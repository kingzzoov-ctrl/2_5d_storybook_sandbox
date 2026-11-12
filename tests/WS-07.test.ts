/**
 * WS-07 测试(SQLite 存档 · 20Hz 差量协议 · 房间生命周期)。
 *
 * 硬约束:本文件只 import `node:*` 与 `shared/**` 与本 WS 的零依赖实现,
 * 不得 import colyseus / better-sqlite3。
 *
 * 运行:`node tests/WS-07.test.ts` 或 `node scripts/verify.ts --only WS-07`
 */

import { test, ok, eq, near, includes, inRange, report } from '../shared/testing/harness.ts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_BYTES, CHUNK_CELLS, packTile, unpackTile } from '../shared/types/tile.ts';
import { BASE_MOVE_SPEED, DT, TICK_HZ, BodyState } from '../shared/types/physics.ts';

/** 仓库根(本文件在 tests/ 下)。 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
  AccessMode,
  PartyMode,
  RoomRole,
  RoomStatus,
  addItemInstance,
  checksumOf,
  chunksUpdatedSince,
  consumeItem,
  createRoom,
  createUser,
  createUser as createUserRow,
  getRecipe,
  getRoom,
  getUser,
  incrementCraftCount,
  listEvents,
  listItems,
  listTopRecipes,
  loadChunk,
  loadChunkCells,
  loadReconnectSnapshot,
  migrate,
  packChunkBlob,
  readSchemaSql,
  saveChunk,
  saveChunkBatch,
  savePlayerState,
  saveReconnectSnapshot,
  schemaSqlPath,
  totalItemsOf,
  unpackChunkBlob,
  upsertRecipe,
  upsertRoomPlayer,
  writeEvent,
  eventIdRetryCount,
  resetEventIdRetryCount,
  type DbLike,
  type RecipeRecord,
} from '../server/src/db/repo.ts';
import { MemoryDb, FOREIGN_KEYS, splitStatements } from '../server/src/db/memory_db.ts';

import {
  BOSS_FIELD_TABLE,
  FIELD_TABLE,
  FieldType,
  ROOM_FIELD_TABLE,
  WILDLIFE_FIELD_TABLE,
  POS_SCALE,
  StateFlagIndex,
  bumpChunkVersion,
  cloneRoomState,
  createBossState,
  createPlayerState,
  createRoomState,
  createWildlifeState,
  entityPayloadBytes,
  fullMask,
  parseChunkVersions,
  quantizePos,
  dequantizePos,
  serializeChunkVersions,
  tableFor,
  upsertBoss,
  upsertPlayer,
  upsertWildlife,
  validateFieldTable,
  EntityKind,
  type RoomState,
} from '../server/src/net/schema.ts';

import {
  PROTOCOL_VERSION,
  PacketOp,
  applyPacket,
  bandwidthTable,
  decodePacket,
  diffChunkVersions,
  encodeDelta,
  encodeFull,
  estimateBandwidth,
  chunkWireBytes,
} from '../server/src/net/delta.ts';

import {
  RECONCILE_DEADZONE,
  RECONCILE_HARD_SNAP,
  SMOOTH_WINDOW_S,
  INTERP_DELAY_S,
  Interpolator,
  LossyChannel,
  absorbOffset,
  dist2,
  errorConverged,
  jitterAmplification,
  maxPositionError,
  maxSpeed,
  normalizeInput,
  predictStep,
  pruneCmds,
  reconcile,
  ReconcileAction,
  resimulate,
  simulateInterpolation,
  type InputCmd,
} from '../client/src/net/prediction.ts';

import {
  ACTION_PERMISSION,
  AFK_TIMEOUT_MS,
  IDLE_SLEEP_MS,
  MEMBER_PRESENCE_LABEL,
  MemberPresence,
  PERMISSION_MATRIX,
  RECONNECT_GRACE_MS,
  RoomAction,
  RoomRegistry,
  RoomRuntime,
  can,
  bootstrap,
} from '../server/src/net/room.ts';
/* task-57:生产装配入口 —— K5/K5b 用**生产路径**(而非手动赋值)证明接线。
   ⚠️ 只依赖 `index.ts`(它刻意不 import colyseus 壳),故本套件仍可在 Node 下加载。 */
import { assemble } from '../server/src/index.ts';

import {
  BASE_ATTACK_INTERVAL_S,
  DEFAULT_LIMITS,
  InventoryReject,
  MAX_ATTACK_SPEED_BONUS,
  MAX_ITEM_DELTA_PER_TICK,
  MAX_MOVE_CATCHUP_TICKS,
  MAX_SPEED_BONUS_MUL,
  AntiCheatRoom,
  ViolationKind,
  advanceServerClock,
  checkAttack,
  checkInventory,
  checkMove,
  createAcState,
  fixedClock,
  maxDisplacementPerTick,
  type FixedClock,
} from '../server/src/net/anticheat.ts';

/* ══════════════════ A. DDL / SQLite ══════════════════ */

test('A01 schema.sql 用真实文件路径可读,且含 WAL/NORMAL/foreign_keys', () => {
  const p = schemaSqlPath();
  ok(existsSync(p), `schema.sql 不存在:${p}`);
  const ddl = readSchemaSql(p);
  includes([ddl.includes('journal_mode = WAL')], true, 'WAL');
  includes([ddl.includes('synchronous = NORMAL')], true, 'synchronous');
  includes([ddl.includes('foreign_keys = ON')], true, 'foreign_keys');
  ok(ddl.length > 2000, `DDL 过短(${ddl.length})`);
});

test('A02 DDL 表数量 = 9,缺一即失败', () => {
  const ddl = readSchemaSql();
  const tables = [...ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*)/gi)]
    .map((m) => m[1]);
  const expected = [
    'schema_migrations', 'users', 'rooms', 'user_sessions', 'room_players',
    'room_chunks', 'ai_alchemy_recipes', 'ai_item_instances', 'room_events',
  ];
  eq(tables.length, 9, '建表数');
  for (const t of expected) includes(tables, t, `缺表 ${t}`);
});

test('A03 语句数 ≥ 25(9 表 + 9 索引 + 1 视图 + 1 触发器 + 6 PRAGMA)', () => {
  const ddl = readSchemaSql();
  /* 不再手工剥注释 —— `splitStatements` 自身跳过注释与字符串,
     这里传原文才能同时验证解析器(A07b 用注释样例单独锁住该能力)。 */
  const stmts = splitStatements(ddl);
  ok(stmts.length >= 25, `语句数 ${stmts.length} < 25`);
});

test('A04 关键列名逐条存在(PlayerSchema 13 字段的持久化镜像)', () => {
  const ddl = readSchemaSql();
  const usersBody = /CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/.exec(ddl)?.[1] ?? '';
  ok(usersBody.length > 0, '没截到 users 表体');
  const required = [
    'id', 'display_name', 'level', 'exp', 'hp', 'max_hp',
    'pos_x', 'pos_y', 'pos_z', 'dir', 'state_flag',
    'weapon_id', 'ai_weapon_recipe_hash', 'held_item_id', 'carrying_entity_id',
    'inventory_json', 'talent_json', 'home_room_id', 'created_at', 'updated_at',
  ];
  for (const c of required) {
    ok(new RegExp(`\\b${c}\\b`).test(usersBody), `users 缺列 ${c}`);
  }
});

test('A05 room_chunks 的 tiles_blob 定长 1024 且是 BLOB,主键为 (room_id,cx,cy)', () => {
  const ddl = readSchemaSql();
  const body = /CREATE TABLE IF NOT EXISTS room_chunks \(([\s\S]*?)\n\) WITHOUT ROWID;/.exec(ddl)?.[1] ?? '';
  ok(body.length > 0, '没截到 room_chunks');
  ok(/tiles_blob\s+BLOB\s+NOT NULL/.test(body), 'tiles_blob 必须是 NOT NULL BLOB');
  ok(/length\(tiles_blob\)\s*=\s*1024/.test(body), '必须约束 1024 字节');
  ok(/PRIMARY KEY \(room_id, chunk_x, chunk_y\)/.test(body), '复合主键缺失');
});

test('A06 三个指定索引齐备:room_chunks 主键、ai_item_instances.owner_id、ai_alchemy_recipes.craft_count', () => {
  const ddl = readSchemaSql();
  const idx = [...ddl.matchAll(/CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*)\s+ON\s+([a-z_][\w]*)\s*\(([^)]*)\)/gi)]
    .map((m) => ({ name: m[1], table: m[2], cols: m[3].replace(/\s+/g, ' ') }));
  ok(idx.length >= 9, `索引数 ${idx.length} < 9`);
  ok(idx.some((i) => i.table === 'ai_item_instances' && /\bowner_id\b/.test(i.cols)), 'ai_item_instances.owner_id 索引缺失');
  ok(idx.some((i) => i.table === 'ai_alchemy_recipes' && /\bcraft_count\b/.test(i.cols)), 'ai_alchemy_recipes.craft_count 索引缺失');
  ok(idx.some((i) => i.table === 'room_chunks' && /\bupdated_at\b/.test(i.cols)), 'room_chunks 增量索引缺失');
});

test('A07 外键与 ON DELETE 策略齐备(CASCADE / SET NULL 各至少一条)', () => {
  const ddl = readSchemaSql();
  const fks = [...ddl.matchAll(/FOREIGN KEY \(([a-z_]+)\)\s+REFERENCES\s+([a-z_]+)\(([a-z_]+)\)\s+ON DELETE (CASCADE|SET NULL)/gi)];
  ok(fks.length >= 8, `外键数 ${fks.length} < 8`);
  ok(fks.some((m) => m[4].toUpperCase() === 'CASCADE'), '缺 CASCADE');
  ok(fks.some((m) => m[4].toUpperCase() === 'SET NULL'), '缺 SET NULL');
});

test('A07b FOREIGN_KEYS 常量与 schema.sql 的 DDL 逐条对齐(防两份外键定义漂移)', () => {
  const ddl = readSchemaSql();
  /* 从 DDL 抽出所有 (子表, 子列) -> (父表, 父列, 策略)。 */
  const fromDdl = new Map<string, { to: string; toCol: string; onDelete: string }>();
  /* 逐表扫描,以便把 FOREIGN KEY 归属到正确的子表。 */
  for (const m of ddl.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][\w]*) \(([\s\S]*?)\n\)(?: WITHOUT ROWID)?;/g)) {
    const childTable = m[1];
    for (const fk of m[2].matchAll(
      /FOREIGN KEY \(([a-z_]+)\)\s+REFERENCES\s+([a-z_]+)\(([a-z_]+)\)\s+ON DELETE (CASCADE|SET NULL)/g,
    )) {
      fromDdl.set(`${childTable}.${fk[1]}`, {
        to: fk[2], toCol: fk[3], onDelete: fk[4].toUpperCase(),
      });
    }
  }
  eq(fromDdl.size, 11, `DDL 中应有 11 条外键,实际 ${fromDdl.size}`);
  eq(FOREIGN_KEYS.length, fromDdl.size, 'MemoryDb 的 FOREIGN_KEYS 条数应与 DDL 一致');

  for (const fk of FOREIGN_KEYS) {
    const key = `${fk.from}.${fk.fromCol}`;
    const spec = fromDdl.get(key);
    ok(spec !== undefined, `FOREIGN_KEYS 多出 DDL 没有的外键:${key}`);
    eq(fk.to, spec.to, `${key} 父表`);
    eq(fk.toCol, spec.toCol, `${key} 父列`);
    eq(fk.onDelete, spec.onDelete, `${key} 删除策略`);
  }
  /* 反向:DDL 里的每条外键都要被 MemoryDb 实现,否则内存库行为与真实库不一致。 */
  for (const key of fromDdl.keys()) {
    ok(FOREIGN_KEYS.some((f) => `${f.from}.${f.fromCol}` === key), `DDL 外键 ${key} 未在 FOREIGN_KEYS 中实现`);
  }
});

test('A07b splitStatements 跳过 SQL 注释(否则 CREATE TABLE 被从注释中间切开)', () => {
  /* 真实缺陷:`schema.sql` 的注释头含 `;`(「见 repo.ts:savePlayer」这类说明),
     改前切分不识别注释 → 9 张表只解析出 2 张,而 migrate() 不报错。
     这里用**包含注释的原文**切分,要求表数正确 —— 而不是靠调用方先剥注释。 */
  const raw = readSchemaSql();
  const stmtsRaw = splitStatements(raw);
  const tablesRaw = stmtsRaw
    .map((s) => /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][\w]*)/i.exec(s.trim())?.[1])
    .filter((t) => t !== undefined);
  eq(tablesRaw.length, 9, `含注释原文切分应得 9 张表,实际 ${tablesRaw.length}`);

  /* 行注释里的分号不得切断语句 */
  const withLineComment = 'CREATE TABLE a (x INT);\n-- 说明:见 foo.ts:bar; baz\nCREATE TABLE b (y INT);';
  const stmts2 = splitStatements(withLineComment)
    .map((s) => /CREATE\s+TABLE\s+([a-z_]+)/i.exec(s.trim())?.[1])
    .filter((t) => t !== undefined);
  eq(stmts2, ['a', 'b'], '行注释中的分号不应切断语句');

  /* 块注释同理 */
  const withBlock = 'CREATE TABLE c (x INT);\n/* 说明:见 foo.ts:a; b */\nCREATE TABLE d (y INT);';
  const stmts3 = splitStatements(withBlock)
    .map((s) => /CREATE\s+TABLE\s+([a-z_]+)/i.exec(s.trim())?.[1])
    .filter((t) => t !== undefined);
  eq(stmts3, ['c', 'd'], '块注释中的分号不应切断语句');

  /* 字符串字面量里的分号也不得切断语句(原有能力,一并锁住) */
  const withStr = "CREATE TABLE e (x TEXT DEFAULT 'a;b');CREATE TABLE f (y INT);";
  const stmts4 = splitStatements(withStr)
    .map((s) => /CREATE\s+TABLE\s+([a-z_]+)/i.exec(s.trim())?.[1])
    .filter((t) => t !== undefined);
  eq(stmts4, ['e', 'f'], '字符串字面量中的分号不应切断语句');
});

test('A07c MemoryDb 从 DDL 解析出 NOT NULL / CHECK 约束,且无静默漏项', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  /* 约束必须真的被解析到 —— 否则「强制约束」是空操作 */
  const users = db.constraintSummary('users');
  ok(users.notNull >= 14, `users NOT NULL 解析出 ${users.notNull} 条(应 ≥ 14)`);
  ok(users.checks >= 6, `users CHECK 解析出 ${users.checks} 条(应 ≥ 6)`);
  const rooms = db.constraintSummary('rooms');
  ok(rooms.notNull >= 11, `rooms NOT NULL 解析出 ${rooms.notNull} 条(应 ≥ 11)`);
  ok(rooms.checks >= 8, `rooms CHECK 解析出 ${rooms.checks} 条(应 ≥ 8)`);

  /* 未实现的 CHECK 形态必须可枚举(跨列表达式无法用单列谓词表达)。
     这里锁住**数量**,所以将来 schema.sql 加了新形态会立刻暴露,
     而不是静默放行。 */
  const un = db.unsupportedChecks();
  eq(un.length, 2, `未实现的 CHECK 应为 2 条(rooms 的两条跨列 access_mode/password_hash),实际 ${un.length}`);
  for (const u of un) eq(u.table, 'rooms', '未实现的 CHECK 目前应只在 rooms');
});

test('A07d MemoryDb 强制 NOT NULL / CHECK / 外键(与真实 SQLite 行为一致)', () => {
  const mk = (): MemoryDb => {
    const db = new MemoryDb();
    migrate(db, 1000);
    createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
    createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
    return db;
  };

  /* 外键:指向不存在的父行必须被拒(改前是**接受**的) */
  let threw = false;
  try {
    mk().insert('room_players', { room_id: 'NOPE', user_id: 'u1', joined_at: 0, last_seen_at: 0 });
  } catch (e) {
    threw = true;
    includes([(e as Error).message], (e as Error).message, '应抛错');
  }
  ok(threw, '插入指向不存在房间的 room_players 应被外键拒绝');

  /* NOT NULL:缺列必须被拒 */
  threw = false;
  try {
    mk().insert('rooms', { id: 'r2', owner_id: 'u1' });
  } catch {
    threw = true;
  }
  ok(threw, '插入缺 NOT NULL 列(name)的 rooms 应被拒绝');

  /* NOT NULL:update 写成 null 必须被拒 */
  threw = false;
  try {
    mk().update('rooms', { id: 'r1' }, { status: null });
  } catch {
    threw = true;
  }
  ok(threw, 'update 把 NOT NULL 列写成 null 应被拒绝');

  /* CHECK:枚举外取值必须被拒 */
  threw = false;
  try {
    mk().insert('room_players', {
      room_id: 'r1', user_id: 'u1', role: 'SUPERUSER', joined_at: 0, last_seen_at: 0,
    });
  } catch {
    threw = true;
  }
  ok(threw, 'role=SUPERUSER 应被 CHECK 拒绝');

  threw = false;
  try {
    mk().update('rooms', { id: 'r1' }, { access_mode: 'WAT' });
  } catch {
    threw = true;
  }
  ok(threw, 'access_mode=WAT 应被 CHECK 拒绝');

  /* CHECK:区间约束(level BETWEEN 1 AND 30) */
  threw = false;
  try {
    mk().update('users', { id: 'u1' }, { level: 99 });
  } catch {
    threw = true;
  }
  ok(threw, 'level=99 超出 BETWEEN 1 AND 30,应被拒绝');

  /* 合法写入不得被误伤 —— 否则约束是「过度拦截」而非「对齐」 */
  const good = mk();
  good.update('rooms', { id: 'r1' }, { status: RoomStatus.SLEEPING });
  good.update('users', { id: 'u1' }, { level: 30, hp: 0 });
  eq(good.select('rooms', { id: 'r1' })[0].status, 'SLEEPING', '合法状态应写入成功');
  eq(good.select('users', { id: 'u1' })[0].level, 30, '边界值 level=30 应合法');
});

test('A07e DDL 的 DEFAULT 会被补齐(MemoryDb 存下的行与真实库一致)', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  /* 不传 status / max_players,应被 DEFAULT 补齐 */
  const row = db.select('rooms', { id: 'r1' })[0];
  eq(row.status, 'OPEN', 'status 应由 DEFAULT 补为 OPEN');
  eq(row.max_players, 16, 'max_players 应由 DEFAULT 补为 16');
  eq(row.access_mode, 'PUBLIC', 'access_mode 应由 DEFAULT 补为 PUBLIC');
  eq(row.world_tick, 0, 'world_tick 应由 DEFAULT 补为 0');
});

test('A07f 触发器:改 rooms.status 自动写 ROOM_STATUS 审计事件(WHEN OLD<>NEW)', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });

  const before = db.count('room_events');
  db.update('rooms', { id: 'r1' }, { status: RoomStatus.SLEEPING, last_active_at: 2000 });
  eq(db.count('room_events'), before + 1, '状态变更应触发一条审计事件');

  const ev = db.select('room_events').at(-1) as Record<string, unknown>;
  eq(ev.kind, 'ROOM_STATUS', '审计事件 kind');
  eq(ev.room_id, 'r1', '审计事件归属房间');
  const payload = JSON.parse(String(ev.payload_json)) as { from: string; to: string };
  eq(payload.from, 'OPEN', 'payload.from');
  eq(payload.to, 'SLEEPING', 'payload.to');

  /* WHEN OLD.status <> NEW.status —— 同值更新不得再写 */
  const mid = db.count('room_events');
  db.update('rooms', { id: 'r1' }, { status: RoomStatus.SLEEPING });
  eq(db.count('room_events'), mid, '同状态更新不应写审计事件');

  /* 非 status 字段更新也不应触发 */
  db.update('rooms', { id: 'r1' }, { world_tick: 7 });
  eq(db.count('room_events'), mid, '改 world_tick 不应写审计事件');
});

test('A07g writeEvent 的主键取号是**全表**的,且不依赖重试兜底', () => {
  /* 真实 bug:`room_events.id` 是全表自增主键,但 writeEvent 曾按
     「该房间的 maxId + 1」取号 → 房间 A 有事件后给房间 B 写第一条就撞主键。
     多房间是核心场景(§7),而原测试全在同一房间内写,所以测不出来。 */
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'roomA', ownerId: 'u1', nowMs: 1000 });
  createRoom(db, { id: 'roomB', ownerId: 'u1', nowMs: 1000 });

  /* A 房间先产生一条事件(改状态走触发器) */
  db.update('rooms', { id: 'roomA' }, { status: RoomStatus.SLEEPING });
  eq(db.count('room_events'), 1, 'A 应有 1 条事件');

  /* B 房间写第一条 —— 改前这里抛「主键冲突:1」 */
  resetEventIdRetryCount();
  writeEvent(db, 'roomB', 1, 'AC_SPEED', 'u1', {}, 3000);
  eq(db.count('room_events'), 2, 'B 房间写事件应成功,id 不与 A 相撞');
  eq(eventIdRetryCount(), 0, '正常路径不应依赖取号重试兜底');

  /* 两个房间各自的 id 全局唯一且连续 */
  const ids = db.select('room_events').map((r) => Number(r.id)).sort((a, b) => a - b);
  eq(ids, [1, 2], '事件 id 应全表连续');

  /* 继续给两个房间交替写,仍不应触发重试 */
  writeEvent(db, 'roomA', 2, 'K', null, {}, 4000);
  writeEvent(db, 'roomB', 3, 'K', null, {}, 4001);
  eq(eventIdRetryCount(), 0, '交替跨房间写仍不应触发重试');
  eq(db.select('room_events').length, 4, '应有 4 条事件');
});

test('A08 MemoryDb 从 schema.sql 建出 9 表 + 索引 + 视图 + 触发器', () => {
  const db = new MemoryDb();
  const r = migrate(db, 1_700_000_000_000);
  eq(r.applied, true, 'migrate 应登记版本');
  eq(r.drift, false, '不应漂移');
  const tables = db.tableNames();
  eq(tables.length, 9, `表数 ${tables.length}`);
  includes(tables, 'schema_migrations');
  includes(tables, 'room_chunks');
  ok(db.indexNames().length >= 9, `索引 ${db.indexNames().length} < 9`);
  includes(db.viewNames(), 'v_public_rooms');
  includes(db.triggerNames(), 'trg_rooms_status_change');
});

test('A09 migrate 幂等:二次调用 applied=false,checksum 稳定', () => {
  const db = new MemoryDb();
  const a = migrate(db, 1000);
  const b = migrate(db, 2000);
  eq(a.checksum, b.checksum, 'checksum 必须稳定');
  eq(b.applied, false, '第二次不应重复登记');
  eq(db.count('schema_migrations'), 1, '迁移表应只有 1 行');
});

test('A10 migrate 检测 DDL 漂移(fail-closed)', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  /* 手工把登记行改成一个不匹配的 checksum,模拟「同版本 DDL 被改动」。 */
  db.update('schema_migrations', { version: 1 }, { checksum: 'fnv1a:deadbeef' });
  const r = migrate(db, 2000);
  eq(r.drift, true, '应检出漂移');
  eq(r.applied, false, '漂移时不得登记');
});

test('A11 checksumOf 是确定性函数且对单字符变化敏感', () => {
  eq(checksumOf('abc'), checksumOf('abc'));
  ok(checksumOf('abc') !== checksumOf('abd'), 'checksum 必须对内容敏感');
  ok(/^fnv1a:[0-9a-f]{8}$/.test(checksumOf('x')), '格式应为 fnv1a:xxxxxxxx');
});

test('A12 chunk blob 1024 字节 round-trip(256 格 × u32 小端)', () => {
  const cells = new Uint32Array(CHUNK_CELLS);
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    cells[i] = packTile({
      elev: i % 4, base: (i * 3) % 16, floor: (i * 7) % 64,
      wire: (i * 5) % 16, obj: (i * 137) % 4096, meta: (i * 11) % 16,
    });
  }
  const blob = packChunkBlob(cells);
  eq(blob.byteLength, CHUNK_BYTES, 'blob 必须 1024 字节');
  eq(blob.byteLength, 1024);
  const back = unpackChunkBlob(blob);
  eq(back.length, CHUNK_CELLS);
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    if (back[i] !== cells[i]) throw new Error(`第 ${i} 格不一致:${back[i]} ≠ ${cells[i]}`);
  }
  /* 位压缩字段仍然能正确解出(端到端:packTile → blob → unpackTile)。 */
  const f = unpackTile(back[42]);
  eq(f.elev, 42 % 4);
  eq(f.obj, (42 * 137) % 4096);
});

test('A13 packChunkBlob 拒绝非法长度;assertChunkBlob 拒绝非 1024', () => {
  let threw = false;
  try { packChunkBlob(new Uint32Array(10)); } catch { threw = true; }
  ok(threw, '短数组应抛错');
  threw = false;
  try { unpackChunkBlob(new Uint8Array(1023)); } catch { threw = true; }
  ok(threw, '1023 字节应抛错');
});

test('A14 saveChunk/loadChunk:落库后 1024 字节逐字节一致,version 自增', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: '岛主', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });

  const cells = new Uint32Array(CHUNK_CELLS).fill(0xabcd1234);
  const blob = packChunkBlob(cells);
  saveChunk(db, 'r1', 3, -2, blob, 2000);
  let rec = loadChunk(db, 'r1', 3, -2);
  ok(rec !== undefined, '应能读回');
  eq(rec.version, 1, '首版 version=1');
  eq(rec.tiles_blob.byteLength, 1024);
  for (let i = 0; i < 1024; i += 1) if (rec.tiles_blob[i] !== blob[i]) throw new Error(`字节 ${i} 不一致`);

  saveChunk(db, 'r1', 3, -2, blob, 3000);
  rec = loadChunk(db, 'r1', 3, -2);
  eq(rec.version, 2, '再写 version+1');
  eq(db.count('room_chunks'), 1, '同坐标不应产生第二行');

  const cellsBack = loadChunkCells(db, 'r1', 3, -2);
  ok(cellsBack !== undefined);
  eq(cellsBack[0], 0xabcd1234 >>> 0);
  eq(cellsBack[255], 0xabcd1234 >>> 0);
});

test('A15 saveChunkBatch 事务性:一批内有一块非法长度则整批回滚', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  const good = packChunkBlob(new Uint32Array(CHUNK_CELLS).fill(7));

  let threw = false;
  try {
    saveChunkBatch(db, 'r1', [
      { cx: 0, cy: 0, blob: good },
      { cx: 1, cy: 0, blob: new Uint8Array(512) },
    ], 2000);
  } catch { threw = true; }
  ok(threw, '非法批应抛错');
  eq(db.count('room_chunks'), 0, '不应写入任何一块');
});

test('A16 saveChunkBatch 正常批写入 N 块;chunksUpdatedSince 只捞增量', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  const mk = (v: number) => packChunkBlob(new Uint32Array(CHUNK_CELLS).fill(v));
  const n = saveChunkBatch(db, 'r1', [
    { cx: 0, cy: 0, blob: mk(1) },
    { cx: 1, cy: 0, blob: mk(2) },
    { cx: 0, cy: 1, blob: mk(3) },
  ], 1000);
  eq(n, 3);
  const since = chunksUpdatedSince(db, 'r1', 1001);
  eq(since.length, 0, '时间之后无变更');
  saveChunk(db, 'r1', 1, 0, mk(9), 5000);
  eq(chunksUpdatedSince(db, 'r1', 1001).length, 1, '只应有 1 块增量');
});

test('A17 users CRUD + savePlayerState 的边界钳制', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  const u = createUser(db, { id: 'u1', displayName: '小酱', nowMs: 1000 });
  eq(u.level, 1);
  eq(u.hp, 100);
  eq(u.inventory_json, '{}');

  savePlayerState(db, 'u1', { level: 30, max_hp: 535, hp: 535 }, 2000);
  const after = getUser(db, 'u1');
  eq(after?.level, 30);
  eq(after?.max_hp, 535);

  /* hp 超过 max_hp 被钳到 max_hp。 */
  savePlayerState(db, 'u1', { hp: 9999 }, 3000);
  eq(getUser(db, 'u1')?.hp, 535, 'hp 应被钳到 max_hp');

  let threw = false;
  try { savePlayerState(db, 'u1', { dir: 5 }, 4000); } catch { threw = true; }
  ok(threw, 'dir 越界应抛错');

  threw = false;
  try { createUser(db, { id: 'u2', displayName: 'X', nowMs: 1000, level: 31 }); } catch { threw = true; }
  ok(threw, 'level 31 应抛错');
});

test('A18 rooms:PUBLIC/PASSWORD 互斥校验 + 级联删除', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });

  let threw = false;
  try {
    createRoom(db, { id: 'rp', ownerId: 'u1', accessMode: AccessMode.PASSWORD, nowMs: 1000 });
  } catch { threw = true; }
  ok(threw, '密码房无 hash 应抛错');

  threw = false;
  try {
    createRoom(db, { id: 'rx', ownerId: 'u1', accessMode: AccessMode.PUBLIC, passwordHash: 'h', nowMs: 1000 });
  } catch { threw = true; }
  ok(threw, '公开房带 hash 应抛错');

  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  createRoom(db, { id: 'r2', ownerId: 'u1', accessMode: AccessMode.PASSWORD, passwordHash: 'h', nowMs: 1000 });
  eq(db.count('rooms'), 2);

  /* 删 user → rooms 级联删。 */
  db.delete('users', { id: 'u1' });
  eq(db.count('rooms'), 0, 'rooms 应随 user 级联删除');
  eq(db.count('users'), 0);
});

test('A19 ai_alchemy_recipes:craft_count 累加 + Top 榜排序', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  const mk = (hash: string, count: number): RecipeRecord => ({
    recipe_hash: hash, input_ids: '[712,116]', k_inputs: 2,
    item_name: `奇物-${hash}`, category: 'AI_CRAFTED', rarity_tier: 2,
    t_eff: 120.5, q_score: 1.12, p_budget: 900,
    stats_json: '{}', visual_json: '{}', pixel_icon_json: '[]',
    llm_model: 'test', first_crafter_id: 'u1',
    craft_count: count, created_at: 1000, last_crafted_at: 1000,
  });
  upsertRecipe(db, mk('116_712', 3));
  upsertRecipe(db, mk('125_712', 7));
  incrementCraftCount(db, '116_712', 2000);
  eq(getRecipe(db, '116_712')?.craft_count, 4, 'craft_count 应 +1');
  const top = listTopRecipes(db, 5);
  eq(top[0].recipe_hash, '125_712', 'Top 应为 craft_count 最大者');

  let threw = false;
  try { upsertRecipe(db, { ...mk('1_2', 1), k_inputs: 5 }); } catch { threw = true; }
  ok(threw, 'k_inputs=5 应抛错');
});

