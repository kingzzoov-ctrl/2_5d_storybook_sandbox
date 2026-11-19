/**
 * WS-FND-133 —— 文档数字的**单一来源**(`scripts/sync-docs.ts`)。
 *
 * ## 这一套件守的是什么
 *
 * `README.md` / `docs/HANDOVER.md` 里的那些数字,八轮里被重钉过 **5 次**,
 * 每一次都是**人抄**。`sync-docs.ts` 的定位是:数字**不许人抄** ——
 * `--write` 现算现写、`--check` 只回答「会不会变」、`verify.ts` 只调用它。
 *
 * ⇒ 于是本套件要钉住的不是"某个数字现在是多少"(那本来就会变),
 *   而是**这台机器的性质**:
 * ```text
 * P1 `--check` / `--write` 是**幂等**的(第二次不再变盘)
 * P2 数字写错**位置**也会红(WS 小计 ↔ 基座小计 互换)
 * P3 报错里给的是**实测值**(不是文档里那个值,也不是「不一致」四个字)
 * P4 §九 的 sha256 **随内容变化而变**,且与 LF 归一口径逐位相同
 * P5 `--check` **绝不写盘**
 * P6 未测量 ⇒ 打印「未校验」,**不是**通过
 * P7 锚点被删 / 表里混进 HANDOVER 自己 ⇒ 结构错误,且**不写盘**
 * P8 台账**表体 ↔ §2.10 汇总表**不符 ⇒ 红(自检不许被"补齐汇总"糊过去)
 * P9 `--gate-log` 复用路径活着:UTF-16LE(BOM)日志能解码 + 9 条正则都能取到数
 * ```
 *
 * ## 为什么能在 1 秒内跑完(而不是 4 分钟)
 *
 * 默认测量源是 `verify --all`(全量口径,实测约 4 分钟)。
 * 本套件给的是 `--measure=<json>` 快照 + `--root=<临时树>`:
 *   · 快照 = 一份**合成**测量值(数字全部是套件里定义的,不是抄来的);
 *   · 临时树 = 真 README / HANDOVER 的副本 —— 锚点形状是真的,
 *     因此本套件同时验证「锚点还找得到」。
 * ⇒ 测的是**同一段比对/写回代码**,只换掉测量源。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, report, test } from '../shared/testing/harness.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SYNC = join(ROOT, 'scripts', 'sync-docs.ts');

/* 副本里必须具备 §九 哈希表的**全部 7 行**目标文件(与 sync-docs.ts 的 HASH_FILES 同集合)。 */
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

/**
 * 临时树里的**合成** `docs/WIRING-LEDGER.md`(表体 3 行 ⇒ 1 未接 / 1 部分接 / 1 已接 / 0 已登记)。
 *
 * 为什么必须有它:`measureWiring()` 把台账当**静态测量源**读(两条测量路径都要),
 * 树里缺这份文件时它报的是 error(缺件不许静默跳过)⇒ `--write` 会被拦住。
 * 这里给的形状与真台账同构(表体 `| R6-... |` + §2.10 汇总表),因此
 * 「README 那一行取自**表体实算**」这条判据在临时树里同样成立;
 * 数字由本文件自己定 ⇒ 若 `sync-docs` 改成从别处取数,断言立刻红。
 */
const SYNTH_LEDGER = [
  '# 合成逐符号台账(WS-FND-133 临时树专用)',
  '',
  '> 形状与 `docs/WIRING-LEDGER.md` 同构:表体 `| R6-... |` + §2.10 汇总表。',
  '',
  '## §2.1 客户端',
  '',
  '| ID | 符号 | 位置 | 现状 | 理由(调用点) | 判据 |',
  '|---|---|---|---|---|---|',
  '| R6-T-1 | `a` | `x.ts` | **已接** | 合成 | — |',
  '| R6-T-2 | `b` | `x.ts` | **部分接** | 合成 | — |',
  '| R6-T-3 | `c` | `y.ts` | **未接** | 合成 | — |',
  '',
  '## §2.10 汇总',
  '',
  '| 桶 | 条数 |',
  '|---|---|',
  '| 已接 | 1 |',
  '| 已登记 | 0 |',
  '| 部分接 | 1 |',
  '| 未接 | 1 |',
  '| 合计 | 3 |',
  '',
].join('\n');

