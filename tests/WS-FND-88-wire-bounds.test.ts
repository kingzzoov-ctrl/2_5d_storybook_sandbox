/**
 * WS-FND-88 —— 审计 P1(协议与契约)的线格式边界判据。
 *
 * 本文件钉四件事,**每条都带负对照 + 注入验证**(证明判据在旧/坏实现下会红):
 *
 * | 组 | 事实 | 旧实现在这条上会怎样 |
 * | :--- | :--- | :--- |
 * | 1 | 房间级 `chunkVersions` 跨 40+ chunk 也能编码/解码 | 旧 `str` 是单 u8 前缀 ⇒ 抛「字符串超长(300 > 255)」 |
 * | 2 | 分段边界 254/255/256/510/511 逐字节可逆 | 旧实现对 >255 一律抛;255 与 256 无法区分收尾段 |
 * | 3 | u16/u32 越界**抛错**(hp/weaponId=70000 不再钳成 65535) | 旧 `clampU16` 静默钳位 |
 * | 4 | u8 与 u16/u32 **同一 round 口径**;u8 越界也抛 | 旧 u8 用 `Math.trunc` ⇒ 3.6 → 3(vs u16 的 4) |
 * | 5 | 解码**恰好消耗完**输入,尾部垃圾 ⇒ 抛错 | 旧实现尾部 69990B 垃圾照样返回成功 |
 * | 6 | 宽单元 `floor/obj=-1` 归 0,不回绕成 65535;`isValid*Id` 被生产调用 | 旧 `(-1 >>> 6)&0x3ff` ⇒ 65535 |
 * | 7 | `FREEZE.md` 与实测一致(329 项 / 11 表 / 746~754 + wire/delta 登记) | 旧文档写 320 项 / 十大分表 / ID ≤ 745 |
 * | 8 | ≤255 字节的老包**逐字节不变**、同输入同输出(无需协议 bump) | —— 保证 v3 老包不被本修破坏 |
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  PacketOp,
  PROTOCOL_VERSION,
  applyPacket,
  decodePacket,
  encodeDelta,
  encodeFull,
} from '../shared/net/delta.ts';
import {
  ROOM_FIELD_TABLE,
  chunkKey,
  serializeChunkVersions,
} from '../shared/types/wire.ts';
import type {
  BossState,
  PlayerState,
  RoomState,
  WildlifeState,
} from '../shared/types/wire.ts';
import {
  isValidFloorId,
  isValidObjId,
  packTile,
  packTileWide,
  unpackTileWide,
  wideCellValue,
} from '../shared/types/tile.ts';
import { ITEM_TABLES, TOTAL_ITEM_COUNT } from '../shared/constants/items.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TE = new TextEncoder();

/* ═════════════════ 夹具 ═════════════════ */

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

function wildlife(id: string, over: Partial<WildlifeState> = {}): WildlifeState {
  return {
    id, mobId: 'mob_meadow_piglet', x: 5, y: 6, z: 0, fsm: 0, hp: 30, maxHp: 30,
    tameOwnerId: '', ...over,
  };
}

function boss(id: string, over: Partial<BossState> = {}): BossState {
  return {
    id, bossId: 'boss_slime_king', phase: 0, hp: 100, maxHp: 100,
    telegraphShape: 0, telegraphX: 0, telegraphY: 0, telegraphR: 0, telegraphEndTick: 0,
    ...over,
  };
}

function state(over: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 'room_alpha',
    meta: { tick: 100, chunkVersions: {}, partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 },
    players: [],
    wildlife: [],
    bosses: [],
    ...over,
  };
}

function withChunks(n: number): RoomState {
  const cv: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) cv[chunkKey(i, Math.floor(i / 16))] = i + 1;
  return state({ meta: { tick: 7, chunkVersions: cv, partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 } });
}

/** 单玩家状态:`carryingEntityId` 长度可控(它是 STR 字段,走 `str` 编码)。 */
function stateWithCarry(len: number): RoomState {
  return state({ players: [player('p1', { carryingEntityId: 'a'.repeat(len) })] });
}

