/**
 * WS-FND-106 · **连接生命周期三处 P1**(第三轮实测)。
 *
 * ## 本套件要回答的三个问题(每个都配负对照)
 * ```
 * P1-1 成员键不一致:带凭证入场者的成员键是**凭证里的 userId**,
 *      而 onLeave / onMessage 用的是 Colyseus 的 `client.sessionId`
 *      ⇒ 席位与连接旁表**永不回收**;移动等输入**全部落空**。
 * P1-2 超期回收漏清世界:`reapExpiredDisconnects` 是唯一没调 `host.removePlayer`
 *      的移除路径(leave / join 超期都调了)⇒ 宽限超期者世界里留旧刚体,
 *      同名重进再 `addPlayer` ⇒ 同一 id 两份刚体。
 * P1-3 凭证不续期:token 只在 join/重连时签发,连接存续期不续;
 *      重连第 1 步就用同一张验签 ⇒ 会话超 5min 掉线后,30s 宽限内重连
 *      **必然**被「token 已过期」拒。
 * ```
 *
 * ## 判据表(每条的「怎么变红」见各用例内注释)
 * ```
 * FND106-1  P1-1 正:成员键 = 凭证 userId;move 报文真的进权威世界且无 correct
 * FND106-2  P1-1 负对照:同一份报文用 sessionId 当键 ⇒ allowed:false(旧键真落空)
 * FND106-3  P1-1 正:onLeave(主动) 用凭证键回收席位 + 旁表归零
 *          负对照:`leave(sessionId)` = false 且席位仍在(修前形态)
 * FND106-4  P1-1 正:onLeave(异常) ⇒ disconnect 保留席位,重连 resumed:true
 * FND106-5  P1-1 正:重连换新 sessionId ⇒ 新键指向同一 userId,旧键被拆,旁表仍 1 条
 * FND106-6  P1-2 正:三条移除路径各调 host.removePlayer **一次**
 * FND106-7  P1-2 负对照:只看房间侧,三条路径**看不见**这个缺陷
 * FND106-8  P1-2 结构守卫:全文件 host.removePlayer( / this.ac.leave( 各 **2** 处
 *          (purgeSeat + join 的超期分支 —— 后者是 WS-07 M8 的代码态窗口要求的
 *           刻意例外,理由写在 room.ts 的 purgeSeat 注释里),this.purgeSeat( 2 处
 * FND106-9  P1-3 正:会话超 TTL 后掉线,宽限期内用**同一张**凭证重连成功
 * FND106-10 P1-3 负对照:同一张过期凭证,宽限期**外** ⇒ 仍拒且原因指认「过期」
 * FND106-11 P1-3 负对照:在线成员 / 从未入房 / 绑定不符 ⇒ 一律不放宽
 * FND106-12 P1-3 口径:三态 + 生效值 = 断线时刻 + 30s,且 TTL > 宽限期
 * FND106-13 P1-3 装配层:过期凭证在宽限内 onJoin **不**拒(4001),宽限外才拒
 * ```
 *
 * ## ⚠️ 一处**刻意**不做的断言
 * 「世界侧旧刚体」这件事在**假件**上只能证明「removePlayer 被调了」——
 * 它证明不了真 `WorldSim` 里刚体真的消失。本套件不声称后者,
 * 真世界的那一侧由 `WS-FND-50` 的 gateway 夹具与 `WS-07` 的 task-58 组覆盖。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { NetPersistRoom, RoomSchema } from '../server/src/net/room.colyseus.ts';
import { RoomRuntime, RECONNECT_GRACE_MS, JOIN_TOKEN_TTL_MS } from '../server/src/net/room.ts';
import type { WorldSaveHost } from '../server/src/net/room.ts';
import type { RoomTokenVerdict } from '../server/src/net/room.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OWNER = 'u_owner';
const GUEST = 'u_alice';

/**
 * 取验签结论的**失败原因** —— `RoomTokenVerdict` 是判别联合,`reason` 只在
 * `ok:false` 那一支上。`eq(v.ok, false)` 是断言、不是类型守卫,故需要这一层
 * 窄化(否则 typecheck 会红:实测 3 条 TS2339)。
 */
function reasonOf(v: RoomTokenVerdict): string {
  return v.ok ? '' : v.reason;
}

/* ═══════════════ 0. 夹具 ═══════════════ */