/**
 * 合成测量值。**每个数都是本文件自己定的**(故意与真仓的当前值不同):
 * 若 `sync-docs` 哪天改成「从文档里读」或「照抄某个常量」,这些断言会立刻红。
 */
const M = {
  docStruct: 3,
  fingerprint: 'v9-0123abcd',
  freeIds: 77,
  strippableDirs: 2,
  decoratorExempt: 0,
  inert: { registered: 1, emptySuccess: 0 },
  trustFromClient: 0,
  suites: { total: 1234, suites: 7, wsTotal: 100, wsSuites: 3, fndTotal: 1134, fndSuites: 4 },
  selfcheck: { passed: 5, total: 5 },
  crossWs: 9,
  frozen: 3,
  reach: { reachable: 12, total: 20, unreachable: 8, whitelist: 8 },
  debt: { clientShell: 0, wiring: 2, mechanism: 1, clientMech: 3, decision: 0, dependency: 0, other: 0 },
  nonDebt: 2,
  diffSet: 1,
  ledger: { total: 133, open: 0, blocking: 0, closed: 133 },
  taut: { hit: 0, whitelist: 0 },
  typecheck: { errors: 42, fingerprints: 7 },
  progress: {
    sections: 7, first: 1, last: 7, increasing: true, noGap: true, hasBom: false, bytes: 12345,
  },
  src: {
    tests: 7, server: 5, client: 3, scripts: 2, shared: 1, total: 18, lines: 123456,
    prodServer: 5, prodClient: 3, prodShared: 1, prodTotal: 9,
  },
};

interface Tree { dir: string; measure: string; drop: () => void }

