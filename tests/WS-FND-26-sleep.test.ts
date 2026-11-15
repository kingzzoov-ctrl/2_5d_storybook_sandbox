/**
 * WS-FND-26 —— **`SLEEP`(玩家上床睡觉)接线**。
 *
 * ## 这个套件为什么存在
 *
 * `SLEEP` 此前只回 `NOT_IMPLEMENTED`(`actions/sleep.ts` 的占位)⇒ 玩家在
 * 卧室里「睡觉」这件事在线上**不存在**:没有入睡、没有时长、没有中断。
 * 手册 §3.8 的卧室增益(每秒回血 + 打盹)只活在 `rooms/effects.ts` 里,
 * 没有一个**动作入口**去登记「这个人现在在睡、睡到什么时候」。
 *
 * 本套件钉的是那份**状态登记**(不是「回了 OK」):
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 卧室里 `SLEEP` ⇒ `OK` + 状态里能读到「睡着 + 到期时刻」 | 去掉 `beginSleep` 登记 |
 * | 2 | 再 `SLEEP` ⇒ `OK` 但**不叠加**(到期时刻不变) | 幂等分支改成无条件重建 |
 * | 3 | 不在卧室 ⇒ `INVALID` 且**状态没被写** | 失败路径也写状态 / 不判卧室 |
 * | 4 | 到期后查询 ⇒ 不再睡(可注入时钟,不 sleep 真秒) | `sleepStateOf` 不判 `untilMs` |
 * | 5 | 中断(离开卧室)⇒ 结束睡眠 | 离开分支不 `endSleep` |
 * | 6 | `GUEST` 也能睡(`SLEEP` 是 `baseline`,不发明权限) | 动作里加一道臆造的权限闸 |
 *
 * ## 用**真装配**
 *
 * `assemble()` 造出世界与运行时,卧室盖在 `WorldSim` 上,动作走
 * `rt.dispatchAction`。卧室判定**不在这里重写**:测试读的是 `WorldSim`
 * 喂给 `rooms/effects.ts` 判定的同一份结果(`roomEffectOf().inBedroom`)。
 *
 * ⚠️ 别与 `RoomRuntime.sleep()` 搞混 —— 那是**房间休眠**,不是玩家睡觉。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';
import {
  SLEEP_DURATION_MS,
  clearSleepRegistry,
  setSleepClock,
  sleepStateOf,
  sleepingCount,
} from '../server/src/net/actions/sleep.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

/** 假时钟(ms)。判据靠**推进这个变量**模拟入睡/到期,绝不 sleep 真秒。 */
let now = 1_000_000;
setSleepClock(() => now);

/** 每个用例开始前:清空睡眠登记 + 归零假时钟(防模块级状态跨用例泄漏)。 */
function reset(): void {
  clearSleepRegistry();
  now = 1_000_000;
}

type Fixture = {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: WorldSim;
  roomId: string;
};

/**
 * 在 `WorldSim`(生产路径)上盖一间带卧室核心件的封闭小屋。
 * 手法与 `tests/WS-03` 的 `buildClosedRoomSim` / `makeRoomWith` 一致。
 */
function buildBedroom(sim: WorldSim, x0 = 3, y0 = 3, w = 9): { cx: number; cy: number } {
  const WALL = 351;
  for (let dy = 0; dy < w; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const edge = dx === 0 || dy === 0 || dx === w - 1 || dy === w - 1;
      sim.setCell(x0 + dx, y0 + dy, edge ? { obj: WALL, floor: 1, elev: 1 } : { floor: 1, elev: 1 });
    }
  }
  /* 南墙开门(363):完全封闭的房间不会被识别。 */
  sim.setCell(x0 + 3, y0 + w - 1, { obj: 363, floor: 1, elev: 1 });
  /* 517「云端软绵绵单人床」= 卧室(COZY_BEDROOM)核心件。 */
  sim.setCell(x0 + 2, y0 + 2, { obj: 517 });
  return { cx: x0 + Math.floor(w / 2), cy: y0 + Math.floor(w / 2) };
}

/**
 * 造一个真装配的房间。`inBedroom: false` = 只加玩家、不盖卧室。
 *
 * ⚠️ 房间效果状态(含 `effects.ts` 的 `inBedroom`)由 **2Hz 慢帧**刷新 ⇒
 *   必须推 20 帧(快帧 20Hz),否则 `roomEffectOf` 还是旧值 / `undefined`,
 *   动作会把「还没刷新」误报成「不在卧室」。
 */