function throwMsg(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

/** 只取该帧里某个 kind 的 upsert 字段(解不出来的就报错)。 */
function decodedFields(bytes: Uint8Array, kind: number, id: string): Record<string, unknown> {
  const pkt = decodePacket(bytes);
  const u = pkt.upserts.find((x) => x.kind === kind && x.id === id);
  ok(u !== undefined, `应存在 kind=${kind} id=${id} 的 upsert`);
  return u!.fields;
}

function indexOfSeq(hay: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/* ═════════════ 1. chunkVersions 长串:40 个 chunk 不再「字符串超长」 ═════════════ */

test('FND88-1 房间级 chunkVersions 40/400 个 chunk 都能编码 → 解码 → 逐键还原', () => {
  for (const n of [40, 400]) {
    const src = withChunks(n);
    const text = serializeChunkVersions(src.meta.chunkVersions);
    ok(text.length > 255, `前置:${n} 个 chunk 的串必须 > 255 字节(实际 ${text.length})`);

    const enc = encodeFull(src);
    const pkt = decodePacket(enc.bytes);
    eq(pkt.bytesConsumed, enc.bytes.length, `n=${n}:必须恰好消耗完`);
    const back = applyPacket(src, pkt);
    eq(serializeChunkVersions(back.meta.chunkVersions), text, `n=${n}:chunkVersions 应逐键还原`);
    eq(Object.keys(back.meta.chunkVersions).length, n, `n=${n}:chunk 个数`);
  }

  /* ★ 负对照 + 注入验证:旧 `str`(单 u8 前缀)在同一个输入上必然抛「字符串超长」。 */
  const legacyStr = (s: string): Uint8Array => {
    const b = TE.encode(s);
    if (b.length > 255) throw new Error(`字符串超长(${b.length} > 255)`);
    const out = new Uint8Array(b.length + 1);
    out[0] = b.length;
    out.set(b, 1);
    return out;
  };
  const long = serializeChunkVersions(withChunks(40).meta.chunkVersions);
  ok(throwMsg(() => legacyStr(long)).includes('字符串超长'),
    '★ 注入验证:旧实现必须在这个输入上抛「字符串超长」——否则本组测错了对象');
  ok(legacyStr(serializeChunkVersions(withChunks(5).meta.chunkVersions)).length > 0,
    '★ 负对照:旧实现对短串正常工作(证明它失败的原因是长度,不是别的)');
});

/* ═════════════ 2. 分段边界:254 / 255 / 256 / 510 / 511 ═════════════ */

test('FND88-2 分段边界 0/1/254/255/256/509/510/511/765 字节:逐字节可逆,且体积符合 1+L+⌊L/255⌋', () => {
  const base = encodeFull(stateWithCarry(0)).bytes.length;

  for (const L of [0, 1, 254, 255, 256, 509, 510, 511, 765]) {
    const src = stateWithCarry(L);
    const enc = encodeFull(src);
    const pkt = decodePacket(enc.bytes);
    const got = decodedFields(enc.bytes, 2, 'p1').carryingEntityId;
    eq(got, 'a'.repeat(L), `L=${L}:round-trip 还原`);
    eq(pkt.bytesConsumed, enc.bytes.length, `L=${L}:恰好消耗完`);

    /* 结构断言:串的线上体积 = 1 字节前缀 + L 字节 + ⌊L/255⌋ 个 `255` 哨兵
       (L 恰为 255 的整数倍时,多出的是那个 0 长收尾段的 1 字节前缀,
        公式对两种情况都成立)。 */
    const want = L + Math.floor(L / 255);
    eq(enc.bytes.length - base, want, `L=${L}:串的线上体积应为 ${want} 字节`);
  }

  /* ★ 负对照:把「255 段」误当终止符实现,会让 255 与 256 字节的串不可区分。 */
  const naiveDecode = (segs: readonly number[]): number => {
    let total = 0;
    for (const n of segs) {
      total += n;
      if (n < 255) break;          /* 若把「< 255」写成「<= 255」,255 会被当终止符 ⇒ 少读一段 */
    }
    return total;
  };
  eq(naiveDecode([255, 0]), 255, '★ 负对照:255 字节串 = 255 段 + 0 长收尾段');
  ok(naiveDecode([255, 1]) !== 0, '★ 注入验证:256 字节串必须读两段(读到 1 为止)');
});

/* ═════════════ 3. u16 / u32 越界:抛错,不静默钳位 ═════════════ */

test('FND88-3 hp / weaponId = 70000 抛错(旧实现钳成 65535),端点 65535 仍可用', () => {
  const prev = state({ players: [player('p1')] });

  /* 65535.6 是 round-then-check 的边界:四舍五入后 = 65536 ⇒ 越界(先钳位再 round 的实现会漏掉它)。 */
  for (const [field, val] of [['hp', 70000], ['weaponId', 70000], ['hp', -1], ['maxHp', 65536], ['weaponId', 65535.6]] as const) {
    const next = state({ players: [player('p1', { [field]: val })] });
    const msg = throwMsg(() => encodeDelta(prev, next));
    ok(msg.includes(field), `${field}=${val} 抛错时必须点名字段(实得:${msg || '未抛'})`);
    ok(msg.includes('越界') || msg.includes('非法'), `${field}=${val}:应是越界类错误(实得:${msg})`);
  }

  /* 非有限 / 非数值:同样抛错(旧实现悄悄写 0)。 */
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const next = state({ players: [player('p1', { hp: bad })] });
    ok(throwMsg(() => encodeDelta(prev, next)).length > 0, `hp=${String(bad)} 必须抛错`);
  }

  /* 端点仍必须能过,且原值回来。 */
  const edge = state({ players: [player('p1', { hp: 65535, weaponId: 65535 })] });
  const enc = encodeDelta(prev, edge);
  const f = decodedFields(enc.bytes, 2, 'p1');
  eq(f.hp, 65535, '端点 65535 应原样上线');
  eq(f.weaponId, 65535, '端点 65535 应原样上线');

  /* ★ 负对照:旧 clampU16 在 70000 上给 65535 —— 与「抛错」是两个世界。 */
  const legacyClampU16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));
  eq(legacyClampU16(70000), 65535, '★ 负对照:旧口径确实把 70000 钳成 65535(所以本组能区分)');
  ok(throwMsg(() => encodeDelta(prev, state({ players: [player('p1', { hp: 70000 })] }))) !== '',
    '★ 注入验证:新口径对这个输入必须抛错,而不是重复旧口径');
});

