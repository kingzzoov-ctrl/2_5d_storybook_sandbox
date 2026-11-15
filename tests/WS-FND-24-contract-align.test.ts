/**
 * WS-FND-24 · 协议契约**逐字段**对齐(契约第三列:客户端那一侧)
 *
 * ## 这个套件回答什么
 *
 * `docs/COMPLETION-CRITERIA.md` §五 有一条未实测:
 * 「`RoomSchema` 与 `prediction.ts` 的 `Snapshot` **逐字段**是否对齐(只读了签名)」。
 * 本套件把它变成可复跑的判据,覆盖三列:
 *
 * ```
 * 第 1 列  shared/types/wire.ts 的四张字段表(FieldSpec,含 note)   ← 唯一线上格式事实源
 * 第 2 列  服务端装配层 RoomSchema / *Schema(schema.colyseus.ts)   ← 由 tests/WS-07 H13/H14 守
 * 第 3 列  客户端解码路径(state_store → delta.decode/apply)与
 *          prediction.ts 的 Snapshot(插值缓冲)                     ← **本套件守**
 * ```
 *
 * ## 为什么本套件**不** `import` 装配层
 *
 * `@colyseus/schema` 是 `optionalDependencies`。`tests/WS-07.test.ts` 早有一条明确约定
 * (见 `server/src/net/schema.colyseus.ts:4-8`):那套测试**只**走零依赖核心,
 * 对装配层做**文本解析**,这样「没装可选依赖」不会让门禁变红。
 * ⇒ 本套件沿用同一约定:第 2 列的一致性**不在这里重复实现**
 * (`tests/WS-07.test.ts:3301` H13 逐类对账、`:3315` H14 容器类 6 字段),
 * 只补 WS-07 **没覆盖**的那条:装配层里声明了、却没有任何写入点的字段(见 FND24-7)。
 *
 * ## 判据纪律
 *
 * 每条断言都带**期望 vs 实际**;「字段覆盖」不用「表里有、所以一定有」推定,
 * 而是走**真编码 → 真解码 → 真合入**的 round-trip,逐字段比 value。
 * 另有一条负对照(FND24-4):表外字段必须**被丢弃** ——
 * 否则「全字段覆盖」可能只是「整条对象原样复制」,那证明不了表驱动。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, includes, report } from '../shared/testing/harness.ts';

import {
  BOSS_FIELD_TABLE,
  EntityKind,
  FIELD_TABLE,
  FIELD_TYPE_BYTES,
  FieldType,
  ROOM_FIELD_TABLE,
  WILDLIFE_FIELD_TABLE,
  tableFor,
  type BossState,
  type FieldSpec,
  type PlayerState,
  type RoomState,
  type WildlifeState,
} from '../shared/types/wire.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { applyPacket, decodePacket, encodeFull } from '../shared/net/delta.ts';
import { emptyRoomState } from '../client/src/net/state_store.ts';
import { Interpolator } from '../client/src/net/prediction.ts';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════════ 0. 期望值(外部事实,不从被测代码反推)═══════════════════════════ */

/**
 * 第 1 列的期望:字段名 → bit → 类型。
 *
 * 出处:`shared/types/wire.ts:106-121`(注释「§7.2 PlayerSchema 全 13 字段 + 协议必需的
 * id/name」),以及设计手册 §7.2 的字段表。**顺序即编码顺序**,任何改动都是协议版本 bump
 * (`wire.ts:103-105` 原文)。
 */
const EXPECTED_PLAYER_FIELDS: readonly (readonly [string, number, string])[] = [
  ['id', 0, 'str'],
  ['name', 1, 'str'],
  ['level', 2, 'u8'],
  ['hp', 3, 'u16'],
  ['maxHp', 4, 'u16'],
  ['x', 5, 'pos'],
  ['y', 6, 'pos'],
  ['z', 7, 'pos'],
  ['dir', 8, 'u8'],
  ['stateFlag', 9, 'u8'],
  ['weaponId', 10, 'u16'],
  ['aiWeaponRecipeHash', 11, 'hash'],
  ['heldItemId', 12, 'u16'],
  ['carryingEntityId', 13, 'str'],
];

