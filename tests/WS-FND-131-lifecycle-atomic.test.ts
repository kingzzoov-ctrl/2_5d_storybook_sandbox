/**
 * WS-FND-131 · **玩家生命周期六处缺口**(第八轮实测)。
 *
 * ## 六条与判据
 * ```
 * P1 加入侧非原子   members.set → state.push → addPlayer → restore(*可抛*) → encodeFull(*可抛*)
 *                    调用方无 try/catch ⇒ 中途抛留下 connected=true 的**幽灵席位**;
 *                    且 `c.userId` 还没写 ⇒ close 不清、reap 只收 connected=false
 *                    ⇒ 该 id **永久占 maxPlayers**。
 *                FND131-1 正:抛 ⇒ 席位/实体都不留,返回 ok:false 且**说出**回了滚
 *                FND131-2 负对照:回滚**不许**顺手把「从没进过世界的人」世界侧移除
 *                FND131-3 三方交叉校验三态(ok / missing / unknown)
 *                FND131-4 装配层第四方核对:runtime 说 ok 但没席位 ⇒ 出声拒绝(4002)
 * P2 移除侧无重试点 purgeSeat 最后才 host.removePlayer,抛则整条 leave 被吞、
 *                    members 已删 ⇒ 世界侧**没有重试点**。
 *                FND131-5 正:抛一次 ⇒ 席位仍清干净 + `lastRemoveApplied=false` + 入队
 *                FND131-6 负对照:正常 host 只调**一次**(重试不是\"每次都多调\")
 * P2 SLEEPING 时 step 早退 reap 只在 step 内、status!==OPEN 就早退 ⇒ 全员断线的房
 *                    到期席位与世界刚体一直挂着;新玩家 join 先 wake 再按
 *                    `members.size` 判满 ⇒ **对零在线房间误报\"房间已满\"**。
 *                FND131-7 正:SLEEPING 房里 step 也回收(且不推进帧号)
 *                FND131-8 负对照:宽限期**内**的席位不许被收
 *                FND131-9 正:超期未 reap 的席位不再占容量 / 负对照:宽限内的照样占
 * P2 per-player 表未穷尽清理
 *                FND131-10 真 WorldSim:progresses / profiles / baseMaxHp /
 *                    partyTeams / downedStates + vitals.resists 全部清干净
 * P2 sleep.ts 无世代维
 *                FND131-11 正/负对照:换代前幂等返回旧窗口,换代后是新窗口
 *                FND131-12 接线:RESET_WORLD 成功 ⇒ 换代;越权失败 ⇒ 不换代
 * P3 Member.seq 死字段
 *                FND131-13 运行时:`seq` 不再是成员会话的字段
 * ```
 *
 * ## 注入验证(每条判据都靠「注入故障」证明自己有牙)
 * ```
 * FND131-1  host.addPlayer 注入 throw          ⇒ 若没有回滚,断言 2/3 会红
 * FND131-2  host.removed 记账                   ⇒ 若回滚不看 `worldAdded`,断言 2 红
 * FND131-3  host 三形态(有/无读口、不登记)    ⇒ world 三态各自可指认
 * FND131-4  把 runtime.join 替换成「返回 ok 但不落席位」⇒ 断言 1/2 红
 * FND131-5  host.removePlayer 注入 throw        ⇒ 若没有队列/可观测量,断言 2/3/4 红
 * FND131-6  (无反注入,同上夹具)                ⇒ 若重试写成了无条件两遍,断言 1 红
 * FND131-7  时钟推进 > RECONNECT_GRACE_MS       ⇒ 若 step 仍早退,断言 2/3 红
 * FND131-8  时钟推进 < RECONNECT_GRACE_MS       ⇒ 若回收无界,断言 1/2 红
 * FND131-9  超期但不 step                       ⇒ 若容量仍读 members.size,断言 1 红
 * FND131-10 真 WorldSim 写满五张表 + 抗性       ⇒ 任一表漏清,对应断言红
 * FND131-11 先 beginSleep 再 bump               ⇒ 若桶不清,断言 3 红
 * FND131-12 同一个 dispatchAction 的两种裁决    ⇒ 若钩子挂在失败分支,断言 3 红
 * FND131-13 运行时 `'seq' in member`            ⇒ 若字段写回,断言 1 红
 * ```
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { NetPersistRoom, RoomSchema } from '../server/src/net/room.colyseus.ts';
import { RoomRuntime, RoomAction, RECONNECT_GRACE_MS } from '../server/src/net/room.ts';
import type { WorldSaveHost } from '../server/src/net/room.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import {
  beginSleep,
  bumpSleepGeneration,
  clearSleepRegistry,
  sleepGenerationOf,
  sleepStateOf,
  sleepingCount,
} from '../server/src/net/actions/sleep.ts';

const OWNER = 'u_owner';
const GUEST = 'u_alice';

/* ═══════════════ 0. 夹具 ═══════════════ */

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
 * 世界侧结构化假件 —— 三个**注入旋钮**:
 * ```
 * throwAddTimes     addPlayer 抛几次(0 = 不抛)          ⇒ FND131-1/2
 * throwRemoveTimes  removePlayer 抛几次(0 = 不抛)       ⇒ FND131-5/6
 * skipAdd           登记成 no-op(世界里\"没有这个人\")    ⇒ FND131-3 missing
 * noPosition        不提供 playerPosition 读口            ⇒ FND131-3 unknown
 * ```
 * 记账(`added` / `removed`)是移除侧判据的全部依据。
 */