test('A20 ai_item_instances:条目守恒(消耗不得为负、不得凭空增加)', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  upsertRecipe(db, {
    recipe_hash: '116_712', input_ids: '[]', k_inputs: 2, item_name: 'x',
    category: 'AI_CRAFTED', rarity_tier: 1, t_eff: 1, q_score: 1, p_budget: 1,
    stats_json: '{}', visual_json: '{}', pixel_icon_json: '[]', llm_model: 'm',
    first_crafter_id: 'u1', craft_count: 1, created_at: 1000, last_crafted_at: 1000,
  });
  addItemInstance(db, {
    instance_id: 'i1', owner_id: 'u1', recipe_hash: '116_712',
    slot: 'weapon', quantity: 5, equipped: 0, stats_json: '{}',
    bound_room_id: null, created_at: 1000, updated_at: 1000,
  });
  eq(totalItemsOf(db, 'u1'), 5);

  eq(consumeItem(db, 'i1', 2, 2000), true);
  eq(totalItemsOf(db, 'u1'), 3);
  eq(consumeItem(db, 'i1', 99, 3000), false, '超量消耗应拒');
  eq(totalItemsOf(db, 'u1'), 3, '拒绝时不得改库');
  eq(consumeItem(db, 'i1', 3, 4000), true);
  eq(db.count('ai_item_instances'), 0, '归零应删行');
});

test('A21 writeEvent / listEvents 按 tick 倒序', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  writeEvent(db, 'r1', 100, 'AC_SPEED', 'u1', { d: 'x' }, 1000);
  writeEvent(db, 'r1', 300, 'AC_TELEPORT', 'u1', { d: 'y' }, 2000);
  writeEvent(db, 'r1', 200, 'ROOM_STATUS', null, {}, 1500);
  const ev = listEvents(db, 'r1', 10);
  eq(ev.length, 3);
  eq(ev[0].tick, 300, '首条应为最大 tick');
  eq(ev[2].tick, 100);
});

/* ══════════════════ B. Schema 字段表 ══════════════════ */

test('B01 FIELD_TABLE 覆盖 §7.2 全 14 字段(id/name + 13 状态)', () => {
  const keys = FIELD_TABLE.map((f) => f.key);
  const required = [
    'id', 'name', 'level', 'hp', 'maxHp', 'x', 'y', 'z', 'dir',
    'stateFlag', 'weaponId', 'aiWeaponRecipeHash', 'heldItemId', 'carryingEntityId',
  ];
  eq(keys.length, required.length, `字段数 ${keys.length}`);
  for (const k of required) includes(keys, k, `缺字段 ${k}`);
});

test('B02 所有字段表无 bit 冲突 / 无 key 重复 / bit < 32', () => {
  for (const [label, t] of [
    ['FIELD_TABLE', FIELD_TABLE],
    ['WILDLIFE', WILDLIFE_FIELD_TABLE],
    ['BOSS', BOSS_FIELD_TABLE],
    ['ROOM', ROOM_FIELD_TABLE],
  ] as const) {
    const errs = validateFieldTable(t);
    eq(errs.length, 0, `${label} 校验失败:${errs.join(', ')}`);
  }
});

test('B03 fullMask 覆盖全字段,且与逐位或结果一致', () => {
  const m = fullMask(EntityKind.PLAYER);
  eq(m, (1 << 14) - 1, '14 字段应得 0x3FFF');
  let manual = 0;
  for (const f of tableFor(EntityKind.PLAYER)) manual |= 1 << f.bit;
  eq(m, manual >>> 0);
  ok(fullMask(EntityKind.BOSS) > 0);
  ok(fullMask(EntityKind.ROOM) > 0);
});

test('B04 坐标定点:quantize/dequantize 往返误差 < 1/1024,且超界被钳', () => {
  eq(POS_SCALE, 1024);
  for (const v of [0, 0.5, -1, 3.14159, 123.456789, -999.9999]) {
    const q = quantizePos(v);
    near(dequantizePos(q), v, 1 / (2 * POS_SCALE), `v=${v}`);
  }
  eq(quantizePos(1e12), 2147483647, '正超界钳到 int32 max');
  eq(quantizePos(-1e12), -2147483648, '负超界钳到 int32 min');
  eq(quantizePos(Number.NaN), 0, 'NaN → 0');
});

test('B05 stateFlag 索引与 BodyState 七态一一对应', () => {
  eq(Object.keys(StateFlagIndex).length, 7);
  eq(StateFlagIndex.NORMAL, 0);
  eq(StateFlagIndex.AFK_SHIELD, 6);
  eq(BodyState.SLIPPING, 'SLIPPING');
  eq(StateFlagIndex.SLIPPING, 1);
});

test('B06 单实体全字段典型字节数(逐字段实测:玩家 62 / 野怪 51 / Boss 51 / 房间 33)', () => {
  /* 玩家 62 = id 8 + name 9 + level 1 + hp 2 + maxHp 2 + xyz 12 + dir 1
   *          + stateFlag 1 + weaponId 2 + recipeHash 13 + heldItemId 2 + carryingId 9
   * 野怪 51 = id 8 + mobId 17 + xyz 12 + fsm 1 + hp 2 + maxHp 2 + tameOwner 9
   * Boss 51 = id 8 + bossId 17 + phase 1 + hp 4 + maxHp 4 + 预警几何 4+4+4 + endTick 4
   * 房间 33 = chunkVersions 24 + partyMode 1 + partyTimer 4 + scoreA 2 + scoreB 2
   *          (帧号走报文头,不计入字段表)
   * 逐字段求和必须等于断言值 —— 改字段表就会让这条测试失败,起到守卫作用。 */
  eq(entityPayloadBytes(EntityKind.PLAYER), 62, '玩家');
  eq(entityPayloadBytes(EntityKind.WILDLIFE), 51, '野怪');
  eq(entityPayloadBytes(EntityKind.BOSS), 51, 'Boss');
  eq(entityPayloadBytes(EntityKind.ROOM), 33, '房间');

  /* 逐字段核对:实现里的 bytes 与字段表逐项一致,且 bit 无空洞。 */
  eq(FIELD_TABLE.reduce((s, f) => s + f.bytes, 0), 62);
  eq(WILDLIFE_FIELD_TABLE.reduce((s, f) => s + f.bytes, 0), 51);
  eq(BOSS_FIELD_TABLE.reduce((s, f) => s + f.bytes, 0), 51);
  eq(ROOM_FIELD_TABLE.reduce((s, f) => s + f.bytes, 0), 33);

  /* 变长字段的模型字节数 = 1 字节长度前缀 + 载荷。 */
  const recipe = FIELD_TABLE.find((f) => f.key === 'aiWeaponRecipeHash');
  eq(recipe?.type, FieldType.HASH);
  eq(recipe?.bytes, 13, '1 + 12 字节 recipeHash');
});

test('B07 chunkVersions 序列化确定性:键排序后 snake_case 稳定', () => {
  const a = serializeChunkVersions({ '2,1': 5, '0,0': 1, '1,0': 3 });
  const b = serializeChunkVersions({ '1,0': 3, '2,1': 5, '0,0': 1 });
  eq(a, b, '不同插入顺序应得同一串');
  eq(a, '0,0:1;1,0:3;2,1:5');
  const back = parseChunkVersions(a);
  eq(back['0,0'], 1);
  eq(back['2,1'], 5);
  eq(Object.keys(parseChunkVersions('')).length, 0);
});

test('B08 cloneRoomState 是深拷贝:改副本不影响原状态', () => {
  const s = createRoomState('r');
  upsertPlayer(s, createPlayerState('p1', { x: 1 }));
  bumpChunkVersion(s, 0, 0);
  const c = cloneRoomState(s);
  c.players[0].x = 999;
  c.meta.chunkVersions['0,0'] = 42;
  eq(s.players[0].x, 1, '原状态不应被改');
  eq(s.meta.chunkVersions['0,0'], 1);
});

test('B09 bumpChunkVersion 单调递增,并写入 chunkVersions', () => {
  const s = createRoomState('r');
  eq(bumpChunkVersion(s, 3, 4), 1);
  eq(bumpChunkVersion(s, 3, 4), 2);
  eq(bumpChunkVersion(s, 1, 1), 1);
  eq(s.meta.chunkVersions['3,4'], 2);
});

/* ══════════════════ C. 差量编码 ══════════════════ */

function buildRoom(nPlayers: number): RoomState {
  const s = createRoomState('room_alpha');
  s.meta.tick = 100;
  for (let i = 0; i < nPlayers; i += 1) {
    s.players.push(createPlayerState(`p${i}`, {
      name: `玩家${i}`,
      level: 10 + i,
      hp: 200 + i,
      maxHp: 235,
      x: 10 + i, y: 20 + i, z: 0,
      dir: i % 4,
      stateFlag: 0,
      weaponId: 712,
      aiWeaponRecipeHash: '116_125_712',
      heldItemId: 0,
      carryingEntityId: '',
    }));
  }
  for (let i = 0; i < 4; i += 1) {
    s.wildlife.push(createWildlifeState(`w${i}`, {
      mobId: 'mob_meadow_piglet', x: 5 + i, y: 6 + i, z: 0,
      fsm: 0, hp: 30, maxHp: 30,
    }));
  }
  s.bosses.push(createBossState('b1', { hp: 2500, maxHp: 7375, phase: 0 }));
  s.meta.chunkVersions['0,0'] = 1;
  return s;
}

test('C01 全量编码可解码:op=FULL,实体数 = 玩家 + 野怪 + Boss + 房间', () => {
  const s = buildRoom(4);
  const full = encodeFull(s, 100);
  const pkt = decodePacket(full.bytes);
  /* 版本号锚定**字面量**。此处原为 `eq(pkt.version, PROTOCOL_VERSION)` —— 断言右侧
   * 取自被测常量 `delta.ts:50`,而 `encodeFull` 写进去的就是同一个常量,两边同源 ⇒
   * 把 `PROTOCOL_VERSION` 改成 7 也全绿(实测:132/132)。它是**跨端协议版本号**,
   * 静默改版会导致客户端/服务端不兼容而没有任何门禁报警。
   *
   * 基线值 1 的出处:`docs/WS-07-net-persist.md` §5 参数配表 —— `PROTOCOL_VERSION | 1 |
   * 协议 bump 依据`,以及 §4.1 线格式 `w.write(u8 PROTOCOL_VERSION)`(u8,故 1 位字节可容纳)。
   * 现有线格式为 v1,尚未 bump;改动线格式时必须**同时**改这里与实现,门禁即在此处变红。 */
  eq(pkt.version, 1, '报文头版本号(协议基线 v1;线格式 bump 时此处必须同步)');
  eq(pkt.op, PacketOp.FULL);
  eq(pkt.tick, 100);
  eq(pkt.removed.length, 0);
  /* 1 房间 + 4 玩家 + 4 野怪 + 1 Boss */
  eq(pkt.upserts.length, 10, `upsert 数 ${pkt.upserts.length}`);
  eq(pkt.bytesConsumed, full.bytes.length, '应刚好读完');
});

