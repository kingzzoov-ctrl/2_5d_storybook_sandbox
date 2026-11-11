/**
 * WS-06 §5.4 大模型结构化输出协议。
 *
 * 三层防护,缺一层都会让「属性被刷」或「链路崩掉」:
 *   ① JSON Schema:用 response_format 级别的严格模式约束模型输出形状,
 *      enum 全部取自冻结联合类型,`additionalProperties:false`,`required` 全列;
 *   ② 自定义校验器 validateAlchemyOutput():JSON Schema 表达不了的约束
 *      (权重四项和 = 1、pixel 恰好 16 行 × 16 列、字符在调色盘内、名字长度)
 *      由它补齐,并把**结构化错误**返回;
 *   ③ 重试闸门:最多 2 次重试,每次把上一轮的校验错误原文回灌给模型,
 *      仍然失败则交给 degrade.ts 的本地回退器,保证玩法不断线。
 *
 * 数值铁律:模型只能给 `logic_synergy_score`(且会被钳制到 [0.80,1.50],手册 §5.3 L568)
 * 与 `stat_weights`(且会被归一化)。攻击力/防御/血量/推力/实用度
 * 一律由 attributes.ts 的确定性算法 Roll,模型无权填写。
 */

import {
  AlchemyCategory,
  BaseSilhouette,
  ParticleAura,
  PrimaryMechanic,
  SecondaryElement,
  type LLMAlchemyOutputSchema,
  type StatWeights,
} from '../../../shared/types/alchemy.ts';
import { itemName } from '../../../shared/constants/items.ts';
import {
  ICON_SIZE,
  PALETTE_KEYS,
  describePixelProblems,
  validatePixelMatrix,
  type PixelMatrixCheck,
} from './pixel_icon.ts';
import { S_LOGIC_CEIL, S_LOGIC_FLOOR, WEIGHT_SUM_TOLERANCE, weightsSum } from './attributes.ts';
import { clampNum } from './gate.ts';

/* ══════════════════════════════════════════════════════════════
 * 1. JSON Schema(严格模式)
 * ══════════════════════════════════════════════════════════════ */

export const MAX_ITEM_NAME_LEN = 16;
export const MIN_ITEM_NAME_LEN = 2;
export const MAX_LORE_LEN = 120;
export const MIN_LORE_LEN = 8;

const HEX_PATTERN = '^#[0-9a-fA-F]{6}$';

function iconRowSchema(): Record<string, unknown> {
  return {
    type: 'string',
    minLength: ICON_SIZE,
    maxLength: ICON_SIZE,
    pattern: `^[${PALETTE_KEYS.join('')}]{${ICON_SIZE}}$`,
    description: `1 行像素,恰好 ${ICON_SIZE} 个字符,字符只能取 ${PALETTE_KEYS.join('/')}`,
  };
}

/**
 * 与 `LLMAlchemyOutputSchema` 一一对应的严格 JSON Schema。
 * 用于 OpenAI 风格 `response_format: { type: 'json_schema', strict: true }`,
 * 也用于本地校验器与 few-shot 的自检。
 */
