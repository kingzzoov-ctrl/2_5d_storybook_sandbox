/**
 * WS-FND-201 · 野怪营地。
 *
 * 守的是「怪有地盘」:怪由营地常驻 —— 玩家走近才刷、打死隔一阵才补、走远整营撤场;
 * 追人追到离家超过拴绳就放弃、走回家。主世界不再围着玩家现刷怪(那样一级玩家刚出镇
 * 就被围殴:2026-11-27 真浏览器实测倒地复活 4 次,一只绵羊都没打到)。
 *
 * 运行:`node tests/WS-FND-201-mob-camps.test.ts`
 */
import { eq, mulberry32, ok, report, test } from '../shared/testing/harness.ts';
import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';
import {
  REGION_DEFS, SPAWN_POINT, WORLD_CENTER, overworld, overworldCell, walkableFrom,
} from '../shared/world/overworld.ts';
import { isDeepWater } from '../shared/world/passable.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import {
  CAMP_LEASH, CAMP_MIN_GAP, CAMP_MIN_SITE_DIST, CAMP_MIN_TOWN_DIST, CAMP_RADIUS, CAMP_RESPAWN_SEC,
  CAMP_SPAWN_MIN_PLAYER_DIST, CAMP_TIER1_MIN_DIST, CAMP_WAKE_DIST, campSafePoints, planCamps, type MobCamp,
} from '../server/src/mobs/camps.ts';
import { circleWarn } from '../server/src/mobs/geometry.ts';
import { GRAZE_RADIUS, MobFsm, MobFsmState } from '../server/src/mobs/fsm.ts';
import { TOWN_SAFE_RADIUS, spawnableMobs } from '../server/src/mobs/spawner.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';

/* ═════════════════════ 规划器(纯函数,读主世界地图)═════════════════════ */

const ow = overworld();
const camps = planCamps(ow);
const N = ow.size;
const reach = walkableFrom(ow, SPAWN_POINT.x, SPAWN_POINT.y);

test('FND201-1 规划:陆地区域都有营地,每处营地的距离与落脚格都合格', () => {
  const per = new Map<string, number>();
  for (const c of camps) per.set(c.region, (per.get(c.region) ?? 0) + 1);
  for (const d of REGION_DEFS) {
    const n = per.get(d.id) ?? 0;
    if (d.id === 'town' || d.id === 'islet') eq(n, 0, `${d.name} 不摆营地`);
    else ok(n >= 2, `${d.name} 至少 2 处营地(实得 ${n})`);
  }
  /* 距离按整数格量(营地坐标带 +0.5,直接相减会差半格)。 */
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const c of camps) {
    if (seen.has(c.id)) bad.push(`${c.id} 重名`);
    seen.add(c.id);
    const cx = Math.floor(c.x);
    const cy = Math.floor(c.y);
    if (Math.hypot(cx - WORLD_CENTER, cy - WORLD_CENTER) < CAMP_MIN_TOWN_DIST) bad.push(`${c.id} 离镇心太近`);
    for (const s of ow.sites) {
      if (Math.hypot(cx - s.x, cy - s.y) < CAMP_MIN_SITE_DIST) bad.push(`${c.id} 离场地 ${s.id} 太近`);
    }
    for (const o of camps) {
      if (o !== c && Math.hypot(cx - Math.floor(o.x), cy - Math.floor(o.y)) < CAMP_MIN_GAP) bad.push(`${c.id} 与 ${o.id} 太近`);
    }
    if (c.cells.length < c.radius * c.radius) bad.push(`${c.id} 落脚格太少(${c.cells.length})`);
    for (const [x, y] of c.cells) {
      const i = y * N + x;
      const cell = overworldCell(ow, x, y);
      if (cell === null || reach[i] !== 1 || cell.obj !== 0 || ow.road[i] !== 0 || isDeepWater(cell)
        || REGION_DEFS[ow.region[i]!]?.id !== c.region || Math.hypot(x - cx, y - cy) > c.radius) {
        bad.push(`${c.id} 的落脚格 (${x},${y}) 不合格(树里 / 水里 / 路上 / 够不着 / 出了圈或出了本区)`);
        break;
      }
    }
  }
  eq(bad, [], '全部营地合格');
});

