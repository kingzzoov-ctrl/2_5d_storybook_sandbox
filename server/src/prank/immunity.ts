/**
 * WS-11 · 218「工程安全帽(和平盾)」100% 免疫清单
 *
 * 冻结层事实源 `items.ts` #218:
 *   「初始背包常驻开关。开启后头顶显示黄色安全帽,100% 免疫队友举起、大锤击退与香蕉皮。」
 * 手册 §6.2 补充:整蛊玩具「互坑但不痛」,队友侧一律零伤害。和平盾把「队友施加的状态」整类屏蔽,
 * 但**不屏蔽 Boss 伤害、野生怪物伤害、地形与炉火灼烧** —— 否则就变成无敌挂了。
 *
 * 三档裁定:
 *   ALLY    队友施加的整蛊载荷  → 和平盾开启时 100% 免疫(状态不下发、位移不发生、伤害为零)
 *   SELF    自己使用自己的道具  → 和平盾不拦截(避免把自己锁死)
 *   HOSTILE 怪物 / Boss / 环境  → 和平盾不拦截
 */

import { PRANK_TOYS, PRANK_TOY_BY_ID, type ToyStateFlag } from './toys.ts';

export { SAFE_SHIELD_ITEM_ID } from './toys.ts';

export const EFFECT_ORIGIN = {
  ALLY: 'ALLY',
  SELF: 'SELF',
  HOSTILE: 'HOSTILE',
} as const;
export type EffectOrigin = (typeof EFFECT_ORIGIN)[keyof typeof EFFECT_ORIGIN];

export const EFFECT_ORIGINS: readonly EffectOrigin[] = ['ALLY', 'SELF', 'HOSTILE'];

export const SHIELD_VERDICT = {
  /** 完全免疫:状态与位移都不下发 */
  IMMUNE: 'IMMUNE',
  /** 不免疫:照常结算 */
  NOT_IMMUNE: 'NOT_IMMUNE',
} as const;
export type ShieldVerdict = (typeof SHIELD_VERDICT)[keyof typeof SHIELD_VERDICT];

/** 非整蛊玩具类伤害/状态来源(和平盾一律不免疫)。 */
export const HOSTILE_SOURCE = {
  BOSS_SKILL: 'BOSS_SKILL',
  BOSS_MELEE: 'BOSS_MELEE',
  WILD_ATTACK: 'WILD_ATTACK',
  LAVA_BURN: 'LAVA_BURN',
  FALL_DAMAGE: 'FALL_DAMAGE',
  STATION_FIRE_BURN: 'STATION_FIRE_BURN',
  DROWNING: 'DROWNING',
} as const;
export type HostileSource = (typeof HOSTILE_SOURCE)[keyof typeof HOSTILE_SOURCE];

export const HOSTILE_SOURCES: readonly HostileSource[] = [
  'BOSS_SKILL', 'BOSS_MELEE', 'WILD_ATTACK',
  'LAVA_BURN', 'FALL_DAMAGE', 'STATION_FIRE_BURN', 'DROWNING',
];

export const HOSTILE_SOURCE_LABEL: Readonly<Record<HostileSource, string>> = {
  BOSS_SKILL: 'Boss 技能伤害(红圈 / 激光 / 震地波)',
  BOSS_MELEE: 'Boss 近身撞击',
  WILD_ATTACK: '野生敌对怪物攻击',
  LAVA_BURN: '熔岩灼烧',
  FALL_DAMAGE: '高处坠落',
  STATION_FIRE_BURN: '高炉 / 汤锅起火灼烧',
  DROWNING: '深水窒息',
};

export interface ImmunityEntry {
  /** 来源键:整蛊玩具用 `PRANK:<id>`,其它用 HostileSource */
  key: string;
  label: string;
  /** 整蛊玩具 ID;非玩具来源为 null */
  toyId: number | null;
  /** 该来源施加的状态标记 */
  flag: ToyStateFlag | 'DAMAGE';
  /** 队友施加时和平盾是否免疫 */
  allyImmune: boolean;
  /** 自用时和平盾是否免疫 */
  selfImmune: boolean;
  /** 怪物 / 环境施加时和平盾是否免疫 */
  hostileImmune: boolean;
  /** 判定依据 */
  rationale: string;
}

/**
 * 由玩具表机器生成 35 条队友载荷免疫条目 —— 保证「35 项全覆盖」不可能漏项。
 * 任何新增 / 改名玩具都会自动进入清单,单测无需改表。
 */
function buildToyEntries(): ImmunityEntry[] {
  return PRANK_TOYS.map((t) => ({
    key: `PRANK:${t.id}`,
    label: `${t.id} ${t.name}`,
    toyId: t.id,
    flag: t.allyEffect.flag,
    allyImmune: true,
    selfImmune: false,
    hostileImmune: false,
    rationale:
      '#218 注释「100% 免疫队友举起、大锤击退与香蕉皮」→ 同类推广:'
      + `队友用 ${t.id} 施加的 ${t.allyEffect.flag} 状态与 ${t.allyEffect.moveTiles} 格位移全部不下发。`,
  }));
}

/** 非玩具类来源条目(和平盾均不免疫)。 */
export const HOSTILE_ENTRIES: readonly ImmunityEntry[] = HOSTILE_SOURCES.map((src) => ({
  key: src,
  label: HOSTILE_SOURCE_LABEL[src],
  toyId: null,
  flag: 'DAMAGE',
  allyImmune: false,
  selfImmune: false,
  hostileImmune: false,
  rationale: '和平盾只屏蔽「队友施加的整蛊载荷」,对伤害来源零屏蔽,否则将破坏战斗平衡。',
}));