type HostProbe = {
  added: string[];
  removed: string[];
  positions: Map<string, { x: number; y: number; z: number }>;
  knobs: { throwAddTimes: number; throwRemoveTimes: number; skipAdd: boolean; noPosition: boolean };
  playerPosition?: (id: string) => { x: number; y: number; z: number } | null;
  addPlayer: (id: string, x: number, y: number) => void;
  removePlayer: (id: string) => boolean;
  resetWorld?: (opts: { seed: number }) => { applied: boolean; seed: number };
};

function makeHost(): HostProbe {
  const added: string[] = [];
  const removed: string[] = [];
  const positions = new Map<string, { x: number; y: number; z: number }>();
  const knobs = { throwAddTimes: 0, throwRemoveTimes: 0, skipAdd: false, noPosition: false };
  const host: HostProbe = {
    added, removed, positions, knobs,
    addPlayer: (id, x, y) => {
      if (knobs.throwAddTimes > 0) {
        knobs.throwAddTimes -= 1;
        throw new Error('注入:addPlayer 抛(模拟世界侧登记失败)');
      }
      if (knobs.skipAdd) return;                 /* 登记成 no-op:世界里没有这个人 */
      added.push(id);
      positions.set(id, { x, y, z: 0 });
    },
    removePlayer: (id) => {
      if (knobs.throwRemoveTimes > 0) {
        knobs.throwRemoveTimes -= 1;
        throw new Error('注入:removePlayer 抛(模拟世界侧移除失败)');
      }
      removed.push(id);
      positions.delete(id);
      return true;
    },
  };
  host.playerPosition = (id) => positions.get(id) ?? null;
  return host;
}

type Fixture = {
  rt: RoomRuntime;
  host: HostProbe;
  c: ReturnType<typeof makeClock>;
};

function makeRuntime(roomId: string, maxPlayers = 8): Fixture {
  const c = makeClock();
  const host = makeHost();
  const rt = new RoomRuntime({
    roomId,
    ownerId: OWNER,
    clock: c.clock,
    maxPlayers,
    host: host as unknown as WorldSaveHost,
  });
  return { rt, host, c };
}

/** 桩客户端(只记账:`send` / `leave`)。 */
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

type RoomInternals = {
  runtime: RoomRuntime;
  seatKeys: Map<string, string>;
  state: RoomSchema;
  onJoin: (client: unknown, o: Record<string, unknown>) => void;
  onLeave: (client: unknown, consented?: boolean) => void;
  onCreate: (o: Record<string, unknown>) => void;
  setState: (s: unknown) => void;
  setSimulationInterval: (fn?: () => void, ms?: number) => void;
  onMessage: (t: string, cb: (c: unknown, m: Record<string, unknown>) => void) => void;
};

/**
 * 真 `NetPersistRoom` 跑一次 `onCreate()`,只把副作用换掉
 * (手法与 `WS-FND-106` / `WS-FND-12` 同源:不起 patch 定时器、不起 20Hz 定时器)。
 */
