/**
 * WS-07 · 服务端权威反作弊(零依赖核心)。
 *
 * 原则:客户端的一切输入都视为「**申请**」,不是「事实」。四类校验:
 *   1. 坐标跳变 —— 单帧位移不得超过 `maxSpeed(移速加成上限) × DT × 容差`。
 *   2. 移速上限 —— 单位时间平均移速,窗口式检测(防单帧合法、累计超速)。
 *   3. 攻速上限 —— 攻击间隔不得小于武器基线间隔 × (1 - 攻速加成上限)。
 *   4. 物品栏一致性 —— 物品总量守恒(消耗必须有来源,产出必须落账)。
 *
 * 处置:轻则**静默拒绝**(把请求回退到权威值,不打断同伴游戏),
 * 重则**累计违规分**触发 kick。所有裁决写 `room_events`。
 */

import { BASE_MOVE_SPEED, DT, TICK_HZ } from '../../../shared/types/physics.ts';

/* ═══════════════════════════ 1. 阈值表 ═══════════════════════════ */

/**
 * 移速加成上限。来源:手册 §3.9/§3.10 的可叠加加速项取上界并留余量 ——
 *   249 行进小军鼓 +25% · 601 甜莓果茶 +15% · 719/731 移速 +10% ·
 *   619 冰面 +40% · 622 水中 +30% · 724 滚翻冷却(不改速度) ·
 *   叠罗汉 `carrierSpeedMul` 只减不增 · 230 缩小药水 0.3 倍(减速)。
 * 最坏正向叠加 1.25 × 1.15 × 1.10 × 1.40 = 2.21;再给 1.15 的余量 → 2.55。
 */
export const MAX_SPEED_BONUS_MUL = 2.55;

/** 坐标跳变的每帧容差:网络抖动下的补偿量,再宽会放过瞬移。 */
export const TELEPORT_SLACK = 1.6;

/** 窗口式移速检测:窗口长度与窗口内允许的平均超速比例。 */
export const SPEED_WINDOW_TICKS = 20; // 1 秒
export const SPEED_WINDOW_TOLERANCE = 1.25;

/**
 * 攻速上限。
 *  - 基线:近战轻剑 0.40s/次(711 普攻三连)。
 *  - 允许的最快:0.40 / (1 + 1.00) = 0.20s —— 覆盖 714 双刀 + 249 军鼓 +25%
 *    + 627 炮台 +35%(只对炮台,不叠加到近战)+ 1220 帧近战限流。
 * 取 1.0 作为攻速加成上限。
 */
export const BASE_ATTACK_INTERVAL_S = 0.4;
export const MAX_ATTACK_SPEED_BONUS = 1.0;

/** 单帧最多允许消耗/产出的物品总量(防「一帧刷满背包」)。 */
export const MAX_ITEM_DELTA_PER_TICK = 64;

/** 违规分:达到即踢出。 */
export const VIOLATION_SCORE_KICK = 12;
export const VIOLATION_SCORE_DECAY_PER_TICK = 0.02;

export const ViolationKind = {
  TELEPORT: 'TELEPORT',
  SPEED: 'SPEED',
  ATTACK_RATE: 'ATTACK_RATE',
  INVENTORY: 'INVENTORY',
} as const;
export type ViolationKind = (typeof ViolationKind)[keyof typeof ViolationKind];

export const VIOLATION_WEIGHT: Readonly<Record<ViolationKind, number>> = {
  TELEPORT: 4,
  SPEED: 3,
  ATTACK_RATE: 2,
  INVENTORY: 5,
};

/* ═══════════════════════════ 2. 可注入时钟 ═══════════════════════════ */

export interface Clock {
  nowMs(): number;
}

/**
 * 可注入时钟。
 *
 * 返回的对象**同时**是一个合法 `Clock`(自带 `nowMs`)与一个控制器
 * (`advance` / `set`)。两种调用风格因此都成立:
 * ```ts
 * const clock = fixedClock(0);           clock.advance(60_000); clock.nowMs();
 * const { clock: c, advance } = fixedClock(0);
 * ```
 * 这样测试里不会因为「传外壳还是传内核」而写出两种不兼容的用法。
 */
export type FixedClock = Clock & {
  advance: (ms: number) => number;
  set: (ms: number) => number;
  /** 自指,兼容解构写法。 */
  clock: Clock;
};

export function fixedClock(startMs: number): FixedClock {
  let t = startMs;
  const self: FixedClock = {
    nowMs: () => t,
    advance: (ms: number) => { t += ms; return t; },
    set: (ms: number) => { t = ms; return t; },
    clock: undefined as unknown as Clock,
  };
  self.clock = self;
  return self;
}

