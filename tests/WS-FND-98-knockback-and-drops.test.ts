/**
 * WS-FND-98 —— 两条**欠账**的落地判据:
 *
 * | # | 欠账 | 落点 |
 * |---|---|---|
 * | 1 | 击退**没有上界、也没按质量归一**;`mass = NaN` 会把 `NaN` 冲量写进刚体 | `physics/world.ts#safeMass` + `applyImpulse`;`world_sim.ts#applyKnockback` |
 * | 2 | mob 掉落**没有概率维** —— 「稀有材料」与「必掉材料」在数据上一模一样 | `shared/constants/mobs.ts#dropChance` + `mobs/drops.ts` |
 *
 * ## 判据(17 条,含负对照)
 *
 * | 编号 | 判据 | 负对照 |
 * |---|---|---|
 * | FND98-1  | 具名常量锚:位移上界 `2`(D-09 同量级)、质量基准 `1`、稀有概率 `0.15` | — |
 * | FND98-2  | ★ 上界:超大距离(`1e9`)位移恰 2 | — |
 * | FND98-3  | 上界对「超过上界的正常距离」也生效(`5 → 2`) | — |
 * | FND98-4  | ★ 质量归一:`2` 格在质量 `1/3/20` 下推 `2 / 0.667 / 0.1` | — |
 * | FND98-5  | 非法质量**被拒绝**(退化为基准 1)| `NaN` / `0` / 负数 / 小数 ⇒ 位移有限、不越界 |
 * | FND98-6  | 非法/非正距离被拒 | `NaN` / `Infinity` / `0` / 负数 ⇒ 位置不动、窗口不开 |
 * | FND98-7  | ★ 冲量路径:`NaN` 质量**不再**产出 `NaN` 冲量 | 同时钉住「旧算式 `J/m` 在 `m = NaN` 时确实是 `NaN`」 |
 * | FND98-8  | 既有行为不回归:冲量仍与质量成反比 | — |
 * | FND98-9  | ★ 必掉项仍必掉(全表逐项 × 200 种子) | — |
 * | FND98-10 | ★ 概率项**同种子可复现**、不同种子会不同 | — |
 * | FND98-11 | ★ 长期频率 ≈ 概率(20000 种子,`0.15 ± 0.01`) | — |
 * | FND98-12 | 非法概率 fail-closed | `NaN` / `0` / 负数 ⇒ 一次不掉;`> 1` ⇒ 恒掉 |
 * | FND98-13 | 未知 mobId / 缺省键的取值 | 空表、缺省必掉、件数缺省 1 |
 * | FND98-14 | ★ 生产接线:`damageMob` 打死怪 ⇒ `lastMobDrops` 与纯函数逐位相同 | 两种子:一个掉 753、一个不掉 |
 * | FND98-15 | ★ P1 修复:同一世界连打 100 次同种稀有怪 ⇒ 掉落次数落在二项分布区间内 | 修前:0 或 100(「恒掉 / 恒不掉」) |
 * | FND98-16 | ★ 不同种子的两个世界 ⇒ 逐次掉落序列不同(各自又不是恒 0/恒 1) | — |
 * | FND98-17 | ★ 同 seed 重放逐次逐位一致,且逐次 = 纯函数**同键**结果 | — |
 *
 * ## 注入验证(实测变红后**还原**,逐条已跑;括号是本次实测变红的判据)
 *   1 `world_sim.ts` 的 `KNOCKBACK_MAX_CELLS` 改 `200` ⇒ **FND98-1/2/3/5 红**
 *     (实测位移 10.5 —— 越界部分被地图钳位兜住,但「2 格预算」已经破了)。
 *   2 `physics/world.ts` 的 `safeMass` 换回 `mass <= 0 ? 1 : mass` ⇒ **FND98-5/7 红**
 *     (`NaN` 质量下 `applyImpulse` 返回 `dvx = NaN`;世界侧的击退直接被拒)。
 *   3 `shared/constants/mobs.ts` 的 `MOB_RARE_DROP_CHANCE` 改 `0.5` ⇒ **FND98-1/10/11/14 红**
 *     (频率实测 0.49945)。
 *   4 `mobs/drops.ts` 的 `rollMobDrops` 把 `roll` 写死 `0`(恒必掉)⇒ **FND98-10/11/14 红**
 *     (频率实测 1)。
 *   5 `world_sim.ts#settleKill` 只把 `worldSeed` 传给 `rollMobDrops`(丢掉击杀实例维)
 *     ⇒ **FND98-14/15/16/17 红**:实测同一世界里 100 次同种怪要么**全掉**要么**全不掉**
 *     (seed 7 与 seed 8 都是「全不掉」⇒ 两个世界的序列还变得一样)。
 *
 * ⚠️ 断言右侧一律**字面量**(`2` / `0.15` / `753` / 手册行号),不从被测模块取期望值 ——
 * 唯一的例外是 FND98-14 的「与纯函数逐位相同」(那条要证的**就是接线**,不是数值)。
 */
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { DEFAULT_BODY_MASS, PhysicsWorld, safeMass } from '../server/src/physics/world.ts';
import { MOB_LIST, MOB_BY_ID, MOB_RARE_DROP_CHANCE, type MobDropRow } from '../shared/constants/mobs.ts';
import {
  MANDATORY_DROP_CHANCE,
  mobDropChanceOf,
  mobDropCountOf,
  mobDropTableOf,
  rollMobDrops,
} from '../server/src/mobs/drops.ts';
import { mobInstanceId } from '../server/src/mobs/spawner.ts';