function makeRoom(opts: { inBedroom?: boolean; asGuest?: boolean } = {}): Fixture {
  const roomId = 'r_sleep';
  const a = assemble({
    roomId,
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    mobs: false,
    rng: mulberry32(7),
  });
  a.runtime.join({ userId: 'p1', asGuest: opts.asGuest === true });

  /* `assemble().host` 运行期就是 `WorldSim`(见 `index.ts` 的 `createHost`);
     类型上是结构化 `WorldSaveHost`,故这里窄化到测试要用的口。 */
  const sim = a.host as unknown as WorldSim;
  let at = { x: 12.5, y: 12.5 };
  if (opts.inBedroom !== false) {
    const c = buildBedroom(sim);
    at = { x: c.cx + 0.5, y: c.cy + 0.5 };
  }
  /* 世界侧要「认识」这个玩家:刚体由 `addPlayer` 建,`tickRoomEffects` 才会计入。 */
  sim.addPlayer('p1', at.x, at.y);
  for (let i = 0; i < 20; i += 1) sim.tick();
  return { rt: a.runtime, sim, roomId };
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND26-1 在卧室 SLEEP ⇒ OK,状态里能读到「睡着了 + 到期时刻」', () => {
  reset();
  const { rt, roomId } = makeRoom();

  const r = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(r.ok, true, `卧室里睡觉应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  ok(r.effect !== undefined, '★ OK 必须带 effect(客户端靠它感知,不留静默成功)');

  const untilMs = r.effect!.untilMs as number;
  eq(r.effect!.sleeping, true, 'effect 应报告「在睡」');
  eq(r.effect!.sinceMs, now, '入睡时刻 = 现在');
  eq(untilMs, now + SLEEP_DURATION_MS, '到期时刻 = 现在 + 睡眠时长');

  const st = sleepStateOf(roomId, 'p1');
  eq(st.sleeping, true, '★ 登记表里能读到「在睡」');
  eq(st.untilMs, untilMs, '查询与回执的到期时刻必须一致(同一份事实)');
  ok(st.remainingMs > 0, `剩余时长应为正(实测 ${st.remainingMs})`);
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND26-2 同一玩家再 SLEEP ⇒ OK 但**不叠加**(到期时刻不变)', () => {
  reset();
  const { rt, roomId } = makeRoom();

  const first = rt.dispatchAction('p1', RoomAction.SLEEP);
  const untilMs = first.effect!.untilMs as number;

  now += 10_000; /* 已睡了 10 秒 */
  const again = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(again.ok, true, '已在睡时再睡仍是幂等成功(不是 INVALID)');
  eq(again.kind, 'OK', '应回 OK');
  eq(again.effect!.alreadySleeping, true, '回执应说明「已在睡」');
  eq(again.effect!.untilMs, untilMs,
    '★ 不叠加:到期时刻必须与第一次相同(叠加会把一次睡眠拖成两倍)');
  eq(sleepStateOf(roomId, 'p1').untilMs, untilMs, '登记表里也保持不变');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND26-3 不在卧室 ⇒ INVALID 且状态没被写', () => {
  reset();
  const { rt, roomId } = makeRoom({ inBedroom: false });

  const r = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(r.ok, false, '不在卧室不能睡');
  eq(r.kind, 'INVALID', '应归为 INVALID(状态不对,不是权限问题)');
  ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须带可读理由');

  eq(sleepingCount(roomId), 0, '★ 失败路径不得写状态');
  eq(sleepStateOf(roomId, 'p1'),
    { sleeping: false, sinceMs: null, untilMs: null, remainingMs: 0 },
    '★ 查询也读不到任何睡眠(没被写)');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND26-4 到期后查询 ⇒ 不再处于睡眠(用可注入时钟,不 sleep 真秒)', () => {
  reset();
  const { rt, roomId } = makeRoom();

  const r = rt.dispatchAction('p1', RoomAction.SLEEP);
  const untilMs = r.effect!.untilMs as number;
  ok(sleepStateOf(roomId, 'p1').sleeping, '前置:应已入睡');

  now = untilMs + 1; /* 直接越过到期时刻 */
  const st = sleepStateOf(roomId, 'p1');
  eq(st.sleeping, false, '★ 时间到 ⇒ 不再处于睡眠');
  eq(st.untilMs, null, '过期后不残留到期时刻');
  eq(sleepingCount(roomId), 0, '过期记录被清掉');

  /* 负对照:到期后再 SLEEP 应是**新的**窗口(不是永久睡、也不是拒绝)。 */
  const fresh = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(fresh.kind, 'OK', '到期后应能再次入睡');
  eq(fresh.effect!.untilMs, now + SLEEP_DURATION_MS, '新窗口从此刻重新计时');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND26-5 中断(离开卧室)⇒ 结束睡眠', () => {
  reset();
  const { rt, sim, roomId } = makeRoom();

  rt.dispatchAction('p1', RoomAction.SLEEP);
  ok(sleepStateOf(roomId, 'p1').sleeping, '前置:应已入睡');

  /* 走出卧室:权威位置挪到空地,推慢帧让 `effects.ts` 的 `inBedroom` 变 false。 */
  sim.setPlayerPos('p1', 23.5, 23.5);
  for (let i = 0; i < 20; i += 1) sim.tick();
  eq(sim.roomEffectOf('p1')!.inBedroom, false, '前置:已离开卧室(判定来自 effects.ts)');

  const out = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(out.kind, 'INVALID', '不在卧室 ⇒ INVALID');
  eq(sleepStateOf(roomId, 'p1').sleeping, false, '★ 离开卧室 = 中断 ⇒ 睡眠必须结束');
  eq(sleepingCount(roomId), 0, '登记被清掉(不留「已离开却还在睡」的孤儿记录)');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND26-6 GUEST 也能睡(SLEEP 是 baseline:按真实权限矩阵,不发明规则)', () => {
  reset();
  const { rt } = makeRoom({ asGuest: true });

  const r = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(r.ok, true, `GUEST 带 baseline ⇒ 允许睡觉(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', 'guest 在卧室里应能睡 —— 不额外臆造一道权限闸');
});

report('WS-FND-26');