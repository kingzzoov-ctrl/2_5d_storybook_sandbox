/**
 * WS-03 / 208 魔法描图卷轴:16×16 框选 → 压缩蓝图码 → 材料清单 → 飞砖接力队列。
 *
 * 蓝图码格式(纯文本,可贴进聊天框):
 *   "BP1:<w>x<h>:<payload>"
 *   payload = base64( RLE 三元组流 ),三元组 = [value:varint][run:varint]
 *   varint  = 7-bit 小端续位编码,高位 1 表示后续字节继续
 *
 * 因为 16×16 自建房屋中同质区域极大(整面墙、整片地板),RLE 后的三元组
 * 通常只有 30~120 组,蓝图码长度稳定落在 100~400 字符区间。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { ITEM_BY_ID, itemName, itemValue } from '../../../shared/constants/items.ts';
import { packTile, unpackTile } from '../../../shared/types/tile.ts';
import { TileGrid } from './grid.ts';
/* 地板槽位 → ID 的唯一事实源(WS-01),不得在本地重写偏移 */
import { floorIdOfSlot } from '../world/chunk.ts';

/** 描图卷轴 208 的固定框选尺寸。 */
export const BLUEPRINT_SIZE = 16;
export const BLUEPRINT_CELLS = BLUEPRINT_SIZE * BLUEPRINT_SIZE;
/** 蓝图码魔数前缀。 */
export const BLUEPRINT_MAGIC = 'BP1';

export interface BlueprintCell {
  /** 物体 ID(Bits 16..27) */
  obj: number;
  /** 地砖 ID(Bits 6..11) */
  floor: number;
  /** 海拔(Bits 0..1) */
  elev: number;
  /** 四色暗线位(Bits 12..15) */
  wire: number;
  /** 运行态 + 朝向(Bits 28..31) */
  meta: number;
}

export interface Blueprint {
  w: number;
  h: number;
  /** 行主序,w×h 个格,下标 y*w+x */
  cells: BlueprintCell[];
  /** 源世界左上角坐标(仅用于日志,不参与编码) */
  originX: number;
  originY: number;
}

export interface MaterialLine {
  id: number;
  name: string;
  /** 需要数量 */
  count: number;
  /** 单件价值分 */
  unitValue: number;
  /** count × unitValue */
  totalValue: number;
}

export interface MaterialManifest {
  /** 逐项材料,按 ID 升序 */
  lines: MaterialLine[];
  /** 材料种类数 */
  kinds: number;
  /** 总件数(所有 count 之和) */
  totalCount: number;
  /** 总价值分 */
  totalValue: number;
  /** 物件数(非地板) */
  objectCount: number;
  /** 地板格数 */
  floorCount: number;
}

/* ─────────────────── varint + base64 ─────────────────── */

function pushVarint(out: number[], v: number): void {
  let n = v >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n & 0x7f);
}

interface Cursor { i: number; buf: readonly number[]; }

function readVarint(c: Cursor): number {
  let shift = 0;
  let result = 0;
  for (;;) {
    if (c.i >= c.buf.length) throw new Error('蓝图码截断:varint 不完整');
    if (shift > 35) throw new Error('蓝图码损坏:varint 过长');
    const b = c.buf[c.i];
    c.i += 1;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
}

/** 字节数组 → base64(自实现,避免依赖 Buffer 的编码差异)。 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: readonly number[]): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8) | (bytes[i + 2] & 0xff);
    out += B64_ALPHABET[(n >>> 18) & 0x3f];
    out += B64_ALPHABET[(n >>> 12) & 0x3f];
    out += B64_ALPHABET[(n >>> 6) & 0x3f];
    out += B64_ALPHABET[n & 0x3f];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] & 0xff) << 16;
    out += B64_ALPHABET[(n >>> 18) & 0x3f];
    out += B64_ALPHABET[(n >>> 12) & 0x3f];
    out += '==';
  } else if (rest === 2) {
    const n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8);
    out += B64_ALPHABET[(n >>> 18) & 0x3f];
    out += B64_ALPHABET[(n >>> 12) & 0x3f];
    out += B64_ALPHABET[(n >>> 6) & 0x3f];
    out += '=';
  }
  return out;
}

export function fromBase64(text: string): number[] {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`蓝图码含非法字符:${ch}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  return out;
}

/* ─────────────────── 编码 / 解码 ─────────────────── */

function cellToValue(c: BlueprintCell): number {
  return packTile({ elev: c.elev, base: 0, floor: c.floor, wire: c.wire, obj: c.obj, meta: c.meta });
}

function valueToCell(v: number): BlueprintCell {
  const f = unpackTile(v);
  return { obj: f.obj, floor: f.floor, elev: f.elev, wire: f.wire, meta: f.meta };
}

/** 从世界框选 16×16 生成蓝图(越界部分按空处理)。 */
export function captureBlueprint(
  grid: TileGrid,
  originX: number,
  originY: number,
  w: number = BLUEPRINT_SIZE,
  h: number = BLUEPRINT_SIZE,
): Blueprint {
  if (w !== BLUEPRINT_SIZE || h !== BLUEPRINT_SIZE) {
    throw new Error(`208 描图卷轴只支持 ${BLUEPRINT_SIZE}×${BLUEPRINT_SIZE} 框选,收到 ${w}×${h}`);
  }
  const cells: BlueprintCell[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const f = unpackTile(grid.get(originX + x, originY + y));
      cells.push({ obj: f.obj, floor: f.floor, elev: f.elev, wire: f.wire, meta: f.meta });
    }
  }
  return { w, h, cells, originX, originY };
}

