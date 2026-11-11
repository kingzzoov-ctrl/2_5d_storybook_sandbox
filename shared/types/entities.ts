/**
 * 实体图鉴契约(冻结层):物品 / 生物 / Boss 的联合类型与成长公式。
 * 与设计手册 §3、§4.1、§4.2、§4.3 一一对应。
 *
 * 语法约定:禁止 `enum` / `const enum`,使用 `as const` 对象 + 联合类型。
 */

export const ItemCategory = {
  NATURAL: 'NATURAL',
  REFINED: 'REFINED',
  TOOL: 'TOOL',
  PRANK_TOY: 'PRANK_TOY',
  FLOOR: 'FLOOR',
  BUILDING: 'BUILDING',
  AUTOMATION: 'AUTOMATION',
  FURNITURE: 'FURNITURE',
  FOOD: 'FOOD',
  WEARABLE: 'WEARABLE',
  COMBAT: 'COMBAT',
  AI_CRAFTED: 'AI_CRAFTED',
} as const;
export type ItemCategory = (typeof ItemCategory)[keyof typeof ItemCategory];

export interface ItemDef {
  id: number;
  name: string;
  category: ItemCategory;
  /** 词条:形态/载体词条 + 特性/机制词条,炼金门禁依赖此字段 */
  tags: string[];
  /** 基础价值分 V_i,参与炼金 T_eff 公式 */
  value: number;
  /** 合成配方:材料 ID -> 数量;undefined 表示自然产出或掉落 */
  recipe?: Record<number, number>;
  /** 合成产出数量,默认 1 */
  output?: number;
  /** 加工设备物品 ID */
  station?: number;
  /** 自由文本机制说明(设计手册原句) */
  note: string;
}

export const Biome = {
  MEADOW: 'MEADOW',
  VALLEY: 'VALLEY',
  SAKURA: 'SAKURA',
  CAVERN: 'CAVERN',
  OASIS: 'OASIS',
  DESSERT: 'DESSERT',
  SKYSEA: 'SKYSEA',
  RUINS: 'RUINS',
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

export const BIOME_LABEL: Record<Biome, string> = {
  MEADOW: '晨曦草甸',
  VALLEY: '金秋河谷',
  SAKURA: '绯樱高地',
  CAVERN: '萤光溶洞',
  OASIS: '星沙绿洲',
  DESSERT: '甜点奇境',
  SKYSEA: '浮空云海',
  RUINS: '发条遗迹',
};

export const MobBehavior = {
  TAMEABLE: 'TAMEABLE',
  MISCHIEVOUS: 'MISCHIEVOUS',
  HOSTILE: 'HOSTILE',
  HOSTILE_ELITE: 'HOSTILE_ELITE',
  MOUNT: 'MOUNT',
  PASSIVE_UNKILLABLE: 'PASSIVE_UNKILLABLE',
  TREASURE_TRICKSTER: 'TREASURE_TRICKSTER',
} as const;
export type MobBehavior = (typeof MobBehavior)[keyof typeof MobBehavior];

export const MobFsmState = {
  IDLE_GRAZE: 'IDLE_GRAZE',
  ALERT_FLEE_OR_CHASE: 'ALERT_FLEE_OR_CHASE',
  TELEGRAPH_ATTACK: 'TELEGRAPH_ATTACK',
} as const;
export type MobFsmState = (typeof MobFsmState)[keyof typeof MobFsmState];

export interface MobDef {
  id: string;
  name: string;
  biome: Biome;
  behavior: MobBehavior;
  level: number;
  hp: number;
  exp: number;
  /** 掉落物 ID -> 数量 */
  drops: Record<number, number>;
  /** 驯养/安抚/互动所需物品 ID */
  tameItem?: number;
  /** AI 行为与沙盒互动的设计原句 */
  note: string;
}

export interface BossPhase {
  /** 进入该阶段的血量百分比阈值,1.0 表示开局 */
  hpThreshold: number;
  name: string;
  /** 地面几何预警圈描述 */
  telegraph: string;
  skill: string;
}

export interface BossDef {
  id: string;
  name: string;
  biome: Biome;
  level: number;
  baseHp: number;
  /** 召唤祭品物品 ID */
  summonItem: number;
  phases: BossPhase[];
  /** 沙盒机关破防弱点 */
  breakMechanic: string;
  /** 必掉战利品物品 ID 列表 */
  loot: number[];
  exp: number;
}

/** Boss 人数血量缩放: HP_base * (1 + 0.65(N-1)) */
export function bossScaledHp(baseHp: number, players: number): number {
  const n = Math.max(1, players);
  return Math.round(baseHp * (1 + 0.65 * (n - 1)));
}

/** 角色升级经验: EXP_next(L) = 50L² + 50L */
export function expToNext(level: number): number {
  return 50 * level * level + 50 * level;
}

/** 每级成长: 最大HP +15,全武器伤害 +3%,负重格 +1;满级 Lv.30 */
export const MAX_LEVEL = 30;
export const BASE_HP = 100;

export function statsAtLevel(level: number): { maxHp: number; dmgMul: number; carrySlots: number } {
  const l = Math.max(1, Math.min(MAX_LEVEL, level));
  return { maxHp: BASE_HP + 15 * (l - 1), dmgMul: 1 + 0.03 * (l - 1), carrySlots: 8 + (l - 1) };
}

/** 每 5 级解锁 1 个被动天赋 */
export const TALENT_LEVELS: readonly number[] = [5, 10, 15, 20, 25, 30];

/** 全队经验共享:Loot 判定半径 24 格;3 人以上额外 +25%;挂机打盹 30% */
export const SHARE_EXP_RADIUS = 24;
export const PARTY_BONUS_THRESHOLD = 3;
export const PARTY_BONUS = 0.25;
export const AFK_EXP_RATIO = 0.3;

/** 幽灵泡泡倒地救援: 摸一下 1 秒内半血复活,零掉级零爆装 */
export const REVIVE_TIME = 1.0;
export const REVIVE_HP_RATIO = 0.5;
/** 复苏天使羽毛笔: 6 格远程满血复活 + 3 秒无敌 */
export const FEATHER_RANGE = 6;
export const FEATHER_INVULN = 3.0;
