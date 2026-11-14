/**
 * WS-07 · 房间生命周期、权限矩阵与重连快照(零依赖核心)。
 *
 * 用一个**可注入时钟**驱动,所有时间相关断言都是确定性的 ——
 * 测试用 `fixedClock()` 推 60 秒,不真 sleep。
 *
 * 关键状态机
 * ```
 *  (create) ──► OPEN ──(lastPlayerLeft + IDLE_SLEEP_MS 到达)──► SLEEPING
 *                 ▲                                                │
 *                 └──────────(join 触发 wake)──────────────────────┘
 *  任意状态 ──(owner close / 空房超过 EVICT_MS)──► CLOSED
 * ```
 * 断线:成员离开时**不删**成员表,只把 `disconnectedAt` 记上;在
 * `RECONNECT_GRACE_MS`(30 秒)内用同一 token 回来 → 直接恢复快照;
 * 超期 → 记一次 `leave` 并清快照。
 */

import {
  encodeDelta,
  encodeFull,
  decodePacket,
  PROTOCOL_VERSION,
} from '../../../shared/net/delta.ts';
import { EntityKind } from '../../../shared/types/wire.ts';
import {
  AntiCheatRoom,
  type Clock,
  type InventoryOp,
  type MoveIntent,
  type Verdict,
  type Violation,
} from './anticheat.ts';
import {
  AccessMode,
  PartyMode,
  RoomRole,
  RoomStatus,
  createRoom,
  createUser,
  getRoom,
  getUser,
  listRooms,
  saveReconnectSnapshot,
  loadReconnectSnapshot,
  setPartyMode,
  setRoomStatus,
  upsertRoomPlayer,
  totalItemsOf,
  type DbLike,
} from '../db/repo.ts';
import {
  createPlayerState,
  createRoomState,
  cloneRoomState,
  type PlayerState,
  type RoomState,
} from './schema.ts';
import { MAX_LEVEL } from '../../../shared/types/entities.ts';

/** 空集合常引用 —— `grantedSourcesFor` 无凭证时返回它,避免每次分配。 */
const EMPTY_SOURCE_SET: ReadonlySet<string> = new Set<string>();

/* ═══════════════════════════ 1. 参数表 ═══════════════════════════ */

/** 无人活动 60 秒 → 自动休眠(手册 §7.1 生命周期)。 */
export const IDLE_SLEEP_MS = 60_000;
/** 断线 30 秒内可原样重连。 */
export const RECONNECT_GRACE_MS = 30_000;
/** 休眠房再无人问津 24 小时 → 关闭(释放内存)。 */
export const EVICT_MS = 24 * 60 * 60 * 1000;
/** 单个玩家两次心跳之间超过此值判定为掉线。 */
export const HEARTBEAT_TIMEOUT_MS = 5_000;
/** 每帧最多处理的动作条数(防止单帧被灌爆)。 */
export const MAX_ACTIONS_PER_TICK = 64;

/**
 * 打盹超时:30 分钟。
 *
 * 这是「玩家去吃了顿饭」与「玩家真的走了」的分界。取值理由:
 *   * **不取 5 分钟** —— 泡杯茶回来发现被踢是体验灾难;
 *   * **不需要更短** —— `AFK_EXP_RATIO = 0.3`(手册 §4.1)本身已经是防挂机机制,
 *     挂机收益只有 30%,不必再用短超时叠加第二重惩罚。
 *
 * **超时后不 disconnect**:房间上限只有 4~16 人,若打盹 30 分钟就释放名额,
 * 16 人房里有人去吃饭、回来时名额可能已被新人占满,他就回不来了。
 * **占着席位比踢掉更友好**,且房间本身有「60 秒无人在线休眠」兜底,
 * 资源不会被真正浪费。
 *
 * 超时只影响两件事:退出经验分配、退出 Boss 个人掉落归属。
 * WS-10 侧算经验分配时请引用本常量,不要另立一份。
 */
export const AFK_TIMEOUT_MS = 30 * 60 * 1000;

/* ═══════════════════════════ 2. 动作与权限矩阵 ═══════════════════════════ */

export const RoomAction = {
  MOVE: 'MOVE',
  ATTACK: 'ATTACK',
  PLACE_BLOCK: 'PLACE_BLOCK',
  BREAK_BLOCK: 'BREAK_BLOCK',
  PICKUP_ITEM: 'PICKUP_ITEM',
  DROP_ITEM: 'DROP_ITEM',
  CRAFT: 'CRAFT',
  USE_ALCHEMY_FURNACE: 'USE_ALCHEMY_FURNACE',
  OPEN_CHEST: 'OPEN_CHEST',
  USE_OWN_CHEST: 'USE_OWN_CHEST',
  SLEEP: 'SLEEP',
  START_PARTY: 'START_PARTY',
  SET_ROOM_ACCESS: 'SET_ROOM_ACCESS',
  SET_PARTY_MODE: 'SET_PARTY_MODE',
  KICK_MEMBER: 'KICK_MEMBER',
  SET_MEMBER_ROLE: 'SET_MEMBER_ROLE',
  RESET_WORLD: 'RESET_WORLD',
  CLOSE_ROOM: 'CLOSE_ROOM',
  MODIFY_TOWN: 'MODIFY_TOWN',
  PLACE_AUTOMATION: 'PLACE_AUTOMATION',
  WIRE_EDIT: 'WIRE_EDIT',
  BREED_TAME: 'BREED_TAME',
} as const;
export type RoomAction = (typeof RoomAction)[keyof typeof RoomAction];

export interface RolePermissions {
  /** 基础生存动作(移动/攻击/拾取)。 */
  baseline: boolean;
  /** 允许建造 / 拆除。 */
  build: boolean;
  /** 允许布线 / 放自动化件。 */
  wiring: boolean;
  /** 允许改公共储物箱。 */
  publicStorage: boolean;
  /** 允许动城镇安全区与图腾。 */
  town: boolean;
  /** 允许开派对 / 设模式。 */
  party: boolean;
  /** 允许管理成员。 */
  manage: boolean;
  /** 允许改房间属性(密码/容量)。 */
  configure: boolean;
  /** 允许重置世界 / 关房。 */
  destructive: boolean;
}

/**
 * 权限矩阵。语义要点(与手册 §7.1 权限矩阵逐格对应):
 *  GUEST 是「游客/访客」——能玩能捡,不能建造、不能布线、不能开箱、不能办派对。
 *  这正是测试里「越权被拒」的判定依据。
 */
export const PERMISSION_MATRIX: Readonly<Record<RoomRole, RolePermissions>> = {
  OWNER: {
    baseline: true, build: true, wiring: true, publicStorage: true,
    town: true, party: true, manage: true, configure: true, destructive: true,
  },
  ADMIN: {
    baseline: true, build: true, wiring: true, publicStorage: true,
    town: true, party: true, manage: true, configure: false, destructive: false,
  },
  MEMBER: {
    baseline: true, build: true, wiring: true, publicStorage: false,
    town: false, party: false, manage: false, configure: false, destructive: false,
  },
  GUEST: {
    baseline: true, build: false, wiring: false, publicStorage: false,
    town: false, party: false, manage: false, configure: false, destructive: false,
  },
};

/** 动作 -> 所需权限位。baseline 类动作永远允许(只要在房里)。 */
export const ACTION_PERMISSION: Readonly<Record<RoomAction, keyof RolePermissions>> = {
  MOVE: 'baseline',
  ATTACK: 'baseline',
  PICKUP_ITEM: 'baseline',
  DROP_ITEM: 'baseline',
  SLEEP: 'baseline',
  USE_OWN_CHEST: 'baseline',
  BREED_TAME: 'baseline',
  PLACE_BLOCK: 'build',
  BREAK_BLOCK: 'build',
  CRAFT: 'build',
  PLACE_AUTOMATION: 'wiring',
  WIRE_EDIT: 'wiring',
  OPEN_CHEST: 'publicStorage',
  USE_ALCHEMY_FURNACE: 'publicStorage',
  MODIFY_TOWN: 'town',
  START_PARTY: 'party',
  SET_PARTY_MODE: 'party',
  KICK_MEMBER: 'manage',
  SET_MEMBER_ROLE: 'manage',
  SET_ROOM_ACCESS: 'configure',
  RESET_WORLD: 'destructive',
  CLOSE_ROOM: 'destructive',
};

export function can(role: RoomRole, action: RoomAction): boolean {
  const perms = PERMISSION_MATRIX[role];
  if (!perms) return false;
  return perms[ACTION_PERMISSION[action]] === true;
}

/* ═══════════════════════════ 3. 会话与成员 ═══════════════════════════ */

/**
 * 成员在场态。
 *
 * `AFK` 与 `AFK_EXPIRED` 的区别就是 `AFK_TIMEOUT_MS`(30 分钟)这条线:
 * 前者还吃 30% 经验,后者完全退出经验与掉落归属 —— 但**两者都仍占席位**。
 *
 * 语法:用 `as const` 对象替代 `enum`(FREEZE.md §0 硬禁令)。
 */
export const MemberPresence = {
  /** 清醒在线。 */
  ACTIVE: 'ACTIVE',
  /** 打盹未超时(< 30 分钟):吃 30% 经验(手册 §4.1 `AFK_EXP_RATIO`)。 */
  AFK: 'AFK',
  /** 打盹已超时(≥ 30 分钟):退出经验分配与个人掉落归属,但仍占席位。 */
  AFK_EXPIRED: 'AFK_EXPIRED',
  /** 断线(App 已关),与打盹正交。 */
  OFFLINE: 'OFFLINE',
} as const;
export type MemberPresence = (typeof MemberPresence)[keyof typeof MemberPresence];

/** 在场态的显示名(日志与审计用)。 */
export const MEMBER_PRESENCE_LABEL: Readonly<Record<MemberPresence, string>> = {
  ACTIVE: '清醒',
  AFK: '打盹',
  AFK_EXPIRED: '打盹超时',
  OFFLINE: '离线',
};

export interface MemberSession {
  userId: string;
  role: RoomRole;
  /** 当前连接 token;断线后置 null。 */
  token: string | null;
  connected: boolean;
  /** 掉线时刻(ms);在线时为 null。 */
  disconnectedAtMs: number | null;
  /**
   * 打盹起始时刻(ms);未打盹为 null。
   * **打盹 ≠ 离线**:切后台打盹的玩家仍然占着席位、仍有实体、仍要吃经验
   * (手册 §4.1 `AFK_EXP_RATIO = 0.3`),因此**不触发房间休眠**。
   */
  afkSinceMs: number | null;
  joinedAtMs: number;
  lastSeenMs: number;
  seq: number;
  /**
   * 本次 join 从存档恢复出的**权威坐标**;未恢复(首次进入/无存档)时为 `null`。
   *
   * ## 为什么要记它(task-70)
   *
   * 契约 §9 验收 1 要求「读档恢复有真调用点」,而**光有调用点不够** ——
   * 「调用了但恢复无效」与「没有存档」在外部表现上**完全一样**(陷阱 89)。
   * 记下恢复结果,断言才能区分这两件事:
   * ```
   * 有存档且恢复成功 ⇒ restoredFrom ≠ null
   * 有存档但恢复失败 ⇒ restoredFrom === null 而 restoreError ≠ null  ← ★ 缺陷
   * 没有存档         ⇒ restoredFrom === null 且 restoreError === null
   * ```
   */
  restoredFrom?: { x: number; y: number } | null;
}

export interface JoinResult {
  ok: boolean;
  reason?: string;
  role?: RoomRole;
  token?: string;
  /** 重连时给出的快照(与断线前逐字节一致)。 */
  snapshot?: Uint8Array;
  /** 是否走了重连路径。 */
  resumed?: boolean;
}

export interface RoomRuntimeOptions {
  roomId: string;
  ownerId: string;
  clock: Clock;
  name?: string;
  accessMode?: AccessMode;
  passwordHash?: string | null;
  maxPlayers?: number;
  worldSeed?: number;
  /**
   * 世界存档源(可选;**US2 起从构造参数注入**,理由见下)。
   *
   * ## 为什么改成构造参,而不是继续用「建完再赋值」
   *
   * 原先只有字段 `worldSaveHost = null` 可写,于是装配层必须
   * 「先 `new RoomRuntime(...)`,再 `rt.worldSaveHost = host`」。
   * 实测后果:**生产里这个赋值一处都没有**(全仓 6 处赋值,5 处在临时探针、
   * 1 处在 `tests/WS-FND-02.test.ts`),`room.colyseus.ts` 全文
   * 无 `worldSaveHost` ⇒ 该契约在运行期**恒为 null**
   * (含既有的 `saveToDb`,那是**存量**缺口,不是本任务引入的)。
   *
   * 构造参数让「有没有世界」在**建房间的那一刻**就必须表态,
   * 而不是靠事后一个可选赋值 —— 后者漏掉时**没有任何东西报错**。
   * 字段仍然保留可写(测试/渐进接入用),但生产装配走构造参。
   *
   * ⚠️ 仍需要有人**构造** host(`server/src/index.ts` 目前不存在)⇒
   * 本参数只保证「有了就能传进来」,不保证「一定有人构造」。
   */
  host?: WorldSaveHost | null;
}

/* ═══════════════════════════ 4. RoomRuntime ═══════════════════════════ */

/**
 * 一次攻击结算的实际结果(供成功回执 + 断言)。
 *
 * 字段全部是**基本类型**:它要能跨 `net` → 传输层边界被序列化,
 * 也刻意不引用模拟层的 `PipelineDamageResult`(理由同 `WorldSaveHost`)。
 */
export interface AttackReport {
  tick: number;
  playerId: string;
  mobId: string;
  /** `OUT_OF_AOI` = 目标不在活跃区,未结算;`OK` = 走到结算了。 */
  outcome: 'OK' | 'OUT_OF_AOI';
  /** 真实掉血(已钳制;尸体恒 0 —— task-33 契约)。 */
  hpLoss: number;
  /** 公式给出的伤害(可能被格挡/闪避归零,故与 `hpLoss` 不同)。 */
  finalDamage: number;
  /** 目标存在且结算了(`false` 通常意味着 `mobId` 不存在)。 */
  hit: boolean;
  outOfReach: boolean;
  dodged: boolean;
}

