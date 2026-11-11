/**
 * WS-02 · 举投系统:举起链、抛物线投掷、完美接球、4 层叠罗汉、平安盾(218)。
 *
 * 全部几何与速度都由冻结层 `shared/types/physics.ts` 的
 * `throwVelocity` / `integrateVertical` / `stackOffset` / `carrierSpeedMul` /
 * `canPerfectCatch` 承担,本模块只负责**组织与规则**(谁能举谁、链多长、
 * 盾是否免疫、接球窗口怎么判定),不重新定义任何常数。
 */

import {
  DT,
  GRAVITY,
  THROW_SPEED_XY,
  THROW_SPEED_Z,
  CARRY_Z_STEP,
  CARRY_MAX_DEPTH,
  CARRY_SLOWDOWN,
  CATCH_RADIUS,
  CATCH_Z_MIN,
  CATCH_Z_MAX,
  BodyState,
  throwVelocity,
  integrateVertical,
  stackOffset,
  carrierSpeedMul,
  canPerfectCatch,
  type DynamicBody,
} from '../../../shared/types/physics.ts';
/* 弹跳初速必须与物理世界共用同一份离散反解,否则两处会得出不同数值 */
import { launchSpeedForApex } from './world.ts';

/* ═══════════════════════ 1. 配表与常量 ═══════════════════════ */

/** 平安盾物品 ID:原文「开启后 100% 免疫队友举起、大锤击退与香蕉皮」。 */
export const SHIELD_ITEM_ID = 218;

/** 举起判定的水平距离上界:必须真正贴住才能举(格)。 */
export const LIFT_RANGE = 0.75;

/** 举起时目标必须接近地面,z 不能已经在半空。 */
export const LIFT_Z_MAX = 0.45;

/** 投掷出去后,原携带者的冷却时间(秒),防止瞬间反复抢人。 */
export const THROW_COOLDOWN = 0.35;

/** 接球判定的连击窗口:接住后 0.25s 内再次投掷视为空中传球,不触发冷却。 */
export const PASS_WINDOW = 0.25;

/** 叠罗汉上层被甩落时的水平散开速度(格/秒)。 */
export const STACK_SHED_SPEED = 2.0;

export const CarryReject = {
  OK: 'OK',
  TOO_FAR: 'TOO_FAR',
  NOT_GROUNDED: 'NOT_GROUNDED',
  SHIELDED: 'SHIELDED',
  DEPTH_EXCEEDED: 'DEPTH_EXCEEDED',
  ALREADY_CARRIED: 'ALREADY_CARRIED',
  SELF: 'SELF',
  HEAVY_BOSS: 'HEAVY_BOSS',
} as const;
export type CarryReject = (typeof CarryReject)[keyof typeof CarryReject];

/** 质量超过该阈值的目标需要 2 人合力(扁担 216)才能举起。 */
export const HEAVY_MASS_THRESHOLD = 10.0;

/* ═══════════════════════ 2. 数据结构 ═══════════════════════ */

export interface CarryActor {
  body: DynamicBody;
  /** 平安盾(物品 218)是否开启 */
  shield: boolean;
}

export interface ChainNode {
  id: string;
  /** 0 = 最底层的承载者(扛人的那个),依此类推 */
  index: number;
  /** 同步后的世界坐标 */
  z: number;
}

export interface ThrowResult {
  /** 出球点 */
  originX: number;
  originY: number;
  originZ: number;
  vx: number;
  vy: number;
  vz: number;
  /** 该投掷物被谁扔出 */
  throwerId: string;
}

export interface CatchCheck {
  caught: boolean;
  z: number;
  dist: number;
  /** 是否落进 [0.3, 1.4] 的完美窗口 */
  inWindow: boolean;
  /** 水平是否够近 */
  nearEnough: boolean;
}

/* ═══════════════════════ 3. 工具 ═══════════════════════ */

/** 距离判定用平方根,显式写出来便于对拍。 */
export function planarDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** 平安盾开启时,一切「整蛊类位移」都无效。 */
export function isKnockbackImmune(actor: CarryActor): boolean {
  return actor.shield === true;
}

/* ═══════════════════════ 4. 举起 ═══════════════════════ */

/**
 * 举起判定。返回 `OK` 或具体拒绝原因。
 * 规则来源:手册 §2.2「举起链」+ 物品 216/218 的 note 原文。
 *
 * 判定顺序(从「与位置无关」到「与位置有关」,便于调试时一次拿到准确原因):
 *   自身 → 免疫 → 已在链上 → 质量 → 距离 → 离地
 */
