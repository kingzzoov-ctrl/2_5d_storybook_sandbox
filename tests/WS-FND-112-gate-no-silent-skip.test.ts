/**
 * WS-FND-112 —— 「门禁的四处静默跳过 + 四组旧判据」的回归锁
 *
 * ## 这一组守的是什么(2026-11-18 第四轮元审计实测)
 *
 * ```
 * 1 verify.ts::checkJudgementAudit  删掉 judgement_audit.ts ⇒ 只 advise 不 fail
 *                                   (同族另外四处用的都是 fail)
 * 2 verify.ts::checkDocs            docs/WS-*.md 一份不剩 ⇒ 直接 return:
 *                                   非 WS 文档 / 链接存在性 / 未决台账**一起**被跳过,
 *                                   README「WS 文档结构」静默降级成「未校验」
 * 3 verify.ts::checkClientBuild     node_modules/vite 不存在 ⇒ 只 console.log 后 return
 *                                   (既不计 advise、也不进汇总行;而它是 client/**\/boot.ts
 *                                    零测试覆盖下**唯一**的自动化验证)
 * 4 count-audit.ts                  CLAIM_FLOORS 里两类下限是 **0**(= 没有保护);
 *                                   countEntries 缩进一变返回 **0**(非 null),而断言 #2 只查 undefined
 * 5 tests/WS-FND-01 A15             零断言(恒绿)
 * 6 tests/WS-09:3832                `eq(L.cols*L.rows, L.cols*L.rows)`(恒真)
 * 7 tests/WS-FND-06:1028            手册不在场 ⇒ `ok(true,'跳过')`(与「通过」逐字相同)
 * 8 doc-line-audit / eol-audit / dead_items 各一条最小校验缺失
 * ```
 *
 * ## 判据纪律(与本仓 FND-103 同一套)
 *
 * ```
 * 1 每条都要能失败 —— 负对照 / 注入验证各至少一次(「跑过了」不算数)
 * 2 行为判据优先:能真跑一个子进程看退出码,就不要只 grep 源码
 * 3 文本判据只用来锁「接线」(纯函数测不到的那一段),且必须带**结构语义**
 * 4 合成树注入一律写 `os.tmpdir()`,绝不写进仓内(「临时残留」门禁 + 不碰真仓)
 * ```
 */

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { reasonVerdict, consumerVerdict, DEAD_ITEMS } from '../scripts/dead_items.ts';
import { layoutInventoryPanel } from '../client/src/ui/panel_layout.ts';
import { canonicalize, fnv1a32, contentFingerprints } from '../server/src/content/registry.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════ 工具 ═══════════════════════ */

interface RunResult { status: number; out: string }

/** 跑一个脚本,**退出码就地取出**(与 FND-103 同一纪律:推远会被 F-类判据误判)。 */
function run(cwd: string, args: string[], env?: Record<string, string>): RunResult {
  const r = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 180_000,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** LF 归一后读源码(CRLF 会让 `\n}\n` 之类的锚点永不到达)。 */
function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 抽某个顶层函数的**函数体**(与 FND-103 同一手法;锚点漂移必须抛错,不许静默通过)。 */
function funcBody(src: string, signature: string): string {
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`源码里找不到 \`${signature}\` ⇒ 本判据的锚点漂移了(必须因此变红)`);
  const end = src.indexOf('\n}\n', i);
  if (end < 0) throw new Error(`\`${signature}\` 之后找不到行首 \`}\``);
  return src.slice(i, end + 2);
}

interface FakeTree { dir: string; drop: () => void }

function makeTree(prefix: string, files: Record<string, string>): FakeTree {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  return { dir, drop: (): void => { rmSync(dir, { recursive: true, force: true }); } };
}


/**
 * 剥掉注释后的**代码** —— 文本判据必须只看代码:说明里会引用被禁的写法(本仓自己就反复这么做)。
 *
 * ⚠️ 这里**刻意不用正则**:剥**行注释**的那个写法若缺 `(^|[^:])` 前缀,会把 `https://`
 * (judgement_audit 的 B 类形态)。逐字符扫既没有那个洞,也不需要往登记表里加挂账。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      out += ' ';
      continue;
    }
    if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** 抽一个 `test('…', () => { … });` 用例的**完整**函数体(到行首 `});` 为止)。 */
