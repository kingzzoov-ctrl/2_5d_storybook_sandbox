/**
 * WS-FND-74 —— **门禁自身**的四道欠账(档 2 第 5/6 组)的判据。
 *
 * ## 本套件为什么存在
 *
 * 依据 `docs/BACKLOG-108-TRIAGE.md` §3 第 6 组 + `docs/RULINGS-DRAFT.md` §4.4,
 * 本轮修了 `scripts/verify.ts` 四处**门禁自己**的欠账:
 *
 * | 修的东西 | 判据在 verify.ts | 本套件钉什么 |
 * | :--- | :--- | :--- |
 * | 同义反复扫描只覆盖第二实参 | `scanAssertionArgs` / `detectTautologyHits` | 全实参 × 5 形态都有区分力 |
 * | 两白名单互不说话 | `findWhitelistCrossViolations` | 可达×孤儿、缺标注、墓碑、同义反复×不可达 |
 * | `resolveImport` 从未复核 | `findResolveImportViolations` | 扩展名补全 / 上溯 / 目录 index / 非相对 / 目录伪装 |
 * | 硬编码 320 | `scripts/items-baseline.ts` 的 `diffItemCounts` | 基线差可报、两方向都报、自身不自洽也报 |
 * | PERF U3 三条 `not-in-manual` | `PERF_TAG_DEMOTED` / `findPerfTagViolations` | 标签表双向对账 |
 * | 动态 `import()` 不跟踪 | `findDynamicImports` | 字面量/非字面量/`import.meta`/注释字符串 |
 *
 * ## 一条硬纪律:**期望值全部手写**
 *
 * 本套件**不**从被测模块取任何期望值 —— 不从 `ASSERTION_FORMS` 读数当期望,
 * 不从 `PERF_TAG_DEMOTED` 读 id 当期望,连真值表里的路径都写成字面量。
 * 理由:用被测对象的输出验证被测对象,与这道门禁要防的「同义反复」同形。
 *
 * ## 每条断言都能变红
 *
 * 每个 `ok/eq` 上方都写明「它怎么变红」。注入证据(改坏 ⇒ 红 ⇒ 字节写回 ⇒ SHA256 一致)
 * 记录在交付报告里,不在本文件 —— 因为本文件是**判据**,不是**执行记录**。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  maskSource,
  splitTopLevelArgs,
  scanAssertionArgs,
  detectTautologyHits,
  findWhitelistCrossViolations,
  findResolveImportViolations,
  resolveImport,
  parseNotInManualIds,
  findPerfTagViolations,
  PERF_TAG_DEMOTED,
  CROSS_ANNOTATION,
} from '../scripts/verify.ts';
import { findDynamicImports } from '../scripts/imports.ts';
import {
  diffItemCounts,
  measureItemCounts,
  readItemBaseline,
  type ItemCounts,
} from '../scripts/items-baseline.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 手写的小工具:把「局部名 → 定义模块」做成 Map,期望值全在调用点写死。 */
const modMap = (pairs: [string, string][]): Map<string, string> => new Map(pairs);
const exportMap = (pairs: [string, string][]): Map<string, string> => new Map(pairs);

/* ═════════════ 1. 源码掩码与实参切分(判据的地基)═════════════ */

test('FND74-1 maskSource 抹掉注释与字符串**内容**,但长度与行号不变', () => {
  const src = [
    'const a = 1; /* 多行',
    '注释 */ eq(x, FOO);',
    "eq(y, '字符串里的 eq(z, BAR)');",
  ].join('\n');
  const masked = maskSource(src);
  /* 怎么变红:改成「整段替换成空格」⇒ 长度变 ⇒ 下面第一条红;
     改成不抹字符串 ⇒ 第 3 行里仍有 BAR ⇒ 第二条红。 */
  eq(masked.length, src.length, 'maskSource 必须保持长度(它靠下标定位行号)');
  ok(masked.includes('FOO'), '真代码里的标识符必须**保留**');
  ok(!masked.includes('BAR'), '字符串内容必须被抹掉(否则会造出幻影断言)');
  ok(!masked.includes('多行'), '注释内容必须被抹掉');
  eq(masked.split('\n').length, 3, '换行必须原样保留(行号不偏)');
});

