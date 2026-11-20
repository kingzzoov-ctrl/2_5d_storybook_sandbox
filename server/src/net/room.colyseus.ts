/**
 * WS-07 · Colyseus Room 薄装配层。
 *
 * **业务逻辑不在这里。** 它把 Colyseus 的生命周期回调原样转发给
 * `RoomRuntime`(`./room.ts`,零依赖),因此所有业务逻辑都能在无 colyseus
 * 环境下被单测覆盖。这里的代码量刻意压到最小:
 *
 *   onCreate  → new RoomRuntime(...)  + RoomSchema + **registerHandlers()**
 *   onJoin    → runtime.join()        → 回发全量/断线快照
 *   onLeave   → runtime.disconnect() / runtime.leave()
 *   setSimulationInterval(50ms) → runtime.step() → schema.syncFrom()
 *
 * ✅ 本文件自 2026-11-14(task-95)起**可被 Node 直接加载**
 *   (装饰器 → `defineTypes`、CJS 命名导入 → 默认导出/`import type`),
 *   并由 `tests/WS-FND-12-wiring-paths.test.ts` 的 FND12-8 实测 import + 断言
 *   4 条 handler 在 `onCreate` 里真的被注册。此前它**谁也没法 import**。
 *
 * 关键:**20Hz 差量由我们自己的 delta.ts 负责**,Colyseus 的自动 patch 只当
 * 兜底(通过 `schema.syncFrom` 写值,由 Colyseus 决定是否下发)。
 * 之所以要两套并存:我们的 delta.ts 支持零依赖单测与精确字节预算,
 * 而 Colyseus 的 patch 支持其 WebSocket 层的可靠有序通道。
 */

import colyseusPkg from 'colyseus';
import type { Client, Room as ColyseusRoom } from 'colyseus';
import { RoomSchema, BossSchema, PlayerSchema, WildlifeSchema, assertSchemaReady } from './schema.colyseus.ts';
import { RoomRuntime, RoomRegistry, type RoomRuntimeOptions, type WorldSaveHost } from './room.ts';
import { DT } from '../../../shared/types/physics.ts';
import { AccessMode, writeEvent } from '../db/repo.ts';
import type { DbLike } from '../db/repo.ts';
import { createHost, resolveAssembly } from '../index.ts';
/* ★ P2(2026-11-21):模块级**侧账**的回收口。
   三本账(`chestsByRoom` / `PLACEMENTS` / `ROOM_PETS`,以及炼金订单的预占)住在
   动作层的模块级 Map 里,而它们此前**只**由 `RESET_WORLD` 清(`actions/reset_world.ts`
   的 `forgetRoomSideLedgers`)⇒ 房间销毁(`onDispose`)一遍都不碰:每销毁一间房就漏
   一份(箱子格 / 放置件 / 宠物归属 / 那间房已认领的订单),而房间对象本身早被 GC 了
   —— 谁也不会再把它们删掉。这里在 `onDispose` 里按 roomId 一并清掉。
/* ★ P2(2026-11-21):模块级**侧账**的回收口。
   三本账(`chestsByRoom` / `PLACEMENTS` / `ROOM_PETS`)住在动作层的模块级 Map 里,
   而它们此前**只**由 `RESET_WORLD` 清(`actions/reset_world.ts` 的
   `forgetRoomSideLedgers`)⇒ 房间销毁(`onDispose`)一遍都不碰:每销毁一间房就漏一份
   (箱子格 / 放置件 / 宠物归属),而房间对象本身早被 GC 了 —— 谁也不会再把它们删掉。
   这里在 `onDispose` 里按 roomId 一并清掉。
   ⚠️ 只清**本房间**的键(`forget*` 都是 `delete(roomId)`),别的房间不受影响。
   ⚠️ 炼金订单的预占**不在这里**:它是 `WeakMap`(键是房间 state 对象身份),state 被
   丢掉时自己就没了 —— 那不是「漏一份」,加进来只是多做一次无人受益的清理。
   ⚠️ 别把这几行挪进 `stepTick` 的 `writeEvent` 那一段:那是审计事件口,不是回收点。 */
import { forgetChests } from './actions/open_chest.ts';
import { forgetPlacements } from './actions/place_automation.ts';
import { forgetRoom } from './actions/breed_tame.ts';

/**
 * `Room` 的**运行时值**只能从默认导出上取(`colyseus` 是 CommonJS,根入口没有命名导出):
 * ```
 * import { Room, Client } from 'colyseus'   ✗ SyntaxError: Named export 'Room' not found
 * import * as ns from 'colyseus'            ✗ 实测只有 4 个键,ns.Room === undefined
 * import pkg from 'colyseus'                ✓ 实测 47 个键,typeof pkg.Room === 'function'
 * ```
 * 而 `Client` **连默认导出上都没有运行时值**(实测 `pkg.Client === undefined`;
 * `@colyseus/core/build/index.d.ts` 只有 `export { type Client, ... }`)
 * ⇒ 它只能是 `import type`(运行时擦除),**不能**改写成解构。
 * ⇒ 两者写法不同不是风格问题,是「该符号有没有运行时值」的差别。
 */
const Room: typeof ColyseusRoom = colyseusPkg.Room;

/**
 * **单通道开关(默认关闭 Colyseus patch 同步)。**
 *
 * `true`  = 双通道:`schema.syncFrom()` 写入 Schema,由 Colyseus 自动 patch 下发,
 *           同时我方也 `broadcast('delta', …)`。
 * `false` = 单通道:Schema 仅作为 **Room 元数据容器**(存 roomId / tick / 成员容器),
 *           所有实体同步只走自研 `delta.ts`。
 *
 * 关闭理由:双通道 = **双倍带宽**(16 人 692B/帧 ≈ 13.52 kB/s 已占满合理区间),
 * 且两套 diff 语义在边界情况(实体瞬间增删、Chunk 版本跳变)会互相覆盖 —— 
 * Colyseus 的 patch 与我们的字段级 diff 对「同一帧该发什么」的判断并不等价。
 *
 * 保留装配代码而不物理删除:将来若要做 `reconnection` 快照校验、
 * 或把 Schema 当作服务端状态自省的可视化出口,可以再开。
 */
export const USE_COLYSEUS_PATCH = false;

/**
 * Colyseus 自动 patch 是否应启用。
 * 统一在这里判断,避免各处散落 `if (USE_COLYSEUS_PATCH)`。
 */
export function patchEnabled(): boolean {
  return USE_COLYSEUS_PATCH;
}

