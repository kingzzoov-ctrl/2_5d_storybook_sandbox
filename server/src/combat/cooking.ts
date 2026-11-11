/**
 * WS-10-E 欢聚料理与恶作剧锅(server/src/combat/cooking.ts)
 *
 * 覆盖 shared/constants/items.ts §3.9 的 601~615(料理 / 驯养道具)+ 212 大铁铲。
 *
 * 核心机制:八人欢聚大汤锅(506)的双分支投料判定
 *   · 正常投料  → 按 604 的配方 {104:1, 124:2, 121:2} 出锅【星光萤火蘑菇汤 604】
 *   · 有人偷塞  → 命中整蛊投料表则改判为对应整蛊料理 607~611
 * 判定优先级固定为 PRANK_PRIORITY,与投料顺序无关,保证多人并发下可复现。
 */

import { itemName } from '../../../shared/constants/items.ts';

/* ───────────────────────────── 锅具 / 工具 ───────────────────────────── */

export const SOUP_POT_ID = 506;
export const KITCHEN_TABLE_ID = 507;
export const PIZZA_OVEN_ID = 508;
export const BIG_SHOVEL_ID = 212;
/** 212 大铁铲在锅边挥动:料理额外 +1 条战斗增益词条 */
export const SHOVEL_BONUS_KEYWORDS = 1;

/* ───────────────────────────── 分支与 buff 结构 ───────────────────────────── */

export const CookBranch = {
  NORMAL: 'NORMAL',
  PRANK: 'PRANK',
} as const;
export type CookBranch = (typeof CookBranch)[keyof typeof CookBranch];

/** 料理增益的完整数值结构:入场即写入,供战斗管线按帧读取。 */
export interface FoodBuff {
  key: string;
  sourceItemId: number;
  branch: CookBranch;
  /** 总时长(秒) */
  durationSec: number;
  /** 剩余时长(秒) */
  remainingSec: number;
  stacks: number;
  statMods: {
    /** 攻击乘区 */
    atkMul: number;
    /** 生命上限加值 */
    hpFlat: number;
    /** 防御加值 */
    defFlat: number;
    /** 移速乘区 */
    moveMul: number;
    /** 暴击率加值 */
    critRate: number;
    /** 爆伤乘区 */
    critDmg: number;
    /** 重力乘区(609 为 0.30) */
    gravityMul: number;
    /** 摩擦系数覆盖(610 为 0.96) */
    muOverride: number;
    /** 跳跃高度乘区(604 为 1.50) */
    jumpMul: number;
    /** 采集效率乘区 */
    gatherMul: number;
    /** 经验获取乘区(613 为 1.30) */
    expMul: number;
  };
  /** 状态开关类效果 */
  flags: Record<string, number | string | boolean>;
}

export interface FoodDef {
  id: number;
  name: string;
  branch: CookBranch;
  /** 料理站:506 大汤锅 / 508 披萨炉 / 505 炼金染缸 */
  station: number;
  /** 基础持续时间(秒),0 表示即时生效 */
  durationSec: number;
  /** 即时恢复 HP */
  instantHealHp: number;
  statMods: Partial<FoodBuff['statMods']>;
  flags: Record<string, number | string | boolean>;
  /** 整蛊判定所需的投料(仅 PRANK 分支) */
  prankTrigger?: Record<number, number>;
  note: string;
}

function mods(p: Partial<FoodBuff['statMods']> = {}): FoodBuff['statMods'] {
  return {
    atkMul: 1.0, hpFlat: 0, defFlat: 0, moveMul: 1.0, critRate: 0, critDmg: 1.0,
    gravityMul: 1.0, muOverride: 0, jumpMul: 1.0, gatherMul: 1.0, expMul: 1.0,
    ...p,
  };
}

/** 恶作剧判定优先级:列表靠前者优先命中。 */
export const PRANK_PRIORITY: readonly number[] = [607, 608, 609, 610, 611];

/* ───────────────────────────── 601~615 料理表 ───────────────────────────── */

