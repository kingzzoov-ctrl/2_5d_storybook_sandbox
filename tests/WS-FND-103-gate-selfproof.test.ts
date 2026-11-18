/**
 * WS-FND-103 —— 「门禁自己证明自己有牙」这条链上的四个洞(2026-11-18 审计 P1,四条都已实测)
 *
 * ## 这一组守的是什么
 *
 * 本仓的最终防线是一句话:「`node scripts/verify.ts` 全绿 ⇒ 可以交付」。
 * 而这句话成立的前提是:**每道门禁在"该红的时候真的会红"**。
 * 审计实测发现这个前提上有四个洞,四个洞的共同形态是同一条:
 * ```
 * 「判据不成立」与「判据通过」在输出上不可区分(陷阱 126)。
 * ```
 *
 * | # | 原缺陷(实测) | 本套判据 |
 * |---|---|---|
 * | P1-1 | `verify.ts::checkGateSelfcheck` 非 `--strict-selfcheck` 时直接 `advise()` + `return`(exit 0)⇒ 「唯一证明各门有牙」的东西自己**默认永不失败** | FND103-1/2/3 |
 * | P1-2 | `runTests` 在 `tests/` 缺失或 0 套件时只 `console.log` 后 return;套件不打印 `N/M 通过` 则 `if (c)` 静默跳过 ⇒ 测试门**结构性可绕过**(`--only __NOMATCH__` 实测 exit 0 + 「全部通过」) | FND103-4/5/6/7 |
 * | P1-3 | `count-audit.ts` 只认 4 条固定措辞正则:改个词 ⇒ hits=0 ⇒ 仍印「一致 0」exit 0;`verify.ts` 对 `count-audit.ts` 缺失只 `advise` | FND103-8/9/10/11/12 |
 * | P1-4 | `docs/HANDOVER.md` §九 的 README sha256 已过期(表 `a38cb95b2d4b` / 实测 `d3604da144a2`) | FND103-13 |
 *
 * ## 判据设计的三条纪律(与本仓既有结论一致)
 *
 * ```
 * 1 每条判据都要能失败:负对照 + 注入验证各至少一次(不是「跑过了」就算数)
 * 2 行为判据优先于文本判据 —— 能真跑一个子进程看退出码,就不要只 grep 源码
 * 3 文本判据只用来锁「接线」(纯函数测不到的那一段),且必须**有顺序语义**:
 *   `fail(` 在 `spawnSync(` 之前、`advise(` 在 `spawnSync(` 之后 ——
 *   这样「把默认路径改回早退」一定会红,而不是「源码里还留着这几个字」就算过
 * ```
 */

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  selfcheckPolicy,
  selfcheckOutcome,
  suiteSetVerdict,
  assertionCountVerdict,
  parseAssertionCounts,
} from '../scripts/verify.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════ 工具 ═══════════════════════ */

interface RunResult { status: number; out: string }

/** 跑一个脚本,**把退出码就地取出**(推远会被「读了没有」类判据误判成没读)。 */
function run(cwd: string, args: string[]): RunResult {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 抽出某个顶层函数的**函数体**。
 *
 * 为什么不用正则截到下一个 `}`:本仓这些函数里有很多嵌套块与模板串,
 * 简单的非贪婪匹配会截短(截短 ⇒ 顺序判据可能"恰好"仍然成立 ⇒ 假绿)。
 * 顶层函数体必然以**行首的 `}`** 结束,故按 `\n}\n` 切最稳。
 * ⚠️ 找不到锚点必须**抛错**:锚点漂移时这条判据不能静默变成"通过"。
 */
function funcBody(src: string, signature: string): string {
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`源码里找不到 \`${signature}\` ⇒ 本判据的锚点漂移了(判据必须因此变红)`);
  const end = src.indexOf('\n}\n', i);
  if (end < 0) throw new Error(`\`${signature}\` 之后找不到行首 \`}\`(函数体不完整?)`);
  return src.slice(i, end);
}

/** LF 归一后的 sha256 前 12 位 —— 与 `verifyHandoverHashes()` 的口径逐字一致。 */
function lfHash(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 12);
}

const lf = (s: string): string => s.replace(/\r\n/g, '\n');

/** 读仓库文件并归一成 LF(源码判据用:CRLF 会让 `\n}\n` 永不到达)。 */
function readSrc(rel: string): string { return lf(readFileSync(join(ROOT, rel), 'utf8')); }

const VERIFY_SRC = readSrc('scripts/verify.ts');

