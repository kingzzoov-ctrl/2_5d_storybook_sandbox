/**
 * WS-09 / 分块几何顶点写出 —— 把「面数统计」变成「真实顶点」。
 *
 * ## 为什么需要这个文件
 *
 * `tile_mesh.buildChunkQuads` **只数面,不产顶点**。早先的
 * `three/stage_assembly.buildChunkGeometry` 拿到 `vertexCount` 后
 * 只 `new Float32Array(vertexCount * 3)` 分配缓冲、**从不写入** ——
 * 于是 position 数组全是 0,地形一个三角形都画不出来。
 *
 * 更糟的是它**长期没被发现**:`tests/WS-09.test.ts`(3226 行)断言的是
 * `vertexCount` 这个**数字**,而数字一直是对的。这是「只报数量不查性质」
 * 的典型 —— 数量对、内容空,门禁全绿。
 *
 * ## 本文件的职责边界
 *
 * - **纯计算**:不 import three、不碰 DOM。产出 `Float32Array`,由装配层塞进引擎。
 * - **与计数共享真相源**:顶点写出与 `buildChunkQuads` 都走
 *   `dominantZGrid` + `neighborZs`,因此「计数」与「实际顶点数」必然一致。
 *   若两者各写一遍取邻逻辑,只要有人改一处就会脱节,而测试只断言计数 ⇒ 漂移不可见。
 *
 * ## 坐标约定(与 `iso_camera.ts` 的 35° 正交投影对齐)
 *
 * 世界坐标直接用「格」单位 `(gx, gy, gz)`:
 * - `gx = cx·CHUNK_SIZE + 块内 x`,格左下角为整数;
 * - `gy` 同理;
 * - `gz = ELEV_TO_Z[elev]` ∈ {-1, 0, 1, 2}。
 *
 * 投影到屏幕由相机负责(见 `iso_camera.projectGridToScreen`),
 * **本文件不投影** —— 这样同一份顶点能被任意相机/引擎复用。
 *
 * ## 四边形顶点顺序(逆时针,右上手系,供背面剔除)
 *
 * 顶面(法线 +Z):
 * ```
 *   2 ── 3      顶点顺序:
 *   │    │        0 = (x,   y,   z)
 *   0 ── 1        1 = (x+1, y,   z)
 *                 2 = (x,   y+1, z)
 *                 3 = (x+1, y+1, z)
 * ```
 * 索引 `[0,1,2, 2,1,3]`(两三角形,与 `assembly_math.quadIndexBuffer` 一致)。
 *
 * 侧面:从块的四邻低处起建,朝向该方向;UV 的 v 轴对应高度,便于贴侧壁纹理。
 */

import {
  CHUNK_SIZE,
  ELEV_TO_Z,
  INDICES_PER_QUAD,
  VERTS_PER_QUAD,
  type ChunkInput,
  type EdgeContext,
  type NeighborZs,
  type QuadBatch,
  dominantZGrid,
  neighborZs,
} from './tile_mesh.ts';

/** 一个 Chunk 的完整几何数据(引擎中立) */
export interface ChunkGeometry {
  /** 顶点位置,每顶点 3 个 float(x, y, z) */
  positions: Float32Array;
  /** 顶点 UV,每顶点 2 个 float(u, v)∈[0,1] */
  uvs: Float32Array;
  /** 顶点法线,每顶点 3 个 float */
  normals: Float32Array;
  /** 索引,每面 6 个 */
  indices: Uint32Array;
  /** 实际顶点数(应等于 batch.vertexCount) */
  vertexCount: number;
  /** 实际面数(应等于 batch.faceCount) */
  faceCount: number;
  /** 与顶点写出同源的计数(供一致性断言) */
  batch: QuadBatch;
}

/** 顶面四个角的本地偏移(逆时针) */
const TOP_CORNERS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * 侧面:给定方向,返回该面的四个角(从地面到顶部)。
 *
 * 每项是 `[dx, dy, dz]`,dz ∈ {0,1} 表示底/顶。
 * 顺序保证逆时针朝向该方向的外侧。
 */
function sideCorners(dir: 'north' | 'south' | 'west' | 'east'): readonly [number, number, number][] {
  switch (dir) {
    /* 北面(y 小的一侧),外法线 -Y */
    case 'north':
      return [
        [0, 0, 0],
        [1, 0, 0],
        [0, 0, 1],
        [1, 0, 1],
      ];
    /* 南面(+Y),外法线 +Y */
    case 'south':
      return [
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 0],
        [1, 1, 1],
      ];
    /* 西面(-X),外法线 -X */
    case 'west':
      return [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
        [0, 1, 1],
      ];
    /* 东面(+X),外法线 +X */
    case 'east':
      return [
        [1, 0, 0],
        [1, 1, 0],
        [1, 0, 1],
        [1, 1, 1],
      ];
    default: {
      const never: never = dir;
      throw new Error(`未知方向: ${String(never)}`);
    }
  }
}