export function canLift(carrier: CarryActor, target: CarryActor, dist: number): CarryReject {
  if (carrier.body.id === target.body.id) return CarryReject.SELF;
  if (target.body.state === BodyState.FROZEN) return CarryReject.HEAVY_BOSS;
  if (target.body.state === BodyState.GHOST_BUBBLE) return CarryReject.HEAVY_BOSS;
  if (target.body.carriedBy !== null) return CarryReject.ALREADY_CARRIED;
  if (isKnockbackImmune(target)) return CarryReject.SHIELDED;
  /* 太重且没带扁担(216)也举不动 —— 先判质量,再判距离:
     否则「又重又远」的目标会先被报成 TOO_FAR,掩盖真正的失败原因 */
  if (target.body.mass >= HEAVY_MASS_THRESHOLD) return CarryReject.HEAVY_BOSS;
  if (dist > LIFT_RANGE) return CarryReject.TOO_FAR;
  if (target.body.z > LIFT_Z_MAX) return CarryReject.NOT_GROUNDED;
  return CarryReject.OK;
}

/** 当前链条长度(含最底层承载者)。 */
export function chainLength(actor: CarryActor): number {
  let n = 1;
  let cur = actor.body;
  const guard = CARRY_MAX_DEPTH + 4;
  for (let i = 0; i < guard; i += 1) {
    if (cur.carrying === null) break;
    n += 1;
    /* 链条由调用方通过 lookup 继续走,这里靠 carrying 字段自洽即可 */
    break;
  }
  return n;
}

/* ═══════════════════════ 5. CarrySystem ═══════════════════════ */

export interface CarryWorld {
  get(id: string): CarryActor | undefined;
  forEach(fn: (a: CarryActor) => void): void;
  /** 0 = 北 1 = 东 2 = 南 3 = 西,用于向图与坐标同步 */
  faceDirOf?(id: string): number;
}

export class CarrySystem {
  private readonly actors: Map<string, CarryActor>;
  /** 出球冷却:throwerId → 剩余秒数 */
  private readonly cooldown: Map<string, number>;
  /** 统计 */
  lifts = 0;
  throws = 0;
  perfectCatches = 0;
  shieldBlocks = 0;
  sheds = 0;

  constructor(actors: Map<string, CarryActor>) {
    this.actors = actors;
    this.cooldown = new Map<string, number>();
  }

  actor(id: string): CarryActor | undefined {
    return this.actors.get(id);
  }

  /** 每帧递减冷却。 */
  tick(dt: number = DT): void {
    for (const [k, v] of this.cooldown) {
      const n = v - dt;
      if (n <= 0) this.cooldown.delete(k);
      else this.cooldown.set(k, n);
    }
  }

  isOnCooldown(id: string): boolean {
    return (this.cooldown.get(id) ?? 0) > 0;
  }

  /* ── 5.1 举起:把 target 挂到 carrier 链尾 ── */

  /**
   * 尝试举起。成功时建立双向链(carrier.carrying / target.carriedBy),
   * 并立即把 target 的 z 同步到 chain 的 0.85 步长位置。
   */
  tryLift(carrierId: string, targetId: string): CarryReject {
    const carrier = this.actors.get(carrierId);
    const target = this.actors.get(targetId);
    if (carrier === undefined || target === undefined) return CarryReject.SELF;
    /* 自己举自己:必须最先判,否则会被后面的「已在链上」抢先命中 */
    if (carrierId === targetId) return CarryReject.SELF;
    if (this.isOnCooldown(carrierId)) return CarryReject.NOT_GROUNDED;

    const root = this.chainRoot(carrierId);
    const chain = this.chainOf(root);
    /* 目标已经在这条链上(链上任意一层)→ 报「已背负」 */
    if (chain.some((a) => a.body.id === targetId)) return CarryReject.ALREADY_CARRIED;

    const depth = chain.length - 1;
    if (depth + 1 >= CARRY_MAX_DEPTH) return CarryReject.DEPTH_EXCEEDED;

    const tail = chain[chain.length - 1];
    const d = planarDistance(
      tail.body.x, tail.body.y,
      target.body.x, target.body.y,
    );
    const verdict = canLift(tail, target, d);
    if (verdict !== CarryReject.OK) {
      if (verdict === CarryReject.SHIELDED) this.shieldBlocks += 1;
      return verdict;
    }

    tail.body.carrying = targetId;
    target.body.carriedBy = carrierId;
    target.body.vx = 0;
    target.body.vy = 0;
    target.body.vz = 0;
    this.lifts += 1;
    this.syncChain(carrierId);
    return CarryReject.OK;
  }