/**
 * ★ WS-FND-162(P1):**这一帧该跳过谁** —— Colyseus 装配层唯一的 delta 收件人判据。
 *
 * ## 修前(实测缺陷:与 `WS-FND-161` 是**同一形态的两个层**)
 * ```text
 * stepTick:  if (packet.length > 0) this.broadcast('delta', packet);  ← 房内**所有** client
 * ```
 * `broadcast` 身上没有任何成员判据,而 `kick()`(`room.ts`)只走 `leave()` ——
 * **摘席位、不断连接**:被踢者那条 Colyseus 连接照旧留在 `this.clients` 里,
 * 于是「被踢」在下行上**完全不可见**(他继续收整房 delta)。
 * 运输层(`ws_server.ts`)的同类缺陷已在 WS-FND-161 修掉,而**这一层当时没修** ——
 * 偏偏 B 路(Colyseus 装配)才是 `scripts/play.ts` 真正跑的那条。
 *
 * ## 判据来自**房间**,本层不自己记第二本账
 * `isSeated(seatKey)` = `RoomRuntime.members` 里还有这个人(`room.ts#isSeated`)。
 * 席位被收走的那一刻房间那边就已经是权威 ⇒ 本层**下一帧**跟着裁掉:不需要通知,
 * 也没有第二处状态能漂(反例:在本层另存一个 `kickedClients` 集合,就得在入场 /
 * 重连 / 断线 / 销毁四条路径上都记得清,漏一条就是「被踢者复活」)。
 *
 * ## 三态(与 `ws_server.ts` 的 `seatAlive` **逐条同款**)
 * ```text
 * 在席位表里      ⇒ 收
 * 不在席位表里    ⇒ 裁掉(被踢 / 主动离场 / 入场被拒因而**从未绑座位**)
 * isSeated 自己抛 ⇒ **收**(fail-open)
 * ```
 * 最后一条是刻意的:故障(房间实现坏了)若表现成「这个人收不到帧」,就把
 * 「服务端坏了」伪装成「网络静了」——本仓反复点名的静默形态。
 *
 * ## 为什么取键必须走 `seatKeyOf` 而不是 `client.sessionId`
 * 带凭证入场的成员键是**凭证里的 userId**,不带凭证的才是 `sessionId`
 * (口径见 `bindSeat`)。若在这里直接拿 `sessionId` 去查房间,前者恒查不到
 * ⇒ 带凭证的人会被**整片**裁掉(修好的缺陷换个方向复发)。故调用方传的
 * 取键函数必须与 onJoin / onLeave / onMessage **同一处**。
 *
 * ## 为什么返回**排除集**而不是收件人集
 * 生产路径用 Colyseus 官方的 `broadcast(type, msg, { except })`:它把报文
 * **编码一次**再发给其余客户端;自己循环 `client.send` 会让同一份字节被逐客户端重编码。
 */
export function deltaExclusions<C extends { sessionId: string }>(
  clients: readonly C[],
  seatKeyOf: (client: C) => string,
  isSeated: (userId: string) => boolean,
): C[] {
  const out: C[] = [];
  for (const client of clients) {
    let seated: boolean;
    try {
      seated = isSeated(seatKeyOf(client)) === true;
    } catch {
      /* 见上面「三态」:房间实现坏了**不许**伪装成「这个人静音」。 */
      seated = true;
    }
    if (!seated) out.push(client);
  }
  return out;
}

export interface NetPersistRoomOptions {
  clock: { nowMs: () => number };
  db: DbLike | null;
  /**
   * ★ WS-FND-134(P1-2):日志出口(**注入式**)。
   *
   * 省略时默认写 `console.error`(见 `logLine`)—— 不是 no-op。
   * 为什么放在 options 而不是直接读 `process.env`:注入让测试能**断言**
   * 「被拒时真的有一行日志」(否则"有没有出口"只能靠读代码)。
   */
  onLog?: (msg: string) => void;
  /**
   * 房主(玩家)id —— 喂给 `RoomRuntimeOptions.ownerId`,用于权限判定。
   *
   * ★ task-76 订正:本字段**此前叫 `registryOwnerId`**,已改名为 `ownerId`。
   *
   * ## 为什么改名:同一语义字段不能有两个名字
   *
   * 两条装配路径都在给**同一个契约字段** `RoomRuntimeOptions.ownerId` 赋值:
   * ```
   * A 路 index.ts:191        ownerId: deps.ownerId ?? 'u_owner'
   * B 路 room.colyseus.ts    ownerId: this.deps?.registryOwnerId ?? 'u_owner'
   *                                              ^^^^^^^^^^^^^^^ 名字不同
   * ```
   * 判据是「同一语义字段,两个来源,必有一处是错的 —— 除非它们本就是两件事」。
   * 实测它们**就是同一件事**,三条证据:
   * ```
   * 1 两者最终都落进 `new RoomRuntime(rtOpts, …)` 的同一个键 `ownerId`
   *   (room.ts:277 声明;room.ts:825 `this.ownerId = opts.ownerId`);
   * 2 该值用途唯一:room.ts:966 `input.userId === this.ownerId` ⇒ 判 OWNER 角色,
   *   以及 :1187/:1202 的两条「不能改房主 / 不能踢房主」—— 都是**玩家**身份;
   * 3 `bootstrap()`(room.ts:2151-2156)拿 ownerId 去 `createUser(db, {id: ownerId})`
   *   ⇒ 它就是一个**用户 id**,不是「注册表的运维者」。
   * ```
   * ## 为什么 `registryOwnerId` 是**误导**而非「另一种说法」
   * ```
   * `RoomRegistry` 自身**没有** ownerId 字段 —— 它的 options 只有
   *   clock / db / onEvict(room.ts:2076-2081),内部存 Map<string, RoomRuntime>;
   * ownerId 是 `registry.create({roomId, ownerId})` 的**入参**,
   *   随即原样转交 RoomRuntime ⇒ 它始终是**房间的** ownerId。
   * ```
   * ⇒ 名字里的 `registry` 暗示「注册表层特有的 owner」,而**并不存在**那样东西。
   *   全仓 `registryOwnerId` 只有 2 处(本文件的声明与使用),`withDeps` 调用点 0 处
   *   ⇒ 改名不触及任何调用方(零风险),且让两条路的字段名**逐字相等** ——
   *   这正是 FND9-9 对 `rtOpts` 键集要求的同一条纪律。
   */
  ownerId: string;
  /**
   * 世界源(US2 装配位)。**由调用方构造**并传进来。
   *
   * ## 为什么类型是 `WorldSaveHost` 而不是具体的模拟层
   *
   * `WorldSaveHost` 是 `room.ts` 里的**结构化接口**(只声明房间用到的方法),
   * 所以这里引用它**不引入任何新的依赖边** —— `room.colyseus.ts` 本就
   * `import './room.ts'`。若改成 import `WorldSim` 类型,就等于在装配层
   * 硬绑模拟层,并把 `scripts/backlog.ts` 的 US2 探针**误报为已开**。
   *
   * ## ★ 2026-11-14:B 路**已经有 host 了**(此段原结论「依然保持 null」已过期)
   *
   * 原结论的论据链是:
   * ```
   * task-57 之前:index.ts 不存在 ⇒ 没有任何东西能构造 host
   * task-57 之后:index.ts 存在,但它**不经过本文件** ——
   *              它自己 new RoomRuntime(rtOpts, db),与本文件是两条平行装配路径
   * ⇒ 本参数在生产里依然是 undefined ⇒ host 依然保持 null
   * ```
   * 前三行**都还对**,只有**最后一行**错了 —— 它默认了「没有注入者 ⇒ 只能是 null」。
   * 而 `createHost()` 就在 `index.ts` 里、且**不依赖本文件**(index.ts 刻意只装到
   * `RoomRuntime` 这一层,不碰 Colyseus)⇒ 本文件可以**单向** import 它。
   * ⇒ 现在走 `resolveRoomHost(this.deps)`:没注入就自己构造。这就是本条的修法。
   *
   * ⚠️ **仍不要把两句合成一句**:
   *   · 「两条装配路径并存」**没变** —— A 路与 B 路各自 `new RoomRuntime`;
   *   · 变的只是「两条路现在都有世界」。
   *   `WS-FND-12` 为此保留了一整套断言,把「谁接上了、怎么接的、哪一态仍是 null」
   *   逐条钉住;把它简化成一句会立刻红。
   *
   * ⚠️ 也**不要**因此以为 `withDeps` 可以删:它是**注入**通道(测试与部署层要指定
   *   自己的 host)。它仍无调用点,但那**不再等于**「B 路无世界」——
   *   见 `WS-FND-12` 的 FND12-4(它继续钉住「谁在注入」这个事实)。
   *
   * ⇒ ★ 教训:一句「因为 X 所以 Y」里,**X 会过期而 Y 未必过期**。
   *   而这一条更刁:过期的既不是 X 也不是 Y,是**从 X 到 Y 的那一步推理**
   *   (「没有注入者 ⇒ 只能是 null」)—— 那种过期**换论据也修不掉**,
   *   只能等有人真的去把能力接上。
   */
  host?: WorldSaveHost | null;
  /**
   * **部署层显式收紧**:为 `true` 时 `onJoin` 不接受"没有凭证"的入场
   * (默认 `false` = 沿用 Colyseus 的服务端 `sessionId`,理由见 `onJoin`)。
   *
   * ⚠️ 刻意**不**写进 `onCreate` 的 `rtOpts` 字面量:那里有一份与
   * `index.ts` 的 `assemble()` **逐键比对**的断言(`WS-FND-09` FND9-9),
   * 而 A 路这次不改 ⇒ 往 B 路的 rtOpts 加一个 A 路没有的键会让那条断言红
   * (它抓的是"两份装配分叉",这里并不分叉 —— 强制与否是**入口**的事,
   *  不是房间运行时的事,故它停在 `onJoin` 这一层)。
   */
  requireJoinToken?: boolean;
}

