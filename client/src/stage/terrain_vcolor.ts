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
 * 顶点着色器:只用 `position` / `normal` / `color` 三个属性。
 * 矩阵 uniform 与仓内既有 shader 保持一致(`uProjection` / `uView` / `uModel`)。
 */
export const TERRAIN_VCOLOR_VERT = `
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
 */
export const TERRAIN_VCOLOR_FRAG = `
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

/** 顶点色着色器声明的属性名(判据用:必须含 color,且不含 uv) */
export function terrainShaderAttributes(): string[] {
  const out: string[] = [];
  const re = /attribute\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null = re.exec(TERRAIN_VCOLOR_VERT);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(TERRAIN_VCOLOR_VERT);
  }
  return out;
}