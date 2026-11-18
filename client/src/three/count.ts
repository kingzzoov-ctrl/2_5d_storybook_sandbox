/**
 * WS-09 U4 / 面数**精确**计算 —— 按 `dominantZGrid` 逐块数,不是最坏上界估算。
 *
 * ## 为什么不能再拿估算值当真相
 *
 * `tile_mesh.estimateFaceCount(worldSize, lod)` 的公式是
 * `patches × 5`(每块 1 顶面 + 4 侧面),它假设**每个块四面都有高差**。
 * 真实地形远远不是这样:整片同海拔的草地侧面数 = 0,于是
 * 「估算 327,680 面」与「实测 65,536 面」能差 5 倍 —— 而这个差额被
 * **800,000 面预算**直接消费:
 *
 *   · 估高了 ⇒ 无谓地把 LOD 降粗 ⇒ 画面糊;
 *   · 估低了(比如有人为了"好看"改公式)⇒ 预算门禁永远绿 ⇒ 上线爆显存。
 *
 * 于是本模块把「精确」做成**可调用的一等函数**:它只依赖两个原始事实源
 * (`dominantZGrid` 合并块海拔 + `neighborZs` 四邻海拔),与
 * `tile_mesh.buildChunkQuads` / `chunk_geometry.emitChunkGeometry` **同源**。
 *
 * ## 判据口径
 *
 * 判据不用本模块的输出当期望值(那是自证),而是**手算的小场景**:
 * 例如「16×16 全平地 LOD0」手算 = 256 顶面 + 0 侧面 = 256;
 * 「1 格平台(海拔 z=1)落在角落的地面上」手算 = 256 顶面 + 2 侧面 = 258。
 * 本模块给出的数必须与手算相等 ⇒ 任何「只数顶面」「漏掉边界 NaN 规则」
 * 「把 merge 当格用」的实现都会红。
 *
 * ## 与 `crossCheckExactFaces` 的分工
 *
 * `exactFaces` 自己走一遍 `dominantZGrid`(这样才能被"手工核对"而不是"转手" ),
 * `crossCheckExactFaces` 再把它和 `buildChunkQuads` 对齐 —— 两份实现若漂移,
 * 装配层(每帧)与门禁会**同时**报错,不存在"只有测试知道"的漂移。
 */

import {
  CHUNK_SIZE,
  LOD_COUNT,
  LOD_MERGE_SIZE,
  VERTS_PER_QUAD,
  type ChunkInput,
  type EdgeContext,
  buildChunkQuads,
  dominantZGrid,
  neighborZs,
} from '../stage/tile_mesh.ts';
import {
  LOD_MERGE_MAX_DZ,
  lodBlockSpan,
  lodColorDriftRows,
  lodMergeVerdict,
} from '../stage/terrain_vcolor.ts';

/** 一个 Chunk 的精确面数拆解 */
export interface ExactFaces {
  /** 合并块数(每个块一个顶面) */
  topQuads: number;
  /** 因四邻更低而生成的侧面数 */
  sideQuads: number;
  faceCount: number;
  vertexCount: number;
}

/**
 * 精确面数。复杂度 O(块数)(LOD0 时 = 256)。
 *
 * 与 `buildChunkQuads` 逐项同构,但**独立走一遍** `dominantZGrid`:
 * 这样「精确算」不是把另一个函数的返回值改个名字,而是可被手算逐项核对。
 */
export function exactFaces(chunk: ChunkInput, lod: number, ctx?: EdgeContext): ExactFaces {
  const { grid, size } = dominantZGrid(chunk, lod);
  let topQuads = 0;
  let sideQuads = 0;
  for (let by = 0; by < size; by += 1) {
    for (let bx = 0; bx < size; bx += 1) {
      const z = grid[by * size + bx];
      if (z === Number.NEGATIVE_INFINITY) continue;
      topQuads += 1;
      const nb = neighborZs(grid, size, LOD_MERGE_SIZE[clampLod(lod)], bx, by, ctx);
      /* 与 buildChunkQuads 完全一致的比较:NaN < z 为 false ⇒ 无邻接数据处不出侧面 */
      if (nb.north < z) sideQuads += 1;
      if (nb.east < z) sideQuads += 1;
      if (nb.south < z) sideQuads += 1;
      if (nb.west < z) sideQuads += 1;
    }
  }
  const faceCount = topQuads + sideQuads;
  return { topQuads, sideQuads, faceCount, vertexCount: faceCount * VERTS_PER_QUAD };
}

