/**
 * WS-FND-89 / 地形顶点色**真的接线了**(审计 P1,客户端)
 *
 * ## 这份套件要抓的两个「判据全绿但真机坏」的缺陷
 *
 * 1. `client/src/three/boot.ts` 的地形材质曾经是
 *    `new THREE.MeshLambertMaterial({ color: 0x9fd6a0 })` —— `vertexColors` 默认
 *    `false`,几何上那份 `color` 属性**没有任何读者**,真机恒为一块单色;
 *    而 `WS-FND-73` 的顶点色判据(长度 / 值域 / 没有采样器)全绿 ——
 *    它们查的是**几何与常量**,不是「谁在读它」。
 *    同时装配层的 `buildTerrainMaterial()`(它才是 `vertexColors: true` 的那条路)
 *    在 `client/src` 里**零调用点**。
 *
 * 2. `client/src/stage/terrain_vcolor.ts` 的顶点源码自带
 *    `attribute vec3 position/normal/color`,而唯一消费者用的是 `ShaderMaterial` ——
 *    three 会**再注入一遍** `position`/`normal`/`uv`(开了 `vertexColors` 还注入
 *    `color`),GLSL 同名重定义 ⇒ 编译失败 ⇒ 地形整块不显示,且**不抛异常**。
 *    `stage/shaders.ts` 的顶点源码(水面/冰砖等)是同型问题。
 *
 * ## 判据口径(每条都带**负对照**:检测器必须能对「坏样本」报红)
 *
 * | # | 判据 | 负对照(证明这条有牙齿) |
 * |---|------|--------------------------|
 * | 1 | 重定义检测器对「自包含源码 + ShaderMaterial」必红,对 managed 版必绿 | 坏样本必须被抓到;自定义属性 `aLodMerge` 不得被误报;重复声明不得被去重吞掉 |
 * | 2 | `color` 真的被消费(几何属性 ↔ 着色器声明 ↔ 片元乘法),且顶点色带信息 | `aLodMerge` 几何里有、着色器里没有 ⇒ 检测器不是恒真 |
 * | 3 | 有 `RawShaderMaterial` 时装配**真的**调它(注入记账) | 注入前后 `threeSource()` 必须变化 |
 * | 4 | 没有 three(兜底)仍可装配,且兜底材质也是 raw | 兜底必须报 `isRawShaderMaterial === true`,否则判据在无 three 环境下会放水 |
 * | 5 | 只有 `ShaderMaterial` 的极简替身 ⇒ 自动换 managed 源码(仍无重定义) | 换的是**另一份**源码,不是同一份照发 |
 * | 6 | `buildTerrainMaterial()` 有生产调用点、boot 不再用单色 Lambert、矩阵每帧上传 | 旧写法样本必须被同一个扫描器抓到 |
 * | 7 | `stage/shaders.ts` 的同型问题不再活着(装配层走 raw + 补 precision) | `VERT_WATER_RIPPLE` 必须仍会被检测器判重定义(否则第 7 条无意义) |
 *
 * 运行:`node tests/WS-FND-89-client-vertexcolor.test.ts`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, eq, ok, report } from '../shared/testing/harness.ts';

import { BaseFluid, Elevation, packTile } from '../shared/types/tile.ts';
import { CHUNK_SIZE, type ChunkInput } from '../client/src/stage/tile_mesh.ts';
import { emitChunkGeometry, validateChunkGeometry } from '../client/src/stage/chunk_geometry.ts';
import {
  TERRAIN_COLOR_ATTRIBUTE,
  TERRAIN_COLOR_COMPONENTS,
  TERRAIN_VCOLOR_FRAG,
  TERRAIN_VCOLOR_VERT,
  TERRAIN_VCOLOR_VERT_MANAGED,
  THREE_MANAGED_ATTRIBUTES,
  duplicatedManagedAttributes,
  parseAttributeDeclarations,
  terrainShaderAttributes,
  terrainShaderSamplesTexture,
} from '../client/src/stage/terrain_vcolor.ts';
import { VERT_WATER_RIPPLE } from '../client/src/stage/shaders.ts';
import {
  FALLBACK_THREE,
  assembleChunkGeometry,
  assembleTerrainMaterial,
  getThreeProvider,
  injectedConstructorCalls,
  resetInjectedConstructorCalls,
  setThreeProvider,
  threeSource,
  type CompatAttributeLike,
  type CompatGeometryLike,
  type CompatMaterialLike,
  type ThreeLike,
} from '../client/src/three/compat.ts';

/* ─────────────────────────── 基础设施 ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT = join(ROOT, 'client');

const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');
const read = (p: string): string => readFileSync(p, 'utf8');

interface ClientFile {
  readonly path: string;
  readonly text: string;
}

/** 递归读 `client/src/**\/*.ts`(与 WS-FND-73 同一口径:`node_modules` / `.git` 跳过) */
function clientSources(): ClientFile[] {
  const out: ClientFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.ts')) out.push({ path: rel(full), text: read(full) });
    }
  };
  walk(join(CLIENT, 'src'));
  return out;
}

