/**
 * WS-09 / 实体立牌与 16×16 像素纹理生成 —— 纯数据层(不 import three)。
 *
 * 三个职责:
 *  1. **8 帧朝向映射**:2.5D 舞台使用立牌(billboard)表现角色,立牌永远面向相机,
 *     但帧号随「世界朝向」切换 —— 8 个方向 × 每方向 1 帧 = 8 帧图集。
 *  2. **AI 炼金武器 16×16 纹理生成**:把 WS-06(`shared/types/alchemy.ts`)
 *     输出的 `visual_style.pixel_icon_16x16`(16 行 × 16 列调色盘字符)转成
 *     1024 字节 RGBA,直接喂给 `THREE.DataTexture`。测试断言 RGBA 长度 1024。
 *  3. **粒子光环挂点**:每件武器声明若干 anchor(世界偏移 + 类别),
 *     装配层据此挂 `ParticlePool` 的发射器。
 *
 * 调色盘约定(与 docs 参数表一致):
 *   '0' 透明   '1' 主色(primary_color_hex)
 *   '2' 副色(secondary_color_hex)  '3' 描边(outline_color_hex)
 *   '.' / ' ' 也视为透明(容忍 LLM 输出的空位)
 */

import type { VisualStyle } from '../../../shared/types/alchemy.ts';

/** 纹理边长(像素) */
export const ICON_SIZE = 16;
/** 像素总数 */
export const ICON_PIXELS = ICON_SIZE * ICON_SIZE;
/** RGBA 字节数 = 16×16×4 = 1024 */
export const ICON_RGBA_BYTES = ICON_PIXELS * 4;

/** 8 帧朝向:0=北 1=东北 2=东 3=东南 4=南 5=西南 6=西 7=西北 */
export const FACING_COUNT = 8;

export const FACING_LABEL: readonly string[] = [
  '北', '东北', '东', '东南', '南', '西南', '西', '西北',
];

/** 与 `shared/types/tile.ts` 的 faceDir(0=北 1=东 2=南 3=西)对齐 */
export const FACING_TO_FACEDIR: readonly number[] = [0, 0, 1, 2, 2, 2, 3, 0];

/** 世界方向向量(XY 平面,与 tick 无关的纯几何) */
export const FACING_VECTORS: readonly { x: number; y: number }[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];

/**
 * 速度向量 → 8 帧朝向;零向量保持 fallback。
 * atan2 的 0 弧度指向 +X(东) = 帧 2,故整体平移 +2 后取模。
 */
export function facingFromVelocity(vx: number, vy: number, fallback = 4): number {
  if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9) return fallback;
  const ang = Math.atan2(vy, vx);
  const sector = Math.round(ang / (Math.PI / 4));
  return ((sector + 2) % 8 + 8) % 8;
}

/** 8 帧朝向 → 图集 UV 偏移(0..1),供 shader 采样 */
export function facingToAtlasUv(facing: number): { u: number; v: number } {
  const f = ((Math.trunc(facing) % FACING_COUNT) + FACING_COUNT) % FACING_COUNT;
  return { u: f / FACING_COUNT, v: 0 };
}

/** 立牌在屏幕上的基准高度(像素),随实体体量缩放 */
export const SPRITE_HEIGHT_PX: Record<string, number> = {
  player: 28,
  mob: 22,
  boss: 72,
  pet: 18,
  prop: 16,
};

export function spriteHeightPx(kind: string, bodyScale = 1): number {
  const base = SPRITE_HEIGHT_PX[kind] ?? SPRITE_HEIGHT_PX.prop;
  return base * Math.max(0.1, bodyScale);
}

/* ───────────────────── 颜色与调色盘 ───────────────────── */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** '#RRGGBB' / '#RGB' → RGBA(0..255),非法输入回退为品红以便一眼识别 */
export function hexToRgba(hex: string, alpha = 255): Rgba {
  if (typeof hex !== 'string') return { r: 255, g: 0, b: 255, a: alpha };
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 255, g: 0, b: 255, a: alpha };
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
    a: alpha,
  };
}

