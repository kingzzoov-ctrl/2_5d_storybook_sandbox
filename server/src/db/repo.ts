/**
 * WS-07 · 持久层仓储(零运行时依赖)
 *
 * 设计要点
 *  1. 本模块**只** import `node:*`、`shared/**` 与 `world/archive.ts`(唯一例外,
 *     D-19 第 5 条的 chunk 裁剪:1 MiB 上限的「拒绝 vs 裁剪」必须和读侧**共用
 *     同一份** WSA1 解码器,否则就是两份必然漂移的格式实现),
 *     不 import `better-sqlite3`。
 *     真实 SQLite 绑定由 `driver.sqlite.ts` 通过结构化类型注入,测试用
 *     `memory_db.ts` 的内存实现顶替 —— 二者都实现同一个 `DbLike`。
 *  2. `DbLike` 是**行级操作**抽象(insert/update/get/select/...),不是原始 SQL 字符串
 *     接口。这样仓储层的校验、守恒、长度断言等真实逻辑可以被完整单测,
 *     而「把这些操作翻成 SQL」这件事只有一个实现点(driver.sqlite.ts)。
 *  3. DDL 是文件产物 `schema.sql`;`readSchemaSql()` 用 `node:fs` 读原文,
 *     测试即用真实文件路径断言 DDL 内容(表数、关键列、索引)。
 *
 * 单位:时间戳 = Unix 毫秒;坐标 = 格;`tiles_blob` = 1024 字节(CHUNK_BYTES)。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHUNK_BYTES, CHUNK_CELLS } from '../../../shared/types/tile.ts';
import { BodyState } from '../../../shared/types/physics.ts';
/* ★ 唯一的跨层 import:WSA1 解码/裁剪器(理由见文件头第 1 条)。
   `import type` 与值导入分开写:类型面不进运行时,裁剪函数才进。 */
import { fitWorldArchive, type ArchiveTrimReport } from '../world/archive.ts';

/* ═══════════════════════════ 1. 依赖注入契约 ═══════════════════════════ */

/** 一行记录:列名 -> 值。BLOB 列以 Uint8Array 表示。 */
export interface Row {
  [column: string]: unknown;
}

/** 主键片段:列名 -> 键值。复合主键给出多列。 */
export interface KeyParts {
  [column: string]: string | number;
}

/**
 * `select` 的排序子句(列名走驱动侧白名单,方向只有两个取值 ⇒ 不构成注入面)。
 */
export interface OrderBy {
  column: string;
  dir: 'asc' | 'desc';
}

export interface DbLike {
  /** 执行 DDL / PRAGMA 批。允许语句以 `;` 分隔。 */
  exec(sql: string): void;
  insert(table: string, row: Row): void;
  update(table: string, key: KeyParts, patch: Row): number;
  delete(table: string, key: KeyParts): number;
  get(table: string, key: KeyParts): Row | undefined;
  /**
   * 按等值条件取行。
   *
   * `limit` / `orderBy` 是**可选**的读取上界(后加的参数,老实现不必改):
   * 「只读最近 N 行」必须能下推到引擎,否则每次读取都会把整个表物化成 JS 行。
   * `room_events` 的流水读取(`listEvents`)与有界保留(`trimEvents`)靠它落地。
   */
  select(table: string, where?: KeyParts, limit?: number, orderBy?: OrderBy): Row[];
  /** 行数;省略 table 时返回全库行数,供断言使用。 */
  count(table?: string): number;
  transaction<T>(fn: () => T): T;
}

/** 各表主键列,供内存实现与 SQL 驱动共用。 */
export const TABLE_PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  schema_migrations: ['version'],
  users: ['id'],
  rooms: ['id'],
  user_sessions: ['token'],
  room_players: ['room_id', 'user_id'],
  room_chunks: ['room_id', 'chunk_x', 'chunk_y'],
  ai_alchemy_recipes: ['recipe_hash'],
  ai_item_instances: ['instance_id'],
  room_events: ['id'],
  /* D-06 世界归档(独立 DDL 文件 `schema_world_archive.sql`,见 §13)。
     登记在这里的唯一目的是让 `driver.sqlite.ts` 的表名白名单认得它 ——
     白名单是从本常量表派生的,不登记就写不进真库。 */
  room_world_archives: ['id'],
  /* ★ WS-FND-156 起始背包发放台账(独立 DDL 文件 `schema_starting_inventory.sql`,
     见 §14)。登记在这里的唯一目的与归档表相同:`driver.sqlite.ts` 的表名白名单
     由本常量表派生,不登记就写不进真库。主键 = `user_id` ⇒ 「一个玩家一行」
     由库层唯一约束保证(并发占位的抓手)。 */
  user_starting_inventory: ['user_id'],
  /* ★ WS-FND-165 房间系统台账(独立 DDL 文件 `schema_room_systems.sql`,见 §17)。
     与上面两张表同一处置:登记在这里 `driver.sqlite.ts` 的表名白名单才认得它,
     而 `MemoryDb.insert` 也需要主键列名(不登记 ⇒ 内存夹具插不进去)。
     主键 = `room_id` ⇒ 「一间房一份台账」由库层唯一约束保证。 */
  room_systems_state: ['room_id'],
  /* ★ WS-FND-164 世界存档(独立 DDL 文件 `schema_world_persistence.sql`,见 §19)。
     两张表各一种粒度(见该 SQL 的文件头):
       `room_chunk_roofs` = 屋顶旁路层,主键与 `room_chunks` 逐列相同;
       `room_world_state` = 世界身份 + 水位表,**一房间一行**。
     登记在这里的唯一目的与归档表 / 台账表相同:`driver.sqlite.ts` 的表名白名单
     由本常量表派生,不登记就写不进真库;`MemoryDb.insert` 也要主键列名。 */
  room_chunk_roofs: ['room_id', 'chunk_x', 'chunk_y'],
  room_world_state: ['room_id'],
  /* ★ WS-FND-168 房间运行时状态 + 玩家装备(独立 DDL 文件
     `schema_room_runtime.sql`,见 §20)。与上面几张表同一处置:登记在这里
     `driver.sqlite.ts` 的表名白名单才认得它们,`MemoryDb.insert` 也需要主键列名。
     两张表都非常驻:只有**第一次存档**时才由 `migrateRoomRuntime` 就地补上。 */
  room_runtime_state: ['room_id'],
  player_equipment_state: ['user_id'],
};

/* ═══════════════════════════ 2. DDL 载入与迁移 ═══════════════════════════ */

export const SCHEMA_FILE_NAME = 'schema.sql';

/**
 * 单个 BLOB 列的字节上限 = **1 MiB**。
 *
 * 两个写入点共用同一个数,DDL 侧各有一条对应的 `CHECK`:
 *   * §13 世界归档 `room_world_archives.snapshot_blob`(`WORLD_ARCHIVE_MAX_BYTES`):
 *     超限时**按整块 chunk 裁剪**(合法的 `WSA1` 才有块可裁);
 *   * §6 重连快照 `room_players.snapshot_blob`(`RECONNECT_SNAPSHOT_MAX_BYTES`):
 *     超限**直接拒** —— 重连快照没有「可裁的块」,按字节截断出来的东西恢复
 *     出去就是一个坏状态(`schema.sql` 里那条 `CHECK (length(...) <= 1048576)`
 *     是同一口径的第二道闸,防绕过本模块直插)。
 */
export const BLOB_MAX_BYTES = 1048576;

/** DDL 全文:用真实文件路径读取,保证测试与运行时读的是同一份产物。 */
export function schemaSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), SCHEMA_FILE_NAME);
}

export function readSchemaSql(path: string = schemaSqlPath()): string {
  return readFileSync(path, 'utf8');
}

/** 迁移登记行。 */
export interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: number;
}

export const MIGRATION_BASELINE_VERSION = 1;
export const MIGRATION_BASELINE_NAME = 'ws07_baseline_net_persist';

/**
 * 本程序认识的 `schema_migrations.version` 全集。
 *
 * 惰性函数而不是模块级常量:归档迁移的版本号在 §13 才声明,
 * 顶层常量在这里读它会踩 TDZ(`export const` 的初始化顺序按文件顺序)。
 */
export function knownMigrationVersions(): number[] {
  return [
    MIGRATION_BASELINE_VERSION,
    WORLD_ARCHIVE_MIGRATION_VERSION,
    STARTING_INVENTORY_MIGRATION_VERSION,
    /* ★ WS-FND-165:房间系统台账(结算幂等键集 + 房内第几天)。
       加进「认识的全集」是**兼容既有库**的那一半:老库(v1/v2/v3)照样通过
       `assertMigrationVersionSupported` —— 这一段不要求任何既有版本行存在,
       只在**第一次存档房间系统状态时**就地补表并登记 v4(见 §17)。 */
    ROOM_SYSTEMS_MIGRATION_VERSION,
    /* ★ WS-FND-164:世界存档(chunk 脏页 + 屋顶旁路层 + 水位表)。加进「认识的全集」
       与上一条同一理由:老库(v1/v2/v3/v4)照样过护栏,这一段只在**第一次存档世界时**
       就地补两张表并登记 v5(见 §19)。 */
    WORLD_PERSISTENCE_MIGRATION_VERSION,
    /* ★ WS-FND-168:房间运行时状态 + 玩家装备(§20)。与上两条同一理由:
       老库(v1..v5 任意组合)照样过护栏,这一段只在**第一次存档**时就地补两张表
       并登记 v6 —— 既不要求任何既有版本行存在,也不动 schema.sql 的 checksum。 */
    ROOM_RUNTIME_MIGRATION_VERSION,
  ];
}

/**
 * **版本护栏**(审计 P1:旧库没有升级路径)。
 *
 * ## 为什么必须在 `db.exec(ddl)` **之前**判
 *
 * 改前 `migrate()` 的顺序是「先 exec 整份 DDL,再读 `schema_migrations` 判漂移」。
 * 对一个**旧库**来说这个顺序是致命的:旧库的表是 `CREATE TABLE` 建出来的,
 * `IF NOT EXISTS` 不会补列、本文件里也一条 `ALTER` 都没有 ⇒ 结构停在旧版本;
 * 而 DDL 已经执行过了,等到发现「版本不认识 / checksum 对不上」时,**库已经
 * 被动过**,既没法回退也说不清是改之前还是改之后坏的。
 *
 * ⇒ 顺序改成「先读版本 → 判护栏 → 判漂移 → 再 exec DDL」:
 *   * 读到**更旧**的版本 ⇒ 拒绝 + 给升级指引(不许拿新程序改旧库);
 *   * 读到**不认识**的版本 ⇒ 拒绝 + 给降级/恢复指引;
 *   * 同版本但 checksum 不一致 ⇒ `drift`(调用方 fail-closed,DDL 不执行)。
 */
export function assertMigrationVersionSupported(versions: readonly unknown[]): void {
  const known = knownMigrationVersions();
  const supported = known.slice().sort((a, b) => a - b).join(' / ');
  for (const raw of versions) {
    const v = Number(raw);
    if (!Number.isInteger(v)) {
      throw new Error(
        `schema_migrations.version 不是整数(实得 ${String(raw)})—— 迁移表被写坏,`
        + '拒绝在任何结构判断之前动库;请从备份恢复或人工核对 schema_migrations',
      );
    }
    if (v < MIGRATION_BASELINE_VERSION) {
      throw new Error(
        `库里的 schema 版本 ${v} 比本程序支持的最旧版本 ${MIGRATION_BASELINE_VERSION} 还旧`
        + `(本程序认识:${supported})—— 旧库没有「就地补列」这条路径(本文件里没有 ALTER)。`
        + '请先用对应旧版本的程序把库导出/重建,再按 docs/WS-07-net-persist.md 的迁移段升级;'
        + '本程序拒绝在旧库上执行 DDL',
      );
    }
    if (!known.includes(v)) {
      throw new Error(
        `库里的 schema 版本 ${v} 本程序不认识(认识的是 ${supported})`
        + ' —— 这份库大概是**更新的程序**建的。请升级程序后重试(不要手改 schema_migrations:'
        + '那会让「结构 ↔ 登记」永久对不上);确需降级请从备份恢复,'
        + '见 docs/WS-07-net-persist.md 的迁移段。本程序拒绝在没判清的库上执行 DDL'
      );
    }
  }
}

/**
 * 读出 `schema_migrations` 的全部登记行。
 *
 * 表还不存在(全新库 / 内存夹具)⇒ 空数组:那是「还没迁移过」,**不是**故障。
 * 其余错误照旧冒泡(否则一次磁盘/权限故障会被伪装成「新库」)。
 */
export function readMigrationRows(db: DbLike): MigrationRow[] {
  try {
    return db.select('schema_migrations') as unknown as MigrationRow[];
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return [];
    throw e;
  }
}

/**
 * 极简 checksum:FNV-1a 32 位(十六进制 8 字符)。
 * 只用于「同一版本 DDL 被偷偷改动」的漂移检测,不做安全用途。
 */
export function checksumOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

export interface MigrateResult {
  applied: boolean;
  version: number;
  checksum: string;
  /** 已存在同版本但 checksum 不一致 = 漂移,fail-closed。 */
  drift: boolean;
}

/**
 * 建表 + 登记迁移版本。
 *
 * ## 顺序是判据的一部分(审计 P1:旧库不能「先改库再发现不兼容」)
 *
 * ``` 
 * 1 读 schema_migrations
 * 2 ★ 版本护栏(更旧 / 不认识 ⇒ 抛,库一个字节都还没动)
 * 3 ★ 同版本 checksum 不一致 ⇒ 返回 drift(不执行 DDL)
 * 4 执行幂等 DDL(与 schema.sql 对齐)
 * 5 没登记过才登记
 * ```
 *
 * 改前是 4 在 1 之前:旧库(缺列)会先被 DDL「无害地」跳过,再在 drift 判定处
 * 抛错 —— 此时库里已经是新旧混合状态。现在 2/3 都在 `db.exec(ddl)` **之前**。
 */
export function migrate(db: DbLike, nowMs: number, ddlPath?: string): MigrateResult {
  const ddl = readSchemaSql(ddlPath);
  const checksum = checksumOf(ddl);
  const rows = readMigrationRows(db);
  /* ★ 步 2:版本护栏。`Number.isInteger` 之外的形状由护栏自己抛。 */
  assertMigrationVersionSupported(rows.map((r) => (r as MigrationRow).version));
  const existing = rows.find((r) => Number((r as MigrationRow).version) === MIGRATION_BASELINE_VERSION) as
    | MigrationRow
    | undefined;
  /* ★ 步 3:漂移 ⇒ DDL 一个字都不执行(改前的顺序会把库先改一遍)。 */
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: MIGRATION_BASELINE_VERSION, checksum, drift: true };
  }
  db.exec(ddl);
  if (existing) {
    return { applied: false, version: MIGRATION_BASELINE_VERSION, checksum, drift: false };
  }
  db.insert('schema_migrations', {
    version: MIGRATION_BASELINE_VERSION,
    name: MIGRATION_BASELINE_NAME,
    checksum,
    applied_at: nowMs,
  });
  return { applied: true, version: MIGRATION_BASELINE_VERSION, checksum, drift: false };
}

/* ═══════════════════════════ 3. Chunk 二进制编解码 ═══════════════════════ */

/** 32 位格值数组 -> 1024 字节小端 BLOB(256 格 × 4 字节)。 */
export function packChunkBlob(cells: ArrayLike<number>): Uint8Array {
  if (cells.length !== CHUNK_CELLS) {
    throw new Error(`非法 Chunk 长度 ${cells.length},应为 ${CHUNK_CELLS}`);
  }
  const buf = new Uint8Array(CHUNK_BYTES);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    view.setUint32(i * 4, (cells[i] ?? 0) >>> 0, true);
  }
  return buf;
}

/** 1024 字节 BLOB -> 32 位格值数组。 */
export function unpackChunkBlob(blob: Uint8Array): Uint32Array {
  assertChunkBlob(blob);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Uint32Array(CHUNK_CELLS);
  for (let i = 0; i < CHUNK_CELLS; i += 1) out[i] = view.getUint32(i * 4, true);
  return out;
}

export function assertChunkBlob(blob: Uint8Array): void {
  if (!(blob instanceof Uint8Array)) throw new Error('tiles_blob 必须是 Uint8Array');
  if (blob.byteLength !== CHUNK_BYTES) {
    throw new Error(`tiles_blob 必须为 ${CHUNK_BYTES} 字节,实际 ${blob.byteLength}`);
  }
}

/* ═══════════════════════════ 4. users ═══════════════════════════ */

/** 对应 §7.2 PlayerSchema 的持久化镜像。 */
export interface PlayerRecord {
  id: string;
  display_name: string;
  level: number;
  exp: number;
  hp: number;
  max_hp: number;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  dir: number;
  state_flag: number;
  weapon_id: number | null;
  ai_weapon_recipe_hash: string | null;
  held_item_id: number | null;
  carrying_entity_id: string | null;
  inventory_json: string;
  talent_json: string;
  home_room_id: string | null;
  created_at: number;
  updated_at: number;
}

export const MAX_LEVEL = 30;

export function createUser(
  db: DbLike,
  input: {
    id: string;
    displayName: string;
    nowMs: number;
    level?: number;
    maxHp?: number;
  },
): PlayerRecord {
  if (!input.id) throw new Error('user.id 不能为空');
  if (db.get('users', { id: input.id })) throw new Error(`用户已存在:${input.id}`);
  const level = clampInt(input.level ?? 1, 1, MAX_LEVEL, 'level');
  const maxHp = clampInt(input.maxHp ?? 100, 1, 100000, 'maxHp');
  const row: PlayerRecord = {
    id: input.id,
    display_name: input.displayName,
    level,
    exp: 0,
    hp: maxHp,
    max_hp: maxHp,
    pos_x: 0,
    pos_y: 0,
    pos_z: 0,
    dir: 0,
    state_flag: 0,
    weapon_id: null,
    ai_weapon_recipe_hash: null,
    held_item_id: null,
    carrying_entity_id: null,
    inventory_json: '{}',
    talent_json: '[]',
    home_room_id: null,
    created_at: input.nowMs,
    updated_at: input.nowMs,
  };
  db.insert('users', row as unknown as Row);
  return row;
}

export function getUser(db: DbLike, id: string): PlayerRecord | undefined {
  return db.get('users', { id }) as PlayerRecord | undefined;
}

/** 落盘一个玩家的运行时状态(离开房间 / 自动存档调用)。 */
export function savePlayerState(
  db: DbLike,
  id: string,
  patch: Partial<PlayerRecord>,
  nowMs: number,
): number {
  const cur = getUser(db, id);
  if (!cur) throw new Error(`用户不存在:${id}`);
  const next: Row = { ...patch, updated_at: nowMs };
  if (next.level !== undefined) next.level = clampInt(next.level as number, 1, MAX_LEVEL, 'level');
  if (next.dir !== undefined) next.dir = clampInt(next.dir as number, 0, 3, 'dir');
  const stateNames = Object.values(BodyState) as string[];
  if (next.state_flag !== undefined) {
    next.state_flag = clampInt(next.state_flag as number, 0, stateNames.length - 1, 'state_flag');
  }
  if (next.max_hp !== undefined) {
    next.max_hp = clampInt(next.max_hp as number, 1, 100000, 'max_hp');
  }
  if (next.hp !== undefined) {
    const maxHp = (next.max_hp as number) ?? cur.max_hp;
    /* hp 是**派生量**:溢出上限或低于 0 时静默钳制,不抛错 —— 血量在战斗中
     * 高频变化,抛错会让一次落盘失败连带丢整个存档事务。 */
    next.hp = clampIntQuiet(next.hp as number, 0, maxHp);
  }
  return db.update('users', { id }, next);
}

/* ═══════════════════════════ 5. rooms ═══════════════════════════ */

export const AccessMode = {
  PUBLIC: 'PUBLIC',
  PASSWORD: 'PASSWORD',
} as const;
export type AccessMode = (typeof AccessMode)[keyof typeof AccessMode];