test('FND74-2 scanAssertionArgs 覆盖 5 种形态,且行号在跨行块注释之后仍然正确', () => {
  const src = [
    '/* 第 1 行 */',
    '/* 第 2',
    '   行 */',
    'eq(a, B, "m");',                 // 第 4 行
    'near(c, D, E, "m");',            // 第 5 行
    'inRange(f, G, H, "m");',         // 第 6 行
    'includes(i, J, "m");',           // 第 7 行
    'ok(K, "m");',                    // 第 8 行
  ].join('\n');
  const refs = scanAssertionArgs(src);
  /* 怎么变红:任何形态漏登记 ⇒ 该形态的槽位角色缺失(下面逐个查)。 */
  const byLine = new Map<number, string[]>();
  for (const r of refs) {
    const list = byLine.get(r.line) ?? [];
    list.push(`${r.role}:${r.expr}`);
    byLine.set(r.line, list);
  }
  /* ⚠️ 消息实参在掩码后是 `" "`(引号保留、内容抹成空格)—— 这正是"字符串不可能被误认成
     裸标识符"的实现方式,所以期望值就写 `msg:" "`。 */
  eq((byLine.get(4) ?? []).join('|'), 'actual:a|expected:B|msg:" "', 'eq 三槽位 + 第 4 行(注释不吞行号)');
  eq((byLine.get(5) ?? []).join('|'), 'actual:c|expected:D|eps:E|msg:" "', 'near 的四参(含**第 3 参** eps)');
  eq((byLine.get(6) ?? []).join('|'), 'actual:f|lo:G|hi:H|msg:" "', 'inRange 含上下界');
  eq((byLine.get(7) ?? []).join('|'), 'actual:i|expected:J|msg:" "', 'includes 两参');
  eq((byLine.get(8) ?? []).join('|'), 'cond:K|msg:" "', 'ok 的表达式槽位');
});

test('FND74-3 splitTopLevelArgs 真值表(嵌套调用 / 字符串里的逗号 / 未配平)', () => {
  const at = (s: string): string[] => {
    const open = s.indexOf('(');
    return splitTopLevelArgs(s, open);
  };
  /* 怎么变红:回退到「遇第一个逗号即停」⇒ 第 2/3 条红。 */
  eq(at("eq(a, b)").join('|'), 'a|b');
  eq(at("eq(compute(320, SLOTS, 1).rows, 21, 'm')").join('|'), 'compute(320, SLOTS, 1).rows|21|\'m\'',
    '内层逗号不得切断顶层实参');
  eq(at("eq(x, 'a,b', 'm')").join('|'), "x|'a,b'|'m'", '字符串里的逗号不切断');
  eq(at('eq(a, [1, 2], f(3, 4))').join('|'), 'a|[1, 2]|f(3, 4)', '方括号与内层括号都不切断');
  eq(at('eq(a, b').length, 0, '括号不配平 ⇒ 一个实参都不给(宁可漏报,不要把整段当实参)');
});

/* ═════════════ 2. 同义反复:全实参覆盖的区分力 ═════════════ */

const SUITE_SRC = [
  "import { FOO, BAR } from '../mod.ts';",   // 第 1 行(import 行不得产出命中)
  'eq(x, FOO);',                             // 第 2 行:真同义反复
  'eq(FOO, 16);',                            // 第 3 行:正确写法(锚点)
  'near(v, 1, TOL);',                       // 第 4 行:容差取自模块
  'inRange(w, LO, HI);',                     // 第 5 行:上下界取自模块
  'ok(FLAG);',                               // 第 6 行:断言常量本身为真
  'ok(FLAG > 0);',                           // 第 7 行:有字面量锚点 ⇒ 不算
  'eq(A2, B2);',                             // 第 8 行:双端同源
  "eq(z, 'FOO');",                           // 第 9 行:字符串不是常量引用
  "eq(y, 1, 'text: eq(y2, FOO)');",          // 第 10 行:消息里的假断言
].join('\n');

