/**
 * WS-09 / 四层海拔分块建面 + 视锥剔除 + LOD —— 纯数学层(不 import three)。
 *
 * 数据来源:`shared/types/tile.ts` 的 32-bit 单元格位压缩。
 *  - `Elevation.DEEP/GROUND/PLATFORM/CLIFF`(0/1/2/3)映射到世界海拔 z = −1/0/1/2;
 *  - 每格最多渲染「顶面 1 + 四向侧面 4 = 5 面」,称为 5 面堆叠网格;
 *  - 一个 16×16 Chunk = 256 格,满载 1280 面(LOD0 最坏)。
 *
 * 面数才是本子系统的生死线:1024×1024 世界 LOD0 最坏 5,242,880 面,
 * 单帧提交量直接爆炸。降级策略分三层(详见 docs/WS-09-client-render.md §4):
 *   ① 高度主导合并(greedy meshing):同海拔连续格合成 1 个 quad;
 *   ② 距离 LOD:1×1 / 2×2 / 4×4 / 8×8 四档,面数按 mergeFactor 平方反比下降;
 *   ③ 视锥剔除:只提交落在相机世界 AABB 内的 Chunk。
 * 三层叠加后 1024×1024 全图 LOD2 = 327,680 面 < 800,000 预算。
 */

import {
  CHUNK_CELLS,
  CHUNK_SIZE,
  Elevation,
  unpackTile,
} from '../../../shared/types/tile.ts';

export { CHUNK_CELLS, CHUNK_SIZE };

/* ───────────────────────────── 参数配表 ───────────────────────────── */

/** 四个海拔层的世界 z:Elevation 0..3 → z −1..2 */
export const ELEV_TO_Z: readonly number[] = [-1, 0, 1, 2];

/** 每格最大面数:顶面 + 北/东/南/西 四个侧面 */
export const FACES_PER_CELL_MAX = 5;

/** LOD 档位数 */
export const LOD_COUNT = 4;

/** 各档合并边长(格):1×1 / 2×2 / 4×4 / 8×8 */
export const LOD_MERGE_SIZE: readonly number[] = [1, 2, 4, 8];

/** 各档合并因数(格数/quad),= mergeSize² */
export const LOD_MERGE_FACTOR: readonly number[] = LOD_MERGE_SIZE.map((s) => s * s);

/** 各档生效的最大相机距离(格),超出则用更粗的档 */
export const LOD_MAX_DIST_CELLS: readonly number[] = [24, 48, 96, Number.POSITIVE_INFINITY];

/** 面数硬预算 */
export const FACE_BUDGET = 800000;

/** 世界边长(格),1024×1024 = 1,048,576 格 */
export const WORLD_SIZE_CELLS = 1024;

/** 每个 quad 的顶点数 / 索引数 */
export const VERTS_PER_QUAD = 4;
export const INDICES_PER_QUAD = 6;

/** 世界海拔 z → Elevation 枚举值 */
export function zToElev(z: number): number {
  const i = ELEV_TO_Z.indexOf(Math.round(z));
  return i < 0 ? Elevation.GROUND : i;
}

/* ───────────────────────────── 数据结构 ───────────────────────────── */

/** 一个 Chunk 的建面输入:16×16 的 32-bit 单元 */
export interface ChunkInput {
  key: string;
  cx: number;
  cy: number;
  tiles: ArrayLike<number>;
}

/** 邻接信息:四个方向的 16 个边缘单元(缺失视为空气) */
export interface EdgeContext {
  north?: ArrayLike<number> | null;
  east?: ArrayLike<number> | null;
  south?: ArrayLike<number> | null;
  west?: ArrayLike<number> | null;
}

export interface QuadBatch {
  /** 顶面 quad 数 */
  topQuads: number;
  /** 侧面 quad 数 */
  sideQuads: number;
  faceCount: number;
  vertexCount: number;
  indexCount: number;
  /** 每层(z = −1..2)参与建面的格数,便于 UI 调试 */
  cellsPerLayer: number[];
}

export interface ChunkBounds {
  key: string;
  cx: number;
  cy: number;
  minZ: number;
  maxZ: number;
}

export interface FrustumCullResult {
  /** 可见 Chunk 的**完整输入**(含 tiles),可直接喂给 `frameFaceCount` */
  visible: ChunkInput[];
  culled: ChunkInput[];
  /** 命中率 0..1 */
  ratio: number;
}

/* ───────────────────────────── 建面算法 ───────────────────────────── */