export const RoomStatus = {
  OPEN: 'OPEN',
  SLEEPING: 'SLEEPING',
  CLOSED: 'CLOSED',
} as const;
export type RoomStatus = (typeof RoomStatus)[keyof typeof RoomStatus];

/* ⚠️ 词表以**冻结层** `shared/constants/bosses.ts` 的 `PARTY_MODES` 为准。
   本枚举此前写的是 `BRIDGE_FLAG` / `CROWN_RUN`,与冻结层的 `BRIDGE_CTF` / `CROWN_BR`
   不一致 —— 而 `schema.sql` 的 CHECK 也跟着写了错的那套,于是:
   **设成冻结层的值会被 DDL 拒绝**(真实 SQLite 实测:`BRIDGE_CTF` →
   `CHECK constraint failed`),而设成 DDL 的值则与冻结层/WS-11 H0 断言不符。
   两套清单(可达性 / 生产零引用)都**查不出**这类缺陷:它们只看可达性。

   冻结层是权威(WS-11 `H0 冻结层 PARTY_MODES 四模式与节拍一致` 直接断言它),
   持久层不该为它让步。已同步修 `schema.sql:82` 的 CHECK。 */
export const PartyMode = {
  NONE: 'NONE',
  BRIDGE_CTF: 'BRIDGE_CTF',
  JELLY_BALL: 'JELLY_BALL',
  CROWN_BR: 'CROWN_BR',
  PAINT_WAR: 'PAINT_WAR',
} as const;
export type PartyMode = (typeof PartyMode)[keyof typeof PartyMode];

export interface RoomRecord {
  id: string;
  owner_id: string;
  name: string;
  access_mode: AccessMode;
  password_hash: string | null;
  max_players: number;
  status: RoomStatus;
  party_mode: PartyMode;
  world_seed: number;
  world_tick: number;
  chunk_radius: number;
  created_at: number;
  last_active_at: number;
  saved_at: number | null;
}

export function createRoom(
  db: DbLike,
  input: {
    id: string;
    ownerId: string;
    name?: string;
    accessMode?: AccessMode;
    passwordHash?: string | null;
    maxPlayers?: number;
    worldSeed?: number;
    nowMs: number;
  },
): RoomRecord {
  if (!getUser(db, input.ownerId)) throw new Error(`房主不存在:${input.ownerId}`);
  if (db.get('rooms', { id: input.id })) throw new Error(`房间已存在:${input.id}`);
  const accessMode = input.accessMode ?? AccessMode.PUBLIC;
  const passwordHash = input.passwordHash ?? null;
  if (accessMode === AccessMode.PASSWORD && !passwordHash) {
    throw new Error('PASSWORD 房间必须提供 passwordHash');
  }
  if (accessMode === AccessMode.PUBLIC && passwordHash) {
    throw new Error('PUBLIC 房间不得携带 passwordHash');
  }
  const row: RoomRecord = {
    id: input.id,
    owner_id: input.ownerId,
    name: input.name ?? input.id,
    access_mode: accessMode,
    password_hash: passwordHash,
    max_players: clampInt(input.maxPlayers ?? 16, 1, 16, 'maxPlayers'),
    status: RoomStatus.OPEN,
    party_mode: PartyMode.NONE,
    world_seed: input.worldSeed ?? 20261010,
    world_tick: 0,
    chunk_radius: 4,
    created_at: input.nowMs,
    last_active_at: input.nowMs,
    saved_at: null,
  };
  db.insert('rooms', row as unknown as Row);
  return row;
}

export function getRoom(db: DbLike, id: string): RoomRecord | undefined {
  return db.get('rooms', { id }) as RoomRecord | undefined;
}

export function listRooms(db: DbLike, opts: { includeSleeping?: boolean } = {}): RoomRecord[] {
  const all = db.select('rooms') as unknown as RoomRecord[];
  const keep = all.filter((r) => r.status !== RoomStatus.CLOSED);
  const rows = opts.includeSleeping ? keep : keep.filter((r) => r.status === RoomStatus.OPEN);
  return rows.slice().sort((a, b) => b.last_active_at - a.last_active_at);
}

export function setRoomStatus(
  db: DbLike,
  id: string,
  status: RoomStatus,
  nowMs: number,
): number {
  const patch: Row = { status, last_active_at: nowMs };
  if (status === RoomStatus.SLEEPING) patch.saved_at = nowMs;
  return db.update('rooms', { id }, patch);
}

export function touchRoom(db: DbLike, id: string, tick: number, nowMs: number): number {
  return db.update('rooms', { id }, { world_tick: Math.max(0, Math.trunc(tick)), last_active_at: nowMs });
}

export function setPartyMode(db: DbLike, id: string, mode: PartyMode, nowMs: number): number {
  return db.update('rooms', { id }, { party_mode: mode, last_active_at: nowMs });
}

/* ═══════════════════════════ 6. room_players / 重连 ═══════════════════════════ */

export const RoomRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  GUEST: 'GUEST',
} as const;
export type RoomRole = (typeof RoomRole)[keyof typeof RoomRole];

/** 重连快照(`room_players.snapshot_blob`)的字节上限 —— 与归档**同口径** 1 MiB。 */
export const RECONNECT_SNAPSHOT_MAX_BYTES = BLOB_MAX_BYTES;

/**
 * 重连快照的字节闸口(两个写入点共用)。
 *
 * 超限**如实拒**(抛错),不截断、不静默丢弃:截断后的字节恢复出去是一个
 * 坏状态(背包/等级/位置被切掉一半),而调用方看到的却是「保存成功」。
 * 与 `archiveWorldSnapshot` 对非 `WSA1` 快照的取舍一致(见 §13)。
 */
function assertReconnectSnapshotSize(snapshot: Uint8Array, where: string): void {
  if (!(snapshot instanceof Uint8Array)) {
    throw new Error(`${where}:快照必须是 Uint8Array(实得 ${typeof snapshot})`);
  }
  if (snapshot.byteLength > RECONNECT_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `${where}:快照 ${snapshot.byteLength} 字节超出上限 ${RECONNECT_SNAPSHOT_MAX_BYTES}`
      + ' —— 拒绝写入而不是截断(截断的重连快照恢复出去是坏状态)',
    );
  }
}

/**
 * ★ 保证 `users` 父行存在(真外键的目标:`room_players.user_id → users.id`)。
 *
 * ## 为什么这条必须在**仓储层**,而不是让调用方先建号
 * 真长跑夹具(文件库 + `PRAGMA foreign_keys = ON`)抓到:
 * ```text
 * room.ts:2797  upsertRoomPlayer(...)   →   repo.ts 的 INSERT room_players
 * schema.sql:131 FOREIGN KEY (user_id) REFERENCES users(id)
 * driver.sqlite.ts:505  PRAGMA foreign_keys = ON
 * ⇒ 库里没有 users 行 ⇒ FOREIGN KEY constraint failed ⇒ 整个入场回滚
 *   (回执 `JOIN_FAILED:加入失败(已回滚...):FOREIGN KEY constraint failed`)
 * ```
 * `room.join()` **自己从不建号**(只有 `bootstrap()` / `assemble()` 建**房主**),
 * 于是「**非房主**第一次进房」在真库上必然失败 —— 而既有测试的夹具都先
 * `createUser` 了那个 id,所以全仓测试全绿。
 * ⇒ 「写子行之前先有父行」是这张表**自己的**完整性前提,不该由调用方记住顺序
 *   (只在 room.ts 里补一次建号也能过,但下一个写入口还会再漏一次)。
 *
 * 手法与 `index.ts:ensureOwnerUser` 逐字同款:读不到就按 id 建一个,显示名取 id
 * (本仓没有「真实昵称」这一格,也不该在这里编一个)。幂等:已是 `users` 行就直接返回。
 */
function ensureUserRow(db: DbLike, userId: string, nowMs: number): void {
  if (userId === '') throw new Error('user_id 不能为空');
  if (db.get('users', { id: userId })) return;
  createUser(db, { id: userId, displayName: userId, nowMs });
}

export function upsertRoomPlayer(
  db: DbLike,
  roomId: string,
  userId: string,
  role: RoomRole,
  nowMs: number,
  snapshot?: Uint8Array,
): void {
  /* ★ 写入侧的字节闸口(§6):与归档同口径 1 MiB,超限**如实拒**(不截断)。 */
  if (snapshot !== undefined) assertReconnectSnapshotSize(snapshot, '重连快照(room_players)');
  /* ★ P0(2026-11-25 长跑实测):**父行先于子行** —— 见 `ensureUserRow`。
     放在最前(而不是只插在 insert 分支之前):重连/改角色那条 update 分支也走同一道闸,
     「库里有这个人」这个前提从此只声明一次。 */
  ensureUserRow(db, userId, nowMs);
  const key = { room_id: roomId, user_id: userId };
  const existing = db.get('room_players', key);
  if (existing) {
    db.update('room_players', key, { role, last_seen_at: nowMs, ...(snapshot ? { snapshot_blob: snapshot } : {}) });
    return;
  }
  db.insert('room_players', {
    room_id: roomId,
    user_id: userId,
    role,
    snapshot_blob: snapshot ?? null,
    joined_at: nowMs,
    last_seen_at: nowMs,
  });
}

export function saveReconnectSnapshot(
  db: DbLike,
  roomId: string,
  userId: string,
  snapshot: Uint8Array,
  nowMs: number,
): number {
  assertReconnectSnapshotSize(snapshot, '重连快照(room_players)');
  return db.update('room_players', { room_id: roomId, user_id: userId }, {
    snapshot_blob: snapshot,
    last_seen_at: nowMs,
  });
}

export function loadReconnectSnapshot(
  db: DbLike,
  roomId: string,
  userId: string,
): Uint8Array | undefined {
  const row = db.get('room_players', { room_id: roomId, user_id: userId });
  if (!row) return undefined;
  const blob = row.snapshot_blob;
  return blob instanceof Uint8Array ? blob : undefined;
}

export function removeRoomPlayer(db: DbLike, roomId: string, userId: string): number {
  return db.delete('room_players', { room_id: roomId, user_id: userId });
}

export function listRoomPlayers(db: DbLike, roomId: string): Row[] {
  return db.select('room_players', { room_id: roomId });
}

/* ═══════════════════════════ 7. room_chunks ═══════════════════════════ */

export interface ChunkRecord {
  room_id: string;
  chunk_x: number;
  chunk_y: number;
  version: number;
  tiles_blob: Uint8Array;
  updated_at: number;
}

/** 写入单块地形。blob 必须是 1024 字节,否则抛错(不静默截断)。 */
export function saveChunk(
  db: DbLike,
  roomId: string,
  chunkX: number,
  chunkY: number,
  blob: Uint8Array,
  nowMs: number,
  version?: number,
): void {
  assertChunkBlob(blob);
  const key = { room_id: roomId, chunk_x: chunkX, chunk_y: chunkY };
  const existing = db.get('room_chunks', key);
  if (existing) {
    const nextVersion = version ?? ((existing.version as number) + 1);
    db.update('room_chunks', key, { tiles_blob: blob, version: nextVersion, updated_at: nowMs });
    return;
  }
  db.insert('room_chunks', {
    room_id: roomId,
    chunk_x: chunkX,
    chunk_y: chunkY,
    version: version ?? 1,
    tiles_blob: blob,
    updated_at: nowMs,
  });
}

export function loadChunk(
  db: DbLike,
  roomId: string,
  chunkX: number,
  chunkY: number,
): ChunkRecord | undefined {
  const row = db.get('room_chunks', { room_id: roomId, chunk_x: chunkX, chunk_y: chunkY });
  return row as ChunkRecord | undefined;
}

export function loadChunkCells(
  db: DbLike,
  roomId: string,
  chunkX: number,
  chunkY: number,
): Uint32Array | undefined {
  const row = loadChunk(db, roomId, chunkX, chunkY);
  if (!row) return undefined;
  return unpackChunkBlob(row.tiles_blob);
}

/**
 * 批量存盘:一次事务写 N 块,返回实际写入块数。任何一块长度非法则整批回滚。
 *
 * ## ★ WS-FND-164:`roofs` 让「一块地形」在一次事务里写全
 *
 * 屋顶层(`Chunk.roofs`)不在 32 位单元里,只能落到 `room_chunk_roofs`(见
 * `schema_world_persistence.sql` 的文件头)。两行必须**同一个事务**:
 * 只写进去一半(地形新、屋顶旧)会让「关掉 host 再读回」得到一个**没人下过**
 * 的世界,而这种半态在回执上完全看不出来。
 *
 * `roofs` 可省:省略 ⇒ 不碰 `room_chunk_roofs`(老调用方与「只关心地形」的
 * 测试逐字兼容 —— 它们拿到的仍是「写了 N 块」这个数)。
 */
export function saveChunkBatch(
  db: DbLike,
  roomId: string,
  chunks: readonly { cx: number; cy: number; blob: Uint8Array; roofs?: Uint8Array }[],
  nowMs: number,
): number {
  for (const c of chunks) {
    assertChunkBlob(c.blob);
    if (c.roofs !== undefined) assertRoofsBlob(c.roofs);
  }
  return db.transaction(() => {
    for (const c of chunks) {
      saveChunk(db, roomId, c.cx, c.cy, c.blob, nowMs);
      if (c.roofs !== undefined) saveChunkRoofs(db, roomId, c.cx, c.cy, c.roofs, nowMs);
    }
    return chunks.length;
  });
}

/** 自某时刻以来变动的 Chunk 坐标(增量存盘用)。 */
export function chunksUpdatedSince(db: DbLike, roomId: string, sinceMs: number): ChunkRecord[] {
  return (db.select('room_chunks', { room_id: roomId }) as unknown as ChunkRecord[])
    .filter((c) => c.updated_at >= sinceMs)
    .sort((a, b) => a.updated_at - b.updated_at);
}

/* ═══════════════════════════ 8. ai_alchemy_recipes ═══════════════════════════ */

export interface RecipeRecord {
  recipe_hash: string;
  input_ids: string;
  k_inputs: number;
  item_name: string;
  category: string;
  rarity_tier: number;
  t_eff: number;
  q_score: number;
  p_budget: number;
  stats_json: string;
  visual_json: string;
  pixel_icon_json: string;
  llm_model: string;
  first_crafter_id: string | null;
  craft_count: number;
  created_at: number;
  last_crafted_at: number;
}

export function upsertRecipe(db: DbLike, row: RecipeRecord): number {
  if (row.k_inputs < 2 || row.k_inputs > 4) throw new Error(`k_inputs 超出 [2,4]:${row.k_inputs}`);
  if (row.rarity_tier < 0 || row.rarity_tier > 3) throw new Error(`rarity_tier 超出 [0,3]`);
  const existing = db.get('ai_alchemy_recipes', { recipe_hash: row.recipe_hash });
  if (existing) return db.update('ai_alchemy_recipes', { recipe_hash: row.recipe_hash }, row as unknown as Row);
  return db.insert('ai_alchemy_recipes', row as unknown as Row);
}

/** 命中缓存一次:craft_count + 1(一世奇物冠名后的复用计数)。 */
export function incrementCraftCount(db: DbLike, recipeHash: string, nowMs: number): number {
  const row = db.get('ai_alchemy_recipes', { recipe_hash: recipeHash }) as RecipeRecord | undefined;
  if (!row) throw new Error(`配方不存在:${recipeHash}`);
  return db.update('ai_alchemy_recipes', { recipe_hash: recipeHash }, {
    craft_count: row.craft_count + 1,
    last_crafted_at: nowMs,
  });
}

export function getRecipe(db: DbLike, recipeHash: string): RecipeRecord | undefined {
  return db.get('ai_alchemy_recipes', { recipe_hash: recipeHash }) as RecipeRecord | undefined;
}

export function listTopRecipes(db: DbLike, limit = 10): RecipeRecord[] {
  return (db.select('ai_alchemy_recipes') as unknown as RecipeRecord[])
    .slice()
    .sort((a, b) => b.craft_count - a.craft_count || b.created_at - a.created_at)
    .slice(0, limit);
}

/* ═══════════════════════════ 9. ai_item_instances ═══════════════════════════ */

export const EquipSlot = {
  WEAPON: 'weapon',
  ARMOR: 'armor',
  HELM: 'helm',
  BOOTS: 'boots',
  RELIC: 'relic',
  CLOAK: 'cloak',
  BAG: 'bag',
} as const;
export type EquipSlot = (typeof EquipSlot)[keyof typeof EquipSlot];

export interface ItemInstanceRecord {
  instance_id: string;
  owner_id: string | null;
  recipe_hash: string | null;
  slot: EquipSlot;
  quantity: number;
  equipped: number;
  stats_json: string;
  bound_room_id: string | null;
  created_at: number;
  updated_at: number;
}

export function addItemInstance(db: DbLike, row: ItemInstanceRecord): void {
  if (row.quantity < 0) throw new Error('quantity 不能为负');
  if (db.get('ai_item_instances', { instance_id: row.instance_id })) {
    throw new Error(`实例已存在:${row.instance_id}`);
  }
  db.insert('ai_item_instances', row as unknown as Row);
}

export function listItems(db: DbLike, ownerId: string): ItemInstanceRecord[] {
  return db.select('ai_item_instances', { owner_id: ownerId }) as unknown as ItemInstanceRecord[];
}

/** 物品栏守恒:只放下限扣减,数量不足返回 false 且不写库。 */
export function consumeItem(db: DbLike, instanceId: string, n: number, nowMs: number): boolean {
  if (!Number.isInteger(n) || n <= 0) throw new Error('n 必须为正整数');
  const row = db.get('ai_item_instances', { instance_id: instanceId }) as
    | ItemInstanceRecord
    | undefined;
  if (!row || row.quantity < n) return false;
  const left = row.quantity - n;
  if (left === 0) {
    db.delete('ai_item_instances', { instance_id: instanceId });
    return true;
  }
  db.update('ai_item_instances', { instance_id: instanceId }, { quantity: left, updated_at: nowMs });
  return true;
}

/**
 * `ai_item_instances` 里 `quantity` **不可用**的行数(累计,只增)。
 *
 * 为什么要有它:坏行被**跳过**是该有的行为(见 `totalItemsOf`),但「跳过」
 * 若无声,它就变成又一处**静默降级** —— 账面悄悄少算几件,而没有任何地方
 * 看得出发生过。`badQuantityRowCount() > 0` ⇒ 持久层里有脏数据,需要人看。
 */
let badQuantityRows = 0;

/** 坏 `quantity` 行数。**正常路径必须为 0**。 */
export function badQuantityRowCount(): number {
  return badQuantityRows;
}

/** 归零(测试用)。 */
export function resetBadQuantityRowCount(): void {
  badQuantityRows = 0;
}

/**
 * 单玩家物品总量(守恒断言的观测口径)。
 *
 * ## ⚠️ 只累加**有限非负**的 `quantity`(不是 `reduce((s,r) => s + r.quantity)`)
 *
 * 一行坏数据(`quantity: NaN` / `'abc'` / `Infinity`)会让整个和变成 `NaN`,
 * 而下游的守恒判定是**比较**:
 * ```
 * after > capacity   ⇒   NaN > 8   = false   (容量闸静默失效)
 * after < 0          ⇒   NaN < 0   = false   (负库存闸静默失效)
 * ```
 * 与 `anticheat.sanitizeMul` 兜 `speedMul` 是**同一族的坑**:`NaN` 让比较恒 false。
 * 它是真实可达面:`quantity` 是库里的数字列,而 `addItemInstance` 只校验
 * 「< 0 抛错」、不校验「是不是有限数」(`addItemInstance(db, {quantity: NaN})`
 * 一路进去 ⇒ 该玩家之后**所有**物品判据失效)。
 *
 * ## 为什么是「整行跳过」而不是「夹到 0」或「抛错」
 * ```
 * 夹到 0  ⇒ 把「这一行坏了」伪装成「这一行是 0」——又一个静默降级(本仓反复记的形态)
 * 抛错    ⇒ 一行脏数据让**整个房间**的物品路径崩掉(比少算更不安全;与
 *           `mergeLimits` 取 fail-closed 而非 fail-fast 同一条理由)
 * 跳过    ⇒ 少算这一行、**并且可观测**(`badQuantityRowCount`),判据仍在
 * ```
 * 数值上「跳过」只会**低估**总量(低估 ⇒ 容量闸更保守),不会让判据失效。
 */
