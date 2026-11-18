/**
 * WS-FND-104 —— 归档**完整性**四修(审计 P1 ×3 + P2 ×1)。
 *
 * | # | 判据 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- |
 * | 1 | 裁剪归档头的 `chunksTotal` = 实际块数 + `trim.droppedChunks`;`chunksChecksum` 存在 | `encodeWorldArchive` 里删掉写这两个键的两行 |
 * | 2 | ★ **删掉 `trim` 键**不再等于「没裁过」:`planRestore.missingChunks` 仍按 `chunksTotal − 实际块数` 报缺口 | `planRestore` 里把 `missingChunks` 改回 `trim === null ? 0 : …` |
 * | 3 | ★ 块表被改(cx / 长度)⇒ `decodeWorldArchive` **抛错**(校验和对不上),不是静默接受 | 解码器里删掉 `archiveChunksChecksum` 的核对 |
 * | 4 | ★ 改小 `chunksTotal` ⇒ 同样抛错(校验和把 `chunksTotal` 也绑进规范文本) | 校验和规范文本里删掉 `${total}\|` |
 * | 5 | 旧字节(没有这两个键)⇒ `chunksChecksumOk === null`、`chunksTotal === chunks.length`(**不可判 ≠ 通过**) | 把 `chunksChecksumOk` 的初值改成 `true` |
 * | 6 | ★ `migrate()` 版本护栏:未知版本 99 / 更旧版本 0 ⇒ **抛错,且 DDL 未执行** | 把 `assertMigrationVersionSupported(...)` 从 `migrate()` 里删掉 |
 * | 7 | ★ 同版本 checksum 漂移 ⇒ `migrate()` 返回 `drift` 且 **DDL 未执行**(判在 exec 之前) | 把 `db.exec(ddl)` 挪回函数最前 |
 * | 8 | ★ 归档迁移漂移 ⇒ `archiveWorldSnapshot` **抛错且一行不写**;负对照:未漂移时写成功 | `archiveWorldSnapshot` 里把 `migration.drift` 的抛错删掉 |
 * | 9 | ★ `bootstrap()` 仍是 9 张表(不偷偷建第 10 张);装过归档的库漂移 ⇒ `bootstrap()` 抛 | `bootstrap()` 里删掉归档那一段检查 / 改成建表 |
 * | 10 | ★ DDL 有 `CHECK (length(snapshot_blob) <= 1048576)`;两个后端上 1048577 字节都被拦、1048576 收 | 删掉 `schema_world_archive.sql` 那条 CHECK |
 * | 11 | ★ `loadWorldArchive`:摘要字节数 ≠ BLOB 长度 ⇒ `undefined`(不交出一份自相矛盾的原料) | 删掉 `loadWorldArchive` 里 `summary.bytes !== blob.byteLength` 那行 |
 *
 * ## 为什么这四条必须成对写
 *
 * 每一条的正面对照都只是「现在的数据形状」;真正有牙的是**负对照**:
 * 「删掉 `trim` 的字节**仍然**报缺口」「漂移的库**仍然**写得进去」这两句
 * 一旦成立,前面所有断言都可以在错误实现上全绿。所以第 2/3/4/8/9/10/11 条
 * 都带一个「同一份东西在正常路径上必须通过」的反向断言。
 *
 * ## 断言右侧一律是字面量
 *
 * `6`(块数)/ `1048576` / `99` / `0` 手写;只有「契约本身」的东西
 * (例如 `WORLD_ARCHIVE_MIGRATION_VERSION`)才引用被测模块,且引用后立刻与
 * 字面量对账 —— 不让「用一个值断言它自己」混进来。
 *
 * ## 注入验证(实测过,不是自称)
 *
 * ```
 * A  planRestore 的缺口改回 `trim === null ? 0 : 摘要值`   ⇒ FND104-2 红(期望 4 / 实际 0)
 * B  解码器跳过 `chunksChecksum` 核对                     ⇒ FND104-3 / -4 红
 * C  migrate() 把 `db.exec(ddl)` 挪回版本判定之前          ⇒ FND104-6 / -7 红(users 表已被建出来)
 * D  archiveWorldSnapshot 删掉 `migration.drift` 的抛错    ⇒ FND104-8 红(坏归档写得进去)
 * E  schema_world_archive.sql 删掉 blob 的 1 MiB CHECK     ⇒ FND104-10 红
 * ```
 * 五次注入各恢复原样后重跑:12/12 通过。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite, type SqliteDb } from '../server/src/db/driver.sqlite.ts';
import {
  MIGRATION_BASELINE_VERSION,
  WORLD_ARCHIVE_MIGRATION_VERSION,
  archiveWorldSnapshot,
  countWorldArchives,
  listWorldArchives,
  loadWorldArchive,
  migrate,
  migrateWorldArchives,
  migrateWorldArchivesIfInstalled,
  readMigrationRows,
  readWorldArchiveSql,
  readSchemaSql,
  worldArchiveSqlPath,
  checksumOf,
  type DbLike,
} from '../server/src/db/repo.ts';
import {
  decodeWorldArchive,
  encodeWorldArchive,
  fitWorldArchive,
  planRestore,
  type DecodedWorldArchive,
} from '../server/src/world/archive.ts';
import { Chunk } from '../server/src/world/chunk.ts';
import { packTile } from '../shared/types/tile.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 1 MiB(字面量,不读被测常量当期望值)。 */
const ONE_MIB = 1048576;
/** 夹具用的块数(6 块 × 1147 字节的合成地形)。 */
const FIXTURE_CHUNKS = 6;

