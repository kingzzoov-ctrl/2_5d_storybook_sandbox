/**
 * WS-FND-101 —— 顶点色 + `aLodMerge` 的 **LOD 合并阈值** 与 **颜色插值口径**。
 *
 * ## 今天的问题:R22 的两件事都「只钉了属性存在」
 *
 * 现有判据(`tests/WS-FND-96-…`,P2-13 / P3-1)钉住的是「先合并再着色」的顺序与
 * 「顶点色在调色板里」,但下面两件事**没有任何数字**:
 *
 *   1. **块内高差达到多少**才允许把面并进上层 LOD —— 没有阈值,「抹掉一层」与
 *      「抹掉三层」在判据上完全一样;
 *   2. 顶点色**插不插值** —— 阶跃与线性插值在平坦地形上逐像素相同,
 *      只有在块内 z 不一致时才分叉 ⇒ 口径不定时缺陷不可见。
 *
 * 本套件把两条口径钉成可判定的数,并给出「改坏哪里会红」。
 *
 * | # | 判据 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- |
 * | 1 | 阈值 = 1 层、插值 = 阶跃;两条**手算前提**成立(层间距 1、一行色差 0.26) | 改 `LOD_MERGE_MAX_DZ` / 改 `LOD_COLOR_INTERPOLATION` / 改 `elevLayerOfZ` 的层间距 |
 * | 2 | 阈值边界:高差 0、1(< / 恰好等于)⇒ `MERGE`;2、3(>)⇒ `KEEP_DETAIL`;空块 ⇒ `MERGE`;NaN/∞ ⇒ `KEEP_DETAIL` | 边界写成 `<`(丢掉「恰好等于」)/ 空块被算成高差无穷 |
 * | 3 | 真实地形预算:平坦 64 块全 safe;高差 2 的块「恰好 1 块 lossy」;`blocks = exactFaces().topQuads` | `dominantZGrid` 换粒度 / 预算重写一份空单元判定 |
 * | 4 | 插值口径 = 阶跃:小数 z 不产生中间色;线性插值色**不在调色板**;同块 z 不同格分布 ⇒ 线性给不同色(不可复现) | 改成先着色再合并(平均)/ 块内逐格插值 |
 * | 5 | 两档 LOD 同一面:块 z 相同 ⇒ 颜色**逐位**相同;块 z 变了 ⇒ 只能变成 `faceColor(层(新块 z), 朝向)` | 用块内「某格」的 z 着色 |
 * | 6 | 法线只由**面朝向**定:与 merge / 块内高差 / 阈值都无关(LOD0..3 顶面都是 (0,0,1)) | 逐法线兰伯特 / 用高差扰法线 |
 * | 7 | 跨块(同一 Chunk 相邻块、不同 Chunk)一律不合并:`OTHER_BLOCK` / `CROSS_CHUNK` 都不可共享合并面 | 判据里丢掉 Chunk 键(「相邻即同块」) |
 * | 8 | 注入:改阈值 / 换插值 / 放宽跨块 —— 三条判据**同时**翻面的证据 | 见 FND101-8 |
 *
 * 断言右侧一律**字面量**(`1`、`'STEP_BY_LAYER'`、`64`、`0.26`);只有「契约本身」
 * (调色板色、层号)才引用被测模块的导出口,因为它们**就是**规格。
 *
 * 运行:`node tests/WS-FND-101-lod-merge-ruling.test.ts`
 */
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { CHUNK_SIZE, type ChunkInput, type EdgeContext } from '../client/src/stage/tile_mesh.ts';
import { Elevation, packTile } from '../shared/types/tile.ts';
import { emitChunkGeometry, type ChunkGeometry } from '../client/src/stage/chunk_geometry.ts';
import {
  ELEV_BASE_RGB,
  LOD_COLOR_INTERPOLATION,
  LOD_MERGE_MAX_DZ,
  LOD_MERGE_ORDER,
  elevLayerOfZ,
  faceColor,
  lodBlockColor,
  lodBlockSpan,
  lodColorDriftRows,
  lodFaceSemantics,
  lodMayShareMergedFace,
  lodMergeScope,
  lodMergeVerdict,
  lodPaletteOf,
  lodTwoLevelDelta,
  mergedZOfFace,
  type FaceColor,
  type LodBlockId,
  type LodFaceSample,
} from '../client/src/stage/terrain_vcolor.ts';
import { LOD_MERGE_ATTRIBUTE, assembleChunkGeometry, lodMergeOfGeometry } from '../client/src/three/compat.ts';
import { exactFaces, frameLodMergeBudget, lodMergeBudget } from '../client/src/three/count.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 测试自造 Chunk:`tiles` 要**可写**(契约是 `ArrayLike<number>`,只读索引签名)。 */
type TestChunk = ChunkInput & { tiles: Uint32Array };

