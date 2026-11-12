/**
 * 断言「红触发条件候选」报告器 —— task-68(只读分析器,**不起进程、不改文件**)
 *
 * > `node scripts/assertion-teeth-report.ts tests/WS-10.test.ts`
 * > `node scripts/assertion-teeth-report.ts --all [--verbose]`
 * > `node scripts/assertion-teeth-report.ts --selftest`
 *
 * ## 它回答的问题(与 `assertion-audit.ts` 分工不同)
 *
 * `assertion-audit.ts`(task-62/66,1440 行)按**值来源**分甲/乙/丙,
 * 并已含 §[f]「标题声称的量不在判据体里」检测器。
 * 本脚本**不重做那件事**,只补它明确声明做不到的一层:
 *
 * ```
 * assertion-audit 的自述边界:「丙 不可机械判定(要跨文件数据流分析)」
 *                              「只做正向检测」
 *                               乙-A 是「兜底档」不是「已证明」
 * ⇒ 本脚本补的是:**这条断言要变红,得改哪个文件的哪个符号** —— 即
 *    「候选注入点」清单,并机械判定一件事:
 *
 *    ★ 该断言的候选注入点里,**有没有一个是生产文件**(server/src|shared|client)?
 *      若没有(全是测试文件内部的字面量/夹具)⇒ **注入生产永远不会让它红** ——
 *      这条是机械可判的,且与「有没有牙」不同(见下「边界」)。
 * ```
 *
 * ## ⚠️ 本脚本的边界(先读,免得把「没报」当「没问题」)
 *
 * ```
 * 1 「候选注入点」是**语法级**推导:从断言两侧表达式里抽标识符,再回到
 *    (a) import 映射 (b) 文件内声明 (c) 全仓方法名索引
 *    ⇒ 它**不知道**运行时哪条路径真的被走到。命中多不代表都有牙。
 * 2 ★ 它**判不了「守错对象」**(陷阱 60:`eq(X,X)` 有牙断言在旁边掩护)。
 *    那需要理解「标题声称守什么」与「判据体守什么」的语义差。
 * 3 ★ 它**判不了「性质类断言」**(陷阱 57:`eq(run(), run())` 语法同源、语义不同源)。
 *    本脚本会把两侧文本相同的判为「乙-like」,但**语义不同源时这是误报**。
 * 4 ★ 它**看不见「被调函数内部」**:`Math.random` 藏在 `bus.emit()` 里时,
 *    本脚本只看到 `bus` 与 `emit`,报不出非确定性 ⇒ 乙-B 那栏判不准。
 * 5 「无生产候选」**不等于**「没牙」:若该断言守的正是一个**测试夹具不变量**,
 *    它就本该只在测试内变红。本脚本只报事实,不下判决。
 * 6 方法名索引是**同名取全**:全仓同名方法有多个定义时会全部列出(按文件排),
 *    需要人读一眼挑。这是刻意的(宁可多列,不误判成唯一)。
 * ```
 *
 * ⇒ 定位:**给出候选 + 标注边界**,不是「判定有没有牙」。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const SELFTEST = process.argv.includes('--selftest');
const ALL = process.argv.includes('--all');

/* ══════════════════════ 1. 位置保持的掩码器 ══════════════════════ */

/**
 * 把注释 / 字符串 / 模板 / 正则字面量的**内容**替换成空格,长度与换行保持不变。
 *
 * 为什么必须是**状态机**而不是 `replace` 拼正则:
 * ```
 * 1 偏移会变 ⇒ 行号全错
 * 2 去匹配「剥注释后的代码」时,剥注释正则**自身**含 `*` + `/` 序列
 *    ⇒ 被自己当注释删掉 ⇒ 检测器报 0 条 ⇒ 看起来「全仓干净」
 * ```
 * 模板里的 `${...}` 是**代码**,按帧回压处理(不能整块空白掉)。
 */