function makeRoom(): { room: RoomInternals; host: HostProbe; clock: ReturnType<typeof makeClock> } {
  const clock = makeClock();
  const host = makeHost();
  const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
  const realPatch = proto['setPatchRate'];
  proto['setPatchRate'] = function stubSetPatchRate(): void { /* 不建定时器 */ };
  const raw = new NetPersistRoom();
  proto['setPatchRate'] = realPatch;

  const room = raw as unknown as RoomInternals & { autoDispose: boolean };
  room.autoDispose = false;
  room.onMessage = (): void => { /* 本套件不发报文 */ };
  room.setState = (s): void => { room.state = s as RoomSchema; };
  room.setSimulationInterval = (): void => { /* 不起 20Hz */ };
  (raw as unknown as { withDeps: (d: unknown) => void }).withDeps({
    ownerId: OWNER,
    clock: clock.clock,
    db: null,
    host: host as unknown as WorldSaveHost,
  });
  room.onCreate({ roomId: 'room_131', maxPlayers: 4 });
  return { room: room as RoomInternals, host, clock };
}

/* ═══════════════ 1. P1 加入侧原子 ═══════════════ */

test('FND131-1 ★P1 加入侧原子:世界侧 addPlayer 抛 ⇒ 席位与实体都不留(不留幽灵)', () => {
  /* 变红条件:去掉 join 里的 try/catch(修前形态)⇒ 断言 1/2/3 全红,
     且断言 4 会拿到一条 `connected=true` 的**永久**席位。 */
  const { rt, host } = makeRuntime('r131a', 1);
  host.knobs.throwAddTimes = 1;

  const res = rt.join({ userId: 'u_a' });
  eq(res.ok, false, '★ 世界侧登记失败 ⇒ 入场必须**失败**(不是\"成功了但没人知道\")');
  ok(String(res.reason).includes('已回滚'), `回执必须说出已回滚(实得:${String(res.reason)})`);
  eq(rt.members.has('u_a'), false, '★★ 席位不许留下(修前:connected=true 的幽灵席位)');
  eq(rt.state.players.some((p) => p.id === 'u_a'), false, '权威 state 里也不许留实体行');
  eq(rt.onlineCount(), 0, '在线数为 0 —— 没有连接会认为自己进了房');
  eq(rt.isSeated('u_a'), false, 'isSeated 如实为 false(装配层据此拒连接)');
});

test('FND131-2 ★P1 负对照:回滚**只**撤「真的登记过」的世界侧,且之后同名/新人都能进', () => {
  /* 变红条件一:回滚时无条件调 `removePlayer`(`worldAdded` 判据被删)⇒ 断言 2 红。
     变红条件二:回滚没把席位腾出来 ⇒ 断言 3/4 红(容量 1 的房里再没人进得来)。 */
  const { rt, host } = makeRuntime('r131b', 1);
  host.knobs.throwAddTimes = 1;
  eq(rt.join({ userId: 'u_a' }).ok, false, '前置:第一次入场在世界侧失败');
  eq(host.removed, [], '★★ 负对照:世界侧**从没登记过**他 ⇒ 回滚不许调 removePlayer(否则会误踢)');

  const again = rt.join({ userId: 'u_a' });
  eq(again.ok, true, '★ 回滚把容量腾出来了 ⇒ 同名重试成功(修前:永久占位 ⇒ 这里恒 \"房间已满\")');
  eq(rt.members.size, 1, '成员表只有这一次的席位');
  eq(rt.state.players.filter((p) => p.id === 'u_a').length, 1, '实体行只有**一份**(回滚没有留半行)');
  /* 负对照的世界侧一节:这一次是**真**登记 ⇒ removePlayer 可以被调(此处通过 leave 验证)。 */
  rt.leave('u_a');
  eq(host.removed, ['u_a'], '真登记过的人退房时,世界侧移除照旧发生');
});