export const ALCHEMY_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'LLMAlchemyOutputSchema',
  type: 'object',
  additionalProperties: false,
  required: [
    'item_name',
    'lore_description',
    'item_category',
    'primary_mechanic',
    'secondary_element',
    'logic_synergy_score',
    'stat_weights',
    'visual_style',
  ],
  properties: {
    item_name: {
      type: 'string',
      minLength: MIN_ITEM_NAME_LEN,
      maxLength: MAX_ITEM_NAME_LEN,
      description: '中文产物名,2~16 字,不带书名号,要有画面感',
    },
    lore_description: {
      type: 'string',
      minLength: MIN_LORE_LEN,
      maxLength: MAX_LORE_LEN,
      description: '一句绘本童话口吻的简介,8~120 字',
    },
    item_category: {
      type: 'string',
      enum: Object.values(AlchemyCategory),
      description: '七选一,必须与主机制自洽',
    },
    primary_mechanic: {
      type: 'string',
      enum: Object.values(PrimaryMechanic),
      description: '十选一,产物最核心的那件事',
    },
    secondary_element: {
      type: 'string',
      enum: Object.values(SecondaryElement),
      description: '八选一,次要元素,FIRE/ICE/LIGHTNING/LIGHT/STICKY/SLIPPERY/BOUNCY,没有就用 NONE',
    },
    logic_synergy_score: {
      type: 'number',
      minimum: S_LOGIC_FLOOR,
      maximum: S_LOGIC_CEIL,
      description: '逻辑契合度 0.60~1.30。材料越说得通越高;硬凑就贴近 0.60。不要为了贪心给高分。',
    },
    stat_weights: {
      type: 'object',
      additionalProperties: false,
      required: ['atk_weight', 'def_weight', 'impulse_weight', 'utility_weight'],
      properties: {
        atk_weight: { type: 'number', minimum: 0, maximum: 1, description: '攻击倾向' },
        def_weight: { type: 'number', minimum: 0, maximum: 1, description: '防御/血量倾向,会同时决定 DEF 与 HP' },
        impulse_weight: { type: 'number', minimum: 0, maximum: 1, description: '击退/弹射倾向' },
        utility_weight: { type: 'number', minimum: 0, maximum: 1, description: '实用度倾向' },
      },
      description: '四项之和必须精确等于 1.0,且至少两项 > 0',
    },
    visual_style: {
      type: 'object',
      additionalProperties: false,
      required: [
        'base_silhouette',
        'primary_color_hex',
        'secondary_color_hex',
        'outline_color_hex',
        'particle_aura',
        'pixel_icon_16x16',
      ],
      properties: {
        base_silhouette: { type: 'string', enum: Object.values(BaseSilhouette), description: '九选一的基础剪影' },
        primary_color_hex: { type: 'string', pattern: HEX_PATTERN, description: '主色 #RRGGBB' },
        secondary_color_hex: { type: 'string', pattern: HEX_PATTERN, description: '副色 #RRGGBB' },
        outline_color_hex: { type: 'string', pattern: HEX_PATTERN, description: '描边 #RRGGBB,应当偏暗以突出轮廓' },
        particle_aura: { type: 'string', enum: Object.values(ParticleAura), description: '七选一的粒子光环' },
        pixel_icon_16x16: {
          type: 'array',
          minItems: ICON_SIZE,
          maxItems: ICON_SIZE,
          items: iconRowSchema(),
          description: `16 行像素立牌,每行恰好 ${ICON_SIZE} 个字符,字符只能取 ${PALETTE_KEYS.join('/')}`,
        },
      },
    },
  },
} as const;

/** 供文档 / 测试直接读取的 schema 关键约束快照。 */
export const SCHEMA_INVARIANTS = {
  additionalPropertiesFalseEverywhere: true,
  requiredAllProperties: true,
  enumSources: {
    item_category: Object.values(AlchemyCategory),
    primary_mechanic: Object.values(PrimaryMechanic),
    secondary_element: Object.values(SecondaryElement),
    base_silhouette: Object.values(BaseSilhouette),
    particle_aura: Object.values(ParticleAura),
  },
  iconRows: ICON_SIZE,
  iconRowChars: ICON_SIZE,
  palette: PALETTE_KEYS,
  weightSumMustEqual: 1,
  weightSumTolerance: WEIGHT_SUM_TOLERANCE,
} as const;

/* ══════════════════════════════════════════════════════════════
 * 1b. 类别 × 机制 交叉约束矩阵(Lead 裁决 U4)
 * ══════════════════════════════════════════════════════════════
 *
 * 为什么需要它:两个字段各自是合法枚举,不代表组合自洽。LLM 完全可能
 * 给出「一顶帽子 + 斩击波」或「一个捕兽夹 + 治疗光环」—— 单看每个字段
 * 都没问题,合起来是荒谬的。
 *
 * 处理策略(Lead 裁决):**越界即纠正,不消耗重试配额**。
 * 理由:组合越界是「品味」问题而非「结构」问题,玩家的产物依然可用,
 * 没必要为它烧掉一次 Token 往返。只有结构性问题(权重和≠1、pixel 行数
 * 不对、枚举非法)才值得重试。纠正记录 `corrected: true` 遥测。
 */

