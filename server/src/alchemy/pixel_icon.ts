/**
 * WS-06 §5.5 十六进制像素立牌:调色盘字符矩阵 → RGBA 字节流 → CanvasTexture 载荷。
 *
 * 数据流:
 *   调色盘字符矩阵(16 行 × 16 列,字符∈PALETTE)
 *     → validatePixelMatrix() 逐行逐列校验
 *     → rasterizePixelIcon() 展开为 Uint8Array(16×16×4),行主序、逐像素 RGBA
 *     → buildCanvasTexturePayload() 打包成客户端可直接 new THREE.CanvasTexture 的结构
 *
 * 坐标系与 Tile 无关:这是「物品立牌 / 展示架贴图」,固定 16px,
 * 每 1px 对应世界立方体 1/16 格,由客户端 UI 层自行放大并强制最近邻采样。
 */

import {
  BaseSilhouette,
  type VisualStyle,
} from '../../../shared/types/alchemy.ts';

/* ══════════════════════════════════════════════════════════════
 * 1. 调色盘
 * ══════════════════════════════════════════════════════════════ */

export const ICON_SIZE = 16;
export const ICON_BYTES = ICON_SIZE * ICON_SIZE * 4;

export const PALETTE_CHAR = {
  TRANSPARENT: '0',
  PRIMARY: '1',
  SECONDARY: '2',
  OUTLINE: '3',
  HIGHLIGHT: '4',
} as const;
export type PaletteChar = (typeof PALETTE_CHAR)[keyof typeof PALETTE_CHAR];

export const PALETTE_KEYS: readonly string[] = ['0', '1', '2', '3', '4'];

export const PALETTE_MEANING: Record<string, string> = {
  '0': '透明(alpha=0,RGB 仍写主色,避免某些混合器出现黑边)',
  '1': '主色 primary_color_hex',
  '2': '副色 secondary_color_hex',
  '3': '描边 outline_color_hex',
  '4': '高光 副色向白色 lerp 35%',
};

/* ══════════════════════════════════════════════════════════════
 * 2. 九个剪影的规范美术(全部手绘,每行严格 16 字符)
 * ══════════════════════════════════════════════════════════════ */

export const SILHOUETTE_ART: Record<BaseSilhouette, readonly string[]> = {
  SWORD: [
    '0000000330000000',
    '0000003113000000',
    '0000003113000000',
    '0000003413000000',
    '0000003413000000',
    '0000003413000000',
    '0000003113000000',
    '0000003113000000',
    '0000003113000000',
    '0000003113000000',
    '0000333333330000',
    '0000322222230000',
    '0000003223000000',
    '0000003223000000',
    '0000003113000000',
    '0000000330000000',
  ],
  HAMMER: [
    '0003333333330000',
    '0003111111113000',
    '0003111144443000',
    '0003111122223000',
    '0003111111113000',
    '0003333333330000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000003223000000',
    '0000000330000000',
  ],
  BOW: [
    '0000003300030000',
    '0000003100030000',
    '0000031000030000',
    '0000031000030000',
    '0000310000030000',
    '0000310000030000',
    '0000320000030000',
    '0000320000030000',
    '0000320000030000',
    '0000310000030000',
    '0000310000030000',
    '0000031000030000',
    '0000031000030000',
    '0000003100030000',
    '0000003100030000',
    '0000003300030000',
  ],
  WAND: [
    '0000000330000000',
    '0000003223000000',
    '0000031111300000',
    '0000003113000000',
    '0000000330000000',
    '0000000000000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000323000000',
    '0000000333000000',
  ],
  POTION: [
    '0000000220000000',
    '0000000320000000',
    '0000000320000000',
    '0000003223000000',
    '0000031111300000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000322222230000',
    '0000322222230000',
    '0000322222230000',
    '0000032222300000',
    '0000003223000000',
    '0000000330000000',
    '0000000000000000',
  ],
  BOMB: [
    '0000000004000000',
    '0000000033000000',
    '0000000330000000',
    '0000003330000000',
    '0000311441130000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000311111130000',
    '0000032222300000',
    '0000003223000000',
    '0000000330000000',
    '0000000000000000',
  ],
  HAT: [
    '0000000320000000',
    '0000000320000000',
    '0000003223000000',
    '0000003113000000',
    '0000031111300000',
    '0000031221300000',
    '0000312222130000',
    '0000312222130000',
    '0003122222213000',
    '0003111111113000',
    '0003111111113000',
    '0032222222223000',
    '0322222222222230',
    '0322222222222230',
    '0032222222223000',
    '0033333333333000',
  ],
  SHIELD: [
    '0000333333330000',
    '0000311111130000',
    '0000312222130000',
    '0000312222130000',
    '0000312442130000',
    '0000312222130000',
    '0000312222130000',
    '0000312222130000',
    '0000312222130000',
    '0000031111300000',
    '0000031221300000',
    '0000003223000000',
    '0000003113000000',
    '0000000320000000',
    '0000000330000000',
    '0000000030000000',
  ],
  GIZMO: [
    '0000000330000000',
    '0000000320000000',
    '0000311111130000',
    '0000311111130000',
    '0000314114130000',
    '0000311111130000',
    '0000312222130000',
    '0000311111130000',
    '0000322222230000',
    '0003111111113000',
    '0003111111113000',
    '0031111111113000',
    '0003111111113000',
    '0003222222223000',
    '0000311111130000',
    '0000333333330000',
  ],
};

