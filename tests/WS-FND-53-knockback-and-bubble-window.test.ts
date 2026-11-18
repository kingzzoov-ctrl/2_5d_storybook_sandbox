/**
 * WS-FND-53 —— 两条**裁决**的实现判据(owner 2026-11-16,见 `docs/DECISIONS.md`):
 *
 * | 裁决 | 内容 | 本文件钉住 |
 * |---|---|---|
 * | **D-09** | 受击击退 = `min(2, 实际伤害 / 20)` 格,方向**远离攻击者** | FND53-1/2/3 |
 * | **D-10** | 泡泡连击窗口 = **5 秒**(复用 `BUBBLE_TRAP_SEC`) | FND53-4/5/6 |
 *
 * ## 为什么这两条必须单独成套件
 * D-09 接上之后 `WS-10` 的三条既有判据(救援半径 / 位置不变)会红 —— 那三条测的是
 * **复活与积分器**,不是击退;按裁决它们被改成"先移走伤害源"。于是「击退本身对不对」
 * 就**没有任何判据**了 ⇒ 本文件补上,并且用**确定性夹具**(相邻一只怪 + 一次命中),
 * 不靠长时间刷怪。
 *
 * ⚠️ 断言右侧一律**字面量 / 由实际伤害算出的期望**(`min(2, dmg/20)`),不从被测模块取期望。
 */
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import {
  LIVE_BUBBLE_INITIAL,
  liveBubbleHit,
  tickLiveBubble,
} from '../server/src/combat/live_bubble.ts';

/** 会主动打人的怪(WS-10 的夹具用同一只)。 */
const MOB = 'mob_lava_elem';
/** 玩家与怪都在这一行上:怪在西侧 ⇒ 击退方向应为 **+x**(远离怪)。 */
const PLAYER_X = 32.5;
const MOB_X = 30.5;

/** 一只怪贴着玩家的一次命中的最小夹具(照 WS-10 的 `partyWorld` 写法)。 */
function hitScene(): WorldSim {
  /* ⚠️ 两个必须:1 `mobs` 不能关 —— 关掉后 `stepMobHits` 直接 return(命中链路整段不跑);
     2 必须喂 `setMobPlayers` —— 没有玩家视图的怪不会选目标,永远不打人。 */
  const s = new WorldSim({ sizeCells: 120 });
  s.addPlayer('p1', PLAYER_X, 32.5);
  s.setMobPlayers([{
    id: 'p1', x: PLAYER_X, y: 32.5, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [711], playingInstrument: false,
  }]);
  s.addMob(`${MOB}#1`, 'MEADOW', MOB_X, 32.5);
  return s;
}

/** 推到**第一次**命中为止;返回帧号,没有命中返回 -1。 */
function untilHit(s: WorldSim, max = 1800): number {
  for (let i = 1; i <= max; i += 1) {
    s.tick();
    if (s.lastHits.length > 0) return i;
  }
  return -1;
}

/* ══════════════════ D-09 受击击退 ══════════════════ */

test('FND53-1 ★ 受击位移 = min(2, 实际伤害 / 20) 格(D-09 的公式本身)', () => {
  const s = hitScene();
  const at = untilHit(s);
  ok(at > 0, `应有一次命中(实测第 ${at} 帧;0 说明预警/命中链路没跑)`);

  const hit = s.lastHits[0]!;
  ok(hit.applied > 0, `命中的实际伤害应 > 0(实测 ${hit.applied})`);
  /* 命中之后立刻移走怪 —— 否则第二、三次命中会继续推,位移就不是"一次命中"的量。 */
  s.mobHost.removeMob(`${MOB}#1`);

  const expected = Math.min(2, hit.applied / 20);
  for (let i = 0; i < 40; i += 1) s.tick(); /* 击退是慢帧两段推,给足余量 */

  const moved = s.playerPosition('p1')!.x - PLAYER_X;
  near(moved, expected, 1e-6,
    `位移应精确等于 min(2, ${hit.applied}/20) = ${expected}(实测 ${moved.toFixed(4)})`);
});

test('FND53-2 ★ 方向是**远离攻击者**(怪在西侧 ⇒ 玩家被推向 +x)', () => {
  const s = hitScene();
  ok(untilHit(s) > 0, '前置:先吃一次命中');
  s.mobHost.removeMob(`${MOB}#1`);
  for (let i = 0; i < 40; i += 1) s.tick();
  ok(s.playerPosition('p1')!.x > PLAYER_X,
    `应被推向 +x(实测 ${s.playerPosition('p1')!.x.toFixed(4)},起点 ${PLAYER_X})`);
});

test('FND53-3 上限:任何伤害推出来都不超过 2 格(大伤害不许把人推出地图)', () => {
  /* 不断言"一定达到 2"—— 那取决于怪物等级(不是本判据要管的事);
     这里钉的是**上界**,而 2 是 D-09 的裁决值。 */
  const s = hitScene();
  ok(untilHit(s) > 0, '前置:先吃一次命中');
  s.mobHost.removeMob(`${MOB}#1`);
  for (let i = 0; i < 40; i += 1) s.tick();
  ok(s.playerPosition('p1')!.x - PLAYER_X <= 2 + 1e-9,
    `位移不得超过 2 格(实测 ${(s.playerPosition('p1')!.x - PLAYER_X).toFixed(4)})`);
});

