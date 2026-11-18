/**
 * WS-FND-116 —— 「第二~四轮新加守卫」的**反向复查**(2026-11-19 第五轮)。
 *
 * ## 这一组守的是什么
 *
 * 前几轮加守卫时,守卫本身有了新的缝。逐条:
 *
 * | # | 判据 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- |
 * | 1 | ★ 声明 RLE 长度**超出剩余字节** ⇒ `Chunk.deserializeSnapshot` **抛**(不再静默当成「没有屋顶」);缺屋顶尾段的**旧布局**仍解得开 | 把 `deserializeSnapshot` 的长度判定改回「够长才 decode」的裸 `if`(没有 else) |
 * | 2 | ★ 屋顶 ID 值域(12 位 / 4095)在**快照 / 回滚路径**同样强制(`decodeRoofRle` 与 `setRoof` 同源);4095 收 | 把 `decodeRoofRle` 里的 `assertRoofId(...)` 换回裸 `& 0xffff` |
 * | 3 | ★ 同时删掉 `trim` + `chunksTotal` + `chunksChecksum` ⇒ 缺口语义归 0,但 `planRestore.chunksVerified === false`(**不可信状态**,不是「完整」) | 把 `planRestore` 里那条 `if (!chunksVerified)` 删掉 |
 * | 4 | ★ `snapshot_bytes` 的上下界在**内存后端也真的校验**(`AND` 合取被 `parseCheckExpr` 认得);双后端 −1 / 1 MiB+1 都拦、0 / 1 MiB 都收 | 把 `parseCheckExpr` 里的 `kind:'and'` 那两支(解析 + `checkPasses`)删掉 |
 * | 5 | ★ 编码侧对 `trim` 的整数 / 非负校验与解码**同源**:`2.5` / `-1` 在**编码**就抛,而不是产出「自家解码必抛」的字节 | 把 encode 里的 `trimIntField` 换回 `Math.trunc(droppedChunks)` + 原样写字段 |
 * | 6 | ★ `fluid.setCell` 的实心格判定与**写入值**同源:`amount: 0.5 / 0.9`(floor 后为 0)不再误抛;`amount: 1` 仍然抛 | 把判定改回入参原值 `init.amount > 0` |
 * | 7 | ★ `parseCheckExpr` 的真值表:同列合取 ⇒ `and`、`BETWEEN 1 AND 30` 仍是 `between`、**跨列**合取仍是 `unsupported`(不半懂) | 把 AND 的切分放在 `BETWEEN` **之前**(两条判据当场红) |
 * | 8 | ★ 加固不许把合法旧字节 / 未裁剪归档打成坏数据:`encode(decode(x))` 逐字节往返、`ops` 自足、`missing` 不伪造 | 在解码侧顺手给未裁剪归档补一个 `chunksChecksum`(往返与「没有摘要」两条判据都会红) |
 *
 * ## 判据纪律(与本仓 FND-104 / FND-112 同一套)
 *
 * ```
 * 1 每条都要能失败 —— 负对照与注入验证成对出现,「跑过了」不算数
 * 2 行为判据优先:能造出坏字节看它抛,就不只 grep 源码
 * 3 文本判据只锁「同源」这类行为测不出的性质,且必须带反向断言
 * 4 断言右侧一律字面量;引用契约常量后立刻与字面量对账(不让「用一个值断言它自己」)
 * ```
 *
 * ## 注入验证(实测:六次注入各变红一次,恢复原样后重跑 8/8 通过)
 *
 * ```
 * A  deserializeSnapshot 改回「够长才 decode」            ⇒ 7/8:FND116-1 红(坏字节不再抛)
 * B  decodeRoofRle 把 assertRoofId 换回 & 0xffff          ⇒ 7/8:FND116-2 红(4096 被收下)
 * C  planRestore 删掉 `if (!chunksVerified)`              ⇒ 6/8:FND116-3 红(三键齐删后毫无降级信号)
 * D  parseCheckExpr 停掉 `and` 识别                       ⇒ 6/8:FND116-4 红(内存后端放行 -1 与 1 MiB+1)
 * E  encode 的 trimIntField 换回 Math.trunc               ⇒ 7/8:FND116-5 红(2.5 / -1 不再抛)
 * F  fluid.setCell 判定换回 init.amount > 0               ⇒ 7/8:FND116-6 红(0.5 被误抛)
 * ```
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  MemoryDb,
  checkExprUnsupported,
  checkPasses,
  parseCheckExpr,
} from '../server/src/db/memory_db.ts';
import { openNodeSqlite, type SqliteDb } from '../server/src/db/driver.sqlite.ts';
import { migrate, migrateWorldArchives } from '../server/src/db/repo.ts';
import { packTile, BaseFluid } from '../shared/types/tile.ts';
import {
  Chunk,
  decodeRoofRle,
  encodeRoofRle,
  ROOF_BITS,
  ROOF_ID_MAX,
} from '../server/src/world/chunk.ts';
import {
  decodeWorldArchive,
  encodeWorldArchive,
  fitWorldArchive,
  planRestore,
  type ArchiveTrimReport,
} from '../server/src/world/archive.ts';
import { FluidField } from '../server/src/world/fluid.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════ 夹具与工具 ═══════════════════════ */