function testBody(src: string, marker: string): string {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`找不到用例锚点 \`${marker}\` ⇒ 判据必须因此变红`);
  const end = src.indexOf('\n});', i);
  if (end < 0) throw new Error(`用例 \`${marker}\` 之后找不到行首 \`});\``);
  return src.slice(i, end + 4);
}
const VERIFY_SRC = readSrc('scripts/verify.ts');
const COUNT_SRC = readSrc('scripts/count-audit.ts');
const DLINE_SRC = readSrc('scripts/doc-line-audit.ts');
const EOL_SRC = readSrc('scripts/eol-audit.ts');
const WS06_SRC = readSrc('tests/WS-FND-06.test.ts');
const WS09_SRC = readSrc('tests/WS-09.test.ts');
const WS01_SRC = readSrc('tests/WS-FND-01.test.ts');

/* ══════════════════════════════════════════════════════════════════════════
 * 1 判据形态审计:脚本被删 ⇒ fail(修前:advise ⇒ 「判据被删掉」= 「判据通过」)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND112-1 判据形态审计:judgement_audit.ts 缺失必须 fail,不许退回 advise', () => {
  const body = funcBody(VERIFY_SRC, 'function checkJudgementAudit(');
  const at = body.indexOf('!existsSync(script)');
  ok(at > 0, '必须有「脚本存在性」判据(删掉锚点 = 本用例失去意义)');
  const block = stripComments(body.slice(at, at + 900));
  ok(block.includes('fail('), '脚本缺失必须 fail(修前是 advise ⇒ 删掉它就能关掉整道判据形态审计)');
  eq(/advise\(/.test(block), false, '这一支的**代码**里不许再出现 advise(');
  ok(block.indexOf('fail(') < block.indexOf('return;'),
    'fail( 必须排在 return; **之前**(否则那一支仍然只是"提前退出 + 什么都没判")');
  /* ★ 注入:把 fail( 换回 advise( ⇒ 上面两条判据必须同时否定 */
  const injected = body.replace(/\n    fail\(\n/, "\n    advise('判据形态审计',\n");
  ok(injected !== body, '注入锚点必须命中(否则这说明本用例没真的检查那一段)');
  const injBlock = stripComments(injected.slice(injected.indexOf('!existsSync(script)'), injected.indexOf('!existsSync(script)') + 900));
  ok(!injBlock.includes('fail('), '负对照:换成 advise( 之后 fail( 必须消失');
  ok(/advise\(/.test(injBlock), '负对照:换回 advise( 后必须能被判据看见(证明判据不是恒真)');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2 文档结构:0 份 WS 文档 ⇒ fail,且**不许连带跳过**后面三段检查
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND112-2 文档结构:0 份 WS 文档必须 fail,且非 WS / 链接 / 台账三段仍照跑', () => {
  /* ★ 第五轮元审计:`checkDocs` 的**注释里**就写着 `bad === 0 && files.length > 0`
     与 `detectStale()`(本仓惯例:说明引用被修的写法)。拿未剥注释的 body 做子串断言
     ⇒ 把早退 `return;` 加回去、或把三段检查写成死代码,判据仍可能绿。
     ⇒ 下面**只在剥注释后的代码**上断言(与 FND112-1/FND112-10 同一套 stripComments)。 */
  const body = stripComments(funcBody(VERIFY_SRC, 'function checkDocs('));
  const at = body.indexOf('files.length === 0');
  ok(at > 0, '必须有「0 份 WS 文档」这一支(锚点漂移即本用例失效)');
  const block = body.slice(at, body.indexOf('const required'));
  ok(block.includes('fail('), '0 份 WS 文档必须 fail(修前是 console.log + return ⇒ 整道文档结构门消失)');
  eq(/^\s*return;/m.test(block), false, '这一支里**不许**早退 —— 早退会连带跳过非 WS / 链接 / 台账三段');
  /* 后面三段必须还在同一个函数体里(它们的存在才是"没有连带跳过"的证据) */
  ok(body.includes('MIN_NON_WS_CHARS'), '非 WS 文档检查必须仍在');
  ok(body.includes('链接到不存在的文档'), '文档间链接存在性检查必须仍在');
  ok(body.includes('detectStale()'), '未决台账过时条目检查必须仍在');
  /* README「WS 文档结构 N/N」的实测值必须**无条件**赋值 ⇒ 0 份时它会被逐字比出来 */
  ok(/docStructCount = files\.length;/.test(body), 'docStructCount 必须无条件赋值(否则 README 那一栏静默变「未校验」)');
  /* ★ 负对照:`bad === 0` 的 pass 分支必须排除 0 份(否则会打出一行绿色的"0 份完整") */
  ok(/bad === 0 && files\.length > 0/.test(body), 'pass 分支必须排除 0 份(否则红被绿盖住)');
  /* ★ 注入:把早退加回去 ⇒ 判据必须变红 */
  const injected = body.replace(/    fail\(\n/, '    return;\n');
  const injBlock = injected.slice(injected.indexOf('files.length === 0'), injected.indexOf('const required'));
  ok(/^\s*return;/m.test(injBlock), '负对照:加回 return; 后必须被判据看见(证明本判据不是恒真)');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3 客户端构建:缺 vite ⇒ 至少进 advise/汇总(修前静默跳过)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND112-3 客户端构建:缺 vite 必须 advise 进汇总(修前只 console.log + return)', () => {
  const body = funcBody(VERIFY_SRC, 'function checkClientBuild(');
  const at = body.indexOf('!existsSync(viteJs)');
  ok(at > 0, '必须有「vite 存在性」判据');
  const block = body.slice(at, at + 800);
  ok(/advise\(\s*'客户端构建'/.test(block), '缺 vite 必须 advise("客户端构建", …) ⇒ 才会进汇总行');
  eq(/console\.log\([^)]*跳过/.test(block), false, '不许退回「只打一行 console.log 然后 return」');
  /* 汇总行的口径:没有升级开关的门禁会打出 `**按设计只告警(不属三道 strict)**` */
  /* ★ 注入:把 advise( 换成 console.log( ⇒ 判据必须变红 */
  const injected = body.replace(/    advise\(\n/, '    console.log(\n');
  ok(injected !== body, '注入锚点必须命中');
  const injBlock = injected.slice(injected.indexOf('!existsSync(viteJs)'), injected.indexOf('!existsSync(viteJs)') + 800);
  eq(/advise\(/.test(injBlock), false, '负对照:换回 console.log 后 advise( 必须消失(证明判据不是恒真)');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4 count-audit:下限不许是 0;0 与 null 都要判
 *
 * 注入方式与 FND-103 相同:把 `count-audit.ts` 拷进一棵**合成最小树**
 * (README 自称 / verify 白名单 / orphan 机读行全部由本测试提供),
 * 于是"达标"与各种"检测面消失"的世界能在**同一份检测器**上跑出来。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 2 空格缩进的白名单 + **空白名单**(只有块注释、零条目 = 本仓的真实形态)。 */
const WL_OK = 'export const UNREACHABLE_EXEMPT = new Set<string>([\n'
  + "  'a.ts',\n"
  + "  'b.ts',\n"
  + ']);\n'
  + 'export const TAUT_SUSPECT_EXEMPT = new Set<string>([\n'
  + ']);\n';

/** ★ 注入(缩进):同一条声明改成 **4 空格** ⇒ 两张正则都数不到条目。 */
const WL_INDENTED = WL_OK.replace("  'a.ts',\n  'b.ts',", "    'a.ts',\n    'b.ts',");

/** ★ 注入(清空):表体变成空的 ⇒ 「0」是一个**合法**正解,必须被显式认账。 */
const WL_EMPTIED = 'export const UNREACHABLE_EXEMPT = new Set<string>([\n]);\n'
  + 'export const TAUT_SUSPECT_EXEMPT = new Set<string>([\n]);\n';

const ORPHAN_STUB = 'export const ORPHAN_KNOWN = new Map<string, string>([\n'
  + "  ['a.ts', '理由理由理由'],\n"
  + "  ['b.ts', '理由理由理由'],\n"
  + ']);\n'
  + "console.log('__ORPHAN_AUDIT_JSON__' + JSON.stringify({\n"
  + '  measured: 2, measuredLines: 2, dead: 0, deadFiles: [], registered: 2,\n'
  + '  unlisted: 0, unlistedDead: 0, registeredNotMeasured: [], stale: 0,\n'
  + '}));\n';

/** README:三类自称各一处,全部等于合成树的正解(2 / 2 / 0)。 */
const README_ALL_OK = '# stub\n可达性白名单 2 条\n`ORPHAN_KNOWN`(2)\n同义反复白名单 0 条\n';

/** ★ 注入(措辞):把「可达性白名单」改个词 ⇒ 该类的命中数掉到 **0**。 */
const README_ONE_REWORDED = '# stub\n可达性白名单共 2 个\n`ORPHAN_KNOWN`(2)\n同义反复白名单 0 条\n';

/** ★ 注入(自称跟着写 0):表数不出条目时,自称若也写 0 ⇒ 修前「0 == 0」逐字全绿。 */
const README_CLAIM_ZERO = '# stub\n可达性白名单 0 条\n`ORPHAN_KNOWN`(2)\n同义反复白名单 0 条\n';

function makeCountTree(verifyStub: string, readme: string): FakeTree {
  const dir = mkdtempSync(join(tmpdir(), 'wsfnd112-count-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'count-audit.ts'), join(dir, 'scripts', 'count-audit.ts'));
  writeFileSync(join(dir, 'scripts', 'verify.ts'), verifyStub, 'utf8');
  writeFileSync(join(dir, 'scripts', 'orphan-audit.ts'), ORPHAN_STUB, 'utf8');
  writeFileSync(join(dir, 'README.md'), readme, 'utf8');
  return { dir, drop: (): void => { rmSync(dir, { recursive: true, force: true }); } };
}

test('FND112-4 count-audit:每一类的具名下限都必须 ≥1(下限 0 = 没有保护)', () => {
  const m = /const CLAIM_FLOORS:[\s\S]*?=\s*\{([\s\S]*?)\};/.exec(COUNT_SRC);
  ok(m !== null, '源码里必须能解析出 CLAIM_FLOORS(锚点漂移即本用例失效)');
  const body = m![1]!;
  const pairs = [...body.matchAll(/(\S+?):\s*(\d+),/g)].map((x) => ({ key: x[1]!, floor: Number(x[2]) }));
  eq(pairs.length, 3, '三类正解键必须各有一条下限(少一条 = 该类没有保护)');
  const zero = pairs.filter((p) => p.floor === 0);
  eq(zero.length, 0, '不许有 0 下限(实测修前有两类下限就是 0:可达性白名单 / orphan —— 等于没有保护)');
  /* ★ 负对照:把任一类的下限改成 0 ⇒ 上面那条必须能看见它 */
  const injected = body.replace(/(\S+?):\s*(\d+),/, '$1: 0,');
  const injZero = [...injected.matchAll(/(\S+?):\s*(\d+),/g)]
    .map((x) => ({ key: x[1]!, floor: Number(x[2]) })).filter((p) => p.floor === 0);
  eq(injZero.length, 1, '负对照:把一条下限改成 0 后必须恰好被数出 1 条(证明判据不是恒真)');
});

test('FND112-5 计数对账(合成树):达标世界必须 exit 0 —— 负对照的基准', () => {
  const t = makeCountTree(WL_OK, README_ALL_OK);
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    eq(r.status, 0, `三类自称全部对上时必须 exit 0(实际输出:${r.out.slice(0, 300)})`);
    ok(/自称总数\s*3;与正解一致\s*3;★\s*陈旧\s*0/.test(r.out), '汇总行必须是"3 处自称全部对上"');
    eq(r.out.includes('★ 命中数低于下限'), false, '达标时不该报下限');
    eq(r.out.includes('★ 正解缺失'), false, '达标时不该报正解缺失');
    eq(r.out.includes('★ 正解为 0 未登记'), false, '达标时不该报"0 未登记"(空白名单已登记)');
  } finally { t.drop(); }
});

test('FND112-6 注入(措辞):某一类被改词 ⇒ 命中 0 ⇒ 必须 fail(修前下限 0 ⇒ 绿)', () => {
  const t = makeCountTree(WL_OK, README_ONE_REWORDED);
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    eq(r.status, 1, '命中数掉到 0 必须非零退出(改个词就能让检测器恒绿 = 判据消失)');
    ok(r.out.includes('★ 命中数低于下限'), '必须报出「★ 命中数低于下限」(verify.ts 接链锚的就是这一行)');
    ok(/可达性白名单:命中\s*0\s*<\s*下限\s*1/.test(r.out), '报错必须给出「哪一类 + 0 < 下限 1」');
    /* 负对照:本注入只该触发下限 —— 不许连带报陈旧/失真(否则分不清是哪条在红) */
    eq(/★\s*陈旧\s+\S+:\d+/.test(r.out), false, '本注入不该触发逐条陈旧(另外两类是自洽的)');
    eq(r.out.includes('★ 登记失真'), false, '本注入不该触发互校');
  } finally { t.drop(); }
});

test('FND112-7 注入(缩进):表数不出条目 + 自称写 0 ⇒ 必须 fail(修前 0==0 逐字全绿)', () => {
  const t = makeCountTree(WL_INDENTED, README_CLAIM_ZERO);
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    eq(r.status, 1, '正解解析不出来时必须非零退出(修前 countEntries 返回 0 ⇒ 与自称 0 相等 ⇒ exit 0)');
    ok(r.out.includes('★ 正解缺失'), '必须报「★ 正解缺失」(名称/缩进/形态变了)');
    ok(r.out.includes('可达性白名单'), '报错必须点名**哪一个**键解析失败');
    eq(r.out.includes('★ 登记失真'), false, '本注入不该触发互校(数据是自洽的)');
  } finally { t.drop(); }
});

test('FND112-8 注入(清空):表真的空了 + 自称写 0 ⇒ 必须报「正解为 0 未登记」', () => {
  const t = makeCountTree(WL_EMPTIED, README_CLAIM_ZERO);
  try {
    const r = run(t.dir, ['scripts/count-audit.ts']);
    eq(r.status, 1, '“正解变成 0”必须有人显式认账,否则非零退出');
    ok(r.out.includes('★ 正解为 0 未登记'), '必须报出「★ 正解为 0 未登记」(断言 #2b)');
    eq(r.out.includes('★ 正解缺失'), false, '本注入是"解析成功但为 0",不该与「正解缺失」混报');
    eq(/★\s*陈旧\s+\S+:\d+/.test(r.out), false, '自称与正解一致(都 0)⇒ 不该报陈旧');
    /* 接线侧:verify.ts 必须认得这一行,否则那条断言在门禁上等于不存在 */
    const body = funcBody(VERIFY_SRC, 'function checkCountAudit(');
    ok(body.includes('★ 正解为 0 未登记'), 'verify.ts::checkCountAudit 必须消费 #2b 的标记');
  } finally { t.drop(); }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5/6 两条旧判据:A15 零断言、WS-09 恒真
 * ══════════════════════════════════════════════════════════════════════════ */

/** 数一段源码里的断言调用(只用于"零断言"这一条)。 */
function assertionCalls(body: string): number {
  return (body.match(/\b(?:ok|eq|near|includes|inRange)\s*\(/g) ?? []).length;
}

test('FND112-9 A15(WS-FND-01):用例必须有真断言 —— 负对照:抽掉断言后判据必须为 0', () => {
  const body = testBody(WS01_SRC, "test('A15 ");
  const n = assertionCalls(body);
  ok(n >= 3, `A15 必须有 ≥3 处断言(修前是 **0 处**,恒绿;实测 ${n} 处)`);
  /* ★ 负对照:把断言行删掉 ⇒ 同一台判据必须数出 0(证明它测的真是断言,不是"文件里很多 ok(") */
  const stripped = body.split('\n').filter((l) => !/\b(?:ok|eq)\s*\(/.test(l)).join('\n');
  eq(assertionCalls(stripped), 0, '负对照:抽掉断言行后必须数出 0');
  /* ★ 行为面:按同一口径独立复算 items 指纹 —— 与 A15 里的独立复算一致 */
  const projected = ITEM_LIST.map((row) => {
    const src = row as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) if (k !== 'note') out[k] = src[k];
    return out;
  });
  const hash = fnv1a32(canonicalize(projected));
  eq(hash, contentFingerprints().items, '独立复算的 items 指纹必须等于发布值');
  const changed = ITEM_LIST.map((row, i) =>
    (i === 0 ? { ...row, name: 'FND112-MUTATED' } : row));
  ok(fnv1a32(canonicalize(changed.map((row) => {
    const src = row as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) if (k !== 'note') out[k] = src[k];
    return out;
  }))) !== hash, '负对照:改了参与投影的字段后指纹必须变');
});

/** 「两侧同源」探针:只认**字面量以外的同一个表达式** —— 用于 WS-09 那条回归锁。 */
function selfCompareLines(src: string): string[] {
  const hits: string[] = [];
  const re = /\beq\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,/g;
  for (const m of src.matchAll(re)) {
    const a = m[1]!.replace(/\s+/g, '');
    const b = m[2]!.replace(/\s+/g, '');
    if (a === b && !/^['"0-9]/.test(a)) hits.push(a);
  }
  return hits;
}

test('FND112-10 WS-09:格子数那条不再两侧同源,且尺寸自洽可独立复算', () => {
  /* ★ 回归锁:旧形态必须**逐字不在**了。needle 用拼接构造 —— 本文件里不出现那个写法本身,
     免得探针(或人)在本测试的源码里又看到一次"恒真断言"。 */
  const needle = `eq(L.cols * L.rows, L.cols * L.rows`;
  eq(stripComments(WS09_SRC).replace(/[ \t]+/g, ' ').includes(needle), false,
    '旧判据 `eq(L.cols*L.rows, L.cols*L.rows)` 必须从**代码**里消失(两侧同源 ⇒ 恒真)');
  /* ★ 判据的牙:同一台探针喂进旧写法必须**报出**它 */
  const injected = `  ${needle}, '网格格数 = 列×行');\n`;
  eq(selfCompareLines(injected).length, 1, '注入旧写法后探针必须报 1 处(证明探针不是恒假)');
  /* ★ 行为面:新断言用的三个数是**独立复算**出来的,这里再独立算一遍 */
  const L = layoutInventoryPanel(1280, 800);
  eq(L.cols * L.rows, 160, '一页格数 = 列 × 行 = 160');
  eq(L.panel.w - L.cols * L.cell, 32, '面板宽 − 网格宽 = 两侧外边距');
  eq(L.panel.h - L.rows * L.cell, 106, '面板高 − 网格高 = 标题 + 标签 + 分页 + 外侧');
  eq(selfCompareLines(stripComments(WS09_SRC)).includes('L.cols*L.rows'), false, '同上(剥注释后再查一次)');
  /* ⚠️ 上面那两条都只在**代码**上查:说明里会引用被禁的写法(本仓自己就这么做),
     拿原文查会立刻变红 —— 那是"判据读错了对象",不是注入抓到了东西。 */
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7 WS-FND-06:跳过必须**可见**(不许 ok(true,'跳过'))
 * ══════════════════════════════════════════════════════════════════════════ */

/** 真实手册的位置:`locatePlan()` 会按 PLAN_MD → %USERPROFILE%/Downloads → docs/ 找。 */
const PLAN_ENV_SKIP = {
  PLAN_MD: join(tmpdir(), '__wsfnd112_no_such_plan__.md'),
  USERPROFILE: tmpdir(),
};

test('FND112-11 WS-FND-06:跳过必须自报(计入 SKIPS 并打汇总行),不许 ok(true,"跳过")', () => {
  /* (a) 手册在场(默认环境)⇒ 跳过 0 项,且那一行存在(证明"0"是**报出来的**,不是省略) */
  const normal = run(ROOT, ['tests/WS-FND-06.test.ts']);
  eq(normal.status, 0, `WS-FND-06 必须绿(实际:${normal.out.slice(-200)})`);
  ok(/\[WS-FND-06\] 跳过 0 项/.test(normal.out), '手册在场时也必须打「跳过 0 项」这一行(汇总要看得见)');
  /* (b) 注入:把手册路径全部引开 ⇒ 走跳过分支 ⇒ 必须**报出 1 项**且仍然绿(跳过≠失败) */
  const skipped = run(ROOT, ['tests/WS-FND-06.test.ts'], PLAN_ENV_SKIP);
  eq(skipped.status, 0, '手册不在场只是跳过,不是失败');
  ok(/\[WS-FND-06\] 跳过 1 项/.test(skipped.out),
    `手册不在场时必须报「跳过 1 项」(修前它只打一句 msg、与"通过"逐字相同):${skipped.out.slice(-200)}`);
  ok(/手册文件不在场/.test(skipped.out), '跳过行必须写出**为什么**跳过');
  /* (c) 接线侧:verify.ts 必须把自报的跳过累加进总账 */
  const runBody = funcBody(VERIFY_SRC, 'function runTests(');
  /* ⚠️ 这两条比的是**源码文本**,故 needle 必须写「源码里的字面量本身」
     (源码里写的是 `\s*(\d+)\s*项` —— 用反斜杠转义的字符串比对,不做二次转义)。 */
  ok(runBody.includes('跳过\\s*(\\d+)\\s*项'), 'runTests 必须解析「跳过 N 项」(否则自报只活在那一个套件里)');
  ok(runBody.includes('跳过 ${sumSkipped} 项**未校验**'), '用例汇总行必须打印跳过总数');
  /* (d) 旧写法必须消失:`ok(true, …跳过…)` */
  eq(/ok\(true,[^)]*跳过/.test(stripComments(WS06_SRC)), false,
    '不许用 ok(true, "跳过…") 表示跳过(那是把"没跑"写成"通过");注:只在**代码**上查,说明里可以引用旧写法');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8 三处最小校验:doc-line-audit 区间终点 / eol-audit bad 含纯 CRLF / dead_items 内容
 * ══════════════════════════════════════════════════════════════════════════ */

const X_TS = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

test('FND112-12 doc-line-audit:行区间**终点**越界必须报(修前只判起点)', () => {
  const src = { 'scripts/doc-line-audit.ts': DLINE_SRC, 'src/x.ts': X_TS, 'notes.md': '引用 src/x.ts:2-99999\n' };
  const t = makeTree('wsfnd112-dline-', src);
  try {
    const r = run(t.dir, ['scripts/doc-line-audit.ts']);
    ok(/行区间终点 99999 > 文件总行数 \d+/.test(r.out),
      `区间终点越界必须被报出(修前只查起点 ⇒ 它落进"行号在范围内"):${r.out.slice(0, 400)}`);
    /* ★ 注入:把终点那一段删掉(= 旧版本)⇒ 同一个 case 必须**不再被报出** */
    const old = DLINE_SRC.replace(/  if \(r\.end !== undefined && r\.end > L\.length\) \{[\s\S]*?\n  \}\n/, '');
    ok(old !== DLINE_SRC, '注入锚点必须命中(否则本用例没真的测到那段新代码)');
    const t2 = makeTree('wsfnd112-dline-old-', { ...src, 'scripts/doc-line-audit.ts': old });
    try {
      const r2 = run(t2.dir, ['scripts/doc-line-audit.ts']);
      eq(/行区间终点 99999/.test(r2.out), false, '旧版本(删掉终点判据)必须看不见它 —— 证明上面那条红是**新代码**带来的');
    } finally { t2.drop(); }
  } finally { t.drop(); }
  /* 负对照:起点与终点都在范围内 ⇒ 不许报越界 */
  const okTree = makeTree('wsfnd112-dline-ok-', {
    'scripts/doc-line-audit.ts': DLINE_SRC, 'src/x.ts': X_TS, 'notes.md': '引用 src/x.ts:1-2\n',
  });
  try {
    const r = run(okTree.dir, ['scripts/doc-line-audit.ts']);
    eq(r.out.includes('行区间终点'), false, '负对照:区间在范围内时不许报越界');
    ok(/行号在范围内\(需人看\)\s*:\s*1 处/.test(r.out), '负对照:它应当落在"在范围内(需人看)"这一类里');
  } finally { okTree.drop(); }
});

/** 结论行判据:高危项合计必须 = [1] + [2] + [3](修前只算 [2]+[3])。 */
function eolBadVerdict(out: string): { ok: boolean; detail: string } {
  const g = /\[1\] 纯 CRLF\s+(\d+)/.exec(out);
  const m = /\[2\] 内部混用\s+(\d+)/.exec(out);
  const b = /\[3\] 带 BOM\s+(\d+)/.exec(out);
  const h = /高危项合计 (\d+)/.exec(out);
  if (g === null || m === null || b === null || h === null) {
    return { ok: false, detail: '结论行不可解析(崩溃 / 格式变了 —— 不许当成通过)' };
  }
  const want = Number(g[1]) + Number(m[1]) + Number(b[1]);
  const got = Number(h[1]);
  return {
    ok: got === want,
    detail: `[1]=${g[1]} [2]=${m[1]} [3]=${b[1]} ⇒ 应为 ${want},实际合计 ${got}`,
  };
}

test('FND112-13 eol-audit:高危项合计必须含 [1] 纯 CRLF(修前只算 [2]+[3])', () => {
  const t = makeTree('wsfnd112-eol-', {
    'scripts/eol-audit.ts': EOL_SRC,
    'scripts/scan-scope.ts': readSrc('scripts/scan-scope.ts'),
    'crlf.txt': 'a\r\nb\r\n',
    'lf.txt': 'a\nb\n',
  });
  try {
    const r = run(t.dir, ['scripts/eol-audit.ts']);
    const v = eolBadVerdict(r.out);
    ok(v.ok, `高危项合计必须 = [1]+[2]+[3](${v.detail})`);
    ok(r.out.includes('crlf.txt'), '纯 CRLF 文件必须被**逐名**列出(不能只在计数里)');
    /* ★ 注入:把合计换成旧公式([2]+[3])⇒ 判据必须变红 */
    const oldSum = Number(/\[2\] 内部混用\s+(\d+)/.exec(r.out)![1]!) + Number(/\[3\] 带 BOM\s+(\d+)/.exec(r.out)![1]!);
    const injectedOut = r.out.replace(/高危项合计 (\d+)/, `高危项合计 ${oldSum}`);
    eq(eolBadVerdict(injectedOut).ok, false, '负对照:旧公式([2]+[3])必须被判据打红(证明它真的在读 [1])');
    /* ★ 反向注入:源码里的 `+ pureCrlf.length` 删掉 ⇒ 旧形态复现 */
    eq(/const bad = mixed\.length \+ bom\.length \+ pureCrlf\.length;/.test(EOL_SRC), true,
      'bad 必须显式含 pureCrlf.length(那一行是这条判据的锚)');
  } finally { t.drop(); }
});

test('FND112-14 dead_items:reason 非空 + consumer 必须指向**真实存在**的文件', () => {
  /* 反例(旧自检全部放过) */
  ok(reasonVerdict('') !== null, '空 reason 必须不合格(旧自检只看 implemented/consumer 的形状)');
  ok(reasonVerdict('TODO') !== null, 'TODO 占位必须不合格');
  ok(reasonVerdict('待办') !== null, '「待办」必须不合格');
  ok(consumerVerdict('see room.ts') !== null, '指向不存在文件的 consumer 必须不合格(过度声称)');
  ok(consumerVerdict('') !== null, '空串 consumer 必须不合格(要么写清,要么按约定写 null)');
  /* 正例 */
  eq(consumerVerdict(null), null, '未实装时按约定为 null ⇒ 合法');
  eq(consumerVerdict('server/src/sim/world_sim.ts:1'), null, '指向真实文件 ⇒ 合法');
  eq(reasonVerdict('使用入口已接(featherRevive),仍缺:投掷弹道与落点判定'), null,
    '写清「缺什么」的长理由 ⇒ 合法');
  /* 真表必须全部合格(否则 scripts/dead_items.ts 自己会 exit 1) */
  for (const d of DEAD_ITEMS) {
    eq(reasonVerdict(d.reason), null, `${d.id} ${d.name} 的 reason`);
    eq(consumerVerdict(d.consumer), null, `${d.id} ${d.name} 的 consumer`);
  }
  eq(DEAD_ITEMS.length > 0, true, '登记表不许是空的(空表会让上面那个 for 变成零次循环)');
});

/* 注入用的临时目录一律 `os.tmpdir()` + `finally rmSync`;
   另:本文件**一次也不 import** scripts/verify.ts —— 那个 import 会带来进程递归。 */
report('WS-FND-112');
