/**
 * WS-06 §5.6 无网络降级生成器。
 *
 * 触发场景(全部要在玩家眼里「看不出区别」):
 *   · LLM 网关 5xx / 超时 / 配额耗尽 / 被内容过滤拦掉;
 *   · JSON 结构连续 3 轮校验失败(MAX_RETRY 用尽);
 *   · 客户端连的是离线单机房间。
 *
 * 设计原则:**确定性 + 可读性优先**。它不假装自己聪明,
 * 而是用标签拼出一个「起码像那么回事」的名字、剪影与权重,
 * 保证合成流程、属性 Roll、像素立牌、入库冠名全部照常走完。
 *
 * 与 LLM 版本的关键差异(必须与 LLM 输出同构,才能共用下游):
 *  - logic_synergy_score 直接取门禁建议值(不随机,便于复现);
 *  - stat_weights 由剪影查表得到,再按亲和度微调;
 *  - pixel_icon_16x16 用 pixel_icon.ts 里该剪影的规范美术;
 *  - lore_description 用固定模板 + 标签拼接。
 */

import {
  type LLMAlchemyOutputSchema,
  type StatWeights,
} from '../../../shared/types/alchemy.ts';
import { isCarrierTag, isMechanicTag } from './gate.ts';
import { type PromptMaterial } from './prompt.ts';
import { canonicalArt } from './pixel_icon.ts';
import { S_LOGIC_CEIL, S_LOGIC_FLOOR } from './attributes.ts';

/** 降级器只需要材料的这四个字段,与 PromptMaterial 同构 */
export type PromptMaterialLike = PromptMaterial;

/**
 * 中性亲和度:取 0.7 使 `atkTilt = 0`,即「不做任何倾斜」。
 * 当上层拿不到门禁亲和度时回落到此值,保证权重表原样可用而非被 NaN 污染。
 */
export const NEUTRAL_AFFINITY = 0.7;

/* ══════════════════════════════════════════════════════════════
 * 1. 标签 → 前缀词 配表
 * ══════════════════════════════════════════════════════════════ */

/** 载体标签 → 名字前缀(形体质感) */
export const CARRIER_WORD: Record<string, string> = {
  木材: '木呆呆', 金属: '铁皮', 石材: '石头', 陶土: '陶罐', 沙材: '琉璃', 纤维: '绒线',
  菌类: '菇菇', 甜食: '糖霜', 水果: '蕉皮', 谷物: '麦香', 草药: '薄荷', 精华: '梦',
  武器: '老兵', 药水瓶: '玻璃瓶', 头饰: '花环', 鞋饰: '踢踢', 背饰: '披风', 腰饰: '腰鼓',
  乐器: '叮咚', 家具: '小凳', 地砖: '地板', 墙体: '墙头', 门窗: '窗棂', 屋顶: '屋檐',
  机关: '发条', 传感器: '触须', 载具: '车车', 流体发射: '水管', 手持: '握柄',
  盾牌: '护盾', 炸弹: '炮仗', 食物: '便当',
};

/** 机制标签 → 名字前缀(行为质感) */
export const MECHANIC_WORD: Record<string, string> = {
  极滑: '溜溜', 摔跤: '扑通', 爆炸: '噼啪', 火焰: '火尾', 高弹: '蹦蹦', 击退: '推推',
  冰冻: '冰晶', 寒冷: '凉凉', 发光: '荧光', 激光: '光束', 导电: '电纹', 变形: '变变',
  致幻: '幻彩', 音乐: '叮咚', 战歌: '战吼', 强粘性: '黏糊', 减速: '慢吞', 浮力: '浮浮',
  浮空: '飘飘', 飞行: '飞天', 声波: '嗡鸣', 治疗: '回春', 愈合: '新芽', 催熟: '催催',
  魔导: '魔导', 暴击: '暴烈', 坚硬: '硬壳', 抗爆: '抗炸', 锋利: '锋利', 保温: '暖手',
  恢复: '回血', 芳香: '香香', 治愈: '治愈', 中空: '空管', 弹性: '弯弯', 中空管状: '竹节',
  容器: '盛装', 可塑: '捏捏', 透明: '透亮', 折射: '棱光', 驱虫: '驱虫', 邀宠: '撒娇',
  自动采摘: '摘摘',
};

