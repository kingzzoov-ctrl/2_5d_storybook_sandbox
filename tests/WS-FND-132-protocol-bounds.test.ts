/**
 * WS-FND-132 —— 第八轮审计:协议**边界**四处(WS 帧层无上界 / pos 静默钳位 /
 * `removed` 的 kind 无白名单 / FULL 的帧号回退)+ i16 的静默回绕。
 *
 * | # | 事实 | 修前在这一条上会怎样 |
 * | :--- | :--- | :--- |
 * | 1 | WS 帧层有**载荷上界**(非控制帧 / 控制帧各一条) | 宣告 `len = 2^40` 且不补满 ⇒ `parseFrame` 恒 null、`conn.buf` 无界增长(O(n^2)) |
 * | 2 | 残帧缓冲有**累积上界**(且可断言) | 同上:内存与 CPU 都没有上界 |
 * | 3 | `pos` 越界 / 非有限 ⇒ **抛错** | `quantizePos` 静默钳到 i32、NaN 变 0 ⇒ 解码回 ~2.1e6 格 |
 * | 4 | `removed.kind` 走**白名单**(解码侧) | 伪造 `kind=9` 三处都不出声 ⇒ 客户端留**幽灵实体** |
 * | 5 | FULL 的帧号回退 = **世代重置**(具名判据) | FULL 把 tick 拉回后,老世代迟到 DELTA 一律放行,三个计数都不涨 |
 * | 6 | `i16` 有校验(不再 `value | 0`) | 40000 静默回绕成 -25536(今日四表无 I16 ⇒ 不可达,但是同一个形态) |
 *
 * ## 判据设计纪律(与本仓 `tests/WS-FND-74` / `-95` 同款)
 * ```
 * 1 每条都要能**失败**:负对照(合法输入不许红)+ 注入(把约定抽掉必然红)各至少一次;
 * 2 行为判据优先:能真跑 parseFrame / encodeDelta / applyPacket / ClientStateStore
 *   就不 grep 源码;唯一用文本判据的是 FND132-12(它天生只有文本形态)——
 *   而它仍然配了**注入**:把源码里那句守卫抠掉,判据必须红。
 * 3 抽掉约定后判据变红 = 这条断言有牙;抽掉约定后仍然绿 = 它在自说自话。
 * ```
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import {
  BOSS_FIELD_TABLE,
  FIELD_TABLE,
  FieldType,
  POS_SCALE,
  ROOM_FIELD_TABLE,
  WILDLIFE_FIELD_TABLE,
  quantizePos,
  type FieldSpec,
  type PlayerState,
  type RoomState,
} from '../shared/types/wire.ts';
import {
  I16_MAX,
  I16_MIN,
  POS_INT32_MAX,
  POS_INT32_MIN,
  PacketOp,
  PROTOCOL_VERSION,
  applyPacket,
  decodePacket,
  encodeDelta,
  encodeFull,
  isRemovableKind,
  ruleFullTick,
  toI16,
} from '../shared/net/delta.ts';
import {
  MAX_CONN_BUF_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  MAX_FRAME_BYTES,
  MAX_FRAME_HEADER_BYTES,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  FrameTooBigError,
  isBufOverflow,
  parseFrame,
} from '../server/src/net/ws_server.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TE = new TextEncoder();

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

function player(id: string, over: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: '玩家',
    level: 1,
    hp: 100,
    maxHp: 100,
    x: 1,
    y: 2,
    z: 0,
    dir: 0,
    stateFlag: 0,
    weaponId: 0,
    aiWeaponRecipeHash: '',
    heldItemId: 0,
    carryingEntityId: '',
    ...over,
  };
}

function state(tick: number, over: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 'room_alpha',
    meta: { tick, chunkVersions: {}, partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 },
    players: [player('p1')],
    wildlife: [],
    bosses: [],
    ...over,
  };
}

/** 抛错就返回文案(不抛返回 `''`)—— 负对照靠它区分「红了」与「没红」。 */
function throwMsg(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 造一个**客户端**帧(带掩码,长度域按 125/65535 三形态)。 */
function clientFrame(op: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength;
  const ext = len <= 125 ? 0 : len <= 65535 ? 2 : 8;
  const out = new Uint8Array(2 + ext + 4 + len);
  out[0] = 0x80 | op;
  out[1] = 0x80 | (ext === 0 ? len : ext === 2 ? 126 : 127);
  let off = 2;
  if (ext === 2) {
    out[off] = (len >>> 8) & 0xff;
    out[off + 1] = len & 0xff;
    off += 2;
  } else if (ext === 8) {
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    out[off] = (hi >>> 24) & 0xff;
    out[off + 1] = (hi >>> 16) & 0xff;
    out[off + 2] = (hi >>> 8) & 0xff;
    out[off + 3] = hi & 0xff;
    out[off + 4] = (lo >>> 24) & 0xff;
    out[off + 5] = (lo >>> 16) & 0xff;
    out[off + 6] = (lo >>> 8) & 0xff;
    out[off + 7] = lo & 0xff;
    off += 8;
  }
  const mask = [0x11, 0x22, 0x33, 0x44];
  out.set(mask, off);
  off += 4;
  for (let i = 0; i < len; i += 1) out[off + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

/**
 * **攻击手法本体**:只发头 —— 长度域写 `declaredLen`,载荷一个字节都不补。
 * (掩码位仍置 1,免得撞上"未掩码"那条**无关**的判据。)
 */
function headerOnlyFrame(op: number, declaredLen: number): Uint8Array {
  const form127 = declaredLen > 65535;
  const form126 = !form127 && declaredLen > 125;
  const ext = form127 ? 8 : form126 ? 2 : 0;
  const out = new Uint8Array(2 + ext + 4);
  out[0] = 0x80 | op;
  out[1] = 0x80 | (form127 ? 127 : form126 ? 126 : declaredLen);
  let off = 2;
  if (form126) {
    out[off] = (declaredLen >>> 8) & 0xff;
    out[off + 1] = declaredLen & 0xff;
    off += 2;
  } else if (form127) {
    const hi = Math.floor(declaredLen / 0x100000000);
    const lo = declaredLen >>> 0;
    out[off] = (hi >>> 24) & 0xff;
    out[off + 1] = (hi >>> 16) & 0xff;
    out[off + 2] = (hi >>> 8) & 0xff;
    out[off + 3] = hi & 0xff;
    out[off + 4] = (lo >>> 24) & 0xff;
    out[off + 5] = (lo >>> 16) & 0xff;
    out[off + 6] = (lo >>> 8) & 0xff;
    out[off + 7] = lo & 0xff;
    off += 8;
  }
  out.set([0x11, 0x22, 0x33, 0x44], off);
  return out;
}

/**
 * 手搓一份只带 `removed` 一份条目的**上行包**(伪造来源。
 * 编码器自己不产这种包 ⇒ 只能手搓字节,这也正是攻击者做的事)。
 */
function packetWithRemoved(kind: number, id: string): Uint8Array {
  const w: number[] = [PROTOCOL_VERSION, PacketOp.DELTA];
  for (let i = 0; i < 4; i += 1) w.push((7 >>> (8 * i)) & 0xff);   /* tick = 7 */
  for (let i = 0; i < 4; i += 1) w.push(0);                       /* ackedSeq 槽位 */
  w.push(1, 0);                                                   /* removedCount = 1 */
  w.push(kind & 0xff);
  const idBytes = TE.encode(id);
  w.push(idBytes.byteLength);                                     /* id 短 ⇒ 单段 */
  for (const b of idBytes) w.push(b);
  w.push(0, 0);                                                   /* upsertCount = 0 */
  return Uint8Array.from(w);
}

/* ═══════════════════════ 1. WS 帧层的上界 ═══════════════════════ */

test('FND132-1 ★ 宣告 len = 2^40 且不补满 ⇒ parseFrame **当场抛**(不再恒 null)', () => {
  const announced = 2 ** 40;                     /* 是安全整数 ⇒ 修前那道 Number.isSafeInteger 拦不住 */
  ok(Number.isSafeInteger(announced), '前提:2^40 是安全整数(修前的判据确实放它过去)');

  const buf = headerOnlyFrame(OP_BINARY, announced);
  /* ── 正面:当场抛,而且是**专用**错误类(运输层据此回 1009) ── */
  let err: unknown = null;
  try { parseFrame(buf); } catch (e) { err = e; }
  ok(err instanceof FrameTooBigError, `必须抛 FrameTooBigError,实得 ${String(err)}`);
  ok((err as Error).message.includes('超界'), `错误文案要点明"超界":${(err as Error).message}`);

  /* ── 注入(修前语义重放):修前**唯一**的长度判据是"够不够"── */
  const preFixOnlyEnoughData = (declared: number, have: number): boolean => have < declared;
  ok(preFixOnlyEnoughData(announced, buf.byteLength),
    '★ 注入:修前那份缓冲会落进"残帧"分支 ⇒ 恒 null、conn.buf 无限长');
  /* 而那条"残帧"分支**今天仍然存在**(合法长度没补满时它就是 null)——
     这证明上面那条 throw 不是"什么都抛",而是**上界**加出来的:
     负对照 ↓ 同一形状、长度合法 ⇒ 回到 null 语义。 */
  eq(parseFrame(headerOnlyFrame(OP_BINARY, 64)), null,
    '负对照:长度合法(64B)、只是没补满 ⇒ 仍必须返回 null(残帧语义没被上界改掉)');
});

test('FND132-2 ★ 上界是"读到就判":边界值恰好在界内不抛、越一字节就抛', () => {
  /* 恰在界内:数据不足 ⇒ null(证明判据是 `>` 而不是 `>=`,且"读到就判"成立) */
  eq(parseFrame(headerOnlyFrame(OP_BINARY, MAX_FRAME_BYTES)), null,
    `len = MAX_FRAME_BYTES(${MAX_FRAME_BYTES})恰好在界内 ⇒ 只该是"残帧",不该抛`);
  /* 越一字节:当场抛 */
  ok(throwMsg(() => parseFrame(headerOnlyFrame(OP_BINARY, MAX_FRAME_BYTES + 1))).includes('超界'),
    'len = MAX_FRAME_BYTES + 1 ⇒ 必须当场抛(不等补满)');
  /* 负对照:界内的**完整**帧照旧解析得出来(不是"凡大帧必拒") */
  const big = new Uint8Array(70000).fill(0xab);            /* WS-13 的压测口径 */
  const p = parseFrame(clientFrame(OP_BINARY, big));
  ok(p !== null, '70000 字节的完整帧必须能解析(界内)');
  eq(p!.payload.byteLength, 70000, '载荷长度逐字节对上');
  eq(p!.consumed, 70000 + 10 + 4, 'consumed = 头 10 + 掩码 4 + 载荷');
});

test('FND132-3 ★ 控制帧**单独**限长(§5.5 的 125),非控制帧不受这条约束', () => {
  /* 正面:ping / close 载荷 126 ⇒ 抛 */
  for (const op of [OP_PING, OP_CLOSE]) {
    ok(throwMsg(() => parseFrame(headerOnlyFrame(op, MAX_CONTROL_FRAME_BYTES + 1))).includes('控制帧'),
      `op=0x${op.toString(16)} 载荷 126 必须抛(§5.5)`);
  }
  /* 负对照 A:恰好 125 的控制帧**能过**(证明限的是 125,不是"控制帧一律抛") */
  const ping125 = parseFrame(clientFrame(OP_PING, new Uint8Array(MAX_CONTROL_FRAME_BYTES)));
  ok(ping125 !== null, '125 字节的 ping 必须能解析');
  /* ★ 期望侧写**字面量 125**,不写 `MAX_CONTROL_FRAME_BYTES`:
     两边都取自本仓常量就是同义反复(常量改了它也跟着改,永远绿)。
     125 是 RFC 6455 §5.5 的定值 ⇒ 常量真的漂走时必须红。 */
  eq(ping125!.payload.byteLength, 125, '负对照 A:载荷原样 125 字节(不是被截断的)');
  /* 负对照 B:非控制帧 126 **不**受 125 那条约束(两条门各管各的) */
  const bin126 = parseFrame(clientFrame(OP_BINARY, new Uint8Array(126)));
  ok(bin126 !== null, '126 字节的二进制帧必须能解析(125 那条只对控制帧)');
  eq(MAX_CONTROL_FRAME_BYTES, 125, '常量本身必须是 125 这一档(RFC 6455 §5.5)');
});

test('FND132-4 ★ 残帧缓冲的累积上界:常量关系 + isBufOverflow 的边界', () => {
  eq(MAX_CONN_BUF_BYTES, MAX_FRAME_HEADER_BYTES + MAX_FRAME_BYTES,
    '缓冲上界 = 帧头最大值 + 载荷上界(一个"没补满的帧"的理论最大值)');
  eq(MAX_FRAME_HEADER_BYTES, 14, '帧头最大 14 = 2 基础 + 8 扩展长度 + 4 掩码');
  /* 边界:恰好等于上界**不算**越界(否则一个刚到上界的合法残帧会被误杀) */
  eq(isBufOverflow(MAX_CONN_BUF_BYTES), false, '恰好到界 ⇒ 不越界');
  eq(isBufOverflow(MAX_CONN_BUF_BYTES + 1), true, '越一字节 ⇒ 越界');
  /* 负对照:上界必须**大于**任何单个合法帧的完整长度(否则正常大帧会被误杀) */
  ok(MAX_CONN_BUF_BYTES > MAX_FRAME_HEADER_BYTES + MAX_FRAME_BYTES - 1,
    '上界必须容得下一个满长度的合法帧');
  ok(MAX_CONN_BUF_BYTES > 70000 + 14, 'WS-13 那条 70000 字节的帧远在界内');
});

/* ═══════════════════════ 2. pos 的取值门 ═══════════════════════ */

test('FND132-5 ★ pos 越界**抛错**:不再静默钳到 i32 max(缺陷口径对照)', () => {
  /* 缺陷口径(仍在 `wire.ts`,被 WS-07 的 B04 逐值钉住 —— 那是"量化"这一层的语义) */
  eq(quantizePos(1e12), POS_INT32_MAX, '量化工具本身仍然钳位(这是它的语义)');
  eq(POS_INT32_MAX, 2147483647, '线上 i32 上界');
  eq(POS_INT32_MIN, -2147483648, '线上 i32 下界');
  eq(quantizePos(1e12), POS_INT32_MAX,
    '★ 注入:修前**协议路径**拿到的就是这个被钳过的值 ⇒ 解码回 ~2.1e6 格、两端不报错');

  /* 正面:同一份状态走**协议出口**必须抛 */
  const bad = state(7, { players: [player('p1', { x: 1e12 })] });
  const msg = throwMsg(() => encodeDelta(state(6), bad, 7));
  ok(msg.includes('x'), `错误要指向字段 x:${msg}`);
  ok(msg.includes('越界'), `文案要点明"越界":${msg}`);

  /* 负对照:界内的坐标逐值往返(不是"凡坐标必抛") */
  const good = state(7, { players: [player('p1', { x: POS_INT32_MAX / POS_SCALE, y: -1.5 })] });
  const back = applyPacket(state(6), decodePacket(encodeDelta(state(6), good, 7).bytes));
  near(back.players[0]!.x, POS_INT32_MAX / POS_SCALE, 1 / (2 * POS_SCALE), '正上界往返');
  near(back.players[0]!.y, -1.5, 1 / (2 * POS_SCALE), '负坐标往返');
  /* 越一字节(i32 + 1)也必须抛 */
  ok(throwMsg(() => encodeDelta(state(6), state(7, {
    players: [player('p1', { x: (POS_INT32_MAX + 1) / POS_SCALE })],
  }), 7)).includes('越界'), '量化后 i32 + 1 ⇒ 抛');
});

test('FND132-6 ★ pos 的非有限值也抛(NaN / ±Infinity),不再悄悄变 0', () => {
  for (const [label, v] of [['NaN', Number.NaN], ['+Inf', Number.POSITIVE_INFINITY],
    ['-Inf', Number.NEGATIVE_INFINITY]] as [string, number][]) {
    const msg = throwMsg(() => encodeDelta(state(6), state(7, {
      players: [player('p1', { z: v })],
    }), 7));
    ok(msg.includes('z'), `${label}:错误要指向字段 z(${msg})`);
    ok(msg.includes('非法取值'), `${label}:文案要点明"非法取值"(${msg})`);
  }
  /* 注入:修前这条路径把 NaN 悄悄写成 0(所以负对照必须同时证明"合法 0 仍然写得出去") */
  eq(quantizePos(Number.NaN), 0, '★ 注入:修前 NaN 会被 `quantizePos` 静默吞成 0');
  const zero = applyPacket(state(6), decodePacket(
    encodeDelta(state(6), state(7, { players: [player('p1', { z: 0 })] }), 7).bytes,
  ));
  eq(zero.players[0]!.z, 0, '负对照:合法的 0 必须照旧写得出去');
});

/* ═══════════════════ 3. removed 的 kind 白名单 ═══════════════════ */

test('FND132-7 ★ 伪造 removed{kid=9} ⇒ **解码抛**;而合入侧本来就只会静默忽略', () => {
  const forged = packetWithRemoved(9, 'p1');
  const msg = throwMsg(() => decodePacket(forged));
  ok(msg.includes('kind'), `解码必须当场抛并点明 kind:${msg}`);

  /* ── 注入:把伪造的解码结果**直接**交给合入侧(修前它就是这个对象) ── */
  const ghost = applyPacket(state(7, { players: [player('p1')] }), {
    version: PROTOCOL_VERSION, op: PacketOp.DELTA, tick: 8, ackedSeq: -1,
    removed: [{ kind: 9, id: 'p1' }], upserts: [], bytesConsumed: forged.byteLength,
  });
  eq(ghost.players.map((p) => p.id).join(','), 'p1',
    '★ 注入:`kind=9` 在合入侧**一条都不命中** ⇒ p1 留着 = 幽灵实体(两端不报错)');

  /* 负对照:同样形状、kind 合法(PLAYER=2)⇒ 解码成功,且删得掉 */
  const okPkt = decodePacket(packetWithRemoved(2, 'p1'));
  eq(okPkt.removed, [{ kind: 2, id: 'p1' }], '负对照:kind=2 正常解出(抛错是冲着 kind 值去的)');
  const gone = applyPacket(state(7, { players: [player('p1')] }), okPkt);
  eq(gone.players.length, 0, '负对照:合法 kind 的删除照旧生效');
});

test('FND132-8 ★ 白名单只有 player / wildlife / boss;ROOM 与未知值一律拒', () => {
  eq(isRemovableKind(2), true, 'PLAYER');
  eq(isRemovableKind(3), true, 'WILDLIFE');
  eq(isRemovableKind(4), true, 'BOSS');
  eq(isRemovableKind(1), false, '★ ROOM:房间级没有"删除"语义 ⇒ 是一条会被静默忽略的条目');
  eq(isRemovableKind(9), false, '未知 kind');
  eq(isRemovableKind(0), false, '0 是保留的"非法"值');
  eq(isRemovableKind(undefined), false, '非数值');
  eq(isRemovableKind('2'), false, '字符串不得被当成 2');
  /* 解码侧把 ROOM 也拦下(与上一条同源判据) */
  ok(throwMsg(() => decodePacket(packetWithRemoved(1, 'p1'))).includes('kind'),
    'kind=ROOM 在解码侧也必须抛');
  /* 编码侧只会吐出三种可删 kind(白名单的另一半:没有别的来源) */
  const d = encodeDelta(
    state(7, {
      players: [player('p1'), player('p2')],
      wildlife: [{ id: 'w1', mobId: 'mob_x', x: 1, y: 1, z: 0, fsm: 0, hp: 5, maxHp: 5, tameOwnerId: '' }],
      bosses: [{ id: 'b1', bossId: 'boss_x', phase: 0, hp: 5, maxHp: 5, telegraphShape: 0,
        telegraphX: 1, telegraphY: 1, telegraphR: 1, telegraphEndTick: 9 }],
    }),
    state(8),
    8,
  );
  ok(d.stats.removed.length >= 3, `三条删除都该产生(实得 ${d.stats.removed.length})`);
  for (const r of d.stats.removed) {
    eq(isRemovableKind(r.kind), true, `编码侧产出的 kind 必须在白名单里(实得 ${r.kind})`);
  }
});

/* ═══════════════════ 4. FULL 的帧号回退 = 世代重置 ═══════════════════ */

test('FND132-9 ★ 世代判据:ruleFullTick 只在**回退**时报重置,并给出老世代上界', () => {
  const reset = ruleFullTick(5000, 3);
  eq(reset.generationReset, true, '5000 → 3 是回退 ⇒ 世代重置');
  eq(reset.tick, 3, '接受该 FULL 后用的帧号 = FULL 自己的 tick(绝不冻结)');
  eq(reset.staleCeiling, 5000, '老世代迟到的上界 = 重置前到过的 tick');
  /* 负对照三态:相等 / 前进 / 从零开始 都**不是**重置 */
  for (const [base, full] of [[5000, 5000], [5000, 6000], [0, 0], [3, 3]] as [number, number][]) {
    const r = ruleFullTick(base, full);
    eq(r.generationReset, false, `base=${base} full=${full} 不是回退`);
    eq(r.staleCeiling, full, `未重置 ⇒ 迟到区间为空(ceiling = ${full})`);
  }
});

test('FND132-10 ★ FULL 仍被接受(不冻结),而老世代迟到区间**可判定**', () => {
  /* 真客户端 store:重现"FULL(tick=3) 覆盖 tick=5000"这条链 */
  const store = new ClientStateStore();
  store.apply(encodeFull(state(5000, { players: [player('p1'), player('p2')] }), 5000).bytes);
  eq(store.state.meta.tick, 5000, '第一份快照');
  store.apply(encodeFull(state(3), 3).bytes);
  eq(store.state.meta.tick, 3, '★ FULL 必须被接受(按 tick 丢掉唯一的恢复快照 = 永久冻结)');
  eq(store.state.players.length, 1, 'FULL 是整体替换(旧快照独有的 p2 不残留)');

  /* ── 迟到的**老世代** DELTA:`tick = 4999` 落在 (3, 5000] 里 ── */
  const oldGen = encodeDelta(state(3), state(4999, { players: [player('p1'), player('p2')] }), 4999);
  const r = store.apply(oldGen.bytes);
  eq(r.changed, true, '★ 缺陷复现:老世代的迟到 DELTA 被**放行**(旧帧号区间与新世代重名)');
  eq(store.staleFrames, 0, '单调门只拦 `tick <= 当前` ⇒ 4999 > 3 ⇒ 不记 stale');
  eq(store.decodeErrors, 0, '不是坏包');
  eq(store.emptyFrames, 0, '不是空帧');
  eq(store.state.players.map((p) => p.id).join(','), 'p1,p2',
    '★ 后果:p2 被这份老世代差量**带回来**(幽灵实体)');

  /* ── 判据给出的可执行规则:老世代区间 = (FULL 的 tick, 重置前的 tick] ── */
  const ruling = ruleFullTick(5000, 3);
  const isOldGeneration = (t: number): boolean => t > ruling.tick && t <= ruling.staleCeiling;
  ok(isOldGeneration(4999), '★ 判据认出 4999 落在老世代区间 ⇒ 单调门据此可丢它');
  ok(isOldGeneration(4),
    '★ 如实记:新世代头几帧(4)与老世代迟到帧(4999)**同号** ⇒ 光看 tick 分不开,'
    + '这正是缺陷的根(所以判据要给的是"整个区间可疑",而不是"我能猜出新旧")');
  eq(isOldGeneration(3), false, '负对照:FULL 自己那一帧不算迟到');
  eq(isOldGeneration(5001), false, '负对照:比重置前的上界还新 ⇒ 属于新世代');
});

/* ═══════════════════ 5. i16 的静默回绕 ═══════════════════ */

test('FND132-11 ★ i16 校验:越界 / 非有限 ⇒ 抛;且四张表今日确实没有 I16 字段', () => {
  const spec: FieldSpec = { key: 'probe', bit: 0, type: FieldType.I16, bytes: 2, note: '测试夹具' };
  /* 前提(这条断言的价值就在这儿:今天是"新增防线",不是修回归) */
  const i16Fields = [...FIELD_TABLE, ...WILDLIFE_FIELD_TABLE, ...BOSS_FIELD_TABLE, ...ROOM_FIELD_TABLE]
    .filter((f) => f.type === FieldType.I16);
  eq(i16Fields.length, 0, '今日四表无 I16 字段 ⇒ 修前那条 `value | 0` 不可达');
  /* 注入:修前的口径是 `w.i16(value | 0)`(写)配 `getInt16`(读)——
     下面这个纯函数就是那两步的**逐位重放**(40000 写进去、读回来是 -25536)。 */
  const preFixI16 = (v: number): number => {
    const x = (v | 0) & 0xffff;
    return x >= 0x8000 ? x - 0x10000 : x;
  };
  eq(preFixI16(40000), -25536, '★ 注入:修前 40000 会静默回绕成 -25536(两端都不报错)');
  eq(preFixI16(Number.NaN), 0, '★ 注入:修前 NaN 会静默变成 0');
  eq(preFixI16(32767), 32767, '负对照:界内值修前也对(证明上面两条不是"什么都变")');
  ok(throwMsg(() => toI16(spec, 40000)).includes('越界'), '现在必须抛');
  for (const [label, v] of [['32768', I16_MAX + 1], ['-32769', I16_MIN - 1],
    ['NaN', Number.NaN], ['+Inf', Number.POSITIVE_INFINITY]] as [string, number][]) {
    ok(throwMsg(() => toI16(spec, v)).length > 0, `${label} ⇒ 必须抛`);
  }
  eq(throwMsg(() => toI16(spec, 40000)).includes('probe'), true, '错误文案要点明字段名');
  /* 负对照:界内值(含舍入口径与 toUint 同规) */
  eq(toI16(spec, I16_MAX), I16_MAX, '上界合法');
  eq(toI16(spec, I16_MIN), I16_MIN, '下界合法');
  eq(toI16(spec, 3.6), 4, '舍入口径与 toUint 同规(Math.round)');
  eq(toI16(spec, -3.6), -4, '负数同规');
});

/* ═══════════════════ 6. 源码级:三处约定真的在代码里 ═══════════════════ */

test('FND132-12 ★ 上界/白名单/判据都在源码里(含注入:抠掉守卫必须红)', () => {
  const wsSrc = readFileSync(join(ROOT, 'server', 'src', 'net', 'ws_server.ts'), 'utf8');
  const deltaSrc = readFileSync(join(ROOT, 'shared', 'net', 'delta.ts'), 'utf8');
  /* ★ 文本判据只咬**可执行**那部分:先去注释 —— 否则一句文档注释就能把它变绿。 */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const WS_MARKS = ['export const MAX_FRAME_BYTES', 'export const MAX_CONTROL_FRAME_BYTES',
    'export const MAX_CONN_BUF_BYTES', '} else if (len > MAX_FRAME_BYTES) {',
    'if (len > MAX_CONTROL_FRAME_BYTES) {', 'isBufOverflow(conn.buf.byteLength)'];
  const DELTA_MARKS = ['toPosInt32(spec, value)', 'export function isRemovableKind',
    '!isRemovableKind(kind)', 'export function ruleFullTick', 'export function toI16'];
  const hasAll = (code: string, marks: readonly string[]): boolean =>
    marks.every((m) => stripComments(code).includes(m));

  ok(hasAll(wsSrc, WS_MARKS), 'ws_server.ts 缺了帧层守卫(上界 / 缓冲上界之一)');
  ok(hasAll(deltaSrc, DELTA_MARKS), 'delta.ts 缺了 pos / kind / FULL / i16 之一');
  /* ── 处置:超界 ⇒ 1009 + **两条出口各记一次账**(不是"记一条日志继续等") ── */
  ok(hasAll(wsSrc, ['encodeClose(tooBig ? 1009 : 1002']),
    '超界必须回 1009(message too big),其余协议错才是最 1002');
  const countRejects = (src: string): number =>
    (stripComments(src).match(/framesRejected \+= 1;/g) ?? []).length;
  eq(countRejects(wsSrc), 2, '两条帧层出口(解析抛错 / 缓冲越界)各记一次');
  /* 注入:把第一处记账抠掉 ⇒ 计数变 1 ⇒ 上一条**必须红**(否则它只是"有个数") */
  const oneShot = wsSrc.replace('framesRejected += 1;', '');
  ok(oneShot !== wsSrc, '记账注入点必须存在');
  eq(countRejects(oneShot), 1, '★ 注入:抠掉一处记账,判据必须跟着变');

  /* ── 注入:把源码副本里的守卫抠掉,文本判据必须跟着红(证明它咬的是真代码) ── */
  const dir = mkdtempSync(join(tmpdir(), 'fnd132-'));
  try {
    const cut = wsSrc.replace('} else if (len > MAX_FRAME_BYTES) {', '} else if (false) {');
    ok(cut !== wsSrc, '注入点必须存在(否则这条判据在自说自话)');
    const copy = join(dir, 'ws_server.ts');
    writeFileSync(copy, cut, 'utf8');
    ok(!hasAll(readFileSync(copy, 'utf8'), WS_MARKS), '抠掉守卫后判据必须为假');
    /* 负对照:只改**注释**的注入不该命中(去注释后判据咬的仍是那行可执行代码) */
    const commentOnly = wsSrc.replace('/** 单帧**载荷**上界', '/** 单帧载荷上界');
    ok(commentOnly !== wsSrc, '注释注入点必须存在');
    ok(hasAll(commentOnly, WS_MARKS), '负对照:改注释不该让判据红');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

report('WS-FND-132');
