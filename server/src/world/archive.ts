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
 * ## 头有**两个版本**,解码器两个都收(判据见 `tests/WS-FND-80`)
 *
 * | 版本 | 头里多什么 | 读不到时怎么办 |
 * | :--- | :--- | :--- |
 * | **v1** | 玩家只有 `id/x/y/z/level`;没有流体水位 | 这两项按**不可用**处理:`ArchivePlayer.hp === undefined` / `fluid === null`;回滚计划把它们列进 `unavailable`,**不抛错、不编值** |
 * | **v2**(本文件默认写出的) | `players[].hp` + `fluid`(非零水位格) | `hp` 在 v2 里是**必填语义**:缺 ⇒ 抛错(拿等级或满血值凑 = 「回滚」变成「顺手改血量」)。`fluid` 允许缺席(干旱世界 ⇒ 解码得 `null`) |
 *
 * `encode(decode(x)) === x` 对**两个版本**都逐字节成立 —— 为此编码器写哪个
 * 版本由**入参形状**决定(见 `resolveWriteVersion`):入参本身是 v1 形状就写
 * v1。否则「对一个 v1 解码结果重新编码」会凭空升版,往返当场不成立。
 *
 * ## 水位表有**自己的**预算(WS-FND-82,判据 `tests/WS-FND-82-archive-fluid-budget.test.ts`)
 *
 * 水位住在头里 ⇒ 计入**固定开销**;512×512 全湿是 262144 行(JSON ≈ 2MB)⇒
 * 固定开销自己就超 1 MiB。所以 §1 给了水位一条独立上限
 * (`FLUID_LEVELS_BUDGET_BYTES`),§5.5 是它的裁剪规则(amount 降序、同值 `(y,x)`
 * 升序,保留**前缀**),`fitWorldArchive` 先裁水位再给块体分预算。丢弃行数与原因
 * 写进头里的 `trim.fluidLevelsDropped` / `fluidReason`,并把「这些格的水位不可用」
 * 列进 `planRestore().unavailable` —— **绝不静默丢水**。
 *
 * ## 三处**刻意不做**的(边界,别当成已实现)
 *
 * 1 **不碰 `world_sim.ts`**:回滚只做到**计划层**(`RestorePlan` 是一份纯数据),
 *    把计划喂给 `WorldSim` 的接线没做 —— 那需要新裁决(回滚要不要先归档当前
 *    世界?)且那个文件是别人的。
 * 2 **不写库**:本文件不认识 `DbLike`。裁剪成字节之后**谁**去写由
 *    `db/repo.ts:archiveWorldSnapshot` 决定(它拿本文件的 `fitWorldArchive`)。
 * 3 **不为「缺字段」编值**:v1 头里没有 `hp` / `fluid` ⇒ 解码如实给
 *    `undefined` / `null`,回滚计划把缺口列进 `unavailable`。编一个 100 出来
 *    会让「回滚」变成「顺手改玩家血量」。写入侧**不许**反过来:声明 v2 却缺
 *    `hp`,或声明 v1 却带着 `hp`/`fluid`,`encodeWorldArchive` 一律抛错
 *    (默默丢掉调用方给的数据比抛错更糟)。
 */

import { Chunk, DIRTY_WORDS, popcount32, toBytes } from './chunk.ts';
import { CHUNK_BYTES, unpackTile } from '../../../shared/types/tile.ts';

/* ═══════════════════════ 1. 字节格式常量(写入侧的镜像) ═══════════════════════ */

/** magic `'WSA1'`(逐字节,不经 UTF-8 —— 理由见写入侧那行注释)。 */
export const WORLD_ARCHIVE_MAGIC = 'WSA1';

/**
 * **本文件默认写出**的格式版本:
 *   v2 = 头里多了 `players[].hp`(玩家血量)与 `fluid`(流体场水位)。
 * 裁剪**不升版**:`trim` 是头里一个可选扩展键(见 `encodeWorldArchive`)。
 */
export const WORLD_ARCHIVE_FORMAT_VERSION = 2;

/**
 * 仍然**可读**的最低版本。
 *
 * v1 的头里没有 `hp` / `fluid` ⇒ 这两项按「不可用」处理(`undefined` / `null`),
 * **不抛错、不编值**。这条常量存在的意义是把「读得回旧字节」写成可判的边界:
 * 版本区间之外(0 / 3 / …)一律抛错,而不是尽力猜。
 */
export const WORLD_ARCHIVE_MIN_READABLE_VERSION = 1;

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

/* ── 水位表的**独立**预算(WS-FND-82) ──
 *
 * ## 为什么水位不能和块体共用一套「装不下就裁」
 *
 * 块体预算 = `上限 - 固定开销`,而水位表**住在固定开销里**。512×512 全湿 ⇒ 262144
 * 行(JSON ≈ 2MB)⇒ 固定开销自己就超了 1 MiB ⇒ `fitWorldArchive` 只能**如实抛错**
 * (归档失败)。把水位塞进块体那个循环也不行:那个循环裁的单位是**整块地形**,
 * 裁不掉「一行水」。一行水只能按自己的尺子裁 ⇒ 给它一个**独立**上限,超了按
 * 可判定规则降采样并记账(**绝不静默丢水**)。
 *
 * ## 这个上限怎么来的(不是新发明的数字)
 *
 * 上限 = 库层单份快照的 blob 上限(`db/repo.ts:WORLD_ARCHIVE_MAX_BYTES` = 1048576)
 * 减去给头与块体留的预留:
 *
 * ```
 * ARCHIVE_BLOB_MAX_BYTES      1048576  与 repo 的 1 MiB 上限逐字节相同
 * CHUNK_BODY_RESERVE_BYTES     131072  房间地形上限 chunk_radius 4 ⇒ 9×9 = 81 块,
 *                                      每块 ≈ 1024(cells) + 96(位图) + 屋顶 RLE
 *                                      ≈ 1145 字节 ⇒ 81 × 1145 ≈ 92.7KB,取整 128KiB
 * FLUID_LEVELS_BUDGET_BYTES    917504  = 1048576 - 131072
 * ```
 *
 * 头里其余部分(世界世代 / 玩家 / 生物 / 掉落 / 块表)**不做预留**:它是按真实
 * 内容量出来的(`fixedOverheadBytes`),预留只会白丢水。
 *
 * ## 规则为什么「可判定」
 *
 * 按 `amount` 降序(值大的水更"重要":满格 1000 毫格的水洼 > 1 毫格的渗水),
 * 同值按 `(y, x)` 升序 —— 全序、不随机、不看插入顺序 ⇒ 同一份水位表在任何机器上
 * 裁出同一批行。保留集是这条优先级序的**前缀**(装不下的那一行之后一律丢):
 * 只有一条分界线,回执里一个数字就说得清;否则「哪些被裁」得逐行解释。
 */

/** 水位裁剪规则的名字(进 `trim.fluidRule`,机器可判)。 */
export const FLUID_LEVEL_TRIM_RULE_ID = 'amount>y>x';

/** 库层单份快照的字节上限 —— 与 `db/repo.ts:WORLD_ARCHIVE_MAX_BYTES` 同一个数。 */
const ARCHIVE_BLOB_MAX_BYTES = 1048576;

/** 给块体留的预留:81 块 × ≈1145 字节 ≈ 92.7KB,向上取整到 128 KiB(见本节头)。 */
const CHUNK_BODY_RESERVE_BYTES = 131072;

/** 水位表**自己能**用的字节上限(= blob 上限 - 块体预留)。 */
export const FLUID_LEVELS_BUDGET_BYTES = ARCHIVE_BLOB_MAX_BYTES - CHUNK_BODY_RESERVE_BYTES;

/**
 * `"fluid":{"width":512,"height":512,"levels":[…]}` 这层壳的字节数。
 * 实测一版是 40 字节左右(两个 3 位数 + 键名),取 64 留余量:
 * 预算按「行」算,壳不该吃行预算。
 */
