/**
 * WS-FND-193 / 地形顶面**采样图集**:材质 → 图集格 UV + 「图集未就绪」的退化路径
 *
 * ## 为什么要有这份套件(这一轮要消的东西)
 *
 * 顶面在 WS-FND-180 之后按**材质**着色(铺装 > 地表 > 海拔层),但仍然是**纯色**:
 * 整张 192×192 的世界在屏幕上是 38 种色块(材质表去重后的色数)。owner 的原话是
 * 「还是一堆色块,需要贴图」。本轮把**地砖格**接进片元:片元采样 `uAtlas`,
 * 顶点色降为「材质基色」(它是**乘数**,不是被替代)。
 *
 * ★ 这是**契约反转**(旧契约「片元源码不得含采样器」),反转的理由写在
 *   `client/src/stage/terrain_vcolor.ts` 顶部的「WS-FND-193 契约反转」一节。
 *   反转**没有**放宽的边界(本套件逐条钉住):
 *   · 顶点色仍是材质基色:长度 = 顶点数 × 3、分量 ∈ [0,1]、`vColor` 仍参与输出;
 *   · 采样**必须**被 `uAtlasReady` 门控(图集是运行时 fetch 的,首帧一定还没有 ⇒
 *     无门控的无条件采样这一帧拿到未绑定纹理 ⇒ 地形整片变黑,且不报错);
 *   · 只对**顶面**采样(侧面是地层剖面,与「表面铺了什么」无关)。
 *
 * ## 判据表(每条都带负对照或手算字面量)
 *
 * | # | 判据 | 负对照 / 有牙证明 |
 * |---|------|-------------------|
 * | 1 | `floor=305` ⇒ 4 个顶点落在**该格**的 offset/repeat 矩形内(逐顶点) | 手算字面量 u0=0.35 / 2/3 / 1/18;格号 107 不是 204 |
 * | 2 | `floor=312` ⇒ 矩形**不同**且各自正确 | 两格 u0 必须不同(否则「不同」恒假) |
 * | 3 | `floor=0`(裸地)⇒ 兜底格(具体格号 104 / 物品 302) | 槽位 0 必须**没有**格子(-1),否则兜底与真格子不可区分 |
 * | 4 | 未知 id(9999 / UGC 槽位 50)⇒ **不抛**、走兜底 | `cellIndexFromId(9999) === -1` 也必须为真 |
 * | 5 | `uAtlasReady = 0` 时纯顶点色;顶点色仍在输出 | 装配层默认值必须是 0(删掉那一行同一扫描器报假) |
 * | 6 | 同一 chunk 两次 `emitChunkGeometry` ⇒ UV **逐元素**相同 | 改掉一个分量的样本必须被同一比较抓住 |
 * | 7 | 每个合并块按**自己的**主导格取格子(两种地砖 ⇒ 两种矩形) | 变异:整块用常量格号 ⇒ 本条红(实测见提交说明) |
 * | 8 | 门控存在(= 图集未到丢不开采样) | 变异:删掉 `if (uAtlasReady …)` ⇒ 同一判据报假(实测见提交说明) |
 * | 9 | LOD>0 合并块仍是**一格**铺满(已知取舍)+ 顶点色两条恒等式不放宽 | LOD0/LOD1 面数 256/64 手算 |
 *
 * ## 两处变异实测(判据有牙的自证;命令与真实输出见提交说明)
 *
 * ```text
 * 变异 A:chunk_geometry 里 `terrainAtlasCellOf(c.base, c.floor)` → 常量格号
 *         ⇒ 第 7 条(顶面矩形集合必须是两种)必红
 * 变异 B:terrain_vcolor 里删掉 `if (uAtlasReady > 0.5 && vNormal.z > 0.5) {` 门控
 *         ⇒ 第 8 条(门控判据)必红;第 5 条也红
 * ```
 *
 * 运行:`node tests/WS-FND-193-terrain-atlas-uv.test.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, eq, ok, near, report } from '../shared/testing/harness.ts';

import { BaseFluid, Elevation, packTile } from '../shared/types/tile.ts';
import { CHUNK_SIZE, type ChunkInput } from '../client/src/stage/tile_mesh.ts';
import { emitChunkGeometry, validateChunkGeometry, type ChunkGeometry } from '../client/src/stage/chunk_geometry.ts';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  cellCoordsOf,
  cellIndexFromId,
  offsetRepeatOfCell,
} from '../client/src/stage/assembly_math.ts';
import {
  TERRAIN_ATLAS_FALLBACK_CELL,
  TERRAIN_ATLAS_FALLBACK_ID,
  TERRAIN_COLOR_COMPONENTS,
  TERRAIN_VCOLOR_FRAG,
  TERRAIN_VCOLOR_VERT,
  terrainAtlasCellForFloorSlot,
  terrainAtlasCellOf,
  terrainAtlasSamplingGated,
  terrainShaderSamplesTexture,
} from '../client/src/stage/terrain_vcolor.ts';

/* ─────────────────────────── 基础设施 ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT = join(ROOT, 'client');

const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * 剥掉块注释。**不用正则**是有意的:本文件里要断言的源码含 `/` 与 `*` 的组合,
 * 手写扫描比一条长正则更可控(也避免转义把断言写歪)。
 * 注释里的 `uAtlasReady = 1`(反面例子)会被真的剥掉 —— 否则下面那条「默认值不许是 1」
 * 会被自己的注释撞红。
 */
function stripBlockComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('/*', i);
    if (open < 0) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf('*/', open + 2);
    if (close < 0) {
      out += src.slice(open);
      break;
    }
    i = close + 2;
  }
  return out;
}

interface UvRect {
  offsetU: number;
  offsetV: number;
  repeatU: number;
  repeatV: number;
}

/**
 * 手算的三个矩形(与 `offsetRepeatOfCell` 独立 —— 期望值不引用被测函数,
 * 免得「两边同一个函数」这种形式同义反复;`offsetRepeatOfCell` 的期望在下面逐条 near)。
 *
 * 图集实测:1280×1152、单格 64、20 列 ⇒ 每格 u 宽 = 64/1280 = 0.05,
 * v 高 = 64/1152 = 1/18;行 5 的 y = 320 ⇒ v0 = 1 − 384/1152 = 2/3。
 */
const RECT_305: UvRect = { offsetU: 0.35, offsetV: 2 / 3, repeatU: 0.05, repeatV: 1 / 18 };
const RECT_312: UvRect = { offsetU: 0.7, offsetV: 2 / 3, repeatU: 0.05, repeatV: 1 / 18 };
const RECT_FALLBACK: UvRect = { offsetU: 0.2, offsetV: 2 / 3, repeatU: 0.05, repeatV: 1 / 18 };

/** 全平、同一铺装的 16×16 Chunk(邻块等高 ⇒ **没有侧面** ⇒ 每个 quad 都是顶面) */
function flatPavedChunk(floor: number, key = 'c_flat'): ChunkInput {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packTile({
    elev: Elevation.GROUND, base: BaseFluid.GRASS, floor, wire: 0, obj: 0, meta: 0,
  }));
  return { key, cx: 0, cy: 0, tiles };
}

/**
 * 左半(x < 8)抬高一档(PLATFORM)且铺 312,右半保持 GROUND 铺 305。
 * ⇒ 同一个 chunk 里**两种地砖 + 真的有侧面**(顶面/侧面都进本文件)。
 */
function steppedPavedChunk(key = 'c_step'): ChunkInput {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const high = x < CHUNK_SIZE / 2;
      tiles[y * CHUNK_SIZE + x] = packTile({
        elev: high ? Elevation.PLATFORM : Elevation.GROUND,
        base: BaseFluid.GRASS,
        floor: high ? 12 : 5,
        wire: 0, obj: 0, meta: 0,
      });
    }
  }
  return { key, cx: 0, cy: 0, tiles };
}