export interface EncodeStats {
  code: string;
  bytes: number;
  runs: number;
  /** 压缩率 = 编码字节 / 原始 32-bit 字节 */
  ratio: number;
}

/** 蓝图 → 蓝图码(RLE + varint + base64)。 */
export function encodeBlueprint(bp: Blueprint): EncodeStats {
  const bytes: number[] = [];
  let runs = 0;
  let prev = cellToValue(bp.cells[0] ?? { obj: 0, floor: 0, elev: 0, wire: 0, meta: 0 });
  let run = 0;
  for (const c of bp.cells) {
    const v = cellToValue(c);
    if (v === prev) {
      run += 1;
      continue;
    }
    pushVarint(bytes, prev);
    pushVarint(bytes, run);
    runs += 1;
    prev = v;
    run = 1;
  }
  pushVarint(bytes, prev);
  pushVarint(bytes, run);
  runs += 1;
  const payload = toBase64(bytes);
  return {
    code: `${BLUEPRINT_MAGIC}:${bp.w}x${bp.h}:${payload}`,
    bytes: bytes.length,
    runs,
    ratio: bytes.length / (bp.cells.length * 4),
  };
}

/** 蓝图码 → 蓝图(严格校验,失败抛错便于测试断言)。 */
export function decodeBlueprint(code: string): Blueprint {
  const parts = code.trim().split(':');
  if (parts.length !== 3) throw new Error('蓝图码格式错误:缺少 3 段');
  const [magic, size, payload] = parts;
  if (magic !== BLUEPRINT_MAGIC) throw new Error(`蓝图码魔数不符:${magic}`);
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) throw new Error(`蓝图码尺寸段非法:${size}`);
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w !== BLUEPRINT_SIZE || h !== BLUEPRINT_SIZE) {
    throw new Error(`蓝图尺寸 ${w}×${h} 超出 208 卷轴能力 ${BLUEPRINT_SIZE}×${BLUEPRINT_SIZE}`);
  }
  const bytes = fromBase64(payload);
  const cursor: Cursor = { i: 0, buf: bytes };
  const cells: BlueprintCell[] = [];
  while (cursor.i < bytes.length) {
    const v = readVarint(cursor);
    const run = readVarint(cursor);
    if (run === 0) throw new Error('蓝图码损坏:游程长度为 0');
    for (let k = 0; k < run; k += 1) cells.push(valueToCell(v));
    if (cells.length > w * h) throw new Error('蓝图码损坏:解出格数超过尺寸');
  }
  if (cells.length !== w * h) {
    throw new Error(`蓝图码不完整:解出 ${cells.length} 格,期望 ${w * h}`);
  }
  return { w, h, cells, originX: 0, originY: 0 };
}

/** round-trip 便捷入口。 */
export function blueprintCode(bp: Blueprint): string {
  return encodeBlueprint(bp).code;
}

/* ─────────────────── 材料清单展开 ─────────────────── */

/**
 * 材料清单展开规则:
 *  - 每个非空 `obj` 格按该物品自身的 `recipe` 展开成原材料;无配方(自然/掉落件)则按 1 件自身计;
 *  - 地板格按地砖物品 ID(floor + 300 映射区间 301~330)计 1 件;
 *  - 同类材料累加,输出按 ID 升序。
 *
 * **地板槽位 → 物品 ID 必须委派 WS-01 的 `floorIdOfSlot()`**:
 * 线性关系 `itemId = 300 + floor` 只在槽位 1..30(地砖 301..330)成立;
 * 槽位 31..63 是 UGC 像素地毯,全部映射到 314。此处若本地重写偏移,
 * 槽位 ≥31 会产出 331..363 这类**物品表里不存在的幽灵 ID**。
 */
