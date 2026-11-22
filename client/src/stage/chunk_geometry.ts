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
 * - **顶点色的材质口径**(WS-FND-180):顶面按格子的 `base` + `floor` 着色
 *   (`terrain_vcolor.topColorOf`:铺装 > 地表 > 海拔层兜底),侧面按海拔层(`faceColor`)。
 *   材质只取合并块的**主导格**(`dominantMaterialGrid`),与块 z 的挑格口径逐字相同;
 *   LOD0 时主导格 = 该格自己,逐格精确。
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

import { unpackTile } from '../../../shared/types/tile.ts';

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
  tileZ,
} from './tile_mesh.ts';
import {
  TERRAIN_COLOR_COMPONENTS,
  elevLayerOfZ,
  faceColor,
  topColorOf,
  validateVertexColors,
  writeVertexColor,
} from './terrain_vcolor.ts';

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
  /**
   * 顶点色,每顶点 `TERRAIN_COLOR_COMPONENTS`(=3)个 float,r/g/b ∈ [0,1]。
   *
   * ★ WS-09 U2:渲染走**顶点色**,不挂纹理图集。长度恒等于 `顶点数 × 3`,
   *   由 `terrain_vcolor.validateVertexColors` 与 `validateChunkGeometry` 双重把守。
   * ★ WS-FND-180 的语义:**顶面** = `topColorOf(层, 主导格 base, 主导格 floor)`
   *   (每个格子的材质不同,因此颜色不同);**侧面** = `faceColor(层, false)`(只按海拔层)。
   *   ⇒ 「顶面全按海拔层着色」这种缺陷**查长度/值域是查不出来的**,必须查取值本身。
   */
  colors: Float32Array;
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
 * 一个 Chunk 在该 LOD 下的**建面单元**(合并块)列表。
 *
 * 与 `buildChunkQuads` 的唯一区别:这里**同时**返回 cell 列表(含顶面材质),
 * 供 `emitChunkGeometry` 复用,避免再扫一遍。
 */
interface Cell {
  bx: number;
  by: number;
  z: number;
  /**
   * 该合并块**主导格**(块内最高非空 z 那一格)的地表材质 —— `base` = `BaseFluid`,
   * `floor` = 铺装槽位。顶面颜色由它们决定(WS-FND-180:`topColorOf`)。
   *
   * 口径与 `dominantZGrid` 的块 z **同一格**(见 `dominantMaterialGrid`);
   * 空块(VOID)记 0 —— 那种块不会进 cells,0 只是防御性默认值。
   */
  base: number;
  floor: number;
  /** 该块需要生成侧面的方向 */
  sides: ('north' | 'south' | 'west' | 'east')[];
  /** 四邻海拔(与 `buildChunkQuads` 同源,一次算好,不在写出循环里重算) */
  neighbors: NeighborZs;
}

/**
 * 每个合并块的**主导格材质**(`base` / `floor`)。
 *
 * ## 为什么需要它
 *
 * 顶面颜色由格子的材质决定(WS-FND-180),而 `dominantZGrid` 只回 z、不回材质。
 * 挑格口径必须与它**逐字相同**,否则「块 z 说的是 A 格、颜色却来自 B 格」:
 *   - 同一扫描顺序:**y 外、x 内**(与 `dominantZGrid` 一样);
 *   - 同一比较:**严格 `>`**(并列时**先出现**的那一格胜出);
 *   - 同一非空判定:`tileZ(tile) !== -Infinity`(空格不参与,否则一块里混进一个
 *     空气单元就会被当成「最高格」)。
 *
 * 实现上只扫一遍:第一个满足 `z === grid[i]` 的非空格**就是**主导格 ——
 * 若更早出现过非空格,它的 z 必然 < grid[i](否则它才是最高格)。
 *
 * ⚠️ 这是 LOD>0 时的**近似**:一个合并块里可能混着多种材质,只取主导格那一种
 * (与「块 z 只取最高格」同一条近似口径)。LOD0(merge = 1)时主导格就是这一格,逐格精确。
 */
