/**
 * WS-FND-128 —— **不变量**的判据(每条一个正例 + 一个反例 + 一次注入验证)。
 *
 * ## 这个套件钉的三件事
 *
 * ```text
 * 1 有这条判据:正例快照下该条通过(⇒ 它不是恒假,不是"一律报违反");
 * 2 这条判据抓得住:它对应的反例被抓到,且**违规集合恰好是它一条**
 *   (⇒ 归因唯一,不是被别的条目顺手抓到);
 * 3 这条判据**有牙**(注入验证):把它换成恒真 ⇒ 那个反例**不再被抓到**
 *   ⇒ 抓到它的正是这一条。同时断言注入物**真的被调用过一次** ——
 *     若 overrides 接错(拼错 code / 按措辞匹配),注入物一次都不跑,
 *     而"注入后不再被抓到"会**恰好成立** ⇒ 那是最危险的假绿。
 * ```
 *
 * ## 判据纪律
 *
 * ```text
 * · 快照/反例的**唯一事实源**是 `scripts/invariants.ts`(门禁调用的同一份)——
 *   本套件不另抄一份快照,否则"测试里的那份"与"门禁跑的那份"会各自漂移;
 * · 期望值写字面量(不在期望槽位引用本仓常量),避免"上游一改就跟着变";
 * · 每个反例都从正例派生且**只改一处** —— 这是"归因唯一"能被断言的前提,
 *   顺手踩到第二条时该修的是反例,不是放宽断言。
 * ```
 *
 * 运行:`node tests/WS-FND-128-invariants.test.ts`
 */

import { eq, ok, report, test } from '../shared/testing/harness.ts';
import {
  INVARIANT_CODES,
  checkAll,
  summarize,
  violations,
} from '../server/src/invariants.ts';
import type {
  InvariantCheck,
  InvariantCode,
  InvariantResult,
  InvSnapshot,
} from '../server/src/invariants.ts';
import {
  VIOLATION_CASES,
  forceAlwaysOk,
  goodSnapshot,
  runSelfcheck,
} from '../scripts/invariants.ts';

/** 取某个 code 的结果(缺了直接红 —— 不许静默跳过)。 */
function resultOf(snap: InvSnapshot, code: InvariantCode): InvariantResult {
  const r = checkAll(snap).find((x) => x.code === code);
  ok(r !== undefined, `结果里缺 ${code} —— 注册表与实现不同集合`);
  return r!;
}

/** 取某个 code 的反例(缺了直接红 —— 没有反例等于这条没被验过)。 */
function caseOf(code: InvariantCode): (typeof VIOLATION_CASES)[number] {
  const c = VIOLATION_CASES.find((v) => v.code === code);
  ok(c !== undefined, `反例表里缺 ${code} —— 每条不变量都必须有一个只踩它的反例`);
  return c!;
}

/* ═════════════ 0 注册表与反例表(先钉"覆盖面"本身)═════════════ */

test('FND128-0 注册表:8 条不变量、每个 code 恰好一条结果、反例一一对应', () => {
  eq(INVARIANT_CODES.length, 8, '不变量条数');
  const snap = goodSnapshot();
  const results = checkAll(snap);
  eq(results.length, 8, '结果条数');
  eq(new Set(results.map((r) => r.code)).size, 8, 'code 去重后条数(不得有重复/缺失)');
  eq(results.map((r) => r.code), [...INVARIANT_CODES], '结果顺序必须与注册表一致');
  eq(VIOLATION_CASES.length, 8, '反例条数');
  eq(VIOLATION_CASES.map((c) => c.code), [...INVARIANT_CODES], '反例必须与注册表一一对应');
});

/* ═════════════ 1 每条不变量:正例 / 反例 / 注入验证 ═════════════ */

for (const code of INVARIANT_CODES) {
  test(`FND128 正例 ${code}:干净快照下该条通过`, () => {
    const r = resultOf(goodSnapshot(), code);
    eq(r.ok, true, `${code} 在正例快照上必须通过(detail:${r.detail})`);
    ok(r.detail.trim().length > 0, '通过时也要给 detail(否则"通过了什么"无从核对)');
  });

  test(`FND128 反例 ${code}:只踩这一条的快照被抓到`, () => {
    const c = caseOf(code);
    const r = resultOf(c.make(), code);
    eq(r.ok, false, `${code} 应报违反 —— ${c.why}`);
    eq(violations(c.make()).map((v) => v.code), [code],
      '违规集合必须**恰好**是这一条(归因唯一)');
    ok(r.detail.trim().length > 0, `detail 要能指到具体 id / 差值,实测:${r.detail}`);
  });

  test(`FND128 注入 ${code}:改成恒真后这个反例不再被抓到`, () => {
    const c = caseOf(code);
    const snap = c.make();
    let used = 0;
    const overrides: Partial<Record<InvariantCode, InvariantCheck>> = {};
    overrides[code] = forceAlwaysOk(code, () => { used += 1; });
    const injected = checkAll(snap, { overrides });
    eq(used, 1, '注入物必须真的被调用一次(否则"不再被抓到"是假证据)');
    eq(injected.find((r) => r.code === code)?.ok, true, '该条已被换成恒真');
    eq(injected.some((r) => r.code === code && !r.ok), false, '恒真之后不得再报违反');
    /* ★ 注入只换**一条**:其余条目照旧。否则"恒真"可能是整体被静默关掉。 */
    eq(injected.filter((r) => !r.ok).map((r) => r.code), [],
      '注入一条之后其余条目仍应全过(证明这个反例只踩一条、且注入是逐条的)');
  });
}

