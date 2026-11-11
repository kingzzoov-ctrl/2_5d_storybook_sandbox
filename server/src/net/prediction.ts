/**
 * WS-07 · 移动预测、服务端权威校正与插值(零依赖核心)。
 *
 * 三个互相独立的问题,分别有自己的函数,便于单测:
 *   1. **客户端预测**(`predictStep`):本地先跑一遍积分,立即出画面。
 *   2. **权威校正**(`reconcile`):收到服务端快照后决定
 *        - 误差 < `RECONCILE_DEADZONE` → 不纠正,只做零点几格的橡皮筋平滑;
 *        - 误差 < `RECONCILE_HARD_SNAP` → 在 `SMOOTH_WINDOW_S` 内线性吸收;
 *        - 误差 >= 硬阈值 → 立即吸附(配合 `rollback` 重演输入)。
 *   3. **远程实体插值**(`Interpolator`):100ms 延迟 + 5% 丢包下,对收到的
 *       带 tick 的快照做「按服务端时间轴的延迟渲染」,消除抖动放大。
 *
 * 关键量化:位置在线上是 1/1024 格定点(`schema.ts: POS_SCALE`),
 * 所以任何小于 `1/1024 ≈ 0.00098` 格的差值都不是「不平滑」,而是分辨率极限。
 */

import { BASE_MOVE_SPEED, DT, TICK_HZ } from '../../../shared/types/physics.ts';

/* ═══════════════════════════ 1. 参数表 ═══════════════════════════ */

/** 误差死区:低于此值不动客户端位置(避免静止时抖)。约 1/20 格。 */
export const RECONCILE_DEADZONE = 0.05;
/** 硬吸附阈值:超过则放弃平滑直接对齐。 */
export const RECONCILE_HARD_SNAP = 1.5;
/** 平滑吸收窗口(秒):软误差在这么久内线性抹平。 */
export const SMOOTH_WINDOW_S = 0.25;
/** 渲染延迟:客户端把服务端时间轴滞后这么多再采样,用来吸收抖动与丢包。 */
export const INTERP_DELAY_S = 0.1;
/** 快照历史保留窗口,超出即淘汰。 */
export const SNAPSHOT_BUFFER_S = 1.0;
/** 单帧最多外推多久(超过就冻结,防止丢包时飞出地图)。 */
export const MAX_EXTRAPOLATE_S = 0.25;
/** 位移超过此值直接判定为「发生了传送」,清空历史避免插值拉出长线。 */
export const TELEPORT_DISTANCE = 8.0;

/* ═══════════════════════════ 2. 客户端预测 ═══════════════════════════ */

export interface Vec3 { x: number; y: number; z: number }

export interface InputCmd {
  /** 客户端命令序号,单调递增。用于回滚重演时丢弃过期输入。 */
  seq: number;
  /** 归一化前的方向输入,范围 [-1,1]。 */
  moveX: number;
  moveY: number;
  /** 是否尝试跳跃(跳跃在服务端权威处理,这里只做位移外推)。 */
  jump: boolean;
}

export function normalizeInput(moveX: number, moveY: number): { x: number; y: number; len: number } {
  const len = Math.hypot(moveX, moveY);
  if (len <= 1e-9) return { x: 0, y: 0, len: 0 };
  return { x: moveX / len, y: moveY / len, len };
}

export interface PredictParams {
  /** 移动速度倍率(装备/料理/叠罗汉),默认 1。 */
  speedMul?: number;
  /** 服务端下发的摩擦;地面 μ 通常 0.75,冰砖 0.98。 */
  mu?: number;
  /** 状态是否禁止移动(眩晕/冰冻/泡泡)。 */
  frozen?: boolean;
}

export function maxSpeed(mul = 1): number {
  return BASE_MOVE_SPEED * Math.max(0, mul);
}

/**
 * 单步预测:`x' = x + dir * v_max * mul * dt`。
 * 故意**不含**摩擦衰减 —— 客户端预测要与服务端 `integrateHorizontal` 的
 * 速度项一致:连续输入时速度项主导,摩擦只在松手时起作用,
 * 因此松手衰减交给服务的权威态 + 校正吸收,预测侧只负责「按键期间的位移」。
 */
