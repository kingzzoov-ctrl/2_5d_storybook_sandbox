/**
 * WS-05:祭坛召唤、人数血量缩放与个人独立掉落(Personal Loot)。
 *
 * 依赖冻结层:`shared/constants/bosses.ts`(8 个 Boss 定义)、
 * `shared/types/entities.ts#bossScaledHp`。
 */

import { BOSS_BY_ID, BOSS_LIST } from '../../../shared/constants/bosses.ts';
import { bossScaledHp } from '../../../shared/types/entities.ts';
import type { BossDef } from '../../../shared/types/entities.ts';
import { isInsideSafeRadius } from '../mobs/spawner.ts';
import { createBossState, type BossState } from './phases.ts';

/* ─────────────── 召唤祭品 ─────────────── */

/**
 * Boss → 召唤祭品 ID。冻结层已给出,这里只做**冻结校验与反查**,
 * 数值本体不与手册产生第二事实源。
 */
export const SUMMON_ITEM_BY_BOSS: ReadonlyMap<string, number> = new Map(
  BOSS_LIST.map((b) => [b.id, b.summonItem]),
);

/** 祭品 ID → Boss ID(反查,供祭坛方块判定)。 */
export const BOSS_BY_SUMMON_ITEM: ReadonlyMap<number, string> = new Map(
  BOSS_LIST.map((b) => [b.summonItem, b.id]),
);

/** 祭品 ID 段:734-741,与手册 §3.10 完全一致。 */
export const SUMMON_ITEM_MIN = 734;
export const SUMMON_ITEM_MAX = 741;

/** 召唤要求:同屏最少/最多人数。 */
export const RAID_MIN_PLAYERS = 1;
export const RAID_MAX_PLAYERS = 16;
/** 祭坛周围玩家参与判定半径(格):与经验共享半径一致。 */
export const RAID_PARTICIPATION_RADIUS = 24;

export const SummonReject = {
  OK: 'OK',
  UNKNOWN_BOSS: 'UNKNOWN_BOSS',
  WRONG_ITEM: 'WRONG_ITEM',
  NO_ALTAR: 'NO_ALTAR',
  /** 祭坛落在城镇安全区内 —— 与 `mobs/spawner.ts#SpawnReject.SAFE_ZONE` 同一字符串。 */
  SAFE_ZONE: 'SAFE_ZONE',
  TOO_MANY_PLAYERS: 'TOO_MANY_PLAYERS',
  BOSS_ALIVE: 'BOSS_ALIVE',
} as const;
export type SummonReject = (typeof SummonReject)[keyof typeof SummonReject];

export interface SummonRequest {
  bossId: string;
  /** 玩家投放到祭坛上的物品 ID。 */
  itemId: number;
  /** 是否存在激活的祭坛方块。 */
  hasAltar: boolean;
  /** 祭坛方块坐标(格),用于安全区判定。 */
  altarX: number;
  altarY: number;
  /** 城镇中心坐标(格)。 */
  townCenterX: number;
  townCenterY: number;
  /** 祭坛半径内的人数。 */
  playerCount: number;
  /** 该 Boss 是否已在场内存活。 */
  alreadyAlive: boolean;
}

export interface SummonResult {
  ok: boolean;
  reason: SummonReject;
  state?: BossState;
  /** 缩放后血量。 */
  scaledHp: number;
}

/**
 * 祭坛召唤。
 *
 * 拒绝顺序(短路,由廉价到昂贵):未知 Boss → 祭坛缺失 → **祭坛在城镇安全区内** →
 * 祭品不匹配 → 人数越界 → 已有同 Boss 存活。
 *
 * **安全区规则(Lead 裁决 3)**:祭坛落在安全区内 → 召唤失败。
 * 安全区禁刷怪(`spawner.ts` 的 `SpawnReject.SAFE_ZONE`),Boss 也是怪,同规则;
 * 判定复用 `isInsideSafeRadius`,与刷怪路径共享同一事实源,杜绝双标准。
 */
export function summonBoss(req: SummonRequest): SummonResult {
  const def = BOSS_BY_ID.get(req.bossId);
  if (!def) return { ok: false, reason: SummonReject.UNKNOWN_BOSS, scaledHp: 0 };
  if (!req.hasAltar) return { ok: false, reason: SummonReject.NO_ALTAR, scaledHp: 0 };
  if (isInsideSafeRadius(req.altarX, req.altarY, req.townCenterX, req.townCenterY)) {
    return { ok: false, reason: SummonReject.SAFE_ZONE, scaledHp: 0 };
  }
  if (req.itemId !== def.summonItem) {
    return { ok: false, reason: SummonReject.WRONG_ITEM, scaledHp: 0 };
  }
  if (req.playerCount < RAID_MIN_PLAYERS || req.playerCount > RAID_MAX_PLAYERS) {
    return { ok: false, reason: SummonReject.TOO_MANY_PLAYERS, scaledHp: 0 };
  }
  if (req.alreadyAlive) return { ok: false, reason: SummonReject.BOSS_ALIVE, scaledHp: 0 };
  const state = createBossState(req.bossId, req.playerCount);
  return { ok: true, reason: SummonReject.OK, state, scaledHp: state.maxHp };
}

/* ─────────────── 人数血量缩放 ─────────────── */

export interface ScalingCurve {
  /** 每个 N 的血量。 */
  curve: number[];
  /** 是否严格单调递增。 */
  monotonic: boolean;
  /** N=1 时等于 baseHp。 */
  baseAtOne: boolean;
}

