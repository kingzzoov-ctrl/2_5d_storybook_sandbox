/**
 * WS-09 / 6 个 GLSL 着色器契约 —— 字符串常量 + uniform 表(不 import three)。
 *
 * 为什么是「字符串 + 表」而不是直接 `new THREE.ShaderMaterial`:
 *  - 测试环境零依赖,不能 import three;把源码作为纯字符串导出后,
 *    测试可以在 node 里断言 uniform 表完整性、括号平衡、声明无重复;
 *  - 装配层(`client/src/three/material_factory.ts`)读这份表去填 uniform,
 *    保证「表里有、shader 里没声明」这种低级错误在 CI 就被拦住。
 *
 * 六个材质对应手册里六类会动的表面:
 *  1. `water_ripple`      水面波纹(河流/温泉/水渠)
 *  2. `grass_breeze`      草木微风摇摆
 *  3. `sakura_particles`  樱花花瓣飘落(附加在屋顶/地面上的加色粒子面片)
 *  4. `lava_emissive`     熔岩自发光(带脉动与边缘灼烧)
 *  5. `ice_reflect`       镜面极滑冰砖反光(315 号地砖)
 *  6. `dye_overlay`       染色喷枪改色(209 号工具,走覆盖通道**不重建材质**)
 *
 * `dye_overlay` 是性能关键:玩家每喷一次色只改 1 个 uniform(`uDyeTint` + `uDyeMaskRect`),
 * 材质实例数恒定,不产生 UV 变体爆炸。
 */

export const SHADER_NAMES = [
  'water_ripple',
  'grass_breeze',
  'sakura_particles',
  'lava_emissive',
  'ice_reflect',
  'dye_overlay',
] as const;
export type ShaderName = (typeof SHADER_NAMES)[number];

export interface ShaderUniformSpec {
  name: string;
  type: 'float' | 'int' | 'vec2' | 'vec3' | 'vec4' | 'mat4' | 'sampler2D';
  /** 出现在哪个阶段的源码里 */
  stage: 'vertex' | 'fragment' | 'both';
  /** 中文语义,供装配层与文档对齐 */
  desc: string;
}

/* ─────────────────────────── 1. 水面波纹 ─────────────────────────── */

export const VERT_WATER_RIPPLE = `
attribute vec3 position;
attribute vec2 uv;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform float uTime;
uniform float uWaveAmp;
uniform vec2 uWaveDir;
varying vec2 vUv;
varying float vWave;
void main() {
  vUv = uv;
  vec4 world = uModel * vec4(position, 1.0);
  float phase = dot(world.xz, uWaveDir) * 6.28318530718 + uTime * 2.0;
  float wave = sin(phase) * uWaveAmp;
  vWave = wave;
  world.y += wave;
  gl_Position = uProjection * uView * world;
}
`;

export const FRAG_WATER_RIPPLE = `
precision mediump float;
uniform sampler2D uAlbedo;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform float uTime;
uniform float uRippleDensity;
varying vec2 vUv;
varying float vWave;
void main() {
  vec2 st = vUv * uRippleDensity + vec2(uTime * 0.03, uTime * 0.017);
  float ring = sin(st.x * 12.566370614) * cos(st.y * 12.566370614);
  float foam = smoothstep(0.72, 0.98, ring * 0.5 + 0.5);
  vec3 base = texture2D(uAlbedo, vUv).rgb;
  vec3 tinted = mix(base, uDeepColor, 0.35 + vWave * 0.5);
  tinted = mix(tinted, uShallowColor, foam * 0.55);
  gl_FragColor = vec4(tinted, 0.92);
}
`;

/* ─────────────────────────── 2. 草木微风 ─────────────────────────── */

export const VERT_GRASS_BREEZE = `
attribute vec3 position;
attribute vec2 uv;
attribute float aWindWeight;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform float uTime;
uniform float uBreezeStrength;
uniform vec2 uWindDir;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 world = uModel * vec4(position, 1.0);
  float sway = sin(uTime * 1.7 + world.x * 0.35 + world.z * 0.21) * uBreezeStrength * aWindWeight;
  world.x += uWindDir.x * sway;
  world.z += uWindDir.y * sway;
  gl_Position = uProjection * uView * world;
}
`;

export const FRAG_GRASS_BREEZE = `
precision mediump float;
uniform sampler2D uAlbedo;
uniform vec3 uTint;
uniform float uAoStrength;
varying vec2 vUv;
void main() {
  vec4 tex = texture2D(uAlbedo, vUv);
  if (tex.a < 0.1) discard;
  float shade = 1.0 - uAoStrength * vUv.y;
  gl_FragColor = vec4(tex.rgb * uTint * shade, tex.a);
}
`;