/** 造一棵副本树 + 一份测量快照。`patch` 用来做「文档被改坏」的各种注入。 */
function mkTree(patch?: (m: Record<string, unknown>) => void): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'wsfnd133-'));
  for (const rel of DOC_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  /* 静态测量源里唯一不来自快照的一份:台账(缺件即 error ⇒ 必须补) */
  writeFileSync(join(dir, 'docs', 'WIRING-LEDGER.md'), SYNTH_LEDGER, 'utf8');
  const snapshot: Record<string, unknown> = JSON.parse(JSON.stringify(M)) as Record<string, unknown>;
  if (patch !== undefined) patch(snapshot);
  const measure = join(dir, 'measure.json');
  writeFileSync(measure, JSON.stringify(snapshot), 'utf8');
  return { dir, measure, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Run { status: number | null; out: string }

function run(t: Tree, ...args: string[]): Run {
  const r = spawnSync(
    process.execPath,
    [SYNC, ...args, `--root=${t.dir}`, `--measure=${t.measure}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const readmeOf = (t: Tree): string => readFileSync(join(t.dir, 'README.md'), 'utf8');
const handoverOf = (t: Tree): string => readFileSync(join(t.dir, 'docs', 'HANDOVER.md'), 'utf8');
const lfHash = (text: string): string =>
  createHash('sha256').update(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')).digest('hex').slice(0, 12);

/** `--write` 一次(每个用例的起手式:把副本拉齐到「与测量一致」)。 */
function settle(t: Tree): void {
  const w = run(t, '--write');
  eq(w.status, 0, `--write 应成功(实际:${w.status})\n${w.out}`);
}

test('FND133-1 --write 幂等:连跑两次,第二次零变化且字节不变', () => {
  const t = mkTree();
  try {
    settle(t);
    const a = { readme: readmeOf(t), handover: handoverOf(t) };
    ok(
      a.readme.includes('共 1234 个用例') && a.readme.includes('WS 编号套件          100 条 / 3 套件'),
      `写回后 README 应含测量值(实际片段:${a.readme.split('\n').filter((l) => l.includes('个用例')).join(' | ')})`,
    );
    ok(a.readme.includes('共 **18 个**'), 'README 的 .ts 总数应取测量值 18');
    ok(a.handover.includes('| 用例 | **1234 条 / 7 套件** | WS 100 条 / 3 套件 · 基座 FND 1134 条 / 4 套件'),
      'HANDOVER §三 用例行应取测量值');
    /* 台账那一行取自临时树里**合成台账的表体实算**(3 行:1/1/1/0),不是抄的常数。 */
    ok(a.readme.includes('(3 行:**1 全未接 / 1 部分接 / 1 已接 / 0 已登记**)'),
      `README 的台账桶计数应取合成台账表体(实际:${a.readme.split('\n').find((l) => l.includes('WIRING-LEDGER.md'))})`);
    const second = run(t, '--write');
    eq(second.status, 0, second.out);
    ok(second.out.includes('已写回 0 处'), `第二次 --write 应零变化(实际:${second.out.trim().split('\n').pop()})`);
    eq(readmeOf(t), a.readme, '第二次 --write 不得改动 README 字节');
    eq(handoverOf(t), a.handover, '第二次 --write 不得改动 HANDOVER 字节');
  } finally { t.drop(); }
});

test('FND133-2 --check 在已对齐的树上报「无变化」且 exit 0', () => {
  const t = mkTree();
  try {
    settle(t);
    const c = run(t, '--check');
    eq(c.status, 0, c.out);
    ok(c.out.includes('无变化'), `--check 应报无变化(实际:${c.out.trim().split('\n').pop()})`);
    ok(c.out.includes('未校验 0 项'), `全部字段都有测量源时不应留未校验(实际:${c.out.trim().split('\n').slice(0, 2).join(' | ')})`);
  } finally { t.drop(); }
});

test('FND133-3 --check 绝不写盘:改坏数字后字节逐位不变', () => {
  const t = mkTree();
  try {
    settle(t);
    const p = join(t.dir, 'README.md');
    writeFileSync(p, readmeOf(t).replace('共 1234 个用例', '共 9999 个用例'), 'utf8');
    const before = readFileSync(p);
    const c = run(t, '--check');
    eq(c.status, 1, '--check 发现不一致时退出码必须是 1');
    eq(readFileSync(p).toString('utf8'), before.toString('utf8'), '--check 不得写盘');
  } finally { t.drop(); }
});

test('FND133-4 报错给的是**应写值**:文档写 9999 ⇒ 必须报 1234 并提示 --write', () => {
  const t = mkTree();
  try {
    settle(t);
    writeFileSync(
      join(t.dir, 'README.md'),
      readmeOf(t).replace('共 1234 个用例', '共 9999 个用例'),
      'utf8',
    );
    const c = run(t, '--check');
    eq(c.status, 1);
    ok(c.out.includes('应写「1234」'), `报错必须给出应写值 1234(实际:${c.out})`);
    ok(!c.out.includes('应写「9999」'), '报错不得把文档里的错值当成应写值');
    ok(c.out.includes('node scripts/sync-docs.ts --write'), '报错必须给出修复命令');
  } finally { t.drop(); }
});

test('FND133-5 字段写错位置也红:WS 小计 ↔ 基座小计 互换', () => {
  const t = mkTree();
  try {
    settle(t);
    const swapped = readmeOf(t)
      .replace(/WS 编号套件(\s+)100 条 \/ 3 套件/, 'WS 编号套件$11134 条 / 3 套件')
      .replace(/基座\(([^)\n]*)\)(\s+)1134 条 \/ 4 套件/, '基座($1)$2100 条 / 4 套件');
    writeFileSync(join(t.dir, 'README.md'), swapped, 'utf8');
    const c = run(t, '--check');
    eq(c.status, 1);
    ok(c.out.includes('WS 编号套件') && c.out.includes('基座套件'),
      `两处分项都要被单独指认(实际:${c.out})`);
    ok(c.out.includes('应写「100」') && c.out.includes('应写「1134」'),
      `两处都要给出正确值(实际:${c.out})`);
  } finally { t.drop(); }
});

test('FND133-6 §九 sha256 随内容变化:改一个字节 ⇒ check 报新值、write 后逐位相同', () => {
  const t = mkTree();
  try {
    settle(t);
    const p = join(t.dir, 'README.md');
    const tampered = `${readmeOf(t)}<!-- 人为篡改 -->\r\n`;
    writeFileSync(p, tampered, 'utf8');
    const expected = lfHash(tampered);
    const c = run(t, '--check');
    eq(c.status, 1, c.out);
    ok(c.out.includes('§九 sha256 · README.md'), `应点名 §九 的 README 行(实际:${c.out})`);
    ok(c.out.includes(expected), `应报出新的 sha256 前 12 位 ${expected}(实际:${c.out})`);
    settle(t);
    const row = /^([0-9a-f]{12})[ \t]+README\.md[ \t]*$/m.exec(handoverOf(t));
    if (row === null) throw new Error('§九 表里应有 README.md 行');
    eq(row[1], expected, '写回后表里的哈希必须等于 LF 归一后的 sha256 前 12 位');
    eq(run(t, '--check').status, 0, '写回后 --check 必须干净');
  } finally { t.drop(); }
});

test('FND133-7 未测量 ≠ 通过:没有 suites 测量源时只打「未校验」,不报红也不假装通过', () => {
  const t = mkTree((m) => { delete m.suites; });
  try {
    settle(t);
    const c = run(t, '--check');
    eq(c.status, 0, `没有测量源的字段不参与比对(实际退出码 ${c.status})\n${c.out}`);
    /* 没有 `suites` ⇒ 5 个锚点(用例总数 / WS 小计 / 基座小计 / §一 套件数 / §三 用例)都未校验。 */
    ok(c.out.includes('未校验 5 项'), '必须报出「5 项未校验」');
    ok(c.out.includes('测试执行 / 用例总数'), '必须点名哪个字段未校验');
    ok(c.out.includes('不是通过'), '有字段未校验时,结论行必须自报「不是通过」');
  } finally { t.drop(); }
});

test('FND133-8 锚点被删 ⇒ 结构错误 + 不写盘(不许「删掉那行就变绿」)', () => {
  const t = mkTree();
  try {
    settle(t);
    const p = join(t.dir, 'README.md');
    const withoutLedger = readmeOf(t)
      .split('\n')
      .filter((l) => !l.startsWith('未决台账'))
      .join('\n');
    writeFileSync(p, withoutLedger, 'utf8');
    const before = readFileSync(p);
    const c = run(t, '--write');
    eq(c.status, 1, '--write 遇到缺锚点必须报错退出');
    ok(c.out.includes('找不到锚点'), `应报「找不到锚点」(实际:${c.out})`);
    eq(readFileSync(p).toString('utf8'), before.toString('utf8'), '结构错误时不得写盘');
  } finally { t.drop(); }
});

test('FND133-9 §九 表里混进 HANDOVER 自己 ⇒ 红(自校验不可能)', () => {
  const t = mkTree();
  try {
    settle(t);
    const p = join(t.dir, 'docs', 'HANDOVER.md');
    writeFileSync(
      p,
      handoverOf(t).replace(
        /^([0-9a-f]{12})([ \t]+README\.md[ \t]*\r?\n)/m,
        '$1$2abcdef123456  docs/HANDOVER.md\n',
      ),
      'utf8',
    );
    const c = run(t, '--check');
    eq(c.status, 1);
    ok(c.out.includes('HANDOVER.md 自己进了表') || c.out.includes('未预期行'),
      `应报「自己进了表」(实际:${c.out})`);
  } finally { t.drop(); }
});

test('FND133-10 欠账 / 非欠账 / 差集构成由测量推出(不是抄的白名单常数)', () => {
  const t = mkTree();
  try {
    settle(t);
    /* 测量:白名单 8、非欠账 2、差集 1 ⇒ 欠账 = 8-2 = 6,gate-only = 2-1 = 1 */
    const md = readmeOf(t);
    ok(md.includes('**8 条中 6 条是欠账**'), `欠账数应=白名单−非欠账(实际:${md.split('\n').find((l) => l.includes('条是欠账'))})`);
    ok(md.includes('另 **2 条非欠账**(其中差集 **1** 条 / gate-only **1** 条)'),
      '非欠账 / 差集 / gate-only 三数必须由测量推出');
    ok(md.includes('欠账构成:等客户端入口 0 / 等编排层接线 2 / 等服务端机制 1 / 等客户端机制 3 / 等裁决 0'),
      '五桶构成必须取测量值');
    ok(handoverOf(t).includes('| 生产可达性 | **12 / 20**(不可达 8 = 白名单 8'),
      'HANDOVER 可达性行必须取测量值');
  } finally { t.drop(); }
});

test('FND133-11 台账与 PROGRESS 行也由测量写回(§九 backlog 行曾写死 37)', () => {
  const t = mkTree();
  try {
    settle(t);
    const md = readmeOf(t);
    ok(md.includes('未决台账       133 条 ✅(0 未关闭 / **0 阻塞** / 133 已关闭'),
      'README 台账行必须是四个测量值');
    const ho = handoverOf(t);
    ok(ho.includes('# 133 条 / 0 未关闭 / 0 阻塞'), '§九 backlog 行必须取测量值');
    ok(ho.includes('| PROGRESS 陷阱 | **7 节 / 1..7** | 严格递增 ✓ / 无缺号 ✓ / 无 BOM ✓ / 12345 字节 |'),
      `PROGRESS 行必须整体由测量生成(实际:${ho.split('\n').find((l) => l.includes('PROGRESS 陷阱'))})`);
  } finally { t.drop(); }
});

test('FND133-12 台账表体 ↔ §2.10 汇总表不符 ⇒ 红,且 --write 拒绝写盘', () => {
  const t = mkTree();
  try {
    settle(t);
    const ledgerPath = join(t.dir, 'docs', 'WIRING-LEDGER.md');
    const readmePath = join(t.dir, 'README.md');
    /* 注入:汇总表自报「已接 = 2」,而表体只有 1 行**已接** ⇒ 台账自己内部矛盾。 */
    writeFileSync(ledgerPath,
      readFileSync(ledgerPath, 'utf8').replace('| 已接 | 1 |', '| 已接 | 2 |'), 'utf8');
    const before = readFileSync(readmePath);
    const c = run(t, '--check');
    eq(c.status, 1, `表体与汇总表不符必须红(实际 ${c.status})\n${c.out}`);
    ok(c.out.includes('台账内部矛盾'), `必须报「台账内部矛盾」(实际:${c.out})`);
    ok(c.out.includes('汇总表「已接」= 2') && c.out.includes('表体实算 1'),
      `必须同时给出自报值与实算值(实际:${c.out})`);
    const w = run(t, '--write');
    eq(w.status, 1, `台账内部矛盾时 --write 必须拒绝(实际 ${w.status})\n${w.out}`);
    eq(readFileSync(readmePath).toString('utf8'), before.toString('utf8'),
      '台账内部矛盾时不得写盘(否则就是把错数字盖上「已同步」的章)');
  } finally { t.drop(); }
});

/* ───────── 测量路径二:`--gate-log` 复用(不给 `--measure` 时走的就是这条) ───────── */

/**
 * 合成门禁输出:**每行形状逐字取自 `verify.ts` 的打印模板**(数字由本文件自己定)。
 *
 * 为什么要有它:`parseGate()` 的取数正则只在"真跑一次 `verify --all`"时被执行,
 * 而生产调用(`verify.ts`)走的是 `--measure` 快照 ⇒ **正则坏死无人发现**:
 * 某个字段解析不到 ⇒ 那一栏静默变「未校验」⇒ 文档里那个数字再也没人比。
 * 本用例把"日志复用"这条路径**钉住**:字段全认出来 = 正则活着。
 */
function gateLogText(): string {
  return [
    '  ✓ 14 份 WS 文档结构完整,且与测试集合一一对应',
    '  ✓ 内容与基线一致(v5-deadbeef)',
    '  ✓ 容量账本:物品 12/34,可用号 4321',
    '  ✓ 全仓可擦除:6 个目录无 enum / 参数属性 / namespace / 装饰器 / 缺扩展名导入'
      + '(装饰器例外 3 处已登记并核对)',
    '  ✓ 入口执行层登记自洽(8 个 verdict 守卫 handler 已登记;其中 2 个成功路径为空)',
    '  ✓ 实测取自客户端 4 处(已登记 1 处)',
    '  ✓ 用例汇总:2345 条通过(9 个套件;WS-01..11 共 301 条 / 4 套件;基座 2044 条 / 5 套件)。'
      + '跳过 0 项**未校验**',
    '  ✓ 冻结层不变量与实测一致(21)',
    '  ✓ 生产可达性:可达 61 / 不可达 39 (共 100,入口 12 个,白名单 39 条)',
    '  ✓ 欠账构成(39 条中 6 条**非欠账**,余 33 条按卡点分类):等客户端入口 1 / 等编排层接线 2'
      + ' / 等服务端机制 3 / 等客户端机制 4 / 等裁决 5',
    '  ── 本节 7/9 条门禁通过 ──',
    '  ✓ 差集 2 条是「有生产引用但引用者也不可达」',
    '  ✓ 同义反复候选:命中 3 条(白名单 4 条)',
    '  ✓ 类型错误未增加(基线 261 条 / 实测 111 条;唯一指纹 基线 7 / 实测 3)',
    '  ✓ 门禁自检全部通过(30/31)',
  ].join('\n');
}

/** 与 `run()` 相反:**不给 `--measure`** —— 走 `--gate-log` / 默认 spawn `verify --all` 那条路。 */
function runGate(t: Tree, ...args: string[]): Run {
  const r = spawnSync(
    process.execPath,
    [SYNC, ...args, `--root=${t.dir}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('FND133-13 `--gate-log` 复用路径活着:UTF-16LE(BOM)日志能解码 + 每条正则都取到数', () => {
  const t = mkTree();
  try {
    /* ★ 陷阱复现:PowerShell 的 `node scripts/verify.ts --all > g.log` 写出的是
       **UTF-16LE + BOM**;按 utf8 读 ⇒ 中文字段全匹配不到 ⇒ 全体「未校验」而输出看着正常。 */
    const logPath = join(t.dir, 'gate.log');
    writeFileSync(logPath, Buffer.concat([
      Buffer.from([0xFF, 0xFE]), Buffer.from(gateLogText(), 'utf16le'),
    ]));
    const w = runGate(t, '--write', `--gate-log=${logPath}`);
    eq(w.status, 0, `--gate-log 下 --write 应成功(实际:${w.status})\n${w.out}`);
    ok(w.out.includes(`--gate-log ${logPath}`), `测量源必须自报是复用的日志(实际:${w.out.split('\n')[0]})`);
    /* 每个字段都取自**那份日志**(不是文档旧值、也不是「未校验」) */
    const md = readmeOf(t);
    ok(md.includes('可用号 4321'), '可用号应取自日志');
    ok(/生产可达性\s+61\/100/.test(md), '可达性应取自日志');
    ok(/跨 WS 集成\s+7\/7/.test(md), '跨 WS 集成应取自日志(本节 7/9)');
    ok(md.includes('共 2345 个用例'), '用例汇总应取自日志');
    ok(/测试执行\s+9\/9/.test(md), '套件数应取自日志');
    const ho = handoverOf(t);
    ok(ho.includes('| 类型检查基线 | **111 条 / 指纹 3**'), '类型基线两数应取自日志');
    ok(ho.includes('| 门禁自检 | **30/31**'), '门禁自检应取自日志');
    ok(/\| 跨 WS 集成 \| 7\/7/.test(ho), 'HANDOVER §三 跨 WS 集成应取自日志');
    /* 同一条路径上 `--check` 必须干净 */
    const c = runGate(t, '--check', `--gate-log=${logPath}`);
    eq(c.status, 0, c.out);
    ok(c.out.includes('无变化'), `写回后 --check 应报无变化(实际:${c.out.trim().split('\n').pop()})`);
    /* ★ 正则坏死的**可观测形式**:字段解析不到 ⇒ 那一栏变「未校验」。
       这份日志覆盖了除台账以外的全部字段,而 `backlog.ts` 不在这棵临时树里
       ⇒ 只允许**台账那 3 处**(README 未决台账 / §三 未决台账 / §九 backlog 行)未校验。 */
    const skipped = c.out.split('\n').filter((l) => l.includes('未校验:'));
    eq(skipped.length, 3, `只允许台账 3 处未校验(实际 ${skipped.length}:${skipped.join(' | ')})\n${c.out}`);
    ok(skipped.every((l) => l.includes('台账') || l.includes('backlog')),
      `未校验的必须是台账那几处(实际:${skipped.join(' | ')})`);
    /* 既无 `--measure` 也无日志 ⇒ 默认 spawn `verify --all`;临时树没有 verify.ts
       ⇒ 必须报「测量源缺失」,而不是把「没测量」说成「无变化」。 */
    const noSrc = runGate(t, '--check');
    eq(noSrc.status, 1, `缺测量源必须非零退出(实际 ${noSrc.status})\n${noSrc.out}`);
    ok(noSrc.out.includes('找不到 scripts/verify.ts') || noSrc.out.includes('测量源缺失'),
      `必须报测量源缺失(实际:${noSrc.out.slice(0, 300)})`);
  } finally { t.drop(); }
});

report('WS-FND-133');