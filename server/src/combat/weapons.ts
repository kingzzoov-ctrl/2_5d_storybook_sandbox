/**
 * WS-10-A 战斗装备数据层(server/src/combat/weapons.ts)
 *
 * 覆盖 shared/constants/items.ts §3.10(701~745)全部 45 项:
 *   · 13 件武器(711~723)+ 1 件破盾工具(204)的完整数值与 [Q] 主动技表;
 *   · 5 件护甲(724~728)、2 件背饰/饰品(729/630)、2 件饰品(730/731);
 *   · 2 件团战消耗品(732/733);
 *   · 8 件 Boss 召唤祭品(734~741,与 bosses.ts 交叉校验);
 *   · 10 件狩猎材料(701~710)与 4 件辅助工具(742~745)。
 *
 * 冻结层约束:shared/** 只读;本文件只 import,不改动任何冻结符号。
 * 物品名称一律经 itemName() 取,杜绝二次硬编码。
 */

import { BASE_ATK } from '../../../shared/types/physics.ts';
import { MAX_LEVEL, statsAtLevel } from '../../../shared/types/entities.ts';
import { itemName } from '../../../shared/constants/items.ts';
import { BOSS_LIST } from '../../../shared/constants/bosses.ts';

export const WEAPON_ITEM_BASE_ATK = BASE_ATK;

/* ───────────────────────────── 属性元素与克制矩阵 ───────────────────────────── */

export const Element = {
  NONE: 'NONE',
  FIRE: 'FIRE',
  ICE: 'ICE',
  LIGHTNING: 'LIGHTNING',
  LIGHT: 'LIGHT',
  SLIME: 'SLIME',
} as const;
export type Element = (typeof Element)[keyof typeof Element];

export const ELEMENTS: readonly Element[] = ['NONE', 'FIRE', 'ICE', 'LIGHTNING', 'LIGHT', 'SLIME'];

export const ELEMENT_LABEL: Record<Element, string> = {
  NONE: '无属性',
  FIRE: '烈焰',
  ICE: '霜冻',
  LIGHTNING: '雷暴',
  LIGHT: '星光',
  SLIME: '胶质',
};

/**
 * 元素克制矩阵(行=攻击方,列=防御方)。
 * 四元环:烈焰 → 霜冻 → 雷暴 → 胶质 → 烈焰(1.5 克制、0.75 逆克、0.5 同抗);
 * 星光对胶质 1.5(果冻类),对自身同抗 0.5。
 */
export const ELEMENT_COUNTER: Record<Element, Record<Element, number>> = {
  NONE: { NONE: 1.0, FIRE: 1.0, ICE: 1.0, LIGHTNING: 1.0, LIGHT: 1.0, SLIME: 1.0 },
  FIRE: { NONE: 1.0, FIRE: 0.5, ICE: 1.5, LIGHTNING: 1.0, LIGHT: 1.0, SLIME: 0.75 },
  ICE: { NONE: 1.0, FIRE: 0.75, ICE: 0.5, LIGHTNING: 1.5, LIGHT: 1.0, SLIME: 1.25 },
  LIGHTNING: { NONE: 1.0, FIRE: 1.0, ICE: 0.75, LIGHTNING: 0.5, LIGHT: 1.0, SLIME: 1.5 },
  LIGHT: { NONE: 1.0, FIRE: 1.0, ICE: 1.0, LIGHTNING: 1.0, LIGHT: 0.5, SLIME: 1.5 },
  SLIME: { NONE: 1.0, FIRE: 1.5, ICE: 0.75, LIGHTNING: 0.5, LIGHT: 1.0, SLIME: 0.5 },
};

export function elementMul(atkElement: Element, defElement: Element): number {
  return ELEMENT_COUNTER[atkElement][defElement];
}

/* ───────────────────────────── 武器分类与技能形状 ───────────────────────────── */

export const WeaponKind = {
  SWORD_LIGHT: 'SWORD_LIGHT',
  SWORD_HEAVY: 'SWORD_HEAVY',
  DUAL_BLADE: 'DUAL_BLADE',
  BOW: 'BOW',
  STAFF: 'STAFF',
  HAMMER: 'HAMMER',
  FAN: 'FAN',
  SHIELD_HAMMER: 'SHIELD_HAMMER',
  SPEAR: 'SPEAR',
  CANNON: 'CANNON',
  TOOL: 'TOOL',
} as const;
export type WeaponKind = (typeof WeaponKind)[keyof typeof WeaponKind];

export const DamageType = {
  MELEE: 'MELEE',
  RANGED: 'RANGED',
  MAGIC: 'MAGIC',
  TERRAIN: 'TERRAIN',
} as const;
export type DamageType = (typeof DamageType)[keyof typeof DamageType];

export const SkillShape = {
  SELF: 'SELF',
  CIRCLE: 'CIRCLE',
  RECT: 'RECT',
  LINE: 'LINE',
  CONE: 'CONE',
  AREA: 'AREA',
  HOLD: 'HOLD',
} as const;
export type SkillShape = (typeof SkillShape)[keyof typeof SkillShape];

export interface SkillDef {
  /** 唯一技能键,用于冷却计时器字典 */
  key: string;
  /** [Q] 主动技显示名 */
  name: string;
  shape: SkillShape;
  /** 技能伤害倍率(乘在 基础 × 等级倍率 × 武器倍率 之上) */
  damageMul: number;
  /** 作用距离(格) */
  range: number;
  /** 作用半径/半宽(格) */
  radius: number;
  /** 多段命中段数 */
  hits: number;
  /** 段间间隔(秒),单段技能为 0 */
  tickSec: number;
  /** 首段延迟(秒),0 表示立即结算 */
  delaySec: number;
  /** 冷却(秒) */
  cooldown: number;
  /** 破盾倍率:对护盾池的伤害放大 */
  shieldBreakMul: number;
  /** 固定破甲值 */
  armorPen: number;
  /** 百分比破甲 */
  armorPenPct: number;
  /** 暴击率加成 */
  critBonus: number;
  /** 击退冲量倍率(乘在武器击退之上) */
  knockbackMul: number;
  /** 眩晕秒数 */
  stunSec: number;
  /** 冻结秒数(时停类) */
  freezeSec: number;
  /** 持续场秒数 */
  durationSec: number;
  /** 预警秒数(地面几何预警圈) */
  telegraphSec: number;
  /** 治疗量(治疗类技能) */
  healHp: number;
  /** 技能自带元素 */
  element: Element;
  /** 技能附加持续伤害 */
  dot: { element: Element; dps: number; sec: number } | null;
  /** 附加状态/召唤物自由字段 */
  extras: Record<string, number | string>;
  note: string;
}