/** 只要面数时的薄封装(判据与 HUD 用) */
export function exactFaceCount(chunk: ChunkInput, lod: number, ctx?: EdgeContext): number {
  return exactFaces(chunk, lod, ctx).faceCount;
}

/** 单帧精确面数 = Σ(可见 Chunk 的精确面数);复杂度 O(可见块数 × 块数) */
export function frameExactFaces(
  chunks: readonly ChunkInput[],
  lodFor: (chunk: ChunkInput) => number,
): ExactFaces {
  let topQuads = 0;
  let sideQuads = 0;
  for (const c of chunks) {
    const e = exactFaces(c, lodFor(c));
    topQuads += e.topQuads;
    sideQuads += e.sideQuads;
  }
  const faceCount = topQuads + sideQuads;
  return { topQuads, sideQuads, faceCount, vertexCount: faceCount * VERTS_PER_QUAD };
}

/**
 * 一致性自检:本模块的精确面数必须等于 `tile_mesh.buildChunkQuads` 的计数。
 * 返回 `null` 表示一致。
 *
 * 两份实现同源但独立 —— 这条断言就是「同源」二字的执行体。
 */
export function crossCheckExactFaces(chunk: ChunkInput, lod: number, ctx?: EdgeContext): string | null {
  const mine = exactFaces(chunk, lod, ctx);
  const ref = buildChunkQuads(chunk, lod, ctx);
  if (mine.faceCount !== ref.faceCount) {
    return `面数漂移:精确 ${mine.faceCount} vs buildChunkQuads ${ref.faceCount}(chunk ${chunk.key} LOD${lod})`;
  }
  if (mine.topQuads !== ref.topQuads || mine.sideQuads !== ref.sideQuads) {
    return `面数拆解漂移:顶 ${mine.topQuads}/${ref.topQuads} 侧 ${mine.sideQuads}/${ref.sideQuads}`
      + `(chunk ${chunk.key} LOD${lod})`;
  }
  return null;
}

/** 全平地 Chunk 的手算基准:16×16 = 256 块 ⇒ 256 面(块内四邻同高,边界无邻接数据) */
export const FLAT_CHUNK_FACES_LOD0 = CHUNK_SIZE * CHUNK_SIZE;

function clampLod(lod: number): number {
  return Math.max(0, Math.min(LOD_COUNT - 1, Math.trunc(lod)));
}

/* ═══════ WS-FND-101 / 合并阈值 × 着色口径:每档 LOD 的「细节被抹平」预算 ═══════ */

/**
 * 一个 Chunk 在某档 LOD 上的**合并质量**拆解。
 *
 * ## 为什么需要这个数
 *
 * `dominantZGrid` 不看块内高差,永远取块内最高 z(降级是它的职责)。于是「一块 2×2 里
 * 有 0 和 2 两个海拔,粗档把它抹成一层」这件事**没有任何地方记账**:面数对、颜色在调色板里、
 * 每面自洽 —— 门禁全绿,只有肉眼能看见「平台那一层没了」。本函数把那笔账记下来:
 * `lossy` = 块内高差超过 `LOD_MERGE_MAX_DZ` 的块数,也就是**这一档 LOD 上颜色不可复现**的块数。
 *
 * ## 为什么逐格 z 不再写一遍 `tileZ`
 *
 * `dominantZGrid(chunk, 0)` 的块就是「一格的合并块」(merge = 1)⇒ `grid[x, y]` 就是该格的 z
 * (空格为 `-Infinity`)。本模块因此**零重复**地拿到逐格 z,与 `exactFaces` 用的是同一个
 * `dominantZGrid` —— 不存在「空单元判定」的第二份实现(那份重复迟早漂移:一处当空气、
 * 把整块高差算成无穷)。
 *
 * ## 判据口径
 *
 * `blocks` 必须等于 `exactFaces(chunk, lod).topQuads`(两份独立走一遍:一份按本档 LOD 数块,
 * 一份按本档 LOD 的块数;漂移即红)。LOD0 恒满足 `safe === blocks`(merge = 1 ⇒ 块内只有一格
 * ⇒ 高差 0)—— 这既是正面判据,也是「阈值不是恒绿/恒红」的锚点。
 */