export const FOODS: readonly FoodDef[] = [
  {
    id: 601, name: itemName(601), branch: CookBranch.NORMAL, station: SOUP_POT_ID,
    durationSec: 600, instantHealHp: 40,
    statMods: { moveMul: 1.15 }, flags: { drink: 1 },
    note: '立即恢复 40 HP,移动速度 +15%,持续 10 分钟。',
  },
  {
    id: 602, name: itemName(602), branch: CookBranch.NORMAL, station: PIZZA_OVEN_ID,
    durationSec: 600, instantHealHp: 0,
    statMods: { hpFlat: 30, gatherMul: 1.20 }, flags: {},
    note: '最大生命值 +30,伐木与采矿速度 +20%,持续 10 分钟。',
  },
  {
    id: 603, name: itemName(603), branch: CookBranch.NORMAL, station: PIZZA_OVEN_ID,
    durationSec: 600, instantHealHp: 0,
    statMods: { critRate: 0.15 }, flags: { dropDoubleChance: 0.35 },
    note: '暴击率 +15%;采集与打怪掉落物数量有 35% 概率翻倍。',
  },
  {
    id: 604, name: itemName(604), branch: CookBranch.NORMAL, station: SOUP_POT_ID,
    durationSec: 600, instantHealHp: 0,
    statMods: { jumpMul: 1.50 }, flags: { glow: true, fallStunImmune: true, soupBase: true },
    note: '全房饮用者散发柔和夜光,跳跃高度 +50% 且免疫跌落眩晕。',
  },
  {
    id: 605, name: itemName(605), branch: CookBranch.NORMAL, station: SOUP_POT_ID,
    durationSec: 600, instantHealHp: 0,
    statMods: { atkMul: 1.25 }, flags: { carryNoSlow: true, throwRangeBonus: 3, meleeOnly: true },
    note: '近战攻击力 +25%;举起队友或炸弹果时移速不衰减且投掷距离 +3 格。',
  },
  {
    id: 606, name: itemName(606), branch: CookBranch.NORMAL, station: PIZZA_OVEN_ID,
    durationSec: 900, instantHealHp: 0,
    statMods: {}, flags: { fireDotPerHit: 15, freezeImmune: true },
    note: '每次武器攻击附带 15 点火焰灼烧伤害,且免疫冰冻状态,持续 15 分钟。',
  },
  {
    id: 607, name: itemName(607), branch: CookBranch.PRANK, station: SOUP_POT_ID,
    durationSec: 300, instantHealHp: 0,
    statMods: { atkMul: 1.25 }, flags: { rocketFart: true, rocketEverySteps: 3, rocketDashTiles: 2 },
    prankTrigger: { 126: 2 },
    note: '+25% 攻击力,同时每走三步向前失控冲刺 2 格并喷出彩虹火苗(还会烧到身后的怪)。',
  },
  {
    id: 608, name: itemName(608), branch: CookBranch.PRANK, station: SOUP_POT_ID,
    durationSec: 60, instantHealHp: 0,
    statMods: {}, flags: { morph: 'CHICKEN', peckGroupAttack: true, chatNoise: true },
    prankTrigger: { 127: 1 },
    note: '全房间喝汤的人集体变成圆滚滚的小肥鸡 60 秒(可用鸡喙集体啄 Boss)。',
  },
  {
    id: 609, name: itemName(609), branch: CookBranch.PRANK, station: SOUP_POT_ID,
    durationSec: 240, instantHealHp: 0,
    statMods: { gravityMul: 0.30 }, flags: { bellyRound: true, floaty: true },
    prankTrigger: { 119: 2 },
    note: '肚子变圆、重力降低 70%,轻轻一跳就能飘在半空躲开地面怪物围攻。',
  },
  {
    id: 610, name: itemName(610), branch: CookBranch.PRANK, station: SOUP_POT_ID,
    durationSec: 240, instantHealHp: 0,
    statMods: { muOverride: 0.96 }, flags: { slide: true, uncontrolled: true },
    prankTrigger: { 125: 2 },
    note: '脚底自带滑冰效果(μ=0.96),全队边滑冰边砍 Boss。',
  },
  {
    id: 611, name: itemName(611), branch: CookBranch.PRANK, station: SOUP_POT_ID,
    durationSec: 300, instantHealHp: 0,
    statMods: {}, flags: { chatScale: 2.0, weaponSfx: 'MUSIC_BOX' },
    prankTrigger: { 124: 3 },
    note: '聊天文字放大抖动,每次挥剑发出清脆八音盒音效。',
  },
  {
    id: 612, name: itemName(612), branch: CookBranch.NORMAL, station: 505,
    durationSec: 0, instantHealHp: 80,
    statMods: {}, flags: { cleanse: true },
    note: '立即恢复 80 HP 并解除滑倒、中毒、变身、灼烧等一切负面/整蛊状态。',
  },
  {
    id: 613, name: itemName(613), branch: CookBranch.NORMAL, station: PIZZA_OVEN_ID,
    durationSec: 1200, instantHealHp: 0,
    statMods: { expMul: 1.30 }, flags: { shareCount: 8, teamBuff: true },
    note: '摆在地上供 8 人分食,全队获得 20 分钟经验获取 +30% 增益。',
  },
  {
    id: 614, name: itemName(614), branch: CookBranch.NORMAL, station: PIZZA_OVEN_ID,
    durationSec: 0, instantHealHp: 0,
    statMods: {}, flags: { tame: true },
    note: '喂给野生温顺动物或残血被击败的精英小怪,可直接驯化为跟随宠物。',
  },
  {
    id: 615, name: itemName(615), branch: CookBranch.NORMAL, station: 505,
    durationSec: 1800, instantHealHp: 0,
    statMods: {}, flags: { spriteEfficiencyMul: 2.0, spriteTarget: 'BOBO_SPIRIT' },
    note: '喂给波波森灵后,该森灵在接下来 30 分钟内收菜与协助捡战利品效率翻倍。',
  },
];