const SUITE_NAMES = modMap([
  ['FOO', 'mod.ts'], ['BAR', 'mod.ts'], ['TOL', 'mod.ts'], ['LO', 'mod.ts'], ['HI', 'mod.ts'],
  ['FLAG', 'mod.ts'], ['A2', 'mod.ts'], ['B2', 'mod.ts'],
]);
const SUITE_EXPORTS = exportMap([
  ['mod.ts::FOO', '1'], ['mod.ts::TOL', '1e-9'], ['mod.ts::LO', '0'], ['mod.ts::HI', '100'],
  ['mod.ts::FLAG', '1'], ['mod.ts::A2', '3'], ['mod.ts::B2', '3'],
]);
const scanSuite = (): ReturnType<typeof detectTautologyHits> =>
  detectTautologyHits(SUITE_SRC, SUITE_NAMES, SUITE_EXPORTS);

test('FND74-4 真同义反复:eq(x, FOO) 命中 expected 槽位,行号正确', () => {
  const hits = scanSuite().hits.filter((h) => h.constName === 'FOO');
  /* 怎么变红:若只看第二实参的第 4 个字符……任何解析退化都会让 line/role 变。 */
  eq(hits.length, 1, 'FOO 只应有一处期望侧命中');
  eq(hits[0]!.role, 'expected');
  eq(hits[0]!.line, 2);
  eq(hits[0]!.mod, 'mod.ts');
});

test('FND74-5 不是同义反复:eq(FOO, 16) 只记锚点,不进候选', () => {
  const scan = scanSuite();
  /* 怎么变红:把 actual 侧也算候选 ⇒ anchors 变 0 / hits 多一条(L3)。 */
  const atLine3 = scan.hits.filter((h) => h.line === 3);
  eq(atLine3.length, 0, 'actual 侧的常量引用**不是**同义反复(那是本仓推荐的反写法)');
  eq(scan.anchors.filter((a) => a.line === 3).length, 1);
  eq(scan.anchors.find((a) => a.line === 3)!.role, 'actual');
});

test('FND74-6 near 的**第 3 参**(容差)取自模块 ⇒ 扩展槽位命中 eps', () => {
  const h = scanSuite().hits.find((x) => x.line === 4);
  /* 怎么变红:回退到只扫第二实参 ⇒ 这里 undefined(容差跟着实现走也不会被报)。 */
  ok(h !== undefined, 'near 的容差取自被测模块必须被看见');
  eq(h!.role, 'eps');
  eq(h!.constName, 'TOL');
});

test('FND74-7 inRange 的上下界取自模块 ⇒ lo 与 hi 两条', () => {
  const hits = scanSuite().hits.filter((x) => x.line === 5);
  eq(hits.length, 2, '上下界各一条');
  eq(hits.map((h) => h.role).sort().join('|'), 'hi|lo');
});

test('FND74-8 ok(CONST) 算候选;ok(CONST > 0) 不算(有字面量锚点)', () => {
  const scan = scanSuite();
  /* 怎么变红:按「表达式里出现常量就算」⇒ 第 7 行也会命中;完全不看 ok ⇒ 第 6 行漏。 */
  eq(scan.hits.filter((h) => h.line === 6).length, 1, 'ok(FLAG) 断的是常量自身的真值');
  eq(scan.hits.find((h) => h.line === 6)!.role, 'cond');
  eq(scan.hits.filter((h) => h.line === 7).length, 0, 'ok(FLAG > 0) 与实现无关,不算同义反复');
});

test('FND74-9 双端同源(eq(A2, B2) 两侧都是本仓常量)⇒ 标 bothSides', () => {
  const h = scanSuite().hits.find((x) => x.line === 8);
  /* 怎么变红:去掉强判据 ⇒ bothSides 恒 false。 */
  ok(h !== undefined);
  eq(h!.bothSides, true, '两侧都随常量移动 ⇒ 必然同义反复');
});

test('FND74-10 字符串/消息/import 行不造幻影命中', () => {
  const scan = scanSuite();
  /* 怎么变红:扫描跑在未掩码文本上 ⇒ 第 9/10 行各多一条。 */
  eq(scan.hits.filter((h) => h.line === 9).length, 0, '字符串里的 FOO 不是常量引用');
  eq(scan.hits.filter((h) => h.line === 10).length, 0, '消息文本里的 eq(y2, FOO) 不是断言');
  eq(scan.hits.filter((h) => h.line === 1).length, 0, 'import 行不产出命中');
  eq(scan.hits.every((h) => h.line !== 1), true);
});