/* ═══════════════════════════ 3. 裁决结果 ═══════════════════════════ */

export interface Violation {
  kind: ViolationKind;
  tick: number;
  playerId: string;
  detail: string;
  weight: number;
}

export interface Verdict {
  allowed: boolean;
  /** 拒绝时给客户端的权威值(用于静默回退)。 */
  corrected?: { x: number; y: number; z: number };
  violation?: Violation;
}

export interface AntiCheatLimits {
  maxSpeedBonusMul: number;
  teleportSlack: number;
  speedWindowTicks: number;
  speedWindowTolerance: number;
  baseAttackIntervalS: number;
  maxAttackSpeedBonus: number;
  maxItemDeltaPerTick: number;
}

export const DEFAULT_LIMITS: AntiCheatLimits = {
  maxSpeedBonusMul: MAX_SPEED_BONUS_MUL,
  teleportSlack: TELEPORT_SLACK,
  speedWindowTicks: SPEED_WINDOW_TICKS,
  speedWindowTolerance: SPEED_WINDOW_TOLERANCE,
  baseAttackIntervalS: BASE_ATTACK_INTERVAL_S,
  maxAttackSpeedBonus: MAX_ATTACK_SPEED_BONUS,
  maxItemDeltaPerTick: MAX_ITEM_DELTA_PER_TICK,
};

/* ═══════════════════════════ 4. 每玩家校验器 ═══════════════════════════ */

export interface MoveIntent {
  tick: number;
  x: number;
  y: number;
  z: number;
  /** 客户端声明的移速倍率(装备/料理),服务端会与服务端自己的账比对。 */
  speedMul?: number;
}

export interface PlayerAntiCheatState {
  id: string;
  lastX: number;
  lastY: number;
  lastZ: number;
  lastTick: number;
  /** 环形窗口:最近 N 帧的位置与时间,用于窗口式移速检测。 */
  window: { tick: number; x: number; y: number }[];
  /** 上次成功攻击的 tick。 */
  lastAttackTick: number;
  score: number;
  violations: Violation[];
  kicked: boolean;
}

export function createAcState(id: string, tick = 0, x = 0, y = 0, z = 0): PlayerAntiCheatState {
  return {
    id,
    lastX: x, lastY: y, lastZ: z,
    lastTick: tick,
    window: [{ tick, x, y }],
    lastAttackTick: -9999,
    score: 0,
    violations: [],
    kicked: false,
  };
}

function record(s: PlayerAntiCheatState, v: Violation): void {
  s.violations.push(v);
  s.score += v.weight;
  if (s.score >= VIOLATION_SCORE_KICK) s.kicked = true;
}

/** 每帧末的分数衰减,让偶发抖动不会攒成踢出。 */
export function decayScore(s: PlayerAntiCheatState): number {
  s.score = Math.max(0, s.score - VIOLATION_SCORE_DECAY_PER_TICK);
  return s.score;
}

/**
 * 单帧允许的最大位移。
 * 位移上界 = maxSpeed(声明倍率) × DT,再乘 `teleportSlack` 补偿时钟抖动。
 */
export function maxDisplacementPerTick(speedMul = 1, limits: AntiCheatLimits = DEFAULT_LIMITS): number {
  const mul = Math.min(Math.max(0, speedMul), limits.maxSpeedBonusMul);
  return BASE_MOVE_SPEED * mul * DT * limits.teleportSlack;
}

/** 校验一次移动意图。 */
export function checkMove(
  s: PlayerAntiCheatState,
  intent: MoveIntent,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
  maxZ = 3,
): Verdict {
  const dtTicks = Math.max(1, intent.tick - s.lastTick);
  const dist = Math.hypot(intent.x - s.lastX, intent.y - s.lastY);
  const dz = Math.abs(intent.z - s.lastZ);
  const allowed = maxDisplacementPerTick(intent.speedMul ?? 1, limits) * dtTicks;

  /* ── 6.1 坐标跳变 ── */
  if (dist > allowed + 1e-9) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: intent.tick,
      playerId: s.id,
      detail: `单帧位移 ${dist.toFixed(3)} 格 > 上界 ${allowed.toFixed(3)}`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return {
      allowed: false,
      corrected: { x: s.lastX, y: s.lastY, z: s.lastZ },
      violation: v,
    };
  }
  if (intent.z < -1 - 1e-9 || intent.z > maxZ + 1e-9) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: intent.tick,
      playerId: s.id,
      detail: `Z=${intent.z} 越界 [-1, ${maxZ}]`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
  }
  void dz;

  /* ── 6.2 窗口式移速 ── */
  s.window.push({ tick: intent.tick, x: intent.x, y: intent.y });
  const cutoff = intent.tick - limits.speedWindowTicks;
  while (s.window.length > 2 && s.window[0].tick < cutoff) s.window.shift();

  const first = s.window[0];
  const spanTicks = intent.tick - first.tick;
  if (spanTicks >= limits.speedWindowTicks) {
    const path = pathLength(s.window);
    const spanS = spanTicks * DT;
    const observed = path / spanS;
    const cap = BASE_MOVE_SPEED * Math.min(intent.speedMul ?? 1, limits.maxSpeedBonusMul)
      * limits.speedWindowTolerance;
    if (observed > cap + 1e-9) {
      const v: Violation = {
        kind: ViolationKind.SPEED,
        tick: intent.tick,
        playerId: s.id,
        detail: `窗口均速 ${observed.toFixed(2)} 格/秒 > 上限 ${cap.toFixed(2)}`,
        weight: VIOLATION_WEIGHT.SPEED,
      };
      record(s, v);
      return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
    }
  }

  s.lastX = intent.x;
  s.lastY = intent.y;
  s.lastZ = intent.z;
  s.lastTick = intent.tick;
  return { allowed: true };
}

