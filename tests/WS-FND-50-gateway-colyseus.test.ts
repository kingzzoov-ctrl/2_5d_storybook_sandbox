/**
 * WS-FND-50 · **真网关端到端**:Colyseus 生产装配路径(`server/src/net/room.colyseus.ts`)
 * **不是空的**。
 *
 * ## 本套件要回答的问题(以及为什么它必须存在)
 *
 * `docs/COMPLETION-CRITERIA.md` 的 `US2 网关` 条目长期是 `[~]`,理由正是
 * 「端到端未证」。而已有的套件分两类,谁都答不了这个:
 * ```
 * FND12-8   真跑一次 onCreate(),但把 setState / onMessage / setSimulationInterval
 *           **全换成桩** ⇒ 证明的是「handler 被注册」,不是「网关跑得起来」
 * FND12-3b  直接调 resolveRoomHost(undefined) ⇒ 证明的是那个**纯函数**返回非 null
 * WS-07     只走零依赖核心 room.ts / schema.ts,从不经过 Colyseus
 * ```
 * ⇒ 「`createHost()` / `wireHost()` 真的被生产路径调用」「`RoomRuntime` 真的拿到 host」
 *   「世界侧注入(计分 sink / SLEEP 读者 / 城镇 provider)真的生效」这三件事,
 *   此前**一条断言都没有**。这正是本仓反复点名的形态:能力存在、通路缺失,
 *   而缺失在任何测试里都不报错。
 *
 * ## 本套件里**哪一段是真的、哪一段没被覆盖**(如实标注)
 *
 * **真的**(全部由真 `colyseus` 0.15.57 驱动,不是替身):
 * ```
 * 1 import colyseusPkg from 'colyseus'  ← 与 room.colyseus.ts 的默认导入**同形**
 * 2 new Server() + gameServerConfig().initializeGameServer(server) + listen(0)
 *   ⇒ 真 WebSocketTransport(`@colyseus/ws-transport`)绑定一个随机端口
 * 3 matchMaker.createRoom('net_persist_room', {...})
 *   ⇒ **由 Colyseus 自己** new NetPersistRoom()、赋 roomId/roomName、
 *     调 **真 `onCreate(options)`**(`@colyseus/core/build/MatchMaker.js:307-328`)
 *   ⇒ 于是 `createHost()` / `wireHost()` / `new RoomRuntime` / `setPatchRate(null)` /
 *     `registerHandlers()` / `setSimulationInterval` 全部**真跑**
 * 4 `onCreate` 里 `setSimulationInterval(...)` 建的 20Hz 定时器**真的存在**
 *   (FND50-2 直接读 `_simulationInterval`)
 * 5 世界侧效果断言读的是**真 `WorldSim`**(`createHost()` 造的那个)
 * 6 `room.state` 是**真 `RoomSchema`**(`onCreate` 里 `setState(new RoomSchema())`)
 * ```
 *
 * **没被覆盖的**(不要把它读成本套件声称过的):
 * ```
 * A 客户端那一段:**没有真 socket**。`colyseus.js` 不在依赖里(package.json 不允许动),
 *   而 Colyseus 的二进制握手协议不适合手搓 ⇒ 入场走 `room.onJoin(stubClient, opts)`,
 *   其中 `stubClient = { sessionId, send, leave }`。
 *   ⇒ 服务端在装配层**只读 client.sessionId**(见 room.colyseus.ts 的 onJoin/onLeave
 *     与 4 条 handler),故 `sessionId` 语义被真跑到;但 `client.send(...)` 的
 *     **序列化与传输**没跑(桩只记账)。
 * B **WS 层字节**:一条报文都没经过 WebSocket。patch 同步按设计关闭
 *   (`USE_COLYSEUS_PATCH = false`),自研 delta 的字节由 WS-12/13 那几套覆盖。
 * C 20Hz **定时器不等待**:拿到房间后调 `setSimulationInterval()`(官方「停表」入口,
 *   `Room.js:163` 无回调即 clearInterval)把它停掉,再**同步**调生产帧函数
 *   `room.stepTick()` —— 否则帧号与 z 轴会随挂钟漂,断言不可复现。
 * D 落盘 / 读档:`db === null`(生产 B 路的现状:`withDeps` 零调用点 ⇒
 *   `resolveAssembly().db === null`)⇒ `saveToDb` 那条整段不进,本套件不断言它。
 * E `gameServerConfig` 的 `deps` **被丢弃**(该函数自己的 docblock 写明),
 *   ⇒ 房间跑的是**生产默认**(`resolveRoomHost(undefined) → createHost()`,
 *   房号 `'room_main'`、真实 `Date.now` 时钟)。这恰好是本套件要证的那条路。
 * F 本轮**实测发现**(不是本套件要断言的接线,记在这里让接手者看得见):
 *   B 路每建一次房会**白造一个世界** —— `onCreate` 里的 `resolveRoomDb(undefined)`
 *   走 `resolveAssembly()`,而后者内部**也**调 `createHost()`(于是 `wireHost()` 的
 *   第二份注入也发生),那个世界随后只被取 `.db` 后丢掉。
 *   ⇒ 副作用:把 B 路改坏成 `host: null` **不会**让 FND50-4 变红(全局 provider
 *     仍被那个被丢掉的世界装上);真正变红的是 FND50-3/5/6/7。详见 FND50-4 的注。
 * ```
 *
 * ## 每条断言都附「它能怎么变红」(本仓纪律:不能变红的断言等于没写)
 */