test('FND131-3 ★P1 三方交叉校验:world 三态可指认(ok / missing / unknown),只有房间侧不一致才致命', () => {
  /* 变红条件:把 `auditJoin` 删掉 ⇒ `lastJoinAudit` 恒 null,断言 1/2/3 红。
     变红条件:把 world 的 missing/unknown 当成失败 ⇒ 断言 2/3 的 ok 变 false。 */
  const a = makeRuntime('r131c');
  a.rt.join({ userId: 'u_a' });
  eq(a.rt.lastJoinAudit, { userId: 'u_a', members: true, state: true, world: 'ok' },
    '★★ 三方都认他:members / state / world=ok(宿主登记 + playerPosition 查得到)');

  const b = makeRuntime('r131d');
  b.host.knobs.skipAdd = true;
  const rb = b.rt.join({ userId: 'u_b' });
  eq(rb.ok, true, '★ world=missing **不是**入场失败(只有 members/state 不一致才回滚)');
  eq(b.rt.lastJoinAudit?.world, 'missing', '★ 但必须**如实**记成 missing —— 不谎报 ok');

  const d = makeRuntime('r131e');
  d.host.knobs.noPosition = true;
  delete d.host.playerPosition;
  const rd = d.rt.join({ userId: 'u_d' });
  eq(rd.ok, true, '★ 没有读口的世界源不影响入场');
  eq(d.rt.lastJoinAudit?.world, 'unknown', '★ 记成 unknown(结构上读不到,不冒充 ok)');
});

test('FND131-4 ★P1 装配层第四方核对:runtime 说 ok 但席位不在 ⇒ 4002 拒绝且不建绑定', () => {
  /* 变红条件:删掉 room.colyseus 的 `isSeated` 核对 ⇒ 断言 1/2 红
     (连接留着、席位却没有、旁表还多一条键 ⇒ 客户端每帧输入全部落空)。 */
  const f = makeRoom();
  const rt = f.room.runtime as unknown as {
    join: (i: Record<string, unknown>) => { ok: boolean; role: string; token: string };
  };
  rt.join = () => ({ ok: true, role: 'MEMBER', token: 't' });

  const c = makeClient('sess-X1');
  f.room.onJoin(c, { token: undefined });
  eq(c.left.length, 1, '★ 必须出声拒绝(不是静默放行)');
  eq(c.left[0]?.code, 4002, '走 4002 通道');
  eq(f.room.seatKeys.size, 0, '★ 不建绑定 —— 旁表不留房间从没收过的键');

  /* 正对照:真 join 时那条核对不许误伤。 */
  const g = makeRoom();
  const c2 = makeClient('sess-X2');
  g.room.onJoin(c2, {});
  eq(c2.left.length, 0, '正对照:真入场不被 4002 拒');
  eq(g.room.seatKeys.get('sess-X2'), 'sess-X2', '正对照:绑定照建');
});

/* ═══════════════ 2. P2 移除侧:可观测 + 可重试 ═══════════════ */

test('FND131-5 ★P2 移除侧抛错:席位照清、失败可见、下一帧重试成功', () => {
  /* 变红条件:回到修前形态(世界侧放最后且无 try / 无队列)⇒ 断言 1/2 红
     (`leave()` 抛,测试直接失败),去掉队列 ⇒ 断言 4 red。 */
  const { rt, host } = makeRuntime('r131f');
  rt.join({ userId: 'u_a' });
  eq(rt.lastRemoveApplied, null, '前置:还没移除过任何东西');

  host.knobs.throwRemoveTimes = 2;             /* 两次都抛 ⇒ 立即重试也失败,进队列 */
  const left = rt.leave('u_a');
  eq(left, true, '主动退房必须回 true(不能因为世界侧抛就整条被吞)');
  eq(rt.members.has('u_a'), false, '★ 席位仍然清干净(不留\"世界里有人、房里没人\"的分裂)');
  eq(rt.state.players.some((p) => p.id === 'u_a'), false, '实体行也清掉');
  eq(rt.lastRemoveApplied, false, '★★ 可观测量:世界侧移除**失败**(修前这里没有任何地方能看出来)');
  ok(String(rt.lastRemoveError).includes('世界侧移除失败'),
    `错因可读(实得:${String(rt.lastRemoveError)})`);

  const done = rt.retryPendingWorldRemovals();
  eq(done, ['u_a'], '★★ 重试点:下一帧重试成功(修前:世界侧刚体/AOI/vitals 永远留着)');
  eq(rt.lastRemoveApplied, true, '重试成功后可观测量翻成 true');
  eq(host.removed, ['u_a'], '世界侧确实被移除了一次(两次抛 + 一次成功)');
  eq(rt.retryPendingWorldRemovals(), [], '队列已空 —— 不会无限重试');
});

