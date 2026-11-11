/**
 * WS-09 / 像素画架 16×16 绘制器 —— 纯逻辑层(不 import three)。
 *
 * 对应用途(冻结层配表):
 *  - 314 自定义像素地毯(可多块无缝拼成巨幅地画)
 *  - 524 绘本艺术展示画框(挂在墙上展示)
 *  - 630 自定义像素印花披风(战队统一披风)
 *  - 209 32 色气压染色枪改色
 *
 * 因此画架的数据契约必须满足三件事:
 *  1. **16×16 = 256 像素,行主序**,与 WS-06 的 `visual_style.pixel_icon_16x16` 完全同构 ——
 *     玩家手绘的图案与 LLM 生成的法器图标用同一套渲染管线;
 *  2. **32 色调色盘**,索引 0..31;索引 32 保留为「透明」,用 −1 表达,避免调色盘与擦除混淆;
 *  3. **撤销/重做双侧栈**,容量有上限(默认 64 步),超出丢最老,内存恒定。
 *
 * 全部操作都是「改 1 个字节」级别,复杂度 O(1)(`fillRect` 为 O(w·h))。
 */

/** 画布边长 */
export const EASEL_SIZE = 16;
/** 像素数 */
export const EASEL_PIXELS = EASEL_SIZE * EASEL_SIZE;
/** 调色盘色数 */
export const PALETTE_SIZE = 32;
/** 透明像素的调色盘索引 */
export const TRANSPARENT_INDEX = -1;
/** 撤销栈默认容量 */
export const DEFAULT_UNDO_DEPTH = 64;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * 32 色调色盘:8 个色相 × 4 档明度,绘本风低饱和高亮。
 * 索引 0 固定为「近白」,便于玩家从空白直接上色;索引 31 为「近黑」描边。
 */
export const PALETTE_32: readonly string[] = [
  '#FFFDF7', '#F5E7D0', '#E9D3B0', '#D8B98C',
  '#F7B7C6', '#EE8CA6', '#D76388', '#B03F6C',
  '#FBD9A0', '#F5B96B', '#E0913C', '#B96A22',
  '#D8EFA8', '#A9D97C', '#7CB855', '#4E8C39',
  '#A8E6E0', '#6EC9C4', '#43A0A4', '#2A7178',
  '#A9C8F5', '#7BA3E8', '#4F76CC', '#2E4C96',
  '#D3B8F0', '#B08BE0', '#875FC2', '#5B3C90',
  '#F0C9A8', '#D9A17C', '#B87A55', '#8A5433',
];

