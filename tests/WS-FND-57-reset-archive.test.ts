/**
 * WS-FND-57 —— **世界归档存储**(D-06:`RESET_WORLD` 的存档政策 = 归档)。
 *
 * ## 这个套件钉的是什么
 *
 * 裁决原文(`docs/DECISIONS.md` **D-06**):
 *   「世界按新 seed 在内存重建,**旧世界存成一份可回滚快照行**(不删、也不原地不管)」
 *
 * 本套件只测**存储那一半**(`server/src/db/repo.ts` §13 + `schema_world_archive.sql`)
 * 与动作层新增的**归档回执**(`net/actions/reset_world.ts`)。
 * **不测**:`WorldSim.resetWorld` 的内存重建(= 宿主那一半,别人在做)、
 * "回滚写入"(D-06 没裁)。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 归档一行能被**读回**,字段齐全(id/seed/时间/字节数/…)+ 字节逐位相同 | 少写一列 / 摘要漏字段 / BLOB 没存 |
 * | 2 | 同一房间连归档两次 ⇒ **两行**、seed 不同、**旧行仍在**(不覆盖) | 用 `INSERT OR REPLACE` / 按房间 upsert / 复用 seq |
 * | 3 | `listWorldArchives` **时间倒序**(同毫秒用 seq 兜底) | 正序返回 / 只按插入顺序 |
 * | 4 | 配额(`WORLD_ARCHIVE_KEEP_PER_ROOM` = 6)生效:归档 8 次仍留**最近 6** 条 | 根本不裁 / 裁错方向(把新的裁掉) |
 * | 5 | **负对照**:没归档过 ⇒ **空数组**(不是 undefined、不抛错) | 返回 undefined / 表没建就抛 |
 * | 6 | **真实 SQLite**(`node:sqlite`,Node 24 内置)上同一套行为成立 | 只在内存实现里对(DDL 或 BLOB 在真库上不通) |
 * | 7 | 动作层回执:`ARCHIVED` / `NOT_ARCHIVED` / `UNREPORTED` **三态**不合并 | 把"宿主没报告"写成"没归档" |
 *
 * ## 断言右侧一律是**字面量**
 * 不取被测模块的导出常量(否则是"用一个值断言它自己");配额写 `6` 而不是
 * `WORLD_ARCHIVE_KEEP_PER_ROOM` —— 常量被偷偷改成 8 时,这里必须**先红**。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { resetWorld } from '../server/src/net/actions/reset_world.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  archiveWorldSnapshot,
  countWorldArchives,
  listWorldArchives,
  loadWorldArchive,
  migrate,
  migrateWorldArchives,
  readSchemaSql,
  schemaSqlPath,
  worldArchiveSqlPath,
  type DbLike,
} from '../server/src/db/repo.ts';

/* ───────────────────────── 两个后端 ───────────────────────── */

/** 内存实现:与生产同一份 `DbLike` 语义(见 `memory_db.ts` 文件头)。 */
function makeMemoryDb(): DbLike {
  const db = new MemoryDb();
  migrate(db, 1000);
  migrateWorldArchives(db, 1000);
  return db;
}

/** 真实 SQLite(`node:sqlite`):证明 DDL / BLOB / 排序在**真引擎**上也成立。 */
function makeRealDb(): { db: DbLike; close: () => void } {
  const db = openNodeSqlite(':memory:');
  migrate(db, 1000);
  migrateWorldArchives(db, 1000);
  return { db, close: () => db.close() };
}

/** 定长快照(内容随 `tag` 变,便于逐位比较)。 */
function blob(tag: number, bytes = 16): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = (tag + i) & 0xff;
  return out;
}

/* ───────────────────────── 1. 一行可读回 ───────────────────────── */