/* ══════════════════════════════════════════════════════════════
 * 3. 颜色工具
 * ══════════════════════════════════════════════════════════════ */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const DEFAULT_PRIMARY = '#8f6b3f';
export const DEFAULT_SECONDARY = '#d8c39a';
export const DEFAULT_OUTLINE = '#241a10';

/** 解析 `#RGB` / `#RRGGBB`;非法输入抛错(调用方须先 sani 化)。 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  if (typeof hex !== 'string') throw new Error(`颜色不是字符串: ${String(hex)}`);
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`非法颜色值: ${hex}`);
  return {
    r: Number.parseInt(s.slice(0, 2), 16),
    g: Number.parseInt(s.slice(2, 4), 16),
    b: Number.parseInt(s.slice(4, 6), 16),
  };
}

export function normalizeHexColor(hex: string, fallback: string): string {
  try {
    const c = parseHexColor(hex);
    const to2 = (n: number): string => n.toString(16).padStart(2, '0');
    return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
  } catch {
    return fallback;
  }
}

function lerpToWhite(n: number, t: number): number {
  return Math.round(n + (255 - n) * t);
}

export const HIGHLIGHT_WHITE_LERP = 0.35;

/** 由 visual_style 生成 5 个调色盘字符到 RGBA 的映射表。 */
export function paletteFrom(style: Pick<VisualStyle, 'primary_color_hex' | 'secondary_color_hex' | 'outline_color_hex'>): Map<string, Rgba> {
  const primary = parseHexColor(normalizeHexColor(style.primary_color_hex, DEFAULT_PRIMARY));
  const secondary = parseHexColor(normalizeHexColor(style.secondary_color_hex, DEFAULT_SECONDARY));
  const outline = parseHexColor(normalizeHexColor(style.outline_color_hex, DEFAULT_OUTLINE));
  const map = new Map<string, Rgba>();
  map.set('0', { r: primary.r, g: primary.g, b: primary.b, a: 0 });
  map.set('1', { r: primary.r, g: primary.g, b: primary.b, a: 255 });
  map.set('2', { r: secondary.r, g: secondary.g, b: secondary.b, a: 255 });
  map.set('3', { r: outline.r, g: outline.g, b: outline.b, a: 255 });
  map.set('4', {
    r: lerpToWhite(secondary.r, HIGHLIGHT_WHITE_LERP),
    g: lerpToWhite(secondary.g, HIGHLIGHT_WHITE_LERP),
    b: lerpToWhite(secondary.b, HIGHLIGHT_WHITE_LERP),
    a: 255,
  });
  return map;
}

/* ══════════════════════════════════════════════════════════════
 * 4. 校验
 * ══════════════════════════════════════════════════════════════ */

export interface PixelMatrixProblem {
  code:
    | 'NOT_ARRAY'
    | 'ROW_COUNT'
    | 'ROW_NOT_STRING'
    | 'ROW_WIDTH'
    | 'BAD_CHAR'
    | 'EMPTY_ART';
  detail: string;
}

export interface PixelMatrixCheck {
  ok: boolean;
  problems: PixelMatrixProblem[];
  /** 非透明像素个数,用于「立牌不能全空」判定 */
  inkPixels: number;
  /** 用到的调色盘字符集合 */
  usedChars: string[];
}

/** 至少要有这么多非透明像素,否则视为废图(全透明立牌在 UI 里等于隐形)。 */
export const MIN_INK_PIXELS = 12;

/**
 * 逐行逐列校验。返回全部问题而不是抛第一个,方便把错误回灌给 LLM 重试。
 */
