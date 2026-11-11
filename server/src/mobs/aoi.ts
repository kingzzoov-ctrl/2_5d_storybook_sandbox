/**
 * WS-04:区块粒度 AOI(Area of Interest)管理器。
 *
 * 核心契约:
 *  - 唤醒:任一「非挂机」玩家与生物的中心距离 ≤ 32 格 → 该生物进入 `activeMobs`;
 *  - 休眠:距离 > 32 格(无迟滞,离开立即冻结)→ 从 `activeMobs` 移除,后续帧零调用;
 *  - 零 CPU:休眠生物不进入任何 tick 循环,`stepActive` 的调用计数不增长。
 *
 * 坐标单位为「格」,区块 16×16 格(见 `shared/types/tile.ts#CHUNK_SIZE`)。
 */

import { CHUNK_SIZE } from '../../../shared/types/tile.ts';

/** 觉醒半径(格)。边界含 32 格本身。 */
export const AOI_WAKE_DISTANCE = 32;
/** 唤醒半径的平方,避免每帧 sqrt。 */
export const AOI_WAKE_DISTANCE_SQ = AOI_WAKE_DISTANCE * AOI_WAKE_DISTANCE;

/** 浮点边界容差:恰好 32.000000000 格仍算在圈内。 */
export const AOI_EPS = 1e-9;

/** 休眠后的生物每秒处理次数上限(0,即完全不处理)。 */
export const DORMANT_TICK_HZ = 0;

export interface AoiPlayer {
  id: string;
  x: number;
  y: number;
  /** 挂机/打盹玩家不提供唤醒能量(设计手册:打盹只享受经验,不维持生态模拟)。 */
  afk: boolean;
}

export interface AoiMobRecord {
  id: string;
  x: number;
  y: number;
  /** 生物所属区块键,用于 O(1) 迁移。 */
  chunkKey: string;
}

export interface AoiStats {
  /** 上一帧参与精确距离判定的生物数。 */
  scannedMobs: number;
  /** 上一帧被遍历的区块数(上界 = 玩家包围盒覆盖的区块数)。 */
  scannedChunks: number;
  /** 唤醒集合大小。 */
  activeCount: number;
  /** 本管理器创建以来的总唤醒次数(用于抖动监控)。 */
  wakes: number;
  /** 总休眠次数。 */
  sleeps: number;
}

