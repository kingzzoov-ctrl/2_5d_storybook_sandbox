/**
 * WS-FND-130 — 物理层不变量(第八轮实测的四条 P1/P2,全部能在 `physics/` 内落地)。
 *
 * ## 这四条各自的「口」与判据
 *
 * ```text
 * 1 P1 击退穿墙/出界       physics/world.ts   lastFreeAlong(纯函数) + clampToFreeCell(口)
 *                          + sweepCircle 改调纯函数(二分只剩一份)
 * 2 P2 旁表 setter 不校验   physics/world.ts   四个 setter 的存在性闸 + sideTableLeaks()
 * 3 P2 carry 质量兜底       physics/carry.ts   applyImpulse 走 safeMass
 *                          + physics/world.ts  stepBody 的 integrateHorizontal 也走 safeMass
 * 4 P2 格位唯一            physics/world.ts   occupantsAt() / sharedCellGroups()
 * ```
 *
 * ## 判据纪律(与本仓 WS-FND-128 同一套)
 *
 * ```text
 * · 每条判据都带**负对照**:正例必须通过、反例必须被抓到(否则「恒真」测不出);
 * · 关键判据带**注入验证**:把判据的牙拔掉(恒假的 isBlocked / 手工塞悬空键 /
 *   去掉 carriedBy 过滤 / 用旧质量兜底)⇒ 反例**不再**被抓到 ⇒ 抓住它的确实是这一条;
 * · 期望值写字面量(不在期望槽位引用本仓常量),避免「上游一改就跟着过」。
 * ```
 *
 * 运行:`node tests/WS-FND-130-physics-invariants.test.ts`
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAMP_RING_MAX,
  DEFAULT_PLAYER_RADIUS,
  PhysicsWorld,
  lastFreeAlong,
} from '../server/src/physics/world.ts';
import type { PhysTerrain } from '../server/src/physics/world.ts';
import { CarrySystem } from '../server/src/physics/carry.ts';
import type { CarryActor } from '../server/src/physics/carry.ts';
import { createBody, integrateVertical, DT } from '../shared/types/physics.ts';
import type { DynamicBody } from '../shared/types/physics.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 实心墙 OBJ 层 ID(351~371 视为实心,取区间左端)。 */
const SOLID_OBJ = 351;

/** 只有 `walls` 集合里的格是实心,其余全空。 */
function terrainWith(walls: ReadonlySet<string>, elev = 1): PhysTerrain {
  return {
    floorSlotAt: () => 0,
    objIdAt: (wx: number, wy: number) => (walls.has(`${wx},${wy}`) ? SOLID_OBJ : 0),
    elevAt: () => elev,
    faceDirAt: () => 1,
  };
}

/** 整张地图都实心(任何位置都不合法)。 */
const SOLID_EVERYWHERE: PhysTerrain = {
  floorSlotAt: () => 0,
  objIdAt: () => SOLID_OBJ,
  elevAt: () => 1,
  faceDirAt: () => 1,
};

/** 独立几何判据(不经过被注入对象):这个点是否落在墙格 `[3,4) × [5,6)` 里。 */
function insideWallCell(x: number, y: number): boolean {
  return x >= 3 && x < 4 && y >= 5 && y < 6;
}

/**
 * 剥掉注释后的源码。**为什么必须剥**:本仓的文件头和 docblock 会**引用**旧写法
 * (`mass === 0 ? 1 : mass` 之类),不剥注释的源码判据会被自己的注释喂成恒真。
 */
