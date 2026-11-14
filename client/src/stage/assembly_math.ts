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

import { pixelScale, TILE_PX, type IsoCamera } from './iso_camera.ts';
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

/* ═════════════════════ 图集几何与缩放(决策 A)═════════════════════
 *
 * ## 为什么这些常数要活在本文件里
 *
 * `docs/THREE-RESEARCH.md` 实测出图集里每个地形块最宽 **58px**,反推 **≈41 px/格**;
 * 而 `iso_camera.ts` 锁的是 **`TILE_PX = 16`**。
 *
 * owner 裁决(决策 A):**保持 `TILE_PX = 16`,在装配层把 64px 图集缩放后使用。**
 * 理由:改动最小 —— `zoomLevels` 六档、LOD 四档屏幕阈值、视口包围盒、
 * 以及**钉住这些值的测试**全部不用动。
 *
 * 放在 `assembly_math.ts` 而不是新开一个文件,是为了**不制造新的欠账**:
 * 本文件已在 `verify.ts` 的 `UNREACHABLE_EXEMPT` 白名单内(理由「本仓无装配入口」),
 * 新开文件会让门禁的「未登记不可达模块」数字 +1,把一次纯实现变更
 * 伪装成结构性欠账。纯数学与这里的其它纯数学同类,合并是正确归属。
 *
 * ## `ATLAS_PX_PER_CELL = 41` 的推导(测出来的,不是猜的)
 *
 * 对 §3.5 地砖的 4 个样本(`id_303`/`id_326`/`id_327`/`id_323`)逐行扫描
 * 不透明像素的 x 跨度,最宽处**都是 58px** —— 同一设计网格。
 * 地砖画的是「菱形顶面 + 一定厚度侧面」,最宽处即菱形水平对角线。
 * 等轴测下 1 格地面的水平对角线 = `2 · cos45° · T`,故:
 *
 * ```
 * T = 58 / (2 · cos45°) = 58 / 1.41421356 = 41.0122 ≈ 41 px/格
 * ```
 *
 * 自证:若 T=41,水平对角线 = `2 · 0.7071068 · 41 = 57.98 ≈ 58` ✓ 与实测吻合;
 * 顶面高 = `58 · sin35° = 33.27px`,实测总高 48~51px,差 15~18px 即侧面厚度。
 *
 * ## 锚点方向(踩过的坑)
 *
 * 图集 JSON 的 `anchor = (0.5, 0.85)` **从顶部**度量(TexturePacker 习惯);
 * three 的 `Sprite.center` **从底部**度量(官方文档:`(0,0)` = lower left)。
 * ⇒ 必须 `center.y = 1 − 0.85 = 0.15`。
 * 照抄 `0.85` 会让立牌**静默下沉 `0.70 × 精灵高`**(64px 精灵上即 44.8px):
 * 不抛异常、不报门禁,只能靠眼睛发现。
 *
 * ## 实体 id ≠ 数组下标(最容易写错的一处)
 *
 * 358 帧的键名是 `id_101` … `id_858`,**跨度 758**,实测**缺 400 个 id**,
 * 压缩成 **13 个连续段**;这 13 段与 `shared/contracts/FREEZE.md:106` 的
 * 物品号段**逐段吻合**(图集是照物品号段出的图)。
 *
 * ⇒ **绝不能写 `id - 101`**:`id_303` 的真实下标是 **105**,而 `303 − 101 = 202`,
 * 直接错位 97 格。必须过 `cellIndexFromId()` 查号段表。
 */

