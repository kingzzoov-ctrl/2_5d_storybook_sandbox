/**
 * 建筑实心盒子:把墙 / 门窗 / 屋顶格画成有体积的方块,而不是一格一张平的立牌。
 *
 * 立牌每张都是朝向相机的一张画,几十张并排在同一平面上,就成了「一圈白柱子围着一块红地毯」,
 * 没有侧墙面也没有整块屋面。这里按格生成方块:墙高 `WALL_HEIGHT`,屋顶格再高 `ROOF_EXTRA`,
 * 顶面与侧面各取一个颜色,由 three 的光照分出明暗。
 *
 * 只产出数据(顶点 / 法线 / 颜色 / 索引),不依赖 three,node 里可直接断言。
 * 相邻两格的公共侧面被高度不低于自己的邻格挡住时不生成(块内判定;跨块的接缝保留,多画几张面不影响观感)。
 */

import { CHUNK_SIZE, ELEV_TO_Z, type ChunkInput } from './tile_mesh.ts';
import { unpackTile } from '../../../shared/types/tile.ts';

/** 盒子覆盖的 obj 号段:351..371 墙体与门窗,372..376 屋顶(384 烟囱仍是立牌)。 */
export const BUILDING_OBJ_MIN = 351;
export const BUILDING_OBJ_MAX = 376;
/** 屋顶号段起点。 */
export const ROOF_OBJ_MIN = 372;

/** 墙高(世界单位,一层地形 = 1)。 */
export const WALL_HEIGHT = 1.25;
/** 屋顶格比墙再高多少:屋面要盖过墙顶才像屋顶。 */
export const ROOF_EXTRA = 0.45;

export function isBuildingObj(obj: number): boolean {
  return Number.isInteger(obj) && obj >= BUILDING_OBJ_MIN && obj <= BUILDING_OBJ_MAX;
}

/** 一个 obj 的盒子样式:基色(sRGB 十六进制)。 */
function baseHexOf(obj: number): number {
  switch (obj) {
    case 351: return 0xa9744a;   /* 暖松原木 */
    case 352: return 0xb5533c;   /* 红砖 */
    case 353: return 0xefe3c8;   /* 奶油灰泥 */
    case 354: return 0xc9b27a;   /* 竹 */
    case 363: return 0x6b4423;   /* 门 */
    case 370: return 0x9fd0ee;   /* 窗 */
    case 372: return 0xc8452f;   /* 红陶瓦 */
    case 373: return 0xd6b25a;   /* 茅草 */
    case 374: return 0x3f78c4;   /* 蓝尖顶 */
    case 375:
    case 376: return 0x8a8a98;
    default: return 0xd8c9a8;
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex: number, mul: number): [number, number, number] {
  const f = (v: number): number => srgbToLinear(Math.min(1, (v / 255) * mul));
  return [f((hex >> 16) & 0xff), f((hex >> 8) & 0xff), f(hex & 0xff)];
}

export interface BuildingBoxes {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  faceCount: number;
}

const EMPTY: BuildingBoxes = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  faceCount: 0,
};

/** 某格盒子的顶面绝对高度(地形层高 + 盒高);该格没有盒子 ⇒ `-Infinity`。 */
function topOf(tiles: ArrayLike<number>, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE) return Number.NEGATIVE_INFINITY;
  const f = unpackTile(tiles[y * CHUNK_SIZE + x] ?? 0);
  if (!isBuildingObj(f.obj)) return Number.NEGATIVE_INFINITY;
  const z = ELEV_TO_Z[f.elev] ?? 0;
  return z + WALL_HEIGHT + (f.obj >= ROOF_OBJ_MIN ? ROOF_EXTRA : 0);
}

/** 一块地形里所有墙 / 屋顶格的盒子。没有建筑格 ⇒ 空结果。不抛:`tiles` 不足 256 格按空气。 */
export function planBuildingBoxes(chunk: ChunkInput): BuildingBoxes {
  const tops: number[] = new Array<number>(CHUNK_SIZE * CHUNK_SIZE);
  let cells = 0;
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const t = topOf(chunk.tiles, x, y);
      tops[y * CHUNK_SIZE + x] = t;
      if (t !== Number.NEGATIVE_INFINITY) cells += 1;
    }
  }
  if (cells === 0) return EMPTY;

  const at = (x: number, y: number): number =>
    (x < 0 || y < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE ? Number.NEGATIVE_INFINITY : tops[y * CHUNK_SIZE + x]!);

  /* 每格最多 5 面:顶 + 四侧。先按上界分配,最后截断到实际面数。 */
  const maxFaces = cells * 5;
  const positions = new Float32Array(maxFaces * 4 * 3);
  const normals = new Float32Array(maxFaces * 4 * 3);
  const colors = new Float32Array(maxFaces * 4 * 3);
  const indices = new Uint32Array(maxFaces * 6);
  let faces = 0;

  const quad = (
    v: readonly [number, number, number][],
    n: readonly [number, number, number],
    c: readonly [number, number, number],
  ): void => {
    const base = faces * 4;
    for (let k = 0; k < 4; k += 1) {
      const o = (base + k) * 3;
      positions[o] = v[k]![0]; positions[o + 1] = v[k]![1]; positions[o + 2] = v[k]![2];
      normals[o] = n[0]; normals[o + 1] = n[1]; normals[o + 2] = n[2];
      colors[o] = c[0]; colors[o + 1] = c[1]; colors[o + 2] = c[2];
    }
    const i = faces * 6;
    indices[i] = base; indices[i + 1] = base + 1; indices[i + 2] = base + 2;
    indices[i + 3] = base; indices[i + 4] = base + 2; indices[i + 5] = base + 3;
    faces += 1;
  };

  const ox = chunk.cx * CHUNK_SIZE;
  const oy = chunk.cy * CHUNK_SIZE;
  for (let by = 0; by < CHUNK_SIZE; by += 1) {
    for (let bx = 0; bx < CHUNK_SIZE; bx += 1) {
      const top = at(bx, by);
      if (top === Number.NEGATIVE_INFINITY) continue;
      const f = unpackTile(chunk.tiles[by * CHUNK_SIZE + bx] ?? 0);
      const z0 = ELEV_TO_Z[f.elev] ?? 0;
      const hex = baseHexOf(f.obj);
      const cTop = rgbOf(hex, 1.12);
      const cSide = rgbOf(hex, 0.92);
      const x0 = ox + bx;
      const y0 = oy + by;
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      quad([[x0, y0, top], [x1, y0, top], [x1, y1, top], [x0, y1, top]], [0, 0, 1], cTop);
      if (at(bx, by - 1) < top) {
        quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, top], [x0, y0, top]], [0, -1, 0], cSide);
      }
      if (at(bx, by + 1) < top) {
        quad([[x1, y1, z0], [x0, y1, z0], [x0, y1, top], [x1, y1, top]], [0, 1, 0], cSide);
      }
      if (at(bx - 1, by) < top) {
        quad([[x0, y1, z0], [x0, y0, z0], [x0, y0, top], [x0, y1, top]], [-1, 0, 0], cSide);
      }
      if (at(bx + 1, by) < top) {
        quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, top], [x1, y0, top]], [1, 0, 0], cSide);
      }
    }
  }

  return {
    positions: positions.slice(0, faces * 12),
    normals: normals.slice(0, faces * 12),
    colors: colors.slice(0, faces * 12),
    indices: indices.slice(0, faces * 6),
    faceCount: faces,
  };
}