/** 可控时钟:`nowMs` 是**房间**判过期/宽限的唯一输入(不真等)。 */
type Clock = { nowMs: () => number };
function makeClock(start = 1_000_000): {
  clock: Clock; at: () => number; advance: (ms: number) => void;
} {
  let now = start;
  return {
    clock: { nowMs: () => now },
    at: () => now,
    advance: (ms): void => { now += ms; },
  };
}

/**
 * 世界侧**结构化假件** —— 只实现本套件读到的那几个口,并**记账**。
 *
 * 记账是本套件 P1-2 判据的全部依据:三条移除路径的差别**只在**
 * 「有没有调 `removePlayer`」上(见 FND106-7 的负对照)。
 */
type HostProbe = {
  added: string[];
  removed: string[];
  moves: string[];
  positions: Map<string, { x: number; y: number; z: number }>;
  saveToDb: () => { hpSaved: number; hpSkipped: number; memRow: number };
  attackMobAuthorized: () => { outcome: 'OUT_OF_AOI'; hit: null };
  listWildlife: () => unknown[];
  materials: () => unknown;
  levelOf: () => number;
  addPlayer: (id: string, x: number, y: number) => void;
  removePlayer: (id: string) => boolean;
  applyPlayerMove: (id: string, x: number, y: number, z?: number) => boolean;
  playerPosition: (id: string) => { x: number; y: number; z: number } | null;
};

function makeHost(): HostProbe {
  const added: string[] = [];
  const removed: string[] = [];
  const moves: string[] = [];
  const positions = new Map<string, { x: number; y: number; z: number }>();
  return {
    added, removed, moves, positions,
    saveToDb: () => ({ hpSaved: 0, hpSkipped: 0, memRow: 0 }),
    attackMobAuthorized: () => ({ outcome: 'OUT_OF_AOI' as const, hit: null }),
    listWildlife: () => [],
    materials: () => ({}),
    levelOf: () => 1,
    addPlayer: (id, x, y) => { added.push(id); positions.set(id, { x, y, z: 0 }); },
    removePlayer: (id) => { removed.push(id); positions.delete(id); return true; },
    applyPlayerMove: (id, x, y, z = 0) => {
      moves.push(`${id}:${x}:${y}:${z}`);
      positions.set(id, { x, y, z });
      return true;
    },
    playerPosition: (id) => positions.get(id) ?? null,
  };
}

/** 裸运行时夹具(P1-2 / P1-3 用)。房主先入场,与生产「房里有人」同一态。 */
function makeRuntime(roomId: string): {
  rt: RoomRuntime; host: HostProbe; c: ReturnType<typeof makeClock>;
} {
  const c = makeClock();
  const host = makeHost();
  const rt = new RoomRuntime({
    roomId,
    ownerId: OWNER,
    clock: c.clock,
    host: host as unknown as WorldSaveHost,
  });
  rt.join({ userId: OWNER });
  return { rt, host, c };
}

/** 桩客户端:`send` / `leave` 只记账(`room.colyseus.ts` 的装配层只读 sessionId)。 */
type StubClient = {
  sessionId: string;
  sent: { t: string; m: unknown }[];
  left: { code: number | undefined; reason: string | undefined }[];
  send: (t: string, m: unknown) => void;
  leave: (code?: number, reason?: string) => void;
};

function makeClient(sessionId: string): StubClient {
  const sent: { t: string; m: unknown }[] = [];
  const left: { code: number | undefined; reason: string | undefined }[] = [];
  return {
    sessionId, sent, left,
    send: (t, m): void => { sent.push({ t, m }); },
    leave: (code, reason): void => { left.push({ code, reason }); },
  };
}

type Handler = (client: unknown, msg: Record<string, unknown>) => void;

/** 真 `NetPersistRoom` 实例 —— 用结构化类型读它的**私有**成员(理由同 WS-FND-50)。 */
type RoomInternals = {
  runtime: RoomRuntime;
  seatKeys: Map<string, string>;
  state: RoomSchema;
  maxClients: number;
  autoDispose: boolean;
  onCreate: (o: Record<string, unknown>) => void;
  onJoin: (client: unknown, o: Record<string, unknown>) => void;
  onLeave: (client: unknown, consented?: boolean) => void;
  onDispose: () => void;
  onMessage: (t: string, cb: Handler) => void;
  setState: (s: unknown) => void;
  setSimulationInterval: (fn?: () => void, ms?: number) => void;
  stepTick: () => void;
};

