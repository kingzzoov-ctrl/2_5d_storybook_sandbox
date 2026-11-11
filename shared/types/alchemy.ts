/**
 * 万物奇想炼金炉契约(冻结层)。对应设计手册 §5.1 / §5.2。
 *
 * 双轨架构:LLM 只做「定性」(命名/类别/机制/外观/权重/契合度),
 * 所有数值由 §5.3 的确定性数学算法 Roll 出,LLM 无权填写攻击力。
 */

export const ALCHEMY_MIN_INPUTS = 2;
export const ALCHEMY_MAX_INPUTS = 4;

/** 形态/载体词条白名单:门禁要求至少命中 1 个 */
export const CARRIER_TAGS: readonly string[] = [
  '木材', '金属', '石材', '陶土', '沙材', '纤维', '菌类', '甜食', '水果', '谷物', '草药',
  '精华', '武器', '药水瓶', '头饰', '鞋饰', '背饰', '腰饰', '乐器', '家具', '地砖', '墙体',
  '门窗', '屋顶', '机关', '传感器', '载具', '流体发射', '手持', '盾牌', '炸弹', '食物',
];

/** 特性/机制词条白名单:门禁要求至少命中 1 个 */
export const MECHANIC_TAGS: readonly string[] = [
  '极滑', '摔跤', '爆炸', '火焰', '高弹', '击退', '冰冻', '寒冷', '发光', '激光', '导电',
  '变形', '致幻', '音乐', '战歌', '强粘性', '减速', '浮力', '浮空', '飞行', '声波', '治疗',
  '愈合', '催熟', '魔导', '暴击', '坚硬', '抗爆', '锋利', '保温', '恢复', '芳香', '治愈',
  '中空', '弹性', '中空管状', '容器', '可塑', '透明', '折射', '驱虫', '邀宠', '自动采摘',
];

export const AlchemyCategory = {
  WEAPON_MELEE: 'WEAPON_MELEE',
  WEAPON_RANGED: 'WEAPON_RANGED',
  WEAPON_STAFF: 'WEAPON_STAFF',
  PRANK_TOY: 'PRANK_TOY',
  CONSUMABLE: 'CONSUMABLE',
  WEARABLE_HAT: 'WEARABLE_HAT',
  TRAP_GADGET: 'TRAP_GADGET',
} as const;
export type AlchemyCategory = (typeof AlchemyCategory)[keyof typeof AlchemyCategory];

export const PrimaryMechanic = {
  SLASH_WAVE: 'SLASH_WAVE',
  SLIP_HAZARD: 'SLIP_HAZARD',
  BOUNCE_IMPULSE: 'BOUNCE_IMPULSE',
  BUBBLE_TRAP: 'BUBBLE_TRAP',
  FREEZE_SLIDE: 'FREEZE_SLIDE',
  CHAIN_LIGHTNING: 'CHAIN_LIGHTNING',
  MORPH_ANIMAL: 'MORPH_ANIMAL',
  HEAL_AURA: 'HEAL_AURA',
  GRAVITY_PULL: 'GRAVITY_PULL',
  ROCKET_FART: 'ROCKET_FART',
} as const;
export type PrimaryMechanic = (typeof PrimaryMechanic)[keyof typeof PrimaryMechanic];

export const SecondaryElement = {
  NONE: 'NONE', FIRE: 'FIRE', ICE: 'ICE', LIGHTNING: 'LIGHTNING',
  LIGHT: 'LIGHT', STICKY: 'STICKY', SLIPPERY: 'SLIPPERY', BOUNCY: 'BOUNCY',
} as const;
export type SecondaryElement = (typeof SecondaryElement)[keyof typeof SecondaryElement];

export const BaseSilhouette = {
  SWORD: 'SWORD', HAMMER: 'HAMMER', BOW: 'BOW', WAND: 'WAND', POTION: 'POTION',
  BOMB: 'BOMB', HAT: 'HAT', SHIELD: 'SHIELD', GIZMO: 'GIZMO',
} as const;
export type BaseSilhouette = (typeof BaseSilhouette)[keyof typeof BaseSilhouette];

export const ParticleAura = {
  NONE: 'NONE', SPARKLE: 'SPARKLE', BUBBLES: 'BUBBLES', FLAME: 'FLAME',
  SNOW: 'SNOW', MUSIC_NOTES: 'MUSIC_NOTES', SLIME_DRIP: 'SLIME_DRIP',
} as const;
export type ParticleAura = (typeof ParticleAura)[keyof typeof ParticleAura];

export interface StatWeights {
  atk_weight: number;
  def_weight: number;
  impulse_weight: number;
  utility_weight: number;
}

export interface VisualStyle {
  base_silhouette: BaseSilhouette;
  primary_color_hex: string;
  secondary_color_hex: string;
  outline_color_hex: string;
  particle_aura: ParticleAura;
  /** 16 行 × 16 列的调色盘字符矩阵 */
  pixel_icon_16x16: string[];
}

export interface LLMAlchemyOutputSchema {
  item_name: string;
  lore_description: string;
  item_category: AlchemyCategory;
  primary_mechanic: PrimaryMechanic;
  secondary_element: SecondaryElement;
  logic_synergy_score: number;
  stat_weights: StatWeights;
  visual_style: VisualStyle;
}

export const RarityTier = {
  COMMON: 0,
  UNCOMMON: 1,
  RARE: 2,
  LEGENDARY: 3,
} as const;
export type RarityTier = (typeof RarityTier)[keyof typeof RarityTier];

export const RARITY_LABEL: Record<number, { name: string; color: string; affixes: number }> = {
  0: { name: '凡品·呆萌造物', color: '白色', affixes: 1 },
  1: { name: '奇巧·脑洞精品', color: '翠绿', affixes: 2 },
  2: { name: '秘宝·大师奇物', color: '星蓝', affixes: 3 },
  3: { name: '神来之笔·传世孤品', color: '曜金', affixes: 4 },
};

export interface RolledStats {
  atk: number;
  def: number;
  hp: number;
  impulse: number;
  util: number;
  affixes: string[];
}

export interface ItemInstanceStats {
  instance_id: string;
  recipe_hash: string;
  owner_id: string;
  rarity_tier: RarityTier;
  quality_score: number;
  t_eff: number;
  budget: number;
  rolled: RolledStats;
  discoverer_name?: string;
}

export interface AlchemyRecipeRow {
  recipe_hash: string;
  discoverer_name: string;
  item_name: string;
  item_category: AlchemyCategory;
  llm_schema_json: string;
  craft_count: number;
  created_at: number;
}

/** 配方哈希:输入物品 ID 升序排列后以下划线拼接,如 "116_125_712" */
export function recipeHash(itemIds: readonly number[]): string {
  const ids = [...itemIds].map((n) => Math.trunc(n));
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0) throw new Error(`非法物品 ID: ${id}`);
  }
  return ids.sort((a, b) => a - b).join('_');
}

export const DEW_ITEM_ID = 130;
export const ALCHEMY_FURNACE_ID = 536;
export const ALCHEMY_GALLERY_ID = 537;
export const BETA_DEW = 0.15;