test('FND201-2 分层:离安全点近的营地只放本群系最温顺的一种,最凶的只在远处巢穴', () => {
  const safe = campSafePoints(ow);
  const bad: string[] = [];
  let near = 0;
  let lairs = 0;
  for (const c of camps) {
    const ladder = spawnableMobs(c.biome).slice().sort((a, b) => a.level - b.level);
    const gentlest = ladder[0]!.id;
    const fiercest = ladder[ladder.length - 1]!.id;
    const cx = Math.floor(c.x);
    const cy = Math.floor(c.y);
    const ds = Math.min(...safe.map((p) => Math.hypot(cx - p.x, cy - p.y)));
    const ids = c.roster.map((r) => r.mobId);
    if (ds < CAMP_TIER1_MIN_DIST) {
      near += 1;
      if (c.tier !== 0 || ids.length !== 1 || ids[0] !== gentlest) {
        bad.push(`${c.id}(离安全点 ${ds.toFixed(0)})应只有 ${gentlest},实得 ${ids.join('+')}`);
      }
    }
    /* 群系里只有两种怪时(樱花),第二种本身就是最凶的,不受这条限制。 */
    if (ladder.length > 2 && ids.includes(fiercest) && c.tier !== 2) bad.push(`${c.id} 不是巢穴却放了最凶的 ${fiercest}`);
    if (c.tier === 2) lairs += 1;
  }
  eq(bad, [], '分层与名单一致');
  ok(near > 0 && lairs > 0, `既有近处的温顺营地(${near})也有远处的巢穴(${lairs})`);
});

test('FND201-3 出生点唤醒不了任何营地;最近的营地只有绵羊;怪追到拴绳尽头也进不了镇子安全区', () => {
  const sp = { x: SPAWN_POINT.x + 0.5, y: SPAWN_POINT.y + 0.5 };
  const nearest = camps.slice()
    .sort((a, b) => Math.hypot(a.x - sp.x, a.y - sp.y) - Math.hypot(b.x - sp.x, b.y - sp.y))[0]!;
  const d = Math.hypot(nearest.x - sp.x, nearest.y - sp.y);
  ok(d > CAMP_WAKE_DIST, `★ 出生点离最近营地 ${d.toFixed(1)} 格 > 唤醒距离 ${CAMP_WAKE_DIST}`);
  eq(nearest.roster.map((r) => r.mobId), ['mob_sheep'], '★ 离出生点最近的营地只有绵羊');
  const bad = camps
    .filter((c) => Math.hypot(c.x - WORLD_CENTER, c.y - WORLD_CENTER) - c.leash <= TOWN_SAFE_RADIUS)
    .map((c) => c.id);
  eq(bad, [], `★ 没有营地的拴绳够得着镇子 ${TOWN_SAFE_RADIUS} 格的安全区`);
});

/* ═════════════════════ 拴绳(FSM)═════════════════════ */

function chaser(leash?: number): MobFsm {
  return new MobFsm('m', {
    homeX: 0, homeY: 0, speed: BASE_MOVE_SPEED, aggroRadius: 8, attackRadius: 1.5,
    makeTelegraph: (s) => circleWarn(s.x, s.y, 1.5, 0.8),
    ...(leash === undefined ? {} : { leash }),
  }, mulberry32(1));
}

/** 玩家始终在怪前方 5 格、以同样的速度跑开:没有拴绳的怪会一直追下去。返回怪离家的最远 x。 */
function runAway(m: MobFsm, seconds: number): number {
  let maxX = 0;
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    m.tick({ x: m.x + 5, y: 0 }, () => false);
    maxX = Math.max(maxX, m.x);
  }
  return maxX;
}