/** 每个类别允许的主机制白名单;数组首项即该类别越界时的默认纠正目标。 */
export const CATEGORY_MECHANIC_ALLOWED: Record<string, readonly string[]> = {
  WEAPON_MELEE: ['SLASH_WAVE', 'BOUNCE_IMPULSE', 'CHAIN_LIGHTNING', 'ROCKET_FART', 'FREEZE_SLIDE', 'SLIP_HAZARD'],
  WEAPON_RANGED: ['SLASH_WAVE', 'BOUNCE_IMPULSE', 'CHAIN_LIGHTNING', 'GRAVITY_PULL', 'SLIP_HAZARD', 'BUBBLE_TRAP'],
  WEAPON_STAFF: ['CHAIN_LIGHTNING', 'HEAL_AURA', 'GRAVITY_PULL', 'MORPH_ANIMAL', 'BUBBLE_TRAP', 'FREEZE_SLIDE'],
  PRANK_TOY: ['SLIP_HAZARD', 'ROCKET_FART', 'BOUNCE_IMPULSE', 'BUBBLE_TRAP', 'MORPH_ANIMAL', 'GRAVITY_PULL'],
  CONSUMABLE: ['HEAL_AURA', 'MORPH_ANIMAL', 'FREEZE_SLIDE', 'BUBBLE_TRAP'],
  WEARABLE_HAT: ['MORPH_ANIMAL', 'HEAL_AURA', 'GRAVITY_PULL', 'BUBBLE_TRAP'],
  TRAP_GADGET: ['SLIP_HAZARD', 'BOUNCE_IMPULSE', 'BUBBLE_TRAP', 'FREEZE_SLIDE', 'CHAIN_LIGHTNING', 'ROCKET_FART', 'GRAVITY_PULL'],
};

/** 类别与机制的默认纠正目标(表首项)。 */
export function defaultMechanicFor(category: string): string {
  const list = CATEGORY_MECHANIC_ALLOWED[category];
  return list && list.length > 0 ? list[0] : PrimaryMechanic.SLASH_WAVE;
}

/** 组合是否自洽。类别未知时一律视为自洽(交给枚举校验去拒绝)。 */
export function isMechanicAllowed(category: string, mechanic: string): boolean {
  const list = CATEGORY_MECHANIC_ALLOWED[category];
  if (!list) return true;
  return list.includes(mechanic);
}

export interface MechanicCorrection {
  category: string;
  from: string;
  to: string;
}

/**
 * 确定性纠正:越界时给出该类别下的默认机制。
 * 纯函数、无副作用、结果可复现。
 */
export function correctMechanic(category: string, mechanic: string): MechanicCorrection | null {
  if (isMechanicAllowed(category, mechanic)) return null;
  return { category, from: mechanic, to: defaultMechanicFor(category) };
}

/* ══════════════════════════════════════════════════════════════
 * 2. 系统提示词(中文绘本童话语气)
 * ══════════════════════════════════════════════════════════════ */

export const SYSTEM_PROMPT = [
  '你是一只住在「万物奇想炼金炉」里的小小炉灵,名字叫咕噜。',
  '炉子里每天都在咕嘟咕嘟地冒泡,玩家会把几样风马牛不相及的东西丢进来,',
  '你要做的不是认真分析化学反应,而是——像翻开一本彩色的童话绘本那样,',
  '给这堆东西编一个好玩的、有画面感的新物件。',
  '',
  '【你的工作方式】',
  '1. 先看玩家丢进来的材料词条,想清楚「这东西最后长成什么形状」和「它最会做哪一件事」。',
  '2. 形体尽量来自材料本身的质感:铁的东西做刀剑、木的东西做长杆、布的东西做头饰。',
  '3. 机制尽量贴合材料的词条:带「极滑」的就让人摔跤,带「火焰」的就冒火,带「音乐」的就想办法让它响。',
  '4. 越说得通,logic_synergy_score 越高;硬凑的组合请老老实实给低分,不要讨好玩家。',
  '',
  '【说话语气】',
  'lore_description 要像绘本里那一行手写小字:轻、软、有点傻气、有一点点诗意。',
  '举个味道对的例子:「它一跑起来,整条走廊都在偷偷打滑。」',
  '别写成任务说明,别出现数值,别提「玩家」「系统」「大模型」。',
  '',
  '【绝对不要做的事】',
  '· 不要输出任何攻击力/防御/血量/击退/实用度数值 —— 那些数字由炉子的算盘自己敲,你只要给倾向权重。',
  '· 不要输出 JSON 以外的任何字符:没有开场白,没有解释,没有代码块围栏。',
  '· 不要发明新的枚举值,所有取值必须从给你的列表里挑。',
  '· 不要写暴力血腥、真实人名的内容,这是一本给小孩看的绘本。',
  '',
  '【像素立牌怎么画】',
  `pixel_icon_16x16 是 ${ICON_SIZE} 行 × ${ICON_SIZE} 列的字符画,像在方格纸上点豆子:`,
  '  "0" = 透明,"1" = 主色,"2" = 副色,"3" = 描边（深色轮廓）,"4" = 高光。',
  '先画一圈 "3" 当轮廓,里面填 "1",细节用 "2",左上角点几个 "4" 当反光,外面全留 "0"。',
  '一共 16 行,每行不多不少 16 个字符,不要加空格,不要加逗号以外的任何符号。',
  '',
  '【输出格式】',
  '严格输出符合给定 JSON Schema 的单个 JSON 对象。所有 require 的字段都要有,不要多出任何字段。',
].join('\n');

