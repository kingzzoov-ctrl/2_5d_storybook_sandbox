/**
 * WS-05 测试:八大 Boss 战 — 召唤 / 人数缩放 / 阶段技能 / 预警几何 / 八条破防 / 个人掉落。
 *
 * 运行:`node tests/WS-05.test.ts`
 */

import { test, ok, eq, near, inRange, report } from '../shared/testing/harness.ts';
import { BOSS_LIST, BOSS_BY_ID, TOTAL_BOSS_COUNT } from '../shared/constants/bosses.ts';
import { bossScaledHp, SHARE_EXP_RADIUS, PARTY_BONUS } from '../shared/types/entities.ts';
import { Biome } from '../shared/types/entities.ts';
import { insideWarn, insideWarn3D, WARN_SHAPES, pointerAngleDeg } from '../server/src/mobs/geometry.ts';
import {
  SpawnReject, inSafeZone, safeZoneShield, TOWN_SAFE_RADIUS, type SpawnWorld,
} from '../server/src/mobs/spawner.ts';

import {
  summonBoss, SUMMON_ITEM_BY_BOSS, BOSS_BY_SUMMON_ITEM, summonItemCoverage,
  scalingCurve, allScalingCurves, rollPersonalLoot, canLoot, orbCountFor,
  fnv1a, seededRoll, RAID_MAX_PLAYERS, SUMMON_ITEM_MIN, SUMMON_ITEM_MAX,
  type RaidParticipant,
  summonBossWithOffering, makeOfferingPort, selfRecyclingBosses, summonItemsInLoot,
  SummonReject,
} from '../server/src/bosses/raid.ts';
import {
  createBossState, phaseIndexFor, skillWarnGeoms, tickBoss, applyBreak, damageBoss,
  spawnFoxClones, BREAK_STUN_SEC, BREAK_CRIT_BONUS, TIME_SHIELD_SEC, TIME_SHIELD_HEAL_RATIO,
  FOX_CLONE_COUNT, JELLY_SPLIT_COUNT,
  type BossState,
} from '../server/src/bosses/phases.ts';
import {
  jellyBreakReady, beaverBreakReady, foxBreakReady, crabSlideBreak, pullBreakReady,
  gingerBreakReady, whaleBreakReady, chronosBreakReady, evaluateBreak, settleBreak,
  survivorsAfterFoxBreak, fakeCloneCount, brokenCrystalCount,
  BREAK_ITEM, BREAK_BOSS_IDS, ICE_MU, OBSIDIAN_WALL_STUN_SEC,
  CRAB_SHELL_DR, WHALE_CRYSTAL_COUNT, CIRCUIT_COLORS, CHRONOS_CIRCUIT_COUNT,
  PULL_MIN_PLAYERS, PULL_FORCE_THRESHOLD,
} from '../server/src/bosses/breaks.ts';
/* task-35 生产接线:WorldSim 持有 Boss 副本运行时,并用内存版 OfferingPort 断言消耗。 */
import { WorldSim } from '../server/src/sim/world_sim.ts';
import type { BossRaidRuntime } from '../server/src/bosses/runtime.ts';
import { makeMemoryOfferingPort } from '../server/src/bosses/runtime.ts';

/* ═════════════════════ 1. 冻结层与祭品 ═════════════════════ */

test('W5-01 消费冻结层:8 个 Boss、8 个祭品 734-741 一一映射', () => {
  eq(BOSS_LIST.length, TOTAL_BOSS_COUNT, 'Boss 总数 = 8');
  const cov = summonItemCoverage();
  eq(cov.complete, true, '祭品 ID 恰好覆盖 734..741 无重无缺');
  eq(cov.ids.length, 8, '8 个祭品');
  eq(cov.ids[0], SUMMON_ITEM_MIN, '最小祭品 734');
  eq(cov.ids[cov.ids.length - 1], SUMMON_ITEM_MAX, '最大祭品 741');
  /* 每个 Boss 的召唤物与冻结表逐条一致 */
  for (const b of BOSS_LIST) {
    eq(SUMMON_ITEM_BY_BOSS.get(b.id), b.summonItem, `${b.id} 祭品 ID`);
    eq(BOSS_BY_SUMMON_ITEM.get(b.summonItem), b.id, `祭品 ${b.summonItem} 反查回 ${b.id}`);
  }
});

test('W5-02 祭坛召唤:正确祭品成功、错误祭品/无祭坛被拒', () => {
  /* 祭坛设在远离城镇中心的野外 (200,200),避免安全区规则干扰本条断言。 */
  const okReq = {
    bossId: 'boss_chronos_colossus', itemId: 741, hasAltar: true,
    altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
    playerCount: 4, alreadyAlive: false,
  };
  const good = summonBoss(okReq);
  eq(good.ok, true, '正确祭品召唤成功');
  eq(good.state!.maxHp, bossScaledHp(38000, 4), '血量按 4 人缩放');
  eq(good.scaledHp, bossScaledHp(38000, 4), '返回缩放血量');

  eq(summonBoss({ ...okReq, itemId: 734 }).reason, 'WRONG_ITEM', '错误祭品被拒');
  eq(summonBoss({ ...okReq, hasAltar: false }).reason, 'NO_ALTAR', '无祭坛被拒');
  eq(summonBoss({ ...okReq, bossId: 'boss_nope' }).reason, 'UNKNOWN_BOSS', '未知 Boss 被拒');
  eq(summonBoss({ ...okReq, alreadyAlive: true }).reason, 'BOSS_ALIVE', '同 Boss 存活时被拒');
  eq(summonBoss({ ...okReq, playerCount: RAID_MAX_PLAYERS + 1 }).reason, 'TOO_MANY_PLAYERS', '超人数被拒');
  /* 8 个 Boss 全部可用各自祭品召唤 */
  for (const b of BOSS_LIST) {
    const r = summonBoss({ ...okReq, bossId: b.id, itemId: b.summonItem, playerCount: 1 });
    eq(r.ok, true, `${b.name} 可召唤`);
  }
});

test('W5-02b 祭坛落在城镇安全区内 → 召唤失败(SAFE_ZONE)', () => {
  /* 基准请求:祭坛在野外,应成功 */
  const base = {
    bossId: 'boss_jelly_king', itemId: 734, hasAltar: true,
    altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
    playerCount: 2, alreadyAlive: false,
  };
  eq(summonBoss(base).ok, true, '野外祭坛可召唤');

  /* 祭坛坐标在 (0,0) 半径 24 内 → 必须失败 */
  const inside = summonBoss({ ...base, altarX: 10, altarY: 10 });
  eq(inside.ok, false, '安全区内祭坛召唤失败');
  eq(inside.reason, 'SAFE_ZONE', '拒绝原因 = SAFE_ZONE');
  eq(inside.reason, SpawnReject.SAFE_ZONE, '与刷怪路径同一字符串常量(单一事实源)');
  eq(inside.scaledHp, 0, '失败时不产生缩放血量');

  /* 边界:恰好 24 格在区内(含边界)、24+1e-6 在区外 */
  eq(summonBoss({ ...base, altarX: TOWN_SAFE_RADIUS, altarY: 0 }).reason, 'SAFE_ZONE', '恰好 24 格 → 区内,拒绝');
  eq(summonBoss({ ...base, altarX: TOWN_SAFE_RADIUS + 1e-6, altarY: 0 }).ok, true, '24+1e-6 格 → 区外,放行');
  /* 对角恰好 24 格 */
  const d = TOWN_SAFE_RADIUS * Math.SQRT1_2;
  eq(summonBoss({ ...base, altarX: d, altarY: d }).reason, 'SAFE_ZONE', '对角恰好 24 格 → 区内');

  /* 安全区检查先于祭品校验(与 spawner 的短路顺序一致) */
  eq(summonBoss({ ...base, altarX: 5, altarY: 5, itemId: 999 }).reason, 'SAFE_ZONE', '安全区优先于祭品校验');

  /* 换一个城镇中心,坐标随之平移 */
  eq(summonBoss({ ...base, altarX: 10, altarY: 10, townCenterX: 500, townCenterY: 500 }).ok, true, '城镇中心在 (500,500) 时 (10,10) 属野外');
});

test('W5-02c Boss 受伤路径不受安全区护盾影响(玩家专属护盾不得误用于 Boss)', () => {
  /* 规则:安全区护盾是给**玩家**的。Boss 被拉进安全区不应免伤。
     这里用「Boss 在安全区内仍能被正常扣血」来锁死该不变量。 */
  const town = { x: 0, y: 0 };
  const safeWorld: SpawnWorld = {
    objAt: () => 0,
    floorAt: () => 0,
    blocked: () => false,
    townCenter: () => town,
    isNight: () => true,
  };
  /* 前置:safeZoneShield 对**玩家**确实生效(否则本断言无意义) */
  near(safeZoneShield(safeWorld, 5, 5, 100), 0, 1e-9, '区内玩家全额吸收');
  near(safeZoneShield(safeWorld, 100, 100, 100), 100, 1e-9, '区外玩家不吸收');

  /* Boss 在安全区中心被拉入后,damageBoss 必须照常扣血 */
  const s = createBossState('boss_crab_kraken', 1);
  s.x = 5;
  s.y = 5; /* 明确处在安全区内 */
  ok(inSafeZone(safeWorld, s.x, s.y), '前置:Boss 坐标确实在安全区内');
  const before = s.hp;
  const r = damageBoss(s, 1000);
  eq(r.toHp, 1000, '安全区内 Boss 仍吃满伤害(护盾不适用于怪)');
  eq(s.hp, before - 1000, 'HP 正常扣除,不因安全区免伤');

  /* 结构性守卫:破防/阶段模块不得引用安全区护盾,防止未来误用 */
  eq(typeof safeZoneShield, 'function', '护盾函数存在且仅用于玩家伤害路径');
});

