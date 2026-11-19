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

/* ═══════════════════════ 0. 质量守卫 ═══════════════════════ */

/**
 * 质量兜底值 —— 与冻结层 `MASS_PLAYER`(1.0,手册 §2.2 质量梯度 1.0/3.0/20.0)同源。
 * 不新造数:质量为 1 时**一切按质量归一的算式与归一前逐位相同**。
 */
export const DEFAULT_BODY_MASS = MASS_PLAYER;

/**
 * 取一枚**可用**的质量;非法质量**拒绝**并退化为 `DEFAULT_BODY_MASS`。
 *
 * 「非法」的判据是 `Number.isInteger(mass) && mass > 0`,它一次覆盖三类坏值:
 *   - `NaN`  —— 旧写法 `mass <= 0 ? 1 : mass` 对 `NaN` 判 `false` ⇒ `NaN` 顺着
 *     `Δv = J / m` 传播成 `NaN` 速度(实测:质量为 `NaN` 的刚体被击退后位置变 `NaN`,
 *     然后整条 AEI/投影链路一起变 `NaN`);
 *   - `±Infinity` —— 旧写法同样漏(`-Infinity <= 0` 为真所以恰好被兜住,`+Infinity` 没有);
 *   - `0` / 负数 / **小数**(非正整数) —— 手册的质量梯度是离散档 `1.0/3.0/20.0`,
 *     小数质量没有来源,一律按非法处理(拒绝比静默接受更容易发现接线错误)。
 *
 * 非有限/非正整数 ⇒ **拒绝**(兜底),而不是抛错:调用点分布在物理步/冲量/撞击三条路径上,
 * 抛错会把「某个刚体质量忘了填」升级成整帧崩。兜底后位移与速度仍是有限值,可判定。
 */
export function safeMass(mass: number): number {
  return Number.isInteger(mass) && mass > 0 ? mass : DEFAULT_BODY_MASS;
}

/* ═══════════════════════ 0b. 状态写入的唯一口(互斥) ═══════════════════════ */

/**
 * 带计时状态的**优先级**(状态互斥表的唯一事实源)。
 *
 * ## 为什么需要它(第八轮实测 P1)
 *
 * 修前每个写入点各写各的:`carry.ts:451` 的击退**无条件**把 `state` 覆盖成
 * `STUNNED`,而物理层的计时到点只把 `STUNNED / FROZEN` 放回 `NORMAL`
 * (`BUBBLED` 不在那一对里)⇒ 两件事叠加的后果是:
 * ```text
 * BUBBLED(带 5 秒计时)被击退 ⇒ 状态被顶成 STUNNED(泡泡的剩余时间丢了)
 * BUBBLED 的计时到点        ⇒ 不在"放回 NORMAL"那一对里 ⇒ 状态**永远**停在 BUBBLED
 * ```
 * 于是「泡泡困住」与「眩晕」既可能并存、也可能永不解除,两种都错。
 *
 * 口径:数值只表示**谁不许被谁顶掉**(大者胜),不是"多严重"的平衡裁决。
 * `GHOST_BUBBLE`(倒地泡泡)排在最上面 —— 它与 `DownedState` 是同一件事的两面,
 * 被眩晕顶掉等于「倒地的人站起来被打晕」。
 */
export const BODY_STATE_PRIORITY: Readonly<Record<BodyState, number>> = {
  NORMAL: 0,
  SLIPPING: 1,
  STUNNED: 2,
  BUBBLED: 3,
  FROZEN: 4,
  GHOST_BUBBLE: 5,
  AFK_SHIELD: 5,
};

/**
 * **由本层计时器管**的状态:计时到点自动回 `NORMAL`。
 *
 * `GHOST_BUBBLE` / `AFK_SHIELD` **不在**里面 —— 它们的生命周期由 `combat/revive.ts`
 * 的 `DownedState` / AFK 层管,物理层擅自放回 `NORMAL` 会把「倒地中」抹掉。
 */
export const TIMED_BODY_STATES: readonly BodyState[] = [
  BodyState.SLIPPING,
  BodyState.STUNNED,
  BodyState.BUBBLED,
  BodyState.FROZEN,
];

/** 该状态是否由本层的计时器负责归零(见 `TIMED_BODY_STATES`)。 */
export function isTimedBodyState(state: BodyState): boolean {
  return TIMED_BODY_STATES.includes(state);
}

/** 冲量击退造成的眩晕时长(秒)。修前这个 `0.4` 是 `carry.ts` 里的字面量。 */
export const KNOCKBACK_STUN_SEC = 0.4;

/**
 * **带计时状态的唯一写入口**(纯函数:无 world 引用,`carry.ts` 直接可用)。
 *
 * 互斥规则(第八轮 P1 的修法):
 * ```text
 * 1 新状态是 NORMAL            ⇒ 无条件清(计时归零);
 * 2 已有状态优先级 **≥** 新状态 ⇒ **不覆盖**:保留原状态(泡泡不被眩晕顶掉),
 *                                且原状态是"本层计时"时把计时取 max(不缩短);
 * 3 否则                        ⇒ 写入新状态 + 新计时。
 * ```
 *
 * @returns 写入之后**实际生效**的状态(被互斥拦下就是原来的那个)。
 */
export function applyTimedBodyState(b: DynamicBody, state: BodyState, sec: number): BodyState {
  const secLeft = Number.isFinite(sec) && sec > 0 ? sec : 0;
  if (state === BodyState.NORMAL) {
    b.state = BodyState.NORMAL;
    b.stateTimer = 0;
    return BodyState.NORMAL;
  }
  const cur = b.state;
  const curRank = BODY_STATE_PRIORITY[cur];
  const newRank = BODY_STATE_PRIORITY[state];
  if (cur !== BodyState.NORMAL && curRank >= newRank) {
    /* 只推**计时**、不换状态:泡泡的剩余时间不会因为挨了一下就被抹掉。 */
    if (isTimedBodyState(cur)) b.stateTimer = Math.max(b.stateTimer, secLeft);
    return cur;
  }
  b.state = state;
  b.stateTimer = secLeft;
  return state;
}

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