test('FND131-6 ★P2 负对照:正常宿主下移除只发生一次(重试不等于每次都多调)', () => {
  /* 变红条件:把「一次立即重试」写成无条件两遍 ⇒ 断言 1 红
     (`host.removed` 会变成 ['u_a','u_a'] —— 下游会收到两次移除事件)。 */
  const { rt, host } = makeRuntime('r131g');
  rt.join({ userId: 'u_a' });
  rt.leave('u_a');
  eq(host.removed, ['u_a'], '★ 成功一次就停:不重复调 removePlayer');
  eq(rt.lastRemoveApplied, true, '可观测量 = true');
  eq(rt.retryPendingWorldRemovals(), [], '队列空:没有任何待重试项');
  eq(rt.lastRemoveError, null, '没有失败就不留错因(可观测量不撒谎)');
});

/* ═══════════════ 3. P2 SLEEPING 时不再早退 ═══════════════ */

test('FND131-7 ★P2 休眠房里 step 也回收:到期席位与世界刚体一起清(帧号不动)', () => {
  /* 变红条件:把 `reapExpiredDisconnects()` 挪回 status 早退**之后**(修前)⇒ 断言 2/3 红。 */
  const { rt, host, c } = makeRuntime('r131h');
  rt.join({ userId: 'u_a' });
  rt.join({ userId: 'u_b' });
  rt.leave('u_b');
  rt.disconnect('u_a');
  eq(rt.sleep(), true, '前置:房间进入 SLEEPING(全员断线后空闲休眠的同一态)');
  c.advance(RECONNECT_GRACE_MS + 1);
  const tick0 = rt.state.meta.tick;

  const pkt = rt.step(null);
  eq(pkt.length, 0, '休眠房不发包(既有契约不变)');
  eq(rt.state.meta.tick, tick0, '★ 休眠房不推进帧号(既有契约不变)');
  eq(rt.members.has('u_a'), false, '★★ 到期席位必须被回收 —— 修前 step 早退,这条恒 false');
  eq(rt.state.players.some((p) => p.id === 'u_a'), false, '实体行一并移除');
  ok(host.removed.includes('u_a'), '★★ 世界侧也移除(修前它会一直挂到房间被销毁)');
});

test('FND131-8 ★P2 负对照:宽限期**内**的席位在休眠房里也不许被收', () => {
  /* 变红条件:把回收写成\"不看 disconnectedAtMs\"(无条件清)⇒ 断言 1/2 红。 */
  const { rt, host, c } = makeRuntime('r131i');
  rt.join({ userId: 'u_a' });
  rt.disconnect('u_a');
  rt.sleep();
  c.advance(1_000);                            /* 远在 30s 宽限内 */

  rt.step(null);
  eq(rt.members.get('u_a')?.connected, false, '★ 席位还在(宽限期内他随时能回来)');
  eq(rt.state.players.some((p) => p.id === 'u_a'), true, '实体行也还在');
  eq(host.removed, [], '世界侧没被移除');
});

test('FND131-9 ★P2 容量按\"活着的席位\"算:超期未回收的席位不再占位', () => {
  /* 变红条件:把容量判据改回 `members.size`(修前)⇒ 断言 1 红(误报\"房间已满\")。 */
  const a = makeRuntime('r131j', 1);
  a.rt.join({ userId: 'u_a' });
  a.rt.disconnect('u_a');
  a.c.advance(RECONNECT_GRACE_MS + 1);         /* 超期,但**不 step**(模拟\"还没人触发回收\") */
  const okJoin = a.rt.join({ userId: 'u_b' });
  eq(okJoin.ok, true, '★★ 零在线房间不许误报\"房间已满\"(修前 members.size 仍含超期席位)');

  /* 负对照:同一个容量,断线**在宽限期内** ⇒ 那条席位继续占位。 */
  const b = makeRuntime('r131k', 1);
  b.rt.join({ userId: 'u_a' });
  b.rt.disconnect('u_a');
  b.c.advance(1_000);
  const rejected = b.rt.join({ userId: 'u_b' });
  eq(rejected.ok, false, '★ 负对照:宽限期内的断线席位**仍然**占容量');
  eq(rejected.reason, '房间已满', '拒因就是\"房间已满\"');
  eq(b.rt.members.has('u_a'), true, '且那条席位没被顺手删掉(宽限期是他的)');
});