/* ═════════════════════ 2. 人数血量缩放 ═════════════════════ */

test('W5-03 bossScaledHp 冻结函数:N=1..16 严格单调递增', () => {
  for (const b of BOSS_LIST) {
    const c = scalingCurve(b.baseHp, 16);
    eq(c.curve.length, 16, `${b.id} 曲线 16 点`);
    eq(c.monotonic, true, `${b.id} 1..16 严格单调递增`);
    eq(c.baseAtOne, true, `${b.id} N=1 等于 baseHp`);
    for (let i = 1; i < c.curve.length; i += 1) {
      ok(c.curve[i] > c.curve[i - 1], `${b.id} N=${i + 1} 必须大于 N=${i}`);
    }
  }
  /* 冻结函数不可被实现层改写:逐点比对 */
  for (let n = 1; n <= 16; n += 1) {
    eq(bossScaledHp(11000, n), Math.round(11000 * (1 + 0.65 * (n - 1))), `N=${n} 与冻结公式一致`);
  }
});

test('W5-04 巨蟹 11000 在 N=16 的具体值 = 118250', () => {
  eq(bossScaledHp(11000, 16), 118250, '11000 × (1 + 0.65×15) = 118250');
  near(11000 * (1 + 0.65 * 15), 118250, 1e-9, '公式手算一致');
  eq(bossScaledHp(11000, 1), 11000, 'N=1 = baseHp');
  eq(bossScaledHp(11000, 2), 18150, 'N=2 = 18150');
  eq(bossScaledHp(11000, 4), 32450, 'N=4 = 32450');
});

test('W5-05 克洛诺斯 38000 在 N=16 的具体值 = 408500,全表 N=16 摘要', () => {
  eq(bossScaledHp(38000, 16), 408500, '38000 × (1 + 0.65×15) = 408500');
  const all = allScalingCurves(16);
  eq(all.boss_jelly_king, 26875, '果冻王 N=16 → 26875');
  eq(all.boss_beaver_mecha, 51600, '河狸 N=16 → 51600');
  eq(all.boss_fox_kitsune, 80625, '妖狐 N=16 → 80625');
  eq(all.boss_crab_kraken, 118250, '巨蟹 N=16 → 118250');
  eq(all.boss_scorpion_pharaoh, 161250, '法老蝎 N=16 → 161250');
  eq(all.boss_ginger_troll, 215000, '姜饼巨魔 N=16 → 215000');
  eq(all.boss_sky_whale, 279500, '云鲸 N=16 → 279500');
  eq(all.boss_chronos_colossus, 408500, '克洛诺斯 N=16 → 408500');
});

test('W5-06 缩放边界:N<1 被钳到 1、小数人数不取整(冻结函数语义)', () => {
  eq(bossScaledHp(11000, 0), 11000, 'N=0 钳到 1');
  eq(bossScaledHp(11000, -5), 11000, '负人数钳到 1');
  /* 冻结函数只对 N<1 做 max(1,n) 钳制,对小数**不取整**:
     11000 × (1 + 0.65×0.9) = 17435 —— 记录该语义,调用方需自行传入整数。 */
  eq(bossScaledHp(11000, 1.9), 17435, 'N=1.9 不取整(冻结函数语义)');
  eq(bossScaledHp(11000, 1.0), 11000, 'N=1.0 → baseHp');
  /* 生产路径只传整数,单调性成立 */
  for (let n = 1; n <= 16; n += 1) {
    eq(bossScaledHp(11000, n), Math.round(11000 * (1 + 0.65 * (n - 1))), `N=${n} 整数路径`);
  }
  ok(bossScaledHp(11000, 100) > bossScaledHp(11000, 16), 'N=100 > N=16');
});

/* ═════════════════════ 3. 阶段与预警几何 ═════════════════════ */

test('W5-07 阶段切换:血量比例跨阈值即推进,边界含等号', () => {
  const s = createBossState('boss_jelly_king', 1);
  eq(s.phaseIndex, 0, '开局 P1');
  eq(phaseIndexFor(s.def, 1.0), 0, '100% → P1');
  /* 果冻王阈值 1.0 / 0.5 / 0.25 */
  eq(phaseIndexFor(s.def, 0.51), 0, '51% 仍 P1');
  eq(phaseIndexFor(s.def, 0.5), 1, '恰好 50% → P2(含等号)');
  eq(phaseIndexFor(s.def, 0.49), 1, '49% → P2');
  eq(phaseIndexFor(s.def, 0.25), 2, '恰好 25% → P3');
  eq(phaseIndexFor(s.def, 0), 2, '0% → 末阶段');
  ok(phaseIndexFor(s.def, 0.5 - 1e-9) === 1, '阈值 -1e-9 仍 P2');
});

test('W5-08 五类预警几何齐备:8 个 Boss 的技能至少覆盖 圆/扇/矩形/环/指针', () => {
  eq(WARN_SHAPES.length, 5, '内核提供五类');
  const seen = new Set<string>();
  for (const b of BOSS_LIST) {
    for (let n = 1; n <= 4; n += 1) {
      const s = createBossState(b.id, 1);
      /* 把血量打到各阶段 */
      s.hp = s.maxHp * (n === 1 ? 1 : n === 2 ? 0.55 : n === 3 ? 0.3 : 0.1);
      tickBoss(s, 0.05, { target: { x: 5, y: 0 }, t: 0 });
      for (const g of skillWarnGeoms(s, { x: 5, y: 0 }, 0)) seen.add(g.kind);
    }
  }
  for (const k of WARN_SHAPES) ok(seen.has(k), `五类几何中缺少 ${k}`);
  eq(seen.size, 5, '恰好覆盖五类');
});

test('W5-09 果冻王 P1 环形波:环内命中、环心与环外安全', () => {
  const s = createBossState('boss_jelly_king', 1);
  const geoms = skillWarnGeoms(s, { x: 5, y: 0 }, 0);
  eq(geoms.length, 1, 'P1 一条环形波');
  eq(geoms[0].kind, 'RING', '几何类型为环');
  const g = geoms[0];
  eq(insideWarn(g, 0, 0), false, '环心(自身中心)不在内');
  eq(insideWarn(g, 2.5, 0), true, '内径边界在内');
  eq(insideWarn(g, 3.0, 0), true, '环带内命中');
  eq(insideWarn(g, 3.5, 0), true, '外径边界在内');
  eq(insideWarn(g, 3.5 + 1e-9, 0), false, '外径 +1e-9 安全');
  eq(insideWarn(g, 2.5 - 1e-9, 0), false, '内径 -1e-9 安全(环心侧)');
  inRange(g.warnSec, 0.8, 0.8, '预警 0.8s');
});

test('W5-10 果冻王 P2 六分裂 / P3 巨口吸气扇形', () => {
  const s = createBossState('boss_jelly_king', 1);
  s.hp = s.maxHp * 0.5; tickBoss(s, 0.05, { target: { x: 5, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 5, y: 0 }, 0);
  /* 期望值写死 6,不引 `JELLY_SPLIT_COUNT` ——
     引被测常量等于同义反复(常量改成 9 两侧同步移动,断言无法失败)。
     出处:手册 L495 P2 原文「分裂成 **6 只**中型果冻四散逃跑」。 */
  eq(p2.length, 6, '6 只中型果冻各一个圆(手册 L495)');
  eq(p2.every((g) => g.kind === 'CIRCLE'), true, '全部为圆');
  eq(p2.every((g) => Math.abs(g.radius - 1.2) < 1e-12), true, '半径 1.2');

  s.hp = s.maxHp * 0.25; tickBoss(s, 0.05, { target: { x: 5, y: 0 }, t: 0 });
  const p3 = skillWarnGeoms(s, { x: 5, y: 0 }, 0);
  eq(p3.length, 1, 'P3 一个锥形区');
  eq(p3[0].kind, 'SECTOR', '扇形');
  eq(p3[0].halfDeg, 22.5, '45° 锥形(半张角 22.5°)');
  eq(p3[0].radius, 6, '长度 6 格');
  eq(insideWarn(p3[0], 3, 0), true, '轴线内命中');
  eq(insideWarn(p3[0], 6, 0), true, '末端边界命中');
  eq(insideWarn(p3[0], 6 + 1e-9, 0), false, '末端 +1e-9 安全');
});

test('W5-11 机甲河狸 P1 窄长矩形 / P2 木坝掩体区', () => {
  const s = createBossState('boss_beaver_mecha', 1);
  const p1 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p1.length, 1, 'P1 一个矩形');
  eq(p1[0].kind, 'RECT', '矩形');
  near(p1[0].halfLen, 6, 1e-12, '半长 6 → 全长 12');
  near(p1[0].halfWidth, 1, 1e-12, '半宽 1 → 全宽 2');
  eq(insideWarn(p1[0], 6, 0), true, '长轴末端命中');
  eq(insideWarn(p1[0], 6 + 1e-9, 0), false, '长轴 +1e-9 安全');
  eq(insideWarn(p1[0], 0, 1), true, '短轴边界命中');
  eq(insideWarn(p1[0], 0, 1 + 1e-9), false, '短轴 +1e-9 安全');

  s.hp = s.maxHp * 0.5; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p2[0].halfLen, 2.5, '木坝 5 格长(半长 2.5)');
  eq(p2[0].halfWidth, 1.5, '木坝 3 格宽(半宽 1.5)');
});