export function totalItemsOf(db: DbLike, ownerId: string): number {
  let sum = 0;
  for (const r of listItems(db, ownerId)) {
    const q = r.quantity;
    if (typeof q !== 'number' || !Number.isFinite(q) || q < 0) {
      badQuantityRows += 1;
      continue;
    }
    sum += q;
  }
  return sum;
}

/* ═══════════════════════════ 10. room_events ═══════════════════════════ */

/* ── 有界保留:按条数封顶(AUDIT P1)────────────────────────────────────────

   事实:改前全仓对 `room_events` **没有任何 DELETE**,而生产插入点是
   `room.colyseus.ts:624`(每帧把 `drainViolations()` 逐条落库)。正常玩法近似
   0 条/小时,但作弊客户端能刷出数千条/小时 ⇒ 库文件**单调涨**、永不回收。

   为什么按**条数**而不是按天数封顶:
     天数封顶在高写入率下照样无界(1000 条/小时 × 7 天 = 17 万条,全都落在
     窗口内),只有条数封顶与「库不会涨」直接等价。天数是第二条防线,等有真实
     留存需求时再加。

   两个水位(不是一个)是为了**摊平成本**:超上限才动手,且一次删到 LOW_WATER
   ⇒ 每 (MAX - LOW_WATER) 次写入才真删一次,而不是每条写入都删一次。 */
export const ROOM_EVENT_RETAIN_MAX = 4096;
export const ROOM_EVENT_RETAIN_LOW_WATER = 3072;

/* `listEvents` 的读取上界(AUDIT P1)。

   改前:`db.select('room_events', {room_id})` 把该房间**全部**行取回 JS 再排序
   裁剪 —— 房间历史多长就读多少行。现在库里按 `tick DESC` 取固定窗口
   (走 `idx_room_events_room_tick`,该索引正是为「房间审计回放:按 room + tick
   倒序」建的),再在调用侧精确排序裁剪。
     * LIST_MAX       = 调用方能要到的上限(挡住无界查询从 API 面溜进来);
     * LIST_OVERFETCH = 过取倍率:窗口边界上可能有同 tick 的行,多取一点再裁。 */
export const ROOM_EVENT_LIST_MAX = 500;
export const ROOM_EVENT_LIST_OVERFETCH = 4;
/** `listEvents` 单次从库里最多读多少行(过取后的硬上限)。 */
export const ROOM_EVENT_LIST_FETCH_MAX = 2000;

/* `room_events.id` 的取号重试计数。
 *
 * **为什么要有这个计数器**:取号重试是一种「兜底」,而兜底会**掩盖**缺陷 ——
 * 我第一版把「按房间取号」改成全表取号时,重试逻辑把碰撞吞掉了,
 * 于是故障注入后门禁照样绿(实测:注入「退回按房间取号」,门禁仍报通过)。
 * 把重试暴露成可观测量,门禁才能断言「正常路径不依赖兜底」——
 * 这比只测「结果对」严格:结果对可能只是因为兜底救了场。 */
let eventIdRetries = 0;

/** 取号重试次数。**正常路径必须为 0**;大于 0 说明主键分配逻辑有问题。 */
export function eventIdRetryCount(): number {
  return eventIdRetries;
}

/** 归零(测试用)。 */
export function resetEventIdRetryCount(): void {
  eventIdRetries = 0;
}

/** 与 `TABLE_PRIMARY_KEYS.room_events` 一致的主键列。
 *
 * 取号 = **全表最大 id + 1**,只读一行(AUDIT P2):`room_events.id` 是
 * `INTEGER PRIMARY KEY AUTOINCREMENT` ⇒ `ORDER BY id DESC LIMIT 1` 落在主键索引
 * 上、不物化整表。改前是 `db.select('room_events')` 把整表取回 JS 求 max = O(N)
 * —— 现在生产插入点还没接上所以不热,接上后就是热点。
 * trim 只删**最小**的 id ⇒ max 单调不减 ⇒ `maxId + 1` 不会重用已删的 id。 */
function nextEventId(db: DbLike): number {
  const newest = db.select('room_events', undefined, 1, { column: 'id', dir: 'desc' })[0];
  return (Number(newest?.id) || 0) + 1;
}

/** 一次事件写入的可观测结果(`trimmed` 报数让「有没有真的封顶」可断言)。 */
export interface EventWriteReport {
  /** 实际写入的行 id。 */
  id: number;
  /** 本次写入触发的 trim 删掉的行数(未超上限 ⇒ 0)。 */
  trimmed: number;
}

export function writeEvent(
  db: DbLike,
  roomId: string,
  tick: number,
  kind: string,
  actorId: string | null,
  payload: unknown,
  nowMs: number,
): EventWriteReport {
  /* ⚠️ `room_events.id` 是**全表**自增主键,不是「每房间一套」。
     这里曾经只查 `{room_id: roomId}` 的 maxId,于是:
       房间 A 写了一条事件(id=1)→ 给房间 B 写第一条事件时
       B 的 maxId 仍是 0 → 撞上 id=1 → `主键冲突`。
     多房间是核心场景(§7),但 WS-07 的事件测试全在同一房间内写,
     所以 109 条测试全绿、bug 照样活着。
     修复:取全表 maxId —— 与 `room_events` 的主键定义一致。 */
  const row = {
    id: nextEventId(db),
    room_id: roomId,
    tick,
    kind,
    actor_id: actorId,
    payload_json: JSON.stringify(payload ?? {}),
    created_at: nowMs,
  };
  let id = row.id;
  try {
    db.insert('room_events', row);
  } catch (e) {
    /* 兜底:并发写入导致取号过期时重试一次。
       计数暴露为 `eventIdRetryCount()` —— 门禁会断言它保持 0。 */
    const msg = (e as Error).message;
    if (!/主键冲突|UNIQUE constraint failed/.test(msg)) throw e;
    eventIdRetries += 1;
    id = nextEventId(db);
    db.insert('room_events', { ...row, id });
  }
  /* ★ 有界保留挂在**写入路径**上:当前宿主没有周期任务,这里是唯一的 trim
     触发点。将来接入周期任务时同时调 `trimEvents`(幂等,重复无害)。 */
  const trimmed = trimEvents(db);
  return { id, trimmed };
}

/**
 * 有界保留:把 `room_events` 从 `ROOM_EVENT_RETAIN_MAX` 削到
 * `ROOM_EVENT_RETAIN_LOW_WATER`,返回删除的行数。
 *
 * **幂等**:未超上限 ⇒ 立刻返回 0 且一行不动(判据是「表规模」而不是
 * 「调用次数」,所以重复调用与一次调用等价)。
 *
 * 删的是 **id 最小**的一批(入库顺序 ⇒ 最旧):`ORDER BY id ASC LIMIT n` 取出
 * 这批 id 再逐行删 —— `DbLike` 只有「按主键删除」这一种写面(没有范围删),故
 * 代价 = 一次有序窗口读 + k 条 `DELETE`。整段包在一个事务里:删到一半崩掉会让
 * 「表规模 ≤ 上限」这个不变量说不清(半截状态既不是旧规模也不是新规模)。
 */
export function trimEvents(db: DbLike): number {
  const total = db.count('room_events');
  if (total <= ROOM_EVENT_RETAIN_MAX) return 0;
  /* `COUNT(*)` 由引擎计数,不物化行;真正贵的是下面那次「取最旧的 k 行」。 */
  const victims = Math.max(0, total - ROOM_EVENT_RETAIN_LOW_WATER);
  const oldest = db.select('room_events', undefined, victims, { column: 'id', dir: 'asc' });
  return db.transaction(() => {
    let removed = 0;
    for (const r of oldest) removed += db.delete('room_events', { id: Number(r.id) });
    return removed;
  });
}

/**
 * 房间审计回放:按 `tick` 倒序取最近 `limit` 条。
 *
 * 「返回多少条」与「从库里读多少行」是两件事,后者才与库规模相关:`limit` 先夹
 * 到 `ROOM_EVENT_LIST_MAX` 以内,再乘过取倍率,并封在 `ROOM_EVENT_LIST_FETCH_MAX`
 * 之下;精确排序仍在调用侧做(三个后端同一口径)。
 */
export function listEvents(db: DbLike, roomId: string, limit = 50): Row[] {
  const want = Math.max(0, Math.min(Math.trunc(limit) || 0, ROOM_EVENT_LIST_MAX));
  if (want === 0) return [];
  const fetch = Math.min(ROOM_EVENT_LIST_FETCH_MAX, want * ROOM_EVENT_LIST_OVERFETCH);
  return db.select('room_events', { room_id: roomId }, fetch, { column: 'tick', dir: 'desc' })
    .slice()
    .sort((a, b) => Number(b.tick) - Number(a.tick) || Number(b.id) - Number(a.id))
    .slice(0, want);
}

/* ═══════════════════════ 11. 存档闭环:HP 与生物 mem 落地 ═══════════════════ */

/* 这一节补的是「运行时状态 → DB」最后一段。
 *
 * 为什么需要:`WorldSim` 能导出 `exportVitals()` / `exportMobMem()`,
 * `users.hp` 与 `rooms` 也早就有落点,但**没有任何东西把两边接起来** ——
 * `savePlayerState` 在全仓只有测试调用(详见 docs/DAMAGE-LOOP.md D7),
 * 生物 mem 更是只活在宿主进程内。于是「能导出」但「从未落盘」。
 *
 * 分层:本节只做**序列化与行级读写**,不认识 `WorldSim`。
 * 把两者拼起来的是 `sim/world_sim.ts` 的 `saveToDb` / `loadFromDb`。
 */

/** 一次 HP 落盘的结果。`skipped` 计数是刻意暴露的 —— 见下方注释。 */
export interface VitalsSaveReport {
  /** 真正写进 `users` 行的人数。 */
  saved: number;
  /** 在 DB 里找不到 `users` 行、因而没写的人数。 */
  skipped: number;
}

/**
 * 把运行时 HP 写进 `users.hp`。
 *
 * ## 为什么只写 `hp`,不写 `max_hp`
 *
 * `users.max_hp` 是**成长派生量**(随等级走,`createUser` 会写入),
 * 而运行时 `VitalsSystem` 只有一个构造期常量 `maxHp`,不是每玩家一份。
 * 用一个全局常量去覆盖每个人的成长上限,会让高等级玩家掉回基础血量 ——
 * 所以这里刻意不碰 `max_hp`,只写战斗中真实变化的 `hp`。
 * (钳制仍按行内既有的 `max_hp` 走,由 `savePlayerState` 负责。)
 *
 * ## 为什么要 `skipped` 而不是抛错
 *
 * `savePlayerState` 在用户不存在时抛错。批量落盘里「某个 ID 没有 users 行」
 * 是正常情形(测试用的模拟玩家、尚未建号的访客),不该让一个人的缺失
 * 把整批存档连坐丢掉。但**静默跳过会让门禁失去分辨力**,
 * 所以把数量返回出来,由调用方断言。
 */
export function saveVitalsToUsers(
  db: DbLike,
  vitals: Record<string, { hp: number }>,
  nowMs: number,
): VitalsSaveReport {
  /* ★ 一次批量落盘 = **一个事务**。
     改前是逐人 UPDATE 而**没有事务**:第 3 个人写失败时,前 2 个人已经落库,
     而调用方拿到的是异常 —— 「存档写了一半」既不守恒也不可重试(重试会把
     前面几个人的 hp 再写一遍,语义上还是半截)。包进事务后:**全成或全不成**。 */
  return db.transaction(() => {
    let saved = 0;
    let skipped = 0;
    for (const id of Object.keys(vitals).sort()) {
      const row = vitals[id];
      if (!row || typeof row.hp !== 'number' || !Number.isFinite(row.hp)) {
        skipped += 1;
        continue;
      }
      if (!getUser(db, id)) {
        skipped += 1;
        continue;
      }
      savePlayerState(db, id, { hp: row.hp }, nowMs);
      saved += 1;
    }
    return { saved, skipped };
  });
}

/**
 * 读回 `users.hp`(与 `saveVitalsToUsers` 对偶)。
 *
 * 只读**显式给出的** ID:把全表用户都读进来会让「谁该被还原」取决于
 * DB 里恰好有谁,而不是当前世界登记了谁 —— 那正是幽灵玩家的来源。
 * 不存在的用户、非有限数的 hp 一律不返回(与 `importVitals` 的拒收口径一致)。
 */
export function loadVitalsFromUsers(
  db: DbLike,
  ids: readonly string[],
): Record<string, { hp: number }> {
  const out: Record<string, { hp: number }> = {};
  for (const id of [...ids].sort()) {
    const u = getUser(db, id);
    if (!u) continue;
    const hp = u.hp;
    if (typeof hp !== 'number' || !Number.isFinite(hp)) continue;
    out[id] = { hp };
  }
  return out;
}

/**
 * 把生物 mem 快照写进 `rooms.mob_mem_json`。
 *
 * 为什么落在 `rooms` 而不是 `users`:mem 是**房间级世界状态**
 * (生物属于某个房间实例),不是玩家个人数据。也正因为它是新增的第三类
 * 房间级载荷,才需要 schema 里那一列的注释说明「为什么加列不加表」。
 *
 * 返回值 = SQL `UPDATE` 影响行数。**0 表示房间不存在、存档没落地** ——
 * 刻意不抛错但把事实暴露出来,让调用方能断言「确实写进了某一间房」。
 * (`touchRoom` 同样返回 changes,此处与其口径一致。)
 */
export function saveRoomMobMem(
  db: DbLike,
  roomId: string,
  mem: Record<string, Record<string, unknown>>,
  nowMs: number,
): number {
  return db.update('rooms', { id: roomId }, {
    mob_mem_json: JSON.stringify(mem ?? {}),
    last_active_at: nowMs,
  });
}

/**
 * 读回生物 mem(与 `saveRoomMobMem` 对偶)。
 *
 * **解析必须容错**:存档是外部输入,可能来自旧版本、被截断或人工改坏。
 * 任何一处坏数据都只应让**那一条**消失,不能把整个房间的世界状态拖垮 ——
 * 所以:房间不存在 / 非法 JSON / 非对象 / 值不是对象,一律降级为「没有这段记忆」。
 * 静默降级是安全的,因为 mem 缺失的后果是「AI 行为重置」而非崩溃;
 * 反过来若这里抛错,一个坏字段就会让整间房读不回来。
 */
export function loadRoomMobMem(
  db: DbLike,
  roomId: string,
): Record<string, Record<string, unknown>> {
  const room = db.get('rooms', { id: roomId });
  if (!room) return {};
  const raw = room.mob_mem_json;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [mobId, v] of Object.entries(parsed as Record<string, unknown>)) {
    /* 只收「plain object」:数组与 null 都会被 importMem 当作脏数据计入 skipped,
       在这里就滤掉,读回来的一定是 importMem 能消费的形状。 */
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    out[mobId] = { ...(v as Record<string, unknown>) };
  }
  return out;
}

/* ═══════════════════════════ 12. 小工具 ═══════════════════════════ */

export function clampInt(v: number, lo: number, hi: number, label: string): number {
  if (!Number.isFinite(v)) throw new Error(`${label} 必须是有限数`);
  const i = Math.trunc(v);
  if (i < lo || i > hi) throw new Error(`${label}=${i} 超出 [${lo}, ${hi}]`);
  return i;
}

/** 静默钳制:用于「越界是正常游戏事件」的派生量(hp / 坐标夹取)。 */
export function clampIntQuiet(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}
/* ═══════════════ 13. 世界归档(D-06:重置的存档政策 = **归档**) ═══════════════
 *
 * 裁决原文:`docs/DECISIONS.md` **D-06** —— 世界按新 seed 在内存重建,
 * **旧世界存成一份可回滚快照行**(不删、也不原地不管)。
 *
 * 本节只做**存储**:表结构(独立 DDL 文件)、迁移、写入、纯读。
 * 「内存里怎么按新 seed 重建世界」是宿主(`WorldSim.resetWorld`)的事,
 * 本节不认识 `WorldSim`(与 §11 同一分层)。
 *
 * ## 为什么不写进 `schema.sql`
 * 建表数被 `tests/WS-07.test.ts:200/295/488` 与 `scripts/verify.ts:5553`
 * 锁死在 **9 张**,外键被 `tests/WS-07.test.ts:269` 锁在 **11 条**。
 * 加第 10 张表会让那四处立刻红,而那些不是本次改动的判据文件。
 * ⇒ 走**自己的** DDL 产物 + 自己的迁移版本(见 `schema_world_archive.sql` 文件头)。
 *
 * ## 三件事的边界(别当成已实现)
 * 1 **幂等可查**:每次归档**追加一行**,旧行不覆盖(`seq` 单调,`id` 是稳定句柄);
 * 2 **可回滚的读口**:`listWorldArchives` / `loadWorldArchive` 是**纯读**,
 *   给将来"回滚到上一版"用 —— **回滚写入不在本裁决范围**(D-06 只裁了归档);
 * 3 **配额**:`WORLD_ARCHIVE_KEEP_PER_ROOM` 在**写入事务内**裁剪,表不会无界增长。
 */

/** 表名(与 DDL 文件里那张表逐字一致)。 */
export const WORLD_ARCHIVE_TABLE = 'room_world_archives';

/** 归档 DDL 的文件产物名。**独立于 `schema.sql`**,理由见本节头。 */
export const WORLD_ARCHIVE_SCHEMA_FILE_NAME = 'schema_world_archive.sql';

/** 归档迁移在 `schema_migrations` 里的版本号(`migrate()` 用 1,本节用 2)。 */
export const WORLD_ARCHIVE_MIGRATION_VERSION = 2;
export const WORLD_ARCHIVE_MIGRATION_NAME = 'ws_fnd57_world_archive';

/**
 * 每个房间保留的归档行数上限(配额)。
 *
 * ## 为什么是 6,以及为什么**必须**有一个数
 * * 触发归档的动作是**手工破坏性**动作:`RESET_WORLD` 要 OWNER 权限 + `confirm: true`
 *   (见 `net/actions/reset_world.ts`),不是每 tick 发生 ⇒ 需求量天然很小;
 * * 单份快照与房间地形同量级(chunk_radius 4 ⇒ ≤ 9×9 = 81 块 × 1024B ≈ 81KB),
 *   6 份 ≈ 0.5MB/房间 —— 与"1KB/Chunk 的主动存档"同一个数量级;
 * * 6 覆盖真实回滚深度(改一版 → 试两个种子 → 再回退两三步),
 *   再深就没有裁决依据(D-06 只要求"可回滚",没定深度)⇒ 不选无穷;
 * * **为什么不选 1**:一次内容迭代里连着试两个种子是常事,第一步的回滚点
 *   会被自己覆盖掉 —— 那等于"只有一次机会",与"可回滚"的字面要求不符。
 */
export const WORLD_ARCHIVE_KEEP_PER_ROOM = 6;

/**
 * 单份快照的字节上限。超限的处置分两种(D-19 第 5 条):
 *
 * 1 **是合法的 `WSA1`**(真实世界快照)⇒ 按 `world/archive.ts:planChunkTrim`
 *    的规则**裁 chunk** 降到上限内再写(规则 = 玩家建造 > 活动 > 原始地形;
 *    逐块记账,绝不切碎块体),回执里带 `trim`(裁了几块 / 多少字节 / 为什么);
 * 2 **不是 `WSA1`**(来源不明的一大坨字节)⇒ **仍然拒绝**:没有块可以裁,
 *    「按字节截断」出来的东西回滚出去就是一个坏世界。
 *
 * 所以「上限」并没有被放宽:写进去的字节永远 ≤ 1048576,而且**裁剪**是
 * 「少了哪几块 + 为什么」可查的,不是静默丢数据。
 * 1MiB 远高于 radius 4 的全量地形(~81KB),却小到一次误传撑不爆库。
 */
export const WORLD_ARCHIVE_MAX_BYTES = BLOB_MAX_BYTES;

