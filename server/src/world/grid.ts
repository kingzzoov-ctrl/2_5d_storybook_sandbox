/**
 * WS-01 · 世界分片容器 WorldGrid 与地形查询源 GridTerrain。
 *
 * 职责:把 16×16 的 `Chunk` 按 (cx, cy) 组装成无限世界,并向 WS-02 物理、
 * WS-08 网络、WS-09 渲染暴露**只读**的地形查询(floorId / objId / elev / dir)。
 *
 * 设计要点:
 *  - 分片索引延迟创建:查询到未生成的分片返回「虚空默认格」,绝不写盘;
 *  - 所有写入走 `edit()`,写前自动留一份 COW 快照,便于回滚与「改前备份」;
 *  - 屋顶层与地砖层分开存储,`roofAt` 独立于 `floorIdAt`。
 */

import {
  CHUNK_SIZE,
  Elevation,
  BaseFluid,
  packTile,
  unpackTile,
  faceDir,
  type TileFields,
} from '../../../shared/types/tile.ts';
import {
  Chunk, chunkKey, idx, inChunkBounds, EMPTY_TILE, toBytes,
  floorIdOfSlot, floorSlotOfId, muOfSlot, FLOOR_MU_BY_SLOT, FLOOR_SLOT_MASK,
} from './chunk.ts';

/* ═══════════════════════ 1. 只读地形查询源 ═══════════════════════ */

export interface TerrainSource {
  /** 世界格坐标 (wx, wy) 的 FLOOR 层 ID,0 = 未铺装 */
  floorIdAt(wx: number, wy: number): number;
  /** 世界格坐标的 OBJ 层 ID,0 = 空 */
  objIdAt(wx: number, wy: number): number;
  /** 海拔层 0..3 */
  elevAt(wx: number, wy: number): number;
  /** 朝向高 2 位:0=北 1=东 2=南 3=西 */
  faceDirAt(wx: number, wy: number): number;
  /** 该格四色暗线掩码 0..15(WS-06 电路读取) */
  wireAt(wx: number, wy: number): number;
  /** 该格屋顶构件 ID,0 = 无 */
  roofAt(wx: number, wy: number): number;
  /** 该格是否通电(WS-06 写入;缺省全部 false) */
  poweredAt?(wx: number, wy: number): boolean;
}

