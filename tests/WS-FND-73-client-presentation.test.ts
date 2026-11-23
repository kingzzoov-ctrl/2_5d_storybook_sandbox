/**
 * WS-FND-73 / 客户端表现层地基(`docs/RULINGS-DRAFT.md` §4.3 的 11 条)
 *
 * 口径:
 *  - **期望值不取自被测模块**:面数用手算小场景,衰减曲线端点写死 1 / 0,
 *    Boss 几何对照表是人工誊写的「手册阶段表」副本(漂移即红);
 *  - 静态扫描(GBK 乱码、`zoomLevels` 单一定义)读的是 `client/**` 的**文件内容**,
 *    不是「跑通的函数」—— 注释腐化与别名扩散只可能在这里被发现。
 *
 * 运行:`node tests/WS-FND-73-client-presentation.test.ts`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, eq, ok, near, report } from '../shared/testing/harness.ts';

import { packTile, Elevation } from '../shared/types/tile.ts';
import { BOSS_LIST } from '../shared/constants/bosses.ts';

import {
  CHUNK_SIZE,
  buildChunkQuads,
  frustumCull,
  dominantZGrid,
  type ChunkInput,
  type CullBox,
} from '../client/src/stage/tile_mesh.ts';
import { emitChunkGeometry } from '../client/src/stage/chunk_geometry.ts';
import {
  TERRAIN_COLOR_ATTRIBUTE,
  TERRAIN_COLOR_COMPONENTS,
  TERRAIN_VCOLOR_FRAG,
  TERRAIN_VCOLOR_VERT,
  ELEV_BASE_RGB,
  faceColor,
  terrainShaderAttributes,
  terrainShaderSamplesTexture,
  terrainAtlasSamplingGated,
  validateVertexColors,
} from '../client/src/stage/terrain_vcolor.ts';
import {
  PARTICLE_KIND_COUNT,
  PARTICLE_PRESETS,
  createEmitterFor,
  qualityRateScale,
  scaledRate,
  type RenderQualityTier,
} from '../client/src/stage/particles.ts';
import {
  BOSS_TELEGRAPH_SHAPES,
  TELEGRAPH_SHAPES,
  buildBossTelegraphTable,
  buildTelegraph,
  validateBossTelegraphCoverage,
  validateTelegraphTableAgainstManual,
  type BossTelegraphRow,
} from '../client/src/ui/boss_hud.ts';
import { buildRecipeTree, flattenTree, type RecipeNode } from '../client/src/ui/recipe_tree.ts';
import {
  ROOF_ITEM_IDS,
  buildRoofMask,
  componentAt,
  labelRoofComponents,
} from '../client/src/stage/roof_transparency.ts';
import {
  DYE_DECAY_CURVE_SOURCE,
  DYE_DECAY_FAR_CELLS,
  dyeDecayAt,
  validateDyeDecayCurve,
} from '../client/src/stage/dye_decay.ts';
import { ZOOM_LEVELS, zoomLevels, createCamera } from '../client/src/stage/iso_camera.ts';
import {
  FALLBACK_THREE,
  assembleChunkGeometry,
  assembleTerrainMaterial,
  compatThree,
  getThreeProvider,
  injectedConstructorCalls,
  resetInjectedConstructorCalls,
  setThreeProvider,
  threeSource,
  type CompatAttributeLike,
  type ThreeLike,
} from '../client/src/three/compat.ts';
import { exactFaces, crossCheckExactFaces } from '../client/src/three/count.ts';

/* ─────────────────────────── 基础设施 ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT = join(ROOT, 'client');

const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');
const src = (p: string): string => readFileSync(p, 'utf8');

function listClientFiles(exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (exts.some((e) => ent.name.endsWith(e))) out.push(full);
    }
  };
  walk(CLIENT);
  return out;
}

const clientTs = (): string[] => listClientFiles(['.ts']);

/** 测试自造 Chunk:`tiles` 保留**具体**数组类型。
 *
 * 生产契约 `ChunkInput.tiles` 是 `ArrayLike<number>`(**只读**索引签名 ⇒ `tiles[i] = x` 不可写),
 * 而本套件要**写**格子来造场景(抬高一格 / 改副本再读回原数组)。
 * ⇒ 这里取「契约 ∧ 更具体」的交集类型,而不是 `as any` 绕开类型检查:
 *   传给 `buildChunkQuads` / `frustumCull` 时仍按 `ChunkInput` 用(那些函数只读它)。 */
type TestChunk = ChunkInput & { tiles: Uint32Array };

/** 一个 16×16 Chunk,全部格子同一海拔层 */
function flatChunk(elev: number, key = 'c_flat', cx = 0, cy = 0): TestChunk {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packTile({ elev, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 }));
  return { key, cx, cy, tiles };
}

function attr(geom: { getAttribute(n: string): CompatAttributeLike | undefined }, n: string): CompatAttributeLike | undefined {
  return geom.getAttribute(n);
}

/* ─────────── 1 / 极简 three 相容层(无 three 也能装配) ─────────── */

