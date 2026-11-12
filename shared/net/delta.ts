/**
 * WS-07 · 手写差量编码器(零依赖核心,对应手册 §7.2 20Hz 增量同步)。
 *
 * 协议目标
 *   1. **字段级 diff**:某一帧只有 1 个玩家挪了 0.1 格,报文里就只能出现
 *      「该玩家 + x/y 两个 bit + 两个 i32」,不能出现整份快照。
 *   2. **无外部依赖**:全部手写 `Uint8Array` 读写,不 import 任何序列化库。
 *   3. **确定性**:同样的 (prev, next) 必须产出逐字节相同的报文。
 *
 * 线上布局(小端)
 * ```
 *  ┌────────┬────────┬───────┬─────────────────────────────────────┐
 *  │ ver u8 │ op u8  │ tick  │ ...载荷                             │
 *  └────────┴────────┴──u32──┴─────────────────────────────────────┘
 *   op = 0 全量快照 / 1 差量
 *
 *   载荷:
 *     u16 removedCount   × { u8 kind, str id }                ← 删除
 *     u16 upsertCount    × { u8 kind, str id, u32 mask, ... } ← 新增/变更
 *         mask 为 0 表示「实体存在但本帧所有字段无变化」,不写任何字段值。
 *         变长字段(STR/HASH)前缀 1 字节长度;定长字段按 FIELD_TYPE_BYTES。
 * ```
 * `str` = u8 长度前缀 + UTF-8 字节。空串编码为 `00`。
 */

import {
  BOSS_FIELD_TABLE,
  ENTITY_KIND_LABEL,
  EntityKind,
  FIELD_TABLE,
  FIELD_TYPE_BYTES,
  FieldType,
  POS_SCALE,
  ROOM_FIELD_TABLE,
  WILDLIFE_FIELD_TABLE,
  chunkKey,
  cloneRoomState,
  dequantizePos,
  parseChunkVersions,
  quantizePos,
  serializeChunkVersions,
  tableFor,
  type BossState,
  type FieldSpec,
  type PlayerState,
  type RoomState,
  type WildlifeState,
} from '../types/wire.ts';

export const PROTOCOL_VERSION = 1;

export const PacketOp = {
  FULL: 0,
  DELTA: 1,
} as const;
export type PacketOp = (typeof PacketOp)[keyof typeof PacketOp];

/* ═══════════════════════════ 1. 字节读写 ═══════════════════════════ */

const TE = new TextEncoder();
const TD = new TextDecoder();

class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void { this.ensure(1); this.buf[this.len++] = v & 0xff; }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }

  u32(v: number): void {
    this.ensure(4);
    const x = v >>> 0;
    this.buf[this.len++] = x & 0xff;
    this.buf[this.len++] = (x >>> 8) & 0xff;
    this.buf[this.len++] = (x >>> 16) & 0xff;
    this.buf[this.len++] = (x >>> 24) & 0xff;
  }

  i32(v: number): void { this.u32(v | 0); }

  i16(v: number): void {
    this.ensure(2);
    const x = (v | 0) & 0xffff;
    this.buf[this.len++] = x & 0xff;
    this.buf[this.len++] = (x >>> 8) & 0xff;
  }

  str(s: string): void {
    const bytes = TE.encode(s);
    if (bytes.length > 255) throw new Error(`字符串超长(${bytes.length} > 255):${s.slice(0, 24)}`);
    this.u8(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  get size(): number { return this.len; }

  finish(): Uint8Array { return this.buf.slice(0, this.len); }
}

class ByteReader {
  private view: DataView;
  private buf: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }

  u32(): number { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }

  i32(): number { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }

  i16(): number { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }

  str(): string {
    const n = this.u8();
    this.need(n);
    const s = TD.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  get remaining(): number { return this.buf.length - this.pos; }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`报文截断:需要 ${n} 字节,剩余 ${this.buf.length - this.pos}`);
    }
  }
}

/* ═══════════════════════════ 2. 字段读写原语 ═══════════════════════════ */