/* ─────────────────────────── 3. 樱花粒子 ─────────────────────────── */

export const VERT_SAKURA_PARTICLES = `
attribute vec3 position;
attribute vec2 uv;
attribute float aSeed;
uniform mat4 uProjection;
uniform mat4 uView;
uniform float uTime;
uniform float uFallSpeed;
uniform float uDriftAmp;
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = uv;
  float t = uTime * uFallSpeed + aSeed * 6.28318530718;
  vec3 p = position;
  p.y -= mod(t * 2.0, 6.0);
  p.x += sin(t * 1.3) * uDriftAmp;
  p.z += cos(t * 1.1) * uDriftAmp;
  vFade = clamp(1.0 - abs(p.y) / 6.0, 0.0, 1.0);
  gl_Position = uProjection * uView * vec4(p, 1.0);
}
`;

export const FRAG_SAKURA_PARTICLES = `
precision mediump float;
uniform sampler2D uPetalAtlas;
uniform vec3 uPetalColor;
uniform float uGlobalAlpha;
varying vec2 vUv;
varying float vFade;
void main() {
  vec4 tex = texture2D(uPetalAtlas, vUv);
  if (tex.a < 0.05) discard;
  vec3 rgb = mix(tex.rgb, uPetalColor, 0.6);
  gl_FragColor = vec4(rgb, tex.a * vFade * uGlobalAlpha);
}
`;

/* ─────────────────────────── 4. 熔岩自发光 ─────────────────────────── */

export const VERT_LAVA_EMISSIVE = `
attribute vec3 position;
attribute vec2 uv;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
}
`;

export const FRAG_LAVA_EMISSIVE = `
precision mediump float;
uniform sampler2D uAlbedo;
uniform vec3 uHotColor;
uniform vec3 uCoolColor;
uniform float uTime;
uniform float uPulseSpeed;
uniform float uEmissiveGain;
varying vec2 vUv;
void main() {
  float cells = fract(sin(dot(vUv * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
  float pulse = 0.5 + 0.5 * sin(uTime * uPulseSpeed + cells * 6.28318530718);
  float crust = smoothstep(0.35, 0.65, texture2D(uAlbedo, vUv).r);
  vec3 hot = uHotColor * (0.7 + pulse * 0.6) * uEmissiveGain;
  vec3 outColor = mix(crust > 0.5 ? uCoolColor : hot, hot, pulse * 0.4);
  gl_FragColor = vec4(outColor, 1.0);
}
`;

/* ─────────────────────────── 5. 冰砖反光 ─────────────────────────── */

export const VERT_ICE_REFLECT = `
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
varying vec2 vUv;
varying vec3 vWorldNormal;
void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(uModel) * normal);
  gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
}
`;

export const FRAG_ICE_REFLECT = `
precision mediump float;
uniform sampler2D uAlbedo;
uniform sampler2D uEnvMap;
uniform vec3 uCameraPos;
uniform float uReflectivity;
uniform float uGlossExponent;
varying vec2 vUv;
varying vec3 vWorldNormal;
void main() {
  vec3 n = normalize(vWorldNormal);
  vec3 viewDir = normalize(uCameraPos - vec3(0.0, 0.0, 0.0));
  vec3 reflected = reflect(-viewDir, n);
  vec2 envUv = vec2(reflected.x * 0.5 + 0.5, reflected.y * 0.5 + 0.5);
  vec3 env = texture2D(uEnvMap, envUv).rgb;
  vec3 base = texture2D(uAlbedo, vUv).rgb;
  float spec = pow(max(dot(reflected, n), 0.0), uGlossExponent);
  vec3 color = mix(base, env, uReflectivity) + vec3(spec * 0.5);
  gl_FragColor = vec4(color, 0.88);
}
`;

/* ─────────────────────────── 6. 染色覆盖 ─────────────────────────── */

export const VERT_DYE_OVERLAY = `
attribute vec3 position;
attribute vec2 uv;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
}
`;

export const FRAG_DYE_OVERLAY = `
precision mediump float;
uniform sampler2D uAlbedo;
uniform vec3 uDyeTint;
uniform vec4 uDyeMaskRect;
uniform float uDyeStrength;
uniform float uPaletteIndex;
varying vec2 vUv;
void main() {
  vec4 tex = texture2D(uAlbedo, vUv);
  float inside = step(uDyeMaskRect.x, vUv.x) * step(vUv.x, uDyeMaskRect.x + uDyeMaskRect.z);
  inside *= step(uDyeMaskRect.y, vUv.y) * step(vUv.y, uDyeMaskRect.y + uDyeMaskRect.w);
  float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
  float amount = inside * uDyeStrength;
  vec3 dyed = mix(tex.rgb, uDyeTint * (0.55 + lum * 0.9), amount);
  float paletteTag = uPaletteIndex * 0.0;
  gl_FragColor = vec4(dyed + paletteTag, tex.a);
}
`;

