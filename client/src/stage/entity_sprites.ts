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

/* ───────────────────── 实体立牌**计划**(第七轮审计 P1) ───────────────────── */

/**
 * ## 修的是什么
 * 修前屏幕上只有**两块**东西跟实体有关:本地玩家的 `player_marker` 与 4 个固定图集立牌。
 * `RoomState.wildlife` / `RoomState.players` 在 `client/src` 里**没有渲染出口** ⇒
 * ```
 * 服务端下发 3 只怪 + 1 个队友 ⇒ 屏幕上一个新东西都没有
 * ```
 * 而且这种缺陷在自检口径里也看不出来(`spriteCount` 只数那 4 个图集立牌)。
 *
 * ## 为什么"计划"是纯函数
 * `three/boot.ts` 顶层 `import three`、还碰 `document` ⇒ node 里加载不了。
 * 于是"哪些实体应该被画、画在哪、什么颜色"这一层判定放这里(node 可直接断言),
 * `boot.ts` 只剩"按计划建/改/删 `THREE.Sprite`"这一段胶水。
 *
 * ## 本地玩家为什么**不在**计划里
 * 它已经有 `player_marker`(带预测位置、屋顶淡出、相机跟随那一整条链)。
 * 在这里再列一遍会让同一局出现**两个自己**,而且两个会随预测/权威不同步抖动。
 */
export interface EntitySpriteSpec {
  /** 精灵在场景里的唯一名字(`mob:<id>` / `player:<id>`) */
  key: string;
  kind: 'player' | 'mob' | 'pet';
  /** 实体 id(线上 `PlayerState.id` / `WildlifeState.id`) */
  entityId: string;
  /** 显示名(玩家名 / mobId) */
  label: string;
  /** 格坐标(权威值,**不**做预测;预测只属于本地玩家) */
  cx: number;
  cy: number;
  z: number;
  /** 立牌高度(像素,来自 `spriteHeightPx`) */
  heightPx: number;
  /** 立牌色(占位色块;真图集映射是独立一件) */
  colorHex: string;
  hp: number;
  maxHp: number;
  /** 恒为 `false` —— 本地玩家不在这份计划里(见上) */
  isLocal: boolean;
}

/** 实体种类 → 占位色。 */
export const ENTITY_SPRITE_COLOR: Readonly<Record<string, string>> = {
  player: '#7fd1ff',
  mob: '#ff8a5c',
  pet: '#9ef07a',
};

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 由**权威快照**算出这一帧该画哪些实体立牌。
 *
 * 覆盖:`wildlife`(含已驯服的宠物)与**其他** `players`。
 * `bosses` 不在内:boss 的身位要等服务端投影出坐标(线上 `BossState` 只有预警圆心),
 * 现在画只能把 boss 钉在预警圈圆心 —— 那是一个看起来合法的错误位置。
 */
/** 立牌计划的**输入快照**形状(玩家/生物两个可选列表)。 */
export type EntitySpriteSource = {
  players?: readonly { id: string; name?: string; x: number; y: number; z?: number; hp?: number; maxHp?: number }[];
  wildlife?: readonly {
    id: string; mobId?: string; x: number; y: number; z?: number; hp?: number; maxHp?: number;
    tameOwnerId?: string;
  }[];
};

/**
 * ★ WS-FND-137 P2:计划里的元素对象**复用计数**(新建过多少个 spec)。
 *
 * 存在的理由:本函数跑在**每帧**(`boot.ts` 的 `reconcileEntitySprites`),
 * 修前每帧新建 N 个 spec 对象 + 一个数组 ⇒ 20Hz × 实体数的垃圾流。
 * 判据:同一份快照连调两次,`spritePlanSpecAllocs` **不再增长**(负对照:
 * 加一个实体,恰好 +1)。
 */
export let spritePlanSpecAllocs = 0;

/** 复位计数器(测试测量前调用)。 */
export function resetSpritePlanCounters(): void {
  spritePlanSpecAllocs = 0;
}

/** 空槽(字段随后逐个覆写,见 `planEntitySpritesInto`)。 */
function blankSpec(): EntitySpriteSpec {
  spritePlanSpecAllocs += 1;
  return {
    key: '', kind: 'player', entityId: '', label: '',
    cx: 0, cy: 0, z: 0, heightPx: 0, colorHex: '', hp: 0, maxHp: 0, isLocal: false,
  };
}

function specAt(out: EntitySpriteSpec[], i: number): EntitySpriteSpec {
  const s = out[i];
  return s ?? blankSpec();
}

/**
 * 由**权威快照**算出这一帧该画哪些实体立牌(每次返回**新数组**,语义与修前一致)。
 *
 * 覆盖:`wildlife`(含已驯服的宠物)与**其他** `players`。
 * `bosses` 不在内:boss 的身位要等服务端投影出坐标(线上 `BossState` 只有预警圆心),
 * 现在画只能把 boss 钉在预警圈圆心 —— 那是一个看起来合法的错误位置。
 */