/** 归档 DDL 全文(用真实文件路径读,与 `readSchemaSql` 同一做法)。 */
export function worldArchiveSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), WORLD_ARCHIVE_SCHEMA_FILE_NAME);
}

export function readWorldArchiveSql(path: string = worldArchiveSqlPath()): string {
  return readFileSync(path, 'utf8');
}

export interface WorldArchiveMigrateResult {
  applied: boolean;
  version: number;
  checksum: string;
  /** 已存在同版本但 checksum 不一致 = 漂移(调用方决定是否 fail-closed)。 */
  drift: boolean;
}

/**
 * 建归档表 + 登记迁移版本。**幂等**(DDL 全是 `IF NOT EXISTS`)。
 *
 * 与 `migrate()` 的关系:`migrate()` 仍然只建 `schema.sql` 那 9 张表,
 * 本函数是**第二段**迁移。宿主(或装配层)在启动时调一次即可;
 * **写入侧 `archiveWorldSnapshot` 也会调它** —— 这样"表没建"不会变成静默丢档。
 *
 * ## 顺序与 `migrate()` 同一条判据(审计 P1)
 *
 * 「先读版本 → 护栏 → 漂移 → 才 exec DDL」。改前是 `exec` 在最前:一份
 * 旧版 `schema_world_archive.sql` 建出来的库会先被 DDL 跳过,再在 drift 处
 * 发现不一致 —— 库已经被动过。
 */
export function migrateWorldArchives(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): WorldArchiveMigrateResult {
  const ddl = readWorldArchiveSql(ddlPath);
  const checksum = checksumOf(ddl);
  const rows = readMigrationRows(db);
  assertMigrationVersionSupported(rows.map((r) => (r as MigrationRow).version));
  const existing = rows.find(
    (r) => Number((r as MigrationRow).version) === WORLD_ARCHIVE_MIGRATION_VERSION,
  ) as MigrationRow | undefined;
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: WORLD_ARCHIVE_MIGRATION_VERSION, checksum, drift: true };
  }
  db.exec(ddl);
  if (existing) {
    return { applied: false, version: WORLD_ARCHIVE_MIGRATION_VERSION, checksum, drift: false };
  }
  db.insert('schema_migrations', {
    version: WORLD_ARCHIVE_MIGRATION_VERSION,
    name: WORLD_ARCHIVE_MIGRATION_NAME,
    checksum,
    applied_at: nowMs,
  });
  return { applied: true, version: WORLD_ARCHIVE_MIGRATION_VERSION, checksum, drift: false };
}

/** 这个库里**装过**归档迁移吗(登记行在 ⇒ 装过)。 */
export function worldArchiveMigrationInstalled(db: DbLike): boolean {
  const rows = readMigrationRows(db);
  return rows.some((r) => Number((r as MigrationRow).version) === WORLD_ARCHIVE_MIGRATION_VERSION);
}

/** `migrateWorldArchivesIfInstalled` 的结果(比迁移结果多一个 `installed`)。 */
export interface WorldArchiveBootCheck extends WorldArchiveMigrateResult {
  /** `false` = 这个库从没装过归档表 ⇒ 本轮**没有**建它(见函数注释)。 */
  installed: boolean;
}

/**
 * **启动检查**:装过归档迁移的库 ⇒ 跑一遍(幂等 DDL + checksum 漂移检测);
 * 没装过的库 ⇒ 什么都不做。
 *
 * ## 为什么全新的库不在这里建归档表
 *
 * 建表数被四处既有判据锁死在 **9 张**(`tests/WS-07.test.ts:200/295/488`、
 * `scripts/verify.ts`:`bootstrap()` 后 `tableNames().length === 9`)。
 * 启动就给新库建第 10 张表会当场把那些门禁打红 —— 而那**不是**本次改动的判据。
 * 归档表在**第一次归档**时由 `archiveWorldSnapshot` 建(同一个 `migrateWorldArchives`)。
 *
 * 但「装过的库」必须在这里核对:那种库里的归档字节是**已经在用的**回滚原料,
 * checksum 漂移说明「DDL 被改过而库里的表没跟着改」⇒ 必须 fail-closed,
 * 不能等到下一次写入才发现。需要「启动就有归档表」的宿主显式调
 * `migrateWorldArchives()` 即可。
 */
export function migrateWorldArchivesIfInstalled(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): WorldArchiveBootCheck {
  if (!worldArchiveMigrationInstalled(db)) {
    return {
      applied: false,
      version: WORLD_ARCHIVE_MIGRATION_VERSION,
      checksum: '',
      drift: false,
      installed: false,
    };
  }
  return { ...migrateWorldArchives(db, nowMs, ddlPath), installed: true };
}

/**
 * 一行归档的**摘要**(回滚读口的返回形状)。
 *
 * 刻意不带 BLOB:选版本时只需要 `id/seed/时间/字节数`,
 * 把整份快照拖进列表会让"看一眼有哪些版本"变成读全表存储。
 * 真要字节时走 `loadWorldArchive(id)`。
 */
export interface WorldArchiveSummary {
  /** 稳定句柄(`<room_id>#<seq>`),回滚读口的钥匙。 */
  id: string;
  room_id: string;
  /** 该房间的第几次归档(1 起,单调)。 */
  seq: number;
  /** **旧世界**的种子(不是新世界的)。 */
  seed: number;
  world_tick: number;
  /** `snapshot_blob` 的字节数。 */
  bytes: number;
  reason: string;
  /** Unix 毫秒。 */
  archived_at: number;
}

/** 带字节的完整归档行 —— **回滚的原料**(只读;回滚写入不在 D-06 范围)。 */
export interface WorldArchiveRecord extends WorldArchiveSummary {
  snapshot_blob: Uint8Array;
}

export interface WorldArchiveWriteResult {
  archived: WorldArchiveSummary;
  /** 本次写入顺手裁掉了几条旧行(配额生效的**可观测**证据,别只靠"表里有几条")。 */
  pruned: number;
  /**
   * 本次写入是否**裁过地形块**(D-19 第 5 条)。`undefined` = 没裁过
   * (快照本来就 ≤ 上限)。
   *
   * ★ 裁剪摘要**同时写进快照头**(`header.trim`),所以这一项不是唯一
   *   来源:`loadWorldArchive` + `decodeWorldArchive` 也能读回来。这里再带
   *   一份是为了让**写入当次**的回执能直接说「裁了几块 / 为什么」。
   */
  trim?: ArchiveTrimReport;
}

/** 时间倒序(同毫秒用 `seq` 兜底),保证两个后端排序一致。 */
function newestArchiveFirst(a: Row, b: Row): number {
  return (
    (Number(b.archived_at) || 0) - (Number(a.archived_at) || 0)
    || (Number(b.seq) || 0) - (Number(a.seq) || 0)
  );
}

function toWorldArchiveSummary(row: Row): WorldArchiveSummary {
  return {
    id: String(row.id),
    room_id: String(row.room_id),
    seq: Number(row.seq),
    seed: Number(row.seed),
    world_tick: Number(row.world_tick ?? 0),
    bytes: Number(row.snapshot_bytes ?? 0),
    reason: typeof row.reason === 'string' ? row.reason : '',
    archived_at: Number(row.archived_at),
  };
}

/**
 * 按配额裁掉某房间的多余归档行,返回删除条数。
 *
 * 裁剪口径 = **保留最近 `keep` 条**(按 `archived_at` 倒序、同毫秒按 `seq` 倒序)。
 * 老版本被删是**配额**的必然结果,不是"覆盖":在配额内,任何一次重置都不会
 * 动到已有行(判据 `tests/WS-FND-57` 第 2 条钉的就是这一点)。
 */
export function pruneWorldArchives(
  db: DbLike,
  roomId: string,
  keep: number = WORLD_ARCHIVE_KEEP_PER_ROOM,
): number {
  const keepN = Number.isFinite(keep) ? Math.max(0, Math.trunc(keep)) : WORLD_ARCHIVE_KEEP_PER_ROOM;
  const ordered = db.select(WORLD_ARCHIVE_TABLE, { room_id: roomId }).slice().sort(newestArchiveFirst);
  let removed = 0;
  for (const row of ordered.slice(keepN)) {
    removed += db.delete(WORLD_ARCHIVE_TABLE, { id: row.id as string });
  }
  return removed;
}

/**
 * 归档一份旧世界快照。**一次重置 = 一行**,旧行不覆盖。
 *
 * 顺序刻意是「建表 → 事务内 (追加 + 裁剪)」:
 * 裁剪放在同一事务里,才不会出现"写进去了但没裁"的中间态
 * (那会让配额在一段窗口内失效,而窗口正好是最坏情况:有人在狂点重置)。
 *
 * 返回值带 `pruned`:配额不是"应该有效",而是**每次都报数**。
 *
 * ## 超 1 MiB 时(D-19 第 5 条)
 *
 * 顺序是「先裁 **chunk**,再进事务」:
 *   * 合法的 `WSA1` ⇒ `world/archive.ts:fitWorldArchive` 按规则裁块到 ≤
 *     `WORLD_ARCHIVE_MAX_BYTES`,写进去的是**裁过的字节**(回执里 `trim` 说清
 *     裁了几块 / 多少字节 / 为什么;同样的摘要也写进了快照头);
 *   * 不是 `WSA1` ⇒ 照旧抛(没有块可裁,而不许截断)。
 * 裁剪发生在事务**之前**:裁失败时一行都不写,不存在「写进去半份」的中间态。
 */
export function archiveWorldSnapshot(
  db: DbLike,
  input: {
    roomId: string;
    /** 旧世界的种子 —— 不是新种子。 */
    seed: number;
    snapshot: Uint8Array;
    nowMs: number;
    worldTick?: number;
    reason?: string;
  },
): WorldArchiveWriteResult {
  if (typeof input.roomId !== 'string' || input.roomId.length === 0) {
    throw new Error('归档需要 roomId(非空字符串)');
  }
  if (!Number.isFinite(input.seed) || !Number.isInteger(input.seed)) {
    throw new Error(`归档的 seed 必须是有限整数(实得 ${String(input.seed)})`);
  }
  if (!Number.isFinite(input.nowMs)) throw new Error('归档需要 nowMs(Unix 毫秒)');
  if (!(input.snapshot instanceof Uint8Array)) throw new Error('归档快照必须是 Uint8Array');
  if (input.snapshot.byteLength === 0) {
    throw new Error('归档快照不能是 0 字节(空快照回滚出去就是一个空世界)');
  }
  /* ★ D-19 第 5 条:超限**裁剪**而不是拒绝 —— 但只对合法的 `WSA1` 成立。
     裁剪的单位是**整块 chunk**(规则见 `world/archive.ts:planChunkTrim`),
     绝不是按字节截断;裁了什么、为什么进回执 + 快照头。 */
  let snapshot = input.snapshot;
  let trim: ArchiveTrimReport | undefined;
  if (snapshot.byteLength > WORLD_ARCHIVE_MAX_BYTES) {
    const oversized = snapshot.byteLength;
    let fitted: { bytes: Uint8Array; report: ArchiveTrimReport | null };
    try {
      fitted = fitWorldArchive(snapshot, WORLD_ARCHIVE_MAX_BYTES);
    } catch (e) {
      throw new Error(
        `归档快照 ${oversized} 字节超出上限 ${WORLD_ARCHIVE_MAX_BYTES},`
        + `且无法按 chunk 裁剪(${e instanceof Error ? e.message : String(e)})`
        + ' —— 拒绝而不是截断:截断的快照回滚出去是坏世界',
      );
    }
    if (fitted.report === null || fitted.bytes.byteLength > WORLD_ARCHIVE_MAX_BYTES) {
      /* 理论上到不了(超限 ⇒ 一定裁过),但「没有报告」不能当成「裁过」。 */
      throw new Error(
        `归档快照 ${oversized} 字节超出上限 ${WORLD_ARCHIVE_MAX_BYTES},`
        + '裁剪没有给出可核对的结果 —— 拒绝写入(不静默降级)',
      );
    }
    snapshot = fitted.bytes;
    trim = fitted.report;
  }
  const bytes = snapshot.byteLength;
  const worldTick = Number.isFinite(input.worldTick)
    ? Math.max(0, Math.trunc(input.worldTick as number))
    : 0;
  const reason = typeof input.reason === 'string' ? input.reason : '';

  /* ★ 归档迁移的 checksum 漂移 ⇒ **fail-closed**(审计 P1)。
     改前这一行把返回值丢了:DDL 被改过(或库里的表与 DDL 对不上)时
     这里静默继续,写进去的归档字节属于哪一版结构没人说得清 —— 等真回滚时
     才发现原料是坏的。现在:漂移 ⇒ 一行都不写,直接抛。 */
  const migration = migrateWorldArchives(db, input.nowMs);
  if (migration.drift) {
    throw new Error(
      `归档迁移 checksum 漂移(schema_migrations.version=${WORLD_ARCHIVE_MIGRATION_VERSION} 的登记与 `
      + `schema_world_archive.sql 对不上)⇒ 拒绝写入(不静默降级)。`
      + '归档是回滚原料:结构没判清就写进去,将来回滚出去的是坏世界;'
      + '请先按 docs/WS-07-net-persist.md 的迁移段核对/重建 room_world_archives',
    );
  }
  return db.transaction(() => {
    const existing = db.select(WORLD_ARCHIVE_TABLE, { room_id: input.roomId });
    /* `seq` 取该房间已有最大值 + 1:**单调**,所以同一毫秒内的两次归档
       (测试里很常见)也有确定的先后与互不相同的 `id`。 */
    const seq = existing.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
    const row: Row = {
      id: `${input.roomId}#${seq}`,
      room_id: input.roomId,
      seq,
      seed: input.seed,
      world_tick: worldTick,
      snapshot_blob: snapshot,
      snapshot_bytes: bytes,
      reason,
      archived_at: input.nowMs,
    };
    db.insert(WORLD_ARCHIVE_TABLE, row);
    const pruned = pruneWorldArchives(db, input.roomId);
    const out: WorldArchiveWriteResult = { archived: toWorldArchiveSummary(row), pruned };
    if (trim !== undefined) out.trim = trim;
    return out;
  });
}

/**
 * **纯读**:某房间的归档摘要列表,按时间倒序。
 *
 * 负对照(没归档过)必须返回**空数组**而不是 `undefined`/抛错:
 * 这个读口会被回滚 UI 与诊断直接消费,"没有可回滚的版本"是一种正常状态。
 * 真实 SQLite 在表还没建时抛 `no such table` —— 只有**这一种**错误被降级成 `[]`,
 * 其余错误照旧冒泡(否则一处权限/磁盘故障会被伪装成"没有归档")。
 */
export function listWorldArchives(
  db: DbLike,
  roomId: string,
  limit: number = WORLD_ARCHIVE_KEEP_PER_ROOM,
): WorldArchiveSummary[] {
  if (typeof roomId !== 'string' || roomId.length === 0) return [];
  const keepN = Number.isFinite(limit) ? Math.trunc(limit) : WORLD_ARCHIVE_KEEP_PER_ROOM;
  if (keepN <= 0) return [];
  let rows: Row[];
  try {
    rows = db.select(WORLD_ARCHIVE_TABLE, { room_id: roomId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return [];
    throw e;
  }
  return rows.slice().sort(newestArchiveFirst).slice(0, keepN).map(toWorldArchiveSummary);
}

/**
 * **纯读**:按句柄取一整行(含快照字节),给将来"回滚到上一版"用。
 *
 * 回滚**写入**刻意不在这里实现:D-06 只裁了"归档",没裁"回滚的语义"
 * (回滚要不要也先归档当前世界?算不算一次新的 RESET_WORLD?)——
 * 没有裁决就实现,等于替 owner 决定玩家数据怎么变。
 *
 * 读不回字节(行不存在 / BLOB 不是 Uint8Array)⇒ `undefined`:
 * 归档行是回滚原料,原料不完整就等于**没有这一版**,不能回一个半截对象。
 *
 * ## `snapshot_bytes` 必须与 BLOB 长度一致(审计 P2)
 *
 * DDL 里 `snapshot_blob` 有 `CHECK (length(...) <= 1048576)`(防绕过本模块直插),
 * 但 `snapshot_bytes` 是**另一列**,跨列等式在 SQLite 里要写成跨列 CHECK,
 * 而 `MemoryDb` 不认那种形态(会进 `unsupportedChecks()`,等于一条假装存在的
 * 约束)。⇒ 一致性在这一层钉住:摘要说多少字节,blob 就必须是多少字节,
 * 否则这一行**不是**可用原料(返回 `undefined`,不是把两个矛盾的数都交出去)。
 */
export function loadWorldArchive(db: DbLike, archiveId: string): WorldArchiveRecord | undefined {
  if (typeof archiveId !== 'string' || archiveId.length === 0) return undefined;
  let row: Row | undefined;
  try {
    row = db.get(WORLD_ARCHIVE_TABLE, { id: archiveId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return undefined;
    throw e;
  }
  if (!row) return undefined;
  const blob = row.snapshot_blob;
  if (!(blob instanceof Uint8Array)) return undefined;
  const summary = toWorldArchiveSummary(row);
  /* ★ 摘要与字节必须互相说得清:对不上 ⇒ 这一版**不完整**(不能回滚半份世界)。 */
  if (summary.bytes !== blob.byteLength) return undefined;
  if (blob.byteLength > WORLD_ARCHIVE_MAX_BYTES) return undefined;
  return { ...summary, snapshot_blob: blob };
}

/** 某房间现有归档行数(配额断言的观测口径;`listWorldArchives` 默认被 N 截断)。 */
export function countWorldArchives(db: DbLike, roomId: string): number {
  try {
    return db.select(WORLD_ARCHIVE_TABLE, { room_id: roomId }).length;
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return 0;
    throw e;
  }
}

/* ═════════ 14. 起始背包发放台账(★ WS-FND-156:跨进程幂等)══════════════
 *
 * ## 缺陷形态(修前)
 *
 * 「起始背包已发」只有一份**房间实例**的内存账
 * (`RoomRuntime.startingInventoryGranted:Set<string>`)⇒
 * ```
 * 服务重启(或换一个 Room 实例)⇒ 同一个 id 再 join ⇒ 集合是空的 ⇒ **再发一份**
 * ```
 * 本节提供**库层真值**:一张 `user_starting_inventory` 台账(主键 = `user_id`)。
 *
 * ## 判序(`net/room.ts:grantStartingInventory` 逐条对着写)
 * ```
 * 1 读台账(先 `migrateStartingInventory` 确保表在)未领才继续   ← 本节
 * 2 本房间内存账 / 权威账 / 计划(纯函数)                       ← room.ts
 * 3 真的发(按件账 + 总量重算)
 * 4 写台账:`claimStartingInventoryGrant()` = 一次 INSERT,
 *   主键冲突 ⇒ false ⇒ 调用方**撤回**第 3 步(不留半态)          ← 本节
 * ```
 *
 * ## 为什么是「先发后记 + 冲突即撤回」,而不是「先占位再发」
 *
 * 两者都能保证「并发只发一份」;选前者的理由都在本仓的可观测面上:
 *   * 写台账失败时库与账**同时**回到未发状态(撤回复用既有的
 *     `RoomRuntime.rollbackStartingInventory`,不新写一份反向逻辑);
 *   * 后者会在「占位成功但发账抛错」时留下一条**没有对应物品**的台账行 ——
 *     那个 id 从此**永远**拿不到起始包,而且不报错。
 *
 * ## 撤回必须**只删自己占的那条**
 *
 * 并发时「我方发起、对方赢了唯一约束」⇒ 我方撤回**不许**删对方的行(否则两人
 * 争着删,谁都不留)。调用方用 `RoomRuntime.dbGrantClaimed` 记住哪几条台账是
 * **本进程**写成功的,只删那些。
 */

/** 台账表名(与 DDL 文件里那张表逐字一致)。 */
export const STARTING_INVENTORY_TABLE = 'user_starting_inventory';

/** 台账 DDL 的文件产物名。**独立于 `schema.sql`**(理由见该 SQL 的文件头)。 */
export const STARTING_INVENTORY_SCHEMA_FILE_NAME = 'schema_starting_inventory.sql';

/** 台账迁移在 `schema_migrations` 里的版本号(基线 1 / 归档 2 / 本表 3)。 */
export const STARTING_INVENTORY_MIGRATION_VERSION = 3;
export const STARTING_INVENTORY_MIGRATION_NAME = 'ws_fnd156_starting_inventory';

/**
 * **起始包内容版本号** —— 与冻结表
 * `shared/constants/starting_inventory.ts#STARTING_INVENTORY` 配套:那张表里
 * 「发了什么」改了,这个数就该 +1(与成长表同一纪律:改内容要有版本痕迹)。
 *
 * ## 版本升高的语义:选**不补发**,并给出理由
 * ```
 * 台账里有行(已领过)⇒ 无论当前版本是多少,一律**不再发**
 * 台账 `version` 只记录「他领的是哪一版」
 * ```
 * 三条理由:
 *   1 起始包是**入场门槛**的一次性礼包(WS-FND-155 的裁定:它不是经济补偿);
 *      按版本追发会把「一次性」悄悄变成「按版本记一笔」—— 那是新玩法,需要
 *      owner 裁决,不是一条 DDL 的副作用;
 *   2 补发**没有可靠的动作面**:入场是唯一调用点(`room.ts` 的 `join` 两处),
 *      而入场次数与版本数无关 ⇒ 在入场里补发等于「谁重进谁先拿到」;
 *   3 但**证据必须留下来**:所以 `version` 落库(而不是只存 0/1)。将来真要补发,
 *      「谁领的是 v1、现在发到 v3」这个查询有原料,不必重建历史。
 *
 * ⚠️ 它在本模块而不是 `shared/constants/starting_inventory.ts` 的原因:冻结层是
 * 另一条写域(本轮写域不含 `shared/**`)⇒ 暂放在本文件,而**口径上它属于那张表**
 * (将来真要搬,连这段注释一起搬,别只搬常量)。
 */
export const STARTING_INVENTORY_VERSION = 1;

/** 台账 DDL 全文(用真实文件路径读,与 `readSchemaSql` 同一做法)。 */
export function startingInventorySqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), STARTING_INVENTORY_SCHEMA_FILE_NAME);
}

export function readStartingInventorySql(path: string = startingInventorySqlPath()): string {
  return readFileSync(path, 'utf8');
}

export interface StartingInventoryMigrateResult {
  applied: boolean;
  version: number;
  checksum: string;
  /** 已存在同版本但 checksum 不一致 = 漂移(调用方决定是否 fail-closed)。 */
  drift: boolean;
}

/**
 * 建台账表 + 登记迁移版本。**幂等**(DDL 全是 `CREATE TABLE IF NOT EXISTS`)。
 *
 * ## 与 `migrate()` 的关系(★ 与归档同一条纪律)
 * `migrate()` 仍然只建 `schema.sql` 那 9 张表;本函数是**第三段**迁移。
 * 之所以不并进 `migrate()`:`migrate()` 后 `tableNames().length === 9` 被四处
 * 既有判据锁着(`tests/WS-07.test.ts:213/501`、`scripts/verify.ts:6776`),
 * 在**全新库**上建第 10 张表会当场把它们打红 —— 那不是本次改动的判据。
 * 于是与 `room_world_archives` 同一处置:**第一次用到的库**才建它。
 *
 * ## 判序:`exec` 必须在版本判定**之后**
 * 「先读版本 → 护栏 → 漂移 → 才 exec DDL」(审计 P1,见 `migrate()` 的长注释)。
 * 旧库缺这张表时本函数**就地补表**,既有表与既有行一个都不动 —— 这就是
 * 「兼容既有库」的实现,不是重建。
 */
export function migrateStartingInventory(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): StartingInventoryMigrateResult {
  const ddl = readStartingInventorySql(ddlPath);
  const checksum = checksumOf(ddl);
  const rows = readMigrationRows(db);
  assertMigrationVersionSupported(rows.map((r) => (r as MigrationRow).version));
  const existing = rows.find(
    (r) => Number((r as MigrationRow).version) === STARTING_INVENTORY_MIGRATION_VERSION,
  ) as MigrationRow | undefined;
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: STARTING_INVENTORY_MIGRATION_VERSION, checksum, drift: true };
  }
  db.exec(ddl);
  if (existing) {
    return { applied: false, version: STARTING_INVENTORY_MIGRATION_VERSION, checksum, drift: false };
  }
  db.insert('schema_migrations', {
    version: STARTING_INVENTORY_MIGRATION_VERSION,
    name: STARTING_INVENTORY_MIGRATION_NAME,
    checksum,
    applied_at: nowMs,
  });
  return { applied: true, version: STARTING_INVENTORY_MIGRATION_VERSION, checksum, drift: false };
}

