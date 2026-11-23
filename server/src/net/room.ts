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
  /* ★ WS-FND-182:地形下行的差量判据(块版本比较)。 */
  diffChunkVersions,
  /* ★ WS-FND-188:NPC 帧的编码口(静态 NPC 表的一次性下发;见文件尾的 `npcFrame()`)。
     与地形帧同一层:判定/编码都在共享协议层,房间只提供**数据**。 */
  encodeNpcFrame,
  type NpcWireDef,
} from '../../../shared/net/delta.ts';
/* ★ WS-FND-188:静态 NPC 表(`NPCS` 是**唯一**一份)—— 房间只把它投影上线上的形状,
   不另立第二份名单(两份名单迟早漂,而漂的表现是"某个 NPC 只在一个端存在")。 */
import { NPCS } from '../npc/defs.ts';
/* ★ WS-FND-182:地形帧的编码口(单块 1032 字节 = 1024 格 + 8 字节块头)。 */
import {
  encodeTerrainFrames,
  terrainChunkKey,
  type TerrainChunkInput,
} from '../../../shared/net/terrain.ts';
import { EntityKind, TelegraphShape, type BossState } from '../../../shared/types/wire.ts';
/* ★ WS-FND-174:世界钟(秒)的慢帧网格(共享冻结层 SLOW_TICK_HZ = 2,即 0.5s = 世界慢帧 dt)。
   worldSecondsOf() 用它把世界的 frameCount / TICK_HZ 读数换算成世界侧逻辑真正比较的那个数。 */
import { SLOW_TICK_HZ } from '../../../shared/types/physics.ts';
/* ★ WS-FND-123:Boss 投影的两个容器写口。修前 `upsertBoss` 是全仓**唯一**定义且
   **零调用**(`room.ts` 没有 `projectBosses`,`bossSnapshots()` 只有测试调)⇒
   `state.bosses` 恒空,客户端血条与地面预警只能走 demo 兜底。 */
import { removeBoss, removeWildlife, upsertBoss, upsertWildlife } from './schema.ts';
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
  /* ★ WS-FND-156:「起始背包已发」的**库层真值**(发放台账,`repo.ts` §14)。
     这里只搬函数与版本常量,语义写在 `grantStartingInventory` 的判序里。 */
  STARTING_INVENTORY_VERSION,
  claimStartingInventoryGrant,
  migrateStartingInventory,
  readStartingInventoryGrant,
  releaseStartingInventoryGrant,
  /* ★ WS-FND-163(A4):玩家背包账的**读口**(repo §15)。写口在存档主机那一侧
     (`world_sim.saveToDb` 的第 4 参),本文件只负责「导出」与「读回落账」。 */
  loadPlayerLedger,
  /* ★ WS-FND-165(B1):两段新落库口 ——
     1 `savePlayerSnapshots`(repo §18):等级 / 经验 / 天赋 / 位置 / 血量(玩家快照);
     2 `migrateRoomSystemsIfInstalled`(repo §17):房间系统台账的启动漂移检查。 */
  savePlayerSnapshots,
  migrateRoomSystemsIfInstalled,
  type PlayerSnapshotRow,
  /* ★ WS-FND-163(A1):`room_events` 有界保留的**周期轨**(见 `maybeTrimEvents`)。
     修前它只挂在写入路径上(`writeEvent` 内部)与 VACUUM 上 ⇒ 只读房永不 trim。 */
  trimEvents,
  type DbLike,
  type PlayerLedgerSnapshot,
  type StartingInventoryGrantRecord,
} from '../db/repo.ts';
import {
  createPlayerState,
  createRoomState,
  cloneRoomState,
  type PlayerState,
  type RoomState,
} from './schema.ts';
import { MAX_LEVEL } from '../../../shared/types/entities.ts';
import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
/* ★ WS-FND-152:背包容量槽数的**唯一出处**(与冻结层 `statsAtLevel` 同源)。
   修前本文件内联 `8 + (lv-1)` —— 那是同一条规则的第二份实现,改冻结层/改档案都不会
   让容量动一位,而两份数恰好相等 ⇒ 没有判据看得出它们已经分开。 */
import { carryCapacityOfLevel } from '../combat/progression.ts';
/* ★ WS-FND-163(A3):快照的**范围裁剪**半径 = 既有 AOI 唤醒半径(32 格,
   `server/src/mobs/aoi.ts`)。不新造一个数:同一个「多远算近」的语义在
   攻击结算(`OUT_OF_AOI`)与生物唤醒上都用它,再造一份就是第二份口径。
   ⚠️ net → mobs 的依赖边在本仓**已有先例**(`net/actions/modify_town.ts`
   取 `mobs/spawner.ts` 的 `TOWN_SAFE_RADIUS`),不是新开的层间边。 */
import { AOI_WAKE_DISTANCE } from '../mobs/aoi.ts';
/* ★ WS-FND-155:起始背包 —— **发什么**在冻结表 `shared/constants/starting_inventory.ts`,
   本文件不复制内容表、也不猜容量:「装不装得下」问 `carryCapacityOf`(与容量闸同源),
   截断/截断回执全在那个纯函数 `planStartingInventory` 里。 */
import {
  STARTING_INVENTORY,
  planStartingInventory,
  type StartingInventoryEntry,
  type StartingInventoryPlan,
} from '../../../shared/constants/starting_inventory.ts';
/* ★ 第六轮:`meta.partyTimer/scoreA/scoreB` 的**数据源**在本房间的派对赛局记录里
   (`START_PARTY` 写的那份,单例模块)。只读两个导出,不碰它的写口。 */
import { PartyPhase, endParty, partyStateOf } from './actions/start_party.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { lookupActionHandler } from './actions/action_table.ts';
import { tameOwnerOf } from './actions/breed_tame.ts';
import { notImplemented } from './actions/not-implemented.ts';
/* ★ WS-FND-131:世界换代时**顺带**给玩家睡眠登记换代(唯一的换代点在
   `dispatchAction` 的 RESET_WORLD 成功那一刻,见那里的注释)。
   ⚠️ 不引入运行时环:`actions/sleep.ts` 只 `import type` 本文件的类型(擦除)。 */
import { bumpSleepGeneration, forgetSleepWorldClock, noteSleepWorldSeconds } from './actions/sleep.ts';
import type { ActionContext } from './actions/types.ts';
/* 物质层的模块级常量(`PICKUP_RADIUS` / `ITEM_ID_SET`)与 `numField` 随那 4 个动作
   一起搬去了 `net/actions/material.ts` —— 它们只为那 4 个 case 存在,留在这里就是死代码。 */

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
 * ★ **自动存档的墙钟周期 = 30 秒**(owner 裁定 2026-11-20:像 Minecraft 一样
 * 自动保存 —— **不提供**手动 `SAVE`/`LOAD` 动作)。
 *
 * ## 为什么是「周期」而不是「手动动作」
 * 手动存档在多人房里没有正确答案:谁有权存?存的是谁的世界?而丢档的代价由
 * 玩家承担(他可以「忘了存」)。⇒ 存档是**服务端职责**,与帧循环同一个生命周期。
 *
 * ## 两条触发轨,取**先到者**
 * ```
 * 帧节流  AUTOSAVE_FRAME_INTERVAL = 20 帧(32Hz ⇒ 0.625 秒)  ← 既有口径(WS-FND-02 C25 钉着)
 * 墙钟轨  AUTOSAVE_INTERVAL_MS    = 30 秒                ← 本常量
 * ```
 * 保留帧节流不是遗留:它是「32Hz 下不许每帧写库」的**下界**(去掉就退化成 32Hz
 * 写库,C25 当场红);墙钟轨补的是帧节流**保证不了**的那一半 —— 房间被低频驱动
 * (`step()` 一秒才来一次、或长时间没人推进)时,「至少每 30 秒落一次盘」才是
 * 可兑现的承诺。
 *
 * ## 失败面全部是可观测量
 * `lastSaveAt` / `saveCount` / `lastSaveError` / `saveFailCount` / `saveErrors`
 * —— 失败**不抛**(那会让一帧的写库错误掀掉整个房间),但也**不静默**
 * (见 `saveWorldNow()`)。丢档最怕的不是写失败,是**没人知道**它失败过。
 */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** 帧节流:每 20 帧一次低频落盘(32Hz ⇒ 0.625 秒;`tests/WS-FND-02` C25 钉着这个数)。 */
export const AUTOSAVE_FRAME_INTERVAL = 20;

/**
 * ★ WS-FND-165(B1):**玩家快照的周期轨** —— 具名间隔(10 秒)。
 *
 * ## 修前缺陷(实测)
 * ```text
 * users.level / pos_x / pos_y / hp  只在 join / 断线那一刻定格(重连快照那条路)
 * users.exp / talent_json           生产 **0 写入**
 * ```
 * ⇒ 进程崩在两次入场之间,这一段期间的等级 / 经验 / 位置 / 血量**全丢**。
 *
 * ## 为什么是独立的一条轨,而不是合并进 `AUTOSAVE_INTERVAL_MS`
 * 两者是**不同性质**的写:自动存档写的是「世界」(生物 mem / 背包账 / 台账),
 * 这条写的是「人」(等级 / 经验 / 天赋 / 位置 / 血量)。合成一条的后果是
 * 「想让人物状态更及时 ⇒ 连带把整份世界存档频率提上去」(或反之),而那两个
 * 频率本来就该各自调。⇒ 各给一个**具名常量**,谁也别搭谁的便车。
 *
 * 10 秒的口径:一次崩溃最多丢 10 秒的移动/血量(与 `HEARTBEAT_TIMEOUT_MS`
 * 同一量级),而写入量是「在场玩家数 × 一次事务 / 10s」—— 与 30 秒的整份
 * 世界存档相比仍是小头。
 */
export const PLAYER_SNAPSHOT_INTERVAL_MS = 10_000;

/**
 * ★ WS-FND-163(A1):`room_events` **有界保留的周期轨** —— 具名间隔(30 秒)。
 *
 * ## 修前缺陷
 * `repo.ts#trimEvents` 早就写好且**幂等**,但它的触发点只有两个:
 * ```text
 * 1 writeEvent 内部(写入路径)  ⇒ 有写入才会 trim
 * 2 VACUUM / 外部维护           ⇒ 不在进程生命周期里
 * ```
 * ⇒ **只读房**(没人写审计流水:零违规、房间状态不变)永远不会 trim;
 *   而「库不会涨」这条承诺不该依赖「恰好有人在写流水」。
 *
 * ## 为什么是**独立**的轨,而不是搭在存档周期(`saveWorldNow`)上
 * 后者会在三种情形下**什么都不做**(没有库 / 没有世界源 / 上次失败仍在退避窗)。
 * 搭在它上面 ⇒ 「没有世界源的房间,审计流水永不回收」—— 那与修前那个
 * 「只读房永不 trim」是同一个缺陷换个入口。
 * ⇒ 本轨只依赖「有库 + `step()` 被驱动」,与存档能不能做成**无关**。
 *
 * ## 与 `AUTOSAVE_INTERVAL_MS` 同为 30 秒但**不共用**常量
 * 两者是两条独立承诺(「世界状态多久落一次盘」/「审计流水多久收一次」),
 * 合并成一个常量会让「单独调其中一个」变成「顺手把另一个也改了」——
 * 而那两个数之间没有任何必须相等的关系。
 */
export const EVENT_TRIM_INTERVAL_MS = 30_000;

/**
 * ★ WS-FND-172(接线):允许喂给 `AntiCheatRoom` 的**帧间隔上限**(毫秒)。
 *
 * ## 为什么需要这条上限(`ac.tick(t, frameMs)` 的分母语义)
 * `frameMs` 是速度窗口的**分母** ⇒ 分母越大、窗口读数越低(**稀释**)。
 * 而本文件里那行 `ac.tick` 在 `status !== OPEN` **早退之后**
 * ⇒ 房间休眠(无人活动 `IDLE_SLEEP_MS` / 暂停)期间一帧都不调它
 * ⇒ **唤醒后首个差值是整段休眠时长**(以秒计)。照传 ⇒ 读数被稀释到几乎为 0
 * ⇒ 反作弊当场失明 —— **比不接线更糟**。
 *
 * ## 250ms 这条线怎么划的(★ 为什么不随 `TICK_HZ` 推导)
 * 它分的是**两类差值**,而这两类的界线与帧率无关:
 *   · 「调度抖动」(GC / 事件循环被占 / 宿主定时器粒度)—— 数十毫秒量级;
 *   · 「休眠 / 暂停 / 长时间停摆」—— 差值**以秒计**。
 * 标称帧步长的约 **8 倍**是这条线的落点:20Hz ⇒ 8 × 50 = 400ms 也算「抖动」;
 * owner 裁定的 32Hz(31.25ms)⇒ 8 × 31.25 = **250ms**,仍落在两类之间,
 * 而它同时是既有取值 ⇒ **保持 250**。
 * ⚠️ **刻意不写成 `8 × 1000 / TICK_HZ`**:按帧推导会让 20Hz 从 250ms 挪到 400ms
 * (判据值变化 = 无谓回归),而且「抖一点还是停久了」本来就是**绝对时间**的量纲 ——
 * 帧率变了,抖动与休眠的真实尺度没变 ⇒ 阈值不该随帧率漂移。
 * 超上限或**不正**(时钟回拨)的差值一律**丢弃**(`tick(t)` 不传 ⇒ 分母保持上一次
 * 的实测值),并计一次 `RoomRuntime.acFrameGapDiscarded`(丢弃必须可观测,不许静默)。
 *
 * ## 为什么导出
 * 它是判据的**锚**:测试要按它构造「正常抖动 / 休眠唤醒」两组差值。
 */
export const AC_FRAME_GAP_MAX_MS = 250;

/**
 * 存档失败日志的环形上限(诊断够用即可,不随房间寿命增长)。
 *
 * ★ P2(2026-11-21)并发修点:修前那条上限小到「同一段时间里多名玩家一起失败」
 * 时更早的错因会被挤掉(单槽字段 `lastSaveError` 更是只剩最后一份)。这里放宽到
 * 足以留住并发的那几份,且**仍是**有界环形 —— 放宽 ≠ 变成无界。
 */
export const SAVE_ERROR_LOG_MAX = 32;

/**
 * 存档失败后的**退避上界**(帧)。
 *
 * 退避按帧指数增长(`autosaveBackoffFrames`),封顶在这里(与墙钟轨同一量级):
 * 「库里写不进去」不该变成每秒一次的重试,但也不该永久放弃。
 *
 * ⚠️ 刻意**不导出**:它是调度内部量,进 `docs/COVERAGE-MATRIX.md` 的普查块只会
 * 多一条与判据无关的行;判据读 `autosaveState()` 的读数。
 */
const AUTOSAVE_BACKOFF_MAX_FRAMES = 600;

/**
 * 每帧**每名在线玩家**的动作份额下限。
 *
 * 份额 = `floor(MAX_ACTIONS_PER_TICK / 在线人数)`,但不低于本常量 ——
 * 在线人数超过整房预算的格数时,人均份额算出来是 0(等于谁都不能动),
 * 那不是收紧而是瘫痪。
 */
const MIN_ACTIONS_PER_TICK_PER_PLAYER = 1;

/** 入场三方交叉校验的**有界**台账容量(并发入场不再「只剩最后一份」)。 */
const JOIN_AUDIT_LOG_MAX = 64;
/** 世界侧移除证据(成功/失败各留一条)的有界台账容量。 */
const REMOVAL_LOG_MAX = 64;
/** 「待重试移除」与「重进」撞车的有界台账容量(见 `dropPendingRemovalOnJoin`)。 */
const REMOVAL_CONFLICT_LOG_MAX = 64;

/**
 * 触发一次存档的**原因**(写进 `lastSaveReason`,失败日志里也带)。
 *
 * 为什么要有它:只看 `saveCount` 涨了,分不清「周期到了」与「玩家退出触发的」
 * —— 而这两件事在排查「为什么这一版存档里少了一个人」时是完全不同的答案。
 */
export type AutosaveReason = 'frame' | 'interval' | 'leave' | 'dispose' | 'reset' | 'manual';

/**
 * `meta.partyTimer` 的上界:24 小时。
 *
 * 为什么要有:`partyTimer` 在线上是 **POS 类型**(i32 × 1024),而它载的是**秒数**。
 * 超长的值(时钟回拨 / 模式表被人改成天文数字)会让这个字段写出一个编码器
 * 只能按 i32 截断的数 —— 客户端读回一个**负数剩余时间**,而那不报错。
 * 取 24h:四种模式最长 180s,留出的余量已是三个数量级,不会卡住真实值。
 */
export const MAX_PARTY_TIMER_SEC = 24 * 60 * 60;

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
  /* ★ WS-FND-154:**采集**(对「可采集物」,即内容表 §3.1 自然资源的物件)。
     与 `BREAK_BLOCK`(权限位 build、对任意物件)是两件事:采集是**基础生存动作**
     (权限位 baseline,游客也能采),前置 = 距离 + 工具(工具族词条由内容表派生),
     判序与零副作用面见 `actions/gather.ts` 的文件头。 */
  GATHER: 'GATHER',
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
  USE_ITEM: 'USE_ITEM',
  /* ★ WS-FND-77 A-4:百货店购买(`515 无人自助售货摊` 的字面量
     「上架......供游客购买」)。此前 `CLOUD_DEPOT` 的购买语义**没有入口**:
     `depot.buy` 只有测试在调。加这一条把「买」变成一个可授权、可回执、
     可判定的动作(判序见 `actions/buy_item.ts`)。 */
  BUY_ITEM: 'BUY_ITEM',
  /* ★ WS-FND-188:**与 NPC 说话**(世界里的那 4 个人此前看不见也点不到)。

     为什么它是一条 `RoomAction` 而不是一条新报文:说话是**玩家意图**,
     与采集/开箱同一类 —— 它必须走同一条动作路由(权限位 / 单帧预算 /
     幂等与反作弊 / 回执出口),才能被授权、被限流、被回执。
     另开一条报文 = 那四件事各写一遍(本仓 1 号病根)。

     ⚠️ `npcId` 由**客户端**报(它认得自己点的是谁),但服务端**不信**它:
     距离与"附近到底是谁"由 `npcAt()` 在权威坐标上重算
     (见 `actions/npc_talk.ts` 的判序)—— 客户端报的只用来对账。 */
  NPC_TALK: 'NPC_TALK',
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
  /* 使用道具是基础生存动作:吃/喝/投掷都不要求角色权限。
     具体的**能用哪一件**由世界侧判定(未知道具 ⇒ 明确拒绝),不靠权限位表达。 */
  USE_ITEM: 'baseline',
  /* 购买(515 无人自助售货摊)是**基础生存动作**:游客也能在别人的店里买 ——
     能不能成交由世界侧判(`depot.buy` 的定价/库存),不由权限位表达。 */
  BUY_ITEM: 'baseline',
  PLACE_BLOCK: 'build',
  BREAK_BLOCK: 'build',
  /* ★ WS-FND-154:采集是**基础生存动作**(手册 §7.1 的 GUEST 是「能玩能捡」)。
     「这一格能不能采」「工具够不够」「站得够不够近」三件事全在动作层判
     (`actions/gather.ts`),不由权限位表达 —— 权限位只回答「你是谁」。 */
  GATHER: 'baseline',
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
  /* ★ WS-FND-188:与 NPC 说话是**基础生存动作**(游客也能问路)。
     「附近有没有人」「站得够不够近」两件事在动作层用权威坐标判
     (`actions/npc_talk.ts`),不由权限位表达 —— 权限位只回答「你是谁」。 */
  NPC_TALK: 'baseline',
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

/* ═══════════ 1.5 加入凭证:签发 → 校验闭环(审计 P0-1)═══════════ */

/**
 * 加入凭证的载荷 —— 它是**服务端签发的声明**,不是客户端可以自己填的字段。
 *
 * ## 为什么是这三件事,少一件就有一条绕过路径
 * ```
 * userId       缺 ⇒ 拿到别人的 token 就能冒充别人(旧实现:`?userId=u_owner` 即成房主)
 * roomId       缺 ⇒ A 房签发的凭证可以拿去进 B 房(跨房重放)
 * expiresAtMs  缺 ⇒ 凭证永不过期 ⇒ 泄漏一次 = 永久身份
 * ```
 * ## 为什么不是"一个随机串存进 Map 里查"
 * 无状态签名(HMAC-SHA256)让**校验收敛在一个纯函数**里:不用维护表、
 * 不会因为「忘了写过期清理」而变成永久凭证,也就能被断言直接打(见 WS-FND-86)。
 * 代价:签发后无法单独吊销 —— 由**短 TTL**兜住(`JOIN_TOKEN_TTL_MS` 5 分钟)。
 */
export interface RoomTokenClaims {
  userId: string;
  roomId: string;
  /** 过期时刻(epoch ms)。`nowMs >= expiresAtMs` 即过期(**含**边界)。 */
  expiresAtMs: number;
}

/**
 * ★ WS-FND-134(P2):入场(join)被拒的**档位**。
 *
 * ## 缺陷形态(第九轮实测)
 * `JoinResult{ok, reason?}` 只有中文散文 `reason` ⇒ 两个装配层
 * (`ws_server.ts` / `room.colyseus.ts`)与客户端要区分
 * 「房满 / 密码错 / token 过期 / 已在线 / 房间已关」**只能比对字符串** ——
 * 一次文案修订就让所有这类判据静默失效(本仓反复记的形态)。
 *
 * ## 口径
 * ```text
 * ROOM_CLOSED / PASSWORD_MISMATCH / ALREADY_ONLINE / ROOM_FULL  房间策略档
 * TOKEN_*                                                        凭证档(逐条对应绕过路径)
 * JOIN_FAILED                                                    入场中途抛错(已回滚)
 * ```
 * ⚠️ 它是**背离场的档位**,不是"错误码大全":每加一个值都必须同时有
 *   一个真实的拒绝分支在用它(否则它会成为一个"看起来有这条路"的假字段)。
 */
export type JoinRejectCode =
  | 'ROOM_CLOSED'
  | 'PASSWORD_MISMATCH'
  | 'ALREADY_ONLINE'
  | 'ROOM_FULL'
  | 'TOKEN_MISSING'
  | 'TOKEN_MALFORMED'
  | 'TOKEN_SIGNATURE'
  | 'TOKEN_PAYLOAD'
  | 'TOKEN_ROOM_MISMATCH'
  | 'TOKEN_USER_MISMATCH'
  | 'TOKEN_EXPIRED'
  | 'JOIN_FAILED';
/** 凭证校验结论。判别联合:失败时带**具体原因**(每一种对应一条绕过路径)。 */
export type RoomTokenVerdict =
  | { ok: true; claims: RoomTokenClaims }
  /**
   * ★ WS-FND-134(P2):失败时**同时**给散文(`reason`,给人读)与**档位**
   * (`code`,给机器读)。修前只有 `reason` ⇒ `join` 的返回值也无从带上档位。
   *
   * ⚠️ 两者**都要**:把 `reason` 删掉只留 `code` 会让排障的人失去"哪一条
   *   判据拦的"这句话(档位粒度到不了 `token 与房间不符(签给 X,本房是 Y)` 这一层)。
   */
  | { ok: false; code: JoinRejectCode; reason: string };

/**
 * 默认有效期 5 分钟 —— 覆盖 `RECONNECT_GRACE_MS`(30s)且远小于"永久"。
 *
 * ## ★ P1-3(2026-11-19):TTL 的**起算点**有两档,必须分开说
 * ```
 * 签发(join / 重连)     ⇒ 起算点 = 签发时刻(本常量即这一档)
 * 断线中的成员重连时      ⇒ 起算点 = **断线时刻**,且不越过宽限期终点
 * ```
 * 第二档不是"另一张凭证",而是**同一个验签入口**里对「过期」这一项的放宽 ——
 * 口径与实现见 `verifyRoomToken` 的 `expect.expiredOkUntilMs` 与
 * `RoomRuntime.reconnectTokenGraceUntilMs`。为什么服务端不干脆在断线时
 * 换发一张新的:装配层(room.colyseus / ws_server)没有可用的下发通道,
 * 客户端手里那张一出生就被写死了过期时刻 ⇒ 放宽判据是唯一可行的修法。
 */
export const JOIN_TOKEN_TTL_MS = 5 * 60_000;
/** TTL 上限 24 小时(防止调用方传一个"永不过期"的数)。 */
export const JOIN_TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const HEX_DIGITS = '0123456789abcdef';

/** 字节 → 小写十六进制(**不用 Buffer**:本文件保持"只用 node 内建 + 手写编码")。 */
function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const b = bytes[i]!;
    out += HEX_DIGITS[(b >> 4) & 0x0f]! + HEX_DIGITS[b & 0x0f]!;
  }
  return out;
}

/** 十六进制 → 字节;非偶数长度或含非十六进制字符 ⇒ `null`(**不猜**)。 */
function bytesOfHex(text: string): Uint8Array | null {
  if (text.length % 2 !== 0) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.byteLength; i += 1) {
    const hi = HEX_DIGITS.indexOf(text[i * 2]!);
    const lo = HEX_DIGITS.indexOf(text[i * 2 + 1]!);
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** HMAC-SHA256(密钥 = 房间私钥,消息 = `v<协议版本>.<载荷十六进制>`)。 */
function tokenMac(secret: string, signedPayload: string): Uint8Array {
  return createHmac('sha256', secret).update(signedPayload, 'utf8').digest();
}

/**
 * 签发一张加入凭证。**只有服务端**调得动(密钥不出进程)。
 * 形如 `v3.<载荷十六进制>.<签名十六进制>`;三点分段是为了让"格式错"与
 * "签名错"给出**不同**原因(负对照才能分别指认)。
 */
export function signRoomToken(secret: string, claims: RoomTokenClaims): string {
  const payload = hexOf(new TextEncoder().encode(JSON.stringify({
    u: claims.userId, r: claims.roomId, e: claims.expiresAtMs,
  })));
  const prefix = `v${PROTOCOL_VERSION}`;
  return `${prefix}.${payload}.${hexOf(tokenMac(secret, `${prefix}.${payload}`))}`;
}

/**
 * 校验一张加入凭证 —— **全仓唯一的 token 校验实现**(运输层与重连共用同一份)。
 *
 * ## 判据顺序是刻意的
 * ```
 * 1 缺 token        ⇒ 拒(未认证:这就是"带 ?userId=u_owner 即成房主"的那条路)
 * 2 格式/版本不对    ⇒ 拒(而不是当"无 token"放过去 —— 静默降级 = 又一条绕过)
 * 3 签名不符        ⇒ 拒(**先**验签,再读载荷:否则等于信任未认领的 JSON)
 * 4 userId 绑定不符  ⇒ 拒(拿着 u_evil 的凭证声称自己是 u_owner)
 * 5 房间不符        ⇒ 拒(跨房重放)
 * 6 过期            ⇒ 拒(`nowMs >= expiresAtMs`,含边界)——
 *                     除非调用方用 `expiredOkUntilMs` 为**该 userId 自己的重连宽限**开门
 * ```
 * ★ P1-3(2026-11-19):第 6 条是**唯一**可被放宽的一条,放宽方式是把**起算点**
 *   从签发时刻换成断线时刻(不是删掉过期判据)—— 口径与边界见
 *   `expect.expiredOkUntilMs` 的注释。
 * ⚠️ 它排在最后**也是判据的一部分**:宽限回调收到的是**已验签且已绑定**的
 *   `claims.userId` ⇒ 「签名不对也问一次宽限」的写法不存在(签名在第 3 条就返回)。
 * `expect.userId === ''` 表示**只认声明、不核对绑定** —— 只有"凭证即身份"的
 * 入口(Colyseus 的 `sessionId` 由服务端生成,没有可比的声明)才这么用,
 * 见 `RoomRuntime.decodeJoinToken`。
 */
export function verifyRoomToken(
  secret: string,
  token: unknown,
  expect: {
    userId: string;
    roomId: string;
    nowMs: number;
    /**
     * ★ 重连宽限(P1-3,2026-11-19):**允许已过期凭证**的截止时刻。
     *
     * ## 缺陷形态(修前,可算得出,不必实测)
     * ```
     * 凭证的 expiresAtMs 在**签发那一刻**就被写死 = 签发时刻 + 5min。
     * 而客户端手里**只有这一张**:在房里坐满 5 分钟 ⇒ 它已经过期;
     * 此刻掉线,30s 宽限期内重连 ⇒ 第 1 步 verifyJoinToken 判「已过期」
     * ⇒ 席位还在、凭证却不能用 ⇒ 明明在宽限期里,却**必然**被拒
     *  (随后 reapExpiredDisconnects 把席位删掉,进度全丢)。
     * ```
     * ⇒ 为什么不去「断线时换发一张新凭证」:服务端在断线时刻**没有任何
     *   可用的下发通道**(客户端已经走了)。装配层(room.colyseus /
     *   ws_server)只能验它递上来的那一张 ⇒ 能改的只有**判据的起算点**。
     *
     * ## 本项的口径(一句话,与实现逐字对应)
     * ```
     * 断线中的成员,其手中那张凭证的有效期**从断线时刻起算**,
     * 且**不得越过重连宽限期的终点**。
     * 生效值 = min(断线时刻 + JOIN_TOKEN_TTL_MS, 断线时刻 + RECONNECT_GRACE_MS)
     *        = 断线时刻 + RECONNECT_GRACE_MS(30s < 5min,故后者总是更紧)
     * ```
     * ⇒ **全仓唯一**算它的地方是 `RoomRuntime.reconnectTokenGraceUntilMs`
     *   (两处调用点:`verifyJoinToken` / `decodeJoinToken`),不许第二份。
     *
     * ## 放宽的边界(逐条)
     * ```
     * 1 只有「过期」这一项被放宽:签名 / 房间 / userId 绑定 / 载荷格式
     *   一条都没动(它们排在本判据之前,先返回);
     * 2 只有**该 userId 自己**处于断线宽限期时才可能得到非 undefined:
     *   在线成员、宽限期已过、从未入房、查无此人 ⇒ `undefined`
     *   ⇒ 原判据原样生效(负对照就在这几个态上);
     * 3 回调拿到的是**已验签**的 `claims.userId`,而不是调用方声明的那个
     *   (核对绑定时两者相等;`userId === ''` 的入口则完全以凭证为准);
     * 4 「宽限期已过就不再放宽」由 `reapExpiredDisconnects` 保证:席位只多活
     *   RECONNECT_GRACE_MS,过了就不再是"断线中的成员" ⇒ 回调恒 `undefined`。
     * ```
     */
    expiredOkUntilMs?: (claimedUserId: string) => number | undefined;
  },
): RoomTokenVerdict {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 'TOKEN_MISSING', reason: '缺少 token(身份未认证)' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== `v${PROTOCOL_VERSION}`) {
    return { ok: false, code: 'TOKEN_MALFORMED', reason: 'token 格式非法(不是本服务端签发的形式)' };
  }
  const signed = `${parts[0]!}.${parts[1]!}`;
  const given = bytesOfHex(parts[2]!);
  const expected = tokenMac(secret, signed);
  /* `timingSafeEqual` 要求等长,**长度先判** —— 否则它会抛(那会被上游当成"没拒")。 */
  if (given === null || given.byteLength !== expected.byteLength
    || !timingSafeEqual(given, expected)) {
    return { ok: false, code: 'TOKEN_SIGNATURE', reason: 'token 签名不符(伪造或密钥不匹配)' };
  }
  const raw = bytesOfHex(parts[1]!);
  if (raw === null) return { ok: false, code: 'TOKEN_PAYLOAD', reason: 'token 载荷非法' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, code: 'TOKEN_PAYLOAD', reason: 'token 载荷非法' };
  }
  if (typeof decoded !== 'object' || decoded === null) {
    return { ok: false, code: 'TOKEN_PAYLOAD', reason: 'token 载荷非法' };
  }
  const rec = decoded as { u?: unknown; r?: unknown; e?: unknown };
  const userId = rec.u;
  const roomId = rec.r;
  const expiresAtMs = rec.e;
  if (typeof userId !== 'string' || typeof roomId !== 'string'
    || typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
    return { ok: false, code: 'TOKEN_PAYLOAD', reason: 'token 载荷非法(缺 userId/roomId/过期时刻)' };
  }
  if (expect.roomId !== '' && roomId !== expect.roomId) {
    return { ok: false, code: 'TOKEN_ROOM_MISMATCH', reason: `token 与房间不符(签给 ${roomId},本房是 ${expect.roomId})` };
  }
  if (expect.userId !== '' && userId !== expect.userId) {
    return { ok: false, code: 'TOKEN_USER_MISMATCH', reason: `token 与声明的 userId 不符(token 属于 ${userId},却声称 ${expect.userId})` };
  }
  if (expect.nowMs >= expiresAtMs) {
    /* ★ P1-3:过期**默认**拒;只有调用方为**这个 userId 的重连宽限**开门时才放过
       (口径、生效值与放宽边界见 `expect.expiredOkUntilMs` 的长注释)。 */
    const until = expect.expiredOkUntilMs?.(userId);
    if (until === undefined || expect.nowMs >= until) {
      return { ok: false, code: 'TOKEN_EXPIRED', reason: `token 已过期(过期时刻 ${expiresAtMs} ≤ 当前 ${expect.nowMs})` };
    }
  }
  return { ok: true, claims: { userId, roomId, expiresAtMs } };
}

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
  /**
   * ★ WS-FND-134(P2):拒绝**档位**(机器可读)。`ok === true` 时**不出现**。
   *
   * ## 为什么必须有它(而不是再加一句更详细的中文)
   * ```text
   * 装配层  ws_server.ts     → 把它原样放进 { t:'reject', code, reason } 下行
   * 装配层  room.colyseus.ts → 把它放进 reject 报文 / 日志
   * 客户端  能据此分流(而不是比字符串)
   * ```
   * 修前只有 `reason`,而两个装配层**都只能原样转发散文** ⇒ "房满"与
   * "token 过期"在客户端看起来是同一件事(`离开房间`),修法却完全不同。
   *
   * ⚠️ 文案(`reason`)与档位(`code`)是**两个**字段,不许互相替代:
   *   把档位写成散文的枚举匹配 = 文案一改就静默失效(本仓反复记的形态)。
   */
  code?: JoinRejectCode;
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
  /**
   * **强制加入凭证**(默认 false = 只对"进程内直接 `join`"放宽)。
   *
   * ## 为什么要这个开关,而不是让 `join` 无条件强制
   * ```
   * 网络边界(ws_server / Colyseus)⇒ 一律传 true:客户端串不可信
   * 进程内直接 new RoomRuntime().join(...) ⇒ 是**可信代码**路径
   *   (全仓 200+ 处既有调用点,均不携带 token;把它们一律判死
   *    只会让"没被网络碰到"的单元测试全红,而**不会**让攻击面变小)
   * ```
   * ⇒ 强制与否是**调用方(边界)**的表态,不是房间的默认值;
   *   `ws_server.ts` 的 `onHello` 里写死 `requireToken: true`(见那边注释)。
   * ⚠️ 注意:即便本开关为 false,**只要调用方给了 token 就必须验过**
   *   (见 `join` 里那条 `input.token !== undefined` 分支)——
   *   不给 token 是"没声明身份",给一个坏 token 是"伪造",两者不能同待遇。
   */
  requireJoinToken?: boolean;
  worldSeed?: number;
  /**
   * ★ 2026-11-26(w85):**出生原点**(格坐标)。
   *
   * 设计过的世界里出生点**不是地图原点** —— 设计图的 (0,0) 是海,营地在地图中心
   * (实测没这个偏移时:玩家落在 `0.5,0.5` 的水里,而广场在 96 格外)。
   * 由装配层按 `deps.design` 传进来;缺省 `{0,0}` ⇒ 与改前**逐字不变**。
   */
  spawnOrigin?: { x: number; y: number };
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
  /**
   * ★ WS-FND-122:本次是否**按了 [Q]**(报文里的意图位)。
   *
   * 为什么回执要带它:没有这一位,「普攻」与「按了 Q 但没有技能 ⇒ 被拒」
   * 在客户端看起来都是一段伤害 —— 那正是本仓反复记的静默形态。
   */
  useSkill: boolean;
  /**
   * ★ WS-FND-122:世界侧给出的**显式拒绝理由**;`null` = 未被拒绝。
   *
   * 为什么是 `string` 而不是联合类型:`net` 刻意**不 import** 模拟层类型
   * (见 `WorldSaveHost` 的 docblock),在这里照抄一份词表就是第二份口径。
   */
  rejected: string | null;
}

/**
 * ★ WS-FND-122:一次**起跳意图**的结果(供断言与排查)。
 *
 * 与 `AttackReport` 同一取舍:字段全是基本类型(要跨 `net` → 传输层边界被
 * 序列化),且**拒绝也要有记录** —— `jumped:false` + `reason` 让
 * 「按了空格但没跳」与「空格根本没到」在断言里可区分。
 * `reason` 由世界侧给(`NOT_A_PLAYER` / `NO_BODY` / `AIRBORNE` / `COOLDOWN`),
 * 房间另外补一个 `NO_WORLD`(宿主没实现 `jumpPlayer`)。
 */
