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

report('WS-FND-133');