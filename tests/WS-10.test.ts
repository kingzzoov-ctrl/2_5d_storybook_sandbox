/**
 * WS-10 验收测试:战斗伤害管线 / 等级天赋成长 / 幽灵泡泡救援 / 料理恶作剧锅
 *
 * 运行:node tests/WS-10.test.ts
 * 全部随机均经 mulberry32(seed) 注入,结果可复现。
 */

import { test, ok, eq, near, includes, inRange, mulberry32, report } from '../shared/testing/harness.ts';

import {
  WEAPONS, WEAPON_BY_ID, BREACH_PICK, PRANK_HAMMER_KNOCKBACK, ARMORS, ARMOR_BY_ID,
  COMBAT_CONSUMABLES, COMBAT_ITEM_INDEX, COMBAT_ITEM_RANGE, Element, ELEMENT_COUNTER,
  elementMul, equipSummary, combatantStats, levelDamageMul, skillOf,
  MAX_DODGE_RATE, BASE_CRIT_DMG, SET_BONUSES, activeSets, SkillShape,
} from '../server/src/combat/weapons.ts';

import {
  ARMOR_K, MIN_DAMAGE, REFLECT_RADIUS, computeDamage, createTarget, applyDamage,
  allyPrankHit, reflectFrom, makeDot, tickDot, planSkillHits, healTarget, floatText,
  shieldPercent, DamageSource, targetFromStats,
} from '../server/src/combat/damage.ts';

import {
  TALENTS, TALENT_BY_ID, TALENT_UNLOCK_LEVELS, activeTalents, talentsUnlockedAt,
  isTalentUnlocked, cumulativeExp, expToReachMax, createProgress, gainExp, setLevel,
  settleMobExp, applyShareResult, KillLedger, levelGapMul, reforge,
  SHARE_RADIUS, PER_MOB_EXP_CAP_MULT, REBIRTH_DEW_COST, REBIRTH_AFFIX_POOL,
} from '../server/src/combat/progression.ts';

import {
  createDowned, tickGhostBubble, ghostDamageMul, ghostControl, touchRevive, TOUCH_RADIUS,
  bubbleGunHit, featherRevive, flagRevive, tickInvuln, isInvulnerable, snapshotDiff,
  FLAG_REVIVE_TIME, FLAG_REVIVE_RADIUS, BUBBLE_GUN_SHOTS, BUBBLE_TRAP_SEC,
  ReviveMethod, GHOST_MOVE_MUL, type EquipmentSnapshot,
} from '../server/src/combat/revive.ts';

import {
  FOODS, FOOD_BY_ID, cookSoup, tickFoodBuff, cleansePrankBuffs, mergeFoodBuffs,
  extinguishFire, PRANK_PRIORITY, CookBranch, SHOVEL_BONUS_KEYWORDS, SOUP_POT_ID,
} from '../server/src/combat/cooking.ts';

import { BodyState } from '../shared/types/physics.ts';
import {
  MAX_LEVEL, TALENT_LEVELS, SHARE_EXP_RADIUS, PARTY_BONUS_THRESHOLD, PARTY_BONUS,
  AFK_EXP_RATIO, REVIVE_TIME, REVIVE_HP_RATIO, FEATHER_RANGE, FEATHER_INVULN,
  expToNext, statsAtLevel, ItemCategory,
} from '../shared/types/entities.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { BOSS_LIST } from '../shared/constants/bosses.ts';

const rng = mulberry32(0x5eed10);

/* ═══════════════════════ 一、装备配表完整性 ═══════════════════════ */

test('701-745 全部 45 项均被战斗子系统索引,无缺号', () => {
  eq(COMBAT_ITEM_RANGE.length, 45, '701~745 应为 45 项');
  eq(COMBAT_ITEM_INDEX.size, 45, '战斗索引条目数');
  const missing: number[] = [];
  for (let id = 701; id <= 745; id += 1) if (!COMBAT_ITEM_INDEX.has(id)) missing.push(id);
  eq(missing.length, 0, `缺失 ID:${missing.join(',')}`);
});

test('13 件武器 711-723 数值与 [Q] 技能全部数据化', () => {
  eq(WEAPONS.length, 13, '武器数量');
  for (let id = 711; id <= 723; id += 1) {
    const w = WEAPON_BY_ID.get(id);
    ok(w !== undefined, `缺少武器 ${id}`);
    eq(w!.name, ITEM_BY_ID.get(id)!.name, `武器 ${id} 名称应取冻结层`);
    ok(w!.atk > 0, `武器 ${id} 攻击力应为正`);
    ok(w!.attackMul > 0, `武器 ${id} 武器倍率`);
    ok(w!.skill.key.startsWith('q_'), `武器 ${id} [Q] 技能键`);
    ok(w!.skill.cooldown > 0, `武器 ${id} 冷却`);
    ok(w!.skill.name.length > 0, `武器 ${id} 技能名`);
    ok(w!.passive.length > 0, `武器 ${id} 被动`);
  }
  eq(WEAPON_BY_ID.get(713)!.name, '黑曜石烈焰巨剑');
  eq(WEAPON_BY_ID.get(719)!.knockbackMul, 3.0, '719 击退 +200%');
  eq(WEAPON_BY_ID.get(723)!.atk, 65, '723 面板 ATK');
});

test('204 爆破镐与 222 大锤的破盾/击退常数符合手册', () => {
  eq(BREACH_PICK.shieldBreakMul, 4.0, '204 破盾倍率');
  ok(BREACH_PICK.shieldBreakMul >= 3.0, '204 应达到无视晶甲阈值');
  eq(BREACH_PICK.skill.shieldBreakMul, 4.0, '204 [Q] 破盾倍率');
  eq(PRANK_HAMMER_KNOCKBACK, 8.0, '222 对队友固定 8 格/秒击退');
  eq(BREACH_PICK.name, ITEM_BY_ID.get(204)!.name);
});

test('728 反伤甲 / 733 羽毛笔 / 732 药水的数值来自冻结配表', () => {
  eq(ARMORS.length, 9, '护甲/饰品条目数(724~731 + 630)');
  const a728 = ARMOR_BY_ID.get(728)!;
  eq(a728.dmgReduce, 0.30, '728 减伤 30%');
  eq(a728.reflectMul, 1.50, '728 反伤 150%');
  eq(a728.hpBonus, 160);
  eq(ARMOR_BY_ID.get(729)!.moveMul, 1.10, '729 移速 +10%');
  eq(ARMOR_BY_ID.get(726)!.cdMul, 0.75, '726 冷却 -25%');

  const c733 = COMBAT_CONSUMABLES.find((c) => c.id === 733)!;
  eq(c733.reviveRange, FEATHER_RANGE, '733 复活距离 = FEATHER_RANGE 6 格');
  eq(c733.invulnSec, FEATHER_INVULN, '733 无敌 = FEATHER_INVULN 3 秒');
  eq(c733.reviveFullHp, true, '733 满血复活');
  const c732 = COMBAT_CONSUMABLES.find((c) => c.id === 732)!;
  eq(c732.healHp, 100, '732 瞬回 100 HP');
  eq(c732.cooldownSec, 8, '732 冷却 8 秒');
});

/* ═══════════════════════ 二、伤害管线八步公式链 ═══════════════════════ */