/** 第 `faceIndex` 个 quad 的 8 个 UV 分量(4 顶点 × 2) */
function quadUv(g: ChunkGeometry, faceIndex: number): number[] {
  const o = faceIndex * 4 * 2;
  return [
    g.uvs[o]!, g.uvs[o + 1]!,
    g.uvs[o + 2]!, g.uvs[o + 3]!,
    g.uvs[o + 4]!, g.uvs[o + 5]!,
    g.uvs[o + 6]!, g.uvs[o + 7]!,
  ];
}

/** 该 quad 是不是**顶面**(看法线:侧面法线 z = 0,顶面 z = 1;本仓每面一个恒定法线) */
function isTopQuad(g: ChunkGeometry, faceIndex: number): boolean {
  return g.normals[faceIndex * 4 * 3 + 2] === 1;
}

/**
 * 逐顶点比对:4 个顶点的 UV 必须**恰好**落在 `rect` 的四个角上,
 * 顺序 = `chunk_geometry.TOP_CORNERS`((0,0) (1,0) (0,1) (1,1))。
 * 用 `near` 而不是 `eq`:UV 是 float32 落盘再读回的值。
 */
function assertQuadUvIsRect(uv: readonly number[], rect: UvRect, msg: string): void {
  near(uv[0]!, rect.offsetU, 1e-6, `${msg} 顶点0.u`);
  near(uv[1]!, rect.offsetV, 1e-6, `${msg} 顶点0.v`);
  near(uv[2]!, rect.offsetU + rect.repeatU, 1e-6, `${msg} 顶点1.u`);
  near(uv[3]!, rect.offsetV, 1e-6, `${msg} 顶点1.v`);
  near(uv[4]!, rect.offsetU, 1e-6, `${msg} 顶点2.u`);
  near(uv[5]!, rect.offsetV + rect.repeatV, 1e-6, `${msg} 顶点2.v`);
  near(uv[6]!, rect.offsetU + rect.repeatU, 1e-6, `${msg} 顶点3.u`);
  near(uv[7]!, rect.offsetV + rect.repeatV, 1e-6, `${msg} 顶点3.v`);
}

/**
 * 矩形的字符串身份(用于集合比较)。
 *
 * ⚠️ 必须 `toFixed(4)`:UV 是 `Float32Array`,0.7 读回来是 0.699999988079071,
 * 直接拼浮点串会让「同一格的矩形」变成两个键(实测:第 7 条因此误红过一次)。
 * 4 位小数对应 1/1280 的格子精度,足够区分相邻格(每格 0.05)。
 */
function rectKey(rect: UvRect): string {
  return `${rect.offsetU.toFixed(4)},${rect.offsetV.toFixed(4)}`;
}

/** 从**实测到的 4 个 float32 分量**取矩形身份(与 `rectKey` 同一口径) */
function quadRectKey(uv: readonly number[]): string {
  return `${uv[0]!.toFixed(4)},${uv[1]!.toFixed(4)}`;
}

