-- ============================================================================
-- 2.5D 绘本沙盒 · 服务端持久层 DDL
-- 归属:WS-07(设计手册 §7.1 存档与持久化)全文落地
-- 目标引擎:SQLite 3(WAL 模式)
-- 本文件是**纯文本产物**:repo.ts 通过 DbLike 接口消费,测试用 node:fs 读原文断言。
--
-- 单位约定
--   * 时间戳一律为 Unix 毫秒(INTEGER)
--   * 坐标一律为「格」(REAL),Z 轴 ∈ [-1, 3]
--   * room_chunks.tiles_blob 固定 1024 字节 = CHUNK_CELLS(256) × Uint32 LE
--     (见 shared/types/tile.ts: CHUNK_BYTES = 1024)
--   * 经验/价值分沿用 shared/types/entities.ts 的口径
--
-- 建表顺序:被引用者在前,保证外键目标已存在:
--   users → rooms → user_sessions / room_players / room_chunks /
--   ai_alchemy_recipes → ai_item_instances → room_events
-- users.ai_weapon_recipe_hash 与 users.home_room_id 是**软引用**(不加 FK 约束),
-- 理由:rooms 与 ai_alchemy_recipes 都晚于 users 建表,硬 FK 会形成循环依赖;
-- 这两列的悬空由 repo.ts 的写入校验兜底(见 repo.ts:savePlayer)。
--
-- 语法约束:仅使用 SQLite 标准 DDL;不使用 ATTACH / 临时表 / 存储过程。
-- ============================================================================

-- ── 0. 连接级 PRAGMA ───────────────────────────────────────────────────────
-- WAL:存档写入与 20Hz 内存态解耦,避免读写互斥;
-- synchronous = NORMAL 是 WAL 下的推荐档位(断电最多丢最后一个 checkpoint,不损坏库);
-- foreign_keys = ON 必须每个连接显式打开,否则外键与级联全部静默失效。
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16000;

-- ── 1. 迁移版本表 ──────────────────────────────────────────────────────────
-- 每次 DDL 变更登记一行;checksum 为对应迁移脚本的 sha256 十六进制。
-- 检测到「已登记版本 + 校验和不一致」时启动必须 fail-closed(见 repo.ts:migrate)。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  checksum   TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);