/* ══════════════════════════════════════════════════════════════════════════
 * P1-1 门禁自检:默认口径必须**真跑**(不再"加 --strict-selfcheck 才跑")
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND103-1 门禁自检:默认真跑(block),只有 --lenient 降级 —— 负对照:默认不等于降级', () => {
  /* 三组正例:默认 / --all / 显式 strict 都是 block */
  eq(selfcheckPolicy([]), 'block', '默认口径必须真跑(修前这里是 advise ⇒ 永不失败)');
  eq(selfcheckPolicy(['--all']), 'block', '--all 与不传 flag 必须同口径');
  eq(selfcheckPolicy(['--strict-selfcheck']), 'block', '旧参数仍必须是拦(向后兼容)');
  eq(selfcheckPolicy(['--strict-selfcheck', '--lenient']), 'block', '显式 strict 优先于 lenient');
  /* 负对照:唯一的降级口是 --lenient —— 证明它不是"永远 block" */
  eq(selfcheckPolicy(['--lenient']), 'advise', '--lenient 必须降级(否则本判据恒真)');
  ok(selfcheckPolicy(['--lenient']) !== selfcheckPolicy([]), '默认与 --lenient 必须可区分');
});

test('FND103-2 门禁自检:失败 / 不打印用例数 ⇒ fail;--lenient 只降级不跳过', () => {
  const failOut = '[门禁自检] D3 改坏 verify.ts 的判据\n  ✗ [D3] 改坏后仍然全绿 —— 判据无牙\n  28 通过 / 29 合计\n';
  /* 正例 1:非零退出 + block ⇒ fail(且带上 ✗ 明细) */
  const blocked = selfcheckOutcome('block', 1, failOut);
  eq(blocked.action, 'fail', 'block 口径下非零退出必须 fail');
  ok(blocked.message.includes('✗'), '失败信息必须带上被判据打出来的 ✗ 行');
  eq(blocked.message.includes('28/29'), false, '失败路径不该拿用例数当安慰');
  /* 正例 2:非零退出 + lenient ⇒ advise(降级,但**仍然真跑过**) */
  const lenient = selfcheckOutcome('advise', 1, failOut);
  eq(lenient.action, 'advise', '--lenient 下失败降级为告警');
  ok(lenient.message.includes('降级'), '降级必须写在文案里(不许看起来像通过)');
  /* 正例 3:全绿 ⇒ pass,且带上 N/M(它要被 HANDOVER §三 的「门禁自检 30/30」用) */
  const green = selfcheckOutcome('block', 0, '...\n  30 通过 / 30 合计\n');
  eq(green.action, 'pass', '全绿必须 pass');
  ok(green.message.includes('30/30'), 'pass 行必须带用例数(否则那一行会静默变"未校验")');
  /* 负对照 1:退出码 0 但**没有** N/M 汇总 ⇒ 必须 fail(不许静默跳过) */
  eq(selfcheckOutcome('block', 0, '跑完了,但没打印任何用例数').action, 'fail',
    '解析不到 N/M ⇒ 不是通过,是"没有比对"(HANDOVER §三 那一行会静默变未校验)');
  /* 负对照 2:`status === null`(崩溃/被 kill)不能被当成成功 */
  eq(selfcheckOutcome('block', null, '').action, 'fail', 'status=null 必须 fail');
  eq(selfcheckOutcome('advise', null, '').action, 'advise', 'lenient 下也只是降级');
});

test('FND103-3 接线:checkGateSelfcheck 里 advise 只能出现在 spawn 之后(否则就是"默认不跑")', () => {
  const body = funcBody(VERIFY_SRC, 'async function checkGateSelfcheck(');
  ok(body.includes('selfcheckPolicy(argv)'), '口径必须来自 selfcheckPolicy(单一来源)');
  ok(body.includes('selfcheckOutcome('), '结果必须交给 selfcheckOutcome 分派 pass/fail/advise');
  const spawnAt = body.indexOf('spawnSync(process.execPath, [script]');
  ok(spawnAt > 0, '必须真的 spawn gate-selfcheck(不是只打印一句话)');
  /* ★ 这条是本判据的牙:把默认分支改回「先 advise 再 return」⇒ 顺序立刻反过来 */
  ok(body.indexOf('advise(') > spawnAt,
    '`advise(` 必须出现在 spawn 之后 —— 出现在之前就说明"默认不跑"回来了');
  ok(body.slice(0, spawnAt).includes('fail('),
    'spawn 之前只允许有「脚本缺失 ⇒ fail」这一条早退');
  ok(!body.includes('未纳入默认口径'),
    '旧文案「未纳入默认口径」必须消失 —— 它标的就是"默认不跑"');
});