/**
 * 解析 B 路的 `rtOpts.host` —— **B 路唯一的 host 判断点**。
 *
 * ## 为什么必须是这个函数,而不是留在 `onCreate` 的字面量里
 *
 * 原实现写 `host: this.deps?.host ?? null`。那一行**没法被断言**:它只存在于
 * 一个生命周期回调内部,而回调用 Colyseus 的服务器上下文才跑得到。
 * 于是「B 路 host 恒为 null」这件事**活过了整整一轮**,只以注释 + 一条
 * 「源码态正则」断言(`WS-FND-12` 的 FND12-3)的形式存在。
 * ⇒ 抽成纯函数 ⇒ 可以直接调用、直接断言(见 `WS-FND-12` 的 FND12-3b)。
 *
 * ## 默认值为什么是 `createHost()` 而不是 `null`
 *
 * `HANDOVER` §7.3 的第一层缺口写的是「B 路仍无世界」。而
 * `server/src/index.ts` 早就有 `createHost()`:它返回**显式标注为**
 * `WorldSaveHost` 的实现 —— 少了 `saveToDb` / `attackMobAuthorized` / `levelOf`
 * 任何一个都会**编译期**报错。缺的从来不是能力,是**没人构造**。
 *
 * ## 依赖方向是单向的(这一点决定了它可行)
 *
 * `index.ts` 的 docblock 记载「本文件一旦 import `room.colyseus.ts`,本文件立刻
 * 不可加载」—— 那说的是**反方向**。这里是 `room.colyseus.ts → index.ts`,
 * 而 `index.ts` **不依赖 Colyseus**(它刻意只装到 `RoomRuntime` 这一层)。
 * 实测:改完两条入口仍各自 `LOADED`(由门禁的「入口可加载」逐条验)。
 *
 * ## 三态,不是两态
 *
 * ```
 * 没有 deps / deps 里没有 host 键 ⇒ createHost()      ← 生产默认
 * deps.host === null(键在、值为 null) ⇒ null         ← **显式关闭**
 * deps.host 有值                      ⇒ 用它          ← 注入
 * ```
 * 中间那一态是**负对照的入口**:`tests/WS-07.test.ts` 的 K1 用 `host: null`
 * 证明「没有 host 时 `saveToDb`/`levelOf`/`attackMobAuthorized` 三处整段跳过」。
 * 把它一起"修好",那条负对照就再也构造不出缺陷了。
 */
export function resolveRoomHost(deps?: NetPersistRoomOptions): WorldSaveHost | null {
  if (deps === undefined) return createHost();
  if ('host' in deps) return deps.host ?? null;
  return createHost();
}

/**
 * B 路的**库**解析 —— 与 A 路(`assemble()`)用**同一套**规则(见 `index.ts` 的
 * `resolveAssembly`)。
 *
 * 改这里的理由:此前是 `this.deps?.db ?? null`。那行在「生产默认」这一支上
 * 与 A 路**不等价** —— A 路给了 `dbPath` 就会开真库,B 路无论如何都 `null`。
 * 同一语义两种答案,迟早会漂;现在两支都走同一处解析。
 *
 * 三态与 `resolveRoomHost` 对齐:
 *   没有 deps          ⇒ 走 `resolveAssembly()`(今天得到 `db: null` —— 见那边的注释)
 *   `db: someDb`       ⇒ 用它
 *   `db: null`(键在)  ⇒ 显式不落盘(负对照入口,别"修"它)
 */
export function resolveRoomDb(deps?: NetPersistRoomOptions): DbLike | null {
  if (deps === undefined) return resolveAssembly().db;
  return deps.db ?? null;
}

export type RoomCreateOptions = {
  roomId?: string;
  name?: string;
  accessMode?: AccessMode;
  passwordHash?: string | null;
  maxPlayers?: number;
  worldSeed?: number;
};

/** Colyseus 房。所有业务都委托给 `runtime`。 */
export class NetPersistRoom extends Room<RoomSchema> {
  private runtime!: RoomRuntime;
  private deps!: NetPersistRoomOptions;
  private lastBroadcastState: ReturnType<RoomRuntime['cloneState']> | null = null;

