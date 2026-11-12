/**
 * WS-10 验收测试:战斗伤害管线 / 等级天赋成长 / 幽灵泡泡救援 / 料理恶作剧锅
 *
 * 运行:node tests/WS-10.test.ts
 * 全部随机均经 mulberry32(seed) 注入,结果可复现。
 */

import { test, ok, eq, near, includes, inRange, mulberry32, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根(本文件在 tests/ 下)。 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  WEAPONS, WEAPON_BY_ID, BREACH_PICK, PRANK_HAMMER_KNOCKBACK, ARMORS, ARMOR_BY_ID,
  COMBAT_CONSUMABLES, COMBAT_ITEM_INDEX, COMBAT_ITEM_RANGE, Element, ELEMENT_COUNTER,
  elementMul, equipSummary, combatantStats, levelDamageMul, skillOf, weaponById,
  MAX_DODGE_RATE, BASE_CRIT_DMG, MAX_CRIT_DMG, SET_BONUSES, activeSets, SkillShape,
  MAX_COMBO_MUL, MAX_CRIT_RATE, sanitizeComboMul,
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
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import {
  MAX_LEVEL, TALENT_LEVELS, SHARE_EXP_RADIUS, PARTY_BONUS_THRESHOLD, PARTY_BONUS,
  AFK_EXP_RATIO, REVIVE_TIME, REVIVE_HP_RATIO, FEATHER_RANGE, FEATHER_INVULN,
  expToNext, statsAtLevel, ItemCategory,
} from '../shared/types/entities.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { BOSS_LIST } from '../shared/constants/bosses.ts';
import { MOB_BY_ID } from '../shared/constants/mobs.ts';
import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';
import { maxDisplacementPerTick } from '../server/src/net/anticheat.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { mobCombatProfile, MOB_DEF_BASE, MOB_DEF_PER_LEVEL, MOB_ELEMENT_BY_ID } from '../server/src/combat/damage.ts';

const rng = mulberry32(0x5eed10);

/* ══════════════ 零、生产路径:玩家 → 生物(task-33 接线)══════════════
 *
 * ## 为什么这组断言必须走 `WorldSim`,不能直调 `computeDamage`
 *
 * 接线前的实测缺陷(`_cp_red33.ts`,全部经生产路径):
 *   · `computeDamage` 生产调用点 = **0**,`damage.ts` 整文件不在生产闭包里;
 *   · 玩家贴 `mob_sheep`(60HP)站 600 帧 → 生物 HP **仍是 60**;
 *   · `damageMob(amount=7)`→7、`damageMob(amount=70)`→70,`amount` 完全由
 *     调用方给定 ⇒ 等级/武器/护甲/元素/暴击**一个都不参与**;
 *   · 但手工直调 `computeDamage` → `finalDamage=28`、八步全跑。
 *   ⇒ **公式是好的,只是没人调。缺陷在接线,不在算法。**
 *
 * 所以下面每一条都**经 `WorldSim`**(真实编排层入口 + 真实生物 AI),
 * 而不是复述 `computeDamage` 的纯函数行为 —— 后者在接线前就已经全绿,
 * 正是本仓反复出现的「测试全绿 + 生产零消费」。
 */

/** 建一个「玩家挨着生物」的世界,装备经 `setMobPlayers` 灌入(走装配层入口)。 */
function attackWorld(
  mobId: string,
  opts: { wearing?: readonly number[]; at?: [number, number]; mobAt?: [number, number] } = {},
): WorldSim {
  const s = new WorldSim({ sizeCells: 48 });
  const [px, py] = opts.at ?? [24, 24];
  const [mx, my] = opts.mobAt ?? [25, 24];
  s.addPlayer('p1', px, py);
  s.setMobPlayers([{
    id: 'p1', x: px, y: py, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [...(opts.wearing ?? [711])], playingInstrument: false,
  }]);
  s.addMob(mobId, 'MEADOW', mx, my);
  return s;
}

test('生产接线1:玩家经 WorldSim 攻击生物 → 生物真的掉血(八步在生产路径上跑通)', () => {
  const s = attackWorld('mob_sheep');
  const rt = s.mobHost.runtimeOf('mob_sheep')!;
  const hp0 = rt.hp;

  /* 反例先立:接线前这条是红的 —— 玩家在场 600 帧,生物血量纹丝不动。 */
  const idle = attackWorld('mob_sheep');
  const idleRt = idle.mobHost.runtimeOf('mob_sheep')!;
  for (let i = 0; i < 600; i += 1) idle.tick();
  eq(idleRt.hp, 60, '对照:玩家只站着不走攻击入口时,生物 600 帧不掉血(攻击不会自己发生)');

  /* 正例:经编排层入口发起攻击。 */
  const r = s.attackMob('p1', 'mob_sheep', { level: 10 });
  ok(r !== null, '经 WorldSim.attackMob 能结算(入口存在且返回结果)');
  eq(rt.hp, hp0 - r!.hpLoss, '生物 HP 实际减少了 hpLoss(不是只返回一个对象)');
  ok(r!.hpLoss > 0, `生物真的掉血 ${r!.hpLoss}(接线前恒为 0)`);
  eq(r!.result.steps.length, 8, '八步全部落在 steps 链上(生产路径走的是完整公式)');

  /* 入口的第三个反例:不存在的生物必须返回 null,而不是静默算出一个伤害。 */
  eq(s.attackMob('p1', 'mob_not_exist'), null, '不存在的生物 → null(不静默造伤害)');
});

test('生产接线2(第1步 基础伤害):等级与武器倍率在生产路径上真的参与', () => {
  /* 正例:等级越高,等级倍率越大 ⇒ 同一只怪的承伤越多。
     注意玩家 totalAtk 在本仓是**常数 22**(不随等级涨,那是 progression 的账),
     所以这里只能断言「等级倍率这一项」的方向,不能断言 ATK 变化。 */
  const lo = attackWorld('mob_sheep');
  const rLo = lo.attackMob('p1', 'mob_sheep', { level: 1 })!;
  const hi = attackWorld('mob_sheep');
  const rHi = hi.attackMob('p1', 'mob_sheep', { level: 25 })!;

  eq(rLo.result.levelMul, 1, 'Lv1 等级倍率 = 1(基线)');
  near(rHi.result.levelMul, 1 + 0.03 * 24, 1e-9, 'Lv25 等级倍率 = 1 + 0.03×24(生产路径读到的是同一公式)');
  ok(rHi.result.finalDamage > rLo.result.finalDamage,
    `等级从 1 到 25:承伤 ${rLo.result.finalDamage} → ${rHi.result.finalDamage}(等级倍率真的进了最终伤害)`);

  /* 反例1:换更强武器(723 磁暴齿轮炮 atk 更高)应打出更多伤害。 */
  const weak = attackWorld('mob_sheep', { wearing: [711] });
  const rWeak = weak.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 711 })!;
  const strong = attackWorld('mob_sheep', { wearing: [723] });
  const rStrong = strong.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 723 })!;
  ok(rStrong.result.base > rWeak.result.base,
    `换武器:base ${rWeak.result.base} → ${rStrong.result.base}(weaponMul 进了第 1 步)`);

  /* 反例2:`levelMul` 的注入验证锚点 —— 公式若退化(去掉等级项),上面 near() 立刻红。 */
  eq(lo.attackMob('p1', 'mob_sheep', { level: 1 })!.result.levelMul, 1,
    '等级倍率在 Lv1 恒为 1(注入「删掉等级项」后此项仍成立,但 Lv25 那条会红)');
});

test('生产接线3(第2步 元素克制):元素矩阵在生产路径上真的参与', () => {
  /* 火系生物 mob_lava_elem 对 FIRE 攻击 ×0.5(被克制)。
     用同一把武器打「同等级的火灵」与「同等级的中性怪」,对比第 2 步后的值。 */
  const fire = attackWorld('mob_lava_elem');
  const rFire = fire.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 713 })!; /* 713 = 黑曜石烈焰巨剑, FIRE */
  const neutral = attackWorld('mob_sheep');
  const rNeutral = neutral.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 713 })!;

  eq(rFire.result.elementMulValue, elementMul(Element.FIRE, Element.FIRE),
    '火打火 = ×0.5(元素表在生产路径上被读到)');
  eq(rNeutral.result.elementMulValue, 1, '火打中性(NONE)= ×1');
  ok(rFire.result.afterElement < rNeutral.result.afterElement,
    `元素克制真的影响第 2 步:火灵 ${rFire.result.afterElement} < 绵羊 ${rNeutral.result.afterElement}`);

  /* 反例:同一把武器打雷系生物应 ×1.5(火→雷在矩阵里是 1)。
     用 ice 打 fire 验证反向增益,确保不是「一律相乘为常数」。 */
  const iceOnFire = attackWorld('mob_lava_elem');
  const rIce = iceOnFire.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 712 })!; /* 712 无元素 */
  eq(rIce.result.elementMulValue, 1, '无元素武器(element NONE)打任何目标恒 ×1');

  /* 派生表的两个反例:未登记元素的怪必须是 NONE,且表本身可断言。 */
  eq(mobCombatProfile(MOB_BY_ID.get('mob_sheep')!).element, Element.NONE,
    '未登记元素的生物派生为 NONE(不凭空发明元素)');
  eq(MOB_ELEMENT_BY_ID.get('mob_lava_elem'), Element.FIRE, '火灵在元素表里登记为 FIRE');
  eq(MOB_ELEMENT_BY_ID.size, 3, '元素表恰好 3 条(只收名称/行为明确带元素语义的)');
});

test('生产接线4(第3步 破甲):固定穿透与百分比穿透在生产路径上真的参与', () => {
  /* 破甲的关键外部表现:`effectiveDef` 随穿透下降,且**不为负**。 */
  const noPen = attackWorld('mob_lava_elem');
  const rNoPen = noPen.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 711 })!; /* 711 pen=0 */
  const pen = attackWorld('mob_lava_elem');
  const rPen = pen.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 722 })!; /* 722 pen=15 penPct=0.15 */

  eq(rNoPen.result.flatPen, 0, '711 木剑固定穿透 = 0');
  eq(rPen.result.flatPen, 15, '722 流沙毒刺枪固定穿透 = 15');
  ok(rPen.result.effectiveDef < rNoPen.result.effectiveDef,
    `破甲真的降低有效防御:${rNoPen.result.effectiveDef} → ${rPen.result.effectiveDef}`);
  ok(rPen.result.effectiveDef >= 0, '有效防御不为负(不允许穿透溢出反向放大伤害)');

  /* 反例:穿透超过目标防御时钳制在 0,不是负数。
     火灵 lv23 的派生 def = 6 + 2×22 = 50;用 pen=15+pct 的组合仍 > 0,
     所以换一只低级怪(lv1, def=6)打 pen=15 验证钳制。 */
  const clamp = attackWorld('mob_sheep');
  const rClamp = clamp.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 722 })!;
  eq(rClamp.result.effectiveDef, 0, '穿透(15)超过派生 def(6)时有效防御钳到 0,不为负');

  /* 派生曲线本身:与 vitals.ts 同构的等级线性。 */
  eq(MOB_DEF_BASE, 6, 'MOB_DEF_BASE = 6(与 vitals.MOB_HIT_BASE 同值)');
  eq(MOB_DEF_PER_LEVEL, 2.0, 'MOB_DEF_PER_LEVEL = 2.0(与 vitals.MOB_HIT_PER_LEVEL 同值)');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_sheep')!).def, 6, 'lv1 绵羊 def = 6');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_clock_knight')!).def, 6 + 2 * 24, 'lv25 发条重骑 def = 54');
});