test('C01b 协议版本门真的会拒:篡改报文头版本字节 → decodePacket 必须抛错', () => {
  /* 上面 C01 只断言「写进去的版本号 == 1」。这只证明**编码端**写对,
   * 不证明**解码端**会拒绝错误版本。这里手工把报文首字节(版本号)改成
   * 非 1 的值,断言 decodePacket 抛错 —— 这才是「协议 bump 时旧客户端
   * 会被拒」的真正门禁。若哪天有人把 delta.ts:425 的校验删掉,本断言变红。 */
  const s = buildRoom(2);
  const bytes = encodeFull(s, 42).bytes;
  eq(bytes[0], 1, '编码端应把版本号写在首字节(u8)');

  for (const bad of [0, 2, 7, 255]) {
    const tampered = Uint8Array.from(bytes);
    tampered[0] = bad;
    let threw = false;
    let msg = '';
    try {
      decodePacket(tampered);
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    ok(threw, `版本号=${bad} 的报文必须被拒(否则跨端静默不兼容)`);
    ok(msg.includes('协议版本不匹配'), `拒绝信息应说明版本不匹配,实际「${msg}」`);
    ok(msg.includes(String(bad)), `拒绝信息应带上收到的版本号 ${bad},实际「${msg}」`);
  }

  /* 反向对照:版本号正确时不应抛错(证明上面的抛错来自版本校验,不是别的原因)。 */
  const okPkt = decodePacket(bytes);
  eq(okPkt.version, 1, '未篡改时应正常解出 v1');
});

test('C02 **字段级 diff**:只改一个玩家的一格坐标,报文只含该玩家 + x/y 两字段', () => {
  const prev = buildRoom(4);
  const next = cloneRoomState(prev);
  next.players[2].x += 1;   // 一格
  next.players[2].y += 1;

  const d = encodeDelta(prev, next, 101);
  eq(d.stats.changedFields.length, 1, `变更实体数 ${d.stats.changedFields.length}`);
  const ch = d.stats.changedFields[0];
  eq(ch.id, 'p2', '应是 p2');
  eq(ch.kind, EntityKind.PLAYER);
  ok(ch.fields.includes('x'), 'x 应出现');
  ok(ch.fields.includes('y'), 'y 应出现');
  eq(ch.fields.length, 2, `只应有 2 个字段,实际 ${ch.fields.join(',')}`);
  ok(!ch.fields.includes('hp'), 'hp 不应出现');
  ok(!ch.fields.includes('name'), 'name 不应出现');
  ok(!ch.fields.includes('weaponId'), 'weaponId 不应出现');
});

test('C03 差量字节数 < 全量编码的 1/10', () => {
  const prev = buildRoom(8);
  const next = cloneRoomState(prev);
  next.players[3].x += 1;
  next.players[3].y += 1;

  const full = encodeFull(next, 101);
  const delta = encodeDelta(prev, next, 101);
  ok(delta.bytes.length * 10 < full.bytes.length,
    `差量 ${delta.bytes.length}B 未小于全量 ${full.bytes.length}B 的 1/10(${(full.bytes.length / 10).toFixed(1)}B)`);
  /* 具体量级:头 6 + 删 2 + upsert 计数 2 + (kind1 + id9 + mask4 + 8B 值) = 32 左右。 */
  inRange(delta.bytes.length, 24, 40, `差量字节 ${delta.bytes.length}`);
});

test('C04 差量 round-trip:applyPacket(prev, decode(delta)) 与 next 一致', () => {
  const prev = buildRoom(6);
  const next = cloneRoomState(prev);
  next.players[1].x = 77.123;
  next.players[1].hp = 12;
  next.players[1].stateFlag = 3;
  next.players[4].weaponId = 719;
  next.meta.tick = 555;
  next.meta.partyMode = 2;
  upsertWildlife(next, createWildlifeState('w_new', { mobId: 'mob_valley_beaver', x: 1, y: 2 }));
  next.bosses[0].phase = 2;
  next.bosses[0].hp = 100;
  next.bosses[0].telegraphShape = 1;
  next.bosses[0].telegraphEndTick = 900;
  next.meta.chunkVersions['5,5'] = 1;

  const d = encodeDelta(prev, next, 555);
  const rebuilt = applyPacket(prev, decodePacket(d.bytes));

  eq(rebuilt.meta.tick, 555);
  eq(rebuilt.meta.partyMode, 2);
  near(rebuilt.players[1].x, 77.123, 1 / POS_SCALE, 'x 定点精度内');
  eq(rebuilt.players[1].hp, 12);
  eq(rebuilt.players[1].stateFlag, 3);
  eq(rebuilt.players[4].weaponId, 719);
  eq(rebuilt.wildlife.length, prev.wildlife.length + 1, '新增野怪应被重建');
  ok(rebuilt.wildlife.some((w) => w.id === 'w_new'), 'w_new 应存在');
  eq(rebuilt.bosses[0].phase, 2);
  eq(rebuilt.bosses[0].hp, 100);
  eq(rebuilt.bosses[0].telegraphShape, 1);
  eq(rebuilt.bosses[0].telegraphEndTick, 900);
  eq(rebuilt.meta.chunkVersions['5,5'], 1);
});

test('C05 删除实体编码在 removed 段,应用后消失', () => {
  const prev = buildRoom(4);
  const next = cloneRoomState(prev);
  next.players = next.players.filter((p) => p.id !== 'p2');
  next.wildlife = next.wildlife.filter((w) => w.id !== 'w1');

  const d = encodeDelta(prev, next, 102);
  eq(d.stats.removed.length, 2, `应删 2 个,实际 ${d.stats.removed.length}`);
  ok(d.stats.removed.some((r) => r.id === 'p2'));
  ok(d.stats.removed.some((r) => r.id === 'w1'));

  const rebuilt = applyPacket(prev, decodePacket(d.bytes));
  eq(rebuilt.players.length, 3);
  eq(rebuilt.wildlife.length, 3);
  ok(!rebuilt.players.some((p) => p.id === 'p2'));
});

test('C06 无变化时差量只有头 + 两个计数(≤ 12 字节)', () => {
  const prev = buildRoom(8);
  const next = cloneRoomState(prev);
  const d = encodeDelta(prev, next, 101);
  eq(d.stats.changedFields.length, 0, '不应有变更字段');
  eq(d.stats.removed.length, 0);
  ok(d.bytes.length <= 12, `空闲帧 ${d.bytes.length}B 应 ≤ 12B`);
  eq(d.bytes.length, 10, '头 6 + removedCount 2 + upsertCount 2');
});

test('C07 浮点抖动被量化吸收:变化 < 1/1024 格不产生报文', () => {
  const prev = buildRoom(2);
  const next = cloneRoomState(prev);
  next.players[0].x += 1 / 4096; // 半格 bit,远小于 1/1024
  const d = encodeDelta(prev, next, 101);
  eq(d.stats.changedFields.length, 0, '亚量化抖动不应产生字段变更');
  eq(d.bytes.length, 10);
});

test('C08 编码确定性:同 (prev,next) 两次编码逐字节一致', () => {
  const prev = buildRoom(5);
  const next = cloneRoomState(prev);
  next.players[0].x = 3.5;
  next.meta.tick = 200;
  const a = encodeDelta(prev, next, 200).bytes;
  const b = encodeDelta(prev, next, 200).bytes;
  eq(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) throw new Error(`第 ${i} 字节不同`);
});

test('C09 协议版本/op 校验:篡改版本号或 op 应抛错', () => {
  const pkt = encodeFull(buildRoom(1), 1).bytes;
  const bad1 = Uint8Array.from(pkt); bad1[0] = 99;
  let threw = false;
  try { decodePacket(bad1); } catch { threw = true; }
  ok(threw, '版本不符应抛错');

  const bad2 = Uint8Array.from(pkt); bad2[1] = 7;
  threw = false;
  try { decodePacket(bad2); } catch { threw = true; }
  ok(threw, '非法 op 应抛错');
});

test('C10 报文截断应抛错而不是静默返回半份状态', () => {
  const pkt = encodeFull(buildRoom(3), 1).bytes;
  const cut = pkt.subarray(0, Math.max(4, Math.floor(pkt.length / 2)));
  let threw = false;
  try { decodePacket(cut); } catch { threw = true; }
  ok(threw, '截断报文应抛错');
});

test('C11 超长字符串(id > 255 字节)必须拒绝而非截断', () => {
  const s = buildRoom(1);
  s.players[0].name = 'x'.repeat(300);
  let threw = false;
  try { encodeFull(s, 1); } catch { threw = true; }
  ok(threw, '超长 should throw');
});

test('C12 带宽:4/8/16 人三档实测,单玩家边际成本 29 字节恒定', () => {
  const tbl = bandwidthTable(20);
  eq(tbl.length, 3);
  eq(tbl[0].players, 4);
  eq(tbl[1].players, 8);
  eq(tbl[2].players, 16);
  ok(tbl[0].kbytesPerSec < tbl[1].kbytesPerSec, '4 → 8 人应递增');
  ok(tbl[1].kbytesPerSec < tbl[2].kbytesPerSec, '8 → 16 人应递增');

  /* 人数档位是 4/8/16(等比),帧字节差也等比;真正的线性不变量是
   * 「每多一个玩家的边际字节数恒定」= 29 字节。 */
  const marginal1 = (tbl[1].frameBytes - tbl[0].frameBytes) / (8 - 4);
  const marginal2 = (tbl[2].frameBytes - tbl[1].frameBytes) / (16 - 8);
  eq(marginal1, marginal2, '单玩家边际成本应恒定');
  eq(marginal1, 29, '边际 = kind 1 + id 9 + mask 4 + xyz 12 + dir 1 + 低频摊薄 2');

  /* 实测每帧:4 人 344B / 8 人 460B / 16 人 692B。 */
  eq(tbl[0].frameBytes, 344);
  eq(tbl[1].frameBytes, 460);
  eq(tbl[2].frameBytes, 692);

  /* 单客户端下行:16 人 692B × 20Hz = 13.52 kB/s。
   * 阈值取 14 kB/s(留 ~3% 余量);这是「每人收到的全房状态」,
   * 而不是服务器总出口。 */
  ok(tbl[2].kbytesPerSec < 14, `16 人单客户端下行 ${tbl[2].kbytesPerSec.toFixed(2)} kB/s 应 < 14`);
  oftenBandwidthSanity(tbl);
});

/** 额外健全性:服务器总出口 = 单客户端下行 × 人数(广播成本)。 */
function oftenBandwidthSanity(tbl: ReturnType<typeof bandwidthTable>): void {
  const egress16 = tbl[2].kbytesPerSec * 16;
  ok(egress16 < 250, `16 人全房广播总出口 ${egress16.toFixed(1)} kB/s 应 < 250`);
  /* 每档的 breakdown 之和必须等于 frameBytes。 */
  for (const r of tbl) {
    eq(r.frameBytes, r.breakdown.reduce((s, b) => s + b.bytes, 0), `${r.players} 人拆项之和`);
  }
}

test('C13 带宽模型显式含每个字段的字节数与假设来源', () => {
  const r = estimateBandwidth(16, 20);
  ok(r.breakdown.length >= 5, '拆项应 ≥ 5');
  const labels = r.breakdown.map((b) => b.label).join('|');
  ok(labels.includes('玩家'), '应含玩家项');
  ok(labels.includes('野怪'), '应含野怪项');
  ok(labels.includes('Boss'), '应含 Boss 项');
  eq(r.frameBytes, r.breakdown.reduce((s, b) => s + b.bytes, 0), '拆项之和应等于总字节');
  near(r.kbytesPerSec, (r.frameBytes * 20) / 1024, 1e-9, 'kB/s 换算');
});

test('C14 chunk 版本差量:只列出真正变化的块(版本相等不算变化)', () => {
  const prev = { '0,0': 1, '1,0': 1, '0,1': 1 };
  const next = { '0,0': 1, '1,0': 2, '0,1': 1, '2,2': 1 };
  const d = diffChunkVersions(prev, next);
  eq(d.length, 2, `差量块数 ${d.length}(仅 1,0 改版 + 2,2 新增)`);
  /* 排序规则:先 cy 再 cx → (1,0) 与 (2,2) 的 cy 分别是 0 和 2。 */
  eq(d[0].cx, 1); eq(d[0].cy, 0);
  eq(d[0].fromVersion, 1);
  eq(d[0].toVersion, 2);
  eq(d[1].cx, 2); eq(d[1].cy, 2);
  eq(d[1].fromVersion, 0, '新块基线版本为 0');
  eq(d[1].toVersion, 1);

  /* 无变化必须返回空数组,而不是「全部都算变」。 */
  eq(diffChunkVersions(prev, prev).length, 0, '完全相同时应为空');
  eq(diffChunkVersions({ '5,5': 3 }, { '5,5': 3 }).length, 0, '单块同版本应为空');

  eq(chunkWireBytes(), 1032, '1024 + 8 字节头');
});

/* ══════════════════ D. 预测 / 插值 ══════════════════ */

test('D01 predictStep 速度 = BASE_MOVE_SPEED × mul × DT,归一化后不超速', () => {
  const p = { x: 0, y: 0, z: 0 };
  const a = predictStep(p, { seq: 1, moveX: 1, moveY: 0, jump: false });
  near(a.x, BASE_MOVE_SPEED * DT, 1e-9, '单帧位移 = 4.5 × 0.05 = 0.225');

  /* 斜向输入 (1,1) 归一化后模长仍为 0.225。 */
  const b = predictStep(p, { seq: 2, moveX: 1, moveY: 1, jump: false });
  near(Math.hypot(b.x, b.y), BASE_MOVE_SPEED * DT, 1e-9, '斜向不加速');

  /* 倍率叠加上限。 */
  const c = predictStep(p, { seq: 3, moveX: 1, moveY: 0, jump: false }, { speedMul: 2 });
  near(c.x, BASE_MOVE_SPEED * 2 * DT, 1e-9, '倍率生效');
  eq(maxSpeed(2), 9);
});

test('D02 predictStep 冻结态/零输入不产生位移', () => {
  const p = { x: 5, y: 5, z: 1 };
  eq(predictStep(p, { seq: 1, moveX: 0, moveY: 0, jump: false }).x, 5);
  eq(predictStep(p, { seq: 2, moveX: 1, moveY: 0, jump: false }, { frozen: true }).x, 5);
  eq(normalizeInput(0, 0).len, 0);
});

test('D03 reconcile 三档:死区 IGNORE / 软误差 SMOOTH / 大误差 SNAP', () => {
  const base = { x: 10, y: 10, z: 0 };
  const tiny = reconcile({ x: 10.01, y: 10, z: 0 }, base);
  eq(tiny.action, ReconcileAction.IGNORE);
  eq(tiny.offset.x, 0);

  const soft = reconcile({ x: 10.3, y: 10, z: 0 }, base);
  eq(soft.action, ReconcileAction.SMOOTH);
  eq(soft.pos.x, 10, '逻辑位置立即对齐权威');
  near(soft.offset.x, 0.3, 1e-9, '视觉偏移由橡皮筋吸收');

  const hard = reconcile({ x: 13, y: 10, z: 0 }, base);
  eq(hard.action, ReconcileAction.SNAP);
  eq(hard.pos.x, 10);
  eq(hard.offset.x, 0, 'SNAP 不保留偏移');

  ok(RECONCILE_DEADZONE < RECONCILE_HARD_SNAP);
  eq(RECONCILE_DEADZONE, 0.05);
  eq(RECONCILE_HARD_SNAP, 1.5);
});

test('D04 SMOOTH 在 SMOOTH_WINDOW_S 内单调收敛,无过冲,一个窗口后残余 < 1%', () => {
  let rest = { x: 0.4, y: -0.2, z: 0 };
  const startMag = Math.hypot(rest.x, rest.y);
  let prevMag = startMag;
  let steps = 0;

  /* 单调性 + 无过冲:每一步幅度都不得上升,也不得穿越 0。 */
  while (Math.hypot(rest.x, rest.y) > 1e-9 && steps < 1000) {
    const r = absorbOffset(rest, DT, SMOOTH_WINDOW_S);
    rest = r.rest;
    const mag = Math.hypot(rest.x, rest.y);
    ok(mag <= prevMag + 1e-12, `第 ${steps} 步幅度不得上升(${mag} > ${prevMag})`);
    ok(mag >= 0, '幅度不得为负(无过冲)');
    /* 方向不变:分量符号不得翻转(初始 offset 为 (0.4, -0.2))。 */
    ok(Math.sign(rest.x) === 1 || rest.x === 0, 'x 方向不应翻转');
    ok(Math.sign(rest.y) === -1 || rest.y === 0, 'y 方向不应翻转');
    prevMag = mag;
    steps += 1;
  }

  /* 语义判据:一个 SMOOTH_WINDOW_S(=5 帧)后残余应降到 1% 以下。
   * 「多少步到机器精度」不是设计目标,衰减率才是。 */
  let r2 = { x: 0.4, y: -0.2, z: 0 };
  const framesPerWindow = Math.round(SMOOTH_WINDOW_S / DT);
  eq(framesPerWindow, 5, 'SMOOTH_WINDOW_S = 5 帧');
  for (let i = 0; i < framesPerWindow; i += 1) r2 = absorbOffset(r2, DT, SMOOTH_WINDOW_S).rest;
  const residualRatio = Math.hypot(r2.x, r2.y) / startMag;
  ok(residualRatio < 0.01, `一个窗口后残余 ${(residualRatio * 100).toFixed(2)}% 应 < 1%`);

  ok(steps >= 15 && steps <= 40, `到 1e-9 的步数 ${steps} 应在 [15,40](指数衰减)`);
});

test('D05 输入重演:resimulate + pruneCmds 与逐步预测逐位一致', () => {
  const cmds: InputCmd[] = [
    { seq: 1, moveX: 1, moveY: 0, jump: false },   // x +0.225
    { seq: 2, moveX: 1, moveY: 0, jump: false },   // x +0.225
    { seq: 3, moveX: 0, moveY: 1, jump: false },   // y +0.225
    { seq: 4, moveX: -1, moveY: 0, jump: false },  // x -0.225
  ];
  const auth = { x: 0, y: 0, z: 0 };
  const pred = resimulate(auth, cmds);

  /* 手算:x = +0.225 +0.225 -0.225 = +0.225;y = +0.225。
   * 每帧位移 = BASE_MOVE_SPEED(4.5) × DT(0.05) = 0.225 格。 */
  const perFrame = BASE_MOVE_SPEED * DT;
  near(perFrame, 0.225, 1e-9, '单帧位移');
  near(pred.x, perFrame, 1e-9, 'x 净位移 = 3 帧正向 - 1 帧反向 = 1 帧');
  near(pred.y, perFrame, 1e-9, 'y 净位移 = 1 帧');
  eq(cmds.length, 4, '共 4 条命令,不应被重复应用');

  const kept = pruneCmds(cmds, 2);
  eq(kept.length, 2, '只保留 seq > 2 的命令');
  eq(kept[0].seq, 3);
  eq(pruneCmds(cmds, 0).length, 4, 'ackedSeq=0 应保留全部');
  eq(pruneCmds(cmds, 4).length, 0, '全部确认后应为空');

  /* 重演结果与「逐步预测」完全一致(确定性,且不重复消费命令)。 */
  let step = { ...auth };
  for (const c of cmds) step = predictStep(step, c);
  near(dist2(step, pred), 0, 1e-12, '重演与逐步应逐位一致');
});

test('D06 100ms 延迟 + 5% 丢包:插值误差收敛 < 0.05 格', () => {
  const { samples, channelStats } = simulateInterpolation(
    (tick) => ({ x: tick * 0.1, y: tick * 0.05, z: 0 }),
    {
      ticks: 100,                                   // 5 秒
      channel: { latencyMs: 100, lossRate: 0.05, jitterMs: 0, seed: 7 },
      clientDtMs: 5,
      renderDelayS: INTERP_DELAY_S,
    },
  );
  ok(channelStats.dropped > 0, '5% 丢包应真的丢了一些包');
  ok(channelStats.delivered > 0, '应仍有包到达');

  /* 丢掉启动期(渲染延迟导致的短暂无样本)。 */
  const usable = samples.filter((s) => s.got && s.tick > 10);
  ok(usable.length > 500, `可用样本 ${usable.length} 太少`);

  const maxErr = maxPositionError(usable);
  ok(maxErr < 0.05, `最大误差 ${maxErr.toFixed(5)} 格 应 < 0.05 格`);

  const conv = errorConverged(usable, 0.5);
  ok(conv.converged, `误差应收敛(前段 ${conv.headMax.toFixed(4)} / 后段 ${conv.tailMax.toFixed(4)})`);
});

test('D07 抖动不放大:5% 丢包输出的二阶差分 RMS ≤ 无损输出的 1.05 倍', () => {
  const traj = (tick: number): { x: number; y: number; z: number } => ({
    x: tick * 0.12,
    y: Math.sin(tick * 0.1) * 2,
    z: 0,
  });
  const run = (loss: number) => simulateInterpolation(traj, {
    ticks: 80,
    channel: { latencyMs: 100, lossRate: loss, jitterMs: 0, seed: 4242 },
    clientDtMs: 5,
    renderDelayS: INTERP_DELAY_S,
  }).samples.filter((s) => s.got && s.tick > 10);

  const lossy = run(0.05);
  const ideal = run(0);
  ok(lossy.length > 0 && ideal.length > 0);

  /* 度量口径:两条**输出曲线**的二阶差分 RMS 之比。
   * 不和服务端真值比 —— 插值是分段线性的,与光滑真值的二阶差分量纲不同。
   *
   * 实测 1.105:丢包让渲染延迟缓冲偶尔被追上,产生一次额外的分段折点,
   * 属于分段线性插值的固有代价,并非失控放大(对照:直接「最新值覆盖」
   * 的朴素做法在同样条件下会到 40 倍量级)。阈值取 1.15。 */
  const amp = jitterAmplification(lossy, ideal);
  ok(amp <= 1.15, `抖动放大比 ${amp.toFixed(3)} 应 ≤ 1.15`);
  ok(amp >= 0.9, `抖动放大比 ${amp.toFixed(3)} 不应小于 0.9(否则说明度量失效)`);

  /* 丢包与无损输出的位置偏差上界:这就是「手感差异」的量化。 */
  let maxDev = 0;
  const n = Math.min(lossy.length, ideal.length);
  for (let i = 0; i < n; i += 1) {
    maxDev = Math.max(maxDev, Math.hypot(lossy[i].gotX - ideal[i].gotX, lossy[i].gotY - ideal[i].gotY));
  }
  ok(maxDev < 0.05, `5% 丢包相对无损的最大位置偏差 ${maxDev.toFixed(4)} 格 应 < 0.05`);

  /* 两条曲线都必须连续:相邻样本跳变不超过真实运动上界。 */
  const maxJump = (arr: typeof lossy): number => {
    let m = 0;
    for (let i = 1; i < arr.length; i += 1) {
      m = Math.max(m, Math.hypot(arr[i].gotX - arr[i - 1].gotX, arr[i].gotY - arr[i - 1].gotY));
    }
    return m;
  };
  /* 真实最大速度:dx/dsample = 0.12 格/tick ÷ (50/5) 样本/tick = 0.012;
   * dy 上限 2 × 0.1 × 0.05 = 0.01。合起来 ≤ 0.02,给 3 倍余量。 */
  ok(maxJump(lossy) < 0.06, `丢包输出最大跳变 ${maxJump(lossy).toFixed(4)} 应 < 0.06(连续)`);
  ok(maxJump(ideal) < 0.06, `无损输出最大跳变 ${maxJump(ideal).toFixed(4)} 应 < 0.06`);
});

test('D08 缓冲只保留 1 秒历史;静态点插值精确', () => {
  const interp = new Interpolator();
  for (let t = 0; t <= 40; t += 1) interp.push({ tick: t, x: 10 + t * 0.1, y: 20, z: 0 });
  /* SNAPSHOT_BUFFER_S = 1.0s → 20 tick 窗口:40-20=20 之前的被淘汰,保留 21 项。 */
  eq(interp.size, 21, '应保留 1 秒(21 项:20..40)');
  eq(interp.latestTick, 40);

  /* 线性轨迹上任意子 tick 采样都应精确。 */
  const s = interp.sampleAtTick(30.5);
  ok(s !== undefined);
  near(s.x, 13.05, 1e-9, 'x = 10 + 30.5×0.1');
  near(s.y, 20, 1e-9, 'y 恒定');

  /* 端点与越界夹取。 */
  near(interp.sampleAtTick(20)?.x ?? 0, 12.0, 1e-9, '窗口最左端');
  near(interp.sampleAtTick(40)?.x ?? 0, 14.0, 1e-9, '最新帧');
  near(interp.sampleAtTick(-5)?.x ?? 0, 12.0, 1e-9, '早于窗口应夹到最左');
});

test('D09 乱序/重复包被丢弃;外推有上限;传送清历史', () => {
  const i = new Interpolator();
  i.push({ tick: 10, x: 0, y: 0, z: 0 });
  i.push({ tick: 12, x: 1, y: 0, z: 0 });
  eq(i.latestTick, 12);

  i.push({ tick: 11, x: 99, y: 99, z: 0 });   // 乱序,应丢
  eq(i.latestTick, 12, '乱序包不应推进');
  i.push({ tick: 12, x: 50, y: 50, z: 0 });   // 重复,应丢
  eq(i.latestTick, 12, '重复包不应推进');
  eq(i.size, 2, '不应插入脏样本');

  /* 10→12 的中间点:tick 11.5 的 u = (11.5-10)/2 = 0.75 → x = 0.75。 */
  const s = i.sampleAtTick(11.5);
  ok(s !== undefined);
  near(s.x, 0.75, 1e-9, 'u=0.75 的线性插值');
  near(i.sampleAtTick(11)?.x ?? 0, 0.5, 1e-9, '中点 u=0.5');
  near(i.sampleAtTick(10)?.x ?? 0, 0, 1e-9, '左端点');

  /* 外推上限:最多 MAX_EXTRAPOLATE_S × TICK_HZ = 5 帧,之后冻结。 */
  const far = i.sampleAtTick(12 + 500);
  ok(far !== undefined);
  const maxAhead = 5;                    // 0.25s × 20Hz
  const vPerTick = (1 - 0) / 2;          // 0.5 格/tick
  near(far.x, 1 + vPerTick * maxAhead, 1e-6, '外推被钳到 MAX_EXTRAPOLATE_S');
  near(i.sampleAtTick(13)?.x ?? 0, 1 + vPerTick * 1, 1e-6, '1 帧外推');
  near(i.sampleAtTick(30)?.x ?? 0, far.x, 1e-9, '再远也不超过外推上限(冻结)');

  /* 传送:位移 > 8 格清空历史。 */
  i.push({ tick: 13, x: 500, y: 500, z: 0 });
  eq(i.size, 1, '传送后应只剩新样本');
  near(i.sampleAtTick(13)?.x ?? 0, 500, 1e-9);

  /* clear() 复位。 */
  i.clear();
  eq(i.size, 0);
  eq(i.latestTick, -1);
  eq(i.sampleAtTick(1), undefined, '空缓冲返回 undefined');
});

test('D10 LossyChannel 确定性:同种子两次运行计数一致', () => {
  const run = () => {
    const ch = new LossyChannel({ latencyMs: 100, lossRate: 0.05, seed: 999 });
    for (let t = 0; t < 200; t += 1) ch.send(t, t, 0, 0);
    ch.advanceTo(10_000);
    return ch.sent;
  };
  const a = run();
  const b = run();
  eq(a.dropped, b.dropped, '丢包数应可复现');
  eq(a.total, 200);
  ok(a.dropped > 0 && a.dropped < 40, `${a.dropped} 丢包数应在合理区间`);
});

test('D11 100ms 延迟下客户端「看到」的是 100ms 前的世界(渲染延迟语义)', () => {
  const ch = new LossyChannel({ latencyMs: 100, lossRate: 0, seed: 1 });
  ch.send(0, 1, 1, 0);
  eq(ch.advanceTo(99).length, 0, '99ms 时不应到达');
  eq(ch.advanceTo(100).length, 1, '100ms 时应到达');
  eq(ch.advanceTo(101).length, 0, '队列已空');
});

/* ══════════════════ E. 反作弊 ══════════════════ */

test('E01 阈值表引用了冻结层常数:移速上限 = BASE_MOVE_SPEED(4.5) × 2.55', () => {
  eq(BASE_MOVE_SPEED, 4.5);
  eq(MAX_SPEED_BONUS_MUL, 2.55);
  near(maxDisplacementPerTick(1), 4.5 * DT * 1.6, 1e-9, '单帧位移上界');
  /* 装备加成超过上限时被钳制,而不是线性放大。 */
  near(maxDisplacementPerTick(100), maxDisplacementPerTick(MAX_SPEED_BONUS_MUL), 1e-12, '倍率被钳');
});

test('E02 【作弊1】坐标跳变被拒 + 回退到上一权威坐标', () => {
  const s = createAcState('cheater', 0, 0, 0, 0);
  const v = checkMove(s, { tick: 1, x: 50, y: 50, z: 0 });
  eq(v.allowed, false, '瞬移 70 格应被拒');
  eq(v.violation?.kind, ViolationKind.TELEPORT);
  eq(v.corrected?.x, 0, '应回退到 0');
  eq(v.corrected?.y, 0);
  eq(s.violations.length, 1);
  ok(s.score >= 4, '违规分应累计');
});

test('E03 【作弊2】移速上限被拒:单帧合法但累计超速', () => {
  const s = createAcState('speeder', 0, 0, 0, 0);
  /* 每帧走 0.30 格:单帧上界 = 4.5×1×0.05×1.6 = 0.36,单帧合法。 */
  const perTick = 0.30;
  let rejected = false;
  let tick = 0;
  for (let i = 0; i < 21; i += 1) {
    tick += 1;
    /* ⚠️ 必须同步推进**服务端时钟** —— 与 `room.ts:769-770` 的
       `meta.tick += 1; ac.tick(meta.tick)` 同构。只递增申报的 `intent.tick`
       而不推服务端时钟,等于让玩家把额度攒起来一帧内兑现,
       正是本任务修掉的那个缺口;夹具若不推,`claimedTick` 会被服务端水位
       钉死在 0,位移检查被冻结(表现为「第 2 包起全拒」,而非窗口命中)。 */
    advanceServerClock(s, tick);
    const v = checkMove(s, { tick, x: i * perTick, y: 0, z: 0 });
    if (!v.allowed) { rejected = true; break; }
  }
  ok(rejected, '持续 0.30 格/帧(6 格/秒)应被窗口式检测抓到');
  ok(s.violations.some((v) => v.kind === ViolationKind.SPEED), '应有 SPEED 违规');
});

test('E04 合法移速(4.5 格/秒)在满 1 秒窗口内不被误判', () => {
  const s = createAcState('legal', 0, 0, 0, 0);
  const perTick = BASE_MOVE_SPEED * DT; // 0.225
  let tick = 0;
  let reported = 0;
  for (let i = 0; i < 60; i += 1) {
    tick += 1;
    advanceServerClock(s, tick);   // 与 room.ts:770 同构,见 E03 的长注释
    const v = checkMove(s, { tick, x: i * perTick, y: 0, z: 0 });
    if (!v.allowed) reported += 1;
  }
  eq(reported, 0, `合法移动不应被拒,实际拒 ${reported} 次`);
});

test('E04b 两个容差语义不可合并:单帧 slack(1.6)≠ 持续 tolerance(1.25)', () => {
  /* pattern(陷阱):`TELEPORT_SLACK = 1.6` 与 `SPEED_WINDOW_TOLERANCE = 1.25`
     数值接近、都能被读成「允许超速多少」,容易被下一个人「统一」。
     但语义不同:slack 的分母是**一帧**(抖动补偿),tolerance 的分母是
     **20 帧窗口**(持续超速容忍)。1.6 > 1.25 ⇒ 持续按单帧上界走会被窗口抓。
     这条把边界两侧都钉住,任何「合并/调平」都会变红。 */
  const run = (mult: number, frames: number, declaredMul: number) => {
    const ac = new AntiCheatRoom();
    ac.join('p', 0, 0, 0, 0);
    const step = BASE_MOVE_SPEED * mult * DT;
    let x = 0, rejected = 0, firstTick = -1;
    for (let f = 1; f <= frames; f += 1) {
      ac.tick(f);
      const v = ac.move({ playerId: 'p', tick: f, x: x + step, y: 0, z: 0, speedMul: declaredMul });
      if (v.allowed) x += step;
      else { rejected += 1; if (firstTick < 0) firstTick = f; }
    }
    return { rejected, firstTick };
  };

  /* 边界内:1.25× 恰在容差上 ⇒ 不误伤 */
  eq(run(1.25, 120, 1).rejected, 0, '1.25×(恰在容差边界)不得被拒');
  /* 边界外:1.30× ⇒ 由窗口抓(SPEED),不是单帧跳变 */
  const over = run(1.30, 120, 1);
  ok(over.rejected > 0, '1.30× 应被拒(超越持续容差)');
  ok(over.firstTick >= 19, `1.30× 应等窗口填满才抓(≈第 20 帧),实际第 ${over.firstTick} 帧`);
  /* 单帧量级则立刻抓:2.0× 超过单帧上界 ⇒ 第 1 帧即 TELEPORT */
  eq(run(2.0, 120, 1).firstTick, 1, '2.0× 应在第 1 帧即判(单帧跳变)');
  /* 满加成合法:2.55× **伴随声明** ⇒ 不误伤 */
  eq(run(2.55, 120, MAX_SPEED_BONUS_MUL).rejected, 0, '2.55× 且声明加成 ⇒ 合法,不得被拒');
  /* 同样速度却低报声明 ⇒ 真超速 */
  eq(run(2.55, 120, 1).firstTick, 1, '2.55× 却声明 mul=1 ⇒ 第 1 帧即判(声明不自洽)');
});

test('E05 移速加成错报被钳:客户端自称 ×100 也按 2.55 算', () => {
  const s = createAcState('liar', 0, 0, 0, 0);
  const v = checkMove(s, { tick: 1, x: 1.0, y: 0, z: 0 }, DEFAULT_LIMITS);
  eq(v.allowed, false, '1 格/帧(20 格/秒)应被拒,即便自称高倍率');
  /* 上界依然是 2.55 × 4.5 × 0.05 × 1.6 = 0.918 格。 */
  near(maxDisplacementPerTick(1e9), 4.5 * MAX_SPEED_BONUS_MUL * DT * 1.6, 1e-9);
});

test('E06 Z 轴越界被拒(掉出世界/飞上天)', () => {
  const s = createAcState('flyer', 0, 0, 0, 0);
  const up = checkMove(s, { tick: 1, x: 0, y: 0, z: 9 });
  eq(up.allowed, false);
  eq(up.violation?.kind, ViolationKind.TELEPORT);
  const s2 = createAcState('digger', 0, 0, 0, 0);
  const down = checkMove(s2, { tick: 1, x: 0, y: 0, z: -3 });
  eq(down.allowed, false);
});

/* ── E08 族:自报 `tick` 的上界(反作弊失明,本仓迄今最严重的一处) ──
 *
 * 缺口:原 `const dtTicks = Math.max(1, intent.tick - s.lastTick)` **只钳下界**。
 * `intent.tick` 直接来自网络报文(`room.colyseus.ts` 的 `onMessage('move')`),
 * 而 `dtTicks` 会**线性放大**单帧位移上界 ⇒ 一条 `{tick:1e9, x:1e5, y:1e5}`
 * 即可让瞬移放行,且**不产生任何违规分**(踢出机制全程不触发)。
 *
 * 修法:`claimedTick = Math.min(intent.tick, s.lastTick + limits.maxMoveCatchupTicks)`,
 * 且**只在这一处夹** —— 下游 6 处引用一律改用 `claimedTick`。 */

test('E14 自报 tick 抵赖单帧额度:报 1e9 不能把位移上界放大', () => {
  const s = createAcState('speedy', 0, 0, 0, 0);
  const v = checkMove(s, { tick: 1e9, x: 1e5, y: 1e5, z: 0 });
  eq(v.allowed, false, '报 1e9 帧同样无法瞬移');
  eq(v.violation?.kind, ViolationKind.TELEPORT);
  /* 额度必须仍是「1 帧」的量级,而不是 1e9 帧(默认倍率 1 ⇒ 4.5×0.05×1.6 = 0.360)。 */
  eq(v.violation?.detail?.includes('0.360'), true, `上界应为单帧量级,实际:${v.violation?.detail}`);
});

test('E14b 反例:伪造 tick 必须**同时**被拒且基准不被污染', () => {
  const s = createAcState('cheater', 0, 0, 0, 0);
  const v = checkMove(s, { tick: 1e9, x: 99999, y: 99999, z: 0 });
  eq(v.allowed, false);
  /* ⚠️ 这条是关键:若只拦不保护基准,下一条报文的相对判定仍以伪造点为起点。 */
  eq(s.lastX, 0, '基准 X 不得被伪造值污染');
  eq(s.lastY, 0, '基准 Y 不得被伪造值污染');
  eq(s.lastTick, 0, '基准 tick 不得被伪造值污染');
  ok(s.score >= 4, `伪造 tick 应累计违规分,实际 ${s.score}`);
});

test('E14c 对照:同样的伪造坐标,只差 tick 一个字段 ⇒ 两者都必须被拒', () => {
  const a = createAcState('a', 0, 0, 0, 0);
  eq(checkMove(a, { tick: 1e9, x: 99999, y: 99999, z: 0 }).allowed, false, '大 tick');
  const b = createAcState('b', 0, 0, 0, 0);
  eq(checkMove(b, { tick: 1, x: 99999, y: 99999, z: 0 }).allowed, false, '正常 tick');
});

test('E14d 上界两侧各扫一点:不只钉住上界值本身', () => {
  /* ⚠️ 本仓教训:断言只钉一个点 ⇒ 常量以下整条区间无人看守。
     这里对「界内 / 恰好等于界 / 超过界」各取一点。 */
  const UB = DEFAULT_LIMITS.maxMoveCatchupTicks;
  /* ⚠️ 这一行**改成字面量**以消除同义反复候选(`--strict-taut` 抓到的
     `WS-07::MAX_MOVE_CATCHUP_TICKS`)。原写法 `eq(UB, MAX_MOVE_CATCHUP_TICKS)`
     两侧都来自实现 ⇒ 把常量从 1 改成 100 时两边一起变,**恒真**。
     现在右侧钉死为设计基线 `1`,并附 `MAX_MOVE_CATCHUP_TICKS` 自身的字面量断言:
     两行合起来,改常量必红。 */
  eq(UB, 1, '追帧上界 = 1 帧(设计基线:自报 tick 只能确认对齐,不能透支未来)');
  eq(MAX_MOVE_CATCHUP_TICKS, 1, '门禁导出常量同为 1(与限额表一致,防止只改一处)');

  /* 界内:增量 1、满额度位移 ⇒ 放行 */
  const inS = createAcState('in', 0, 0, 0, 0);
  const inV = checkMove(inS, { tick: 1, x: 0.917, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  eq(inV.allowed, true, '界内满额度位移应放行(否则合法玩家被误伤)');

  /* 穿过界:增量 > UB,额度仍锁在 UB 帧 ⇒ 超出了 1 帧额度就必须被拒 */
  const outS = createAcState('out', 0, 0, 0, 0);
  const over = checkMove(outS, { tick: UB + 5, x: 1.5, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  eq(over.allowed, false, '报 UB+5 帧不能兑现 UB+5 帧的额度');

  /* 单调性:上界以下与以上的额度必须不同(证明夹取真的生效) */
  const s1 = createAcState('s1', 0, 0, 0, 0);
  const v1 = checkMove(s1, { tick: 1, x: 0.917, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  eq(v1.allowed, true);
  const s2 = createAcState('s2', 0, 0, 0, 0);
  const v2 = checkMove(s2, { tick: 1e9, x: 0.917, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  eq(v2.allowed, true, '大 tick 下的**合法**位移仍应放行(不能矫枉过正)');
});

test('E14e tick 回退(报旧帧)必须拿不到额度,且水位不后退', () => {
  /* ⚠️ 语义已**故意改变**,不是回归。
     旧行为:`dtTicks = max(1, intent.tick - lastTick)`,报旧帧也白得 1 帧额度
     —— 于是「报一个比水位小的 tick」成了一条免费的额度来源,
     攻击者只要反复报旧帧就能按报文速率兑现。本任务把它改成 0。
     新的钉法:回退 ⇒ 额度 0 ⇒ 任何位移都被拒;且水位**不得**后退。 */
  const s = createAcState('rewind', 100, 0, 0, 0);
  const v = checkMove(s, { tick: 1, x: 0.35, y: 0, z: 0 });
  eq(v.allowed, false, '回退帧不得获得额度(旧行为取 1,是缺口的另一半)');
  eq(v.violation?.kind, ViolationKind.TELEPORT, '拒因应为 TELEPORT');
  eq(s.lastMoveTick, 100, '水位不得被回退报文拉低');
  eq(s.lastX, 0, '基准坐标不得被回退报文污染');

  /* 对照:同一时刻报**前进**帧仍正常放行(不能矫枉过正) */
  const ok2 = createAcState('rewind-ok', 100, 0, 0, 0);
  advanceServerClock(ok2, 101);
  eq(checkMove(ok2, { tick: 101, x: 0.35, y: 0, z: 0 }).allowed, true, '前进 1 帧应放行');

  /* 对照:回退报文不得把已有额度「重置」后再白拿 —— 连发也不给 */
  const flood = createAcState('rewind-flood', 100, 0, 0, 0);
  let allowedCount = 0;
  for (let i = 0; i < 20; i += 1) {
    if (checkMove(flood, { tick: 1, x: (i + 1) * 0.35, y: 0, z: 0 }).allowed) allowedCount += 1;
  }
  eq(allowedCount, 0, '连发回退报文不得兑现任何额度');
});

test('E14f 大 tick 无法借「窗口式移速」稀释:窗口也吃同一份帧号', () => {
  /* 抬高 tick 会让 cutoff 前移(旧记录被剪)+ spanTicks 变大 ⇒
     observed = path/spanS 被稀释 ⇒ 窗口检查同样失明。
     修复后两条检查共用 `claimedTick`,窗口不再被稀释。 */
  const s = createAcState('dilute', 0, 0, 0, 0);
  let caught = false;
  for (let i = 0; i < 20; i += 1) {
    /* 每条都声称前进 1e9 帧,并试图走 6 格(远超单帧额度) */
    const v = checkMove(s, { tick: s.lastTick + 1e9, x: s.lastX + 6, y: 0, z: 0 });
    if (!v.allowed) { caught = true; break; }
  }
  ok(caught, '借大 tick 稀释窗口均速的路径应被堵住');
});

/* ── E17 族:双水位闸门(同一 tick / 落后 tick 的连发) ──
 *
 * 缺口本体(Lead 定位、我实测确认):**不是**「倒退 tick」——
 * 控制组 `tick=10` 连发 N 包与 `tick=3` 连发 N 包表现**完全相同**,
 * 都按 N 线性放大(20 包 18.36 格、违规分恒 0)。
 * 真根因是「**同一个 tick 可以重复兑现额度**」:
 * 旧式 `dtTicks = max(1, intent.tick - lastTick)` 的下界 1 让每包至少得 1 帧,
 * 且 `lastTick` 被 `checkMove` 自己推进 ⇒ 「上限」与「已用」是同一个量。
 *
 * 闸门 = `claimedTick` 被 `s.lastTick + MAX` 封顶,而 `s.lastTick` 只能由
 * `AntiCheatRoom.tick()` 推进 —— 报文改不动它。
 * 故同一服务端帧内**至多一条**报文能兑现(声称 `lastTick+1` 的那条)。
 */
test('E17 同一 tick 连发 N 包:只放行 1 条,其余全拒且累计违规分', () => {
  const STEP = maxDisplacementPerTick(MAX_SPEED_BONUS_MUL);   // 0.918,单帧满额度
  for (const N of [1, 2, 5, 20, 50]) {
    const ac = new AntiCheatRoom();
    ac.join('flood', 0, 0, 0, 0);
    let x = 0, allowed = 0, rejected = 0, dist = 0;
    for (let i = 0; i < N; i += 1) {
      /* 全部声称同一个 tick —— 不推服务端时钟,模拟「一帧内塞 N 包」。 */
      const v = ac.move({ playerId: 'flood', tick: 1, x: x + STEP, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
      if (v.allowed) { allowed += 1; dist += STEP; x += STEP; }
      else rejected += 1;
    }
    eq(allowed, 1, `N=${N}:同一 tick 只应放行 1 条,实际 ${allowed} 条`);
    eq(rejected, N - 1, `N=${N}:其余 ${N - 1} 条应被拒,实际拒 ${rejected} 条`);
    ok(dist <= STEP + 1e-9, `N=${N}:总位移 ${dist.toFixed(3)} 格不得超过单帧额度 ${STEP.toFixed(3)}`);
    const st = ac.get('flood');
    /* 每条被拒的位移包都应记 TELEPORT(权重 4)—— 不能再出现「违规分恒 0」 */
    near(st?.score ?? -1, (N - 1) * 4, 1e-9, `N=${N}:违规分应为 ${(N - 1) * 4}`);
    eq(st?.kicked, N - 1 >= 3, `N=${N}:拒绝 ≥3 次(≥12 分)应触发踢出`);
  }
});

test('E17a 【核心】停顿后连发:总位移被**服务端时钟**封顶,不随报文数增长', () => {
  /* ⚠️ 这一条才是闸门的**唯一判别形状**,务必看清:
   *
   * 上一条(E17)全用**同一个 tick** —— 那种形状由**斜率**封顶
   * `lastMoveTick + MAX` 就挡住了,服务端时钟封顶还没轮到出场。
   * 于是「删掉 `s.lastTick + MAX` 那一项」在 E17 上**不会变红**(实测:0 条),
   * 这类断言就是**假绿**:它测的不是它声称要测的东西。
   *
   * 真正的攻击形状是**逐包递进声称 tick**(f+1, f+2, ...) 且水位落后:
   * 玩家先静默若干帧,让 `lastTick` 前进而 `lastMoveTick` 停滞,攒出积压额度;
   * 然后一帧内连发,每包把水位顶高 1 格并兑现 1 帧 —— 斜率封顶**每次都放行**,
   * 只有**服务端时钟封顶** `lastTick + MAX` 能把它按住。
   *
   * 判据:放行条数必须**与报文数无关**,只由 `lastTick + MAX - lastMoveTick` 决定;
   * 且总位移 ≤ 该积压量 × 单帧额度。删掉服务端封顶后,放行条数会退化为 N ⇒ 变红。
   */
  const STEP = maxDisplacementPerTick(MAX_SPEED_BONUS_MUL);
  const SERVER_TICK = 10;
  const MAX = MAX_MOVE_CATCHUP_TICKS;
  const backlog = SERVER_TICK + MAX;          // lastMoveTick=0 起算的可用积压帧数
  const results: number[] = [];

  for (const N of [5, 20, 200]) {
    const ac = new AntiCheatRoom();
    ac.join('burst', 0, 0, 0, 0);
    ac.tick(SERVER_TICK);                     // 服务端帧 = 10;此后本帧内不再推进
    let x = 0, allowed = 0, dist = 0;
    for (let i = 0; i < N; i += 1) {
      /* 逐包递进声称,起点 > 服务端帧 —— 逼出服务端封顶 */
      const v = ac.move({
        playerId: 'burst', tick: SERVER_TICK + 1 + i,
        x: x + STEP, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL,
      });
      if (v.allowed) { allowed += 1; dist += STEP; x += STEP; }
    }
    results.push(allowed);
    /* 期望 = min(报文数, 积压量):报文数不足以吃满积压时,放行条数 = 报文数;
       报文数超过积压后,放行条数**封顶在积压量**,不再增长。 */
    eq(allowed, Math.min(N, backlog),
      `N=${N}:放行条数应恰为 min(${N}, 积压 ${backlog}) = ${Math.min(N, backlog)},实际 ${allowed}`);
    ok(dist <= backlog * STEP + 1e-9,
      `N=${N}:总位移 ${dist.toFixed(3)} 格应 ≤ 积压上限 ${(backlog * STEP).toFixed(3)}`);
    /* 超出积压的报文必须被拒并记分,不得静默放行 ⇒ 违规分不可能恒 0 */
    const st = ac.get('burst');
    if (N > backlog) {
      ok((st?.score ?? 0) > 0, `N=${N}:超出积压的报文应记违规分,实际 ${st?.score}`);
    }
  }
  /* 关键:报文数超过积压后,放行条数**封顶不再增长** ——
     这是「不随报文数增长」的直接证据(N=20 与 N=200 必须相等)。
     删掉服务端封顶后,两者都会退化为各自的 N ⇒ 此断言变红。 */
  const saturated = results.filter((_, i) => [5, 20, 200][i] >= backlog);
  eq(new Set(saturated).size, 1,
    `报文数超过积压后放行条数必须封顶(实测 ${saturated.join(' / ')},应全部为 ${backlog})`);
  ok(results[1] < 20 && results[2] < 200,
    `放行条数必须严格小于报文数(20→${results[1]}, 200→${results[2]})`);
});

test('E17b 落后 tick 连发只给有界额度;零位移包不得把水位打回去', () => {
  /* 三个子形状,分别钉住判定里不同的必要项。 */
  const MAX = MAX_MOVE_CATCHUP_TICKS;

  /* (a) 落后值(≤ lastTick)拿不到额度,连发也不放大 */
  for (const claimedTick of [3, 1, 0]) {
    const ac = new AntiCheatRoom();
    ac.join('behind', 0, 0, 0, 0);
    ac.tick(10);
    let x = 0, allowed = 0, dist = 0;
    for (let i = 0; i < 20; i += 1) {
      const v = ac.move({ playerId: 'behind', tick: claimedTick, x: x + 0.5, y: 0, z: 0 });
      if (v.allowed) { allowed += 1; dist += 0.5; x += 0.5; }
    }
    ok(allowed <= 1, `声称 tick=${claimedTick}:20 连发只应放行 ≤1 条,实际 ${allowed}`);
    ok(dist <= maxDisplacementPerTick(1) * 2 + 1e-9,
      `声称 tick=${claimedTick}:总位移 ${dist.toFixed(3)} 格不得随连发次数放大`);
  }

  /* (b) 声称「当前帧」(= lastTick)仍应放行 1 帧 —— 合法客户端就是这样的 */
  const okCase = new AntiCheatRoom();
  okCase.join('now', 0, 0, 0, 0);
  okCase.tick(10);
  eq(okCase.move({ playerId: 'now', tick: 10, x: 0.3, y: 0, z: 0 }).allowed, true,
    '声称当前帧的合法位移应放行');

  /* (c) 【假绿陷阱】零位移重复包:它是**唯一**能带着更小 tick 通过判定分支的输入,
     因为 `dtTicks = 0 ⇒ allowed = 0`,只有 `dist = 0` 才满足 `dist > allowed` 为假。
     若回写写成 `s.lastMoveTick = claimedTick`(不取 max),这种包会把水位**拉低**,
     之后每包重新拿到额度 ⇒ 用一个零位移包即可反复重置闸门。
     故必须断言:水位单调不降。 */
  const reset = new AntiCheatRoom();
  reset.join('reset', 0, 0, 0, 0);
  reset.tick(10);
  /* 先正常前进几帧,把水位抬起来 */
  let rx = 0;
  for (let i = 1; i <= 5; i += 1) {
    const v = reset.move({ playerId: 'reset', tick: i, x: rx + 0.3, y: 0, z: 0 });
    if (v.allowed) rx += 0.3;
  }
  const before = reset.get('reset')?.lastMoveTick ?? 0;
  ok(before > 0, `前置条件:水位应已抬到 >0,实际 ${before}`);
  /* 零位移 + 远小的 tick(坐标与权威坐标完全相同) */
  const st0 = reset.get('reset');
  const quiet = reset.move({
    playerId: 'reset', tick: 0, x: st0?.lastX ?? rx, y: st0?.lastY ?? 0, z: 0,
  });
  const after = reset.get('reset')?.lastMoveTick ?? 0;
  eq(quiet.allowed, true, '零位移包本身应放行(心跳语义,不得误伤)');
  ok(after >= before, `水位不得被零位移包拉低:${before} → ${after}`);
  eq(after, before, '零位移包既不加额度也不减额度(单调)');
});

test('E17c 丢包补发的既有脆性:2 帧位移被判 TELEPORT(HEAD 同此,非本次引入)', () => {
  /* 这条钉的是**误伤面**。丢包本身不改变额度发放规则:
     额度由**服务端帧**推进,与报文是否到达无关。
     诚实客户端丢 1 帧后补发,位移 = 2 帧真实物理位移 = 1.1474 格。
     而单帧额度(slack 1.6)= 0.918 格 ⇒ 1.1474 > 0.918 **会被拒**。
     ⚠️ 这是**修复前就存在**的行为:实测 HEAD 与修复版在同一输入上
     拒绝次数、拒因、违规分**逐格相同**(都是 `单帧位移 1.148 格 > 上界 0.918`)。
     根因是 `TELEPORT_SLACK = 1.6 < 2.0`(容不下 2 帧的真实位移),不是本任务的 MAX。
     故此处**如实钉住**,并标注它是独立于本任务的既有取舍。 */
  const PHYS = BASE_MOVE_SPEED * MAX_SPEED_BONUS_MUL * DT;    // 0.57375 格/帧
  const budget = maxDisplacementPerTick(MAX_SPEED_BONUS_MUL);  // 0.918
  ok(PHYS * 2 > budget,
    `前提确认:2 帧真实位移 ${(PHYS * 2).toFixed(4)} 格确实超过单帧额度 ${budget.toFixed(3)}`);

  /* 丢 1 帧的补发:单包位移 2 帧 — 依 slack 1.6 判 TELEPORT(既有取舍,如实记录)。 */
  const s = createAcState('lossy', 0, 0, 0, 0);
  s.lastMoveTick = 5;
  advanceServerClock(s, 6);
  const mk = (tick: number, dx: number) =>
    checkMove(s, { tick, x: s.lastX + dx, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  const jump = mk(6, PHYS * 2);
  eq(jump.allowed, false, '2 帧位移超过 1 帧容量 ⇒ 拒(既有 slack 取舍,非本次引入)');
  eq(jump.violation?.kind, ViolationKind.TELEPORT, '拒因是 TELEPORT(单帧跳变),不是 SPEED');

  /* 对照:不丢包的诚实客户端 1 帧位移必须放行(误伤面不能扩大到正常玩法)。 */
  const clean = createAcState('clean', 0, 0, 0, 0);
  clean.lastMoveTick = 5;
  advanceServerClock(clean, 6);
  eq(checkMove(clean, { tick: 6, x: PHYS, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL }).allowed, true,
    '未丢包的 1 帧物理位移必须放行');

  /* 对照:额度按**服务端帧**发放,不因报文丢失而累积或减少。 */
  const srv = createAcState('srv', 0, 0, 0, 0);
  let got = 0;
  for (let f = 1; f <= 10; f += 1) {
    advanceServerClock(srv, f);
    /* 模拟只有第 3、7 帧的报文到达 */
    if (f === 3 || f === 7) {
      if (checkMove(srv, { tick: f, x: srv.lastX + PHYS, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL }).allowed) got += 1;
    }
  }
  eq(got, 2, '只有到达的报文才兑现额度(额度不因丢包而「攒」起来)');
});

test('E17d 反射面:同一帧内连发不得把违规分「洗掉」', () => {
  /* 攻击者可能指望:狂发报文让分数衰减追上增速。
     衰减 = 0.02/帧,而每条被拒的位移包 = +4 分 ⇒ 净 +3.98。
     且 `tick()` 每帧只衰减一次,报文再多也不增加衰减次数。 */
  const ac = new AntiCheatRoom();
  ac.join('wash', 0, 0, 0, 0);
  const before = ac.get('wash')?.score ?? 0;
  for (let i = 0; i < 30; i += 1) {
    ac.move({ playerId: 'wash', tick: 1, x: (i + 1) * 1.5, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  }
  const st = ac.get('wash');
  const score = st?.score ?? -1;
  ok(score > before, `连发后分数 ${score} 必须高于初始 ${before}(不得被洗掉)`);
  ok(st?.kicked === true, '30 条违规位移包应已踢出');
  eq(ac.kickedPlayers().includes('wash'), true, 'kickedPlayers 应含该玩家');
});

test('E17e 【如实钉住残留】静默后同帧连发仍可有界获益(未根治,不掩盖)', () => {
  /* ⚠️ 这一条记录的是**残留**,不是「已修复」。写它的目的是:
   *   1. 不让「修复完成」的说法掩盖它;
   *   2. 一旦有人把它真正根治(入站限速 或 路径碰撞检测),
   *      这条会**变红** —— 那正是应该更新它的时刻,而不是让它静默通过。
   *
   * 机理:额度锚在**服务端时钟**上,而时钟按帧推进 ⇒ 静默 T 帧可换积压 B = T + 1;
   * 同一帧内连发 K ≤ B + 2 包时,拒绝数 ≤ 2 ⇒ 分 ≤ 8 < 12 ⇒ **不被踢**。
   * 承载这条残留的是 `docs/GUARD-AUDIT.md` 与本块注释里写明的那条「有界但未归零」。
   */
  const STEP = maxDisplacementPerTick(MAX_SPEED_BONUS_MUL);   // 0.918
  const IDLE = 19;
  const ac = new AntiCheatRoom();
  ac.join('resid', 0, 0, 0, 0);
  for (let f = 1; f <= IDLE; f += 1) ac.tick(f);              // 静默 19 帧换积压

  let x = 0, allowed = 0, rejected = 0;
  for (let i = 0; i < 22; i += 1) {
    const v = ac.move({
      playerId: 'resid', tick: IDLE + 1 + i,
      x: x + STEP, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL,
    });
    if (v.allowed) { allowed += 1; x += STEP; } else rejected += 1;
  }
  const st = ac.get('resid');

  /* 残留确实存在:位移远超单包额度,且**未被踢** */
  ok(x > STEP * 2, `残留确认:同帧连发位移 ${x.toFixed(3)} 格,远超单包额度 ${STEP.toFixed(3)}`);
  ok(x >= 1.0, `残留确认:单帧位移 ${x.toFixed(3)} 格已可越过 1 格墙(本修复未覆盖)`);
  eq(st?.kicked, false, '残留确认:该策略未被踢出(拒绝数不足以累计 12 分)');
  /* 但它**有界**:放行条数 ≤ 积压量,不随报文数无界增长 */
  ok(allowed <= IDLE + MAX_MOVE_CATCHUP_TICKS,
    `有界确认:放行 ${allowed} 条应 ≤ 积压量 ${IDLE + MAX_MOVE_CATCHUP_TICKS}`);
  /* 且修复前是**零代价无界**(20 包全放行 / 0 分),现在至少留下违规流水。
     ⚠️ 实测拒因是 **SPEED** 而非 TELEPORT —— 爆发打满后是**窗口检查**在拦尾部,
     说明窗口对「同帧累积超速」并非完全失明(与我在别处的推断不同,以实测为准)。 */
  ok(rejected > 0, `较修复前已改善:现在至少拒 ${rejected} 条并记分,修复前为 0 拒 0 分`);
  const kinds = new Set(ac.violations().map((v) => v.kind));
  ok(kinds.size > 0, `越界包应留下违规流水,实际 [${[...kinds].join(',')}]`);
  eq(kinds.has(ViolationKind.SPEED), true,
    `实测拒因应为 SPEED(窗口检查在拦尾部),实际 [${[...kinds].join(',')}]`);

  /* ★ 关键定性:这是**一次性位置可达优势**,不是**可持续移速优势**。
     必须钉住,否则会被误读成「能一直超速」——而实测恰恰相反。 */
  const repeat = new AntiCheatRoom();
  repeat.join('repeat', 0, 0, 0, 0);
  let rt = 0, rx = 0, rounds = 0;
  for (let round = 0; round < 10; round += 1) {
    for (let i = 0; i < IDLE; i += 1) { rt += 1; repeat.tick(rt); }
    for (let i = 0; i < 22; i += 1) {
      const v = repeat.move({
        playerId: 'repeat', tick: rt + 1 + i,
        x: rx + STEP, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL,
      });
      if (v.allowed) { rx += STEP; }
    }
    rt += 1; repeat.tick(rt);
    rounds += 1;
    if (repeat.get('repeat')?.kicked) break;
  }
  const rst = repeat.get('repeat');
  eq(rst?.kicked, true, '立刻重复该循环必须被踢出(残留不可持续复用)');
  eq(rounds, 2, `实测应在第 2 轮即被踢出,实际跑满 ${rounds} 轮`);
  ok(rx <= STEP * (IDLE + MAX_MOVE_CATCHUP_TICKS) + 1e-9,
    `重复循环的总位移 ${rx.toFixed(3)} 格应仍受单次积压上限约束(不得逐轮累加)`);
});

/* ── E09 族:非有限值与字段缺失(与 CR-14 U2-b 同族) ──
 *
 * `Math.max(0, {})` / 字段缺失 ⇒ `NaN`,而 **NaN 的任何比较恒 false**
 * ⇒ `dist > allowed` 静默失效。这类值不需要 msgpack:`{"x":{}}` 经 JSON 即达。 */

test('E15 非有限坐标/帧号被拒:NaN 与字段缺失都拦得住', () => {
  const cases: [string, { tick?: number; x?: unknown; y?: unknown; z?: unknown }][] = [
    ['x=NaN', { tick: 1, x: NaN, y: 1, z: 0 }],
    ['y=NaN', { tick: 1, x: 1, y: NaN, z: 0 }],
    ['z=NaN', { tick: 1, x: 1, y: 1, z: NaN }],
    ['x=+Infinity', { tick: 1, x: Infinity, y: 1, z: 0 }],
    ['x=-Infinity', { tick: 1, x: -Infinity, y: 1, z: 0 }],
    ['tick=NaN', { tick: NaN, x: 1, y: 1, z: 0 }],
    ['tick=Infinity', { tick: Infinity, x: 1, y: 1, z: 0 }],
    ['x 字段缺失', { tick: 1, y: 1, z: 0 }],
    ['x={}(JSON 可达)', { tick: 1, x: {}, y: 1, z: 0 }],
    ['x="abc"(JSON 可达)', { tick: 1, x: 'abc', y: 1, z: 0 }],
  ];
  for (const [label, intent] of cases) {
    const s = createAcState('bad');
    const v = checkMove(s, intent as never);
    eq(v.allowed, false, `${label} 必须被拒`);
    eq(s.lastX, 0, `${label} 不得污染基准 X`);
    eq(s.lastTick, 0, `${label} 不得污染基准 tick`);
  }
});

test('E15b 对照:有限值不被误伤(值域门不能变成拒绝服务)', () => {
  for (const x of [0, 0.1, -0.1, 0.3, 1e-9]) {
    const s = createAcState('ok', 0, 0, 0, 0);
    eq(checkMove(s, { tick: 1, x, y: 0, z: 0 }).allowed, true, `有限 x=${x} 应放行`);
  }
});

test('E15c Z 轴下界与上界两侧:非有限值不许绕过 Z 检查', () => {
  /* z=-1 与 z=maxZ 是合法边界;越界与 NaN 必须拒。 */
  const okS = createAcState('zok', 0, 0, 0, 0);
  eq(checkMove(okS, { tick: 1, x: 0, y: 0, z: 3 }).allowed, true, 'z=3(上界内)放行');
  const okS2 = createAcState('zok2', 0, 0, 0, 0);
  eq(checkMove(okS2, { tick: 1, x: 0, y: 0, z: -1 }).allowed, true, 'z=-1(下界内)放行');
  for (const [label, z] of [['z=3.0001', 3.0001], ['z=-1.0001', -1.0001], ['z=NaN', NaN]] as [string, number][]) {
    const s = createAcState('zbad');
    eq(checkMove(s, { tick: 1, x: 0, y: 0, z }).allowed, false, `${label} 必须被拒`);
  }
});

/* ── E10 族:`ops` 形状门(报文面第三处缺口) ──
 *
 * `ops` 是 `onMessage('inventory')` 里**唯一**由客户端提交的值,而调用链中间
 * 没有任何运行时校验(`readonly InventoryOp[]` 只是 TS 编译期声明)。
 * 修复前,`{"ops":1}` / `{"ops":{}}` / `{"ops":null}` / `{}` 等**一行合法 JSON**
 * 都会让 `for...of` 抛 TypeError ⇒ 没有裁决对象 ⇒ `if (r.violation)` 拿不到
 * 任何东西,违规分不累计、踢出机制不触发。 */

test('E16 ops 非数组被判为非法的裁决(不是抛异常)', () => {
  const inv = { allowedSources: new Set<string>(), beforeTotal: 0, capacity: 8 };
  const cases: [string, unknown][] = [
    ['ops=1(JSON 可达)', 1],
    ['ops={}(JSON 可达)', {}],
    ['ops=null(JSON 可达)', null],
    ['ops 字段缺失(JSON {})', undefined],
    ['ops=true', true],
    ['ops="x"(可迭代但是字符串)', 'x'],
  ];
  for (const [label, ops] of cases) {
    const s = createAcState('bad');
    /* ⚠️ 这条断言的价值在于「不抛」:抛了就没有裁决对象,反作弊静默失效。 */
    const r = checkInventory(s, { tick: 1, ops, ...inv } as never, DEFAULT_LIMITS);
    eq(r.allowed, false, `${label} 必须被拒`);
    eq(r.rejectCode, InventoryReject.MALFORMED, `${label} 拒因应为 MALFORMED`);
  }
});

test('E16b 对照:合法 ops 不受形状门误伤', () => {
  const inv = { allowedSources: new Set<string>(['drop:1']), beforeTotal: 0, capacity: 8 };
  const empty = createAcState('e');
  eq(checkInventory(empty, { tick: 1, ops: [], ...inv }, DEFAULT_LIMITS).allowed, true, '空数组放行');
  const one = createAcState('o');
  const r = checkInventory(one, { tick: 1, ops: [{ itemId: 1, delta: 1, source: 'drop:1' }], ...inv }, DEFAULT_LIMITS);
  eq(r.allowed, true, '带合法凭证的单条操作放行');
  eq(r.afterTotal, 1);
});

test('E16c 操作项本身非法也被判 MALFORMED(不只是外层数组)', () => {
  const inv = { allowedSources: new Set<string>(), beforeTotal: 0, capacity: 8 };
  for (const [label, op] of [
    ['null 操作项', null],
    ['数字操作项', 5],
    ['itemId=NaN', { itemId: NaN, delta: 1 }],
    ['缺 itemId', { delta: 1 }],
  ] as [string, unknown][]) {
    const s = createAcState('p');
    const r = checkInventory(s, { tick: 1, ops: [op], ...inv } as never, DEFAULT_LIMITS);
    eq(r.allowed, false, `${label} 必须被拒`);
    eq(r.rejectCode, InventoryReject.MALFORMED, `${label} 拒因应为 MALFORMED`);
  }
});

test('E14g 吞吐已与**报文速率**解耦:同帧连发不再线性放大(修复后新语义)', () => {
  /* 旧版此处钉的是**残留**:「上界=1 只保证每条报文最多兑现 1 帧额度,
     而 `s.lastTick` 会被每条被接受的报文推进 1 ⇒ 吞吐 ≈ N × 0.717 格/秒」。
     该残留已随双水位改造消失:额度改为 `claimedTick - lastMoveTick`,
     而 `claimedTick` 又被 `lastTick + MAX` 封顶 ⇒ 同一服务端帧内**至多一条**
     报文能兑现(声称 `lastTick+1` 的那条),其余 `dtTicks = 0` 一律拿不到额度。
     故吞吐上界由**真实帧率**决定,与入站报文数无关 —— 这一条现在是**回归哨兵**:
     若有人把服务端封顶去掉,吞吐会重新随 N 线性增长,此断言立刻变红。 */
  const STEP = 0.918;            // MAX=1 帧 @2.55 的满额度
  const run = (N: number): number => {
    const ac = new AntiCheatRoom();
    ac.join('p', 0, 0, 0, 0);
    let x = 0, total = 0;
    for (let i = 0; i < N; i += 1) {
      /* 时钟冻结在一帧内(最坏情形:攻击者把报文全塞进同一帧)。 */
      const v = ac.move({ playerId: 'p', tick: 1, x: x + STEP, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
      if (v.allowed) { total += STEP; x += STEP; }
    }
    return total;
  };
  const at5 = run(5);
  const at50 = run(50);
  ok(at50 <= at5 + 1e-9,
    `同一帧内连发 50 包(${at50.toFixed(3)} 格)不得比 5 包(${at5.toFixed(3)} 格)走得更远`);
  ok(at50 <= maxDisplacementPerTick(MAX_SPEED_BONUS_MUL) + 1e-9,
    `单帧总位移 ${at50.toFixed(3)} 格应 ≤ 单帧额度 ${maxDisplacementPerTick(MAX_SPEED_BONUS_MUL).toFixed(3)} 格`);

  /* 对照:真实帧率下(每帧推进时钟)额度照常发放,不与上一条冲突。
     ⚠️ 步长必须用**真实物理位移** 4.5×2.55×0.05 = 0.5737 格/帧,
     不能用上面的单帧额度 0.918 —— 后者是**单帧跳变容差**(slack 1.6),
     而持续运动受更紧的**窗口上限**约束:4.5×2.55×1.25×0.05 = 0.7172 格/帧。
     用 0.918 连走 20 帧 = 18.36 格/0.95 秒 = 19.3 格/秒 > 14.34 ⇒ 第 20 帧
     本就该判 SPEED(是本测试自己的步长选错,不是实现误伤)。 */
  const PHYS = BASE_MOVE_SPEED * MAX_SPEED_BONUS_MUL * DT;   // 0.57375
  const ac2 = new AntiCheatRoom();
  ac2.join('q', 0, 0, 0, 0);
  let x2 = 0, allowed2 = 0;
  for (let f = 1; f <= 20; f += 1) {
    ac2.tick(f);
    const v = ac2.move({ playerId: 'q', tick: f, x: x2 + PHYS, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
    if (v.allowed) { allowed2 += 1; x2 += PHYS; }
    else ok(false, `第 ${f} 帧真实物理位移被误伤:${v.violation?.detail}`);
  }
  eq(allowed2, 20, '20 帧各 1 包应全部放行(帧率配额正常发放)');
});

test('E07 【作弊3】攻速上限被拒:最小间隔 = 0.4s / (1 + bonus)', () => {
  const s = createAcState('macro', 0, 0, 0, 0);
  const minTicks = BASE_ATTACK_INTERVAL_S * TICK_HZ; // 8 帧
  eq(minTicks, 8);
  eq(checkAttack(s, 8).allowed, true, '满 8 帧应允许');
  const v = checkAttack(s, 10); // 仅 2 帧
  eq(v.allowed, false, '2 帧内二次攻击应被拒');
  eq(v.violation?.kind, ViolationKind.ATTACK_RATE);

  /* 加成上限被钳:自称 +1000% 也只是 2 倍速(4 帧)。 */
  const s2 = createAcState('macro2', 0, 0, 0, 0);
  eq(checkAttack(s2, 100, 1e6).allowed, true);
  eq(checkAttack(s2, 102, 1e6).allowed, false, '2 帧 < 4 帧最小间隔');
  eq(checkAttack(s2, 104, 1e6).allowed, true, '4 帧满足最小间隔');
  eq(MAX_ATTACK_SPEED_BONUS, 1.0);
});

test('E08 【作弊4】物品栏:无凭证产出被拒,拒因码为 ITEM_FROM_NOTHING', () => {
  const s = createAcState('duper', 0, 0, 0, 0);
  const r = checkInventory(s, {
    tick: 1,
    ops: [{ itemId: 719, delta: 1 }],   // 没有 source
    allowedSources: new Set<string>(),
    beforeTotal: 0,
    capacity: 320,
  });
  eq(r.allowed, false, '凭空产出应被拒');
  eq(r.violation?.kind, ViolationKind.INVENTORY);
  eq(r.rejectCode, InventoryReject.FROM_NOTHING, '拒因码应为 ITEM_FROM_NOTHING');
  ok(r.violation?.detail.includes('凭空产出') === true, `拒因应含「凭空产出」:${r.violation?.detail}`);

  /* 伪造一个不在白名单里的 source 也要拒。 */
  const fake = checkInventory(createAcState('duper2', 0, 0, 0, 0), {
    tick: 1,
    ops: [{ itemId: 719, delta: 1, source: 'invented:source' }],
    allowedSources: new Set(['real:source']),
    beforeTotal: 0, capacity: 320,
  });
  eq(fake.allowed, false, '伪造 source 应被拒');
  eq(fake.rejectCode, InventoryReject.FROM_NOTHING);
  eq(fake.afterTotal, 0, '拒绝时总量不变');
});

test('E09 物品栏:合法产出(带 source)通过,总量守恒', () => {
  const s = createAcState('honest', 0, 0, 0, 0);
  const r = checkInventory(s, {
    tick: 1,
    ops: [
      { itemId: 101, delta: 3, source: 'chop:tree_42' },
      { itemId: 118, delta: 2, source: 'chop:tree_42' },
      { itemId: 121, delta: -1, source: undefined },
    ],
    allowedSources: new Set(['chop:tree_42']),
    beforeTotal: 10,
    capacity: 320,
  });
  eq(r.allowed, true, `合法应通过:${r.violation?.detail ?? ''}`);
  eq(r.afterTotal, 14, '10 + 3 + 2 - 1 = 14');
});

test('E10 物品栏:单帧净变化超限 / 为负 / 溢出容量 三种边界都被拒', () => {
  const mk = () => createAcState('edge', 0, 0, 0, 0);
  const src = new Set(['s']);

  const flood = checkInventory(mk(), {
    tick: 1,
    ops: [{ itemId: 101, delta: MAX_ITEM_DELTA_PER_TICK + 1, source: 's' }],
    allowedSources: src, beforeTotal: 0, capacity: 10000,
  });
  eq(flood.allowed, false, '净变化超限应拒');

  const neg = checkInventory(mk(), {
    tick: 1,
    ops: [{ itemId: 101, delta: -5 }],
    allowedSources: src, beforeTotal: 2, capacity: 320,
  });
  eq(neg.allowed, false, '总量为负应拒');
  eq(neg.afterTotal, 2, '拒绝时总量不变');

  const over = checkInventory(mk(), {
    tick: 1,
    ops: [{ itemId: 101, delta: 10, source: 's' }],
    allowedSources: src, beforeTotal: 315, capacity: 320,
  });
  eq(over.allowed, false, '溢出容量应拒');

  const frac = checkInventory(mk(), {
    tick: 1,
    ops: [{ itemId: 101, delta: 1.5, source: 's' }],
    allowedSources: src, beforeTotal: 0, capacity: 320,
  });
  eq(frac.allowed, false, '非整数增量应拒');
});

test('E11 违规累计触发踢出;kickedPlayers 可查', () => {
  const ac = new AntiCheatRoom();
  ac.join('bad', 0, 0, 0, 0);
  for (let i = 1; i <= 5; i += 1) {
    ac.move({ playerId: 'bad', tick: i, x: i * 100, y: 0, z: 0 });
  }
  const st = ac.get('bad');
  ok(st !== undefined);
  ok(st.score >= 12, `违规分 ${st.score} 应 ≥ 12`);
  includes(ac.kickedPlayers(), 'bad');
  ok(ac.countByKind(ViolationKind.TELEPORT) >= 3, '应有多条 TELEPORT');
});

test('E12 分数衰减:每帧 -0.02,不会无限累积', () => {
  const s = createAcState('decay', 0, 0, 0, 0);
  checkMove(s, { tick: 1, x: 100, y: 0, z: 0 });   // +4
  const before = s.score;
  for (let i = 0; i < 50; i += 1) {
    s.score = Math.max(0, s.score - 0.02);
  }
  ok(s.score < before, `衰减后 ${s.score} 应小于 ${before}`);
  ok(s.score >= 0, '不得为负');
});

test('E13 合法移动 + 合法攻击 + 合法物品 三者都不产生违规', () => {
  const ac = new AntiCheatRoom();
  ac.join('good', 0, 0, 0, 0);
  let tick = 0;
  for (let i = 0; i < 40; i += 1) {
    tick += 1;
    /* 与生产同构:先推服务端时钟(`room.ts:770`),再处理本帧报文。 */
    ac.tick(tick);
    const v = ac.move({ playerId: 'good', tick, x: i * BASE_MOVE_SPEED * DT, y: 0, z: 0 });
    ok(v.allowed, `第 ${i} 帧合法移动被拒:${v.violation?.detail ?? ''}`);
  }
  ok(ac.attack('good', 100).allowed);
  const inv = ac.inventory('good', {
    tick: 200, ops: [{ itemId: 101, delta: 1, source: 'chop:x' }],
    allowedSources: new Set(['chop:x']), beforeTotal: 0, capacity: 320,
  });
  ok(inv.allowed);
  eq(ac.violations().length, 0, '不应有任何违规');
});

/* ══════════════════ F. 房间生命周期 / 权限 / 重连 ══════════════════ */

function newRoom(db: DbLike | null = null): { rt: RoomRuntime; c: ReturnType<typeof fixedClock> } {
  const c = fixedClock(1_700_000_000_000);
  if (db) {
    createUserRow(db, { id: 'owner', displayName: '岛主', nowMs: c.clock.nowMs() });
    createUserRow(db, { id: 'guest1', displayName: '客人', nowMs: c.clock.nowMs() });
  }
  const rt = new RoomRuntime({ roomId: 'room_alpha', ownerId: 'owner', clock: c.clock }, db);
  return { rt, c };
}

test('F01 创建/加入:房主得 OWNER,普通玩家得 MEMBER,访客得 GUEST', () => {
  const { rt } = newRoom();
  const a = rt.join({ userId: 'owner' });
  eq(a.ok, true);
  eq(a.role, RoomRole.OWNER);
  ok(a.snapshot !== undefined, '入场应给快照');

  const b = rt.join({ userId: 'u2' });
  eq(b.role, RoomRole.MEMBER);
  const c = rt.join({ userId: 'u3', asGuest: true });
  eq(c.role, RoomRole.GUEST);
  eq(rt.onlineCount(), 3);
  eq(rt.state.players.length, 3, '三个玩家实体');
});

test('F02 密码房:错误密码被拒,正确密码放行', () => {
  const clock = fixedClock(1000);
  const rt = new RoomRuntime({
    roomId: 'rp', ownerId: 'owner', clock, accessMode: AccessMode.PASSWORD, passwordHash: 'hash_abc',
  });
  const bad = rt.join({ userId: 'owner', passwordHash: 'wrong' });
  eq(bad.ok, false, '错误密码应拒');
  const noPass = rt.join({ userId: 'owner' });
  eq(noPass.ok, false, '无密码应拒');
  const good = rt.join({ userId: 'owner', passwordHash: 'hash_abc' });
  eq(good.ok, true);
});

test('F03 满员拒绝(默认 16 人)', () => {
  const clock = fixedClock(1000);
  const rt = new RoomRuntime({ roomId: 'rf', ownerId: 'o', clock, maxPlayers: 3 });
  eq(rt.join({ userId: 'o' }).ok, true);
  eq(rt.join({ userId: 'a' }).ok, true);
  eq(rt.join({ userId: 'b' }).ok, true);
  const full = rt.join({ userId: 'c' });
  eq(full.ok, false);
  ok((full.reason ?? '').includes('满'), `原因:${full.reason}`);
});

test('F04 【60 秒休眠】用注入时钟推进,不真 sleep;第 59 秒不睡、第 60 秒睡', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.leave('owner');                    // 主动离开 → 房间空
  eq(rt.onlineCount(), 0);

  c.advance(IDLE_SLEEP_MS - 1000);      // +59s
  eq(rt.checkIdleSleep(), false, '59 秒不应休眠');
  eq(rt.status, RoomStatus.OPEN);

  c.advance(1000);                      // +60s 整
  eq(rt.checkIdleSleep(), true, '60 秒应休眠');
  eq(rt.status, RoomStatus.SLEEPING);
  eq(rt.sleepCount, 1);
  eq(IDLE_SLEEP_MS, 60_000);
});

test('F05 有人在线时永不休眠,即便过了 10 分钟', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  c.advance(600_000);
  eq(rt.checkIdleSleep(), false, '有人在线不应休眠');
  eq(rt.status, RoomStatus.OPEN);
});

test('F05b 【打盹 ≠ 离线】打盹玩家仍占席位,不触发 60 秒房间休眠', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'napper' });

  /* 进入打盹:仍 connected、仍有实体,只是不计入「活跃」。 */
  eq(rt.setAfk('napper', true), true);
  eq(rt.afkPlayerCount(), 1);
  eq(rt.activePlayerCount(), 1, '只剩 owner 清醒');
  eq(rt.onlineCount(), 2, '两人都还在线');
  eq(rt.state.players.length, 2, '打盹不销毁实体(要吃 AFK 经验)');

  /* owner 也掉线,只剩打盹的人 —— 房间仍然「有人」。 */
  rt.disconnect('owner');
  eq(rt.onlineCount(), 1);
  eq(rt.afkPlayerCount(), 1);

  /* 推进 10 分钟:绝不休眠。 */
  c.advance(600_000);
  eq(rt.checkIdleSleep(), false, '只剩打盹玩家时不应休眠');
  eq(rt.status, RoomStatus.OPEN, '房间必须保持 OPEN');
  eq(rt.sleepCount, 0);

  /* 打盹者醒来,活动计数恢复。 */
  eq(rt.setAfk('napper', false), true);
  eq(rt.afkPlayerCount(), 0);
  eq(rt.activePlayerCount(), 1);
  eq(rt.checkIdleSleep(), false);

  /* 打盹者真正离线后,才走 60 秒休眠计时。 */
  rt.disconnect('napper');
  eq(rt.onlineCount(), 0);
  c.advance(IDLE_SLEEP_MS + 1);
  eq(rt.checkIdleSleep(), true, '全部离线满 60 秒后才休眠');
  eq(rt.status, RoomStatus.SLEEPING);
});

test('F05c 打盹状态在重连时被清除(回来就是清醒的)', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'u2' });
  rt.setAfk('u2', true);
  eq(rt.afkPlayerCount(), 1);
  rt.disconnect('u2');
  const back = rt.join({ userId: 'u2' });
  eq(back.ok, true);
  eq(back.resumed, true);
  eq(rt.afkPlayerCount(), 0, '重连后不应还是打盹态');
  eq(rt.activePlayerCount(), 2);
});

test('F05d 未在线的用户 setAfk 返回 false(不能远程给人挂机)', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  eq(rt.setAfk('nobody', true), false);
  rt.disconnect('owner');
  eq(rt.setAfk('owner', true), false, '已断线的人不能被设打盹');
});

test('F05e 【打盹超时 30 分钟】成员仍在 members、仍 connected、仍占席位', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'sleeper' });
  rt.setAfk('sleeper', true);
  eq(AFK_TIMEOUT_MS, 30 * 60 * 1000, '超时阈值应为 30 分钟');

  /* 29 分钟:未超时。 */
  c.advance(AFK_TIMEOUT_MS - 60_000);
  const m1 = rt.members.get('sleeper');
  ok(m1 !== undefined);
  eq(rt.isAfkExpired(m1), false, '29 分钟不应算超时');
  eq(rt.presenceOf('sleeper'), MemberPresence.AFK);

  /* 30 分钟整:超时,但**不 disconnect**。 */
  c.advance(60_000);
  const m2 = rt.members.get('sleeper');
  ok(m2 !== undefined, '超时后成员必须仍在 members 里');
  eq(m2.connected, true, '超时后仍 connected(裁决 1:超时不 disconnect)');
  eq(rt.isAfkExpired(m2), true, '应判为超时');
  eq(rt.presenceOf('sleeper'), MemberPresence.AFK_EXPIRED);
  eq(m2.afkSinceMs !== null, true, 'afkSinceMs 应保留(不重置 —— 人可能还在)');

  /* 席位:超时者仍计入 seatCount / afkPlayerCount。 */
  eq(rt.seatCount(), 2, '超时者仍占席位');
  eq(rt.afkPlayerCount(), 1, '仍算打盹玩家');
  eq(rt.afkExpiredCount(), 1);
  eq(rt.onlineCount(), 2, '仍是在线');

  /* 关键:房主离开只剩超时打盹者 → 房间**绝不能休眠**(否则他回来房没了)。 */
  rt.leave('owner');
  eq(rt.seatCount(), 1);
  c.advance(600_000);   // 再推 10 分钟
  eq(rt.checkIdleSleep(), false, '超时打盹者在线时房间不应休眠');
  eq(rt.status, RoomStatus.OPEN);
  eq(rt.sleepCount, 0);
});

test('F05f 【打盹超时】不计入 activePlayerCount,但计入席位数', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'sleeper' });

  /* 清醒:2 活跃 / 0 打盹 / 2 席位。 */
  eq(rt.activePlayerCount(), 2);
  eq(rt.afkPlayerCount(), 0);
  eq(rt.seatCount(), 2);

  /* 打盹未超时:1 活跃 / 1 打盹 / 2 席位。 */
  rt.setAfk('sleeper', true);
  eq(rt.activePlayerCount(), 1, '打盹者不计入活跃');
  eq(rt.afkPlayerCount(), 1);
  eq(rt.seatCount(), 2, '打盹不释放席位');

  /* 打盹超时:活跃数**不变**(本来就不算),席位**不变**。 */
  c.advance(AFK_TIMEOUT_MS + 1);
  eq(rt.activePlayerCount(), 1, '超时者仍不计入活跃');
  eq(rt.afkPlayerCount(), 1);
  eq(rt.afkExpiredCount(), 1);
  eq(rt.seatCount(), 2, '超时也仍占席位 —— 这就是「不 disconnect」的收益');
  eq(rt.onlineCount(), 2);

  /* 超时者退出经验与掉落归属,未超时的打盹者仍保留 30% 经验资格。 */
  const owner = rt.members.get('owner');
  const sleeper = rt.members.get('sleeper');
  ok(owner !== undefined && sleeper !== undefined);
  eq(rt.isExpEligible(owner), true, '清醒者全额经验');
  eq(rt.isExpEligible(sleeper), false, '超时者退出经验分配');
  eq(rt.isLootEligible(sleeper), false, '超时者退出个人掉落归属');

  /* 对照:未超时的打盹者**仍然**吃 30% 经验、仍有掉落归属。 */
  const { rt: rt2, c: c2 } = newRoom();
  rt2.join({ userId: 'owner' });
  rt2.join({ userId: 'nap' });
  rt2.setAfk('nap', true);
  c2.advance(AFK_TIMEOUT_MS - 1);
  const nap = rt2.members.get('nap');
  ok(nap !== undefined);
  eq(rt2.presenceOf('nap'), MemberPresence.AFK);
  eq(rt2.isExpEligible(nap), true, '未超时可享受 AFK_EXP_RATIO=0.3 的经验');
  eq(rt2.isLootEligible(nap), true, '未超时仍有掉落归属');

  /* 醒来即恢复活跃并回到全额经验。 */
  rt.setAfk('sleeper', false);
  eq(rt.activePlayerCount(), 2);
  eq(rt.afkExpiredCount(), 0);
  const back = rt.members.get('sleeper');
  ok(back !== undefined);
  eq(rt.isExpEligible(back), true);
});

test('F05g 四态在场判定完整:清醒/打盹/打盹超时/离线', () => {
  eq(Object.keys(MemberPresence).length, 4);
  eq(MemberPresence.ACTIVE, 'ACTIVE');
  eq(MemberPresence.AFK_EXPIRED, 'AFK_EXPIRED');
  eq(Object.keys(MEMBER_PRESENCE_LABEL).length, 4, '每个态都要有显示名');
  eq(MEMBER_PRESENCE_LABEL.AFK, '打盹');
  eq(MEMBER_PRESENCE_LABEL.AFK_EXPIRED, '打盹超时');

  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  eq(rt.presenceOf('owner'), MemberPresence.ACTIVE);
  eq(rt.presenceOf('ghost'), undefined, '不存在的成员返回 undefined');

  rt.setAfk('owner', true);
  eq(rt.presenceOf('owner'), MemberPresence.AFK);
  c.advance(AFK_TIMEOUT_MS + 1);
  eq(rt.presenceOf('owner'), MemberPresence.AFK_EXPIRED);

  rt.disconnect('owner');
  eq(rt.presenceOf('owner'), MemberPresence.OFFLINE, '断线优先于打盹');
  eq(rt.seatCount(), 0, '断线不占席位');
  eq(rt.afkExpiredCount(), 0, '断线者不算打盹超时');
});

test('F06 唤醒:休眠房加入 → 自动 OPEN,wakeCount+1,世界帧号接续', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.state.meta.tick = 5000;
  rt.leave('owner');
  c.advance(IDLE_SLEEP_MS + 1);
  rt.checkIdleSleep();
  eq(rt.status, RoomStatus.SLEEPING);

  const r = rt.join({ userId: 'someone' });
  eq(r.ok, true);
  eq(rt.status, RoomStatus.OPEN, '加入应自动唤醒');
  eq(rt.wakeCount, 1);
  eq(rt.state.meta.tick, 5000, '世界帧号应接续,不重置');
});

test('F07 step() 在 SLEEPING 时不推进世界帧号(零 CPU)', () => {
  const { rt, c } = newRoom();
  c.advance(IDLE_SLEEP_MS + 1);
  rt.checkIdleSleep();
  eq(rt.status, RoomStatus.SLEEPING);
  const tickBefore = rt.state.meta.tick;
  const pkt = rt.step(rt.cloneState());
  eq(pkt.length, 0, '休眠房不发包');
  eq(rt.state.meta.tick, tickBefore, '帧号不推进');
});

test('F08 【断线 30 秒】重连快照逐字节一致', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'u2' });
  rt.applyMove('u2', { tick: 1, x: 1.0, y: 0.5, z: 0 });
  rt.state.meta.tick = 300;

  const before = rt.snapshotFor('u2');
  rt.disconnect('u2');
  eq(rt.onlineCount(), 1);
  eq(rt.members.get('u2')?.connected, false);
  eq(rt.state.players.length, 2, '断线不删实体(占位保留)');

  c.advance(20_000);                  // 20s 后回来
  const back = rt.join({ userId: 'u2' });
  eq(back.ok, true);
  eq(back.resumed, true, '应走重连路径');
  eq(RECONNECT_GRACE_MS, 30_000, '宽限期常量');
  ok(back.snapshot !== undefined);
  eq(back.snapshot.length, before.length, '快照长度应一致');
  for (let i = 0; i < before.length; i += 1) {
    if (back.snapshot[i] !== before[i]) throw new Error(`快照第 ${i} 字节不一致`);
  }
});

