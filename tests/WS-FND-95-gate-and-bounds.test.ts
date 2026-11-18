/**
 * WS-FND-95 —— 审计第三批的判据(双端同源门禁 / 包头上界 / 钳制选址)
 *
 * ## 这一组守的是什么
 *
 * | # | 条目 | 原缺陷(实测) | 本套判据 |
 * |---|---|---|---|
 * | 1 | P3-8 双端同源 | `advise('同义反复', …)` 只告警、不进退出码 ⇒ 比"未登记候选"**更强**的证据反而更宽松 | FND95-1/2/3:默认拦 / `--lenient` 降级 / 汇总行给条数;检测器 → 判定两端都钉 |
 * | 2 | P2-13 `ticks`·`seq` | 帧头 `w.u32(tick)` 与 `(ackedSeq+1)>>>0` 对越界/非有限值**静默回绕成 0** | FND95-4/5/6/7:编码器**抛错**、解析器**拒**、写口只有一处换算 |
 * | 3 | P3-6 钳制选址 | 「越界 hp 该在哪里被钳」没有写下来的答案,两处口径各写一半 | FND95-8/9:编码器只报错、vitals 出边恒合法;约定在代码与文档里各写一次 |
 *
 * ## 判据设计的纪律(与本仓 `tests/WS-FND-74` 同款)
 *
 * ```
 * 1 每条都要能**失败**:负对照(合法输入不许红)+ 注入(把约定/判据抽掉必红)各至少一次
 * 2 行为判据优先:能真跑 `encodeDelta` / `parseMoveIntent` / `revive` 就不 grep 源码
 * 3 唯一用文本判据的是「约定写没写下来」(FND95-9)—— 它天生只有文本形态;
 *   仍然配了注入:把副本里的那两行抽掉,判据必须红
 * ```
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  MAX_ACKED_SEQ,
  MAX_U32,
  MIN_ACKED_SEQ,
  ackSlotValue,
  assertAckedSeq,
  assertU32,
  decodePacket,
  encodeDelta,
  encodeFull,
  isValidAckedSeq,
  isU32,
} from '../shared/net/delta.ts';
import { EntityKind, type PlayerState, type RoomState } from '../shared/types/wire.ts';
import { BOTH_SIDES_GATE, bothSidesVerdict, detectTautologyHits } from '../scripts/verify.ts';
import { parseMoveIntent } from '../server/src/net/ws_server.ts';
import { VitalsSystem } from '../server/src/combat/vitals.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/* ═══════════════════════ 夹具 ═══════════════════════ */

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