function tileZ(tile: number): number {
  const u = unpackTile(tile);
  if (u.obj === 0 && u.floor === 0 && u.base === 0) return Number.NEGATIVE_INFINITY;
  const z = ELEV_TO_Z[u.elev & 0x3];
  return z === undefined ? 0 : z;
}

/**
 * 把 256 格的 z 提到「合并块」粒度:每块取块内最高的非空 z。
 * 复杂度 O(cells)。
 */
export function dominantZGrid(chunk: ChunkInput, lod: number): { grid: Float64Array; size: number; merge: number } {
  const lodIdx = Math.max(0, Math.min(LOD_COUNT - 1, Math.trunc(lod)));
  const merge = LOD_MERGE_SIZE[lodIdx];
  const size = Math.ceil(CHUNK_SIZE / merge);
  const grid = new Float64Array(size * size).fill(Number.NEGATIVE_INFINITY);
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const z = tileZ(chunk.tiles[y * CHUNK_SIZE + x] ?? 0);
      if (z === Number.NEGATIVE_INFINITY) continue;
      const bx = Math.floor(x / merge);
      const by = Math.floor(y / merge);
      const i = by * size + bx;
      if (z > grid[i]) grid[i] = z;
    }
  }
  return { grid, size, merge };
}

/**
 * 取相邻 Chunk 在某一列/行上的最高海拔。
 *
 * **无邻接数据时返回 NaN**,比较 `NaN < z` 恒为 false ⇒ 不生成侧面。
 * 这是刻意的「无数据不画」策略:没有邻块信息时宁可不画边界侧面,
 * 也不要凭空生成一圈虚假的裙边(会让区块边缘看起来多出一层台阶)。
 * 需要跨区块无缝时由上层传入 `EdgeContext`。
 */
function edgeZ(
  ctx: EdgeContext | undefined,
  dir: 'north' | 'east' | 'south' | 'west',
  index: number,
  merge: number,
): number {
  const arr = ctx ? ctx[dir] : undefined;
  if (!arr) return Number.NaN;
  let best = Number.NEGATIVE_INFINITY;
  const base = index * merge;
  for (let k = 0; k < merge && base + k < CHUNK_SIZE; k += 1) {
    const z = tileZ(arr[base + k] ?? 0);
    if (z > best) best = z;
  }
  /* 邻接列全为空气时返回 NEGATIVE_INFINITY,此时应生成侧面(朝向虚空的高差) */
  return best;
}

/** 一个合并块的四邻海拔(北 = y−1,南 = y+1,西 = x−1,东 = x+1) */
export interface NeighborZs {
  north: number;
  south: number;
  west: number;
  east: number;
}

/**
 * 取某个合并块四邻的最高海拔。
 *
 * **单一真相源**:建面计数(`buildChunkQuads`)与顶点写出(`chunk_geometry.emitChunkGeometry`)
 * 都必须走这个函数。早先两处各写一遍同样的取邻逻辑,一旦有人只改一处,
 * 计数就会与真实顶点数脱节 —— 而测试只断言计数,于是漂移永远不可见。
 *
 * 区块边缘无邻接数据时由 `edgeZ` 返回 NaN,`NaN < z` 恒为 false ⇒ 不生成侧面。
 */
export function neighborZs(
  grid: Float64Array,
  size: number,
  merge: number,
  bx: number,
  by: number,
  ctx?: EdgeContext,
): NeighborZs {
  return {
    north: by > 0 ? grid[(by - 1) * size + bx] : edgeZ(ctx, 'north', bx, merge),
    south: by < size - 1 ? grid[(by + 1) * size + bx] : edgeZ(ctx, 'south', bx, merge),
    west: bx > 0 ? grid[by * size + (bx - 1)] : edgeZ(ctx, 'west', by, merge),
    east: bx < size - 1 ? grid[by * size + (bx + 1)] : edgeZ(ctx, 'east', by, merge),
  };
}

/**
 * 分块建面:greedy meshing。
 *  - 顶面:每个非空合并块 1 个 quad;
 *  - 侧面:块的四邻若海拔不等(或邻块为空)则 1 个 quad,四邻最多 4 个。
 * 复杂度 O(cells)(阶数不随 LOD 变化,只是 size 变小)。
 *
 * ⚠️ 本函数**只计数,不产出顶点**。真实顶点/UV/索引由 `chunk_geometry.emitChunkGeometry` 生成,
 * 两者共享 `dominantZGrid` 与 `neighborZs`,因此计数与几何必然一致。
 */
