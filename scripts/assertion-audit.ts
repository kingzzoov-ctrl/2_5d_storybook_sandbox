/**
 * 跨套件断言「值来源」审计 —— 常驻只读脚本(task-62,net-persist)。
 *
 * ## 它要解决的病
 *
 * task-57/58/59 三轮里实测出**至少 4 条没牙的断言**,每次都靠「猜一个注入」
 * 才发现(`M8` 位置恒真 / `T59-1` 累计值误用 / `T59-5` 判据取错源 / `K1` tautology)。
 * **猜注入的弱点**:猜不到的形态就漏。
 *
 * ⇒ 本脚本换判据:**不问「注入什么它会红」,问「这条断言的值从哪来」**。
 *
 * ```
 * 甲 期望值来自**常量字面量**      eq(x, 37) / eq(n, 5)
 *    ⇒ 上游常量一改就过期;而「过期」表现为**假红**,与真缺陷无法区分(陷阱 43)
 * 乙 两侧来自**同一表达式**        eq(f(x), f(x)) / ok(true) / eq(o.x, o.x)
 *    ⇒ **恒真,改什么都没用** —— 无声的,永远绿
 * 丙 两侧来自**两个独立权威**      eq(库值, 运行时权威值) / eq(state.x, bodies.x)
 *    ⇒ 有牙。样板:`eq(库hp, hpAtSave)` + `ok(hpAtSave > 37)`(C25 改后形态)
 * ```
 *
 * ## ⚠️ 本脚本的判据边界(先读,免得把「没报」当「没问题」)
 *
 * `甲` 与 `乙` 是**可机械判定**的;**`丙` 不可机械判定**(要判两个来源是否
 * 真的独立,需要跨文件数据流分析)。⇒ 本脚本**只做正向检测**:
 * ```
 * 报出的 乙 = 「我证明了它恒真的」         —— 结论可信
 * 报出的 甲 = 「期望值是字面量」           —— 是**待判清单**,不是缺陷清单
 * 未报出的 = 「本脚本的判据看不见它」     —— **不等于它没问题**(尤其丙类)
 * ```
 *
 * ## 本脚本自身也要被审计(承 `judgement_audit.ts` 的骨架)
 *
 * 我写第一版时踩了两个同族错:
 * ```
 * 1 「期望值命中同值常量」当判据 ⇒ 报 2387/2804 = 85%,但 `eq(_, 0)` 命中
 *    `GHOST_BUBBLE_MIN_SEC = 0` 毫无意义 ⇒ **判据太宽,噪音淹没信号**
 *    ⇒ 改成**用法判据**:期望值只有「字面上就等于某常量的**表达式**」才算贴身镜像
 * 2 用 `Get-Content -Skip` 核对行号 ⇒ 打印的是**别的行**(GBK/UTF-8 混读)
 *    ⇒ 行号一律由脚本自己算,并**用 grep 工具复核**关键结论
 * ```
 * ⇒ 故每个检测器都必须过**区分力自检**:脏样本必命中、干净样本必不命中。
 *
 * 用法:
 * ```
 * node scripts/assertion-audit.ts            # 报告
 * node scripts/assertion-audit.ts --strict   # 有乙类命中即 exit 1
 * ```
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ⚠️ 必须用 `fileURLToPath`:手拼 `new URL(...).pathname` 在 Windows 上得到
   `/C:/...`,`existsSync` 全 false ⇒ **扫 0 个文件却「顺利完成」**。
   这是 `judgement_audit.ts` E 检测器记过的形态,本脚本同样加「文件数 > 0」自检。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

const TEST_DIR = join(ROOT, 'tests');

/* ══════════════════ 词法工具 ══════════════════ */

/**
 * **位置保持**地屏蔽注释与字符串内容(保留换行与偏移,行号才可靠)。
 *
 * 为什么不用 `.replace()` 拼正则:
 * ```
 * 1 偏移会变 ⇒ 行号错
 * 2 去匹配「剥注释后的代码」时,剥注释正则**自身**含 `*` + `/` 序列
 *    ⇒ 被自己当注释删掉 ⇒ 检测器报 0 条 ⇒ 看起来「全仓干净」
 * ```
 * 故识别**正则字面量**并原样保留(它是代码)。
 */