type RoomFixture = {
  room: RoomInternals;
  handlers: Map<string, Handler>;
  host: HostProbe;
  clock: ReturnType<typeof makeClock>;
};

/**
 * 真跑一次 `onCreate()`,只把**副作用**换掉(手法与 `WS-FND-12` 的 FND12-8 同源):
 * ```
 * setPatchRate        → 空实现(Colyseus 构造器会起 50ms patch 定时器 ⇒ 挂住进程)
 * setState            → 记到实例上(state 仍是**真 RoomSchema**)
 * onMessage           → 记录器(于是 4 条**真注册**的 handler 可以被直接驱动)
 * setSimulationInterval → 空实现(不起 20Hz 定时器)
 * ```
 * ★ 世界源与时钟**由本夹具注入**(`withDeps`),于是 `host` 的记账可断言、
 *   时间可推进 —— 这两件事正是 P1-2 / P1-3 判据要的。
 */
function makeRoom(): RoomFixture {
  const clock = makeClock();
  const host = makeHost();
  const handlers = new Map<string, Handler>();

  const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
  const realSetPatchRate = proto['setPatchRate'];
  proto['setPatchRate'] = function stubSetPatchRate(): void { /* 不建定时器 */ };
  const raw = new NetPersistRoom();
  proto['setPatchRate'] = realSetPatchRate;

  const room = raw as unknown as RoomInternals;
  room.autoDispose = false;   /* 否则空房 1s 后自己 dispose,污染 stderr */
  room.onMessage = (t, cb): void => { handlers.set(t, cb); };
  room.setState = (s): void => { room.state = s as RoomSchema; };
  room.setSimulationInterval = (): void => { /* 不起 20Hz 定时器 */ };
  (raw as unknown as { withDeps: (d: unknown) => void }).withDeps({
    ownerId: OWNER,
    clock: clock.clock,
    db: null,
    host: host as unknown as WorldSaveHost,
  });
  room.onCreate({ roomId: 'room_106', maxPlayers: 4 });
  /* ⚠️ **刻意不在这里预置房主**:本套件的判据逐条数「连接旁表里有几条绑定」,
     一个预置连接会让每个数都偏移 1(而偏移是靠记性维持的 —— 那正是本仓
     反复点名的"靠约定"形态)。需要房主在场的用例自己调 `onJoin`。 */

  return { room, handlers, host, clock };
}

/** 驱动一条**真注册**的报文入口;返回该 client 收到的一切都留在 `client.sent` 里。 */
function fire(f: RoomFixture, type: string, client: StubClient, msg: Record<string, unknown>): void {
  const h = f.handlers.get(type);
  ok(typeof h === 'function', `前置:onCreate 必须注册 ${type} 入口(否则报文会被静默丢弃)`);
  h!(client, msg);
}

function playerOf(rt: RoomRuntime, id: string): { x: number; y: number; z: number } {
  const p = rt.state.players.find((q) => q.id === id);
  ok(p !== undefined, `前置:${id} 的实体在房间里`);
  return { x: p!.x, y: p!.y, z: p!.z };
}

/* ═══════════════ 1. P1-1 成员键一致性 ═══════════════ */

test('FND106-1 ★ P1-1 带凭证入场 ⇒ 成员键 = 凭证里的 userId,move 报文真的进权威世界', () => {
  /* 变红条件:
       · `onJoin` 不再 `bindSeat(client.sessionId, userId)` ⇒ 下面第 3 条红;
       · 4 条 handler 里任何一处写回 `client.sessionId` ⇒ 第 4/5 条红
         (修前实测:预期 0 次世界写入、1 条 correct)。 */
  const f = makeRoom();
  const c = makeClient('sess-A1');
  const token = f.room.runtime.issueJoinToken(GUEST);
  f.room.onJoin(c, { token });

  ok(f.room.runtime.members.get(GUEST) !== undefined,
    '★ 席位键必须是**凭证里的 userId**(room.ts 判 OWNER / 授权都按它)');
  eq(f.room.runtime.members.get('sess-A1'), undefined,
    '★ 席位**没有**落在 sessionId 上 —— 那个串是 Colyseus 的连接号,不是身份');
  eq(f.room.seatKeys.get('sess-A1'), GUEST, '连接旁表把 sessionId 绑到凭证 userId');
  eq(c.sent.filter((s) => s.t === 'snapshot').length, 1, '入场快照照发(不是空成功路径)');

  const before = playerOf(f.room.runtime, GUEST);
  const movesBefore = f.host.moves.length;
  fire(f, 'move', c, { tick: 1, x: before.x + 0.1, y: before.y, z: 0 });

  eq(f.host.moves.length - movesBefore, 1,
    '★ 移动报文**真的**落到了权威世界(修前恒 0:ac.move 查无此人 ⇒ allowed:false 且提前返回)');
  eq(f.host.moves[f.host.moves.length - 1], `${GUEST}:${before.x + 0.1}:${before.y}:0`,
    '写入用的是**成员键**与报文里的坐标');
  eq(c.sent.filter((s) => s.t === 'correct').length, 0,
    '★ 没有收到 correct(修前每一条输入都回一条 correct,外部表现是"按键没反应")');
});