function liveSource(rel: string): string {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

/**
 * 切出源码里的**一段**(从 `start` 起、到 `end` 之前)。两端的锚点都必须存在,
 * 缺一个就当场失败 —— 锚点漂掉后「找不到 ⇒ 跳过」会把判据变成恒真。
 *
 * 为什么要按段切:像「二分只许有一份」这种判据,数全文件的字面量会把
 * `launchSpeedForApex`(另一条算式)一起数进去 ⇒ 判据本身变成误报源。
 */
function spanOf(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  ok(at >= 0, `源码里找不到起始锚点 \`${start}\``);
  const stop = src.indexOf(end, at + start.length);
  ok(stop > at, `源码里找不到结束锚点 \`${end}\``);
  return src.slice(at, stop);
}

/* ═══════════ 1(P1)· 击退/搬家:落点永不进墙、无遮挡逐位不变 ═══════════ */

test('FND130-1 贴 1 格厚墙击退 1.2 格 ⇒ 停在墙前,落点不在实心格内', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set(['3,5'])) });
  const r = DEFAULT_PLAYER_RADIUS;
  /* 半径 0.35 的圆,圆心 x 最多到 4 - ... ⇒ 墙格左边界 3,停在 3 - 0.35 之前 */
  const s = w.sweepCircle(2.6, 5.5, 1.2, 0, r);
  ok(s.blocked, '被墙挡下必须报 blocked(否则「被挡住」与「压根没被挡」分不开)');
  ok(!w.isBlockedAt(s.x, s.y, r), `落点仍在实心格内:(${s.x}, ${s.y})`);
  ok(!insideWallCell(s.x, s.y), `独立几何判据也说落点进了墙格:(${s.x}, ${s.y})`);
  ok(s.x <= 3 - r + 1e-9, `落点必须退到墙前(≤ ${3 - r}),实际 ${s.x}`);
  /* 负对照:同样的位移在没有墙的地方**逐位**等于终点(WS-FND-98 的 1e-9 口径) */
  const free = new PhysicsWorld({ terrain: terrainWith(new Set()) });
  const f = free.sweepCircle(2.6, 5.5, 1.2, 0, r);
  eq(f.blocked, false, '无遮挡时不该报 blocked');
  eq(f.x, 2.6 + 1.2, '无遮挡时位移必须与修前逐位相同');
  eq(f.y, 5.5, '无遮挡时 y 不该被动到');
});

test('FND130-2 扫掠判据的牙在 isBlockedAt:注入「恒不挡」⇒ 反例不再被抓到', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set(['3,5'])) });
  const r = DEFAULT_PLAYER_RADIUS;
  const teeth = w.sweepCircle(2.6, 5.5, 1.2, 0, r);
  ok(!insideWallCell(teeth.x, teeth.y), '前提:未注入时落点不进墙(否则下面证明不了任何事)');
  /* 注入:把一个**恒不挡**的谓词装进同一个实例(模拟「判据被拔牙」) */
  const patched = w as unknown as { isBlockedAt: (x: number, y: number, rr?: number) => boolean };
  const saved = patched.isBlockedAt;
  patched.isBlockedAt = () => false;
  try {
    const blind = w.sweepCircle(2.6, 5.5, 1.2, 0, r);
    eq(blind.blocked, false, '注入后必须不再报 blocked(这正是「判据失效」的样子)');
    near(blind.x, 3.8, 1e-12, '注入后一路推进到终点');
    ok(insideWallCell(blind.x, blind.y), '注入后落点确实进了墙格 ⇒ 牙在 isBlockedAt 上');
  } finally {
    patched.isBlockedAt = saved;
  }
  /* 还原后判据恢复:同一调用又回到墙前(不是「一次注入永久失明」) */
  const back = w.sweepCircle(2.6, 5.5, 1.2, 0, r);
  ok(!insideWallCell(back.x, back.y), '还原后判据必须恢复');
});

/* ═══════════ 2(P1)· 落点校验口 clampToFreeCell ═══════════ */

test('FND130-3 已卡在墙内的圆心 ⇒ clampToFreeCell 挪到最近合法格中心', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set(['3,5'])) });
  const r = DEFAULT_PLAYER_RADIUS;
  const c = w.clampToFreeCell(3.5, 5.5, r);
  eq(c.blocked, true, '请求点在墙里 ⇒ blocked 必须为真');
  ok(!w.isBlockedAt(c.x, c.y, r), `回退点仍不合法:(${c.x}, ${c.y})`);
  ok(!insideWallCell(c.x, c.y), `回退点仍落在墙格:(${c.x}, ${c.y})`);
  /* 落点必须是**格中心**(0.5 偏移):本口只承诺「最近合法格中心」 */
  eq(c.x - Math.floor(c.x), 0.5, '回退点必须是格中心(x)');
  eq(c.y - Math.floor(c.y), 0.5, '回退点必须是格中心(y)');
  /* 负对照 1:本来就是合法点 ⇒ 原样返回、blocked 为假、逐位不变 */
  const good = w.clampToFreeCell(2.5, 5.5, r);
  eq(good, { x: 2.5, y: 5.5, blocked: false }, '合法落点必须原样返回');
  /* 负对照 2:非法入参 fail-closed(有 fallback 用 fallback,没有就退到世界中心) */
  eq(w.clampToFreeCell(Number.NaN, 5.5, r, { x: 2.5, y: 5.5 }), { x: 2.5, y: 5.5, blocked: true }, 'NaN 必须退到 fallback');
  const nanNoFb = w.clampToFreeCell(Number.NaN, Number.POSITIVE_INFINITY, r);
  ok(Number.isFinite(nanNoFb.x) && Number.isFinite(nanNoFb.y), '没有 fallback 时也不许把 NaN 放出去');
  eq(nanNoFb.blocked, true, 'NaN 入参一律 blocked');
  /* 负对照 3:找不到任何合法格 ⇒ **原地不动**(绝不挑一个更坏的落点) */
  const solid = new PhysicsWorld({ terrain: SOLID_EVERYWHERE });
  eq(solid.clampToFreeCell(5.5, 5.5, r), { x: 5.5, y: 5.5, blocked: true }, '全实心时必须原地不动');
});

