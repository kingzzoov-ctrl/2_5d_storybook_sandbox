/**
 * 通行规则:一格能不能走进去。服务端落点裁决与客户端预测用的是这同一份。
 *
 * 三类挡路:
 * 1 实心物件 —— 墙、大树、岩石、矿脉、家具、地标;
 * 2 深水 —— 深层(Z-1)的流体格,上面没有栈桥/桥;
 * 3 陡坎 —— 目标格比身体高出半格以上(站在台阶上可以多上一层,跳起来也够得着一层)。
 *
 * 往低处走永远可以。已经身在不可进入的格子里(被扔进河里、脚下被人放了墙)时不拦,
 * 否则会永远卡死。
 */

import { BaseFluid, Elevation } from '../types/tile.ts';
import { isLandmark, Landmark } from './landmarks.ts';

/** 通行判定要读的那四个字段。 */
export interface CellView {
  elev: number;
  base: number;
  floor: number;
  obj: number;
}

/** 读一格;世界外返回 `null`。 */
export type CellReader = (cx: number, cy: number) => CellView | null;

/** 不借助台阶/跳跃时能迈上去的高度(格)。 */
export const STEP_UP_REACH = 0.55;

/** 台阶/坡道/藤梯:站在上面可以多上一层。 */
export const STAIR_OBJS: ReadonlySet<number> = new Set([377, 378, 379]);

/** 铺在水上也能走的物件(吊桥 / 拱桥)。 */
export const BRIDGE_OBJS: ReadonlySet<number> = new Set([380, 381]);

/** 不挡路的地标(踩得过去的小东西)。 */
const SOFT_LANDMARKS: ReadonlySet<number> = new Set([Landmark.FLOWER_BED, Landmark.CLOUD_PUFF]);

/**
 * 自然资源里**挡路**的那些:树、岩石、矿脉(一格一棵,生成器保证它们互不相邻)。
 * 草、灌木、蘑菇、作物可以直接走过去。
 */
const SOLID_NATURAL: ReadonlySet<number> = new Set([
  101, 102, 103, 104, 105, 106, 109, 110, 111, 112, 113, 114, 115, 116, 120, 122, 125, 128,
]);

/** 家具与设备(501..537)里**不**挡路的:路灯、摆件,以及要「坐 / 躺上去」才用得了的床、椅、吊床。 */
const SOFT_FURNITURE: ReadonlySet<number> = new Set([517, 518, 520, 521, 522, 523, 524]);

/** 这个物件挡不挡路。 */
export function isSolidObj(obj: number): boolean {
  if (obj === 0) return false;
  if (obj >= 351 && obj <= 371) return true;            /* 墙体与门窗(与物理层既有口径一致) */
  if (obj >= 372 && obj <= 376) return true;            /* 屋顶格:房子内部进不去 */
  if (SOLID_NATURAL.has(obj)) return true;
  if (obj >= 501 && obj <= 537) return !SOFT_FURNITURE.has(obj);
  if (obj === 750) return true;                          /* 通关纪念碑 */
  if (isLandmark(obj)) return !SOFT_LANDMARKS.has(obj);
  return false;
}

/** 这个基底是不是流体(水 / 温泉 / 粘液 / 熔岩 / 巧克力浆)。 */
export function isFluidBase(base: number): boolean {
  return base >= BaseFluid.SHALLOW_WATER && base <= BaseFluid.CHOCO;
}

/** 深水:深层流体格,且没有铺装也没有桥。 */
export function isDeepWater(c: CellView): boolean {
  return c.elev === Elevation.DEEP && isFluidBase(c.base) && c.floor === 0 && !BRIDGE_OBJS.has(c.obj);
}

/** 一格的地面高度(与物理层 `groundZAt` 同口径:elev - 1)。 */
export function groundZOf(c: CellView): number {
  return (c.elev & 0x3) - 1;
}

/**
 * 从 `from` 格走进 `to` 格行不行。
 *
 * `bodyZ` 是身体的权威高度(绝对值;物理层把它钳在 ≥ 0)。实际用的是
 * `max(bodyZ, from 的地面高度)`:站在哪一层就至少有那一层的高度,
 * 免得刚上台阶、权威高度还没回来的那几帧被自己脚下的台面挡住。
 */
export function canEnter(from: CellView | null, to: CellView, bodyZ: number): boolean {
  if (isSolidObj(to.obj)) return false;
  if (isDeepWater(to)) return from !== null && isDeepWater(from);
  const z = Number.isFinite(bodyZ) ? bodyZ : 0;
  const standing = from === null ? z : Math.max(z, groundZOf(from));
  const reach = standing + STEP_UP_REACH + (from !== null && STAIR_OBJS.has(from.obj) ? 1 : 0);
  return groundZOf(to) <= reach;
}

/** 圆(圆心 `x,y`、半径 `r`)是否压到任何进不去的格子;世界外也算压到。 */
export function blockedAt(x: number, y: number, r: number, bodyZ: number, from: CellView | null, cellAt: CellReader): boolean {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      const c = cellAt(gx, gy);
      if (c !== null && canEnter(from, c, bodyZ)) continue;
      const nx = Math.min(Math.max(x, gx), gx + 1);
      const ny = Math.min(Math.max(y, gy), gy + 1);
      if (Math.hypot(x - nx, y - ny) < r) return true;
    }
  }
  return false;
}

/** 一次位移的最大子步长(格):比任何挡路物都薄,不会一步跨过去。 */
export const MOVE_SUBSTEP = 0.2;

/**
 * 把位移 `(x0,y0) → (x1,y1)` 走到走不动为止,贴着障碍滑行(先试整步,再试单轴)。
 *
 * 起点本身已经压在障碍上 ⇒ 原样放行(见文件头:不许卡死)。
 * 返回最终位置与是否被挡过。
 */
export function slideMove(
  x0: number, y0: number, x1: number, y1: number,
  r: number, bodyZ: number, cellAt: CellReader,
): { x: number; y: number; blocked: boolean } {
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) return { x: x0, y: y0, blocked: true };
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (dist === 0) return { x: x0, y: y0, blocked: false };
  const steps = Math.max(1, Math.ceil(dist / MOVE_SUBSTEP));
  const sx = (x1 - x0) / steps;
  const sy = (y1 - y0) / steps;
  let x = x0;
  let y = y0;
  let blocked = false;
  for (let i = 0; i < steps; i += 1) {
    const from = cellAt(Math.floor(x), Math.floor(y));
    if (blockedAt(x, y, r, bodyZ, from, cellAt)) {
      /* 已经压着障碍:这一步不裁决,走出去再说。 */
      x += sx;
      y += sy;
      continue;
    }
    if (!blockedAt(x + sx, y + sy, r, bodyZ, from, cellAt)) {
      x += sx;
      y += sy;
    } else if (sx !== 0 && !blockedAt(x + sx, y, r, bodyZ, from, cellAt)) {
      x += sx;
      blocked = true;
    } else if (sy !== 0 && !blockedAt(x, y + sy, r, bodyZ, from, cellAt)) {
      y += sy;
      blocked = true;
    } else {
      blocked = true;
      break;
    }
  }
  /* 一路没被挡 ⇒ 落点就是申报的那个点(不带子步累加的浮点尾差)。 */
  return blocked ? { x, y, blocked } : { x: x1, y: y1, blocked };
}
