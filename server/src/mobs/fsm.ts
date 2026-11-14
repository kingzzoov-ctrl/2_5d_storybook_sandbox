/**
 * WS-04:三态 FSM 与零寻路 steering。
 *
 *   IDLE_GRAZE              → 在出生点 4 格内挑无阻挡点慢走 3~5 秒
 *   ALERT_FLEE_OR_CHASE     → 单位向量 + 左偏 45° / 右偏 45° 探针避障(只读 3 次地形数组)
 *   TELEGRAPH_ATTACK        → 0.8~1.5s 预警几何,到期后一次性结算区域伤害
 *
 * 全部逻辑为纯函数 + 少量可变状态,单次 tick 实测 < 0.01ms(见 tests/WS-04.test.ts 计时断言)。
 */

import {
  DT,
  RADIUS_WILD,
  type DynamicBody,
} from '../../../shared/types/physics.ts';
import { MobFsmState } from '../../../shared/types/entities.ts';
import { type Vec2, unit, angleToDeg, insideWarn, type WarnGeom } from './geometry.ts';

export { MobFsmState };

/* ─────────────── 参数配表(设计手册 §4.2 与 §2.1) ─────────────── */

/** 闲逛最短/最长持续秒数。 */
export const GRAZE_SEC_MIN = 3;
export const GRAZE_SEC_MAX = 5;
/** 闲逛活动半径(格,相对出生点)。 */
export const GRAZE_RADIUS = 4;
/** 闲逛移速 = BASE_MOVE_SPEED × 该系数 = 1.8 格/秒。 */
export const GRAZE_SPEED_MUL = 0.4;
/** 追逃移速系数。 */
export const CHASE_SPEED_MUL = 1.0;
/** 避障探针长度(格):前 / 左 45° / 右 45° 各读 1 次。 */
export const PROBE_LEN = 1.0;
/** 避障偏转角(度)。 */
export const AVOID_ANGLE_DEG = 45;
/** 每次 steering 固定的地形读取次数(硬上界,用于「零寻路」证明)。 */
export const PROBE_READS_PER_STEP = 3;
/** 预警时长取值区间(秒)。 */
export const TELEGRAPH_SEC_MIN = 0.8;
export const TELEGRAPH_SEC_MAX = 1.5;
/** 脱战距离:超过该值回 IDLE_GRAZE。 */
export const DISENGAGE_DISTANCE = 24;
/** 攻击后摇:预警结算后强制冷却,避免同帧连发(防「一帧多段伤害」)。 */
export const ATTACK_COOLDOWN_SEC = 1.2;

/** 探针结果:前进 / 左偏 45° / 右偏 45°。 */
export interface SteerResult {
  /** 实际采用的方向单位向量。 */
  dir: Vec2;
  /** 偏转档位:0 = 直行,-1 = 左偏 45°,+1 = 右偏 45°。 */
  turn: -1 | 0 | 1;
  /** 本步的地形数组读取次数(恒为 3)。 */
  reads: number;
  /** 三向探测结果,便于测试断言。 */
  blocked: { forward: boolean; left: boolean; right: boolean };
}

/**
 * 45° 避障:读 3 次地形数组(前、左偏 45°、右偏 45°)。
 *
 * 优先级:直行 > 左偏 > 右偏(左撇优先,保证同一地图下行为确定可复现)。
 * 三向全堵时回退为「反方向」(turn = 0 但 dir 取反),并标记 reads 仍为 3,
 * 使寻路成本在任何地形下都是常数,不触发递归展开。
 */
export function steer45(
  dirX: number,
  dirY: number,
  x: number,
  y: number,
  probe: (px: number, py: number) => boolean,
  probeLen: number = PROBE_LEN,
): SteerResult {
  const u = unit(dirX, dirY);
  const rad = Math.atan2(u.y, u.x);

  const test = (deg: number): boolean => {
    const a = rad + deg * (Math.PI / 180);
    return probe(x + Math.cos(a) * probeLen, y + Math.sin(a) * probeLen);
  };

  /* ── 恰好 3 次数组读取,顺序固定 ── */
  const forward = test(0);
  const left = test(-AVOID_ANGLE_DEG);
  const right = test(+AVOID_ANGLE_DEG);

  if (!forward) return { dir: u, turn: 0, reads: PROBE_READS_PER_STEP, blocked: { forward, left, right } };

  const pick = (deg: number): Vec2 => {
    const a = rad + deg * (Math.PI / 180);
    return { x: Math.cos(a), y: Math.sin(a) };
  };
  if (!left) return { dir: pick(-AVOID_ANGLE_DEG), turn: -1, reads: PROBE_READS_PER_STEP, blocked: { forward, left, right } };
  if (!right) return { dir: pick(+AVOID_ANGLE_DEG), turn: 1, reads: PROBE_READS_PER_STEP, blocked: { forward, left, right } };
  /* 全堵:原路折返,同样只读 3 次。 */
  return { dir: { x: -u.x, y: -u.y }, turn: 0, reads: PROBE_READS_PER_STEP, blocked: { forward, left, right } };
}