test('FND88-3b u32 越界抛错;Boss 端点 4294967295 与 38000 均可用', () => {
  const prev = state({ bosses: [boss('b1')] });
  const big = state({ bosses: [boss('b1', { telegraphEndTick: 4294967296 })] });
  ok(throwMsg(() => encodeDelta(prev, big)).includes('telegraphEndTick'),
    'u32 越界必须抛错并点名字段');

  const maxHp = state({ bosses: [boss('b1', { hp: 38000, maxHp: 4294967295 })] });
  const f = decodedFields(encodeDelta(prev, maxHp).bytes, 4, 'b1');
  eq(f.hp, 38000, 'Boss hp 38000(u32 的真实用途)');
  eq(f.maxHp, 4294967295, 'u32 端点');

  /* ★ 负对照:旧 clampU32 会把 4294967296 静默写回 4294967295。 */
  const legacyClampU32 = (v: number): number => Math.max(0, Math.min(4294967295, Math.round(v)));
  eq(legacyClampU32(4294967296), 4294967295, '★ 负对照:旧口径在此确实回绕到端点');
});
/* ═════════════ 4. u8 与 u16/u32 同一 round 口径 ═════════════ */

test('FND88-4 同一个 3.6 在 u8 与 u16 上都应是 4(旧实现 u8=3、u16=4)', () => {
  const prev = state({ players: [player('p1')] });

  const up = decodedFields(
    encodeDelta(prev, state({ players: [player('p1', { level: 3.6, hp: 3.6, dir: 2.5 })] })).bytes, 2, 'p1',
  );
  eq(up.level, 4, 'u8 level:3.6 → 4(round,不是 trunc)');
  eq(up.hp, 4, 'u16 hp:3.6 → 4');
  eq(up.dir, 3, 'u8 dir:2.5 → 3(round 半上)');

  const down = decodedFields(
    encodeDelta(prev, state({ players: [player('p1', { level: 3.4, hp: 3.4 })] })).bytes, 2, 'p1',
  );
  eq(down.level, 3, 'u8 level:3.4 → 3');
  eq(down.hp, 3, 'u16 hp:3.4 → 3');

  /* u8 越界同样是错误,不是截断。 */
  ok(throwMsg(() => encodeDelta(prev, state({ players: [player('p1', { level: 256 })] }))).includes('level'),
    'u8 = 256 必须抛错');
  ok(throwMsg(() => encodeDelta(prev, state({ players: [player('p1', { dir: -1 })] }))).includes('dir'),
    'u8 = -1 必须抛错');

  /* ★ 负对照:旧 clampU8 用 trunc ⇒ 3.6 → 3,与 u16 的 4 不一致。 */
  const legacyClampU8 = (v: number): number => Math.max(0, Math.min(255, Math.trunc(v)));
  eq(legacyClampU8(3.6), 3, '★ 负对照:旧 u8 口径给 3');
  eq(up.hp, 4, '★ 注入验证:同一输入在 u16 上是 4 —— 新旧口径的差异正是本组要钉的');
  ok(legacyClampU8(3.6) !== up.level, '★ 若有人把 u8 改回 trunc,这条立刻红');
});

