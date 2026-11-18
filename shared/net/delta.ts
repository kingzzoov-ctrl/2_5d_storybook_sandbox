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
 *  ┌────────┬────────┬───────┬──────────┬────────────────────────────────┐
 *  │ ver u8 │ op u8  │ tick  │ ackedSeq │ ...载荷                        │
 *  └────────┴────────┴──u32──┴────u32───┴────────────────────────────────┘
 *   op = 0 全量快照 / 1 差量
 *   ackedSeq = 客户端命令确认号,线上存 **ackedSeq + 1**
 *              ⇒ `0` 天然表示「还没有 ack」(内部 `-1`),不引入魔法值。
 *              编码侧只写占位 `0`;**真值由运输层按连接覆写**
 *              (见 `server/src/net/ws_server.ts` 的广播循环)。
 *
 *   载荷:
 *     u16 removedCount   × { u8 kind, str id }                ← 删除
 *     u16 upsertCount    × { u8 kind, str id, u32 mask, ... } ← 新增/变更
 *         mask 为 0 表示「实体存在但本帧所有字段无变化」,不写任何字段值。
 *         变长字段(STR/HASH)按下面的 `str` 编码;定长字段按 FIELD_TYPE_BYTES。
 * ```
 * `str` = **分段** u8 长度前缀 + UTF-8 字节:
 *   · 长度 < 255 ⇒ `u8 len` + payload(与 1 字节前缀的老格式**逐字节相同**);
 *   · 长度 ≥ 255 ⇒ 每 255 字节一段、段前缀写哨兵 `255`,最后补一段 `u8 (<255)`
 *     (可能为 0 的收尾段)。读出时循环到「段长 < 255」为止。
 *   空串仍编码为 `00`。
 *
 *   ⚠️ 为什么必须分段(审计 P1-1,2026-11):房间级 `chunkVersions` 是**变长拼接串**,
 *   一个 16×16 世界跨 40 个 chunk 就 > 255 字节 ⇒ 旧实现直接抛「字符串超长」,
 *   全量快照根本发不出去。分段保持 ≤255 的老包**一字不变**(无需协议 bump),
 *   同时上限从 255 抬到 255×256 = 65025 字节(≈ 5000 个 chunk)。
 *
 *   ⚠️ 字段取值**一律不钳位**(审计 P1-2):u8/u16/u32 越界、非有限、非数值
 *   ⇒ **抛错**,不静默截断/回绕。u8 与 u16/u32 同用 `Math.round`(旧实现 u8 是
 *   trunc,同一个 3.6 在两种字段上给出 3 与 4 两种结果)。
 *   解码侧要求**恰好消耗完**输入(尾部有垃圾 ⇒ 抛错,不再"解析成功")。
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

/*
 * 协议版本 —— **3**(D-14 owner 裁决:方法 A,包头加 `ackedSeq`)。
 *
 * ★ 为什么必须 bump:`decodePacket` 按顺序读字段,老解码器会把多出来的
 *   4 字节 ack 读成 `removedCount` ⇒ 轻则「报文截断」,重则解出一堆
 *   垃圾实体而**完全不报错**(本仓最忌的形态)。bump 是让老客户端
 *   **明确失败**的唯一手段(`client/src/net/session.ts` 的版本门)。
 *
 * ★ 为什么**不能**是 2:`FRAME_BINARY` 就是 `0x02`(见 session.ts),
 *   而 `classifyDownlink` 的规则 3 依赖 `PROTOCOL_VERSION !== FRAME_BINARY`
 *   ⇒ 版本 = 2 时「裸包首字节」与「帧 tag」不可区分,下行分流变成
 *   不可判定。跳过 2、取 3。
 *
 * 连带:resume token 串含本常量(`server/src/net/room.ts`),版本一变,
 * 30s 宽限期内的旧 token 不再匹配 —— 一次性影响,已登记。
 */
export const PROTOCOL_VERSION = 3;

/* ═══════════════ 0. u32 上界(审计 P3-6:帧号 / ack 序号)═══════════════════
 *
 * ## 修前的洞(实测口径)
 *
 * 帧头两个 u32 字段(`tick` 与 `ackedSeq`)**没有任何取值门**:
 * ```
 * encodeFull(state, 4294967296)        ⇒ 线上写 0        ← 静默回绕(u32 截断)
 * encodeFull(state, Infinity)          ⇒ 线上写 0        ← 同上
 * withAckedSeq(payload, 4294967296)    ⇒ (v+1)>>>0 回绕  ← 服务端侧同一形态
 * ```
 * 回绕**不报错**,而解码侧同样读不出异常(u32 读回来永远是"合法"的),
 * 于是「帧号跳变 / ack 归零」在两端都表现为**正常数字** —— 与本文件 §1
 * 已经修掉的字段静默钳位(P1-2)是同一形态,只是发生在包头。
 *
 * ## 口径:u32 线上量必须**显式合法**,非法一律抛错
 *
 * ```
 * 合法   [0, MAX_U32] 内的有限整数  ⇒ 原样
 * 非法   非数值 / NaN / Infinity / 小数 / 负数 / > MAX_U32 ⇒ **抛错**
 * ```
 * 不做截断、不做回绕、不做钳位:截断会让「客户端伪造的 ackedSeq」变成
 * 一个看似合理的小数字,而钳位会让超长帧号与真实帧号撞值。
 * 三种宽度(P1-2)与两个包头字段(P3-6)现在共用同一条口径:**报错**。
 *
 * `ackedSeq` 内部域是 `[-1, MAX_ACKED_SEQ]`(`-1` = 该连接还没带过 seq),
 * 线上存 `ackedSeq + 1` ⇒ `0` 天然表示无 ack,与解码侧的还原互为逆运算。
 */

/** 线上 u32 的取值上界(`2^32 − 1`)。 */
export const MAX_U32 = 4_294_967_295;

/** 内部 `ackedSeq` 的下界:`-1` = 本连接还没收到过 `seq`。 */
export const MIN_ACKED_SEQ = -1;

/**
 * 内部 `ackedSeq` 的上界。
 *
 * 为什么是 `MAX_U32 − 1` 而不是 `MAX_U32`:线上存的是 `ackedSeq + 1`,
 * 上界 `MAX_U32` 会写成 `4294967296` ⇒ 回绕成 `0`(即"没有 ack")
 * —— 一个**最坏**的静默错值:客户端会以为服务端什么都没处理。
 */
export const MAX_ACKED_SEQ = MAX_U32 - 1;

/**
 * 一个值能否作为**线上 u32** 写入(帧号 tick / ack 槽位)。
 *
 * 单独成谓词是为了让「拒绝」与「抛错」两种调用形态共用**同一份**判据:
 * 运输层要求"拒掉这条输入"(连接必须活下去),编码器要求"当场抛错"(不许写出坏包)。
 */
export function isU32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_U32;
}

/**
 * 线上 u32 的**唯一**校验口:非法即抛错(带字段名与原值)。
 * @returns 原值(合法时),便于写成 `w.u32(assertU32('tick', tick))`。
 */
export function assertU32(field: string, v: unknown): number {
  if (!isU32(v)) {
    throw new Error(
      `${field} 非法取值:${String(v)}(要求 0..${MAX_U32} 的有限整数 —— 协议不做静默截断/回绕)`,
    );
  }
  return v;
}

/** 内部 `ackedSeq` 是否合法(见 `MAX_ACKED_SEQ` 的注释)。 */
export function isValidAckedSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_ACKED_SEQ && v <= MAX_ACKED_SEQ;
}

/** 内部 `ackedSeq` 的校验口:非法即抛错。@returns 原值 */
export function assertAckedSeq(v: unknown): number {
  if (!isValidAckedSeq(v)) {
    throw new Error(
      `ackedSeq 非法取值:${String(v)}(要求 ${MIN_ACKED_SEQ}..${MAX_ACKED_SEQ} 的整数;`
      + `线上存 ackedSeq+1 ⇒ 上界比 u32 少 1)`,
    );
  }
  return v;
}

/**
 * 线上 ack 槽位(4 字节)该写的值 = `ackedSeq + 1`。
 *
 * **不在这里钳/截断**:非法 `ackedSeq` 由 `assertAckedSeq` 抛错。
 * 运输层(`server/src/net/ws_server.ts` 的 `withAckedSeq`)只用本函数,
 * 于是"内部域 → 线上域"只有一处换算。
 */
export function ackSlotValue(ackedSeq: unknown): number {
  return assertAckedSeq(ackedSeq) + 1;
}
/**
 * 报文 op。
 *
 * | op | 名字 | 语义 |
 * |----|------|------|
 * | 0  | `FULL`  | **自包含快照 + 整体替换**:接收方先清空实体表再按载荷重建 |
 * | 1  | `DELTA` | 增量:载荷作用在**已有**状态上 |
 *
 * ⚠️ `FULL` 的「整体替换」是**协议语义**,由 `applyPacket` 执行(见那边 §5 的说明)。
 * 修前 `applyPacket` 对 op **不做任何区分**,FULL 只在**空 base** 上才等价于快照;
 * 重连/入场时套在一份旧状态上就变成「只 merge 不删」⇒ 旧快照独有的实体
 * (player / wildlife / boss)永远留着,是**幽灵实体**且两端都不报错(审计 P1)。
 */
export const PacketOp = {
  FULL: 0,
  DELTA: 1,
} as const;
export type PacketOp = (typeof PacketOp)[keyof typeof PacketOp];

/* ═══════════════════════════ 1. 字节读写 ═══════════════════════════ */

const TE = new TextEncoder();
const TD = new TextDecoder();

/**
 * `str` 编码的长度上限(字节):255 字节/段 × 最多 256 段 = 65280。
 * 超过即抛错。取这个上限的理由:房间级 `chunkVersions` 串在 16×16 世界里
 * 40 个 chunk 约 300 字节,极端(数百 chunk)也只有几 KB —— 65KB 是宽松上界,
 * 同时把「伪造超长串」的病态输入挡在解码前。
 */
const MAX_STR_BYTES = 255 * 256;

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

  /**
   * 写变长串:**分段** u8 前缀。
   *
   *   len < 255  ⇒ `u8 len` + payload —— 与旧格式逐字节相同(≤255 的包不变);
   *   len ≥ 255  ⇒ 每 255 字节一段、段前缀 `255`(哨兵),末尾补一段 `<255`
   *                 (串长恰为 255 的整数倍时补一个 0 长收尾段)。
   *
   * 上限 `MAX_STR_BYTES` = 255 × 256 = 65280 字节。超过即抛错(不是静默截断)。
   */
  str(s: string): void {
    const bytes = TE.encode(s);
    if (bytes.length > MAX_STR_BYTES) {
      throw new Error(`字符串超长(${bytes.length} > ${MAX_STR_BYTES} 字节):${s.slice(0, 24)}`);
    }
    let off = 0;
    while (bytes.length - off >= 255) {
      this.u8(255);
      this.ensure(255);
      this.buf.set(bytes.subarray(off, off + 255), this.len);
      this.len += 255;
      off += 255;
    }
    this.u8(bytes.length - off);
    this.ensure(bytes.length - off);
    this.buf.set(bytes.subarray(off), this.len);
    this.len += bytes.length - off;
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

  /**
   * 读变长串:`str` 的逆运算。段前缀 = 255 ⇒ 后面还有一段;
   * `< 255` ⇒ 本段是最后一段(含 0 长收尾段)。
   *
   * ⚠️ 段数/总长都受 `MAX_STR_BYTES` 约束,并有 `need()` 兜住截断 ——
   * 一段伪造的「255, 255, 255, …」不会让解码器无限读下去。
   */
  str(): string {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const n = this.u8();
      this.need(n);
      parts.push(this.buf.subarray(this.pos, this.pos + n));
      this.pos += n;
      total += n;
      if (total > MAX_STR_BYTES) {
        throw new Error(`字符串超长(> ${MAX_STR_BYTES} 字节,疑似伪造分段)`);
      }
      if (n < 255) break;
    }
    if (parts.length === 1) return TD.decode(parts[0]);
    const joined = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { joined.set(p, off); off += p.length; }
    return TD.decode(joined);
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
      w.u8(toUint(spec, value));
      return;
    case FieldType.U16:
      w.u16(toUint(spec, value));
      return;
    case FieldType.U32:
      w.u32(toUint(spec, value));
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

/** 无符号字段类型 → 线上上限。i8/u16/u32 只有这三种(u16 两个端点仍各算一个 key)。 */
const UINT_MAX: Readonly<Record<string, number>> = {
  [FieldType.U8]: 255,
  [FieldType.U16]: 65535,
  [FieldType.U32]: 4294967295,
};

/**
 * 无符号字段取值的**唯一**转换口(编码与 diff 比较共用):非法就**抛错**。
 *
 * 审计 P1-2 的实测缺陷(改前):越界值被**静默钳位**
 *   `hp = weaponId = 70000 ⇒ 65535`;`u8` 用 `Math.trunc` 而 `u16/u32` 用
 *   `Math.round` ⇒ 同一个 `3.6` 在 `level` 上是 3、在 `hp` 上是 4;
 *   负值/`NaN` 被悄悄写成 0 —— 三类静默错值在解码侧完全看不出来。
 *
 * 改后口径:**非数值 / 非有限 / 负数 / 超上限 ⇒ 抛错**(带字段名与原值),
 * 三种宽度统一 `Math.round`。
 *
 * ★ 审计 P3-8(钳制选址的**单点约定**的编码器一侧):本函数**只报错,不钳**。
 * 「越界 hp 该在哪里被钳」的唯一答案是 `server/src/combat/vitals.ts`
 * (`0 ≤ hp ≤ maxHp` 只在那里成形,见该文件的「单点约定」块与
 * `docs/AUDIT-W34.md` §7.5);本文件遇到越界 hp 的唯一正确行为是**抛错** ——
 * 若哪天有调用方绕过 vitals 把越界 hp 塞进来,这里应当**红**,而不是替它圆场。
 * 判据:`tests/WS-FND-95-gate-and-bounds.test.ts` FND95-8。
 */
function toUint(spec: FieldSpec, value: unknown): number {
  const max = UINT_MAX[spec.type];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `字段 ${spec.key} 非法取值:${String(value)}(${spec.type} 只接受 0..${max} 的有限数值)`,
    );
  }
  const n = Math.round(value);
  if (n < 0 || n > max) {
    throw new Error(
      `字段 ${spec.key} 越界:${value} 不在 0..${max}(${spec.type})—— 协议不做静默钳位`,
    );
  }
  return n;
}

/** 量化的字段取值(比较用),保证「量化后相同即等于没变」,避免浮点抖动刷帧。 */
function normalized(kind: EntityKind, spec: FieldSpec, value: unknown): unknown {
  switch (spec.type) {
    case FieldType.POS:
      return typeof value === 'number' ? quantizePos(value) : 0;
    case FieldType.U8:
    case FieldType.U16:
    case FieldType.U32:
      /* 与 writeField 走**同一个** toUint:比较口径 = 上线口径 ⇒ 不会出现
         「本帧判为没变、真要写时却抛错」这种半截状态。 */
      return toUint(spec, value);
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
 * `prev === null` 时退化为全量快照(op = FULL)—— 此时 `removedCount` **恒 0**
 * (没有"上一份"可比较),「整体替换」的语义**不由编码侧表达**,而由解码侧的
 * `applyPacket` 按 op 执行。⇒ 谁也不能只读 `stats.removed` 就断言"没东西被删"。
 */
export function encodeDelta(
  prev: RoomState | null,
  next: RoomState,
  tick: number = next.meta.tick,
): EncodedPacket {
  const w = new ByteWriter();
  w.u8(PROTOCOL_VERSION);
  w.u8(prev ? PacketOp.DELTA : PacketOp.FULL);
  /* ★ 审计 P3-6:`tick` 是线上 u32 —— 越界/非有限整数**抛错**,不静默回绕。
     修前 `w.u32(tick)` 对 `4294967296` / `Infinity` / `-1` 全部写成 0,
     而解码侧读回来永远是"合法数字" ⇒ 两端都看不出帧号跳过了一大段。 */
  w.u32(assertU32('tick', tick));
  /* ── ackedSeq 槽位(4 字节,小端)──
     编码 = `ackedSeq + 1`(内部 `-1` ⇒ 线上 `0`)。**这里只写占位 0**:
     它是**每连接**的量,真值由运输层逐连接覆写(冻结层不需要知道
     ack 属于哪条连接)。覆写走 `ackSlotValue()`(同一份换算 + 校验)。 */
  w.u32(0);

  const removed: { kind: number; id: string }[] = [];
  const plans: UpsertPlan[] = [];

  /* ── 先算删除 ──
     ⚠️ `prev === null`(FULL)时**这里必然一条都不产生** —— 没有"上一份"可比。
     全量报文的"整体替换"不靠 removed 表达,靠解码侧 `applyPacket` 的
     `pkt.op === FULL` 分支清表(审计 P1)。⇒ 别在调用方读 `stats.removed`
     来断言"这份快照没有删除项",那恒成立。
     顺序固定 WILDLIFE → BOSS → PLAYER 是为了让报文逐字节确定(见文件头 §3)。 */
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

  /* 两级计数是 u16:数量越界同样**不许静默截断**(> 65535 个实体 ⇒ 抛错)。
     否则报文里写 65535、实际 70000 个 ⇒ 解码侧静默少 4465 个,与审计 P1-2 同形态。 */
  if (removed.length > 65535) {
    throw new Error(`删除条目过多:${removed.length} > 65535(u16 计数越界)`);
  }
  w.u16(removed.length);
  for (const r of removed) { w.u8(r.kind); w.str(r.id); }

  if (plans.length > 65535) {
    throw new Error(`变更条目过多:${plans.length} > 65535(u16 计数越界)`);
  }
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

/**
 * 全量快照编码(新客户端入场 / 断线重连)。
 *
 * 载荷**自包含**:房间级 5 字段 + 全部 player/wildlife/boss 一行不落
 * (`removedCount` 恒 0 —— 见 `encodeDelta` 的说明)。
 * ⇒ 接收方必须按「整体替换」处理:FULL 之后的状态**只**取决于这一份报文,
 *   与它此前持有过什么无关。执行点在 `applyPacket`(审计 P1)。
 */
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
  /**
   * 服务端**已应用**到的客户端命令序号(`-1` = 本帧没带 ack)。
   * 线上存的是 `ackedSeq + 1` ⇒ 这里减回来;`0` 不表示「第 0 条」。
   */
  ackedSeq: number;
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
  /* ackedSeq:线上 = 内部 + 1 ⇒ 这里减 1 还原(占位 0 ⇒ -1 = 无 ack)。
     ★ 解码侧**不需要**再校验上界:`r.u32()` 的返回值结构上就落在 `[0, MAX_U32]`,
     ⇒ 还原后恒在 `[MIN_ACKED_SEQ, MAX_ACKED_SEQ]`(见 §0)。上界门只在**写入侧**:
     编码器(本文件 `assertU32('tick', …)`)与运输层的 `ackSlotValue()`。 */
  const ackedSeq = r.u32() - 1;

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
  /* ★ 审计 P1-2:解码必须**恰好消耗完**输入。
     改前:尾部多余字节被**静默接受** —— `new Uint8Array(70000)` 首字节置 3、
     次字节置 0 时 `decodePacket` 不抛,返回 `bytesConsumed = 10`,
     69990 字节垃圾无人过问(实测)。那让"解析成功"变成可灌水的假判据。
     改后:尾部有剩余 ⇒ **抛错**,且错误文案点明「尾部/未消耗」,
     与 `server/src/net/ws_server.ts` 的计数口径一致(它据此记 rejected)。 */
  if (r.pos !== bytes.length) {
    throw new Error(
      `报文尾部有 ${bytes.length - r.pos} 字节未消耗(解出 ${r.pos}/${bytes.length}B)`,
    );
  }
  return { version, op, tick, ackedSeq, removed, upserts, bytesConsumed: r.pos };
}

/**
 * 把解码结果套用到一份状态上,得到重建后的状态(round-trip 断言用)。
 *
 * ## ★ 审计 P1:`FULL` 是**整体替换**,不是 merge
 *
 * 修前本函数对 `pkt.op` **不做任何区分** —— 于是 `FULL` 只在"base 是空状态"时
 * 才等价于快照。入场 / 断线重连时它被套在一份**旧状态**上,表现是:
 *
 * ```
 * 旧快照有 player A,B + wildlife w1,w2 + boss z;新快照只有 player A
 * 修前: A 被 upsert 覆盖,B/w1/w2/z **原样留着** → 屏幕上是幽灵实体
 *        (编码侧 `removedCount` 恒 0:prev === null 时没有任何比较对象,见
 *        `encodeDelta` 的说明 ⇒ 解码侧无从得知"谁消失了")
 * 修后: 实体表先清空,再按载荷重建 ⇒ 结果**只**取决于这一份报文
 * ```
 *
 * 两端都不报错,是这一处最难查的地方 —— 所以替换语义必须写在**解码侧**
 * (它是唯一同时知道 op 与 base 的地方),而不是指望编码侧列出 removed。
 * `DELTA` 分支**不受影响**:它仍然只按 `pkt.removed` 删、按 upsert 合。
 */
export function applyPacket(base: RoomState, pkt: DecodedPacket): RoomState {
  const out = cloneRoomState(base);
  /* 帧号来自报文头,无条件覆盖 —— 它是单调时钟,不是 diff 字段。 */
  out.meta.tick = pkt.tick;
  if (pkt.op === PacketOp.FULL) {
    /* 自包含快照:实体表与房间级 meta 一律从零开始。
       (`encodeFull` 一定带一条覆盖全部 5 个 ROOM 字段的 upsert,所以下面
       的清零不会让 meta 丢值;而万一报文残缺,这里也只会得到"空"而不是"旧值"。) */
    out.players = [];
    out.wildlife = [];
    out.bosses = [];
    out.meta.chunkVersions = {};
    out.meta.partyMode = 0;
    out.meta.partyTimer = 0;
    out.meta.scoreA = 0;
    out.meta.scoreB = 0;
  }
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
 *   * 报文头 10 字节(ver/op/tick/ackedSeq)+ 两级计数 4 字节 = 14 字节。
 */
export function estimateBandwidth(players: number, tickHz = 20): BandwidthReport {
  const STR_ID = 9;               // u8 长度 + 8 字节 id
  const perPlayer = 1 + STR_ID + 4 + 12 + 1 + 2; // kind+id+mask+xyz+dir+低频摊薄
  const wildlifeCount = 8;
  const wildlifeMoving = 6;
  const perWildlife = 1 + STR_ID + 4 + 12 + 1 + 2; // 42
  const perBoss = 1 + STR_ID + 4 + 12 + 1 + 13 + 2; // 33+... 见文档
  const header = 14;
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