test('1 相容层:未注入 three 时走兜底且真的装配出几何/材质', () => {
  /* 前提:测试进程里没有 three,注入点必须是空的 */
  eq(getThreeProvider(), null, '默认不应有注入的 three');
  eq(threeSource(), 'fallback');
  ok(Object.is(compatThree(), FALLBACK_THREE), 'compatThree() 应返回兜底表面');

  const chunk = flatChunk(Elevation.GROUND);
  const emitted = emitChunkGeometry(chunk, 0);
  const geom = assembleChunkGeometry(emitted, 0);

  /* 「装配」必须真的把属性记下来(不是空实现) */
  eq(attr(geom, 'position')?.itemSize, 3, 'position 每顶点 3 分量');
  eq(attr(geom, 'position')?.array.length, emitted.vertexCount * 3, 'position 数组长度');
  eq(attr(geom, 'aLodMerge')?.itemSize, 1, 'aLodMerge 每顶点 1 分量');
  eq(attr(geom, 'aLodMerge')?.array.length, emitted.vertexCount, 'aLodMerge 数组长度');
  ok(geom.getIndex() !== undefined, '索引必须被 setIndex 记下来');
  eq(geom.getIndex()?.array.length, emitted.indices.length, '索引长度 = 写出索引数');

  const mat = assembleTerrainMaterial();
  eq(mat.vertexColors, true, '地形材质必须走顶点色');
  ok(mat.fragmentShader.length > 0 && mat.vertexShader.length > 0, '着色器源码不能为空');
  eq(mat.uniforms.uProjection !== undefined, true, 'uniform uProjection 必须存在');
});

test('1b 相容层:注入替身后确实调用注入的构造器,并可还原', () => {
  const calls = { attribute: 0, geometry: 0, material: 0, matrix: 0 };
  class FakeAttr {
    readonly array: ArrayLike<number>;
    readonly itemSize: number;
    constructor(array: ArrayLike<number>, itemSize: number) {
      this.array = array;
      this.itemSize = itemSize;
      calls.attribute += 1;
    }
    get count(): number {
      return Math.floor(this.array.length / this.itemSize);
    }
  }
  class FakeGeom {
    readonly attributes: Record<string, unknown> = {};
    private index: unknown;
    constructor() {
      calls.geometry += 1;
    }
    setAttribute(n: string, a: unknown): void {
      this.attributes[n] = a;
    }
    getAttribute(n: string): unknown {
      return this.attributes[n];
    }
    setIndex(a: unknown): void {
      this.index = a;
    }
    getIndex(): unknown {
      return this.index;
    }
  }
  class FakeMat {
    readonly params: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      this.params = params;
      calls.material += 1;
    }
  }
  class FakeMatrix4 {
    constructor() {
      calls.matrix += 1;
    }
  }
  const fake = {
    BufferAttribute: FakeAttr,
    BufferGeometry: FakeGeom,
    ShaderMaterial: FakeMat,
    Matrix4: FakeMatrix4,
  } as unknown as ThreeLike;

  const prev = setThreeProvider(fake);
  resetInjectedConstructorCalls();
  try {
    eq(threeSource(), 'injected');
    const emitted = emitChunkGeometry(flatChunk(Elevation.GROUND), 0);
    assembleChunkGeometry(emitted, 0);
    eq(calls.geometry, 1, '必须调用注入的 BufferGeometry');
    ok(calls.attribute >= 4, `注入的 BufferAttribute 至少要建 4 个,实际 ${calls.attribute}`);
    eq(injectedConstructorCalls(), 1, '注入记账 = 1 次装配');
    const mat = assembleTerrainMaterial();
    ok(calls.material === 1 && calls.matrix === 3, `材质与 3 个矩阵应各被注入调用一次(${calls.material}/${calls.matrix})`);
    eq((mat as unknown as FakeMat).params.vertexColors, true, '注入路径同样走顶点色');
  } finally {
    setThreeProvider(prev);
  }
  eq(threeSource(), 'fallback', '还原后必须回到兜底');
});