/* ═════════════ 3. 两白名单交叉标注 ═════════════ */

const P = 'server/src/x.ts';
const cleanInput = (): Parameters<typeof findWhitelistCrossViolations>[0] => ({
  reachable: new Set<string>(),
  unreachableExempt: new Map([[P, '理由:传递不可达']]),
  orphan: new Map([[P, '理由:生产零引用']]),
  tautCandidates: new Map(),
  crossAnnotations: new Map([[P, '两侧口径相容:只被门禁消费']]),
});

test('FND74-11 交叉检查:干净样例必须零违反', () => {
  /* 怎么变红:R1/R2/R3 任一写错方向(把"通过"判成"违反")⇒ 这里非空。 */
  eq(findWhitelistCrossViolations(cleanInput()).length, 0);
});

test('FND74-12 交叉检查 R1:同一模块一边"可达"一边"孤儿" ⇒ 必须报', () => {
  const input = cleanInput();
  const reachable = new Set<string>([P]);
  const bad = findWhitelistCrossViolations({ ...input, reachable });
  /* 怎么变红:只看 orphan ⊆ 白名单(旧判据)⇒ 这里 0 条 ⇒ 矛盾被静默放过。 */
  eq(bad.length, 1);
  ok(bad[0]!.includes('可达'), '报错必须说清是哪一侧说它可达');
});

test('FND74-13 交叉检查 R2:两边都豁免却没有标注 / 标注已成墓碑 ⇒ 各报一条', () => {
  const noNote = cleanInput();
  noNote.crossAnnotations = new Map();
  eq(findWhitelistCrossViolations(noNote).length, 1, '缺标注必须报');

  const tombstone = cleanInput();
  /* 标注还在、两张表里的豁免都撤了 ⇒ 标注变墓碑。两张表各撤一边是两条**独立**的
     墓碑判据(orphan 侧 / 白名单侧),所以这里把两边都撤掉,期望 2 条。 */
  tombstone.orphan = new Map();
  tombstone.unreachableExempt = new Map();
  const bad = findWhitelistCrossViolations(tombstone);
  /* 怎么变红:只做单向(有→缺)检查 ⇒ 墓碑(标注还在、豁免已撤)被静默留下。 */
  eq(bad.length, 2, '标注指向的模块已不在两张表里 ⇒ 两条墓碑(orphan 与白名单各一)');
  ok(bad.every((b) => b.includes('墓碑')));
});

test('FND74-14 交叉检查 R3:同义反复候选的模块在不可达白名单里 ⇒ 两边都豁免', () => {
  const input = cleanInput();
  const tautCandidates = new Map([['WS-01::FOO', { suite: 'WS-01', mod: P, lines: [12] }]]);
  const bad = findWhitelistCrossViolations({ ...input, tautCandidates });
  /* 怎么变红:不做这条交叉 ⇒ "断言同义反复 + 模块不可达"两处豁免共存而全绿。 */
  eq(bad.length, 1);
  ok(bad[0]!.includes('WS-01::FOO'));
});

test('FND74-15 CROSS_ANNOTATION 与真实两表对得上(防"标注表自己烂掉")', () => {
  /* 这条读的是**真表**:它证明上面那三条判据在真实仓库上也是绿的。
     怎么变红:从两张表里摘掉一条已标注的模块(标注变墓碑)⇒ 报错。 */
  const bad = findWhitelistCrossViolations({
    reachable: new Set<string>(),
    unreachableExempt: new Map([...CROSS_ANNOTATION.keys()].map((k) => [k, '理由:传递不可达'])),
    orphan: new Map([...CROSS_ANNOTATION.keys()].map((k) => [k, '理由:生产零引用'])),
    tautCandidates: new Map(),
    crossAnnotations: CROSS_ANNOTATION,
  });
  eq(bad.length, 0);
  ok(CROSS_ANNOTATION.size > 0, '交叉标注表不能为空(否则本判据退化成恒真)');
});

/* ═════════════ 4. import 解析复核 ═════════════ */