function writeField(w: ByteWriter, spec: FieldSpec, value: unknown): void {
  switch (spec.type) {
    case FieldType.POS:
      w.i32(typeof value === 'number' ? quantizePos(value) : 0);
      return;
    case FieldType.U8:
      w.u8(clampU8(value));
      return;
    case FieldType.U16:
      w.u16(clampU16(value));
      return;
    case FieldType.U32:
      w.u32(clampU32(value));
      return;
    case FieldType.I16:
      w.i16(typeof value === 'number' ? value | 0 : 0);
      return;
    case FieldType.STR:
    case FieldType.HASH:
      w.str(typeof value === 'string' ? value : '');
      return;
    default:
      throw new Error(`未知字段类型:${String(spec.type)}`);
  }
}

function readField(r: ByteReader, spec: FieldSpec): unknown {
  switch (spec.type) {
    case FieldType.POS: return dequantizePos(r.i32());
    case FieldType.U8: return r.u8();
    case FieldType.U16: return r.u16();
    case FieldType.U32: return r.u32();
    case FieldType.I16: return r.i16();
    case FieldType.STR:
    case FieldType.HASH: return r.str();
    default: throw new Error(`未知字段类型:${String(spec.type)}`);
  }
}

function clampU8(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
  return Math.max(0, Math.min(255, n));
}

function clampU16(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(65535, n));
}

function clampU32(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(4294967295, n));
}

/** 量化的字段取值(比较用),保证「量化后相同即等于没变」,避免浮点抖动刷帧。 */
function normalized(kind: EntityKind, spec: FieldSpec, value: unknown): unknown {
  switch (spec.type) {
    case FieldType.POS:
      return typeof value === 'number' ? quantizePos(value) : 0;
    case FieldType.U8:
    case FieldType.U16:
    case FieldType.U32:
      return spec.type === FieldType.U8 ? clampU8(value)
        : spec.type === FieldType.U16 ? clampU16(value) : clampU32(value);
    case FieldType.I16:
      return typeof value === 'number' ? value | 0 : 0;
    case FieldType.STR:
    case FieldType.HASH:
      return typeof value === 'string' ? value : '';
    default:
      throw new Error(`未知字段类型(${ENTITY_KIND_LABEL[kind]}):${String(spec.type)}`);
  }
}

/* ═══════════════════════════ 3. 实体取值/赋值 ═══════════════════════════ */

type AnyEntity = Record<string, unknown>;

function entityOf(state: RoomState, kind: EntityKind, id: string): AnyEntity | undefined {
  switch (kind) {
    case EntityKind.ROOM:
      return roomToFlat(state);
    case EntityKind.PLAYER:
      return state.players.find((p) => p.id === id) as unknown as AnyEntity | undefined;
    case EntityKind.WILDLIFE:
      return state.wildlife.find((w) => w.id === id) as unknown as AnyEntity | undefined;
    case EntityKind.BOSS:
      return state.bosses.find((b) => b.id === id) as unknown as AnyEntity | undefined;
    default:
      throw new Error(`未知实体种类:${kind}`);
  }
}

/**
 * 房间级状态拍平成「字段名 -> 值」,让 ROOM 与其它实体共用同一套 diff 逻辑。
 * **不含 tick** —— 帧号走报文头,见 `ROOM_FIELD_TABLE` 的注释。
 */
export function roomToFlat(s: RoomState): AnyEntity {
  return {
    chunkVersions: serializeChunkVersions(s.meta.chunkVersions),
    partyMode: s.meta.partyMode,
    partyTimer: s.meta.partyTimer,
    scoreA: s.meta.scoreA,
    scoreB: s.meta.scoreB,
  };
}

function applyFlatToRoom(s: RoomState, flat: AnyEntity): void {
  s.meta.chunkVersions = parseChunkVersions(String(flat.chunkVersions ?? ''));
  s.meta.partyMode = Number(flat.partyMode) || 0;
  s.meta.partyTimer = Number(flat.partyTimer) || 0;
  s.meta.scoreA = Number(flat.scoreA) || 0;
  s.meta.scoreB = Number(flat.scoreB) || 0;
}

/* ═══════════════════════════ 4. 编码 ═══════════════════════════ */

export interface EncodeStats {
  /** 每个实体改了哪些字段(调试与断言用)。 */
  changedFields: { kind: number; id: string; fields: string[] }[];
  removed: { kind: number; id: string }[];
  bytes: number;
}

export interface EncodedPacket {
  bytes: Uint8Array;
  stats: EncodeStats;
}