  /* ── 5.2 放下 ── */

  release(carrierId: string): string | null {
    const carrier = this.actors.get(carrierId);
    if (carrier === undefined || carrier.body.carrying === null) return null;
    const childId = carrier.body.carrying;
    const child = this.actors.get(childId);
    carrier.body.carrying = null;
    if (child !== undefined) {
      child.body.carriedBy = null;
      child.body.state = BodyState.NORMAL;
      /* 放下的人被顶到承载者所在格,落回地面 */
      child.body.x = carrier.body.x;
      child.body.y = carrier.body.y;
      child.body.z = 0;
      child.body.vz = 0;
    }
    this.syncChain(carrierId);
    return childId;
  }

  /**
   * 强制拆链(被眩晕 / 被冰冻 / 断线):整条链上的人都掉下来。
   * 上层给一个小的水平散开速度,避免全部叠在同一格。
   */
  breakChain(carrierId: string): string[] {
    const root = this.chainRoot(carrierId);
    const ids = this.chainOf(root).map((a) => a.body.id);
    let dropped: string[] = [];
    for (let i = ids.length - 1; i >= 1; i -= 1) {
      const child = this.actors.get(ids[i]);
      const parent = this.actors.get(ids[i - 1]);
      if (child === undefined || parent === undefined) continue;
      parent.body.carrying = null;
      child.body.carriedBy = null;
      child.body.x = parent.body.x;
      child.body.y = parent.body.y;
      child.body.z = 0;
      child.body.vz = 0;
      const ang = (i * Math.PI * 2) / Math.max(1, ids.length - 1);
      child.body.vx = Math.cos(ang) * STACK_SHED_SPEED;
      child.body.vy = Math.sin(ang) * STACK_SHED_SPEED;
      dropped.push(child.body.id);
    }
    dropped = dropped.reverse();
    this.sheds += dropped.length;
    return dropped;
  }

  /* ── 5.3 坐标同步 ── */

  /**
   * 把整条链的 z 重算成 E_k.z = E_0.z + k * 0.85,
   * 并把上层 x/y 吸附到底层坐标(叠罗汉是「人站在人肩上」)。
   */
  syncChain(carrierId: string): ChainNode[] {
    const root = this.chainRoot(carrierId);
    const chain = this.chainOf(root);
    const nodes: ChainNode[] = [];
    const base = chain[0];
    if (base === undefined) return nodes;
    for (let k = 0; k < chain.length; k += 1) {
      const a = chain[k];
      a.body.z = base.body.z + stackOffset(k);
      if (k > 0) {
        a.body.x = base.body.x;
        a.body.y = base.body.y;
        a.body.vx = base.body.vx;
        a.body.vy = base.body.vy;
      }
      a.body.state = k === 0 ? a.body.state : BodyState.STUNNED;
      nodes.push({ id: a.body.id, index: k, z: a.body.z });
    }
    return nodes;
  }

  /** 最底层承载者的移速乘数 = CARRY_SLOWDOWN^depth。 */
  speedMulOf(carrierId: string): number {
    const root = this.chainRoot(carrierId);
    const depth = this.chainOf(root).length - 1;
    return carrierSpeedMul(depth);
  }

  /** 叠罗汉高度(顶层 z),用于测试断言 4 层 = 2.55。 */
  topZ(carrierId: string): number {
    const root = this.chainRoot(carrierId);
    const chain = this.chainOf(root);
    if (chain.length === 0) return 0;
    return chain[0].body.z + stackOffset(chain.length - 1);
  }

  chainOf(carrierId: string): CarryActor[] {
    const out: CarryActor[] = [];
    let cur = this.actors.get(carrierId);
    for (let i = 0; i <= CARRY_MAX_DEPTH + 1; i += 1) {
      if (cur === undefined) break;
      out.push(cur);
      const nextId = cur.body.carrying;
      if (nextId === null) break;
      cur = this.actors.get(nextId);
    }
    return out;
  }

  /** 沿 carriedBy 反向找到链根(最底层承载者)。 */
  chainRoot(id: string): string {
    let cur = this.actors.get(id);
    for (let i = 0; i <= CARRY_MAX_DEPTH + 1; i += 1) {
      if (cur === undefined || cur.body.carriedBy === null) break;
      cur = this.actors.get(cur.body.carriedBy);
    }
    return cur === undefined ? id : cur.body.id;
  }