/**
 * 第 3 列的期望:`client/src/net/prediction.ts:177-183` 的 `Snapshot` 逐字段。
 *
 * `Snapshot` 是**类型**(编译期),运行期没有反射出口;所以这里把它写成常量,
 * 并用 FND24-5 的**行为**断言(Interpolator 只看这 4 个键、输出恰好 3 个轴)
 * 把常量钉在真实运行路径上。
 */
const SNAPSHOT_FIELDS: readonly string[] = ['tick', 'x', 'y', 'z'];

/** 表里有什么、客户端插值缓冲里有什么 —— 差集就是「玩家状态里插值看不到的部分」。 */
const NOT_IN_SNAPSHOT: readonly string[] = [
  'id', 'name', 'level', 'hp', 'maxHp', 'dir',
  'stateFlag', 'weaponId', 'aiWeaponRecipeHash', 'heldItemId', 'carryingEntityId',
];

/* ═══════════════════════════ 1. 测试夹具 ═══════════════════════════ */

/** 一份「每个字段都有非默认值」的权威状态。值都取 1/1024 定点可精确表示的二进制小数。 */
function sampleState(): RoomState {
  const s = createRoomState('room_24');
  s.meta.tick = 4242;
  s.meta.chunkVersions = { '0,0': 3, '1,-2': 17 };
  s.meta.partyMode = 2;
  s.meta.partyTimer = 12.25;
  s.meta.scoreA = 7;
  s.meta.scoreB = 9;

  const p: PlayerState = {
    id: 'abcd1234',
    name: '阿澄',
    level: 27,
    hp: 1234,
    maxHp: 2345,
    x: 12.5,
    y: -3.25,
    z: 1.75,
    dir: 3,
    stateFlag: 4,
    weaponId: 305,
    aiWeaponRecipeHash: '116_125_712',
    heldItemId: 152,
    carryingEntityId: 'wxyz9876',
  };
  s.players = [p];

  const w: WildlifeState = {
    id: 'mob00001',
    mobId: 'mob_meadow_piglet',
    x: 40.5,
    y: 33.25,
    z: 0.5,
    fsm: 2,
    hp: 30,
    maxHp: 30,
    tameOwnerId: '',
  };
  s.wildlife = [w];

  /* Boss 的 hp/telegraphEndTick 是 **u32**(上限 38000 的最强 Boss 装不进 u16) ——
     这里故意用 38000 与一个大 tick,若有人把类型改窄,本套件立刻红。 */
  const b: BossState = {
    id: 'boss0001',
    bossId: 'boss_chronos_colossus',
    phase: 2,
    hp: 38000,
    maxHp: 38000,
    telegraphShape: 4,
    telegraphX: 50.5,
    telegraphY: 50.25,
    telegraphR: 6.5,
    telegraphEndTick: 123456,
  };
  s.bosses = [b];
  return s;
}

/** 走**客户端真正用的那两个函数**:`decodePacket` → `applyPacket`(见 state_store.ts:143/153)。 */
function roundTrip(state: RoomState, headerTick: number): RoomState {
  const pkt = encodeFull(state, headerTick);
  return applyPacket(emptyRoomState(), decodePacket(pkt.bytes));
}

/**
 * 值相等判定。
 *
 * 房间级的 `chunkVersions` 在 wire 上是「排序拼接字符串」,解码后被
 * `parseChunkVersions` **重建为新对象** ⇒ 引用必然不同,必须按结构比。
 * 序列化时键已排序,所以 JSON 文本是确定性的。
 */
function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** 逐字段比一张表:key 存在、值相等。返回第一处不符的说明(全对时为空串)。 */
function firstFieldMismatch(
  table: readonly FieldSpec[],
  got: Record<string, unknown>,
  want: Record<string, unknown>,
): string {
  for (const spec of table) {
    if (!(spec.key in got)) return `${spec.key} 未出现在解码结果里`;
    if (!sameFieldValue(got[spec.key], want[spec.key])) {
      return `${spec.key}:期望 ${JSON.stringify(want[spec.key])} / 实际 ${JSON.stringify(got[spec.key])}`;
    }
  }
  return '';
}