/* ══════════════════════════════════════════════════════════════════════════
 * P1-2 测试门:0 套件 / 缺 tests 目录 / 套件不打印 N/M ⇒ 必须 fail
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND103-4 测试门:缺 tests/ 或 0 套件 ⇒ fail —— 负对照:非 0 套件才通过', () => {
  const noDir = suiteSetVerdict({ hasTestsDir: false, suiteCount: 0 });
  eq(noDir.ok, false, 'tests/ 不存在必须 fail(修前是 console.log + return)');
  ok(noDir.message.includes('tests/ 目录不存在'), '报错要指名缺的是什么');
  const zero = suiteSetVerdict({ hasTestsDir: true, suiteCount: 0 });
  eq(zero.ok, false, '0 套件必须 fail(与"全部通过"不可区分)');
  ok(zero.message.includes('0 个'), '报错必须给出"0"这个事实');
  const narrowed = suiteSetVerdict({ hasTestsDir: true, suiteCount: 0, only: 'WS-99' });
  eq(narrowed.ok, false, '--only 匹配 0 个套件也必须 fail');
  ok(narrowed.message.includes('--only WS-99'), '报错必须回显被收窄的 --only 值');
  /* 负对照:有套件 ⇒ 通过(证明上面三条不是恒 false) */
  eq(suiteSetVerdict({ hasTestsDir: true, suiteCount: 3 }).ok, true, '3 个套件必须通过');
});

test('FND103-5 单套件计数:不打印 N/M 通过 ⇒ fail;多处 ⇒ fail —— 负对照:恰好一处才通过', () => {
  const parse = parseAssertionCounts;
  eq(parse('随便一段输出,没有计数行'), null, '没有「N/M 通过」⇒ null');
  eq(assertionCountVerdict(parse('随便一段输出,没有计数行')).ok, false,
    'null 必须 fail(修前是 if (c) ⇒ 静默跳过)');
  eq(assertionCountVerdict(null).ok, false, '显式 null 同样必须 fail');
  const multi = parse('[X] 1/1 通过\n[X] 999/999 通过');
  eq(Number.isNaN(multi?.passed ?? 0), true, '多处计数行必须以 NaN 表示"被污染"');
  eq(assertionCountVerdict(multi).ok, false, '多处计数行必须 fail(计数可被套件自己伪造)');
  /* 负对照:恰好一处 ⇒ 通过,且数字是那个数字 */
  const one = parse('[WS-FND-103] 12/12 通过');
  eq(assertionCountVerdict(one).ok, true, '恰好一处必须通过');
  eq(one?.total, 12, '计数必须读的是那一行里的数字');
});