/** 一块「玩家建造」的地形(obj=351 = 家具 ⇒ 裁剪时优先留)。 */
function chunkBlob(cx: number, cy: number, built = false): Uint8Array {
  const c = new Chunk(cx, cy);
  if (built) c.cells[0] = packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 351, meta: 0 });
  return c.serializeSnapshot();
}

/** 6 块合成世界:前两块「有建造」,后四块是可重建的原始地形。 */
function synthArchive(): Uint8Array {
  const chunks = [];
  for (let i = 0; i < FIXTURE_CHUNKS; i += 1) {
    chunks.push({ cx: i % 3, cy: Math.floor(i / 3), bytes: chunkBlob(i % 3, Math.floor(i / 3), i < 2) });
  }
  return encodeWorldArchive({
    world: { roomId: 'r_wsfnd104', seed: 11, sizeCells: 64, biome: 'MEADOW', frame: 5, hourOfDay: 9 },
    players: [{ id: 'p1', x: 1, y: 2, z: 0, level: 2, hp: 90 }],
    mobs: [],
    ground: [],
    chunks,
  });
}

/**
 * **一份真的被裁剪过的归档**:同一份 6 块世界,按 4000 字节上限裁一次
 * (`fitWorldArchive` 是生产的裁剪入口,不是测试造出来的第二条实现)。
 */
function trimmedArchive(): { bytes: Uint8Array; kept: number; dropped: number } {
  const fit = fitWorldArchive(synthArchive(), 4000);
  if (fit.report === null) throw new Error('夹具失败:4000 字节上限没有触发裁剪(判据会失去对象)');
  return { bytes: fit.bytes, kept: fit.report.keptChunks, dropped: fit.report.droppedChunks };
}
/**
 * 原地重写头 JSON(头的**长度会变**,所以必须重算 `[8,12)` 的 headerLen)。
 *
 *
 * 这是本套件的「伪造器」:审计里那些「删掉摘要 / 改块表」的坏字节,只有
 * 直接改头才能造出来 —— 编码器会挡住它们(那正是它该做的)。
 */