/** 抛错就返回文案,不抛就返回空串 —— 负对照靠它区分「红了」与「没红」。 */
function throwMsg(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

/**
 * 从全量包里取该玩家的 hp。
 *
 * ⚠️ **不能按下标取**:`encodeDelta` 先写房间级 upsert(`kind = ROOM`),
 * 玩家在它之后 —— `upserts[0].fields.hp` 恒 `undefined`
 * (我第一版就是这么写的,判据当场报「期望 65535 / 实际 undefined」)。
 * 找 upsert 要按 `(kind, id)` 找,不按位置。
 */
function playerHp(bytes: Uint8Array, id: string): unknown {
  const u = decodePacket(bytes).upserts.find((x) => x.kind === EntityKind.PLAYER && x.id === id);
  ok(u !== undefined, `应存在 PLAYER ${id} 的 upsert`);
  return u!.fields.hp;
}

/* ═════════════ 1. 双端同源:默认拦截(P3-8)═════════════ */

test('FND95-1 双端同源判定的**真值表**:默认拦、`--lenient` 才降级、0 处不拦', () => {
  /* 怎么变红:把 `block` 写成恒 false(修前的 `advise` 口径)⇒ 第 2/5 行红;
     写成恒 true ⇒ 第 1/3/4 行红。 */
  const rows: Array<[number, boolean, boolean, string]> = [
    /* count, lenient, 期望 block, 说明 */
    [0, false, false, '负对照:没有命中不许拦'],
    [1, false, true, '默认口径 ⇒ 拦截(修前这里是 false)'],
    [1, true, false, '--lenient ⇒ 降级为告警'],
    [0, true, false, '负对照:lenient + 0 处 ⇒ 仍然不拦'],
    [3, false, true, '多条同样拦'],
  ];
  for (const [count, lenient, want, why] of rows) {
    const v = bothSidesVerdict(count, lenient);
    eq(v.block, want, `count=${count} lenient=${lenient}:${why}`);
  }
  /* 门禁名必须与 `ADVISE_UPGRADE` / 汇总行用的是同一个字符串。 */
  eq(BOTH_SIDES_GATE, '同义反复·双端同源');
  eq(bothSidesVerdict(2, false).message.includes('2 处'), true, '文案里要带条数');
});

test('FND95-2 检测器 → 判定**两端都钉**:eq(A2, B2) 产 bothSides,一侧字面量不产', () => {
  /* 夹具与 `tests/WS-FND-74` 的第 8 行同形:`actual` 与 `expected` 都取自本仓常量。 */
  const names = new Map<string, string>([['A2', 'mod.ts'], ['B2', 'mod.ts'], ['FOO', 'mod.ts']]);
  const exports = new Map<string, string>([
    ['mod.ts::A2', '3'], ['mod.ts::B2', '3'], ['mod.ts::FOO', '1'],
  ]);
  const both = detectTautologyHits('eq(A2, B2);', names, exports);
  /* 怎么变红:检测器回退成"只看 expected 侧" ⇒ bothSides 恒 false(这正是 FND74-9 的形状)。 */
  eq(both.hits.filter((h) => h.bothSides).length, 1, '双端同源必须被检出');
  eq(bothSidesVerdict(both.hits.filter((h) => h.bothSides).length, false).block, true,
    '检出的条数喂给判定 ⇒ 默认必须拦');

  /* 负对照:第 2 参是字面量 ⇒ 不是双端同源,判定也不许拦。 */
  const oneSide = detectTautologyHits('eq(FOO, 16);', names, exports);
  eq(oneSide.hits.filter((h) => h.bothSides).length, 0, '一侧字面量不是双端同源');
  eq(bothSidesVerdict(0, false).block, false, '0 处 ⇒ 不拦');
});

test('FND95-3 汇总行**必须**给出双端同源条数(修前汇总行没有这个数)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8');
  /* 怎么变红:删掉 `bothSidesSuffix` 或把汇总行的插值去掉。 */
  ok(src.includes('bothSidesMeasured'), '必须有模块级测量变量');
  ok(/双端同源 \$\{bothSidesMeasured/.test(src), '汇总行必须插 `bothSidesMeasured`');
  ok(src.includes('const bothSidesSuffix'), '汇总行前缀要有具名常量(便于核对)');
  /* 注入:把那一行换成不带条数的写法,判据的判据必须红。 */
  const broken = src.replace('const bothSidesSuffix = ` · 双端同源 ${bothSidesMeasured ?? \'?\'} 处`;', '');
  ok(broken !== src, '注入点必须存在(否则本判据只是"跑过了")');
  ok(!/双端同源 \$\{bothSidesMeasured/.test(broken), '抽掉那行后判据必须不再命中');
  ok(src.includes('fail(`'), 'verify.ts 的拦截必须仍然存在');
});

/* ═════════════ 2. 帧头上界(P2-13)═════════════ */

test('FND95-4 tick:u32 端点可编码,越界/非有限整数**抛错**(不静默回绕)', () => {
  /* 端点(合法)正向:两端都必须真的写进去。 */
  for (const t of [0, MAX_U32]) {
    const pkt = encodeFull(state({ meta: { ...state().meta, tick: t } }));
    eq(decodePacket(pkt.bytes).tick, t, `tick=${t} 端点应原样往返`);
  }
  /* 非法:一律抛错。修前 `w.u32` 会把它们全写成 0 —— 这里是本判据的**牙**。 */
  const bad: unknown[] = [MAX_U32 + 1, -1, 1.5, NaN, Infinity, -Infinity];
  for (const t of bad) {
    const msg = throwMsg(() => encodeFull(state({ meta: { ...state().meta, tick: t as number } })));
    ok(msg.length > 0, `tick=${String(t)} 必须抛错(修前回绕成 0)`);
    ok(msg.includes('tick'), `错误文案要指名字段:tick=${String(t)} ⇒ ${msg}`);
  }
  /* 显式传参同样受管(不是只防 meta.tick 那一条路径)。 */
  ok(throwMsg(() => encodeDelta(null, state(), MAX_U32 + 1)).length > 0, '显式 tick 参数也要抛错');
  eq(decodePacket(encodeDelta(null, state(), MAX_U32).bytes).tick, MAX_U32, '显式参数端点可用');
});

test('FND95-5 ackedSeq 域:内部 -1..2^32-2,线上 +1;非法**抛错**', () => {
  /* 域的定义本身:上界比 u32 少 1(否则 +1 撞回绕)。 */
  eq(MIN_ACKED_SEQ, -1);
  eq(MAX_ACKED_SEQ, MAX_U32 - 1);
  eq(isValidAckedSeq(-1), true);
  eq(isValidAckedSeq(MAX_ACKED_SEQ), true);
  eq(ackSlotValue(-1), 0, '内部 -1 ⇒ 线上 0(没有魔法值)');
  eq(ackSlotValue(0), 1);
  eq(ackSlotValue(MAX_ACKED_SEQ), MAX_U32, '上界 +1 恰好等于 u32 上界');

  /* 负对照:非法值必须**抛**,而不是回绕。 */
  const bad: unknown[] = [MAX_U32, -2, 1.5, NaN, Infinity, '7', null, undefined];
  for (const v of bad) {
    ok(throwMsg(() => ackSlotValue(v)).length > 0, `ackSlotValue(${String(v)}) 必须抛错`);
    ok(throwMsg(() => assertAckedSeq(v)).length > 0, `assertAckedSeq(${String(v)}) 必须抛错`);
  }
  /* 注入验证:证明"修前那个公式确实回绕成 0"—— 这就是要防的形态。 */
  eq((MAX_U32 + 1) >>> 0, 0, '旧写法 (ackedSeq+1)>>>0 在上界+1 处回绕成 0(= "没有 ack")');
  eq((MAX_ACKED_SEQ + 1) >>> 0, MAX_U32, '合法上界的旧写法与 ackSlotValue 一致');
});

test('FND95-6 上行 `seq`:上界外**拒**(不登记 ack),移动本身照常接受', () => {
  const base = { tick: 1, x: 0.5, y: 0.5, z: 0 };
  const withSeq = (seq: unknown): ReturnType<typeof parseMoveIntent> =>
    parseMoveIntent({ ...base, seq });

  /* 正向:合法端点都要被登记。 */
  for (const seq of [0, 1, MAX_ACKED_SEQ]) {
    const r = withSeq(seq);
    ok(r.ok, `seq=${seq} 的移动意图应被接受`);
    eq(r.ok ? r.intent.seq : undefined, seq, `seq=${seq} 应登记`);
  }
  /* 负对照 + 上界:非法 seq ⇒ 当作没给(移动仍应用,但不带 ack)。
     修前 `4294967296` 会被原样登记 ⇒ 之后由 `(v+1)>>>0` 回绕成 0。 */
  for (const seq of [MAX_U32, MAX_ACKED_SEQ + 1, -1, 1.5, NaN, Infinity, '3']) {
    const r = withSeq(seq);
    ok(r.ok, `seq=${String(seq)} 不该让整次移动消失`);
    eq(r.ok ? r.intent.seq : 'x', undefined, `seq=${String(seq)} 必须被拒(不登记)`);
  }
});

test('FND95-7 线上 ack 槽位:唯一换算 + 4 字节覆写后可原样解回(P2-13 闭环)', () => {
  /* 复刻运输层 `withAckedSeq` 的写法(偏移 6、小端 u32)—— 用它验证"内部域→线上域→解码"闭环。 */
  const ACKED_SEQ_OFFSET = 6;
  const writeAck = (payload: Uint8Array, ackedSeq: number): Uint8Array => {
    const out = Uint8Array.from(payload);
    const raw = ackSlotValue(ackedSeq);
    out[ACKED_SEQ_OFFSET] = raw & 0xff;
    out[ACKED_SEQ_OFFSET + 1] = (raw >>> 8) & 0xff;
    out[ACKED_SEQ_OFFSET + 2] = (raw >>> 16) & 0xff;
    out[ACKED_SEQ_OFFSET + 3] = (raw >>> 24) & 0xff;
    return out;
  };
  const payload = encodeFull(state()).bytes;
  for (const acked of [-1, 0, 7, MAX_ACKED_SEQ]) {
    eq(decodePacket(writeAck(payload, acked)).ackedSeq, acked, `ackedSeq=${acked} 必须原样解回`);
  }
  /* 负对照:不覆写时占位 0 ⇒ -1(「本帧没带 ack」),不是"第 0 条"。 */
  eq(decodePacket(payload).ackedSeq, -1, '占位 0 必须解成 -1');
  /* 服务端的写口只有一处换算:非法值在这里就红了,不会流到字节里。 */
  ok(throwMsg(() => writeAck(payload, MAX_U32)).length > 0, '越界 acked 必须抛错,不许写出回绕字节');
});

/* ═════════════ 3. 钳制选址的单点约定(P3-6)═════════════ */

test('FND95-8 越界 hp:编码器**抛错**,vitals 出来的**一定合法**(两条同时成立)', () => {
  /* 半边一:**非法状态**在编码器这里必须红(它只负责报错)。 */
  const illegal: unknown[] = [65536, 70000, -1, NaN, Infinity];
  for (const hp of illegal) {
    const msg = throwMsg(() => encodeFull(state({ players: [player('p1', { hp: hp as number })] })));
    ok(msg.length > 0, `hp=${String(hp)} 必须抛错(编码器不做静默钳位)`);
    ok(/越界|非法取值/.test(msg), `错误文案要能区分「越界」:hp=${String(hp)} ⇒ ${msg}`);
  }
  /* 负对照:u16 端点仍可编码 —— 不许把判据做成"凡是 hp 都报错"。 */
  eq(playerHp(encodeFull(state({ players: [player('p1', { hp: 65535 })] })).bytes, 'p1'),
    65535, '端点 65535 必须可用');

  /* 半边二:同一个病态输入喂 vitals,出边一定落在 [0, maxHp] 且能编码。 */
  const vs = new VitalsSystem(); /* 缺省 maxHp = PLAYER_BASE_HP = 100 */
  vs.register('p1');
  const pathological: number[] = [535, -5, NaN, Infinity, -Infinity, 1e9];
  for (const bad of pathological) {
    ok(vs.revive('p1', bad), 'revive 必须成功(它是公开入口)');
    const v = vs.get('p1')!;
    ok(Number.isFinite(v.hp), `revive(${String(bad)}) ⇒ hp=${v.hp} 必须是有限数`);
    ok(v.hp >= 0 && v.hp <= v.maxHp, `revive(${String(bad)}) ⇒ hp=${v.hp} 必须在 [0, ${v.maxHp}]`);
    const bytes = encodeFull(state({ players: [player('p1', { hp: v.hp, maxHp: v.maxHp })] })).bytes;
    eq(playerHp(bytes, 'p1'), Math.round(v.hp), 'vitals 的值必须能正常上线');
  }
  /* 另外三条写点也各钉一次(它们都在同一个类里,不是"只有 revive 好使")。 */
  vs.revive('p1', 100);
  vs.applyDamage('p1', 1e9, { ignoreIframe: true });
  eq(vs.get('p1')!.hp, 0, 'applyDamage 只能把 hp 打到 0(不会到负)');
  vs.revive('p1', 100);
  vs.heal('p1', 1e9);
  eq(vs.get('p1')!.hp, vs.get('p1')!.maxHp, 'heal 不许超过 maxHp');
  vs.syncMaxHp('p1', 50);
  ok(vs.get('p1')!.hp <= 50, 'syncMaxHp 下调上限时必须把 hp 一起钳下来');
});

test('FND95-9 单点约定**各写一次**:vitals(钳) + delta(只报错) + 文档 §7.5', () => {
  const vitalsSrc = readFileSync(join(ROOT, 'server/src/combat/vitals.ts'), 'utf8');
  const deltaSrc = readFileSync(join(ROOT, 'shared/net/delta.ts'), 'utf8');
  const docSrc = readFileSync(join(ROOT, 'docs/AUDIT-W34.md'), 'utf8');

  /** 一组必须同时出现的锚 ⇒ 少一个就说明这段约定被删/被搬走了。 */
  const hasAll = (src: string, marks: readonly string[]): boolean => marks.every((m) => src.includes(m));
  const VITALS_MARKS = ['钳制选址的**单点约定**', '`shared/net/delta.ts` 的 `toUint`', '不变量 `0 ≤ hp ≤ maxHp`'];
  const DELTA_MARKS = ['只报错,不钳', 'server/src/combat/vitals.ts', 'WS-FND-95-gate-and-bounds.test.ts'];
  const DOC_MARKS = ['### 7.5 ★ 钳制选址的**单点约定**', '越界 hp(> 65535 / 负 / NaN / 非数值)⇒ throw',
    '钳制(写进状态)   server/src/combat/vitals.ts'];

  ok(hasAll(vitalsSrc, VITALS_MARKS), 'vitals.ts 里必须有「单点约定」块(钳制侧)');
  ok(hasAll(deltaSrc, DELTA_MARKS), 'delta.ts 的 toUint 必须写明「只报错,不钳」并指向 vitals');
  ok(hasAll(docSrc, DOC_MARKS), 'docs/AUDIT-W34.md §7.5 必须记下同一条约定');

  /* 注入:把 vitals 那段抽掉一份副本 ⇒ 判据必须红(证明它不是因为"总能命中"才绿)。 */
  const dir = mkdtempSync(join(tmpdir(), 'fnd95-'));
  try {
    const cut = vitalsSrc.replace('钳制选址的**单点约定**', '（已删除的约定）');
    ok(cut !== vitalsSrc, '注入点必须存在');
    const copy = join(dir, 'vitals.ts');
    writeFileSync(copy, cut, 'utf8');
    ok(!hasAll(readFileSync(copy, 'utf8'), VITALS_MARKS), '抽掉约定后判据必须为假');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* 常量断言:让 `isU32` 这两个端点与 `MAX_U32` 的口径绑在一起(改宽度时它先红)。 */
test('FND95-10 u32 判据的端点:0 与 MAX_U32 合法,两侧各一格非法', () => {
  eq(isU32(0), true);
  eq(isU32(MAX_U32), true);
  eq(isU32(MAX_U32 + 1), false);
  eq(isU32(-1), false);
  eq(isU32(1.5), false);
  eq(isU32(NaN), false);
  eq(assertU32('probe', 7), 7, '合法值必须原样返回(便于写成 w.u32(assertU32(...)))');
  /* 负对照:同一个判据对非法值**必须**抛错 —— 否则上面那行只是"函数能跑"。 */
  ok(throwMsg(() => assertU32('probe', MAX_U32 + 1)).includes('probe'), '错误文案要指名字段');
});

report('WS-FND-95');