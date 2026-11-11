/**
 * WS-03 共享网格容器(本工作流自研,冻结层之外):承放 32-Bit 单元格的世界视图。
 *
 * 设计要点:
 *  - 只依赖 `node:*` 与冻结层的 `shared/types/tile.ts`;
 *  - 禁止 `enum` / 参数属性 / `namespace`,相对导入必须带 `.ts` 后缀;
 *  - 越界读取返回 `EMPTY_TILE`,越界写入静默丢弃 —— 调用方无需到处写边界分支;
 *  - 底层 `Uint32Array` 一维连续,512×512 世界 = 1 MB。
 */

import { OBJ_MASK, packTile, unpackTile } from '../../../shared/types/tile.ts';
/** 空单元格:六字段全 0(elev=0 深沟、obj=0 无物体、wire=0 无暗线)。 */
export const EMPTY_TILE = packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 0, meta: 0 });

/** 方位常量:0=北(−y) 1=东(+x) 2=南(+y) 3=西(−x),与 `faceDir()` 高 2 位取值一致。 */
export const Dir = { NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

/** 四方向偏移,下标即 `Dir` 值。 */
export const DIR_DX: readonly number[] = [0, 1, 0, -1];
export const DIR_DY: readonly number[] = [-1, 0, 1, 0];

/**
 * 矩形瓦片网格:一维 `Uint32Array` 行主序存放 32-Bit 单元格。
 * 坐标约定:x 向东 0..width-1,y 向南 0..height-1。
 */
export class TileGrid {
  readonly width: number;
  readonly height: number;
  private data: Uint32Array;

  constructor(width: number, height: number, fillValue: number = EMPTY_TILE) {
    this.width = Math.max(0, width | 0);
    this.height = Math.max(0, height | 0);
    this.data = new Uint32Array(this.width * this.height);
    if (fillValue !== 0) this.data.fill(fillValue >>> 0);
  }

  /** 全局格索引;越界返回 −1。 */
  index(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** 读格;越界得到 `EMPTY_TILE`(不抛异常,便于邻接掩码直接采样)。 */
  get(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? EMPTY_TILE : this.data[i];
  }

  /** 写格;越界静默丢弃。 */
  set(x: number, y: number, v: number): void {
    const i = this.index(x, y);
    if (i >= 0) this.data[i] = v >>> 0;
  }

  /** 取格内物体 ID(Bits 16..27),越界为 0。 */
  objAt(x: number, y: number): number {
    return (this.get(x, y) & OBJ_MASK) >>> 16;
  }

  /** 写格内物体 ID,其余字段保留。 */
  setObj(x: number, y: number, objId: number): void {
    const f = unpackTile(this.get(x, y));
    f.obj = objId & 0xfff;
    this.set(x, y, packTile(f));
  }

  /** 按 4 邻域填充矩形(含端点);越界部分自动裁剪。 */
  fillRect(x0: number, y0: number, x1: number, y1: number, v: number): void {
    const lx = Math.max(0, Math.min(x0, x1));
    const hx = Math.min(this.width - 1, Math.max(x0, x1));
    const ly = Math.max(0, Math.min(y0, y1));
    const hy = Math.min(this.height - 1, Math.max(y0, y1));
    for (let y = ly; y <= hy; y += 1) {
      for (let x = lx; x <= hx; x += 1) this.set(x, y, v);
    }
  }

  /** 从另一网格整体拷入(左上角对齐),用于测试与蓝图落位。 */
  blit(src: TileGrid, ox: number, oy: number): void {
    for (let y = 0; y < src.height; y += 1) {
      for (let x = 0; x < src.width; x += 1) this.set(ox + x, oy + y, src.get(x, y));
    }
  }

  /** 遍历全部格;回调可提前返回 false 终止。 */
  forEach(fn: (v: number, x: number, y: number) => void | boolean): void {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (fn(this.data[y * this.width + x], x, y) === false) return;
      }
    }
  }

  /** 统计满足谓词的格数。 */
  countWhere(pred: (v: number, x: number, y: number) => boolean): number {
    let n = 0;
    this.forEach((v, x, y) => {
      if (pred(v, x, y)) n += 1;
    });
    return n;
  }

  /** 导出为行主序副本(调试与哈希用)。 */
  toArray(): Uint32Array {
    return this.data.slice();
  }
}