test('管线1:基础 = ATK × 等级倍率 × 武器倍率', () => {
  const bare = combatantStats(1, []);
  eq(bare.totalAtk, 10, 'Lv.1 裸装总攻 = BASE_ATK 10');
  eq(levelDamageMul(1), 1.0, 'Lv.1 等级倍率 1.00');
  near(levelDamageMul(30), 1.87, 1e-9, 'Lv.30 等级倍率 1.87');

  const target = createTarget({ id: 'dummy', name: '木桩', hp: 99999, maxHp: 99999 });
  const d = computeDamage({ attacker: bare, target, critRoll: 0.99, dodgeRoll: 0.99 });
  near(d.base, 10 * 1.0 * 1.0, 1e-9, '裸装裸手基础伤害');
  eq(d.finalDamage, 10, '无防御时最终伤害等于基础');

  const w = WEAPON_BY_ID.get(711)!;
  const a = combatantStats(1, [711]);
  const d2 = computeDamage({ attacker: a, target, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  near(d2.base, (10 + 12) * 1.0 * 1.0, 1e-9, '711 基础 = (10+12) × 1.0 × 1.0');
  eq(d2.steps[0].step, '1 基础伤害', '第一步应为「基础伤害」');
});

test('管线2:元素克制矩阵四元环与同抗', () => {
  eq(elementMul(Element.FIRE, Element.ICE), 1.5, '烈焰 → 霜冻 1.5');
  eq(elementMul(Element.ICE, Element.LIGHTNING), 1.5, '霜冻 → 雷暴 1.5');
  eq(elementMul(Element.LIGHTNING, Element.SLIME), 1.5, '雷暴 → 胶质 1.5');
  eq(elementMul(Element.SLIME, Element.FIRE), 1.5, '胶质 → 烈焰 1.5 闭环');
  eq(elementMul(Element.FIRE, Element.FIRE), 0.5, '同属性互抗 0.5');
  eq(elementMul(Element.LIGHT, Element.SLIME), 1.5, '星光克制胶质(果冻类)');
  eq(elementMul(Element.NONE, Element.FIRE), 1.0, '无属性不吃克制');
  for (const atk of Object.keys(ELEMENT_COUNTER) as Element[]) {
    for (const def of Object.keys(ELEMENT_COUNTER) as Element[]) {
      inRange(ELEMENT_COUNTER[atk][def], 0.5, 1.5, `克制矩阵 ${atk}→${def} 应在 [0.5,1.5]`);
    }
  }

  const a = combatantStats(8, [713]);
  const w = WEAPON_BY_ID.get(713)!;
  const lava = createTarget({ id: 'lava', name: '火灵', hp: 99999, maxHp: 99999, element: Element.FIRE });
  const d = computeDamage({ attacker: a, target: lava, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(d.elementMulValue, 0.5, '713 烈焰打火灵被 0.5 抗');
  near(d.afterElement, d.base * 0.5, 1e-6, '2 元素后伤害 = 基础 × 0.5');
});

test('管线3:破甲为固定穿透后乘百分比,有效防御不为负', () => {
  const a = combatantStats(1, [713]);
  const w = WEAPON_BY_ID.get(713)!;
  const target = createTarget({ id: 'm', name: '重甲虫', hp: 99999, maxHp: 99999, def: 80 });
  const d = computeDamage({ attacker: a, target, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(d.flatPen, 12, '713 固定穿透 12');
  eq(d.effectiveDef, (80 - 12) * 1, '有效防御 = (80 − 12) × 1 = 68');

  const thin = createTarget({ id: 'thin', name: '纸皮', hp: 99999, maxHp: 99999, def: 3 });
  const d2 = computeDamage({ attacker: a, target: thin, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(d2.effectiveDef, 0, '穿透超过防御时有效防御钳制为 0');

  const a718 = combatantStats(1, [718]);
  const w718 = WEAPON_BY_ID.get(718)!;
  const d3 = computeDamage({ attacker: a718, target, weapon: w718, skill: w718.skill, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(d3.pctPen, 0.25, '718 [Q] 百分比穿透 25%');
  near(d3.effectiveDef, (80 - 10) * 0.75, 1e-9, '718 有效防御 = (80−10) × (1−0.25) = 52.5');
});

test('破甲语义钉死:同源不叠加取 max,异源同样取 max 不求和', () => {
  /* 语义定义:「同源不叠加,异源取最大」。
     718 手持的破甲与它自己 [Q] 陨石星落的破甲同属该武器自身,是同源;
     204 爆破镐与 718 的 [Q] 则分属两件不同武器,是异源。两者一律取 max。 */
  const target = createTarget({ id: 'armored', name: '重甲虫', hp: 99999, maxHp: 99999, def: 80 });
  const w718 = WEAPON_BY_ID.get(718)!;
  /* 若按「相加」的错误语义,有效 DEF 会跌到次优区间,用此基线做反证 */
  const naiveSum = (flat: number, pct: number): number => Math.max(0, 80 - flat) * (1 - pct);

  /* ── 同源:718 手持 + 718 [Q] ── */
  eq(w718.armorPen, 10, '718 手持固定破甲 10');
  eq(w718.armorPenPct, 0.15, '718 手持百分比破甲 15%');
  eq(w718.skill.armorPen, 10, '718 [Q] 固定破甲 10');
  eq(w718.skill.armorPenPct, 0.25, '718 [Q] 百分比破甲 25%');

  const same = computeDamage({
    attacker: combatantStats(1, [718]), target, weapon: w718, skill: w718.skill,
    critRoll: 0.99, dodgeRoll: 0.99,
  });
  eq(same.flatPen, 10, '同源取 max → 固定破甲 10(相加会得 10+10+10=30)');
  eq(same.pctPen, 0.25, '同源取 max → 百分比破甲 25%(相加会得 15%+25%+15%=55%)');
  eq(same.effectiveDef, 52.5, '718 手持 + [Q] 同时生效 → 有效 DEF = (80−10) × 0.75 = 52.5');
  ok(same.effectiveDef > naiveSum(30, 0.55), `同源若相加只剩 ${naiveSum(30, 0.55)},现取值 ${same.effectiveDef} 更高`);
  ok(same.effectiveDef / naiveSum(30, 0.55) > 2, '取 max 与相加的差距超过一倍,语义不可能被误改而测试仍绿');

  /* ── 异源:204 爆破镐(武器级破甲)× 718 [Q] ── */
  eq(BREACH_PICK.armorPen, 15, '204 固定破甲 15');
  eq(BREACH_PICK.armorPenPct, 0.10, '204 百分比破甲 10%');
  const cross = computeDamage({
    attacker: combatantStats(1, [204]), target, weapon: BREACH_PICK, skill: w718.skill,
    critRoll: 0.99, dodgeRoll: 0.99,
  });
  eq(cross.flatPen, 15, '异源取 max → 固定破甲 15(相加会得 15+10+15=40)');
  eq(cross.pctPen, 0.25, '异源取 max → 百分比破甲 25%(相加会得 10%+25%+10%=45%)');
  eq(cross.effectiveDef, 48.75, '204 × 718 [Q] → 有效 DEF = (80−15) × 0.75 = 48.75');
  ok(cross.effectiveDef > naiveSum(40, 0.45), `异源若相加只剩 ${naiveSum(40, 0.45)},现取值 ${cross.effectiveDef} 更高`);
  /* 204 固定破甲 15 > 718 的 10,故异源场景有效 DEF 更低(穿透更强 → 有效防御更低) */
  ok(cross.effectiveDef < same.effectiveDef, `204 破甲更强 → 有效 DEF ${cross.effectiveDef} 低于同源场景的 ${same.effectiveDef}`);
  eq(same.effectiveDef - cross.effectiveDef, 3.75, '(80−10)×0.75 − (80−15)×0.75 = 3.75,差值仅由 5 点固定破甲决定');

  /* 反向校验:有效 DEF 随目标防御单调递增,不存在被穿透成负数的放大路径 */
  const tanky = computeDamage({
    attacker: combatantStats(1, [204]), target: createTarget({ id: 'tank', name: '坦克', hp: 9e9, maxHp: 9e9, def: 200 }),
    weapon: BREACH_PICK, skill: w718.skill, critRoll: 0.99, dodgeRoll: 0.99,
  });
  eq(tanky.effectiveDef, (200 - 15) * 0.75, '高防目标:有效 DEF = (200−15) × 0.75 = 138.75');
  ok(tanky.effectiveDef > cross.effectiveDef, '目标防御越高,有效 DEF 越高(无反向放大)');
});

test('管线4:204 破晶甲盾、击破后溢出折算转入 HP', () => {
  const crystal = createTarget({
    id: 'beetle', name: '紫晶重甲虫', hp: 750, maxHp: 750, def: 20,
    shield: 100, shieldMax: 100, crystalArmor: true,
  });

  /* 普通武器:晶甲只吃 20%,破盾倍率 1.0 → 打不穿 */
  const a711 = combatantStats(1, [711]);
  const w711 = WEAPON_BY_ID.get(711)!;
  const hold = computeDamage({ attacker: a711, target: crystal, weapon: w711, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(hold.crystalMul, 0.20, '非破盾武器被晶甲削到 20%');
  eq(hold.shieldBroken, false, '护盾未破');
  eq(hold.finalDamage, 0, '护盾未破时 HP 完全免伤');

  /* 204 爆破镐:破盾倍率 4.0 ≥ 3.0 → 无视晶甲,一击破盾 */
  const a204 = combatantStats(1, [204]);
  const breach = computeDamage({ attacker: a204, target: crystal, weapon: BREACH_PICK, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(breach.crystalMul, 1.0, '204 无视晶甲削减');
  eq(breach.shieldBreakMul, 4.0, '204 破盾倍率 4.0');
  eq(breach.shieldBroken, true, '204 一击破盾');
  ok(breach.shieldDamage > 100, `204 破盾伤害 ${breach.shieldDamage} 应超过 100 点护盾池`);
  ok(breach.finalDamage > 0, '破盾后溢出伤害转入 HP');
  eq(breach.steps[3].step, '4 破盾', '第四步应为「破盾」');

  /* 228 痒痒炸弹果:120 点破甲爆破伤害 */
  const bomb = computeDamage({
    attacker: combatantStats(1, []),
    target: createTarget({ id: 'm2', name: '怪', hp: 99999, maxHp: 99999 }),
    externalMul: 12, critRoll: 0.99, dodgeRoll: 0.99,
  });
  eq(bomb.finalDamage, 120, '228 爆破等效 120 点伤害');
});

test('管线5:暴击率边界与爆伤上限 3.0', () => {
  const target = createTarget({ id: 'dummy', name: '木桩', hp: 99999, maxHp: 99999 });
  const a = combatantStats(1, [711]);
  const w = WEAPON_BY_ID.get(711)!;

  const noCrit = computeDamage({ attacker: a, target, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(noCrit.critRolled, false, 'roll=0.99 不暴击');
  eq(noCrit.critMul, 1.0, '未暴击倍率 1.0');

  /* 711 critBonus 0.02 + 基础 0.05 = 0.07 */
  eq(noCrit.critRate, 0.07, '711 暴击率 = 0.05 + 0.02');
  const edgeLow = computeDamage({ attacker: a, target, weapon: w, critRoll: 0.0699, dodgeRoll: 0.99 });
  eq(edgeLow.critRolled, true, 'roll < critRate 即暴击(边界下沿)');
  const edgeHigh = computeDamage({ attacker: a, target, weapon: w, critRoll: 0.0701, dodgeRoll: 0.99 });
  eq(edgeHigh.critRolled, false, 'roll ≥ critRate 不暴击(边界上沿)');
  eq(edgeLow.critMul, BASE_CRIT_DMG, '基础爆伤 150%');
  near(edgeLow.finalDamage, noCrit.finalDamage * 1.5, 0.6, '暴击伤害约为 1.5 倍');

  /* 爆伤封顶:718 + 词条堆到 3.0 以上仍钳制为 3.0 */
  const stackedCrit = combatantStats(30, [718, 730], { critDmg: 5.0 });
  eq(stackedCrit.critDmg, 3.0, '爆伤硬上限 3.0');
  const cap = computeDamage({ attacker: stackedCrit, target, weapon: WEAPON_BY_ID.get(718)!, critRoll: 0.0, dodgeRoll: 0.99 });
  eq(cap.critMul, 3.0, '暴击倍率钳制在 3.0');
});

test('管线6:护甲减伤为递减曲线,永不归零', () => {
  eq(ARMOR_K, 120, '护甲常数 K=120');
  const mk = (def: number): number => ARMOR_K / (ARMOR_K + def);
  eq(mk(0), 1.0, 'DEF=0 时无减伤');
  eq(mk(120), 0.5, 'DEF=K 时减伤恰好 50%');
  near(mk(240), 1 / 3, 1e-9, 'DEF=2K 时减伤 33.3%');
  ok(mk(1200) > 0, 'DEF 极高时减伤系数仍为正,不归零');
  ok(mk(0) - mk(120) > mk(960) - mk(1200), '减伤曲线递减:相同 DEF 增量的减伤收益逐段变小');

  const attacker = combatantStats(1, [711]);
  const w = WEAPON_BY_ID.get(711)!;
  const soft = computeDamage({ attacker, target: createTarget({ id: 's', name: '软', hp: 9e9, maxHp: 9e9, def: 120 }), weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  const hard = computeDamage({ attacker, target: createTarget({ id: 'h', name: '硬', hp: 9e9, maxHp: 9e9, def: 240 }), weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(soft.mitigationMul, 0.5, 'DEF=120 → 系数 0.5');
  ok(hard.finalDamage < soft.finalDamage, 'DEF 更高则最终伤害更低');
  ok(hard.finalDamage >= MIN_DAMAGE, `最低伤害保底 ${MIN_DAMAGE}`);

  /* 幽灵泡泡/无敌墙:takenMul=0 → 完全免疫 */
  const ghost = computeDamage({ attacker, target: createTarget({ id: 'g', name: '幽灵泡泡', hp: 100, maxHp: 100, takenMul: 0 }), weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  eq(ghost.finalDamage, 0, 'takenMul=0 时完全免伤');
});

test('管线7:728 反伤 150% 数值与半径', () => {
  const p728 = targetFromStats(combatantStats(10, [728]), { id: 'p728', name: '紫晶荆棘反伤甲' });
  eq(p728.dmgReduce, 0.30, '728 词条减伤 30%');
  eq(p728.reflectMul, 1.50, '728 反伤倍率 150%');

  const attacker = combatantStats(1, [711]);
  const w = WEAPON_BY_ID.get(711)!;
  const d = computeDamage({ attacker, target: p728, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });

  /* 无甲木桩基线:DEF 0 → 护甲系数 1.0 */
  const baseline = computeDamage({ attacker, target: createTarget({ id: 'dummy', name: '木桩', hp: 9e9, maxHp: 9e9 }), weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });

  /* 728 同时提供 DEF +32 与 30% 词条减伤,两者是独立的两个乘区 */
  const armorMul = ARMOR_K / (ARMOR_K + p728.def);
  near(armorMul, 120 / 152, 1e-9, '728 护甲系数 = 120/(120+32)');
  const expected = baseline.finalDamage * armorMul * 0.70;
  near(d.finalDamage, expected, 0.6, `728 承伤 ≈ 基线 × ${armorMul.toFixed(4)} 护甲 × 0.70 词条`);
  ok(d.finalDamage < baseline.finalDamage, '728 使实际承伤低于裸装基线');
  near(d.reflectDamage, d.finalDamage * 1.5, 0.02, `728 反伤 = 承伤 × 1.50 = ${d.reflectDamage}`);

  const sep = reflectFrom(1.50, d.finalDamage);
  eq(sep.reflectDamage, d.reflectDamage, '独立反伤入口与管线第 7 步数值一致');
  /* 反伤半径锚**字面量**。此处原为 `eq(sep.radius, REFLECT_RADIUS)` —— 断言右侧
   * 取自被测模块自己的导出常量,实现改多少判据跟着改多少,**数学上无法失败**。
   * 实测注入:`REFLECT_RADIUS` 3.0 → 6.0 时本套件仍 44/44 全绿。
   * 手册未给反伤作用半径(仅 §3 提到「反伤重盾」等词条,无半径数值),
   * 故以**当前值 3 格为设计基线**写死 —— 取自设计基线,非取自实现。
   * 同时锚常量本身,防止只改一侧。 */
  eq(sep.radius, 3, '反伤作用半径 3 格(设计基线)');
  eq(REFLECT_RADIUS, 3, 'REFLECT_RADIUS = 3 格(设计基线,非取自实现)');
});

test('管线8:击退冲量 = 武器击退 × 倍率 × 技能倍率 ÷ 质量', () => {
  const attacker = combatantStats(1, [719]);
  const w719 = WEAPON_BY_ID.get(719)!;
  eq(w719.knockbackMul, 3.0, '719 击退倍率 3.0');
  const light = computeDamage({ attacker, target: createTarget({ id: 'l', name: '小怪', hp: 9e9, maxHp: 9e9, mass: 1.0 }), weapon: w719, critRoll: 0.99, dodgeRoll: 0.99 });
  near(light.knockbackImpulse, 6.0 * 3.0 / 1.0, 1e-9, '轻目标击退 18 格/秒');
  const heavy = computeDamage({ attacker, target: createTarget({ id: 'h', name: 'Boss', hp: 9e9, maxHp: 9e9, mass: 20.0 }), weapon: w719, critRoll: 0.99, dodgeRoll: 0.99 });
  near(heavy.knockbackImpulse, 6.0 * 3.0 / 20.0, 1e-9, 'Boss 质量 20 时击退仅 0.9 格/秒');
  ok(heavy.knockbackImpulse < light.knockbackImpulse, '质量越大击退越小');
  eq(heavy.steps[heavy.steps.length - 1].step, '8 击退', '最后一步为「击退」');
});

test('管线:八步全部落在 steps 链上且顺序固定', () => {
  const a = combatantStats(18, [713]);
  const w = WEAPON_BY_ID.get(713)!;
  const t = createTarget({ id: 't', name: '怪', hp: 9e9, maxHp: 9e9, def: 40, element: Element.ICE });
  const d = computeDamage({ attacker: a, target: t, weapon: w, skill: w.skill, critRoll: 0.0, dodgeRoll: 0.99 });
  const names = d.steps.map((s) => s.step);
  eq(names.length, 8, '完整管线共 8 步');
  includes(names, '1 基础伤害');
  includes(names, '2 元素克制');
  includes(names, '3 破甲');
  includes(names, '4 破盾');
  includes(names, '5 暴击');
  includes(names, '6 减伤');
  includes(names, '7 反伤');
  includes(names, '8 击退');
  eq(names[0], '1 基础伤害', '第一步固定为基础');
  eq(names[7], '8 击退', '第八步固定为击退');
});

test('管线:闪避与超距分支短路,均不产生伤害', () => {
  const a = combatantStats(1, [711]);
  const w = WEAPON_BY_ID.get(711)!;
  const dodgy = createTarget({ id: 'd', name: '滑溜', hp: 100, maxHp: 100, dodgeRate: 0.25 });
  const dodged = computeDamage({ attacker: a, target: dodgy, weapon: w, critRoll: 0.99, dodgeRoll: 0.10 });
  eq(dodged.dodged, true, 'roll 低于闪避率则闪避');
  eq(dodged.finalDamage, 0, '闪避时 0 伤害');
  eq(dodged.float.text, '闪避', '飘字显示「闪避」');

  const hit = computeDamage({ attacker: a, target: dodgy, weapon: w, critRoll: 0.99, dodgeRoll: 0.30 });
  eq(hit.dodged, false, 'roll 高于闪避率则命中');

  const far = computeDamage({ attacker: a, target: dodgy, weapon: w, critRoll: 0.99, dodgeRoll: 0.99, distance: 50 });
  eq(far.outOfReach, true, '超距攻击不结算');
  eq(far.finalDamage, 0, '超距 0 伤害');

  /* 闪避率硬上限 0.75 */
  const capped = combatantStats(1, [724, 730]);
  ok(capped.dodgeRate <= MAX_DODGE_RATE, `闪避率 ${capped.dodgeRate} 不超过 0.75`);
});

test('击退/减伤/暴击的随机分布经 mulberry32 注入可复现', () => {
  const a = combatantStats(1, [711]);
  const w = WEAPON_BY_ID.get(711)!;
  const target = createTarget({ id: 'st', name: '木桩', hp: 9e9, maxHp: 9e9 });
  let crits = 0;
  const N = 2000;
  for (let i = 0; i < N; i += 1) {
    const d = computeDamage({ attacker: a, target, weapon: w, critRoll: rng(), dodgeRoll: 1 });
    if (d.critRolled) crits += 1;
  }
  const rate = crits / N;
  inRange(rate, 0.05, 0.10, `2000 次采样暴击率 ${rate.toFixed(4)} 应贴近 0.07`);

  const rngB = mulberry32(0x5eed10);
  const first = Array.from({ length: 5 }, () => rngB());
  const rngC = mulberry32(0x5eed10);
  const second = Array.from({ length: 5 }, () => rngC());
  for (let i = 0; i < 5; i += 1) near(first[i], second[i], 1e-12, '同种子序列完全一致');
});

test('伤害数字飘字:暴击金色放大、破盾前缀、治疗绿色', () => {
  const normal = floatText(120, false, false, 0);
  eq(normal.color, 'FFFFFF', '普通伤害白色');
  const crit = floatText(1200, true, false, 0);
  eq(crit.color, 'FFD34D', '暴击金色');
  ok(crit.sizeScale > normal.sizeScale, '暴击字号更大');
  const broken = floatText(300, false, true, 150);
  eq(broken.color, '66D9FF', '破盾蓝色');
  ok(broken.text.startsWith('破盾!'), '破盾飘字带前缀');
  const immune = floatText(0, false, false, 0);
  eq(immune.text, '免疫', '无伤害时显示免疫');
});

test('纯函数式结算:applyDamage 扣血、破盾余量、击倒判定', () => {
  const a = combatantStats(1, [711]);
  const w = WEAPON_BY_ID.get(711)!;
  const t = createTarget({ id: 'k', name: '小怪', hp: 30, maxHp: 30 });
  const d = computeDamage({ attacker: a, target: t, weapon: w, critRoll: 0.99, dodgeRoll: 0.99 });
  const applied = applyDamage(t, d);
  eq(t.hp, 30, '原对象未被就地修改(纯函数)');
  eq(applied.target.hp, 30 - d.finalDamage, '扣血正确');
  const lethal = applyDamage(createTarget({ id: 'k2', name: '残血', hp: 1, maxHp: 30 }), d);
  ok(lethal.downed, 'HP 归零判定击倒');

  /* 227 泡泡水枪 / 222 大锤:对队友 0 伤害 + 8 格/秒击退 */
  const ally = allyPrankHit(t);
  eq(ally.finalDamage, 0, '整蛊对队友 0 伤害');
  eq(ally.knockbackImpulse, 8.0, '整蛊固定 8 格/秒击退');
  eq(ally.source, DamageSource.PRANK);

  const healed = healTarget(createTarget({ id: 'h', name: '残血', hp: 50, maxHp: 100 }), 100);
  eq(healed.healed, 50, '治疗不超过上限');
  eq(healed.target.hp, 100, '治疗封顶到满血');
});

test('DoT 灼烧按帧结算且到点过期(713 火浪 15/s × 4s)', () => {
  const w = WEAPON_BY_ID.get(713)!;
  let task = makeDot('m', w.skill.dot!, 'lava');
  eq(task.dps, 15, '713 [Q] 灼烧 15/s');
  eq(task.remainSec, 4, '持续 4 秒');
  let total = 0;
  for (let i = 0; i < 80; i += 1) {
    const step = tickDot(task, 0.05);
    task = step.task;
    total += step.damage;
    if (i === 79) ok(step.expired, '4 秒后 DoT 过期');
  }
  near(total, 60, 0.5, '15/s × 4s = 60 点总伤害');
});

/* ═══════════════════════ 三、技能参数(713/716/718/723) ═══════════════════════ */

test('713 火浪 / 716 箭雨 / 718 陨石 / 723 时停的命中计划', () => {
  const s713 = WEAPON_BY_ID.get(713)!.skill;
  eq(s713.name, '熔岩裂地斩');
  eq(s713.range, 6.0, '713 火浪 6 格远');
  eq(s713.radius, 1.0, '713 火浪半宽 1(宽 2 格)');
  eq(s713.damageMul, 2.6, '713 技能倍率 2.6');
  const p713 = planSkillHits(s713);
  eq(p713.area, '6 格直线(宽 2)', '713 命中区域描述');
  eq(p713.totalMul, 2.6);

  const s716 = WEAPON_BY_ID.get(716)!.skill;
  eq(s716.name, '箭雨天降');
  eq(s716.durationSec, 3.0, '716 箭雨持续 3 秒');
  eq(s716.hits, 6, '716 每 0.5 秒一段共 6 段');
  eq(s716.tickSec, 0.5);
  eq(s716.extras.areaSize, '4x4', '716 覆盖 4×4');
  const p716 = planSkillHits(s716);
  eq(p716.ticks.length, 6);
  near(p716.totalMul, 3.3, 1e-9, '716 总倍率 0.55 × 6 = 3.3');

  const s718 = WEAPON_BY_ID.get(718)!.skill;
  eq(s718.name, '陨石星落');
  eq(s718.telegraphSec, 1.0, '718 1 秒地面预警');
  eq(s718.radius, 3.5, '718 流星半径 3.5 格');
  eq(s718.damageMul, 4.0, '718 巨额范围伤害 4.0 倍率');

  const s723 = WEAPON_BY_ID.get(723)!.skill;
  eq(s723.name, '时间凝滞力场');
  eq(s723.freezeSec, 3.0, '723 冻结 3 秒');
  eq(s723.extras.areaSize, '6x6', '723 6×6 钟表结界');
  eq(s723.shape, SkillShape.AREA);
  eq(s723.durationSec, 3.0, '时停持续 3 秒');

  eq(WEAPON_BY_ID.get(712)!.skill.stunSec, 1.5, '712 破盾重劈震晕 1.5 秒');
  eq(WEAPON_BY_ID.get(715)!.skill.hits, 3, '715 三连散射 3 支');
  eq(WEAPON_BY_ID.get(717)!.skill.healHp, 60, '717 治愈春风圈 60 HP');
  eq(WEAPON_BY_ID.get(720)!.skill.durationSec, 5.0, '720 落英幻境 5 秒护盾');
  eq(WEAPON_BY_ID.get(722)!.skill.extras.pullRadius, 5, '722 聚怪半径 5 格');
  eq(skillOf(204)!.stunSec, 0.8, '204 震波眩晕 0.8 秒');
});

/* ═══════════════════════ 四、等级 • 天赋 • 经验共享 ═══════════════════════ */

test('升级曲线 Lv.1 → Lv.30 累计经验 = 449500', () => {
  eq(expToNext(1), 100, 'expToNext(1) = 50+50');
  eq(expToNext(10), 5500, 'expToNext(10) = 50·100+50·10');
  eq(cumulativeExp(1), 0, 'Lv.1 起步为 0');
  eq(cumulativeExp(2), 100, '升到 Lv.2 需 100');
  let manual = 0;
  for (let i = 1; i < 30; i += 1) manual += expToNext(i);
  eq(cumulativeExp(30), manual, '累计经验与逐级求和一致');
  eq(expToReachMax(), 449500, 'Lv.1 → Lv.30 累计经验');

  const p = createProgress('P1');
  eq(p.level, 1);
  eq(p.maxHp, 100);
  const r = gainExp(p, 449500);
  eq(r.progress.level, MAX_LEVEL, '一次性灌满经验可升到满级');
  eq(r.progress.maxHp, statsAtLevel(30).maxHp, '满级生命 535');
  eq(r.progress.maxHp, 535);
  eq(r.levelUps.length, 29, '共触发 29 次升级');
  eq(r.animation.play, true, '升级播放动画');
  ok(r.animation.seconds > 0, '动画时长为正');
});

test('6 个天赋在 5/10/15/20/25/30 级解锁,每个数值可断言', () => {
  eq(TALENTS.length, 6, '天赋共 6 条');
  eq(TALENT_UNLOCK_LEVELS.length, 6);
  for (let i = 0; i < 6; i += 1) {
    eq(TALENTS[i].unlockLevel, TALENT_LEVELS[i], `第 ${i + 1} 条天赋解锁等级`);
  }

  /* 解锁边界:差 1 级不解锁,到级才解锁 */
  eq(activeTalents(4).length, 0, 'Lv.4 尚无天赋');
  eq(activeTalents(5).length, 1, 'Lv.5 解锁 1 条');
  eq(activeTalents(9).length, 1, 'Lv.9 仍 1 条');
  eq(activeTalents(10).length, 2, 'Lv.10 解锁第 2 条');
  eq(activeTalents(30).length, 6, 'Lv.30 六条全解锁');
  eq(talentsUnlockedAt(15).length, 1, 'Lv.15 恰好解锁 1 条');
  eq(talentsUnlockedAt(15)[0].id, 'talent_rescue_swift', 'Lv.15 天赋为急救快手');
  eq(isTalentUnlocked(14, 'talent_rescue_swift'), false, 'Lv.14 未解锁急救快手');
  eq(isTalentUnlocked(15, 'talent_rescue_swift'), true, 'Lv.15 解锁急救快手');

  /* 逐条数值断言 */
  const roll = TALENT_BY_ID.get('talent_roll_bomb')!;
  eq(roll.effects.shadowBombRatio, 0.40, '翻滚残影炸弹伤害 = 攻击力 40%');
  eq(roll.effects.shadowBombSec, 2.0, '残影存在 2 秒');
  eq(roll.effects.rollCdMul, 0.80, '翻滚冷却 ×0.80');

  const thr = TALENT_BY_ID.get('talent_throw_master')!;
  eq(thr.effects.throwDamageMul, 2.00, '投掷伤害翻倍 2.00');
  eq(thr.effects.throwRangeBonus, 1.0, '投掷距离 +1 格');

  const res = TALENT_BY_ID.get('talent_rescue_swift')!;
  eq(res.effects.reviveTimeMul, 0.50, '救援速度翻倍(时间 ×0.50)');
  eq(res.effects.reviveHpRatioBonus, 0.10, '复活血量 50% → 60%');

  const cm = TALENT_BY_ID.get('talent_crit_master')!;
  eq(cm.effects.critRateBonus, 0.08, '暴击率 +8%');
  eq(cm.effects.critDmgBonus, 0.25, '爆伤 +25%');

  const ea = TALENT_BY_ID.get('talent_element_affinity')!;
  eq(ea.effects.counterAmpCap, 1.875, '元素克制 1.5 → 1.875');
  eq(ea.effects.resistAmpFloor, 0.375, '被克制 0.75 → 0.375');

  const dr = TALENT_BY_ID.get('talent_dream_revelation')!;
  eq(dr.effects.expGainMul, 1.20, '经验获取 +20%');
  eq(dr.effects.afkExpRatio, 0.45, '打盹系数 0.3 → 0.45');

  /* 升级时属性重算:每级 HP +15、伤害 +3%、负重格 +1 */
  const p = setLevel(createProgress('P2'), 30);
  eq(p.maxHp, 100 + 15 * 29, 'Lv.30 生命 535');
  near(p.dmgMul, 1 + 0.03 * 29, 1e-9, 'Lv.30 伤害倍率 1.87');
  eq(p.carrySlots, 8 + 29, 'Lv.30 负重格 37');
  eq(p.talentFlags.critRateBonus, 0.08, '天赋旗标写入档案');
  eq(p.talentFlags.expGainMul, 1.20, 'Lv.30 天赋旗标');
  ok(Object.keys(p.talentFlags).length >= 6, '天赋旗标覆盖 6 条天赋效果');
});

test('经验共享1:24 格内 100% 全额、24 格外 0(不分补刀)', () => {
  eq(SHARE_RADIUS, 24, '共享半径 = SHARE_EXP_RADIUS 24');
  eq(SHARE_EXP_RADIUS, 24, '冻结层常数一致');

  const ledger = new KillLedger();
  const res = settleMobExp(ledger, {
    mobInstanceId: 'mob_a', mobLevel: 1, baseExp: 100,
    participants: [
      { playerId: 'killer', distance: 0, level: 1, afk: false },
      { playerId: 'near', distance: 23.9, level: 1, afk: false },
      { playerId: 'far', distance: 24.1, level: 1, afk: false },
    ],
  });
  const killer = res.entries.find((e) => e.playerId === 'killer')!;
  const nearOne = res.entries.find((e) => e.playerId === 'near')!;
  const farOne = res.entries.find((e) => e.playerId === 'far')!;

  eq(killer.share, 100, '补刀者拿 100%,无额外加成');
  eq(nearOne.share, 100, '23.9 格内拿 100%(少于 3 人不触发欢聚)');
  eq(killer.share, nearOne.share, '不分补刀:补刀者与旁观者经验相同');
  eq(farOne.share, 0, '24.1 格外拿 0');
  eq(farOne.inRadius, false, '超出半径标记');
  eq(res.outOfRangeCount, 1, '1 人被判定超距');
  eq(res.participantCount, 2, '半径内非打盹人数 2');
});

test('经验共享2:≥3 人触发 +25% 欢聚加成(阈值边界)', () => {
  eq(PARTY_BONUS_THRESHOLD, 3);
  eq(PARTY_BONUS, 0.25);

  const two = new KillLedger();
  const r2p = settleMobExp(two, {
    mobInstanceId: 'mob_2p', mobLevel: 1, baseExp: 200,
    participants: [
      { playerId: 'A', distance: 1, level: 1, afk: false },
      { playerId: 'B', distance: 2, level: 1, afk: false },
    ],
  });
  eq(r2p.partyMul, 1.0, '2 人不触发欢聚加成');
  eq(r2p.entries[0].share, 200, '2 人时每人 200');

  const three = new KillLedger();
  const r3p = settleMobExp(three, {
    mobInstanceId: 'mob_3p', mobLevel: 1, baseExp: 200,
    participants: [
      { playerId: 'A', distance: 1, level: 1, afk: false },
      { playerId: 'B', distance: 2, level: 1, afk: false },
      { playerId: 'C', distance: 3, level: 1, afk: false },
    ],
  });
  eq(r3p.partyMul, 1.25, '3 人触发 1.25 倍');
  eq(r3p.entries[0].share, 250, '200 × 1.25 = 250');
  eq(r3p.partyMul, 1 + PARTY_BONUS, '欢聚加成 = 1 + 0.25');
});

test('经验共享3:打盹/挂机只拿 0.3× 梦境见习经验', () => {
  eq(AFK_EXP_RATIO, 0.3, '冻结层 AFK_EXP_RATIO');
  const ledger = new KillLedger();
  const res = settleMobExp(ledger, {
    mobInstanceId: 'mob_afk', mobLevel: 1, baseExp: 100,
    participants: [
      { playerId: 'awake', distance: 1, level: 1, afk: false },
      { playerId: 'sleepy', distance: 1, level: 1, afk: true },
      { playerId: 'awake2', distance: 1, level: 1, afk: false },
      { playerId: 'awake3', distance: 1, level: 1, afk: false },
    ],
  });
  const awake = res.entries.find((e) => e.playerId === 'awake')!;
  const sleepy = res.entries.find((e) => e.playerId === 'sleepy')!;
  eq(sleepy.afkApplied, true, '打盹标记生效');
  eq(res.participantCount, 3, '打盹者不计入 3 人阈值,清醒的 3 人触发欢聚');
  eq(res.partyMul, 1.25, '3 名清醒玩家触发 1.25 倍');
  eq(awake.share, 125, '清醒者 = 100 × 1.25 = 125');
  eq(sleepy.share, Math.round(100 * 1.25 * 0.3), '打盹者 = 100 × 1.25 × 0.3 = 38');
  ok(sleepy.share < awake.share, '打盹经验显著低于清醒');

  /* 打盹系数精确核对(单人在场、无欢聚加成) */
  const solo = new KillLedger();
  const soloRes = settleMobExp(solo, {
    mobInstanceId: 'mob_afk2', mobLevel: 1, baseExp: 1000,
    participants: [{ playerId: 'nap', distance: 1, level: 1, afk: true }],
  });
  eq(soloRes.entries[0].share, 300, '1000 × 0.3 = 300');
  eq(soloRes.partyMul, 1.0, '打盹者不计入阈值,单人不触发欢聚');
});

test('经验共享4:同一怪只结算一次 + 8 人同时结算总额上限防刷', () => {
  const ledger = new KillLedger();
  const eight = Array.from({ length: 8 }, (_v, i) => ({
    playerId: `P${i}`, distance: 5, level: 1, afk: false,
  }));
  const first = settleMobExp(ledger, { mobInstanceId: 'mob_boss', mobLevel: 1, baseExp: 100, participants: eight });
  eq(first.deduped, false, '首次结算正常');
  eq(first.participantCount, 8, '8 人计入');
  eq(first.partyMul, 1.25, '8 人享受欢聚加成');
  eq(first.rawTotal, 100 * 1.25 * 8, '未裁剪总额 = 1000');
  eq(first.cap, 100 * PER_MOB_EXP_CAP_MULT, '上限 = baseExp × 5.0 = 500');
  eq(first.capped, true, '触发总额上限');
  eq(first.total, 500, '实际发放被压到恰好 500');
  eq(first.entries[0].share, 63, '余数补给:前 4 人各 63');
  eq(first.entries[7].share, 62, '后 4 人各 62');
  eq(first.entries.filter((e) => e.share === 63).length, 4, '恰好 4 人拿到补齐的 1 点');
  ok(first.total <= first.cap, '总额不超过上限');
  eq(first.entries.reduce((a, b) => a + b.share, 0), first.total, '分项之和恰好等于总额(余数已补齐)');

  const again = settleMobExp(ledger, { mobInstanceId: 'mob_boss', mobLevel: 1, baseExp: 100, participants: eight });
  eq(again.deduped, true, '同一怪二次结算被去重拒绝');
  eq(again.total, 0, '重复结算发放 0 经验');
  eq(again.entries.length, 0, '重复结算无发放条目');

  const other = settleMobExp(ledger, { mobInstanceId: 'mob_other', mobLevel: 1, baseExp: 100, participants: eight.slice(0, 2) });
  eq(other.deduped, false, '不同怪实例可正常结算');
  eq(ledger.size(), 2, '账本记录 2 个怪实例');

  /* 4 人未触发上限:4 × 1.25 = 5.0 倍,恰为闸门阈值 */
  const l2 = new KillLedger();
  const four = settleMobExp(l2, {
    mobInstanceId: 'mob_4p', mobLevel: 1, baseExp: 100,
    participants: Array.from({ length: 4 }, (_v, i) => ({ playerId: `Q${i}`, distance: 1, level: 1, afk: false })),
  });
  eq(four.rawTotal, 500, '4 人未裁剪总额 500');
  eq(four.capped, false, '4 人恰好触达但不越过闸门');
  eq(four.total, 500, '未裁剪时全额发放');
});

test('经验共享:等级压制与增益乘区,并可直接写进玩家档案', () => {
  eq(levelGapMul(1, 10), 1.0, '等级不高于怪物时无压制');
  near(levelGapMul(10, 10), 1.0, 1e-9, '同级 100%');
  near(levelGapMul(15, 10), 0.5, 1e-9, '高 5 级 → 50%');
  near(levelGapMul(30, 10), 0.1, 1e-9, '压制下限 0.10');

  const ledger = new KillLedger();
  const res = settleMobExp(ledger, {
    mobInstanceId: 'mob_buff', mobLevel: 10, baseExp: 1000,
    participants: [
      { playerId: 'cake', distance: 1, level: 10, afk: false, expBonusMul: 1.30 },
      { playerId: 'dream', distance: 1, level: 10, afk: false, hasDreamTalent: true, expBonusMul: 1.0 },
    ],
  });
  eq(res.entries.find((e) => e.playerId === 'cake')!.share, 1300, '613 庆典蛋糕 +30% → 1300');
  eq(res.entries.find((e) => e.playerId === 'dream')!.share, 1200, 'Lv.30 天赋梦境启示 +20% → 1200');

  const progresses = new Map([['cake', createProgress('cake')], ['dream', createProgress('dream')]]);
  const applied = applyShareResult(progresses, res);
  eq(applied.progresses.get('cake')!.totalExp, 1300, '结算写入档案累计经验');
  eq(applied.progresses.get('cake')!.level, 4, '1300 经验:100+300+600=1000 已过 Lv.4,还差 1000 升 Lv.5');
  eq(applied.events.get('cake')!.levelUps.length, 3, '共触发 3 次升级(Lv.2/3/4)');
  eq(cumulativeExp(4), 1000, '到 Lv.4 累计需 1000');
  ok(cumulativeExp(5) > 1300, 'Lv.5 需要 1500,故停在 Lv.4');
  eq(applied.progresses.get('cake')!.exp, 300, 'Lv.4 内进度 300');
});

test('533 魔镜洗练:消耗 5 露水,14 词条池,4 档分档', () => {
  eq(REBIRTH_DEW_COST, 5, '洗练消耗 5 梦境露水');
  eq(REBIRTH_AFFIX_POOL.length, 14, '词条池 14 条');
  const tiers: [number, number][] = [[0.0, 1], [0.5499, 1], [0.55, 2], [0.8699, 2], [0.87, 3], [0.9799, 3], [0.98, 4], [0.9999, 4]];
  for (const [roll, tier] of tiers) {
    eq(reforge(roll, 0).tier, tier, `roll=${roll} → 档 ${tier}`);
  }
  const r = reforge(0.99, 0.0);
  eq(r.affix, 'atk_pct', 'pick=0 命中池首');
  eq(r.dewCost, 5);
  ok(REBIRTH_AFFIX_POOL.includes(reforge(0.5, 0.99).affix), 'pick 取模后仍是合法词条');
  ok(REBIRTH_AFFIX_POOL.includes(reforge(0.5, 1.5).affix), 'pick 超出范围取模回落');
});

test('套装与徽章光环:719+727 触发果冻王 2 件套', () => {
  eq(SET_BONUSES.length, 3, '共 3 组套装');
  eq(activeSets([719, 727]).length, 1, '719+727 触发果冻王套装');
  eq(activeSets([719]).length, 0, '单件不触发套装');
  const solo = equipSummary([719]);
  const paired = equipSummary([719, 727]);
  ok(paired.hpMulFromSets > solo.hpMulFromSets, '2 件套提升生命乘区');
  near(paired.atkMulFromSets, 1.08, 1e-9, '果冻王 2 件套攻击 ×1.08');
  near(paired.hpMulFromSets, 1.05, 1e-9, '果冻王 2 件套生命 ×1.05');
  eq(paired.flags.set_set_jelly_king, 1.08, '套装旗标');

  /* 731 徽章:8 格内每名队友 +5% 攻防,上限 +40% */
  const no = combatantStats(10, [731], { allyCount: 0 });
  const four = combatantStats(10, [731], { allyCount: 4 });
  const many = combatantStats(10, [731], { allyCount: 20 });
  near(no.totalAtk, 10, 1e-9, '无队友时无加成');
  near(four.totalAtk, 10 * 1.20, 1e-9, '4 名队友 +20% 攻击');
  near(many.totalAtk, 10 * 1.40, 1e-9, '20 名队友被钳制在 +40%');
  near(many.flags.allyAura, 0.40, 1e-9, '光环上限 0.40');
});

test('经验共享:同一怪 8 人结算的防刷总额与单怪上限一致', () => {
  const ledger = new KillLedger();
  const mob = { mobInstanceId: 'boss_kraken', mobLevel: 20, baseExp: 2500 };
  const eight = Array.from({ length: 8 }, (_v, i) => ({
    playerId: `R${i}`, distance: 10, level: 20, afk: false,
  }));
  const res = settleMobExp(ledger, { ...mob, participants: eight });
  eq(res.cap, 2500 * 5, 'Boss 级怪上限 12500');
  eq(res.rawTotal, 2500 * 1.25 * 8, '理论总额 25000');
  eq(res.capped, true, '触发防刷闸门');
  eq(res.total, 12500, '实发恰好 12500,严格等于上限');
  eq(res.entries[0].share, 1563, '余数补齐:前 4 人各 1563');
  eq(res.entries[7].share, 1562, '后 4 人各 1562');
  ok(res.entries.every((e) => e.scaledDown), '全部标记为被缩减');
  ok(res.total <= res.cap, '总额不越过上限');
  eq(res.entries.reduce((a, b) => a + b.share, 0), res.total, '分项之和恰好等于总额');
  ok(res.entries[0].share < 2500, '8 人同时结算的人均经验低于单刷满额,构成防刷激励');
});

/* ═══════════════════════ 五、幽灵泡泡倒地与救援 ═══════════════════════ */

const EQUIP: EquipmentSnapshot = {
  weapon: 713, armor: 728, helm: 616, boots: 619, relic: 730, cape: 630,
};

test('幽灵泡泡:倒地零掉级零爆装,等级与装备栏快照完全不变', () => {
  const before = setLevel(createProgress('Hero'), 18);
  const levelBefore = before.level;
  const expBefore = before.exp;
  const totalBefore = before.totalExp;
  const equipBefore: EquipmentSnapshot = { ...EQUIP };

  const downed = createDowned(before, EQUIP, 12, -7);
  eq(downed.state, BodyState.GHOST_BUBBLE, '倒地后进入 GHOST_BUBBLE 状态');
  eq(downed.levelSnapshot, levelBefore, '快照记录倒地时等级');
  eq(downed.equipmentSnapshot.weapon, 713, '快照记录武器');
  eq(downed.equipmentSnapshot.armor, 728, '快照记录护甲');

  /* 模拟倒地 60 秒漂浮 */
  let d = downed;
  for (let i = 0; i < 1200; i += 1) d = tickGhostBubble(d, 0.05).downed;
  ok(d.downedSec > 59, `幽灵泡泡已漂浮 ${d.downedSec} 秒`);
  eq(d.state, BodyState.GHOST_BUBBLE, '漂浮期间状态不变');

  /* 用羽毛笔满血复活(不消耗等级) */
  const revived = featherRevive({ downed: d, casterId: 'Friend', distance: 3, progress: before });
  eq(revived.revived, true, '羽毛笔复活成功');
  eq(revived.result!.levelUnchanged, true, '零掉级:等级完全不变');
  eq(revived.result!.equipmentUnchanged, true, '零爆装:装备栏完全不变');
  eq(before.level, levelBefore, '档案等级未被改写');
  eq(before.exp, expBefore, '档案经验进度未被改写');
  eq(before.totalExp, totalBefore, '档案累计经验未被改写');
  const diff = snapshotDiff(equipBefore, EQUIP);
  eq(diff.changed, false, '装备栏快照逐格比对无差异');
  eq(diff.keys.length, 0, '没有任何槽位变化');
  eq(before.maxHp, statsAtLevel(levelBefore).maxHp, '生命上限仍是该等级的标准值');
});

test('幽灵泡泡:期间完全免伤且不能移动/攻击/被治疗', () => {
  const p = setLevel(createProgress('Ghost'), 10);
  const d = createDowned(p, EQUIP, 0, 0);
  eq(ghostDamageMul(d), 0, '幽灵泡泡免伤乘区为 0');
  const ctl = ghostControl(d);
  eq(ctl.moveMul, GHOST_MOVE_MUL, '位移乘数 0(不能自主移动)');
  eq(ctl.moveMul, 0, '位移被完全限制');
  eq(ctl.canAttack, false, '不能攻击');
  eq(ctl.canBeHealed, false, '不能被治疗');
  const healed = ghostControl({ ...d, state: BodyState.NORMAL });
  eq(healed.canAttack, true, '复活后可攻击');
  eq(healed.moveMul, 1, '复活后位移恢复');

  /* 幽灵泡泡受击 0 伤害 */
  const a = combatantStats(30, [723]);
  const w = WEAPON_BY_ID.get(723)!;
  const hit = computeDamage({
    attacker: a, target: createTarget({ id: 'g', name: '幽灵泡泡', hp: 100, maxHp: 100, takenMul: ghostDamageMul(d) }),
    weapon: w, critRoll: 0.0, dodgeRoll: 0.99,
  });
  eq(hit.finalDamage, 0, '幽灵泡泡受击完全免伤');
});

test('幽灵泡泡:队友触碰 1 秒半血复活', () => {
  eq(REVIVE_TIME, 1.0, '冻结层 REVIVE_TIME = 1.0 秒');
  eq(REVIVE_HP_RATIO, 0.5, '冻结层 REVIVE_HP_RATIO = 0.5');
  const p = setLevel(createProgress('Down'), 10);
  eq(p.maxHp, 235, 'Lv.10 生命上限 235');
  const start = createDowned(p, EQUIP, 0, 0);

  /* 累计 0.95 秒尚未完成 */
  let d = start;
  let outcome = touchRevive({ downed: d, rescuerId: 'Friend', distance: 0.5, dt: 0.95, progress: p });
  eq(outcome.revived, false, '0.95 秒未完成救援');
  near(outcome.downed.reviveProgress, 0.95, 1e-9, '救援进度累计 0.95');
  d = outcome.downed;

  /* 再补 0.05 秒 → 满 1.0 秒完成 */
  outcome = touchRevive({ downed: d, rescuerId: 'Friend', distance: 0.5, dt: 0.05, progress: p });
  eq(outcome.revived, true, '满 1.0 秒完成复活');
  eq(outcome.result!.method, ReviveMethod.TOUCH, '复活方式为触摸');
  eq(outcome.result!.elapsedSec, REVIVE_TIME, '耗时恰好 1.0 秒');
  eq(outcome.result!.hpAfter, Math.round(235 * 0.5), '半血复活 118 HP');
  eq(outcome.result!.hpAfter, 118);
  eq(outcome.downed.state, BodyState.NORMAL, '复活后回到 NORMAL');
  eq(outcome.result!.levelUnchanged, true, '零掉级');

  /* 超出触摸半径则进度清零 */
  const away = touchRevive({ downed: d, rescuerId: 'Friend', distance: TOUCH_RADIUS + 0.1, dt: 0.5, progress: p });
  eq(away.revived, false, '距离过远不推进救援');
  eq(away.downed.reviveProgress, 0, '离开后进度归零');
  eq(d.reviveProgress, 0.95, '原状态对象未被就地修改(纯函数)');

  /* Lv.15 天赋「急救快手」:救援时间减半 → 0.5 秒,且复活血量 50% → 60% */
  const half = touchRevive({
    downed: away.downed, rescuerId: 'Medic', distance: 0.4, dt: 0.5, progress: p,
    reviveTimeMul: 0.5, reviveHpRatioBonus: 0.10,
  });
  eq(half.revived, true, '0.5 秒内完成救援(天赋加速)');
  eq(half.result!.elapsedSec, 0.5, '救援耗时减半为 0.5 秒');
  eq(half.result!.hpAfter, Math.round(235 * 0.6), '天赋额外 +10% → 60% 生命 141');
  eq(half.result!.hpAfter, 141);
  eq(half.result!.hpAfter - outcome.result!.hpAfter, 23, '天赋多回 23 HP(60% − 50%)');
});

test('227 泡泡水枪:连中 3 发把人装进大泡泡,并可直接灭高炉火', () => {
  eq(BUBBLE_GUN_SHOTS, 3, '227 需连中 3 发');
  eq(BUBBLE_TRAP_SEC, 5.0, '泡泡困人 5 秒');
  const p = setLevel(createProgress('Target'), 10);
  let d = createDowned(p, EQUIP, 0, 0);
  const s1 = bubbleGunHit(d);
  eq(s1.trapped, false, '第 1 发未困住');
  eq(s1.downed.bubbleStacks, 1, '层数 1');
  const s2 = bubbleGunHit(s1.downed);
  eq(s2.trapped, false, '第 2 发未困住');
  eq(s2.downed.bubbleStacks, 2, '层数 2');
  const s3 = bubbleGunHit(s2.downed);
  eq(s3.trapped, true, '第 3 发成功困人');
  eq(s3.downed.state, BodyState.BUBBLED, '状态变为 BUBBLED');
  eq(s3.downed.bubbleStacks, 0, '层数清零');
  eq(s3.downed.invulnSec, BUBBLE_TRAP_SEC, '困人计时 = 5 秒');

  /* 227 水枪灭火:3 格内火格强度归零 */
  const cells = [
    { x: 0, y: 0, intensity: 1.0 },
    { x: 2, y: 2, intensity: 0.8 },
    { x: 9, y: 9, intensity: 1.0 },
  ];
  const out = extinguishFire(cells, 0, 0);
  eq(out.extinguished, 2, '3 格内 2 处火被浇灭');
  eq(out.cells[0].intensity, 0, '近处火格熄灭');
  eq(out.cells[2].intensity, 1.0, '远处火格不受影响');
  eq(cells[0].intensity, 1.0, '原数组未被就地修改');
});

test('733 复苏羽毛笔:6 格满血复活 + 3 秒无敌', () => {
  eq(FEATHER_RANGE, 6, '冻结层 FEATHER_RANGE = 6 格');
  eq(FEATHER_INVULN, 3.0, '冻结层 FEATHER_INVULN = 3.0 秒');
  const p = setLevel(createProgress('Fallen'), 20);
  const d = createDowned(p, EQUIP, 5, 5);

  /* 超距失败 */
  const tooFar = featherRevive({ downed: d, casterId: 'Angel', distance: 6.1, progress: p });
  eq(tooFar.revived, false, '6.1 格超出 6 格射程,复活失败');
  ok(tooFar.reason.includes('6'), `失败原因含距离:${tooFar.reason}`);

  /* 恰好 6 格成功 */
  const okRange = featherRevive({ downed: d, casterId: 'Angel', distance: 6, progress: p });
  eq(okRange.revived, true, '恰好 6 格成功复活');
  eq(okRange.result!.method, ReviveMethod.FEATHER, '复活方式为羽毛笔');
  eq(okRange.result!.hpAfter, p.maxHp, '满血复活');
  eq(okRange.result!.hpAfter, 385, 'Lv.20 满血 385');
  eq(okRange.result!.invulnSec, FEATHER_INVULN, '3 秒无敌');
  eq(okRange.result!.levelUnchanged, true, '零掉级');
  eq(okRange.downed.invulnSec, FEATHER_INVULN, '无敌计时写入状态');
  eq(isInvulnerable(okRange.downed), true, '无敌判定为真');

  /* 无敌倒计时 */
  let s = okRange.downed;
  s = tickInvuln(s, 1.0);
  near(s.invulnSec, 2.0, 1e-9, '1 秒后剩 2 秒无敌');
  s = tickInvuln(s, 2.0);
  eq(s.invulnSec, 0, '3 秒后无敌结束');
  eq(isInvulnerable(s), false, '无敌判定为假');

  /* 对非幽灵泡泡目标无效 */
  const notGhost = featherRevive({ downed: { ...d, state: BodyState.NORMAL }, casterId: 'Angel', distance: 2, progress: p });
  eq(notGhost.revived, false, '目标不是幽灵泡泡时无效');
});

test('435 复活旗:3 格内读条 2 秒半血复活', () => {
  eq(FLAG_REVIVE_TIME, 2.0, '旗点复活读条 2 秒');
  eq(FLAG_REVIVE_RADIUS, 3.0, '旗点复活半径 3 格');
  const p = setLevel(createProgress('FlagHero'), 30);
  const d = createDowned(p, EQUIP, 0, 0);

  const far = flagRevive({ downed: d, flagId: 'flag_blue', distance: 3.5, dt: 1.0, progress: p });
  eq(far.revived, false, '超出 3 格半径不推进');
  eq(far.downed.reviveProgress, 0);

  const half = flagRevive({ downed: d, flagId: 'flag_blue', distance: 1.0, dt: 1.0, progress: p });
  eq(half.revived, false, '1 秒尚未读条完成');
  const done = flagRevive({ downed: half.downed, flagId: 'flag_blue', distance: 1.0, dt: 1.0, progress: p });
  eq(done.revived, true, '2 秒读条完成');
  eq(done.result!.flagId, 'flag_blue', '记录复活旗归属');
  eq(done.result!.hpAfter, Math.round(535 * 0.5), '半血复活 268');
  eq(done.result!.levelUnchanged, true, '零掉级');
  eq(done.downed.state, BodyState.NORMAL);
});

/* ═══════════════════════ 六、料理与恶作剧锅 ═══════════════════════ */

test('601-615 全部 15 项料理的效果与时长数据化', () => {
  eq(FOODS.length, 15, '601~615 共 15 项');
  for (let id = 601; id <= 615; id += 1) {
    const f = FOOD_BY_ID.get(id);
    ok(f !== undefined, `缺少料理 ${id}`);
    eq(f!.name, ITEM_BY_ID.get(id)!.name, `料理 ${id} 名称取冻结层`);
    eq(ITEM_BY_ID.get(id)!.category, ItemCategory.FOOD, `料理 ${id} 分类`);
  }
  eq(FOOD_BY_ID.get(601)!.instantHealHp, 40, '601 立即回 40 HP');
  eq(FOOD_BY_ID.get(601)!.durationSec, 600, '601 持续 10 分钟');
  near(FOOD_BY_ID.get(601)!.statMods.moveMul!, 1.15, 1e-9, '601 移速 +15%');
  eq(FOOD_BY_ID.get(602)!.statMods.hpFlat, 30, '602 生命上限 +30');
  eq(FOOD_BY_ID.get(603)!.statMods.critRate, 0.15, '603 暴击率 +15%');
  eq(FOOD_BY_ID.get(603)!.flags.dropDoubleChance, 0.35, '603 掉落翻倍 35%');
  eq(FOOD_BY_ID.get(604)!.statMods.jumpMul, 1.50, '604 跳跃 +50%');
  eq(FOOD_BY_ID.get(604)!.flags.fallStunImmune, true, '604 免疫跌落眩晕');
  near(FOOD_BY_ID.get(605)!.statMods.atkMul!, 1.25, 1e-9, '605 近战攻击 +25%');
  eq(FOOD_BY_ID.get(605)!.flags.throwRangeBonus, 3, '605 投掷距离 +3 格');
  eq(FOOD_BY_ID.get(606)!.flags.fireDotPerHit, 15, '606 每次攻击附 15 点灼烧');
  eq(FOOD_BY_ID.get(606)!.durationSec, 900, '606 持续 15 分钟');
  eq(FOOD_BY_ID.get(612)!.instantHealHp, 80, '612 立即回 80 HP');
  eq(FOOD_BY_ID.get(612)!.flags.cleanse, true, '612 净化负面状态');
  eq(FOOD_BY_ID.get(613)!.statMods.expMul, 1.30, '613 经验 +30%');
  eq(FOOD_BY_ID.get(613)!.durationSec, 1200, '613 持续 20 分钟');
  eq(FOOD_BY_ID.get(614)!.flags.tame, true, '614 可驯化');
  eq(FOOD_BY_ID.get(615)!.flags.spriteEfficiencyMul, 2.0, '615 森灵效率翻倍');
  eq(FOOD_BY_ID.get(615)!.durationSec, 1800, '615 持续 30 分钟');
});

test('恶作剧锅:正常投料出锅 604,偷塞变身菇改判 608', () => {
  eq(SOUP_POT_ID, 506, '大汤锅 ID');
  eq(PRANK_PRIORITY.length, 5, '整蛊判定优先级 5 条(607~611)');

  /* 正常投料:{104:1, 124:2, 121:2} */
  const normal = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2 } });
  eq(normal.ok, true, '正常投料出锅成功');
  eq(normal.branch, CookBranch.NORMAL, '判定为正常分支');
  eq(normal.itemId, 604, '产出 604 星光萤火蘑菇汤');
  eq(normal.name, ITEM_BY_ID.get(604)!.name, '名称与冻结层一致');
  eq(normal.prankTriggeredBy, null, '无整蛊触发');
  eq(normal.durationSec, 600, '持续 600 秒');
  eq(normal.buff!.durationSec, 600, 'buff 结构写入总时长');
  eq(normal.buff!.remainingSec, 600, 'buff 剩余时长初始化');
  eq(normal.buff!.key, 'food_604', 'buff key 规范');
  eq(normal.buff!.sourceItemId, 604, 'buff 记录来源物品');
  eq(normal.buff!.branch, CookBranch.NORMAL);
  near(normal.buff!.statMods.jumpMul, 1.50, 1e-9, 'buff 写入跳跃 +50%');
  eq(normal.buff!.flags.fallStunImmune, true, 'buff 写入免疫跌落眩晕');

  /* 偷塞 1 个幻彩变身菇 127 → 改判 608 */
  const pranked = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2, 127: 1 } });
  eq(pranked.ok, true, '偷塞后仍出锅');
  eq(pranked.branch, CookBranch.PRANK, '判定为恶作剧分支');
  eq(pranked.itemId, 608, '产出 608 小肥鸡咯咯浓汤');
  eq(pranked.name, '小肥鸡咯咯浓汤(恶作剧锅)');
  eq(pranked.prankTriggeredBy!['127'], 1, '触发投料明细记录 127×1');
  eq(pranked.durationSec, 60, '持续 60 秒');
  eq(pranked.buff!.durationSec, 60, 'buff 总时长 60 秒');
  eq(pranked.buff!.branch, CookBranch.PRANK, 'buff 分支标记为 PRANK');
  eq(pranked.buff!.flags.morph, 'CHICKEN', 'buff 写入变形目标 CHICKEN');
  eq(pranked.prankFlags.morph, 'CHICKEN', '整蛊旗标同步给玩家名单');
  ok(pranked.reason.includes('整蛊'), `判定原因:${pranked.reason}`);
});

test('恶作剧锅:607/609/610/611 五种整蛊料理的触发投料与时长', () => {
  /* 607 喷火彩虹屁咖喱:126 ×2 */
  const r607 = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2, 126: 2 } });
  eq(r607.itemId, 607, '爆裂火椒 ×2 → 607');
  eq(r607.durationSec, 300, '607 持续 300 秒');
  near(r607.buff!.statMods.atkMul, 1.25, 1e-9, '607 攻击 +25%');
  eq(r607.buff!.flags.rocketFart, true, '607 失控冲刺');
  eq(r607.buff!.flags.rocketEverySteps, 3, '607 每三步触发');
  eq(r607.buff!.flags.rocketDashTiles, 2, '607 向前冲刺 2 格');

  /* 609 气球肚皮漂浮饮:119 ×2 */
  const r609 = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2, 119: 2 } });
  eq(r609.itemId, 609, '云朵棉花 ×2 → 609');
  eq(r609.durationSec, 240, '609 持续 240 秒');
  near(r609.buff!.statMods.gravityMul, 0.30, 1e-9, '609 重力降至 30%');

  /* 610 滑溜溜溜冰奶昔:125 ×2 */
  const r610 = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2, 125: 2 } });
  eq(r610.itemId, 610, '滑溜香蕉 ×2 → 610');
  eq(r610.durationSec, 240, '610 持续 240 秒');
  near(r610.buff!.statMods.muOverride, 0.96, 1e-9, '610 摩擦系数 0.96');

  /* 611 大嗓门回声果冻:124 ×3 */
  const r611 = cookSoup({ inputs: { 104: 1, 124: 3, 121: 2 } });
  eq(r611.itemId, 611, '弹簧跳跳菇 ×3 → 611');
  eq(r611.durationSec, 300, '611 持续 300 秒');
  eq(r611.buff!.flags.weaponSfx, 'MUSIC_BOX', '611 挥剑八音盒音效');
  eq(r611.buff!.flags.chatScale, 2.0, '611 聊天文字放大');

  /* 优先级:同时满足 607 与 608 时列表靠前者优先 */
  const both = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2, 126: 2, 127: 1 } });
  eq(both.itemId, 607, '同时命中 607/608 时按优先级取 607');
  eq(PRANK_PRIORITY[0], 607, '优先级首位为 607');

  /* 五种整蛊料理时长汇总断言 */
  const durations = [607, 608, 609, 610, 611].map((id) => FOOD_BY_ID.get(id)!.durationSec);
  eq(durations.length, 5, '五种整蛊料理');
  eq(durations[0], 300);
  eq(durations[1], 60);
  eq(durations[2], 240);
  eq(durations[3], 240);
  eq(durations[4], 300);
});

test('恶作剧锅:火灭、空投料、投料不足的失败分支', () => {
  const out = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2 }, fireOut: true });
  eq(out.ok, false, '火被浇灭时出锅失败');
  eq(out.itemId, 0, '失败无产出');
  ok(out.reason.includes('浇灭'), `失败原因:${out.reason}`);

  const empty = cookSoup({ inputs: {} });
  eq(empty.ok, false, '空投料失败');
  ok(empty.reason.includes('空'), `失败原因:${empty.reason}`);

  const short = cookSoup({ inputs: { 104: 1, 121: 2 } });
  eq(short.ok, false, '投料不足失败');
  eq(short.buff, null, '失败无 buff 结构');
  eq(short.reason.length > 0, true, '失败给出可读原因');
});

test('212 大铁铲:灭火并给料理额外 +1 条战斗词条', () => {
  eq(SHOVEL_BONUS_KEYWORDS, 1, '212 额外 +1 条战斗词条');
  const plain = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2 } });
  eq(plain.bonusKeywords.length, 0, '不用铲子无额外词条');
  const shoveled = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2 }, shovelUsed: true });
  eq(shoveled.bonusKeywords.length, 1, '用铲子后 +1 条词条');
  eq(shoveled.buff!.flags[`kw_${shoveled.bonusKeywords[0]}`] !== undefined, true, '词条写入 buff.flags');

  /* 626 金牌大厨高高帽:时长翻倍 */
  const chef = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2 }, chefHat: true });
  eq(chef.durationSec, 1200, '626 使 600 秒 → 1200 秒');
  eq(chef.buff!.durationSec, 1200, 'buff 结构同步翻倍');

  /* 212 灭火:3 格内火格强度归零 */
  const cells = [{ x: 1, y: 0, intensity: 0.9 }, { x: 2.9, y: 0, intensity: 0.5 }, { x: 3.5, y: 0, intensity: 0.7 }];
  const res = extinguishFire(cells, 0, 0);
  eq(res.extinguished, 2, '3 格内 2 处熄灭');
  eq(res.cells[1].intensity, 0, '边界内熄灭');
  eq(res.cells[2].intensity, 0.7, '边界外保持');
});

