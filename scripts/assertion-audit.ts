/**
 * 跨套件断言「值来源」审计 —— 常驻只读脚本(task-62 建,task-66 扩)。
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
 *    ⇒ ★**不是一个语义类**,task-66 起三分(见下)
 * 丙 两侧来自**两个独立权威**      eq(库值, 运行时权威值) / eq(state.x, bodies.x)
 *    ⇒ 有牙。样板:`eq(库hp, hpAtSave)` + `ok(hpAtSave > 37)`(C25 改后形态)
 * ```
 *
 * ## ★ task-66:乙类三分 + 「标题声称的量」检测器
 *
 * **起因是我自己的工具在 task-65 上误报了一条**:
 * ```
 * tests/WS-09.test.ts:3719
 * test('面板布局:格子尺寸自洽(**格子数 × 格宽 = 网格宽**)', () => {
 *   eq(L.cols * L.rows, L.cols * L.rows, '网格格数 = 列×行');   ← 本脚本报成「乙类」
 * ```
 * 而 task-65 的注入实验证明它**牵涉一个真缺陷**:
 * ```
 * 注入 `gridW = cols*cell + 7`(破坏标题声称的不变量)
 *   ⇒ 该 test **绿**;完整门禁四旗 **exit 0**(17 套件)
 * 对照 `CELL_INSET = 99999` ⇒ 该 test **红**(103/104)⇒ 判红器有效
 * `gridW` 在 tests/ 里 **0 次**出现(生产里 5 次)
 * ```
 * ⇒ 真正的问题**不是「两侧同源」**(那是语法形态),是「**它守错了对象**」。
 * 故乙类按「它到底守了什么」三分:
 * ```
 * 乙-A  两侧同源 ∧ 未见非确定源          ⇒ **兜底档**(≠已证明恒真,是待判)
 * 乙-B  两侧同源 ∧ 被测算含非确定源      ⇒ **守确定性**,保留(实测有牙)
 * 乙-C  两侧同源 ∧ 标题声称的量不在参数中 ⇒ ★**守错对象**(本脚本能证明的那一类)
 * ```
 * 并新增 §[f] 检测器:扫全仓,报「标题方程右侧的量不在断言参数表达式里」的候选。
 *
 * ## ⚠️ 本脚本的判据边界(先读,免得把「没报」当「没问题」)
 *
 * `甲` 与 `乙` 是**可机械判定**的;**`丙` 不可机械判定**(要判两个来源是否
 * 真的独立,需要跨文件数据流分析)。⇒ 本脚本**只做正向检测**:
 * ```
 * 报出的 乙-A/乙-B = **启发式分栏**          —— 不等于已证明
 * 报出的 乙-C      = **能证明的**(标题 vs 参数) —— 但仍需人工确认「是不是真该守」
 * 报出的 甲        = 「期望值是字面量」      —— 是**待判清单**,不是缺陷清单
 * 报出的 [T?]      = 「口径收窄后的候选」    —— **宁可漏报不误报**(见 §[f] 的取舍说明)
 * 未报出的         = 「本脚本的判据看不见它」 —— **不等于它没问题**(尤其丙类)
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
 * 3 ★ (task-66)判「该量是否出现在判据体」时我用了**整个体**(含断言消息字符串)
 *    ⇒ `4096` 因出现在消息模板里而被判「出现了」= **假阴性**
 *    ⇒ 修法:判据体只取**字符串已空白化**的版本 —— **消息文字不是判据**
 * 4 ★ (task-66)第一版 [T?] 口径太宽:全仓报 13 条,逐条读代码只有 **1 条**真的
 *    ⇒ 精度 7.7%。收窄成「右侧必须是一个**项**」⇒ 1 条,精度 100%,**召回率下降**
 * ```
 * ⇒ 故每个检测器都必须过**区分力自检**:脏样本必命中、干净样本必不命中。
 *   **判红器(脏/净样本)是唯一能挡住「空壳检测器」的东西** —— 见 `[自检]` 节。
 *
 * 用法:
 * ```
 * node scripts/assertion-audit.ts            # 报告
 * node scripts/assertion-audit.ts --strict   # 有乙类命中或自检失败即 exit 1
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

/* ══════════════════ ★ 乙类三分(task-66)══════════════════ */