test('FND74-16 resolveImport 真值表(期望值手写,含"目录伪装成 .ts")', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wsfnd74-'));
  try {
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub', 'a.ts'), 'export const A = 1;\n', 'utf8');
    writeFileSync(join(tmp, 'sub', 'index.ts'), 'export const I = 1;\n', 'utf8');
    mkdirSync(join(tmp, 'chunk.ts'));   /* ★ 名字以 .ts 结尾的**目录** */
    const from = join(tmp, 'entry.ts');
    writeFileSync(from, '\n', 'utf8');

    /* 怎么变红:去掉 `isFile()` 改回 `existsSync` ⇒ 第 5 条返回目录路径。 */
    eq(resolveImport(from, './sub/a.ts'), join(tmp, 'sub', 'a.ts'), 'a 显式扩展名');
    eq(resolveImport(from, './sub/a'), join(tmp, 'sub', 'a.ts'), 'b 补全 .ts');
    eq(resolveImport(from, './sub'), join(tmp, 'sub', 'index.ts'), 'c 目录 index.ts');
    eq(resolveImport(from, './nope.ts'), null, 'd 不存在(带扩展名)');
    eq(resolveImport(from, './chunk.ts'), null, 'e 目录伪装成 .ts ⇒ 必须 null(旧实现会把它当模块)');
    eq(resolveImport(from, 'node:fs'), null, 'f 非相对说明符(包名)');
    eq(resolveImport(from, '@shared/x.ts'), null, 'g 非相对说明符(别名;本仓无 paths)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('FND74-17 真实仓库上 import 解析判据 0 违反(夹具 / tsconfig 无别名)', () => {
  const bad = findResolveImportViolations(ROOT);
  /* 怎么变红:给 tsconfig 加 `paths`,或删掉夹具脚本 ⇒ 都会让这里非空。 */
  eq(bad.length, 0, `期望 0 违反,实际:${bad.slice(0, 3).join('; ')}`);
});

/* ═════════════ 5. 动态 import 边界 ═════════════ */

test('FND74-18 findDynamicImports 区分字面量/非字面量/import.meta/注释/字符串', () => {
  const src = [
    "await import('./a.ts');",           // 1 字面量
    "await import(`./b.ts`);",           // 2 字面量(模板串)
    'await import(name);',               // 3 非字面量 ← 边界
    'const m = import.meta.url;',        // 4 不是导入
    "// 注释里的 import('./c.ts')",       // 5 不算
    "eq(x, 'import(y)');",               // 6 字符串里,不算
    'ok(true, "import() 这个词本身");',   // 7 字符串里的 import(),不算
    /* 8 正则里的引号会让扫描器的"引号状态"错位(实测:WS-FND-01 的消息文本里就是这么被骗的)
       ⇒ 紧邻的第 9 行那个 `'…import()…'` 会被当成**代码态**。 */
    String.raw`const re = /import\(\s*['"][^'"]*x\.ts['"]\s*\)/.test(s);`,
    "ok(re, '以动态 import() 引用 x.ts');",   // 9 错位后的伪命中 —— 必须被空实参过滤挡掉
  ].join('\n');
  const sites = findDynamicImports(src);
  /* 怎么变红:
     · 去掉空实参 `import()` 过滤 ⇒ 第 9 行冒出一条"非字面量"(实测踩过的那个伪命中);
     · 不跳过注释/字符串 ⇒ 第 5/6/7 行多出来;
     · 把非字面量也当字面量 ⇒ 第 3 行的 literal 翻成 true。 */
  eq(sites.length, 3, '只有 3 处真动态导入');
  eq(sites.map((s) => `${s.line}:${String(s.literal)}`).join('|'), '1:true|2:true|3:false');
  ok(sites.every((s) => s.line !== 9), '`import()` 空实参在 TS 里不合法 ⇒ 只能是引号状态错位造出的伪命中');
  ok(sites.every((s) => s.line !== 4), 'import.meta 不是导入');
  /* ★ 单元级判据:空实参 `import()` **不是导入**。
     怎么变红:去掉 `dq !== ')'` 过滤 ⇒ 这两条立刻变 1(实测在 `tests/WS-FND-01.test.ts`
     上就是这么冒出一条伪命中的)。这条断言是那次实测的**最小复现**,
     比构造一整个"引号状态错位"的长样例更难造假。 */
  eq(findDynamicImports('import();').length, 0, '空实参 import() 不是导入');
  eq(findDynamicImports('await import();\n').length, 0);
});

/* ═════════════ 6. PERF U3 标签 + 内容基线 ═════════════ */

test('FND74-19 PERF 标签表与源码**双向**对账', () => {
  const fake = [
    'add({',
    "    id: 'C3',",
    "    verdict: 'not-in-manual',",
    '  });',
    'add({',
    "    id: 'C9',",
    "    verdict: 'not-in-manual',",
    '  });',
    'add({',
    "    id: 'C10',",
    "    verdict: 'unknown',",
    '  });',
  ].join('\n');
  /* 怎么变红:把 C3 从标签表删掉 ⇒ "源码新增未登记"那条红;把 C9 加进标签表 ⇒ 反之。 */
  eq(parseNotInManualIds(fake).join('|'), 'C3|C9', '只认 verdict=not-in-manual 的 add 块');
  const bad = findPerfTagViolations(fake);
  ok(bad.some((b) => b.includes('C9')), '源码有而未登记 ⇒ 报');
  ok(bad.some((b) => b.includes('C7')), '标签表有而源码没有 ⇒ 也报(防墓碑)');
  eq(PERF_TAG_DEMOTED.map(([id]) => id).join('|'), 'C3|C7|C8', '标签就是这三条,不许多不许少');
});

test('FND74-20 内容基线:两个方向都报,且"基线自身不自洽"也报', () => {
  const mk = (itemCount: number, sum: number, t: Record<string, { count: number; ids: number }>): ItemCounts =>
    ({ itemCount, tableCount: Object.keys(t).length, tableSum: sum, tables: t });
  const base = mk(320, 320, { '3.1': { count: 30, ids: 30 } });
  /* 怎么变红:只比总数不比分表 ⇒ 第 2 条红;只报"不一致"不给方向 ⇒ 第 1 条里的 `+` 缺。 */
  eq(diffItemCounts(base, mk(330, 320, { '3.1': { count: 30, ids: 30 } })).length, 1);
  ok(diffItemCounts(base, mk(330, 320, { '3.1': { count: 30, ids: 30 } }))[0]!.includes('+10'),
    '差多少、往哪个方向,必须写在输出里');
  eq(diffItemCounts(base, mk(320, 320, { '3.1': { count: 30, ids: 29 } })).length, 1, '分表条目数也要比');
  ok(diffItemCounts(base, mk(320, 320, { '3.1': { count: 31, ids: 30 } })).some((d) => d.includes('count')),
    '手册声明数(count)与实测不符也要报');
  const broken = mk(320, 999, { '3.1': { count: 30, ids: 30 } });
  eq(diffItemCounts(broken, broken).length, 1, '基线文件自身不自洽(合计≠总数)必须报');
  /* 真实文件:内容没动过 ⇒ 与实测零差。怎么变红:改 items.ts 的内容数而不跑 --update。 */
  const real = readItemBaseline();
  ok(real !== null, 'scripts/items-baseline.json 必须存在(否则门禁那一道直接 fail)');
  eq(diffItemCounts(real!, measureItemCounts()).length, 0);
});

/* ═════════════ 7. 接线判据:四道新门禁真的被 main 调用 ═════════════ */

test('FND74-21 verify.ts 的 main 里确实调用了四道新检查(防"写了没接")', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8');
  /* 怎么变红:删掉任一调用点(或把它挪到 `if (import.meta.main)` 之外)⇒ 该条红。
     ⚠️ 文本判据在这里是**恰当**手段:它测的是"调用点存在"这件事,
        import 这个模块不会告诉我 main 里排了什么。 */
  for (const call of ['checkResolveImport();', 'checkWhitelistCross();', 'checkPerfTagDemotions();', 'checkDynamicImportBoundary();']) {
    ok(src.includes(call), `main 里缺少调用:${call}`);
  }
  /* 顺序判据:交叉检查要在可达性/同义反复**之后**(否则读到 null ⇒ 该道 fail)。 */
  const at = (s: string): number => src.indexOf(s);
  ok(at('checkReachability();') < at('checkWhitelistCross();'), '交叉检查必须在可达性之后');
  ok(at('checkTautology();') < at('checkWhitelistCross();'), '交叉检查必须在同义反复之后');
  ok(at('checkResolveImport();') < at('checkReachability();'), 'import 解析自检必须在可达性之前(地基先行)');
});

report('WS-FND-74');