/** 快照头在块体字节里的偏移:`256 × 4` 单元 + `3 × 32` 台账位图 = 1120(字面量)。 */
const SNAPSHOT_HEAD = 1024 + 96;
/** 屋顶 RLE 起点 = 头 + 24(version / dirtyCount / cx / cy / rleLen / flags)。 */
const RLE_AT = SNAPSHOT_HEAD + 24;
/** 夹具用的块数(6 块合成地形)。 */
const FIXTURE_CHUNKS = 6;

/** 一块地形:可选在 (0,0) 摆一件家具(obj=351 ⇒ 裁剪时算「玩家建造」)。 */
function chunkBlob(cx: number, cy: number, built = false): Uint8Array {
  const c = new Chunk(cx, cy);
  if (built) c.cells[0] = packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 351, meta: 0 });
  return c.serializeSnapshot();
}

/** 6 块合成世界(前两块「有建造」,后四块是可重建的原始地形)。 */
function synthArchive(): Uint8Array {
  const chunks = [];
  for (let i = 0; i < FIXTURE_CHUNKS; i += 1) {
    chunks.push({ cx: i % 3, cy: Math.floor(i / 3), bytes: chunkBlob(i % 3, Math.floor(i / 3), i < 2) });
  }
  return encodeWorldArchive({
    world: { roomId: 'r_wsfnd116', seed: 23, sizeCells: 64, biome: 'MEADOW', frame: 7, hourOfDay: 11 },
    players: [],
    mobs: [],
    ground: [],
    chunks,
  });
}

/** 原地重写头 JSON(头长度会变 ⇒ 必须重算 `[8,12)`)。 */
function rewriteHeader(bytes: Uint8Array, mutate: (h: Record<string, unknown>) => void): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLen))) as Record<string, unknown>;
  mutate(header);
  const newHeader = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(12 + newHeader.byteLength + bytes.byteLength - (12 + headerLen));
  out.set(bytes.subarray(0, 12), 0);
  new DataView(out.buffer).setUint32(8, newHeader.byteLength, true);
  out.set(newHeader, 12);
  out.set(bytes.subarray(12 + headerLen), 12 + newHeader.byteLength);
  return out;
}