function maskSource(src: string, strings: 'keep' | 'blank'): string {
  const out = src.split('');
  const blank = (i: number): void => { if (i < src.length && src[i] !== '\n') out[i] = ' '; };
  let prev = '';
  let i = 0;
  const n = src.length;
  const regexCanStart = (ch: string): boolean => ch === '' || !/[A-Za-z0-9_$)\]]/.test(ch);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i += 1; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { blank(i); i += 1; } continue; }

    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      if (strings === 'blank') blank(i);
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { if (strings === 'blank') { blank(i); blank(i + 1); } i += 2; continue; }
        if (src[i] === q) { if (strings === 'blank') blank(i); i += 1; break; }
        if (strings === 'blank') blank(i);
        i += 1;
      }
      prev = '"';
      continue;
    }

    if (c === '/' && regexCanStart(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') { inClass = true; j += 1; continue; }
        if (d === ']') { inClass = false; j += 1; continue; }
        if (d === '/' && !inClass) { closed = true; j += 1; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j] ?? '')) j += 1;
        i = j; prev = '/';
        continue;
      }
    }

    if (c !== undefined && !/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

/** 代码区(注释 + 字符串内容都空白化)。
 *  ⚠️ 必须对**原文**做,不能对已算出的掩码再做 —— 那会二次屏蔽。 */
const codeOf = (src: string): string => maskSource(src, 'blank');

/* ══════════════════ 参数切分 ══════════════════ */

type Call = { kind: string; line: number; args: string[]; text: string };

/**
 * 从 `(` 之后切出**顶层逗号**分隔参数的 **[start, end) 区间**。
 *
 * ★ 为什么返回**区间**而不是文本 —— 本脚本最关键的一处修正:
 * ```
 * 判「两侧是否同一表达式」时,若在**字符串已空白化**的文本上比较,
 * `fnv1a('abc')` 与 `fnv1a('abd')` 都会变成 `fnv1a(     )` ⇒ **误判为恒真**。
 * 我第一版就这样,自检 L1 的干净样本当场把它抓住(实得 乙,应为 甲)。
 * ⇒ 定界必须用「字符串空白化」版(否则字符串里的 `)` 会破坏深度计数),
 *   取值必须用「字符串保留」版(否则不同字面量看起来相同)。
 * 两份掩码**位置保持**,故同一组区间对两者都成立。
 * ```
 */
function splitArgRanges(code: string, start: number): { ranges: [number, number][]; end: number } {
  const ranges: [number, number][] = [];
  let depth = 0;
  let argStart = start;
  let i = start;
  for (; i < code.length; i += 1) {
    const c = code[i]!;
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth -= 1; continue;
    }
    if (c === ',' && depth === 0) { ranges.push([argStart, i]); argStart = i + 1; continue; }
  }
  ranges.push([argStart, i]);
  return { ranges, end: i };
}

/** 找出所有断言调用。**定界在** `codeBlank`(字符串已空白化)上做。 */
const ASSERT_KINDS = ['eq', 'near', 'includes', 'inRange', 'ok'] as const;

function findCalls(codeBlank: string, codeKeep: string): Call[] {
  const out: Call[] = [];
  const re = /\b(eq|near|includes|inRange|ok)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeBlank)) !== null) {
    /* 排除成员方法调用 `matcher.eq(...)` —— 前面是 `.` 或标识符字符则跳过。 */
    const before = codeBlank.slice(Math.max(0, m.index - 1), m.index);
    if (/[.\w$]/.test(before)) continue;
    const kind = m[1]!;
    const { ranges } = splitArgRanges(codeBlank, m.index + m[0].length);
    /* ★ 取值用 codeKeep(位置保持)⇒ 不同字符串字面量不会被抹成同一个 */
    const args = ranges.map(([a, b]) => codeKeep.slice(a, b));
    out.push({ kind, line: codeBlank.slice(0, m.index).split('\n').length, args, text: m[0] });
  }
  return out;
}

/** 比较用规范化:去空白。⚠️ 只去空白,不动字符串内容(内容必须保留)。 */
const flat = (s: string): string => s.replace(/\s+/g, '');
const isEmpty = (s: string): boolean => flat(s).length === 0;

/* ══════════════════ 甲/乙/丙 分类 ══════════════════ */

type Verdict = '甲' | '乙' | '丙' | '?';

const NUM_LIT = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const STR_LIT = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")$/;
const BOOL_LIT = /^(?:true|false)$/;
const NULL_LIT = /^(?:null|undefined)$/;
/** 全大写常量名 / 形如 CONST_A 或 A.B。
 *  ⚠️ 要求 ≥3 字符:`N` / `K` / `M` 这类单字母是测试里的**数学局部量**,
 *  不是上游常量。我第一版没限长度,`N` 以 9 次命中排到第一 —— 纯噪音。 */
const CAP_CONST = /^[A-Z][A-Z0-9_]{2,}$/;
/** 「值」的形态 —— 用来判「两侧是否各自独立求值」 */
const VALUEISH = /[\w$))\]]/;

/**
 * 判定**期望值**(第二参数)是否为「贴身常量镜像」。
 *
 * ⚠️ 关键区别(我第一版栽在这里):
 * ```
 * eq(x, 0)        期望值 0  —— **不报**:几乎所有相等断言都可能期望 0,
 *                             报它等于用「值相等」判「同源」,噪音 85%
 * eq(x, CONST_X)  期望值 是常量名 —— **报**:写测试的人**有意**引用了上游符号,
 *                             上游一改它就跟着变(或该变而没变)
 * ```
 * ⇒ 甲类的判据是「**写测试的人引用了哪个上游符号**」,不是「数字碰巧相等」。
 */
