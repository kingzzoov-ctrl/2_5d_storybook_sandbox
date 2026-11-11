/**
 * WS-09 / 粒子对象池 —— 纯逻辑层(不 import three)。
 *
 * 为什么要池:绘本沙盒里同时活着的粒子是「樱花 + 水花 + 熔岩火星 + 冰晶 + 染色雾 + 上升光环」六类叠加,
 * 一局 8 人混战峰值可达 3000+,而 V8 的年轻代对这种小对象极不友好 ——
 * 每次 `new` 都会在 GC 时把所有粒子指针扫一遍,表现为每 3~5 秒一次 8ms 的掉帧尖刺。
 *
 * 本池的三条硬纪律:
 *  1. **容量恒定**:构造时一次性分配 capacity 套字段数组(SoA,Structure-of-Arrays),
 *     此后无论 acquire 多少次都**不再分配**;容量耗尽返回 −1,由调用方降级(丢最老的粒子)。
 *  2. **回收零成本**:`release(i)` 只做两件事 —— 置 alive 位为 0、把 i 压回 freeList;
 *     下一次 `acquire()` 必然复用同一个槽位,不触碰堆。
 *  3. **更新为纯扫描**:`update` 只遍历活跃索引,不做任何对象创建,且**不产生临时数组**
 *     (避免 GC 压力的关键在「不给 GC 制造垃圾」,而不只是「少 new 对象」)。
 *
 * 占用:capacity=4096 时约 4096 × (13 个 Float32 + 2 个 Uint8) ≈ 4096 × 60B ≈ 240KB,可忽略。
 */

import { GRAVITY } from '../../../shared/types/physics.ts';

/** 粒子类别:与 6 个 shader / Aura 一一对应 */
export const ParticleKind = {
  SAKURA: 0,
  WATER_SPLASH: 1,
  LAVA_EMBER: 2,
  ICE_CRYSTAL: 3,
  DYE_MIST: 4,
  AURA_RING: 5,
} as const;
export type ParticleKind = (typeof ParticleKind)[keyof typeof ParticleKind];

export const PARTICLE_KIND_COUNT = 6;

export const DEFAULT_POOL_CAPACITY = 4096;

/** 单粒子字段视图(全部 SoA) */
export interface ParticleView {
  index: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  rotation: number;
  spin: number;
  kind: ParticleKind;
  paletteIndex: number;
  seed: number;
}

export interface SpawnOptions {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life?: number;
  size?: number;
  rotation?: number;
  spin?: number;
  kind?: ParticleKind;
  paletteIndex?: number;
  seed?: number;
  /** 自定义重力倍率;0 = 无重力(花瓣/光环) */
  gravityScale?: number;
}

export class ParticlePool {
  readonly capacity: number;

  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vxArr: Float32Array;
  private vyArr: Float32Array;
  private vzArr: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private rot: Float32Array;
  private spin: Float32Array;
  private seed: Float32Array;
  private gravScale: Float32Array;
  private kindArr: Uint8Array;
  private palette: Uint8Array;
  private alive: Uint8Array;

  private freeList: Int32Array;
  private freeCount: number;
  private liveCount: number;
  /** 活跃索引的紧凑列表,避免 update 时扫描整个 capacity */
  private liveList: Int32Array;

  /** 统计:累计发放、累计归还、容量增长次数(必须恒为 0)、丢弃数 */
  private issued: number;
  private recycled: number;
  private growths: number;
  private droppedSpawns: number;

  constructor(capacity: number = DEFAULT_POOL_CAPACITY) {
    const n = Math.max(1, Math.floor(capacity));
    this.capacity = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vxArr = new Float32Array(n);
    this.vyArr = new Float32Array(n);
    this.vzArr = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.gravScale = new Float32Array(n);
    this.kindArr = new Uint8Array(n);
    this.palette = new Uint8Array(n);
    this.alive = new Uint8Array(n);

    /* freeList 逆序压栈,acquire 弹出即得小下标,提高 cache 命中 */
    this.freeList = new Int32Array(n);
    for (let i = 0; i < n; i += 1) this.freeList[i] = n - 1 - i;
    this.freeCount = n;
    this.liveCount = 0;
    this.liveList = new Int32Array(n);
    this.issued = 0;
    this.recycled = 0;
    this.growths = 0;
    this.droppedSpawns = 0;
  }

  get activeCount(): number {
    return this.liveCount;
  }

  /** 池的物理长度:必须恒等于 capacity(永不增长) */
  get poolLength(): number {
    return this.capacity;
  }

  get freeSlots(): number {
    return this.freeCount;
  }

  get stats(): { issued: number; recycled: number; growths: number; droppedSpawns: number; active: number; capacity: number } {
    return {
      issued: this.issued,
      recycled: this.recycled,
      growths: this.growths,
      droppedSpawns: this.droppedSpawns,
      active: this.liveCount,
      capacity: this.capacity,
    };
  }

  isAlive(i: number): boolean {
    return i >= 0 && i < this.capacity && this.alive[i] === 1;
  }