test('FND106-2 ★ P1-1 负对照:同一份报文,键写成 sessionId ⇒ allowed:false', () => {
  /* 这条是 FND106-1 的**对照项**:若 `applyMove` 对任何 id 都放行,
     第一条的「世界收到了」就什么都证明不了。 */
  const f = makeRoom();
  const c = makeClient('sess-B1');
  f.room.onJoin(c, { token: f.room.runtime.issueJoinToken(GUEST) });
  const p = playerOf(f.room.runtime, GUEST);

  const wrong = f.room.runtime.applyMove('sess-B1', { tick: 1, x: p.x + 0.1, y: p.y, z: 0 });
  eq(wrong.allowed, false,
    '★ 负对照:错键(sessionId)真的落空 —— 反作弊里没有这个 id');

  const right = f.room.runtime.applyMove(GUEST, { tick: 1, x: p.x + 0.1, y: p.y, z: 0 });
  eq(right.allowed, true,
    '正对照:同一个成员、同一帧、同一坐标,换成**成员键**就放行 ⇒ 差别只在键');
});

test('FND106-3 ★ P1-1 onLeave(主动退房)用凭证键回收席位 + 连接旁表归零', () => {
  /* 变红条件:onLeave 改回 `client.sessionId` ⇒ 第 2/3 条红(席位与旁表都留下),
     且第 5 条会给出「修前形态」的直接证据。 */
  const f = makeRoom();
  const c = makeClient('sess-C1');
  const token = f.room.runtime.issueJoinToken(GUEST);
  f.room.onJoin(c, { token });
  eq(f.room.seatKeys.size, 1, '前置:入场后有一条连接绑定');

  f.room.onLeave(c, true);
  eq(f.room.runtime.members.get(GUEST), undefined,
    '★ 主动退房必须回收**席位**(回收用的键 = 凭证 userId)');
  eq(f.room.seatKeys.size, 0, '★ 连接旁表必须一起回收(修前它永不归零)');

  /* 负对照:用 sessionId 当键 —— 房间连"有人在退房"都不知道。 */
  const c2 = makeClient('sess-C2');
  f.room.onJoin(c2, { token: f.room.runtime.issueJoinToken(GUEST) });
  eq(f.room.runtime.leave('sess-C2'), false,
    '★ 负对照:用 sessionId 调 leave ⇒ false(`members.get` 查不到人,直接 return false)');
  ok(f.room.runtime.members.get(GUEST) !== undefined,
    '★ 而且席位**还在** —— 这正是修前 onLeave 的实际效果');
});

test('FND106-4 ★ P1-1 onLeave(异常断开)保留席位 ⇒ 重连走 resumed 路径', () => {
  /* 变红条件:onLeave 把异常断开也走 leave() ⇒ 席位被删、第 2 条红;
     或键写回 sessionId ⇒ 第 2 条红(disconnect 同样查无此人)。 */
  const f = makeRoom();
  const c = makeClient('sess-D1');
  const token = f.room.runtime.issueJoinToken(GUEST);
  f.room.onJoin(c, { token });

  f.room.onLeave(c, false);
  const m = f.room.runtime.members.get(GUEST);
  ok(m !== undefined, '★ 异常断开**保留席位**(走 disconnect —— 30s 宽限期的前提)');
  eq(m?.connected, false, 'connected=false');
  ok(m?.disconnectedAtMs !== null && m?.disconnectedAtMs !== undefined,
    '断线时刻被记下(宽限期的起点,也是 P1-3 的起算点)');
  eq(f.room.seatKeys.size, 0, '旁表仍要拆:席位在,连接不在了');

  const back = f.room.runtime.join({ userId: GUEST, token, requireToken: true });
  eq(back.ok, true, '宽限期内重连被放行');
  eq(back.resumed, true, '★ 走的是**重连**路径(席位与快照都保住了,没有变成"新加入")');
});