/** D-09 的 2 格(owner 2026-11-16)—— 手册/裁决值,判据用字面量钉住。 */
const CAP = 2;
/** 手册 L387(624 招财进宝猫耳箍)「稀有材料掉落率 +15%」—— 全手册唯一的野怪掉落率数字。 */
const RARE = 0.15;
/** 手册点名「稀有」的两件掉落。 */
const RARE_TREE = 753;
const RARE_RECIPE = 751;

/* ── 夹具 ── */

function bareSim(seed = 7): WorldSim {
  return new WorldSim({ sizeCells: 24, mobs: false, wiring: false, seed });
}

/** 直接改刚体质量(生产里由 `createBody` 的 `patch` 写;测非法值只有这条路)。 */
function forceMass(sim: WorldSim, id: string, mass: number): void {
  const b = sim.physics.bodies.get(id);
  if (b === undefined) throw new Error('前置失败:没有刚体');
  b.mass = mass;
}

/** 施加一次击退并把两段慢帧推完,返回 |实际位移| 与「窗口是否关闭」。 */
function knockAndMeasure(sim: WorldSim, id: string, fromX: number, distance: number):
  { moved: number; applied: boolean; windowOpen: boolean; posX: number; posFinite: boolean } {
  const before = sim.playerPosition(id);
  if (before === null) throw new Error('前置失败:没有位置');
  const applied = sim.applyKnockback(id, fromX, before.y, distance);
  for (let i = 0; i < 60; i += 1) sim.tick();
  const after = sim.playerPosition(id)!;
  return {
    moved: Math.abs(after.x - before.x),
    applied,
    windowOpen: sim.knockbackOf(id),
    posX: after.x,
    posFinite: Number.isFinite(after.x) && Number.isFinite(after.y),
  };
}

/** 一张只有 p1 的静图(推完击退)。 */
function knockOnce(mass: number, distance: number): ReturnType<typeof knockAndMeasure> {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  forceMass(sim, 'p1', mass);
  return knockAndMeasure(sim, 'p1', 10.5, distance); /* 攻击者在西侧 ⇒ 被推向 +x */
}

/**
 * 在一个世界里连打 `n` 次同种怪(实例序号 1..n,id 走生产唯一生成器
 * `mobInstanceId`),返回**每次击杀的掉落物品 id**(itemId 升序,与 `lastMobDrops` 同形)。
 *
 * 走真路径 `addMob` → `damageMob`(致死) → `settleKill`。实例序号逐次不同 ⇒ 每一次击杀
 * 都有自己的**击杀实例维**;同 seed 的世界重放会得到同一串序号(判据 FND98-15/16/17)。
 */
function killSeries(seed: number, species: string, n: number): number[][] {
  const sim = bareSim(seed);
  sim.addPlayer('p1', 12.5, 12.5);
  const out: number[][] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = mobInstanceId(species, i);
    sim.addMob(id, 'MEADOW', 14, 12.5);
    sim.damageMob(id, 999_999, 'PHYSICAL', 0);
    out.push(sim.lastMobDrops.map((d) => d.itemId));
  }
  return out;
}