/** float32 读回后的近似相等(1e-6 远小于半格 0.025,又远大于 float32 误差) */
function closeTo(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/* ────────────── 1 / 305(红砖广场)⇒ 该格的矩形 ────────────── */

test('1 floor=305(红砖广场)⇒ 4 个顶点落在该图集格的 offset/repeat 矩形内', () => {
  /* 手算:号段 301..330 的**首格号是 103**(不是 301−101 = 200)⇒ 305 = 103 + 4 = 107;
     格 107 = 列 7 行 5 ⇒ x = 7×64 = 448, y = 5×64 = 320。 */
  eq(cellIndexFromId(305), 107, '305 ⇒ 图集格 107(按 `id−101` 会错到 204)');
  eq(cellCoordsOf(107), { col: 7, row: 5 }, '格 107 = 列 7 行 5');
  ok(107 < ATLAS_COLS * ATLAS_ROWS, '格号必须落在图集网格内');

  const expected = offsetRepeatOfCell(107);
  near(expected.offsetU, RECT_305.offsetU, 1e-12, '手算 u0 = 448/1280 = 0.35');
  near(expected.offsetV, RECT_305.offsetV, 1e-12, '手算 v0 = 1 − 384/1152 = 2/3');
  near(expected.repeatU, RECT_305.repeatU, 1e-12, '手算每格宽 = 64/1280 = 0.05');
  near(expected.repeatV, RECT_305.repeatV, 1e-12, '手算每格高 = 64/1152 = 1/18');

  const g = emitChunkGeometry(flatPavedChunk(5), 0);
  eq(validateChunkGeometry(g), null, '几何自检必须通过');
  eq(g.batch.topQuads, CHUNK_SIZE * CHUNK_SIZE, 'LOD0:16×16 格各一个顶面(样本非空)');
  eq(g.batch.sideQuads, 0, '全平等高 ⇒ 没有侧面 ⇒ 每个 quad 都是顶面(逐块可查)');
  eq(g.uvs.length, g.vertexCount * 2, 'UV 长度 = 顶点数 × 2(既有恒等式,不许放宽)');
  eq(g.colors.length, g.vertexCount * TERRAIN_COLOR_COMPONENTS, '顶点色长度恒等式不许放宽');

  for (let f = 0; f < g.batch.topQuads; f += 1) assertQuadUvIsRect(quadUv(g, f), expected, `第 ${f} 块`);
});

/* ────────────── 2 / 312(球场草皮)⇒ 另一个矩形 ────────────── */

test('2 floor=312(球场草皮)⇒ 矩形与 305 不同,且各自都正确', () => {
  eq(cellIndexFromId(312), 114, '312 ⇒ 图集格 114(= 103 + 11)');
  eq(cellCoordsOf(114), { col: 14, row: 5 }, '格 114 = 列 14 行 5');

  const e305 = offsetRepeatOfCell(107);
  const e312 = offsetRepeatOfCell(114);
  /* ★ 负对照:两格若给出同一个矩形,下面的「不同」断言就恒假 ⇒ 先证明它们真的不同 */
  ok(e305.offsetU !== e312.offsetU, '负对照:305 与 312 的 u offset 必须不同');
  near(e312.offsetU, RECT_312.offsetU, 1e-12, '手算 u0 = 896/1280 = 0.7');
  near(e312.repeatU, RECT_312.repeatU, 1e-12, '手算每格宽 = 0.05');

  const g305 = emitChunkGeometry(flatPavedChunk(5, 'c_305'), 0);
  const g312 = emitChunkGeometry(flatPavedChunk(12, 'c_312'), 0);
  for (let f = 0; f < g312.batch.topQuads; f += 1) assertQuadUvIsRect(quadUv(g312, f), e312, `312 第 ${f} 块`);

  const first305 = quadUv(g305, 0);
  const first312 = quadUv(g312, 0);
  eq(first305[0] !== first312[0], true, '两种地砖的 u0 必须不同(305=0.35 / 312=0.7)');
  eq(first305[1] === first312[1], true, '同一行 ⇒ v0 相同(证明差异来自**格号**而不是随机数)');
});

/* ────────────── 3 / 裸地 ⇒ base 兜底格 ────────────── */

test('3 floor=0(裸地)⇒ 走 base 兜底格(格号钉成字面量)', () => {
  eq(TERRAIN_ATLAS_FALLBACK_ID, 302, '兜底物品 = 302 鹅卵石径(低饱和:乘上去不把材质色带偏)');
  eq(TERRAIN_ATLAS_FALLBACK_CELL, 104, '兜底格号 = 104(列 4 行 5;不是 302−101 = 201)');
  eq(cellIndexFromId(302), 104, '兜底格号必须由号段表算出(与常量同源)');
  eq(terrainAtlasCellForFloorSlot(0), -1, '槽位 0 = 无铺装 ⇒ **没有**格子(否则兜底与真格子不可区分)');
  eq(terrainAtlasCellOf(BaseFluid.GRASS, 0), TERRAIN_ATLAS_FALLBACK_CELL, '裸地 ⇒ 兜底格');
  eq(terrainAtlasCellOf(BaseFluid.GOLD_SAND, 0), TERRAIN_ATLAS_FALLBACK_CELL, '另一种 base 也是同一兜底格');

  const rect = offsetRepeatOfCell(TERRAIN_ATLAS_FALLBACK_CELL);
  near(rect.offsetU, RECT_FALLBACK.offsetU, 1e-12, '手算兜底 u0 = 256/1280 = 0.2');
  const g = emitChunkGeometry(flatPavedChunk(0), 0);
  eq(g.batch.topQuads, CHUNK_SIZE * CHUNK_SIZE, '裸地仍然每格一个顶面');
  for (let f = 0; f < g.batch.topQuads; f += 1) assertQuadUvIsRect(quadUv(g, f), rect, `裸地第 ${f} 块`);
});

/* ────────────── 4 / 未知 id ⇒ 不抛、走兜底 ────────────── */

test('4 未知 id(9999 / UGC 槽位)⇒ 不抛、走兜底', () => {
  eq(cellIndexFromId(9999), -1, '9999 不在图集号段里 ⇒ 表返回 -1(而不是乱指一格)');
  eq(terrainAtlasCellForFloorSlot(9999), -1, '越界槽位 ⇒ 没有格子(不抛)');
  eq(terrainAtlasCellOf(0, 9999), TERRAIN_ATLAS_FALLBACK_CELL, '未知槽位 ⇒ 兜底');
  eq(terrainAtlasCellOf(9999, 0), TERRAIN_ATLAS_FALLBACK_CELL, '未知 base(9999)⇒ 兜底');
  eq(terrainAtlasCellForFloorSlot(50), -1, '槽位 50 = UGC 像素地毯变体(美术在服务器生成的像素纹理里)⇒ 没有格子');

  /* `obj` 里塞 9999:12 位字段会把 9999 截成 1807 —— 无论截成什么,
     UV 都只能由 floor 决定,而且整块几何不许抛 */
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packTile({
    elev: Elevation.GROUND, base: BaseFluid.GRASS, floor: 50, wire: 0, obj: 9999, meta: 0,
  }));
  const g = emitChunkGeometry({ key: 'c_unknown', cx: 0, cy: 0, tiles }, 0);
  eq(validateChunkGeometry(g), null, '坏 id 的 chunk 仍必须过几何自检');
  const rect = offsetRepeatOfCell(TERRAIN_ATLAS_FALLBACK_CELL);
  for (let f = 0; f < g.batch.topQuads; f += 1) assertQuadUvIsRect(quadUv(g, f), rect, `未知 id 第 ${f} 块`);
});