import { test, ok, eq, report, results } from '../shared/testing/harness.ts';
import colyseusPkg from 'colyseus';

import { NetPersistRoom, RoomSchema, gameServerConfig } from '../server/src/net/room.colyseus.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import type { ActionPayload } from '../server/src/net/room.ts';
import { townSafeRadiusFor } from '../server/src/mobs/spawner.ts';
import { FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import { beginSleep, clearSleepRegistry } from '../server/src/net/actions/sleep.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/**
 * `colyseus` 的**运行时对象**按结构取用。
 *
 * 只声明本套件真用到的 5 个成员 —— 与 `room.colyseus.ts` 的取舍同一理由:
 * 该包的 `.d.ts` 描述的是它的**内部**装配(`Room` 泛型、`Transport` 子类),
 * 而测试要钉的是「真模块 + 真类」这件事,不是它的类型体操。
 * ⚠️ `import colyseusPkg from 'colyseus'` 本身是**生产同形**的(CJS 默认导出);
 *    `Room` / `Client` 只能这样取,理由见 `room.colyseus.ts:33-45` 的长注释。
 */
type ColyseusServerLike = {
  define: (name: string, handler: unknown) => void;
  listen: (port: number, hostname?: string) => Promise<void>;
  gracefullyShutdown: (exit?: boolean) => Promise<void>;
};

type ColyseusLike = {
  Server: new (options?: { greet?: boolean }) => ColyseusServerLike;
  matchMaker: {
    createRoom: (roomName: string, clientOptions: Record<string, unknown>) => Promise<{ roomId: string }>;
    getRoomById: (roomId: string) => unknown;
    getRoomClass: (roomName: string) => unknown;
  };
};
const { Server, matchMaker } = colyseusPkg as unknown as ColyseusLike;

const OWNER = 'u_owner';
const ROOM_ID = 'room_main';
const ROOM_TYPE = 'net_persist_room';

/**
 * `MODIFY_TOWN` 的报文体。
 *
 * ⚠️ `radius` 这个键**还没写进** `ActionPayload`(`modify_town.ts` 文件头自己记着这件事),
 * 那里的手法是**局部交叉类型**(不是第二份协议定义)。测试沿用同一手法 ——
 * 既能让类型检查通过,又不假装那个键已经在契约里。
 */
type TownPayload = ActionPayload & { radius: number };
const TOWN_PATCH: TownPayload = { radius: 8 };

/** 世界侧读口(测试只用这几个;`WorldSaveHost` 是结构化接口,刻意不引模拟层类型)。 */
type WorldReads = {
  roomId: string;
  playerPosition: (id: string) => { x: number; y: number; z?: number } | null;
  lastRoomEffects: { playerId: string; sleeping: number }[];
};

/** 桩客户端:`room.colyseus.ts` 的装配层只读 `client.sessionId`;`send`/`leave` 只记账。 */
type StubClient = { sessionId: string; send: (t: string, m: unknown) => void; leave: () => void };

/** 真 `NetPersistRoom` 实例 —— 用结构类型读它的**私有**成员(理由见各断言)。 */
type RoomInternals = {
  constructor: { name: string };
  roomId: string;
  roomName: string;
  maxClients: number;
  state: RoomSchema;
  runtime: RoomRuntime;
  onJoin: (client: StubClient, options: { passwordHash?: string; asGuest?: boolean }) => void;
  stepTick: () => void;
  setSimulationInterval: (cb?: () => void, delay?: number) => void;
  /** Colyseus 私有:20Hz 仿真定时器(`Room.js:163` 的 `setSimulationInterval` 建的)。 */
  _simulationInterval: unknown;
};

type Gateway = { server: ColyseusServerLike; room: RoomInternals; socketRoomId: string; sends: string[] };

let gateway: Gateway | null = null;

/** 起真网关并**由 Colyseus 自己**建出房间(只做一次;各断言共用这个夹具)。 */
async function ensureGateway(): Promise<Gateway> {
  if (gateway !== null) return gateway;
  const server = new Server({ greet: false });   /* `greet` 只关启动横幅:输出留给门禁 */
  /* ★ 用**生产注册助手**登记房型 —— `gameServerConfig` 是全仓唯一的生产注册点,
     此前**零调用方**(room.colyseus.ts:493)。本套件是它的第一个消费者。 */
  const cfg = gameServerConfig({ ownerId: OWNER, clock: { nowMs: () => Date.now() }, db: null });
  cfg.initializeGameServer(server);
  await server.listen(0, '127.0.0.1');
  /* 端口 0 ⇒ 随机口;房号用**世界侧同一个** `'room_main'`(见文件头 E 段)。 */
  const listing = await matchMaker.createRoom(ROOM_TYPE, { roomId: ROOM_ID, maxPlayers: 4 });
  const room = matchMaker.getRoomById(listing.roomId) as RoomInternals;
  gateway = { server, room, socketRoomId: listing.roomId, sends: [] };
  /* 房主入场:走**真 `onJoin`**(内部 `runtime.join` + 回发全量快照 + schema 同步)。
     ★ 必须在任何 `dispatchAction` **之前** —— 房主身份(`rtOpts.ownerId === 'u_owner'`)
       只有同 id 的成员入场后才成立(`room.ts` 的 `authorize` 按成员角色判)。 */
  gateOnJoin(gateway, OWNER);
  return gateway;
}

/** 真 `onJoin` 的驱动(桩只提供装配层真正读到的那几个字段)。 */
function gateOnJoin(g: Gateway, sessionId: string): void {
  g.room.onJoin({
    sessionId,
    send: (t) => { g.sends.push(t); },
    leave: () => { g.sends.push('leave'); },
  }, {});
}

/** 世界侧读口 —— `worldSaveHost` 为 null 时这里会**抛**,那正是注入验证要的红。 */
function worldReads(rt: RoomRuntime): WorldReads {
  return rt.worldSaveHost as unknown as WorldReads;
}

/** 异步版 `test`(理由同 WS-FND-15:同步 `test()` 不会 await)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

/* ═══════════════════ 1. 反向对照(网关**之前**)═══════════════════ */

test('FND50-1 反向对照:不走网关 ⇒ 城镇配置改了,世界侧**读不到**(仍 24)', () => {
  /* 为什么这条必须先跑:它是 `FND50-4` 的**对照项**,必须在**本进程还没构造过任何
     host** 时取数 —— 一旦 `createHost()` 跑过,`spawner` 的 provider 就被装上了,
     这一态再也构造不出来。
     变红条件(逐个):
       · `resolveRoomHost` 不再由 `createHost()` 兜底(host 又成 null)⇒ 第一条红;
       · `MODIFY_TOWN` 处理器的注册表写入被改坏 ⇒ `afterSafeRadius` 红;
       · 有人把 `setTownRadiusProvider(townSafeRadiusProvider)` 提到**模块顶层**
         (而不是装配期)⇒ 本条的 24 会变成 8 ⇒ 红(那正是「没接就不是注入」的反面)。 */
  const bare = new RoomRuntime({ roomId: 'room_bare', ownerId: OWNER, clock: { nowMs: () => 0 } });
  eq(bare.worldSaveHost, null, '不走网关的裸运行时**没有**世界源');

  eq(bare.join({ userId: OWNER }).ok, true, '前置:房主入场');
  const out = bare.dispatchAction(OWNER, 'MODIFY_TOWN', TOWN_PATCH);
  eq(out.ok, true, '前置:MODIFY_TOWN 应被授权并写入注册表');
  eq(out.effect?.afterSafeRadius, 8, '前置:注册表里**确实**是 8');

  eq(townSafeRadiusFor('room_bare'), 24,
    '★ 不走网关 ⇒ 刷怪侧仍读工厂常量 24 —— 配置改了而世界侧没有任何读者');
});

/* ═══════════════════ 2. 真网关 ═══════════════════ */

async function main(): Promise<void> {
  await atest('FND50-2 ★ 真网关:真 Server + 生产注册助手 + matchMaker.createRoom ⇒ 真 NetPersistRoom', async () => {
    /* 变红条件:
         · `gameServerConfig` 不再 `server.define(ROOM_TYPE, NetPersistRoom)` ⇒
           `createRoom` 抛 `no handler found` ⇒ 本套件整段抛(红);
         · 有人把房型名改成别的字符串 ⇒ `getRoomClass` 的身份断言红;
         · `onCreate` 不再 `this.maxClients = ... options.maxPlayers` ⇒ 4 红。 */
    const g = await ensureGateway();

    eq(g.room.constructor.name, 'NetPersistRoom', '★ 这个实例是 Colyseus 自己 new 出来的真房');
    eq(g.room.roomName, ROOM_TYPE, '房型名 = 生产注册助手登记的那个');
    ok(matchMaker.getRoomClass(ROOM_TYPE) === NetPersistRoom,
      '★ `matchMaker` 登记的类**就是** `NetPersistRoom`(同一引用,不是同形替身)');
    eq(g.room.maxClients, 4, '`onCreate` 真跑了(它把 options.maxPlayers 写进房间)');
    eq(g.room.runtime.id, ROOM_ID, '`onCreate` 真跑了(它用 options.roomId 建了运行时)');
    eq(g.socketRoomId === ROOM_ID, false,
      '房号区分:Colyseus 的 socket 房号是它自己生成的,`' + ROOM_ID + '` 是**世界/运行时**那个'
      + `(实测 socketRoomId=${g.socketRoomId})`);

    /* `onCreate` 里 `setSimulationInterval(() => this.stepTick(), 50)` 的产物。
       变红条件:onCreate 不再起仿真定时器(那等于生产 20Hz 帧源没了)。 */
    eq(typeof g.room._simulationInterval, 'object',
      '★ onCreate 起的 20Hz 仿真定时器真的存在(Node 的 Timeout 是对象)');
    /* 停表:官方入口 `setSimulationInterval()`(无回调 ⇒ `clearInterval`;`Room.js:163`)。
       ⚠️ 与 `setPatchRate` **不同**:它**不清字段** —— `_simulationInterval` 会留下那个
          已被 clearInterval 的句柄(实测)。故这里断言的是「字段仍是那个对象」,
          而不是「变成 undefined」(后者实测为假,写上去就是一条假断言)。 */
    g.room.setSimulationInterval();
    eq(typeof g.room._simulationInterval, 'object',
      '停表只 clearInterval、不清字段(与 setPatchRate 的 `_patchInterval = void 0` 不同)');
  });

  await atest('FND50-3 ★★ 网关路径上 RoomRuntime **拿到了 host**(不再恒 null)', async () => {
    /* 这条就是 US2 网关那一栏的正面判据。历史:此处曾 `this.deps?.host ?? null`,
       而 `withDeps` 全仓零调用点 ⇒ **恒为 null**(注释里活过一整轮)。
       变红条件:把 `host: resolveRoomHost(this.deps)` 改回任何直连 null 的形态。 */
    const g = await ensureGateway();
    const host = g.room.runtime.worldSaveHost;

    ok(host !== null, '★ 网关路径上 host 不是 null(生产默认走 createHost())');
    const h = host as NonNullable<typeof host>;
    eq(typeof h.saveToDb, 'function', 'host 的契约方法齐全(落盘口)');
    eq(typeof h.levelOf, 'function', 'host 的契约方法齐全(等级投影口)');
    eq(typeof h.attackMobAuthorized, 'function', 'host 的契约方法齐全(攻击结算口)');
    eq(worldReads(g.room.runtime).roomId, ROOM_ID,
      '★ 世界拿到的房号与运行时**同源**(空串会让查配置拿回出厂值)');
  });

  await atest('FND50-4 ★★★ wireHost 的**城镇 provider** 在网关路径生效(24 → 8)', async () => {
    /* `wireHost()`(`server/src/index.ts:231-250`)是三条世界侧注入的**唯一落点**;
       第一版把它写在 `assemble()` 里 ⇒ 生产(Colyseus)路径**全空**(审查 A1)。
       变红条件(逐个):
         · `createHost()` 不再调 `wireHost()` ⇒ spawner 没 provider ⇒ 后面两条 8 变 24;
         · provider 装错房号 ⇒ `room_main` 读不回来;
         · `townSafeRadiusProvider` 变成常量 24 ⇒ 8 红。
       ⚠️ 实测订正(注入验证,2026-11-16):把 B 路改坏成 `host: null` **本条不会红** ——
         因为 `resolveRoomDb(undefined)` 内部走的是 `resolveAssembly()`,而后者**也**调
         `createHost()`(provider 照样装上),那个世界随后被丢掉(只取 `.db`)。
         ⇒ 本条的唯一变红条件是「`wireHost()` 不再装 provider」;
         同一注入下真正变红的是 FND50-3 / FND50-5 / FND50-6 / FND50-7
         —— 它们读的是**运行时自己那个** host,不是这个全局 provider。
         (⚠️ 那处副作用本身是待裁缺陷:B 路每建一次房会**白造一个世界**。)
         ★ 所以「注入必红」这条纪律在本套件里由 FND50-3/5/6/7 承担,本条承担的是
           「世界侧**装配期注入**真的装上了」。 */
    const g = await ensureGateway();
    const rt = g.room.runtime;

    eq(townSafeRadiusFor(ROOM_ID), 24, '前置:还没改配置 ⇒ 24');
    const out = rt.dispatchAction(OWNER, 'MODIFY_TOWN', TOWN_PATCH);
    eq(out.ok, true, '经**网关运行时**改配置应成功(房主身份来自 rtOpts.ownerId)');
    eq(out.effect?.afterSafeRadius, 8, '注册表写入 8');

    eq(townSafeRadiusFor(ROOM_ID), 8,
      '★★★ 世界侧(刷怪/安全区)按 MODIFY_TOWN 的 8 走 —— 只有 wireHost 装了 provider 才可能');
    eq(townSafeRadiusFor('room_never_configured'), 24,
      '对照:没配过的房号仍是 24(读的是 per-room 注册表,不是常量)');
    eq(townSafeRadiusFor('room_bare'), 8,
      '★ 同一条注册表记录:「网关之前读 24(FND50-1)、网关之后读 8」'
      + '⇒ 差的**就是**网关那次 CreateHost/wireHost 注入,不是配置本身');
  });

  await atest('FND50-5 ★★ 经网关的移动写进**权威世界**(z 轴),并读回', async () => {
    /* 变红条件:
         · `applyMove` 不再 `host.applyPlayerMove(...)` ⇒ 权威 z 停在 0;
         · 断言应紧跟在移动之后取(z 会随世界物理漂,见本套件末尾那段 tick)。 */
    const g = await ensureGateway();
    eq(g.sends, ['snapshot'],
      '★ 入场回执:真 `onJoin`(夹具里跑的)发出了全量快照 —— 不是空成功路径');

    const rt = g.room.runtime;
    const reads = worldReads(rt);
    eq(reads.playerPosition(OWNER)?.z, 0, '前置:新玩家权威高度 0');
    eq(reads.playerPosition(OWNER)?.x, 0.5, '前置:出生点 x=0.5');

    /* 小步移动(防作弊上界 0.360 格/帧),带 z ⇒ 走的是 `applyMove` 的权威写路径。 */
    const verdict = rt.applyMove(OWNER, { tick: rt.state.meta.tick + 1, x: 0.6, y: 0.5, z: 3 });
    eq(verdict.allowed, true, '带 z 的移动应被放行');
    eq(reads.playerPosition(OWNER)?.z, 3, '★★ 高度真的进了权威刚体(不是只写在报文投影里)');
    eq(reads.playerPosition(OWNER)?.x, 0.6, '平面位置也进了权威');
  });

  await atest('FND50-6 ★ 真 RoomSchema:字段与**权威值**一致(不是读文档/注释)', async () => {
    /* 变红条件(逐个):
         · `onJoin` 不再 `schema.syncFrom(...)` ⇒ 玩家不在 schema 里(size 0);
         · `stepTick` 不再逐帧 `syncFrom` ⇒ schema 停在入场那一刻(x/y/z 旧值);
         · `projectAllPlayers` 不再从世界读回 pose ⇒ z 与权威不一致。 */
    const g = await ensureGateway();
    const room = g.room;
    ok(room.state instanceof RoomSchema, '★ `room.state` 是**真** `RoomSchema`(onCreate 里 setState)');
    eq(room.state.players.size, 1, '入场后 schema 里有 1 个玩家');

    room.stepTick();   /* 生产帧函数(20Hz 定时器调的就是它) */
    const sp = room.state.players.get(OWNER);
    eq(room.state.roomId, ROOM_ID, 'schema 的 roomId 与权威一致');
    eq(sp?.x, 0.6, 'schema.x = 权威 x(逐帧投影读回)');
    eq(sp?.y, 0.5, 'schema.y = 权威 y');
    eq(sp?.z, 3, '★ schema.z = 权威 z —— 世界侧 z 真的走到了 schema 上');
    eq(sp?.level, 1, 'level 来自权威档案(新玩家 1 级)');
  });

  await atest('FND50-7 ★★ wireHost 的 **SLEEP 读口**在网关路径生效(且只认本房号)', async () => {
    /* `world_sim.ts` 的 `lastRoomEffects[].sleeping` 只由 `attachSleepSource` 决定;
       装配层那次注入(roomId 闭包)是它的**唯一**来源。
       ⚠️ 睡眠登记用 `beginSleep` 直写注册表(与 WS-FND-43 同法):`SLEEP` 动作要求
          **站在卧室里**(`actions/sleep.ts:227`),那条世界判定不是本套件要测的东西。
       变红条件(逐个):
         · `createHost()` 不调 `wireHost()` ⇒ 没有读口 ⇒ 记录恒 0 ⇒ 第一条红;
         · 注入的闭包用了**空房号 / 别人的房号** ⇒ 第一条红(用 `room_main` 登记读不到);
         · 慢帧不再逐玩家产生记录 ⇒ `rec` 为 undefined ⇒ 红。 */
    const g = await ensureGateway();
    const room = g.room;
    const reads = worldReads(room.runtime);

    clearSleepRegistry();
    beginSleep(ROOM_ID, OWNER);
    /* 慢帧每 `FAST_PER_SLOW` 个快帧一次(`lastRoomEffects` 只在慢帧刷新);
       跨过一个慢帧所需的帧数由 `FAST_PER_SLOW` 派生(不写死 —— 写死的数只在旧 tick 率下成立),
       再加 2 帧余量,不用 while 重试(重试包裹会把「一根都没扫到」洗成绿)。 */
    for (let i = 0; i < FAST_PER_SLOW + 2; i += 1) room.stepTick();
    const rec = reads.lastRoomEffects.find((r) => r.playerId === OWNER);
    eq(rec?.sleeping, 1, '★★ 本房号的登记被世界侧读到(sleeping=1)—— 只有注入生效才会发生');

    /* 反向:登记在**别的房号**下 ⇒ 读口问的是本房号 ⇒ 必须是 0(否则闭包里房号是错的,
       或干脆是个全局开关)。 */
    clearSleepRegistry();
    beginSleep('room_other', OWNER);
    for (let i = 0; i < FAST_PER_SLOW + 2; i += 1) room.stepTick();
    eq(reads.lastRoomEffects.find((r) => r.playerId === OWNER)?.sleeping, 0,
      '★ 别的房号的登记**不算**(读口的口径是本房号,不是全局)');
  });
}

await main();

/* 收尾:关掉真 Server(含 matchMaker / transport)⇒ 进程能自然退出,不留定时器。
   ⚠️ 这里经 `ensureGateway()` 取夹具,而不是直接读模块级 `gateway`:
     那个 `let gateway: Gateway | null = null` 在**模块顶层**的控制流分析里会被窄化成
     `null`(赋值发生在函数体内)⇒ 直接读会报 TS2339(`Property 'server' does not exist
     on type 'never'`,实测)。
   夹具没起来时(那时已有一条红的断言)没有服务要关,故吞掉这条路。 */
try {
  const g = await ensureGateway();
  await g.server.gracefullyShutdown(false);
} catch {
  /* 没有服务可关 */
}

/* ⚠️ `report()` 必须在异步区**之后**(否则异步断言还没跑完就打完计数)。 */
report('WS-FND-50');