/* ═══════════════ 4. P2 per-player 表穷尽清理 ═══════════════ */

test('FND131-10 ★P2 真 WorldSim:离场清干净五张玩家表 + vitals 元素抗性', () => {
  /* 变红条件:删掉 world_sim `removePlayer` 里对应的那一行(或 vitals.unregister 的
     `resists.delete`)⇒ 对应的\"后\"断言红。前置断言是**负对照**:不清理时它们恒真。 */
  const sim = new WorldSim({ sizeCells: 16, mobs: false, wiring: false, seed: 5 });
  sim.addPlayer('p1', 2.5, 2.5);
  /* 用**生产**入口把「等级 / 装备 / 上限基准」写进去(不直接塞 Map)。 */
  sim.restoreFromProfile('p1', { level: 30, hp: 400, x: 2.5, y: 2.5, z: 0, weaponId: 7001 });
  eq(sim.vitals.setElementResist('p1', 'FIRE', 0.5), true, '前置:FIRE 抗性 0.5 在身');

  const internals = sim as unknown as {
    partyTeams: Map<string, string>;
    downedStates: Map<string, unknown>;
    baseMaxHp: Map<string, number>;
  };
  internals.partyTeams.set('p1', 'RED');
  internals.downedStates.set('p1', { playerId: 'p1' } as unknown);

  /* ── 前置(非默认值)── */
  eq(sim.levelOf('p1'), 30, '前置:等级 30 在权威里');
  eq(sim.weaponOf('p1'), 7001, '前置:装备 7001 在档案里');
  eq(sim.partyTeamOf('p1'), 'RED', '前置:队籍 RED');
  ok(sim.downedOf('p1') !== undefined, '前置:倒地态在册');
  eq(internals.baseMaxHp.has('p1'), true, '前置:上限基准已写入');
  eq(sim.vitals.elementResistOf('p1', 'FIRE'), 0.5, '前置:抗性 0.5');

  eq(sim.removePlayer('p1'), true, '移除玩家');

  /* ── 后(全部回到默认)── */
  eq(sim.levelOf('p1'), 1, '★★ 等级不许跨会话继承(回到 1)');
  eq(sim.weaponOf('p1'), undefined, '★★ 装备档案清掉(武器不许跨会话继承)');
  eq(sim.partyTeamOf('p1'), null, '★★ 队籍清掉(不许一进场就算进上一局的红队)');
  eq(sim.downedOf('p1'), undefined, '★★ 倒地态清掉(不许重连即\"已倒下\")');
  eq(internals.baseMaxHp.has('p1'), false, '★★ 上限基准清掉(不许与新的 100 打架)');
  eq(sim.vitals.elementResistOf('p1', 'FIRE'), 1, '★★ 元素抗性清掉(回到中性 1.0)');

  /* 负对照:同一套写入但**不**调 removePlayer ⇒ 全部残留(证明\"后\"那组不是恒真)。 */
  const keep = new WorldSim({ sizeCells: 16, mobs: false, wiring: false, seed: 5 });
  keep.addPlayer('p1', 2.5, 2.5);
  keep.restoreFromProfile('p1', { level: 30, hp: 400, x: 2.5, y: 2.5, z: 0, weaponId: 7001 });
  keep.vitals.setElementResist('p1', 'FIRE', 0.5);
  eq(keep.levelOf('p1'), 30, '负对照:不调 removePlayer ⇒ 等级仍在');
  eq(keep.vitals.elementResistOf('p1', 'FIRE'), 0.5, '负对照:不调 removePlayer ⇒ 抗性仍在');
});

/* ═══════════════ 5. P2 sleep.ts 世代维 ═══════════════ */

