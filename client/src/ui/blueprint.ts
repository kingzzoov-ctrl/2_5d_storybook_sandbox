/**
 * WS-09 / 房间蓝图框选 —— 纯逻辑层(不 import three)。
 *
 * 玩法:玩家按住拖拽在 2.5D 舞台上画一个矩形,系统把矩形覆盖的格框选出来,
 * 用于「整片拆墙 / 整片铺地砖 / 导出建筑蓝图 / 复制到其他房间」。
 *
 * 三个必须处理对的难点:
 *  1. **2.5D 屏幕矩形 ≠ 世界轴对齐矩形**。正交 45° 投影下,屏幕上一个矩形
 *     反投影到地面是**菱形**;如果直接对屏幕矩形取 min/max 再反投影角点,
 *     框选会明显「偏掉」。正确做法是把屏幕矩形的 4 个角**分别反投影**,
 *     再取世界 AABB —— 这个 AABB 天然包住菱形,是玩家直觉上的「框选范围」。
 *  2. **跨海拔**:框选区域可能同时覆盖 Z=−1(水沟)与 Z=0(平原)。
 *     蓝图按 (x, y, z) 三元组记录,允许同一 (x,y) 有多个 z 的构件
 *     (如河面上的栈桥 Z=0 与河床 Z=−1)。
 *  3. **规模上限**:一次框选可能覆盖 1024×1024 全图(1,048,576 格),
 *     必须用显式上限,避免生成百万级对象数组把标签页打死。
 */

import { CHUNK_SIZE } from '../../../shared/types/tile.ts';
import { unprojectScreenToGrid, type IsoCamera } from '../stage/iso_camera.ts';

/** 单次框选的最大格数(超过则按中心裁剪,并在 UI 上提示) */
export const MAX_SELECT_CELLS = 64 * 64;

/** 最小有效框选边长(像素),小于此值视为误触(当作点击) */
export const MIN_DRAG_PX = 4;

/** 蓝图记录的一条构件 */
export interface BlueprintCell {
  x: number;
  y: number;
  z: number;
  /** 32-bit 单元值 */
  tile: number;
}

export interface Blueprint {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 覆盖格数(面积) */
  area: number;
  /** 非空格数 */
  filled: number;
  cells: BlueprintCell[];
  /** 是否被 MAX_SELECT_CELLS 裁剪 */
  clipped: boolean;
}

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CellRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  clipped: boolean;
}

/** 屏幕矩形是否达到「拖拽」阈值(否则视为点击) */
export function isDrag(rect: ScreenRect): boolean {
  return Math.abs(rect.x1 - rect.x0) >= MIN_DRAG_PX && Math.abs(rect.y1 - rect.y0) >= MIN_DRAG_PX;
}

/** 规范化屏幕矩形(自动交换左上/右下) */
export function normalizeScreenRect(rect: ScreenRect): ScreenRect {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/**
 * 屏幕矩形 → 世界 AABB。
 *
 * **关键**:不是取两个角点,而是把 4 个角都反投影后取 min/max。
 * 45° 投影下,只取 2 个对角会让框选区域在某一侧缩水近半。
 * 复杂度 O(1)。
 */
export function screenRectToWorldRect(rect: ScreenRect, cam: IsoCamera, gz = 0): WorldRect {
  const r = normalizeScreenRect(rect);
  const corners = [
    unprojectScreenToGrid(r.x0, r.y0, cam, gz),
    unprojectScreenToGrid(r.x1, r.y0, cam, gz),
    unprojectScreenToGrid(r.x0, r.y1, cam, gz),
    unprojectScreenToGrid(r.x1, r.y1, cam, gz),
  ];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const c of corners) {
    if (c.gx < minX) minX = c.gx;
    if (c.gx > maxX) maxX = c.gx;
    if (c.gy < minY) minY = c.gy;
    if (c.gy > maxY) maxY = c.gy;
  }
  return { minX, minY, maxX, maxY };
}

/** 世界 AABB → 整数格范围(含端点),并按 MAX_SELECT_CELLS 居中裁剪 */
export function clampCellRange(rect: WorldRect, maxCells = MAX_SELECT_CELLS): CellRange {
  let x0 = Math.floor(rect.minX);
  let y0 = Math.floor(rect.minY);
  let x1 = Math.floor(rect.maxX);
  let y1 = Math.floor(rect.maxY);
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
  if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const cap = Math.max(1, Math.trunc(maxCells));
  if (w * h <= cap) return { x0, y0, x1, y1, clipped: false };

  /* 居中裁剪成正方形近似,保证不超上限 */
  const side = Math.max(1, Math.floor(Math.sqrt(cap)));
  const cx = Math.floor((x0 + x1) / 2);
  const cy = Math.floor((y0 + y1) / 2);
  const half = Math.floor(side / 2);
  return {
    x0: cx - half,
    y0: cy - half,
    x1: cx - half + side - 1,
    y1: cy - half + side - 1,
    clipped: true,
  };
}