test('FND130-4 落点校验能跨过 2 格厚墙;牙仍在 isBlockedAt(注入对比)', () => {
  const r = DEFAULT_PLAYER_RADIUS;
  /* x=3 与 x=4 两格都实心 ⇒ 只能在 x=5 那侧的格中心落地 */
  const w = new PhysicsWorld({ terrain: terrainWith(new Set(['3,5', '4,5'])) });
  const c = w.clampToFreeCell(3.5, 5.5, r);
  ok(!w.isBlockedAt(c.x, c.y, r), `回退点仍不合法:(${c.x}, ${c.y})`);
  ok(!(c.x >= 3 && c.x < 5 && c.y >= 5 && c.y < 6), `回退点仍落在 2 格厚的墙里:(${c.x}, ${c.y})`);
  /* 注入:恒不挡的 isBlockedAt ⇒ 直接返回墙里的原点(证明这条判据不是自证) */
  const patched = w as unknown as { isBlockedAt: (x: number, y: number, rr?: number) => boolean };
  const saved = patched.isBlockedAt;
  patched.isBlockedAt = () => false;
  let blind = { x: 0, y: 0, blocked: false };
  try {
    blind = w.clampToFreeCell(3.5, 5.5, r);
  } finally {
    patched.isBlockedAt = saved;
  }
  eq(blind, { x: 3.5, y: 5.5, blocked: false }, '注入后原样放行(判据失效的样子)');
  ok(insideWallCell(blind.x, blind.y), '注入后落点确实在墙里 ⇒ 抓住它的是 isBlockedAt');
});

/* ═══════════ 3(P1)· 纯函数与唯一事实源 ═══════════ */

test('FND130-5 lastFreeAlong 是纯函数:sweepCircle 与它逐位同源', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set(['3,5'])) });
  const r = DEFAULT_PLAYER_RADIUS;
  const s = w.sweepCircle(2.6, 5.5, 1.2, 0, r);
  const p = lastFreeAlong(2.6, 5.5, 1.2, 0, (x, y) => w.isBlockedAt(x, y, r));
  eq(s, p, 'sweepCircle 与 pure 版本必须逐位相同(否则同一算式有两份实现)');
  /* 负对照:非法位移 fail-closed */
  eq(lastFreeAlong(1, 1, Number.NaN, 0, () => false), { x: 1, y: 1, blocked: true, moved: 0 }, 'NaN 位移必须原地不动');
  eq(lastFreeAlong(1, 1, Number.POSITIVE_INFINITY, 0, () => false).blocked, true, 'Inf 位移必须 blocked');
  /* 恒不挡 ⇒ 终点原样(纯函数只做几何,不自己判地形) */
  eq(lastFreeAlong(0, 0, 2, 0, () => false), { x: 2, y: 0, blocked: false, moved: 2 }, '恒不挡时原样返回终点');
  /* 起点不合法 **且终点也不合法** ⇒ 二分不前进(纵向能绕出去就不算"不前进") */
  const thick = new PhysicsWorld({ terrain: terrainWith(new Set(['3,5', '4,5'])) });
  const stuck = lastFreeAlong(3.5, 5.5, 1, 0, (x, y) => thick.isBlockedAt(x, y, r));
  eq(stuck, { x: 3.5, y: 5.5, blocked: true, moved: 0 }, '首尾皆不合法时二分不前进');
  /* 源码判据:**二分只有一份**,`sweepCircle` 只是把 `isBlockedAt` 包成回调。
     不能数全文件里 `(lo + hi) / 2` 的个数 —— `launchSpeedForApex` 也用同一个二分,
     那是另一条算式(反解初速),把它们混成一条判据会把引擎的正确实现判成违规。 */
  const live = liveSource('server/src/physics/world.ts');
  const sweepSpan = spanOf(live, '  sweepCircle(', '  clampToFreeCell(');
  ok(sweepSpan.includes('lastFreeAlong('), 'sweepCircle 必须委托给纯函数 lastFreeAlong');
  ok(!sweepSpan.includes('hi = mid'), 'sweepCircle 里不许再有一份二分(两份实现必然漂)');
  const pureSpan = spanOf(live, 'export function lastFreeAlong(', 'export const PhysStats');
  ok(pureSpan.includes('hi = mid'), '二分必须留在 lastFreeAlong 里(别把判据删成恒真)');
});

