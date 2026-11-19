/**
 * WS-FND-139 —— 「文档数字的**两次测量必须一致**」这条链上的三个洞(第十轮实测)。
 *
 * ## 这一套件守的是什么
 *
 * 第十轮实测:同一棵树上 `sync-docs --write` 量到 **145/2641**,而 `--check` 量到 **146/2649**。
 * 差的那一个套件不是"少跑了一次":
 * ```text
 *   某个套件的汇总行被 **stderr 的 SQLite `ExperimentalWarning`** 顶替
 *   ⇒ 它的断言数没进总账 ⇒ 汇总行照样打出一个**看起来正常**的数字
 *   ⇒ --write 把这个"少一个套件"的数写进 README ⇒ 文档被改成**错的**。
 * ```
 * ⇒ 三条判据(与第四轮「0 套件即 fail」同口径):
 * ```text
 *   P1 测量源隔离:逐个套件采集时 stdout / stderr **分开**
 *                 (stderr 只作"剥掉行首警告后"的兜底通道)
 *   P2 计数质量前置:某套件没被解析出汇总行 ⇒ 报错 + **点名**,且这一行**不给数字**
 *   P3 两次测量一致:--check 与 --write 走同一测量路径;复用日志先与树交叉核对套件数
 * ```
 *
 * ## 为什么用合成树 + 伪造日志(而不是真跑 --all)
 * 真跑一次全量门禁约 4 分钟,而本套件要测的是"**测量源本身被污染时会发生什么**" ——
 * 那件事必须在**能注入**的地方测:临时树给锚点形状,伪造日志给测量源。
 * ⇒ 于是同一段比对/写回代码能在 1 秒内被驱动出"污染"与"干净"两种世界。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { suiteEvidenceFiles, suiteSourceReport } from '../scripts/sync-docs.ts';
import { parseAssertionCounts, stripWarningLines, suiteCountingText } from '../scripts/verify.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SYNC = join(ROOT, 'scripts', 'sync-docs.ts');

/** §九 哈希表要求的 7 行目标文件(与 sync-docs.ts 的 HASH_FILES 同集合)。 */
const DOC_FILES = [
  'README.md',
  'docs/HANDOVER.md',
  'docs/PROGRESS.md',
  'docs/LEAD-PLAN.md',
  'docs/ARCH-GAPS.md',
  'docs/CHANGE_REQUESTS.md',
  'docs/COMPLETION-CRITERIA.md',
  'docs/TASK-83-wasd-three-options.md',
];

/** 其它会被"静态量"读到的文档(`--root` 换树时必须一起带,否则那道自检会红在别处)。 */
const EXTRA_FILES = ['docs/WIRING-LEDGER.md'];

/** 三个**合成**套件文件:内容无关 —— 它们只是「树里有几个套件」的**实物证据**。 */
const SUITES = ['tests/WS-01.test.ts', 'tests/WS-FND-01-alpha.test.ts', 'tests/WS-FND-02-beta.test.ts'];

/** 警告行(与第十轮实测同族:SQLite 驱动的 ExperimentalWarning 走在 stderr 上)。 */
const WARNING = '   (node:4321) ExperimentalWarning: SQLite is an experimental feature '
  + 'and might change at any time';

/* ───────────────────────── 合成测量源 ───────────────────────── */

/**
 * 一份「健康」的门禁输出:每个套件一行结果行 + 一行自洽的汇总行。
 * ⚠️ 结果行的形状必须与 `verify.ts::runTests` 真打出来的逐字相同(`✓ <rel> — <末行>`),
 *   否则本套件测的就不是那条真判据(结果行是"这个套件真跑过"的证据)。
 */
function goodLog(): string {
  return [
    '  ✓ tests/WS-01.test.ts — [WS-01] 30/30 通过',
    '  ✓ tests/WS-FND-01-alpha.test.ts — [WS-FND-01-alpha] 12/12 通过',
    '  ✓ tests/WS-FND-02-beta.test.ts — [WS-FND-02-beta] 8/8 通过',
    '  ✓ 用例汇总:50 条通过(3 个套件;WS-01..11 共 30 条 / 1 套件;基座 20 条 / 2 套件)。'
      + '跳过 0 项**未校验**',
  ].join('\n');
}

/**
 * ★ 注入 A:**警告顶替了一个套件的汇总行**(第十轮实测的形态)。
 * 结果行少一条 + 汇总行少一个套件(自称 2 个 / 42 条)—— 而它**看起来完全正常**。
 */
