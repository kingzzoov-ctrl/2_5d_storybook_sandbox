/**
 * WS-FND-182 · 地形下行帧 —— 服务端把**真正的块字节**发给客户端。
 *
 * ## 修前的形态(本任务要修的那一件事)
 * ```text
 * 客户端:client/src/stage/design_world.ts 的 buildDesignChunks() 在本地重算同一张设计图
 * 服务端:WorldSim / WorldGrid 里跑着**另一份**世界
 * 中间:  shared/net/delta.ts 的 chunkWireBytes / diffChunkVersions / makeChunkVersionKey
 *        **只有单测在用** —— 线上不存在 chunk 下行
 * ```
 * ⇒ 玩家盖的墙、拆的块、地形被载具改过的结果**一个字节都到不了客户端**;
 *   世界只能靠「两边各算一遍同一张图」对齐,而那是治不了的(服务器一侧会变)。
 *
 * ## 帧布局(小端)
 * ```text
 * ┌────────┬────────┬──────────────┬──────────────────────────────┐
 * │ tag u8 │ ver u8 │ count u16    │ count × 块(每块 1032 字节)    │
 * └────────┴────────┴──────────────┴──────────────────────────────┘
 *   块 = ┌────────┬────────┬─────────────┬───────────────────────────┐
 *        │ cx i16 │ cy i16 │ version u32 │ 256 × u32(打包格,1024 B)   │
 *        └────────┴────────┴─────────────┴───────────────────────────┘
 * ```
 *
 * ⚠️ 单块线上体积 = `chunkWireBytes()`(= 1024 + 8)。本文件**不重写**那个数字:
 *    `TERRAIN_CHUNK_BYTES` 直接取它,并在模块加载时验算
 *    「8 字节块头 + 256 × 4 字节格」与它一致 —— 两侧漂移时**当场抛错**,
 *    而不是让客户端按另一个长度去切块(那会静默错位,且看不出是谁错了)。
 *    块内的 1024 字节与 `Chunk.serialize()` **逐字节相同**(同一条口径:
 *    256 个 u32 小端),判据见 `tests/WS-FND-182-terrain-downlink.test.ts`。
 *
 * ## 为什么下行**这一种**带 tag(而差量包不带)
 * 契约 §12.1 的「下行裸协议字节」说的是一条**快照通道**;两种二进制帧共用
 * 同一个 WS opcode(0x2)⇒ 不靠首字节就没有任何东西能把它们区分开。
 * 首字节取值因此必须**同时**避开:
 * ```text
 * 0x01 FRAME_TEXT       0x02 FRAME_BINARY        0x7b `{`(裸 JSON)
 * PROTOCOL_VERSION = 3(裸差量包的首字节 = 协议版本号)
 * ```
 * ⇒ 取 `0x54`('T')。客户端在 `classifyDownlink` **之后**按这个 tag 分流
 *   (见 `client/src/net/session.ts`),差量包的首字节因此**一个字节都没变**。
 *
 * ## 为什么按帧切块(`TERRAIN_CHUNKS_PER_FRAME`)
 * 一块 1032 字节:192×192 的设计图是 144 块 = **148 KB**。整份一次写进 socket
 * 会把 Node 的发送队列打满(`socket.write` 连续返回 false ⇒ `ws_server.ts` 的
 * `BACKPRESSURE_DISCONNECT_STRIKES` 会把刚进场的人踢掉)。
 * 每帧只装 8 块(8.3 KB)⇒ 每条 WS 帧都稳稳落在默认 highWaterMark 之下,
 * 而且**每帧自包含**:客户端不需要跨帧拼装,丢一帧只丢那 8 块。
 *
 * ## 错误口径(与 `delta.ts` 同规)
 * ```text
 * 非整数 / 越界坐标 / 越界版本 / 格值非 u32  ⇒ **抛错**(不静默截断、不回绕)
 * 帧截断 / 尾部有垃圾 / 首字节不是 tag      ⇒ **抛错**(不"尽量解")
 * ```
 */