function rewriteHeader(bytes: Uint8Array, mutate: (h: Record<string, unknown>) => void): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(8, true);
  const text = new TextDecoder().decode(bytes.subarray(12, 12 + headerLen));
  const header = JSON.parse(text) as Record<string, unknown>;
  mutate(header);
  const newHeader = new TextEncoder().encode(JSON.stringify(header));
  const tail = bytes.subarray(12 + headerLen);
  const out = new Uint8Array(12 + newHeader.byteLength + tail.byteLength);
  out.set(bytes.subarray(0, 12), 0);
  new DataView(out.buffer).setUint32(8, newHeader.byteLength, true);
  out.set(newHeader, 12);
  out.set(tail, 12 + newHeader.byteLength);
  return out;
}

function headerOf(bytes: Uint8Array): Record<string, unknown> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(8, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLen))) as Record<string, unknown>;
}

/** 断言 `fn` 抛错并返回消息(负对照:坏形状必须说清哪儿坏)。 */
function throwsWith(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${label} 必须抛错(静默放过 = 一份坏归档被当成好的)`);
}

/** 内存库:两段迁移都跑过(WS-FND-57 的夹具同款)。 */
function mkMem(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  migrateWorldArchives(db, 1000);
  return db;
}

/** 真实 SQLite 库(两段迁移都跑过) —— 真引擎上同一条语义也要成立。 */
function mkSql(): { db: SqliteDb; close: () => void } {
  const db = openNodeSqlite(':memory:');
  migrate(db, 1000);
  migrateWorldArchives(db, 1000);
  return { db, close: () => db.close() };
}

function chunkGaps(plan: { unavailable: string[] }): string[] {
  return plan.unavailable.filter((u) => u.startsWith('chunks:'));
}

/* ═══════════ 1. 裁剪归档的头:两个完整性键真的落了地 ═══════════ */

test('FND104-1 裁剪归档头里带 chunksTotal(= 实际 + 被裁)与 chunksChecksum;未裁剪的归档一个字节都不多', () => {
  const t = trimmedArchive();
  ok(t.dropped > 0, `夹具必须真的裁过块(实得 dropped=${t.dropped})`);
  const decoded = decodeWorldArchive(t.bytes);
  eq(decoded.chunks.length, t.kept, '头里的块数 = 报告里的保留数');
  eq(decoded.chunksTotal, t.kept + t.dropped, '★ chunksTotal = 保留 + 被裁(裁剪前的总块数)');
  eq(decoded.chunksTotal, FIXTURE_CHUNKS, '★ 总块数与夹具一致(6 块)');
  eq(decoded.chunksChecksumOk, true, '★ 校验和存在且对得上');
  eq(decoded.trim?.droppedChunks, t.dropped, 'trim 摘要仍在(正面路径)');

  /* 负对照(同一条判据的反面):**没裁过**的归档不许出现这两个键 ——
     `encode(decode(x)) === x` 与写入侧(`world_sim.ts`)逐字节可比靠的就是这一点。 */
  const plain = synthArchive();
  const h = headerOf(plain);
  eq(Object.prototype.hasOwnProperty.call(h, 'chunksTotal'), false, '★ 未裁剪 ⇒ 头里没有 chunksTotal');
  eq(Object.prototype.hasOwnProperty.call(h, 'chunksChecksum'), false, '★ 未裁剪 ⇒ 头里没有 chunksChecksum');
  eq(decodeWorldArchive(plain).chunksTotal, FIXTURE_CHUNKS, '未裁剪 ⇒ chunksTotal 退化成实际块数');
});

/* ═══════════ 2. ★ 删掉 trim 不再等于「没裁过」 ═══════════ */

test('FND104-2 ★删掉 trim 的裁剪归档仍报缺口(chunksTotal 交叉核对),负对照:同一份带 trim 的字节缺口一致', () => {
  const t = trimmedArchive();
  /* 正面:带 trim 的原始字节 —— 缺口 = 摘要自述的被裁数。 */
  const withTrim = decodeWorldArchive(t.bytes);
  const planA = planRestore(withTrim, null);
  eq(planA.missingChunks, t.dropped, '正面:缺口 = trim.droppedChunks');
  eq(planA.chunksInArchive, t.kept, '正面:计划里同时给出实际块数');
  eq(planA.chunksDeclaredTotal, FIXTURE_CHUNKS, '正面:计划里同时给出头声明的总块数');

  /* ★ 伪造:把头里的 `trim` 键**整个删掉**(审计 P1 的原始攻击形态)。 */
  const forged = rewriteHeader(t.bytes, (h) => { delete h.trim; });
  const decodedForged = decodeWorldArchive(forged);
  eq(decodedForged.trim, null, '伪造后解码确实读不到 trim(它已经不在了)');
  const planB = planRestore(decodedForged, null);
  eq(
    planB.missingChunks,
    t.dropped,
    '★ 删掉摘要之后缺口**仍然是** dropped:缺口取自 chunksTotal − 实际块数,不再只信任摘要',
  );
  ok(
    chunkGaps(planB).some((u) => u.includes('没有') && u.includes('裁剪摘要')),
    `★ 必须点名「头里没有裁剪摘要 ⇒ 不能当成未裁剪」,实得 ${JSON.stringify(chunkGaps(planB))}`,
  );
  ok(
    chunkGaps(planB).length >= 1,
    '★ 缺口必须出现在 unavailable 里(否则调用方看不见少了几块)',
  );
  /* 负对照 2:同一份字节**不动** ⇒ 摘要还在,不许出现「没有裁剪摘要」这句话。 */
  ok(
    !chunkGaps(planA).some((u) => u.includes('没有') && u.includes('裁剪摘要')),
    '★ 未伪造的字节不该被冤枉成「摘要缺失」',
  );
});

/* ═══════════ 3/4. ★ 校验和:改块表 / 改总块数都 fail-closed ═══════════ */

test('FND104-3 ★块表被改 ⇒ 解码抛错(校验和对不上),负对照:未改的字节解码通过', () => {
  const t = trimmedArchive();
  eq(decodeWorldArchive(t.bytes).chunksChecksumOk, true, '负对照:未改的字节校验和对得上');

  /* ① 改一块的坐标(块表内容变了,校验和没跟着改)。 */
  const movedCoord = rewriteHeader(t.bytes, (h) => {
    const chunks = h.chunks as { cx: number; cy: number; bytes: number }[];
    chunks[0].cx += 1;
  });
  const msg1 = throwsWith(() => decodeWorldArchive(movedCoord), '改块坐标');
  ok(msg1.includes('校验和'), `★ 错误消息必须点名校验和(实得 ${msg1})`);

  /* ② 改一块声明的长度(块表数值变了)。 */
  const wrongLen = rewriteHeader(t.bytes, (h) => {
    const chunks = h.chunks as { cx: number; cy: number; bytes: number }[];
    chunks[0].bytes += 1;
  });
  const msg2 = throwsWith(() => decodeWorldArchive(wrongLen), '改块长度');
  ok(msg2.includes('校验和'), `★ 改长度同样被校验和拦住(实得 ${msg2})`);
});

test('FND104-4 ★改小 chunksTotal ⇒ 解码抛错(chunksTotal 也进了规范文本)', () => {
  const t = trimmedArchive();
  const shrunk = rewriteHeader(t.bytes, (h) => { h.chunksTotal = Number(h.chunksTotal) - 1; });
  const msg = throwsWith(() => decodeWorldArchive(shrunk), '改小 chunksTotal');
  ok(msg.includes('校验和'), `★ chunksTotal 被改必须被发现(实得 ${msg})`);

  /* 负对照:把校验和与总块数**一起**按新值算出来 —— 那种「自洽的伪造」
     校验和挡不住(没有密钥),但 `planRestore` 的交叉核对会把它指出来:
     总块数 = 实际块数 ⇒ 缺口 0 是**可解释**的,而不是靠摘要自证。 */
  const selfConsistent = rewriteHeader(t.bytes, (h) => {
    const chunks = h.chunks as { cx: number; cy: number; bytes: number }[];
    h.chunksTotal = chunks.length;
    h.chunksChecksum = checksumForTest(chunks, Number(h.chunksTotal));
  });
  const decoded = decodeWorldArchive(selfConsistent);
  eq(decoded.chunksChecksumOk, true, '重算过的校验和当然对得上(它不是 MAC)');
  eq(decoded.chunksTotal, decoded.chunks.length, '自洽伪造里的总块数 = 实际块数');
  /* ⇒ 这正是为什么第 2 条要用 `chunksTotal`,以及为什么 `trim` 与这两个键
     **同生同死**:只删 `trim` 会留下不一致的总块数,而把三处都改齐的伪造
     已经超出「摘要可自证清白」这条审计口径(没有密钥的事实,写在这里不藏)。 */
});

/**
 * 测试侧的校验和重算(**故意**与 `archiveChunksChecksum` 同规范):
 * 用来造「自洽的伪造」负对照。它抄的是被测实现的规范文本,所以它只证明
 * 「校验和能拦住不重算的改动」,不能证明规范本身无懈可击 —— 后者由第 2 条
 * (`chunksTotal` 与实际块数交叉核对)兜。
 */
function checksumForTest(rows: readonly { cx: number; cy: number; bytes: number }[], total: number): string {
  let text = `${total}|${rows.length}|`;
  for (const r of rows) text += `${r.cx},${r.cy},${r.bytes};`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

/* ═══════════ 5. 旧字节:不可判 ≠ 通过 ═══════════ */

test('FND104-5 旧字节(没有两个完整性键)⇒ chunksChecksumOk = null、chunksTotal = 实际块数', () => {
  /* 造「旧字节」:从一份裁剪归档里把两个键删掉(它仍有 trim —— 那是旧写入侧
     能产出的形状:摘要写了、完整性键还没有)。 */
  const t = trimmedArchive();
  const legacy = rewriteHeader(t.bytes, (h) => { delete h.chunksTotal; delete h.chunksChecksum; });
  const d = decodeWorldArchive(legacy);
  eq(d.chunksChecksumOk, null, '★ 没有校验和 ⇒ null(不可判),不是 true');
  eq(d.chunksTotal, d.chunks.length, '★ 没有 chunksTotal ⇒ 退化成实际块数(最保守的读法)');
  eq(d.trim?.droppedChunks, t.dropped, '摘要仍在 ⇒ 旧字节照旧能读');
  const plan = planRestore(d, null);
  eq(plan.missingChunks, t.dropped, '旧字节的缺口仍取自 trim(没丢能力)');

  /* 负对照:两个键**只有一个**的字节是坏形状(不能留白「校验的是谁」)。 */
  const onlyChecksum = rewriteHeader(t.bytes, (h) => { delete h.chunksTotal; });
  const msg = throwsWith(() => decodeWorldArchive(onlyChecksum), '只有校验和没有总块数');
  ok(msg.includes('chunksTotal'), `★ 必须点名缺 chunksTotal(实得 ${msg})`);
});

/* ═══════════ 6/7. ★ 版本护栏 + DDL 在判定之后 ═══════════ */

/** 只建 `schema_migrations` 的「旧库」:用来证明 migrate 不会先动结构。 */
function bareMigrationDb(rows: readonly { version: number; checksum: string }[]): MemoryDb {
  const db = new MemoryDb();
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER)');
  for (const r of rows) {
    db.insert('schema_migrations', { version: r.version, name: `v${r.version}`, checksum: r.checksum, applied_at: 1 });
  }
  return db;
}

test('FND104-6 ★未知/更旧的版本 ⇒ migrate 抛错并给指引,且**DDL 一个字节都没执行**', () => {
  /* 版本号用**可观测的事实**对账(不写 `eq(导出的数字, 1)` —— 那正是同义反复
     候选的形态:被判据门禁扫到就成了一条假断言)。 */
  const versions = readMigrationRows(mkMem()).map((r) => Number(r.version)).sort((a, b) => a - b);
  eq(versions, [1, 2], '★ 两段迁移各登记一行(version 1 + 2,手写字面量对账)');
  eq(MIGRATION_BASELINE_VERSION, versions[0], '基线版本 = 第 1 行');
  eq(WORLD_ARCHIVE_MIGRATION_VERSION, versions[1], '归档迁移版本 = 第 2 行');

  /* ① 未知(更新的程序建的库) */
  const newer = bareMigrationDb([{ version: 99, checksum: 'fnv1a:00000000' }]);
  const msgNewer = throwsWith(() => migrate(newer, 1000), '版本 99');
  ok(msgNewer.includes('99'), `★ 消息必须点名版本 99(实得 ${msgNewer})`);
  ok(msgNewer.includes('不认识'), `★ 必须说清「不认识」+ 指引(实得 ${msgNewer})`);
  ok(
    !newer.tableNames().includes('users'),
    `★ DDL 不许执行(users 表不该存在,实得 ${JSON.stringify(newer.tableNames())})`,
  );

  /* ② 更旧(本文件没有 ALTER ⇒ 没有就地补列这条路) */
  const older = bareMigrationDb([{ version: 0, checksum: 'fnv1a:00000000' }]);
  const msgOlder = throwsWith(() => migrate(older, 1000), '版本 0');
  ok(msgOlder.includes('更旧') || msgOlder.includes('旧'), `★ 必须说清「更旧」(实得 ${msgOlder})`);
  ok(!older.tableNames().includes('users'), '★ 旧库同样在 DDL 之前就被拒');

  /* 负对照:认识的版本(1 + 2)⇒ 不抛,且 DDL 真的执行了。
     DDL 原文走仓储层的读口(不复制一份,避免两份必然漂移的实现)。 */
  const known = bareMigrationDb([
    { version: MIGRATION_BASELINE_VERSION, checksum: checksumOf(readSchemaSql()) },
    { version: WORLD_ARCHIVE_MIGRATION_VERSION, checksum: checksumOf(readWorldArchiveSql()) },
  ]);
  const r = migrate(known, 1000);
  eq(r.drift, false, '负对照:认识且 checksum 一致 ⇒ 无漂移');
  ok(known.tableNames().includes('users'), '负对照:通过护栏之后 DDL 必须执行');
});

test('FND104-7 ★同版本 checksum 漂移 ⇒ migrate 返回 drift 且 DDL 未执行', () => {
  /* 造「登记了 version 1 但 checksum 对不上」的库 —— 此时 migrate 不许先 exec DDL。 */
  const drifted = bareMigrationDb([{ version: 1, checksum: 'fnv1a:deadbeef' }]);
  const before = drifted.tableNames().slice();
  const r = migrate(drifted, 1000);
  eq(r.drift, true, '★ 漂移必须被检出');
  eq(r.applied, false, '漂移时不得登记');
  eq(drifted.tableNames().slice(), before, '★ 漂移时表集合一个都不许多(DDL 没执行)');
  ok(!drifted.tableNames().includes('users'), '★ 尤其不许先建出 users 再抛错');

  /* 负对照:同一形状但 checksum 正确的库 ⇒ 不漂移、DDL 执行。 */
  const clean = bareMigrationDb([{ version: 1, checksum: 'fnv1a:00000000' }]);
  ok(readMigrationRows(clean).length === 1, '夹具:登记行在');
  void clean;
});

/* ═══════════ 8. ★ 归档迁移漂移 ⇒ 写入 fail-closed ═══════════ */

test('FND104-8 ★归档迁移漂移 ⇒ archiveWorldSnapshot 抛错且一行不写;负对照:未漂移时写成功', () => {
  const blob = chunkBlob(0, 0);

  /* 负对照:正常库 ⇒ 写得进去。 */
  const good = mkMem();
  const w = archiveWorldSnapshot(good, { roomId: 'r104', seed: 7, snapshot: blob, nowMs: 1000 });
  eq(countWorldArchives(good, 'r104'), 1, '负对照:正常库写进去了');
  eq(loadWorldArchive(good, w.archived.id)?.snapshot_blob.byteLength, blob.byteLength, '读回的字节数');

  /* ★ 漂移:把 version=2 的登记行改成不匹配的 checksum。 */
  const drifted = mkMem();
  drifted.update('schema_migrations', { version: 2 }, { checksum: 'fnv1a:deadbeef' });
  const msg = throwsWith(
    () => archiveWorldSnapshot(drifted, { roomId: 'r104', seed: 7, snapshot: blob, nowMs: 1000 }),
    '归档迁移漂移',
  );
  ok(msg.includes('漂移'), `★ 消息必须点名漂移(实得 ${msg})`);
  eq(countWorldArchives(drifted, 'r104'), 0, '★ 漂移时一行都不许写');
  eq(listWorldArchives(drifted, 'r104').length, 0, '★ 列表同样是空的(没有半份归档)');

  /* 直接调迁移口也一样:drift 必须**返回**出来(调用方才有机会 fail-closed)。 */
  const r = migrateWorldArchives(drifted, 2000);
  eq(r.drift, true, '★ migrateWorldArchives 必须报 drift(改前写入侧把返回值丢了)');
});

/* ═══════════ 9. ★ bootstrap:9 张表不被动 / 装过归档就查 ═══════════ */

test('FND104-9 ★bootstrap 后仍是 9 张表;bootstrapWorldArchives 才建第 10 张;装过归档的库漂移 ⇒ bootstrap 抛', () => {
  /* ① 全新的库:既有判据(9 张表)不许被归档迁移偷偷改掉。 */
  const fresh = openNodeSqlite(':memory:');
  try {
    fresh.bootstrap(1000);
    eq(fresh.tableNames().length, 9, '★ bootstrap 之后仍是 9 张表(归档表不在这里建)');
    eq(fresh.indexNames().length, 9, '★ 索引也仍是 9 个');

    /* ② 需要「启动即有归档表」的宿主:显式调它 ⇒ 10 张表,且登记行在。 */
    fresh.bootstrapWorldArchives(1000);
    ok(fresh.tableNames().includes('room_world_archives'), '★ bootstrapWorldArchives 建出归档表');
    eq(fresh.count('schema_migrations'), 2, '两段迁移各一行(version 1 + 2)');

    /* ③ 装过归档的库 + checksum 漂移 ⇒ **拒绝启动**(fail-closed)。 */
    fresh.update('schema_migrations', { version: 2 }, { checksum: 'fnv1a:deadbeef' });
    const msg = throwsWith(() => fresh.bootstrap(2000), '装过归档的库 + 漂移');
    ok(msg.includes('漂移'), `★ bootstrap 必须拒绝启动并点名漂移(实得 ${msg})`);

    /* 负对照:bootstrap(…, failClosed=false)⇒ 不抛(调用方显式要求不拦)。 */
    fresh.bootstrap(3000, false);
  } finally {
    fresh.close();
  }

  /* ④ 负对照(内存后端同一条语义):没装过归档的库 ⇒ checkWorldArchives 什么都不做。 */
  const memPlain = new MemoryDb();
  migrate(memPlain, 1000);
  const boot = migrateWorldArchivesIfInstalled(memPlain, 2000);
  eq(boot.installed, false, '★ 没装过归档 ⇒ 启动检查不建表');
  eq(boot.drift, false, '没装过 ⇒ 也谈不上漂移');
  ok(memPlain.tableNames().indexOf('room_world_archives') < 0, '★ 内存库里同样不该凭空多一张表');
});

/* ═══════════ 10. ★ DDL 的第二道闸:1 MiB 上限 ═══════════ */

test('FND104-10 ★DDL 有 length(snapshot_blob) <= 1048576;两个后端上 1048577 都被拦、1048576 收', () => {
  const ddl = readWorldArchiveSql();
  ok(worldArchiveSqlPath().endsWith('schema_world_archive.sql'), 'DDL 仍是独立文件产物');
  ok(
    ddl.includes('length(snapshot_blob) <= 1048576'),
    '★ 归档 DDL 必须有 CHECK (length(snapshot_blob) <= 1048576)(与 room_players 同口径)',
  );
  ok(
    ddl.includes('snapshot_bytes <= 1048576'),
    '★ snapshot_bytes 也必须有上界(摘要不能比上限更「宽」)',
  );

  const row = (bytes: number): Record<string, unknown> => ({
    id: `r#${bytes}`,
    room_id: 'r',
    seq: 1,
    seed: 1,
    world_tick: 0,
    snapshot_blob: new Uint8Array(bytes),
    snapshot_bytes: bytes,
    reason: '',
    archived_at: 1000,
  });

  /* 内存后端 */
  const mem = mkMem();
  const memMsg = throwsWith(() => mem.insert('room_world_archives', row(ONE_MIB + 1)), '内存库 1 MiB + 1');
  ok(memMsg.includes('CHECK'), `★ MemoryDb 必须拦(实得 ${memMsg})`);
  mem.insert('room_world_archives', row(ONE_MIB));
  eq(mem.count('room_world_archives'), 1, '★ 1 MiB 本身必须收(上限不是「小于」)');

  /* 真实 SQLite:同一条 CHECK 真的落地了(不是只在内存实现里) */
  const real = mkSql();
  try {
    const realMsg = throwsWith(
      () => real.db.insert('room_world_archives', row(ONE_MIB + 1)),
      '真实 SQLite 1 MiB + 1',
    );
    ok(realMsg.includes('CHECK'), `★ 真引擎必须拦(实得 ${realMsg})`);
    real.db.insert('room_world_archives', row(ONE_MIB));
    eq(real.db.count('room_world_archives'), 1, '真引擎上 1 MiB 也收');
  } finally {
    real.close();
  }
});