function maskSource(src: string): string {
  const n = src.length;
  const out = src.split('');
  const blank = (i: number): void => {
    if (i < n && src[i] !== '\n' && src[i] !== '\r') out[i] = ' ';
  };

  interface Frame { mode: string; depth: number; fromTpl: boolean }
  const frames: Frame[] = [{ mode: 'code', depth: 0, fromTpl: false }];
  const top = (): Frame => frames[frames.length - 1]!;

  const REGEX_OK_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
  const REGEX_OK_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof']);

  let prevSig = '';       /* 上一个「有效字符」(值结束符会被记成 " 或 ` 或 ) 或 ] 等) */
  let word = '';          /* 正在累积的标识符 */
  let prevWord = '';
  let i = 0;

  while (i < n) {
    const f = top();
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1]! : '';

    if (f.mode === 'line') {
      if (c === '\n') frames.pop(); else blank(i);
      i += 1; continue;
    }
    if (f.mode === 'block') {
      if (c === '*' && c2 === '/') { blank(i); blank(i + 1); i += 2; frames.pop(); continue; }
      blank(i); i += 1; continue;
    }
    if (f.mode === 'single' || f.mode === 'double') {
      const q = f.mode === 'single' ? "'" : '"';
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === q) { blank(i); i += 1; frames.pop(); prevSig = q; continue; }
      if (c === '\n') { frames.pop(); continue; }        /* 未闭合字符串:回退到代码态 */
      blank(i); i += 1; continue;
    }
    if (f.mode === 'tpl') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { blank(i); i += 1; frames.pop(); prevSig = '`'; continue; }
      if (c === '$' && c2 === '{') {
        blank(i); blank(i + 1); i += 2;
        frames.push({ mode: 'code', depth: 0, fromTpl: true });
        prevSig = '{'; continue;
      }
      blank(i); i += 1; continue;
    }
    if (f.mode === 'regex') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '[') { f.depth = 1; blank(i); i += 1; continue; }
      if (c === ']') { f.depth = 0; blank(i); i += 1; continue; }
      if (c === '/' && f.depth === 0) {
        blank(i); i += 1;
        while (i < n && /[a-z]/i.test(src[i]!)) { blank(i); i += 1; }   /* flags */
        frames.pop(); prevSig = '/'; continue;
      }
      blank(i); i += 1; continue;
    }

    /* ── mode === 'code' ── */
    if (c === '/' && c2 === '/') { blank(i); blank(i + 1); i += 2; frames.push({ mode: 'line', depth: 0, fromTpl: false }); continue; }
    if (c === '/' && c2 === '*') { blank(i); blank(i + 1); i += 2; frames.push({ mode: 'block', depth: 0, fromTpl: false }); continue; }
    if (c === '"') { blank(i); i += 1; frames.push({ mode: 'double', depth: 0, fromTpl: false }); continue; }
    if (c === "'") { blank(i); i += 1; frames.push({ mode: 'single', depth: 0, fromTpl: false }); continue; }
    if (c === '`') { blank(i); i += 1; frames.push({ mode: 'tpl', depth: 0, fromTpl: false }); continue; }
    if (c === '/' && (REGEX_OK_CHARS.has(prevSig) || REGEX_OK_WORDS.has(prevWord))) {
      blank(i); i += 1; frames.push({ mode: 'regex', depth: 0, fromTpl: false }); continue;
    }
    if (c === '{') f.depth += 1;
    else if (c === '}') {
      if (f.depth > 0) f.depth -= 1;
      else if (f.fromTpl) { frames.pop(); prevSig = '}'; i += 1; continue; }
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      if (/[A-Za-z0-9_$]/.test(c)) word += c;
      else { if (word !== '') prevWord = word; word = ''; }
    }
    i += 1;
  }
  return out.join('');
}

/* ══════════════════════ 2. 括号/花括号配对 ══════════════════════ */

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** 从 `open` 位置(该字符是左括号)找到匹配的右括号位置;找不到返回 -1。 */
function matchBracket(masked: string, open: number): number {
  const close = PAIRS[masked[open]!];
  if (close === undefined) return -1;
  let d = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i]!;
    if (c === masked[open]) d += 1;
    else if (c === close) { d -= 1; if (d === 0) return i; }
  }
  return -1;
}

/* ══════════════════════ 3. 顶层逗号切分 ══════════════════════ */

