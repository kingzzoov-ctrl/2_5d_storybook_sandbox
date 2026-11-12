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
  PROTOCOL_VERSION,
} from '../../../shared/net/delta.ts';
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
    if (db) {
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
    this.ac.join(input.userId, this.state.meta.tick, body?.x ?? 0, body?.y ?? 0, body?.z ?? 0);

    /* ★ 同时把玩家登记进**世界**(task-58):`sim.addPlayer` 此前生产调用者为 0,
       于是模拟层不知道有这个玩家 ⇒ `applyPlayerMove` 静默无效,
       距离开闸读刚体 ⇒ 永久 `OUT_OF_AOI`。
       ⚠️ 用**同一个** `body.x/y` 播种,保证反作弊与刚体**同源** ——
       两者不同会让第一次移动被判瞬移(实测差 13.649 格)。
       没有世界时整段跳过(与 `saveToDb`/`levelOf` 同一 null 契约)。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.addPlayer === 'function') {
      host.addPlayer(input.userId, body?.x ?? 0, body?.y ?? 0);
    }
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
    this.syncLevelProjections();
    return prevSnapshot ? encodeDelta(prevSnapshot, this.state).bytes : new Uint8Array(0);
  }

  /**
   * 把**权威等级**投影到 `state.players[].level`(W2「level 双写者」的裁决)。
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
   * ## 上界
   *
   * 这里**夹一次**上界。理由不是「模拟层可能溢出」(`combatantStats`
   * 内部已钳到 `MAX_LEVEL`),而是**本字段的消费者不钳**:
   * `carryCapacityOf` 直接 `8 + (lv - 1)`,而 `progression.statsAtLevel` 的口径
   * 是 `8 + (L-1)` 且 `L` 已被钳 ⇒ 投影越界会让两处口径分歧。
   * 该上界此前是**惰性**的(level 恒 1),接线后即时生效 ——
   * 由 `WS-07 E18` 两侧扫描钉住(level=30 ⇒ 37;level=31 ⇒ 仍 37)。
   */
  private syncLevelProjections(): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.levelOf !== 'function') return;
    for (const p of this.state.players) {
      const lv = host.levelOf(p.id);
      if (!Number.isFinite(lv)) continue;
      const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(lv)));
      if (p.level !== clamped) p.level = clamped;
    }
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

  /** 标记/取消打盹。打盹只影响「是否计入活跃」,不影响连接与席位。 */
  setAfk(userId: string, afk: boolean): boolean {
    const m = this.members.get(userId);
    if (!m || !m.connected) return false;
    m.afkSinceMs = afk ? this.clock.nowMs() : null;
    return true;
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