  /**
   * ★ P1-1(2026-11-19):**连接 → 成员键**的绑定表(`Colyseus sessionId → 成员键`)。
   *
   * 建表/拆表/取键三件事都收敛在 `bindSeat` / `seatKeyOf` / `unbindSeat`
   * 三个方法里(缺陷形态与修法见 `bindSeat` 的长注释)。
   */
  private seatKeys = new Map<string, string>();

  /* ── ★ WS-FND-134(P2):留证字段 → 日志出口(见 noteRuntimeEvidence) ──
     三个字段记的是「**最近一次**」错因 ⇒ 必须记住「上一次已经报过的那一条」,
     否则 20Hz 的 stepTick 会把同一行刷 20 次(噪声会让人关掉日志 —— 那等于又回到静默)。 */
  private loggedRestoreError: string | null = null;
  private loggedRemoveError: string | null = null;
  private loggedJoinAudit: RoomRuntime['lastJoinAudit'] = null;

  /**
   * ★ WS-FND-134(P1-2):装配层(B 路)的**日志出口**。
   *
   * 修前:本文件一个日志出口都没有(A/B 两条装配路径里,B 路发生的事 ——
   * 凭证被拒 / 入场失败 / 读档坏了 —— 在生产**没有任何痕迹**)。
   *
   * 现在:
   *   注入 deps.onLog(部署层可接管)⇒ 默认写 console.error,**不静默**
   *   行首带类别标签 `[room:<cat>]`(结构化,便于筛选与断言)
   *
   * ⚠️ 出口自己抛不许把房间带崩(宽容 catch,与断开路径同一纪律)。
   */
  private logLine(cat: string, msg: string): void {
    const line = `[room:${cat}] ${msg}`;
    const sink = this.deps?.onLog;
    if (typeof sink === 'function') {
      try { sink(line); return; } catch { /* 出口抛不许把房间带崩 */ }
    }
    try { console.error(line); } catch { /* 控制台不可用时不抛 */ }
  }

  /**
   * ★ WS-FND-134(P2):把 RoomRuntime 的三个**留证字段**接上日志出口。
   *
   * 缺陷形态(第九轮实测):lastRestoreError / lastRemoveError / lastJoinAudit
   * 在 room.ts 里被认真写入(每处都配有「不许静默」的长注释),但**生产侧 0 个读点**
   * —— 只有测试读它们。⇒ 运行期真的发生「读档坏了 / 世界侧移除失败」时,
   * 注释承诺的可观测**只对测试成立**,而生产里没有任何出口。
   *
   * 为什么放在 stepTick 而不是各自的发生点:
   *   发生点都在 room.ts(不是本层),而「写日志」是装配层的事;
   *   stepTick 是唯一每帧都会跑的本层方法 ⇒ 它保证「只要发生了,下一帧就被搬出来」,
   *   且不必在 room.ts 里塞回调(那会让房间反向依赖装配层)。
   */
  private noteRuntimeEvidence(): void {
    const rt = this.runtime;
    if (rt.lastRestoreError !== null && rt.lastRestoreError !== this.loggedRestoreError) {
      this.loggedRestoreError = rt.lastRestoreError;
      this.logLine('restore', rt.lastRestoreError);
    }
    if (rt.lastRemoveError !== null && rt.lastRemoveError !== this.loggedRemoveError) {
      this.loggedRemoveError = rt.lastRemoveError;
      this.logLine('remove', rt.lastRemoveError);
    }
    /* ⚠️ 入场审计用**引用**比较(每一次入场都是新对象):内容比较会每帧做一次
       序列化,而它对本判据没有增量(同一个对象不会变)。 */
    if (rt.lastJoinAudit !== null && rt.lastJoinAudit !== this.loggedJoinAudit) {
      this.loggedJoinAudit = rt.lastJoinAudit;
      const a = rt.lastJoinAudit;
      this.logLine('join-audit',
        `user=${a.userId} members=${a.members} state=${a.state} world=${a.world}`);
    }
  }

  override onCreate(options: RoomCreateOptions): void {
    assertSchemaReady();
    this.maxClients = Math.min(16, Math.max(1, options.maxPlayers ?? 16));
    this.setState(new RoomSchema());

    /* 单通道:关掉 Colyseus 的自动 patch 定时器。
     *
     * ★ task-76 实测订正:`this.patchRate = null` **关不掉**。
     *   此前这里写的是**直接赋属性**,并注释说它是「官方开关」—— 两句都不对。
     *
     * ## 实测(读 @colyseus/core 0.15.57 的 build/Room.js)
     *
     * ```
     * constructor L84       this.setPatchRate(this.patchRate)   ← patchRate 默认 50ms
     *                       ⇒ setPatchRate 内部 setInterval(broadcastPatch, 50)
     * setPatchRate  L177    this.patchRate = milliseconds;
     *               L179    if (this._patchInterval) { clearInterval(...); _patchInterval = undefined }
     *               L183    if (ms !== null && ms !== 0) { _patchInterval = setInterval(...) }
     * broadcastPatch L267   **完全不读 this.patchRate**
     * ```
     *
     * ⇒ 「关掉」这件事**只发生在 `setPatchRate` 内部的 clearInterval**。
     *   直接写 `this.patchRate = null` 只是改了个**没有被读的字段**,
     *   构造器建的那个 50ms 定时器**继续跑**,照旧周期性调 `broadcastPatch()`。
     *
     * ## 运行期证据(探针 `_t76_timer.ts`,子类覆写 `broadcastPatch` 计数)
     *
     * ```
     * A 组 直接赋 patchRate = null    : 260ms 内 broadcastPatch 被调 4 次  ★ 没关掉
     * B 组 setPatchRate(null)(官方)   : 260ms 内被调 0 次                  ✓ 真关掉
     * C 组 完全不碰(默认 50ms)       : 260ms 内被调 4 次  ← 与 A 组同值
     * ```
     *
     * ⇒ C 组与 A 组**同为 4 次**是这条证据的关键:它说明 A 组的定时器
     *   与「根本没关」的运行状态**无法区分**。若不实测,只看 `patchRate` 字段
     *   变没变(它确实变成了 null),会得出「已关闭」的相反结论。
     *
     * ⇒ 故这里改为调用官方关闭入口 `setPatchRate(null)`。 */
    if (!patchEnabled()) {
      this.setPatchRate(null);
    } else {
      this.setPatchRate(DT * 1000);
    }

    const roomId = options.roomId ?? this.roomId;
    const rtOpts: RoomRuntimeOptions = {
      roomId,
      ownerId: this.deps?.ownerId ?? 'u_owner',
      clock: this.deps?.clock ?? { nowMs: () => Date.now() },
      name: options.name,
      accessMode: options.accessMode ?? AccessMode.PUBLIC,
      passwordHash: options.passwordHash ?? null,
      maxPlayers: this.maxClients,
      worldSeed: options.worldSeed,
      /* US2 装配位:世界源经构造参传入。
         ★ 2026-11-14:`?? null` 已换成 `resolveRoomHost(this.deps)` ——
         B 路**不再是「恒为 null」**。三态语义见那个函数的注释:
           没有 deps / 没有 host 键 ⇒ 生产默认 `createHost()`
           `host: null`(键在、值为 null)⇒ 显式关闭(负对照入口,别"修"它)
         ⚠️ 仍**不是**「两条路合并」:A 路(`index.ts` 的 `assemble()`)与
         B 路(本文件)各自构造一份 `RoomRuntime`,这一条没变、也不该顺手变。
         变的只是:**两条路现在都有世界**。 */
      host: resolveRoomHost(this.deps),
    };
    /* ★ 库的解析统一走 `resolveRoomDb`(与 A 路同一套规则)。
       ⚠️ 生产里 `this.deps === undefined` ⇒ `resolveAssembly().db` ⇒ 今天仍是 `null`
       ⇒ **落盘/读档不跑**。这是已知边界,不是遗漏:缺的是「库从哪来」的裁决,
       而不是这一段接线(见 `index.ts` `resolveAssembly` 的注释)。 */
    this.runtime = new RoomRuntime(rtOpts, resolveRoomDb(this.deps));

    /* ★ 报文入口的**唯一**注册点(task-95 补)。
     *
     * 位置的理由(两句话都是硬条件,不是风格):
     *  1 必须在 `this.runtime` 建好**之后** —— 4 条 handler 的第一句都是
     *    `this.runtime.<fn>(...)`,注册时虽不读它,但**收到报文时**必读;
     *  2 必须在**第一次可能收到报文之前** —— Colyseus 只在该房 `onCreate`
     *    返回之后才会把客户端交给它(先是 `onJoin`,再是任意 `onMessage`)。
     *    放在这里 ⇒ 早于 `onJoin`、早于任何报文;若挪到 `onJoin` 里,
     *    重连/并发入场时先到的那条报文会被**静默丢弃**(onMessage 无 handler
     *    时 Colyseus 不报错)。
     *
     * ⚠️ 为什么值得专门写这段:实测本方法此前**全仓 0 调用点**(仅 :316 的声明)
     *    ⇒ 4 条 handler 从未注册 ⇒ 玩家按得动、客户端也发得出去,
     *    但服务端**永远收不到** move / attack / inventory / action。
     *    而「不可加载」掩盖了这件事 —— 文件加载不了,讨论 handler 注册无从谈起。 */
    this.registerHandlers();

    /* 20Hz 权威帧。 */
    this.setSimulationInterval(() => this.stepTick(), DT * 1000);
  }

