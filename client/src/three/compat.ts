/**
 * WS-09 U1 / **极简 three 相容层** —— 没有 `three` 依赖时也能装配。
 *
 * ## 为什么需要这一层
 *
 * 装配层(`three/stage_assembly.ts`)是唯一 import `three` 的地方,而本仓的硬约束是
 * 「**默认零运行时依赖**」:`node_modules/` 通常不存在,`three` 是 `optionalDependencies`,
 * 测试与 CI 都不装它。于是「装配」这件事在 99% 的生命周期里**没有实现可用**:
 *   - 想在 node 里跑一次装配、断言「颜色属性真的挂上去了」⇒ `import 'three'` 直接 ENOENT;
 *   - 想在浏览器里跑 ⇒ `three` 有,但代码路径与测试跑的不是同一份 ⇒ 装配逻辑无法被覆盖。
 *
 * 收口办法不是「把 three 装成依赖」,而是把**装配用到的 three 表面压到最小**并允许注入:
 *   · `ThreeLike` 只声明本仓真正用到的 4 个构造器(`BufferAttribute` / `BufferGeometry` /
 *     `ShaderMaterial` / `Matrix4`),不多不少;
 *   · `setThreeProvider()` 注入真 `three`(浏览器/装了 three 的环境);
 *   · **没注入时**退回 `FALLBACK_THREE`:同样接口的纯对象实现,把属性原样记下来,
 *     既不碰 GPU 也不抛错 —— 判据「不给 three 时装配不抛」靠它成立;
 *   · 判据「给了替身时调用到」:注入一个记账替身,装配必须真的 `new` 了它。
 *
 * ## 为什么不是「try { await import('three') } catch」
 *
 * 动态 import 在**静态类型检查**里仍要被解析(本仓 `tsc` 基线里 `TS7016` 就是它),
 * 而 `await` 会把装配变成异步 —— 建面是每帧热路径,不该为此引入 Promise。
 * 注入是同步的,且注入点唯一(装配层文件顶部一行)。
 *
 * ## 与 `stage/` 的分层关系
 *
 * 本文件属于 `three/**`,允许 import `stage/**`(反向禁止)。纯计算仍然住在
 * `stage/chunk_geometry.ts` 与 `stage/terrain_vcolor.ts`,这里只做「塞进构造器」。
 */

import type { ChunkGeometry } from '../stage/chunk_geometry.ts';
import {
  TERRAIN_COLOR_ATTRIBUTE,
  TERRAIN_COLOR_COMPONENTS,
  TERRAIN_VCOLOR_FRAG,
  TERRAIN_VCOLOR_VERT,
  TERRAIN_VCOLOR_VERT_MANAGED,
} from '../stage/terrain_vcolor.ts';
import { lodMergeSize } from '../stage/assembly_math.ts';

/* ───────────────────────── 最小接口(只到够用) ───────────────────────── */

/** 顶点属性:与 `THREE.BufferAttribute` 同形的只读视图 */
export interface CompatAttributeLike {
  readonly array: ArrayLike<number>;
  readonly itemSize: number;
  readonly count: number;
}

/** 几何:只声明装配层用到的四个方法 */
export interface CompatGeometryLike {
  setAttribute(name: string, attr: CompatAttributeLike): void;
  getAttribute(name: string): CompatAttributeLike | undefined;
  setIndex(attr: CompatAttributeLike): void;
  getIndex(): CompatAttributeLike | undefined;
  readonly attributes: Record<string, CompatAttributeLike>;
}

/** 材质:只声明装配层用到的字段 */
export interface CompatMaterialLike {
  readonly name: string;
  readonly vertexColors: boolean;
  readonly uniforms: Record<string, { value: unknown }>;
  readonly vertexShader: string;
  readonly fragmentShader: string;
  /**
   * 真 `THREE.RawShaderMaterial` 为 `true`。
   *
   * ★ 这个字段是「着色器会不会被重定义」的**可测开关**:raw 材料 three **不注入**
   *   任何前缀(内建 `attribute` / `precision` 全都得自己写),非 raw 材料 three
   *   会注入 `attribute vec3 position/normal/uv`(+ `color`,开了 `vertexColors`)。
   *   配错组合的后果是同名重定义 ⇒ 编译失败 ⇒ 整块不显示,且没有任何异常抛出。
   */
  readonly isRawShaderMaterial?: boolean;
}