export function buildChunkQuads(chunk: ChunkInput, lod: number, ctx?: EdgeContext): QuadBatch {
  const { grid, size, merge } = dominantZGrid(chunk, lod);
  const cellsPerLayer = [0, 0, 0, 0];
  let topQuads = 0;
  let sideQuads = 0;

  for (let by = 0; by < size; by += 1) {
    for (let bx = 0; bx < size; bx += 1) {
      const z = grid[by * size + bx];
      if (z === Number.NEGATIVE_INFINITY) continue;
      topQuads += 1;
      const layer = Math.max(0, Math.min(3, ELEV_TO_Z.indexOf(z)));
      cellsPerLayer[layer] += 1;

      const nb = neighborZs(grid, size, merge, bx, by, ctx);
      if (nb.north < z) sideQuads += 1;
      if (nb.east < z) sideQuads += 1;
      if (nb.south < z) sideQuads += 1;
      if (nb.west < z) sideQuads += 1;
    }
  }

  const faceCount = topQuads + sideQuads;
  return {
    topQuads,
    sideQuads,
    faceCount,
    vertexCount: faceCount * VERTS_PER_QUAD,
    indexCount: faceCount * INDICES_PER_QUAD,
    cellsPerLayer,
  };
}

export function chunkBounds(chunk: ChunkInput): ChunkBounds {
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    const z = tileZ(chunk.tiles[i] ?? 0);
    if (z === Number.NEGATIVE_INFINITY) continue;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (minZ === Number.POSITIVE_INFINITY) {
    minZ = 0;
    maxZ = 0;
  }
  return { key: chunk.key, cx: chunk.cx, cy: chunk.cy, minZ, maxZ };
}

/* ───────────────────────────── 视锥剔除 ───────────────────────────── */

export interface CullBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * 视锥剔除:Chunk 的世界 AABB 与相机地面 AABB 求交。
 *
 * 区间约定:格坐标用**闭区间** `[minX, maxX]` 表示可见格,
 * 而 Chunk 覆盖的是**半开区间** `[x0, x0+16)`。因此求交必须写成
 * `x0 <= maxX && x1 > minX`(注意 `>` 而不是 `>=`)。
 * 若误写 `x1 >= minX`,刚好贴边的相邻 Chunk 会被多算一个,
 * 表现为视口边缘多渲染一列/一行看不见的区块。
 *
 * **返回值契约**:`visible` / `culled` 必须保留**完整的 `ChunkInput`**,
 * 而不只是它的几何边界。下游 `frameFaceCount(visible, lodFor)` 直接消费
 * 这个数组建面 —— 若只返回 `{key,cx,cy,minZ,maxZ}` 这类边界摘要,
 * 下游会拿到没有 `tiles` 的对象,在 `dominantZGrid` 里炸成
 * `Cannot read properties of undefined`。这个缺陷曾长期存在:
 * 单测只断言 `visible.length`,不把它喂给建面函数,所以从不报错。
 * 需要边界摘要的调用方请读 `boundsOf(key)` 或自行 `chunkBounds()`。
 *
 * 复杂度 O(chunks),求交 O(1)。
 */
export function frustumCull(chunks: readonly ChunkInput[], cameraBounds: CullBox): FrustumCullResult {
  const visible: ChunkInput[] = [];
  const culled: ChunkInput[] = [];
  for (const c of chunks) {
    const x0 = c.cx * CHUNK_SIZE;
    const y0 = c.cy * CHUNK_SIZE;
    const x1 = x0 + CHUNK_SIZE;
    const y1 = y0 + CHUNK_SIZE;
    const hit = x0 <= cameraBounds.maxX && x1 > cameraBounds.minX
      && y0 <= cameraBounds.maxY && y1 > cameraBounds.minY;
    if (hit) visible.push(c);
    else culled.push(c);
  }
  const total = chunks.length;
  return { visible, culled, ratio: total === 0 ? 0 : visible.length / total };
}

/** 单位变换:把 `iso_camera.ViewBounds` 适配到 CullBox(min/max 同名) */
export function boundsForCam(v: { minX: number; maxX: number; minY: number; maxY: number }): CullBox {
  return { minX: v.minX, maxX: v.maxX, minY: v.minY, maxY: v.maxY };
}

/* ───────────────────────────── LOD 选择 ───────────────────────────── */

/**
 * 按相机距离(格)选 LOD 档位。
 * dist ≤ 24 → 0;≤ 48 → 1;≤ 96 → 2;否则 3。
 */