-- ── 2. users:账号 + 角色成长快照(手册 §7.1 users)─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT    PRIMARY KEY,
  display_name          TEXT    NOT NULL,
  level                 INTEGER NOT NULL DEFAULT 1   CHECK (level BETWEEN 1 AND 30),
  exp                   INTEGER NOT NULL DEFAULT 0   CHECK (exp >= 0),
  hp                    INTEGER NOT NULL DEFAULT 100 CHECK (hp >= 0),
  max_hp                INTEGER NOT NULL DEFAULT 100 CHECK (max_hp > 0),
  pos_x                 REAL    NOT NULL DEFAULT 0,
  pos_y                 REAL    NOT NULL DEFAULT 0,
  pos_z                 REAL    NOT NULL DEFAULT 0,
  dir                   INTEGER NOT NULL DEFAULT 0   CHECK (dir BETWEEN 0 AND 3),
  state_flag            INTEGER NOT NULL DEFAULT 0   CHECK (state_flag BETWEEN 0 AND 7),
  -- 手册 §7.2 PlayerSchema 的持久化镜像
  weapon_id             INTEGER,
  ai_weapon_recipe_hash TEXT,
  held_item_id          INTEGER,
  carrying_entity_id    TEXT,
  inventory_json        TEXT    NOT NULL DEFAULT '{}',
  talent_json           TEXT    NOT NULL DEFAULT '[]',
  home_room_id          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- ── 3. rooms:房间元数据与生命周期(手册 §7.1 rooms)────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT    PRIMARY KEY,
  owner_id       TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  access_mode    TEXT    NOT NULL DEFAULT 'PUBLIC'
                 CHECK (access_mode IN ('PUBLIC', 'PASSWORD')),
  password_hash  TEXT,
  max_players    INTEGER NOT NULL DEFAULT 16 CHECK (max_players BETWEEN 1 AND 16),
  status         TEXT    NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'SLEEPING', 'CLOSED')),
  party_mode     TEXT    NOT NULL DEFAULT 'NONE'
                 CHECK (party_mode IN ('NONE', 'BRIDGE_FLAG', 'JELLY_BALL', 'CROWN_RUN', 'PAINT_WAR')),
  world_seed     INTEGER NOT NULL DEFAULT 0,
  world_tick     INTEGER NOT NULL DEFAULT 0  CHECK (world_tick >= 0),
  chunk_radius   INTEGER NOT NULL DEFAULT 4  CHECK (chunk_radius BETWEEN 1 AND 16),
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  saved_at       INTEGER,
  -- 生物 AI 记忆快照(JSON 文本,形如 {"mob_x":{"escapeTimer":7.5}})。
  -- 为什么是**加列**而不是新表:表数被 `verify.ts` 锁在 9 张、
  -- 外键被 WS-07 的 A07b 锁在 11 条,新表会同时打破两者。
  -- 语义:'{}' = 该房间没有生物记忆(新建房间的默认值)。
  -- 不加 CHECK:跨列/函数式 CHECK 会计入 `unsupportedChecks()`,
  -- 而那条断言锁的是 2 条(见 tests/WS-07.test.ts:314),加了就红。
  mob_mem_json   TEXT    NOT NULL DEFAULT '{}',
  -- 密码房必须落一个 hash;公开房必须留空,二者互斥。
  CHECK (access_mode = 'PUBLIC' OR password_hash IS NOT NULL),
  CHECK (access_mode = 'PASSWORD' OR password_hash IS NULL),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── 4. user_sessions:断线重连令牌(30 秒宽限期由 room.ts 判定)──────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  token      TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  room_id    TEXT,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL
);

-- ── 5. room_players:房间成员 + 最近一次状态快照(重连恢复用)──────────────
CREATE TABLE IF NOT EXISTS room_players (
  room_id       TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'MEMBER'
                CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'GUEST')),
  snapshot_blob BLOB,
  joined_at     INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── 6. room_chunks:1KB/Chunk 的地形主存储(手册 §7.1 room_chunks)──────────
CREATE TABLE IF NOT EXISTS room_chunks (
  room_id    TEXT    NOT NULL,
  chunk_x    INTEGER NOT NULL,
  chunk_y    INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  tiles_blob BLOB    NOT NULL CHECK (length(tiles_blob) = 1024),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, chunk_x, chunk_y),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) WITHOUT ROWID;