test('FND106-5 ★ P1-1 重连(新 sessionId)后三条路径仍用同一个键', () => {
  /* 变红条件:bindSeat 不拆旧键 ⇒ 第 1/3 条红(旁表泄漏);四条路径任一走
     `client.sessionId` ⇒ 第 1 或第 4 条红。 */
  const f = makeRoom();
  const c1 = makeClient('sess-E1');
  const token = f.room.runtime.issueJoinToken(GUEST);
  f.room.onJoin(c1, { token });
  f.room.onLeave(c1, false);

  const c2 = makeClient('sess-E2');
  f.room.onJoin(c2, { token });
  eq(f.room.seatKeys.size, 1, '★ 重连后旁表仍只有**一条**绑定(旧键必须被拆)');
  eq(f.room.seatKeys.get('sess-E2'), GUEST, '新 sessionId 指向**同一个**成员键');
  eq(f.room.seatKeys.get('sess-E1'), undefined, '旧 sessionId 的绑定已拆(不泄漏)');

  const p = playerOf(f.room.runtime, GUEST);
  const n = f.host.moves.length;
  fire(f, 'move', c2, { tick: 2, x: p.x + 0.1, y: p.y, z: 0 });
  eq(f.host.moves.length - n, 1, '★ 新连接上的报文同样落进权威世界');
  eq(c2.sent.filter((s) => s.t === 'correct').length, 0, '且没有 correct');
});

/* ═══════════════ 2. P1-2 超期回收漏清世界 ═══════════════ */

test('FND106-6 ★ P1-2 三条移除路径都调 host.removePlayer(各一次)', () => {
  /* 变红条件(逐个):
       · `reapExpiredDisconnects` 自己手写那 3 步(修前形态)⇒ 第 4 条红;
       · `join()` 的超期重进分支不再世界侧移除 ⇒ 第 6/7 条红;
       · `leave()` 不再移除 ⇒ 第 2 条红。 */
  const a = makeRuntime('r106p1');
  a.rt.join({ userId: 'u_x' });
  eq(a.host.removed.length, 0, '前置:还没有人被移除');
  a.rt.leave('u_x');
  eq(a.host.removed, ['u_x'], '★ 路径 1(主动退房)调 host.removePlayer 一次');

  const b = makeRuntime('r106p2');
  b.rt.join({ userId: 'u_x' });
  b.rt.disconnect('u_x');
  b.c.advance(RECONNECT_GRACE_MS + 1);
  eq(b.rt.reapExpiredDisconnects(), ['u_x'], '前置:宽限超期者被回收');
  eq(b.host.removed, ['u_x'],
    '★ 路径 2(宽限超期回收)**必须**同样调 host.removePlayer —— 修前**只有这条漏了**');

  const d = makeRuntime('r106p3');
  d.rt.join({ userId: 'u_x' });
  d.rt.disconnect('u_x');
  d.c.advance(RECONNECT_GRACE_MS + 1);
  d.rt.join({ userId: 'u_x' });
  eq(d.host.removed, ['u_x'], '★ 路径 3(宽限超期后同名重进)也先世界侧移除');
  eq(d.host.added.filter((id) => id === 'u_x'), ['u_x', 'u_x'],
    '★ 然后才重新登记(addPlayer 第二次)—— 只有 removePlayer 先发生,世界里才不会有两份刚体');
  eq(d.rt.members.get('u_x')?.connected, true, '重进者已在线(回收没有把新席位也删掉)');
});

