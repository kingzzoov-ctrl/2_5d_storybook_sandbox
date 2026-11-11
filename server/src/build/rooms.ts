/**
 * WS-03 / 动态房间识别:BFS 闭合房间检测 + 9 种 `ROOM_RECIPES` 评分。
 *
 * 算法总览:
 *   1. 从锚点格开始 4 邻域泛洪,遇到围合构件(`isBarrier`)即记为该方向的「墙」;
 *   2. 泛洪面积超过 `maxArea`(默认 100 格)或触到世界边界 → 判定为室外,拒绝;
 *   3. 房间内部物体按 ID 计数,与 `ROOM_RECIPES` 做「必需件 + 可选件」评分;
 *   4. 形状约束:最小面积、长宽比、矩形填充率。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { OBJ_MASK, packTile, unpackTile } from '../../../shared/types/tile.ts';
import { ROOM_RECIPES } from '../../../shared/constants/bosses.ts';
import { TileGrid, DIR_DX, DIR_DY } from './grid.ts';
import { isBarrier, isDoor, isWindow, isWall, isRoof } from './autotile.ts';

/** 单房间默认上限:100 格(手册 §3.8 动态房间面积约束)。 */
export const DEFAULT_MAX_AREA = 100;
/** 最小可识别面积:4 格(2×2)。 */
export const DEFAULT_MIN_AREA = 4;
/** 最大长宽比:超过 4:1 视为走廊而非房间。 */
export const DEFAULT_MAX_ASPECT = 4.0;
/** 最小矩形填充率:房间格数 / 外接矩形面积。 */
export const DEFAULT_MIN_FILL = 0.5;

export const RoomRejectReason = {
  NONE: 'NONE',
  AREA_OVERFLOW: 'AREA_OVERFLOW',
  BOUNDARY_LEAK: 'BOUNDARY_LEAK',
  AREA_TOO_SMALL: 'AREA_TOO_SMALL',
  ASPECT_TOO_LONG: 'ASPECT_TOO_LONG',
  FILL_TOO_SPARSE: 'FILL_TOO_SPARSE',
  ANCHOR_IS_BARRIER: 'ANCHOR_IS_BARRIER',
} as const;
export type RoomRejectReason = (typeof RoomRejectReason)[keyof typeof RoomRejectReason];

export interface RoomCell {
  x: number;
  y: number;
}

export interface RoomBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
}

export interface RoomInfo {
  /** 房间序号(同一次扫描内自增,便于日志定位) */
  id: number;
  /** 房间内部全部格(不含围合构件本身) */
  cells: RoomCell[];
  /** 上报面积:正常即内部格数;超面积时钉死在 `maxArea + 1` */
  area: number;
  /** 实际探测过的格数(超面积熔断后仍会探测到 `leakProbeCells` 以区分泄漏) */
  probedCells: number;
  /** 内部格的外接矩形(不含墙体) */
  bbox: RoomBBox;
  /** 含围合一圈的外接矩形,用于 UI 画房间边框与落位蓝图 */
  outerBBox: RoomBBox;
  /** 是否通过闭合性与形状全部约束 */
  closed: boolean;
  /** 未通过时的首个原因 */
  reject: RoomRejectReason;
  /** 边界上的门数量(关着的门计入围合) */
  doorCount: number;
  /** 边界上的窗数量 */
  windowCount: number;
  /** 边界上普通墙体数量 */
  wallCount: number;
  /** 泛洪是否触到世界边界(漏墙的强信号) */
  boundaryLeak: boolean;
  /** 房间内部物体 ID → 数量 */
  objects: Map<number, number>;
  /** 内部地砖 ID 集合(去重) */
  floorSet: Set<number>;
  /** 内部是否含屋顶构件(屋顶在房间之上) */
  roofed: boolean;
  /** 矩形填充率 */
  fill: number;
  /**
   * 本次查询**访问过的全部格索引**(含超面积后探测到的那些)。
   * `scanRooms` 用它做全场去重:否则一个溢流的大空洞会被反复扫描,
   * 每 101 格就吐出一个假房间。
   */
  consumed: number[];
}

export interface RoomRecipeDef {
  key: string;
  name: string;
  required: readonly number[];
  optional: readonly number[];
  bonus: string;
}