/**
 * 房间可挂载的「世界存档源」。
 *
 * ## 为什么是结构化接口,而不是 import 模拟层
 *
 * `RoomRuntime` 至今**不认识**模拟层(US2「room 持有 sim」仍未开)。
 * 为了落盘而在 `net/room.ts` 里 import 它,会凭空造出一条
 * `net → sim → db` 的编译期依赖,并把它变成 `room.ts` 的硬约束 ——
 * 那是本任务不需要的耦合。
 *
 * 这里只声明**用到的那几个方法**:谁提供它都行(模拟层满足它),
 * 房间不关心实现。于是接线成本是一行,且不引入新的可达性边。
 *
 * ⚠️ 注意:本文件**有意不出现**模拟层的类型名 —— 一旦这里 import 了它,
 * US2 才真的变成过时条目(`scripts/backlog.ts` 的 US2 探针正盯着本文件)。
 * 现在两者依然互不依赖,只是**结构上可组合**。
 *
 * ## US2 起新增的攻击面(同样只用结构化类型)
 *
 * `attackMobAuthorized` 的返回被**就地展开成基本类型**,不引用
 * `PipelineDamageResult` 等模拟层类型 —— 否则 `net` 就依赖 `combat` 了。
 * 房间只关心四个整数/字符串:结果形态、掉了多少血、是否命中、目标死活。
 */
export interface WorldSaveHost {
  saveToDb(
    db: DbLike,
    roomId: string,
    nowMs: number,
  ): { hpSaved: number; hpSkipped: number; memRow: number };
  /**
   * 玩家对某只生物发起一次**权威**攻击(等级/装备由模拟层自己派生)。
   *
   * 与 `saveToDb` 同一取舍:这是**结构化**声明,不 import 模拟层类型。
   *
   * @returns `null` = 没有这只生物;**`outcome`** 区分「结算了」与
   *          「目标不在活跃区(AOI 外)」—— 后者不是错误,是闸门。
   */
  attackMobAuthorized(
    playerId: string,
    mobId: string,
  ): {
    outcome: 'OK' | 'OUT_OF_AOI';
    /**
     * `null` = 生物不存在。
     *
     * ⚠ 形状必须与 `WorldSim.attackMobAuthorized` **逐字段对齐** ——
     * 伤害在 `result.finalDamage`(嵌套),不在顶层。
     * 我第一版把 `finalDamage` 写在顶层,于是真实对象里它是
     * `undefined`,经 `?? 0` 静默变成 0:回执永久上报「0 伤害」而
     * **没有任何东西报错**(`worldSaveHost` 是结构化接口 + 装配处用了
     * `as never`,两侧类型不对齐也不会红)。这类「字段路径写错」在本仓
     * 属高发(见陷阱 2:签名/字段猜错),故这里写明嵌套关系。
     */
    hit: {
      /** **已钳制**的真实掉血(task-33 契约;尸体恒 0)。 */
      hpLoss: number;
      result: {
        finalDamage: number;
        outOfReach: boolean;
        dodged: boolean;
      };
    } | null;
  };
  /**
   * 玩家的**权威等级**(来自进度档案 `progression`,不是网络投影)。
   *
   * 房间用它把 `state.players[].level` 从「恒 1 的默认值」变成**投影**
   * (见 `syncLevelProjections`)。可选:老的世界源没实现它时,
   * 等级投影整段跳过 —— 不报错,也不假装同步过。
   */
  levelOf?(playerId: string): number;
  /**
   * 把一次**已获准**的移动写进世界(权威位置 = `physics.bodies`)。
   *
   * ## 为什么需要它(task-58 的缺口)
   *
   * 接线前全仓**没有任何地方**把 `MoveIntent` 送进模拟层:
   * ```
   * room.ts        applyMove 只写 state.players[].x/y/z
   * server/src/net 写 physics.bodies 的位置/速度:**0 处**
   * world.ts:460   刚体位移只由 b.x += b.vx*dt 积分驱动
   * world_sim.ts   mobDistance 读 physics.bodies
   * ```
   * ⇒ 玩家在模拟层里**永久静止** ⇒ 距目标恒超 AOI ⇒ `attackMobAuthorized`
   *   **永久 OUT_OF_AOI** ⇒ 攻击永不结算。
   *
   * ## 反作弊**不在这里判**(判据只在一处)
   *
   * 合法性由 `anticheat.checkMove` 判定(见 `applyMove`)。本方法是**执行**,
   * 假设输入已获准。详见 `WorldSim.applyPlayerMove` 的 docblock。
   *
   * 可选:老的世界源不实现它时,`applyMove` 退回「只写 state」——
   * 与 `levelOf` / `saveToDb` 同一 null 契约,不报错也不假装。
   */
  applyPlayerMove?(playerId: string, x: number, y: number): boolean;
  /**
   * 读回玩家的**权威位置**。与 `applyPlayerMove` 成对:
   * 写入后从权威读回、投影到 `state`,才能让**击退/搬运**对客户端可见
   * (那两条走 `applyImpulse` 改速度,不经过 `applyPlayerMove`)。
   */
  playerPosition?(playerId: string): { x: number; y: number } | null;
  /**
   * 把玩家**登记进世界**(进场)。与 `applyPlayerMove` 是**一对**。
   *
   * ## 为什么它必须与移动转发同时存在(task-58 实测发现的第四条链路)
   *
   * 实测(生产路径 `assemble()` → `join()`):
   * ```
   * room 里 state.players.x           = 0.5(房间出生点)
   * sim 里 playerPosition('p1')       = **null**   ← 模拟层不认识这个玩家
   * ⇒ applyPlayerMove 返回 false ⇒ 移动转发**静默无效**
   * ```
   * `sim.addPlayer()` 的**生产调用者实测为 0**(只有 `demo.ts` 调)。
   * ⇒ 只修「移动转发」而不登记玩家,等于给一个不存在的刚体写坐标 ——
   *   断言会绿(写入方法返回 false 但无人检查),而玩家在模拟层里依然不存在。
   *
   * ## 出生点以**房间的**为准
   *
   * 调用方传 `state.players[].x/y`(房间已按 `spawnPoint()` 定好),保证
   * 「反作弊播种坐标」与「刚体坐标」**同源**。若两者不同,第一次移动会被
   * 判成瞬移(实测:反作弊在 0.5、刚体在 10 ⇒ 报「单帧位移 13.649 格」)。
   */
  addPlayer?(playerId: string, x: number, y: number): void;
  /** 把玩家从世界移除(离场)。与 `addPlayer` 成对,避免刚体残留。 */
  removePlayer?(playerId: string): boolean;
  /**
   * **同步一名玩家的打盹态到模拟层**(task-74)。
   *
   * ## 为什么需要这个口(而不是让模拟层自己算)
   *
   * `afk` 的**权威在房间**:`memberPresence()` / `afkSinceMs` 是只有房间知道的
   * 事实(谁断线、谁切后台、谁超时 30 分钟)。模拟层没有这些输入。
   *
   * 而实测(接线前):`world_sim.ts` 的**三处 `afk` 生产者全写字面量 `false`**
   * ⇒ `afk` 恒 false ⇒ 三条规则**静默失效**:
   * ```
   * mobs/aoi.ts:62               if (p.afk) continue;     打盹者仍提供 AOI 唤醒能量
   * mobs/behaviors.ts:196        if (p.afk) continue;     生物仍追打打盹者
   * combat/progression.ts:326/350  afkMul              打盹者仍**全额**分经验(手册 §4.1:0.3)
   * ```
   * 三条都不报错、门禁全绿、各自的单元测试都是绿的 —— 因为那些测试自己造
   * 夹具(`setPlayers([{afk:true}])`),测的是「给它 true 会跳过」,
   * **从来没人测「true 从哪来」**。
   *
   * ## 返回「是否发生变化」而不是 `void`
   *
   * 与 `restoreFromProfile` 同一纪律:返回**实际生效**的语义,
   * 调用方应断言它。忽略它会让「同步静默无效」与「同步成功」不可区分。
   *
   * ## ⚠️ 本声明**必须**与 `index.ts` 的 `createHost` 一起看
   *
   * `createHost` 的返回类型标注是 `WorldSaveHost`。`WorldSim` **有**而本接口
   * **没声明**的成员会被**结构化裁掉** ⇒ 房间侧 `typeof host.setPlayerAfk`
   * 在**编译期**恒假(不是运行期)。这正是 task-70 实测到的形态。
   *
   * 可选(`?`):老的世界源不实现它时,房间侧整段跳过 —— 与 `levelOf` /
   * `saveToDb` 同一 null 契约,不报错也不假装同步过。
   */
  setPlayerAfk?(playerId: string, afk: boolean): boolean;
  /**
   * 推进世界 **n 个快帧**(task-59:驱动缺失)。
   *
   * ## 为什么是「快帧数」而不是秒
   *
   * `WorldSim` 自管**内部双频**(`FAST_PER_SLOW = 10`),而 `tick()` 一次
   * 就是一帧(实测相位 `FAST×9 SLOW FAST×2`)。
   * ⇒ `advance(1)` 对应外部一帧,**恰好 1:1**,不需要换算。
   * `SIM_FAST_DT = 0.05 = 1/20` 与 20Hz 天然对齐。
   *
   * ## ⚠️ 调用方**绝不可**再乘 `FAST_PER_SLOW`
   *
   * 若以为「慢帧 2Hz,外面要乘 10」,就会每慢帧推进两次 AI ⇒ **世界快 2 倍**。
   * 这类错误不报错、测试也可能照过(`WorldSim.advance` 的 docblock 记录了同一先例)。
   *
   * 可选:世界源不实现它时,`step()` 整段跳过 —— 与 `saveToDb` 同一 null 契约。
   */
  advance?(frames: number): number;

  /**
   * **读档恢复的权威入口**(task-70 / 契约 §2.1)。
   *
   * 把一份**已解码的**玩家档案按固定顺序写进权威层(`progresses` / `vitals`)。
   * 顺序的内部实现在 `WorldSim.restoreFromProfile`,此处只声明契约。
   *
   * ## 为什么它必须存在(而不是房间解析 blob 后直写 `state.players[]`)
   *
   * ```
   * 实测:level 的**唯一**持久化处 = room_players.snapshot_blob
   *       (它是 encodeFull(state) 的**投影值**,不是权威)
   * 而 users 表虽然**有** level/max_hp 列:
   *       saveVitalsToUsers 只写 hp(repo.ts:773),且 hp 被 cur.max_hp(=100)钳住
   *       ⇒ **DB 路装不下 535 血**(实测 hp 恒 100)
   * ⇒ 读档只能走 blob;而 blob 是投影值 ⇒ 必须由**权威侧**接收它,
   *   否则 §4.3 的「唯一写者是 projectPlayer」被绕过:
   *   房间直写 state ⇒ 下一帧 projectPlayer 用权威旧值覆盖 ⇒
   *   表现为「恢复了又弹回」(一帧的错,但可观测)
   * ```
   *
   * ## ⚠️ `profile` **刻意不含 `maxHp`**
   *
   * `maxHp` 是 `level` 的**派生值**(`statsAtLevel`),由模拟层算。
   * 若让房间传 maxHp,就出现了第二份派生实现 —— 那正是 W1 的成因。
   *
   * ## ⚠️ 返回值的含义
   *
   * 实际生效的**玩家数**(0 通常表示「玩家未登记」⇒ 本方法内部会先 `addPlayer`,
   * 故正常路径应返回 1)。调用方应断言它,而不是忽略 ——
   * 忽略它会让「恢复静默无效」与「恢复成功」不可区分(陷阱 89)。
   */
  restoreFromProfile?(playerId: string, profile: {
    level: number;
    hp: number;
    x: number;
    y: number;
    z: number;
    /**
     * 装备的武器 id(U16)。
     *
     * ⚠️ 模拟层会把它写进 `wearing`(`weaponOf` 的既有规则:
     *    「`wearing` 里不在 `ARMOR_BY_ID` 的第一个 id 即武器」),
     *    **不是** `heldItem` —— 写错那个字段 `weaponOf` 读不到,
     *    而不会有任何东西报错。
     */
    weaponId?: number;
  }): number;