export function validatePixelMatrix(matrix: unknown): PixelMatrixCheck {
  const problems: PixelMatrixProblem[] = [];
  if (!Array.isArray(matrix)) {
    return { ok: false, problems: [{ code: 'NOT_ARRAY', detail: `应为字符串数组,实际 ${typeof matrix}` }], inkPixels: 0, usedChars: [] };
  }
  if (matrix.length !== ICON_SIZE) {
    problems.push({ code: 'ROW_COUNT', detail: `行数应为 ${ICON_SIZE},实际 ${matrix.length}` });
  }
  const used = new Set<string>();
  let ink = 0;
  for (let y = 0; y < matrix.length; y += 1) {
    const row = matrix[y];
    if (typeof row !== 'string') {
      problems.push({ code: 'ROW_NOT_STRING', detail: `第 ${y} 行不是字符串(实际 ${typeof row})` });
      continue;
    }
    if (row.length !== ICON_SIZE) {
      problems.push({ code: 'ROW_WIDTH', detail: `第 ${y} 行长度应为 ${ICON_SIZE},实际 ${row.length}` });
    }
    const width = Math.min(row.length, ICON_SIZE);
    for (let x = 0; x < width; x += 1) {
      const ch = row[x];
      if (!PALETTE_KEYS.includes(ch)) {
        problems.push({ code: 'BAD_CHAR', detail: `第 ${y} 行第 ${x} 列字符 '${ch}' 不在调色盘 ${PALETTE_KEYS.join('')} 内` });
        continue;
      }
      used.add(ch);
      if (ch !== PALETTE_CHAR.TRANSPARENT) ink += 1;
    }
  }
  if (ink < MIN_INK_PIXELS && problems.length === 0) {
    problems.push({ code: 'EMPTY_ART', detail: `非透明像素仅 ${ink} 个,少于 ${MIN_INK_PIXELS},判定为废图` });
  }
  return { ok: problems.length === 0, problems, inkPixels: ink, usedChars: [...used].sort() };
}

/** 把问题列表压成一行中文错误串,用于回灌 LLM 的重试提示。 */
export function describePixelProblems(check: PixelMatrixCheck, limit = 4): string {
  return check.problems.slice(0, limit).map((p) => `[${p.code}] ${p.detail}`).join('; ');
}

/* ══════════════════════════════════════════════════════════════
 * 5. 光栅化
 * ══════════════════════════════════════════════════════════════ */

export interface RasterResult {
  /** 行主序 RGBA,长度 1024 */
  data: Uint8Array;
  /** 16×16×4 */
  bytes: number;
  inkPixels: number;
}

/**
 * 调色盘字符矩阵 → Uint8Array(1024)。
 * 越界与非法字符一律按「透明」处理(调用前应先 validate,这里只做兜底不抛错,
 * 保证即使 LLM 偶尔吐脏数据也不会让整条合成链崩掉)。
 */
export function rasterizePixelIcon(
  matrix: readonly string[],
  palette: Map<string, Rgba>,
): RasterResult {
  const data = new Uint8Array(ICON_BYTES);
  let ink = 0;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const row = typeof matrix[y] === 'string' ? matrix[y] : '';
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const ch = x < row.length ? row[x] : PALETTE_CHAR.TRANSPARENT;
      const rgba = palette.get(ch) ?? palette.get(PALETTE_CHAR.TRANSPARENT);
      if (!rgba) continue;
      const idx = (y * ICON_SIZE + x) * 4;
      data[idx] = rgba.r;
      data[idx + 1] = rgba.g;
      data[idx + 2] = rgba.b;
      data[idx + 3] = rgba.a;
      if (rgba.a !== 0) ink += 1;
    }
  }
  return { data, bytes: ICON_BYTES, inkPixels: ink };
}

export function pixelAt(data: Uint8Array, x: number, y: number): Rgba {
  const idx = (y * ICON_SIZE + x) * 4;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
}