/** 这个库里**装过**台账迁移吗(登记行在 ⇒ 装过)。 */
export function startingInventoryMigrationInstalled(db: DbLike): boolean {
  const rows = readMigrationRows(db);
  return rows.some((r) => Number((r as MigrationRow).version) === STARTING_INVENTORY_MIGRATION_VERSION);
}

/** `migrateStartingInventoryIfInstalled` 的结果(比迁移结果多一个 `installed`)。 */
export interface StartingInventoryBootCheck extends StartingInventoryMigrateResult {
  /** `false` = 这个库从没装过台账 ⇒ 本轮**没有**建它(见函数注释)。 */
  installed: boolean;
}

/**
 * **启动检查**:装过台账迁移的库 ⇒ 跑一遍(幂等 DDL + checksum 漂移检测);
 * 没装过的库 ⇒ 什么都不做(全新库不许在这里多出第 10 张表)。
 *
 * 为什么仍要这一道:装过的库里的台账行是「谁已经领过」的**唯一真值**,checksum
 * 漂移说明「DDL 被改过而库里的表没跟着改」⇒ 必须 fail-closed,不能等到某次入场
 * 才发现「判据与库结构已经对不上」。
 */
export function migrateStartingInventoryIfInstalled(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): StartingInventoryBootCheck {
  if (!startingInventoryMigrationInstalled(db)) {
    return {
      applied: false,
      version: STARTING_INVENTORY_MIGRATION_VERSION,
      checksum: '',
      drift: false,
      installed: false,
    };
  }
  return { ...migrateStartingInventory(db, nowMs, ddlPath), installed: true };
}

/** 一行台账 = 一个玩家已领过起始背包。 */
export interface StartingInventoryGrantRecord {
  user_id: string;
  /** 发放**当时**的起始包版本号(`STARTING_INVENTORY_VERSION`)。 */
  version: number;
  granted_at: number;
}

/**
 * **纯读**:这个 id 领过起始背包吗(领过 ⇒ 那一行;没领过 / 表还没建 ⇒ `undefined`)。
 *
 * 与归档的读口同一处置:只有 `no such table` 这一种错误被降级成「没有记录」
 * (旧库还没跑过本段迁移 —— 那是「未领」,不是故障),其余错误照旧冒泡
 * (否则一次磁盘/权限故障会被伪装成「没领过」⇒ 重发一份)。
 */
export function readStartingInventoryGrant(
  db: DbLike,
  userId: string,
): StartingInventoryGrantRecord | undefined {
  if (typeof userId !== 'string' || userId.length === 0) return undefined;
  let row: Row | undefined;
  try {
    row = db.get(STARTING_INVENTORY_TABLE, { user_id: userId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return undefined;
    throw e;
  }
  if (!row) return undefined;
  const version = Number(row.version);
  return {
    user_id: String(row.user_id),
    version: Number.isFinite(version) ? version : 0,
    granted_at: Number(row.granted_at) || 0,
  };
}

/**
 * **占位**:把「这个 id 已领过起始背包」写进库。
 *
 * ## 返回值是判据的一部分
 * ```
 * true   这一次**我方**写成功了 ⇒ 调用方保留刚发出去的那一份
 * false  已经有行(主键冲突)⇒ ★ 另一个房间实例 / 进程 / 上一次进程已经发过
 *        ⇒ 调用方必须**撤回自己刚发的那一份**(不留半态)
 * ```
 * 「有行就返回 false」而不是「有行先查一次再写」:查-写之间就是竞态窗口,而
 * `INSERT` + 主键唯一约束是**原子**的 —— 「并发两次 join 只发一份」靠的是这一条,
 * 不是靠调用方的谨慎。
 *
 * 漂移 ⇒ **fail-closed 抛错**(调用方撤回已发出的那一份并如实记 `FAILED`):
 * 台账写不进去时继续发,就等于退化成改前的「每个进程各发一份」。
 */
export function claimStartingInventoryGrant(
  db: DbLike,
  userId: string,
  version: number,
  nowMs: number,
): boolean {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('起始背包台账需要非空 userId');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`起始背包版本号必须是 ≥1 的整数(实得 ${String(version)})`);
  }
  if (!Number.isFinite(nowMs)) throw new Error('起始背包台账需要 nowMs(Unix 毫秒)');
  const migration = migrateStartingInventory(db, nowMs);
  if (migration.drift) {
    throw new Error(
      `起始背包台账迁移 checksum 漂移(schema_migrations.version=${STARTING_INVENTORY_MIGRATION_VERSION}`
      + ' 的登记与 schema_starting_inventory.sql 对不上)⇒ 拒绝写入(不静默降级):'
      + '台账是「已发」的唯一真值,结构没判清就写,重启后会变成重发或永不发',
    );
  }
  try {
    db.insert(STARTING_INVENTORY_TABLE, {
      user_id: userId,
      version: Math.trunc(version),
      granted_at: nowMs,
    });
    return true;
  } catch (e) {
    /* 两个后端的主键冲突措辞:MemoryDb「xxx 主键冲突:...」/ SQLite
       「UNIQUE constraint failed: ...」。**只**把这两种当「已领」,其余错误照抛
       (磁盘故障不能伪装成「别人发过了」)。 */
    const msg = (e as Error)?.message ?? '';
    if (/主键冲突|UNIQUE constraint failed/i.test(msg)) return false;
    throw e;
  }
}

/**
 * **删掉一条台账**(入场失败撤回时用)。
 *
 * ⚠️ 调用方**只许删自己写成功的那条**(见 §14 段头)。表还没建 ⇒ 0
 * (没有行可删,不是故障)。
 */
export function releaseStartingInventoryGrant(db: DbLike, userId: string): number {
  if (typeof userId !== 'string' || userId.length === 0) return 0;
  try {
    return db.delete(STARTING_INVENTORY_TABLE, { user_id: userId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return 0;
    throw e;
  }
}

/** 台账行数(诊断 / 判据的观测口径;表还没建 ⇒ 0)。 */
export function countStartingInventoryGrants(db: DbLike): number {
  try {
    return db.select(STARTING_INVENTORY_TABLE).length;
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return 0;
    throw e;
  }
}

/* ═══════════ 15. 玩家背包账落库(按件账 + 总量账)═══════════
 *
 * ## 缺陷形态(本轮修点,A4)
 *
 * 自动存档此前只保证「起始包**不重发**」—— 那是 `user_starting_inventory`
 * 台账(§14),它回答的是「发过没有」,**不是**「手里有什么」。
 * 而背包账全在房间内存里(`room.ts` 的 `itemCounts` / `inventoryTotals`),
 * 库里两个可能的落点**都没有生产写口**:
 * ```text
 * users.inventory_json   createUser 写 '{}' 之后再没有写点
 * ai_item_instances      addItemInstance 只有测试调用
 * ```
 * ⇒ 收下起始包、采集、合成……全在内存,进程一停背包回到空,
 *   而且**没有任何东西会红**(库里那一行还在,只是从未变过)。
 * 「自动存档」这句话在背包这一维上是空的。
 *
 * ## 落点为什么是 `users.inventory_json`(既有列,不加表)
 * ```text
 * 1 契约 §2.3 第 8 项的**明细权威**就是它(见 room.ts 的投影表);
 * 2 表数与迁移版本集合被既有判据逐行锁着(见 §13 / §14 的说明:
 *   WS-07 锁建表数、WS-FND-156 断言加入口后 schema_migrations 仍是 [1, 3])
 *   ⇒ 新表 / 新迁移会当场把它们打红;
 * 3 既有列 + 既有行 = 「一个玩家一份账」,与 `users.hp`(§11)同一形状。
 * ```
 *
 * ## 账格式(键序固定 ⇒ 同一份账写成**逐字节相同**的 JSON)
 * ```json
 * { "$v": 1, "$total": 10, "101": 7, "116": 3 }
 * ```
 *   · **数字键** = 按件账(itemId → 件数,只写 > 0 的项):与契约里那份
 *     `{"101":20,"116":5}` **同形**,旧读者(若有)读到的仍是明细;
 *   · `$total` = **总量账**(调用方给的原值,**不在这里重算**):
 *     两账分开存才能**对账** —— 读口把「`$total` 与 Σ明细 不一致」如实报成
 *     `drift`,而不是替它圆场(那正是本仓反复点名的静默改数);
 *   · `$v` = 账格式版本。读不懂的版本 ⇒ `undefined`(**不猜**),理由见
 *     `loadPlayerLedger`。
 *
 * ## 坏条目:跳过 + 计数,不抛
 * `itemId` 非正整数 / 件数非正有限整数 ⇒ 跳过并计入 `dropped`;
 * 条目数超 `PLAYER_LEDGER_ITEM_MAX` ⇒ 按 itemId 升序截断,余下计入 `dropped`。
 * 抛错会让「一个坏条目」把**整份存档**连坐丢掉(与 `totalItemsOf` 同源取舍)。
 */

/** 玩家背包账的**账格式版本**(落进 `users.inventory_json` 的 `$v`)。 */
export const PLAYER_LEDGER_VERSION = 1;

/** 总量账在 JSON 里的保留键。非数字键 ⇒ 结构上不可能与 itemId 撞。 */
export const PLAYER_LEDGER_TOTAL_KEY = '$total';

/** 账格式版本在 JSON 里的保留键。 */
export const PLAYER_LEDGER_VERSION_KEY = '$v';

/** 单玩家**落库条目上限**(防「一个玩家把库写爆」)。超出按 itemId 升序截断。 */
export const PLAYER_LEDGER_ITEM_MAX = 4096;

/**
 * 一次落库的输入:一个玩家的两份账。
 *
 * ⚠️ `counts` 收 `ReadonlyMap`(房间侧的既有形状),`total` 是**独立的一份账**
 * (房间侧 `inventoryTotals`,增量式)—— 不在这里由明细重算,
 * 否则「两账已经漂了」这件事会被写库这一步悄悄抹平。
 */
export interface PlayerLedgerSnapshot {
  readonly counts: ReadonlyMap<number, number>;
  readonly total: number;
}

/** 一个玩家的落库结果。`row === 0` = 库里没有这个 `users` 行 ⇒ 这次**没落地**。 */
export interface PlayerLedgerWriteReport {
  /** `UPDATE users` 的影响行数。 */
  row: number;
  /** 写进 JSON 的按件条目数。 */
  kept: number;
  /** 被跳过的坏条目数(非整数 id / 非正件数 / 超条目上限)。 */
  dropped: number;
  /** 实际写下的总量账(非法输入按 0 写)。 */
  total: number;
}

/** 读回的一份账(与 `PlayerLedgerSnapshot` 对偶,+ 两个诊断量)。 */
export interface PlayerLedgerRead {
  readonly counts: Map<number, number>;
  /** 库里那个 `$total`(读不出来时退化为 Σ明细 —— 见 `drift`)。 */
  readonly total: number;
  /** `true` = 库里两账**不一致**(总量账漂了)。读口如实报,不替它圆场。 */
  readonly drift: boolean;
  readonly version: number;
}

/**
 * 序列化一份账(唯一实现;`savePlayerLedgers` 用它)。
 *
 * 键序固定(`$v` → `$total` → itemId 升序)⇒ **同一份账两次落库逐字节相同**,
 * 于是「存档幂等」这条能按字节断言,而不是按「字段在不在」断言。
 */
function serializePlayerLedger(
  ledger: PlayerLedgerSnapshot,
): { json: string; kept: number; dropped: number; total: number } {
  const entries: [number, number][] = [];
  let dropped = 0;
  for (const [rawId, rawQty] of ledger.counts) {
    const id = typeof rawId === 'number' ? rawId : Number(rawId);
    const qty = typeof rawQty === 'number' ? rawQty : Number(rawQty);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) {
      dropped += 1;
      continue;
    }
    entries.push([id, Math.trunc(qty)]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  if (entries.length > PLAYER_LEDGER_ITEM_MAX) {
    dropped += entries.length - PLAYER_LEDGER_ITEM_MAX;
    entries.length = PLAYER_LEDGER_ITEM_MAX;
  }
  const rawTotal = ledger.total;
  const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? Math.trunc(rawTotal) : 0;
  const obj: Record<string, number> = {
    [PLAYER_LEDGER_VERSION_KEY]: PLAYER_LEDGER_VERSION,
    [PLAYER_LEDGER_TOTAL_KEY]: total,
  };
  let kept = 0;
  for (const [id, qty] of entries) {
    obj[String(id)] = qty;
    kept += 1;
  }
  return { json: JSON.stringify(obj), kept, dropped, total };
}

/**
 * 解析一份账(外部输入 ⇒ **容错**),读不懂的形态一律 `undefined`。
 *
 * ## 为什么版本号不认识就返回 `undefined`(而不是「尽量读」)
 * 账格式将来会变;`$v` 不认识说明写它的程序与读它的程序**不是同一版**。
 * 按当前口径硬读会把「另一版格式」读成一份**看起来正常**的账,
 * ⇒ 玩家背包被静默改写。⇒ 不猜:当作「没有账」,由调用方走「新玩家」那条路。
 *
 * ## `drift` 的口径
 * `$total` 读得出且与 Σ明细 不等 ⇒ `true`(两份账漂了);
 * `$total` 读不出(缺失/非法)⇒ 以 Σ明细为总量,且**不**报 drift
 * (那时「以明细为准」是唯一可解释的选择,不是漂移)。
 */
function parsePlayerLedger(raw: unknown): PlayerLedgerRead | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const version = Number(obj[PLAYER_LEDGER_VERSION_KEY]);
  if (!Number.isInteger(version) || version !== PLAYER_LEDGER_VERSION) return undefined;
  const counts = new Map<number, number>();
  let sum = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (key === PLAYER_LEDGER_VERSION_KEY || key === PLAYER_LEDGER_TOTAL_KEY) continue;
    const id = Number(key);
    const qty = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) continue;
    counts.set(id, Math.trunc(qty));
    sum += Math.trunc(qty);
  }
  const storedTotal = Number(obj[PLAYER_LEDGER_TOTAL_KEY]);
  const readable = Number.isInteger(storedTotal) && storedTotal >= 0;
  return {
    counts,
    total: readable ? storedTotal : sum,
    drift: readable ? storedTotal !== sum : false,
    version,
  };
}

/**
 * 批量落库玩家背包账(唯一写口;一次调用 = **一个事务**)。
 *
 * ## 与 `saveVitalsToUsers`(§11)**逐条同款**的三点
 * ```text
 * 1 skipped 而不是抛错:DB 里没有 users 行是**正常**情形(尚未建号的访客 /
 *   测试里的模拟 id)—— 一个人的缺失不该把整批存档连坐丢掉;
 *   但它**必须可观测**(返回值),否则门禁会失去分辨力;
 * 2 一次事务:第 3 个人写失败时前 2 个不许已经落库(半截存档不可重试);
 * 3 每个 id 只写**一份**账(`users.inventory_json` 覆盖写),不做第二份真值。
 * ```
 *
 * ⚠️ `updated_at` 一并推进:这一行的内容确实变了(与 `savePlayerState` 同口径)。
 */