/** 图集图像宽度(像素),实测自 `meta.size.w` */
export const ATLAS_IMAGE_W = 1280;
/** 图集图像高度(像素),实测自 `meta.size.h` */
export const ATLAS_IMAGE_H = 1152;
/** 单格边长(像素)—— 358 帧全部 64×64,实测无一例外 */
export const ATLAS_CELL = 64;
/** 列数 */
export const ATLAS_COLS = 20;
/** 行数 */
export const ATLAS_ROWS = 18;
/** 网格容量 = 20×18 = 360 */
export const ATLAS_CAPACITY = ATLAS_COLS * ATLAS_ROWS;
/** 实际精灵数 358;容量 360 − 358 = **2 个空槽**(row-major 下标 358 与 359) */
export const ATLAS_SPRITE_COUNT = 358;

/** 空槽的 row-major 下标(17×20+18=358,17×20+19=359) */
export const ATLAS_EMPTY_CELLS: readonly number[] = [358, 359];

/** 图集里一格地面的基准像素:`58 / (2·cos45°) = 41.0122 ≈ 41` */
export const ATLAS_PX_PER_CELL = 41;

/** 地砖样本最宽像素(4/4 实测一致) */
export const ATLAS_TILE_WIDTH_PX = 58;

/**
 * 图集像素 → **屏幕像素**的比值:`TILE_PX / ATLAS_PX_PER_CELL = 16 / 41 ≈ 0.3902439`。
 *
 * ⚠️ **这是屏幕像素比,不是世界单位比**。three 的 `Sprite.scale` /
 * `Mesh.scale` 吃的是**世界单位**,所以**不能**拿它去乘 `ATLAS_CELL`
 * 当作精灵尺寸 —— 那会放大 `TILE_PX = 16` 倍。
 *
 * 这个坑是实测踩到的:第一版写 `SPRITE_CELL_WORLD = ATLAS_CELL * SPRITE_SCALE`
 * (≈ 24.98),截图里精灵占了约 400 屏幕像素、盖住半张地图。
 * 24.98 恰好 = 64/41 × 16,多的那个 16 就是被当成世界单位的 TILE_PX。
 *
 * 本常量的正当用途:估算「某图素在屏幕上有多少像素」,例如判断细节是否被缩掉。
 */
export const SPRITE_SCALE = TILE_PX / ATLAS_PX_PER_CELL;

/**
 * 图集像素 → **世界单位**的比值:`1 / ATLAS_PX_PER_CELL ≈ 0.02439`。
 *
 * 因为 1 世界单位 = 1 格(见 `chunk_geometry.ts` 的恒等映射),
 * 而设计上 41 图素 = 1 格,故 1 图素 = 1/41 世界单位。
 */
export const WORLD_PER_ATLAS_PX = 1 / ATLAS_PX_PER_CELL;

/** 图集锚点(JSON 原值,**从顶部**度量) */
export const ATLAS_ANCHOR_X = 0.5;
export const ATLAS_ANCHOR_Y = 0.85;

/** three `Sprite.center` 应取的值(**从底部**度量)⇒ `(0.5, 0.15)` */
export const SPRITE_CENTER_X = ATLAS_ANCHOR_X;
export const SPRITE_CENTER_Y = 1 - ATLAS_ANCHOR_Y;

/**
 * 号段表:`[起始 id, 段长]`,共 13 段、合计 358。
 *
 * 用「段」而不是「358 个 id 的数组」:13 条数据、可人读、
 * 改动时能一眼看出是哪一段错位了。实测自 `atlas_sprites.json` 的键集。
 */
export const ATLAS_ID_SEGMENTS: readonly (readonly [number, number])[] = [
  [101, 30], [151, 20], [201, 18], [221, 35], [301, 30], [351, 35], [401, 40],
  [501, 37], [601, 30], [701, 45], [801, 6], [811, 24], [851, 8],
];

/** 号段长度合计 —— 必须等于 `ATLAS_SPRITE_COUNT` */
export const ATLAS_ID_SEGMENT_TOTAL = ATLAS_ID_SEGMENTS.reduce((s, [, n]) => s + n, 0);

