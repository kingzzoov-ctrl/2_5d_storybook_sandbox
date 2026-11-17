/**
 * WS-09 U2 / 地形**顶点色** —— 渲染不再依赖纹理图集。
 *
 * ## 为什么弃用纹理图集
 *
 * 早先地形靠 `uAlbedo` 图集 + UV:每种地砖在 1024×1024 图集里占一格,
 * 于是「加一种地砖」= 「重画图集 + 重算 UV + 重传纹理」三件事同时发生。
 * 本仓地砖种类在 U10 裁决后**扩到 u16**(>64 种),图集网格随之变成
 * 64×64 格 → 单图集 4096×4096 纹理,显存与采样都不可接受。
 *
 * 顶点色把「材质基色」搬进顶点属性:
 *   - 每个顶点 3 个 float(RGB),长度恒等于 `顶点数 × 3`;
 *   - 加一种地砖只需在 `ELEV_BASE_RGB` / 调色表里加一行,不碰任何纹理;
 *   - 与 `chunk_geometry` 的顶点写出**同源**:颜色在 `pushVertex` 处一起写,
 *     不存在「几何更新了、颜色忘更新」的错位。
 *
 * ## 判据口径(写在这里,因为判据就是本文件的产品规格)
 *
 *   1. `colors.length === vertexCount × TERRAIN_COLOR_COMPONENTS`(=3);
 *   2. 每个分量 ∈ [0, 1](越界即 NaN/负值/过曝,GPU 会静默截断而肉眼很难发现);
 *   3. 片元着色器源码**不含** `sampler2D` / `texture2D`(`terrainShaderSamplesTexture() === false`)。
 *
 * ## 为什么不写 4 分量(RGBA)
 *
 * 透明由材质/染色 uniform 负责,顶点 alpha 恒为 1 只会多占 33% 带宽。
 * `TERRAIN_COLOR_COMPONENTS` 是**唯一**的分量数事实源:谁都别写死 3。
 */

/** 顶点色分量数(RGB)。唯一事实源 —— 装配层与判据都读它。 */
export const TERRAIN_COLOR_COMPONENTS = 3;

/** 顶点色在几何上的属性名 */
export const TERRAIN_COLOR_ATTRIBUTE = 'color';

/** 一个顶点的颜色(0..1 线性空间) */
export interface FaceColor {
  r: number;
  g: number;
  b: number;
}

/**
 * 四层地质基色,下标 = `Elevation`(0 DEEP / 1 GROUND / 2 PLATFORM / 3 CLIFF)。
 *
 * 取值刻意避开纯色:纯 (1,1,1) 在顶点色路径上会与「未写入」不可区分
 * (`Float32Array` 默认 0 是全黑,而全白是最高亮度,两者都能被盲眼看过去),
 * 因此每层都落在中间调,任一层漏写都会在判据 2 之外被「层间颜色相同」抓住。
 */
export const ELEV_BASE_RGB: readonly FaceColor[] = [
  { r: 0.24, g: 0.36, b: 0.52 }, /* DEEP     深水 */
  { r: 0.42, g: 0.62, b: 0.36 }, /* GROUND   草地 */
  { r: 0.62, g: 0.58, b: 0.46 }, /* PLATFORM 木台 */
  { r: 0.56, g: 0.52, b: 0.54 }, /* CLIFF    石崖 */
];

/** 顶面亮度因子(朝上,受光最多) */
export const TOP_FACE_SHADE = 1;

/**
 * 侧面亮度因子。固定光向来自左上前方,四个侧面共用同一个系数 ——
 * 本仓是像素画风格,**不做**逐法线兰伯特(那会在相邻侧面之间产生肉眼可见的
 * 亮度跳变,破坏「同一块地形一个色」的观感)。
 */
export const SIDE_FACE_SHADE = 0.82;