function warningEatsOneSuite(): string {
  return [
    '  ✓ tests/WS-01.test.ts — [WS-01] 30/30 通过',
    WARNING,
    '  ✓ tests/WS-FND-02-beta.test.ts — [WS-FND-02-beta] 8/8 通过',
    '  ✓ 用例汇总:42 条通过(2 个套件;WS-01..11 共 30 条 / 1 套件;基座 12 条 / 1 套件)。'
      + '跳过 0 项**未校验**',
  ].join('\n');
}

/** ★ 注入 B:**汇总行整行被顶替**(套件都在,但没有任何可解析的「用例汇总:…」行)。 */
function warningEatsSummary(): string {
  return [
    '  ✓ tests/WS-01.test.ts — [WS-01] 30/30 通过',
    '  ✓ tests/WS-FND-01-alpha.test.ts — [WS-FND-01-alpha] 12/12 通过',
    '  ✓ tests/WS-FND-02-beta.test.ts — [WS-FND-02-beta] 8/8 通过',
    WARNING,
  ].join('\n');
}

/** ★ 注入 C:日志里出现了**树里不存在**的套件文件(这份日志不是这棵树的测量)。 */
function logFromAnotherTree(): string {
  return [
    '  ✓ tests/WS-01.test.ts — [WS-01] 30/30 通过',
    '  ✓ tests/WS-FND-01-alpha.test.ts — [WS-FND-01-alpha] 12/12 通过',
    '  ✓ tests/WS-FND-02-beta.test.ts — [WS-FND-02-beta] 8/8 通过',
    '  ✓ tests/WS-99.test.ts — [WS-99] 1/1 通过',
    '  ✓ 用例汇总:51 条通过(4 个套件;WS-01..11 共 30 条 / 1 套件;基座 21 条 / 3 套件)。'
      + '跳过 0 项**未校验**',
  ].join('\n');
}

/* ───────────────────────── 临时树 ───────────────────────── */

interface Tree { dir: string; log: string; put: (text: string) => void; drop: () => void }