test('FND57-1 归档一行能被读回:摘要字段齐全,字节逐位相同', () => {
  const db = makeMemoryDb();
  const snap = blob(7, 24);

  const out = archiveWorldSnapshot(db, {
    roomId: 'r1',
    seed: 4242,
    snapshot: snap,
    nowMs: 1_700_000_000_000,
    worldTick: 912,
    reason: 'RESET_WORLD',
  });

  /* 写入回执本身也得可信 —— 它是回执里 `archiveId`/`archiveBytes` 的来源。 */
  eq(out.archived.seed, 4242, '回执里的 seed = **旧世界**的种子');
  eq(out.archived.bytes, 24, '回执里的 bytes = 快照字节数');
  eq(out.pruned, 0, '第一次归档没有可裁的旧行');

  const rows = listWorldArchives(db, 'r1');
  eq(rows.length, 1, '一个房间一条归档');
  /* 字段**逐个**点名:漏一个字段就是回滚 UI 少一个信息。 */
  eq(Object.keys(rows[0]).sort(), [
    'archived_at', 'bytes', 'id', 'reason', 'room_id', 'seed', 'seq', 'world_tick',
  ], '摘要字段集合');
  eq(rows[0].id, 'r1#1', '句柄 = <room_id>#<seq>(回滚读口的钥匙)');
  eq(rows[0].room_id, 'r1', 'room_id');
  eq(rows[0].seq, 1, 'seq 从 1 起');
  eq(rows[0].seed, 4242, 'seed 是旧世界的种子');
  eq(rows[0].world_tick, 912, 'world_tick 原样保存');
  eq(rows[0].bytes, 24, 'bytes = 快照长度');
  eq(rows[0].reason, 'RESET_WORLD', 'reason 原样保存');
  eq(rows[0].archived_at, 1_700_000_000_000, 'archived_at = Unix 毫秒原值');

  /* 字节必须**逐位**读得回来 —— 摘要对而 BLOB 坏,回滚出去就是坏世界。 */
  const full = loadWorldArchive(db, rows[0].id)!;
  ok(full !== undefined, '按句柄应能取到完整归档行');
  eq(full.snapshot_blob.byteLength, 24, 'BLOB 长度');
  eq(Array.from(full.snapshot_blob), Array.from(snap), '★ BLOB 逐位相同(不是"长度对就行")');
});

/* ───────────────────────── 2. 幂等不覆盖 ───────────────────────── */

test('FND57-2 同一房间连续两次重置 ⇒ 两行、seed 不同、旧行**仍在**', () => {
  const db = makeMemoryDb();
  const first = archiveWorldSnapshot(db, { roomId: 'r2', seed: 111, snapshot: blob(1), nowMs: 1000 });
  const second = archiveWorldSnapshot(db, { roomId: 'r2', seed: 222, snapshot: blob(2), nowMs: 2000 });

  ok(first.archived.id !== second.archived.id, '两条归档不能共用一个句柄(那就是覆盖)');
  eq(second.pruned, 0, '配额内**不许**裁掉旧行(2 条 ≪ 6)');

  const rows = listWorldArchives(db, 'r2');
  eq(rows.length, 2, '★ 两次重置 = 两行(不是一次 upsert)');
  eq(rows.map((r) => r.seed), [222, 111], '两条各自的 seed,新的在前');
  eq(rows.map((r) => r.seq), [2, 1], 'seq 单调递增');

  /* 旧行不只是"还在列表里":它的字节也仍然可读回。 */
  const old = loadWorldArchive(db, first.archived.id)!;
  ok(old !== undefined, '★ 旧行必须仍然可读(不覆盖 = 真的一行没丢)');
  eq(Array.from(old.snapshot_blob), Array.from(blob(1)), '旧行的字节仍是**旧世界**的');
  eq(old.seed, 111, '旧行的 seed 没被新归档改写');
  eq(old.archived_at, 1000, '旧行的时间戳没被改写');
});

/* ───────────────────────── 3. 时间倒序 ───────────────────────── */

test('FND57-3 listWorldArchives 按时间**倒序**(乱序写入也一样)', () => {
  const db = makeMemoryDb();
  /* 故意乱序:先写最新的,再写中间的,最后写最旧的 —— 正序返回会露馅。 */
  archiveWorldSnapshot(db, { roomId: 'r3', seed: 300, snapshot: blob(3), nowMs: 3000 });
  archiveWorldSnapshot(db, { roomId: 'r3', seed: 100, snapshot: blob(1), nowMs: 1000 });
  archiveWorldSnapshot(db, { roomId: 'r3', seed: 200, snapshot: blob(2), nowMs: 2000 });

  eq(
    listWorldArchives(db, 'r3').map((r) => r.archived_at),
    [3000, 2000, 1000],
    '★ 按 archived_at 倒序(最近一版在最前 —— "回滚到上一版"就是 rows[0])',
  );

  /* 同一毫秒的两次归档:靠 seq 兜底,仍然是确定的倒序(不能依赖插入顺序)。 */
  const db2 = makeMemoryDb();
  archiveWorldSnapshot(db2, { roomId: 'r3', seed: 10, snapshot: blob(1), nowMs: 5000 });
  archiveWorldSnapshot(db2, { roomId: 'r3', seed: 20, snapshot: blob(2), nowMs: 5000 });
  eq(listWorldArchives(db2, 'r3').map((r) => r.seed), [20, 10], '同毫秒 ⇒ 后写的在前(seq 兜底)');

  /* 别的房间不串味。 */
  eq(listWorldArchives(db, 'r_other'), [], '按 roomId 隔离');
});