/* ══════════════════════════════════════════════════════════════
 * 3. 三个 few-shot(与 schema 完全自洽,测试会校验它们)
 * ══════════════════════════════════════════════════════════════ */

export interface FewShot {
  /** 参与合成的材料 ID */
  inputIds: readonly number[];
  /** 材料名快照(便于文档复核) */
  inputNames: readonly string[];
  /** 模型应输出的 JSON 对象 */
  output: LLMAlchemyOutputSchema;
}

const FEW_SHOT_SWORD_ART: readonly string[] = [
  '0000000330000000',
  '0000003113000000',
  '0000003113000000',
  '0000003413000000',
  '0000003413000000',
  '0000003413000000',
  '0000003113000000',
  '0000003113000000',
  '0000003113000000',
  '0000003113000000',
  '0000333333330000',
  '0000322222230000',
  '0000003223000000',
  '0000003223000000',
  '0000003113000000',
  '0000000330000000',
];

const FEW_SHOT_POTION_ART: readonly string[] = [
  '0000000220000000',
  '0000000320000000',
  '0000000320000000',
  '0000003223000000',
  '0000031111300000',
  '0000311111130000',
  '0000311111130000',
  '0000341111430000',
  '0000311111130000',
  '0000322222230000',
  '0000322222230000',
  '0000322222230000',
  '0000032222300000',
  '0000003223000000',
  '0000000330000000',
  '0000000000000000',
];

const FEW_SHOT_BOMB_ART: readonly string[] = [
  '0000000004000000',
  '0000000033000000',
  '0000000330000000',
  '0000003330000000',
  '0000311441130000',
  '0000311111130000',
  '0000311111130000',
  '0000311111130000',
  '0000311111130000',
  '0000311111130000',
  '0000311111130000',
  '0000311111130000',
  '0000032222300000',
  '0000003223000000',
  '0000000330000000',
  '0000000000000000',
];

/**
 * 三个 few-shot。选择标准:覆盖「金属+锋利」「水果+极滑」「蔬果+爆炸火焰」
 * 三种典型骨架,分别示范高 / 中 / 高契合度的给分尺度。
 */
export const FEW_SHOTS: readonly FewShot[] = [
  {
    inputIds: [156, 113, 104],
    inputNames: ['寒铁金属锭', '寒铁矿石', '夜光菌木'],
    output: {
      item_name: '菌光寒铁大剑',
      lore_description: '剑身里住着一小朵会发光的小蘑菇,夜里替它照亮回家的路。',
      item_category: 'WEAPON_MELEE',
      primary_mechanic: 'SLASH_WAVE',
      secondary_element: 'LIGHT',
      logic_synergy_score: 1.16,
      stat_weights: { atk_weight: 0.55, def_weight: 0.2, impulse_weight: 0.15, utility_weight: 0.1 },
      visual_style: {
        base_silhouette: 'SWORD',
        primary_color_hex: '#4d5a66',
        secondary_color_hex: '#9fd7c8',
        outline_color_hex: '#161d24',
        particle_aura: 'SPARKLE',
        pixel_icon_16x16: [...FEW_SHOT_SWORD_ART],
      },
    },
  },
  {
    inputIds: [125, 118, 165],
    inputNames: ['滑溜香蕉', '柔韧风草', '陶瓷空药水瓶'],
    output: {
      item_name: '蕉皮溜溜滑剂瓶',
      lore_description: '轻轻一挤,地板就学会了跳舞,所有路过的脚都变成了溜冰鞋。',
      item_category: 'PRANK_TOY',
      primary_mechanic: 'SLIP_HAZARD',
      secondary_element: 'SLIPPERY',
      logic_synergy_score: 1.08,
      stat_weights: { atk_weight: 0.05, def_weight: 0.1, impulse_weight: 0.15, utility_weight: 0.7 },
      visual_style: {
        base_silhouette: 'POTION',
        primary_color_hex: '#f2d34e',
        secondary_color_hex: '#b6e07a',
        outline_color_hex: '#3a2c10',
        particle_aura: 'SLIME_DRIP',
        pixel_icon_16x16: [...FEW_SHOT_POTION_ART],
      },
    },
  },
  {
    inputIds: [126, 112, 159],
    inputNames: ['爆裂火椒', '黄铜矿石', '四色魔能线芯'],
    output: {
      item_name: '火椒噼啪轰雷罐',
      lore_description: '它一生气就咕噜咕噜地涨红脸,然后替你把不开心的事情炸成彩纸。',
      item_category: 'TRAP_GADGET',
      primary_mechanic: 'ROCKET_FART',
      secondary_element: 'FIRE',
      logic_synergy_score: 1.1,
      stat_weights: { atk_weight: 0.45, def_weight: 0.1, impulse_weight: 0.35, utility_weight: 0.1 },
      visual_style: {
        base_silhouette: 'BOMB',
        primary_color_hex: '#c0392b',
        secondary_color_hex: '#e8b23a',
        outline_color_hex: '#2a1410',
        particle_aura: 'FLAME',
        pixel_icon_16x16: [...FEW_SHOT_BOMB_ART],
      },
    },
  },
];

