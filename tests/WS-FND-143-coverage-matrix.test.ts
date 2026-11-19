/**
 * WS-FND-143 —— **导出覆盖矩阵工具**:三档判据、台账比对、`--json` 结构。
 *
 * ## 这套件钉的四件事
 *
 * ```text
 * 1 三档判据**各自一正一反**:behavior 的正例(同行断言 / 同用例体后续断言)、
 *   behavior 的反例(只在字符串里)、symbol-only 的正例(字面量 + 取文本实参)、
 *   symbol-only 的反例(只在注释里、只在非探针字符串里)、none 的正例与反例。
 *   ⚠️ 反例比正例重要:三档判据最容易的失效形态是「什么都被判成 behavior」,
 *      那样报告永远好看,而"覆盖"这个词就没有含义了。
 * 2 `--check` 在三种漂移上**必须红**:台账漏一条导出(普查块)、状态列写错、
 *   待处置清单漏登记 —— 并且**报出来的消息要指名是哪一条**,不是只说"数量不对"。
 * 3 `--json` 结构稳定(键集合 + 排序 + 三档之和 == total),因为它是**机读**面:
 *   下一个人接门禁时读的是它,键名漂了就是一次静默的口径变更。
 * 4 真仓的台账与实测**一致**(FND143-12)。这条是本套件唯一对全仓生效的断言 ——
 *   它让 "台账过期" 变成一次**红色的测试**,而不是一次谁都没发现的文档腐烂。
 *   ⚠️ 新增/删除 `server/src` 的导出后,修法是 `node scripts/coverage-matrix.ts --write`,
 *      不是改断言。
 * ```
 *
 * ## 为什么用**假的 root**
 *
 * 三档判据的每条规则都要有"恰好踩这条"的样本;在真仓里造这些样本等于往生产代码里
 * 塞垃圾。故 `buildMatrix({ root })` 接受任意根目录 —— 每个用例写一棵**只含必需文件**
 * 的临时树(1~2 个 `server/src/*.ts` + 1 个 `tests/*.test.ts`),
 * 于是"这个符号为什么被判成这一档"可以**逐条归因**,而不是"全仓里大概是"。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import {
  BLOCKS,
  LEDGER_REL,
  blockOf,
  buildMatrix,
  checkLedger,
  defaultRoot,
  parseRows,
  runCheck,
  spliceLedger,
  statusOk,
} from '../scripts/coverage-matrix.ts';
import type { MatrixReport } from '../scripts/coverage-matrix.ts';

/* ═══════════════ 0 夹具:一棵"只含必需文件"的临时树 ═══════════════ */

interface FakeSpec {
  /** 键 = 仓库相对路径,值 = 文件内容 */
  files: Record<string, string>;
}