/**
 * 按「相对本层」的顶层逗号切分实参,**返回区间**而不是子串。
 *
 * ★ 为什么返回区间:同一个切分结果要同时用于**掩码版**(判据)与**原文版**(展示)。
 *   而两者的字符偏移**完全相同**(掩码器保证等长),所以区间可以复用。
 *
 * ★★★ 前置条件:传入的必须是**掩码过**的文本。
 *   原文里字符串内的逗号会被当成顶层逗号 ⇒ 切错。
 *   实测:`splitArgs("'a,b', x")` ⇒ **3 段**(应为 2):`"a` / `b'"` / `x`。
 *   ⚠️ 而 2026-11-13 修之前,`extractAssertions` 里**有一处**正是这么调的
 *     (`splitArgs(src.slice(...))`)⇒ 那些行含逗号字符串的断言,
 *     展示出来的「期望值」是被切断的。危害在于:
 *     报告里的期望值正是人用来判断"这条判据有没有牙"的依据 ⇒ 会被误导。
 */
function splitArgRanges(masked: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i]!;
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
    else if (c === ',' && d === 0) { out.push([start, i]); start = i + 1; }
  }
  out.push([start, masked.length]);
  return out;
}

/** 按「相对本层」的顶层逗号切分实参。掩码过的文本里没有字符串内容,故括号计数可靠。 */
function splitArgs(masked: string): string[] {
  return splitArgRanges(masked).map(([a, b]) => masked.slice(a, b));
}

/* ══════════════════════ 4. 提取 test 块与断言 ══════════════════════ */

const ASSERTION_FNS = new Set(['eq', 'ok', 'near', 'includes', 'inRange', 'notEqual', 'assert', 'throws']);
const JS_KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this', 'new', 'typeof', 'instanceof',
  'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'const', 'let', 'var',
  'function', 'of', 'in', 'await', 'async', 'as', 'void', 'delete', 'yield', 'class', 'extends',
  'super', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'default', 'import', 'export',
  'from', 'number', 'string', 'boolean', 'object', 'symbol', 'any', 'unknown', 'never', 'readonly',
]);

interface Assertion {
  fn: string;
  line: number;
  actualText: string;
  expectedText: string;
  messageText: string;
}

interface TestBlock {
  name: string;
  line: number;
  start: number;
  end: number;
  bodyStart: number;
  assertions: Assertion[];
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i += 1) if (src[i] === '\n') n += 1;
  return n;
}

function extractTests(src: string, masked: string): TestBlock[] {
  const blocks: TestBlock[] = [];
  const re = /\btest\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;

    /* 标题:用原始文本取(掩码把字符串内容抹了,标题就在实参里) */
    const titleRaw = src.slice(open + 1, masked.indexOf(',', open) > 0 ? masked.indexOf(',', open) : close);
    const title = titleRaw.replace(/\s+/g, ' ').trim().slice(0, 120);

    /* 找回调体的 `{`
     *
     * ★★★ 2026-11-13 修:原实现从 `close + 1` 往后找 ⇒ **方向反了**。
     * `close` 是**整个 `test(...)` 调用**的右括号,它位于回调体**之后**
     * (实测 WS-10: open=4223, close=5082, 而回调体的 `{` 在 4278)。
     * ⇒ 从 close+1 往后永远找不到 `{`,只会撞上 `;` 或 200 字符窗口耗尽
     * ⇒ `bodyOpen < 0` ⇒ **每一块都被 `continue` 丢弃** ⇒ 断言恒 0。
     * 实测后果:该工具对 WS-10(893 个断言调用 / 97 个 test 块)报「断言 0 条」,
     * 对**每一个**文件都是 0 —— 一个恒报 0 的工具比没有工具更危险:
     * 它看起来"跑过了",而它的 0 会被读成"这里没有断言"。
     * ⇒ 正确方向:在 **`open` 与 `close` 之间**找回调体的 `{`(取第一个)。
     */
    let bodyOpen = -1;
    for (let i = open + 1; i < close; i += 1) {
      if (masked[i] === '{') { bodyOpen = i; break; }
    }
    if (bodyOpen < 0) continue;
    const bodyClose = matchBracket(masked, bodyOpen);
    if (bodyClose < 0 || bodyClose > close) continue;

    blocks.push({
      name: title, line: lineOf(src, m.index), start: m.index, end: bodyClose,
      bodyStart: bodyOpen, assertions: [],
    });
    re.lastIndex = bodyClose;
  }
  return blocks;
}