  /** 注入时钟 / 数据库(由 index.ts 在创建房间前调用)。 */
  withDeps(deps: NetPersistRoomOptions): this {
    this.deps = deps;
    return this;
  }

  /**
   * ★ P1-1(2026-11-19):**席位键** —— 装配层里**唯一**一处决定「拿哪个串去调 runtime」。
   *
   * ## 缺陷形态(修前,三处调用点都是同一个错串)
   *
   * (下列行号是**修前那一版**的;修完后这三处都经本方法取键)
   * ```
   * onJoin      :361-368   userId = 凭证里的 userId(带 token 入场者)   ← 成员键
   * onLeave     :393       this.runtime.leave(client.sessionId)         ← 另一个串
   * onMessage   :439/449/483/510  applyMove(client.sessionId, ...)      ← 同一个错串
   * ```
   * `sessionId` 是 Colyseus **服务端生成**的连接号,而凭证里的 `userId` 是
   * 身份来源 —— 两者**逐字不同** ⇒ 带凭证入场的人身上会同时发生两件事:
   * ```
   * 1 席位/连接旁表**永不回收**:`leave(sessionId)` 在 `members` 里查不到
   *   (`:1622` 的 `members.get` = undefined)⇒ 直接 `return false`
   *   ⇒ 房间根本不知道有人在退房,人走了席位还在、重连也拿不到 resumed;
   * 2 输入**整条落空**:`applyMove(sessionId, ...)` ⇒ 反作弊里没有这个 id
   *   (`anticheat.ts:1113` 的 `states.get(playerId)` = undefined)
   *   ⇒ `allowed:false` ⇒ 客户端每帧收到一条 `correct`,
   *     外部表现是「WASD 按了没反应」,而服务端**不报任何错**。
   * ```
   * ⚠️ 这正是本仓反复记的形态:**两个名字指同一件事,而只有一个是对的**。
   *   它不会自己暴露:两条路径各自的局部断言(「凭证验过了」「handler 注册了」)
   *   都还是绿的。
   *
   * ## 为什么是「绑定表 + 统一取键」,而不是二选一
   * ```
   * 把成员键统一成 sessionId ⇒ 房主(u_owner)永远进不来:
   *   room.ts 判 OWNER 靠 `input.userId === this.ownerId`(:1486),
   *   而 sessionId 不可能等于 'u_owner' ⇒ 房主凭证白验(见 onJoin 的威胁模型);
   * 把成员键统一成凭证 userId ⇒ 无 token 的存量客户端没有 userId 可当键
   *   (`onJoin` 明写「无 token ⇒ 行为不变」)。
   * ```
   * ⇒ 键的**取值规则不变**(有凭证 ⇒ 凭证的 userId;没凭证 ⇒ sessionId),
   *   变的是「三条路径都经同一个函数取它」—— 于是不可能再分叉。
   *
   * ## 三条路径的一致性(逐条)
   * ```
   * onJoin     :入场成功后 bindSeat(sessionId, userId);
   * 重连       :Colyseus 侧是**新连接**(新 sessionId)⇒ 再次 onJoin
   *            ⇒ 表里旧键由 bindSeat 顺手拆掉(一名成员只留一条绑定),
   *              新键指向**同一个** userId ⇒ 席位走 room.ts 的 resumed 路径;
   * onLeave    :unbindSeat(sessionId) 拿到键**并**拆掉旁表 ⇒ leave/disconnect
   *            (修前旁表在这里永不回收,正是缺陷的一半);
   * onMessage  :seatKeyOf(client) ⇒ 与上面两条**同一个**键。
   * ```
   */
  private bindSeat(sessionId: string, userId: string): void {
    /* ★ 同一成员只该有一条活连接(`room.ts` 的 join 对在线者直接回
       「该用户已在线」,不会走到这里)⇒ 先把它的旧绑定拆掉,免得重连换了
       sessionId 之后旧键永远留在表里(那会让「旁表不回收」的形态复活,
       只是换了个地方)。 */
    for (const [sid, uid] of [...this.seatKeys]) {
      if (uid === userId && sid !== sessionId) this.seatKeys.delete(sid);
    }
    this.seatKeys.set(sessionId, userId);
  }