function mkTree(logText: string): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'wsfnd139-'));
  for (const rel of [...DOC_FILES, ...EXTRA_FILES]) {
    if (!existsSync(join(ROOT, rel))) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  for (const rel of SUITES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), 'export {};\n', 'utf8');
  }
  const log = join(dir, 'gate.log');
  const put = (text: string): void => writeFileSync(log, text, 'utf8');
  put(logText);
  return { dir, log, put, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Run { status: number | null; out: string }

function run(t: Tree, ...args: string[]): Run {
  const r = spawnSync(
    process.execPath,
    [SYNC, ...args, `--root=${t.dir}`, `--gate-log=${t.log}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const readmeOf = (t: Tree): string => readFileSync(join(t.dir, 'README.md'), 'utf8');

/* ═════════════════════════ P1 测量源隔离(纯函数面)═════════════════════════ */

test('FND139-1 逐套件的证据只认**结果行**:警告行不算证据,也不许被数成套件', () => {
  const ev = suiteEvidenceFiles(goodLog());
  eq(ev, SUITES, '三个合成套件的结果行必须逐个被认出来');
  /* ★ 警告行不是证据:它没有 `tests/….test.ts` 的路径形态。 */
  const withWarn = suiteEvidenceFiles(`${WARNING}\n${goodLog()}`);
  eq(withWarn, SUITES, '多一条 stderr 警告不得改变证据集合');
  eq(suiteEvidenceFiles('  用例汇总:50 条通过(3 个套件)').length, 0,
    '汇总行自己不是证据(它是**自称**,不是"跑过")');
});

test('FND139-2 健康日志 ⇒ 三条核对全过(负对照:这一条不是恒红)', () => {
  const r = suiteSourceReport(goodLog(), SUITES);
  eq(r.problems, [], `健康日志必须零问题(实际:${r.problems.join(' / ')})`);
  eq(r.claimed, 3, '自称套件数必须解析出来');
  eq(r.checked, true, '有结果行 ⇒ 必须真的做了核对(checked=false 就等于没查)');
});

/* ═════════════════════ P2 计数质量前置(注入面)═════════════════════════ */

test('FND139-3 警告顶替一个套件的汇总行 ⇒ 报错并**点名**,绝不给出"少一个套件的数字"', () => {
  const r = suiteSourceReport(warningEatsOneSuite(), SUITES);
  ok(r.problems.length > 0, '少一个套件的日志必须报问题(第十轮那个数字就是这么来的)');
  const all = r.problems.join(' / ');
  ok(all.includes('tests/WS-FND-01-alpha.test.ts'),
    `必须点名缺的套件(实际:${all})`);
  ok(all.includes('2 个套件') || all.includes('差 1'),
    `必须报出"自称的套件数与树里不符"(实际:${all})`);
  /* 没被顶替的那两个套件仍然认得出 —— 证明"报错"不是"全都认不出"(那样就分不清故障面) */
  eq(r.evidence, [SUITES[0]!, SUITES[2]!], '仍应认出没被顶替的两个套件');
});

test('FND139-4 汇总行整行被顶替 ⇒ 同样报错(不许退化成"这一栏没测过")', () => {
  const r = suiteSourceReport(warningEatsSummary(), SUITES);
  eq(r.claimed, null, '没有可解析的汇总行 ⇒ claimed 必须是 null(不是 0)');
  ok(r.problems.join(' / ').includes('没有可解析'),
    `必须报"没有可解析的用例汇总行"(实际:${r.problems.join(' / ')})`);
  ok(r.evidence.length === 3, '三个套件的结果行都在 ⇒ 这是故障,不是"没跑测试"');
});

test('FND139-5 日志来自另一棵树(多出一个套件文件)⇒ 报错', () => {
  const r = suiteSourceReport(logFromAnotherTree(), SUITES);
  ok(r.problems.join(' / ').includes('tests/WS-99.test.ts'),
    `必须点名树上不存在的套件(实际:${r.problems.join(' / ')})`);
});

/* ═════════ P3 端到端:--check 必须报错(而不是给个数字);--write 幂等 ═════════ */

test('FND139-6 端到端:污染的日志 ⇒ `--check` 退出 1 且报"测量源不可信",不给任何数字', () => {
  const t = mkTree(warningEatsOneSuite());
  try {
    const before = readFileSync(join(t.dir, 'README.md'));
    const c = run(t, '--check');
    eq(c.status, 1, `污染的测量源必须非零退出(实际 ${c.status})\n${c.out}`);
    ok(c.out.includes('测量源不可信'), `必须报"测量源不可信"(实际:${c.out.slice(0, 400)})`);
    ok(c.out.includes('tests/WS-FND-01-alpha.test.ts'), '必须点名缺结果行的套件');
    ok(c.out.includes('42 条通过') === false, '不得把被顶替后的数字当成可用测量');
    ok(c.out.includes('未变化') === false, '这种情况不许打印"无变化"那种良性结论');
    /* ★ `--check` 不写盘(结构错误 / 测量源故障时都不写)。 */
    eq(readFileSync(join(t.dir, 'README.md')).toString('utf8'), before.toString('utf8'),
      '--check 在任何情况下都不得写盘');
  } finally { t.drop(); }
});

test('FND139-7 端到端:健康日志 ⇒ 交叉核对被**打印出来**(不是默认跳过)', () => {
  const t = mkTree(goodLog());
  try {
    const c = run(t, '--check');
    ok(c.out.includes('套件数已交叉核对'),
      `必须打印交叉核对的结果(实际:${c.out.slice(0, 400)})`);
    ok(c.out.includes('3 个'), '打印里必须带上核对到的套件数');
    ok(c.out.includes('测量源不可信') === false, '健康日志不该报"测量源不可信"');
  } finally { t.drop(); }
});

test('FND139-8 端到端:同一份日志下 `--write` 幂等(连跑两次第二次零变化)', () => {
  const t = mkTree(goodLog());
  try {
    const w1 = run(t, '--write');
    eq(w1.status, 0, `--write 必须成功(实际 ${w1.status})\n${w1.out}`);
    const after1 = readmeOf(t);
    /* 写回的值必须**来自日志的测量**(不是照抄文档里的旧值) —— 这条同时证明
       `--write` 与 `--check` 走的是**同一条测量路径**(同一个 `--gate-log`)。 */
    ok(after1.includes('共 50 个用例'), `README 必须写成测量值 50(实际:${after1.split('\n').filter((l) => l.includes('个用例')).join(' | ')})`);
    ok(after1.includes('3/3 ✅'), '套件数必须写成测量出来的 3');
    const w2 = run(t, '--write');
    eq(w2.status, 0, w2.out);
    ok(w2.out.includes('已写回 0 处'), `第二次 --write 必须零变化(实际:${w2.out.trim().split('\n').pop()})`);
    eq(readmeOf(t), after1, '第二次 --write 不得改动 README 字节(幂等)');
    /* 写回后 --check 干净:两处测量(写与查)对同一份测量源结论一致。 */
    const c = run(t, '--check');
    eq(c.status, 0, `写回后 --check 必须干净\n${c.out}`);
    ok(c.out.includes('无变化'), '写回后必须是"无变化"');
  } finally { t.drop(); }
});

test('FND139-9 端到端:测量源被换掉(另一棵树的日志)⇒ `--write` 拒绝写盘', () => {
  const t = mkTree(goodLog());
  try {
    const c1 = run(t, '--check');
    ok(c1.out.includes('套件数已交叉核对'), '前置条件:健康日志先过核对');
    t.put(logFromAnotherTree());
    const before = readFileSync(join(t.dir, 'README.md'));
    const w = run(t, '--write');
    eq(w.status, 1, `伪造日志下 --write 必须拒绝(实际 ${w.status})\n${w.out}`);
    eq(readFileSync(join(t.dir, 'README.md')).toString('utf8'), before.toString('utf8'),
      '测量源不可信时 --write 不得写盘');
    ok(w.out.includes('tests/WS-99.test.ts'), '必须点名那个不存在的套件');
  } finally { t.drop(); }
});


/* ═════════ P4 verify 侧:套件输出的「可计数文本」只认 stdout(警告不得影响计数)═════════ */

const VERIFY_SRC = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8').replace(/\r\n/g, '\n');

/** 抽顶层函数体(以行首 `}` 结束;与 `tests/WS-FND-103` 同一口径)。 */
function funcBody(src: string, signature: string): string {
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`verify.ts 里找不到 ${signature} ⇒ 锚点漂移,本判据必须因此变红`);
  const end = src.indexOf('\n}\n', i);
  if (end < 0) throw new Error(`${signature} 之后找不到行首的右花括号(函数体不完整?)`);
  return src.slice(i, end);
}

test('FND139-10 verify 侧:计数只读 stdout;警告最多只能进"剥警告后的 stderr"兜底通道', () => {
  /* 主路径:计数在 stdout ⇒ stderr 的警告**一个字符都进不来** */
  const iso = suiteCountingText('[WS-01] 30/30 通过\n', `${WARNING}\n`);
  eq(iso.source, 'stdout', 'stdout 有计数时必须走主路径');
  eq(iso.text.includes('Warning'), false, '警告不得混进可计数文本');
  eq(parseAssertionCounts(iso.text)?.total, 30, '主路径必须量到 stdout 的那个数');
  /* 兜底路径:stdout 没有 ⇒ 剥掉警告后的 stderr 仍然量得到(而不是"没打印") */
  const fb = suiteCountingText('', `${WARNING}\n[WS-01] 12/12 通过\n`);
  eq(fb.source, 'stderr-去警告', 'stdout 没有计数才允许走兜底通道');
  eq(fb.removedWarnings, 1, '必须报出剥掉了几行警告(静默剥掉 = 看不见"污染"这件事)');
  eq(parseAssertionCounts(fb.text)?.total, 12, '兜底路径也必须量到那个数');
  eq(stripWarningLines(`${WARNING}\n正常一行\n`).removed, 1, '只剥行首的警告行,不碰别的行');
  /* 污染:两个流各一处 ⇒ 仍按旧的"恰好一处"严判处理(不许挑一个信) */
  eq(suiteCountingText('[X] 1/1 通过\n', '[X] 1/1 通过\n').bothStreamsHaveCount, true,
    '两个流各打一处必须被标成污染');
  /* ★ 接线锁:`runTests` 里**不得**再把两个流拼起来数(那就是第十轮那个缺陷的形态) */
  const body = funcBody(VERIFY_SRC, 'function runTests(');
  ok(body.includes('suiteCountingText('), 'runTests 必须走 suiteCountingText(单一实现)');
  ok(body.includes('parseAssertionCounts(iso.text)'), '计数必须对着隔离后的文本做');
  eq(body.includes("${r.stdout ?? ''}${r.stderr ?? ''}"), false,
    'runTests 不得再把两个流拼成一个字符串再数');
  /* ★ 计数质量前置:缺汇总行时那一行**不给数字**,并收集缺的套件 */
  ok(body.includes('用例汇总**不完整**'), '缺套件时不许打可解析的汇总行(必须打"不完整")');
  ok(body.includes('unmeasured'), '必须把"没解析出汇总行的套件"收集起来并点名');
});
report('WS-FND-139');