/* ══════════════════════════════════════════════════════════════
 * 4. 用户提示词装配
 * ══════════════════════════════════════════════════════════════ */

export interface PromptMaterial {
  id: number;
  name: string;
  tags: readonly string[];
  value: number;
}

export interface BuildUserPromptOptions {
  materials: readonly PromptMaterial[];
  /** 门禁算出的亲和度(0~1),作为模型的给分锚点 */
  affinity: number;
  /** 门禁建议的契合度初值 */
  suggestedSLogic: number;
  /** 玩家炼金专精等级,仅供叙事提及 */
  lvProf?: number;
  /** 是否使用梦境露水(影响叙事,不影响数值) */
  useDew?: boolean;
  /** 第几次尝试(0 = 首次);>0 时会把上一轮错误回灌 */
  attempt?: number;
  /** 上一轮校验失败的原始错误列表 */
  previousErrors?: readonly string[];
  /** 上一轮的原始输出(截断后回灌,便于模型定位错误) */
  previousRaw?: string;
}

export function describeMaterials(materials: readonly PromptMaterial[]): string {
  return materials
    .map((m, i) => `  ${i + 1}. #${m.id} ${m.name}（词条:${m.tags.join('、')}）`)
    .join('\n');
}

export function buildUserPrompt(opts: BuildUserPromptOptions): string {
  const lines: string[] = [];
  lines.push('咕噜——炉盖掀开了,今天丢进来的是这几样东西:');
  lines.push(describeMaterials(opts.materials));
  lines.push('');
  lines.push(`炉子的算盘先替你估了一下:这堆东西的「亲和度」是 ${opts.affinity.toFixed(3)}(0~1),`);
  lines.push(`所以你给的 logic_synergy_score 应该围绕 ${opts.suggestedSLogic.toFixed(3)} 上下浮动一点点。`);
  if ((opts.lvProf ?? 0) > 0) lines.push(`炼金的人已经练到专精 ${opts.lvProf} 级了,锅里的火候很稳。`);
  if (opts.useDew) lines.push('有一滴梦境露水掉进去了,炉子里飘着好闻的困意。');
  lines.push('');
  lines.push('请按 JSON Schema 生成一个全新的奇物,记住:不要输出任何属性数值,只给倾向权重。');

  if (opts.attempt && opts.attempt > 0) {
    lines.push('');
    lines.push(`【第 ${opts.attempt} 次重试】你上一次的输出没有通过炉子的检查,错误如下:`);
    for (const e of opts.previousErrors ?? []) lines.push(`  × ${e}`);
    if (opts.previousRaw) {
      const raw = opts.previousRaw.length > 1200 ? `${opts.previousRaw.slice(0, 1200)}…(已截断)` : opts.previousRaw;
      lines.push('你上次的原文(供定位):');
      lines.push(raw);
    }
    lines.push('请只修正上述问题,其余内容可以保持不变,重新输出完整的 JSON 对象。');
  }
  return lines.join('\n');
}