test('料理 buff 计时、合并与整蛊净化(612)', () => {
  const soup = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2 } });
  let buff = soup.buff!;
  const t1 = tickFoodBuff(buff, 100);
  near(t1.buff.remainingSec, 500, 1e-9, '100 秒后剩 500');
  eq(t1.expired, false);
  const t2 = tickFoodBuff(t1.buff, 600);
  eq(t2.buff.remainingSec, 0, '时长耗尽归零');
  eq(t2.expired, true, '到期标记');

  const atkBuff = cookSoup({ inputs: { 104: 1, 124: 2, 121: 2, 126: 2 } }).buff!;
  const merged = mergeFoodBuffs([buff, atkBuff]);
  near(merged.atkMul, 1.0 * 1.25, 1e-9, '攻击乘区相乘');
  near(merged.jumpMul, 1.50, 1e-9, '跳跃乘区保留');

  const kept = cleansePrankBuffs([buff, atkBuff]);
  eq(kept.length, 1, '612 净化后只剩非整蛊 buff');
  eq(kept[0].branch, CookBranch.NORMAL, '保留的是正常料理');
});

/* ═══════════════════════ 七、Boss 祭品与目标档案 ═══════════════════════ */

test('734-741 八件祭品与 bosses.ts 的 summonItem 一一对应', () => {
  eq(BOSS_LIST.length, 8, '世界 Boss 8 个');
  let matched = 0;
  for (let id = 734; id <= 741; id += 1) {
    const entry = COMBAT_ITEM_INDEX.get(id)!;
    eq(entry.kind, 'OFFERING', `祭品 ${id} 分类`);
    const boss = BOSS_LIST.find((b) => b.summonItem === id);
    ok(boss !== undefined, `祭品 ${id} 应对应某个 Boss`);
    eq(entry.ref, boss!.id, `祭品 ${id} 指向 ${boss!.id}`);
    ok(entry.note.includes(String(boss!.baseHp)), `祭品 ${id} 标注 Boss 血量`);
    matched += 1;
  }
  eq(matched, 8, '8 件祭品全部闭合');
});