const FLUID_FIELD_SHELL_BYTES = 64;

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

/**
 * 玩家世代:位置 + 等级(+ **v2 才有的血量**)。
 *
 * `hp` 是**可选**字段,这件事本身就是判据的一部分:
 *   - v2 头里有它 ⇒ 回滚还原血量;
 *   - v1 头里没有 ⇒ `undefined` = **不可用**,回滚计划把 `players[].hp` 写进
 *     `unavailable`,由宿主按登记重置 —— **不编一个 100**(编出来会让
 *     「回滚」变成「顺手改玩家血量」)。
 */
export interface ArchivePlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  level: number;
  /** v2:玩家血量(毫点级实数;v1 头里没有 ⇒ `undefined`)。 */
  hp?: number;
}

/**
 * 一格**水位**(毫格,`FluidField.amount` 的原值)。
 *
 * 只有**非零**的格才进表:「0 水位」与「不在表里」是同一件事(解码 = 未列出
 * 的格全 0),而干旱世界占了真实世界的大多数格 ⇒ 稀疏表几乎不花字节。
 */
export interface ArchiveFluidLevel {
  x: number;
  y: number;
  /** 毫格(正整数;1 满格 = 1000 毫格,见 `world/fluid.ts:CAP`)。 */
  amount: number;
}

/**
 * v2 头里的**流体场水位**(`WorldSim.fluid` 的 `amount` 数组)。
 *
 * ## 为什么是稀疏表而不是密度数组
 *
 * 512×512 的密度数组是 262144 个数(JSON 里 ~2MB),而归档的字节上限是
 * 1 MiB(`db/repo.ts:WORLD_ARCHIVE_MAX_BYTES`)—— 密集表会把「归档」变成
 * 「必然超限再被裁」,即水位永远存不下来。稀疏表 + **全序** = 同样的信息、
 * 可判定的字节。
 *
 * ## 键序/表序都是判据的一部分
 *
 * `levels` 必须按 `(y, x)` 升序且不重复(解码时校验):这样「同一份世界归档
 * 两次」得到逐字节相同的水位段,`encode(decode(x)) === x` 才有意义。
 */