/**
 * μ 乘子的**中性值**:1 表示「这次不改变地板摩擦」。
 *
 * 表里查不到该刚体 ⇒ 就是 1;显式设回 1 ⇒ 从表里删掉,不留一条等价记录 ——
 * 否则「回到中性」与「从没设过」在表里分不开,排查时看不出现场。
 */
export const MU_MUL_NEUTRAL = 1;

/** 单帧最大子步数,防止实体速度爆表时穿透。 */
export const MAX_SUBSTEPS = 4;

/** 超过该速度的实体拆分成子步积分。 */
export const SUBSTEP_SPEED_THRESHOLD = 6.0;

/** 位置兜底钳制:任何坐标超出这个量级都视为数值异常并复位。 */
export const FINITE_LIMIT = 1e6;

/**
 * 扫掠位移的**二分细化次数**:每次折半 ⇒ 精度 = 1/2^n 格。
 * 12 次 ≈ 0.00024 格(远小于任何半径),且只在"终点不合法"时才跑。
 */
export const SWEEP_REFINE_STEPS = 12;

/**
 * 落点校验的**回退搜索半径**(格,切比雪夫环数)。
 *
 * 8 环 = 最多 17×17 格:足够跨过本仓最厚的实心墙(地图边缘 + 1~2 格厚墙),
 * 又不至于让一次失败的落点校验变成全图扫描(20Hz 下每次被挡都要跑一遍)。
 */
export const CLAMP_RING_MAX = 8;

/**
 * **沿位移退回到最后一个合法点**(★ WS-FND-130 P1 的**纯函数**形态)。
 *
 * 把圆心从 `(x, y)` 沿 `(dx, dy)` 推进:
 * - 终点合法 ⇒ **原样返回终点**(`blocked: false`,不做任何中间算术 ——
 *   无遮挡时位移必须与修前**逐位相同**,`WS-FND-98` 用 `1e-9` 精度钉着它);
 * - 终点不合法 ⇒ 在 `[起点, 终点]` 上二分 `steps` 次,返回**最后一个合法比例**
 *   对应的点;起点本身就不合法时二分不前进 ⇒ 原地不动(`moved: 0`)。
 *
 * ## 为什么是纯函数
 *
 * 「哪些格实心 / 圆能不能站」是 `PhysicsWorld` 的事实(`isBlockedAt`),但
 * 「沿位移退到最后一个合法点」是**几何**,与地形无关。把它做成收 `isBlocked`
 * 回调的纯函数有两个好处:`sweepCircle` 与测试/别的调用方共用**同一份**二分
 * (两份实现必然漂);而且可以**注入**一个恒假/恒真的 `isBlocked` 直接验证
 * 「这道判据的牙长在哪」。
 *
 * 非法 `dx/dy`(`NaN` / `±Infinity`)⇒ fail-closed:原地不动 + `blocked: true`。
 */