/** 世界 z(−1..2)→ 地质层下标(0..3);越界夹紧 */
export function elevLayerOfZ(z: number): number {
  switch (Math.round(z)) {
    case -1: return 0;
    case 0: return 1;
    case 1: return 2;
    case 2: return 3;
    default: return z < 0 ? 0 : 3;
  }
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** 取某层某朝向面的颜色(唯一算法源:基色 × 亮度因子,分量夹紧到 [0,1]) */
export function faceColor(layer: number, isTop: boolean): FaceColor {
  const i = Math.max(0, Math.min(ELEV_BASE_RGB.length - 1, Math.trunc(layer)));
  const base = ELEV_BASE_RGB[i];
  const shade = isTop ? TOP_FACE_SHADE : SIDE_FACE_SHADE;
  return {
    r: clamp01(base.r * shade),
    g: clamp01(base.g * shade),
    b: clamp01(base.b * shade),
  };
}

/** 把颜色写到顶点色数组的第 `vertexIndex` 个顶点上 */
export function writeVertexColor(colors: Float32Array, vertexIndex: number, c: FaceColor): void {
  const o = vertexIndex * TERRAIN_COLOR_COMPONENTS;
  colors[o] = c.r;
  colors[o + 1] = c.g;
  colors[o + 2] = c.b;
}

/**
 * 顶点色自检。返回 `null` 表示合法;否则返回**具体**原因。
 *
 * 为什么单独做成函数而不是散在断言里:与 `validateChunkGeometry` 同构,
 * 让装配层(每帧)与测试(门禁)跑**同一份**检查,避免「测试查的是一套、
 * 运行时走的是另一套」。
 */
export function validateVertexColors(colors: Float32Array, vertexCount: number): string | null {
  const expected = vertexCount * TERRAIN_COLOR_COMPONENTS;
  if (colors.length !== expected) {
    return `顶点色长度 ${colors.length} ≠ 顶点数 ${vertexCount} × ${TERRAIN_COLOR_COMPONENTS} = ${expected}`;
  }
  for (let i = 0; i < colors.length; i += 1) {
    const v = colors[i];
    if (!Number.isFinite(v)) return `顶点色分量 [${i}] 非有限值(${String(v)})`;
    if (v < 0 || v > 1) return `顶点色分量 [${i}] = ${v} 超出 [0,1]`;
  }
  return null;
}

/* ───────────────────────── 顶点色着色器(无纹理) ───────────────────────── */

/**
 * three 在**非 raw**(`ShaderMaterial`)路径里**自动注入**的顶点属性。
 *
 * `position` / `normal` / `uv` 是无条件注入的;`color` 在 `material.vertexColors === true`
 * (`#define USE_COLOR`)时注入。
 *
 * ★ WS-FND-89:这份表存在的唯一理由是**判据能查重** —— 自定义源码里再声明一次
 *   这些名字,GLSL 就是「redefinition of 'position'」,编译失败 ⇒ 整个地形画不出来,
 *   而 node 侧的判据(长度、值域、没有采样器)照样全绿。实测就发生过。
 */
export const THREE_MANAGED_ATTRIBUTES: readonly string[] = ['position', 'normal', 'uv', 'color'];

/**
 * 顶点着色器(**自包含**版:配 `RawShaderMaterial`)。
 *
 * 只用 `position` / `normal` / `color` 三个属性;矩阵 uniform 与仓内既有 shader
 * 保持一致(`uProjection` / `uView` / `uModel`)。
 *
 * ★ 为什么 `precision` 与三个 `attribute` 都必须写在这里:`RawShaderMaterial`
 *   **不做任何注入**(连默认浮点精度都没有)。three 只在 `ShaderMaterial` 路径上
 *   注入 `attribute vec3 position/normal/uv`(开 `vertexColors` 还注入 `color`),
 *   所以同一份源码**绝不能**再喂给 `ShaderMaterial` —— 那就是同名重定义。
 *   非 raw 路径请用 `TERRAIN_VCOLOR_VERT_MANAGED`(内建声明已剥离,见文件末尾)。
 */
export const TERRAIN_VCOLOR_VERT = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec3 color;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vColor = color;
  vNormal = normal;
  gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
}
`;

/**
 * 片元着色器:顶点色 × 固定光向的兰伯特近似。
 *
 * ★ 硬约束:**不出现任何采样器**。写了 `uAlbedo` 就等于回到纹理图集,
 *   而 U2 裁决的全部收益(加地砖不改图集、不重传纹理)会当场消失。
 *
 * `precision` 显式写出:配 `RawShaderMaterial` 时 three 不注入默认精度。
 * 非 raw 路径上 three 也会注入一行同样的声明 —— 重复设定默认精度是**合法**的
 * (与重复声明 `attribute` 不同),所以两条路径可以共用同一份片元源码。
 */
export const TERRAIN_VCOLOR_FRAG = `
precision highp float;
uniform float uAmbient;
varying vec3 vColor;
varying vec3 vNormal;
const vec3 LIGHT_DIR = vec3(0.4082482, -0.4082482, 0.8164965);
void main() {
  float ndl = max(dot(normalize(vNormal), LIGHT_DIR), 0.0);
  vec3 lit = vColor * (uAmbient + (1.0 - uAmbient) * ndl);
  gl_FragColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}
