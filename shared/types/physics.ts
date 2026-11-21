/**
 * 2.5D 伪三维质点物理契约(冻结层)。对应设计手册 §2.2。
 * 单位统一为「格」与「格/秒」。
 *
 * 语法约定:禁止 `enum` / `const enum`。
 */

export const TICK_HZ = 32;
/** 标称帧间隔(毫秒)= `1000 / TICK_HZ`(32Hz ⇒ 31.25ms)。 */
export const TICK_MS = 1000 / TICK_HZ; // 31.25
export const DT = 1 / TICK_HZ; // 0.03125s
/** 快帧单步时长(秒)—— 与 `DT` 同源(`SIM_FAST_DT` 取它)。 */
export const SIM_DT = 1 / TICK_HZ; // 0.03125s
/**
 * 慢帧时长(秒)—— **语义源头**:0.5 秒。慢帧频率由它推出,不是反过来。
 * ⇒ 一个慢帧跨越的快帧数 = `TICK_HZ × SLOW_DT`(32Hz ⇒ 16);
 *   改 tick 率时**时长不变**,只有帧数跟着换算(见下方 helper)。
 */
export const SLOW_DT = 0.5;
/** 慢帧频率(Hz)= `1 / SLOW_DT`。 */
export const SLOW_TICK_HZ = 1 / SLOW_DT; // 2

/* ── 帧数 ⇄ 秒 ⇄ 毫秒 的**唯一**换算口(帧数以 `TICK_HZ` 为网格)──
 * 所有「以帧数计的时长」必须从这里派生:写死帧数会在改 tick 率时**静默改时长**。 */
export function secondsToTicks(sec: number): number { return Math.round(sec * TICK_HZ); }
export function ticksToSeconds(n: number): number { return n / TICK_HZ; }
export function msToTicks(ms: number): number { return Math.round((ms * TICK_HZ) / 1000); }

export const GRAVITY = -18.0;      // 格/秒²
export const THROW_SPEED_XY = 8.5; // 格/秒
export const THROW_SPEED_Z = 6.0;  // 格/秒
export const CARRY_Z_STEP = 0.85;  // 每层叠罗汉高度
export const CARRY_MAX_DEPTH = 4;  // 最多 4 层
export const CARRY_SLOWDOWN = 0.85; // 每背一层,底层移速乘数
export const CATCH_RADIUS = 0.8;
export const CATCH_Z_MIN = 0.3;
export const CATCH_Z_MAX = 1.4;

export const RADIUS_PLAYER = 0.35;
export const RADIUS_WILD = 0.40;
export const RADIUS_BOSS = 1.20;
export const MASS_PLAYER = 1.0;
export const MASS_HEAVY = 3.0;
export const MASS_BOSS = 20.0;

export const BASE_MOVE_SPEED = 4.5; // 格/秒
/*
 * ★ `BASE_HP` 的**唯一声明**在 `shared/types/entities.ts`(成长公式 `statsAtLevel` 的底座);
 *   本文件只**转发**它。原先这里有一份同值副本(`= 100`)——零生产消费者,
 *   但它是「同一个数两处声明」,加一级血上限时必然只改一处 ⇒ 副本已删。
 */
export { BASE_HP } from './entities.ts';
export const BASE_ATK = 10;

export const BodyState = {
  NORMAL: 'NORMAL',
  SLIPPING: 'SLIPPING',
  STUNNED: 'STUNNED',
  BUBBLED: 'BUBBLED',
  FROZEN: 'FROZEN',
  GHOST_BUBBLE: 'GHOST_BUBBLE',
  AFK_SHIELD: 'AFK_SHIELD',
} as const;
export type BodyState = (typeof BodyState)[keyof typeof BodyState];

export const BODY_STATES: readonly BodyState[] = [
  'NORMAL', 'SLIPPING', 'STUNNED', 'BUBBLED', 'FROZEN', 'GHOST_BUBBLE', 'AFK_SHIELD',
];

export interface DynamicBody {
  id: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  radius: number;
  mass: number;
  state: BodyState;
  carriedBy: string | null;
  carrying: string | null;
  /** 状态剩余秒数(眩晕/冰冻/泡泡/幽灵) */
  stateTimer: number;
  /** 当前脚下摩擦系数 */
  mu: number;
}

export interface Vec2 { x: number; y: number; }

export function createBody(id: string, patch: Partial<DynamicBody> = {}): DynamicBody {
  return {
    id,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    radius: RADIUS_PLAYER,
    mass: MASS_PLAYER,
    state: BodyState.NORMAL,
    carriedBy: null,
    carrying: null,
    stateTimer: 0,
    mu: 0.75,
    ...patch,
  };
}

/** 水平摩擦与地形滑行积分: v' = v*mu + a*dt + (F_impulse + F_belt)/m */
export function integrateHorizontal(
  vx: number, vy: number,
  mu: number,
  ax: number, ay: number,
  fx: number, fy: number,
  beltX: number, beltY: number,
  mass: number,
  dt: number = DT,
): Vec2 {
  const m = mass === 0 ? 1 : mass;
  return {
    x: vx * mu + ax * dt + (fx + beltX) / m,
    y: vy * mu + ay * dt + (fy + beltY) / m,
  };
}

export interface VerticalStep { z: number; vz: number; grounded: boolean; }

export function integrateVertical(z: number, vz: number, dt: number = DT): VerticalStep {
  const nz = z + vz * dt;
  const nvz = vz + GRAVITY * dt;
  if (nz <= 0) return { z: 0, vz: 0, grounded: true };
  return { z: nz, vz: nvz, grounded: false };
}

export interface ThrowParams { x: number; y: number; z: number; vx: number; vy: number; vz: number; }

/** 抛物线投掷初速度: 水平 |dir| * 8.5,z 初速 +6.0 */
export function throwVelocity(dirX: number, dirY: number, z0: number, speedMul = 1): ThrowParams {
  const len = Math.hypot(dirX, dirY) || 1;
  return {
    x: 0, y: 0, z: z0,
    vx: (dirX / len) * THROW_SPEED_XY * speedMul,
    vy: (dirY / len) * THROW_SPEED_XY * speedMul,
    vz: THROW_SPEED_Z,
  };
}

/** 举起链坐标同步:E_k.z = E_0.z + k * 0.85 */
export function stackOffset(index: number): number {
  return index * CARRY_Z_STEP;
}

/** 底层承载者移速乘数 0.85^depth */
export function carrierSpeedMul(depth: number): number {
  return CARRY_SLOWDOWN ** depth;
}

/** 完美接球判定: 0.3 <= z <= 1.4 且水平距离 <= 0.8 */
export function canPerfectCatch(z: number, dist: number): boolean {
  return z >= CATCH_Z_MIN && z <= CATCH_Z_MAX && dist <= CATCH_RADIUS;
}

/** 圆形刚体弹性碰撞反弹 */
export function resolveCircleBounce(
  vx: number, vy: number, nx: number, ny: number, restitution = 1.0,
): Vec2 {
  const d = vx * nx + vy * ny;
  return { x: vx - (1 + restitution) * d * nx, y: vy - (1 + restitution) * d * ny };
}