/* ══════════════════════════════════════════════════════════════
 * 2. 剪影选择规则(按优先级,命中即返回)
 * ══════════════════════════════════════════════════════════════ */

export interface SilhouetteRule {
  id: string;
  silhouette: LLMAlchemyOutputSchema['visual_style']['base_silhouette'];
  category: LLMAlchemyOutputSchema['item_category'];
  /** 任一命中即算 */
  anyTags: readonly string[];
  /** 机制倾向(用于 DMG/权重表) */
  mechanic: LLMAlchemyOutputSchema['primary_mechanic'];
}

/**
 * 规则表按声明序匹配,越靠前优先级越高。
 * 「炸弹」「爆炸」之类破坏性词条排在前面,避免被「金属」抢先判定成大剑。
 */
export const SILHOUETTE_RULES: readonly SilhouetteRule[] = [
  { id: 'BOMB', silhouette: 'BOMB', category: 'TRAP_GADGET', anyTags: ['炸弹', '爆炸', '催熟'], mechanic: 'ROCKET_FART' },
  { id: 'POTION', silhouette: 'POTION', category: 'CONSUMABLE', anyTags: ['药水瓶', '容器', '流体发射', '治疗', '治愈', '恢复', '愈合', '芳香', '草药', '精华'], mechanic: 'HEAL_AURA' },
  { id: 'BOW', silhouette: 'BOW', category: 'WEAPON_RANGED', anyTags: ['中空管状', '中空', '载具', '传感器'], mechanic: 'BOUNCE_IMPULSE' },
  { id: 'WAND', silhouette: 'WAND', category: 'WEAPON_STAFF', anyTags: ['魔导', '激光', '发光', '折射', '致幻'], mechanic: 'CHAIN_LIGHTNING' },
  { id: 'HAT', silhouette: 'HAT', category: 'WEARABLE_HAT', anyTags: ['头饰', '透明', '甜食', '纤维'], mechanic: 'MORPH_ANIMAL' },
  { id: 'SHIELD', silhouette: 'SHIELD', category: 'WEARABLE_HAT', anyTags: ['盾牌', '抗爆', '坚硬', '保温'], mechanic: 'GRAVITY_PULL' },
  { id: 'HAMMER', silhouette: 'HAMMER', category: 'WEAPON_MELEE', anyTags: ['石材', '金属', '陶土', '武器', '击退'], mechanic: 'SLASH_WAVE' },
  { id: 'SWORD', silhouette: 'SWORD', category: 'WEAPON_MELEE', anyTags: ['锋利', '暴击', '手持'], mechanic: 'SLASH_WAVE' },
  { id: 'GIZMO', silhouette: 'GIZMO', category: 'PRANK_TOY', anyTags: ['机关', '家具', '地砖', '墙体', '门窗', '屋顶', '木材', '菌类', '水果', '谷物', '沙材'], mechanic: 'SLIP_HAZARD' },
];

/** 全部规则都不命中时的兜底 */
export const FALLBACK_RULE: SilhouetteRule = {
  id: 'FALLBACK', silhouette: 'GIZMO', category: 'PRANK_TOY', anyTags: [], mechanic: 'SLIP_HAZARD',
};

export function selectSilhouetteRule(tags: readonly string[]): SilhouetteRule {
  const set = new Set(tags);
  for (const rule of SILHOUETTE_RULES) {
    if (rule.anyTags.some((t) => set.has(t))) return rule;
  }
  return FALLBACK_RULE;
}