/**
 * ## 为什么必须三分(承 task-65 的实测)
 *
 * 原来的乙类只有一类,把**三个语义完全不同**的东西混在一个数字里:
 * ```
 * 乙-A  两侧同源 ∧ **语义上也同源**(确实恒真)
 *       样板:`eq(L.cols * L.rows, L.cols * L.rows)` 里两侧是**同一个值**
 *       (cols/rows 都是同一对象的字段,没有被测算介入)
 *       定性:**真问题** —— 它不守任何缺陷类
 *
 * 乙-B  两侧同源 ∧ **语义上不同源**(被测算含非确定源)
 *       样板:`tests/WS-FND-02.test.ts:401 eq(run(), run())`,run 内建 EventBus
 *       实测(task-65 §1.2):往 EventBus 注入 `Math.random()` 派生的帧号
 *       ⇒ 该断言 **红了**(65/65 → 63/65)
 *       定性:**无害,且是有价值的** —— 它守「不引入非确定性」
 *
 * ★乙-C 两侧同源 ∧ **它根本不是这个 test 要守的量**(守错对象)
 *       样板:`tests/WS-09.test.ts:3719`
 *         test('面板布局:格子尺寸自洽(**格子数 × 格宽 = 网格宽**)', () => {
 *           eq(L.cols * L.rows, L.cols * L.rows, '网格格数 = 列×行');  ← 3719 里的这句
 *       标题声称守「网格宽」,而 `gridW` 在**全仓 tests/ 里 0 次出现**;
 *       该 test 里另有三条**有牙**断言(3723/3726/3728)给它当掩护
 *       实测(task-65 §4.2):注入 `gridW = cols*cell + 7`(即**破坏标题声称的不变量**)
 *       ⇒ 该 test **绿** + **完整门禁 exit 0**
 *       定性:**最隐蔽的一类** —— 它连「恒真」都不是问题所在,
 *             问题是**这个 test 压根没在守它标题说的那个东西**
 * ```
 *
 * ⚠️ **三类不可机械完全区分**,本脚本只做**启发式分栏**:
 * ```
 * 乙-C 判据(最强、最可靠):该 test 的**标题里有显式方程**,而方程右侧的量
 *      在**断言的参数表达式**里不出现 ⇒ 守错对象
 *       ⇒ 这是**可以证明**的(见 §T 检测器),故优先判
 * 乙-B 判据:两侧同源 ∧ 被测表达式含**非确定源**(Date.now/Math.random/clock/…)
 *       ⇒ 启发式(词法),可能漏(非确定源可能藏在被调函数内部)
 * 乙-A 其余 —— **默认档**,不是「已证明恒真」
 * ```
 * ⚠️ **乙-A 是兜底档不是结论**:本脚本没有跨文件数据流分析,无法证明
 *    「两次调用必然返回同一值」。⇒ 报告里按此分栏,**不代表乙-A 就一定是缺陷**。
 */
const NONDET_SRC = /\b(?:Date\.now|performance\.now|Math\.random|hrtime|new Date|randomUUID|process\.hrtime)\b/;

/** test 的名字字符串 + 判据体(供乙-C 与 §T 检测器共用)。 */
type TestBlock = {
  file: string;
  /** `test(` 所在行(1-based) */
  headLine: number;
  /** 标题字符串所在行(1-based) */
  line: number;
  title: string;
  /** 判据体(含花括号),**原文**(字符串保留) */
  body: string;
  /** 判据体,**字符串与注释已空白化**(位置保持)—— 「量是否被断言」只认这个 */
  argsOnly: string;
  /** 体内的断言行号(1-based) */
  assertLines: number[];
};

/** 位置保持地屏蔽注释与**字符串内容**(保留换行与偏移)。`blankStrings=false` 只屏蔽注释。 */
function maskMore(src: string, blankStrings: boolean): string {
  const out = src.split('');
  let st: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && c2 === '/') { inBlock = false; i += 1; } continue; }
    if (st !== null) {
      if (c === '\\') { if (blankStrings) { out[i] = ' '; if (i + 1 < src.length) out[i + 1] = ' '; } i += 1; continue; }
      if (c === st) { st = null; if (blankStrings) out[i] = ' '; continue; }
      if (blankStrings && c !== '\n') out[i] = ' ';
      continue;
    }
    if (c === '/' && c2 === '/') { inLine = true; out[i] = ' '; out[i + 1] = ' '; i += 1; continue; }
    if (c === '/' && c2 === '*') { inBlock = true; out[i] = ' '; out[i + 1] = ' '; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') { st = c; if (blankStrings) out[i] = ' '; continue; }
  }
  return out.join('');
}

/**
 * 抽出每个 `test('标题', () => { ... })` 的标题与判据体。
 *
 * ⚠️ 必须**手写括号配对**而不是正则:体内有字符串、模板串、块注释,
 * 且本仓的 test 体内含嵌套箭头函数与对象字面量。
 */