export interface WeaponDef {
  id: number;
  name: string;
  kind: WeaponKind;
  damageType: DamageType;
  /** 面板攻击力加成(与 BASE_ATK 相加后成为总攻) */
  atk: number;
  /** 面板防御力加成(盾武) */
  def: number;
  /** 武器倍率:重剑 1.35 / 双刃 1.10 / 炮 1.50 … */
  attackMul: number;
  /** 攻速倍率(1.0 = 基准 1.0 次/秒) */
  speedMul: number;
  /** 攻击距离(格) */
  reach: number;
  /** 基础击退冲量(格/秒) */
  knockback: number;
  /** 击退倍率(719 为 3.0 即 +200%) */
  knockbackMul: number;
  element: Element;
  /** 固定穿透护甲 */
  armorPen: number;
  /** 护甲百分比穿透 */
  armorPenPct: number;
  /** 破盾倍率 */
  shieldBreakMul: number;
  /** 额外暴击率 */
  critBonus: number;
  /** 额外爆伤(1.5 = 150%) */
  critDmgBonus: number;
  /** 穿透目标数 */
  pierce: number;
  /** 命中附加 DoT */
  dot: { element: Element; dps: number; sec: number } | null;
  skill: SkillDef;
  passive: string;
}

function mkSkill(p: Partial<SkillDef> & { key: string; name: string; note: string }): SkillDef {
  return {
    shape: SkillShape.CIRCLE,
    damageMul: 1.0,
    range: 0,
    radius: 0,
    hits: 1,
    tickSec: 0,
    delaySec: 0,
    cooldown: 8,
    shieldBreakMul: 1.0,
    armorPen: 0,
    armorPenPct: 0,
    critBonus: 0,
    knockbackMul: 1.0,
    stunSec: 0,
    freezeSec: 0,
    durationSec: 0,
    telegraphSec: 0,
    healHp: 0,
    element: Element.NONE,
    dot: null,
    extras: {},
    ...p,
  };
}

function mkWeapon(p: Partial<WeaponDef> & { id: number; kind: WeaponKind; damageType: DamageType }): WeaponDef {
  const base: WeaponDef = {
    id: p.id,
    name: itemName(p.id),
    kind: p.kind,
    damageType: p.damageType,
    atk: 0,
    def: 0,
    attackMul: 1.0,
    speedMul: 1.0,
    reach: 1.8,
    knockback: 3.0,
    knockbackMul: 1.0,
    element: Element.NONE,
    armorPen: 0,
    armorPenPct: 0,
    shieldBreakMul: 1.0,
    critBonus: 0,
    critDmgBonus: 0,
    pierce: 0,
    dot: null,
    passive: '被动效果待配。',
    skill: mkSkill({ key: `q_${p.id}`, name: '未命名技能', note: '' }),
  };
  const merged: WeaponDef = { ...base, ...p };
  merged.name = itemName(p.id);
  return merged;
}

/* ───────────────────────────── 711~723 武器 ───────────────────────────── */