/* ══════════════════ D-10 连击窗口 ══════════════════ */

test('FND53-4 ★ 连击窗口 5 秒:4.5 秒仍算连中,5.5 秒已过期(D-10 的边界两侧)', () => {
  let s = LIVE_BUBBLE_INITIAL;
  s = liveBubbleHit(s).state; /* 第 1 发 */
  s = liveBubbleHit(s).state; /* 第 2 发 */
  eq(s.stacks, 2, '前置:两发累计 = 2 层');

  /* 4.5 秒(9 × 0.5,慢帧步长)⇒ 仍在窗口内。 */
  let inside = s;
  for (let i = 0; i < 9; i += 1) inside = tickLiveBubble(inside, 0.5);
  eq(inside.stacks, 2, '4.5 秒 < 5 秒 ⇒ 层数保持 2(没被清)');
  const third = liveBubbleHit(inside);
  eq(third.trapped, true, '★ 窗口内第 3 发 ⇒ 困住');

  /* 5.5 秒 ⇒ 过期。 */
  let outside = s;
  for (let i = 0; i < 11; i += 1) outside = tickLiveBubble(outside, 0.5);
  eq(outside.stacks, 0, '★ 5.5 秒 ≥ 5 秒 ⇒ 层数归零');
  const after = liveBubbleHit(outside);
  eq(after.trapped, false, '超窗后这一发只算第 1 发 ⇒ 不困住');
  eq(after.state.stacks, 1, '层数从 1 重新累计');
});

test('FND53-5 困住期间再打**不续杯**(既有语义不回归:层数从 0 重计,trapSec 不被刷新)', () => {
  let s = LIVE_BUBBLE_INITIAL;
  for (let i = 0; i < 3; i += 1) s = liveBubbleHit(s).state;
  eq(s.trapSec, 5, '三发 ⇒ 困住 5 秒(BUBBLE_TRAP_SEC 的字面值)');
  for (let i = 0; i < 4; i += 1) s = tickLiveBubble(s, 0.5); /* 2 秒过去 */
  const trappedLeft = s.trapSec;
  const again = liveBubbleHit(s);
  eq(again.trapped, false, '被困期间再打不会"再困一次"');
  eq(again.state.trapSec, trappedLeft, '★ 剩余困住时间不变(不许续杯)');
  eq(again.state.stacks, 1, '层数从 0 重新累计');
});

test('FND53-6 ★ 世界侧同样生效:慢帧推进让层数过期(不是只有纯函数对)', () => {
  const a = assemble({ roomId: 'r_bub_window', ownerId: 'p1', sizeCells: 24, mobs: false });
  a.runtime.join({ userId: 'p1' });
  a.runtime.join({ userId: 'p2' });
  const sim = a.host as unknown as WorldSim;
  for (const id of ['p1', 'p2']) {
    if (!sim.physics.bodies.has(id)) sim.addPlayer(id, 12.5, 12.5);
  }
  /* 前置:道具必须在背包里(扣减按总量守恒)。 */
  const src = 'seed:227';
  a.runtime.grantItemSource('p1', src);
  const seeded = a.runtime.applyInventory('p1', { ops: [{ itemId: 227, delta: 6, source: src }] });
  if (!seeded.allowed) throw new Error('前置失败:塞不进 227');

  const fire = () => a.runtime.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 227, targetId: 'p2' });
  const trappedOf = (r: { effect?: unknown }): boolean =>
    (r.effect as Record<string, string | number | boolean>).trapped === true;

  eq(trappedOf(fire()), false, '第 1 发不困住');
  eq(trappedOf(fire()), false, '第 2 发不困住');
  eq(trappedOf(fire()), true, '★ 窗口内第 3 发 ⇒ 困住');

  /* 换一个玩家验过期:两发 → 推 7 秒 → 第 3 发不该困住。 */
  a.runtime.join({ userId: 'p3' });
  if (!sim.physics.bodies.has('p3')) sim.addPlayer('p3', 12.5, 12.5);
  const fireAt = (t: string) =>
    a.runtime.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 227, targetId: t });
  eq(trappedOf(fireAt('p3')), false, 'p3 第 1 发不困住');
  eq(trappedOf(fireAt('p3')), false, 'p3 第 2 发不困住');
  sim.advance(140); /* 14 个慢帧 = 7 秒 > 5 秒窗口 */
  eq(sim.liveBubbleOf('p3').stacks, 0, '★ 7 秒后层数已过期(世界侧慢帧真的在推进窗口)');
  eq(trappedOf(fireAt('p3')), false, '★ 过期后的这一发只算第 1 发,不困住');
});

report('WS-FND-53-knockback-and-bubble-window');