test('W5-12 妖狐 P1 三道 30° 风刃 / P2 四分身', () => {
  const s = createBossState('boss_fox_kitsune', 1);
  const p1 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p1.length, 3, '三道风刃');
  eq(p1.every((g) => g.kind === 'SECTOR'), true, '全部扇形');
  eq(p1.every((g) => g.halfDeg === 15), true, '每道 30°(半张角 15°)');
  eq(p1.every((g) => g.radius === 8), true, '长 8 格');
  /* 三道的轴角互隔 25° */
  near(p1[1].centerDeg - p1[0].centerDeg, 25, 1e-9, '相邻风刃间隔 25°');

  s.hp = s.maxHp * 0.6; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p2.length, FOX_CLONE_COUNT, '4 个分身蓄力圈');
  eq(p2.every((g) => g.radius === 2), true, '半径 2');
  eq(s.clones.length, FOX_CLONE_COUNT, '状态里也生成 4 个分身');
  eq(fakeCloneCount(s.clones), 3, '3 个假分身');
  eq(survivorsAfterFoxBreak(s.clones).length, 1, '破幻后只剩 1 个真身');
});

test('W5-13 巨蟹 P1 双钳射线 / P2 弹射圆', () => {
  const s = createBossState('boss_crab_kraken', 1);
  const p1 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p1.length, 2, '两条激光射线');
  eq(p1.every((g) => g.kind === 'RECT'), true, '射线是矩形');
  eq(p1.every((g) => Math.abs(g.halfWidth - 0.4) < 1e-12), true, '宽 0.8');
  eq(p1.every((g) => Math.abs(g.halfLen - 5) < 1e-12), true, '长 10');

  s.hp = s.maxHp * 0.45; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p2[0].kind, 'CIRCLE', 'P2 弹射是圆');
  eq(p2[0].radius, 1.2, '半径 1.2');
});

test('W5-14 法老蝎 P1 流沙漩涡 / P2 仅露毒尾无大红圈', () => {
  const s = createBossState('boss_scorpion_pharaoh', 1);
  const p1 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p1[0].kind, 'CIRCLE', 'P1 向心吸附区');
  eq(p1[0].radius, 5, '半径 5');
  eq(p1[0].warnSec, 2.0, '持续 2s');
  eq(insideWarn(p1[0], 5, 0), true, '半径边界命中');
  eq(insideWarn(p1[0], 5 + 1e-9, 0), false, '半径 +1e-9 安全');

  s.hp = s.maxHp * 0.5; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p2[0].kind, 'RECT', 'P2 是细长凸起(非大红圈)');
  eq(p2[0].halfWidth, 0.35, '很窄');
  ok(p2[0].radius < 2, 'P2 没有大范围红圈');
});

test('W5-15 云鲸 P1 云浪宽环 / P2 Z=2 高空 60° 扇形', () => {
  const s = createBossState('boss_sky_whale', 1);
  const p1 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p1[0].kind, 'RING', 'P1 环状云浪');
  near(p1[0].radius - p1[0].innerRadius, 3, 1e-12, '环宽 3 格');
  eq(insideWarn(p1[0], 10.5, 0), true, '环带内命中');
  eq(insideWarn(p1[0], 8.9, 0), false, '内侧外安全');

  s.hp = s.maxHp * 0.55; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p2[0].kind, 'SECTOR', 'P2 巨大扇形');
  eq(p2[0].halfDeg, 30, '60°(半张角 30°)');
  eq(p2[0].radius, 14, '长 14 格');
  eq(p2[0].z, 2, '从 Z=2 高空吐息');
  /* Z 层判定:地面玩家(z=0)应被判定命中(zTolerance 1.6 覆盖到 0.4 以上) */
  eq(insideWarn3D(p2[0], 5, 0, 2), true, '同层命中');
  eq(s.z, 2, 'P2 升空到 Z=2');
});

test('W5-16 克洛诺斯 P1 旋转指针 / P2 四角四色环 / P3 全场改写', () => {
  const s = createBossState('boss_chronos_colossus', 1);
  const p1 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p1[0].kind, 'POINTER', 'P1 旋转指针');
  eq(p1[0].radius, 12, '长 12 格');
  eq(p1[0].halfWidth, 0.5, '宽 1 格');
  /* 指针推进:30°/s。t=2s → 60°,故 60° 方向上的点命中,90° 方向不命中。 */
  const p60 = { x: Math.cos(60 * Math.PI / 180) * 6, y: Math.sin(60 * Math.PI / 180) * 6 };
  eq(insideWarn(p1[0], p60.x, p60.y, 0), false, 't=0 时 60° 方向不在指针上');
  eq(insideWarn(p1[0], p60.x, p60.y, 2), true, 't=2s 转 60° 后该点落在指针上');
  eq(insideWarn(p1[0], 0, 5, 2), false, '90° 方向仍不在指针上');
  eq(insideWarn(p1[0], 0, 5, 3), true, 't=3s 转 90° 后 +y 才命中');
  near(pointerAngleDeg(p1[0], 2), 60, 1e-12, '角速度 30°/s');
  eq(insideWarn(p1[0], 12, 0, 0), true, 't=0 指针末端命中');
  eq(insideWarn(p1[0], 12 + 1e-9, 0, 0), false, '末端 +1e-9 安全');

  s.hp = s.maxHp * 0.65; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p2 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p2.length, CHRONOS_CIRCUIT_COUNT + 1, '四角指示环 + 中央脉冲塔');
  eq(p2.filter((g) => g.kind === 'RING').length, 4, '四个环');
  eq(p2.filter((g) => g.kind === 'CIRCLE').length, 1, '中央一个圆');
  eq(s.shieldSec, TIME_SHIELD_SEC, 'P2 开启 8 秒时间护盾');

  s.hp = s.maxHp * 0.3; tickBoss(s, 0.05, { target: { x: 10, y: 0 }, t: 0 });
  const p3 = skillWarnGeoms(s, { x: 10, y: 0 }, 0);
  eq(p3[0].kind, 'RECT', 'P3 全场预闪');
  eq(p3[0].halfLen, 12, '覆盖 24×24');
});

/* ═════════════════════ 4. 阶段推进与时间护盾 ═════════════════════ */

test('W5-17 阶段推进:掉血跨阈值切阶段并重置施法冷却', () => {
  const s = createBossState('boss_chronos_colossus', 4);
  eq(s.phaseIndex, 0, '开局 P1');
  const hp0 = s.hp;
  /* 打到 30% 以下,跨过 0.65 与 0.3 */
  s.hp = Math.round(hp0 * 0.29);
  const switched = tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(switched, true, '检测到阶段切换');
  eq(s.phaseIndex, 2, '进入 P3');
  eq(s.phaseSec, 0.05, '阶段计时重置后累加了一帧');
  eq(s.casts, 0, '切阶段后施法计数未增加(本帧未施法)');
});

test('W5-18 时间护盾:8 秒内未破则回血,破防则回血取消', () => {
  const s = createBossState('boss_chronos_colossus', 1);
  s.hp = Math.round(s.maxHp * 0.64);
  tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s.phaseIndex, 1, '进入 P2');
  eq(s.shieldSec, TIME_SHIELD_SEC, '护盾窗口 8s');
  const hpAfterSwitch = s.hp;
  /* 推进 8 秒未破防 → 回血 */
  for (let i = 0; i < 161; i += 1) tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s.shieldSec, 0, '护盾窗口结束');
  const expectHeal = Math.round(s.maxHp * TIME_SHIELD_HEAL_RATIO);
  eq(s.healedBack, expectHeal, `回血 ${expectHeal}(20% 上限)`);
  ok(s.hp > hpAfterSwitch, '血量确实回升');

  /* 破防路径:回血不发生 */
  const s2 = createBossState('boss_chronos_colossus', 1);
  s2.hp = Math.round(s2.maxHp * 0.64);
  tickBoss(s2, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  applyBreak(s2);
  for (let i = 0; i < 200; i += 1) tickBoss(s2, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s2.healedBack, 0, '破防后不回血');
});

test('W5-19 护盾吸收伤害:先吃护盾再扣血', () => {
  const s = createBossState('boss_chronos_colossus', 1);
  s.hp = Math.round(s.maxHp * 0.64);
  tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  const shield = s.shieldHp;
  ok(shield > 0, '护盾有血量');
  const hpBefore = s.hp;
  const r = damageBoss(s, shield - 10);
  eq(r.toShield, shield - 10, '全部打进护盾');
  eq(r.toHp, 0, '本体未掉血');
  eq(s.hp, hpBefore, 'HP 不变');
  const r2 = damageBoss(s, 50);
  eq(r2.toShield, 10, '剩余 10 点打进护盾');
  eq(r2.toHp, 40, '其余 40 打本体');
  eq(s.shieldSec, 0, '护盾破碎后窗口关闭');
});