/** 断言 `fn` 抛错并返回消息(fail-closed 的判据必须说清哪儿坏)。 */
function throwsWith(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${label} 必须抛错(静默放过 = 坏数据被当成好的)`);
}

/** LF 归一后读源码(文本判据用;CRLF 会让锚点永不到达)。 */
function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

function mkMem(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  migrateWorldArchives(db, 1000);
  return db;
}

function mkSql(): { db: SqliteDb; close: () => void } {
  const db = openNodeSqlite(':memory:');
  migrate(db, 1000);
  migrateWorldArchives(db, 1000);
  return { db, close: () => db.close() };
}

/* ═════════== 1. ★ 截断的屋顶层不许被「当成没有屋顶」 ═════════== */

test('FND116-1 ★声明 RLE 长度超出剩余字节 ⇒ 抛;旧布局(没有屋顶尾段)仍解得开', () => {
  const c = new Chunk(1, 1);
  c.setRoof(2, 3, 372);
  const snap = c.serializeSnapshot();
  ok(snap.byteLength > RLE_AT + 3, `前提:这份快照带屋顶尾段(实得 ${snap.byteLength} 字节)`);

  /* 负对照 1:不改的字节必须解得开,且屋顶照旧读得回(证明不是「一律抛」)。 */
  const back = Chunk.deserializeSnapshot(snap);
  eq(back.getRoof(2, 3), 372, '未改的字节:屋顶原样读回');

  /* 注入:把**最后一个字节**切掉 —— 头里声明的 rleLen 于是超出剩余字节。
     改前这一层是裸 `if (够长) { decode }`:截断被吃掉 ⇒ 解出来的屋顶层是空的
     (`roofAt()` 全 0),`archive.ts:decodeChunk` 据此把该块判成 tier 0 并优先裁掉。 */
  const truncated = snap.slice(0, snap.byteLength - 1);
  const msg = throwsWith(() => Chunk.deserializeSnapshot(truncated), '截断的屋顶尾段');
  ok(msg.includes('屋顶层'), `★ 错误消息必须点名屋顶层(实得 ${msg})`);

  /* 负对照 2:旧布局(快照只有头、没有 24 字节尾字段)仍然合法 —— 那是
     「这一版快照没有屋顶层」的**老字节**,不是坏数据。 */
  const legacy = snap.slice(0, SNAPSHOT_HEAD);
  const legacyChunk = Chunk.deserializeSnapshot(legacy);
  eq(legacyChunk.getRoof(2, 3), 0, '旧布局:没有屋顶尾段 ⇒ 屋顶全 0(合法路径不许被打红)');

  /* ★ 归档路径的口径:坏块体必须**当场抛**(而不是降级成 tier 0 再被裁掉)。 */
  const badArchive = encodeWorldArchive({
    world: { roomId: 'r_bad', seed: 1, sizeCells: 64, biome: 'MEADOW', frame: 1, hourOfDay: 0 },
    players: [],
    mobs: [],
    ground: [],
    chunks: [{ cx: 0, cy: 0, bytes: truncated }],
  });
  const msg2 = throwsWith(() => decodeWorldArchive(badArchive), '归档里的截断块体');
  ok(msg2.includes('地形字节解不开'), `★ 归档解码必须点名「地形字节解不开」(实得 ${msg2})`);
});

/* ═════════== 2. ★ 屋顶 12 位上界在快照 / 回滚路径同样强制 ═════════== */

test('FND116-2 ★decodeRoofRle 与 setRoof 共用 12 位上界:4095 收、4096 抛,快照路径同样拦', () => {
  eq(ROOF_BITS, 12, '★ ROOF 层位宽取自 VERTICAL_STACK(字面量对账)');
  eq(ROOF_ID_MAX, 4095, '★ 上界 = 2^12 − 1(字面量对账)');

  /* 注入:直接喂一个 4096 的 RLE 值(`0x1000` 小端 = 00 10)。 */
  const into = new Uint16Array(4);
  const msg = throwsWith(
    () => decodeRoofRle(new Uint8Array([0xff, 0x00, 0x10]), into),
    'RLE 里的 4096',
  );
  ok(msg.includes('12 位'), `★ 错误消息必须点名 12 位(实得 ${msg})`);
  eq(into[0], 0, '★ 抛之前一格都不许写(坏值不能半写进去)');

  /* 负对照:边界值 4095 与合法 ID 照旧收下(证明判据不是「一律抛」)。 */
  const okBuf = new Uint16Array(2);
  decodeRoofRle(new Uint8Array([0xff, 0xff, 0x0f, 0xff, 0x74, 0x01]), okBuf);
  eq(okBuf[0], 4095, '负对照:4095 收');
  eq(okBuf[1], 372, '负对照:内容表里的 372 照旧');

  /* ★ 快照路径(回滚就是走这条):把真快照里的那一个 0xff 值的低 16 位改成 0x1000。 */
  const c = new Chunk(0, 0);
  c.setRoof(1, 0, 372);
  const snap = c.serializeSnapshot();
  const rle = encodeRoofRle(c.roofs);
  const at = RLE_AT + rle.indexOf(0xff);
  ok(at > RLE_AT, '前提:快照里能找到 0xff 屋顶标记');
  const patched = snap.slice();
  patched[at + 1] = 0x00;
  patched[at + 2] = 0x10; /* 0x1000 = 4096 */
  const msg2 = throwsWith(() => Chunk.deserializeSnapshot(patched), '快照里的 4096 屋顶');
  ok(msg2.includes('12 位'), `★ 快照 / 回滚路径必须同样拦(实得 ${msg2})`);
  eq(Chunk.deserializeSnapshot(snap).getRoof(1, 0), 372, '负对照:未改的快照照旧解得开');

  /* ★ 「同源」是行为测不出的性质(两条路只有一份上界),用源码锁:两个入口都点名
     `assertRoofId`,且 `decodeRoofRle` 里不再出现裸 `& 0xffff` 直接落盘。 */
  const src = readSrc('server/src/world/chunk.ts');
  ok(/into\[o\] = assertRoofId\(/.test(src), '★ decodeRoofRle 的落盘必须过 assertRoofId');
  ok(
    /setRoof\(x: number, y: number, roofId: number\): void \{[\s\S]*?assertRoofId\(roofId/.test(src),
    '★ setRoof 必须用同一个 assertRoofId(不是第二份数字)',
  );
  ok(!/into\[o\] = \(buf\[i \+ 1\]/.test(src), '负对照:不许再直接把裸 16 位值写进 roofs');
});

/* ═════════== 3. ★ 「没有摘要」本身是不可信状态 ═════════== */

test('FND116-3 ★三键齐删(trim + chunksTotal + chunksChecksum)⇒ chunksVerified=false,不许退化成「完整」', () => {
  const fit = fitWorldArchive(synthArchive(), 4000);
  if (fit.report === null) throw new Error('夹具失败:4000 字节上限没有触发裁剪(判据会失去对象)');
  ok(fit.report.droppedChunks > 0, `前提:真裁过块(实得 ${fit.report.droppedChunks})`);

  /* 负对照 1:没动过的裁剪归档 ⇒ 摘要齐、校验和对得上 ⇒ `chunksVerified === true`。 */
  const clean = decodeWorldArchive(fit.bytes);
  eq(clean.chunksChecksumOk, true, '前提:未伪造字节里校验和存在且对得上');
  const planClean = planRestore(clean, null);
  eq(planClean.chunksVerified, true, '★ 有摘要 ⇒ chunksVerified = true');
  ok(
    !planClean.unavailable.some((u) => u.startsWith('chunks:') && u.includes('地形表摘要')),
    '★ 有摘要时不许出现「没有摘要」的降级叙述',
  );

  /* 注入:把三个**可选**键一起删掉(审计 P2 的攻击形态)。 */
  const forged = rewriteHeader(fit.bytes, (h) => {
    delete h.trim;
    delete h.chunksTotal;
    delete h.chunksChecksum;
  });
  const d = decodeWorldArchive(forged);
  eq(d.trim, null, '注入生效:头里已读不到 trim');
  eq(d.chunksChecksumOk, null, '★ 没有校验和 ⇒ null(不可判 ≠ 通过)');
  eq(d.chunksTotal, d.chunks.length, '★ 没有 chunksTotal ⇒ 退化成实际块数(这正是缺口归零的原因)');

  const plan = planRestore(d, null);
  eq(plan.missingChunks, 0, '缺口只报**检出的**:三个键都没了,谁也无法声明少了几块');
  eq(plan.chunksDeclaredTotal, plan.chunksInArchive, '两个口径退化到同一个数(所以缺口是 0)');
  eq(plan.chunksVerified, false, '★ 「没有摘要」必须是明确的**不可信状态**');
  ok(
    plan.unavailable.some((u) => u.startsWith('chunks:') && u.includes('地形表摘要') && u.includes('不可判')),
    `★ 必须有一条说明「块表不可判」(实得 ${plan.unavailable.join(' / ')})`,
  );

  /* 负对照 2:未裁剪的干净归档也从没有摘要(旧字节形态),缺口 0 但同样**不许**
     被说成「已裁掉」—— 那条断言属于摘要的口径,不在这里编。 */
  const plain = decodeWorldArchive(synthArchive());
  const planPlain = planRestore(plain, null);
  eq(planPlain.chunksVerified, false, '未裁剪的归档也没有摘要 ⇒ 同样不可判');
  eq(planPlain.missingChunks, 0, '★ 缺口是 0');
  ok(!planPlain.unavailable.some((u) => u.includes('已裁掉')), '★ 不许把「没有摘要」编成「已裁掉 N 块」');
});

/* ═════════== 4. ★ snapshot_bytes 的上下界在内存后端也生效 ═════════== */

test('FND116-4 ★`AND` 合取被认出:snapshot_bytes 的 −1 / 1 MiB+1 在双后端都被拦', () => {
  const mem = mkMem();
  const un = mem.unsupportedChecks();
  eq(un.length, 2, `★ 归档表不许再贡献未实现的 CHECK(实得 ${un.length} 条)`);
  ok(un.every((u) => u.table === 'rooms'), '★ 剩下那 2 条仍是 rooms 的跨列 OR(不是被一刀切放行)');

  const row = (bytes: number): Record<string, unknown> => ({
    id: `r#${bytes}`, room_id: 'r', seq: 1, seed: 1, world_tick: 0,
    snapshot_blob: new Uint8Array(Math.max(0, bytes)), snapshot_bytes: bytes,
    reason: '', archived_at: 1000,
  });

  /* 负对照:0 与 1 MiB 都在界内(上限不是「小于」)。 */
  mem.insert('room_world_archives', row(0));
  mem.insert('room_world_archives', row(1048576));

  const negMsg = throwsWith(() => mem.insert('room_world_archives', row(-1)), '内存库 −1');
  ok(negMsg.includes('CHECK'), `★ 内存后端必须拦 −1(实得 ${negMsg})`);
  const bigMsg = throwsWith(() => mem.insert('room_world_archives', row(1048577)), '内存库 1 MiB + 1');
  ok(bigMsg.includes('CHECK'), `★ 内存后端必须拦 1 MiB + 1(实得 ${bigMsg})`);

  /* 真引擎同一条语义(不是只在内存实现里)。 */
  const real = mkSql();
  try {
    real.db.insert('room_world_archives', row(0));
    const realNeg = throwsWith(() => real.db.insert('room_world_archives', row(-1)), '真引擎 −1');
    ok(realNeg.includes('CHECK'), `★ 真引擎必须拦 −1(实得 ${realNeg})`);
    const realBig = throwsWith(
      () => real.db.insert('room_world_archives', row(1048577)),
      '真引擎 1 MiB + 1',
    );
    ok(realBig.includes('CHECK'), `★ 真引擎必须拦 1 MiB + 1(实得 ${realBig})`);
  } finally {
    real.close();
  }
});

