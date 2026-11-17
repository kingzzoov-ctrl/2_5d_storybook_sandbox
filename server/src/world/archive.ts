/**
 * WS-FND-72 · WSA1 世界快照:**解码 / chunk 裁剪规则 / 回滚计划**(D-19 第 5 条)
 *
 * ## 这个文件补的是哪一段
 *
 * 归档这条链原来只有**写**:`WorldSim.describeWorldForArchive()` 造出 `WSA1`
 * 字节 → `repo.archiveWorldSnapshot()` 存成一列 BLOB → `listWorldArchives()`
 * 列摘要。**没有人解它**,而且存储层有 1 MiB 上限,超了直接抛
 * (`archive: null` + `archiveError`,世界照样重建)。
 *
 * owner 已裁(`docs/DECISIONS.md` **D-19 第 5 条**):「归档快照 ⇒ **chunk 裁剪
 * 规则 + 完整回滚**」。于是本文件是三件东西的**唯一实现点**:
 *
 * ``` 
 * 1 decodeWorldArchive()    字节 → 结构化对象(世界世代 / 玩家世代 / 地形 chunk 列表)
 * 2 planChunkTrim() + fitWorldArchive()
 *                           超预算时按**可判定纯函数**裁 chunk(不是截断、不是随机)
 * 3 planRestore() + applyRestorePlan()
 *                           解码结果 → 操作计划 → 「按计划重建」得到旧世界描述
 * ```
 *
 * ## 为什么解码**只在本文件实现一次**
 *
 * 格式由**写入侧**决定(`world_sim.ts:describeWorldForArchive` 的 docblock 是
 * 权威说明),地形块体直接用 `world/chunk.ts:Chunk.serializeSnapshot()` ——
 * 那是仓库里**已有**的第二份地形序列化(它自己的 docblock 就写着「本地存档 /
 * 回滚用」)。再写一份「归档专用的地形编码」必然与它漂移,而漂移发生在
 * 「回滚」这条**最少被走**的路径上(等真要用的时候才发现读不回来)。
 *
 * ⚠️ 本文件**不 import `sim/**` 与 `db/**`**:它只认识字节格式与 `Chunk`,
 *    不认识世界怎么跑、也不认识库。方向是 `db/repo.ts` → 本文件(写入侧裁剪),
 *    不是反过来。
 *
 * ## 三段各自的**判据形态**(见 `tests/WS-FND-72-archive-rollback.test.ts`)
 *
 * | # | 判据 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 真实写入侧的快照 → 解码 → **逐字段相等**,且 `encode(decode(x))` 逐字节回到 `x` | 头偏移算错 / 少解一个字段 / 块体长度用错 |
 * | 2 | 小世界 **全部保留**;超预算世界 ⇒ 裁剪后字节数 ≤ 上限、被裁列表非空、原因可读 | 裁了但没用预算 / 静默截断 / 裁掉玩家建造 |
 * | 3 | 归档 → 解码 → 计划 → **应用到空世界** ⟷ 归档前的描述逐字段相等 | 计划漏字段 / 把 `current` 混进 ops |
 *
 * ## 三处**刻意不做**的(边界,别当成已实现)
 *
 * 1 **不碰 `world_sim.ts`**:回滚只做到**计划层**(`RestorePlan` 是一份纯数据),
 *    把计划喂给 `WorldSim` 的接线没做 —— 那需要新裁决(回滚要不要先归档当前
 *    世界?)且那个文件是别人的。
 * 2 **不写库**:本文件不认识 `DbLike`。裁剪成字节之后**谁**去写由
 *    `db/repo.ts:archiveWorldSnapshot` 决定(它拿本文件的 `fitWorldArchive`)。
 * 3 **不补格式里没有的字段**:WSA1 v1 的头里**没有玩家血量**(只有
 *    `id/x/y/z/level`),所以回滚计划把 `players[].hp` 列进 `unavailable`
 *    而不是编一个 100 出来 —— 编出来会让「回滚」变成「顺手改玩家血量」。
 */

import { Chunk, DIRTY_WORDS, popcount32, toBytes } from './chunk.ts';
import { CHUNK_BYTES, unpackTile } from '../../../shared/types/tile.ts';

/* ═══════════════════════ 1. 字节格式常量(写入侧的镜像) ═══════════════════════ */

/** magic `'WSA1'`(逐字节,不经 UTF-8 —— 理由见写入侧那行注释)。 */
export const WORLD_ARCHIVE_MAGIC = 'WSA1';

/** 格式版本。裁剪**不升版**:`trim` 是头里一个可选扩展键(见 `encodeWorldArchive`)。 */
export const WORLD_ARCHIVE_FORMAT_VERSION = 1;

/** `magic[4) + version[4) + headerLen[4)`,见写入侧 docblock 的 `[0,12)`。 */
const PREFIX_BYTES = 12;
/** 头之后那 4 字节的 `chunkCount`。 */
const CHUNK_COUNT_BYTES = 4;
/** 头 JSON 的字节区间起点(= `PREFIX_BYTES`)。 */
const HEADER_START = PREFIX_BYTES;

/** magic 的四个字节(`'WSA1'` 的 ASCII/UTF-8 逐字节值)。 */
const MAGIC_BYTES: readonly number[] = [0x57, 0x53, 0x41, 0x31];

/**
 * 一个 chunk 块体的**最小**长度:`cells(1024) + dirty/wet/lava(3×32) + 头(24)`。
 * 屋顶 RLE 至少 1~3 字节,所以真实块体 ≥ 1145;这里只用来挡「明显不够」的坏数据。
 */
const MIN_CHUNK_BYTES = CHUNK_BYTES + 32 * 3 + 24;

/** 裁剪规则的名字(进 `trim.rule`,让回执里的「为什么」可被机器判断)。 */
export const TRIM_RULE_ID = 'built>activity>regenerable';

/* ═══════════════════════ 2. 解码后的形状 ═══════════════════════ */

/** 世界世代(身份 + 时钟)。回滚要还的就是这几个数。 */
export interface ArchiveWorldMeta {
  roomId: string;
  /** **旧世界**的种子(决定「按这个 seed 重放出来是不是同一个世界」)。 */
  seed: number;
  sizeCells: number;
  biome: string;
  /** 世界帧号(D-07:世界时钟由帧号派生)。 */
  frame: number;
  /** 钟点(0~24 的浮点,`WorldSim.hourOfDay()`)。 */
  hourOfDay: number;
}

/** 玩家世代:位置 + 等级。**没有 hp**(格式里就没有,见文件头边界 3)。 */
export interface ArchivePlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  level: number;
}

export interface ArchiveMob {
  id: string;
  mobId: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
}

export interface ArchiveGroundItem {
  itemId: number;
  count: number;
  x: number;
  y: number;
}