test('F09 超过 30 秒宽限期:重连降级为 GUEST,不再是原角色', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  const j = rt.join({ userId: 'admin1' });
  eq(j.role, RoomRole.MEMBER);
  rt.setMemberRole('owner', 'admin1', RoomRole.ADMIN);
  eq(rt.members.get('admin1')?.role, RoomRole.ADMIN);

  rt.disconnect('admin1');
  c.advance(RECONNECT_GRACE_MS + 1);
  const back = rt.join({ userId: 'admin1' });
  eq(back.ok, true);
  eq(back.resumed, false, '超期不走重连路径');
  eq(back.role, RoomRole.GUEST, '应降级为 GUEST');
});

test('F10 reapExpiredDisconnects 清理超期掉线成员,实体同步移除', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'u2' });
  rt.disconnect('u2');
  eq(rt.state.players.length, 2);

  c.advance(RECONNECT_GRACE_MS - 1);
  eq(rt.reapExpiredDisconnects().length, 0, '未超期不清理');
  c.advance(2);
  const gone = rt.reapExpiredDisconnects();
  eq(gone.length, 1);
  eq(gone[0], 'u2');
  eq(rt.state.players.length, 1, '实体应被移除');
});

test('F11 【权限矩阵】GUEST 越权被拒:建造/布线/开箱/派对/管理/配置/破坏', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'g', asGuest: true });

  const denied: RoomAction[] = [
    RoomAction.PLACE_BLOCK, RoomAction.BREAK_BLOCK, RoomAction.CRAFT,
    RoomAction.PLACE_AUTOMATION, RoomAction.WIRE_EDIT,
    RoomAction.OPEN_CHEST, RoomAction.USE_ALCHEMY_FURNACE,
    RoomAction.MODIFY_TOWN, RoomAction.START_PARTY, RoomAction.SET_PARTY_MODE,
    RoomAction.KICK_MEMBER, RoomAction.SET_MEMBER_ROLE,
    RoomAction.SET_ROOM_ACCESS, RoomAction.RESET_WORLD, RoomAction.CLOSE_ROOM,
  ];
  for (const a of denied) {
    const g = rt.authorize('g', a);
    eq(g.allowed, false, `GUEST 不应能 ${a}`);
    eq(g.role, RoomRole.GUEST);
  }
  /* 但基础生存动作允许。 */
  for (const a of [RoomAction.MOVE, RoomAction.ATTACK, RoomAction.PICKUP_ITEM, RoomAction.SLEEP, RoomAction.USE_OWN_CHEST]) {
    eq(rt.authorize('g', a).allowed, true, `GUEST 应能 ${a}`);
  }
});

