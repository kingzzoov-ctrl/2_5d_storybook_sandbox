/**
 * 导出覆盖矩阵 —— **工具 + 台账**(第十轮「导出覆盖矩阵」落进仓的那一件)。
 *
 * ## 这个工具要解决的病
 *
 * ```text
 * 上一轮把 server/src 的 2290 个导出分成三档,结论只活在一台机器的 scratch 里。
 * ⇒ 「覆盖如何」这个事实**没有可复算的来源**:
 *    · 数字是抄件,谁都不许再算一遍(算出来也对不上,因为口径没落到代码里);
 *    · 新加一个导出**不会**让任何东西绿→红 ⇒ 欠账只增不减,且无人知道增了。
 * ⇒ 故本文件的产物不是「一份报告」,而是 **口径(判据)+ 台账(可被 --check 比对)**。
 * ```
 *
 * ## 三档判据(机械、可复算;**不含"猜"**)
 *
 * 对 `server/src/**` 的每个导出符号 `S`,在 `tests/*.test.ts` 里找它的出现位置。
 * 每个出现位置先被分成两类(靠**掩码**判定,不靠语义):
 *
 * ```text
 * code    = 该标识符出现在**代码位**(掩码后仍在)
 * literal = 该标识符出现在**字符串字面量或正则字面量**里
 *          (注释里的出现**两者都不算** —— 掩码把它抹掉了)
 * ```
 *
 * 然后按下表定档(**先命中即定档**,优先级从上到下):
 *
 * ```text
 * ┬ behavior     ∃ 一个 code 出现,且满足:
 * │                B1 同一行(掩码后)含断言调用 eq( / ok( / near( / inRange( / throws
 * │              ∨ B2 该出现落在某个 test( ... ) 用例体内,且该用例体内**同行或其后的行**
 * │                   含断言调用
 * │              ⚠️ B2 是必要的:B1 漏掉最普通的写法
 * │                 `const r = foo(1);` 换行 `eq(r, 2);`
 * ├ symbol-only  ∃ 一个 literal 出现,且该行(去注释、留字符串)含**取文本的实参**:
 * │                .includes( / readCode( / .test( / .exec( / .match( / .search( /
 * │                .startsWith( / .endsWith( / .split( / .replace(
 * │              ⇒ 即:符号名只是被**当成文本来比对**,没有被调用
 * └ none         其余(含:只在注释里出现;只在字符串里出现但该行**不是**取文本的实参
 *                —— 后者不计为 symbol-only,因为它不构成"用文本核对这个符号"的证据)
 * ```
 *
 * ### 边界(写在代码里,也写在输出里 —— 不假装无边界)
 *
 * ```text
 * 1 B2 是**上界**:用例体内出现过名字 + 后面有断言,不等于断言的就是它的行为。
 *   例:`const c: Clock = ...; eq(c.now(), 1);` 里 Clock 只用作类型标注 ⇒ 记 behavior。
 *   故台账把 kind 逐行标出:对 type 导出,behavior 的语义是「在测试代码里被引用(类型位)」,
 *   类型没有可断言的运行时行为 —— 这一档**不是**"证明了行为"。
 * 2 名字统计是**按名字**的:跨模块同名(shared 的 clamp / MAX_LEVEL 这类)会串台。
 *   生产引用数因此是**上界**,不是引用图。
 * 3 一处 `export const a = 1, b = 2` 只登记 a(单声明符口径);
 *   匿名 `export default {}` 不登记(没有名字可登记)。
 * 4 barrel 只解析**一层**(index.ts 的 `export ... from` / `export *` 折回定义文件)。
 * ```
 *
 * ## 用法
 *
 * ```bash
 * node scripts/coverage-matrix.ts                 # 可读表(人读)
 * node scripts/coverage-matrix.ts --json          # 机读:整份 MatrixReport
 * node scripts/coverage-matrix.ts --check         # 比对台账 docs/COVERAGE-MATRIX.md;不一致 exit 1
 * node scripts/coverage-matrix.ts --write         # 重写台账里的三块生成段(保留人填的状态列)
 * node scripts/coverage-matrix.ts --root=<dir> --tests=<dir> --ledger=<path>   # 测试用:换根
 * ```
 *
 * ## 台账三块(其余部分是人写的口径与结论,`--write` 不碰)
 *
 * ```text
 * STATS  三档统计(可被算出来的数 ⇒ 台账只许是抄件,正解在工具里)
 * CENSUS 导出普查(逐行 file | kind | tier | 名字...) —— 这是「新增/消失的导出必须红」的载体
 * ROWS   待处置清单(状态列**由人填**:待补 / 已补(判据名) / 无需(理由))
 * ```
 *
 * ⚠️ `--check` 只校验两件事:**清单与实测一致**、**状态列写法合法**。
 *    它**不判断**你填 `无需(理由)` 的理由对不对 —— 那要求推断意图,属本仓分水岭的另一侧。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

/* ═══════════════════════════ 0 类型 ═══════════════════════════ */

/** 三档。顺序即优先级(`behavior` 先命中即定档)。 */
export type Tier = 'behavior' | 'symbol-only' | 'none';
/** 导出种类。`type` 没有可断言的运行时行为 —— 台账逐行标出,不与 `value` 混算。 */
export type ExportKind = 'value' | 'type';

export const TIERS: readonly Tier[] = ['behavior', 'symbol-only', 'none'];

export interface ExportEntry {
  file: string;
  name: string;
  kind: ExportKind;
  tier: Tier;
  /** 生产侧(`server/src` + `shared` + `client/src`)按名字的出现次数,**不含定义文件自身**。 */
  prodRefs: number;
  /** 判据证据(`tests/x.test.ts:123 同行断言` 之类)。`none` 为空。 */
  evidence: string[];
}