/* ═══════════ 4(P2)· 旁表 setter 的存在性闸 + 悬空条目判据 ═══════════ */

test('FND130-6 四个 setter 对不存在的 id 一律拒绝,且旁表不落条目', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set()) });
  w.spawn('p1', { x: 1.5, y: 1.5 });
  /* 正例:存在的 id 必须能写进去(否则「拒绝」与「根本没实现」不可分) */
  eq(w.setMuMul('p1', 0.96), true, '存在 id 的 setMuMul 必须接受');
  eq(w.setSpeedCap('p1', 4.5), true, '存在 id 的 setSpeedCap 必须接受');
  eq(w.setGravityMul('p1', 0.3), true, '存在 id 的 setGravityMul 必须接受');
  eq(w.setJumpMul('p1', 1.5), true, '存在 id 的 setJumpMul 必须接受');
  near(w.muMulOf('p1'), 0.96, 1e-12, '读口必须读到刚写的值');
  eq(w.sideTablesSubsetOfBodies(), true, '合法写入后「旁表键 ⊆ bodies 键」必须成立');
  /* 反例:不存在的 id ⇒ 四个 setter 全部 false,且不新增条目 */
  eq(w.setMuMul('ghost', 0.5), false, '不存在的 id 必须拒绝 setMuMul(修前返回 true)');
  eq(w.setSpeedCap('ghost', 1), false, '不存在的 id 必须拒绝 setSpeedCap');
  eq(w.setGravityMul('ghost', 0.5), false, '不存在的 id 必须拒绝 setGravityMul');
  eq(w.setJumpMul('ghost', 1), false, '不存在的 id 必须拒绝 setJumpMul');
  eq(w.sideTableLeaks(), [], '被拒绝的写入不许在旁表里留悬空条目');
  eq(w.muMulOf('ghost'), 1, '读口对不存在的 id 必须回中性值');
  /* 生命周期:remove 之后旁表必须跟着回收(否则悬空条目从这条路径进来) */
  w.remove('p1');
  eq(w.sideTableLeaks(), [], 'remove 必须回收全部旁表条目');
  eq(w.speedCapOf('p1'), null, 'remove 后读口必须回到「没设过」');
});

test('FND130-7 悬空条目判据有牙:手工塞一条 ⇒ 被报出;恒空审计漏掉它', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set()) });
  w.spawn('p1', { x: 1.5, y: 1.5 });
  eq(w.sideTableLeaks(), [], '前提:构造后无悬空条目');
  /* 注入:绕过 setter 的存在性闸,直接把悬空键塞进旁表(这就是修前的形态) */
  const priv = w as unknown as { muMuls: Map<string, number>; gravityMuls: Map<string, number> };
  priv.muMuls.set('ghost', 0.5);
  priv.gravityMuls.set('ghost2', 0.3);
  const leaks = w.sideTableLeaks();
  eq(leaks.length, 2, `两条悬空条目必须都被报出,实际 ${JSON.stringify(leaks)}`);
  ok(leaks.some((l) => l.table === 'muMuls' && l.id === 'ghost'), '必须指到具体表与具体 id');
  eq(w.sideTablesSubsetOfBodies(), false, '注入后「旁表键 ⊆ bodies 键」必须为假');
  /* 注入验证的第二半:把判据换成恒空 ⇒ 同样的悬空条目**不再**被报出(否则这条判据恒真) */
  const muteAudit = (): { table: string; id: string }[] => [];
  eq(muteAudit().length, 0, '恒空审计对同一条悬空条目无话可说 ⇒ 抓到它的确实是 sideTableLeaks');
  /* spawn 同 id 覆盖也会回收:重生不该继承上一条命的乘子 */
  priv.muMuls.set('p1', 0.2);
  w.spawn('p1', { x: 2.5, y: 2.5 });
  eq(w.muMulOf('p1'), 1, 'spawn 覆盖必须回收旧乘子(新生不继承上一条命)');
});