/* ═════════== 5. ★ 编码侧与解码侧同一个 trim 整数口径 ═════════== */

test('FND116-5 ★encode 拒绝非整数 / 负数 trim 字段(不再产出「自家解码必抛」的字节)', () => {
  const chunks = [{ cx: 0, cy: 0, bytes: chunkBlob(0, 0, true) }, { cx: 1, cy: 0, bytes: chunkBlob(1, 0) }];
  const world = { roomId: 'r_trim', seed: 5, sizeCells: 64, biome: 'MEADOW', frame: 3, hourOfDay: 4 };
  const trim: ArchiveTrimReport = {
    budgetBytes: 2000, originalBytes: 4000, keptChunks: 2, droppedChunks: 1, droppedBytes: 1200,
    rule: 'built>activity>regenerable', reason: '夹具:裁掉 1 块不可重建的? (人读原因)', dropped: [],
  };
  const enc = (t: ArchiveTrimReport): Uint8Array => encodeWorldArchive({
    world, players: [], mobs: [], ground: [], chunks, trim: t,
  });

  /* 负对照:合法的非负整数 ⇒ 编码成功,且解码能把两个口径对回来。 */
  const good = enc(trim);
  const d = decodeWorldArchive(good);
  eq(d.trim?.droppedChunks, 1, '负对照:被裁数原样回到头里');
  eq(d.chunksTotal, 3, '★ 总块数 = 实际 2 + 被裁 1(裁剪前口径)');
  eq(d.chunksChecksumOk, true, '负对照:校验和写下了且对得上');
  ok(good.byteLength > 0, '负对照:合法 trim 编码成功');

  /* 注入 1:2.5 —— 改前用 `Math.trunc` 算校验和、字段原样写 ⇒ 编码收下、解码必抛。 */
  const fracMsg = throwsWith(() => enc({ ...trim, droppedChunks: 2.5 }), '非整数 droppedChunks');
  ok(fracMsg.includes('编码失败'), `★ 必须在**编码**就抛(实得 ${fracMsg})`);
  ok(fracMsg.includes('droppedChunks'), '★ 消息要点名是哪个字段');

  /* 注入 2:-1 —— 改前两端都不拦,而 `planRestore` 的 Math.max(0,…) 会归 0:
     头里说「裁了 -1 块」、计划里说「缺口 0」,自相矛盾。 */
  const negMsg = throwsWith(() => enc({ ...trim, droppedChunks: -1 }), '负数 droppedChunks');
  ok(negMsg.includes('非负'), `★ 负值必须在编码就抛(实得 ${negMsg})`);
  const budgetMsg = throwsWith(() => enc({ ...trim, budgetBytes: -5 }), '负数 budgetBytes');
  ok(budgetMsg.includes('budgetBytes'), '★ 每个写出去的字段各判一次(不只看 droppedChunks)');

  /* ★ 两端同源:把 2.5 直接写进头 JSON ⇒ 解码也必须抛同一种话(不是只有编码在挑)。 */
  const forged = rewriteHeader(good, (h) => {
    (h.trim as Record<string, unknown>).droppedChunks = 2.5;
  });
  const decMsg = throwsWith(() => decodeWorldArchive(forged), '头里的 2.5');
  ok(decMsg.includes('必须是整数'), `★ 解码侧同口径(实得 ${decMsg})`);
});