export const WEAPONS: readonly WeaponDef[] = [
  mkWeapon({
    id: 711, kind: WeaponKind.SWORD_LIGHT, damageType: DamageType.MELEE,
    atk: 12, attackMul: 1.00, speedMul: 1.1, reach: 1.6, knockback: 3.0,
    critBonus: 0.02, passive: '普攻三连挥砍(1.00 / 1.00 / 1.25 倍)。',
    skill: mkSkill({
      key: 'q_whirl', name: '旋风斩', shape: SkillShape.CIRCLE, damageMul: 1.4, radius: 1.6,
      cooldown: 6, knockbackMul: 2.0, note: '原地旋转一圈,击退周围 1.6 格内所有小怪。',
    }),
  }),
  mkWeapon({
    id: 712, kind: WeaponKind.SWORD_HEAVY, damageType: DamageType.MELEE,
    atk: 28, attackMul: 1.25, speedMul: 0.8, reach: 2.1, knockback: 4.5, knockbackMul: 1.2,
    armorPen: 8, shieldBreakMul: 1.5, critBonus: 0.03, critDmgBonus: 0.10,
    passive: '挥砍硬直更高;对护盾目标天然多吃破盾系数。',
    skill: mkSkill({
      key: 'q_shieldbreak', name: '破盾重劈', shape: SkillShape.RECT, damageMul: 2.2, range: 2.0,
      radius: 1.5, cooldown: 9, shieldBreakMul: 3.0, armorPen: 20, stunSec: 1.5, knockbackMul: 2.5,
      note: '向前跃起猛劈地面,震晕 2×3 格内敌人 1.5 秒。',
    }),
  }),
  mkWeapon({
    id: 713, kind: WeaponKind.SWORD_HEAVY, damageType: DamageType.MELEE,
    atk: 48, attackMul: 1.35, speedMul: 0.75, reach: 2.3, knockback: 5.0, knockbackMul: 1.3,
    element: Element.FIRE, armorPen: 12, shieldBreakMul: 1.5, critBonus: 0.05, critDmgBonus: 0.20,
    dot: { element: Element.FIRE, dps: 8, sec: 3 },
    passive: '火焰刀光:每次命中附加 8/s × 3s 灼烧。',
    skill: mkSkill({
      key: 'q_lavawave', name: '熔岩裂地斩', shape: SkillShape.LINE, damageMul: 2.6, range: 6.0,
      radius: 1.0, cooldown: 10, shieldBreakMul: 2.0, armorPen: 15, knockbackMul: 2.0,
      element: Element.FIRE, dot: { element: Element.FIRE, dps: 15, sec: 4 },
      note: '向前发出一道 6 格远、2 格宽的火浪,命中者附加 15/s × 4s 灼烧。',
    }),
  }),
  mkWeapon({
    id: 714, kind: WeaponKind.DUAL_BLADE, damageType: DamageType.MELEE,
    atk: 38, attackMul: 1.10, speedMul: 1.6, reach: 1.5, knockback: 2.5,
    armorPen: 6, shieldBreakMul: 1.2, critBonus: 0.10, critDmgBonus: 0.15, pierce: 1,
    passive: '攻速极快(1.6×),连击第三段额外 +0.20 倍率。',
    skill: mkSkill({
      key: 'q_phantom_dash', name: '幻影突袭', shape: SkillShape.LINE, damageMul: 1.8, range: 5.0,
      radius: 0.9, cooldown: 7, armorPen: 10, stunSec: 1.0,
      extras: { grab: 1, throwRange: 6, dashSec: 0.35 },
      note: '化作残影向前穿梭 5 格,抓起路径上 1 只眩晕小怪扔向 6 格外。',
    }),
  }),
  mkWeapon({
    id: 715, kind: WeaponKind.BOW, damageType: DamageType.RANGED,
    atk: 18, attackMul: 1.00, speedMul: 0.9, reach: 12.0, knockback: 2.0, knockbackMul: 0.8,
    armorPen: 2, shieldBreakMul: 0.8, critBonus: 0.05, critDmgBonus: 0.15,
    passive: '支持移动中蓄力射击,满蓄力 +0.35 倍率。',
    skill: mkSkill({
      key: 'q_triple_shot', name: '三连散射', shape: SkillShape.CONE, damageMul: 0.8, range: 10.0,
      radius: 0.5, hits: 3, cooldown: 5, extras: { coneDeg: 45 },
      note: '扇形 45° 射出 3 支竹箭,每支 0.8 倍率。',
    }),
  }),
  mkWeapon({
    id: 716, kind: WeaponKind.BOW, damageType: DamageType.RANGED,
    atk: 42, attackMul: 1.15, speedMul: 0.85, reach: 16.0, knockback: 2.5, knockbackMul: 0.9,
    element: Element.LIGHT, armorPen: 8, armorPenPct: 0.10, shieldBreakMul: 1.0,
    critBonus: 0.08, critDmgBonus: 0.25, pierce: 2,
    passive: '箭矢穿透 2 个目标,每额外穿透一个 −15% 伤害。',
    skill: mkSkill({
      key: 'q_arrow_rain', name: '箭雨天降', shape: SkillShape.AREA, damageMul: 0.55, range: 14.0,
      radius: 2.0, hits: 6, tickSec: 0.5, cooldown: 14, durationSec: 3.0, element: Element.LIGHT,
      extras: { areaSize: '4x4', arrowCount: 12 },
      note: '在目标 4×4 区域降下持续 3 秒星光箭雨,每 0.5 秒结算 0.55 倍率,共 6 段。',
    }),
  }),
  mkWeapon({
    id: 717, kind: WeaponKind.STAFF, damageType: DamageType.MAGIC,
    atk: 20, attackMul: 1.00, speedMul: 1.0, reach: 10.0, knockback: 1.5, knockbackMul: 0.6,
    element: Element.LIGHT, critBonus: 0.03, critDmgBonus: 0.20,
    passive: '发射自动微追踪星光弹,等效命中率 +30%。',
    skill: mkSkill({
      key: 'q_heal_circle', name: '治愈春风圈', shape: SkillShape.CIRCLE, damageMul: 0,
      radius: 5.0, cooldown: 12, healHp: 60, element: Element.LIGHT, extras: { targetAllies: 1 },
      note: '为周围 5 格内所有队友恢复 60 HP。',
    }),
  }),
  mkWeapon({
    id: 718, kind: WeaponKind.STAFF, damageType: DamageType.MAGIC,
    atk: 52, attackMul: 1.20, speedMul: 0.7, reach: 14.0, knockback: 3.0,
    element: Element.LIGHT, armorPen: 10, armorPenPct: 0.15, shieldBreakMul: 1.4,
    critBonus: 0.06, critDmgBonus: 0.30,
    passive: '技能冷却额外缩减 10%。',
    skill: mkSkill({
      key: 'q_meteor', name: '陨石星落', shape: SkillShape.CIRCLE, damageMul: 4.0, range: 14.0,
      radius: 3.5, cooldown: 18, telegraphSec: 1.0, armorPen: 10, armorPenPct: 0.25,
      shieldBreakMul: 2.5, knockbackMul: 3.0, element: Element.LIGHT, extras: { launchZ: 2.5 },
      note: '1 秒地面预警后召唤 Q 版彩色流星,半径 3.5 格、4.0 倍率并弹飞目标 2.5 格高。',
    }),
  }),
  mkWeapon({
    id: 719, kind: WeaponKind.HAMMER, damageType: DamageType.MELEE,
    atk: 40, attackMul: 1.40, speedMul: 0.7, reach: 2.2, knockback: 6.0, knockbackMul: 3.0,
    element: Element.SLIME, armorPen: 5, shieldBreakMul: 2.0, critDmgBonus: 0.30,
    passive: '击退 +200%;命中时 25% 概率把自身弹起 1 格。',
    skill: mkSkill({
      key: 'q_jelly_slam', name: '果冻王泰山压顶', shape: SkillShape.CIRCLE, damageMul: 3.0,
      range: 3.0, radius: 3.0, cooldown: 16, knockbackMul: 2.5, element: Element.SLIME, stunSec: 1.2,
      extras: { jumpZ: 3, summonJelly: 4, jellyHp: 40, jellySec: 15 },
      note: '跃起至 Z=3 猛砸地面,召唤 4 只友好小果冻(40 HP / 15 秒)帮全队咬怪。',
    }),
  }),
  mkWeapon({
    id: 720, kind: WeaponKind.FAN, damageType: DamageType.MAGIC,
    atk: 46, attackMul: 1.15, speedMul: 1.0, reach: 8.0, knockback: 2.0, knockbackMul: 0.8,
    element: Element.LIGHT, armorPen: 6, armorPenPct: 0.10, shieldBreakMul: 1.0,
    critBonus: 0.05, critDmgBonus: 0.35, pierce: 1,
    passive: '普攻扇出三道回旋樱花风刃,回程再结算一次 0.5 倍率。',
    skill: mkSkill({
      key: 'q_petal_veil', name: '落英幻境', shape: SkillShape.SELF, damageMul: 0,
      radius: 6.0, cooldown: 20, durationSec: 5.0, element: Element.LIGHT,
      extras: { shieldRatio: 0.25, moveMul: 1.4, targetAllies: 1 },
      note: '全队获得 5 秒花瓣护盾(吸收 25% 最大生命的伤害,移速 +40%)。',
    }),
  }),
  mkWeapon({
    id: 721, kind: WeaponKind.SHIELD_HAMMER, damageType: DamageType.MELEE,
    atk: 45, def: 35, attackMul: 1.30, speedMul: 0.7, reach: 2.0, knockback: 4.0, knockbackMul: 1.2,
    armorPen: 8, shieldBreakMul: 1.8, critDmgBonus: 0.20,
    passive: 'DEF +35;持盾时正面额外减伤 20%。',
    skill: mkSkill({
      key: 'q_crystal_guard', name: '绝对防御紫晶盾', shape: SkillShape.HOLD, damageMul: 0,
      radius: 1.4, cooldown: 12, durationSec: 2.5,
      extras: { reflectMul: 1.0, blockMul: 1.0, frontOnly: 1 },
      note: '按住技能键架盾 2.5 秒,将 Boss 冲撞与弹幕 100% 反弹回去。',
    }),
  }),
  mkWeapon({
    id: 722, kind: WeaponKind.SPEAR, damageType: DamageType.MELEE,
    atk: 50, attackMul: 1.25, speedMul: 0.9, reach: 2.8, knockback: 3.5,
    armorPen: 15, armorPenPct: 0.15, shieldBreakMul: 1.6, critBonus: 0.04, critDmgBonus: 0.20,
    dot: { element: Element.NONE, dps: 12, sec: 5 },
    passive: '攻击附带中毒破甲:12/s × 5s,期间目标护甲额外 −10。',
    skill: mkSkill({
      key: 'q_quicksand', name: '流沙星璇', shape: SkillShape.CIRCLE, damageMul: 0.6, range: 5.0,
      radius: 5.0, hits: 5, tickSec: 0.5, cooldown: 14, durationSec: 2.5,
      extras: { pullSpeed: 3.5, pullRadius: 5, armorShred: 10 },
      note: '枪尖生成流沙漩涡,以 3.5 格/秒聚拢 5 格内怪物,每 0.5 秒 0.6 倍率。',
    }),
  }),
  mkWeapon({
    id: 723, kind: WeaponKind.CANNON, damageType: DamageType.RANGED,
    atk: 65, attackMul: 1.50, speedMul: 0.65, reach: 12.0, knockback: 4.0, knockbackMul: 1.1,
    element: Element.LIGHTNING, armorPen: 12, armorPenPct: 0.20, shieldBreakMul: 2.0,
    critBonus: 0.07, critDmgBonus: 0.40,
    passive: '电弧齿轮在怪物之间弹射 5 次,每次衰减 12%。',
    skill: mkSkill({
      key: 'q_time_field', name: '时间凝滞力场', shape: SkillShape.AREA, damageMul: 0.8, range: 8.0,
      radius: 3.0, cooldown: 22, freezeSec: 3.0, durationSec: 3.0, element: Element.LIGHTNING,
      extras: { areaSize: '6x6', freezeProjectiles: 1, tickSec: 1.0 },
      note: '展开 6×6 钟表结界,冻结圈内所有怪物与弹幕 3 秒。',
    }),
  }),
];