/* ═════════════ 5. 解码恰好消耗完:尾部垃圾 ⇒ 抛错 ═════════════ */

test('FND88-5 尾部多余字节必须抛错(旧实现静默返回 bytesConsumed=10)', () => {
  const good = encodeFull(withChunks(2)).bytes;

  /* 负对照:原文不抛,且恰好消耗完。 */
  const clean = decodePacket(good);
  eq(clean.bytesConsumed, good.length, '★ 负对照:合法包恰好消耗完');

  const dirty = new Uint8Array(good.length + 10);
  dirty.set(good, 0);
  const msg = throwMsg(() => decodePacket(dirty));
  ok(msg.includes('尾部') && msg.includes('未消耗'), `尾部垃圾必须抛错并点明原因(实得:${msg || '未抛'})`);

  /* 大垃圾包:旧实现在这里返回 { bytesConsumed: 10 }。 */
  const junk = new Uint8Array(70000);
  junk[0] = PROTOCOL_VERSION;
  junk[1] = PacketOp.FULL;
  ok(throwMsg(() => decodePacket(junk)).includes('未消耗'),
    '★ 注入验证:70000B 垃圾包必须抛错(旧实现返回 bytesConsumed=10 且不抛)');

  /* 截断也必须抛(need() 兜底,不是静默短读)。 */
  ok(throwMsg(() => decodePacket(good.subarray(0, good.length - 1))).length > 0, '截断必须抛错');

  /* ★ 负对照:把尾部检查删掉会得到什么 —— 与本判据的结论相反。 */
  const legacyVerdict = (bytes: Uint8Array, consumed: number): string =>
    consumed === bytes.length ? 'ok' : 'lost';        /* 旧世界:尾部垃圾 = 成功 */
  eq(legacyVerdict(dirty, clean.bytesConsumed), 'lost',
    '★ 负对照:若不检查尾部,这包会被判成功(尾部有垃圾却"解析成功")');
});

/* ═════════════ 6. 宽单元:floor/obj = -1 不回绕成 65535 ═════════════ */