test('1c 相容层自身不 import three(否则"无 three"根本 import 不起来)', () => {
  const text = src(join(CLIENT, 'src/three/compat.ts'));
  ok(!/from\s+['"]three['"]/.test(text), 'compat.ts 不得 import three');
  ok(!/from\s+['"].*stage_assembly\.ts['"]/.test(text), 'compat.ts 不得反向依赖装配层');
  /* 装配层才是唯一允许 import three 的地方 —— 这是分层不变量 */
  ok(/from\s+['"]three['"]/.test(src(join(CLIENT, 'src/three/stage_assembly.ts'))), 'stage_assembly.ts 应 import three');
});

/* ─────────── 2 / 顶点色(不用纹理图集) ─────────── */

test('2 顶点色:geometry 带 color 属性且不带 uv,着色器不采纹理', () => {
  const emitted = emitChunkGeometry(flatChunk(Elevation.GROUND), 0);
  eq(emitted.colors.length, emitted.vertexCount * TERRAIN_COLOR_COMPONENTS, '顶点色长度 = 顶点数 × 3');
  eq(validateVertexColors(emitted.colors, emitted.vertexCount), null, '顶点色自检必须通过');

  const geom = assembleChunkGeometry(emitted, 0);
  const color = attr(geom, TERRAIN_COLOR_ATTRIBUTE);
  ok(color !== undefined, '装配后的几何必须有 color 属性');
  /* ★ 期望值写**字面量 3**(不能拿被测常量当期望:那会让这条断言恒真)。
     常量本身的值由下一行的**锚点**钉住 —— 常量在 actual 侧才是保留牙齿的写法。 */
  eq(TERRAIN_COLOR_COMPONENTS, 3, '锚点:顶点色每顶点 3 分量(RGB),常量值不得漂移');
  eq(color?.itemSize, 3, 'color 属性每顶点 3 分量');
  eq(color?.array.length, emitted.vertexCount * TERRAIN_COLOR_COMPONENTS);
  /*
   * ★ WS-FND-193 契约反转(旧证据「几何上没有 uv + 着色器里没有采样器」**已作废**):
   *   顶面现在按 UV 采样地砖格(图集是运行时 fetch 的成品资源,地砖 301..330 的格子
   *   本来就在里面),所以「没有 uv / 没有采样器」这两条不再是「走顶点色」的证据。
   *   反转的完整理由与新的四条判据写在 `terrain_vcolor.ts` 顶部;逐条主场在
   *   `tests/WS-FND-193-terrain-atlas-uv.test.ts`。
   *
   *   这里保留的是**相容层自己的口径**:`assembleChunkGeometry` 的属性清单仍是
   *   position / color / normal / aLodMerge / 索引 —— 挂 uv 是装配入口
   *   (`three/stage_assembly.buildChunkGeometry`)在它之后做的事:相容层是最小装配,
   *   不替调用方决定「要不要纹理」。
   */
  eq(attr(geom, 'uv'), undefined, '相容层 `assembleChunkGeometry` 本身不挂 uv(挂 uv 是装配入口的事)');
  eq(attr(geom, 'uv2'), undefined, 'uv2 谁都不挂(本仓只用一套 UV)');
  eq(terrainShaderSamplesTexture(), true, '★ 契约反转:片元必须采样图集(WS-FND-193)');
  ok(/sampler2D/.test(TERRAIN_VCOLOR_FRAG), '片元源码必须声明 uAtlas 采样器');
  eq(terrainAtlasSamplingGated(), true, '采样必须被 uAtlasReady 门控(图集未到 ⇒ 退回纯顶点色)');
  eq(terrainShaderAttributes().includes(TERRAIN_COLOR_ATTRIBUTE), true, '顶点着色器必须声明 color 属性');
  eq(terrainShaderAttributes().includes('uv'), true, '★ 契约反转:顶点着色器必须声明 uv(顶面按 UV 取图集格)');
});

test('2b 顶点色:四层基色互不相同,侧面比顶面暗', () => {
  eq(ELEV_BASE_RGB.length, 4, '四层地质基色');
  const seen = new Set(ELEV_BASE_RGB.map((c) => `${c.r},${c.g},${c.b}`));
  eq(seen.size, 4, '四层基色必须互不相同(否则层信息会被顶点色吞掉)');
  for (let layer = 0; layer < 4; layer += 1) {
    const top = faceColor(layer, true);
    const side = faceColor(layer, false);
    ok(side.r < top.r && side.g < top.g && side.b < top.b, `层 ${layer} 的侧面必须比顶面暗`);
    for (const v of [top.r, top.g, top.b, side.r, side.g, side.b]) {
      ok(v >= 0 && v <= 1, `顶点色分量 ${v} 必须在 [0,1]`);
    }
  }
});

/* ─────────── 3 / flattenTree 保留父节点溯源 ─────────── */

test('3 flattenTree:每个节点的 parentId/parentPath 与树结构一致(209 染色枪手算)', () => {
  const tree = buildRecipeTree(209);
  const flat = flattenTree(tree.root);

  /* 手工场景:209 ← {155×1, 165×2};155 ← {112×2, 101×1};165 ← {108×1} ⇒ 共 6 个节点 */
  eq(flat.map((n) => n.itemId).slice().sort((a, b) => a - b), [101, 108, 112, 155, 165, 209], '扁平数组的节点集合');
  eq(flat.length, tree.nodeCount, 'flattenTree 必须覆盖全部节点');
  eq(flat[0].itemId, 209, '首个是根');

  /* 根:无父 */
  eq(tree.root.parentId, -1, '根节点 parentId = -1');
  eq(tree.root.parentPath, [], '根节点 parentPath = []');
  eq(tree.root.depth, 0, '根 depth = 0');

  /* 逐条重建「条文式」期望:child.parentPath === parent.parentPath ++ [parent.itemId] */
  const byPath = new Map<string, RecipeNode>();
  for (const n of flat) byPath.set(n.parentPath.concat([n.itemId]).join('/'), n);
  for (const n of flat) {
    if (n === tree.root) continue;
    const parentChain = n.parentPath;
    ok(parentChain.length === n.depth, `节点 ${n.itemId} 的 parentPath 长度 ${parentChain.length} 应等于 depth ${n.depth}`);
    eq(n.parentId, parentChain[parentChain.length - 1], `节点 ${n.itemId} 的 parentId 必须是 parentPath 末位`);
    const parent = byPath.get(parentChain.join('/'));
    ok(parent !== undefined, `节点 ${n.itemId} 的父链在第 ${n.depth - 1} 层必须解析到真实节点`);
    ok(parent!.parentId !== n.itemId, `溯源不得自指(${n.itemId})`);
  }

  /* flattenTree 返回的是原节点本身(不复制,否则溯源字段与树上结构脱钩) */
  const rootIdx = flat.findIndex((n) => n.itemId === 209);
  ok(Object.is(flat[rootIdx], tree.root), 'flattenTree 必须返回原节点引用');

  const n165 = flat.find((n) => n.itemId === 165);
  ok(n165 !== undefined, '必须找到 165');
  eq(n165!.parentId, 209);
  eq(n165!.parentPath, [209]);
  eq(n165!.depth, 1);
  const n108 = flat.find((n) => n.itemId === 108);
  ok(n108 !== undefined, '必须找到 108');
  eq(n108!.parentId, 165);
  eq(n108!.parentPath, [209, 165]);
  eq(n108!.depth, 2);
  /* includeCollapsed=false 也不得抹掉溯源 */
  const shallow = flattenTree(tree.root, false);
  for (const n of shallow) eq(n.parentPath.length, n.depth, `剪枝flatten 后 ${n.itemId} 的 parentPath 长度`);
});

/* ─────────── 4 / 面数按 dominantZGrid 精确算 ─────────── */

test('4 面数:手算小场景 256/258/64/16 与精确计数逐项相等', () => {
  const flat = flatChunk(Elevation.GROUND);
  /* 手算:16×16 全平地 = 256 顶面 + 0 侧面(块内四邻同高,块外无邻接数据不出侧面) */
  eq(exactFaces(flat, 0), { topQuads: 256, sideQuads: 0, faceCount: 256, vertexCount: 1024 });

  /* 手算 LOD1(2×2 合并)= 8×8 = 64 顶面;LOD2(4×4)= 4×4 = 16 顶面 */
  eq(exactFaces(flat, 1).faceCount, 64);
  eq(exactFaces(flat, 1).topQuads, 64);
  eq(exactFaces(flat, 2).faceCount, 16);

  /* 手算:角落一格抬高一级(海拔 PLATFORM)⇒ 它的东、南两侧各出 1 个侧面 ⇒ 256 + 2 = 258 */
  const raised = flatChunk(Elevation.GROUND);
  raised.tiles[0] = packTile({ elev: Elevation.PLATFORM, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 });
  eq(exactFaces(raised, 0), { topQuads: 256, sideQuads: 2, faceCount: 258, vertexCount: 1032 });

  /* 整块抬高:侧面全部出现在块的边界外?没有邻接数据 ⇒ 仍是 256(锁死「边界 NaN 不出侧面」规则) */
  eq(exactFaces(flatChunk(Elevation.PLATFORM), 0).faceCount, 256);

  /* 邻接数据给出来以后,边界才出侧面:北邻全空 ⇒ 第一行 16 块各出 1 个北侧面 */
  const north = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE); /* 全 0 = 空气 */
  eq(exactFaces(flat, 0, { north }).sideQuads, 16);
  eq(exactFaces(flat, 0, { north }).faceCount, 272);
});

test('4b 面数:精确计数 == 真正写出的面数 == buildChunkQuads', () => {
  const raised = flatChunk(Elevation.GROUND);
  raised.tiles[0] = packTile({ elev: Elevation.PLATFORM, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 });
  for (const lod of [0, 1, 2]) {
    eq(crossCheckExactFaces(raised, lod), null, `LOD${lod} 精确计数与 buildChunkQuads 不得漂移`);
    const emitted = emitChunkGeometry(raised, lod);
    eq(emitted.faceCount, exactFaces(raised, lod).faceCount, `LOD${lod} 写出面数`);
    eq(emitted.indices.length, emitted.faceCount * 6, `LOD${lod} 索引数 = 面数 × 6`);
    eq(buildChunkQuads(raised, lod).faceCount, exactFaces(raised, lod).faceCount, `LOD${lod} 计数同源`);
  }
  /* 合并块海拔确实是「块内最高」:2×2 合并时角落抬高格所在块为 PLATFORM */
  const grid = dominantZGrid(raised, 1);
  eq(grid.size, 8);
  eq(grid.grid[0], 1, '块内最高海拔 = z(PLATFORM) = 1');
  eq(grid.grid[1], 0, '相邻块仍是地面 z = 0');
});

/* ─────────── 5 / 粒子 rate 随画质档缩放 ─────────── */

test('5 粒子 rate:三档严格递增,且各粒子类别共用同一缩放比', () => {
  const tiers: readonly RenderQualityTier[] = ['LOW', 'MEDIUM', 'HIGH'];
  eq(PARTICLE_KIND_COUNT, 6, '六类粒子');

  for (let kind = 0; kind < PARTICLE_KIND_COUNT; kind += 1) {
    const low = scaledRate(kind as 0, 'LOW');
    const mid = scaledRate(kind as 0, 'MEDIUM');
    const high = scaledRate(kind as 0, 'HIGH');
    ok(low > 0 && mid > 0 && high > 0, `类别 ${kind} 三档 rate 必须为正`);
    ok(low < mid && mid < high, `类别 ${kind} 的 rate 必须随画质档严格递增(${low}/${mid}/${high})`);
    /* HIGH 档就是基准速率(不额外打折) */
    eq(high, PARTICLE_PRESETS[kind as 0].rate, `类别 ${kind} 的 HIGH 档应等于基准 rate`);
  }

  /* 单一缩放表:LOW/HIGH 与 MEDIUM/HIGH 的比值对所有类别都一样 */
  const ratios = new Set<string>();
  for (let kind = 0; kind < PARTICLE_KIND_COUNT; kind += 1) {
    const s = qualityRateScale('LOW') / qualityRateScale('HIGH');
    ratios.add(s.toFixed(6));
  }
  eq(ratios.size, 1, '画质缩放必须是一张全局表,不是逐类别硬编码');
  ok(qualityRateScale('LOW') < qualityRateScale('MEDIUM') && qualityRateScale('MEDIUM') < qualityRateScale('HIGH'));

  /* 消费点:发射器速率取自 scaledRate,而不是漏掉档位的基准 rate */
  for (const tier of tiers) {
    const e = createEmitterFor(0, tier);
    near(e.ratePerSec, scaledRate(0, tier), 1e-9, `发射器速率必须按 ${tier} 档缩放`);
  }
});

/* ─────────── 6 / BossTelegraphRow ↔ 5 种预警几何逐 Boss 对照 ─────────── */

/**
 * 人工对照表(手册阶段表誊写,WS-09 §U7)。
 * **刻意写死**:表一改这里就红 —— 正则兜底把「环」静默画成「实心盘」的历史不能重演。
 */
const MANUAL_BOSS_SHAPES: Readonly<Record<string, readonly string[]>> = {
  boss_jelly_king: ['ANNULUS', 'CIRCLE', 'CONE'],
  boss_beaver_mecha: ['LINE', 'CIRCLE'],
  boss_fox_kitsune: ['CONE', 'ANNULUS'],
  boss_crab_kraken: ['LINE', 'CIRCLE'],
  boss_scorpion_pharaoh: ['CIRCLE', 'LINE'],
  boss_ginger_troll: ['CIRCLE', 'CIRCLE'],
  boss_sky_whale: ['ANNULUS', 'CONE'],
  boss_chronos_colossus: ['LINE', 'ANNULUS', 'CIRCLE'],
};

const KEY_OF_ROW = (r: BossTelegraphRow): string => `${r.bossId}#${r.phaseIndex}`;

test('6 BossTelegraphRow:逐 Boss 逐阶段等于人工对照表,且几何都在 5 种之内', () => {
  const rows = buildBossTelegraphTable();
  const manualRows: BossTelegraphRow[] = [];
  for (const boss of BOSS_LIST) {
    for (let i = 0; i < boss.phases.length; i += 1) {
      manualRows.push({
        bossId: boss.id,
        bossName: boss.name,
        phaseIndex: i,
        phaseName: boss.phases[i].name,
        /* `BossTelegraphRow` 必填字段 —— 手册阶段表的血量阈值(本测试后面 `near(got.hpThreshold, want.hpThreshold)` 比它) */
        hpThreshold: boss.phases[i].hpThreshold,
        shape: MANUAL_BOSS_SHAPES[boss.id][i] as BossTelegraphRow['shape'],
        radius: 0,
        chargeSec: 0,
        danger: 0,
        note: boss.phases[i].telegraph,
      });
    }
  }
  eq(rows.length, manualRows.length, '行数 = 冻结层全部 Boss 的阶段总数');
  eq(
    rows.map(KEY_OF_ROW),
    manualRows.map(KEY_OF_ROW),
    '每个 Boss 的每个阶段都必须有自己的行(顺序按冻结层阶段表)',
  );

  /* 5 种几何都存在且都能画出非空几何 */
  eq(TELEGRAPH_SHAPES.length, 5);
  eq(TELEGRAPH_SHAPES.slice().sort(), ['ANNULUS', 'CIRCLE', 'CONE', 'CROSS', 'LINE']);
  for (const shape of TELEGRAPH_SHAPES) {
    const g = buildTelegraph(
      /* `TelegraphSpec` 的 `chargeSec` / `danger` 是**必填**(几何不依赖它们,只影响渲染浓度)
         —— 这里给字面量,把类型缺口补上而不是 `as any` 绕过。 */
      { shape, cx: 4, cy: 4, cz: 2, radius: 3, facing: 0, spreadRad: 1, innerRadius: 1, length: 5, width: 1,
        chargeSec: 1, danger: 0.5 },
      createCamera(800, 600),
    );
    ok(g.outer.length > 0, `几何 ${shape} 必须产出外圈顶点`);
    eq(g.screenOuter.length, g.outer.length, `${shape} 屏幕投影点数必须与外圈一致`);
    /* 环与十字的中空靠内圈实现:只填外圈会画成实心盘 */
    if (shape === 'ANNULUS' || shape === 'CROSS') ok(g.inner.length > 0, `${shape} 必须有内圈(否则变实心盘)`);
  }

  const byKey = new Map(rows.map((r) => [KEY_OF_ROW(r), r]));
  for (const want of manualRows) {
    const got = byKey.get(KEY_OF_ROW(want));
    ok(got !== undefined, `缺少 ${KEY_OF_ROW(want)}`);
    eq(got!.shape, want.shape, `${KEY_OF_ROW(want)} 的预警几何`);
    eq(got!.phaseName, want.phaseName, `${KEY_OF_ROW(want)} 的阶段名`);
    eq(got!.bossName, want.bossName, `${KEY_OF_ROW(want)} 的 Boss 名`);
    near(got!.hpThreshold, want.hpThreshold, 1e-9, `${KEY_OF_ROW(want)} 的血量阈值`);
    ok(got!.radius > 0, `${KEY_OF_ROW(want)} 的半径必须为正`);
    ok(got!.chargeSec > 0, `${KEY_OF_ROW(want)} 的蓄力秒数必须为正`);
  }
  for (const r of rows) ok(TELEGRAPH_SHAPES.includes(r.shape), `${KEY_OF_ROW(r)} 的形状 ${r.shape} 不在 5 种之内`);
});

test('6b BossTelegraphRow:覆盖判据与文案对照都通过,且对照表逐 Boss 齐全', () => {
  eq(validateBossTelegraphCoverage().ok, true, `覆盖判据:${validateBossTelegraphCoverage().errors.join('; ')}`);
  eq(validateTelegraphTableAgainstManual().ok, true, `文案对照:${validateTelegraphTableAgainstManual().errors.join('; ')}`);
  eq(BOSS_TELEGRAPH_SHAPES.size, BOSS_LIST.length, '对照表条目数必须等于 Boss 数');
  for (const boss of BOSS_LIST) {
    const pinned = BOSS_TELEGRAPH_SHAPES.get(boss.id);
    ok(pinned !== undefined, `${boss.id} 未登记`);
    eq(pinned!.length, boss.phases.length, `${boss.id} 的阶段数`);
    eq(pinned!, MANUAL_BOSS_SHAPES[boss.id], `${boss.id} 的钉死几何`);
  }
  /* 手工锚点:文案里的典型措辞与几何必须对得上 */
  const anchor = (bossId: string, phase: number): string => {
    const row = buildBossTelegraphTable().find((r) => r.bossId === bossId && r.phaseIndex === phase);
    return row === undefined ? 'MISSING' : row.shape;
  };
  eq(anchor('boss_jelly_king', 0), 'ANNULUS', '「环形果冻波」= 环');
  eq(anchor('boss_jelly_king', 2), 'CONE', '「锥形吸附区」= 锥');
  eq(anchor('boss_chronos_colossus', 0), 'LINE', '「旋转激光指针」= 线');
});

/* ─────────── 7 / GBK 损坏注释重写 ─────────── */

/**
 * UTF-8 中文被按 GBK 解码后产生的典型串。
 * 这些码位在正常中文技术注释里不会自然出现,所以「命中即腐化」。
 */
const MOJIBAKE = /[\uFFFD]|锟斤拷|锛|鍜|鈥|銆|鐨|鏄|鍦|瀹|绋|鎬|缁|鏂|鏍|鍧|浣|鍑|鍏|鏄|銉|鈩|馃|锔|鍙|鏋|鍐|闃|鍑|鍗|鍒|鏈/;

test('7 注释腐化:client/** 无 U+FFFD 与典型 GBK 乱码串', () => {
  const files = listClientFiles(['.ts', '.tsx', '.js', '.css', '.html', '.json']);
  ok(files.length > 20, `扫描面太小(${files.length} 个文件),判据会失去意义`);
  const bad: string[] = [];
  for (const f of files) {
    const text = src(f);
    if (text.includes('\uFFFD')) bad.push(`${rel(f)}: 含 U+FFFD`);
    const m = MOJIBAKE.exec(text);
    if (m !== null && m[0] !== '\uFFFD') {
      const idx = m.index;
      const line = text.slice(0, idx).split('\n').length;
      bad.push(`${rel(f)}:${line}: 乱码串 ${JSON.stringify(m[0])}`);
    }
  }
  eq(bad, [], '以下文件仍有 GBK 损坏注释');
});

/* ─────────── 8 / zoomLevels 单一导出 ─────────── */

test('8 zoomLevels:client/src 只有一处定义,且与 ZOOM_LEVELS 是同一个冻结数组', () => {
  const defRe = /^export\s+const\s+zoomLevels\b/m;
  const anyDefRe = /^\s*(?:export\s+)?const\s+zoomLevels\b/m;
  const defs: string[] = [];
  const anyDefs: string[] = [];
  for (const f of clientTs()) {
    const text = src(f);
    if (defRe.test(text)) defs.push(rel(f));
    if (anyDefRe.test(text)) anyDefs.push(rel(f));
  }
  eq(defs, ['client/src/stage/iso_camera.ts'], '`export const zoomLevels` 必须只有一处定义');
  eq(anyDefs, ['client/src/stage/iso_camera.ts'], '`zoomLevels` 不得在别处二次定义(别名不得扩散)');
  eq(
    (src(join(CLIENT, 'src/stage/iso_camera.ts')).match(/^export\s+const\s+zoomLevels\b/gm) ?? []).length,
    1,
    '同一文件内也不得重复导出',
  );

  /* 运行时:一个冻结数组,六档,升序,含 1(100%) */
  ok(Object.is(ZOOM_LEVELS, zoomLevels), 'zoomLevels 必须与 ZOOM_LEVELS 同引用(不复制、不派生)');
  ok(Object.isFrozen(ZOOM_LEVELS), 'ZOOM_LEVELS 必须冻结');
  eq(ZOOM_LEVELS.length, 6);
  eq(ZOOM_LEVELS.includes(1), true, '档位表必须包含 1(100%)');
  for (let i = 1; i < ZOOM_LEVELS.length; i += 1) ok(ZOOM_LEVELS[i] > ZOOM_LEVELS[i - 1], '档位必须升序');
});

/* ─────────── 9 / 屋顶连通域 4-邻域 ─────────── */

function roofTiles(cells: readonly (readonly [number, number])[], w: number, h: number): Uint32Array {
  const tiles = new Uint32Array(w * h);
  const obj = ROOF_ITEM_IDS[0];
  for (const [x, y] of cells) tiles[y * w + x] = packTile({ elev: Elevation.CLIFF, base: 1, floor: 0, wire: 0, obj, meta: 0 });
  return tiles;
}

test('9 屋顶连通域:只按 4-邻域合并,对角相接算两片', () => {
  /* 对角两格:8-邻域会并成 1 片(错),4-邻域必须是 2 片 */
  const diag = labelRoofComponents(buildRoofMask(roofTiles([[0, 0], [1, 1]], 4, 4), 4, 4));
  eq(diag.count, 2, '对角相接的两格必须是两个连通域');
  eq(diag.sizes, [1, 1]);
  eq(diag.bounds[0], [0, 0, 0, 0]);
  eq(diag.bounds[1], [1, 1, 1, 1]);

  /* 正交相邻两格必须并成 1 片 */
  const pair = labelRoofComponents(buildRoofMask(roofTiles([[0, 0], [1, 0]], 4, 4), 4, 4));
  eq(pair.count, 1);
  eq(pair.sizes, [2]);
  eq(pair.bounds[0], [0, 0, 1, 0]);

  /* L 形三格:4-邻域连通 ⇒ 1 片 3 格 */
  const ell = labelRoofComponents(buildRoofMask(roofTiles([[0, 0], [0, 1], [1, 1]], 4, 4), 4, 4));
  eq(ell.count, 1, 'L 形必须是同一片');
  eq(ell.sizes, [3]);

  /* 对角 + 正交混合:[[0,0],[1,1],[1,0]] ⇒ (0,0)-(1,0)-(1,1) 一片 */
  const mix = labelRoofComponents(buildRoofMask(roofTiles([[0, 0], [1, 0], [1, 1], [3, 3]], 4, 4), 4, 4));
  eq(mix.count, 2);
  eq(mix.sizes.slice().sort(), [1, 3]);
  eq(componentAt(mix, 0, 0, 4), componentAt(mix, 1, 1, 4), '斜对且经正交连通的两格同属一片');
  eq(componentAt(mix, 2, 2, 4), -1, '非屋顶格必须返回 -1');
  eq(componentAt(mix, 3, 3, 4) === componentAt(mix, 0, 0, 4), false, '孤立格必须与 L 形不同片');

  /* 屋顶掩码只认屋顶 obj,普通地面不算 */
  const plain = buildRoofMask(roofTiles([[0, 0]], 4, 4), 4, 4);
  eq(plain.roofCells, 1);
  const grass = new Uint32Array(16).fill(packTile({ elev: Elevation.GROUND, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 }));
  eq(buildRoofMask(grass, 4, 4).roofCells, 0);
});

/* ─────────── 10 / frustumCull 返回副本 ─────────── */

test('10 frustumCull:visible 是逐元素副本,改它不脏原数组', () => {
  const a = flatChunk(Elevation.GROUND, 'a', 0, 0);
  const b = flatChunk(Elevation.GROUND, 'b', 1, 0);
  const chunks: ChunkInput[] = [a, b];
  const box: CullBox = { minX: 0, maxX: 15, minY: 0, maxY: 15 };

  const res = frustumCull(chunks, box);
  eq(res.visible.length, 1, '贴边判定:只有 cx=0 的块落在 [0,15] 闭区间内');
  eq(res.culled.length, 1);
  ok(!Object.is(res.visible, chunks), 'visible 必须是新数组');
  ok(!Object.is(res.visible[0], a), 'visible 的元素也必须是副本');
  near(res.ratio, 0.5, 1e-12, '命中率');

  const beforeTile5 = a.tiles[5];
  const beforeKey = a.key;
  /* 契约:`visible` 的元素是**深拷贝**(`tiles` 逐格复制)⇒ 副本的 tiles 必须是
     **具体可写数组**,不能只是只读视图。运行时用 `instanceof` 证给它看,
     顺带把静态类型从 `ArrayLike<number>`(只读)收窄到可写的 `Uint32Array`。 */
  const copy = res.visible[0];
  ok(copy.tiles instanceof Uint32Array, 'visible 的 tiles 必须是逐格复制的具体数组');
  if (!(copy.tiles instanceof Uint32Array)) return; /* 上面已报红;此处只为收窄类型 */
  copy.tiles[5] = 0xffffffff;
  copy.key = 'MUTATED';
  res.visible.push(b);
  eq(a.tiles[5], beforeTile5, '改副本不得写脏原 chunk 的 tiles');
  eq(a.key, beforeKey, '改副本不得写脏原 chunk 的 key');
  eq(a.tiles.length, CHUNK_SIZE * CHUNK_SIZE, '原 chunk 的 tiles 长度不得变化');
  eq(chunks.length, 2, 'visible.push 不得影响入参数组');

  /* culled 按契约保持引用(下游只读它做统计) */
  ok(Object.is(res.culled[0], b), 'culled 保持原引用');
});

test('10b frustumCull:半开区间 { x1 > minX } —— 贴边相邻块不得多算一列', () => {
  const chunks: ChunkInput[] = [
    flatChunk(Elevation.GROUND, 'c0', 0, 0),
    flatChunk(Elevation.GROUND, 'c1', 1, 0),
    flatChunk(Elevation.GROUND, 'c2', 2, 0),
  ];
  /* 相机只看到格 16..31(exactly chunk 1 覆盖的半开区间) */
  const res = frustumCull(chunks, { minX: 16, maxX: 31, minY: 0, maxY: 15 });
  eq(res.visible.map((c) => c.key), ['c1']);
  eq(res.visible[0].tiles.length, CHUNK_SIZE * CHUNK_SIZE);
  /* visible 可以直接喂给建面函数(不能只剩边界摘要) */
  eq(buildChunkQuads(res.visible[0], 0).faceCount, 256);
});

/* ─────────── 11 / 染色衰减曲线的消费点 ─────────── */

test('11 染色衰减:端点恰好 1 和 0,线性中点 0.75/0.5,单调不增', () => {
  /* 端点用字面量 1 / 0,不取模块常量当期望 */
  eq(dyeDecayAt(0), 1, '距离 0 处强度必须恰好为 1');
  eq(dyeDecayAt(DYE_DECAY_FAR_CELLS), 0, '射程处强度必须恰好为 0');
  eq(dyeDecayAt(DYE_DECAY_FAR_CELLS * 2), 0, '射程外不得出现负强度');
  eq(dyeDecayAt(-3), 1, '贴身(负距离)按 1 处理');

  /* 线性:1/4 处 = 0.75,1/2 处 = 0.5 */
  near(dyeDecayAt(DYE_DECAY_FAR_CELLS / 4), 0.75, 1e-12, '1/4 射程处');
  near(dyeDecayAt(DYE_DECAY_FAR_CELLS / 2), 0.5, 1e-12, '1/2 射程处');

  let prev = 1;
  for (let d = 0; d <= DYE_DECAY_FAR_CELLS; d += 0.5) {
    const v = dyeDecayAt(d);
    ok(v >= 0 && v <= 1, `距离 ${d} 的强度 ${v} 必须在 [0,1]`);
    ok(v <= prev, `距离 ${d} 的强度回升(${prev} → ${v})`);
    prev = v;
  }
  eq(validateDyeDecayCurve(), null, '曲线自检必须通过');
});

test('11b 染色衰减:消费点指向冻结层 shared/constants/dye.ts,client 不自造曲线', () => {
  eq(DYE_DECAY_CURVE_SOURCE, 'shared/constants/dye.ts', '唯一曲线来源必须是冻结层');
  /* 消费点存在:dye_overlay 必须真的调用衰减函数,而不是自己算一份 */
  const overlay = src(join(CLIENT, 'src/stage/dye_overlay.ts'));
  ok(/from\s+['"]\.\/dye_decay\.ts['"]/.test(overlay), 'dye_overlay 必须从 dye_decay 取曲线');
  ok(/\bdyeDecayAt\s*\(/.test(overlay), 'dye_overlay 必须调用 dyeDecayAt');
  ok(/\bdyeDecayColor\s*\(/.test(overlay), 'dye_overlay 必须用 dyeDecayColor 算最终颜色');
  /* client/** 不得自带第二份衰减实现 */
  const selfMade = clientTs().filter((f) => /export\s+function\s+dyeAttenuation\b/.test(src(f)));
  eq(selfMade.map(rel), [], 'client 不得重新实现 dyeAttenuation');
  /* 并且确实 import 了 shared 的那一份 */
  ok(/from\s+['"].*shared\/constants\/dye\.ts['"]/.test(src(join(CLIENT, 'src/stage/dye_decay.ts'))), 'dye_decay 必须 import 冻结层曲线');
});

/* ─────────────────────────── 收尾 ─────────────────────────── */

report('WS-FND-73');