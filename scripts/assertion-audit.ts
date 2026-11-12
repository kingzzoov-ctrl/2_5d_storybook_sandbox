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
 * node scripts/assertion-audit.ts              # 报告
 * node scripts/assertion-audit.ts --strict-h   # ★ 门禁用:自检失败/只读被破坏/[h] 命中 ⇒ exit 1
 * node scripts/assertion-audit.ts --strict     # 人工复核用:上面三项 **外加** 乙类命中 ⇒ exit 1
 * ```
 *
 * ## ★ 门禁接线请用 `--strict-h`,**不要**用 `--strict`
 * ```
 * `--strict` 把**乙类命中**也算失败,而乙类本仓常态 **25 条**
 * ⇒ 挂 `--strict` 会**恒红** ⇒ 接线者会误读成"水位超了"或"判据坏了"。
 * `--strict-h` 只拦「判据本身坏了」:
 *   1 自检未过(labFail > 0)     —— 某个检测器坏了
 *   2 只读被破坏(changed > 0)   —— 本脚本改了文件(不该发生)
 *   3 [h] 命中 > 0               —— 判据只被注释满足(真问题)
 * ⇒ 挂法(一行):`node scripts/assertion-audit.ts --strict-h`
 * ⚠️ **不要**在门禁里另写一套命中判断 —— 那会造出第二份口径(CR-20)。
 * ⚠️ 判据边界(接线者必读):`--strict-h` 只覆盖**本脚本能机械判定**的部分。
 *    它报 0 命中**不等于**"没有判据问题" —— [T?]/[量纲]/[h] 各自都有
 *    **覆盖率缺口**(如 [h] 只有 36/48 处路径可解析,清单见 [h-未解析] 节),已在各自报告节标明。
 *    **不要把它当成"判据已全检"**。
 * ```
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, dirname, basename } from 'node:path';
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

/**
 * 位置保持地屏蔽注释与**字符串内容**(保留换行与偏移)。`blankStrings=false` 只屏蔽注释。
 *
 * ## ★ task-A 修的两处缺陷(2026-11-13)
 *
 * ```
 * ① **注释分支只 `continue` 没涂白** —— `out` 由 `src.split('')` 初始化,
 *    所以「跳过」不等于「清空」。后果:注释里的数字**漏进 argsOnly**。
 *    实测:`maskMore('const a = 1; /* KB 1024 *\/', false)` 原返回
 *          `'const a = 1;    KB 1024 *\/'` ⇒ `1024` 残留。
 * ② **模板串被整体当字符串** ⇒ `${...}` 插值里的**代码**被一起空白化。
 *    实测:`maskMore('ok(x, `共 ${4096} 次`)', true)` 原返回 `'ok(x,        )'`。
 * ```
 * ## ⚠️ 但这两个缺陷在**本仓 tests/ 上是潜伏的** —— 修前修后输出**逐条相同**
 * ```
 * 影响实验(三变体跑全仓 [T?] 检测器):
 *   A 现状(两缺陷都在)          ⇒ 1 条:WS-09:3719
 *   B 只修①                       ⇒ 1 条:WS-09:3719
 *   C 修①+保留插值                ⇒ 1 条:WS-09:3719
 * ⇒ **A = B = C** ⇒ 它们**没有产出过错的清单**
 * ```
 * 之所以没影响:`tests/` 里没有「注释中带量」或「插值里带量」的标题方程形态。
 * ⇒ 这是「**能证明的**:bug 存在且已修」与「**不能证明的**:它曾造成过错误结论」
 *   必须分开报的典型例子 —— 修它是**正确的**(消除潜伏),但不能说它**曾错过**。
 */
function maskMore(src: string, blankStrings: boolean): string {
  const out = src.split('');
  /* ★ 涂白是**显式动作**,不是「跳过」的副作用 —— 见上方缺陷① */
  const W = (i: number): void => { out[i] = ' '; };
  /* 模板串插值栈:进入 `${` 后按**代码**处理(缺陷②的修法) */
  const stack: { kind: 'tpl' | 'interp'; depth: number }[] = [];
  let st: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    const c2 = src[i + 1];
    /* ── 注释:**永远**涂白(两档都涂) ── */
    if (inLine) { W(i); if (c === '\n') { inLine = false; out[i] = '\n'; } continue; }
    if (inBlock) {
      if (c === '*' && c2 === '/') { inBlock = false; W(i); W(i + 1); i += 1; continue; }
      W(i); if (c === '\n') out[i] = '\n';
      continue;
    }
    /* ── 普通字符串:按 blankStrings ── */
    if (st !== null) {
      if (c === '\\') { if (blankStrings) { W(i); if (i + 1 < src.length) W(i + 1); } i += 1; continue; }
      if (c === st) { st = null; if (blankStrings) W(i); continue; }
      if (blankStrings && c !== '\n') W(i);
      continue;
    }
    if (c === '/' && c2 === '/') { inLine = true; W(i); W(i + 1); i += 1; continue; }
    if (c === '/' && c2 === '*') { inBlock = true; W(i); W(i + 1); i += 1; continue; }
    if (c === "'" || c === '"') { st = c; if (blankStrings) W(i); continue; }
    if (c === '`') {
      const inTpl = stack.length > 0 && stack[stack.length - 1]!.kind === 'tpl';
      if (!inTpl) { stack.push({ kind: 'tpl', depth: 0 }); if (blankStrings) W(i); continue; }
      stack.pop(); if (blankStrings) W(i); continue;
    }
    const top = stack.length > 0 ? stack[stack.length - 1]! : null;
    if (top !== null && top.kind === 'tpl') {
      /* 模板串**字面文本** ⇒ 涂白;`${` 进入插值(按代码保留) */
      if (c === '$' && c2 === '{') { stack.push({ kind: 'interp', depth: 1 }); if (blankStrings) W(i); i += 1; continue; }
      if (blankStrings && c !== '\n') W(i);
      continue;
    }
    if (top !== null && top.kind === 'interp') {
      if (c === '{') top.depth += 1;
      else if (c === '}') {
        top.depth -= 1;
        if (top.depth === 0) { stack.pop(); if (blankStrings) W(i); continue; }
      }
    }
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

/* ══════════════════════════════════════════════════════════════════════════
   ★ task-A:`maskMore` 自身的缺陷自检(M1~M4)
   为什么单独给**掩码器**做自检:它不是一个"业务检测器",它是**所有**下游
   检测器的**输入通道**。它错 ⇒ 下游全部错,而且**错得没有声音**
   (输出看起来照常、条数照常,只是内容不对)。
   ⇒ 承陷阱 44「判据的覆盖面本身需要被验证」:输入通道也要被验证。

   这两条缺陷是我在 task-A 里**先写原型、再交叉验证**才发现的:
   ```
   ① 注释分支只 continue 没涂白 ⇒ 注释里的数字漏进 argsOnly
   ② 模板串 `${...}` 插值被整体空白化 ⇒ 插值里的代码看不见
   ```
   ⚠️ 但**修前修后 tests/ 的输出逐条相同**(见 maskMore 的 JSDoc 影响实验)
      ⇒ 这两个 lab 证明的是「**修得对**」,不是「**曾经错过**」。
   ══════════════════════════════════════════════════════════════════════════ */
type MaskLab = {
  id: string;
  what: string;
  src: string;
  blank: boolean;
  /** 掩码结果**必须包含**的子串(不填 = 不检查) */
  mustHave?: string;
  /** 掩码结果**不得包含**的子串(填 '(none)' = 不作检查) */
  mustNotHave: string;
};