/**
 * 采集蓝图:遍历范围内的 (x, y, z),把非空单元收进 cells。
 *
 * @param getTile  (x, y, z) → 32-bit 单元值;缺失返回 0
 * @param zLayers  参与采集的海拔层,默认全部 4 层
 * 复杂度 O(面积 × 层数)。
 */
export function collectBlueprint(
  range: { x0: number; y0: number; x1: number; y1: number; clipped?: boolean },
  getTile: (x: number, y: number, z: number) => number,
  zLayers: readonly number[] = [-1, 0, 1, 2],
): Blueprint {
  const cells: BlueprintCell[] = [];
  let filled = 0;
  let area = 0;
  for (let y = range.y0; y <= range.y1; y += 1) {
    for (let x = range.x0; x <= range.x1; x += 1) {
      area += 1;
      for (const z of zLayers) {
        const tile = getTile(x, y, z);
        if (tile === 0) continue;
        cells.push({ x, y, z, tile });
        filled += 1;
      }
    }
  }
  return {
    minX: range.x0,
    minY: range.y0,
    maxX: range.x1,
    maxY: range.y1,
    area,
    filled,
    cells,
    clipped: range.clipped === true,
  };
}

/** 蓝图占用的 Chunk 集合(用于只渲染/同步相关区块) */
export function blueprintChunks(bp: Blueprint): string[] {
  const keys = new Set<string>();
  const cx0 = Math.floor(bp.minX / CHUNK_SIZE);
  const cy0 = Math.floor(bp.minY / CHUNK_SIZE);
  const cx1 = Math.floor(bp.maxX / CHUNK_SIZE);
  const cy1 = Math.floor(bp.maxY / CHUNK_SIZE);
  for (let cy = cy0; cy <= cy1; cy += 1) {
    for (let cx = cx0; cx <= cx1; cx += 1) keys.add(`${cx},${cy}`);
  }
  return [...keys];
}

/**
 * 蓝图对称镜像(左半框选 → 复制到右半,绘本小镇党刚需)。
 *
 * **镜像轴取原蓝图的选区边界,而不是镜像后 cells 的包围盒。**
 * 早先版本用 `cells` 重新求 `minX/maxX`,于是单格构件的镜像结果把边界收缩成
 * 一个点(`0..5` → `4..4`);对结果再镜像一次,轴变成 `4+4=8`,
 * `8−4=4` 就不再回到原点 —— 镜像不满足对合性(involution),
 * 表现成「反复按镜像键,图形一路向右漂移」。
 * 选区边界属于「这次框选的范围」,镜像只是把内容翻到另一侧,边界不该随之改变。
 */
export function mirrorBlueprint(bp: Blueprint, axis: 'x' | 'y'): Blueprint {
  const mid = axis === 'x' ? bp.minX + bp.maxX : bp.minY + bp.maxY;
  const cells = bp.cells.map((c) => {
    if (axis === 'x') return { x: mid - c.x, y: c.y, z: c.z, tile: c.tile };
    return { x: c.x, y: mid - c.y, z: c.z, tile: c.tile };
  });
  return {
    /* 边界保持原选区,保证两次镜像回到原位 */
    minX: bp.minX,
    maxX: bp.maxX,
    minY: bp.minY,
    maxY: bp.maxY,
    area: bp.area,
    filled: bp.filled,
    cells,
    clipped: bp.clipped,
  };
}

/** 蓝图摘要(UI 顶条) */
export function blueprintSummary(bp: Blueprint): string {
  return `蓝图 ${bp.maxX - bp.minX + 1}×${bp.maxY - bp.minY + 1}`
    + `|覆盖 ${bp.area} 格|非空 ${bp.filled} 构件`
    + `|涉及 ${blueprintChunks(bp).length} 个 Chunk`
    + (bp.clipped ? '|已按上限裁剪' : '');
}

/** 框选边框的世界四角(装配层画虚线框用) */
export function blueprintOutline(bp: Blueprint, z = 0): { x: number; y: number; z: number }[] {
  return [
    { x: bp.minX, y: bp.minY, z },
    { x: bp.maxX + 1, y: bp.minY, z },
    { x: bp.maxX + 1, y: bp.maxY + 1, z },
    { x: bp.minX, y: bp.maxY + 1, z },
  ];
}

/** 单层采集便捷入口 */
export function collectBlueprintLayer(
  range: { x0: number; y0: number; x1: number; y1: number; clipped?: boolean },
  getTile: (x: number, y: number, z: number) => number,
  z: number,
): Blueprint {
  return collectBlueprint(range, getTile, [z]);
}