/** 把三个 few-shot 装配成 messages 数组(供注入式 LlmClient 使用)。 */
export function buildFewShotMessages(): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const fs of FEW_SHOTS) {
    const materials: PromptMaterial[] = fs.inputIds.map((id, i) => ({
      id,
      name: fs.inputNames[i] ?? itemName(id),
      tags: [],
      value: 0,
    }));
    out.push({
      role: 'user',
      content: buildUserPrompt({ materials, affinity: 0.7, suggestedSLogic: fs.output.logic_synergy_score }),
    });
    out.push({ role: 'assistant', content: JSON.stringify(fs.output) });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
 * 5. 校验器(补齐 JSON Schema 表达不了的约束)
 * ══════════════════════════════════════════════════════════════ */

export interface ValidationIssue {
  path: string;
  code: string;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** 通过时给出规范化后的对象(权重已归一化、契合度已钳制、颜色已规范、机制已纠正) */
  value?: LLMAlchemyOutputSchema;
  /** 类别 × 机制越界纠正记录(U4);无越界则为空数组 */
  corrections: MechanicCorrection[];
  /** 是否发生过越界纠正;遥测字段 */
  corrected: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normHex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return `#${s.toLowerCase()}`;
}

const KNOWN_KEYS = new Set(Object.keys(ALCHEMY_JSON_SCHEMA.properties as Record<string, unknown>));

/**
 * 全量校验。结果分三类:
 *  - 硬失败(重试):缺字段、枚举非法、额外字段、像素矩阵非法、名称超长。
 *    「结构性问题」——产物根本没法用,必须让模型重来。
 *  - 可修复/可忽略(不重试):契合度越界(钳制)、权重和≠1(归一化)。
 *    玩家对这些无感知,没必要烧掉一次 Token 往返。
 *  - **越界即纠正(不重试)**:类别 × 机制组合不自洽(Lead 裁决 U4)。
 *    这是「品味」问题,产物依然可用,直接确定性纠正为类别默认机制,
 *    并置 `corrected: true` 供遥测统计。
 *  注意:**权重四项全为 0** 属于硬失败,归一化无从下手。
 */
export function validateAlchemyOutput(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const corrections: MechanicCorrection[] = [];
  const hard = (path: string, code: string, detail: string): void => {
    issues.push({ path, code, detail });
  };

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [{ path: '$', code: 'NOT_OBJECT', detail: `顶层应为 JSON 对象,实际 ${Array.isArray(raw) ? 'array' : typeof raw}` }],
      corrections: [],
      corrected: false,
    };
  }

  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) hard(k, 'EXTRA_FIELD', `出现了 Schema 未定义的字段 "${k}"(additionalProperties:false)`);
  }
  for (const k of KNOWN_KEYS) {
    if (!(k in raw)) hard(k, 'MISSING_FIELD', `缺少必填字段 "${k}"`);
  }

  /* item_name */
  const name = raw.item_name;
  if (typeof name !== 'string') hard('item_name', 'NOT_STRING', 'item_name 必须是字符串');
  else {
    const trimmed = name.trim();
    if (trimmed.length < MIN_ITEM_NAME_LEN || trimmed.length > MAX_ITEM_NAME_LEN) {
      hard('item_name', 'LENGTH', `item_name 长度应∈[${MIN_ITEM_NAME_LEN},${MAX_ITEM_NAME_LEN}],实际 ${trimmed.length}:「${trimmed}」`);
    }
    if (/[《》"“”\n\t]/.test(trimmed)) hard('item_name', 'BAD_CHARS', `item_name 不应含书名号/引号/换行:「${trimmed}」`);
  }

  /* lore_description */
  const lore = raw.lore_description;
  if (typeof lore !== 'string') hard('lore_description', 'NOT_STRING', 'lore_description 必须是字符串');
  else {
    const t = lore.trim();
    if (t.length < MIN_LORE_LEN || t.length > MAX_LORE_LEN) {
      hard('lore_description', 'LENGTH', `lore_description 长度应∈[${MIN_LORE_LEN},${MAX_LORE_LEN}],实际 ${t.length}`);
    }
  }

  /* 四个枚举 */
  const enumFields: [string, readonly string[]][] = [
    ['item_category', Object.values(AlchemyCategory)],
    ['primary_mechanic', Object.values(PrimaryMechanic)],
    ['secondary_element', Object.values(SecondaryElement)],
  ];
  for (const [field, allowed] of enumFields) {
    const v = raw[field];
    if (typeof v !== 'string' || !allowed.includes(v)) {
      hard(field, 'ENUM', `${field} 取值非法:「${String(v)}」,必须∈{${allowed.join(',')}}`);
    }
  }

  /* logic_synergy_score */
  let sLogic = S_LOGIC_FLOOR;
  const s = raw.logic_synergy_score;
  if (typeof s !== 'number' || !Number.isFinite(s)) {
    hard('logic_synergy_score', 'NOT_NUMBER', `logic_synergy_score 必须是数字,实际 ${String(s)}`);
  } else if (s < S_LOGIC_FLOOR || s > S_LOGIC_CEIL) {
    issues.push({ path: 'logic_synergy_score', code: 'CLAMPED', detail: `logic_synergy_score ${s} 越界,已钳制到 [${S_LOGIC_FLOOR},${S_LOGIC_CEIL}]` });
    sLogic = clampNum(s, S_LOGIC_FLOOR, S_LOGIC_CEIL);
  } else {
    sLogic = s;
  }

  /* stat_weights */
  let weights: StatWeights | undefined;
  const w = raw.stat_weights;
  const weightKeys = ['atk_weight', 'def_weight', 'impulse_weight', 'utility_weight'];
  if (!isPlainObject(w)) {
    hard('stat_weights', 'NOT_OBJECT', 'stat_weights 必须是对象');
  } else {
    const missing = weightKeys.filter((k) => !(k in w));
    const extra = Object.keys(w).filter((k) => !weightKeys.includes(k));
    for (const k of missing) hard(`stat_weights.${k}`, 'MISSING_FIELD', `缺少 ${k}`);
    for (const k of extra) hard(`stat_weights.${k}`, 'EXTRA_FIELD', `stat_weights 多出字段 ${k}`);
    const nums: Partial<StatWeights> = {};
    let numericOk = missing.length === 0 && extra.length === 0;
    for (const k of weightKeys) {
      const v = w[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        hard(`stat_weights.${k}`, 'NOT_NUMBER', `${k} 必须是数字,实际 ${String(v)}`);
        numericOk = false;
        continue;
      }
      if (v < 0 || v > 1) {
        hard(`stat_weights.${k}`, 'RANGE', `${k} 应∈[0,1],实际 ${v}`);
        numericOk = false;
        continue;
      }
      (nums as Record<string, number>)[k] = v;
    }
    if (numericOk) {
      const sum = weightsSum(nums as StatWeights);
      const positive = weightKeys.filter((k) => (nums as Record<string, number>)[k] > 0).length;
      if (positive === 0) {
        hard('stat_weights', 'ALL_ZERO', 'stat_weights 四项全为 0,无法归一化');
      } else if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
        issues.push({ path: 'stat_weights', code: 'NORMALIZED', detail: `四项之和 ${sum.toFixed(6)} ≠ 1,已自动归一化` });
        weights = {
          atk_weight: (nums as StatWeights).atk_weight / sum,
          def_weight: (nums as StatWeights).def_weight / sum,
          impulse_weight: (nums as StatWeights).impulse_weight / sum,
          utility_weight: (nums as StatWeights).utility_weight / sum,
        };
      } else {
        weights = nums as StatWeights;
      }
    }
  }

  /* visual_style */
  const vs = raw.visual_style;
  let iconCheck: PixelMatrixCheck = { ok: false, problems: [], inkPixels: 0, usedChars: [] };
  let silhouette: string | undefined;
  let aura: string | undefined;
  let pHex: string | undefined;
  let sHex: string | undefined;
  let oHex: string | undefined;
  if (!isPlainObject(vs)) {
    hard('visual_style', 'NOT_OBJECT', 'visual_style 必须是对象');
  } else {
    const vsKeys = ['base_silhouette', 'primary_color_hex', 'secondary_color_hex', 'outline_color_hex', 'particle_aura', 'pixel_icon_16x16'];
    for (const k of Object.keys(vs)) if (!vsKeys.includes(k)) hard(`visual_style.${k}`, 'EXTRA_FIELD', `visual_style 多出字段 ${k}`);
    for (const k of vsKeys) if (!(k in vs)) hard(`visual_style.${k}`, 'MISSING_FIELD', `缺少 visual_style.${k}`);

    const silAllowed = Object.values(BaseSilhouette);
    if (typeof vs.base_silhouette !== 'string' || !silAllowed.includes(vs.base_silhouette)) {
      hard('visual_style.base_silhouette', 'ENUM', `base_silhouette 取值非法:「${String(vs.base_silhouette)}」`);
    } else silhouette = vs.base_silhouette;

    const auraAllowed = Object.values(ParticleAura);
    if (typeof vs.particle_aura !== 'string' || !auraAllowed.includes(vs.particle_aura)) {
      hard('visual_style.particle_aura', 'ENUM', `particle_aura 取值非法:「${String(vs.particle_aura)}」`);
    } else aura = vs.particle_aura;

    for (const [field, setter] of [['primary_color_hex', (v: string) => { pHex = v; }], ['secondary_color_hex', (v: string) => { sHex = v; }], ['outline_color_hex', (v: string) => { oHex = v; }]] as [string, (v: string) => void][]) {
      const nv = normHex(vs[field]);
      if (!nv) hard(`visual_style.${field}`, 'HEX', `${field} 必须是 #RRGGBB,实际「${String(vs[field])}」`);
      else setter(nv);
    }

    iconCheck = validatePixelMatrix(vs.pixel_icon_16x16);
    if (!iconCheck.ok) {
      hard('visual_style.pixel_icon_16x16', 'PIXEL_MATRIX', describePixelProblems(iconCheck, 4));
    }
  }

  const blocking = issues.filter((i) => i.code !== 'CLAMPED' && i.code !== 'NORMALIZED');
  if (blocking.length > 0 || !weights || !silhouette || !aura || !pHex || !sHex || !oHex) {
    return { ok: false, issues, corrections, corrected: corrections.length > 0 };
  }

  /* 类别 × 机制交叉约束(U4):越界即确定性纠正,不消耗重试配额 */
  const rawCategory = raw.item_category as string;
  const rawMechanic = raw.primary_mechanic as string;
  const fix = correctMechanic(rawCategory, rawMechanic);
  let finalMechanic = rawMechanic;
  if (fix) {
    corrections.push(fix);
    finalMechanic = fix.to;
    issues.push({
      path: 'primary_mechanic',
      code: 'CORRECTED',
      detail: `类别 ${fix.category} 不允许机制 ${fix.from},已确定性纠正为 ${fix.to}(不消耗重试配额)`,
    });
  }

  const okName = typeof name === 'string' ? name.trim() : '';
  const okLore = typeof lore === 'string' ? lore.trim() : '';
  return {
    ok: true,
    issues,
    corrections,
    corrected: corrections.length > 0,
    value: {
      item_name: okName,
      lore_description: okLore,
      item_category: rawCategory as LLMAlchemyOutputSchema['item_category'],
      primary_mechanic: finalMechanic as LLMAlchemyOutputSchema['primary_mechanic'],
      secondary_element: raw.secondary_element as LLMAlchemyOutputSchema['secondary_element'],
      logic_synergy_score: sLogic,
      stat_weights: weights,
      visual_style: {
        base_silhouette: silhouette as LLMAlchemyOutputSchema['visual_style']['base_silhouette'],
        primary_color_hex: pHex,
        secondary_color_hex: sHex,
        outline_color_hex: oHex,
        particle_aura: aura as LLMAlchemyOutputSchema['visual_style']['particle_aura'],
        pixel_icon_16x16: [...(vs as { pixel_icon_16x16: string[] }).pixel_icon_16x16],
      },
    },
  };
}