test('FND131-11 ★P2 睡眠登记带世代:换代前幂等返回旧窗口,换代后是新窗口', () => {
  /* 变红条件:把 `bumpSleepGeneration` 的 `players.clear()` 删掉 ⇒ 断言 3/4 红
     (重置世界后 `beginSleep` 仍把上一世代的 `untilMs` 原样返回)。 */
  clearSleepRegistry();
  const room = 'room_131_sleep';
  eq(sleepGenerationOf(room), 0, '前置:从未换过代 = 0');

  const first = beginSleep(room, 'p1', 1_000);
  eq(first.alreadySleeping, false, '首次入睡');
  eq(first.record.untilMs, 61_000, '窗口 = now + 60s');

  /* 负对照(换代前):同一时刻再睡 ⇒ 幂等,返回**同一条**记录。 */
  const again = beginSleep(room, 'p1', 1_000);
  eq(again.alreadySleeping, true, '★ 换代前:幂等(不叠加计时)');
  eq(again.record.untilMs, 61_000, '换代前返回的是**旧世代**那条窗口(正是缺陷形态)');

  eq(bumpSleepGeneration(room), 1, '★ 换代:世代号 +1');
  eq(sleepGenerationOf(room), 1, '读口如实反映世代');
  eq(sleepingCount(room), 0, '★★ 换代把上一世代的窗口全部作废');
  eq(sleepStateOf(room, 'p1', 1_000).sleeping, false, '★★ 旧窗口不再算\"在睡\"');

  const fresh = beginSleep(room, 'p1', 1_000);
  eq(fresh.alreadySleeping, false, '★★ 换代后是一次**新的**入睡(不是继承旧窗口)');
  eq(fresh.record.untilMs, 61_000, '新窗口 = 新的 now + 60s');
  ok(fresh.record !== first.record, '而且是一条**新记录**(不是同对象)');
  clearSleepRegistry();
});

test('FND131-12 ★P2 接线:RESET_WORLD 成功才换代;越权失败不换代', () => {
  /* 变红条件:把 dispatchAction 里那行 `bumpSleepGeneration` 删掉 ⇒ 断言 2 红;
     把钩子挂到失败分支 ⇒ 断言 4 红。 */
  const c = makeClock();
  const host = makeHost();
  host.resetWorld = (o) => ({ applied: true, seed: o.seed });
  const rt = new RoomRuntime({
    roomId: 'room_131_reset',
    ownerId: OWNER,
    clock: c.clock,
    host: host as unknown as WorldSaveHost,
  });
  rt.join({ userId: OWNER });
  clearSleepRegistry();
  eq(sleepGenerationOf('room_131_reset'), 0, '前置:世代 0');

  const ok1 = rt.dispatchAction(OWNER, RoomAction.RESET_WORLD, { confirm: true, seed: 7 });
  eq(ok1.ok, true, '前置:房主的重置成功');
  eq(sleepGenerationOf('room_131_reset'), 1, '★★ 世界换代 ⇒ 睡眠登记换代(修前这段没有接线)');

  /* 负对照:GUEST 越权 ⇒ 动作失败 ⇒ 世代**不动**。 */
  rt.join({ userId: GUEST });
  const denied = rt.dispatchAction(GUEST, RoomAction.RESET_WORLD, { confirm: true, seed: 8 });
  eq(denied.ok, false, '负对照:GUEST 越权被拒');
  eq(sleepGenerationOf('room_131_reset'), 1, '★ 失败分支不换代(钩子只挂在成功那一刻)');
});

/* ═══════════════ 6. P3 死字段 ═══════════════ */

test('FND131-13 ★P3 `Member.seq` 已删:成员会话不再混写房间帧号', () => {
  /* 变红条件:把 `seq` 写回 `MemberSession`(或 `snapshotFor` 里那行赋值)⇒ 断言 1 红。
     为什么删:全仓 0 读取,而唯一写点写的是 `state.meta.tick`(房间帧号),
     把**两个时钟**混进同一个字段。 */
  const { rt } = makeRuntime('r131l');
  rt.join({ userId: 'u_a' });
  const m = rt.members.get('u_a');
  ok(m !== undefined, '前置:席位在');
  eq('seq' in (m as unknown as Record<string, unknown>), false, '★ 成员会话里没有 `seq` 这个字段');
  /* 快照仍可用(删字段不该影响编码)。 */
  ok(rt.snapshotFor('u_a').length > 0, '快照照常产出(行为不受删字段影响)');
});

report('WS-FND-131');