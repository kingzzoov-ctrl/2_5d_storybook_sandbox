/**
 * WS-03 / 四色暗线视图(207 四色电路扳手的 UI 数据源)。
 *
 * 职责:从 32-Bit 单元格的 Bits 12..15 抽出四色暗线,重新打包成「按颜色分层的
 * 布线视图」,供客户端叠加渲染,并给出铺线合法性校验(不与实心构件冲突)。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。信号推进逻辑不在这里,见 WS-08 的
 * `server/src/wiring/graph.ts`。
 */

import { WIRE_BIT, WireColor, unpackTile } from '../../../shared/types/tile.ts';
import { TileGrid, DIR_DX, DIR_DY } from './grid.ts';
import { isBarrier } from './autotile.ts';

/** 颜色短名(与冻结层 `WireColor` 值一一对应)。 */
export const WIRE_NAME: Record<number, string> = {
  [WireColor.RED]: 'RED',
  [WireColor.BLUE]: 'BLUE',
  [WireColor.YELLOW]: 'YELLOW',
  [WireColor.GREEN]: 'GREEN',
};

/** 颜色中文标签,UI 侧直接使用。 */
export const WIRE_LABEL: Record<number, string> = {
  [WireColor.RED]: '红线',
  [WireColor.BLUE]: '蓝线',
  [WireColor.YELLOW]: '黄线',
  [WireColor.GREEN]: '绿线(风力动力网)',
};

export const ALL_WIRE_COLORS: readonly WireColor[] = [
  WireColor.RED,
  WireColor.BLUE,
  WireColor.YELLOW,
  WireColor.GREEN,
];

/** 单个格子的布线信息。 */
export interface WireCellInfo {
  x: number;
  y: number;
  /** 4 位掩码,Bit0=红 Bit1=蓝 Bit2=黄 Bit3=绿 */
  wireMask: number;
  colors: WireColor[];
  /** 该格是否被实心构件占据(铺线会失败) */
  blocked: boolean;
  /** 该格物体 ID */
  obj: number;
}

/** 单色分层。 */
export interface WireLayer {
  color: WireColor;
  name: string;
  label: string;
  /** 该色线的全部格 */
  cells: { x: number; y: number }[];
  /** 该色网络的连通分量数量 */
  networkCount: number;
  /** 每个连通分量的格数,降序 */
  componentSizes: number[];
}

export interface WireView {
  width: number;
  height: number;
  /** 覆盖层:Bits 12..15 的原始值 */
  overlay: Uint8Array;
  /** 四色分层数据 */
  layers: WireLayer[];
  /**
   * 全部铺了线的**格**数:对四色做 `Set<globalIndex>` 并集后取 size。
   * 一个格子上叠两条线仍只算 1。
   */
  wiredCells: number;
  /**
   * **色·格**口径的总数:Σ 各颜色的格数。
   * 与 `wiredCells` 的差值恰好等于 `overlapCells`。
   */
  perColorWiredCells: number;
  /** 出现两色以上重叠的格数(提示玩家可能串色) */
  overlapCells: number;
  /** 按颜色统计的格数 */
  perColorCount: Record<number, number>;
}

/**
 * 构建布线视图。
 * 复杂度 O(W·H) 抽取 + O(Σ|layer|) 连通分量(BFS)。
 *
 * 去重口径(不能混):
 *  - `wiredCells` 用 `Set<globalIndex>` 求并集,同一格叠两色只算 1;
 *  - `perColorWiredCells` 是逐色计数之和,重叠格在每色各计 1 次;
 *  - `perColorWiredCells − wiredCells === overlapCells` 是必须成立的不变量。
 */
export function buildWireView(grid: TileGrid): WireView {
  const width = grid.width;
  const height = grid.height;
  const overlay = new Uint8Array(width * height);
  const perColorCount: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const wiredSet = new Set<number>();
  let perColorWiredCells = 0;
  let overlapCells = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const w = unpackTile(grid.get(x, y)).wire & 0xf;
      overlay[y * width + x] = w;
      if (w === 0) continue;
      wiredSet.add(y * width + x);
      let bits = 0;
      for (const c of ALL_WIRE_COLORS) {
        if ((w & WIRE_BIT[c]) !== 0) {
          perColorCount[c] += 1;
          perColorWiredCells += 1;
          bits += 1;
        }
      }
      if (bits >= 2) overlapCells += 1;
    }
  }

  const layers: WireLayer[] = ALL_WIRE_COLORS.map((color) => {
    const cells: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((overlay[y * width + x] & WIRE_BIT[color]) !== 0) cells.push({ x, y });
      }
    }
    const sizes = connectedComponentSizes(cells, color, overlay, width, height);
    return {
      color,
      name: WIRE_NAME[color],
      label: WIRE_LABEL[color],
      cells,
      networkCount: sizes.length,
      componentSizes: sizes,
    };
  });

  const wiredCells = wiredSet.size;

  return {
    width,
    height,
    overlay,
    layers,
    wiredCells,
    perColorWiredCells,
    overlapCells: Math.max(0, perColorWiredCells - wiredCells),
    perColorCount,
  };
}