/**
 * 出现次数(逐字计数)。**刻意不用正则**:
 * 正则的转义会被源码里的注释/字符串干扰,而这里要数的就是**字面量**。
 */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/* ═══════════════════════════ 2. 断言 ═══════════════════════════ */

test('FND24-1 字段表逐字段:14 项、bit 0..13、类型与手册 §7.2 一致(顺序即编码顺序)', () => {
  eq(FIELD_TABLE.length, 14, 'PlayerSchema 应 14 字段(§7.2 的 13 + 协议必需的 id)');
  const got = FIELD_TABLE.map((s) => [s.key, s.bit, s.type]);
  const want = EXPECTED_PLAYER_FIELDS.map((r) => [r[0], r[1], r[2]]);
  eq(got, want, '字段表(名字/bit/类型)应与期望逐项一致,实际');
  /* bit 必须严格递增 —— 顺序即编码顺序,wirte.ts:103-105 明确「任何改动都是协议版本 bump」 */
  ok(
    FIELD_TABLE.every((s, i) => i === 0 || FIELD_TABLE[i - 1].bit < s.bit),
    '字段表必须按 bit 严格升序',
  );
});

test('FND24-2 每个 FieldSpec 的 bytes 与 FIELD_TYPE_BYTES 自洽;变长类型不得有定长值', () => {
  const tables = [FIELD_TABLE, WILDLIFE_FIELD_TABLE, BOSS_FIELD_TABLE, ROOM_FIELD_TABLE];
  for (const t of tables) {
    for (const spec of t) {
      ok(spec.note.length >= 4, `${spec.key} 的 note 为空 —— FieldSpec 的可审计出处是必填项`);
      const fixed = FIELD_TYPE_BYTES[spec.type];
      if (spec.type === FieldType.STR || spec.type === FieldType.HASH) {
        ok(fixed === undefined, `${spec.key}:${spec.type} 是变长类型,不应有定长字节数(实际 ${String(fixed)})`);
        ok(spec.bytes > 0, `${spec.key}:变长类型也要给「典型字节数」供带宽估算,实际 ${spec.bytes}`);
      } else {
        eq(spec.bytes, fixed, `${spec.key}:${spec.type} 的 bytes 应等于 FIELD_TYPE_BYTES 的值,实际`);
      }
    }
  }
  /* 手册 §7.2 是玩家字段表的出处;note 里逐条写着它,便于回头核 */
  const noRef = FIELD_TABLE.filter((s) => !s.note.includes('§7.2')).map((s) => s.key);
  eq(noRef, [], '每个玩家字段的 note 都应标明手册出处(§7.2),缺的:');
});

