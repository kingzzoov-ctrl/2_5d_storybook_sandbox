/**
 * WS-09 / 装配层的**纯数学**部分 —— 零依赖,可被测试直接 import。
 *
 * ## 为什么需要这个文件
 *
 * `three/stage_assembly.ts` 是唯一 import `three` 的模块,而 `tests/WS-09.test.ts`
 * 有硬约束「不得 import three」。于是出现了一个结构性盲区:装配层里凡是
 * **纯计算**(NDC 换算、正交半宽、索引缓冲、图集 UV、uniform 默认值分类)
 * 都因为和 three 构造函数写在同一个文件里,而**永远无法被任何测试覆盖**。
 *
 * 实测后果(见 task-15 审计):`stage_assembly.ts` 的 6 条相对 import 路径全部写错
 * (`./iso_camera.ts` 应为 `../stage/iso_camera.ts`),模块**连加载都失败**,
 * 却因为「没有任何测试会加载它」而长期无人发现。这正是本文件要消灭的盲区:
 *
 *  - 纯计算 → 搬到这里(`stage/` 是纯逻辑层),可被测试覆盖;
 *  - `three/` 只留「把数值塞进 three 构造函数」的薄装配,不再承载规则。
 *
 * 层间不变量:`stage/**` 与 `ui/**` 永不 import `three`;只有 `three/**` 可以。
 */

import { pixelScale, type IsoCamera } from './iso_camera.ts';
import { LOD_MERGE_SIZE } from './tile_mesh.ts';

/* ───────────────────── 相机朝向常量 ───────────────────── */

/** 俯仰角(度)—— 与 `iso_camera.PITCH_DEG` 同源,装配层复用同一数值 */
export const CAM_PITCH_DEG = 35;
/** 方位角(度) */
export const CAM_AZIMUTH_DEG = 45;
export const CAM_PITCH_RAD = (CAM_PITCH_DEG * Math.PI) / 180;
export const CAM_AZIMUTH_RAD = (CAM_AZIMUTH_DEG * Math.PI) / 180;
/** 正交相机离焦点的距离(世界单位)。正交投影下它不影响力大小,只决定 near/far 内的裁剪 */
export const ORTHO_DISTANCE = 512;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 焦点 → 相机的单位偏移方向。
 *
 * `dir = (cos(pitch)·cos(az), cos(pitch)·sin(az), sin(pitch))`。
 * 因为两项 cos 与 sin 的组合满足 `cos²+sin²=1`,该向量**恒为单位向量**,
 * 所以 `焦点 + dir × 512` 到焦点的距离精确等于 512(不随角度变化)。
 */
export function cameraOffsetDirection(): Vec3 {
  return {
    x: Math.cos(CAM_PITCH_RAD) * Math.cos(CAM_AZIMUTH_RAD),
    y: Math.cos(CAM_PITCH_RAD) * Math.sin(CAM_AZIMUTH_RAD),
    z: Math.sin(CAM_PITCH_RAD),
  };
}

/** 相机前向(由相机指向焦点),即偏移方向取反后归一化 */
export function cameraForwardVector(): Vec3 {
  const d = cameraOffsetDirection();
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: -d.x / len, y: -d.y / len, z: -d.z / len };
}

/** 相机世界坐标 = 焦点 + 方向 × 距离 */
export function cameraPosition(focusX: number, focusY: number, focusZ: number, distance = ORTHO_DISTANCE): Vec3 {
  const d = cameraOffsetDirection();
  return {
    x: focusX + d.x * distance,
    y: focusY + d.y * distance,
    z: focusZ + d.z * distance,
  };
}

/**
 * 正交相机的半宽/半高(世界单位)。
 *
 * 纯逻辑相机用「屏幕像素」,three 正交相机用「以视口中心为原点的世界单位」,
 * 换算只有一条:**世界单位 = 像素 / pixelScale**。
 */
export function orthoHalfExtents(cam: IsoCamera): { halfW: number; halfH: number } {
  const k = pixelScale(cam);
  return { halfW: cam.viewportW / 2 / k, halfH: cam.viewportH / 2 / k };
}

/** 屏幕像素 → three NDC(射线拾取用):x 右为正,y 上为正,范围 [−1,1] */
export function screenToNdc(sx: number, sy: number, viewportW: number, viewportH: number): { x: number; y: number } {
  const w = viewportW > 0 ? viewportW : 1;
  const h = viewportH > 0 ? viewportH : 1;
  return { x: (sx / w) * 2 - 1, y: -((sy / h) * 2 - 1) };
}

/** 世界(格)→ three 世界坐标元组。恒等映射:格坐标与 three 世界坐标 1:1 */
export function gridToVec3Tuple(gx: number, gy: number, gz: number): Vec3 {
  return { x: gx, y: gy, z: gz };
}

/* ───────────────────── 网格索引缓冲 ───────────────────── */

/** 每个 quad = 2 个三角形 = 6 个索引 */
export const INDICES_PER_QUAD_GEOM = 6;
/** 每个 quad = 4 个顶点 */
export const VERTS_PER_QUAD_GEOM = 4;

/**
 * 由面数生成索引缓冲:第 q 个 quad 占顶点 `4q..4q+3`,
 * 三角形为 `(0,1,2)` 与 `(0,2,3)` —— 逆时针缠绕,与 three 默认正面一致。
 */