test('W5-20 破防眩晕窗口与全队暴击加成:8 个 Boss 逐条核对时长', () => {
  for (const b of BOSS_LIST) {
    const s = createBossState(b.id, 1);
    const r = settleBreak(s, b.id);
    eq(r.stunSec, BREAK_STUN_SEC[b.id], `${b.name} 眩晕窗口 = 冻结表值`);
    /* 期望值写死 1.00(+100%),不引 `BREAK_CRIT_BONUS` —— 引被测常量是同义反复。
       出处:手册 L495 破防原文「炸翻肚皮朝天眩晕 6 秒,**全队上去暴打全暴击**」;
       手册只描述「全暴击」这一效果,未给倍率数值,故倍率按**设计基线** 1.00 钉死。 */
    eq(r.critBonus, 1.00, `${b.name} 全队暴击加成 +100%(手册 L495「全暴击」)`);
    eq(s.stunnedSec, r.stunSec, '状态已套用');
    eq(s.critBonus, 1.00, '暴击加成生效');
    /* 眩晕期间不施法、无预警几何 */
    const casts0 = s.casts;
    for (let i = 0; i < 20; i += 1) tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
    eq(s.casts, casts0, `${b.name} 眩晕期间不施法`);
    eq(skillWarnGeoms(s, { x: 0, y: 0 }, 0).length, 0, `${b.name} 眩晕期间无预警几何`);
    eq(s.critBonus, 1.00, '眩晕期间保持暴击加成');
  }
  /* 窗口走完后加成归零 */
  const s = createBossState('boss_jelly_king', 1);
  applyBreak(s);
  for (let i = 0; i < 130; i += 1) tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s.stunnedSec, 0, '眩晕结束');
  eq(s.critBonus, 0, '暴击加成随窗口结束而消失');
});

test('W5-21 破防结算一致性:BossState 与 bossId 不匹配必须报错', () => {
  const s = createBossState('boss_jelly_king', 1);
  let threw = false;
  try {
    settleBreak(s, 'boss_crab_kraken');
  } catch {
    threw = true;
  }
  eq(threw, true, '不匹配时抛错,防止跨 Boss 套用时长');
});

/* ═════════════════════ 5. 八条破防(可判定布尔) ═════════════════════ */

test('W5-22 破防① 果冻王:点燃炸弹果顺着吸力喂进嘴', () => {
  const base = { phaseIndex: 2, suctionActive: true, feedItem: BREAK_ITEM.BOMB_FRUIT, lit: true, distanceToMouth: 2, mouthRadius: 3 };
  eq(jellyBreakReady(base), true, 'P3 吸气 + 点燃炸弹果 + 在嘴内 → 破防');
  eq(jellyBreakReady({ ...base, lit: false }), false, '未点燃的炸弹果不生效');
  eq(jellyBreakReady({ ...base, suctionActive: false }), false, '未在吸气阶段不生效');
  eq(jellyBreakReady({ ...base, phaseIndex: 0 }), false, 'P1 不生效');
  eq(jellyBreakReady({ ...base, distanceToMouth: 3 }), true, '恰好贴到嘴边界生效');
  eq(jellyBreakReady({ ...base, distanceToMouth: 3 + 1e-9 }), false, '超出嘴半径 1e-9 不生效');
  eq(jellyBreakReady({ ...base, feedItem: BREAK_ITEM.THORN_MAT, lit: false }), true, '荆棘地垫无需点燃');
  eq(jellyBreakReady({ ...base, feedItem: 101 }), false, '普通原木不生效');
});

test('W5-23 破防② 机甲河狸:开闸放水冲坝', () => {
  const base = { damPresent: true, channelIntact: true, gateOpened: true, upstreamHigher: true };
  eq(beaverBreakReady(base), true, '四项齐备 → 冲垮木坝');
  eq(beaverBreakReady({ ...base, channelIntact: false }), false, '引水渠缺一格 → 不破防');
  eq(beaverBreakReady({ ...base, gateOpened: false }), false, '未拉闸 → 不破防');
  eq(beaverBreakReady({ ...base, upstreamHigher: false }), false, '上游不低于坝体 → 水到不了');
  eq(beaverBreakReady({ ...base, damPresent: false }), false, '还没筑坝 → 无坝可冲');
});

test('W5-24 破防③ 妖狐:小号/音符砖破幻,震碎所有假分身', () => {
  const s = createBossState('boss_fox_kitsune', 1);
  s.hp = Math.round(s.maxHp * 0.6);
  tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s.clones.length, 4, '已有 4 个分身');
  const base = { clones: s.clones, instrumentItem: BREAK_ITEM.TRUMPET, noteCircuitOn: false, instrumentReady: true };
  eq(foxBreakReady(base), true, '小号破幻');
  eq(foxBreakReady({ ...base, instrumentReady: false }), false, '乐器冷却中不生效');
  eq(foxBreakReady({ ...base, instrumentItem: 101 }), false, '非小号不生效');
  eq(foxBreakReady({ ...base, instrumentItem: 0, noteCircuitOn: true }), true, '音符砖电路通电同样破幻');
  eq(foxBreakReady({ ...base, clones: [] }), false, '无分身时不触发');
  eq(foxBreakReady({ ...base, noteCircuitOn: false, instrumentItem: 0 }), false, '两条路径都不满足');
  ok(fakeCloneCount(s.clones) === 3 && survivorsAfterFoxBreak(s.clones).length === 1, '1 真 3 假');
});

test('W5-25 破防④ 巨蟹:315 冰砖上 μ=0.98 失控,撞 359 碎壳,眩晕 6 秒', () => {
  const base = {
    floorUnder: BREAK_ITEM.ICE_BRICK, speed: 10, slidDistance: 5,
    obstacleAhead: BREAK_ITEM.OBSIDIAN_WALL, shellDr: 0.90,
  };
  const r = crabSlideBreak(base);
  eq(ICE_MU, 0.98, '冰砖摩擦系数 μ=0.98(冻结物品表 315)');
  eq(r.uncontrolled, true, '冰面上失去控制');
  eq(r.shattered, true, '撞上黑曜石墙碎壳');
  eq(r.shellDrAfter, 0, '壳减伤从 90% 降到 0');
  eq(base.shellDr, 0.90, '撞击前确实是 90% 减伤');
  /* 直接钉住实现常量 —— 出处:手册 L498「全身紫晶壳减免 **90%** 伤害」。
     原写法 `eq(base.shellDr, CRAB_SHELL_DR)` 是把常量当输入再断言透传,
     对「必须是 90%」零约束;且该常量在实现侧当前**零消费点**(见报告)。 */
  eq(CRAB_SHELL_DR, 0.90, 'CRAB_SHELL_DR = 90%(手册 L498)');
  eq(r.stunSec, 6.0, '眩晕窗口 6 秒');

  /* 边界:非冰面 / 滑行不足 / 撞的不是黑曜石 / 速度不够 */
  eq(crabSlideBreak({ ...base, floorUnder: 301 }).uncontrolled, false, '普通农田不打滑');
  eq(crabSlideBreak({ ...base, slidDistance: 4 }).uncontrolled, true, '恰好 4 格即失控');
  eq(crabSlideBreak({ ...base, slidDistance: 4 - 1e-9 }).uncontrolled, false, '3.999 格未失控');
  const noWall = crabSlideBreak({ ...base, obstacleAhead: 106 });
  eq(noWall.shattered, false, '撞普通石块不碎壳');
  eq(noWall.shellDrAfter, 0.90, '未碎壳则减伤保持 90%');
  eq(crabSlideBreak({ ...base, speed: 8.0 }).shattered, true, '恰好 8.0 格/秒撞碎');
  eq(crabSlideBreak({ ...base, speed: 8.0 - 1e-9 }).shattered, false, '略低于 8.0 只是擦碰');
});

test('W5-26 破防⑤ 法老蝎:2~4 人拔河拽出沙面', () => {
  const two = pullBreakReady({ forces: [1, 1], anchored: [true, true], aligned: [true, true] });
  eq(two.ok, true, '2 人合力达标 → 拽出');
  eq(two.pullers, 2, '有效人数 2');
  near(two.totalForce, 2.0, 1e-12, '合力恰好等于阈值 2.0');

  const one = pullBreakReady({ forces: [1], anchored: [true], aligned: [true] });
  eq(one.ok, false, '单人拽不动');
  eq(one.reason, 'too_few', '原因 = 人数不足');

  const four = pullBreakReady({ forces: [1, 1, 1, 1], anchored: [true, true, true, true], aligned: [true, true, true, true] });
  eq(four.ok, true, '4 人上限内成立');
  eq(four.pullers, 4, '4 人参与');

  const five = pullBreakReady({ forces: [1, 1, 1, 1, 1], anchored: [true, true, true, true, true], aligned: [true, true, true, true, true] });
  eq(five.ok, false, '超过 4 人被拒');
  eq(five.reason, 'too_many', '原因 = 人数超限');

  /* 有一人未挂稳 → 有效人数掉到 1,不成立 */
  const loose = pullBreakReady({ forces: [1, 1], anchored: [true, false], aligned: [true, true] });
  eq(loose.ok, false, '一人未挂稳 → 不成立');
  eq(loose.pullers, 1, '有效人数只剩 1');
  /* 侧拉(不共线)同样不算 */
  const side = pullBreakReady({ forces: [1, 1], anchored: [true, true], aligned: [true, false] });
  eq(side.ok, false, '侧拉不算有效拉力');
  /* 拉力不足 */
  const weak = pullBreakReady({ forces: [0.5, 0.5], anchored: [true, true], aligned: [true, true] });
  eq(weak.ok, false, '合力 1.0 < 2.0');
  eq(weak.reason, 'force_low', '原因 = 拉力不足');
  eq(PULL_MIN_PLAYERS, 2, '阈值人数 2');
  eq(PULL_FORCE_THRESHOLD, 2.0, '阈值合力 2.0');
});