export interface JumpReport {
  playerId: string;
  jumped: boolean;
  reason: string;
  /** 实际写进权威 `vz` 的值;没跳 ⇒ `null`。 */
  vz: number | null;
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
/* ══════════════ 回执 `effect` 的值域(★ 2026-11-18 第五轮 P1:统一形状)══════════════
 *
 * ## 修前是什么样
 *
 * 契约只允许**标量**,而两个写者塞了嵌套值:
 * ```
 * actions/craft.ts:229              consumed: match.consumed   ← Record<number, number>
 * actions/use_alchemy_furnace.ts:543 consumed / certificate / gallery(对象 + 数组)
 * ⇒ 两处都用 `as unknown as EffectRecord` **绕过**类型
 * ```
 * 绕过之后两端各自的编译器都是绿的:契约说「只放标量」、实现放对象,
 * 线上靠 JSON 恰好能序列化 ⇒ **没有一处会红**。下一个人照「标量」写消费者时
 * 才会炸(`undefined` 字段、`[object Object]` 进 UI)—— 本仓反复点名的
 * 「静默绕类型」形态。
 *
 * ## 裁定:放宽**契约**,而不是继续绕过
 *
 * 回执的唯一出路是报文(`room.colyseus.ts` 的 `client.send('actionResult')`),
 * 而报文就是 JSON ⇒ 允许的值域本来就是 **JSON 值**,不是「标量」:
 * ```
 * EffectValue = string | number | boolean | null | readonly EffectValue[] | EffectRecord
 * ```
 * 顶层仍是 `Record`(键必须是标识符),只有嵌套层递归 —— 深度由数据决定,
 * 于是 `as unknown as` 两处全部消失(见 craft.ts / use_alchemy_furnace.ts)。
 *
 * ## ⚠️ 为什么**不**摊平(`consumed_103: 1` 那种)
 *
 * 键名由内容表 id 决定 ⇒ **键集随配方变**,摊平会得到一个键数随数据膨胀的回执;
 * 而死角在于:逐件账是 `tests/WS-FND-25/31/55/79` 明写要看到的东西
 * (「★ effect 里能看到**扣了哪几件**」),摊平等于把那条证据从回执里删掉。
 * ⇒ 放宽是唯一不动语义、也不动既有断言的写法。
 *
 * ## ⚠️ 值域里**没有** `undefined`
 *
 * `exactOptionalPropertyTypes=false` ⇒ `undefined` 会静默进报文,和「没有这个键」
 * 变成同一件事。要表达「没有」用 `null`(`galleryNote` 就是这一档)。
 * 唯一允许缺省的地方是 `effect` 自己那个 `?:`。
 */
export type EffectScalar = string | number | boolean;
export type EffectValue = EffectScalar | null | readonly EffectValue[] | EffectRecord;
export interface EffectRecord {
  readonly [key: string]: EffectValue;
}

/**
 * `USE_ITEM` 的世界侧回执。
 *
 * ## 为什么 `consume` 与 `applied` 分开
 *
 * 「生效了」和「该扣道具」不是同一件事:
 *   - 733 羽毛笔**超距**时:什么都没发生(不复活),而且**不许扣道具**;
 *   - 733 命中时:复活了,扣 1 件。
 * 一个布尔表达不了这两个维度 ⇒ 分成两个。动作层据此决定要不要 `applyInventory(-1)`
 * (它只信这里回来的 `consume`,不自己再判一次距离 —— 那会是第二份实现)。
 */
export interface UseItemOutcome {
  /** 这次使用是否**真的生效**(世界状态变了)。 */
  applied: boolean;
  /** 是否应扣掉 1 件。⚠️ 只有 `applied === true` 时才允许为 `true`。 */
  consume: boolean;
  /** 给人看的理由(`applied === true` 时为 `'ok'`)。 */
  reason: string;
  /**
   * 回执明细。值域 = `EffectRecord`(**JSON 值**,不是「只标量」)——
   * 与 `ActionOutcome['effect']` 同口径,嵌套项不再靠 `as` 绕过。见 `EffectValue` 的 docblock。
   */
  effect?: EffectRecord;
}

export interface WorldSaveHost {
  /*
   * ★ WS-FND-163(A4):`playerLedgers` = 本房间的**玩家背包账**(按件账 + 总量账)。
   *
   * ## 为什么是可选参数
   * 手写 host 假件(`tests/**` / `scripts/**`)与老实现只声明三个参数本来就合法:
   * 少了它 ⇒ 存档**不写背包**、`ledgerSaved` 缺省(`room.ts` 按 `?? 0` 读),
   * 而不是编译期红 —— 与 `setPlayerAfk` / `resetWorld` 那一族可选成员的取舍同源。
   * 生产宿主(`world_sim.saveToDb`)实现了它,`index.ts` 的装配不需要改。
   *
   * ## 为什么返回字段也是可选的
   * 老宿主的返回值里没有这三个数 ⇒ 「这一次有没有写背包」是 `undefined`。
   * 房间侧按 `?? 0` 读并放进 `lastSaveReport` —— 「没写」与「写了 0 个」在
   * 报告里是同一个数,所以判据要同时看**库里的行**(见 `tests/WS-FND-163`
   * 的注入那条:拿掉这个参数 ⇒ 库里永远没有背包账)。
   */
  saveToDb(
    db: DbLike,
    roomId: string,
    nowMs: number,
    playerLedgers?: ReadonlyMap<string, PlayerLedgerSnapshot>,
  ): {
    hpSaved: number;
    hpSkipped: number;
    memRow: number;
    ledgerSaved?: number;
    ledgerSkipped?: number;
    ledgerDropped?: number;
    /* ★ WS-FND-165(B1):房间系统台账那一段的落地数(1 = 写进去了一行)。
       老宿主(只有前三段)⇒ 这三个键缺省,房间侧按 `?? 0` 读(与上面同一处置)。 */
    /* ★ WS-FND-165(B1):房间系统台账那一段的落地数(1 = 写进去了一行)。
       老宿主(只有前三段)⇒ 这三个键缺省,房间侧按 `?? 0` 读(与上面同一处置)。 */
    systemsRow?: number;
    systemsKeys?: number;
    systemsDropped?: number;
    /* ★ WS-FND-168(B1):房间运行时状态那一行(五段)的落地数 / 字节。同上可选:
       老宿主没有它 ⇒ 缺省,不影响任何既有路径。 */
    runtimeRow?: number;
    runtimeBytes?: number;
  };
  /* ══════════ ★ WS-FND-165(B1):冷启动恢复 + 周期玩家快照的三条声明 ══════════
   *
   * 与上面 `playerLedgers` 同一取舍:**可选**(`?`)。手写 host 假件
   * (`tests/**` / `scripts/**`)不实现它们本来就合法 —— 那种宿主走
   * 「能力缺失」分支(本文件显式记 `skipReason`),**不许**静默假装做过。
   *
   * 1 `restoreRoomSystemsFromDb`  —— 结算幂等台账的**读口**(冷启动那一次):
   *    修前 `roomSystemsState.settled` / `roomDayIndex` 只活在内存 ⇒ 同一张订单
   *    跨进程能再成交一次。返回 `reason` 如实区分 no-table / no-row / corrupt。
   * 2 `exportPlayerSnapshots`    —— 周期快照的**导出**(等级/经验/天赋/位置/血量)。
   * 3 `restoreProgressionFromDb` —— 入场时把**经验/天赋**读回世界(修前 exp 归零)。
   */
  restoreRoomSystemsFromDb?(
    db: DbLike,
    roomId: string,
  ): { applied: boolean; added: number; keys: number; dayIndex: number; dropped: number; reason: string };
  exportPlayerSnapshots?(): readonly PlayerSnapshotRow[];
  /**
   * ★ WS-FND-168:房间运行时状态(**房间系统状态 / 百货机库存 / 地面掉落 / 电路件 /
   * 生物位置朝向**)的读口。可选:没有它的宿主不存在这条读路(这是**显式的边界**,
   * 不是缺陷)—— 与 `restoreRoomSystemsFromDb` 同一处置。
   */
  restoreRoomRuntimeFromDb?(
    db: DbLike,
    roomId: string,
  ): {
    applied: boolean; reason: string;
    crops: number; gallery: number; ranchPets: number; harvest: number;
    depot: number; drops: number; wiring: number; mobs: number;
    corrupt: readonly string[];
  };
  restoreProgressionFromDb?(
    db: DbLike,
    playerId: string,
  ): { applied: boolean; level: number; exp: number; talent: number; reason: string };
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
    /**
     * ★ WS-FND-122:**意图位**,不是面板数据。
     * `useSkill:true` = 「我按了 Q」⇒ 技能由模拟层从**当前武器**取
     * (`skillOf`),这里不传任何技能定义/数值(与 `weaponId` 的自报纪律同源)。
     * 可选:`{useSkill:true}` 与「不传」必须可区分 —— 前者会**显式拒**
     * 没有技能的情况(`NO_SKILL`),后者是普攻。
     */
    opts?: { useSkill?: boolean },
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
    /**
     * ★ WS-FND-122:世界侧的**显式拒绝理由**(`null` = 未被拒绝)。
     *
     * 为什么加它:`outcome` 只有两个值,装不下「为什么没结算」——
     * 而「按了 Q 但这把武器没有技能」必须与「打到了」可区分
     * (修前那种情况会静默退回普攻)。词表由世界层拥有,这里只搬运。
     */
    rejected?: string | null;
  };
  /* ══════════ ★ WS-FND-122:四条「世界侧有能力、网络侧没有出口」的声明 ══════════
   *
   * 与 `setPlayerAfk` / `resetWorld` 同一取舍:**可选**(`?`)。手写 host 假件
   * (`tests/**` / `scripts/**`)不实现它们本来就合法 —— 那种宿主走动作层的
   * 「能力缺失」分支(显式 `NOT_IMPLEMENTED`),**不许**静默成功。
   *
   * ⚠️ 为什么必须在这里声明:`createHost()` 的返回类型标注是 `WorldSaveHost`,
   * `WorldSim` **有**而本接口**没声明**的成员会被**结构化裁掉** ⇒ 房间侧
   * `typeof host.xxx` 在**编译期**恒假(task-70 的实测形态)。
   */
  /**
   * ★ 起跳(`jump` 报文位的落点)。
   *
   * 为什么判据在世界侧而不是房间:地面/冷却要读**权威刚体**(`physics.bodies`),
   * 房间手里没有它。签名只回 `{jumped, reason}` —— 房间不重判。
   */
  tryPlayerJump?(playerId: string): { jumped: boolean; reason: string; vz: number | null };
  /** ★ 218 和平盾的**真实开关**(读口)。见 `WorldSim.shieldOnOf`。 */
  shieldOnOf?(playerId: string): boolean;
  /** ★ 218 和平盾的**写口**(唯一生产调用点:`actions/use_item.ts` 的 218 分支)。 */
  setShieldOn?(playerId: string, on: boolean): boolean;
  /**
   * ★ 整蛊玩具(221..255)的**效果落点**。判定(`gatePrank`)在动作层,
   * 这里只落到权威状态(眩晕计时 + 击退冲量);队友侧零伤害由玩具表保证。
   */
  applyPrankToTarget?(
    actorId: string,
    targetId: string,
    p: { toyId: number; stunSec: number; impulse: number; moveTiles: number; flag: string },
  ): { applied: boolean; reason: string; stunSec: number; moveTiles: number; flag: string };
  /**
   * ★ 436 哨台 `params.mode` 的**唯一写口**(`START_PARTY` 的落点)。
   *
   * `applied:false` + `reason` ⇒ 这一栏写不了(世界里没有哨台 / 模式越界)。
   * ⚠️ 调用方必须把它写进回执 —— 静默当成成功会让「四模式九闸」看起来接好了。
   */
  setRefereeDeskMode?(mode: number): {
    applied: boolean; reason: string; deskId: string | null; mode: number;
  };
  /**
   * 当前**存活**生物的快照(权威 → 投影,每帧一次)。
   *
   * ## 为什么必须由世界提供,而不是房间自己遍历
   * 房间手里只有这个结构化接口,刻意**不 import 模拟层类型** ——
   * 而 `state.wildlife` 总得有东西去填:实测接线前 `upsertWildlife()`
   * 在**全仓 0 个调用点**,于是客户端快照里恒为 `wildlife: []`,
   * 世界里有没有怪都看不见 ⇒ 打怪**永远没有目标**(不是"打不动",是没有)。
   *
   * ## 必选(刻意不写 `?`)
   * 本接口的 `levelOf?` / `applyPlayerMove?` 都是可选的:老的世界源不实现时
   * 整段跳过、不报错。但生物投影**不能**可选 —— 漏掉它的表现是
   * 「世界里满是怪、客户端一只都看不到」,一个不抛错、不打日志的静默失效。
   * ⇒ 写成必选:世界源不提供时,**装配处编译期就该红**。
   *
   * 形状与 `shared/types/wire.ts` 的 `WildlifeState` 逐字段相同
   * (那 9 个字段),这里不 import 它,只为与 `WorldSaveHost` 其余成员
   * 保持同一取舍:接口只描述形状,不引具体层。
   */
  listWildlife(): {
    id: string; mobId: string;
    x: number; y: number; z: number;
    fsm: number; hp: number; maxHp: number;
    tameOwnerId: string;
  }[];
  /**
   * 玩家语义的**物质层**(放置 / 破坏 / 地面物品)。
   *
   * 形状与 `WorldSim.materials()` 逐字段相同(那边导出为 `MaterialApi`);
   * 这里**再写一遍**是刻意的 —— 本接口的取舍是"只描述形状、不 import 具体层"。
   * 两侧若分叉,`createHost()` 里那句 `return sim` 会**编译期**报错
   * (机制说明见 `index.ts` 的 docblock)。
   *
   * 必选(不写 `?`):漏掉它的表现是「能放下、但世界没变」这类静默失效 ——
   * 与 `listWildlife` 同一理由。
   */
  materials(): {
    blockAt(x: number, y: number): number;
    placeBlock(x: number, y: number, objId: number): { ok: true } | { ok: false; reason: string };
    breakBlock(
      x: number, y: number, actorId?: string,
    ): { ok: true; objId: number; gatherMul?: number } | { ok: false; reason: string };
    groundItemsNear(
      x: number, y: number, radius: number,
    ): { itemId: number; count: number; x: number; y: number; dist: number }[];
    consumeGroundItem(itemId: number, count: number, nearX?: number, nearY?: number, radius?: number): number;
    takeGroundItemNear(x: number, y: number, itemId: number, radius: number): boolean;
    dropItem(x: number, y: number, itemId: number, count: number): void;
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
   * ★ WS-FND-152:该玩家的**背包容量槽数**(权威 = 成长档案的 `carrySlots`)。
   *
   * 为什么需要这个读口:修前 `carryCapacityOf` **内联**了 `8 + (lv-1)` ——
   * 那条算式与 `progression.statsAtLevel` 是同一条规则的**两份实现**,
   * 于是「改档案 / 改冻结层」都不会让房间容量动一位,而两者数值恰好相等,
   * **没有判据能看出它们已经分开**。现在房间先问这一口。
   *
   * 可选(与 `levelOf?` 同一取舍):老的世界源没实现它时,容量回落到
   * `combat/progression.ts#carryCapacityOfLevel(level)` —— 仍是同一出处,不报错。
   */
  carrySlotsOf?(playerId: string): number | null;
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
  applyPlayerMove?(playerId: string, x: number, y: number, z?: number): boolean;
  /**
   * 读回玩家的**权威位置**。与 `applyPlayerMove` 成对:
   * 写入后从权威读回、投影到 `state`,才能让**击退/搬运**对客户端可见
   * (那两条走 `applyImpulse` 改速度,不经过 `applyPlayerMove`)。
   */
  playerPosition?(playerId: string): { x: number; y: number; z?: number } | null;
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
   * `WorldSim` 自管**内部双频**(`FAST_PER_SLOW = 16`),而 `tick()` 一次
   * 就是一帧(实测相位 `FAST×9 SLOW FAST×2`)。
   * ⇒ `advance(1)` 对应外部一帧,**恰好 1:1**,不需要换算。
   * `SIM_FAST_DT = 0.03125 = 1/32` 与 32Hz 天然对齐。
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
   * ★ WS-FND-174:**世界钟(秒)** —— `frameCount / TICK_HZ`(世界自己按帧序派生,
   * 不读系统时钟,D-07)。
   *
   * ## 为什么房间要读它
   *
   * 派对 HUD 的剩余时间必须与**判定**同源:模式相位(`party/modes.ts` 的
   * `modeElapsedSec`)与打盹回血(`social/afk.ts` 的 `tickAfk` 收到的 `nowSec`)
   * 用的都是世界侧的 `partyClock`(`0.5s × 慢帧数`)—— 即世界钟。房间此前用
   * `clock.nowMs()`(墙钟)算 HUD 的 elapsed ⇒ HUD 比世界早 20% 走到 0
   * (180 秒的赛:墙上 180 秒时世界还剩 ~37 秒)。
   *
   * ## 为什么写成属性而不是方法
   *
   * `WorldSim` 上的实现是 `get simSeconds()`(`sim/world_sim.ts`)—— 结构化类型下
   * getter 就是只读属性,写成 `simSeconds?(): number` 会和它**编译期对不上**
   * (而「对不上就红」正是本接口存在的意义)。
   *
   * ## 缺它时的语义(可选成员)
   *
   * 手写 host 假件 / 老世界源没有这个读数 ⇒ **不猜**:HUD 停在「本局总时长」并
   * 计数(`partyHudNoClockFrames`),**不**退回墙钟(墙钟正是本缺陷的来源)。
   */
  readonly simSeconds?: number;

  /**
   * ★ WS-FND-182:**地形下行的读口** —— 世界上当前存在的块
   * (坐标 + 版本 + 1024 字节的打包格)。
   *
   * ## 为什么必须在这里声明(而不是房间直接读 `WorldSim` 的内部 Map)
   * `createHost()` 的返回类型标注是 `WorldSaveHost` ⟹ `WorldSim` **有**而本接口
   * **没声明**的成员会被**结构化裁掉**,房间侧 `typeof host.terrainChunks` 在
   * **编译期**恒假(task-70 实测过同一个形态)。⇒ 要用它就必须在这里写出来。
   *
   * ## 形状(与 `WorldSim.terrainChunks` 逐字段一致)
   * ```text
   * cx / cy    块坐标(i16 可表示;键的口径由 `terrainChunkKey()` 统一)
   * version    块版本号 —— 任何真实写入 +1,是"要不要重发"的唯一判据
   * tiles      `Chunk.cells` 本体(**不拷贝**)⇒ 调用方必须在同一同步段内编完
   * ```
   *
   * 可选(与 `levelOf` / `saveToDb` 同一 null 契约):老的世界源不实现它,
   * 房间侧 `terrainDeltaFor` 就返回**空结果**(一帧都不发),不报错也不假装发过
   * —— 空结果与"世界里真的一块都没有"在线上同形,那是本接口的既有取舍
   * (单机演示房本来就没有块)。
   */
  terrainChunks?(): readonly {
    cx: number;
    cy: number;
    version: number;
    tiles: Uint32Array;
  }[];

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
  /**
   * 玩家的**派对队伍**(435 复活旗是唯一来源)。没有队伍 / 世界没有派对 ⇒ `null`。
   *
   * ## 为什么房间需要它(第六轮 P1:`meta.scoreA/scoreB`)
   * `state.meta.scoreA` / `scoreB` 是**队伍口径**的两个比分,而房间手里的派对账
   * (`actions/start_party.ts` 的 `PartySnapshot.scores`)是**按玩家 id** 的。
   * 两者之间缺的正是「这个人在哪一队」—— 那是世界的权威事实(`partyTeams`,
   * 由 `WorldSim.scanPartyTeams` 从 435 旗扫出来),房间不自己猜。
   *
   * 可选(与 `levelOf?` 同一取舍):老世界源没有这个读口时,比分如实写 0,
   * 不按「加入顺序」编一个队伍 —— 编出来的表现是「比分显示在别人头上」,
   * 不报错、不影响推进,只把名次算错。
   */
  partyTeamOf?(playerId: string): string | null;

  /* ══════════ ★ WS-FND-123:boss / party 的四个读口 + 一个写口 ══════════
   *
   * 修前这五条**一条都没有**,于是两条链路在两端各自"正常"、中间断着:
   * ```
   *   bosses :world 有 bossRaid.snapshots()  room 有 upsertBoss()    ⇒ 无人调 ⇒ 客户端 bosses=[]
   *   party  :436 哨台建 contest        START_PARTY 建 PartyRecord   ⇒ 两套开局互不通 ⇒ HUD 恒 0
   * ```
   * 全部**可选**(与 `partyTeamOf?` 同一取舍):手写 host 假件(测试/脚本)不实现
   * 它们本来就合法 —— 缺哪个读口,对应那一款行为**如实不做**(不猜值、不兜底)。
   */

  /** 在场 Boss 的只读快照(`bosses/runtime.ts` 的 12 个内部字段);无 ⇒ `undefined`。 */
  bossSnapshots?(): readonly {
    bossId: string;
    hp: number;
    maxHp: number;
    phaseIndex: number;
  }[];

  /**
   * 在场 Boss 的**线格式**投影(`BOSS_FIELD_TABLE` 的 10 个字段)。
   *
   * 为什么不复用 `bossSnapshots()`:它**不含** `telegraphShape/X/Y/R/EndTick` 与 `id`,
   * 那五格是客户端画地面预警的唯一来源(`bossHudFrom`)。
   * 房间只做搬运(`projectBosses`),几何由世界侧算 —— 这里**不许**再算一遍。
   */
  bossHudSnapshots?(): readonly {
    id: string;
    bossId: string;
    phase: number;
    hp: number;
    maxHp: number;
    telegraphShape: number;
    telegraphX: number;
    telegraphY: number;
    telegraphR: number;
    telegraphEndTick: number;
  }[];

  /** 派对相位(`IDLE` / `BUILD` / `RACE` / `PLAY` / `SETTLED`);没有派对 ⇒ `'IDLE'`。 */
  partyPhase?(): string;

  /** 本局模式键(`BRIDGE_CTF` / `JELLY_BALL` / `CROWN_BR` / `PAINT_WAR`);未开局 ⇒ `null`。 */
  partyModeKey?(): string | null;

  /** 本局裁判的玩家 id(站在 436 哨台上的人);未开局 ⇒ `''`。 */
  partyReferee?(): string;

  /**
   * **开一局派对**(★ 两套开局的另一半)。
   *
   * `START_PARTY` 只建**记分账**(`actions/start_party.ts` 的 `PartyRecord`),
   * 世界侧的 contest 只能由这里开 —— 修前两条路各开一半,于是:
   * `addScore` 永不调用(没账本)/ `partyPhase()` 恒 `IDLE`(没赛局)。
   *
   * 返回 `false` = 世界拒绝(未知模式键 / 空裁判 id),调用方如实记录,**不**当成功。
   */
  startPartyRun?(key: string, refereeId: string): boolean;

  /** 最近一次派对结算的**线格式视图**(终场文案 / 前三名 / 各队名次);无 ⇒ `null`。 */
  partySettlementView?(): {
    modeName: string;
    broadcastText: string;
    top: string[];
    standing: { rank: number; team: string | null; value: number }[];
  } | null;

  /** 急单结算回执(`RUSH_GRADE` 在这里);未结算 ⇒ `null`。 */
  rushSettlement?(): { grade: string; score: number } | null;

  /**
   * 世界总线(**只订阅**,不 emit)。
   *
   * 播报此前只 `bus.emit('party_broadcast')`,而 `server/src` 里 `.bus.on(` 是 **0 处**
   * ⇒ 比分播报 / 终场文案 / 前三名堆在总线里没人取。房间订阅它是这条链的第一段消费。
   */
  bus?: {
    on(pattern: string, handler: (e: { kind: string; payload?: Record<string, unknown> }) => void): unknown;
  };
  /* ⚠️ 此处**刻意没有** `inventoryTotalOf(): {used, cap}` —— 契约 §3.1 列了它,
     但实测它在本仓是**三无**:零实现(WorldSim 没有)、零消费者(step/applyInventory
     都不读)、零断言引用。而它给的又是**总量**,与 W5 的裁定
     「总量必须由**明细重算**,不得当输入」**方向相反** ——
     留着它会鼓励将来有人「读总量再赋给 state」,那正是 W5 要挡的形态。
     ⇒ 第 8 项的真实通路是:
       `projectInventoryTotalFor` → `host.inventoryDetailOf` → `projectInventoryTotal`
     ⇒ 故删声明而不补实现(已在 docs/WS-07-net-persist.md §9.1 记 CR)。 */
  /**
   * **世界重置**(`RESET_WORLD` 的唯一通路)。★ **2026-11-16 起有实现者**:
   * `WorldSim.resetWorld`(`server/src/sim/world_sim.ts`),落点见
   * `docs/DECISIONS.md` **D-06**(= 归档 + 内存重建)。
   *
   * ## 为什么仍是**可选**成员
   *
   * 本接口每个成员都要求实现者**真的做得到**。手写 host 假件(`tests/**`、
   * `scripts/**` 里那几份)不实现它本来就合法 —— 那种宿主走的是动作层的
   * 「能力缺失」分支(显式 `NOT_IMPLEMENTED`,不许静默成功)。
   * 做成必填会逼所有假件补一个**假实现**,那正是本仓反复防的"静默成功"。
   * 配套那行 `return sim` 也说明了这点:可选成员**必须**在这里声明,
   * 否则会被结构化裁掉(`index.ts` 的 `createHost` docblock)。
   *
   * ## 契约:返回**实际生效**的语义(不是"我收到了请求")
   *
   * - `applied: true`  ⇒ 世界已经是新种子,调用方必须假定旧状态全部作废
   *   (地形 / 生物 / 掉落 / 钟点 06:00;玩家保留、满血、回出生点);
   * - `applied: false` ⇒ **一字未改**,`reason` 说清为什么。
   *
   * ## 归档回执(★ D-06,三态的来源)
   *
   * `archive` **必填**(不是可选):
   *   - `{ id, seed, archived_at, bytes }` = 旧世界**已归档**;
   *   - `null` = **明确**没归档,原因在 `archiveError`(`'没有库'` / sink 抛错 / …)。
   *
   * ⚠️ **归档失败不许改 `applied`**:世界确实已经重建了,把 `applied` 写成
   *   `false` 会让调用方以为还停在旧世界(继续用旧 chunk)。动作层
   *   (`net/actions/reset_world.ts` 的 `resetEffect`)按这三态回 `ARCHIVED` /
   *   `NOT_ARCHIVED` / `UNREPORTED`,本接口的形状必须与它**逐字段同形**。
   *
   * ## 参数
   *
   * - `seed`:**新世界**的种子(有限整数;非法 ⇒ `applied: false` + 零副作用);
   * - `nowMs`:**可选**归档时间戳(动作层手里没有时钟,缺省世界自己取
   *   `Date.now()`)。它**只进归档行**,不进模拟 —— 世界时钟由帧序派生(D-07),
   *   挂钟不会污染确定性。
   */
  resetWorld?(opts: { seed: number; nowMs?: number }): {
    applied: boolean;
    /** **实际生效**的种子(`applied: true` 时 = 新世界的种子)。 */
    seed: number;
    reason?: string;
    /** 旧世界归档回执(★ D-06):`{...}` = 已归档;`null` = 明确没归档。 */
    archive: { id: string; seed: number; archived_at: number; bytes: number } | null;
    /** 归档失败 / 没有库的原因(归档没成不该让回执看起来一切正常)。 */
    archiveError?: string;
  };
  /**
   * 该玩家是否已**解锁高级锻造**(★ D-11:站进 `FORGE_MASTER` 房间 ⇒ true)。
   *
   * 世界侧把 `rooms/effects.ts` 的 `RoomEffectResult.forgeUnlocked` 投影成这条读口
   * (不另算一份房间归属)。**可选**(`?`):没有它时 `CRAFT` 对 `station === 505`
   * 的配方回 `NOT_IMPLEMENTED` —— 显式能力缺失,不是静默放行。
   */
  forgeUnlockedOf?(actorId: string): boolean;
  /**
   * **使用一件道具**(`USE_ITEM` 的唯一世界侧落点)。
   *
   * 为什么是一个**通用**口而不是三个专用方法:道具语义按 `itemId` 分派
   * (733 救队友 / 227 困人 / 料理吃 buff),三者共享同一套"判定 → 扣减 → 写回"纪律。
   * 开三个方法会让动作层按 itemId 自己 `if/else`,把语义判断复制到两层。
   *
   * ⚠️ **今天没有"按件背包明细"读口**(`PlayerState` 只有 `heldItemId`)⇒
   *   `itemId` 由动作层从报文取(客户端自报),世界侧**只信它是自己认识的 id**,
   *   不校验"该玩家真的有这一件" —— 那需要先补按件读口(见 `TASK-99`)。
   */
  useItem?(actorId: string, req: { itemId: number; targetId?: string; targetDeviceId?: number }): UseItemOutcome;
  /**
   * **百货店购买(515)的报价**(`BUY_ITEM` 的第一步)。**零副作用**:
   * 在库存副本上跑一遍 `systems/depot.ts:buy`,失败时世界一个字节都不改。
   *
   * 为什么拆成「报价 + 提交」两步:动作层要**先知道这笔能不能成**,
   * 再去扣玩家背包(否则失败时会出现「扣了东西但没买到」)。
   * `buy` 是纯函数 ⇒ 两次调用算的是同一件事,不构成第二份实现。
   *
   * 可选:老的世界源没有摊位 ⇒ 动作层回 `NOT_IMPLEMENTED`(显式能力缺失)。
   */
  purchaseQuote?(itemId: number, qty: number): {
    ok: boolean;
    reason: string;
    cost: number;
    stock: Record<number, number>;
  };
  /**
   * **百货店购买(515)的提交**:只有成交才写库存。
   *
   * 与 `purchaseQuote` 一起构成「检查 → 扣背包 → 落定」的三段事务;
   * 任何一段失败,库存与背包都回到原样(见 `actions/buy_item.ts` 的判序)。
   */
  purchaseCommit?(itemId: number, qty: number): { ok: boolean; cost: number; reason: string };
  /**
   * **炼金首创冠名 + 537 陈列投影**(`ALCHEMY_LAB` 的系统落点)。
   *
   * 为什么不是 `forgeAlchemy`:那条路要外部 LLM 网关,而本仓的确定性
   * 降级路径(`systems/alchemy_lab.ts` → `alchemy/degrade.ts`)在离线也能出产物 ——
   * 「全服首创」因此**在没有模型的房间里也可判定**。
   */
  brewAtFurnace?(actorId: string, itemIds: readonly number[], opts?: {
    affinity?: number;
    suggestedSLogic?: number;
    at?: number;
  }): {
    ok: boolean;
    reason?: string;
    first?: boolean;
    entry?: {
      recipeHash: string;
      discovererName: string;
      itemName: string;
      itemCategory: string;
      craftCount: number;
      firstAt: number;
      schemaJson: string;
    };
    display: {
      recipeHash: string;
      discovererName: string;
      itemName: string;
      itemCategory: string;
      craftCount: number;
      firstAt: number;
    }[];
  };

  /* ══════════ ★ 2026-11-18(第五轮 P2):被**实际读取**的 6 个成员必须在这里声明 ══════════
   *
   * ## 修前是什么形态
   *
   * 下面这 6 个成员 `WorldSim` 都有、房间也都在用,但**本接口一句都没声明** ⇒
   * `createHost()` 的 `return sim` 会把它们**结构化裁掉**,于是各消费方只能:
   * ```
   * room.ts:2667        host as (WorldSaveHost & { syncMaxHp?(...) })        ← 交叉类型
   * room.ts:2694        host as (WorldSaveHost & { inventoryDetailOf?(...) })← 交叉类型
   * actions/sleep.ts     host as unknown as RoomEffectCapableHost           ← 局部窄类型
   * actions/place_automation.ts  host as unknown as SizeCapableHost         ← 局部窄类型
   * actions/use_alchemy_furnace.ts  host as unknown as AlchemyLabReadPort   ← 局部窄类型
   * ```
   * 这与本接口第 798-806 行自称的「结构化裁剪守卫」**直接相悖**:守卫的价值是
   * 「漏声明 ⇒ 编译期红」,而这几处 `as` 让「漏声明」照样编译通过 ⇒ 守卫在最需要它的
   * 地方失效了(第五轮实测 P2)。
   *
   * ## 为什么仍写成**可选**(`?`)
   *
   * 与 `setPlayerAfk` / `resetWorld` 同一契约:手写 host 假件(`tests/**`、`scripts/**`)
   * 不实现它们本来就合法,那种宿主走动作层的「能力缺失」分支(显式 `NOT_IMPLEMENTED`),
   * **不许**静默成功。改成必填会逼所有假件补一个假实现 —— 那正是本仓反复防的形态。
   *
   * ## 形状从哪来(以实现真相为准,不引模拟层类型)
   *
   * 逐字段对着 `server/src/sim/world_sim.ts` 的签名抄,并**只抄房间用到的那几维**:
   * `roomEffectOf` 只留 `inBedroom`(`sleep.ts` 读的那一维)、`lastRoomEffects` 只留
   * `playerId` / `roomKey`(`use_alchemy_furnace.ts` 站位判定读的那两维)——
   * 多抄一维就多一份「将来会漂」的声明。
   */
  /**
   * 等级 → **派生上限**(`progression.statsAtLevel` 的唯一算子,含温泉/大餐乘区)。
   * `null` = 没有这个玩家。房间只**搬运**它(经 `syncMaxHp` 落到权威 `vitals`)。
   */
  maxHpForLevel?(playerId: string, level: number): number | null;
  /**
   * 把派生上限写进权威 `vitals`(钳制策略 C 在 vitals 内,**不在这里再钳一次**)。
   * @returns 是否**真的发生变更**(同值重复提交 ⇒ false,供调用方避免重复投影)。
   */
  syncMaxHp?(playerId: string, maxHp: number): boolean;
  /**
   * 背包**明细**(第 8 项总量重算的唯一输入,契约 §2.3 的 W5 裁定)。
   *
   * ⚠️ 生产实现(`world_sim.ts`)如实返回 `null`:模拟层不持有背包明细。
   * 房间侧因此**必须**有同源的退路(见 `RoomRuntime.inventoryDetailOf` 与
   * `projectInventoryTotalFor`)——「宿主没有明细」不等于「不重算」。
   */
  inventoryDetailOf?(playerId: string): readonly { quantity?: unknown }[] | null;
  /** 该玩家本慢帧的房间效果(只声明 `sleep.ts` 读的那一维)。 */
  roomEffectOf?(playerId: string): { readonly inBedroom: boolean } | undefined;
  /** 世界边长(格)。`place_automation` 的坐标上界读它,读不到才退回防呆常量。 */
  readonly sizeCells?: number;
  /**
   * 最近一慢帧的房间效果**成行**结果(只声明站位判定读的两维:
   * `playerId` / `roomKey`)。`roomKey === null` = 不在任何具名房间。
   */
  lastRoomEffects?: readonly { readonly playerId: string; readonly roomKey: string | null }[];
}

/**
 * ★ WS-FND-174:**世界钟(秒)读数** —— 判定(HUD / 打盹 / 回血)唯一认可的时基。
 *
 * ## 它回答的是什么
 *
 * `host.simSeconds` = `frameCount / TICK_HZ`(世界钟的原始读数),再**量化到慢帧网格**
 * (`SLOW_TICK_HZ`)。量化不是修饰:世界侧真正比较的那个数(`partyClock.now()`,
 * 即 `tickPartyMode` 的 elapsed 与 `tickAfk` 的 `nowSec`)恒等于
 * `0.5 × 慢帧数` = `quant(frameCount / 20)` —— 多一个慢帧才多 0.5 秒。
 * ⇒ 这里读到的数与世界**逐帧相等**,于是「HUD 的剩余秒数」就是「判定的剩余秒数」
 * (差一个慢帧都会让「HUD 归零」与「结算」错帧)。
 *
 * ## 为什么不是墙钟
 *
 * 墙钟只在名义 20Hz 节拍下与它对得上;真实部署的帧率低于名义值(实测 ~16Hz)时,
 * 两者差约 20% ⇒ 用墙钟算剩余,180 秒的赛在墙上 180 秒就显示「剩余 0」,
 * 而世界还剩 37 秒(HUD 与判定打架,且**不报错**)。
 *
 * @returns 世界钟秒;没有读数(host 为 null / 老世界源 / 非有限数)⇒ `null`,
 *          调用方**如实降级**(HUD 停在总时长;睡眠登记退回模块时钟)。
 */
function worldSecondsOf(host: WorldSaveHost | null): number | null {
  const sec = host?.simSeconds;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null;
  return Math.floor(sec * SLOW_TICK_HZ) / SLOW_TICK_HZ;
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
 * 契约 §3.2 要求返回 `boolean` 供差量编码复用 —— 但含义必须是
 * **「有字段真的变了」**,不是「读到了权威」。理由:
 * ```
 * 若返回「读到了」⇒ 每帧恒 true ⇒ 差分编码退化成全量下发
 * (带宽浪费,且掩盖"其实没变"这个事实)
 * ```
 *
 * ## ⚠️ 为什么 `level` 要夹上界,而 `hp`/`maxHp` 不夹
 *
 * `level` 夹一次(与既有 `syncLevelProjections` 同口径),理由是本字段的
 * **消费者不夹**:`carryCapacityOf` 现在**不再自己算**(WS-FND-152:改调
 * `combat/progression.ts#carryCapacityOfLevel`,与 `statsAtLevel` 同一出处)。
 * 但投影仍必须夹:档案 `carrySlots` 走的是玩家等级,而等级越界会让
 * `state.players[].level` 与档案等级分歧 —— 那正是这一行的由来。
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
  /** `SET_PARTY_MODE`:派对模式。 */
  partyMode?: PartyMode;
  /* ── 物质层的四个动作(2026-11-14)────────────────────────────

     这四个字段此前**不存在**,因为那四个动作没有执行层(`TASK-96`)。
     它们都取"客户端只说**做什么**,不说**在哪/多少算数**"的口径:
     `x`/`y` 是目标格,`itemId` 是内容表里的 id,`count` 是件数。
     ⚠️ 丢弃/拾取**不用**客户端报的坐标 —— 落点取权威位置(见 `dispatchAction`)。 */
  /** `PLACE_BLOCK` / `BREAK_BLOCK`:目标格坐标。 */
  x?: number;
  y?: number;
  /** `PLACE_BLOCK` / `DROP_ITEM` / `PICKUP_ITEM`:物品 id(必须在冻结内容表里)。 */
  itemId?: number;
  /** `DROP_ITEM`:丢弃件数(默认 1)。 */
  count?: number;
  /**
   * `USE_ITEM`:目标**器件**(料理站等设备 id)。
   *
   * 与 `targetId`(玩家)是**互斥**的两种报文形态:器件目标走"浇灭炉火",
   * 玩家目标走"救人 / 困人 / 吃 buff"。**两者同时给出 ⇒ 动作层直接拒(`INVALID`)**
   * (`net/actions/use_item.ts`);世界侧另有一道兜底:见 `targetDeviceId` 就不读 `targetId`。
   * 器件在内容表里是**物件 id**(506 汤锅 / 507 切菜台 / 508 披萨炉),不是玩家 id。
   */
  targetDeviceId?: number;
  /**
   * `USE_ITEM`:服务端**账面**的格子序号(0 起,按 `itemId` 升序)。
   *
   * 它不是客户端自报的物品 id —— 服务端拿它去自己的按件账上翻出真实 `itemId`,
   * 与申报的 `itemId` **不一致就拒**(见 `actions/use_item.ts`)。
   * 之所以让客户端能报 slot:UI 列表天然是"第几格",而**翻译**这一步必须在服务端。
   */
  slot?: number;

  /* ── ★ 2026-11-18(第五轮 P2):7 个动作的**消费键**此前不在契约里 ────────────
   *
   * 实测:下列键各自被动作模块读取,却**一个都没写进本接口** ⇒ 消费方只能
   * 各自补交叉类型(`ActionPayload & { ... }`,六处)或直接 `as { key?: unknown }`,
   * 于是「协议只有一处」这条纪律在实际读写里被绕过:
   * ```
   * WIRE_EDIT          dir / color / channel / clear
   * BREED_TAME         op / petId / mobId / mateId
   * MODIFY_TOWN        radius / name / totemCell
   * RESET_WORLD        seed / confirm
   * BUY_ITEM           qty / orderId
   * ALCHEMY_LAB        orderId(与 BUY_ITEM 同键:同一个幂等请求号语义)
   * PLACE_AUTOMATION   kind
   * ```
   *
   * ⚠️ 为什么**全部**是 `unknown` 而不是各自的细类型:
   * 报文是**外部输入**,`ws_server` 把客户端 JSON 原样递进来 ⇒ 契约侧只能说
   * 「这个键可能出现,值未知」;真正的收窄在**唯一**的消费处(各动作模块的
   * `intField` / `numField` / 域检查),那里失败一律 `INVALID` 并**不猜默认值**。
   * 若在这里写 `radius?: number`,就等于让「字符串 8」在编译期变成合法报文 ——
   * 那是把消毒从动作层挪进类型系统,而类型系统在运行期不存在。
   *
   * ⚠️ 各动作模块里的局部交叉类型(如 `TownPayload`)现在与这里**同义重复**,
   * 但它们是**读**用的窄化,不是第二份协议定义;是否删由各模块自己定
   * (本次可改范围不含那几个文件)。
   */
  /** `WIRE_EDIT`:方向下标(合法域 = `DIR_VECTORS` 下标)。 */
  dir?: unknown;
  /** `WIRE_EDIT`:四色之一(合法域 = `ALL_COLORS`)。 */
  color?: unknown;
  /** `WIRE_EDIT`:无线频道(合法域 = `[CHANNEL_MIN, CHANNEL_MAX]` 整数)。 */
  channel?: unknown;
  /** `WIRE_EDIT`:`true` = 断开(只接受字面 true)。 */
  clear?: unknown;
  /** `BREED_TAME`:子动作(`TAME` / `FEED` / `BREED` …)。 */
  op?: unknown;
  /** `BREED_TAME`:宠物 id。 */
  petId?: unknown;
  /** `BREED_TAME`:生物 id。 */
  mobId?: unknown;
  /** `BREED_TAME`:繁殖配对的那一只。 */
  mateId?: unknown;
  /** `MODIFY_TOWN`:新安全区半径(有限整数,`MIN/Max_TOWN_RADIUS` 之间)。 */
  radius?: unknown;
  /** `MODIFY_TOWN`:新城镇名(去空白后 1..`MAX_TOWN_NAME_LEN`)。 */
  name?: unknown;
  /** `MODIFY_TOWN`:新图腾格;`null` = 清掉图腾。 */
  totemCell?: unknown;
  /** `RESET_WORLD`:新世界种子(有限整数)。 */
  seed?: unknown;
  /** `RESET_WORLD`:二次确认(只接受字面 true —— 重置是不可逆破坏性动作)。 */
  confirm?: unknown;
  /** `BUY_ITEM`:购买件数(正整数;**缺省不等于 1**,缺了就是 `INVALID`)。 */
  qty?: unknown;
  /** `BUY_ITEM` / alchemy:客户端请求号(可选幂等键;给了就**原样**透传)。 */
  orderId?: unknown;
  /** `PLACE_AUTOMATION`:组件种类名(必须在 `wiring` 注册表里)。 */
  kind?: unknown;
  /**
   * ★ WS-FND-188:`NPC_TALK`:要跟哪一个说话(`server/src/npc/defs.ts` 的 `NpcDef.id`)。
   *
   * ⚠️ 由**客户端**报(它认得自己站在谁旁边),但服务端**不信**它:
   *   距离与"附近到底是谁"由 `npcAt()` 在**权威坐标**上重算,
   *   不一致 ⇒ `INVALID`(见 `actions/npc_talk.ts` 的判序)。
   *   不这么做的后果:站在营地也能隔着半张地图跟农田里的老农对话。
   */
  npcId?: unknown;
}

/**
 * 一次动作分派的**结果 + 回执**。`effect` 放可序列化的少量字段 ——
 * 回执要能直接进报文,不许把内部对象漏出去。
 *
 * ⚠️ `effect` 的值域是 `EffectRecord`(**JSON 值**),不是「只标量」:
 * `craft` 的逐件扣料表 / `use_alchemy_furnace` 的冠名证书与陈列投影都是嵌套结构,
 * 它们此前被 `as unknown as EffectRecord` 绕过(见 `EffectValue` 的 docblock)。
 * 仍然**不许**漏内部对象:能进这里的只有**纯数据**(JSON 值),不是类实例/Map/函数。
 */
export interface ActionOutcome {
  ok: boolean;
  /**
   * 结果类别。**必须显式**(含 `NOT_IMPLEMENTED`)= 消灭"静默成功"的载体。
   *
   * ★ P1(2026-11-21)预算档修点:`THROTTLED` 是**单帧动作预算**被吃光时的那一档;
   * 修前它复用了 `INVALID` —— 与「不是参数问题」的注释**自相矛盾**(客户端只能
   * 读到一个「你参数错了」,而真正的原因是这一帧挤不下)。
   */
  kind: 'OK' | 'PERMISSION' | 'INVALID' | 'THROTTLED' | 'NOT_IMPLEMENTED' | 'ROOM_CLOSED';
  /** 失败原因;`ok === true` 时不存在。 */
  reason?: string;
  /** 成功时的后果摘要(回执用)。值域见 `EffectValue`。 */
  effect?: EffectRecord;
}

/**
 * **按件库存读口**(`USE_ITEM` 的 itemId 权威来源)。
 *
 * ## 为什么独立成接口,而不是塞进 `ActionContext`
 *
 * `actions/types.ts` 是**跨动作**的契约文件(另一条线在改它)。
 * 这一项只有 `USE_ITEM` 用,且它必须由**房间**实现(账本在 `RoomRuntime`)。
 * ⇒ 用结构化类型接线:`RoomRuntime` 直接把绑定后的两个函数放进 `ActionContext`,
 * 处理器侧用 `Partial<ItemReadPort>` 窄化(**缺读口**时走"没有权威"分支,
 * 而不是假装有 —— 与 `simReadView` 的逐口降级同一取舍)。
 */
export interface ItemReadPort {
  /** 某玩家的某件道具**真的**有几件;0 = 账面没有。 */
  itemCountOf(userId: string, itemId: number): number;
  /** 该玩家按 itemId 升序的持有清单(`slot` 报文体据此翻译)。 */
  itemIdsOf(userId: string): number[];
}

/**
 * 第 8 项「总量 ← 明细」重算时,明细**是从哪来的**(诊断与判据用;见
 * `RoomRuntime.inventoryDetailSource`)。
 *
 * ```
 * 'host' = 世界源提供了明细(它以世界侧权威为准)
 * 'room' = 宿主没有明细(生产实现恒 null)⇒ 退回**本房间按件账**(与总量账同一批 ops)
 * 'none' = 两个来源都没有 ⇒ **不重算**(fail-closed,不编造 0)
 * ```
 */
export type InventoryDetailSource = 'host' | 'room' | 'none';

/**
 * ★ WS-FND-155:起始背包的**发放回执**(可观测面;`RoomRuntime.lastStartingInventory`)。
 *
 * 三态**不许合并**(合并就是「把不确定说成确定」):
 * ```text
 * GRANTED  真的写进账了(件数 / 截断都在下面两份清单里)
 * SKIPPED  没发,而且说得出为什么:已经发过 / 权威账里已有东西
 * FAILED   本该发,计划被拒(容量非法 / 表内容非法)⇒ **一个数都没动**
 * ```
 * `rolledBack: true` = 发过又被「入场失败」撤回(`granted` 原样保留 ——
 * 那条记录说的是「当时打算发什么」,不是「现在账里有什么」)。
 *
 * 放在这里(而不是 `net/actions/**`)的理由:发放**只发生在入场段**
 * (`join` 与重连分支),它不是可被客户端触发的动作 —— 本仓「动作 = 一条 `RoomAction`」
 * 的台账(WS-FND-18 / WS-FND-95)因此不受影响。
 */
export interface StartingInventoryReport {
  readonly userId: string;
  readonly verdict: 'GRANTED' | 'SKIPPED' | 'FAILED';
  /** 真的进了账的那几件(容量不够时末项可能是部分的)。 */
  readonly granted: readonly StartingInventoryEntry[];
  /** 因容量被丢掉的那几件(如实列出:回执与断言都读它)。 */
  readonly truncated: readonly StartingInventoryEntry[];
  /** `granted` 的件数合计(账面上**新增**的件数)。 */
  readonly total: number;
  /** 这次用的容量(`carryCapacityOf` 的返回值,不是本文件猜的数)。 */
  readonly capacity: number;
  readonly reason: string;
  readonly rolledBack: boolean;
}

/**
 * ★ WS-FND-182:一步地形下行的结果。
 *
 * 两个字段各有单一职责(别合并成一个 `Uint8Array`):
 * ```text
 * frames   要发的帧(已经是按 TERRAIN_CHUNKS_PER_FRAME 切好的自包含帧)
 *          空数组 = "没有任何块变了" ⇒ 调用方一个字节都别发(节流的第一层)
 * versions 这一轮结束后的**当前**块版本表(key = "cx,cy")⇒ 调用方据此推进
 *          自己的基线。它**不等于**"刚发了哪些块",而是"发完之后世界上是什么版本"
 *          —— 两者混用会让"新块在编码之后又被改了一次"永久漏发。
 * ```
 */
export interface TerrainDelta {
  frames: Uint8Array[];
  versions: Record<string, number>;
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
  /**
   * 派对模式。★ 2026-11-18(第五轮 P3):**唯一写者是 `state.meta.partyMode`**。
   *
   * ## 修前:两处维护,其中一处只写不读
   *
   * 此前这里是一个并列字段 `partyMode: PartyMode = PartyMode.NONE`,由
   * `setPartyModeBy` 和 `state.meta.partyMode` **各写一次**:
   * ```
   * this.partyMode = mode;                                   ← 内存副本
   * this.state.meta.partyMode = Object.values(PartyMode).indexOf(mode);  ← 线快照
   * ```
   * 实测:`rt.partyMode` 的**生产读者 = 0**(只有测试读它)⇒ 一份没人读的第二份状态,
   * 迟早与快照漂移(而漂移时没有任何断言会红 —— 它本来就没读者)。
   *
   * ## 现在:解码读法(单一存储)
   *
   * 存储只有 `state.meta.partyMode`(枚举**下标**,因为线协议要 U8);
   * 本访问器按 `Object.values(PartyMode)` 还原 —— 与 `setPartyModeBy` 编码用的是
   * **同一张值表**,故 encode/decode 不可能对不上。越界下标(坏快照)⇒ `NONE`,
   * 与 `START_PARTY` 那边「下标不是任何合法模式 ⇒ 拒」同一取向。
   *
   * ⚠️ `get` 而不是方法:既有调用点(`rt.partyMode`)与 `tests/WS-07` 的断言
   * 都按**字段**读它,改成方法会在调用点静默变成「函数对象」。
   */
  get partyMode(): PartyMode {
    const table = Object.values(PartyMode);
    return table[this.state.meta.partyMode] ?? PartyMode.NONE;
  }
  readonly ac: AntiCheatRoom;
  /**
   * ★ WS-FND-172(接线):上一次 `ac.tick` 时读到的**实测墙钟**(`clock.nowMs()`)。
   * `null` = 还没走过一帧(首帧没有差值可算)。
   *
   * 只在 `status === OPEN` 的那一支里推进 ⇒ 休眠期间它**冻结**,
   * 唤醒后首个差值就是整段休眠时长(由 `AC_FRAME_GAP_MAX_MS` 拦下)。
   */
  private lastAcFrameMs: number | null = null;
  /**
   * ★ WS-FND-172(接线):被**丢弃**的帧间隔差值次数(首帧不计)。
   *
   * 丢弃 = 「区间不合法(超 `AC_FRAME_GAP_MAX_MS` / ≤ 0)⇒ 不喂给窗口分母」。
   * 它必须可读:否则「休眠唤醒后分母被稀释」这件事会表现成「什么都没发生」——
   * 而稀释正是接线要防的那件事(见 `AC_FRAME_GAP_MAX_MS` 的注释)。
   */
  acFrameGapDiscarded = 0;
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
  /**
   * ★ 2026-11-26(w85):**出生原点**(格)。由装配层按 `deps.design` 传进来。
   *
   * 缺省 `{0,0}` ⇒ `spawnPoint()` 的结果与改前**逐字相同**
   * (`0.5 + n*1.5`)。设计过的世界里营地在 (96,96),不偏移就会出生在海里。
   */
  spawnOrigin: { x: number; y: number } = { x: 0, y: 0 };
  /** 上一次落盘的实际计数;null = 从未落盘。供测试与诊断断言。 */
  lastSaveReport: {
    tick: number;
    hpSaved: number;
    hpSkipped: number;
    memRow: number;
    /* ★ WS-FND-163(A4):背包账那一段的落地数。老宿主 / 空账 ⇒ 记 0
       (报告里这两个键**恒定出现**,读的人不必先判 undefined)。 */
    ledgerSaved: number;
    ledgerDropped: number;
    /* ★ WS-FND-165(B1):房间系统台账那一段(结算幂等键集 + 房内第几天)。
       `systemsKeys` 是**真正落库**的键数 —— 「这一次到底把幂等账写进去没有」
       由此可断言,不必靠读的人相信它写了(老宿主 ⇒ 记 0,与上面同一处置)。 */
    systemsRow: number;
    systemsKeys: number;
    systemsDropped: number;
  } | null = null;

