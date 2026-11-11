/**
 * WS-04 / WS-05 共用「地面预警几何内核」。
 *
 * 五类几何:圆 CIRCLE / 扇 SECTOR / 矩形 RECT / 环 RING / 旋转指针 POINTER。
 * 全部为**精确点在几何内判定**,使用相对容差 `GEOM_EPS`(1e-12)消除浮点噪声,
 * 使得「恰好落在边界上」判为 true,「恰好差 1e-9」判为 false。
 *
 * 语法约定:禁止 `enum` / 参数属性 / `namespace`;相对导入带 `.ts`。
 */

import type { Vec2 } from '../../../shared/types/physics.ts';

/** 相对容差:1e-12 ≫ 双精度累积误差(~1e-16),≪ 题目要求的 1e-9 判定步长。 */
export const GEOM_EPS = 1e-12;

export const DEG = Math.PI / 180;

export const WarnShape = {
  CIRCLE: 'CIRCLE',
  SECTOR: 'SECTOR',
  RECT: 'RECT',
  RING: 'RING',
  POINTER: 'POINTER',
} as const;
export type WarnShape = (typeof WarnShape)[keyof typeof WarnShape];

export const WARN_SHAPES: readonly WarnShape[] = [
  WarnShape.CIRCLE, WarnShape.SECTOR, WarnShape.RECT, WarnShape.RING, WarnShape.POINTER,
];

/**
 * 统一预警几何。字段按 `kind` 解释:
 * - CIRCLE  : cx, cy, radius
 * - SECTOR  : cx, cy, radius, centerDeg(轴角), halfDeg(半张角)
 * - RECT    : cx, cy, centerDeg(长轴角), halfLen(半长), halfWidth(半宽)
 * - RING    : cx, cy, innerRadius, radius(外径)
 * - POINTER : cx, cy, centerDeg(起始角), spinDegPerSec(顺时针角速度), halfLen(长), halfWidth(半宽)
 */
export interface WarnGeom {
  kind: WarnShape;
  cx: number;
  cy: number;
  radius: number;
  innerRadius: number;
  centerDeg: number;
  halfDeg: number;
  halfLen: number;
  halfWidth: number;
  spinDegPerSec: number;
  /** 预警中心高度(Z 层),用于云鲸 Z=2 高空吐息。 */
  z: number;
  /** Z 容差:目标 z 落在 [z - zTolerance, z + zTolerance] 内才结算。 */
  zTolerance: number;
  /** 预警持续秒数(0 表示由调用方接管)。 */
  warnSec: number;
}

export function makeWarn(patch: Partial<WarnGeom> = {}): WarnGeom {
  return {
    kind: WarnShape.CIRCLE,
    cx: 0,
    cy: 0,
    radius: 0,
    innerRadius: 0,
    centerDeg: 0,
    halfDeg: 0,
    halfLen: 0,
    halfWidth: 0,
    spinDegPerSec: 0,
    z: 0,
    zTolerance: 1.6,
    warnSec: 0,
    ...patch,
  };
}

export function circleWarn(cx: number, cy: number, radius: number, warnSec = 0.8): WarnGeom {
  return makeWarn({ kind: WarnShape.CIRCLE, cx, cy, radius, warnSec });
}

export function ringWarn(cx: number, cy: number, innerRadius: number, outerRadius: number, warnSec = 0.8): WarnGeom {
  return makeWarn({ kind: WarnShape.RING, cx, cy, radius: outerRadius, innerRadius, warnSec });
}

/** 扇形:中心 + 轴角 centerDeg + 半张角 halfDeg(0 < halfDeg < 180)。 */
export function sectorWarn(
  cx: number, cy: number, radius: number, centerDeg: number, halfDeg: number, warnSec = 0.8,
): WarnGeom {
  return makeWarn({ kind: WarnShape.SECTOR, cx, cy, radius, centerDeg, halfDeg, warnSec });
}

/** 有向矩形:中心 + 长轴角 centerDeg + 半长 halfLen + 半宽 halfWidth。 */
export function rectWarn(
  cx: number, cy: number, halfLen: number, halfWidth: number, centerDeg: number, warnSec = 0.8,
): WarnGeom {
  return makeWarn({
    kind: WarnShape.RECT, cx, cy, centerDeg, halfLen, halfWidth, radius: halfLen, warnSec,
  });
}

/** 旋转指针:从 centerDeg 起以 spinDegPerSec 顺时针旋转的细长矩形。 */
export function pointerWarn(
  cx: number, cy: number, length: number, width: number, centerDeg: number,
  spinDegPerSec: number, warnSec = 0.8,
): WarnGeom {
  return makeWarn({
    kind: WarnShape.POINTER, cx, cy, centerDeg, spinDegPerSec,
    halfLen: length, halfWidth: width / 2, radius: length, warnSec,
  });
}

