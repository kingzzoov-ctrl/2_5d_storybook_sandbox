/**
 * WS-02 · 2.5D 伪三维刚体物理世界(20Hz)。
 *
 * 全部积分由冻结层 `shared/types/physics.ts` 承担:
 *   - `integrateHorizontal(vx, vy, mu, ax, ay, fx, fy, beltX, beltY, mass, dt)`
 *   - `integrateVertical(z, vz, dt)`
 *   - `resolveCircleBounce(vx, vy, nx, ny, restitution)`
 *   - `createBody(id, patch)` / `BodyState`
 * 本模块只负责**组织**:地形摩擦查表、外力(加速带/传送带/漩涡)、
 * 地砖机关(蹦床/火炭/落穴)、圆形刚体两两碰撞、与地形的墙壁反弹。
 *
 * 单位:格、格/秒、格/秒²;角度用弧度。
 */

import {
  DT,
  TICK_HZ,
  GRAVITY,
  BodyState,
  createBody,
  integrateHorizontal,
  integrateVertical,
  resolveCircleBounce,
  MASS_PLAYER,
  RADIUS_PLAYER,
  type DynamicBody,
} from '../../../shared/types/physics.ts';
import {
  FLOOR_MU_BY_SLOT,
  FLOOR_BURN_BY_SLOT,
  FLOOR_SLOT_MASK,
  floorIdOfSlot,
  floorSlotOfId,
  muOfSlot,
} from '../world/chunk.ts';

/* ═══════════════════════ 1. 地形接口(结构化匹配 WorldGrid) ═══════════════════════ */

export interface PhysTerrain {
  /** FLOOR 层原始 6 位槽位 */
  floorSlotAt(wx: number, wy: number): number;
  /** OBJ 层 ID,0 = 空 */
  objIdAt(wx: number, wy: number): number;
  /** 海拔 0..3:地面高度 z = elev - 1 */
  elevAt(wx: number, wy: number): number;
  /** 朝向 0=北 1=东 2=南 3=西 */
  faceDirAt(wx: number, wy: number): number;
  poweredAt?(wx: number, wy: number): boolean;
  roofAt?(wx: number, wy: number): number;
}

/** 全平地形的兜底实现(测试夹具)。 */
export const FLAT_TERRAIN: PhysTerrain = {
  floorSlotAt: () => 0,
  objIdAt: () => 0,
  elevAt: () => 1,
  faceDirAt: () => 1,
};

/* ═══════════════════════ 2. 地形摩擦与外力配表 ═══════════════════════ */

/** 地砖 → 加速带推力向量(格/秒)。方向按该格 META 高 2 位的朝向。 */
export const BELT_FORCE: ReadonlyMap<number, number> = new Map<number, number>([
  // 317 单向狂飙加速带:原文「踩上瞬间沿箭头方向施加 10 格/秒推力」
  [317, 10.0],
  // 313 塑胶跑道计速砖:白色跑道线,给 3.5 格/秒的推进
  [313, 3.5],
  // 330 矿车制动加速轨:通电时提供全速推力
  [330, 6.0],
]);

/** 传送带 / 加速带是否只在通电时生效。 */
export const BELT_REQUIRES_POWER: ReadonlySet<number> = new Set<number>([330]);
/** 重复踩踏 / 已通电时的额外推力倍率。 */
export const BELT_POWERED_BONUS = 1.0;

/**
 * 蹦床砖 318:落地时把垂直速度设为该值,峰值直达 Z=2。
 *
 * **为什么不是解析值 √(2·18·2) ≈ 8.4853?**
 * 冻结层的 `integrateVertical` 是**显式欧拉**(位置用旧速度):
 *   z_{k+1} = z_k + vz_k·dt ,  vz_{k+1} = vz_k + g·dt
 * 于是每帧都会多走 `vz·dt` 中的半步,峰值系统性偏高约 `vz0·dt/2`。
 * 用解析值在 20Hz 下实测峰值是 2.2176 格,超出目标 10.9%,肉眼可见。
 * 因此这里**反解离散积分器**,求出让采样峰值恰好落在 2.0 的初速
 * (≈8.20 格/秒)。`BOUNCE_VZ_ANALYTIC` 保留解析值供文档对照。
 */