/**
 * 生成 N = 1..maxPlayers 的缩放曲线。
 *
 * 冻结公式 `bossScaledHp(baseHp, n) = round(baseHp × (1 + 0.65(n−1)))`
 * 对 n ≥ 1 恒为严格递增(斜率 0.65 × baseHp ≥ 1625 ≫ 舍入误差 0.5)。
 */
export function scalingCurve(baseHp: number, maxPlayers = 16): ScalingCurve {
  const curve: number[] = [];
  for (let n = 1; n <= maxPlayers; n += 1) curve.push(bossScaledHp(baseHp, n));
  let monotonic = true;
  for (let i = 1; i < curve.length; i += 1) {
    if (!(curve[i] > curve[i - 1])) monotonic = false;
  }
  return { curve, monotonic, baseAtOne: curve[0] === baseHp };
}

/** 全部 8 个 Boss 的缩放曲线摘要。 */
export function allScalingCurves(maxPlayers = 16): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of BOSS_LIST) out[b.id] = bossScaledHp(b.baseHp, maxPlayers);
  return out;
}

/* ─────────────── 个人独立掉落 ─────────────── */

export interface RaidParticipant {
  id: string;
  /** 是否参与了本次战斗(在参与半径内且造成过伤害)。 */
  contributed: boolean;
  /** 累计伤害,用于加权数量。 */
  damageDealt: number;
  x: number;
  y: number;
}

export interface LootEntry { itemId: number; count: number; }

/** 一个只属于某玩家的掉落光球:他人不可见、不可拾取。 */
export interface LootOrb {
  orbId: string;
  ownerId: string;
  x: number;
  y: number;
  entries: LootEntry[];
  exp: number;
  personal: true;
}

/** 掉落光球散布半径(格)。 */
export const LOOT_SCATTER_RADIUS = 2.5;

/** 确定性字符串哈希(FNV-1a 32 位),保证同一 (bossId, ownerId) 掉落可复现。 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 由种子生成可复现的 [0,1) 序列(Mulberry32,与测试桩同族)。 */
export function seededRoll(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 结算个人独立掉落。
 *
 * 规则:
 *  - **每位参与战斗的玩家各自获得一个独立光球**(8 人 → 8 球),
 *    光球 `personal: true` 且 `ownerId` 唯一,互不可见;
 *  - 战利品取自 `def.loot`(必掉清单),数量 = 1 + floor(damageShare × 2);
 *  - 经验按 `def.exp` 全额 × 伤害份额,3 人以上套用冻结层 `PARTY_BONUS`;
 *  - 未参与者(挂机/提前离场)不产出光球。
 */
export function rollPersonalLoot(
  bossId: string,
  participants: readonly RaidParticipant[],
  opts: { partyBonus?: number; dropMul?: number } = {},
): LootOrb[] {
  const def = BOSS_BY_ID.get(bossId);
  if (!def) return [];
  const partyBonus = opts.partyBonus ?? 0;
  const dropMul = opts.dropMul ?? 1;

  const contributors = participants.filter((p) => p.contributed);
  if (contributors.length === 0) return [];
  const totalDamage = contributors.reduce((s, p) => s + Math.max(0, p.damageDealt), 0);
  const evenShare = 1 / contributors.length;

  const orbs: LootOrb[] = [];
  for (const p of contributors) {
    const share = totalDamage > 0 ? Math.max(0, p.damageDealt) / totalDamage : evenShare;
    const rng = seededRoll(fnv1a(`${bossId}|${p.id}`));
    const entries: LootEntry[] = def.loot.map((itemId) => {
      const base = 1 + Math.floor(share * 2);
      const jitter = rng() < 0.35 ? 1 : 0; /* 35% 几率数量翻倍(烘焙派词条同源概率) */
      return { itemId, count: Math.max(1, Math.round((base + jitter) * dropMul)) };
    });
    const angle = rng() * Math.PI * 2;
    const radius = rng() * LOOT_SCATTER_RADIUS;
    orbs.push({
      orbId: `${bossId}:${p.id}`,
      ownerId: p.id,
      x: p.x + Math.cos(angle) * radius,
      y: p.y + Math.sin(angle) * radius,
      entries,
      exp: Math.round(def.exp * share * (1 + partyBonus)),
      personal: true,
    });
  }
  return orbs;
}

/** 某玩家能否拾取该光球(仅所有者可见可拾)。 */
export function canLoot(orb: LootOrb, playerId: string, isAfk: boolean): boolean {
  if (orb.ownerId !== playerId) return false;
  if (isAfk) return false;
  return true;
}

/** 全团光球总数 = 参与人数(用于「8 人各得一球」断言)。 */
export function orbCountFor(participants: readonly RaidParticipant[]): number {
  return participants.filter((p) => p.contributed).length;
}

/** 祭坛召唤物品与手册一致性自检:8 个 Boss → 734..741 一一映射。 */
export function summonItemCoverage(): { ids: number[]; complete: boolean } {
  const ids = BOSS_LIST.map((b) => b.summonItem).sort((a, b) => a - b);
  const expected: number[] = [];
  for (let i = SUMMON_ITEM_MIN; i <= SUMMON_ITEM_MAX; i += 1) expected.push(i);
  const complete = ids.length === expected.length && ids.every((v, i) => v === expected[i]);
  return { ids, complete };
}

/** Boss 定义查询(含阶段与破防原文,供 UI 图鉴)。 */
export function bossDef(bossId: string): BossDef | undefined {
  return BOSS_BY_ID.get(bossId);
}