/** 可注入的 three 表面(最小集) */
export interface ThreeLike {
  BufferAttribute: new (array: ArrayLike<number>, itemSize: number) => CompatAttributeLike;
  BufferGeometry: new () => CompatGeometryLike;
  ShaderMaterial: new (params: Record<string, unknown>) => CompatMaterialLike;
  Matrix4: new () => unknown;
  /**
   * 可选:真 three 有;**极简替身可以没有**。
   *
   * 没有它时 `assembleTerrainMaterial()` 退回 `ShaderMaterial` + **剥掉内建声明的**
   * 顶点源码(见 `TERRAIN_VCOLOR_VERT_MANAGED`)—— 两条路都不产生重定义,
   * 不存在「替身环境绿、真机红」的落差。
   */
  RawShaderMaterial?: new (params: Record<string, unknown>) => CompatMaterialLike;
}

/* ───────────────────────── 兜底实现(无 three) ───────────────────────── */

class FallbackBufferAttribute implements CompatAttributeLike {
  readonly array: ArrayLike<number>;
  readonly itemSize: number;

  constructor(array: ArrayLike<number>, itemSize: number) {
    this.array = array;
    this.itemSize = Math.max(1, Math.trunc(itemSize));
  }

  /** 与 three 一致:count = 元素个数 / 每顶点分量数 */
  get count(): number {
    return Math.floor(this.array.length / this.itemSize);
  }
}

class FallbackBufferGeometry implements CompatGeometryLike {
  readonly attributes: Record<string, CompatAttributeLike> = {};
  private index: CompatAttributeLike | undefined;

  setAttribute(name: string, attr: CompatAttributeLike): void {
    this.attributes[name] = attr;
  }

  getAttribute(name: string): CompatAttributeLike | undefined {
    return this.attributes[name];
  }

  setIndex(attr: CompatAttributeLike): void {
    this.index = attr;
  }

  getIndex(): CompatAttributeLike | undefined {
    return this.index;
  }
}

/** 兜底材质:`ShaderMaterial` 语义(非 raw) */
class FallbackShaderMaterial implements CompatMaterialLike {
  readonly name: string;
  readonly vertexColors: boolean;
  readonly uniforms: Record<string, { value: unknown }>;
  readonly vertexShader: string;
  readonly fragmentShader: string;
  readonly isRawShaderMaterial: boolean = false;

  constructor(params: Record<string, unknown>) {
    this.name = typeof params.name === 'string' ? params.name : '';
    this.vertexColors = params.vertexColors === true;
    this.uniforms = (params.uniforms as Record<string, { value: unknown }> | undefined) ?? {};
    this.vertexShader = typeof params.vertexShader === 'string' ? params.vertexShader : '';
    this.fragmentShader = typeof params.fragmentShader === 'string' ? params.fragmentShader : '';
  }
}

/**
 * 兜底 `RawShaderMaterial`:与真 three 同语义 —— **不注入**任何前缀。
 *
 * ★ 为什么兜底也要区分 raw / 非 raw:地形走的是 raw(`precision` 与三个 `attribute`
 *   都写在源码里)。若兜底把它当成非 raw,判据在「没有 three」的环境里就会以为
 *   three 会注入内建 ⇒ 悄悄放过重定义。`isRawShaderMaterial` 让这条差异**可断言**。
 */
class FallbackRawShaderMaterial extends FallbackShaderMaterial {
  override readonly isRawShaderMaterial: boolean = true;
}

const IDENTITY4: readonly number[] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

/** 4×4 单位矩阵的**形状**占位:兜底模式不渲染,只要能让 uniform 有个值 */
class FallbackMatrix4 {
  readonly elements: readonly number[] = IDENTITY4;

  toArray(): number[] {
    return [...IDENTITY4];
  }
}

/**
 * 兜底 three:接口相同、行为是「记账」。
 *
 * ★ 它**不是**空实现:属性必须真的被记下来,否则「没给 three 也能装配」就只是
 *   「没给 three 也没装配」—— 那种实现会让判据假绿(装配什么都没做也不抛)。
 */
export const FALLBACK_THREE: ThreeLike = {
  BufferAttribute: FallbackBufferAttribute,
  BufferGeometry: FallbackBufferGeometry,
  ShaderMaterial: FallbackShaderMaterial,
  Matrix4: FallbackMatrix4,
  /* raw 也要有:地形顶点色材质走 raw(否则会被当成会注入内建的 ShaderMaterial) */
  RawShaderMaterial: FallbackRawShaderMaterial,
};

/* ───────────────────────── 注入点 ───────────────────────── */

let provider: ThreeLike | null = null;
let injectedCalls = 0;

/**
 * 注入真 `three`(装配层文件顶部调用一次);传 `null` 退回兜底。
 * 返回注入前的提供者,便于临时替换后还原(测试用)。
 */
export function setThreeProvider(next: ThreeLike | null): ThreeLike | null {
  const prev = provider;
  provider = next;
  return prev;
}

export function getThreeProvider(): ThreeLike | null {
  return provider;
}