function packElev(elev: number): number {
  return packTile({ elev, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 });
}

function fillChunk(key: string, cx: number, cy: number, elev: number): TestChunk {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packElev(elev));
  return { key, cx, cy, tiles };
}

/** 16×16 全 GROUND(z = 0):块内高差恒 0 的样本。 */
function flatChunk(key = 'c_flat', cx = 0, cy = 0): TestChunk {
  return fillChunk(key, cx, cy, Elevation.GROUND);
}

/** 16×16 全 CLIFF(z = 2):用于「相邻 Chunk 接缝」样本。 */
function tallChunk(key = 'c_tall', cx = 1, cy = 0): TestChunk {
  return fillChunk(key, cx, cy, Elevation.CLIFF);
}

/** 平地 + 若干格格到指定海拔。 */
function withCells(key: string, cells: readonly (readonly [number, number, number])[]): TestChunk {
  const c = flatChunk(key, 0, 0);
  for (const [x, y, elev] of cells) c.tiles[y * CHUNK_SIZE + x] = packElev(elev);
  return c;
}

/** 块内高差**恰好 1**:(0,0) 抬到 PLATFORM(z = 1),LOD1 的块 (0,0) 是 {1,0,0,0}。 */
function oneStepChunk(): TestChunk {
  return withCells('c_one', [[0, 0, Elevation.PLATFORM]]);
}

/** 块内高差**大于阈值**:(0,0) 抬到 CLIFF(z = 2),LOD1 的块 (0,0) 是 {2,0,0,0}。 */
function twoStepChunk(): TestChunk {
  return withCells('c_two', [[0, 0, Elevation.CLIFF]]);
}

/** 块内高差 3:CLIFF(2) 与 DEEP(−1) 落在同一个 LOD1 块里。 */
function threeStepChunk(): TestChunk {
  return withCells('c_three', [[0, 0, Elevation.CLIFF], [1, 1, Elevation.DEEP]]);
}

/** 全空 Chunk(32-bit 全 0 = 空气):不建面,也就没有合并质量可言。 */
function emptyChunk(key = 'c_empty'): TestChunk {
  return { key, cx: 0, cy: 0, tiles: new Uint32Array(CHUNK_SIZE * CHUNK_SIZE) };
}

/** 取某个 Chunk 的东/西边缘一列(16 格),作为邻居的 `EdgeContext`。 */
function columnTiles(chunk: TestChunk, side: 'east' | 'west'): number[] {
  const x = side === 'east' ? CHUNK_SIZE - 1 : 0;
  const out: number[] = [];
  for (let y = 0; y < CHUNK_SIZE; y += 1) out.push(chunk.tiles[y * CHUNK_SIZE + x]);
  return out;
}

/** 把几何按**面**(每 4 个顶点一个 quad)切成 LOD 采样。 */
function facesOf(g: ChunkGeometry): LodFaceSample[] {
  const out: LodFaceSample[] = [];
  for (let f = 0; f < g.faceCount; f += 1) {
    const base = f * 4;
    const vertZ: number[] = [];
    for (let k = 0; k < 4; k += 1) vertZ.push(g.positions[(base + k) * 3 + 2]);
    out.push({
      vertZ,
      normal: { x: g.normals[base * 3], y: g.normals[base * 3 + 1], z: g.normals[base * 3 + 2] },
      color: { r: g.colors[base * 3], g: g.colors[base * 3 + 1], b: g.colors[base * 3 + 2] },
    });
  }
  return out;
}

function isTopFace(f: LodFaceSample): boolean {
  return Math.abs(f.normal.z - 1) <= 1e-6;
}

function sameColor(a: FaceColor, b: FaceColor): boolean {
  return Math.abs(a.r - b.r) <= 1e-6 && Math.abs(a.g - b.g) <= 1e-6 && Math.abs(a.b - b.b) <= 1e-6;
}

/** 取某块的颜色;空块没有颜色 ⇒ 夹具直接炸(避免「null 被当成通过了」)。 */
function colorOf(cellZs: readonly number[], isTop: boolean): FaceColor {
  const got = lodBlockColor(cellZs, isTop);
  if (got === null) throw new Error(`块内没有非空格:${cellZs.map(String).join(',')}`);
  return got.color;
}