/* ────────────── 5 / 未就绪退化路径(源码级)────────────── */

test('5 uAtlasReady = 0 ⇒ 不采样、退回纯顶点色(且顶点色仍在输出)', () => {
  eq(terrainShaderSamplesTexture(), true, '★ 契约:片元必须采样图集(删掉采样器 = 退回纯色块)');
  eq(terrainAtlasSamplingGated(), true, '★ 契约:采样必须被 uAtlasReady 门控');
  ok(TERRAIN_VCOLOR_FRAG.includes('uniform sampler2D uAtlas;'), '片元必须声明 uAtlas');
  ok(TERRAIN_VCOLOR_FRAG.includes('if (uAtlasReady > 0.5 && vNormal.z > 0.5) {'), '门控那一行必须在');
  ok(TERRAIN_VCOLOR_FRAG.includes('vec3 albedo = vColor;'), '默认 albedo = 顶点色 ⇒ 未就绪时输出纯顶点色');
  ok(TERRAIN_VCOLOR_FRAG.includes('vColor * tex * 2.0'), '顶点色仍是基色,图素只做明暗调制');

  /* 顺序必须:顶点色 → 门控 → 采样(顺序反了就等于「先采样、门控形同虚设」) */
  const albedoAt = TERRAIN_VCOLOR_FRAG.indexOf('vec3 albedo = vColor;');
  const guardAt = TERRAIN_VCOLOR_FRAG.indexOf('if (uAtlasReady > 0.5');
  const sampleAt = TERRAIN_VCOLOR_FRAG.indexOf('texture2D(');
  ok(albedoAt >= 0 && albedoAt < guardAt && guardAt < sampleAt, '顺序必须是 顶点色 → 门控 → 采样');

  /* 顶点阶段:uv 必须真的被读进 varying(声明了不读 = 图集 UV 到不了片元) */
  ok(TERRAIN_VCOLOR_VERT.includes('attribute vec2 uv;'), '顶点源码必须声明 uv');
  ok(TERRAIN_VCOLOR_VERT.includes('vUv = uv;'), '顶点源码必须把 uv 写进 varying');
  eq(TERRAIN_COLOR_COMPONENTS, 3, '锚点:顶点色仍是 3 分量(不许因为贴图改成 4)');

  /* 装配侧:默认必须是「未就绪」;挂 uv 的必须是装配入口(相容层不挂) */
  const asm = stripBlockComments(read(join(CLIENT, 'src/three/stage_assembly.ts')));
  ok(asm.includes('mat.uniforms.uAtlasReady = { value: 0 };'), 'buildTerrainMaterial 必须把 uAtlasReady 默认成 0');
  ok(asm.includes('mat.uniforms.uAtlas = { value: null };'), '必须建 uAtlas 槽位并默认 null');
  ok(asm.includes('geom.setAttribute(TERRAIN_UV_ATTRIBUTE'), '装配入口必须把 uv 挂上几何');
  ok(asm.includes('export function bindTerrainAtlas('), '必须导出 bindTerrainAtlas(img → 纹理)');
  ok(asm.includes('tex.colorSpace = THREE.NoColorSpace;'), '图素是乘数 ⇒ 不解码成线性(否则整片变暗)');

  /* ★ 负对照:同一扫描器对「删掉那一行」的样本必须报假 */
  const tainted = asm.split('mat.uniforms.uAtlasReady = { value: 0 };').join('');
  eq(tainted === asm, false, '负对照样本必须真的变了(替换命中)');
  eq(tainted.includes('mat.uniforms.uAtlasReady = { value: 0 };'), false, '负对照:删掉该行后同一检查必须报假');
});