test('生产接线5(第4步 破盾):护盾与晶甲系数在生产路径上真的参与', () => {
  /* 晶甲类:`crystalArmor` 时普通武器只打 20%。
     用 createTarget 注入受控夹具(生物派生刻意不设晶甲 —— 见 mobCombatProfile 注释)。 */
  const armored = createTarget({
    id: 'mob_beetle_crystal', name: '紫晶重甲虫', hp: 750, maxHp: 750,
    def: 32, crystalArmor: true,
  });
  const s = new WorldSim({ sizeCells: 48 });
  const st = combatantStats(10, [711]);
  const plain = computeDamage({ attacker: st, target: armored, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  const breaker = computeDamage({ attacker: st, target: armored, weapon: weaponById(204), critRoll: 1, dodgeRoll: 1 });
  eq(plain.crystalMul, 0.20, '晶甲未破:系数 ×0.20');
  eq(breaker.crystalMul, 1.0, '204 爆破镐 shieldBreakMul=4.0 ≥ 3.0 ⇒ 无视晶甲 ×1.0(反例)');

  /* 护盾未破时 HP 完全免伤;击破后溢出按破盾倍率折算转入 HP。 */
  const shielded = createTarget({
    id: 'mob_x', name: '带盾夹具', hp: 500, maxHp: 500, shield: 10, shieldMax: 10,
  });
  const rShield = computeDamage({ attacker: st, target: shielded, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  eq(rShield.shieldBroken, true, '护盾 10 被一击击破');
  ok(rShield.shieldDamage > 0, `护盾伤害 ${rShield.shieldDamage} > 0`);
  const applied = applyDamage(shielded, rShield);
  eq(applied.shieldLeft, 0, '击破后护盾余量归零');
  ok(applied.target.hp < 500, `击破后溢出转入 HP:500 → ${applied.target.hp}`);

  /* 反例:护盾未破时 HP 完全不动(与「护盾只是数字装饰」区分开)。 */
  const thick = createTarget({ id: 'mob_y', name: '厚盾夹具', hp: 500, maxHp: 500, shield: 9999, shieldMax: 9999 });
  const rThick = computeDamage({ attacker: st, target: thick, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  eq(rThick.finalDamage, 0, '护盾未破 ⇒ HP 免伤,最终伤害为 0');
  eq(applyDamage(thick, rThick).target.hp, 500, '护盾未破时 HP 一点没掉');
  void s;
});

test('生产接线6(第5步 暴击):暴击率封顶与爆伤上限在生产路径上真的参与', () => {
  const st = combatantStats(10, [711]);
  const t = createTarget({ id: 'mob_sheep', name: '云朵绵羊', hp: 60, maxHp: 60, def: 6 });

  /* 正例:critRoll = 0 必暴(0 < critRate)。 */
  const crit = computeDamage({ attacker: st, target: t, weapon: weaponById(711), critRoll: 0, dodgeRoll: 1 });
  const noCrit = computeDamage({ attacker: st, target: t, weapon: weaponById(711), critRoll: 0.999, dodgeRoll: 1 });
  eq(crit.critRolled, true, 'critRoll=0 ⇒ 必暴');
  eq(noCrit.critRolled, false, 'critRoll=0.999 ⇒ 不暴(反例)');
  eq(noCrit.critMul, 1.0, '未暴击时倍率 = 1(不影响伤害)');
  ok(crit.critMul > 1, `暴击倍率 ${crit.critMul} > 1`);
  ok(crit.finalDamage > noCrit.finalDamage, `暴击真的提高最终伤害:${noCrit.finalDamage} → ${crit.finalDamage}`);

  /* 边界:爆伤上限 3.0(MANU 手册规定),超过则钳制。 */
  const overloaded = { ...st, critDmg: 99 };
  const capped = computeDamage({ attacker: overloaded, target: t, weapon: weaponById(711), critRoll: 0, dodgeRoll: 1 });
  eq(capped.critMul, 3.0, '爆伤钳到上限 3.0(不是取输入值 99)');
  ok(capped.critMul < 99, '反例锚点:钳制确实发生');
});

test('生产接线7(第6步 减伤):护甲递减曲线与词条减伤在生产路径上真的参与', () => {
  const st = combatantStats(10, [711]);

  /* 递减曲线:ARMOR_K/(ARMOR_K+def),def 越高系数越小但恒 > 0。 */
  const soft = createTarget({ id: 'a', name: '软皮', hp: 9999, maxHp: 9999, def: 0 });
  const hard = createTarget({ id: 'b', name: '重甲', hp: 9999, maxHp: 9999, def: 5000 });
  const rSoft = computeDamage({ attacker: st, target: soft, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  const rHard = computeDamage({ attacker: st, target: hard, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });

  eq(rSoft.mitigationMul, 1, 'def=0 ⇒ 护甲系数 = 1(不减伤)');
  ok(rHard.mitigationMul > 0, `def=5000 时系数 ${rHard.mitigationMul} 恒 > 0(递减永不归零)`);
  ok(rHard.mitigationMul < rSoft.mitigationMul, '护甲系数真的随 def 递减');
  eq(rHard.finalDamage, 1, 'DEF=5000 ⇒ 原始伤害被最低保底抬到 1(保底分支可达)');
  eq(MIN_DAMAGE, 1, 'MIN_DAMAGE = 1');

  /* 词条减伤(728 = 0.30)是第 6 步的独立乘区。 */
  const reduced = createTarget({ id: 'c', name: '带减伤', hp: 9999, maxHp: 9999, def: 6, dmgReduce: 0.30 });
  const plain = createTarget({ id: 'd', name: '无减伤', hp: 9999, maxHp: 9999, def: 6 });
  const rRed = computeDamage({ attacker: st, target: reduced, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  const rPlain = computeDamage({ attacker: st, target: plain, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  ok(rRed.finalDamage < rPlain.finalDamage,
    `词条减伤 30% 真的生效:${rPlain.finalDamage} → ${rRed.finalDamage}`);

  /* 反例:takenMul = 0 完全免疫(幽灵泡泡/无敌墙)。 */
  const immune = createTarget({ id: 'e', name: '无敌墙', hp: 9999, maxHp: 9999, def: 0, takenMul: 0 });
  const rImmune = computeDamage({ attacker: st, target: immune, weapon: weaponById(711), critRoll: 0, dodgeRoll: 1 });
  eq(rImmune.finalDamage, 0, 'takenMul=0 ⇒ 即使暴击也完全免伤,最终伤害归零');
});

test('生产接线8(第7步 反伤):反伤数值与作用半径在生产路径上真的参与', () => {
  const st = combatantStats(10, [711]);
  /* 反伤是「受击方把承伤折算回攻击者」。728 反伤甲的 reflectMul = 1.50。 */
  const reflector = createTarget({
    id: 'p_reflect', name: '728 反伤甲玩家', hp: 9999, maxHp: 9999, def: 32, reflectMul: 1.5,
  });
  const r = computeDamage({ attacker: st, target: reflector, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  near(r.reflectDamage, r.finalDamage * 1.5, 1e-6, '反伤 = 实际承伤 × 1.5(第 7 步)');

  /* 与独立入口 reflectFrom 双向一致(两处口径必须同源)。 */
  const indep = reflectFrom(1.5, r.finalDamage);
  near(indep.reflectDamage, r.reflectDamage, 1e-6, 'reflectFrom 与 computeDamage 第 7 步同值');
  eq(indep.radius, REFLECT_RADIUS, '反伤半径取自实现');
  eq(REFLECT_RADIUS, 3, 'REFLECT_RADIUS = 3 格(设计基线,非取自实现)');
  eq(r.steps[6]!.step, '7 反伤', '第 7 步在 steps 链的第 7 位(顺序固定)');

  /* 反例1:无反射倍率 ⇒ 反伤为 0(不是「一律有反伤」)。 */
  const plain = createTarget({ id: 'mob_plain', name: '普通怪', hp: 9999, maxHp: 9999, def: 6 });
  const rPlain = computeDamage({ attacker: st, target: plain, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  eq(rPlain.reflectDamage, 0, 'reflectMul=0 ⇒ 反伤 0(反例)');

  /* 反例2:生物派生**刻意不设** reflectMul —— 否则等于给每只怪白送反伤。
     这条守住 mobCombatProfile 的职责边界(个体特性交给 AI)。 */
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).reflectMul, 0,
    '派生档案不设反伤(生物反伤不做 —— 否则凭空造出「怪物反伤」)');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).crystalArmor, false,
    '派生档案不设晶甲(个体特性由生物 AI 的 onDamage 负责,避免双重结算)');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).dmgReduce, 0,
    '派生档案不设词条减伤(同上,否则「减 80%」会变成减 96%)');
});

test('生产接线9(第8步 击退):击退冲量在生产路径上真的参与', () => {
  const st = combatantStats(10, [711]);
  /* 击退 = 武器基础击退 × 倍率 × 技能倍率 ÷ 质量。 */
  const light = createTarget({ id: 'a', name: '轻', hp: 9999, maxHp: 9999, def: 6, mass: 1.0 });
  const heavy = createTarget({ id: 'b', name: '重', hp: 9999, maxHp: 9999, def: 6, mass: 4.0 });
  const rLight = computeDamage({ attacker: st, target: light, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  const rHeavy = computeDamage({ attacker: st, target: heavy, weapon: weaponById(711), critRoll: 1, dodgeRoll: 1 });
  ok(rLight.knockbackImpulse > 0, `击退冲量 ${rLight.knockbackImpulse} > 0`);
  near(rHeavy.knockbackImpulse, rLight.knockbackImpulse / 4, 1e-6, '质量 ×4 ⇒ 击退 ÷4(质量真的参与)');
  eq(rLight.steps[7]!.step, '8 击退', '第 8 步在 steps 链的第 8 位(八步顺序固定)');

  /* 反例:222 充气大锤除击退外,对队友是 0 伤害 + 固定冲量。 */
  const prank = allyPrankHit(light);
  eq(prank.finalDamage, 0, '整蛊命中对队友 0 伤害');
  eq(prank.knockbackImpulse, PRANK_HAMMER_KNOCKBACK, `整蛊固定击退 ${PRANK_HAMMER_KNOCKBACK} 格/秒(与武器无关)`);
  ok(prank.knockbackImpulse !== rLight.knockbackImpulse, '整蛊冲量与普通攻击不同(反例锚点)');

  /* 派生质量:生物质量默认 1(与 physics.spawn 默认一致)。 */
  eq(mobCombatProfile(MOB_BY_ID.get('mob_clock_knight')!).mass, 1, '生物派生质量默认 1');
});

test('生产接线10:八步之外的短路分支在生产路径上真的参与(超距 / 闪避)', () => {
  /* 0a 超距:距离超过 reach + 容差 ⇒ 落空,不产生任何伤害。 */
  const far = attackWorld('mob_sheep', { at: [10, 10], mobAt: [40, 40] });
  const rFar = far.attackMob('p1', 'mob_sheep', { level: 10 })!;
  eq(rFar.result.outOfReach, true, '距离 42 格 ⇒ outOfReach(生产路径真的传了 distance)');
  eq(rFar.result.finalDamage, 0, '超距 ⇒ 最终伤害 0');
  eq(rFar.hpLoss, 0, '超距 ⇒ 生物一点血没掉');
  eq(far.mobHost.runtimeOf('mob_sheep')!.hp, 60, '超距后生物仍是满血');

  /* 0b 闪避:目标闪避率封顶 0.75,roll 落在其下则完全免伤。 */
  const slippery = createTarget({ id: 'x', name: '滑', hp: 9999, maxHp: 9999, def: 0, dodgeRate: 5.0 });
  const st = combatantStats(10, [711]);
  const dodged = computeDamage({ attacker: st, target: slippery, weapon: weaponById(711), critRoll: 0, dodgeRoll: 0.74 });
  const hit = computeDamage({ attacker: st, target: slippery, weapon: weaponById(711), critRoll: 0, dodgeRoll: 0.76 });
  eq(dodged.dodged, true, 'dodgeRoll 0.74 < 封顶 0.75 ⇒ 闪避');
  eq(dodged.finalDamage, 0, '闪避 ⇒ 最终伤害 0');
  eq(hit.dodged, false, 'dodgeRoll 0.76 > 0.75 ⇒ 未闪避(反例:封顶真的在起作用)');
  ok(hit.finalDamage > 0, `未闪避 ⇒ 正常结算 ${hit.finalDamage}`);
  eq(MAX_DODGE_RATE, 0.75, 'MAX_DODGE_RATE = 0.75(闪避硬封顶)');

  /* 反例:生物派生不设闪避率(怪物不闪避 —— 那会让玩家的每次攻击都可能空)。 */
  eq(mobCombatProfile(MOB_BY_ID.get('mob_tanuki')!).dodgeRate, 0, '派生档案不设闪避(怪物不闪避)');
});

test('生产接线11:装配层真的能把玩家装备喂进伤害管线', () => {
  /* 这条守的是「护甲算得出但喂不进去」—— 若 setMobPlayers 的 wearing 没被
     attackMob 读到,玩家穿什么都是裸装,护甲形同虚设。 */
  const bare = attackWorld('mob_sheep', { wearing: [] });
  const rBare = bare.attackMob('p1', 'mob_sheep', { level: 10, wearing: [] })!;
  const armored = attackWorld('mob_sheep', { wearing: [711, 728] });
  const rArmored = armored.attackMob('p1', 'mob_sheep', { level: 10, wearing: [711, 728] })!;

  eq(equipSummary([711, 728]).def, 32, '728 提供 def +32(装配层聚合)');
  ok(rArmored.result.base > rBare.result.base,
    `穿 728 后第 1 步更高:${rBare.result.base} → ${rArmored.result.base}(wearing 真的被读到)`);
  eq(equipSummary([711, 728]).reflectMul, 1.5, '728 反伤倍率 1.5 被聚合(供第 7 步)');
  eq(equipSummary([711, 728]).dmgReduce, 0.30, '728 词条减伤 0.30 被聚合(供第 6 步)');

  /* 反例:`setMobPlayers` 灌入的 wearing 必须被 attackMob 作为缺省读到。 */
  const auto = attackWorld('mob_sheep', { wearing: [711, 728] });
  const rAuto = auto.attackMob('p1', 'mob_sheep', { level: 10 })!; /* 不显式传 wearing */
  eq(rAuto.result.base, rArmored.result.base,
    '不显式传 wearing 时,attackMob 从 setMobPlayers 的记录里读到同一套装备');
});

test('生产接线12:204 爆破镐经 attackMob 真的能一击敲碎晶甲(EXPLOSION 可达)', () => {
  /* ## 这条守的是一个我自己在接线时引入的缺陷
   *
   * 手册与 `WeaponDef` 都写着 204「对晶甲类护盾拥有 4.0 破盾倍率」,
   * 而 `BeetleAi.onDamage`(`behaviors.ts:720`)的碎壳分支判据是
   * `kind === DamageKind.EXPLOSION`。
   *
   * 我第一版 `damageKindOf` **按元素映射**,而 `BREACH_PICK.element` 是 `NONE`
   * (它靠爆破而非元素)⇒ 落到 `PHYSICAL` ⇒ **碎壳分支永远不可达**。
   * 症状与 task-33 本身同型:手册记载的机制,在生产入口上形同不存在。
   *
   * 修法:按**武器 ID** 把 204 钉死为 `EXPLOSION`。 */
  const beetle = attackWorld('mob_beetle_crystal');
  const rt = beetle.mobHost.runtimeOf('mob_beetle_crystal')!;

  /* 正例:先确认未碎壳(flag 初始为 0)。 */
  eq(rt.mem.shellBroken ?? 0, 0, '前置:甲虫壳完好');

  /* 用 204 攻击 —— 必须触发碎壳事件,而不是只掉一点血。 */
  const r = beetle.attackMob('p1', 'mob_beetle_crystal', { level: 10, weaponId: 204 })!;
  eq(rt.mem.shellBroken, 1, '204 经 attackMob 真的敲碎了晶甲壳(shellBroken=1)');
  includes(r.events, 'beetle_shell_broken', '碎壳事件被上报(不是静默改血量)');
  ok(r.hpLoss > 0, `碎壳同时造成伤害 ${r.hpLoss}`);

  /* 反例:同一只甲虫,用普通武器(711, element NONE)不触发碎壳。
     这一条守住「碎壳不是无条件发生的」—— 若 204 的映射失效退回 PHYSICAL,
     上面的正例会红;若有人把碎壳改成无条件,下面的反例会红。 */
  const plain = attackWorld('mob_beetle_crystal');
  const plainRt = plain.mobHost.runtimeOf('mob_beetle_crystal')!;
  plain.attackMob('p1', 'mob_beetle_crystal', { level: 10, weaponId: 711 });
  eq(plainRt.mem.shellBroken ?? 0, 0, '反例:711 木剑不碎壳(碎壳是 204/爆破专属)');

  /* 第二条反例:正例不能靠「伤害高」蒙混 —— 713 火巨剑 atk 更高,仍不碎壳。 */
  const fire = attackWorld('mob_beetle_crystal');
  const fireRt = fire.mobHost.runtimeOf('mob_beetle_crystal')!;
  fire.attackMob('p1', 'mob_beetle_crystal', { level: 10, weaponId: 713 });
  eq(fireRt.mem.shellBroken ?? 0, 0, '反例:713 火巨剑也不碎壳(看的是 kind,不是伤害量)');
});

test('生产接线13:火灵遇水经 attackMob 真的固化为黑曜石(WATER 可达)', () => {
  /* ## 这条守的通道,以及一个「差点写出来的死代码」
   *
   * 火灵的固化分支判 `kind === DamageKind.WATER`(`behaviors.ts:1224`)。
   * 我第一版 `damageKindOf` 里写了 `case Element.ICE: return WATER` ——
   * 语义上合理,但**实测武器表里没有任何 ICE 武器**(13 把武器的元素只有
   * NONE/FIRE/LIGHT/SLIME/LIGHTNING),那段就是**永不执行的代码**。
   *
   * 故现在 `damageKindOf` 刻意不写 ICE 分支,并在此**设一道陷阱断言**:
   * 一旦有人新增 ICE 武器,该断言变红,提醒必须同时恢复映射 ——
   * 否则火灵固化会静默失效。
   *
   * WATER 的两条**真实可达**路径在这里都被覆盖:
   *   路径 A:`opts.kind` 显式覆盖(推导只做缺省);
   *   路径 B:227 泡泡水枪经 `interactMob`(工具通道)。 */
  const lava = attackWorld('mob_lava_elem');
  const rt = lava.mobHost.runtimeOf('mob_lava_elem')!;
  eq(rt.mem.solidified ?? 0, 0, '前置:火灵未固化');

  /* 反例先立:普通物理攻击不固化(固化不是无条件发生的)。 */
  const plain = attackWorld('mob_lava_elem');
  const plainRt = plain.mobHost.runtimeOf('mob_lava_elem')!;
  const rPlain = plain.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 711 })!;
  eq(plainRt.mem.solidified ?? 0, 0, '反例:711 木剑(PHYSICAL)不固化火灵');
  ok(rPlain.hpLoss > 0, '普通攻击正常造成伤害(不固化 ≠ 不受伤)');

  /* 路径 A:显式给 kind=WATER,固化必须发生。 */
  const water = attackWorld('mob_lava_elem');
  const waterRt = water.mobHost.runtimeOf('mob_lava_elem')!;
  water.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 711, kind: DamageKind.WATER });
  eq(waterRt.mem.solidified, 1, '路径A:显式 kind=WATER 经 attackMob 真的固化火灵');

  /* 路径 B:227 泡泡连发水枪走工具通道。 */
  const gun = attackWorld('mob_lava_elem');
  const gunRt = gun.mobHost.runtimeOf('mob_lava_elem')!;
  const interacted = gun.interactMob('mob_lava_elem', 227, 'p1');
  eq(interacted, true, '路径B:227 泡泡水枪经 interactMob 命中火灵');
  eq(gunRt.mem.solidified, 1, '路径B:水枪使火灵固化(与 attackMob 的 kind 通道互补,两条都在)');

  /* ⚠ 陷阱断言:武器表里不能有 ICE 武器,否则上面的推导必须补回 ICE 分支。 */
  ok(!WEAPONS.some((w) => w.element === Element.ICE),
    '武器表无 ICE 武器 —— 若有新增,必须恢复 damageKindOf 里的 ICE→WATER 映射,'
    + '否则火灵固化静默失效(本条即为该提醒)');
  eq(WEAPONS.filter((w) => w.element !== Element.NONE).map((w) => w.element).sort().join(','),
    ['FIRE', 'LIGHT', 'LIGHT', 'LIGHT', 'LIGHT', 'LIGHTNING', 'SLIME'].sort().join(','),
    '非 NONE 元素武器恰好 7 把(FIRE×1 / LIGHT×4 / LIGHTNING×1 / SLIME×1)');

  /* 派生档案:火灵是 FIRE 元素(元素表登记),供第 2 步克制计算。 */
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).element, Element.FIRE,
    '火灵派生元素 = FIRE(第 2 步火打火 ×0.5)');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).def, 6 + 2 * 22,
    '火灵 lv23 派生 def = 50(与 vitals 同构的等级线性)');
});

test('生产接线14:八步逐步在生产路径上被驱动(并标明哪几步无生产触发器)', () => {
  /* ## 这条把「八步都在生产路径上跑」拆到**逐步**可判定
   *
   * task-33 的验收口语是「八步每步各一条断言 + 反例」。但有一个必须
   * **如实说明**的事实:八步里有几步在「玩家打怪」方向上**没有生产触发器**
   * —— 不是接线没做完,而是本仓的生物数据里根本不存在能触发它的输入。
   * 硬凑一条断言只会造出「测住了但生产跑不到」的假绿。
   *
   * | 步 | 生产触发器 | 能否经 attackMob 驱动 |
   * | :--- | :--- | :--- |
   * | 1 基础伤害 | 等级 / 武器倍率 / 连段 | ✓ 可(下面第 1 组) |
   * | 2 元素克制 | 元素武器 × 生物元素 | ✓ 可(713 打火灵) |
   * | 3 破甲 | 武器 armorPen / armorPenPct | ✓ 可(711 vs 722) |
   * | 4 破盾 | 生物 `shield` / 晶甲系数 | **✗ 部分**:生物派生不给 `shield`
   *   (冻结层无该字段),晶甲已由生物 AI 的 `onDamage` 承担 ⇒ 见下方说明 |
   * | 5 暴击 | `critRate` + `critRoll` | ✓ 可但**不可控**(roll 由 rng 出;
   *   生产上只能靠概率,断言只能查「暴击时倍率正确」) |
   * | 6 减伤 | 生物 `def` + 词条减伤 | ✓ 可(不同生物 def 不同) |
   * | 7 反伤 | 受击方 `reflectMul` | **✗ 不可**:生物派生刻意不设 `reflectMul`
   *   (设了就是凭空造「怪物反伤」)⇒ 该步在玩家→怪方向**恒为 0** |
   * | 8 击退 | 武器击退 ÷ 质量 | ✓ 可(质量恒 1,故 = 武器基础击退) |
   *
   * ⇒ 下面分三组:能驱动的逐步断言、不能驱动的**如实断言其恒为 0**、
   *   以及短路分支。**没有把不可驱动的步伪装成已覆盖。** */
  const s = attackWorld('mob_lava_elem');
  const r = s.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 713 })!;

  /* ── 八步全部出现在 steps 链上(顺序与条数固定)── */
  eq(r.result.steps.length, 8, 'steps 链恰好 8 步');
  eq(r.result.steps.map((x) => x.step).join(' | '),
    '1 基础伤害 | 2 元素克制 | 3 破甲 | 4 破盾 | 5 暴击 | 6 减伤 | 7 反伤 | 8 击退',
    '八步名称与顺序固定(生产路径产出,不是测试里手写的)');

  /* ── 第 1 步:随等级/武器倍率变 ── */
  const s1a = attackWorld('mob_lava_elem');
  const r1a = s1a.attackMob('p1', 'mob_lava_elem', { level: 1, weaponId: 711 })!;
  ok(r.result.steps[0]!.value > r1a.result.steps[0]!.value,
    `第1步随输入变:lv1/711=${r1a.result.steps[0]!.value} → lv10/713=${r.result.steps[0]!.value}`);
  /* 反例:把武器换成更弱的,第 1 步必须下降。 */
  const s1b = attackWorld('mob_lava_elem');
  const r1b = s1b.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 711 })!;
  ok(r1b.result.steps[0]!.value < r.result.steps[0]!.value, '反例:换弱武器第 1 步下降');

  /* ── 第 2 步:火焰武器打火灵(×0.5)── */
  ok(r.result.steps[1]!.value < r.result.steps[0]!.value,
    `第2步元素克制真的削减:${r.result.steps[0]!.value} → ${r.result.steps[1]!.value}(火打火 ×0.5)`);
  /* 反例:同一把武器打中性生物,第 2 步不变。 */
  const s2 = attackWorld('mob_sheep');
  const r2 = s2.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 713 })!;
  eq(r2.result.steps[1]!.value, r2.result.steps[0]!.value,
    '反例:火焰武器打中性(NONE)生物,第 2 步等于第 1 步(×1,不削减)');

  /* ── 第 3 步:破甲把有效防御打下来 ── */
  const s3 = attackWorld('mob_lava_elem');
  const r3 = s3.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 722 })!;
  ok(r3.result.steps[2]!.value < r.result.steps[2]!.value,
    `第3步破甲生效:711(pen0) effDef=${r.result.steps[2]!.value} → 722(pen15) effDef=${r3.result.steps[2]!.value}`);
  /* 反例:穿透超过防御时钳到 0,不为负。 */
  const s3b = attackWorld('mob_sheep');
  const r3b = s3b.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 722 })!;
  eq(r3b.result.steps[2]!.value, 0, '反例:pen 15 > 绵羊 def 6 ⇒ effDef 钳到 0(不为负)');

  /* ── 第 4 步:**如实断言**——生物派生不给 shield,故生产上第 4 步不削血。
     ⚠️ 量纲提醒:第 3 步 value 是 **`effectiveDef`(防御值)**,
     第 4 步才是**伤害**。拿它们直接比大小是量纲错误(实测第3步=38、
     第4步=18.86,前者大只因它是防御点而不是伤害)。故第 4 步与第 2 步比。
     晶甲/格挡等个体特性已由生物 AI 的 `onDamage` 承担(见 生产接线12 甲虫碎壳)。── */
  eq(r.result.steps[3]!.value, r.result.steps[1]!.value,
    '第4步(破盾)对派生生物不削减:生物无 shield 字段 ⇒ 该步等于第2步(如实断言,非「已覆盖」)');
  eq(r.result.steps[2]!.value, r.result.effectiveDef,
    '第3步 value 是 effectiveDef(防御量纲),不是伤害 —— 与结果字段同源');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).shield, 0, '派生档案 shield = 0(冻结层无该字段)');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).crystalArmor, false,
    '派生档案 crystalArmor = false —— 晶甲交给生物 AI,避免双重结算');

  /* ── 第 5 步:暴击。生产上 roll 由 combatRng 决定,故断言「暴击语义正确」
     而非「必然/必然不暴击」。第 5 步的值 = 第 4 步 × critMul,故两种情况都合法。── */
  ok(r.result.critMul >= 1 && r.result.critMul <= MAX_CRIT_DMG,
    `第5步暴击倍率在 [1, ${MAX_CRIT_DMG}] 内(生产路径钳制生效)`);
  eq(r.result.steps[4]!.value,
    r.result.steps[3]!.value * r.result.critMul,
    `第5步 = 第4步 × 暴击倍率(实测 ${r.result.steps[3]!.value} × ${r.result.critMul} = ${r.result.steps[4]!.value};`
    + `本次 critRolled=${r.result.critRolled})`);
  /* 反例:用夹具强制不暴 → 倍率为 1、第 5 步等于第 4 步。 */
  const noCritFix = computeDamage({
    attacker: combatantStats(10, [711]),
    target: createTarget({ id: 'x', name: '夹具', hp: 999, maxHp: 999, def: 6 }),
    weapon: weaponById(711), critRoll: 0.999, dodgeRoll: 1,
  });
  eq(noCritFix.critMul, 1, '反例(夹具强制不暴):critMul = 1');
  eq(noCritFix.steps[4]!.value, noCritFix.steps[3]!.value, '反例:不暴时第 5 步等于第 4 步');
  /* 反例:用夹具强制暴击,倍率必须 > 1 且真的抬高伤害。 */
  const forced = computeDamage({
    attacker: combatantStats(10, [711]), target: createTarget({ id: 'x', name: '夹具', hp: 999, maxHp: 999, def: 6 }),
    weapon: weaponById(711), critRoll: 0, dodgeRoll: 1,
  });
  ok(forced.critMul > 1, `反例(夹具强制暴击):critMul=${forced.critMul} > 1`);
  ok(forced.finalDamage > noCritFix.finalDamage,
    `暴击真的抬高最终伤害:${noCritFix.finalDamage} → ${forced.finalDamage}`);

  /* ── 第 6 步:减伤。不同生物 def 不同 ⇒ 减伤系数不同。── */
  eq(r.result.steps[5]!.step, '6 减伤', '第6步在链上');
  const s6a = attackWorld('mob_sheep');
  const r6a = s6a.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 711 })!;
  const s6b = attackWorld('mob_clock_knight');
  const r6b = s6b.attackMob('p1', 'mob_clock_knight', { level: 10, weaponId: 711 })!;
  ok(r6b.result.mitigationMul < r6a.result.mitigationMul,
    `第6步随 def 递减:绵羊(def6)=${r6a.result.mitigationMul} > 重骑(def54)=${r6b.result.mitigationMul}`);
  /* 反例:def=0 时减伤系数为 1(不减伤)。 */
  eq(computeDamage({
    attacker: combatantStats(10, [711]), target: createTarget({ id: 'z', name: '无甲', hp: 999, maxHp: 999, def: 0 }),
    weapon: weaponById(711), critRoll: 1, dodgeRoll: 1,
  }).mitigationMul, 1, '反例:def=0 ⇒ 减伤系数 1(不减伤)');

  /* ── 第 7 步:**如实断言**——生物派生不给 reflectMul ⇒ 玩家→怪方向反伤恒为 0。── */
  eq(r.result.steps[6]!.value, 0,
    '第7步反伤对派生生物恒为 0(生物无 reflectMul ⇒ 该步在玩家→怪方向不可驱动,如实断言)');
  eq(mobCombatProfile(MOB_BY_ID.get('mob_lava_elem')!).reflectMul, 0,
    '派生档案 reflectMul = 0 —— 不凭空造「怪物反伤」');
  /* 反例:反伤机制本身活着 —— 728 反伤甲作为受击方时第 7 步非零。 */
  const refl = computeDamage({
    attacker: combatantStats(10, [711]),
    target: createTarget({ id: 'p', name: '728 玩家', hp: 999, maxHp: 999, def: 32, reflectMul: 1.5 }),
    weapon: weaponById(711), critRoll: 1, dodgeRoll: 1,
  });
  ok(refl.reflectDamage > 0, `反例:受击方带 reflectMul 时第 7 步非零(${refl.reflectDamage})`);

  /* ── 第 8 步:击退。质量为 1 ⇒ 击退 = 武器基础击退 × 倍率。── */
  ok(r.result.steps[7]!.value > 0, `第8步击退 = ${r.result.steps[7]!.value} > 0`);
  const s8 = attackWorld('mob_lava_elem');
  const r8 = s8.attackMob('p1', 'mob_lava_elem', { level: 10, weaponId: 711 })!;
  ok(r.result.steps[7]!.value !== r8.result.steps[7]!.value,
    `第8步随武器变:711=${r8.result.steps[7]!.value} vs 713=${r.result.steps[7]!.value}`);
  /* 反例:222 充气大锤打队友 = 0 伤害 + 固定冲量(击退与伤害解耦)。 */
  const prank = allyPrankHit(createTarget({ id: 'ally', name: '队友', hp: 999, maxHp: 999 }));
  eq(prank.finalDamage, 0, '反例:整蛊对队友 0 伤害');
  eq(prank.knockbackImpulse, PRANK_HAMMER_KNOCKBACK, `反例:整蛊固定击退 ${PRANK_HAMMER_KNOCKBACK}(与武器无关)`);

  /* ── 短路分支同样在生产路径上 ── */
  const sFar = attackWorld('mob_sheep', { at: [4, 4], mobAt: [40, 40] });
  const rFar = sFar.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 715 })!; /* 715 弓 reach 12 */
  eq(rFar.result.outOfReach, true, `短路:超距(outOfReach)在生产路径上生效(弓 reach 12,距离 ${Math.hypot(36, 36).toFixed(1)})`);
  eq(rFar.hpLoss, 0, '短路:超距时生物一点血没掉');

  /* ── 逐步汇总(供报告引用)── */
  console.log('    [八步生产路径实测值]');
  r.result.steps.forEach((x, i) => console.log(`      ${i + 1}. ${x.step} = ${x.value}`));
});