`;

/**
 * 顶点色着色器是否仍在采样纹理。**必须恒为 `false`** ——
 * 判据拿它当断言,而不是拿「有没有 `uAlbedo` 字样」(别名会绕过那种检查)。
 */
export function terrainShaderSamplesTexture(): boolean {
  const both = `${TERRAIN_VCOLOR_VERT}\n${TERRAIN_VCOLOR_FRAG}`;
  return /sampler2D|samplerCube|texture2D|textureCube/.test(both);
}

/**
 * 从 GLSL 源码里按出现顺序抽取 `attribute <type> <name>;` 的名字(**可重复**)。
 *
 * 保留重复是有意的:「同一属性声明了两次」本身就是要抓的缺陷,去重会把它吃掉。
 */
export function parseAttributeDeclarations(src: string): string[] {
  const out: string[] = [];
  const re = /attribute\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
}

/**
 * 源码里**与 three 注入重名**的属性声明(去重)。
 *
 * 返回非空 ⇒ 这份源码**不能**配 `ShaderMaterial`(GLSL 重定义 ⇒ 编译失败 ⇒
 * 对象整块不显示)。它是 `TERRAIN_VCOLOR_VERT` / `TERRAIN_VCOLOR_VERT_MANAGED`
 * 两条路径的共用判据。
 */
export function duplicatedManagedAttributes(src: string): string[] {
  const managed = new Set(THREE_MANAGED_ATTRIBUTES);
  const hit = new Set<string>();
  for (const name of parseAttributeDeclarations(src)) {
    if (managed.has(name)) hit.add(name);
  }
  return [...hit];
}

/**
 * 剥掉指定名字的 `attribute` 声明行(其余原样保留)。
 *
 * 用途:把自包含源码变成 `ShaderMaterial` 版本 —— three 已经注入了那些声明,
 * 我们再声明一次就是重定义。**只删声明行**,不碰任何使用点,因此两条路径
 * 的计算逻辑必然同源(不存在「raw 版改了、managed 版忘了改」)。
 */
export function stripAttributeDeclarations(src: string, names: readonly string[]): string {
  const drop = new Set(names);
  const kept: string[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*attribute\s+\w+\s+(\w+)\s*;\s*$/.exec(line);
    if (m !== null && drop.has(m[1])) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * `ShaderMaterial`(非 raw)专用顶点源码:three 注入的内建声明已剥离。
 *
 * ★ 它不是「另一份实现」—— 由 `TERRAIN_VCOLOR_VERT` 机械派生,唯一差异是少了
 *   三行 `attribute`(three 会注入)。判据:`duplicatedManagedAttributes(THIS) === []`。
 */
export const TERRAIN_VCOLOR_VERT_MANAGED: string =
  stripAttributeDeclarations(TERRAIN_VCOLOR_VERT, THREE_MANAGED_ATTRIBUTES);

/** 顶点色着色器声明的属性名(判据用:必须含 color,且不含 uv) */
export function terrainShaderAttributes(): string[] {
  return parseAttributeDeclarations(TERRAIN_VCOLOR_VERT);
}