/* ────────────── 6 / 确定性 ────────────── */

test('6 同一个 chunk 两次 emitChunkGeometry ⇒ UV 逐元素相同', () => {
  const c = steppedPavedChunk();
  const a = emitChunkGeometry(c, 0);
  const b = emitChunkGeometry(c, 0);
  ok(a.batch.sideQuads > 0, '这个样本必须真的有侧面(UV 不止顶面那一种写法)');
  eq(a.uvs.length, b.uvs.length, 'UV 数组长度相同');
  eq(a.uvs.length, a.vertexCount * 2, 'UV 长度恒等式');

  let diff = -1;
  for (let i = 0; i < a.uvs.length; i += 1) {
    if (!Object.is(a.uvs[i], b.uvs[i])) {
      diff = i;
      break;
    }
  }
  eq(diff, -1, `UV 必须逐元素相同(首个不同下标 ${diff})`);

  /* ★ 负对照:同一个比较口径喂给「改掉一个分量」的样本必须命中 —— 证明上面不是恒真 */
  const broken = Float32Array.from(a.uvs);
  broken[0] = broken[0]! + 1;
  let diff2 = -1;
  for (let i = 0; i < broken.length; i += 1) {
    if (!Object.is(broken[i], b.uvs[i])) {
      diff2 = i;
      break;
    }
  }
  eq(diff2, 0, `负对照:改掉一个分量后同一比较必须命中(实测下标 ${diff2})`);
});

/* ────────────── 7 / 反向:按各自的主导格取格子 ────────────── */

