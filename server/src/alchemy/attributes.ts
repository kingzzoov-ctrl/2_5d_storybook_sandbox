/**
 * WS-06 §5.3 五步确定性属性算法 + 双词条化学反应突变。
 *
 * 设计铁律:
 *  - LLM 只提供「定性」(类别 / 机制 / 外观 / 权重 / 契合度),**任何数值都不来自 LLM**;
 *  - 本文件是纯函数集合,零 I/O、零全局可变状态,所有随机性来自注入的 `rng`;
 *  - 同一 (输入, 种子) 必须逐位可复现,因此随机数的消耗顺序被严格固定:
 *      ① ε 截断正态(Box-Muller,每轮 2 次 rng)
 *      ② 化学反应突变(按 REACTION_RULES 表序,每条规则至多 1 次 rng)
 *      ③ 词条抽取(每条 1 次 rng)
 *  - 禁止 enum / 参数属性 / namespace,相对导入必须带 `.ts`。
 */

import {
  ALCHEMY_MAX_INPUTS,
  ALCHEMY_MIN_INPUTS,
  BETA_DEW,
  RARITY_LABEL,
  RarityTier,
  type ItemInstanceStats,
  type PrimaryMechanic,
  type SecondaryElement,
  type StatWeights,
} from '../../../shared/types/alchemy.ts';
import { ITEM_BY_ID } from '../../../shared/constants/items.ts';

/* ══════════════════════════════════════════════════════════════
 * 1. 参数配表(全部魔法数字集中于此,文档 §5 逐项标注出处)
 * ══════════════════════════════════════════════════════════════ */

/** T_eff 幂次聚合指数(手册 §5.3 第一步) */
export const AGG_EXPONENT = 1.35;
/** 多材料协同加成系数:每多 1 件材料 +12% */
export const K_BONUS_RATE = 0.12;
/**
 * 品质公式里的专精等级上限。
 * 手册 §5.3（L568）逐字给出 `Lv_prof ∈ [1, 10]`。
 *
 * ⚠️ 不要与 `MAX_LEVEL`(人物冒险等级上限 30,手册 §4.1 L451)混为一谈 ——
 * 二者是两个独立概念。此前本常量误取 30,使 `(1 + 0.02·Lv_prof)` 的上限
 * 从手册的 1.20 被抬到 1.60,品质加成上限虚高 33%。
 */
export const PROF_MAX_LEVEL = 10;
/** 每级专精给 2% 品质加成(手册 §5.3 L568) */
export const PROF_RATE_PER_LEVEL = 0.02;
/**
 * LLM 契合度的合法下限 / 上限(超出即钳制,防止越权放大数值)。
 * 手册 §5.3（L568）逐字给出 `S_logic ∈ [0.80, 1.50]`。
 */
export const S_LOGIC_MIN = 0.80;
export const S_LOGIC_MAX = 1.50;
/** 语义化别名:门禁/协议层统一用 FLOOR/CEIL 说话,定义仍以此处为唯一事实源 */
export const S_LOGIC_FLOOR = S_LOGIC_MIN;
export const S_LOGIC_CEIL = S_LOGIC_MAX;
/** 品质的硬上限,防止极端参数炸表 */
export const Q_MAX = 2.5;
/** P_budget = round(8.5 × T_eff^0.82 × Q) */
export const BUDGET_BASE = 8.5;
export const BUDGET_EXPONENT = 0.82;
export const BUDGET_MIN = 1;
export const BUDGET_MAX = 9999;
/** 四维切分系数(手册 §5.3 第四步) */
export const ATK_MUL = 1.2;
export const DEF_MUL = 0.6;
export const HP_MUL = 2.5;
export const IMPULSE_BASE = 3.0;
export const IMPULSE_MUL = 0.15;
export const UTIL_MUL = 0.4;
export const UTIL_CAP_PERCENT = 50;
/** 稀有度四档阈值:Q < 1.00 凡品 / < 1.25 奇巧 / < 1.55 秘宝 / ≥ 1.55 神来之笔 */
export const RARITY_THRESHOLDS: readonly [number, number, number] = [1.0, 1.25, 1.55];
/**
 * ε ~ 截断正态 N(1.0, 0.12²),截断区间 [0.80, 1.25]。
 *
 * **σ = 0.12 逐字取自手册 L568**:原文写
 * `\varepsilon \sim \mathcal{N}(1.0, 0.12^2) \in [0.80, 1.25]`。
 *
 * 本常量曾取 `0.122`(原注释写 `N(1.0, 0.122²)`,与常量自洽但与手册不符),
 * 比手册高约 1.7%。判定为**转写笔误**而非有意调优:
 *   - 手册公式里 `0.12^2` 的 `^2` 是「方差=σ²」的记号,σ 本身即 0.12;
 *   - 代码侧无任何注释、推导或标定记录支持 0.122;
 *   - 差异小到不影响任何分档概率 ⇒ 也不像是为调参引入的。
 * 故按手册改回 0.12。(若日后确要为「截断后实际标准差」取别的值,
 * 必须写明推导,不要留一个无出处的尾数。)
 */