export const WEAPON_BY_ID: ReadonlyMap<number, WeaponDef> = new Map(WEAPONS.map((w) => [w.id, w]));

export function weaponById(id: number): WeaponDef | null {
  return WEAPON_BY_ID.get(id) ?? (id === 204 ? BREACH_PICK : null);
}

export function skillOf(id: number): SkillDef | null {
  const w = weaponById(id);
  return w ? w.skill : null;
}

/** 204 黑金爆破冲击镐:工具类武器,专司破晶甲盾。 */
export const BREACH_PICK: WeaponDef = mkWeapon({
  id: 204, kind: WeaponKind.TOOL, damageType: DamageType.MELEE,
  atk: 35, attackMul: 1.10, speedMul: 0.8, reach: 2.4, knockback: 3.5,
  armorPen: 15, armorPenPct: 0.10, shieldBreakMul: 4.0, critDmgBonus: 0.10,
  passive: '震波同时敲击前方 1×3 矿脉;对晶甲类护盾拥有 4.0 破盾倍率。',
  skill: mkSkill({
    key: 'q_quake', name: '震波敲击', shape: SkillShape.RECT, damageMul: 1.6, range: 2.4,
    radius: 1.5, cooldown: 6, shieldBreakMul: 4.0, armorPen: 25, stunSec: 0.8,
    note: '一击敲碎晶甲类怪物的护盾,并对 1×3 矩形内目标造成 1.6 倍率震波。',
  }),
});

/** 222 充气玩具大锤:对队友 0 伤害,固定 8 格/秒击退冲量。 */
export const PRANK_HAMMER_KNOCKBACK = 8.0;

/* ───────────────────────────── 装备槽与护甲/饰品 ───────────────────────────── */

export const ArmorSlot = {
  WEAPON: 'weapon',
  ARMOR: 'armor',
  HELM: 'helm',
  BOOTS: 'boots',
  RELIC: 'relic',
  CAPE: 'cape',
} as const;
export type ArmorSlot = (typeof ArmorSlot)[keyof typeof ArmorSlot];