  /** 取本条连接该用的成员键(规则与理由见 `bindSeat` 的长注释)。 */
  private seatKeyOf(client: Client): string {
    return this.seatKeys.get(client.sessionId) ?? client.sessionId;
  }

  /** 拆掉本条连接的绑定并**回传**它的成员键(`onLeave` 用)。 */
  private unbindSeat(sessionId: string): string {
    const key = this.seatKeys.get(sessionId) ?? sessionId;
    this.seatKeys.delete(sessionId);
    return key;
  }

  /**
   * 入场。**身份与鉴权(审计 P0-1)**:
   *
   * ## 这一条路径的威胁模型与裸 WS **不同**,必须明说
   * ```
   * 裸 WS(ws_server.ts):成员键来自握手 URL 的 ?userId= ⇒ **客户端可控**
   *                       ⇒ 必须强制凭证(那里已经强制了)
   * Colyseus(client.sessionId):键由**服务端**生成 ⇒ 客户端冒充不了任何人
   *                       ⇒ 问题是反的:房主(u_owner)反而**永远进不来**
   * ```
   * ⇒ 这里的修法不是"也强制一张凭证"(那只会把 `WS-FND-50` 那套真网关夹具全部判死,
   *   而它测的是装配层,不是鉴权),而是:**给了凭证就必须验过,并按凭证认人**。
   * ```
   * 无 token            ⇒ 行为不变(成员键 = client.sessionId)         ← 存量兼容
   * 有 token 且验签通过 ⇒ 成员键 = **凭证里的 userId**(于是房主能是房主了)
   * 有 token 但验签失败 ⇒ client.leave(4001) + 不上席位                ← 不静默降级
   * deps.requireJoinToken === true ⇒ 无 token 也拒(部署层可显式收紧)
   * ```
   * ⚠️ 那条"不静默降级"是关键:伪造的凭证如果被当成"没给凭证"放过去,
   *   就等于"客户端决定服务端怎么解读它的输入"(CR-14 U1 同形)。
   *
   * ## ★ P1-1(2026-11-19):入场成功之后,**键必须跟着凭证走**
   * 上面那段决定的是「这次入场算谁」;而同一次入场之后,离开 / 报文 /
   * 重连三条路径**必须**用**同一个键**。修前只有本方法用凭证的 userId,
   * 另外三处用 `client.sessionId` ⇒ 席位不回收、输入全落空 ——
   * 形态、后果与修法见 `bindSeat` 的长注释(它是本装配层唯一的取键口径)。
   */
  override onJoin(client: Client, options: { passwordHash?: string; asGuest?: boolean; token?: string }): void {
    const token = typeof options?.token === 'string' && options.token.length > 0
      ? options.token : undefined;
    /* 默认身份 = Colyseus 的服务端 sessionId(不可被客户端指定)。 */
    let userId = client.sessionId;
    if (token !== undefined) {
      const verdict = this.runtime.decodeJoinToken(token);
      if (!verdict.ok) {
        /* ★ WS-FND-134(P2/P5):凭证被拒要带**档位**(TOKEN_EXPIRED / TOKEN_SIGNATURE / ...)
           且**必须出声**。修前只有一句 `client.leave(4001, verdict.reason)` ⇒
           客户端只知道"被踢了",服务端一个字都不留。 */
        this.logLine('join-reject', `code=${verdict.code} user=${userId} reason=${verdict.reason}`);
        client.send('reject', { kind: 'JOIN', code: verdict.code, reason: verdict.reason });
        client.leave(4001, verdict.reason);
        return;
      }
      userId = verdict.claims.userId;
    } else if (this.deps?.requireJoinToken === true) {
      this.logLine('join-reject', `code=TOKEN_MISSING user=${userId} 本房要求加入凭证`);
      client.send('reject', { kind: 'JOIN', code: 'TOKEN_MISSING', reason: '缺少 token(本房要求加入凭证)' });
      client.leave(4001, '缺少 token(本房要求加入凭证)');
      return;
    }
    const res = this.runtime.join({
      userId,
      passwordHash: options?.passwordHash ?? null,
      asGuest: options?.asGuest ?? false,
      /* 有凭证 ⇒ 让房间**再验一次**(同一份实现、同一把密钥:签发与校验收敛在一处);
         无凭证 ⇒ 不强制(见上面的威胁模型说明)。
         ★ P1-3(2026-11-19):这一步与上面 `decodeJoinToken` 是**同一口径** ——
         断线宽限期内「过期」按**断线时刻**起算(`reconnectTokenGraceUntilMs`),
         故会话超过 5 分钟的人掉线后仍能在 30s 内重连;修前它必然被拒,
         而拒因写的是「token 已过期」(看起来像客户端的问题)。 */
      token,
      requireToken: token !== undefined,
    });
    if (!res.ok) {
      /* ★ WS-FND-134(P2/P5):把房间给出的**档位**原样带回客户端(修前只有散文)。 */
      const code = res.code ?? 'JOIN_REJECTED';
      const reason = res.reason ?? 'join rejected';
      this.logLine('join-reject', `code=${code} user=${userId} reason=${reason}`);
      client.send('reject', { kind: 'JOIN', code, reason });
      client.leave(4000, reason);
      return;
    }
    /* ★ WS-FND-131(P1):**装配层的交叉核对** —— `runtime.join()` 说 ok,
       就必须**真的**在席位上。两者不一致(= runtime 侧已回滚,或将来有人让
       join 返回 ok 却没落席位)时,这条连接**什么都不该做**:它会继续发 move /
       attack,而服务端每一条都会落空(反作弊查无此人),外部表现是「连上了但
       按键没反应」—— 那正是本仓反复记的「静默成功」形态。
       ⇒ 出声拒绝(4002),并且**不建绑定**(否则旁表会留下一条房间从没收过的键)。 */
    if (!this.runtime.isSeated(userId)) {
      this.logLine('join-reject', `code=RUNTIME_NOT_SEATED user=${userId}`);
      client.send('reject', { kind: 'JOIN', code: 'RUNTIME_NOT_SEATED', reason: '入场未生效' });
      client.leave(4002, '入场未生效(runtime 侧没有这个席位,已按失败处理)');
      return;
    }
    /* ★ P1-1:入场**成功之后**才建绑定 —— 被拒的连接不许在表里留键,
       否则 `unbindSeat` 会把一个房间从没收过的 userId 交给 leave/disconnect。 */
    this.bindSeat(client.sessionId, userId);
    /* ★ WS-FND-134(P1-2):入场**成功**也要留一行 —— 修前装配层只在失败时
       `client.leave()`,成功路径上一个字都没有 ⇒ "他到底进没进来"只能靠客户端说。
       这里带上三方交叉校验结果(`lastJoinAudit`),而 errors 由 stepTick 搬出去。 */
    this.logLine('join', `入场 ok user=${userId} resumed=${res.resumed === true}`
      + ` audit=${JSON.stringify(this.runtime.lastJoinAudit)}`);
    /* 入场报文:全量快照(重连时是逐字节一致的恢复快照)。 */
    if (res.snapshot) client.send('snapshot', res.snapshot);
    this.schema().syncFrom(this.runtime.cloneState());
  }