/** 调色盘索引 → RGB(越界回退为白色) */
export function paletteColor(index: number): Rgb {
  const i = Math.trunc(index);
  if (!Number.isFinite(i) || i < 0 || i >= PALETTE_SIZE) return { r: 255, g: 255, b: 255 };
  const hex = PALETTE_32[i];
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export interface EaselFrame {
  /** 长度 256,取值 −1(透明)或 0..31 */
  pixels: Int8Array;
  /** 结果矩阵的调色盘字符行,与 WS-06 契约同构 */
  rows: string[];
}

/**
 * 像素画架。所有编辑方法都返回是否真的发生了改变(无变化不入撤销栈)。
 */
export class PixelEasel {
  readonly size: number;
  private pixels: Int8Array;
  private undoStack: Int8Array[];
  private redoStack: Int8Array[];
  private readonly undoDepth: number;
  /** 笔画缓冲:一次拖动只形成 1 个撤销步 */
  private strokeSnapshot: Int8Array | null;

  constructor(undoDepth = DEFAULT_UNDO_DEPTH) {
    this.size = EASEL_SIZE;
    this.pixels = new Int8Array(EASEL_PIXELS).fill(TRANSPARENT_INDEX);
    this.undoStack = [];
    this.redoStack = [];
    this.undoDepth = Math.max(1, Math.trunc(undoDepth));
    this.strokeSnapshot = null;
  }

  static fromRows(rows: readonly string[]): PixelEasel {
    const e = new PixelEasel();
    e.loadRows(rows);
    return e;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  inBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return TRANSPARENT_INDEX;
    return this.pixels[y * this.size + x];
  }

  private snapshot(): Int8Array {
    return this.pixels.slice();
  }

  private pushUndo(before: Int8Array): void {
    this.undoStack.push(before);
    if (this.undoStack.length > this.undoDepth) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** 开始一笔(拖动/连续绘制),整笔合并为 1 个撤销步 */
  beginStroke(): void {
    if (this.strokeSnapshot === null) this.strokeSnapshot = this.snapshot();
  }

  /** 结束一笔 */
  endStroke(): void {
    if (this.strokeSnapshot === null) return;
    const same = this.strokeSnapshot.every((v, i) => v === this.pixels[i]);
    if (!same) this.pushUndo(this.strokeSnapshot);
    this.strokeSnapshot = null;
  }

  /** 单点上色;index=−1 表示擦除 */
  paint(x: number, y: number, index: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const v = this.normalizeIndex(index);
    const i = y * this.size + x;
    if (this.pixels[i] === v) return false;
    if (this.strokeSnapshot === null) this.pushUndo(this.snapshot());
    this.pixels[i] = v;
    return true;
  }

  private normalizeIndex(index: number): number {
    const i = Math.trunc(index);
    if (i < 0 || i >= PALETTE_SIZE) return TRANSPARENT_INDEX;
    return i;
  }

  /** 矩形填充(含端点,坐标自动夹紧) */
  fillRect(x0: number, y0: number, x1: number, y1: number, index: number): boolean {
    const ax = Math.max(0, Math.min(this.size - 1, Math.min(Math.trunc(x0), Math.trunc(x1))));
    const bx = Math.max(0, Math.min(this.size - 1, Math.max(Math.trunc(x0), Math.trunc(x1))));
    const ay = Math.max(0, Math.min(this.size - 1, Math.min(Math.trunc(y0), Math.trunc(y1))));
    const by = Math.max(0, Math.min(this.size - 1, Math.max(Math.trunc(y0), Math.trunc(y1))));
    const v = this.normalizeIndex(index);
    const before = this.snapshot();
    let changed = false;
    for (let y = ay; y <= by; y += 1) {
      for (let x = ax; x <= bx; x += 1) {
        const i = y * this.size + x;
        if (this.pixels[i] !== v) { this.pixels[i] = v; changed = true; }
      }
    }
    if (changed) this.pushUndo(before);
    return changed;
  }

  /** 洪水填充(4-邻域,显式栈) */
  floodFill(x: number, y: number, index: number): number {
    if (!this.inBounds(x, y)) return 0;
    const target = this.pixels[y * this.size + x];
    const v = this.normalizeIndex(index);
    if (target === v) return 0;
    const before = this.snapshot();
    const stack: number[] = [y * this.size + x];
    let n = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      if (this.pixels[i] !== target) continue;
      this.pixels[i] = v;
      n += 1;
      const px = i % this.size;
      const py = (i - px) / this.size;
      if (px > 0) stack.push(i - 1);
      if (px < this.size - 1) stack.push(i + 1);
      if (py > 0) stack.push(i - this.size);
      if (py < this.size - 1) stack.push(i + this.size);
    }
    if (n > 0) this.pushUndo(before);
    return n;
  }

  clear(): boolean {
    const before = this.snapshot();
    let changed = false;
    for (let i = 0; i < this.pixels.length; i += 1) {
      if (this.pixels[i] !== TRANSPARENT_INDEX) { this.pixels[i] = TRANSPARENT_INDEX; changed = true; }
    }
    if (changed) this.pushUndo(before);
    return changed;
  }

  /** 水平/垂直镜像/旋转 90°(对称绘制快捷键) */
  transform(op: 'flipX' | 'flipY' | 'rotate90' | 'rotate180'): void {
    const before = this.snapshot();
    const src = this.pixels.slice();
    const n = this.size;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        let sx = x;
        let sy = y;
        if (op === 'flipX') sx = n - 1 - x;
        else if (op === 'flipY') sy = n - 1 - y;
        else if (op === 'rotate90') { sx = y; sy = n - 1 - x; }
        else { sx = n - 1 - x; sy = n - 1 - y; }
        this.pixels[y * n + x] = src[sy * n + sx];
      }
    }
    this.pushUndo(before);
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.pixels = prev;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.pixels = next;
    return true;
  }

  /** 导出 256 个索引的副本 */
  toIndices(): Int8Array {
    return this.pixels.slice();
  }

  /** 导出 WS-06 同构的调色盘字符行(索引 0..3 用 '0'..'3' 会失真,故用 32 进制的两位表达) */
  toRows(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.size; y += 1) {
      let s = '';
      for (let x = 0; x < this.size; x += 1) {
        const v = this.pixels[y * this.size + x];
        s += v < 0 ? '.' : String.fromCharCode(97 + v);
      }
      rows.push(s);
    }
    return rows;
  }

  /** 从字符行载入:'.' 透明,'a'..'`'+31 对应索引 0..31 */
  loadRows(rows: readonly string[]): void {
    const before = this.snapshot();
    for (let y = 0; y < this.size; y += 1) {
      const row = typeof rows[y] === 'string' ? rows[y] : '';
      for (let x = 0; x < this.size; x += 1) {
        const ch = x < row.length ? row[x] : '.';
        let v = TRANSPARENT_INDEX;
        if (ch !== '.' && ch !== ' ') {
          const code = ch.charCodeAt(0) - 97;
          v = code >= 0 && code < PALETTE_SIZE ? code : TRANSPARENT_INDEX;
        }
        this.pixels[y * this.size + x] = v;
      }
    }
    this.pushUndo(before);
  }

  /** 统计:每色像素数 */
  histogram(): number[] {
    const h = new Array(PALETTE_SIZE + 1).fill(0);
    for (let i = 0; i < this.pixels.length; i += 1) {
      const v = this.pixels[i];
      if (v < 0) h[PALETTE_SIZE] += 1;
      else h[v] += 1;
    }
    return h;
  }

  /** 非透明像素占比 */
  coverage(): number {
    let n = 0;
    for (let i = 0; i < this.pixels.length; i += 1) if (this.pixels[i] >= 0) n += 1;
    return n / EASEL_PIXELS;
  }

  /** 序列化为紧凑字符串(存档/联机同步用):32 色调色盘 → base32 字符 */
  serialize(): string {
    const alphabet = '0123456789abcdefghijklmnopqrstuv';
    let s = '';
    for (let i = 0; i < this.pixels.length; i += 1) {
      const v = this.pixels[i];
      s += v < 0 ? 'z' : alphabet[v];
    }
    return s;
  }

  static deserialize(blob: string): PixelEasel {
    const e = new PixelEasel();
    if (typeof blob !== 'string') return e;
    for (let i = 0; i < EASEL_PIXELS; i += 1) {
      const ch = blob[i];
      if (ch === undefined) break;
      if (ch === 'z') { e.pixels[i] = TRANSPARENT_INDEX; continue; }
      const v = '0123456789abcdefghijklmnopqrstuv'.indexOf(ch);
      e.pixels[i] = v >= 0 ? v : TRANSPARENT_INDEX;
    }
    return e;
  }
}