export const ARMOR_SLOTS: readonly ArmorSlot[] = ['weapon', 'armor', 'helm', 'boots', 'relic', 'cape'];

export interface ArmorDef {
  id: number;
  name: string;
  slot: ArmorSlot;
  hpBonus: number;
  def: number;
  /** 闪避率加成,结算上限 0.75 */
  dodgeRate: number;
  critBonus: number;
  critDmgBonus: number;
  /** 词条减伤(乘区,728 = 0.30) */
  dmgReduce: number;
  /** 反伤倍率(相对实际承伤,728 = 1.50) */
  reflectMul: number;
  moveMul: number;
  /** 技能冷却乘数(<1 为缩减) */
  cdMul: number;
  keywords: string[];
  passive: string;
}

function mkArmor(p: Partial<ArmorDef> & { id: number; slot: ArmorSlot }): ArmorDef {
  const base: ArmorDef = {
    id: p.id,
    name: itemName(p.id),
    slot: p.slot,
    hpBonus: 0, def: 0, dodgeRate: 0, critBonus: 0, critDmgBonus: 0,
    dmgReduce: 0, reflectMul: 0, moveMul: 1.0, cdMul: 1.0, keywords: [], passive: '被动效果待配。',
  };
  const merged: ArmorDef = { ...base, ...p };
  merged.name = itemName(p.id);
  return merged;
}

export const ARMORS: readonly ArmorDef[] = [
  mkArmor({
    id: 724, slot: ArmorSlot.ARMOR, hpBonus: 40, def: 8, dodgeRate: 0.10, cdMul: 1.0,
    keywords: ['闪避', '轻甲'], passive: 'HP +40、DEF +8、闪避 +10%;翻滚冷却缩减 20%。',
  }),
  mkArmor({
    id: 725, slot: ArmorSlot.ARMOR, hpBonus: 100, def: 22, moveMul: 0.95,
    keywords: ['重甲', '抗硬直'], passive: 'HP +100、DEF +22;受击硬直减半。',
  }),
  mkArmor({
    id: 726, slot: ArmorSlot.ARMOR, hpBonus: 60, def: 14, cdMul: 0.75,
    keywords: ['冷却缩减', '治疗增幅'], passive: 'HP +60、DEF +14;技能冷却 −25%,治疗/护盾范围 +50%。',
  }),
  mkArmor({
    id: 727, slot: ArmorSlot.ARMOR, hpBonus: 120, def: 18,
    keywords: ['高弹', '弹飞'], passive: 'HP +120、DEF +18;受近战攻击时把攻击者弹飞 4 格。',
  }),
  mkArmor({
    id: 728, slot: ArmorSlot.ARMOR, hpBonus: 160, def: 32, dmgReduce: 0.30, reflectMul: 1.50,
    moveMul: 0.95, keywords: ['反伤', '减伤'],
    passive: 'HP +160、DEF +32;减免 30% 伤害,并将所受伤害的 150% 化作紫晶尖刺反伤周围敌人。',
  }),
  mkArmor({
    id: 729, slot: ArmorSlot.CAPE, moveMul: 1.10, keywords: ['吸血', '飞行'],
    passive: '移速 +10%;每次武器或技能命中野生怪物回复自身 3 HP。',
  }),
  mkArmor({
    id: 730, slot: ArmorSlot.RELIC, dodgeRate: 0.03, keywords: ['二段跳', '位移'],
    passive: '空中额外一次翻滚冲刺或二段跳,闪避 +3%。',
  }),
  mkArmor({
    id: 731, slot: ArmorSlot.RELIC, keywords: ['光环', '团队'],
    passive: '周围 8 格内每名同房队友提供 +5% 攻防,上限 +40%。',
  }),
  mkArmor({
    id: 630, slot: ArmorSlot.CAPE, def: 8, keywords: ['披风', 'UGC'],
    passive: 'DEF +8;背面实时展示玩家手绘 16×16 像素图案。',
  }),
];

export const ARMOR_BY_ID: ReadonlyMap<number, ArmorDef> = new Map(ARMORS.map((a) => [a.id, a]));

/** 套装:传奇系列 2 件套加成。 */
export interface SetBonusDef {
  key: string;
  name: string;
  members: readonly number[];
  atkMul: number;
  hpMul: number;
  dmgReduce: number;
  desc: string;
}

export const SET_BONUSES: readonly SetBonusDef[] = [
  {
    key: 'set_jelly_king', name: '果冻王弹跳套装', members: [719, 727],
    atkMul: 1.08, hpMul: 1.05, dmgReduce: 0, desc: '击退额外 +100%,弹跳高度 +1 格。',
  },
  {
    key: 'set_crystal_kraken', name: '深渊紫晶反伤套装', members: [721, 728],
    atkMul: 1.05, hpMul: 1.10, dmgReduce: 0.10, desc: '减伤叠至 40%,反伤 150% → 170%。',
  },
  {
    key: 'set_chronos', name: '发条时间套装', members: [723, 726],
    atkMul: 1.12, hpMul: 1.05, dmgReduce: 0, desc: '技能冷却再 −15%,时停延长 0.5 秒。',
  },
];

export function activeSets(equippedIds: readonly number[]): SetBonusDef[] {
  const owned = new Set(equippedIds);
  return SET_BONUSES.filter((s) => s.members.every((m) => owned.has(m)));
}

/* ───────────────────────────── 732~733 消耗品 ───────────────────────────── */

export const ConsumableKind = {
  HEAL_POTION: 'HEAL_POTION',
  REVIVE_ITEM: 'REVIVE_ITEM',
} as const;
export type ConsumableKind = (typeof ConsumableKind)[keyof typeof ConsumableKind];

export interface CombatConsumableDef {
  id: number;
  name: string;
  kind: ConsumableKind;
  healHp: number;
  cooldownSec: number;
  splashRadius: number;
  splashHeal: number;
  reviveRange: number;
  reviveFullHp: boolean;
  invulnSec: number;
  tossable: boolean;
  note: string;
}