test('7 反向(有牙):每个合并块按**自己的**主导格取格子 ⇒ 两种地砖两种矩形', () => {
  const g = emitChunkGeometry(steppedPavedChunk(), 0);
  ok(g.batch.sideQuads > 0, '样本必须有侧面(顺便覆盖「侧面不采样」那一侧的 UV 写法)');

  const e305 = offsetRepeatOfCell(107);
  const e312 = offsetRepeatOfCell(114);
  const seen = new Map<string, number>();
  for (let f = 0; f < g.faceCount; f += 1) {
    if (!isTopQuad(g, f)) continue;
    const uv = quadUv(g, f);
    const key = quadRectKey(uv);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    /* 每一块都必须**恰好**是自己那一格的矩形(不是「大概落在某个矩形里」) */
    const hit = closeTo(uv[0]!, e305.offsetU) ? e305 : closeTo(uv[0]!, e312.offsetU) ? e312 : null;
    if (hit === null) throw new Error(`第 ${f} 块顶面的 UV 起点 (${uv[0]},${uv[1]}) 不是 305/312 任何一格的矩形`);
    assertQuadUvIsRect(uv, hit, `第 ${f} 块`);
  }

  /*
   * ★ 有牙的关键一句:**顶面矩形集合必须恰好是这两种**。
   *   变异实测:把 `chunk_geometry` 的 `terrainAtlasCellOf(c.base, c.floor)` 换成
   *   `terrainAtlasCellOf(0, 5)`(整块用同一个常量格号)⇒ 这里只剩 1 种 ⇒ 本条红。
   */
  eq([...seen.keys()].sort(), [rectKey(e305), rectKey(e312)].sort(),
    `顶面必须同时出现两种地砖的矩形(实测 ${[...seen.keys()].join(' | ')})`);
  eq(seen.size, 2, '恰好两种(常量格号的实现只会剩 1 种)');
  eq([...seen.values()].reduce((s, n) => s + n, 0), CHUNK_SIZE * CHUNK_SIZE, '每格一个顶面都被查到');
});

/* ────────────── 8 / 反向:删掉门控 ⇒ 判据必红 ────────────── */

test('8 反向(有牙):删掉 uAtlasReady 分支 ⇒ 门控判据报假', () => {
  eq(terrainAtlasSamplingGated(), true, '产品源码:采样在门控之内');
  const unguarded = TERRAIN_VCOLOR_FRAG.split('if (uAtlasReady > 0.5 && vNormal.z > 0.5) {').join('{');
  eq(unguarded === TERRAIN_VCOLOR_FRAG, false, '变异样本必须真的变了(替换命中)');
  ok(unguarded.includes('texture2D('), '变异样本**仍然采样**(所以它变红不是因为采样被删掉)');
  eq(terrainAtlasSamplingGated(unguarded), false, '★ 删掉门控后同一判据必须报假(= 那条变异的实测红)');
  eq(terrainAtlasSamplingGated(), true, '产品源码仍报真(判据不是恒假)');
});

/* ────────────── 9 / LOD>0 的取舍 + 顶点色不放宽 ────────────── */

test('9 LOD>0:合并块铺满**一格**(图案放大 merge 倍)+ 顶点色两条恒等式不放宽', () => {
  const g0 = emitChunkGeometry(flatPavedChunk(5, 'c_lod0'), 0);
  const g1 = emitChunkGeometry(flatPavedChunk(5, 'c_lod1'), 1);
  eq(g0.batch.topQuads, 256, 'LOD0(merge=1):16×16 = 256 个顶面');
  eq(g1.batch.topQuads, 64, 'LOD1(merge=2):8×8 = 64 个合并块');

  const rect = offsetRepeatOfCell(107);
  for (let f = 0; f < g1.batch.topQuads; f += 1) assertQuadUvIsRect(quadUv(g1, f), rect, `LOD1 第 ${f} 块`);

  /* 两条既有判据原样成立(长度 + 值域),不许因为贴图而放宽 */
  eq(g1.uvs.length, g1.vertexCount * 2, 'UV 长度 = 顶点数 × 2');
  eq(g1.colors.length, g1.vertexCount * TERRAIN_COLOR_COMPONENTS, '顶点色长度 = 顶点数 × 3');
  for (let i = 0; i < g1.colors.length; i += 1) {
    const v = g1.colors[i]!;
    ok(v >= 0 && v <= 1, `顶点色分量 [${i}] = ${v} 必须在 [0,1]`);
  }
});

report('WS-FND-193');