/* ───────────────────────── 4. 配额 ───────────────────────── */

test('FND57-4 配额生效:归档 8 次仍只留最近 6 条,且裁的是**旧的**', () => {
  const db = makeMemoryDb();
  const pruned: number[] = [];
  for (let i = 1; i <= 8; i += 1) {
    const r = archiveWorldSnapshot(db, {
      roomId: 'r4', seed: 1000 + i, snapshot: blob(i), nowMs: 10_000 + i,
    });
    pruned.push(r.pruned);
  }

  /* 前 6 次都在配额内(不许动旧行);第 7、8 次各裁掉 1 条。 */
  eq(pruned, [0, 0, 0, 0, 0, 0, 1, 1], '★ 裁剪从**超出那一刻**开始,一次只裁一条');
  eq(countWorldArchives(db, 'r4'), 6, '★ 表里实有 6 行(不是"列表截断了但表还在长")');

  const rows = listWorldArchives(db, 'r4');
  eq(rows.length, 6, '默认上限 = 6');
  eq(rows.map((r) => r.seed), [1008, 1007, 1006, 1005, 1004, 1003], '★ 留下的是**最近** 6 条');
  eq(rows[0].id, 'r4#8', '最新一条的句柄');

  /* 被裁的是最旧的两条 —— 方向反了("裁新的")会让回滚永远拿不到最近的版本。 */
  eq(loadWorldArchive(db, 'r4#1'), undefined, '★ 最旧的一条已被配额裁掉');
  eq(loadWorldArchive(db, 'r4#2'), undefined, '第二条旧的也被裁掉');
  ok(loadWorldArchive(db, 'r4#3') !== undefined, '第 3 条仍在(边界不能多裁)');

  /* 显式 limit 也要生效(读口默认被 N 截断,但调用方可以更窄)。 */
  eq(listWorldArchives(db, 'r4', 2).map((r) => r.seq), [8, 7], 'limit 参数生效');
  eq(listWorldArchives(db, 'r4', 0), [], 'limit=0 ⇒ 空列表(不抛错)');
});

/* ───────────────────────── 5. 负对照 ───────────────────────── */

test('FND57-5 负对照:没归档过 ⇒ **空数组**(不是 undefined、不抛错)', () => {
  const db = makeMemoryDb();
  const rows = listWorldArchives(db, 'r_never_archived');
  ok(Array.isArray(rows), '★ 必须返回数组');
  eq(rows, [], '★ 空列表');
  eq(countWorldArchives(db, 'r_never_archived'), 0, '计数 0');
  eq(loadWorldArchive(db, 'r_never_archived#1'), undefined, '不存在的句柄 ⇒ undefined(不是抛错)');

  /* 更狠的负对照:**表都还没建**(真实 SQLite 会抛 `no such table`)。
     这个读口会被回滚 UI 直接消费,"还没有归档能力"不该表现成一次崩溃;
     但**只有** no such table 被降级,别的错误照旧冒泡(见 repo.ts 注释)。 */
  const raw = openNodeSqlite(':memory:');
  try {
    migrate(raw, 1000);
    eq(listWorldArchives(raw, 'r_never'), [], '★ 归档表未建 ⇒ 仍然空列表,不抛');
    eq(countWorldArchives(raw, 'r_never'), 0, '计数 0');
  } finally {
    raw.close();
  }
});

/* ───────────────────────── 6. 真实 SQLite ───────────────────────── */