/* ══════════════════════════════════════════════════════════════
 * 3. 权重表(剪影 → 基础权重)
 * ══════════════════════════════════════════════════════════════ */

export const SILHOUETTE_WEIGHTS: Record<string, StatWeights> = {
  SWORD: { atk_weight: 0.5, def_weight: 0.18, impulse_weight: 0.22, utility_weight: 0.1 },
  HAMMER: { atk_weight: 0.45, def_weight: 0.22, impulse_weight: 0.28, utility_weight: 0.05 },
  BOW: { atk_weight: 0.5, def_weight: 0.1, impulse_weight: 0.2, utility_weight: 0.2 },
  WAND: { atk_weight: 0.32, def_weight: 0.1, impulse_weight: 0.08, utility_weight: 0.5 },
  POTION: { atk_weight: 0.05, def_weight: 0.15, impulse_weight: 0.05, utility_weight: 0.75 },
  BOMB: { atk_weight: 0.42, def_weight: 0.08, impulse_weight: 0.4, utility_weight: 0.1 },
  HAT: { atk_weight: 0.08, def_weight: 0.37, impulse_weight: 0.05, utility_weight: 0.5 },
  SHIELD: { atk_weight: 0.1, def_weight: 0.67, impulse_weight: 0.13, utility_weight: 0.1 },
  GIZMO: { atk_weight: 0.15, def_weight: 0.15, impulse_weight: 0.25, utility_weight: 0.45 },
};

/* ══════════════════════════════════════════════════════════════
 * 4. 颜色表(按主导标签取色)
 * ══════════════════════════════════════════════════════════════ */

export interface ColorTriple {
  primary: string;
  secondary: string;
  outline: string;
}

export const TAG_COLOR: Record<string, ColorTriple> = {
  金属: { primary: '#5b6570', secondary: '#b9c4cf', outline: '#1a1f25' },
  木材: { primary: '#8f6b3f', secondary: '#d8c39a', outline: '#241a10' },
  石材: { primary: '#7a7d80', secondary: '#c6c9cb', outline: '#232527' },
  陶土: { primary: '#a9603f', secondary: '#dda07f', outline: '#2c1710' },
  沙材: { primary: '#d9c37a', secondary: '#f4ead0', outline: '#332c14' },
  纤维: { primary: '#c8b394', secondary: '#efe4d0', outline: '#2b241a' },
  菌类: { primary: '#9a6fb0', secondary: '#e0c8ef', outline: '#241630' },
  甜食: { primary: '#e8a0b8', secondary: '#ffd9e4', outline: '#3a1c26' },
  水果: { primary: '#e0c74a', secondary: '#b9e07a', outline: '#33300f' },
  谷物: { primary: '#d9b45c', secondary: '#f2e2b0', outline: '#33280f' },
  草药: { primary: '#5f9e63', secondary: '#bfe3b4', outline: '#152918' },
  精华: { primary: '#7fb9d9', secondary: '#e3f2fb', outline: '#16262f' },
  火焰: { primary: '#c0392b', secondary: '#e8b23a', outline: '#2a1410' },
  冰冻: { primary: '#6fc3d9', secondary: '#d6f2fa', outline: '#152a30' },
  寒冷: { primary: '#8fb8cc', secondary: '#e2f0f6', outline: '#1a2830' },
  发光: { primary: '#b9d94e', secondary: '#f2f7c0', outline: '#2b300f' },
  激光: { primary: '#d94e9f', secondary: '#ffd0ec', outline: '#330f26' },
  导电: { primary: '#c9b33a', secondary: '#fff3a8', outline: '#332c0f' },
  魔导: { primary: '#7a5fd9', secondary: '#d0c4ff', outline: '#1e1440' },
  极滑: { primary: '#a8d94e', secondary: '#eaf7b0', outline: '#28330f' },
  爆炸: { primary: '#d96b2b', secondary: '#ffcf8a', outline: '#33190d' },
};

