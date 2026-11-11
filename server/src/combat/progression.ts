/**
 * WS-10-C 等级 / 天赋 / 全队经验共享(server/src/combat/progression.ts)
 *
 * 冻结层事实源:
 *   · expToNext(L) = 50L² + 50L          (shared/types/entities.ts)
 *   · statsAtLevel(L) = HP 100+15(L−1), dmgMul 1+0.03(L−1), carrySlots 8+(L−1)
 *   · TALENT_LEVELS = [5,10,15,20,25,30]
 *   · SHARE_EXP_RADIUS=24 / PARTY_BONUS_THRESHOLD=3 / PARTY_BONUS=0.25 / AFK_EXP_RATIO=0.3
 *
 * 本模块不复制任何冻结公式,全部经 import 取用,保证双实现不会漂移。
 */

import {
  AFK_EXP_RATIO,
  MAX_LEVEL,
  PARTY_BONUS,
  PARTY_BONUS_THRESHOLD,
  SHARE_EXP_RADIUS,
  TALENT_LEVELS,
  expToNext,
  statsAtLevel,
} from '../../../shared/types/entities.ts';

export const SHARE_RADIUS = SHARE_EXP_RADIUS;
export const TALENT_UNLOCK_LEVELS = TALENT_LEVELS;

/* ───────────────────────────── 天赋表(6 条,5/10/15/20/25/30 解锁) ───────────────────────────── */

export interface TalentDef {
  id: string;
  name: string;
  unlockLevel: number;
  /** 一句话机制说明 */
  summary: string;
  /** 可断言的效果数值字典 */
  effects: Record<string, number>;
}

export const TALENTS: readonly TalentDef[] = [
  {
    id: 'talent_roll_bomb', name: '翻滚·残影炸弹', unlockLevel: 5,
    summary: '翻滚后原地留下一个残影泡沫,0.6 秒后炸开并击退周围小怪。',
    effects: {
      shadowBombRatio: 0.40,   // 伤害 = 攻击力 × 40%
      shadowBombSec: 2.0,      // 残影存在 2.0 秒
      shadowBombRadius: 1.5,   // 爆炸半径 1.5 格
      rollCdMul: 0.80,         // 翻滚冷却 ×0.80
    },
  },
  {
    id: 'talent_throw_master', name: '大力士·投掷精通', unlockLevel: 10,
    summary: '举起与投掷伤害翻倍,投掷距离 +1 格,并可把中小型怪物当炮弹扔出去。',
    effects: {
      throwDamageMul: 2.00,    // 投掷伤害翻倍
      throwRangeBonus: 1.0,    // 投掷距离 +1 格
      throwSpeedMul: 1.10,     // 投掷初速 ×1.10
      carrySlowdownRelief: 0.10, // 叠罗汉减速减轻 10%
    },
  },
  {
    id: 'talent_rescue_swift', name: '急救快手·把队友拉起来', unlockLevel: 15,
    summary: '救援队友所需时间减半(1.0s → 0.5s),复活后额外多 10% 生命。',
    effects: {
      reviveTimeMul: 0.50,     // 救援速度翻倍
      reviveHpRatioBonus: 0.10, // 复活血量 50% → 60%
      reviveRadiusBonus: 0.5,  // 救援判定半径 +0.5 格
    },
  },
  {
    id: 'talent_crit_master', name: '暴击大师', unlockLevel: 20,
    summary: '暴击率 +8%,暴击伤害 +25%。',
    effects: { critRateBonus: 0.08, critDmgBonus: 0.25 },
  },
  {
    id: 'talent_element_affinity', name: '元素亲和', unlockLevel: 25,
    summary: '元素克制幅度放大 25%(1.5 → 1.875),被克制方的减伤也同步放大。',
    effects: { elementMulBonus: 0.25, counterAmpCap: 1.875, resistAmpFloor: 0.375 },
  },
  {
    id: 'talent_dream_revelation', name: '梦境启示', unlockLevel: 30,
    summary: '全部经验获取 +20%;打盹见习经验由 0.3 提升到 0.45;打盹攒露水速度 ×1.5。',
    effects: { expGainMul: 1.20, afkExpRatio: 0.45, dewRateMul: 1.5 },
  },
];

export const TALENT_BY_ID: ReadonlyMap<string, TalentDef> = new Map(TALENTS.map((t) => [t.id, t]));

