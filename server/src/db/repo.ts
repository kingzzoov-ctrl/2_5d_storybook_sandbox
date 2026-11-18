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

export interface DbLike {
  /** 执行 DDL / PRAGMA 批。允许语句以 `;` 分隔。 */
  exec(sql: string): void;
  insert(table: string, row: Row): void;
  update(table: string, key: KeyParts, patch: Row): number;
  delete(table: string, key: KeyParts): number;
  get(table: string, key: KeyParts): Row | undefined;
  select(table: string, where?: KeyParts): Row[];
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
  return [MIGRATION_BASELINE_VERSION, WORLD_ARCHIVE_MIGRATION_VERSION];
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

/** 批量存盘:一次事务写 N 块,返回实际写入块数。任何一块长度非法则整批回滚。 */
export function saveChunkBatch(
  db: DbLike,
  roomId: string,
  chunks: readonly { cx: number; cy: number; blob: Uint8Array }[],
  nowMs: number,
): number {
  for (const c of chunks) assertChunkBlob(c.blob);
  return db.transaction(() => {
    for (const c of chunks) saveChunk(db, roomId, c.cx, c.cy, c.blob, nowMs);
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

/** 单玩家物品总量(守恒断言的观测口径)。 */
export function totalItemsOf(db: DbLike, ownerId: string): number {
  return listItems(db, ownerId).reduce((s, r) => s + r.quantity, 0);
}

/* ═══════════════════════════ 10. room_events ═══════════════════════════ */

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

/** 与 `TABLE_PRIMARY_KEYS.room_events` 一致的主键列。 */
function nextEventId(db: DbLike): number {
  const rows = db.select('room_events');
  let maxId = 0;
  for (const r of rows) maxId = Math.max(maxId, Number(r.id) || 0);
  return maxId + 1;
}

export function writeEvent(
  db: DbLike,
  roomId: string,
  tick: number,
  kind: string,
  actorId: string | null,
  payload: unknown,
  nowMs: number,
): void {
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
  try {
    db.insert('room_events', row);
  } catch (e) {
    /* 兜底:并发写入导致取号过期时重试一次。
       计数暴露为 `eventIdRetryCount()` —— 门禁会断言它保持 0。 */
    const msg = (e as Error).message;
    if (!/主键冲突|UNIQUE constraint failed/.test(msg)) throw e;
    eventIdRetries += 1;
    db.insert('room_events', { ...row, id: nextEventId(db) });
  }
}

export function listEvents(db: DbLike, roomId: string, limit = 50): Row[] {
  return db.select('room_events', { room_id: roomId })
    .slice()
    .sort((a, b) => Number(b.tick) - Number(a.tick) || Number(b.id) - Number(a.id))
    .slice(0, limit);
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