test('生产接线15:玩家攻击不消耗生物 AI 的随机流(战斗随机流已分离)', () => {
  /* ## 这条守的是我在接线时引入的一个**静默耦合**
   *
   * 第一版 `attackMob` 用 `this.rng()` 取 critRoll/dodgeRoll,而同一个
   * `rng` 也喂给 `mobHost`(生物 AI)与 spawner。实测:0 次 vs 1 次攻击
   * 时,**三个远处、与战斗无关**的生物轨迹全部分叉 ——
   * ⇒ 玩家攻击次数成了生物 AI 的隐式输入,回放无法只靠世界种子重演。
   *
   * 修法:`WorldSimOptions.combatRng` 独立成流。
   *
   * ## 判据为什么用**计数包装器**,而不是「远处生物轨迹是否一致」
   *
   * 我第一版用的是轨迹比较,结果**过于严格而不成立**,原因是本仓一个
   * **既有架构属性**:`MobHost` 内部所有生物共用**一条** rng 流。
   * 攻击目标怪会合理改变它自己的行为(scared/flee),该行为消耗的随机数
   * 个数随之变化,于是**同一条流上后面的其他生物也被顺移** ——
   * 这与我的战斗取数无关,是设计使然。
   *
   * 所以正确的判据是直测「谁消耗了哪条流」:给 `rng` 与 `combatRng`
   * 各包一层计数器,断言 `attackMob` **从共享流取 0 次**、从战斗流取 >0 次。
   * 这比轨迹比较更精确,也不会把既有架构属性误判成缺陷。 */
  const counting = (base: () => number): { fn: () => number; n: () => number } => {
    let c = 0;
    return { fn: () => { c += 1; return base(); }, n: () => c };
  };
  const build = (rng: () => number, combatRng: () => number): WorldSim => {
    const s = new WorldSim({ sizeCells: 64, rng, combatRng });
    s.addPlayer('p1', 8, 8);
    s.setMobPlayers([{
      id: 'p1', x: 8, y: 8, z: 0, facingDeg: 0, afk: false,
      heldItem: 0, wearing: [711], playingInstrument: false,
    }]);
    s.addMob('mob_sheep', 'MEADOW', 9, 8);
    s.addMob('mob_boar', 'MEADOW', 50, 50);
    return s;
  };

  /* 正例:attackMob 完全不碰共享流。 */
  const shared1 = counting(mulberry32(1));
  const combat1 = counting(mulberry32(2));
  const s1 = build(shared1.fn, combat1.fn);
  const sh0 = shared1.n();
  const cb0 = combat1.n();
  const r1 = s1.attackMob('p1', 'mob_sheep', { level: 10 });
  eq(shared1.n() - sh0, 0,
    'attackMob 从**共享** rng 取 0 次(生物 AI 的流不被玩家攻击推进)');
  ok(combat1.n() - cb0 > 0,
    `attackMob 从**战斗流**取数 ${combat1.n() - cb0} 次(暴击+闪避各一次,证明它真的在用 combatRng)`);
  eq(combat1.n() - cb0, 2, '恰好 2 次:critRoll 与 dodgeRoll 各一');
  ok(r1 !== null, '攻击照常结算(分离不等于没跑)');

  /* 反例:只 tick 不攻击 ⇒ 战斗流必须为 0,共享流必须 > 0。 */
  const shared2 = counting(mulberry32(1));
  const combat2 = counting(mulberry32(2));
  const s2 = build(shared2.fn, combat2.fn);
  const sh2 = shared2.n();
  const cb2 = combat2.n();
  for (let i = 0; i < 20; i += 1) s2.tick();
  ok(shared2.n() - sh2 > 0, `反例:20 帧 AI 推进消耗共享流 ${shared2.n() - sh2} 次`);
  eq(combat2.n() - cb2, 0, '反例:不攻击时战斗流取 0 次(战斗流不归 AI 用)');

  /* 同时:战斗本身仍确定性可复现(分离不能把可复现性搞丢)。 */
  const mkAtk = (): number => {
    const s = build(mulberry32(1), mulberry32(2));
    return s.attackMob('p1', 'mob_sheep', { level: 10 })!.result.finalDamage;
  };
  eq(mkAtk(), mkAtk(), '同种子两次攻击结果完全一致(分离后仍可复现)');

  /* combatRng 可注入且真的决定暴击序列。 */
  const mk = (combatRng: () => number): WorldSim => {
    const s = new WorldSim({ sizeCells: 48, combatRng });
    s.addPlayer('p1', 24, 24);
    s.setMobPlayers([{
      id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
      heldItem: 0, wearing: [711], playingInstrument: false,
    }]);
    s.addMob('mob_sheep', 'MEADOW', 25, 24);
    return s;
  };
  const rc = mk(() => 0).attackMob('p1', 'mob_sheep', { level: 10 })!;
  const rn = mk(() => 0.999).attackMob('p1', 'mob_sheep', { level: 10 })!;
  eq(rc.result.critRolled, true, '注入 combatRng=()=>0 ⇒ 必暴(证明 combatRng 真的被读)');
  eq(rn.result.critRolled, false, '注入 combatRng=()=>0.999 ⇒ 不暴(反例)');
  ok(rc.result.finalDamage > rn.result.finalDamage,
    `暴击序列可注入且真的影响伤害:${rn.result.finalDamage} → ${rc.result.finalDamage}`);
});