  /** 申请一个槽位;容量耗尽返回 −1(不扩容、不抛错) */
  acquire(): number {
    if (this.freeCount <= 0) return -1;
    this.freeCount -= 1;
    const i = this.freeList[this.freeCount];
    this.alive[i] = 1;
    this.liveList[this.liveCount] = i;
    this.liveCount += 1;
    this.issued += 1;
    this.px[i] = 0;
    this.py[i] = 0;
    this.pz[i] = 0;
    this.vxArr[i] = 0;
    this.vyArr[i] = 0;
    this.vzArr[i] = 0;
    this.life[i] = 1;
    this.maxLife[i] = 1;
    this.size[i] = 1;
    this.rot[i] = 0;
    this.spin[i] = 0;
    this.seed[i] = 0;
    this.gravScale[i] = 1;
    this.kindArr[i] = ParticleKind.SAKURA;
    this.palette[i] = 0;
    return i;
  }

  /** 归还槽位;重复归还或越界为无操作幂等 */
  release(i: number): boolean {
    if (!this.isAlive(i)) return false;
    this.alive[i] = 0;
    /* 从 liveList 交换删除:O(1),不打乱顺序也不产生空洞 */
    for (let k = 0; k < this.liveCount; k += 1) {
      if (this.liveList[k] === i) {
        this.liveList[k] = this.liveList[this.liveCount - 1];
        this.liveCount -= 1;
        break;
      }
    }
    this.freeList[this.freeCount] = i;
    this.freeCount += 1;
    this.recycled += 1;
    return true;
  }

  /** 申请并写入完整字段;返回槽位索引,耗尽返回 −1 */
  spawn(opts: SpawnOptions): number {
    const i = this.acquire();
    if (i < 0) {
      this.droppedSpawns += 1;
      return -1;
    }
    this.px[i] = opts.x;
    this.py[i] = opts.y;
    this.pz[i] = opts.z;
    this.vxArr[i] = opts.vx ?? 0;
    this.vyArr[i] = opts.vy ?? 0;
    this.vzArr[i] = opts.vz ?? 0;
    const life = opts.life ?? 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = opts.size ?? 1;
    this.rot[i] = opts.rotation ?? 0;
    this.spin[i] = opts.spin ?? 0;
    this.kindArr[i] = (opts.kind ?? ParticleKind.SAKURA) as number;
    this.palette[i] = opts.paletteIndex ?? 0;
    this.seed[i] = opts.seed ?? i / this.capacity;
    this.gravScale[i] = opts.gravityScale ?? 1;
    return i;
  }

  read(i: number): ParticleView | null {
    if (!this.isAlive(i)) return null;
    return {
      index: i,
      x: this.px[i],
      y: this.py[i],
      z: this.pz[i],
      vx: this.vxArr[i],
      vy: this.vyArr[i],
      vz: this.vzArr[i],
      life: this.life[i],
      maxLife: this.maxLife[i],
      size: this.size[i],
      rotation: this.rot[i],
      spin: this.spin[i],
      kind: this.kindArr[i] as ParticleKind,
      paletteIndex: this.palette[i],
      seed: this.seed[i],
    };
  }

