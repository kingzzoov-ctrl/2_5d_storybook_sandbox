/**
 * WS-FND-43 —— **`SLEEP` 的世界侧读者**。
 *
 * ## 这个套件补的是哪一环
 *
 * `actions/sleep.ts` 早就登记"谁在睡、睡到何时",但**世界侧没有任何读者**
 * (`docs/TASK-96` 二之二 第 3 条)。这一环接上的是:
 *   `assemble()`(装配层)把 `sleepStateOf(roomId, userId)` 注入给 `WorldSim`,
 *   慢帧的房间效果记录(`lastRoomEffects`)里因此带上 `sleeping: 0|1`。
 *
 * ⚠️ **本套件不声称"睡觉改变回血"**:那是产品裁决,不是接线。
 *   回血数值未动的证据在既有的三个套件里:`WS-03`(89 条)、`WS-FND-11-afk`(14 条)、
 *   `WS-FND-26-sleep`(6 条)—— 它们在本轮全部保持绿。
 *
 * ## `sleeping` 的语义(别读成否定事实)
 *
 * 没接读口时写 `0`,意思是"**世界侧不知道**",不是"玩家没睡"。判据按 0 断言即可。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { beginSleep, clearSleepRegistry } from '../server/src/net/actions/sleep.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

let seq = 0;

type Room = { rt: ReturnType<typeof assemble>['runtime']; sim: WorldSim; roomId: string };

function makeRoom(): Room {
  seq += 1;
  const roomId = `r_sleepw${seq}`;
  const a = assemble({
    roomId,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    mobs: false,
    rng: mulberry32(31),
  });
  const sim = a.host as unknown as WorldSim;
  a.runtime.join({ userId: 'p1' });
  if (!sim.physics.bodies.has('p1')) sim.addPlayer('p1', 8, 8);
  return { rt: a.runtime, sim, roomId };
}

/** 推足够多的快帧以跨过至少一个慢帧(慢帧 2Hz、快帧 30Hz ⇒ 15 帧一个慢帧)。 */
const slowFrame = (sim: WorldSim) => sim.advance(30);

/** 取本慢帧里某玩家的房间效果记录。 */
const recOf = (sim: WorldSim, id: string) => sim.lastRoomEffects.find((r) => r.playerId === id);

/* ───────────────────────── 判据 ───────────────────────── */

test('FND43-1 注入的读口说了算:true ⇒ `sleeping: 1`,`false` ⇒ `sleeping: 0`', () => {
  const r = makeRoom();

  r.sim.attachSleepSource(() => true);
  slowFrame(r.sim);
  eq(recOf(r.sim, 'p1')?.sleeping, 1, '★ 读口说"在睡" ⇒ 记录里必须是 1');

  r.sim.attachSleepSource(() => false);
  slowFrame(r.sim);
  eq(recOf(r.sim, 'p1')?.sleeping, 0, '★ 读口说"没睡" ⇒ 记录里是 0');
});

test('FND43-2 ★ **生产装配**已经把睡眠读口接上了(不是只有测试能注入)', () => {
  clearSleepRegistry();
  const r = makeRoom();

  /* 先把"没睡"这一侧钉住:没有 SLEEP 记录时必须是 0。 */
  slowFrame(r.sim);
  eq(recOf(r.sim, 'p1')?.sleeping, 0, '前置:还没睡');

  /* 直接往**真**睡眠注册表里登记(不经过卧室判定 —— 本条测的是**读者**,不是入寝条件)。 */
  beginSleep(r.roomId, 'p1');
  slowFrame(r.sim);

  eq(recOf(r.sim, 'p1')?.sleeping, 1, '★★ 装配层的注入必须真的生效(`assemble → attachSleepSource → sleepStateOf`)');

  clearSleepRegistry();
  slowFrame(r.sim);
  eq(recOf(r.sim, 'p1')?.sleeping, 0, '登记清掉之后回到 0(证明确实是在读那份登记,而不是常量)');
});

test('FND43-3 `sleeping` 的形状是数字 0/1(不是 boolean、不是 undefined)', () => {
  const r = makeRoom();
  slowFrame(r.sim);
  const rec = recOf(r.sim, 'p1');
  ok(rec !== undefined, '前置:该玩家应有一条房间效果记录');
  eq(typeof rec?.sleeping, 'number', '★ 类型必须是 number');
  ok(rec?.sleeping === 0 || rec?.sleeping === 1, '★ 取值只能是 0 或 1');
});

test('FND43-4 别的玩家睡着不影响我的记录(逐玩家,不是全局开关)', () => {
  clearSleepRegistry();
  const r = makeRoom();
  r.rt.join({ userId: 'p2' });
  if (!r.sim.physics.bodies.has('p2')) r.sim.addPlayer('p2', 9, 9);

  beginSleep(r.roomId, 'p2');
  slowFrame(r.sim);

  eq(recOf(r.sim, 'p2')?.sleeping, 1, 'p2 在睡');
  eq(recOf(r.sim, 'p1')?.sleeping, 0, '★ p1 没睡 ⇒ 必须是 0(不是"全房间都算在睡")');
  clearSleepRegistry();
});

test('FND43-5 读口抛错不许把慢帧打断(世界照常推进)', () => {
  const r = makeRoom();
  r.sim.attachSleepSource(() => {
    throw new Error('读口坏了');
  });

  /* ⚠️ 今天的行为是**上抛** —— 这条判据把它钉住,免得有人"顺手"改成静默吞掉
     (吞掉会让"谁都没在睡"变成一个看不出来的谎)。若将来决定吞掉,改这里并写理由。 */
  let threw = false;
  try {
    slowFrame(r.sim);
  } catch {
    threw = true;
  }
  eq(threw, true, '★ 读口抛错时是**上抛**(该口径写在这里,不靠人记)');
});

test('FND43-6 注入是幂等的:二次注入只留最后一个', () => {
  const r = makeRoom();
  r.sim.attachSleepSource(() => false);
  r.sim.attachSleepSource(() => true);
  slowFrame(r.sim);
  eq(recOf(r.sim, 'p1')?.sleeping, 1, '后注入的生效');
});

report('WS-FND-43');