interface UpsertPlan {
  kind: EntityKind;
  id: string;
  mask: number;
  fields: FieldSpec[];
  values: unknown[];
}

function planFor(
  kind: EntityKind,
  id: string,
  prev: AnyEntity | undefined,
  next: AnyEntity,
): UpsertPlan | null {
  const table = tableFor(kind);
  const fields: FieldSpec[] = [];
  const values: unknown[] = [];
  let mask = 0;
  for (const spec of table) {
    const a = prev ? normalized(kind, spec, prev[spec.key]) : undefined;
    const b = normalized(kind, spec, next[spec.key]);
    if (prev && a === b) continue;
    mask = (mask | (1 << spec.bit)) >>> 0;
    fields.push(spec);
    values.push(next[spec.key]);
  }
  if (prev && mask === 0) return null;
  return { kind, id, mask, fields, values };
}

/**
 * 差量编码:`next` 相对 `prev` 的增量报文。
 * `prev === null` 时退化为全量快照(op = FULL)。
 */
export function encodeDelta(
  prev: RoomState | null,
  next: RoomState,
  tick: number = next.meta.tick,
): EncodedPacket {
  const w = new ByteWriter();
  w.u8(PROTOCOL_VERSION);
  w.u8(prev ? PacketOp.DELTA : PacketOp.FULL);
  w.u32(tick);

  const removed: { kind: number; id: string }[] = [];
  const plans: UpsertPlan[] = [];

  /* ── 先算删除 ── */
  if (prev) {
    for (const kind of [EntityKind.WILDLIFE, EntityKind.BOSS, EntityKind.PLAYER] as const) {
      const prevList = listOf(prev, kind);
      const nextList = listOf(next, kind);
      const nextIds = new Set(nextList.map((e) => e.id));
      for (const e of prevList) if (!nextIds.has(e.id)) removed.push({ kind, id: e.id });
    }
  }

  /* ── 房间级 ── */
  const roomPlan = planFor(
    EntityKind.ROOM,
    next.roomId,
    prev ? roomToFlat(prev) : undefined,
    roomToFlat(next),
  );
  if (roomPlan) plans.push(roomPlan);

  /* ── 实体级 ── */
  for (const kind of [EntityKind.PLAYER, EntityKind.WILDLIFE, EntityKind.BOSS] as const) {
    const nextList = listOf(next, kind);
    for (const e of nextList) {
      const before = prev ? listOf(prev, kind).find((x) => x.id === e.id) : undefined;
      const p = planFor(kind, e.id, before as unknown as AnyEntity | undefined, e as unknown as AnyEntity);
      if (p) plans.push(p);
    }
  }

  w.u16(removed.length);
  for (const r of removed) { w.u8(r.kind); w.str(r.id); }

  w.u16(plans.length);
  for (const p of plans) {
    w.u8(p.kind);
    w.str(p.id);
    w.u32(p.mask);
    for (let i = 0; i < p.fields.length; i += 1) writeField(w, p.fields[i], p.values[i]);
  }

  const bytes = w.finish();
  return {
    bytes,
    stats: {
      changedFields: plans.map((p) => ({
        kind: p.kind,
        id: p.id,
        fields: p.fields.map((f) => f.key),
      })),
      removed,
      bytes: bytes.length,
    },
  };
}

/** 全量快照编码(新客户端入场 / 断线重连)。 */
export function encodeFull(state: RoomState, tick: number = state.meta.tick): EncodedPacket {
  return encodeDelta(null, state, tick);
}

function listOf(
  s: RoomState,
  kind: EntityKind,
): { id: string }[] {
  switch (kind) {
    case EntityKind.PLAYER: return s.players;
    case EntityKind.WILDLIFE: return s.wildlife;
    case EntityKind.BOSS: return s.bosses;
    case EntityKind.ROOM: return [{ id: s.roomId }];
    default: return [];
  }
}

/* ═══════════════════════════ 5. 解码 ═══════════════════════════ */

export interface DecodedPacket {
  version: number;
  op: PacketOp;
  tick: number;
  removed: { kind: number; id: string }[];
  upserts: { kind: number; id: string; mask: number; fields: Record<string, unknown> }[];
  bytesConsumed: number;
}

