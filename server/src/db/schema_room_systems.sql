-- ============================================================================
-- 2.5D 绘本沙盒 · **房间系统台账** DDL(WS-FND-165 / B1 审计)
-- 归属:B1 实测 —— 「同一 `orderId` / 牧场第 N 天跨进程可再成交一次」
--       (修前 `roomSystemsState.settled` 与 `roomDayIndex` **只**活在 `WorldSim`
--        的字段里,进程一停就归零 ⇒ 重放窗口重新打开)。
-- 目标引擎:SQLite 3(与 schema.sql 同一个库、同一套 PRAGMA)
--
-- ## 为什么是**独立的旁表**,而不是往 rooms 上加一列
--
-- 1 不动 `schema.sql`:`migrate()` 的 checksum 已登记在既有库的
--   `schema_migrations`(version = 1)。改那份 DDL 会让**每个旧库**在启动时
--   判成 drift 并 fail-closed 拒绝启动(`repo.ts` 的 `migrate()`)—— 那不是
--   「兼容既有库」,那是把既有库全部拒之门外(与 `schema_starting_inventory.sql`
--   文件头第 2 条同一条理由)。
-- 2 本表**不引外键**:外键条数被 `tests/WS-07.test.ts` 的 A07b 锁在 11 条
--   (与 `schema_world_archive.sql` / `schema_starting_inventory.sql` 同一处置);
--   且台账的语义是「这间房结算过哪几张单」,房间行被删之后那份历史仍应可读。
-- 3 建表数与「9 张表」的既有判据不冲突:本表**不在 `migrate()` 里建**,
--   而是**第一次存档房间系统状态时**由 `migrateRoomSystems()` 就地补上
--   (`CREATE TABLE IF NOT EXISTS` 幂等),与归档表/起始包台账同一处置。
--
-- ## 「旧库」怎么进来(就地补表,不重建)
--
-- 老库(基线 v1 / v2 / v3)里没有这张表、也没有版本 4 的登记行 ⇒
-- `repo.ts:migrateRoomSystems()` 跑一次本文件并登记一行 ⇒ 库原地升到 v4,
-- 既有表与既有行一个都不动。判序与隔壁两段同一条纪律:
-- 「先读版本 → 护栏 → 漂移 → 才 exec DDL」。
--
-- 单位约定(与 schema.sql 一致):时间戳 = Unix 毫秒。
-- ============================================================================

-- ── 一行 = 一间房的房间系统台账(结算幂等键集 + 房内第几天)──────────────
-- 语义:
--   * `room_id`      = 房间 id(主键 ⇒ 一间房只有一份台账,并发写不会出现两份);
--   * `day_index`    = 房内「第几天」(`WorldSim.roomDayIndex`)。它是牧场日结键的
--                      一维:归零 ⇒ 同一个「第 0 天」会**再结算一次**;
--   * `settled_json` = 结算键集(`{"$v":1,"keys":[{"key":"...","at":123}]}`,
--                      顺序 = 入账顺序,读回时原样还原 FIFO 淘汰序);
--   * `key_count`    = 键数摘要(给诊断/断言用,不必把 JSON 拉出来);
--   * `saved_at`     = 写入时刻(Unix 毫秒)。
-- CHECK 的形态刻意选 `MemoryDb.parseCheckExpr` 认得的那两种(`col >= n` /
-- `length(col) <= n`):内存夹具与真实 SQLite 对同一条约束**都真的校验**
-- (不会进 `unsupportedChecks()`)。
-- `length(settled_json)` 的上界是「绕过仓储层直插」的第二道闸:键集的条数已由
-- `repo.ts:ROOM_SYSTEMS_MAX_KEYS` 在写入侧裁到 4096,正常写入永远碰不到它。
CREATE TABLE IF NOT EXISTS room_systems_state (
  room_id      TEXT    PRIMARY KEY,
  day_index    INTEGER NOT NULL DEFAULT 0 CHECK (day_index >= 0),
  settled_json TEXT    NOT NULL DEFAULT '{}' CHECK (length(settled_json) <= 262144),
  key_count    INTEGER NOT NULL DEFAULT 0 CHECK (key_count >= 0),
  saved_at     INTEGER NOT NULL
);