test('FND106-7 ★ P1-2 负对照:只看房间侧,这个缺陷**看不见**', () => {
  /* 为什么必须写这条:FND106-2/6 那种「行为级」判据要能证明自己有牙。
     这个缺陷的形态恰恰是「房间侧一切正常」——
     修前 `reapExpiredDisconnects` 照样删席位、照样改 `state.players`,
     所有房间侧断言都是绿的;差别**只在**世界侧那一次调用。
     ⇒ 本条的结论:两条路径的房间侧状态**逐字相同** ⇒ 席位判据不可替代世界侧判据。 */
  const a = makeRuntime('r106n1');
  a.rt.join({ userId: 'u_x' });
  a.rt.leave('u_x');

  const b = makeRuntime('r106n2');
  b.rt.join({ userId: 'u_x' });
  b.rt.disconnect('u_x');
  b.c.advance(RECONNECT_GRACE_MS + 1);
  b.rt.reapExpiredDisconnects();

  eq(a.rt.state.players.map((p) => p.id), [OWNER], '路径 1 之后:房里只剩房主');
  eq(b.rt.state.players.map((p) => p.id), [OWNER], '路径 2 之后:房间里**同样**只剩房主');
  eq(a.rt.members.size, b.rt.members.size, '两条路径的成员表大小一致(房间侧无法区分)');
  eq(a.host.removed, b.host.removed,
    '★ 唯一的差别(修前)就在世界侧这一格:路径 2 会是 `[]` 而路径 1 是 [u_x]');
});