/** 两色线性混合(**负对照模型**,不是产品口径)。 */
function mixColors(a: FaceColor, b: FaceColor, t: number): FaceColor {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/**
 * **线性插值模型**(负对照):块内逐格层号取平均,再在相邻两行调色板之间插值。
 * 这不是产品的实现(产品是阶跃),写在这里正是为了让「不可复现」可判定:
 * 同一块 z、不同块内格分布 ⇒ 这个模型给出不同颜色。
 */
function linearMeanColor(cellZs: readonly number[], isTop: boolean): FaceColor {
  const layers: number[] = [];
  for (const z of cellZs) if (Number.isFinite(z)) layers.push(elevLayerOfZ(z));
  if (layers.length === 0) throw new Error('空块没有插值可言');
  let sum = 0;
  for (const l of layers) sum += l;
  const mean = sum / layers.length;
  const lo = Math.max(0, Math.min(ELEV_BASE_RGB.length - 1, Math.floor(mean)));
  const hi = Math.max(0, Math.min(ELEV_BASE_RGB.length - 1, Math.ceil(mean)));
  return mixColors(faceColor(lo, isTop), faceColor(hi, isTop), mean - lo);
}

/** 相邻两行调色板的最大分量差(阈值注释里手算的那个数)。 */
function maxAdjacentRowDelta(): number {
  let worst = 0;
  for (let i = 1; i < ELEV_BASE_RGB.length; i += 1) {
    const a = ELEV_BASE_RGB[i - 1];
    const b = ELEV_BASE_RGB[i];
    const pairs: readonly (readonly [number, number])[] = [[a.r, b.r], [a.g, b.g], [a.b, b.b]];
    for (const [x, y] of pairs) {
      const d = Math.abs(x - y);
      if (d > worst) worst = d;
    }
  }
  return worst;
}
/** 取「必须为红」的判定原因;`null` ⇒ 判据恒绿,直接判失败。 */
function redReason(err: string | null): string {
  if (err === null) throw new Error('期望判定为红(null 才算绿),实际为绿');
  return err;
}


/* ═════════════ 1. 口径常量 + 两条手算前提 ═════════════ */

test('FND101-1 口径:阈值 = 1 层、插值 = 阶跃;层间距 1 与一行色差 0.26 两条手算前提成立', () => {
  eq(LOD_MERGE_MAX_DZ, 1, '阈值:块内高差 <= 1 层才准以合并色出现在粗档');
  eq(LOD_COLOR_INTERPOLATION, 'STEP_BY_LAYER', '插值口径:按层查调色板(层间阶跃),不插值');
  eq(LOD_MERGE_ORDER, 'MERGE_THEN_COLOR', '顺序:先合并再着色 —— 阶跃口径与它一致,线性插值属于相反顺序');

  /* 前提 1(阈值注释第 1 条):层间距恒为 1 ⇒ 世界 z -1..2 一一对应层号 0..3 */
  eq([elevLayerOfZ(-1), elevLayerOfZ(0), elevLayerOfZ(1), elevLayerOfZ(2)], [0, 1, 2, 3]);
  eq(elevLayerOfZ(-9), 0, '越界向下夹紧到 DEEP');
  eq(elevLayerOfZ(9), 3, '越界向上夹紧到 CLIFF');

  /* 前提 2(阈值注释第 3 条):相邻两行的最大分量差 = 0.26(DEEP → GROUND) */
  near(maxAdjacentRowDelta(), 0.26, 1e-9, '一行色差的手算上限');
  ok(maxAdjacentRowDelta() > 0.2,
    '上界必须真的比 GROUND → PLATFORM 的 0.20 大,否则 0.26 就不是上界');

  /* 负对照:调色板相邻行不是「都一样」—— 三行的差 0.26 / 0.20 / 0.08 互不相同,
     因此「一行差」这个单位只有在阶跃口径下才说得清(插值会落到行与行之间)。 */
  const rowDeltas = [0.26, 0.20, 0.08];
  for (const d of rowDeltas) ok(d <= maxAdjacentRowDelta() + 1e-12, `手算的 ${d} 不得超过上界`);
});

/* ═════════════ 2. 阈值边界(小于 / 恰好等于 / 大于)═════════════ */

test('FND101-2 阈值边界:高差 0/1 ⇒ MERGE,2/3 ⇒ KEEP_DETAIL;空块 MERGE、NaN/∞ KEEP_DETAIL', () => {
  /* 画像本身:空块与有块两种形态 */
  eq(lodBlockSpan([]), {
    cells: 0, minZ: Number.POSITIVE_INFINITY, maxZ: Number.NEGATIVE_INFINITY, dz: 0,
  });
  eq(lodBlockSpan([0, 0, 0, 0]), { cells: 4, minZ: 0, maxZ: 0, dz: 0 });
  eq(lodBlockSpan([0, 2, 0, 0]), { cells: 4, minZ: 0, maxZ: 2, dz: 2 });
  /* 空单元(−∞ / NaN)不算格:否则一块里混进空格就会被算成「高差无穷」 */
  eq(lodBlockSpan([0, Number.NEGATIVE_INFINITY, 1]).cells, 2, '空格不计入格数');
  eq(lodBlockSpan([0, Number.NaN, 1]).dz, 1, 'NaN 不得把高差撑成无穷');

  /* 边界:0 < 1(小于)、1 = 1(恰好等于)、2 > 1(大于) */
  eq(lodMergeVerdict(0), 'MERGE', '块内无高差');
  eq(lodMergeVerdict(1), 'MERGE', '恰好等于阈值 ⇒ 仍允许合并(边界含等号)');
  eq(lodMergeVerdict(2), 'KEEP_DETAIL', '大于阈值 ⇒ 细节被抹平,必须计数');
  eq(lodMergeVerdict(3), 'KEEP_DETAIL', '跨三层更不行');
  /* 空块:没有颜色可抹平 ⇒ MERGE(不是 KEEP_DETAIL) */
  eq(lodMergeVerdict(lodBlockSpan([]).dz), 'MERGE', '空块无面,不该被算成 lossy');
  /* 非法输入不猜:NaN / ∞ 一律按「会抹平细节」处理(宁严不松) */
  eq(lodMergeVerdict(Number.NaN), 'KEEP_DETAIL');
  eq(lodMergeVerdict(Number.POSITIVE_INFINITY), 'KEEP_DETAIL');

  /* 真实地形:16×16 在 LOD1(merge 2)是 8×8 = 64 块 */
  eq(lodMergeBudget(flatChunk(), 1),
    { blocks: 64, safe: 64, lossy: 0, lossyRatio: 0, maxDz: 0, maxDriftRows: 0, threshold: 1 },
    '全平地:64 块全 safe');
  const one = lodMergeBudget(oneStepChunk(), 1);
  eq([one.blocks, one.safe, one.lossy, one.maxDz], [64, 64, 0, 1], '高差恰好 1 ⇒ 仍全部 safe');
  const two = lodMergeBudget(twoStepChunk(), 1);
  eq([two.blocks, two.safe, two.lossy, two.maxDz, two.maxDriftRows], [64, 63, 1, 2, 2],
    '高差 2 ⇒ 恰好 1 块 lossy,行偏差 = 2');
  near(two.lossyRatio, 0.015625, 1e-12, 'lossy 占比 = 1/64');
  const three = lodMergeBudget(threeStepChunk(), 1);
  eq([three.blocks, three.safe, three.lossy, three.maxDz, three.maxDriftRows], [64, 63, 1, 3, 3]);
  /* LOD0:merge 1 ⇒ 每块一格 ⇒ 高差恒 0(阈值不是「恒红」也不是「恒绿」的锚点) */
  eq([lodMergeBudget(twoStepChunk(), 0).blocks, lodMergeBudget(twoStepChunk(), 0).lossy], [256, 0]);
  /* 空 Chunk:0 块,占比记 0(不是 NaN) */
  eq([lodMergeBudget(emptyChunk(), 1).blocks, lodMergeBudget(emptyChunk(), 1).lossyRatio], [0, 0]);

  /* ★ 注入:阈值改成 2 ⇒ 同一块地形立刻翻面(改阈值必红) */
  const loosened = lodMergeBudget(twoStepChunk(), 1, 2);
  eq([loosened.blocks, loosened.safe, loosened.lossy, loosened.threshold], [64, 64, 0, 2],
    '阈值 2 时高差 2 的块变成 safe');
  ok(loosened.lossy !== two.lossy, '同一块在两个阈值下结论必须不同 —— 否则「改阈值必红」不成立');
  eq(lodMergeVerdict(2, 2), 'MERGE', '注入判据本身:阈值 2 时 2 也算「等于」');
  /* 反向收紧到 0:高差 1 的块从 safe 翻成 lossy */
  eq(lodMergeBudget(oneStepChunk(), 1, 0).lossy, 1);
  eq(lodMergeVerdict(1, 0), 'KEEP_DETAIL');
});

/* ═════════════ 3. 预算与计数同源(blocks = topQuads)═════════════ */

test('FND101-3 预算不是自证:blocks 必须等于 exactFaces 的 topQuads(LOD0..3 × 四种地形)', () => {
  const cases: readonly (readonly [string, TestChunk])[] = [
    ['平坦', flatChunk()],
    ['高差1', oneStepChunk()],
    ['高差2', twoStepChunk()],
    ['高差3', threeStepChunk()],
    ['全空', emptyChunk()],
  ];
  let checked = 0;
  for (const [name, chunk] of cases) {
    for (const lod of [0, 1, 2, 3]) {
      const budget = lodMergeBudget(chunk, lod);
      const exact = exactFaces(chunk, lod);
      eq(budget.blocks, exact.topQuads, `${name} LOD${lod}:预算块数必须等于精确顶面数`);
      eq(budget.safe + budget.lossy, budget.blocks, `${name} LOD${lod}:safe + lossy 必须铺满`);
      checked += 1;
    }
  }
  ok(checked === 20, `20 个组合都要查过(实得 ${checked})`);

  /* 手算:LOD1 8×8 = 64 块,LOD2 4×4 = 16 块,LOD3 2×2 = 4 块 */
  eq([1, 2, 3].map((lod) => lodMergeBudget(flatChunk(), lod).blocks), [64, 16, 4]);
  /* 高差块在粗档上仍然是**同一批块**(合并粒度由 LOD_MERGE_SIZE 定,不由阈值定) */
  eq([twoStepChunk(), threeStepChunk()].map((c) => lodMergeBudget(c, 2).blocks), [16, 16]);
  eq([twoStepChunk(), threeStepChunk()].map((c) => lodMergeBudget(c, 2).lossy), [1, 1]);

  /* 行偏差与高差同一单位:阶跃口径下 drift == dz(手算:z=-1..2 ⇒ 层 0..3) */
  eq(lodColorDriftRows([0, 2]), 2);
  eq(lodColorDriftRows([-1, 2]), 3);
  eq(lodColorDriftRows([]), null, '空块没有行偏差可言(不是 0 行)');
  eq(lodMergeBudget(threeStepChunk(), 1).maxDriftRows, lodMergeBudget(threeStepChunk(), 1).maxDz);
});

/* ═════════════ 4. 插值口径:阶跃(不插值)═════════════ */

test('FND101-4 插值口径:阶跃;线性插值色在调色板外,且同一块 z 会给出不同色(不可复现)', () => {
  eq(LOD_COLOR_INTERPOLATION, 'STEP_BY_LAYER', '口径常量:按层查表');

  /* 阶跃的直接证据:小数 z 不产生中间色,只按层落位 */
  eq(colorOf([0, 1.9], true), colorOf([0, 2], true), 'z=1.9 与 z=2 落同一层 ⇒ 同色(没有插值)');
  eq(colorOf([0, 1.9], true), faceColor(3, true), '就是 CLIFF 那一行(层 3)');
  eq(lodPaletteOf(colorOf([0, 1.9], true)), { layer: 3, isTop: true });
  /* 颜色只由 (块 z, 朝向) 定 ⇒ 与块内高差无关(高差 3 的块和单格块同色) */
  eq(colorOf([2, -1, 0, 0], true), colorOf([2], true), '同块 z ⇒ 同色,与块内分布无关');
  eq(lodBlockColor([], true), null, '空块没有颜色(null,不是黑色)');

  /* ★ 负对照一:线性插值色**不在**调色板里 ⇒ 与阶跃口径可区分 */
  const lerped = mixColors(faceColor(1, true), faceColor(3, true), 0.5);
  near(lerped.r, 0.49, 1e-9, 'GROUND 亮档与 CLIFF 亮档的中点 r');
  eq(lodPaletteOf(lerped), null, '两行中间色不是调色板色');
  const lerpedFace: LodFaceSample = { vertZ: [2, 2, 2, 2], normal: { x: 0, y: 0, z: 1 }, color: lerped };
  const lerpedErr = lodFaceSemantics(lerpedFace);
  ok(lerpedErr !== null, '插值色必须过不了面级自检');
  ok(redReason(lerpedErr).includes('调色板'), `红要指到调色板:${redReason(lerpedErr)}`);

  /* ★ 负对照二:同一个块 z、不同块内格分布 ⇒ 线性插值给不同色 ⇒ 两档 LOD 不可复现 */
  const cellsA = [0, 2, 2, 2]; /* 层 1,3,3,3 ⇒ 均值 2.5 */
  const cellsB = [0, 0, 0, 2]; /* 层 1,1,1,3 ⇒ 均值 1.5 */
  eq([lodBlockSpan(cellsA).maxZ, lodBlockSpan(cellsB).maxZ], [2, 2], '两块合并后的 z 相同');
  eq(colorOf(cellsA, true), colorOf(cellsB, true), '阶跃:同块 z ⇒ 逐位同色(可复现)');
  ok(!sameColor(linearMeanColor(cellsA, true), linearMeanColor(cellsB, true)),
    '线性:同块 z 却给不同色 —— 同一个面在两档 LOD 上无法复现');
  /* 这一对色差确实来自插值,不是「调色板里本来就不同」 */
  eq([lodPaletteOf(linearMeanColor(cellsA, true)), lodPaletteOf(linearMeanColor(cellsB, true))], [null, null],
    '线性模型的输出都落在调色板外');
});

/* ═════════════ 5. 两档 LOD:同面颜色一致 / 按规则变化 ═════════════ */

test('FND101-5 两档 LOD:块 z 相同 ⇒ 颜色逐位相同;块 z 变了 ⇒ 只能按层规则变', () => {
  const flat0 = facesOf(emitChunkGeometry(flatChunk(), 0));
  const flat1 = facesOf(emitChunkGeometry(flatChunk(), 1));
  eq([flat0.length, flat1.length], [256, 64], '平坦:LOD0 256 面 / LOD1 64 面');
  const flatTop0 = flat0.find(isTopFace);
  const flatTop1 = flat1.find(isTopFace);
  ok(flatTop0 !== undefined && flatTop1 !== undefined, '两档都要有顶面');
  if (flatTop0 === undefined || flatTop1 === undefined) return;
  eq(lodTwoLevelDelta(flatTop0, flatTop1), null, '平坦地形两档:必须一致');
  eq([flatTop1.color.r, flatTop1.color.g, flatTop1.color.b],
    [flatTop0.color.r, flatTop0.color.g, flatTop0.color.b], '块 z 相同 ⇒ 顶点色逐位相同(float32 后也一样)');
  near(flatTop1.color.r, 0.42, 1e-6, 'GROUND 亮档 r');
  near(flatTop1.color.g, 0.62, 1e-6, 'GROUND 亮档 g');
  near(flatTop1.color.b, 0.36, 1e-6, 'GROUND 亮档 b');
  /* 与「按块 z 查表」的结果一致(几何色经 float32 落盘,故用 near 而非逐位) */
  near(flatTop1.color.r, colorOf([0, 0, 0, 0], true).r, 1e-6, '几何色 = 阶跃查表色 r');
  near(flatTop1.color.g, colorOf([0, 0, 0, 0], true).g, 1e-6, '几何色 = 阶跃查表色 g');
  near(flatTop1.color.b, colorOf([0, 0, 0, 0], true).b, 1e-6, '几何色 = 阶跃查表色 b');

  /* 台阶:LOD0 的 z=0 顶面 → LOD1 覆盖它的合并块主导 z=2 ⇒ 允许变色,但必须按规则 */
  const step0 = facesOf(emitChunkGeometry(twoStepChunk(), 0));
  const step1 = facesOf(emitChunkGeometry(twoStepChunk(), 1));
  const lowTop = step0.find((f) => isTopFace(f) && mergedZOfFace(f.vertZ) === 0);
  const highTop = step1.find((f) => isTopFace(f) && mergedZOfFace(f.vertZ) === 2);
  ok(lowTop !== undefined, 'LOD0 要有 z=0 的顶面');
  ok(highTop !== undefined, 'LOD1 的合并块主导 z 应为 2(块内最高非空 z)');
  if (lowTop === undefined || highTop === undefined) return;
  eq(lodTwoLevelDelta(lowTop, highTop), null, '块 z 变了 ⇒ 颜色按 faceColor(层(新块 z), 朝向) 变');
  ok(!sameColor(lowTop.color, highTop.color), '这一对确实是「颜色变了」的样本(不是退化对照)');
  eq(lodPaletteOf(highTop.color), { layer: 3, isTop: true });
  near(highTop.color.r, 0.56, 1e-6, 'CLIFF 亮档 r');
  near(highTop.color.g, 0.52, 1e-6, 'CLIFF 亮档 g');
  near(highTop.color.b, 0.54, 1e-6, 'CLIFF 亮档 b');

  /* ★ 负对照:把 LOD1 那一面换成「块内线性平均色」⇒ 两条判据同时红 */
  const averaged: LodFaceSample = {
    vertZ: highTop.vertZ,
    normal: highTop.normal,
    color: linearMeanColor([0, 2, 0, 0], true),
  };
  ok(lodFaceSemantics(averaged) !== null, '负对照:平均/插值色不得通过面级自检');
  ok(lodTwoLevelDelta(lowTop, averaged) !== null, '负对照:两档对照必须拒绝插值色');
});

/* ═════════════ 6. 法线只由面朝向定 ═════════════ */

test('FND101-6 法线只由面朝向定:与 merge、块内高差、阈值都无关(LOD0..3 顶面都是 (0,0,1))', () => {
  /* 平坦:LOD0/1/2/3 面数与 aLodMerge 都手写(LOD_MERGE_SIZE = 1/2/4/8) */
  eq([0, 1, 2, 3].map((lod) => emitChunkGeometry(flatChunk(), lod).faceCount), [256, 64, 16, 4]);
  eq([0, 1, 2, 3].map((lod) =>
    lodMergeOfGeometry(assembleChunkGeometry(emitChunkGeometry(flatChunk(), lod), lod)) ?? -1),
  [1, 2, 4, 8], `aLodMerge 必须等于该档的 merge(${LOD_MERGE_ATTRIBUTE})`);

  for (const lod of [0, 1, 2, 3]) {
    for (const f of facesOf(emitChunkGeometry(flatChunk(), lod))) {
      eq([f.normal.x, f.normal.y, f.normal.z], [0, 0, 1], `LOD${lod} 顶面法线恒为 (0,0,1)`);
    }
  }

  /* 有侧面的地形:法线集合只可能是 5 个轴向之一,且与块内高差无关 */
  const canonical = new Set(['0,0,1', '0,-1,0', '0,1,0', '-1,0,0', '1,0,0']);
  for (const lod of [0, 1, 3]) {
    const faces = facesOf(emitChunkGeometry(twoStepChunk(), lod));
    ok(faces.length > 0, `LOD${lod} 必须有面`);
    for (const f of faces) {
      const key = `${f.normal.x},${f.normal.y},${f.normal.z}`;
      ok(canonical.has(key), `LOD${lod} 出现了非轴向法线 ${key}`);
    }
    /* 顶面法线逐位相同(与 LOD、块内高差都无关) */
    for (const f of faces.filter(isTopFace)) {
      eq([f.normal.x, f.normal.y, f.normal.z], [0, 0, 1]);
    }
  }
  /* 高差 3 的块与高差 0 的块:顶面法线仍然逐位相同 */
  const dz3Top = facesOf(emitChunkGeometry(threeStepChunk(), 1)).find(isTopFace);
  const dz0Top = facesOf(emitChunkGeometry(flatChunk(), 1)).find(isTopFace);
  ok(dz3Top !== undefined && dz0Top !== undefined, '两个样本都要有顶面');
  if (dz3Top === undefined || dz0Top === undefined) return;
  eq([dz3Top.normal.x, dz3Top.normal.y, dz3Top.normal.z],
    [dz0Top.normal.x, dz0Top.normal.y, dz0Top.normal.z], '法线与块内高差无关');

  /* ★ 负对照一:单位向量但不在规范集(斜向 45 度)⇒ 红,且要指到规范集 */
  const base: LodFaceSample = { vertZ: [0, 0, 0, 0], normal: { x: 0, y: 0, z: 1 }, color: faceColor(1, true) };
  eq(lodFaceSemantics(base), null, '正对照:z=0 顶面自洽');
  const skewed: LodFaceSample = { ...base, normal: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 } };
  const skewedErr = lodFaceSemantics(skewed);
  ok(skewedErr !== null, '负对照:斜法线必须红');
  ok(redReason(skewedErr).includes('规范集'), `红要指到规范集:${redReason(skewedErr)}`);
  /* ★ 负对照二:非单位向量 ⇒ 另一条独立的红 */
  const notUnit: LodFaceSample = { ...base, normal: { x: 0.6, y: 0.6, z: 0.5 } };
  const unitErr = lodFaceSemantics(notUnit);
  ok(unitErr !== null, '负对照:非单位法线必须红');
  ok(redReason(unitErr).includes('单位向量'), `红要指到单位向量:${redReason(unitErr)}`);
});