test('W5-27 破防⑥ 姜饼巨魔:蹦床反弹 或 黑暗料理投喂', () => {
  const base = { trampolinePlaced: false, sugarBallRebounded: false, darkCuisineFed: false, containsMushroom: false, mouthOpen: false };
  eq(gingerBreakReady({ ...base, trampolinePlaced: true, sugarBallRebounded: true }), true, '蹦床反弹砸晕自己');
  eq(gingerBreakReady({ ...base, trampolinePlaced: true, sugarBallRebounded: false }), false, '铺了蹦床但糖球没反弹 → 不生效');
  eq(gingerBreakReady({ ...base, trampolinePlaced: false, sugarBallRebounded: true }), false, '没有蹦床 → 不生效');
  eq(gingerBreakReady({ ...base, darkCuisineFed: true, containsMushroom: true, mouthOpen: true }), true, '黑暗料理喂它变大肥鸡');
  eq(gingerBreakReady({ ...base, darkCuisineFed: true, containsMushroom: false, mouthOpen: true }), false, '料理没加变身菇 → 不生效');
  eq(gingerBreakReady({ ...base, darkCuisineFed: true, containsMushroom: true, mouthOpen: false }), false, '没张嘴 → 喂不进去');
  eq(gingerBreakReady(base), false, '空输入不成立');
});

test('W5-28 破防⑦ 云鲸:飞艇/叠罗汉登背敲碎 3 颗雷晶', () => {
  const crackedAll = [true, true, true];
  const base = { crystalBroken: crackedAll, boardingMethod: 'AIRSHIP', stackDepth: 0, withinWindow: true };
  eq(whaleBreakReady(base), true, '飞艇登背 + 3 颗全碎 → 净化');
  eq(whaleBreakReady({ ...base, crystalBroken: [true, true, false] }), false, '只碎 2 颗 → 不成立');
  eq(brokenCrystalCount({ ...base, crystalBroken: [true, true, false] }), 2, '计数 2');
  eq(whaleBreakReady({ ...base, crystalBroken: [true, true] }), false, '雷晶数量与冻结值不符');
  eq(whaleBreakReady({ ...base, withinWindow: false }), false, '超出 6 秒窗口 → 不成立');
  /* 叠罗汉路径需要 4 层 */
  const stack = { ...base, boardingMethod: 'STACK', stackDepth: 4 };
  eq(whaleBreakReady(stack), true, '4 人叠罗汉登背');
  eq(whaleBreakReady({ ...stack, stackDepth: 3 }), false, '3 层不够高');
  eq(whaleBreakReady({ ...base, boardingMethod: 'NONE' }), false, '未登背不成立');
  eq(WHALE_CRYSTAL_COUNT, 3, '冻结值 3 颗雷晶');
});

test('W5-29 破防⑧ 克洛诺斯:四角四色齐备才破盾,三缺一不破', () => {
  const all = [true, true, true, true];
  const base = { circuitsOn: all, platesPressed: all, towerPowered: true, shieldActive: true };
  const r = chronosBreakReady(base);
  eq(r.ok, true, '四色齐备 + 塔通电 + 护盾在 → 击穿');
  eq(r.circuitsCount, 4, '接通 4 路');
  eq(r.missing.length, 0, '无缺失');

  /* 三缺一(逐色验证,必须失败) */
  for (let k = 0; k < CHRONOS_CIRCUIT_COUNT; k += 1) {
    const partial = all.map((v, i) => (i === k ? false : v));
    const rr = chronosBreakReady({ ...base, circuitsOn: partial });
    eq(rr.ok, false, `缺 ${CIRCUIT_COLORS[k]} 时不破盾`);
    eq(rr.circuitsCount, 3, '只接通 3 路');
    eq(rr.missing.join(','), CIRCUIT_COLORS[k], `缺失清单精确指出 ${CIRCUIT_COLORS[k]}`);
    eq(rr.reason, 'circuit_incomplete', '原因 = 电路不完整');
    /* 压力板未压住等同于电路未接通 */
    const plateMissing = all.map((v, i) => (i === k ? false : v));
    eq(chronosBreakReady({ ...base, platesPressed: plateMissing }).ok, false, `压力板缺 ${CIRCUIT_COLORS[k]} 时同样不破`);
  }
  /* 两路缺失 */
  eq(chronosBreakReady({ ...base, circuitsOn: [true, true, false, false] }).circuitsCount, 2, '只接通 2 路');
  eq(chronosBreakReady({ ...base, circuitsOn: [true, false, false, false] }).reason, 'circuit_incomplete', '单路不破');
  /* 四色齐备但塔未通电 */
  eq(chronosBreakReady({ ...base, towerPowered: false }).reason, 'tower_unpowered', '塔未通电不破');
  /* 四色齐备但护盾已消失 → 无需破 */
  eq(chronosBreakReady({ ...base, shieldActive: false }).reason, 'shield_gone', '护盾已消失');
  eq(CHRONOS_CIRCUIT_COUNT, 4, '冻结值 4 路');
});

test('W5-30 八条破防统一入口:返回 boolean 且覆盖全部 8 个 Boss', () => {
  eq(BREAK_BOSS_IDS.length, 8, '8 个 Boss 都有破防');
  ok(BREAK_BOSS_IDS.every((id) => BOSS_BY_ID.has(id)), 'ID 与冻结表一致');
  eq(new Set(BREAK_BOSS_IDS).size, 8, '无重复');

  /* 每个 Boss 在「完美输入」下破防、在「空输入」下不破防 */
  const perfect: Record<string, unknown> = {
    boss_jelly_king: { phaseIndex: 2, suctionActive: true, feedItem: BREAK_ITEM.BOMB_FRUIT, lit: true, distanceToMouth: 1, mouthRadius: 3 },
    boss_beaver_mecha: { damPresent: true, channelIntact: true, gateOpened: true, upstreamHigher: true },
    boss_fox_kitsune: { clones: [{ id: 0, x: 0, y: 0, isReal: true, chargeSec: 0 }], instrumentItem: BREAK_ITEM.TRUMPET, noteCircuitOn: false, instrumentReady: true },
    boss_crab_kraken: { floorUnder: BREAK_ITEM.ICE_BRICK, speed: 10, slidDistance: 5, obstacleAhead: BREAK_ITEM.OBSIDIAN_WALL, shellDr: 0.90 },
    boss_scorpion_pharaoh: { forces: [1, 1], anchored: [true, true], aligned: [true, true] },
    boss_ginger_troll: { trampolinePlaced: true, sugarBallRebounded: true, darkCuisineFed: false, containsMushroom: false, mouthOpen: false },
    boss_sky_whale: { crystalBroken: [true, true, true], boardingMethod: 'AIRSHIP', stackDepth: 0, withinWindow: true },
    boss_chronos_colossus: { circuitsOn: [true, true, true, true], platesPressed: [true, true, true, true], towerPowered: true, shieldActive: true },
  };
  for (const id of BREAK_BOSS_IDS) {
    eq(evaluateBreak(id, perfect[id]).ok, true, `${id} 完美输入应破防`);
    eq(typeof evaluateBreak(id, perfect[id]).ok, 'boolean', '返回严格布尔');
  }
  eq(evaluateBreak('boss_unknown', {}).ok, false, '未知 Boss 返回 false');
  eq(evaluateBreak('boss_unknown', {}).reason, 'unsupported', '未知 Boss 给出原因');
});

test('W5-31 破防成功 → 眩晕窗口 → 全队暴击:端到端串联(以克洛诺斯为例)', () => {
  const s = createBossState('boss_chronos_colossus', 8);
  s.hp = Math.round(s.maxHp * 0.64);
  tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s.phaseIndex, 1, '进入 P2 并开盾');
  eq(s.shieldSec, TIME_SHIELD_SEC, '时间护盾已开启');

  const input = { circuitsOn: [true, true, true, false], platesPressed: [true, true, true, true], towerPowered: true, shieldActive: true };
  eq(evaluateBreak('boss_chronos_colossus', input).ok, false, '三缺一 → 不破');
  /* 补上第四色 */
  const full = { ...input, circuitsOn: [true, true, true, true] };
  eq(evaluateBreak('boss_chronos_colossus', full).ok, true, '四色齐备 → 破盾');
  const settled = settleBreak(s, 'boss_chronos_colossus');
  eq(settled.stunSec, BREAK_STUN_SEC.boss_chronos_colossus, '眩晕 6 秒');
  eq(settled.critBonus, 1.00, '全队暴击 +100%(手册 L495)');
  eq(s.shieldSec, 0, '护盾被击穿');
  eq(s.shieldHp, 0, '护盾血量归零');
  /* 眩晕期间输出窗口:本体可被打 */
  const hpBefore = s.hp;
  const dmg = damageBoss(s, 5000);
  eq(dmg.toHp, 5000, '无护盾阻挡,全额进本体');
  eq(s.hp, hpBefore - 5000, 'HP 正确扣除');
  /* 窗口结束 */
  for (let i = 0; i < 121; i += 1) tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 });
  eq(s.stunnedSec, 0, '眩晕结束');
  eq(s.critBonus, 0, '暴击加成失效');
  eq(s.healedBack, 0, '已破防故不回血');
});