  /* ══════════ ★ 自动存档的可观测面(owner 裁定:像 Minecraft 一样自动保存)══════════
   *
   * 这几个格**不是第二份真值**:真值仍在库(`users.hp` / `rooms.mob_mem_json`),
   * 它们只回答「上一次存档什么时候发生、成了几次、失败过没有」——
   * 也就是「丢了档的话,能不能当场看出来」。修前这三个问题**没有任何答案**:
   * 落盘只在 `step()` 里被顺手调一下,成没成只体现在 `lastSaveReport`
   * (而它答的是「写了几条」,不是「写没写成」)。
   */

  /** 最近一次**成功**存档的时刻(注入时钟);null = 从未存过。 */
  lastSaveAt: number | null = null;
  /** 成功存档的**累计次数**(幂等重存也算一次 —— 数据不变,见 `saveWorldNow`)。 */
  saveCount = 0;
  /** 存档失败的累计次数(与 `lastSaveError` 成对读)。 */
  saveFailCount = 0;
  /**
   * 最近一次存档失败的错因;null = 无失败。
   *
   * ⚠️ 失败**不抛**也**不清空**旧存档:库还留着上一版,而这件事必须被看见
   * (`console` 之外还有 `saveErrors` 环形日志 + 这个字段)。
   */
  lastSaveError: string | null = null;
  /** 触发最近一次存档的**原因**(周期 / 离场 / 销毁 / 重置)。 */
  lastSaveReason: AutosaveReason | null = null;
  /** 存档失败日志(环形,最多 `SAVE_ERROR_LOG_MAX` 条)。 */
  readonly saveErrors: { at: number; reason: AutosaveReason; message: string }[] = [];
  /**
   * 上一次**跳过**存档的原因(`no-db` / `no-host`);null = 最近一次没有跳过。
   *
   * 与 `lastSaveError` 互斥且分工明确:跳过是「本来就没得存」(纯内存模式 /
   * 本房间没有模拟层),失败是「该存没存成」。把两者混成一个字段会让
   * 「测试里的内存模式」看起来像「生产在丢档」。
   */
  lastSaveSkipReason: 'no-db' | 'no-host' | null = null;
  /**
   * 墙钟轨的水位(= 最近一次存档时刻;构造时 = 建房时刻)。
   *
   * 与 `lastSaveAt` 分开的理由:`lastSaveAt` 是**对外**的读数(可被手动改),
   * 而这条是调度用的内部水位 —— 让它俩共用一个字段等于把调度状态暴露成公开 API。
   */
  private lastAutosaveAtMs: number;

  /* ── ★ WS-FND-163(A1):`room_events` 有界保留的周期轨(可观测面)──────────
   *
   * 与存档那一族同一纪律:真值仍在库里(`room_events` 的行数),
   * 这里只回答「上一次收是什么时候、收掉几条、失败过没有」——
   * 修前这三个问题**没有答案**(trim 只在写入路径上发生,而只读房压根不写)。
   */
  /** 事件保留轨的水位(= 上一次 trim 时刻;构造时 = 建房时刻)。 */
  private lastEventTrimAtMs: number;
  /** 最近一次事件保留的结果;`null` = 从未跑过。 */
  lastEventTrim: { at: number; removed: number } | null = null;
  /** 成功跑过的事件保留次数(与 `lastEventTrim` 成对读)。 */
  eventTrimCount = 0;
  /**
   * 最近一次事件保留的错因;`null` = 没有失败。
   *
   * ⚠️ 与存档失败同一取舍:trim 失败**不抛**(一次 DELETE 失败不该掀掉整帧),
   * 但**不静默** —— 否则「审计流水不再回收」会表现成「没有任何事情发生」。
   */
  lastEventTrimError: string | null = null;

  /**
   * ★ P1(2026-11-21)自动存档双轨倒置修点:上一次**尝试**存档的房间帧号
   * (`-1` = 还没试过)。退避窗口就是按它算的帧差。
   */
  private lastSaveAttemptTick = -1;
  /**
   * ★ P1(2026-11-21)退避窗口(帧):一次失败之后要等这么多帧才允许再试,
   * 每次继续失败翻倍、封顶 `AUTOSAVE_BACKOFF_MAX_FRAMES`,**成功即归零**。
   * 修前没有这一项 ⇒ 失败后每帧都重试(每秒一次,永不退避)。
   */
  private autosaveBackoffFrames = 0;
  /**
   * ★ P1(2026-11-21)**在途**标志:一次存档正在写库时不允许再进一次。
   *
   * 闸在 `autosaveDue()` 与 `saveWorldNow()` 上各判一次:前者避免「同一帧被两个
   * 触发源各推一次」,后者兜住重入(宿主回调里再碰存档)。判据读 `autosaveState()`。
   */
  private autosaveInFlight = false;
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

  /**
   * ★ WS-FND-131(P2 移除侧):最近一次「世界侧移除」是否**真的落地**;
   * `null` = 从未尝试过移除(与 `lastRestoreApplied` 同一处置)。
   *
   * ```
   * true   世界侧确实移除了(或本来就没有世界源 —— 没有残留可留)
   * false  两次尝试都抛 ⇒ 已进 `pendingWorldRemovals`,下一帧重试
   * ```
   * 缺陷形态见 `removeFromWorld()`:修前 `host.removePlayer` 排在最后且无 try,
   * 抛了就整条 `leave()` 被吞、`members` 已删 ⇒ 世界侧**没有任何重试点**,
   * 而外部**看不出**这次移除失败了。
   */
  lastRemoveApplied: boolean | null = null;
  /** 最近一次世界侧/反作弊清理的错因;null = 无错。 */
  lastRemoveError: string | null = null;
  /**
   * 世界侧移除失败、等待下一帧重试的 userId ⇒ **该席位当时的入场世代**(见
   * `retryPendingWorldRemovals` / `memberGens`)。
   *
   * ★ P1(2026-11-21)世代修点:修前是 `Set<string>`(只有 userId)。同一个 id 在
   * 下一帧重试**之前**重进时,重试会把**刚重进的那具刚体**删掉;而 join 不删这条、
   * `auditJoin` 只在入场那一刻跑 ⇒ 「房里有他 / 世界没他」**没有任何告警**。
   * 现在条目带世代:重进时先清本人待删并留证(`removalConflicts`),重试时再核一次。
   */
  private readonly pendingWorldRemovals = new Map<string, { epoch: number; tick: number }>();
  /** 每个席位的**入场世代**(`join` 发号;`clearSeatTraces` 删除)。 */
  private readonly memberGens = new Map<string, number>();
  /** 世代发号器(只增,不复用 —— 复用会让「上一代」与「这一代」重新相等)。 */
  private memberGenSeq = 0;
  /**
   * 世界侧移除的证据台账(**有界**;`lastRemoveApplied` 只是它最后一条的投影)。
   *
   * ★ P2(2026-11-21)并发修点:修前只有单槽 `lastRemoveApplied` / `lastRemoveError`,
   * N 个人并发离开之后只剩最后一份 —— 前面几个人失败得静悄悄。
   */
  readonly removeLog: {
    at: number; tick: number; userId: string; applied: boolean; error: string | null;
  }[] = [];
  /**
   * 「待重试移除」与「重进」撞车的台账(**有界**)。
   *
   * `worldMismatch` = 入场那次三方校验里 `world !== 'ok'`,也就是「房里有他、
   * 世界侧却查不到」—— 修前这种态**连一个字段都没有**(只能靠人读代码推)。
   */
  removalConflicts: {
    at: number; tick: number; userId: string; kind: 'rejoined' | 'epoch-stale';
    epoch: number; worldMismatch: boolean;
  }[] = [];

  /**
   * ★ WS-FND-131(P1):最近一次入场的**三方交叉校验**结果;null = 还没入场过。
   *
   * `world` 是**三态**:`unknown` = 该世界源没有 `playerPosition` 读口
   * (不冒充 ok,见 `auditJoin`)。
   */
  lastJoinAudit: {
    userId: string;
    members: boolean;
    state: boolean;
    world: 'ok' | 'missing' | 'unknown';
  } | null = null;
  /**
   * 入场审计的**有界**台账(`lastJoinAudit` 只是它最后一条)。
   *
   * ★ P2(2026-11-21)并发修点:修前只有单槽 —— N 个人并发入场时,除了最后进来的
   * 那一个,其余人的三方校验结果**一条都不留**。判据:`joinAudits.length` 必须等于
   * 并发入场人数,而不是 1。
   */
  readonly joinAudits: {
    userId: string;
    members: boolean;
    state: boolean;
    world: 'ok' | 'missing' | 'unknown';
  }[] = [];
  /** 每 tick 累计的违规,由外层写 room_events。 */
  private pendingViolations: Violation[] = [];

  /* ══════════ ★ WS-FND-123:boss 投影 / 派对记账打通 / 播报下发 ══════════
   *
   * 这四组状态全部是**可观测量**(计数或最近一次的副本),不是第二份真值:
   * 真值仍在世界(`bossRaid` / `partyContest`)与 `actions/start_party.ts` 的
   * `PartyRecord` 里。这里的每一格都由下面那几个方法从真值搬运而来。
   */

  /** 累计投影过的 boss 实体帧数(证明 `upsertBoss` 每帧真的被调)。 */
  bossProjectionCount = 0;

  /** 世界总线订阅是否已接上(幂等;`close()` 会退订)。 */
  private worldBusAttached = false;

  /** 总线订阅的退订函数(`close()` 调;`EventBus.on` 返回它)。 */
  private worldBusOff: (() => void) | null = null;

  /** 从世界总线收到的播报(**未下发**的积压;`drainPartyBroadcasts()` 取走)。 */
  private partyBroadcastOutbox: { kind: string; text: string; atTick: number }[] = [];

  /** 累计收到的播报条数(含已取走的)。 */
  partyBroadcastTotal = 0;

  /** `START_PARTY` 真的建出记账并开出赛局的次数 / 世界开局后补建记账的次数。 */
  partyRecordStartCount = 0;
  partyRecordAdoptCount = 0;
  /** 建账失败/跳过的次数(模式键是契约外取值等),显式计数而不是静默。 */
  partyRecordSkips = 0;
  /** `endParty` 被真调用(赛局收束)的次数。 */
  partyRecordEndCount = 0;

  /**
   * HUD 倒计时的**锚点**:本局开局那一刻的世界钟秒 + 本局的身份(开局时刻,
   * 只当**身份标签**用,不当时间用)。
   *
   * 为什么需要一个锚点:模式相位只认「世界钟距开局过了多久」,而世界侧的开局
   * 时刻(`startedAtSec`)不出读口 ⇒ 房间在**第一次看见 `RUNNING`** 的帧上记下
   * 那一刻的世界钟。世界开局与房间建账在同一帧(`dispatchAction` 的
   * `startWorldPartyRun` 钩子 / `syncPartyRecord` 的补建路径),故锚点与
   * `startedAtSec` 同帧。
   */
  private partyHudAnchor: { tag: number; sec: number } | null = null;
  /**
   * 没有世界钟读数的帧数(`worldSecondsOf` 返回 `null`)。**可断言**,不静默:
   * 有世界源却没读到世界钟,是接线漏了;没有世界源(手写 host 假件)时它照涨,
   * 但那种房本来就没有赛局在跑。
   */
  partyHudNoClockFrames = 0;

  /** 世界开局 → 记账的锁:同一局只补建一次(键 = 模式键 + 裁判;世界回 IDLE 即释放)。 */
  private partyRecordLatch: string | null = null;

  /** 回执里已经送过的数据指纹(播报条数 / 结算 / 急单评级),避免每帧重复塞。 */
  private receiptSeenBroadcast = 0;
  private receiptSeenSettlement = '';
  private receiptSeenRush = '';
  /**
   * 本房**签名私钥**(32 字节随机)。从不离开服务端进程,也不进任何下行帧。
   *
   * ## 为什么"每房一把"而不是全局一把
   * 换房即换钥 ⇒ 泄漏一把只影响一个房间;而且 A 房的凭证在 B 房**签名就对不上**
   * ⇒ 跨房重放被两层同时挡住(还有 `claims.roomId` 那一层,见 `verifyRoomToken`)。
   * 注:不落库 —— 进程重启后旧凭证失效,重连需要重新签发(如实记为已知边界)。
   */
  private readonly authSecret: string;
  /**
   * **签发方声明的房主凭证**:构造房间时为本房 `ownerId` 签一张。
   *
   * 它就是「房主由谁定」的答案 —— 由**装配层**(库里的 `rooms.owner_id`,
   * 或大厅/首个入房者那次签发)决定,而不是由客户端串决定。
   * 谁能出示这张凭证,谁就是 OWNER;出示不了的人带着 `?userId=u_owner`
   * 也只是一个叫 u_owner 的字符串(旧实现正是在这里形同虚设)。
   */
  readonly ownerToken: string;
  /** 是否强制加入凭证(见 `RoomRuntimeOptions.requireJoinToken`)。 */
  readonly requireJoinToken: boolean;
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
    /* ★ 墙钟轨的水位从这里开始 —— 建房即「刚存过」,否则首帧就会因为
       `now - 0 >= 30s` 而误触发一次存档(开机顺序就会变成「先落盘再热闹」)。 */
    this.lastAutosaveAtMs = this.lastActivityMs;
    /* ★ WS-FND-163(A1):事件保留轨的水位同款 —— 建房即「刚收过」,
       否则首帧就会因为 `now - 0 >= 30s` 而误触发一次 trim(无害但会污染判据读数)。 */
    this.lastEventTrimAtMs = this.lastActivityMs;
    /* ── 身份鉴权(审计 P0-1):私钥 + 强制开关 + 房主凭证 ──
       顺序有要求:`authSecret` 必须先于 `ownerToken`(后者要签名),
       而两者都必须在 `this.id` / `this.clock` 之后(载荷里要 roomId 与过期时刻)。 */
    this.requireJoinToken = opts.requireJoinToken ?? false;
    this.authSecret = randomBytes(32).toString('hex');
    this.ownerToken = this.issueJoinToken(this.ownerId);
    /* 世界源从构造参注入(见 `RoomRuntimeOptions.host` 的长注释):
       缺省仍为 null,但**装配层现在有地方可传** —— 此前只能事后赋值,
       而生产里那个赋值一处都不存在。 */
    this.worldSaveHost = opts.host ?? null;
    this.spawnOrigin = opts.spawnOrigin ?? { x: 0, y: 0 };
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
    /* ★ WS-FND-165(B1) ①:玩家快照轨的水位 —— 建房即「刚存过」(与 `lastAutosaveAtMs`
       同一理由:否则首帧就会因为 `now - 0 >= 10s` 而误触发一次写库)。
       ② **冷启动恢复结算台账**:必须在建房之后、任何人入场之前
       (位置理由见 `restoreRoomSystems` 的 docblock)。 */
    this.lastPlayerSnapshotAtMs = this.lastActivityMs;
    this.restoreRoomSystems();
  }

  /* ══════════════ ★ WS-FND-155:起始背包(只与入场段有关)══════════════
   *
   * ## 发什么
   * `shared/constants/starting_inventory.ts#STARTING_INVENTORY`(冻结表,7 件:
   * 101×2 / 106×2 / 118×2 / 201×1)。**一个 id 都不新造**,本文件不挑物品、
   * 也不复述那张表 —— 表动了这里自动跟着动。
   *
   * ## 什么时候发:**只在玩家首次出现时**,判据四条(全在一处,顺序固定)
   * ```text
   * 0 库里的**发放台账**(`user_starting_inventory`)没有这个 id ⇒ 才继续
   *   ★ WS-FND-156:跨进程的真值。有行 ⇒ SKIPPED(重启 / 换实例 / 换进程都不重发)
   * 1 本房间实例里**没发过**这个 id    ← startingInventoryGranted:Set<string>
   *   (有库模式下的**快路径**;无库模式下的**唯一**账)
   * 2 权威账里**一件都没有**(总量 0) ← 「他不是一个空手的新玩家」的负向佐证
   * 3 装得下 且 内容合法               ← planStartingInventory(见下)
   * ```
   * 四条全过才写账;**任何一条不过都只留回执、一个数都不动**(`verdict: SKIPPED/FAILED`)。
   * 发完之后**再**写库占位(`claimStartingInventoryGrant`,主键 = `user_id`):
   * 并发里后到的那个撞唯一约束 ⇒ **撤回自己刚发的那一份**并如实记 `SKIPPED`
   * —— 「并发两次 join 只发一份」由**库层唯一约束**保证,不靠时间差侥幸。
   *
   * ## 为什么判据是「房间账」而不是「世界账」
   *   · 世界侧的 `WorldSim.addPlayer` 返回值(`CREATED` / `RELOCATED`)**不够用**:
   *     退房会 `removePlayer` 清掉世界侧台账,同名重进又是 `CREATED` ——
   *     它只说「这一轮刚登记」,不说「以前没来过」;
   *   · 而背包账**本来就在房间**(`itemCounts` / `inventoryTotals`;模拟层**不**持有
   *     背包明细,见 `inventoryDetailSource` 的注释:让世界侧编一份出来就是第二份
   *     事实源)。⇒「发什么」与「发过没有」落在同一个对象上,天然同源。
   *   · 结果:宽限期内重连(`resumed`)、退房重进、宽限超期重进、`RESET_WORLD`
   *     之后再来 —— **一次都不会重复发**。重连那一条也调本方法(必然 SKIPPED),
   *     这样**每一次入场都有如实回执**,而不是「没调就等于没发」。
   *
   * ## 与容量闸一致
   * 容量**不在这里算**:问 `carryCapacityOf(userId)`(唯一出处是成长档案
   * `carrySlots` / `statsAtLevel`,WS-FND-152)。计划由
   * `planStartingInventory(容量, 表)` 出:装不下就按表序截断,丢掉的项进回执。
   * 本类**只写**账,不另立第二份「够不够」的判定。
   *
   * ## 写账走哪条路
   * `applyItemCountDelta`(按件账的**唯一**写入口)+ `projectInventoryTotalFor`
   * (总量按明细**重算**,不累加)。这里**不**走 `applyInventory`:那条路判的是
   * **客户端报文**(凭证链 / `allowedSources` 查的是「客户端凭空产出」),服务端
   * 自己发的东西没有「凭证」可言 —— 硬塞一张反而要给用途枚举加一项
   * (`anticheat.ts`,本轮写域外)。
   *
   * ## ★ WS-FND-156:跨进程幂等靠**库里的台账**(本轮主修点)
   *
   * 修前这一整段只有**房间实例**的内存账(`startingInventoryGranted`)⇒
   * 服务重启后同一个 id 会**再发一份**。现在多了一条闸 0:
   * ```
   * user_starting_inventory(user_id PK, version, granted_at)
   *   ⇒ 有行 = 已领(真值);主键 = 库层唯一约束 = 并发占位的抓手
   * ```
   * 顺序是「**先查库 → 未领才发 → 发成功再写库**」:发账抛错时库里还没有行
   * (不留半态);写库撞唯一约束时把**刚发的那一份撤回**(账与库同时回到未发)。
   *
   * ## 无库模式(`--memory` / `db === null`)的语义:退化为进程内账
   * 闸 1 就是无库模式下**唯一**的账,行为与改前逐字相同 ⇒ ⚠️ **此模式下服务
   * 重启后同一个 id 会再发一份**(不是缺陷,是「没有库就没有跨进程真值」的必然
   * 结果;如实写在这里,也写进 `--memory` 的说明)。
   *
   * ## `RESET_WORLD` 的语义:标记**不清**(与 FND155-8 的裁定一致)
   * 台账 / 内存账都是**玩家世代**数据(`user_id` → 已领),而 `RESET_WORLD` 换的是
   * **世界世代**(种子 / 地形 / 生物)⇒ 重置通路上不存在「清发放标记」这件事,
   * 也不该有:清了就是「重置一次,每人再白拿一份」。走廊证据:重置分支只做三件事
   * (睡眠换代登记 / 立刻落盘 / 世界内存重建),台账既不在这三件里,也不是按
   * `room_id` 存的 ⇒ 重置后重进仍然 SKIPPED(FND156-8 钉这一条)。
   *
   * ## 起始包**版本号**变化的语义:选「不补发」(理由见 `repo.ts` §14)
   * 台账里的 `version` 记的是**发放当时**的版本;判据只看「有没有这一行」,
   * 版本升高不给老玩家补发 —— 那属于经济/补偿玩法(与 FND155-8 第 3 条同源),
   * 而版本号留下的是**将来真要做补发时的原料**。
   */
  private readonly startingInventoryGranted = new Set<string>();

  /**
   * ★ WS-FND-156:**本进程写成功的**台账行(`user_id` 集合)。
   *
   * 撤回(`rollbackStartingInventory`)时用它决定「要不要删库里的那一行」:
   * ```text
   * 在集合里   ⇒ 那行是**我们**写成功的 ⇒ 撤回时必须一并删掉(否则这个 id 从此
   *              被记为「已领」而账里一件都没有 ⇒ 同名重试永远拿不到包,且不报错)
   * 不在集合里 ⇒ 那行是**别人**写的(并发里对方赢了唯一约束)⇒ **不许删** ——
   *              两个进程争着删会让「谁都不留」,而且等于把对方真实发出的那份作废
   * ```
   */
  private readonly dbGrantClaimed = new Set<string>();

  /**
   * 最近一次起始背包发放的**回执**(可观测;`null` = 还没有过任何一次入场尝试)。
   *
   * 三态与 `auditJoin` 同族:`GRANTED` 真发了 / `SKIPPED` 没发且**说得出为什么**
   * (已经发过、账里已有东西)/ `FAILED` 本该发而计划被拒(**一个都没写**)。
   * `rolledBack: true` = 发过又被入场失败撤回(见 `rollbackStartingInventory`)。
   */
  lastStartingInventory: StartingInventoryReport | null = null;

  /* ── 4.1 加入 / 重连 ── */