test('createTarget / targetFromStats:受击方档案可直接由战斗面板生成', () => {
  const stats = combatantStats(30, [728, 721]);
  const t = targetFromStats(stats, { id: 'p', name: '重装玩家' });
  eq(t.maxHp, stats.maxHp, '生命上限取自面板');
  eq(t.hp, stats.maxHp, '初始满血');
  eq(t.def, stats.def, '防御取自面板');
  eq(t.dmgReduce, stats.dmgReduce, '词条减伤取自面板');
  eq(t.reflectMul, stats.reflectMul, '反伤倍率取自面板');
  ok(t.reflectMul >= 1.5, `721+728 套装反伤 ${t.reflectMul} 至少 150%`);

  const brittle = createTarget({ id: 'b', name: '脆皮', hp: 10, maxHp: 10 });
  eq(brittle.shieldMax, 0, '无护盾时 shieldMax 为 0');
  eq(shieldPercent(brittle), 0, '无护盾时护盾条比例为 0');
  const shielded = createTarget({ id: 's', name: '护盾怪', hp: 100, maxHp: 100, shield: 60 });
  eq(shielded.shieldMax, 60, '自动补写 shieldMax');
  eq(shieldPercent(shielded), 1.0, '满护盾比例 1.0');
  eq(shieldPercent({ ...shielded, shield: 30 }), 0.5, '半护盾 0.5');
});

/* ───────────────────────── 收尾 ───────────────────────── */

report('WS-10');