  private chainTail(rootId: string): CarryActor {
    const chain = this.chainOf(rootId);
    return chain[chain.length - 1];
  }

  /* ── 5.4 投掷 ── */

  /**
   * 把 chain 的**顶层**扔出去。
   * 初速度完全由冻结层 `throwVelocity` 给出:水平 |dir|*8.5,z 初速 +6.0。
   */
  throwTop(carrierId: string, dirX: number, dirY: number, speedMul = 1): ThrowResult | null {
    const root = this.chainRoot(carrierId);
    const chain = this.chainOf(root);
    if (chain.length < 2) return null;
    const top = chain[chain.length - 1];
    const parent = chain[chain.length - 2];
    const throwerId = parent.body.id;

    parent.body.carrying = null;
    top.body.carriedBy = null;
    top.body.state = BodyState.NORMAL;

    const t = throwVelocity(dirX, dirY, top.body.z, speedMul);
    top.body.x = parent.body.x;
    top.body.y = parent.body.y;
    top.body.z = t.z;
    top.body.vx = t.vx;
    top.body.vy = t.vy;
    top.body.vz = t.vz;

    this.cooldown.set(throwerId, THROW_COOLDOWN);
    this.throws += 1;
    this.syncChain(root);
    return {
      originX: parent.body.x,
      originY: parent.body.y,
      originZ: t.z,
      vx: t.vx, vy: t.vy, vz: t.vz,
      throwerId,
    };
  }

  /** 单飞项目(不是人,而是被扔的物体)的投掷,同样走 throwVelocity。 */
  throwProjectile(
    throwerId: string, x: number, y: number, z: number,
    dirX: number, dirY: number, speedMul = 1,
  ): ThrowResult {
    const t = throwVelocity(dirX, dirY, z, speedMul);
    this.cooldown.set(throwerId, THROW_COOLDOWN);
    this.throws += 1;
    return { originX: x, originY: y, originZ: z, vx: t.vx, vy: t.vy, vz: t.vz, throwerId };
  }

  /* ── 5.5 完美接球 ── */

  /**
   * 接球判定:直接把冻结层的 `canPerfectCatch(z, dist)` 包一层,
   * 额外返回中间量,便于测试与调试面板展示。
   */
  checkCatch(x: number, y: number, z: number, catcherX: number, catcherY: number): CatchCheck {
    const dist = planarDistance(x, y, catcherX, catcherY);
    const inWindow = z >= CATCH_Z_MIN && z <= CATCH_Z_MAX;
    const nearEnough = dist <= CATCH_RADIUS;
    const caught = canPerfectCatch(z, dist);
    return { caught, z, dist, inWindow, nearEnough };
  }

  /** 记录一次成功接球,返回是否为空中传球(接球后立刻能再投)。 */
  registerCatch(catcherId: string): boolean {
    this.perfectCatches += 1;
    const onCd = this.isOnCooldown(catcherId);
    if (onCd) this.cooldown.delete(catcherId);
    return onCd;
  }

  /* ── 5.6 击退 / 掼摔 ── */

  /**
   * 施加冲量 J(单位:格·质量/秒),质量 m → 速度变化 Δv = J/m。
   * 平安盾开启者直接免疫,并把冲量原样返回 0。
   */
  applyImpulse(id: string, jx: number, jy: number, jz: number): { dvx: number; dvy: number; dvz: number; blocked: boolean } {
    const a = this.actors.get(id);
    if (a === undefined) return { dvx: 0, dvy: 0, dvz: 0, blocked: false };
    if (isKnockbackImmune(a)) {
      this.shieldBlocks += 1;
      return { dvx: 0, dvy: 0, dvz: 0, blocked: true };
    }
    const m = a.body.mass === 0 ? 1 : a.body.mass;
    const dvx = jx / m;
    const dvy = jy / m;
    const dvz = jz / m;
    /* 被掼摔的人从链上脱落 */
    if (a.body.carriedBy !== null) this.release(a.body.carriedBy);
    a.body.vx += dvx;
    a.body.vy += dvy;
    a.body.vz += dvz;
    a.body.state = BodyState.STUNNED;
    a.body.stateTimer = 0.4;
    return { dvx, dvy, dvz, blocked: false };
  }

  /* ── 5.7 统计 ── */

  stats(): { lifts: number; throws: number; perfectCatches: number; shieldBlocks: number; sheds: number } {
    return {
      lifts: this.lifts,
      throws: this.throws,
      perfectCatches: this.perfectCatches,
      shieldBlocks: this.shieldBlocks,
      sheds: this.sheds,
    };
  }
}