export interface RoomMatch {
  key: string;
  name: string;
  /** 必需件是否全部命中 */
  matched: boolean;
  /** 缺失的必需件 */
  missingRequired: number[];
  /** 命中的可选件 */
  hitOptional: number[];
  /** 综合得分:必需件满分 100,可选件每件 +5,规模与围合加分 */
  score: number;
  /** 额外可选项总数 */
  optionalTotal: number;
  /** 配方奖励说明 */
  bonus: string;
}

export interface RoomIdentity {
  roomId: number;
  /** 采纳的配方 key;无法识别时为 null */
  key: string | null;
  /** 房间名:命中配方用配方名,否则「未命名空间」 */
  displayName: string;
  score: number;
  matches: RoomMatch[];
}

export interface ScanOptions {
  maxArea: number;
  minArea: number;
  maxAspect: number;
  minFill: number;
  /** 半高篱笆 357 是否算围合(生态牧场需要) */
  sealSemiOpen: boolean;
  /**
   * 泄漏探测上限:泛洪超过 `maxArea` 后不立即收工,继续扩张以区分
   * 「房间太大」(最终被墙截住)与「根本没围住」(冲出世界边界)。
   * 默认 `maxArea × 32 = 3200`,把单次查询代价钉死在常数上界内;
   * 超上限仍未收敛 ⇒ 判为 BOUNDARY_LEAK(不封闭),不报 AREA_OVERFLOW。
   */
  leakProbeCells: number;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  maxArea: DEFAULT_MAX_AREA,
  minArea: DEFAULT_MIN_AREA,
  maxAspect: DEFAULT_MAX_ASPECT,
  minFill: DEFAULT_MIN_FILL,
  sealSemiOpen: true,
  leakProbeCells: DEFAULT_MAX_AREA * 32,
};

/* ─────────────────── 配方归一化:冻结层的 `as const` 元组 → `readonly number[]` ─────────────────── */

export const NORMALIZED_RECIPES: readonly RoomRecipeDef[] = Object.freeze(
  ROOM_RECIPES.map((r) => ({
    key: r.key as string,
    name: r.name as string,
    required: (r.required as readonly number[]).slice(),
    optional: (r.optional as readonly number[]).slice(),
    bonus: r.bonus as string,
  })),
);

/** 全部配方出现过的必需件 ID 并集(供快速预筛)。 */
export const ALL_REQUIRED_IDS: readonly number[] = Object.freeze(
  [...new Set(NORMALIZED_RECIPES.flatMap((r) => [...r.required]))].sort((a, b) => a - b),
);

/* ─────────────────── 数据抽取 ─────────────────── */

function extractObjects(grid: TileGrid, cells: readonly RoomCell[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cells) {
    const obj = (grid.get(c.x, c.y) & OBJ_MASK) >>> 16;
    if (obj !== 0) m.set(obj, (m.get(obj) ?? 0) + 1);
  }
  return m;
}

function extractFloors(grid: TileGrid, cells: readonly RoomCell[]): Set<number> {
  const s = new Set<number>();
  for (const c of cells) {
    const f = unpackTile(grid.get(c.x, c.y)).floor;
    if (f !== 0) s.add(f);
  }
  return s;
}

/* ─────────────────── 核心:BFS 闭合检测 ─────────────────── */

/**
 * 从锚点向内泛洪。
 * 复杂度 O(A),A 为泛洪面积(≤ maxArea + 1),每格检查 4 个邻居 → 常数 4。
 */