/** 完整免疫清单:35 玩具条目 + 7 条敌对来源条目 = 42 条。 */
export const IMMUNITY_MANIFEST: readonly ImmunityEntry[] = [...buildToyEntries(), ...HOSTILE_ENTRIES];

export const IMMUNITY_BY_KEY: ReadonlyMap<string, ImmunityEntry> = new Map(
  IMMUNITY_MANIFEST.map((e) => [e.key, e]),
);

/** 手册点名必须免疫的六个代表项(单测逐项展开)。 */
export const NAMED_IMMUNE_TOY_IDS: readonly number[] = [221, 222, 225, 227, 229, 233];

export const NAMED_IMMUNE_LABEL: Readonly<Record<number, string>> = {
  221: '队友举起',
  222: '大锤击退',
  225: '香蕉皮',
  227: '泡泡',
  229: '变身吹箭',
  233: '雪球',
};

export interface ShieldResolution {
  verdict: ShieldVerdict;
  /** 是否拦截:true 表示不施加任何状态 / 位移 / 伤害 */
  blocked: boolean;
  flag: ToyStateFlag | 'DAMAGE' | null;
  label: string;
  reason: string;
}

/**
 * 统一裁定入口。
 *
 * @param shieldOn 218 工程安全帽是否开启(初始背包常驻开关)
 * @param sourceKey 整蛊玩具传 `PRANK:<id>` 或直接传物品 ID 数字;敌对来源传 HostileSource
 * @param origin 效果来源
 */
export function resolveShield(
  shieldOn: boolean,
  sourceKey: string | number,
  origin: EffectOrigin,
): ShieldResolution {
  const key = typeof sourceKey === 'number' ? `PRANK:${sourceKey}` : sourceKey;
  const entry = IMMUNITY_BY_KEY.get(key);
  if (!entry) {
    return {
      verdict: SHIELD_VERDICT.NOT_IMMUNE,
      blocked: false,
      flag: null,
      label: `未知来源 ${key}`,
      reason: 'UNKNOWN_SOURCE',
    };
  }

  if (!shieldOn) {
    return {
      verdict: SHIELD_VERDICT.NOT_IMMUNE,
      blocked: false,
      flag: entry.flag,
      label: entry.label,
      reason: 'SHIELD_OFF',
    };
  }

  const immune = origin === EFFECT_ORIGIN.ALLY
    ? entry.allyImmune
    : origin === EFFECT_ORIGIN.SELF
      ? entry.selfImmune
      : entry.hostileImmune;

  return {
    verdict: immune ? SHIELD_VERDICT.IMMUNE : SHIELD_VERDICT.NOT_IMMUNE,
    blocked: immune,
    flag: entry.flag,
    label: entry.label,
    reason: immune ? `SHIELD_BLOCK_${origin}` : `SHIELD_PASS_${origin}`,
  };
}

export function isImmuneToAllyPrank(shieldOn: boolean, toyId: number): boolean {
  return resolveShield(shieldOn, toyId, EFFECT_ORIGIN.ALLY).blocked;
}

/** Boss / 怪物 / 环境伤害恒定穿透和平盾。 */
export function isImmuneToHostile(shieldOn: boolean, src: HostileSource): boolean {
  return resolveShield(shieldOn, src, EFFECT_ORIGIN.HOSTILE).blocked;
}

/** 清单完整性自检。 */
export function assertImmunityManifestComplete(): void {
  for (const t of PRANK_TOYS) {
    const e = IMMUNITY_BY_KEY.get(`PRANK:${t.id}`);
    if (!e) throw new Error(`免疫清单缺少整蛊玩具 #${t.id}`);
    if (!e.allyImmune) throw new Error(`#${t.id} 队友载荷未标记为免疫`);
  }
  for (const src of HOSTILE_SOURCES) {
    const e = IMMUNITY_BY_KEY.get(src);
    if (!e) throw new Error(`免疫清单缺少敌对来源 ${src}`);
    if (e.allyImmune || e.selfImmune || e.hostileImmune) {
      throw new Error(`敌对来源 ${src} 被错误标记为免疫`);
    }
  }
  for (const id of NAMED_IMMUNE_TOY_IDS) {
    if (!PRANK_TOY_BY_ID.has(id)) throw new Error(`手册点名的整蛊玩具 #${id} 不在玩具表内`);
  }
}

export interface ShieldState {
  ownerId: string;
  on: boolean;
  /** 佩戴者头顶是否显示黄色安全帽 */
  helmetVisible: boolean;
  /** 累计拦截次数(用于信誉 / 成就) */
  blockedCount: number;
  /** 最近一次拦截的来源键 */
  lastBlockedKey: string | null;
}

export function createShield(ownerId: string, on = true): ShieldState {
  return { ownerId, on, helmetVisible: on, blockedCount: 0, lastBlockedKey: null };
}

/** 切换常驻开关:开关即头盔外观显隐。 */
export function toggleShield(s: ShieldState): ShieldState {
  s.on = !s.on;
  s.helmetVisible = s.on;
  return s;
}

/** 走一遍裁定并累计统计(上层真正施加效果前必调)。 */
export function applyShield(
  s: ShieldState,
  sourceKey: string | number,
  origin: EffectOrigin,
): ShieldResolution {
  const r = resolveShield(s.on, sourceKey, origin);
  if (r.blocked) {
    s.blockedCount += 1;
    s.lastBlockedKey = typeof sourceKey === 'number' ? `PRANK:${sourceKey}` : sourceKey;
  }
  return r;
}

assertImmunityManifestComplete();