export function lastFreeAlong(
  x: number, y: number, dx: number, dy: number,
  isBlocked: (x: number, y: number) => boolean,
  steps: number = SWEEP_REFINE_STEPS,
): { x: number; y: number; blocked: boolean; moved: number } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { x, y, blocked: true, moved: 0 };
  }
  const targetX = x + dx;
  const targetY = y + dy;
  const len = Math.hypot(dx, dy);
  if (!isBlocked(targetX, targetY)) {
    return { x: targetX, y: targetY, blocked: false, moved: len };
  }
  let lo = 0;
  let hi = 1;
  const n = Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : SWEEP_REFINE_STEPS;
  for (let i = 0; i < n; i += 1) {
    const mid = (lo + hi) / 2;
    if (isBlocked(x + dx * mid, y + dy * mid)) hi = mid;
    else lo = mid;
  }
  return { x: x + dx * lo, y: y + dy * lo, blocked: true, moved: len * lo };
}

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
  /**
   * 按刚体的 μ **乘子**(裁决 D-12)。缺省 = 没有记录 = 中性 1。
   *
   * **为什么是乘、不是覆盖?** 滑溜料理的 `muOverride = 0.96` 若**覆盖**地板 μ,
   * 冰面 0.98 会被拉低到 0.96(冰上反而更涩)、湿地 0.40 会被拉高到 0.96
   * (泥里反而更滑)—— 同一份料理在不同地面上方向相反,和"滑溜"的语义矛盾。
   * 相乘则方向恒定:冰 0.98×0.96 = 0.9408 更滑、泥 0.40×0.96 = 0.384 更黏。
   *
   * **为什么不改冻结层的 `Body`?** `shared/types/physics.ts` 是冻结层,由 `BodyState`
   * / `integrateHorizontal` 的签名锁死;加字段要改冻结层。因此乘子留在物理层
   * 自己的一张旁表里,按 body id 索引。
   *
   * ⚠️ 结算**只在一处**:`stepBody` 里 `b.mu = 地板μ × mul`。别的地方再乘一次
   * 会变成 mul 的平方(两份实现也会被门禁抓)。
   */
  private readonly muMuls: Map<string, number> = new Map();
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

  /**
   * 回收某刚体 id 在所有**按 id 索引的旁表**里的记录。
   *
   * 口径与 `remove()` / `clear()` 一致(三处共用本函数):一条 id 的生命周期
   * 结束时,它不该在任何旁表里留下记录。**不是可选项** ——
   * `spawn()` 覆盖同 id 时若不清,新刚体会**继承上一条命的滑溜/料理状态**
   * (muMuls 的注释专门写了这一条),而三张 buff 表还会随「换图/重置时的
   * 同 id 重生」逐轮留下再没人读的僵尸条目(无界增长)。
   *
   * `openedTraps` 刻意**不在这儿**:它的键是格 `"cx,cy"`,不是刚体 id ——
   * 陷阱开了就是世界状态,只由 `clear()`(重建世界)清。
   */
  private reclaimSideTables(id: string): void {
    this.trapTimers.delete(id);
    this.muMuls.delete(id);
    this.speedCaps.delete(id);
    this.gravityMuls.delete(id);
    this.jumpMuls.delete(id);
  }

  /**
   * 全部**按刚体 id 索引**的旁表:`表名 → 键集合`(审计的**唯一**读口)。
   *
   * `openedTraps` 刻意不在里面:它的键是格 `"cx,cy"`,不是刚体 id
   * (与 `reclaimSideTables` 同一条口径)。新增旁表时**必须**在这里登记,
   * 否则 `sideTableLeaks()` 对它是瞎的 —— 这正是本口存在的意义。
   */
  private sideTableKeys(): { table: string; keys: string[] }[] {
    return [
      { table: 'trapTimers', keys: [...this.trapTimers.keys()] },
      { table: 'muMuls', keys: [...this.muMuls.keys()] },
      { table: 'speedCaps', keys: [...this.speedCaps.keys()] },
      { table: 'gravityMuls', keys: [...this.gravityMuls.keys()] },
      { table: 'jumpMuls', keys: [...this.jumpMuls.keys()] },
    ];
  }

  /**
   * **悬空条目**清单:旁表里有、`bodies` 里已经没有的 id(★ WS-FND-130 P2)。
   *
   * ## 为什么这是判据而不是「顺手清一下」
   *
   * 悬空条目**读不到也清不掉**(读口按 id 查,`remove()` 已经过去了),它会一直
   * 躺着直到同名刚体重生才"诈尸"—— 而那一刻新刚体会**继承上一条命**的乘子。
   * 静默清理会把「是谁写进来的」这条线索一起抹掉,所以这里只**报**,由 setter
   * 的存在性闸(`setMuMul` / `setSpeedCap` / `setGravityMul` / `setJumpMul` 对
   * 不存在 id 返回 `false`)+ `reclaimSideTables`(remove/clear/spawn 三条路径)
   * 保证这条清单在生产中**恒空**;`sideTableLeaks()` 是它的**判据**。
   *
   * @returns `[]` = 旁表键 ⊆ bodies 键(不变量成立)。
   */
  sideTableLeaks(): { table: string; id: string }[] {
    const out: { table: string; id: string }[] = [];
    for (const t of this.sideTableKeys()) {
      for (const id of t.keys) {
        if (!this.bodies.has(id)) out.push({ table: t.table, id });
      }
    }
    return out;
  }

  /** 「旁表键 ⊆ bodies 键」这条不变量是否成立(`sideTableLeaks()` 的布尔包装)。 */
  sideTablesSubsetOfBodies(): boolean {
    return this.sideTableLeaks().length === 0;
  }

  /**
   * 生成(或**覆盖**)一个刚体。
   *
   * 覆盖同 id 与新建走同一条路:`remove()` 能回收的,`spawn()` 也必须回收 ——
   * 否则「同 id 重生」与「先 remove 再 spawn」在旁表上留下两种状态。
   */
  spawn(id: string, patch: Partial<DynamicBody> = {}): DynamicBody {
    this.reclaimSideTables(id);
    const b = createBody(id, patch);
    this.bodies.set(id, b);
    return b;
  }

  remove(id: string): boolean {
    this.reclaimSideTables(id);
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
    this.muMuls.clear();
    /* ★ WS-FND-77:三张料理旁表一起清(重建世界 = 没有任何 buff 残留)。 */
    this.speedCaps.clear();
    this.gravityMuls.clear();
    this.jumpMuls.clear();
    this.fx.length = 0;
    this.tickCount = 0;
    this.elapsed = 0;
  }

  /* ── 格占用查询(★ WS-FND-130 P2:格位唯一)──
   *
   * ## 为什么需要「口」而不是让调用方自己 `Math.floor` 遍历
   *
   * 「两个不同 id 落在同一格」在物理上**允许**发生(两两碰撞只做圆的分离,半径
   * 0.35 的两个圆可以完全重合;传送 / 读档 / 出生点也可以是同一格),所以物理层
   * 不该擅自拒绝 —— 但**不可观测**意味着「真的撞在一起了」与「压根没发生过」
   * 在外面分不开(本仓反复点名的「不可判定的失败」)。于是这里只提供**查询口**:
   * 计数(`occupantsAt`)与冲突清单(`sharedCellGroups`),是否强制由编排层裁决
   * (`world_sim#addPlayer` 那一侧决定「同格就挪开 / 只记一笔」)。
   */

  /**
   * 该格里**所有**刚体 id(格 = `floor(x), floor(y)`),按 id 排序。
   *
   * 排序是刻意的:`Map` 的迭代序在增删之后不可复现,而「同一格里有谁」是一份
   * 要拿去断言/留痕的事实,必须稳定。
   */
  occupantsAt(cx: number, cy: number): string[] {
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return [];
    const out: string[] = [];
    for (const b of this.bodies.values()) {
      if (Math.floor(b.x) === cx && Math.floor(b.y) === cy) out.push(b.id);
    }
    return out.sort();
  }

  /**
   * **同格冲突**清单:同一格里挤了 ≥2 个**不同 id** 的组(按格坐标排序)。
   *
   * 口径(两条都必须写清,否则判据会误报):
   * - **被举起的实体不算**:`carry.syncChain` 故意把第 k>0 层的 x/y 吸附到底层
   *   (叠罗汉就是「人站在人肩上」),那是**设计**而不是冲突。
   * - **坐标非有限的实体不算**:它们归 `ensureFinite` 管,塞进格清单只会让
   *   真正的冲突淹没在噪声里。
   */
  sharedCellGroups(): { cx: number; cy: number; ids: string[] }[] {
    const byCell = new Map<string, { cx: number; cy: number; ids: string[] }>();
    for (const b of this.bodies.values()) {
      if (b.carriedBy !== null) continue;
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const cx = Math.floor(b.x);
      const cy = Math.floor(b.y);
      const key = `${cx},${cy}`;
      const g = byCell.get(key);
      if (g === undefined) byCell.set(key, { cx, cy, ids: [b.id] });
      else g.ids.push(b.id);
    }
    const out: { cx: number; cy: number; ids: string[] }[] = [];
    for (const g of byCell.values()) {
      if (g.ids.length < 2) continue;
      g.ids.sort();
      out.push(g);
    }
    out.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    return out;
  }

  /* ── 摩擦乘子(裁决 D-12)── */

  /**
   * 设置某刚体的 μ **乘子**(最终摩擦 = 地板 μ × mul)。
   * 用于滑溜料理:`setMuMul(id, 0.96)` ⇒ 冰面 0.98×0.96、湿地 0.40×0.96,
   * 两个方向都朝"滑溜"走(见 `muMuls` 的注释)。
   *
   * **只接受有限正数**:`NaN` / `±Infinity` / `0` / 负数一律**拒绝并保持原值**。
   * 为什么不能"夹到 0"就完事:`mu = 0` 在 `integrateHorizontal` 里是
   * `v' = v*0` ⇒ 每帧速度归零,刚体不会"停",而是**原地定住**、外力也推不动,
   * 看上去像卡进墙里;负数更会让速度每帧反向并指数增长(直接飞走)。
   * 于是非法输入必须是 no-op,而不是写一个"看起来夹过了"的值。
   *
   * ★ 第八轮 P2:刚体 id **必须已存在**(`bodies` 里有它),否则**拒绝并返回 `false`**。
   * 修前对任何 id 都返回 `true` 并留一条记录 —— 而生产侧的输入是 `vitals.ids()`
   * (不是 `physics.bodies`)⇒ 任何「有 vitals 但没有刚体」的 id 都会立刻造出一条
   * **悬空条目**:它永远读不到、也永远清不掉,直到同名刚体重生才"诈尸"。
   *
   * @returns `true` = 已接受;`false` = 被拒(状态未变)。
   */
  setMuMul(id: string, mul: number): boolean {
    if (typeof mul !== 'number' || !Number.isFinite(mul) || mul <= 0) return false;
    /* ★ 存在性闸:悬空条目比"拒绝"难收拾得多(见 docblock)。 */
    if (!this.bodies.has(id)) return false;
    if (mul === MU_MUL_NEUTRAL) {
      /* 回到中性 = 删记录,不留一条 1(见 `MU_MUL_NEUTRAL` 的注释)。 */
      this.muMuls.delete(id);
      return true;
    }
    this.muMuls.set(id, mul);
    return true;
  }

  /** 某刚体当前的 μ 乘子;没设过 / 已清回中性 ⇒ 1(`MU_MUL_NEUTRAL`)。 */
  muMulOf(id: string): number {
    return this.muMuls.get(id) ?? MU_MUL_NEUTRAL;
  }

  /** 清掉某刚体的 μ 乘子(等价于 `setMuMul(id, MU_MUL_NEUTRAL)`)。 */
  clearMuMul(id: string): boolean {
    return this.muMuls.delete(id);
  }

  /* ── 料理 3 字段的**物理设置口**(WS-FND-77 / W 线:moveMul / gravityMul / jumpMul)──
   *
   * ## 为什么是「三张旁表 + stepBody 里的结算点」而不是改冻结层
   *
   * `shared/types/physics.ts` 的 `DynamicBody` 是冻结层(`integrateHorizontal` /
   * `integrateVertical` 的签名锁着它),加字段要改冻结层。与本文件的 `muMuls`
   * 同一手法:按**刚体 id** 索引的旁表,中性值 = 1。
   *
   * ## 三者的语义(与 `combat/cooking.ts` 的 `statMods` 逐字段对应)
   *
   * ```
   * moveMul     601 暖心甜莓果茶「移动速度 +15%」 ⇒ **水平速度上限** = 基准速 × mul
   * gravityMul  609 气球肚皮漂浮饮「重力降低 70%」⇒ 垂直积分的重力 × mul
   * jumpMul     604 星光萤火蘑菇汤「跳跃高度 +50%」⇒ 起跳初速 × mul(`jump()`)
   * ```
   *
   * ⚠️ **中性值是 1,且中性时逐位不变**:三处结算都写成 `if (mul !== 1)`,
   *   所以没有料理 buff 的刚体与加这条通道之前完全一致(与本文件 `muMuls` 的
   *   「中性乘子 1 ⇒ `mu * 1` 逐位不变」同一条纪律)。
   *
   * ⚠️ **结算只在 `stepBody` / `jump()` 里发生一次**。世界侧(`WorldSim`)只负责
   *   「读 buff → 推乘子」,不自己乘 —— 两处都乘就是平方(见 `muMuls` 的注释)。
   */

  /** 刚体 id → 水平速度上限(格/秒)。缺省 = **不设上限**(与接线前逐字一致)。 */
  private readonly speedCaps: Map<string, number> = new Map();
  /** 刚体 id → 重力乘子。缺省 = 1。 */
  private readonly gravityMuls: Map<string, number> = new Map();
  /** 刚体 id → 起跳初速乘子。缺省 = 1。 */
  private readonly jumpMuls: Map<string, number> = new Map();

  /**
   * 设某刚体的**水平速度上限**(格/秒)。用于 `moveMul`:世界侧推
   * `BASE_MOVE_SPEED × moveMul`(基准速在冻结层,本文件不另立一份)。
   *
   * 只接受有限正数:非法输入是 **no-op**(与 `setMuMul` 同一取舍 ——
   * 写一个「看起来夹过了」的 0 会让刚体原地定住,表现像卡进墙里)。
   *
   * ★ 第八轮 P2:刚体 id 必须已存在,否则拒(悬空条目永远读不到也清不掉 ——
   * 口径与 `setMuMul` 的 docblock 逐字同源)。
   *
   * @returns `true` = 已接受;`false` = 被拒(状态未变)。
   */
  setSpeedCap(id: string, cap: number): boolean {
    if (!this.bodies.has(id)) return false;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return false;
    this.speedCaps.set(id, cap);
    return true;
  }

  /** 某刚体的速度上限;没设过 ⇒ `null`(`null` 与「上限 0」不是同一件事)。 */
  speedCapOf(id: string): number | null {
    return this.speedCaps.get(id) ?? null;
  }

  /** 撤掉速度上限(回到「不设上限」)。 */
  clearSpeedCap(id: string): boolean {
    return this.speedCaps.delete(id);
  }

  /**
   * 设某刚体的**重力乘子**(1 = 中性)。用于 609 的「重力降低 70%」⇒ 0.30。
   *
   * 只接受有限**正数**:0 会让刚体永远悬空(不是「无重力」而是永不落地),
   * 负数会把重力翻成向上 —— 两者都是「看起来夹过了」的坏值,故一律拒。
   */
  setGravityMul(id: string, mul: number): boolean {
    /* ★ 存在性闸(第八轮 P2):与 `setMuMul` 的 docblock 同一口径 —— 对不存在的
       刚体写乘子只会留一条**悬空条目**,而生产侧的输入是 `vitals.ids()`。 */
    if (!this.bodies.has(id)) return false;
    if (typeof mul !== 'number' || !Number.isFinite(mul) || mul <= 0) return false;
    if (mul === 1) {
      this.gravityMuls.delete(id);
      return true;
    }
    this.gravityMuls.set(id, mul);
    return true;
  }

  /** 某刚体的重力乘子;没设过 ⇒ 1(中性)。 */
  gravityMulOf(id: string): number {
    return this.gravityMuls.get(id) ?? 1;
  }

  /** 撤掉重力乘子(等价于 `setGravityMul(id, 1)`)。 */
  clearGravityMul(id: string): boolean {
    return this.gravityMuls.delete(id);
  }

  /**
   * 设某刚体的**起跳初速乘子**(1 = 中性)。用于 604 的「跳跃高度 +50%」⇒ 1.50。
   *
   * ⚠️ 本文件**不自己造跳跃初速**:起跳速度是内容/物理层的已有常量
   *   (`physics/carry.ts` 的 `JUMP_VZ`),由调用方作为 `baseVz` 传给 `jump()`。
   *   这样物理层没有第二个「跳跃高度」事实源。
   */
  setJumpMul(id: string, mul: number): boolean {
    /* ★ 存在性闸(第八轮 P2):与 `setMuMul` 的 docblock 同一口径。 */
    if (!this.bodies.has(id)) return false;
    if (typeof mul !== 'number' || !Number.isFinite(mul) || mul <= 0) return false;
    if (mul === 1) {
      this.jumpMuls.delete(id);
      return true;
    }
    this.jumpMuls.set(id, mul);
    return true;
  }

  /** 某刚体的起跳乘子;没设过 ⇒ 1(中性)。 */
  jumpMulOf(id: string): number {
    return this.jumpMuls.get(id) ?? 1;
  }

  /** 撤掉起跳乘子。 */
  clearJumpMul(id: string): boolean {
    return this.jumpMuls.delete(id);
  }

  /**
   * **起跳**:把 `baseVz`(调用方给的初速,通常是 `carry.ts` 的 `JUMP_VZ`)
   * 乘上该刚体的 `jumpMul` 写进 `vz`。
   *
   * 为什么需要这个方法(`jumpMul` 光有 setter 不成立):乘子必须有一个
   * **被用到的瞬间**,否则它就是「存了但没人读」的第三条旁表 —— 本仓反复
   * 点名的「实现完整、单测全绿、编排层不接」形态。
   *
   * @returns 实际写入的 `vz`;刚体不存在 / 参数非法 ⇒ `null`(不抛错)。
   */
  jump(id: string, baseVz: number): number | null {
    const b = this.bodies.get(id);
    if (b === undefined) return null;
    if (typeof baseVz !== 'number' || !Number.isFinite(baseVz)) return null;
    const vz = baseVz * this.jumpMulOf(id);
    if (!Number.isFinite(vz)) return null;
    b.vz = vz;
    return vz;
  }

  /**
   * **带计时状态的写入口**(第八轮 P1:统一状态源)。
   *
   * 实现完全委托给纯函数 `applyTimedBodyState`(互斥规则与优先级表在那边的
   * docblock 里),这里只补一层「刚体不存在 ⇒ 不写、返回 `NORMAL`」的闸 ——
   * 与四个旁表 setter 同一口径。
   *
   * ⚠️ **别处不许再直接写 `body.state`**:那正是 `carry.ts:451` 的旧形态
   * (无条件覆盖 ⇒ 带计时的 `BUBBLED` 被顶成 `STUNNED`、泡泡的计时丢掉)。
   *
   * @returns 写入之后**实际生效**的状态。
   */
  applyTimedState(id: string, state: BodyState, sec: number): BodyState {
    const b = this.bodies.get(id);
    if (b === undefined) return BodyState.NORMAL;
    return applyTimedBodyState(b, state, sec);
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

  /**
   * 圆心在 `(x, y)`、半径 `radius` 的圆**能不能站**:不许与任何实心格相交,也不许出界。
   *
   * ## 为什么不能只查"圆心所在格"
   *
   * 圆心在自由格里、圆边却已经压进邻格时,那半个身位**也在墙里**
   * (这正是 `resolveTerrainWalls` 用 `x - cx < r` 去兜的那件事)。所以判据是
   * 「圆 ↔ 格矩形」的距离 `< radius`,与半径无关的部分(圆心所在格)自然也被它覆盖
   * (距离 0 < radius)。
   *
   * ## 越界
   *
   * 边界口径与 `clampBounds` **同一个**(圆心必须落在 `[minX, maxX] × [minY, maxY]`)——
   * 不另立一套"带半径的边界",否则同一张地图会有两条边界事实。
   *
   * 非法入参一律 fail-closed(`true` = 不可站):`NaN` 坐标放行等于让
   * `NaN` 顺着位置传播(第八轮 P1 的穿墙与出界就是这一类)。
   */
  isBlockedAt(x: number, y: number, radius: number = DEFAULT_PLAYER_RADIUS): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    if (!Number.isFinite(radius) || radius <= 0) return true;
    const { minX, minY, maxX, maxY } = this.bounds;
    if (x < minX || x > maxX || y < minY || y > maxY) return true;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    /* 半径 ≤ 1 格 ⇒ 圆最多跨 3×3 格;邻格逐格查(与 `resolveTerrainWalls` 同口径)。 */
    for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
      for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
        if (!this.isSolidCell(gx, gy)) continue;
        const nx = Math.min(Math.max(x, gx), gx + 1);
        const ny = Math.min(Math.max(y, gy), gy + 1);
        if (Math.hypot(x - nx, y - ny) < radius) return true;
      }
    }
    return false;
  }

  /**
   * **扫掠位移**(第八轮 P1 的修法):把圆心从 `(x, y)` 沿 `(dx, dy)` 推进,
   * 遇到实心格 / 出界就**退到最后一个合法点**,绝不把刚体搬进墙里。
   *
   * ## 为什么必须是扫掠,不能只校验终点
   *
   * 击退是一次 1~2 格的**位置搬家**(`world_sim.ts#tickKnockback`),不是速度积分 ⇒
   * 物理步的子步拆分拦不住它。只判终点也会错:1 格厚的墙在终点之外时,
   * "起点合法、终点合法"仍可能中途穿过去(贴着墙被推、终点落在墙的另一侧)。
   *
   * ## 为什么终点合法就**原样返回**(不做任何中间算术)
   *
   * 无遮挡时位移必须与修前**逐位相同**(`WS-FND-98` 的 `min(2, 伤害/20)` 判据
   * 用 `1e-9` 精度钉着它)⇒ 只有终点不合法时才走二分细化。
   *
   * @returns 实际落点 + `blocked`(是否被挡下 = 还有剩余位移没推完)。
   */
  sweepCircle(
    x: number, y: number, dx: number, dy: number,
    radius: number = DEFAULT_PLAYER_RADIUS,
  ): { x: number; y: number; blocked: boolean; moved: number } {
    /* ★ WS-FND-130 P1:二分细化搬去**纯函数** `lastFreeAlong`(唯一事实源),
       本方法只剩「把 `isBlockedAt` 包成回调」这一件事。
       两份二分实现必然会漂(本仓反复踩过的「同一算式两处写」),而这里的语义
       (终点合法 ⇒ 原样返回、起点不合法 ⇒ 原地不动)必须只有一份。 */
    return lastFreeAlong(x, y, dx, dy, (px, py) => this.isBlockedAt(px, py, radius));
  }

  /**
   * **落点校验 / 回退到最近合法格**(★ WS-FND-130 P1 的第二个口)。
   *
   * 给定圆心 `(x, y)`:合法就**原样返回**(`blocked: false`,逐位不变);
   * 与实心格相交 / 越界就挪到**最近的合法格中心**,并报 `blocked: true`。
   *
   * ## 为什么还需要它(`sweepCircle` 不够)
   *
   * `sweepCircle` 的隐含前提是**起点合法**:它在 `[起点, 终点]` 上二分,起点本身
   * 不合法时 `lo` 停在 0 ⇒ 原样不动(`world_sim#tickKnockback` 正是这种情况:
   * 上一帧已经落进墙格的刚体再被击退,扫掠救不出来)。击退 / 传送 / 读档搬位置
   * 都是**一步到位**的搬家,需要的不是「再扫一次」,而是「这个落点还算不算数,
   * 不算就退到最近的合法点」。这就是本口。
   *
   * ## 判据与取舍
   *
   * - 候选只用**格中心** `(gx+0.5, gy+0.5)`:`isBlockedAt` 的判据是
   *   `dist < radius`,而 `RADIUS_PLAYER = 0.35` 的圆在自由格中心必然合法
   *   (距任何格边 0.5 > 0.35)。半径大到整格塞不下(`> 0.5`)时本口**不猜** ——
   *   找不到合法点就返回 `blocked: true` 且**原地不动**,绝不挑一个更坏的落点。
   * - 搜索按**切比雪夫环**由近及远(`CLAMP_RING_MAX` 环),每一环只取本环的边、
   *   并取**欧氏距离最小**的合法格中心;同环内扫描顺序固定 ⇒ 结果可复现
   *   (不依赖 `Map` 迭代序)。
   * - 非法入参 **fail-closed**:非有限坐标退到 `fallback`(给了才用)或世界中心;
   *   连它们都不合法就返回原点 + `blocked: true`(`NaN` 放行等于让 `NaN` 顺着
   *   位置传播 —— 第八轮 P1 的穿墙与出界正是这一类)。
   *
   * @param fallback 调用方手里的**最后合法点**(通常是上一帧位置)。
   * @returns 实际落点 + `blocked`(请求点非法 ⇒ 被搬过)。
   */
  clampToFreeCell(
    x: number, y: number,
    radius: number = DEFAULT_PLAYER_RADIUS,
    fallback?: { x: number; y: number },
  ): { x: number; y: number; blocked: boolean } {
    const r = Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_PLAYER_RADIUS;
    const fb = fallback !== undefined && Number.isFinite(fallback.x) && Number.isFinite(fallback.y)
      ? fallback
      : undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (fb !== undefined) return { x: fb.x, y: fb.y, blocked: true };
      const hx = clampNum((this.bounds.minX + this.bounds.maxX) / 2, this.bounds.minX, this.bounds.maxX);
      const hy = clampNum((this.bounds.minY + this.bounds.maxY) / 2, this.bounds.minY, this.bounds.maxY);
      return { x: hx, y: hy, blocked: true };
    }
    if (!this.isBlockedAt(x, y, r)) return { x, y, blocked: false };
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let ring = 0; ring <= CLAMP_RING_MAX; ring += 1) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let gy = cy - ring; gy <= cy + ring; gy += 1) {
        for (let gx = cx - ring; gx <= cx + ring; gx += 1) {
          /* 只看本环的**边**:环内的格在更近的一环里已经试过。 */
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue;
          const px = gx + 0.5;
          const py = gy + 0.5;
          if (this.isBlockedAt(px, py, r)) continue;
          const d = Math.hypot(px - x, py - y);
          if (d < bestD) {
            best = { x: px, y: py };
            bestD = d;
          }
        }
      }
      if (best !== null) return { x: best.x, y: best.y, blocked: true };
    }
    if (fb !== undefined && !this.isBlockedAt(fb.x, fb.y, r)) return { x: fb.x, y: fb.y, blocked: true };
    return { x, y, blocked: true };
  }

  /* ── 主循环 ── */

  /**
   * 20Hz 推进一帧。
   * 顺序:机关外力 → 拆分子步 → 水平积分 → 垂直积分 → 地形碰撞 →
   *       两两碰撞 → **墙体反卡** → 边界钳制 → 有限性兜底。
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

    /* 2. 墙体反卡 → 边界 → 有限性兜底 */
    for (const b of this.bodies.values()) {
      /* ★ 第八轮 P1:`resolveTerrainWalls` 只兜「圆心仍自由、圆边越界」那一档,
         所以被 `applyImpulse`(大锤 / 击退)一步推进墙里、或被位置路径搬家落进
         墙里的刚体会**滞留在墙内**(圆心在实心格 ⇒ 四条边判定全不成立)。
         这里主动把它推回最近的一个合法点 —— 位置是唯一权威,不留"卡住"态。 */
      this.unstickFromSolid(b, report);
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

    /* 状态计时(★ 第八轮 P1:到点回 `NORMAL` 的状态由 `TIMED_BODY_STATES` 决定,
       不再只认 `STUNNED / FROZEN` —— 修前 `BUBBLED` 的计时到点**没人放它回 NORMAL**,
       于是"泡泡困住"在归零后永远留着)。

       `GHOST_BUBBLE` / `AFK_SHIELD` 刻意不在表里:它们的生命周期由
       `combat/revive.ts` 的 `DownedState` / AFK 层持有,物理层放它回 NORMAL
       等于把「倒地中」抹掉(见 `TIMED_BODY_STATES` 的注释)。 */
    if (b.stateTimer > 0) {
      b.stateTimer -= dt;
      if (b.stateTimer <= 0) {
        b.stateTimer = 0;
        if (isTimedBodyState(b.state)) b.state = BodyState.NORMAL;
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
    /* ★ μ 乘子的**唯一结算点**(裁决 D-12):最终摩擦 = 地板 μ × 该刚体的乘子。
       用于滑溜料理(0.96):冰面 0.98 → 0.9408(更滑)、湿地 0.40 → 0.384(更黏)。
       方向恒定是**相乘**相对**覆盖**的全部意义(见 `muMuls` 的注释):
       覆盖会把冰面拉低 0.98→0.96、把湿地拉高 0.40→0.96,同一份料理两头相反。

       中性乘子是 1 ⇒ `mu * 1` 在 IEEE 双精度下**逐位不变**,
       因此没有滑溜 buff 的刚体行为与加这条通道之前完全一致。
       乘子在这里只出现这一次:别处再乘一次就是 mul 的平方,两份实现也会被门禁抓
       (`WS-FND-54` FND54-2 用 0.9408 这个字面量把它钉住)。 */
    b.mu = mu * this.muMulOf(b.id);

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
    /* ★ WS-FND-130 P2:质量一律经 `safeMass`(§0)。冻结层 `integrateHorizontal` 里的
       `mass === 0 ? 1 : mass` 只挡 `0`:`NaN` 质量会让 `(fx + beltX) / m` 变 `NaN`
       ⇒ 下面那道有限性守卫把速度**每帧清零**(表现是「这个刚体在传送带上纹丝不动」,
       而不是任何报错)。合法质量(正整数)经 `safeMass` **逐位不变**。 */
    const nv = integrateHorizontal(b.vx, b.vy, mu, 0, 0, 0, 0, beltX, beltY, safeMass(b.mass), dt);
    if (Number.isFinite(nv.x) && Number.isFinite(nv.y)) {
      b.vx = nv.x;
      b.vy = nv.y;
    } else {
      b.vx = 0;
      b.vy = 0;
    }

    /* ★ WS-FND-77 / moveMul(601「移动速度 +15%」)的**唯一结算点**:
       有上限才夹,且夹的是速度矢量(方向不变)。没设过上限 ⇒ 逐位不变
       (与接线前完全一致 —— 本仓「中性值不得改变既有行为」的纪律)。

       为什么不夹位移:位置由 `b.x += vx·dt` 直接得出,夹速度就等价地
       限制了每帧位移;夹位移会让碰撞/反弹看到的速度与实际移动脱节。

       ⚠️ 被击退/投掷的瞬时速度**也会**被这个上限夹住 —— 这是「移动速度 +15%」
       这条 buff 挂在刚体上的必然结果(上限是刚体属性,不是输入属性)。
       故世界侧只给**有 moveMul 的玩家**推上限,没吃料理的人完全不受影响。 */
    const cap = this.speedCaps.get(b.id);
    if (cap !== undefined) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > cap) {
        const k = cap / sp;
        b.vx *= k;
        b.vy *= k;
      }
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    /* — 垂直积分(冻结层) — */
    const gz = this.groundZAt(b.x, b.y);
    const vzBefore = b.vz;
    /* ★ 重力倍率的**唯一结算点**:落穴倍率(`gMul`,机关,1.8)× 料理乘子
       (`gravityMul`,609「重力降低 70%」⇒ 0.30)。两者中性值都是 1,
       相乘为 1 时这一行整个跳过 ⇒ 没有落穴也没有料理时逐位不变。
       GRAVITY 为负,乘 (total-1) 后增加值速度朝向 -z。 */
    const gFood = this.gravityMuls.get(b.id) ?? 1;
    const gTotal = gMul * gFood;
    if (gTotal !== 1) b.vz += GRAVITY * (gTotal - 1) * dt;
    const vs = integrateVertical(b.z, b.vz, dt);
    b.z = vs.z;
    b.vz = vs.vz;

    /* 落地判定。★ 第八轮:按**现状**订正这段注释(原文写「gz 可能 < 0(深沟)或
       > 0(高台)」,但 `< 0` 那一支是**死代码**)。

       `groundZAt` 返回 `(elev & 3) - 1 ∈ {-1, 0, 1, 2}`,而冻结层
       `integrateVertical` 把 z **硬钳在 ≥ 0**(`if (nz <= 0) return { z: 0, ... }`)⇒
       `b.z <= gz` 在 `gz = -1`(elev 0 的深沟格)时**永不成立**。
       能走到的只有 `gz ≥ 0`(平地 0 / 高台 1~2)。
       深沟"掉进去"的观感来自落穴倍率(`TRAP_FALL_MUL`)让 z 更快归 0,
       不是真的落到 -1 —— 这一点如实记在这里,不假装那个分支还活着。 */
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

  /**
   * **墙体反卡**(第八轮 P1):圆心已经落在实心格内 / 圆与实心格相交时,
   * 把它推回**最近的一个合法点**。
   *
   * ## 为什么 `resolveTerrainWalls` 兜不住这一档
   *
   * 那个方法逐边判「`b.x - cx < r` 且**邻格**实心」;可圆心一旦已经在实心格内,
   * 四条边判定用的都是"当前格 / 邻格"的组合,可能全不成立 ⇒ 刚体**留在墙里**。
   * 实测表现:贴着 1 格厚实心墙被击退 1~2 格 ⇒ 落进墙格后出不来;地图边缘同理。
   * 物理层必须有一处「从墙里出来」的通道。
   *
   * ## 为什么是「最小平移」的四选一
   *
   * 候选是圆心所在格的**四条边外侧**(距离各为 `radius`),取位移最小且
   * `isBlockedAt` 判为合法的那一个;四个都不合法 ⇒ **不动**(留给下一次 step
   * 继续试),绝不挑一个更坏的落点。
   *
   * @returns 是否真的推出来了。
   */
  private unstickFromSolid(b: DynamicBody, report: StepReport): boolean {
    if (!this.isBlockedAt(b.x, b.y, b.radius)) return false;
    const r = b.radius;
    const cx = Math.floor(b.x);
    const cy = Math.floor(b.y);
    const candidates: readonly { x: number; y: number }[] = [
      { x: cx - r, y: b.y },
      { x: cx + 1 + r, y: b.y },
      { x: b.x, y: cy - r },
      { x: b.x, y: cy + 1 + r },
    ];
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      if (this.isBlockedAt(c.x, c.y, r)) continue;
      const d = Math.hypot(c.x - b.x, c.y - b.y);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    if (best === null) return false;
    b.x = best.x;
    b.y = best.y;
    /* 从墙里出来的那一下不该带着"墙里的速度"继续跑(否则下一帧又冲回去)。 */
    b.vx = 0;
    b.vy = 0;
    report.wallHits += 1;
    this.fx.push({ kind: 'WALL_HIT', id: b.id, x: b.x, y: b.y, z: b.z, magnitude: 0 });
    return true;
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

        /* 位置分离:按质量反比分配(非法质量先经 `safeMass` 拒绝,见 §0) */
        const ma = safeMass(a.mass);
        const mb = safeMass(b.mass);
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
   * 施加冲量 J:Δv = J / m。**按质量归一**(质量越大 Δv 越小)。
   * 大锤击退走这条路径,平安盾在 CarrySystem 层拦截。
   *
   * `m` 一律经 `safeMass`(§0):`NaN` / `±Infinity` / `0` / 负数 / 小数质量被**拒绝**,
   * 退化为 `DEFAULT_BODY_MASS`。旧写法 `mass <= 0 ? 1 : mass` 会让 `NaN` 质量
   * 直接产出 `NaN` 冲量(`Δv = J / NaN`),而 `NaN` 一旦写进 `vx` 就再也回不来
   * (积分器每一步都带着它)。
   */
  applyImpulse(id: string, jx: number, jy: number, jz: number): { dvx: number; dvy: number; dvz: number } {
    const b = this.bodies.get(id);
    if (b === undefined) return { dvx: 0, dvy: 0, dvz: 0 };
    const m = safeMass(b.mass);
    const dvx = jx / m;
    const dvy = jy / m;
    const dvz = jz / m;
    b.vx += dvx;
    b.vy += dvy;
    b.vz += dvz;
    return { dvx, dvy, dvz };
  }

  /** 掼摔:把被举起者沿 dir 抛出并附加下压速度。质量同样经 `safeMass` 归一。 */
  slam(id: string, dirX: number, dirY: number, power: number): { dvx: number; dvy: number; dvz: number } {
    const b = this.bodies.get(id);
    if (b === undefined) return { dvx: 0, dvy: 0, dvz: 0 };
    const len = Math.hypot(dirX, dirY) || 1;
    const m = safeMass(b.mass);
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