/** RGBA → 调色盘字符矩阵(往返验证用)。 */
export function matrixFromRgba(data: Uint8Array, palette: Map<string, Rgba>): string[] {
  const reverse = new Map<string, string>();
  for (const [ch, c] of palette) reverse.set(`${c.r},${c.g},${c.b},${c.a}`, ch);
  const out: string[] = [];
  for (let y = 0; y < ICON_SIZE; y += 1) {
    let row = '';
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const c = pixelAt(data, x, y);
      row += reverse.get(`${c.r},${c.g},${c.b},${c.a}`) ?? '?';
    }
    out.push(row);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
 * 6. CanvasTexture 载荷
 * ══════════════════════════════════════════════════════════════ */

export interface CanvasTexturePayload {
  /** 客户端据此选择 THREE.DataTexture / CanvasTexture */
  kind: 'DataTexture';
  width: number;
  height: number;
  /** 行主序 RGBA8 */
  data: Uint8Array;
  format: 'RGBAFormat';
  type: 'UnsignedByteType';
  /** 像素画必须最近邻采样 */
  magFilter: 'NearestFilter';
  minFilter: 'NearestFilter';
  wrapS: 'ClampToEdgeWrapping';
  wrapT: 'ClampToEdgeWrapping';
  flipY: false;
  premultiplyAlpha: false;
  /** 客户端需执行 texture.needsUpdate = true */
  needsUpdate: true;
  /** 供 UI 做 3× / 5× 放大时的整数倍标志 */
  pixelRatioHint: number;
  /** 内容寻址指纹(同一立牌跨客户端共享纹理缓存) */
  textureKey: string;
  palette: { primary: string; secondary: string; outline: string };
}

export const TEXTURE_PIXEL_RATIO = 3;

/** 把 RGBA 字节流打包成客户端可直接消费的纹理载荷。 */
export function buildCanvasTexturePayload(
  raster: RasterResult,
  style: Pick<VisualStyle, 'primary_color_hex' | 'secondary_color_hex' | 'outline_color_hex'>,
  keySource = '',
): CanvasTexturePayload {
  const primary = normalizeHexColor(style.primary_color_hex, DEFAULT_PRIMARY);
  const secondary = normalizeHexColor(style.secondary_color_hex, DEFAULT_SECONDARY);
  const outline = normalizeHexColor(style.outline_color_hex, DEFAULT_OUTLINE);
  return {
    kind: 'DataTexture',
    width: ICON_SIZE,
    height: ICON_SIZE,
    data: raster.data,
    format: 'RGBAFormat',
    type: 'UnsignedByteType',
    magFilter: 'NearestFilter',
    minFilter: 'NearestFilter',
    wrapS: 'ClampToEdgeWrapping',
    wrapT: 'ClampToEdgeWrapping',
    flipY: false,
    premultiplyAlpha: false,
    needsUpdate: true,
    pixelRatioHint: TEXTURE_PIXEL_RATIO,
    textureKey: `px16:${keySource}:${primary}:${secondary}:${outline}:${raster.inkPixels}`,
    palette: { primary, secondary, outline },
  };
}

/* ══════════════════════════════════════════════════════════════
 * 7. 一步到位入口
 * ══════════════════════════════════════════════════════════════ */

export interface IconBuildResult {
  check: PixelMatrixCheck;
  raster: RasterResult;
  payload: CanvasTexturePayload;
  /** 立牌实际使用的剪影 */
  silhouette: BaseSilhouette;
}

/**
 * 校验 + 光栅化 + 打包。矩阵不合法时**自动回退到该剪影的规范美术**,
 * 并把问题保留在返回值里供上层记日志 —— 玩家永远看不到「空气立牌」。
 */
export function buildIcon(
  matrix: readonly string[] | undefined,
  silhouette: BaseSilhouette,
  style: VisualStyle | (Pick<VisualStyle, 'primary_color_hex' | 'secondary_color_hex' | 'outline_color_hex'> & { pixel_icon_16x16?: string[] }),
  keySource = '',
): IconBuildResult {
  const check = validatePixelMatrix(matrix);
  const art = check.ok && matrix ? matrix : SILHOUETTE_ART[silhouette];
  const palette = paletteFrom(style);
  const raster = rasterizePixelIcon(art, palette);
  const payload = buildCanvasTexturePayload(raster, style, keySource);
  return { check, raster, payload, silhouette };
}

/** 取剪影的规范美术(深拷贝,防外部改写常量)。 */
export function canonicalArt(silhouette: BaseSilhouette): string[] {
  return [...SILHOUETTE_ART[silhouette]];
}

/** 九个剪影的规范美术自检(导入期/测试期可跑)。 */
export function selfCheckArt(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const name of Object.values(BaseSilhouette)) {
    const art = SILHOUETTE_ART[name as BaseSilhouette];
    if (!art) {
      errors.push(`剪影 ${name} 缺美术`);
      continue;
    }
    const c = validatePixelMatrix(art);
    if (!c.ok) errors.push(`剪影 ${name}: ${describePixelProblems(c, 3)}`);
  }
  return { ok: errors.length === 0, errors };
}