  /**
   * 加入房间。
   *  - **先认证**:凭 `token`(服务端签发,见 `signRoomToken`)确定身份,再谈策略。
   *  - 房间 SLEEPING → 自动唤醒(wake),并把世界帧号接续下去。
   *  - 同名成员处于断线宽限期内 → 走重连路径,返回**逐字节一致**的快照。
   *  - 密码房校验 `passwordHash`;满员拒绝。
   *
   * ## ★★★ 审计 P0-1:为什么认证必须**排在第一条**
   * 旧实现的判据只有 `input.userId === this.ownerId`,而 `input.userId`
   * 在运输层**由客户端串决定**(握手 URL 的 `?userId=`)⇒ 谁都能说自己是房主。
   * 修法不是把那一行改得更聪明,而是**让它左边的输入变成已认证的**:
   * ```
   * 网络边界(ws_server)⇒ 一律 requireToken: true
   * 重连               ⇒ 同一条校验(本方法只有这一个入口,重连走的是同一段)
   * 进程内直连          ⇒ 可信代码,默认不强制(见 RoomRuntimeOptions.requireJoinToken)
   * ```
   * ⚠️ 「缺 token」与「给了坏 token」**分开**:前者是没声明身份(可信路径可省),
   *   后者是伪造 —— 不论 `requireToken` 是什么都直接拒。
   */
  join(input: {
    userId: string;
    passwordHash?: string | null;
    asGuest?: boolean;
    /** 加入凭证(服务端签发)。运输层必填;进程内直连可省。 */
    token?: string;
    /** 强制校验凭证 —— 网络边界一律传 `true`(见 `ws_server.ts` 的 `onHello`)。 */
    requireToken?: boolean;
  }): JoinResult {
    const now = this.clock.nowMs();
    /* ── ① 身份认证(先于一切策略:连房间关没关都不该告诉未认证的人)── */
    if (input.requireToken === true || this.requireJoinToken || input.token !== undefined) {
      const verdict = this.verifyJoinToken(input.userId, input.token);
      if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
    }
    if (this.status === RoomStatus.CLOSED) return { ok: false, code: 'ROOM_CLOSED', reason: '房间已关闭' };

    if (this.accessMode === AccessMode.PASSWORD) {
      if (!input.passwordHash || input.passwordHash !== this.passwordHash) {
        return { ok: false, code: 'PASSWORD_MISMATCH', reason: '房间密码错误' };
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
        /* ⚠️ 这一支**刻意不**并进 `purgeSeat()` —— 它必须自己把世界侧那一步
           写在**分支内**:`tests/WS-07.test.ts` 的 M8 用**代码态窗口**
           (从 `away > RECONNECT_GRACE_MS` 起 800 字符)钉住「超期分支必须调
           `removePlayer`」,而代码态窗口无法表达"间接调用"。
           ⇒ 与本分支逐字相同的四步,在 `leave()` / `reapExpiredDisconnects()`
           那两条路径上收敛到 `purgeSeat()`(见那里的注释:reap 修前漏了这一支)。
           三条路径的**行为一致**由 WS-FND-106 的 FND106-6 逐条钉住
           (它数的是 host 上真实发生的调用,不是源码文本)。
           ★ 旧注释(仍然成立):世界侧必须**一并**移除 —— 漏了它会让
           「宽限期超期重进」的玩家在模拟层里**留下旧刚体**,而随后 `addPlayer`
           又会 spawn 一次(位置 = 出生点)。 */
        this.members.delete(input.userId);
        this.state.players = this.state.players.filter((p) => p.id !== input.userId);
        this.ac.leave(input.userId);
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
        /* ★ 重连**不豁免**认证:上面那段 `verifyJoinToken` 是唯一的入口,
           所以「带 ?userId=u_owner 重连」和「首次加入冒充房主」是同一条路、同一个门。
           ★ P1-3(2026-11-19):**过期不等于被拒** —— 若该成员正处于断线宽限期,
           上面那次验签会把「过期」的起算点换成**断线时刻**(口径见
           `reconnectTokenGraceUntilMs`);否则会话一超过 5 分钟,宽限期内重连
           就**必然**被拒(修前的实测形态)。
           重连成功后再**换发**一张新凭证:房间侧顺手而已 —— 实测两个装配层
           调用点(`ws_server.ts:onHello` / `room.colyseus.ts:onJoin`)都**只读**
           `res.ok` / `res.resumed` / `res.snapshot`,**没有一处**把 `res.token`
           回给客户端 ⇒「手里那张老凭证还能不能用」只能由上面那条口径决定。 */
        const token = this.issueJoinToken(input.userId);
        existing.token = token;
        existing.connected = true;
        existing.disconnectedAtMs = null;
        existing.afkSinceMs = null;
        existing.lastSeenMs = now;
        this.touch(now);
        /* ★ WS-FND-155:**重连也走同一条发放尝试** —— 三条守卫都是幂等的,故这里
           必然 SKIPPED;这么做的价值是「每一次入场都有如实回执」,而不是靠
           「没调就等于没发」去推断重连有没有重复发。 */
        this.grantStartingInventory(input.userId);
        const snapshot = this.snapshotFor(input.userId);
        if (this.db) {
          saveReconnectSnapshot(this.db, this.id, input.userId, snapshot, now);
        }
        return { ok: true, role: existing.role, token, snapshot, resumed: true };
      }
      return { ok: false, code: 'ALREADY_ONLINE', reason: '该用户已在线' };
    }

    /* ★ WS-FND-131(P2):容量按「**活着**的席位」算 = 在线 + 仍在宽限期内的断线占位。
       修前第一句用的是 `members.size`(含**宽限期已过、只是还没被 reap 掉**的席位)
       ⇒ 全员断线的房间(SLEEPING)会对第一个新玩家误报「房间已满」。
       宽限期内的断线席位**继续占位**(他随时可能回来,那条席位必须给他留着);
       超期的不再占位 —— 它随后会被 `reapExpiredDisconnects()` 真正收掉。 */
    const liveSeats = [...this.members.values()].filter((m) => m.connected
      || (m.disconnectedAtMs !== null && now - m.disconnectedAtMs <= RECONNECT_GRACE_MS)).length;
    if (liveSeats >= this.maxPlayers) return { ok: false, code: 'ROOM_FULL', reason: '房间已满' };
    /* 人数上限按「当前在线」算,断线占位不计(与上面那句**不重复**:它管总数,这句管在线)。 */
    const online = [...this.members.values()].filter((m) => m.connected).length;
    if (online >= this.maxPlayers) return { ok: false, code: 'ROOM_FULL', reason: '房间已满' };

    /* ── 角色:房主恒为 OWNER;宽限期超期重进的旧管理员降为 GUEST,必须重新授权 ──
     *
     * ## ★ 审计 P0-1:这一行**不是**鉴别器,它是**授权映射**
     * ```
     * 谁能出现在 `input.userId` 里 ← 由上面的 verifyJoinToken 决定(边界 + 凭证)
     * 出现了之后是 OWNER 还是 MEMBER ← 由这一行按 this.ownerId(服务端声明)决定
     * ```
     * 旧缺陷的成因不是这一行写错,而是**它左边的输入可以随便写**。
     * 现在网络路径上 `input.userId` 必须与凭证的 `claims.userId` 逐字相等
     * ( `verifyRoomToken` 的「与声明的 userId 不符」),⇒ 带 `?userId=u_owner`
     * 而拿不出 u_owner 的凭证 ⇒ 在**上一段就返回**了,走不到这里。
     * ⚠️ 故这条 OWNER 分支的正确性依赖「认证在前」—— 谁把认证挪到下面,谁就把它变回缺陷。 */
    const role: RoomRole = input.userId === this.ownerId
      ? RoomRole.OWNER
      : (input.asGuest || demotedFromExpiry) ? RoomRole.GUEST : RoomRole.MEMBER;

    const token = this.issueJoinToken(input.userId);
    const session: MemberSession = {
      userId: input.userId,
      role,
      token,
      connected: true,
      disconnectedAtMs: null,
      afkSinceMs: null,
      joinedAtMs: now,
      lastSeenMs: now,
    };
    /* ══ ★ WS-FND-131(P1 加入侧非原子)════════════════════════════════════
       ## 修前形态(实测可复现)
       ```
       members.set → state.players.push → host.addPlayer
                   → restoreFromSnapshot(可抛) → encodeFull(可抛)   ← 调用方无 try/catch
       ```
       中途抛会**同时**发生三件事,而它不报给任何人:
         1 `members` 里留下一条 `connected=true` 的**幽灵席位**;
         2 `c.userId` 还没写回去 ⇒ 装配层的 close/leave 都**不知道该清谁**;
         3 `reapExpiredDisconnects` 只收 `connected=false` ⇒ 这条席位**永不过期**
           ⇒ 该 id **永久占 maxPlayers**。

       ## 现在的契约:整段是**一件事**
       任何一步抛 ⇒ `rollbackJoin()` 把房间侧与世界侧**逐项还原**
       (有旧实体行就放回去,没有就删干净),返回 `ok:false` 并带上回滚结果。
       调用方拿到的永远是「完整成功」或「一行痕迹都不留」。

       ## 三方交叉校验(成功路径上再核一次)
       `auditJoin()` 核「成员表 / 权威 state / 世界」三者是否同时认这个人
       (`lastJoinAudit` 留证);`members` 或 `state` 任一不一致就按**失败**回滚。
       `world` 有 `ok`/`missing`/`unknown` 三态 —— 没有 `playerPosition` 读口的
       世界源**不谎报**成 ok(与 `lastSaveReport` 同一纪律)。 */
    const prevPlayerRow = this.state.players.find((p) => p.id === input.userId) ?? null;
    let worldAdded = false;
    try {
      /* ★ P1(2026-11-21)世代修点:席位登记**同时**发一个入场世代 ——
         世界侧移除的待重试条目按它核对「这还是不是同一条命」(见 `purgeSeat` /
         `retryPendingWorldRemovals`)。放着这条,「刚重进的刚体被上一次的
         重试删掉」就只能靠人工读代码发现。 */
      this.memberGenSeq += 1;
      this.memberGens.set(input.userId, this.memberGenSeq);
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
        /* ★ WS-FND-131:只有**真的**登记成功才记 —— 回滚时据此决定要不要
           世界侧移除(否则会把「本来就在世界里的人」误踢掉)。 */
        worldAdded = true;
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
       * 测试可读 ⇒ 让「恢复无效」与「没有存档」可区分(陷阱 89)。 */
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

      /* ★ 第四修点的基准(见 `lastMoveAuthority` 的 docblock):**加入那一刻**的权威刚体。
         玩家进房到第一包之间世界可能自己挪了刚体(落体 / 被怪推 / 碰撞分离),那一段同样
         「客户端不可能知道」⇒ 从入场就起算,不留空档。取值与上面 `ac.join` 的播种**同源**
         (恢复后的实际权威坐标,不是存档 blob 里的坐标)。 */
      this.lastMoveAuthority.set(input.userId, {
        x: restoredPose?.x ?? body?.x ?? 0,
        y: restoredPose?.y ?? body?.y ?? 0,
      });

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
       *   放在 `ac.join` 之后是为了让「反作弊播种」与「读档」贴在一起更好读。 */
      if (restoredPose !== null) this.projectAllPlayers();

      /* ★★ WS-FND-155:起始背包 = 进场段的**最后一件事**。位置是契约,三条都有理由:
         ① 在 `addPlayer` **之后** —— 与读档、反作弊播种同一条「先登记再按 id 操作」的纪律;
         ② 在 `restoreFromProfile` **之后** —— 容量按**恢复后**的档案算(30 级 = 37 格);
            放在读档前会让高等级老玩家的包被 Lv.1 的 8 格截断,而那不是他的容量;
         ③ 在 `encodeFull` **之前** —— 首帧快照与账一致,不出现「先告诉客户端 0 件、
            50ms 后跳成 7 件」那种一帧的错。
         ⚠️ 计划被拒(容量非法 / 表内容非法)**不抛**:入场不该因为一份起始礼物失败,
            但必须留回执(`lastStartingInventory`),不许静默什么都不发。 */
      /* ★ WS-FND-163(A4):**读回落账** —— 背包账的恢复点。
         位置是契约:必须在 `startingInventory` **之前**,否则「手里已有东西」
         这条闸(闸 2)看到的还是空账 ⇒ 老玩家会被再发一次起始包;
         也必须在 `restoreFromProfile` **之后**(容量按恢复后的档案算,与起始包同一理由)。 */
      this.restorePlayerLedger(input.userId);
      /* ★ WS-FND-165(B1):**成长档案**读回(经验 / 天赋 / 等级)。
         位置:紧挨着背包账读回 —— 两者都是「库里的玩家存档 → 权威层」,
         且都必须在 `grantStartingInventory` 之前(那条路的闸 2 看的是「他有没有东西」)。
         ⚠️ 与 `restoreFromProfile` **不重复**:那条走重连快照(level/hp/位置),
         这条走 `users.exp` / `users.talent_json`(修前它们**生产 0 写入**)。
         失败不抛(入场不该因为一份经验起不来),但记 `lastProgressionRestore*`。 */
      this.restorePlayerProgression(input.userId);
      this.grantStartingInventory(input.userId);

      this.touch(now);

      const snapshot = encodeFull(this.state, this.state.meta.tick).bytes;
      if (this.db) {
        upsertRoomPlayer(this.db, this.id, input.userId, role, now, snapshot);
      }

      /* ★ WS-FND-131:三方交叉校验(见上面那段契约说明)。 */
      const audit = this.auditJoin(input.userId);
      this.lastJoinAudit = { userId: input.userId, ...audit };
      /* ★ P2(2026-11-21):审计结果**入台账**(有界),不再只留最后一份 ——
         N 个人并发入场时,单槽 `lastJoinAudit` 只会留下最后一个。 */
      this.joinAudits.push({ userId: input.userId, ...audit });
      if (this.joinAudits.length > JOIN_AUDIT_LOG_MAX) this.joinAudits.shift();
      if (!audit.members || !audit.state) {
        /* 房间侧两方自己都不一致 ⇒ 这次入场**没成** ⇒ 按失败回滚,
           不留「连带状态的幽灵席位」。 */
        throw new Error(
          `入场后三方不一致(members=${audit.members} state=${audit.state} world=${audit.world})`,
        );
      }
      /* ══════════ ★ P1(2026-11-21)「待重试移除」与「本人重进」撞车 ══════════
       *
       * ## 修前形态(实测可复现)
       * ```
       * 帧 N    leave(u) → host.removePlayer 两次都抛 ⇒ pendingWorldRemovals.add('u')
       * 帧 N+1  u 重进(members / state / 刚体都回来了)
       * 帧 N+2  step() 顶部 retryPendingWorldRemovals() ⇒ removePlayer('u')
       *         ⇒ **把刚重进的那具刚体删掉**
       * ```
       * 结果:房间里有他的席位与快照,世界侧查不到他 —— 而这**没有任何告警**
       * (`auditJoin` 只在入场那一刻跑过一次,那时他还好好的)。
       *
       * ## 现在
       * 入场这条路上先把**本人**的待删条目清掉,并把这次撞车写进
       * `removalConflicts`(`worldMismatch` 直接来自刚算出的三方校验)⇒
       * 「房里有他 / 世界没他」从此有一条可断言的记录,而不是靠人读代码推。
       */
      const pendingBefore = this.pendingWorldRemovals.get(input.userId);
      if (pendingBefore !== undefined) {
        this.pendingWorldRemovals.delete(input.userId);
        this.removalConflicts.push({
          at: now,
          tick: this.state.meta.tick,
          userId: input.userId,
          kind: 'rejoined',
          epoch: pendingBefore.epoch,
          worldMismatch: audit.world !== 'ok',
        });
        if (this.removalConflicts.length > REMOVAL_CONFLICT_LOG_MAX) this.removalConflicts.shift();
      }
      return { ok: true, role, token, snapshot, resumed: false };
    } catch (e) {
      /* ★ WS-FND-155:入场中途抛 ⇒ **起始背包也要一起撤回**。否则权威账里会留下一份
         谁都看不见的起始包(这个 id 连席位都没有),而「发过没有」那条幂等账会一直
         记着 发过了 ⇒ 同名重试永远拿不到包。撤回走同一条按件写入口(减 delta),
         顺序在 `rollbackJoin` **之前**:先清账,再收席位与实体。 */
      const packRolledBack = this.rollbackStartingInventory(input.userId);
      const rb = this.rollbackJoin(input.userId, prevPlayerRow, worldAdded);
      const why = (e as Error).message.slice(0, 120);
      return {
        ok: false,
        /* ★ WS-FND-134(P2):入场中途抛错(已回滚)与"策略拒绝"分开档 ——
           前者是**缺陷信号**(该叫醒人),后者是正常业务(该给玩家一句话)。 */
        code: 'JOIN_FAILED',
        reason: `加入失败(已回滚:world=${rb.world}${rb.restoredRow ? ',旧实体行已还原' : ''}`
          + `${packRolledBack ? ',起始背包已撤回' : ''}):${why}`,
      };
    }
  }

  /**
   * ★ WS-FND-131(P1):**三方交叉校验** —— 一次入场之后,「成员表 / 权威 state /
   * 世界」三者必须同时认这个人。
   *
   * ## 为什么是三方,而不是「看 `members` 就够了」
   * 修前的缺陷恰恰是**只看其中一方**就会得出\"入场成功\":`members` 有、`state`
   * 有一行,而世界侧 `addPlayer` 若静默 no-op(宿主没有该方法),玩家在模拟层
   * 不存在 ⇒ 每条移动都 `allowed:false`。反过来,世界有刚体而 `members` 没有
   * 就是那条**永久占位**的幽灵席位。
   *
   * ## `world` 的三态
   * ```
   * ok      宿主有 playerPosition 且查得到 ⇒ 世界真的认这个人
   * missing 宿主有 playerPosition 但查不到 ⇒ 世界侧没登记(缺陷信号)
   * unknown 宿主没有 playerPosition 读口 ⇒ **不知道**,不冒充 ok
   * ```
   * `unknown` 不是失败:那是「结构上读不到」,与 `WS-FND-12` 的 host 三态同族。
   */
  private auditJoin(userId: string): {
    members: boolean;
    state: boolean;
    world: 'ok' | 'missing' | 'unknown';
  } {
    const members = this.members.get(userId)?.connected === true;
    const state = this.state.players.some((p) => p.id === userId);
    const host = this.worldSaveHost;
    let world: 'ok' | 'missing' | 'unknown' = 'unknown';
    if (host !== null && typeof host.playerPosition === 'function') {
      try {
        world = host.playerPosition(userId) !== null ? 'ok' : 'missing';
      } catch {
        world = 'unknown';
      }
    }
    return { members, state, world };
  }

  /**
   * ★ WS-FND-131(P1):入场失败时的**回滚**。返回可读的回滚结果(进 `reason`)。
   *
   * 三件事,一件都不能少:
   * ```
   * 1 房间侧痕迹走 `clearSeatTraces()`(members / state.players / 反作弊)——
   *   它是**唯一**一处做这三步的地方,回滚不另写一份;
   * 2 旧实体行若在入场前就存在,放回去(而不是\"反正删了\");
   * 3 世界侧**只在真的 `addPlayer` 过**时才移除(`worldAdded`)——
   *   否则会把「本来就在世界里的人」误踢掉。
   * ```
   */
  private rollbackJoin(
    userId: string,
    prevPlayerRow: PlayerState | null,
    worldAdded: boolean,
  ): { world: 'skipped' | 'removed' | 'pending'; restoredRow: boolean } {
    this.clearSeatTraces(userId);
    let restoredRow = false;
    if (prevPlayerRow !== null && !this.state.players.some((p) => p.id === userId)) {
      this.state.players.push(prevPlayerRow);
      restoredRow = true;
    }
    if (!worldAdded) return { world: 'skipped', restoredRow };
    const removed = this.removeFromWorld(userId);
    return { world: removed ? 'removed' : 'pending', restoredRow };
  }

  /**
   * ★ WS-FND-155 / WS-FND-156:**发放起始背包**(入场段唯一的写法;判据的完整说明见类里那段注释)。
   *
   * ## 四条守卫,顺序固定(先便宜后昂贵,且**都不写账**)
   * ```text
   * 0 库台账 :这个 id 已在 `user_starting_inventory` 里 ⇒ SKIPPED(★ 跨进程真值)
   * 1 房间账 :这个 id 已经发过                ⇒ SKIPPED(进程内快路径 / 无库模式唯一账)
   * 2 权威账 :手里已有东西(总量>0)           ⇒ SKIPPED —— 他不是「空手的新玩家」
   * 3 计划   :容量(问 carryCapacityOf)+ 内容合法 + 截断 ⇒ 拒了就 FAILED,零副作用
   * ```
   * 四条全过才写:一次 `applyItemCountDelta`(**按件账唯一写入口**)+
   * 一次 `projectInventoryTotalFor`(总量按明细**重算**);然后**再**写库占位
   * (`claimStartingInventoryGrant`,主键 = `user_id`)。⇒ 不新增第二个背包真值。
   *
   * ## ★ 「发成功再写库 + 冲突即撤回」是判据的一部分
   * ```text
   * 写库抛别的错   ⇒ 撤回这次发放(账回到 0 件),回执 FAILED ⇒ 不留半态
   * 写库撞唯一约束 ⇒ 另一个实例 / 进程已经发过 ⇒ 撤回这次发放,回执 SKIPPED
   * ```
   * 撤回复用 `rollbackStartingInventory`(与入场失败那条路**同一份**实现),
   * 且只删**本进程写成功的**那行(`dbGrantClaimed`)—— 见那个字段的注释。
   *
   * ## 为什么这里不经 `applyInventory`
   * 那条路判的是**客户端报文**(凭证链 + `allowedSources` 查「凭空产出」),
   * 服务端自己发的东西不该装成客户端报了一笔 —— 见类里那段注释。
   *
   * ## 失败为什么不抛
   * 入场不该因为一份起始礼物失败。但**不许静默**:拒因逐字进
   * `lastStartingInventory.reason`(`FAILED` / `SKIPPED`),而且一个数都没写。
   */
  grantStartingInventory(userId: string): StartingInventoryReport {
    const now = this.clock.nowMs();
    const capacity = this.carryCapacityOf(userId);
    const record = (r: StartingInventoryReport): StartingInventoryReport => {
      this.lastStartingInventory = r;
      return r;
    };
    const base: Omit<StartingInventoryReport, 'verdict' | 'reason'> = {
      userId, granted: [], truncated: [], total: 0, capacity, rolledBack: false,
    };
    /* 闸 0(★ WS-FND-156):**库里的发放台账** —— 跨进程唯一的真值。
       顺序:先把表确保在(`migrateStartingInventory` 幂等 + 漂移判定),再读这一行。
       漂移 ⇒ FAILED 且零副作用:台账写不进去时继续发,就等于退化成
       「每个进程各发一份」(那正是改前的缺陷形态)。 */
    if (this.db) {
      const migration = migrateStartingInventory(this.db, now);
      if (migration.drift) {
        return record({
          ...base,
          verdict: 'FAILED',
          reason: '起始背包发放台账的结构漂移(登记的 checksum 与 schema_starting_inventory.sql 对不上)'
            + ' ⇒ 不发(fail-closed):台账写不进去就会变成「每次重启重发一份」,比不发更坏',
        });
      }
      const grantedRow: StartingInventoryGrantRecord | undefined =
        readStartingInventoryGrant(this.db, userId);
      if (grantedRow !== undefined) {
        return record({
          ...base,
          verdict: 'SKIPPED',
          reason: `库里记着这个 id 已领过起始背包(version=${grantedRow.version},`
            + `at=${grantedRow.granted_at})⇒ 不重发(★ 跨进程幂等:重启 / 换房间实例 / 换进程都不发)`,
        });
      }
    }

    /* 闸 1:本房间实例里**已经发过**这个 id(重连 / 重进 / 世界换代后回来都撞这一条)。
       有库模式下它是**快路径**(闸 0 才是真值);无库模式下它是**唯一**的账。 */
    if (this.startingInventoryGranted.has(userId)) {
      return record({
        ...base,
        verdict: 'SKIPPED',
        reason: '本房间已经给他发过起始背包 ⇒ 不重复发(重连 / 重进 / 重置世界之后都不发)',
      });
    }

    /* 闸 2:权威账里已经有东西 ⇒ 他不是「空手的新玩家」。
       库基线也算(它由 `authoritativeItemTotal` 与房间账相加)⇒ 将来背包真的落库后,
       这条会挡住「新房间实例 + 老存档」这种**跨进程**的重复发放。 */
    const owned = this.authoritativeItemTotal(userId);
    if (owned > 0) {
      return record({
        ...base,
        verdict: 'SKIPPED',
        reason: `权威账里已经有 ${owned} 件 ⇒ 不是空手新玩家,不发起始背包`,
      });
    }

    /* 闸 3:计划 —— 容量 / 内容合法性 / 按优先级截断,全在冻结层那一个纯函数里
       (本类不复制那张表,也不另写一份「够不够」)。 */
    const plan: StartingInventoryPlan = planStartingInventory(capacity);
    if (!plan.ok || plan.total < 1) {
      return record({
        ...base,
        truncated: plan.truncated,
        verdict: 'FAILED',
        reason: plan.ok
          ? '起始背包表是空的 ⇒ 一个都不发(fail-closed;不谎报「发了」)'
          : plan.reason,
      });
    }

    /* 发放:与 `applyInventory` 放行之后**同一对**写口。
       ★ 先把回执挂上:撤回(`rollbackStartingInventory`)只认 `GRANTED` + 这个 userId,
       而下面写库失败时撤回的正是「这一次」的发放。 */
    const issuing: StartingInventoryReport = {
      ...base,
      verdict: 'GRANTED',
      granted: plan.granted,
      truncated: plan.truncated,
      total: plan.total,
      reason: plan.reason,
    };
    this.lastStartingInventory = issuing;
    this.applyItemCountDelta(
      userId,
      plan.granted.map((g) => ({ itemId: g.itemId, delta: g.count })),
    );
    this.projectInventoryTotalFor(userId);

    /* ★ 发成功**之后**才写库:失败 ⇒ **撤回**(账与库都不留半态)。 */
    if (this.db) {
      let claimed = false;
      try {
        claimed = claimStartingInventoryGrant(this.db, userId, STARTING_INVENTORY_VERSION, now);
      } catch (e) {
        this.rollbackStartingInventory(userId);
        return record({
          ...base,
          verdict: 'FAILED',
          reason: `起始背包台账写库失败(${(e as Error).message.slice(0, 120)})`
            + ' ⇒ 本次发放已整批撤回(账与库都不留半态)',
        });
      }
      if (!claimed) {
        /* 另一个实例 / 进程 / 上一次进程已经写过这一行 ⇒ 我方这次是**多余的那一份**。 */
        this.rollbackStartingInventory(userId);
        return record({
          ...base,
          verdict: 'SKIPPED',
          reason: '另一个房间实例 / 进程已经占位(库层唯一约束挡住第二次写入)'
            + ' ⇒ 撤回本次发放,只保留对方那一份',
        });
      }
      this.dbGrantClaimed.add(userId);
    }

    this.startingInventoryGranted.add(userId);
    return record(issuing);
  }

  /**
   * ★ WS-FND-155 / ★ WS-FND-156:把**这一次**刚发出去的起始背包撤回来
   * (两条通路共用:入场失败 / 台账占位失败)。
   *
   * ## 为什么必须显式撤回
   * 入场失败只回滚**席位痕迹**(`members` / `state.players` / 反作弊 / 世界侧刚体),
   * 而背包账是**另一对表**(`itemCounts` / `inventoryTotals`)—— 它不在
   * `clearSeatTraces()` 的清单里。⇒ 不撤就是三件事同时发生:
   * ```text
   * 1 权威账里留下一份谁都看不见的起始包(这个 id 连席位都没有);
   * 2 幂等账记着「发过了」⇒ 同名重试**永远**拿不到包(而且不报错);
   * 3 ★ WS-FND-156:库里的台账行也记着「已领」⇒ 连**进程重启**也救不回来
   *   (重试只会走闸 0 的 SKIPPED)⇒ 所以库那一行必须在同一次撤回里一并删掉。
   * ```
   *
   * 撤回走**减 delta**,与发放**同一条**按件写入口(`applyItemCountDelta`),
   * 再按明细重算总量:两份账不会一个人一套写法。
   *
   * 幂等 / 定向:`lastStartingInventory` 不是这个人的、或那份回执不是 `GRANTED`、
   * 或已经撤过 ⇒ 什么都不做并返回 `false`(调用方据此决定要不要在 `reason` 里点名)。
   *
   * @returns `true` = 这次**确实**撤了一份回去。
   */
  private rollbackStartingInventory(userId: string): boolean {
    const rep = this.lastStartingInventory;
    if (rep === null || rep.userId !== userId) return false;
    if (rep.verdict !== 'GRANTED' || rep.rolledBack || rep.granted.length === 0) return false;
    for (const g of rep.granted) {
      if (g.count > 0) this.applyItemCountDelta(userId, [{ itemId: g.itemId, delta: -g.count }]);
    }
    this.projectInventoryTotalFor(userId);
    /* ★ WS-FND-156:库里的台账行也要一并解掉 —— 否则这个 id 从此被记为「已领」,
       而账里一件都没有(同名重试、甚至进程重启之后的同名重试都**永远**拿不到包)。
       ⚠️ **只删本进程写成功的那条**(`dbGrantClaimed`):并发里对方赢的那条是对方
       真实发出的那份包的凭据,我方撤回时删掉它 = 把别人的发放作废。 */
    const note = this.releaseDbGrantIfOurs(userId);
    /* ★ 幂等账也要解掉 —— 否则这条 id 从此被记为「发过」,而账里一件都没有。 */
    this.startingInventoryGranted.delete(userId);
    this.lastStartingInventory = {
      ...rep,
      rolledBack: true,
      reason: `${rep.reason} ⇒ 已整批撤回${note}`,
    };
    return true;
  }

  /**
   * ★ WS-FND-156:删掉**本进程写成功的**那条台账行(别的进程写的一律不碰)。
   *
   * 返回一段可拼进 `reason` 的**失败说明**(成功时是空串):删不掉必须**看得见**
   * —— 那会让这个 id 在库里被记为「已领」而账里一件都没有,之后每次重试都 SKIPPED。
   * 与 `saveWorldNow` 同一纪律:清理失败**不抛**(那会掀掉整个入场),但也**不静默**。
   */
  private releaseDbGrantIfOurs(userId: string): string {
    const db = this.db;
    if (db === null || !this.dbGrantClaimed.has(userId)) return '';
    this.dbGrantClaimed.delete(userId);
    try {
      releaseStartingInventoryGrant(db, userId);
      return '';
    } catch (e) {
      return `;⚠️ 库台账清理失败(${(e as Error).message.slice(0, 80)})⇒ 该 id 可能被记为已领`;
    }
  }