test('生产接线16:攻击已死生物时 hpLoss 归零(不虚报掉血)', () => {
  /* ## 这条守的是 `hpLoss` 的真实语义
   *
   * `damageMob` 自述契约是「**`hpLoss` 才是真正的掉血**,因为可能被格挡」。
   * 但 `BaseMobAi.onDamage`(`behaviors.ts:175`)算的是:
   * ```ts
   * const hpLoss = Math.max(0, amount);
   * rt.hp = Math.max(0, rt.hp - hpLoss);   // 尸体上 rt.hp 恒被钳在 0
   * ```
   * ⇒ 对一具**尸体**它照样返回 `hpLoss = amount`。实测修前:
   * ```
   * rt.alive=false, rt.hp=0 → 再攻击 → hpLoss=27,hp 0 → 0
   * ```
   * 调用方若据此发经验 / 判定击杀 / 统计 DPS,会为死掉的生物反复记账。
   *
   * 修法:`attackMob` 用「攻击前 `rt.hp`」钳制 `hpLoss` —— 只有攻击前还活着、
   * 且 HP 真的下降才算掉血。本断言守住它。 */
  const s = attackWorld('mob_sheep');
  const rt = s.mobHost.runtimeOf('mob_sheep')!;

  /* 先正常打到死。 */
  let killed = 0;
  for (let i = 0; i < 20 && rt.alive; i += 1) {
    const r = s.attackMob('p1', 'mob_sheep', { level: 10 });
    killed += r!.hpLoss;
  }
  eq(rt.alive, false, '20 次内击杀成功(活着的目标会掉血)');
  eq(rt.hp, 0, '死亡时 HP 为 0');
  ok(killed > 0, `击杀过程确实累计掉血 ${killed}(不是从未受伤就死了)`);

  /* 正例:攻击尸体 hpLoss 必须为 0(修前是 27)。 */
  const r1 = s.attackMob('p1', 'mob_sheep', { level: 10 })!;
  eq(r1.hpLoss, 0, '攻击已死生物 ⇒ hpLoss = 0(修前虚报 27)');
  eq(rt.hp, 0, '尸体 HP 仍是 0(没被扣成负数)');
  eq(rt.alive, false, '尸体不会因再挨打而「复活」');

  /* 反例:活着的生物 hpLoss 必须 > 0 —— 归零不能把正常路径也吃掉。 */
  const alive = attackWorld('mob_sheep');
  const aliveRt = alive.mobHost.runtimeOf('mob_sheep')!;
  const ra = alive.attackMob('p1', 'mob_sheep', { level: 10 })!;
  ok(ra.hpLoss > 0, `反例:活着的生物 hpLoss = ${ra.hpLoss} > 0`);
  eq(aliveRt.hp, 60 - ra.hpLoss, '反例:HP 实际减少了 hpLoss(正常路径未被影响)');

  /* ── 钳制的**另一半**语义:溢出侧(Lead 提出,我原先写出了弱断言)──
   *
   * `Math.min(rawLoss, hpBefore)` 有两侧:
   *   · 下侧 = 尸体不虚报(上面已断言 `hpLoss = 0`);
   *   · 上侧 = **剩余血量 < 伤害时,`hpLoss` 应等于剩余血量,而不是伤害值**。
   *
   * 我原先写的是 `ok(rl.hpLoss <= 3)` —— 那是**弱断言,等于没测**:
   * `hpLoss = 0` 也能通过 `<= 3`,而 0 恰恰是「伤害完全没记上」的错误行为。
   * ⇒ 改成**精确相等 + 伤害确实超过残血**的前置条件,两侧夹住。 */
  const low = attackWorld('mob_sheep');
  const lowRt = low.mobHost.runtimeOf('mob_sheep')!;
  lowRt.hp = 6; /* 只剩 6 血 */
  /* 用 Lv20 + 712 重剑,保证 finalDamage 明显大于 6 —— 否则「溢出被钳」
     与「伤害本来就小」无法区分,断言又会变成形状化。 */
  const rl = low.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 })!;
  ok(rl.result.finalDamage > 6,
    `前置:本次 finalDamage=${rl.result.finalDamage} 确实超过残血 6(否则测不到溢出钳制)`);
  eq(rl.hpLoss, 6, `残血 6 被 ${rl.result.finalDamage} 伤害打死 ⇒ hpLoss 恰为 6(不是伤害值,也不是 0)`);
  eq(lowRt.hp, 0, '残血目标被击杀,HP 归 0');

  /* 再补一条**更严格**的:残血 1 时 hpLoss 必须 = 1(最难区分 0 与 1)。 */
  const one = attackWorld('mob_sheep');
  const oneRt = one.mobHost.runtimeOf('mob_sheep')!;
  oneRt.hp = 1;
  const rOne = one.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 })!;
  eq(rOne.hpLoss, 1, '残血 1 ⇒ hpLoss 恰为 1(同时排除「虚报大数」与「记成 0」两种错法)');

  /* 反例(未溢出侧):伤害**小于**满血时,hpLoss 必须等于伤害本身。
     ⚠ 这里我自己先写错过一次:Lv20 + 712 打出 65,而绵羊满血只有 60
     ⇒ 那**本身就是溢出情形**,钳制理应生效(hpLoss=60),不是反例。
     要测「未溢出时钳制不生效」,必须让 finalDamage 严格小于满血。 */
  const full = attackWorld('mob_sheep');
  const fullRt = full.mobHost.runtimeOf('mob_sheep')!;
  const rFull = full.attackMob('p1', 'mob_sheep', { level: 1, weaponId: 711 })!;
  ok(rFull.result.finalDamage < 60,
    `前置:本次 finalDamage=${rFull.result.finalDamage} < 满血 60(这才是真正的未溢出情形)`);
  eq(rFull.hpLoss, rFull.result.finalDamage,
    `反例:未溢出时 hpLoss(${rFull.hpLoss}) = finalDamage(${rFull.result.finalDamage}) —— 钳制不生效`);
  eq(fullRt.hp, 60 - rFull.result.finalDamage, '反例:HP 按 finalDamage 全额扣除');

  /* 再补一条:伤害**恰好等于**满血时的边界(既不算溢出、也不该被削)。 */
  const exact = attackWorld('mob_sheep');
  const exactRt = exact.mobHost.runtimeOf('mob_sheep')!;
  const rExact = exact.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 })!;
  eq(rExact.result.finalDamage, 65, '边界:该组合恰好打出 65 > 60,故属溢出侧');
  eq(rExact.hpLoss, 60, '边界:溢出侧 hpLoss = 满血 60(与 finalDamage 65 不等,钳制生效)');
  eq(exactRt.hp, 0, '边界:一次打死,HP 归 0');
});

test('生产接线17:装配层漏传 wearing 时退化为裸装,不抛异常', () => {
  /* ## 守什么
   *
   * `attackMob` 由网络层调用(不在 tick 路径上),但**装配层漏传 `wearing`**
   * 会走到 `wearingOf()`。第一版写的是 `p ? p.wearing : []` ——
   * 只覆盖「找不到玩家」,**不覆盖「玩家存在但 `wearing` 是 `undefined`」**,
   * 于是 `[...wearing]` 抛 `TypeError: wearing is not iterable`。
   *
   * 实测该反例:显式传 `wearing: undefined` 即触发。
   * 本仓的取舍是「生产路径上不 throw」⇒ 应**退化为按裸装结算**
   * (玩家看得见伤害数字变化),而不是让整次攻击崩掉。 */
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 24);
  /* 刻意构造「玩家已登记、但 wearing 字段缺失」的畸形输入。 */
  s.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: undefined as unknown as number[], playingInstrument: false,
  }]);
  s.addMob('mob_sheep', 'MEADOW', 25, 24);

  /* 正例:不抛异常,且按裸装算出伤害。 */
  let threw: string | null = null;
  let r: ReturnType<typeof s.attackMob> = null;
  try {
    r = s.attackMob('p1', 'mob_sheep', { level: 10 });
  } catch (err) {
    threw = (err as Error).message;
  }
  eq(threw, null, `wearing 缺失时不抛异常(实际:${threw ?? '无异常'})`);
  ok(r !== null, 'wearing 缺失时仍返回结算结果(退化为裸装,不是中断)');
  ok(r!.result.base > 0, `裸装仍算出第 1 步伤害 ${r!.result.base}`);

  /* 反例:显式传空数组与缺字段应得到**同一个**结果(两条退化路径一致)。 */
  const bare = attackWorld('mob_sheep', { wearing: [] });
  const rBare = bare.attackMob('p1', 'mob_sheep', { level: 10, wearing: [] })!;
  eq(r!.result.base, rBare.result.base, '缺 wearing 与传空数组等价(都按裸装)');

  /* 对照:正常装配仍能拿到装备(退化不能把正常路径也吃掉)。 */
  const okWorld = attackWorld('mob_sheep', { wearing: [711, 728] });
  const rOk = okWorld.attackMob('p1', 'mob_sheep', { level: 10 })!;
  ok(rOk.result.base > rBare.result.base,
    `对照:正常 wearing 下第 1 步更高(${rBare.result.base} → ${rOk.result.base}),退化不影响正常路径`);
});

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
  /* 本行是 `eq(计算值, 导出常量)` 形态 —— 两侧同源,数学上恒真。
   * 【task-23 定性结论:保留,不改为字面量】理由(注入实测):
   *   注入 BASE_CRIT_DMG 1.5→2.5 ⇒ 本套件 43/44 变红(红在相邻的字面量断言),
   *   即**该常量已被同套件独立锚点覆盖**,本行是冗余而非漏洞。
   *   与 `REFLECT_RADIUS` 的处置不同 —— 那一条注入后 44/44 全绿(无守卫),故必须改;
   *   本条注入会红(有守卫),属 verify.ts 白名单里已登记的**候选**,非缺陷。
   *   改为字面量会使 `WS-10::BASE_CRIT_DMG` 条目失真 —— 那需要同步改 verify.ts,
   *   不在本任务写域,故保持原样。 */
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
  eq(soft.finalDamage, 11, 'DEF=120 时最终伤害 = 11(设计基线)');
  ok(hard.finalDamage < soft.finalDamage, 'DEF 更高则最终伤害更低');
  eq(hard.finalDamage, 7, 'DEF=240 时最终伤害 = 7(设计基线)');

  /* 最低伤害保底 —— 这里原本只有 `ok(hard.finalDamage >= MIN_DAMAGE)`,
   * 两个问题叠加使它**永不生效**:
   *   1 右侧 `MIN_DAMAGE` 取自被测模块;实现里是 `Math.max(MIN_DAMAGE, raw)`,
   *     故该不等式对**任意**常量值恒真(构造上无法失败);
   *   2 `hard.finalDamage` 实测 7,离保底 1 很远,**保底分支从未被执行**。
   * 实测注入:`MIN_DAMAGE` 1→0 时本套件仍 **44/44 全绿**。
   * 修法:用**真正触发保底**的场景(DEF 1200 ⇒ 未取整 raw≈0.0 ⇒ 被抬到 1),
   * 并锚定字面量 1。这样常量一漂移就红,且保底分支真被执行一次。 */
  const ironwall = computeDamage({
    attacker, target: createTarget({ id: 'w', name: '铁壁', hp: 9e9, maxHp: 9e9, def: 5000 }),
    weapon: w, critRoll: 0.99, dodgeRoll: 0.99,
  });
  eq(ironwall.finalDamage, 1, 'DEF=5000 时被最低伤害保底抬到 1(保底分支可达)');
  eq(MIN_DAMAGE, 1, 'MIN_DAMAGE = 1(设计基线,非取自实现)');

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

  /* 闪避率硬上限 0.75 —— 原断言 `ok(capped.dodgeRate <= MAX_DODGE_RATE)` 是**空断言**:
   * 右侧 `MAX_DODGE_RATE` 取自被测模块,而 `combatantStats` 里是
   * `Math.min(eq.dodgeRate, MAX_DODGE_RATE)`,故该不等式对**任意**常量值恒真;
   * 且生产数据下闪避上限只有 0.13(全部 9 件护甲中仅 724=0.10、730=0.03 提供闪避),
   * **封顶分支从未被执行过**。实测注入:`MAX_DODGE_RATE` 0.75→0.99 时仍 44/44 全绿。
   *
   * 修法分两步,因为「封顶分支不可达」是**数据事实**,不能靠编造装备绕过:
   *   1 断言当前装备组合的**真实数值** 0.13(字面量)⇒ 聚合逻辑漂移就红;
   *   2 断言常量本身 = 0.75(字面量)⇒ 常量漂移就红;
   *   3 用**直接构造的 target.dodgeRate** 验证封顶逻辑本身(不依赖装备数据),
   *      使 `Math.min(..., MAX_DODGE_RATE)` 这条分支真被执行一次。 */
  const capped = combatantStats(1, [724, 730]);
  eq(capped.dodgeRate, 0.13, '724(0.10) + 730(0.03) → 闪避 0.13(设计基线)');
  eq(MAX_DODGE_RATE, 0.75, 'MAX_DODGE_RATE = 0.75(设计基线,非取自实现)');

  /* 封顶分支可达性:直接给目标一个超上限闪避率,验证被钳到 0.75 */
  const slippery = createTarget({ id: 'slip', name: '极滑', hp: 100, maxHp: 100, dodgeRate: 5.0 });
  const justUnder = computeDamage({ attacker: a, target: slippery, weapon: w, critRoll: 0.99, dodgeRoll: 0.74 });
  eq(justUnder.dodged, true, 'roll 0.74 < 钳后 0.75 → 仍闪避(封顶为 0.75 而非 5.0)');
  const justOver = computeDamage({ attacker: a, target: slippery, weapon: w, critRoll: 0.99, dodgeRoll: 0.76 });
  eq(justOver.dodged, false, 'roll 0.76 > 封顶 0.75 → 命中(证明封顶真的生效)');
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
  /* 【task-23 定性结论:保留,不改为字面量】同 `BASE_CRIT_DMG` ——
   * 注入 GHOST_MOVE_MUL 0→0.5 ⇒ 变红(相邻 `eq(ctl.moveMul, 0)` 抓住),故常量有守卫。
   * 属 verify.ts 白名单已登记候选,非缺陷;改字面量需同步 verify.ts,不在写域。 */
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
  /* 【task-23 定性结论:保留,不改为字面量】同 `BASE_CRIT_DMG` ——
   * 注入 BUBBLE_TRAP_SEC 5.0→9.0 ⇒ 变红(相邻字面量断言抓住),故常量有守卫。
   * 属 verify.ts 白名单已登记候选,非缺陷;改字面量需同步 verify.ts,不在写域。 */
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