/* ═══════════ 5(P2)· carry 的质量归一 ═══════════ */

function actorOf(id: string, patch: Partial<DynamicBody> = {}): CarryActor {
  return { body: createBody(id, patch), shield: false };
}

test('FND130-8 carry.applyImpulse 的质量一律经 safeMass(NaN/Inf 不再产出 NaN/零击退)', () => {
  const actors = new Map<string, CarryActor>();
  const bad = actorOf('bad', { mass: Number.NaN });
  const inf = actorOf('inf', { mass: Number.POSITIVE_INFINITY });
  const heavy = actorOf('heavy', { mass: 20 });
  const frac = actorOf('frac', { mass: 1.5 });
  actors.set('bad', bad);
  actors.set('inf', inf);
  actors.set('heavy', heavy);
  actors.set('frac', frac);
  const carry = new CarrySystem(actors);
  eq(carry.applyImpulse('bad', 10, 0, 0).dvx, 10, 'NaN 质量必须退化为基准质量 1(Δv = J)');
  eq(carry.applyImpulse('inf', 10, 0, 0).dvx, 10, '+Inf 质量同样退化为 1(旧写法会给出 0 击退)');
  eq(carry.applyImpulse('frac', 10, 0, 0).dvx, 10, '小数质量(非正整数)同样被拒绝');
  eq(carry.applyImpulse('heavy', 10, 0, 0).dvx, 0.5, '合法质量必须按 Δv = J/m 归一');
  ok(Number.isFinite(bad.body.vx), 'Δv 必须是有限值(旧写法写出 NaN)');
  /* 负对照/注入:旧兜底 `mass === 0 ? 1 : mass` 对 NaN 与 +Inf 各错一种 */
  const oldMass = (m: number): number => (m === 0 ? 1 : m);
  ok(Number.isNaN(10 / oldMass(Number.NaN)), '旧写法对 NaN 给出 NaN(修前的症状)');
  eq(10 / oldMass(Number.POSITIVE_INFINITY), 0, '旧写法对 +Inf 给出 0 击退(另一种漏法)');
  /* 源码判据:活代码里不得再有旧兜底(注释已剥,不会被 docblock 喂成恒真) */
  for (const rel of ['server/src/physics/carry.ts', 'server/src/physics/world.ts']) {
    const live = liveSource(rel);
    ok(!/mass === 0\s*\?\s*1\s*:/.test(live), `${rel} 的活代码里仍有 mass === 0 ? 1 : mass`);
  }
});

/* ═══════════ 6(P2)· 格位唯一:查询口 + 冲突清单 ═══════════ */