export interface LodMergeBudget {
  /** 非空合并块数(= 该档的顶面数) */
  blocks: number;
  /** 块内高差 <= 阈值 ⇒ 合并色可复现 */
  safe: number;
  /** 块内高差 > 阈值 ⇒ 粗档上细节被抹平(必须被报告,不许静默合并) */
  lossy: number;
  /** `lossy / blocks`(0..1;空 Chunk 记 0) */
  lossyRatio: number;
  /** 观测到的块内最大高差(便于与阈值直接对照) */
  maxDz: number;
  /** 合并色对块内各格的最大**行偏差**(阶跃口径下恒等于 `maxDz`) */
  maxDriftRows: number;
  /** 本次判定用的阈值(`terrain_vcolor.LOD_MERGE_MAX_DZ` 的当下值,随结果一起返回) */
  threshold: number;
}

/**
 * 一个 Chunk 在某档 LOD 上的合并质量。复杂度 O(格数)(= 256),与建面同阶。
 *
 * `threshold` 默认 = `LOD_MERGE_MAX_DZ`;**显式传入只为让判据「换一个阈值跑同一块地形」**
 * 并断言 `lossy` 必须随之翻面(改阈值必红)。生产路径只有一个阈值。
 */
export function lodMergeBudget(chunk: ChunkInput, lod: number, threshold: number = LOD_MERGE_MAX_DZ): LodMergeBudget {
  const merge = LOD_MERGE_SIZE[clampLod(lod)];
  /* 逐格 z 的**唯一事实源**:merge = 1 时 dominantZGrid 的一块就是一格 */
  const perCell = dominantZGrid(chunk, 0);
  const cellSize = perCell.size;
  const cells = perCell.grid;
  const size = Math.ceil(cellSize / merge);
  let blocks = 0;
  let safe = 0;
  let lossy = 0;
  let maxDz = 0;
  let maxDriftRows = 0;
  for (let by = 0; by < size; by += 1) {
    for (let bx = 0; bx < size; bx += 1) {
      const zs: number[] = [];
      const yEnd = Math.min((by + 1) * merge, cellSize);
      const xEnd = Math.min((bx + 1) * merge, cellSize);
      for (let y = by * merge; y < yEnd; y += 1) {
        for (let x = bx * merge; x < xEnd; x += 1) {
          const z = cells[y * cellSize + x];
          if (z === Number.NEGATIVE_INFINITY) continue;
          zs.push(z);
        }
      }
      /* 空块不建面(与 buildChunkQuads 的 `continue` 同规则)⇒ 不进预算 */
      if (zs.length === 0) continue;
      const span = lodBlockSpan(zs);
      blocks += 1;
      if (span.dz > maxDz) maxDz = span.dz;
      if (lodMergeVerdict(span.dz, threshold) === 'MERGE') safe += 1;
      else lossy += 1;
      const drift = lodColorDriftRows(zs);
      if (drift !== null && drift > maxDriftRows) maxDriftRows = drift;
    }
  }
  return {
    blocks,
    safe,
    lossy,
    lossyRatio: blocks === 0 ? 0 : lossy / blocks,
    maxDz,
    maxDriftRows,
    threshold,
  };
}

/** 单帧合并质量 = Σ(可见 Chunk 的预算);与 `frameExactFaces` 同形,供 HUD 与门禁读同一份数 */
export function frameLodMergeBudget(
  chunks: readonly ChunkInput[],
  lodFor: (chunk: ChunkInput) => number,
): LodMergeBudget {
  let blocks = 0;
  let safe = 0;
  let lossy = 0;
  let maxDz = 0;
  let maxDriftRows = 0;
  let threshold = LOD_MERGE_MAX_DZ;
  for (const c of chunks) {
    const b = lodMergeBudget(c, lodFor(c));
    blocks += b.blocks;
    safe += b.safe;
    lossy += b.lossy;
    if (b.maxDz > maxDz) maxDz = b.maxDz;
    if (b.maxDriftRows > maxDriftRows) maxDriftRows = b.maxDriftRows;
    threshold = b.threshold;
  }
  return {
    blocks,
    safe,
    lossy,
    lossyRatio: blocks === 0 ? 0 : lossy / blocks,
    maxDz,
    maxDriftRows,
    threshold,
  };
}