test('FND57-6 真实 SQLite(node:sqlite)上同一套行为成立', () => {
  const { db, close } = makeRealDb();
  try {
    /* DDL 真的落地了(不是只改了内存实现)。 */
    const real = db as unknown as { tableNames(): string[] };
    ok(real.tableNames().includes('room_world_archives'), '★ 真库里建出了归档表');
    const idx = (db as unknown as { indexNames(): string[] }).indexNames();
    ok(idx.includes('idx_room_world_archives_room'), '★ 真库里建出了按房间的倒序索引');
    eq(db.count('schema_migrations'), 2, '两段迁移各登记一行(version 1 + 2)');

    const snap = blob(9, 32);
    const a = archiveWorldSnapshot(db, { roomId: 'r6', seed: 77, snapshot: snap, nowMs: 1000 });
    const b = archiveWorldSnapshot(db, { roomId: 'r6', seed: 88, snapshot: blob(3, 8), nowMs: 2000 });

    eq(listWorldArchives(db, 'r6').map((r) => r.seed), [88, 77], '真引擎上的倒序');
    eq(loadWorldArchive(db, a.archived.id)?.snapshot_blob.byteLength, 32, '真引擎上的 BLOB 长度');
    eq(Array.from(loadWorldArchive(db, a.archived.id)?.snapshot_blob ?? []), Array.from(snap),
      '★ 真引擎上的 BLOB 逐位相同');
    eq(loadWorldArchive(db, b.archived.id)?.bytes, 8, '第二条的字节数摘要');

    /* 配额在真引擎上也生效(事务内 append+prune)。 */
    for (let i = 0; i < 6; i += 1) {
      archiveWorldSnapshot(db, { roomId: 'r6', seed: 500 + i, snapshot: blob(i + 1, 4), nowMs: 3000 + i });
    }
    eq(countWorldArchives(db, 'r6'), 6, '★ 真引擎上也会裁剪到 6 条');
    eq(listWorldArchives(db, 'r6').length, 6, '列表 6 条');
  } finally {
    close();
  }
});

/* ───────────────────────── 7. 动作层回执 ───────────────────────── */

type ResetHostResult = {
  applied: boolean;
  seed: number;
  reason?: string;
  archive?: { id: string; seed: number; archived_at: number; bytes: number } | null;
  archiveError?: string;
};

/**
 * 造一个**只够本动作用**的 `ActionContext`。
 *
 * 不装配整个 `RoomRuntime`:本套件测的是"归档回执怎么写进 effect",
 * 拉进编排层会把无关的可变状态带进来(`tests/WS-FND-34` 已经用真装配测过
 * 权限 / 确认 / 种子校验,那些本轮**不动**)。
 */