function dominantMaterialGrid(
  chunk: ChunkInput,
  grid: Float64Array,
  size: number,
  merge: number,
): { base: Int32Array; floor: Int32Array } {
  const base = new Int32Array(size * size);
  const floor = new Int32Array(size * size);
  const picked = new Uint8Array(size * size);
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const tile = chunk.tiles[y * CHUNK_SIZE + x] ?? 0;
      const z = tileZ(tile);
      if (z === Number.NEGATIVE_INFINITY) continue;
      const i = Math.floor(y / merge) * size + Math.floor(x / merge);
      if (picked[i] === 1 || z !== grid[i]) continue;
      picked[i] = 1;
      const u = unpackTile(tile);
      base[i] = u.base;
      floor[i] = u.floor;
    }
  }
  return { base, floor };
}

function collectCells(
  chunk: ChunkInput,
  lod: number,
  ctx?: EdgeContext,
): { size: number; merge: number; cells: Cell[] } {
  const { grid, size, merge } = dominantZGrid(chunk, lod);
  /* 主导格材质与块 z 同源(同一扫描顺序 + 同一严格 >),一次算好给下面每个块取用 */
  const material = dominantMaterialGrid(chunk, grid, size, merge);
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
      const mi = by * size + bx;
      cells.push({ bx, by, z, base: material.base[mi]!, floor: material.floor[mi]!, sides, neighbors });
    }
  }
  return { size, merge, cells };
}

/**
 * 把一个 Chunk 建成可提交给 GPU 的顶点/UV/法线/顶点色/索引。
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
  /**
   * 顶点色(WS-09 U2)。**长度 = 顶点数 × TERRAIN_COLOR_COMPONENTS** ——
   * 这条恒等式是「渲染走顶点色」的可测口径:谁把它写成每面一色或每格一色,
   * 长度立刻对不上,而只断言「数组非空」永远发现不了那种错位。
   */
  const colors = new Float32Array(vertexCount * TERRAIN_COLOR_COMPONENTS);
  const indices = new Uint32Array(faceCount * INDICES_PER_QUAD);

  let vi = 0; /* 顶点游标(以顶点为单位) */
  let fi = 0; /* 面游标 */
  let ii = 0; /* 索引游标 */

  const chunkOriginX = chunk.cx * CHUNK_SIZE;
  const chunkOriginY = chunk.cy * CHUNK_SIZE;

  /** 写一个顶点;颜色与位置同一次写入,杜绝「几何更新了颜色没跟上」 */
  const pushVertex = (
    x: number, y: number, z: number,
    u: number, v: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number,
  ): void => {
    positions[vi * 3] = x;
    positions[vi * 3 + 1] = y;
    positions[vi * 3 + 2] = z;
    uvs[vi * 2] = u;
    uvs[vi * 2 + 1] = v;
    normals[vi * 3] = nx;
    normals[vi * 3 + 1] = ny;
    normals[vi * 3 + 2] = nz;
    writeVertexColor(colors, vi, { r, g, b });
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

    /*
     * 颜色(WS-FND-180):
     *   顶面 —— 由**格子材质**决定:`topColorOf(层, base, floor)`
     *           (铺装 > 地表 `base` > 海拔层兜底)。同一个海拔层上草地/金沙/熔岩
     *           因此是不同色,世界不再是 4 色色块。材质取该合并块的**主导格**
     *           (见 `collectCells`);LOD0 时主导格就是这一格自己,逐格精确。
     *   侧面 —— 仍按**海拔层**取背光档:侧面是地层剖面与块间高差,与「表面铺了什么」无关。
     */
    const elev = elevLayerOfZ(z);
    const topColor = topColorOf(elev, c.base, c.floor);
    const sideColor = faceColor(elev, false);

    /* ── 顶面(法线 +Z)── */
    for (const [dx, dy] of TOP_CORNERS) {
      pushVertex(
        cellX + dx * merge,
        cellY + dy * merge,
        z,
        u0 + dx * du,
        v0 + dy * du,
        0, 0, 1,
        topColor.r, topColor.g, topColor.b,
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
          sideColor.r, sideColor.g, sideColor.b,
        );
      }
      pushQuadIndices();
    }
  }

  return {
    positions,
    uvs,
    normals,
    colors,
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
  /* ── 顶点色(WS-09 U2):长度与值域,和 positions/indices 同级别把守 ── */
  const colorErr = validateVertexColors(g.colors, g.vertexCount);
  if (colorErr !== null) return colorErr;
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