/* ─────────────── FSM ─────────────── */

export interface FsmConfig {
  /** 出生点锚。 */
  homeX: number;
  homeY: number;
  /** 基础移速(格/秒)。 */
  speed: number;
  /** 感知半径(格):进入后从 IDLE 转 ALERT。 */
  aggroRadius: number;
  /** 攻击触发距离(格)。 */
  attackRadius: number;
  /** 预警几何生成器。 */
  makeTelegraph: (self: MobFsm, target: Vec2) => WarnGeom;
}

export interface TelegraphState {
  geom: WarnGeom;
  remain: number;
  fired: boolean;
  /** 结算标记:本帧是否新结算(避免重复扣血)。 */
  resolved: boolean;
}

export class MobFsm {
  state: string = MobFsmState.IDLE_GRAZE;
  id: string;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  homeX: number;
  homeY: number;
  speed: number;
  aggroRadius: number;
  attackRadius: number;
  /** 闲逛剩余秒数。 */
  grazeTimer = 0;
  /** 当前闲逛目标点。 */
  grazeTarget: Vec2;
  telegraph: TelegraphState | null = null;
  /** 累计地形数组读取次数,用于断言 steering 成本。 */
  totalProbeReads = 0;
  /** 累计 tick 数。 */
  ticks = 0;
  /** 上一次 steering 结果。 */
  lastSteer: SteerResult | null = null;
  /** 本次 ALERT 的目标点(玩家位置)。 */
  target: Vec2 = { x: 0, y: 0 };
  /** 是否「逃跑」而非「追击」(温顺/受惊生物)。 */
  flee = false;
  /** 攻击后摇剩余秒数:>0 时不得再次进入 TELEGRAPH_ATTACK。 */
  attackCd = 0;
  /** 启用避障:测「无寻路」成本时置 false。 */
  avoid = true;
  private readonly makeTelegraph: (self: MobFsm, target: Vec2) => WarnGeom;
  private readonly rng: () => number;

  constructor(id: string, cfg: FsmConfig, rng: () => number, body?: Partial<DynamicBody>) {
    this.id = id;
    this.homeX = cfg.homeX;
    this.homeY = cfg.homeY;
    this.x = body?.x ?? cfg.homeX;
    this.y = body?.y ?? cfg.homeY;
    this.speed = cfg.speed;
    this.aggroRadius = cfg.aggroRadius;
    this.attackRadius = cfg.attackRadius;
    this.makeTelegraph = cfg.makeTelegraph;
    this.rng = rng;
    this.grazeTarget = { x: cfg.homeX, y: cfg.homeY };
    this.resetGraze();
  }

  get radius(): number {
    return RADIUS_WILD;
  }

  /** 在出生点 GRAZE_RADIUS 内挑一个无阻挡点,并随机 3~5 秒停留。 */
  resetGraze(): void {
    this.grazeTimer = GRAZE_SEC_MIN + this.rng() * (GRAZE_SEC_MAX - GRAZE_SEC_MIN);
    const a = this.rng() * Math.PI * 2;
    const r = this.rng() * GRAZE_RADIUS;
    this.grazeTarget = { x: this.homeX + Math.cos(a) * r, y: this.homeY + Math.sin(a) * r };
  }

  /** 切换状态并清理上一状态残留。 */
  setState(next: string): void {
    if (this.state === next) return;
    this.state = next;
    if (next === MobFsmState.IDLE_GRAZE) {
      this.telegraph = null;
      this.resetGraze();
    }
    if (next !== MobFsmState.TELEGRAPH_ATTACK) this.telegraph = null;
  }

  /** 进入预警攻击态。 */
  beginTelegraph(target: Vec2): void {
    const geom = this.makeTelegraph(this, target);
    const span = Math.max(TELEGRAPH_SEC_MIN, Math.min(TELEGRAPH_SEC_MAX, geom.warnSec || 0.8));
    geom.warnSec = span;
    this.telegraph = { geom, remain: span, fired: false, resolved: false };
    this.state = MobFsmState.TELEGRAPH_ATTACK;
  }