  override onLeave(client: Client, consented?: boolean): void {
    /* ★ P1-1:键必须经过 `unbindSeat` —— 修前这里写死 `client.sessionId`,
       而带凭证入场者的成员键是**凭证里的 userId** ⇒ `leave()`/`disconnect()`
       查不到人,席位与连接旁表**都不回收**(形态见 `bindSeat`)。
       它同时负责拆表:`onLeave` 是连接消失的那一点。 */
    const key = this.unbindSeat(client.sessionId);
    /* 主动退房直接回收;异常断开保留 30 秒宽限。 */
    if (consented) this.runtime.leave(key);
    else this.runtime.disconnect(key);
  }

  override onDispose(): void {
    /* ★ P1-1:房间销毁 ⇒ 连接旁表一并清掉(席位表由 `runtime.close()` 负责)。 */
    this.seatKeys.clear();
    this.runtime.close();
    /* ══════════ ★ P2(2026-11-21)模块级侧账的**回收点** ══════════
     * 缺陷形态(修前):这三本账(`chestsByRoom` / `PLACEMENTS` / `ROOM_PETS`)唯一
     * 的清理调用点是 `RESET_WORLD`(`actions/reset_world.ts` 的 `forgetRoomSideLedgers`)
     * ⇒ **正常销毁**的房间一遍都不碰:每销毁一间房就漏一份(箱子格 / 放置件 /
     * 宠物归属),而房间对象自己早被 GC 掉了 —— 再也没有谁会去删那几把键。
     * 表现完全静默:房间没了、内存里那几个 Map 还在长(长跑进程里随建房数线性涨)。
     *
     * 修法 = 复用一个**已经存在**的回收口(不新造第二套):`close()` 之后按 roomId 清。
     * 顺序无所谓(两边互不依赖),放在 `close()` **之后**只是让「存档 → 关状态 → 清账」
     * 这条时间线读起来是一条线。
     *
     * ⚠️ 幂等:`forget*` 都是 `Map.delete(roomId)`,重复调用无副作用(`onDispose` 本身
     *   在 Colyseus 里也只调一次)。 */
    forgetChests(this.runtime.id);
    forgetPlacements(this.runtime.id);
    forgetRoom(this.runtime.id);
  }

  /** 每帧:推进权威世界 + 发差量 + 落审计。 */
  private stepTick(): void {
    const packet = this.runtime.step(this.lastBroadcastState);
    this.lastBroadcastState = this.runtime.cloneState();

    /* 单通道:只发自研 delta —— ★ WS-FND-162(P1):按**席位**裁剪收件人
       (判据与理由见 `deltaExclusions`)。 */
    if (packet.length > 0) {
      const except = deltaExclusions(
        this.clients,
        (c) => this.seatKeyOf(c),
        (u) => this.runtime.isSeated(u),
      );
      /* 没人被裁时走**原来那一行裸广播**(常规路径不替 Colyseus 的 `except: []`
         语义背书 —— 那条语义要有自己的判据才用)。 */
      if (except.length === 0) this.broadcast('delta', packet);
      else this.broadcast('delta', packet, { except });
    }

    /* Schema 始终与权威状态保持同步 —— 这一步**无条件执行**。
     *
     * 是否把它的变更下发到网络,由 patch **定时器**决定(见 onCreate):
     * 单通道模式下已调 `setPatchRate(null)` 把定时器清掉,于是 Schema 只作为
     * 服务端自省与调试出口,不产生任何下行流量。
     * ⚠️ task-76 订正:此处原写「由 `patchRate` 决定」并据此认为赋值即可 ——
     *   实测 `broadcastPatch()` **不读** `patchRate`(见 onCreate 的长注释),
     *   真正决定「有没有定时器」的是 `_patchInterval`。
     *   ⇒ 措辞按**机制**写,不按字段名写。 */
    this.schema().syncFrom(this.lastBroadcastState);

    /* ★ WS-FND-134(P2):把三个**留证字段**(lastRestoreError / lastRemoveError /
       lastJoinAudit)搬到唯一的日志出口上 —— 修前它们在**生产侧 0 个读点**。 */
    this.noteRuntimeEvidence();

    const violations = this.runtime.drainViolations();
    if (violations.length > 0) {
      /* ★ WS-FND-159:生产插入点也走仓储层的 `writeEvent`,不再裸 `insert`。
         裸 insert 的 id 是 `Date.now() * 1000 + rand`:
           * 同毫秒 >1000 条就**撞主键**(作弊客户端刷得出来);
           * 而且它绕过 `trimEvents` ⇒ `room_events` 永不清理(审计 P1)。
         `nowMs` 传 `v.tick`,与改前的 `created_at: v.tick` 逐字一致;
         `db` 为 null(未装配持久层)时与改前一样:流水只活在内存里。 */
      const db = this.runtime.db;
      if (db) {
        for (const v of violations) {
          writeEvent(db, this.runtime.id, v.tick, `AC_${v.kind}`, v.playerId,
            { detail: v.detail, weight: v.weight }, v.tick);
        }
      }
    }
  }