function extractAssertions(src: string, masked: string, from: number, to: number): Assertion[] {
  const out: Assertion[] = [];
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (m.index >= to) break;
    const fn = m[1]!;
    if (!ASSERTION_FNS.has(fn)) continue;
    /* 排除 `x.eq(` 这种成员调用(本仓 harness 的断言都是裸调用) */
    const before = masked.slice(Math.max(0, m.index - 2), m.index).match(/\S\s*$/);
    if (before !== null && before[0]!.trim().endsWith('.')) continue;

    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0 || close > to) continue;

    const argsMasked = masked.slice(open + 1, close);
    /* ★ 用**同一套**区间切分,再分别从掩码版(判据)与原文版(展示)取子串。
       掩码器保证等长 ⇒ 偏移一致 ⇒ 区间可复用。
       这样就不会再出现"把原文喂给只接受掩码文本的函数"那个错。 */
    const ranges = splitArgRanges(argsMasked);
    const rawArgsSrc = src.slice(open + 1, close);
    const rawAt = (k: number): string => {
      const r = ranges[k];
      if (r === undefined) return '';
      return rawArgsSrc.slice(r[0], r[1]);
    };
    const args = ranges.map(([a, b]) => argsMasked.slice(a, b));

    out.push({
      fn,
      line: lineOf(src, m.index),
      actualText: rawAt(0).replace(/\s+/g, ' ').trim().slice(0, 90),
      expectedText: rawAt(1).replace(/\s+/g, ' ').trim().slice(0, 90),
      messageText: rawAt(ranges.length - 1).replace(/\s+/g, ' ').trim().slice(0, 60),
      __maskedActual: args[0] ?? '',
      __maskedExpected: args[1] ?? '',
    } as Assertion & { __maskedActual: string; __maskedExpected: string });
    re.lastIndex = close;
  }
  return out;
}

/* ══════════════════════ 5. 标识符抽取 ══════════════════════ */

interface Idents { base: string[]; members: string[] }

/** 掩码过的文本里抽标识符:`base` = 非成员位置的,`members` = `.name(` 形式的方法名。 */
function collectIdents(maskedArg: string): Idents {
  const base: string[] = [];
  const members: string[] = [];
  const re = /(\.\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskedArg)) !== null) {
    const isMember = m[1] !== undefined;
    const id = m[2]!;
    if (JS_KEYWORDS.has(id)) continue;
    if (isMember) {
      /* 只收「作为方法被调用」的成员(后随 `(`),属性读取不收 */
      const after = maskedArg.slice(m.index + m[0].length);
      if (/^\s*\(/.test(after)) members.push(id);
    } else base.push(id);
  }
  return { base: [...new Set(base)], members: [...new Set(members)] };
}

/* ══════════════════════ 6. 全仓符号索引 ══════════════════════ */

interface SymHit { file: string; line: number; kind: string }

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const p = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
}

let PROD_FILES: string[] = [];
const FILE_LINES = new Map<string, string[]>();
function linesOf(f: string): string[] {
  let v = FILE_LINES.get(f);
  if (v === undefined) { v = readFileSync(f, 'utf8').split('\n'); FILE_LINES.set(f, v); }
  return v;
}

/** 全仓找 `name` 的**声明点**。宁可多列,不误判成唯一。 */
function findDecls(name: string): SymHit[] {
  const hits: SymHit[] = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats: { re: RegExp; kind: string }[] = [
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${esc}\\b`), kind: 'const/let/var' },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\b`), kind: 'function' },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${esc}\\b`), kind: 'class' },
    { re: new RegExp(`^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+${esc}\\b`), kind: 'type' },
    { re: new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|async|get|set|abstract|override|declare)\\s+)*[*]?\\s*${esc}\\s*[(<]`), kind: 'method' },
  ];
  for (const f of PROD_FILES) {
    const L = linesOf(f);
    for (let i = 0; i < L.length; i += 1) {
      for (const p of pats) {
        if (p.re.test(L[i]!)) { hits.push({ file: relative(ROOT, f), line: i + 1, kind: p.kind }); }
      }
      if (hits.length > 24) return hits;      /* 同名过多时截断(报事实,不猜) */
    }
  }
  return hits;
}

/* ══════════════════════ 7. 单文件分析 ══════════════════════ */