test('FND103-6 接线:runTests 的前置 fail 早于任何 spawn,旧的两条早退文案已消失', () => {
  const body = funcBody(VERIFY_SRC, 'function runTests(');
  ok(body.includes('suiteSetVerdict('), '前置口径必须走 suiteSetVerdict');
  ok(body.includes('assertionCountVerdict('), '单套件计数必须过 assertionCountVerdict');
  const spawnAt = body.indexOf('spawnSync(process.execPath, [f]');
  ok(spawnAt > 0, '必须真的逐个 spawn 套件');
  /* ★ 牙:把前置改回 console.log + return ⇒ spawn 之前不再有 fail(  */
  ok(body.indexOf('fail(') < spawnAt, '前置判据必须在**第一个套件被 spawn 之前** fail');
  ok(!body.includes('暂无 tests/ 目录'), '旧的「暂无 tests/ 目录」文案必须消失');
  ok(!body.includes('无匹配测试'), '旧的「无匹配测试」文案必须消失');
  /* ★ 牙:`null`(未打印 N/M)必须落在**失败**分支 —— 把条件翻成 `c !== null && !av.ok`,
     就等于退回旧的 `if (c)` 静默跳过,而纯函数判据照样全绿 ⇒ 这条必须锁住接线。 */
  ok(/if \(c === null \|\| !av\.ok\) \{/.test(body),
    'null(未打印 N/M)必须在失败分支里:不许静默跳过');
});

test('FND103-7 真跑:verify.ts --only 匹配 0 个套件 ⇒ exit 1(修前实测 exit 0 + 「全部通过」)', () => {
  const r = run(ROOT, ['scripts/verify.ts', '--only', '__WSFND103_NO_SUCH_SUITE__']);
  eq(r.status, 1, '--only 收窄到 0 个套件必须非零退出(否则拼错一个参数就关掉整道测试门)');
  ok(r.out.includes('匹配 0 个套件'), '必须说清"0 个套件",而不是只报一个总数');
  eq(r.out.includes('全部通过'), false, '这个口径下**不许**打印「全部通过」');
});

/* ══════════════════════════════════════════════════════════════════════════
 * P1-3 计数对账:命中数有具名下限 + 被扫文件必须在
 *
 * 注入方式:把 `count-audit.ts` 拷进一棵**合成最小树**(README 自称 / verify 白名单 /
 * orphan 机读行全部由本测试提供),于是"命中数达标"与"命中数归零"两种世界
 * 都能在同一份检测器上跑出来 —— 不需要改真仓一个字节。
 * ══════════════════════════════════════════════════════════════════════════ */

const STUB_VERIFY = 'export const UNREACHABLE_EXEMPT = new Set<string>([\n'
  + "  'a.ts',\n"
  + "  'b.ts',\n"
  + ']);\n'
  + 'export const TAUT_SUSPECT_EXEMPT = new Set<string>([\n'
  + "  't.ts',\n"
  + ']);\n';

const STUB_ORPHAN = 'export const ORPHAN_KNOWN = new Map<string, string>([\n'
  + "  ['a.ts', '理由一行'],\n"
  + "  ['b.ts', '理由一行'],\n"
  + ']);\n'
  + "console.log('__ORPHAN_AUDIT_JSON__' + JSON.stringify({\n"
  + '  measured: 2, measuredLines: 2, dead: 0, deadFiles: [], registered: 2,\n'
  + '  unlisted: 0, unlistedDead: 0, registeredNotMeasured: [], stale: 0,\n'
  + '}));\n';

/** README 里三条自称都指向合成树里算得出的正解(2 / 2 / 1)。 */
const STUB_README_OK = '# stub\n可达性白名单 2 条\n`ORPHAN_KNOWN`(2)\n同义反复白名单 1 条\n';

/** 注入 A:同一句话**换个措辞** ⇒ 三条正则全都匹配不到 ⇒ hits = 0。 */
const STUB_README_REWORDED = '# stub\n可达性白名单共 2 个\n`ORPHAN_KNOWN` 一共 2 个\n同义反复白名单共 1 个\n';

interface FakeTree { dir: string; drop: () => void }

/** 造一棵最小树:只放 count-audit 需要的那三个 + 它 spawn 的 orphan-audit。 */
function makeTree(readme: string | null): FakeTree {
  const dir = mkdtempSync(join(tmpdir(), 'wsfnd103-count-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'count-audit.ts'), join(dir, 'scripts', 'count-audit.ts'));
  writeFileSync(join(dir, 'scripts', 'verify.ts'), STUB_VERIFY, 'utf8');
  writeFileSync(join(dir, 'scripts', 'orphan-audit.ts'), STUB_ORPHAN, 'utf8');
  if (readme !== null) writeFileSync(join(dir, 'README.md'), readme, 'utf8');
  return { dir, drop: (): void => { rmSync(dir, { recursive: true, force: true }); } };
}

test('FND103-8 计数对账(合成树):三条自称全部对上 ⇒ exit 0(负对照的基准世界)', () => {
  const t = makeTree(STUB_README_OK);
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    eq(r.status, 0, `合成树里自称与正解一致时必须 exit 0(实际输出:${r.out.slice(0, 300)})`);
    ok(/自称总数\s*3;与正解一致\s*3;★\s*陈旧\s*0/.test(r.out),
      '汇总行必须是"3 处自称全部对上" —— 与下面两个注入世界只在**命中数**上不同');
    eq(r.out.includes('★ 命中数低于下限'), false, '达标时不该报下限');
    eq(r.out.includes('★ 扫描文件缺失'), false, '文件齐全时不该报缺失');
  } finally { t.drop(); }
});

test('FND103-9 注入:把自称的**措辞**改掉 ⇒ hits=0 ⇒ 必须 fail(修前印「一致 0」exit 0)', () => {
  const t = makeTree(STUB_README_REWORDED);
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    /* ★ 这一条就是审计 P1-3 的正题:同一份检测器、同一句意思,只有措辞变了 */
    eq(r.status, 1, '命中数掉到 0 必须非零退出(改个词就能让检测器恒绿 = 判据消失)');
    ok(r.out.includes('★ 命中数低于下限'),
      '必须报出「★ 命中数低于下限」(verify.ts 接链锚的就是这一行)');
    ok(/合计:命中\s*0\s*<\s*下限/.test(r.out), '报错必须给出"0 < 下限 N"这两个数');
    /* 负对照:这一棵里**不该**同时报逐条陈旧/失真 —— 否则分不清是哪条在红。
       ⚠️ 不能 grep `★ 陈旧` 这个子串:汇总行「...;★ 陈旧 0」里就有它 ⇒
       必须按**定位行形态**(`★ 陈旧 <文件>:<行>`)判,否则本判据会把正常输出判成陈旧。 */
    eq(/★\s*陈旧\s+\S+:\d+/.test(r.out), false, '本注入只该触发下限,不该连带报逐条陈旧');
    eq(r.out.includes('★ 登记失真'), false, '本注入不该触发互校(互校数据是自洽的)');
  } finally { t.drop(); }
});

test('FND103-10 注入:删掉一个**被扫文件** ⇒ 必须 fail(删文件 = 让里面的自称一起消失)', () => {
  const t = makeTree(null); /* 没有 README.md */
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    eq(r.status, 1, '被扫文件缺失必须非零退出');
    ok(r.out.includes('★ 扫描文件缺失'), '必须报出「★ 扫描文件缺失」');
    ok(r.out.includes('README.md'), '报错必须点名**哪一个**文件缺了');
  } finally { t.drop(); }
});