export function floodRoom(
  grid: TileGrid,
  ax: number,
  ay: number,
  options: ScanOptions = DEFAULT_SCAN_OPTIONS,
  roomId = 0,
): RoomInfo {
  const emptyBBox: RoomBBox = { x0: ax, y0: ay, x1: ax, y1: ay, w: 1, h: 1 };
  const mk = (partial: Partial<RoomInfo>): RoomInfo => ({
    id: roomId,
    cells: [],
    area: 0,
    probedCells: 0,
    bbox: emptyBBox,
    outerBBox: emptyBBox,
    closed: false,
    reject: RoomRejectReason.NONE,
    doorCount: 0,
    windowCount: 0,
    wallCount: 0,
    boundaryLeak: false,
    objects: new Map(),
    floorSet: new Set(),
    roofed: false,
    fill: 0,
    consumed: [],
    ...partial,
  });

  if (!grid.inBounds(ax, ay)) {
    return mk({ reject: RoomRejectReason.ANCHOR_IS_BARRIER });
  }
  const anchorObj = (grid.get(ax, ay) & OBJ_MASK) >>> 16;
  if (isBarrier(anchorObj, options.sealSemiOpen)) {
    return mk({ reject: RoomRejectReason.ANCHOR_IS_BARRIER });
  }

  const width = grid.width;
  const visited = new Uint8Array(width * grid.height);
  const cells: RoomCell[] = [];
  const queue: number[] = [ay * width + ax];
  visited[ay * width + ax] = 1;
  /** 本次查询访问过的全部格索引(含超面积后的探测格),供 scanRooms 去重 */
  const consumed: number[] = [ay * width + ax];

  let boundaryLeak = false;
  let overflow = false;
  let doorCount = 0;
  let windowCount = 0;
  let wallCount = 0;
  let x0 = ax;
  let y0 = ay;
  let x1 = ax;
  let y1 = ay;
  let head = 0;
  /** 进入超面积后的探测格数(只用于判断「是否真的围住」) */
  let probeCells = 0;

  /* 边界去重:同一围合格可能被多个内部格看到,用 Set 去重后再计数 */
  const seenBarrier = new Set<number>();

  while (head < queue.length) {
    const idx = queue[head];
    head += 1;
    const cx = idx % width;
    const cy = (idx - cx) / width;

    if (overflow) {
      /*
       * 探测模式:不再把格计入内部面积,只继续扩张以回答
       * 「泛洪最终会不会冲出世界边界」。这使 AREA_OVERFLOW(围住了但太大)
       * 与 BOUNDARY_LEAK(根本没围住)成为两个互斥且精确的错误码。
       */
      probeCells += 1;
      if (probeCells > options.leakProbeCells) break;
    } else {
      cells.push({ x: cx, y: cy });
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
      if (cells.length > options.maxArea) overflow = true;
    }

    for (let d = 0; d < 4; d += 1) {
      const nx = cx + DIR_DX[d];
      const ny = cy + DIR_DY[d];
      if (!grid.inBounds(nx, ny)) {
        /* 触到世界边界 = 未闭合 */
        boundaryLeak = true;
        continue;
      }
      const nIdx = ny * width + nx;
      const nobj = (grid.get(nx, ny) & OBJ_MASK) >>> 16;
      if (isBarrier(nobj, options.sealSemiOpen)) {
        if (!seenBarrier.has(nIdx)) {
          seenBarrier.add(nIdx);
          if (isDoor(nobj)) doorCount += 1;
          else if (isWindow(nobj)) windowCount += 1;
          else wallCount += 1; /* 墙体 / 窗 / 半高篱笆统一计入围合格 */
        }
        continue;
      }
      if (visited[nIdx] === 0) {
        visited[nIdx] = 1;
        queue.push(nIdx);
        consumed.push(nIdx);
      }
    }
  }

  /*
   * 围合环补全:4 邻域泛洪只会「看到」正交紧贴内部的围合格,矩形房间的四个
   * 围合角只与内部格**对角**相邻,必须单独补扫一圈。
   * 判据:遍历全部内部格,取其 8 邻域;其中的围合件统一计入围合环
   * (含四角),并并入**外部**包络 —— 绝不污染内部包络。
   */
  if (!boundaryLeak && !overflow) {
    for (const c of cells) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (dx === 0 && dy === 0) continue;
          const px = c.x + dx;
          const py = c.y + dy;
          if (!grid.inBounds(px, py)) continue;
          const pIdx = py * width + px;
          if (seenBarrier.has(pIdx)) continue;
          const pObj = (grid.get(px, py) & OBJ_MASK) >>> 16;
          if (!isBarrier(pObj, options.sealSemiOpen)) continue;
          seenBarrier.add(pIdx);
          if (isDoor(pObj)) doorCount += 1;
          else if (isWindow(pObj)) windowCount += 1;
          else wallCount += 1;
        }
      }
    }
  }

  const bbox: RoomBBox = { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  /*
   * 上报面积:超面积时钉死在 maxArea + 1,即「首次越界的那一格」;
   * 探测到底的格数另存 probedCells,供调试与性能统计。
   */
  const area = overflow ? options.maxArea + 1 : cells.length;
  const probedCells = overflow ? options.maxArea + 1 + probeCells : cells.length;
  const rectArea = bbox.w * bbox.h;
  const fill = rectArea === 0 ? 0 : area / rectArea;
  const aspect = Math.max(bbox.w, bbox.h) / Math.max(1, Math.min(bbox.w, bbox.h));

  /* 外接矩形含围合一圈:把看到的围合格也并入包络 */
  let ox0 = x0;
  let oy0 = y0;
  let ox1 = x1;
  let oy1 = y1;
  for (const idx of seenBarrier) {
    const bx = idx % width;
    const by = (idx - bx) / width;
    if (bx < ox0) ox0 = bx;
    if (by < oy0) oy0 = by;
    if (bx > ox1) ox1 = bx;
    if (by > oy1) oy1 = by;
  }
  const outerBBox: RoomBBox = { x0: ox0, y0: oy0, x1: ox1, y1: oy1, w: ox1 - ox0 + 1, h: oy1 - oy0 + 1 };

  const objects = extractObjects(grid, cells);
  let roofed = false;
  for (const id of objects.keys()) if (isRoof(id)) roofed = true;

  let reject: RoomRejectReason = RoomRejectReason.NONE;
  /* 漏墙的优先级高于溢流:漏墙是「为什么不是房间」的更精确原因 */
  if (boundaryLeak) reject = RoomRejectReason.BOUNDARY_LEAK;
  else if (overflow) reject = RoomRejectReason.AREA_OVERFLOW;
  else if (area < options.minArea) reject = RoomRejectReason.AREA_TOO_SMALL;
  else if (aspect > options.maxAspect) reject = RoomRejectReason.ASPECT_TOO_LONG;
  else if (fill < options.minFill) reject = RoomRejectReason.FILL_TOO_SPARSE;

  return {
    id: roomId,
    cells,
    area,
    probedCells,
    bbox,
    outerBBox,
    closed: reject === RoomRejectReason.NONE,
    reject,
    doorCount,
    windowCount,
    wallCount,
    boundaryLeak,
    objects,
    floorSet: extractFloors(grid, cells),
    roofed,
    fill,
    consumed,
  };
}

