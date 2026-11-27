/**
 * WS-FND-200 · 独自倒地的自动复活。
 *
 * 守的是「单人被怪打倒不会永久卡死」:`soloRespawnSec > 0` 时,倒地满该秒数且没有人在救,
 * 玩家被送回 `respawnPoint` 并按半血复活;缺省(0)时行为与此前完全一致(倒地一直倒着)。
 *
 * 运行:`node tests/WS-FND-200-solo-respawn.test.ts`
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';

function tickSlow(sim: WorldSim, n: number): void {
  for (let i = 0; i < n * FAST_PER_SLOW; i += 1) sim.tick();
}

function downedWorld(opts: { soloRespawnSec?: number }): WorldSim {
  const sim = new WorldSim({ sizeCells: 120, respawnPoint: { x: 60.5, y: 60.5 }, ...opts });
  sim.addPlayer('p1', 24, 24);
  sim.vitals.applyDamage('p1', 100000, { ignoreIframe: true });
  return sim;
}

test('FND200-1 开着:倒地满秒数 ⇒ 回重生点、半血、不再倒地、有计数', () => {
  const sim = downedWorld({ soloRespawnSec: 2 });
  ok(sim.vitals.get('p1')!.downed, '前置:确实倒地了');
  tickSlow(sim, 1);
  ok(sim.downedOf('p1') !== undefined, '前置:慢帧建出了泡泡状态');
  tickSlow(sim, 3);
  ok(sim.vitals.get('p1')!.downed, '没到 2 秒 ⇒ 仍倒地(不是一倒地就弹回去)');
  eq(sim.soloRespawns, 0, '没到点 ⇒ 无计数');
  tickSlow(sim, 3);
  const v = sim.vitals.get('p1')!;
  eq(v.downed, false, '★ 满 2 秒 ⇒ 复活');
  ok(v.hp > 0 && Math.abs(v.hp - v.maxHp * 0.5) < 1, `半血复活(hp=${v.hp}/${v.maxHp})`);
  const p = sim.playerPosition('p1')!;
  ok(Math.hypot(p.x - 60.5, p.y - 60.5) < 1.5, `★ 回到重生点(实得 ${p.x.toFixed(1)},${p.y.toFixed(1)})`);
  eq(sim.downedOf('p1'), undefined, '泡泡状态清掉');
  eq(sim.soloRespawns, 1, '计数 +1');
  tickSlow(sim, 4);
  eq(sim.soloRespawns, 1, '复活后不会再触发');
});

test('FND200-2 缺省关闭:倒地一直倒着(既有行为不变)', () => {
  const sim = downedWorld({});
  tickSlow(sim, 30);
  ok(sim.vitals.get('p1')!.downed, '★ 关着时 15 秒后仍倒地');
  eq(sim.soloRespawns, 0, '无计数');
});

test('FND200-3 非法秒数(NaN / 负数)等于关闭', () => {
  for (const bad of [Number.NaN, -3, 0]) {
    const sim = downedWorld({ soloRespawnSec: bad });
    tickSlow(sim, 12);
    ok(sim.vitals.get('p1')!.downed, `soloRespawnSec=${String(bad)} ⇒ 不复活`);
  }
});

report('WS-FND-200');
