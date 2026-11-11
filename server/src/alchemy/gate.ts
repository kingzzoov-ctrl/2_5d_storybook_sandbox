/**
 * WS-06 §5.2 逻辑门禁 Tag Affinity Gate。
 *
 * 门禁解决一个具体问题:玩家会把「两块砖头」扔进炼金炉,然后要求大模型
 * 变出一把剑。LLM 什么都会顺着你说,所以必须在调用之前就用**纯规则**把
 * 没有骨架的组合挡掉,这就是「元素排斥」。
 *
 * 骨架 = 两个正交维度:
 *   ① 形态/载体(CARRIER_TAGS):这东西最终长成什么样子 —— 金属、木材、武器、药水瓶…
 *   ② 特性/机制(MECHANIC_TAGS):这东西会干什么 —— 极滑、火焰、极滑、击退、治疗…
 * 两个维度各至少命中 1 个,才允许进入 LLM 与属性 Roll。
 *
 * 亲白度(Affinity)是「这堆材料看起来多有戏」的启发式初判 ∈ [0,1]:
 * 它会被换算成给 LLM 的 s_logic 初值,并从源头抑制「硬凑材料也能出神品」。
 *
 * 补救通道:梦境露水(130)是混沌催化剂,可以在**只缺一个维度**时破格放行一次,
 * 且同一配方哈希只允许用一次 —— 露水是稀缺资源,不能变成作弊器。
 */

import {
  ALCHEMY_MAX_INPUTS,
  ALCHEMY_MIN_INPUTS,
  CARRIER_TAGS,
  DEW_ITEM_ID,
  MECHANIC_TAGS,
} from '../../../shared/types/alchemy.ts';
import { ITEM_BY_ID, itemName } from '../../../shared/constants/items.ts';
import { S_LOGIC_MAX, S_LOGIC_MIN } from './attributes.ts';

const CARRIER_SET: ReadonlySet<string> = new Set(CARRIER_TAGS);
const MECHANIC_SET: ReadonlySet<string> = new Set(MECHANIC_TAGS);

/* ══════════════════════════════════════════════════════════════
 * 1. 亲和度配表
 * ══════════════════════════════════════════════════════════════ */

/** 两个维度都齐备时的基础分 */
export const AFFINITY_BASE = 0.55;
/** 每多命中 1 个载体标签 +0.04(最多计 3 个) */
export const AFFINITY_CARRIER_STEP = 0.04;
export const AFFINITY_CARRIER_CAP = 3;
/** 每多命中 1 个机制标签 +0.03(最多计 4 个) */
export const AFFINITY_MECHANIC_STEP = 0.03;
export const AFFINITY_MECHANIC_CAP = 4;
/** 跨材料共享标签(「共鸣」)每个 +0.05,最多计 4 个 */
export const AFFINITY_RESONANCE_STEP = 0.05;
export const AFFINITY_RESONANCE_CAP = 4;
/** 材料件数奖励:k=3 +0.03,k=4 +0.06 */
export const AFFINITY_K_STEP = 0.03;
/** 亲和度下限(门禁通过时不应低于此值) */
export const AFFINITY_MIN = 0.0;
export const AFFINITY_MAX = 1.0;
/** s_logic 初值映射:0.75 + 0.45 × affinity,再钳制到 [S_LOGIC_MIN,S_LOGIC_MAX] */
export const S_LOGIC_BASE = 0.75;
export const S_LOGIC_SPAN = 0.45;
/** 边界常量的唯一事实源在 attributes.ts,这里只做语义化别名 */
export const S_LOGIC_FLOOR = S_LOGIC_MIN;
export const S_LOGIC_CEIL = S_LOGIC_MAX;

export const REJECT_SUBJECT = '元素排斥';
export const DEW_RELEASE_COST = DEW_ITEM_ID;

/* ══════════════════════════════════════════════════════════════
 * 2. 请求 / 结果结构
 * ══════════════════════════════════════════════════════════════ */