/** 已访问位图:全场扫描时避免重复处理同一区域。 */
export function scanRooms(
  grid: TileGrid,
  options: ScanOptions = DEFAULT_SCAN_OPTIONS,
): RoomInfo[] {
  const width = grid.width;
  const visited = new Uint8Array(width * grid.height);
  const out: RoomInfo[] = [];
  let id = 0;
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (visited[idx] !== 0) continue;
      const obj = (grid.get(x, y) & OBJ_MASK) >>> 16;
      if (isBarrier(obj, options.sealSemiOpen)) {
        visited[idx] = 1;
        continue;
      }
      id += 1;
      const room = floodRoom(grid, x, y, options, id);
      /* 去重:标记本次查询访问过的**全部**格(含溢流探测格),避免重复扫描 */
      for (const ci of room.consumed) visited[ci] = 1;
      out.push(room);
    }
  }
  return out;
}

/* ─────────────────── 配方评分 ─────────────────── */

export const SCORE_REQUIRED_BASE = 100;
export const SCORE_OPTIONAL_EACH = 5;
export const SCORE_OPTIONAL_CAP = 15;
export const SCORE_SWEET_SPOT = 5;
export const SCORE_SEAL_BONUS = 3;

/** 规模甜点区:9~64 格视为「像样的房间」。 */
export const SWEET_SPOT_MIN = 9;
export const SWEET_SPOT_MAX = 64;

/**
 * 单配方评分:
 *   score = (必需件全中 ? 100 : 0)
 *         + min(可选件命中数 × 5, 15)
 *         + (面积在甜点区 ? 5 : 0)
 *         + (门 ≤ 2 且无窗泄漏 ? 3 : 0)
 * 必需件缺失时 `matched=false`,但仍返回分数供调试排序。
 */
export function scoreRoom(room: RoomInfo, recipe: RoomRecipeDef): RoomMatch {
  const missingRequired: number[] = [];
  for (const id of recipe.required) {
    if ((room.objects.get(id) ?? 0) <= 0) missingRequired.push(id);
  }
  const hitOptional: number[] = [];
  for (const id of recipe.optional) {
    if ((room.objects.get(id) ?? 0) > 0) hitOptional.push(id);
  }
  const matched = missingRequired.length === 0;
  let score = matched ? SCORE_REQUIRED_BASE : 0;
  score += Math.min(hitOptional.length * SCORE_OPTIONAL_EACH, SCORE_OPTIONAL_CAP);
  if (room.area >= SWEET_SPOT_MIN && room.area <= SWEET_SPOT_MAX) score += SCORE_SWEET_SPOT;
  if (room.doorCount <= 2 && room.closed) score += SCORE_SEAL_BONUS;
  return {
    key: recipe.key,
    name: recipe.name,
    matched,
    missingRequired,
    hitOptional,
    score,
    optionalTotal: recipe.optional.length,
    bonus: recipe.bonus,
  };
}

