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
  /**
   * **配方里的「任意 X」留白槽**,每项是一组「任一命中即可」的 tag。
   *
   * 手册有 3 条配方写「任意染料」,而 `recipe` 只能表达确定 ID,
   * 早先的代码把留白**硬编成了 166 绯红植物染料**:
   *   - L178 `237 七彩颜料水球`   = `陶瓷空药水瓶×1 + 任意染料×1`
   *   - L186 `245 手持庆典烟花筒` = `翠玉青竹×1 + 爆裂火椒×1 + 染料×1`
   *   - L242 `356 哥特彩绘花窗墙` = `全透琉璃板×1 + 任意染料×2`
   * ⇒ 167/168/169 三色染料此前**完全无法**用于这三条配方(只能造出 166)。
   *
   * 本字段是**附加**的:`recipe` 的既有键一律保留(删键会让
   * `WS-FND-06` 的 237/245 对照与 `verify.ts` 的引用闭合红)。
   * 语义:`recipe` 是「必须消耗的确定件」,`recipeAnyTag` 是「逐个满足的留白槽」,
   * 两者**并集**构成完整配方 —— 留白槽不再依赖具体键的存在。
   *
   * 例:`recipeAnyTag: [['染料']]` ⇒ 任一带 `染料` tag 的物品可顶替 1 个。
   */
  recipeAnyTag?: string[][];
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
  /**
   * **每件必掉战利品的数量,与 `loot` 逐位对应**(下标 i 即 `loot[i]` 的数量)。
   *
   * 手册的「必掉史诗战利品」列同时表达了三类信息,而 `loot: number[]` 只能装第一类:
   *   1. 带 ID 的必掉件 → `loot` 已表达;
   *   2. 带数量的必掉件(手册 L496 `703 河狸钢牙×10`、L501 `117 极光星辰碎片×15`)→ 本字段;
   *   3. 无对应 ID 的抽象奖励(图纸/随从/纪念碑)→ `lootAbstract`。
   *
   * 缺省 = 全 1(手册未注数量就是 1 件)。
   *
   * ⚠️ **为什么不直接改 `loot` 的元素个数或值**:`contentFingerprints()` 的
   * `bosses` 分区哈希 `{id,name,baseHp,summonItem,loot}`,改它会让冻结指纹漂移,
   * 并撞红 `WS-FND-01/06`、`data-conformance.ts`、`README.md` 四处**写域外**锚点。
   * ⇒ 手册修正一律走附加字段,`loot` 保持字节级不变。见 docs/CHANGE_REQUESTS.md CR-16。
   */
  lootQty?: number[];
  /**
   * 手册写进「必掉战利品」列、但 320 项物品表内**不存在**对应 ID 的抽象奖励原文。
   *
   * 例:手册 L496「自动伐木机甲宠物图纸」、L500「皇家甜点主题全套城堡图纸与姜饼人随从」、
   * L502「纯金通关纪念碑」。这 7 条在 `ITEM_LIST` 里 0 命中 —— 不能凭空塞进物品表
   * (会破坏 320 件的内容锁),但也不能**静默丢弃**(丢了等于手册那句话从未被实现)。
   * ⇒ 以文字形式登记,供 UI / 掉落提示消费。
   */
  lootAbstract?: string[];
  /**
   * `loot` 中**与手册不符**的条目及其原因。
   *
   * 命中的场景是「手册里该件是手段/造物,不是掉落」:
   *   - `437 叮当蒸汽小火车头`:手册 L496 的战利品列写的是「703×10 + 自动伐木机甲宠物图纸」,
   *     而 437 在 L313 是**可造载具**(`寒铁金属锭×6 + 黄铜金属锭×4`),L603 也只是玩家拿它玩乐;
   *   - `440 八人云海探险飞艇`:手册 L501 的破防手段写「全队**驾驶** 440 飞艇贴近云鲸」,
   *     而它是 L316 的**可造载具**(`秘银魔导锭×6 + 蓬松云朵布×10`);L501 战利品列是「117×15 + 718」。
   *
   * 处理方式:**不删 `loot` 条目**(删了会动指纹),而是在生产掉落里过滤掉,
   * 并把偏离记录在案 —— 这样既不破契约,也不会继续把造物当战利品发给玩家。
   */
  lootDeviations?: { itemId: number; reason: string }[];
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