export const FLOOR_ID_OFFSET = 300;

/**
 * 地板槽位 → 物品 ID。
 *
 * 唯一事实源是 `world/chunk.ts#floorIdOfSlot`(内部走 `FLOOR_PALETTE`)。
 * 本函数只做「0 表示无铺装」的语义包装,不重写映射。
 */
export function floorItemId(floor: number): number {
  const f = floor | 0;
  if (f <= 0) return 0;
  return floorIdOfSlot(f);
}

export interface ManifestOptions {
  /** 是否把每个物件展开为其合成配方原料(默认 true) */
  expandRecipes: boolean;
  /** 是否统计地板 */
  includeFloors: boolean;
  /** 是否把暗线布设计入「四色电路扳手」消耗(每 16 格 1 把) */
  includeWiringTool: boolean;
}

export const DEFAULT_MANIFEST_OPTIONS: ManifestOptions = {
  expandRecipes: true,
  includeFloors: true,
  includeWiringTool: true,
};

/** 四色电路扳手 207:每 16 格暗线消耗 1 把。 */
export const WIRE_TOOL_ID = 207;
export const WIRE_CELLS_PER_TOOL = 16;

export function expandMaterials(bp: Blueprint, options: ManifestOptions = DEFAULT_MANIFEST_OPTIONS): MaterialManifest {
  const acc = new Map<number, number>();
  const add = (id: number, n: number): void => {
    if (id <= 0 || n <= 0) return;
    acc.set(id, (acc.get(id) ?? 0) + n);
  };

  let objectCount = 0;
  let floorCount = 0;
  let wireCells = 0;

  for (const c of bp.cells) {
    if (c.obj !== 0) {
      objectCount += 1;
      const def = ITEM_BY_ID.get(c.obj);
      if (options.expandRecipes && def?.recipe) {
        for (const [k, v] of Object.entries(def.recipe)) add(Number(k), v);
      } else {
        add(c.obj, 1);
      }
    }
    if (c.floor !== 0) {
      floorCount += 1;
      if (options.includeFloors) add(floorItemId(c.floor), 1);
    }
    if (c.wire !== 0) wireCells += 1;
  }

  if (options.includeWiringTool && wireCells > 0) {
    add(WIRE_TOOL_ID, Math.ceil(wireCells / WIRE_CELLS_PER_TOOL));
  }

  const lines: MaterialLine[] = [...acc.entries()]
    .map(([id, count]) => {
      const unitValue = itemValue(id);
      return { id, name: itemName(id), count, unitValue, totalValue: unitValue * count };
    })
    .sort((a, b) => a.id - b.id);

  return {
    lines,
    kinds: lines.length,
    totalCount: lines.reduce((s, l) => s + l.count, 0),
    totalValue: lines.reduce((s, l) => s + l.totalValue, 0),
    objectCount,
    floorCount,
  };
}

/* ─────────────────── 飞砖接力队列 ─────────────────── */

export const RelayTaskState = {
  PENDING: 'PENDING',
  FLYING: 'FLYING',
  PLACED: 'PLACED',
} as const;
export type RelayTaskState = (typeof RelayTaskState)[keyof typeof RelayTaskState];

export interface RelayTask {
  seq: number;
  /** 目标格在蓝图内的下标 */
  cellIndex: number;
  /** 蓝图内相对坐标 */
  lx: number;
  ly: number;
  obj: number;
  floor: number;
  elev: number;
  wire: number;
  meta: number;
  state: RelayTaskState;
  /** 认领该任务的玩家 ID */
  owner: string | null;
  /** 任务开始飞行的时间戳(ms) */
  startedAt: number;
  /** 材料是否已投喂成功 */
  materialFed: boolean;
}

/** 每块飞砖的飞行时长(ms):距离越远越久,基准 400ms + 60ms/格。 */
export const BRICK_FLIGHT_BASE_MS = 400;
export const BRICK_FLIGHT_PER_CELL_MS = 60;

export interface RelayQueueOptions {
  /** 接力人数上限(房主 + 好友),手册建议 1~8 人 */
  maxBuilders: number;
  /** 每人同时在飞的砖数上限 */
  perBuilderParallel: number;
}