/** 在布线视图内对单色做 4 邻域连通分量统计,返回各分量格数(降序)。 */
function connectedComponentSizes(
  cells: readonly { x: number; y: number }[],
  color: WireColor,
  overlay: Uint8Array,
  width: number,
  height: number,
): number[] {
  const seen = new Uint8Array(width * height);
  const sizes: number[] = [];
  for (const start of cells) {
    const sIdx = start.y * width + start.x;
    if (seen[sIdx] !== 0) continue;
    seen[sIdx] = 1;
    const queue: number[] = [sIdx];
    let head = 0;
    let size = 0;
    while (head < queue.length) {
      const idx = queue[head];
      head += 1;
      size += 1;
      const cx = idx % width;
      const cy = (idx - cx) / width;
      for (let d = 0; d < 4; d += 1) {
        const nx = cx + DIR_DX[d];
        const ny = cy + DIR_DY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (seen[nIdx] !== 0) continue;
        if ((overlay[nIdx] & WIRE_BIT[color]) === 0) continue;
        seen[nIdx] = 1;
        queue.push(nIdx);
      }
    }
    sizes.push(size);
  }
  sizes.sort((a, b) => b - a);
  return sizes;
}

/** 取某格的布线信息。 */
export function wireCellAt(grid: TileGrid, x: number, y: number): WireCellInfo {
  const v = grid.get(x, y);
  const f = unpackTile(v);
  const wireMask = f.wire & 0xf;
  const colors: WireColor[] = [];
  for (const c of ALL_WIRE_COLORS) if ((wireMask & WIRE_BIT[c]) !== 0) colors.push(c);
  return {
    x,
    y,
    wireMask,
    colors,
    blocked: isBarrier(f.obj),
    obj: f.obj,
  };
}

export const LayWireResult = {
  OK: 'OK',
  BLOCKED_BY_SOLID: 'BLOCKED_BY_SOLID',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  ALREADY_SET: 'ALREADY_SET',
} as const;
export type LayWireResult = (typeof LayWireResult)[keyof typeof LayWireResult];

/** 铺线合法性:实心墙体/门/窗内不能埋线(除了「窗帘墙 + 暗线」的例外由 UI 侧裁决)。 */
export function canLayWire(grid: TileGrid, x: number, y: number, color: WireColor): LayWireResult {
  if (!grid.inBounds(x, y)) return LayWireResult.OUT_OF_BOUNDS;
  const f = unpackTile(grid.get(x, y));
  if (isBarrier(f.obj)) return LayWireResult.BLOCKED_BY_SOLID;
  if ((f.wire & WIRE_BIT[color]) !== 0) return LayWireResult.ALREADY_SET;
  return LayWireResult.OK;
}

/** 统计视图里「孤立线头」数量:只有一个同色邻居的格,提示玩家线断了。 */
export function danglingEnds(view: WireView): number {
  let n = 0;
  for (const layer of view.layers) {
    for (const c of layer.cells) {
      let deg = 0;
      for (let d = 0; d < 4; d += 1) {
        const nx = c.x + DIR_DX[d];
        const ny = c.y + DIR_DY[d];
        if (nx < 0 || ny < 0 || nx >= view.width || ny >= view.height) continue;
        if ((view.overlay[ny * view.width + nx] & WIRE_BIT[layer.color]) !== 0) deg += 1;
      }
      if (deg <= 1) n += 1;
    }
  }
  return n;
}

/** 把视图压缩成可下发客户端的紧凑字节流:每行 run-length 编码。 */
export function serializeWireView(view: WireView): number[] {
  const out: number[] = [];
  for (let y = 0; y < view.height; y += 1) {
    let run = 0;
    let cur = 0;
    for (let x = 0; x < view.width; x += 1) {
      const v = view.overlay[y * view.width + x] & 0xf;
      if (x === 0) {
        cur = v;
        run = 1;
        continue;
      }
      if (v === cur) {
        run += 1;
      } else {
        out.push(cur & 0xf, Math.min(run, 255));
        cur = v;
        run = 1;
      }
    }
    out.push(cur & 0xf, Math.min(run, 255));
  }
  return out;
}