export interface GateRequest {
  /** 投入的物品 ID(可含露水;门禁会自动识别并把露水移出材料位) */
  itemIds: readonly number[];
  /** 玩家是否愿意/能够使用梦境露水破格放行 */
  offerDew?: boolean;
  /** 该配方哈希此前是否已用过露水破格(由调用方从缓存读取) */
  dewAlreadyUsed?: boolean;
  /** 玩家背包里是否真有露水(默认按 offerDew 推断) */
  hasDewInBag?: boolean;
}

export type GateCode =
  | 'PASS'
  | 'PASS_WITH_DEW'
  | 'K_OUT_OF_RANGE'
  | 'UNKNOWN_ITEM'
  | 'REPEATED_ITEM'
  | 'MISSING_CARRIER'
  | 'MISSING_MECHANIC'
  | 'MISSING_BOTH'
  | 'DEW_ALREADY_USED'
  | 'NO_DEW_IN_BAG'
  | 'NON_ALCHEMABLE';

export interface DewRelease {
  itemId: number;
  itemName: string;
  /** 破格放行消耗数量,固定 1 */
  amount: number;
  /** 本次破格补上的维度 */
  patches: 'CARRIER' | 'MECHANIC';
  /** 破格代价:品质折扣,放行成功但 Q 打折 */
  qualityPenalty: number;
  /** 人类可读说明 */
  note: string;
}

export interface GateResult {
  pass: boolean;
  code: GateCode;
  k: number;
  /** 材料物品 ID(已剥离露水、已升序) */
  materialIds: number[];
  /** 材料名称 */
  materialNames: string[];
  /** 是否本次请求含露水 */
  usesDew: boolean;
  /** 从材料位剥离出的露水件数 */
  dewStripped: number;
  carrierHits: string[];
  mechanicHits: string[];
  /** 跨材料共享的标签(共鸣) */
  resonanceTags: string[];
  /** 亲和度原始值 ∈ [0,1] */
  affinity_raw: number;
  /** 亲和度量化值(保留 3 位) */
  affinity: number;
  /** 建议的逻辑契合度初值,交给 LLM 作为参考、并在无网络时直接使用 */
  suggested_s_logic: number;
  /** 露水破格方案(失败且可用时非空) */
  dewRelease: DewRelease | null;
  /** 拒绝原因码列表 */
  reasons: GateCode[];
  /** 「元素排斥」玩家提示文案 */
  message: string;
}

/** 露水破格的品质折扣:放行但不白给,乘客还是要付出代价 */
export const DEW_RELEASE_QUALITY_PENALTY = 0.9;

/* ══════════════════════════════════════════════════════════════
 * 3. 工具
 * ══════════════════════════════════════════════════════════════ */