const SIDE_NORMALS: Record<'north' | 'south' | 'west' | 'east', readonly [number, number, number]> = {
  north: [0, -1, 0],
  south: [0, 1, 0],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

const SIDE_DIRS = ['north', 'south', 'west', 'east'] as const;

/**
 * 统计一个 Chunk 在该 LOD 下需要多少顶点/索引。
 *
 * 与 `buildChunkQuads` 的唯一区别:这里**同时**返回 cell 列表,
 * 供 `emitChunkGeometry` 复用,避免再扫一遍。
 */
interface Cell {
  bx: number;
  by: number;
  z: number;
  /** 该块需要生成侧面的方向 */
  sides: ('north' | 'south' | 'west' | 'east')[];
  /** 四邻海拔(与 `buildChunkQuads` 同源,一次算好,不在写出循环里重算) */
  neighbors: NeighborZs;
}

function collectCells(
  chunk: ChunkInput,
  lod: number,
  ctx?: EdgeContext,
): { size: number; merge: number; cells: Cell[] } {
  const { grid, size, merge } = dominantZGrid(chunk, lod);
  const cells: Cell[] = [];
  for (let by = 0; by < size; by += 1) {
    for (let bx = 0; bx < size; bx += 1) {
      const z = grid[by * size + bx]!;
      if (z === Number.NEGATIVE_INFINITY) continue;
      /* 与 buildChunkQuads 走同一个 neighborZs —— 计数与顶点数因此必然一致 */
      const neighbors = neighborZs(grid, size, merge, bx, by, ctx);
      const sides: Cell['sides'] = [];
      if (neighbors.north < z) sides.push('north');
      if (neighbors.south < z) sides.push('south');
      if (neighbors.west < z) sides.push('west');
      if (neighbors.east < z) sides.push('east');
      cells.push({ bx, by, z, sides, neighbors });
    }
  }
  return { size, merge, cells };
}

/**
 * 把一个 Chunk 建成可提交给 GPU 的顶点/UV/法线/索引。
 *
 * **纯函数**:同样输入必得同样输出,可在 node 里直接测试,不需要引擎。
 */
export function emitChunkGeometry(chunk: ChunkInput, lod: number, ctx?: EdgeContext): ChunkGeometry {
  const lodIdx = Math.max(0, Math.min(3, Math.trunc(lod)));
  const { cells, merge } = collectCells(chunk, lod, ctx);

  let faceCount = 0;
  for (const c of cells) faceCount += 1 + c.sides.length;

  const vertexCount = faceCount * VERTS_PER_QUAD;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(faceCount * INDICES_PER_QUAD);

  let vi = 0; /* 顶点游标(以顶点为单位) */
  let fi = 0; /* 面游标 */
  let ii = 0; /* 索引游标 */

  const chunkOriginX = chunk.cx * CHUNK_SIZE;
  const chunkOriginY = chunk.cy * CHUNK_SIZE;

  const pushVertex = (x: number, y: number, z: number, u: number, v: number, nx: number, ny: number, nz: number): void => {
    positions[vi * 3] = x;
    positions[vi * 3 + 1] = y;
    positions[vi * 3 + 2] = z;
    uvs[vi * 2] = u;
    uvs[vi * 2 + 1] = v;
    normals[vi * 3] = nx;
    normals[vi * 3 + 1] = ny;
    normals[vi * 3 + 2] = nz;
    vi += 1;
  };

  const pushQuadIndices = (): void => {
    const b = fi * VERTS_PER_QUAD;
    indices[ii] = b;
    indices[ii + 1] = b + 1;
    indices[ii + 2] = b + 2;
    indices[ii + 3] = b + 2;
    indices[ii + 4] = b + 1;
    indices[ii + 5] = b + 3;
    ii += INDICES_PER_QUAD;
    fi += 1;
  };

  for (const c of cells) {
    /* 该合并块在世界中的左下角(格)。每块占 merge×merge 格。 */
    const cellX = chunkOriginX + c.bx * merge;
    const cellY = chunkOriginY + c.by * merge;
    const z = c.z;
    /* UV:用格坐标对 CHUNK_SIZE 取模,保证相邻块纹理连续 */
    const u0 = (c.bx * merge) / CHUNK_SIZE;
    const v0 = (c.by * merge) / CHUNK_SIZE;
    const du = merge / CHUNK_SIZE;

    /* ── 顶面(法线 +Z)── */
    for (const [dx, dy] of TOP_CORNERS) {
      pushVertex(
        cellX + dx * merge,
        cellY + dy * merge,
        z,
        u0 + dx * du,
        v0 + dy * du,
        0, 0, 1,
      );
    }
    pushQuadIndices();

    /* ── 侧面:仅在邻块更低时生成,高度差 = z - 邻块 z ── */
    for (const dir of SIDE_DIRS) {
      if (!c.sides.includes(dir)) continue;
      const nz = c.neighbors[dir];
      /* 邻块无数据(NaN)时不画(与 buildChunkQuads 的判据一致:NaN < z 为 false 时不会进 sides) */
      if (!Number.isFinite(nz) && nz !== Number.NEGATIVE_INFINITY) continue;
      const bottom = Number.isFinite(nz) ? nz : -1; /* 朝向虚空时,裙边落到最低层 */
      const corners = sideCorners(dir);
      const nrm = SIDE_NORMALS[dir];
      for (let k = 0; k < 4; k += 1) {
        const [dx, dy, dz] = corners[k]!;
        const vy = dz === 0 ? bottom : z;
        pushVertex(
          cellX + dx * merge,
          cellY + dy * merge,
          vy,
          (k % 2 === 0 ? 0 : 1),
          dz,
          nrm[0], nrm[1], nrm[2],
        );
      }
      pushQuadIndices();
    }
  }

  return {
    positions,
    uvs,
    normals,
    indices,
    vertexCount: vi,
    faceCount: fi,
    batch: {
      topQuads: cells.length,
      sideQuads: faceCount - cells.length,
      faceCount,
      vertexCount,
      indexCount: indices.length,
      cellsPerLayer: countLayers(cells.map((c) => c.z)),
    },
  };
}

/** 每层(z = -1..2)参与建面的格数 */
function countLayers(zs: number[]): number[] {
  const out = [0, 0, 0, 0];
  for (const z of zs) {
    const i = ELEV_TO_Z.indexOf(z);
    out[Math.max(0, Math.min(3, i))]! += 1;
  }
  return out;
}

/**
 * 自检:几何是否与计数一致。**这是补上「只报数字不查内容」的那个洞**。
 *
 * 返回 `null` 表示一致;否则返回不一致的描述。
 * 装配层与测试都应调用它 —— 数量对但内容空的情况会在这里被抓住。
 */
export function validateChunkGeometry(g: ChunkGeometry): string | null {
  if (g.vertexCount !== g.batch.vertexCount) {
    return `顶点数不一致:写出 ${g.vertexCount} vs 计数 ${g.batch.vertexCount}`;
  }
  if (g.faceCount !== g.batch.faceCount) {
    return `面数不一致:写出 ${g.faceCount} vs 计数 ${g.batch.faceCount}`;
  }
  if (g.positions.length !== g.vertexCount * 3) {
    return `positions 长度 ${g.positions.length} ≠ 顶点数×3 = ${g.vertexCount * 3}`;
  }
  if (g.indices.length !== g.faceCount * INDICES_PER_QUAD) {
    return `indices 长度 ${g.indices.length} ≠ 面数×6 = ${g.faceCount * INDICES_PER_QUAD}`;
  }
  if (g.vertexCount > 0) {
    let nonZero = 0;
    for (let i = 0; i < g.positions.length; i += 1) {
      if (g.positions[i] !== 0) nonZero += 1;
    }
    if (nonZero === 0) {
      return 'positions 全为 0 —— 顶点被分配但从未写入';
    }
  }
  /* 索引不得越界 */
  for (let i = 0; i < g.indices.length; i += 1) {
    if (g.indices[i]! >= g.vertexCount) {
      return `索引越界:indices[${i}] = ${g.indices[i]} ≥ 顶点数 ${g.vertexCount}`;
    }
  }
  /* 每面 6 索引必须全落在该面的 4 个顶点内 */
  for (let f = 0; f < g.faceCount; f += 1) {
    const base = f * VERTS_PER_QUAD;
    for (let k = 0; k < INDICES_PER_QUAD; k += 1) {
      const v = g.indices[f * INDICES_PER_QUAD + k]!;
      if (v < base || v >= base + VERTS_PER_QUAD) {
        return `第 ${f} 面的索引 ${v} 不在其顶点区间 [${base}, ${base + VERTS_PER_QUAD})`;
      }
    }
  }
  return null;
}