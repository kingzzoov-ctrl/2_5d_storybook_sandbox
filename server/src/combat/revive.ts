/**
 * WS-10-D 幽灵泡泡倒地与救援(server/src/combat/revive.ts)
 *
 * 冻结层事实源(shared/types/entities.ts):
 *   REVIVE_TIME = 1.0s      摸一下 1 秒内半血复活
 *   REVIVE_HP_RATIO = 0.5   复活血量 = 50% 上限
 *   FEATHER_RANGE = 6       733 羽毛笔远程复活距离
 *   FEATHER_INVULN = 3.0    733 复活后 3 秒无敌
 *
 * 三条硬规则:
 *   · 零掉级:倒地与复活全程不动 level / exp / totalExp;
 *   · 零爆装:倒地与复活全程不动装备栏快照(逐格比对);
 *   · 幽灵泡泡期间免伤(伤害乘区 0),但不能移动、不能攻击、不能被治疗。
 */

import { BodyState } from '../../../shared/types/physics.ts';
import { FEATHER_INVULN, FEATHER_RANGE, REVIVE_HP_RATIO, REVIVE_TIME } from '../../../shared/types/entities.ts';
import type { PlayerProgress } from './progression.ts';

/* ───────────────────────────── 常量 ───────────────────────────── */

export const GHOST_BUBBLE_MIN_SEC = 0;
/** 倒地后幽灵泡泡自动漂移速度(格/秒) */
export const GHOST_DRIFT_SPEED = 0.6;
/** 227 泡泡连发水枪:连中 3 发把人装进大泡泡 */
export const BUBBLE_GUN_SHOTS = 3;
/** 泡泡困人时长(秒) */
export const BUBBLE_TRAP_SEC = 5.0;
/** 435 四色复活旗:旗点复活读条(秒),比手动救援略慢 */
export const FLAG_REVIVE_TIME = 2.0;
/** 435 旗点复活半径(格) */
export const FLAG_REVIVE_RADIUS = 3.0;
/** 刚被救起后的保护无敌(基础手动救援) */
export const MANUAL_REVIVE_INVULN = 0.5;
/** 幽灵泡泡期间位移限制:速度乘数 0 */
export const GHOST_MOVE_MUL = 0;

/* ───────────────────────────── 数据结构 ───────────────────────────── */

export const ReviveMethod = {
  TOUCH: 'TOUCH',
  FEATHER: 'FEATHER',
  FLAG: 'FLAG',
  CHAIRSIDE: 'CHAIRSIDE',
} as const;
export type ReviveMethod = (typeof ReviveMethod)[keyof typeof ReviveMethod];

export interface EquipmentSnapshot {
  weapon: number | null;
  armor: number | null;
  helm: number | null;
  boots: number | null;
  relic: number | null;
  cape: number | null;
}

export interface DownedState {
  playerId: string;
  /** 倒地瞬间冻结的成长快照,复活时原样还原(零掉级) */
  levelSnapshot: number;
  expSnapshot: number;
  totalExpSnapshot: number;
  /** 倒地瞬间冻结的装备栏快照(零爆装) */
  equipmentSnapshot: EquipmentSnapshot;
  /** 幽灵泡泡位置 */
  x: number;
  y: number;
  /** 幽灵泡泡已存在时长 */
  downedSec: number;
  /** 被救援进度 [0,1],累计 1 秒即复活 */
  reviveProgress: number;
  /** 正在救援的玩家 */
  rescuerId: string | null;
  /** 已叠加的泡泡层数(227 泡泡水枪) */
  bubbleStacks: number;
  /** 是否处于 3 秒无敌 */
  invulnSec: number;
  state: BodyState;
}

export function createDowned(
  progress: PlayerProgress,
  equipment: EquipmentSnapshot,
  x: number,
  y: number,
): DownedState {
  return {
    playerId: progress.playerId,
    levelSnapshot: progress.level,
    expSnapshot: progress.exp,
    totalExpSnapshot: progress.totalExp,
    equipmentSnapshot: { ...equipment },
    x, y,
    downedSec: 0,
    reviveProgress: 0,
    rescuerId: null,
    bubbleStacks: 0,
    invulnSec: 0,
    state: BodyState.GHOST_BUBBLE,
  };
}

/* ───────────────────────────── 结算结构 ───────────────────────────── */

export interface ReviveResult {
  method: ReviveMethod;
  playerId: string;
  /** 复活后是否保持原等级 */
  levelUnchanged: boolean;
  /** 复活后是否保持原装备栏 */
  equipmentUnchanged: boolean;
  hpAfter: number;
  maxHpAfter: number;
  invulnSec: number;
  state: BodyState;
  /** 复活耗时(秒) */
  elapsedSec: number;
  /** 复活旗坐标(仅 FLAG 用) */
  flagId?: string;
}