test('FND103-11 接线:count-audit.ts 缺失 ⇒ verify 侧 fail(不再 advise)', () => {
  const body = funcBody(VERIFY_SRC, 'function checkCountAudit(');
  const missAt = body.indexOf('!existsSync(script)');
  ok(missAt > 0, '必须有「脚本存在性」判据');
  const missBlock = body.slice(missAt, missAt + 600);
  ok(missBlock.includes('fail('), '脚本缺失必须 fail(修前是 advise ⇒ 删掉它就能关掉整道比对)');
  ok(!missBlock.includes("advise('计数对账'"), '不许退回 advise');
  /* 上游新增的两道"还比得上吗"断言,接线侧必须各自认得(理由不能混成一句) */
  ok(body.includes('★ 命中数低于下限'), '必须消费 count-audit 的下限标记');
  ok(body.includes('★ 扫描文件缺失'), '必须消费 count-audit 的缺文件标记');
});

test('FND103-12 真仓:count-audit 当前仍达标(下限常量与今天的文档状态相容)', () => {
  const r = run(ROOT, ['scripts/count-audit.ts']);
  eq(r.status, 0, `真仓 count-audit 必须绿(否则下限设错了:${r.out.slice(0, 300)})`);
  ok(/自称总数\s*\d+;与正解一致\s*\d+;★\s*陈旧\s*0/.test(r.out), '汇总行必须可解析');
  eq(r.out.includes('★ 命中数低于下限'), false, '真仓当前命中数必须不低于下限');
});

/* ══════════════════════════════════════════════════════════════════════════
 * P1-4 HANDOVER §九 的 README 哈希
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND103-13 HANDOVER §九 的 README sha256 == LF 归一后的 README —— 负对照:多一个字节必不等', () => {
  const handover = lf(readFileSync(join(ROOT, 'docs', 'HANDOVER.md'), 'utf8'));
  const readme = lf(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  const row = /^([0-9a-f]{12})[ \t]+README\.md[ \t]*$/m.exec(handover);
  ok(row !== null, 'HANDOVER §九 必须有 `README.md` 那一行(删行 = 少查一个文件)');
  /* ⚠️ 不用 `row[1]` 直接取:`ok()` 不窄化类型(tests 的类型基线也是锁死的)⇒ 用 `?? ''`,
     缺行时 listed 为空串 ⇒ 下面的 eq 必然红(不会因为类型收窄问题而静默通过)。 */
  const listed = row?.[1] ?? '';
  eq(listed === lfHash(readme), true,
    `§九 的 README 哈希必须等于当前 README(LF 归一;表 ${listed} / 实测 ${lfHash(readme)})`);
  /* 负对照:同一判据对"改过一个字节的 README"必须说"不等" —— 否则它是恒真式 */
  ok(lfHash(`${readme}\n`) !== listed, '负对照:README 多一个换行后哈希必须变(判据不是恒真)');
  ok(lfHash(`${readme}x`) !== listed, '负对照:README 多一个字符后哈希必须变');
});

/* 注入用的临时目录一律 `os.tmpdir()` + `finally rmSync`:
   写进仓内会撞「临时残留」告警,写进系统临时目录则天然隔离。 */
report('WS-FND-103');