function pathLength(win: readonly { x: number; y: number }[]): number {
  let d = 0;
  for (let i = 1; i < win.length; i += 1) {
    d += Math.hypot(win[i].x - win[i - 1].x, win[i].y - win[i - 1].y);
  }
  return d;
}

/**
 * 校验一次攻击。
 * 最小间隔 = `baseAttackIntervalS / (1 + 攻速加成)`;加成被服务端上限钳制,
 * 所以客户端自称 +500% 攻速也无效。
 */
export function checkAttack(
  s: PlayerAntiCheatState,
  tick: number,
  claimedAttackSpeedBonus = 0,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): Verdict {
  const bonus = Math.min(Math.max(0, claimedAttackSpeedBonus), limits.maxAttackSpeedBonus);
  const minIntervalTicks = (limits.baseAttackIntervalS / (1 + bonus)) * TICK_HZ;
  const since = tick - s.lastAttackTick;
  if (since < minIntervalTicks - 1e-9) {
    const v: Violation = {
      kind: ViolationKind.ATTACK_RATE,
      tick,
      playerId: s.id,
      detail: `攻击间隔 ${since.toFixed(2)} 帧 < 最小 ${minIntervalTicks.toFixed(2)} 帧`,
      weight: VIOLATION_WEIGHT.ATTACK_RATE,
    };
    record(s, v);
    return { allowed: false, violation: v };
  }
  s.lastAttackTick = tick;
  return { allowed: true };
}

/* ═══════════════════════════ 5. 物品栏一致性 ═══════════════════════════ */

export interface InventoryOp {
  itemId: number;
  /** 正数 = 获得,负数 = 消耗。 */
  delta: number;
  /** 来源凭证:合成配方哈希 / 掉落实体 id / 采集点 id。无凭证的产出直接拒。 */
  source?: string;
}

export interface InventoryCheckInput {
  tick: number;
  ops: readonly InventoryOp[];
  /** 服务端认可的「可产出集合」:本次 tick 内合法的掉落/合成产物 id。 */
  allowedSources: ReadonlySet<string>;
  /** 当前背包总量(用于总量守恒)。 */
  beforeTotal: number;
  capacity: number;
}

/**
 * 拒因码。每个码对应一条**可判定的守恒律**,便于把违规流水做成指标。
 */
export const InventoryReject = {
  /** 产出没有服务端认可的来源凭证 —— 凭空产出。 */
  FROM_NOTHING: 'ITEM_FROM_NOTHING',
  /** 单帧净变化超过 `MAX_ITEM_DELTA_PER_TICK`。 */
  BURST: 'ITEM_BURST',
  /** 扣减后总量为负 —— 消耗了不存在的东西。 */
  NEGATIVE: 'ITEM_NEGATIVE',
  /** 超出背包容量。 */
  OVERFLOW: 'ITEM_OVERFLOW',
  /** 增量不是整数(浮点刷物品的典型手法)。 */
  FRACTIONAL: 'ITEM_FRACTIONAL',
} as const;
export type InventoryReject = (typeof InventoryReject)[keyof typeof InventoryReject];

const INVENTORY_REJECT_LABEL: Readonly<Record<string, string>> = {
  ITEM_FROM_NOTHING: '凭空产出',
  ITEM_BURST: '单帧脉冲',
  ITEM_NEGATIVE: '总量为负',
  ITEM_OVERFLOW: '容量溢出',
  ITEM_FRACTIONAL: '非整数增量',
};

export interface InventoryCheckResult {
  allowed: boolean;
  afterTotal: number;
  violation?: Violation;
  rejectCode?: InventoryReject;
}