/* ═══════════════════════ 6. 抛物线积分(纯函数) ═══════════════════════ */

export interface ArcSample {
  t: number;
  x: number;
  y: number;
  z: number;
  vz: number;
  grounded: boolean;
}

/**
 * 用冻结层的 `integrateVertical` 逐 20Hz 推进一条抛物线。
 * 水平方向**不衰减**(空中无摩擦),因此射程 = 水平速度 × 滞空时间。
 * 复现手册 §2.2 的对照:滞空 2*6.0/18.0 = 0.6667s,射程 8.5 × 0.6667 = 5.667 格。
 */
export function simulateArc(
  originX: number, originY: number, z0: number,
  dirX: number, dirY: number,
  speedMul = 1,
  dt: number = DT,
): ArcSample[] {
  const t = throwVelocity(dirX, dirY, z0, speedMul);
  const samples: ArcSample[] = [{ t: 0, x: originX, y: originY, z: z0, vz: t.vz, grounded: false }];
  let x = originX;
  let y = originY;
  let z = z0;
  let vz = t.vz;
  let time = 0;
  const maxSteps = Math.ceil(60 / dt);
  for (let i = 0; i < maxSteps; i += 1) {
    x += t.vx * dt;
    y += t.vy * dt;
    const s = integrateVertical(z, vz, dt);
    z = s.z;
    vz = s.vz;
    time += dt;
    samples.push({ t: time, x, y, z, vz, grounded: s.grounded });
    if (s.grounded && i > 0) break;
  }
  return samples;
}

/** 从抛物线样本里找第一个满足完美接球的时刻(接球者在 (cx, cy))。 */
export function firstCatchWindow(
  samples: readonly ArcSample[], cx: number, cy: number,
): CatchCheck | null {
  for (const s of samples) {
    const dist = planarDistance(s.x, s.y, cx, cy);
    if (canPerfectCatch(s.z, dist)) {
      const inWindow = s.z >= CATCH_Z_MIN && s.z <= CATCH_Z_MAX;
      return { caught: true, z: s.z, dist, inWindow, nearEnough: dist <= CATCH_RADIUS };
    }
  }
  return null;
}

/** 抛物线水平射程(落地前走过的水平距离)。 */
export function arcRange(samples: readonly ArcSample[]): number {
  const last = samples[samples.length - 1];
  const first = samples[0];
  return planarDistance(first.x, first.y, last.x, last.y);
}

/* ═══════════════════════ 7. 物理解析式对照 ═══════════════════════ */

/** 理论滞空时间 2·vz0/|g|。 */
export function theoreticalAirtime(vz0: number = THROW_SPEED_Z): number {
  return (2 * vz0) / Math.abs(GRAVITY);
}

/** 理论水平射程 = 水平速度 × 滞空时间。 */
export function theoreticalRange(speedXY: number = THROW_SPEED_XY, vz0: number = THROW_SPEED_Z): number {
  return speedXY * theoreticalAirtime(vz0);
}

/** 抛物线仰角(弧度):atan(vz0 / vxy)。 */
export function arcElevation(vxy: number = THROW_SPEED_XY, vz0: number = THROW_SPEED_Z): number {
  return Math.atan2(vz0, vxy);
}

/** 弹跳砖 318 需要的垂直初速:使**离散采样**峰值恰好到 Z=2。
    注意不是解析值 √(2·18·2)=8.4853 —— 冻结层的 integrateVertical 是显式欧拉,
    用解析值在 20Hz 下峰值会超调到 2.2176。真正的初速由 world.ts 反解导出。 */
export const BOUNCE_TARGET_Z = 2.0;
export const BOUNCE_VZ = launchSpeedForApex(BOUNCE_TARGET_Z);
/** 解析值,保留供文档与测试对照。 */
export const BOUNCE_VZ_ANALYTIC = Math.sqrt(2 * Math.abs(GRAVITY) * BOUNCE_TARGET_Z);

/** 跳跃初速:离散修正后峰值恰为 1.0 格。 */
export const JUMP_TARGET_Z = 1.0;
export const JUMP_VZ = launchSpeedForApex(JUMP_TARGET_Z);

/** 每层叠罗汉的高度(格),等于冻结层 CARRY_Z_STEP。 */
export const STACK_STEP = CARRY_Z_STEP;
/** 4 层叠罗汉的顶层高度 = 3 × 0.85 = 2.55。 */
export const STACK_4_TOP_Z = stackOffset(CARRY_MAX_DEPTH - 1);