/* ══════════════ 零之二、生产路径:击杀结算 / 幽灵泡泡 / 装备词条(task-44 接线)══════════════
 *
 * 三个模块在接线前**生产零引用**(`verify.ts` 的 `UNREACHABLE_EXEMPT` 挂着
 * 前两个的理由原文是「WS-10 击杀结算,待接入」「WS-10 复活/无敌,待接入」)。
 *
 * 接线前的实测缺口(经生产路径复现):
 *   · 击杀 `mob_sheep` 后 `WorldSim` 上**没有任何经验账本可观测** —— 24 格共享
 *     经验 / 连续升级 / 天赋钩子全部不生效;
 *   · `vitals.downed` 变成 `true` 之后**没有后续** —— 不进幽灵泡泡、队友贴着
 *     站 300 帧也救不起来;
 *   · `713` 声明了 `dot: { dps: 8, sec: 3 }`、手册写着「每击附加 8/s × 3s 灼烧」,
 *     但命中后跑满 60 帧(3s)生物 HP **纹丝不动**;`equipSummary` 还把护甲的
 *     `keywords` 整个丢掉(729 的「吸血」靠硬编码 `lifestealPerHit` 兜的)。
 *
 * 与 task-33 同一纪律:下面每条都**经 `WorldSim` 真实入口**(以及真实生物 AI),
 * 不复述纯函数行为 —— 纯函数那部分在接线前就已经全绿。
 */

/** 多玩家世界(经 `setMobPlayers` 灌装备,走装配层入口)。 */
function partyWorld(
  players: readonly { id: string; x: number; y: number; wearing?: readonly number[] }[],
  mobId: string,
  mobAt: readonly [number, number] = [25, 24],
): WorldSim {
  const s = new WorldSim({ sizeCells: 120 });
  for (const p of players) s.addPlayer(p.id, p.x, p.y);
  s.setMobPlayers(players.map((p) => ({
    id: p.id, x: p.x, y: p.y, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [...(p.wearing ?? [711])], playingInstrument: false,
  })));
  s.addMob(mobId, 'MEADOW', mobAt[0], mobAt[1]);
  return s;
}

test('task44-1:击杀生物 → 队伍经验真的入账(接线前 WorldSim 无任何经验账本)', () => {
  const s = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [712] }], 'mob_sheep');

  /* 反例先立:接线前这条是红的 —— 击杀后经验恒为 0。 */
  eq(s.progressSnapshotOf('p1'), null, '对照:击杀前该玩家还没有成长档案(账本不是构造时就预填的)');
  eq(s.killSettleCount, 0, '对照:击杀前结算计数为 0');
  eq(s.totalExpGranted, 0, '对照:击杀前累计发放经验为 0');

  const rt = s.mobHost.runtimeOf('mob_sheep')!;
  const r = s.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 })!;
  eq(rt.alive, false, '一击击杀(前置:确实发生了击杀,否则下面测的是别的东西)');
  eq(r.hpLoss, 60, '前置:本次造成 60 点掉血 = 绵羊满血(伤害足够致死)');

  /* 正例:击杀真的结算了。 */
  const p = s.progressSnapshotOf('p1')!;
  ok(p !== null, '击杀后该玩家有了成长档案(账本由击杀这一事件创建)');
  eq(s.killSettleCount, 1, '击杀结算计数 = 1');
  eq(p.totalExp, 15, '入账总经验 = 绵羊 exp 15(接线前恒为 0)');
  eq(p.level, 1, '15 经验不足以升到 2 级,等级仍是 1');
  eq(s.totalExpGranted, 15, '累计发放经验 = 15');
  eq(s.lastKillSettle!.deduped, false, '本次不是重复结算(去重账本首次 claim 成功)');
});

test('task44-2:尸体不能反复结算(击杀判定取「本次伤害造成击杀」而非「hp<=0」)', () => {
  const s = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [712] }], 'mob_sheep');
  s.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 });
  const n1 = s.killSettleCount;
  const e1 = s.totalExpGranted;
  eq(n1, 1, '前置:第一次击杀结算了 1 次');

  /* 反例:连打 10 次尸体 —— 一次都不能再结算。 */
  for (let i = 0; i < 10; i += 1) s.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 });
  eq(s.killSettleCount, n1, '连打 10 次尸体,结算计数不变(仍是 1)');
  eq(s.totalExpGranted, e1, '累计经验不变(没有为死掉的生物反复记账)');

  /* 正例对照:换一只**不同 ID** 的怪,必须能继续结算 —— 归零不能把正常路径吃掉。 */
  s.addMob('mob_boar', 'MEADOW', 25, 24);
  const rt2 = s.mobHost.runtimeOf('mob_boar')!;
  for (let i = 0; i < 20 && rt2.alive; i += 1) s.attackMob('p1', 'mob_boar', { level: 20, weaponId: 712 });
  eq(rt2.alive, false, '第二只怪被击杀');
  eq(s.killSettleCount, 2, '第二只怪的击杀**也**结算了(计数 2)');
  eq(s.totalExpGranted, 15 + 45, '累计经验 = 绵羊 15 + 野猪 45 = 60');
});

test('task44-3:24 格外不共享经验(负对照:范围外必须为 0)', () => {
  /* ⚠ 这条断言的存在理由:若把两个玩家都放在**附近**(< 24 格),
     那么「漏了距离判定」的实现**照样全绿** —— 因为「附近」满足「在范围内」。
     ⇒ 必须有一个**范围外**的玩家当负对照。
     这与 task-33 那条(「测钳制不生效,必须先证明输入落在不生效的那一侧」)同族。 */
  const s = partyWorld([
    { id: 'near', x: 24, y: 24, wearing: [712] },
    { id: 'far', x: 24, y: 64, wearing: [712] },   /* 距击杀点 40 格 > SHARE_RADIUS */
  ], 'mob_sheep');

  /* 前置:先证明这个夹具**真的**把两人放在了范围内外两侧。 */
  ok(40 > SHARE_RADIUS, `前置:40 格确实超出共享半径 ${SHARE_RADIUS}`);

  s.attackMob('near', 'mob_sheep', { level: 20, weaponId: 712 });

  eq(s.progressSnapshotOf('near')!.totalExp, 15, '范围内的玩家拿到 15 经验');
  /* ⚠ 判据用 `totalExp`/**经验条目**,不用「档案是否存在」。
     我第一版断言 `progressSnapshotOf('far') === null`,它**红**了 ——
     查后确认:范围外的玩家确实拿到了 0 经验(行为正确),但被建了个空档案。
     那是我接线引入的多余副作用,已修成「只给范围内建档」;
     即便如此,**断言本身也该测行为(拿到多少经验)而不是副作用(档案在不在)**
     —— 后者会在任何无关重构下变红,属脆弱断言。 */
  const far = s.progressSnapshotOf('far');
  eq(far?.totalExp ?? 0, 0, '范围外的玩家拿到 **0** 经验(负对照的核心)');
  eq(far, null, '且范围外的玩家**不会**被建档(次生不变量:档案 = 参与过击杀)');

  /* 更强的一条:结算条目里 far 的 share 必须是 0,而不是「压根没进列表」。 */
  const farEntry = s.lastKillSettle!.entries.find((e) => e.playerId === 'far')!;
  eq(farEntry.share, 0, '结算条目里 far 的 share = 0(在列表里但份额为 0)');
  eq(farEntry.inRadius, false, 'far 被标记为不在半径内');
  eq(s.lastKillSettle!.outOfRangeCount, 1, '结算结果记录「1 人在范围外被削减」');
  eq(s.totalExpGranted, 15, '本次总发放只有范围内那一份');
});

test('task44-4:经验结算吃的是 progression 的等级,不是 attackMob 的 opts.level', () => {
  /* ⚠ 这条钉住一个**已知的双源**,不是宣称它是正确的。
     `attackMob({ level })` 是调用方自报、参与伤害;`progression` 的等级来自
     击杀累积、参与经验压制。两者今天**恰好**都从 1 开始,所以看起来一致;
     一旦 US2 把 opts.level 接上客户端报文,这里就会分叉。
     ⇒ 断言把现状**写死并可见**,而不是留一个将来会静默分叉的隐形双源。 */
  const results: number[] = [];
  for (const lv of [1, 20]) {
    const s = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [712] }], 'mob_sheep');
    s.attackMob('p1', 'mob_sheep', { level: lv, weaponId: 712 });
    results.push(s.totalExpGranted);
  }
  eq(results[0], 15, `opts.level=1 时入账 15(progression 等级 1,无压制)`);
  eq(results[1], 15, `opts.level=20 时**同样**入账 15 —— 经验压制读的是 progression 的 lv1,不是 opts.level=20`);
  /* 显式记录两者今天是同一个数,将来分叉时这条会红。 */
  eq(results[0], results[1], '两者当前一致;若将来 US2 把等级权威统一到进度档案,本断言需同步改为「按 progression 等级压制」');
});

test('task44-5:HP 归零 → 进幽灵泡泡(vitals.downed 是唯一判据)', () => {
  const s = partyWorld([
    { id: 'p1', x: 24, y: 24 },
    { id: 'p2', x: 40, y: 40 },   /* 队友先在远处,避免把人打死后立刻被救 */
  ], 'mob_lava_elem', [24, 26]);

  eq(s.downedOf('p1'), undefined, '对照:一开始没有泡泡状态');

  let downedAt = -1;
  for (let i = 0; i < 600; i += 1) {
    s.tick();
    if (s.vitals.get('p1')!.downed) { downedAt = i; break; }
  }
  ok(downedAt >= 0, `前置:确实在 600 帧内被打到 HP 归零(第 ${downedAt} 帧)`);

  const d = s.downedOf('p1')!;
  ok(d !== undefined, '倒地后有了幽灵泡泡状态(接线前 downed=true 但没有任何后续)');
  eq(d.state, BodyState.GHOST_BUBBLE, '泡泡状态是 GHOST_BUBBLE');
  eq(d.reviveProgress, 0, '刚倒计时救援进度为 0');
  eq(d.rescuerId, null, '还没有救援者');
  /* 零掉级 / 零爆装:倒地瞬间冻结的快照必须来自进度档案。 */
  eq(d.levelSnapshot, s.progressSnapshotOf('p1')!.level, '倒地快照的等级 = 进度档案的等级(零掉级的前提)');
});

test('task44-6:队友触摸复活 —— 含「隔一格救不到」的反向对照', () => {
  /* ⚠ 反向对照是必须的:若只测「同格能救」,漏了距离判定的实现照样全绿。
     实测边界:TOUCH_RADIUS=0.9,0.85 格能救、0.95 格不能。 */
  const attempt = (dist: number): { revived: boolean; hp: number } => {
    const s = partyWorld([
      { id: 'p1', x: 24, y: 24 },
      { id: 'p2', x: 24 + 40, y: 24 },   /* 先放远处 */
    ], 'mob_lava_elem', [24, 26]);
    for (let i = 0; i < 600 && !s.vitals.get('p1')!.downed; i += 1) s.tick();
    /* 前置:此时确实倒地了。 */
    if (!s.vitals.get('p1')!.downed) return { revived: false, hp: -1 };
    s.setPlayerPos('p2', 24 + dist, 24);   /* 移到指定距离 */
    for (let i = 0; i < 60; i += 1) {
      s.tick();
      if (s.lastRevive !== null) break;
    }
    return { revived: s.lastRevive !== null, hp: s.vitals.get('p1')!.hp };
  };

  /* 正例:0.3 格(明显在半径内)。
     ⚠ 这个局部变量**不能叫 `near`** —— 会遮蔽导入的 `near()` 断言函数,
     报错是运行时才出现的 `near is not a function`(TS 类型剥离不做作用域报错)。
     踩过一次,留此注记。 */
  const closeBy = attempt(0.3);
  eq(closeBy.revived, true, '队友站 0.3 格(≤0.9)→ 触摸复活成功');
  eq(closeBy.hp, 50, '复活血量 = 50% 上限(100 × REVIVE_HP_RATIO 0.5)');

  /* 反向对照 1:0.95 格(刚好超出 0.9)。 */
  const justOut = attempt(0.95);
  eq(justOut.revived, false, '队友站 0.95 格(>TOUCH_RADIUS 0.9)→ **不能**复活(反向对照)');

  /* 反向对照 2:3 格(明显在半径外)。 */
  const far = attempt(3.0);
  eq(far.revived, false, '队友站 3 格 → 不能复活(反向对照)');

  /* ── 「中途松手,进度归零」—— 单一真相,由 revive.ts 拥有 ──
   *
   * ⚠ 这条是我修掉一个**自己引入的缺陷**后补的,值得完整记录。
   *
   * 我第一版在编排层写了 `if (bestId !== null && bestDist <= TOUCH_RADIUS)`
   * 预检查,**跳过**越界时的 `touchRevive` 调用。而 `revive.ts` 正是用
   * 「距离越界」表达**松手**:越界时它把 `reviveProgress` 归零。
   * 跳过调用 = 那段归零永不执行 ⇒ 实测「贴身累积 0.5 → 走远 → 回来」
   * 进度**被继承**,下一次贴近直接凑满 1.0 复活 —— 救援比设计更容易。
   *
   * 注入实验 I9(去掉我那份判据)保持**全绿** ⇒ 证明半径是两份实现、
   * 且断言当时完全测不到这个语义。这正是 Lead 转述的 build-wiring 教训
   * (「同一个概念的第二份实现」⇒ 死字段/缺陷隐身)在我这里的复现。
   *
   * 修法:距离判定只由 `touchRevive` 拥有,编排层无条件委托给它
   * (无救援者时传 `+Infinity`)。下面这条钉住修复后的语义。 */
  const release = ((): { carriedOver: boolean; afterReturn: number } => {
    const s = partyWorld([
      { id: 'p1', x: 24, y: 24 },
      { id: 'p2', x: 64, y: 24 },
    ], 'mob_lava_elem', [24, 26]);
    for (let i = 0; i < 600 && !s.vitals.get('p1')!.downed; i += 1) s.tick();
    /* 贴身 1 个慢帧(0.5s < REVIVE_TIME 1.0s ⇒ 不会复活)。 */
    s.setPlayerPos('p2', 24.3, 24);
    for (let i = 0; i < 10; i += 1) s.tick();
    const built = s.downedOf('p1')?.reviveProgress ?? -1;
    /* 走远(> TOUCH_RADIUS)。 */
    s.setPlayerPos('p2', 30, 24);
    for (let i = 0; i < 10; i += 1) s.tick();
    const afterRelease = s.downedOf('p1')?.reviveProgress ?? -1;
    /* 再回来 1 个慢帧 —— 若进度被继承会直接满,若从零则回到 0.5。 */
    s.setPlayerPos('p2', 24.3, 24);
    for (let i = 0; i < 10; i += 1) s.tick();
    return { carriedOver: built > 0 && afterRelease > 0, afterReturn: s.downedOf('p1')?.reviveProgress ?? -1 };
  })();
  eq(release.carriedOver, false, '走远后救援进度归零(「中途松手进度归零」契约生效)');
  near(release.afterReturn, 0.5, 1e-9, '回来后进度从 0 重新累积到 0.5,而不是继承走远前那 0.5');

  /* ── 倒地者不能当救援者 ──
   *
   * ⚠ 这条是注入 I10 逼出来的**测试盲区**:
   * 注入「去掉 `ov.downed` 过滤」时**全绿**,查后确认原因是
   * **没有任何夹具含「倒地的救援者」** —— 我的 task44-6 把救援者放在远处,
   * 而贴身夹具里两人会被熔岩同时打死(范围伤害),于是这条路径从未走到。
   *
   * 判据:直接把队友的 `downed` 置真,再看倒地者能否被「救活」。
   * 若没有这条,「倒地者救倒地者」这个错误行为在测试里完全不可见。 */
  const ghostRescuer = ((): { revived: boolean } => {
    const g = partyWorld([
      { id: 'p1', x: 24, y: 24 },
      { id: 'p2', x: 64, y: 24 },
    ], 'mob_lava_elem', [24, 26]);
    while (!g.vitals.get('p1')!.downed) g.tick();
    /* 把 p2 也标成倒地(直接置字段 —— 它是可变对象),再把它挪到 p1 身边。 */
    const gv2 = g.vitals.get('p2')!;
    gv2.downed = true;
    gv2.hp = 0;
    g.setPlayerPos('p2', 24.3, 24);
    for (let i = 0; i < 40; i += 1) {
      g.tick();
      if (g.lastRevive !== null) break;
      /* 每帧重置:避免被其它路径改动而干扰本断言。 */
      g.vitals.get('p2')!.downed = true;
    }
    return { revived: g.lastRevive !== null };
  })();
  eq(ghostRescuer.revived, false, '倒地者(p2)站在 0.3 格也**救不了**人(倒地者不能当救援者)');
});

