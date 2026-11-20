-- ============================================================================
-- 2.5D 绘本沙盒 · **世界存档(脏页 chunk 旁路层 + 房间级世界状态)** DDL
-- 归属:WS-FND-164 —— B1 审计实测的 P0
--   `repo.saveChunk` / `saveChunkBatch` / `loadChunk` 在生产里 **0 调用** ⇒
--   进程一停,**地形与玩家建造全丢**,世界按 seed 重新生成;
--   `reset_world` 的归档行也只写不读。
-- 目标引擎:SQLite 3(与 schema.sql 同一个库、同一套 PRAGMA)
--
-- ## 为什么是**独立的旁表**,而不是给 `room_chunks` / `rooms` 加列
--
-- 1 `room_chunks.tiles_blob` 被 DDL 锁在**恰好 1024 字节**
--    (`CHECK (length(tiles_blob) = 1024)`,手册 §7.1 的 1KB/Chunk),而屋顶层
--    (`Chunk.roofs`,12 位/格 的旁路层)根本不在那 32 位里 ⇒ 想「顺手」把屋顶
--    塞进同一行只有两种做法:改掉那条 1024 的 CHECK(既有判据
--    `tests/WS-07.test.ts` A05 与手册都钉着它),或者开一个「同一块地形两行」的
--    畸形主键。两条都把一句简单的「chunk = 1KB 单元」变成需要解释的东西。
-- 2 水位是**房间级**的连续场(`FluidField` 是 sizeCells × sizeCells 一整片),
--    不属于任何一块 chunk ⇒ 它需要一个房间级的落点。
-- 3 ★ **不动 `schema.sql`**:那份 DDL 的 checksum 登记在既有库的
--    `schema_migrations`(version = 1)里,改一个字符就会让**每一个旧库**在启动时
--    判成 drift 并 fail-closed(见 `repo.ts:migrate`)。本文件走自己的迁移版本
--    (v5),`CREATE TABLE IF NOT EXISTS` 幂等,**第一次存档时**才建表 ——
--    与 `schema_world_archive.sql`(v2)/ `schema_starting_inventory.sql`(v3)
--    同一处置:`migrate()` 之后仍然是 9 张表,既有判据不动。
--
-- ## 两个表各自回答什么
--
-- ```text
-- room_chunk_roofs  一行 = 一块地形的**屋顶旁路层**(RLE 字节;全空 = 1 字节)
-- room_world_state  一行 = 一个房间的**世界身份 + 水位表**(seed / 边长 / 群系 /
--                   帧号 / FLV1 字节)
-- ```
--
-- ## 为什么两表都**不引外键**
--
-- 与归档表 / 台账表同一条理由(见 `schema_world_archive.sql` 与
-- `schema_starting_inventory.sql` 的文件头):外键条数被 `tests/WS-07.test.ts`
-- A07b 锁在 11 条,且 `MemoryDb` 的级联是由常量表 `FOREIGN_KEYS` 驱动的 ——
-- 只在这份 DDL 里写 FK 会让「真库级联 / 内存库不级联」变成两份行为。
-- 清理按 `room_id` 显式做(`repo.forgetRoomWorldSave`),两种后端同一个口。
--
-- 单位约定(与 schema.sql 一致):时间戳 = Unix 毫秒。
-- ============================================================================

-- ── 1. room_chunk_roofs:屋顶层(12 位/格,32 位单元装不下)───────────────
-- 语义:
--   * 主键与 `room_chunks` **逐列相同** ⇒ 一块地形在两张表里最多各一行,
--     「同一块两行」在库层就不可能;
--   * `roofs_blob` = `world/chunk.ts:encodeRoofRle(roofs)` 的字节:
--     `0x00..0x7f` = 该数值个零值,`0xff vL vH` = 1 个非零值 ⇒ 全空块 **3 字节**
--     (256 格零 = 127+127+2,每段零游程最多 127 格),满屋顶块 ≤ 768 字节。
--     上限 4096 是「明显不是屋顶层 = 坏数据」的闸,不是压缩估计;
--   * 形态刻意用 `length(x) <= n`:`MemoryDb` 认得它(`parseCheckExpr` 的 lengthMax),
--     于是内存夹具与真实 SQLite 对同一条约束的行为一致。
CREATE TABLE IF NOT EXISTS room_chunk_roofs (
  room_id    TEXT    NOT NULL,
  chunk_x    INTEGER NOT NULL,
  chunk_y    INTEGER NOT NULL,
  roofs_blob BLOB    NOT NULL CHECK (length(roofs_blob) <= 4096),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, chunk_x, chunk_y)
) WITHOUT ROWID;

-- ── 2. room_world_state:世界身份 + 水位表(一房间一行)────────────────────
-- 语义:
--   * `seed` / `size_cells` / `biome` / `frame` = 读档时要还原的**世界身份**。
--     `seed` 同时是**世代替换的判据**:`WorldSim.resetWorld` 换了种子之后,
--     库里那行的 `seed` 与本世界的 `worldSeed` 不再相等 ⇒ 下一次自动存档
--     先整代清空再写(见 `repo.forgetRoomWorldSave`),旧世代的 chunk 行不会
--     被当成新世界读回来;
--   * `fluid_blob` = `world/fluid.ts:packFluidAmounts` 的 `FLV1` 字节
--     (`12 + 4·w·h`)。可空:干旱世界 / 尺寸超预算时不写水位(读档时按「没有
--     水位表」处理,**不编一个空场**——两者的区别是「没存过」与「存了但全干」);
--   * 上下界写成 `col >= 0` 的同列合取(`MemoryDb.parseCheckExpr` 认得的那一种)。
CREATE TABLE IF NOT EXISTS room_world_state (
  room_id     TEXT    PRIMARY KEY,
  seed        INTEGER NOT NULL,
  size_cells  INTEGER NOT NULL CHECK (size_cells > 0),
  biome       TEXT    NOT NULL,
  frame       INTEGER NOT NULL CHECK (frame >= 0),
  fluid_blob  BLOB    CHECK (length(fluid_blob) <= 1048576),
  updated_at  INTEGER NOT NULL
);