export const COMBAT_CONSUMABLES: readonly CombatConsumableDef[] = [
  {
    id: 732, name: itemName(732), kind: ConsumableKind.HEAL_POTION, healHp: 100, cooldownSec: 8,
    splashRadius: 2.0, splashHeal: 50, reviveRange: 0, reviveFullHp: false, invulnSec: 0,
    tossable: true,
    note: '饮用后瞬间恢复 100 HP(冷却 8 秒);扔向残血队友触发 2 格范围溅射治疗 50 HP。',
  },
  {
    id: 733, name: itemName(733), kind: ConsumableKind.REVIVE_ITEM, healHp: 0, cooldownSec: 12,
    splashRadius: 0, splashHeal: 0, reviveRange: 6, reviveFullHp: true, invulnSec: 3.0,
    tossable: true,
    note: '扔向 6 格内的幽灵泡泡队友,满血复活并赋予 3 秒无敌。',
  },
];

export const CONSUMABLE_BY_ID: ReadonlyMap<number, CombatConsumableDef> = new Map(
  COMBAT_CONSUMABLES.map((c) => [c.id, c]),
);

/* ───────────────────────────── 701~745 全量索引(45 项覆盖) ───────────────────────────── */

export const CombatItemKind = {
  MATERIAL: 'MATERIAL',
  WEAPON: 'WEAPON',
  ARMOR: 'ARMOR',
  RELIC: 'RELIC',
  CONSUMABLE: 'CONSUMABLE',
  OFFERING: 'OFFERING',
  UTILITY: 'UTILITY',
} as const;
export type CombatItemKind = (typeof CombatItemKind)[keyof typeof CombatItemKind];

export interface CombatItemEntry {
  id: number;
  name: string;
  kind: CombatItemKind;
  /** WEAPON/ARMOR/RELIC/CONSUMABLE 指向具体定义表键;其余为用途标签 */
  ref: string;
  note: string;
}

const MATERIAL_NOTES: Record<number, string> = {
  701: '通用狩猎肉材,熬制加攻大锅汤 605 的核心。',
  702: '缝制轻甲 724、猎人箭袋与战鼓鼓面。',
  703: '锻造高破甲锯齿武器 714。',
  704: '果冻国王遗物,锻造传奇 719 / 727。',
  705: '千年垂枝妖狐遗物,锻造传奇 720。',
  706: '深渊晶甲巨蟹遗物,锻造传奇 721 / 728。',
  707: '黄金沙暴法老蝎遗物,锻造传奇 722。',
  708: '远古发条时间巨像遗物,锻造传奇 723。',
  709: '制作 729 吸血披风与滑翔翼。',
  710: '免燃料永久加热高炉,或锻造 713 烈焰附魔武器。',
};

const UTILITY_NOTES: Record<number, string> = {
  742: '宠物牵引丝带:跟随出战 / 留守牧场 / 帮背 8 格物品。',
  743: '坐骑鞍:骑乘陆行鸟或穿山甲,移速 +60%。',
  744: '怪物图鉴照相机:拍照收录后全房对该怪伤害永久 +10%。',
  745: '怪物生态诱捕笼:装入甜莓诱饵活捉小怪。',
};

function buildCombatIndex(): Map<number, CombatItemEntry> {
  const out = new Map<number, CombatItemEntry>();
  for (let id = 701; id <= 745; id += 1) {
    const name = itemName(id);
    if (MATERIAL_NOTES[id] !== undefined) {
      out.set(id, { id, name, kind: CombatItemKind.MATERIAL, ref: 'material', note: MATERIAL_NOTES[id] });
      continue;
    }
    if (UTILITY_NOTES[id] !== undefined) {
      out.set(id, { id, name, kind: CombatItemKind.UTILITY, ref: 'utility', note: UTILITY_NOTES[id] });
      continue;
    }
    const w = WEAPON_BY_ID.get(id);
    if (w) {
      out.set(id, { id, name: w.name, kind: CombatItemKind.WEAPON, ref: w.skill.key, note: w.passive });
      continue;
    }
    const a = ARMOR_BY_ID.get(id);
    if (a) {
      const isRelic = a.slot === ArmorSlot.RELIC || a.slot === ArmorSlot.CAPE;
      out.set(id, { id, name: a.name, kind: isRelic ? CombatItemKind.RELIC : CombatItemKind.ARMOR, ref: a.slot, note: a.passive });
      continue;
    }
    const c = CONSUMABLE_BY_ID.get(id);
    if (c) {
      out.set(id, { id, name: c.name, kind: CombatItemKind.CONSUMABLE, ref: c.kind, note: c.note });
      continue;
    }
    const boss = BOSS_LIST.find((b) => b.summonItem === id);
    if (boss) {
      out.set(id, {
        id, name, kind: CombatItemKind.OFFERING, ref: boss.id,
        note: `放置在对应祭坛召唤 ${boss.name}(Lv.${boss.level} / baseHp ${boss.baseHp})。`,
      });
      continue;
    }
    out.set(id, { id, name, kind: CombatItemKind.UTILITY, ref: 'misc', note: '战斗辅助物品。' });
  }
  return out;
}

export const COMBAT_ITEM_INDEX: ReadonlyMap<number, CombatItemEntry> = buildCombatIndex();
export const COMBAT_ITEM_RANGE: readonly number[] = Array.from(
  { length: 45 }, (_v, i) => 701 + i,
);

/* ───────────────────────────── 装备合计与派生属性 ───────────────────────────── */

export interface EquipSummary {
  atk: number;
  def: number;
  hpBonus: number;
  dodgeRate: number;
  critBonus: number;
  critDmgBonus: number;
  dmgReduce: number;
  reflectMul: number;
  moveMul: number;
  cdMul: number;
  knockbackMul: number;
  shieldBreakMul: number;
  armorPen: number;
  armorPenPct: number;
  atkMulFromSets: number;
  hpMulFromSets: number;
  /** 被动钩子:吸血、近战弹飞、二段跳、徽章光环等 */
  flags: Record<string, number>;
}