/**
 * 把画架图案铺成 N×M 无缝巨幅地画(314 号地毯多块拼接)。
 *
 * 每一行都**先补齐到 `EASEL_SIZE` 再决定是否镜像**。
 * 原实现的镜像分支直接 `[...src].reverse()`,对短行输入会产出宽度不一致的行
 * (copy 0 宽 16、copy 1 宽 2),拼出的地画错位 —— 同一份输入走不同分支得到不同宽度,
 * 属于必须消除的不对称。行内空白用 `'.'`(透明)填充,与 0 号副本一致。
 *
 * 返回的是「按 `cols` 分行、每行 `copies/cols` 个副本」的二维数组,
 * 每个 `cols` 组之后压入一个空数组作为**分组分隔标记**。
 */
export function tilePattern(rows: readonly string[], cols: number, copies: number): string[][] {
  const out: string[][] = [];
  const c = Math.max(1, Math.trunc(cols));
  for (let copy = 0; copy < Math.max(1, Math.trunc(copies)); copy += 1) {
    const flip = copy % 2 === 1;
    const rowsOfCopy: string[] = [];
    for (let y = 0; y < EASEL_SIZE; y += 1) {
      const src = typeof rows[y] === 'string' ? rows[y] : '';
      /* 先补齐到整行宽度,再镜像 —— 保证任意副本的行宽恒为 EASEL_SIZE */
      const padded = src.padEnd(EASEL_SIZE, '.').slice(0, EASEL_SIZE);
      rowsOfCopy.push(flip ? [...padded].reverse().join('') : padded);
    }
    out.push(rowsOfCopy);
    if ((copy + 1) % c === 0) out.push([]);
  }
  return out;
}

/** 调色盘色名(UI 色板 tooltip) */
export function paletteLabel(index: number): string {
  const i = Math.trunc(index);
  if (i < 0 || i >= PALETTE_SIZE) return `透明`;
  const group = Math.floor(i / 4);
  const level = i % 4;
  const names = ['白', '粉', '橙', '绿', '青', '蓝', '紫', '棕'];
  const levels = ['极浅', '浅', '中', '深'];
  return `${names[group]}·${levels[level]}(${PALETTE_32[i]})`;
}