import { CHUNK_CELLS } from '../types/tile.ts';
import { MAX_U32, assertU32, chunkWireBytes, makeChunkVersionKey } from './delta.ts';

/* ═══════════════════════ 1. 常量(与 delta.ts 同一份口径)═══════════════════════ */

/**
 * 地形帧的首字节 tag(见文件头「为什么带 tag」)。
 *
 * `0x54` = ASCII 'T'。改动它 = 改线上契约:客户端会把它当**差量包**
 * 送去解码(报「协议版本不匹配」),而服务端那边看起来一切正常。
 */
export const TERRAIN_FRAME_TAG = 0x54;

/** 地形帧的线路版本。与 `PROTOCOL_VERSION` **分开**:两者的 bump 理由不同。 */
export const TERRAIN_WIRE_VERSION = 1;

/** 帧头:tag u8 + ver u8 + count u16 = 4 字节。 */
export const TERRAIN_FRAME_HEADER_BYTES = 4;

/** 块头:cx i16 + cy i16 + version u32 = 8 字节。 */
export const CHUNK_HEAD_BYTES = 8;

/** 一格的格字节数(打包单元是 u32)。 */
export const CHUNK_CELL_BYTES = 4;

/** 一块的格字节数:256 × 4 = 1024。 */
export const CHUNK_TILES_BYTES = CHUNK_CELLS * CHUNK_CELL_BYTES;

/**
 * 单块的线上体积(= 1024 + 8)。
 *
 * ★ 取自冻结层出口 `chunkWireBytes()`,**不在本文件重写 1032**。
 */
export const TERRAIN_CHUNK_BYTES = chunkWireBytes();

/** 一帧最多装几块(理由见文件头「为什么按帧切块」)。 */
export const TERRAIN_CHUNKS_PER_FRAME = 8;

/** 块数的 u16 上界(`count` 字段的宽度)。 */
export const TERRAIN_MAX_CHUNKS_PER_FRAME = 0xffff;

/* 口径验算:两块字节数必须同源。漂移时**加载即抛** —— 而不是让客户端
   按另一个长度切块(那会静默错位:第二块起全部读偏 8 字节)。 */
if (TERRAIN_CHUNK_BYTES !== CHUNK_HEAD_BYTES + CHUNK_TILES_BYTES) {
  throw new Error(
    `地形帧口径漂移:chunkWireBytes()=${TERRAIN_CHUNK_BYTES},`
    + `而本文件算出的块长 = ${CHUNK_HEAD_BYTES}(块头) + ${CHUNK_TILES_BYTES}(格) `
    + `= ${CHUNK_HEAD_BYTES + CHUNK_TILES_BYTES}`,
  );
}

/** cx / cy 的 i16 值域(块坐标不做静默回绕)。 */
export const CHUNK_COORD_MIN = -32768;
export const CHUNK_COORD_MAX = 32767;

/* ═══════════════════════ 2. 形状 ═══════════════════════ */

/** 编码输入:一块的坐标、版本号与打包格(任意可索引数组)。 */
export interface TerrainChunkInput {
  cx: number;
  cy: number;
  /** 块版本号(`Chunk.version`;u32)。服务端用它决定「要不要重发这一块」。 */
  version: number;
  /** 256 个打包格(每格 32-bit)。块内顺序:**按 y 行优先**(`idx(x,y) = y*16+x`)。 */
  tiles: ArrayLike<number>;
}

/** 解码输出:一块的坐标、版本号与打包格(独立 `Uint32Array`,不与线上缓冲共享)。 */
export interface TerrainChunk {
  cx: number;
  cy: number;
  version: number;
  tiles: Uint32Array;
}

/** 一帧解出来的东西。 */
export interface DecodedTerrainFrame {
  wireVersion: number;
  chunks: TerrainChunk[];
  /** 恰好消耗的字节数(尾部有垃圾时**抛错**,不是静默接受)。 */
  bytesConsumed: number;
}