/* ══════════════════ 1. 常量锚 ══════════════════ */

test('FND98-1 ★ 具名常量锚:上界 2 格(D-09 同量级)、质量基准 1、稀有概率 0.15', () => {
  eq(WorldSim.KNOCKBACK_MAX_CELLS, CAP, '击退总位移上界 = 2 格(与 D-09 的 min(2, 伤害/20) 同量级)');
  eq(WorldSim.KNOCKBACK_MASS_REF, 1, '质量归一基准 = 1(= MASS_PLAYER ⇒ 既有判据逐位不变)');
  eq(DEFAULT_BODY_MASS, 1, '物理层兜底质量 = 1');
  eq(safeMass(3), 3, '正整数质量原样通过');
  eq(MOB_RARE_DROP_CHANCE, RARE, '稀有材料概率 = 手册 L387 的 0.15(不许按手感调参)');
  eq(MANDATORY_DROP_CHANCE, 1, '缺省概率 = 必掉');
});

/* ══════════════════ 2. 上界 ══════════════════ */

test('FND98-2 ★ 上界:一次 1e9 格的击退也只推 2 格(超大伤害不越界)', () => {
  const r = knockOnce(1, 1e9);
  eq(r.applied, true, '前置:这么大的距离仍是「算作一次击退」');
  eq(r.posFinite, true, '位置必须有限');
  near(r.moved, CAP, 1e-9, `★ 位移必须被钳到 ${CAP}(实测 ${r.moved})`);
  eq(r.windowOpen, false, '推完 ⇒ 窗口关闭(两段推完,不会永不关闭)');
});

test('FND98-3 上界对「超过上界的正常距离」同样生效:5 格 ⇒ 2 格', () => {
  const r = knockOnce(1, 5);
  near(r.moved, CAP, 1e-9, `5 > 上界 ⇒ 钳到 ${CAP}(实测 ${r.moved})`);
  const exact = knockOnce(1, 2);
  near(exact.moved, 2, 1e-9, '等于上界 ⇒ 不减(边界不退让)');
});

/* ══════════════════ 3. 质量归一 ══════════════════ */

test('FND98-4 ★ 质量归一:2 格在质量 1/3/20 下推 2 / 0.667 / 0.1', () => {
  near(knockOnce(1, 2).moved, 2, 1e-9, '质量 1(基准)⇒ 位移与归一前逐位相同');
  near(knockOnce(3, 2).moved, 2 / 3, 1e-9, '质量 3 ⇒ 2 × (1/3)');
  near(knockOnce(20, 2).moved, 0.1, 1e-9, '质量 20(= MASS_BOSS)⇒ 2 × (1/20)');
});

test('FND98-5 ★ 负对照:非法质量被拒绝(NaN / 0 / 负数 / 小数)⇒ 位移仍有限且不越界', () => {
  for (const mass of [Number.NaN, 0, -3, 2.5]) {
    const r = knockOnce(mass, 2);
    eq(r.applied, true, `质量 ${mass} 仍算一次击退(拒绝的是质量,不是这次击退)`);
    eq(r.posFinite, true, `★ 质量 ${mass} 不许把位置变成 NaN`);
    near(r.moved, 2, 1e-9, `质量 ${mass} 退化为基准 1 ⇒ 位移 2(实测 ${r.moved})`);
  }
  const huge = knockOnce(Number.NaN, 1e9);
  near(huge.moved, CAP, 1e-9, '★ NaN 质量 + 1e9 距离 ⇒ 既不 NaN 也不越界');
});

/* ══════════════════ 4. 距离的非法值 ══════════════════ */

test('FND98-6 负对照:非法/非正距离被拒(位置不动、窗口不开)', () => {
  for (const distance of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const sim = bareSim();
    sim.addPlayer('p1', 12.5, 12.5);
    eq(sim.applyKnockback('p1', 10.5, 12.5, distance), false, `距离 ${distance} 不算击退`);
    eq(sim.knockbackOf('p1'), false, `距离 ${distance} ⇒ 窗口不开`);
    eq(sim.playerPosition('p1')!.x, 12.5, `距离 ${distance} ⇒ 位置不动`);
  }
  /* 与攻击者完全重合:没有方向可言(既有语义,不回归)。 */
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.applyKnockback('p1', 12.5, 12.5, 2), false, '重合 ⇒ 拒(不随便挑方向)');
});