export function quadIndexBuffer(faceCount: number): Uint32Array {
  const n = Math.max(0, Math.trunc(faceCount));
  const out = new Uint32Array(n * INDICES_PER_QUAD_GEOM);
  for (let q = 0; q < n; q += 1) {
    const v = q * VERTS_PER_QUAD_GEOM;
    const o = q * INDICES_PER_QUAD_GEOM;
    out[o] = v;
    out[o + 1] = v + 1;
    out[o + 2] = v + 2;
    out[o + 3] = v;
    out[o + 4] = v + 2;
    out[o + 5] = v + 3;
  }
  return out;
}

/** LOD 档位 → 合并边长(越界夹紧,不抛错) */
export function lodMergeSize(lod: number, table: readonly number[] = LOD_MERGE_SIZE): number {
  if (table.length === 0) return 1;
  const i = Math.max(0, Math.min(table.length - 1, Math.trunc(lod)));
  return table[i];
}

/* ───────────────────── 材质与 uniform ───────────────────── */

/** uniform 类型的粗分类:决定装配层该塞哪种零值对象 */
export type UniformKind = 'number' | 'vec2' | 'vec3' | 'vec4' | 'mat4' | 'texture' | 'unknown';

export function uniformTypeKind(type: string): UniformKind {
  switch (type) {
    case 'float':
    case 'int':
      return 'number';
    case 'vec2':
      return 'vec2';
    case 'vec3':
      return 'vec3';
    case 'vec4':
      return 'vec4';
    case 'mat4':
      return 'mat4';
    case 'sampler2D':
      return 'texture';
    default:
      return 'unknown';
  }
}

/** 纹理类 uniform 的默认值是「无贴图」(three 里即 null),数值类则不透明 */
export function isTextureUniform(type: string): boolean {
  return uniformTypeKind(type) === 'texture';
}

/**
 * shader 名 → 材质的透明/深度写入标志。
 *
 * 规则:樱花粒子、水面、染色覆盖层需要混合(transparent);
 * 樱花粒子不写深度(避免互相遮挡出黑边)。
 */
export function shaderMaterialFlags(name: string): { transparent: boolean; depthWrite: boolean } {
  return {
    transparent: name === 'sakura_particles' || name === 'water_ripple' || name === 'dye_overlay',
    depthWrite: name !== 'sakura_particles',
  };
}

/* ───────────────────── 立牌图集 ───────────────────── */

/** 立牌图集横向帧数(8 朝向) */
export const ATLAS_FRAME_COUNT = 8;

/** 朝向 → 图集帧下标,负数与越界一律环绕到 [0,8) */
export function atlasFrameIndex(facing: number): number {
  const n = ATLAS_FRAME_COUNT;
  const f = Math.trunc(facing);
  return ((f % n) + n) % n;
}

/** 朝向 → 图集 UV(offset/repeat)。横向 8 等分,纵向不切 */
export function atlasUvForFacing(facing: number): {
  offsetU: number;
  offsetV: number;
  repeatU: number;
  repeatV: number;
} {
  return {
    offsetU: atlasFrameIndex(facing) / ATLAS_FRAME_COUNT,
    offsetV: 0,
    repeatU: 1 / ATLAS_FRAME_COUNT,
    repeatV: 1,
  };
}

/** 立牌世界缩放 = 像素高 / pixelScale */
export function billboardScale(heightPx: number, cam: IsoCamera): number {
  const k = pixelScale(cam);
  return heightPx / k;
}

/* ───────────────────── 染色 uniform 负载 ───────────────────── */

export interface Rgb01 {
  r: number;
  g: number;
  b: number;
}

function channel01(hex: string, from: number): number {
  const v = Number.parseInt(hex.slice(from, from + 2), 16);
  return Number.isNaN(v) ? 0 : v / 255;
}

/**
 * `#RRGGBB` → 归一化 RGB(0..1),供 uniform 上传。
 * 非法/短串按 0 处理(不抛错:染色是高频操作,不能因一个坏色值打断整帧)。
 */
export function hexToRgb01(hex: string): Rgb01 {
  const h = typeof hex === 'string' && hex.startsWith('#') ? hex : '';
  return { r: channel01(h, 1), g: channel01(h, 3), b: channel01(h, 5) };
}

export interface DyeUniformPayload {
  tint: Rgb01;
  maskRect: { x: number; y: number; w: number; h: number };
  strength: number;
}

/** 单条染色记录 → 一份 uniform 负载(纯函数,paletteColor 由调用方注入以便测试) */
export function dyeUniformPayload(
  entry: { tintIndex: number; maskRect: { x: number; y: number; w: number; h: number }; strength: number },
  paletteColor: (i: number) => string,
): DyeUniformPayload {
  const hex = paletteColor(entry.tintIndex);
  return {
    tint: hexToRgb01(hex),
    maskRect: { ...entry.maskRect },
    strength: entry.strength,
  };
}

/**
 * 染色材质只有**一组** uniform 槽位(`uDyeTint`/`uDyeMaskRect`/`uDyeStrength` 都是单值),
 * 因此一次上传只能表达**一个**表面。多表面走 `DyeChannel.exportUniformArray()` +
 * 实例化属性那条路径,不走这里。
 *
 * 这解释了为什么本函数返回的是「是否成功上传」(1/0)而不是「上传了多少条」:
 * 早期实现按 `entries.length` 计数,把「循环写同一个槽位 N 次」误报成「N 个表面已上传」,
 * 实际上只有最后一条可见 —— 一个因为整块代码从未被测试而长期潜伏的计数错误。
 */
export function dyeUploadCount(entries: readonly unknown[]): number {
  return entries.length > 0 ? 1 : 0;
}