export interface ArchiveFluidField {
  width: number;
  height: number;
  /** 非零水位格,**按 `(y, x)` 升序、不重复**。 */
  levels: ArchiveFluidLevel[];
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
  /**
   * 水位表被裁掉了几行(**只有裁过水位才写这组键** —— 没裁时它们的缺席
   * 就是「水位表完整」的证据,而不是「0 行」)。
   */
  fluidLevelsTotal?: number;
  fluidLevelsKept?: number;
  fluidLevelsDropped?: number;
  /** 水位表能用的字节预算(`FLUID_LEVELS_BUDGET_BYTES` 或按本次上限算出来的那份)。 */
  fluidBudgetBytes?: number;
  /** 水位裁剪的规则标识(`FLUID_LEVEL_TRIM_RULE_ID`),机器可判。 */
  fluidRule?: string;
  /** 水位为什么被裁(含保留 / 丢弃行数与「被裁的格不回滚」)。 */
  fluidReason?: string;
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
  /** v2 的流体场水位(v1 头里没有 ⇒ `null` = **不可用**,回滚不铺水位)。 */
  fluid: ArchiveFluidField | null;
  mobs: ArchiveMob[];
  ground: ArchiveGroundItem[];
  /** 地形 chunk 列表(**头里声明的顺序**;写入侧按 `(cy, cx)` 升序)。 */
  chunks: ArchiveChunk[];
  /**
   * 头里声明的「**裁剪前**总块数」(=`chunks.length + trim.droppedChunks`)。
   *
   * 旧字节(本字段出现之前写的)没有这个键 ⇒ 退化成 `chunks.length`
   * (那是**唯一**还能诚实说的话:再往下就只能信 `trim` 的自述了)。
   * 它不是装饰:`planRestore` 用它和 `chunks.length` **交叉核对**,
   * 于是「删掉几块 + 删掉 `trim` 键」不能再伪装成「一份完整的归档」。
   */
  chunksTotal: number;
  /**
   * 头里那条地形表校验和的核对结果:
   *   * `true` = 校验和存在且对得上;
   *   * `null` = 旧字节里没有校验和(**不可判**,不是「通过」)。
   * 对不上时解码直接抛错(fail-closed),所以 `false` 到不了这里。
   */
  chunksChecksumOk: boolean | null;
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

/**
 * 可选整数字段(裁剪摘要里**只有裁过才有**的那一组键):缺席 ⇒ `undefined`。
 * 给了就必须是整数 —— 坏数据照旧抛错,不「尽力读一部分」。
 */
function optionalIntField(v: unknown, where: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  return intField(v, where);
}

/** 可选字符串字段(同上)。缺席 ⇒ `undefined`(与「写了个空串」分得清)。 */
function optionalStrField(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 头里的 `trim` 扩展键(可选)。坏形状 ⇒ `null`(**不**把坏数据当「没裁过」之外的东西)。 */
function decodeTrimNote(v: unknown): ArchiveTrimReport | null {
  if (v === undefined || v === null) return null;
  const o = recordField(v, 'header.trim');
  /* 水位那组键**只在裁过水位时才有**:没裁 ⇒ `undefined`(键也不写回),
     「缺席」与「0 行」在字节层是两回事(见 `ArchiveTrimReport`)。 */
  return {
    budgetBytes: intField(o.budgetBytes, 'header.trim.budgetBytes'),
    originalBytes: intField(o.originalBytes, 'header.trim.originalBytes'),
    keptChunks: intField(o.keptChunks, 'header.trim.keptChunks'),
    droppedChunks: intField(o.droppedChunks, 'header.trim.droppedChunks'),
    droppedBytes: intField(o.droppedBytes, 'header.trim.droppedBytes'),
    rule: typeof o.rule === 'string' ? o.rule : '',
    reason: typeof o.reason === 'string' ? o.reason : '',
    fluidLevelsTotal: optionalIntField(o.fluidLevelsTotal, 'header.trim.fluidLevelsTotal'),
    fluidLevelsKept: optionalIntField(o.fluidLevelsKept, 'header.trim.fluidLevelsKept'),
    fluidLevelsDropped: optionalIntField(o.fluidLevelsDropped, 'header.trim.fluidLevelsDropped'),
    fluidBudgetBytes: optionalIntField(o.fluidBudgetBytes, 'header.trim.fluidBudgetBytes'),
    fluidRule: optionalStrField(o.fluidRule),
    fluidReason: optionalStrField(o.fluidReason),
    /* 逐块清单不持久化(见 `ArchiveTrimReport.dropped`)。 */
    dropped: [],
  };
}

/**
 * 地形表的**校验和**(FNV-1a 32 位,`fnv1a:xxxxxxxx`)。
 *
 * ## 为什么要它(审计 P1:摘要可自证清白)
 *
 * `trim` 是一段**自述**摘要 —— 它说「我裁了几块」。如果它是唯一口径,那么
 * 「删掉几块 + 顺手把 `trim` 键删掉」的字节看起来就是「一份从没裁过的完整归档」:
 * 摘要自己证明自己清白,`planRestore` 的 `missingChunks` 恒为 0。
 * 校验和把**头里那张块表**(`cx/cy/bytes` + `chunkCount`)**绑在一起**:
 * 表被改过 / 块被删过而校验和没跟着改 ⇒ `decodeWorldArchive` 当场抛错。
 *
 * 它挡的是**漂移 / 手改 / 半截写**,不是恶意伪造(没有密钥,能改字节的人
 * 也能重算校验和)。所以 `planRestore` 还有第二道:拿头里声明的
 * `chunksTotal` 与**实际块数**交叉核对(见 `planRestore` 的缺口计算)。
 */
export function archiveChunksChecksum(
  rows: readonly { cx: number; cy: number; bytes: number }[],
  count: number,
  /** 头里那条 `chunksTotal`(**裁剪前**的总块数)。 */
  total: number,
): string {
  /* 规范文本:总块数 + 实际块数 + 每块 `cx,cy,字节数`(顺序**就是**头里的顺序 ——
     写入侧按 `(cy, cx)` 升序,所以同一份世界只有一种规范文本)。
     `total` 也进规范文本:否则「改小 `chunksTotal` + 删掉几块」就能让缺口归零,
     而校验和还认为一切正常。 */
  let text = `${total}|${count}|`;
  for (const r of rows) text += `${r.cx},${r.cy},${r.bytes};`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

/**
 * 头里的 `fluid` 扩展键(v2)。`undefined` / `null` ⇒ `null`(**不可用**,
 * 不编一个全零密度场)。
 *
 * ## 为什么要逐条校验,而且规则是**可判定的**
 *
 * 水位表的用途是「把液面还回去」,所以它必须是**全序、无重复、坐标在界内**:
 *   - 乱序 / 重复 ⇒ 「同一份世界归档两次」的字节可能不同(逐字节可比就废了);
 *   - 坐标越界 ⇒ 铺水位时静默写不进去(或写到别的格上);
 *   - `amount <= 0` ⇒ 与「不在表里」重复表达同一件事,白吃字节。
 * 这三条都在这里抛错(说清第几条),而不是「尽力读一部分」。
 */
function decodeFluidField(v: unknown): ArchiveFluidField | null {
  if (v === undefined || v === null) return null;
  const o = recordField(v, 'header.fluid');
  const width = intField(o.width, 'header.fluid.width');
  const height = intField(o.height, 'header.fluid.height');
  if (width <= 0 || height <= 0) {
    throw new Error(
      `WSA1 解码失败:header.fluid 的尺寸 ${width}×${height} 不是正数(水位场必须有界)`,
    );
  }
  const rows = arrayField(o.levels, 'header.fluid.levels');
  const levels: ArchiveFluidLevel[] = [];
  /* 上一个格的 `y * width + x`:用它判「升序且不重复」,不必造一张集合。 */
  let prevKey = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const where = `header.fluid.levels[${i}]`;
    const row = arrayField(rows[i], where);
    if (row.length !== 3) {
      throw new Error(
        `WSA1 解码失败:${where} 必须是 [x, y, amount] 三元组(实得 ${row.length} 项)`,
      );
    }
    const x = intField(row[0], `${where}[0](x)`);
    const y = intField(row[1], `${where}[1](y)`);
    const amount = intField(row[2], `${where}[2](amount)`);
    if (x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error(
        `WSA1 解码失败:${where} 的坐标 (${x},${y}) 在 ${width}×${height} 水位场之外`,
      );
    }
    if (amount <= 0) {
      throw new Error(
        `WSA1 解码失败:${where} 的水位 ${amount} 不是正数`
        + '(0 水位与「不在表里」是同一件事,不该进表)',
      );
    }
    const key = y * width + x;
    if (key <= prevKey) {
      throw new Error(
        `WSA1 解码失败:${where} 的坐标 (${x},${y}) 破坏了 (y, x) 升序/唯一性`
        + `(前一格 key=${prevKey},本格 key=${key})—— 水位表必须是全序`,
      );
    }
    prevKey = key;
    levels.push({ x, y, amount });
  }
  return { width, height, levels };
}

/** 水位场的**深拷贝**(回滚计划/世界描述不许与解码结果共用同一批数组)。 */
function copyFluidField(f: ArchiveFluidField | null): ArchiveFluidField | null {
  if (f === null) return null;
  return {
    width: f.width,
    height: f.height,
    levels: f.levels.map((l) => ({ x: l.x, y: l.y, amount: l.amount })),
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
  /* ★ 版本区间而不是「等于当前版本」:v1 的字节必须**仍然读得回**
     (老归档、老测试夹具里都是 v1)。区间外的版本才是坏数据。 */
  if (
    !Number.isInteger(version)
    || version < WORLD_ARCHIVE_MIN_READABLE_VERSION
    || version > WORLD_ARCHIVE_FORMAT_VERSION
  ) {
    throw new Error(
      `WSA1 解码失败:版本 ${version} 不认识(本文件读 `
      + `${WORLD_ARCHIVE_MIN_READABLE_VERSION}~${WORLD_ARCHIVE_FORMAT_VERSION},`
      + `写 ${WORLD_ARCHIVE_FORMAT_VERSION})`,
    );
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
  const headerVersion = intField(header.version, 'header.version');
  if (headerVersion !== version) {
    throw new Error(
      `WSA1 解码失败:头里的 version(${headerVersion})与 [4,8) 的 uint32 版本号`
      + `(${version})不一致 —— 这份字节是拼出来的`,
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

  /* 告警收集器必须在**玩家**之前声明:v1 头里出现 v2 才有的字段(hp / fluid)
     是非致命异常,要报出来(语义见 `DecodedWorldArchive.warnings`)。 */
  const warnings: string[] = [];
  const players: ArchivePlayer[] = arrayField(header.players, 'header.players').map((raw, i) => {
    const p = recordField(raw, `header.players[${i}]`);
    const out: ArchivePlayer = {
      id: strField(p.id, `header.players[${i}].id`),
      x: numField(p.x, `header.players[${i}].x`),
      y: numField(p.y, `header.players[${i}].y`),
      z: numField(p.z, `header.players[${i}].z`),
      level: intField(p.level, `header.players[${i}].level`),
    };
    if (version >= 2) {
      /* ★ v2 里 `hp` 是**必填语义**:缺席就抛错 —— 不拿等级或满血值凑一个,
         那会把「回滚」变成「顺手改玩家血量」(见文件头 §1 表格)。 */
      out.hp = numField(p.hp, `header.players[${i}].hp(v2 头里必填)`);
      if (out.hp < 0) {
        throw new Error(
          `WSA1 解码失败:header.players[${i}].hp 是 ${out.hp} —— 血量不能是负数`,
        );
      }
    } else if (p.hp !== undefined) {
      warnings.push(
        `header.players[${i}].hp 是 v2 才有的字段,但头版本是 v1 ⇒ 按**不可用**处理(不读它)`,
      );
    }
    return out;
  });
  /* ★ v2 的流体水位:v1 头里没有 ⇒ `null`;v2 也允许缺席(干旱世界 ⇒ `null`)。
     两种情况都不编一个全零密度场 —— 那会让「不可用」看起来像「已还原」。 */
  const fluid = version >= 2 ? decodeFluidField(header.fluid) : null;
  if (version < 2 && header.fluid !== undefined && header.fluid !== null) {
    warnings.push('header.fluid 是 v2 才有的字段,但头版本是 v1 ⇒ 按**不可用**处理(不读它)');
  }
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
  /* ★ 第二道防线(审计 P1):头里声明的**裁剪前总块数** + 地形表校验和。
     两者都不是「正文之外的一句自述」—— 前者与 `chunks.length` 交叉核对,
     后者把头里那张块表与 `chunkCount` 绑死。拦的是「删块 + 删摘要」这种
     看起来像「未裁剪完整归档」的字节(见 `archiveChunksChecksum`)。 */
  const descriptors = table.map((raw, i) => {
    const row = recordField(raw, `header.chunks[${i}]`);
    return {
      cx: intField(row.cx, `header.chunks[${i}].cx`),
      cy: intField(row.cy, `header.chunks[${i}].cy`),
      bytes: intField(row.bytes, `header.chunks[${i}].bytes`),
    };
  });
  const declaredTotal = optionalIntField(header.chunksTotal, 'header.chunksTotal');
  const chunksTotal = declaredTotal === undefined ? chunkCount : declaredTotal;
  if (chunksTotal < chunkCount) {
    throw new Error(
      `WSA1 解码失败:头里声明的总块数 ${chunksTotal} 比实际块数 ${chunkCount} 还少`
      + ' —— 头自相矛盾(总块数不可能小于留下的块数)',
    );
  }
  /* 校验和:有就核对(对不上 ⇒ 抛),没有(旧字节)⇒ `null` = **不可判**。
     「不可判」与「通过」在 `DecodedWorldArchive` 里是两个值,不合并。 */
  let chunksChecksumOk: boolean | null = null;
  const rawChecksum = header.chunksChecksum;
  if (typeof rawChecksum === 'string' && rawChecksum.length > 0) {
    if (declaredTotal === undefined) {
      throw new Error(
        'WSA1 解码失败:头里有地形表校验和,却没有 `chunksTotal` —— '
        + '两者必须同时存在(只留一个,等于把「校验的是谁」这件事留白)',
      );
    }
    const expected = archiveChunksChecksum(descriptors, chunkCount, chunksTotal);
    if (rawChecksum !== expected) {
      throw new Error(
        `WSA1 解码失败:地形表校验和对不上(头里 ${rawChecksum},`
        + `按块表+总块数算出 ${expected})—— 块表 / 总块数被改过,这份归档不能用来回滚`,
      );
    }
    chunksChecksumOk = true;
  }

  const chunks: ArchiveChunk[] = [];
  let pos = headerEnd + CHUNK_COUNT_BYTES;
  for (let i = 0; i < chunkCount; i += 1) {
    const { cx, cy, bytes: len } = descriptors[i];
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
    fluid,
    mobs,
    ground,
    chunks,
    /* ★ 交叉核对用的两个口径(见 `DecodedWorldArchive.chunksTotal`)。
       `chunksTotal` 缺席(旧字节)时等于实际块数 —— 那是能说出的**最保守**的话。 */
    chunksTotal,
    chunksChecksumOk,
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
  /**
   * 头版本(1 或 2)。**省略时按入参形状推断**(见 `resolveWriteVersion`):
   *   - 给了 `fluid`,或任一玩家带 `hp` ⇒ 写 **v2**(= 本文件默认方向);
   *   - 入参本身就是 v1 形状(无 `fluid`、玩家无 `hp`)⇒ 写 **v1**。
   *
   * 为什么不写成一个永远 v2 的默认值:「`encode(decode(x)) === x` 对**两个
   * 版本**都逐字节成立」是回滚判据的基础,而对一个 v1 解码结果重新编码时,
   * 写 v2 会凭空升版(前缀 4 字节 + 头里的 version 都变),往返当场不成立。
   */
  version?: number;
  world: ArchiveWorldMeta;
  players: readonly ArchivePlayer[];
  /** v2:流体场水位。`undefined` / `null` ⇒ **不写这个键**(v1 头里没有它)。 */
  fluid?: ArchiveFluidField | null;
  mobs: readonly ArchiveMob[];
  ground: readonly ArchiveGroundItem[];
  chunks: readonly WorldArchiveChunkPayload[];
  /** 裁过才有(写进头里的 `trim` 扩展键)。 */
  trim?: ArchiveTrimReport | null;
}

/**
 * 水位表写成**全序**(按 `(y, x)` 升序,与解码器的校验同一把尺子),并挡住
 * 三种坏入参(非整数 / 非正数 / 同一格两次)。
 *
 * 为什么编码侧要**排序**而不是「调用方自己按序给」:排序让「同一份水位」只有
 * 一种字节形态(两次归档逐字节可比);而不校验非正整数会让
 * `amount: 0` 这类「等价于缺席」的行白吃预算 —— 归档的字节上限是 1 MiB,
 * 每一行的意义都必须能说清。
 */
function canonicalLevels(levels: readonly ArchiveFluidLevel[]): ArchiveFluidLevel[] {
  const rows = levels.slice();
  for (const l of rows) {
    if (!Number.isInteger(l.amount) || l.amount <= 0) {
      throw new Error(
        `WSA1 编码失败:水位 (${l.x},${l.y}) 的 amount 必须是正整数(实得 ${String(l.amount)})`
        + ' —— 0 水位与「不在表里」是同一件事,不该进表',
      );
    }
  }
  rows.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].y === rows[i - 1].y && rows[i].x === rows[i - 1].x) {
      throw new Error(
        `WSA1 编码失败:水位表里 (${rows[i].x},${rows[i].y}) 出现了两次(一格只有一个水位)`,
      );
    }
  }
  return rows;
}

/**
 * **写出哪个版本**:显式给 `version` 就用它;否则按「入参里有没有 v2 载荷」定。
 *
 * 两条**不许**的写法(与「不编值」同源,都在调用方那一侧):声明 v2 却缺
 * `hp`,或声明 v1 却带着 `hp` / `fluid` —— 两者都抛错而不是「凑一个」/「默默
 * 丢掉」。见 `encodeWorldArchive` 里的落实。
 */
function resolveWriteVersion(input: EncodeWorldArchiveInput): number {
  const declared = input.version;
  if (declared !== undefined) {
    if (declared !== 1 && declared !== 2) {
      throw new Error(
        `WSA1 编码失败:版本 ${String(declared)} 不是本文件支持的 1 / 2`
        + `(读得回的是 ${WORLD_ARCHIVE_MIN_READABLE_VERSION}~${WORLD_ARCHIVE_FORMAT_VERSION})`,
      );
    }
    return declared;
  }
  const hasFluid = input.fluid !== undefined && input.fluid !== null;
  const hasHp = input.players.some((p) => p.hp !== undefined);
  return hasFluid || hasHp ? 2 : 1;
}

/**
 * 结构化对象 → `WSA1` 字节。**与写入侧逐键同序**,所以对同一份解码结果
 * `encode(decode(x)) === x`(判据 1 的第二半;**两个版本**都成立)。
 *
 * 为什么键序要死守:那不是「风格」—— 逐字节可比是「归档前后是不是同一份世界」
 * 的判据基础(见 `describeWorldForArchive` 里那段对 `Map` 插入顺序的说明)。
 *
 * v2 的键序(写入侧必须同序):
 * `version, roomId, seed, sizeCells, biome, frame, hourOfDay, players,
 *  fluid, mobs, ground, chunks, [trim]`;玩家对象内是 `id, x, y, z, level, hp`。
 */
export function encodeWorldArchive(input: EncodeWorldArchiveInput): Uint8Array {
  const version = resolveWriteVersion(input);
  const fluid = input.fluid === undefined ? null : input.fluid;
  if (version === 1 && (fluid !== null || input.players.some((p) => p.hp !== undefined))) {
    throw new Error(
      'WSA1 编码失败:版本 1 的头里没有 players[].hp / fluid'
      + '(要带上它们就把 version 写成 2,或省略 version 让入参形状决定)'
      + ' —— 默默丢掉调用方给的数据比抛错更糟',
    );
  }
  if (version >= 2) {
    for (const p of input.players) {
      if (p.hp === undefined) {
        throw new Error(
          `WSA1 编码失败:v2 头里玩家 ${p.id} 没有 hp(v2 的 hp 是必填语义,不编值)`,
        );
      }
      if (!Number.isFinite(p.hp) || p.hp < 0) {
        throw new Error(
          `WSA1 编码失败:v2 头里玩家 ${p.id} 的 hp 必须是 ≥ 0 的有限数(实得 ${String(p.hp)})`,
        );
      }
    }
  }
  const header: Record<string, unknown> = {
    version,
    roomId: input.world.roomId,
    seed: input.world.seed,
    sizeCells: input.world.sizeCells,
    biome: input.world.biome,
    frame: input.world.frame,
    hourOfDay: input.world.hourOfDay,
    players: input.players.map((p) => (version >= 2
      ? { id: p.id, x: p.x, y: p.y, z: p.z, level: p.level, hp: p.hp }
      : { id: p.id, x: p.x, y: p.y, z: p.z, level: p.level })),
  };
  /* ★ `fluid` **紧跟** `players`(键序是逐字节可比的一部分)。
     用赋值而不是写进上面的字面量:键**缺席**与「写一个 null」在字节层是两回事,
     而 v1 头里根本没有这个键。 */
  if (fluid !== null) {
    header.fluid = {
      width: fluid.width,
      height: fluid.height,
      levels: canonicalLevels(fluid.levels).map((l) => [l.x, l.y, l.amount]),
    };
  }
  header.mobs = input.mobs.map((m) => ({
    id: m.id, mobId: m.mobId, x: m.x, y: m.y, z: m.z, hp: m.hp, maxHp: m.maxHp,
  }));
  header.ground = input.ground.map((g) => ({ itemId: g.itemId, count: g.count, x: g.x, y: g.y }));
  header.chunks = input.chunks.map((c) => ({ cx: c.cx, cy: c.cy, bytes: c.bytes.byteLength }));
  /* ★ 第二道防线的两个键(键序接在 `chunks` 之后;既有判据的键序断言
     `tests/WS-FND-80` / `-81` 只钉到 `chunks` 为止)。
       · `chunksTotal` = **裁剪前**的总块数。`trim` 自述「裁了几块」时,这个数是
         **另一份**口径:`planRestore` 拿它与**实际块数**交叉核对,于是「删块 + 删
         `trim`」不能再伪装成「从没裁过的完整归档」(审计 P1)。
       · `chunksChecksum` = 头里那张块表 + `chunkCount` 的校验和,改表不重算就抛。
     ⚠️ 两个键**只在写了 `trim` 时才写**:`trim` 是「这份快照被裁过」的唯一标记,
     也只有带着它的字节才可能被「删摘要」伪装。没裁过的快照必须与写入侧
     (`world_sim.ts:describeWorldForArchive`)**逐字节一致**(`encode(decode(x)) === x`
     是既有判据),凭空多两个键会当场把那条判据打红。
     两者都按**实际写入的块**算,不抄调用方的说法。 */
  if (input.trim !== undefined && input.trim !== null) {
    const chunksTotal = input.chunks.length + Math.max(0, Math.trunc(input.trim.droppedChunks));
    header.chunksTotal = chunksTotal;
    header.chunksChecksum = archiveChunksChecksum(
      input.chunks.map((c) => ({ cx: c.cx, cy: c.cy, bytes: c.bytes.byteLength })),
      input.chunks.length,
      chunksTotal,
    );
  }
  if (input.trim !== undefined && input.trim !== null) {
    const trim: Record<string, unknown> = {
      budgetBytes: input.trim.budgetBytes,
      originalBytes: input.trim.originalBytes,
      keptChunks: input.trim.keptChunks,
      droppedChunks: input.trim.droppedChunks,
      droppedBytes: input.trim.droppedBytes,
      rule: input.trim.rule,
      reason: input.trim.reason,
    };
    /* ★ 水位那组键**只在裁过水位时**写(键序接在 `reason` 之后 —— 不裁时一个字节
       都不多,`encode(decode(x)) === x` 与既有的裁剪字节全都原样保持)。
       用赋值而不是写进上面的字面量:键缺席与「写个 0」在字节层是两回事。 */
    const t = input.trim;
    if (t.fluidLevelsTotal !== undefined) trim.fluidLevelsTotal = t.fluidLevelsTotal;
    if (t.fluidLevelsKept !== undefined) trim.fluidLevelsKept = t.fluidLevelsKept;
    if (t.fluidLevelsDropped !== undefined) trim.fluidLevelsDropped = t.fluidLevelsDropped;
    if (t.fluidBudgetBytes !== undefined) trim.fluidBudgetBytes = t.fluidBudgetBytes;
    if (t.fluidRule !== undefined) trim.fluidRule = t.fluidRule;
    if (t.fluidReason !== undefined) trim.fluidReason = t.fluidReason;
    header.trim = trim;
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
  dv.setUint32(4, version, true);
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
/* ═══════════════════ 5.5 水位裁剪规则(纯函数,WS-FND-82) ═══════════════════
 *
 * ## 规则本体(一句话)
 *
 * 「**amount 大的水先留**,同值时 `(y, x)` 小的先留」;保留集是这条优先级序的
 * **前缀**,装不下的第一行之后一律丢。
 *
 * ## 为什么这条规则是「可判定」的
 *
 * - 判据只有 `amount` 与 `(y, x)`,都来自水位表本身(不是「看起来重要」、不是随机、
 *   不看 `Map` 插入顺序)⇒ 任何机器上裁出同一批行,`fitWorldArchive` 两次逐字节相同;
 * - 语义上也说得通:1000 毫格(满格)的水洼比 1 毫格的渗水更接近「水面」,而回滚一张
 *   水位表的目的是「把液面还回去」;
 * - **前缀**而不是「能塞就塞」:分界线只有一个数字,回执里说得清;否则「哪些被裁」
 *   要逐行解释,而逐行清单**不持久化**(见 `ArchiveTrimReport.dropped`)。
 *
 * ## 两条**不许**的写法
 *
 * 1 **不许静默丢**:丢了几行、原有多少、为什么,必须进 `trim`(头里)+ 回执;
 * 2 **不许把丢弃的格写成 0**:那与「已还原」看不出区别 —— 被裁的格就是**不在表里**,
 *   回滚计划会如实说「这些格的水位不可用」。
 */

/** 水位裁剪计划(纯数据)。 */
export interface FluidLevelTrimPlan {
  /** 保留的行(**按 `(y, x)` 升序**,即编码侧的规范序)。 */
  kept: ArchiveFluidLevel[];
  totalRows: number;
  keptRows: number;
  droppedRows: number;
  /** 保留 / 丢弃的行在头 JSON 里占的字节(含行间逗号)。 */
  keptBytes: number;
  droppedBytes: number;
  /** 本次给「行」的预算(不含 `fluid` 那层壳,见 `FLUID_FIELD_SHELL_BYTES`)。 */
  budgetBytes: number;
  /** 保留集是否装进预算。 */
  fits: boolean;
  /** 规则标识(`FLUID_LEVEL_TRIM_RULE_ID`),机器可判。 */
  rule: string;
  /** 人类可读的原因(保留 / 丢弃行数 + 「被裁的格不编 0」)。 */
  reason: string;
}

/** 一行水位在头 JSON 里的字节数(`[x,y,amount]` + 一个分隔逗号)。 */
function fluidRowBytes(l: ArchiveFluidLevel): number {
  /* 三个值都是整数、JSON 里全是 ASCII ⇒ 字符数 = UTF-8 字节数。`+1` 是行间逗号;
     最后一行会多算 1 字节 —— 偏向安全侧(宁少留一行,也不越过上限)。 */
  return JSON.stringify([l.x, l.y, l.amount]).length + 1;
}

/**
 * 水位优先级比较:`> 0` ⇒ `a` **更值得留**(裁的时候先裁 `b`)。
 *
 * 导出它,是为了让「规则可判定」这句话能被**单独测**:比较函数是纯的、全序的
 * (坐标唯一 ⇒ 任意两行都分得出先后),与输入顺序无关。
 */
export function compareFluidLevelPriority(a: ArchiveFluidLevel, b: ArchiveFluidLevel): number {
  if (a.amount !== b.amount) return b.amount - a.amount;
  if (a.y !== b.y) return a.y - b.y;
  return a.x - b.x;
}

/** 水位裁剪的**唯一**措辞点(计划、头里的 `trim.fluidReason`、回执共用)。 */
function fluidTrimReason(args: {
  totalRows: number;
  keptRows: number;
  droppedRows: number;
  totalBytes: number;
  droppedBytes: number;
  budgetBytes: number;
}): string {
  return (
    `水位表超预算:${args.totalRows} 行(${args.totalBytes} 字节)`
    + ` > 水位预算 ${args.budgetBytes} 字节 ⇒ 按「${FLUID_LEVEL_TRIM_RULE_ID}」`
    + `(amount 降序,同值按 (y, x) 升序)保留前 ${args.keptRows} 行,`
    + `裁掉 ${args.droppedRows} 行(${args.droppedBytes} 字节)。`
    + '⚠️ 被裁的格**不在水位表里**,回滚不会伪造(不编 0 —— 那与「已还原」看不出区别)。'
  );
}

/**
 * **水位裁剪规则本体**:水位表 + 行预算 → 保留集 / 行数 / 原因。纯函数。
 *
 * 预算足够时**一行都不裁**(判据 WS-FND-82 的「小世界全留」),原因也如实写
 * 「预算足够」而不是留空 —— 空原因会让回执看起来像「没跑过规则」。
 */
export function planFluidLevelsTrim(
  levels: readonly ArchiveFluidLevel[],
  budgetBytes: number,
): FluidLevelTrimPlan {
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, Math.trunc(budgetBytes)) : 0;
  let totalBytes = 0;
  for (const l of levels) totalBytes += fluidRowBytes(l);
  const base = {
    totalRows: levels.length,
    totalBytes,
    budgetBytes: budget,
    rule: FLUID_LEVEL_TRIM_RULE_ID,
  };
  if (totalBytes <= budget) {
    return {
      kept: levels.map((l) => ({ x: l.x, y: l.y, amount: l.amount })),
      keptRows: levels.length,
      droppedRows: 0,
      keptBytes: totalBytes,
      droppedBytes: 0,
      ...base,
      fits: true,
      reason: `预算足够:水位 ${levels.length} 行(${totalBytes} 字节)≤ 水位预算 ${budget} 字节 ⇒ 全部保留(不裁剪)`,
    };
  }
  const order = levels.slice().sort(compareFluidLevelPriority);
  const kept: ArchiveFluidLevel[] = [];
  let keptBytes = 0;
  let droppedBytes = 0;
  /* 前缀语义:一旦有一行装不下,后面的都不再尝试(见本节头的第 3 条理由)。 */
  let closed = false;
  for (const l of order) {
    const cost = fluidRowBytes(l);
    if (!closed && keptBytes + cost <= budget) {
      kept.push({ x: l.x, y: l.y, amount: l.amount });
      keptBytes += cost;
      continue;
    }
    closed = true;
    droppedBytes += cost;
  }
  /* 编码侧要求全序:保留下来的那批也得按 `(y, x)` 排回去(否则
     `encodeWorldArchive` 会替我们排 —— 但「计划」与「字节」用两把尺子迟早漂移)。 */
  kept.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const droppedRows = levels.length - kept.length;
  return {
    kept,
    keptRows: kept.length,
    droppedRows,
    keptBytes,
    droppedBytes,
    ...base,
    fits: keptBytes <= budget,
    reason: fluidTrimReason({
      totalRows: levels.length,
      keptRows: kept.length,
      droppedRows,
      totalBytes,
      droppedBytes,
      budgetBytes: budget,
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

/**
 * 把「块表」换成空的再编码一次 = 不含地形的固定开销。
 *
 * ⚠️ 必须按**原版本**与**当前(可能已被裁过的)水位**量:漏掉 `fluid` 会让量出来的
 * 开销偏小,于是最后一步编码超出上限、被迫再让一块 —— 「水位把地形挤掉」这种
 * 数字上的因果关系在本文件里不该出现。
 *
 * `fluid` 由**调用方**给(不是直接读 `decoded.fluid`):水位裁过之后要拿**裁过的
 * 那份**重新量,否则「裁完水位仍超上限」会在这里空转。传 `null` = 头里**不写**
 * `fluid` 键,用来量「不含水位的固定开销」(见 `fitWorldArchive`)。
 */
function fixedOverheadBytes(
  decoded: DecodedWorldArchive,
  fluid: ArchiveFluidField | null,
): number {
  return encodeWorldArchive({
    version: decoded.version,
    world: decoded.world,
    players: decoded.players,
    fluid,
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
 * **把一份快照装进字节上限**:够小就原样返回;超了就按 §5 / §5.5 的规则裁块与
 * 裁水位,再装回去。纯函数(不碰库、不碰世界)。
 *
 * ## 顺序:**先水位,再地形**
 *
 * 水位表住在**固定开销**里(头 JSON),而块体预算 = `上限 - 固定开销`。512×512
 * 全湿 ⇒ 262144 行 ⇒ 固定开销自己就超 1 MiB ⇒ 块体预算是 0(甚至负),
 * 「连一块地形都不留」都装不进去 ⇒ 改造前只能**如实抛错**(归档失败)。
 * 所以先让水位过它**自己的**预算(§5.5,常量见 `FLUID_LEVELS_BUDGET_BYTES`),
 * 再按剩下多少给块体分预算。反过来(先裁块)会让水位把地形全挤掉,却没解决
 * 超限本身。
 *
 * ## 裁剪**只裁地形与水位**
 *
 * 玩家血量 / 世界世代 / 生物 / 掉落原样保留;水位只按规则降采样(降采样结果与
 * 原因写进头里的 `trim`,见 `ArchiveTrimReport.fluidLevelsDropped` /`fluidReason`)。
 * 「裁过的归档」回滚时仍然能还回玩家的血、以及**留下的那些**液面 —— 缺口是
 * **明说的**,不是静默丢的。
 *
 * 重编码时显式带上 `version` / `fluid`:不显式给就会**按形状推断**,
 * 而一份「v2 但没有水位」的入参推断出来的仍不是原版本 —— 逐字节可比会当场破掉。
 *
 * @param maxBytes 硬上限(生产是 `repo.ts:WORLD_ARCHIVE_MAX_BYTES` = 1 MiB)
 * @throws 解码失败(不是 `WSA1`)/ 水位已裁到 0 行、地形一块不留仍装不下(如实失败)
 */
export function fitWorldArchive(snapshot: Uint8Array, maxBytes: number): FitWorldArchiveResult {
  const decoded = decodeWorldArchive(snapshot);
  const max = Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : 0;
  if (max <= 0) throw new Error(`WSA1 裁剪失败:上限 ${maxBytes} 不是正数`);
  if (decoded.totalBytes <= max) {
    /* ★ 不裁 ⇒ **原样返回入参**(逐字节不变):多写一个 `trim` 键都会让「同一份
       世界的两份归档」在字节上分叉。 */
    return { bytes: snapshot, trimmed: false, decoded, report: null };
  }

  /* ── 第一步:水位表过它**自己的**预算(§5.5) ──
     水位不降下来,下面的块体预算就没有意义(固定开销自己超上限)。 */
  let fluid: ArchiveFluidField | null = decoded.fluid;
  let fluidPlan: FluidLevelTrimPlan | null = null;
  let fixed = fixedOverheadBytes(decoded, fluid);
  if (fixed > max && decoded.fluid !== null) {
    /* 不含水位的固定开销是**量**出来的(不猜):预留只给块体,其余按真实内容。 */
    const nonFluidFixed = fixedOverheadBytes(decoded, null);
    const chunkReserve = Math.min(CHUNK_BODY_RESERVE_BYTES, decoded.bodyBytes);
    let fluidBudget = Math.min(
      FLUID_LEVELS_BUDGET_BYTES,
      Math.max(0, max - nonFluidFixed - chunkReserve),
    );
    /* 行字节是**估算**(JSON 长度),壳与头里其它键还有几字节的余地 ⇒ 真装不下就
       按超出的差额再收一次。循环有界:每次至少多让 `FLUID_FIELD_SHELL_BYTES`,
       且保留集空时立即退出。 */
    for (let guard = 0; guard < 32; guard += 1) {
      const plan = planFluidLevelsTrim(
        decoded.fluid.levels,
        Math.max(0, fluidBudget - FLUID_FIELD_SHELL_BYTES),
      );
      fluid = { width: decoded.fluid.width, height: decoded.fluid.height, levels: plan.kept };
      fluidPlan = plan;
      fixed = fixedOverheadBytes(decoded, fluid);
      if (fixed <= max || plan.keptRows === 0) break;
      fluidBudget = Math.max(0, fluidBudget - Math.max(FLUID_FIELD_SHELL_BYTES, fixed - max));
    }
    /* 一行都没丢 ⇒ 水位本来不是瓶颈:别把「跑过规则」写成「裁过水位」
       —— 那组键的**缺席**才是「水位表完整」的证据(见 `ArchiveTrimReport`)。 */
    if (fluidPlan !== null && fluidPlan.droppedRows === 0) {
      fluidPlan = null;
      fluid = decoded.fluid;
      fixed = fixedOverheadBytes(decoded, fluid);
    }
  }
  if (fixed > max) {
    throw new Error(
      `WSA1 裁剪失败:即使一块地形都不留、水位也已按预算裁过`
      + `(现 ${fluid === null ? '不可用' : `${fluid.levels.length} 行`}),`
      + `固定部分(头/玩家(含血量)/生物/掉落/水位)仍 ${fixed} 字节 > 上限 ${max} 字节`
      + ' —— 只有缩短玩家/生物列表才能归档(不在这里替 owner 决定丢谁)',
    );
  }

  const chunkBudget = max - fixed;
  const plan = planChunkTrim(decoded.chunks, chunkBudget);
  let kept = plan.kept.slice();
  const dropped = plan.dropped.slice();
  for (;;) {
    const droppedBytes = dropped.reduce((n, d) => n + d.bytes, 0);
    /* 地形与水位各有各的账:没裁地形时**不许**照抄「超预算…裁掉 0 块」那句
       —— 那会让回执看起来像「裁了地形但其实没有」。 */
    const chunkReason = dropped.length > 0
      ? trimReason({
        totalBytes: decoded.bodyBytes,
        budgetBytes: chunkBudget,
        kept: kept.length,
        dropped,
        droppedBytes,
      })
      : `预算足够:地形 ${decoded.bodyBytes} 字节 ≤ 块体预算 ${chunkBudget} 字节`
        + ` ⇒ ${kept.length} 块全部保留(不裁剪)`;
    const report: ArchiveTrimReport = {
      budgetBytes: max,
      originalBytes: decoded.totalBytes,
      keptChunks: kept.length,
      droppedChunks: dropped.length,
      droppedBytes,
      rule: TRIM_RULE_ID,
      reason: fluidPlan === null ? chunkReason : `${chunkReason} ☵ 水位另裁:${fluidPlan.reason}`,
      dropped: dropped.slice(),
    };
    if (fluidPlan !== null) {
      report.fluidLevelsTotal = fluidPlan.totalRows;
      report.fluidLevelsKept = fluidPlan.keptRows;
      report.fluidLevelsDropped = fluidPlan.droppedRows;
      report.fluidBudgetBytes = fluidPlan.budgetBytes;
      report.fluidRule = fluidPlan.rule;
      report.fluidReason = fluidPlan.reason;
    }
    const out = encodeWorldArchive({
      version: decoded.version,
      world: decoded.world,
      players: decoded.players,
      fluid,
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
        + ` > 上限 ${max} 字节(头里的玩家(含血量)/生物/掉落/水位太长)`,
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
 * 3 归档里**没有**的东西进 `unavailable`(玩家血量 / 流体水位)或
 *    `missingChunks`(被裁掉的地形块),**不许**编值。
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
  /** v2 的流体水位(`null` = 归档里没有这一项 ⇒ 不可用,回滚不铺水位)。 */
  fluid: ArchiveFluidField | null;
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
    fluid: null,
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
    players: decoded.players.map((p) => (p.hp === undefined
      ? { id: p.id, x: p.x, y: p.y, z: p.z, level: p.level }
      : { id: p.id, x: p.x, y: p.y, z: p.z, level: p.level, hp: p.hp })),
    /* ★ 水位走**深拷贝**:描述/计划不许与解码结果共用同一批数组 ——
       共享会让「同一份计划应用两次」在字面上互相影响。 */
    fluid: copyFluidField(decoded.fluid),
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
  /**
   * 归档里**有**血量才带这个键。
   *
   * v1 头里没有 `hp` ⇒ 键**缺席** = 不可用:应用侧按「重建后满血」处理,
   * 不许在这里填一个 100(v2 头里则有,且由解码器保证是有限非负数)。
   */
  hp?: number;
}

/**
 * 一条「把**流体水位**铺回去」的 op —— **v2 才有**。
 *
 * v1 的归档里没有水位(`fluid === null`)⇒ 这条 op **不产生**(见 `planRestore`)。
 * 「缺水位」是缺口,不是「水位全 0」:编一个全零密度场会让回滚**静默把水抽干**,
 * 而回执上看不出这件事。
 *
 * `levels` 是全序(按 `(y, x)` 升序)的非零水位表;没被列出的格保持宿主重建后
 * 的值(应用侧不负责把它清零)。
 */
export interface RestoreFluidOp {
  kind: 'fluid';
  width: number;
  height: number;
  levels: ArchiveFluidLevel[];
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
  | RestoreFluidOp
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
  /**
   * 归档里**少了**几块地形。两个口径取 max(见 `planRestore` 的缺口计算):
   * 摘要自述的 `trim.droppedChunks`,与「头声明的总块数 − 实际块数」。
   * 所以「删掉 `trim` 键」不再能把缺口变成 0。
   */
  missingChunks: number;
  /**
   * 归档里**实际**带的块数(与 `chunksDeclaredTotal` 的差额就是缺口)。
   * 审阅时把这两个数与 `missingChunks` 摆在一起,缺口就不是一句自述了。
   */
  chunksInArchive?: number;
  /** 头里声明的**裁剪前**总块数(`DecodedWorldArchive.chunksTotal`)。 */
  chunksDeclaredTotal?: number;
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
    /* `hp` **只在归档里有的时候**才带上:v1 头里没有 ⇒ 键缺席 = 不可用,
       ops 也就不许凭空填一个 100(见 `RestorePlayerOp.hp`)。 */
    const op: RestorePlayerOp = {
      kind: 'player', id: p.id, x: p.x, y: p.y, z: p.z, level: p.level,
    };
    if (p.hp !== undefined) op.hp = p.hp;
    ops.push(op);
  }
  /* ★ v2 的流体水位(v1 里 `fluid === null` ⇒ **不产生这条 op**,
     否则「回滚」会顺手把水抽干 —— 见 `RestoreFluidOp`)。 */
  if (snapshot.fluid !== null) {
    ops.push({
      kind: 'fluid',
      width: snapshot.fluid.width,
      height: snapshot.fluid.height,
      levels: snapshot.fluid.levels.map((l) => ({ x: l.x, y: l.y, amount: l.amount })),
    });
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
      /* 血量只在一侧也报得出来的时候才叙述(v1 的两侧都没有 ⇒ 不编)。 */
      if (now.hp !== undefined && p.hp !== undefined && now.hp !== p.hp) {
        changes.push(`玩家 ${p.id} 血量:${now.hp} → ${p.hp}`);
      }
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
    const nowFluid = current.fluid;
    if (snapshot.fluid === null) {
      if (nowFluid !== null) {
        changes.push(
          `流体水位:归档里**没有**这一项(v${snapshot.version} 头)⇒ 液面不还原`
          + `(当前描述里有 ${nowFluid.levels.length} 格非零水位)`,
        );
      }
    } else if (
      nowFluid === null
      || nowFluid.width !== snapshot.fluid.width
      || nowFluid.height !== snapshot.fluid.height
      || nowFluid.levels.length !== snapshot.fluid.levels.length
    ) {
      const from = nowFluid === null ? '不可用' : `${nowFluid.levels.length} 格非零`;
      changes.push(`流体水位:${from} → ${snapshot.fluid.levels.length} 格非零`);
    }
  }

  const trim = snapshot.trim;
  /* ★ 缺口 = 「摘要自述的」与「实际块数算出来的」两个口径取 **max**(审计 P1)。
   *
   * 改前只有第一个:`trim === null` ⇒ `missingChunks = 0`。于是一份**裁过**
   * 的归档只要把 `trim` 键删掉(再顺手删掉几块),`planRestore` 就报「没裁过、
   * 缺口 0」—— 摘要自己证明自己清白,回滚静默少几块地形。现在:
   *   · 实际块数 `actualChunks`;
   *   · 头里声明的裁剪前总块数 `snapshot.chunksTotal`(旧字节 ⇒ = 实际块数);
   *   · `shortfall = chunksTotal - actualChunks` —— **不依赖 `trim` 是否存在**;
   *   · `missingChunks = max(trim?.droppedChunks ?? 0, shortfall)`。
   * 两个来源任意一个说得更大,就按大的报 —— 缺口宁可多说,不肯少说。 */
  const actualChunks = snapshot.chunks.length;
  const declaredTotalChunks = snapshot.chunksTotal;
  const shortfall = Math.max(0, declaredTotalChunks - actualChunks);
  const trimDropped = trim === null ? 0 : Math.max(0, Math.trunc(trim.droppedChunks));
  const missingChunks = Math.max(trimDropped, shortfall);
  const unavailable: string[] = [];
  const playersWithoutHp = snapshot.players.filter((p) => p.hp === undefined).length;
  if (playersWithoutHp > 0) {
    unavailable.push(
      `players[].hp:v${snapshot.version} 的归档头里**没有血量**(只有 id/x/y/z/level;`
      + `${playersWithoutHp} 个玩家受影响)⇒ 计划只还原位置与等级,`
      + '血量由宿主按登记重置(不在这里编一个 100)',
    );
  }
  if (snapshot.fluid === null) {
    unavailable.push(
      `fluid:v${snapshot.version} 的归档头里**没有流体水位** ⇒ 计划不铺液面,`
      + '水位按宿主重建后的空地重新开始(不编一个全零密度场 —— 那和「已还原」看不出区别)',
    );
  }
  /* (a) `trim` 缺席但**头声明的总块数 > 实际块数** ⇒ 这就是「摘要被删/缺失,
     而块确实少了」。不写成「已裁掉 N 块」:那份摘要不在头里,不能替它编原因。 */
  if (trim === null && shortfall > 0) {
    unavailable.push(
      `chunks:归档头声明共 ${declaredTotalChunks} 块,实际只带 ${actualChunks} 块`
      + ` ⇒ 缺 ${shortfall} 块,而头里**没有**裁剪摘要(被删或从未写下)`
      + ' —— 这不能当成「未裁剪」:缺口照报,计划不会伪造这些块',
    );
  }
  /* (b) 摘要说留下的块数与实际块数对不上 ⇒ 摘要本身不可信,两个数都报出来。 */
  if (trim !== null && trim.keptChunks !== actualChunks) {
    unavailable.push(
      `chunks:裁剪摘要自称保留 ${trim.keptChunks} 块,归档里实际只有 ${actualChunks} 块`
      + `(缺口按 ${missingChunks} 块计)⇒ 摘要与实际块数不一致,计划只按实际块数重建`,
    );
  }
  if (trim !== null && trimDropped > 0) {
    const avg = Math.round(trim.droppedBytes / trimDropped);
    unavailable.push(
      `chunks:归档时已裁掉 ${missingChunks} 块(合计 ${trim.droppedBytes} 字节,平均 ${avg} 字节/块)`
      + ' ⇒ 这些块**没有**字节,计划不会伪造;原始地形可由 seed 重建,玩家建造部分不可回滚',
    );
  }
  /* ★ 被裁掉的**水位**(WS-FND-82):必须在计划层读得出来 —— 归档少了哪些格、
     为什么少。否则「液面回来了」与「液面被裁过」在回执上看不出区别(静默丢水)。
     与块的 `unavailable` 同一种形态:说清**多少 + 为什么 + 计划不伪造什么**。 */
  const fluidDropped = trim === null ? 0 : Math.max(0, Math.trunc(trim.fluidLevelsDropped ?? 0));
  if (trim !== null && fluidDropped > 0) {
    const keptRows = trim.fluidLevelsKept
      ?? (snapshot.fluid === null ? 0 : snapshot.fluid.levels.length);
    const totalRows = trim.fluidLevelsTotal ?? (keptRows + fluidDropped);
    const fluidRule = trim.fluidRule ?? FLUID_LEVEL_TRIM_RULE_ID;
    const why = trim.fluidReason !== undefined && trim.fluidReason.length > 0
      ? trim.fluidReason
      : fluidRule;
    changes.push(
      `流体水位:归档时按「${fluidRule}」裁掉了 ${fluidDropped} 行`
      + `(原 ${totalRows} 行 ⇒ 保留 ${keptRows} 行,水位预算 ${trim.fluidBudgetBytes ?? 0} 字节)`
      + ' ⇒ 只铺回保留的那些格,被裁的格**不编 0**',
    );
    unavailable.push(
      `fluid.levels:归档时水位表被裁掉 ${fluidDropped} 行`
      + `(原 ${totalRows} 行,保留 ${keptRows} 行;原因:${why})`
      + ' ⇒ 这些格的水位**不在归档里**,计划不会伪造(不编 0 —— 那与「已还原」看不出区别)',
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
    chunksInArchive: actualChunks,
    chunksDeclaredTotal: declaredTotalChunks,
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
 *
 * 没有对应 op 的字段保持空世界的值(`fluid: null` / 玩家对象里**没有** `hp` 键):
 * 那是「归档里没有这一项」的表达,不是「值等于 0」。调用方(宿主)据此判断
 * 「血量 / 液面要不要自己兜底」,而不是被一个编出来的 0 骗过去。
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
      const p: ArchivePlayer = { id: op.id, x: op.x, y: op.y, z: op.z, level: op.level };
      /* 只在 op 带 `hp` 时才建这个键(v1 的计划里没有它 ⇒ 键缺席 ≠ `hp: undefined`)。
         逐字段比较与 `Object.keys` 都要分得清这两者。 */
      if (op.hp !== undefined) p.hp = op.hp;
      out.players.push(p);
      continue;
    }
    if (op.kind === 'fluid') {
      /* 深拷贝:同一份计划应用两次不许共享同一批数组(纯函数的前提)。 */
      out.fluid = copyFluidField({ width: op.width, height: op.height, levels: op.levels });
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
        || p.hp !== q.hp
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
  /* 水位:v2 里是稀疏表,所以逐格点名 —— 比 `JSON.stringify` 更容易看出差在哪一格。 */
  if ((a.fluid === null) !== (b.fluid === null)) {
    out.push(
      `fluid:${a.fluid === null ? '不可用(null)' : `${a.fluid.levels.length} 格非零`}`
      + `≠${b.fluid === null ? '不可用(null)' : `${b.fluid.levels.length} 格非零`}`,
    );
  } else if (a.fluid !== null && b.fluid !== null) {
    const fa = a.fluid;
    const fb = b.fluid;
    if (fa.width !== fb.width) out.push(`fluid.width:${fa.width}≠${fb.width}`);
    if (fa.height !== fb.height) out.push(`fluid.height:${fa.height}≠${fb.height}`);
    if (fa.levels.length !== fb.levels.length) {
      out.push(`fluid.levels.length:${fa.levels.length}≠${fb.levels.length}`);
    } else {
      for (let i = 0; i < fa.levels.length; i += 1) {
        const l = fa.levels[i];
        const m = fb.levels[i];
        if (l.x !== m.x || l.y !== m.y || l.amount !== m.amount) {
          out.push(
            `fluid.levels[${i}]:(${l.x},${l.y})水位 ${l.amount}≠(${m.x},${m.y})水位 ${m.amount}`,
          );
        }
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