export const DEFAULT_RELAY_OPTIONS: RelayQueueOptions = {
  maxBuilders: 8,
  perBuilderParallel: 2,
};

/**
 * 飞砖接力队列:把蓝图拆成「每格一个任务」,按「先下后上、先外后内」排序。
 *
 * 排序理由:屋顶(372~376)必须最后铺,否则会遮挡内部施工的虚影预览;
 * 墙体优先立起,让接力队伍能看到房间轮廓。
 */
export function buildRelayQueue(bp: Blueprint, options: RelayQueueOptions = DEFAULT_RELAY_OPTIONS): RelayTask[] {
  const tasks: RelayTask[] = [];
  const cellCount = bp.cells.length;
  for (let i = 0; i < cellCount; i += 1) {
    const c = bp.cells[i];
    tasks.push({
      seq: 0,
      cellIndex: i,
      lx: i % bp.w,
      ly: Math.floor(i / bp.w),
      obj: c.obj,
      floor: c.floor,
      elev: c.elev,
      wire: c.wire,
      meta: c.meta,
      state: RelayTaskState.PENDING,
      owner: null,
      startedAt: 0,
      materialFed: false,
    });
  }
  /* 阶段权重:墙体(351~362)= 1,门窗(363~371)= 2,家具/电路(≥500 或 4xx)= 3,屋顶(372~376)= 4 */
  const stageOf = (obj: number): number => {
    if (obj === 0) return 0;
    if (obj >= 351 && obj <= 362) return 1;
    if (obj >= 363 && obj <= 371) return 2;
    if (obj >= 372 && obj <= 376) return 4;
    return 3;
  };
  tasks.sort((a, b) => {
    const sa = stageOf(a.obj);
    const sb = stageOf(b.obj);
    if (sa !== sb) return sa - sb;
    if (a.ly !== b.ly) return a.ly - b.ly;
    return a.lx - b.lx;
  });
  for (let i = 0; i < tasks.length; i += 1) tasks[i].seq = i;
  void options;
  return tasks;
}

/** 飞砖飞行时长(ms):由接力的两名玩家间的曼哈顿距离决定。 */
export function flightDurationMs(dist: number, buildSpeedMul = 1): number {
  const d = Math.max(0, dist);
  const raw = BRICK_FLIGHT_BASE_MS + d * BRICK_FLIGHT_PER_CELL_MS;
  return Math.round(raw / Math.max(0.1, buildSpeedMul));
}

export interface RelayBuilder {
  id: string;
  /** 当前位置(世界格),用于估算飞行时长 */
  x: number;
  y: number;
  /** 建造速度乘数(专精加成) */
  speedMul: number;
}

export interface RelayTickResult {
  /** 本次 tick 新完成放置的任务 */
  placed: RelayTask[];
  /** 本次 tick 新派发的任务 */
  assigned: RelayTask[];
  /** 是否还有未完成任务 */
  remaining: number;
}

/**
 * 接力推进器:每个 tick 给空闲玩家派活,并把飞行时间到的任务标记为已放置。
 *
 * 派发规则(**确定性轮转**,不是贪心也不是按材料重量):
 *   - 构造时就把「任务 i 归谁」钉死为 `active[i % k]`,即第 i 条按 index 取模派给第 i%k 人;
 *   - 因此 N 条任务分给 k 人时,每人恰好 `floor(N/k)` 或 `ceil(N/k)` 条,负载差恒 ≤ 1;
 *   - `perBuilderParallel` 只是**并发在飞上限**(防止一人手上同时飞 40 块),不影响最终归属;
 *   - 256 条 / 8 人 = 每人 32 条;257 条 / 8 人 = 33,32,32,32,32,32,32,32。
 */
export class RelayQueue {
  tasks: RelayTask[];
  builders: RelayBuilder[];
  options: RelayQueueOptions;
  /** 任务 seq → 预定归属玩家 ID(构造时一次算定) */
  readonly plan: Map<number, string>;
  private cursor: number;

  constructor(tasks: RelayTask[], builders: RelayBuilder[], options: RelayQueueOptions = DEFAULT_RELAY_OPTIONS) {
    this.tasks = tasks;
    this.builders = builders;
    this.options = options;
    this.cursor = 0;
    this.plan = new Map<number, string>();
    const active = builders.slice(0, Math.max(1, options.maxBuilders));
    if (active.length > 0) {
      for (let i = 0; i < tasks.length; i += 1) {
        this.plan.set(tasks[i].seq, active[i % active.length].id);
      }
    }
  }