/** 建临时树;返回 root。调用方负责 `rmTree(root)`。 */
function makeRoot(spec: FakeSpec): string {
  const root = mkdtempSync(join(tmpdir(), 'cov-matrix-'));
  for (const [rel, text] of Object.entries(spec.files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}

function rmTree(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** 在某棵临时树上**只取一个符号**的档位(缺了直接失败,不静默)。 */
function tierOf(r: MatrixReport, file: string, name: string): { tier: string; evidence: string[] } {
  const e = r.exports.find((x) => x.file === file && x.name === name);
  ok(e !== undefined, `矩阵里没有 ${file}:${name} —— 枚举口径漏了这个导出`);
  /* ⚠️ `!` 是必要的:`ok()` 不是类型守卫(harness 的签名是 `(cond: unknown)`)⇒ 不加就是 4 条 TS18048。
     本仓既有做法一致:见 `tests/WS-FND-128-invariants.test.ts` 的 `return r!;`。 */
  return { tier: e!.tier, evidence: e!.evidence };
}

/** 台账骨架(三块生成段的空壳);`spliceLedger` 负责填。 */
const SKELETON = [
  '# 覆盖矩阵(测试夹具)',
  '',
  '<!-- GEN:STATS:BEGIN -->',
  '<!-- GEN:STATS:END -->',
  '',
  '<!-- GEN:ROWS:BEGIN -->',
  '<!-- GEN:ROWS:END -->',
  '',
  '<!-- GEN:CENSUS:BEGIN -->',
  '<!-- GEN:CENSUS:END -->',
  '',
].join('\n');

/** 一棵最小树:2 个导出 + 1 条用例(供 `--check` 的三条用例复用)。 */
const MINI: FakeSpec = {
  files: {
    'server/src/alpha.ts': [
      'export function foo(n: number): number { return n + 1; }',
      'export function bar(n: number): number { return n - 1; }',
      '',
    ].join('\n'),
    'tests/A.test.ts': [
      "import { eq } from '../../shared/testing/harness.ts';",
      'test(\'a\', () => {',
      '  eq(foo(1), 2);',
      '});',
      '',
    ].join('\n'),
  },
};

/** 把 ledger 文本落盘并返回路径(写进临时树的 docs/ 下)。 */
function writeLedger(root: string, text: string): string {
  const p = join(root, LEDGER_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  return p;
}

/* ═══════════════ 1 三档判据:各自一正一反 ═══════════════ */

test('FND143-1 behavior 正例(同行断言):真调 + 同一行断言 ⇒ behavior', () => {
  const root = makeRoot({
    files: {
      'server/src/a.ts': 'export function foo(n: number): number { return n + 1; }\n',
      'tests/T.test.ts': [
        'test(\'t\', () => {',
        '  eq(foo(1), 2);',
        '});',
        '',
      ].join('\n'),
    },
  });
  try {
    const r = buildMatrix({ root });
    const got = tierOf(r, 'server/src/a.ts', 'foo');
    eq(got.tier, 'behavior', '同行有 eq( ⇒ 必须是 behavior');
    ok(got.evidence[0] !== undefined && got.evidence[0].includes('同行断言'),
      `证据必须写明判据形态(实测:${JSON.stringify(got.evidence)})`);
    eq(r.totals.behavior, 1, '三个计数之和必须是 1');
    eq(r.totals.exports, 1, '导出必须只有 1 个(夹具自证)');
  } finally {
    rmTree(root);
  }
});

test('FND143-2 behavior 正例(同用例体后续断言):换行写法也必须算 —— 只看同行会漏最普通的形态', () => {
  const root = makeRoot({
    files: {
      'server/src/a.ts': 'export function qux(n: number): number { return n * 2; }\n',
      'tests/T.test.ts': [
        'test(\'t\', () => {',
        '  const r = qux(2);',
        '  eq(r, 4);',
        '});',
        '',
      ].join('\n'),
    },
  });
  try {
    const r = buildMatrix({ root });
    const got = tierOf(r, 'server/src/a.ts', 'qux');
    eq(got.tier, 'behavior', '同一用例体内后续有断言 ⇒ 必须算 behavior');
    ok((got.evidence[0] ?? '').includes('同用例体内后续断言'),
      `证据必须指明是 B2 而非 B1(实测:${JSON.stringify(got.evidence)})`);
  } finally {
    rmTree(root);
  }
});

test('FND143-3 behavior 反例:名字只出现在字符串里 + 同一行有 ok( ⇒ **不是** behavior', () => {
  const root = makeRoot({
    files: {
      'server/src/a.ts': 'export const onlyInString = 1;\n',
      'tests/T.test.ts': [
        'test(\'t\', () => {',
        '  const src = readCode(\'server/src/a.ts\');',
        '  ok(src.includes(\'onlyInString\'), \'源码里该有它\');',
        '});',
        '',
      ].join('\n'),
    },
  });
  try {
    const r = buildMatrix({ root });
    const got = tierOf(r, 'server/src/a.ts', 'onlyInString');
    ok(got.tier !== 'behavior', `同一行有 ok( 但符号在字符串里 ⇒ 不许记 behavior(实测 ${got.tier})`);
    eq(got.tier, 'symbol-only', '它只被当文本比对 ⇒ symbol-only');
  } finally {
    rmTree(root);
  }
});

test('FND143-4 symbol-only 正例(正则字面量 + .test( 实参)', () => {
  const root = makeRoot({
    files: {
      'server/src/a.ts': 'export function bar(): number { return 1; }\n',
      'tests/T.test.ts': [
        'test(\'t\', () => {',
        '  const src = readText(\'server/src/a.ts\');',
        '  ok(/function\\s+bar\\s*\\(/.test(src), \'源码里该有 bar\');',
        '});',
        '',
      ].join('\n'),
    },
  });
  try {
    const r = buildMatrix({ root });
    const got = tierOf(r, 'server/src/a.ts', 'bar');
    eq(got.tier, 'symbol-only', '正则字面量 + .test( ⇒ symbol-only');
    ok((got.evidence[0] ?? '').includes('字面量 + 取文本实参'),
      `证据必须写明是"取文本实参"(实测:${JSON.stringify(got.evidence)})`);
  } finally {
    rmTree(root);
  }
});

test('FND143-5 symbol-only 反例:只在注释里、或只在**非探针**字符串里 ⇒ 都是 none', () => {
  const root = makeRoot({
    files: {
      'server/src/a.ts': [
        'export const onlyInComment = 1;',
        'export const onlyInPlainString = 2;',
        '',
      ].join('\n'),
      'tests/T.test.ts': [
        '/* 这一段注释里提到 onlyInComment,但注释不是判据源 */',
        'test(\'t\', () => {',
        '  eq(\'onlyInPlainString\', \'onlyInPlainString\', \'字符串里出现但那一行不是取文本实参\');',
        '});',
        '',
      ].join('\n'),
    },
  });
  try {
    const r = buildMatrix({ root });
    eq(tierOf(r, 'server/src/a.ts', 'onlyInComment').tier, 'none', '只在注释里 ⇒ none');
    eq(tierOf(r, 'server/src/a.ts', 'onlyInPlainString').tier, 'none',
      '只在非探针字符串里 ⇒ none(它不构成"用文本核对该符号"的证据)');
    eq(r.totals.symbolOnly, 0, '这两条都不许进 symbol-only');
  } finally {
    rmTree(root);
  }
});

test('FND143-6 none 正例与反例:没人提过 ⇒ none;被生产引用 ⇒ 进待处置清单', () => {
  const root = makeRoot({
    files: {
      'server/src/a.ts': [
        'export function lonely(): number { return 1; }',
        'export function calledInProd(): number { return 2; }',
        'export function asserted(): number { return 3; }',
        '',
      ].join('\n'),
      'server/src/b.ts': 'import { calledInProd } from \'./a.ts\';\nexport const x = calledInProd();\n',
      'tests/T.test.ts': [
        'test(\'t\', () => {',
        '  eq(asserted(), 3);',
        '});',
        '',
      ].join('\n'),
    },
  });
  try {
    const r = buildMatrix({ root });
    eq(tierOf(r, 'server/src/a.ts', 'asserted').tier, 'behavior', '被断言 ⇒ behavior(即非 none)');
    eq(tierOf(r, 'server/src/a.ts', 'lonely').tier, 'none', '没人提过 ⇒ none');
    eq(tierOf(r, 'server/src/a.ts', 'calledInProd').tier, 'none', '只在生产里被调用、测试没提 ⇒ none');
    const lonely = r.exports.find((e) => e.name === 'lonely');
    const called = r.exports.find((e) => e.name === 'calledInProd');
    ok(lonely !== undefined && called !== undefined, '两条都该在枚举里');
    eq(lonely!.prodRefs, 0, 'lonely 的生产引用应是 0');
    ok(called!.prodRefs > 0, `calledInProd 的生产引用应 > 0(实测 ${called!.prodRefs})`);
    const keys = r.actionable.map((a) => `${a.file}:${a.name}`);
    ok(keys.includes('server/src/a.ts:calledInProd'), 'none ∧ 生产引用 > 0 ⇒ 必须进待处置清单');
    ok(!keys.includes('server/src/a.ts:lonely'), 'none ∧ 生产引用 = 0 ⇒ 不进待处置清单');
    ok(!keys.includes('server/src/a.ts:asserted'), 'behavior ⇒ 不进待处置清单');
  } finally {
    rmTree(root);
  }
});

/* ═══════════════ 2 台账:一致必须绿,三种漂移必须红 ═══════════════ */

test('FND143-7 --check 正例:刚写完的台账与实测一致(round-trip 幂等)', () => {
  const root = makeRoot(MINI);
  try {
    const r = buildMatrix({ root });
    const filled = spliceLedger(SKELETON, r, new Map());
    const p = writeLedger(root, filled);
    const chk = runCheck({ root, ledgerPath: p });
    eq(chk.problems, [], `刚生成的台账必须一致(实测问题:${chk.problems.join(' / ')})`);
    eq(chk.ok, true, 'ok 必须为 true');
    /* 幂等:再写一次,文本不变 */
    eq(spliceLedger(filled, r, new Map()), filled, '--write 必须幂等(同一实测 ⇒ 同一文本)');
    /* 三块都在 */
    for (const b of [BLOCKS.stats, BLOCKS.census, BLOCKS.rows]) {
      ok(blockOf(filled, b) !== null, `台账缺 ${b} 块`);
    }
  } finally {
    rmTree(root);
  }
});

test('FND143-8 --check 红:普查块漏了一条导出(新增/消失的导出必须让门禁红)', () => {
  const root = makeRoot(MINI);
  try {
    const r = buildMatrix({ root });
    const filled = spliceLedger(SKELETON, r, new Map());
    const census = blockOf(filled, BLOCKS.census) ?? '';
    const lines = census.split('\n').filter((l) => l.trim() !== '');
    ok(lines.length > 0, '普查块必须非空(否则本条断言无意义)');
    /* 造"漏一条":把普查块整块清空 —— 等价于台账里一个导出都没登记 */
    const broken = filled.replace(census, '\n');
    const chk = checkLedger(r, broken);
    eq(chk.ok, false, '普查块与实测不符必须红');
    ok(chk.problems.some((p) => p.includes('普查块比实测少')),
      `必须报"普查块比实测少"(实测消息:${chk.problems.join(' / ')})`);
    ok(chk.problems.some((p) => p.includes('server/src/alpha.ts:foo')),
      `必须**指名**漏掉的是哪个符号(实测消息:${chk.problems.join(' / ')})`);
  } finally {
    rmTree(root);
  }
});

test('FND143-9 --check 红:状态列写错(只允许 待补 / 已补(判据名) / 无需(理由))', () => {
  ok(statusOk('待补'), '待补 合法');
  ok(statusOk('已补(WS-07 H11)'), '已补(判据名) 合法');
  ok(statusOk('无需(类型导出,运行时不可断言)'), '无需(理由) 合法');
  ok(!statusOk('已补'), '已补 缺括号 ⇒ 非法');
  ok(!statusOk('无需()'), '无需() 空理由 ⇒ 非法');
  ok(!statusOk('搞定了'), '自造词 ⇒ 非法');
  ok(!statusOk('待补 '), '尾随空格 ⇒ 非法(格式要能被解析,不是"看起来差不多")');

  /* 在**真的台账文本**上改一处状态,确认 checkLedger 会指名它 */
  const root = makeRoot({
    files: {
      ...MINI.files,
      'server/src/c.ts': [
        'export function usedInProd(): number { return 7; }',
        '',
      ].join('\n'),
      'server/src/d.ts': 'import { usedInProd } from \'./c.ts\';\nexport const y = usedInProd();\n',
    },
  });
  try {
    const r = buildMatrix({ root });
    const filled = spliceLedger(SKELETON, r, new Map());
    ok(filled.includes('| 待补 |'), '待处置清单里必须有一条 待补(否则本条无意义)');
    const broken = filled.replace('| 待补 |', '| 搞定了 |');
    const chk = checkLedger(r, broken);
    eq(chk.ok, false, '状态列写法非法必须红');
    ok(chk.problems.some((p) => p.includes('状态列写法非法')),
      `必须报状态列问题(实测消息:${chk.problems.join(' / ')})`);
    ok(chk.problems.some((p) => p.includes('搞定了')), '必须回显写错的那一格');
  } finally {
    rmTree(root);
  }
});

test('FND143-10 --check 红:待处置清单漏登记一条(实测有、台账无)', () => {
  const root = makeRoot({
    files: {
      ...MINI.files,
      'server/src/c.ts': 'export function usedInProd(): number { return 7; }\n',
      'server/src/d.ts': 'import { usedInProd } from \'./c.ts\';\nexport const y = usedInProd();\n',
    },
  });
  try {
    const r = buildMatrix({ root });
    const filled = spliceLedger(SKELETON, r, new Map());
    const rowsBlock = blockOf(filled, BLOCKS.rows) ?? '';
    const rows = parseRows(rowsBlock);
    eq(rows.length, 1, `夹具应恰好 1 条待处置(实测 ${rows.length})`);
    const kept = rowsBlock.split('\n').filter((l) => !l.includes('usedInProd')).join('\n');
    const broken = filled.replace(rowsBlock, kept);
    const chk = checkLedger(r, broken);
    eq(chk.ok, false, '漏登记必须红');
    ok(chk.problems.some((p) => p.includes('漏登记')), `必须报漏登记(实测:${chk.problems.join(' / ')})`);
    ok(chk.problems.some((p) => p.includes('server/src/c.ts:usedInProd')), '必须指名漏的是哪一条');
  } finally {
    rmTree(root);
  }
});

/* ═══════════════ 3 --json 结构稳定 + 真仓一致性 ═══════════════ */

test('FND143-11 --json 结构稳定:键集合/排序/档位之和 都不许漂', () => {
  const root = makeRoot(MINI);
  try {
    const r = buildMatrix({ root });
    const expectedTop = [
      'actionable', 'byKind', 'census', 'exports', 'root', 'srcFiles', 'testFiles', 'totals',
    ];
    eq(Object.keys(r).sort(), expectedTop, 'MatrixReport 顶层键集合(机读面:漂了就是口径变更)');
    eq(Object.keys(r.totals).sort(), [
      'behavior', 'exports', 'none', 'noneWithProdRef', 'noneWithoutProdRef', 'symbolOnly',
    ], 'totals 键集合');
    eq(Object.keys(r.byKind).sort(), ['type', 'value'], 'byKind 键集合');
    eq(Object.keys(r.exports[0]).sort(), [
      'evidence', 'file', 'kind', 'name', 'prodRefs', 'tier',
    ], 'ExportEntry 键集合(排序后)');
    eq(r.totals.behavior + r.totals.symbolOnly + r.totals.none, r.totals.exports,
      '三档之和必须等于 total');
    eq(r.totals.noneWithProdRef + r.totals.noneWithoutProdRef, r.totals.none,
      'none 的两个子计数之和必须等于 none');
    eq(r.byKind.value.behavior + r.byKind.type.behavior, r.totals.behavior, 'byKind.behavior 求和');
    eq(r.byKind.value.none + r.byKind.type.none, r.totals.none, 'byKind.none 求和');
    /* 排序:exports 按 (file, name);census 行按 file */
    const files = r.exports.map((e) => `${e.file}\u0000${e.name}`);
    eq(files.slice().sort(), files, 'exports 必须按 (file, name) 排序');
    const censFiles = r.census.map((l) => l.split(' | ')[0] ?? '');
    eq(censFiles.slice().sort(), censFiles, 'census 必须按文件排序');
    /* JSON 往返不丢信息(字段都是可序列化的原始值) */
    eq(JSON.parse(JSON.stringify(r)), r, 'JSON 往返必须等价');
  } finally {
    rmTree(root);
  }
});

test('FND143-12 真仓:docs/COVERAGE-MATRIX.md 与实测一致(台账过期 = 一次红)', () => {
  const root = defaultRoot();
  ok(readFileSync(join(root, LEDGER_REL), 'utf8').length > 0, '台账必须存在且非空');
  const chk = runCheck({ root, ledgerPath: join(root, LEDGER_REL) });
  eq(chk.problems, [],
    `台账与实测不一致 ⇒ 跑 node scripts/coverage-matrix.ts --write(实测问题:${chk.problems.join(' / ')})`);
  ok(chk.report.totals.exports > 1000,
    `真仓导出数应上千(实测 ${chk.report.totals.exports})—— 太小说明枚举口径坏了`);
  ok(chk.report.testFiles > 100, `判据源应上百(实测 ${chk.report.testFiles})`);
  const statuses = parseRows(blockOf(readFileSync(join(root, LEDGER_REL), 'utf8'), BLOCKS.rows) ?? '')
    .map((x) => x.status);
  ok(statuses.length > 0, '待处置清单必须有行');
  eq(statuses.filter((s) => !statusOk(s)), [], '台账里的状态列必须全部合法');
});

report('WS-FND-143-coverage-matrix');