/* ══════════════════ 5. 冲量路径的质量归一 ══════════════════ */

test('FND98-7 ★ 冲量路径:`NaN` 质量不再产出 `NaN` 冲量(旧算式确实是 NaN)', () => {
  ok(Number.isNaN(60 / Number.NaN), '前提:旧算式 Δv = J / m 在 m = NaN 时确实是 NaN');
  eq(safeMass(Number.NaN), 1, 'NaN 质量被拒绝 ⇒ 退化为基准 1');
  eq(safeMass(Number.POSITIVE_INFINITY), 1, '+Infinity 也被拒绝(旧写法 `mass <= 0 ? 1 : mass` 漏这一档)');
  eq(safeMass(-1), 1, '负数被拒绝');
  eq(safeMass(0), 1, '0 被拒绝');
  eq(safeMass(1.5), 1, '小数(非正整数)被拒绝 —— 手册的质量梯度是离散档 1/3/20');

  const pw = new PhysicsWorld();
  pw.spawn('bad', { mass: Number.NaN });
  const dv = pw.applyImpulse('bad', 60, 0, 0);
  eq(Number.isFinite(dv.dvx), true, '★ NaN 质量 ⇒ Δv 仍有限(修前是 NaN)');
  near(dv.dvx, 60, 1e-12, '★ 退化为基准质量 1 ⇒ Δv = 60');
  eq(Number.isFinite(pw.bodies.get('bad')!.vx), true, '★ 速度里不许落进 NaN(落进去就再也回不来)');
});

test('FND98-8 既有行为不回归:冲量/掼摔仍与质量成反比', () => {
  const pw = new PhysicsWorld();
  pw.spawn('light', { mass: 1 });
  pw.spawn('heavy', { mass: 3 });
  pw.spawn('boss', { mass: 20 });
  near(pw.applyImpulse('light', 60, 0, 0).dvx, 60, 1e-12, '质量 1 ⇒ Δv 60');
  near(pw.applyImpulse('heavy', 60, 0, 0).dvx, 20, 1e-12, '质量 3 ⇒ Δv 20');
  near(pw.applyImpulse('boss', 60, 0, 0).dvx, 3, 1e-12, '质量 20 ⇒ Δv 3');
  near(pw.slam('heavy', 1, 0, 30).dvx, 10, 1e-12, '掼摔同样按质量衰减');
});

/* ══════════════════ 6. 掉落概率字段 ══════════════════ */

test('FND98-9 ★ 必掉项仍必掉:手册没写「稀有」的每一项,200 个种子下 100% 出现', () => {
  let checked = 0;
  for (const row of MOB_LIST) {
    for (const entry of mobDropTableOf(row.id)) {
      if (entry.chance < 1) continue; /* 概率项由 FND98-11 管 */
      for (let seed = 0; seed < 200; seed += 1) {
        const ids = rollMobDrops(row.id, seed).map((d) => d.itemId);
        if (!ids.includes(entry.itemId)) {
          throw new Error(`${row.id} 的必掉项 ${entry.itemId} 在种子 ${seed} 下没掉`);
        }
      }
      checked += 1;
    }
  }
  ok(checked >= 20, `应抽查到 ≥20 个必掉项(实测 ${checked})`);
  /* 手册 L476「掉蓬松彩羽」**没写**概率 ⇒ 752 必须仍是必掉(概率项只有 751/753 两项)。 */
  eq(mobDropChanceOf('mob_chocobo', 752), 1, '★ 蓬松彩羽(手册没点「稀有」)⇒ 缺省必掉');
  const rareCount = MOB_LIST.reduce(
    (n, row) => n + mobDropTableOf(row.id).filter((e) => e.chance < 1).length, 0,
  );
  eq(rareCount, 2, '★ 全表概率项恰好 2 项(手册点名「稀有」的 751 / 753)');
});