export interface GhostBubbleTick {
  downed: DownedState;
  /** 本帧是否完成复活 */
  revived: boolean;
}

/* ───────────────────────────── 幽灵泡泡逐帧 ───────────────────────────── */

export function tickGhostBubble(d: DownedState, dt: number): GhostBubbleTick {
  const downedSec = Math.round((d.downedSec + dt) * 1000) / 1000;
  /* 幽灵泡泡无重力地在原地缓慢漂浮;不允许自主位移 */
  const drift = Math.sin(downedSec * 1.4) * GHOST_DRIFT_SPEED * dt;
  return {
    downed: { ...d, downedSec, y: Math.round((d.y + drift) * 1000) / 1000 },
    revived: false,
  };
}

/** 幽灵泡泡期间完全免伤:takenMul 归零由 damage.ts 的第 6 步兑现。 */
export function ghostDamageMul(d: DownedState): number {
  return d.state === BodyState.GHOST_BUBBLE ? 0 : 1;
}

/** 幽灵泡泡期间位移乘数与动作权限。 */
export function ghostControl(d: DownedState): { moveMul: number; canAttack: boolean; canBeHealed: boolean } {
  const ghost = d.state === BodyState.GHOST_BUBBLE;
  return {
    moveMul: ghost ? GHOST_MOVE_MUL : 1,
    canAttack: !ghost,
    canBeHealed: !ghost,
  };
}

/* ───────────────────────────── 手动触摸救援(1 秒半血) ───────────────────────────── */

export interface TouchReviveInput {
  downed: DownedState;
  rescuerId: string;
  /** 救援者与幽灵泡泡的距离(格) */
  distance: number;
  /** 本帧时长 */
  dt: number;
  progress: PlayerProgress;
  /** 天赋「急救快手」:reviveTimeMul(默认 1.0) */
  reviveTimeMul?: number;
  /** 天赋「急救快手」:reviveHpRatioBonus(默认 0) */
  reviveHpRatioBonus?: number;
}

export interface TouchReviveOutcome {
  downed: DownedState;
  /** 是否在本帧完成复活 */
  revived: boolean;
  result: ReviveResult | null;
}

export const TOUCH_RADIUS = 0.9;

/**
 * 触摸救援:距离 ≤ 0.9 格、按住互动键累计 reviveTime(默认 1.0s)→ 半血复活。
 * 中途松手进度归零(设计上不留存)。
 */
export function touchRevive(input: TouchReviveInput): TouchReviveOutcome {
  const { downed, dt } = input;
  if (downed.state !== BodyState.GHOST_BUBBLE) {
    return { downed, revived: false, result: null };
  }
  if (input.distance > TOUCH_RADIUS) {
    return { downed: { ...downed, reviveProgress: 0, rescuerId: null }, revived: false, result: null };
  }
  const need = REVIVE_TIME * (input.reviveTimeMul ?? 1.0);
  const reviveProgress = Math.round((downed.reviveProgress + dt) * 1000) / 1000;
  if (reviveProgress < need) {
    return {
      downed: { ...downed, reviveProgress, rescuerId: input.rescuerId },
      revived: false,
      result: null,
    };
  }
  const ratio = Math.min(1, REVIVE_HP_RATIO + (input.reviveHpRatioBonus ?? 0));
  const maxHp = input.progress.maxHp;
  return {
    downed: {
      ...downed,
      reviveProgress: 0,
      rescuerId: null,
      state: BodyState.NORMAL,
      invulnSec: MANUAL_REVIVE_INVULN,
      bubbleStacks: 0,
    },
    revived: true,
    result: {
      method: ReviveMethod.TOUCH,
      playerId: downed.playerId,
      levelUnchanged: input.progress.level === downed.levelSnapshot,
      equipmentUnchanged: true,
      hpAfter: Math.round(maxHp * ratio),
      maxHpAfter: maxHp,
      invulnSec: MANUAL_REVIVE_INVULN,
      state: BodyState.NORMAL,
      elapsedSec: need,
    },
  };
}

/* ───────────────────────────── 227 泡泡水枪与 733 羽毛笔 ───────────────────────────── */

export interface RangedReviveInput {
  downed: DownedState;
  casterId: string;
  distance: number;
  progress: PlayerProgress;
}