/* ═════════== 6. ★ fluid.setCell:判定与写入同源 ═════════== */

test('FND116-6 ★实心格判定用落盘值:0.5 / 0.9 不再误抛,1 仍然抛', () => {
  const f = new FluidField(4, 4);
  f.setCell(1, 0, { base: BaseFluid.ROCK, solid: true });

  /* 注入:实心格 + amount 0.5 —— 改前按入参原值判 `> 0` ⇒ 误抛 RangeError,
     而 `clampAmount(0.5) = 0`:一格水都写不进去。 */
  f.setCell(1, 0, { amount: 0.5 });
  eq(f.amountAt(1, 0), 0, '★ 0.5 落盘是 0(与判定同源)');
  f.setCell(1, 0, { amount: 0.9 });
  eq(f.amountAt(1, 0), 0, '★ 0.9 同样落盘 0、同样不抛');

  /* 负对照 1:实心格 + amount 1(落盘 1)仍然必须抛 —— 判据没有被削掉。 */
  const msg = throwsWith(() => f.setCell(1, 0, { amount: 1 }), '实心格注 1 毫格');
  ok(msg.includes('实心格'), `★ 错误消息必须点名实心格(实得 ${msg})`);
  eq(f.amountAt(1, 0), 0, '★ 抛之后那格仍没有水');

  /* 负对照 2:非实心格的分数水位按 floor 落盘(判定与写入用的是同一个值)。 */
  f.setCell(2, 0, { base: BaseFluid.SHALLOW_WATER });
  f.setCell(2, 0, { amount: 900.9 });
  eq(f.amountAt(2, 0), 900, '★ 非实心格:900.9 ⇒ 900(floor)');
});
/* ═════════== 7. ★ `parseCheckExpr` 的真值表(认得的形态 vs 不半懂的) ═════════== */