export interface ActionableRow {
  file: string;
  name: string;
  kind: ExportKind;
  tier: Tier;
  prodRefs: number;
}

export interface MatrixReport {
  root: string;
  /** 枚举到的文件数(**自证分母**:0 个文件时后面每个数都无意义)。 */
  srcFiles: number;
  testFiles: number;
  totals: {
    exports: number;
    behavior: number;
    symbolOnly: number;
    none: number;
    noneWithProdRef: number;
    noneWithoutProdRef: number;
  };
  byKind: Record<ExportKind, Record<Tier, number>>;
  exports: ExportEntry[];
  /** 待处置清单 = `symbol-only` ∪ (`none` ∧ 生产引用 > 0)。 */
  actionable: ActionableRow[];
  /** 普查行(台账 CENSUS 块的**唯一**来源)。 */
  census: string[];
}

/* ═══════════════════ 1 掩码:把「代码位」与「字面量位」分开 ═══════════════════ */

export interface LiteralSpan {
  start: number;
  end: number;
  kind: 'string' | 'regex';
}

export interface SourceView {
  /** 注释与字面量内容全部换成空格(等长、保留换行)⇒ 位置与原文一一对应。 */
  code: string;
  /** 只剥注释,字符串/正则**原样保留**(找"这一行是不是取文本的实参"要用它)。 */
  keepStrings: string;
  literals: LiteralSpan[];
  lineStarts: number[];
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
/** 前一个有效字符若是这些,则 `／` 是除号/注释起点,不是正则起点。 */
const REGEX_PREV = /[A-Za-z0-9_$)\]}"'`.]/;

/**
 * 一次扫描同时产出三样东西:`code`(剥注释+字面量)、`keepStrings`(剥注释)、字面量区间。
 *
 * ⚠️ **为什么不能只做一种**:两个判据的需求相反 ——
 *    找标识符必须抹掉字符串(否则 `'Foo'` 会冒充"调用了 Foo");
 *    判"是不是取文本的实参"又必须**看见**字符串(否则 `src.includes('Foo')` 看不见)。
 *    ⇒ 一次扫描三份产出,避免两套剥法(本仓陷阱 31/41:两份实现必然分叉)。
 *
 * ⚠️ 正则字面量的识别靠「前一个有效字符」:`= /x/.test(s)`(正则) vs `a / b`(除号)。
 *    这是**够用的近似**,不是 tokenizer:除法写在与 `(`/`,` 相邻处的罕见形态会被误判成
 *    正则起点(上一轮 symonly3 就栽在相反方向 —— 把正则的引号当成字符串起始,报了 400 条假阳性)。
 *    本仓既有做法一致:近似 + 把边界写进注释与输出。
 */
export function maskCommentsAndStrings(src: string): SourceView {
  const n = src.length;
  const code = src.split('');
  const keep = src.split('');
  const literals: LiteralSpan[] = [];
  /* ⚠️ 行首偏移**单独一遍**(见 `lineStartsOf` 的长注释:复用本循环会漏掉注释/字面量里的换行)。 */
  let i = 0;
  /* 前一个**有效**(非空白)字符:用来区分 `/` 是正则起点还是除号。 */
  let prev = '';
  const blankCode = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (src[k] !== '\n') code[k] = ' ';
  };
  const blankBoth = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (src[k] !== '\n') { code[k] = ' '; keep[k] = ' '; }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blankBoth(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blankBoth(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        j += 1;
      }
      literals.push({ start: i, end: j, kind: 'string' });
      blankCode(i, j);
      i = j;
      prev = "'";
      continue;
    }
    if (c === '/' && !REGEX_PREV.test(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') { j += 2; continue; }
        if (e === '[') inClass = true;
        else if (e === ']') inClass = false;
        else if (e === '/' && !inClass) { closed = true; j += 1; break; }
        else if (e === '\n') break;
        j += 1;
      }
      /* 未闭合 ⇒ 不是正则(多半是除号)⇒ 原样放行,不登记 span */
      if (closed) {
        literals.push({ start: i, end: j, kind: 'regex' });
        blankCode(i, j);
        i = j;
        prev = 'x';
        continue;
      }
    }
    /* 行号在循环外单独算 ⇒ 这里只更新「前一个有效字符」 */
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { code: code.join(''), keepStrings: keep.join(''), literals, lineStarts: lineStartsOf(src) };
}