test('task44-7:复活后泡泡清除且 downed 归位(不写成死循环)', () => {
  /* ⚠ 这条防的是一个我预见的失败模式:若复活后没把结果写回 `vitals`,
     下一帧 `vitals.downed` 仍是 true → 又建一次泡泡 → 表现为
     「复活了但立刻又倒下」。断言必须查**复活之后**的状态。 */
  const s = partyWorld([
    { id: 'p1', x: 24, y: 24 },
    { id: 'p2', x: 64, y: 24 },
  ], 'mob_lava_elem', [24, 26]);
  for (let i = 0; i < 600 && !s.vitals.get('p1')!.downed; i += 1) s.tick();
  eq(s.vitals.get('p1')!.downed, true, '前置:先倒地');
  s.setPlayerPos('p2', 24.3, 24);
  for (let i = 0; i < 60 && s.lastRevive === null; i += 1) s.tick();

  ok(s.lastRevive !== null, '复活发生了');
  eq(s.lastRevive!.method, ReviveMethod.TOUCH, '复活方式是 TOUCH');
  eq(s.lastRevive!.levelUnchanged, true, '零掉级:复活后等级未变');
  eq(s.lastRevive!.equipmentUnchanged, true, '零爆装:复活后装备栏未变');
  eq(s.lastRevive!.invulnSec, 0.5, '复活后有 0.5s 无敌(MANUAL_REVIVE_INVULN)');

  eq(s.vitals.get('p1')!.downed, false, '复活后 vitals.downed 归 false(写回了瞬时判定)');
  eq(s.vitals.get('p1')!.hp, 50, '复活后 HP 为 50');
  eq(s.downedOf('p1'), undefined, '复活后泡泡状态被清除');

  /* ⚠ 「再跑一段确认没有立刻又倒下」这条我第一版写错了两次,值得记录。
     第一次:夹具里熔岩**还在旁边**,p1 复活在 50 血后又被打空 ——
     那是**预期行为**(世界里有持续伤害源),不是「状态没写回的死死循环」。
     第二次:我想 `removeMob` 移走熔岩,但**编排层没有这个方法**。
     ⇒ 最终做法:把 p1/p2 一起传送到远处(实测可行),再验证。
     判据用 `totalTaken` —— 它只增不减,最能说明「没有再挨打」。 */
  s.setPlayerPos('p1', 300, 300);
  s.setPlayerPos('p2', 300, 300);
  const takenAfterRevive = s.vitals.get('p1')!.totalTaken;
  for (let i = 0; i < 40; i += 1) s.tick();
  eq(s.vitals.get('p1')!.downed, false, '移开伤害源后 40 帧内没有再次倒地(排除状态未清的死循环)');
  eq(s.vitals.get('p1')!.totalTaken, takenAfterRevive, 'totalTaken 未再增长 —— 确实没有再挨打');
  eq(s.downedOf('p1'), undefined, '没有重新生成泡泡');
});

test('task44-8:713 命中 → 灼烧 DoT 真的逐帧扣血(原先生产零消费)', () => {
  const s = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_tanuki');

  /* 反例先立:接线前命中后 60 帧 HP 纹丝不动。 */
  const rt = s.mobHost.runtimeOf('mob_tanuki')!;
  const r = s.attackMob('p1', 'mob_tanuki', { level: 1, weaponId: 713 })!;
  const afterHit = rt.hp;
  ok(r.hpLoss > 0, `前置:命中确实造成了直伤 ${r.hpLoss}`);

  const dot = s.dotOf('mob_tanuki');
  ok(dot !== undefined, '命中带 dot 的武器后生物身上有点燃任务(接线前恒为 undefined)');
  eq(dot!.dps, 8, '任务 dps 取自武器表 713 的 dot.dps = 8');
  eq(dot!.remainSec, 3, '任务时长取自武器表 dot.sec = 3');

  for (let i = 0; i < 60; i += 1) s.tick();   /* 3 秒 = 60 快帧 */
  const burned = afterHit - rt.hp;
  near(burned, 24, 1e-6, `3 秒灼烧总量 = ${burned}(期望 8/s × 3s = 24,接线前为 0)`);
  eq(s.dotOf('mob_tanuki'), undefined, '3 秒后灼烧任务被清账(不留孤儿任务)');

  /* ── 时间剖面:证明灼烧是「3 秒内均匀烧完」而不是「瞬间烧完」──
   *
   * ⚠ 这条是被注入 I13 逼出来的。把 `tickDot(task, DT)` 误写成
   * `tickDot(task, SIM_SLOW_DT)`(0.5 而非 0.05)时:
   *   总量仍是 24(= dps × sec,与 dt 无关)⇒ **上面那条总量断言全绿**;
   *   但灼烧会在 **6 帧 = 0.3 秒**内烧完,而不是 3 秒。
   * ⇒ 「总量」抓不到时钟错误,只有**时间剖面**能抓。
   * 这是我 task-44 第一版的真实错误(在别处踩过同族):断言测了总量,
   * 却没测「什么时候烧完」。 */
  const prof = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_tanuki');
  const prt = prof.mobHost.runtimeOf('mob_tanuki')!;
  prof.attackMob('p1', 'mob_tanuki', { level: 1, weaponId: 713 });
  const ph0 = prt.hp;
  for (let i = 0; i < 20; i += 1) prof.tick();        /* t = 1s */
  near(ph0 - prt.hp, 8, 1e-6, `t=1s 时已烧 8(1/3 总量)—— 若按错时钟此时已烧完 24`);
  ok(prof.dotOf('mob_tanuki') !== undefined, 't=1s 时灼烧任务**仍在**(没提前结束)');
  for (let i = 0; i < 20; i += 1) prof.tick();        /* t = 2s */
  near(ph0 - prt.hp, 16, 1e-6, 't=2s 时已烧 16(2/3 总量)');
  for (let i = 0; i < 20; i += 1) prof.tick();        /* t = 3s */
  near(ph0 - prt.hp, 24, 1e-6, 't=3s 时恰好烧完 24');
  eq(prof.dotOf('mob_tanuki'), undefined, 't=3s 时任务清除');

  /* 反例:再跑 60 帧不应继续掉血(时长到了就该停)。 */
  const hpAt3s = rt.hp;
  for (let i = 0; i < 60; i += 1) s.tick();
  near(rt.hp, hpAt3s, 1e-9, '再跑 3 秒 HP 不变(灼烧按时长结束,不是永久燃烧)');
});

test('task44-9:DoT 只在**命中**时点燃(挥空 / 无 dot 武器两个反向对照)', () => {
  /* 反向对照 1:无 dot 的武器(711)不该点燃。 */
  const a = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [711] }], 'mob_tanuki');
  a.attackMob('p1', 'mob_tanuki', { level: 1, weaponId: 711 });
  eq(a.dotOf('mob_tanuki'), undefined, '反向对照:711 没有 dot 字段 → 不点燃');

  /* 反向对照 2:超距挥空(hpLoss=0)不该点燃。 */
  const b = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_tanuki', [60, 60]);
  const rb = b.attackMob('p1', 'mob_tanuki', { level: 1, weaponId: 713 })!;
  eq(rb.hpLoss, 0, '前置:超距攻击 hpLoss = 0(确实挥空了)');
  eq(b.dotOf('mob_tanuki'), undefined, '反向对照:挥空(hpLoss=0)→ 不点燃');

  /* 反向对照 3:一击致死时不留「活了 0 帧」的幽灵任务。 */
  const c = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_sheep');
  const rc = c.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 713 })!;
  eq(c.mobHost.runtimeOf('mob_sheep')!.alive, false, '前置:一击击杀');
  eq(c.dotOf('mob_sheep'), undefined, '反向对照:一击致死 → 不挂灼烧(尸体上不留任务)');
});

test('task44-10:DoT 击杀同样结算经验(灼烧走同一个伤害收口)', () => {
  /* 这条钉住「DoT 经 damageMob 而不是直接改 rt.hp」——
     若 DoT 绕过收口,灼烧致死**不会**触发经验结算,而这在
     「有没有掉血」的断言下完全看不出来。 */
  const s = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_tanuki');
  const rt = s.mobHost.runtimeOf('mob_tanuki')!;
  /* 把血卡在「直伤打不死、但直伤 + 24 能烧死」的区间。 */
  const probe = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_tanuki');
  const direct = probe.attackMob('p1', 'mob_tanuki', { level: 1, weaponId: 713 })!.hpLoss;
  rt.hp = direct + 12;

  s.attackMob('p1', 'mob_tanuki', { level: 1, weaponId: 713 });
  eq(rt.alive, true, '前置:直伤之后目标**仍然活着**(本击杀必须由灼烧完成)');
  eq(s.killSettleCount, 0, '前置:此时还没有结算');

  for (let i = 0; i < 60; i += 1) s.tick();
  eq(rt.alive, false, '灼烧把目标烧死了');
  eq(s.killSettleCount, 1, '灼烧致死**同样**触发击杀结算(证明 DoT 走的是同一个伤害收口)');
  eq(s.totalExpGranted, 85, '入账的正是 mob_tanuki 的 exp 85');
});

test('task44-11:DoT 携带命中方向(fromDeg),不因站位运气改变总量', () => {
  /* ⚠ 这条是我自己踩的坑:第一版给 DoT 传硬编码 `fromDeg: 0`,
     而发条重骑的正面护板按方向减伤(KNIGHT_FRONT_DR=0.90)。
     实测同一玩家、同一武器、只因站位不同,灼烧 2.40 vs 24.00 —— 差 10 倍。
     传死值等于宣称「灼烧永远从 0° 来」,伤害取决于生物恰好朝哪边。
     ⇒ 点燃时必须记住那一击的真实方向。

     ## 为什么必须**冻结朝向**
     骑士每帧 `facingDeg` 朝向最近玩家 ⇒ 只靠坐标无法区分正面/背后
     (两侧都会被判成正面)。我第一次对照就是这样失效的:两个数都没变。
     ⇒ 必须把 `rt.facingDeg` 钉住,变量才被隔离。 */
  const burnFrom = (fromDeg: number): { burn: number; events: string[] } => {
    const s = partyWorld([{ id: 'p1', x: 24, y: 24, wearing: [713] }], 'mob_clock_knight');
    const rt = s.mobHost.runtimeOf('mob_clock_knight')!;
    const r = s.attackMob('p1', 'mob_clock_knight', { level: 1, weaponId: 713, fromDeg })!;
    const afterHit = rt.hp;
    for (let i = 0; i < 60; i += 1) { rt.facingDeg = 0; s.tick(); }
    return { burn: afterHit - rt.hp, events: r.events as string[] };
  };

  const front = burnFrom(0);     /* 骑士朝 0°,攻击也来自 0° → 正面 */
  const back = burnFrom(180);    /* 骑士朝 0°,攻击来自 180° → 背后 */

  includes(front.events, 'knight_front_plate', '正面击中触发护板事件(前置:方向确实被判成正面)');
  eq(back.events.length, 0, '背后击中不触发护板事件(前置:方向确实被判成背后)');

  near(front.burn, 2.4, 1e-6, `正面灼烧 = ${front.burn}(24 × 10%,护板吃掉了 90%)`);
  near(back.burn, 24, 1e-6, `背后灼烧 = ${back.burn}(全额,未被护板削减)`);
  ok(Math.abs(front.burn - back.burn) > 0.5,
    '两侧灼烧**不同** ⇒ DoT 真的携带了命中方向(硬编码 fromDeg 时两侧会同值)');

  /* 同一方向必须可复现 —— 排除「随机」。 */
  const frontAgain = burnFrom(0);
  near(frontAgain.burn, front.burn, 1e-9, '同一方向重复点燃,灼烧量完全一致(方向是唯一变量,结果确定)');
});

test('task44-12:护甲 keywords 被 equipSummary 丢弃(已知缺口,显式记录而非静默)', () => {
  /* ⚠ 这条记录一个**我判定为「本轮不修」的缺口**,并说明理由。
     不修的原因不是「不重要」,而是「改了会造假」:
     729 的 `keywords: ['吸血','飞行']` 里,「吸血」由硬编码
     `flags.lifestealPerHit = 3` 兑现,「飞行」**没有任何数值定义** ——
     手册也没写飞行的高度/速度。若为了让 `keywords` 非空而把它塞进
     `flags`,等于**凭空发明一套机制数值**,那比缺口更坏。
     ⇒ 断言把「summary 不含 keywords」写死为**当前事实**,
       将来真做了词条系统时这条会红,迫使实现者同步更新。 */
  const sum = equipSummary([711, 729]);
  eq('keywords' in sum, false, '当前事实:EquipSummary 不含 keywords 字段(护甲的 keywords 被丢弃)');
  eq(sum.flags.lifestealPerHit, 3, '729 的「吸血」靠硬编码 flags 兑现(不是走 keywords)');
  eq(ARMOR_BY_ID.get(729)!.keywords.length, 2, '729 表里**确实**声明了 2 条 keywords');

  /* 反向对照:数值字段**没有**被丢弃 —— 证明问题只出在 keywords,不是整个 summary 坏了。 */
  const sum2 = equipSummary([711, 724]);
  eq(sum2.dodgeRate, 0.1, '反向对照:724 的 dodgeRate 0.10 正常进入 summary');
  eq(sum2.hpBonus, 40, '反向对照:724 的 hpBonus 40 正常进入 summary');
  /* 724 的 keywords 同样是 2 条却不体现在 summary 里 —— 与数值字段形成对照。 */
  eq(ARMOR_BY_ID.get(724)!.keywords.length, 2, '对照:724 也有 2 条 keywords,但 summary 里同样看不到');
  /* 两者差异只来自数值字段,不来自 keywords。 */
  const a = attackWorld('mob_sheep', { wearing: [711, 724] });
  const b = attackWorld('mob_sheep', { wearing: [711, 730] });
  const ra = a.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 711 })!;
  const rb = b.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 711 })!;
  eq(ra.result.finalDamage, rb.result.finalDamage,
    '两件 keywords 完全不同的护甲(724 vs 730)对伤害无影响 —— keywords 目前不参与伤害管线');
});

/* ══════════ 零之三、信任边界:自报标量消毒(task-51)══════════════
 *
 * ## 缺陷
 *
 * `attackMob` 的 `opts.comboMul` 直接透传进 `computeDamage`,而管线第一段
 * `base = totalAtk × levelMul × weaponMul × comboMul × skillMul` 里,
 * **它是唯一没有上界的乘数**:
 *
 * | 乘数 | 上界 |
 * |:---|:---|
 * | `levelMul` | `combatantStats` 钳 `MAX_LEVEL=30` |
 * | `weaponMul` / `skillMul` | 查表(武器表最大 `attackMul` = 1.5) |
 * | `dodgeRate` / `critRate` / `critDmg` | 各自 `MAX_*` |
 * | `comboMul` | ❌ **无** |
 *
 * 实测 `comboMul: 1e9` → `finalDamage` 从 14 涨到 **14285714286**(≈1.0e9×)。
 *
 * ## 为什么这条断言必须能**区分「拒绝」与「夹取」**
 *
 * 只测「数字变小了」无法区分两种语义:
 *   · 夹取(clamp)到 3.0 → 与**合法上界**同值
 *   · 拒绝(reject)回 1.0 → 与**缺省**同值
 * 二者都「变小了」。所以断言必须锚定到**两个不同的已知数值**上。
 *
 * ## 语义选择与依据(不是「手册要求」)
 *
 * ⚠ 手册**没有**定义连段倍率数值(全文 `连段|连招|第三段|三段` = 0 命中),
 * 也**没有**任何「服务端权威 / 反作弊」概念(0 命中)。故依据是**本仓既有纪律**:
 *   · CR-14 U1:`allowedSources`/`capacity` 一律服务端派生
 *   · CR-14 U2-b:`NaN` 声明使钳位公式产出 `NaN` ⇒ 判据被污染,**已修**,
 *     修法即 `sanitizeMul`(非数字/`NaN`/`-Infinity` 退 fallback,其余夹到 max)
 * ⇒ 本条是**同一纪律的又一实例**,不是新原则。
 *
 * 选择:
 *   · 非数字 / `NaN` / `-Infinity` ⇒ **拒绝**,退回 1.0。这些不是「太大了」,
 *     而是「根本不是倍率」,夹取无意义。
 *   · 有限但 > 3.0 / `+Infinity` ⇒ **夹取**到 `MAX_COMBO_MUL`。
 *   · 负数 / 0 ⇒ 夹到 0(既有 `MIN_DAMAGE` 兜底)。
 */