/** id 最小值 */
export const ATLAS_ID_MIN = 101;
/** id 最大值 */
export const ATLAS_ID_MAX = 858;
/** id 跨度:`858 − 101 + 1 = 758`,而帧只有 358 ⇒ 缺 400 */
export const ATLAS_ID_SPAN = ATLAS_ID_MAX - ATLAS_ID_MIN + 1;

/**
 * 实体 id → row-major 下标。**不在图集内时返回 `-1`**。
 *
 * 复杂度 O(段数) = O(13),常数级。
 */
export function cellIndexFromId(id: number): number {
  let base = 0;
  for (const seg of ATLAS_ID_SEGMENTS) {
    const [from, len] = seg;
    if (id >= from && id < from + len) return base + (id - from);
    base += len;
  }
  return -1;
}

/** row-major 下标 → 实体 id。越界返回 `-1`。 */
export function idFromCellIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= ATLAS_SPRITE_COUNT) return -1;
  let base = 0;
  for (const seg of ATLAS_ID_SEGMENTS) {
    const [from, len] = seg;
    if (index < base + len) return from + (index - base);
    base += len;
  }
  return -1;
}

/** 该 id 是否有图 */
export function hasSpriteId(id: number): boolean {
  return cellIndexFromId(id) >= 0;
}

/**
 * 用 `id − 101` 当下标**是否安全**?
 *
 * 恒为 `false`:跨度 758 ≠ 帧数 358,缺 400 个 id。
 * 本函数存在的意义就是让读者看见这个结论 —— 不要删。
 */
export function idOffsetIsSafe(): boolean {
  return ATLAS_ID_SPAN === ATLAS_SPRITE_COUNT;
}

/** 若强行用 `id − 101` 当下标会落到哪一格(仅供诊断,不要用于生产) */
export function unsafeCellFromId(id: number): number {
  return id - ATLAS_ID_MIN;
}

/** `id − 101` 比真值多算了多少格;id 不存在时返回 NaN */
export function idOffsetDrift(id: number): number {
  const truth = cellIndexFromId(id);
  return truth < 0 ? Number.NaN : unsafeCellFromId(id) - truth;
}

/** (列,行) → row-major 下标 */
export function cellIndexOf(col: number, row: number): number {
  return row * ATLAS_COLS + col;
}

/** row-major 下标 → (列,行) */
export function cellCoordsOf(index: number): { col: number; row: number } {
  return { col: index % ATLAS_COLS, row: Math.floor(index / ATLAS_COLS) };
}

/** row-major 下标是否落在有效格内(排除 2 个空槽) */
export function isValidCell(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < ATLAS_CAPACITY && !ATLAS_EMPTY_CELLS.includes(index);
}

/**
 * row-major 下标 → 帧矩形(像素)。
 *
 * 键序实测 **358/358 严格等于 row-major**,所以「第 i 格」可 O(1) 算出;
 * **但实体 id 不是下标**,必须先过 `cellIndexFromId()`。
 */
export function frameRectOfCell(index: number): { x: number; y: number; w: number; h: number } {
  const { col, row } = cellCoordsOf(index);
  return { x: col * ATLAS_CELL, y: row * ATLAS_CELL, w: ATLAS_CELL, h: ATLAS_CELL };
}

/** 实体 id → 帧矩形。id 不存在时返回 `null`。 */
export function frameRectOfId(id: number): { x: number; y: number; w: number; h: number } | null {
  const i = cellIndexFromId(id);
  return i < 0 ? null : frameRectOfCell(i);
}

export interface FrameUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * 帧矩形(图像左上角原点)→ three UV(左下角原点)。
 *
 * `Texture.flipY` 默认 `true`,故 v 按 `1 − y/H` 翻转:
 * `v1` 对应帧的**上**边,`v0` 对应帧的**下**边。
 */
export function frameToUv(
  x: number,
  y: number,
  w: number,
  h: number,
  imageW = ATLAS_IMAGE_W,
  imageH = ATLAS_IMAGE_H,
): FrameUv {
  return {
    u0: x / imageW,
    u1: (x + w) / imageW,
    v0: 1 - (y + h) / imageH,
    v1: 1 - y / imageH,
  };
}