test('FND201-4 拴绳:追人追到离家超过拴绳就放弃,最远只到拴绳边上', () => {
  eq(chaser().leash, Infinity, '缺省不拴(与旧行为一致)');
  const free = runAway(chaser(), 30);
  ok(free > 60, `前置:没有拴绳时一路追下去(跑出 ${free.toFixed(1)} 格)`);
  const leashed = runAway(chaser(10), 30);
  ok(leashed <= 10 + BASE_MOVE_SPEED * DT + 1e-6, `★ 拴绳 10 ⇒ 最远只到 ${leashed.toFixed(2)} 格`);
  ok(leashed > 9, `它确实追到了拴绳边上(${leashed.toFixed(2)} 格),不是原地没动`);
});

test('FND201-5 回家途中不再索敌:玩家就在身边也不理,走进家门才恢复', () => {
  const m = chaser(10);
  m.x = 12;                                       /* 被引出了拴绳 */
  m.setState(MobFsmState.ALERT_FLEE_OR_CHASE);
  m.tick({ x: 14, y: 0 }, () => false);
  eq(m.state, MobFsmState.IDLE_GRAZE, '★ 离家 12 > 拴绳 10 ⇒ 放弃追击');
  let realerted = false;
  let steps = 0;
  while (Math.hypot(m.x, m.y) > GRAZE_RADIUS && steps < 4000) {
    m.tick({ x: m.x + 2, y: 0 }, () => false);    /* 玩家贴在身后 2 格 */
    if (m.state !== MobFsmState.IDLE_GRAZE) realerted = true;
    steps += 1;
  }
  ok(!realerted, '★ 回家途中无视玩家');
  ok(Math.hypot(m.x, m.y) <= GRAZE_RADIUS, `走回了家(离家 ${Math.hypot(m.x, m.y).toFixed(2)} 格)`);
  m.tick({ x: m.x + 2, y: 0 }, () => false);
  eq(m.state, MobFsmState.ALERT_FLEE_OR_CHASE, '到家之后恢复索敌');
});

/* ═════════════════════ 营地接进模拟层(合成小世界)═════════════════════ */

/** 以 (cx,cy) 为心、半径 r 的整数格圆盘。 */
function disc(cx: number, cy: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) if (dx * dx + dy * dy <= r * r) out.push([cx + dx, cy + dy]);
  }
  return out;
}

const CAMP: MobCamp = {
  id: 'camp_test_1', tier: 0, region: 'meadow', biome: 'MEADOW',
  x: 150.5, y: 100.5, radius: 6, leash: 12,
  roster: [{ mobId: 'mob_sheep', count: 3 }],
  cells: disc(150, 100, 6),
};

function campWorld(): WorldSim {
  /* townCenter 挪到角落:默认的世界正中会让 24 格安全区罩住营地。 */
  return new WorldSim({ sizeCells: 200, townCenter: { x: 10, y: 10 }, camps: [CAMP], seed: 7, rng: mulberry32(7) });
}

function tickSlow(sim: WorldSim, n: number): void {
  for (let i = 0; i < n * FAST_PER_SLOW; i += 1) sim.tick();
}

test('FND201-6 营地:玩家远 ⇒ 空;走近 ⇒ 刷满,都在圈里,家 = 圆心,带拴绳', () => {
  const sim = campWorld();
  sim.addPlayer('p1', 100, 100);                  /* 离营地 50.5 > 唤醒距离 */
  tickSlow(sim, 30);
  eq(sim.listWildlife().length, 0, '★ 玩家太远 ⇒ 营地不开张(全图撒点的旧行为会在这里冒出怪)');
  sim.setPlayerPos('p1', 125, 100);               /* 离营地 25.5 < 唤醒距离 */
  tickSlow(sim, 6);
  const w = sim.listWildlife();
  eq(w.length, 3, '★ 走近 ⇒ 刷满 3 只');
  for (const m of w) {
    eq(m.mobId, 'mob_sheep', '物种来自营地名单');
    ok(Math.hypot(m.x - CAMP.x, m.y - CAMP.y) <= CAMP.radius + 1, `★ 在营地圈里(${m.x.toFixed(1)},${m.y.toFixed(1)})`);
    const rt = sim.mobHost.runtimeOf(m.id)!;
    eq([rt.anchorX, rt.anchorY], [CAMP.x, CAMP.y], '★ 家 = 营地圆心(不是刷出来的那一格)');
    eq(rt.fsm.leash, CAMP.leash, '★ 带着营地的拴绳');
  }
});