export const BOUNCE_VZ_ANALYTIC = Math.sqrt(2 * Math.abs(GRAVITY) * 2.0); // ≈ 8.4853

/** 用冻结层积分器测一条纯垂直轨迹的采样峰值。 */
export function apexHeight(vz0: number, dt: number = DT): number {
  let z = 0;
  let vz = vz0;
  let peak = 0;
  for (let i = 0; i < 10000; i += 1) {
    const s = integrateVertical(z, vz, dt);
    z = s.z;
    vz = s.vz;
    if (z > peak) peak = z;
    if (s.grounded && i > 0) break;
  }
  return peak;
}

/** 二分反解:使 20Hz 采样峰值 ≈ targetZ 的垂直初速。 */
export function launchSpeedForApex(targetZ: number, dt: number = DT): number {
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (apexHeight(mid, dt) < targetZ) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 蹦床砖 318 的垂直弹射初速(离散修正后,采样峰值 = Z=2)。 */
export const BOUNCE_VZ = launchSpeedForApex(2.0);

/** 落穴草席 319:踩上去多久后碎裂。 */
export const TRAP_DELAY = 0.4;
/**
 * 落穴计时的浮点容差。0.05 累加 8 次得到 0.39999999999999997,
 * 若直接用 `t >= 0.4` 会晚一帧触发(实测 9 帧而非 8 帧)。
 * 取 1e-9 既能吸收该误差,又不会让 7 帧(0.35)误触发。
 */
export const TRAP_EPS = 1e-9;
/** 落穴造成的下落加速度倍率(掉进坑里摔得更快)。 */
export const TRAP_FALL_MUL = 1.8;

/** 火炭砖每秒灼烧伤害(320)。 */
export const BURN_DPS = 15;
/** 荆棘地垫每秒流血伤害(324)。 */
export const BLEED_DPS = 20;

/** 漩涡砖 323 的吸引半径与加速度。 */
export const VORTEX_RADIUS = 2.0;
export const VORTEX_ACCEL = 2.4;

/** 圆碰撞的默认恢复系数(手册 §2.2「圆形刚体弹性碰撞」)。 */
export const COLLISION_RESTITUTION = 1.0;

/** 单帧最大子步数,防止实体速度爆表时穿透。 */
export const MAX_SUBSTEPS = 4;

/** 超过该速度的实体拆分成子步积分。 */
export const SUBSTEP_SPEED_THRESHOLD = 6.0;

/** 位置兜底钳制:任何坐标超出这个量级都视为数值异常并复位。 */
export const FINITE_LIMIT = 1e6;

export const PhysStats = {
  NORMAL: 'NORMAL',
} as const;

export interface StepReport {
  bodies: number;
  pairs: number;
  substeps: number;
  bounces: number;
  wallHits: number;
  burns: number;
  trapsTriggered: number;
  milliseconds: number;
}

/* ═══════════════════════ 3. 特效事件(渲染层订阅) ═══════════════════════ */

export const FxKind = {
  LANDED: 'LANDED',
  BOUNCED: 'BOUNCED',
  WALL_HIT: 'WALL_HIT',
  BURNED: 'BURNED',
  TRAP_OPENED: 'TRAP_OPENED',
  VORTEX_PULL: 'VORTEX_PULL',
  BOUNCE_PAIR: 'BOUNCE_PAIR',
  OUT_OF_WORLD: 'OUT_OF_WORLD',
} as const;
export type FxKind = (typeof FxKind)[keyof typeof FxKind];

export interface PhysFx {
  kind: FxKind;
  id: string;
  otherId?: string;
  x: number;
  y: number;
  z: number;
  magnitude: number;
}

/* ═══════════════════════ 4. PhysicsWorld ═══════════════════════ */

export interface PhysicsWorldOptions {
  terrain?: PhysTerrain;
  /** 世界矩形边界,实体撞上去反弹 */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** 是否处理两两碰撞 */
  pairwise?: boolean;
  /** 是否处理地砖机关 */
  hazards?: boolean;
}

export class PhysicsWorld {
  readonly bodies: Map<string, DynamicBody>;
  terrain: PhysTerrain;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  pairwise: boolean;
  hazards: boolean;

  /** 累计 tick 数 */
  tickCount = 0;
  /** 累计模拟时间的倒数(秒) */
  elapsed = 0;

  /** 落穴计时:bodyId → 已站在 319 上的秒数 */
  private readonly trapTimers: Map<string, number> = new Map();
  /** 已触发的落穴格集合 */
  private readonly openedTraps: Set<string> = new Set();
  /** 本帧特效队列 */
  readonly fx: PhysFx[] = [];
  /** 上一帧报告 */
  lastReport: StepReport = {
    bodies: 0, pairs: 0, substeps: 1, bounces: 0, wallHits: 0, burns: 0, trapsTriggered: 0, milliseconds: 0,
  };
  /** 统计 */
  totalBounces = 0;
  totalWallHits = 0;
  totalBurns = 0;
  totalTraps = 0;

  constructor(opts: PhysicsWorldOptions = {}) {
    this.bodies = new Map<string, DynamicBody>();
    this.terrain = opts.terrain ?? FLAT_TERRAIN;
    this.bounds = opts.bounds ?? { minX: 0, minY: 0, maxX: 256, maxY: 256 };
    this.pairwise = opts.pairwise ?? true;
    this.hazards = opts.hazards ?? true;
  }

  /* ── 实体管理 ── */

  spawn(id: string, patch: Partial<DynamicBody> = {}): DynamicBody {
    const b = createBody(id, patch);
    this.bodies.set(id, b);
    return b;
  }

  remove(id: string): boolean {
    this.trapTimers.delete(id);
    return this.bodies.delete(id);
  }

  get(id: string): DynamicBody | undefined {
    return this.bodies.get(id);
  }

  get size(): number {
    return this.bodies.size;
  }

  clear(): void {
    this.bodies.clear();
    this.trapTimers.clear();
    this.openedTraps.clear();
    this.fx.length = 0;
    this.tickCount = 0;
    this.elapsed = 0;
  }

  /* ── 地形查询 ── */

  private cellX(b: DynamicBody): number {
    return Math.floor(b.x);
  }

  private cellY(b: DynamicBody): number {
    return Math.floor(b.y);
  }

  /** 该格 μ(FLOOR 层槽位 → 预计算表)。 */
  muAt(x: number, y: number): number {
    return muOfSlot(this.terrain.floorSlotAt(Math.floor(x), Math.floor(y)));
  }

  /** 该格地面高度 z = elev - 1(0=Z-1 深沟,1=Z0,2=Z1,3=Z2)。 */
  groundZAt(x: number, y: number): number {
    const e = this.terrain.elevAt(Math.floor(x), Math.floor(y));
    return (e & 0x3) - 1;
  }

  /** 该格 FLOOR 物品 ID(经 `floorIdOfSlot` 调色板,唯一事实源)。 */
  floorIdAt(x: number, y: number): number {
    return floorIdOfSlot(this.terrain.floorSlotAt(Math.floor(x), Math.floor(y)));
  }

  /** 该格是否阻挡水平移动:OBJ 351~371 视为实心墙。 */
  isSolidCell(cx: number, cy: number): boolean {
    const o = this.terrain.objIdAt(cx, cy);
    if (o === 0) return false;
    return o >= 351 && o <= 371;
  }

  /* ── 主循环 ── */

  /**
   * 20Hz 推进一帧。
   * 顺序:机关外力 → 拆分子步 → 水平积分 → 垂直积分 → 地形碰撞 →
   *       两两碰撞 → 边界钳制 → 有限性兜底。
   */
  step(dt: number = DT): StepReport {
    const t0 = performance.now();
    this.fx.length = 0;
    const report: StepReport = {
      bodies: this.bodies.size, pairs: 0, substeps: 1,
      bounces: 0, wallHits: 0, burns: 0, trapsTriggered: 0, milliseconds: 0,
    };

    if (!(dt > 0) || !Number.isFinite(dt)) {
      report.milliseconds = performance.now() - t0;
      this.lastReport = report;
      return report;
    }

    /* 1. 是否需要拆子步:按最快实体速度决定 */
    let vmax = 0;
    for (const b of this.bodies.values()) {
      const s = Math.hypot(b.vx, b.vy);
      if (s > vmax) vmax = s;
    }
    const substeps = clampInt(
      Math.ceil((vmax * dt) / 0.25),
      1,
      MAX_SUBSTEPS,
    );
    report.substeps = substeps;
    const sdt = dt / substeps;

    for (let s = 0; s < substeps; s += 1) {
      for (const b of this.bodies.values()) {
        this.stepBody(b, sdt, report);
      }
      if (this.pairwise) this.resolvePairs(report);
    }

    /* 2. 边界与有限性兜底 */
    for (const b of this.bodies.values()) {
      this.clampBounds(b);
      this.ensureFinite(b, report);
    }

    this.tickCount += 1;
    this.elapsed += dt;
    report.milliseconds = performance.now() - t0;
    this.lastReport = report;
    this.totalBounces += report.bounces;
    this.totalWallHits += report.wallHits;
    this.totalBurns += report.burns;
    this.totalTraps += report.trapsTriggered;
    return report;
  }

  /** 连续跑 n 帧。 */
  run(frames: number, dt: number = DT): StepReport {
    let last = this.lastReport;
    for (let i = 0; i < frames; i += 1) last = this.step(dt);
    return last;
  }

  /* ── 单刚体一步 ── */

  private stepBody(b: DynamicBody, dt: number, report: StepReport): void {
    /* 被举起的实体由 CarrySystem 全权托管,物理不重复积分 */
    if (b.carriedBy !== null) {
      b.mu = 1.0;
      return;
    }

    /* 状态计时 */
    if (b.stateTimer > 0) {
      b.stateTimer -= dt;
      if (b.stateTimer <= 0) {
        b.stateTimer = 0;
        if (b.state === BodyState.STUNNED || b.state === BodyState.FROZEN) {
          b.state = BodyState.NORMAL;
        }
      }
    }

    const cx = this.cellX(b);
    const cy = this.cellY(b);
    const slot = this.terrain.floorSlotAt(cx, cy) & FLOOR_SLOT_MASK;
    /* 槽位 → 物品 ID 必须走 `floorIdOfSlot`(唯一事实源)。
       曾经这里写的是 `301 + slot - 1`,即假定「槽位 = ID - 300」;
       该式只在槽位 1~30(地砖 301~330)成立,槽位 31~63 是 UGC 像素地毯
       (映射到 314),手工式会算出 331~363 这批**不存在**的地砖 ID。
       后果:UGC 地毯上不触发任何机关,且 belt/hazard 查表全部落空。 */
    const floorId = floorIdOfSlot(slot);

    /* — 摩擦 — */
    /* 眩晕 / 冰冻期间速度直接归零,但仍受重力下落 */
    let mu = FLOOR_MU_BY_SLOT[slot];
    if (b.state === BodyState.STUNNED || b.state === BodyState.FROZEN) {
      b.vx = 0;
      b.vy = 0;
    }
    if (b.state === BodyState.SLIPPING) mu = Math.max(mu, 0.98);
    b.mu = mu;

    /* — 加速带外力 — */
    let beltX = 0;
    let beltY = 0;
    const appliedSlot = slot === 0 ? 0 : floorId;
    const beltPower = BELT_FORCE.get(appliedSlot);
    if (beltPower !== undefined) {
      const powered = this.terrain.poweredAt?.(cx, cy) ?? false;
      const requiresPower = BELT_REQUIRES_POWER.has(appliedSlot);
      const active = requiresPower ? powered : true;
      if (active) {
        const dir = this.terrain.faceDirAt(cx, cy) & 0x3;
        const v = DIR_VEC[dir];
        beltX = v.x * beltPower;
        beltY = v.y * beltPower;
      }
    }

    /* — 漩涡砖 323:向心吸力 — */
    if (this.hazards && appliedSlot === 323) {
      beltX += 0;
      beltY += 0;
      this.applyVortex(b, report);
    }

    /* — 重力(带落穴倍率) — */
    let gMul = 1;
    if (this.hazards && appliedSlot === 319) {
      const key = `${b.id}`;
      const t = (this.trapTimers.get(key) ?? 0) + dt;
      this.trapTimers.set(key, t);
      /* 用 epsilon 比较:0.05 累加 8 次是 0.39999999999999997,
         直接 `t >= 0.4` 会让落穴晚一帧触发(实测为 9 帧而非 8 帧)。 */
      if (t >= TRAP_DELAY - TRAP_EPS && !this.openedTraps.has(`${cx},${cy}`)) {
        this.openedTraps.add(`${cx},${cy}`);
        report.trapsTriggered += 1;
        this.fx.push({ kind: 'TRAP_OPENED', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: 0 });
      }
      gMul = TRAP_FALL_MUL;
    } else {
      this.trapTimers.delete(b.id);
    }

    /* — 水平积分(冻结层) — */
    const nv = integrateHorizontal(b.vx, b.vy, mu, 0, 0, 0, 0, beltX, beltY, b.mass, dt);
    if (Number.isFinite(nv.x) && Number.isFinite(nv.y)) {
      b.vx = nv.x;
      b.vy = nv.y;
    } else {
      b.vx = 0;
      b.vy = 0;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    /* — 垂直积分(冻结层) — */
    const gz = this.groundZAt(b.x, b.y);
    const vzBefore = b.vz;
    /* 落穴时重力倍率抬高:GRAVITY 为负,乘 (gMul-1) 后增加值速度朝向 -z */
    if (gMul !== 1) b.vz += GRAVITY * (gMul - 1) * dt;
    const vs = integrateVertical(b.z, b.vz, dt);
    b.z = vs.z;
    b.vz = vs.vz;

    /* 落地判定:地面高度 gz 可能 < 0(深沟)或 > 0(高台) */
    if (b.z <= gz) {
      b.z = gz;
      const landingSpeed = Math.abs(vzBefore);
      /* 蹦床砖 318:把下落速度换成向上的弹射速度 */
      if (this.hazards && appliedSlot === 318) {
        b.vz = BOUNCE_VZ;
        report.bounces += 1;
        this.fx.push({ kind: 'BOUNCED', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: BOUNCE_VZ });
      } else {
        b.vz = 0;
        if (landingSpeed > 1.0) {
          this.fx.push({ kind: 'LANDED', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: landingSpeed });
        }
      }
    }

    /* — 火炭 / 荆棘伤害 — */
    if (this.hazards) {
      const burn = FLOOR_BURN_BY_SLOT[slot];
      if (burn > 0 && b.z <= gz + 0.05) {
        report.burns += 1;
        this.fx.push({ kind: 'BURNED', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: burn });
      }
      if (appliedSlot === 324 && b.z <= gz + 0.05) {
        this.fx.push({ kind: 'BURNED', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: BLEED_DPS });
      }
    }

    /* — 墙壁碰撞 — */
    this.resolveTerrainWalls(b, report);
  }

  /* ── 墙壁反弹 ── */

  /**
   * 与实心格的边界碰撞:用圆的半径判断是否越过格边,越过后
   * 用 `resolveCircleBounce` 反射速度并把圆心推回格内。
   */
  private resolveTerrainWalls(b: DynamicBody, report: StepReport): void {
    const r = b.radius;
    const cx = Math.floor(b.x);
    const cy = Math.floor(b.y);

    /* 西墙:x 距格左边界 < r 且左侧格实心 */
    if (b.x - cx < r && this.isSolidCell(cx - 1, cy)) {
      const v = resolveCircleBounce(b.vx, b.vy, 1, 0, COLLISION_RESTITUTION);
      b.vx = v.x;
      b.vy = v.y;
      b.x = cx + r;
      report.wallHits += 1;
      this.fx.push({ kind: 'WALL_HIT', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: Math.abs(v.x) });
      b.state = b.state === BodyState.NORMAL ? BodyState.NORMAL : b.state;
    }
    /* 东墙 */
    const cxNow = Math.floor(b.x);
    if (cxNow + 1 - b.x < r && this.isSolidCell(cxNow + 1, cy)) {
      const v = resolveCircleBounce(b.vx, b.vy, -1, 0, COLLISION_RESTITUTION);
      b.vx = v.x;
      b.vy = v.y;
      b.x = cxNow + 1 - r;
      report.wallHits += 1;
      this.fx.push({ kind: 'WALL_HIT', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: Math.abs(v.x) });
    }
    /* 北墙 */
    const cyNow = Math.floor(b.y);
    if (b.y - cyNow < r && this.isSolidCell(cxNow, cyNow - 1)) {
      const v = resolveCircleBounce(b.vx, b.vy, 0, 1, COLLISION_RESTITUTION);
      b.vx = v.x;
      b.vy = v.y;
      b.y = cyNow + r;
      report.wallHits += 1;
      this.fx.push({ kind: 'WALL_HIT', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: Math.abs(v.y) });
    }
    /* 南墙 */
    const cyNow2 = Math.floor(b.y);
    if (cyNow2 + 1 - b.y < r && this.isSolidCell(cxNow, cyNow2 + 1)) {
      const v = resolveCircleBounce(b.vx, b.vy, 0, -1, COLLISION_RESTITUTION);
      b.vx = v.x;
      b.vy = v.y;
      b.y = cyNow2 + 1 - r;
      report.wallHits += 1;
      this.fx.push({ kind: 'WALL_HIT', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: Math.abs(v.y) });
    }
  }

  /* ── 两两碰撞(O(n²),n 小;文档给出网格加速的替换点) ── */

  private resolvePairs(report: StepReport): void {
    const list = [...this.bodies.values()];
    const n = list.length;
    for (let i = 0; i < n; i += 1) {
      const a = list[i];
      for (let j = i + 1; j < n; j += 1) {
        const b = list[j];
        report.pairs += 1;
        /* 被举起的实体不参与碰撞(它们属于同一条链) */
        if (a.carriedBy !== null || b.carriedBy !== null) continue;
        if (a.carrying !== null && a.carrying === b.id) continue;
        if (b.carrying !== null && b.carrying === a.id) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const rr = a.radius + b.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        /* 高度差过大视为不在同一层 */
        if (Math.abs(dz) > Math.max(a.radius, b.radius)) continue;

        const d = Math.sqrt(d2);
        const nx = d > 1e-9 ? dx / d : 1;
        const ny = d > 1e-9 ? dy / d : 0;

        /* 位置分离:按质量反比分配 */
        const ma = a.mass <= 0 ? 1 : a.mass;
        const mb = b.mass <= 0 ? 1 : b.mass;
        const total = ma + mb;
        const overlap = rr - d;
        a.x -= nx * overlap * (mb / total);
        a.y -= ny * overlap * (mb / total);
        b.x += nx * overlap * (ma / total);
        b.y += ny * overlap * (ma / total);

        /* 速度反弹:同向接近才处理 */
        const relN = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relN < 0) {
          const bounce = resolveCircleBounce(a.vx, a.vy, nx, ny, COLLISION_RESTITUTION);
          const shared = (2 * relN) / total;
          a.vx = bounce.x + shared * mb * nx;
          a.vy = bounce.y + shared * mb * ny;
          b.vx = b.vx - shared * ma * nx;
          b.vy = b.vy - shared * ma * ny;
          this.fx.push({
            kind: 'BOUNCE_PAIR', id: a.id, otherId: b.id,
            x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: Math.max(a.z, b.z),
            magnitude: Math.abs(relN),
          });
        }
      }
    }
  }

  /* ── 冲量工具 ── */

  /**
   * 施加冲量 J:Δv = J / m。
   * 大锤击退走这条路径,平安盾在 CarrySystem 层拦截。
   */
  applyImpulse(id: string, jx: number, jy: number, jz: number): { dvx: number; dvy: number; dvz: number } {
    const b = this.bodies.get(id);
    if (b === undefined) return { dvx: 0, dvy: 0, dvz: 0 };
    const m = b.mass <= 0 ? 1 : b.mass;
    const dvx = jx / m;
    const dvy = jy / m;
    const dvz = jz / m;
    b.vx += dvx;
    b.vy += dvy;
    b.vz += dvz;
    return { dvx, dvy, dvz };
  }

  /** 掼摔:把被举起者沿 dir 抛出并附加下压速度。 */
  slam(id: string, dirX: number, dirY: number, power: number): { dvx: number; dvy: number; dvz: number } {
    const b = this.bodies.get(id);
    if (b === undefined) return { dvx: 0, dvy: 0, dvz: 0 };
    const len = Math.hypot(dirX, dirY) || 1;
    const m = b.mass <= 0 ? 1 : b.mass;
    const dvx = (dirX / len) * power / m;
    const dvy = (dirY / len) * power / m;
    const dvz = -power / m;
    b.vx += dvx;
    b.vy += dvy;
    b.vz += dvz;
    return { dvx, dvy, dvz };
  }

  /* ── 漩涡 ── */

  private applyVortex(b: DynamicBody, report: StepReport): void {
    const cx = Math.floor(b.x) + 0.5;
    const cy = Math.floor(b.y) + 0.5;
    const dx = cx - b.x;
    const dy = cy - b.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    const strength = VORTEX_ACCEL * (1 - Math.min(1, d / VORTEX_RADIUS));
    b.vx += (dx / d) * strength * DT;
    b.vy += (dy / d) * strength * DT;
    report.pairs += 0;
    this.fx.push({ kind: 'VORTEX_PULL', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: strength });
  }

  /* ── 边界与有限性 ── */

  private clampBounds(b: DynamicBody): void {
    const { minX, minY, maxX, maxY } = this.bounds;
    if (b.x < minX) { b.x = minX; b.vx = Math.abs(b.vx) * COLLISION_RESTITUTION; }
    if (b.x > maxX) { b.x = maxX; b.vx = -Math.abs(b.vx) * COLLISION_RESTITUTION; }
    if (b.y < minY) { b.y = minY; b.vy = Math.abs(b.vy) * COLLISION_RESTITUTION; }
    if (b.y > maxY) { b.y = maxY; b.vy = -Math.abs(b.vy) * COLLISION_RESTITUTION; }
  }

  /** 数值兜底:任何非有限值都复位到安全状态,并留下一条特效记录便于告警。 */
  private ensureFinite(b: DynamicBody, report: StepReport): void {
    let bad = false;
    if (!Number.isFinite(b.x) || Math.abs(b.x) > FINITE_LIMIT) { b.x = clampNum(b.x, this.bounds.minX, this.bounds.maxX); bad = true; }
    if (!Number.isFinite(b.y) || Math.abs(b.y) > FINITE_LIMIT) { b.y = clampNum(b.y, this.bounds.minY, this.bounds.maxY); bad = true; }
    if (!Number.isFinite(b.z) || Math.abs(b.z) > FINITE_LIMIT) { b.z = 0; bad = true; }
    if (!Number.isFinite(b.vx)) { b.vx = 0; bad = true; }
    if (!Number.isFinite(b.vy)) { b.vy = 0; bad = true; }
    if (!Number.isFinite(b.vz)) { b.vz = 0; bad = true; }
    if (bad) {
      report.bounces += 0;
      this.fx.push({ kind: 'OUT_OF_WORLD', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: 0 });
    }
  }

  /* ── 快照 / 统计 ── */

  /** 所有实体坐标是否有限(10 万帧后的验收断言用)。 */
  allFinite(): boolean {
    for (const b of this.bodies.values()) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)) return false;
      if (!Number.isFinite(b.vx) || !Number.isFinite(b.vy) || !Number.isFinite(b.vz)) return false;
    }
    return true;
  }

  /** 世界状态的紧凑快照(网络层 diff 的输入)。 */
  snapshot(): { id: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; state: BodyState }[] {
    return [...this.bodies.values()].map((b) => ({
      id: b.id, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, state: b.state,
    }));
  }

  /** 每帧耗时的滚动平均(文档性能节引用)。 */
  benchmark(frames: number, warmup = 0): { avgMs: number; maxMs: number; p99Ms: number } {
    for (let i = 0; i < warmup; i += 1) this.step();
    const samples: number[] = [];
    for (let i = 0; i < frames; i += 1) {
      const t0 = performance.now();
      this.step();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))];
    return { avgMs: avg, maxMs: samples[samples.length - 1], p99Ms: p99 };
  }
}