-- ── 7. ai_alchemy_recipes:全服炼金配方缓存(手册 §5.2 / §7.1)──────────────
CREATE TABLE IF NOT EXISTS ai_alchemy_recipes (
  recipe_hash      TEXT    PRIMARY KEY,
  input_ids        TEXT    NOT NULL,
  k_inputs         INTEGER NOT NULL CHECK (k_inputs BETWEEN 2 AND 4),
  item_name        TEXT    NOT NULL,
  category         TEXT    NOT NULL,
  rarity_tier      INTEGER NOT NULL CHECK (rarity_tier BETWEEN 0 AND 3),
  t_eff            REAL    NOT NULL CHECK (t_eff > 0),
  q_score          REAL    NOT NULL CHECK (q_score > 0),
  p_budget         INTEGER NOT NULL CHECK (p_budget >= 0),
  stats_json       TEXT    NOT NULL,
  visual_json      TEXT    NOT NULL,
  pixel_icon_json  TEXT    NOT NULL,
  llm_model        TEXT    NOT NULL,
  first_crafter_id TEXT,
  craft_count      INTEGER NOT NULL DEFAULT 1 CHECK (craft_count >= 1),
  created_at       INTEGER NOT NULL,
  last_crafted_at  INTEGER NOT NULL,
  FOREIGN KEY (first_crafter_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ── 8. ai_item_instances:AI 造物实例(手册 §7.1 ai_item_instances)─────────
CREATE TABLE IF NOT EXISTS ai_item_instances (
  instance_id   TEXT    PRIMARY KEY,
  owner_id      TEXT,
  recipe_hash   TEXT,
  slot          TEXT    NOT NULL
                CHECK (slot IN ('weapon', 'armor', 'helm', 'boots', 'relic', 'cloak', 'bag')),
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  equipped      INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  stats_json    TEXT    NOT NULL DEFAULT '{}',
  bound_room_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (owner_id)      REFERENCES users(id)                       ON DELETE CASCADE,
  FOREIGN KEY (recipe_hash)   REFERENCES ai_alchemy_recipes(recipe_hash) ON DELETE SET NULL,
  FOREIGN KEY (bound_room_id) REFERENCES rooms(id)                       ON DELETE SET NULL
);

-- ── 9. room_events:反作弊裁决与生命周期审计流水 ───────────────────────────
CREATE TABLE IF NOT EXISTS room_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT    NOT NULL,
  tick         INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  actor_id     TEXT,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- ── 索引设计 ───────────────────────────────────────────────────────────────
-- 房间大厅列表:按「状态 + 可见性 + 最近活跃」倒序翻页。
CREATE INDEX IF NOT EXISTS idx_rooms_status_access
  ON rooms (status, access_mode, last_active_at DESC);

-- 我拥有的房间。
CREATE INDEX IF NOT EXISTS idx_rooms_owner
  ON rooms (owner_id, created_at DESC);

-- 我在哪些房间有存档(重连时先按 user_id 反查)。
CREATE INDEX IF NOT EXISTS idx_room_players_user
  ON room_players (user_id, last_seen_at DESC);

-- 增量存盘:按 room_id + updated_at 捞「最近变动的 Chunk」。
CREATE INDEX IF NOT EXISTS idx_room_chunks_updated
  ON room_chunks (room_id, updated_at DESC);

-- 博物架 / 全服首次合成榜:按 craft_count 倒序。
CREATE INDEX IF NOT EXISTS idx_ai_alchemy_recipes_craft_count
  ON ai_alchemy_recipes (craft_count DESC, created_at DESC);

-- 背包按 owner 取件(手册明确要求:ai_item_instances.owner_id 建索引)。
CREATE INDEX IF NOT EXISTS idx_ai_item_instances_owner
  ON ai_item_instances (owner_id, slot, equipped DESC);

-- 配方反查:某配方产出过哪些实例。
CREATE INDEX IF NOT EXISTS idx_ai_item_instances_recipe
  ON ai_item_instances (recipe_hash);

-- 会话清理任务:按 user + 过期时间扫描。
CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions (user_id, expires_at DESC);

-- 房间审计回放:按 room + tick 倒序。
CREATE INDEX IF NOT EXISTS idx_room_events_room_tick
  ON room_events (room_id, tick DESC);

-- ── 视图:大厅列表 ─────────────────────────────────────────────────────────
CREATE VIEW IF NOT EXISTS v_public_rooms AS
SELECT r.id,
       r.name,
       r.access_mode,
       r.status,
       r.party_mode,
       r.world_tick,
       r.max_players,
       r.last_active_at,
       (SELECT COUNT(*) FROM room_players p WHERE p.room_id = r.id) AS member_count
  FROM rooms r
 WHERE r.status <> 'CLOSED'
 ORDER BY r.last_active_at DESC;

-- ── 触发器:房间状态迁移写审计流水 ─────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS trg_rooms_status_change
AFTER UPDATE OF status ON rooms
FOR EACH ROW WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO room_events (room_id, tick, kind, actor_id, payload_json, created_at)
  VALUES (NEW.id, NEW.world_tick, 'ROOM_STATUS', NULL,
          json_object('from', OLD.status, 'to', NEW.status), NEW.last_active_at);
END;