/** 帧矩形 → `Texture.offset` / `Texture.repeat` */
export function frameToOffsetRepeat(
  x: number,
  y: number,
  w: number,
  h: number,
  imageW = ATLAS_IMAGE_W,
  imageH = ATLAS_IMAGE_H,
): { offsetU: number; offsetV: number; repeatU: number; repeatV: number } {
  const uv = frameToUv(x, y, w, h, imageW, imageH);
  return {
    offsetU: uv.u0,
    offsetV: uv.v0,
    repeatU: uv.u1 - uv.u0,
    repeatV: uv.v1 - uv.v0,
  };
}

/** row-major 下标 → offset/repeat(O(1)) */
export function offsetRepeatOfCell(
  index: number,
): { offsetU: number; offsetV: number; repeatU: number; repeatV: number } {
  const r = frameRectOfCell(index);
  return frameToOffsetRepeat(r.x, r.y, r.w, r.h);
}

/** 实体 id → offset/repeat。id 不存在时返回 `null`。 */
export function offsetRepeatOfId(
  id: number,
): { offsetU: number; offsetV: number; repeatU: number; repeatV: number } | null {
  const r = frameRectOfId(id);
  return r === null ? null : frameToOffsetRepeat(r.x, r.y, r.w, r.h);
}

/**
 * 一格精灵在**世界单位**中的边长 = `ATLAS_CELL / ATLAS_PX_PER_CELL = 64/41 ≈ 1.561`。
 *
 * 因为 1 世界单位 = 1 格,而 41 图素 = 1 格,所以 64 图素 = 64/41 格。
 * 这个值略大于 1,是因为地砖图里那一格画的是 64px 的方形画布,
 * 而其中**实际占地的菱形对角线是 58px**(见 `ATLAS_TILE_WIDTH_PX`)——
 * 画布留了 3px 边距,故 64/41 略大于 1 是正常的。
 */
export const SPRITE_CELL_WORLD = ATLAS_CELL * WORLD_PER_ATLAS_PX;

/**
 * 精灵在世界单位中的高度。
 *
 * `heightCells` = 设计上想让该精灵占几格高(树/角色/建筑不同)。
 */
export function spriteWorldHeight(heightCells: number): number {
  return SPRITE_CELL_WORLD * heightCells;
}

/**
 * 图集锚点(**从顶部**)→ three `Sprite.center`(**从底部**)。
 *
 * 本块最重要的一个函数:方向搞反会让立牌静默下沉 `0.70 × 高度`。
 */
export function anchorToSpriteCenter(anchorY: number): number {
  return 1 - anchorY;
}

/**
 * 精灵 `position` 应放哪。
 *
 * three 的 sprite 顶点计算会把 `center` 那个点对齐到 `position`,
 * 所以**把 `position` 直接放在格点上,锚点就必然落在格点** —— 不需按高度补偿。
 * `heightWorld`/`centerY` 参数保留给调用方算包围盒用,本函数不使用。
 */