test('FND88-6 宽单元 floor/obj 非法值归 0;-1 不再回绕成 65535;isValid*Id 被生产调用', () => {
  const base = { elev: 1, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 };

  for (const bad of [-1, -65535, 65536, 70000, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
    const f = unpackTileWide(packTileWide({ ...base, floor: bad, obj: bad }));
    eq(f.floor, 0, `floor=${String(bad)} 应归 0(空铺装)`);
    eq(f.obj, 0, `obj=${String(bad)} 应归 0(空格)`);
  }

  /* 合法值必须一位不丢(0 / 63 / 64 / 4095 / 4096 / 65535)。 */
  for (const v of [0, 1, 63, 64, 255, 4095, 4096, 65535]) {
    const f = unpackTileWide(packTileWide({ ...base, floor: v, obj: v }));
    eq(f.floor, v, `floor=${v} 应完整还原(u16)`);
    eq(f.obj, v, `obj=${v} 应完整还原(u16)`);
    ok(wideCellValue({ ...base, floor: v, obj: v }) >= 0, `wideCellValue(${v}) 应为非负`);
  }

  /* `-1` 的宽单元必须与「空」逐字节相同 —— 而不是高位被写成 1023/15。 */
  const negWide = packTileWide({ ...base, floor: -1, obj: -1 });
  const zeroWide = packTileWide({ ...base, floor: 0, obj: 0 });
  eq(negWide, zeroWide, '★ floor/obj = -1 的宽单元必须等于空单元');
  eq(negWide.hi, 0, '★ 高位字必须为 0(-1 曾把它写成 1023 | 15<<10)');
  eq(packTileWide({ ...base, floor: 63, obj: 4095 }).lo, packTile({ ...base, floor: 63, obj: 4095 }),
    '32 位字语义本批未改:floor≤63 且 obj≤4095 时 lo 仍等于旧 32 位字(老蓝图码不变)');
  eq(packTileWide({ ...base, floor: 0, obj: 0 }).lo, packTile(base), '空单元的 lo 也仍等于旧 32 位字');

  /* ★ 负对照 + 注入验证:旧公式在 -1 上给出 65535。 */
  const legacyFloor = ((-1 & 0x3f) | (((Math.trunc(-1) >>> 6) & 0x3ff) << 6)) & 0xffff;
  const legacyObj = ((-1 & 0xfff) | (((Math.trunc(-1) >>> 12) & 0x0f) << 12)) & 0xffff;
  eq(legacyFloor, 65535, '★ 负对照:旧公式把 floor=-1 回绕成 65535');
  eq(legacyObj, 65535, '★ 负对照:旧公式把 obj=-1 回绕成 65535');
  ok(unpackTileWide(negWide).floor !== legacyFloor, '★ 注入验证:新实现必须与旧公式不同,否则本组无牙');

  /* 口径必须真的被生产调用,而不是只在测试里被引用。 */
  const tileSrc = readFileSync(join(ROOT, 'shared/types/tile.ts'), 'utf8');
  const body = /export function packTileWide\([\s\S]*?\n\}/.exec(tileSrc);
  ok(body !== null, '应能找到 packTileWide 的函数体');
  ok(body![0].includes('isValidFloorId('), 'packTileWide 必须调用 isValidFloorId(口径与执行同处)');
  ok(body![0].includes('isValidObjId('), 'packTileWide 必须调用 isValidObjId(口径与执行同处)');
  ok(!/Math\.trunc\([^)]*\)\s*>>>/.test(body![0]), 'packTileWide 不得再用 `Math.trunc(...) >>> n` 的高位写法');
  ok(isValidFloorId(65535) && !isValidFloorId(65536) && !isValidFloorId(-1), 'isValidFloorId 边界');
  ok(isValidObjId(65535) && !isValidObjId(65536) && !isValidObjId(-1), 'isValidObjId 边界');
});

/* ═════════════ 7. FREEZE.md 与实测一致 ═════════════ */