export function decodePacket(bytes: Uint8Array): DecodedPacket {
  const r = new ByteReader(bytes);
  const version = r.u8();
  if (version !== PROTOCOL_VERSION) throw new Error(`协议版本不匹配:${version}`);
  const op = r.u8() as PacketOp;
  if (op !== PacketOp.FULL && op !== PacketOp.DELTA) throw new Error(`未知 op:${op}`);
  const tick = r.u32();

  const removedCount = r.u16();
  const removed: { kind: number; id: string }[] = [];
  for (let i = 0; i < removedCount; i += 1) removed.push({ kind: r.u8(), id: r.str() });

  const upsertCount = r.u16();
  const upserts: DecodedPacket['upserts'] = [];
  for (let i = 0; i < upsertCount; i += 1) {
    const kind = r.u8();
    const id = r.str();
    const mask = r.u32();
    const fields: Record<string, unknown> = {};
    for (const spec of tableFor(kind as EntityKind)) {
      if (((mask >>> spec.bit) & 1) === 0) continue;
      fields[spec.key] = readField(r, spec);
    }
    upserts.push({ kind, id, mask, fields });
  }
  return { version, op, tick, removed, upserts, bytesConsumed: r.pos };
}

/** 把解码结果套用到一份状态上,得到重建后的状态(round-trip 断言用)。 */
export function applyPacket(base: RoomState, pkt: DecodedPacket): RoomState {
  const out = cloneRoomState(base);
  /* 帧号来自报文头,无条件覆盖 —— 它是单调时钟,不是 diff 字段。 */
  out.meta.tick = pkt.tick;
  for (const r of pkt.removed) {
    if (r.kind === EntityKind.PLAYER) out.players = out.players.filter((p) => p.id !== r.id);
    else if (r.kind === EntityKind.WILDLIFE) out.wildlife = out.wildlife.filter((w) => w.id !== r.id);
    else if (r.kind === EntityKind.BOSS) out.bosses = out.bosses.filter((b) => b.id !== r.id);
  }
  for (const u of pkt.upserts) {
    if (u.kind === EntityKind.ROOM) {
      const flat: AnyEntity = {};
      for (const spec of ROOM_FIELD_TABLE) {
        flat[spec.key] = spec.key in u.fields ? u.fields[spec.key] : (roomToFlat(out)[spec.key]);
      }
      applyFlatToRoom(out, flat);
      continue;
    }
    const table = tableFor(u.kind as EntityKind);
    if (u.kind === EntityKind.PLAYER) {
      const cur = out.players.find((p) => p.id === u.id);
      const merged = mergeEntity(cur, table, u.id, u.fields) as unknown as PlayerState;
      const i = out.players.findIndex((p) => p.id === u.id);
      if (i === -1) out.players.push(merged); else out.players[i] = merged;
    } else if (u.kind === EntityKind.WILDLIFE) {
      const cur = out.wildlife.find((w) => w.id === u.id);
      const merged = mergeEntity(cur, table, u.id, u.fields) as unknown as WildlifeState;
      const i = out.wildlife.findIndex((w) => w.id === u.id);
      if (i === -1) out.wildlife.push(merged); else out.wildlife[i] = merged;
    } else if (u.kind === EntityKind.BOSS) {
      const cur = out.bosses.find((b) => b.id === u.id);
      const merged = mergeEntity(cur, table, u.id, u.fields) as unknown as BossState;
      const i = out.bosses.findIndex((b) => b.id === u.id);
      if (i === -1) out.bosses.push(merged); else out.bosses[i] = merged;
    }
  }
  return out;
}

function mergeEntity(
  cur: AnyEntity | undefined,
  table: readonly FieldSpec[],
  id: string,
  fields: Record<string, unknown>,
): AnyEntity {
  const out: AnyEntity = {};
  for (const spec of table) {
    if (spec.key in fields) out[spec.key] = fields[spec.key];
    else if (cur) out[spec.key] = cur[spec.key];
    else out[spec.key] = defaultFor(spec);
  }
  out.id = id;
  return out;
}

function defaultFor(spec: FieldSpec): unknown {
  switch (spec.type) {
    case FieldType.POS: return 0;
    case FieldType.U8:
    case FieldType.U16:
    case FieldType.U32:
    case FieldType.I16: return 0;
    case FieldType.STR:
    case FieldType.HASH: return '';
    default: return 0;
  }
}