/**
 * 一块地形 chunk 的**解码结果**。
 *
 * `bytes` 是 `Chunk.serializeSnapshot()` 的**原样字节**(已复制成独立缓冲):
 * 回滚要「逐位还回去」,所以**不重新编码地形** —— 只搬运。
 *
 * 三个计数是**裁剪规则的输入**:规则必须是纯函数,所以判据(「值得留吗」)
 * 必须是可数的东西,不能是「看起来重要」。
 */
export interface ArchiveChunk {
  cx: number;
  cy: number;
  /** 块体原样字节(`byteOffset === 0` 的独立副本)。 */
  bytes: Uint8Array;
  /** `bytes.byteLength`(单独存一份,省得到处 `.byteLength`)。 */
  byteLength: number;
  /** 有内容的格数:`obj !== 0 || wire !== 0 || roof !== 0`(= 玩家建造,不可由 seed 重建)。 */
  builtCells: number;
  /** 屋顶层的非零格数(屋顶走独立旁路层,是玩家作品的一部分)。 */
  roofCells: number;
  /** 流体台账位数(`wet | lava` 位图),表示「这块正在发生什么」。 */
  fluidCells: number;
  /** 脏位数(`dirty` 位图;`Chunk.deserializeSnapshot` 已经算好 `dirtyCount`)。 */
  dirtyCells: number;
  /** 优先级分层:2 玩家建造 / 1 活动(流体或脏位)/ 0 原始地形(可由同 seed 重建)。 */
  tier: number;
  /** 块体自带的 `cx/cy` 与头里声明的不一致(= 坏数据;出问题要看得见)。 */
  coordMismatch: boolean;
}

/** 被裁掉的那一块(回执里的「裁了谁」)。 */
export interface ArchiveTrimDroppedChunk {
  cx: number;
  cy: number;
  /** 块体字节数(裁掉多少字节)。 */
  bytes: number;
  /** 为什么裁它(`regenerable` / `budget`)。 */
  reason: string;
}

/**
 * 裁剪报告(「被裁掉多少 / 为什么」)。
 *
 * 摘要会**写进快照头**(`header.trim`),所以「以后谁来读这份归档」都能看出
 * 它是裁剪过的;逐块清单**不持久化**(900 块的手写清单要吃掉 ~36KB 预算,
 * 而预算正是裁剪要守的东西)。
 */
export interface ArchiveTrimReport {
  /** 本次裁剪的字节上限(逐字节可判)。 */
  budgetBytes: number;
  /** 裁剪前快照字节数。 */
  originalBytes: number;
  /** 保留了几块地形。 */
  keptChunks: number;
  /** 裁掉了几块。 */
  droppedChunks: number;
  /** 裁掉的块体字节合计。 */
  droppedBytes: number;
  /** 规则标识(`TRIM_RULE_ID`),机器可判。 */
  rule: string;
  /** 人类可读的原因(含优先级与「被裁块不可回滚」)。 */
  reason: string;
  /** 逐块清单(**只在本次裁剪的回执里有**;从库里读回时是空数组)。 */
  dropped: ArchiveTrimDroppedChunk[];
}

/** 解码结果 = 回滚的全部原料。 */
export interface DecodedWorldArchive {
  /** 头里的 `version`(与 `[4,8)` 的 uint32 必须一致,否则算坏数据)。 */
  version: number;
  /** 整份快照字节数。 */
  totalBytes: number;
  /** 头 JSON 的字节数。 */
  headerBytes: number;
  /** 块体合计字节数。 */
  bodyBytes: number;
  world: ArchiveWorldMeta;
  players: ArchivePlayer[];
  mobs: ArchiveMob[];
  ground: ArchiveGroundItem[];
  /** 地形 chunk 列表(**头里声明的顺序**;写入侧按 `(cy, cx)` 升序)。 */
  chunks: ArchiveChunk[];
  /** 裁剪摘要(没裁过 ⇒ `null`)。 */
  trim: ArchiveTrimReport | null;
  /** 解码时发现的**非致命**异常(坐标不一致 / 未知扩展键)。空数组 = 干净。 */
  warnings: string[];
}

/* ═══════════════════════ 3. 解码 ═══════════════════════ */

/** 取一个必须存在、且必须是有限数的字段(解码器的校验都必须**说清是哪个字段**)。 */
function numField(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`WSA1 解码失败:${where} 必须是有限数(实得 ${String(v)})`);
  }
  return v;
}

/** 取一个必须是整数的字段。 */
function intField(v: unknown, where: string): number {
  const n = numField(v, where);
  if (!Number.isInteger(n)) throw new Error(`WSA1 解码失败:${where} 必须是整数(实得 ${n})`);
  return n;
}

/** 取一个必须是字符串的字段。 */
function strField(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`WSA1 解码失败:${where} 必须是字符串(实得 ${String(v)})`);
  return v;
}

function recordField(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`WSA1 解码失败:${where} 必须是对象`);
  }
  return v as Record<string, unknown>;
}

function arrayField(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`WSA1 解码失败:${where} 必须是数组`);
  return v;
}

/**
 * 单块地形:原样字节 + 三个计数。
 *
 * `Chunk.deserializeSnapshot()` 是**唯一**的地形解码实现(见文件头),这里只
 * 负责「从块体里数出裁剪规则要的判据」。块体先 `slice()` 成独立缓冲:
 * `Uint32Array` 视图要求 `byteOffset % 4 === 0`,而头 JSON 的长度是任意字节数
 * (`'沙漠'` 三个字节),直接用 `subarray()` 会当场 `RangeError`。
 */