  /** 客户端输入:移动 / 攻击 / 物品。**只有这些入口**能改权威状态。 */
  private registerHandlers(): void {
    this.onMessage('move', (client, msg: { tick: number; x: number; y: number; z: number; speedMul?: number }) => {
      const verdict = this.runtime.applyMove(this.seatKeyOf(client), msg);
      if (!verdict.allowed) client.send('correct', verdict.corrected ?? null);
    });
    /* ⚠️ 报文里**只接受「打谁」**(mobId)与客户端的攻速声明。
       `level` / `wearing` / `weaponId` / `comboMul` 一律由服务端从权威档案
       派生(`applyAttack` → `attackMobAuthorized` 的签名里根本没有它们);
       报文若仍带这四个字段会被**忽略**(不是报错:老客户端仍能连)。
       这与 `inventory` 通道同一形态(见 CR-14 U1)。 */
    /* ★ WS-FND-122:`useSkill` 是 **[Q] 意图位**(只认字面 `true`)。
       ⚠️ 这条通道与 `ws_server` 的 `t:'attack'` 是**两个运输层**,
          但两者都只表达同一个意图、都走同一个 `applyAttack` —— 判据不在运输层。 */
    this.onMessage('attack', (client, msg: { claimedBonus?: number; mobId?: string; useSkill?: boolean }) => {
      const useSkill = msg?.useSkill === true;
      const verdict = this.runtime.applyAttack(
        this.seatKeyOf(client),
        msg?.claimedBonus ?? 0,
        typeof msg?.mobId === 'string' ? msg.mobId : undefined,
        useSkill,
      );
      if (!verdict.allowed) {
        client.send('reject', { kind: 'ATTACK' });
        return;
      }
      /* 成功回执:接线前这里**什么都不发**(空成功路径)。
         回执形态参照 `reject` / `correct` 的既有做法(单通道 + 小对象),
         带上真实结算值,让客户端能据此播伤害数字而**不必自己算一遍**。 */
      const rep = this.runtime.lastAttackReport;
      if (rep === null) {
        /* 反作弊放行但没有世界/没有目标 —— 不谎报命中。 */
        client.send('attackResult', { resolved: false });
        return;
      }
      client.send('attackResult', {
        resolved: rep.hit,
        mobId: rep.mobId,
        outcome: rep.outcome,
        hpLoss: rep.hpLoss,
        finalDamage: rep.finalDamage,
        outOfReach: rep.outOfReach,
        dodged: rep.dodged,
        useSkill: rep.useSkill,
        rejected: rep.rejected,
      });
    });
    /* ⚠️ 报文里**只接受 ops**。`allowedSources` / `capacity` / `beforeTotal`
       一律由服务端在 `RoomRuntime.applyInventory` 内派生 —— 它们曾是
       客户端字段,那等于让客户端决定自己的判据(见 CR-14 U1)。
       报文里若仍带这三个字段,会被**忽略**(不是报错:老客户端仍能连)。 */
    this.onMessage('inventory', (client, msg: {
      ops: { itemId: number; delta: number; source?: string }[];
    }) => {
      const r = this.runtime.applyInventory(this.seatKeyOf(client), { ops: msg.ops });
      if (!r.allowed) {
        /* ★ **不隐藏归因**(P2:`ITEM_NEGATIVE` / `ITEM_OVERFLOW` / `ITEM_FROM_NOTHING`
           此前被入口一律折叠成 `INVENTORY`):客户端与诊断据此分不出
           「这一件不够扣」与「容量不够」—— 而这两件事的修法完全不同。
           判据仍在**唯一汇点**(`RoomRuntime.applyInventory` 的四个服务端派生入参,
           含按件账 `beforeByItem`),这里只把汇点给出的拒因码**如实带出去**。 */
        client.send('reject', { kind: 'INVENTORY', code: r.rejectCode ?? null });
      }
    });
    /* ── action:授权 → 执行 → **回执**(2026-11-14 接线)──
     *
     * ## 此前形态(实测)
     * ```
     * authorize(...) ⇒ !allowed ⇒ send('reject')
     * ⇒ allowed === true 时**零执行、零回执、零日志**(成功分支为空)
     * ```
     * ⇒ 22 个 `RoomAction` 长期「授权存在、执行不存在」;玩家按了没反应,
     *   而且**没有任何一处**能看出原因 —— 连 `else` 都没有。
     *
     * ## 现在
     * 执行落到 `RoomRuntime.dispatchAction()`(它负责把宿主方法的返回值
     * 翻译成 `ActionOutcome`,并对未实现的动作用 `NOT_IMPLEMENTED` **显式**拒绝)。
     * 本 handler 只做一件事:**把结果变成回执**。
     *
     * ★ 成功**也**发回执(`actionResult { ok: true, effect }`)。
     *   这不是冗余流量,而是消灭「静默成功」的唯一办法:
     *   没有回执时,「执行了」与「什么都没发生」在客户端**不可区分**。
     * ★ 失败带 `kind` —— 否则「无权」与「这个动作还没实现」在客户端又混成一件事,
     *   而那正是本次修复要消灭的那类混淆。 */
    this.onMessage('action', (client, msg: {
      action: Parameters<RoomRuntime['authorize']>[1];
      payload?: Parameters<RoomRuntime['dispatchAction']>[2];
    }) => {
      /* ★ WS-FND-134(P2):dispatchAction **抛**时必须回一条 INTERNAL 档(且先留日志)——
         修前它原样冒泡进 Colyseus:那条连接只看到连接级错误,分不清"我发错了"
         与"服务端执行崩了";而裸 WS 路径当时回的是 INVALID,两边各自都不对。
         ⇒ 两条装配路径现在对齐到同一档 INTERNAL(判据在测试里各自钉住)。 */
      let out: ReturnType<RoomRuntime['dispatchAction']>;
      try {
        out = this.runtime.dispatchAction(this.seatKeyOf(client), msg.action, msg.payload ?? {});
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.logLine('action-error', `dispatchAction 抛错(action=${String(msg.action)}):${reason}`);
        client.send('reject', { kind: 'INTERNAL', action: msg.action, reason });
        return;
      }
      if (out.ok) {
        client.send('actionResult', { ok: true, action: msg.action, effect: out.effect ?? null });
        return;
      }
      client.send('reject', { kind: out.kind, action: msg.action, reason: out.reason ?? null });
    });
  }

  private schema(): RoomSchema {
    return this.state as RoomSchema;
  }
}

/**
 * 注册到 Colyseus 的服务端入口辅助(**全仓无调用方**)。
 *
 * ⚠️ task-76 订正:原文写「由 `server/src/index.ts` 调用 —— 该文件**当前不存在**」。
 * 两句**都已过期**:`index.ts` 已由 task-57 补出;而它**并不调用本函数**
 * (它直接 `new RoomRuntime(...)`,即 A 路)。⇒ 本函数仍无调用方,
 * 但原因从「没人写调用者」变成了「**有两条路,而选中的是另一条**」。
 *
 * ⚠️ `deps` 在这里**无法转交给房间**:`server.define` 只登记构造器,
 * 实例化时由 Colyseus 调 `onCreate`,没有任何地方能把 `deps` 递给它。
 * 原实现因此写了 `void deps`(**丢弃**)。保留这个参数是给将来
 * 一个统一注入点,但**它现在确实什么都没做** ——
 * 不写 `void deps` 会让读者以为它被用上了。
 * 真正的注入路径是 `room.withDeps(deps)`(见那里的注释)。
 *
 * ⚠️ 2026-11-14 订正:上一句**前一半仍准确**("整条 B 路无人装配"曾是真因),
 *    但**结论已改** —— B 路现在通过 `resolveRoomHost(this.deps)` 自己构造 host,
 *    **不再恒为 null**。`withDeps` 仍无调用方,那只是「注入通道没人用」,
 *    不再是缺口。详见 `resolveRoomHost` 的注释与 `WS-FND-12`。
 */
export function gameServerConfig(deps: NetPersistRoomOptions): {
  initializeGameServer: (server: { define: (name: string, handler: unknown) => void }) => void;
  /** 原样回传,便于 `index.ts` 调 `withDeps` —— 目前无调用方。 */
  deps: NetPersistRoomOptions;
} {
  return {
    initializeGameServer: (server) => {
      server.define('net_persist_room', NetPersistRoom as unknown as new () => unknown);
    },
    deps,
  };
}

export { RoomRegistry, PlayerSchema, WildlifeSchema, BossSchema, RoomSchema };