/* ═════════════ 7. 跨块不合并 ═════════════ */

test('FND101-7 跨块不合并:同一 Chunk 的相邻块与相邻 Chunk 都不能共享一个合并面', () => {
  const a: LodBlockId = { chunk: 'c_0_0', bx: 7, by: 3 };
  const sameBlock: LodBlockId = { chunk: 'c_0_0', bx: 7, by: 3 };
  const otherBlock: LodBlockId = { chunk: 'c_0_0', bx: 8, by: 3 };
  const crossChunk: LodBlockId = { chunk: 'c_1_0', bx: 7, by: 3 };

  eq(lodMergeScope(a, sameBlock), 'SAME_BLOCK');
  eq(lodMergeScope(a, otherBlock), 'OTHER_BLOCK');
  eq(lodMergeScope(a, crossChunk), 'CROSS_CHUNK');
  eq(lodMayShareMergedFace(a, sameBlock), true, '同一个块内可以共享一次合并');
  eq(lodMayShareMergedFace(a, otherBlock), false, '同一 Chunk 的相邻块不合并');
  eq(lodMayShareMergedFace(a, crossChunk), false, '跨 Chunk 永不合并');
  /* 负对照:世界坐标相邻 ≠ 同一块 —— 只有 Chunk 键能区分这两件事 */
  eq([a.bx, a.by], [crossChunk.bx, crossChunk.by], '两块在各自 Chunk 里的块坐标**相同**');

  /* 真实地形:两个相邻 Chunk 各自 64 块 ⇒ 128 块,不是 64 块(没有跨块共享) */
  const left = flatChunk('c_0_0', 0, 0);
  const right = tallChunk('c_1_0', 1, 0);
  eq(frameLodMergeBudget([left, right], () => 1).blocks, 128, '两块各自建面,块数相加');
  eq([exactFaces(left, 1).topQuads, exactFaces(right, 1).topQuads], [64, 64]);

  /* 接缝:东邻高一档 ⇒ **高的一侧**自己出 8 个侧面,而不是两块并成一个面 */
  const rightSeam = exactFaces(right, 1, { west: columnTiles(left, 'east') });
  eq([rightSeam.topQuads, rightSeam.sideQuads], [64, 8], '高的一侧:64 顶面 + 8 侧面');
  const leftSeam = exactFaces(left, 1, { east: columnTiles(right, 'west') });
  eq([leftSeam.topQuads, leftSeam.sideQuads], [64, 0], '低的一侧不出侧面(等高/无数据同规则)');
  eq(rightSeam.faceCount, 72, '接缝处的面属于高的一侧,不属于「共享面」');

  /* ★ 注入:判据里丢掉 Chunk 键(「相邻即同块」)⇒ 跨块被误判为可合并 */
  const naive = (x: LodBlockId, y: LodBlockId): boolean => x.bx === y.bx && x.by === y.by;
  eq(naive(a, crossChunk), true, '注入形态:bx/by 相同就当成一块');
  ok(naive(a, crossChunk) !== lodMayShareMergedFace(a, crossChunk),
    '注入必须与产品判据相反 —— 否则这条判据对「丢掉 Chunk 键」是瞎的');
  eq([naive(a, otherBlock), lodMayShareMergedFace(a, otherBlock)], [false, false],
    '同一 Chunk 内的相邻块:朴素判据也说得对(它只错在跨 Chunk)');
});