export const DEFAULT_COLOR: ColorTriple = { primary: '#8a8f96', secondary: '#d5d9de', outline: '#1c1f23' };

export function pickColor(tags: readonly string[]): ColorTriple {
  for (const t of tags) {
    const c = TAG_COLOR[t];
    if (c) return c;
  }
  return DEFAULT_COLOR;
}

/* ══════════════════════════════════════════════════════════════
 * 5. 粒子光环
 * ══════════════════════════════════════════════════════════════ */

export const MECHANIC_AURA: Record<string, LLMAlchemyOutputSchema['visual_style']['particle_aura']> = {
  火焰: 'FLAME', 爆炸: 'FLAME', 保温: 'FLAME',
  冰冻: 'SNOW', 寒冷: 'SNOW', 抗爆: 'SNOW',
  音乐: 'MUSIC_NOTES', 战歌: 'MUSIC_NOTES', 声波: 'MUSIC_NOTES',
  强粘性: 'SLIME_DRIP', 极滑: 'SLIME_DRIP', 减速: 'SLIME_DRIP', 可塑: 'SLIME_DRIP',
  浮力: 'BUBBLES', 高弹: 'BUBBLES', 浮空: 'BUBBLES', 弹性: 'BUBBLES',
  发光: 'SPARKLE', 激光: 'SPARKLE', 魔导: 'SPARKLE', 折射: 'SPARKLE', 致幻: 'SPARKLE', 暴击: 'SPARKLE',
};

export function pickAura(tags: readonly string[]): LLMAlchemyOutputSchema['visual_style']['particle_aura'] {
  for (const t of tags) {
    const a = MECHANIC_AURA[t];
    if (a) return a;
  }
  return 'NONE';
}

/* ══════════════════════════════════════════════════════════════
 * 6. 副元素
 * ══════════════════════════════════════════════════════════════ */

export const TAG_ELEMENT: Record<string, LLMAlchemyOutputSchema['secondary_element']> = {
  火焰: 'FIRE', 爆炸: 'FIRE',
  冰冻: 'ICE', 寒冷: 'ICE',
  导电: 'LIGHTNING',
  激光: 'LIGHT', 发光: 'LIGHT', 折射: 'LIGHT', 魔导: 'LIGHT',
  强粘性: 'STICKY', 减速: 'STICKY',
  极滑: 'SLIPPERY', 摔跤: 'SLIPPERY',
  高弹: 'BOUNCY', 弹性: 'BOUNCY', 浮力: 'BOUNCY',
};

export function pickElement(tags: readonly string[]): LLMAlchemyOutputSchema['secondary_element'] {
  for (const t of tags) {
    const e = TAG_ELEMENT[t];
    if (e) return e;
  }
  return 'NONE';
}

/* ══════════════════════════════════════════════════════════════
 * 7. 名字拼接
 * ══════════════════════════════════════════════════════════════ */

export const SILHOUETTE_NOUN: Record<string, string> = {
  SWORD: '大剑', HAMMER: '大锤', BOW: '小弓', WAND: '法杖', POTION: '药水瓶',
  BOMB: '轰雷罐', HAT: '头巾', SHIELD: '圆盾', GIZMO: '小机关',
};

/** 名字最长 16 字,超出则逐级压缩前缀 */
export const NAME_MAX_LEN = 16;