/** 一个 16×16 同海拔 Chunk(与 `WS-FND-73` 的 `flatChunk` 同形) */
function flatChunk(elev: number, key = 'c_flat'): ChunkInput {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packTile({ elev, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 }));
  return { key, cx: 0, cy: 0, tiles };
}

/**
 * 两档海拔的 Chunk:右半抬高一层,**两半的地表材质也不同**(GRASS / GOLD_SAND)。
 *
 * 为什么要单调海拔**不够**:全平的块只有顶面,顶点色只有一种取值 ——
 * 「颜色有没有被消费」在那种几何上分辨不出来(侧面亮度档不会出现)。
 *
 * ★ 为什么两半的 `base` 也要不同(WS-FND-180):顶面颜色已改由格子的
 *   `base`/`floor` 决定(`terrain_vcolor.topColorOf`),不再由海拔层决定。
 *   若两半都写 `base: 1`,顶面只有一种颜色、侧面只有高档那一侧的暗档 ⇒ 只剩 2 种取值,
 *   这条「顶点色带信息」的判据就会误红(它测的是「颜色有没有分辨力」,不是「是否按层」)。
 */
function steppedChunk(): ChunkInput {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const left = x < CHUNK_SIZE / 2;
      const elev = left ? Elevation.GROUND : Elevation.PLATFORM;
      const base = left ? BaseFluid.GRASS : BaseFluid.GOLD_SAND;
      tiles[y * CHUNK_SIZE + x] = packTile({ elev, base, floor: 0, wire: 0, obj: 0, meta: 0 });
    }
  }
  return { key: 'c_step', cx: 0, cy: 0, tiles };
}

function attrOf(
  geom: CompatGeometryLike,
  name: string,
): CompatAttributeLike | undefined {
  return geom.getAttribute(name);
}

/** 同一属性**声明了两次以上**的名字(与 three 注入无关的「自己重定义自己」) */
function selfDuplicates(src: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of parseAttributeDeclarations(src)) {
    if (seen.has(name)) dup.add(name);
    else seen.add(name);
  }
  return [...dup];
}

/**
 * 去掉 `//` 与 `块` 注释(注释里的**历史写法**不是代码,扫描时必须剥掉)。
 *
 * `boot.ts` 的 docblock 会刻意引用被删掉的旧代码(那是取证价值),不剥注释就会
 * 把「注释里提到旧写法」误判成「代码还在用旧写法」。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/* ─────────────────── 1 / 重定义检测器(先证它有牙齿) ─────────────────── */