test('F12 【权限矩阵】MEMBER 可建造但不可配置/破坏;ADMIN 不可配置但可管理', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'm' });
  rt.join({ userId: 'ad', asGuest: true });
  rt.setMemberRole('owner', 'ad', RoomRole.ADMIN);

  eq(rt.authorize('m', RoomAction.PLACE_BLOCK).allowed, true, 'MEMBER 可建造');
  eq(rt.authorize('m', RoomAction.WIRE_EDIT).allowed, true, 'MEMBER 可布线');
  eq(rt.authorize('m', RoomAction.OPEN_CHEST).allowed, false, 'MEMBER 不可开公共箱');
  eq(rt.authorize('m', RoomAction.SET_ROOM_ACCESS).allowed, false, 'MEMBER 不可改配置');
  eq(rt.authorize('m', RoomAction.CLOSE_ROOM).allowed, false, 'MEMBER 不可关房');

  eq(rt.authorize('ad', RoomAction.KICK_MEMBER).allowed, true, 'ADMIN 可管理');
  eq(rt.authorize('ad', RoomAction.SET_ROOM_ACCESS).allowed, false, 'ADMIN 不可改配置');
  eq(rt.authorize('ad', RoomAction.RESET_WORLD).allowed, false, 'ADMIN 不可破坏');

  eq(rt.authorize('owner', RoomAction.RESET_WORLD).allowed, true, 'OWNER 全权');
  eq(rt.authorize('owner', RoomAction.SET_ROOM_ACCESS).allowed, true);
});

test('F13 权限矩阵表结构完整:4 角色 × 9 权限位 × 22 动作全覆盖', () => {
  eq(Object.keys(PERMISSION_MATRIX).length, 4);
  for (const role of [RoomRole.OWNER, RoomRole.ADMIN, RoomRole.MEMBER, RoomRole.GUEST]) {
    const p = PERMISSION_MATRIX[role];
    eq(Object.keys(p).length, 9, `${role} 权限位数`);
    ok(p.baseline === true, `${role} 必须有 baseline`);
  }
  const actions = Object.keys(ACTION_PERMISSION);
  eq(actions.length, Object.keys(RoomAction).length, '每个动作都要映射到权限位');
  for (const a of Object.values(RoomAction)) {
    ok(ACTION_PERMISSION[a] in PERMISSION_MATRIX.OWNER, `${a} 的权限位非法`);
  }
  /* 越权语义:GUEST 只有 baseline。 */
  eq(can(RoomRole.GUEST, RoomAction.ATTACK), true);
  eq(can(RoomRole.GUEST, RoomAction.PLACE_BLOCK), false);
  eq(can(RoomRole.UNKNOWN_ROLE ?? 'NOPE' as RoomRole, RoomAction.ATTACK), false, '未知角色一律拒');
});

test('F14 越权操作无副作用:kick 被拒后目标仍在房间', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'm' });
  rt.join({ userId: 'g', asGuest: true });

  const r = rt.kick('g', 'm');
  eq(r.ok, false, 'GUEST 踢人应被拒');
  ok(rt.members.has('m'), '目标应仍在房间');

  const r2 = rt.setMemberRole('m', 'g', RoomRole.ADMIN);
  eq(r2.ok, false, 'MEMBER 提权应被拒');
  eq(rt.members.get('g')?.role, RoomRole.GUEST, '角色不变');

  const r3 = rt.setAccess('m', AccessMode.PASSWORD, 'h');
  eq(r3.ok, false, 'MEMBER 改密码应被拒');
  eq(rt.accessMode, AccessMode.PUBLIC, '访问模式不变');
});

test('F15 房主保护:kick 房主 / 改房主角色 都被拒', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'ad', asGuest: true });
  rt.setMemberRole('owner', 'ad', RoomRole.ADMIN);

  eq(rt.kick('ad', 'owner').ok, false, 'ADMIN 不能踢房主');
  eq(rt.setMemberRole('ad', 'owner', RoomRole.GUEST).ok, false, '不能改房主角色');
  eq(rt.setMemberRole('ad', 'ad', RoomRole.OWNER).ok, false, '不能自封房主');
});

test('F16 房主离开后管理权移交给最早加入的在线成员', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'early' });
  rt.join({ userId: 'late' });
  rt.leave('owner');
  eq(rt.members.get('early')?.role, RoomRole.ADMIN, '最早加入者应升为 ADMIN');
  eq(rt.members.get('late')?.role, RoomRole.MEMBER, '后来者不变');
});

test('F17 派对模式:仅 OWNER/ADMIN 可切,GUEST 被拒且模式不变', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'g', asGuest: true });
  eq(rt.setPartyModeBy('g', PartyMode.JELLY_BALL).ok, false, 'GUEST 应被拒');
  eq(rt.partyMode, PartyMode.NONE, '模式不变');
  eq(rt.setPartyModeBy('owner', PartyMode.CROWN_BR).ok, true);
  eq(rt.partyMode, PartyMode.CROWN_BR);
  eq(rt.state.meta.partyMode, Object.values(PartyMode).indexOf('CROWN_BR'));
});

test('F18 step() 推进 tick 并产出差量包;20 帧后 tick%20==0 落盘', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  const { rt } = newRoom(db);
  rt.join({ userId: 'owner' });

  let prev = rt.cloneState();
  const sizes: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const pkt = rt.step(prev);
    prev = rt.cloneState();
    sizes.push(pkt.length);
    if (i < 19) eq(pkt.length, 10, `静止帧 ${i} 应为 10 字节(仅头),实际 ${pkt.length}`);
  }
  eq(rt.state.meta.tick, 20);
  ok(sizes.every((s) => s <= 12), '每帧都应是空差量');
  const roomRow = getRoom(db, 'room_alpha');
  eq(roomRow?.world_tick, 20, '第 20 帧应把 world_tick 落盘');
});

test('F19 RoomRegistry:创建/列表/休眠过滤/超期回收', () => {
  const clock = fixedClock(1000);
  const reg = new RoomRegistry({ clock });
  reg.create({ roomId: 'r1', ownerId: 'o1' });
  reg.create({ roomId: 'r2', ownerId: 'o2' });
  eq(reg.size(), 2);
  eq(reg.list().length, 2);
  ok(reg.list().every((r) => r.status === RoomStatus.OPEN));

  const r1 = reg.get('r1');
  ok(r1 !== undefined);
  r1.sleep();
  eq(reg.list().length, 1, '默认不列休眠房');
  eq(reg.list(true).length, 2, 'includeSleeping 时列全');

  clock.advance(24 * 60 * 60 * 1000 + 1);
  const evicted = reg.reapEvictions();
  eq(evicted.length, 1);
  eq(evicted[0], 'r1');
  eq(reg.size(), 1);
  includes(reg.evictedRooms(), 'r1');
});

test('F20 bootstrap 装配:owner 用户 + 房间 + 可加入', () => {
  const clock = fixedClock(2000);
  const db = new MemoryDb();
  migrate(db, 2000);
  const { registry, ownerId, roomId } = bootstrap({ clock, db });
  eq(ownerId, 'u_owner');
  eq(roomId, 'room_alpha');
  ok(getUser(db, ownerId) !== undefined, 'owner 应落库');
  ok(getRoom(db, roomId) !== undefined, '房间应落库');

  const rt = registry.get(roomId);
  ok(rt !== undefined);
  const j = rt.join({ userId: ownerId });
  eq(j.ok, true);
  eq(j.role, RoomRole.OWNER);
  eq(db.count('room_players'), 1, '成员应落库');
});

test('F21 断线快照落库:PCB 路径(disconnect → DB)与重连读取一致', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  const { rt } = newRoom(db);
  rt.join({ userId: 'owner' });
  rt.state.meta.tick = 77;
  rt.disconnect('owner');

  const stored = loadReconnectSnapshot(db, 'room_alpha', 'owner');
  ok(stored !== undefined, '快照应已落库');
  const live = rt.snapshotFor('owner');
  eq(stored.length, live.length);
  for (let i = 0; i < live.length; i += 1) {
    if (stored[i] !== live[i]) throw new Error(`DB 快照第 ${i} 字节与实时不一致`);
  }

  /* 手工覆盖快照后再读,确认读的是库里的值。 */
  saveReconnectSnapshot(db, 'room_alpha', 'owner', new Uint8Array([1, 2, 3]), 5000);
  const again = loadReconnectSnapshot(db, 'room_alpha', 'owner');
  eq(again?.length, 3);
  eq(again?.[0], 1);
});

test('F22 房间状态迁移落库并写审计事件(触发器语义由 repo 覆盖)', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  const { rt, c } = newRoom(db);
  rt.join({ userId: 'owner' });
  rt.leave('owner');
  c.advance(IDLE_SLEEP_MS + 1);
  rt.checkIdleSleep();
  eq(getRoom(db, 'room_alpha')?.status, RoomStatus.SLEEPING);
  ok(getRoom(db, 'room_alpha')?.saved_at !== null, '休眠应记 saved_at');

  rt.wake();
  eq(getRoom(db, 'room_alpha')?.status, RoomStatus.OPEN);
});

test('F23 反作弊在房间层生效:瞬移被拒且写违规流水', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  const v = rt.applyMove('owner', { tick: 1, x: 500, y: 500, z: 0 });
  eq(v.allowed, false);
  eq(rt.playerState('owner')?.x, 0.5, '实体坐标不应被改(出生点 0.5)');
  const dropped = rt.drainViolations();
  eq(dropped.length, 1);
  eq(dropped[0].kind, ViolationKind.TELEPORT);
  eq(rt.drainViolations().length, 0, 'drain 后应清空');
});

test('F24 合法移动在房间层被接受,实体坐标同步', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  const spawnX = rt.playerState('owner')?.x ?? 0;
  const v = rt.applyMove('owner', { tick: 1, x: spawnX + 0.2, y: 0.5, z: 0 });
  eq(v.allowed, true);
  near(rt.playerState('owner')?.x ?? -1, spawnX + 0.2, 1e-9);
});

test('F25 重连快照在多玩家场景下仍逐字节一致', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'u2' });
  rt.join({ userId: 'u3' });
  rt.applyMove('u2', { tick: 1, x: 1, y: 1, z: 0 });
  rt.state.meta.tick = 999;

  const before = rt.snapshotFor('u2');
  rt.disconnect('u2');
  c.advance(1000);
  const j = rt.join({ userId: 'u2' });
  ok(j.snapshot !== undefined);
  eq(j.snapshot.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    if (j.snapshot[i] !== before[i]) throw new Error(`第 ${i} 字节不一致`);
  }
  eq(rt.state.meta.tick, 999, '状态不应被重连改变');
});

test('F26 close() 后 join 被拒,step 不再推进', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  eq(rt.close(), true);
  eq(rt.status, RoomStatus.CLOSED);
  eq(rt.close(), false, '重复关闭应返回 false');
  const j = rt.join({ userId: 'u9' });
  eq(j.ok, false);
  const before = rt.state.meta.tick;
  eq(rt.step(rt.cloneState()).length, 0);
  eq(rt.state.meta.tick, before);
});

test('F27 心跳刷新 lastSeen 并恢复在线态', () => {
  const { rt, c } = newRoom();
  rt.join({ userId: 'owner' });
  rt.disconnect('owner');
  eq(rt.members.get('owner')?.connected, false);
  c.advance(1000);
  eq(rt.heartbeat('owner'), true);
  eq(rt.members.get('owner')?.connected, true);
  eq(rt.members.get('owner')?.disconnectedAtMs, null);
});

test('F28 同用户重复在线加入被拒(防多开顶号)', () => {
  const { rt } = newRoom();
  eq(rt.join({ userId: 'owner' }).ok, true);
  const again = rt.join({ userId: 'owner' });
  eq(again.ok, false);
  ok((again.reason ?? '').includes('已在线'), `原因:${again.reason}`);
});

/* ══════════════════ G. 端到端 ══════════════════ */

test('G01 端到端:8 人房间跑 60 帧,快照 → 差量 → 重建全部一致', () => {
  const clock = fixedClock(1000);
  const rt = new RoomRuntime({ roomId: 'e2e', ownerId: 'p0', clock });
  for (let i = 0; i < 8; i += 1) rt.join({ userId: `p${i}` });

  let prev = rt.cloneState();
  const decoderStateQueue: RoomState[] = [cloneRoomState(prev)];
  let totalBytes = 0;

  for (let f = 0; f < 60; f += 1) {
    /* 每帧让 p1 挪一点(合法速度)。 */
    const p1 = rt.playerState('p1');
    ok(p1 !== undefined);
    const v = rt.applyMove('p1', {
      tick: rt.state.meta.tick + 1,
      x: p1.x + BASE_MOVE_SPEED * DT * 0.9,
      y: p1.y,
      z: 0,
    });
    ok(v.allowed, `第 ${f} 帧合法移动被拒:${v.violation?.detail ?? ''}`);

    const pkt = rt.step(prev);
    totalBytes += pkt.length;
    /* 客户端侧:用解码包重建状态,应与服务端逐字段一致。 */
    const rebuilt = applyPacket(decoderStateQueue[decoderStateQueue.length - 1], decodePacket(pkt));
    decoderStateQueue.push(rebuilt);
    prev = rt.cloneState();
  }

  const clientState = decoderStateQueue[decoderStateQueue.length - 1];
  const serverState = rt.cloneState();
  eq(clientState.players.length, serverState.players.length, '玩家数一致');
  eq(clientState.meta.tick, serverState.meta.tick, '帧号一致');
  for (let i = 0; i < serverState.players.length; i += 1) {
    const a = clientState.players[i];
    const b = serverState.players[i];
    eq(a.id, b.id);
    near(a.x, b.x, 1 / POS_SCALE, `玩家 ${b.id} x`);
    near(a.y, b.y, 1 / POS_SCALE, `玩家 ${b.id} y`);
    eq(a.hp, b.hp);
  }
  ok(totalBytes < 60 * 120, `60 帧共 ${totalBytes}B 应 < 7200B`);
});

test('G02 端到端:存档 → 重启 → 读回,chunk 与玩家状态逐字节一致', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: '岛主', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });

  const cells = new Uint32Array(CHUNK_CELLS);
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    cells[i] = packTile({ elev: i % 4, base: 1, floor: i % 64, wire: 0, obj: i % 4096, meta: 0 });
  }
  const blob = packChunkBlob(cells);
  saveChunk(db, 'r1', 0, 0, blob, 2000);
  savePlayerState(db, 'u1', {
    level: 25, exp: 12345, hp: 400, max_hp: 460,
    pos_x: 12.5, pos_y: -3.25, pos_z: 2, dir: 2, state_flag: 4,
    weapon_id: 719, ai_weapon_recipe_hash: '116_125_712',
    inventory_json: '{"101":20,"116":5}',
  }, 3000);

  /* 「重启」:新 MemoryDb 无法模拟,但库本身是同一份;直接重读。 */
  const chunkBack = loadChunkCells(db, 'r1', 0, 0);
  ok(chunkBack !== undefined);
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    if (chunkBack[i] !== (cells[i] >>> 0)) throw new Error(`格 ${i} 不一致`);
  }

  const u = getUser(db, 'u1');
  eq(u?.level, 25);
  eq(u?.exp, 12345);
  eq(u?.max_hp, 460);
  near(u?.pos_x ?? 0, 12.5, 1e-9);
  near(u?.pos_y ?? 0, -3.25, 1e-9);
  eq(u?.pos_z, 2);
  eq(u?.dir, 2);
  eq(u?.state_flag, 4);
  eq(u?.weapon_id, 719);
  eq(u?.ai_weapon_recipe_hash, '116_125_712');
  eq(u?.inventory_json, '{"101":20,"116":5}');
});

test('G03 端到端:16 人房间稳态下行带宽符合文档三档估算', () => {
  const rt = new RoomRuntime({ roomId: 'band', ownerId: 'p0', clock: fixedClock(1000) });
  for (let i = 0; i < 16; i += 1) rt.join({ userId: `p${i}` });

  let prev = rt.cloneState();
  let bytes = 0;
  const FRAMES = 100;
  for (let f = 0; f < FRAMES; f += 1) {
    /* 所有人每帧合法移动 0.9 倍速 → 每人都要发 x/y。 */
    for (let i = 0; i < 16; i += 1) {
      const p = rt.playerState(`p${i}`);
      ok(p !== undefined);
      rt.applyMove(`p${i}`, {
        tick: rt.state.meta.tick + 1,
        x: p.x + BASE_MOVE_SPEED * DT * 0.9,
        y: p.y,
        z: 0,
      });
    }
    bytes += rt.step(prev).length;
    prev = rt.cloneState();
  }
  const perFrame = bytes / FRAMES;
  const model = estimateBandwidth(16, 20);
  ok(perFrame < 800, `16 人实测每帧 ${perFrame.toFixed(1)}B 应 < 800B`);
  ok(perFrame <= model.frameBytes * 2.5,
    `实测 ${perFrame.toFixed(1)}B 不应大幅超过模型 ${model.frameBytes}B`);
  const kbs = (perFrame * 20) / 1024;
  ok(kbs < 12, `实测下行 ${kbs.toFixed(2)} kB/s 应 < 12`);
});