function isLiteralExpected(e: string): boolean {
  const t = e.trim();
  return NUM_LIT.test(t) || STR_LIT.test(t) || BOOL_LIT.test(t) || NULL_LIT.test(t);
}

function isNamedConstExpected(e: string): boolean {
  const t = flat(e);
  if (CAP_CONST.test(t)) return true;
  if (/^[A-Za-z_$][\w$]*\.[A-Z][A-Z0-9_]*$/.test(t)) return true;
  return false;
}

/**
 * 判「两侧同一表达式」—— **乙类**。
 * ```
 * eq(f(x), f(x))    文本相同        ⇒ 只证「两次调用一致」(确定性),不证值对
 * eq(a.b, a.b)      文本相同        ⇒ 恒真
 * ok(true)          字面真          ⇒ 恒真
 * ok(a === a)       两侧相同        ⇒ 恒真
 * ok(x.length >= 0) 恒真不等式      ⇒ 恒真
 * ```
 */
function isTautology(kind: string, args: string[]): { hit: boolean; why: string } {
  if (kind === 'ok') {
    const cond = flat(args[0] ?? '');
    if (cond === '') return { hit: false, why: '' };
    if (cond === 'true') return { hit: true, why: '`ok(true)` —— 字面真,不依赖任何被测状态' };
    /* 两侧完全相同的二元比较 */
    const cmp = /^(.+?)(===|!==|==|!=|>=|<=|>|<)(.+)$/.exec(cond);
    if (cmp) {
      const L = cmp[1]!; const op = cmp[2]!; const R = cmp[3]!;
      if (L === R) return { hit: true, why: `\`ok(${L} ${op} ${R})\` —— 两侧同一表达式` };
      /* `>= 0` / `<= 0` 于 length/count/size:非负数恒成立。
         ⚠️ 我第一版写的是 `/^(?:>=|<=)0$/.test(R)` —— 但 `R` 是**右侧**,
         对 `length >= 0` 而言 `R === '0'`,那个正则永远不匹配 ⇒ 检测器是空壳。
         自检 L3 当场抓住。正确写法是分别判 `op` 与 `R`。 */
      if (op === '>=' && R === '0' && /\.(?:length|size|count)$/.test(L)) {
        return { hit: true, why: `\`${L} >= 0\` —— 长度恒非负` };
      }
    }
    return { hit: false, why: '' };
  }

  if (kind === 'eq' || kind === 'near') {
    const A = flat(args[0] ?? '');
    const B = flat(args[1] ?? '');
    if (A === '' || B === '') return { hit: false, why: '' };
    if (A === B) {
      /* ⚠️ 分清两种语义 —— 这是本类最容易误判的地方:
         `eq(f(x), f(x))` 对**确定性**是有区分力的(若 f 引入随机性/时钟就会红),
         只对「f 算出的**值**是否等于应该的值」无区分力。
         ⇒ 报,但标注**边界**:「只守确定性,不守值正确性」。 */
      const callLike = /^[\w$][\w$.]*\(.*\)$/.test(A) || /\(/.test(A);
      return {
        hit: true,
        why: callLike
          ? '两侧同一**调用** ⇒ 只守「两次调用结果一致」(确定性);**不守**该值是否正确'
          : '两侧同一**表达式** ⇒ 恒真',
      };
    }
    /* ⚠️ 我第一版还有一条规则:「一侧是另一侧的成员路径」(`A.endsWith('.'+B)`)⇒ 判乙。
       **那是个错误判据**,实测造成大批假阳性:
       ```
       near(m!.mu, mu)        m 取自 FLOOR_META(权威),mu 取自测试内硬编码的手册数组
                              ⇒ 两者**独立**,是真正的丙/甲类交叉验证
       eq(g.batch.topQuads, batch.topQuads)
                              g = emitChunkGeometry(...), batch = buildChunkQuads(...)
                              ⇒ 两个**不同函数的返回值**互验 ⇒ **有牙**
       ```
       根因:`A` 以 `.B` 结尾只是**字面巧合**(短局部变量名常与属性名重名),
       不代表值同源。判「同源」需要**数据流**,我做不到。
       ⇒ 已删除该规则。**保守方向**:宁可漏报乙类,不制造假阳性
         (假阳性会让整份报告失去可信度,而漏报只是这份清单不完整 —— 报告里写明)。 */

    return { hit: false, why: '' };
  }

  return { hit: false, why: '' };
}

/**
 * 丙类判据:**两侧的值来自两个独立权威**。
 * ⚠️ 不可机械判定 ⇒ 只做**保守的正向识别**:若两侧一个是「读取端」动词、
 * 另一个是「持有端」动词,或两侧分别命中「库/序列化」与「运行时对象」词汇,
 * 则**推定**为丙。误判方向:把丙报成甲/乙(保守),不会把乙报成丙。
 */
const READ_VERBS = /\b(?:get|read|load|query|select|parse|fromDb|loadFromDb|JSON\.parse)\w*/i;
const LIVE_WORDS = /\b(?:sim|world|rt|runtime|host|physics|bodies|vitals|state|live|authority|actual)\w*/i;

function looksLikeDualAuthority(a: string, b: string): boolean {
  const A = flat(a); const B = flat(b);
  const aRead = READ_VERBS.test(A); const bRead = READ_VERBS.test(B);
  const aLive = LIVE_WORDS.test(A); const bLive = LIVE_WORDS.test(B);
  if (aRead !== bRead && aLive !== bLive && aLive !== bLive) return false;
  /* 一读一活 ⇒ 两侧独立性最强 */
  if (aRead && bLive && !bRead && !aLive) return true;
  if (bRead && aLive && !aRead && !bLive) return true;
  /* 一侧明显是「权威另一处」 */
  if (VALUEISH.test(A) && VALUEISH.test(B) && /\.(?:x|y|z|hp|hpSaved|value|tick|frame)\b/.test(A + '|' + B)) {
    const aMember = /\w+\.\w+/.test(A); const bMember = /\w+\.\w+/.test(B);
    const aCall = /\(/.test(A); const bCall = /\(/.test(B);
    if ((aMember && bCall) || (bCall && aMember) || (aCall && bCall)) return true;
  }
  return false;
}

type Row = {
  file: string;
  line: number;
  kind: string;
  verdict: Verdict;
  why: string;
  expr: string;
  expected: string;
};

function classify(file: string, src: string): Row[] {
  /* ★ 两份保持位置的掩码:定界用 blank(字符串里的括号不参与深度),
     取值用 keep(不同字符串字面量必须可区分)。见 `splitArgRanges` 的说明。 */
  const codeBlank = maskSource(src, 'blank');
  const codeKeep = maskSource(src, 'keep');
  const rows: Row[] = [];
  for (const c of findCalls(codeBlank, codeKeep)) {
    const a = c.args;
    if (c.kind === 'ok') {
      if (isEmpty(a[0] ?? '')) continue;
      const t = isTautology('ok', a);
      rows.push({
        file, line: c.line, kind: 'ok',
        verdict: t.hit ? '乙' : '?', why: t.why,
        expr: flat(a[0]!).slice(0, 90),
        expected: '(布尔条件)',
      });
      continue;
    }
    if (a.length < 2) continue;
    const got = a[0]!; const want = a[1]!;
    if (isEmpty(got) && isEmpty(want)) continue;
    const t = isTautology(c.kind, [got, want]);
    if (t.hit) {
      rows.push({
        file, line: c.line, kind: c.kind, verdict: '乙', why: t.why,
        expr: `${flat(got).slice(0, 44)} / ${flat(want).slice(0, 44)}`,
        expected: flat(want).slice(0, 60),
      });
      continue;
    }
    if (looksLikeDualAuthority(got, want)) {
      rows.push({
        file, line: c.line, kind: c.kind, verdict: '丙', why: '两侧分属读取端与运行时端(推定独立)',
        expr: `${flat(got).slice(0, 44)} / ${flat(want).slice(0, 44)}`,
        expected: flat(want).slice(0, 60),
      });
      continue;
    }
    if (isLiteralExpected(want) || isNamedConstExpected(want)) {
      rows.push({
        file, line: c.line, kind: c.kind,
        verdict: '甲',
        why: isNamedConstExpected(want) ? '期望值是**具名常量**(有意引用上游符号)' : '期望值是字面量',
        expr: flat(got).slice(0, 44),
        expected: flat(want).slice(0, 60),
      });
      continue;
    }
    rows.push({
      file, line: c.line, kind: c.kind, verdict: '?', why: '期望值是表达式,来源需人工判',
      expr: `${flat(got).slice(0, 44)} / ${flat(want).slice(0, 44)}`,
      expected: flat(want).slice(0, 60),
    });
  }
  return rows;
}

/* ══════════════════ 检测器区分力自检 ══════════════════ */

type Lab = {
  id: string;
  what: string;
  /** 脏样本:必须判出 `dirtyWant` */
  dirty: string;
  dirtyWant: Verdict;
  /** 干净样本 —— 语义是「**不得**判成 `dirtyWant`」,不管它实际被判成什么。 */
  clean: string;
};

/**
 * 自检不是「多加几条断言」,而是**把分类器本身变成被测对象**。
 * 本仓纪律(`judgement_audit.ts` 骨架):不过自检的检测器,其结果不可信。
 *
 * ⚠️ 我第一版给干净样本也写了 `cleanWant`,并用 `'?'` 当「不关心」的哨兵 ——
 * 结果 3 条假失败(`干净样本被误判为 ?`)。**哨兵值与真实判类撞名**是个经典坑:
 * `'?'` 既表示「无期望」又表示「真实分类结果」,两者不可区分。
 * ⇒ 改法:干净样本只声明**否命题**(「不得是 dirtyWant」),不声明正命题。
 */
const LABS: readonly Lab[] = [
  {
    id: 'L1',
    what: '乙类 · 两侧同一调用',
    dirty: `test('t', () => { eq(fnv1a('abc'), fnv1a('abc'), '稳定'); });`,
    dirtyWant: '乙',
    clean: `test('t', () => { eq(fnv1a('abc'), 12345, '稳定'); });`,
  },
  {
    id: 'L1b',
    what: '★ 不同字符串字面量**不得**被当成同一表达式(掩码过粗)',
    dirty: `test('t', () => { eq(fnv1a('abc'), fnv1a('abd'), '不同输入'); });`,
    dirtyWant: '?',
    clean: `test('t', () => { eq(fnv1a('abc'), fnv1a('abc'), '同输入'); });`,
  },
  {
    id: 'L2',
    what: '乙类 · ok(true) 字面真',
    dirty: `test('t', () => { ok(true, '合法'); });`,
    dirtyWant: '乙',
    clean: `test('t', () => { ok(x > 0, '正数'); });`,
  },
  {
    id: 'L3',
    what: '乙类 · 长度恒非负',
    dirty: `test('t', () => { ok(arr.length >= 0, '可用'); });`,
    dirtyWant: '乙',
    clean: `test('t', () => { ok(arr.length >= 1, '非空'); });`,
  },
  {
    id: 'L4',
    what: '乙类 · eq(o.x, o.x) 两侧同一成员路径',
    dirty: `test('t', () => { eq(g.batch.topQuads, g.batch.topQuads, '一致'); });`,
    dirtyWant: '乙',
    clean: `test('t', () => { eq(g.batch.topQuads, expected.topQuads, '一致'); });`,
  },
  {
    id: 'L4b',
    what: '★ 别名比较规则已删 —— 干净样本(`g.batch.x` vs `batch.x`,两个不同函数)不得被误报',
    dirty: `test('t', () => { eq(g.batch.topQuads, g.batch.topQuads, '恒真'); });`,
    dirtyWant: '乙',
    clean: `test('t', () => { eq(g.batch.topQuads, batch.topQuads, '互验'); });`,
  },
  {
    id: 'L4c',
    what: '★ 手册对照表形态(`m!.mu` vs 硬编码 `mu`)不得被误报为同源',
    dirty: `test('t', () => { eq(m!.mu, m!.mu, '恒真'); });`,
    dirtyWant: '乙',
    clean: `test('t', () => { near(m!.mu, mu, 1e-12, '手册'); });`,
  },
  {
    id: 'L5',
    what: '甲类 · 期望值是字面量',
    dirty: `test('t', () => { eq(add(1, 2), 3, '和'); });`,
    dirtyWant: '甲',
    clean: `test('t', () => { eq(add(1, 2), answer, '和'); });`,
  },
  {
    id: 'L6',
    what: '甲类 · 期望值是具名常量',
    dirty: `test('t', () => { eq(levelOf(u), MAX_LEVEL, '上限'); });`,
    dirtyWant: '甲',
    clean: `test('t', () => { eq(levelOf(u), r.level, '上限'); });`,
  },
  {
    id: 'L7',
    what: '★ 注释里的断言**不得**被计入',
    dirty: `test('t', () => { ok(x > 0, '正'); });`,
    dirtyWant: '?',
    clean: `test('t', () => { /* eq(a, a) 反例说明 */ ok(x > 0, '正'); });`,
  },
  {
    id: 'L8',
    what: '★ 字符串里的断言文本**不得**被计入',
    dirty: `test('t', () => { ok(x > 0, 'x'); });`,
    dirtyWant: '?',
    clean: `test('t', () => { const s = "eq(a, a)"; ok(s.length > 0, 'x'); });`,
  },
  {
    id: 'L9',
    what: '★ 成员方法调用 eq 不得被当成断言',
    dirty: `test('t', () => { ok(x > 0, 'x'); });`,
    dirtyWant: '?',
    clean: `test('t', () => { const r = matcher.eq(a, a); ok(r, 'x'); });`,
  },
];

type LabResult = { id: string; ok: boolean; detail: string };

function runLab(l: Lab): LabResult {
  let dirtyRows: Row[];
  let cleanRows: Row[];
  try {
    dirtyRows = classify('<dirty>', l.dirty);
    cleanRows = classify('<clean>', l.clean);
  } catch (e) {
    return { id: l.id, ok: false, detail: `抛错:${(e as Error).message.slice(0, 90)}` };
  }
  const show = (rs: Row[]): string => rs.map((r) => r.verdict).join('/') || '无';

  /* 正命题:脏样本必须判出 `dirtyWant`(`'?'` 表示「必须有断言被判为待人工判」) */
  const dirtyOk = dirtyRows.some((r) => r.verdict === l.dirtyWant);
  if (!dirtyOk) {
    return {
      id: l.id, ok: false,
      detail: `脏样本**未被判为 ${l.dirtyWant}**(实得 ${show(dirtyRows)})`
        + ' ⇒ 该检测器抓不到它声称要抓的东西',
    };
  }
  /* 否命题:干净样本不得判成同一个目标类 */
  const cleanBad = cleanRows.some((r) => r.verdict === l.dirtyWant && l.dirtyWant !== '?');
  if (cleanBad) {
    return { id: l.id, ok: false, detail: `干净样本被误判为 ${l.dirtyWant}(实得 ${show(cleanRows)})⇒ 噪音检测器` };
  }
  return { id: l.id, ok: true, detail: `脏=${show(dirtyRows)} 净=${show(cleanRows)}` };
}

/* ══════════════════ 甲类上游常量索引 ══════════════════ */

/**
 * 建「常量名 → 定义点」索引。⚠️ 用它回答「谁改了会过期」,
 * **不用它**做「值相等」匹配(那样噪音 85%,见文件头教训 1)。
 */
function buildConstIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  const roots = ['shared', join('server', 'src')];
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, out);
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  const re = /\bexport\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/g;
  for (const r of roots) {
    for (const f of walk(join(ROOT, r))) {
      const src = readFileSync(f, 'utf8');
      const code = codeOf(src);
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const line = code.slice(0, m.index).split('\n').length;
        if (!idx.has(m[1]!)) idx.set(m[1]!, `${relative(ROOT, f).split(sep).join('/')}:${line}`);
      }
    }
  }
  return idx;
}

