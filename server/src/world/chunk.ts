/**
 * WS-01 · 地形位压缩引擎 —— 16×16 Chunk、五层垂直数据栈、脏格位图、1KB 序列化。
 *
 * 约束(见 shared/contracts/FREEZE.md):
 *  - 只使用 `node:*` 与冻结层的 `shared/types/tile.ts`;
 *  - 禁止 enum / 参数属性 / namespace;相对导入必须带 `.ts`;
 *  - 每格六字段来自 packTile(32-bit),不额外持有平行数组。
 *
 * 三个必须说清的设计取舍:
 *
 *  1. **FLOOR 层是「调色板槽位」而不是物品 ID。**
 *     FLOOR 字段只有 6 位(0..63),而地砖物品 ID 是 301~330。
 *     因此 32-bit 单元里存的是 0~63 的槽位号,语义映射由 `FLOOR_PALETTE`
 *     承担:0 = 无铺装,1~30 = 301~330,31~63 = UGC 像素地毯(314)变体。
 *     这是位宽推导出的硬结论——任何写 `floor === 315` 的判断都是错的,
 *     必须先经 `floorIdOfSlot()` 映射。
 *
 *  2. **屋顶不进 OBJ 层。** OBJ(12 位,0..4095)保留给主体方块/家具/机关
 *     (351~385 与 401~537 都在范围内)。但屋顶若与「屋里的壁炉」共用同一格,
 *     一格只能存一个 ID 就会冲突。所以屋顶走独立的 `roofs: Uint16Array` 旁路层,
 *     `roofAt()` 与 `objIdAt()` 各自独立。屋顶仍然属于 §3.6 建筑构件槽位,
 *     只是**存在别处**。
 *
 *  3. **地砖带来的物理属性只走派生缓存**:`muAt()` 直接读 Float64Array 快查表,
 *     不回写格位,保证 32-bit 单元格始终是唯一真相。
 */

import {
  CHUNK_SIZE,
  CHUNK_CELLS,
  CHUNK_BYTES,
  Elevation,
  BaseFluid,
  packTile,
  unpackTile,
  withField,
  metaState,
  faceDir,
  type TileFields,
} from '../../../shared/types/tile.ts';

/* ═══════════════════════ 1. 分片常量与索引工具 ═══════════════════════ */

export const CHUNK_W = CHUNK_SIZE;                 // 16
export const CHUNK_SHIFT = 4;                      // 16 = 1 << 4
export const CHUNK_MASK = CHUNK_SIZE - 1;          // 0x0f
export const DIRTY_WORDS = 8;                      // 256 bit / 32 bit
export const DIRTY_BYTES = CHUNK_CELLS >> 3;       // 32 字节 = 256 位

/** 局部坐标 → 单元索引(x 沿东,y 沿南)。 */
export function idx(x: number, y: number): number {
  return (y << CHUNK_SHIFT) | x;
}

export function inChunkBounds(x: number, y: number): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE
  );
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

export interface WorldToChunk {
  cx: number;
  cy: number;
  lx: number;
  ly: number;
}

export function worldToChunk(wx: number, wy: number): WorldToChunk {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cy = Math.floor(wy / CHUNK_SIZE);
  return { cx, cy, lx: wx - cx * CHUNK_SIZE, ly: wy - cy * CHUNK_SIZE };
}