  /* ══════════ US2 裁决 3:投影所需的**只读**读口(契约 §3.1)══════════
   *
   * ## 为什么读口单独一组、且**全部可选**
   *
   * 与 `levelOf` / `applyPlayerMove` 同一 null 契约:老的世界源不实现就用
   * 「没有权威」的退路,不报错也不假装同步过。实测老源只实现了前 7 个。
   *
   * ## ★★ 为什么抽这一组而不是让房间直接读 `WorldSim` 内部 Map
   *
   * 契约 §3.1 给了两条理由,第二条是关键的:
   * ```
   * 1 投影**可单测** —— 一个假实现即可,不必起整个 WorldSim
   * 2 ★★ 它把「投影读了哪些字段」变成**显式**的 ——
   *   若将来有人在投影里读 `room.state.players[].hp` 当权威,
   *   那是**回抄**,而有了这个接口就能用「假实现不提供该字段」
   *   来**结构性挡掉**
   * ```
   * ⇒ 本接口**只暴露 SSOT 侧的值**。任何从 `state` 取数的投影都拿不到输入,
   *   因为本接口的方法签名里**根本没有** `state`。这是结构性的,不是约定。
   *
   * ## ⚠️ 与契约 §3.1 的三处**实测不符**(按实现真相取值,已记 CR)
   *
   * | 契约写法 | 实现真相 | 本接口取值 |
   * | :--- | :--- | :--- |
   * | `weaponOf(): string \| undefined` | `PlayerState.weaponId` 是 **U16 数字**(FIELD_TABLE 实测) | `number` |
   * | `poseOf(): {x,y,z} \| null` | `DynamicBody` **有** z,但 `applyMove` 只接 x/y | `{x,y,z}`(z 读回权威) |
   * | `inventoryTotalOf(): {used,cap}` | 三无(零实现/零消费者/零断言),且与 W5 方向相反 | **删声明**(见下) |
   * ```
   * ⚠️ 第一条不是笔误可以忽略的:若按契约返回 `string`,投影写进
   *    `PlayerState.weaponId`(U16,`FIELD_TABLE` 会按 2 字节编码)会得到一个
   *    **字符串进数值字段** —— 编码器要么抛,要么写出垃圾。
   *    ⇒ 按实现真相取 `number`。契约文字应改(已在文档里记 CR)。
   */
  /** 生命值权威(`VitalsSystem`)。不存在该玩家 ⇒ `null`。 */
  vitalsOf?(playerId: string): { hp: number; maxHp: number; downed: boolean } | null;
  /** 位置权威(`physics.bodies`,含 z —— 与 `playerPosition` 的 x/y 版并存)。 */
  poseOf?(playerId: string): { x: number; y: number; z: number } | null;
  /**
   * 装备权威武器 id。`undefined` = 该玩家没有武器/没有装备数据。
   *
   * ⚠️ 类型是 `number`(U16),**不是**契约里写的 `string` —— 见上表。
   */
  weaponOf?(playerId: string): number | undefined;
  /* ⚠️ 此处**刻意没有** `inventoryTotalOf(): {used, cap}` —— 契约 §3.1 列了它,
     但实测它在本仓是**三无**:零实现(WorldSim 没有)、零消费者(step/applyInventory
     都不读)、零断言引用。而它给的又是**总量**,与 W5 的裁定
     「总量必须由**明细重算**,不得当输入」**方向相反** ——
     留着它会鼓励将来有人「读总量再赋给 state」,那正是 W5 要挡的形态。
     ⇒ 第 8 项的真实通路是:
       `projectInventoryTotalFor` → `host.inventoryDetailOf` → `projectInventoryTotal`
     ⇒ 故删声明而不补实现(已在 docs/WS-07-net-persist.md §9.1 记 CR)。 */
}

/** 投影输出的 7 个状态字段(第 8 项 `inventory` 不落在 `PlayerState` 上,见下)。 */
export interface PlayerProjection {
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  z: number;
  weaponId: number;
}

/**
 * 投影所需的**只读**读口(契约 §3.1)。
 *
 * ## 为什么它与 `WorldSaveHost` 的读口分开定义
 *
 * `WorldSaveHost` 是「房间对世界的完整契约」(写口 + 读口 + 驱动口),
 * 而本接口是**投影函数唯一被允许的输入面**。
 * ⇒ 分开之后,`projectPlayer` 的签名**结构上**只能拿到 SSOT 侧的值:
 *   它没有任何参数能触及 `room.state`,所以「回抄」不是「不该做」,
 *   而是**做不到**(契约 §3.1 理由 2 的兑现)。
 *
 * ## ⚠️ 全部方法返回 `null`/`undefined` 的语义
 * ```
 * null  = 「权威说这个玩家不存在」⇒ 该字段**不投影**(保留旧值,不写 0)
 * ⇒ ★ 不能把 null 当 0 写:那会让「世界不认识这个玩家」表现为
 *   「玩家血量归零 / 位置瞬移到原点」——两个都像真的故障。
 * ```
 */
export interface SimReadView {
  levelOf(playerId: string): number;
  vitalsOf(playerId: string): { hp: number; maxHp: number; downed: boolean } | null;
  poseOf(playerId: string): { x: number; y: number; z: number } | null;
  weaponOf(playerId: string): number | undefined;
}

/**
 * 把 SSOT 投影到只读网络视图(契约 §3.2)。
 *
 * ## 纯函数语义
 *
 * ```
 * 同样输入 ⇒ 同样输出,且**不读 `out` 自身**。
 * ```
 * ⚠️ 注意「不读 out 自身」是**性质**,不是风格:一旦读 `out.hp` 去算新值
 *    (例如 `out.hp -= dmg`),就又把投影变成第二个权威了。
 * 本函数的实现里只出现 `view.*` 与字面常量 —— 没有 `out.` 的读。
 *
 * ## 返回「是否发生变更」而不是「是否有权威值」
 *
 * 契约 §3.2 要求返回 `boolean` 供 20Hz 差分编码复用 —— 但含义必须是
 * **「有字段真的变了」**,不是「读到了权威」。理由:
 * ```
 * 若返回「读到了」⇒ 每帧恒 true ⇒ 差分编码退化成全量下发
 * (带宽浪费,且掩盖"其实没变"这个事实)
 * ```
 *
 * ## ⚠️ 为什么 `level` 要夹上界,而 `hp`/`maxHp` 不夹
 *
 * `level` 夹一次(与既有 `syncLevelProjections` 同口径),理由是本字段的
 * **消费者不夹**:`carryCapacityOf` 直接 `8 + (lv - 1)`。若投影越界,
 * 房间容量口径与 `progression.statsAtLevel`(已钳)就分歧了。
 * 而 `hp`/`maxHp` 的钳制**已经在 `VitalsSystem` 内**(`syncMaxHp` 策略 C),
 * ⇒ 在这里再钳一次就是**第二份实现**(本仓明确的缺陷形态)。
 * ⇒ 分工:上界统一一处(`vitals` 管生命、`progression` 管等级),
 *   投影只**搬运**。
 *
 * ## ⚠️ `z` 从权威读,不从报文
 *
 * `poseOf` 返回的 z 来自 `DynamicBody.z`。此前 `applyMove` 写的是
 * `p.z = intent.z`(客户端声明值)—— 那是任务 58 之前的旧路径。
 * 现在权威有 z(高度/跳跃/流体浮沉都会改它),投影必须读权威,
 * 否则「玩家在水里被抬起」这类变化对客户端不可见。
 */
export function projectPlayer(view: SimReadView, playerId: string, out: PlayerProjection): boolean {
  let changed = false;

  /* ── 1 level(权威 = progresses;夹上界,理由见 docblock)── */
  const lv = view.levelOf(playerId);
  if (Number.isFinite(lv)) {
    const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(lv)));
    if (out.level !== clamped) { out.level = clamped; changed = true; }
  }

  /* ── 2 hp / 3 maxHp(权威 = vitals;**不夹**,钳制在 vitals 内)── */
  const v = view.vitalsOf(playerId);
  if (v !== null) {
    if (Number.isFinite(v.hp) && out.hp !== v.hp) { out.hp = v.hp; changed = true; }
    if (Number.isFinite(v.maxHp) && out.maxHp !== v.maxHp) { out.maxHp = v.maxHp; changed = true; }
  }

  /* ── 4/5/6 x,y,z(权威 = physics)──
     ⚠️ `null` ⇒ 不投影(保留旧值)。把 null 当 0 写会让「世界不认识这个玩家」
        表现成「瞬移到原点」——那看起来像真故障,会把排障引偏。 */
  const pose = view.poseOf(playerId);
  if (pose !== null) {
    if (Number.isFinite(pose.x) && out.x !== pose.x) { out.x = pose.x; changed = true; }
    if (Number.isFinite(pose.y) && out.y !== pose.y) { out.y = pose.y; changed = true; }
    if (Number.isFinite(pose.z) && out.z !== pose.z) { out.z = pose.z; changed = true; }
  }

  /* ── 7 weaponId(权威 = 装备)──
     ⚠️ `undefined` = 「没有装备数据」⇒ 不投影。不得写成 0:
        `0` 在 FIELD_TABLE 里的语义是「空手」,那是一个**真实的手持状态**,
        与「采不到权威」是两件事(本仓 CR-14 U1 的同族区分)。 */
  const w = view.weaponOf(playerId);
  if (w !== undefined && Number.isFinite(w) && out.weaponId !== w) {
    out.weaponId = w;
    changed = true;
  }

  return changed;
}

/**
 * 背包**总量** = 由明细**重算**的纯函数(契约 §2.3 的 W5 裁定)。
 *
 * ## ★★ 为什么必须是纯函数,不得累加式更新
 *
 * ```
 * 累加式:total += delta   ⇒ **漏一帧就永久偏差**(误差不可自愈)
 * 重算式:total = f(items) ⇒ 任何一帧的结果都只依赖当时的明细
 * ```
 * 契约 §2.3 明写这一条。实测同族先例:本仓 `repo.ts` 的 `totalItemsOf`
 * 就是**对明细求和**,不是读一个累加计数器 —— 两者结果应一致,
 * 而那正是本函数可以**交叉验证**的对象。
 *
 * ## ⚠️ 与 `room.inventoryTotals` 的关系(这才是 W5 的实质)
 *
 * ```
 * users.inventory_json(明细)  →  权威
 * room.inventoryTotals(总量)  →  **派生缓存**(纯内存模式下的退路)
 * ⇒ 方向 = 明细 → 总量(单向)
 * ⇒ 故本函数**只接受明细数组**,不接受任何"当前总量"参数 ——
 *   那会让它又变成「以总量为输入」(= 双向的第一步)。
 * ```
 * ⚠️ 若传入的明细**不是数组**(库返回 `{}` / `null`),回退 `0` 而不是 `NaN`:
 *    `NaN` 会让 `after > capacity`、`after < 0` 全部恒 false ⇒ 容量守恒失效
 *    (与 CR-27 同族)。
 *
 * @param items 明细(每项至少要有 `quantity`)
 * @returns 总件数(非负整数);输入非法时 `0`
 */
export function projectInventoryTotal(
  items: readonly { quantity?: unknown }[] | null | undefined,
): number {
  if (!Array.isArray(items)) return 0;
  let sum = 0;
  for (const it of items) {
    const q = it?.quantity;
    /* ⚠️ 逐项 `isFinite` 而不是整段求和后判断:一项 `NaN` 会毒化整个和,
       而逐项挡掉能让「其余合法项仍然计入」—— 与 `checkInventory` 的
       `FRACTIONAL` 逐项判同一取向。 */
    if (typeof q === 'number' && Number.isFinite(q)) sum += q;
  }
  return sum < 0 ? 0 : sum;
}

/**
 * `action` 报文里除动作名之外能带的参数(**可选**;缺则按 `INVALID` 拒绝)。
 *
 * 为什么不把参数并进 `RoomAction` 常量本身:动作名是**协议常量**,
 * 而要带的参数随动作而变(16 个动作里只有 4 个需要参数)。
 * 分开之后,「动作清单」这一份事实仍然只有一处(`RoomAction`)。
 */
export interface ActionPayload {
  /** `SET_MEMBER_ROLE` / `KICK_MEMBER`:目标成员。 */
  targetId?: string;
  /** `SET_MEMBER_ROLE`:新角色。 */
  role?: RoomRole;
  /** `SET_ROOM_ACCESS`:访问模式。 */
  mode?: AccessMode;
  /** `SET_ROOM_ACCESS`:密码房的口令 hash(`null` = 无密码)。 */
  passwordHash?: string | null;
  /** `SET_PARTY_MODE`:派对模式。 */
  partyMode?: PartyMode;
}

/**
 * 一次动作分派的**结果 + 回执**。`effect` 只放可序列化的少量字段 ——
 * 回执要能直接进报文,不许把内部对象漏出去。
 */
export interface ActionOutcome {
  ok: boolean;
  /** 结果类别。**必须显式**(含 `NOT_IMPLEMENTED`)= 消灭"静默成功"的载体。 */
  kind: 'OK' | 'PERMISSION' | 'INVALID' | 'NOT_IMPLEMENTED' | 'ROOM_CLOSED';
  /** 失败原因;`ok === true` 时不存在。 */
  reason?: string;
  /** 成功时的后果摘要(回执用)。 */
  effect?: Record<string, string | number | boolean>;
}
/**
 * 单个房间的运行时。**不 import colyseus** —— colyseus 的 Room 只是薄装配层
 * (`room.colyseus.ts`),把它的 onTick/onJoin 转发到这里的方法。
 */
export class RoomRuntime {
  readonly id: string;
  readonly ownerId: string;
  readonly clock: Clock;
  state: RoomState;
  status: RoomStatus = RoomStatus.OPEN;
  accessMode: AccessMode;
  passwordHash: string | null;
  maxPlayers: number;
  partyMode: PartyMode = PartyMode.NONE;
  readonly ac: AntiCheatRoom;
  readonly members = new Map<string, MemberSession>();
  /** 上次「有人活动」的时刻。 */
  lastActivityMs: number;
  /** SQLite 仓储(可注入;null = 纯内存模式,不进库)。 */
  readonly db: DbLike | null;
  /**
   * 世界存档源(可注入;null = 本房间没有模拟层,只落 world_tick)。
   *
   * 弱点可见:`null` 时 HP 与生物 mem **不会落盘**。这个事实由
   * `lastSaveReport` 暴露出来,而不是让调用方以为「已经存过了」。
   */
  worldSaveHost: WorldSaveHost | null = null;
  /** 上一次落盘的实际计数;null = 从未落盘。供测试与诊断断言。 */
  lastSaveReport: {
    tick: number;
    hpSaved: number;
    hpSkipped: number;
    memRow: number;
  } | null = null;
  /**
   * 上一次读档恢复:`restoreFromProfile` 返回的**生效玩家数**;null = 从未尝试。
   *
   * 与 `lastSaveReport` 同一处置:把「做了没有、生效几条」**显式暴露**,
   * 而不是让调用方以为「已经恢复过了」。
   */
  lastRestoreApplied: number | null = null;
  /**
   * 上一次读档失败的**原因**;null = 无失败。
   *
   * ⚠️ 只记**真失败**(存档存在但解不开 —— 协议版本变了 / 字节截断),
   * **不记**「没有存档」(那是常态,不是错误)。
   * ⇒ 这个区分是刻意的:两类混在一起会让「读坏了」看起来像「首次进入」。
   */
  lastRestoreError: string | null = null;
  /** 每 tick 累计的违规,由外层写 room_events。 */
  private pendingViolations: Violation[] = [];
  private tokenSeq = 0;
  /** 休眠/唤醒次数,便于断言。 */
  sleepCount = 0;
  wakeCount = 0;