function extractTests(file: string, src: string): TestBlock[] {
  const out: TestBlock[] = [];
  const re = /\btest\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    const q = src[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    let j = i + 1;
    let title = '';
    while (j < src.length && src[j] !== q) { title += src[j]; j += 1; }
    if (src[j] !== q) continue;
    const titleLine = src.slice(0, m.index).split('\n').length;
    let k = j + 1;
    while (k < src.length && src[k] !== '{') k += 1;
    if (k >= src.length) continue;
    let depth = 0;
    let end = k;
    let st: string | null = null;
    let inLine = false;
    let inBlock = false;
    for (let p = k; p < src.length; p += 1) {
      const c = src[p]!;
      const c2 = src[p + 1];
      if (inLine) { if (c === '\n') inLine = false; continue; }
      if (inBlock) { if (c === '*' && c2 === '/') { inBlock = false; p += 1; } continue; }
      if (st !== null) { if (c === '\\') { p += 1; continue; } if (c === st) st = null; continue; }
      if (c === '/' && c2 === '/') { inLine = true; p += 1; continue; }
      if (c === '/' && c2 === '*') { inBlock = true; p += 1; continue; }
      if (c === "'" || c === '"' || c === '`') { st = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { end = p; break; } }
    }
    const body = src.slice(k, end + 1);
    const assertLines: number[] = [];
    const dr = /\b(?:eq|near|includes|inRange|ok)\s*\(/g;
    let d: RegExpExecArray | null;
    while ((d = dr.exec(body)) !== null) {
      const before = body.slice(Math.max(0, d.index - 1), d.index);
      if (/[.\w$]/.test(before)) continue;
      assertLines.push(k + d.index === 0 ? 1 : src.slice(0, k + d.index).split('\n').length);
    }
    out.push({
      file, headLine: titleLine, line: titleLine, title, body,
      argsOnly: maskMore(body, true), assertLines,
    });
    re.lastIndex = end + 1;
  }
  return out;
}

/** 把断言行号映射到所属 test 的标题。 */
function testOf(testBlocks: readonly TestBlock[], file: string, assertLine: number): TestBlock | undefined {
  const mine = testBlocks.filter((t) => t.file === file);
  let best: TestBlock | undefined;
  for (const t of mine) if (t.line <= assertLine) { if (best === undefined || t.line > best.line) best = t; }
  /* 确认该断言真的落在 test 体内(而非两 test 之间的顶层代码) */
  if (best === undefined) return undefined;
  const idx = best.assertLines.indexOf(assertLine);
  return idx >= 0 ? best : undefined;
}

/**
 * **乙-C 判据**:标题声称守的量,在断言的**参数表达式**里不出现。
 *
 * 只认**标题里的显式方程** `A = B`(单等号,非 `==`/`<=`/`>=`/`!=`)。
 * 理由(实测校准,2026-11-13):
 * ```
 * 我试过「提取标题里所有名词/数字,查它是否在体内出现」——
 * 在 1249 个 test 上命中 **646 条(52%)**,全是噪音:
 *   `Boss` 36 次 / `task` 20 次 / `FND9` 14 次 —— 是**任务号与文档引用**,不是量
 * ⇒ 砍掉名词/数字提取,只留**方程形态**。
 * ```
 * ⚠️ 这是**启发式**,边界见 `docs/TEETH-METHOD.md` §8 与本文件报告节。
 */
const CN_CHAR = /[\u4e00-\u9fa5]/;

/**
 * **项 vs 表达式 vs 散文**:只有「项」才算一条可判的量声明。
 *
 * ## 为什么需要它(实测,不是审美)
 *
 * 第一版全仓扫出 **13 条**候选,我**逐条读代码核实**,结果 **只有 1 条是真的**
 * (WS-09:3719)= 精度 **1/13 = 7.7%**。12 条误报有**三种共同形态**:
 * ```
 * 形态 1 右侧是**算式**(不是字面量)
 *   `最小间隔 = 0.4s / (1 + bonus)`  ⇒ 体里写作 `BASE_ATTACK_INTERVAL_S * TICK_HZ`
 *   `正交半宽 = 像素/scale` / `行数 = 条目数 + 4`
 *   `基础 = ATK × 等级倍率 × 武器倍率` ⇒ 体里用 totalAtk / levelDamageMul
 *   ⇒ 它们**测了**,只是把量**推导着**表达 ⇒ 不是守错对象
 *
 * 形态 2 右侧是**散文释义**(`=` 当「叫做」用,不是方程)
 *   `每个字段都有 @type 注解(缺注解 = 静默不同步)`
 *   `两类定义的字段**顺序**也一致(装配层的字段顺序 = 字段表 bit 序)`
 *   `位移恰好 = 上界放行 / 上界 + ε 被拒`
 *   `一帧 = 一快帧(不双倍)`
 *   `三方互证:Σcount = ids 并集 = ITEM_LIST.length`
 *   `S1 ...:「槽位 = 件数」在 330 时必是半行`(且 `=` 在**引号**内)
 *   ⇒ **根本不是量声明** ⇒ 报它等于噪音
 *
 * 形态 3 右侧的**名字在体里**,只是尾部黏了一个中文词
 *   `几何数 = buildChunkQuads 数` ⇒ 体里就有 buildChunkQuads
 * ```
 *
 * ## 判据:「右侧必须是一个**项**」
 * ```
 * 项 = 纯中文短语(2~12 字,无空格/无常量名/无算符)
 *    或 纯数值(数字,可紧跟 0~3 个中文单位字,**不得有空格**)
 * 凡含:空白、算符(+ - * / × ÷ ≈ → =)、括号引号、常量名混中文 ⇒ 一律**不是项** ⇒ 不报
 * ```
 *
 * ⚠️ **这条是「收窄」不是「修准」**:它不仅降误报,也会**漏掉真的守错对象**
 * (若某条真的守错对象、而它的标题右侧恰好是算式 ⇒ 本检测器看不见)。
 * ⚠️ **n=13 太小**,上面的精度不足以推广到全仓 —— 报告里两个精度都给出。
 */
const OPERATOR_CHAR = /[-+*/×÷≈→=<>|&^~（）()\[\]【】「」『』“”"'`…、,，。;；:：!！?？]/;

/**
 * **量名词尾**(封闭列表)—— 判「右侧那个中文短语是不是一个**量**」。
 *
 * ## 为什么需要第二道闸(`asTerm` 不够)
 *
 * `asTerm` 放过了一个**谓词/后果**,而它不是量:
 * ```
 * `(缺注解 = 静默不同步)`   ← `=` 在这里是「会怎样」,不是「等于多少」
 *                              LHS 是条件、RHS 是后果 ⇒ **两者都不是量**
 * 而 `(格子数 × 格宽 = 网格宽)` 两侧都是**量**(LHS 含 `×` 由 asTerm 挡掉,
 *   RHS「网格宽」是量)⇒ 才是本文要找的形态
 * ```
 * 中文里没有词形变化,判「是不是量」只能靠**这个词是不是量名词**。
 * 封闭列表 = 本检测器的**主要失效边界**(见文件末报告节)。
 *
 * ⚠️ **已知漏报**(列表不全 ⇒ 该报不报):
 * ```
 * 面积 周长 体积 密度 速度 加速度 时长 概率 份额 排名 距离 …
 * ```
 * ⚠️ **已知误报风险**(这些词也可能是谓词):`位` / `次` / `时`
 */
const QTY_SUFFIX = [
  '数', '量', '值', '宽', '高', '长', '度', '率', '积', '容', '重',
  '大小', '上限', '下界', '阈值', '余量', '总量', '总数', '个数', '格数',
  '层', '格', '块', '条', '件', '个', '次', '帧', '秒', '毫秒',
];

function asTerm(rhs: string): { term: string; kind: '数值' | '名词' } | null {
  /* 形态 1/2/3 的共同特征:含空白或算符/括号 ⇒ 不是项 */
  if (/\s/.test(rhs)) return null;
  if (OPERATOR_CHAR.test(rhs)) return null;
  const num = /^(\d+(?:\.\d+)?)([\u4e00-\u9fa5]{0,3})$/.exec(rhs);
  if (num) return { term: num[1]!, kind: '数值' };
  /* 纯中文短语 **且以量名词尾结尾** */
  if (!/^[\u4e00-\u9fa5]{2,12}$/.test(rhs)) return null;
  const isQty = QTY_SUFFIX.some((s) => rhs.endsWith(s));
  if (!isQty) return null;
  return { term: rhs, kind: '名词' };
}

function claimsMismatch(t: TestBlock): { claimed: string; kind: string } | null {
  const re = /([^=<>!+\-*/]{2,40}?)\s*=\s*([^=]{1,40})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t.title)) !== null) {
    const lhs = m[1]!.trim().replace(/[（(].*$/, '').trim();
    /* 右边界:切到标点/括号 —— ⚠️ 但**不切引号**(引号内的 `=` 是散文,交给 asTerm 拒) */
    const rhsRaw = m[2]!.trim().replace(/[，,。;；)）\]】].*$/, '').trim();
    if (rhsRaw === '' || lhs === '') continue;
    const term = asTerm(rhsRaw);
    if (term === null) continue;
    /* ★ 关键:查 **argsOnly**(字符串已空白化)⇒ **消息文字不算判据**。
       实测我第一版查原文,`4096` 因出现在断言消息模板里而被判「出现了」= 假阴性。 */
    if (t.argsOnly.includes(term.term)) continue;
    return { claimed: term.term, kind: term.kind };
  }
  return null;
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
  /** ★ task-66:乙类的**子类**(乙-A/乙-B/乙-C)。只有 verdict==='乙' 时有值。 */
  sub?: '乙-A' | '乙-B' | '乙-C';
  /** ★ task-66:所属 test 的标题行(用于定位与「声称量」判定)。 */
  testLine?: number;
};