export function savePlayerLedgers(
  db: DbLike,
  ledgers: ReadonlyMap<string, PlayerLedgerSnapshot>,
  nowMs: number,
): { saved: number; skipped: number; rows: number; dropped: number } {
  return db.transaction(() => {
    let saved = 0;
    let skipped = 0;
    let rows = 0;
    let dropped = 0;
    /* 按键排序 ⇒ 写入顺序确定(同一份账两次落库的影响行数与字节完全一致)。 */
    for (const userId of [...ledgers.keys()].sort()) {
      const ledger = ledgers.get(userId);
      if (ledger === undefined || typeof userId !== 'string' || userId.length === 0) {
        skipped += 1;
        continue;
      }
      if (!getUser(db, userId)) {
        skipped += 1;
        continue;
      }
      const ser = serializePlayerLedger(ledger);
      rows += db.update('users', { id: userId }, {
        inventory_json: ser.json,
        updated_at: nowMs,
      });
      saved += 1;
      dropped += ser.dropped;
    }
    return { saved, skipped, rows, dropped };
  });
}

/**
 * 读回一个玩家的背包账(与 `savePlayerLedgers` 对偶)。
 *
 * `undefined` 的三种含义**互不相同**,调用方按同一处置(「他没有可用的账」),
 * 但它们各自的成因写在这里,免得下一次有人把它们压成一个:
 * ```text
 * 1 没有这个 users 行             ⇒ 还没建号
 * 2 inventory_json 还是 '{}'      ⇒ 从来没有存过背包(新玩家)
 * 3 格式读不懂(JSON 坏 / $v 不认识)⇒ 不猜(见 parsePlayerLedger)
 * ```
 * 三种都**不是**「背包是空的」这个断言 —— 「空背包」的形态是
 * `counts.size === 0 && total === 0` 且 `version` 认识。
 */
export function loadPlayerLedger(db: DbLike, userId: string): PlayerLedgerRead | undefined {
  if (typeof userId !== 'string' || userId.length === 0) return undefined;
  const row = getUser(db, userId);
  if (!row) return undefined;
  return parsePlayerLedger(row.inventory_json);
}
/* ═══════════ 17. 房间系统台账(WS-FND-165:结算幂等跨进程)═══════════
 *
 * ## 修前形态(B1 审计实测)
 *
 * `WorldSim` 的 `roomSystemsState.settled`(幂等键集)与 `roomDayIndex`(房内第几天)
 * **只活在字段里**:进程一停就归零 ⇒ 同一个 `orderId`(百货 / 炼金)可以**再成交一次**,
 * 牧场「第 0 天」也会**再结算一次** —— 而这两条都是钱,不是显示问题。
 *
 * ## 落点为什么是**独立的旁表**(理由与 §13/§14 同源)
 *
 * `schema.sql` 的 checksum 已登记在既有库的 `schema_migrations`(version = 1):
 * 往 `rooms` 上加一列会改掉整份 schema.sql 的 checksum ⇒ **每一个旧库**启动即 drift
 * 并 fail-closed 拒绝启动。故走自己的 DDL 文件 + 自己的迁移版本(4):
 * 老库(v1 / v2 / v3 任意组合)**原地补表**,既有表与既有行一个都不动。
 *
 * ## 写入侧的容错纪律与 §15(背包账)不同
 *
 * 背包账读不回来只影响一个人;而幂等键集读不回来会**重开重放窗口** ⇒
 * 这里把「读不懂」**如实分类**返回(调用方按 `reason` 记录/断言),
 * **不猜成「没有台账」**,也**不抛**(抛会让整间房起不来)。
 */

/** 台账表名(与 DDL 文件里那张表逐字一致)。 */
export const ROOM_SYSTEMS_TABLE = 'room_systems_state';

/** 台账 DDL 的文件产物名。**独立于 `schema.sql`**(理由见该 SQL 的文件头)。 */
export const ROOM_SYSTEMS_SCHEMA_FILE_NAME = 'schema_room_systems.sql';

/** 台账迁移在 `schema_migrations` 里的版本号(基线 1 / 归档 2 / 起始包 3 / 本表 4)。 */
export const ROOM_SYSTEMS_MIGRATION_VERSION = 4;
export const ROOM_SYSTEMS_MIGRATION_NAME = 'ws_fnd165_room_systems_state';

/** `settled_json` 的**格式版本**(落进 JSON 的 `$v`;不认识的版本一律不猜)。 */
export const ROOM_SYSTEMS_STATE_VERSION = 1;
/** 格式版本键(与背包账的 `$v` 同名同义)。 */
export const ROOM_SYSTEMS_VERSION_KEY = '$v';

/**
 * 键集上限(`settled_json` 里最多带几个键)。
 *
 * 口径与 `systems/idempotency.ts:SETTLEMENT_LEDGER_CAPACITY` **一致**(4096):
 * 内存台账的容量就是它,落库侧比内存更宽毫无意义;比内存更窄则会**静默丢掉**
 * 内存里还在的键 ⇒ 重启后那条键又能重放一次。取「与内存一致」是唯一不引入
 * 第二个数字的取法 ⇒ 这里**不**新造调参。
 */
export const ROOM_SYSTEMS_MAX_KEYS = 4096;

/** 台账 DDL 全文(用真实文件路径读,与 `readSchemaSql` 同一做法)。 */
export function roomSystemsSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), ROOM_SYSTEMS_SCHEMA_FILE_NAME);
}

export function readRoomSystemsSql(path: string = roomSystemsSqlPath()): string {
  return readFileSync(path, 'utf8');
}

/** 一条结算键:`key` = 幂等键(`ECO_RANCH@DAY:7`),`at` = 首次成功结算的逻辑时刻。 */
export interface RoomSystemsKeyEntry {
  key: string;
  at: number;
}

/** 一间房的房间系统台账快照(落库形状;与 `WorldSim.exportRoomSystemsSnapshot` 对偶)。 */
export interface RoomSystemsSnapshot {
  /** 房内「第几天」(0 起整数;非法值在写入侧静默钳到 0)。 */
  dayIndex: number;
  /** 结算键集,**按入账顺序**(读回时还原 FIFO 淘汰序)。 */
  keys: readonly RoomSystemsKeyEntry[];
}

/**
 * 读回结果。`ok:false` 的三种成因**互不相同**,刻意不压成一个 `undefined`:
 * ```text
 * no-table  这个库从没存过房间系统状态(老库 / 全新库)   —— 正常
 * no-row    这间房没有台账行(第一次跑)                 —— 正常
 * corrupt   有一行但内容读不懂(JSON 坏 / $v 不认识)     —— **必须可断言**:
 *           它意味着「重放窗口可能是开的」,不许静默当成「没有台账」
 * ```
 * `dropped` 是**逐条**被丢掉的键数(单条脏数据只影响那一条,不拖垮整份台账)。
 */
export type RoomSystemsRead =
  | { ok: true; state: RoomSystemsSnapshot; dropped: number }
  | { ok: false; reason: 'no-table' | 'no-row' | 'corrupt'; dropped: number };

export interface RoomSystemsMigrateResult {
  applied: boolean;
  version: number;
  checksum: string;
  /** 已存在同版本但 checksum 不一致 = 漂移(调用方决定是否 fail-closed)。 */
  drift: boolean;
}

/**
 * 建台账表 + 登记迁移版本。**幂等**(DDL 全是 `CREATE TABLE IF NOT EXISTS`)。
 *
 * 判序与 §13/§14 逐字相同:「先读版本 → 护栏 → 漂移 → 才 exec DDL」——
 * 对旧库先 exec 会在发现结构不认识之前**已经动过库**。
 */
export function migrateRoomSystems(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): RoomSystemsMigrateResult {
  const ddl = readRoomSystemsSql(ddlPath);
  const checksum = checksumOf(ddl);
  const rows = readMigrationRows(db);
  assertMigrationVersionSupported(rows.map((r) => (r as MigrationRow).version));
  const existing = rows.find(
    (r) => Number((r as MigrationRow).version) === ROOM_SYSTEMS_MIGRATION_VERSION,
  ) as MigrationRow | undefined;
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: ROOM_SYSTEMS_MIGRATION_VERSION, checksum, drift: true };
  }
  db.exec(ddl);
  if (existing) {
    return { applied: false, version: ROOM_SYSTEMS_MIGRATION_VERSION, checksum, drift: false };
  }
  db.insert('schema_migrations', {
    version: ROOM_SYSTEMS_MIGRATION_VERSION,
    name: ROOM_SYSTEMS_MIGRATION_NAME,
    checksum,
    applied_at: nowMs,
  });
  return { applied: true, version: ROOM_SYSTEMS_MIGRATION_VERSION, checksum, drift: false };
}

/** 这个库里**装过**房间系统台账迁移吗(登记行在 ⇒ 装过)。 */
export function roomSystemsMigrationInstalled(db: DbLike): boolean {
  const rows = readMigrationRows(db);
  return rows.some((r) => Number((r as MigrationRow).version) === ROOM_SYSTEMS_MIGRATION_VERSION);
}

/** `migrateRoomSystemsIfInstalled` 的结果(比迁移结果多一个 `installed`)。 */
export interface RoomSystemsBootCheck extends RoomSystemsMigrateResult {
  /** `false` = 这个库从没装过本台账 ⇒ 本轮**没有**建它(见函数注释)。 */
  installed: boolean;
}

/**
 * **启动检查**:装过本迁移的库 ⇒ 跑一遍(幂等 DDL + checksum 漂移检测);
 * 没装过的库 ⇒ 什么都不做(全新库不许在这里多出一张表 —— 建表数被既有判据锁着)。
 */
export function migrateRoomSystemsIfInstalled(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): RoomSystemsBootCheck {
  if (!roomSystemsMigrationInstalled(db)) {
    return {
      applied: false, version: ROOM_SYSTEMS_MIGRATION_VERSION,
      checksum: '', drift: false, installed: false,
    };
  }
  return { ...migrateRoomSystems(db, nowMs, ddlPath), installed: true };
}

/** 把一份快照序列化成落库字节(唯一实现;顺序即入账顺序)。 */
function serializeRoomSystems(snapshot: RoomSystemsSnapshot): {
  dayIndex: number; json: string; keys: number; dropped: number;
} {
  const dayIndex = Number.isFinite(snapshot.dayIndex) && snapshot.dayIndex > 0
    ? Math.trunc(snapshot.dayIndex)
    : 0;
  let dropped = 0;
  const seen = new Set<string>();
  const keys: RoomSystemsKeyEntry[] = [];
  for (const raw of snapshot.keys ?? []) {
    const key = typeof raw?.key === 'string' ? raw.key.trim() : '';
    const at = Number.isFinite(raw?.at) ? Math.trunc(raw.at) : 0;
    if (key === '') { dropped += 1; continue; }
    /* 同一键只留**一条**(去重不合并:值只用于报错,不参与判定)。 */
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    keys.push({ key, at });
  }
  /* 超上限 ⇒ 丢**最老**的(与内存台账的 FIFO 淘汰同一取法:能重放的只可能在最近这一端)。 */
  while (keys.length > ROOM_SYSTEMS_MAX_KEYS) { keys.shift(); dropped += 1; }
  return {
    dayIndex,
    keys: keys.length,
    dropped,
    json: JSON.stringify({
      [ROOM_SYSTEMS_VERSION_KEY]: ROOM_SYSTEMS_STATE_VERSION,
      keys,
    }),
  };
}

/**
 * 写一间房的房间系统台账(第一次写会**就地补表**并登记 v4)。
 *
 * ## 返回值都是判据
 * ```text
 * row      实际写入行数(1 = 落地;0 = 行在一次读-写之间消失,不该发生 ⇒ 可断言)
 * keys     真正落库的键数(超上限时小于入参 —— 「丢了几个」在 dropped 里)
 * dropped  输入侧被丢掉的条目数(空键 / 重复键 / 超上限)
 * ```
 * 漂移 ⇒ **fail-closed 抛错**:判据建在没核对过的结构上,比「这一次没存」更坏。
 */
export function saveRoomSystemsState(
  db: DbLike,
  roomId: string,
  snapshot: RoomSystemsSnapshot,
  nowMs: number,
): { row: number; keys: number; dropped: number } {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new Error('房间系统台账需要非空 roomId');
  }
  if (!Number.isFinite(nowMs)) throw new Error('房间系统台账需要 nowMs(Unix 毫秒)');
  const migration = migrateRoomSystems(db, nowMs);
  if (migration.drift) {
    throw new Error(
      `房间系统台账迁移 checksum 漂移(schema_migrations.version=${ROOM_SYSTEMS_MIGRATION_VERSION}`
      + ' 的登记与 schema_room_systems.sql 对不上)⇒ 拒绝写入(不静默降级):'
      + '它记的是「哪几张单已结算」,结构没判清就写,重启后会变成可重复结算',
    );
  }
  const ser = serializeRoomSystems(snapshot);
  const patch: Row = {
    day_index: ser.dayIndex,
    settled_json: ser.json,
    key_count: ser.keys,
    saved_at: nowMs,
  };
  const existing = db.get(ROOM_SYSTEMS_TABLE, { room_id: roomId });
  if (existing === undefined) {
    db.insert(ROOM_SYSTEMS_TABLE, { room_id: roomId, ...patch });
    return { row: 1, keys: ser.keys, dropped: ser.dropped };
  }
  const row = db.update(ROOM_SYSTEMS_TABLE, { room_id: roomId }, patch);
  return { row, keys: ser.keys, dropped: ser.dropped };
}

/**
 * 读回一间房的房间系统台账(与 `saveRoomSystemsState` 对偶)。
 *
 * 只有 `no such table` 被降级成 `no-table`(老库还没跑过本段迁移 —— 那是
 * 「从没存过」,不是故障);其余错误照旧冒泡(否则一次磁盘故障会被伪装成
 * 「没有台账」⇒ 重放窗口静默打开)。
 */
export function loadRoomSystemsState(db: DbLike, roomId: string): RoomSystemsRead {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    return { ok: false, reason: 'no-row', dropped: 0 };
  }
  let row: Row | undefined;
  try {
    row = db.get(ROOM_SYSTEMS_TABLE, { room_id: roomId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) {
      return { ok: false, reason: 'no-table', dropped: 0 };
    }
    throw e;
  }
  if (!row) return { ok: false, reason: 'no-row', dropped: 0 };
  const dayRaw = Number(row.day_index);
  const dayIndex = Number.isFinite(dayRaw) && dayRaw > 0 ? Math.trunc(dayRaw) : 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.settled_json ?? ''));
  } catch {
    return { ok: false, reason: 'corrupt', dropped: 0 };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'corrupt', dropped: 0 };
  }
  const env = parsed as Record<string, unknown>;
  if (Number(env[ROOM_SYSTEMS_VERSION_KEY]) !== ROOM_SYSTEMS_STATE_VERSION) {
    return { ok: false, reason: 'corrupt', dropped: 0 };
  }
  if (!Array.isArray(env.keys)) return { ok: false, reason: 'corrupt', dropped: 0 };
  let dropped = 0;
  const seen = new Set<string>();
  const keys: RoomSystemsKeyEntry[] = [];
  for (const raw of env.keys as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { dropped += 1; continue; }
    const e = raw as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (key === '' || seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    keys.push({ key, at: Number.isFinite(Number(e.at)) ? Math.trunc(Number(e.at)) : 0 });
  }
  while (keys.length > ROOM_SYSTEMS_MAX_KEYS) { keys.shift(); dropped += 1; }
  return { ok: true, state: { dayIndex, keys }, dropped };
}

/* ═══════════ 18. 玩家快照(WS-FND-165:等级 / 经验 / 天赋 / 位置 / 血量)═══════════
 *
 * ## 修前形态(B1 审计实测)
 * ```text
 * users.exp / users.talent_json   生产 **0 写入**(createUser 之后就再没有写点)
 * users.level / pos_x / pos_y / hp 只在 join / 断线那一刻定格(走重连快照那条路)
 * ⇒ 进程崩在两次入场之间:这一段期间的经验、等级、位置、血量**全丢**
 * ```
 * 本节是**周期存档**要用的批量写口:等级 / 经验 / 天赋 / 位置 / 血量 一次事务落库。
 *
 * ## 为什么不另写一份 UPDATE
 * 单行写入复用 `savePlayerState` —— 数值钳制、`updated_at`、「users 行是否存在」
 * 都已经在那里有唯一实现 ⇒ 本节只做「批量 + 事务 + 计数」,不引入第二份字段口径。
 */

/** 一名玩家的快照行(结构化:调用方不必 import 模拟层类型)。 */
export interface PlayerSnapshotRow {
  userId: string;
  level: number;
  exp: number;
  hp: number;
  x: number;
  y: number;
  z: number;
  /** 已解锁天赋 id 列表(`users.talent_json`)。**省略** ⇒ 不碰那一列。 */
  /** 已解锁天赋 id 列表(`users.talent_json`)。**省略** ⇒ 不碰那一列。 */
  talent?: readonly string[];
  /**
   * ★ WS-FND-168:朝向(`users.dir`,0..3)。**省略** ⇒ 不碰那一列。
   * 「没带这一项」与「他朝向 0」是两件事(与 `talent` 同一纪律)。
   */
  dir?: number;
  /** ★ WS-FND-168:手持物 id(`users.held_item_id`)。`null` = 明确空手;`省略` = 不碰。 */
  heldItemId?: number | null;
  /**
   * ★ WS-FND-168:装备物品 id(**不含武器** —— 那件已由重连快照 `snapshot_blob`
   * 承载,见 `world_sim.ts:restoreFromProfile`)。
   * 落 `player_equipment_state`(§20 的独立 DDL);`省略` ⇒ 不碰那一行。
   */
  equipment?: readonly number[];
}

/** 快照里最多记几个天赋 id(内容层今天 6 个;给将来留余量,不是玩法调参)。 */
export const PLAYER_SNAPSHOT_MAX_TALENTS = 64;

/**
 * ★ WS-FND-168:一名玩家的**非武器装备**上限(实战 ≤ 7 个槽;留余量,不是玩法调参)。
 * 超出按升序截断并计入 `dropped`(与 `PLAYER_LEDGER_ITEM_MAX` 同一处置)。
 */
export const PLAYER_EQUIPMENT_MAX = 64;

/**
 * 批量落盘玩家快照(周期存档的写口)。
 *
 * ## 三条纪律
 * ```text
 * 1 一次事务:第 3 个人写失败时前 2 个不许已经落库(半截存档不可重试)
 * 2 「没有 users 行」= skipped,不是错误(访客 id 只活在房间/世界侧)
 * 3 数值一律**静默钳制**(level 1..30 / exp ≥ 0 / hp ≥ 0 / 坐标非有限 ⇒ 0):
 *   这些是战斗与移动里高频变化的派生量,抛错会让一次落盘连带丢整个事务
 * ```
 * `talent_json` 只在**明确给了** `talent` 时写 —— 「没带这一项」与「他一个天赋
 * 都没有」是两件事,省缺省值把后者写成前者就是静默改数。
 */