/** 调色盘字符 → RGBA;a=0 表示透明 */
export function paletteCharToRgba(ch: string, style: VisualStyle): Rgba {
  if (ch === '1') return hexToRgba(style.primary_color_hex, 255);
  if (ch === '2') return hexToRgba(style.secondary_color_hex, 255);
  if (ch === '3') return hexToRgba(style.outline_color_hex, 255);
  return { r: 0, g: 0, b: 0, a: 0 };
}

/* ───────────────────── 像素矩阵 → RGBA ───────────────────── */

export interface PixelMatrixStats {
  /** 非透明像素数 */
  opaquePixels: number;
  /** 每类调色盘字符出现次数,索引 0..3 */
  usage: number[];
  /** 行数 / 列数 */
  rows: number;
  cols: number;
}

/**
 * 16×16 调色盘字符矩阵 → 1024 字节 RGBA(Uint8Array)。
 *
 * 行序:数组第 0 行 = 图像最上方(Top),与 Canvas 2D 的 ImageData 一致;
 * 装配层用 `THREE.DataTexture(data, 16, 16)` 时需 `flipY = false`。
 *
 * 容错:
 *  - 行数不足 16 时补空行;超过 16 行截断;
 *  - 列数不足 16 时补透明;超过 16 列截断;
 *  - 未知字符一律透明。
 */
export function pixelIconToRgba(rows: readonly string[], style: VisualStyle): Uint8Array {
  const out = new Uint8Array(ICON_RGBA_BYTES);
  const list = Array.isArray(rows) ? rows : [];
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const row = typeof list[y] === 'string' ? list[y] : '';
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const ch = x < row.length ? row[x] : '0';
      const c = paletteCharToRgba(ch, style);
      const o = (y * ICON_SIZE + x) * 4;
      out[o] = c.r;
      out[o + 1] = c.g;
      out[o + 2] = c.b;
      out[o + 3] = c.a;
    }
  }
  return out;
}

/** 只统计字符分布,不生成 RGBA */
export function pixelIconStats(rows: readonly string[]): PixelMatrixStats {
  const usage = [0, 0, 0, 0];
  let opaque = 0;
  const list = Array.isArray(rows) ? rows : [];
  const rowCount = Math.min(ICON_SIZE, list.length);
  let maxCols = 0;
  for (let y = 0; y < rowCount; y += 1) {
    const row = typeof list[y] === 'string' ? list[y] : '';
    if (row.length > maxCols) maxCols = row.length;
    for (let x = 0; x < Math.min(ICON_SIZE, row.length); x += 1) {
      const ch = row[x];
      const k = ch === '1' ? 1 : ch === '2' ? 2 : ch === '3' ? 3 : 0;
      usage[k] += 1;
      if (k !== 0) opaque += 1;
    }
  }
  return { opaquePixels: opaque, usage, rows: list.length, cols: maxCols };
}

/** 空(合法但全透明)图标,给 LLM 输出缺字段时兜底 */
export function blankIconRows(): string[] {
  return Array.from({ length: ICON_SIZE }, () => '0'.repeat(ICON_SIZE));
}

/** 把任意字符串数组规整成 16×16(补 '0' / 截断) */
export function normalizeIconRows(rows: readonly string[]): string[] {
  const list = Array.isArray(rows) ? rows : [];
  const out: string[] = [];
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const row = typeof list[y] === 'string' ? list[y] : '';
    out.push(row.slice(0, ICON_SIZE).padEnd(ICON_SIZE, '0'));
  }
  return out;
}

/* ───────────────────── 程序化兜底图标 ───────────────────── */