/* ═════════════ 2 边界(≤ 不是 <、上界恰好取到)═════════════ */

test('FND128-边界 容器恰好装满通过、容量等于件数不算溢出', () => {
  const s = goodSnapshot();
  const chest = s.containers[2]!;
  eq(chest.total, chest.capacity, '前置:箱子本来就是"恰好装满"');
  eq(resultOf(s, 'CONTAINER_CAPACITY').ok, true, '恰好装满必须通过(判据是 ≤ 不是 <)');
  const over = goodSnapshot();
  over.containers[2]!.total += 1;
  over.containers[2]!.byItem['712'] = 3;
  eq(resultOf(over, 'CONTAINER_CAPACITY').ok, false, '越界 1 件必须报');
});

test('FND128-边界 单帧字节恰好等于上界通过、多 1 字节报违反', () => {
  const at = goodSnapshot();
  at.frame.bytes = at.frame.maxBytes;
  eq(resultOf(at, 'FRAME_BYTES_BOUND').ok, true, '恰好等于上界必须通过(判据是 ≤)');
  const over = goodSnapshot();
  over.frame.bytes = over.frame.maxBytes + 1;
  eq(resultOf(over, 'FRAME_BYTES_BOUND').ok, false, '超出 1 字节必须报');
});

test('FND128-边界 旁表 key 指向容器 id 是合法的(knownIds 不只含刚体)', () => {
  const s = goodSnapshot();
  s.sideTables.push({ name: 'lootBox', keys: ['chest_1'] });
  eq(resultOf(s, 'SIDE_TABLE_KEYS').ok, true, '容器 id 也算"已存在 id"');
  s.sideTables.push({ name: 'lootBox', keys: ['chest_404'] });
  eq(resultOf(s, 'SIDE_TABLE_KEYS').ok, false, '多出一个不存在的 id 必须报');
});

test('FND128-边界 空 knownIds + 有刚体 ⇒ 该条报"无从判定"而不是静默通过', () => {
  const s = goodSnapshot();
  s.knownIds = [];
  const r = resultOf(s, 'SIDE_TABLE_KEYS');
  eq(r.ok, false, '"筛不到东西"必须出声(否则这一条退化成摆设)');
  ok(r.detail.includes('knownIds'), `detail 要点名原因,实测:${r.detail}`);
});

/* ═════════════ 3 汇总与门禁入口 ═════════════ */

test('FND128-汇总 summarize:正例无失败、反例逐个进 failed 清单', () => {
  const good = summarize(checkAll(goodSnapshot()));
  eq(good.ok, true, '正例汇总');
  eq(good.failed, [], '正例不得有失败项');
  eq(good.total, 8, '汇总的条数就是注册表条数');
  const c = caseOf('LEDGER_NON_NEGATIVE');
  const bad = summarize(checkAll(c.make()));
  eq(bad.ok, false, '反例汇总');
  eq(bad.failed, ['LEDGER_NON_NEGATIVE'], 'failed 清单必须指到那一条');
});

test('FND128-门禁入口 runSelfcheck:整套自检全绿(门禁调的就是它)', () => {
  const r = runSelfcheck();
  eq(r.ok, true, `自检必须全绿,实测:${r.summaryLine}`);
  eq(r.invariantCount, 8, '自检覆盖的不变量条数');
  eq(r.cases.length, 8, '自检覆盖的反例条数');
  eq(r.cases.filter((c) => !c.ok).map((c) => c.code), [], '不得有"没牙"的条目');
  eq(r.passed, r.total, 'passed 必须等于 total(没有一个判定被跳过)');
});

test('FND128-门禁入口 runSelfcheck:注入证据非空(每条反例都验过"有牙")', () => {
  const r = runSelfcheck();
  eq(r.cases.filter((c) => c.injectionUsed === 1).length, 8, '每条反例的注入物都必须被调用过一次');
  eq(r.cases.filter((c) => c.onlyExpected).length, 8, '每条反例的归因都必须唯一');
  eq(r.cases.filter((c) => c.injectedCaught).length, 0, '注入恒真后仍被抓到的条数(期望 0)');
});

report('WS-FND-128-invariants');