export function popcount32(v: number): number {
  let x = v >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * 把 `Uint8Array | ArrayBuffer` 归一化成「有独立 buffer、byteOffset=0」的字节视图。
 * 存在的意义:`new DataView(x)` 只接受真正的 `ArrayBuffer`,而这个函数
 * 让上层不必关心调用方递进来的是视图还是裸缓冲。
 */
export function toBytes(buf: ArrayBuffer | Uint8Array): Uint8Array {
  if (buf instanceof Uint8Array) {
    if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) return buf;
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return new Uint8Array(buf);
}

/* ═══════════════════════ 2. FLOOR 层调色板 ═══════════════════════ */

/** 地砖物品 ID 区间:301~330 共 30 种。 */
export const FLOOR_ID_MIN = 301;
export const FLOOR_ID_MAX = 330;
export const FLOOR_BASE_COUNT = 30;

/** FLOOR 层槽位自身的 6 位掩码。 */
export const FLOOR_SLOT_MASK = 0x3f;

/** UGC 像素地毯(314)占用的槽位区间:31~63 共 33 个变体。 */
export const FLOOR_UGC_FIRST = 31;
export const FLOOR_UGC_LAST = 63;
export const FLOOR_UGC_ID = 314;

/**
 * 槽位 → 物品 ID。索引即写进 FLOOR 层的 6 位值。
 *   0      : 无铺装(裸地)
 *   1..30  : 301..330
 *   31..63 : 314 的 UGC 变体槽
 */
export const FLOOR_PALETTE: readonly number[] = (() => {
  const arr = new Array<number>(64).fill(0);
  for (let i = 0; i < FLOOR_BASE_COUNT; i += 1) arr[1 + i] = FLOOR_ID_MIN + i;
  for (let i = FLOOR_UGC_FIRST; i <= FLOOR_UGC_LAST; i += 1) arr[i] = FLOOR_UGC_ID;
  return arr;
})();

/** 槽位 → 物品 ID。越界与 0 都回落为 0(无铺装)。 */
export function floorIdOfSlot(slot: number): number {
  const s = slot & FLOOR_SLOT_MASK;
  return FLOOR_PALETTE[s] ?? 0;
}

/** 物品 ID → 槽位。未知 ID 与 0 都回落为 0。 */
export function floorSlotOfId(id: number): number {
  if (!Number.isFinite(id) || id <= 0) return 0;
  const i = Math.floor(id);
  if (i >= FLOOR_ID_MIN && i <= FLOOR_ID_MAX) return i - FLOOR_ID_MIN + 1;
  if (i === FLOOR_UGC_ID) return FLOOR_UGC_FIRST;
  return 0;
}

/* ═══════════════════════ 3. 地砖物理属性配表 ═══════════════════════ */

export const SurfaceKind = {
  INTERIOR: 'INTERIOR',
  EXTERIOR: 'EXTERIOR',
  WET: 'WET',
  ICE: 'ICE',
  CONVEYOR: 'CONVEYOR',
} as const;
export type SurfaceKind = (typeof SurfaceKind)[keyof typeof SurfaceKind];

export interface FloorMeta {
  /** 摩擦系数 μ,integrateHorizontal 直接使用 */
  mu: number;
  /**
   * 手册 §3.5「移速修正」列(1.0 = 100%)。
   *
   * ⚠️ **当前只有数据,没有消费点** —— 尚未接进物理积分。
   * 出处:手册 L202~L231 该列 30 行全部给出。
   *
   * 不要把它与 `physics/world.ts` 的 `BELT_FORCE` 混为一谈:
   * 那是「格/秒推力」(317=10.0),这是「速度乘数」(317=2.0),
   * 两者是**不同的建模**,数值不可互相搬运。
   */
  speedMul: number;
  surface: SurfaceKind;
  /** 接触时每秒灼烧伤害(0 = 不烧) */
  burnPerSec: number;
  /** 是否能踩(落穴等对应 false) */
  walkable: boolean;
  /** 引水渠判定:该地砖旁边挖低是否形成汇水口 */
  canal: boolean;
  /** 是否属于伤害性地砖 */
  hazard: boolean;
}

/**
 * 没有配表记录的地砖统一使用的摩擦系数(缺省值)。
 * 等于 `DEFAULT_MU`,两个名字指同一件事,`DEFAULT_MU` 供外部按语义调用。
 */
export const FLOOR_DEFAULT_MU = 0.75;
/** `FLOOR_DEFAULT_MU` 的语义别名:任何「查不到 μ 的地砖」都用它。 */
export const DEFAULT_MU = FLOOR_DEFAULT_MU;
/**
 * 裸地(未铺装,槽位 0)的摩擦系数。
 * 注意与 `DEFAULT_MU` 的区别:槽位 0 是**明确知道**没铺装,走 0.72;
 * 而「传进来一个 999 这种不存在的物品 ID」走 `DEFAULT_MU` = 0.75。
 */
export const BARE_GROUND_MU = 0.72;

/** 手册 §3.5「移速修正」的缺省值 = 100%(不修正)。 */
export const SPEED_MUL_DEFAULT = 1.0;

function fmeta(patch: Partial<FloorMeta>): FloorMeta {
  return {
    mu: FLOOR_DEFAULT_MU,
    speedMul: SPEED_MUL_DEFAULT,
    surface: 'EXTERIOR',
    burnPerSec: 0,
    walkable: true,
    canal: false,
    hazard: false,
    ...patch,
  };
}

/**
 * 地砖配表,键为**物品 ID**。
 *
 * **μ 与移速修正逐条取自手册 §3.5 表**(`2_5d_cartoon_sandbox_plan.md`
 * L202~L231,表头 L200),不是本模块自行设定 —— 见 L202~L231 的
 * 「摩擦系数 μ」与「移速修正」两列。
 *
 * 历史:此前本表的 μ 只有 315/316/322/328 四个来自手册正文摘句,
 * 其余 26 个是按 note 功能倾向自定的近似值(0.62~0.90),
 * 与手册 §3.5 的完整 μ 列有 24 处不符。2026-11 对照审计发现后按手册改正。
 *
 * 特殊机制(surface / burnPerSec / canal / hazard)仍取自 items.ts 的 note 原文,
 * 手册 §3.5 表末列与之对应。
 */
export const FLOOR_META: ReadonlyMap<number, FloorMeta> = new Map<number, FloorMeta>([
  // 301 肥沃农田耕地 —— 靠近水源 3 格内自动湿润(L202)
  [301, fmeta({ mu: 0.75, speedMul: 1.00 })],
  // 302 青苔鹅卵石径 —— 基础园林小路(L203)
  [302, fmeta({ mu: 0.75, speedMul: 1.15 })],
  // 303 暖松人字木地板 —— 室内木地板(L204)
  [303, fmeta({ mu: 0.75, speedMul: 1.10, surface: 'INTERIOR' })],
  // 304 绯樱榻榻米席 —— 和风室内,打盹回血与攒露水 +20%(L205)
  [304, fmeta({ mu: 0.75, speedMul: 1.10, surface: 'INTERIOR' })],
  // 305 复古红砖广场砖 —— 城镇广场(L206)
  [305, fmeta({ mu: 0.75, speedMul: 1.15 })],
  // 306 纯白大理石砖 —— 反光柔和(L207)
  [306, fmeta({ mu: 0.78, speedMul: 1.15, surface: 'INTERIOR' })],
  // 307 黑白国际象棋砖 —— 棋类铺装(L208)
  [307, fmeta({ mu: 0.75, speedMul: 1.10, surface: 'INTERIOR' })],
  // 308 樱花花瓣地毯 —— 踩过惊起花瓣粒子(L209)
  [308, fmeta({ mu: 0.75, speedMul: 1.10 })],
  // 309 萤光星光夜路砖 —— 夜间发光并阻止野怪刷新(L210)
  [309, fmeta({ mu: 0.75, speedMul: 1.15 })],
  // 310 水上浮木栈桥 —— 铺设在 Z=-1 水面上(L211)
  [310, fmeta({ mu: 0.75, speedMul: 1.10, surface: 'WET', canal: true })],
  // 311 华夫威化饼干砖 —— 甜点风格(L212)
  [311, fmeta({ mu: 0.75, speedMul: 1.10, surface: 'INTERIOR' })],
  // 312 绿茵足球场草皮 —— 4v4 球场(L213)
  [312, fmeta({ mu: 0.76, speedMul: 1.15 })],
  // 313 塑胶跑道计速砖 —— 白色跑道线(L214)
  [313, fmeta({ mu: 0.72, speedMul: 1.25, surface: 'CONVEYOR' })],
  // 314 自定义像素地毯 —— 玩家手绘 16×16 图案(L215)
  [314, fmeta({ mu: 0.75, speedMul: 1.10, surface: 'INTERIOR' })],
  // 315 镜面极滑冰砖 —— 极度打滑(L216)
  [315, fmeta({ mu: 0.98, speedMul: 1.30, surface: 'ICE' })],
  // 316 紫泥减速沼泽砖 —— 深陷泥潭寸步难行(L217)
  [316, fmeta({ mu: 0.40, speedMul: 0.45, surface: 'WET' })],
  // 317 单向狂飙加速带 —— 另有 10 格/秒推力(见 BELT_FORCE)(L218)
  [317, fmeta({ mu: 0.85, speedMul: 2.00, surface: 'CONVEYOR' })],
  // 318 高弹果冻蹦床砖 —— 弹跳直达 Z=2(弹性见 BOUNCE_TABLE)(L219)
  [318, fmeta({ mu: 0.80, speedMul: 1.00 })],
  // 319 伪装落穴草席 —— 0.4 秒后碎裂(L220)
  [319, fmeta({ mu: 0.75, speedMul: 1.00, hazard: true })],
  // 320 炙热烫脚火炭砖 —— 野生怪物每秒 15 点灼烧(L221)
  [320, fmeta({ mu: 0.75, speedMul: 1.35, burnPerSec: 15, hazard: true })],
  // 321 眩晕旋转圆盘砖 —— 每秒旋转朝向 180°(L222)
  [321, fmeta({ mu: 0.80, speedMul: 1.00 })],
  // 322 强粘蜂蜜减速毯 —— 粘住脚底,2 秒内无法跳跃或冲锋(L223)
  [322, fmeta({ mu: 0.35, speedMul: 0.40, surface: 'WET' })],
  // 323 流沙向心漩涡砖 —— 2 格吸力(L224)
  [323, fmeta({ mu: 0.65, speedMul: 0.80, surface: 'WET' })],
  // 324 倒刺荆棘地垫 —— 每秒 20 点流血(L225)
  [324, fmeta({ mu: 0.60, speedMul: 0.70, hazard: true })],
  // 325 迪斯科变色灯砖 —— 8 色霓虹(L226)
  [325, fmeta({ mu: 0.75, speedMul: 1.15, surface: 'INTERIOR' })],
  // 326 双子星传送地砖 A —— 站 1 秒后传送(L227)
  [326, fmeta({ mu: 0.75, speedMul: 1.00 })],
  // 327 双子星传送地砖 B —— 双向互通(L228)
  [327, fmeta({ mu: 0.75, speedMul: 1.00 })],
  // 328 矿车笔直铁轨 —— 低滚阻高速滑行(L229)
  [328, fmeta({ mu: 0.90, speedMul: 1.00, surface: 'CONVEYOR' })],
  // 329 矿车转弯与爬坡轨 —— 连接高低差(L230)
  [329, fmeta({ mu: 0.90, speedMul: 1.00, surface: 'CONVEYOR' })],
  // 330 矿车制动加速轨 —— 通电推力 / 断电刹车(L231)
  [330, fmeta({ mu: 0.95, speedMul: 1.80, surface: 'CONVEYOR' })],
]);

/**
 * 按槽位预计算的「移速修正」快查表(1.0 = 100%)。
 *
 * ⚠️ 与 `FLOOR_MU_BY_SLOT` 一样是**预计算数据表,目前无消费点**。
 * 手册 §3.5 给了这一列,但把它接进物理积分会显著改变手感
 * (317 是 ×2.0、316 是 ×0.45),属于平衡性变更,需单独裁决后接入。
 * 现在先让数据可查、有出处、有门禁。
 */
export const FLOOR_SPEED_MUL_BY_SLOT: Float64Array = (() => {
  const t = new Float64Array(64);
  for (let s = 0; s < 64; s += 1) {
    t[s] = s === 0
      ? SPEED_MUL_DEFAULT
      : (FLOOR_META.get(FLOOR_PALETTE[s])?.speedMul ?? SPEED_MUL_DEFAULT);
  }
  return t;
})();

/** 槽位 → 移速修正。传入的就是 FLOOR 层的原始 6 位值。 */
export function speedMulOfSlot(slot: number): number {
  return FLOOR_SPEED_MUL_BY_SLOT[slot & FLOOR_SLOT_MASK];
}

/** 按槽位预计算的 μ 快查表(Float64Array,物理热路径零哈希开销)。 */
export const FLOOR_MU_BY_SLOT: Float64Array = (() => {
  const t = new Float64Array(64);
  for (let s = 0; s < 64; s += 1) {
    mufill(t, s);
  }
  return t;
})();

function mufill(t: Float64Array, s: number): void {
  if (s === 0) {
    t[s] = BARE_GROUND_MU;
    return;
  }
  t[s] = FLOOR_META.get(FLOOR_PALETTE[s])?.mu ?? FLOOR_DEFAULT_MU;
}

/** 按槽位预计算的火炭灼烧值。 */
export const FLOOR_BURN_BY_SLOT: Float64Array = (() => {
  const t = new Float64Array(64);
  for (let s = 0; s < 64; s += 1) t[s] = FLOOR_META.get(FLOOR_PALETTE[s])?.burnPerSec ?? 0;
  return t;
})();

/** 槽位 → μ。传入的就是 FLOOR 层的原始 6 位值。 */
export function muOfSlot(slot: number): number {
  return FLOOR_MU_BY_SLOT[slot & FLOOR_SLOT_MASK];
}

/**
 * 物品 ID → μ。三条分支必须分清:
 *   - `itemId <= 0`       → 明确没铺装,用 `BARE_GROUND_MU`(0.72)
 *   - 已登记地砖(301~330)→ 配表值
 *   - 未登记物品 ID       → `DEFAULT_MU`(0.75,手册要求的缺省值)
 */
export function floorMu(itemId: number): number {
  if (!Number.isFinite(itemId) || itemId <= 0) return BARE_GROUND_MU;
  const m = FLOOR_META.get(Math.floor(itemId));
  return m === undefined ? DEFAULT_MU : m.mu;
}

export function floorMeta(itemId: number): FloorMeta {
  if (!Number.isFinite(itemId) || itemId <= 0) return fmeta({ mu: BARE_GROUND_MU });
  return FLOOR_META.get(Math.floor(itemId)) ?? fmeta({ mu: DEFAULT_MU });
}

export function floorBurn(itemId: number): number {
  return FLOOR_META.get(itemId)?.burnPerSec ?? 0;
}

/* ═══════════════════════ 4. 屋顶层 ═══════════════════════ */

/** 建筑构件槽位范围。 */
export const BUILDING_MIN = 351;
export const BUILDING_MAX = 385;

/** 允许充当屋顶的构件 ID:372~376 与 384。 */
export const ROOF_CAPABLE: ReadonlySet<number> = new Set<number>([372, 373, 374, 375, 376, 384]);

export interface RoofMeta {
  /** 玩家进入其投影时屋顶的目标不透明度,1 = 永不透明 */
  alpha: number;
  /** 是否参与「自动变透明」 */
  autoFade: boolean;
  /** 水平投影覆盖的横向格数 */
  span: number;
}

export const ROOF_META: ReadonlyMap<number, RoofMeta> = new Map<number, RoofMeta>([
  // 372 暖红陶瓦斜屋顶 —— 原文「角色走入室内时整片连通屋顶自动变透明」
  [372, { alpha: 0.25, autoFade: true, span: 3 }],
  // 373 森林茅草厚屋顶 —— 原文「半透明」
  [373, { alpha: 0.30, autoFade: true, span: 3 }],
  // 374 蔚蓝童话尖塔顶 —— 装饰尖顶,不自动透明
  [374, { alpha: 1.0, autoFade: false, span: 1 }],
  // 375 阳光温室玻璃顶 —— 原文「全天候透光」
  [375, { alpha: 0.15, autoFade: true, span: 3 }],
  // 376 紫藤花架凉亭顶 —— 原文「半透光花藤顶」
  [376, { alpha: 0.45, autoFade: true, span: 3 }],
  // 384 屋顶炊烟小烟囱 —— 装饰件,不遮挡
  [384, { alpha: 0.0, autoFade: true, span: 1 }],
]);

export function isRoofId(id: number): boolean {
  return ROOF_CAPABLE.has(id);
}

export function roofAlphaOf(id: number): number {
  return ROOF_META.get(id)?.alpha ?? 1;
}

export function roofSpanOf(id: number): number {
  return ROOF_META.get(id)?.span ?? 1;
}

/* ═══════════════════════ 5. 五层垂直数据栈 ═══════════════════════ */

export const VerticalLayer = {
  ELEV: 'ELEV',
  BASE: 'BASE',
  FLOOR: 'FLOOR',
  WIRE: 'WIRE',
  OBJ: 'OBJ',
  META: 'META',
  ROOF: 'ROOF',
} as const;
export type VerticalLayer = (typeof VerticalLayer)[keyof typeof VerticalLayer];

export interface LayerSpec {
  layer: VerticalLayer;
  bits: number;
  max: number;
  meaning: string;
}

/**
 * 垂直数据栈。前 6 层共 32 位,由冻结层 packTile 承担;
 * ROOF 是旁路层(不入 32 位),用 Uint16Array 平行存储。
 */
export const VERTICAL_STACK: readonly LayerSpec[] = [
  { layer: 'ELEV', bits: 2, max: 3, meaning: '海拔:0=Z-1 深沟,1=Z0 平原,2=Z1,3=Z2' },
  { layer: 'BASE', bits: 4, max: 15, meaning: '基底/流体:草地、泥土、金砂、岩石、浅水、温泉、粘液、熔岩、巧克力' },
  { layer: 'FLOOR', bits: 6, max: 63, meaning: '地表铺装槽位(经 FLOOR_PALETTE 映射到地砖物品 ID)' },
  { layer: 'WIRE', bits: 4, max: 15, meaning: '四色暗线 R/B/Y/G(WS-06 电路读取)' },
  { layer: 'OBJ', bits: 12, max: 4095, meaning: '主体方块/家具/机关 ID,0 为空' },
  { layer: 'META', bits: 4, max: 15, meaning: '低 2 位运行态,高 2 位朝向(0=北 1=东 2=南 3=西)' },
  { layer: 'ROOF', bits: 12, max: 4095, meaning: '屋顶构件 ID 旁路层(372~376 / 384)' },
];

/**
 * 层名 → `TileFields` 字段名。
 * `TileFields` 的键是**小写**(elev/base/floor/wire/obj/meta),而层名是大写,
 * 因此 `layer()` 必须显式查这张表,不能直接把大写的层名当键去索引。
 */
export const LAYER_FIELD: Readonly<Record<string, keyof TileFields>> = {
  ELEV: 'elev',
  BASE: 'base',
  FLOOR: 'floor',
  WIRE: 'wire',
  OBJ: 'obj',
  META: 'meta',
};

/** 进 32 位的六个层名(顺序与 packTile 的字段顺序一致)。 */
export const PACKED_LAYERS: readonly VerticalLayer[] = ['ELEV', 'BASE', 'FLOOR', 'WIRE', 'OBJ', 'META'];

/* ═══════════════════════ 6. 结构化 TileView ═══════════════════════ */

export interface TileView {
  gx: number;
  gy: number;
  lx: number;
  ly: number;
  packed: number;
  elev: number;
  base: number;
  /** 6 位槽位 */
  floorSlot: number;
  /** 槽位映射出的地砖物品 ID,0 = 无铺装 */
  floorId: number;
  wire: number;
  obj: number;
  meta: number;
  metaState: number;
  faceDir: number;
  roof: number;
  roofAlpha: number;
  roofCovers: boolean;
  mu: number;
  burnPerSec: number;
}

/* ═══════════════════════ 7. 空格默认值 ═══════════════════════ */

export const EMPTY_TILE = packTile({
  elev: Elevation.GROUND,
  base: BaseFluid.VOID,
  floor: 0,
  wire: 0,
  obj: 0,
  meta: 0,
});

/* ═══════════════════════ 8. Chunk ═══════════════════════ */

export class Chunk {
  readonly cx: number;
  readonly cy: number;
  /** 六层打包后的 256 格,1 格 4 字节 = 1024 字节 */
  readonly cells: Uint32Array;
  /** 屋顶旁路层,1 格 2 字节 */
  readonly roofs: Uint16Array;
  /** 256 位脏格位图:8 个 32 位字 */
  readonly dirty: Uint32Array;
  /** 进水台账位图(相变与引水渠调试用) */
  readonly wet: Uint32Array;
  /** 进熔岩台账位图 */
  readonly lava: Uint32Array;
  /** 脏格总数,避免每次遍历 8 个字 */
  dirtyCount: number;
  /** 单调递增版本号,任何实际写入 +1 */
  version: number;

  /** 本分片常驻字节:打包 1KB + 屋顶 512B + 3 张 32B 位图 = 1632 */
  static readonly RESIDENT_BYTES = CHUNK_BYTES + CHUNK_CELLS * 2 + DIRTY_BYTES * 3;
  /** 传输格式:恰好 1024 字节 = 256 × uint32 LE */
  static readonly SERIALIZE_BYTES = CHUNK_BYTES;

  constructor(cx: number, cy: number, fill: number = EMPTY_TILE) {
    this.cx = cx | 0;
    this.cy = cy | 0;
    this.cells = new Uint32Array(CHUNK_CELLS);
    this.roofs = new Uint16Array(CHUNK_CELLS);
    this.dirty = new Uint32Array(DIRTY_WORDS);
    this.wet = new Uint32Array(DIRTY_WORDS);
    this.lava = new Uint32Array(DIRTY_WORDS);
    this.dirtyCount = 0;
    this.version = 0;
    this.cells.fill(fill >>> 0);
  }

  /* ── 读 ── */

  get(x: number, y: number): number {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.get 越界:(${x}, ${y})`);
    return this.cells[idx(x, y)];
  }

  getFields(x: number, y: number): TileFields {
    return unpackTile(this.get(x, y));
  }

  /** 五层垂直数据栈统一读口。层名大写,内部经 LAYER_FIELD 映射到小写字段。 */
  layer(x: number, y: number, layer: VerticalLayer): number {
    if (layer === 'ROOF') return this.getRoof(x, y);
    const field = LAYER_FIELD[layer];
    if (field === undefined) throw new RangeError(`Chunk.layer 未知层名:${String(layer)}`);
    return unpackTile(this.cells[idx(x, y)])[field];
  }

  getRoof(x: number, y: number): number {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.getRoof 越界:(${x}, ${y})`);
    return this.roofs[idx(x, y)];
  }

  /** 该格 FLOOR 层原始 6 位槽位。 */
  floorSlotAt(x: number, y: number): number {
    return (this.cells[idx(x, y)] >>> 6) & FLOOR_SLOT_MASK;
  }

  /** 该格地砖的物品 ID(经调色板映射)。 */
  floorIdAt(x: number, y: number): number {
    return floorIdOfSlot((this.cells[idx(x, y)] >>> 6) & FLOOR_SLOT_MASK);
  }

  /** 该格摩擦系数。热路径,直接读预计算表。 */
  muAt(x: number, y: number): number {
    return FLOOR_MU_BY_SLOT[(this.cells[idx(x, y)] >>> 6) & FLOOR_SLOT_MASK];
  }

  /** 该格每秒灼烧伤害。 */
  burnAt(x: number, y: number): number {
    return FLOOR_BURN_BY_SLOT[(this.cells[idx(x, y)] >>> 6) & FLOOR_SLOT_MASK];
  }

  /* ── 写 ── */

  set(x: number, y: number, fields: Partial<TileFields>): number {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.set 越界:(${x}, ${y})`);
    const i = idx(x, y);
    return this.writeCell(i, packTile({ ...unpackTile(this.cells[i]), ...fields }));
  }

  /** 单字段改写(与冻结层 withField 同语义,但落盘 + 置脏)。 */
  withCell(x: number, y: number, field: keyof TileFields, value: number): number {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.withCell 越界:(${x}, ${y})`);
    const i = idx(x, y);
    return this.writeCell(i, withField(this.cells[i], field, value));
  }

  /**
   * 直接写入一个**已打包**的 32-bit 单元。
   *
   * 与 `withCell` 的分工(务必分清,写错会把高位混进低字段):
   *   - `withCell(x, y, field, value)`  —— value 是**该字段的原值**
   *     (wire 传 0..15,floor 传槽位 0..63)。要写四色线请自己先算好
   *     `wire = RED_BIT | GREEN_BIT` 再传进来。
   *   - `setPacked(x, y, packed)`      —— packed 是**整片 32-bit 值**,
   *     用于把冻结层 `setWire` / `packTile` 等纯函数的返回值原样落盘。
   *
   * 典型正确用法:`c.setPacked(x, y, setWire(setWire(v, RED, true), GREEN, true))`
   * 典型错误用法:`c.withCell(x, y, 'wire', setWire(...))` —— 传进去的是整片,
   * `packTile` 会取它的低 4 位,结果把 elev/base 的位当成线色。
   */
  setPacked(x: number, y: number, packed: number): number {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.setPacked 越界:(${x}, ${y})`);
    return this.writeCell(idx(x, y), packed >>> 0);
  }

  /** 按**物品 ID** 铺地砖,自动查调色板槽位。 */
  setFloor(x: number, y: number, itemId: number): number {
    return this.withCell(x, y, 'floor', floorSlotOfId(itemId));
  }

  setRoof(x: number, y: number, roofId: number): void {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.setRoof 越界:(${x}, ${y})`);
    const i = idx(x, y);
    const v = roofId >>> 0;
    if (this.roofs[i] === v) return;
    this.roofs[i] = v;
    this.markDirtyIndex(i);
  }

  private writeCell(i: number, next: number): number {
    const prev = this.cells[i];
    if (prev === next) return prev;
    this.cells[i] = next;
    this.markDirtyIndex(i);
    return next;
  }

  /* ── 脏格位图 ── */

  markDirty(x: number, y: number): void {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.markDirty 越界:(${x}, ${y})`);
    this.markDirtyIndex(idx(x, y));
  }

  private markDirtyIndex(i: number): void {
    const w = i >>> 5;
    const b = 1 << (i & 31);
    if ((this.dirty[w] & b) === 0) {
      this.dirty[w] |= b;
      this.dirtyCount += 1;
    }
    this.version = (this.version + 1) >>> 0;
  }

  isDirty(x: number, y: number): boolean {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.isDirty 越界:(${x}, ${y})`);
    const i = idx(x, y);
    return (this.dirty[i >>> 5] & (1 << (i & 31))) !== 0;
  }

  clearDirty(): void {
    this.dirty.fill(0);
    this.dirtyCount = 0;
  }

  clearDirtyAt(x: number, y: number): void {
    if (!inChunkBounds(x, y)) throw new RangeError(`Chunk.clearDirtyAt 越界:(${x}, ${y})`);
    const i = idx(x, y);
    const w = i >>> 5;
    const b = 1 << (i & 31);
    if ((this.dirty[w] & b) !== 0) {
      this.dirty[w] &= ~b;
      this.dirtyCount -= 1;
    }
  }

  /** 位扫描遍历脏格,不扫 256 次。 */
  *dirtyCells(): Generator<{ x: number; y: number; packed: number }> {
    for (let w = 0; w < DIRTY_WORDS; w += 1) {
      let bits = this.dirty[w] >>> 0;
      while (bits !== 0) {
        const lsb = (bits & -bits) >>> 0;
        const i = (w << 5) | (31 - Math.clz32(lsb));
        yield { x: i & CHUNK_MASK, y: i >>> CHUNK_SHIFT, packed: this.cells[i] };
        bits = (bits ^ lsb) >>> 0;
      }
    }
  }

  /** 脏位图展开成 32 字节小端位图,便于网络层直接发。 */
  dirtyBits(): Uint8Array {
    const out = new Uint8Array(DIRTY_BYTES);
    for (let i = 0; i < CHUNK_CELLS; i += 1) {
      if ((this.dirty[i >>> 5] & (1 << (i & 31))) !== 0) out[i >>> 3] |= 1 << (i & 7);
    }
    return out;
  }

  /* ── 台账 ── */

  markWet(x: number, y: number): void {
    const i = idx(x, y);
    this.wet[i >>> 5] |= 1 << (i & 31);
  }

  markLava(x: number, y: number): void {
    const i = idx(x, y);
    this.lava[i >>> 5] |= 1 << (i & 31);
  }

  /* ── 屋顶进入判定 ── */

  /**
   * 玩家站在本格时生效的屋顶不透明度:
   * 自身格有屋顶 → 用它;否则左右各 1 格内的屋顶若跨度够宽,水平投影覆盖本格。
   * 返回 1 表示无遮挡,数值越小越透明。
   */
  roofAlphaUnder(gx: number, gy: number): number {
    if (!inChunkBounds(gx, gy)) return 1;
    const self = this.roofs[idx(gx, gy)];
    if (self !== 0) return roofAlphaOf(self);
    let best = 1;
    for (let d = 1; d <= 2; d += 1) {
      for (let s = -1; s <= 1; s += 2) {
        const nx = gx + s * d;
        if (nx < 0 || nx >= CHUNK_SIZE) continue;
        const id = this.roofs[idx(nx, gy)];
        if (id === 0) continue;
        if (roofSpanOf(id) < d * 2 + 1) continue;
        const a = roofAlphaOf(id);
        if (a < best) best = a;
      }
    }
    return best;
  }

  roofCovers(gx: number, gy: number): boolean {
    if (!inChunkBounds(gx, gy)) return false;
    return this.roofs[idx(gx, gy)] !== 0 || this.roofAlphaUnder(gx, gy) < 1;
  }

  /* ── 哈希 ── */

  /** 结构哈希:只依赖 elev/base/floor/obj/朝向,不含运行态(WS-03 房间识别用)。 */
  hashCell(x: number, y: number): number {
    const v = this.cells[idx(x, y)];
    const f = unpackTile(v);
    let h = 0x811c9dc5;
    h = Math.imul(h ^ (f.elev & 0x3), 0x01000193) >>> 0;
    h = Math.imul(h ^ (f.base & 0xf), 0x01000193) >>> 0;
    h = Math.imul(h ^ (f.floor & FLOOR_SLOT_MASK), 0x01000193) >>> 0;
    h = Math.imul(h ^ (f.obj & 0xfff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (faceDir(v) & 0x3), 0x01000193) >>> 0;
    return h >>> 0;
  }

  /* ── 序列化 ── */

  serialize(): Uint8Array {
    /* 必须是独立、byteOffset=0、byteLength 恰好 1024 的新 buffer,
       调用方可以直接 `new DataView(c.serialize().buffer)` 或原样发网络。 */
    const out = new Uint8Array(CHUNK_BYTES);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < CHUNK_CELLS; i += 1) dv.setUint32(i * 4, this.cells[i], true);
    return out;
  }

  /**
   * 反序列化:接受 `Uint8Array` 或裸 `ArrayBuffer`(两者都常见,调用方不该被这种
   * 细节绊住)。只读前 1024 字节,因此后续追加的扩展字段完全向后兼容。
   * cx/cy 可由参数覆盖(服务端按分片键重建时使用)。
   */
  static deserialize(buf: Uint8Array | ArrayBuffer, cx = 0, cy = 0): Chunk {
    const bytes = toBytes(buf);
    if (bytes.byteLength < CHUNK_BYTES) {
      throw new RangeError(`Chunk.deserialize 缓冲不足:${bytes.byteLength} < ${CHUNK_BYTES}`);
    }
    const c = new Chunk(cx, cy);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, CHUNK_BYTES);
    for (let i = 0; i < CHUNK_CELLS; i += 1) c.cells[i] = dv.getUint32(i * 4, true);
    return c;
  }

  /**
   * 扩展快照(本地存档 / 回滚用,不上线):
   *   [0,1024)    256 × uint32 打包单元
   *   [1024,1056) 256 bit 脏位图
   *   [1056,1088) 256 bit 进水台账
   *   [1088,1120) 256 bit 进熔岩台账
   *   [1120,1144) version / dirtyCount / cx / cy / roofRleLen / flags
   *   [1144,…)    屋顶层 RLE
   */
  serializeSnapshot(): Uint8Array {
    const rle = encodeRoofRle(this.roofs);
    const out = new Uint8Array(CHUNK_BYTES + DIRTY_BYTES * 3 + 24 + rle.length);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < CHUNK_CELLS; i += 1) dv.setUint32(i * 4, this.cells[i], true);
    out.set(new Uint8Array(this.dirty.buffer, this.dirty.byteOffset, DIRTY_BYTES), CHUNK_BYTES);
    out.set(new Uint8Array(this.wet.buffer, this.wet.byteOffset, DIRTY_BYTES), CHUNK_BYTES + DIRTY_BYTES);
    out.set(new Uint8Array(this.lava.buffer, this.lava.byteOffset, DIRTY_BYTES), CHUNK_BYTES + DIRTY_BYTES * 2);
    const head = CHUNK_BYTES + DIRTY_BYTES * 3;
    dv.setUint32(head + 0, this.version >>> 0, true);
    dv.setUint32(head + 4, this.dirtyCount >>> 0, true);
    dv.setInt32(head + 8, this.cx | 0, true);
    dv.setInt32(head + 12, this.cy | 0, true);
    dv.setUint32(head + 16, rle.length >>> 0, true);
    dv.setUint32(head + 20, 0, true);
    out.set(rle, head + 24);
    return out;
  }

  static deserializeSnapshot(buf: Uint8Array | ArrayBuffer): Chunk {
    const bytes = toBytes(buf);
    const c = Chunk.deserialize(bytes);
    const head = CHUNK_BYTES + DIRTY_BYTES * 3;
    if (bytes.byteLength < head + 24) return c;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    c.cx = dv.getInt32(head + 8, true);
    c.cy = dv.getInt32(head + 12, true);
    c.version = dv.getUint32(head + 0, true);
    c.dirty.set(new Uint32Array(bytes.buffer, bytes.byteOffset + CHUNK_BYTES, DIRTY_WORDS));
    c.wet.set(new Uint32Array(bytes.buffer, bytes.byteOffset + CHUNK_BYTES + DIRTY_BYTES, DIRTY_WORDS));
    c.lava.set(new Uint32Array(bytes.buffer, bytes.byteOffset + CHUNK_BYTES + DIRTY_BYTES * 2, DIRTY_WORDS));
    c.dirtyCount = 0;
    for (let w = 0; w < DIRTY_WORDS; w += 1) c.dirtyCount += popcount32(c.dirty[w]);
    const rleLen = dv.getUint32(head + 16, true);
    if (bytes.byteLength >= head + 24 + rleLen) {
      decodeRoofRle(bytes.subarray(head + 24, head + 24 + rleLen), c.roofs);
    }
    return c;
  }

  /** 深拷贝(回滚快照用)。 */
  clone(cx = this.cx, cy = this.cy): Chunk {
    const c = new Chunk(cx, cy);
    c.cells.set(this.cells);
    c.roofs.set(this.roofs);
    c.dirty.set(this.dirty);
    c.wet.set(this.wet);
    c.lava.set(this.lava);
    c.dirtyCount = this.dirtyCount;
    c.version = this.version;
    return c;
  }

  /** 本分片常驻字节。 */
  byteSize(): number {
    return CHUNK_BYTES + this.roofs.byteLength + DIRTY_BYTES * 3;
  }

  /** 打包成 TileView(调试 / 渲染桥接用,不在热路径)。 */
  view(x: number, y: number, gx = x, gy = y): TileView {
    const packed = this.cells[idx(x, y)];
    const f = unpackTile(packed);
    const slot = f.floor & FLOOR_SLOT_MASK;
    const alpha = this.roofAlphaUnder(x, y);
    return {
      gx, gy, lx: x, ly: y, packed,
      elev: f.elev, base: f.base,
      floorSlot: slot, floorId: floorIdOfSlot(slot),
      wire: f.wire, obj: f.obj, meta: f.meta,
      metaState: metaState(packed), faceDir: faceDir(packed),
      roof: this.roofs[idx(x, y)],
      roofAlpha: alpha,
      roofCovers: this.roofs[idx(x, y)] !== 0 || alpha < 1,
      mu: muOfSlot(slot),
      burnPerSec: FLOOR_BURN_BY_SLOT[slot],
    };
  }
}

/* ═══════════════════════ 9. 屋顶层 RLE ═══════════════════════ */

/**
 * 屋顶层游程编码:
 *   0x00..0x7f  → 该数值个零值
 *   0xff vL vH  → 1 个非零值(小端 uint16)
 * 全空 chunk 只占 1 字节。
 */
export function encodeRoofRle(roofs: Uint16Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < roofs.length) {
    const v = roofs[i];
    if (v === 0) {
      let n = 0;
      while (i + n < roofs.length && roofs[i + n] === 0 && n < 127) n += 1;
      out.push(n);
      i += n;
      continue;
    }
    out.push(0xff, v & 0xff, (v >>> 8) & 0xff);
    i += 1;
  }
  return Uint8Array.from(out);
}

export function decodeRoofRle(buf: Uint8Array, into: Uint16Array): void {
  let i = 0;
  let o = 0;
  while (i < buf.length && o < into.length) {
    const tag = buf[i];
    if (tag === 0xff) {
      into[o] = (buf[i + 1] | (buf[i + 2] << 8)) & 0xffff;
      o += 1;
      i += 3;
    } else {
      o += tag;
      i += 1;
    }
  }
}