export function predictStep(p: Vec3, cmd: InputCmd, params: PredictParams = {}): Vec3 {
  if (params.frozen) return { x: p.x, y: p.y, z: p.z };
  const dir = normalizeInput(cmd.moveX, cmd.moveY);
  if (dir.len === 0) return { x: p.x, y: p.y, z: p.z };
  const v = maxSpeed(params.speedMul ?? 1);
  const step = v * DT;
  return { x: p.x + dir.x * step, y: p.y + dir.y * step, z: p.z };
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function dist2(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/* ═══════════════════════════ 3. 权威校正 ═══════════════════════════ */

export const ReconcileAction = {
  /** 误差可忽略,不动。 */
  IGNORE: 'IGNORE',
  /** 软误差,`SMOOTH_WINDOW_S` 内平滑吸收。 */
  SMOOTH: 'SMOOTH',
  /** 硬误差,立即吸附。 */
  SNAP: 'SNAP',
} as const;
export type ReconcileAction = (typeof ReconcileAction)[keyof typeof ReconcileAction];

export interface ReconcileResult {
  action: ReconcileAction;
  /** 校正后客户端应当使用的坐标。 */
  pos: Vec3;
  /** 待吸收的偏移量(仅在 SMOOTH 时非零)。 */
  offset: Vec3;
  /** 误差标量(格)。 */
  error: number;
}

/**
 * 软校正:客户端拿预测坐标 `predicted` 与服务端权威 `authoritative` 比较。
 *  - SMOOTH 时把偏差记成一个「视觉偏移」,在若干帧内线性收回,
 *    游戏逻辑位置**立即**改成权威值(避免权威与逻辑分叉)。
 */
export function reconcile(predicted: Vec3, authoritative: Vec3): ReconcileResult {
  const error = dist2(predicted, authoritative);
  if (error < RECONCILE_DEADZONE) {
    return { action: ReconcileAction.IGNORE, pos: predicted, offset: { x: 0, y: 0, z: 0 }, error };
  }
  if (error >= RECONCILE_HARD_SNAP) {
    return { action: ReconcileAction.SNAP, pos: authoritative, offset: { x: 0, y: 0, z: 0 }, error };
  }
  const offset = { x: predicted.x - authoritative.x, y: predicted.y - authoritative.y, z: 0 };
  /* 逻辑位置立刻对齐权威;视觉上先按偏移量画,再收回。 */
  return {
    action: ReconcileAction.SMOOTH,
    pos: authoritative,
    offset,
    error,
  };
}

/**
 * 平滑吸收:每帧把视觉偏移按指数衰减收回,时间常数使得
 * **一个 SMOOTH_WINDOW_S 之后残余量降到 1%**(即视觉上已看不见)。
 *
 * 用指数而非线性:线性衰减在末段会产生肉眼可辨的「最后一跳」,
 * 指数衰减的收敛速度与当前偏移量成正比,整体观感更接近自然减速。
 * 返回本帧的**渲染位置偏移**与剩余偏移。
 */
export function absorbOffset(
  offset: Vec3,
  dt: number = DT,
  windowS: number = SMOOTH_WINDOW_S,
): { visual: Vec3; rest: Vec3 } {
  /* 一个 window 内衰减到 1% → 衰减系数 k = 1 - 100^(-dt/window) */
  const k = 1 - Math.pow(100, -dt / Math.max(1e-6, windowS));
  const rest = { x: offset.x * (1 - k), y: offset.y * (1 - k), z: 0 };
  return { visual: offset, rest };
}

/**
 * 带输入重演的校正:软误差时不用猜测,直接把「服务端已经应用过的输入」之后的
 * 输入序列重跑一遍,得到与权威一致的预测位置 —— 这是无漂移的手感关键。
 */
export function resimulate(
  authoritative: Vec3,
  cmds: readonly InputCmd[],
  params: PredictParams = {},
): Vec3 {
  let p = { ...authoritative };
  for (const c of cmds) p = predictStep(p, c, params);
  return p;
}

/** 丢弃服务端已确认的输入。 */
export function pruneCmds(cmds: InputCmd[], ackedSeq: number): InputCmd[] {
  return cmds.filter((c) => c.seq > ackedSeq);
}

/* ═══════════════════════════ 4. 快照插值缓冲 ═══════════════════════════ */

export interface Snapshot {
  /** 服务端 tick。 */
  tick: number;
  x: number;
  y: number;
  z: number;
}

export interface InterpSample { x: number; y: number; z: number }

/**
 * 远程实体插值器。
 *
 * 语义:按 `serverTime = clientTime - INTERP_DELAY_S` 在快照序列中采样。
 * 采样点落在两帧之间 → 线性插值;落在最新一帧之后 → 线性外推,但最多
 * `MAX_EXTRAPOLATE_S`,再往后冻结(防止丢包时乱飞)。
 *
 * 抖动抑制:插值在**服务端 tick 时间轴**上做,客户端帧率抖动与网络抖动都不影响
 * 输出曲线的连续性。
 */
export class Interpolator {
  private buf: Snapshot[] = [];
  /** 已按 tick 排序。 */
  private lastTick = -1;

  push(s: Snapshot): void {
    if (s.tick <= this.lastTick) return; // 乱序/重复包直接丢
    const last = this.buf[this.buf.length - 1];
    if (last && (Math.abs(s.x - last.x) > TELEPORT_DISTANCE || Math.abs(s.y - last.y) > TELEPORT_DISTANCE)) {
      this.buf = []; // 传送:清历史,避免插值拉出跨图直线
    }
    this.buf.push({ ...s });
    this.lastTick = s.tick;
    const cutoffTick = this.lastTick - Math.round(SNAPSHOT_BUFFER_S * TICK_HZ);
    while (this.buf.length > 2 && this.buf[0].tick < cutoffTick) this.buf.shift();
  }

  get size(): number {
    return this.buf.length;
  }

  get latestTick(): number {
    return this.lastTick;
  }

  /** 按给定「服务端时间」(秒)采样。 */
  sampleAtServerTime(t: number): InterpSample | undefined {
    return this.sampleAtTick(t * TICK_HZ);
  }

  /** 按给定服务端 tick(可为小数)采样。 */
  sampleAtTick(tick: number): InterpSample | undefined {
    const n = this.buf.length;
    if (n === 0) return undefined;
    if (n === 1) return { x: this.buf[0].x, y: this.buf[0].y, z: this.buf[0].z };
    const first = this.buf[0];
    const last = this.buf[n - 1];

    if (tick <= first.tick) return { x: first.x, y: first.y, z: first.z };

    if (tick >= last.tick) {
      /* 外推:最多 MAX_EXTRAPOLATE_S。 */
      const prev = this.buf[n - 2];
      const span = last.tick - prev.tick;
      if (span <= 0) return { x: last.x, y: last.y, z: last.z };
      const maxTicks = MAX_EXTRAPOLATE_S * TICK_HZ;
      const ahead = Math.min(tick - last.tick, maxTicks);
      const vr = { x: (last.x - prev.x) / span, y: (last.y - prev.y) / span, z: (last.z - prev.z) / span };
      return { x: last.x + vr.x * ahead, y: last.y + vr.y * ahead, z: last.z + vr.z * ahead };
    }

    /* 二分找区间(缓冲通常 <40 项,线性也够,这里用二分保证 O(log n))。 */
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].tick <= tick) lo = mid; else hi = mid;
    }
    const a = this.buf[lo];
    const b = this.buf[hi];
    const span = b.tick - a.tick;
    if (span <= 0) return { x: a.x, y: a.y, z: a.z };
    const u = (tick - a.tick) / span;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
  }

  clear(): void {
    this.buf = [];
    this.lastTick = -1;
  }
}