test('1 负对照:自包含源码配 ShaderMaterial 必红,managed 版必绿', () => {
  /* 前提:three 注入的那几个名字就是这三+uv —— 常量本身钉成字面量,防漂移 */
  eq([...THREE_MANAGED_ATTRIBUTES], ['position', 'normal', 'uv', 'color']);

  /* 「坏样本」:自包含源码三名全声明 ⇒ 配 `ShaderMaterial` 就是重定义 */
  const dup = duplicatedManagedAttributes(TERRAIN_VCOLOR_VERT);
  eq(dup.sort(), ['color', 'normal', 'position'], `自包含源码必须被判为重定义(实测 ${dup.join(',')})`);

  /* managed 版:three 已注入,源码里一个都不许再声明 */
  eq(duplicatedManagedAttributes(TERRAIN_VCOLOR_VERT_MANAGED), [],
    'managed 版不得声明任何 three 会注入的属性');

  /* ★ 负对照一:剥离的是**声明**,不是使用点 —— 三个名字必须还在被用 */
  ok(/vColor\s*=\s*color\s*;/.test(TERRAIN_VCOLOR_VERT_MANAGED), 'managed 版仍要读 color 属性');
  ok(/vNormal\s*=\s*normal\s*;/.test(TERRAIN_VCOLOR_VERT_MANAGED), 'managed 版仍要读 normal 属性');
  ok(/vec4\(\s*position\s*,\s*1\.0\s*\)/.test(TERRAIN_VCOLOR_VERT_MANAGED), 'managed 版仍要读 position 属性');

  /* ★ 负对照二:自定义属性不得被误报(否则检测器就是「凡属性皆红」) */
  eq(duplicatedManagedAttributes('attribute float aLodMerge;'), [],
    '自定义属性不是 three 注入的,不该判重定义');

  /* ★ 负对照三:同名声明两次必须原样留在解析结果里(去重会吃掉真缺陷) */
  eq(parseAttributeDeclarations('attribute vec3 position;\nattribute vec3 position;').length, 2,
    '重复声明必须是 2 条(解析器不得去重)');
});

/* ─────────────────── 2 / 颜色真的被消费 ─────────────────── */