test('FND24-3 客户端解码路径覆盖四张表的每一个字段(真编码 → 真解码 → 真合入)', () => {
  const src = sampleState();
  const got = roundTrip(src, src.meta.tick);

  /* ── 玩家:14 字段逐项 ── */
  eq(got.players.length, 1, '玩家数应保持 1,实际');
  const gp = got.players[0] as unknown as Record<string, unknown>;
  const wp = src.players[0] as unknown as Record<string, unknown>;
  eq(firstFieldMismatch(FIELD_TABLE, gp, wp), '', '玩家字段 round-trip 不符:');

  /* ── 野生动物:9 字段逐项 ── */
  eq(got.wildlife.length, 1, '野生动物数应保持 1,实际');
  eq(
    firstFieldMismatch(
      WILDLIFE_FIELD_TABLE,
      got.wildlife[0] as unknown as Record<string, unknown>,
      src.wildlife[0] as unknown as Record<string, unknown>,
    ),
    '',
    '野生动物字段 round-trip 不符:',
  );

  /* ── Boss:10 字段逐项(u32 的 hp/telegraphEndTick 在这里才有牙)── */
  eq(got.bosses.length, 1, 'Boss 数应保持 1,实际');
  eq(
    firstFieldMismatch(
      BOSS_FIELD_TABLE,
      got.bosses[0] as unknown as Record<string, unknown>,
      src.bosses[0] as unknown as Record<string, unknown>,
    ),
    '',
    'Boss 字段 round-trip 不符:',
  );

  /* ── 房间级:5 字段(注意 chunkVersions 走的是「排序拼接字符串」)── */
  const gotMeta = got.meta as unknown as Record<string, unknown>;
  const wantMeta = src.meta as unknown as Record<string, unknown>;
  eq(firstFieldMismatch(ROOM_FIELD_TABLE, gotMeta, wantMeta), '', '房间级字段 round-trip 不符:');
  eq(got.meta.chunkVersions, src.meta.chunkVersions, 'chunkVersions 必须原样还原(键排序 → 拼接 → 解析)');

  /* ── 每张表的字段数(文档里逐字段表的行数就是这四个数)── */
  eq(
    [FIELD_TABLE.length, WILDLIFE_FIELD_TABLE.length, BOSS_FIELD_TABLE.length, ROOM_FIELD_TABLE.length],
    [14, 9, 10, 5],
    '四张表的字段数应为 14/9/10/5,实际',
  );
  /* tableFor 是四张表的**唯一可达入口**(wire.ts:355-360 自述) —— 逐 kind 指向同一份数组 */
  for (const kind of [EntityKind.PLAYER, EntityKind.WILDLIFE, EntityKind.BOSS, EntityKind.ROOM]) {
    const t = tableFor(kind);
    const expect = kind === EntityKind.PLAYER ? FIELD_TABLE
      : kind === EntityKind.WILDLIFE ? WILDLIFE_FIELD_TABLE
        : kind === EntityKind.BOSS ? BOSS_FIELD_TABLE : ROOM_FIELD_TABLE;
    ok(t === expect, `tableFor(${kind}) 应返回同一份数组(引用相等),实际不是`);
  }
});

test('FND24-4 【负对照】表外字段必须被丢弃 —— 证明解码是「按表」而不是「整对象复制」', () => {
  const src = sampleState();
  /* 往玩家对象上挂一个**表里没有**的键。若解码路径是原样复制,它会被带回来。 */
  const withExtra = { ...src.players[0], notInTable: 'leaked' } as unknown as PlayerState;
  src.players = [withExtra];
  const got = roundTrip(src, src.meta.tick);
  const gp = got.players[0] as unknown as Record<string, unknown>;
  ok(!('notInTable' in gp), '表外字段 notInTable 不应出现在解码结果里 —— 出现了说明解码不是表驱动');
  eq(Object.keys(gp).sort(), FIELD_TABLE.map((s) => s.key).sort(), '解码结果的键集应恰好等于字段表的键集,实际');
});

test('FND24-5 Snapshot 只覆盖字段表的 3/14(x/y/z);它的 tick 不是实体字段', () => {
  /* ── 运行期证据:Interpolator 只吃 tick/x/y/z,输出恰好 3 个轴 ── */
  const it = new Interpolator();
  it.push({ tick: 1, x: 0, y: 0, z: 0 });
  it.push({ tick: 2, x: 2, y: 4, z: 1 });
  eq(it.size, 2, 'Interpolator 应接受这两帧(字段刚好是 tick/x/y/z),实际帧数');
  const sampled = it.sampleAtTick(1.5);
  ok(sampled !== undefined, 'sampleAtTick(1.5) 应给出采样值');
  /* ⚠️ `ok()` **不是** TS 断言签名(harness 是 throw-style),所以这里用 `?? NaN 三元` 收敛类型:
     若采样真的是 undefined,这组断言会以「期望 1 / 实际 NaN」的形式变红,而不是崩在属性读取上。 */
  const sample = sampled ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN };
  eq(Object.keys(sample).sort(), ['x', 'y', 'z'], '插值输出应恰好是 3 个轴(没有 hp/name 等),实际键集');
  /* 两帧线性插值中点 —— 顺便钉住「快照坐标与 wire 同单位(格)」这条语义 */
  eq([sample.x, sample.y, sample.z], [1, 2, 0.5], '中点插值应为 (1, 2, 0.5),实际');

  /* ── 静态逐字段:交集 / 差集 ── */
  const tableKeys = FIELD_TABLE.map((s) => s.key);
  const covered = FIELD_TABLE.filter((s) => SNAPSHOT_FIELDS.includes(s.key)).map((s) => s.key);
  const missing = FIELD_TABLE.filter((s) => !SNAPSHOT_FIELDS.includes(s.key)).map((s) => s.key);
  eq(covered, ['x', 'y', 'z'], 'Snapshot 覆盖的字段表字段应为 x/y/z,实际');
  eq(missing, NOT_IN_SNAPSHOT.slice(), '未被 Snapshot 覆盖的字段应与期望差集一致(11 个),实际');
  eq(missing.length, 11, '未被覆盖的字段应为 11 个(14 - 3),实际');

  /* ── 非显然结论:Snapshot.tick 与字段表无关 ── */
  includes(SNAPSHOT_FIELDS, 'tick', 'Snapshot 应有 tick');
  ok(!tableKeys.includes('tick'), '玩家字段表里不应有 tick —— 若有,说明「帧号走报文头」的设计被改了');
  ok(!ROOM_FIELD_TABLE.some((s) => s.key === 'tick'), '房间字段表里也不应有 tick(wire.ts:150-156 的带宽权衡)');
  /* 而 RoomMetaState **有** tick:这正是「状态里有、字段表里没有」的那处非对称 */
  const meta = createRoomState('r24').meta as unknown as Record<string, unknown>;
  ok('tick' in meta, 'RoomMetaState 应有 tick(帧号在状态里,但不在字段表里)');
});

