/**
 * WS-07 · 持久层仓储(零运行时依赖)
 *
 * 设计要点
 *  1. 本模块**只** import `node:*` 与 `shared/**`,不 import `better-sqlite3`。
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
};

/* ═══════════════════════════ 2. DDL 载入与迁移 ═══════════════════════════ */

export const SCHEMA_FILE_NAME = 'schema.sql';

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
 * 已登记版本且 checksum 一致 -> 跳过 DDL(applied=false),但仍执行幂等 DDL 以保证
 * 探针库/内存库结构与 schema.sql 一致。
 */
export function migrate(db: DbLike, nowMs: number, ddlPath?: string): MigrateResult {
  const ddl = readSchemaSql(ddlPath);
  db.exec(ddl);
  const checksum = checksumOf(ddl);
  const existing = db.get('schema_migrations', { version: MIGRATION_BASELINE_VERSION }) as
    | MigrationRow
    | undefined;
  if (existing && existing.checksum !== checksum) {
    return { applied: false, version: MIGRATION_BASELINE_VERSION, checksum, drift: true };
  }
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

export const PartyMode = {
  NONE: 'NONE',
  BRIDGE_FLAG: 'BRIDGE_FLAG',
  JELLY_BALL: 'JELLY_BALL',
  CROWN_RUN: 'CROWN_RUN',
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

export function upsertRoomPlayer(
  db: DbLike,
  roomId: string,
  userId: string,
  role: RoomRole,
  nowMs: number,
  snapshot?: Uint8Array,
): void {
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