/* ─────────────────────────── 源码登记表 ─────────────────────────── */

export interface ShaderProgram {
  name: ShaderName;
  vertex: string;
  fragment: string;
}

export const SHADER_PROGRAMS: Record<ShaderName, ShaderProgram> = {
  water_ripple: { name: 'water_ripple', vertex: VERT_WATER_RIPPLE, fragment: FRAG_WATER_RIPPLE },
  grass_breeze: { name: 'grass_breeze', vertex: VERT_GRASS_BREEZE, fragment: FRAG_GRASS_BREEZE },
  sakura_particles: {
    name: 'sakura_particles',
    vertex: VERT_SAKURA_PARTICLES,
    fragment: FRAG_SAKURA_PARTICLES,
  },
  lava_emissive: { name: 'lava_emissive', vertex: VERT_LAVA_EMISSIVE, fragment: FRAG_LAVA_EMISSIVE },
  ice_reflect: { name: 'ice_reflect', vertex: VERT_ICE_REFLECT, fragment: FRAG_ICE_REFLECT },
  dye_overlay: { name: 'dye_overlay', vertex: VERT_DYE_OVERLAY, fragment: FRAG_DYE_OVERLAY },
};

/* ─────────────────────────── uniform 表 ─────────────────────────── */

const U_PROJ: ShaderUniformSpec = { name: 'uProjection', type: 'mat4', stage: 'vertex', desc: '正交投影矩阵' };
const U_VIEW: ShaderUniformSpec = { name: 'uView', type: 'mat4', stage: 'vertex', desc: '视图矩阵' };
const U_MODEL: ShaderUniformSpec = { name: 'uModel', type: 'mat4', stage: 'vertex', desc: '模型矩阵(含染色/缩放)' };
const U_TIME_BOTH: ShaderUniformSpec = { name: 'uTime', type: 'float', stage: 'both', desc: '累计时间(秒),顶点与片元都要用' };
const U_TIME_VERT: ShaderUniformSpec = { name: 'uTime', type: 'float', stage: 'vertex', desc: '累计时间(秒),仅顶点位移需要' };
const U_TIME_FRAG: ShaderUniformSpec = { name: 'uTime', type: 'float', stage: 'fragment', desc: '累计时间(秒),仅片元着色需要' };
const U_ALBEDO: ShaderUniformSpec = { name: 'uAlbedo', type: 'sampler2D', stage: 'fragment', desc: '基础贴图(调色盘索引图)' };

export const SHADER_UNIFORMS: Record<ShaderName, readonly ShaderUniformSpec[]> = {
  water_ripple: [
    U_PROJ, U_VIEW, U_MODEL, U_TIME_BOTH,
    { name: 'uWaveAmp', type: 'float', stage: 'vertex', desc: '波幅(格),默认 0.06' },
    { name: 'uWaveDir', type: 'vec2', stage: 'vertex', desc: '波向单位向量' },
    U_ALBEDO,
    { name: 'uShallowColor', type: 'vec3', stage: 'fragment', desc: '浅水色' },
    { name: 'uDeepColor', type: 'vec3', stage: 'fragment', desc: '深水色' },
    { name: 'uRippleDensity', type: 'float', stage: 'fragment', desc: '涟漪密度,默认 8' },
  ],
  grass_breeze: [
    U_PROJ, U_VIEW, U_MODEL, U_TIME_VERT,
    { name: 'uBreezeStrength', type: 'float', stage: 'vertex', desc: '摇摆幅度(格),默认 0.08' },
    { name: 'uWindDir', type: 'vec2', stage: 'vertex', desc: '风向单位向量' },
    U_ALBEDO,
    { name: 'uTint', type: 'vec3', stage: 'fragment', desc: '群系色调乘子' },
    { name: 'uAoStrength', type: 'float', stage: 'fragment', desc: '根部遮蔽强度,默认 0.35' },
  ],
  sakura_particles: [
    U_PROJ, U_VIEW, U_TIME_VERT,
    { name: 'uFallSpeed', type: 'float', stage: 'vertex', desc: '下落速度(格/秒),默认 0.6' },
    { name: 'uDriftAmp', type: 'float', stage: 'vertex', desc: '横向漂移幅度(格),默认 0.4' },
    { name: 'uPetalAtlas', type: 'sampler2D', stage: 'fragment', desc: '花瓣图集' },
    { name: 'uPetalColor', type: 'vec3', stage: 'fragment', desc: '花瓣染色(绯樱粉)' },
    { name: 'uGlobalAlpha', type: 'float', stage: 'fragment', desc: '整体透明度(天气淡入用)' },
  ],
  lava_emissive: [
    U_PROJ, U_VIEW, U_MODEL, U_TIME_FRAG,
    U_ALBEDO,
    { name: 'uHotColor', type: 'vec3', stage: 'fragment', desc: '熔岩高温色' },
    { name: 'uCoolColor', type: 'vec3', stage: 'fragment', desc: '冷却硬壳色' },
    { name: 'uPulseSpeed', type: 'float', stage: 'fragment', desc: '脉动角速度,默认 1.4' },
    { name: 'uEmissiveGain', type: 'float', stage: 'fragment', desc: '自发光增益,默认 1.0' },
  ],
  ice_reflect: [
    U_PROJ, U_VIEW, U_MODEL,
    { name: 'uCameraPos', type: 'vec3', stage: 'fragment', desc: '相机世界位置(正交下仍用朝向)' },
    U_ALBEDO,
    { name: 'uEnvMap', type: 'sampler2D', stage: 'fragment', desc: '环境立方体展开图' },
    { name: 'uReflectivity', type: 'float', stage: 'fragment', desc: '反射混合比,默认 0.55' },
    { name: 'uGlossExponent', type: 'float', stage: 'fragment', desc: '高光指数,默认 48' },
  ],
  dye_overlay: [
    U_PROJ, U_VIEW, U_MODEL,
    U_ALBEDO,
    { name: 'uDyeTint', type: 'vec3', stage: 'fragment', desc: '32 色调色盘当前色' },
    { name: 'uDyeMaskRect', type: 'vec4', stage: 'fragment', desc: '染色矩形(x, y, w, h),UV 空间' },
    { name: 'uDyeStrength', type: 'float', stage: 'fragment', desc: '染色强度 0..1' },
    { name: 'uPaletteIndex', type: 'float', stage: 'fragment', desc: '调色盘索引 0..31' },
  ],
};