/**
 * 物品栏一致性:
 *  a) 单帧净变化量绝对值 ≤ MAX_ITEM_DELTA_PER_TICK;
 *  b) 任何**产出**(delta > 0)必须带服务端认可的 source;
 *  c) 消耗后的总量不得为负,且不得超过容量 —— 即「总和守恒」。
 *
 * 检查顺序刻意把**凭证**放在最前:凭空产出是最严重的一类,不应被
 * 后面的量级检查抢先命中而失去归因。
 */
export function checkInventory(
  s: PlayerAntiCheatState,
  input: InventoryCheckInput,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): InventoryCheckResult {
  let net = 0;
  for (const op of input.ops) {
    if (!Number.isInteger(op.delta)) {
      return rejectInv(s, input, InventoryReject.FRACTIONAL,
        `非整数增量 item=${op.itemId} delta=${op.delta}`);
    }
    if (op.delta > 0 && (!op.source || !input.allowedSources.has(op.source))) {
      return rejectInv(s, input, InventoryReject.FROM_NOTHING,
        `物品 ${op.itemId} 凭空产出(source=${op.source ?? '∅'} 未被服务端认可)`);
    }
    net += op.delta;
  }
  if (Math.abs(net) > limits.maxItemDeltaPerTick) {
    return rejectInv(s, input, InventoryReject.BURST,
      `单帧净变化 ${net} 超上限 ${limits.maxItemDeltaPerTick}`);
  }
  const after = input.beforeTotal + net;
  if (after < 0) {
    return rejectInv(s, input, InventoryReject.NEGATIVE,
      `消耗了不存在的东西:${input.beforeTotal}${net >= 0 ? '+' : ''}${net}=${after} < 0`);
  }
  if (after > input.capacity) {
    return rejectInv(s, input, InventoryReject.OVERFLOW,
      `总量 ${after} 超容量 ${input.capacity}`);
  }
  return { allowed: true, afterTotal: after };
}

function rejectInv(
  s: PlayerAntiCheatState,
  input: InventoryCheckInput,
  code: InventoryReject,
  detail: string,
): InventoryCheckResult {
  const v: Violation = {
    kind: ViolationKind.INVENTORY,
    tick: input.tick,
    playerId: s.id,
    detail: `[${code}] ${INVENTORY_REJECT_LABEL[code]} — ${detail}`,
    weight: VIOLATION_WEIGHT.INVENTORY,
  };
  record(s, v);
  return { allowed: false, afterTotal: input.beforeTotal, violation: v, rejectCode: code };
}

/* ═══════════════════════════ 6. 房间级汇总 ═══════════════════════════ */

export class AntiCheatRoom {
  readonly limits: AntiCheatLimits;
  private states = new Map<string, PlayerAntiCheatState>();
  private log: Violation[] = [];

  constructor(limits: AntiCheatLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  join(id: string, tick = 0, x = 0, y = 0, z = 0): PlayerAntiCheatState {
    const s = createAcState(id, tick, x, y, z);
    this.states.set(id, s);
    return s;
  }

  leave(id: string): void {
    this.states.delete(id);
  }

  get(id: string): PlayerAntiCheatState | undefined {
    return this.states.get(id);
  }

  /** 每帧推进:分数衰减 + 淘汰被踢的玩家状态。 */
  tick(t: number): void {
    for (const s of this.states.values()) {
      decayScore(s);
      s.lastTick = Math.max(s.lastTick, t);
    }
  }

  move(intent: MoveIntent & { playerId: string }, maxZ = 3): Verdict {
    const s = this.states.get(intent.playerId);
    if (!s) return { allowed: false };
    const v = checkMove(s, intent, this.limits, maxZ);
    if (v.violation) this.log.push(v.violation);
    this.log = this.log.slice(-512);
    return v;
  }

  attack(playerId: string, tick: number, claimedBonus = 0): Verdict {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false };
    const v = checkAttack(s, tick, claimedBonus, this.limits);
    if (v.violation) this.log.push(v.violation);
    return v;
  }

  inventory(playerId: string, input: InventoryCheckInput): InventoryCheckResult {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false, afterTotal: input.beforeTotal };
    const r = checkInventory(s, input, this.limits);
    if (r.violation) this.log.push(r.violation);
    return r;
  }

  /** 全部违规流水(供写入 room_events)。 */
  violations(): readonly Violation[] {
    return this.log;
  }

  countByKind(kind: ViolationKind): number {
    return this.log.filter((v) => v.kind === kind).length;
  }

  kickedPlayers(): string[] {
    return [...this.states.values()].filter((s) => s.kicked).map((s) => s.id);
  }
}