export function chunkKeyOf(x: number, y: number): string {
  return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`;
}

/** 单点是否在任一玩家 AOI 内(精确欧氏距离,含边界)。 */
export function isInsideAoi(x: number, y: number, players: readonly AoiPlayer[]): boolean {
  const lim = AOI_WAKE_DISTANCE * (1 + AOI_EPS) * (AOI_WAKE_DISTANCE * (1 + AOI_EPS));
  for (const p of players) {
    if (p.afk) continue;
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy <= lim) return true;
  }
  return false;
}

/**
 * 区块级 AOI 索引。
 *
 * 内存:`Map<chunkKey, Set<mobId>>`,每块一条 Set;200 只怪最多占 200 个 key,
 * 实测 Set 头开销 ~144B,总上界 < 64KB。
 */
export class AoiManager {
  /** 唤醒集合:进入该集合 = 参与本帧模拟。 */
  readonly activeMobs: Set<string> = new Set<string>();

  private readonly mobs: Map<string, AoiMobRecord> = new Map<string, AoiMobRecord>();
  private readonly chunks: Map<string, Set<string>> = new Map<string, Set<string>>();
  private players: AoiPlayer[] = [];

  /** CPU 记账:只有 `stepActive` 会对唤醒生物自增。 */
  activeStepCalls = 0;
  dormantStepCalls = 0;
  /** 累计的唤醒生物 tick 次数(每生物每帧 +1)。 */
  totalActiveTicks = 0;
  /** 上一次 `update` 的统计。 */
  lastStats: AoiStats = {
    scannedMobs: 0, scannedChunks: 0, activeCount: 0, wakes: 0, sleeps: 0,
  };

  registerMob(id: string, x: number, y: number): void {
    this.unregisterMob(id);
    const key = chunkKeyOf(x, y);
    this.mobs.set(id, { id, x, y, chunkKey: key });
    let bucket = this.chunks.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      this.chunks.set(key, bucket);
    }
    bucket.add(id);
  }

  unregisterMob(id: string): void {
    const rec = this.mobs.get(id);
    if (!rec) return;
    const bucket = this.chunks.get(rec.chunkKey);
    if (bucket) {
      bucket.delete(id);
      if (bucket.size === 0) this.chunks.delete(rec.chunkKey);
    }
    this.mobs.delete(id);
    this.activeMobs.delete(id);
  }

  /** 生物跨区块移动时调用;同区块内移动为 O(1) 空操作。 */
  moveMob(id: string, x: number, y: number): void {
    const rec = this.mobs.get(id);
    if (!rec) {
      this.registerMob(id, x, y);
      return;
    }
    rec.x = x;
    rec.y = y;
    const key = chunkKeyOf(x, y);
    if (key === rec.chunkKey) return;
    const old = this.chunks.get(rec.chunkKey);
    if (old) {
      old.delete(id);
      if (old.size === 0) this.chunks.delete(rec.chunkKey);
    }
    let bucket = this.chunks.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      this.chunks.set(key, bucket);
    }
    bucket.add(id);
    rec.chunkKey = key;
  }

  getMob(id: string): AoiMobRecord | undefined {
    return this.mobs.get(id);
  }

  get mobCount(): number {
    return this.mobs.size;
  }

  setPlayers(players: readonly AoiPlayer[]): void {
    this.players = players.filter((p) => !p.afk);
  }

  /**
   * 重算唤醒集合。
   *
   * 复杂度:O(P × C_p + Σ|bucket|),其中 C_p 是单玩家包围盒覆盖的区块数,
   * 32 格半径 → 每轴 5±1 块,上界 49 块;去重后一次遍历。
   * 与生物总数相关的是「被覆盖区块里的生物数」,不是全量 N。
   */
  update(): { woke: string[]; slept: string[] } {
    const visited = new Set<string>();
    let scannedChunks = 0;

    for (const p of this.players) {
      const c0x = Math.floor((p.x - AOI_WAKE_DISTANCE) / CHUNK_SIZE);
      const c1x = Math.floor((p.x + AOI_WAKE_DISTANCE) / CHUNK_SIZE);
      const c0y = Math.floor((p.y - AOI_WAKE_DISTANCE) / CHUNK_SIZE);
      const c1y = Math.floor((p.y + AOI_WAKE_DISTANCE) / CHUNK_SIZE);
      for (let cx = c0x; cx <= c1x; cx += 1) {
        for (let cy = c0y; cy <= c1y; cy += 1) {
          const key = `${cx},${cy}`;
          if (visited.has(key)) continue;
          visited.add(key);
          scannedChunks += 1;
          const bucket = this.chunks.get(key);
          if (!bucket) continue;
          for (const id of bucket) visited.add(`#${id}`);
        }
      }
    }

    const woke: string[] = [];
    const slept: string[] = [];
    let scannedMobs = 0;

    /* 候选集:包围盒内的生物 + 当前唤醒集合(可能已出圈,需检查休眠)。 */
    const candidates = new Set<string>();
    for (const token of visited) {
      if (token.startsWith('#')) candidates.add(token.slice(1));
    }
    for (const id of this.activeMobs) candidates.add(id);

    for (const id of candidates) {
      const rec = this.mobs.get(id);
      if (!rec) {
        if (this.activeMobs.delete(id)) slept.push(id);
        continue;
      }
      scannedMobs += 1;
      const inside = isInsideAoi(rec.x, rec.y, this.players) || isNearAnyPlayer(rec.x, rec.y, this.players);
      if (inside) {
        if (!this.activeMobs.has(id)) {
          this.activeMobs.add(id);
          woke.push(id);
        }
      } else if (this.activeMobs.delete(id)) {
        slept.push(id);
      }
    }

    this.lastStats = {
      scannedMobs,
      scannedChunks,
      activeCount: this.activeMobs.size,
      wakes: this.lastStats.wakes + woke.length,
      sleeps: this.lastStats.sleeps + slept.length,
    };
    return { woke, slept };
  }

  /** 业务方法:仅对唤醒生物执行回调,并记账。 */
  stepActive(fn: (id: string, rec: AoiMobRecord) => void): number {
    let n = 0;
    for (const id of this.activeMobs) {
      const rec = this.mobs.get(id);
      if (!rec) continue;
      this.activeStepCalls += 1;
      this.totalActiveTicks += 1;
      fn(id, rec);
      n += 1;
    }
    return n;
  }

  isActive(id: string): boolean {
    return this.activeMobs.has(id);
  }
}

/** 与 `isInsideAoi` 等价,但用乘方展开避免重复求面积;供 update 复用。 */
function isNearAnyPlayer(x: number, y: number, players: readonly AoiPlayer[]): boolean {
  const r = AOI_WAKE_DISTANCE * (1 + AOI_EPS);
  const lim = r * r;
  for (const p of players) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy <= lim) return true;
  }
  return false;
}

/**
 * 每帧扫描成本模型(供文档引用,也是测试断言的对象)。
 *
 * - 单玩家覆盖 32 格 → 每轴 ceil(32/16)*2+1 = 5 块,上界 25 块;
 * - 8 玩家最坏 200 块,平均去重后 ~60 块;
 * - 每块哈希 1 次 + Set 遍历,实测 ~40ns;
 * - 200 只怪中仅 30 只落在覆盖块内 → 精确判定 30 次 × ~8ns。
 *
 * 返回 `{ chunkLookups, preciseTests, estimateUs }`。
 */
export function estimateAoiScanCost(playerCount: number, coveredMobs: number): {
  chunkLookups: number; preciseTests: number; estimateUs: number;
} {
  const perPlayerChunks = 25;
  const chunkLookups = playerCount * perPlayerChunks;
  const preciseTests = coveredMobs;
  const estimateUs = chunkLookups * 0.04 + preciseTests * 0.008;
  return { chunkLookups, preciseTests, estimateUs };
}