export const EPSILON_MEAN = 1.0;
export const EPSILON_SIGMA = 0.12;
export const EPSILON_MIN = 0.8;
export const EPSILON_MAX = 1.25;
/** 截断正态最多重采 64 轮(理论拒绝率 < 12%,64 轮后仍失败的兜底为均值) */
export const EPSILON_MAX_ATTEMPTS = 64;
/** 权重和必须为 1 的容差 */
export const WEIGHT_SUM_TOLERANCE = 1e-6;

export interface NormalSpec {
  mean: number;
  sigma: number;
  min: number;
  max: number;
}

export const EPSILON_SPEC: NormalSpec = {
  mean: EPSILON_MEAN,
  sigma: EPSILON_SIGMA,
  min: EPSILON_MIN,
  max: EPSILON_MAX,
};

/* ══════════════════════════════════════════════════════════════
 * 2. 随机源(与 harness.mulberry32 位级一致,便于测试对照)
 * ══════════════════════════════════════════════════════════════ */

/**
 * Mulberry32。与 `shared/testing/harness.ts` 的 `mulberry32` 逐位一致,
 * 生产侧用本函数,测试侧可直接注入 harness 的实现,两者可互换。
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ══════════════════════════════════════════════════════════════
 * 3. 第一步:T_eff 幂次聚合
 * ══════════════════════════════════════════════════════════════ */

export interface PowerMeanBreakdown {
  /** 材料件数 k */
  k: number;
  /** 各材料的价值分 V_i */
  values: number[];
  /** 每项的 V_i^1.35 */
  powered: number[];
  /** Σ V_i^1.35 */
  poweredSum: number;
  /** (1/k)·Σ V_i^1.35 */
  poweredMean: number;
  /** 幂平均主体 = poweredMean^(1/1.35) */
  powerMean: number;
  /** 多材料协同乘子 (1 + 0.12(k−1)) */
  kMultiplier: number;
  /** T_eff */
  tEff: number;
}

/**
 * T_eff = (1/k · Σ V_i^1.35)^(1/1.35) × (1 + 0.12(k−1))
 *
 * 为什么用幂平均而不是算术平均:1.35 次幂会放大高价值材料的主导性,
 * 又不会像 max() 那样让低价值材料完全失效 —— 投入 4 件高价值材料
 * 必然比 2 件强,但塞垃圾件仍然会拖低结果,这正是「炼金」的手感。
 */
export function powerMeanBreakdown(values: readonly number[]): PowerMeanBreakdown {
  const k = values.length;
  if (k < ALCHEMY_MIN_INPUTS || k > ALCHEMY_MAX_INPUTS) {
    throw new Error(`材料件数 k=${k} 越界,必须∈[${ALCHEMY_MIN_INPUTS},${ALCHEMY_MAX_INPUTS}]`);
  }
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`材料价值分非法: ${v}`);
  }
  const powered = values.map((v) => Math.pow(v, AGG_EXPONENT));
  const poweredSum = powered.reduce((a, b) => a + b, 0);
  const poweredMean = poweredSum / k;
  const powerMean = Math.pow(poweredMean, 1 / AGG_EXPONENT);
  const kMultiplier = 1 + K_BONUS_RATE * (k - 1);
  const tEff = powerMean * kMultiplier;
  return { k, values: [...values], powered, poweredSum, poweredMean, powerMean, kMultiplier, tEff };
}