test('FND201-7 玩家站在营地正中:落点都离他太近 ⇒ 不在眼皮底下凭空刷怪', () => {
  const sim = campWorld();
  sim.addPlayer('p1', CAMP.x, CAMP.y);
  tickSlow(sim, 10);
  eq(sim.listWildlife().length, 0, `营地圈半径 ${CAMP.radius} < ${CAMP_SPAWN_MIN_PLAYER_DIST} ⇒ 一只都不刷`);
  sim.setPlayerPos('p1', 125, 100);
  tickSlow(sim, 6);
  eq(sim.listWildlife().length, 3, '玩家一走开就刷满');
});

test('FND201-8 补员:打死一只隔 CAMP_RESPAWN_SEC 才补;走远整营撤场,回来立刻满员', () => {
  const sim = campWorld();
  sim.addPlayer('p1', 125, 100);
  tickSlow(sim, 6);
  const first = sim.listWildlife();
  eq(first.length, 3, '前置:刷满');
  const victim = first[0]!.id;
  sim.damageMob(victim, 9999, DamageKind.PHYSICAL, 0);
  eq(sim.listWildlife().length, 2, '前置:死了一只');
  tickSlow(sim, 2 * (CAMP_RESPAWN_SEC - 10));
  eq(sim.listWildlife().length, 2, `★ 没到 ${CAMP_RESPAWN_SEC} 秒 ⇒ 不补`);
  tickSlow(sim, 2 * 15);
  const after = sim.listWildlife();
  eq(after.length, 3, '★ 到点 ⇒ 补上');
  ok(!after.some((m) => m.id === victim), '补的是新实例(序号不复用,否则击杀账会吞经验)');

  sim.setPlayerPos('p1', 60, 100);                /* 离营地 90 > 离场距离 80 */
  tickSlow(sim, 6);
  eq(sim.listWildlife().length, 0, '★ 走远 ⇒ 整营撤场');
  ok(sim.despawnedFarMobs >= 3, `撤场有计数(实得 ${sim.despawnedFarMobs})`);
  sim.setPlayerPos('p1', 125, 100);
  tickSlow(sim, 4);
  eq(sim.listWildlife().length, 3, '★ 回来立刻满员(撤场不罚等待时间)');
});

test('FND201-9 营地世界里,远离所有玩家的怪(含营地外手加的)照样离场', () => {
  const sim = campWorld();
  sim.addPlayer('p1', 125, 100);
  sim.addMob('mob_boar#900', 'MEADOW', 30, 30);   /* 离玩家 118 格 */
  tickSlow(sim, 4);
  ok(!sim.listWildlife().some((m) => m.id === 'mob_boar#900'), '★ 远处的孤儿怪被清走(读档回来的怪靠它收场,否则越攒越多)');
});

test('FND201-10 参数不等式:唤醒 / 离场 / 拴绳 / 镇子安全区在几何上互相咬得住', () => {
  const maxLeash = Math.max(...CAMP_LEASH);
  const spawnToTown = Math.hypot(SPAWN_POINT.x - WORLD_CENTER, SPAWN_POINT.y - WORLD_CENTER);
  ok(CAMP_WAKE_DIST < CAMP_MIN_TOWN_DIST - spawnToTown,
    `★ 站在出生点唤醒不了任何营地:${CAMP_WAKE_DIST} < ${CAMP_MIN_TOWN_DIST} - ${spawnToTown}`);
  ok(CAMP_MIN_TOWN_DIST - maxLeash > TOWN_SAFE_RADIUS,
    `★ 最长拴绳也够不着安全区:${CAMP_MIN_TOWN_DIST} - ${maxLeash} > ${TOWN_SAFE_RADIUS}`);
  ok(WorldSim.DESPAWN_DISTANCE > CAMP_WAKE_DIST + CAMP_RADIUS + maxLeash,
    `★ 开着的营地里的怪不会被撤场:${WorldSim.DESPAWN_DISTANCE} > ${CAMP_WAKE_DIST} + ${CAMP_RADIUS} + ${maxLeash}`);
});

report('WS-FND-201');