test('FND130-9 两个不同 id 同格 ⇒ occupantsAt/sharedCellGroups 报出;叠罗汉不算冲突', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set()) });
  w.spawn('p1', { x: 2.4, y: 5.4 });
  w.spawn('p2', { x: 2.9, y: 5.9 });
  eq(w.occupantsAt(2, 5), ['p1', 'p2'], '同格两个 id 都必须被查到(且按 id 排序)');
  eq(w.sharedCellGroups(), [{ cx: 2, cy: 5, ids: ['p1', 'p2'] }], '同格冲突必须成组报出');
  /* 负对照:挪开一格 ⇒ 冲突消失(否则这条判据对「合法分居」也报) */
  w.get('p2')!.x = 3.4;
  eq(w.sharedCellGroups(), [], '不同格不许报冲突');
  eq(w.occupantsAt(2, 5), ['p1'], '挪走后该格只剩 p1');
  /* 负对照:叠罗汉链上(被举起)的坐标**故意**与底层同格,不算冲突 */
  w.get('p2')!.x = 2.4;
  w.get('p2')!.y = 5.4;
  w.get('p2')!.carriedBy = 'p1';
  eq(w.occupantsAt(2, 5), ['p1', 'p2'], '占用查询不排除被举起者(它确实在这一格)');
  eq(w.sharedCellGroups(), [], '被举起者与承载者同格是设计,不是冲突');
  /* 注入验证:去掉 carriedBy 过滤的「mutant」会把叠罗汉误报成冲突 */
  const mutantGroups = (world: PhysicsWorld): number => {
    const seen = new Map<string, string[]>();
    for (const b of world.bodies.values()) {
      const k = `${Math.floor(b.x)},${Math.floor(b.y)}`;
      const arr = seen.get(k);
      if (arr === undefined) seen.set(k, [b.id]);
      else arr.push(b.id);
    }
    let n = 0;
    for (const arr of seen.values()) if (arr.length >= 2) n += 1;
    return n;
  };
  eq(mutantGroups(w), 1, 'mutant(无 carriedBy 过滤)必须把叠罗汉误报 ⇒ 过滤是判据的牙');
  /* 非法入参:不返回 NaN 格 */
  eq(w.occupantsAt(Number.NaN, 5), [], 'NaN 格坐标必须返回空而不是 NaN 键');
});

/* ═══════════ 7(gz=-1)· 按现状订正注释:那个分支是死的 ═══════════ */

test('FND130-10 gz=-1 不可达(冻结层把 z 硬钳 ≥ 0),注释已按现状订正', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set(), 0) });
  eq(w.groundZAt(0, 0), -1, 'elev 0 的格 groundZ 必须是 -1');
  /* 冻结层的硬钳:z 永远不会落到 0 以下 ⇒ `b.z <= -1` 永不成立 */
  let z = 0;
  let vz = -1;
  for (let i = 0; i < 200; i += 1) {
    const s = integrateVertical(z, vz, DT);
    z = s.z;
    vz = s.vz;
    ok(z >= 0, `第 ${i} 帧 z 掉到 0 以下(${z})—— 冻结层的硬钳失效了`);
  }
  eq(z, 0, '深沟里 z 停在 0(不是 -1)');
  ok(!(z <= -1), '`b.z <= gz` 在 gz=-1 时永不成立 ⇒ 那个分支是死代码');
  /* 源码判据:world.ts 的落地注释必须**如实**写着它是死代码(订正过的样子) */
  const raw = readFileSync(join(ROOT, 'server/src/physics/world.ts'), 'utf8');
  ok(raw.includes('死代码'), 'world.ts 的落地分支注释必须点明 gz<0 那一支是死代码');
  ok(raw.includes('硬钳在 ≥ 0') || raw.includes('硬钳'), '注释必须给出理由(冻结层把 z 钳在 ≥ 0)');
  ok(!/gz\s*可能\s*<\s*0/.test(raw) || raw.includes('原文写'), '旧说法必须被标成「原文」,不能当现状照抄');
});

/* ═══════════ 8(口)· 这些口确实挂在 PhysicsWorld 上(不是孤儿纯函数)═══════════ */

test('FND130-11 四个口都在类上,且常量与半径取自既有事实源', () => {
  const w = new PhysicsWorld({ terrain: terrainWith(new Set()) });
  for (const k of ['clampToFreeCell', 'sweepCircle', 'occupantsAt', 'sharedCellGroups', 'sideTableLeaks', 'sideTablesSubsetOfBodies'] as const) {
    eq(typeof (w as unknown as Record<string, unknown>)[k], 'function', `PhysicsWorld 上缺 ${k}`);
  }
  eq(CLAMP_RING_MAX, 8, '回退环数钉在 8(改它要重新算代价)');
  eq(DEFAULT_PLAYER_RADIUS, 0.35, '半径必须取自冻结层 RADIUS_PLAYER');
  /* 空世界:所有口都必须有稳定的空答案,不许抛错 */
  eq(w.occupantsAt(0, 0), [], '空世界的占用查询返回空数组');
  eq(w.sharedCellGroups(), [], '空世界没有同格冲突');
  eq(w.sideTableLeaks(), [], '空世界没有悬空条目');
  eq(w.clampToFreeCell(0.5, 0.5, DEFAULT_PLAYER_RADIUS), { x: 0.5, y: 0.5, blocked: false }, '自由点上原样返回');
});

report('WS-FND-130');