/** 把 issues 压成可直接回灌 LLM 的字符串数组。 */
export function issueMessages(issues: readonly ValidationIssue[], limit = 6): string[] {
  return issues.slice(0, limit).map((i) => `${i.path || '$'} [${i.code}] ${i.detail}`);
}

/** 解析模型可能带 markdown 围栏 / 前后缀的原始文本,尽量抠出 JSON 对象。 */
export function extractJsonObject(text: unknown): { ok: boolean; value?: unknown; error?: string } {
  if (typeof text !== 'string') return { ok: false, error: `响应不是字符串(${typeof text})` };
  let s = text.trim();
  if (s.length === 0) return { ok: false, error: '响应为空' };
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return { ok: false, error: '响应中找不到 JSON 对象' };
  const slice = s.slice(first, last + 1);
  try {
    return { ok: true, value: JSON.parse(slice) };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败:${err instanceof Error ? err.message : String(err)}` };
  }
}

export const MAX_RETRY = 2;

/** 自检:三个 few-shot 必须全部能通过校验器。 */
export function selfCheckFewShots(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  FEW_SHOTS.forEach((fs, i) => {
    const r = validateAlchemyOutput(fs.output);
    if (!r.ok) {
      errors.push(`few-shot #${i}(${fs.output.item_name}) 校验失败:${issueMessages(r.issues, 3).join(' / ')}`);
    }
  });
  if (FEW_SHOTS.length !== 3) errors.push(`few-shot 数量应为 3,实际 ${FEW_SHOTS.length}`);
  return { ok: errors.length === 0, errors };
}