/** 便捷入口:只取 T_eff 标量。 */
export function effectiveValue(values: readonly number[]): number {
  return powerMeanBreakdown(values).tEff;
}

/** 材料 ID → 价值分数组(顺序即输入顺序,内部会按哈希无关的顺序取值;露水由调用方剥离)。 */
export function materialValues(itemIds: readonly number[]): number[] {
  return itemIds.map((id) => {
    const def = ITEM_BY_ID.get(id);
    if (!def) throw new Error(`未知物品 ID: ${id}`);
    return def.value;
  });
}

/* ══════════════════════════════════════════════════════════════
 * 4. 第二步:品质 Q(含 ε 截断正态)
 * ══════════════════════════════════════════════════════════════ */

/** Box-Muller + 拒绝采样,返回 [min,max] 内的正态样本;失败兜底为均值。 */
export function sampleTruncatedNormal(spec: NormalSpec, rng: () => number): number {
  for (let i = 0; i < EPSILON_MAX_ATTEMPTS; i += 1) {
    const u1 = rng();
    const u2 = rng();
    if (u1 <= 0) continue;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const x = spec.mean + spec.sigma * z;
    if (x >= spec.min && x <= spec.max) return x;
  }
  return Math.min(spec.max, Math.max(spec.min, spec.mean));
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export interface QualityBreakdown {
  /** LLM 给出的逻辑契合度(已钳制到 [0.60,1.30]) */
  sLogic: number;
  /** 专精等级(已钳制到 [0,30]) */
  lvProf: number;
  /** 是否投入梦境露水 */
  useDew: boolean;
  /** 露水加成 β_dew */
  betaDew: number;
  /** 1 + 0.02·Lv_prof + β_dew */
  profMultiplier: number;
  /** ε */
  epsilon: number;
  /** Q */
  q: number;
}

/**
 * Q = S_logic × (1 + 0.02·Lv_prof + β_dew) × ε
 *
 * S_logic 是 LLM 唯一的数值出口,但仍被钳制在 [0.80,1.50](手册 §5.3 L568):
 * 模型给 5.0 也不会变成 5 倍预算,彻底断掉「提示词刷属性」这条路。
 */
export function qualityBreakdown(
  sLogicRaw: number,
  lvProfRaw: number,
  useDew: boolean,
  epsilon: number,
): QualityBreakdown {
  const sLogic = clamp(sLogicRaw, S_LOGIC_MIN, S_LOGIC_MAX);
  const lvProf = Math.trunc(clamp(lvProfRaw, 0, PROF_MAX_LEVEL));
  const betaDew = useDew ? BETA_DEW : 0;
  const profMultiplier = 1 + PROF_RATE_PER_LEVEL * lvProf + betaDew;
  const eps = clamp(epsilon, EPSILON_MIN, EPSILON_MAX);
  const q = clamp(sLogic * profMultiplier * eps, 0, Q_MAX);
  return { sLogic, lvProf, useDew, betaDew, profMultiplier, epsilon: eps, q };
}

/* ══════════════════════════════════════════════════════════════
 * 5. 第三步:四档稀有度
 * ══════════════════════════════════════════════════════════════ */

export function rarityTierOf(q: number): RarityTier {
  if (!Number.isFinite(q) || q < RARITY_THRESHOLDS[0]) return RarityTier.COMMON;
  if (q < RARITY_THRESHOLDS[1]) return RarityTier.UNCOMMON;
  if (q < RARITY_THRESHOLDS[2]) return RarityTier.RARE;
  return RarityTier.LEGENDARY;
}

export function affixCountOf(tier: RarityTier, mutated: boolean): number {
  const base = RARITY_LABEL[tier]?.affixes ?? 1;
  return base + (mutated ? 1 : 0);
}

/* ══════════════════════════════════════════════════════════════
 * 6. 第四步:预算与四维切分
 * ══════════════════════════════════════════════════════════════ */

/** P_budget = round(8.5 × T_eff^0.82 × Q) */
export function budgetOf(tEff: number, q: number): number {
  if (!Number.isFinite(tEff) || tEff <= 0) throw new Error(`T_eff 非法: ${tEff}`);
  const raw = BUDGET_BASE * Math.pow(tEff, BUDGET_EXPONENT) * q;
  return clamp(Math.round(raw), BUDGET_MIN, BUDGET_MAX);
}

export interface SliceBreakdown {
  atkRaw: number;
  defRaw: number;
  hpRaw: number;
  impulseRaw: number;
  utilRaw: number;
  atk: number;
  def: number;
  hp: number;
  impulse: number;
  util: number;
}

export function weightsSum(w: StatWeights): number {
  return w.atk_weight + w.def_weight + w.impulse_weight + w.utility_weight;
}

/**
 * 四维切分:
 *   ATK  = round(P · w_atk · 1.2)
 *   DEF  = round(P · w_def · 0.6)
 *   HP   = round(P · w_def · 2.5)
 *   F_impulse = 3.0 + round(P · w_imp · 0.15)   ← round 作用于内层乘积
 *   Util%     = min(50, round(P · w_util · 0.4))
 */
export function splitBudget(budget: number, w: StatWeights): SliceBreakdown {
  const atkRaw = budget * w.atk_weight * ATK_MUL;
  const defRaw = budget * w.def_weight * DEF_MUL;
  const hpRaw = budget * w.def_weight * HP_MUL;
  const impulseRaw = budget * w.impulse_weight * IMPULSE_MUL;
  const utilRaw = budget * w.utility_weight * UTIL_MUL;
  return {
    atkRaw,
    defRaw,
    hpRaw,
    impulseRaw,
    utilRaw,
    atk: Math.round(atkRaw),
    def: Math.round(defRaw),
    hp: Math.round(hpRaw),
    /* 单位:格/秒。与 WS-02 THROW_SPEED_XY(投掷初速)同量纲但不同源,不可互换或相加。
       本字段是「击退冲量」——施加于目标后立刻并入其速度,随后按地形摩擦 μ 衰减;
       THROW_SPEED_XY 是「主动投掷被举起实体」的专属初速。两者绝不进入同一个公式。
       参见 docs/WS-06-alchemy.md §10-U1(Lead 已裁决)。 */
    impulse: IMPULSE_BASE + Math.round(impulseRaw),
    util: Math.min(UTIL_CAP_PERCENT, Math.round(utilRaw)),
  };
}

/* ══════════════════════════════════════════════════════════════
 * 7. 双词条化学反应突变(概率表)
 * ══════════════════════════════════════════════════════════════ */

export interface ReactionRule {
  id: string;
  /** 突变词条中文名(会作为额外词条挤进 affixes) */
  name: string;
  /** 两个必需机制标签(顺序无关) */
  pair: readonly [string, string];
  /** 触发概率 ∈ (0,1] */
  probability: number;
  /** 突变后强制覆盖的副元素 */
  element: SecondaryElement;
  /** 突变后强制覆盖的粒子光环 */
  aura: string;
  /** 权重增量(应用后重新归一化) */
  weightShift: StatWeights;
  /** 预算乘子(应用中位数取整前的浮点预算) */
  budgetMul: number;
  lore: string;
}

const ZERO_SHIFT: StatWeights = { atk_weight: 0, def_weight: 0, impulse_weight: 0, utility_weight: 0 };

/**
 * 化学反应表。规则按声明序判定:每条规则若两个标签都齐备,就消耗 1 次 rng;
 * 第一条掷中的规则生效,**一次合成最多 1 个突变**。
 * 全表命中率(至少触发一次)= 1 − Π(1 − p_s),由测试用蒙特卡洛断言。
 */
export const REACTION_RULES: readonly ReactionRule[] = [
  {
    id: 'STEAM_DASH', name: '蒸汽冲刺', pair: ['极滑', '火焰'], probability: 0.55,
    element: 'FIRE', aura: 'FLAME',
    weightShift: { atk_weight: -0.05, def_weight: -0.05, impulse_weight: 0.1, utility_weight: 0 },
    budgetMul: 1.08,
    lore: '滑溜溜的皮在火上一烤,嘶——整把武器冒着白汽往前窜。',
  },
  {
    id: 'ICE_RINK', name: '镜面溜冰', pair: ['冰冻', '极滑'], probability: 0.5,
    element: 'ICE', aura: 'SNOW',
    weightShift: { atk_weight: -0.06, def_weight: 0, impulse_weight: 0.06, utility_weight: 0 },
    budgetMul: 1.05,
    lore: '冻得硬邦邦又滑得不讲理,踩上去的人全在跳圆舞曲。',
  },
  {
    id: 'SPRING_COIL', name: '雷纹弹簧', pair: ['导电', '高弹'], probability: 0.45,
    element: 'LIGHTNING', aura: 'SPARKLE',
    weightShift: { atk_weight: 0.04, def_weight: -0.04, impulse_weight: 0, utility_weight: 0 },
    budgetMul: 1.12,
    lore: '一弹一跳之间噼啪作响,像一群小雷电在弹簧上蹦床。',
  },
  {
    id: 'PRISM_MIRAGE', name: '棱光幻影', pair: ['发光', '致幻'], probability: 0.4,
    element: 'LIGHT', aura: 'SPARKLE',
    weightShift: { atk_weight: 0, def_weight: -0.03, impulse_weight: 0, utility_weight: 0.03 },
    budgetMul: 1.1,
    lore: '光被打散成七瓣,看久了会忘了自己本来要打谁。',
  },
  {
    id: 'GOO_BLAST', name: '黏胶轰雷', pair: ['爆炸', '强粘性'], probability: 0.6,
    element: 'STICKY', aura: 'SLIME_DRIP',
    weightShift: { atk_weight: 0.06, def_weight: -0.06, impulse_weight: 0, utility_weight: 0 },
    budgetMul: 1.14,
    lore: '炸完还黏在原地,清理它比打败它更花时间。',
  },
  {
    id: 'GRAND_CHOIR', name: '齐奏战歌', pair: ['音乐', '战歌'], probability: 0.35,
    element: 'NONE', aura: 'MUSIC_NOTES',
    weightShift: { atk_weight: -0.04, def_weight: 0.02, impulse_weight: 0, utility_weight: 0.02 },
    budgetMul: 1.06,
    lore: '一个人的口哨是口哨,四个人的口哨是出征。',
  },
  {
    id: 'STARBREAK', name: '崩星一击', pair: ['坚硬', '暴击'], probability: 0.3,
    element: 'NONE', aura: 'SPARKLE',
    weightShift: { atk_weight: 0.09, def_weight: -0.06, impulse_weight: -0.03, utility_weight: 0 },
    budgetMul: 1.18,
    lore: '硬到不讲道理的东西被敲中的那一瞬,连星星都听见了。',
  },
  {
    id: 'WARM_SNOW', name: '暖雪回春', pair: ['寒冷', '治愈'], probability: 0.5,
    element: 'ICE', aura: 'SNOW',
    weightShift: { atk_weight: -0.07, def_weight: 0.05, impulse_weight: 0, utility_weight: 0.02 },
    budgetMul: 1.07,
    lore: '凉丝丝地贴在伤口上,疼好像被雪轻轻抱走了一点。',
  },
  {
    id: 'STAR_RAIL', name: '星轨炮', pair: ['魔导', '激光'], probability: 0.42,
    element: 'LIGHT', aura: 'SPARKLE',
    weightShift: { atk_weight: 0.07, def_weight: -0.05, impulse_weight: -0.02, utility_weight: 0 },
    budgetMul: 1.16,
    lore: '魔导回路把光拧成一根线,指向哪儿,哪儿就该躲开。',
  },
  {
    id: 'FLING_SLAM', name: '弹射摔跤', pair: ['摔跤', '击退'], probability: 0.48,
    element: 'BOUNCY', aura: 'BUBBLES',
    weightShift: { atk_weight: -0.02, def_weight: 0, impulse_weight: 0.08, utility_weight: -0.06 },
    budgetMul: 1.09,
    lore: '它不负责打倒你,它负责把你送到很远的地方去。',
  },
];

export interface ReactionHit {
  rule: ReactionRule;
  /** 掷点值,便于复盘 */
  roll: number;
}

/**
 * 按表序掷化学反应。返回首个命中规则(或 undefined)。
 * 随机数消耗次数 = 命中规则之前的规则数 + 1(未命中则 = 全部齐备规则的条数)。
 */
export function rollReaction(tags: readonly string[], rng: () => number): ReactionHit | undefined {
  const set = new Set(tags);
  for (const rule of REACTION_RULES) {
    if (!set.has(rule.pair[0]) || !set.has(rule.pair[1])) continue;
    const roll = rng();
    if (roll < rule.probability) return { rule, roll };
  }
  return undefined;
}

/** 把权重增量叠加后重新归一化,保证和恒为 1(下溢时回退到原权重)。 */
export function applyWeightShift(base: StatWeights, shift: StatWeights): StatWeights {
  const merged: StatWeights = {
    atk_weight: base.atk_weight + shift.atk_weight,
    def_weight: base.def_weight + shift.def_weight,
    impulse_weight: base.impulse_weight + shift.impulse_weight,
    utility_weight: base.utility_weight + shift.utility_weight,
  };
  const floor = 0.01;
  const safe = {
    atk_weight: Math.max(floor, merged.atk_weight),
    def_weight: Math.max(floor, merged.def_weight),
    impulse_weight: Math.max(floor, merged.impulse_weight),
    utility_weight: Math.max(floor, merged.utility_weight),
  };
  const sum = weightsSum(safe);
  if (!Number.isFinite(sum) || sum <= 0) return { ...base };
  const norm: StatWeights = {
    atk_weight: safe.atk_weight / sum,
    def_weight: safe.def_weight / sum,
    impulse_weight: safe.impulse_weight / sum,
    utility_weight: safe.utility_weight / sum,
  };
  /* 归一化残差补到最大项,消除浮点误差导致的 sum≠1 */
  const drift = 1 - weightsSum(norm);
  const keys: (keyof StatWeights)[] = ['atk_weight', 'def_weight', 'impulse_weight', 'utility_weight'];
  let maxKey: keyof StatWeights = 'atk_weight';
  for (const kk of keys) if (norm[kk] > norm[maxKey]) maxKey = kk;
  norm[maxKey] += drift;
  return norm;
}

/** 权重增量规格(供文档与测试引用) */
export const NO_WEIGHT_SHIFT: StatWeights = ZERO_SHIFT;

/* ══════════════════════════════════════════════════════════════
 * 8. 词条池与抽取
 * ══════════════════════════════════════════════════════════════ */

export const AFFIX_POOL: readonly string[] = [
  '锋利刻痕', '破盾尖啸', '暴烈尾焰', '跳跳弹簧', '冰霜纹路', '雷纹回路',
  '滑溜涂层', '甜甜余味', '回春绒毛', '黏糊护壁', '星火小尾', '风草缠绳',
  '叮咚余音', '云朵软垫', '硬壳边角', '荧光斑点',
];

/** 词条池的稳定抽取:按 rng 取下标,撞车则顺延,保证不重复。 */
export function pickAffixes(count: number, rng: () => number): string[] {
  const n = Math.max(0, Math.min(count, AFFIX_POOL.length));
  const used = new Set<number>();
  const out: string[] = [];
  let guard = 0;
  while (out.length < n && guard < AFFIX_POOL.length * 4) {
    guard += 1;
    const idx = Math.floor(rng() * AFFIX_POOL.length) % AFFIX_POOL.length;
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(AFFIX_POOL[idx]);
  }
  let cursor = 0;
  while (out.length < n && cursor < AFFIX_POOL.length) {
    if (!used.has(cursor)) {
      used.add(cursor);
      out.push(AFFIX_POOL[cursor]);
    }
    cursor += 1;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
 * 9. Roll 总装
 * ══════════════════════════════════════════════════════════════ */

export interface RollRequest {
  /** 已剥离露水的材料 ID(2~4 件) */
  materialIds: readonly number[];
  /** LLM / 降级器给出的逻辑契合度 */
  logicSynergyScore: number;
  /** LLM / 降级器给出的四维权重 */
  statWeights: StatWeights;
  /** 玩家炼金专精等级 */
  lvProf: number;
  /** 是否投入梦境露水 */
  useDew: boolean;
  /** 参与化学反应判定的标签集合(材料标签 ∪ 产物标签) */
  tags: readonly string[];
  /** 主机制(仅用于词条文案与突变覆盖) */
  primaryMechanic: PrimaryMechanic;
  /** 注入随机源;缺省时由 seed 构造 mulberry32 */
  rng?: () => number;
  /** 随机种子(仅当 rng 缺省时生效) */
  seed?: number;
}

export interface RollBreakdown {
  powerMean: PowerMeanBreakdown;
  quality: QualityBreakdown;
  tier: RarityTier;
  budgetRaw: number;
  budget: number;
  effectiveWeights: StatWeights;
  slices: SliceBreakdown;
  reaction?: ReactionHit;
  affixTarget: number;
}

export interface RollOutcome {
  /** 实例属性(除 instance_id / owner_id / recipe_hash 外全部填好) */
  stats: Omit<ItemInstanceStats, 'instance_id' | 'owner_id' | 'recipe_hash'> & {
    reaction_id?: string;
  };
  breakdown: RollBreakdown;
  /** 突变后的副元素覆盖值(未突变则为 null) */
  elementOverride: SecondaryElement | null;
  /** 突变后的光环覆盖值(未突变则为 null) */
  auraOverride: string | null;
}

/**
 * 五步算法总装。执行顺序固定为 ε → 突变 → 词条,保证种子可复现。
 */
export function rollStats(req: RollRequest): RollOutcome {
  const rng = req.rng ?? seededRng(req.seed ?? 1);
  const pm = powerMeanBreakdown(materialValues(req.materialIds));
  const epsilon = sampleTruncatedNormal(EPSILON_SPEC, rng);
  const quality = qualityBreakdown(req.logicSynergyScore, req.lvProf, req.useDew, epsilon);
  const tier = rarityTierOf(quality.q);

  const hit = rollReaction(req.tags, rng);
  const effectiveWeights = hit ? applyWeightShift(req.statWeights, hit.rule.weightShift) : { ...req.statWeights };

  const budgetRaw = BUDGET_BASE * Math.pow(pm.tEff, BUDGET_EXPONENT) * quality.q * (hit ? hit.rule.budgetMul : 1);
  const budget = clamp(Math.round(budgetRaw), BUDGET_MIN, BUDGET_MAX);
  const slices = splitBudget(budget, effectiveWeights);

  const affixTarget = affixCountOf(tier, Boolean(hit));
  const affixes = pickAffixes(affixTarget, rng);
  if (hit) affixes[affixes.length - 1] = hit.rule.name;

  const stats: RollOutcome['stats'] = {
    rarity_tier: tier,
    quality_score: quality.q,
    t_eff: pm.tEff,
    budget,
    rolled: {
      atk: slices.atk,
      def: slices.def,
      hp: slices.hp,
      impulse: slices.impulse,
      util: slices.util,
      affixes,
    },
    reaction_id: hit?.rule.id,
  };

  return {
    stats,
    breakdown: {
      powerMean: pm,
      quality,
      tier,
      budgetRaw,
      budget,
      effectiveWeights,
      slices,
      reaction: hit,
      affixTarget,
    },
    elementOverride: hit ? hit.rule.element : null,
    auraOverride: hit ? hit.rule.aura : null,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 10. 参数自检(启动期可跑,保证配表内部一致)
 * ══════════════════════════════════════════════════════════════ */

export interface ParamSelfCheck {
  ok: boolean;
  errors: string[];
}

export function selfCheckParams(): ParamSelfCheck {
  const errors: string[] = [];
  const ids = REACTION_RULES.map((r) => r.id);
  if (new Set(ids).size !== ids.length) errors.push('化学反应 id 重复');
  for (const r of REACTION_RULES) {
    if (!(r.probability > 0 && r.probability <= 1)) errors.push(`${r.id} 概率越界 ${r.probability}`);
    if (r.pair[0] === r.pair[1]) errors.push(`${r.id} 标签对自相同`);
    if (r.budgetMul < 1) errors.push(`${r.id} 预算乘子应 ≥1`);
  }
  if (RARITY_THRESHOLDS[0] >= RARITY_THRESHOLDS[1] || RARITY_THRESHOLDS[1] >= RARITY_THRESHOLDS[2]) {
    errors.push('稀有度阈值非递增');
  }
  if (EPSILON_SIGMA <= 0) errors.push('ε 标准差必须为正');
  return { ok: errors.length === 0, errors };
}