function decodeChunk(raw: Uint8Array, cx: number, cy: number, index: number): ArchiveChunk {
  if (raw.byteLength < MIN_CHUNK_BYTES) {
    throw new Error(
      `WSA1 解码失败:第 ${index} 块 (${cx},${cy}) 只有 ${raw.byteLength} 字节,`
      + `连最小块体 ${MIN_CHUNK_BYTES} 字节都不到`,
    );
  }
  let c: Chunk;
  try {
    c = Chunk.deserializeSnapshot(raw);
  } catch (e) {
    throw new Error(
      `WSA1 解码失败:第 ${index} 块 (${cx},${cy}) 的地形字节解不开`
      + `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  let builtCells = 0;
  let roofCells = 0;
  for (let i = 0; i < c.cells.length; i += 1) {
    const roof = c.roofs[i];
    if (roof !== 0) roofCells += 1;
    if (roof !== 0) {
      builtCells += 1;
      continue;
    }
    const f = unpackTile(c.cells[i]);
    /* obj(家具/机关)与 wire(电路)都不是地形生成物 —— 只能由玩家造出来。 */
    if (f.obj !== 0 || f.wire !== 0) builtCells += 1;
  }
  let fluidCells = 0;
  for (let w = 0; w < DIRTY_WORDS; w += 1) {
    fluidCells += popcount32(c.wet[w]);
    fluidCells += popcount32(c.lava[w]);
  }
  const dirtyCells = Number.isFinite(c.dirtyCount) ? Math.max(0, Math.trunc(c.dirtyCount)) : 0;
  const tier = builtCells > 0 ? 2 : (fluidCells + dirtyCells > 0 ? 1 : 0);
  return {
    cx,
    cy,
    bytes: raw,
    byteLength: raw.byteLength,
    builtCells,
    roofCells,
    fluidCells,
    dirtyCells,
    tier,
    coordMismatch: c.cx !== cx || c.cy !== cy,
  };
}

/** 头里的 `trim` 扩展键(可选)。坏形状 ⇒ `null`(**不**把坏数据当「没裁过」之外的东西)。 */
function decodeTrimNote(v: unknown): ArchiveTrimReport | null {
  if (v === undefined || v === null) return null;
  const o = recordField(v, 'header.trim');
  return {
    budgetBytes: intField(o.budgetBytes, 'header.trim.budgetBytes'),
    originalBytes: intField(o.originalBytes, 'header.trim.originalBytes'),
    keptChunks: intField(o.keptChunks, 'header.trim.keptChunks'),
    droppedChunks: intField(o.droppedChunks, 'header.trim.droppedChunks'),
    droppedBytes: intField(o.droppedBytes, 'header.trim.droppedBytes'),
    rule: typeof o.rule === 'string' ? o.rule : '',
    reason: typeof o.reason === 'string' ? o.reason : '',
    /* 逐块清单不持久化(见 `ArchiveTrimReport.dropped`)。 */
    dropped: [],
  };
}

/**
 * `WSA1` 字节 → 结构化对象。**纯函数**,坏数据一律抛错(说清是哪个位置/字段)。
 *
 * 为什么坏数据必须抛而不是「尽力而为」:这份字节的唯一用途是**回滚**,
 * 回一半的世界比回不去更糟(玩家建筑静默消失,而回执说「已归档」)。
 */
export function decodeWorldArchive(input: Uint8Array | ArrayBuffer): DecodedWorldArchive {
  /* 归一化成 byteOffset=0 的独立视图:`DataView` 只吃真正的 ArrayBuffer,
     而调用方递进来的可能是 Node `Buffer`(有偏移的视图)。 */
  const bytes = toBytes(input);
  if (bytes.byteLength < PREFIX_BYTES + CHUNK_COUNT_BYTES) {
    throw new Error(
      `WSA1 解码失败:缓冲只有 ${bytes.byteLength} 字节,连 ${PREFIX_BYTES}+${CHUNK_COUNT_BYTES} 字节的前缀都不够`,
    );
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new Error(
        `WSA1 解码失败:第 ${i} 字节不是 magic '${WORLD_ARCHIVE_MAGIC}' 的一部分`
        + `(实得 0x${bytes[i].toString(16)})`,
      );
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== WORLD_ARCHIVE_FORMAT_VERSION) {
    throw new Error(`WSA1 解码失败:版本 ${version} 不认识(本文件只认 ${WORLD_ARCHIVE_FORMAT_VERSION})`);
  }
  const headerLen = dv.getUint32(8, true);
  const headerEnd = HEADER_START + headerLen;
  if (headerEnd + CHUNK_COUNT_BYTES > bytes.byteLength) {
    throw new Error(
      `WSA1 解码失败:头声明 ${headerLen} 字节(到 ${headerEnd}),`
      + `但缓冲只有 ${bytes.byteLength} 字节 —— 头长度本身越界`,
    );
  }
  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_START, headerEnd)));
  } catch (e) {
    throw new Error(`WSA1 解码失败:头不是合法 JSON(${e instanceof Error ? e.message : String(e)})`);
  }
  const header = recordField(headerRaw, 'header');
  if (intField(header.version, 'header.version') !== version) {
    throw new Error(
      `WSA1 解码失败:头里的 version(${String(header.version)})与 `
      + `[4,8) 的 uint32(${version})不一致 —— 这份字节是拼出来的`,
    );
  }

  const world: ArchiveWorldMeta = {
    roomId: strField(header.roomId, 'header.roomId'),
    seed: intField(header.seed, 'header.seed'),
    sizeCells: intField(header.sizeCells, 'header.sizeCells'),
    biome: strField(header.biome, 'header.biome'),
    frame: intField(header.frame, 'header.frame'),
    hourOfDay: numField(header.hourOfDay, 'header.hourOfDay'),
  };

  const players = arrayField(header.players, 'header.players').map((raw, i) => {
    const p = recordField(raw, `header.players[${i}]`);
    return {
      id: strField(p.id, `header.players[${i}].id`),
      x: numField(p.x, `header.players[${i}].x`),
      y: numField(p.y, `header.players[${i}].y`),
      z: numField(p.z, `header.players[${i}].z`),
      level: intField(p.level, `header.players[${i}].level`),
    };
  });
  const mobs = arrayField(header.mobs, 'header.mobs').map((raw, i) => {
    const m = recordField(raw, `header.mobs[${i}]`);
    return {
      id: strField(m.id, `header.mobs[${i}].id`),
      mobId: strField(m.mobId, `header.mobs[${i}].mobId`),
      x: numField(m.x, `header.mobs[${i}].x`),
      y: numField(m.y, `header.mobs[${i}].y`),
      z: numField(m.z, `header.mobs[${i}].z`),
      hp: numField(m.hp, `header.mobs[${i}].hp`),
      maxHp: numField(m.maxHp, `header.mobs[${i}].maxHp`),
    };
  });
  const ground = arrayField(header.ground, 'header.ground').map((raw, i) => {
    const g = recordField(raw, `header.ground[${i}]`);
    return {
      itemId: intField(g.itemId, `header.ground[${i}].itemId`),
      count: intField(g.count, `header.ground[${i}].count`),
      x: numField(g.x, `header.ground[${i}].x`),
      y: numField(g.y, `header.ground[${i}].y`),
    };
  });

  const table = arrayField(header.chunks, 'header.chunks');
  const chunkCount = dv.getUint32(headerEnd, true);
  if (chunkCount !== table.length) {
    throw new Error(
      `WSA1 解码失败:头里列了 ${table.length} 块,但 chunkCount 写的是 ${chunkCount}`,
    );
  }

  const warnings: string[] = [];
  const chunks: ArchiveChunk[] = [];
  let pos = headerEnd + CHUNK_COUNT_BYTES;
  for (let i = 0; i < chunkCount; i += 1) {
    const row = recordField(table[i], `header.chunks[${i}]`);
    const cx = intField(row.cx, `header.chunks[${i}].cx`);
    const cy = intField(row.cy, `header.chunks[${i}].cy`);
    const len = intField(row.bytes, `header.chunks[${i}].bytes`);
    if (len <= 0) throw new Error(`WSA1 解码失败:第 ${i} 块 (${cx},${cy}) 声明 ${len} 字节`);
    if (pos + len > bytes.byteLength) {
      throw new Error(
        `WSA1 解码失败:第 ${i} 块 (${cx},${cy}) 声明 ${len} 字节,但只剩 ${bytes.byteLength - pos} 字节 —— 快照被截断`,
      );
    }
    /* `slice` = 复制成独立缓冲(见 `decodeChunk` 的 4 字节对齐理由)。 */
    const chunk = decodeChunk(bytes.slice(pos, pos + len), cx, cy, i);
    if (chunk.coordMismatch) {
      warnings.push(`第 ${i} 块的块体自带坐标与头声明的不一致(头 ${cx},${cy})`);
    }
    chunks.push(chunk);
    pos += len;
  }
  const bodyBytes = pos - (headerEnd + CHUNK_COUNT_BYTES);
  if (pos !== bytes.byteLength) {
    throw new Error(
      `WSA1 解码失败:块体合计 ${bodyBytes} 字节,走到 ${pos};缓冲 ${bytes.byteLength} 字节`
      + `(多出 ${bytes.byteLength - pos} 字节的尾巴 —— 不是本格式)`,
    );
  }
  return {
    version,
    totalBytes: bytes.byteLength,
    headerBytes: headerLen,
    bodyBytes,
    world,
    players,
    mobs,
    ground,
    chunks,
    trim: decodeTrimNote(header.trim),
    warnings,
  };
}

/* ═══════════════════════ 4. 编码(裁剪要重新装回去) ═══════════════════════ */

/** 一块地形的**搬运载荷**(`bytes` 原样,不解不编)。 */
export interface WorldArchiveChunkPayload {
  cx: number;
  cy: number;
  bytes: Uint8Array;
}

export interface EncodeWorldArchiveInput {
  world: ArchiveWorldMeta;
  players: readonly ArchivePlayer[];
  mobs: readonly ArchiveMob[];
  ground: readonly ArchiveGroundItem[];
  chunks: readonly WorldArchiveChunkPayload[];
  /** 裁过才有(写进头里的 `trim` 扩展键)。 */
  trim?: ArchiveTrimReport | null;
}

/**
 * 结构化对象 → `WSA1` 字节。**与写入侧逐键同序**,所以对同一份解码结果
 * `encode(decode(x)) === x`(判据 1 的第二半)。
 *
 * 为什么键序要死守:那不是「风格」—— 逐字节可比是「归档前后是不是同一份世界」
 * 的判据基础(见 `describeWorldForArchive` 里那段对 `Map` 插入顺序的说明)。
 */
export function encodeWorldArchive(input: EncodeWorldArchiveInput): Uint8Array {
  const header: Record<string, unknown> = {
    version: WORLD_ARCHIVE_FORMAT_VERSION,
    roomId: input.world.roomId,
    seed: input.world.seed,
    sizeCells: input.world.sizeCells,
    biome: input.world.biome,
    frame: input.world.frame,
    hourOfDay: input.world.hourOfDay,
    players: input.players.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, level: p.level })),
    mobs: input.mobs.map((m) => ({
      id: m.id, mobId: m.mobId, x: m.x, y: m.y, z: m.z, hp: m.hp, maxHp: m.maxHp,
    })),
    ground: input.ground.map((g) => ({ itemId: g.itemId, count: g.count, x: g.x, y: g.y })),
    chunks: input.chunks.map((c) => ({ cx: c.cx, cy: c.cy, bytes: c.bytes.byteLength })),
  };
  if (input.trim !== undefined && input.trim !== null) {
    header.trim = {
      budgetBytes: input.trim.budgetBytes,
      originalBytes: input.trim.originalBytes,
      keptChunks: input.trim.keptChunks,
      droppedChunks: input.trim.droppedChunks,
      droppedBytes: input.trim.droppedBytes,
      rule: input.trim.rule,
      reason: input.trim.reason,
    };
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  let bodyBytes = 0;
  for (const c of input.chunks) {
    if (!(c.bytes instanceof Uint8Array) || c.bytes.byteLength === 0) {
      throw new Error(`WSA1 编码失败:块 (${c.cx},${c.cy}) 没有字节`);
    }
    bodyBytes += c.bytes.byteLength;
  }
  const out = new Uint8Array(
    PREFIX_BYTES + headerBytes.byteLength + CHUNK_COUNT_BYTES + bodyBytes,
  );
  const dv = new DataView(out.buffer);
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) out[i] = MAGIC_BYTES[i];
  dv.setUint32(4, WORLD_ARCHIVE_FORMAT_VERSION, true);
  dv.setUint32(8, headerBytes.byteLength, true);
  out.set(headerBytes, HEADER_START);
  let off = HEADER_START + headerBytes.byteLength;
  dv.setUint32(off, input.chunks.length, true);
  off += CHUNK_COUNT_BYTES;
  for (const c of input.chunks) {
    out.set(c.bytes, off);
    off += c.bytes.byteLength;
  }
  return out;
}

/* ═══════════════════════ 5. chunk 裁剪规则(纯函数) ═══════════════════════
 *
 * ## 规则本体(一句话)
 *
 * 「**玩家建造 > 活动(流体/脏位)> 原始地形**」:超预算时先扔掉**可由同 seed
 * 重建**的原始地形,再按上面的优先级能装几块装几块,装不下的裁掉并记账。
 *
 * ## 为什么这个规则是「可判定」的
 *
 * 三个判据全部来自**块体字节本身**(`obj`/`wire`/`roof`/`wet`/`lava`/`dirty` 位),
 * 没有一个来自「建造历史」「时间」「随机」:
 *
 * ``` 
 * tier = 2  有 obj/wire/roof ⇒ 玩家作品,seed 重建不出来 ⇒ 最值得留
 *        1  有流体台账或脏位   ⇒ 说明这块正在发生什么 ⇒ 次之
 *        0  什么都没有         ⇒ 原始地形,同 seed 可重建 ⇒ 超预算时**不花字节**
 * 同 tier 内:builtCells 多者先、roofCells 多者先、活动位多者先、
 *             最后按 (cy, cx) 升序 —— 全序,任何机器上结果一致。
 * ```
 *
 * ## 三条**不许**的写法(每条都对应一个真实缺陷形态)
 *
 * 1 **不许静默截断**:`slice(0, budget)` 会切碎块体 ⇒ 解出来是坏地形。裁的
 *    单位只有**整块**,且被裁的块必须进 `dropped` 列表 + 说清原因。
 * 2 **不许随机 / 不许按 Map 插入顺序**:那会让同一世界在两次归档里裁出两种
 *    结果,「回滚到这一版」就不再可复现。
 * 3 **不许为了「看起来完整」而保留一块只装了一半的块**:块是原子单位。
 */

/** 裁剪计划(纯数据)。 */
export interface ChunkTrimPlan {
  /** 保留的块(**按 `(cy, cx)` 升序**,与写入侧的块序一致)。 */
  kept: ArchiveChunk[];
  /** 被裁的块。 */
  dropped: ArchiveTrimDroppedChunk[];
  /** 保留块体合计字节。 */
  keptBytes: number;
  /** 被裁块体合计字节。 */
  droppedBytes: number;
  /** 输入块体合计字节。 */
  totalBytes: number;
  /** 本次裁剪的块体预算(不含头/玩家/生物/掉落的固定开销)。 */
  budgetBytes: number;
  /** 保留集是否装进预算(单块比预算还大 ⇒ `false`)。 */
  fits: boolean;
  /** 人类可读的原因。 */
  reason: string;
}

/** 按 `(cy, cx)` 升序:写入侧的块序,也是「逐字节可比」的一部分。 */
function byCoords(a: { cy: number; cx: number }, b: { cy: number; cx: number }): number {
  return (a.cy - b.cy) || (a.cx - b.cx);
}

/**
 * 优先级比较:`> 0` ⇒ `a` **更值得留**(裁的时候先裁 `b`)。
 *
 * 导出它是为了让「规则可判定」这句话能被**单独测**(判据 2 的一半):
 * 比较函数是纯的、全序的(坐标唯一),不依赖输入顺序。
 */
export function compareChunkPriority(a: ArchiveChunk, b: ArchiveChunk): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.builtCells !== b.builtCells) return a.builtCells - b.builtCells;
  if (a.roofCells !== b.roofCells) return a.roofCells - b.roofCells;
  const actA = a.fluidCells + a.dirtyCells;
  const actB = b.fluidCells + b.dirtyCells;
  if (actA !== actB) return actA - actB;
  /* 同级同分 ⇒ 按坐标**降序**定序(于是「先留」的是 `(cy,cx)` 小的那块,
     与写入侧块序一致)。这一步只为**全序**,不代表任何空间价值判断。 */
  return -((a.cy - b.cy) || (a.cx - b.cx));
}

function countByReason(dropped: readonly ArchiveTrimDroppedChunk[], prefix: string): number {
  let n = 0;
  for (const d of dropped) if (d.reason.startsWith(prefix)) n += 1;
  return n;
}

/** 「为什么裁」的**唯一**措辞点(计划与最终回执共用,免得两处数字漂移)。 */
function trimReason(args: {
  totalBytes: number;
  budgetBytes: number;
  kept: number;
  dropped: readonly ArchiveTrimDroppedChunk[];
  droppedBytes: number;
}): string {
  const regen = countByReason(args.dropped, 'regenerable');
  const budget = countByReason(args.dropped, 'budget');
  return (
    `超预算:地形 ${args.totalBytes} 字节 > 块体预算 ${args.budgetBytes} 字节`
    + ` ⇒ 按「玩家建造 > 活动(流体/脏位)> 原始地形(同 seed 可重建)」裁剪:`
    + `保留 ${args.kept} 块,裁掉 ${args.dropped.length} 块(${args.droppedBytes} 字节)`
    + ` = 原始地形 ${regen} 块 + 优先级已占满预算 ${budget} 块。`
    + '⚠️ 被裁的块**不在归档里**,回滚时不会伪造;原始地形可用同一 seed 重建,'
    + '玩家建造(物体/电路/屋顶)不可重建。'
  );
}

/**
 * **裁剪规则本体**:块列表 + 块体预算 → 保留集 / 被裁集 / 原因。纯函数。
 *
 * 预算足够时**一块都不裁**(判据 2 的前半:「小世界全留」),原因也如实写
 * 「预算足够」而不是留空 —— 空原因会让回执看起来像「没跑过规则」。
 */
export function planChunkTrim(
  chunks: readonly ArchiveChunk[],
  budgetBytes: number,
): ChunkTrimPlan {
  const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, Math.trunc(budgetBytes)) : 0;
  const sortedByCoords = chunks.slice().sort(byCoords);
  if (totalBytes <= budget) {
    return {
      kept: sortedByCoords,
      dropped: [],
      keptBytes: totalBytes,
      droppedBytes: 0,
      totalBytes,
      budgetBytes: budget,
      fits: true,
      reason: `预算足够:地形 ${totalBytes} 字节 ≤ 块体预算 ${budget} 字节 ⇒ ${chunks.length} 块全部保留(不裁剪)`,
    };
  }
  /* 优先级**降序** = 「先装的顺序」。 */
  const order = chunks.slice().sort((a, b) => compareChunkPriority(b, a));
  const kept: ArchiveChunk[] = [];
  const dropped: ArchiveTrimDroppedChunk[] = [];
  let keptBytes = 0;
  let droppedBytes = 0;
  for (const c of order) {
    if (c.tier === 0) {
      /* 原始地形:超预算时**一律**不花字节(哪怕还装得下,也要先让位给
         玩家建造 —— 否则「装得下就先放」会让后面的建造块被裁)。 */
      dropped.push({ cx: c.cx, cy: c.cy, bytes: c.byteLength, reason: 'regenerable(原始地形,同 seed 可重建)' });
      droppedBytes += c.byteLength;
      continue;
    }
    if (keptBytes + c.byteLength <= budget) {
      kept.push(c);
      keptBytes += c.byteLength;
      continue;
    }
    dropped.push({ cx: c.cx, cy: c.cy, bytes: c.byteLength, reason: 'budget(优先级更高的块已占满预算)' });
    droppedBytes += c.byteLength;
  }
  kept.sort(byCoords);
  dropped.sort(byCoords);
  return {
    kept,
    dropped,
    keptBytes,
    droppedBytes,
    totalBytes,
    budgetBytes: budget,
    fits: keptBytes <= budget,
    reason: trimReason({
      totalBytes,
      budgetBytes: budget,
      kept: kept.length,
      dropped,
      droppedBytes,
    }),
  };
}
/* ═══════════════════ 6. 装进上限:解码 → 裁剪 → 重新编码 ═══════════════════
 *
 * ## 这一步解决的就是「大世界归档直接抛错」
 *
 * 原来的写入侧只有一道**拒绝**:`snapshot.byteLength > 1 MiB` ⇒ 抛
 * (`archive: null` + `archiveError`,世界照样重建)。D-19 第 5 条之后,超限
 * 走**裁剪**而不是拒绝,但「裁剪」必须守住三件事:
 *
 * 1 **写进去的字节数 ≤ 上限**(逐字节可判,不是「大概」);
 * 2 **裁了什么、为什么**必须能报出来(回执 + 快照头里的 `trim`);
 * 3 **裁不出来就如实失败**:连「一块地形都不留」都装不进上限 ⇒ 抛错,
 *    而不是写一份半截世界。
 *
 * ## 为什么要有「固定开销」这一步
 *
 * 块体预算 ≠ 字节上限:头 JSON(玩家/生物/掉落/块表)与 `trim` 摘要本身也占
 * 字节,而 `trim` 摘要里还有各计数 —— 它的**位数**取决于最终裁剪结果。
 * 所以先按「零块地形」量出固定开销,再给块体分预算,最后**反复校验**直到
 * 编码结果真的 ≤ 上限(多让一块)。循环一定有界:每次要么成立,要么少一块。
 */

/** `fitWorldArchive` 的结果。 */
export interface FitWorldArchiveResult {
  /** **要落库**的字节(没裁 ⇒ 就是入参本身,逐字节不变)。 */
  bytes: Uint8Array;
  /** 是否真的裁过。 */
  trimmed: boolean;
  /** 解码结果(裁没裁都有:调用方总要能看世界/玩家)。 */
  decoded: DecodedWorldArchive;
  /** 裁剪报告(`trimmed === false` ⇒ `null`)。 */
  report: ArchiveTrimReport | null;
}

/** 把「块表」换成空的再编码一次 = 不含地形的固定开销。 */
function fixedOverheadBytes(decoded: DecodedWorldArchive): number {
  return encodeWorldArchive({
    world: decoded.world,
    players: decoded.players,
    mobs: decoded.mobs,
    ground: decoded.ground,
    chunks: [],
  }).byteLength;
}

/** 优先级**最低**的保留块(超一点点时让掉它 —— 与规则同一把尺子)。 */
function lowestPriorityAmong(kept: readonly ArchiveChunk[]): ArchiveChunk {
  let worst = kept[0];
  for (const c of kept) {
    if (compareChunkPriority(c, worst) < 0) worst = c;
  }
  return worst;
}

/**
 * **把一份快照装进字节上限**:够小就原样返回;超了就按 §5 的规则裁块并重新
 * 装回去。纯函数(不碰库、不碰世界)。
 *
 * @param maxBytes 硬上限(生产是 `repo.ts:WORLD_ARCHIVE_MAX_BYTES` = 1 MiB)
 * @throws 解码失败(不是 `WSA1`)/ 连零块地形都装不下(如实失败,不写半截世界)
 */
export function fitWorldArchive(snapshot: Uint8Array, maxBytes: number): FitWorldArchiveResult {
  const decoded = decodeWorldArchive(snapshot);
  const max = Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : 0;
  if (max <= 0) throw new Error(`WSA1 裁剪失败:上限 ${maxBytes} 不是正数`);
  if (decoded.totalBytes <= max) {
    return { bytes: snapshot, trimmed: false, decoded, report: null };
  }
  const fixed = fixedOverheadBytes(decoded);
  if (fixed > max) {
    throw new Error(
      `WSA1 裁剪失败:即使一块地形都不留,固定部分(头/玩家/生物/掉落)仍 ${fixed} 字节`
      + ` > 上限 ${max} 字节 —— 缩短玩家/生物列表才能归档(不在这里替 owner 决定丢谁)`,
    );
  }
  const plan = planChunkTrim(decoded.chunks, max - fixed);
  let kept = plan.kept.slice();
  const dropped = plan.dropped.slice();
  for (;;) {
    const droppedBytes = dropped.reduce((n, d) => n + d.bytes, 0);
    const report: ArchiveTrimReport = {
      budgetBytes: max,
      originalBytes: decoded.totalBytes,
      keptChunks: kept.length,
      droppedChunks: dropped.length,
      droppedBytes,
      rule: TRIM_RULE_ID,
      reason: trimReason({
        totalBytes: decoded.bodyBytes,
        budgetBytes: max - fixed,
        kept: kept.length,
        dropped,
        droppedBytes,
      }),
      dropped: dropped.slice(),
    };
    const out = encodeWorldArchive({
      world: decoded.world,
      players: decoded.players,
      mobs: decoded.mobs,
      ground: decoded.ground,
      chunks: kept,
      trim: report,
    });
    if (out.byteLength <= max) {
      return { bytes: out, trimmed: true, decoded, report };
    }
    if (kept.length === 0) {
      throw new Error(
        `WSA1 裁剪失败:裁掉全部 ${decoded.chunks.length} 块地形后仍 ${out.byteLength} 字节`
        + ` > 上限 ${max} 字节(头里的玩家/生物/掉落太长)`,
      );
    }
    /* `trim` 摘要自己也要占字节:让掉优先级最低的一块再量一次。 */
    const victim = lowestPriorityAmong(kept);
    kept = kept.filter((c) => c !== victim);
    dropped.push({
      cx: victim.cx,
      cy: victim.cy,
      bytes: victim.byteLength,
      reason: 'budget(摘要自身占字节,再让一块)',
    });
  }
}

/* ═══════════════════════ 7. 回滚计划(纯函数) ═══════════════════════
 *
 * ## 判据形态
 *
 * 「归档 → 解码 → 计划 → **按计划应用到一个空世界描述** ⟷ 归档前的描述逐字段
 *  相等」。三件事因此必须成立:
 *
 * 1 `planRestore` 是**纯函数**:同样输入 ⇒ 同样的计划,不改任何入参对象;
 * 2 `RestorePlan.ops` **自足**:只靠 ops 就能从「空世界」重建出旧世界
 *   (`current` 只影响 `changes` 里那几句可读的差异叙述,**不**影响 ops ——
 *    否则「重建」就依赖当前状态,回滚不再是纯函数);
 * 3 归档里**没有**的东西进 `unavailable`(玩家血量)或 `missingChunks`
 *    (被裁掉的地形块),**不许**编值。
 *
 * ## 为什么先出「计划」而不是直接改世界
 *
 * 直接改 `WorldSim` 需要先裁「回滚要不要也先归档当前世界」「算不算一次新的
 * `RESET_WORLD`」——D-06 只裁了归档,D-19 只裁了「完整回滚」的实现形态。
 * 计划层是可测的、可审的、可回放的中间产物;接不接世界是**下一步**的裁决,
 * 而 `world_sim.ts` 也不是本线能改的文件。
 */

/** 一块要还回去的地形(`bytes` 原样,应用时不解码 —— 搬运即还原)。 */
export interface RestoreChunk {
  cx: number;
  cy: number;
  bytes: Uint8Array;
}

/**
 * 「世界描述」—— 回滚的**目标形状**。
 *
 * 刻意与 `DecodedWorldArchive` 的字段**同名**:这样「归档前的描述」与
 * 「按计划重建出来的描述」可以逐字段比,而不必写一层翻译(翻译层本身
 * 就是漏字段的地方)。`emptyWorldState()` = 全零,是重建的起点。
 */
export interface RestoreWorldState {
  roomId: string;
  seed: number;
  sizeCells: number;
  biome: string;
  frame: number;
  hourOfDay: number;
  players: ArchivePlayer[];
  mobs: ArchiveMob[];
  ground: ArchiveGroundItem[];
  chunks: RestoreChunk[];
}

/** 重建的**空世界**(全零 + 空表)。每次返回新对象 —— 共享单例会被第一次应用污染。 */
export function emptyWorldState(): RestoreWorldState {
  return {
    roomId: '',
    seed: 0,
    sizeCells: 0,
    biome: '',
    frame: 0,
    hourOfDay: 0,
    players: [],
    mobs: [],
    ground: [],
    chunks: [],
  };
}

/**
 * 解码结果 → 「旧世界描述」(= 判据里那个**归档前的描述**)。
 *
 * 它不解码地形内容,只搬运块字节:回滚的判据是「逐位还回去」,不是
 * 「重新生成一份看起来一样的」。
 */
export function describeDecodedWorld(decoded: DecodedWorldArchive): RestoreWorldState {
  return {
    roomId: decoded.world.roomId,
    seed: decoded.world.seed,
    sizeCells: decoded.world.sizeCells,
    biome: decoded.world.biome,
    frame: decoded.world.frame,
    hourOfDay: decoded.world.hourOfDay,
    players: decoded.players.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, level: p.level })),
    mobs: decoded.mobs.map((m) => ({
      id: m.id, mobId: m.mobId, x: m.x, y: m.y, z: m.z, hp: m.hp, maxHp: m.maxHp,
    })),
    ground: decoded.ground.map((g) => ({ itemId: g.itemId, count: g.count, x: g.x, y: g.y })),
    chunks: decoded.chunks
      .slice()
      .sort(byCoords)
      .map((c) => ({ cx: c.cx, cy: c.cy, bytes: c.bytes })),
  };
}

/** 计划里的一条操作。`kind` 是**字符串字面量**(不是 enum —— 仓规禁 enum)。 */
export interface RestoreWorldOp {
  kind: 'world';
  roomId: string;
  seed: number;
  sizeCells: number;
  biome: string;
  frame: number;
  hourOfDay: number;
}

export interface RestorePlayerOp {
  kind: 'player';
  id: string;
  x: number;
  y: number;
  z: number;
  level: number;
}

export interface RestoreChunkOp {
  kind: 'chunk';
  cx: number;
  cy: number;
  bytes: Uint8Array;
}

export interface RestoreMobOp {
  kind: 'mob';
  id: string;
  mobId: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
}

export interface RestoreGroundOp {
  kind: 'ground';
  itemId: number;
  count: number;
  x: number;
  y: number;
}

export type RestoreOp =
  | RestoreWorldOp
  | RestorePlayerOp
  | RestoreChunkOp
  | RestoreMobOp
  | RestoreGroundOp;

/** 回滚计划(纯数据;**可直接断言、可序列化审阅**)。 */
export interface RestorePlan {
  /** 来源归档的摘要(审阅时一眼看出「回滚到哪一版」)。 */
  source: {
    roomId: string;
    seed: number;
    frame: number;
    hourOfDay: number;
    bytes: number;
    chunks: number;
    trimmed: boolean;
  };
  /** 操作清单(**自足**:从空世界按它走一遍就得到旧世界)。 */
  ops: RestoreOp[];
  /** 归档里**没有**、因此计划不会伪造的字段(说明到具体字段名)。 */
  unavailable: string[];
  /** 归档时被裁掉的地形块**数量**(取自快照头里的 `trim`;没裁过 = 0)。 */
  missingChunks: number;
  /** 被裁块的逐块清单(只在「刚裁完」的那份对象里非空;从库里读回时为空)。 */
  missing: ArchiveTrimDroppedChunk[];
  /** 与 `current` 的差异叙述(只影响可读性,**不**影响 ops)。 */
  changes: string[];
}

/**
 * 解码结果 + 当前世界描述 → **回滚计划**。纯函数。
 *
 * `current` 允许 `null`(「不知道现在是啥」)—— 计划照样成立,只是 `changes`
 * 里只有「按空世界重建」那一条。这让回滚可以发生在「当前状态已经没人记得」
 * 的最坏情况下,而那正是回滚最需要的时候。
 */
export function planRestore(
  snapshot: DecodedWorldArchive,
  current: RestoreWorldState | null,
): RestorePlan {
  const ops: RestoreOp[] = [];
  const changes: string[] = [];
  ops.push({
    kind: 'world',
    roomId: snapshot.world.roomId,
    seed: snapshot.world.seed,
    sizeCells: snapshot.world.sizeCells,
    biome: snapshot.world.biome,
    frame: snapshot.world.frame,
    hourOfDay: snapshot.world.hourOfDay,
  });
  for (const p of snapshot.players) {
    ops.push({ kind: 'player', id: p.id, x: p.x, y: p.y, z: p.z, level: p.level });
  }
  for (const c of snapshot.chunks.slice().sort(byCoords)) {
    ops.push({ kind: 'chunk', cx: c.cx, cy: c.cy, bytes: c.bytes });
  }
  for (const m of snapshot.mobs) {
    ops.push({
      kind: 'mob', id: m.id, mobId: m.mobId, x: m.x, y: m.y, z: m.z, hp: m.hp, maxHp: m.maxHp,
    });
  }
  for (const g of snapshot.ground) {
    ops.push({ kind: 'ground', itemId: g.itemId, count: g.count, x: g.x, y: g.y });
  }

  /* 差异叙述:只读 `current`,不参与 ops(见本节第 2 条判据)。 */
  if (current === null) {
    changes.push('没有当前世界描述:计划按「从空世界重建」给出(ops 自足,不依赖现状)');
  } else {
    if (current.seed !== snapshot.world.seed) {
      changes.push(`世界 seed:${current.seed} → ${snapshot.world.seed}`);
    }
    if (current.sizeCells !== snapshot.world.sizeCells || current.biome !== snapshot.world.biome) {
      changes.push(
        `世界身份:${current.sizeCells} 格/${current.biome} → ${snapshot.world.sizeCells} 格/${snapshot.world.biome}`,
      );
    }
    if (current.frame !== snapshot.world.frame) {
      changes.push(`帧号:${current.frame} → ${snapshot.world.frame}`);
    }
    if (current.hourOfDay !== snapshot.world.hourOfDay) {
      changes.push(`钟点:${current.hourOfDay} → ${snapshot.world.hourOfDay}`);
    }
    const nowPlayers = new Map(current.players.map((p) => [p.id, p] as const));
    for (const p of snapshot.players) {
      const now = nowPlayers.get(p.id);
      if (now === undefined) {
        changes.push(`玩家 ${p.id}:当前世界没有 ⇒ 回到 (${p.x}, ${p.y}, ${p.z}) 等级 ${p.level}`);
        continue;
      }
      if (now.x !== p.x || now.y !== p.y || now.z !== p.z) {
        changes.push(`玩家 ${p.id} 位置:(${now.x}, ${now.y}, ${now.z}) → (${p.x}, ${p.y}, ${p.z})`);
      }
      if (now.level !== p.level) changes.push(`玩家 ${p.id} 等级:${now.level} → ${p.level}`);
    }
    const nowChunks = new Set(current.chunks.map((c) => `${c.cy}:${c.cx}`));
    let overwrite = 0;
    for (const c of snapshot.chunks) if (nowChunks.has(`${c.cy}:${c.cx}`)) overwrite += 1;
    if (overwrite > 0) {
      changes.push(
        `地形:覆盖 ${overwrite} 块现有 chunk(其余 ${snapshot.chunks.length - overwrite} 块是新增)`,
      );
    }
    if (current.chunks.length > snapshot.chunks.length) {
      changes.push(
        `地形:当前 ${current.chunks.length} 块 > 归档 ${snapshot.chunks.length} 块 ⇒`
        + '多出来的块由「重建」清掉(归档里没有它们)',
      );
    }
    if (current.mobs.length !== snapshot.mobs.length) {
      changes.push(`生物:${current.mobs.length} → ${snapshot.mobs.length}`);
    }
    if (current.ground.length !== snapshot.ground.length) {
      changes.push(`地面掉落:${current.ground.length} → ${snapshot.ground.length}`);
    }
  }

  const trim = snapshot.trim;
  const missingChunks = trim === null ? 0 : Math.max(0, Math.trunc(trim.droppedChunks));
  const unavailable: string[] = [];
  if (snapshot.players.length > 0) {
    unavailable.push(
      'players[].hp:WSA1 v1 的头里**没有血量**(只有 id/x/y/z/level)⇒ 计划只还原位置与等级,'
      + '血量由宿主按登记重置(不在这里编一个 100)',
    );
  }
  if (trim !== null && missingChunks > 0) {
    const avg = Math.round(trim.droppedBytes / missingChunks);
    unavailable.push(
      `chunks:归档时已裁掉 ${missingChunks} 块(合计 ${trim.droppedBytes} 字节,平均 ${avg} 字节/块)`
      + ' ⇒ 这些块**没有**字节,计划不会伪造;原始地形可由 seed 重建,玩家建造部分不可回滚',
    );
  }
  return {
    source: {
      roomId: snapshot.world.roomId,
      seed: snapshot.world.seed,
      frame: snapshot.world.frame,
      hourOfDay: snapshot.world.hourOfDay,
      bytes: snapshot.totalBytes,
      chunks: snapshot.chunks.length,
      trimmed: trim !== null,
    },
    ops,
    unavailable,
    missingChunks,
    missing: trim === null ? [] : trim.dropped.slice(),
    changes,
  };
}

/**
 * **按计划重建**:把「空世界描述」走成旧世界描述。纯函数(不改 `plan`)。
 *
 * 刻意**不**接受「往现有状态上叠加」:叠加会让「归档里没有的块」留着,而那
 * 正好是回滚要清掉的东西。每次从 `emptyWorldState()` 起,所以同一份计划应用
 * 两次得到同样的结果。
 */
export function applyRestorePlan(plan: RestorePlan): RestoreWorldState {
  const out = emptyWorldState();
  for (const op of plan.ops) {
    if (op.kind === 'world') {
      out.roomId = op.roomId;
      out.seed = op.seed;
      out.sizeCells = op.sizeCells;
      out.biome = op.biome;
      out.frame = op.frame;
      out.hourOfDay = op.hourOfDay;
      continue;
    }
    if (op.kind === 'player') {
      out.players.push({ id: op.id, x: op.x, y: op.y, z: op.z, level: op.level });
      continue;
    }
    if (op.kind === 'chunk') {
      out.chunks.push({ cx: op.cx, cy: op.cy, bytes: op.bytes });
      continue;
    }
    if (op.kind === 'mob') {
      out.mobs.push({
        id: op.id, mobId: op.mobId, x: op.x, y: op.y, z: op.z, hp: op.hp, maxHp: op.maxHp,
      });
      continue;
    }
    out.ground.push({ itemId: op.itemId, count: op.count, x: op.x, y: op.y });
  }
  out.chunks.sort(byCoords);
  return out;
}

/**
 * 两个世界描述的**逐字段**比较结果:空数组 = 相等。
 *
 * 导出它是为了让判据能用**同一把尺子**(而不是在测试里手写 `JSON.stringify`,
 * 那会漏掉 `Uint8Array` 与字段顺序这两件事)。字段是逐项点名的 —— 加字段
 * 忘了比较会立刻红,而不是静默放过。
 */
export function diffWorldState(a: RestoreWorldState, b: RestoreWorldState): string[] {
  const out: string[] = [];
  if (a.roomId !== b.roomId) out.push(`roomId:${a.roomId}≠${b.roomId}`);
  if (a.seed !== b.seed) out.push(`seed:${a.seed}≠${b.seed}`);
  if (a.sizeCells !== b.sizeCells) out.push(`sizeCells:${a.sizeCells}≠${b.sizeCells}`);
  if (a.biome !== b.biome) out.push(`biome:${a.biome}≠${b.biome}`);
  if (a.frame !== b.frame) out.push(`frame:${a.frame}≠${b.frame}`);
  if (a.hourOfDay !== b.hourOfDay) out.push(`hourOfDay:${a.hourOfDay}≠${b.hourOfDay}`);
  if (a.players.length !== b.players.length) {
    out.push(`players.length:${a.players.length}≠${b.players.length}`);
  } else {
    for (let i = 0; i < a.players.length; i += 1) {
      const p = a.players[i];
      const q = b.players[i];
      if (
        p.id !== q.id || p.x !== q.x || p.y !== q.y || p.z !== q.z || p.level !== q.level
      ) {
        out.push(`players[${i}]:${JSON.stringify(p)}≠${JSON.stringify(q)}`);
      }
    }
  }
  if (a.mobs.length !== b.mobs.length) {
    out.push(`mobs.length:${a.mobs.length}≠${b.mobs.length}`);
  } else {
    for (let i = 0; i < a.mobs.length; i += 1) {
      if (JSON.stringify(a.mobs[i]) !== JSON.stringify(b.mobs[i])) {
        out.push(`mobs[${i}]:${JSON.stringify(a.mobs[i])}≠${JSON.stringify(b.mobs[i])}`);
      }
    }
  }
  if (a.ground.length !== b.ground.length) {
    out.push(`ground.length:${a.ground.length}≠${b.ground.length}`);
  } else {
    for (let i = 0; i < a.ground.length; i += 1) {
      if (JSON.stringify(a.ground[i]) !== JSON.stringify(b.ground[i])) {
        out.push(`ground[${i}]:${JSON.stringify(a.ground[i])}≠${JSON.stringify(b.ground[i])}`);
      }
    }
  }
  if (a.chunks.length !== b.chunks.length) {
    out.push(`chunks.length:${a.chunks.length}≠${b.chunks.length}`);
  } else {
    for (let i = 0; i < a.chunks.length; i += 1) {
      const x = a.chunks[i];
      const y = b.chunks[i];
      if (x.cx !== y.cx || x.cy !== y.cy) {
        out.push(`chunks[${i}] 坐标:(${x.cx},${x.cy})≠(${y.cx},${y.cy})`);
        continue;
      }
      if (x.bytes.byteLength !== y.bytes.byteLength) {
        out.push(`chunks[${i}] 字节数:${x.bytes.byteLength}≠${y.bytes.byteLength}`);
        continue;
      }
      for (let k = 0; k < x.bytes.byteLength; k += 1) {
        if (x.bytes[k] !== y.bytes[k]) {
          out.push(`chunks[${i}] 第 ${k} 字节不同`);
          break;
        }
      }
    }
  }
  return out;
}