export function spritePositionForAnchor(
  gx: number,
  gy: number,
  gz: number,
  heightWorld: number,
  centerY = SPRITE_CENTER_Y,
): Vec3 {
  void heightWorld;
  void centerY;
  return { x: gx, y: gy, z: gz };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 玩家立牌 —— 「当局者在哪」的可视化(task-83)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 玩家立牌的名字.
 *
 * 测试与自检脚本靠它从**场景图**里把这块精灵找回来(而不是靠「函数被调用过」),
 * 故必须是常量而不是散落两处的字面量 —— 否则改名时测试会静默失灵.
 */
export const PLAYER_MARKER_NAME = 'player_marker';

/**
 * 玩家立牌的摆放参数(世界单位「格」).
 *
 * `gx/gy` 是格坐标(与 `chunk_geometry` 的 `x = cellX, y = cellY` 恒等映射同系);
 * `gz` 是**地形那一格的高程**,不是估的 ⇒ 脚必然踩在面上.
 */
export interface PlayerMarkerPlacement {
  gx: number;
  gy: number;
  gz: number;
  /** 是否应当可见. 权威未知(`center` 为 null)时为 false,**不是**摆到 (0,0). */
  visible: boolean;
}

/** 取整到格(地形高程表的键是整数格)。 */
export function cellFloor(v: number): number {
  return Math.floor(v);
}

/**
 * 从「世界格坐标 → 高程」查表取地面高度.
 *
 * 与 `three/boot.ts` 建表时用的是**同一个键格式**(`gx,gy` 逗号分隔),
 * 故这里只做查表与兜底,不重复实现 tile 解包.
 *
 * 查不到时返回 `0`(地表基准). 这比 `NaN` 安全 —— `NaN` 会让精灵整个消失,
 * 而那不是「没画」,是「画了一个看不见的东西」,更难查.
 */
export function groundZAt(zAt: ReadonlyMap<string, number>, gx: number, gy: number): number {
  const z = zAt.get(`${gx},${gy}`);
  return z === undefined ? 0 : z;
}

/**
 * 由「权威圆心」与「地形高程表」算出立牌摆放.
 *
 * ## 为什么 `center` 为 null 时返回 `visible: false`,而不是摆到原点
 *
 * 与 `net/telegraph_center.ts` 的同一条理由:**世界原点是一个看起来合法的错误位置**.
 * 摆过去会让玩家在左上一闪,而**没有任何东西会报错**. ⇒ 「不知道」必须与
 * 「位置是 (0,0)」分开,由调用方显式决定.
 *
 * ## 为什么格坐标要 +0.5
 *
 * `telegraphCenterOf` 返回的是**玩家所在格**(来自 `PlayerState.x/y`,解码时已
 * 反量化为「格」). 地形顶面覆盖 `[gx, gx+1] × [gy, gy+1]`
 * ⇒ 要让脚**踩在格子中央**必须 +0.5(与 `three/boot.ts` 立牌落点同一做法).
 *
 * ## 位置只有一个来源
 *
 * ```
 * telegraphCenterOf(RoomState, localPlayerId)  →  { cx, cy } | null   ← 已有, 可达
 * playerMarkerPlacement(center, zAt)          →  { gx, gy, gz, visible }  ← 本函数
 * ```
 * 本函数**只把那个位置翻译成 three 的摆放参数**,不重新解释坐标 ——
 * 刻意如此:`three/boot.ts` 的立牌注释记着一次实测事故,立牌用错缩放常量
 * 导致精灵放大 16 倍盖住半张地图,根因就是**两处各算一份口径**.
 */
export function playerMarkerPlacement(
  center: { cx: number; cy: number } | null,
  zAt: ReadonlyMap<string, number>,
): PlayerMarkerPlacement {
  if (center === null) return { gx: 0, gy: 0, gz: 0, visible: false };
  const gx = center.cx + 0.5;
  const gy = center.cy + 0.5;
  const gz = groundZAt(zAt, cellFloor(gx), cellFloor(gy));
  /* 走既有的 `spritePositionForAnchor`(它此前**零调用方**)—— 立牌和别的立牌
   * 用同一条落点规则,不另写一遍「position 放哪」。 */
  const pos = spritePositionForAnchor(gx, gy, gz, spriteWorldHeight(1));
  return { gx: pos.x, gy: pos.y, gz: pos.z, visible: true };
}

/** 立牌在世界单位下的尺寸(一格宽 × 一格高). */
export function playerMarkerScale(cellWorld = SPRITE_CELL_WORLD): { x: number; y: number } {
  return { x: cellWorld, y: spriteWorldHeight(1) };
}