/* ══════════════════ 单一来源检测:同一判据两份实现 ══════════════════ */

/**
 * Lead 特别点名的一类,**比「没牙的断言」更危险**:
 * ```
 * 同一个判据有两份实现、口径不同 ⇒ 两份都在用、有一份对、门禁全绿
 * 样板:extractRelativeImports 在 verify.ts 里认全形态,在 deadcode-audit.ts 里
 *       只认 from ⇒ 后者把可达模块报成「真缺陷」
 * ```
 * 判据:同族函数名在 **≥2 个文件** 各定义一次。
 * ⚠️ 这**只是候选清单** —— 同名不等于是同一份判据(如 `walk` 各有用途)。
 *    ⇒ 报告里必须标「候选,需人工判口径」,不得直接断言重复。
 */
const FAMILIES: readonly { id: string; what: string; re: RegExp }[] = [
  {
    id: '剥注释/掩码',
    what: '把注释(或字符串)空白化的工具',
    re: /\b(?:function|const)\s+(strip(?:Comments?|ToCode)?\w*|maskComments|codeOnlyMask|codeKeepStrings|stripCommentsOnly|stripCommentsAndStrings)\s*[=(]/,
  },
  {
    id: '相对 import 提取',
    what: '从源码文本抽出相对导入路径',
    re: /\b(?:function|const)\s+(\w*(?:[Ii]mport)\w*)\s*[=(]/,
  },
  {
    id: '目录遍历',
    what: '递归列目录',
    re: /\b(?:function|const)\s+(walk\w*|scanDir\w*|walkTs|walkClient)\s*[=(]/,
  },
  {
    id: '根目录定位',
    what: '算出仓库根(Windows 上极易错)',
    re: /\b(?:const|function)\s+(\w+)\s*[=(][^\n]*fileURLToPath/,
  },
  {
    id: '文件哈希',
    what: '取文件 SHA-256',
    re: /\b(?:function|const)\s+(sha256|sha256Of|fileHash\w*|hashOf\w*)\s*[=(]/,
  },
];

type DupGroup = { id: string; what: string; sites: { file: string; line: number; name: string }[] };

function findDupGroups(files: readonly string[]): DupGroup[] {
  const out: DupGroup[] = [];
  for (const fam of FAMILIES) {
    const sites: { file: string; line: number; name: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const code = codeOf(src);
      const lines = code.split('\n');
      lines.forEach((l, i) => {
        const m = fam.re.exec(l);
        if (m === null) return;
        sites.push({ file: relative(ROOT, f).split(sep).join('/'), line: i + 1, name: m[1] ?? '(?)' });
      });
    }
    const fileCount = new Set(sites.map((s) => s.file)).size;
    if (fileCount >= 2) out.push({ id: fam.id, what: fam.what, sites });
  }
  return out;
}

/* ══════════════════ 运行 ══════════════════ */

const testFiles = existsSync(TEST_DIR)
  ? readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts')).map((f) => join(TEST_DIR, f))
  : [];

const allScanned = [
  ...testFiles,
  ...FAMILIES.flatMap(() => [] as string[]),
];

/* ★ 覆盖面自检:扫到 0 个文件必须**失败**,不能「顺利完成并报 0 处命中」。 */
if (testFiles.length === 0) {
  console.log('✗ 扫到 0 个测试文件 —— ROOT 或 TEST_DIR 算错了。');
  console.log(`  ROOT = ${ROOT}`);
  console.log('  ⇒ 空结果**不是**「没问题」,是判据没运行。');
  process.exit(1);
}

const shaOf = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const before = new Map(testFiles.map((f) => [f, shaOf(f)]));

console.log('[断言值来源审计] 只读,不修改任何文件');
console.log(`  扫描根:tests/   文件数:${testFiles.length}\n`);

/* ── 1. 自检 ── */
console.log('[自检] 分类器区分力(脏样本必命中 / 干净样本必不误报)');
const labResults = LABS.map(runLab);
let labFail = 0;
for (const r of labResults) {
  if (r.ok) console.log(`  ✓ ${r.id}  ${r.detail}`);
  else { labFail += 1; console.log(`  ✗ ${r.id}  ${r.detail}`); }
}
if (labFail > 0) {
  console.log(`\n  ⚠️ ${labFail} 个检测器未过自检 —— **下面的结果不可信**,请先修检测器`);
}

/* ── 2. 全量分类 ── */
const rows: Row[] = [];
for (const f of testFiles) {
  const src = readFileSync(f, 'utf8');
  /* 跳过本审计器自身(不在 tests/ 下,保险起见仍判) */
  for (const r of classify(relative(ROOT, f).split(sep).join('/'), src)) rows.push(r);
}

const bySuite = new Map<string, Record<Verdict, number>>();
for (const r of rows) {
  const suite = r.file.replace(/^tests\//, '');
  if (!bySuite.has(suite)) bySuite.set(suite, { 甲: 0, 乙: 0, 丙: 0, '?': 0 });
  bySuite.get(suite)![r.verdict] += 1;
}

console.log('\n[a] 三分类逐套件统计');
console.log('    套件                        甲     乙     丙      ?  ');
const suiteNames = [...bySuite.keys()].sort();
const tot = { 甲: 0, 乙: 0, 丙: 0, '?': 0 };
for (const s of suiteNames) {
  const c = bySuite.get(s)!;
  tot.甲 += c.甲; tot.乙 += c.乙; tot.丙 += c.丙; tot['?'] += c['?'];
  console.log(`    ${s.padEnd(26)} ${String(c.甲).padStart(5)} ${String(c.乙).padStart(5)}`
    + ` ${String(c.丙).padStart(5)} ${String(c['?']).padStart(6)}`);
}
console.log(`    ${'— 合计'.padEnd(25)} ${String(tot.甲).padStart(5)} ${String(tot.乙).padStart(5)}`
  + ` ${String(tot.丙).padStart(5)} ${String(tot['?']).padStart(6)}`);
const totalRows = tot.甲 + tot.乙 + tot.丙 + tot['?'];
console.log(`    断言总数(已分类)= ${totalRows}`);

/* ── 3. 乙类逐条(优先)── */
const taut = rows.filter((r) => r.verdict === '乙');

/**
 * ★ 本轮最重要的发现:**乙类不能一律报成「缺陷」**。
 *
 * 实测(tests/WS-FND-02:401 `eq(run(), run())`,run 内建 EventBus):
 * ```
 * 往 EventBus 里注入 `Math.random()` 派生的事件帧号 ⇒ **该断言红了**
 * ⇒ 它**守得住**「不引入非确定性」这一真实缺陷类
 * ⇒ 它不是「没牙」,是「守确定性」的一半
 * ```
 * 故乙类必须再细分:
 * ```
 * 乙-守确定性  邻近有「同函数不同输入」对照,或被测函数含非确定源
 *              ⇒ **保留价值明确**:别删
 * 乙-真空      两侧必然相等且不守任何真实缺陷类
 *              ⇒ 应删或补第三方对照
 * ```
 * ⚠️ 「邻近有没有对照」用 ±4 行启发式判 —— **这是启发式,不是证明**。
 *    报告里按「有无对照」分栏,**不代表无对照的就一定是缺陷**。
 */
function neighborGuard(lines: string[], line1: number, fn: string): { text: string; at: number } | null {
  for (let d = -4; d <= 4; d += 1) {
    if (d === 0) continue;
    const L = lines[line1 - 1 + d];
    if (L === undefined) continue;
    const f = flat(L);
    if (!f.includes(fn + '(')) continue;
    if (f.includes('!==') || f.includes('!=')) return { text: f.slice(0, 88), at: line1 + d };
  }
  return null;
}

console.log(`\n[b] ★ 乙类(两侧同源)逐条 —— 共 ${taut.length} 条`);
console.log('    ⚠️ 读法:**乙类不都是缺陷**。实测:往被测算注入真非确定性后,');
console.log('       `eq(run(), run())` **会红** ⇒ 它守得住「不引入非确定性」,不是没牙。');
console.log('       ⇒ 本节按「邻近有无敏感性对照」分栏;**无对照 ≠ 一定是缺陷**。');
let withGuard = 0;
let noGuard = 0;
for (const r of taut) {
  const src = readFileSync(join(ROOT, r.file), 'utf8');
  const lines = src.split(/\r?\n/);
  const fn = /^([\w$.]+)\(/.exec(r.expr)?.[1] ?? flat(r.expr).slice(0, 12);
  const g = neighborGuard(lines, r.line, fn);
  if (g !== null) withGuard += 1; else noGuard += 1;
  console.log(`    ${g !== null ? '[有对照]' : '[**无对照**]'} ${r.file}:${r.line}  [${r.kind}]`);
  console.log(`        ${r.why}`);
  console.log(`        表达式:${r.expr}`);
  if (g !== null) console.log(`        对照 L${g.at}:${g.text}`);
}
console.log(`\n    小计:有邻近对照 ${withGuard} 条 / **无对照 ${noGuard} 条**(后者是待人工判的重点)`);

/* ── 4. 甲类分组(按「上游谁改了会过期」)── */
const constIdx = buildConstIndex();
console.log(`\n[c] 甲类分组(上游常量索引:${constIdx.size} 个具名常量)`);
const namedConst = rows.filter((r) => r.verdict === '甲' && CAP_CONST.test(r.expected));
const usedNames = new Map<string, Row[]>();
for (const r of namedConst) {
  if (!usedNames.has(r.expected)) usedNames.set(r.expected, []);
  usedNames.get(r.expected)!.push(r);
}
const unusedInTests = [...constIdx.keys()].filter((k) => !usedNames.has(k));
console.log(`    甲类总数 = ${tot.甲}`);
console.log(`      其中期望值是**具名常量** = ${namedConst.length}(涉 ${usedNames.size} 个符号)`);
console.log(`      其中期望值是**纯字面量** = ${tot.甲 - namedConst.length}`);
console.log(`    具名常量被测试引用:`);
for (const [name, rs] of [...usedNames].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
  console.log(`      ${String(rs.length).padStart(4)}×  ${name.padEnd(30)} ${constIdx.get(name) ?? '(定义未在 shared/server 顶层找到)'}`);
}
console.log(`    ⚠️ 上游有定义但**测试一次都没引用**的常量 = ${unusedInTests.length} 个`);
console.log('       ⇒ 这些常量的值若漂移,没有任何测试会红');

/* ── 5. 单一来源检测 ── */
const allTs = testFiles;
const dupGroups = findDupGroups(allTs);
console.log('\n[e] ★ 单一来源候选:同一判据两份实现');
console.log('    ⚠️ 这是**候选清单**,不是缺陷清单 —— 同名不等于是同一份判据。');
for (const g of dupGroups) {
  const files = [...new Set(g.sites.map((s) => s.file))];
  console.log(`    ${g.id}(${g.what})—— ${g.sites.length} 处 / ${files.length} 个文件`);
  for (const s of g.sites) console.log(`        ${s.file}:${s.line}  ${s.name}`);
}

/* ── 6. 只读自证 ── */
const changed: string[] = [];
for (const [f, h0] of before) if (shaOf(f) !== h0) changed.push(relative(ROOT, f).split(sep).join('/'));
console.log('\n[只读自证]');
if (changed.length === 0) {
  console.log(`  ✓ ${testFiles.length} 个文件运行前后 SHA-256 全部一致 —— 本脚本未修改任何文件`);
} else {
  console.log(`  ✗ ${changed.length} 个文件变化(不应发生):${changed.slice(0, 5).join(', ')}`);
}

/* ── 7. 汇总 ── */
console.log('\n[汇总]');
console.log(`  自检未过检测器:${labFail} / ${LABS.length}`);
console.log(`  甲(字面量/具名常量期望值):${tot.甲}`);
console.log(`  乙(两侧同源):${tot.乙}   ← 分栏:有邻近对照 ${withGuard} / 无对照 ${noGuard}`);
console.log(`  丙(两侧独立权威,推定):${tot.丙}`);
console.log(`  ?(需人工判):${tot['?']}`);
console.log(`  单一来源候选组:${dupGroups.length}`);
console.log('');
console.log('  ⚠️ 判据边界(报告必须同时给出):');
console.log('    · 甲类 = **「期望值是字面量/具名常量」,是待判清单,不是缺陷清单**');
console.log('      它是**正常且推荐**的写法;只有「上游一改就过期」时才成为隐患');
console.log('    · 乙类 = 已在自检中证明分类器可靠;但「无邻近对照」是**启发式**');
console.log('    · 丙类 = **不可机械判定**,本脚本只做保守正向识别 ⇒ 只报 8 条,远少于实际');
console.log('    · 「?」= 本脚本判据看不见,占 35% ⇒ **它的存在就是这份报告的适用范围声明**');

const bad = labFail > 0 || changed.length > 0;
if (STRICT && (bad || tot.乙 > 0)) {
  console.log(`\n[--strict] ${bad ? '自检失败或只读被破坏' : `有 ${tot.乙} 条乙类命中`} ⇒ exit 1`);
  process.exit(1);
}
if (bad) process.exit(1);
void allScanned;
console.log('\n✓ 审计完成(未加 --strict,命中不导致失败)');