test('FND24-6 帧号走报文头:字段表里没有 tick,applyPacket 仍能还原 tick(无条件覆盖)', () => {
  const src = sampleState();
  const headerTick = 987654;
  const pkt = encodeFull(src, headerTick);
  const dec = decodePacket(pkt.bytes);
  eq(dec.tick, headerTick, '报文头的 tick 应等于编码时给的值,实际');
  const roomUpserts = dec.upserts.filter((u) => u.kind === EntityKind.ROOM);
  ok(roomUpserts.length === 1, '全量报文里应恰好有 1 次房间级 upsert,实际');
  const roomUpsert = roomUpserts[0];
  if (roomUpsert === undefined) throw new Error('房间级 upsert 缺失 —— 上面那条 ok 应已报红');
  ok(!('tick' in roomUpsert.fields), '房间级 upsert 的字段里不应有 tick —— 若出现,说明帧号进了字段表(每帧多 ~28 字节)');
  const applied = applyPacket(emptyRoomState(), dec);
  eq(applied.meta.tick, headerTick, 'applyPacket 应无条件用报文头的 tick 覆盖 meta.tick,实际');
  ok(src.meta.tick !== headerTick, '前置条件:源状态的 tick 必须与报文头不同,否则本断言无区分力');
});

test('FND24-7 装配层有一处「声明了但零写入点」的字段:dirtyChunkKeys(不改运行时,只钉住事实)', () => {
  const src = readFileSync(join(ROOT_DIR, 'server', 'src', 'net', 'schema.colyseus.ts'), 'utf8');
  /* 声明处 1 次 + defineTypes 登记 1 次 = 2 次;没有任何 `this.dirtyChunkKeys = ...` 写入。 */
  eq(occurrences(src, 'dirtyChunkKeys'), 2, 'dirtyChunkKeys 在装配层应只出现 2 次(声明 + defineTypes),实际');
  eq(occurrences(src, 'this.dirtyChunkKeys'), 0, 'syncFrom() 不应写 dirtyChunkKeys —— 若开始写,请把本断言改成「有写入点」,实际');
  /* 它在 wire 侧**没有**对应字段:这是「装配层多出来的字段」,不会进 delta 包 */
  ok(!ROOM_FIELD_TABLE.some((s) => s.key === 'dirtyChunkKeys'), 'ROOM_FIELD_TABLE 不应有 dirtyChunkKeys(否则它就该被 delta 编码)');
  /* 期望 vs 实际(如实记录,不在本套件里修):
     期望 = 装配层的每个字段都在 wire 层有对应者并真的被 syncFrom 写;
     实际 = dirtyChunkKeys 只有声明与登记,0 个写入点 ⇒ 永远为空数组。 */
  ok(true, '结论:声明存在、写入点 0 —— 见 docs/MEASUREMENTS-S5.md §3 的「真实不一致」清单');
});

report('WS-FND-24-contract-align');