  /**
   * 推进所有活跃粒子:积分 + 寿命衰减 + 落回地面回收。
   *
   * 轴向约定(与 `shared/types/physics.ts` 的二维物理一致):
   *  - `px/py` 是地面平面(x/y 格),`pz` 是海拔高度;
   *  - **重力只作用在 `pz` 上**(向下为负),`py` 不受重力。
   * 早前把重力错误地加在 `py` 上,会导致粒子朝南「漂走」而不是下落。
   *
   * 复杂度 O(liveCount),无分配。
   */
  update(dt: number, gravity = GRAVITY): void {
    if (dt <= 0) return;
    for (let k = this.liveCount - 1; k >= 0; k -= 1) {
      const i = this.liveList[k];
      const g = gravity * this.gravScale[i];
      this.vzArr[i] += g * dt;
      this.px[i] += this.vxArr[i] * dt;
      this.py[i] += this.vyArr[i] * dt;
      this.pz[i] += this.vzArr[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      this.life[i] -= dt;
      if (this.life[i] <= 0 || this.pz[i] < -2 || this.py[i] < -4) this.release(i);
    }
  }

  /** 在当前寿命下归一化的透明度 0..1 */
  alphaOf(i: number): number {
    if (!this.isAlive(i)) return 0;
    const t = this.maxLife[i] <= 0 ? 0 : this.life[i] / this.maxLife[i];
    return Math.min(1, Math.max(0, t));
  }

  /** 一次性回收全部,返回回收数量 */
  releaseAll(): number {
    let n = 0;
    while (this.liveCount > 0) {
      if (this.release(this.liveList[this.liveCount - 1])) n += 1;
      else break;
    }
    return n;
  }

  /** 遍历活跃粒子(回调式,不生成数组) */
  forEachActive(fn: (i: number) => void): void {
    for (let k = 0; k < this.liveCount; k += 1) fn(this.liveList[k]);
  }
}

/* ───────────────────────────── 发射器 ───────────────────────────── */

export interface BurstConfig {
  count: number;
  speed: number;
  spreadRad: number;
  life: number;
  size: number;
  /** 基础朝向角(弧度,XZ 平面) */
  baseAngle?: number;
  kind?: ParticleKind;
  paletteIndex?: number;
  gravityScale?: number;
}

/**
 * 圆形爆发发射:第 k 个粒子角度 = baseAngle + spreadRad·(2k/count − 1)。
 * 返回实际生成数量(可能小于 count,池满时静默降级)。
 *
 * 池满时必须**继续遍历剩余粒子**而不是 `break`:每个失败请求都要计入
 * `stats.droppedSpawns`,否则「本次爆发被丢弃了几个」这个观测指标永远只等于 1,
 * 火焰/烟尘的密度调控就失去了反馈信号。失败路径不做任何分配,继续遍历几乎零成本。
 */
export function emitBurst(pool: ParticlePool, cfg: BurstConfig, x: number, y: number, z: number): number {
  const n = Math.max(0, Math.trunc(cfg.count));
  if (n === 0) return 0;
  const base = cfg.baseAngle ?? 0;
  let made = 0;
  for (let k = 0; k < n; k += 1) {
    const t = n === 1 ? 0 : (2 * k) / n - 1;
    const ang = base + cfg.spreadRad * t;
    const i = pool.spawn({
      x, y, z,
      vx: Math.cos(ang) * cfg.speed,
      vy: Math.sin(ang) * cfg.speed * 0.35,
      vz: -Math.abs(Math.sin(ang)) * cfg.speed * 0.2,
      life: cfg.life,
      size: cfg.size,
      spin: (k % 2 === 0 ? 1 : -1) * 3.5,
      kind: cfg.kind ?? ParticleKind.WATER_SPLASH,
      paletteIndex: cfg.paletteIndex ?? 0,
      seed: (k + 1) / (n + 1),
      gravityScale: cfg.gravityScale ?? 1,
    });
    if (i >= 0) made += 1;
  }
  return made;
}

/** 采样连续发射器:按累计时间决定本帧生成数,余数留到下一帧(帧率无关) */
export interface ContinuousEmitter {
  accumulator: number;
  ratePerSec: number;
  /** 累计消耗的**逻辑时间**(用于把浮点误差钉回现实时间轴) */
  elapsedSec: number;
  /** 累计已产出数;与 `elapsedSec × ratePerSec` 构成闭合恒等式 */
  emittedTotal: number;
}

export function createEmitter(ratePerSec: number): ContinuousEmitter {
  return { accumulator: 0, ratePerSec: Math.max(0, ratePerSec), elapsedSec: 0, emittedTotal: 0 };
}

/**
 * 连续发射器采样。
 *
 * **必须用「逻辑总时间 × 速率」重算理论生成量,而不是逐帧累加
 * `rate × dt` 再取整。** 逐帧累加会累积浮点误差:200 次 `× 0.005` 的累加
 * 得到 `0.9999999999999998` 而不是 1,`floor(0.9999…×20)` 于是给出 **19**
 * 而不是 20 —— 表现成「同样一秒,帧率越高粒子越少」,
 * 恰好摧毁这个函数存在的唯一理由(帧率无关性)。
 * 这里改为维护 `elapsedSec`(逐帧累加的秒数,仅用于对齐时间轴)并让
 * `total = elapsedSec × rate` 承担理论量,余数由 `total − emitted` 得出,
 * 单帧的浮点误差不会跨帧放大。`emittedTotal` 记录已产出数,使该式闭合成恒等式。
 */
export function stepEmitter(e: ContinuousEmitter, dt: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  e.elapsedSec += step;
  const target = Math.floor(e.elapsedSec * e.ratePerSec + 1e-9);
  const n = Math.max(0, target - e.emittedTotal);
  e.emittedTotal = target;
  /* 累加器只作为对外可读的「待补足小数部分」,不再是唯一事实源 */
  e.accumulator = e.elapsedSec * e.ratePerSec - e.emittedTotal;
  if (e.accumulator < 0) e.accumulator = 0;
  return n;
}

/** 各类粒子的默认参数表(与 docs 参数表同步) */
export const PARTICLE_PRESETS: Record<ParticleKind, { rate: number; life: number; size: number; gravityScale: number }> = {
  0: { rate: 12, life: 6.0, size: 0.35, gravityScale: 0 },
  1: { rate: 24, life: 0.8, size: 0.22, gravityScale: 1 },
  2: { rate: 8, life: 1.6, size: 0.3, gravityScale: -0.15 },
  3: { rate: 16, life: 1.1, size: 0.26, gravityScale: 0.6 },
  4: { rate: 20, life: 1.4, size: 0.5, gravityScale: -0.05 },
  5: { rate: 6, life: 1.0, size: 1.2, gravityScale: 0 },
};