interface ImportMap { from: Map<string, string>; local: Set<string> }

function buildImports(tf: string, src: string): ImportMap {
  const from = new Map<string, string>();
  const local = new Set<string>();
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1]!;
    const spec = m[2]!;
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces !== null) {
      for (const raw of braces[1]!.split(',')) {
        const id = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) from.set(id, spec);
      }
    }
    const star = clause.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (star !== null) from.set(star[1]!, spec);
    const def = clause.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|$)/);
    if (def !== null && !clause.trim().startsWith('{')) from.set(def[1]!, spec);
  }
  /* 文件内声明(夹具、helper、局部常量) */
  const declRe = /^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let d: RegExpExecArray | null;
  while ((d = declRe.exec(src)) !== null) local.add(d[1]!);
  return { from, local };
}

function resolveSpec(tf: string, spec: string): string {
  if (!spec.startsWith('.')) return '(外部包)';
  const base = join(dirname(tf), spec);
  for (const cand of [base, base.replace(/\.ts$/, '') + '.ts', join(base, 'index.ts')]) {
    try { if (statSync(cand).isFile()) return relative(ROOT, cand); } catch { /* 继续 */ }
  }
  return relative(ROOT, base);
}

interface Finding {
  block: string;
  blockLine: number;
  a: Assertion & { __maskedActual: string; __maskedExpected: string };
  cls: string;
  prodCands: SymHit[];
  testCands: string[];
  unresolved: string[];
}

