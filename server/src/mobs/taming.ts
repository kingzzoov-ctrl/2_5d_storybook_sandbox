/**
 * WS-04:驯养 / 牧场 / 宠物出战系统。
 *
 * 流程:喂食(达标次数)→ 驯化 → 三指令(跟随 / 留守 / 背物资)→ 牧场产出 → 出战上限。
 *
 * 出战上限:默认 1 只;装备 `628 繁花鹿角园艺冠` 后解锁第 2 只。
 */

import { MOB_BY_ID, MOB_LIST } from '../../../shared/constants/mobs.ts';
import type { MobDef } from '../../../shared/types/entities.ts';
import { MobBehavior } from '../../../shared/types/entities.ts';

/* ─────────────── 参数配表 ─────────────── */

/** 每只生物驯化所需喂食次数(按 `tameItem` 区分难度)。 */
export const TAME_FEED_COUNT: Record<string, number> = {
  mob_sheep: 1,
  mob_squirrel: 1,
  mob_glow_frog: 1,
  mob_capybara: 1,
  mob_chocobo: 3,   /* 陆行鸟:先蜂蜜罐粘脚,再喂 3 个黄金小麦 */
  mob_pangolin: 1,
  mob_sky_manta: 0, /* 直接跳背搭车,无需驯化 */
};

export const DEFAULT_TAME_FEED_COUNT = 1;

/** 出战上限与解锁头饰。 */
export const DEPLOY_LIMIT_BASE = 1;
export const DEPLOY_LIMIT_WITH_BADGE = 2;
export const DEPLOY_BADGE_ID = 628;

/** 牧场自动产出周期(秒):1 游戏日 = 86400s 的简化,这里按 1 天产出一次。 */
export const RANCH_PRODUCE_SEC = 600;
/** 牧场容量(圈养上限)。 */
export const RANCH_CAPACITY = 24;

export const TameCommand = {
  FOLLOW: 'FOLLOW',
  STAY: 'STAY',
  CARRY: 'CARRY',
} as const;
export type TameCommand = (typeof TameCommand)[keyof typeof TameCommand];

export const TAME_COMMANDS: readonly TameCommand[] = ['FOLLOW', 'STAY', 'CARRY'];

export const TameStage = {
  WILD: 'WILD',
  FED: 'FED',
  TAMED: 'TAMED',
} as const;
export type TameStage = (typeof TameStage)[keyof typeof TameStage];

export interface PetRecord {
  mobId: string;
  name: string;
  stage: TameStage;
  fedCount: number;
  requiredFeeds: number;
  command: TameCommand;
  /** 已装备鞍具(743 云朵陆行鸟骑乘鞍)后可骑乘。 */
  saddle: boolean;
  /** 牧场圈养中。 */
  inRanch: boolean;
  /** 背物资负载(格)。 */
  carryLoad: number;
  /** 已出战中。 */
  deployed: boolean;
  lastProduceAt: number;
}

export interface TameResult {
  ok: boolean;
  stage: TameStage;
  reason: string;
  spawned?: { itemId: number; count: number };
}

/** 可驯养生物清单(温顺/坐骑)。 */
export function tameableDefs(): MobDef[] {
  return MOB_LIST.filter((m) => m.tameItem !== undefined);
}

/** 生物是否为可驯养类别。 */
export function canTame(mobId: string): boolean {
  const def = MOB_BY_ID.get(mobId);
  if (!def) return false;
  return def.behavior === MobBehavior.TAMEABLE || def.behavior === MobBehavior.MOUNT
    || def.behavior === MobBehavior.PASSIVE_UNKILLABLE;
}

export function createPetRecord(mobId: string, now = 0): PetRecord | null {
  const def = MOB_BY_ID.get(mobId);
  if (!def || !canTame(mobId)) return null;
  return {
    mobId,
    name: def.name,
    stage: TameStage.WILD,
    fedCount: 0,
    requiredFeeds: TAME_FEED_COUNT[mobId] ?? DEFAULT_TAME_FEED_COUNT,
    command: TameCommand.STAY,
    saddle: false,
    inRanch: false,
    carryLoad: 0,
    deployed: false,
    lastProduceAt: now,
  };
}

/**
 * 喂食一步。
 *
 * 关键边界:
 *  - 物品不匹配 → `ok=false, reason='wrong_item'`,计数不增长;
 *  - 达到所需次数 → `stage='TAMED'` 并回赠该生物的特色产出(`drops` 第一项);
 *  - 已驯化再次喂食 → 仅补充 `lastProduceAt`,不重复发奖。
 */
export function feedPet(pet: PetRecord, itemId: number): TameResult {
  const def = MOB_BY_ID.get(pet.mobId);
  if (!def) return { ok: false, stage: pet.stage, reason: 'unknown_mob' };
  if (pet.stage === TameStage.TAMED) {
    return { ok: false, stage: pet.stage, reason: 'already_tamed' };
  }
  if (def.tameItem === undefined) {
    return { ok: false, stage: pet.stage, reason: 'not_tameable' };
  }
  if (itemId !== def.tameItem) {
    return { ok: false, stage: pet.stage, reason: 'wrong_item' };
  }
  pet.fedCount += 1;
  pet.stage = TameStage.FED;
  if (pet.fedCount >= pet.requiredFeeds) {
    pet.stage = TameStage.TAMED;
    const dropId = Number(Object.keys(def.drops)[0]);
    return {
      ok: true,
      stage: pet.stage,
      reason: 'tamed',
      spawned: { itemId: dropId, count: 1 },
    };
  }
  return { ok: true, stage: pet.stage, reason: 'fed' };
}