export function selectLod(cameraDistance: number): number {
  const d = Number.isFinite(cameraDistance) ? Math.abs(cameraDistance) : Number.POSITIVE_INFINITY;
  for (let i = 0; i < LOD_MAX_DIST_CELLS.length; i += 1) {
    if (d <= LOD_MAX_DIST_CELLS[i]) return i;
  }
  return LOD_COUNT - 1;
}

/** 压缩相邻档位跳变,避免 LOD 抖动(pop) */
export function smoothLod(prevLod: number, targetLod: number, hysteresis = 1): number {
  const p = Math.max(0, Math.min(LOD_COUNT - 1, Math.trunc(prevLod)));
  const t = Math.max(0, Math.min(LOD_COUNT - 1, Math.trunc(targetLod)));
  if (t > p) return Math.min(t, p + Math.max(0, Math.trunc(hysteresis)));
  if (t < p) return Math.max(t, p - Math.max(0, Math.trunc(hysteresis)));
  return p;
}

/** Chunk 中心到相机的水平距离(格) */
export function chunkDistance(cx: number, cy: number, camX: number, camY: number): number {
  return Math.hypot(cx * CHUNK_SIZE + CHUNK_SIZE / 2 - camX, cy * CHUNK_SIZE + CHUNK_SIZE / 2 - camY);
}

/* ───────────────────────────── 面数估算 ───────────────────────────── */

/**
 * 面数估算(greedy meshing 的最坏上界,不依赖具体地形):
 *
 *   patches = ceil(world/mergeSize)²        // 合并块总数
 *   top     = patches                       // 每块 1 个顶面
 *   side    = patches × 4                   // 每块四面各最多 1 个侧面
 *   faces   = top + side = patches × 5
 *
 * LOD0(merge=1)退化为「每格 5 面」,与 FACES_PER_CELL_MAX 一致,可交叉验算。
 * 复杂度 O(1)。
 */
export function estimateFaceCount(worldSize: number, lod: number): number {
  const w = Math.max(1, Math.floor(worldSize));
  const lodIdx = Math.max(0, Math.min(LOD_COUNT - 1, Math.trunc(lod)));
  const merge = LOD_MERGE_SIZE[lodIdx];
  const patches = Math.ceil(w / merge) ** 2;
  return patches * FACES_PER_CELL_MAX;
}

/** 同上,但拆开返回顶面/侧面 */
export function estimateFaceBreakdown(worldSize: number, lod: number): { topQuads: number; sideQuads: number; faceCount: number } {
  const w = Math.max(1, Math.floor(worldSize));
  const lodIdx = Math.max(0, Math.min(LOD_COUNT - 1, Math.trunc(lod)));
  const patches = Math.ceil(w / LOD_MERGE_SIZE[lodIdx]) ** 2;
  return { topQuads: patches, sideQuads: patches * 4, faceCount: patches * FACES_PER_CELL_MAX };
}

/** 未做任何降级的理论最坏面数:每格 5 面 */
export function rawWorstFaceCount(worldSize: number): number {
  return Math.max(1, Math.floor(worldSize)) ** 2 * FACES_PER_CELL_MAX;
}

/** 全图 LOD 面数是否在预算内 */
export function withinBudget(worldSize: number, lod: number, budget = FACE_BUDGET): boolean {
  return estimateFaceCount(worldSize, lod) < budget;
}

/** 满足预算的最粗档位起点(LOD0 → 3 依次试) */
export function cheapestLodWithinBudget(worldSize: number, budget = FACE_BUDGET): number {
  for (let i = 0; i < LOD_COUNT; i += 1) {
    if (withinBudget(worldSize, i, budget)) return i;
  }
  return LOD_COUNT - 1;
}

/**
 * 单帧真实提交面数 = Σ(可见 Chunk 的 buildChunkQuads)。
 * 复杂度 O(可见 Chunk × 256)。
 */
export function frameFaceCount(
  visible: readonly ChunkInput[],
  lodFor: (chunk: ChunkInput) => number,
): { faces: number; topQuads: number; sideQuads: number; vertices: number } {
  let faces = 0;
  let top = 0;
  let side = 0;
  for (const c of visible) {
    const b = buildChunkQuads(c, lodFor(c));
    faces += b.faceCount;
    top += b.topQuads;
    side += b.sideQuads;
  }
  return { faces, topQuads: top, sideQuads: side, vertices: faces * VERTS_PER_QUAD };
}

/** 空 Chunk(全 0)建面应为 0 面 —— 供边界用例 */
export function emptyChunk(key: string, cx: number, cy: number): ChunkInput {
  return { key, cx, cy, tiles: new Uint32Array(CHUNK_CELLS) };
}