function analyzeFile(tf: string): Finding[] {
  const src = readFileSync(tf, 'utf8');
  const masked = maskSource(src);
  const imports = buildImports(tf, src);
  const findings: Finding[] = [];

  for (const b of extractTests(src, masked)) {
    const asserts = extractAssertions(src, masked, b.bodyStart, b.end);
    for (const a of asserts) {
      const aa = a as Assertion & { __maskedActual: string; __maskedExpected: string };
      const idA = collectIdents(aa.__maskedActual);
      const idE = collectIdents(aa.__maskedExpected);

      const prodCands: SymHit[] = [];
      const testCands: string[] = [];
      const unresolved: string[] = [];

      const consider = (names: string[], kind: 'base' | 'member'): void => {
        for (const n of names) {
          if (kind === 'base' && imports.local.has(n)) { testCands.push(`${n}(本文件声明)`); continue; }
          const spec = imports.from.get(n);
          if (spec !== undefined) {
            const f = resolveSpec(tf, spec);
            prodCands.push({ file: f, line: 0, kind: `import {${n}}` });
            continue;
          }
          if (kind === 'base' && !imports.local.has(n)) {
            /* 未 import 也未在本文件声明:可能是参数/循环变量/解构,记为未解析 */
            unresolved.push(n);
          }
          if (kind === 'member') {
            const hits = findDecls(n);
            for (const h of hits) prodCands.push(h);
          }
        }
      };
      consider(idA.base, 'base');
      consider(idE.base, 'base');
      consider([...idA.members, ...idE.members], 'member');

      /* 分类(启发式,不是判决) */
      const normA = aa.__maskedActual.replace(/\s+/g, '');
      const normE = aa.__maskedExpected.replace(/\s+/g, '');
      let cls = '丙-like(两侧不同源)';
      if (normA === normE && normA !== '') cls = '乙-like(两侧同一表达式)';
      else if (/^[0-9'"`\-+(]|^true$|^false$|^null$|^undefined$|^NaN$/.test(normE) && normE.length > 0) cls = '甲-like(期望是字面量)';
      else if (normE === '') cls = '无期望值(单参断言)';

      findings.push({ block: b.name, blockLine: b.line, a: aa, cls, prodCands, testCands, unresolved });
    }
  }
  return findings;
}

/* ══════════════════════ 8. 自检(判红器) ══════════════════════ */

function selftest(): number {
  let fails = 0;
  const chk = (c: boolean, m: string): void => {
    if (!c) { fails += 1; console.error(`  ✗ [自检] ${m}`); } else console.log(`  ✓ ${m}`);
  };

  console.log('── 掩码器 ──');
  /* ★★★ 2026-11-13 修:原样本第 4 行把 `eq(` 写在**模板文本**里
   * (`const t = \`eq(${realVar}, 3) ...\``),却期望它被算成"真断言"。
   * 那是**错的期望**:ES 规范里模板**文本**不是代码,只有 `${...}` 内才是。
   * ⇒ 掩码器抹掉它**是对的**(这与它抹注释/字符串/正则同一个道理)。
   * ⇒ 该样本真正验证的是「模板里的代码(在 ${} 内)**保留**」,
   *   而原样本的 `${realVar}` 里**没有** `eq(`,于是它既没验证"保留",
   *   又错误地要求"保留",导致自检恒红。
   * ⇒ 正确样本:让 `${}` 里真的放一条断言,模板文本里放一条假的。
   *   —— 这才同时测到两个方向(该抹的抹、该留的留)。 */
  const dirty = [
    "// eq(shouldNotAppear, 1)  注释里的断言",
    "const s = 'eq(alsoNot, 2)  字符串里的断言';",
    "const re = /eq\\(nope\\)/;",
    "const t = `eq(tplTextNotCode, 3) 模板**文本**里的假断言`;",
    "eq(realVar, 4, '真断言');",
    "const u = `外壳${eq(realInTpl, 5, '模板里的真断言')}尾部`;",
  ].join('\n');
  const dm = maskSource(dirty);
  chk(!dm.includes('shouldNotAppear'), '注释内容被掩掉');
  chk(!dm.includes('alsoNot'), '字符串内容被掩掉');
  chk(!dm.includes('nope'), '正则字面量内容被掩掉');
  chk(!dm.includes('tplTextNotCode'), '★ 模板**文本**里的 `eq(` 被掩掉(它不是代码)');
  chk(dm.includes('realInTpl'), '★ 模板 `${...}` 内的**真代码保留**(不被整块掩掉)');
  chk(dm.length === dirty.length, '掩码后长度不变(行号可靠)');
  const found = extractAssertions(dirty, dm, 0, dirty.length);
  chk(found.length === 2, `只抽出 2 条真断言(L5 裸断言 + L6 模板内断言),实测 ${found.length}`);
  chk(found.some((f) => f.line === 5), '行号定位到第 5 行的真断言');
  chk(found.some((f) => f.line === 6), '行号定位到第 6 行(模板 `${}` 里的真断言)');

  console.log('── 顶层逗号切分 ──');
  /* ★★★ 2026-11-13 修(第二次):原样本传的是 **原文**
   * `"f(a, g(b, c), [1, 2], 'x,y', { k: 1 })"` —— 两个错:
   *   1 含最外层 `f(...)` ⇒ 深度从 1 起算 ⇒ 顶层逗号 0 个
   *   2 ★ 它含 `'x,y'`(字符串内的逗号),而 `splitArgs` 的**前置条件是掩码文本**
   *     ⇒ 原文喂进去必然把 `'x,y'` 切断 ⇒ 6 段
   * ⇒ ⇒ 两次修的都是**同一个形态**:我用**违反前置条件的输入**去测一个函数,
   *   然后把它的(正确)行为判成失败。
   * ⇒ 正确样本:先掩码,再切分 —— 这正是**真实调用点**的做法。 */
  const spRaw = "a, g(b, c), [1, 2], 'x,y', { k: 1 } ";
  const spMasked = maskSource(spRaw);
  chk(spMasked.length === spRaw.length, '样本掩码后等长(偏移可直接对照原文)');
  /* ⚠️ 我在这条上连错两次,记下来:第一次猜"抹成 `'   '`"(形状猜死),
     第二次猜"掩码后不含逗号"(但**结构性逗号**还在,它们本来就该在)。
     ⇒ 正确做法是**量出差值**,而不是猜某个绝对形态:
       原文 7 个逗号(含字符串里那 1 个),掩码后应是 6 个 ⇒ 差**恰好 1**。
     ⇒ ★ 这条断言的性质是"**恰好少一个**",它同时钉住两件事:
       字符串内那个被抹了、且**只有它**被抹(没有误伤结构逗号)。 */
  const commas = (t: string): number => t.split(',').length - 1;
  chk(commas(spRaw) === 7, `原文逗号 7 个(含字符串里 1 个),实测 ${commas(spRaw)}`);
  chk(
    commas(spMasked) === 6,
    `★ 掩码后恰好 6 个 ⇒ 只少了字符串里那一个,实测 ${commas(spMasked)}`,
  );
  const sp = splitArgs(spMasked);
  chk(sp.length === 5, `嵌套括号/数组/对象里的逗号不切分,实测 ${sp.length} 段`);
  chk(sp[4]!.trim() === '{ k: 1 }', '最后一段完整');
  /* ★ 并钉住"违反前置条件会怎样" —— 把它做成**已知的错**,而不是踩到它 */
  chk(splitArgs(spRaw).length === 6, '★ 反例:原文喂进去 ⇒ 6 段(证明前置条件是真约束,不是提醒)');

  console.log('── ★ 单引号字符串里的逗号(必须靠掩码,不能靠原文) ──');
  /* 这条钉住 2026-11-13 修掉的第二个真缺陷:
     展示用的 actualText/expectedText 曾把**原文**喂给只接受掩码文本的切分函数
     ⇒ 含逗号的字符串会被切断。用区间切分后两侧同源,不再可能不一致。 */
  {
    const code = "eq(call('a,b'), 1, 'm')";
    const mk = maskSource(code);
    const openI = code.indexOf('(');
    const closeI = matchBracket(mk, openI);
    const ranges = splitArgRanges(mk.slice(openI + 1, closeI));
    const rawSrc = code.slice(openI + 1, closeI);
    const asRaw = rawSrc.slice(ranges[0]![0], ranges[0]![1]).trim();
    chk(ranges.length === 3, `顶层逗号 3 段(实际/期望/消息),实测 ${ranges.length}`);
    chk(asRaw === "call('a,b')", `★ 展示文本未被字符串内的逗号切断,实测 ${JSON.stringify(asRaw)}`);
    const asMasked = mk.slice(openI + 1, closeI).slice(ranges[0]![0], ranges[0]![1]).trim();
    chk(asMasked === 'call(     )', `判据文本用掩码版(字符串内容已抹),实测 ${JSON.stringify(asMasked)}`);
  }

  console.log('── ★ test 块提取(2026-11-13 修掉的恒 0 缺陷)──');
  /* 这条钉住第一个真缺陷:原实现从**整个调用**的右括号之后找回调体 `{`
     ⇒ 方向反了 ⇒ 每块都被丢弃 ⇒ 对每个文件都报"断言 0 条"。
     这里用一个最小样例 + 一个真文件双层验证。 */
  {
    const mini = "test('t', () => {\n  eq(1, 1, 'm');\n  ok(true, 'm2');\n});";
    const mm = maskSource(mini);
    const bl = extractTests(mini, mm);
    chk(bl.length === 1, `最小样例抽出 1 个 test 块,实测 ${bl.length}`);
    chk(
      bl.length === 1 && extractAssertions(mini, mm, bl[0]!.bodyStart, bl[0]!.end).length === 2,
      '该块内抽出 2 条断言',
    );
    /* 真文件:必须有大量块(若方向再反了,这里会立刻归零) */
    const realTf = join(ROOT, 'tests', 'WS-10.test.ts');
    const realSrc = readFileSync(realTf, 'utf8');
    const realMk = maskSource(realSrc);
    const realBlocks = extractTests(realSrc, realMk);
    chk(realBlocks.length > 50, `真文件 WS-10 抽出 ${realBlocks.length} 个 test 块(>50)`);
    const realAssert = realBlocks.reduce(
      (s, b) => s + extractAssertions(realSrc, realMk, b.bodyStart, b.end).length, 0,
    );
    chk(realAssert > 500, `真文件合计断言 ${realAssert} 条(>500)—— 修之前这里是 0`);
  }

  console.log('── 标识符抽取 ──');
  const ids = collectIdents('s.vitals.applyHit(x) + KEEP * 2 ');
  chk(ids.members.includes('applyHit'), '成员方法名被收集(用于回到生产定义)');
  chk(ids.base.includes('x') && ids.base.includes('KEEP'), '裸标识符被收集');
  chk(!ids.base.includes('vitals'), '`.vitals` 是属性读取(后无 `(`),不被当成 base');

  console.log('── import / 本文件声明 解析 ──');
  const tf = join(ROOT, 'tests', 'WS-10.test.ts');
  const im = buildImports(tf, readFileSync(tf, 'utf8'));
  chk(im.from.has('ReviveMethod') || im.from.size > 0, `import 映射非空(实测 ${im.from.size} 项)`);
  chk(im.local.has('partyWorld'), '本文件函数声明被识别为 local');

  console.log('── 真文件端到端 ──');
  const f10 = analyzeFile(tf);
  chk(f10.length > 100, `WS-10 抽出 ${f10.length} 条断言`);
  const withProd = f10.filter((x) => x.prodCands.some((c) => !c.file.startsWith('tests'))).length;
  chk(withProd > 0, `其中 ${withProd} 条解析出**生产**候选注入点`);
  const sample = f10.find((x) => x.prodCands.some((c) => c.file.includes('vitals')));
  chk(sample !== undefined, '抽样能回到 server/src/combat/vitals.ts');

  if (fails > 0) console.error(`\n[自检] ${fails} 项失败`);
  else console.log('\n[自检] 全部通过');
  return fails;
}

/* ══════════════════════ 9. 主流程 ══════════════════════ */

PROD_FILES = [];
for (const top of ['server/src', 'shared', 'client']) walk(join(ROOT, top), PROD_FILES);

if (SELFTEST) {
  process.exitCode = selftest() > 0 ? 1 : 0;
} else {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets: string[] = [];
  if (ALL || args.length === 0) {
    const td = join(ROOT, 'tests');
    for (const f of readdirSync(td)) if (f.endsWith('.test.ts')) targets.push(join(td, f));
  } else {
    for (const a of args) targets.push(a.startsWith('.') || /^[A-Za-z]:/.test(a) ? a : join(ROOT, a));
  }

  let totAssertions = 0;
  let totNoProd = 0;
  const summary: string[] = [];

  for (const tf of targets) {
    let findings: Finding[];
    try { findings = analyzeFile(tf); } catch (e) {
      console.error(`  ✗ ${relative(ROOT, tf)} 分析失败: ${(e as Error).message}`);
      continue;
    }
    const noProd = findings.filter((x) => !x.prodCands.some((c) => !c.file.startsWith('tests')));
    totAssertions += findings.length;
    totNoProd += noProd.length;

    console.log(`\n═══ ${relative(ROOT, tf)} ═══`);
    console.log(`  断言 ${findings.length} 条 / 无生产候选 ${noProd.length} 条`);

    for (const f of findings) {
      const prod = f.prodCands.filter((c) => !c.file.startsWith('tests'));
      const hasProd = prod.length > 0;
      if (!VERBOSE && hasProd) continue;
      console.log(`  ${hasProd ? '·' : '★'} L${f.a.line} [${f.a.fn}] ${f.cls}`);
      console.log(`      实际: ${f.a.actualText}`);
      if (f.a.expectedText !== '') console.log(`      期望: ${f.a.expectedText}`);
      if (prod.length > 0) {
        const seen = new Set<string>();
        for (const c of prod) {
          const k = `${c.file}:${c.line}:${c.kind}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (seen.size > 6) { console.log('        …(截断)'); break; }
          console.log(`      候选注入点 [生产] ${c.file}${c.line ? ':' + c.line : ''}  (${c.kind})`);
        }
      } else {
        console.log('      ★ 无生产候选 —— 注入生产**永远不会**让它红');
        if (f.testCands.length > 0) console.log(`        仅测试内: ${[...new Set(f.testCands)].join(', ')}`);
        if (f.unresolved.length > 0) console.log(`        未解析: ${[...new Set(f.unresolved)].join(', ')}`);
      }
    }
    summary.push(`  ${relative(ROOT, tf).padEnd(30)} 断言 ${String(findings.length).padStart(4)}  无生产候选 ${String(noProd.length).padStart(4)}`);
  }

  console.log('\n═══ 汇总 ═══');
  for (const s of summary) console.log(s);
  console.log(`\n  合计断言 ${totAssertions} 条,其中无生产候选 ${totNoProd} 条` +
    `(${totAssertions > 0 ? ((totNoProd / totAssertions) * 100).toFixed(1) : '0'}%)`);
  console.log('  ⚠️ 「无生产候选」不等于「没牙」:守测试夹具不变量的断言就该如此。见文件头「边界」。');
}