  /**
   * ★ WS-FND-131:这个 id 现在是否**真的**在房间里(成员表里有且 connected)。
   *
   * 装配层用它做**第四方**核对:`runtime.join()` 说 ok 而这里说 false
   * 就是「幽灵席位/被回滚」的现场 —— 那时必须出声拒绝连接,而不是让一个
   * 「连着但不在房里」的客户端继续发报文(见 `room.colyseus.ts` 的 onJoin)。
   */
  isSeated(userId: string): boolean {
    return this.members.get(userId)?.connected === true;
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
    /* ★ owner 裁定「销毁即存」(2026-11-20):`room.colyseus.ts` 的 `onDispose`
       与命令式 `CLOSE_ROOM` 都落到本方法 —— 这是「房间实例即将消失」的
       **唯一**存档时机。放在改状态**之前**:存档会写 `last_active_at`,
       它描述的是「最后一帧世界还活着」,不该被「已关闭」抢先盖掉。
       幂等:第 2 次 `close()` 在上一行就早退了,不会重复存。 */
    this.saveWorldNow('dispose');
    this.status = RoomStatus.CLOSED;
    /* ★ WS-FND-123:退订世界总线 —— 房间关闭后世界可能还活着(装配层可能复用
       host),留着订阅会让播报继续堆进一个已关闭房间的 outbox(纯泄漏)。 */
    if (this.worldBusOff !== null) {
      this.worldBusOff();
      this.worldBusOff = null;
    }
    this.worldBusAttached = false;
    /* ★ WS-FND-174:房间实例消失 ⇒ 连同它那条**世界钟读数**一起摘掉。
       不摘就是一处按 roomId 增长的泄漏(`sleep.ts` 的 `WORLD_SEC` 只有
       本方法能回收);摘下之后该房的睡眠查询退回模块时钟 —— 房间都没了,
       也不会再有查询。 */
    forgetSleepWorldClock(this.id);
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.CLOSED, this.clock.nowMs());
    return true;
  }

  /**
   * ★ P1-2(2026-11-19):把一名成员的**四处痕迹**一次性摘干净。
   *
   * ## 缺陷形态(修前)
   * 「成员被移除」在房间里是**三条**路径,要做的动作**完全相同**:
   * ```
   * leave()                     主动退房 / 被踢 / 房主关房      —— 4 步齐全
   * join() 宽限超期重进(同名重进) 同一个人换了身份回来            —— 4 步齐全
   * reapExpiredDisconnects()    宽限期到了、房间自己回收         —— ★ 只有 3 步
   * ```
   * 第三条只删了 `members` / `state.players` / `ac` 三处,**没调
   * `host.removePlayer`** ⇒ 超期者的刚体与 `playerIds` 留在模拟层里;
   * 而它随后重新入场会再 `addPlayer` 一次 ⇒ 世界里同一个 id **两份刚体**
   * (位置被悄悄拉回出生点、上一轮的进度/生命值被继承 —— 与 `removePlayer`
   * 注释里记的是同一族症状)。
   * ⚠️ 三条路径分头写时**漏一步不会有任何报错**:前三步照样成功,
   *   「`state.players` 少了一个」的断言照样绿 ⇒ 这类缺陷只能靠
   *   「收敛成一处」消灭,靠"下次仔细点"消灭不掉。
   *
   * ## 谁在用(2/3 条路径,第 3 条是**刻意的例外**)
   * ```
   * leave()                    → 调本方法
   * reapExpiredDisconnects()   → 调本方法   ← ★ 修前就是这条漏了世界侧
   * join() 的宽限超期分支       → **不调**(自己在分支内写那四步)
   * ```
   * 例外的理由**不是设计取舍,而是一条外部约束**(逐字记在这里,免得下一个人
   * 以为它是漏改):`tests/WS-07.test.ts` 的 M8 用**代码态窗口**钉住
   * 「超期分支必须调 `removePlayer`」—— 它从 `away > RECONNECT_GRACE_MS`
   * 起取 800 字符,要求窗口里出现 `removePlayer`。代码态窗口**无法表达
   * 「间接调用」**,把那一支折进本方法会当场让 M8 变红(实测)。
   * ⇒ 三条路径的**行为一致**由行为级判据兜住:`tests/WS-FND-106-...` 的
   *   FND106-6(数 host 上真实发生的调用)+ FND106-8(数调用点数量)。
   */
  private purgeSeat(userId: string): void {
    /* ★ WS-FND-131(P2):修前世界侧(`host.removePlayer`)排在**最后**且没有
       try — 它一抛就整条 `leave()` 被吞,而 `members` 已删 ⇒ **没有重试点**
       (席位没了、刚体/AOI/vitals 还在,同名重进会在世界里叠出第二份刚体)。
       现在:房间侧痕迹与**可重试**的世界侧移除各走各的,任一侧失败都留证据。
       ★ P1(2026-11-21):世代在**清席位之前**取 —— 条目要记住「这是哪一代的待删」,
       同一个 id 以新一代回来之后,那一条就不许再执行(见 `retryPendingWorldRemovals`)。 */
    const epoch = this.memberGens.get(userId) ?? -1;
    this.clearSeatTraces(userId);
    this.removeFromWorld(userId, epoch);
  }

  /**
   * ★ WS-FND-131:席位在**房间侧**的痕迹(`members` / `state.players` / 反作弊)。
   *
   * 反作弊那一步单独 try:它失败**不该**阻断席位与实体的回收(否则又回到
   * 「一步抛 ⇒ 整条路径没做完」的老形态),但要留下 `lastRemoveError`。
   */
  private clearSeatTraces(userId: string): void {
    this.members.delete(userId);
    /* ★ P1(2026-11-21):入场世代随席位一起清。留着它,下一次重进就会与「上一代的
       待删条目」**同代**,那条待删又会被执行 —— 正是这次要消灭的形态。 */
    this.memberGens.delete(userId);
    /* ★ P2(2026-11-21):按玩家的动作预算桶同属「这个 id 的必清痕迹」,
       否则每个进过房的 id 都在 `actionsThisTickByPlayer` 里留一把钥匙。 */
    this.actionsThisTickByPlayer.delete(userId);
    /* ★ 第十轮 P3:`lastTargetlessAttackTick` 每玩家一条,修前 leave/purgeSeat 只调
       `ac.leave()` ⇒ 这张旁表跨世代残留(同 id 重进时留着上一代的帧号)。
       它与 `ac.leave` 同属「这个 id 的必清痕迹」,故**并排清**,不散到别处。 */
    this.lastTargetlessAttackTick.delete(userId);
    /* ★ 第四修点:房间自己那份「上一包时的权威刚体」同属这个 id 的必清痕迹。 */
    this.lastMoveAuthority.delete(userId);
    /* ★ P2(2026-11-21):两张按玩家的背包表也要收 —— 只收**空账**,见下面的理由。 */
    this.prunePlayerLedger(userId);
    this.state.players = this.state.players.filter((p) => p.id !== userId);
    try {
      this.ac.leave(userId);
    } catch (e) {
      this.lastRemoveError = `反作弊回收失败(${userId}):${(e as Error).message.slice(0, 80)}`;
    }
  }

  /**
   * ★ P2(2026-11-21):把**空账**从按玩家的两张背包表(`itemCounts` /
   * `inventoryTotals`)里摘掉,并计数 `ledgerPrunes`。
   *
   * ## 为什么是「只清空账」,而不是「离场一律清」
   * 这两张表**不是缓存**:`authoritativeItemCount` / `authoritativeItemTotal` 直接
   * 读它们,而重进时 `startingInventoryGranted`(跨进程幂等账)**会**挡住重发
   * ⇒ 离场一律清 = 退房即吞掉玩家的持有,重进拿回一个空包,且**没有任何东西报错**。
   * 既有判据 `tests/WS-FND-155` 的 FND155-4(退房重进仍是 7 件)钉的正是这一条。
   * ⇒ 只摘「一件都没有」的那一条:它不承载任何玩家状态,只是 Map 里的一把钥匙
   *   (长期房间反复进出时会一直攒着 —— 那才是要治的形态)。
   *
   * ⚠️ 非空账**必须**留着(那是玩家的东西);这条边界写在这里,免得下一个人把它
   * 改回「一律清」。
   */
  private prunePlayerLedger(userId: string): void {
    const counts = this.itemCounts.get(userId);
    if (counts !== undefined) {
      for (const n of counts.values()) if (n > 0) return;
    }
    if ((this.inventoryTotals.get(userId) ?? 0) > 0) return;
    if (counts === undefined && !this.inventoryTotals.has(userId)) return;
    this.itemCounts.delete(userId);
    this.inventoryTotals.delete(userId);
    this.ledgerPrunes += 1;
  }

  /**
   * ★ WS-FND-131(P2):世界侧移除的**唯一实现** —— 一次立即重试 + 待重试队列。
   *
   * ## 为什么要有它(修前形态)
   * ```
   * purgeSeat 最后才调 host.removePlayer,抛则:
   *   房间侧前 3 步已经做完(席位已删)⇒ 没有任何一处还会再调它
   *   世界侧刚体 / AOI / vitals / 玩法表**留着** ⇒ 同名重进 = 同一 id 两份刚体
   * ```
   * ⇒ 两件事都要:1**重试**(同一处最多 2 次);2失败**入队**
   *   (`pendingWorldRemovals`),由 `retryPendingWorldRemovals()` 在下一帧再试 ——
   *   这样「世界侧抛错」不再是终态,而是一个**可观测量 + 可重试点**。
   *
   * ## 可观测量
   * `lastRemoveApplied`:`true` = 这次移除世界侧**确实**成功(或本来就没世界源);
   * `false` = 两次都抛 ⇒ 已入队待重试。`lastRemoveError` 记最后一次的错因。
   * ★ P2(2026-11-21):两次结果各留一条到 `removeLog`(有界)—— 单槽在并发离场时
   * 只剩最后一份,前面几个人的失败得静悄悄。
   *
   * @param epoch 这个席位的**入场世代**(`purgeSeat` 取;回滚路径传 -1)。
   *              条目记下它 ⇒ 同一个 id 以新一代回来之后这条待删就作废
   *              (见 P1 世代修点)。
   */
  private removeFromWorld(userId: string, epoch = -1): boolean {
    const host = this.worldSaveHost;
    const now = this.clock.nowMs();
    const tick = this.state.meta.tick;
    if (host === null || typeof host.removePlayer !== 'function') {
      /* 没有世界源 ⇒ 没有「世界侧残留」这件事,如实算成功(与 saveToDb 同一 null 契约)。 */
      this.pendingWorldRemovals.delete(userId);
      this.lastRemoveApplied = true;
      this.lastRemoveError = null;
      this.pushRemoveEvidence({ at: now, tick, userId, applied: true, error: null });
      return true;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        host.removePlayer(userId);
        this.pendingWorldRemovals.delete(userId);
        this.lastRemoveApplied = true;
        this.lastRemoveError = null;
        this.pushRemoveEvidence({ at: now, tick, userId, applied: true, error: null });
        return true;
      } catch (e) {
        this.lastRemoveError =
          `世界侧移除失败(${userId},第 ${attempt + 1} 次):${(e as Error).message.slice(0, 80)}`;
      }
    }
    this.pendingWorldRemovals.set(userId, { epoch, tick });
    this.lastRemoveApplied = false;
    this.pushRemoveEvidence({ at: now, tick, userId, applied: false, error: this.lastRemoveError });
    return false;
  }

  /** 世界侧移除证据入**有界**台账(见 `removeLog`)。 */
  private pushRemoveEvidence(row: {
    at: number; tick: number; userId: string; applied: boolean; error: string | null;
  }): void {
    this.removeLog.push(row);
    if (this.removeLog.length > REMOVAL_LOG_MAX) this.removeLog.shift();
  }

  /**
   * 重试所有「世界侧移除失败」的 id。返回本轮真的移除成功的 id 列表。
   *
   * 调用点:`step()` 的**最顶部**(早于 status 早退)⇒ 休眠房里也会推进;
   * 队列为空时是 O(1) 早退。
   *
   * ★ P1(2026-11-21):每条都要先核**世代**。调用点与重进点在同一个 32Hz 循环里
   * 竞争(消息处理 → 下一帧 step),修前 `Set<string>` 只有 userId ⇒ 无法区分
   * 「这条待删说的是哪一代」,于是重试会把**刚重进的刚体**删掉。
   */
  retryPendingWorldRemovals(): string[] {
    if (this.pendingWorldRemovals.size === 0) return [];
    const done: string[] = [];
    for (const [userId, entry] of [...this.pendingWorldRemovals]) {
      /* 第二道闸(`join()` 里是第一道):这个 id 现在**在房里**,而且它的世代与条目
         记的那一代不同 ⇒ 条目说的是上一代的席位,执行它就是把刚重进的那具刚体删掉。
         ⇒ 丢条目、留证,不调宿主。 */
      const liveEpoch = this.memberGens.get(userId);
      if (liveEpoch !== undefined && liveEpoch !== entry.epoch) {
        this.pendingWorldRemovals.delete(userId);
        this.removalConflicts.push({
          at: this.clock.nowMs(),
          tick: this.state.meta.tick,
          userId,
          kind: 'epoch-stale',
          epoch: entry.epoch,
          worldMismatch: this.auditJoin(userId).world !== 'ok',
        });
        if (this.removalConflicts.length > REMOVAL_CONFLICT_LOG_MAX) this.removalConflicts.shift();
        continue;
      }
      if (this.removeFromWorld(userId, entry.epoch)) done.push(userId);
    }
    return done;
  }

  /** 主动离开(非掉线):立刻回收席位与快照。 */
  leave(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s) return false;
    /* ★ owner 裁定「离场即存」(2026-11-20):先落盘、**再**摘席位。
       反序的话离场者已从 `vitals` 里被摘掉 ⇒ 他这一局的血量/进度永远存不进去
       (库里留着的是上一版的旧值,而没有任何东西会报错)。
       `purgeSeat` 之后的下一次存档(周期 / 销毁)因此**不含这个幽灵实体**。 */
    this.saveWorldNow('leave');
    this.purgeSeat(userId);
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
        /* ★ P1-2:与 `leave()` / `join()` 走**同一个** `purgeSeat()` ——
           修前这里少了世界侧那一步(见 `purgeSeat` 的注释)。 */
        this.purgeSeat(m.userId);
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
    /* ★ 单一存储:只写线快照的枚举下标(值表顺序 = `Object.values(PartyMode)`,
       `get partyMode()` 用同一张表还原)。修前这里还并写 `this.partyMode = mode`,
       于是同一事实有两份状态、其中一份没有生产读者(见 partyMode 的 docblock)。 */
    this.state.meta.partyMode = Object.values(PartyMode).indexOf(mode);
    /* ★ 第六轮:选完模式**立刻**把 HUD 三字段对齐一次(不等下一帧)——
       否则 `SET_PARTY_MODE` 与「下一帧 step」之间,客户端会看到「已选模式但
       计时/比分还是全 0」的一帧。没有赛局记录时 `syncPartyHud` 如实写 0。 */
    this.syncPartyHud();
    this.touch(this.clock.nowMs());
    if (this.db) setPartyMode(this.db, this.id, mode, this.clock.nowMs());
    return { ok: true };
  }

  /**
   * 派对 HUD 的**唯一写口**:`state.meta.partyTimer` / `scoreA` / `scoreB`。
   *
   * ## 为什么需要它(第六轮 P1:「有字段、无写点」)
   * `shared/types/wire.ts` 的 `ROOM_FIELD_TABLE` bit 2..4 声明了这三个字段,
   * 客户端 `client/src/ui/party_hud.ts` 也在读(`partyHudOf`,经
   * `three/ui_binding.ts` 画到 HUD 上)—— 但**生产侧一个写点都没有**:
   * 实测它们只出现在 `schema.ts` / `schema.colyseus.ts` 的默认值里。
   * ⇒ 表现是「派对在跑,客户端恒显示 剩余 0s / 红 0 : 0 蓝」,而这**不报错**。
   *
  * ## 两个数字各自的**已有**权威(不新造第三份状态)
  * ```
  * 计时:**世界钟**(`host.simSeconds`,判定用的同一个数)+ 本房在「第一次看见
  *       RUNNING」那一帧记下的世界钟锚点(`partyHudAnchor`);总时长取
  *       `shared/constants/bosses.ts::PARTY_MODES`(`party/modes.ts` 建运行时
  *        用的也是这张表,故两边同源)
  * 比分:同一份记录的 `scores`(按玩家 id),队伍归属问世界 `partyTeamOf`
  * ```
  * ★ WS-FND-174(**时基**):倒计时必须与**判定**同源 —— 模式相位走世界钟
  * (`party/modes.ts` 的 `modeElapsedSec`)、打盹回血也走世界钟(`social/afk.ts`
  * 的 `tickAfk` 收到的 `nowSec`)。修前这里用 `clock.nowMs()`(墙钟)算 elapsed:
  * 名义 20Hz 下两者恰好对上,而真实帧率低于名义值(实测 ~16Hz)时墙钟快约 20%
  * ⇒ 180 秒的赛在墙上 180 秒就显示「剩余 0」,世界却还剩 37 秒
  * (「HUD 归零」比「结算」早 37 秒,而**不报错**)。现在 HUD 的剩余秒数逐帧
  * 等于判定的剩余秒数(`worldSecondsOf` 读出的是世界钟的慢帧网格值)。
  * ⚠️ 房间仍然**不**自己跑一份对局时钟:锚点只是「第一次看见 RUNNING 那一刻的
  * 世界钟读数」,判断与推进都在世界侧(那是唯一真值)。
  *
  * ## 五个分支都**如实**写值(不是缺失静默)
  * 1 房间没有赛局记录(`START_PARTY` 从没开过)⇒ 三个字段全 0;
  * 2 赛局已 `SETTLED` ⇒ 剩余秒数归 0(比分保留:名次已定格,清掉会让 HUD 闪成 0:0);
  * 3 世界没有 `partyTeamOf`(老宿主)⇒ 分不出红/蓝 ⇒ 比分 0,不按加入顺序编;
  * 4 模式不在 `PARTY_MODES`(契约外取值)⇒ 总时长 0 ⇒ 剩余 0;
  * 5 **没有世界钟读数**(`worldSecondsOf` ⇒ `null`:手写 host 假件 / 老宿主)
  *   ⇒ 剩余停在**本局总时长**并计数(`partyHudNoClockFrames`)—— 不猜,也**不**
  *   退回墙钟(退回墙钟就是本缺陷本身)。
   *
   * ## 幂等与代价
   * 只写**值有变化**的字段(与 `syncLevelProjections` 同一取舍):32Hz 每帧写一遍值
   * 本身不贵,但逐帧把同一个值写回快照会让差量编码器看见「每帧都变」——
   * 那是真的多余。故三个字段各自比较后赋值。
   */
  private syncPartyHud(): void {
    const snap = partyStateOf(this.id);
    let remainSec = 0;
    let scoreA = 0;
    let scoreB = 0;
    if (snap !== null) {
      /* 世界源只取一次:倒计时(世界钟)与比分(队伍归属)读的是同一个宿主。 */
      const host = this.worldSaveHost;
      const cfg = PARTY_MODES.find((m) => m.key === snap.mode);
      const totalSec = cfg === undefined ? 0 : cfg.buildSec + cfg.raceSec;
      if (snap.state === PartyPhase.RUNNING) {
        /* ★ WS-FND-174:剩余 = 总时长 − **世界钟**流逝(判定用的那一个数)。
           `startedAtMs` 只当本局的**身份标签**(换局时重取锚点),不当时间用。 */
        const nowSec = worldSecondsOf(host);
        if (nowSec === null) {
          /* 没有世界钟 ⇒ 不猜、也不退回墙钟:停在总时长 + 计数(分支 5)。 */
          this.partyHudAnchor = null;
          this.partyHudNoClockFrames += 1;
          remainSec = totalSec;
        } else {
          if (this.partyHudAnchor === null || this.partyHudAnchor.tag !== snap.startedAtMs) {
            this.partyHudAnchor = { tag: snap.startedAtMs, sec: nowSec };
          }
          const elapsedSec = Math.max(0, nowSec - this.partyHudAnchor.sec);
          /* `ceil` 而不是 `round`:`round` 会让「还剩 0.05 秒」显示成 0
             ⇒ HUD 比判定**早一帧**归零。再夹到 `[0, totalSec]`:世界钟回退
             (如 `RESET_WORLD` 换代后帧号归零)时剩余不会超过本局总时长。 */
          remainSec = Math.min(totalSec, Math.max(0, Math.ceil(totalSec - elapsedSec)));
        }
      } else {
        /* 本局不在跑(已结算 / 没开局)⇒ 锚点作废,下一局重新取。 */
        this.partyHudAnchor = null;
      }
      /* 队伍的权威在世界侧(435 旗)。没有这个读口 ⇒ 比分 0,不猜。 */
      const teamOf = host === null ? undefined : host.partyTeamOf;
      if (teamOf !== undefined) {
        for (const [userId, score] of snap.scores) {
          const team = teamOf.call(host, userId);
          if (team === 'RED') scoreA += score;
          else if (team === 'BLUE') scoreB += score;
        }
      }
    } else {
      /* 没有赛局记录 ⇒ 锚点作废(否则下一局会拿上一局的锚点算剩余)。 */
      this.partyHudAnchor = null;
    }
    /* `partyTimer` 是 POS(i32×1024)载秒数、`scoreA/B` 是 U16 ⇒ 逐字段夹到值域内:
       负剩余与溢出都会让编码器写出垃圾,而那是静默的(剩余那一路已在上面夹过
       一轮,这里的 `MAX_PARTY_TIMER_SEC` 是字段值域的最后一道)。 */
    const timer = Math.min(MAX_PARTY_TIMER_SEC, Math.max(0, remainSec));
    if (this.state.meta.partyTimer !== timer) this.state.meta.partyTimer = timer;
    const a = Math.min(65535, Math.max(0, Math.round(scoreA)));
    if (this.state.meta.scoreA !== a) this.state.meta.scoreA = a;
    const b = Math.min(65535, Math.max(0, Math.round(scoreB)));
    if (this.state.meta.scoreB !== b) this.state.meta.scoreB = b;
  }

  /* ── 4.4 动作分派(RoomAction 的**执行层**)── */

  /**
   * 把 `authorize()` 的「许可」变成「执行 + 回执」—— **查注册表**,把活交给该动作自己的模块。
   *
   * ## 结构(2026-11-15 拆分:一个动作一支处理器 + 一张表)
   *
   * ```
   * actions/action_table.ts 22 项归属表(`Record<RoomAction, ActionHandler>` ⇒ 编译期完整)
   * actions/admin.ts        SET_MEMBER_ROLE / KICK_MEMBER / SET_ROOM_ACCESS /
   *                         SET_PARTY_MODE / CLOSE_ROOM
   * actions/material.ts     PLACE_BLOCK / BREAK_BLOCK / DROP_ITEM / PICKUP_ITEM
   * actions/<action>.ts     其余 13 个各占一个模块(接线只改那一个文件 ⇒ 可并行)
   * ```
   * ⇒ 本方法只剩三步:**查表** → 没登记就 `NOT_IMPLEMENTED` → 调处理器。
   *   处理器拿到的是 `ActionContext`(见 `actions/types.ts`),**不是** `RoomRuntime`:
   *   它们碰不到私有态,也不会在这里长出第二份权限判定。
   *
   * ⚠️ 拆分是**纯重构**:回执的字面内容(`kind` / `reason` 文本 / `effect` 字段名)
   *   一个字节都没变 —— 那是 `tests/WS-07`(ACT 系列)/ `WS-FND-18` / `WS-FND-20` /
   *   `WS-FND-21` 钉着的东西。
   *
   * ## 此前的问题(实测,2026-11-14)—— 换结构不动这些结论
   *
   * `room.colyseus.ts` 的 `action` 报文 handler 原本只有一句:
   * ```
   * authorize(...) ⇒ !allowed ⇒ client.send('reject', ...)
   * ```
   * ⇒ `allowed === true` 时**零执行、零回执、零日志**(成功分支为空)。
   * 于是 22 个 `RoomAction` 长期处于「授权存在、执行不存在」的状态,
   * 而**失败是静默的** —— 玩家按了没反应,没有任何一处能看出原因。
   *
   * ## 为什么处理器**不**自己判权限(这是刻意的分工)
   *
   * 4 个管理动作的宿主方法(`setMemberRole` / `kick` / `setAccess` / `setPartyModeBy`)
   * **各自第一行就是 `authorize(...)`**。处理器若再判一次,就长出**第二份权限实现**
   * —— 本仓 1 号病根(陷阱 31/41)。⇒ 宿主方法自带闸的,直接调它,再把返回值翻译成回执。
   *
   * ⚠️ 唯一的例外是 `CLOSE_ROOM`:`close()` 是**生命周期方法**,还被 `onDispose` 与
   *   `reapEvictions` 调用 ⇒ 它**不能**自带权限闸,闸必须写在 `actions/admin.ts` 里。
   *   这个不对称是**刻意的**,不是遗漏。
   *
   * ## 未实现的动作**显式**返回 `NOT_IMPLEMENTED`
   *
   * 静默成功正是要消灭的东西。若对未实现的动作返回 `ok: true`,客户端会以为动作生效了,
   * **而门禁一条都红不了**(它只查「成功分支是否为空」)。⇒ 回 `ok: false` +
   * `kind: 'NOT_IMPLEMENTED'` ⇒ 它**可被断言**:「发 `PLACE_BLOCK` ⇒ 必须是 NOT_IMPLEMENTED」。
   * 将来谁把它接上,那条断言会**按设计变红**,提醒同时更新 `verify.ts` 的
   * `VERDICT_HANDLER_KNOWN` 登记。★ 本仓既有手法:把"未做项"钉成一条会红的断言,
   * 而不是留一句注释。
   */
  dispatchAction(actorId: string, action: RoomAction, payload: ActionPayload = {}): ActionOutcome {
    /* ★ WS-FND-135(P2):**单帧动作预算** —— 修前 `MAX_ACTIONS_PER_TICK` 在全仓
       只有一处声明(以及注释里的引用),**没有任何执行点**:一帧内多连接连发
       多少条动作就执行多少条,没有兜底。这里把它变成真正的闸:
       ```
       预算耗尽 ⇒ 拒(ok:false / kind:'THROTTLED')+ 计数 + 留明细
       ```
       · 归零点是**帧边界**(`step()` 里 `meta.tick += 1`)—— 判据取 `meta.tick`,
         不取系统时钟(与 `ac.tick` 的服务端时钟同一纪律:世界推进坐什么钟,
         预算就坐什么钟);
       · 拒绝时**不查表、不执行、不写状态**:被拒的动作零副作用,回执写明是预算
         而不是权限/参数(否则「动作被吞」会被读成「动作非法」);
       · 记录 `actionsThrottled` / `throttledActions` ⇒ 被拒**可观测**,不是静默丢弃。

       ══════════ ★ P1(2026-11-21)三条修点 ══════════
       实测(16 人房):一个客户端灌满整房那 64 格之后,同帧其余人的动作**全灭**,
       而且被拒回执写的是 `INVALID`(读的人只会以为是自己的参数错了)。
       ```text
       1 查表**先于**扣格 —— 报文里不存在的动作名只花一次 Map 查找,不再吃预算;
       2 预算分两层:整房上限 + **每玩家份额**(见 `consumeActionBudget`)⇒
         一个人只能耗掉自己那一份,别人那一份还在;
       3 超预算回 `THROTTLED` 这一**独立档位**,不复用 `INVALID`(见 `ActionOutcome.kind`)。
       ``` */
    const handler = lookupActionHandler(action);
    /* 没登记 ⇒ 报文里是个**不存在的动作名**(`tests/WS-FND-21` FND21-3 发的就是
       `NO_SUCH_ACTION_NAME`)。理由文本与拆分前那个 `default:` 分支**逐字相同**
       (唯一出处:`actions/not-implemented.ts`)。
       ★ 这一步在**扣格之前**:垃圾动作(查不到处理器)不该花掉任何人(包括别人)的预算。 */
    if (handler === undefined) return notImplemented(action);
    const overBudget = this.consumeActionBudget(actorId, action);
    if (overBudget !== null) return { ok: false, kind: 'THROTTLED', reason: overBudget };
    const outcome = handler(this.actionContextFor(actorId, action, payload));
    /* ★ WS-FND-123(P1-2):记账建好之后,把**赛局**也开起来。
       `START_PARTY` 的处理器只写 `PartyRecord`,世界的 contest 必须由这条钩子开
       —— 否则账本在、比分永远是 0(`addScore` 有账可记但没有对局事件)。 */
    if (outcome.ok && action === RoomAction.START_PARTY) this.startWorldPartyRun(actorId);
    /* ★ WS-FND-131(P2):世界**换代** ⇒ 玩家睡眠登记一并换代。
       `actions/sleep.ts` 的 `SLEEPERS[roomId][playerId]` 原无世代维 ⇒ 重置世界后
       `beginSleep` 仍可能把**上一世代**的窗口原样返回(「刚上床就已睡了一半」)。
       换代点是**唯一**的:RESET_WORLD 成功这一刻(与 `startWorldPartyRun` 同一位置)。 */
    if (outcome.ok && action === RoomAction.RESET_WORLD) bumpSleepGeneration(this.id);
    /* ★ owner 裁定「重置即存」(2026-11-20):`RESET_WORLD` 成功 ⇒ **立刻**落一次盘。
       为什么不能等周期:重置之后世界里所有刚体/血量/生物 mem 都换了一代,
       若在下一个周期到点之前进程退出,库里留着的是**旧世代**的状态,而回执
       已经告诉玩家「世界换了」—— 那正是「回执与存档两份真值」的形态。
       ⚠️ 只存**新世界**(旧世界由宿主的 `resetWorld` 走归档,见 D-06);
          本行不碰归档,也不改 DDL。 */
    if (outcome.ok && action === RoomAction.RESET_WORLD) this.saveWorldNow('reset');
    /* ★ WS-FND-123(P1-4/P1-5):回执出口。只在**成功**回执上加新键,
       失败回执的形状一个字节都不动(既有断言不受影响)。 */
    return outcome.ok ? this.withPartyReceipt(outcome) : outcome;
  }

  /* ── ★ WS-FND-135(P2):单帧动作预算的状态与执行点 ── */

  /** 本帧已执行的**动作**条数(与 `actionBudgetTick` 配对,帧一变即归零)。 */
  private actionsThisTick = 0;
  /** 上面那个计数属于哪一帧(`state.meta.tick`);`-1` = 还没执行过任何动作。 */
  private actionBudgetTick = -1;
  /**
   * ★ P1(2026-11-21)**按玩家**的本帧已执行数(帧边界清空)。
   *
   * 为什么必须有它:修前只有整房一个计数 ⇒ 一个客户端灌满 64 格,同帧其余 7 人的
   * 动作全部被拒(「邻居把预算吃光」)。按玩家记之后,份额用完只挡他自己。
   * 离场时随席位清(`clearSeatTraces`),否则每个进过房的 id 都留一条。
   */
  private readonly actionsThisTickByPlayer = new Map<string, number>();
  /** 本帧的**每玩家份额**(帧边界按在线人数重算;读数见 `actionBudgetState`)。 */
  private perPlayerActionLimit = MAX_ACTIONS_PER_TICK;

  /** 累计**执行**的动作条数(诊断与判据;与 `actionsThrottled` 成对读)。 */
  actionsDispatched = 0;
  /**
   * 累计**因单帧预算被拒**的动作条数。
   *
   * 修前这个数不存在(预算根本没实现)⇒「一帧被灌了 500 条动作」与
   * 「一帧只来了 5 条」在外面**完全一样**。判据见 `tests/WS-FND-135`。
   */
  actionsThrottled = 0;
  /**
   * 其中**由每玩家份额**(而不是整房上限)拒掉的条数。
   *
   * 为什么单独计数:「邻居把整房预算吃光」与「这个人自己刷过头」是两件不同的事,
   * 而修前它们连一个数都没有(两档都只剩一个共享计数)。
   */
  actionsThrottledByPlayerShare = 0;
  /**
   * 最近被预算拒掉的动作(环形,最多 32 条;够诊断/断言即可)。
   *
   * `scope` = 拒它的是哪一层预算(`player` = 每玩家份额;`room` = 整房上限)。
   */
  readonly throttledActions: {
    tick: number; actorId: string; action: RoomAction; scope: 'player' | 'room';
  }[] = [];

  /**
   * 本帧预算的读数(判据专用读口)。
   *
   * `used` 是**本帧**已执行数,`limit` 取 `MAX_ACTIONS_PER_TICK` ——
   * 判据不自己算「64 减几」,也不抄常量(抄了就会与门禁漂移)。
   *
   * ★ P1(2026-11-21):加上 `playerLimit`(本帧每人份额)与 `perPlayer`
   * (本帧各人已执行数)—— 「一个人能不能把别人的份吃掉」才有可断言的事实。
   */
  actionBudgetState(): {
    tick: number; used: number; limit: number; throttled: number;
    playerLimit: number; perPlayer: Record<string, number>;
  } {
    const sameFrame = this.actionBudgetTick === this.state.meta.tick;
    const perPlayer: Record<string, number> = {};
    if (sameFrame) {
      for (const [id, n] of this.actionsThisTickByPlayer) perPlayer[id] = n;
    }
    return {
      tick: this.state.meta.tick,
      used: sameFrame ? this.actionsThisTick : 0,
      limit: MAX_ACTIONS_PER_TICK,
      throttled: this.actionsThrottled,
      playerLimit: this.perPlayerActionLimit,
      perPlayer,
    };
  }

  /**
   * 本帧的**每玩家份额** = `floor(MAX_ACTIONS_PER_TICK / 在线人数)`,不低于
   * `MIN_ACTIONS_PER_TICK_PER_PLAYER`。
   *
   * 依据「在线人数」而不是「曾经进过房的人数」:份额约束的是**同一帧里同时在
   * 抢预算的人**;离线席位的份额本来就没人会用,按它摊只会让在线的人更宽松。
   * 单人房(以及测试里的裸 `RoomRuntime`)⇒ 份额 = 整房上限,行为与修前一致。
   */
  private perPlayerAllowance(): number {
    let online = 0;
    for (const m of this.members.values()) if (m.connected) online += 1;
    const share = Math.floor(MAX_ACTIONS_PER_TICK / Math.max(1, online));
    return Math.max(MIN_ACTIONS_PER_TICK_PER_PLAYER, share);
  }

  /**
   * 消耗一格本帧动作预算。返回 `null` = 放行;否则是**拒绝理由**(本条不许执行)。
   *
   * 顺序:先判帧边界归零,再判**每玩家份额**,最后判整房上限 —— 反过来的话
   * 「新一帧的第一条」会先被上一帧的余量拒掉,而那一帧早已过去(判据上是
   * 「隔帧仍被拒」的错形态)。
   *
   * ★ P1(2026-11-21):两层的**先后**也是判据的一部分 —— 先查份额才能说清
   * 「拒的是这个人自己刷过头」还是「这一帧整房真的满了」。
   */
  private consumeActionBudget(actorId: string, action: RoomAction): string | null {
    const tick = this.state.meta.tick;
    if (tick !== this.actionBudgetTick) {
      this.actionBudgetTick = tick;
      this.actionsThisTick = 0;
      this.actionsThisTickByPlayer.clear();
      /* 份额按**本帧**的在线人数重算一次(帧内不变 ⇒ 同一条动作在两帧之间的
         裁决依据是稳定的,不会因为别人刚走就让这一帧中途放宽)。 */
      this.perPlayerActionLimit = this.perPlayerAllowance();
    }
    const mine = this.actionsThisTickByPlayer.get(actorId) ?? 0;
    if (mine >= this.perPlayerActionLimit) {
      this.actionsThrottled += 1;
      this.actionsThrottledByPlayerShare += 1;
      this.throttledActions.push({ tick, actorId, action, scope: 'player' });
      if (this.throttledActions.length > 32) this.throttledActions.shift();
      return `单帧动作预算超限(每玩家 ${this.perPlayerActionLimit}/帧):本条未执行`
        + ' —— 被拒的是**你自己**这一帧的动作,别人的份额不受影响';
    }
    if (this.actionsThisTick >= MAX_ACTIONS_PER_TICK) {
      this.actionsThrottled += 1;
      this.throttledActions.push({ tick, actorId, action, scope: 'room' });
      if (this.throttledActions.length > 32) this.throttledActions.shift();
      return `单帧动作预算超限(${MAX_ACTIONS_PER_TICK}/帧):本条未执行`;
    }
    this.actionsThisTick += 1;
    this.actionsThisTickByPlayer.set(actorId, mine + 1);
    this.actionsDispatched += 1;
    return null;
  }

  /**
   * 为**一次**分派装配 `ActionContext`。
   *
   * ⚠️ 这里只**转交** `RoomRuntime` 已有的能力(绑定后的函数),不复制任何判定:
   *   `classifyFailure` / `materialsOf` / `hostPositionOf` 仍是 `private`,
   *   处理器拿不到 `this`,只能调下面列出的这些。
   *
   * ⚠️ `status` 必须是 **getter**:`CLOSE_ROOM` 的回执要在 `close()` **之后**读状态
   *   (`effect: { status: 'CLOSED' }`)。若在这里取一次快照值,回执会谎报 `OPEN`
   *   —— 那是**行为变化**,不是代码风格。
   */
  private actionContextFor(
    actorId: string,
    action: RoomAction,
    payload: ActionPayload,
  ): ActionContext {
    const rt = this;
    /* ★ `USE_ITEM` 的**按件**读口(见 `ItemReadPort` 的 docblock):
       两个绑定函数独立挂在上下文上,而不是给 `ActionContext` 接口加成员 ——
       `actions/types.ts` 是跨动作契约(另一条线在改),而读口只有这一个动作消费。
       用交叉类型交出:处理器侧 `Partial<ItemReadPort>` 窄化即可。 */
    const ctx: ActionContext & ItemReadPort = {
      actorId,
      action,
      payload,
      state: rt.state,
      host: rt.worldSaveHost,
      get status() { return rt.status; },
      authorize: (userId, a) => rt.authorize(userId, a),
      classifyFailure: (id, a, reason) => rt.classifyFailure(id, a, reason),
      materialsOf: () => rt.materialsOf(),
      hostPositionOf: (userId) => rt.hostPositionOf(userId),
      applyInventory: (userId, input) => rt.applyInventory(userId, input),
      grantItemSource: (userId, source) => rt.grantItemSource(userId, source),
      revokeItemSource: (userId, source) => rt.revokeItemSource(userId, source),
      setMemberRole: (id, targetId, role) => rt.setMemberRole(id, targetId, role),
      kick: (id, targetId) => rt.kick(id, targetId),
      setAccess: (id, mode, passwordHash) => rt.setAccess(id, mode, passwordHash),
      setPartyModeBy: (id, mode) => rt.setPartyModeBy(id, mode),
      close: () => rt.close(),
      itemCountOf: (userId, itemId) => rt.authoritativeItemCount(userId, itemId),
      itemIdsOf: (userId) => rt.authoritativeItemIds(userId),
    };
    return ctx;
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

  /**
   * 世界源的**物质层**;没有世界源时返回 `null`。
   *
   * 为什么单开一个取法:四个物质动作都要它,而「拿不到」必须**显式**变成
   * 一条 `NOT_IMPLEMENTED` 回执 —— 不能写成 `?.` 之后静默跳过
   * (那正是本仓反复记的那类静默失效)。
   */
  private materialsOf(): ReturnType<WorldSaveHost['materials']> | null {
    const h = this.worldSaveHost;
    return h === null ? null : h.materials();
  }

  /**
   * 玩家的**权威位置**(`physics.bodies`);拿不到返回 `null`。
   *
   * `playerPosition` 是 `WorldSaveHost` 的**可选**成员(老世界源没有)⇒
   * 这里显式判 `typeof`,由调用方给出可读的拒绝理由。
   *
   * ⚠️ 丢东西 / 捡东西的落点**只认这里** —— 客户端报的坐标一律不采信
   * (否则玩家能把东西丢到地图另一头,或隔着半个世界捡东西)。
   *
   * ★ 本方法是这个读法的**唯一实现**:`applyMove` 里原来内联了一份同样的
   *   `typeof` 判断,已改为调它(同一读法两处各写一遍就是"两份实现"的起点)。
   */
  private hostPositionOf(userId: string): { x: number; y: number; z?: number } | null {
    const h = this.worldSaveHost;
    if (h === null || typeof h.playerPosition !== 'function') return null;
    return h.playerPosition(userId);
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
    /* ★ WS-FND-135(P1):快照必须在 `ac.move` **之前**取 —— 它放行时会把两样东西
       一起推进:`s.window`(窗口式移速的时间轴)与水位(`lastX/Y/Z` + `lastMoveTick`)。
       而「世界是否**接受**这组坐标」要等下面那一行 `applyPlayerMove` 的返回值。 */

    /* ★ WS-FND-178(**第二修点**;60 分钟长跑实测追加):**入口先重锚**。

       病理(实测 `gapBefore = |投影 − 水位|` 从 0.3 一路涨到 2.66):权威刚体在
       `applyMove` **之外**也会动 —— 物理沉降 / 击退 / `syncPlayers()` 把刚体投影回
       `state.players`。而水位只在「包被接受」或「世界拒收」时重锚(见本方法下面两处
       `syncWatermark`)⇒ 投影与水位越走越开;客户端又按**投影**起算下一包 ⇒
       `dist = 漂移 + 步长 > 单帧上界` ⇒ 判 TELEPORT ⇒ 走下面的早退分支 ⇒
       **再也不重锚** ⇒ 漂移只增不减,**永久风暴**(且 `acViolations` 环很快灌满)。

       修法:把判据的参考点锚到**此刻的权威刚体**,而不是「上一次申报坐标」。
       ⇒ `dist` 变成「客户端申报的位置离它**真实所在**有多远」 —— 这正是瞬移判据
       该有的语义,所以是**加强**不是放松:单帧上界 `0.225` / 窗口均速 / Z 值域
       一字未动,真作弊者申报远处坐标照样按真实位移判。

       取不到权威(无世界 / 旧世界源不给 z)⇒ **跳过**(行为与本修点引入前逐位一致)。

       ⚠️ 顺序:必须在 `snapshotMove` **之前** —— 否则世界拒收路径回滚到的是
       未重锚的旧水位,等于白修。

       ⚠️ **残余**:这一处之后仍会剩零星的 TELEPORT(世界在同一帧里把刚体挪走 +
       客户端那一包正在飞)。归因与两类分法见下面「残余的**归因**」那一段 ——
       **判据与上界一个数都没动**。 */
    const bodyNow = this.hostPositionOf(userId);
    if (bodyNow !== null && typeof bodyNow.z === 'number' && Number.isFinite(bodyNow.z)) {
      /* ★ 「世界自己挪了刚体」的位移由**房间自己的读数**给出,不读 AC 水位 ——
         水位是判据的参考点,回滚/注入会让它与权威不一致,拿它推位移等于「水位被改坏
         就换来宽限」(WS-FND-135 的注入负对照守这条)。见 `ac.noteAuthorityDrift`。 */
      const prevAuth = this.lastMoveAuthority.get(userId);
      this.ac.noteAuthorityDrift(
        userId,
        prevAuth === undefined ? 0 : Math.hypot(bodyNow.x - prevAuth.x, bodyNow.y - prevAuth.y),
      );
      this.ac.syncWatermark(userId, bodyNow.x, bodyNow.y, bodyNow.z);
    }
    const snap = this.ac.snapshotMove(userId);
    /* ★ 客户端发的是**它自己的**帧计数器(`main.ts` 的 `localTick`),必须折算到
       房间时钟,否则 `dtTicks` 恒 0 ⇒ 每包带位移的移动都被判 TELEPORT、玩家动不了
       (判据 `FND178-8`)。折算不改额度语义:`checkMove` 里那对夹取照旧封顶。 */
    const v = this.ac.move(
      { ...intent, tick: this.ac.normalizeClientTick(userId, intent.tick), playerId: userId }, 3,
    );
    if (!v.allowed) {
      if (v.violation) this.pendingViolations.push(v.violation);
      /* ★ 基准点 C(反作弊拒绝):世界**没有被写**,权威没动 ⇒ 客户端能读到的仍是 `bodyNow`。
         不更新它,下一包就会把「本包之后的世界位移」叠在旧基准上 —— 宽限单调变大。 */
      if (bodyNow !== null) this.lastMoveAuthority.set(userId, { x: bodyNow.x, y: bodyNow.y });
      return v;
    }

    /* ⚠️ ★ WS-FND-178 **残余**(如实登记:本轮修点**没有**动这一支,而且这一支
       **不需要**再补重锚 —— 理由在下面;真正的残余在本段末尾)。

       这里提前返回 ⇒ 既不重写 `state.players`、也不碰水位。这**是对的**:
       「反作弊拒绝」意味着**世界没有被写过**,刚体留在原处;而入口重锚(本方法顶部)
       刚刚把水位钉到**本次调用开始时**的权威刚体 ⇒ 水位 / 刚体 / 投影三者此刻一致。
       ⚠️ 修前这一支**不重锚**,「拒包之后永久偏离、之后每个包都违规」的风暴正是它
       (60 分钟 soak:`acDroppedViolations` ≈38/s、`acViolations` 饱和 512);入口修点
       把它关掉之后同一个探针读到 `acDroppedViolations = 0`。

       **为什么不在这一支补一个 `syncWatermark`**:单独重锚会造出一个**更糟**的形态 ——
       水位锚到了新刚体,而 `state.players` 仍是旧投影(这里不投影是**有意**的:反作弊拒绝
       要走 `v.corrected`,让客户端按**判据的权威**回退,而不是按世界投影)。客户端随后按
       快照(旧投影)起算的下一包,位移 = |旧投影 − 新刚体| ⇒ 又变成假阳性,只是换了个来源。
       ⇒ 要真正补上必须**同时**重锚 **且**把权威刚体投进 `state.players`,那会改掉反作弊
       拒绝的既有回执语义(牵动 WS-FND-135 / WS-FND-172 登记的口径),**超出本轮范围**。

       ══════════ 残余的**归因**(本轮实测:2.5 分钟 / 8 客户端 / 5Hz 假客户端)══════════

       入口重锚之后仍剩 **9~22 条 / 2.5 分钟**(≈0.06~0.15/s)`acViolations`,
       `acDroppedViolations = 0`,**全部** TELEPORT,`detail` 一律
       `单帧位移 0.22x 格 > 上界 0.225`。逐包探针(`_gap3.ts`)把两类分开:

       ```text
       projGap = |投影 − 刚体| = 0            ← **应用那一刻**投影与刚体同源(不是投影陈旧)
       readGap = |客户端**读**投影那一刻 − 应用时刻刚体| = 0.014 ~ 0.300 格
                 = 「读 → 服务端应用这一包」之间那**一个服务端帧**里世界的位移
                   (八个假客户端在角落堆叠 ⇒ `resolvePairs` 每帧推一点;
                    被怪击退时一帧就是 0.088~0.300 格)
       dtTicks = 1(每包只兑现 1 帧 ⇒ 额度 = 0.225)
       ⇒ dist = 步长 + 那一帧的漂移;判 TELEPORT 的条件是它 > 0.225
       ```

       · **夹具固有(主因,已按夹具保真度修掉)**:假客户端每包走
         `√2 × 0.15 = 0.2121` = 0.225 的 **94.3%**,余量只剩 0.0129 格 ⇒ 上面那
         **一个帧**的漂移(0.014~0.023)就够把 dist 顶过 0.225(22 条里 16 条属于此类)。
         修法在**夹具**侧(`scripts/soak.ts#WALK_STEP`:改成「一包 = 一个标称帧的
         合法位移」= 0.140625,余量 0.0844 格,与生产客户端同档)—— **判据与上界一个数
         都没动**。实测:`acViolations` **22 → 0**、`acDroppedViolations` 0、
         `dist` 峰值 0.159。
       · **产品固有(模型上仍在,本轮修后 2.5 分钟未观测到)**:世界在**一帧内**把刚体
         挪出 0.0844 格(上面那 6 条真击退:一帧 0.088~0.300 格)时,那一包**仍在飞**的
         诚实客户端会被判 TELEPORT —— 快照只能**事后**告诉它新位置。故**不动任何数值**。
         真要消它只有两条不改上界的路:
         (a) **世界位移后给一包宽限**(刚体在 `applyMove` 之外被挪过 ⇒ 下一包多兑现
             1 帧额度)—— 取舍:那一包的**有效**上界变成 2 帧(0.45),而「被击退」是
             服务器侧可触发的事件 ⇒ 给作弊者留了「想办法挨一下击退再瞬移 0.45」的窄口子;
         (b) **把 AC 拒绝的回执也下发 `corrected`**(现在 `ws_server` 只在
             `worldRejected === true` 时发 `reject` 帧,AC 侧拒绝**什么都不发**,
             客户端只能靠下一帧快照自己对齐)—— 取舍:改运输层回执面,并牵动
             WS-FND-135 / WS-FND-172 已登记的口径。
         两条都**不在本轮范围**(残余 ≈0.06/s、无饱和、无丢证据),如实登记而不动。 */

    /* 1 先写进世界(权威)。没有世界则跳过 —— 不报错,不假装。

       ★ WS-FND-135(P1):返回值**必须收下**(修前是 `host.applyPlayerMove(...)` 一行,
       返回值被丢弃)。世界会在**倒地 / 眩晕 / 被困(227)/ 击退窗口 / 非有限值**时
       拒收坐标,而那正是一组**没有落地**的坐标:
       ```
       刚体位置 : 原地(世界拒绝了)
       反作弊水位: 已到申报坐标(幻影)
       ⇒ 下一包按**幻影**坐标算位移 ⇒ 合法玩家被误判 TELEPORT / SPEED
       ```
       而 `applyMove` 修前照旧返回 `allowed: true` —— **谎报成功**。
       「世界不认识这个玩家」与「世界拒收这次移动」必须分开:`playerPosition`
       有权威刚体才是**拒收**(NOT_A_PLAYER / NO_BODY 只表示**没登记**,
       旧世界源也可能没有这个读口 ⇒ 那时退回旧行为,不制造假拒绝)。 */
    const host = this.worldSaveHost;
    const authBefore = this.hostPositionOf(userId);
    let worldAccepted = true;
    if (host !== null && typeof host.applyPlayerMove === 'function') {
      worldAccepted = host.applyPlayerMove(userId, intent.x, intent.y, intent.z) !== false;
    }
    if (!worldAccepted && authBefore !== null) {
      /* 回滚窗口与水位(不是「保留一部分」):幻影坐标不许成为下一包的基准。
         违规流水与分数**不动** —— 那是判定的事实,不是位置事实。
         ★ WS-FND-178(P1):权威值必须**重读一次**(修前这里用的是 `applyPlayerMove`
         **之前**读到的 `authBefore`)—— 世界在同一次调用里可能已经把刚体改了
         (击退搬家 / 撞墙滑行 / 落地沉降 / 台阶),那样 `state.players` 与 `corrected`
         写出去的都是**陈旧值**,而水位连陈旧值都拿不到(只有 `rollbackMove` 那一份
         「移动之前的申报坐标」)。重读之后两条读数一起锚到调用之后的权威刚体。
         新值取不到(世界这次没给出权威 / 旧世界源)⇒ 退回 `authBefore`,行为逐字不变。 */
      const authAfter = this.hostPositionOf(userId) ?? authBefore;
      const rolled = this.ac.rollbackMove(userId, snap);
      this.worldMoveRejects += 1;
      this.lastMoveWorldReject = rolled;
      const p = this.state.players.find((x) => x.id === userId);
      if (p) {
        p.x = authAfter.x;
        p.y = authAfter.y;
        if (typeof authAfter.z === 'number') p.z = authAfter.z;
      }
      /* 水位重锚到**权威刚体**:`rollbackMove` 只把水位拉回「这次移动之前」,
         而世界这段时间是自己在动的 ⇒ 不回锚就是「权威与水位永久偏离,
         每个移动包都被判瞬移、永不收敛」(WS-FND-178 的根因)。
         z 的取舍与上面两处逐点同源:`authAfter` 没给高度(旧世界源只回 x/y)⇒
         保持**移动之前**的水位(`snap.lastZ`,此刻已被 `rollbackMove` 写回),
         **不**把这次没落地的申报高度写进水位。 */
      this.ac.syncWatermark(
        userId,
        authAfter.x,
        authAfter.y,
        typeof authAfter.z === 'number' ? authAfter.z : (snap?.lastZ ?? intent.z),
      );
      this.touch(this.clock.nowMs());
      /* 如实回执:静默回退到**权威**坐标,并标记这不是反作弊拒绝。 */
      /* ★ 基准点 B(世界拒收):客户端能读到的权威 = **调用之后**的刚体(`authAfter`)。
         用调用前的 `authBefore` 会让下一包少算这一段位移。 */
      this.lastMoveAuthority.set(userId, { x: authAfter.x, y: authAfter.y });
      return {
        allowed: false,
        corrected: {
          x: authAfter.x,
          y: authAfter.y,
          z: typeof authAfter.z === 'number' ? authAfter.z : intent.z,
        },
        worldRejected: true,
      };
    }

    /* ★ 1b WS-FND-122:**起跳**. 报文里的 `jump:true` 此前**没有消费者**
       (`parseMoveIntent` 直接丢字段,`jumpPlayer` 生产 0 调用)。
       判据(地面 / 冷却)在世界侧 `jumpPlayer` 的入口一处判 —— 房间只搬运意图,
       并把**结果**(含拒绝理由)记进 `lastJumpReport`:不记的话「按了空格没反应」
       与「空格没到」在断言里不可区分。
       ⚠️ 放在位置写入**之后**:起跳要在地面(`z === 0`),先写位置再判,
          语义才是「站在这一格起跳」。 */
    if (intent.jump === true) {
      this.lastJumpReport = this.applyJumpIntent(userId);
    }

    /* 2 再把**权威值**投影到 state。
       有世界就从权威读回(含击退/搬运的结果);没有世界就只有声明值可写。
       ★ z 也从权威读回(2026-11-16 接通;**WS-FND-147 起口径更严格**):
       `applyPlayerMove` 只在「刚体静止且服务端没动过 z」时才采纳 `intent.z`,
       空中 / 落地 / 蹦床 / 落穴 / 台阶这些**服务端自己产生的高度变化**一律以刚体为准
       (裁决见 `WorldSim.lastZAuthority`)。⇒ 客户端声明的 z **只是建议值**:
       `room.ts` 只搬运它、**不判**它,也不把它当最终值(与 x/y 同一口径 ——
       判定只在世界侧一处,理由见 `applyPlayerMove` 的「不制造第二份等效实现」)。
       `host.playerPosition` 的 `z` 是**可选**的(老世界源只回 x/y)⇒ 回退到声明值。

       ★ WS-FND-178(P1):权威值**无条件**先读一次(修前只在 `p` 存在时读,且读完
       只用来投影)。读回的值同时是**水位重锚**的输入 —— 世界可能采纳了这组坐标却把
       刚体放到别处(空中 / 落地 / 台阶的 z 由服务端裁决,见 `WorldSim.lastZAuthority`),
       水位若继续停在申报值,判据的参考点就与权威刚体不一致(下一包按权威起算 ⇒ 误判)。
       投影与水位取自**同一次读数**:两处各读一次就等于又造了一份基准。 */
    const auth = this.hostPositionOf(userId);
      /* ★ 基准点 A(正常放行):客户端**能读到的**那一份 = 本包处理**完**之后的权威刚体。
         下一包的 `authorityDrift` 从它起算 ⇒ 玩家自己这一步**不会**被算成「世界自位移」。
         (拿「进入本包**之前**的权威」当基准,会把玩家的每一步都记成世界位移 ⇒
         真作弊包被误归 `stale`,`FND178-5` 当场红 —— 第一版就是这么错的。) */
      this.lastMoveAuthority.set(userId, { x: auth?.x ?? intent.x, y: auth?.y ?? intent.y });
    const p = this.state.players.find((x) => x.id === userId);
    if (p) {
      p.x = auth?.x ?? intent.x;
      p.y = auth?.y ?? intent.y;
      p.z = auth?.z ?? intent.z;
    }
    /* 没有世界 / 旧世界源(拿不到权威)⇒ 三个值退回声明值:那正是 `checkMove`
       放行时已经写进水位的东西 ⇒ 该分支逐位不变(不制造第二种基准)。 */
    this.ac.syncWatermark(
      userId,
      auth?.x ?? intent.x,
      auth?.y ?? intent.y,
      auth?.z ?? intent.z,
    );
    this.touch(this.clock.nowMs());
    return v;
  }

  /**
   * ★ WS-FND-135(P1):`applyMove` 因**世界侧拒收**而**未落地**的次数。
   *
   * 修前这个数是**不可观测的 0**(返回值被丢弃):世界拒绝了、房间照旧报成功、
   * 水位照旧推进 —— 三件事同时静默。有它之后,「世界拒收」在断言里可分辨
   * (判据见 `tests/WS-FND-135`)。
   */
  worldMoveRejects = 0;

  /**
   * 最近一次**世界侧拒收**是否**真的**被回滚掉了窗口(诊断用;`false` 还表示
   * 「反作弊状态里没有这个玩家」或「拿不到快照」—— 两种情形都不该被当成
   * 「回滚过了」)。`null` = 从未发生世界侧拒收。
   */
  lastMoveWorldReject: boolean | null = null;

  /**
   * ★ 每个玩家**上一次移动包到达时**的权威刚体(x/y)。
   *
   * 用途只有一个:`applyMove` 顶部用它算出「**世界自己**自上一包以来把刚体挪了多远」,
   * 喂给 `ac.noteAuthorityDrift` —— 那正是客户端那一包发出时**不可能知道**的位移,
   * `checkMove` §6.1 据此把这一包归入 `stale`(照样拒绝,但不计违规、不加分)。
   *
   * ⚠️ 为什么**不**在 AC 里用水位之差推:`水位`(`lastX/lastY/lastZ`)是**判据的参考点**,
   * 回滚 / 测试注入都会让它与权威不一致 ⇒ 拿它推位移等于「水位被改坏就换来宽限」,
   * 而那正是 `WS-FND-135` 注入负对照守的东西。这里是**房间自己**的权威读数,与水位解耦。
   *
   * 与席位同生命周期:离场走 `clearSeatTraces`(否则每个进过房的 id 都留一条)。
   */
  private lastMoveAuthority = new Map<string, { x: number; y: number }>();

  /**
   * ★ WS-FND-122:把一条**起跳意图**交给世界侧,并把它回的形态**原样**记下。
   *
   * 为什么这一段单独抽出来(而不是三行 inline):
   * 「宿主没实现」这条分支必须有一句**可读的理由**(`NO_WORLD`),
   * 否则 `jumped:false` 会同时表示「跳不了」与「这条链没接」——
   * 正是本仓反复记的静默形态。
   */
  private applyJumpIntent(userId: string): JumpReport {
    const host = this.worldSaveHost;
    if (host === null || typeof host.tryPlayerJump !== 'function') {
      return { playerId: userId, jumped: false, reason: 'NO_WORLD', vz: null };
    }
    const out = host.tryPlayerJump(userId);
    return {
      playerId: userId,
      jumped: out.jumped === true,
      reason: out.reason ?? 'UNKNOWN',
      vz: out.vz ?? null,
    };
  }

  /**
   * 最近一次**起跳意图**的结果;`null` = 还没有带 `jump` 的移动报文。
   *
   * 与 `lastAttackReport` 同一取舍:`null` 让「没接线 / 没按空格」与
   * 「按了但被拒」在断言里可区分。
   */
  lastJumpReport: JumpReport | null = null;

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
   * ★ WS-FND-122:**`useSkill`(按了 Q)是报文里唯一的第二个意图位**。
   *   它只表达「我按了 Q」,技能定义/倍率/段数一律由模拟层从**当前武器**取
   *   (`skillOf` / `planSkillHits`)—— 与上面「不传面板数据」同一条纪律。
   *   没有技能可放 ⇒ 世界侧回 `rejected:'NO_SKILL'`,回执照实带上,**零副作用**。
   *
   * @param mobId 客户端指定的目标;缺省/非法时按「无目标」处理(不结算)。
   * @param useSkill `true` = 本次是 `[Q]` 技;只接受字面 `true`(运输层已收窄)。
   */
  applyAttack(userId: string, claimedBonus = 0, mobId?: string, useSkill = false): Verdict {
    /* ★ WS-FND-135(P3):**只判定、不提交**冷却水位 —— 提交推迟到「真的结算了」
       的那一刻(见本方法尾部)。修前第一行就把 `lastAttackTick` 推到当前 tick,
       于是「没有世界 / 报文没带 mobId / 世界回 `NO_SKILL` / 超射程」这四种
       **零伤害**的攻击白占 8 帧冷却(`baseAttackIntervalS = 0.4s` = 8 帧),
       表现是「按了没反应,还得再等 8 帧」。
       ⚠️ 其中「报文没带 `mobId`」这一类另有一套细分:**首次**不占冷却,**同一帧内第二次**
          交给攻速闸(否则畸形报文能当无限额度的探测口)——推导见本方法中段「细分」注释。 */
    const atkTick = this.state.meta.tick;
    const v = this.ac.attackPreview(userId, atkTick, claimedBonus);
    if (v.violation) this.pendingViolations.push(v.violation);
    if (!v.allowed) {
      this.lastAttackReport = null;
      this.lastAttackSettled = false;
      this.lastAttackRejection = 'RATE';
      return v;
    }

    /* 反作弊放行后才结算。没有世界 / 没有目标 ⇒ 只记「闸后无执行」,不谎报成功。

       ★ 细分(第九轮:畸形请求 vs 世界侧拒绝)—— 两条已钉死的判据在这里相撞:
       ```text
       WS-FND-135 FND135-12  无世界 / 无 mobId / NO_SKILL / 目标不在册 ⇒ **不占冷却**
                             (第一次畸形请求之后 `lastAttackTick` 必须仍是 -9999,
                              同帧第二次也仍放行)
       WS-07 G04 / WR-14 U2-b 「同一 tick 二次攻击应被拒」—— 第一次畸形请求不吃
                              冷却 ⇒ 第二次会被放行(修前吃冷却,故被拒)
       ```
       ⇒ 这两个场景之间**唯一可观测的差别不是「畸形 / 世界侧」**,而是「同一帧内是否
       重复」:`FND135-12(a)` 是「有 mobId、无世界」,`G04` 是「无 mobId、无世界」——
       两次调用落在**同一个分支**上,单看第一次的入参根本区分不出它们谁是谁。
       ⇒ 口径:① **首次**畸形请求不占冷却(它是零效果的尝试,FND135-12 的裁决);
              ② **同一帧内第二次**同类畸形请求不再是尝试,是重试/探测 ⇒ 交给攻速闸。
       ②不另造判决:提交该帧水位后让 `attackPreview` 复判 —— ATTACK_RATE 的判决与
       违规只由 `previewAttack` 一处产出(不给同一件事造第二个出处)。
       ⚠️ 「重复」只在**同一帧**内成立:①不推进水位 ⇒ 下一帧的畸形请求仍按①处理
          (与 FND135-12 的「畸形请求不占冷却」逐字一致)。 */
    const host = this.worldSaveHost;
    if (typeof mobId !== 'string' || mobId === '') {
      /* ② 同一帧内的第二次:提交水位 ⇒ 复判必然 ATTACK_RATE(闸自己给判决与违规)。 */
      if (this.lastTargetlessAttackTick.get(userId) === atkTick) {
        this.ac.commitAttackOf(userId, atkTick);
        const again = this.ac.attackPreview(userId, atkTick, claimedBonus);
        /* ★ 第十轮 P2:同帧第二次畸形攻击的违规**也要**进流水 —— 修前这里与
           `:3142` 不同:复判确实产出了 ATTACK_RATE,却没人把它推给 `room_events`
           (drainViolations 只认 pendingViolations)⇒ 攻击刷屏在存档里**零痕迹**。 */
        if (again.violation) this.pendingViolations.push(again.violation);
        this.lastAttackReport = null;
        this.lastAttackSettled = false;
        this.lastAttackRejection = 'RATE';
        return again;
      }
      /* ① 首次:只记账、零结算、**不碰冷却水位**。 */
      this.lastTargetlessAttackTick.set(userId, atkTick);
      this.lastAttackReport = null;
      this.lastAttackSettled = false;
      this.lastAttackRejection = host === null ? 'NO_WORLD' : 'NO_TARGET';
      return v;
    }
    /* 「有目标但没有世界」与「目标不在册」同属世界侧/装配侧事实 ⇒ 同样不占冷却。 */
    if (host === null) {
      this.lastAttackReport = null;
      this.lastAttackSettled = false;
      this.lastAttackRejection = 'NO_WORLD';
      return v;
    }

    /* ★ 第三个实参只在**按了 Q** 时给:老世界源不认它时,「普攻」这条路上的
       结构化调用保持不变(少一个可选实参 ⇒ 不会因为多一层而改变行为)。 */
    const authorized = useSkill
      ? host.attackMobAuthorized(userId, mobId, { useSkill: true })
      : host.attackMobAuthorized(userId, mobId);
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
      useSkill,
      rejected: authorized.rejected ?? null,
    };

    /* ★ WS-FND-135(P3):**成功才提交**冷却水位。
       「成功」的判据是**世界侧真的结算了一段伤害**:
       ```
       authorized.rejected === null   世界没拒(不是 NO_SKILL / DOWNED / OUT_OF_AOI …)
       hit !== null                   拿到了结算对象(生物不在册 ⇒ hit === null)
       !hit.result.outOfReach         不是超射程(公式第 0a 步会把它标出来)
       ```
       三者缺一都不提交 ⇒ 那次攻击不占冷却。**提交用 `preview` 时那一帧的 tick**
       (`atkTick`,不是重新取的 `meta.tick`):否则同帧内 `step()` 推进帧号后
       「提交一个更小的 tick」会被单调水位吞掉,冷却悄悄消失。 */
    const settled = authorized.rejected === null && hit !== null && hit.result.outOfReach !== true;
    this.lastAttackSettled = settled;
    /* `rejected` 为 null 却仍没结算(**生物不在册** ⇒ `hit === null`,
       见 `attackMobAuthorized` 的 `rt === null` 分支)与「超射程」是两件事 ⇒
       理由分开写,不合并成一个 `OUT_OF_REACH`(那是「判据退化成读文本」的近亲)。 */
    this.lastAttackRejection = settled
      ? null
      : (authorized.rejected ?? (hit === null ? 'NO_TARGET_MOB' : 'OUT_OF_REACH'));
    if (settled) this.ac.commitAttackOf(userId, atkTick);
    return v;
  }

  /**
   * ★ WS-FND-135(P3):上一次攻击**是否真的结算了**(冷却水位有没有被提交)。
   *
   * 为什么必须单独可读:`lastAttackReport` 只在**走到世界**时才有值,
   * 而「压着冷却却没打出去」这一族(`NO_WORLD` / `NO_TARGET` / `NO_SKILL` /
   * `OUT_OF_REACH`)在修前**完全不可观测** —— 客户端只觉得卡,判据侧看不出原因。
   * `null` = 还没有过攻击报文。
   */
  lastAttackSettled: boolean | null = null;
  /**
   * ★ 同一帧内的**重复畸形请求**判定位(`applyAttack` 用):`userId` → 该玩家上一次
   * 「报文没带 `mobId`」的那一帧。
   *
   * 存在的唯一理由见 `applyAttack` 里那段裁决:畸形请求**本身不占冷却**
   * (WS-FND-135-12 钉死),只有「同一帧内第二次」才按攻速闸处理(WS-07 G04);
   * 而两次调用之间**唯一可观测的差别**就是「这一帧有没有用过」,故必须留下这个帧号。
   * 读写都只在 `applyAttack` 一处,且每帧**覆盖写同一个 key** ⇒ 不随帧数增长
   * (条目数 = 攻击过的玩家数)。
   */
  private readonly lastTargetlessAttackTick = new Map<string, number>();

  /**
   * 上一次攻击**没有结算**的原因(`null` = 结算了,或还没有过攻击报文)。
   * 取值:`'RATE' | 'NO_WORLD' | 'NO_TARGET' | 'OUT_OF_REACH' | <世界侧 rejected>`。
   */
  lastAttackRejection: string | null = null;

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
   * 其余四个由本方法从服务端状态算:
   *
   * - `allowedSources`:本 tick 服务端认可的合法产出集合 —— 由 `grantedSources`
   *   显式授予(掉落/合成在授予时登记),**客户端无法自行扩集**;
   * - `beforeTotal`:★ **已落盘基线 + 本房间账**。`db` 侧的 `ai_item_instances`
   *   全仓**没有生产写入口**(`addItemInstance` 只有测试调用),故它单独用只能是
   *   一个恒 0 的基准 —— 那会让容量闸在 db 模式下**恒失效**(连发 N 次每批都判
   *   `0 + net`,累不到上限;而单批 ≥ 容量 反被误判 `OVERFLOW`)。
   *   ⇒ 基准由**同一批 ops 的产物**给出:`inventoryTotals`(本房间账,见
   *   `applyItemTotalDelta` / `projectInventoryTotalFor`),库值只当**已落盘**那部分。
   * - `beforeByItem`:★ **按件**权威账(`itemCounts`,与 `authoritativeItemCount`
   *   同一份)。只有它才判得住「扣一件自己没有的东西」—— 总量判据守恒的是**别人**的
   *   件数(见 `InventoryCheckInput.beforeByItem`)。
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
      /* ★ 按件判据(唯一汇点):`itemCounts` 是同一批 ops 的产物,和
         `authoritativeItemTotal`/`authoritativeItemCount` 同源。
         ⚠️ 这一行是**判据本身**,不是可选项:去掉它,负 delta 就只剩总量判据,
         `{"itemId":733,"delta":-5}`(实际只有 2 件)会被放行并被静默夹零
         (由 `tests/WS-FND-129` 的 A/B 钉住)。 */
      beforeByItem: new Map(this.itemCounts.get(userId) ?? []),
      capacity: this.carryCapacityOf(userId),
    });
    if (r.violation) this.pendingViolations.push(r.violation);
    /* 通过的合法操作要落到总量记账上,否则下一次 beforeTotal 仍是旧值 ——
       那会让「总量守恒」这层在连续操作间隔里失真。 */
    if (r.allowed) {
      this.applyItemTotalDelta(userId, input.ops);
      /* ★ 按件权威账的**唯一**写入口(与总量记账同一时机、同一前提:只有放行的 ops 才算)。
         放在这里而不是 `use_item` 里:那里只该**读**,写会让「谁改的账」出现第二个来源。 */
      this.applyItemCountDelta(userId, input.ops);
    }
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
   * **撤销**一张已登记的产出凭证(审计 P3:先登记后正向失败必须回撤)。
   *
   * 修前这里只有「授予」(单调增)与「tick 末清空」两档,于是**发放被拒**的令牌
   * 会留在集合里到 tick 末 —— 同一 tick 内任何另一条分支拿同一张串去铸 +delta,
   * `checkInventory` 都会按「服务端登记过」放行。那条口径正是凭证链要堵的洞。
   *
   * 幂等:串不在集合里 ⇒ 什么都不做(重复撤销安全,`expireItemSources` 之后也安全)。
   * 唯一的生产调用点是 `actions/item_source.ts` 的 `unbindItemSource`(它拿的是
   * `bindItemSource` 铸出来的那张),不开放给动作层裸调。
   */
  revokeItemSource(userId: string, source: string): void {
    this.grantedSources.get(userId)?.delete(source);
  }

  /**
   * 权威库存总量 = **已落盘基线 + 本房间账**。
   *
   * ## ★ 为什么不是「有 db 就读 db」(db 模式容量闸失效的修点)
   *
   * 修前这里是 `if (this.db) return totalItemsOf(this.db, userId)`。
   * 而 `totalItemsOf` 读的是 `ai_item_instances`,这张表**全仓没有生产写入口**
   * (`addItemInstance` 只有测试调用;生产只在内存里记 `inventoryTotals` /
   * `itemCounts`)⇒ db 模式下基准**恒为 0**:
   * ```
   * 连发 20 条 +1  每批都判 (0 + 1) ≤ capacity ⇒ **全部放行**,累不到上限
   * 单批 +9(capacity 8)⇒ 0 + 9 > 8 ⇒ **误判 OVERFLOW**(明明背包里没几件)
   * ```
   * ⇒ 判据用的基准与写账路径更新的是**两份不同的账**,这就是那条「容量闸失效」。
   *
   * ## 修法:基准取**同一权威源**(与写入路径同源),库值只当已落盘那部分
   *
   * `db` 侧是**已落盘**基线(载荷 = 本房间之前存下来的量),`inventoryTotals`
   * 是本房间**未落盘**的增量账 —— 两者相加才是「现在真实的持有量」。
   * `db === null`(纯内存/测试模式)时没有任何已落盘部分,退化为纯房间账。
   *
   * ⚠️ 如实记录边界:今天生产**没有**把 ops 写进 `ai_item_instances` 的路径,
   * 故 db 那一项在生产上恒为 0(两账相加 = 房间账);若将来补上写库,
   * 本式的语义正好变成「持久 + 增量」,不需要改判据 —— 但**必须**同时保证
   * 写库与写房间账是同一批 ops(否则这里会变成双重计数)。这条由
   * `tests/WS-FND-129` 的「基准与写入同源」判据钉住。
   *
   * 记账仍由服务端维护,**绝不取自客户端**。
   */
  authoritativeItemTotal(userId: string): number {
    const local = this.inventoryTotals.get(userId) ?? 0;
    if (this.db) {
      try {
        return totalItemsOf(this.db, userId) + local;
      } catch {
        /* 库不可用(如未建表)时退回本地记账。刻意不抛:网络层不该因
           持久层故障而拒掉全部合法操作;但记账仍走服务端口径。 */
      }
    }
    return local;
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
   * 权威背包容量 —— 不是客户端自报值(WS-FND-152 起也不再是**第二份**口径)。
   *
   * ## 两个来源,按优先级
   *
   * ```text
   * 1 世界源的 `carrySlotsOf(userId)`  ← 成长档案的 carrySlots(每级由 recompute 重算,
   *                                      带天赋摊平)⇒ 改档案真的会改容量
   * 2 回落到 `carryCapacityOfLevel(level)` ← 与冻结层 statsAtLevel 同源
   * ```
   *
   * 修前这里是内联的 `8 + (lv - 1)`:与 `progression.statsAtLevel` 是同一条规则的
   * **两份实现**。两份数今天恰好相等 ⇒ **没有任何判据能看出它们已经分开**;
   * 而改冻结层 / 改档案都不会让房间容量动一位。判据:`tests/WS-FND-152`。
   */
  carryCapacityOf(userId: string): number {
    const fromWorld = this.worldSaveHost?.carrySlotsOf?.(userId) ?? null;
    if (fromWorld !== null && Number.isFinite(fromWorld) && fromWorld > 0) {
      return Math.trunc(fromWorld);
    }
    const lv = this.state.players.find((p) => p.id === userId)?.level ?? 1;
    return carryCapacityOfLevel(lv);
  }

  /** 本地总量记账(仅 `db === null` 时参与计算;有库时以库为准)。 */
  private readonly inventoryTotals = new Map<string, number>();
  /**
   * ★ P2(2026-11-21):`prunePlayerLedger` 真的摘掉了多少条按玩家账(可观测)。
   *
   * 为什么要有这个数:修前这两张表**只增不删**(没有清理点)⇒「长跑房间里到底
   * 攒了多少把没人用的钥匙」连一个数都没有。摘一条 +1,让清理本身可断言。
   */
  ledgerPrunes = 0;
  /** 每 tick 的合法产出凭证:userId → source 集合。 */
  private readonly grantedSources = new Map<string, Set<string>>();

  /* ══════════════ 按件权威账(`USE_ITEM` 的 itemId 读口)══════════════
   *
   * ## 为什么必须在这里、而且是一张**新的**表
   *
   * 修前 `USE_ITEM` 的 `itemId` 是**客户端自报**的(见 `actions/use_item.ts` 的
   * 历史注释):服务端只有「总量」(`authoritativeItemTotal`)和「有没有这件」分开算不了。
   * 后果是白嫖:背包里一件 733 都没有,也能无限发 `{itemId:733}` —— 因为扣减只看
   * 「总量够不够」,随便什么别的道具都能被当成 733 扣掉。
   *
   * ## 数据源为什么**不是** `ai_item_instances`(库里的明细)
   *
   * 那张表存的是「AI 生成实例」(`slot` / `recipe_hash` / `stats_json`),
   * **没有内容层 `itemId` 这一列** —— 拿它反查 `itemId` 是查不到东西的。
   * 而 `applyInventory` 的 `ops` 恰恰带着 `itemId`,且它是**唯一的库存变更路径**
   * (总量记账也在这里维护,`inventoryTotals` 是同一形态的先例)。
   * ⇒ 按件账跟着 `ops` 走:唯一写入口 = `applyItemCountDelta`。
   */
  private readonly itemCounts = new Map<string, Map<number, number>>();

  /**
   * **某玩家真的有多少件 `itemId`**(服务端权威读口)。
   *
   * 返回值语义:
   * ```
   * > 0   真的拥有这么多件
   * 0     账面没有 —— 调用方必须**拒绝**且零副作用
   * ```
   * ⚠️ 不接受负数 / 非有限 `itemId`:那不是「查不到」,是**坏参数** ⇒ 同样返回 0
   * (fail-closed:坏参数的唯一安全结论是「没有」)。
   */
  authoritativeItemCount(userId: string, itemId: number): number {
    if (!Number.isFinite(itemId)) return 0;
    const n = this.itemCounts.get(userId)?.get(Math.trunc(itemId)) ?? 0;
    return n > 0 ? n : 0;
  }

  /**
   * 该玩家**按 itemId 升序**的持有清单(> 0 件才出现)。
   *
   * `USE_ITEM` 的 `slot` 报文体用它把「第几个格子」翻译成真实的 `itemId`
   * (服务端说了算;客户端无法用一个 slot 号指认一件它没有的东西)。
   * 排序是**定序**的关键:同一份账面必须每次都给出同样的 slot 序列,
   * 否则「刷两次 slot 拿到两件不同的东西」会变成一个可复现的白嫖入口。
   */
  authoritativeItemIds(userId: string): number[] {
    const m = this.itemCounts.get(userId);
    if (m === undefined) return [];
    return [...m.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort((a, b) => a - b);
  }

  /** 把一次**已放行**的 ops 记到按件账上(唯一写入口)。 */
  private applyItemCountDelta(userId: string, ops: readonly InventoryOp[]): void {
    let m = this.itemCounts.get(userId);
    for (const op of ops) {
      if (!Number.isFinite(op.itemId) || !Number.isInteger(op.delta)) continue;
      const id = Math.trunc(op.itemId);
      if (m === undefined) {
        m = new Map<number, number>();
        this.itemCounts.set(userId, m);
      }
      const next = (m.get(id) ?? 0) + op.delta;
      /* 不允许负件数 —— 与总量记账的 `next < 0 ? 0` 同一取舍(账面异常夹到 0)。
         ★ 经入口(`applyInventory` → `checkInventory` 的按件判据)时**这里已不可达**:
         不足件的负 delta 在 `checkInventory` 就被 `ITEM_NEGATIVE` 拒掉,本函数只处理
         **已放行**的 ops。留着它是给「账面本来就不一致」的兜底,不是判据 ——
         判据在入口,**不要**把这里当「扣超了也无所谓」的依据(那就是修前的静默夹零)。 */
      m.set(id, next > 0 ? next : 0);
    }
  }

  /* ══════════ ★ WS-FND-163(A4):背包账的**落库导出**与**读回落账** ══════════
   *
   * ## 修前形态(本轮最优先的那条)
   * 自动存档(`saveWorldNow`)只保证「起始包**不重发**」——
   * 那是 `user_starting_inventory` 台账,它回答「发过没有」,**不是**「手里有什么」。
   * 而这两张表(`itemCounts` / `inventoryTotals`)只活在房间里:
   * ```text
   * users.inventory_json   从 createUser 起就是 '{}',之后再没有生产写点
   * ai_item_instances      addItemInstance 只有测试调用
   * ```
   * ⇒ 「自动存档」在背包这一维上是**空的**:进程一停,背包回到空,
   *   而库里那一行还在(只是从未变过)⇒ 没有任何东西会红。
   *
   * ## 两份账都要落,而且**分开**落
   * 按件账是明细,总量账是容量闸的基准之一(见 `authoritativeItemTotal`)。
   * 只落明细 ⇒ 读回时总量得重算(而「重算」正是本仓点名的那条静默改数);
   * 只落总量 ⇒ 明细没了,`USE_ITEM` 的按件判据(白名单)直接失效。
   * ⇒ 两份都写进同一行(repo §15 的 `$total` + 数字键),读口如实报 `drift`。
   */

  /**
   * 把本房间的玩家背包账导出成落库形状(存档主机与存档报告共用)。
   *
   * 空账**不导出**:一个从未拿到东西的玩家不该在库里占一行,
   * 也不该把别人(或上一局)的账覆盖成空。
   */
  exportPlayerLedgers(): Map<string, PlayerLedgerSnapshot> {
    const out = new Map<string, PlayerLedgerSnapshot>();
    const ids = new Set<string>([...this.itemCounts.keys(), ...this.inventoryTotals.keys()]);
    for (const userId of ids) {
      const counts = this.itemCounts.get(userId) ?? new Map<number, number>();
      let sum = 0;
      for (const n of counts.values()) if (n > 0) sum += n;
      const total = this.inventoryTotals.get(userId) ?? sum;
      if (sum === 0 && total === 0) continue;
      out.set(userId, { counts, total });
    }
    return out;
  }

  /**
   * 上一次**读回落账**的读数(诊断;判据用它区分「库里没有账」与「读回成空」)。
   *
   * `null` = 本房间还没读过;`applied: false` 的三种成因各不相同:
   * ```text
   * 没有库            db === null
   * 本地已有账        内存账比库新(离场已存过一次;存失败时库里那份更旧)⇒ 不覆盖
   * 库里没有可用账    没有 users 行 / 还是 '{}' / 格式读不懂(repo §15)
   * ```
   */
  lastLedgerRestore: {
    readonly userId: string;
    readonly applied: boolean;
    /** 读回的按件条目数。 */
    readonly counts: number;
    /** 读回的总量账。 */
    readonly total: number;
    /** 库里两账不一致(总量账漂了)—— 如实上报,不在这里替它改数。 */
    readonly drift: boolean;
  } | null = null;

  /** 背包账读回失败时的错因;`null` = 没有失败。 */
  lastLedgerError: string | null = null;

  /**
   * ★ WS-FND-163(A4):从库里读回**这个玩家**的背包账(入场时调一次)。
   *
   * ## 为什么只在「本房间没有这个人的账」时才读
   * 内存账永远不比库旧:
   * ```text
   * 离场前已经存过一次(leave() 先 saveWorldNow('leave') 再 purgeSeat)
   * 存失败时库里那份才是**更旧的**(失败已记账,但没有改库)
   * ```
   * ⇒ 无条件覆盖写会把「这一局刚产出的东西」抹成「上一次的存档」。
   * 这条边界的判据在 `tests/WS-FND-163`(负对照:本地有账 ⇒ 库里的旧值不生效)。
   */
  restorePlayerLedger(userId: string): boolean {
    const db = this.db;
    if (db === null) {
      this.lastLedgerRestore = { userId, applied: false, counts: 0, total: 0, drift: false };
      return false;
    }
    if (this.itemCounts.has(userId) || this.inventoryTotals.has(userId)) {
      this.lastLedgerRestore = { userId, applied: false, counts: 0, total: 0, drift: false };
      return false;
    }
    let row: ReturnType<typeof loadPlayerLedger>;
    try {
      row = loadPlayerLedger(db, userId);
    } catch (e) {
      /* 读库失败**不抛**:背包读不回来不该让入场失败(与 `grantStartingInventory`
         的「入场不因一份礼物失败」同一取舍),但绝不静默。 */
      this.lastLedgerError =
        `背包账读回失败(${((e as Error)?.message ?? String(e)).slice(0, 120)})`.slice(0, 160);
      this.lastLedgerRestore = { userId, applied: false, counts: 0, total: 0, drift: false };
      return false;
    }
    if (row === undefined) {
      this.lastLedgerRestore = { userId, applied: false, counts: 0, total: 0, drift: false };
      return false;
    }
    /* 空账(库里存成 0 件)⇒ 什么都不落:Map 里多一条空账只是垃圾,
       而「他确实没有东西」这个事实不需要一条记录来表达。 */
    if (row.counts.size === 0 && row.total === 0) {
      this.lastLedgerRestore = { userId, applied: false, counts: 0, total: 0, drift: row.drift };
      return false;
    }
    const counts = new Map<number, number>();
    for (const [itemId, qty] of row.counts) {
      if (Number.isInteger(itemId) && itemId > 0 && Number.isInteger(qty) && qty > 0) {
        counts.set(Math.trunc(itemId), Math.trunc(qty));
      }
    }
    if (counts.size > 0) this.itemCounts.set(userId, counts);
    this.inventoryTotals.set(userId, row.total);
    this.lastLedgerError = null;
    this.lastLedgerRestore = {
      userId, applied: true, counts: counts.size, total: row.total, drift: row.drift,
    };
    return true;
  }
  drainViolations(): Violation[] {
    const out = this.pendingViolations;
    this.pendingViolations = [];
    return out;
  }

  /* ── 4.35 自动存档(★ owner 裁定 2026-11-20:像 Minecraft 一样自动保存)── */

  /**
   * **存一次世界** —— 自动存档的**唯一落点**(全部触发源都经这里,
   * 不另立第二套存档格式)。
   *
   * ## 为什么是「唯一落点」
   * 存档动作此前**只**在 `step()` 的 20 帧节流里出现过一次;而「离场 / 销毁 /
   * 重置」这三种时机各自都需要同一件事。若三处各写一遍 `host.saveToDb(...)`,
   * 那么「失败怎么记」「报告怎么填」「水位怎么推」就会长出**三份口径** ——
   * 本仓 1 号病根(两份实现)的最小形态。⇒ 三处只决定**何时**调,本方法决定**怎么调**。
   *
   * ## 复用既有存档路径
   * 落盘走 `host.saveToDb(db, roomId, nowMs, playerLedgers)`(HP → `users.hp`、
   * 生物 mem → `rooms.mob_mem_json`、★ WS-FND-163:玩家背包账 →
   * `users.inventory_json`),读回走 `loadFromDb` / `restoreFromProfile` /
   * `restorePlayerLedger`。本方法**不引入任何新格式**、不写新表、不改 DDL。
   *
   * ## 失败**不抛**,但绝不静默
   * ``` 
   * 抛出去 ⇒ 一次写库失败会掀掉整个房间(离场路径还会吞掉席位回收);
   * 静默   ⇒ 表现与「存成功了」逐字相同 —— 本仓反复记的那类缺陷。
   * ```
   * ⇒ 记 `lastSaveError` / `saveFailCount` / `saveErrors[]`,并且**不动** `lastSaveAt`
   *   与 `saveCount`(那两个数只描述**成功过**的次数与时刻)。
   *
   * @param reason 触发原因(周期 / 离场 / 销毁 / 重置 / 手动)。
   * @returns `true` = 这一次真的写进了库;`false` = 跳过(无库/无世界源)或失败。
   *          ⚠️ 调用方**不要**把它当错误处理依据 —— 它们看 `lastSaveError` 与
   *          `lastSaveSkipReason`(两者互斥,不会同时非空)。
   */
  saveWorldNow(reason: AutosaveReason = 'manual'): boolean {
    const db = this.db;
    const host = this.worldSaveHost;
    const now = this.clock.nowMs();
    /* 没有库 / 没有世界源 / 老宿主没实现 `saveToDb` ⇒ **什么都不做**。
       不写 `lastSaveAt`、不产 `lastSaveReport` —— 不撒谎说存过了
       (与 step 里那段 `if (this.worldSaveHost)` 同一 null 契约)。 */
    if (db === null || host === null || typeof host.saveToDb !== 'function') {
      this.lastSaveSkipReason = db === null ? 'no-db' : 'no-host';
      return false;
    }
    /* ★ P1(2026-11-21)**在途闸**:已经在写库时不许再进一次(判据读
       `autosaveState().inFlight`)。写库是同步的,这个标志兜的是**重入**
       (宿主回调里再碰存档 / 两个触发源在同一帧互相插队)。 */
    if (this.autosaveInFlight) return false;
    this.autosaveInFlight = true;
    this.lastSaveAttemptTick = this.state.meta.tick;
    try {
      /* ★ WS-FND-163(A4):背包账(**按件账 + 总量账**)与 HP / 生物 mem
         **同一次写入、同一个落点** —— 存档动作仍然只有一个实现。
         传的是**导出结果**(空账就是空 Map):「这一次写了几份」由报告如实带出来,
         不在这里猜,也不另开第二条存档路径。 */
      const playerLedgers = this.exportPlayerLedgers();
      const r = host.saveToDb(db, this.id, this.lastActivityMs, playerLedgers);
      /* 报告与库是**同一份**写入的结果:报告的 tick 取**存档后**的房间帧号,
         与 `world_tick` 同版(否则读回时两者会差一帧)。 */
      this.lastSaveReport = {
        tick: this.state.meta.tick,
        hpSaved: r.hpSaved,
        hpSkipped: r.hpSkipped,
        memRow: r.memRow,
        /* 老宿主(没有这三个数)⇒ 如实记 0:报告里恒定出现,读的人不必先判 undefined。 */
        ledgerSaved: r.ledgerSaved ?? 0,
        ledgerDropped: r.ledgerDropped ?? 0,
        /* ★ WS-FND-165(B1):台账那一段 —— 老宿主(没有这三个数)⇒ 如实记 0。 */
        systemsRow: r.systemsRow ?? 0,
        systemsKeys: r.systemsKeys ?? 0,
        systemsDropped: r.systemsDropped ?? 0,
      };
      this.lastSaveAt = now;
      this.lastAutosaveAtMs = now;
      this.lastSaveReason = reason;
      this.saveCount += 1;
      this.lastSaveError = null;
      this.lastSaveSkipReason = null;
      /* ★ P1:成功 ⇒ 退避归零(失败过的那一段窗口已经过去)。 */
      this.autosaveBackoffFrames = 0;
      return true;
    } catch (e) {
      const message = ((e as Error)?.message ?? String(e)).slice(0, 160);
      this.lastSaveError = `自动存档失败(${reason}):${message}`;
      this.saveFailCount += 1;
      this.saveErrors.push({ at: now, reason, message });
      if (this.saveErrors.length > SAVE_ERROR_LOG_MAX) this.saveErrors.shift();
      /* ★ P1(2026-11-21)**退避**:修前失败后每一帧都重试(20Hz 下一秒钟一次,
         永不退避)⇒ 写不进去的库会被重试打死。现在按**帧**指数放大:
         第一次失败 ⇒ 一个帧节流窗,之后每次翻倍、封顶 `AUTOSAVE_BACKOFF_MAX_FRAMES`;
         任何一次成功立刻归零(见上一支)。 */
      this.autosaveBackoffFrames = this.autosaveBackoffFrames === 0
        ? AUTOSAVE_FRAME_INTERVAL
        : Math.min(this.autosaveBackoffFrames * 2, AUTOSAVE_BACKOFF_MAX_FRAMES);
      return false;
    } finally {
      this.autosaveInFlight = false;
    }
  }

  /**
   * ★ P1(2026-11-21)自动存档的**调度读数**(判据专用:调度状态本身是私有的,
   * 不该为了可测就长成第二套公开 API)。
   *
   * ```text
   * inFlight        一次写库正在进行中(闸见 `saveWorldNow`)
   * backoffFrames   当前失败退避窗(帧);0 = 不在退避
   * lastAttemptTick 上一次**尝试**存档的房间帧号(-1 = 还没试过)
   * untilBackoffOver 还差几帧才允许再试(0 = 现在允许)
   * ```
   */
  autosaveState(): {
    inFlight: boolean; backoffFrames: number; lastAttemptTick: number; untilBackoffOver: number;
  } {
    const since = this.state.meta.tick - this.lastSaveAttemptTick;
    return {
      inFlight: this.autosaveInFlight,
      backoffFrames: this.autosaveBackoffFrames,
      lastAttemptTick: this.lastSaveAttemptTick,
      untilBackoffOver: Math.max(0, this.autosaveBackoffFrames - since),
    };
  }

  /* ══════════ ★ WS-FND-165(B1):玩家快照的周期轨(等级 / 经验 / 天赋 / 位置 / 血量)══════════
   *
   * ## 它补的是哪一段
   * ```text
   * users.exp / talent_json        生产 **0 写入**(createUser 之后再没有写点)
   * users.level / pos_x / pos_y    只在 join / 断线那一刻定格
   * ```
   * ⇒ 两次入场之间的一切(打怪涨的经验、走到哪里、掉了多少血)在崩溃时**全丢**。
   * 本轨按 `PLAYER_SNAPSHOT_INTERVAL_MS` 落库,把「定格在入场那一刻」变成「最近 10 秒」。
   *
   * ## 状态是**字段**而不是局部变量
   * 与 `lastSaveAt` / `maybeTrimEvents` 同一取舍:调度状态 приватно,但必须**可观测**
   * (`lastPlayerSnapshotAt` / `playerSnapshotCount` / …),否则「轨没跑」与
   * 「跑了但没人需要」从外面看不出区别(live-path 那类缺陷)。
   */

  /** 周期快照的水位(建房即「刚存过」,否则首帧就会因为 `now - 0 >= 10s` 误触发)。 */
  private lastPlayerSnapshotAtMs: number;
  /** 偶发写库失败时的退避窗(帧);成功即归零。 */
  private playerSnapshotBackoffFrames = 0;
  private lastPlayerSnapshotAttemptTick = -1;
  /** 成功落盘次数(**失败不计**:与 `saveCount` 同一口径)。 */
  playerSnapshotCount = 0;
  /** 最近一次**成功**落盘的时刻;`null` = 还没成功过。 */
  lastPlayerSnapshotAt: number | null = null;
  /** 最近一次成功落盘的报告(几人的快照真的写进了库)。 */
  lastPlayerSnapshotReport: {
    tick: number; saved: number; skipped: number; dropped: number; reason: string;
  } | null = null;
  /** 最近一次失败的错因;`null` = 没有失败。 */
  lastPlayerSnapshotError: string | null = null;
  /** 跳过原因(`no-db` / `no-host` / `no-capability`);成功时归 `null`。 */
  lastPlayerSnapshotSkipReason: string | null = null;
  /** 最近的失败(环形,最多 8 条)—— 与 `saveErrors` 同一处置。 */
  readonly playerSnapshotErrors: { at: number; reason: string; message: string }[] = [];
  /**
   * ★ 冷启动恢复房间系统台账的读数(`null` = 本房间还没试过)。
   *
   * 为什么必须可观测:台账是「哪几张单已结算」的唯一跨进程真值;
   * `reason: 'corrupt'` 意味着**重放窗口可能是开的**,而那件事必须看得见,
   * 不许被一句「恢复失败但房间照常跑」盖过去。
   */
  lastRoomSystemsRestore: {
    readonly applied: boolean;
    readonly added: number;
    readonly keys: number;
    readonly dayIndex: number;
    readonly dropped: number;
    readonly reason: string;
  } | null = null;
  /** 最近一次入场读回**成长档案**(等级/经验/天赋)的读数;`null` = 还没试过。 */
  lastProgressionRestore: {
    readonly userId: string;
    readonly applied: boolean;
    readonly level: number;
    readonly exp: number;
    readonly talent: number;
    readonly reason: string;
  } | null = null;
  /** 成长档案读回失败时的错因;`null` = 没有失败。 */
  lastProgressionRestoreError: string | null = null;

  /**
   * ★ WS-FND-165(B1):**冷启动恢复结算台账**(构造期调一次)。
   *
   * 位置:建房之后、任何人入场之前。此刻世界是全新的(台账空、日号 0),
   * 而库里的那份才是「这间房以前结算过什么」⇒ 必须**先**并进来,
   * 否则第一张老订单就会被当成新订单再成交一次(这正是本次要修的缺陷)。
   *
   * 失败**不抛**(与 `maybeTrimEvents` 同一取舍:冷启动不该因为一份台账起不来),
   * 但如实分类记进 `lastRoomSystemsRestore`,并由 `reason` 区分
   * 「没有库 / 宿主没这能力 / 库里没有 / 库里读不懂」。
   */
  restoreRoomSystems(): boolean {
    const host = this.worldSaveHost;
    /* 顺序固定(与 `saveWorldNow` 的 null 契约同一写法):
       1 没有库          ⇒ no-db(纯内存模式没有跨进程真值)
       2 宿主没有这个能力 ⇒ no-capability(手写假件 / 老宿主,不假装做过)
       3 库**没装过**本迁移 ⇒ no-table,**直接跳过读口** —— 这一条不只是措辞:
         `MemoryDb.get()` 对不存在的表会**顺手建一张空表**,于是「读一次」会在内存
         夹具上凭空多出第 10 张表,把既有判据(`tests/WS-FND-156` FND156-7 的
         「只多了台账这一张」)打红。库从没装过 ⇒ 本来就没有台账可读。 */
    if (this.db === null) {
      this.lastRoomSystemsRestore = {
        applied: false, added: 0, keys: 0, dayIndex: 0, dropped: 0, reason: 'no-db',
      };
      return false;
    }
    if (host === null || typeof host.restoreRoomSystemsFromDb !== 'function') {
      this.lastRoomSystemsRestore = {
        applied: false, added: 0, keys: 0, dayIndex: 0, dropped: 0, reason: 'no-capability',
      };
      return false;
    }
    try {
      /* 台账表的**启动漂移检查**:装过本迁移的库 ⇒ 幂等 DDL + checksum 判定,
         漂移 ⇒ 抛(与起始包台账/归档同一条 fail-closed 纪律);没装过 ⇒ 什么都不做
         ⇒ 下面直接记 no-table,一个字节都不碰库。 */
      const boot = migrateRoomSystemsIfInstalled(this.db, this.clock.nowMs());
      if (!boot.installed) {
        this.lastRoomSystemsRestore = {
          applied: false, added: 0, keys: 0, dayIndex: 0, dropped: 0, reason: 'no-table',
        };
        return false;
      }
      const r = host.restoreRoomSystemsFromDb(this.db, this.id);
      this.lastRoomSystemsRestore = {
        applied: r.applied, added: r.added, keys: r.keys,
        dayIndex: r.dayIndex, dropped: r.dropped, reason: r.reason,
      };
      return r.applied;
    } catch (e) {
      this.lastRoomSystemsRestore = {
        applied: false, added: 0, keys: 0, dayIndex: 0, dropped: 0,
        reason: `failed:${((e as Error)?.message ?? String(e)).slice(0, 120)}`,
      };
      return false;
    }
  }

  /**
   * ★ WS-FND-165(B1):**把在场玩家的快照写进库**(周期轨的唯一落点)。
   *
   * ## 与 `saveWorldNow` 的分工
   * ```text
   * saveWorldNow        写「世界」:HP / 生物 mem / 背包账 / 结算台账(30 秒 + 事件触发)
   * savePlayerSnapshotsNow 写「人」:等级 / 经验 / 天赋 / 位置 / 血量(10 秒)
   * ```
   * 两者共用**同一份** repo 写口风格(事务 + 计数 + 失败不抛但可读),但**不**共用一个方法:
   * 合并会让「玩家状态的及时性」与「世界存档的频率/成本」互相绑架。
   *
   * ## 没有宿主导出能力时**跳过**,且跳过原因可读
   * 手写 host 假件没有 `exportPlayerSnapshots` ⇒ 记 `no-capability` 而不抛
   * (与 `saveWorldNow` 的 `no-host` 同一处置)。
   *
   * @returns `true` = 这一次真的写进了库(至少一行有效);`false` = 跳过或失败。
   */
  savePlayerSnapshotsNow(reason: string = 'manual'): boolean {
    const db = this.db;
    const host = this.worldSaveHost;
    const now = this.clock.nowMs();
    if (db === null || host === null || typeof host.exportPlayerSnapshots !== 'function') {
      this.lastPlayerSnapshotSkipReason = db === null
        ? 'no-db'
        : (host === null ? 'no-host' : 'no-capability');
      return false;
    }
    this.lastPlayerSnapshotAttemptTick = this.state.meta.tick;
    try {
      /* ★ WS-FND-168:把**朝向 / 手持物**并进快照行 —— 它们是 `PlayerState` 的字段
         (模拟层没有它们的落点),由持有 `state` 的房间补上;装备由宿主导出。
         「房间补 state、宿主导档案」的分工与投影表一致(见 room.ts 的 §投影)。 */
      const rows = host.exportPlayerSnapshots().map((r) => {
        const ps = this.state.players.find((p) => p.id === r.userId);
        if (ps === undefined) return r;
        return { ...r, dir: ps.dir, heldItemId: ps.heldItemId };
      });
      const r = savePlayerSnapshots(db, rows, now);
      this.lastPlayerSnapshotReport = {
        tick: this.state.meta.tick, saved: r.saved, skipped: r.skipped, dropped: r.dropped, reason,
      };
      this.lastPlayerSnapshotAt = now;
      this.playerSnapshotCount += 1;
      this.lastPlayerSnapshotError = null;
      this.lastPlayerSnapshotSkipReason = null;
      this.playerSnapshotBackoffFrames = 0;
      return r.saved > 0;
    } catch (e) {
      const message = ((e as Error)?.message ?? String(e)).slice(0, 160);
      this.lastPlayerSnapshotError = `玩家快照落库失败(${reason}):${message}`;
      this.playerSnapshotErrors.push({ at: now, reason, message });
      if (this.playerSnapshotErrors.length > 8) this.playerSnapshotErrors.shift();
      /* 退避:与自动存档同一取法(第一次失败 ⇒ 一个周期窗,之后翻倍、封顶)。 */
      this.playerSnapshotBackoffFrames = this.playerSnapshotBackoffFrames === 0
        ? AUTOSAVE_FRAME_INTERVAL
        : Math.min(this.playerSnapshotBackoffFrames * 2, AUTOSAVE_BACKOFF_MAX_FRAMES);
      return false;
    }
  }

  /**
   * 本帧该不该写玩家快照(周期轨;`step()` 顶部调用,与 `maybeTrimEvents` 逐字同款)。
   *
   * 闸:退避窗未过 ⇒ 不写;距上次成功不足 `PLAYER_SNAPSHOT_INTERVAL_MS` ⇒ 不写。
   * `CLOSED` 房间不再推进(席位已由装配层收走)。
   */
  maybeSavePlayerSnapshots(): boolean {
    if (this.db === null) return false;
    if (this.status === RoomStatus.CLOSED) return false;
    const now = this.clock.nowMs();
    const sinceAttempt = this.state.meta.tick - this.lastPlayerSnapshotAttemptTick;
    if (this.playerSnapshotBackoffFrames > 0 && sinceAttempt < this.playerSnapshotBackoffFrames) {
      return false;
    }
    if (now - this.lastPlayerSnapshotAtMs < PLAYER_SNAPSHOT_INTERVAL_MS) return false;
    this.lastPlayerSnapshotAtMs = now;
    return this.savePlayerSnapshotsNow('interval');
  }

  /**
   * ★ WS-FND-165(B1):入场时读回**成长档案**(经验 / 天赋 / 等级)。
   *
   * 修前这一段是空的:`restoreFromProfile` 只带回 level/hp/位置,而
   * `users.exp` / `talent_json` **没有任何写点** ⇒ 「重启后等级在、经验归零」。
   * 现在入场顺路问一次库(有宿主能力才问;没有 ⇒ 记 `no-capability`,不假装)。
   */
  restorePlayerProgression(userId: string): boolean {
    const host = this.worldSaveHost;
    const db = this.db;
    if (
      db === null || host === null
      || typeof host.restoreProgressionFromDb !== 'function'
    ) {
      this.lastProgressionRestore = {
        userId, applied: false, level: 0, exp: 0, talent: 0,
        reason: db === null ? 'no-db' : 'no-capability',
      };
      return false;
    }
    try {
      const r = host.restoreProgressionFromDb(db, userId);
      this.lastProgressionRestore = {
        userId, applied: r.applied, level: r.level, exp: r.exp, talent: r.talent, reason: r.reason,
      };
      if (r.applied) this.lastProgressionRestoreError = null;
      return r.applied;
    } catch (e) {
      this.lastProgressionRestoreError =
        `成长档案读回失败(${((e as Error)?.message ?? String(e)).slice(0, 120)})`.slice(0, 160);
      this.lastProgressionRestore = {
        userId, applied: false, level: 0, exp: 0, talent: 0, reason: 'failed',
      };
      return false;
    }
  }

  /**
   * 本帧该不该自动存档 —— 返回**原因**(`null` = 本帧不存),而不是布尔:
   * 「周期到点」与「冷启动帧节流」在排查存档频率时是两个答案,不该压成一个 `true`。
   *
   * ══════════ ★ P1(2026-11-21)双轨**倒置**修点 ══════════
   *
   * ## 修前形态(实测:16 人房 ~35 SQL/s、约 12.6 万条/h)
   * ```text
   * autosaveDue():  if (tick % 20 === 0) return 'frame';     ← **先判**
   *                 if (now - lastAutosaveAtMs >= 30_000) …   ← 正常推进下永远轮不到
   * ```
   * 帧轨先判 ⇒ 每 20 帧(1 秒)**必存一次**,而墙钟轨那 30 秒的承诺一次都不触发
   * (它只在房间被低频驱动、且帧号恰好不是 20 的倍数时才有机会)。owner 裁定要的是
   * 「像 Minecraft 一样自动保存」= **每 30 秒一次**,不是「每秒一次」—— 两个
   * 「至少 / 至多」被写成了两个**触发器**,于是一个顶掉另一个。
   *
   * ## 现在:墙钟是**触发源**,帧节流只能让它**更慢**
   * ```text
   * 在途 / 失败退避窗未过            ⇒ 不存           ← 新增
   * now - lastAutosaveAtMs ≥ 30s    ⇒ 'interval'     ← 稳态**唯一**触发器
   * 还没成功存过 且 tick % 20 === 0  ⇒ 'frame'        ← 冷启动垫底(见下)
   * 其余                            ⇒ 不存
   * ```
   * 「帧轨更慢、不更快」的两条保证:
   *   1 帧轨只在 `saveCount === 0`(还没有一次**成功**存档)时成立 —— 冷启动那一次,
   *      以及持续失败时(那时真正的限速器是退避窗);一旦存成功过,它就不再参与;
   *   2 任何一次触发都要先过「距上次墙钟 ≥ `AUTOSAVE_INTERVAL_MS`」⇒ **没有任何
   *      路径**能让两次成功存档的间隔短于 30 秒。
   *
   * ⚠️ 为什么保留冷启动那一次:第 20 帧触发是**既有口径**
   * (`AUTOSAVE_FRAME_INTERVAL`;`tests/WS-FND-150` 的 FND150-5 / FND150-9 用**冻结的
   * 虚拟时钟**钉着它:空库第一次帧节流点要落一次盘、写失败在帧节流点也要记账)。
   * 删掉它 = 「建房后一直没人推进到 30 秒」的房间一个字节都不写库 —— 那是另一条缺陷。
   * 冷启动只发生一次,不构成每秒写库。
   */
  private autosaveDue(): AutosaveReason | null {
    if (this.autosaveInFlight) return null;
    const tick = this.state.meta.tick;
    /* 退避窗没过 ⇒ 这一帧不试(它同时是「失败后每秒重试」的止血点)。 */
    if (tick - this.lastSaveAttemptTick < this.autosaveBackoffFrames) return null;
    if (this.clock.nowMs() - this.lastAutosaveAtMs >= AUTOSAVE_INTERVAL_MS) return 'interval';
    /* 冷启动垫底:还没有一次成功存档时,帧节流点试一次(只到第一次成功为止)。 */
    if (this.saveCount === 0 && tick % AUTOSAVE_FRAME_INTERVAL === 0) return 'frame';
    return null;
  }

  /**
   * ★ WS-FND-163(A1):`room_events` 有界保留的**周期轨**(具名间隔 30 秒)。
   *
   * ## 为什么必须有这条轨
   * `repo.ts#trimEvents` 是幂等的,但修前它的触发点只有「写入流水」与
   * 「VACUUM / 外部维护」—— 于是**只读房**(没人写审计流水)永远不会 trim,
   * 「库不会涨」这条承诺退化成「恰好有人在写流水」。
   *
   * ## 调用点为什么在 `step()` 的**顶部**(早于 `status !== OPEN` 早退)
   * 只读房的典型形态就是 `SLEEPING`:玩家全走了、房间不再推进帧号。
   * 把本方法放在那行早退**之后**,它就永远跑不到 —— 与修前是同一个缺陷。
   * 与 `retryPendingWorldRemovals()` 同一位置、同一理由(见 `step()` 顶部)。
   *
   * ## 闸与水位
   * 距上次 trim 不足 `EVENT_TRIM_INTERVAL_MS` ⇒ **立刻返回 0、一行都不碰**
   * (判据是水位而不是「调用次数」;幂等由 `trimEvents` 自己保证 ——
   * 未超上限时它同样返回 0)。
   *
   * ## 失败不抛但绝不静默
   * 一次 DELETE 失败不该掀掉整帧(与 `saveWorldNow` 同一取舍),
   * 但「流水不再回收」必须可读 ⇒ `lastEventTrimError` + `lastEventTrim` 如实留证。
   *
   * @returns 本次真的删掉的行数(未到点 / 未超上限 / 失败 ⇒ 0)
   */
  maybeTrimEvents(): number {
    if (this.db === null) return 0;
    const now = this.clock.nowMs();
    if (now - this.lastEventTrimAtMs < EVENT_TRIM_INTERVAL_MS) return 0;
    this.lastEventTrimAtMs = now;
    try {
      const removed = trimEvents(this.db);
      this.lastEventTrim = { at: now, removed };
      this.eventTrimCount += 1;
      this.lastEventTrimError = null;
      return removed;
    } catch (e) {
      const message = ((e as Error)?.message ?? String(e)).slice(0, 160);
      this.lastEventTrimError = `事件流水保留失败(${message})`;
      /* 失败**不**推进成功计数,但留一条读数(removed: 0 与实际一致)。 */
      this.lastEventTrim = { at: now, removed: 0 };
      return 0;
    }
  }

  /* ── 4.4 每帧推进 ── */

  /**
   * 32Hz 推进。返回本帧的编码报文(差量)。
   * `prev` 由调用方持有(通常是「上一帧已发给该客户端的快照」)。
   */
  step(prevSnapshot: RoomState | null = null): Uint8Array {
    /* ★ WS-FND-131(P2/SLEEPING):回收**不受 status 限制**。
       修前这条早退写在 `reapExpiredDisconnects()` **之前** ⇒ 全员断线 → 房间
       SLEEPING ⇒ 到期席位与世界刚体一直挂着(step 根本走不到回收那一行);
       而新玩家加入时先 `wake()`、再按 `members.size` 判满 ⇒ **对零在线房间
       误报「房间已满」**。⇒ 现在休眠房里也把两件清理做掉:
         · `retryPendingWorldRemovals()` 推进上一次抛错的世界侧移除(见 purgeSeat);
         · `reapExpiredDisconnects()` 回收宽限期已过的席位。
       `CLOSED` 例外:房间已销毁,回收没有意义(席位由装配层 onDispose 收)。
       这两步**都不推进 `meta.tick`** ⇒ F07「休眠房不推进帧号」照旧成立。 */
    this.retryPendingWorldRemovals();
    /* ★ WS-FND-163(A1):`room_events` 有界保留的周期轨 —— 位置与上面那行
       **逐字同款**:在 `status !== OPEN` 早退**之前**。只读房的形态正是
       `SLEEPING`(玩家全走了、帧号不再推进),放在早退之后就永远跑不到,
       那与修前「只读房永不 trim」是同一个缺陷。
       ⚠️ 与存档轨**无关**:没有世界源 / 存档正在退避时本轨照跑
       (理由见 `EVENT_TRIM_INTERVAL_MS` 的注释)。 */
    this.maybeTrimEvents();
    /* ★ WS-FND-165(B1):玩家快照的**周期轨** —— 与上面那行逐字同款
       (在 `status !== OPEN` 早退**之前**,因为休眠房里也要把人物状态落住;
        本轨自带 `PLAYER_SNAPSHOT_INTERVAL_MS` 水位 + 失败退避)。
       ⚠️ 与自动存档轨**无关**:存档在退避 / 没有世界源时本轨照跑。 */
    this.maybeSavePlayerSnapshots();
    if (this.status !== RoomStatus.CLOSED) this.reapExpiredDisconnects();
    if (this.status !== RoomStatus.OPEN) return new Uint8Array(0);
    this.state.meta.tick += 1;
    /* ★ WS-FND-123:世界总线订阅必须在**第一次 advance 之前**接上 ——
       播报是在 `advance()` 内部 `bus.drain()` 时投递的,晚一帧接就丢掉第一帧的
       开局播报(`MODE_START`)。幂等。 */
    this.attachWorldBus();
    /* ★ 第六轮:派对 HUD 的三个字段与 `meta.tick` **同一个写点**(每帧一次)——
       放在这里而不是 `worldSaveHost.advance()` 里,是因为它读的两份事实
       (房间赛局记录 / 世界队伍)在**任何**宿主下都存在,而 `advance` 是可选成员。 */
    this.syncPartyHud();
    /* ★ WS-FND-172(接线):把这**一帧的实测墙钟差**喂给反作弊速度窗口的**分母**。

       ## 为什么必须接线
       `anticheat.ts` 把窗口分母参数化(`setFrameIntervalMs` / `tick(t, frameMs)`)
      正是为「服务端真帧率 ≠ 标称帧步长」那一半;不接线则分母恒为标称帧步长
      (`anticheat.ts` 的 `DEFAULT_FRAME_DT_SECONDS`,由 `TICK_HZ` 推导:
      20Hz ⇒ 50ms,32Hz ⇒ 31.25ms)
       ⇒ 实测 15.93Hz(62.77ms/帧)下合法 4.5 格/秒被读成
       `4.5 × 20 / 15.93 = 5.65 > 上限 5.625`(FND172-3 登记的那次误判)。
       而**本行**是房间侧唯一读得到实测节拍的地方(`this.clock.nowMs()`)。

       ## ⚠️ 为什么必须有上限(`AC_FRAME_GAP_MAX_MS`)
       本行在 `status !== OPEN` 早退**之后** ⇒ 休眠期间一帧都不调 ⇒
       **唤醒后首个差值 = 整段休眠时长**(以秒计)。若照传:分母被放大几个数量级、
       窗口读数趋近 0 ⇒ 反作弊失明 —— **比不接线更糟**(稀释)。
       ⇒ 首帧(无差值)与「差值 > `AC_FRAME_GAP_MAX_MS` / ≤ 0(时钟回拨)」
       一律**丢弃**:不给分母,并计一次 `acFrameGapDiscarded`(丢弃可观测,不静默)。
       丢弃时走 `tick(t)`(不传 `frameMs`)⇒ 分母保持上一次的**实测**值
      (从未注入过时即缺省标称帧步长,同上)。

       ⚠️ 与 `sim.frame` **无关**:喂进去的是**墙钟差**,不是帧号
       (见下面那段「三个时钟互不联动」)。 */
    const acNowMs = this.clock.nowMs();
    if (this.lastAcFrameMs === null) {
      /* 首帧:没有前一帧的读数 ⇒ 无差值可算(分母保持当前值)。 */
      this.ac.tick(this.state.meta.tick);
    } else {
      const acFrameMs = acNowMs - this.lastAcFrameMs;
      if (acFrameMs > 0 && acFrameMs <= AC_FRAME_GAP_MAX_MS) {
        this.ac.tick(this.state.meta.tick, acFrameMs);
      } else {
        this.acFrameGapDiscarded += 1;
        this.ac.tick(this.state.meta.tick);
      }
    }
    this.lastAcFrameMs = acNowMs;

    /* ── 推进世界(task-59:驱动缺失)──
       接线前**服务器路径**对 `tick`/`run` 的调用是 **0 处**
       (`setSimulationInterval` → 本方法 → 只 tick 计数/落盘/投影等级 → 返回)
       ⇒ 物理 / AI / 流体 / 电路 / 刷怪 / `syncPlayers()` 一帧都没跑过。
       最要命的是 `syncPlayers()`:它是 `mobPlayers` 的唯一刷新点,
       不跑 ⇒ **生物 AI 看不见玩家移动**。

       ## 为什么是 `advance(1)` 且**只能**写 1
       `WorldSim` 内部自管双频(`FAST_PER_SLOW = secondsToTicks(SLOW_DT)` = 16),一次 `tick()` 就是一帧
       (相位由 `frame % FAST_PER_SLOW` 决定);`SIM_FAST_DT = 0.03125 = 1/32` 与外部
       32Hz **天然对齐**。⇒ 外部一帧 = 内部一快帧,**恰好 1:1**。

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
       room.state.meta.tick  本方法 +1(房间 32Hz)
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
    /* ★ WS-FND-174:把**世界钟读数**推给睡眠登记(`actions/sleep.ts`)。
       为什么必须由房间推:打盹窗口的两端必须与世界侧的回血/露水
       (`tickAfk` 收到的 `nowSec`)同一个时基,而房间是**唯一**驱动世界的人 ——
       世界钟只有它读得到。时机 = 推完世界的下一行(读数即本帧世界钟),
       于是「窗口到期」与「回血停止」落在**同一个慢帧**。 */
    noteSleepWorldSeconds(this.id, worldSecondsOf(host));

    /* ★ WS-FND-123:两套开局**打通**的落点(见 `syncPartyRecord`)。
       必须在 `advance(1)` **之后**:世界的 `partyPhase()/partyModeKey()` 是本帧
       推进后的事实(哨台入口在 `tickPartyStep` 里跑),早一帧读会差一整局。 */
    this.syncPartyRecord();
    /* 结算/开局会在上面这一行里改变记账 ⇒ HUD 三个字段用**同一帧**的新值重算一次。
       `syncPartyHud` 只写有变化的字段 ⇒ 重复调用无副作用。 */
    this.syncPartyHud();

    this.checkIdleSleep();
    /* ══════════ ★ 自动存档(owner 裁定 2026-11-20:不提供手动 SAVE/LOAD)══════════
     * 两条轨的关系见 `autosaveDue()`(**墙钟是触发源,帧节流只能更慢**):
     *   · 墙钟(每 `AUTOSAVE_INTERVAL_MS` = 30 秒)—— 稳态**唯一**触发器;
     *   · 帧节流(每 `AUTOSAVE_FRAME_INTERVAL` 帧)—— 只在「还没成功存过」时垫一次;
     *   · 失败后按帧**指数退避**(`saveWorldNow`),不再每帧重试。
     * 落盘动作本身**只有一个实现**(`saveWorldNow()`):这里只决定「何时」。
     */
    if (this.db) {
      /* 世界帧号低频落盘(每 20 帧 = 0.625 秒),避免 32Hz 写库。 */
      if (this.state.meta.tick % AUTOSAVE_FRAME_INTERVAL === 0) {
        this.db.update('rooms', { id: this.id }, {
          world_tick: this.state.meta.tick,
          last_active_at: this.lastActivityMs,
        });
      }
      const due = this.autosaveDue();
      if (due !== null) this.saveWorldNow(due);
      /* ⚠️ 为什么 `world_tick` 写在**存档之前**:`saveToDb` 里 `saveRoomMobMem`
         也会写 `last_active_at`,先写帧号再写内容,两者落在同一秒;
         顺序固定,读回时 `world_tick` 与 `mob_mem_json` 必然同版。

         `worldSaveHost` 为 null 时 `saveWorldNow` **什么都不做**(只记
         `lastSaveSkipReason`)—— 不撒谎说存过了。 */
    }

    /* ⚠️ 必须在 `if (this.db)` **之外** —— 等级投影与有没有数据库无关。
       (放进去的话,纯内存模式 `db === null` 就永远不同步等级,
       而那正是测试最常用的形态。) */
    this.projectAllPlayers();
    /* ★ 2026-11-14:生物投影。与等级投影**同一时机、同一理由**
       (「权威一变,投影随即一致」),而且必须与下面的 `encodeDelta` 同帧 ——
       否则客户端比世界晚一帧才看到生物(表现为「走过去才发现它在动」)。 */
    this.projectWildlife();
    /* ★ WS-FND-123:boss 投影。与生物投影**同帧同理由**(权威一变,投影随即一致),
       且必须与下面的 `encodeDelta` 同帧 —— 否则客户端晚一帧才看到 boss 换阶段/换预警。 */
    this.projectBosses();
    /* ★ 审计 P0-2 要求:过期凭证必须真的被回收。
       修前 `expireItemSources()` **全仓零调用**(见 `anticheat.ts` §5.0 的「修前」段),
       而 `grantItemSource` 只增不减 ⇒ 未消费的令牌一直留到房间销毁。
       安全性不依赖本调用(令牌自带 tick + 一次性判据),这里治的是**内存卫生**:
       放在**每 tick 末**,tick 之间到达的动作照常铸/验,凭证**不跨 tick 累积**。
       `expireItemSources` 是**幂等**的(只 `clear()` 一张 Map),重复调用无副作用。 */
    this.expireItemSources();
    return prevSnapshot ? encodeDelta(prevSnapshot, this.state).bytes : new Uint8Array(0);
  }

  /**
   * 把世界的**存活生物清单**单向投影进 `state.wildlife`(权威 → 投影)。
   *
   * ## 它补的是一条**断了两头的**链路
   * ```
   * 世界侧  canSpawn(...) ⇒ spawned += 1          ← 只计数,不造怪(已于 world_sim 修)
   * 网络侧  upsertWildlife()                      ← 全仓 0 个调用点(本方法补上)
   * ```
   * ⇒ 两头都缺时表现完全一样:**客户端 `wildlife: []`**,
   *   而服务端一切"正常"(没有异常、没有日志、测试照过)。
   * 这正是本仓反复记的那类缺陷:能力存在、通路缺失。
   *
   * ## 清账为什么必须做
   * `upsertWildlife` 只**增/改**,没有对应的删除调用。不清的话,
   * 被打死的生物会**永远留在客户端快照里**:一只打不动、也不反击的幽灵目标
   * (`attackMobAuthorized` 对它回 `null`)。
   * ⇒ 以「权威清单」为准做一次差集删除,而不是等客户端自己超时。
   *
   * ## 为什么不信 `this.state` 当权威
   * 本方法只做单向写:读世界的 `listWildlife()`,不改它。
   * 反向(把 `state.wildlife` 灌回世界)会让两处互为依据 ——
   * 与 `projectAllPlayers` 的注释里记的是**同一个**病根形态。
   */
  private projectWildlife(): void {
    const host = this.worldSaveHost;
    /* `typeof` 守卫与上面 `host.advance` 同一写法:接口是必选的,
       但**老的世界源**(测试里的手搓替身)可能不实现 ⇒ 退回"不投影",
       而不是抛。 */
    if (host === null || typeof host.listWildlife !== 'function') return;
    const seen = new Set<string>();
    for (const w of host.listWildlife()) {
      seen.add(w.id);
      upsertWildlife(this.state, {
        id: w.id, mobId: w.mobId, x: w.x, y: w.y, z: w.z,
        fsm: w.fsm, hp: w.hp, maxHp: w.maxHp,
        /* ★ 宠物归属的**权威**是 `actions/breed_tame.ts`(`tameOwnerOf`),不在这里写第二份;
           `null ⇒ ''` 就是 wire 的「野生」口径(`schema.ts` 里 `tameOwnerId` 默认为空串)。
           此前这一格直接抄 `w.tameOwnerId`,而世界侧那格恒为 `''` ⇒ 世界/AI 永远不知道谁被驯服。 */
        tameOwnerId: tameOwnerOf(this.state.roomId, w.id) ?? '',
      });
    }
    for (let i = this.state.wildlife.length - 1; i >= 0; i -= 1) {
      const id = this.state.wildlife[i]!.id;
      if (!seen.has(id)) removeWildlife(this.state, id);
    }
  }

  /**
   * ★ WS-FND-123(P1-1):把世界**在场 Boss** 单向投影进 `state.bosses`(10 字段)。
   *
   * ## 它补的是一条两头都断的链(与 `projectWildlife` 同一形态)
   * ```
   *   世界侧  BossRaidRuntime.snapshots()        ← 12 个内部字段(hp/phase/hpRatio…)
   *   网络侧  schema.ts#upsertBoss               ← 全仓**唯一**容器写口,零调用
   *   ⇒ 客户端 RoomState.bosses 恒 []  ⇒ bossHudFrom() 恒 null ⇒ 血条/地面预警走 demo 兜底
   * ```
   * 修前没有任何一处报错:boss 在世界里正常被打、正常进阶段,只是**从未出进程**。
   *
   * ## 为什么优先 `bossHudSnapshots()`
   * `bossSnapshots()` 不含 `id` 与五个预警字段(`telegraphShape/X/Y/R/EndTick`),
   * 而 `BOSS_FIELD_TABLE` 要求 10 格全给。线格式由世界侧算(= 唯一能拿到
   * `BossState` 的地方),本方法只搬运,**不重算几何**。
   *
   * ## 老世界源(只有 `bossSnapshots()`)怎么办:如实降级
   * 投影阶段与血量,预警五格写 `TelegraphShape.NONE / 0` —— 客户端据此**不画**预警圈,
   * 而不是拿一个默认圆兜底(那会让「几何丢了」看起来像正常画面)。
   */
  private projectBosses(): void {
    const host = this.worldSaveHost;
    if (host === null) return;
    let list: readonly BossState[] | null = null;
    if (typeof host.bossHudSnapshots === 'function') {
      list = host.bossHudSnapshots() as readonly BossState[];
    } else if (typeof host.bossSnapshots === 'function') {
      list = host.bossSnapshots().map((b) => ({
        id: `boss:${b.bossId}`,
        bossId: b.bossId,
        phase: b.phaseIndex,
        hp: b.hp,
        maxHp: b.maxHp,
        telegraphShape: TelegraphShape.NONE,
        telegraphX: 0,
        telegraphY: 0,
        telegraphR: 0,
        telegraphEndTick: 0,
      }));
    }
    /* 一个读口都没有 ⇒ **不投影**(也不清空既有投影:那是「世界不认识 boss」,
       不是「boss 全死了」)。 */
    if (list === null) return;
    const seen = new Set<string>();
    for (const b of list) {
      seen.add(b.id);
      upsertBoss(this.state, { ...b });
      this.bossProjectionCount += 1;
    }
    /* 清账:不在场的一律移除,理由与 `projectWildlife` 逐字相同 ——
       否则被打死的 Boss 会永远留在客户端快照里(一条打不动的血条)。 */
    for (let i = this.state.bosses.length - 1; i >= 0; i -= 1) {
      const id = this.state.bosses[i]!.id;
      if (!seen.has(id)) removeBoss(this.state, id);
    }
  }

  /**
   * ★ WS-FND-123(P1-4):接上世界总线的**第一段消费**(幂等)。
   *
   * 修前:`sim/world_sim.ts` 只 `bus.emit('party_broadcast', …)`,而 `server/src`
   * 里 `.bus.on(` 是 **0 处** ⇒ 比分播报 / 终场文案 / 前三名堆在总线里没人取,
   * 两端的类型都是对的、测试也是绿的(`WS-FND-120` 只断言「总线收到了」)。
   *
   * ## 为什么订阅必须早于第一次 `advance()`
   * 总线在 `advance()` 内部 `drain()` 时投递 ⇒ 晚一帧接就丢掉第一帧的开局播报。
   * 故 `step()` 在 `meta.tick += 1` 之后、`host.advance(1)` 之前调本方法。
   *
   * ## 没有 `bus` 的老世界源
   * 不订阅、也**不假装订阅**(`partyBroadcastTotal` 保持 0)。
   */
  private attachWorldBus(): void {
    if (this.worldBusAttached) return;
    const host = this.worldSaveHost;
    const bus = host === null ? undefined : host.bus;
    if (bus === undefined) return;
    this.worldBusAttached = true;
    const off = bus.on('party_broadcast', (e) => {
      const payload = e.payload ?? {};
      const text = typeof payload.text === 'string' ? payload.text : '';
      const kind = typeof payload.kind === 'string' ? payload.kind : e.kind;
      this.partyBroadcastOutbox.push({ kind, text, atTick: this.state.meta.tick });
      /* 上界:回执/下发只需要最近几条;无界数组会随着对局无限增长。 */
      if (this.partyBroadcastOutbox.length > 64) this.partyBroadcastOutbox.shift();
      this.partyBroadcastTotal += 1;
    });
    this.worldBusOff = typeof off === 'function' ? (off as () => void) : null;
  }

  /** 已收到、尚未下发的播报(只读视图;供传输层/诊断读)。 */
  partyBroadcasts(): readonly { kind: string; text: string; atTick: number }[] {
    return this.partyBroadcastOutbox;
  }

  /** 取走积压播报(下发出口;`drainViolations` 同一形态)。 */
  drainPartyBroadcasts(): { kind: string; text: string; atTick: number }[] {
    const out = this.partyBroadcastOutbox;
    this.partyBroadcastOutbox = [];
    return out;
  }

  /**
   * ★ WS-FND-123(P1-2):**两套开局打通** —— 记账(`PartyRecord`)与赛局(contest)。
   *
   * ## 修前是两条各开一半的路
   * ```
   *   436 哨台(世界):createPartyContest ⇒ contest 在跑,但 PARTIES 里没有记录
   *   START_PARTY(网络):写 PartyRecord      ⇒ 账本有了,但世界没有赛局
   *   ⇒ partyStateOf() 恒 null(哨台开的局)/ addScore 永不调用 / meta.scoreA/B 恒 0
   *      / endParty 零生产调用
   * ```
   *
   * ## 现在这一帧做什么(三种情形,都不猜)
   * ```
   *   世界有局 + 账本 RUNNING            ⇒ 什么都不做(已经在同一条路上)
   *   世界有局 + 账本没有/已结算          ⇒ 补建账本(走真正的 START_PARTY 动作)
   *   世界回 IDLE + 账本仍 RUNNING       ⇒ endParty 收束(名次定格,addScore 停止计分)
   * ```
   *
   * ## ★ WS-FND-176:第三支(D-23 的「自动回 IDLE」)**修前永不触发**
   *
   * ```text
   * 派对**自然超时**结算之后,世界的 `partyPhase()` 停在 'SETTLED' 再也不动
   *   (修前只有 436 哨台按 -1 的 `WorldSim.clearPartyRun()` 会清掉赛局容器)
   *   ⇒ 本方法第三支(判据 = `'IDLE'`)永不触发
   *   ⇒ 账本永远 RUNNING ⇒ `addScore` 继续累计(名次早已定格,分却还在涨)
   * ```
   *
   * ⇒ 修点在**世界侧**、且只有一处:`party/modes.ts` 的 `tickPartyMode` ——
   * 结算定格之后的下一慢帧把相位送回 `IDLE`(§6 有完整口径)。本方法**一个字都没改**:
   * 它等的那个 `'IDLE'` 现在真的会来,于是「世界回 IDLE + 账本仍 RUNNING ⇒ endParty」
   * 这条既有路径对自然超时也成立。
   *
   * ⚠️ **不**把这一支放宽成「`'SETTLED'` 也算收束」:`SETTLED` 是**结算那一帧**的可见形态,
   * 而那一帧的账**必须还开着**(结算前一刻的分仍算得进去)。提前关账会把终场分吞掉,
   * 而那种吞法不报错、只让名次少一档 —— 判据分列在 `tests/WS-FND-176`
   * (FND176-2/3/4:结算帧账本仍 RUNNING、跨过慢帧边界才收束)。
   *
   * ## 为什么必须走 `dispatchAction(START_PARTY)` 而不是自己写 Map
   * 账本的单例 `PARTIES` 只有 `actions/start_party.ts` 能写(`addScore`/`endParty`
   * 也都在那里)。房间这边再写一份就是第二份真值,那正是要消灭的形态。
   * ⇒ 房间只负责「找到**有权限**的演员 + 把世界的模式键投进去」。
   *
   * ## 演员怎么选(无权限时**如实跳过**,不静默冒充)
   * 候选序:裁判(哨台上站的人) → 房主。`START_PARTY` 要 `party` 权限位
   * (OWNER/ADMIN 有,MEMBER/GUEST 没有)—— 所以裁判是 MEMBER 而房主不在线时,
   * 本帧**建不出**账本,计入 `partyRecordSkips`(可断言,而不是看起来一切正常)。
   */
  private syncPartyRecord(): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.partyPhase !== 'function') return;
    const phase = host.partyPhase();
    const snap = partyStateOf(this.id);
    if (phase === 'IDLE' || phase === '') {
      this.partyRecordLatch = null;
      if (snap !== null && snap.state === PartyPhase.RUNNING) {
        const done = endParty(this.id, this.clock.nowMs());
        if (done !== null) this.partyRecordEndCount += 1;
      }
      return;
    }
    if (snap !== null && snap.state === PartyPhase.RUNNING) return;
    const key = typeof host.partyModeKey === 'function' ? host.partyModeKey() : null;
    if (key === null) { this.partyRecordSkips += 1; return; }
    if (this.partyRecordLatch === key) return;
    const idx = Object.values(PartyMode).indexOf(key as PartyMode);
    if (idx <= 0) { this.partyRecordSkips += 1; return; }
    /* 演员:裁判优先,其次房主;两者都无 `party` 权限 ⇒ 本帧不建账。 */
    const referee = typeof host.partyReferee === 'function' ? host.partyReferee() : '';
    const candidates: string[] = [];
    if (referee !== '') candidates.push(referee);
    if (this.ownerId !== referee) candidates.push(this.ownerId);
    const actor = candidates.find((id) => this.authorize(id, RoomAction.START_PARTY).allowed);
    if (actor === undefined) { this.partyRecordSkips += 1; return; }
    /* 哨台的模式命令**就是**房间已选模式(同一格 `meta.partyMode`)——
       走 `setPartyModeBy`(唯一写口,自带授权闸),不在这里直写字段。 */
    this.setPartyModeBy(actor, key as PartyMode);
    /* ★ WS-FND-135(P2) 的**副作用修正**:这条派活是**房间自己**发起的,回执被
       `startWorldPartyRun` 丢掉(没有客户端能看见它)⇒ 它**不许**消耗「回执指纹」。

       修前看不出问题:`bus.drain()` 那时在慢帧块**之前**,开局播报要等下一快帧才投递,
       而本函数在**同一个慢帧**里就派了这条活 ⇒ 指纹那一刻还是空的。
       投递点移到帧末之后,播报在同一帧就到了,于是这条内部派活会把开局播报的指纹
       吃掉 —— 客户端**再也拿不到**它(`partyBroadcast` 只在「有新数据」时挂上回执)。
       ⇒ 派活前后把三个指纹原样复原(`dispatchAction` 的其余行为一个字节不改;
       判据见 `tests/WS-FND-135` FND135-6 与 `tests/WS-FND-123` FND123-12)。 */
    const seenFingerprints = {
      broadcast: this.receiptSeenBroadcast,
      settlement: this.receiptSeenSettlement,
      rush: this.receiptSeenRush,
    };
    const res = this.dispatchAction(actor, RoomAction.START_PARTY, { partyMode: key as PartyMode });
    this.receiptSeenBroadcast = seenFingerprints.broadcast;
    this.receiptSeenSettlement = seenFingerprints.settlement;
    this.receiptSeenRush = seenFingerprints.rush;
    if (res.ok) {
      this.partyRecordLatch = key;
      this.partyRecordAdoptCount += 1;
    } else {
      this.partyRecordSkips += 1;
    }
  }

  /**
   * ★ WS-FND-123(P1-2 的另一半):`START_PARTY` 成功 ⇒ **真的开出赛局**。
   *
   * 修前这里零调用 ⇒ 账本建出来了,世界却一场都没跑:`partyPhase()` 恒 `IDLE`、
   * 比分永远为 0、`partySettlement()` 恒 `null`。
   *
   * ⚠️ 幂等守卫:`partyPhase() !== 'IDLE'` 时**不重开** —— `startPartyRun` 每次都会
   * `createPartyContest` 一个新容器,重开等于把正在跑的那一局连同比分丢掉(不报错)。
   */
  private startWorldPartyRun(actorId: string): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.startPartyRun !== 'function') return;
    if (typeof host.partyPhase === 'function' && host.partyPhase() !== 'IDLE') return;
    const snap = partyStateOf(this.id);
    if (snap === null || snap.state !== PartyPhase.RUNNING) return;
    if (host.startPartyRun(String(snap.mode), actorId)) this.partyRecordStartCount += 1;
  }

  /**
   * ★ WS-FND-123(P1-4 / P1-5):**回执出口** —— 把比分播报、终场文案、前三名、
   * 急单 `RUSH_GRADE` 搭在**成功回执**的 `effect` 上。
   *
   * ## 为什么走回执(而不是新开一条下行通道)
   * 客户端只认两条下行:`delta` 二进制包(字段由 `wire.ts` 冻结,房间改不了)
   * 与 `actionResult` 回执(`client/src/net/action_entry.ts` 的
   * `inlinePayload(r.effect)` 会把每个键渲染成一行)。⇒ 在 `effect` 里加键是
   * **不改协议、不动客户端**就能送达的那条路。值域按 `EffectRecord` 只放字符串/数字。
   *
   * ## 为什么带指纹(`receiptSeen*`)
   * 同一条播报/同一份结算在**每次**动作回执里重复出现会被读成「刚刚又发生了一次」。
   * ⇒ 只在世界侧出现**新**数据时挂上去;没有新数据时**一个键都不加**(回执形状不变,
   * 既有 `WS-07`/`WS-FND-*` 的 effect 断言不受影响)。
   */
  private withPartyReceipt(outcome: ActionOutcome): ActionOutcome {
    const host = this.worldSaveHost;
    if (host === null) return outcome;
    const extra: Record<string, string | number> = {};
    if (this.partyBroadcastTotal !== this.receiptSeenBroadcast && this.partyBroadcastOutbox.length > 0) {
      const last = this.partyBroadcastOutbox[this.partyBroadcastOutbox.length - 1]!;
      extra.partyBroadcast = last.text;
      extra.partyBroadcastTotal = this.partyBroadcastTotal;
      this.receiptSeenBroadcast = this.partyBroadcastTotal;
    }
    const view = typeof host.partySettlementView === 'function' ? host.partySettlementView() : null;
    if (view !== null) {
      const fp = `${view.modeName}:${view.broadcastText}`;
      if (fp !== this.receiptSeenSettlement) {
        this.receiptSeenSettlement = fp;
        extra.partyEnd = view.broadcastText;
        extra.partyModeName = view.modeName;
        /* 前三名只对**个人赛**存在(`personal` 有排序);团队赛为空 ⇒ 不加这个键。 */
        if (view.top.length > 0) extra.partyTop3 = view.top.join(' | ');
      }
    }
    const rush = typeof host.rushSettlement === 'function' ? host.rushSettlement() : null;
    if (rush !== null) {
      const fp = `${rush.grade}:${rush.score}`;
      if (fp !== this.receiptSeenRush) {
        this.receiptSeenRush = fp;
        extra.rushGrade = rush.grade;
        extra.rushScore = rush.score;
      }
    }
    if (Object.keys(extra).length === 0) return outcome;
    return { ...outcome, effect: { ...(outcome.effect ?? {}), ...extra } };
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
   * ⚠️ 第 8 项**不在这里逐帧投** —— 它是标量,32Hz × N 人无意义(带宽裁定),
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
   * `CarrySystem` 的容量闸读 `state.players[].level`(经 `carryCapacityOf` ⇒
   * `progression.carryCapacityOfLevel`,与 `statsAtLevel` 同一出处),它**不会**再
   * 自己钳一次 ⇒ 投影越界(level=31)就会让「容量 = 8+30」这类越界值直接生效。
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
    const host = this.worldSaveHost;
    if (host === null || typeof host.maxHpForLevel !== 'function') return null;
    const v = host.maxHpForLevel(playerId, level);
    return v !== null && Number.isFinite(v) ? v : null;
  }

  /** 把派生上限交给 vitals(经世界源;`net` 不认识 `VitalsSystem`)。 */
  private syncMaxHpOf(playerId: string, derivedMaxHp: number): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.syncMaxHp !== 'function') return;
    host.syncMaxHp(playerId, derivedMaxHp);
  }

  /**
   * 第 8 项「总量 ← 明细」重算时**明细从哪来** —— 全类唯一的取法(见 `InventoryDetailSource`)。
   *
   * ## ★★ 第五轮 P1 的修点就在这里
   *
   * 修前:`projectInventoryTotalFor` **只**读 `host.inventoryDetailOf`,而唯一生产宿主
   * (`world_sim.ts:4247`)如实返回 `null` ⇒ **恒**返回 false ⇒「总量按明细重算」这条
   * 契约**在生产上从未执行过**。两处账于是各自维护:
   * ```
   * inventoryTotals  增量式(applyItemTotalDelta:total += Σdelta)
   * itemCounts       明细式(applyItemCountDelta:按件加减)
   * ```
   * 两者今天结果相同,但增量式**漏一帧就永久偏差** —— 正是契约 §2.3(W5 裁定)
   * 要挡的形态;而「按明细重算」这道保险从未上过电。
   *
   * ## 修法:让明细来源**同源**,而不是让宿主编一个明细
   *
   * ```
   * 宿主实现 inventoryDetailOf ⇒ 以世界侧为准(将来背包搬进模拟层时自动生效)
   * 宿主没有(null / 未声明)  ⇒ 退回**本房间按件账** `itemCounts`
   *                            它的唯一写入口 applyItemCountDelta 与总量账
   *                            (applyItemTotalDelta)**吃的是同一批 ops、同一前提**
   *                            ⇒ 两处账同源,重算有真输入
   * 两者都没有                 ⇒ 'none':不重算(fail-closed,见下)
   * ```
   * ⚠️ 为什么**不**改 `world_sim.ts` 去实现 `inventoryDetailOf`:模拟层**确实**
   * 不持有背包明细(那是 `users.inventory_json` / 房间账的事)。让它编一份出来
   * 就是第二份事实源。⇒ 正确的落点是「房间自己的明细账」。
   *
   * ⚠️ 为什么返回**房间账的形状**(`{itemId, quantity}[]`)而不是直接返回 Map:
   * `projectInventoryTotal` 只认 `quantity` 字段(它对 `Record` / `Map` 一概不认),
   * 这里就地翻译成它认的**唯一**形状,免得下游再写一层解析。
   */
  private inventoryDetailSource(userId: string): {
    readonly source: InventoryDetailSource;
    readonly detail: readonly { quantity?: unknown }[];
  } {
    const host = this.worldSaveHost;
    if (host !== null && typeof host.inventoryDetailOf === 'function') {
      const fromHost = host.inventoryDetailOf(userId);
      if (fromHost !== null) return { source: 'host', detail: fromHost };
    }
    const m = this.itemCounts.get(userId);
    if (m === undefined) return { source: 'none', detail: [] };
    const rows: { itemId: number; quantity: number }[] = [];
    for (const [itemId, quantity] of m) rows.push({ itemId, quantity });
    return { source: 'room', detail: rows };
  }

  /**
   * 上一次总量投影的**来源与结果**(诊断;判据用它区分「重算真的跑了」与「静默没跑」)。
   *
   * `null` = 从未跑过。核心一维是 `source`:`'host'` / `'room'` = 重算**有输入**;
   * `'none'` = 两个明细源都没有。第五轮 P1 的形态是「**恒** false 且没有任何地方
   * 看得出它没跑」,本字段就是那个「看得出」。
   */
  lastInventoryProjection: {
    readonly userId: string;
    readonly source: InventoryDetailSource;
    readonly total: number;
    readonly changed: boolean;
  } | null = null;

  /**
   * 第 8 项 `inventory`:总量投影(契约 §2.3 的 W5 裁定)。
   *
   * ## ★★ 方向 = 明细 → 总量,且**重算**而非累加
   *
   * 累加式(`total += delta`)漏一帧就**永久偏差**;
   * 重算式(`total = f(明细)`)任何一帧只依赖当时的明细。
   * ⇒ 故这里**读明细**(经 `inventoryDetailSource`),不读 `inventoryTotals`。
   *   `inventoryTotals` 是纯内存模式下的**退路缓存**,不是本投影的输入。
   *
   * ## 为什么是「变更时」而不是逐帧(契约 §2.3 带宽裁定)
   *
   * 总量是标量,逐帧投 20 次 × N 人无意义。⇒ 调用方只在
   * `applyInventory` 通过后调一次。
   * ⚠️ 但**重算**这一点与频率无关:低频 + 累加式照样会漂(而且更晚发现)。
   *
   * ## `source === 'none'` 时**不重算**(fail-closed,修前是静默 false)
   *
   * 明细源一个都没有 ⇒ 既**不**把总量写成 `0`(那是拿编造的值覆盖增量账),
   * 也**不**假装成功;如实把这一次记进 `lastInventoryProjection`(source `'none'`)。
   * 与修前的差别不是「多一个分支」,而是:**「没有明细」这件事从此可观测**
   * ——修前它与「明细算出来没变化」是同一个返回值 `false`,从外面分不开。
   *
   * @returns 是否发生变更(供调用方决定要不要下发)
   */
  projectInventoryTotalFor(userId: string): boolean {
    const { source, detail } = this.inventoryDetailSource(userId);
    if (source === 'none') {
      this.lastInventoryProjection = {
        userId, source, total: this.inventoryTotals.get(userId) ?? 0, changed: false,
      };
      return false;
    }
    const total = projectInventoryTotal(detail);
    const prev = this.inventoryTotals.get(userId) ?? 0;
    const changed = prev !== total;
    if (changed) this.inventoryTotals.set(userId, total);
    this.lastInventoryProjection = { userId, source, total, changed };
    return changed;
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
   *
   * ★ WS-FND-162(P1):**按 userId 裁剪** —— 只有在**成员表**里的人拿得到快照,
   *   别人拿到的是一份**空包**(= 什么都不发)。判据与理由见方法体里的长注释。
   */
  snapshotFor(userId: string): Uint8Array {
    /* ★ WS-FND-131:此处原本写 `s.seq = this.state.meta.tick` —— 那条 `MemberSession.seq`
       全仓**0 读取**,而且它把**房间帧号**混写进**成员会话**字段(两个时钟混写)。
       字段已删;快照本身按整房编码,逐字节一致性不受影响(见 docblock)。 */
    /* ══════════ ★ WS-FND-162(P1):**按 userId 裁剪**(修前这个参数被忽略)══════════
       ## 修前(实测缺陷)
       签名写的是 `snapshotFor(_userId)` —— 下划线已经声明了「没人用它」,实现是
       无条件的 `encodeFull(整房)` ⇒ **被踢者 / 已离场者**与在场者拿到的东西**逐字节相同**。
       「按人裁剪」这件事在代码里从未存在过(两个装配层都只**读** `res.snapshot`)。

       ## 现在:不在成员表里 ⇒ 返回**空包**
       `Uint8Array(0)` 是本仓既有的「什么都不发」哨兵:`ws_server.ts` 的 `sendBinary`
       遇 0 字节**直接 return** ⇒ 那条连接一个字节都收不到。
       ⚠️ **不许**改成「发一份零实体的合法帧」:客户端会把它读成**一次世界换代**
         (空实体集 = 全删),那比不发更坏。

       ## 判据为什么是「在成员表里」,而**不是** `connected`
       `disconnect()` 是在把席位标成 `connected=false` **之后**才调本方法落盘;
       若判据写成 `connected`,断线那一瞬间这份快照就成了空包 ⇒ **重连快照永远存不进去**,
       而库里只是少一行、没有任何东西会红(本仓反复点名的静默形态)。
       `kick()` / `leave()` 走的是 `purgeSeat()` → `clearSeatTraces()`,它把席位
       **从表里删掉** ⇒ 「被踢 / 离场」与「断线待重连」在**同一张表**上可分。

      ## ★ WS-FND-163(A3):**AOI 级裁剪**(修前是席位级 —— 成员拿到**整房**)
      席位级只回答「他还在不在房里」,答不了「他看得见谁」。修前成员那份仍是
      `encodeFull(整房)` ⇒ 地图另一端的人的血量 / 朝向 / 移动**每帧都进**他的包。

      ## 权威可见性判据**只有一个**:`visibleStateFor(userId)`
      ```text
      席位级:谁在成员表里   ← 本方法下面那一行(`members.has`),唯一实现
      AOI 级:谁在视距内     ← `visibleStateFor`,唯一实现
      ```
      两条判据各只有一处,装配层(Colyseus / 裸 WS)都**不另算距离**:
      它们手上的快照就是这一份。⇒「谁看得见谁」在系统里不存在第二份口径,
      也就不存在「两个投递层各裁一遍、结果不一致」的形态(与 WS-FND-161 / -162
      对席位判据的处置同款)。

      ## 裁剪口径(用**既有** AOI 常量,不新造一个数)
      ```text
      半径 = AOI_WAKE_DISTANCE(32 格,server/src/mobs/aoi.ts)
      距离 = 二维欧氏(x / y;协议与生物唤醒都是 2D ⇒ z 不参与)
      含边界(与 aoi.ts 的 <= 同口径)
      自己恒在(自己那个实体行是排除不掉的:客户端会把自己删掉)
      players / wildlife 按各自的权威坐标判;boss **不裁**(见下一条边界)
      ```
      ## 边界(如实标注,不是遗漏)
      * **boss 不参与裁剪**:线上格式里 `BossState` **没有位置字段**
        (`shared/types/wire.ts` 只有 `telegraphX/Y` —— 那是**地面预警锚点**,
        不是怪的位置)。拿预警锚点当怪的位置是**猜**,会造出第二份事实源 ⇒ 不猜:
        boss 的字段仍然进包;这条边界写在这里,免得下一个人以为裁过了。
      * **没有滞后**(与 aoi.ts 一致):边界上来回横跳会让实体反复进出包,
        那算带宽问题,不算判据问题;要治它得先有一条明确的滞后常量。 */
    if (!this.members.has(userId)) return new Uint8Array(0);
    return encodeFull(this.visibleStateFor(userId), this.state.meta.tick).bytes;
  }

  /**
   * **入场首帧**:整房全量(不按 AOI 裁)。
   *
   * 逐帧广播 `step(prev)` 是**整房**差量、所有连接共用一份;首帧若按 AOI 裁,
   * 视距外的实体在客户端没有基线,之后只收到「动过的字段」⇒ 物种 id 与血量恒为空
   * (屏幕上是一堆 0/0 的无名方块)。首帧必须与差量是同一个范围。
   * `snapshotFor` 的 AOI 口径保留给落盘/重连一致性用;要把 AOI 真做到线上,
   * 得先让差量也按连接裁,那时两处一起改。
   * 席位判据与 `snapshotFor` 相同:不在成员表里 ⇒ 空包。
   */
  joinSnapshotFor(userId: string): Uint8Array {
    if (!this.members.has(userId)) return new Uint8Array(0);
    return encodeFull(this.state, this.state.meta.tick).bytes;
  }

  /* ── 4.6 ★ WS-FND-182:地形下行 ── */

  /**
   * **一步地形下行**:拿调用方**已知的**块版本表,给出「该发的块帧」与
   * 「这一轮之后的当前版本表」。
   *
   * ## 为什么需要它(修前的形态)
   * ```text
   * 客户端:client/src/stage/design_world.ts 在**本地**重算同一张设计图
   * 服务端:WorldGrid 里跑着另一份世界
   * 中间:  shared/net/delta.ts 的三个 chunk 原语**只有单测在用**(线上零下行)
   * ⇒ 玩家盖的墙 / 拆的块在屏幕上永远不出现,而**没有任何东西会红**
   * ```
   * 本方法就是那条缺失通道的服务端半边,它**只做三件事**:
   * ```text
   * 1 读世界侧的块清单(host.terrainChunks,可选成员,缺它 ⇒ 空结果)
   * 2 用 diffChunkVersions(known, current) 算出**只有哪些块变了**
   * 3 只把那些块编成帧(encodeTerrainFrames)⇒ 没有变化时一个字都不编
   * ```
   *
   * ## 节流在哪一层(必须说清,否则下一个人会在这里再加一层)
   * ```text
   * 判据层(本方法):「没有块变」⇒ frames 为空 ⇒ 一个字节都不发
   * 速率层(ws_server):「距上次下发不足 TERRAIN_RESEND_MIN_INTERVAL_MS」⇒ 根本不调;
   *                     「一条连接一轮最多发 TERRAIN_FRAMES_PER_WINDOW 帧」⇒ 队列化
   * ```
   * ⇒ 本方法**不做**任何时间判断(它没有时钟,也不该有:那会长出第二个节流口径)。
   *
   * ## ⚠️ 基线(known)由**调用方**持有,而且是**每连接**一份
   * 断线重连 ⇒ 新连接从 `{}` 起 ⇒ 全量重发一遍(那正是想要的:块没到就是没到)。
   */
  terrainDeltaFor(known: Record<string, number>): TerrainDelta {
    const host = this.worldSaveHost;
    /* 没有世界源 / 老世界源没实现这个读口 ⇒ 空结果(与 `levelOf` 同一 null 契约:
       不报错、也不假装发过)。 */
    if (host === null || typeof host.terrainChunks !== 'function') {
      return { frames: [], versions: {} };
    }

    /* ⚠️ 这一段**必须同步**:`tiles` 是 `Chunk.cells` 本体(不拷贝,见
       `WorldSim.terrainChunks` 的口径 1)⇒ 从读到编完之间不许 await / 让出。 */
    const chunks = host.terrainChunks();
    const versions: Record<string, number> = {};
    const byKey = new Map<string, TerrainChunkInput>();
    for (const c of chunks) {
      const k = terrainChunkKey(c.cx, c.cy);
      versions[k] = c.version;
      byKey.set(k, c);
    }

    const changed = diffChunkVersions(known, versions);
    if (changed.length === 0) return { frames: [], versions };

    const want: TerrainChunkInput[] = [];
    for (const d of changed) {
      const c = byKey.get(terrainChunkKey(d.cx, d.cy));
      /* 理论上一定命中(两段读的是同一份 `chunks`)⇒ 万一没有,宁可少发一块
         也不发一块身份不明的字节。这一条不抛错:它是"读口在两段之间变了"
         那类竞态(真发生时 `versions` 也已经是新的,下一轮会补上)。 */
      if (c !== undefined) want.push(c);
    }
    return { frames: encodeTerrainFrames(want), versions };
  }

  /* ── 4.7 ★ WS-FND-188:静态 NPC 表的**一次性**下发 ── */

  /**
   * NPC 帧 —— `hello`/`welcome` 之后由运输层调**一次**。
   *
   * ## 为什么是一次性的(而不是进每帧快照)
   * ```text
   * NPC 是静态数据:坐标写死在设计图里,没有血量/状态/移动
   * ⇒ 进 20Hz 差量快照 = 每帧白编一份永不变的载荷;
   *   而且要为此给 shared/types/wire.ts 的字段表加一个 EntityKind
   *   (冻结层改动 + 所有按 kind 遍历的判据都要跟着动)。
   * ```
   * ## 为什么不在这里判"该不该发"
   * 「什么时候发」是**连接生命周期**的事(`hello`/`welcome` 那一刻),而本方法没有
   * 连接、也不该有 —— 它只回答"这份表怎么上线"(与 `terrainDeltaFor` 不做时间判断
   * 是同一条纪律:节流/时机住在运输层,免得长出第二个口径)。
   *
   * ## 坐标口径
   * `NpcDef.home` 是**设计图格坐标**,与 `WorldSim` 的格坐标同一套原点
   * (`server/src/npc/defs.ts` 的文件头写了为什么)。这里原样送上去:
   * 客户端用**同一对**数字摆立牌与判距离 —— 两端各换算一次就是"人站在半格外"。
   */
  npcFrame(): Uint8Array {
    const wire: NpcWireDef[] = NPCS.map((n) => {
      const q = n.quest;
      return q === undefined
        ? { id: n.id, name: n.name, x: n.home.x, y: n.home.y }
        : {
          id: n.id,
          name: n.name,
          x: n.home.x,
          y: n.home.y,
          quest: {
            id: q.id,
            title: q.title,
            needItemId: q.needItemId,
            needCount: q.needCount,
          },
        };
    });
    return encodeNpcFrame(wire);
  }

  /**
   * ★ WS-FND-163(A3):**这个玩家看得见的世界** —— 可见性判据的**唯一**实现。
   *
   * ## 为什么返回「一份状态」而不是「一个过滤谓词」
   * 编码器(`encodeFull`)只认 `RoomState`。返回**浅拷贝 + 过滤后的数组**
   * ⇒ 不改编码层(`shared/net/delta.ts`)、不改线上格式,而且「不可见 ⇒ 不发」
   * 在协议上就是**明确定义的**:FULL 报文里没有的实体,客户端按「整体替换」
   * 删掉它(`applyPacket` 的 FULL 分支)—— 实体走进视距时下一帧自然回来。
   *
   * ## 零改动短路
   * 全员可见时**原样返回 `this.state`**(不复制、不过滤)⇒ 常规路径与修前
   * 逐字节相同,这条裁剪对绝大多数帧(大家挤在一起)是零成本的。
   *
   * ## 视野源 = `state.players` 里**自己那一行**
   * 不是世界刚体:两者在客户端预测 / 回滚时会短暂不同,而线上的一切都由
   * `state` 决定(发送端与判据端读同一份坐标,不会互相打架)。
   *
   * ⚠️ 不要在这里加第二层判断(视线 / 阵营 / 隐身):那属于玩法裁决,
   * 加进来就等于长出第二个可见性口径。
   *
   * ⚠️ fail-open:自己在 `state.players` 里没有行(极端:投影尚未跑)⇒
   * 退回**整房**。宁可多发,不静默把人裁成空世界(与 `ws_server.ts#seatAlive`
   * 、`deltaExclusions` 的取舍同款)。
   */
  private visibleStateFor(userId: string): RoomState {
    const state = this.state;
    const me = state.players.find((p) => p.id === userId);
    if (me === undefined) return state;
    const limit = AOI_WAKE_DISTANCE * AOI_WAKE_DISTANCE;
    const near = (x: number, y: number): boolean => {
      const dx = x - me.x;
      const dy = y - me.y;
      return dx * dx + dy * dy <= limit;
    };
    const players = state.players.filter((p) => p.id === userId || near(p.x, p.y));
    const wildlife = state.wildlife.filter((w) => near(w.x, w.y));
    if (players.length === state.players.length && wildlife.length === state.wildlife.length) {
      return state;
    }
    return { ...state, players, wildlife };
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

  /**
   * 签发一张加入凭证(服务端专用入口:登录 / 大厅 / 房主入场 / 断线重连)。
   *
   * ## 旧 `mintToken()` 为什么必须删掉
   * ```ts
   * return `${this.id}-${this.tokenSeq}-${PROTOCOL_VERSION}`;   // ← 旧实现
   * ```
   * 它**格式完全可预测**(房间 id + 递增序号 + 常量)⇒ 任何人徒手就能写出一张"合法"的;
   * 而它又**一次都没被校验过**(全仓 0 处 verify)⇒ 那个 token 只是日志里的装饰。
   * 现在:`member.token` 是**签名过的**凭证,并且 `join` 的入口会校验它
   * (见 `verifyJoinToken`)⇒ 签发与校验是**同一份密钥 + 同一份实现**。
   *
   * `ttlMs` 会被钳到 `[1, JOIN_TOKEN_MAX_TTL_MS]`:调用方传 `Infinity`/负数
   * 不该能造出"永不过期"的凭证(那正是要消灭的形态)。
   */
  issueJoinToken(userId: string, ttlMs: number = JOIN_TOKEN_TTL_MS): string {
    const requested = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : JOIN_TOKEN_TTL_MS;
    const ttl = Math.min(JOIN_TOKEN_MAX_TTL_MS, Math.max(1, requested));
    return signRoomToken(this.authSecret, {
      userId,
      roomId: this.id,
      expiresAtMs: this.clock.nowMs() + ttl,
    });
  }

  /**
   * 校验一张加入凭证,并**核对它声明的 userId** —— 运输层与重连调用的是同一个方法。
   * 失败原因原样往上抛(下游把它当 `reject` 帧的 reason),不吞、不归一化:
   * 「缺 token / 伪造 / 过期 / 房的凭证」是四件事,合成一句就没法指认了。
   *
   * ★ P1-3(2026-11-19):过期判据的**起算点**在重连态下改为断线时刻 ——
   *   由 `reconnectTokenGraceUntilMs(userId)` 提供,口径见
   *   `verifyRoomToken` 的 `expect.expiredOkUntilMs`。
   *   ⚠️ 这里**只**放宽过期(签名/房间/绑定三判据没动),而且只对
   *      **这个 userId 自己**的断线宽限生效 —— 在线成员拿到的是 `undefined`。
   */
  verifyJoinToken(userId: string, token: unknown): RoomTokenVerdict {
    return verifyRoomToken(this.authSecret, token, {
      userId,
      roomId: this.id,
      nowMs: this.clock.nowMs(),
      expiredOkUntilMs: () => this.reconnectTokenGraceUntilMs(userId),
    });
  }

  /**
   * 校验凭证的**签名/房间/有效期**,但不核对 userId 绑定 —— 供「凭证即身份」的入口用。
   *
   * 只有一类调用方该用它:`room.colyseus.ts` 的 `onJoin`。那里的成员键是
   * Colyseus 自己生成的 `client.sessionId`(**服务端产物**,不是客户端串),
   * 没有"客户端声明的 userId"可比对;凭证里的 `userId` 才是身份来源。
   * ⚠️ 裸 WS 路径**不要**用它:那里有 `?userId=` 这个可伪造的声明,必须走
   * `verifyJoinToken`(它会把两者钉在一起)。
   */
  decodeJoinToken(token: unknown): RoomTokenVerdict {
    return verifyRoomToken(this.authSecret, token, {
      userId: '',
      roomId: this.id,
      nowMs: this.clock.nowMs(),
      /* ★ P1-3:这里**没有**客户端声明的 userId 可比对 ⇒ 只能用凭证自己的
         `claims.userId` 去问宽限 —— 回调的参数正是它(见 verifyRoomToken 的
         `expiredOkUntilMs` 注释第 3 条)。 */
      expiredOkUntilMs: (claimedUserId: string) => this.reconnectTokenGraceUntilMs(claimedUserId),
    });
  }

  /**
   * ★ P1-3(2026-11-19):断线中的成员**重连时可用的凭证截止时刻**。
   *
   * ## 口径(全仓唯一一处算它 —— 两处调用点共用)
   * ```
   * 生效值 = min(断线时刻 + JOIN_TOKEN_TTL_MS, 断线时刻 + RECONNECT_GRACE_MS)
   *        = 断线时刻 + 30s(因为 30s < 5min,宽限期总是更紧的那个)
   * ```
   * 直觉版:**凭证的有效期从断线时刻重新起算,但绝不越过重连宽限期的终点**。
   * 前一半修的是「会话超过 5 分钟 ⇒ 手里那张已过期 ⇒ 宽限期内必然被拒」;
   * 后一半保证放宽**不能**比席位本身活得更久(席位一过 30s 就被
   * `reapExpiredDisconnects` 收回,那时这里恒返回 `undefined`)。
   *
   * ## 为什么这样算而不是「断线时换发一张」
   * 服务端在**断线那一刻**没有任何可用的下发通道(客户端已经走了);
   * 装配层只能验客户端递上来的那一张 ⇒ 能改的只有**判据的起算点**。
   * 详见 `verifyRoomToken` 的 `expect.expiredOkUntilMs`。
   *
   * ## 三态(负对照的入口都在这里)
   * ```
   * 没有这个成员 / 已在线 / 没有断线时刻 ⇒ `undefined` ⇒ 过期凭证照旧被拒
   * 断线中且仍在宽限期内              ⇒ 断线时刻 + RECONNECT_GRACE_MS
   * ```
   * ⚠️ `s.disconnectedAtMs === null` 单独判一次是**必须**的:它在类型上
   *   是 `number | null`,直接相加会得到 `NaN`,而 `nowMs >= NaN` 恒为
   *   `false` ⇒ 那会变成一条**无条件的放行**(本仓反复点名的 NaN 形态)。
   */
  reconnectTokenGraceUntilMs(userId: string): number | undefined {
    const s = this.members.get(userId);
    if (s === undefined || s.connected || s.disconnectedAtMs === null) return undefined;
    return Math.min(
      s.disconnectedAtMs + JOIN_TOKEN_TTL_MS,
      s.disconnectedAtMs + RECONNECT_GRACE_MS,
    );
  }

  private spawnPoint(): { x: number; y: number } {
    /* 出生点铺开:第 n 个玩家沿 X 轴排开 1.5 格,避免叠罗汉误触。
       ★ w85:`spawnOrigin` 偏移 —— 设计过的世界里出生点不是地图原点
       (设计图的原点是海,营地在地图中心)。缺省 `{0,0}` ⇒ 与改前逐字不变。 */
    const o = this.spawnOrigin;
    const n = this.state.players.length;
    return { x: o.x + 0.5 + (n % 8) * 1.5, y: o.y + 0.5 + Math.floor(n / 8) * 1.5 };
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