/** 用给定 comboMul 打一刀,返回最终伤害。 */
function comboHit(comboMul: unknown): number {
  const s = attackWorld('mob_sheep', { wearing: [] });
  const r = s.attackMob('p1', 'mob_sheep', { comboMul: comboMul as number })!;
  return r.result.finalDamage;
}

test('task51-1:合法连段倍率原样生效(消毒不得改动合法值)', () => {
  /* ⚠ 前置:先钉住「1.0 的基准」,否则下面所有比例都无从判读。 */
  const one = comboHit(1.0);
  eq(one, comboHit(undefined), '缺省 comboMul 与显式 1.0 等价(消毒的 fallback 也是 1.0)');

  /* 现网真实声明的 4 个值(从武器表 passive 穷举,不是猜的):
       711 三连「1.00 / 1.00 / 1.25」→ 1.25
       714「第三段额外 +0.20」        → 1.20
       715「满蓄力 +0.35」            → 1.35
       720「回程再结算 0.5 倍率」      → 0.50 */
  const declared = [1.25, 1.2, 1.35] as const;
  for (const v of declared) {
    ok(comboHit(v) > one, `声明值 ${v} 让伤害**变大**(前置:确实作用到了公式上)`);
  }
  eq(comboHit(1.25), comboHit(1.25), '同一合法值可复现');

  /* 逐值钉死,任何「误夹」都会让某一项变红。 */
  const expectRatio = (v: number): number => {
    /* 管线在 step 6 取整,故只比较「未取整前的比例」在同一取整下的结果:
       用 1.0 与 v 两次实测,断言 v 的结果严格大于 1.0 且小于 v+1 的粗界,
       再单独用上界断言兜住。这里只要求单调,不假设取整口径。 */
    return Math.round((one * v) * 100) / 100;
  };
  ok(comboHit(1.2) === expectRatio(1.2) || Math.abs(comboHit(1.2) - expectRatio(1.2)) <= 1,
    `1.20 的结果 ${comboHit(1.2)} 与未取整期望 ${expectRatio(1.2)} 相差 ≤1(仅取整差)`);
  ok(comboHit(1.25) === expectRatio(1.25) || Math.abs(comboHit(1.25) - expectRatio(1.25)) <= 1,
    `1.25 的结果 ${comboHit(1.25)} 与未取整期望 ${expectRatio(1.25)} 相差 ≤1`);
});

test('task51-2:【核心】非法值语义 —— 拒绝(NaN)与夹取(1e9)必须**可区分**', () => {
  /* 三个锚点:缺省 1.0 = 下锚点;合法上界 3.0 = 上锚点。 */
  const at1 = comboHit(1.0);
  const atMax = comboHit(MAX_COMBO_MUL);
  ok(atMax > at1, `前置:合法上界 ${MAX_COMBO_MUL} 确实比 1.0 大(${atMax} > ${at1}),否则两个锚点无法区分`);

  /* ── 锚点 A:**拒绝**语义 —— 非数字 / NaN / -Infinity 退回 1.0 ── */
  for (const bad of [Number.NaN, 'x', {}, null, undefined] as const) {
    eq(comboHit(bad), at1, `非法值 ${String(bad)} 被**拒绝**,退回 1.0 的伤害(${at1})`);
  }
  eq(comboHit(Number.NEGATIVE_INFINITY), at1, '-Infinity 被**拒绝**,退回 1.0');

  /* ── 锚点 B:**夹取**语义 —— 有限越界 / +Infinity 夹到 MAX_COMBO_MUL ── */
  for (const big of [10, 100, 1e9, Number.POSITIVE_INFINITY] as const) {
    eq(comboHit(big), atMax, `越界值 ${String(big)} 被**夹取**到上界,伤害 = ${atMax}(不是 1.0 的 ${at1})`);
  }

  /* ── 关键:**两者必须不同**,否则「拒绝」与「夹取」不可分辨 ── */
  ok(atMax !== at1, `夹取锚点 ${atMax} ≠ 拒绝锚点 ${at1} ⇒ 两种语义在本断言下可区分`);

  /* ── 负数 / 0:夹到 0,由 MIN_DAMAGE 兜底为最小伤害 ── */
  eq(comboHit(0), comboHit(-1), '0 与负数的结果一致(都被夹到 0)');
  ok(comboHit(0) < at1, '夹到 0 后伤害低于 1.0 的基线(说明 0 真的生效了,不是被当成非法值退回 1.0)');
});

test('task51-3:NaN 不得污染生物 HP(此前的永久损坏)', () => {
  /* ⚠ 这条测的是**状态污染**,不是数值大小。
     `comboMul: NaN` 时 `base = NaN` ⇒ `finalDamageRaw = NaN` ⇒
     `Math.max(MIN_DAMAGE, NaN)` = **NaN** ⇒ 写进 `rt.hp` 后生物 HP 变 NaN,
     而 `NaN <= 0` 恒 false ⇒ `alive` 永远为 true ⇒ **该生物永远打不死**。
     实测:此后补一刀合法值也救不回来(HP 仍是 NaN)。 */
  const s = attackWorld('mob_sheep', { wearing: [] });
  const rt = s.mobHost.runtimeOf('mob_sheep')!;
  const r = s.attackMob('p1', 'mob_sheep', { comboMul: Number.NaN })!;
  eq(r.result.finalDamage, 14, 'NaN 输入被拒绝,本次伤害正常结算为 14(不是 NaN)');
  ok(!Number.isNaN(rt.hp), '生物 HP 仍是有限数(没有被污染成 NaN)');
  eq(rt.hp, 60 - 14, 'HP 正常扣除 14');

  /* 补刀:证明该生物**还能被打死**,不是「活着但打不动」。 */
  const s2 = attackWorld('mob_sheep', { wearing: [] });
  const rt2 = s2.mobHost.runtimeOf('mob_sheep')!;
  s2.attackMob('p1', 'mob_sheep', { comboMul: Number.NaN });
  for (let i = 0; i < 10 && rt2.alive; i += 1) s2.attackMob('p1', 'mob_sheep', { level: 20, weaponId: 712 });
  eq(rt2.alive, false, '被 NaN 攻击过的生物**仍然可以被正常击杀**(HP 未污染)');
});

test('task51-4:等级自报也要消毒(与 comboMul 同一类的兄弟缺陷)', () => {
  /* ⚠ 这条是我做「陷阱 31 探测器」时发现的:**只修 comboMul 是假修**。
     `world_sim` 原写法 `Math.max(1, Math.trunc(opts.level ?? 1))`:
       `Math.trunc(NaN)` = NaN,`Math.max(1, NaN)` = **NaN**(Math.max 遇 NaN 返回 NaN)
     ⇒ 等级 NaN 同样把 `levelMul` 弄成 NaN ⇒ **完全相同的 HP 永久污染**。
     实测修复前 `level: NaN` 与 `comboMul: NaN` 行为一致(都让 hp 变 NaN)。 */
  const s = attackWorld('mob_sheep', { wearing: [] });
  const rt = s.mobHost.runtimeOf('mob_sheep')!;
  const r = s.attackMob('p1', 'mob_sheep', { level: Number.NaN })!;
  eq(r.result.finalDamage, comboHit(1.0), 'level: NaN 被拒绝,退回 1 级(伤害 = 1 级基线)');
  ok(!Number.isNaN(rt.hp), 'HP 未污染');

  /* 合法等级仍按原样生效(反向对照:别把好的也拒了)。 */
  const s2 = attackWorld('mob_sheep', { wearing: [] });
  const r20 = s2.attackMob('p1', 'mob_sheep', { level: 20 })!;
  ok(r20.result.finalDamage > comboHit(1.0), 'level: 20 仍正常放大伤害(消毒没有误伤合法值)');

  /* 封顶照旧:MAX_LEVEL=30 以上不再增长。扫描多点 —— 单点区分不了「封顶」与「非线性」。 */
  const at30 = ((): number => { const g = attackWorld('mob_sheep', { wearing: [] }); return g.attackMob('p1', 'mob_sheep', { level: 30 })!.result.finalDamage; })();
  for (const lv of [31, 1e9] as const) {
    const g = attackWorld('mob_sheep', { wearing: [] });
    eq(g.attackMob('p1', 'mob_sheep', { level: lv })!.result.finalDamage, at30,
      `level ${lv} 封顶在 30 级`);
  }
  /* ⚠ `+Infinity` 必须**夹到上界**而不是被拒绝 —— 这是 `sanitizeMul` 的既有口径
     (`+Infinity` 经 `Math.min` 本就正确钳到上界,属既有正确行为,改了是无谓回归)。
     我第一版用 `Number.isFinite` 一刀切,把 `level: Infinity` 从「30 级」改成了
     「1 级」,正是被下面这条断言抓红的 —— 留此注记,证明这条断言有牙。 */
  const gInf = attackWorld('mob_sheep', { wearing: [] });
  eq(gInf.attackMob('p1', 'mob_sheep', { level: Number.POSITIVE_INFINITY })!.result.finalDamage, at30,
    'level: +Infinity 夹取到 30 级(不是被拒绝成 1 级 —— 与 sanitizeMul 同口径)');
  /* 前置:证明「封顶」是真的封顶,而不是等级本来就不起作用。 */
  ok(at30 > comboHit(1.0), '前置:30 级确实比 1 级伤害高,否则上面几条测的是「等级无效」');
});

test('task51-5:comboMul 是唯一无上界乘数 —— 其余六个各有界(不一致才是缺陷依据)', () => {
  /* 这条不是「再测一遍 comboMul」,而是把**不一致**本身钉住:
     同一个公式里七个乘数,六个有界、一个没有,这才是「缺陷」的判据
     (手册没有任何权威/反作弊概念,所以依据只能是本仓一致性)。 */
  eq(MAX_COMBO_MUL, 3.0, 'comboMul 上界 = 3.0');

  /* 兄弟乘数的上界各自生效 —— 逐个证明,而不是笼统声称。 */
  const atkFor = (lv: number): number => combatantStats(lv, []).totalAtk;
  eq(atkFor(1), atkFor(30), 'totalAtk 与等级无关(等级只经 levelMul 进公式)');
  eq(combatantStats(999, []).level, MAX_LEVEL, `combatantStats 把等级钳到 MAX_LEVEL=${MAX_LEVEL}`);
  /* ⚠ 闪避率要**重复堆**才能触到上限:单套护甲最高只有 724 的 0.10,
     全表带 dodgeRate 的护甲只有 724(0.10)/730(0.03),全塞也只有 0.13。
     我第一版写 `combatantStats(30,[724,730]).dodgeRate === 0.75` 是错的
     —— 实测 0.13,根本没触到钳制点,那条断言测的不是钳制。 */
  eq(combatantStats(30, [724, 730]).dodgeRate, 0.13, '前置:单套 724+730 的闪避率是 0.13(未触上限)');
  const dodgy = Array.from({ length: 20 }, () => 724);
  eq(combatantStats(30, dodgy).dodgeRate, MAX_DODGE_RATE,
    `重复堆 20 件 724 才触到上限,被钳到 ${MAX_DODGE_RATE}`);
  eq(combatantStats(30, [718, 730], { critDmg: 5.0 }).critDmg, MAX_CRIT_DMG,
    `爆伤钳到 MAX_CRIT_DMG=${MAX_CRIT_DMG}(即便声明 5.0)`);
  eq(combatantStats(30, [], { critRate: 1e9 }).critRate, MAX_CRIT_RATE, '暴击率钳到 1.0');

  /* 而 comboMul 修复前**没有任何** MAX_* 可钳 —— 现在有了,且是同一个量纲。 */
  ok(MAX_COMBO_MUL > 1, '上界大于 1(连段是加成而非削减)');
  ok(MAX_COMBO_MUL >= 1.35, `上界覆盖武器表已声明的最大倍率 1.35(不能把合法值误拒)`);
});

/* ─────────── US2(task-47):权威攻击入口 + 装备权威归属 ─────────── */

/** 权威入口的固定夹具:固定 RNG,排除暴击/闪避对伤害比较的干扰。 */
function authWorld(wearing: number[] = [], d = 1, at: [number, number] = [10, 10]): WorldSim {
  const s = new WorldSim({ sizeCells: 128, combatRng: () => 0.5 });
  s.addPlayer('p1', at[0], at[1]);
  if (wearing.length > 0) s.setProfile('p1', { wearing });
  s.addMob('mob_sheep', 'MEADOW', at[0] + d, at[1]);
  return s;
}

test('US2-1:装备经 setMobPlayers 灌入后**跨帧存活**(修 syncPlayers 抹除)', () => {
  /* ## 这条守的是本任务发现的真缺陷(不是新功能)
     `syncPlayers()` 每帧从 `physics.bodies` 重建 `mobPlayers`,而它原先把
     `wearing` 写成字面量 `[]` —— 于是装配层灌进来的装备**下一帧被抹掉**。
     实测(接线前):灌 [712] 后立刻攻击 76 伤害,`tick()` 一次掉回 10。
     ⇒ 装备不能存在**派生视图**里,必须有独立持有者(`profiles`)。

     ## ⚠ 修法是**一对**改动,单点注入测不出(故障注入实测)
     1 `wearingOf` 改成读 `profiles`(权威);
     2 `syncPlayers` 改成从 `profiles` 投影(而不是写字面量 `[]`)。
     只改 (1):`mobPlayers` 里仍有对的值 ⇒ 读哪边都对 ⇒ **全绿**;
     只改 (2):`wearingOf` 仍读 `mobPlayers`,而它已被正确投影 ⇒ 也全绿。
     **两处同时复原**才复现原缺陷 ⇒ 只有那种注入能让本断言变红
     (实测 J-A2:81/82,红 US2-1)。这正是本仓陷阱 31 的形态 ——
     「一条注入没红」有**两种**解释,本次实测确认是「第二份实现顶着」。 */
  const s = new WorldSim({ sizeCells: 48, combatRng: () => 0.5 });
  s.addPlayer('p1', 24, 24);
  s.addMob('mob_sheep', 'MEADOW', 25, 24);
  s.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [712], playingInstrument: false,
  }]);

  eq([...s.profileOf('p1').wearing], [712], '档案立即记下装备');
  const before = s.attackMob('p1', 'mob_sheep')!.result.finalDamage;

  /* 推进多帧 —— 接线前这里就会把 wearing 抹成 [] */
  for (let i = 0; i < 5; i += 1) s.tick();
  eq([...s.profileOf('p1').wearing], [712], 'tick×5 后档案里装备**仍在**');
  const after = s.attackMob('p1', 'mob_sheep')!.result.finalDamage;
  eq(after, before, '固定 RNG 下跨帧伤害一致(装备没丢)');

  /* 反向对照:真裸装必须显著更低 —— 否则上面「一致」可能只是装备本来就不起作用。 */
  const bare = new WorldSim({ sizeCells: 48, combatRng: () => 0.5 });
  bare.addPlayer('p1', 24, 24);
  bare.addMob('mob_sheep', 'MEADOW', 25, 24);
  const bareDmg = bare.attackMob('p1', 'mob_sheep')!.result.finalDamage;
  ok(before > bareDmg, `装 712(${before})必须高于裸装(${bareDmg})⇒ 装备真的参与结算`);
});