test('2 颜色真的被消费:几何属性 → 着色器声明 → 片元,且顶点色带信息', () => {
  /* ★ 用**两档海拔**的块:单调海拔只有顶面,顶点色只会有一个取值 ——
     在那种几何上「颜色有没有被消费」分辨不出来(见 `steppedChunk` 的注释) */
  const emitted = emitChunkGeometry(steppedChunk(), 0);
  eq(validateChunkGeometry(emitted), null, '几何自检必须通过(含顶点色)');

  const geom = assembleChunkGeometry(emitted, 0);
  const color = attrOf(geom, TERRAIN_COLOR_ATTRIBUTE);
  ok(color !== undefined, '装配后的几何必须带 color 属性(否则着色器读不到任何颜色)');
  /* ★ 期望值一律写**字面量** —— `eq(actual, TERRAIN_COLOR_COMPONENTS)` 是把
     被测常量搬到期望槽位,实现改成 4 也照样绿(判据同义反复)。
     常量本身只在下面这一条里当**锚点**被钉住(actual 槽位,方向相反)。 */
  eq(TERRAIN_COLOR_COMPONENTS, 3, '锚点:color 每顶点 3 分量(常量本身钉成字面量)');
  eq(color?.itemSize, 3, 'color 每顶点 3 分量(字面量,不引用被测常量)');
  eq(color?.array.length, emitted.vertexCount * 3, 'color 长度 = 顶点数 × 3');

  /* 顶点色必须**带信息**:全同值的实现会让「颜色被消费」无从分辨 */
  const seen = new Set<string>();
  const arr = color?.array ?? [];
  for (let i = 0; i + 2 < arr.length; i += 3) {
    seen.add(`${arr[i]},${arr[i + 1]},${arr[i + 2]}`);
  }
  ok(seen.size >= 3, `顶点色至少要有 3 种取值(两层 × 顶/侧 × 两种地表;实测 ${seen.size})`);

  /* ★ 负对照:同一个统计口径喂给**单调海拔**的块必须只剩 1 种取值 ——
     证明上面那个 `>= 3` 真的在分辨「带不带信息」,而不是恒真 */
  const flat = emitChunkGeometry(flatChunk(Elevation.GROUND), 0);
  const flatSeen = new Set<string>();
  for (let i = 0; i + 2 < flat.colors.length; i += 3) {
    flatSeen.add(`${flat.colors[i]},${flat.colors[i + 1]},${flat.colors[i + 2]}`);
  }
  eq(flatSeen.size, 1, `单调海拔只剩顶面 ⇒ 只有 1 种顶点色(实测 ${flatSeen.size})`);

  /* 属性名对齐:几何上的 `color` 就是着色器声明的那一个 */
  const declared = terrainShaderAttributes();
  eq(declared.includes(TERRAIN_COLOR_ATTRIBUTE), true, '顶点着色器必须声明 color 属性');
  eq(declared.includes('uv'), false, '顶点着色器不得声明 uv(顶点色路径不传图集坐标)');

  /* ★ 负对照:几何上还有 `aLodMerge`,它**不在**声明里 ——
     证明「属性名对齐」这条检查不是「什么都对得上」 */
  ok(attrOf(geom, 'aLodMerge') !== undefined, '几何上确实有 aLodMerge');
  eq(declared.includes('aLodMerge'), false, 'aLodMerge 不该出现在地形顶点着色器里(负对照)');
  eq(THREE_MANAGED_ATTRIBUTES.includes('aLodMerge'), false, 'aLodMerge 也不是 three 注入的(负对照)');

  /* 链路两端:顶点着色器把属性写进 varying,片元把 varying 乘进颜色 */
  ok(/vColor\s*=\s*color\s*;/.test(TERRAIN_VCOLOR_VERT), '顶点阶段:vColor = color(属性真的被读)');
  ok(/vColor\s*\*/.test(TERRAIN_VCOLOR_FRAG), '片元阶段:vColor 参与颜色计算(不是死 varying)');
  eq(terrainShaderSamplesTexture(), false, '顶点色路径不得采样纹理');
});

/* ─────────────────── 3 / 注入验证:raw 优先 ─────────────────── */