const MASK_LABS: readonly MaskLab[] = [
  {
    id: 'M1',
    what: '★缺陷①:块注释里的数字**不得**漏进掩码结果',
    src: 'const a = 1; /* KB 1024 */',
    blank: false,
    mustNotHave: '1024',
  },
  {
    id: 'M2',
    what: '★缺陷①:行注释里的数字**不得**漏进掩码结果',
    src: 'const a = 1; // 这里 4096 是错的',
    blank: false,
    mustNotHave: '4096',
  },
  {
    id: 'M3',
    what: '★缺陷②:模板串 `${...}` 插值里的**代码**必须保留',
    src: 'ok(ms < 3000, `共 ${4096} 次`);',
    blank: true,
    mustHave: '4096',
    mustNotHave: '(none)',
  },
  {
    id: 'M4',
    what: '干净样本:模板串的**字面文本**仍须涂白(不能连它也保留)',
    src: 'ok(ms < 3000, `共 4096 次`);',
    blank: true,
    mustNotHave: '4096',
  },
];

function runMaskLab(l: MaskLab): LabResult {
  let got: string;
  try { got = maskMore(l.src, l.blank); } catch (e) {
    return { id: l.id, ok: false, detail: `抛错:${(e as Error).message.slice(0, 90)}` };
  }
  if (l.mustNotHave !== '(none)' && got.includes(l.mustNotHave)) {
    return { id: l.id, ok: false, detail: `掩码结果仍含「${l.mustNotHave}」⇒ 该缺陷未修` };
  }
  if (l.mustHave !== undefined && !got.includes(l.mustHave)) {
    return { id: l.id, ok: false, detail: `掩码结果丢了「${l.mustHave}」⇒ 插值被误涂白` };
  }
  return { id: l.id, ok: true, detail: '符合' };
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ task-A:量纲检测器(G)的区分力自检

   ⚠️ G 的自检**只喂源码字符串**,不落盘 —— 它的谓词 `detectDimInSource(src)`
     已被抽成纯函数,全仓扫描与 lab **共用同一份**(CR-20:不造第二份口径)。
     故本脚本**全程只读**,`[只读自证]` 因此仍然严格成立。
     (我上一版注释说它会往 os.tmpdir() 落文件 —— 那是**改设计前的旧稿**,
      留着会让下一个读的人以为自检会写盘。已删。)
   ══════════════════════════════════════════════════════════════════════════ */
type GLab = {
  id: string;
  what: string;
  src: string;
  want: boolean;
};

const G_LABS: readonly GLab[] = [
  {
    id: 'G1',
    what: '★脏样本(真实形态):KiB/s 派生值喂进 ×8/1000 当 Mbps',
    /* 这就是 perf-bounds.ts:515/516/522 的形态 */
    src: `const perClient = (bytes * 20) / 1024;
const roomEgress = perClient * n;
const mbps = roomEgress * 8 / 1000;`,
    want: true,
  },
  {
    id: 'G2',
    what: '干净样本:两侧都用 1024(IEC 一致)⇒ 不得报',
    src: `const kib = bytes / 1024;
const mibps = kib * 1024 * 8 / 1e6;`,
    want: false,
  },
  {
    id: 'G3',
    what: '干净样本:1024 与 1000 在**不同表达式**里(各按各的口径)⇒ 不得报',
    src: `const kib = bytes / 1024;
const kilo = count / 1000;
const total = kib + kilo;`,
    want: false,
  },
];

function runGLab(l: GLab): LabResult {
  /* ★ 落一个临时文件到 **仓库外**(os.tmpdir()),跑检测器的核心谓词,再删。
     ⚠️ 不复用 scanDimMismatch(它硬编码 ROOT + 扫描根)——
        这里只测**谓词本身**,故把它抽成 detectInSource 供两边共用。 */
  let got: boolean;
  try { got = detectDimInSource(l.src); } catch (e) {
    return { id: l.id, ok: false, detail: `抛错:${(e as Error).message.slice(0, 90)}` };
  }
  if (got !== l.want) {
    return {
      id: l.id, ok: false,
      detail: `期望报=${l.want} 实得报=${got} ⇒ ${l.want ? '**漏报**' : '**误报**'}`,
    };
  }
  return { id: l.id, ok: true, detail: `报=${got}` };
}


/* ══════════════════════════════════════════════════════════════════════════
   ★ task-A(Lead 批准项 [3]):「`includes('标识符')` 判源码 ⇒ 先 stripComments」

   ## 为什么需要它(我**在同一个任务里踩了两次**同一个形态)
   ```
   第一次  maskMore(工具):注释分支只 continue 没涂白 ⇒ 注释里的数字漏进 argsOnly
   第二次  WS-FND-03 判据:includes('verifyContentCompatibility')
           被**我注入的一句注释**命中 ⇒ 判据对真缺陷**没牙**(反向核查当场抓住)
   ⇒ 不是疏忽,是**必须机械化防住的形态**。
   ```

   ## ★★ 我写错了**两版**,两版的错法不同 —— 都记在这里,因为它们是路标
   ```
   第一版:X ∈ raw(自身) 且 X ∉ code(自身)  ⇒ 真阳性**恒 0**
     错因:`includes('X')` 这行**自己**就把 X 写进了 code ⇒ 后半句恒假。
     实测 S1/S2 报 0 条 ⇒ **自检当场抓住**。

   第二版:剔除「判据那一行」后再问 X 是否在其余 code 里 ⇒ **73 处 100% 误报**
     错因:`readFileSync(p).includes('X')` 检查的是**另一个文件**!
        X 在**分析者自身**文件里当然只出现在那一行 —— 与目标文件无关。
     ★ 两版共用一个盲点:**把「自身文件」当成了「目标文件」。**

   第三版(本实现):**解析 readFileSync 的路径 ⇒ 读目标文件 ⇒ 在目标文件里问**
   ```

   ## 正确判据
   ```
   1 解析路径:readFileSync(<第一个实参>) → 仓库内路径
       支持 join(ROOT,'a','b')  /  字符串字面量  /  一级 const 间接
       ⚠️ 提取实参必须**按括号深度**找配对的 `)`,不能用"最后一个 )"
         (嵌套 join 会错 —— 我第一版就是这么错的,可解析率 0/71)
   2 读**目标文件**原文 raw2;stripComments(raw2) = code2
   3 若 X ∈ raw2 且 X ∉ code2
       ⇒ X 在目标文件里**只存在于注释** ⇒ 该判据靠注释撑着 ⇒ **报**
   ```

   ## ⚠️ 实测:路径解析率 **36/48**(旧文档写的 44/71 是**过期的**)
   ```
   真阳性 **1 处 —— 而它是有意的**:
     tests/WS-FND-01.test.ts  includes('contentFingerprints')
     目标文件:server/src/bosses/raid.ts
     ⇒ 该名字在 raid.ts 里**只存在于 L345 的注释**
   ⇒ 但 WS-FND-01 的注释明写:这条**就是**为了钉住
     「注释里的命中不算消费」这个反例本身(防将来有人把统计退化成 grep)。
   ⇒ ⇒ **它是故意的负向样本** ⇒ 必须进**已知无害表**,否则本检测器常年报一条已知无害项。

   ★★★ 关于「44/71 vs 36/48」——**两个数不一致,而旧数是错的**
   ```
   旧文档(本注释上文 + 报告行)手写「71 处路径 / 44 可解析 / 27 追不到」。
   实测(独立探针 + 本文件的 ScanStats 计数):**48 处 / 36 可解析 / 8 追不到**,
   构成:实参取不出 0 / 算不出路径 8 / 目标文件读不到 4。
   ⇒ 三个数**互不相符** ⇒ 「71/44」是某个**旧版本**的测量结果,一直没人改。
   ⇒ ★ 这正是本仓反复记的那类问题:**手写的、会漂的数字比没有数字更糟** ——
     它看起来是实测,读者会据此判断覆盖率。现已改为**实测计数**(ScanStats)。
   ```
   ⚠️ **为什么实测 48 而不是 105**:105 是 `readFileSync(` 的**调用点总数**。
      本检测器只关心「**同一作用域里**有个 const 取了 readFileSync,
      且某处对它 `.includes('字面串')`」的站点 ⇒ 48 是那个交集。
      (用户可见的"71"并非任何一个可复现口径 —— 这一点本身就是要修的理由。)

   ## ★★ 追不到的 **8** 处(必须列出来,不能只报个数)
   ```
   理由:只报"N 处追不到"**不可核对** —— 读者不知道是哪几处,
   也就无法判断"追不到的是不是恰好都不重要"(盲区与空白在输出上同形)。
   ⇒ 按**可修性**分组(详见运行时的 [h-未解析] 节):
   ```

   | 位置 | 查的字面串 | 为什么追不到 | 可修性 |
   | :--- | :--- | :--- | :--- |
   | `tests/WS-FND-01.test.ts:1128` | `argv.includes` | `join(ROOT, rel)` —— `rel` 是变量 | B 需数据流分析 |
   | `tests/WS-FND-01.test.ts:1132` | `══ 内容基线锁 ══` | 同上 | B |
   | `tests/WS-FND-01.test.ts:1133` | `process.exit(1)` | 同上 | B |
   | `tests/WS-FND-01.test.ts:1134` | `contentFingerprintLine` | 同上 | B |
   | `tests/WS-FND-01.test.ts:1136` | `--help` | 同上 | B |
   | `tests/WS-FND-01.test.ts:1147` | `基线文件缺失` | 同上 | B |
   | `tests/WS-FND-01.test.ts:1148` | `内容与基线一致` | 同上 | B |
   | `tests/WS-FND-01.test.ts:1149` | `内容与基线不一致` | 同上 | B |

   ```
   ★ 8 处**全部**来自同一处 `join(ROOT, rel)`,**同一个变量名 `rel`**。
   ⇒ 那不是 8 个独立缺口,是**同 1 个**结构缺口(缺"变量段解析")的 8 个实例。
   ⇒ 修它的收益:要么 0(那 8 条本来就该豁免),要么 8 —— **一次性**。
   ⇒ 处置(Lead 已排期):**列为 todo 表**;不在本轮关键路径。
     ⚠️ 修之前要先回答:那 8 条判据本身有没有意义 ——
        它们查的是 `content-lock.ts` 的**源码文本**(含 CLI 分支与提示语),
        而 `rel` 在真跑时才确定 ⇒ 检测器**结构上**看不到目标文件是哪份。
   ```

   ## ⚠️ 失效边界(必须与结论同报)
   ```
   · 路径解析率 **36/48**(实测,非手写)⇒ **未报 ≠ 安全**:
     只证明在**可解析的 36 处**里没有该形态
   · 只认 .includes(/.indexOf(;正则 /re.test(src) **看不见**
   · X 含转义时按**字面**比对,可能与源文不同形 ⇒ 会漏
   · 已知无害表是**手工维护**的 ⇒ 它自己会成为下一个"手写清单"漂移点
   · ★ 行号口径已修(块注释保留换行)——
     修之前报的行号最多偏 **-103 行**,而**判据结论是对的**
     ⇒ 这个 bug 只能靠"点过去看代码对不对"发现,很难自证
   ```
   ══════════════════════════════════════════════════════════════════════════ */

/** 只去注释(保留字符串内容)—— 与 WS-FND-03 的 stripComments 同口径。
 *  ⚠️ `(^|[^:])` 守卫防的是**同行** `https://` 之后的真代码被吃掉
 *     (跨行形态守卫无差别 —— 实测只有同行才暴露;见 WS-FND-03 的说明)。
 *
 *  ## ★★★ 块注释必须保持**行数**(实测抓到的真 bug)
 *  ```
 *  我原来写的是 `.replace(/\/\*[\s\S]*?\*\//g, ' ')`,把整块注释压成**一个空格**。
 *  ⇒ 跨行块注释里的换行**消失** ⇒ 后面所有行**下标前移**。
 *  ★ 实测(tests/WS-FND-01.test.ts,1499 行):
 *      原文 1499 行 → 剥后 **1331** 行(差 168)
 *      该文件首部有一个 **42 行**的块注释 ⇒ 之后整体偏移 -41
 *      探针报某条在 `L1025`,**真实位置 L1128** ⇒ 偏 **-103 行**
 *  ⇒ ⇒ 我此前所有用它的地方(**注释撑着的判据 / 追不到的清单 / 行号输出**)
 *     报出的**行号全是错的** —— 而消息本身看起来完全正常。
 *  ```
 *  ⇒ 修法:替换文本里**保留原注释内的换行数** —— 用等量 `\n` 顶替,
 *    非换行字符换成空格(空格不影响 `includes` 类判据,换行数决定行号)。
 *
 *  ⚠️ 为什么不是"直接删掉注释":`ok(src.includes('x'))` 的判据要求
 *     **注释里的 x 不算数**,故注释内容必须变空 —— 只是**行数不变**。
 *  ⚠️ 这也解释了为什么这个 bug 一直没被发现:**判据的结论是对的**
 *     (命中/不命中不受影响),只有**行号**错。而行号错的表现是
 *     "点过去看到的代码跟消息对不上" —— 很容易被当成"我看错文件了"。 */
function stripCommentsOnly(s: string): string {
  return s
    /* 块注释:保留其中的换行,其余字符变空格 */
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' ' + m.replace(/[^\n]/g, '') + ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * ★ 已知无害表:这些命中是**刻意**的负向样本,不是缺陷。
 * ⚠️ 每条都必须写明**为什么无害**,否则这个表会退化成"把红的都加进去"。
 */
const COMMENT_BACKED_EXEMPT: readonly { file: string; x: string; why: string }[] = [
  {
    file: 'tests/WS-FND-01.test.ts',
    x: 'contentFingerprints',
    why: 'WS-FND-01:1369 明写:这条**就是**为了钉住「注释里的命中不算消费」这个反例本身,'
      + '防将来有人把统计退化成 grep。⇒ 故意的。',
  },
];

/** 路径求解:能把 readFileSync 的实参静态求值到仓库内路径时返回它,否则 null(不猜)。 */
function resolveSrcPath(argExpr: string, fileDir: string, root: string): string | null {
  const a = argExpr.trim();
  const lit = /^(['"])([^'"]*)\1$/.exec(a);
  if (lit) {
    const v = lit[2]!;
    return (v.startsWith('.') || v.includes('/')) ? join(fileDir, v) : null;
  }
  const j = /^join\s*\(([\s\S]*)\)$/.exec(a);
  if (j === null) return null;
  const parts: string[] = [];
  let hasRoot = false;
  /* 顶层逗号切分(简化:join 的参数不含嵌套逗号) */
  for (const seg of j[1]!.split(',')) {
    const t = seg.trim();
    const l2 = /^(['"])([^'"]*)\1$/.exec(t);
    if (l2) { parts.push(l2[2]!); continue; }
    if (/^(ROOT|HERE|ROOT_DIR|__dirname|DIR|BASE)$/.test(t)) { hasRoot = true; continue; }
    return null;  /* 有算不出的段 ⇒ 放弃,不猜 */
  }
  return hasRoot ? join(root, ...parts) : join(fileDir, ...parts);
}

/** 从 `const v = readFileSync(<arg>, 'utf8')` 的声明里取出**第一个实参**(按括号深度配对)。 */
function firstArgOfReadFileSync(decl: string): string | null {
  const ri = decl.indexOf('readFileSync');
  if (ri < 0) return null;
  const open = decl.indexOf('(', ri);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let k = open; k < decl.length; k += 1) {
    const ch = decl[k]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; if (depth === 0) { close = k; break; } }
  }
  if (close < 0) return null;
  const argsRaw = decl.slice(open + 1, close);
  /* 顶层逗号切分 */
  let d2 = 0;
  for (let k = 0; k < argsRaw.length; k += 1) {
    const ch = argsRaw[k]!;
    if (ch === '(' || ch === '[' || ch === '{') d2 += 1;
    else if (ch === ')' || ch === ']' || ch === '}') d2 -= 1;
    else if (ch === ',' && d2 === 0) return argsRaw.slice(0, k).trim();
  }
  return argsRaw.trim();
}

/**
 * ★ 扫描计数(可选出参)。
 *
 * ## 为什么要有这个(而不是在报告里手写"27 处追不到")
 * ```
 * 我第一版把解析率**手写在报告文本里**(「44/71 路径可解析,剩下 27 处追不到」)。
 * ⇒ 那是**手写数字**:检测器改了(比如 `firstArgOfReadFileSync` 从"截到最后一个 )"
 *   改成括号配对)、被测集变了(新增套件),这个数字**不会跟着变**。
 * ⇒ 而我实测对不上:
 *      文件里写 71 处 / 44 可解析(⇒ 27 追不到)
 *      独立探针数出来 **48 处 / 40 可解析**(⇒ 8 追不到)
 *      `readFileSync(` 调用点总数则是 **105**
 * ⇒ 三个数**互不相符** ⇒ 说明"71/44"是某个**旧版本**的测量结果,一直没人改。
 * ⇒ ★ 这正是本仓反复记的那类问题:**一个手写的、会漂的数字,比没有数字更糟** ——
 *   它看起来是实测,实际是历史。**读者会据此判断覆盖率。**
 * ⇒ 故:改成**实测计数**,由扫描器自己上报。
 * ```
 * ⚠️ 计数**只在非自检调用时**累加(`scanCommentBackedIn` 也被 S 系列自检调用,
 *    那些合成样本不该算进"全仓解析率")。故用可选参数,自检处不传。
 */
type ScanStats = { sites: number; resolved: number; noArg: number; noPath: number; readFailed: number };

/** ★ 单一实现:给定某个文件的源码,返回该文件里「判据只被注释满足」的命中。
 *  全仓扫描与 S 系列自检**共用这一个**(CR-20:不造第二份口径)。 */
function scanCommentBackedIn(
  file: string,
  src: string,
  root: string,
  stats: ScanStats | null = null,
): { line: number; x: string; target: string }[] {
  const out: { line: number; x: string; target: string }[] = [];
  const code = stripCommentsOnly(src);
  const lines = code.split('\n');
  const consts = new Map<string, string>();
  for (const l of lines) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/.exec(l);
    if (m) consts.set(m[1]!, m[2]!.trim());
  }
  const fileDir = dirname(join(root, file));
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    const re = /([A-Za-z_$][\w$]*)\s*\.\s*(?:includes|indexOf)\s*\(\s*(['"])([^'"]*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) {
      const v = m[1]!;
      const x = m[3]!;
      if (x.length === 0) continue;
      const decl = consts.get(v);
      if (decl === undefined || !decl.includes('readFileSync')) continue;
      /* ── 从这里起才算一个**站点**(上面那 continue 是"这不是 readFileSync 变量")── */
      if (stats !== null) stats.sites += 1;
      const expr = firstArgOfReadFileSync(decl);
      if (expr === null) { if (stats !== null) stats.noArg += 1; continue; }
      /* 一级 const 间接(如 DELTA_SRC_PATH = join(ROOT, 'a','b')) */
      let ex = expr;
      const one = /^([A-Za-z_$][\w$]*)$/.exec(ex);
      if (one) { const c2 = consts.get(one[1]!); if (c2 !== undefined) ex = c2; }
      const p = resolveSrcPath(ex, fileDir, root);
      if (p === null) { if (stats !== null) stats.noPath += 1; continue; }
      let raw2: string;
      try { raw2 = readFileSync(p, 'utf8'); } catch { if (stats !== null) stats.readFailed += 1; continue; }
      if (stats !== null) stats.resolved += 1;
      if (raw2.includes(x) && !stripCommentsOnly(raw2).includes(x)) {
        out.push({ line: i + 1, x, target: relative(root, p).split(sep).join('/') });
      }
    }
  }
  return out;
}

/**
 * ★★ 列出「**追不到**」的站点 —— 与 `scanCommentBackedIn` **共用同一套判据**
 *    (同样的 `consts` 收集、同样的 `firstArgOfReadFileSync`、同样的 `resolveSrcPath`),
 *    只在"路径解析失败"那一刻收集,而不是丢弃。
 *
 * ## 为什么必须把清单列出来(Lead 的要求,理由很硬)
 * ```
 * 报告里原先只有一句「27 处含变量段 ⇒ 追不到」。
 * ★ 但那句话**不可核对**:读者不知道是哪 27 处,也不知道它们为什么追不到
 *   ⇒ 无法判断"这些追不到的是不是恰好都不重要"(那正是盲区最危险的地方)。
 * ★ 更糟:我实测那 27 是**手写的旧数字**(详见 ScanStats 注释)。
 * ⇒ 故:列成表,每条写清 `文件:行 / 查的字面串 / 为什么追不到`。
 *   「为什么」分成三类,因为三类的**可修性完全不同**:
 *     · join 里有变量段   ⇒ 需要跨函数数据流 ⇒ 本检测器做不到(记明)
 *     · 非 join/非字面量  ⇒ 如模板串 / 变量 / 函数调用 ⇒ 同上
 *     · 实参取不出        ⇒ ★ **这是我的解析器能力问题,可修**
 *   ⇒ 第三类是唯一"能通过改检测器消掉"的,优先看。
 * ```
 * ⚠️ 与 `scanCommentBackedIn` 的重复:两处都要走一遍同样的 consts/regex。
 *    **我没有把它们合成一个函数**,因为合并会逼 `scanCommentBackedIn` 承担
 *    "收集失败项"这个它不需要的职责(它的签名与 S 系列自检共享)。
 *    ⇒ 但**判据必须同源**:故这里**逐字复用**那三个函数,不另写一套解析。
 */
function scanUnresolvedIn(
  file: string,
  src: string,
  root: string,
): { file: string; line: number; x: string; arg: string; why: string }[] {
  const out: { file: string; line: number; x: string; arg: string; why: string }[] = [];
  const code = stripCommentsOnly(src);
  const lines = code.split('\n');
  const consts = new Map<string, string>();
  for (const l of lines) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/.exec(l);
    if (m) consts.set(m[1]!, m[2]!.trim());
  }
  const fileDir = dirname(join(root, file));
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    const re = /([A-Za-z_$][\w$]*)\s*\.\s*(?:includes|indexOf)\s*\(\s*(['"])([^'"]*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) {
      const v = m[1]!;
      const x = m[3]!;
      if (x.length === 0) continue;
      const decl = consts.get(v);
      if (decl === undefined || !decl.includes('readFileSync')) continue;
      const expr = firstArgOfReadFileSync(decl);
      if (expr === null) {
        out.push({ file, line: i + 1, x, arg: '(取不出)', why: '实参取不出(无括号 / 嵌套过深)' });
        continue;
      }
      let ex = expr;
      const one = /^([A-Za-z_$][\w$]*)$/.exec(ex);
      if (one) { const c2 = consts.get(one[1]!); if (c2 !== undefined) ex = c2; }
      if (resolveSrcPath(ex, fileDir, root) !== null) continue;
      out.push({ file, line: i + 1, x, arg: expr.slice(0, 90), why: whyUnresolved(expr) });
    }
  }
  return out;
}

/** 把「为什么追不到」分成三类 —— 三类的**可修性**不同,故必须分开。 */
function whyUnresolved(expr: string): string {
  const j = /^join\s*\(([\s\S]*)\)$/.exec(expr.trim());
  if (j === null) return '既非字面量也非 join(模板串 / 变量 / 函数调用)';
  const bad: string[] = [];
  for (const seg of j[1]!.split(',')) {
    const t = seg.trim();
    if (/^(['"])[^'"]*\1$/.test(t)) continue;
    if (/^(ROOT|HERE|ROOT_DIR|__dirname|DIR|BASE)$/.test(t)) continue;
    bad.push(t);
  }
  if (bad.length === 0) return '★ join 顶层逗号切分失败(参数含嵌套逗号)—— 解析器可修';
  return `join 里含算不出的段:${bad.join(' / ')}`;
}

/* ★ S 系列:区分力自检 —— 脏样本必须报,干净样本必须不报。 *  ⚠️ 它测的是**同一个** scanCommentBackedIn(不另造实现)。
 *     但注意:自检把"源码字符串"喂进去时,**目标文件**必须真实存在
 *     (因为判据要读目标文件)。故样本里一律指向一个**真实且已知**的文件:
 *     `server/src/bosses/raid.ts`(它的 contentFingerprints 只在注释里)。 */
type SLab = { id: string; what: string; src: string; want: number };

const S_TARGET = 'server/src/bosses/raid.ts';

const S_LABS: readonly SLab[] = [
  {
    id: 'S1',
    what: '★脏样本(真实形态):判据查的标识符在**目标文件**里只存在于注释',
    /* 指向 raid.ts —— 该文件里 contentFingerprints 真的只在注释里 */
    src: `const raidSrc = readFileSync(join(ROOT, '${S_TARGET}'), 'utf8');
ok(raidSrc.includes('contentFingerprints'), '某处消费了它');`,
    want: 1,
  },
  {
    id: 'S2',
    what: '干净样本:标识符在目标文件里**代码**也出现 ⇒ 不得报',
    src: `const raidSrc = readFileSync(join(ROOT, '${S_TARGET}'), 'utf8');
ok(raidSrc.includes('BossDef'), 'BossDef 存在');`,
    want: 0,
  },
  {
    id: 'S3',
    what: '干净样本:路径**解析不出来** ⇒ 不报(不猜,不制造误报)',
    src: `const someSrc = readFileSync(join(ROOT, rel), 'utf8');
ok(someSrc.includes('contentFingerprints'), 'x');`,
    want: 0,
  },
  {
    id: 'S4',
    what: '干净样本:对象不是 readFileSync 的结果 ⇒ 不在范围',
    src: `const data = JSON.parse('{}');
ok(data.includes('contentFingerprints'), '无关');`,
    want: 0,
  },
  {
    id: 'S5',
    what: '★回归样本:WS-FND-03 修复前的**真实原文形态**(目标文件里该名在代码中)',
    /* room.ts 里有 contentClaim 的**代码**出现(不是只在注释)⇒ 不该报。
       若哪天有人把 stripComments 从 WS-FND-03 删掉,本检查会在那边报出来。 */
    src: `const roomSrcT37 = readFileSync(join(ROOT, 'server', 'src', 'net', 'room.ts'), 'utf8');
const roomCarries = roomSrcT37.includes('contentClaim');
const roomVerifies = roomSrcT37.includes('verifyContentCompatibility');`,
    want: 0,
  },
];

function runSLab(l: SLab): LabResult {
  let got: number;
  try { got = scanCommentBackedIn('<lab>', l.src, ROOT).length; } catch (e) {
    return { id: l.id, ok: false, detail: `抛错:${(e as Error).message.slice(0, 90)}` };
  }
  if (got !== l.want) {
    return { id: l.id, ok: false, detail: `期望报 ${l.want} 条,实得 ${got} 条` };
  }
  return { id: l.id, ok: true, detail: `报 ${got} 条` };
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

/**
 * 扫描根里的测试文件清单。
 *
 * ## ★★ 为什么必须过滤 `_` 前缀(实测抓到的口径不一致)
 * ```
 * 本仓 `.gitignore:37` 是 `_*` ⇒ 这些文件**不进交付物**。
 * 另外两个扫描器**都**跳过它们:
 *    scripts/verify.ts:1876          `basename(p).startsWith('_') ⇒ continue`
 *    scripts/judgement_audit.ts:1650 路径任一段以 `_` 开头 ⇒ skip
 * ★ 而我这份**没有过滤** —— 实测:放一个 `tests/_xaudit_probe.test.ts`,
 *    文件数 23 → **24**,输出里出现 `_xaudit_probe` ⇒ 我的主分类器**扫到了它**。
 * ⚠️ 更难看的是:**同一个文件里两套口径**——
 *    `[g]` 的 `scanDimMismatch()`(L2118 附近)walk 时**有** `_` 过滤,
 *    而这里**没有** ⇒ 同一份报告里,`[g]` 不看的文件 `[乙]/[丙]/[h]` 却在看。
 * ```
 * ## 后果(为什么这不是洁癖)
 * ```
 * 有人放个 `tests/_probe.test.ts` 进去 ⇒ 另两个工具跳过、我这份会扫
 * ⇒ 我可能报出命中,而那是**不存在于交付物里**的代码
 * ⇒ 报的"问题"读者**永远找不到**(他看不到那个文件,因为它被 gitignore 了)
 * ⇒ ★ 这类误报最坏的地方不是噪音,是**让人怀疑整份报告**。
 * ```
 * ## 为什么今天看不出来
 * ```
 * 实测 `tests/` 下 **23 个文件,0 个 _ 前缀** ⇒ 差异**当前不可观测**。
 * ⇒ 正因如此更该修:**一个只在"别人犯了某个错"时才显形的口径差异,
 *   永远不会被自己发现**。而我自己就是那个"别人"(我本轮放了 6 个 `_` 探针在
 *   `default-workspace/` 根 —— 侥幸不在 `tests/` 下,否则就会触发)。
 * ```
 *
 * ## ★★ 为什么必须抽成**一个函数**(我第一版的自检自己又实现了一遍 —— CR-20)
 * ```
 * 我第一版:生产用一条 `.filter(...)`,而**自检里又写了一条一样的 filter**。
 * ⇒ 注入实测:把**生产那条**删掉 ⇒ 自检**照样绿**
 *   —— 因为它测的是**自己那份副本**,不是生产清单。
 * ⇒ ★ 这正是本仓 CR-20「不造第二份口径」的教科书形态:
 *     两条同时存在时看不出问题(都"对"),删掉一条也不红(另一条顶着)。
 * ⇒ 故:过滤只在**本函数里出现一次**,生产与自检**都**调它。
 *   现在删掉里面那个 filter ⇒ 生产清单与自检**一起**变 ⇒ 红。
 * ```
 */
function listTestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    /* ★ 与 verify.ts:1876 / judgement_audit.ts:1650 / 本文件 [g] 的 walk() 同口径 */
    .filter((f) => !f.startsWith('_'))
    .map((f) => join(dir, f));
}

const testFiles = listTestFiles(TEST_DIR);

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

/* ★★ `_` 前缀过滤的**自证**(防止它哪天被"顺手删掉")
 *
 * ```
 * `listTestFiles()` 里那条 `.filter((f) => !f.startsWith('_'))` 是**静默生效**的:
 *   删掉它,今天**没有任何断言会红**(实测 tests/ 下 0 个 _ 文件)。
 * ⇒ ⇒ 那就是一段"改了没人知道"的代码 —— 与本任务反复记的**装饰**同族。
 * ⇒ 故:造一个真实 `_` 文件,要求它**不出现在** `listTestFiles()` 的结果里。
 *   ★ 关键是**调生产那个函数**,不是自己重算 —— 否则又是 CR-20(见函数头注释)。
 * ```
 * ⚠️ 用**真实临时文件**而不是 mock:mock 测不出 `readdirSync` 的行为。 */
{
  const probeName = '_audit_selfcheck_probe.test.ts';
  const probePath = join(TEST_DIR, probeName);
  /* 先查"当前有没有已存在的 _ 文件漏进来"(非探针的、别人放的) */
  const leaked = listTestFiles(TEST_DIR).filter((p) => basename(p).startsWith('_'));
  if (leaked.length > 0) {
    console.log(`✗ \`_\` 前缀文件漏进扫描清单(${leaked.length} 个):`
      + `${leaked.map((p) => relative(ROOT, p)).join(', ')}`);
    console.log('  ⇒ 这些文件被 .gitignore 排除(= 不在交付物里)⇒ 报它们等于报"找不到的东西"。');
    process.exit(1);
  }
  try {
    writeFileSync(probePath, "import { eq } from '../shared/testing/harness.ts';\neq(1, 1, '探针');\n");
    /* ★ 这里**必须**调生产函数 `listTestFiles` —— 那才是"测它"而不是"又实现一遍" */
    const again = listTestFiles(TEST_DIR);
    if (again.some((p) => basename(p) === probeName)) {
      console.log(`✗ \`_\` 前缀过滤**失效**:探针 ${probeName} 被 listTestFiles() 收进来了`);
      console.log('  ⇒ 这会报出 gitignore 掉的代码 ⇒ 读者永远找不到那些"问题"。');
      process.exit(1);
    }
    console.log(`  ✓ [自检] \`_\` 前缀过滤生效(造探针 ${probeName} ⇒ listTestFiles() 未收录)`);
  } finally {
    /* ★ 必须删掉 —— 不能给仓库留垃圾 */
    try { unlinkSync(probePath); } catch { /* 已不在 */ }
  }
}

const shaOf = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const before = new Map(testFiles.map((f) => [f, shaOf(f)]));

/* ⚠️ 这句声明必须**精确**,否则它自己会变成一句假话。
   `[只读自证]` 只覆盖 `testFiles` 里那些文件 —— 而上面那条 `_` 过滤自检
   **会创建一个探针文件再删掉**。它不进 `testFiles` ⇒ 自证仍成立,
   但"不修改任何文件"这个**字面**说法与事实有出入 ⇒ 改成写清边界。 */
console.log('[断言值来源审计] 只读:被扫描文件运行前后 SHA-256 不变(见末尾 `[只读自证]`)');
console.log('  ⚠️ 唯一例外:`_` 前缀过滤自检会**临时创建再删除**一个 tests/_*.test.ts 探针;');
console.log('     该探针不进扫描清单,故不影响上面的自证 —— 但声明必须写清这点。');
console.log(`  扫描根:tests/   文件数:${testFiles.length}\n`);

/* ── 1. 自检 ── */
console.log('[自检] 分类器区分力(脏样本必命中 / 干净样本必不误报)');
const labResults = [
  ...LABS.map(runLab),
  ...T_LABS.map(runTLab),
  ...SUB_LABS.map(runSubLab),
  ...MASK_LABS.map(runMaskLab),
  ...G_LABS.map(runGLab),
  ...S_LABS.map(runSLab),
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

/* ══════════════════════════════════════════════════════════════════════════
   §[g] ★ 量纲/单位对齐检测器(task-A)

   ## 它要解决的病(来源是一手数据,不是想象)

   `scripts/perf-bounds.ts:515/516/522`:
   ```
   515  const perClient = (moving.bytes.length * 20) / 1024;   // ← 单位是 **KiB/s**
   516  const roomEgress = perClient * n;
   522  `${(roomEgress * 8 / 1000).toFixed(2)} Mbps`           // ← 按 **kB/s** 换算
   ```
   KiB/s → Mbps 的系数应是 `× 1024 × 8 / 1e6 = 0.008192`,而代码用 `× 8 / 1000 = 0.008`
   ⇒ **低估 2.344%**。实测(用真实字节数,两条独立算法交叉校验一致):
   ```
   移动稳态帧 = 368 B;n = 16
   roomEgress = 115.00 KiB/s
   代码算的 Mbps = 0.9200
   正确(KiB 口径) = 0.9421
   直接(B/s 口径) = 0.9421   ← 与「正确」逐位相同 ⇒ 证明换算推导无误
   ⇒ 低估 2.344%
   ```
   ⚠️ 危害**不是**这个数偏小,而是:**它让「相对 1Mbps 上行有余量」这个结论
     建立在一个偏乐观的换算上 —— 而这类错误在别处可以是最坏方向。**

   ## 三个形态 —— 但**只做有真阳性的那个**(实测校准 2026-11-13)

   ```
   形态 1  SI 标签(KB/MB)配 1024 除数            ⇒ 4 条命中,**全是显示标签措辞**
           (clean-temp.ts:74 / verify.ts:2559,2566 / WS-07:1100)
           ⇒ ⚠️ 0 条是数值错误 ⇒ **不报**(报了就是 4 条噪音)
   形态 2  ★ 二进制派生值喂进十进制换算            ⇒ **1 处真错,已量化 2.344%** ⇒ 报
   形态 3  `.length`(字符)与 `byteLength`(字节)同处比较 ⇒ 全仓 **0 条** ⇒ **不做**(空壳)
   形态 4  名字带单位后缀 vs 字面量量级            ⇒ 全仓 **0 条** ⇒ **不做**(空壳)
   ```
   ★ **形态 3/4 我不做,不是"漏了",是实测没有真阳性** ——
     做了就是造一个永远报 0 条、看起来"很干净"的空壳检测器(比不做更坏:
     它会让读者以为那块被检查过了)。

   ## ⚠️ 本检测器的失效边界(必须与结论同报)
   ```
   · 它只查**同一表达式里**「变量既由 1024 派生、又参与 1000 换算」
     ⇒ 跨函数/跨文件的数据流它**看不见**
   · 它**不判**「哪个表达式是对的」—— 只报「两侧进制不一致,请人工判」
     (因为「用 KiB 还是 kB」本身是**产品选择**,不是语法错误)
   · 变量传递做了 3 轮粗传播 ⇒ 更深的链**会漏**
   · **不能因为它没报就说某处量纲对** —— 未报 ≠ 已验
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ★ 量纲检测的**核心谓词** —— 单一实现,供**全仓扫描**与**自检 lab** 共用。
 *
 * 为什么必须共用(而不是各写一份):承 CR-20 与陷阱 51 ——
 * 「同一判据两份实现 = 两份口径」,而自检的意义正是**验证被测的那一份**。
 * 若 lab 走另一份实现,它证明的就不是扫描器了。
 *
 * ## ★ 口径里的那条「补回」规则 —— 是干净样本 G2 逼出来的
 * ```
 * 报:    roomEgress * 8 / 1000        ← 有 1000 基,**且同式内没有任何 1024**
 * 不报:  kib * 1024 * 8 / 1e6         ← 有 1000 基,但**同式内显式 ×1024 补了回来**
 * ```
 * 为什么这条是**有原则的**而不是"打补丁":后者是**完整的 KiB→Mbps 换算公式**
 * (`×1024` 把 KiB 还原成 B,再 `×8/1e6` 转 Mbps)⇒ 它**没有**进制混用,
 * 只是在同一行里把两步都写了出来。前者缺了 `×1024` 那一步 ⇒ 才是不一致。
 * ```
 * ⚠️ 我第一版没有这条 ⇒ 干净样本 G2 当场报红 ⇒ **我的 lab 抓住了我的误报**。
 *    这正是「每条断言必须能回答『它失败了说明我的哪个假设错』」的实例。
 * ```
 */
function detectDimInSource(src: string): boolean {
  /* ★ 用**修好的** maskMore:注释里的话不算判据、插值里的代码要看见 */
  const code = maskMore(src, true);
  const lines = code.split('\n');
  const binVars = new Set<string>();
  for (const l of lines) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*(?:\/\s*1024\b|\*\s*1024\b)/.exec(l);
    if (m) binVars.add(m[1]!);
  }
  if (binVars.size === 0) return false;
  /* 粗传播 3 轮(更深的链会漏 —— 见失效边界) */
  for (let pass = 0; pass < 3; pass += 1) {
    for (const l of lines) {
      const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/.exec(l);
      if (!m) continue;
      if ([...binVars].some((v) => new RegExp(`\\b${v}\\b`).test(m[2]!))) binVars.add(m[1]!);
    }
  }
  for (const l of lines) {
    const used = [...binVars].filter((v) => new RegExp(`\\b${v}\\b`).test(l));
    if (used.length === 0) continue;
    if (!/[/\*]\s*(?:1000|1e3|1e6)\b/.test(l)) continue;
    /* ★「补回」规则:同式内有 1024 ⇒ 是完整换算公式,不是混用 */
    if (/\b1024\b/.test(l)) continue;
    return true;
  }
  return false;
}

/** 量纲候选:同一表达式里既有「÷1024 派生」的变量、又有「÷1000 / ×1000」换算。 */
type DimCand = { file: string; line: number; vars: string; text: string };

function scanDimMismatch(): DimCand[] {
  const out: DimCand[] = [];
  /* 扫描根:生产 + 脚本 + 测试。⚠️ `shared/**` 必须在列 ——
     它住着跨层契约,而 task-68 刚证明过「约定俗成以为被扫、其实没被扫」的洞。 */
  const roots = ['scripts', 'tests', 'server/src', 'client/src', 'shared'];
  const files: string[] = [];
  const walk = (dir: string): void => {
    let ents: import('node:fs').Dirent[];
    try { ents = readdirSync(join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const relP = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(relP);
      else if (e.name.endsWith('.ts')) files.push(relP);
    }
  };
  for (const r of roots) walk(r);

  for (const relP of files) {
    let src: string;
    try { src = readFileSync(join(ROOT, relP), 'utf8'); } catch { continue; }
    /* ★ 谓词与自检 lab 共用同一份(见 detectDimInSource 的注释)。
       这里额外**取出行号与变量名**给报告用 —— 同一次扫描,不重跑。 */
    const code = maskMore(src, true);
    const lines = code.split('\n');
    const binVars = new Set<string>();
    for (const l of lines) {
      const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*(?:\/\s*1024\b|\*\s*1024\b)/.exec(l);
      if (m) binVars.add(m[1]!);
    }
    if (binVars.size === 0) continue;
    for (let pass = 0; pass < 3; pass += 1) {
      for (const l of lines) {
        const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/.exec(l);
        if (!m) continue;
        if ([...binVars].some((v) => new RegExp(`\\b${v}\\b`).test(m[2]!))) binVars.add(m[1]!);
      }
    }
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i]!;
      const used = [...binVars].filter((v) => new RegExp(`\\b${v}\\b`).test(l));
      if (used.length === 0) continue;
      if (!/[/\*]\s*(?:1000|1e3|1e6)\b/.test(l)) continue;
      /* ★「补回」规则(与 detectDimInSource 同一条,见其 JSDoc) */
      if (/\b1024\b/.test(l)) continue;
      out.push({
        file: relP, line: i + 1, vars: used.join(','),
        text: src.split('\n')[i]?.trim().slice(0, 120) ?? '',
      });
    }
  }
  return out;
}

const dimCands = scanDimMismatch();
/* ★ 自检一致性:谓词说「有」⇒ 扫描器必须也报出来。两者不一致就是两份口径。
   ⚠️ 这段必须在 `dimCands` **定义之后**(我第一版放在函数体里 ⇒ TDZ 报错)。 */

if (dimCands.length > 0) {
  const anyHit = dimCands.some((c) => {
    try { return detectDimInSource(readFileSync(join(ROOT, c.file), 'utf8')); } catch { return false; }
  });
  if (!anyHit) console.log('    ✗ 检测器内部不一致:扫描器报了候选,谓词却说没有');
}

/* ── ★ [h] 靠注释撑着的判据(Lead 批准项 [3])── */
const cbHits: { file: string; line: number; x: string; target: string }[] = [];
/* ★ 实测计数(见 ScanStats 的注释:报告里的解析率**不再手写**) */
const cbStats: ScanStats = { sites: 0, resolved: 0, noArg: 0, noPath: 0, readFailed: 0 };
/* ★ 不可解析项的**清单**(供文件头那张 todo 表;「追不到」不能只报个数) */
const cbUnresolved: { file: string; line: number; x: string; arg: string; why: string }[] = [];
for (const f of testFiles) {
  const rel = relative(ROOT, f).split(sep).join('/');
  let raw: string;
  try { raw = readFileSync(f, 'utf8'); } catch { continue; }
  for (const h of scanCommentBackedIn(rel, raw, ROOT, cbStats)) cbHits.push({ file: rel, ...h });
  for (const u of scanUnresolvedIn(rel, raw, ROOT)) cbUnresolved.push(u);
}
/* 已知无害表(刻意的负向样本)*/
const cbKept = cbHits.filter((h) => !COMMENT_BACKED_EXEMPT.some((e) => e.file === h.file && e.x === h.x));
console.log(`\n[h] ★ 「判据只被**注释**满足」—— ${cbKept.length} 处(另有 ${cbHits.length - cbKept.length} 处属已知无害)`);
console.log('    判据:解析 `readFileSync(<arg>)` 的路径 ⇒ 读**目标文件** ⇒ 若该字面串在目标文件里');
console.log('          **只存在于注释**、代码里一次都不出现 ⇒ 该判据可以被一句注释单独满足');
console.log('    ⇒ 假绿**已经实现**(不是"可能")。');
/* ★★ 解析率改用**实测**(见 ScanStats 注释:手写的旧数字对不上实测)。 */
console.log(`    ⚠️ 路径解析率(实测):**${cbStats.resolved}/${cbStats.sites}** 可解析`
  + `,追不到 ${cbUnresolved.length} 处`);
console.log(`       构成:实参取不出 ${cbStats.noArg} / 算不出路径 ${cbStats.noPath}`
  + ` / 目标文件读不到 ${cbStats.readFailed}`);
console.log('    ⇒ **未报 ≠ 安全**:只证明在**可解析的那部分**里没有该形态。');
console.log('    ⇒ 追不到的是哪些、为什么,见下面 [h-未解析] 节 + 文件头那张表。');
console.log('    ⚠️ 不看正则形式(/re.test(src));转义字面量按字面比对 ⇒ 会漏。');
for (const h of cbKept) console.log(`    ${h.file}:${h.line}  「${h.x}」⇒ 目标 ${h.target}`);
if (cbKept.length === 0) console.log('    (0 处 —— 先确认检查没坏:跑 [自检] 节的 S1~S5)');
for (const e of COMMENT_BACKED_EXEMPT) {
  const hit = cbHits.some((h) => h.file === e.file && h.x === e.x);
  console.log(`    [豁免] ${e.file} 「${e.x}」${hit ? '' : ' ⚠️ **未命中 ⇒ 豁免条目可能已过期**'}`);
  console.log(`       为何无害:${e.why}`);
}

/* ── ★★ [h-未解析]:把"追不到"的**清单**列出来(不能只报个数) ──
 *
 * ```
 * 理由:只报"27 处追不到"这句话**不可核对** ——
 *   读者不知道是哪 27 处,也就无法判断"追不到的是不是恰好都不重要"
 *   (那正是盲区最危险的地方:盲区与空白在输出上同形)。
 * ⇒ 列清单,并按**可修性**分组:
 *     A 解析器可修   ⇒ 只有"join 顶层逗号切分失败"这一类(我的实现能力问题)
 *     B 需数据流分析 ⇒ join 里有变量段(本检测器结构上做不到)
 *     C 非 join 形态 ⇒ 模板串/变量/函数调用(同上)
 *   ⇒ 先看 A:**那是唯一能通过改检测器消掉的**。
 * ```
 * ⚠️ 这一节**按实测条数决定是否打印**,不写死"27 处"。 */
console.log(`\n[h-未解析] ★ 追不到的站点清单 —— ${cbUnresolved.length} 处(按"为什么"分组)`);
if (cbUnresolved.length === 0) {
  console.log('    (0 处 —— ⚠️ 先确认解析器没坏:跑 [自检] 节的 S1~S5,它们要能报出 1 处)');
} else {
  const byWhy = new Map<string, typeof cbUnresolved>();
  for (const u of cbUnresolved) {
    if (!byWhy.has(u.why)) byWhy.set(u.why, []);
    byWhy.get(u.why)!.push(u);
  }
  for (const [why, arr] of [...byWhy].sort((a, b) => b[1].length - a[1].length)) {
    const tag = why.includes('可修') ? 'A 解析器可修' : 'B/C 需数据流分析或非 join 形态';
    console.log(`    ── [${tag}] ${why}(${arr.length} 处)`);
    for (const u of arr) console.log(`        ${u.file}:${u.line}  「${u.x}」  arg=${u.arg}`);
  }
}
console.log(`\n[g] ★ 量纲/单位不一致候选 —— ${dimCands.length} 条(需人工判:哪侧是对的) `);
console.log('    判据:同一表达式里,变量既由 **÷1024/×1024** 派生、又参与 **÷1000/×1000/1e6** 换算。');
console.log('    ⚠️ 本检测器**不判哪侧对** —— 「KiB 还是 kB」是产品选择,不是语法错误。');
console.log('    ⚠️ 只查**同一表达式**;跨函数/跨文件的数据流看不见 ⇒ 未报 ≠ 已验。');
console.log('    ⚠️ 形态 1(SI 标签配 1024 除数)与形态 3/4 **实测 0 条真阳性** ⇒ 刻意不做');
console.log('       (做了会造出"永远报 0 条"的空壳,比不做更坏:读者会以为那块被检查过了)。');
for (const c of dimCands) {
  console.log(`    ${c.file}:${c.line}  [变量:${c.vars}]`);
  console.log(`        ${c.text}`);
}
if (dimCands.length === 0) {
  console.log('    (0 条 —— ⚠️ 先确认检测器没坏:跑 [自检] 节的 G1/G2/G3)');
}


const changed: string[] = [];
for (const [f, h0] of before) if (shaOf(f) !== h0) changed.push(relative(ROOT, f).split(sep).join('/'));
console.log('\n[只读自证]');
if (changed.length === 0) {
  console.log(`  ✓ ${testFiles.length} 个文件运行前后 SHA-256 全部一致 —— 被扫描文件未被本脚本修改`);
  console.log('     (⚠️ 声明范围仅限被扫描文件;`_` 过滤自检的临时探针不在其列,见开头说明)');
} else {
  console.log(`  ✗ ${changed.length} 个文件变化(不应发生):${changed.slice(0, 5).join(', ')}`);
}

/* ── 7. 汇总 ── */
console.log('\n[汇总]');
console.log(`  自检未过检测器:${labFail} / ${labResults.length}`
  + `(分类器 ${LABS.length} + ★T ${T_LABS.length} + ★乙类三分 ${SUB_LABS.length}`
  + ` + ★掩码器 ${MASK_LABS.length} + ★量纲 ${G_LABS.length} + ★注释撑判据 ${S_LABS.length})`);
console.log(`  甲(字面量/具名常量期望值):${tot.甲}`);
console.log(`  乙(两侧同源):${tot.乙}`
  + `   ← ★三分:乙-A(兜底档)${subCount['乙-A']} / 乙-B(守确定性)${subCount['乙-B']} / **乙-C(守错对象)${subCount['乙-C']}**`);
console.log(`      邻近对照:有 ${withGuard} / 无 ${noGuard}`);
console.log(`  丙(两侧独立权威,推定):${tot.丙}`);
console.log(`  ?(需人工判):${tot['?']}`);
console.log(`  ★[T?] 「标题声称的量不在判据参数中」候选:${tCands.length} 条(待人工复核)`);
console.log(`  ★[量纲] 「同一表达式里 1024 基与 1000 基混用」候选:${dimCands.length} 条(待人工判哪侧对)`);
console.log(`  单一来源候选组:${dupGroups.length}`);
console.log('');
console.log('  ⚠️ 判据边界(报告必须同时给出):');
console.log('    · 甲类 = **「期望值是字面量/具名常量」,是待判清单,不是缺陷清单**');
console.log('      它是**正常且推荐**的写法;只有「上游一改就过期」时才成为隐患');
console.log('    · **乙类三分里只有乙-C 是本脚本能证明的**;乙-A/乙-B 是启发式分栏');
console.log('    · 丙类 = **不可机械判定**,本脚本只做保守正向识别 ⇒ 只报 8 条,远少于实际');
console.log('    · [T?] = **启发式**,中文分词不可靠 ⇒ 口径刻意收窄,**宁可漏报不误报**');
console.log('    · [量纲] = **只报不一致、不判哪侧对**;只查同一表达式 ⇒ 跨函数/跨文件看不见');
console.log('    · ★ 形态 3/4(字符vs字节、单位量级)**实测 0 条真阳性 ⇒ 不做**');
console.log('      ⇒ 「没报」有两种含义:① 查过、没问题 ② **根本没查**');
console.log('         本行就是区分它们的地方 —— 未列出的形态一律属于 ②');
console.log('    · 「?」= 本脚本判据看不见,占 35% ⇒ **它的存在就是这份报告的适用范围声明**');

const bad = labFail > 0 || changed.length > 0;
/* ★ `--strict-h` = 只把 **[h] 命中**当失败(供门禁接线用)。
 *
 * ⚠️ 为什么不能只用 `--strict`:它把**乙类命中**(本仓常态 25 条)也算失败
 *    ⇒ 门禁若挂 `--strict` 会**恒红** ⇒ 接线者会以为"水位又超了"或"判据坏了"。
 *    实测:`--strict` 现在 exit 1,原因是「有 25 条乙类命中」——
 *    **那是既有状态,不是缺陷**(乙类 = 两侧同源,正常且推荐的写法,
 *    只有"上游一改就过期"时才是隐患)。
 * ⇒ 于是给门禁一个**精确**的开关:只拦"判据本身坏了"这一件。
 *   `--strict`(原样保留,给人工复核用)/ `--strict-h`(给门禁用)。 */
const STRICT_H = process.argv.includes('--strict-h');

if (STRICT_H && (bad || cbKept.length > 0)) {
  console.log(`\n[--strict-h] ${bad ? '自检失败或只读被破坏'
    : `[h] 有 ${cbKept.length} 处「判据只被注释满足」`} ⇒ exit 1`);
  process.exit(1);
}
if (STRICT && (bad || tot.乙 > 0 || cbKept.length > 0)) {
  console.log(`\n[--strict] ${bad ? '自检失败或只读被破坏'
    : tot.乙 > 0 ? `有 ${tot.乙} 条乙类命中(既有状态,非缺陷)`
      : `[h] 有 ${cbKept.length} 处「判据只被注释满足」`} ⇒ exit 1`);
  process.exit(1);
}
if (bad) process.exit(1);
void allScanned;
console.log('\n✓ 审计完成(未加 --strict,命中不导致失败)');