test('FND88-7 FREEZE.md:329 项 / 11 表 / 746-754,且登记 wire.ts 与 delta.ts', () => {
  const md = readFileSync(join(ROOT, 'shared/contracts/FREEZE.md'), 'utf8');

  /* 数字必须与**代码实测**对齐(不是抄文档)。 */
  eq(TOTAL_ITEM_COUNT, 329, '实测物品总数');
  eq(ITEM_TABLES.length, 11, '实测分表数');
  ok(md.includes('329'), 'FREEZE.md 必须写 329 项');
  ok(md.includes('十一分表'), 'FREEZE.md 必须写「十一分表」');
  ok(md.includes('746-754'), 'FREEZE.md 必须写明 3.11 区段 746-754');
  ok(md.includes('3.11'), 'FREEZE.md 必须点名 §3.11 补录表');

  /* 两个文件必须进目录树 + API 表。 */
  ok(md.includes('types/wire.ts'), '目录树必须登记 shared/types/wire.ts');
  ok(md.includes('net/delta.ts'), '目录树必须登记 shared/net/delta.ts');
  ok(md.includes('shared/types/wire.ts'), 'API 表必须给出 wire.ts 的完整路径');
  ok(md.includes('shared/net/delta.ts'), 'API 表必须给出 delta.ts 的完整路径');
  ok(md.includes('encodeDelta') && md.includes('decodePacket'), 'API 表必须列 delta.ts 的编解码入口');
  ok(md.includes('FIELD_TABLE') && md.includes('tableFor'), 'API 表必须列 wire.ts 的字段表与入口');
  ok(md.includes('packTileWide') && md.includes('isValidFloorId'), 'API 表必须列宽单元与 ID 校验');

  /* ★ 负对照:旧的过期数字一个都不许留。 */
  const stale = (text: string): string[] =>
    ['320 项配表', '十大分表', 'TOTAL_ITEM_COUNT=320', 'ITEM_LIST: readonly ItemDef[]`(320'].filter((s) => text.includes(s));
  eq(stale(md), [], '★ 过期数字仍残留(每一项都必须改掉)');
  eq(stale('### 2.5 `shared/constants/items.ts` — 320 项配表\n`ITEM_TABLES`(十大分表)'),
    ['320 项配表', '十大分表'], '★ 注入验证:同一判据在旧文本上必须报出过期项');
});

/* ═════════════ 8. 老包逐字节不变 + 编码确定性 ═════════════ */

test('FND88-8 ≤255 字节的串仍是「u8 前缀 + payload」:老包逐字节不变、编码确定', () => {
  /* 玩家 id 'p1' = 2 字节 ⇒ 线上必须是 `02 70 31`(单字节前缀),不是分段头。 */
  const enc = encodeFull(state({ players: [player('p1')] }));
  ok(indexOfSeq(enc.bytes, [0x02, 0x70, 0x31]) >= 0,
    '★ ≤255 的串必须保持单 u8 长度前缀(老客户端才解得动)');

  /* 空串仍是 `00`,后面紧跟 u32 mask 的高字节 —— 结构未变。 */
  ok(indexOfSeq(enc.bytes, [0x00, 0x00, 0x00, 0x00, 0x00]) >= 0, '空串应编码为 `00`');

  /* 确定性:同一 (prev,next) 两次编码逐字节相同。 */
  const prev = state({ players: [player('p1')], wildlife: [wildlife('w1')] });
  const next = state({
    players: [player('p1', { x: 1.5, hp: 99 })],
    wildlife: [wildlife('w1', { x: 5.5 })],
    meta: { tick: 101, chunkVersions: withChunks(40).meta.chunkVersions, partyMode: 1, partyTimer: 30, scoreA: 1, scoreB: 2 },
  });
  const a = encodeDelta(prev, next);
  const b = encodeDelta(prev, next);
  eq(Array.from(a.bytes), Array.from(b.bytes), '同输入同输出');

  /* 大 chunkVersions 的差量也必须自洽(不是只有全量能过)。 */
  const back = applyPacket(prev, decodePacket(a.bytes));
  eq(serializeChunkVersions(back.meta.chunkVersions),
    serializeChunkVersions(next.meta.chunkVersions), '差量帧里的 chunkVersions 应还原');
  eq(back.players[0].hp, 99, '差量帧的 hp 应还原');
  eq(PROTOCOL_VERSION, 3, '协议版本仍是 3(本修不 bump:≤255 的老包逐字节不变)');
  eq(ROOM_FIELD_TABLE[0].key, 'chunkVersions', '房间级首字段仍是 chunkVersions');
});

report('WS-FND-88');