/** 偏移 → 行号(0 基)。二分,给"这个出现落在哪一行"用。 */
function lineOf(lineStarts: number[], at: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const IDENT_ALL = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/* ═══════════════════ 2 枚举导出(Barrel 只解析一层)═══════════════════ */

interface Decl { name: string; kind: ExportKind }
interface ReExport { name: string; spec: string; kind: ExportKind }
interface FileDecls { rel: string; locals: Decl[]; reexports: ReExport[]; stars: string[] }

/** 声明前的修饰词(`export default function f` 里 `default` 要跳过)。 */
const MODIFIERS = new Set(['abstract', 'declare', 'async', 'default']);

function skipSpace(s: string, at: number): number {
  let i = at;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

/**
 * 全量行首偏移(单独一遍,**不复用掩码循环里的计数**)。
 *
 * ⚠️ 这是一条**实测踩到的**修正:第一版在掩码循环里顺手 `push(i+1)`,而注释/字符串/正则
 *    分支都是 `i = j; continue` —— **跳过的区间里的换行从没被记过**。
 *    后果:凡带块注释的文件(本仓每个文件都有),`lineOf()` 返回的行号都**偏小**,
 *    而"某行有没有断言"用的是 `split('\n')` 的真实行号 ⇒ 两边错位,
 *    于是 `ok(!world.includes('gatePrank('))` 这种一目了然的 symbol-only 被判成 `none`。
 *    ⇒ 判据:凡是"两种行号来源"并存的地方,必须只有**一个**来源。
 */
function lineStartsOf(src: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') out.push(i + 1);
  return out;
}

/** 取 `from '<spec>'` 里的 spec:从 `fromPos` 起第一段**字符串字面量**。 */
function specAfter(src: string, code: string, literals: LiteralSpan[], fromPos: number): string | null {
  for (const sp of literals) {
    if (sp.start <= fromPos) continue;
    if (sp.kind !== 'string') continue;
    const between = code.slice(fromPos, sp.start);
    /* 语句已结束(逗号/分号/换行后的新语句)⇒ 不是这段的说明符 */
    if (/[,;]/.test(between)) return null;
    if (!/\bfrom\b/.test(between)) return null;
    return src.slice(sp.start + 1, sp.end - 1);
  }
  return null;
}

/**
 * 解析一个文件的导出声明。
 *
 * ⚠️ 在**掩码文本**上找 `export` —— 这条不是洁癖:注释里写 `export function foo` 的
 *    示例代码会被当成真导出(本仓踩过多次)。命名在掩码块之后**紧邻**调用
 *    也是刻意:`judgement_audit` 的 D 类检测器按 ±10 行窗口判"有没有先剥注释"。
 */
export function parseExportDecls(rel: string, src: string): FileDecls {
  const view = maskCommentsAndStrings(src);
  const code = view.code;
  const out: FileDecls = { rel, locals: [], reexports: [], stars: [] };
  for (const m of code.matchAll(/(?:^|[^A-Za-z0-9_$.])export\b/g)) {
    const at = m.index + m[0].length;
    let p = skipSpace(code, at);
    let hadDefault = false;
    for (let guard = 0; guard < 3; guard += 1) {
      const w = IDENT_RE.exec(code.slice(p));
      if (w === null) break;
      if (!MODIFIERS.has(w[0])) break;
      if (w[0] === 'default') hadDefault = true;
      p = skipSpace(code, p + w[0].length);
    }
    /* 具名块:`export { a, b } [from '...']` —— `export type { ... }` 走同一分支 */
    let namedAt = p;
    let namedKind: ExportKind = 'value';
    if (code.startsWith('{', p) && hadDefault) continue; /* 匿名 `export default {` */
    if (code.startsWith('type', p) && !/^type[A-Za-z0-9_$]/.test(code.slice(p + 4))) {
      const p2 = skipSpace(code, p + 4);
      if (code.startsWith('{', p2)) { namedAt = p2; namedKind = 'type'; } else namedAt = p;
    }
    if (code.startsWith('{', namedAt)) {
      const close = code.indexOf('}', namedAt);
      if (close < 0) continue;
      const body = code.slice(namedAt + 1, close);
      const spec = specAfter(src, code, view.literals, close + 1);
      const items = body.split(',').map((x) => x.trim()).filter((x) => x !== '');
      for (const item of items) {
        const cleaned = item.replace(/^type\s+/, '');
        const parts = cleaned.split(/\s+as\s+/);
        const name = parts[parts.length - 1].trim();
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
        if (spec === null) {
          /* 没有 from ⇒ 把本文件已声明的名字再导出一次(别名):不新增条目,只登记别名 */
          continue;
        }
        out.reexports.push({ name, spec, kind: namedKind });
      }
      continue;
    }
    /* 星号:`export * from '...'` / `export * as ns from '...'` */
    if (code.startsWith('*', p)) {
      let q = skipSpace(code, p + 1);
      const asTok = IDENT_RE.exec(code.slice(q));
      let alias: string | null = null;
      if (asTok !== null && asTok[0] === 'as') {
        const nameAt = skipSpace(code, q + 2);
        const nm = IDENT_RE.exec(code.slice(nameAt));
        if (nm !== null) { alias = nm[0]; q = skipSpace(code, nameAt + nm[0].length); }
      }
      const spec = specAfter(src, code, view.literals, q);
      if (spec === null) continue;
      if (alias !== null) out.reexports.push({ name: alias, spec, kind: 'value' });
      else out.stars.push(spec);
      continue;
    }
    /* 声明:`export [default] function|class|const|let|var|interface|type NAME` */
    const head = IDENT_RE.exec(code.slice(p));
    if (head === null) continue;
    const kw = head[0];
    const after = skipSpace(code, p + kw.length);
    if (kw === 'type') {
      const nm = IDENT_RE.exec(code.slice(after));
      if (nm !== null) out.locals.push({ name: nm[0], kind: 'type' });
      continue;
    }
    if (kw === 'function') {
      let q = after;
      if (code[q] === '*') q = skipSpace(code, q + 1);
      const nm = IDENT_RE.exec(code.slice(q));
      if (nm !== null) out.locals.push({ name: nm[0], kind: 'value' });
      continue;
    }
    if (kw === 'class' || kw === 'const' || kw === 'let' || kw === 'var' || kw === 'interface') {
      const nm = IDENT_RE.exec(code.slice(after));
      if (nm !== null) out.locals.push({ name: nm[0], kind: kw === 'interface' ? 'type' : 'value' });
      continue;
    }
    /* 其余(`export default <expr>` / `export =` / `export import`)不登记 */
  }
  return out;
}

function walkTs(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkTs(p, out);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const toRel = (root: string, p: string): string => relative(root, p).split('\\').join('/');

/** 把 `./x.ts` / `../y` 这类说明符解析成仓库相对路径(仅相对说明符;裸包名返回 null)。 */
function resolveSpec(fromRel: string, spec: string, exists: (rel: string) => boolean): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromRel), spec).split('\\').join('/');
  const cands = base.endsWith('.ts') ? [base] : [`${base}.ts`, `${base}/index.ts`];
  for (const c of cands) if (exists(c)) return c;
  return null;
}