/**
 * 房间是否可进入识别流程的唯一判据 —— 全局只此一处实现。
 * `identifyRoom` 自身也会调用它;若传入未闭合房间则直接返回「未命名空间」。
 */
export function isRecognizable(room: RoomInfo): boolean {
  return room.closed === true && room.reject === RoomRejectReason.NONE;
}

/**
 * 房间识别:对 9 种配方全量评分,取「matched 且分数最高」者。
 * 并列时依次比较:可选件命中数 → 配方顺序下标(靠前者优先)。
 *
 * **未闭合的房间一律不参与评分**:直接返回 key=null、matches 为空数组,
 * 避免上层拿到一份「看起来命中了但根本没围住」的假结果。
 */
export function identifyRoom(
  room: RoomInfo,
  recipes: readonly RoomRecipeDef[] = NORMALIZED_RECIPES,
): RoomIdentity {
  if (!isRecognizable(room)) {
    return { roomId: room.id, key: null, displayName: '未命名空间', score: 0, matches: [] };
  }
  const matches = recipes.map((r) => scoreRoom(room, r));
  const ok = matches.filter((m) => m.matched);
  if (ok.length === 0) {
    return { roomId: room.id, key: null, displayName: '未命名空间', score: 0, matches };
  }
  ok.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.hitOptional.length !== a.hitOptional.length) return b.hitOptional.length - a.hitOptional.length;
    return recipes.findIndex((r) => r.key === a.key) - recipes.findIndex((r) => r.key === b.key);
  });
  const best = ok[0];
  return { roomId: room.id, key: best.key, displayName: best.name, score: best.score, matches };
}

/**
 * 一次扫描 + 全量识别。
 * 过滤条件集中在 `isRecognizable`,不在调用点重复书写。
 */
export function identifyAllRooms(
  grid: TileGrid,
  options: ScanOptions = DEFAULT_SCAN_OPTIONS,
  recipes: readonly RoomRecipeDef[] = NORMALIZED_RECIPES,
): RoomIdentity[] {
  return scanRooms(grid, options)
    .filter(isRecognizable)
    .map((r) => identifyRoom(r, recipes));
}

/* ─────────────────── 建造辅助:生成规则房间 ─────────────────── */

export interface BoxRoomSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  wallId: number;
  floorId: number;
  /** 南墙上的门所在列(相对 x),−1 表示无门 */
  doorAtCol: number;
  /** 每扇门额外偏移列(用于「两扇门」用例) */
  extraDoorAtCols: readonly number[];
}

/**
 * 在网格上盖一间矩形小屋:四壁 `wallId`、内部铺 `floorId`、南墙开门。
 * 内部尺寸 = (w−2) × (h−2),默认 w=h=7 → 25 格内部,落在 100 格上限内。
 */
export function stampBoxRoom(grid: TileGrid, spec: BoxRoomSpec): void {
  const { x, y, w, h, wallId, floorId } = spec;
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const edge = dx === 0 || dy === 0 || dx === w - 1 || dy === h - 1;
      const f = unpackTile(grid.get(x + dx, y + dy));
      f.obj = edge ? wallId & 0xfff : 0;
      f.floor = floorId & 0x3f;
      f.elev = 1; /* GROUND */
      grid.set(x + dx, y + dy, packTile(f));
    }
  }
  const inner = Math.max(1, w - 2);
  const doorCols = [spec.doorAtCol, ...spec.extraDoorAtCols].filter((c) => c >= 0);
  for (const col of doorCols) {
    const dx = 1 + (((col % inner) + inner) % inner);
    grid.setObj(x + dx, y + h - 1, 363);
  }
}

/** 挖掉一个围合格,制造「缺一个角」的漏墙世界。 */
export function punchHole(grid: TileGrid, x: number, y: number): void {
  const f = unpackTile(grid.get(x, y));
  f.obj = 0;
  grid.set(x, y, packTile(f));
}

/** 在房间内部放一件物体(保持地砖不变)。 */
export function placeInRoom(grid: TileGrid, x: number, y: number, objId: number): void {
  grid.setObj(x, y, objId);
}

/** 从房间信息里反查某配方必需件是否齐备(轻量查询,不做全量评分)。 */
export function hasAllRequired(room: RoomInfo, recipe: RoomRecipeDef): boolean {
  return recipe.required.every((id) => (room.objects.get(id) ?? 0) > 0);
}