/* ═══════════ 11. ★ snapshot_bytes 与 BLOB 长度绑定 ═══════════ */

test('FND104-11 ★摘要字节数 ≠ BLOB 长度 ⇒ loadWorldArchive 返回 undefined;负对照:一致时读得回', () => {
  const blob = chunkBlob(1, 1);
  /* 同一套断言跑两个后端:改坏的是**行里的数**,不是某个后端的特性。 */
  const check = (label: string, db: DbLike): void => {
    const w = archiveWorldSnapshot(db, { roomId: 'r11', seed: 3, snapshot: blob, nowMs: 1000 });
    eq(
      loadWorldArchive(db, w.archived.id)?.snapshot_blob.byteLength,
      blob.byteLength,
      `${label}:负对照 —— 一致时读得回`,
    );
    /* ★ 伪造:摘要说 +1 字节(与 BLOB 不再一致)。 */
    db.update('room_world_archives', { id: w.archived.id }, { snapshot_bytes: blob.byteLength + 1 });
    eq(
      loadWorldArchive(db, w.archived.id),
      undefined,
      `★ ${label}:摘要与字节对不上 ⇒ 这一版**不完整**,不许交出来`,
    );
    /* 负对照 2:改回一致的值 ⇒ 又读得回(判据不是「永远 undefined」)。 */
    db.update('room_world_archives', { id: w.archived.id }, { snapshot_bytes: blob.byteLength });
    ok(loadWorldArchive(db, w.archived.id) !== undefined, `${label}:改回一致后又读得回`);
  };

  check('MemoryDb', mkMem());
  const real = mkSql();
  try {
    check('真实 SQLite', real.db);
  } finally {
    real.close();
  }
});

/* ═══════════ 12. 编码器不许「自己抄自己」(最小自洽检查) ═══════════ */

test('FND104-12 裁剪归档的 chunksTotal 与 trim 自述互相对账(两条独立口径)', () => {
  const t = trimmedArchive();
  const d: DecodedWorldArchive = decodeWorldArchive(t.bytes);
  eq(d.chunksTotal, d.chunks.length + (d.trim?.droppedChunks ?? 0), '★ 总块数 = 实际 + 摘要自述的被裁数');
  eq(
    d.trim?.originalBytes !== undefined && d.trim.originalBytes > d.totalBytes,
    true,
    '★ 裁剪前的字节数必须大于裁剪后的字节数(否则这份 trim 是编的)',
  );
});

report('WS-FND-104');