function makeCtx(reset: (o: { seed: number }) => ResetHostResult): ActionContext {
  const ctx = {
    actorId: 'p1',
    action: 'RESET_WORLD',
    payload: { confirm: true, seed: 4242 },
    state: {},
    host: { resetWorld: reset },
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: (_a: string, _b: string, reason?: string) => ({
      ok: false, kind: 'PERMISSION', reason: reason ?? 'PERMISSION',
    }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: () => ({ ok: true, applied: [], rejected: [] }),
    grantItemSource: () => undefined,
    setMemberRole: () => ({ ok: false }),
    kick: () => ({ ok: false }),
    setAccess: () => ({ ok: false }),
    setPartyModeBy: () => ({ ok: false }),
    close: () => false,
  };
  return ctx as unknown as ActionContext;
}

test('FND57-7 归档回执三态:ARCHIVED / NOT_ARCHIVED / UNREPORTED 不合并', () => {
  /* (a) 宿主报告已归档 ⇒ effect 带句柄与字节数。 */
  const archived = resetWorld(makeCtx(() => ({
    applied: true,
    seed: 4242,
    archive: { id: 'r7#3', seed: 111, archived_at: 9000, bytes: 24 },
  })));
  eq(archived.ok, true, '(a) 应成功');
  eq(archived.effect?.archive, 'ARCHIVED', '★ 归档发生了 ⇒ ARCHIVED');
  eq(archived.effect?.archiveId, 'r7#3', '归档句柄透传');
  eq(archived.effect?.archiveSeed, 111, '**旧世界**的种子透传');
  eq(archived.effect?.archiveBytes, 24, '字节数透传');
  eq(archived.effect?.seed, 4242, '原口径:effect.seed 仍是**新**种子');

  /* (b) 宿主明确说没归档(null)⇒ NOT_ARCHIVED,且不带句柄。 */
  const notArchived = resetWorld(makeCtx(() => ({ applied: true, seed: 4242, archive: null })));
  eq(notArchived.effect?.archive, 'NOT_ARCHIVED', '★ 明确没归档 ⇒ NOT_ARCHIVED');
  eq(notArchived.effect?.archiveId, undefined, '没归档就没有句柄(不许编一个)');

  /* (c) 宿主**没报告**这个字段 ⇒ UNREPORTED。
     把它写成 NOT_ARCHIVED 就是"把不确定说成确定" —— 那条判据在这里红。 */
  const unreported = resetWorld(makeCtx(() => ({ applied: true, seed: 4242 })));
  eq(unreported.effect?.archive, 'UNREPORTED', '★ 没报告 ≠ 没归档');
  eq(unreported.effect?.archiveId, undefined, '没报告就没有句柄');

  /* (d) 归档失败 ⇒ 原因照转,不能只回一句"重置成功"。 */
  const failed = resetWorld(makeCtx(() => ({
    applied: true, seed: 4242, archive: null, archiveError: '磁盘满',
  })));
  eq(failed.ok, true, '(d) 重置本身生效 ⇒ 仍然 OK');
  eq(failed.effect?.archive, 'NOT_ARCHIVED', '归档没成 ⇒ NOT_ARCHIVED');
  eq(failed.effect?.archiveError, '磁盘满', '★ 归档失败的原因必须转述给客户端');

  /* (e) 没生效的那条路**不许**冒出 effect(口径与改前一致)。 */
  const notApplied = resetWorld(makeCtx(() => ({ applied: false, seed: 0, reason: '世界正在结算中' })));
  eq(notApplied.ok, false, '(e) 未生效');
  eq(notApplied.effect, undefined, '未生效就没有 effect');
});

/* ───────────────────────── 8. 存储与迁移的边角 ───────────────────────── */

test('FND57-8 归档 DDL 是**独立文件产物**,且迁移幂等', () => {
  /* DDL 是文件产物(与 schema.sql 同风格)—— 测试读真实路径,而不是读代码里的字符串。 */
  const ddlPath = worldArchiveSqlPath();
  ok(ddlPath.endsWith('schema_world_archive.sql'), `归档 DDL 路径(实得 ${ddlPath})`);
  ok(ddlPath !== schemaSqlPath(), '归档 DDL **独立于** schema.sql(建表数被既有判据锁在 9 张)');

  /* schema.sql 仍然只有 9 张表 —— 本轮没动别人的判据口径。 */
  const schemaTables = [...readSchemaSql().matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*)/gi)];
  eq(schemaTables.length, 9, 'schema.sql 建表数仍是 9(归档表不在里面)');

  const db = makeMemoryDb();
  /* 再跑一次:不炸、不重复登记。 */
  const again = migrateWorldArchives(db, 2000);
  eq(again.applied, false, '第二次迁移不再登记');
  eq(db.count('schema_migrations'), 2, '迁移登记仍是 2 行(version 1 + 2)');
  eq(again.drift, false, '同一份 DDL ⇒ 无漂移');
});

test('FND57-9 归档写入**拒绝**坏输入,而不是静默写个半截行', () => {
  const db = makeMemoryDb();
  const throws = (fn: () => unknown, label: string): void => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    ok(threw, `${label} 必须抛错(静默写进去 = 回滚出一份坏世界)`);
  };

  throws(() => archiveWorldSnapshot(db, { roomId: '', seed: 1, snapshot: blob(1), nowMs: 1 }), '空 roomId');
  throws(() => archiveWorldSnapshot(db, { roomId: 'r9', seed: 1.5, snapshot: blob(1), nowMs: 1 }), '小数 seed');
  throws(() => archiveWorldSnapshot(db, {
    roomId: 'r9', seed: 1, snapshot: new Uint8Array(0), nowMs: 1,
  }), '0 字节快照');
  throws(() => archiveWorldSnapshot(db, {
    roomId: 'r9', seed: 1, snapshot: new Uint8Array(1048577), nowMs: 1,
  }), '超出 1MiB 上限的快照(拒绝而不是截断)');

  eq(countWorldArchives(db, 'r9'), 0, '★ 四次拒绝之后**一行都没写进去**');
});

report('WS-FND-57');