/**
 * 块版本表的键 —— `"cx,cy"`。
 *
 * ⚠️ 与 `server/src/world/chunk.ts` 的 `chunkKey`(`"cx:cy"`)**不是**同一个口径:
 * 后者是 `WorldGrid` 的内部 Map 键。上线的键必须是 `makeChunkVersionKey`
 * (= `shared/types/wire.ts` 的 `chunkKey`)—— `diffChunkVersions` 按 `,` 切分,
 * 而 `design_world.ts` 的 `ChunkInput.key` 也是 `"cx,cy"`。
 * ⇒ 本函数是**唯一**一处,两端都调它。
 */
export function terrainChunkKey(cx: number, cy: number): string {
  return makeChunkVersionKey(cx, cy);
}

/** 一帧字节是不是地形帧(判据 = 首字节 tag + 至少一个帧头)。 */
export function isTerrainFrame(bytes: Uint8Array): boolean {
  return bytes.byteLength >= TERRAIN_FRAME_HEADER_BYTES && bytes[0] === TERRAIN_FRAME_TAG;
}

/** i16 坐标的唯一校验口:非法即抛错(不截断、不回绕)。 */
function assertChunkCoord(field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < CHUNK_COORD_MIN || v > CHUNK_COORD_MAX) {
    throw new Error(
      `${field} 非法取值:${String(v)}(要求 ${CHUNK_COORD_MIN}..${CHUNK_COORD_MAX} 的整数)`,
    );
  }
  return v;
}

/* ═══════════════════════ 3. 编码 ═══════════════════════ */

/**
 * 编一帧地形(自包含)。
 *
 * 块的**顺序即入参顺序**:调用方要用 `diffChunkVersions` 的输出(它按 `(cy, cx)`
 * 排序)⇒ 同一份变更集永远编出逐字节相同的帧(确定性,与 `delta.ts` 同规)。
 */
export function encodeTerrainFrame(chunks: readonly TerrainChunkInput[]): Uint8Array {
  if (chunks.length > TERRAIN_MAX_CHUNKS_PER_FRAME) {
    throw new Error(
      `地形帧块数越界:${chunks.length} > ${TERRAIN_MAX_CHUNKS_PER_FRAME}(u16 计数)`,
    );
  }
  const out = new Uint8Array(TERRAIN_FRAME_HEADER_BYTES + chunks.length * TERRAIN_CHUNK_BYTES);
  const dv = new DataView(out.buffer);
  out[0] = TERRAIN_FRAME_TAG;
  out[1] = TERRAIN_WIRE_VERSION;
  dv.setUint16(2, chunks.length, true);

  let off = TERRAIN_FRAME_HEADER_BYTES;
  for (const ch of chunks) {
    dv.setInt16(off, assertChunkCoord('块坐标 cx', ch.cx), true);
    dv.setInt16(off + 2, assertChunkCoord('块坐标 cy', ch.cy), true);
    dv.setUint32(off + 4, assertU32('块版本号 version', ch.version), true);
    if (ch.tiles.length < CHUNK_CELLS) {
      throw new Error(
        `块 (${ch.cx},${ch.cy}) 的格数组不足:${ch.tiles.length} < ${CHUNK_CELLS}`
        + '(块必须是满 16×16 —— 短数组会让后面所有的格错位)',
      );
    }
    let p = off + CHUNK_HEAD_BYTES;
    for (let i = 0; i < CHUNK_CELLS; i += 1) {
      const v: unknown = ch.tiles[i];
      /* ★ 与 `delta.ts` 的 `toUint` 同规:格值非 u32 ⇒ **抛错**。
         `>>> 0` 会把 NaN / 1.5 / -1 静默变成一个"合法"的 u32,
         而那正是本仓反复记的静默错值形态。 */
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_U32) {
        throw new Error(
          `块 (${ch.cx},${ch.cy}) 第 ${i} 格非法:${String(v)}`
          + `(要求 0..${MAX_U32} 的整数 —— 协议不做静默截断/回绕)`,
        );
      }
      dv.setUint32(p, v, true);
      p += CHUNK_CELL_BYTES;
    }
    off += TERRAIN_CHUNK_BYTES;
  }
  return out;
}