  constructor(opts: RoomRuntimeOptions, db: DbLike | null = null) {
    this.id = opts.roomId;
    this.ownerId = opts.ownerId;
    this.clock = opts.clock;
    this.db = db;
    this.accessMode = opts.accessMode ?? AccessMode.PUBLIC;
    this.passwordHash = opts.passwordHash ?? null;
    this.maxPlayers = Math.min(16, Math.max(1, opts.maxPlayers ?? 16));
    this.state = createRoomState(this.id);
    this.ac = new AntiCheatRoom();
    this.lastActivityMs = this.clock.nowMs();
    /* 世界源从构造参注入(见 `RoomRuntimeOptions.host` 的长注释):
       缺省仍为 null,但**装配层现在有地方可传** —— 此前只能事后赋值,
       而生产里那个赋值一处都不存在。 */
    this.worldSaveHost = opts.host ?? null;
    /* ══════════ ★ 房间落库必须是**幂等**的(task-70 实测抓到)══════════
     *
     * ## 为什么原来的 `createRoom` 无条件调用是错的
     *
     * `createRoom` 对已存在的 id **抛异常**(`repo.ts:328`)。
     * 而本构造器在**每次**装配时都调它 ⇒
     * ```
     * 服务重启(DB 里已有 room_a)
     * ⇒ assemble() ⇒ new RoomRuntime(...) ⇒ createRoom 抛「房间已存在」
     * ⇒ **装配失败** ⇒ 根本走不到读档恢复那一步
     * ```
     * ⇒ 「冷启动读档」在**架构上**不可达 —— 本任务是 task-70,
     *   而它的名字就是冷启动。实测:
     * ```
     * new RoomRuntime(opts, db) 第一次 ⇒ OK
     * new RoomRuntime(opts, db) 第二次 ⇒ ★ 抛「房间已存在:room_a」
     * assemble({db}) 第二次           ⇒ ★ 同上
     * ```
     *
     * ## 判据:构造器的职责是「**确保**房间存在」,不是「**创建**房间」
     *
     * 与 `migrate` 同一语义:能重复执行。故**先查**:
     * ```
     * 已存在 ⇒ 什么都不做(保留库里的 name/accessMode 等 ——
     *                  那些可能在别处被改过,不该被本次装配的默认值盖回)
     * 不存在 ⇒ 按原逻辑创建
     * ```
     *
     * ## ⚠️ 为什么不改 `createRoom` 成 upsert
     *
     * 它那条守卫是**故意的**:能抓到「同一个房间被建两次」这类真错
     * (实测 `tests/WS-07` 有断言依赖它抛)。把守卫改成静默 upsert
     * 会让那个错误消失 —— 而错误消失不等于问题消失。
     * ⇒ 收敛在**调用点**修,不动被依赖的守卫。
     *
     * ## 幂等后仍可变的部分(刻意不覆盖)
     *
     * `ownerId` / `name` / `maxPlayers` / `worldSeed` / 密码
     * —— 库里的现值**优先**。理由:它们是**可运行时变更**的
     * (`setPartyMode`/`setRoomStatus` 已在做同类变更),
     * 而本次装配的参多数是 `?? 默认值`,用它覆盖会把用户的改动静默抹掉。
     */
    if (db && getRoom(db, opts.roomId) === undefined) {
      createRoom(db, {
        id: opts.roomId,
        ownerId: opts.ownerId,
        name: opts.name ?? opts.roomId,
        accessMode: this.accessMode,
        passwordHash: this.passwordHash,
        maxPlayers: this.maxPlayers,
        worldSeed: opts.worldSeed ?? 20261010,
        nowMs: this.clock.nowMs(),
      });
    }
  }

  /* ── 4.1 加入 / 重连 ── */

  /**
   * 加入房间。
   *  - 房间 SLEEPING → 自动唤醒(wake),并把世界帧号接续下去。
   *  - 同名成员处于断线宽限期内 → 走重连路径,返回**逐字节一致**的快照。
   *  - 密码房校验 `passwordHash`;满员拒绝。
   */
  join(input: {
    userId: string;
    passwordHash?: string | null;
    asGuest?: boolean;
  }): JoinResult {
    const now = this.clock.nowMs();
    if (this.status === RoomStatus.CLOSED) return { ok: false, reason: '房间已关闭' };

    if (this.accessMode === AccessMode.PASSWORD) {
      if (!input.passwordHash || input.passwordHash !== this.passwordHash) {
        return { ok: false, reason: '房间密码错误' };
      }
    }

    if (this.status === RoomStatus.SLEEPING) this.wake();

    /* 宽限期已过的掉线成员:席位已被回收,本次按「访客重进」对待 ——
     * 不恢复原角色(尤其不恢复 ADMIN),必须由房主重新授权。 */
    let demotedFromExpiry = false;
    const stale = this.members.get(input.userId);
    if (stale && !stale.connected) {
      const away = stale.disconnectedAtMs === null ? 0 : now - stale.disconnectedAtMs;
      if (away > RECONNECT_GRACE_MS) {
        demotedFromExpiry = true;
        this.members.delete(input.userId);
        this.state.players = this.state.players.filter((p) => p.id !== input.userId);
        this.ac.leave(input.userId);
        /* ⚠️ 世界侧必须**一并**移除 —— 这条路径与 `leave()` 是两处,
           漏了它会让「宽限期超期重进」的玩家在模拟层里**留下旧刚体**,
           而随后 `addPlayer` 又会 spawn 一次(位置 = 出生点),
           表现为「重进后位置被悄悄拉回出生点」。 */
        const hostStale = this.worldSaveHost;
        if (hostStale !== null && typeof hostStale.removePlayer === 'function') {
          hostStale.removePlayer(input.userId);
        }
      }
    }

    const existing = this.members.get(input.userId);
    if (existing) {
      /* ── 重连路径(仍在 30 秒宽限期内) ── */
      if (!existing.connected) {
        const token = this.mintToken();
        existing.token = token;
        existing.connected = true;
        existing.disconnectedAtMs = null;
        existing.afkSinceMs = null;
        existing.lastSeenMs = now;
        this.touch(now);
        const snapshot = this.snapshotFor(input.userId);
        if (this.db) {
          saveReconnectSnapshot(this.db, this.id, input.userId, snapshot, now);
        }
        return { ok: true, role: existing.role, token, snapshot, resumed: true };
      }
      return { ok: false, reason: '该用户已在线' };
    }

    if (this.members.size >= this.maxPlayers) return { ok: false, reason: '房间已满' };
    /* 人数上限按「当前在线」算,断线占位不计。 */
    const online = [...this.members.values()].filter((m) => m.connected).length;
    if (online >= this.maxPlayers) return { ok: false, reason: '房间已满' };

    /* 角色:房主恒为 OWNER;宽限期超期重进的旧管理员降为 GUEST,必须重新授权。 */
    const role: RoomRole = input.userId === this.ownerId
      ? RoomRole.OWNER
      : (input.asGuest || demotedFromExpiry) ? RoomRole.GUEST : RoomRole.MEMBER;

    const token = this.mintToken();
    const session: MemberSession = {
      userId: input.userId,
      role,
      token,
      connected: true,
      disconnectedAtMs: null,
      afkSinceMs: null,
      joinedAtMs: now,
      lastSeenMs: now,
      seq: 0,
    };
    this.members.set(input.userId, session);

    /* 玩家实体进场:同位置已有玩家则做最小偏移,避免叠在一起。 */
    if (!this.state.players.some((p) => p.id === input.userId)) {
      const spawn = this.spawnPoint();
      this.state.players.push(createPlayerState(input.userId, {
        name: input.userId,
        x: spawn.x, y: spawn.y, z: 0,
      }));
    }
    /* 反作弊状态以**实际出生坐标**播种,否则会把出生点位移误判成瞬移。 */
    const body = this.state.players.find((p) => p.id === input.userId);

    /* ★ 把玩家登记进**世界**(task-58):`sim.addPlayer` 此前生产调用者为 0,
       于是模拟层不知道有这个玩家 ⇒ `applyPlayerMove` 静默无效,
       距离开闸读刚体 ⇒ 永久 `OUT_OF_AOI`。
       ⚠️ 用**同一个** `body.x/y` 播种,保证反作弊与刚体**同源** ——
       两者不同会让第一次移动被判瞬移(实测差 13.649 格)。
       没有世界时整段跳过(与 `saveToDb`/`levelOf` 同一 null 契约)。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.addPlayer === 'function') {
      host.addPlayer(input.userId, body?.x ?? 0, body?.y ?? 0);
    }

    /* ★★ 读档恢复(task-70 / 契约 §4.1)。**必须在 `ac.join` 之前** ——
     * 反作弊要用**恢复后**的实际坐标播种。
     *
     * ## 顺序:**登记 → 读档 → 反作弊播种 → 落库**
     *
     * `addPlayer` 必须在读档**之前**:`restoreFromProfile` 内部要
     * `applyPlayerMove` 与 `importVitals`,两者对未登记的玩家都是静默 no-op。
     * (与契约 §4.1.1 同一条,理由不同:blob 路要的是「刚体/生命已存在」。)
     *
     * ## 为什么失败时**不报错、只不恢复**
     *
     * 与 `saveToDb`/`levelOf` 同一 null 契约:没有 db、没有存档
     * 都是**正常**情况(首次进入),不是错误。
     * ⚠️ 但**不静默**:返回值与错误分别记在 `restoreApplied` / `restoreError`,
     * 测试可读 ⇒ 让「恢复无效」与「没有存档」可区分(陷阱 89)。
     */
    let restoredPose: { x: number; y: number } | null = null;
    if (host !== null && typeof host.restoreFromProfile === 'function' && this.db) {
      restoredPose = this.restoreFromSnapshot(host, input.userId);
      if (restoredPose !== null) session.restoredFrom = restoredPose;
    }

    /* 反作弊播种:优先用**恢复后**的实际权威坐标;没有存档则用出生点。
       ⚠️ 不用 blob 里的坐标 —— 刚体可能因碰撞被推开,
          两者不同会被判瞬移(实测差 13.649 格)。 */
    this.ac.join(
      input.userId,
      this.state.meta.tick,
      restoredPose?.x ?? body?.x ?? 0,
      restoredPose?.y ?? body?.y ?? 0,
      body?.z ?? 0,
    );

    /* ★★ 恢复后**立刻投影一次**(task-70 实测抓到的一环)。
     *
     * ## 为什么不能等到下一帧的 `step()`
     *
     * `step()` 里的 `projectAllPlayers()` 是常规投影点,但它最早也要**50ms 后**
     * 才跑。而本方法下面那行 `encodeFull(this.state, ...)` 会把
     * **当前**投影编成 join 的初始快照**发给客户端**:
     * ```
     * 不立刻投影 ⇒ 客户端收到的首帧是 level=1 / hp=100 / maxHp=100
     *            ⇒ HUD 先显示 1 级 100 血,50ms 后才跳成 30 级 535 血
     * ```
     * ⇒ 实测确认:`join` 后、`step` 前读 `state.players[].maxHp` 得 **100**,
     *   `step` 后得 535 —— 中间那一帧的错**真的存在**。
     *
     * ## 为什么这不是"第二处投影"(不违反 §4.3 单一写者)
     *
     * 调的**就是** `projectAllPlayers()`,同一个唯一写者,没有第二份实现。
     * ⇒ 「唯一写者」约束的是**谁写 state**,不是**何时写**。
     *   在这里调只是把**本该在下一帧发生的同一次投影**提前到发快照之前。
     *
     * ⚠️ 必须先于 `ac.join` 吗?**不必** —— 反作弊读的是刚体(`playerPosition`),
     *   而投影只写 `state`。两件事互不依赖,故顺序无关;
     *   放在 `ac.join` 之后是为了让「反作弊播种」与「读档」贴在一起更好读。
     */
    if (restoredPose !== null) this.projectAllPlayers();

    this.touch(now);

    const snapshot = encodeFull(this.state, this.state.meta.tick).bytes;
    if (this.db) {
      upsertRoomPlayer(this.db, this.id, input.userId, role, now, snapshot);
    }
    return { ok: true, role, token, snapshot, resumed: false };
  }