test('FND116-7 ★同列合取被认出、BETWEEN 不被切坏、跨列合取仍是 unsupported', () => {
  /* 1 归档表那条(单列 + 上下界)⇒ `and`,且求值方向对。 */
  const c = parseCheckExpr('snapshot_bytes >= 0 AND snapshot_bytes <= 1048576');
  eq(c.kind, 'and', '★ 同列 AND 合取必须被认出(否则内存后端等于没有这条约束)');
  eq(checkPasses(c, -1), false, '合取求值:−1 不通过');
  eq(checkPasses(c, 1048577), false, '合取求值:1 MiB + 1 不通过');
  eq(checkPasses(c, 0), true, '负对照:0 通过');
  eq(checkPasses(c, 1048576), true, '负对照:1 MiB 通过');

  /* 2 `BETWEEN a AND b` 里的 `AND` 不是合取 —— 顺序错了两条判据都会当场红。 */
  const bt = parseCheckExpr('level BETWEEN 1 AND 30');
  eq(bt.kind, 'between', '★ BETWEEN 必须仍然解析成 between(不许被 AND 切开)');
  eq(checkPasses(bt, 31), false, 'between 上界仍然拦 31');

  /* 3 跨列合取:认不出来就**如实说**不认识(不许半懂后放行)。 */
  const cross = parseCheckExpr('a >= 0 AND b <= 1');
  eq(cross.kind, 'unsupported', '★ 跨列合取必须报 unsupported(单值求值对它没意义)');
  ok(checkExprUnsupported(cross), '★ unsupported 必须被算作「未实现的约束」(可枚举)');
  ok(!checkExprUnsupported(c), '负对照:认得的同列合取不算未实现');
});