/** 9 种剪影的默认 16×16 图案(LLM 缺 pixel_icon 时使用) */
export const SILHOUETTE_PATTERNS: Record<string, string[]> = {
  SWORD: [
    '0000000000003000',
    '0000000000031000',
    '0000000000310000',
    '0000000003100000',
    '0000000031000000',
    '0000000310000000',
    '0000003100000000',
    '0000031000000000',
    '0002200000000000',
    '0022220000000000',
    '0002200000000000',
    '0022000000000000',
    '0220000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  HAMMER: [
    '0033333333330000',
    '0031111111130000',
    '0031111111130000',
    '0033333333330000',
    '0000003100000000',
    '0000003100000000',
    '0000003100000000',
    '0000003100000000',
    '0000003100000000',
    '0000003100000000',
    '0000003100000000',
    '0000003200000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  BOW: [
    '0003000030000000',
    '0031000001300000',
    '0310000000130000',
    '3100000000013000',
    '3100000000013000',
    '0310000000130000',
    '0031000001300000',
    '0003100013000000',
    '0000310030000000',
    '0000031300000000',
    '0000003000000000',
    '0000002000000000',
    '0000002000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  WAND: [
    '0000000000003000',
    '0000000000031300',
    '0000000000311000',
    '0000000003100000',
    '0000000031000000',
    '0000000310000000',
    '0000003100000000',
    '0000031000000000',
    '0000310000000000',
    '0003100000000000',
    '0032000000000000',
    '0200000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  POTION: [
    '0000003000000000',
    '0000003100000000',
    '0000001300000000',
    '0000001300000000',
    '0000011110000000',
    '0000111111000000',
    '0001122211000000',
    '0001222221000000',
    '0001222221000000',
    '0001122211000000',
    '0000111111000000',
    '0000011110000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  BOMB: [
    '0000000003000000',
    '0000000031300000',
    '0000000310000000',
    '0000003000000000',
    '0000111111100000',
    '0001111111110000',
    '0011111111111000',
    '0011222222211000',
    '0011222222211000',
    '0011111111111000',
    '0001111111110000',
    '0000111111100000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  HAT: [
    '0000000000000000',
    '0000001100000000',
    '0000011110000000',
    '0000111111000000',
    '0001111111100000',
    '0001111111100000',
    '0001111111100000',
    '0001111111100000',
    '0001111111100000',
    '0003333333300000',
    '0033333333330000',
    '0333333333333000',
    '0033333333300000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  SHIELD: [
    '0033333333330000',
    '0311111111130000',
    '0311222222130000',
    '0311222222130000',
    '0311222222130000',
    '0311222222130000',
    '0311111111130000',
    '0031111111300000',
    '0003111113000000',
    '0000311130000000',
    '0000031300000000',
    '0000003000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ],
  GIZMO: [
    '0000000000000000',
    '0001111111100000',
    '0011000000110000',
    '0110000000011000',
    '0110022200011000',
    '0110222220011000',
    '0110222220011000',
    '0110022200011000',
    '0110000000011000',
    '0011000000110000',
    '0001111111100000',
    '0000003330000000',
    '0000003230000000',
    '0000003330000000',
    '0000000000000000',
    '0000000000000000',
  ],
};

export function patternForSilhouette(silhouette: string): string[] {
  const p = SILHOUETTE_PATTERNS[silhouette];
  return p ? [...p] : blankIconRows();
}

/** 取图标行:优先 LLM 输出,缺失/畸形时退回剪影兜底 */
export function resolveIconRows(style: VisualStyle): string[] {
  const rows = style && Array.isArray(style.pixel_icon_16x16) ? style.pixel_icon_16x16 : [];
  if (rows.length === 0) return patternForSilhouette(style?.base_silhouette ?? 'GIZMO');
  return normalizeIconRows(rows);
}

/* ───────────────────── 粒子光环挂点 ───────────────────── */

export interface AuraAnchor {
  /** 相对实体中心的偏移(格) */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  kind: number;
  scale: number;
}

/** 每种 ParticleAura 的挂点布局(格偏移),由装配层换算成世界坐标 */
export const AURA_ANCHORS: Record<string, AuraAnchor[]> = {
  NONE: [],
  SPARKLE: [
    { offsetX: 0, offsetY: 0, offsetZ: 1.1, kind: 5, scale: 0.6 },
    { offsetX: 0.3, offsetY: 0, offsetZ: 0.8, kind: 4, scale: 0.4 },
  ],
  BUBBLES: [
    { offsetX: -0.25, offsetY: 0, offsetZ: 0.5, kind: 1, scale: 0.5 },
    { offsetX: 0.25, offsetY: 0, offsetZ: 0.9, kind: 1, scale: 0.5 },
  ],
  FLAME: [
    { offsetX: 0, offsetY: 0, offsetZ: 0.9, kind: 2, scale: 0.7 },
    { offsetX: 0.2, offsetY: 0, offsetZ: 1.2, kind: 2, scale: 0.5 },
  ],
  SNOW: [
    { offsetX: 0, offsetY: 0, offsetZ: 1.0, kind: 3, scale: 0.6 },
  ],
  MUSIC_NOTES: [
    { offsetX: 0.35, offsetY: 0, offsetZ: 1.0, kind: 5, scale: 0.45 },
  ],
  SLIME_DRIP: [
    { offsetX: 0, offsetY: 0, offsetZ: 0.2, kind: 1, scale: 0.5 },
    { offsetX: -0.3, offsetY: 0, offsetZ: 0.15, kind: 1, scale: 0.35 },
  ],
};

export function auraAnchors(aura: string): AuraAnchor[] {
  return AURA_ANCHORS[aura] ?? AURA_ANCHORS.NONE;
}

/**
 * 武器在实体手中的持握挂点(格偏移),随 8 帧朝向旋转。
 *
 * **必须归一化**:`FACING_VECTORS` 的四个对角线方向是 (±1, ±1),模长为 √2;
 * 若不归一化,持武器的手会在这 4 个朝向上甩到 0.4525 格处(比其他朝向远 41%),
 * 表现为武器「一跳一跳」。归一化后所有朝向的手部半径恒为 0.32 格。
 */
export function weaponHoldOffset(facing: number): { x: number; y: number; z: number } {
  const f = ((Math.trunc(facing) % FACING_COUNT) + FACING_COUNT) % FACING_COUNT;
  const v = FACING_VECTORS[f];
  const len = Math.hypot(v.x, v.y) || 1;
  const r = 0.32;
  return { x: (v.x / len) * r, y: (v.y / len) * r, z: 0.55 };
}

/* ───────────────────── 完整纹理包 ───────────────────── */

export interface WeaponTextureBundle {
  /** 1024 字节 RGBA */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** 非透明像素占比 0..1 */
  coverage: number;
  /** 是否有描边像素 */
  hasOutline: boolean;
  anchors: AuraAnchor[];
}

/**
 * 一站式:LLM `VisualStyle` → GPU 纹理数据 + 挂点。
 * 复杂度 O(256),单件武器亚微秒级,可每帧重建(但装配层应缓存)。
 */
export function buildWeaponTexture(style: VisualStyle): WeaponTextureBundle {
  const rows = resolveIconRows(style);
  const rgba = pixelIconToRgba(rows, style);
  const stats = pixelIconStats(rows);
  return {
    rgba,
    width: ICON_SIZE,
    height: ICON_SIZE,
    coverage: stats.opaquePixels / ICON_PIXELS,
    hasOutline: stats.usage[3] > 0,
    anchors: auraAnchors(style?.particle_aura ?? 'NONE'),
  };
}

/** 校验 16×16 矩阵合法性(给 WS-06 输出的门禁复用) */
export function validateIconRows(rows: readonly string[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(rows)) return { ok: false, errors: ['不是数组'] };
  if (rows.length !== ICON_SIZE) errors.push(`行数 ${rows.length} ≠ 16`);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (typeof r !== 'string') { errors.push(`第 ${i} 行不是字符串`); continue; }
    if (r.length !== ICON_SIZE) errors.push(`第 ${i} 行列数 ${r.length} ≠ 16`);
    for (const ch of r) if (!'0123. '.includes(ch)) errors.push(`第 ${i} 行含非法字符 '${ch}'`);
  }
  return { ok: errors.length === 0, errors };
}