  /**
   * 单帧推进。
   *
   * @param target 目标(玩家)位置;null 表示无目标。
   * @param probe  地形探针:`true` 表示该点被阻挡。
   * @returns 本帧结算的预警几何(未结算则 null)。
   */
  tick(target: Vec2 | null, probe: (px: number, py: number) => boolean, dt: number = DT): WarnGeom | null {
    this.ticks += 1;
    if (this.attackCd > 0) this.attackCd = Math.max(0, this.attackCd - dt);
    switch (this.state) {
      case MobFsmState.IDLE_GRAZE:
        return this.tickGraze(target, probe, dt);
      case MobFsmState.ALERT_FLEE_OR_CHASE:
        return this.tickAlert(target, probe, dt);
      case MobFsmState.TELEGRAPH_ATTACK:
        return this.tickTelegraph(dt);
      default:
        return null;
    }
  }

  private tickGraze(target: Vec2 | null, probe: (px: number, py: number) => boolean, dt: number): WarnGeom | null {
    if (target) {
      const d = Math.hypot(target.x - this.x, target.y - this.y);
      if (d <= this.aggroRadius) {
        this.flee = this.aggroRadius < 4;
        this.setState(MobFsmState.ALERT_FLEE_OR_CHASE);
        return null;
      }
    }
    this.grazeTimer -= dt;
    if (this.grazeTimer <= 0) this.resetGraze();

    /* 闲逛:朝目标点慢走;被阻挡则换向(同样 3 次读)。 */
    const dx = this.grazeTarget.x - this.x;
    const dy = this.grazeTarget.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      this.resetGraze();
      this.vx = 0;
      this.vy = 0;
      return null;
    }
    const steer = steer45(dx, dy, this.x, this.y, probe);
    this.totalProbeReads += steer.reads;
    this.lastSteer = steer;
    const v = this.speed * GRAZE_SPEED_MUL;
    this.vx = steer.dir.x * v;
    this.vy = steer.dir.y * v;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    return null;
  }

  private tickAlert(target: Vec2 | null, probe: (px: number, py: number) => boolean, dt: number): WarnGeom | null {
    if (!target) {
      this.setState(MobFsmState.IDLE_GRAZE);
      return null;
    }
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist > DISENGAGE_DISTANCE) {
      this.setState(MobFsmState.IDLE_GRAZE);
      return null;
    }
    /* 攻击后摇未结束时不起手,保证「预警 - 结算」严格 1:1。 */
    if (dist <= this.attackRadius && this.attackCd <= 0) {
      this.beginTelegraph(target);
      return null;
    }

    /* 逃跑 = 远离;追击 = 靠近。 */
    const sign = this.flee ? -1 : 1;
    const steer = this.avoid
      ? steer45(dx * sign, dy * sign, this.x, this.y, probe)
      : (() => {
        const u = unit(dx * sign, dy * sign);
        return { dir: u, turn: 0 as const, reads: 0, blocked: { forward: false, left: false, right: false } };
      })();
    this.totalProbeReads += steer.reads;
    this.lastSteer = steer;

    const v = this.speed * CHASE_SPEED_MUL;
    this.vx = steer.dir.x * v;
    this.vy = steer.dir.y * v;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.target = { x: target.x, y: target.y };
    return null;
  }

  private tickTelegraph(dt: number): WarnGeom | null {
    const tg = this.telegraph;
    if (!tg) {
      this.setState(MobFsmState.IDLE_GRAZE);
      return null;
    }
    tg.resolved = false;
    tg.remain -= dt;
    if (tg.remain <= 0 && !tg.fired) {
      tg.fired = true;
      tg.resolved = true;
      this.state = MobFsmState.ALERT_FLEE_OR_CHASE;
      this.attackCd = ATTACK_COOLDOWN_SEC;
      return tg.geom;
    }
    return null;
  }
}

/** 受击/被控制时强制转 ALERT(供 behaviors 调用)。 */
export function forceAlert(m: MobFsm, target: Vec2, flee = false): void {
  m.flee = flee;
  m.target = { x: target.x, y: target.y };
  m.setState(MobFsmState.ALERT_FLEE_OR_CHASE);
}

/** 结算:目标是否落在预警几何内。 */
export function resolveTelegraphHit(g: WarnGeom, px: number, py: number, pz = 0, t = 0): boolean {
  return insideWarn(g, px, py, t) && Math.abs(pz - g.z) <= g.zTolerance;
}

/** 供文档/测试使用的方向角(度)。 */
export function headingDeg(m: MobFsm): number {
  return angleToDeg(0, 0, m.vx, m.vy);
}

/**
 * 每帧成本模型。
 *
 * 唤醒生物 30 只、每只 1 次 steering(3 次数组读)+ 位置积分:
 *  - 数组读:3 × 8ns = 24ns
 *  - 三角:`sin/cos` 各 1 次,~20ns
 *  - 积分与写回:~15ns
 *  → 单怪单帧 ≈ 60~80ns;30 只 ≈ 2.1µs;20Hz 下占单帧预算(50ms)的 0.0042%。
 */
export function estimateFsmCostUs(activeMobs: number): number {
  return activeMobs * 0.07;
}