export const FOOD_BY_ID: ReadonlyMap<number, FoodDef> = new Map(FOODS.map((f) => [f.id, f]));

/* ───────────────────────────── 投料判定 ───────────────────────────── */

export interface CookInput {
  /** 投料:物品 ID -> 数量 */
  inputs: Record<number, number>;
  /** 是否使用 212 大铁铲(出锅料理额外 +1 条战斗词条) */
  shovelUsed?: boolean;
  /** 626 金牌大厨高高帽:持续时长翻倍 */
  chefHat?: boolean;
  /** 大锅火候是否被水浇灭(227 水枪/212 铲);true 则本次出锅失败 */
  fireOut?: boolean;
}

export interface CookResult {
  ok: boolean;
  /** 出锅料理(itemId);失败时为 0 */
  itemId: number;
  name: string;
  branch: CookBranch;
  /** 触发整蛊的投料明细 */
  prankTriggeredBy: Record<number, number> | null;
  /** 最终时长(应用 626 翻倍后的值) */
  durationSec: number;
  /** 完整 buff 结构,直接写进角色状态机 */
  buff: FoodBuff | null;
  /** 额外战斗词条(212 大铁铲) */
  bonusKeywords: string[];
  /** 被整蛊的玩家名单(由调用方填充,此处先记录应标记的 flag) */
  prankFlags: Record<string, number | string | boolean>;
  reason: string;
}

/** 212 大铁铲可附加的战斗增益词条池。 */
export const COMBAT_KEYWORD_POOL: readonly string[] = [
  'atk_pct', 'def_flat', 'hp_flat', 'crit_rate', 'crit_dmg', 'dodge_rate', 'knockback_mul',
];

const BONUS_KEYWORD_VALUE: Record<string, number> = {
  atk_pct: 0.05,
  def_flat: 4,
  hp_flat: 20,
  crit_rate: 0.03,
  crit_dmg: 0.10,
  dodge_rate: 0.02,
  knockback_mul: 0.10,
};

function matches(inputs: Record<number, number>, need: Record<number, number>): boolean {
  for (const [k, v] of Object.entries(need)) {
    if ((inputs[Number(k)] ?? 0) < v) return false;
  }
  return true;
}

/**
 * 老汤锅双分支判定。
 * 1 火灭(被 227 泡泡水枪或 212 大铁铲浇灭)→ 出锅失败;
 * 2 按 PRANK_PRIORITY 顺序扫描整蛊投料,命中即改判为整蛊料理;
 * 3 未命中整蛊 → 走正常配方判定,基准为 604 星光萤火蘑菇汤;
 * 4 应用 626 金牌大厨高高帽的时长翻倍与 212 大铁铲的额外战斗词条。
 */