test('FND98-10 ★ 概率项同种子可复现,且不同种子真的会不同', () => {
  const a = rollMobDrops('mob_squirrel', 11);
  const b = rollMobDrops('mob_squirrel', 11);
  eq(JSON.stringify(a), JSON.stringify(b), '★ 同 (mobId, seed) 两次判定逐位相同');
  eq(a.some((d) => d.itemId === RARE_TREE), true, '种子 11:稀有树种真的掉了');
  eq(rollMobDrops('mob_squirrel', 7).some((d) => d.itemId === RARE_TREE), false,
    '种子 7:同一只怪同一条掉落**没掉**(⇒ 不是「恒必掉」)');

  const seen = new Set<string>();
  for (let seed = 0; seed < 50; seed += 1) {
    seen.add(rollMobDrops('mob_squirrel', seed).some((d) => d.itemId === RARE_TREE) ? 'Y' : 'N');
  }
  eq(seen.size, 2, '50 个种子下「掉 / 不掉」两种结果都出现过');
});

test('FND98-11 ★ 长期频率 ≈ 概率:20000 个种子下 753 / 751 都 ≈ 0.15', () => {
  const freq = (mobId: string, itemId: number, n: number): number => {
    let hit = 0;
    for (let seed = 0; seed < n; seed += 1) {
      if (rollMobDrops(mobId, seed).some((d) => d.itemId === itemId)) hit += 1;
    }
    return hit / n;
  };
  const N = 20000;
  const tree = freq('mob_squirrel', RARE_TREE, N);
  const recipe = freq('mob_choco_golem', RARE_RECIPE, N);
  ok(Math.abs(tree - RARE) <= 0.01, `★ 753 频率 ${tree} 应 ≈ ${RARE}(±0.01)`);
  ok(Math.abs(recipe - RARE) <= 0.01, `★ 751 频率 ${recipe} 应 ≈ ${RARE}(±0.01)`);
  /* 负对照:必掉项的频率是**恰好 1**,不是「接近 1」—— 同一套 roll 下它不可能漏。 */
  eq(freq('mob_chocobo', 752, 2000), 1, '负对照:必掉项频率 = 1(小数概率项才可能漏)');
});

test('FND98-12 负对照:非法概率 fail-closed(NaN/≤0 ⇒ 不掉;>1 ⇒ 恒掉)', () => {
  const row = MOB_BY_ID.get('mob_sheep') as unknown as MobDropRow;
  ok(row !== undefined, '前置:表里有 mob_sheep');
  try {
    row.dropChance = { 119: Number.NaN };
    eq(mobDropChanceOf('mob_sheep', 119), 0, 'NaN 概率 ⇒ 读成 0(不许静默变必掉)');
    row.dropChance = { 119: -1 };
    eq(mobDropChanceOf('mob_sheep', 119), 0, '负概率 ⇒ 0');
    let hit = 0;
    for (let seed = 0; seed < 500; seed += 1) {
      if (rollMobDrops('mob_sheep', seed).some((d) => d.itemId === 119)) hit += 1;
    }
    eq(hit, 0, '500 个种子下非法概率一次都不掉');
    row.dropChance = { 119: 5 };
    eq(mobDropChanceOf('mob_sheep', 119), 1, '概率 > 1 ⇒ 钳到 1');
    eq(rollMobDrops('mob_sheep', 0).some((d) => d.itemId === 119), true, '钳到 1 之后必然掉');
    row.dropChance = { 119: 1 };
    eq(rollMobDrops('mob_sheep', 0).some((d) => d.itemId === 119), true, '概率 = 1 也必掉');
  } finally {
    delete row.dropChance; /* 还原内容表(测试不许改变内容语义) */
  }
  eq(mobDropChanceOf('mob_sheep', 119), 1, '还原后仍是必掉');
});

test('FND98-13 未知 mobId / 缺省键:空表、必掉、件数 1', () => {
  eq(mobDropTableOf('mob_不存在').length, 0, '未知 mobId ⇒ 空掉落(不抛错,调用方在热路径上)');
  eq(rollMobDrops('mob_不存在', 3).length, 0, '未知 mobId ⇒ 判定结果也是空');
  eq(mobDropChanceOf('mob_sheep', 701), 1, '没有 dropChance 键 ⇒ 必掉');
  eq(mobDropCountOf('mob_sheep', 119), 2, '件数取手册的 ×2');
  eq(mobDropCountOf('mob_choco_golem', 105), 5, '件数取手册的 ×5');
  eq(mobDropCountOf('mob_sheep', 701), 1, '手册没写 ×N ⇒ 1 件');
  /* 数据不变量:概率键必须是掉落键的子集(多余键不产生掉落,属于接线错误)。 */
  for (const r of MOB_LIST) {
    for (const key of Object.keys(r.dropChance ?? {})) {
      ok(Object.prototype.hasOwnProperty.call(r.drops, key),
        `${r.id} 的概率键 ${key} 必须在 drops 里(否则是个静默无效的按键)`);
    }
  }
});