/* ─────────────────────────── 静态校验工具(供测试调用) ─────────────────────────── */

/** 提取 `uniform <type> <name>;` 声明 */
export function declaredUniforms(src: string): string[] {
  const out: string[] = [];
  const re = /uniform\s+\w+\s+(\w+)\s*;/g;
  let m = re.exec(src);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
}

/** 提取 `attribute <type> <name>;` 声明 */
export function declaredAttributes(src: string): string[] {
  const out: string[] = [];
  const re = /attribute\s+\w+\s+(\w+)\s*;/g;
  let m = re.exec(src);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
}

/** 花括号平衡检查,返回差值(0 = 平衡) */
export function braceBalance(src: string): number {
  let depth = 0;
  for (const ch of src) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

/** 圆括号平衡检查 */
export function parenBalance(src: string): number {
  let depth = 0;
  for (const ch of src) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return depth;
}

/** 是否存在同一名字被重复声明(uniform/attribute/varying 合计) */
export function duplicateDeclarations(src: string): string[] {
  const seen = new Map<string, number>();
  const re = /\b(uniform|attribute|varying)\s+\w+\s+(\w+)\s*;/g;
  let m = re.exec(src);
  while (m !== null) {
    const name = m[2];
    seen.set(name, (seen.get(name) ?? 0) + 1);
    m = re.exec(src);
  }
  const dups: string[] = [];
  for (const [k, v] of seen) if (v > 1) dups.push(k);
  return dups;
}

/** 检查表里登记的 uniform 是否真的在源码里声明(双向闭合) */
export function uniformTableConsistency(name: ShaderName): { missing: string[]; undeclared: string[] } {
  const prog = SHADER_PROGRAMS[name];
  const specs = SHADER_UNIFORMS[name];
  const vertUni = new Set(declaredUniforms(prog.vertex));
  const fragUni = new Set(declaredUniforms(prog.fragment));
  const missing: string[] = [];
  for (const s of specs) {
    const inVert = s.stage === 'vertex' || s.stage === 'both';
    const inFrag = s.stage === 'fragment' || s.stage === 'both';
    if (inVert && !vertUni.has(s.name)) missing.push(`vertex:${s.name}`);
    if (inFrag && !fragUni.has(s.name)) missing.push(`fragment:${s.name}`);
  }
  const tableNames = new Set(specs.map((s) => s.name));
  const undeclared: string[] = [];
  for (const u of vertUni) if (!tableNames.has(u)) undeclared.push(`vertex:${u}`);
  for (const u of fragUni) if (!tableNames.has(u)) undeclared.push(`fragment:${u}`);
  return { missing, undeclared };
}

/** 某 shader 的全部 uniform 名字(去重) */
export function uniformNames(name: ShaderName): string[] {
  return [...new Set(SHADER_UNIFORMS[name].map((s) => s.name))];
}