/* ═══════════════════════════ 5. 网络损伤模拟(仅供测试与调参) ═══════════════════════════ */

export interface LossyChannelOptions {
  /** 单向延迟,毫秒。 */
  latencyMs: number;
  /** 丢包率 0..1。 */
  lossRate: number;
  /** 抖动,毫秒(均匀分布 ±jitterMs)。 */
  jitterMs?: number;
  seed?: number;
}

interface InFlight {
  atMs: number;
  tick: number;
  x: number;
  y: number;
  z: number;
}

/**
 * 确定性丢包/延迟信道。用 mulberry32 同款 LCG,保证测试可复现。
 * `advance(dtMs)` 推进时间并返回本步「到达客户端」的快照。
 */
export class LossyChannel {
  private rngState: number;
  private clock = 0;
  private queue: InFlight[] = [];
  readonly latencyMs: number;
  readonly lossRate: number;
  readonly jitterMs: number;
  readonly sent = { total: 0, dropped: 0, delivered: 0 };

  constructor(opts: LossyChannelOptions) {
    this.latencyMs = opts.latencyMs;
    this.lossRate = opts.lossRate;
    this.jitterMs = opts.jitterMs ?? 0;
    this.rngState = (opts.seed ?? 20261010) >>> 0;
  }

  private rand(): number {
    let a = this.rngState;
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    this.rngState = a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  send(tick: number, x: number, y: number, z: number): boolean {
    this.sent.total += 1;
    if (this.rand() < this.lossRate) {
      this.sent.dropped += 1;
      return false;
    }
    const jitter = this.jitterMs > 0 ? (this.rand() * 2 - 1) * this.jitterMs : 0;
    this.queue.push({ atMs: this.clock + this.latencyMs + jitter, tick, x, y, z });
    this.queue.sort((a, b) => a.atMs - b.atMs);
    return true;
  }

  advanceTo(ms: number): InFlight[] {
    this.clock = ms;
    const out: InFlight[] = [];
    while (this.queue.length > 0 && this.queue[0].atMs <= this.clock) {
      const it = this.queue.shift();
      if (it) { out.push(it); this.sent.delivered += 1; }
    }
    return out;
  }
}

/** 把一条「已知真值轨迹」压过损伤信道再插值,返回逐帧采样结果(测试主驱动)。 */
export function simulateInterpolation(
  truthAt: (tick: number) => { x: number; y: number; z: number },
  opts: {
    ticks: number;
    channel: LossyChannelOptions;
    clientDtMs?: number;
    renderDelayS?: number;
  },
): {
  samples: { tick: number; truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[];
  channelStats: { total: number; dropped: number; delivered: number };
} {
  const ch = new LossyChannel(opts.channel);
  const interp = new Interpolator();
  const clientDt = opts.clientDtMs ?? 5; // 200Hz 渲染
  const delay = (opts.renderDelayS ?? INTERP_DELAY_S) * 1000;

  const out: { tick: number; truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[] = [];

  /* 服务端 20Hz 发包。 */
  for (let t = 0; t <= opts.ticks; t += 1) {
    const p = truthAt(t);
    ch.send(t, p.x, p.y, p.z);
    /* 客户端在这 50ms 内按 clientDt 步进渲染。 */
    for (let ms = 0; ms < 1000 / TICK_HZ; ms += clientDt) {
      const now = t * (1000 / TICK_HZ) + ms;
      for (const pkt of ch.advanceTo(now)) interp.push({ tick: pkt.tick, x: pkt.x, y: pkt.y, z: pkt.z });
      const sampleTick = (now - delay) / (1000 / TICK_HZ);
      const s = interp.sampleAtTick(sampleTick);
      const truthTick = (now - delay) / (1000 / TICK_HZ);
      const truth = truthAt(truthTick);
      out.push({
        tick: truthTick,
        truthX: truth.x,
        truthY: truth.y,
        gotX: s ? s.x : truth.x,
        gotY: s ? s.y : truth.y,
        got: s !== undefined,
      });
    }
  }
  return { samples: out, channelStats: { ...ch.sent } };
}

/**
 * 曲线二阶差分的 RMS —— 「这条曲线有多抖」的量化口径。
 *
 * 用它比较**两条输出曲线**(如 5% 丢包 vs 0% 丢包)的抖动,是判断
 * 「丢包是否被放大成可见抖动」的正确做法。
 *
 * 注意**不要**拿它去和服务端真值比较:插值是分段线性的,段内二阶差分恒为 0、
 * 段边界出现脉冲,而真值(例如正弦轨迹)是光滑的 —— 两者二阶差分的量纲根本
 * 不同,比值会被人为放大几十倍,得出「抖动放大 55 倍」这种假结论。
 */
export function secondDiffRms(
  samples: readonly { truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[],
): number {
  const pts: { x: number; y: number }[] = [];
  for (const s of samples) {
    if (!s.got) continue;
    pts.push({ x: s.gotX, y: s.gotY });
  }
  return secondDiffRmsOf(pts);
}

export function secondDiffRmsOf(pts: readonly { x: number; y: number }[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 2; i < pts.length; i += 1) {
    const ax = pts[i].x - 2 * pts[i - 1].x + pts[i - 2].x;
    const ay = pts[i].y - 2 * pts[i - 1].y + pts[i - 2].y;
    sum += ax * ax + ay * ay;
    n += 1;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

/**
 * 抖动放大比:损伤信道输出曲线 vs 无损信道输出曲线 的二阶差分 RMS 之比。
 * ≤ 1.05 表示「5% 丢包没有让画面变得更抖」。
 */
export function jitterAmplification(
  lossySamples: readonly { truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[],
  idealSamples: readonly { truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[],
): number {
  const lossy = secondDiffRms(lossySamples);
  const ideal = secondDiffRms(idealSamples);
  if (ideal < 1e-9) return lossy < 1e-9 ? 1 : Number.POSITIVE_INFINITY;
  return lossy / ideal;
}

/** 最大位置误差(格)。 */
export function maxPositionError(
  samples: readonly { truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[],
): number {
  let m = 0;
  for (const s of samples) {
    if (!s.got) continue;
    m = Math.max(m, Math.hypot(s.gotX - s.truthX, s.gotY - s.truthY));
  }
  return m;
}

/** 误差收敛判定:后半段最大误差 < 前半段(排除启动期排空延迟缓冲的暂态)。 */
export function errorConverged(
  samples: readonly { truthX: number; truthY: number; gotX: number; gotY: number; got: boolean }[],
  tailRatio = 0.5,
): { headMax: number; tailMax: number; converged: boolean } {
  const n = samples.length;
  const cut = Math.floor(n * tailRatio);
  const headMax = maxPositionError(samples.slice(0, cut));
  const tailMax = maxPositionError(samples.slice(cut));
  return { headMax, tailMax, converged: tailMax <= headMax + 1e-9 };
}