/* ══════════════════ 7. 生产接线 ══════════════════ */

test('FND98-14 ★ 生产接线:打死怪 ⇒ `lastMobDrops`(同种子同一次击杀可复现,751/753 按概率)', () => {
  /** 打死一只怪(真走 `damageMob` → `settleKill`),返回世界。 */
  const kill = (seed: number, mobId: string): WorldSim => {
    const sim = bareSim(seed);
    sim.addPlayer('p1', 12.5, 12.5);
    sim.addMob(mobId, 'MEADOW', 14, 12.5);
    sim.damageMob(mobId, 999_999, 'PHYSICAL', 0);
    return sim;
  };

  const s7 = kill(7, 'mob_squirrel#1');
  eq(JSON.stringify(s7.lastMobDrops.map((d) => d.itemId)), '[101,753]',
    '★ 种子 7 + 实例 #1 ⇒ 101 与 753 都掉(稀有树种抽中;字面量锚:0.15 的概率)');
  const s17 = kill(17, 'mob_squirrel#1');
  eq(JSON.stringify(s17.lastMobDrops.map((d) => d.itemId)), '[101]',
    '★ 种子 17 + 实例 #1 ⇒ 只掉必掉的 101(同一只怪、另一个世界:稀有树种没抽中)');
  const same = kill(7, 'mob_squirrel#1');
  eq(JSON.stringify(same.lastMobDrops), JSON.stringify(s7.lastMobDrops),
    '★ 同种子 + **同一次击杀**(同实例 id)⇒ 同一份掉落(可复现)');

  /* 「接线没接错」的正面证据:与纯函数**同键**逐位相同(种子 = 世界身份,键 = 击杀实例维)。 */
  eq(JSON.stringify(s7.lastMobDrops),
    JSON.stringify(rollMobDrops('mob_squirrel', s7.worldSeed, 'mob_squirrel#1')),
    '★ 生产结果 = `rollMobDrops(def.id, worldSeed, 击杀实例 id)` 逐位相同');
  eq(JSON.stringify(s17.lastMobDrops),
    JSON.stringify(rollMobDrops('mob_squirrel', s17.worldSeed, 'mob_squirrel#1')),
    '★ 没抽中那一次也逐位相同');

  const golem = kill(7, 'mob_choco_golem#1');
  eq(JSON.stringify(golem.lastMobDrops.map((d) => d.itemId)), '[105,603,751]',
    '★ 种子 7 的巧克力盾卫 ⇒ 751 抽中(同一个字段在另一只怪上同样生效)');
  eq(golem.lastMobDrops.find((d) => d.itemId === 105)?.count, 5, '件数按手册 ×5 传下去');
  const golem1 = kill(1, 'mob_choco_golem#1');
  eq(JSON.stringify(golem1.lastMobDrops.map((d) => d.itemId)), '[105,603]',
    '★ 种子 1 ⇒ 必掉的 105/603 在,稀有甜点食谱 751 不在');

  /* 没发生过击杀 ⇒ 空(与 `lastKillSettle === null` 一起可区分)。 */
  const quiet = bareSim();
  quiet.addPlayer('p1', 12.5, 12.5);
  eq(quiet.lastMobDrops.length, 0, '没击杀 ⇒ 空掉落');
  eq(quiet.lastKillSettle, null, '没击杀 ⇒ 结算也是 null(两义可区分)');
});

/* ══════════════════ 8. P1:击杀实例维(同世界多次击杀的独立性) ══════════════════ */