test('G04 端到端:四类作弊在完整房间流程中都被拒绝', () => {
  const { rt } = newRoom();
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'cheat' });

  /* 1 坐标跳变:从出生点瞬移到 (40,40) */
  const tele = rt.applyMove('cheat', { tick: 1, x: 40, y: 40, z: 0 });
  eq(tele.allowed, false, '瞬移应被拒');
  eq(tele.violation?.kind, ViolationKind.TELEPORT);

  /* 2 移速:每帧 0.32 格(6.4 格/秒)。单帧上界 0.72 格 → 单帧合法,
   *   但 1 秒窗口均速 6.4 > 4.5×1.25=5.625 → 窗口检测应命中 SPEED。
   *   起点必须是**当前权威坐标**,否则会被先判成瞬移。
   *   ⚠️ 必须每帧 `rt.step()`:服务端时钟只由 `room.ts:770` 推进,
   *   而每帧额度 = `claimedTick - lastMoveTick` —— 不跑 step 就一帧额度都拿不到,
   *   位移检查会被冻结(与 E03/E04 同一根因)。 */
  const startX = rt.playerState('cheat')?.x ?? 0;
  let rejectedSpeed = false;
  let tick = tele.violation?.tick ?? 1;
  for (let i = 1; i <= 25; i += 1) {
    tick += 1;
    const v = rt.applyMove('cheat', { tick, x: startX + i * 0.32, y: 0.5, z: 0 });
    if (!v.allowed) {
      ok(v.violation?.kind === ViolationKind.SPEED,
        `应判 SPEED 而非 ${v.violation?.kind}:${v.violation?.detail}`);
      rejectedSpeed = true;
      break;
    }
    rt.step(null);   // 本帧推进服务端时钟(与 room.ts:769-770 同构)
  }
  ok(rejectedSpeed, `累计超速应被拒(窗口均速 6.4 格/秒 > 5.625)`);

  /* 3 攻速:同一 tick 连打两次 */
  eq(rt.applyAttack('cheat', 0).allowed, true);
  eq(rt.applyAttack('cheat', 0).allowed, false, '同一 tick 二次攻击应被拒');

  /* 4 物品栏:凭空造 99 件传奇武器。
     ⚠️ 这里**刻意只传 ops** —— CR-14 U1 修复后,`applyInventory` 的签名
     只接受 `{ ops }`,其余三个判据一律由服务端派生。
     早期版本传 `allowedSources: new Set()` / `beforeTotal` / `capacity`,
     那是**在生产不可能出现的入参**上通过(装配层缺口的测试形态之一)。 */
  const inv = rt.applyInventory('cheat', { ops: [{ itemId: 719, delta: 99 }] });
  eq(inv.allowed, false, '凭空造物品应被拒');
  eq(inv.rejectCode, InventoryReject.FROM_NOTHING);

  /* 四类违规都留下流水。 */
  const kinds = new Set(rt.ac.violations().map((v) => v.kind));
  for (const k of [ViolationKind.TELEPORT, ViolationKind.SPEED, ViolationKind.ATTACK_RATE, ViolationKind.INVENTORY]) {
    ok(kinds.has(k), `应记录 ${k} 违规,实际只有 ${[...kinds].join(',')}`);
  }
  /* 违规分应已接近踢出阈值。 */
  const st = rt.ac.get('cheat');
  ok(st !== undefined && st.score >= 12, `违规分 ${st?.score} 应 ≥ 12`);
  includes(rt.ac.kickedPlayers(), 'cheat');
});

test('G05 端到端:60 秒无人 → 休眠 → 唤醒 → 状态与休眠前一致', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  const { rt, c } = newRoom(db);
  rt.join({ userId: 'owner' });
  rt.state.meta.tick = 1234;
  rt.state.meta.chunkVersions['2,3'] = 7;
  const beforeSnapshot = rt.snapshotFor('owner');

  rt.leave('owner');
  c.advance(IDLE_SLEEP_MS);
  eq(rt.checkIdleSleep(), true);
  eq(rt.status, RoomStatus.SLEEPING);
  eq(getRoom(db, 'room_alpha')?.status, RoomStatus.SLEEPING);

  rt.wake();
  eq(rt.status, RoomStatus.OPEN);
  eq(rt.state.meta.tick, 1234, '世界帧号不变');
  eq(rt.state.meta.chunkVersions['2,3'], 7, '区块版本不变');
  ok(beforeSnapshot.length > 0);
});

test('G06 端到端:16 人满房 + 1 人被踢 + 1 人重连,计数正确', () => {
  const clock = fixedClock(1000);
  const rt = new RoomRuntime({ roomId: 'big', ownerId: 'p0', clock, maxPlayers: 16 });
  for (let i = 0; i < 16; i += 1) rt.join({ userId: `p${i}` });
  eq(rt.onlineCount(), 16);

  eq(rt.kick('p0', 'p5').ok, true);
  eq(rt.onlineCount(), 15);
  ok(!rt.members.has('p5'));

  rt.disconnect('p3');
  eq(rt.onlineCount(), 14);

  clock.advance(1000);
  const back = rt.join({ userId: 'p3' });
  eq(back.ok, true);
  eq(back.resumed, true);
  eq(rt.onlineCount(), 15);

  /* 满房后新加入被拒。 */
  rt.join({ userId: 'newbie' });
  eq(rt.onlineCount(), 16);
  eq(rt.join({ userId: 'overflow' }).ok, false);
});

/* ═══════════════════════════════════════════════════════════════════════
 * H. Colyseus 装配层字段等价校验(task-13)
 *
 * 背景:`server/src/net/schema.colyseus.ts` 有 **44 个行首** `@type` 装饰器
 * (第 45 处是 `:182` 注释里的残留文本,不生效 —— 两个数都对,口径不同),
 * 装饰器在 Node strip-only 下是**运行时拒绝**(`.ts`/`.js` 都抛
 * `Invalid or unexpected token`)—— 所以**不能 import 该文件来测**。
 *
 * ⚠️ **本注释在 2026-11-12 修正过两处**(原写「45 个」+「Colyseus 未安装」):
 *   1. 「Colyseus 是 optionalDependency **未安装**」→ 实测 **已装 v0.15.57**
 *      (在 `optionalDependencies` 而非 `dependencies`,后者是 `{}` —— 只看后者会误判)。
 *      ⇒ **「不能 import」的真因只有一个:装饰器**,与包无关。原注释把两条理由并列,
 *        其中一条是错的:后来者装了包、以为能 import,会发现仍不行却不知为何。
 *      (**修法也因此不同**:缺包 `npm i` 即可;装饰器需构建步骤或改用零依赖替身。)
 *   2. 装饰器计数 44(行首,真实生效)vs 45(含 `:182` 注释残留)。
 *
 * ⚠️ **第二个独立阻塞点(同日发现,与包无关)**:本文件的依赖
 * `room.colyseus.ts:19` 用的是**命名导入** `import { Room, Client } from 'colyseus'`,
 * 而 `colyseus` 是 **CommonJS**(`type` 未设、`main: ./build/index.js`)——
 * 命名导入会抛 `Named export 'Room' not found`。实测:
 * `import { Room }` ✗ / `import c from 'colyseus'` ✓ / `import * as c` ✓。
 * ⇒ **就算把 44 处装饰器全去掉,该文件依然 import 失败。修法清单是两条,不是一条。**
 *
 * 注:`readFileSync` 文本解析的做法**本身仍然正确**(理由见下),只是给后来者的归因错了。
 * 而 `assertSchemaReady()` 在生产被 `room.colyseus.ts:73` 调用,却零测试驱动。
 *
 * 做法:**文本解析 + 集合比对**,把判据独立复现,不依赖装饰器能否执行。
 * 这不是「退而求其次」—— 它测的是**源码事实**(字段名、注解类型、生产调用点),
 * 恰恰是装饰器版本无法在测试环境里暴露的部分。
 *
 * 本组断言在 2026-11-11 首次运行时**抓到两个真实缺陷**:
 *   1. `PlayerSchema.name` 漏写 `@type` → 昵称永远同步不到客户端(静默);
 *   2. `RoomMetaSchema.tick` 多出字段 → `assertSchemaReady()` 在生产抛错,
 *      服务端起不来。两者都已修复,断言保留为回归守卫。
 * ═══════════════════════════════════════════════════════════════════════ */

/** 被测装配层源码路径。 */
const COLYSEUS_SCHEMA_PATH = join(ROOT_DIR, 'server', 'src', 'net', 'schema.colyseus.ts');
const COLYSEUS_ROOM_PATH = join(ROOT_DIR, 'server', 'src', 'net', 'room.colyseus.ts');

/** 匹配「恰好 2 空格缩进」的字段声明行:`[@type(...)] name = ...`。
 * 方法体内的赋值缩进更深(4+ 空格),自然被排除。
 * 4 个可选捕获组覆盖 4 种 `@type` 参数形态:
 *   1 字符串字面量 `'string'`
 *   2 对象字面量 `{ map: PlayerSchema }`
 *   3 数组字面量 `['string']`
 *   4 构造器引用 `RoomMetaSchema`
 * 全部不匹配时(即无注解)捕获组均为 undefined → type = null。 */
const COLYSEUS_FIELD_LINE =
  /^ {2}(?:@type\((?:'([^']*)'|(\{[^}]*\})|(\[\s*'[^']*'\s*\])|([A-Za-z_]\w*))\)\s+)?([A-Za-z_]\w*)\s*=/;

/**
 * 从 `schema.colyseus.ts` 里解析出一个 Schema 子类的实例字段。
 * 返回 `type: null` 表示该字段**没有 `@type` 注解**。
 */
function parseColyseusClass(
  source: string,
  className: string,
): { name: string; type: string | null }[] {
  const m = new RegExp(`export class ${className} extends Schema \\{([\\s\\S]*?)\\n\\}`).exec(source);
  ok(m !== null, `应能在 schema.colyseus.ts 里找到 export class ${className} extends Schema`);
  const out: { name: string; type: string | null }[] = [];
  for (const line of m![1].split('\n')) {
    const f = COLYSEUS_FIELD_LINE.exec(line);
    if (!f) continue;
    out.push({ name: f[5], type: f[1] ?? f[2] ?? f[3] ?? f[4] ?? null });
  }
  return out;
}

/** 读装配层源码(每次现读,保证断言测的是磁盘上的当前状态)。 */
function readColyseusSchema(): string {
  ok(existsSync(COLYSEUS_SCHEMA_PATH), `装配层源码应存在:${COLYSEUS_SCHEMA_PATH}`);
  return readFileSync(COLYSEUS_SCHEMA_PATH, 'utf8');
}

/** FIELD_TABLE 的 FieldType → Colyseus 类型字符串映射(与源码 COLYSEUS_TYPE 同源)。 */
const EXPECTED_COLYSEUS_TYPE: Readonly<Record<string, string>> = {
  pos: 'number',
  u8: 'uint8',
  u16: 'uint16',
  u32: 'uint32',
  i16: 'int16',
  str: 'string',
  hash: 'string',
};

/** 4 个实体类 ↔ 4 张字段表的配对。 */
const PARITY_PAIRS: readonly [string, string, () => readonly { key: string; type: string }[]][] = [
  ['PlayerSchema', 'PlayerSchema', () => FIELD_TABLE],
  ['WildlifeSchema', 'WildlifeSchema', () => WILDLIFE_FIELD_TABLE],
  ['BossSchema', 'BossSchema', () => BOSS_FIELD_TABLE],
  ['RoomMetaSchema', 'RoomMetaSchema', () => ROOM_FIELD_TABLE],
];

test('H01 装配层源码存在,且是唯一带装饰器的文件(其余文件禁装饰器)', () => {
  const src = readColyseusSchema();
  ok(src.length > 0, '源码应非空');
  /* 文件头已声明「本文件不被测试 import」。 */
  ok(src.includes('assertFieldTableParity'), '应含 assertFieldTableParity');
  ok(src.includes('assertSchemaReady'), '应含 assertSchemaReady');
  /* @colyseus/schema 是唯一外部依赖导入。 */
  ok(src.includes("from '@colyseus/schema'"), '应从 @colyseus/schema 导入');
});

test('H02 装饰器总数与逐类分布符合实测(5 个类)', () => {
  const src = readColyseusSchema();
  /* 实测:5 个类共 44 个带注解字段;另有 1 处 `@type` 出现在
   * RoomMetaSchema 的说明注释里,故字面计数为 45。 */
  const counts: Record<string, number> = {};
  for (const cls of ['PlayerSchema', 'WildlifeSchema', 'BossSchema', 'RoomMetaSchema', 'RoomSchema']) {
    const fields = parseColyseusClass(src, cls);
    counts[cls] = fields.filter((f) => f.type !== null).length;
    eq(fields.length - counts[cls], 0, `${cls} 不应存在无注解字段`);
  }
  eq(counts.PlayerSchema, 14);
  eq(counts.WildlifeSchema, 9);
  eq(counts.BossSchema, 10);
  eq(counts.RoomMetaSchema, 5);
  eq(counts.RoomSchema, 6);
  eq(Object.values(counts).reduce((a, b) => a + b, 0), 44, '五类合计 44 个带注解字段');

  /* 字面计数 = 44 个真注解 + 1 处注释提及。用注释提及数反推,
   * 防止有人在注释里多加 `@type(` 却不动代码,把这里的等式搞成巧合。 */
  const literal = [...src.matchAll(/@type\(/g)].length;
  const inComments = src.split('\n')
    .filter((l) => /^\s*(\/\*|\*|\/\/)/.test(l) && l.includes('@type(')).length;
  eq(literal, 44 + inComments, `@type 字面计数应等于真注解数(44)+ 注释提及数(${inComments})`);
  eq(inComments, 1, '注释里的 @type 提及共 1 处');
});

test('H03 【核心】PlayerSchema 的字段集合与 FIELD_TABLE 完全相等(不多不少)', () => {
  const src = readColyseusSchema();
  const declared = parseColyseusClass(src, 'PlayerSchema').map((f) => f.name);
  const expected = FIELD_TABLE.map((f) => f.key);
  eq(declared.length, expected.length, `字段数应为 ${expected.length}`);
  eq([...declared].sort(), [...expected].sort(), '字段集合应完全相等');
  /* 逐个点名,报错时能指出是哪个字段。 */
  for (const k of expected) includes(declared, k, `PlayerSchema 应含字段 ${k}`);
  for (const k of declared) includes(expected, k, `PlayerSchema 不应多出字段 ${k}`);
});

test('H04 【核心】WildlifeSchema 的字段集合与 WILDLIFE_FIELD_TABLE 完全相等', () => {
  const src = readColyseusSchema();
  const declared = parseColyseusClass(src, 'WildlifeSchema').map((f) => f.name);
  const expected = WILDLIFE_FIELD_TABLE.map((f) => f.key);
  eq(declared.length, expected.length, `字段数应为 ${expected.length}`);
  eq([...declared].sort(), [...expected].sort(), '字段集合应完全相等');
  for (const k of expected) includes(declared, k, `WildlifeSchema 应含字段 ${k}`);
});

test('H05 【核心】BossSchema 的字段集合与 BOSS_FIELD_TABLE 完全相等', () => {
  const src = readColyseusSchema();
  const declared = parseColyseusClass(src, 'BossSchema').map((f) => f.name);
  const expected = BOSS_FIELD_TABLE.map((f) => f.key);
  eq(declared.length, expected.length, `字段数应为 ${expected.length}`);
  eq([...declared].sort(), [...expected].sort(), '字段集合应完全相等');
  for (const k of expected) includes(declared, k, `BossSchema 应含字段 ${k}`);
});

test('H06 【核心】RoomMetaSchema 的字段集合与 ROOM_FIELD_TABLE 完全相等(不含 tick)', () => {
  const src = readColyseusSchema();
  const declared = parseColyseusClass(src, 'RoomMetaSchema').map((f) => f.name);
  const expected = ROOM_FIELD_TABLE.map((f) => f.key);
  eq(declared.length, expected.length, `字段数应为 ${expected.length}`);
  eq([...declared].sort(), [...expected].sort(), '字段集合应完全相等');
  /* 显式守住「帧号不在房间字段表里」这条设计决定 —— 这是本组断言
   * 首次运行时抓到的缺陷 2:多出的 tick 会让 assertSchemaReady() 抛错。 */
  ok(!declared.includes('tick'), 'RoomMetaSchema 不应含 tick(帧号走报文头)');
  ok(!expected.includes('tick'), 'ROOM_FIELD_TABLE 本就不含 tick');
});

test('H07 每个字段都有 @type 注解(缺注解 = 静默不同步)', () => {
  const src = readColyseusSchema();
  /* 这是缺陷 1 的守卫:PlayerSchema.name 原先漏写 @type,
   * Colyseus 会静默跳过未标注字段 —— 昵称永远到不了客户端。 */
  for (const [cls] of PARITY_PAIRS) {
    const fields = parseColyseusClass(src, cls);
    for (const f of fields) {
      ok(f.type !== null, `${cls}.${f.name} 缺少 @type 注解(Colyseus 会静默不同步该字段)`);
    }
  }
});

test('H08 @type 声明的类型与 FIELD_TABLE.type 的映射逐字段一致', () => {
  const src = readColyseusSchema();
  for (const [cls, , tableFn] of PARITY_PAIRS) {
    const declared = parseColyseusClass(src, cls);
    for (const spec of tableFn()) {
      const f = declared.find((x) => x.name === spec.key);
      ok(f !== undefined, `${cls}.${spec.key} 应存在`);
      const want = EXPECTED_COLYSEUS_TYPE[spec.type];
      ok(want !== undefined, `FieldType.${spec.type} 应有映射`);
      eq(f!.type, want, `${cls}.${spec.key}:FieldType.${spec.type} 应映射为 '${want}'`);
    }
  }
});

test('H09 映射表覆盖全部 7 种 FieldType,且与源码 COLYSEUS_TYPE 同源', () => {
  const src = readColyseusSchema();
  /* 断言源码里的 COLYSEUS_TYPE 与本测试的副本一致(防两处定义漂移)。 */
  const block = /const COLYSEUS_TYPE[^{]*\{([\s\S]*?)\}/.exec(src);
  ok(block !== null, '应能抽出 COLYSEUS_TYPE 块');
  const pairs = [...block![1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]] as const);
  eq(pairs.length, 7, 'COLYSEUS_TYPE 应有 7 项');
  for (const [k, v] of pairs) {
    eq(EXPECTED_COLYSEUS_TYPE[k], v, `映射 ${k} 应与源码一致`);
  }
  /* FieldType 的 7 个取值都要能被映射。 */
  const allTypes = Object.values(FieldType);
  eq(allTypes.length, 7, 'FieldType 应有 7 种');
  for (const t of allTypes) ok(EXPECTED_COLYSEUS_TYPE[t] !== undefined, `FieldType.${t} 应有 Colyseus 映射`);
});

test('H10 生产代码确实调用 assertSchemaReady()(防止有人删掉这行启动校验)', () => {
  ok(existsSync(COLYSEUS_ROOM_PATH), 'room.colyseus.ts 应存在');
  const room = readFileSync(COLYSEUS_ROOM_PATH, 'utf8');
  /* 导入 + 调用都要在。 */
  ok(room.includes('assertSchemaReady'), 'room.colyseus.ts 应引用 assertSchemaReady');
  ok(/assertSchemaReady\(\)/.test(room), '应有 assertSchemaReady() 调用');
  /* 必须在 onCreate 里调用(fail-fast 的时机)。 */
  const onCreate = /override onCreate\([\s\S]*?\n  \}/.exec(room);
  ok(onCreate !== null, '应能找到 onCreate 方法体');
  ok(onCreate![0].includes('assertSchemaReady()'), 'assertSchemaReady() 应在 onCreate 内调用(fail-fast)');
});

test('H11 assertSchemaReady 的实现保留:抛错、聚合 errs、不吞异常', () => {
  const src = readColyseusSchema();
  const body = /export function assertSchemaReady\(\)[\s\S]*?\n\}/.exec(src);
  ok(body !== null, '应保留 assertSchemaReady 实现');
  const b = body![0];
  ok(b.includes('assertFieldTableParity()'), '应调用 assertFieldTableParity()');
  ok(b.includes('errs.length > 0'), '应在有错误时判定失败');
  ok(b.includes('throw new Error'), '应抛错(fail-fast),而不是仅打印');
  /* 错误信息应带上有问题字段(便于定位)。 */
  ok(b.includes('errs.join'), '错误信息应聚合全部 errs');
});

test('H12 assertFieldTableParity 的判定逻辑完整:缺字段 + 多字段 + 表格自校验', () => {
  const src = readColyseusSchema();
  const body = /export function assertFieldTableParity\(\)[\s\S]*?\n\}/.exec(src);
  ok(body !== null, '应保留 assertFieldTableParity 实现');
  const b = body![0];
  ok(b.includes('validateFieldTable'), '应做表格自校验(bit 冲突等)');
  ok(b.includes('缺少字段'), '应检查「缺字段」方向');
  ok(b.includes('多出字段'), '应检查「多字段」方向');
  /* 四个类都要被纳入对账,一个都不能漏。 */
  for (const cls of ['PlayerSchema', 'WildlifeSchema', 'BossSchema', 'RoomMetaSchema']) {
    ok(b.includes(cls), `对账应覆盖 ${cls}`);
  }
  eq([...b.matchAll(/label: '(\w+)'/g)].length, 4, '应有 4 条对账项');
});

test('H13 装配层的字段清单与核心字段表逐类对账(独立复现 parity 判定)', () => {
  /* 不 import 装配层,而是用文本抽取独立复现 assertFieldTableParity 的判定 ——
   * 若它与核心字段表不符,本断言报出与生产相同的错误文案。 */
  const src = readColyseusSchema();
  const errs: string[] = [];
  for (const [cls, , tableFn] of PARITY_PAIRS) {
    const declared = new Set(parseColyseusClass(src, cls).map((f) => f.name));
    const table = tableFn();
    for (const spec of table) if (!declared.has(spec.key)) errs.push(`${cls} 缺少字段 ${spec.key}`);
    for (const k of declared) if (!table.some((s) => s.key === k)) errs.push(`${cls} 多出字段 ${k}(未登记在 FIELD_TABLE)`);
  }
  eq(errs, [], `装配层与字段表应完全对齐,实际 ${JSON.stringify(errs)}`);
});

test('H14 容器类 RoomSchema 的字段与协议语义一致(5 个容器 + roomId)', () => {
  const src = readColyseusSchema();
  const fields = parseColyseusClass(src, 'RoomSchema');
  const names = fields.map((f) => f.name);
  for (const k of ['roomId', 'meta', 'players', 'wildlife', 'bosses', 'dirtyChunkKeys']) {
    includes(names, k, `RoomSchema 应含 ${k}`);
  }
  eq(fields.length, 6, 'RoomSchema 应有 6 个字段');
  /* 实体容器用 MapSchema(按 id 去重 + 支持 remove),与手写协议的
   * removed 列表语义对齐 —— 这是注释里的声称,这里验源码。 */
  const body = /export class RoomSchema extends Schema \{([\s\S]*?)\n\}/.exec(src)![1];
  for (const k of ['players', 'wildlife', 'bosses']) {
    ok(new RegExp(`@type\\(\\{ map: \\w+ \\}\\)\\s+${k}\\s*=\\s*new MapSchema`).test(body),
      `${k} 应为 MapSchema(@type({ map: ... }))`);
  }
  ok(/dirtyChunkKeys\s*=\s*new ArraySchema/.test(body), 'dirtyChunkKeys 应为 ArraySchema');
});

test('H15 【故障注入守卫】字段名/注解的解析对偏移敏感,不会静默通过', () => {
  /* 本组断言全部依赖 parseColyseusClass 的文本解析。若解析器本身坏了
   * (例如正则不再匹配任何行),所有「集合相等」断言会因为两边都空而**假绿**。
   * 这里用自造的假源码验证解析器真的在抽取,并对注入的变化敏感。 */
  const fake = [
    'export class ProbeSchema extends Schema {',
    "  @type('string') alpha = '';",
    "  @type('uint8') beta = 0;",
    '  gamma = 1;',
    '}',
  ].join('\n');
  const got = parseColyseusClass(fake, 'ProbeSchema');
  eq(got.length, 3, '解析器应抽出 3 个字段(不能因为解析失败而返回空)');
  eq(got.map((f) => f.name), ['alpha', 'beta', 'gamma']);
  eq(got[0].type, 'string');
  eq(got[1].type, 'uint8');
  eq(got[2].type, null, 'gamma 无注解 → type 应为 null(而非 undefined)');

  /* 方法体里的赋值不应被当成字段。 */
  const withMethod = [
    'export class ProbeSchema extends Schema {',
    "  @type('string') alpha = '';",
    '  assign(x: { alpha: string }): void {',
    '    this.alpha = x.alpha;',
    '    const tmp = 1;',
    '  }',
    '}',
  ].join('\n');
  const got2 = parseColyseusClass(withMethod, 'ProbeSchema');
  eq(got2.length, 1, '方法体内的赋值不应被当成字段');
  eq(got2[0].name, 'alpha');

  /* 篡改字段名 → 解析结果跟着变(证明解析器不是在返回缓存/常量)。 */
  const tampered = withMethod.replace('alpha', 'ALPHA_RENAMED');
  const got3 = parseColyseusClass(tampered, 'ProbeSchema');
  eq(got3[0].name, 'ALPHA_RENAMED', '字段名变了,解析结果必须跟着变');
});

test('H16 字段表本身的完整性(bit 无冲突、升序、无重复 key)', () => {
  /* 装配层的对账依赖字段表自身正确;这里补上核心侧的守卫。 */
  for (const [cls, , tableFn] of PARITY_PAIRS) {
    const table = tableFn();
    eq(validateFieldTable(table), [], `${cls} 的字段表应无冲突`);
    const bits = table.map((f) => f.bit);
    eq(new Set(bits).size, bits.length, `${cls} bit 应互异`);
    const keys = table.map((f) => f.key);
    eq(new Set(keys).size, keys.length, `${cls} key 应互异`);
    for (let i = 1; i < table.length; i += 1) {
      ok(table[i].bit > table[i - 1].bit, `${cls} 应按 bit 升序`);
    }
  }
});

test('H17 两类定义的字段**顺序**也一致(装配层的字段顺序 = 字段表 bit 序)', () => {
  /* Colyseus 的 patch 按声明顺序编号;顺序错位虽然不会让 parity 报错,
   * 但会让 schema 的字段序号与 12 位 obj / 报文里的 bit 编号对不上,
   * 排查线上问题时极难定位。这里把顺序也固化。 */
  const src = readColyseusSchema();
  for (const [cls, , tableFn] of PARITY_PAIRS) {
    const declared = parseColyseusClass(src, cls).map((f) => f.name);
    const expected = tableFn().map((f) => f.key);
    eq(declared, expected, `${cls} 字段顺序应与字段表 bit 升序一致`);
  }
});

/* ═══════════ CR-14 U1:装配层回归(判据必须来自服务端)═══════════ */

/* 为什么单独一段:前面的 `checkInventory` 单测守的是**函数契约**,
   而 CR-14 U1 的缺陷在**装配** —— 网络层把客户端值当判据传进来。
   只补函数级测试挡不住这类回归,必须在**真实入口**(`RoomRuntime.applyInventory`)
   上钉住「客户端提供不了判据」这个事实。 */

test('CR-14 U1 装配层:凭空产出被拒(客户端无法自行扩 allowedSources)', () => {
  const rt = new RoomRuntime({ roomId: 'cr14', ownerId: 'p0', clock: fixedClock(1000) });
  rt.state.meta.tick = 1;
  rt.join({ userId: 'atk' } as never);
  (rt.state.players as { id: string; level: number }[]).push({ id: 'atk', level: 1 } as never);

  /* 客户端在 source 里塞什么都无效 —— 凭证只能由服务端 grantItemSource 授予 */
  const r = rt.applyInventory('atk', { ops: [{ itemId: 101, delta: 5, source: 'cheat' }] });
  eq(r.allowed, false, '未授予的 source 应被拒');
  eq(r.rejectCode, InventoryReject.FROM_NOTHING, '拒因应为 FROM_NOTHING');
});

test('CR-14 U1 装配层:容量由等级派生,超容量报 OVERFLOW', () => {
  const rt = new RoomRuntime({ roomId: 'cr14', ownerId: 'p0', clock: fixedClock(1000) });
  rt.state.meta.tick = 1;
  rt.join({ userId: 'atk' } as never);
  (rt.state.players as { id: string; level: number }[]).push({ id: 'atk', level: 1 } as never);

  /* capacity 必须是服务端按等级算出的值,而不是某个可传入的量 */
  eq(rt.carryCapacityOf('atk'), 8, 'Lv1 容量应为 8(8 + (L-1))');

  rt.grantItemSource('atk', 'drop:lot');
  let last: { allowed: boolean; rejectCode?: string } = { allowed: true };
  for (let i = 0; i < 12 && last.allowed; i += 1) {
    last = rt.applyInventory('atk', { ops: [{ itemId: 400, delta: 8, source: 'drop:lot' }] });
  }
  eq(last.allowed, false, '超容量应被拒');
  eq(last.rejectCode, InventoryReject.OVERFLOW, '拒因应为 OVERFLOW');
  eq(rt.authoritativeItemTotal('atk'), 8, '服务端总量应停在容量上限');
});

test('CR-14 U1 装配层:NEGATIVE 分支可达(旧版因 beforeTotal 反推而恒不可达)', () => {
  const rt = new RoomRuntime({ roomId: 'cr14', ownerId: 'p0', clock: fixedClock(1000) });
  rt.state.meta.tick = 1;
  rt.join({ userId: 'atk' } as never);
  (rt.state.players as { id: string; level: number }[]).push({ id: 'atk', level: 1 } as never);

  rt.grantItemSource('atk', 'chop:x');
  const give = rt.applyInventory('atk', { ops: [{ itemId: 200, delta: 3, source: 'chop:x' }] });
  eq(give.allowed, true, '服务端授予凭证后应放行');
  eq(rt.authoritativeItemTotal('atk'), 3, '总量应累计为 3');

  /* 关键:扣 5 而只持有 3。旧版 `beforeTotal` 由本帧 ops 反推 ⇒ after ≡ 0 ⇒ 该分支不可达 */
  const neg = rt.applyInventory('atk', { ops: [{ itemId: 200, delta: -5 }] });
  eq(neg.allowed, false, '超量扣减应被拒');
  eq(neg.rejectCode, InventoryReject.NEGATIVE, '拒因应为 NEGATIVE(证明该分支可达)');
});

test('CR-14 U1 装配层:合法操作不被误拒 + 凭证不跨 tick', () => {
  const rt = new RoomRuntime({ roomId: 'cr14', ownerId: 'p0', clock: fixedClock(1000) });
  rt.state.meta.tick = 1;
  rt.join({ userId: 'atk' } as never);
  (rt.state.players as { id: string; level: number }[]).push({ id: 'atk', level: 1 } as never);

  rt.grantItemSource('atk', 'chop:y');
  eq(rt.applyInventory('atk', { ops: [{ itemId: 300, delta: 2, source: 'chop:y' }] }).allowed, true, '合法产出应放行');
  eq(rt.applyInventory('atk', { ops: [{ itemId: 300, delta: -1 }] }).allowed, true, '合法扣减应放行');

  /* 凭证带 tick 语义:expireItemSources 后旧凭证失效 */
  rt.expireItemSources();
  const again = rt.applyInventory('atk', { ops: [{ itemId: 301, delta: 1, source: 'chop:y' }] });
  eq(again.allowed, false, '凭证过期后应被拒');
  eq(again.rejectCode, InventoryReject.FROM_NOTHING, '过期凭证应报 FROM_NOTHING');
});

