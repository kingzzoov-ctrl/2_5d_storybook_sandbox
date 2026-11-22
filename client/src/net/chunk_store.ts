/**
 * WS-FND-182 · 客户端**块存储** —— 服务端下行的地形在这里落地。
 *
 * ## 它替掉的是什么
 * 修前客户端的地形来自 `client/src/stage/design_world.ts` 的 `buildDesignChunks()`
 * (在本地重算同一张设计图),与服务器**在跑的那个世界**没有数据关系 ——
 * 玩家盖的墙、拆的块一个字节都到不了这里。
 * 现在地形的唯一来源是服务端下行的块帧(见 `shared/net/terrain.ts`),
 * 本文件是它在客户端这一侧的**纯数据**落点:
 * ```text
 * 收帧 → applyWire(bytes) → key → { cx, cy, version, tiles: Uint32Array }
 * ```
 * 不 import three、不持句柄、不知道渲染 —— 建面由调用方拿 `chunks()` 喂
 * `tile_mesh.ts` 的 `ChunkInput`。
 *
 * ## 调用方式(接线由 `three/boot.ts` 那一侧做,本文件不碰它)
 * ```ts
 * // 1 建一个(整个会话只有一个;与 ClientStateStore 同一纪律)
 * const chunks = new ClientChunkStore();
 *
 * // 2 传给会话 —— 收到块后 session 会调 events.onTerrain
 * const session = createSession({
 *   url, store, chunks,
 *   events: {
 *     onFrame: (r, st) => { ... },                 // 实体快照(不变)
 *     // ★ 地形:块已经写进 chunks 了,这里只决定「要不要重建 mesh」
 *     onTerrain: ({ changed, store }) => {
 *       const input = store.chunks();              // 顺序稳定(按 (cy,cx))
 *       rebuildMeshes(input, new Set(changed));    // 只重建变了的那些块
 *       store.clearDirty();                        // ★ 重建完**必须**清,否则下一帧还会重建
 *     },
 *   },
 * });
 *
 * // 3 首帧:没有 onTerrain 回调时也可以主动拉(join 后块是分批到的)
 * const all = chunks.chunks();
 * const dirty = chunks.dirty();     // 还没被消费掉的脏 key(按 (cy,cx) 升序)
 * ```
 *
 * ## 三条语义(判据见 `tests/WS-FND-182-terrain-downlink.test.ts`)
 * ```text
 * 1 同一个 key 收到两次 ⇒ **后者为准**(整块替换;块字节是自包含的)
 * 2 chunks() 顺序**稳定**且与写入顺序无关(按 (cy,cx) 升序,与
 *   diffChunkVersions / buildDesignChunks 同一口径)⇒ 建面结果可复现
 * 3 脏标记是**消费型**的:clearDirty() 之前一直脏 ⇒ 调用方漏清会表现为
 *   "每帧重建同一批",而不是"某一帧漏重建"(后者才是难查的那一种)
 * ```
 */

import {
  decodeTerrainFrame,
  terrainChunkKey,
  type DecodedTerrainFrame,
} from '../../../shared/net/terrain.ts';
import type { ChunkInput } from '../stage/tile_mesh.ts';

/** 存下来的一块。`tiles` 是解码时新造的独立数组(不与线上缓冲共享)。 */
export interface StoredChunk {
  key: string;
  cx: number;
  cy: number;
  version: number;
  tiles: Uint32Array;
}

/** 一次落地的结果(可观测:调用方不必自己再 diff 一遍)。 */
export interface ChunkApplyResult {
  /** 本帧真正写下的块 key(按 (cy,cx) 升序,同 key 只出现一次)。 */
  changed: string[];
  /**
   * 其中**新建**的块数。
   * ⚠️ `added + replaced === changed.length` 只在「同一个 key 在一帧里只出现一次」
   * 时成立 —— 一帧内重复的 key 会各算一次(那种帧是服务端的 bug,不是正常形态)。
   */
  added: number;
  /** 其中**覆盖**已有块的块数(整块替换,不是 merge)。 */
  replaced: number;
}

/**
 * 地形块存储。
 *
 * ⚠️ 与 `ClientStateStore` 的分工:`ClientStateStore` 装**实体快照**
 * (玩家 / 生物 / boss / 房间级 meta),本类装**地形块**。
 * 两者**不共用**一份 `apply`,因为判据完全不同:
 * 快照按 tick 单调门丢弃迟到帧,而块是「按 key 的整块替换」——
 * 一块的字节**没有世代**,按 tick 丢它只会让某块永久停在旧版本。
 */