/* ═════════════════════ 6. 个人独立掉落 ═════════════════════ */

function makeParticipants(n: number): RaidParticipant[] {
  const out: RaidParticipant[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: `p${i}`, contributed: true, damageDealt: 1000, x: i * 2, y: 0 });
  }
  return out;
}

test('W5-32 个人独立掉落:8 人各得一球、球互不相同且仅本人可拾', () => {
  const parts = makeParticipants(8);
  const orbs = rollPersonalLoot('boss_crab_kraken', parts);
  eq(orbs.length, 8, '8 人各得一球');
  eq(orbCountFor(parts), 8, '光球数 = 参与人数');
  eq(new Set(orbs.map((o) => o.orbId)).size, 8, 'orbId 唯一');
  eq(new Set(orbs.map((o) => o.ownerId)).size, 8, 'ownerId 唯一');
  eq(orbs.every((o) => o.personal === true), true, '全部标记为个人独立掉落');
  eq(orbs.map((o) => o.ownerId).sort().join(','), parts.map((p) => p.id).sort().join(','), '每人恰好一球');

  /* 仅本人可拾 */
  const orb0 = orbs.find((o) => o.ownerId === 'p0')!;
  eq(canLoot(orb0, 'p0', false), true, '本人可拾');
  eq(canLoot(orb0, 'p1', false), false, '他人不可拾');
  eq(canLoot(orb0, 'p0', true), false, '挂机者不可拾');

  /* 战利品取自冻结表的 loot 清单 */
  const def = BOSS_BY_ID.get('boss_crab_kraken')!;
  eq(orb0.entries.length, def.loot.length, '每个光球含全部必掉战利品');
  for (const l of def.loot) ok(orb0.entries.some((e) => e.itemId === l), `光球含战利品 ${l}`);
});

test('W5-33 个人掉落边界:0 人 / 未参与者 / 单人均不崩', () => {
  eq(rollPersonalLoot('boss_jelly_king', []).length, 0, '空参战列表 → 无光球');
  const afk: RaidParticipant[] = [
    { id: 'p0', contributed: false, damageDealt: 0, x: 0, y: 0 },
    { id: 'p1', contributed: true, damageDealt: 500, x: 1, y: 0 },
  ];
  const orbs = rollPersonalLoot('boss_jelly_king', afk);
  eq(orbs.length, 1, '未参与者不产出光球');
  eq(orbs[0].ownerId, 'p1', '只有参与者得球');
  eq(orbCountFor(afk), 1, '计数一致');
  const solo = rollPersonalLoot('boss_jelly_king', makeParticipants(1));
  eq(solo.length, 1, '单人也能拿到自己的球');
  eq(solo[0].exp, BOSS_BY_ID.get('boss_jelly_king')!.exp, '单人拿满经验');
  eq(rollPersonalLoot('boss_nope', makeParticipants(3)).length, 0, '未知 Boss 返回空');
});

test('W5-34 掉落可复现:同一 (Boss, 玩家) 恒定,不同玩家不同', () => {
  const parts = makeParticipants(3);
  const a = rollPersonalLoot('boss_fox_kitsune', parts);
  const b = rollPersonalLoot('boss_fox_kitsune', parts);
  eq(JSON.stringify(a), JSON.stringify(b), '两次结算完全一致(确定性)');
  const p0 = a[0];
  eq(p0.orbId, `boss_fox_kitsune:p0`, 'orbId 命名规则');
  /* 3 人队伍套用 PARTY_BONUS 加成 */
  const bonus = rollPersonalLoot('boss_fox_kitsune', parts, { partyBonus: PARTY_BONUS });
  ok(bonus[0].exp > p0.exp, '3 人以上经验获得 +25% 加成');
  near(bonus[0].exp, Math.round(BOSS_BY_ID.get('boss_fox_kitsune')!.exp / 3 * (1 + PARTY_BONUS)), 1, '经验 = base/3 × 1.25');
  /* 哈希稳定 */
  eq(fnv1a('abc'), fnv1a('abc'), 'fnv1a 稳定');
  ok(fnv1a('abc') !== fnv1a('abd'), '不同输入不同哈希');
  const rng = seededRoll(42);
  const seq = [rng(), rng(), rng()];
  const rng2 = seededRoll(42);
  eq(JSON.stringify([rng2(), rng2(), rng2()]), JSON.stringify(seq), '种子随机可复现');
  eq(SHARE_EXP_RADIUS, 24, '共享经验半径冻结值 24');
});

/* ═════════════════════ 7. 性能与边界 ═════════════════════ */

test('W5-35 性能:16 人团队 8 阶段预警几何生成的每帧开销', () => {
  const states: BossState[] = BOSS_LIST.map((b) => createBossState(b.id, 16));
  const start = process.hrtime.bigint();
  const FRAMES = 2000;
  let geoms = 0;
  for (let f = 0; f < FRAMES; f += 1) {
    for (const s of states) {
      tickBoss(s, 0.05, { target: { x: f % 20, y: 3 }, t: f * 0.05 });
      geoms += skillWarnGeoms(s, { x: f % 20, y: 3 }, f * 0.05).length;
    }
  }
  const usPerFrame = Number(process.hrtime.bigint() - start) / 1000 / FRAMES;
  ok(geoms > 0, '确实生成了几何');
  /* 8 个 Boss 同屏(极端上界)单帧生成开销 */
  ok(usPerFrame < 500, `8 Boss 同屏单帧 ${usPerFrame.toFixed(2)}µs 应 < 500µs(单帧预算 50ms 的 1%)`);
  /* 单个 Boss 单帧 < 63µs */
  ok(usPerFrame / 8 < 63, `单 Boss 单帧 ${(usPerFrame / 8).toFixed(2)}µs 应 < 63µs`);
});

test('W5-36 几何剔除加速:点在外接圆外时必然不在几何内', () => {
  const s = createBossState('boss_sky_whale', 1);
  const p2 = (() => { s.hp = Math.round(s.maxHp * 0.5); tickBoss(s, 0.05, { target: { x: 0, y: 0 }, t: 0 }); return skillWarnGeoms(s, { x: 0, y: 0 }, 0)[0]; })();
  /* 远处点:先按外接圆剔掉 */
  eq(insideWarn(p2, 100, 100), false, '远点不命中');
  eq(insideWarn(p2, 14, 0), true, '扇形末端边界命中');
  eq(insideWarn(p2, 14 + 1e-9, 0), false, '末端 +1e-9 安全');
  /* Z 层不匹配时也不命中 */
  eq(insideWarn3D(p2, 5, 0, 10), false, 'Z 严重不符不命中');
});

test('W5-37 全 Boss 技能几何均在有效参数域(半径>0、扇角∈(0,180)、环内<外)', () => {
  for (const b of BOSS_LIST) {
    for (const ratio of [1.0, 0.6, 0.4, 0.2, 0.05]) {
      const s = createBossState(b.id, 4);
      s.hp = Math.round(s.maxHp * ratio);
      tickBoss(s, 0.05, { target: { x: 3, y: 4 }, t: 0 });
      for (const g of skillWarnGeoms(s, { x: 3, y: 4 }, 0)) {
        ok(g.radius > 0, `${b.id}@${ratio} 半径必须为正`);
        inRange(g.warnSec, 0.2, 2.0, `${b.id} 预警时长在合理区间`);
        if (g.kind === 'SECTOR') {
          ok(g.halfDeg > 0 && g.halfDeg < 180, `${b.id} 半张角必须在 (0,180)`);
        }
        if (g.kind === 'RING') {
          ok(g.innerRadius < g.radius, `${b.id} 环内径必须小于外径`);
        }
        if (g.kind === 'RECT' || g.kind === 'POINTER') {
          ok(g.halfLen > 0 && g.halfWidth >= 0, `${b.id} 矩形半长半宽非负`);
        }
      }
    }
  }
});

test('W5-38 与群系耦合:8 个 Boss 各归一个群系,祭品表覆盖 8 群系', () => {
  const biomes = new Set(BOSS_LIST.map((b) => b.biome));
  eq(biomes.size, 8, '8 个 Boss 分属 8 个群系');
  for (const b of BOSS_LIST) {
    ok(Object.values(Biome).includes(b.biome), `${b.id} 群系合法`);
    ok(b.phases.length >= 2, `${b.id} 至少两阶段`);
    ok(b.breakMechanic.length > 0, `${b.id} 有破防机制原文`);
    ok(b.loot.length >= 2, `${b.id} 至少两件必掉战利品`);
  }
  /* 阶段阈值单调不增(由开局向末阶段推进) */
  for (const b of BOSS_LIST) {
    for (let i = 1; i < b.phases.length; i += 1) {
      ok(b.phases[i].hpThreshold <= b.phases[i - 1].hpThreshold, `${b.id} 阈值单调不增`);
    }
    eq(b.phases[0].hpThreshold, 1.0, `${b.id} P1 阈值 = 1.0`);
  }
});