/* ═══════════════════ 3 tests 索引(出现位置 / 断言 / 用例体)═══════════════════ */

interface Occ { rel: string; line: number; where: 'code' | 'literal'; body: number }

interface TestsIndex {
  files: number;
  /** 名字 → 出现位置 */
  occ: Map<string, Occ[]>;
  /** `${rel}:${line}` → 该行(掩码后)含断言调用 */
  assertLines: Set<string>;
  /** `${rel}:${line}` → 该行(去注释留字符串)含"取文本的实参" */
  probeLines: Set<string>;
  /** `${rel}:${bodyId}` → 该用例体内的断言行号(升序) */
  assertByBody: Map<string, number[]>;
}

/** 断言调用:harness 的 `eq` / `ok` / `near` / `inRange`,以及"必须抛"的 `throws`。 */
const ASSERT_LINE = /(?:^|[^A-Za-z0-9_$.])(?:eq|ok|near|inRange|throws)\s*\(/;
/** 取文本的实参:把符号名当**文本**比对的现场(`.includes(` 等),含读文件的入口。 */
const TEXT_PROBE_LINE = /\.(?:includes|startsWith|endsWith|test|exec|match|matchAll|search|split|replace)\s*\(|(?:readCode|readText|readSource|readFileSync)\s*\(/;

/** 找出 `test( ... )` 的用例体区间(掩码后括号配对 ⇒ 字符串里的括号不会捣乱)。 */
function testBodies(code: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of code.matchAll(/(?:^|[^A-Za-z0-9_$.])test\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let j = open;
    while (j < code.length) {
      const c = code[j];
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    if (j < code.length) out.push({ start: open, end: j });
  }
  return out;
}

function indexTests(root: string, testsDir: string): TestsIndex {
  const idx: TestsIndex = {
    files: 0, occ: new Map(), assertLines: new Set(), probeLines: new Set(), assertByBody: new Map(),
  };
  const files = walkTs(testsDir, []).filter((p) => p.endsWith('.test.ts')).sort();
  for (const abs of files) {
    idx.files += 1;
    const rel = toRel(root, abs);
    const src = readFileSync(abs, 'utf8');
    const view = maskCommentsAndStrings(src);
    const code = view.code;
    const codeLines = code.split('\n');
    const keepLines = view.keepStrings.split('\n');
    /* 行级判据 */
    for (let ln = 0; ln < codeLines.length; ln += 1) {
      if (ASSERT_LINE.test(codeLines[ln])) idx.assertLines.add(`${rel}:${ln}`);
      if (TEXT_PROBE_LINE.test(keepLines[ln])) idx.probeLines.add(`${rel}:${ln}`);
    }
    /* 用例体:行 → bodyId(多个体重叠时取最内层 = 最后写入的) */
    const bodies = testBodies(code);
    const bodyOfLine = new Map<number, number>();
    bodies.forEach((b, bi) => {
      const l1 = lineOf(view.lineStarts, b.start);
      const l2 = lineOf(view.lineStarts, b.end);
      for (let ln = l1; ln <= l2; ln += 1) bodyOfLine.set(ln, bi);
    });
    const assertByBody = new Map<number, number[]>();
    for (let ln = 0; ln < codeLines.length; ln += 1) {
      const bi = bodyOfLine.get(ln);
      if (bi === undefined) continue;
      if (!idx.assertLines.has(`${rel}:${ln}`)) continue;
      const arr = assertByBody.get(bi) ?? [];
      arr.push(ln);
      assertByBody.set(bi, arr);
    }
    for (const [bi, arr] of assertByBody.entries()) idx.assertByBody.set(`${rel}:${bi}`, arr);
    /* 出现位置:代码位(掩码文本里扫)+ 字面量位(原文在 span 内扫) */
    for (const m of code.matchAll(IDENT_ALL)) {
      const at = m.index;
      const line = lineOf(view.lineStarts, at);
      const body = bodyOfLine.get(line) ?? -1;
      const arr = idx.occ.get(m[0]) ?? [];
      arr.push({ rel, line, where: 'code', body });
      idx.occ.set(m[0], arr);
    }
    for (const sp of view.literals) {
      const text = src.slice(sp.start, sp.end);
      for (const m of text.matchAll(IDENT_ALL)) {
        const at = sp.start + m.index;
        const line = lineOf(view.lineStarts, at);
        const arr = idx.occ.get(m[0]) ?? [];
        arr.push({ rel, line, where: 'literal', body: bodyOfLine.get(line) ?? -1 });
        idx.occ.set(m[0], arr);
      }
    }
  }
  return idx;
}

/* ═══════════════════ 4 生产引用(按名字计,上界)═══════════════════ */

function indexProdRefs(root: string, prodDirs: string[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const dir of prodDirs) {
    for (const abs of walkTs(dir, [])) {
      const rel = toRel(root, abs);
      const view = maskCommentsAndStrings(readFileSync(abs, 'utf8'));
      for (const m of view.code.matchAll(IDENT_ALL)) {
        let byFile = out.get(m[0]);
        if (byFile === undefined) { byFile = new Map(); out.set(m[0], byFile); }
        byFile.set(rel, (byFile.get(rel) ?? 0) + 1);
      }
    }
  }
  return out;
}

/* ═══════════════════ 5 定档 ═══════════════════ */

/**
 * 定档(`none` / `symbol-only` / `behavior`,先命中即定档)。
 *
 * ⚠️ 内部行号是 0 基,**证据里打印的是 1 基**(与全仓 `path.ts:NNN` 的读法一致 ——
 *    0 基的行号会让人拿着去编辑器里找错行,而"证据指错行"和"没有证据"一样没用)。
 */
function classify(name: string, idx: TestsIndex): { tier: Tier; evidence: string[] } {
  const list = idx.occ.get(name) ?? [];
  /* 1 behavior(优先级最高:同一符号既能被调用又被文本比对时,算"有行为判据") */
  for (const o of list) {
    if (o.where !== 'code') continue;
    const key = `${o.rel}:${o.line}`;
    if (idx.assertLines.has(key)) return { tier: 'behavior', evidence: [`${o.rel}:${o.line + 1} 同行断言`] };
  }
  for (const o of list) {
    if (o.where !== 'code' || o.body < 0) continue;
    const lines = idx.assertByBody.get(`${o.rel}:${o.body}`) ?? [];
    if (lines.some((ln) => ln >= o.line)) {
      return { tier: 'behavior', evidence: [`${o.rel}:${o.line + 1} 同用例体内后续断言`] };
    }
  }
  /* 2 symbol-only(只被当作文本比对) */
  for (const o of list) {
    if (o.where !== 'literal') continue;
    const key = `${o.rel}:${o.line}`;
    if (idx.probeLines.has(key)) {
      return { tier: 'symbol-only', evidence: [`${o.rel}:${o.line + 1} 字面量 + 取文本实参`] };
    }
  }
  /* 3 none:在测试里没有可用证据(含"只在注释里"与"只在非探针字符串里") */
  return { tier: 'none', evidence: [] };
}

/* ═══════════════════ 6 主测量 ═══════════════════ */

export interface BuildOptions {
  root: string;
  /** 默认 `<root>/server/src` */
  srcDir?: string;
  /** 默认 `<root>/tests` */
  testsDir?: string;
  /** 默认 `<root>/{server/src,shared,client/src}` */
  prodDirs?: string[];
}

export function buildMatrix(opts: BuildOptions): MatrixReport {
  const root = resolve(opts.root);
  const srcDir = opts.srcDir ?? join(root, 'server', 'src');
  const testsDir = opts.testsDir ?? join(root, 'tests');
  const prodDirs = opts.prodDirs ?? ['server/src', 'shared', 'client/src'].map((d) => join(root, d));

  const srcFiles = walkTs(srcDir, []).map((p) => toRel(root, p)).sort();
  const fileSet = new Set(srcFiles);
  const exists = (rel: string): boolean => fileSet.has(rel);

  const declsOf = new Map<string, FileDecls>();
  for (const rel of srcFiles) declsOf.set(rel, parseExportDecls(rel, readFileSync(join(root, rel), 'utf8')));

  /* 6.1 先登记**本文件声明**的导出(唯一的"真身") */
  const entries = new Map<string, ExportEntry>();
  const push = (file: string, name: string, kind: ExportKind): void => {
    const key = `${file}::${name}`;
    const old = entries.get(key);
    if (old !== undefined) { if (kind === 'value') old.kind = 'value'; return; }
    entries.set(key, { file, name, kind, tier: 'none', prodRefs: 0, evidence: [] });
  };
  for (const rel of srcFiles) {
    const own = declsOf.get(rel);
    if (own === undefined) continue; /* `Map.get` 的 undefined:显式跳过,不用 `!` 把可能性藏起来 */
    for (const d of own.locals) push(rel, d.name, d.kind);
  }

  /* 6.2 barrel:把 `export ... from` 折回定义文件(**一层**)。
     能折到"真身"的不新增条目;折不到的记在目标文件上并标注是重导出。 */
  const throughStars = (targetRel: string, name: string, depth: number): string | null => {
    const own = declsOf.get(targetRel);
    if (own === undefined) return null;
    if (own.locals.some((d) => d.name === name)) return targetRel;
    if (depth >= 3) return null;
    for (const spec of own.stars) {
      const t = resolveSpec(targetRel, spec, exists);
      if (t === null) continue;
      const hit = throughStars(t, name, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  for (const rel of srcFiles) {
    const own = declsOf.get(rel);
    if (own === undefined) continue;
    for (const rx of own.reexports) {
      const target = resolveSpec(rel, rx.spec, exists);
      if (target === null) continue; /* 指向仓外/包:不登记(不是 server/src 的导出) */
      const def = throughStars(target, rx.name, 0) ?? target;
      push(def, rx.name, rx.kind);
    }
  }

  /* 6.3 判档 */
  const tests = indexTests(root, testsDir);
  const prod = indexProdRefs(root, prodDirs);
  for (const e of entries.values()) {
    const c = classify(e.name, tests);
    e.tier = c.tier;
    e.evidence = c.evidence;
    const byFile = prod.get(e.name);
    let n = 0;
    if (byFile !== undefined) for (const [f, k] of byFile.entries()) if (f !== e.file) n += k;
    e.prodRefs = n;
  }

  const all = [...entries.values()].sort((a, b) =>
    (a.file === b.file ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.file < b.file ? -1 : 1));

  const byKind: Record<ExportKind, Record<Tier, number>> = {
    value: { behavior: 0, 'symbol-only': 0, none: 0 },
    type: { behavior: 0, 'symbol-only': 0, none: 0 },
  };
  for (const e of all) byKind[e.kind][e.tier] += 1;

  const count = (t: Tier): number => all.filter((e) => e.tier === t).length;
  const noneList = all.filter((e) => e.tier === 'none');
  const actionable: ActionableRow[] = all
    .filter((e) => e.tier === 'symbol-only' || (e.tier === 'none' && e.prodRefs > 0))
    .map((e) => ({ file: e.file, name: e.name, kind: e.kind, tier: e.tier, prodRefs: e.prodRefs }))
    .sort((a, b) => {
      const ta = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier);
      if (ta !== 0) return ta;
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

  return {
    root,
    srcFiles: srcFiles.length,
    testFiles: tests.files,
    totals: {
      exports: all.length,
      behavior: count('behavior'),
      symbolOnly: count('symbol-only'),
      none: noneList.length,
      noneWithProdRef: noneList.filter((e) => e.prodRefs > 0).length,
      noneWithoutProdRef: noneList.filter((e) => e.prodRefs === 0).length,
    },
    byKind,
    exports: all,
    actionable,
    census: censusLines(all),
  };
}

/** 普查行:`file | kind | tier | 名字...`(排序固定 ⇒ 可逐行 diff)。 */
function censusLines(entries: ExportEntry[]): string[] {
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const mark = e.kind === 'value' ? 'v' : 't';
    const key = `${e.file} | ${mark} | ${e.tier}`;
    const arr = groups.get(key) ?? [];
    arr.push(e.name);
    groups.set(key, arr);
  }
  const kindOrder = (mark: string): number => (mark === 'v' ? 0 : 1);
  return [...groups.entries()]
    .sort((a, b) => {
      const fa = a[0].split(' | ');
      const fb = b[0].split(' | ');
      if (fa[0] !== fb[0]) return fa[0] < fb[0] ? -1 : 1;
      const ka = kindOrder(fa[1]) - kindOrder(fb[1]);
      if (ka !== 0) return ka;
      return TIERS.indexOf(fa[2] as Tier) - TIERS.indexOf(fb[2] as Tier);
    })
    .map(([key, names]) => `${key} | ${names.slice().sort().join(' ')}`);
}

/* ═══════════════════ 7 台账:三块生成段 + 状态列 ═══════════════════ */

export const LEDGER_REL = 'docs/COVERAGE-MATRIX.md';

export const BLOCKS = { stats: 'STATS', census: 'CENSUS', rows: 'ROWS' } as const;

const beginMark = (name: string): string => `<!-- GEN:${name}:BEGIN -->`;
const endMark = (name: string): string => `<!-- GEN:${name}:END -->`;

export function blockOf(text: string, name: string): string | null {
  const b = beginMark(name);
  const e = endMark(name);
  const i = text.indexOf(b);
  if (i < 0) return null;
  const j = text.indexOf(e, i + b.length);
  if (j < 0) return null;
  return text.slice(i + b.length, j);
}

/**
 * 统计块(键固定 ASCII ⇒ 解析不会因中文全角空格而漂)。
 *
 * ⚠️ **`test-files` 刻意不进这一块**(只打印在可读表与 `--json` 里):
 *    它随「新增一个测试套件」而变,而那是**噪音不是漂移** ——
 *    放进比对会让任何人不加导出、只加一个套件就把台账弄红。
 *    判据源增加造成的**档位变化**由 CENSUS 逐符号抓,不需要靠这个数。
 */
export function renderStats(r: MatrixReport): string {
  return [
    `total = ${r.totals.exports}`,
    `behavior = ${r.totals.behavior}`,
    `symbol-only = ${r.totals.symbolOnly}`,
    `none = ${r.totals.none}`,
    `none-prodref-positive = ${r.totals.noneWithProdRef}`,
    `none-prodref-zero = ${r.totals.noneWithoutProdRef}`,
    `src-files = ${r.srcFiles}`,
  ].join('\n');
}

export function renderCensus(r: MatrixReport): string {
  return r.census.join('\n');
}

export const STATUS_LEGEND = '待补 / 已补(判据名) / 无需(理由)';

/** 状态列的**合法写法**(三条正则;`--check` 只校验写法,不评判理由对不对)。 */
const STATUS_FORMS: { re: RegExp; why: string }[] = [
  { re: /^待补$/, why: '待补' },
  { re: /^已补\(\S.*\)$/, why: '已补(判据名) —— 括号里必须写**哪条判据**补的' },
  { re: /^无需\(\S.*\)$/, why: '无需(理由) —— 括号里必须写**为什么不需要**' },
];

export function statusOk(status: string): boolean {
  return STATUS_FORMS.some((f) => f.re.test(status));
}

export interface LedgerRow {
  file: string;
  name: string;
  kind: string;
  tier: string;
  prodRefs: string;
  status: string;
}

export function renderRows(r: MatrixReport, statuses: Map<string, string>): string {
  const head = [
    '| # | 文件:符号 | 类型 | 生产引用 | 状态 |',
    '| --: | --- | --- | --: | --- |',
  ];
  const body = r.actionable.map((a, i) => {
    const key = `${a.file}:${a.name}`;
    const st = statuses.get(key) ?? '待补';
    return `| ${i + 1} | \`${key}\` | ${a.kind} | ${a.prodRefs} | ${st} |`;
  });
  return [...head, ...body].join('\n');
}

export function parseRows(block: string): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    /* cells[0] 是首个 `|` 之前的空串,末尾同理 ⇒ 取中间 */
    const inner = cells.slice(1, cells.length - 1);
    if (inner.length < 5) continue;
    if (/^-+$/.test(inner[0].replace(/:/g, ''))) continue;
    if (inner[0] === '#') continue;
    const loc = /^`([^`]+\.ts):([^`]+)`$/.exec(inner[1]);
    if (loc === null) continue;
    out.push({
      file: loc[1], name: loc[2], kind: inner[2], tier: '', prodRefs: inner[3], status: inner[4],
    });
  }
  return out;
}

export interface LedgerCheck {
  ok: boolean;
  problems: string[];
}

const show = (xs: string[], limit: number): string => (xs.length <= limit
  ? xs.join(' / ')
  : `${xs.slice(0, limit).join(' / ')} …(共 ${xs.length} 条)`);

/** 普查块 → `file | kind | tier` → 名字集合。 */
function parseCensus(block: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(' | ');
    if (parts.length < 4) continue;
    const key = `${parts[0].trim()} | ${parts[1].trim()} | ${parts[2].trim()}`;
    out.set(key, new Set(parts[3].trim().split(/\s+/).filter((x) => x !== '')));
  }
  return out;
}

/**
 * 台账 vs 实测。
 *
 * 三件事**只有这三件**(判据的边界写在 `docs/COVERAGE-MATRIX.md` §0):
 * ```text
 * 1 STATS 每个数 == 实测(新增/消失会同时改变 total,故这里就红一次)
 * 2 CENSUS 逐行相等(**新增的导出**与**消失的导出**在这一步被点名)
 * 3 ROWS 的 `file:name` 集合 == 实测待处置集合;每行状态列写法合法
 * ```
 * ⚠️ 顺序固定:`total` 不过是"数量对不上",CENSUS 才指名"哪一个"。两者都报 ——
 *    只报 total 的话,人会去猜是哪一个(而这正是上一轮矩阵无法复核的原因之一)。
 */
export function checkLedger(r: MatrixReport, text: string): LedgerCheck {
  const problems: string[] = [];
  /* 1 统计 */
  const statsBlock = blockOf(text, BLOCKS.stats);
  if (statsBlock === null) {
    problems.push(`台账缺少 ${BLOCKS.stats} 生成块(修法:node scripts/coverage-matrix.ts --write)`);
  } else {
    const want: Record<string, number> = {
      total: r.totals.exports,
      behavior: r.totals.behavior,
      'symbol-only': r.totals.symbolOnly,
      none: r.totals.none,
      'none-prodref-positive': r.totals.noneWithProdRef,
      'none-prodref-zero': r.totals.noneWithoutProdRef,
      'src-files': r.srcFiles,
    };
    for (const [k, v] of Object.entries(want)) {
      const m = new RegExp(`^\\s*${k.replace(/-/g, '\\-')}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(statsBlock);
      if (m === null) { problems.push(`统计块缺少 \`${k} = N\` 行(实测 ${v})`); continue; }
      if (Number(m[1]) !== v) problems.push(`统计 ${k}:台账 ${m[1]} / 实测 ${v} ⇒ 先 --write 再复核结论`);
    }
  }
  /* 2 普查 */
  const censusBlock = blockOf(text, BLOCKS.census);
  if (censusBlock === null) {
    problems.push(`台账缺少 ${BLOCKS.census} 生成块(修法:node scripts/coverage-matrix.ts --write)`);
  } else {
    const mine = parseCensus(renderCensus(r));
    const theirs = parseCensus(censusBlock);
    const added: string[] = [];
    const removed: string[] = [];
    for (const [key, names] of mine.entries()) {
      const other = theirs.get(key);
      if (other === undefined) { for (const n of names) added.push(`${key.split(' | ')[0]}:${n}(${key.split(' | ')[2]})`); continue; }
      for (const n of names) if (!other.has(n)) added.push(`${key.split(' | ')[0]}:${n}(${key.split(' | ')[2]})`);
      for (const n of other) if (!names.has(n)) removed.push(`${key.split(' | ')[0]}:${n}(${key.split(' | ')[2]})`);
    }
    for (const [key, names] of theirs.entries()) {
      if (mine.has(key)) continue;
      for (const n of names) removed.push(`${key.split(' | ')[0]}:${n}(${key.split(' | ')[2]})`);
    }
    /* 同一符号**换档**会同时落进 added(新档)与 removed(旧档)⇒ 单独指出,免得读者以为是两个符号 */
    if (added.length > 0) problems.push(`普查块比实测少(新增/换档)${added.length} 条:${show(added, 8)}`);
    if (removed.length > 0) problems.push(`普查块比实测多(已消失/换档)${removed.length} 条:${show(removed, 8)}`);
  }
  /* 3 待处置清单 + 状态列 */
  const rowsBlock = blockOf(text, BLOCKS.rows);
  if (rowsBlock === null) {
    problems.push(`台账缺少 ${BLOCKS.rows} 生成块(修法:node scripts/coverage-matrix.ts --write)`);
  } else {
    const rows = parseRows(rowsBlock);
    const mine = new Set(r.actionable.map((a) => `${a.file}:${a.name}`));
    const theirs = new Set(rows.map((x) => `${x.file}:${x.name}`));
    const missing = [...mine].filter((k) => !theirs.has(k));
    const extra = [...theirs].filter((k) => !mine.has(k));
    if (missing.length > 0) problems.push(`待处置清单漏登记 ${missing.length} 条(实测有、台账无):${show(missing, 8)}`);
    if (extra.length > 0) {
      problems.push(`待处置清单多登记 ${extra.length} 条(台账有、实测已不属待处置 —— 已补/已消失):${show(extra, 8)}`);
    }
    const bad = rows.filter((x) => !statusOk(x.status));
    if (bad.length > 0) {
      problems.push(`状态列写法非法 ${bad.length} 条(只允许 ${STATUS_LEGEND}):`
        + show(bad.map((x) => `${x.file}:${x.name}="${x.status}"`), 6));
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 把三块生成段写回台账文本(`statuses` = 从旧台账读回的人填状态)。 */
export function spliceLedger(text: string, r: MatrixReport, statuses: Map<string, string>): string {
  const put = (src: string, name: string, body: string): string => {
    const b = beginMark(name);
    const e = endMark(name);
    const i = src.indexOf(b);
    if (i < 0) throw new Error(`台账缺少 ${name} 生成块起点标记 ${b}`);
    const j = src.indexOf(e, i + b.length);
    if (j < 0) throw new Error(`台账缺少 ${name} 生成块终点标记 ${e}`);
    return `${src.slice(0, i + b.length)}\n${body}\n${src.slice(j)}`;
  };
  let out = put(text, BLOCKS.stats, renderStats(r));
  out = put(out, BLOCKS.census, renderCensus(r));
  out = put(out, BLOCKS.rows, renderRows(r, statuses));
  return out;
}

/* ═══════════════════ 8 入口 ═══════════════════ */

export interface RunOptions {
  root: string;
  ledgerPath: string;
  /** 已填状态(键 `file:name`);不给则全 `待补`。 */
  statuses?: Map<string, string>;
}

export function defaultRoot(): string {
  /* 本文件在 `<root>/scripts/` 下 ⇒ 上一级就是根。不依赖 cwd(测试要能换根)。 */
  return resolve(join(import.meta.dirname, '..'));
}

export function runCheck(opts: RunOptions): LedgerCheck & { report: MatrixReport } {
  const report = buildMatrix({ root: opts.root });
  if (!existsSync(opts.ledgerPath)) {
    return {
      ok: false,
      problems: [`台账不存在:${opts.ledgerPath}(修法:node scripts/coverage-matrix.ts --write)`],
      report,
    };
  }
  const r = checkLedger(report, readFileSync(opts.ledgerPath, 'utf8'));
  return { ok: r.ok, problems: r.problems, report };
}

export function runWrite(opts: RunOptions): { report: MatrixReport; bytes: number } {
  const report = buildMatrix({ root: opts.root });
  if (!existsSync(opts.ledgerPath)) {
    throw new Error(`台账不存在:${opts.ledgerPath} —— --write 需要三块生成段标记(不会凭空造台账)`);
  }
  const text = readFileSync(opts.ledgerPath, 'utf8');
  const rowsBlock = blockOf(text, BLOCKS.rows) ?? '';
  const statuses = opts.statuses ?? new Map(parseRows(rowsBlock).map((x) => [`${x.file}:${x.name}`, x.status]));
  const next = spliceLedger(text, report, statuses);
  writeFileSync(opts.ledgerPath, next, 'utf8');
  return { report, bytes: next.length };
}

function readableTable(r: MatrixReport): string {
  const lines: string[] = [];
  lines.push('\n══ 0 分母(自证:0 个文件时后面每个数都无意义)══');
  lines.push(`   server/src 文件 ${r.srcFiles} 个 · tests 判据源 ${r.testFiles} 个 · 导出 ${r.totals.exports} 个`);
  lines.push('\n══ 1 三档 ══');
  lines.push(`   behavior ${r.totals.behavior} · symbol-only ${r.totals.symbolOnly} · none ${r.totals.none}`);
  lines.push(`   none 里:生产引用 > 0 的 ${r.totals.noneWithProdRef} 条 · 生产引用 = 0 的 ${r.totals.noneWithoutProdRef} 条`);
  for (const k of ['value', 'type'] as ExportKind[]) {
    const t = r.byKind[k];
    lines.push(`   ${k.padEnd(5)}:behavior ${t.behavior} · symbol-only ${t['symbol-only']} · none ${t.none}`);
  }
  const symOnly = r.actionable.filter((a) => a.tier === 'symbol-only');
  lines.push(`\n══ 2 symbol-only(${symOnly.length} 条;判据 = 只被当文本比对)══`);
  for (const a of symOnly) {
    const e = r.exports.find((x) => x.file === a.file && x.name === a.name);
    lines.push(`   ${a.kind.padEnd(5)} ${a.file}:${a.name}  证据=${e === undefined ? '?' : (e.evidence[0] ?? '?')}`);
  }
  const noneRows = r.actionable.filter((a) => a.tier === 'none');
  lines.push(`\n══ 3 none 且仍被生产引用(${noneRows.length} 条;按生产引用数降序)══`);
  for (const a of noneRows.slice().sort((x, y) => y.prodRefs - x.prodRefs).slice(0, 60)) {
    lines.push(`   prod=${a.prodRefs} ${a.file}:${a.name}`);
  }
  if (noneRows.length > 60) lines.push(`   …(只列前 60 条;完整清单见 docs/COVERAGE-MATRIX.md 的 ROWS 块)`);
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const root = value('root') ?? defaultRoot();
  const ledgerPath = value('ledger') ?? join(root, LEDGER_REL);
  const asJson = argv.includes('--json');
  const check = argv.includes('--check');
  const write = argv.includes('--write');
  const extra = { srcDir: value('src'), testsDir: value('tests') };
  const build = { root, ...extra };

  if (check) {
    const r = runCheck({ root, ledgerPath });
    console.log(`台账 ${relative(root, ledgerPath).split('\\').join('/')} ↔ 实测:`);
    console.log(`  导出 ${r.report.totals.exports} · behavior ${r.report.totals.behavior}`
      + ` · symbol-only ${r.report.totals.symbolOnly} · none ${r.report.totals.none}`);
    if (r.ok) {
      console.log('  ✓ 一致(清单与实测相同;状态列写法合法)');
      return;
    }
    console.error(`  ✗ ${r.problems.length} 项不一致:`);
    for (const p of r.problems) console.error(`      · ${p}`);
    process.exitCode = 1;
    return;
  }

  if (write) {
    const before = existsSync(ledgerPath) ? parseRows(blockOf(readFileSync(ledgerPath, 'utf8'), BLOCKS.rows) ?? '') : [];
    const r = runWrite({ root, ledgerPath });
    console.log(`已写台账:${relative(root, ledgerPath).split('\\').join('/')}(${r.bytes} B)`
      + ` · 保留已填状态 ${before.filter((x) => x.status !== '待补').length} 条`
      + ` · 导出 ${r.report.totals.exports}(behavior ${r.report.totals.behavior}`
      + ` / symbol-only ${r.report.totals.symbolOnly} / none ${r.report.totals.none})`);
    return;
  }

  const report = buildMatrix(build);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(readableTable(report));
  console.log('\n用法:--json / --check / --write(见文件头)');
}

if (import.meta.main) main();