/** 当前装配走的是哪条路:'injected' | 'fallback' —— 判据要**看得出**区别 */
export function threeSource(): 'injected' | 'fallback' {
  return provider === null ? 'fallback' : 'injected';
}

/** 注入的构造器被调用了几次(记账,证明「给了替身时调用到」) */
export function injectedConstructorCalls(): number {
  return injectedCalls;
}

export function resetInjectedConstructorCalls(): void {
  injectedCalls = 0;
}

/** 取当前装配用的 three 表面:注入优先,否则兜底 */
export function compatThree(): ThreeLike {
  return provider ?? FALLBACK_THREE;
}

/* ───────────────────────── 装配 ───────────────────────── */

/**
 * 把纯逻辑层写出的顶点数据装成几何(引擎中立)。
 *
 * 属性清单就是「渲染走顶点色」的实现口径:
 *   `position`(3)/ `color`(3, **不含任何纹理坐标图集**)/ `normal`(3)/
 *   `aLodMerge`(1)/ 索引。
 *
 * 判据:返回的几何上 `getAttribute('color')` 必须存在,且
 *   `array.length === vertexCount × TERRAIN_COLOR_COMPONENTS`
 *   (改坏 `chunk_geometry` 的写法 ⇒ 长度不符 ⇒ 红)。
 */
export function assembleChunkGeometry(emitted: ChunkGeometry, lod: number): CompatGeometryLike {
  const three = compatThree();
  const geom = new three.BufferGeometry();
  if (provider !== null) injectedCalls += 1;
  const merge = new Float32Array(emitted.vertexCount).fill(lodMergeSize(lod));
  geom.setAttribute('position', new three.BufferAttribute(emitted.positions, 3));
  geom.setAttribute(TERRAIN_COLOR_ATTRIBUTE,
    new three.BufferAttribute(emitted.colors, TERRAIN_COLOR_COMPONENTS));
  geom.setAttribute('normal', new three.BufferAttribute(emitted.normals, 3));
  geom.setAttribute('aLodMerge', new three.BufferAttribute(merge, 1));
  geom.setIndex(new three.BufferAttribute(emitted.indices, 1));
  return geom;
}

/** uniform 默认值(装配层不硬编码 uniform 名之外的任何东西) */
function matrixUniforms(three: ThreeLike): Record<string, { value: unknown }> {
  return {
    uProjection: { value: new three.Matrix4() },
    uView: { value: new three.Matrix4() },
    uModel: { value: new three.Matrix4() },
    uAmbient: { value: 0.45 },
  };
}

/**
 * 地形材质:顶点色 + 固定光向的兰伯特近似,**不采任何纹理**。
 *
 * 判据(与 `stage/terrain_vcolor.ts` 的 `terrainShaderSamplesTexture()` 呼应):
 * 片元源码里不出现 `sampler2D`/`texture2D` —— 一旦有人把图集塞回来,判据立刻红。
 *
 * ## ★ WS-FND-89:为什么优先 `RawShaderMaterial`
 *
 * `TERRAIN_VCOLOR_VERT` 自带 `precision` 与 `attribute vec3 position/normal/color`。
 * 这些声明配 raw 材料是**必需**的(raw 不做任何注入);配 `ShaderMaterial` 却是
 * **同名重定义** —— three 会先注入 `position`/`normal`/`uv`(开了 `vertexColors`
 * 还注入 `color`),GLSL 编译直接失败 ⇒ 地形整块不画,且**不抛异常**。
 *
 * 所以:
 *   · 有 `RawShaderMaterial`(真 three / 兜底)→ raw + 自包含源码;
 *   · 没有(极简替身)→ `ShaderMaterial` + `TERRAIN_VCOLOR_VERT_MANAGED`(内建声明已剥离)。
 *
 * 两条路都**不可能**出现重定义,因此不存在「测试环境绿、真机红」的落差。
 */
export function assembleTerrainMaterial(): CompatMaterialLike {
  const three = compatThree();
  if (provider !== null) injectedCalls += 1;
  const uniforms = matrixUniforms(three);
  const Raw = three.RawShaderMaterial;
  if (Raw !== undefined) {
    return new Raw({
      name: 'terrain_vcolor',
      uniforms,
      vertexShader: TERRAIN_VCOLOR_VERT,
      fragmentShader: TERRAIN_VCOLOR_FRAG,
      vertexColors: true,
      transparent: false,
      depthWrite: true,
    });
  }
  return new three.ShaderMaterial({
    name: 'terrain_vcolor',
    uniforms,
    vertexShader: TERRAIN_VCOLOR_VERT_MANAGED,
    fragmentShader: TERRAIN_VCOLOR_FRAG,
    vertexColors: true,
    transparent: false,
    depthWrite: true,
  });
}