test('FND98-15 ★ P1:同一世界连打 100 次同种稀有怪 ⇒ 掉落次数落在二项分布内(不是 0 也不是 100)', () => {
  /* 修前形态(`world_sim.ts` 只传 `worldSeed`):同一世界里同种怪**每次击杀的 roll 完全相同**
     ⇒ 要么 100 掉要么 100 不掉(=「该物种在这个世界必掉 / 必不掉」)。 */
  const N = 100;
  const series = killSeries(7, 'mob_squirrel', N);
  const hit = (ids: number[]): boolean => ids.includes(RARE_TREE);
  const hits = series.filter(hit).length;
  ok(hits > 0, `★ 100 次里必须掉过(实测 ${hits})—— 修前是「要么 0 要么 100」`);
  ok(hits < N, `★ 100 次里必须也有不掉(实测 ${hits})—— 恒掉同样是退化`);
  /* 0.15 × 100 = 15、二项分布 sd ≈ 3.6 ⇒ [5, 30] 是 ±3σ 的宽松带,够钉住「独立采样」。 */
  ok(hits >= 5 && hits <= 30, `★ 掉落次数 ${hits} 应落在 [5,30](0.15 的二项分布)`);
  /* ★ 更强的**形状**判据:FNV-1a 只吃序号末位时 roll 会成段相关(实测 seed 7 呈
     「9 掉 / 9 不掉 /…」阶梯,翻转 ≈ 8);真·独立采样的翻转数期望 ≈ 2 × 100 × 0.15 × 0.85 = 25.5。 */
  let transitions = 0;
  for (let i = 1; i < N; i += 1) {
    if (hit(series[i]) !== hit(series[i - 1])) transitions += 1;
  }
  ok(transitions >= 15, `★ 掉落序列的翻转次数 ${transitions} 应 ≥15(修前那个「阶梯」只有个位数)`);
  /* 必掉项在每一条里都在(同一条 roll 路径;实例维不该动必掉项)。 */
  eq(series.every((ids) => ids.includes(101)), true, '★ 100 次里必掉的 101 一次都没漏');
});

test('FND98-16 ★ 不同种子的两个世界 ⇒ 逐次掉落序列不同(各自也不是恒 0 / 恒 1)', () => {
  const a = killSeries(7, 'mob_squirrel', 100);
  const b = killSeries(8, 'mob_squirrel', 100);
  const hit = (ids: number[]): boolean => ids.includes(RARE_TREE);
  const hitsA = a.filter(hit).length;
  const hitsB = b.filter(hit).length;
  ok(hitsA > 0 && hitsA < 100, `世界 7:${hitsA}/100(既非恒掉也非恒不掉)`);
  ok(hitsB > 0 && hitsB < 100, `世界 8:${hitsB}/100(既非恒掉也非恒不掉)`);
  let diff = 0;
  for (let i = 0; i < 100; i += 1) if (hit(a[i]) !== hit(b[i])) diff += 1;
  ok(diff >= 10, `★ 两个不同种子的世界逐次结果不同处数 ${diff} 应 ≥10(修前两边都恒 0 ⇒ 差 0)`);
});

test('FND98-17 ★ 同 seed 重放逐次逐位一致,且逐次 = 纯函数同键结果', () => {
  const N = 60;
  const first = killSeries(7, 'mob_squirrel', N);
  const replay = killSeries(7, 'mob_squirrel', N);
  eq(JSON.stringify(replay), JSON.stringify(first), '★ 同 seed 的世界重放 60 次击杀 ⇒ 逐次掉落逐位一致');
  /* 逐次与纯函数**同键**(seed + 实例 id)逐位相同 ⇒ 「可复现」不是靠世界侧内部状态攒出来的。 */
  for (let i = 1; i <= N; i += 1) {
    const key = mobInstanceId('mob_squirrel', i);
    eq(
      JSON.stringify(first[i - 1]),
      JSON.stringify(rollMobDrops('mob_squirrel', 7, key).map((d) => d.itemId)),
      `第 ${i} 次击杀(键 ${key})应与纯函数同键结果一致`,
    );
  }
  /* 同一次击杀的键重复调用 = 同一个 roll(纯函数、无内部状态);不同次击杀的键 ⇒ 可以不同。 */
  eq(
    JSON.stringify(rollMobDrops('mob_squirrel', 7, 'mob_squirrel#1')),
    JSON.stringify(rollMobDrops('mob_squirrel', 7, 'mob_squirrel#1')),
    '★ 同键重复调用逐位相同',
  );
  eq(
    JSON.stringify(rollMobDrops('mob_squirrel', 7, 'mob_squirrel#1'))
      !== JSON.stringify(rollMobDrops('mob_squirrel', 7, 'mob_squirrel#2')),
    true,
    '★ 同 seed 下实例 #1 与 #2 的掉落不同(修前两者恒等)',
  );
});

report('WS-FND-98-knockback-and-drops');