/** 指针在 t 秒时的朝向角(度,顺时针为正)。 */
export function pointerAngleDeg(g: WarnGeom, t: number): number {
  return g.centerDeg + g.spinDegPerSec * t;
}

/**
 * 「点在几何内」精确判定。
 *
 * 复杂度 O(1),无分支预测失败点;全部用「相对容差」而非绝对容差,保证尺度无关。
 *
 * @param t 指针/旋转类几何的时间(秒);其余几何忽略。
 */
export function insideWarn(g: WarnGeom, px: number, py: number, t = 0): boolean {
  const dx = px - g.cx;
  const dy = py - g.cy;
  const d2 = dx * dx + dy * dy;

  switch (g.kind) {
    case 'CIRCLE': {
      const r = g.radius * (1 + GEOM_EPS);
      return d2 <= r * r;
    }
    case 'RING': {
      const outer = g.radius * (1 + GEOM_EPS);
      const inner = g.innerRadius * (1 - GEOM_EPS);
      if (d2 > outer * outer) return false;
      if (g.innerRadius <= 0) return true;
      return d2 >= inner * inner;
    }
    case 'SECTOR': {
      const r = g.radius * (1 + GEOM_EPS);
      if (d2 > r * r) return false;
      if (d2 <= 0) return true;
      const a = g.centerDeg * DEG;
      const d = Math.sqrt(d2);
      // 点积法:无需 atan2,边界处无三角函数回代误差。
      const dot = (dx * Math.cos(a) + dy * Math.sin(a)) / d;
      return dot >= Math.cos(g.halfDeg * DEG) - GEOM_EPS;
    }
    case 'RECT': {
      const a = g.centerDeg * DEG;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const lx = dx * ca + dy * sa;
      const ly = -dx * sa + dy * ca;
      const hl = g.halfLen * (1 + GEOM_EPS);
      const hw = g.halfWidth * (1 + GEOM_EPS);
      return (lx <= hl && lx >= -hl) && (ly <= hw && ly >= -hw);
    }
    case 'POINTER': {
      const a = pointerAngleDeg(g, t) * DEG;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const lx = dx * ca + dy * sa;
      const ly = -dx * sa + dy * ca;
      const hw = g.halfWidth * (1 + GEOM_EPS);
      // 指针锚定在中心,只朝正向延伸 [0, halfLen]。
      return (lx >= -g.halfLen * GEOM_EPS && lx <= g.halfLen * (1 + GEOM_EPS))
        && (ly <= hw && ly >= -hw);
    }
    default:
      return false;
  }
}

/** 高度层判定:目标 z 是否落入预警的垂直容差。 */
export function insideWarnZ(g: WarnGeom, pz: number): boolean {
  return Math.abs(pz - g.z) <= g.zTolerance * (1 + GEOM_EPS);
}

/** 综合判定(水平几何 + 高度层)。 */
export function insideWarn3D(g: WarnGeom, px: number, py: number, pz: number, t = 0): boolean {
  return insideWarnZ(g, pz) && insideWarn(g, px, py, t);
}

/** 几何外接圆半径(用于粗筛加速:先做 O(1) 圆剔除,再做精确判定)。 */
export function warnBoundsRadius(g: WarnGeom): number {
  switch (g.kind) {
    case 'RECT':
    case 'POINTER':
      return Math.hypot(g.halfLen, g.halfWidth);
    default:
      return g.radius;
  }
}

/** 粗筛:点在几何外接圆与 z 容差之外 → 必然不在几何内。 */
export function rejectByBounds(g: WarnGeom, px: number, py: number, pz: number): boolean {
  if (!insideWarnZ(g, pz)) return true;
  const r = warnBoundsRadius(g) * (1 + GEOM_EPS);
  const dx = px - g.cx;
  const dy = py - g.cy;
  return dx * dx + dy * dy > r * r;
}

/** 射线(宽 w,长 l)的便捷构造:等价于以原点为锚的 RECT。 */
export function rayWarn(
  cx: number, cy: number, length: number, width: number, dirDeg: number, warnSec = 0.5,
): WarnGeom {
  return rectWarn(
    cx + Math.cos(dirDeg * DEG) * length / 2,
    cy + Math.sin(dirDeg * DEG) * length / 2,
    length / 2, width / 2, dirDeg, warnSec,
  );
}

/** 从中心朝目标点的方向角(度)。 */
export function angleToDeg(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(toY - fromY, toX - fromX) / DEG;
}

/** 角度归一化到 (-180, 180]。 */
export function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** 夹角绝对值(度,范围 [0, 180])。 */
export function angleDiffDeg(a: number, b: number): number {
  return Math.abs(wrapDeg(a - b));
}

/** 单位向量;零向量回退为 (0, 1)。 */
export function unit(dx: number, dy: number): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 1 };
  return { x: dx / len, y: dy / len };
}