  /** 幂等唤醒:SLEEPING → OPEN。 */
  wake(): boolean {
    if (this.status !== RoomStatus.SLEEPING) return false;
    this.status = RoomStatus.OPEN;
    this.wakeCount += 1;
    this.touch(this.clock.nowMs());
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.OPEN, this.clock.nowMs());
    return true;
  }

  /** 进入休眠:状态落盘、成员保留、世界帧号冻结。 */
  sleep(): boolean {
    if (this.status !== RoomStatus.OPEN) return false;
    this.status = RoomStatus.SLEEPING;
    this.sleepCount += 1;
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.SLEEPING, this.clock.nowMs());
    return true;
  }

  close(): boolean {
    if (this.status === RoomStatus.CLOSED) return false;
    this.status = RoomStatus.CLOSED;
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.CLOSED, this.clock.nowMs());
    return true;
  }

  /** 主动离开(非掉线):立刻回收席位与快照。 */
  leave(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s) return false;
    this.members.delete(userId);
    this.state.players = this.state.players.filter((p) => p.id !== userId);
    this.ac.leave(userId);
    /* 世界侧一并移除:留着刚体与 `playerIds` 会让**同名玩家重新加入时**
       继承上一轮的进度/生命值(与 `removePlayer` 注释里「温泉计时被继承」同族)。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.removePlayer === 'function') {
      host.removePlayer(userId);
    }
    if (s.role === RoomRole.OWNER && this.members.size > 0) {
      /* 房主走了:把 OWNER 传给最早的在线 ADMIN/MEMBER。 */
      const next = [...this.members.values()]
        .filter((m) => m.connected)
        .sort((a, b) => a.joinedAtMs - b.joinedAtMs)[0];
      if (next) next.role = RoomRole.ADMIN;
    }
    this.touch(this.clock.nowMs());
    return true;
  }

  /** 掉线:保留席位与快照,记 `disconnectedAtMs`。 */
  disconnect(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s || !s.connected) return false;
    const now = this.clock.nowMs();
    s.connected = false;
    s.token = null;
    s.disconnectedAtMs = now;
    const snapshot = this.snapshotFor(userId);
    if (this.db) saveReconnectSnapshot(this.db, this.id, userId, snapshot, now);
    this.touch(now);
    return true;
  }

  /** 心跳:刷新 lastSeen。 */
  heartbeat(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s) return false;
    s.lastSeenMs = this.clock.nowMs();
    s.connected = true;
    s.disconnectedAtMs = null;
    this.touch(s.lastSeenMs);
    return true;
  }

  /**
   * 把超出宽限期的掉线成员真正移除(在 `tick()` 里驱动)。
   * 返回被清理的 userId 列表。
   */
  reapExpiredDisconnects(): string[] {
    const now = this.clock.nowMs();
    const gone: string[] = [];
    for (const m of [...this.members.values()]) {
      if (m.connected || m.disconnectedAtMs === null) continue;
      if (now - m.disconnectedAtMs > RECONNECT_GRACE_MS) {
        this.members.delete(m.userId);
        this.state.players = this.state.players.filter((p) => p.id !== m.userId);
        this.ac.leave(m.userId);
        gone.push(m.userId);
      }
    }
    if (gone.length > 0) this.touch(now);
    return gone;
  }

  /* ── 4.2 权限门 ── */

  /** 权限裁决。越权返回 false 且**不产生副作用**。 */
  authorize(userId: string, action: RoomAction): { allowed: boolean; reason?: string; role?: RoomRole } {
    const m = this.members.get(userId);
    if (!m || !m.connected) return { allowed: false, reason: '不在房间内' };
    const role = m.role;
    if (!can(role, action)) {
      return { allowed: false, reason: `角色 ${role} 无权执行 ${action}`, role };
    }
    return { allowed: true, role };
  }

  setMemberRole(actorId: string, targetId: string, role: RoomRole): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.SET_MEMBER_ROLE);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    const target = this.members.get(targetId);
    if (!target) return { ok: false, reason: '目标不在房间内' };
    if (targetId === this.ownerId) return { ok: false, reason: '不能改房主角色' };
    if (role === RoomRole.OWNER) return { ok: false, reason: '不能把他人提升为房主' };
    /* ADMIN 不能互相降级,防止管理权互斗。 */
    if (gate.role === RoomRole.ADMIN && target.role === RoomRole.ADMIN) {
      return { ok: false, reason: 'ADMIN 不能修改其它 ADMIN' };
    }
    target.role = role;
    this.touch(this.clock.nowMs());
    if (this.db) upsertRoomPlayer(this.db, this.id, targetId, role, this.clock.nowMs());
    return { ok: true };
  }

  kick(actorId: string, targetId: string): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.KICK_MEMBER);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    if (targetId === this.ownerId) return { ok: false, reason: '不能踢出房主' };
    const target = this.members.get(targetId);
    if (!target) return { ok: false, reason: '目标不在房间内' };
    if (gate.role === RoomRole.ADMIN && target.role === RoomRole.ADMIN) {
      return { ok: false, reason: 'ADMIN 不能踢出 ADMIN' };
    }
    this.leave(targetId);
    return { ok: true };
  }

  setAccess(actorId: string, mode: AccessMode, passwordHash: string | null): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.SET_ROOM_ACCESS);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    if (mode === AccessMode.PASSWORD && !passwordHash) {
      return { ok: false, reason: '密码房必须提供 hash' };
    }
    if (mode === AccessMode.PUBLIC && passwordHash) {
      return { ok: false, reason: '公开房不得带密码' };
    }
    this.accessMode = mode;
    this.passwordHash = passwordHash;
    this.touch(this.clock.nowMs());
    return { ok: true };
  }

  setPartyModeBy(actorId: string, mode: PartyMode): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.SET_PARTY_MODE);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    this.partyMode = mode;
    this.state.meta.partyMode = Object.values(PartyMode).indexOf(mode);
    this.touch(this.clock.nowMs());
    if (this.db) setPartyMode(this.db, this.id, mode, this.clock.nowMs());
    return { ok: true };
  }

  /* ── 4.4 动作分派(RoomAction 的**执行层**)── */

  /**
   * 把 `authorize()` 的「许可」变成「执行 + 回执」。
   *
   * ## 此前的问题(实测,2026-11-14)
   *
   * `room.colyseus.ts` 的 `action` 报文 handler 只有一句:
   * ```
   * authorize(...) ⇒ !allowed ⇒ client.send('reject', ...)
   * ```
   * ⇒ `allowed === true` 时**零执行、零回执、零日志**(成功分支为空)。
   * 于是 22 个 `RoomAction` 长期处于「授权存在、执行不存在」的状态,
   * 而**失败是静默的** —— 玩家按了没反应,没有任何一处能看出原因。
   *
   * ## 为什么本方法**不**自己判权限(这是刻意的分工)
   *
   * 下面 4 个动作的宿主方法(`setMemberRole` / `kick` / `setAccess` /
   * `setPartyModeBy`)**各自第一行就是 `this.authorize(...)`**。
   * 本方法若再判一次,就长出**第二份权限实现** —— 本仓 1 号病根
   * (陷阱 31/41;同族的最近一例是 `vitals.ts:405-408` 记的「两侧都钳 = 两份实现」)。
   * ⇒ 故:**宿主方法自带闸的,直接调用它,再把它的返回值翻译成本方法的返回类型。**
   *
   * ⚠️ 唯一的例外是 `CLOSE_ROOM`:`close()` 是**生命周期方法**,
   *   还被 `onDispose` 与 `reapEvictions` 调用 ⇒ 它**不能**自带权限闸,
   *   闸必须在这里。这个不对称是**刻意的**,不是遗漏。
   *
   * ## 未实现的动作**显式**返回 `NOT_IMPLEMENTED`
   *
   * 静默成功正是本次要消灭的东西。若这里对未实现的动作返回 `ok: true`,
   * 客户端会以为动作生效了,**而门禁一条都红不了**(它只查「成功分支是否为空」)。
   * ⇒ 返回 `ok: false` + `kind: 'NOT_IMPLEMENTED'` ⇒ 它**可被断言**:
   *   「发 `PLACE_BLOCK` ⇒ 回执必须是 NOT_IMPLEMENTED」。
   *   将来谁把它接上,那条断言会**按设计变红**,提醒同时更新
   *   `verify.ts` 的 `VERDICT_HANDLER_KNOWN` 登记。
   *   ★ 这与本仓既有手法一致:**把"未做项"钉成一条会红的断言**,而不是留一句注释。
   */
  dispatchAction(actorId: string, action: RoomAction, payload: ActionPayload = {}): ActionOutcome {
    switch (action) {
      case RoomAction.SET_MEMBER_ROLE: {
        const targetId = payload.targetId;
        const role = payload.role;
        if (typeof targetId !== 'string' || role === undefined) {
          return { ok: false, kind: 'INVALID', reason: '需要 targetId 与 role' };
        }
        const r = this.setMemberRole(actorId, targetId, role);
        return r.ok
          ? { ok: true, kind: 'OK', effect: { targetId, role: String(role) } }
          : this.classifyFailure(actorId, action, r.reason);
      }
      case RoomAction.KICK_MEMBER: {
        const targetId = payload.targetId;
        if (typeof targetId !== 'string') {
          return { ok: false, kind: 'INVALID', reason: '需要 targetId' };
        }
        const r = this.kick(actorId, targetId);
        return r.ok
          ? { ok: true, kind: 'OK', effect: { targetId } }
          : this.classifyFailure(actorId, action, r.reason);
      }
      case RoomAction.SET_ROOM_ACCESS: {
        const mode = payload.mode;
        if (mode === undefined) return { ok: false, kind: 'INVALID', reason: '需要 mode' };
        const r = this.setAccess(actorId, mode, payload.passwordHash ?? null);
        return r.ok
          ? { ok: true, kind: 'OK', effect: { mode: String(mode) } }
          : this.classifyFailure(actorId, action, r.reason);
      }
      case RoomAction.SET_PARTY_MODE: {
        const mode = payload.partyMode;
        if (mode === undefined) return { ok: false, kind: 'INVALID', reason: '需要 partyMode' };
        const r = this.setPartyModeBy(actorId, mode);
        return r.ok
          ? { ok: true, kind: 'OK', effect: { partyMode: String(mode) } }
          : this.classifyFailure(actorId, action, r.reason);
      }
      case RoomAction.CLOSE_ROOM: {
        /* ★ 例外:`close()` 不自带闸(见上方长注释)⇒ 闸在这里。 */
        const gate = this.authorize(actorId, RoomAction.CLOSE_ROOM);
        if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
        const done = this.close();
        if (!done) return { ok: false, kind: 'ROOM_CLOSED', reason: '房间已不是 OPEN' };
        return { ok: true, kind: 'OK', effect: { status: String(this.status) } };
      }
      default:
        return {
          ok: false,
          kind: 'NOT_IMPLEMENTED',
          reason: `动作 ${action} 尚无执行层(授权存在、执行不存在 —— 见 docs/TASK-94)`,
        };
    }
  }

  /**
   * 失败**分类** —— 只在失败路径上问一次 `authorize()`,拿它的**结构化结果**分类。
   *
   * ⚠️ 这里**不许**改成"看 `reason` 字符串里有没有『无权』":
   *   那是本仓反复点名的形态 —— **判据取不到它该判的东西时就会退化成读文本**
   *   (`whitelistBreakdown` 的教训)。`authorize()` 本来就返回布尔,
   *   读它比读它生成的散文可靠。
   *
   * ⚠️ 也**不是**第二份权限实现:判定仍由宿主方法内的那次 `authorize()` 做,
   *   本方法只在它**已经拒绝之后**再问一次,用于分流 PERMISSION 与 INVALID。
   *   `authorize()` 的契约写明"越权返回 false 且**不产生副作用**"⇒ 重问是安全的。
   */
  private classifyFailure(actorId: string, action: RoomAction, reason: string | undefined): ActionOutcome {
    const gate = this.authorize(actorId, action);
    return { ok: false, kind: gate.allowed ? 'INVALID' : 'PERMISSION', reason };
  }

  /* ── 4.3 反作弊转发 ── */

  /**
   * 移动报文 → 反作弊闸 → **写入世界**(task-58 接线)。
   *
   * ## 权威归属(与 `docs/AUTHORITY-MAP.md` 的 W2 同一形态)
   *
   * ```
   * physics.bodies            = **权威**(位置与速度的真值)
   * state.players[].x/y/z     = **只读投影**(网络下发用)
   * ```
   * 与 `level` 的处理**逐点同构**:`progresses.level` 权威,
   * `state.players[].level` 每帧由 `syncLevelProjections()` 单向投影。
   * ⇒ 位置是 W2「双写者」形态的**新实例**,不是新机制。
   *
   * ## 为什么必须**从权威读回**,而不是照抄客户端声明
   *
   * 接线前这里写的是 `p.x = intent.x`(照抄声明)。但那只是「玩家自己走」
   * 那一条路径;`physics.bodies` 还会被**击退/搬运**改(`applyImpulse` /
   * `carry.ts`),那些路径**不经过本方法**。
   * ⇒ 若照抄声明,击退后会出现:
   * ```
   * physics.bodies.x = 99(被击退的真实位置)
   * state.players.x  = 0.7(客户端仍声称自己在原地)
   * ⇒ 客户端以为自己在怪旁边,距离闸读权威说不在 ⇒ **永久 OUT_OF_AOI**
   * ```
   * ⇒ 读回让「击退/搬运对客户端可见」,并消除这条死锁。
   *
   * ## 反作弊只有**一处**判定
   *
   * `ac.move` → `checkMove` 是唯一判定点(上界、非有限值、窗口速率)。
   * `host.applyPlayerMove` **不做**第二次判定 —— 理由见
   * `WorldSim.applyPlayerMove` 的 docblock(不制造第二份等效实现;
   * 第二处还会掩盖第一处失效)。
   *
   * ## `host` 为空时退回旧行为
   *
   * 没有世界 ⇒ 无可读回的权威 ⇒ 照抄声明(与 `levelOf`/`saveToDb`
   * 同一 null 契约)。这不是「两份实现」:写入点始终只有这一处,
   * 分支判据是「有没有世界」。
   */
  applyMove(userId: string, intent: Omit<MoveIntent, 'playerId'>): Verdict {
    const v = this.ac.move({ ...intent, playerId: userId }, 3);
    if (!v.allowed) {
      if (v.violation) this.pendingViolations.push(v.violation);
      return v;
    }

    /* 1 先写进世界(权威)。没有世界则跳过 —— 不报错,不假装。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.applyPlayerMove === 'function') {
      host.applyPlayerMove(userId, intent.x, intent.y);
    }

    /* 2 再把**权威值**投影到 state。
       有世界就从权威读回(含击退/搬运的结果);没有世界就只有声明值可写。
       ⚠️ z **不从权威读**:本次只接 x/y(跨轴混用是新的分叉点,见未做项)。 */
    const p = this.state.players.find((x) => x.id === userId);
    if (p) {
      const auth = host !== null && typeof host.playerPosition === 'function'
        ? host.playerPosition(userId)
        : null;
      p.x = auth?.x ?? intent.x;
      p.y = auth?.y ?? intent.y;
      p.z = intent.z;
    }
    this.touch(this.clock.nowMs());
    return v;
  }

  /**
   * 攻击报文 → 反作弊闸 → **模拟层结算**(US2/task-47 接线)。
   *
   * ## 接线前 vs 接线后(实测)
   *
   * 接线前 `applyAttack` 只做 `ac.attack` 并丢弃结果:
   * ```
   * room.ts:638-642  applyAttack → this.ac.attack(...) → pendingViolations.push → return v
   * ```
   * 实测:玩家的生物 hp 60 → 攻击一次 → **60**(`lastHits` 长度 0、`hitCount` 0)。
   * 即「按攻击键什么都不发生」。
   *
   * ## 协议设计(为什么是 `mobId` 而不是坐标/最近敌人)
   *
   * 报文携带**意图**:打**哪一只**(`mobId`)。
   * - 客户端**不传**坐标:位置权威在 `physics.bodies`,由 `applyMove`
   *    **经 `host.applyPlayerMove` 写入**(task-58 起为真)。
   *    ⚠️ 本句此前写「由 `applyMove` 写入」而当时**并没有**这条写路径
   *    (全仓写 `physics.bodies` 的位置:**0 处**)—— 注释说的是**方向**,
   *    不是**事实**。task-58 补齐了写入,本句才成为对事实的陈述。
   *   若让客户端传目标坐标,等于把「我在哪」这个判据交回客户端。
   * - 客户端**不传** `level` / `wearing` / `weaponId` / `comboMul`:
   *   这些是面板数据,一律由模拟层从权威档案派生
   *   (`attackMobAuthorized` 的签名里根本没有它们)。
   * - 服务端**不信任** `mobId` 本身 —— 它只是「我想打这只」,
   *   能否打到由两道闸决定(AOI 活跃区 + 武器 `reach`)。
   *
   * ⇒ 客户端的自由度只剩「选择目标」,而**目标的合法性与可达性全在服务端**。
   * 这是 CR-14 U1/U2 那族纪律在网络入口上的兑现。
   *
   * @param mobId 客户端指定的目标;缺省/非法时按「无目标」处理(不结算)。
   */
  applyAttack(userId: string, claimedBonus = 0, mobId?: string): Verdict {
    const v = this.ac.attack(userId, this.state.meta.tick, claimedBonus);
    if (v.violation) this.pendingViolations.push(v.violation);
    if (!v.allowed) {
      this.lastAttackReport = null;
      return v;
    }

    /* 反作弊放行后才结算。没有世界 / 没有目标 ⇒ 只记「闸后无执行」,不谎报成功。 */
    const host = this.worldSaveHost;
    if (host === null || typeof mobId !== 'string' || mobId === '') {
      this.lastAttackReport = null;
      return v;
    }

    const authorized = host.attackMobAuthorized(userId, mobId);
    const hit = authorized.hit;
    this.lastAttackReport = {
      tick: this.state.meta.tick,
      playerId: userId,
      mobId,
      outcome: authorized.outcome,
      hpLoss: hit?.hpLoss ?? 0,
      finalDamage: hit?.result.finalDamage ?? 0,
      hit: hit !== null,
      outOfReach: hit?.result.outOfReach ?? false,
      dodged: hit?.result.dodged ?? false,
    };
    return v;
  }

  /**
   * 上一次攻击结算的实际结果;`null` = **没有发生结算**。
   *
   * 与 `lastSaveReport` 同一取舍:`null` 让「没接线」与「接了但这次没打中」
   * 在断言里**可区分**,而不是都表现为「无事发生」。
   */
  lastAttackReport: AttackReport | null = null;

  /**
   * 反作弊物品检查 —— **权威值一律由服务端派生**(CR-14 U1)。
   *
   * 早期版本由调用方(网络层)把 `allowedSources` / `capacity` / `beforeTotal`
   * 三个值**从客户端报文里取**后传进来 ⇒ 判据由客户端决定,等价于该检查不存在:
   * 自带 `allowedSources` 可凭空产出物品、自报 `capacity` 可绕过容量、
   * `beforeTotal` 由本帧 ops 反推使 `NEGATIVE` 分支恒不可达。
   *
   * 现在只接受客户端的 `ops`(它**本就该**来自客户端:玩家要买/卖什么),
   * 其余三个由本方法从服务端状态算:
   *
   * - `allowedSources`:本 tick 服务端认可的合法产出集合 —— 由 `grantedSources`
   *   显式授予(掉落/合成在授予时登记),**客户端无法自行扩集**;
   * - `beforeTotal`:来自 `db`(`totalItemsOf`)的**权威库存总量**,
   *   `db === null`(纯内存模式)时回退到 `inventoryTotals` 本地记账;
   * - `capacity`:来自等级(`carrySlotsAt`),不是客户端自报值。
   *
   * @param input.ops 客户端提交的增减操作(唯一可信来自客户端的部分)
   */
  applyInventory(
    userId: string,
    input: { ops: readonly InventoryOp[] },
  ): ReturnType<AntiCheatRoom['inventory']> {
    const r = this.ac.inventory(userId, {
      tick: this.state.meta.tick,
      ops: input.ops,
      allowedSources: this.grantedSourcesFor(userId),
      beforeTotal: this.authoritativeItemTotal(userId),
      capacity: this.carryCapacityOf(userId),
    });
    if (r.violation) this.pendingViolations.push(r.violation);
    /* 通过的合法操作要落到总量记账上,否则下一次 beforeTotal 仍是旧值 ——
       那会让「总量守恒」这层在连续操作间隔里失真。 */
    if (r.allowed) this.applyItemTotalDelta(userId, input.ops);
    /* 第 8 项:通过后立刻把**总量**按明细重算一次(契约 §2.3「变更时投影」)。
       ⚠️ 必须在 applyItemTotalDelta **之后** —— 否则重算读的是变更前的明细。
       ⚠️ 这条与 applyItemTotalDelta 不是重复:后者是纯内存模式的**退路缓存**,
          前者是**权威重算**(走明细)。host 提供明细时以**重算**为准
          (见 projectInventoryTotalFor 与 projectInventoryTotal 的 docblock)。 */
    this.projectInventoryTotalFor(userId);
    return r;
  }

  /**
   * 服务端认可的「可产出来源集合」。
   *
   * 这是 CR-14 U1 的修复核心:`checkInventory` 判 `allowedSources.has(source)`,
   * 所以这个集合**必须**由服务端持有。授予发生在掉落/合成时
   * (见 `grantItemSource`),每 tick 末由 `expireItemSources` 清理。
   */
  private grantedSourcesFor(userId: string): ReadonlySet<string> {
    return this.grantedSources.get(userId) ?? EMPTY_SOURCE_SET;
  }

  /**
   * 授予一个合法产出凭证 —— **只有服务端逻辑可以调用**。
   *
   * 典型调用点:掉落结算(`damageMob` 之后)、合成成功(`alchemy` 出口)。
   * 凭证带 tick,过期即失效;重复授予同一 source 是幂等的。
   */
  grantItemSource(userId: string, source: string): void {
    const cur = this.grantedSources.get(userId);
    if (cur) cur.add(source);
    else this.grantedSources.set(userId, new Set([source]));
  }

  /** 清掉所有产出凭证。每 tick 末调用 —— 凭证**不跨 tick 累积**。 */
  expireItemSources(): void {
    this.grantedSources.clear();
  }

  /**
   * 权威库存总量。
   *
   * 有 `db` 时读库(`totalItemsOf`),这是**唯一的服务端事实源**;
   * `db === null`(纯内存/测试模式)时用本地记账 —— 那时没有持久层可查,
   * 但记账仍由服务端维护,**绝不取自客户端**。
   */
  authoritativeItemTotal(userId: string): number {
    if (this.db) {
      try {
        return totalItemsOf(this.db, userId);
      } catch {
        /* 库不可用(如未建表)时退回本地记账。刻意不抛:网络层不该因
           持久层故障而拒掉全部合法操作;但记账仍走服务端口径。 */
      }
    }
    return this.inventoryTotals.get(userId) ?? 0;
  }

  /** 把本次 ops 的净变化记到服务端总量上(仅供 `authoritativeItemTotal` 用)。 */
  private applyItemTotalDelta(userId: string, ops: readonly InventoryOp[]): void {
    const net = ops.reduce((s, o) => s + o.delta, 0);
    if (net === 0) return;
    const next = (this.inventoryTotals.get(userId) ?? 0) + net;
    /* 不允许负总量 —— 那意味着内存账与库不一致,夹到 0 并留给上层发现。 */
    this.inventoryTotals.set(userId, next < 0 ? 0 : next);
  }

  /**
   * 权威背包容量 —— 由**等级**决定,不是客户端自报值。
   *
   * 口径:`statsAtLevel(L).carrySlots = 8 + (L-1)`(见 `progression.ts`)。
   * 本方法内联同一公式而非 import 该模块 —— 因为 `progression.ts` 目前在
   * 可达性白名单里(待接线),网络层不该依赖一个尚未接入的模块。
   * 两者数值必须一致,由 `tests/WS-07.test.ts` 钉住。
   */
  carryCapacityOf(userId: string): number {
    const lv = this.state.players.find((p) => p.id === userId)?.level ?? 1;
    return 8 + (lv - 1);
  }

  /** 本地总量记账(仅 `db === null` 时参与计算;有库时以库为准)。 */
  private readonly inventoryTotals = new Map<string, number>();
  /** 每 tick 的合法产出凭证:userId → source 集合。 */
  private readonly grantedSources = new Map<string, Set<string>>();

  drainViolations(): Violation[] {
    const out = this.pendingViolations;
    this.pendingViolations = [];
    return out;
  }

  /* ── 4.4 每帧推进 ── */

  /**
   * 20Hz 推进。返回本帧的编码报文(差量)。
   * `prev` 由调用方持有(通常是「上一帧已发给该客户端的快照」)。
   */
  step(prevSnapshot: RoomState | null = null): Uint8Array {
    if (this.status !== RoomStatus.OPEN) return new Uint8Array(0);
    this.state.meta.tick += 1;
    this.ac.tick(this.state.meta.tick);

    /* ── 推进世界(task-59:驱动缺失)──
       接线前**服务器路径**对 `tick`/`run` 的调用是 **0 处**
       (`setSimulationInterval` → 本方法 → 只 tick 计数/落盘/投影等级 → 返回)
       ⇒ 物理 / AI / 流体 / 电路 / 刷怪 / `syncPlayers()` 一帧都没跑过。
       最要命的是 `syncPlayers()`:它是 `mobPlayers` 的唯一刷新点,
       不跑 ⇒ **生物 AI 看不见玩家移动**。

       ## 为什么是 `advance(1)` 且**只能**写 1
       `WorldSim` 内部自管双频(`FAST_PER_SLOW=10`),一次 `tick()` 就是一帧
       (实测相位 `FAST×9 SLOW FAST×2`);`SIM_FAST_DT = 0.05 = 1/20` 与外部
       20Hz **天然对齐**。⇒ 外部一帧 = 内部一快帧,**恰好 1:1**。

       ⚠️ **绝不可**写成 `advance(FAST_PER_SLOW)` 或在本方法里再调一次 ——
       那会每慢帧推进两次 AI,世界快 2 倍,而**不报错、测试也可能照过**
       (`world_sim.ts` 自己记着这个先例)。翻倍检测断言见 WS-07 的 N 系列。

       ## 为什么放在 `ac.tick` 之后、落盘之前
       - 在 `ac.tick` 之后:反作弊的服务端时钟先单调前进,世界再推进 ——
         两者**互不换算**(见下),顺序只影响「本帧读到哪个值」;
       - 在落盘之前:20 帧节流写库时,存下的是**推进后**的世界,
         与 `world_tick` 同版(否则存的是上一帧的世界)。
       - 在 `syncLevelProjections` 之前:等级投影读的是推进后的权威。

       ## ⚠️ 三个时钟**互不联动**,不要试图让它们相等
       ```
       room.state.meta.tick  本方法 +1(房间 20Hz)
       WorldSim.frame        advance 推进(世界帧)
       ac.s.lastTick         服务端时钟水位(反作弊自己的)
       ```
       实测三者各自增长。**强行让 `sim.frame` 去喂 `ac.tick` 会把
       「客户端申报 tick」与「服务端帧号」混成一个字段** —— 那正是 task-55
       修掉的病根。`MAX_MOVE_CATCHUP_TICKS` 只要求**服务端时钟单调**,
       本方法已用 `meta.tick` 保证,不需要与 `sim.frame` 对齐。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.advance === 'function') {
      host.advance(1);
    }

    this.reapExpiredDisconnects();
    this.checkIdleSleep();
    if (this.db) {
      /* 世界帧号低频落盘(每 20 帧 = 1 秒),避免 20Hz 写库。 */
      if (this.state.meta.tick % 20 === 0) {
        this.db.update('rooms', { id: this.id }, {
          world_tick: this.state.meta.tick,
          last_active_at: this.lastActivityMs,
        });
        /* ── 同一时机把「运行时状态」也落盘(WS-05 D7 + WS-04 §430)──
           刻意复用这条 20 帧节流,而不是另起一个计时器:
           两者都是「世界状态低频落盘」,同样的理由(20Hz 写库会打爆 I/O),
           同样的时机(每秒一次)才自洽 —— 两个独立周期会让读回的
           帧号与存档内容互相错位。

           为什么放在 world_tick **之后**:`saveToDb` 里 `saveRoomMobMem`
           也会写 `last_active_at`,先写帧号再写内容,两者落在同一秒;
           顺序固定,读回时 `world_tick` 与 `mob_mem_json` 必然同版。

           `worldSaveHost` 为 null 时**什么都不做** —— 不撒谎说存过了。 */
        if (this.worldSaveHost) {
          const r = this.worldSaveHost.saveToDb(this.db, this.id, this.lastActivityMs);
          this.lastSaveReport = {
            tick: this.state.meta.tick,
            hpSaved: r.hpSaved,
            hpSkipped: r.hpSkipped,
            memRow: r.memRow,
          };
        }
      }
    }
    /* ⚠️ 必须在 `if (this.db)` **之外** —— 等级投影与有没有数据库无关。
       (放进去的话,纯内存模式 `db === null` 就永远不同步等级,
       而那正是测试最常用的形态。) */
    this.projectAllPlayers();
    return prevSnapshot ? encodeDelta(prevSnapshot, this.state).bytes : new Uint8Array(0);
  }

  /**
   * 把 SSOT 的 **8 个交集字段**单向投影到 `state.players[]`(契约 §2.3;裁决 2 + 3)。
   *
   * ## 本方法此前叫 `syncLevelProjections`,只投 `level`
   *
   * 改名不是重命名:`level` 此前是**唯一**被投影的字段(W2 的修法),
   * 而契约 §2.3 把交集面扩到 8 个。保留旧名会让人以为「这里只管等级」,
   * 从而在别处再加一条投影路径 —— 那正是「两份实现」的起点。
   * ⇒ 单一出口:`step()` 只调本方法,本方法只调 `projectPlayer`。
   *
   * ## 两份等级的关系(这是 US2 必须显式处理的那一条)
   *
   * | 存在哪 | 是谁 | 谁会写 |
   * | :--- | :--- | :--- |
   * | `WorldSim.progresses[].level` | **权威**(升级经 `progression.ts` 真发生在这里) | 击杀结算 |
   * | `state.players[].level` | **投影**(网络编码 + `carryCapacityOf` 读它) | **本方法** |
   *
   * 接线前实测:`room.ts` 里 `level` 赋值 **0 处** ⇒ 该字段恒为 schema
   * 默认值 `1`,于是 30 级玩家的容量仍算 8(预期 37),而网络下发的等级
   * 也是 1。**两套等级各活各的**(见 `docs/AUTHORITY-MAP.md` W2)。
   *
   * ## 为什么是「投影」而不是「双向同步」
   *
   * 只允许**权威 → 投影**单向流动。反向写(把 `state.players[].level`
   * 灌回 `progresses`)会让两处互为依据、谁最后写谁算数 —— 那正是
   * `CR-14 U1` 的病根形态(`beforeTotal` 由本帧 ops 反推 ⇒ 判据自指)。
   *
   * ## 为什么放在 `step()` 而不是 `applyAttack` 里
   *
   * 升级不只是攻击造成的(救援、任务、打盹经验都会发经验),
   * 挂在攻击上会漏掉其余路径。放在每帧推进里,「权威一变,投影随即一致」,
   * 且与 `saveToDb` 的 20 帧节流**同一个 tick 编号**,落盘与下发不会错位。
   *
   * ## ★ 8 字段的权威来源与投影规则(契约 §2.3 表)
   *
   * | # | 字段 | 权威 | 本方法做什么 |
   * | :--- | :--- | :--- | :--- |
   * | 1 | `level` | `progresses` | 夹 `[1, MAX_LEVEL]` 后直传 |
   * | 2 | `hp` | `vitals` | 直传(**不夹** —— 钳制在 vitals 内) |
   * | 3 | `maxHp` | `vitals`(已是派生值) | 先 `syncMaxHp` 再直传 |
   * | 4/5/6 | `x`/`y`/`z` | `physics.bodies` | 直传 |
   * | 7 | `weaponId` | 装备权威 | 直传(`undefined` = 不投) |
   * | 8 | `inventory` | `users.inventory_json`(明细) | ⚠️ **只投总量**,走变更时路径 |
   *
   * ⚠️ 第 8 项**不在这里逐帧投** —— 它是标量,20Hz × N 人无意义(带宽裁定),
   *    由 `projectInventoryTotalFor` 在 `applyInventory` 变更时调一次。
   *
   * ## ⚠️ 顺序:先 `syncMaxHp` 再 `projectPlayer`(不可换)
   *
   * 契约 §4 第 4 步:先按等级同步派生上限,再投影。
   * 换过来的话,升级那一帧投影到的是**旧上限** —— 一帧的错,
   * 且在等级跳变边界上会表现为「血量上限落后一帧」。
   *
   * ## 上界(`level` 夹一次)
   *
   * 理由不是「模拟层可能溢出」(`combatantStats`
   * 内部已钳到 `MAX_LEVEL`),而是**本字段的消费者不钳**:
   * `carryCapacityOf` 直接 `8 + (lv - 1)`,而 `progression.statsAtLevel` 的口径
   * 是 `8 + (L-1)` 且 `L` 已被钳 ⇒ 投影越界会让两处口径分歧。
   * 该上界此前是**惰性**的(level 恒 1),接线后即时生效 ——
   * 由 `WS-07 E18` 两侧扫描钉住(level=30 ⇒ 37;level=31 ⇒ 仍 37)。
   */
  private projectAllPlayers(): void {
    const host = this.worldSaveHost;
    if (host === null) return;
    const view = this.simReadView();
    if (view === null) return;
    /* 逐玩家投影 8 个交集字段(契约 §2.3)。
       ⚠️ 这里**不改 state 以外的任何东西** —— 投影是只读视图的写入,
          不是领域变更。领域变更只在 `WorldSim.tick` 里发生(契约 §4)。
       ⚠️ 顺序:先 syncMaxHp 再 projectPlayer —— 与契约 §4 第 4 步一致。
          maxHp 是派生值,必须先落到 vitals,投影才能读到**本帧**的正确上限
          (反过来的话,升级那一帧投影到的是旧上限 —— 一帧的错)。 */
    for (const p of this.state.players) {
      const lv = view.levelOf(p.id);
      if (Number.isFinite(lv)) {
        const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(lv)));
        /* 裁决 1:maxHp 由 progression 派生,经 vitals.syncMaxHp 落到权威。
           ⚠️ 这里**不算** maxHp 公式 —— 那会是第二份实现(公式在 progression)。
              本方法只做「等级 → 问一次派生值 → 交给 vitals」的搬运。
           ⚠️ 为什么逐帧调而不是只在等级变化时调:
              syncMaxHp 自己返回 bool 且内部判 changed ⇒ 重复调**无副作用**
              实测:`maxHp` 相同且 `hp <= maxHp` 时 changed=false、不写。
              用「这里先判等级变了没」来省调用,会引入**第二处变化检测**,
              而那正是两份实现互相顶着的地方。 */
        const derived = this.derivedMaxHp(p.id, clamped);
        if (derived !== null) this.syncMaxHpOf(p.id, derived);
      }
      projectPlayer(view, p.id, p);
    }
  }

  /**
   * 构造投影读口(契约 §3.1)。
   *
   * ## 为什么在**这里**构造,而不是让 projectPlayer 自己摸 worldSaveHost
   *
   * `projectPlayer` 只接受 `SimReadView` ⇒ 它**结构上**拿不到 `room.state`。
   * 把所有 `host` 的存在性判断收在这一处,投影函数就变成**纯函数**
   * —— 那正是它能被假实现单测的前提。
   *
   * ## ⚠️ 老世界源(只实现了部分读口)怎么办:逐口降级
   *
   * 缺哪个读口,该读口返回「没有权威」:vitalsOf/poseOf 给 null、
   * weaponOf 给 undefined ⇒ 对应字段不投影(保留旧值)。
   * ⇒ 而不是整段跳过:那样「接了 3 个读口」与「一个都没接」表现相同,
   *   断言分不出进度。逐口降级让**接了哪些**成为可观测的。
   *
   * ⚠️ 第 8 项不在这里 —— 走「变更时投影」的单独路径(且**只有明细一条通路**)
   * (契约 §2.3 带宽裁定),读口存在性由 `projectInventoryTotalFor` 自己判。
   */
  private simReadView(): SimReadView | null {
    const host = this.worldSaveHost;
    if (host === null) return null;
    return {
      levelOf: (id) => (typeof host.levelOf === 'function' ? host.levelOf(id) : 1),
      vitalsOf: (id) => (typeof host.vitalsOf === 'function' ? host.vitalsOf(id) : null),
      poseOf: (id) => (typeof host.poseOf === 'function' ? host.poseOf(id) : null),
      weaponOf: (id) => (typeof host.weaponOf === 'function' ? host.weaponOf(id) : undefined),

    };
  }

  /**
   * 派生上限注入点。默认走 `progression.statsAtLevel` —— 但它住在
   * `server/src/combat/`,而 `net → combat` 是**禁止**的依赖方向
   * (契约 §8;`WS-07 K6` 钉住本文件的代码态不得出现模拟层符号)。
   *
   * ⇒ 故派生值必须**由世界源提供**:它同时知道 progression 与 vitals,
   *   是唯一能合法连接两侧的地方(契约 §8「派生值由**调用方**传入,
   *   不让 vitals 自己按 level 查表」)。
   * ⇒ 世界源没提供时返回 null ⇒ 不改 maxHp(保留 vitals 的既有值),
   *   而**不是**拿一个猜的公式兜底 —— 那会是第二份实现。
   */
  private derivedMaxHp(playerId: string, level: number): number | null {
    const host = this.worldSaveHost as
      | (WorldSaveHost & { maxHpForLevel?(id: string, lv: number): number | null })
      | null;
    if (host === null || typeof host.maxHpForLevel !== 'function') return null;
    const v = host.maxHpForLevel(playerId, level);
    return v !== null && Number.isFinite(v) ? v : null;
  }

  /** 把派生上限交给 vitals(经世界源;`net` 不认识 `VitalsSystem`)。 */
  private syncMaxHpOf(playerId: string, derivedMaxHp: number): void {
    const host = this.worldSaveHost as
      | (WorldSaveHost & { syncMaxHp?(id: string, hp: number): boolean })
      | null;
    if (host === null || typeof host.syncMaxHp !== 'function') return;
    host.syncMaxHp(playerId, derivedMaxHp);
  }

  /**
   * 第 8 项 `inventory`:总量投影(契约 §2.3 的 W5 裁定)。
   *
   * ## ★★ 方向 = 明细 → 总量,且**重算**而非累加
   *
   * 累加式(`total += delta`)漏一帧就**永久偏差**;
   * 重算式(`total = f(明细)`)任何一帧只依赖当时的明细。
   * ⇒ 故这里**读明细**(经 `inventoryDetailOf`),不读 `inventoryTotals`。
   *   `inventoryTotals` 是纯内存模式下的**退路缓存**,不是本投影的输入。
   *
   * ## 为什么是「变更时」而不是逐帧(契约 §2.3 带宽裁定)
   *
   * 总量是标量,逐帧投 20 次 × N 人无意义。⇒ 调用方只在
   * `applyInventory` 通过后调一次。
   * ⚠️ 但**重算**这一点与频率无关:低频 + 累加式照样会漂(而且更晚发现)。
   *
   * @returns 是否发生变更(供调用方决定要不要下发)
   */
  projectInventoryTotalFor(userId: string): boolean {
    const host = this.worldSaveHost as
      | (WorldSaveHost & {
        inventoryDetailOf?(id: string): readonly { quantity?: unknown }[] | null;
      })
      | null;
    if (host === null || typeof host.inventoryDetailOf !== 'function') return false;
    const detail = host.inventoryDetailOf(userId);
    if (detail === null) return false;
    const total = projectInventoryTotal(detail);
    const prev = this.inventoryTotals.get(userId);
    if (prev === total) return false;
    this.inventoryTotals.set(userId, total);
    return true;
  }

  /**
   * 成员在线态/打盹态的三分。
   *
   * 打盹有**两个阶段**,由 `AFK_TIMEOUT_MS`(30 分钟)分开:
   *
   * | 阶段 | 占席位 | 计活跃 | 吃经验 | 个人掉落归属 |
   * | :--- | :---: | :---: | :---: | :---: |
   * | `ACTIVE` 清醒 | ✓ | ✓ | 100% | ✓ |
   * | `AFK` 打盹 < 30 分钟 | ✓ | ✗ | `AFK_EXP_RATIO`=30% | ✗ |
   * | `AFK_EXPIRED` 打盹 ≥ 30 分钟 | ✓ | ✗ | 0% | ✗ |
   *
   * `OFFLINE` 是断线(App 已关),与打盹正交:打盹者仍 `connected`。
   * 注意 `AFK_EXPIRED` **仍然占席位、仍然 online** —— 超时不 disconnect。
   */
  memberPresence(m: MemberSession): MemberPresence {
    if (!m.connected) return MemberPresence.OFFLINE;
    if (m.afkSinceMs === null) return MemberPresence.ACTIVE;
    return this.isAfkExpired(m) ? MemberPresence.AFK_EXPIRED : MemberPresence.AFK;
  }

  /** 打盹是否已超过 `AFK_TIMEOUT_MS`。 */
  isAfkExpired(m: MemberSession): boolean {
    if (m.afkSinceMs === null) return false;
    return this.clock.nowMs() - m.afkSinceMs >= AFK_TIMEOUT_MS;
  }

  /**
   * 房间是否「无人」。
   *
   * **打盹 ≠ 离线**:切后台打盹的玩家(无论是否超过 `AFK_TIMEOUT_MS`)
   * 仍然 `connected`、仍然占席位、仍有实体,所以**不能让房间休眠**。
   * 真正触发休眠的只有「没有任何在线连接」。
   */
  hasAnyOnlineConnection(): boolean {
    for (const m of this.members.values()) if (m.connected) return true;
    return false;
  }

  /**
   * 在线且清醒(非打盹)的玩家数。
   *
   * 打盹者(含超时者)**不计入** —— 这是「房间还有没有人在真的玩」的口径,
   * 与「席位是否被占」是两个不同的问题。
   */
  activePlayerCount(): number {
    return [...this.members.values()]
      .filter((m) => this.memberPresence(m) === MemberPresence.ACTIVE).length;
  }

  /** 打盹玩家数(含未超时与已超时;两者都仍占席位)。 */
  afkPlayerCount(): number {
    let n = 0;
    for (const m of this.members.values()) {
      const s = this.memberPresence(m);
      if (s === MemberPresence.AFK || s === MemberPresence.AFK_EXPIRED) n += 1;
    }
    return n;
  }

  /**
   * 打盹已超时(≥30 分钟)且**仍在线**的玩家数。
   * 这些人退出经验分配与个人掉落归属,但仍占席位。
   *
   * 注意用在场态而非裸时间戳判定:一个已断线的成员可能还留着旧的 `afkSinceMs`,
   * 但他的态是 `OFFLINE`(断线优先于打盹),不该被算进打盹超时。
   */
  afkExpiredCount(): number {
    let n = 0;
    for (const m of this.members.values()) {
      if (this.memberPresence(m) === MemberPresence.AFK_EXPIRED) n += 1;
    }
    return n;
  }

  /** 席位占用数(在线即占,与是否打盹、是否超时无关)。 */
  seatCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.connected) n += 1;
    return n;
  }

  /** 某成员的在场态(供 WS-10 经验分配、WS-05 掉落归属查询)。 */
  presenceOf(userId: string): MemberPresence | undefined {
    const m = this.members.get(userId);
    return m ? this.memberPresence(m) : undefined;
  }

  /**
   * 该成员是否应参与**经验分配**。
   * 清醒者全额;打盹未超时者按 `AFK_EXP_RATIO` 折算(由 WS-10 侧乘系数);
   * 打盹超时者**完全退出**;断线者退出。
   */
  isExpEligible(m: MemberSession): boolean {
    const s = this.memberPresence(m);
    return s === MemberPresence.ACTIVE || s === MemberPresence.AFK;
  }

  /** 该成员是否应参与 **Boss 个人掉落归属**(超时打盹者不参与)。 */
  isLootEligible(m: MemberSession): boolean {
    const s = this.memberPresence(m);
    return s === MemberPresence.ACTIVE || s === MemberPresence.AFK;
  }

  /**
   * 标记/取消打盹。打盹只影响「是否计入活跃」,不影响连接与席位。
   *
   * ## task-74:本方法现在是**单向推送**的起点
   *
   * 接线前实测:本方法的**生产调用点 0 处**(`tests/WS-07.test.ts` 有 11 处)。
   * ⇒ 打盹这个状态在模拟层**永不生效** ⇒ `afk` 恒 false ⇒
   *   `aoi` / `behaviors` / `progression` 的三条闸门全是死代码。
   *
   * 现在:房间是打盹的**唯一权威**,每次变更**推**给模拟层。
   * 方向是单向的(房间 → 模拟层)—— 模拟层不反过来问房间,
   * 因为 `room.ts` 有意不认识模拟层类型(见本文件 L270-285 的设计自述)。
   *
   * ## ⚠️ 返回值语义**不变**
   *
   * 仍返回「该用户是否是一个可被标记的在线成员」。
   * 模拟层推送**成功与否不影响它** —— 世界侧没有这个玩家(尚未 `addPlayer`)
   * 时,打盹标记在房间侧**依然成立**(他还是房间成员),只是暂时没有投影。
   * 把这层耦合进返回值会让「房间记下了」与「世界知道了」混成一个布尔。
   */
  setAfk(userId: string, afk: boolean): boolean {
    const m = this.members.get(userId);
    if (!m || !m.connected) return false;
    m.afkSinceMs = afk ? this.clock.nowMs() : null;
    this.pushAfkToHost(userId, afk);
    return true;
  }

  /**
   * 把打盹态推给模拟层(单向)。
   *
   * 抽成私有方法而不是写在 `setAfk` 里,是为了让**其它入口**
   * (`join` / `leave` / `disconnect` / 宽限期超期清理)也能复用同一段 ——
   * 那些入口会让玩家出现/消失,而「消失的玩家仍留在模拟层的打盹集合里」
   * 是一类静默残留(本仓 `afkPlayers` 已按 `playerIds` 过滤来防它,
   * 但离场时**主动清一次**更稳)。
   *
   * 与 `removePlayer` 的调用点同一纪律:写成 `typeof host.x === 'function'`
   * 而不是 `if (host.x)` —— 老的世界源没实现它时整段跳过,不报错也不假装。
   */
  private pushAfkToHost(userId: string, afk: boolean): void {
    const host = this.worldSaveHost;
    if (host !== null && typeof host.setPlayerAfk === 'function') {
      host.setPlayerAfk(userId, afk);
    }
  }

  /**
   * 无人 60 秒 → 自动休眠。
   *
   * 判定条件:**没有任何在线连接**(打盹的不算无人,超时的也不算)
   * **且** 距上次活动 ≥ IDLE_SLEEP_MS。
   * 有连接时直接把活动时间戳刷新,保证「有人挂着」的房间永不进入休眠。
   *
   * 注意:打盹者超时(≥30 分钟)也**不**触发休眠 —— 他还在线、还占席位、
   * 可能随时回来。房间真正无人只发生在全部 `disconnect` 之后。
   */
  checkIdleSleep(): boolean {
    if (this.status !== RoomStatus.OPEN) return false;
    if (this.hasAnyOnlineConnection()) {
      /* 有人在线(含打盹与超时打盹):保持活跃计时,永不休眠。 */
      this.touch(this.clock.nowMs());
      return false;
    }
    if (this.clock.nowMs() - this.lastActivityMs < IDLE_SLEEP_MS) return false;
    return this.sleep();
  }

  touch(nowMs: number): void {
    this.lastActivityMs = nowMs;
  }

  /* ── 4.5 快照 ── */

  /**
   * 某玩家在**本轮会话**的稳定快照。
   * 编码是确定性的(`encodeFull` 遍历顺序固定、定点量化),因此只要世界状态未变,
   * 同一 tick 下重复调用逐字节一致 —— 重连一致性的基础。
   */
  snapshotFor(userId: string): Uint8Array {
    const s = this.members.get(userId);
    if (s) s.seq = this.state.meta.tick;
    return encodeFull(this.state, this.state.meta.tick).bytes;
  }

  /** 供断言:把快照解码回来对照。 */
  cloneState(): RoomState {
    return cloneRoomState(this.state);
  }

  /**
   * **读档恢复**(task-70 / 契约 §4.1)。返回恢复后该玩家的**实际权威坐标**,
   * 或 `null`(无存档 / 存档里没有这个人 ⇒ 走正常出生流程)。
   *
   * ## 为什么读 blob 而不是 `users` 表
   *
   * 实测(契约 §2.2.1):
   * ```
   * level 的唯一持久化处 = room_players.snapshot_blob
   * users 表虽**有** level/max_hp 列,但 saveVitalsToUsers 只写 hp(repo.ts:773),
   * 且 hp 被 cur.max_hp(=建号 100)钳住 ⇒ 实测写 535 读回 100
   * ```
   * ⇒ **只有 blob 装得下** level 与 535 血。
   *
   * ## 只取「自己那一行」
   *
   * blob 是 `encodeFull(state)`(整房快照)⇒ 含所有玩家的行。
   * 本方法**只提取 `userId` 自己**的那行 ——
   * 若把整房都写回权威,那是**用旧快照覆盖别人当前的状态**,
   * 表现为「一个人重连,全房回档」。
   *
   * ## 失败一律返回 `null`,不抛
   *
   * 存档可能:① 不存在(首次进入) ② 协议版本变了(`decodePacket` 会抛)
   * ③ 字节被截断。三者都是**正常的**「没有可用存档」,不该让 join 失败。
   * ⚠️ 但 ② ③ 与 ① 的处置**不同**:前者是**缺陷**,后者是常态。
   *    故 ② ③ 走 `restoreError` 记下来(测试可断言),而不是彻底静默 ——
   *    否则「存档读坏了」与「没有存档」不可区分(陷阱 89)。
   */
  restoreFromSnapshot(
    host: WorldSaveHost,
    userId: string,
  ): { x: number; y: number } | null {
    if (!this.db) return null;
    const restorer = host.restoreFromProfile;
    if (typeof restorer !== 'function') return null;

    const blob = loadReconnectSnapshot(this.db, this.id, userId);
    if (blob === undefined) return null;

    let row: PlayerProjection | null = null;
    try {
      const pkt = decodePacket(blob);
      for (const up of pkt.upserts) {
        if (up.kind !== EntityKind.PLAYER || up.id !== userId) continue;
        const f = up.fields;
        row = {
          level: typeof f.level === 'number' ? f.level : 1,
          hp: typeof f.hp === 'number' ? f.hp : 0,
          maxHp: typeof f.maxHp === 'number' ? f.maxHp : 0,
          x: typeof f.x === 'number' ? f.x : 0,
          y: typeof f.y === 'number' ? f.y : 0,
          z: typeof f.z === 'number' ? f.z : 0,
          weaponId: typeof f.weaponId === 'number' ? f.weaponId : 0,
        };
        break;
      }
    } catch (e) {
      /* 存档存在但读不回来 ⇒ 这是**缺陷**,与「没有存档」不同。记下来供断言。 */
      this.lastRestoreError = `快照解码失败(${userId}):${(e as Error).message.slice(0, 80)}`;
      return null;
    }
    if (row === null) return null;

    /* ⚠️ 先落到**权威**(唯一入口),**不碰** `state.players[]` —— §4.3。
       投影由下一帧的 `syncLevelProjections` 统一做(它已在每帧被调用)。 */
    const applied = restorer.call(host, userId, {
      level: row.level,
      hp: row.hp,
      x: row.x,
      y: row.y,
      z: row.z,
      weaponId: row.weaponId,
    });
    this.lastRestoreApplied = applied;

    /* 返回**恢复后的实际**坐标(不是 blob 里的):刚体可能因碰撞被推开,
       用 blob 坐标播种反作弊会把第一次移动判成瞬移(实测差 13.649 格)。 */
    if (typeof host.playerPosition === 'function') {
      const p = host.playerPosition(userId);
      if (p !== null) return { x: p.x, y: p.y };
    }
    return { x: row.x, y: row.y };
  }

  onlineCount(): number {
    return [...this.members.values()].filter((m) => m.connected).length;
  }

  playerState(id: string): PlayerState | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  /* ── 内部 ── */

  private mintToken(): string {
    this.tokenSeq += 1;
    return `${this.id}-${this.tokenSeq}-${PROTOCOL_VERSION}`;
  }

  private spawnPoint(): { x: number; y: number } {
    /* 出生点铺开:第 n 个玩家沿 X 轴排开 1.5 格,避免叠罗汉误触。 */
    const n = this.state.players.length;
    return { x: 0.5 + (n % 8) * 1.5, y: 0.5 + Math.floor(n / 8) * 1.5 };
  }
}

