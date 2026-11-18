-- ============================================================================
-- 2.5D 绘本沙盒 · 世界归档 DDL
-- 归属:D-06(`docs/DECISIONS.md`)= `RESET_WORLD` 的存档政策是**归档**
--       (世界按新 seed 在内存重建,**旧世界存成一份可回滚快照行**)
-- 目标引擎:SQLite 3(与 schema.sql 同一个库、同一套 PRAGMA)
--
-- ## 为什么是**独立 DDL 文件**,而不是往 schema.sql 里加第 10 张表
--
-- 建表数被三处**既有判据**锁死在 9 张,且它们不归本次改动:
--   * `tests/WS-07.test.ts:200`  `eq(tables.length, 9)`(A02)
--   * `tests/WS-07.test.ts:295`  `eq(tablesRaw.length, 9)`(A07b 注释切分)
--   * `tests/WS-07.test.ts:488`  `eq(tables.length, 9)`
--   * `scripts/verify.ts:5553`   `db.tableNames().length !== 9`
-- 外键数同样被 `tests/WS-07.test.ts:269` 锁在 11 条。
-- 把归档表塞进 schema.sql 会让上述四处**立刻红**,而那是别人的判据文件。
--
-- ⇒ 归档走**自己的迁移**:`repo.ts:migrateWorldArchives()`(version 2)单独 exec 本文件。
--   `migrate()` 仍然只建那 9 张表 ⇒ 上面四条判据的口径一个字都不用改。
--   本表**不加外键**:一是 FK 数被锁死,二是归档的语义是"历史版本",
--   房间被删之后那几版快照仍应可读(而不是被 ON DELETE 连带清掉)。
--
-- 单位约定(与 schema.sql 一致):时间戳 = Unix 毫秒;BLOB 列 = Uint8Array。
-- ============================================================================

-- ── 世界归档行:一次 `RESET_WORLD` 落一行(旧世界) ─────────────────────────
-- 语义:
--   * `id`            = 回滚读口的稳定句柄(`<room_id>#<seq>`,同一房间内单调);
--   * `seq`           = 该房间的第几次归档(不是全局),用于同毫秒内的排序;
--   * `seed`          = **旧世界**的种子(不是新世界的) —— 回滚时要的就是它;
--   * `snapshot_blob` = 旧世界的快照字节;**不覆盖、不合并**,每次重置追加一行;
--   * `snapshot_bytes`= 字节数摘要(给回滚 UI 用,不必把 BLOB 拉出来);
--   * `reason`        = 归档原因(可空字符串;便于将来区分"重置归档"/"手动归档")。
-- 配额由 `repo.ts:WORLD_ARCHIVE_KEEP_PER_ROOM` 在**写入事务内**裁剪,本表不会无界增长。
CREATE TABLE IF NOT EXISTS room_world_archives (
  id             TEXT    PRIMARY KEY,
  room_id        TEXT    NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  seed           INTEGER NOT NULL,
  world_tick     INTEGER NOT NULL DEFAULT 0 CHECK (world_tick >= 0),
  -- ★ 1 MiB 上限的**第二道闸**(审计 P2):与 `room_players.snapshot_blob`
  -- (`schema.sql:126`)同一个口径。写入侧 `repo.archiveWorldSnapshot` 会先按整块
  -- chunk 裁剪到 ≤ 上限;这条 CHECK 挡的是**绕过本模块直插**的路径。
  -- 形态刻意用 `length(x) <= n`:`MemoryDb` 认得它(`parseCheckExpr` 的 lengthMax),
  -- 于是内存夹具与真实 SQLite 对同一条约束的行为一致(不会进 `unsupportedChecks`)。
  snapshot_blob  BLOB    NOT NULL CHECK (length(snapshot_blob) <= 1048576),
  -- `snapshot_bytes` 与 `length(snapshot_blob)` 的**绑定**:
  -- 跨列等式(`snapshot_bytes = length(snapshot_blob)`)在 MemoryDb 的谓词解析器里
  -- 是 unsupported 形态(会变成一条「看起来存在、实际不校验」的约束),所以它
  -- 挪进仓储层、两头都钉:`archiveWorldSnapshot` 写入时**由 blob 长度算出**它,
  -- `loadWorldArchive` 读回时**核对**它,不一致 ⇒ 视为「这一版不完整」返回 undefined。
  -- 这里再加一条上界,防「摘要说 8 字节、blob 是 900KB」这种连读取都懒得核对的行。
  -- ★ 上下界刻意写成 `col >= 0 AND col <= n` 的**同列合取**:`MemoryDb.parseCheckExpr`
  -- 认得这个形态(`{kind:'and'}`),于是内存夹具与真实 SQLite **都真的校验**它。
  -- 改前整条落进 `unsupportedChecks()`(默认放行)⇒ 内存后端等于没有这条约束,
  -- 「测试绿、生产异」—— 守它的判据在 `tests/WS-FND-116`。
  snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0 AND snapshot_bytes <= 1048576),
  reason         TEXT    NOT NULL DEFAULT '',
  archived_at    INTEGER NOT NULL
);

-- 回滚读口:`listWorldArchives(roomId)` 走「按房间 + 时间倒序」。
CREATE INDEX IF NOT EXISTS idx_room_world_archives_room
  ON room_world_archives (room_id, archived_at DESC, seq DESC);