/* ═════════════ 8. 注入汇总:三条口径同时翻面 ═════════════ */

test('FND101-8 注入:改阈值 / 换插值 / 放宽跨块 —— 三条判据都必须翻红', () => {
  /* 1 改阈值:2 ⇒ 高差 2 的块从 KEEP_DETAIL 变 MERGE */
  eq(lodMergeVerdict(2), 'KEEP_DETAIL', '产品口径');
  eq(lodMergeVerdict(2, 2), 'MERGE', '注入口径:阈值 2');
  eq([lodMergeBudget(twoStepChunk(), 1).lossy, lodMergeBudget(twoStepChunk(), 1, 2).lossy], [1, 0],
    '同一块地形在两个阈值下的 lossy 必须不同');

  /* 2 换插值:那一面换成线性平均色 ⇒ 面级自检与两档对照同时红 */
  const lowTop = facesOf(emitChunkGeometry(twoStepChunk(), 0)).find((f) => isTopFace(f) && mergedZOfFace(f.vertZ) === 0);
  const injected: LodFaceSample = {
    vertZ: [2, 2, 2, 2],
    normal: { x: 0, y: 0, z: 1 },
    color: linearMeanColor([0, 2, 0, 0], true),
  };
  ok(lowTop !== undefined, '需要一张 LOD0 的 z=0 顶面作为对照');
  if (lowTop === undefined) return;
  ok(lodFaceSemantics(injected) !== null, '注入 2:插值色过不了面级自检');
  ok(lodTwoLevelDelta(lowTop, injected) !== null, '注入 2:两档对照必须拒绝插值色');

  /* 3 放宽跨块:丢掉 Chunk 键 ⇒ 跨块被判成可合并(与产品相反) */
  const crossA: LodBlockId = { chunk: 'c_0_0', bx: 7, by: 0 };
  const crossB: LodBlockId = { chunk: 'c_1_0', bx: 7, by: 0 };
  /* 注入形态:判据里丢掉 Chunk 键(「相邻即同块」) */
  const naive = (x: LodBlockId, y: LodBlockId): boolean => x.bx === y.bx && x.by === y.by;
  eq([naive(crossA, crossB), lodMayShareMergedFace(crossA, crossB)], [true, false],
    '注入 3:朴素判据说能合并,产品判据说不能');
  /* 产品的三道结论都在这条跨块对上:不同块、不可共享、且不是同一 Chunk */
  eq([lodMergeScope(crossA, crossB), lodMergeScope(crossA, { chunk: 'c_0_0', bx: 6, by: 0 })],
    ['CROSS_CHUNK', 'OTHER_BLOCK']);
});

report('WS-FND-101');