/* ═══════════════════════════ 5. 房间管理器 ═══════════════════════════ */

export interface RoomRegistryOptions {
  clock: Clock;
  db?: DbLike | null;
  /** 房间被彻底回收时回调(用于清内存缓存)。 */
  onEvict?: (roomId: string) => void;
}

export class RoomRegistry {
  readonly clock: Clock;
  readonly db: DbLike | null;
  private rooms = new Map<string, RoomRuntime>();
  private evicted: string[] = [];
  private readonly onEvict?: (roomId: string) => void;

  constructor(opts: RoomRegistryOptions) {
    this.clock = opts.clock;
    this.db = opts.db ?? null;
    this.onEvict = opts.onEvict;
  }

  create(opts: Omit<RoomRuntimeOptions, 'clock'>): RoomRuntime {
    if (this.rooms.has(opts.roomId)) throw new Error(`房间 id 冲突:${opts.roomId}`);
    const r = new RoomRuntime({ ...opts, clock: this.clock }, this.db);
    this.rooms.set(opts.roomId, r);
    return r;
  }

  get(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId);
  }

  /** 大厅列表:只列 OPEN;`includeSleeping` 时连休眠房一起列(带状态)。 */
  list(includeSleeping = false): RoomRuntime[] {
    return [...this.rooms.values()]
      .filter((r) => r.status !== RoomStatus.CLOSED)
      .filter((r) => includeSleeping || r.status === RoomStatus.OPEN)
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  /** 休眠房超期回收。 */
  reapEvictions(): string[] {
    const now = this.clock.nowMs();
    const out: string[] = [];
    for (const r of [...this.rooms.values()]) {
      if (r.status !== RoomStatus.SLEEPING) continue;
      if (now - r.lastActivityMs < EVICT_MS) continue;
      r.close();
      this.rooms.delete(r.id);
      this.evicted.push(r.id);
      out.push(r.id);
      if (this.onEvict) this.onEvict(r.id);
    }
    return out;
  }

  evictedRooms(): readonly string[] {
    return this.evicted;
  }

  size(): number {
    return this.rooms.size;
  }
}

/* ═══════════════════════════ 6. 便捷装配 ═══════════════════════════ */

export interface BootstrapOptions {
  clock: Clock;
  db?: DbLike | null;
  ownerId?: string;
  ownerName?: string;
}

/** 最小可跑装配:建一个 owner 用户 + 一个房间。测试与冒烟共用。 */
export function bootstrap(opts: BootstrapOptions): { registry: RoomRegistry; ownerId: string; roomId: string } {
  const ownerId = opts.ownerId ?? 'u_owner';
  const roomId = 'room_alpha';
  const db = opts.db ?? null;
  const now = opts.clock.nowMs();
  if (db && !getUser(db, ownerId)) {
    createUser(db, { id: ownerId, displayName: opts.ownerName ?? '岛主', nowMs: now });
  }
  const registry = new RoomRegistry({ clock: opts.clock, db });
  registry.create({ roomId, ownerId });
  return { registry, ownerId, roomId };
}

/** 供 SQL 侧读取房间列表。 */
export function registryRoomIds(db: DbLike): string[] {
  return listRooms(db, { includeSleeping: true }).map((r) => r.id);
}

/** 导出以保持与 repo 层的可组合性(测试会直接调)。 */
export { getRoom, loadReconnectSnapshot };