export class ClientChunkStore {
  private readonly byKey = new Map<string, StoredChunk>();
  private readonly dirtyKeys = new Set<string>();
  private frames = 0;

  /** 已落地的块数。 */
  get size(): number {
    return this.byKey.size;
  }

  /** 已落地的帧数(单调;与 `size` 分开 —— 一帧可以只含 0 块,也可以含 8 块)。 */
  get appliedFrames(): number {
    return this.frames;
  }

  /**
   * 落一帧(**已解好的**帧)。
   *
   * 同一帧里同一个 key 出现两次时:**后一个赢**(与跨帧的规则一致 ——
   * 不做"先到先得"的例外,那会让「一帧内重复」变成一处只在服务端出 bug 时
   * 才会走到的分支)。
   */
  applyFrame(frame: DecodedTerrainFrame): ChunkApplyResult {
    const changed = new Set<string>();
    let added = 0;
    let replaced = 0;
    for (const c of frame.chunks) {
      const key = terrainChunkKey(c.cx, c.cy);
      /* 落地的顺序 = 「删掉旧的再放新的」⇒ Map 里最近写入的排在最后,
         而 `chunks()` 另有稳定排序(见 `sortKeys`)⇒ 两者互不干扰。 */
      if (this.byKey.delete(key)) replaced += 1; else added += 1;
      this.byKey.set(key, { key, cx: c.cx, cy: c.cy, version: c.version, tiles: c.tiles });
      this.dirtyKeys.add(key);
      changed.add(key);
    }
    this.frames += 1;
    return { changed: this.sortKeys(changed), added, replaced };
  }

  /**
   * 落一帧(**线上字节**)。
   *
   * ⚠️ 解不开就**抛**(由 `session.ts` 计数 + 报 `onDrop`):静默 return 会让
   * 「服务端发了、客户端没画」与「服务端没发」在现场完全同形 —— 那正是本仓
   * 反复记的形态。半帧状态不会被写入(`decodeTerrainFrame` 在写任何东西之前
   * 就已经校验完长度与 tag)。
   */
  applyWire(bytes: Uint8Array): ChunkApplyResult {
    return this.applyFrame(decodeTerrainFrame(bytes));
  }

  /** 一块(没有 ⇒ `undefined`)。 */
  get(key: string): StoredChunk | undefined {
    return this.byKey.get(key);
  }

  /** 全部块,顺序 = 按 (cy, cx) 升序(与写入顺序、帧顺序**无关**)。 */
  chunks(): ChunkInput[] {
    return this.sortKeys(this.byKey.keys()).map((k) => {
      /* 上面刚数过的键一定在:非空断言在这里是"同一份 Map 的两句话"。 */
      const c = this.byKey.get(k) as StoredChunk;
      /* `ChunkInput` 的形状取自 `tile_mesh.ts`:key / cx / cy / tiles。
         ⇒ 建面侧不需要知道本类的存在(口子就是这一个函数的返回类型)。 */
      return { key: c.key, cx: c.cx, cy: c.cy, tiles: c.tiles };
    });
  }

  /** 还没被消费掉的脏 key(按 (cy,cx) 升序)。 */
  dirty(): string[] {
    return this.sortKeys(this.dirtyKeys);
  }

  /** 消费脏标记(接线点在重建完那批块**之后**;重复调用是幂等的)。 */
  clearDirty(): void {
    this.dirtyKeys.clear();
  }

  /**
   * 当前块版本表(`key → version`)——
   * 与 `delta.ts` 的 `diffChunkVersions` 同一键口径,重连后如果需要
   * 「告诉服务端我手里有什么版本」,这就是那份基线。
   */
  versions(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.byKey.values()) out[c.key] = c.version;
    return out;
  }

  /** 清空(重连换世代 / 卸载时用)。脏标记一并清。 */
  reset(): void {
    this.byKey.clear();
    this.dirtyKeys.clear();
  }

  /* ── 内部 ── */

  /** 稳定序:先 cy 后 cx(与 `diffChunkVersions` 的排序规则逐字一致)。 */
  private sortKeys(keys: Iterable<string>): string[] {
    return [...keys].sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number);
      const [bx, by] = b.split(',').map(Number);
      return (ay - by) || (ax - bx);
    });
  }
}