function uniqueSorted(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

/** 取出某物品命中 CARRIER_TAGS 的标签 */
export function carrierTagsOf(itemId: number): string[] {
  const def = ITEM_BY_ID.get(itemId);
  if (!def) return [];
  return def.tags.filter((t) => CARRIER_SET.has(t));
}

/** 取出某物品命中 MECHANIC_TAGS 的标签 */
export function mechanicTagsOf(itemId: number): string[] {
  const def = ITEM_BY_ID.get(itemId);
  if (!def) return [];
  return def.tags.filter((t) => MECHANIC_SET.has(t));
}

/** 跨材料共享标签:出现在 ≥2 个不同材料上的标签 */
export function resonanceTagsOf(materialIds: readonly number[]): string[] {
  const counts = new Map<string, number>();
  for (const id of materialIds) {
    const tags = ITEM_BY_ID.get(id)?.tags ?? [];
    for (const t of new Set(tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [tag, n] of counts) if (n >= 2) out.push(tag);
  return out.sort();
}

export function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* ══════════════════════════════════════════════════════════════
 * 4. 亲和度计算
 * ══════════════════════════════════════════════════════════════ */

export interface AffinityBreakdown {
  base: number;
  carrierBonus: number;
  mechanicBonus: number;
  resonanceBonus: number;
  kBonus: number;
  raw: number;
  affinity: number;
  suggestedSLogic: number;
}

/**
 * 亲和度聚合。仅在「双维度齐备」时有意义;缺维度直接给 0。
 * 公式:
 *   A = 0.55
 *     + 0.04 × min(|carrierHits|, 3)
 *     + 0.03 × min(|mechanicHits|, 4)
 *     + 0.05 × min(|resonanceTags|, 4)
 *     + 0.03 × (k − 2)
 *   钳制到 [0,1]
 *   S_logic 初值 = clamp(0.75 + 0.45 × A, 0.80, 1.50)
 */
export function affinityBreakdown(
  k: number,
  carrierHits: readonly string[],
  mechanicHits: readonly string[],
  resonanceTags: readonly string[],
  dualSatisfied: boolean,
): AffinityBreakdown {
  if (!dualSatisfied) {
    return { base: 0, carrierBonus: 0, mechanicBonus: 0, resonanceBonus: 0, kBonus: 0, raw: 0, affinity: 0, suggestedSLogic: S_LOGIC_FLOOR };
  }
  const carrierBonus = AFFINITY_CARRIER_STEP * Math.min(carrierHits.length, AFFINITY_CARRIER_CAP);
  const mechanicBonus = AFFINITY_MECHANIC_STEP * Math.min(mechanicHits.length, AFFINITY_MECHANIC_CAP);
  const resonanceBonus = AFFINITY_RESONANCE_STEP * Math.min(resonanceTags.length, AFFINITY_RESONANCE_CAP);
  const kBonus = AFFINITY_K_STEP * Math.max(0, k - ALCHEMY_MIN_INPUTS);
  const raw = AFFINITY_BASE + carrierBonus + mechanicBonus + resonanceBonus + kBonus;
  const affinity = clampNum(raw, AFFINITY_MIN, AFFINITY_MAX);
  const suggestedSLogic = clampNum(S_LOGIC_BASE + S_LOGIC_SPAN * affinity, S_LOGIC_FLOOR, S_LOGIC_CEIL);
  return { base: AFFINITY_BASE, carrierBonus, mechanicBonus, resonanceBonus, kBonus, raw, affinity, suggestedSLogic };
}

/* ══════════════════════════════════════════════════════════════
 * 5. 门禁主流程
 * ══════════════════════════════════════════════════════════════ */

function rejectText(reasons: readonly GateCode[], detail: string): string {
  return `【${REJECT_SUBJECT}】${detail} ${reasons.includes('MISSING_BOTH') ? '既没有能成形的形体,也没有能发生的事。' : ''}提示:至少需要 1 件「形体/载体」(如金属、木材、药水瓶)+ 1 件带「特性/机制」(如极滑、火焰、治疗)的材料;或投入 1 份梦境露水破格放行。`.trim();
}

/**
 * 门禁判定。纯函数,零 I/O。
 * 露水既可作为「破格通行证」(offerDew),也会自动从材料位剥离;
 * 若玩家把露水当第 3 件材料硬塞进 k=2 的组合,它仍然只算催化剂,不占位。
 */
export function checkGate(req: GateRequest): GateResult {
  const reasons: GateCode[] = [];
  const rawIds = [...new Set(req.itemIds.map((n) => Math.trunc(n)))];
  if (rawIds.length !== req.itemIds.length) reasons.push('REPEATED_ITEM');

  const unknown = rawIds.filter((id) => !ITEM_BY_ID.has(id));
  const materialIds = rawIds.filter((id) => ITEM_BY_ID.has(id) && id !== DEW_ITEM_ID).sort((a, b) => a - b);
  const dewStripped = rawIds.filter((id) => id === DEW_ITEM_ID).length;
  const k = materialIds.length;
  /* 价值分为 0 的物品是「系统开关/标记物」(如 #218 工程安全帽),不是材料 */
  const nonAlchemable = materialIds.filter((id) => (ITEM_BY_ID.get(id)?.value ?? 0) <= 0);

  const carrierHits: string[] = [];
  const mechanicHits: string[] = [];
  for (const id of materialIds) {
    carrierHits.push(...carrierTagsOf(id));
    mechanicHits.push(...mechanicTagsOf(id));
  }
  const carriers = uniqueSorted(carrierHits);
  const mechanics = uniqueSorted(mechanicHits);
  const resonance = resonanceTagsOf(materialIds);
  const hasCarrier = carriers.length > 0;
  const hasMechanic = mechanics.length > 0;

  const base = (extra: Partial<GateResult>): GateResult => ({
    pass: false,
    code: 'PASS',
    k,
    materialIds,
    materialNames: materialIds.map((id) => itemName(id)),
    usesDew: false,
    dewStripped,
    carrierHits: carriers,
    mechanicHits: mechanics,
    resonanceTags: resonance,
    affinity_raw: 0,
    affinity: 0,
    suggested_s_logic: S_LOGIC_FLOOR,
    dewRelease: null,
    reasons,
    message: '',
    ...extra,
  });

  /* ① 硬性结构检查 */
  if (unknown.length > 0) reasons.push('UNKNOWN_ITEM');
  if (k < ALCHEMY_MIN_INPUTS || k > ALCHEMY_MAX_INPUTS) reasons.push('K_OUT_OF_RANGE');
  if (unknown.length > 0 || k < ALCHEMY_MIN_INPUTS || k > ALCHEMY_MAX_INPUTS) {
    const detail = unknown.length > 0
      ? `投料含未知物品:${unknown.join('、')}。`
      : `需要 ${ALCHEMY_MIN_INPUTS}~${ALCHEMY_MAX_INPUTS} 件材料,实际 ${k} 件。`;
    return base({ code: unknown.length > 0 ? 'UNKNOWN_ITEM' : 'K_OUT_OF_RANGE', message: `${detail}(未进入亲和度判定)` });
  }
  if (nonAlchemable.length > 0) {
    reasons.push('NON_ALCHEMABLE');
    const names = nonAlchemable.map((id) => itemName(id)).join('、');
    return base({
      code: 'NON_ALCHEMABLE',
      message: `【元素排斥】${names} 是随身开关/功能件,它不是材料,炉子怎么烧都不会化。请换一件真正的材料。`,
    });
  }

  const dualSatisfied = hasCarrier && hasMechanic;

  /* ② 双维度齐备 → 直接放行 */
  if (dualSatisfied) {
    const ab = affinityBreakdown(k, carriers, mechanics, resonance, true);
    return base({
      pass: true,
      code: 'PASS',
      affinity_raw: ab.raw,
      affinity: round3(ab.affinity),
      suggested_s_logic: round3(ab.suggestedSLogic),
      usesDew: dewStripped > 0,
      reasons: [],
      message: `【炉火正旺】亲和度 ${round3(ab.affinity)} / 建议契合度 ${round3(ab.suggestedSLogic)}。载体[${carriers.join('、')}] × 机制[${mechanics.join('、')}]${resonance.length > 0 ? ` · 共鸣[${resonance.join('、')}]` : ''}。`,
    });
  }

  /* ③ 单维缺失 → 视露水情况给破格方案 */
  const missing: 'CARRIER' | 'MECHANIC' | 'BOTH' = !hasCarrier && !hasMechanic ? 'BOTH' : !hasCarrier ? 'CARRIER' : 'MECHANIC';
  reasons.push(missing === 'BOTH' ? 'MISSING_BOTH' : missing === 'CARRIER' ? 'MISSING_CARRIER' : 'MISSING_MECHANIC');

  const detail = missing === 'CARRIER'
    ? `缺少「形体/载体」词条 —— 有机制(${mechanics.join('、')})但没东西把它装起来。`
    : missing === 'MECHANIC'
      ? `缺少「特性/机制」词条 —— 有形体(${carriers.join('、')})但它什么也不会做。`
      : '既没有形体/载体词条,也没有特性/机制词条。';

  if (missing === 'BOTH') {
    return base({ code: 'MISSING_BOTH', message: rejectText(reasons, `${detail}露水也补不上两个都空的骨架。`) });
  }

  const wantsDew = req.offerDew === true || dewStripped > 0;
  const bagHasDew = req.hasDewInBag ?? wantsDew;

  if (!wantsDew) {
    return base({ code: reasons[0], message: rejectText(reasons, detail) });
  }
  if (req.dewAlreadyUsed === true) {
    reasons.push('DEW_ALREADY_USED');
    return base({ code: 'DEW_ALREADY_USED', message: rejectText(reasons, `${detail}该配方已经用过一次梦境露水破格,同一配方只能用一次。`) });
  }
  if (!bagHasDew) {
    reasons.push('NO_DEW_IN_BAG');
    return base({ code: 'NO_DEW_IN_BAG', message: rejectText(reasons, `${detail}背包中没有梦境露水(#${DEW_ITEM_ID})。`) });
  }

  /* 破格放行:亲和度按「补齐后的理想命中」打 0.85 折,并且 Q 打折 */
  const patchedCarriers = missing === 'CARRIER' ? [...carriers, '露水补形'] : carriers;
  const patchedMechanics = missing === 'MECHANIC' ? [...mechanics, '混沌催化'] : mechanics;
  const ab = affinityBreakdown(k, patchedCarriers, patchedMechanics, resonance, true);
  const discountedAffinity = clampNum(ab.affinity * 0.85, 0, 1);
  return base({
    pass: true,
    code: 'PASS_WITH_DEW',
    affinity_raw: ab.raw * 0.85,
    affinity: round3(discountedAffinity),
    suggested_s_logic: round3(clampNum(S_LOGIC_BASE + S_LOGIC_SPAN * discountedAffinity, S_LOGIC_FLOOR, S_LOGIC_CEIL)),
    usesDew: true,
    dewRelease: {
      itemId: DEW_ITEM_ID,
      itemName: itemName(DEW_ITEM_ID),
      amount: 1,
      patches: missing,
      qualityPenalty: DEW_RELEASE_QUALITY_PENALTY,
      note: `投入 1 份梦境露水,补齐「${missing === 'CARRIER' ? '形体/载体' : '特性/机制'}」维度,本次放行;品质 Q ×${DEW_RELEASE_QUALITY_PENALTY}。`,
    },
    message: `【露水破格】${detail}一滴梦境露水落下,炉子咕噜一声认了。`,
  });
}

/* ══════════════════════════════════════════════════════════════
 * 6. 标签工具(供 prompt / degrade 复用)
 * ══════════════════════════════════════════════════════════════ */

export function collectTags(materialIds: readonly number[]): string[] {
  const out = new Set<string>();
  for (const id of materialIds) for (const t of ITEM_BY_ID.get(id)?.tags ?? []) out.add(t);
  return [...out].sort();
}

export function isCarrierTag(tag: string): boolean {
  return CARRIER_SET.has(tag);
}

export function isMechanicTag(tag: string): boolean {
  return MECHANIC_SET.has(tag);
}

export function gateSelfCheck(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (CARRIER_TAGS.length === 0) errors.push('CARRIER_TAGS 为空');
  if (MECHANIC_TAGS.length === 0) errors.push('MECHANIC_TAGS 为空');
  const overlap = CARRIER_TAGS.filter((t) => MECHANIC_SET.has(t));
  if (overlap.length > 0) errors.push(`载体与机制白名单重叠(门禁会被绕过):${overlap.join('、')}`);
  if (new Set(CARRIER_TAGS).size !== CARRIER_TAGS.length) errors.push('CARRIER_TAGS 内部重复');
  if (new Set(MECHANIC_TAGS).size !== MECHANIC_TAGS.length) errors.push('MECHANIC_TAGS 内部重复');
  return { ok: errors.length === 0, errors };
}