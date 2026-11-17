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

/**
 * 地表铺装层 Bits 6..11:32 位单元格内**仍是 6 位**。
 * u16 地砖 ID 见文件末尾的「宽单元」API(`packTileWide`),裁决 2026-11-17 · D-19。
 */
export const FLOOR_SHIFT = 6;
export const FLOOR_MASK = 0x00000fc0;

/** 四色暗线层 Bits 12..15:R,B,Y,G */
export const WIRE_SHIFT = 12;
export const WIRE_MASK = 0x0000f000;

/**
 * 主体方块/家具/机关 ID Bits 16..27,0 表示空。
 * 32 位单元格内是 12 位;u16 物品 ID 见「宽单元」API(`packTileWide`)。
 */
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

/* ═════════════ 冻结层解锁(owner 2026-11-17 · D-19)═════════════
 *
 * 授权来源:`docs/RULINGS-DRAFT.md` 4.1 U10(地砖 >64 ⇒ 扩 u16)、
 *          4.4 EXTENDING U3(12 位 vs U16 双 ID ⇒ 统一 U16)。
 *
 * ## 为什么不是把 32 位单元格重新切片
 *
 * 把 FLOOR 从 6 位改成 16 位、OBJ 从 12 位改成 16 位,加起来要 42 位 ——
 * 一个 32 位字装不下,而且会同时改掉 `CHUNK_BYTES = 1024`(存档体积 ×1.75)与
 * `FLOOR_MASK` / `OBJ_MASK` 的既有取值(WS-01 存档、WS-07 网络、WS-09 渲染
 * 都按旧位宽写死)。所以本层**不动 32 位字的语义**,而是新增「宽单元」:
 *
 *     TileCellWide = { lo: 32 位旧字, hi: 14 位高位字 }
 *     hi 布局:bits 0..9  = floor >>> 6  (补足 floor 的 u16 高 10 位)
 *             bits 10..13 = obj   >>> 12 (补足 obj 的 u16 高 4 位)
 *
 * 于是 `lo` 里 floor ≤ 63 且 obj ≤ 4095 的单元,宽单元高位字恒为 0 ——
 * 旧数据/旧蓝图码**逐字节不变**(蓝图码用 `wideCellValue()` 作 varint 值)。
 */

/** 地砖 ID 位宽(u16,裁决 D-19)。 */
export const FLOOR_ID_BITS = 16;
/** 地砖 ID 上限掩码(65535;0 仍表示无铺装)。 */
export const FLOOR_ID_MASK = 0xffff;
/** 物体/物品 ID 位宽(u16,与 `shared/types/wire.ts` 的 `heldItemId: u16` 对齐)。 */
export const OBJ_ID_BITS = 16;
/** 物体/物品 ID 上限掩码(65535;0 仍表示空格)。 */
export const OBJ_ID_MASK = 0xffff;

/** 32 位字里 FLOOR 层实际位宽(既有,不得改)。 */
export const FLOOR_WORD_BITS = 6;
/** 32 位字里 FLOOR 层掩码。 */
export const FLOOR_WORD_MASK = 0x3f;
/** 32 位字里 OBJ 层实际位宽(既有,不得改)。 */
export const OBJ_WORD_BITS = 12;
/** 32 位字里 OBJ 层掩码。 */
export const OBJ_WORD_MASK = 0xfff;

/** 宽单元高位字里 FLOOR 占的位数 = 16 − 6 = 10。 */
export const FLOOR_HI_BITS = FLOOR_ID_BITS - FLOOR_WORD_BITS;
/** 宽单元高位字里 OBJ 占的位数 = 16 − 12 = 4。 */
export const OBJ_HI_BITS = OBJ_ID_BITS - OBJ_WORD_BITS;
/** 高位字总位数 = 14。 */
export const WIDE_HI_BITS = FLOOR_HI_BITS + OBJ_HI_BITS;
/** 高位字全 1 掩码(0x3fff)。 */
export const WIDE_HI_MASK = 0x3fff;
/** 2^32:`lo` 与 `hi` 合成单个数值时的进位基数。 */
export const WIDE_VALUE_SCALE = 0x100000000;

/** 宽单元:低 32 位沿用旧位宽,高 14 位补足 u16。 */
export interface TileCellWide {
  lo: number;
  hi: number;
}

/**
 * `TileFields` → 宽单元。`floor`/`obj` 超出 u16 时按 u16 截断
 * (与 `packTile` 的截断语义一致,不抛错 —— 高频路径不能因一个坏 ID 断帧)。
 */
export function packTileWide(f: TileFields): TileCellWide {
  const lo = packTile({ ...f, floor: f.floor & FLOOR_WORD_MASK, obj: f.obj & OBJ_WORD_MASK });
  const floorHi = (Math.trunc(f.floor) >>> FLOOR_WORD_BITS) & 0x3ff;
  const objHi = (Math.trunc(f.obj) >>> OBJ_WORD_BITS) & 0x0f;
  return { lo, hi: (floorHi | (objHi << FLOOR_HI_BITS)) >>> 0 };
}

/** 宽单元 → `TileFields`(u16 地砖 + u16 物体 ID 完整还原)。 */
export function unpackTileWide(c: TileCellWide): TileFields {
  const f = unpackTile(c.lo >>> 0);
  const hi = c.hi >>> 0;
  f.floor = (f.floor & FLOOR_WORD_MASK) | ((hi & 0x3ff) << FLOOR_WORD_BITS);
  f.obj = (f.obj & OBJ_WORD_MASK) | (((hi >>> FLOOR_HI_BITS) & 0x0f) << OBJ_WORD_BITS);
  return f;
}

/**
 * `TileFields` → 单个数值(lo + hi × 2^32,最大 46 位)。
 *
 * 用途:蓝图的 RLE 游程值。floor ≤ 63 且 obj ≤ 4095 时**等于旧的
 * `packTile(...)` 结果**,因此旧蓝图码保持可解码。
 */
export function wideCellValue(f: TileFields): number {
  const c = packTileWide(f);
  return c.lo + c.hi * WIDE_VALUE_SCALE;
}

/** 单个数值 → `TileFields`(与 `wideCellValue` 互为逆运算)。 */
export function fieldsFromWideValue(v: number): TileFields {
  if (!Number.isFinite(v) || v < 0 || Math.trunc(v) !== v) {
    throw new Error(`非法宽单元值:${v}(应为 [0, 2^46) 内的整数)`);
  }
  const hi = Math.floor(v / WIDE_VALUE_SCALE);
  if (hi > WIDE_HI_MASK) throw new Error(`宽单元高位字越界:${hi} > ${WIDE_HI_MASK}`);
  return unpackTileWide({ lo: v - hi * WIDE_VALUE_SCALE, hi });
}

/** 地砖 ID 是否落在 u16 范围内(0 = 无铺装也算合法)。 */
export function isValidFloorId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id <= FLOOR_ID_MASK;
}

/** 物体/物品 ID 是否落在 u16 范围内(0 = 空格也算合法)。 */
export function isValidObjId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id <= OBJ_ID_MASK;
}
