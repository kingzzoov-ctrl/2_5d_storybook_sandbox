/**
 * 32-Bit 单元格位压缩契约(冻结层,任何工作流不得修改本文件签名)。
 * 对应设计手册 §2.3。
 *
 * 语法约定:本仓库禁止 `enum` / `const enum`(Node 原生类型擦除不支持),
 * 一律使用 `as const` 对象 + 联合类型。
 */

/** 海拔层 Bits 0..1:0=Z-1 深沟,1=Z0 平原,2=Z1,3=Z2 */
export const ELEV_SHIFT = 0;
export const ELEV_MASK = 0x00000003;

/** 基底与流体层 Bits 2..5 */
export const BASE_SHIFT = 2;
export const BASE_MASK = 0x0000003c;

/** 地表铺装层 Bits 6..11:64 种地砖 */
export const FLOOR_SHIFT = 6;
export const FLOOR_MASK = 0x00000fc0;

/** 四色暗线层 Bits 12..15:R,B,Y,G */
export const WIRE_SHIFT = 12;
export const WIRE_MASK = 0x0000f000;

/** 主体方块/家具/机关 ID Bits 16..27,0 表示空 */
export const OBJ_SHIFT = 16;
export const OBJ_MASK = 0x0fff0000;
export const OBJ_EMPTY = 0;

/** 朝向与运行态 Bits 28..31 */
export const META_SHIFT = 28;
export const META_MASK = 0xf0000000;

export const Elevation = { DEEP: 0, GROUND: 1, PLATFORM: 2, CLIFF: 3 } as const;
export type Elevation = (typeof Elevation)[keyof typeof Elevation];

export const BaseFluid = {
  VOID: 0, GRASS: 1, DIRT: 2, GOLD_SAND: 3, ROCK: 4,
  SHALLOW_WATER: 5, HOT_SPRING: 6, SLIME: 7, LAVA: 8, CHOCO: 9,
} as const;
export type BaseFluid = (typeof BaseFluid)[keyof typeof BaseFluid];

export const WireColor = { RED: 0, BLUE: 1, YELLOW: 2, GREEN: 3 } as const;
export type WireColor = (typeof WireColor)[keyof typeof WireColor];

export const CHUNK_SIZE = 16;
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_BYTES = CHUNK_CELLS * 4;

export interface TileFields {
  elev: number;
  base: number;
  floor: number;
  wire: number;
  obj: number;
  meta: number;
}

export function packTile(f: TileFields): number {
  return (
    (((f.elev & 0x3) << ELEV_SHIFT) |
      ((f.base & 0xf) << BASE_SHIFT) |
      ((f.floor & 0x3f) << FLOOR_SHIFT) |
      ((f.wire & 0xf) << WIRE_SHIFT) |
      ((f.obj & 0xfff) << OBJ_SHIFT) |
      ((f.meta & 0xf) << META_SHIFT)) >>>
    0
  );
}

export function unpackTile(v: number): TileFields {
  return {
    elev: (v & ELEV_MASK) >>> ELEV_SHIFT,
    base: (v & BASE_MASK) >>> BASE_SHIFT,
    floor: (v & FLOOR_MASK) >>> FLOOR_SHIFT,
    wire: (v & WIRE_MASK) >>> WIRE_SHIFT,
    obj: (v & OBJ_MASK) >>> OBJ_SHIFT,
    meta: (v & META_MASK) >>> META_SHIFT,
  };
}

export function withField(v: number, field: keyof TileFields, value: number): number {
  const f = unpackTile(v);
  f[field] = value;
  return packTile(f);
}

export const WIRE_BIT: Record<number, number> = { 0: 1, 1: 2, 2: 4, 3: 8 };

export function hasWire(v: number, c: WireColor): boolean {
  return (unpackTile(v).wire & WIRE_BIT[c]) !== 0;
}

export function setWire(v: number, c: WireColor, on: boolean): number {
  const f = unpackTile(v);
  f.wire = on ? f.wire | WIRE_BIT[c] : f.wire & ~WIRE_BIT[c];
  return packTile(f);
}

/** 运行态低 2 位:0=断电/关闭,1=通电/开启,2..3 留给门与闸的中间态 */
export function metaState(v: number): number {
  return unpackTile(v).meta & 0x3;
}

/** 朝向高 2 位:0=北 1=东 2=南 3=西 */
export function faceDir(v: number): number {
  return (unpackTile(v).meta >> 2) & 0x3;
}