/** 下达指令;未驯化生物拒不服从。 */
export function commandPet(pet: PetRecord, cmd: TameCommand): boolean {
  if (pet.stage !== TameStage.TAMED) return false;
  pet.command = cmd;
  return true;
}

/**
 * 出战上限。
 *
 * @param wearing 玩家穿戴的物品 ID 列表
 */
export function deployLimit(wearing: readonly number[]): number {
  return wearing.includes(DEPLOY_BADGE_ID) ? DEPLOY_LIMIT_WITH_BADGE : DEPLOY_LIMIT_BASE;
}

export interface DeployResult { ok: boolean; deployed: number; limit: number; reason: string; }

/** 尝试让某只宠物出战(消耗一个出战名额)。 */
export function deployPet(pets: PetRecord[], pet: PetRecord, wearing: readonly number[]): DeployResult {
  const limit = deployLimit(wearing);
  const deployed = pets.filter((p) => p.deployed).length;
  if (pet.stage !== TameStage.TAMED) {
    return { ok: false, deployed, limit, reason: 'not_tamed' };
  }
  if (pet.inRanch) {
    return { ok: false, deployed, limit, reason: 'in_ranch' };
  }
  if (pet.deployed) {
    return { ok: true, deployed, limit, reason: 'already_deployed' };
  }
  if (deployed >= limit) {
    return { ok: false, deployed, limit, reason: 'limit_reached' };
  }
  pet.deployed = true;
  pet.command = TameCommand.FOLLOW;
  return { ok: true, deployed: deployed + 1, limit, reason: 'deployed' };
}

export function undeployPet(pets: PetRecord[], pet: PetRecord): void {
  pet.deployed = false;
  pet.command = TameCommand.STAY;
}

/** 送入牧场。 */
export function sendToRanch(pets: PetRecord[], pet: PetRecord): boolean {
  if (pet.stage !== TameStage.TAMED) return false;
  const inRanch = pets.filter((p) => p.inRanch).length;
  if (inRanch >= RANCH_CAPACITY) return false;
  pet.inRanch = true;
  pet.deployed = false;
  pet.command = TameCommand.STAY;
  return true;
}

export interface RanchYield { itemId: number; count: number; }

/**
 * 牧场自动产出结算。
 *
 * 产出规则:每 `RANCH_PRODUCE_SEC` 秒,每只圈养生物按自身掉落表产出 1 份;
 * 结界内若存在 >= 3 只同类,额外产出 1 份(「圈养动物自动进食并每日产出」的群体加成)。
 */
export function tickRanch(pets: PetRecord[], now: number): RanchYield[] {
  const out: RanchYield[] = [];
  const counts = new Map<string, number>();
  for (const p of pets) {
    if (!p.inRanch) continue;
    counts.set(p.mobId, (counts.get(p.mobId) ?? 0) + 1);
  }
  for (const pet of pets) {
    if (!pet.inRanch) continue;
    if (now - pet.lastProduceAt < RANCH_PRODUCE_SEC) continue;
    pet.lastProduceAt = now;
    const def = MOB_BY_ID.get(pet.mobId);
    if (!def) continue;
    const dropId = Number(Object.keys(def.drops)[0]);
    const bonus = (counts.get(pet.mobId) ?? 0) >= 3 ? 1 : 0;
    out.push({ itemId: dropId, count: 1 + bonus });
  }
  return out;
}

/**
 * 背物资指令的负载计算。
 *
 * 负载 = 4 + floor(生物等级 / 5),上限 12 格;
 * 负载 > 0 时生物移速乘 `CARRY_SLOWDOWN^1` 之外的额外 0.9 惩罚。
 */
export const CARRY_BASE_SLOTS = 4;
export const CARRY_MAX_SLOTS = 12;
export const CARRY_SPEED_PENALTY = 0.9;

export function carrySlots(mobId: string): number {
  const def = MOB_BY_ID.get(mobId);
  if (!def) return 0;
  return Math.min(CARRY_MAX_SLOTS, CARRY_BASE_SLOTS + Math.floor(def.level / 5));
}

export function carrySpeedMul(pet: PetRecord): number {
  return pet.command === TameCommand.CARRY && pet.carryLoad > 0 ? CARRY_SPEED_PENALTY : 1;
}

/** 三指令的每帧期望行为(纯函数,便于断言)。 */
export function commandIntent(pet: PetRecord, owner: { x: number; y: number }, petPos: { x: number; y: number }): {
  targetX: number; targetY: number; move: boolean;
} {
  switch (pet.command) {
    case 'FOLLOW': {
      const d = Math.hypot(owner.x - petPos.x, owner.y - petPos.y);
      return { targetX: owner.x, targetY: owner.y, move: d > 1.5 };
    }
    case 'STAY':
      return { targetX: petPos.x, targetY: petPos.y, move: false };
    case 'CARRY':
      return { targetX: owner.x, targetY: owner.y, move: true };
    default:
      return { targetX: petPos.x, targetY: petPos.y, move: false };
  }
}

/** 自检:配表覆盖度(24 种里可驯养的条目数)。 */
export function tamingCoverage(): { tameable: number; total: number } {
  return { tameable: tameableDefs().length, total: MOB_LIST.length };
}