export function cookSoup(input: CookInput): CookResult {
  const empty = (reason: string): CookResult => ({
    ok: false, itemId: 0, name: '', branch: CookBranch.NORMAL, prankTriggeredBy: null,
    durationSec: 0, buff: null, bonusKeywords: [], prankFlags: {}, reason,
  });

  if (input.fireOut === true) return empty('炉火已被浇灭,本次投料作废');

  const positive = Object.entries(input.inputs).filter(([, v]) => v > 0);
  if (positive.length === 0) return empty('投料为空');

  let branch = CookBranch.NORMAL;
  let food = FOOD_BY_ID.get(604)!;
  let prankTriggeredBy: Record<number, number> | null = null;
  let prankFlags: Record<string, number | string | boolean> = {};

  for (const id of PRANK_PRIORITY) {
    const def = FOOD_BY_ID.get(id);
    if (!def || !def.prankTrigger) continue;
    if (matches(input.inputs, def.prankTrigger)) {
      food = def;
      branch = CookBranch.PRANK;
      prankTriggeredBy = { ...def.prankTrigger };
      prankFlags = { ...def.flags };
      break;
    }
  }

  if (branch === CookBranch.NORMAL) {
    const normalRecipe: Record<number, number> = { 104: 1, 124: 2, 121: 2 };
    if (!matches(input.inputs, normalRecipe)) {
      return empty(`正常投料不足:需要 ${JSON.stringify(normalRecipe)}`);
    }
  }

  const bonusKeywords: string[] = [];
  if (input.shovelUsed === true) {
    const pick = COMBAT_KEYWORD_POOL[
      (food.id + input.shovelUsed * SHOVEL_BONUS_KEYWORDS) % COMBAT_KEYWORD_POOL.length
    ];
    bonusKeywords.push(pick);
  }

  const durationMul = input.chefHat === true ? 2 : 1;
  const durationSec = food.durationSec * durationMul;

  const statMods = mods(food.statMods);
  for (const k of bonusKeywords) {
    const v = BONUS_KEYWORD_VALUE[k] ?? 0;
    if (k === 'atk_pct') statMods.atkMul = Math.round((statMods.atkMul + v) * 1000) / 1000;
    else if (k === 'def_flat') statMods.defFlat += v;
    else if (k === 'hp_flat') statMods.hpFlat += v;
    else if (k === 'crit_rate') statMods.critRate = Math.round((statMods.critRate + v) * 1000) / 1000;
    else if (k === 'crit_dmg') statMods.critDmg = Math.round((statMods.critDmg + v) * 1000) / 1000;
  }

  const buff: FoodBuff = {
    key: `food_${food.id}`,
    sourceItemId: food.id,
    branch,
    durationSec,
    remainingSec: durationSec,
    stacks: 1,
    statMods,
    flags: { ...food.flags, ...Object.fromEntries(bonusKeywords.map((k) => [`kw_${k}`, BONUS_KEYWORD_VALUE[k] ?? 0])) },
  };

  return {
    ok: true,
    itemId: food.id,
    name: food.name,
    branch,
    prankTriggeredBy,
    durationSec,
    buff,
    bonusKeywords,
    prankFlags,
    reason: branch === CookBranch.PRANK
      ? `整蛊投料命中,改判为 ${food.name}`
      : '正常投料,出锅成功',
  };
}

/* ───────────────────────────── buff 计时与清洗 ───────────────────────────── */

export function tickFoodBuff(buff: FoodBuff, dt: number): { buff: FoodBuff; expired: boolean } {
  const remainingSec = Math.max(0, Math.round((buff.remainingSec - dt) * 1000) / 1000);
  return { buff: { ...buff, remainingSec }, expired: remainingSec <= 0 };
}

/** 612 冰爽薄荷净化饮 / 612:清空全部整蛊类 buff。 */
export function cleansePrankBuffs(buffs: readonly FoodBuff[]): FoodBuff[] {
  return buffs.filter((b) => b.branch !== CookBranch.PRANK);
}

/** 合并多个料理 buff 的乘区(乘区相乘,加值相加,flags 后写覆盖)。 */
export function mergeFoodBuffs(buffs: readonly FoodBuff[]): FoodBuff['statMods'] {
  const out = mods();
  for (const b of buffs) {
    out.atkMul *= b.statMods.atkMul;
    out.hpFlat += b.statMods.hpFlat;
    out.defFlat += b.statMods.defFlat;
    out.moveMul *= b.statMods.moveMul;
    out.critRate += b.statMods.critRate;
    out.critDmg *= b.statMods.critDmg;
    out.gravityMul *= b.statMods.gravityMul;
    if (b.statMods.muOverride > 0) out.muOverride = Math.max(out.muOverride, b.statMods.muOverride);
    out.jumpMul *= b.statMods.jumpMul;
    out.gatherMul *= b.statMods.gatherMul;
    out.expMul *= b.statMods.expMul;
  }
  return out;
}

/* ───────────────────────────── 212 大铁铲:灭火 ───────────────────────────── */

export const EXTINGUISH_RADIUS = 3.0;

export interface FireCell {
  x: number;
  y: number;
  /** 火势强度 [0,1],0 表示已熄灭 */
  intensity: number;
}

/**
 * 212 大铁铲/227 水枪灭火:3 格内所有火格强度直接归零。
 * 对高炉与汤锅分别返回「是否降温成功」与「本轮是否继续烹饪」。
 */
export function extinguishFire(
  cells: readonly FireCell[],
  originX: number,
  originY: number,
): { cells: FireCell[]; extinguished: number } {
  let extinguished = 0;
  const out = cells.map((c) => {
    const dist = Math.hypot(c.x - originX, c.y - originY);
    if (dist <= EXTINGUISH_RADIUS && c.intensity > 0) {
      extinguished += 1;
      return { ...c, intensity: 0 };
    }
    return { ...c };
  });
  return { cells: out, extinguished };
}