/* ═══════════════════════ 5. 内部工具 ═══════════════════════ */

/** 朝向 → 单位向量:0=北(-y) 1=东(+x) 2=南(+y) 3=西(-x)。 */
const DIR_VEC: readonly { x: number; y: number }[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  const i = Math.floor(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/* ═══════════════════════ 6. 摩擦滑行解析式 ═══════════════════════ */

/**
 * 纯摩擦滑行的解析射程:每帧 v' = v*mu,位移累加 v*dt。
 * s = v0 * dt * (1 - mu^n) / (1 - mu),n → ∞ 时 s∞ = v0*dt/(1-mu)。
 * 冰砖 μ=0.98 → s∞ = 0.05*v0/0.02 = 2.5*v0;v0=4.5 时 ≈ 11.25 格,
 * 因此手册「冰砖上冲锋野猪刹不住车」成立。
 */
export function slideDistance(mu: number, v0: number, dt: number = DT): number {
  if (mu >= 1) return Infinity;
  return (v0 * dt) / (1 - mu);
}

/** 滑行到速度低于 eps 所需帧数。 */
export function slideFrames(mu: number, v0: number, eps = 1e-3): number {
  if (mu <= 0) return 1;
  if (mu >= 1) return Infinity;
  return Math.ceil(Math.log(eps / v0) / Math.log(mu));
}

/** 每帧速度序列(用于「冰砖上 N 帧后速度」的断言)。 */
export function decayTrace(mu: number, v0: number, frames: number): number[] {
  const out: number[] = [];
  let v = v0;
  for (let i = 0; i < frames; i += 1) {
    v *= mu;
    out.push(v);
  }
  return out;
}

/** 用冻结层积分器逐帧推进纯滑行,返回每帧位移与总位移。 */
export function glide(
  mu: number, v0: number, dirX: number, dirY: number, frames: number, dt: number = DT,
): { positions: { x: number; y: number }[]; distance: number; endSpeed: number } {
  const len = Math.hypot(dirX, dirY) || 1;
  let vx = (dirX / len) * v0;
  let vy = (dirY / len) * v0;
  let x = 0;
  let y = 0;
  const positions: { x: number; y: number }[] = [{ x, y }];
  for (let i = 0; i < frames; i += 1) {
    const nv = integrateHorizontal(vx, vy, mu, 0, 0, 0, 0, 0, 0, MASS_PLAYER, dt);
    vx = nv.x;
    vy = nv.y;
    x += vx * dt;
    y += vy * dt;
    positions.push({ x, y });
  }
  return { positions, distance: Math.hypot(x, y), endSpeed: Math.hypot(vx, vy) };
}

/* ═══════════════════════ 7. 默认实体工厂 ═══════════════════════ */

export const DEFAULT_PLAYER_RADIUS = RADIUS_PLAYER;
export const DEFAULT_PLAYER_MASS = MASS_PLAYER;
export const SERVER_TICK_HZ = TICK_HZ;