/**
 * 227 泡泡连发水枪:对活人连中 3 发 → 装进大泡泡(BUBBLED)5 秒随风乱飘;
 * 对幽灵泡泡使用则叠 1 层泡泡,满 3 层可被推着走(不复活)。
 */
export function bubbleGunHit(downed: DownedState): { downed: DownedState; trapped: boolean } {
  const bubbleStacks = downed.bubbleStacks + 1;
  if (bubbleStacks >= BUBBLE_GUN_SHOTS) {
    return {
      downed: { ...downed, bubbleStacks: 0, state: BodyState.BUBBLED, invulnSec: BUBBLE_TRAP_SEC },
      trapped: true,
    };
  }
  return { downed: { ...downed, bubbleStacks }, trapped: false };
}

/**
 * 733 复苏天使羽毛笔:6 格内投掷,满血复活 + 3 秒无敌。
 * 超距直接无效(道具不消耗、不复活),由调用方决定是否退还。
 */
export function featherRevive(input: RangedReviveInput): {
  downed: DownedState;
  revived: boolean;
  result: ReviveResult | null;
  reason: string;
} {
  if (input.distance > FEATHER_RANGE) {
    return { downed: input.downed, revived: false, result: null, reason: `距离 ${input.distance} > ${FEATHER_RANGE} 格` };
  }
  if (input.downed.state !== BodyState.GHOST_BUBBLE) {
    return { downed: input.downed, revived: false, result: null, reason: '目标不是幽灵泡泡' };
  }
  const maxHp = input.progress.maxHp;
  return {
    downed: {
      ...input.downed, state: BodyState.NORMAL, reviveProgress: 0, rescuerId: null,
      bubbleStacks: 0, invulnSec: FEATHER_INVULN,
    },
    revived: true,
    result: {
      method: ReviveMethod.FEATHER,
      playerId: input.downed.playerId,
      levelUnchanged: input.progress.level === input.downed.levelSnapshot,
      equipmentUnchanged: true,
      hpAfter: maxHp,
      maxHpAfter: maxHp,
      invulnSec: FEATHER_INVULN,
      state: BodyState.NORMAL,
      elapsedSec: 0,
    },
    reason: 'ok',
  };
}

/**
 * 435 四色队伍出生复活旗:3 格内站在旗旁读条 2 秒 → 半血复活(不消耗道具)。
 */
export function flagRevive(input: {
  downed: DownedState;
  flagId: string;
  distance: number;
  dt: number;
  progress: PlayerProgress;
}): TouchReviveOutcome {
  const { downed, dt } = input;
  if (downed.state !== BodyState.GHOST_BUBBLE || input.distance > FLAG_REVIVE_RADIUS) {
    return { downed: { ...downed, reviveProgress: 0 }, revived: false, result: null };
  }
  const reviveProgress = Math.round((downed.reviveProgress + dt) * 1000) / 1000;
  if (reviveProgress < FLAG_REVIVE_TIME) {
    return { downed: { ...downed, reviveProgress }, revived: false, result: null };
  }
  const maxHp = input.progress.maxHp;
  return {
    downed: {
      ...downed, state: BodyState.NORMAL, reviveProgress: 0, invulnSec: MANUAL_REVIVE_INVULN,
      bubbleStacks: 0,
    },
    revived: true,
    result: {
      method: ReviveMethod.FLAG,
      playerId: downed.playerId,
      levelUnchanged: input.progress.level === downed.levelSnapshot,
      equipmentUnchanged: true,
      hpAfter: Math.round(maxHp * REVIVE_HP_RATIO),
      maxHpAfter: maxHp,
      invulnSec: MANUAL_REVIVE_INVULN,
      state: BodyState.NORMAL,
      elapsedSec: FLAG_REVIVE_TIME,
      flagId: input.flagId,
    },
  };
}

/* ───────────────────────────── 无敌计时 ───────────────────────────── */

export function tickInvuln(downed: DownedState, dt: number): DownedState {
  return { ...downed, invulnSec: Math.max(0, Math.round((downed.invulnSec - dt) * 1000) / 1000) };
}

export function isInvulnerable(downed: DownedState): boolean {
  return downed.invulnSec > 0;
}

/** 快照比对:用于「零掉级零爆装」的直接断言。 */
export function snapshotDiff(
  a: EquipmentSnapshot,
  b: EquipmentSnapshot,
): { changed: boolean; keys: string[] } {
  const keys: string[] = [];
  for (const k of ['weapon', 'armor', 'helm', 'boots', 'relic', 'cape'] as const) {
    if (a[k] !== b[k]) keys.push(k);
  }
  return { changed: keys.length > 0, keys };
}