export function savePlayerSnapshots(
  db: DbLike,
  rows: readonly PlayerSnapshotRow[],
  nowMs: number,
): { saved: number; skipped: number; dropped: number } {
  if (!Number.isFinite(nowMs)) throw new Error('玩家快照需要 nowMs(Unix 毫秒)');
  /* ★ WS-FND-168:装备那一段要 `player_equipment_state`(§20)。迁移**放在事务之前**
     —— DDL 不该出现在一个写事务里(那是两个不同层级的操作)。只在**确实带了
     equipment** 时才动库:老调用方(不带装备)逐字兼容,连迁移都不触发。 */
  if (rows.some((r) => r?.equipment !== undefined)) {
    const m = migrateRoomRuntime(db, nowMs);
    if (m.drift) {
      throw new Error(
        `房间运行时状态迁移 checksum 漂移(schema_migrations.version=${ROOM_RUNTIME_MIGRATION_VERSION}`
        + ' 与 schema_room_runtime.sql 对不上)⇒ 拒绝写入玩家装备(不静默降级)',
      );
    }
  }
  return db.transaction(() => {
    let saved = 0;
    let skipped = 0;
    let dropped = 0;
    /* 按 id 排序 ⇒ 写入顺序确定(同一份快照两次落库的行数与字节完全一致)。 */
    const sorted = [...rows].sort((a, b) => String(a?.userId).localeCompare(String(b?.userId)));
    for (const r of sorted) {
      const id = typeof r?.userId === 'string' ? r.userId : '';
      if (id === '' || !getUser(db, id)) { skipped += 1; continue; }
      const patch: Partial<PlayerRecord> = {
        level: clampIntQuiet(r.level, 1, MAX_LEVEL),
        exp: Math.max(0, Math.trunc(Number.isFinite(r.exp) ? r.exp : 0)),
        hp: Number.isFinite(r.hp) ? Math.trunc(r.hp) : 0,
        pos_x: Number.isFinite(r.x) ? r.x : 0,
        pos_y: Number.isFinite(r.y) ? r.y : 0,
        pos_z: Number.isFinite(r.z) ? r.z : 0,
      };
      if (r.talent !== undefined) {
        const seen = new Set<string>();
        for (const t of r.talent) {
          const tid = typeof t === 'string' ? t.trim() : '';
          if (tid === '' || seen.has(tid) || seen.size >= PLAYER_SNAPSHOT_MAX_TALENTS) {
            dropped += 1;
            continue;
          }
          seen.add(tid);
        }
        patch.talent_json = JSON.stringify([...seen]);
      }
      /* ★ WS-FND-168:朝向与手持物**只在明确给了**时写(与 talent 同一纪律:
         「没带这一项」与「他朝向 0 / 空手」是两件事)。 */
      if (r.dir !== undefined) patch.dir = clampIntQuiet(r.dir, 0, 3);
      if (r.heldItemId !== undefined) {
        const held = r.heldItemId;
        patch.held_item_id = typeof held === 'number' && Number.isInteger(held) && held >= 0
          ? Math.trunc(held)
          : null;
      }
      savePlayerState(db, id, patch, nowMs);
      /* ★ WS-FND-168:装备(非武器)落 `player_equipment_state`(独立表)。
         省略 `equipment` ⇒ 不碰那一行(与 `talent_json` 同一取舍)。 */
      if (r.equipment !== undefined) {
        const eq = savePlayerEquipmentState(db, id, r.equipment, nowMs);
        dropped += eq.dropped;
      }
      saved += 1;
    }
    return { saved, skipped, dropped };
  });
}

/**
 * 读回玩家快照(与 `savePlayerSnapshots` 对偶)。
 *
 * 只读**显式给出的** ID:把全表用户读进来会让「谁该被还原」取决于库里恰好有谁
 * (与 `loadVitalsFromUsers` 同一理由)。不存在的行 / 读不懂的 `talent_json`
 * 一律降级(`talent: []`),不让一行脏数据把读档整体拖垮(与 `parsePlayerLedger`
 * 同一取舍,但**方向相反**:这里是「读不回来就当他没天赋」,而背包账读不回来
 * 会**拒绝覆盖**(见 §15)—— 因为装备丢了会白嫖,天赋丢了只是少个被动)。
 */
export function loadPlayerSnapshots(db: DbLike, ids: readonly string[]): PlayerSnapshotRow[] {
  const out: PlayerSnapshotRow[] = [];
  for (const id of [...ids].sort()) {
    const u = getUser(db, id);
    if (!u) continue;
    let talent: string[] = [];
    try {
      const parsed = JSON.parse(String(u.talent_json ?? '[]'));
      if (Array.isArray(parsed)) {
        talent = parsed.filter((t): t is string => typeof t === 'string' && t !== '');
      }
    } catch { talent = []; }
    const row: PlayerSnapshotRow = {
      userId: u.id,
      level: clampIntQuiet(u.level, 1, MAX_LEVEL),
      exp: Number.isFinite(Number(u.exp)) ? Math.max(0, Math.trunc(Number(u.exp))) : 0,
      hp: Number.isFinite(Number(u.hp)) ? Math.trunc(Number(u.hp)) : 0,
      x: Number.isFinite(Number(u.pos_x)) ? Number(u.pos_x) : 0,
      y: Number.isFinite(Number(u.pos_y)) ? Number(u.pos_y) : 0,
      z: Number.isFinite(Number(u.pos_z)) ? Number(u.pos_z) : 0,
      talent,
    };
    /* ★ WS-FND-168:朝向 / 手持物 / 装备(读不懂的装备一律降级成 [],
       与 talent 同一取舍:装不回来只是少件被动,不许把整次读档拖垮)。 */
    row.dir = clampIntQuiet(u.dir, 0, 3);
    row.heldItemId = Number.isInteger(Number(u.held_item_id)) && Number(u.held_item_id) >= 0
      ? Math.trunc(Number(u.held_item_id))
      : null;
    row.equipment = loadPlayerEquipmentState(db, u.id).equipment;
    out.push(row);
  }
  return out;
}

/* ═══════ 19. 世界存档:chunk 脏页 + 屋顶旁路层 + 世界状态(★ WS-FND-164)═══════
 *
 * ## 这一段补的是哪一刀(B1 审计实测的 P0)
 *
 * ```text
 * §7 的 saveChunk / saveChunkBatch / loadChunk 在此之前生产 **0 调用**
 *   ⇒ 进程一停,地形与玩家建造全丢,世界按 seed 从空场重新开始;
 * §13 的归档行(room_world_archives)也只写不读 ⇒ 那份"可回滚快照"没人取得回来。
 * ```
 *
 * 本节只做**存储**:脏页 chunk 的落库/读回、屋顶旁路层、房间级世界状态。
 * 「什么时候存、读回来怎么铺进世界」是宿主(`sim/world_sim.ts` 的
 * `saveToDb` / `restoreWorldFromDb`)的事,本节不认识 `WorldSim`(与 §11/§13 同一分层)。
 *
 * ## 为什么是**独立 DDL + 懒建表**(而不是动 `schema.sql`)
 *
 * 见 `schema_world_persistence.sql` 的文件头:`room_chunks.tiles_blob` 被锁在
 * 恰好 1024 字节(屋顶层不在那 32 位里),而水位是房间级的连续场;
 * 改 `schema.sql` 一个字符就会让**每一个旧库**在启动时判成 checksum drift 并
 * fail-closed。⇒ 走自己的 DDL 产物 + 自己的迁移版本(v5),
 * `migrateWorldPersistence` 在**第一次存档时**跑一次(幂等 DDL),既有库原地升版。
 *
 * ## 三件刻意不做的事
 *
 * 1 **不在这里解水位字节**:`fluid_blob` 的格式(`FLV1`)定义在 `world/fluid.ts`,
 *    本节只当它是一坨带上限的字节(本模块的跨层 import 仍然只有
 *    `world/archive.ts` 那一条,理由见文件头第 1 条)。
 * 2 **不做增量 diff**:脏页的粒度是**整块 1KB**(判据在 `world/chunk.ts` 的
 *    `isSaveDirty`)。按格 diff 会把「一块 1KB 的行」变成「一串补丁」,
 *    而回放补丁需要一条版本链 —— 那是另一套东西,不是本段要修的缺陷。
 * 3 **不主动删旧世代的字节**(除了显式 `forgetRoomWorldSave`):`seed` 变了才清,
 *    见 `WorldStateRecord.seed` 的注释(**读侧**也会比对,不靠写侧自觉)。
 */

/** 本段 DDL 的文件产物名。**独立于 `schema.sql`**(理由见本节头)。 */
export const WORLD_PERSISTENCE_SCHEMA_FILE_NAME = 'schema_world_persistence.sql';

/** 屋顶旁路层表名(与 DDL 文件里那张表逐字一致)。 */
export const CHUNK_ROOFS_TABLE = 'room_chunk_roofs';

/** 世界状态表名(与 DDL 文件里那张表逐字一致)。 */
export const WORLD_STATE_TABLE = 'room_world_state';

/** 本段迁移在 `schema_migrations` 里的版本号(基线 1 / 归档 2 / 台账 3 / 房间系统 4)。 */
export const WORLD_PERSISTENCE_MIGRATION_VERSION = 5;
export const WORLD_PERSISTENCE_MIGRATION_NAME = 'ws_fnd164_world_persistence';

/**
 * 单块屋顶 RLE 的字节上限。
 *
 * 全空块 = 3 字节(256 个零格 = 127 + 127 + 2 的零游程,`encodeRoofRle` 的每段
 * 零游程最多 127 格);满屋顶块 = `256 × 3 = 768` 字节 ⇒ 4096 是「明显不是屋顶层
 * = 坏数据」的闸,不是压缩估计。
 * (与 DDL 里 `length(roofs_blob) <= 4096` 那条 CHECK 同一个数,值只在这里写一次。)
 */
export const ROOFS_BLOB_MAX_BYTES = 4096;

/** 本段 DDL 全文(用真实文件路径读,与 `readSchemaSql` 同一做法)。 */
export function worldPersistenceSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), WORLD_PERSISTENCE_SCHEMA_FILE_NAME);
}

export function readWorldPersistenceSql(path: string = worldPersistenceSqlPath()): string {
  return readFileSync(path, 'utf8');
}

export interface WorldPersistenceMigrateResult {
  applied: boolean;
  version: number;
  checksum: string;
  /** 已存在同版本但 checksum 不一致 = 漂移(写入侧 fail-closed)。 */
  drift: boolean;
}

/**
 * 建两张世界存档表 + 登记迁移版本。**幂等**。
 *
 * 判序与 §13 / §14 逐条相同(审计 P1):「先读版本 → 护栏 → 漂移 → 才 exec DDL」。
 * 漂移 ⇒ 调用方(`WorldSim.saveDirtyChunksToDb`)**拒写** —— 表结构与 DDL 对不上时
 * 写进去的脏页属于哪一版结构没人说得清,而它**正是读档原料**。
 */
export function migrateWorldPersistence(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): WorldPersistenceMigrateResult {
  const ddl = readWorldPersistenceSql(ddlPath);
  const checksum = checksumOf(ddl);
  const rows = readMigrationRows(db);
  assertMigrationVersionSupported(rows.map((r) => (r as MigrationRow).version));
  const existing = rows.find(
    (r) => Number((r as MigrationRow).version) === WORLD_PERSISTENCE_MIGRATION_VERSION,
  ) as MigrationRow | undefined;
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: WORLD_PERSISTENCE_MIGRATION_VERSION, checksum, drift: true };
  }
  db.exec(ddl);
  if (existing) {
    return { applied: false, version: WORLD_PERSISTENCE_MIGRATION_VERSION, checksum, drift: false };
  }
  db.insert('schema_migrations', {
    version: WORLD_PERSISTENCE_MIGRATION_VERSION,
    name: WORLD_PERSISTENCE_MIGRATION_NAME,
    checksum,
    applied_at: nowMs,
  });
  return { applied: true, version: WORLD_PERSISTENCE_MIGRATION_VERSION, checksum, drift: false };
}

/** 这个库里**装过**世界存档迁移吗(登记行在 ⇒ 装过)。 */
export function worldPersistenceInstalled(db: DbLike): boolean {
  const rows = readMigrationRows(db);
  return rows.some((r) => Number((r as MigrationRow).version) === WORLD_PERSISTENCE_MIGRATION_VERSION);
}

/**
 * 屋顶层字节的**唯一**校验口径(写侧;读侧另判长度与可解性)。
 *
 * 抛而不是钳:`roofs_blob` 是读档原料 —— 存进去一个被截断的屋顶层,读回来就是
 * 「这一块没有屋顶」(玩家盖的屋顶静默消失),而写入方拿到的是"成功"。
 * 与 `assertChunkBlob` 同一条取舍。
 */
export function assertRoofsBlob(blob: Uint8Array): void {
  if (!(blob instanceof Uint8Array)) throw new Error('roofs_blob 必须是 Uint8Array');
  if (blob.byteLength === 0) {
    /* 空屋顶层仍然有 3 字节(`encodeRoofRle` 对全零块给出 127+127+2 的零游程)——
       0 字节只可能来自「忘了编码」,不能当成「没有屋顶」放过去。 */
    throw new Error('roofs_blob 不能是 0 字节(全空屋顶层的 RLE 是 3 个零游程字节)');
  }
  if (blob.byteLength > ROOFS_BLOB_MAX_BYTES) {
    throw new Error(
      `roofs_blob ${blob.byteLength} 字节超出上限 ${ROOFS_BLOB_MAX_BYTES}`
      + ' —— 拒绝写入而不是截断(截断的屋顶层读回来就是「这一块没有屋顶」)',
    );
  }
}

/** 写一块屋顶层。行不存在则插入(与 `saveChunk` 同形状)。 */
export function saveChunkRoofs(
  db: DbLike,
  roomId: string,
  chunkX: number,
  chunkY: number,
  roofsBlob: Uint8Array,
  nowMs: number,
): void {
  assertRoofsBlob(roofsBlob);
  const key = { room_id: roomId, chunk_x: chunkX, chunk_y: chunkY };
  if (db.get(CHUNK_ROOFS_TABLE, key)) {
    db.update(CHUNK_ROOFS_TABLE, key, { roofs_blob: roofsBlob, updated_at: nowMs });
    return;
  }
  db.insert(CHUNK_ROOFS_TABLE, {
    room_id: roomId,
    chunk_x: chunkX,
    chunk_y: chunkY,
    roofs_blob: roofsBlob,
    updated_at: nowMs,
  });
}

/** 读一块屋顶层。行不存在 / 字节不是 `Uint8Array` / 超上限 ⇒ `undefined`(不编一个空层)。 */
export function loadChunkRoofs(
  db: DbLike,
  roomId: string,
  chunkX: number,
  chunkY: number,
): Uint8Array | undefined {
  const row = db.get(CHUNK_ROOFS_TABLE, { room_id: roomId, chunk_x: chunkX, chunk_y: chunkY });
  if (row === undefined) return undefined;
  const blob = row.roofs_blob;
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return undefined;
  if (blob.byteLength > ROOFS_BLOB_MAX_BYTES) return undefined;
  return blob;
}

/** 本房间已落盘的地形块坐标(按 (cy, cx) 升序 ⇒ 读档顺序确定、可复现)。表还没建 ⇒ `[]`。 */
export function listRoomChunkCoords(db: DbLike, roomId: string): { cx: number; cy: number }[] {
  let rows: ChunkRecord[];
  try {
    rows = db.select('room_chunks', { room_id: roomId }) as unknown as ChunkRecord[];
  } catch (e) {
    /* 「表还没建」= 这个库从没跑过基线迁移 / 还没存过任何一块 ⇒ 没有坐标可读。
       其余错误照旧冒泡(磁盘/权限故障被伪装成「没有存档」就是一张空地图)。 */
    if (/no such table/i.test((e as Error)?.message ?? '')) return [];
    throw e;
  }
  return rows
    .map((r) => ({ cx: Number(r.chunk_x), cy: Number(r.chunk_y) }))
    .filter((c) => Number.isInteger(c.cx) && Number.isInteger(c.cy))
    .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
}

/** 本房间已落盘的地形块数(诊断 / 判据的观测口径;表还没建 ⇒ 0)。 */
export function countRoomChunks(db: DbLike, roomId: string): number {
  try {
    return db.select('room_chunks', { room_id: roomId }).length;
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return 0;
    throw e;
  }
}

/** 本房间已落盘的屋顶层行数(与 `countRoomChunks` 对偶;表还没建 ⇒ 0)。 */
export function countRoomChunkRoofs(db: DbLike, roomId: string): number {
  try {
    return db.select(CHUNK_ROOFS_TABLE, { room_id: roomId }).length;
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return 0;
    throw e;
  }
}

/**
 * 一行世界状态。
 *
 * `seed` 是**世代替换的判据**(读写两侧都用它):
 *   * 写侧:库里 `seed` ≠ 本世界的 `worldSeed` ⇒ 先 `forgetRoomWorldSave` 再写
 *     (`reset_world` 换了种子之后,旧世代的 chunk 行必须作废,否则下一次启动
 *     会把**重置前**的世界读回来);
 *   * 读侧:同一个比对 ⇒ 不匹配就**不恢复**(如实报 `seed-mismatch`)。
 */
export interface WorldStateRecord {
  room_id: string;
  seed: number;
  size_cells: number;
  biome: string;
  frame: number;
  /** `FLV1` 字节(格式定义在 `world/fluid.ts`);`null` = 这份存档没存水位。 */
  fluid_blob: Uint8Array | null;
  updated_at: number;
}

/**
 * 写世界状态(一房间一行,覆盖写)。`fluid` 省略 ⇒ 这一行**不带水位**
 * (与「水位是全零」是两件事:前者是「没存过」,后者是「存了但全干」)。
 *
 * 水位超 1 MiB ⇒ **如实抛**(不截断):半个水位场读回来分不清「这里本来没水」
 * 与「这里的字节丢了」—— 与 §13 对非 `WSA1` 快照的取舍一致。
 */
export function saveWorldState(
  db: DbLike,
  input: {
    roomId: string;
    seed: number;
    sizeCells: number;
    biome: string;
    frame: number;
    fluid?: Uint8Array | null;
    nowMs: number;
  },
): void {
  if (typeof input.roomId !== 'string' || input.roomId.length === 0) {
    throw new Error('世界状态需要 roomId(非空字符串)');
  }
  if (!Number.isFinite(input.seed) || !Number.isInteger(input.seed)) {
    throw new Error(`世界状态的 seed 必须是有限整数(实得 ${String(input.seed)})`);
  }
  const sizeCells = clampInt(input.sizeCells, 1, 4096, 'sizeCells');
  const frame = clampInt(input.frame, 0, Number.MAX_SAFE_INTEGER, 'frame');
  const fluid = input.fluid ?? null;
  if (fluid !== null) {
    if (!(fluid instanceof Uint8Array)) throw new Error('fluid_blob 必须是 Uint8Array');
    if (fluid.byteLength > BLOB_MAX_BYTES) {
      throw new Error(
        `fluid_blob ${fluid.byteLength} 字节超出上限 ${BLOB_MAX_BYTES}`
        + ' —— 拒绝写入而不是截断(截断的水位场读回来是半个世界的水)',
      );
    }
  }
  const key = { room_id: input.roomId };
  const row = {
    room_id: input.roomId,
    seed: Math.trunc(input.seed),
    size_cells: sizeCells,
    biome: typeof input.biome === 'string' ? input.biome : '',
    frame,
    fluid_blob: fluid,
    updated_at: input.nowMs,
  };
  if (db.get(WORLD_STATE_TABLE, key)) {
    db.update(WORLD_STATE_TABLE, key, row);
    return;
  }
  db.insert(WORLD_STATE_TABLE, row);
}

/**
 * 读世界状态。表还没建 / 这个房间没有行 ⇒ `undefined`(「没存过」,不是故障)。
 *
 * 其余错误照旧冒泡:一次磁盘/权限故障被伪装成「没存过」的后果是
 * **一张空地图**被当成「新世界」启动 —— 那正是本段要修的那把刀。
 */