export const MAX_DODGE_RATE = 0.75;
export const MAX_CRIT_RATE = 1.0;
export const MAX_CRIT_DMG = 3.0;
export const BASE_CRIT_RATE = 0.05;
export const BASE_CRIT_DMG = 1.5;

/**
 * 普攻连段倍率(`comboMul`)的设计上界。
 *
 * ## 为什么需要一个上界
 *
 * `comboMul` 是伤害管线第一段里**唯一没有上界**的乘数:
 *
 * | 乘数 | 上界来源 |
 * |:---|:---|
 * | `levelMul` | `combatantStats` 钳 `Math.min(MAX_LEVEL, level)` |
 * | `weaponMul` | 查表 `weapon.attackMul`,武器表最大 1.5 |
 * | `skillMul` | 查表 `skill.damageMul` |
 * | `dodgeRate` | `Math.min(…, MAX_DODGE_RATE)` |
 * | `critRate` | `Math.min(1.0, …)` |
 * | `critDmg` | `Math.min(…, MAX_CRIT_DMG)` |
 * | `comboMul` | ❌ **无 —— 本常量补上** |
 *
 * 同一个公式里七个乘数六个有界、一个没有,这是**不一致**而不是设计。
 * 实测 `comboMul: 1e9` 让 `finalDamage` 从 14 涨到 **1.4e10**(约 1.0e9×)。
 *
 * ## 为什么是 3.0,而不是「查表」
 *
 * 手册**没有**定义连段倍率数值(全文扫 `连段|连招|第三段|三段` = 0 命中);
 * 倍率只散落在各武器的 `passive` 文案里,且**每把武器不同**:
 *
 * | 武器 | 声明 | 折算倍率 |
 * |:---|:---|:---|
 * | 711 | 普攻三连(1.00 / 1.00 / **1.25**) | 1.25 |
 * | 714 | 第三段额外 **+0.20** | 1.20 |
 * | 715 | 满蓄力 **+0.35** | 1.35 |
 * | 720 | 回程再结算 **0.5** 倍率 | 0.50 |
 *
 * ⇒ 合法值是**逐武器不同**的标量,不是全局离散集合
 *   (实测这几个值互不相同,任何「查 {1.00, 1.00, 1.25} 表」的实现都会
 *   把 714 合法的 1.20 与 720 合法的 0.50 一起**误拒**)。
 *
 * 因此采用与 `MAX_CRIT_DMG` **同一形态**:给一个宽松的设计上界,
 * 取值依据 = 已声明最大值 1.35 的约 2.2 倍,任何高于 3.0 的值都无法由
 * 现有武器表解释。这与 `MAX_CRIT_DMG = 3.0`(基础 1.5、表内加成上限约 2.0)
 * 的「宽松上界」口径一致。
 *
 * ## 非法值语义(与「夹取」不同)
 *
 * - **非数字 / `NaN` / `-Infinity`** ⇒ 退回 `1.0`(**拒绝**)。
 *   这些不是「太大了」,而是「根本不是一个倍率」,夹取无意义
 *   —— 这正是 CR-14 U2-b 的形态:`NaN` 让下游 `Math.max(MIN_DAMAGE, NaN)`
 *   产出 `NaN`,`hp` 被永久污染成 `NaN`,生物**永远打不死**。
 * - **有限但过大** ⇒ 夹到 `MAX_COMBO_MUL`(**夹取**)。
 * - **`+Infinity`** ⇒ 经 `Math.min` 自然夹到上界(与 `sanitizeMul` 同口径)。
 */
export const MAX_COMBO_MUL = 3.0;

/**
 * 消毒一个「自报倍率」标量(连段倍率等)。
 *
 * ## 为什么返回 `fallback` 而不是 `0`
 *
 * 与 `anticheat.ts` 的 `sanitizeMul` 同理:取 `0` 会让该次攻击恒为最小伤害,
 * 等于用坏输入把自己锁死;取 `fallback` 则退化为「没有这段加成」,
 * 攻击仍按基线正常结算。兜底**不构成放水面** —— 声明一个合法的上界值
 * 得到的结果与兜底不同,而非法值不再能放大任何东西。
 *
 * ## ⚠ 与 `server/src/net/anticheat.ts:242` 的 `sanitizeMul` 是同形函数
 *
 * 两者语义一致(非数字/`NaN`/`-Infinity` 退 `fallback`,其余夹到 `[0, max]`)。
 * `anticheat.ts` 那份是私有且面向「移速/攻速」域,本任务写域不含该文件,
 * 故此处独立实现并**显式登记这处重复**(不静默):将来若要收敛为单一实现,
 * 应把它提到共享模块并让两边同时引用 —— 属跨域改动,留给后续裁决。
 */
export function sanitizeMul(declared: unknown, fallback: number, max: number): number {
  if (typeof declared !== 'number') return fallback;
  if (Number.isNaN(declared) || declared === Number.NEGATIVE_INFINITY) return fallback;
  return Math.min(Math.max(0, declared), max);
}

/** 连段倍率消毒:见 `MAX_COMBO_MUL`。缺省与非法值都退回 `1.0`(无连段加成)。 */
export function sanitizeComboMul(declared: unknown): number {
  return sanitizeMul(declared, 1.0, MAX_COMBO_MUL);
}

export function emptySummary(): EquipSummary {
  return {
    atk: 0, def: 0, hpBonus: 0, dodgeRate: 0, critBonus: 0, critDmgBonus: 0,
    dmgReduce: 0, reflectMul: 0, moveMul: 1.0, cdMul: 1.0, knockbackMul: 1.0,
    shieldBreakMul: 1.0, armorPen: 0, armorPenPct: 0, atkMulFromSets: 1.0, hpMulFromSets: 1.0,
    flags: {},
  };
}

/**
 * 六部位装备合计。未识别的 ID 一律忽略(不抛错),便于客户端先行预览。
 * weapon 槽只取第一件命中武器(后装备的覆盖)。
 */