/** 朝向 → 单位向量:0=北(-y) 1=东(+x) 2=南(+y) 3=西(-x) */
export const DIR_VECTORS: readonly { x: number; y: number }[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export const DIR_NAMES: readonly string[] = ['北', '东', '南', '西'];

/* ═══════════════════════ 2. WorldGrid ═══════════════════════ */

export interface GridStats {
  chunks: number;
  cells: number;
  /** 已创建分片的打包单元裸字节 */
  cellBytes: number;
  /** 附加层(屋顶 2B/格 + 3 张 32B 位图) */
  auxBytes: number;
  dirtyCells: number;
  instanceBytes: number;
}

export class WorldGrid implements TerrainSource {
  readonly chunks: Map<string, Chunk>;
  private readonly scratch: TileFields = { elev: 0, base: 0, floor: 0, wire: 0, obj: 0, meta: 0 };
  private powered: Set<string> | null = null;

  constructor() {
    this.chunks = new Map<string, Chunk>();
  }

  /* ── 分片管理 ── */

  hasChunk(cx: number, cy: number): boolean {
    return this.chunks.has(chunkKey(cx, cy));
  }

  getChunk(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  ensureChunk(cx: number, cy: number): Chunk {
    const k = chunkKey(cx, cy);
    let c = this.chunks.get(k);
    if (c === undefined) {
      c = new Chunk(cx, cy);
      this.chunks.set(k, c);
    }
    return c;
  }

  /** 整个世界灌入同一默认格(测试与「新建世界」用)。 */
  fillAll(fields: Partial<TileFields>): void {
    for (const c of this.chunks.values()) {
      for (let i = 0; i < 256; i += 1) {
        c.cells[i] = packTile({ ...unpackTile(c.cells[i]), ...fields });
      }
      c.version = (c.version + 1) >>> 0;
    }
  }

  /* ── 读写 ── */

  cellAt(wx: number, wy: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const c = this.chunks.get(chunkKey(cx, cy));
    if (c === undefined) return EMPTY_TILE;
    return c.cells[idx(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE)];
  }

  fieldsAt(wx: number, wy: number): TileFields {
    return unpackTile(this.cellAt(wx, wy));
  }

  /** 写入并落脏位;返回被替换的旧值。 */
  setCell(wx: number, wy: number, fields: Partial<TileFields>): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const c = this.ensureChunk(cx, cy);
    const before = c.get(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE);
    c.set(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE, fields);
    return before;
  }

  setFloor(wx: number, wy: number, itemId: number): void {
    this.setCell(wx, wy, { floor: floorSlotOfId(itemId) });
  }

  setRoof(wx: number, wy: number, roofId: number): void {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const c = this.ensureChunk(cx, cy);
    c.setRoof(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE, roofId);
  }

  /* ── TerrainSource ── */

  floorIdAt(wx: number, wy: number): number {
    return floorIdOfSlot(this.floorSlotAt(wx, wy));
  }

  /** FLOOR 层原始 6 位槽位。 */
  floorSlotAt(wx: number, wy: number): number {
    return (this.cellAt(wx, wy) >>> 6) & FLOOR_SLOT_MASK;
  }

  objIdAt(wx: number, wy: number): number {
    return unpackTile(this.cellAt(wx, wy)).obj;
  }

  elevAt(wx: number, wy: number): number {
    return unpackTile(this.cellAt(wx, wy)).elev;
  }

  faceDirAt(wx: number, wy: number): number {
    return faceDir(this.cellAt(wx, wy));
  }

  wireAt(wx: number, wy: number): number {
    return unpackTile(this.cellAt(wx, wy)).wire;
  }

  roofAt(wx: number, wy: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const c = this.chunks.get(chunkKey(cx, cy));
    if (c === undefined) return 0;
    return c.roofs[idx(wx - cx * CHUNK_SIZE, wy - cy * CHUNK_SIZE)];
  }

  poweredAt(wx: number, wy: number): boolean {
    return this.powered !== null && this.powered.has(`${wx},${wy}`);
  }

  /** WS-06 电路子系统回写通电格集合(只存供电中的格,内存 = O(通电格数)) */
  setPoweredCells(cells: readonly { x: number; y: number }[]): void {
    if (cells.length === 0) {
      this.powered = null;
      return;
    }
    this.powered = new Set(cells.map((c) => `${c.x},${c.y}`));
  }

  /* ── 物理便捷接口 ── */

  /** 该世界格是否阻挡水平移动(墙体 351~371 视为实心) */
  isSolidAt(wx: number, wy: number): boolean {
    const o = this.objIdAt(wx, wy);
    if (o === 0) return false;
    return o >= 351 && o <= 371;
  }

  muAt(wx: number, wy: number): number {
    return muOfSlot(this.floorSlotAt(wx, wy));
  }

  /** 裸表读取 μ 的备用路径(与 muAt 等价,便于对拍)。 */
  muById(itemId: number): number {
    return muOfSlot(floorSlotOfId(itemId));
  }

  /** 预计算 μ 表的只读视图(物理层可直取,避免逐格函数调用)。 */
  static get MU_TABLE(): Float64Array {
    return FLOOR_MU_BY_SLOT;
  }

  /* ── 统计 ── */

  stats(): GridStats {
    let cells = 0;
    let dirty = 0;
    for (const c of this.chunks.values()) {
      cells += c.cells.length;
      dirty += c.dirtyCount;
    }
    const chunkCount = this.chunks.size;
    const cellBytes = cells * 4;
    const auxBytes = cells * 2 + chunkCount * 3 * 32;
    return {
      chunks: chunkCount,
      cells,
      cellBytes,
      auxBytes,
      dirtyCells: dirty,
      instanceBytes: cellBytes + auxBytes + chunkCount * 64,
    };
  }

  clearAllDirty(): number {
    let n = 0;
    for (const c of this.chunks.values()) {
      n += c.dirtyCount;
      c.clearDirty();
    }
    return n;
  }
}

/* ═══════════════════════ 3. 引水渠:挖低 Z0 → Z-1 ═══════════════════════ */

export const CanalResult = {
  DUG: 'DUG',
  ALREADY_DEEP: 'ALREADY_DEEP',
  BLOCKED: 'BLOCKED',
} as const;
export type CanalResult = (typeof CanalResult)[keyof typeof CanalResult];

/**
 * 把一格 Z0 挖成 Z-1 深沟。若该格上方存在实心 OBJ,视为挖不动(BLOCKED)。
 * 返回是否产生「汇水口」——即该格四邻中存在水面高出自身的格。
 */
export function digToDeep(grid: WorldGrid, wx: number, wy: number): CanalResult {
  const f = grid.fieldsAt(wx, wy);
  if (f.elev === Elevation.DEEP) return CanalResult.ALREADY_DEEP;
  if (grid.isSolidAt(wx, wy)) return CanalResult.BLOCKED;
  grid.setCell(wx, wy, { elev: Elevation.DEEP, base: BaseFluid.DIRT });
  return CanalResult.DUG;
}

const ORTHO: readonly { x: number; y: number }[] = [
  { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 },
];

/** 该格是否为有效汇水口:自身海拔严格低于四邻中至少一个,且邻格为流体基底。 */
export function isCanalIntake(grid: WorldGrid, wx: number, wy: number): boolean {
  const self = grid.fieldsAt(wx, wy);
  if (self.elev !== Elevation.DEEP) return false;
  for (const d of ORTHO) {
    const n = grid.fieldsAt(wx + d.x, wy + d.y);
    if (n.elev > self.elev && n.base >= BaseFluid.SHALLOW_WATER) return true;
  }
  return false;
}

/** 兜底:在整片分片里找所有汇水口(WS-01 测试与调试面板用)。 */
export function findCanalIntakes(grid: WorldGrid, cx: number, cy: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let ly = 0; ly < CHUNK_SIZE; ly += 1) {
    for (let lx = 0; lx < CHUNK_SIZE; lx += 1) {
      const wx = cx * CHUNK_SIZE + lx;
      const wy = cy * CHUNK_SIZE + ly;
      if (isCanalIntake(grid, wx, wy)) out.push({ x: wx, y: wy });
    }
  }
  return out;
}

/** 世界格坐标是否在分片内(边界断言用)。 */
export function isInsideChunk(wx: number, wy: number, cx: number, cy: number): boolean {
  const lx = wx - cx * CHUNK_SIZE;
  const ly = wy - cy * CHUNK_SIZE;
  return inChunkBounds(lx, ly);
}