/* ═════════== 8. ★ 加固不许把合法旧字节 / 未裁剪归档打成坏数据 ═════════== */

test('FND116-8 ★旧字节与未裁剪归档仍逐字节往返;加固只加「不可判」信号,不删数据', () => {
  const bytes = synthArchive();
  const d = decodeWorldArchive(bytes);
  eq(d.trim, null, '夹具:未裁剪 ⇒ 头里没有 trim');
  eq(d.chunksChecksumOk, null, '夹具:未裁剪 ⇒ 也没有摘要(旧字节形态)');
  eq(d.chunks.length, FIXTURE_CHUNKS, '★ 6 块一块不少');

  /* 往返:同一份世界 encode(decode(x)) 必须逐字节回到 x(加固不许改写入侧字节)。 */
  const again = encodeWorldArchive({
    version: d.version,
    world: d.world,
    players: d.players,
    fluid: d.fluid,
    mobs: d.mobs,
    ground: d.ground,
    chunks: d.chunks.map((x) => ({ cx: x.cx, cy: x.cy, bytes: x.bytes })),
    trim: d.trim,
  });
  eq(again.byteLength, bytes.byteLength, '★ 往返后字节数不变');
  let same = true;
  for (let i = 0; i < bytes.byteLength; i += 1) if (bytes[i] !== again[i]) same = false;
  ok(same, '★ encode(decode(x)) 逐字节等于 x');

  /* 计划自足:ops 只由归档决定 ⇒ 1 条 world + 6 条 chunk(字面量)。 */
  const plan = planRestore(d, null);
  eq(plan.ops.length, 7, '★ ops = 1(world) + 6(chunk)');
  eq(plan.ops.filter((o) => o.kind === 'chunk').length, FIXTURE_CHUNKS, '6 条 chunk op');
  eq(plan.missing.length, 0, '没有摘要 ⇒ 逐块清单为空(不伪造)');
  ok(plan.unavailable.some((u) => u.startsWith('chunks:')), '★ 「不可判」是信号,不是删数据');
});

report('WS-FND-116');