/**
 * 把一串块切成**多条自包含帧**(每条 ≤ `TERRAIN_CHUNKS_PER_FRAME` 块)。
 * 空输入 ⇒ 空数组(调用方据此判「无变化,不发」)。
 */
export function encodeTerrainFrames(chunks: readonly TerrainChunkInput[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i += TERRAIN_CHUNKS_PER_FRAME) {
    out.push(encodeTerrainFrame(chunks.slice(i, i + TERRAIN_CHUNKS_PER_FRAME)));
  }
  return out;
}

/* ═══════════════════════ 4. 解码 ═══════════════════════ */

/**
 * 解一帧地形。
 *
 * 尾部有剩余字节 ⇒ **抛错**(与 `decodePacket` 的 P1-2 同规):
 * 静默接受会让「两帧粘在一起」看起来像「一帧解成功了」。
 */
export function decodeTerrainFrame(bytes: Uint8Array): DecodedTerrainFrame {
  if (bytes.byteLength < TERRAIN_FRAME_HEADER_BYTES) {
    throw new Error(
      `地形帧截断:需要 ${TERRAIN_FRAME_HEADER_BYTES} 字节帧头,实得 ${bytes.byteLength} 字节`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = dv.getUint8(0);
  if (tag !== TERRAIN_FRAME_TAG) {
    throw new Error(
      `不是地形帧:首字节 ${tag} ≠ ${TERRAIN_FRAME_TAG}`
      + '(把它当差量包解会更早报「协议版本不匹配」—— 那是**错的**对象)',
    );
  }
  const wireVersion = dv.getUint8(1);
  if (wireVersion !== TERRAIN_WIRE_VERSION) {
    throw new Error(
      `地形帧线路版本不匹配:${wireVersion}(本地 ${TERRAIN_WIRE_VERSION})—— 明确失败,不静默降级`,
    );
  }
  const count = dv.getUint16(2, true);
  const need = TERRAIN_FRAME_HEADER_BYTES + count * TERRAIN_CHUNK_BYTES;
  if (bytes.byteLength < need) {
    throw new Error(
      `地形帧截断:声明 ${count} 块(需 ${need} 字节),实得 ${bytes.byteLength} 字节`,
    );
  }
  if (bytes.byteLength !== need) {
    throw new Error(
      `地形帧尾部有 ${bytes.byteLength - need} 字节未消耗(解出 ${need}/${bytes.byteLength}B)`,
    );
  }

  const chunks: TerrainChunk[] = [];
  for (let i = 0; i < count; i += 1) {
    const off = TERRAIN_FRAME_HEADER_BYTES + i * TERRAIN_CHUNK_BYTES;
    const cx = dv.getInt16(off, true);
    const cy = dv.getInt16(off + 2, true);
    const version = dv.getUint32(off + 4, true);
    const tiles = new Uint32Array(CHUNK_CELLS);
    for (let k = 0; k < CHUNK_CELLS; k += 1) {
      tiles[k] = dv.getUint32(off + CHUNK_HEAD_BYTES + k * CHUNK_CELL_BYTES, true);
    }
    chunks.push({ cx, cy, version, tiles });
  }
  return { wireVersion, chunks, bytesConsumed: need };
}

/** 解多条帧(切帧的逆运算);块的顺序 = 帧序 × 帧内序。 */
export function decodeTerrainFrames(frames: readonly Uint8Array[]): TerrainChunk[] {
  const out: TerrainChunk[] = [];
  for (const f of frames) {
    for (const c of decodeTerrainFrame(f).chunks) out.push(c);
  }
  return out;
}

/** 一块的打包格 → 线上 1024 字节(小端 u32)。`Chunk.serialize()` 的纯数据版。 */
export function encodeChunkTiles(tiles: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(CHUNK_TILES_BYTES);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < CHUNK_CELLS; i += 1) dv.setUint32(i * CHUNK_CELL_BYTES, tiles[i], true);
  return out;
}