test('3 装配:有 RawShaderMaterial 时真的调 raw(注入记账 + 参数检查)', () => {
  const calls = { raw: 0, managed: 0, matrix: 0, attr: 0, geom: 0 };
  let rawParams: Record<string, unknown> = {};

  class FakeAttr implements CompatAttributeLike {
    readonly array: ArrayLike<number>;
    readonly itemSize: number;
    constructor(array: ArrayLike<number>, itemSize: number) {
      this.array = array;
      this.itemSize = itemSize;
      calls.attr += 1;
    }
    get count(): number {
      return Math.floor(this.array.length / this.itemSize);
    }
  }
  class FakeGeom implements CompatGeometryLike {
    readonly attributes: Record<string, CompatAttributeLike> = {};
    setAttribute(n: string, a: CompatAttributeLike): void {
      this.attributes[n] = a;
    }
    getAttribute(n: string): CompatAttributeLike | undefined {
      return this.attributes[n];
    }
    setIndex(a: CompatAttributeLike): void {
      this.attributes.__index = a;
      calls.geom += 1;
    }
    getIndex(): CompatAttributeLike | undefined {
      return this.attributes.__index;
    }
  }
  class FakeMat implements CompatMaterialLike {
    readonly params: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      this.params = params;
    }
    /* 极简替身不模拟 three 的字段语义 —— 判据只用 `params` */
    get name(): string {
      return typeof this.params.name === 'string' ? this.params.name : '';
    }
    get vertexColors(): boolean {
      return this.params.vertexColors === true;
    }
    get uniforms(): Record<string, { value: unknown }> {
      return (this.params.uniforms as Record<string, { value: unknown }> | undefined) ?? {};
    }
    get vertexShader(): string {
      return typeof this.params.vertexShader === 'string' ? this.params.vertexShader : '';
    }
    get fragmentShader(): string {
      return typeof this.params.fragmentShader === 'string' ? this.params.fragmentShader : '';
    }
  }
  class FakeMatrix4 {
    constructor() {
      calls.matrix += 1;
    }
  }

  const fake: ThreeLike = {
    BufferAttribute: FakeAttr,
    BufferGeometry: FakeGeom,
    /* 非 raw 构造器也记账:它被调用就说明 three 会再注入一遍内建属性 */
    ShaderMaterial: class extends FakeMat {
      constructor(params: Record<string, unknown>) {
        super(params);
        calls.managed += 1;
      }
    },
    Matrix4: FakeMatrix4,
    /* 真 three 的形状:raw 构造器存在 */
    RawShaderMaterial: class extends FakeMat {
      constructor(params: Record<string, unknown>) {
        super(params);
        calls.raw += 1;
        rawParams = params;
      }
      get isRawShaderMaterial(): boolean {
        return true;
      }
    },
  };

  const prev = setThreeProvider(fake);
  resetInjectedConstructorCalls();
  try {
    eq(threeSource(), 'injected', '注入后必须走注入路径(负对照:与兜底可分辨)');
    const mat = assembleTerrainMaterial();
    eq(calls.raw, 1, 'raw 构造器必须被调用恰好 1 次');
    eq(calls.managed, 0, 'ShaderMaterial 构造器不得被调用(它会再注入一遍内建属性)');
    ok(calls.matrix === 3, `三个矩阵 uniform 应各被构造一次(实测 ${calls.matrix})`);
    eq(injectedConstructorCalls(), 1, '注入记账 = 1 次装配');
    eq(rawParams.vertexColors, true, '注入路径同样走顶点色');
    eq(rawParams.vertexShader, TERRAIN_VCOLOR_VERT, 'raw 路径必须用自包含源码');
    eq(rawParams.fragmentShader, TERRAIN_VCOLOR_FRAG, '片元源码同一份');
    /* raw 材料 three 不注入 ⇒ 这份源码**必须**自带声明,且每个名字只声明一次 */
    eq(parseAttributeDeclarations(mat.vertexShader).sort(), ['color', 'normal', 'position'],
      'raw 源码必须自带三个内建属性的声明(与 raw 材料配对)');
    eq(selfDuplicates(mat.vertexShader), [], 'raw 源码不得把同一属性声明两次');
    eq(parseAttributeDeclarations(mat.fragmentShader), [], '片元源码没有属性声明');
  } finally {
    setThreeProvider(prev);
    resetInjectedConstructorCalls();
  }
  eq(threeSource(), 'fallback', '还原后必须回到兜底');
  eq(getThreeProvider(), null, '测试进程里不该残留注入');
});

/* ─────────────────── 4 / 无 three 仍可装配 ─────────────────── */

test('4 无 three(兜底)仍可装配,且兜底材质也是 raw', () => {
  eq(getThreeProvider(), null, '前提:本测试进程没有注入的 three');
  eq(threeSource(), 'fallback');

  const mat = assembleTerrainMaterial();
  eq(mat.isRawShaderMaterial, true,
    '兜底也必须是 raw:否则「three 会注入内建」的前提在无 three 环境里被悄悄当成真,判据放水');
  eq(mat.vertexColors, true, '兜底材质必须走顶点色');
  eq(mat.vertexShader, TERRAIN_VCOLOR_VERT, '兜底用自包含源码(与真机同一条路)');
  eq(parseAttributeDeclarations(mat.vertexShader).sort(), ['color', 'normal', 'position'],
    '兜底 raw 源码自带三个内建声明');
  eq(selfDuplicates(mat.vertexShader), [], '兜底路径不得自重定义');
  /* raw 也不注入矩阵 ⇒ 三个矩阵 uniform 必须由装配层建出来(每帧再上传) */
  ok(mat.uniforms.uProjection !== undefined, 'uProjection 必须存在');
  ok(mat.uniforms.uView !== undefined, 'uView 必须存在');
  ok(mat.uniforms.uModel !== undefined, 'uModel 必须存在');
  ok(Object.is(FALLBACK_THREE.RawShaderMaterial !== undefined, true), '兜底表面必须提供 RawShaderMaterial');
});