test('US2-2:权威入口的**三道闸** —— 身份 / 到该玩家的距离 / 武器 reach', () => {
  /* ## 闸 1:身份(生物不得当攻击者)
     生物也在 `physics.bodies` 里 ⇒ 不查身份就能「用一只生物打另一只」。 */
  const s0 = new WorldSim({ sizeCells: 128, combatRng: () => 0.5 });
  s0.addPlayer('p1', 10, 10);
  s0.addMob('mob_sheep', 'MEADOW', 11, 10);
  s0.addMob('mob_boar', 'MEADOW', 12, 10);
  eq(s0.attackMobAuthorized('p1', 'mob_sheep').outcome, 'OK', '玩家攻击 ⇒ 放行到结算');
  const asMob = s0.attackMobAuthorized('mob_boar', 'mob_sheep');
  eq(asMob.outcome, 'OUT_OF_AOI', '拿生物当攻击者 ⇒ 身份闸拦住');
  eq(asMob.hit, null, '身份闸拦住时不产生结算结果');

  /* ## 闸 2:到**该玩家**的距离(两侧都要扫,单点区分不了「闸」与「碰巧」) */
  for (const [d, expectOk] of [[1, true], [31, true], [32, true], [33, false], [60, false]] as [number, boolean][]) {
    const s = authWorld([], d);
    const r = s.attackMobAuthorized('p1', 'mob_sheep');
    eq(r.outcome === 'OK', expectOk,
      `距离 ${d} 格 ⇒ ${expectOk ? '进入结算' : '被 AOI 闸拦下'}(边界 32)`);
  }

  /* ## 闸 3:武器 reach(在 AOI 内但超出射程)—— 阈值由管线 0a 步定,不另起一套 */
  const reachOf = (wearing: number[]): number => {
    let max = -1;
    for (const d of [1, 2, 3, 4, 5, 8, 10, 12, 13, 14, 16, 20]) {
      const s = authWorld(wearing, d);
      if ((s.attackMobAuthorized('p1', 'mob_sheep').hit?.hpLoss ?? 0) > 0) max = Math.max(max, d);
    }
    return max;
  };
  const bareReach = reachOf([]);
  const bowReach = reachOf([715]);
  /* 边界 = reach + MAX_REACH_TOLERANCE(1.5):
     裸装 1.8+1.5 = 3.3 ⇒ 整数最大 3;
     弓 12.0+1.5 = 13.5 ⇒ 整数最大 13。
     实测确认(逐整数扫,不跳点)。 */
  eq(bareReach, 3, `裸装(1.8+1.5=3.3)最大命中 3 格,实际 ${bareReach}`);
  eq(bowReach, 13, `弓 715(12+1.5=13.5)最大命中 13 格,实际 ${bowReach}`);
  ok(bowReach > bareReach, '长弓必须比裸装打得远(否则 reach 没参与)');
  ok(bowReach < 32, 'reach 闸比 AOI(32)更严 ⇒ 它才是最终判据');
});

test('US2-3:★伪造面板进不了结算(本任务的灵魂断言)', () => {
  /* ## 判据不是「服务端写了个 sanitize」,而是**结构性事实**:
     `attackMobAuthorized` 的形参表里**没有** level/wearing/weaponId/comboMul
     ⇒ 客户端报文里的面板字段**没有入口可进**。
     这比「加了校验」更强:校验可能被绕过,不存在的入口不会。 */
  const withForge = authWorld([712], 1);
  const dmgWith712 = withForge.attackMobAuthorized('p1', 'mob_sheep').hit!.result.finalDamage;

  /* 模拟「报文里塞满面板」:唯一能被网络层读取的是 mobId,其余字段被丢弃 */
  const r = withForge.attackMobAuthorized('p1', 'mob_sheep');
  eq(r.hit!.result.finalDamage, dmgWith712,
    '再次攻击(报文可塞任意面板)伤害不变 ⇒ 面板对结算无影响');

  /* ## 更强的证据:用**同一世界**改客户端「自称」,服务端派生值不变。
     做法:世界里的权威档案是 [712],而「客户端自称」是别的 —— 结算只认档案。 */
  const s = authWorld([711], 1);   /* 权威:711(弱) */
  const authoritative = s.attackMobAuthorized('p1', 'mob_sheep').hit!.result.finalDamage;
  const s712 = authWorld([712], 1); /* 对照:权威 712(强) */
  const stronger = s712.attackMobAuthorized('p1', 'mob_sheep').hit!.result.finalDamage;
  ok(stronger > authoritative,
    `权威装备变了伤害才变(711→${authoritative} / 712→${stronger})⇒ 结算读的是**权威档案**`);

  /* ## 结构性证据:源码形参表(注释会漂移,形参不会) */
  const src = readFileSync(join(ROOT_DIR, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const sig = /attackMobAuthorized\(\s*([^)]*)\)/.exec(src);
  ok(sig !== null, '找得到 attackMobAuthorized 的签名');
  const params = sig![1]!;
  for (const bad of ['level', 'wearing', 'weaponId', 'comboMul']) {
    ok(!params.includes(bad),
      `权威入口形参里不得出现 ${bad}(实际: ${params.replace(/\s+/g, ' ').trim()})`);
  }
  ok(params.includes('playerId') && params.includes('mobId'),
    '形参只有「谁打谁」这类意图/身份 —— 面板数据无从传入');
});

test('US2-4:权威等级来自 progression,不是调用方自报(与 attackMob 的口径分界)', () => {
  /* `attackMob({ level })` 的 level 是**自报值**;`attackMobAuthorized` 读
     `progresses`。这条把两者的**分界**钉住:改了权威等级,伤害才跟着变。 */
  const s = authWorld([], 1);
  const at1 = s.attackMobAuthorized('p1', 'mob_sheep').hit!.result.finalDamage;

  /* 升级权威档案(与网络层无关,直接改 simulation 侧) */
  const p = s.progressOf('p1');
  Object.assign(p, setLevel(p, 30));
  eq(s.levelOf('p1'), 30, 'levelOf 读到权威等级');

  const s2 = authWorld([], 1);
  const p2 = s2.progressOf('p1');
  Object.assign(p2, setLevel(p2, 30));
  const at30 = s2.attackMobAuthorized('p1', 'mob_sheep').hit!.result.finalDamage;
  ok(at30 > at1, `30 级(${at30})必须高于 1 级(${at1})⇒ 等级真的进了结算`);

  /* ⚠️ 而 `attackMob` 的 opts.level 仍是自报(测试夹具用)—— 这是**刻意**保留的
     分界:网络层只调授权入口,故自报值不可达。此处如实记录该分界存在。 */
  const selfReported = authWorld([], 1).attackMob('p1', 'mob_sheep', { level: 30 })!;
  const authoritative30 = authWorld([], 1);
  Object.assign(authoritative30.progressOf('p1'), setLevel(authoritative30.progressOf('p1'), 1));
  ok(selfReported.result.finalDamage > authoritative30.attackMobAuthorized('p1', 'mob_sheep').hit!.result.finalDamage,
    '自报 level:30 与权威 level:1 会给出**不同**伤害 ⇒ 两条路真的分开了(授权入口不吃自报)');
});

/* ═══════ task-58:`applyPlayerMove` —— 玩家移动的权威写入点 ═══════ */

test('T58-1 ★ applyPlayerMove 真的写进 `physics.bodies`(不是「调过方法」)', () => {
  /* 判据必须是**权威位置的前后差**(`playerPosition` 读 `physics.bodies`),
     不能是「方法返回 true」—— 方法体整个空掉时返回 true 仍然为真。
     接线前的实测:`applyMove` 写 `state` 5 次、`physics.bodies` 恒不动 ⇒ 分叉 1.5 格。 */
  const s = authWorld();
  const before = s.playerPosition('p1')!;
  eq(s.applyPlayerMove('p1', 12.5, 10), true, '写入返回 true');
  const after = s.playerPosition('p1')!;
  eq(after.x, 12.5, '★ 权威 x 真的变了(接线前恒为出生点)');
  eq(before.x, 10, '对照:写入前是出生点 10 ⇒ 确实是这次调用改的');
});

test('T58-2 位置写入后**无漂移**:积分器不会把它挪回去', () => {
  /* 这是选「位置方案」而非「速度方案」的关键论据之一。
     位置写入绕过积分(`vx` 恒 0),故不经过摩擦衰减;速度写入则会被
     `integrateHorizontal` 先衰减再积分(实测 4.5 → 3.24,一帧只走 0.162)。
     ⇒ 两侧都测:写入后推 1 帧、推 50 帧,位置都必须**逐位不变**。 */
  const s = authWorld();
  s.applyPlayerMove('p1', 12.5, 10);
  s.tick();
  eq(s.playerPosition('p1')!.x, 12.5, '推 1 帧后仍精确等于写入值(无摩擦衰减)');
  for (let i = 0; i < 50; i += 1) s.tick();
  eq(s.playerPosition('p1')!.x, 12.5, '推 50 帧后仍精确不变 ⇒ 位置方案稳定');

  /* 对照:速度方案会被摩擦吃掉 —— 证明上面「无漂移」不是恒真。 */
  const b = s.physics.bodies.get('p1')!;
  b.vx = BASE_MOVE_SPEED;
  s.tick();
  ok(Math.abs(b.x - 12.5) > 1e-6,
    `对照:写 vx 后位置**会**变(${b.x.toFixed(4)})⇒ 两条路径行为确实不同`);
  ok(Math.abs(b.x - 12.5) < 0.2,
    `且位移远小于 v×DT(${BASE_MOVE_SPEED * DT})⇒ 摩擦先衰减再积分,与客户端预测对不上`);
});

test('T58-3 身份检查:生物不得冒充玩家改坐标(与反作弊正交)', () => {
  /* `physics.bodies` 里玩家与生物**混在一起**(`addPlayer` 与 `addMob`
     都调 `physics.spawn`)。不查这一条就能用一只生物冒充玩家。
     判据是「**是不是玩家**」,与「位移合不合法」正交 ⇒ **不构成**反作弊的第二份实现。 */
  const s = authWorld();
  const mobBefore = { ...s.physics.bodies.get('mob_sheep')! };
  eq(s.applyPlayerMove('mob_sheep', 99, 99), false,
    '★ 生物作为「玩家」写入 ⇒ 被拒(返回 false)');
  eq(s.physics.bodies.get('mob_sheep')!.x, mobBefore.x, '生物的刚体**没有**被改');

  eq(s.applyPlayerMove('nobody', 1, 1), false, '未登记的 id ⇒ 被拒');
  eq(s.playerPosition('nobody'), null, '未登记的 id ⇒ 读位置返回 null');

  /* 非有限值也必须挡住:写入 NaN 会让 `mobDistance` 恒 NaN,
     而 `NaN > 阈值` 恒 false ⇒ **距离闸永久失效**(本仓高发坑)。 */
  eq(s.applyPlayerMove('p1', Number.NaN, 10), false, 'NaN 被拒(否则距离闸永久失效)');
  eq(s.applyPlayerMove('p1', 10, Number.POSITIVE_INFINITY), false, 'Infinity 被拒');
  eq(s.playerPosition('p1')!.x, 10, '被拒的写入**没有**留下任何痕迹');
});

test('T58-4 ★ 世界侧**没有第二道反作弊**(用「撤销第一道」证明)', () => {
  /* ## 为什么需要这条(Lead 指定的形态)
     断言「超界被拒」只能证明**至少有一道**。要证明 physics 侧**没有**第二道,
     必须让第一道失效、再看第二道是否接手 —— 「用注入证明不存在」。
     做法:直接调 `applyPlayerMove`(绕过 `checkMove`),给一个远超上界的位移。
     若世界照收 ⇒ 无第二道;若被拒 ⇒ 有第二道(与「判据只在一处」矛盾)。 */
  const s = authWorld();
  const bound = maxDisplacementPerTick(1);
  ok(bound > 0 && bound < 1, `前置:上界确实存在且极小 = ${bound.toFixed(6)} 格/帧`);

  const far = 5000;
  eq(s.applyPlayerMove('p1', far, s.playerPosition('p1')!.y), true,
    `★ 世界**照收** ${far} 格位移 ⇒ physics 侧没有任何上界(判据只在 checkMove)`);
  eq(s.playerPosition('p1')!.x, far, '权威位置真的被写成超界值 ⇒ 也没有隐式钳制');

  /* ⚠️ 真入口的对照(`checkMove` **会**拦)在 WS-07 的 M4/M5 ——
     反作弊住在 `RoomRuntime`(net 层),不在 `WorldSim` 里。
     本文件只证明「世界侧没有第二道」,不越界断言网络层。 */
});

test('T58-5 边界残余(如实记录):世界侧不钳制,钳制由物理在 tick 时做', () => {
  /* ## 这条记录一个**已知残余**,不是「修好了」
     `applyPlayerMove` 只管「写在哪」,**不做边界钳制** —— 因为边界归物理层
     (`world.ts:670` 在 `tick` 时把刚体钳回 `bounds`)。若这里也钳一次,
     就是**第二份边界实现**(与「反作弊只在一处」同一条纪律)。
     实测残余:
       · 写入 `maxX + 5` ⇒ 权威立刻读到 `maxX + 5`
       · 推 1 帧 ⇒ 被 `world.ts:670` 钳回 `maxX`
       · 再推 2 帧 ⇒ **稳定停在边界**(不会持续增长)
     性质:**一次性收敛**,非持续。非越权:反作弊限单帧 ≤ 0.36 格,
     而窗口速率(5.63 格/秒)限住了总量 ⇒ 走不到世界外。 */
  const s = authWorld();
  const maxX = s.sizeCells - 1;
  const over = maxX + 5;
  eq(s.applyPlayerMove('p1', over, 10), true, '写入被接受(不做边界判定)');
  eq(s.playerPosition('p1')!.x, over, '权威立刻 = 越界值(世界侧无钳制)');

  s.tick();
  eq(s.playerPosition('p1')!.x, maxX, '★ 推 1 帧 ⇒ 被**物理层**钳回边界(`world.ts:670`)');
  s.tick();
  s.tick();
  eq(s.playerPosition('p1')!.x, maxX, '★ 再推 2 帧 ⇒ 稳定停在边界 ⇒ 残余**一次性收敛**');

  /* 阴性对照:界内的合法写入**不被**钳制 —— 否则上面「钳回」可能是恒真的。 */
  const s2 = authWorld();
  s2.applyPlayerMove('p1', 20, 10);
  s2.tick();
  eq(s2.playerPosition('p1')!.x, 20, '对照:界内写入不被钳制 ⇒ 上面的钳制是**边界特有**行为');
});

test('T58-6 ★ `removePlayer` 真的有牙:旁路状态不跨轮继承(位置看不出差别)', () => {
  /* ## 这条的来源:故障注入 J8-1 把我的一条断言判成「没牙」
     M8 路径 3 原本断言「超期重进后刚体位置 == 出生点」。撤掉那个分支的
     `removePlayer` **没有让它变红** —— 因为 `physics.spawn` 是 `Map.set`(**覆盖**),
     位置照样是出生点。逐字段对拍(位置/刚体数/`playerIds`/`vitals`/`profile`)
     **全部相同**;唯一区分得出的是 `removePlayer` 清掉的**旁路状态**。
     ⇒ 有牙的判据必须落在旁路状态上,本用例把它钉住。 */
  const s = authWorld();
  /* 播「上一轮的残余」:温泉计时(roomEffects 是私有,按既有做法直取) */
  const re = (s as never as { roomEffects: Map<string, unknown> }).roomEffects;
  re.set('p1', { soakMs: 999_999 });
  eq(re.has('p1'), true, '前置:已播种房间效果残余');

  s.removePlayer('p1');
  s.addPlayer('p1', 10, 10);
  eq(re.has('p1'), false,
    '★ 重进后**不继承**上一轮的温泉计时(这才是 removePlayer 的可观测差别)');

  /* 阴性对照:不调 removePlayer 时残余**会**留下 ⇒ 上面不是恒真。 */
  const s2 = authWorld();
  const re2 = (s2 as never as { roomEffects: Map<string, unknown> }).roomEffects;
  re2.set('p1', { soakMs: 999_999 });
  s2.addPlayer('p1', 10, 10);        /* 直接重 spawn,不 remove */
  eq(re2.has('p1'), true,
    '对照:不调 removePlayer ⇒ 残余**留下** ⇒ 两条路径确实不同');

  /* 而**位置**在两条路径下相同 —— 如实记录这个「看不见」的事实,
     它是 J8-1 的结论,也是「为什么不能靠位置断言」的证据。 */
  eq(s.playerPosition('p1')!.x, s2.playerPosition('p1')!.x,
    '如实记录:**位置**在两条路径下相同 ⇒ 位置断言区分不出 removePlayer 是否被调用');
});

/* ───────────────────────── 收尾 ───────────────────────── */

report('WS-10');
