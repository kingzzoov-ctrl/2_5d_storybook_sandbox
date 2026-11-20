-- ============================================================================
-- 2.5D 绘本沙盒 · **房间运行时状态 + 玩家装备** DDL(★ WS-FND-168 / B1 审计)
-- 归属:B1 实测 —— 上一轮逐条**诚实登记**但仍**只活在内存**的那几类状态:
--   · 房间系统:`gallery`(537 陈列)/ `harvest`(交付台账)/ `crops`(耕地)/
--     `ranchPets`(圈养名单)/ `lastRanch` / `lastBrew`;
--   · 百货机库存(`depotStock`);
--   · 地面掉落(`mobGround`);
--   · 电路件(`wiring.components` 的组件运行态);
--   · 生物位置 / 朝向(此前只有 `rooms.mob_mem_json` 存 AI 记忆,**没有位置**);
--   · 玩家的装备(除走重连 blob 的那件武器)/ `held_item_id` / 朝向。
--   修前这些全在 `WorldSim` 的字段里:进程一停就归零,而库里那几行还在 ——
--   「自动存档成功」在**这几维**上是空的。
-- 目标引擎:SQLite 3(与 schema.sql 同一个库、同一套 PRAGMA)
--
-- ## 为什么是**独立的旁表**,而不是给 `rooms` / `users` 加列
--
-- 1 不动 `schema.sql`:它的 checksum 已登记在既有库的 `schema_migrations`
--   (version = 1)。改那份 DDL 一个字符就会让**每一个旧库**在启动时判成
--   checksum drift 并 fail-closed(见 `repo.ts:migrate`)—— 那不是「兼容既有库」,
--   那是把既有库全部拒之门外(与 `schema_world_archive.sql` /
--   `schema_starting_inventory.sql` / `schema_room_systems.sql` 同一处置)。
-- 2 本文件**不引外键**:外键条数被 `tests/WS-07.test.ts` 的 A07b 锁在 11 条
--   (与隔壁三份独立 DDL 同一理由);且这些状态是**房间/玩家级运行时数据**,
--   房间行被删之后仍应可读。
-- 3 建表数与「9 张表」的既有判据不冲突:本文件的两张表**不在 `migrate()` 里建**,
--   而是**第一次存档**时由 `migrateRoomRuntime()` 就地补上
--   (`CREATE TABLE IF NOT EXISTS` 幂等),老库(v1..v5 任意组合)原地升版。
--
-- ## 「旧库」怎么进来(就地补表,不重建)
--
-- 老库里没有这两张表、也没有版本 6 的登记行 ⇒ `repo.ts:migrateRoomRuntime()`
-- 跑一次本文件并登记一行 ⇒ 库原地升到 v6,既有表与既有行一个都不动。判序与
-- 隔壁各段同一条纪律:「先读版本 → 护栏 → 漂移 → 才 exec DDL」。
--
-- ## 版本标记(便于将来改结构)
--
-- 每个 `*_json` 列存的是**一个信封**:
--   { "$v": 1, "data": <该段的载荷> }
-- `$v` 是**段格式版本**:不认识的版本 ⇒ 读侧如实标 `corrupt`(**不猜**),
-- 于是「写它的程序」与「读它的程序」不是同一版这件事看得见(与
-- `repo.ts` 的背包账 `$v` / 房间系统台账 `$v` 同一口径)。
--
-- 单位约定(与 schema.sql 一致):时间戳 = Unix 毫秒。
-- ============================================================================

-- ── 1. room_runtime_state:一房间一行的运行时状态(五段信封)──────────────
-- 语义:`room_id` 是主键 ⇒ 一间房只有一行(并发写不会出现两份);
-- 五列各是一个自带的段:`systems` / `depot` / `drops` / `wiring` / `mobs`。
--   * 分列而不是一坨大 JSON:**一段坏了只影响那一段**(读侧逐段标 corrupt),
--     换一坨大 JSON 的话「坏了一个字段 = 整间房的运行时状态全丢」;
--   * 空串 `''` = 这一段**没存过**(与「存过但内容为空」是两件事);
--   * `CHECK (length(...) <= 1048576)` 是「绕过仓储层直插」的第二道闸:
--     上限与 `repo.ts:BLOB_MAX_BYTES` 同口径;
--   * CHECK 刻意选 `length(x) <= n` 这一种形态 —— `MemoryDb.parseCheckExpr`
--     认得它(内存夹具与真实 SQLite 对同一条约束**都真的校验**)。
CREATE TABLE IF NOT EXISTS room_runtime_state (
  room_id      TEXT    PRIMARY KEY,
  systems_json TEXT    NOT NULL DEFAULT '' CHECK (length(systems_json) <= 1048576),
  depot_json   TEXT    NOT NULL DEFAULT '' CHECK (length(depot_json) <= 1048576),
  drops_json   TEXT    NOT NULL DEFAULT '' CHECK (length(drops_json) <= 1048576),
  wiring_json  TEXT    NOT NULL DEFAULT '' CHECK (length(wiring_json) <= 1048576),
  mobs_json    TEXT    NOT NULL DEFAULT '' CHECK (length(mobs_json) <= 1048576),
  saved_at     INTEGER NOT NULL
);

-- ── 2. player_equipment_state:一名玩家的装备(除走重连 blob 的武器)────────
-- 语义:`user_id` 是主键 ⇒ 一人一行;
--   * `equipment_json` = `{ "$v": 1, "data": { "equipment": [物品 id...] } }`,
--     装的是**非武器**的 wearing(武器那件已由重连快照 `snapshot_blob` 承载,
--     见 `world_sim.ts:restoreFromProfile` 的注释);
--   * 上限 65536:装备是一小串 id,远小于 1 MiB;这个数是「明显不是装备 = 坏数据」
--     的闸,不是容量估计。
CREATE TABLE IF NOT EXISTS player_equipment_state (
  user_id        TEXT PRIMARY KEY,
  equipment_json TEXT NOT NULL DEFAULT '' CHECK (length(equipment_json) <= 65536),
  saved_at       INTEGER NOT NULL
);