/* ─────────────────── 5 / 极简替身(只有 ShaderMaterial) ─────────────────── */

test('5 只有 ShaderMaterial 的替身:自动换 managed 源码,仍无重定义', () => {
  const seen: Record<string, unknown>[] = [];

  class Attr implements CompatAttributeLike {
    readonly array: ArrayLike<number>;
    readonly itemSize: number;
    constructor(array: ArrayLike<number>, itemSize: number) {
      this.array = array;
      this.itemSize = itemSize;
    }
    get count(): number {
      return Math.floor(this.array.length / this.itemSize);
    }
  }
  class Geom implements CompatGeometryLike {
    readonly attributes: Record<string, CompatAttributeLike> = {};
    setAttribute(n: string, a: CompatAttributeLike): void {
      this.attributes[n] = a;
    }
    getAttribute(n: string): CompatAttributeLike | undefined {
      return this.attributes[n];
    }
    setIndex(a: CompatAttributeLike): void {
      this.attributes.__index = a;
    }
    getIndex(): CompatAttributeLike | undefined {
      return this.attributes.__index;
    }
  }
  class Mat implements CompatMaterialLike {
    readonly params: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      this.params = params;
      seen.push(params);
    }
    get name(): string {
      return typeof this.params.name === 'string' ? this.params.name : '';
    }
    get vertexColors(): boolean {
      return this.params.vertexColors === true;
    }
    get uniforms(): Record<string, { value: unknown }> {
      return (this.params.uniforms as Record<string, { value: unknown }> | undefined) ?? {};
    }
    get vertexShader(): string {
      return typeof this.params.vertexShader === 'string' ? this.params.vertexShader : '';
    }
    get fragmentShader(): string {
      return typeof this.params.fragmentShader === 'string' ? this.params.fragmentShader : '';
    }
  }
  class M4 {
    readonly kind = 'mat4';
  }

  const legacy: ThreeLike = {
    BufferAttribute: Attr,
    BufferGeometry: Geom,
    ShaderMaterial: Mat,
    Matrix4: M4,
    /* 刻意**不给** RawShaderMaterial —— 与 `tests/WS-FND-73` 的替身同形 */
  };

  const prev = setThreeProvider(legacy);
  try {
    const mat = assembleTerrainMaterial();
    eq(seen.length, 1, 'ShaderMaterial 构造器必须被调用 1 次');
    eq(mat.vertexColors, true, '非 raw 路径同样走顶点色');
    eq(mat.vertexShader, TERRAIN_VCOLOR_VERT_MANAGED,
      '非 raw 路径必须换成 managed 源码(内建声明已剥离)');
    ok(mat.vertexShader !== TERRAIN_VCOLOR_VERT,
      '负对照:必须换过源码 —— 同一份照发就是重定义');
    eq(duplicatedManagedAttributes(mat.vertexShader), [], 'managed 源码配 ShaderMaterial:无重定义');
    /* 两条路径的差异只有声明行:使用点逐个仍在 */
    ok(/vColor\s*=\s*color\s*;/.test(mat.vertexShader), 'managed 版仍在读 color');
  } finally {
    setThreeProvider(prev);
  }
});

/* ─────────────────── 6 / 生产接线 ─────────────────── */