/* ═══════════ WR-14 U2:移速/攻速阈值与客户端声明 ═══════════ */

/* 背景见 `docs/CHANGE_REQUESTS.md` CR-14 U2。两组断言分开:
 *   · U2-a:**已声明的设计取舍** —— 上限随客户端声明放大(有界)。这是 §7 明写的口径,
 *           因此本组把它**钉住**,而不是当成缺陷:将来真做服务端核算时,这里会变红并提示改口径。
 *   · U2-b:**真缺陷** —— 非数字声明会让钳位公式产生 NaN,`dist > NaN` 恒为 false
 *           ⇒ TELEPORT / SPEED / ATTACK_RATE 三道检查**同时失效**(比 U2 本身更严重)。
 *           该缺陷与「上限多大」无关:即便把上限设成 1.0 也照样失守。 */

test('WR-14 U2-a 声明倍率确实抬高上限(已声明设计取舍,非缺陷;有界)', () => {
  /* 这不是要修的 bug,是 §7「一律钳到上限,不自证」的后果:声明越高,上限越高。
   * 本断言把它钉住 —— 若哪天改口径为服务端核算,此处必须同步改。 */
  const tolerance = 1.25;
  const capOf = (mul: number): number => BASE_MOVE_SPEED * mul * tolerance;

  near(capOf(1.0), 5.625, 1e-9, '裸装声明 1.0 → 5.625 格/秒');
  near(capOf(2.55), 14.34375, 1e-9, '满声明 2.55 → 14.34375 格/秒');
  ok(capOf(2.55) > capOf(1.0), '上限随声明放大 —— 这正是 U2 描述的取舍');

  /* 有界:钳在 MAX_SPEED_BONUS_MUL,不会无限放大。 */
  near(maxDisplacementPerTick(2.55), maxDisplacementPerTick(1e9), 1e-12, '超过上限即被钳');
  const hardCap = BASE_MOVE_SPEED * MAX_SPEED_BONUS_MUL * tolerance;
  ok(capOf(2.55) <= hardCap + 1e-9, `上限不超过硬顶 ${hardCap} 格/秒`);
  near(capOf(2.55) / BASE_MOVE_SPEED, 3.1875, 1e-4,
    '相对裸装基线最坏 3.19 倍(有界,不是无界加速)');
});

test('WR-14 U2-b 【首要】非数字声明不得让 TELEPORT 检查失效', () => {
  /* 缺陷本体:`Math.max(0, {})` = NaN ⇒ allowed = NaN ⇒ `dist > NaN + 1e-9` 恒 false
   * ⇒ 单帧瞬移被**直接放行**。而 `{"speedMul":{}}` 经 JSON 反序列化即可到达网络层,
   * 类型标注拦不住运行时(`room.colyseus.ts:166` 的入参类型不产生运行时校验)。
   *
   * 实测只有「转数值得 NaN」的输入会让钳位失效。以下**不是**缺陷路径,不得误伤:
   *   `null` / `[]` / `true` → 分别转 0 / 0 / 1,钳位仍有效(见下一条反向对照)。 */
  for (const raw of ['{"speedMul":{}}', '{"speedMul":"abc"}']) {
    const declared = JSON.parse(raw).speedMul;
    const s = createAcState('cheat', 0, 0, 0);
    /* 单帧跳 200 格 —— 远超任何合法上限。 */
    const v = checkMove(s, { tick: 1, x: 200, y: 0, z: 0, speedMul: declared });
    eq(v.allowed, false, `${raw}:单帧跳 200 格必须被拒`);
    eq(v.violation?.kind, ViolationKind.TELEPORT, `${raw}:拒因应为 TELEPORT`);
    eq(v.corrected?.x, 0, `${raw}:应回退到权威坐标`);
  }

  /* 反向对照:合法声明下当然也拒 —— 证明上面的红不是「本来就拒」。 */
  const okState = createAcState('legal', 0, 0, 0);
  eq(checkMove(okState, { tick: 1, x: 200, y: 0, z: 0, speedMul: 1.0 }).allowed, false,
    '数值声明下同样拒(对照组)');

  /* 边界说明:以下输入**不是**缺陷路径(转数值分别为 0/0/1,钳位仍有效),
   * 修完之前它们就已是绿的 —— 钉在这里防止修法把安全输入误伤成放行。 */
  for (const safe of [null, [], true, undefined]) {
    const st = createAcState('safe', 0, 0, 0);
    eq(checkMove(st, { tick: 1, x: 200, y: 0, z: 0, speedMul: safe as number }).allowed, false,
      `安全输入 ${String(safe)} 应仍被拒(不得因修 NaN 而放行)`);
  }
});

test('WR-14 U2-b 非数字声明不得让窗口式 SPEED 检查失效', () => {
  /* 形状照搬 E03:每帧 0.30 格 —— 单帧上限 0.36 内(合法),但 6 格/秒超出窗口上限 5.625。
   * 声明为 NaN 时帧上限与窗口上限都变 NaN,两道检查同时静默放行。 */
  for (const declared of [JSON.parse('{"speedMul":{}}').speedMul, 'abc']) {
    const s = createAcState('cheat', 0, 0, 0);
    let rejected = false;
    for (let i = 1; i <= 21; i += 1) {
      advanceServerClock(s, i);   // 与 room.ts:770 同构(见 E03 长注释)
      const v = checkMove(s, { tick: i, x: i * 0.30, y: 0, z: 0, speedMul: declared });
      if (!v.allowed) { rejected = true; break; }
    }
    ok(rejected, `声明 ${JSON.stringify(declared)}:持续 0.30 格/帧(6 格/秒)应被窗口式检测抓到`);
    ok(s.violations.some((v) => v.kind === ViolationKind.SPEED),
      `声明 ${JSON.stringify(declared)}:应有 SPEED 违规`);
  }

  /* 对照组:同样的位移形状,声明合法数值 1.0 时必须被拒 —— 证明上面的红来自 NaN 而非位移本身。 */
  const ctl = createAcState('legal', 0, 0, 0);
  let ctlRejected = false;
  for (let i = 1; i <= 21; i += 1) {
    advanceServerClock(ctl, i);
    const v = checkMove(ctl, { tick: i, x: i * 0.30, y: 0, z: 0, speedMul: 1.0 });
    if (!v.allowed) { ctlRejected = true; break; }
  }
  ok(ctlRejected, '合法声明 1.0 下同一位移形状应被拒(对照组)');
});

test('WR-14 U2-b 非数字声明不得让 ATTACK_RATE 检查失效', () => {
  for (const declared of [JSON.parse('{"claimedBonus":{}}').claimedBonus, 'abc']) {
    const s = createAcState('cheat', 0);
    checkAttack(s, 0, 0);
    let rejected = false;
    /* 每帧攻击(间隔 1 帧),基线需 8 帧。声明为 NaN 时 minInterval 变 NaN,`< NaN` 恒 false。 */
    for (let t = 1; t <= 10; t += 1) {
      const v = checkAttack(s, t, declared);
      if (!v.allowed) { rejected = true; break; }
    }
    ok(rejected, `声明 ${JSON.stringify(declared)}:每帧攻击应被拒`);
    ok(s.violations.some((v) => v.kind === ViolationKind.ATTACK_RATE),
      `声明 ${JSON.stringify(declared)}:应有 ATTACK_RATE 违规`);
  }

  /* 对照组:合法数值同样拒。 */
  const s2 = createAcState('legal', 0);
  checkAttack(s2, 0, 0);
  eq(checkAttack(s2, 1, 0).allowed, false, '数值声明下每帧攻击也拒(对照组)');
});

test('WR-14 U2-b 经真实入口 `applyMove` / `applyAttack` 同样挡住', () => {
  /* 函数级之外再钉装配层:证明缺陷能穿过 RoomRuntime 到达玩家状态。 */
  const rt = new RoomRuntime({ roomId: 'wr14', ownerId: 'p0', clock: fixedClock(1000) });
  rt.join({ userId: 'cheat' });

  const badMul = JSON.parse('{"speedMul":{}}').speedMul;
  const mv = rt.applyMove('cheat', { tick: 1, x: 200, y: 0, z: 0, speedMul: badMul });
  eq(mv.allowed, false, 'applyMove 必须挡住非数字声明的瞬移');
  eq(mv.violation?.kind, ViolationKind.TELEPORT);
  eq(rt.playerState('cheat')?.x, 0.5, '实体坐标不应被改(出生点 0.5)');

  const badBonus = JSON.parse('{"claimedBonus":{}}').claimedBonus;
  eq(rt.applyAttack('cheat', badBonus).allowed, true, '首次攻击放行');
  eq(rt.applyAttack('cheat', badBonus).allowed, false,
    '同一 tick 二次攻击必须被拒(非数字声明不豁免攻速)');
});

test('WR-14 U2-b 合法声明与缺省仍有原有行为(未误伤)', () => {
  /* 非有限值的修复只应影响「产生 NaN」的输入;其余路径行为必须不变。 */
  near(maxDisplacementPerTick(1), 4.5 * DT * 1.6, 1e-9, '默认倍率 1');
  near(maxDisplacementPerTick(2.55), maxDisplacementPerTick(2.55), 1e-12, '数值声明原样');
  near(maxDisplacementPerTick(Number.POSITIVE_INFINITY), maxDisplacementPerTick(2.55), 1e-12,
    'Infinity 仍被钳到上限(原本就正确,不得回归)');
  near(maxDisplacementPerTick(0), 0, 1e-12, '声明 0 → 0');

  const s = createAcState('legal', 0, 0, 0);
  const perTick = BASE_MOVE_SPEED * DT;
  let reported = 0;
  for (let i = 1; i <= 40; i += 1) {
    advanceServerClock(s, i);   // 与 room.ts:770 同构(见 E03 长注释)
    if (!checkMove(s, { tick: i, x: i * perTick, y: 0, z: 0 }).allowed) reported += 1;
  }
  eq(reported, 0, '合法移速不受影响');
});

test('WR-14 U2-b 口径一致:实现注释不再声称服务端自行核算', () => {
  /* 这一条测的是**注释**这个制品本身(故读源码文本),因为 U2 的病灶之一
   * 就是注释与 §7 口径矛盾。注释不在行为层可测,只能对其文本断言。 */
  const src = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'anticheat.ts'), 'utf8');
  ok(!src.includes('服务端会与服务端自己的账比对'),
    '`MoveIntent.speedMul` 的旧注释(声称服务端自行核对)必须已改掉');

  /* 引用标错修正:移速 +10% 的出处是手册 729,不是 719/731。
   * 注意:文档里**记录这个错误**时会出现该字样,故不能断言「全文不含」——
   * 要断言的是它**不再被当作取值来源**。 */
  ok(!/719\/731 移速/.test(src), 'MAX_SPEED_BONUS_MUL 注释不得再把移速出处写作 719/731');
  ok(src.includes('729'), '应改为手册 729(夜影吸血蝙蝠斗篷,移速 +10%)');

  /* 新注释必须说明「钳位而非自证」这条口径,与 §7 一致。 */
  ok(/钳|不自证/.test(src), '注释应写明钳位/不自证口径');

  /* 文档同源:参数表里的取值来源必须是 729,不得再是 719/731。 */
  const doc = readFileSync(join(ROOT_DIR, 'docs', 'WS-07-net-persist.md'), 'utf8');
  ok(!/719\/731 移速/.test(doc), '文档参数表不得再把移速出处写作 719/731');
  ok(doc.includes('729'), '文档应引用手册 729');
  /* §7 口径说明必须存在(U2 澄清落点),否则口径又只剩注释一处。 */
  ok(doc.includes('不自证'), '§7 应保留「不自证」口径');
  ok(/装备数据|无装备槽/.test(doc), '§7 应说明服务端为何无法自行核算(缺装备数据)');
});

/* ═══════════ task-37:「生产零引用」的主人归属判定 ═══════════ */

/* 背景:Lead 的 `orphan-audit.ts` 把「除自身外只有 `tests/**` 引用」判为欠账。
 * 判定后发现该判据混了两种不同的问题,本组把结论钉住(理由与行号见
 * `tests/WS-FND-03.test.ts` 的 F1~F6 与 docs 说明)。 */

/** 某源码文件里是否以 **import 语句** 引用了 target(路径字样 + 语句形态双判)。 */
function importsTarget(file: string, target: string): boolean {
  for (const l of readFileSync(join(ROOT_DIR, file), 'utf8').split('\n')) {
    if (!l.includes(target)) continue;
    if (/^\s*import\b|await\s+import\(|^\s*\}\s*from\s*['"]/.test(l)) return true;
  }
  return false;
}

test('task-37 判定1:`memory_db.ts` 是**测试替身**,不该按「欠账」处置', () => {
  /* 它是 `DbLike` 的第二个实现 —— `repo.ts:35` 定义接口,`driver.sqlite.ts:125`
   * 与 `memory_db.ts:96` 是两个实现。生产走 sqlite,测试走内存,这是**架构意图**
   * (memory_db.ts:4 自述「用途:测试与本地冒烟」)。
   * 关键:门禁 `verify.ts:2797` 真的**用它**做双后端语义对照 —— 它有活干。 */
  const gateUsesIt = readFileSync(join(ROOT_DIR, 'scripts', 'verify.ts'), 'utf8')
    .includes("await import('../server/src/db/memory_db.ts')");
  ok(gateUsesIt, '门禁真的 import 了 memory_db(它是「门禁在用」而非「没人用」)');

  /* 两个实现同名接口 —— 证明它是**替身**而不是漏接的生产件。 */
  const memSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'db', 'memory_db.ts'), 'utf8');
  ok(/implements\s+DbLike/.test(memSrc), 'memory_db 实现 DbLike 接口(是替身而非孤儿)');
  const drvSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'db', 'driver.sqlite.ts'), 'utf8');
  ok(/implements\s+DbLike/.test(drvSrc), 'driver.sqlite 实现同一 DbLike(SQLite 侧)');

  /* 接口定义在生产模块里,两个实现都依赖它 —— 生产侧确实「知道」这个抽象。 */
  const repoSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'db', 'repo.ts'), 'utf8');
  ok(/export\s+interface\s+DbLike/.test(repoSrc), 'DbLike 定义在生产模块 repo.ts:35');

  /* 生产侧引用 DbLike(经结构化类型注入)证明抽象是活的。 */
  for (const f of ['server/src/net/room.ts', 'server/src/sim/world_sim.ts',
    'server/src/db/driver.sqlite.ts', 'server/src/net/room.colyseus.ts']) {
    ok(importsTarget(f, '/db/repo.ts') || importsTarget(f, './repo.ts'),
      `${f} 从 repo.ts 取 DbLike(生产侧依赖该抽象)`);
  }
});

test('task-37 判定2:`baseline.ts` 的主人是**门禁**,Lead 的口径确实错了', () => {
  /* 关键事实:`verify.ts:3212` 是**代码级**动态 import(不是注释),
   * 且返回值被真正使用(`:3220 mod.diffBaseline(mod.readBaseline())`)。
   * 另有 `content-lock.ts:22` 与 `extension-drill.ts:42` 两处 import。
   * 故它是**门禁模块** —— 运行时不调它是**正确**的,不该算运行时欠账。 */
  const vSrc = readFileSync(join(ROOT_DIR, 'scripts', 'verify.ts'), 'utf8');
  ok(vSrc.includes("await import('../server/src/content/baseline.ts')"),
    'verify.ts 以代码级动态 import 引 baseline.ts(:3212)');
  ok(vSrc.includes('mod.diffBaseline(mod.readBaseline())'),
    '且真的调用了它的函数(:3220)—— 不是只 import 不用');

  ok(importsTarget('scripts/content-lock.ts', 'content/baseline.ts'),
    'content-lock.ts 也 import 它(:22)');
  ok(importsTarget('scripts/extension-drill.ts', 'content/baseline.ts'),
    'extension-drill.ts 也 import 它(:42)');

  /* 反向:生产侧确实零引用 —— 这是**预期**的(内容锁不是运行时职责)。 */
  let prodRefs = 0;
  for (const f of ['server/src/net/room.ts', 'server/src/net/room.colyseus.ts',
    'server/src/sim/world_sim.ts']) {
    if (importsTarget(f, 'content/baseline.ts')) prodRefs += 1;
  }
  eq(prodRefs, 0, '生产侧零引用属预期(运行时不做内容锁比对)');
});

test('task-37 判定3:把 `scripts/**` 并入「生产侧」会**掩盖**真实欠账', () => {
  /* Lead 提的修法(把 scripts/** 算生产侧)会带来方向性危险:
   * 模块只要「被某个门禁读了一下」就从缺账里消失,而它**运行时仍不执行**。
   * 门禁覆盖缺失 与 运行时功能缺失 是**两种不同的缺陷**,不能合并成一条判据。
   *
   * ⚠️ **本组曾以 `cooking.ts` 作为例子并硬编码「生产侧零引用」——
   * 那是个会过期的断言。2026-11-12 `task-39` 把 cooking.ts 接进生产后它变红。
   * 断言必须钉**原理**(存在这样的模块),而不是钉**某个具体模块的当前状态**。 */
  /* ⚠️ **本组不得点名任何具体模块**。它曾以 `cooking.ts` 举例并硬编码
   * 「生产侧零引用」—— 2026-11-12 `task-39` 把它接进生产后断言变红。
   * 点名 = 把断言绑在某个模块的**当前状态**上,那个状态本来就会变。
   * 正确做法:断言 **「这类模块的集合非空」** 这个纯原理。 */

  /* 原理:「被门禁引用但生产零引用」的模块**集合非空**。
   * 只要该集合非空,「把 scripts/** 并入生产侧」就一定会掩盖掉欠账 ——
   * 这是集合层面的性质,与集合里有谁无关。 */
  const vSrc37 = readFileSync(join(ROOT_DIR, 'scripts', 'verify.ts'), 'utf8');
  const wlKeys = [...vSrc37.matchAll(/\['((?:server|client)\/src\/[^']+)',\s*'/g)].map((m) => m[1]!);
  ok(wlKeys.length > 0, `从白名单取到待判定模块(${wlKeys.length} 条)`);

  const scriptFiles = listTs(join(ROOT_DIR, 'scripts'));
  const prodFiles = [
    ...listTs(join(ROOT_DIR, 'server', 'src')),
    ...listTs(join(ROOT_DIR, 'client', 'src')),
  ];

  const gateOnly: string[] = [];
  for (const mod of wlKeys) {
    /* 用路径尾部(去掉 <side>/src/ 前缀)匹配 import 语句。 */
    const tail = mod.replace(/^(?:server|client)\/src\//, '');
    const gateRef = scriptFiles.some((f) => importsTarget(f, tail));
    const prodRef = prodFiles.some((f) => importsTarget(f, tail));
    if (gateRef && !prodRef) gateOnly.push(mod);
  }

  ok(gateOnly.length > 0,
    `“仅被门禁引用、生产零引用”的模块必须非空(否则掩盖风险不存在)。`
    + `实测 ${gateOnly.length} 个:${gateOnly.slice(0, 4).join(', ')}`);
});

/** 列出目录下所有 .ts 文件(相对 ROOT_DIR 的路径),跳过 node_modules 与临时脚本。 */
function listTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e.startsWith('_')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) listTs(p, acc);
    else if (e.endsWith('.ts')) acc.push(p.slice(ROOT_DIR.length + 1).split('\\').join('/'));
  }
  return acc;
}

test('task-37 判定4:`logistics.ts` 已被生产引用,应从清单移出', () => {
  /* `orphan-audit.ts` 自己的自检已报「已可达,应移出」。
   * 依据:`world_sim.ts:48-59` 以**值导入**取 `tickLogistics` / `loadConveyor`。
   *
   * ⚠ 断言必须解析 **import 块本身**,不能用 `/tickLogistics/.test(src)` ——
   * 后者会被方法名 `tickLogisticsStep`(:1316)或注释命中而**恒真**,
   * 属「同义反复」。下面的 importValueNames 只取 import 语句里的标识符。 */
  const wsSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8');
  ok(importsTarget('server/src/sim/world_sim.ts', 'wiring/logistics.ts'),
    'world_sim.ts import 了 logistics.ts(:48-59)');

  const imported = importValueNames(wsSrc, '../wiring/logistics.ts');
  ok(imported.includes('tickLogistics'),
    `以**值**导入 tickLogistics(实际导入值:${imported.join(', ') || '无'})`);
  ok(imported.includes('loadConveyor'),
    `以**值**导入 loadConveyor(实际导入值:${imported.join(', ') || '无'})`);
  /* 反例:类型导出不算「运行时加载该模块」—— strip-only 下会被擦掉。 */
  ok(!imported.some((n) => n.startsWith('type ')),
    '导入列表里没有残留的裸 `type X`(类型项应已剔出值列表)');
});

/**
 * 抽出 `from '...spec'` 那个 import 块里的**值**导入标识符。
 * 只解析 import 语句本身,不扫全文 —— 避免被方法名/注释命中而恒真。
 */
function importValueNames(src: string, spec: string): string[] {
  /* 逐个 import 语句扫描,而不是一个跨行贪婪正则 —— 后者会从**更早**的
   * import 块一路吃到本块(`[^}]` 会跨越中间那些 `}`)。 */
  const lines = src.split('\n');
  const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`from\\s*['"][^'"]*${esc}['"]`).test(lines[i]!)) continue;
    /* 已经在一行里闭合(`import { a, b } from '...'`)。 */
    const oneLine = /import\s*\{([^}]*)\}/.exec(lines[i]!);
    if (oneLine) return splitNames(oneLine[1]!);
    /* 多行形态:向上找最近的 `import {`。 */
    for (let j = i - 1; j >= 0 && i - j < 30; j -= 1) {
      const m = /import\s*\{/.exec(lines[j]!);
      if (!m) continue;
      const block = lines.slice(j, i + 1).join('\n');
      const inner = /\{([\s\S]*)\}/.exec(block);
      return inner ? splitNames(inner[1]!) : [];
    }
  }
  return [];
}

function splitNames(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 0 && !x.startsWith('type ') && !x.startsWith('//'));
}