function classify(file: string, src: string): Row[] {
  /* ★ 两份保持位置的掩码:定界用 blank(字符串里的括号不参与深度),
     取值用 keep(不同字符串字面量必须可区分)。见 `splitArgRanges` 的说明。 */
  const codeBlank = maskSource(src, 'blank');
  const codeKeep = maskSource(src, 'keep');
  const rows: Row[] = [];
  /* ★ task-66:先抽 test 块,供乙类三分与「声称量」检测器使用 */
  const tests = extractTests(file, src);
  const tOf = (line: number): TestBlock | undefined => testOf(tests, file, line);
  /** 乙类三分:先判乙-C(可证明),再判乙-B(启发式),余为乙-A(兜底档)。 */
  const subOf = (line: number, exprText: string): { sub: Row['sub']; why: string } => {
    const tb = tOf(line);
    if (tb !== undefined) {
      const mm = claimsMismatch(tb);
      if (mm !== null) {
        return {
          sub: '乙-C',
          why: `★**守错对象**:该 test 标题声称守「${mm.claimed}」(${mm.kind}),`
            + '而它**未出现在任何断言的参数表达式里**'
            + `(标题原文「${tb.title.slice(0, 60)}」)`,
        };
      }
    }
    if (NONDET_SRC.test(exprText)) {
      return { sub: '乙-B', why: '两侧同源,但被测算含**非确定源** ⇒ 守「不引入非确定性」(无害且有价值)' };
    }
    return { sub: '乙-A', why: '两侧同源且**未见**非确定源 ⇒ 兜底档:**不等于已证明恒真**(无跨文件数据流分析)' };
  };
  for (const c of findCalls(codeBlank, codeKeep)) {
    const a = c.args;
    if (c.kind === 'ok') {
      if (isEmpty(a[0] ?? '')) continue;
      const t = isTautology('ok', a);
      if (t.hit) {
        const s = subOf(c.line, a[0]!);
        rows.push({
          file, line: c.line, kind: 'ok', verdict: '乙', sub: s.sub,
          why: `${t.why} —— ${s.why}`,
          expr: flat(a[0]!).slice(0, 90),
          expected: '(布尔条件)',
          testLine: tOf(c.line)?.line,
        });
      } else {
        rows.push({
          file, line: c.line, kind: 'ok', verdict: '?', why: t.why,
          expr: flat(a[0]!).slice(0, 90),
          expected: '(布尔条件)',
          testLine: tOf(c.line)?.line,
        });
      }
      continue;
    }
    if (a.length < 2) continue;
    const got = a[0]!; const want = a[1]!;
    if (isEmpty(got) && isEmpty(want)) continue;
    const t = isTautology(c.kind, [got, want]);
    if (t.hit) {
      const s = subOf(c.line, `${got} ${want}`);
      rows.push({
        file, line: c.line, kind: c.kind, verdict: '乙', sub: s.sub,
        why: `${t.why} —— ${s.why}`,
        expr: `${flat(got).slice(0, 44)} / ${flat(want).slice(0, 44)}`,
        expected: flat(want).slice(0, 60),
        testLine: tOf(c.line)?.line,
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

/**
 * ★ **T 检测器的区分力自检**(task-66)。
 *
 * ⚠️ 这是本脚本里**最容易产出"看起来有道理但错"的清单**的地方 ——
 * 一个中文分词启发式。故自检必须覆盖**两个方向**,且必须有一个
 * **专门用来抓假阴性**的样本(消息字符串里复述了声称的量)。
 *
 * ⚠️ 与 `Lab` 不同的是:T 检测器**不是**给每个断言判类,而是给整个 test 判「标题与体是否相符」。
 * 故它有自己的结构。`want` = 是否**应该**报 `[T?]`。
 */
type TLab = { id: string; what: string; src: string; want: boolean };

const T_LABS: readonly TLab[] = [
  {
    id: 'T1',
    what: '★ 假阴性防线:标题声称的量**只出现在断言消息字符串**里 ⇒ 仍须报',
    /* 这正是我在 WS-01:874 上踩的坑:消息模板复述了「4096」,
       若把消息算作判据就会漏报。⚠️ 但用了「9999」当右侧 ⇒ 须是**项**(数值+单位字)。 */
    src: `test('序列化 4096 分片的耗时 = 9999毫秒', () => {
  ok(ms < 3000, \`4096 次序列化耗时 \${ms.toFixed(1)}ms 应在预算内\`);
});`,
    want: true,
  },
  {
    id: 'T2',
    what: '干净样本:标题方程右侧的量**在断言参数里** ⇒ 不得报',
    src: `test('举起链 4 层叠罗汉高度 = 2.55 格', () => {
  near(STACK_4_TOP_Z, 2.55, 1e-12, '顶层');
});`,
    want: false,
  },
  {
    id: 'T3',
    what: '★ 真阳性:标题声称「网格宽」而体内只有 cols*rows ⇒ 报',
    src: `test('面板布局:格子尺寸自洽(格子数 × 格宽 = 网格宽)', () => {
  eq(L.cols * L.rows, L.cols * L.rows, '网格格数 = 列×行');
  ok(CELL_INSET * 2 < L.cell, '内缩');
});`,
    want: true,
  },
  {
    id: 'T4',
    what: '★ 干净样本:**无方程形态**的标题(纯中文) ⇒ 不得报(本检测器的盲区)',
    src: `test('面板布局:画布与调色盘都不超出面板', () => {
  ok(L.canvas.x >= L.panel.x, '画布左边界在面板内');
});`,
    want: false,
  },
  {
    id: 'T5',
    what: '★ 干净样本:注释里的方程**不得**参与判定',
    src: `test('序列化长度自洽', () => {
  /* 早期版本: 长度 = 9999 是错的 */
  eq(buf.length, 1024, '长度');
});`,
    want: false,
  },
  {
    id: 'T6',
    what: '★ 干净样本(**实测误报形态 1**):方程右侧是**算式** ⇒ 不得报',
    /* 全仓实扫的第 1 号误报:`最小间隔 = 0.4s / (1 + bonus)`
       体里写作 `BASE_ATTACK_INTERVAL_S * TICK_HZ` —— **它测了**,只是推导着表达。 */
    src: `test('E07 攻速上限被拒:最小间隔 = 0.4s / (1 + bonus)', () => {
  const minTicks = BASE_ATTACK_INTERVAL_S * TICK_HZ;
  eq(minTicks, 8);
});`,
    want: false,
  },
  {
    id: 'T7',
    what: '★ 干净样本(**实测误报形态 2**):`=` 当「叫做」用(散文释义)⇒ 不得报',
    /* 全仓实扫的误报:`(缺注解 = 静默不同步)` / `(装配层的字段顺序 = 字段表 bit 序)` */
    src: `test('H07 每个字段都有 @type 注解(缺注解 = 静默不同步)', () => {
  ok(f.type !== null, '缺注解');
});`,
    want: false,
  },
  {
    id: 'T8',
    what: '★ 干净样本(**实测误报形态 3**):名字在体里,尾部黏了中文词 ⇒ 不得报',
    /* 全仓实扫的误报:`几何数 = buildChunkQuads 数`,体里就有 buildChunkQuads */
    src: `test('顶点填充:写出与计数同源(几何数 = buildChunkQuads 数)', () => {
  eq(g.faceCount, batch.faceCount, '面数一致');
});`,
    want: false,
  },
  {
    id: 'T9',
    what: '★ 干净样本:`=` 出现在**引号内** ⇒ 不得报',
    src: `test('S1 判据区分力自检:「槽位 = 件数」在半行时必红', () => {
  ok(halfRow, '半行');
});`,
    want: false,
  },
];

function runTLab(l: TLab): LabResult {
  let got: boolean;
  let claimed = '';
  try {
    const tbs = extractTests('<t>', l.src);
    if (tbs.length !== 1) return { id: l.id, ok: false, detail: `抽出 ${tbs.length} 个 test(应 1)` };
    const mm = claimsMismatch(tbs[0]!);
    got = mm !== null;
    claimed = mm?.claimed ?? '';
  } catch (e) {
    return { id: l.id, ok: false, detail: `抛错:${(e as Error).message.slice(0, 90)}` };
  }
  if (got !== l.want) {
    return {
      id: l.id, ok: false,
      detail: `期望报=${l.want} 实得报=${got}${claimed ? `(声称「${claimed}」)` : ''}`
        + ` ⇒ ${l.want ? '**漏报**(口径太窄)' : '**误报**(口径太宽)'}`,
    };
  }
  return { id: l.id, ok: true, detail: `报=${got}${claimed ? `「${claimed}」` : ''}` };
}

/** ★ 乙类三分的区分力自检:每条都必须判出**指定子类**。 */
type SubLab = { id: string; what: string; src: string; want: '乙-A' | '乙-B' | '乙-C'; line?: number };

const SUB_LABS: readonly SubLab[] = [
  {
    id: 'S1',
    what: '★乙-C 守错对象:标题方程右侧的量不在断言参数里',
    src: `test('格子尺寸自洽(格子数 × 格宽 = 网格宽)', () => {
  eq(L.cols * L.rows, L.cols * L.rows, '网格格数');
});`,
    want: '乙-C',
  },
  {
    id: 'S2',
    what: '乙-B 非确定源:被测算用 Math.random',
    src: `test('同输入必同输出', () => {
  eq(runWith(Math.random), runWith(Math.random), '一致');
});`,
    want: '乙-B',
  },
  {
    id: 'S3',
    what: '★乙-A 兜底档:无方程、无非确定源',
    src: `test('幂等', () => {
  eq(normalize(x), normalize(x), '一致');
});`,
    want: '乙-A',
  },
  {
    id: 'S4',
    what: '★乙-C 优先于乙-B:两者同时成立时判乙-C(可证明的优先)',
    /* ⚠️ 我第一版这条样本写成 `test('值自洽(输入 = 输出)')` ⇒ **样本本身坏了**:
       `输出` 不在 `QTY_SUFFIX` 里(它不是量名词)⇒ asTerm 拒它 ⇒ 落到乙-B。
       **是样本错,不是优先级错** —— 改右侧为量名词「宽度」后两者同时成立。 */
    src: `test('值自洽(输入 = 宽度)', () => {
  eq(runWith(Math.random), runWith(Math.random), '一致');
});`,
    want: '乙-C',
  },
];

function runSubLab(l: SubLab): LabResult {
  let rows: Row[];
  try { rows = classify('<sub>', l.src); } catch (e) {
    return { id: l.id, ok: false, detail: `抛错:${(e as Error).message.slice(0, 90)}` };
  }
  const tautRows = rows.filter((r) => r.verdict === '乙');
  if (tautRows.length === 0) return { id: l.id, ok: false, detail: '未判出任何乙类(脏样本) ⇒ 检测器空壳' };
  const got = tautRows[0]!.sub ?? '(无)';
  if (got !== l.want) {
    return { id: l.id, ok: false, detail: `期望 ${l.want} 实得 ${got}` };
  }
  return { id: l.id, ok: true, detail: got };
}

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
const labResults = [
  ...LABS.map(runLab),
  ...T_LABS.map(runTLab),
  ...SUB_LABS.map(runSubLab),
];
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

console.log(`\n[b] ★ 乙类(两侧同源)**三分** —— 共 ${taut.length} 条`);
console.log('    ⚠️ 读法:**乙类不是一个语义类**。task-65 实测:往被测算注入真非确定性后,');
console.log('       `eq(run(), run())` **会红** ⇒ 它守得住「不引入非确定性」,不是没牙。');
console.log('       故按「它到底守了什么」分三栏:');
console.log('         [乙-A] 两侧同源 ∧ 未见非确定源 ⇒ **兜底档**(≠已证明恒真,是待判)');
console.log('         [乙-B] 两侧同源 ∧ 被测算含非确定源 ⇒ **守确定性**,保留(实测有牙)');
console.log('         [乙-C] ★**守错对象** —— 标题声称守 X,而 X 未出现在断言的参数表达式里');
let withGuard = 0;
let noGuard = 0;
const subCount = { '乙-A': 0, '乙-B': 0, '乙-C': 0 };
for (const r of taut) {
  const src = readFileSync(join(ROOT, r.file), 'utf8');
  const lines = src.split(/\r?\n/);
  const fn = /^([\w$.]+)\(/.exec(r.expr)?.[1] ?? flat(r.expr).slice(0, 12);
  const g = neighborGuard(lines, r.line, fn);
  if (g !== null) withGuard += 1; else noGuard += 1;
  const sub = r.sub ?? '乙-A';
  subCount[sub] += 1;
  console.log(`    [${sub}] ${g !== null ? '[有邻近对照]' : '[无邻近对照]'} ${r.file}:${r.line}  [${r.kind}]`);
  if (r.testLine !== undefined) {
    const tl = lines[r.testLine - 1] ?? '';
    const tm = /test\('([^']*)'/.exec(tl);
    if (tm) console.log(`        所属 test L${r.testLine}:「${tm[1]!.slice(0, 78)}」`);
  }
  console.log(`        ${r.why}`);
  console.log(`        表达式:${r.expr}`);
  if (g !== null) console.log(`        对照 L${g.at}:${g.text}`);
}
console.log(`\n    小计:乙-A(兜底档)${subCount['乙-A']} 条 / 乙-B(守确定性)${subCount['乙-B']} 条`
  + ` / ★乙-C(守错对象)${subCount['乙-C']} 条`);
console.log(`        邻近对照:有 ${withGuard} 条 / 无 ${noGuard} 条(后者是待人工判的重点)`);
if (subCount['乙-B'] === 0) {
  console.log('');
  console.log('    ⚠️⚠️ **乙-B = 0 条不可读成「本仓没有守确定性的断言」** —— 事实相反:');
  console.log('        `tests/WS-FND-02.test.ts:401 eq(run(), run())` **就是**乙-B,');
  console.log('        它被本脚本判成了 **乙-A**。原因:**`NONDET_SRC` 只看断言的表达式文本**');
  console.log('        (`run() / run()`),而那个非确定源(`Math.random`)藏在');
  console.log('        `EventBus` 的 `emit` 里 —— **被调函数内部**。');
  console.log('        ⇒ 词法检测器**看不进被调函数** ⇒ 这一栏是**下界**,且可能极低。');
  console.log('        ⇒ 要真判「它守不守确定性」,只能做注入实验(task-65 §1.2 就是这么做的:');
  console.log('           往 EventBus 注入 Math.random 派生的帧号 ⇒ 该断言**红了**,65/65 → 63/65)');
}
if (subCount['乙-C'] > 0) {
  console.log('    ★ **乙-C 是本脚本能证明的那一类** —— 其余两类是启发式分栏。');
}

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

/* ── 5b. ★ T 检测器:「标题声称的量」与「判据体」不符(task-66)── */
/**
 * **这是候选清单,不是缺陷清单。**
 *
 * 判据(精确形态,只认一种):test 标题里有**显式方程** `A = B`,
 * 而方程右侧的量**未出现在该 test 任何断言的参数表达式里**。
 *
 * ⚠️ **提取口径与它为什么这么窄**(实测校准,2026-11-13,1249 个 test):
 * ```
 * 我试过「提取标题里所有名词/数字,查是否在体内出现」⇒ 命中 646 条 = **52%**
 *   全是噪音:`Boss` 36 次 / `task` 20 次 / `FND9` 14 次 —— **任务号与文档引用**
 * ⇒ 砍掉名词/数字提取,只留**方程形态** `A = B`
 * ```
 * ⚠️ **已知误报形态**(写在这里,免得下一个人重新踩):
 * ```
 * 1 `A = B` 里的 B 是**中文量词短语**而体里用**英文标识符**表达同一量
 *    例:标题「... 行数 = 条目数 + 4」而体用 `rows.length`
 *    ⇒ 这类会把**同名但不同书写**的量报成不符
 * 2 方程右侧是**算式**(如 `A = B × C`)⇒ 当前口径取到 `B`,可能误报
 * 3 标题含 `=` 但**不是方程**(如「X 不变」「default=」)⇒ 靠「右侧须为数值或中文名词」过滤,
 *    仍可能漏过
 * 4 **多行标题 / 模板串标题** ⇒ `extractTests` 只认单引号/双引号/反引号的**单行**标题
 * ```
 * ⚠️ **失效边界**:
 * ```
 * · 本检测器**看不见没有方程形态的守错对象**(如「属性 A 与 B 自洽」这类纯中文标题)
 *   ⇒ 它是**下界**,不是总数(与丙类 8 条同性质)
 * · 「量未出现在参数表达式里」**不等于**「这个量没被测」 ——
 *   它可能被**间接**测(体里算了别的派生量,隐含该量正确)
 *   ⇒ 必须人工复核,这是 `[T?]` 而非「缺陷」的原因
 * · 中文分词不可靠 ⇒ **宁可漏报,不制造误报**(与乙类删掉 `endsWith` 规则同一取向)
 * ```
 */
const tCands: { file: string; testLine: number; title: string; claimed: string; kind: string
  ; actuals: string }[] = [];
for (const f of testFiles) {
  const rel = relative(ROOT, f).split(sep).join('/');
  const src = readFileSync(f, 'utf8');
  for (const tb of extractTests(rel, src)) {
    const mm = claimsMismatch(tb);
    if (mm === null) continue;
    /* 采集「体里实际出现的量」作为对照证据(取该 test 的断言名/字面量) */
    const actuals: string[] = [];
    const lits = tb.argsOnly.match(/\b[A-Z][A-Z0-9_]{2,}\b|\b\d+(?:\.\d+)?\b/g) ?? [];
    for (const x of lits) if (!actuals.includes(x)) actuals.push(x);
    tCands.push({
      file: rel, testLine: tb.line, title: tb.title,
      claimed: mm.claimed, kind: mm.kind,
      actuals: actuals.slice(0, 14).join(' '),
    });
  }
}
console.log(`\n[f] ★ [T?] 「标题声称的量」不在判据参数中 —— 候选 ${tCands.length} 条(**需人工复核,不是缺陷**)`);
console.log('    判据:标题里有显式方程 `A = B`,而右侧的量未出现在本条 test 的**断言参数表达式**里。');
console.log('    ⚠️ 只查参数表达式,**不查断言消息字符串** —— 消息文字不是判据');
console.log('       (我第一版查了原文,`4096` 因出现在消息模板里而被判「出现了」= 假阴性)。');
console.log('    ⚠️ **口径是**「右侧必须是一个**项**」(纯中文量名 或 数值+单位字,无空白无算符)。');
console.log('       不这样收窄的话:第一版全仓报 **13 条**,我逐条读代码核实只有 **1 条是真的**');
console.log('       ⇒ 精度 7.7%。那 12 条误报有**三种共同形态**(算式 / 散文释义 / 名字+中文尾),');
console.log('         都已作为 T6~T9 自检样本钉住。**代价是召回率下降**(见报告)。');
for (const c of tCands) {
  console.log(`    ${c.file}:${c.testLine}  [${c.kind}]`);
  console.log(`        标题:${c.title.slice(0, 92)}`);
  console.log(`        声称守:「${c.claimed}」`);
  console.log(`        为什么可疑:该量在断言的**参数表达式**里 0 次出现`);
  if (c.actuals) console.log(`        体里实际出现的量:${c.actuals}`);
}
if (tCands.length === 0) {
  console.log('    (0 条 —— ⚠️ 先确认检测器没坏:跑 `--selfcheck-t` 或看 [自检] 节)');
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
console.log(`  自检未过检测器:${labFail} / ${labResults.length}`
  + `(分类器 ${LABS.length} + ★T 检测器 ${T_LABS.length} + ★乙类三分 ${SUB_LABS.length})`);
console.log(`  甲(字面量/具名常量期望值):${tot.甲}`);
console.log(`  乙(两侧同源):${tot.乙}`
  + `   ← ★三分:乙-A(兜底档)${subCount['乙-A']} / 乙-B(守确定性)${subCount['乙-B']} / **乙-C(守错对象)${subCount['乙-C']}**`);
console.log(`      邻近对照:有 ${withGuard} / 无 ${noGuard}`);
console.log(`  丙(两侧独立权威,推定):${tot.丙}`);
console.log(`  ?(需人工判):${tot['?']}`);
console.log(`  ★[T?] 「标题声称的量不在判据参数中」候选:${tCands.length} 条(待人工复核)`);
console.log(`  单一来源候选组:${dupGroups.length}`);
console.log('');
console.log('  ⚠️ 判据边界(报告必须同时给出):');
console.log('    · 甲类 = **「期望值是字面量/具名常量」,是待判清单,不是缺陷清单**');
console.log('      它是**正常且推荐**的写法;只有「上游一改就过期」时才成为隐患');
console.log('    · **乙类三分里只有乙-C 是本脚本能证明的**;乙-A/乙-B 是启发式分栏');
console.log('    · 丙类 = **不可机械判定**,本脚本只做保守正向识别 ⇒ 只报 8 条,远少于实际');
console.log('    · [T?] = **启发式**,中文分词不可靠 ⇒ 口径刻意收窄,**宁可漏报不误报**');
console.log('    · 「?」= 本脚本判据看不见,占 35% ⇒ **它的存在就是这份报告的适用范围声明**');

const bad = labFail > 0 || changed.length > 0;
if (STRICT && (bad || tot.乙 > 0)) {
  console.log(`\n[--strict] ${bad ? '自检失败或只读被破坏' : `有 ${tot.乙} 条乙类命中`} ⇒ exit 1`);
  process.exit(1);
}
if (bad) process.exit(1);
void allScanned;
console.log('\n✓ 审计完成(未加 --strict,命中不导致失败)');