  private flyingCount(builderId: string): number {
    let n = 0;
    for (const t of this.tasks) if (t.state === RelayTaskState.FLYING && t.owner === builderId) n += 1;
    return n;
  }

  tick(now: number): RelayTickResult {
    const assigned: RelayTask[] = [];
    const placed: RelayTask[] = [];

    /* 1. 结算已到时的任务 */
    for (const t of this.tasks) {
      if (t.state !== RelayTaskState.FLYING) continue;
      const b = this.builders.find((x) => x.id === t.owner);
      const dist = b ? Math.abs(b.x - t.lx) + Math.abs(b.y - t.ly) : 0;
      const dur = flightDurationMs(dist, b?.speedMul ?? 1);
      if (now - t.startedAt >= dur) {
        t.state = RelayTaskState.PLACED;
        t.materialFed = true;
        placed.push(t);
      }
    }

    /* 2. 派发:按预定归属走,只受并发上限约束 */
    const active = this.builders.slice(0, Math.max(1, this.options.maxBuilders));
    if (active.length > 0) {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const b of active) {
          if (this.flyingCount(b.id) >= this.options.perBuilderParallel) continue;
          /* 该玩家名下第一条还没派出去的任务 */
          let next: RelayTask | undefined;
          for (const t of this.tasks) {
            if (t.state !== RelayTaskState.PENDING) continue;
            if (this.plan.get(t.seq) !== b.id) continue;
            next = t;
            break;
          }
          if (!next) continue;
          next.state = RelayTaskState.FLYING;
          next.owner = b.id;
          next.startedAt = now;
          assigned.push(next);
          progressed = true;
        }
      }
    }

    return {
      placed,
      assigned,
      remaining: this.tasks.filter((t) => t.state !== RelayTaskState.PLACED).length,
    };
  }

  /** 一次性跑完(测试与「瞬时完成」调试用)。 */
  drain(stepMs = 50, maxSteps = 100000): { steps: number; placed: number } {
    let now = 0;
    let steps = 0;
    let placed = 0;
    while (steps < maxSteps) {
      const r = this.tick(now);
      placed += r.placed.length;
      steps += 1;
      if (r.remaining === 0) break;
      now += stepMs;
    }
    return { steps, placed };
  }

  /** 把已放置的任务写回世界网格(蓝图坐标系 + 偏移)。 */
  applyTo(grid: TileGrid, ox: number, oy: number): number {
    let n = 0;
    for (const t of this.tasks) {
      if (t.state !== RelayTaskState.PLACED) continue;
      const f = unpackTile(grid.get(ox + t.lx, oy + t.ly));
      f.obj = t.obj & 0xfff;
      f.floor = t.floor & 0x3f;
      f.elev = t.elev & 0x3;
      f.wire = t.wire & 0xf;
      f.meta = t.meta & 0xf;
      grid.set(ox + t.lx, oy + t.ly, packTile(f));
      n += 1;
    }
    return n;
  }

  /** 当前进度 0..1。 */
  progress(): number {
    if (this.tasks.length === 0) return 1;
    const done = this.tasks.filter((t) => t.state === RelayTaskState.PLACED).length;
    return done / this.tasks.length;
  }
}

/** 分工统计:每个玩家被分到多少块(用于 UI 侧显示接力进度条)。 */
export function relayWorkload(tasks: readonly RelayTask[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner) continue;
    m.set(t.owner, (m.get(t.owner) ?? 0) + 1);
  }
  return m;
}

/** 蓝图格数(恒定 256),供 UI 显示。 */
export const BLUEPRINT_CELL_COUNT = BLUEPRINT_CELLS;

/** 从蓝图取出非空格坐标清单(材料投喂的遍历顺序)。 */
export function blueprintSolidCells(bp: Blueprint): { lx: number; ly: number; obj: number }[] {
  const out: { lx: number; ly: number; obj: number }[] = [];
  for (let i = 0; i < bp.cells.length; i += 1) {
    const c = bp.cells[i];
    if (c.obj === 0) continue;
    out.push({ lx: i % bp.w, ly: Math.floor(i / bp.w), obj: c.obj });
  }
  return out;
}

/** 供房间检测复用:蓝图 → 独立网格。 */
export function blueprintToGrid(bp: Blueprint): TileGrid {
  const g = new TileGrid(bp.w, bp.h);
  for (let i = 0; i < bp.cells.length; i += 1) {
    const c = bp.cells[i];
    g.set(i % bp.w, Math.floor(i / bp.w), cellToValue(c));
  }
  return g;
}