test('task-37 判定5:`handshake.ts` 是**真欠账**,但接线被 3 个前提阻塞', () => {
  /* 它是三个模块里唯一「谁都不引」的:production 0 / scripts 0。
   * 判定为真欠账 —— 但**不能直接接线**,理由是可实测的: */
  const hSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'content', 'handshake.ts'), 'utf8');

  /* 前提1:生产 join 签名里没有承载 contentClaim 的位置。 */
  const roomSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.ts'), 'utf8');
  ok(/join\(input:\s*\{\s*userId: string;/.test(roomSrc),
    'room.ts:369 的 join 入参无 contentClaim 位');
  ok(!/contentClaim/.test(roomSrc), 'room.ts 完全不提 contentClaim');

  /* 前提2:默认策略是 STRICT,而 STRICT 对「未提供指纹」是拒绝。 */
  ok(/DEFAULT_CONTENT_POLICY[^=]*=\s*ContentPolicy\.STRICT/.test(hSrc),
    '默认策略为 STRICT(handshake.ts:90)');
  const strictNull = exactSameRejectsNull();
  ok(strictNull, 'STRICT + 无指纹 ⇒ 拒绝进场(故无条件接线会让所有客户端进不来)');

  /* 前提3:客户端没有网络层,发不出声明。 */
  const mainSrc = readFileSync(join(ROOT_DIR, 'client', 'src', 'main.ts'), 'utf8');
  ok(!/WebSocket|colyseus|fetch\(/.test(mainSrc),
    'client/src/main.ts 无任何网络能力 —— 无法发送 contentClaim');
});

/** 复刻 handshake 的 STRICT-无指纹分支(纯函数,避免 import 其模块带来的耦合)。 */
function exactSameRejectsNull(): boolean {
  const src = readFileSync(join(ROOT_DIR, 'server', 'src', 'content', 'handshake.ts'), 'utf8');
  /* 该分支必须存在且返回 ok:false。 */
  return /if \(!claim[\s\S]{0,400}?ok: false/.test(src);
}

test('task-37 判定6:两个目标模块在**两套清单**里的口径必须一致', () => {
  /* `verify.ts` 的 `UNREACHABLE_EXEMPT`(判据=从 PROD_ENTRIES 不可达)
   * 与 `orphan-audit.ts` 的 `ORPHAN_KNOWN`(判据=只有 tests/** 引用)
   * 是**两套判据**。同一模块在两套里结论不同 ⇒ 无法判断该信哪个
   * (这正是 task-34 要记入 PROGRESS 的教训之一)。 */
  const vSrc = readFileSync(join(ROOT_DIR, 'scripts', 'verify.ts'), 'utf8');
  const aSrc = readFileSync(join(ROOT_DIR, 'scripts', 'orphan-audit.ts'), 'utf8');

  for (const mod of ['server/src/db/memory_db.ts', 'server/src/content/baseline.ts']) {
    ok(vSrc.includes(`'${mod}'`), `${mod} 在 verify 白名单里`);
    ok(aSrc.includes(`'${mod}'`), `${mod} 在 orphan 清单里`);
  }

  /* 反例证明两套判据确实会分叉:`driver.sqlite.ts` 在 verify 白名单里,
   * 却**不在** orphan 清单里(因为它被 verify 自己 import 了)——
   * 同一文件两套结论相反,这就是「两套词法判定互相矛盾」。 */
  ok(vSrc.includes("'server/src/db/driver.sqlite.ts'"), 'driver.sqlite 在 verify 白名单');
  ok(!aSrc.includes("['server/src/db/driver.sqlite.ts'"), '但**不在** orphan 清单');
});

/* ═══════════ task-40:prediction.ts 的归属判定与搬迁 ═══════════ */

test('task-40 判定:prediction 是**客户端**模块,已搬到 client/src/net/', () => {
  /* 判定依据(四条,task-40 任务书列的三条 + 我补的依赖判据):
   *   1. 文件自述「客户端预测…立即出画面」(读源码断言,防有人写回服务端)
   *   2. 它要的是**服务端权威快照** ⇒ 服务端自己是权威,不需要 reconcile 自己
   *   3. 服务端入口 `room.ts` 只**产出**快照,不含 predictStep/reconcile/Interpolator
   *   4. 它只依赖 `shared/`(唯一 import),不依赖 server/src ⇒ 可自由搬迁
   * 结论:放 `server/src/net/` 是**放错位置**,不是「漏接线」。 */

  /* 1. 搬迁结果:文件在客户端侧,且服务端侧已无此文件。 */
  ok(existsSync(join(ROOT_DIR, 'client', 'src', 'net', 'prediction.ts')),
    'prediction.ts 位于 client/src/net/(搬迁已完成)');
  ok(!existsSync(join(ROOT_DIR, 'server', 'src', 'net', 'prediction.ts')),
    'server/src/net/prediction.ts 已不存在(没有留下副本)');

  /* 2. 依赖判据:唯一 import 是 shared/,故搬迁不牵出依赖链。
   *    ⚠ 断言要解析 **import 语句本身**,不能用 /shared/ 之类宽词 ——
   *    注释里出现「shared」会让断言恒真(同义反复,task-25 的教训)。 */
  const predSrc = readFileSync(join(ROOT_DIR, 'client', 'src', 'net', 'prediction.ts'), 'utf8');
  const predImports = predSrc.split('\n').filter((l) => /^\s*import\s/.test(l));
  eq(predImports.length, 1, '它只有 1 条 import(依赖面极窄)');
  ok(/from\s+'\.\.\/\.\.\/\.\.\/shared\//.test(predImports[0]!),
    `唯一依赖是 shared/(实际:${predImports[0]!.trim().slice(0, 70)})`);
  ok(!predImports.some((l) => /server\//.test(l)),
    '不依赖 server/src ⇒ 搬迁未带出依赖链');

  /* 3. 服务端侧确实不用它 —— 这是「放错位置」的正面证据。 */
  const roomSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.ts'), 'utf8');
  ok(/snapshotFor/.test(roomSrc), 'room.ts **产出**快照(snapshotFor)');
  for (const fn of ['predictStep', 'reconcile', 'Interpolator']) {
    ok(!roomSrc.includes(fn),
      `room.ts 不含 ${fn} ⇒ 服务端不该预测自己已是权威的东西`);
  }

  /* 4. 搬迁后**仍不可达**:客户端尚无网络层,没人调用它。
   *    所以白名单条目**保留**,只改理由(不是摘除)。 */
  const mainSrc = readFileSync(join(ROOT_DIR, 'client', 'src', 'main.ts'), 'utf8');
  ok(!mainSrc.includes('prediction'),
    'client/src/main.ts 未 import prediction ⇒ 搬迁后**仍不可达**');
  ok(!/WebSocket|colyseus|fetch\(/.test(mainSrc),
    '客户端仍无网络层 ⇒ 它等的是「客户端网络层」,不是「服务端接线」');
});

/* 注:「旧路径必须从两套清单消失」**不在本套件断言** —— 理由有二:
 *   1. 那两处清单归 Lead / coop-party 改(不在 task-40 写域);
 *      在此断言会让共享门禁在他人收口前**持续变红**,挡住所有队友。
 *   2. **不必重复**:`verify.ts` 的白名单自检已经查「文件不存在」
 *      (`checkReachability` 的 `stale.push(rel + '(文件不存在)')`),
 *      搬迁后它会自己报出 `server/src/net/prediction.ts(文件不存在)`。
 *      在此再断言一遍属于同一判据的第二套词法 —— 正是本仓已发生过
 *      「两套词法互相矛盾」的教训。 */

/* ═══ task-38:「动作面」缺陷 —— 授权存在,执行不存在 ═══ */

/* 这一类缺陷**两套清单都查不出**,因为它不是「模块不可达」:
 * `room.ts` 可达、`authorize` 可达、`RoomAction` 可达 —— 全都可达。
 * 缺的是**「被授权之后的那一步」**。
 *
 * 判据不是可达性,而是**「授权数量 vs 执行数量」的落差**。
 * 门禁查不到「声明了 22 个动作、只有 3 个能真的发生」这种形态。 */

test('task-38 【真缺陷】RoomAction 声明 22 个动作,生产只有 3 条通道能改变世界', () => {
  /* ① 动作面:声明了多少 */
  const declared = Object.values(RoomAction);
  eq(declared.length, 22, 'RoomAction 声明 22 个动作');

  /* ② 通道面:客户端真实能发的消息 */
  const roomColyseus = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.colyseus.ts'), 'utf8');
  const messages = [...roomColyseus.matchAll(/this\.onMessage\('(\w+)'/g)].map((m) => m[1]!);
  eq(messages.join(','), 'move,attack,inventory,action',
    '客户端消息面恰好 4 条');

  /* ③ ★ 核心:其中 'action' **只验权限,不执行动作**。
   *    证明方式:该 handler 的函数体里除 authorize 外**没有第二个 runtime 调用**。 */
  const actionHandler = /onMessage\('action'[\s\S]*?\n    \}\);/.exec(roomColyseus)![0];
  includes(actionHandler, 'authorize', "action handler 调 authorize");
  const otherCalls = [...actionHandler.matchAll(/this\.runtime\.(\w+)\s*\(/g)]
    .map((m) => m[1]!).filter((n) => n !== 'authorize');
  eq(otherCalls.length, 0,
    `action handler 除 authorize 外无其它 runtime 调用 ⇒ 授权后**没有执行者**`
    + `(若不为 0,实际调用:${otherCalls.join(', ')})`);
  ok(!/else/.test(actionHandler),
    'action handler 没有 else 分支 ⇒ allowed=true 时**静默返回**,连回执都没有');

  /* ④ 三条真正生效的通道作对照 —— 证明「通道」这个概念本身是可行的。 */
  const performing: string[] = [];
  for (const m of messages) {
    if (m === 'action') continue;
    const seg = new RegExp(`onMessage\\('${m}'[\\s\\S]*?\\n    \\}\\);`).exec(roomColyseus)![0];
    const call = /this\.runtime\.(\w+)\s*\(/.exec(seg);
    if (call) performing.push(`${m}→${call[1]}`);
  }
  eq(performing.length, 3,
    `能改变世界的通道恰好 3 条:${performing.join(', ')}`);
  for (const want of ['applyMove', 'applyAttack', 'applyInventory']) {
    ok(performing.some((p) => p.endsWith(want)), `${want} 在生效通道里`);
  }
});

test('task-38 【真缺陷】authorize 是**纯判定**:房主被允许全部 22 个动作,状态却零变化', () => {
  /* ★ 这是「静默空操作」的运行时实证 —— 不是读代码推断的。
   * 若无此断言,「22 个动作被允许」会被误读成「22 个功能可用」。 */

  const c = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: 't38_action', ownerId: 'owner', clock: c.clock });

  const a = rt.join({ userId: 'owner' });
  eq(a.ok, true, '房主加入');
  eq(a.role, RoomRole.OWNER, '房主角色是 OWNER');

  /* ① 房主**被允许**全部动作 —— 权限系统看起来完全可用。 */
  const declared = Object.values(RoomAction);
  const allowedList = declared.filter((act) => rt.authorize('owner', act).allowed);
  eq(allowedList.length, declared.length,
    `OWNER 被允许全部 ${declared.length} 个动作(权限系统自身是完整的)`);

  /* ② ★ 但把它们**全跑一遍**,权威状态**一个字节都不变**。
   *    用序列化长度作指纹:`cloneState()` 是纯数据快照,能反映任何字段变化。 */
  const before = JSON.stringify(rt.cloneState());
  for (const act of declared) rt.authorize('owner', act);
  const after = JSON.stringify(rt.cloneState());
  eq(JSON.stringify(rt.cloneState()), before,
    'authorize 无副作用(纯查表)—— 是事实,但**不足以**推出「无执行层」');

  /* 2b ★ 真正的支点:成功分支为空。`if (!gate.allowed) reject;` 之后**再无语句**。
   *    (我第一版把「2a 的零变化」当结论 —— 那是错的证据链,mob-boss-ai 指出、
   *     我复核后确认成立:`authorize` 是纯函数,纯函数当然不改状态。
   *     更糟:若有人给 action 加真执行却仍让 authorize 保持纯,旧断言会**照样绿**。) */
  const roomColyseus2 = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.colyseus.ts'), 'utf8');
  const actionBody = /onMessage\('action'[\s\S]*?\n    \}\);/.exec(roomColyseus2)![0];
  const codeLines2 = actionBody.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\/[\/*]|^\*/.test(l));
  /* ⚠️ 期望值是 **4** 不是 3 —— 我第一版写 3 并失败:
   *    handler 的代码行是「onMessage 头 / authorize / reject / `});` 收尾」。
   *    断言写错时**先怀疑自己**:实测打印后才定的这个数。 */
  eq(codeLines2.length, 4,
    `action handler 只有 4 行代码(onMessage 头 / authorize / reject / 收尾)`
    + ` ⇒ 成功分支确为空(实际 ${codeLines2.length} 行:${codeLines2.map((l) => l.slice(0, 30)).join(' ‖ ')})`);

  /* ③ 对照组:applyMove 立刻改变状态 —— 证明「(2) 的零变化」是因为
   *    authorize 不执行,而不是因为快照机制不敏感。
   *    ⚠️ 两点实测踩坑:
   *      a) `cloneState().players` 是**数组**(不是 Map),元素含 `id`。
   *      b) 位移必须**合法**:反作弊上限 `maxDisplacementPerTick() ≈ 0.36`,
   *         我第一版写 `x0 + 5` 被卡掉,于是「x 没变」——**那会让对照组自证失败**,
   *         误得出「快照机制不敏感」的反向结论。 */
  rt.join({ userId: 'p2' });
  type Snap = { players: { id: string; x: number }[] };
  const findX = (): number => {
    const s = rt.cloneState() as unknown as Snap;
    const row = s.players.find((q) => q.id === 'p2');
    ok(row !== undefined, '能在快照里按 id 找到 p2');
    return row!.x;
  };
  const x0 = findX();
  const step = maxDisplacementPerTick() * 0.5;   /* 半个上限,确保合法 */
  const mv = rt.applyMove('p2', { tick: 1, x: x0 + step, y: 0.5, z: 0 });
  eq(mv.allowed, true, `位移 ${step.toFixed(4)} 在上限内,反作弊放行`);
  const x1 = findX();
  ok(x1 !== x0,
    `applyMove 把 x 从 ${x0} 改到 ${x1} ⇒ 快照机制是敏感的,`
    + `所以上面的「零变化」是真结论,不是断言写错`);

  /* ④ 第二个敏感性对照:`meta` 分区也在快照里,且真能被驱动。
   *    这同时是 task-38 的另一条证据:`partyMode` **可驱动**,
   *    而 `partyTimer` / `scoreA` / `scoreB` **从不被驱动**(全仓只在
   *    schema.ts 内出现,无任何赋值点)。 */
  type Meta = { meta: { partyMode: number; partyTimer: number; scoreA: number; scoreB: number } };
  const metaBefore = (rt.cloneState() as unknown as Meta).meta;
  eq(metaBefore.partyMode, 0, '初始 partyMode = 0(NONE)');
  eq(metaBefore.partyTimer, 0, 'partyTimer 初始 0');
  rt.setPartyModeBy('owner', PartyMode.PAINT_WAR);
  const metaAfter = (rt.cloneState() as unknown as Meta).meta;
  eq(metaAfter.partyMode, Object.values(PartyMode).indexOf(PartyMode.PAINT_WAR),
    `setPartyModeBy 真的改了快照里的 partyMode(${metaBefore.partyMode} → ${metaAfter.partyMode})`
    + ` ⇒ meta 分区也在快照覆盖内`);
  /* ★ 但计分与计时**从来不跟着动** —— 这就是「有字段、无运行时」的实证。 */
  eq(metaAfter.partyTimer, 0, 'partyTimer 仍为 0 ⇒ 从无代码驱动它');
  eq(metaAfter.scoreA, 0, 'scoreA 仍为 0 ⇒ 从无代码驱动它');
  eq(metaAfter.scoreB, 0, 'scoreB 仍为 0 ⇒ 从无代码驱动它');
});

test('task-38:taming/modes 需要的动作**权限标签已存在**,缺的只是执行者', () => {
  /* 这条把 task-38 的「暂不接」判据精确化。
   * 我原先与 mob-boss-ai 都判「等 US2(room 持有 sim)」,
   * 但更精确的说法是:**等待「动作执行管线」这一层** ——
   * 权限位早就定义好了,连房主都已被授权,唯独没有执行者。 */
  const declared = Object.values(RoomAction);

  /* 驯服:taming.ts 若要被驱动,需要一个「繁殖/驯服」动作的入口。 */
  ok(declared.includes(RoomAction.BREED_TAME),
    'RoomAction.BREED_TAME **已定义** ⇒ 驯服不是「没人想过」');

  /* 派对:modes.ts 同理。 */
  ok(declared.includes(RoomAction.START_PARTY), 'RoomAction.START_PARTY 已定义');
  ok(declared.includes(RoomAction.SET_PARTY_MODE), 'RoomAction.SET_PARTY_MODE 已定义');

  /* 而这三个都**没有执行者**(由 verify.ts 的 ACTION_PERMISSION 定义域可证:
   * 它们只有「需要哪个权限位」的登记,没有对应的执行方法)。 */
  const roomSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.ts'), 'utf8');
  for (const missing of ['breedTame', 'startParty', 'beginPartyMode']) {
    ok(!new RegExp(`\\b${missing}\\s*\\(`).test(roomSrc),
      `room.ts 没有 ${missing}() ⇒ 该动作无执行者`);
  }

  /* ⇒ 结论固化:动作**声明**数远大于**可执行**数。这个落差是本缺陷的度量。 */
  const executable = ['MOVE', 'ATTACK', 'PLACE_BLOCK', 'BREAK_BLOCK', 'PICKUP_ITEM',
    'DROP_ITEM', 'CRAFT', 'USE_ALCHEMY_FURNACE', 'OPEN_CHEST', 'USE_OWN_CHEST', 'SLEEP',
    'START_PARTY', 'SET_ROOM_ACCESS', 'SET_PARTY_MODE', 'KICK_MEMBER', 'SET_MEMBER_ROLE',
    'RESET_WORLD', 'CLOSE_ROOM', 'MODIFY_TOWN', 'PLACE_AUTOMATION', 'WIRE_EDIT', 'BREED_TAME'];
  eq(executable.length, declared.length, '逐条枚举覆盖全部动作(防止未来加动作时漏登记)');
});

/* ═══ task-38:「可达 ≠ 可跑」—— 生产入口可跑性的**结构**判据 ═══ */

/* 这一类缺陷两套清单都查不出:模块**可达**(甚至是生产入口),却**无法加载**。
 *
 * ⚠️ 本组用**静态**判据,不 `await import()` —— 实测发现动态 import **不是安全探针**:
 * `server/src/sim/demo.ts` 的顶层会**直接跑 200 帧模拟并打印整张报告**
 * (它是 `npm run sim` 的入口,顶层即副作用)。在测试里 import 它会真的跑一遍模拟。
 * ⇒ 所以这里改为**静态判定「已知阻塞形态」**,与 `schema.colyseus.ts` 那组的做法一致。 */

test('task-38 【真缺陷】生产入口 room.colyseus.ts 无法加载 —— 两个**独立**阻塞点', () => {
  const rcSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.colyseus.ts'), 'utf8');

  /* 阻塞点 1:依赖链上的 `schema.colyseus.ts` 含装饰器(Node strip-only 不解析)。
   * ⇒ `room.colyseus.ts` 自己 **0 处装饰器**,是被依赖拖垮的。 */
  const ownDecos = [...rcSrc.matchAll(/^\s*@(\w+)/gm)].length;
  eq(ownDecos, 0, 'room.colyseus.ts 自身 **0 处**装饰器 ⇒ 它是被依赖拖垮的');

  const scSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'schema.colyseus.ts'), 'utf8');
  const depDecos = [...scSrc.matchAll(/^\s*@(\w+)/gm)].length;
  /* ⚠️ 行首计数 = **真实生效**的装饰器数(44)。
   *    `@type(` 的字面出现数是 45 —— 差 1 处在 `:182` 注释里(残留文本,不生效)。
   *    两个数都对;断言取**行首**口径,因为它才是「会被解析的」。 */
  eq(depDecos, 44, 'schema.colyseus.ts 有 44 处**生效**装饰器(行首口径;含注释为 45)');
  ok(rcSrc.includes('schema.colyseus'),
    'room.colyseus.ts 确实依赖 schema.colyseus.ts ⇒ 被其装饰器拖垮');

  /* 阻塞点 2(与包无关、与装饰器无关):命名导入 ↔ CommonJS。
   * ⇒ **就算 44 处装饰器全去掉,该文件依然 import 失败。修法清单是两条。** */
  includes(rcSrc, "import { Room, Client } from 'colyseus'",
    '用的是**命名导入**');
  const cjs = JSON.parse(readFileSync(join(ROOT_DIR, 'node_modules', 'colyseus', 'package.json'), 'utf8'));
  ok(cjs.type === undefined,
    `colyseus 是 CommonJS(\`type\` 未设)—— 命名导入会抛 Named export not found`);
  ok(typeof cjs.main === 'string' && cjs.main.endsWith('.js'),
    `colyseus 的 main = ${cjs.main} ⇒ CJS 入口`);

  /* ★ 并证明它「已装」—— 原注释写「未安装」是**过期的**。
   *   包在 `optionalDependencies` 而非 `dependencies`(后者是 `{}`)——
   *    只读后者会误判「未装」(我与 mob-boss-ai 各踩过一次)。 */
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  ok(!pkg.dependencies || !pkg.dependencies.colyseus,
    '`dependencies` 里**没有** colyseus —— 只看这个字段会误判「未装」');
  ok(typeof pkg.optionalDependencies?.colyseus === 'string',
    `colyseus 在 optionalDependencies(${pkg.optionalDependencies?.colyseus})⇒ 声明已装`);
  /* ⚠️ 我第一版写 `parseInt(cjs.version) >= 0` —— **恒真**(任何版本号都 ≥ 0),
   *    故障注入(把版本改成 0.15.0)漏掉了。这是本仓反复出现的「同义反复断言」。
   *    改成:**实测版本必须满足清单声明的 semver 下界**(`^0.15.17` ⇒ ≥ 0.15.17)。
   *    这样「装了但是个不满足声明的旧版」也会红。 */
  const declared = String(pkg.optionalDependencies.colyseus).replace(/^[\^~]/, '');
  const num = (s: string): number[] => (s.split('.').map((x) => Number.parseInt(x, 10)));
  const [aMaj, aMin, aPat] = num(cjs.version);
  const [dMaj, dMin, dPat] = num(declared);
  const installedGeDeclared = aMaj! > dMaj!
    || (aMaj === dMaj && (aMin! > dMin! || (aMin === dMin && aPat! >= dPat!)));
  ok(installedGeDeclared,
    `实测 v${cjs.version} 满足清单声明的 ^${declared}(下界)`
    + ` ⇒ **确已安装**,原注释「未安装」已过期`);

  /* 判据固化:凡生产入口,必须能被加载。这里断言「已知不可加载的入口」清单
   * 与我们实测一致 —— 若将来有人修好了,本条会红,提醒**同步删除本断言**。 */
  const verifySrc = readFileSync(join(ROOT_DIR, 'scripts', 'verify.ts'), 'utf8');
  includes(verifySrc, "'server/src/net/room.colyseus.ts'",
    'room.colyseus.ts 在 PROD_ENTRIES 里(是生产入口)');
  ok(rcSrc.includes('onMessage'),
    '它确实承载客户端消息面 ⇒ 「入口跑不到」意味着这些 handler 零测试可覆盖');
});

test('task-38:包与装配层的模块形态 —— 列举式核对(防只读一个字段的全称结论)', () => {
  /* 我踩过的坑:`dependencies = {}` ⇒ 判「未装」。
   * `mob-boss-ai` 同型踩过一次。
   * ⇒ 这件事本身就是一条陷阱:**用一个不完整的字段得出全称结论**。
   * 本断言把「相关字段」**逐条列举**,漏读任何一个都会在本条里暴露。 */
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
  const fields = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'];
  for (const f of fields) {
    const has = pkg[f] !== undefined;
    console.log(`    [task-38] package.json.${f}: ${has ? JSON.stringify(pkg[f]).slice(0, 78) : '(未定义)'}`);
  }
  /* 至少有一条路径声明了 colyseus —— 「包声明」这个结论必须覆盖全部四个字段才能下。 */
  const declaredAnywhere = fields.some((f) => typeof pkg[f]?.colyseus === 'string');
  ok(declaredAnywhere,
    'colyseus 在**四个依赖字段之一**里有声明 ⇒ 「未声明」这个全称结论不成立');
  eq(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, true,
    'dependencies 确实为空 —— 但这**只是四个字段之一**,不能据此推「未装」');
});

/* ═══════════════ US2(task-47)网关联动契约 ═══════════════ */

/**
 * 一个**最小结构化 host 假件** —— 只实现房间会调的三个方法。
 *
 * ⚠️ 它**证明的是「契约设计正确」,不是「接线生效」**。
 * 这两个命题必须分开说:本假件由测试**手动传入**,而生产里
 * `server/src/index.ts` 不存在 ⇒ 没有人构造真 host(见 K5)。
 */
function fakeHost(o: {
  level?: (id: string) => number;
  onAttack?: (player: string, mob: string) => void;
  hpLoss?: number;
} = {}): {
  saveToDb: () => { hpSaved: number; hpSkipped: number; memRow: number };
  attackMobAuthorized: (p: string, m: string) => {
    outcome: 'OK' | 'OUT_OF_AOI';
    hit: { hpLoss: number; result: { finalDamage: number; outOfReach: boolean; dodged: boolean } } | null;
  };
  levelOf: (id: string) => number;
} {
  return {
    saveToDb: () => ({ hpSaved: 0, hpSkipped: 0, memRow: 0 }),
    attackMobAuthorized: (p, m) => {
      o.onAttack?.(p, m);
      return {
        outcome: 'OK',
        hit: {
          hpLoss: o.hpLoss ?? 7,
          result: { finalDamage: o.hpLoss ?? 7, outOfReach: false, dodged: false },
        },
      };
    },
    levelOf: o.level ?? (() => 1),
  };
}

test('K1 host 为 null 时整个契约**整段跳过**:不报错、不假装、不留假回执', () => {
  /* 这条钉住的是「没接线」与「接了但没打中」**可区分**。
     若三处都不判 null,后果分别是:
       · saveToDb:落盘报告谎报 hpSaved 数(实际没存)
       · attackMobAuthorized:凭空造伤害(更糟)
       · levelOf:把等级投影成本地猜测值
     ⇒ 三者都必须「什么都不做」,且可观测。 */
  const { rt } = newRoom(null);
  eq(rt.worldSaveHost, null, '缺省构造 ⇒ host 为 null(生产就是这一支)');
  rt.join({ userId: 'p1' });

  /* ⚠️ 落盘那一段**必须带 db**,否则没有区分力。
     第一版我写 `newRoom(null)` —— 而落盘分支嵌在 `if (this.db) { if (tick%20===0) ... }`
     里,没有库时它根本不会执行,于是 `lastSaveReport` 无论 host 是否为 null
     都是 null ⇒ 断言**恒真**(故障注入 J5 把 F18 判红、K1 归绿,正是这次抓到的)。
     ⇒ 用带库的房,才真的走到 `if (this.worldSaveHost)` 那一行。 */
  {
    const db = new MemoryDb();
    migrate(db, 1000);
    const { rt: rtDb } = newRoom(db);
    rtDb.join({ userId: 'owner' });
    eq(rtDb.worldSaveHost, null, '带库的房:host 仍为 null(缺省)');
    for (let i = 0; i < 40; i += 1) rtDb.step();
    eq(rtDb.state.meta.tick, 40, '真的推进到 40 帧(跨过两次 tick%20==0)');
    eq(rtDb.lastSaveReport, null,
      'host=null 且真的走到落盘时机 ⇒ lastSaveReport 仍为 null(不谎报已落盘)');
    /* 前置:证明「走到时机」这件事本身不是空的 —— world_tick 照常落盘(那一段与 host 无关)。 */
    eq(getRoom(db, 'room_alpha')?.world_tick, 40,
      '前置:world_tick 已落盘 ⇒ 确实执行到了落盘位置,不是整段被跳过');
  }

  /* 以下部分复用上面那个无库房 rt(攻击/等级投影与 db 无关)*/

  /* 攻击:反作弊放行,但**不结算**、**不发假回执** */
  rt.state.meta.tick = 100;
  const v = rt.applyAttack('p1', 0, 'mob_sheep');
  eq(v.allowed, true, '反作弊层照常放行(它与世界源无关)');
  eq(rt.lastAttackReport, null, 'host=null ⇒ 不留攻击报告 ⇒ 上层发 `resolved:false`,不谎报命中');

  /* 3 等级:投影不执行 ⇒ 保持 schema 默认值 1(而不是被猜成别的) */
  const p = rt.state.players.find((x) => x.id === 'p1')!;
  eq(p.level, 1, 'host=null ⇒ 等级投影整段跳过,保持默认 1(不猜)');
  eq(rt.carryCapacityOf('p1'), 8, '容量按 level=1 ⇒ 8(与接线前一致,没有静默变化)');
});

test('K2 装配位存在:`host` 可经**构造参**注入(此前只能事后赋值)', () => {
  /* 接线前 `worldSaveHost` 只有字段可写 ⇒ 装配必须「new 完再赋值」,
     而生产里那个赋值**一处都不存在**。构造参让「有没有世界」在
     建房间那一刻就必须表态。 */
  const rt = new RoomRuntime({
    roomId: 'k2', ownerId: 'o', clock: fixedClock(1000), host: fakeHost(),
  });
  ok(rt.worldSaveHost !== null, '构造参 host 真的被接上了(不是被忽略)');

  /* 生效自检:注入后运行时取值真的变了(避免「注入了但没生效」判成断言没牙) */
  rt.join({ userId: 'p1' });
  rt.state.meta.tick = 100;
  rt.applyAttack('p1', 0, 'mob_sheep');
  ok(rt.lastAttackReport !== null, '生效自检:有 host ⇒ 真的产生了攻击报告');
  eq(rt.lastAttackReport!.hpLoss, 7, '结算值来自 host(回执带的是 host 给的掉血)');
});

test('K3 权威等级经 host 投影到 state.players[].level(两侧扫描)', () => {
  let lv = 1;
  const rt = new RoomRuntime({
    roomId: 'k3', ownerId: 'o', clock: fixedClock(1000), host: fakeHost({ level: () => lv }),
  });
  rt.join({ userId: 'p1' });
  const p = rt.state.players.find((x) => x.id === 'p1')!;

  /* 逐档扫描(单点区分不了「投影生效」与「本来就相等」) */
  const cases: [number, number][] = [[1, 8], [10, 17], [20, 27], [30, 37], [31, 37], [9999, 37]];
  for (const [input, expectCap] of cases) {
    lv = input;
    rt.step();
    const expectLv = Math.max(1, Math.min(30, input));
    eq(p.level, expectLv, `权威 ${input} ⇒ 投影等级 ${expectLv}`);
    eq(rt.carryCapacityOf('p1'), expectCap, `权威 ${input} ⇒ 容量 ${expectCap}`);
  }
  /* 封顶两侧:30 与 31 **必须同为 37** —— 若只扫单点,「封顶」与
     「线性增长」在这次测里不可区分。 */
  lv = 30; rt.step();
  const at30 = p.level;
  lv = 31; rt.step();
  eq(p.level, at30, '边界两侧:31 不得比 30 更高(封顶真的存在)');
});

test('K4 伪造面板进不了结算:报文只允许携带意图', () => {
  /* 这是本任务的**灵魂**:客户端自报 `level`/`wearing`/`comboMul`
     不得影响服务端派生值。判据用**结构性事实**:
       `applyAttack` 的签名里根本没有面板参数 ⇒ 报文无从透传。 */
  const seen: string[] = [];
  const rt = new RoomRuntime({
    roomId: 'k4', ownerId: 'o', clock: fixedClock(1000),
    host: fakeHost({ onAttack: (p, m) => seen.push(`${p}:${m}`) }),
  });
  rt.join({ userId: 'p1' });
  rt.state.meta.tick = 100;

  /* 模拟一个「什么都报」的恶意报文:handler 只取 mobId,其余字段被丢弃 */
  const evil = { mobId: 'mob_sheep', claimedBonus: 0, level: 9999, wearing: [712], comboMul: 1e9 };
  rt.applyAttack('p1', evil.claimedBonus, evil.mobId);
  eq(seen.length, 1, '攻击真的到达了模拟层');
  eq(seen[0], 'p1:mob_sheep', '模拟层收到的只有「谁打谁」——没有任何面板字段');

  /* 结构性证据:`applyAttack` 的形参表里没有面板位。
     (签名是判据的**唯一**来源,注释可以漂移,形参不会。) */
  const src = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'room.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const sig = /applyAttack\(([^)]*)\)/.exec(src);
  ok(sig !== null, '找得到 applyAttack 的签名');
  const params = sig![1]!;
  for (const bad of ['level', 'wearing', 'weaponId', 'comboMul']) {
    ok(!params.includes(bad), `applyAttack 形参里不得出现 ${bad}(实际: ${params.trim()})`);
  }
  ok(params.includes('mobId'), '只允许 mobId 这类**意图**参数出现');
});

test('K5 ★ 装配入口**真的存在并注入 host**(原「缺口钉住」已按承诺改写为正向断言)', () => {
  /* ## 这条的历史(重要,不要删)
     它原本写的是 **`eq(entryExists, false)`** —— 「钉住缺口本身」。
     当时的实测:`server/src/**` 里 `worldSaveHost = ...` 赋值 **0 处**,
     `server/src/index.ts` **不存在** ⇒ 新接的 `levelOf` / `attackMobAuthorized`
     与既有的 `saveToDb` **三者在运行期都不可达**(第 9 例「测试全绿 + 生产零消费」)。

     ⚠️ 那条断言当时就写明:「一旦有人补出 index.ts 并注入 host,本断言会变红
     —— 那时应当**改写成正向断言**,而不是删掉。」task-57 补出了 `index.ts`
     ⇒ 它**如期变红**(实测 181/182,红 K5)⇒ **现改写为正向断言**。 */
  const entry = join(ROOT_DIR, 'server', 'src', 'index.ts');
  ok(existsSync(entry), '`server/src/index.ts` 存在(装配入口已补)');

  const idxSrc = readFileSync(entry, 'utf8').replace(/\r\n/g, '\n');
  /* 入口必须**真的**把 host 放进 rtOpts —— 而不是只定义了个 createHost */
  ok(/host,/.test(idxSrc), 'assemble() 把 host 放进 rtOpts(不是只造了不用)');
  ok(/new RoomRuntime\(/.test(idxSrc), '入口真的构造了 RoomRuntime');

  /* ## 用**生产路径**证明接线通了(与我 K2/K3 的**手动假件**是两件事)
     手动注入只能证明「契约可用」;这里证明「生产装配路径真的会注入」。 */
  const a = assemble({ clock: fixedClock(1000), combatRng: () => 0.5, sizeCells: 64 });
  ok(a.runtime.worldSaveHost !== null,
    '★ 经 `assemble()` 后 `runtime.worldSaveHost` 非 null ⇒ 接线在生产路径上真的发生');
  eq(a.runtime.worldSaveHost, a.host, '运行时拿到的正是入口构造的那个 host(同一个对象)');

  /* ## 两侧对照:不装配就没有 —— 否则上面那条可能只是「恒有」
     这正是原 K1 钉住的不变量,这里作**负向对照**保留。 */
  const bare = new RoomRuntime({ roomId: 'bare', ownerId: 'o', clock: fixedClock(1000) });
  eq(bare.worldSaveHost, null, '负向对照:不经装配时不传 host ⇒ 仍为 null(不是恒有)');
});

test('K5b ★ 经生产装配后,攻击与等级**真的结算**(不再 resolved:false)', () => {
  /* 这条是 K5 的**行为级**证据:光「host 非 null」还不够,
     要真的走通「报文 → 反作弊 → 模拟层结算 → 回执」全链。 */
  const a = assemble({ clock: fixedClock(1000), combatRng: () => 0.5, sizeCells: 64 });
  /* 世界初始化不属于本任务;这里显式放入玩家与怪,便于把焦点放在**接线**上。 */
  const sim = a.host as unknown as {
    addPlayer(id: string, x: number, y: number): void;
    addMob(id: string, biome: string, x: number, y: number): void;
  };
  sim.addPlayer('p1', 10, 10);
  sim.addMob('mob_sheep', 'MEADOW', 11, 10);

  a.runtime.join({ userId: 'p1' });
  a.runtime.state.meta.tick = 100;
  const v = a.runtime.applyAttack('p1', 0, 'mob_sheep');
  eq(v.allowed, true, '反作弊放行');
  const rep = a.runtime.lastAttackReport;
  ok(rep !== null, '★ 经**生产装配**后产生了攻击报告(接线前恒为 null ⇒ resolved:false)');
  eq(rep!.outcome, 'OK', '结算走到 OK');
  ok(rep!.hpLoss > 0, `真实掉血 ${rep!.hpLoss} > 0 ⇒ 确实打中了(不是空转)`);
  eq(rep!.finalDamage, 10, '伤害值来自权威档案(裸装 10)');

  /* 对照:同一路径不装配时**不谎报** —— 让「接通」与「没接通」可区分。 */
  const bare = new RoomRuntime({ roomId: 'bare2', ownerId: 'o', clock: fixedClock(1000) });
  bare.join({ userId: 'p1' });
  bare.state.meta.tick = 100;
  bare.applyAttack('p1', 0, 'mob_sheep');
  eq(bare.lastAttackReport, null, '负向对照:不装配 ⇒ 报告为 null(上层发 resolved:false)');
});

test('K6 装配位不得让 US2 探针误报:net 层仍不含模拟层符号(代码态)', () => {
  /* `scripts/backlog.ts` 的 US2 探针是 `/WorldSim|world_sim/`,跑在
     **代码态**文本上(注释与字符串都被擦掉)。
     ⇒ 用 `WorldSaveHost` 这个**结构化接口**就安全;
       一旦有人改成 import 模拟层类型,US2 会**误报为已开**。
     本断言用与探针**同一口径**(去注释)复核这一点,防止将来改动踩它。 */
  const strip = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const files = ['server/src/net/room.ts', 'server/src/net/room.colyseus.ts'];
  for (const f of files) {
    const code = strip(readFileSync(join(ROOT_DIR, f), 'utf8').replace(/\r\n/g, '\n'));
    ok(!/WorldSim|world_sim/.test(code),
      `${f} 的**代码态**不含 WorldSim/world_sim(注释里提到不算)⇒ US2 探针不会误报`);
  }
});

/* ═══════════════ 收尾 ═══════════════ */

report('WS-07');