test('6 生产接线:buildTerrainMaterial 有调用点、boot 不再用单色 Lambert、矩阵每帧上传', () => {
  const files = clientSources();
  ok(files.length > 10, `client/src 源码扫描非空(实测 ${files.length} 个文件)`);

  /* (a) 调用点:装配层之外至少一处 —— 这就是「生产调用点」。
     扫描前**剥注释**:`stage_assembly` 的 docblock 会提到这个函数名,注释不是调用。 */
  const callSites = files
    .filter((f) => f.path !== 'client/src/three/stage_assembly.ts')
    .filter((f) => /buildTerrainMaterial\s*\(/.test(stripComments(f.text)))
    .map((f) => f.path);
  ok(callSites.length >= 1, 'buildTerrainMaterial() 必须有生产调用点(零调用 = 顶点色材质永远用不上)');
  eq(callSites.includes('client/src/three/boot.ts'), true, '地形材质的调用点必须是 boot.ts');

  /* (b) boot 的地形材质真的来自 `buildTerrainMaterial()`(剥注释后看**代码**) */
  const boot = stripComments(read(join(CLIENT, 'src/three/boot.ts')));
  ok(/const mat = buildTerrainMaterial\(\)/.test(boot),
    '地形材质必须由 buildTerrainMaterial() 产出(它才带 vertexColors: true)');
  eq(/0x9fd6a0/.test(boot), false, 'boot.ts 的代码里不得再出现旧的地形单色字面量');

  /* (c) raw 材料没有自动矩阵 ⇒ 每帧上传必须在 render 之前 */
  const syncAt = boot.indexOf('syncTerrainCamera(mat, camera)');
  const renderAt = boot.indexOf('renderer.render(scene, camera)');
  ok(syncAt >= 0, 'boot.ts 必须每帧调 syncTerrainCamera(mat, camera)');
  ok(renderAt >= 0, 'boot.ts 必须有 renderer.render(scene, camera)');
  ok(syncAt < renderAt, `矩阵上传必须在渲染之前(实测 ${syncAt} vs ${renderAt})`);

  /* ★ 负对照:把旧写法喂给**同一个**检测器 —— 必须不被认成「走顶点色材质」,且旧色值必被抓到 */
  const oldSnippet = 'const mat = new THREE.MeshLambertMaterial({ color: 0x9fd6a0 });';
  eq(/const mat = buildTerrainMaterial\(\)/.test(oldSnippet), false,
    '负对照:旧写法不得被认成顶点色材质(否则这条判据恒真)');
  eq(/0x9fd6a0/.test(oldSnippet), true, '负对照:旧色值必须被抓到');
});

/* ─────────────────── 7 / 同型问题(shaders.ts) ─────────────────── */

test('7 stage/shaders.ts 的同型问题不再活着:装配层走 raw + 补 precision', () => {
  /* 负对照先立:那份源码确实自带内建声明(否则第 7 条没东西可守) */
  const dup = duplicatedManagedAttributes(VERT_WATER_RIPPLE);
  ok(dup.includes('position') && dup.includes('uv'),
    `水面顶点源码自带 position/uv 声明(实测 ${dup.join(',')})—— 配 ShaderMaterial 必重定义`);

  const asm = stripComments(read(join(CLIENT, 'src/three/stage_assembly.ts')));
  const managedCtor = (asm.match(/new THREE\.ShaderMaterial\s*\(/g) ?? []).length;
  const rawCtor = (asm.match(/new THREE\.RawShaderMaterial\s*\(/g) ?? []).length;
  eq(managedCtor, 0, `装配层不得再造 ShaderMaterial(它会注入内建属性;实测 ${managedCtor} 处)`);
  ok(rawCtor >= 1, `装配层必须用 RawShaderMaterial(实测 ${rawCtor} 处)`);
  /* raw 连默认精度都不注入 ⇒ 顶点源码前必须补 precision */
  ok(/precision highp float;\\n\$\{prog\.vertex\}/.test(asm),
    'raw 顶点源码前必须补 `precision highp float;`(否则真机编译失败)');
  /* 片元源码自带精度(与真机同一份),不需要装配层补 */
  ok(/precision\s+(highp|mediump|lowp)\s+float\s*;/.test(TERRAIN_VCOLOR_FRAG), '片元源码自带 precision');
});

report('WS-FND-89');