export function planEntitySprites(state: EntitySpriteSource, localPlayerId: string): EntitySpriteSpec[] {
  return planEntitySpritesInto([], state, localPlayerId);
}

/**
 * `planEntitySprites` 的**复用槽**版本(WS-FND-137 P2,`boot.ts` 每帧用)。
 *
 * ## 修的是什么
 * 每帧都新建一个数组 + 每个实体一个 spec 对象,而这些对象**当帧就被读掉丢弃**。
 * ⇒ 现在写进调用方给的 `out`:数组复用(`out.length = n`)、元素对象按槽位复用,
 * 每个字段**逐个覆写**(所以复用槽不会串上一帧的值)。
 *
 * ## 为什么需要「按槽位复用」而不是「永远不新建」
 * 名册会变(玩家进出、生物生灭)⇒ 槽位不够时才 `blankSpec()` 新建,
 * 名册稳定的帧里分配数为 **0**。
 *
 * ## 为什么公开的 `planEntitySprites` 仍然返回新数组
 * 调用方可能持有返回的数组(测试会连调两次做比对);把复用缓冲直接返回出去
 * 会让「第二次调用」把「第一次的结果」改掉 —— 那是行为变更,不是优化。
 */
export function planEntitySpritesInto(
  out: EntitySpriteSpec[],
  state: EntitySpriteSource,
  localPlayerId: string,
): EntitySpriteSpec[] {
  let n = 0;
  for (const p of state.players ?? []) {
    if (p.id === localPlayerId) continue;         /* 本地玩家有 player_marker */
    if (!finite(p.x) || !finite(p.y)) continue;   /* 坐标坏了 ⇒ 不画(不是画到 0,0) */
    const s = specAt(out, n);
    n += 1;
    s.key = `player:${p.id}`;
    s.kind = 'player';
    s.entityId = p.id;
    s.label = typeof p.name === 'string' && p.name !== '' ? p.name : p.id;
    s.cx = p.x;
    s.cy = p.y;
    s.z = finite(p.z) ? p.z : 0;
    s.heightPx = spriteHeightPx('player');
    s.colorHex = ENTITY_SPRITE_COLOR.player;
    s.hp = finite(p.hp) ? p.hp : 0;
    s.maxHp = finite(p.maxHp) ? p.maxHp : 0;
    s.isLocal = false;
    out[n - 1] = s;
  }
  for (const w of state.wildlife ?? []) {
    if (!finite(w.x) || !finite(w.y)) continue;
    const tame = typeof w.tameOwnerId === 'string' && w.tameOwnerId !== '';
    const kind: 'mob' | 'pet' = tame ? 'pet' : 'mob';
    const s = specAt(out, n);
    n += 1;
    s.key = `${kind}:${w.id}`;
    s.kind = kind;
    s.entityId = w.id;
    s.label = typeof w.mobId === 'string' && w.mobId !== '' ? w.mobId : w.id;
    s.cx = w.x;
    s.cy = w.y;
    s.z = finite(w.z) ? w.z : 0;
    s.heightPx = spriteHeightPx(kind);
    s.colorHex = tame ? ENTITY_SPRITE_COLOR.pet : ENTITY_SPRITE_COLOR.mob;
    s.hp = finite(w.hp) ? w.hp : 0;
    s.maxHp = finite(w.maxHp) ? w.maxHp : 0;
    s.isLocal = false;
    out[n - 1] = s;
  }
  out.length = n;
  /* 稳定顺序:同一份快照两次调用逐字段相同(自检口径可比对) */
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** 计划里某类实体的条数(自检口径:wildlife 与远端玩家**分开**报)。 */
export function countByKind(specs: readonly EntitySpriteSpec[], kind: EntitySpriteSpec['kind']): number {
  let n = 0;
  for (const s of specs) if (s.kind === kind) n += 1;
  return n;
}

/**
 * 三类一次数完(WS-FND-137 P2:`boot.ts` 修前为同一批 specs 扫了 **3 遍**
 * —— `countByKind('mob') + countByKind('pet') + countByKind('player')`)。
 *
 * ⚠️ 与 `countByKind` 的关系:**口径必须一致**(同一条逐条比较的判据)。
 * 判据里直接拿两者逐类对比(WS-FND-137 的 FND137-9),避免「两份统计各自漂移」。
 */
export function countByKinds(specs: readonly EntitySpriteSpec[]): { player: number; mob: number; pet: number } {
  let player = 0;
  let mob = 0;
  let pet = 0;
  for (const s of specs) {
    if (s.kind === 'player') player += 1;
    else if (s.kind === 'mob') mob += 1;
    else pet += 1;
  }
  return { player, mob, pet };
}