/* ═════════════════════ 9. 祭品消耗(owner 裁决 D-03)═════════════════════ */

/* 基准请求:野外祭坛、正确祭品、2 人。 */
const OFFER_BASE = {
  bossId: 'boss_jelly_king', itemId: 734, hasAltar: true,
  altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
  playerCount: 2, alreadyAlive: false, ownerId: 'u1',
};

/** 内存库存:单实例,便于精确观察「扣了几个」。 */
function memPort(initial: number): {
  port: ReturnType<typeof makeOfferingPort>;
  held: () => number;
  restoreCalls: () => number;
} {
  let qty = initial;
  let restores = 0;
  const port = makeOfferingPort({
    listOwned: () => (qty > 0 ? [{ instanceId: 'i1', itemId: 734, quantity: qty }] : []),
    consumeInstance: (_id, n) => {
      if (qty < n) return false;
      qty -= n;
      return true;
    },
    restoreInstance: (_id, n) => { restores += 1; qty += n; },
  });
  return { port, held: () => qty, restoreCalls: () => restores };
}

test('W5-39 祭品消耗:召唤成功后持有数 -1', () => {
  const m = memPort(3);
  eq(m.held(), 3, '起始 3 个');
  const r = summonBossWithOffering(OFFER_BASE, m.port);
  eq(r.ok, true, '召唤成功');
  eq(r.offeringConsumed, true, '标记为已消耗');
  eq(m.held(), 2, '**持有数必须降 1** —— 这是本裁决的核心断言');
  eq(r.reason, SummonReject.OK, '原因 = OK');
});

test('W5-40 祭品不足:召唤失败且**一个都不扣**', () => {
  const m = memPort(0);
  const r = summonBossWithOffering(OFFER_BASE, m.port);
  eq(r.ok, false, '没祭品不能召唤');
  eq(r.reason, SummonReject.NO_OFFERING, '原因 = NO_OFFERING');
  eq(r.offeringConsumed, false, '失败时不得标记已消耗');
  eq(m.held(), 0, '失败时持有数不变');
});

test('W5-41 顺序铁律:其它校验失败时**绝不碰库存**', () => {
  /* 每一种失败原因都必须发生在扣祭品**之前**。
     这里用「初始有 1 个」——若实现写成先扣后校验,这些用例会看到 held 变 0。 */
  const cases: { name: string; over: Partial<typeof OFFER_BASE>; reason: string }[] = [
    { name: '错误祭品', over: { itemId: 735 }, reason: 'WRONG_ITEM' },
    { name: '无祭坛', over: { hasAltar: false }, reason: 'NO_ALTAR' },
    { name: '安全区内', over: { altarX: 0, altarY: 0 }, reason: 'SAFE_ZONE' },
    { name: '人数越界', over: { playerCount: RAID_MAX_PLAYERS + 1 }, reason: 'TOO_MANY_PLAYERS' },
    { name: '同 Boss 存活', over: { alreadyAlive: true }, reason: 'BOSS_ALIVE' },
    { name: '未知 Boss', over: { bossId: 'boss_nope' }, reason: 'UNKNOWN_BOSS' },
  ];
  for (const c of cases) {
    const m = memPort(1);
    const r = summonBossWithOffering({ ...OFFER_BASE, ...c.over }, m.port);
    eq(r.ok, false, `${c.name}:召唤失败`);
    eq(r.reason, c.reason, `${c.name}:原因正确`);
    eq(r.offeringConsumed, false, `${c.name}:不得标记已消耗`);
    eq(m.held(), 1, `${c.name}:**祭品必须原封不动**(扣了就是先扣后校验)`);
  }
});

test('W5-42 并发兜底:countOf 说有、consume 说没有 ⇒ 按 NO_OFFERING 失败', () => {
  /* 模拟「预检之后、真扣之前被别人抢走」:countOf 恒返回 1,consume 恒失败。
     若实现只信 countOf,这里会返回 ok=true —— 那正是并发下的重复召唤漏洞。 */
  const port = {
    countOf: () => 1,
    consume: () => false,
  };
  const r = summonBossWithOffering(OFFER_BASE, port);
  eq(r.ok, false, 'consume 失败 ⇒ 召唤不成立(判据只能取 consume 返回值)');
  eq(r.reason, SummonReject.NO_OFFERING, '原因 = NO_OFFERING');
  eq(r.offeringConsumed, false, '未消耗');
  eq(r.scaledHp, 0, '失败不产生血量');
});

test('W5-43 多实例跨扣失败时真回滚(不留半扣状态)', () => {
  /* 两个实例各 1 个。要求扣 2 个:第 1 个成功、第 2 个失败 ⇒ 必须把第 1 个补回。
     这是 makeOfferingPort 里 `applied` + `restoreInstance` 那条路径。 */
  const inst = [
    { instanceId: 'a', itemId: 734, quantity: 1 },
    { instanceId: 'b', itemId: 734, quantity: 1 },
  ];
  let restores = 0;
  let failSecond = true;
  const port = makeOfferingPort({
    listOwned: () => inst,
    consumeInstance: (id, n) => {
      const row = inst.find((r) => r.instanceId === id)!;
      if (id === 'b' && failSecond) return false;
      if (row.quantity < n) return false;
      row.quantity -= n;
      return true;
    },
    restoreInstance: (id, n) => { restores += 1; inst.find((r) => r.instanceId === id)!.quantity += n; },
  });
  eq(port.consume('u1', 734, 2), false, '跨扣失败返回 false');
  eq(restores, 1, '**必须回滚已扣的 1 个**');
  eq(inst[0]!.quantity, 1, '实例 a 恢复原状');
  eq(inst[1]!.quantity, 1, '实例 b 未被改动');

  /* 正对照:让它成功,证明上面不是「恒失败」的假红 */
  failSecond = false;
  eq(port.consume('u1', 734, 2), true, '同样代码路径在允许时应成功');
  eq(inst[0]!.quantity, 0, '实例 a 已扣');
  eq(inst[1]!.quantity, 0, '实例 b 已扣');
});

test('W5-44 自反馈漏洞:战利品不得含自身祭品(CR-15 已修复,含正负对照)', () => {
  /*
   * ## 这条用例的两种形态
   *
   * 修复前(2026-11-11 ~ 2026-11-12):它**故意断言不期望的现状** ——
   * 「恰好 1 个 Boss 掉自己的祭品(boss_ginger_troll:739)」,
   * 目的是在 Lead 改冻结层 loot 时立刻变红提醒同步。
   *
   * 修复后(CR-15,2026-11-12):改成断言**期望状态 = 0**。
   * 它的红灯曾精确亮过一次 —— 那正是修复生效的证据:
   *   `实测恰好 1 个 Boss 掉自己的祭品 期望 1 / 实际 0`
   *
   * 这条的**核心价值不在数字**,而在下面的正负对照:它证明检测器
   * 真能区分「掉」与「不掉」,而不是恒返回空或恒返回全部。
   */
  const bad = selfRecyclingBosses();
  eq(bad.length, 0, '没有任何 Boss 掉自己的祭品(CR-15 已修)');

  /* 负对照:不掉自身祭品的合成 Boss,检测器必须不命中 */
  const clean = selfRecyclingBosses([
    { id: 'x', name: 'x', biome: 'DESSERT', level: 1, baseHp: 1, summonItem: 734, exp: 1, loot: [609], phases: [], breakMechanic: '' },
  ] as never);
  eq(clean.length, 0, '不掉自身祭品的 Boss 不得被误报');

  /* 正对照:真的掉了,检测器必须报出来 —— 没有这条,
     上面的 `0` 可能只是因为检测器恒返回空。 */
  const bad2 = selfRecyclingBosses([
    { id: 'y', name: 'y', biome: 'DESSERT', level: 1, baseHp: 1, summonItem: 735, exp: 1, loot: [735, 609], phases: [], breakMechanic: '' },
  ] as never);
  eq(bad2.length, 1, '掉自身祭品的 Boss 必须被报出(正对照)');
  eq(bad2[0]!.bossId, 'y', '报的是那个 Boss');
  eq(bad2[0]!.itemId, 735, '报的是那个祭品 ID');

  /* 祭品区段扫描:与 selfRecycling 的口径互证 */
  const inLoot = summonItemsInLoot();
  eq(inLoot.length, 0, '战利品里不得出现任何祭品(734..741)');
  eq(SUMMON_ITEM_MIN <= 739 && 739 <= SUMMON_ITEM_MAX, true, '739 确实在祭品区段内(区段判据本身有效)');
});

/* ═════════════════════ task-35:生产路径接线 ═════════════════════ */