/** 等级 → 已解锁天赋(按解锁顺序) */
export function activeTalents(level: number): TalentDef[] {
  return TALENTS.filter((t) => level >= t.unlockLevel);
}

/** 某个等级刚刚解锁的天赋(升级动画用) */
export function talentsUnlockedAt(level: number): TalentDef[] {
  return TALENTS.filter((t) => t.unlockLevel === level);
}

export function isTalentUnlocked(level: number, talentId: string): boolean {
  const t = TALENT_BY_ID.get(talentId);
  return t !== undefined && level >= t.unlockLevel;
}

/* ───────────────────────────── 经验曲线 ───────────────────────────── */

/** 1 → L 的累计所需经验(不含 L 级内进度) */
export function cumulativeExp(level: number): number {
  const l = Math.max(1, Math.floor(level));
  let sum = 0;
  for (let i = 1; i < l; i += 1) sum += expToNext(i);
  return sum;
}

/** 从 Lv.1 升到 Lv.30 的累计经验 = 449500 */
export function expToReachMax(): number {
  return cumulativeExp(MAX_LEVEL);
}

/* ───────────────────────────── 玩家成长档案 ───────────────────────────── */

export interface PlayerProgress {
  playerId: string;
  level: number;
  /** 当前等级内的经验进度 */
  exp: number;
  /** 开档以来的累计总经验 */
  totalExp: number;
  maxHp: number;
  dmgMul: number;
  carrySlots: number;
  /** 天赋钩子:每级重算后写入,供战斗管线读取 */
  talentFlags: Record<string, number>;
}

export function createProgress(playerId: string): PlayerProgress {
  return recompute({ playerId, level: 1, exp: 0, totalExp: 0, maxHp: 0, dmgMul: 1, carrySlots: 8, talentFlags: {} });
}

function recompute(p: PlayerProgress): PlayerProgress {
  const s = statsAtLevel(p.level);
  const flags: Record<string, number> = {};
  for (const t of activeTalents(p.level)) {
    for (const [k, v] of Object.entries(t.effects)) flags[k] = v;
  }
  return { ...p, maxHp: s.maxHp, dmgMul: s.dmgMul, carrySlots: s.carrySlots, talentFlags: flags };
}

export interface LevelUpEvent {
  from: number;
  to: number;
  talents: TalentDef[];
  maxHp: number;
}

export interface ExpGainResult {
  progress: PlayerProgress;
  /** 实际入账经验(满级后为 0) */
  gained: number;
  /** 溢出的废经验(满级) */
  overflow: number;
  levelUps: LevelUpEvent[];
  /** 升级动画:是否播放 + 建议时长(秒) */
  animation: { play: boolean; seconds: number };
}

/**
 * 入账经验并连续升级。满级后经验不再累积(overflow 记账便于 UI 提示)。
 * restartAt:便于测试指定起点等级。
 */
export function gainExp(progress: PlayerProgress, amount: number): ExpGainResult {
  const add = Math.max(0, amount);
  if (progress.level >= MAX_LEVEL) {
    return {
      progress, gained: 0, overflow: add, levelUps: [],
      animation: { play: false, seconds: 0 },
    };
  }
  let level = progress.level;
  let exp = progress.exp + add;
  let totalExp = progress.totalExp + add;
  const levelUps: LevelUpEvent[] = [];
  while (level < MAX_LEVEL) {
    const need = expToNext(level);
    if (exp < need) break;
    exp -= need;
    level += 1;
    const next = recompute({ ...progress, level, exp, totalExp });
    levelUps.push({
      from: level - 1,
      to: level,
      talents: talentsUnlockedAt(level),
      maxHp: next.maxHp,
    });
  }
  if (level >= MAX_LEVEL) exp = 0;
  const out = recompute({ ...progress, level, exp, totalExp });
  return {
    progress: out,
    gained: add,
    overflow: 0,
    levelUps,
    animation: { play: levelUps.length > 0, seconds: levelUps.length > 0 ? 1.2 : 0 },
  };
}

/** 直接把档案设到某等级(调试/回滚用),保留累计经验一致性。 */
export function setLevel(progress: PlayerProgress, level: number): PlayerProgress {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return recompute({ ...progress, level: l, exp: 0, totalExp: Math.max(progress.totalExp, cumulativeExp(l)) });
}

/* ───────────────────────────── 全队经验共享 ───────────────────────────── */