export function loadWorldState(db: DbLike, roomId: string): WorldStateRecord | undefined {
  if (typeof roomId !== 'string' || roomId.length === 0) return undefined;
  let row: Row | undefined;
  try {
    row = db.get(WORLD_STATE_TABLE, { room_id: roomId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return undefined;
    throw e;
  }
  if (!row) return undefined;
  const blob = row.fluid_blob;
  return {
    room_id: String(row.room_id),
    seed: Number(row.seed) || 0,
    size_cells: Number(row.size_cells) || 0,
    biome: typeof row.biome === 'string' ? row.biome : '',
    frame: Number(row.frame) || 0,
    fluid_blob: blob instanceof Uint8Array && blob.byteLength > 0 ? blob : null,
    updated_at: Number(row.updated_at) || 0,
  };
}

/**
 * 丢掉某房间**整个**世界存档(地形行 + 屋顶行 + 状态行),返回各删了几行。
 *
 * 两个调用点(`sim/world_sim.ts`):
 *   * 写侧发现 `seed` 不一致(重置换了世界世代)⇒ 先清后写;
 *   * 读侧**不调用本函数**:库里那一代的 `seed` 与「房间配置里的 seed」不一致时,
 *     按**库里的**种子恢复(`seedAdopted`,见 `restoreWorldFromDb`)——
 *     `reset_world` 刻意不改房间的 `worldSeed`(见 `net/actions/reset_world.ts`),
 *     把库清掉等于把上一次重置**回退掉**。
 * 表还没建 ⇒ 0(没有行可删,不是故障)。
 */
export function forgetRoomWorldSave(
  db: DbLike,
  roomId: string,
): { chunks: number; roofs: number; state: number } {
  const wipe = (table: string): number => {
    let rows: Row[];
    try {
      rows = db.select(table, { room_id: roomId });
    } catch (e) {
      if (/no such table/i.test((e as Error)?.message ?? '')) return 0;
      throw e;
    }
    let removed = 0;
    for (const r of rows) {
      if (table === WORLD_STATE_TABLE) {
        removed += db.delete(table, { room_id: roomId });
        continue;
      }
      removed += db.delete(table, {
        room_id: roomId,
        chunk_x: Number(r.chunk_x),
        chunk_y: Number(r.chunk_y),
      });
    }
    return removed;
  };
  return {
    chunks: wipe('room_chunks'),
    roofs: wipe(CHUNK_ROOFS_TABLE),
    state: wipe(WORLD_STATE_TABLE),
  };
}

/* ══════ 20. 房间运行时状态 + 玩家装备(★ WS-FND-168:诚实清单里仍只在内存的那些)═══════
 *
 * 上一轮逐条**诚实登记**但仍**只活在内存**的状态,修前没有任何落库路径:
 * ```text
 * roomSystemsState.{gallery,harvest,crops,ranchPets,lastRanch,lastBrew}  只在字段里
 * depotStock(百货机库存)                                                  只在字段里
 * mobGround(地面掉落)                                                     只在字段里
 * wiring.components(电路件的运行态)                                       只在字段里
 * 生物位置 / 朝向(rooms.mob_mem_json 只存 AI 记忆,**没有位置**)           只在字段里
 * 玩家装备 / held_item_id / 朝向                                          只在重连 blob 里(除武器)
 * ```
 * ⇒ 进程一停这几维全归零,而库里那几行还在 —— 「自动存档成功」在**这几维**上是空的。
 *
 * ## 落点为什么是**独立 DDL + 两张懒建表**(理由与 §13/§14/§17/§19 同源)
 *
 * `schema.sql` 的 checksum 已登记在既有库的 `schema_migrations`(version = 1):
 * 往 `rooms` 上加一列会改掉整份 schema.sql 的 checksum ⇒ **每一个旧库**启动即 drift
 * 并 fail-closed 拒绝启动。故走自己的 DDL 文件 + 自己的迁移版本(6):
 * 老库(v1..v5 任意组合)**原地补两张表**,既有表与既有行一个都不动。
 * 建表数与「9 张表」的既有判据不冲突 —— 本段**不在 `migrate()` 里建表**,
 * 只在**第一次存档**时由 `migrateRoomRuntime()` 就地补上(与归档/起始包/房间系统同一处置)。
 *
 * ## 版本标记
 * 每个 `*_json` 列存 `{ "$v": 1, "data": <载荷> }`。不认识的 `$v` ⇒ 读侧如实标
 * `corrupt`(**不猜**),于是「写它的程序」与「读它的程序」不是同一版这件事看得见。
 *
 * ## 读侧的容错纪律(与 §11 的 per-entry、§17 的 corrupt 同族)
 * ```text
 * no-table   这个库从没存过(老库 / 全新库)        —— 正常
 * no-row     这间房没有运行时状态行(第一次跑)      —— 正常
 * corrupt    某一段有内容但读不懂(JSON 坏 / $v 不认识)—— **逐段**如实标:
 *            一段坏了只丢那一段,不把整间房的运行时状态全丢(故分列而不是一坨大 JSON)
 * ```
 */

/** 房间运行时状态表名(与 DDL 文件里那张表逐字一致)。 */
export const ROOM_RUNTIME_TABLE = 'room_runtime_state';

/** 玩家装备表名(与 DDL 文件里那张表逐字一致)。 */
export const PLAYER_EQUIPMENT_TABLE = 'player_equipment_state';

/** 本段 DDL 的文件产物名。**独立于 `schema.sql`**(理由见本节头)。 */
export const ROOM_RUNTIME_SCHEMA_FILE_NAME = 'schema_room_runtime.sql';

/** 本段迁移在 `schema_migrations` 里的版本号(基线 1 / 归档 2 / 起始包 3 / 房间系统 4 / 世界存档 5)。 */
export const ROOM_RUNTIME_MIGRATION_VERSION = 6;
export const ROOM_RUNTIME_MIGRATION_NAME = 'ws_fnd168_room_runtime';

/** 段信封的格式版本(落进 `*_json` 的 `$v`;不认识的版本一律不猜)。 */
export const ROOM_RUNTIME_STATE_VERSION = 1;
/** 格式版本键(与背包账 / 房间系统台账的 `$v` 同名同义)。 */
export const ROOM_RUNTIME_VERSION_KEY = '$v';
/** 载荷键(信封里 `$v` 之外的唯一成员)。 */
export const ROOM_RUNTIME_DATA_KEY = 'data';

/** 单个段 JSON 的字节上限(与 §13/§19 的写入闸同口径)。 */
export const ROOM_RUNTIME_MAX_BYTES = BLOB_MAX_BYTES;

/** 装备 JSON 的字节上限(装备是一小串 id;见 DDL 文件里的 65536)。 */
export const PLAYER_EQUIPMENT_MAX_BYTES = 65536;

/** 五段各是什么(顺序 = DDL 里的列顺序 ⇒ 序列化逐字节可复现)。 */
export type RoomRuntimeSection = 'systems' | 'depot' | 'drops' | 'wiring' | 'mobs';
export const ROOM_RUNTIME_SECTIONS: readonly RoomRuntimeSection[] = Object.freeze([
  'systems', 'depot', 'drops', 'wiring', 'mobs',
] as const);

/** 段 → 列名(**唯一**一处映射;写/读两侧共用,防两份必然漂移的清单)。 */
const ROOM_RUNTIME_COLUMN: Readonly<Record<RoomRuntimeSection, string>> = Object.freeze({
  systems: 'systems_json',
  depot: 'depot_json',
  drops: 'drops_json',
  wiring: 'wiring_json',
  mobs: 'mobs_json',
});

/**
 * 一间房的运行时状态快照(**可 JSON 序列化**的载荷)。
 *
 * 各段是 `unknown`:本模块**不认识** `WorldSim`(与 §11/§17 同一分层)——
 * 它的形状由持有者(`sim/world_sim.ts`)在导出/恢复时负责。`省略` 某段 ⇒ 该段写成空串。
 */
export interface RoomRuntimeSnapshot {
  systems?: unknown;
  depot?: unknown;
  drops?: unknown;
  wiring?: unknown;
  mobs?: unknown;
}

/** 读回的五段(没存过的段是 `undefined` —— 与「存过但内容为空」区分开)。 */
export interface RoomRuntimeLoaded {
  systems?: unknown;
  depot?: unknown;
  drops?: unknown;
  wiring?: unknown;
  mobs?: unknown;
}

/**
 * 读回结果。
 * ```text
 * ok:false  reason='no-table'  这个库从没存过运行时状态(老库 / 全新库)
 * ok:false  reason='no-row'    这间房没有行(第一次跑)
 * ok:true   corrupt=[...]      **某几段**读不懂(逐段如实标,其余段照常返回)
 * ```
 * `ok:false` 只在「整行层面」缺失时出现;段层面的坏数据不把好段一起拖垮。
 */
export type RoomRuntimeRead =
  | { ok: true; state: RoomRuntimeLoaded; dropped: number; corrupt: readonly RoomRuntimeSection[]; bytes: number }
  | { ok: false; reason: 'no-table' | 'no-row'; dropped: number; corrupt: readonly RoomRuntimeSection[]; bytes: number };

export interface RoomRuntimeMigrateResult {
  applied: boolean;
  version: number;
  checksum: string;
  /** 已存在同版本但 checksum 不一致 = 漂移(写入侧 fail-closed)。 */
  drift: boolean;
}

/** 本段 DDL 全文(用真实文件路径读,与 `readSchemaSql` 同一做法)。 */
export function roomRuntimeSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), ROOM_RUNTIME_SCHEMA_FILE_NAME);
}

export function readRoomRuntimeSql(path: string = roomRuntimeSqlPath()): string {
  return readFileSync(path, 'utf8');
}

/**
 * 建两张表 + 登记迁移版本。**幂等**(DDL 全是 `CREATE TABLE IF NOT EXISTS`)。
 *
 * 判序与 §13/§14/§17/§19 逐字相同:「先读版本 → 护栏 → 漂移 → 才 exec DDL」——
 * 对旧库先 exec 会在发现结构不认识之前**已经动过库**。
 */
export function migrateRoomRuntime(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): RoomRuntimeMigrateResult {
  const ddl = readRoomRuntimeSql(ddlPath);
  const checksum = checksumOf(ddl);
  const rows = readMigrationRows(db);
  assertMigrationVersionSupported(rows.map((r) => (r as MigrationRow).version));
  const existing = rows.find(
    (r) => Number((r as MigrationRow).version) === ROOM_RUNTIME_MIGRATION_VERSION,
  ) as MigrationRow | undefined;
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: ROOM_RUNTIME_MIGRATION_VERSION, checksum, drift: true };
  }
  db.exec(ddl);
  if (existing) {
    return { applied: false, version: ROOM_RUNTIME_MIGRATION_VERSION, checksum, drift: false };
  }
  db.insert('schema_migrations', {
    version: ROOM_RUNTIME_MIGRATION_VERSION,
    name: ROOM_RUNTIME_MIGRATION_NAME,
    checksum,
    applied_at: nowMs,
  });
  return { applied: true, version: ROOM_RUNTIME_MIGRATION_VERSION, checksum, drift: false };
}

/** 这个库里**装过**本段迁移吗(登记行在 ⇒ 装过)。 */
export function roomRuntimeInstalled(db: DbLike): boolean {
  const rows = readMigrationRows(db);
  return rows.some((r) => Number((r as MigrationRow).version) === ROOM_RUNTIME_MIGRATION_VERSION);
}

/** `migrateRoomRuntimeIfInstalled` 的结果(比迁移结果多一个 `installed`)。 */
export interface RoomRuntimeBootCheck extends RoomRuntimeMigrateResult {
  /** `false` = 这个库从没装过本段 ⇒ 本轮**没有**建它(见函数注释)。 */
  installed: boolean;
}

/**
 * **启动检查**:装过本迁移的库 ⇒ 跑一遍(幂等 DDL + checksum 漂移检测);
 * 没装过的库 ⇒ 什么都不做(全新库不许在这里多出两张表 —— 建表数被既有判据锁着)。
 */
export function migrateRoomRuntimeIfInstalled(
  db: DbLike,
  nowMs: number,
  ddlPath?: string,
): RoomRuntimeBootCheck {
  if (!roomRuntimeInstalled(db)) {
    return {
      applied: false, version: ROOM_RUNTIME_MIGRATION_VERSION,
      checksum: '', drift: false, installed: false,
    };
  }
  return { ...migrateRoomRuntime(db, nowMs, ddlPath), installed: true };
}

/** 把一个段的载荷封进 `{$v,data}`(唯一序列化实现;同一载荷两次落库逐字节相同)。 */
function packSection(value: unknown): string {
  return JSON.stringify({
    [ROOM_RUNTIME_VERSION_KEY]: ROOM_RUNTIME_STATE_VERSION,
    [ROOM_RUNTIME_DATA_KEY]: value ?? null,
  });
}

/** 解一个段:读不懂(JSON 坏 / 非对象 / `$v` 不认识 / 缺 `data`)⇒ `undefined`(不猜)。 */
function unpackSection(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const env = parsed as Record<string, unknown>;
  if (Number(env[ROOM_RUNTIME_VERSION_KEY]) !== ROOM_RUNTIME_STATE_VERSION) return undefined;
  if (!Object.prototype.hasOwnProperty.call(env, ROOM_RUNTIME_DATA_KEY)) return undefined;
  return env[ROOM_RUNTIME_DATA_KEY];
}

/**
 * 写一间房的运行时状态(**第一次写会就地补表**并登记 v6)。整行覆盖语义:
 * 未给的段写成空串。任何一段超上限 ⇒ **如实抛**(不截断,与 §13/§19 同一取舍)。
 *
 * 返回值都是判据:`row` = 影响行数(1 = 落地;0 = 行在读-写之间消失,不该发生);
 * `bytes` = 本次写入的段 JSON 总字节;`written` = 真正写下的段数(给了载荷的段)。
 */
export function saveRoomRuntimeState(
  db: DbLike,
  roomId: string,
  snapshot: RoomRuntimeSnapshot,
  nowMs: number,
): { row: number; bytes: number; written: number } {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new Error('房间运行时状态需要非空 roomId');
  }
  if (!Number.isFinite(nowMs)) throw new Error('房间运行时状态需要 nowMs(Unix 毫秒)');
  const migration = migrateRoomRuntime(db, nowMs);
  if (migration.drift) {
    throw new Error(
      `房间运行时状态迁移 checksum 漂移(schema_migrations.version=${ROOM_RUNTIME_MIGRATION_VERSION}`
      + ' 的登记与 schema_room_runtime.sql 对不上)⇒ 拒绝写入(不静默降级):'
      + '这些状态是读档原料,结构没判清就写,重启后读回来的是坏状态',
    );
  }
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const patch: Row = { saved_at: nowMs };
  let bytes = 0;
  let written = 0;
  for (const section of ROOM_RUNTIME_SECTIONS) {
    const present = Object.prototype.hasOwnProperty.call(snap, section) && snap[section] !== undefined;
    if (!present) {
      patch[ROOM_RUNTIME_COLUMN[section]] = '';
      continue;
    }
    const json = packSection(snap[section]);
    if (json.length > ROOM_RUNTIME_MAX_BYTES) {
      throw new Error(
        `段 ${section} 的 JSON ${json.length} 字节超出上限 ${ROOM_RUNTIME_MAX_BYTES}`
        + ' —— 拒绝写入而不是截断(截断的段读回来是坏状态)',
      );
    }
    patch[ROOM_RUNTIME_COLUMN[section]] = json;
    bytes += json.length;
    written += 1;
  }
  const existing = db.get(ROOM_RUNTIME_TABLE, { room_id: roomId });
  if (existing === undefined) {
    db.insert(ROOM_RUNTIME_TABLE, { room_id: roomId, ...patch });
    return { row: 1, bytes, written };
  }
  return { row: db.update(ROOM_RUNTIME_TABLE, { room_id: roomId }, patch), bytes, written };
}

/**
 * 读一间房的运行时状态(与 `saveRoomRuntimeState` 对偶)。
 *
 * 先看 **迁移登记行**:没装过本段 ⇒ `no-table` 且**一个字节都不碰库**
 * (`MemoryDb.get()` 对不存在的表会顺手建一张空表,那会在内存夹具上凭空多出两张表)。
 * 装过之后真库的表若被删掉 ⇒ `no such table` 照样降级成 `no-table`。
 */
export function loadRoomRuntimeState(db: DbLike, roomId: string): RoomRuntimeRead {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    return { ok: false, reason: 'no-row', dropped: 0, corrupt: [], bytes: 0 };
  }
  if (!roomRuntimeInstalled(db)) {
    return { ok: false, reason: 'no-table', dropped: 0, corrupt: [], bytes: 0 };
  }
  let row: Row | undefined;
  try {
    row = db.get(ROOM_RUNTIME_TABLE, { room_id: roomId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) {
      return { ok: false, reason: 'no-table', dropped: 0, corrupt: [], bytes: 0 };
    }
    throw e;
  }
  if (!row) return { ok: false, reason: 'no-row', dropped: 0, corrupt: [], bytes: 0 };
  const state: RoomRuntimeLoaded = {};
  const corrupt: RoomRuntimeSection[] = [];
  let bytes = 0;
  for (const section of ROOM_RUNTIME_SECTIONS) {
    const raw = row[ROOM_RUNTIME_COLUMN[section]];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    bytes += raw.length;
    const value = unpackSection(raw);
    if (value === undefined) {
      corrupt.push(section);
      continue;
    }
    (state as Record<string, unknown>)[section] = value;
  }
  return { ok: true, state, dropped: 0, corrupt, bytes };
}

/** 读回的一名玩家装备。`corrupt` = 有行但读不懂(**不猜**成空装备)。 */
export interface PlayerEquipmentRead {
  equipment: readonly number[];
  corrupt: boolean;
}

/**
 * 写一名玩家的**非武器**装备(第一次写会就地补表)。
 *
 * 迁移**不在这里重跑**:调用方(`savePlayerSnapshots`)在事务之前已经迁移过
 * (`roomRuntimeInstalled` 为真)⇒ 这里不再 exec DDL(DDL 不该出现在写事务里)。
 * 非法 id 静默丢弃并计数(与 `serializePlayerLedger` 同一取舍)。
 */
export function savePlayerEquipmentState(
  db: DbLike,
  userId: string,
  equipment: readonly number[],
  nowMs: number,
): { kept: number; dropped: number } {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('玩家装备需要非空 userId');
  }
  if (!Number.isFinite(nowMs)) throw new Error('玩家装备需要 nowMs(Unix 毫秒)');
  if (!roomRuntimeInstalled(db)) {
    const migration = migrateRoomRuntime(db, nowMs);
    if (migration.drift) {
      throw new Error(
        `房间运行时状态迁移 checksum 漂移(schema_migrations.version=${ROOM_RUNTIME_MIGRATION_VERSION}`
        + ' 与 schema_room_runtime.sql 对不上)⇒ 拒绝写入玩家装备(不静默降级)',
      );
    }
  }
  const seen = new Set<number>();
  let dropped = 0;
  for (const raw of equipment ?? []) {
    if (!Number.isInteger(raw) || raw <= 0 || seen.has(raw) || seen.size >= PLAYER_EQUIPMENT_MAX) {
      dropped += 1;
      continue;
    }
    seen.add(raw);
  }
  /* 升序 ⇒ 同一份装备两次落库逐字节相同(判据能按字节比)。 */
  const ids = [...seen].sort((a, b) => a - b);
  const json = packSection({ equipment: ids });
  if (json.length > PLAYER_EQUIPMENT_MAX_BYTES) {
    throw new Error(`玩家装备 JSON ${json.length} 字节超出上限 ${PLAYER_EQUIPMENT_MAX_BYTES}`);
  }
  const key = { user_id: userId };
  const patch: Row = { equipment_json: json, saved_at: nowMs };
  if (db.get(PLAYER_EQUIPMENT_TABLE, key) === undefined) {
    db.insert(PLAYER_EQUIPMENT_TABLE, { user_id: userId, ...patch });
  } else {
    db.update(PLAYER_EQUIPMENT_TABLE, key, patch);
  }
  return { kept: ids.length, dropped };
}

/**
 * 读一名玩家的装备(与 `savePlayerEquipmentState` 对偶)。
 *
 * 没装过本段 / 没有行 / 这一段空 ⇒ `equipment: []`(正常);有行但读不懂 ⇒
 * `corrupt: true`(**不猜**成「他没有装备」—— 那与「读坏了」是两件事)。
 */
export function loadPlayerEquipmentState(db: DbLike, userId: string): PlayerEquipmentRead {
  if (typeof userId !== 'string' || userId.length === 0) return { equipment: [], corrupt: false };
  if (!roomRuntimeInstalled(db)) return { equipment: [], corrupt: false };
  let row: Row | undefined;
  try {
    row = db.get(PLAYER_EQUIPMENT_TABLE, { user_id: userId });
  } catch (e) {
    if (/no such table/i.test((e as Error)?.message ?? '')) return { equipment: [], corrupt: false };
    throw e;
  }
  if (!row) return { equipment: [], corrupt: false };
  const raw = row.equipment_json;
  if (typeof raw !== 'string' || raw.length === 0) return { equipment: [], corrupt: false };
  const payload = unpackSection(raw);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { equipment: [], corrupt: true };
  }
  const list = (payload as { equipment?: unknown }).equipment;
  if (!Array.isArray(list)) return { equipment: [], corrupt: true };
  const out: number[] = [];
  for (const v of list) {
    if (Number.isInteger(v) && (v as number) > 0) out.push(v as number);
  }
  return { equipment: out, corrupt: false };
}