export function equipSummary(equippedIds: readonly number[]): EquipSummary {
  const s = emptySummary();
  let weaponTaken = false;
  for (const id of equippedIds) {
    const w = weaponById(id);
    if (w && !weaponTaken) {
      weaponTaken = true;
      s.atk += w.atk;
      s.def += w.def;
      s.critBonus += w.critBonus;
      s.critDmgBonus += w.critDmgBonus;
      s.knockbackMul = Math.max(s.knockbackMul, w.knockbackMul);
      s.shieldBreakMul = Math.max(s.shieldBreakMul, w.shieldBreakMul);
      s.armorPen += w.armorPen;
      s.armorPenPct = Math.max(s.armorPenPct, w.armorPenPct);
      s.flags.weaponId = w.id;
      s.flags.weaponAttackMul = w.attackMul;
      s.flags.weaponSpeedMul = w.speedMul;
      s.flags.weaponBaseKnockback = w.knockback;
      s.flags.weaponReach = w.reach;
      s.flags[`weaponElement_${w.element}`] = 1;
      continue;
    }
    const a = ARMOR_BY_ID.get(id);
    if (!a) continue;
    s.def += a.def;
    s.hpBonus += a.hpBonus;
    s.dodgeRate += a.dodgeRate;
    s.critBonus += a.critBonus;
    s.critDmgBonus += a.critDmgBonus;
    s.dmgReduce += a.dmgReduce;
    s.reflectMul += a.reflectMul;
    s.moveMul *= a.moveMul;
    s.cdMul *= a.cdMul;
    if (a.id === 729) s.flags.lifestealPerHit = 3;
    if (a.id === 727) s.flags.meleeBounceTiles = 4;
    if (a.id === 730) s.flags.airDash = 1;
    if (a.id === 731) {
      s.flags.allyAuraPer = 0.05;
      s.flags.allyAuraCap = 0.40;
      s.flags.allyAuraRadius = 8;
    }
    if (a.id === 725) s.flags.hitStunMul = 0.5;
    if (a.id === 724) s.flags.rollCdMul = 0.8;
    if (a.id === 726) s.flags.healRadiusMul = 1.5;
  }
  for (const set of activeSets(equippedIds)) {
    s.dmgReduce += set.dmgReduce;
    if (set.key === 'set_crystal_kraken') s.reflectMul = 1.70;
    if (set.key === 'set_chronos') s.cdMul *= 0.85;
    s.atkMulFromSets *= set.atkMul;
    s.hpMulFromSets *= set.hpMul;
    s.flags[`set_${set.key}`] = set.atkMul;
  }
  s.dodgeRate = Math.min(s.dodgeRate, MAX_DODGE_RATE);
  s.dmgReduce = Math.min(s.dmgReduce, 0.90);
  return s;
}

/* ───────────────────────────── 攻方面板 ───────────────────────────── */

export interface CombatantStats {
  level: number;
  baseAtk: number;
  totalAtk: number;
  maxHp: number;
  def: number;
  dodgeRate: number;
  critRate: number;
  critDmg: number;
  dmgReduce: number;
  reflectMul: number;
  moveMul: number;
  cdMul: number;
  knockbackMul: number;
  shieldBreakMul: number;
  armorPen: number;
  armorPenPct: number;
  flags: Record<string, number>;
}

export interface BuffInput {
  atkMul?: number;
  hpMul?: number;
  critRate?: number;
  critDmg?: number;
  /** 同房同心圆光环队友数量(731 徽章) */
  allyCount?: number;
}

export function combatantStats(
  level: number,
  equippedIds: readonly number[] = [],
  buffs: BuffInput = {},
): CombatantStats {
  const lv = Math.max(1, Math.min(MAX_LEVEL, level));
  const grow = statsAtLevel(lv);
  const eq = equipSummary(equippedIds);
  let aura = 0;
  if (eq.flags.allyAuraPer !== undefined) {
    aura = Math.min(eq.flags.allyAuraPer * Math.max(0, buffs.allyCount ?? 0), eq.flags.allyAuraCap);
  }
  const atkMul = (buffs.atkMul ?? 1.0) * (1 + aura);
  const hpMul = (buffs.hpMul ?? 1.0) * (1 + aura);
  return {
    level: lv,
    baseAtk: WEAPON_ITEM_BASE_ATK,
    totalAtk: (WEAPON_ITEM_BASE_ATK + eq.atk) * atkMul * eq.atkMulFromSets,
    maxHp: Math.round((grow.maxHp + eq.hpBonus) * hpMul * eq.hpMulFromSets),
    def: eq.def,
    dodgeRate: Math.min(eq.dodgeRate, MAX_DODGE_RATE),
    critRate: Math.min(Math.max(BASE_CRIT_RATE + eq.critBonus + (buffs.critRate ?? 0), 0), MAX_CRIT_RATE),
    critDmg: Math.min(BASE_CRIT_DMG + eq.critDmgBonus + (buffs.critDmg ?? 0), MAX_CRIT_DMG),
    dmgReduce: eq.dmgReduce,
    reflectMul: eq.reflectMul,
    moveMul: eq.moveMul,
    cdMul: eq.cdMul,
    knockbackMul: eq.knockbackMul,
    shieldBreakMul: eq.shieldBreakMul,
    armorPen: eq.armorPen,
    armorPenPct: eq.armorPenPct,
    flags: { ...eq.flags, allyAura: aura },
  };
}

/** 等级伤害倍率:dmgMul = 1 + 0.03 × (L − 1)。 */
export function levelDamageMul(level: number): number {
  return statsAtLevel(Math.max(1, Math.min(MAX_LEVEL, level))).dmgMul;
}

/* ───────────────────────────── 嘲讽/仇恨工具 ───────────────────────────── */

/** 242 大声公扩音喇叭:强制 8 格内怪物仇恨转向。 */
export const TAUNT_RADIUS = 8;
/** 251 黄金凯旋小号:全队暴击率 +15%。 */
export const KAIROS_CRIT_BONUS = 0.15;