/**
 * 同一怪多人结算的总额上限倍数(防刷硬闸)。
 * 取 5.0 的依据:3 人满编欢聚的总额 = 1.25 × 3 = 3.75 倍基础经验,
 * 5.0 留出 33% 余量不误伤正常组队;8 人同屏时 rawTotal = 10 倍,
 * 触发闸门并等比缩放到 5 倍,人均反而低于 3 人队,构成防刷激励。
 */
export const PER_MOB_EXP_CAP_MULT = 5.0;
/** 等级压制:玩家每高出怪物 1 级,经验 −10% */
export const LEVEL_GAP_STEP = 0.10;
export const LEVEL_GAP_MIN = 0.10;

export interface ShareParticipant {
  playerId: string;
  /** 与击杀点的水平距离(格) */
  distance: number;
  level: number;
  /** 打盹/挂机状态:只拿梦境见习经验 */
  afk: boolean;
  /** 外部经验增益乘区(613 庆典蛋糕 1.30) */
  expBonusMul?: number;
  /** 是否已解锁 Lv.30 天赋「梦境启示」 */
  hasDreamTalent?: boolean;
}

export interface ShareContext {
  /** 怪实例唯一 ID:去重的关键 */
  mobInstanceId: string;
  /** 怪等级,用于等级压制 */
  mobLevel: number;
  baseExp: number;
  participants: readonly ShareParticipant[];
}

export interface ShareEntry {
  playerId: string;
  /** 最终入账经验(四舍五入取整) */
  share: number;
  inRadius: boolean;
  afkApplied: boolean;
  partyMul: number;
  levelMul: number;
  bonusMul: number;
  /** 是否因总额上限被等比缩减 */
  scaledDown: boolean;
}

export interface ShareResult {
  mobInstanceId: string;
  entries: ShareEntry[];
  /** 实际总发放 */
  total: number;
  /** 未裁剪前的理论总额 */
  rawTotal: number;
  /** 本次允许的总额上限 */
  cap: number;
  capped: boolean;
  /** 结算时参与人数(24 格内、非打盹者计入阈值) */
  participantCount: number;
  partyMul: number;
  /** 重复结算被拒绝 */
  deduped: boolean;
  /** 24 格内削减掉的玩家数 */
  outOfRangeCount: number;
}

/** 击杀去重账本:同一怪实例只允许结算一次 */
export class KillLedger {
  private claimed: Set<string>;

  constructor() {
    this.claimed = new Set<string>();
  }

  claim(id: string): boolean {
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    return true;
  }

  has(id: string): boolean {
    return this.claimed.has(id);
  }

  size(): number {
    return this.claimed.size;
  }

  reset(): void {
    this.claimed.clear();
  }
}

/** 等级压制系数 */
export function levelGapMul(playerLevel: number, mobLevel: number): number {
  const diff = playerLevel - mobLevel;
  if (diff <= 0) return 1.0;
  return Math.max(LEVEL_GAP_MIN, 1 - LEVEL_GAP_STEP * diff);
}

/**
 * 全队经验共享结算。
 * 规则:
 *   1. 距离 > 24 格 → 0 经验(不因补刀者远近而改变);
 *   2. 24 格内一律 100% 基础经验,补刀者不额外加成;
 *   3. 参与人数(24 格内且非打盹)≥ 3 → 每人 ×1.25 欢聚加成;
 *   4. 打盹/挂机 → ×0.3 梦境见习经验(仍享受欢聚加成之前的份额);
 *   5. 同一怪实例只结算一次(KillLedger);
 *   6. 总额硬上限 = baseExp × 4.0,超出按等比缩减。
 */