test('FND106-8 ★ P1-2 结构守卫:回收动作只有两处写法,两条收敛在 purgeSeat', () => {
  /* 为什么要有源码态判据:FND106-6 只覆盖**今天这三条**路径。若将来有人
     再手写第四条回收(或把某一条抄回去),行为判据可能照绿 —— 而
     「写法数量 + 谁调谁」能当场红。

     ⚠️ 期望值是 **2** 而不是 1,而且这不是"少收了一处":
     `join()` 的宽限超期分支必须把世界侧那一步写在**分支内** ——
     `tests/WS-07.test.ts` 的 M8 用**代码态窗口**(起点 `away > RECONNECT_GRACE_MS`,
     长 800 字符)要求窗口里出现 `removePlayer`,而代码态窗口表达不了"间接调用"
     (实测:把它折进 purgeSeat ⇒ M8 变红)。理由逐字记在 room.ts 的 `purgeSeat`
     注释里,同一段也说明「行为一致」由 FND106-6 兜住。 */
  const strip = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const src = strip(readFileSync(join(ROOT, 'server/src/net/room.ts'), 'utf8').replace(/\r\n/g, '\n'));

  /* ⚠️ 正则按 `.removePlayer(`(不带接收者)数:`join` 那一支的局部变量叫 `hostStale`,
     写 `host\.removePlayer\(` 会漏掉它 —— 而那正是"数少了一处"的假绿形态
     (实测踩到:期望 2 实得 1)。 */
  eq([...src.matchAll(/\.removePlayer\(/g)].length, 2,
    '★ 世界侧移除只有**两处**代码:purgeSeat + join 的宽限超期分支(第三处 = 有人又手写了一份)');
  eq([...src.matchAll(/this\.ac\.leave\(/g)].length, 2,
    '反作弊回收同样两处(同上:多一处就是"手写第四条路径"的开端)');
  eq([...src.matchAll(/this\.purgeSeat\(/g)].length, 2,
    '★ `purgeSeat()` 被**两条**路径调用:leave / 宽限超期回收');

  const reap = /reapExpiredDisconnects\(\)[\s\S]*?\n  \}/.exec(src);
  ok(reap !== null && /this\.purgeSeat\(/.test(reap[0]),
    '★ 宽限超期回收必须走 `purgeSeat()` —— 修前这条是**手写的三步**(漏了世界侧)');
  const leaveBlock = /leave\(userId: string\)[\s\S]*?\n  \}/.exec(src);
  ok(leaveBlock !== null && /this\.purgeSeat\(/.test(leaveBlock[0]),
    '主动退房那条也走 `purgeSeat()`');

  /* 与 WS-07 M8 **同一个判据**(独立的第二份):超期分支的窗口里必须真的出现
     `removePlayer` —— 这样"折进 purgeSeat"这件事在本套件里也会当场红,
     而不是只有 M8 知道。 */
  const gi = src.indexOf('away > RECONNECT_GRACE_MS');
  ok(gi > 0, '源码里能找到 `away > RECONNECT_GRACE_MS` 判断');
  ok(src.slice(gi, gi + 800).includes('removePlayer'),
    '★ 宽限超期分支的窗口里必须有 `removePlayer`(与 WS-07 M8 同判据)');
});

/* ═══════════════ 3. P1-3 凭证续期(口径) ═══════════════ */

test('FND106-9 ★ P1-3 会话超 TTL 后掉线,宽限期内用**同一张**凭证重连成功', () => {
  /* 变红条件:把 `verifyJoinToken` / `decodeJoinToken` 里的
     `expiredOkUntilMs` 去掉(即修前形态)⇒ 第 3/4 条红,拒因会是「token 已过期」。 */
  const { rt, c } = makeRuntime('r106t1');
  const token = rt.issueJoinToken(GUEST);
  eq(rt.join({ userId: GUEST, token, requireToken: true }).ok, true, '前置:凭证入场');

  c.advance(6 * 60_000);                       /* 会话坐满 6 分钟(> 5min TTL) */
  eq(rt.verifyJoinToken(GUEST, token).ok, false,
    '前置:此刻 token **确实已过期**(在线成员不享有任何宽限)');
  eq(rt.disconnect(GUEST), true, '模拟异常掉线');

  c.advance(5_000);                            /* 5 秒后重连(远在 30s 宽限内) */
  const back = rt.join({ userId: GUEST, token, requireToken: true });
  eq(back.ok, true, '★ 宽限期内同一张**已过期**凭证必须能重连(修前这里必然被拒)');
  eq(back.resumed, true, '★ 而且走的是重连路径(席位与快照没丢)');
});

test('FND106-10 ★ P1-3 负对照:同一张过期凭证,宽限期**外**仍被拒(且原因指认过期)', () => {
  /* 这条防的是「把过期判据整个删掉」式的修法:放宽必须**有界**。 */
  const { rt, c } = makeRuntime('r106t2');
  const token = rt.issueJoinToken(GUEST);
  rt.join({ userId: GUEST, token, requireToken: true });

  c.advance(6 * 60_000);
  rt.disconnect(GUEST);
  c.advance(RECONNECT_GRACE_MS + 1);           /* 宽限期刚过 1ms */
  const late = rt.join({ userId: GUEST, token, requireToken: true });
  eq(late.ok, false, '★ 宽限期外重连必须**仍然**被拒');
  ok(String(late.reason).includes('过期'),
    `拒因必须指认「过期」(实得:${String(late.reason)})`);
  eq(rt.members.get(GUEST)?.connected, false, '★ 被拒的重连**没有**把人放回在线');
});

test('FND106-11 ★ P1-3 负对照:宽限只对「断线中的本人」生效(三态之外一律不放宽)', () => {
  /* 三态负对照,各对应一条绕过路径:
       在线成员   ⇒ 宽限窗口根本不适用(过期票不能当"第二把钥匙")
       从未入房者 ⇒ 没有席位 ⇒ 无宽限可借
       绑定不符   ⇒ 拿别人的票(哪怕他在宽限期里)也不行 */
  const { rt, c } = makeRuntime('r106t3');
  const tokenGuest = rt.issueJoinToken(GUEST);
  rt.join({ userId: GUEST, token: tokenGuest });
  /* ⚠️ 这两张票必须在**推时钟之前**签:否则它们一出生就是"还没过期",
     负对照会退化成"签了一张好票当然放行"(实测踩到,幸亏断言当场红)。 */
  const tokenOther = rt.issueJoinToken('u_other');
  const tokenGhost = rt.issueJoinToken('u_ghost');

  c.advance(6 * 60_000);
  const online = rt.verifyJoinToken(GUEST, tokenGuest);
  eq(online.ok, false, '★ 在线成员的过期凭证 ⇒ 拒(宽限只服务"掉线中的人")');
  ok(reasonOf(online).includes('过期'), `原因指认过期(实得:${reasonOf(online)})`);

  const ghost = rt.verifyJoinToken('u_ghost', tokenGhost);
  eq(ghost.ok, false, '★ 从未入房者的**自己的**过期凭证 ⇒ 拒(没有席位就没有宽限)');
  ok(reasonOf(ghost).includes('过期'), `原因同样指认过期(实得:${reasonOf(ghost)})`);

  eq(rt.verifyJoinToken(GUEST, tokenOther).ok, false,
    '★ 拿别人的凭证 ⇒ 拒(绑定判据没有因为宽限而放松)');
  ok(reasonOf(rt.verifyJoinToken(GUEST, tokenOther)).includes('userId'),
    '且原因指认"与声明的 userId 不符"(不是过期 —— 负对照必须能指认对象)');
});

test('FND106-12 ★ P1-3 口径:生效值 = 断线时刻 + 30s,且 TTL > 宽限期(等式的成立条件)', () => {
  /* 口径句:「凭证有效期从**断线时刻**起算,且不越过宽限期终点」
     ⇒ 生效值 = min(断线时刻+TTL, 断线时刻+宽限) = 断线时刻 + 30s。
     本用例钉的是那条等式的**两个前提**与**三态** —— 前提一变,等式就换了答案。 */
  eq(RECONNECT_GRACE_MS, 30_000, '宽限期 = 30s(口径里的上界)');
  eq(JOIN_TOKEN_TTL_MS, 300_000, 'TTL = 5min');
  ok(JOIN_TOKEN_TTL_MS > RECONNECT_GRACE_MS,
    '★ TTL 必须**大于**宽限期 —— 否则 min(...) 会取到 TTL,"宽限期内必然可重连"就不再成立');

  const { rt, c } = makeRuntime('r106t4');
  rt.join({ userId: GUEST });
  eq(rt.reconnectTokenGraceUntilMs(GUEST), undefined, '在线成员 ⇒ undefined(过期判据原样生效)');
  eq(rt.reconnectTokenGraceUntilMs('u_ghost'), undefined, '查无此人 ⇒ undefined');

  const at = c.at();
  rt.disconnect(GUEST);
  eq(rt.reconnectTokenGraceUntilMs(GUEST)! - at, 30_000,
    '★ 断线中 ⇒ 断线时刻 + 30s(= min(TTL, 宽限),因为 TTL 更大)');
});

test('FND106-13 ★ P1-3 装配层(Colyseus):过期凭证在宽限内 onJoin 不拒,宽限外才拒', () => {
  /* 修前:`onJoin` 第 1 步 `decodeJoinToken` 就用同一张票验签 ⇒ 会话超 5min
     的人掉线后,30s 宽限内重连**必然**收到 client.leave(4001, '已过期')。
     变红条件:去掉 `decodeJoinToken` / `verifyJoinToken` 的 `expiredOkUntilMs`。 */
  const f = makeRoom();
  const c1 = makeClient('sess-G1');
  const token = f.room.runtime.issueJoinToken(GUEST);
  f.room.onJoin(c1, { token });
  eq(f.room.runtime.members.get(GUEST)?.connected, true, '前置:入场');

  f.clock.advance(6 * 60_000);                 /* 会话超过 TTL */
  f.room.onLeave(c1, false);                   /* 异常断开 ⇒ 30s 宽限 */
  f.clock.advance(5_000);

  const c2 = makeClient('sess-G2');
  f.room.onJoin(c2, { token });                /* 同一张**已过期**凭证 */
  eq(c2.left.length, 0,
    '★ 装配层不得用「token 已过期」把宽限期内的重连挡在门外(修前第 1 条就是这条)');
  eq(f.room.runtime.members.get(GUEST)?.connected, true, '★ 已回到在线(走了 resumed)');
  eq(c2.sent.filter((s) => s.t === 'snapshot').length, 1, '重连快照照发');

  /* 负对照:同样的过期票,宽限期过了 ⇒ 按 4001 拒,且不许上席位。 */
  const g = makeRoom();
  const cA = makeClient('sess-H1');
  const token2 = g.room.runtime.issueJoinToken(GUEST);
  g.room.onJoin(cA, { token: token2 });
  g.clock.advance(6 * 60_000);
  g.room.onLeave(cA, false);
  g.clock.advance(RECONNECT_GRACE_MS + 1);

  const cB = makeClient('sess-H2');
  g.room.onJoin(cB, { token: token2 });
  eq(cB.left.length, 1, '★ 宽限期外 ⇒ 装配层必须出声拒绝(不是静默放行)');
  eq(cB.left[0]?.code, 4001, '拒行走 4001 通道');
  ok(String(cB.left[0]?.reason).includes('过期'),
    `拒因必须指认「过期」(实得:${String(cB.left[0]?.reason)})`);
  eq(g.room.runtime.members.get(GUEST)?.connected, false,
    '★ 被拒的连接不许把人放回在线(席位仍是断线态)');
});

report('WS-FND-106');