/** 从材料名里取「最有味道」的两个字当尾巴(如「滑溜香蕉」→「香蕉」) */
function materialFlavor(materials: readonly PromptMaterialLike[]): string {
  for (const m of materials) {
    const clean = m.name.replace(/[【】#\s]/g, '');
    if (clean.length >= 2) return clean.slice(-2);
  }
  return '';
}

export interface NameParts {
  carrierWord: string;
  mechanicWord: string;
  secondaryWord: string;
  noun: string;
  flavor: string;
}

/**
 * 名字模板:`[载体词] + [机制词] + [副机制词] + [剪影名词]`,
 * 若过长则依次丢弃修饰,极端情况下退回 `[剪影名词]`。
 * 例:「蕉皮」+「溜溜」+「荧光」+「大剑」→「蕉皮溜溜荧光大剑」(8 字)
 */
export function composeName(
  tags: readonly string[],
  silhouette: string,
  materials: readonly PromptMaterialLike[],
): { name: string; parts: NameParts } {
  const carriers = tags.filter((t) => isCarrierTag(t));
  const mechanics = tags.filter((t) => isMechanicTag(t));
  const carrierWord = carriers.map((t) => CARRIER_WORD[t]).find((w) => Boolean(w)) ?? '';
  const mechWords = mechanics.map((t) => MECHANIC_WORD[t]).filter((w) => Boolean(w));
  const mechanicWord = mechWords[0] ?? '';
  const secondaryWord = mechWords.find((w) => w !== mechanicWord) ?? '';
  const noun = SILHOUETTE_NOUN[silhouette] ?? '小玩意';
  const flavor = materialFlavor(materials);

  const candidates = [
    `${carrierWord}${mechanicWord}${secondaryWord}${noun}`,
    `${carrierWord}${mechanicWord}${noun}`,
    `${mechanicWord}${secondaryWord}${noun}`,
    `${carrierWord}${flavor}${noun}`,
    `${mechanicWord}${noun}`,
    `${flavor}${noun}`,
    noun,
    `神秘的${noun}`,
  ];
  for (const c of candidates) {
    const t = c.trim();
    if (t.length >= 2 && t.length <= NAME_MAX_LEN) {
      return { name: t, parts: { carrierWord, mechanicWord, secondaryWord, noun, flavor } };
    }
  }
  return { name: noun.slice(0, NAME_MAX_LEN), parts: { carrierWord, mechanicWord, secondaryWord, noun, flavor } };
}

/* ══════════════════════════════════════════════════════════════
 * 8. 简介模板
 * ══════════════════════════════════════════════════════════════ */

export const LORE_TEMPLATE = '炉子里咕嘟了三天三夜,它终于肯睁开眼睛:{carrier}和{mechanic}吵了一架,然后又握手言和。';

export function composeLore(parts: NameParts, tags: readonly string[]): string {
  const carrier = parts.carrierWord ? `${parts.carrierWord}的味道` : '一堆说不清的料';
  const mech = parts.mechanicWord ? `${parts.mechanicWord}的脾气` : '谁也不服谁的倔脾气';
  let lore = LORE_TEMPLATE.replace('{carrier}', carrier).replace('{mechanic}', mech);
  if (lore.length < 8) lore = `炉子里咕嘟出来的${tags[0] ?? '神秘'}小玩意,看着就有点傻气。`;
  return lore.slice(0, 120);
}

/* ══════════════════════════════════════════════════════════════
 * 9. 主入口
 * ══════════════════════════════════════════════════════════════ */

export interface DegradeRequest {
  /** 材料的完整信息(id / name / tags / value) */
  materials: readonly PromptMaterialLike[];
  /** 门禁给出的亲和度 ∈ [0,1] */
  affinity: number;
  /** 门禁建议的契合度初值 */
  suggestedSLogic: number;
  /** 降级原因(仅用于审计日志) */
  reason?: string;
}

export interface DegradeResult {
  /** 与 LLM 输出同构,可直接喂给 attributes.rollStats */
  output: LLMAlchemyOutputSchema;
  /** 命中的规则 id / 兜底标识 */
  ruleId: string;
  /** 名字拼装中间量,便于文档复核与调试 */
  nameParts: NameParts;
  reason: string;
}

/** 收集全部标签(去重升序) */
export function tagsOf(materials: readonly PromptMaterialLike[]): string[] {
  const out = new Set<string>();
  for (const m of materials) for (const t of m.tags) out.add(t);
  return [...out].sort();
}

/**
 * 本地确定性回退:同样的输入永远给同样的产物。
 * 不调用任何随机源 —— 离线房的两台客户端必须看到同一件东西。
 */
export function degradeGenerate(req: DegradeRequest): DegradeResult {
  /*
   * 缺省入参防守:上层在「门禁被 NON_ALCHEMABLE / 元素排斥拦下」时仍可能兜底
   * 调本函数,此时拿不到亲和度与契合度建议。若不防守,`(undefined - 0.7) * 0.2`
   * 会得到 NaN,一路污染权重 → 产物无法通过校验器。所以此处一律回落到
   * 「中性亲和度 = 0.7(不倾斜)」与「契合度下限」。
   */
  const affinity = Number.isFinite(req.affinity) ? req.affinity : NEUTRAL_AFFINITY;
  const suggestedSLogic = Number.isFinite(req.suggestedSLogic)
    ? Math.min(S_LOGIC_CEIL, Math.max(S_LOGIC_FLOOR, req.suggestedSLogic))
    : S_LOGIC_FLOOR;

  const tags = tagsOf(req.materials);
  const rule = selectSilhouetteRule(tags);
  const color = pickColor(tags);
  const { name, parts } = composeName(tags, rule.silhouette, req.materials);
  const baseWeights = SILHOUETTE_WEIGHTS[rule.silhouette] ?? SILHOUETTE_WEIGHTS.GIZMO;
  /* 亲和度作为「微调旋钮」:亲和度高时略微强化攻击向,低时更均衡 */
  const atkTilt = (affinity - 0.7) * 0.2;
  const weights: StatWeights = {
    atk_weight: Math.max(0.02, baseWeights.atk_weight + atkTilt),
    def_weight: baseWeights.def_weight,
    impulse_weight: baseWeights.impulse_weight,
    utility_weight: Math.max(0.02, baseWeights.utility_weight - atkTilt),
  };

  const output: LLMAlchemyOutputSchema = {
    item_name: name,
    lore_description: composeLore(parts, tags),
    item_category: rule.category,
    primary_mechanic: rule.mechanic,
    secondary_element: pickElement(tags),
    logic_synergy_score: suggestedSLogic,
    stat_weights: weights,
    visual_style: {
      base_silhouette: rule.silhouette,
      primary_color_hex: color.primary,
      secondary_color_hex: color.secondary,
      outline_color_hex: color.outline,
      particle_aura: pickAura(tags),
      pixel_icon_16x16: canonicalArt(rule.silhouette),
    },
  };

  return { output, ruleId: rule.id, nameParts: parts, reason: req.reason ?? 'LLM 不可用,已启用本地确定性回退' };
}

/** 降级器自检:规则表与配表必须自洽。 */
export function selfCheckDegrade(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = SILHOUETTE_RULES.map((r) => r.id);
  if (new Set(ids).size !== ids.length) errors.push('剪影规则 id 重复');
  for (const r of SILHOUETTE_RULES) {
    if (!SILHOUETTE_WEIGHTS[r.silhouette]) errors.push(`剪影 ${r.silhouette} 缺少权重表`);
    if (!SILHOUETTE_NOUN[r.silhouette]) errors.push(`剪影 ${r.silhouette} 缺少名词`);
    if (r.anyTags.length === 0) errors.push(`规则 ${r.id} 无匹配标签(会遮蔽后续规则)`);
  }
  if (!SILHOUETTE_WEIGHTS[FALLBACK_RULE.silhouette]) errors.push('兜底规则剪影缺权重');
  for (const [sil, w] of Object.entries(SILHOUETTE_WEIGHTS)) {
    const sum = w.atk_weight + w.def_weight + w.impulse_weight + w.utility_weight;
    if (Math.abs(sum - 1) > 1e-6) errors.push(`权重表 ${sil} 权重和 ${sum} ≠ 1`);
  }
  return { ok: errors.length === 0, errors };
}