export function settleMobExp(
  ledger: KillLedger,
  ctx: ShareContext,
): ShareResult {
  const partyEligible = ctx.participants.filter((p) => p.distance <= SHARE_RADIUS && !p.afk).length;
  const partyMul = partyEligible >= PARTY_BONUS_THRESHOLD ? 1 + PARTY_BONUS : 1.0;
  const cap = ctx.baseExp * PER_MOB_EXP_CAP_MULT;

  if (!ledger.claim(ctx.mobInstanceId)) {
    return {
      mobInstanceId: ctx.mobInstanceId, entries: [], total: 0, rawTotal: 0, cap, capped: false,
      participantCount: partyEligible, partyMul, deduped: true, outOfRangeCount: 0,
    };
  }

  const provisional: ShareEntry[] = [];
  let rawTotal = 0;
  let outOfRangeCount = 0;
  for (const p of ctx.participants) {
    const inRadius = p.distance <= SHARE_RADIUS;
    if (!inRadius) {
      outOfRangeCount += 1;
      provisional.push({
        playerId: p.playerId, share: 0, inRadius: false, afkApplied: p.afk,
        partyMul: 1, levelMul: 1, bonusMul: 1, scaledDown: false,
      });
      continue;
    }
    const afkMul = p.afk
      ? (p.hasDreamTalent
        ? TALENT_BY_ID.get('talent_dream_revelation')!.effects.afkExpRatio
        : AFK_EXP_RATIO)
      : 1.0;
    const lvMul = levelGapMul(p.level, ctx.mobLevel);
    const bonusMul = (p.expBonusMul ?? 1.0) * (p.hasDreamTalent
      ? TALENT_BY_ID.get('talent_dream_revelation')!.effects.expGainMul
      : 1.0);
    const raw = ctx.baseExp * partyMul * afkMul * lvMul * bonusMul;
    rawTotal += raw;
    provisional.push({
      playerId: p.playerId, share: raw, inRadius: true, afkApplied: p.afk,
      partyMul, levelMul: Math.round(lvMul * 1000) / 1000, bonusMul, scaledDown: false,
    });
  }

  const capped = rawTotal > cap && rawTotal > 0;
  const scale = capped ? cap / rawTotal : 1.0;
  /* 裁剪时先向下取整,再把余数逐个补给前几名,保证分项之和恰好等于总额上限 */
  const entries = provisional.map((e) => ({
    ...e,
    share: capped && e.share > 0 ? Math.floor(e.share * scale) : Math.round(e.share),
    scaledDown: capped && e.share > 0,
  }));
  if (capped) {
    const target = Math.floor(cap);
    let allocated = entries.reduce((a, b) => a + b.share, 0);
    let leftover = target - allocated;
    for (let i = 0; i < entries.length && leftover > 0; i += 1) {
      if (entries[i].share > 0) {
        entries[i].share += 1;
        leftover -= 1;
      }
    }
    allocated = entries.reduce((a, b) => a + b.share, 0);
    void allocated;
  }
  const total = entries.reduce((a, b) => a + b.share, 0);

  return {
    mobInstanceId: ctx.mobInstanceId,
    entries, total, rawTotal: Math.round(rawTotal * 100) / 100, cap,
    capped, participantCount: partyEligible, partyMul, deduped: false, outOfRangeCount,
  };
}

/** 便捷:把一次结算直接写进各玩家档案。 */
export function applyShareResult(
  progresses: ReadonlyMap<string, PlayerProgress>,
  result: ShareResult,
): { progresses: Map<string, PlayerProgress>; events: Map<string, ExpGainResult> } {
  const next = new Map(progresses);
  const events = new Map<string, ExpGainResult>();
  for (const e of result.entries) {
    const p = next.get(e.playerId);
    if (!p || e.share <= 0) continue;
    const r = gainExp(p, e.share);
    next.set(e.playerId, r.progress);
    events.set(e.playerId, r);
  }
  return { progresses: next, events };
}

/* ───────────────────────────── 洗练重铸(533 魔镜) ───────────────────────────── */

export const REBIRTH_DEW_COST = 5;
export const REBIRTH_AFFIX_POOL: readonly string[] = [
  'atk_pct', 'def_flat', 'hp_flat', 'crit_rate', 'crit_dmg', 'dodge_rate',
  'element_fire', 'element_ice', 'element_lightning', 'element_light',
  'cooldown_cut', 'knockback_mul', 'lifesteal', 'shield_break',
];

export interface RebirthResult {
  affix: string;
  roll: number;
  tier: number;
  value: number;
  dewCost: number;
}

/** 洗练:消耗 5 露水,从 14 词条池中滚 1 条,tier 由 roll 分档。 */
export function reforge(roll: number, pick: number): RebirthResult {
  const len = REBIRTH_AFFIX_POOL.length;
  const idx = Math.abs(Math.floor(pick * len)) % len;
  const affix = REBIRTH_AFFIX_POOL[idx];
  const tier = roll < 0.55 ? 1 : roll < 0.87 ? 2 : roll < 0.98 ? 3 : 4;
  const value = Math.round((0.5 + 0.5 * tier) * 100) / 100;
  return { affix, roll, tier, value, dewCost: REBIRTH_DEW_COST };
}