/* ═══════════════════════════ 6. 带宽估算 ═══════════════════════════ */

export interface BandwidthReport {
  players: number;
  frameBytes: number;
  /** 下行 KB/s = frameBytes × TICK_HZ / 1024。 */
  kbps: number;
  kbytesPerSec: number;
  breakdown: { label: string; bytes: number }[];
}

/**
 * 稳态帧字节估算模型。
 *
 * 假设(与文档 §5 参数表一一对应):
 *   * 20Hz;每帧每个玩家都动(最坏情况,现实约 60%~80%)。
 *   * 玩家本帧变更字段 = id(9) + x/y/z(12) + dir(1) = 22 字节值
 *     + 头部 u8 kind(1) + str id(1+8) + u32 mask(4) = 14 字节。→ 36 字节/人。
 *   * 玩家每帧约 1/20 概率触发 hp/stateFlag/weaponId 等低频字段变更,
 *     低频字段平均 3 字节值 + 摊到 mask 一起发 → 近似 +2 字节/人/帧。
 *   * 野生动物 8 只处于 AOI 内,每帧 6 只动:每只 42 字节。
 *   * Boss 1 只:每帧 33 字节(坐标 12 + 预警几何 13 + phase 1 + mask/op 7)。
 *   * 房间级 meta:每帧 chunkVersions 变化时 40 字节;稳态 20 帧才变 1 次 → 摊 2 字节/帧。
 *   * 报文头 6 字节 + 两级计数 4 字节 = 10 字节。
 */
export function estimateBandwidth(players: number, tickHz = 20): BandwidthReport {
  const STR_ID = 9;               // u8 长度 + 8 字节 id
  const perPlayer = 1 + STR_ID + 4 + 12 + 1 + 2; // kind+id+mask+xyz+dir+低频摊薄
  const wildlifeCount = 8;
  const wildlifeMoving = 6;
  const perWildlife = 1 + STR_ID + 4 + 12 + 1 + 2; // 42
  const perBoss = 1 + STR_ID + 4 + 12 + 1 + 13 + 2; // 33+... 见文档
  const header = 10;
  const roomMeta = 2;

  const breakdown = [
    { label: `玩家 ×${players}`, bytes: players * perPlayer },
    { label: `野怪 ×${wildlifeMoving}/${wildlifeCount}`, bytes: wildlifeMoving * perWildlife },
    { label: 'Boss ×1', bytes: perBoss },
    { label: '房间级 meta(摊薄)', bytes: roomMeta },
    { label: '报文头 + 计数', bytes: header },
  ];
  const frameBytes = breakdown.reduce((s, b) => s + b.bytes, 0);
  const kbytesPerSec = (frameBytes * tickHz) / 1024;
  return { players, frameBytes, kbps: kbytesPerSec, kbytesPerSec, breakdown };
}

/** 三档带宽表(4 / 8 / 16 人),测试与文档共用。 */
export function bandwidthTable(tickHz = 20): BandwidthReport[] {
  return [4, 8, 16].map((n) => estimateBandwidth(n, tickHz));
}

/* ═══════════════════════════ 7. Chunk 版本差量(地形增量) ═══════════════════════════ */

export interface ChunkDiffEntry {
  cx: number;
  cy: number;
  fromVersion: number;
  toVersion: number;
}

/** 比较两份 chunkVersions,给出需要重传的 Chunk 列表。 */
export function diffChunkVersions(
  prev: Record<string, number>,
  next: Record<string, number>,
): ChunkDiffEntry[] {
  const out: ChunkDiffEntry[] = [];
  for (const k of Object.keys(next)) {
    const from = prev[k] ?? 0;
    const to = next[k];
    if (from !== to) {
      const [cx, cy] = k.split(',').map(Number);
      out.push({ cx, cy, fromVersion: from, toVersion: to });
    }
  }
  return out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

/** 单块 Chunk 的线上体积:1024 字节原始位压缩 + 8 字节头。 */
export function chunkWireBytes(): number {
  return FIELD_TYPE_BYTES.u32 === 4 ? 1024 + 8 : 1032;
}

export function makeChunkVersionKey(cx: number, cy: number): string {
  return chunkKey(cx, cy);
}

/** 定点换算再次导出,方便调用方只 import delta.ts。 */
export { POS_SCALE, quantizePos, dequantizePos };