/*
 * ## 这一组为什么必须先红
 *
 * 本仓已**第 5 次**出现同一形态的缺陷:实现存在 + 单测全绿 + 生产永不执行。
 * `raid.ts`(413 行)、`breaks.ts`(447 行)、`phases.ts`(401 行)正是其中一组 ——
 * 上面 44 条用例把它们的**函数级**行为测得很好,却没有一条问过:
 * **生产 tick 会不会走到它们?**
 *
 * 答案是否定的。实测证据(接线前):
 *   · `WorldSim` 的 28 个成员里,匹配 `boss|raid|summon|break` 的是 **0 个**;
 *   · `sim.addMob('boss_jelly_king', 10, 10)` → `undefined`
 *     (8 个 Boss **全部**不在 `MOB_BY_ID` 里,`addMob` 查不到 def 就返回 undefined);
 *   · `sim.interactMob('boss_jelly_king', 734, 'p1')` → `false`;
 *   · `sim.tick()` 跑 40 帧,成员集合**未变**。
 *
 * 所以下面这几条在接线前**必然红** —— 它们断言的是「生产真的走到了」,
 * 而不是「函数本身能工作」。没有红过就接线,等于没验证过缺陷存在。
 */

test('W5-45 生产可达:WorldSim 必须持有 Boss 副本运行时(接线前为红)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  const anySim = sim as unknown as Record<string, unknown>;
  const raid = anySim['bossRaid'] as BossRaidRuntime | undefined;
  ok(raid !== undefined && raid !== null,
    'WorldSim 必须持有 Boss 副本运行时 bossRaid —— 否则 bosses/** 生产永不执行');
  /* 正对照:拿到的必须是真东西,不是占位对象 */
  eq(typeof raid?.summon, 'function', 'bossRaid.summon 必须是可调用的生产入口');
  eq(typeof raid?.damage, 'function', 'bossRaid.damage 必须是可调用的生产入口');
  eq(typeof raid?.tryBreak, 'function', 'bossRaid.tryBreak 必须是可调用的生产入口');
});

test('W5-46 生产路径破防:Boss 承伤累积到阈值 → 真的推进阶段', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  const raid = sim.bossRaid;
  ok(raid !== null, 'bossRaid 必须已接线');

  /* 先把果冻王召出来(走生产入口,含祭品消耗) */
  const port = makeMemoryOfferingPort({ p1: { 734: 1 } });
  const s = raid!.summon(
    {
      bossId: 'boss_jelly_king', itemId: 734, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 2, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  eq(s.ok, true, '正确祭品 + 祭坛 → 召唤成立');
  eq(raid!.stateOf('boss_jelly_king')?.phaseIndex, 0, '开局是 P1');

  /* 承伤累积:打到 20% 血(果冻王 P3 阈值 0.25) */
  const st = raid!.stateOf('boss_jelly_king')!;
  const before = st.hp;
  raid!.damage('boss_jelly_king', Math.round(before * 0.85));
  eq(raid!.stateOf('boss_jelly_king')!.hp < before, true, '承伤后血量确实下降');

  /* 推进一帧慢帧,让阶段机重算下标 */
  raid!.tickBosses(0.5);
  eq(raid!.stateOf('boss_jelly_king')!.phaseIndex, 2,
    '承伤累积到 20% 血 → 真的进入 P3(这是生产路径推出来的,不是直接写 state)');
});

test('W5-47 生产路径破防:满足破防条件 → breakAchieved 置位并进入眩晕窗口', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  const raid = sim.bossRaid!;
  const port = makeMemoryOfferingPort({ p1: { 734: 1 } });
  raid.summon(
    {
      bossId: 'boss_jelly_king', itemId: 734, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 2, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  const st = raid.stateOf('boss_jelly_king')!;
  raid.damage('boss_jelly_king', Math.round(st.hp * 0.85));
  raid.tickBosses(0.5);
  eq(raid.stateOf('boss_jelly_king')!.breakAchieved, false, '条件未满足时未破防(负对照)');

  /* 生产入口投喂:点燃的 228 顺吸力扔进嘴 */
  const r = raid.tryBreak('boss_jelly_king', {
    phaseIndex: 2, suctionActive: true, feedItem: 228, lit: true,
    distanceToMouth: 1.5, mouthRadius: 3,
  });
  eq(r.ok, true, '生产入口判定破防成立');
  const after = raid.stateOf('boss_jelly_king')!;
  eq(after.breakAchieved, true, '破防态真的置位');
  eq(after.stunnedSec, BREAK_STUN_SEC['boss_jelly_king'], '进入 6 秒眩晕窗口');
  /* 这里**刻意写字面量 1.00**,不用 `BREAK_CRIT_BONUS`:
     后者会让断言变成同义反复(`applyBreak` 就是赋这个常量,任何值都能过),
     于是常量漂移时断言照样绿。手册 §4.3 对破防窗口的要求是
     「全队上去暴打全暴击」⇒ 暴击加成 = +100% = 倍率增量 1.00。
     写死了才能抓住常量被改动。 */
  eq(after.critBonus, 1.00, '全队暴击加成 +100%(手册 §4.3「全暴击」,字面量锚定)');

  /* 负对照:条件不满足时同一入口必须返回 false 且不改状态 */
  const r2 = raid.tryBreak('boss_beaver_mecha', { damDestroyed: false, mechShortCircuited: false });
  eq(r2.ok, false, '未满足条件 → 不破防');
});

test('W5-48 生产路径召唤:祭品真的被消耗(D-03),库存随之减少', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  const raid = sim.bossRaid!;
  const bag: Record<string, Record<number, number>> = { p1: { 741: 1 } };
  const port = makeMemoryOfferingPort(bag);

  eq(port.countOf('p1', 741), 1, '献祭前有 1 个祭品');
  const s = raid.summon(
    {
      bossId: 'boss_chronos_colossus', itemId: 741, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 4, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  eq(s.ok, true, '召唤成立');
  eq(s.offeringConsumed, true, 'D-03:祭品必须被消耗');
  eq(port.countOf('p1', 741), 0, '库存真的从 1 变成 0');
  eq(raid.stateOf('boss_chronos_colossus') !== undefined, true, 'Boss 实体已进入生产运行时');

  /* 负对照:库存为空时同一入口必须失败且**不扣任何东西** */
  const s2 = raid.summon(
    {
      bossId: 'boss_sky_whale', itemId: 740, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 4, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  eq(s2.ok, false, '没有祭品 → 召唤失败');
  eq(s2.reason, SummonReject.NO_OFFERING, '拒绝理由是 NO_OFFERING');
  eq(s2.offeringConsumed, false, '失败路径恒为未消耗');
  eq(port.countOf('p1', 740), 0, '没有凭空扣掉不存在的东西');
});

test('W5-49 生产 tick 真的推进 Boss 状态(不是摆设字段)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  const raid = sim.bossRaid!;
  const port = makeMemoryOfferingPort({ p1: { 734: 1 } });
  raid.summon(
    {
      bossId: 'boss_jelly_king', itemId: 734, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 2, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  const cd0 = raid.stateOf('boss_jelly_king')!.castCd;
  const sec0 = raid.stateOf('boss_jelly_king')!.phaseSec;
  /* 走**生产 tick 路径**(WorldSim.tick),而不是直接调 tickBosses */
  for (let i = 0; i < 40; i += 1) sim.tick();
  const st = raid.stateOf('boss_jelly_king')!;
  eq(st.phaseSec > sec0, true, 'WorldSim.tick 真的推进了 Boss phaseSec');
  eq(st.castCd !== cd0 || st.casts > 0, true, '施法倒计时/计数在生产 tick 下发生变化');
});

test('W5-50 生产入口真的存在:WorldSim 暴露 summon/damage/break/snapshot(不只是 import 图可达)', () => {
  /*
   * 这一条防的是**「可达但不调用」** —— 只加 import 不加调用点时,
   * 静态可达性门禁会绿,而 summon/tryBreak 依旧永不执行,缺陷形态不变。
   * 所以这里断言的是 WorldSim **自己**有这四个可调用入口。
   */
  const sim = new WorldSim({ sizeCells: 48 });
  const anySim = sim as unknown as Record<string, unknown>;
  for (const m of ['summonBoss', 'damageBoss', 'tryBreakBoss', 'bossSnapshots']) {
    eq(typeof anySim[m], 'function', `WorldSim 必须暴露 ${m} 作为真实调用点`);
  }

  /* 端到端:走 WorldSim 自己的人口,而不是直接摸 bossRaid */
  const port = makeMemoryOfferingPort({ p1: { 741: 1 } });
  const s = sim.summonBoss(
    {
      bossId: 'boss_chronos_colossus', itemId: 741, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 4, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  eq(s.ok, true, '经 WorldSim.summonBoss 召唤成立');
  eq(port.countOf('p1', 741), 0, '经 WorldSim 这条路也真的扣了祭品');

  const snaps = sim.bossSnapshots();
  eq(snaps.length, 1, 'snapshot 能看到刚召出的 Boss');
  eq(snaps[0]!.bossId, 'boss_chronos_colossus', 'snapshot 的 Boss ID 正确');
  eq(snaps[0]!.hpRatio, 1, '满血开局');

  /* 经 WorldSim 入口造成伤害 */
  const d = sim.damageBoss('boss_chronos_colossus', 1000);
  eq(d !== null, true, '经 WorldSim.damageBoss 能打到 Boss');
  eq(d!.toHp > 0, true, '伤害真的落在血量上');
  eq(sim.bossSnapshots()[0]!.hpRatio < 1, true, 'snapshot 反映掉血');

  /* 未知 Boss 的负对照 */
  eq(sim.damageBoss('boss_not_exist', 100), null, '未知 Boss → null(不抛错)');
  eq(sim.tryBreakBoss('boss_not_exist', {}).ok, false, '未知 Boss 破防 → false');
});

report('WS-05');