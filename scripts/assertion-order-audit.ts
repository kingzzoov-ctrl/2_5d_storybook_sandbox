/**
 * 断言「零信息」普查器 —— 只读分析器。**不起子进程、不改任何文件、不进退出码。**
 *
 * > `node scripts/assertion-order-audit.ts`             # 摘要
 * > `node scripts/assertion-order-audit.ts --file tests/WS-01.test.ts`
 * > `node scripts/assertion-order-audit.ts --list`      # 逐条清单(按文件 = 写域分组)
 * > `node scripts/assertion-order-audit.ts --selftest`  # 判据自检(合成断言,不读真实文件)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## ★ 我不声称什么(先读这一节 —— 这是最容易搞错的一句话)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```
 * 1 ✗ 本脚本的产出**不等于**「该删的断言名单」。
 *      零信息 ⇒ 该断言不提供**独立**信息;但**该保留哪条是产品判断** ——
 *      通常该留的是**更严**的那条(它覆盖更多失败情形),删掉更松的那条。
 *      本脚本只**指出配对关系**,不指定删哪条。
 *
 * 2 ✗ 本脚本**不**声称覆盖全部「顺序中断」后果。
 *      它只覆盖一种**可判定**的形态:同块内两条断言观测**同一表达式**。
 *      观测**不同**表达式的两条之间的耦合(如 eq(f(x),a) 与 g(y)>b)
 *      本脚本**看不见** ⇒ 归入「未覆盖」,不计入任何结论。
 *
 * 3 ✗ 「顺序可被阻断」那一列 **不**等于「这些断言有缺陷」。
 *      它回答的是**复核可信度**问题:用「注入→看块是否红」验牙时,
 *      前面任何一条失败都会挡住后面 ⇒ 那些断言**在这次实验里没被验到**。
 *      这是**实验方法的局限**,不是被扫代码的缺陷。
 *
 * 4 ✗ 本脚本**不**判断断言的语义是否正确。
 *      值对不对(期望值是不是该是这个数)是**另一条轴**,不在本工具内。
 *
 * 5 ✗ 本脚本**不**改变运行时语义。harness 仍是 throw 式;
 *      本工具只是**枚举**那个性质的后果,不改它。
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## 它要解决的病(来源:task-85 任务 H)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shared/testing/harness.ts:28/162` 的 `ok()` / `eq()` 是 **throw 式**:
 * ```
 *   ok()  ⇒ if (!cond) throw new Error(msg)
 *   eq()  ⇒ throw new Error(...)
 * ```
 * ⇒ **一个块里第一条失败的断言就中断函数体**,其后断言**从未执行**。
 * ⇒ 后果:`tests/` 里「块绿」**不**等于「块内每条断言都被验证过」。
 *
 * task-89(terrain-physicist)用**常量注入**扫 158 个块:13 有遮蔽 / 15 无遮蔽 /
 * **130 无法判定**(该块所有断言都没被那 23 个常量驱动到)。
 *
 * ## 本脚本走**另一条轴**,所以能覆盖那 130 个块
 *
 * ```
 * task-89                    注入**生产常量** ⇒ 看块是否变红 ⇒ 需该常量驱动到该块
 * assertion-audit.ts         判**值来源**(甲/乙/丙)      ⇒ 不看顺序、不看蕴含
 * assertion-teeth-report.ts  列**候选注入点**            ⇒ 不判蕴含
 * ★ 本脚本                   判**同块内两条断言的逻辑蕴含** ⇒ 不注入、不跑套件
 * ```
 *
 * ## 核心判据(为什么它**可判定**,不是"扫一扫描一扫")
 *
 * ```
 * 设同块内第 i 条与第 j 条断言(i < j)的**第 1 个顶层实参表达式文本完全相同** T(i)=T(j)=X。
 * ⇒ 两者观测**同一个值** v = value(X) ⇒ 两条的真假完全由 v 决定
 * ⇒ 于是可判:∀v: P_i(v) ⇒ P_j(v) ?
 *    · 为真 ⇒ 第 j 条**永远不能提供第 i 条之外的信息** ⇒ 零信息
 *    · 为假 ⇒ ∃v 使 i 通过而 j 失败 ⇒ j **能独立报红** ⇒ 有牙
 * ⇒ ★ 与"注入什么"无关、与"跑到第几条"无关 ⇒ **不受顺序中断影响**
 * ```
 * ⚠️ **必须同块**:跨块的执行顺序由块间流程决定,不在本工具判据内。
 *
 * ## 强度分档(★ 必须与结论同时报)
 *
 * ```
 * A 逻辑必然 : 两条都「等值于字面量」(eq(X,c) / ok(X===c))
 *              ⇒ v 被钉成唯一值 ⇒ 蕴含**与取值域无关** ⇒ 最强
 * B 域内验证 : 谓词含范围/不等/位运算 ⇒ 在**有限取值域**上 0 反例
 *              ⇒ 只能说"该域内蕴含",**不声称实数域** ⇒ 中等
 * 未覆盖     : 第 1 实参不同 / 无法解析为数值谓词 / 期望值是查不到的标识符
 *              ⇒ ★ **显式成桶**,不许"其余归入默认类"(task-89 自曝 3 的教训)
 * ```
 * ★ 依据是 **`prot` 的形态**,**不是**取值域(tier_check 实测订正:
 *   4 组等值式 prot 在非整数域上同样 0 反例)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const TESTS_DIR = join(ROOT, 'tests');
const PROD_DIRS = ['server/src', 'client/src', 'shared'];

/**
 * 把 UTF-8 源码剥成「只剩代码」—— 去行注释、**去块注释**、字符串/模板 → 空串。
 *
 * ★ 这个函数是必需的,不是洁癖:`judgement_audit.ts` 的检测器 D
 *   (「对未剥注释的原文做 match(/x/g) 计数」)**抓到了我第一版**:
 *   ```
 *   scripts/assertion-order-audit.ts  for (const m of src.matchAll(/export const .../g))
 *   ```
 *   而我的常量表判据里含 `export` ⇒ 落在 D 的扫描目标内。
 *
 * ## ★ 但要**分开报**:这是**潜伏**,不是**现行缺陷**(我实测核过)
 * ```
 *   污染要成立需两件事同时为真:
 *     (a) docblock 里有形如 `export const X = N;` 的**例子**  ⇒ ✅ 成立(实测 1 处)
 *     (b) collectNumericConsts **会扫到本文件**                ⇒ ❌ **不成立**
 *         (PROD_DIRS = server/src·client/src·shared,而本文件在 scripts/)
 *   ⇒ 实测:剥注释后命中 0,不剥注释命中 1 ⇒ 该例子形如真声明;
 *     但它**此刻**不会被收进常量表。
 *   ⇒ 准确表述:**一旦扫描范围扩到 scripts/,那行例子会被当成真声明**,
 *     而我的常量表是"先到先得" ⇒ **可能盖掉真值**。
 * ⇒ 我按 D 修(它报的是真实坏形态),但**不声称"修了一个现行缺陷"** ——
 *   把潜伏说成现行,与"把崩了说成红了"同族。
 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let s = '';
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]!;
      const c2 = line[i + 1];
      if (!inBlock && c === '/' && c2 === '/') break;              /* 行注释 ⇒ 行尾丢弃 */
      if (!inBlock && c === '/' && c2 === '*') { inBlock = true; i += 1; continue; }
      if (inBlock && c === '*' && c2 === '/') { inBlock = false; i += 1; continue; }
      if (!inBlock) {
        if (c === "'" || c === '"' || c === '`') {
          /* 跳过整条字符串/模板字面量 */
          const q = c;
          i += 1;
          while (i < line.length) {
            if (line[i] === '\\') { i += 2; continue; }
            if (line[i] === q) break;
            i += 1;
          }
          continue;
        }
        s += c;
      }
    }
    out.push(s);
  }
  return out.join('\n');
}

/**
 * 收集**模块级 `export const` 的全部名字**(不论初值是什么形态)。
 *
 * ★ 为什么需要它(我第二版引入的**假阴性**):
 * ```
 * client/src/ui/inventory.ts
 *   L119  export const INVENTORY_ROWS = INVENTORY_LAYOUT.rows;
 *   L127  export const INVENTORY_SLOTS = INVENTORY_LAYOUT.slots;        ← ★ 初值是**取值表达式**
 *   L139  export const INVENTORY_PAGE_COUNT = INVENTORY_LAYOUT.pageCount;
 * ⇒ 它们**是**模块级不可变绑定,但初值不是**数字字面量**
 *   ⇒ 我的 collectNumericConsts 收不进去 ⇒ 被误判成"局部变量"
 *   ⇒ 加上"中间有语句就不报"的护栏后,真发现(WS-09 L1586/L1589)被**误杀**
 * ```
 * ⇒ 修法:`immutable = 有数值的常量 ∪ 模块级 export const 名`
 *   ⇒ 初值形态不影响"运行期不可变"这个性质。
 * ⚠️ 只收 `const`,**不收 `let`/`var`**(那可被改写)。
 */
function collectModuleLevelConsts(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    let ents: string[];
    try { ents = readdirSync(dir); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!e.endsWith('.ts')) continue;
      let src: string;
      try { src = readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of stripCommentsAndStrings(src).matchAll(/export\s+const\s+([A-Za-z_]\w*)/g)) {
        out.add(m[1]!);
      }
    }
  };
  for (const d of PROD_DIRS) walk(join(ROOT, d));
  /* 冻结层与测试助手里的常量同样是模块级 */
  walk(join(ROOT, 'shared'));
  walk(join(ROOT, 'client/src'));
  return out;
}

/**
 * 「该 subject 在两条断言之间是否**不可能被改写**」
 * ```
 *   是模块级 export const(不论初值形态) ⇒ 不可能 ⇒ 无需看中间语句
 *   否则(局部变量 / let / 参数)         ⇒ 可能   ⇒ 要求两条之间无语句
 * ```
 */
function isImmutableSubject(name: string, numericConsts: Map<string, number>, moduleConsts: Set<string>): boolean {
  return numericConsts.has(name) || moduleConsts.has(name);
}

/* ═══════════════════ 1. 常量表:标识符 → 数值 ═══════════════════ */

function collectNumericConsts(): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    let ents: string[];
    try { ents = readdirSync(dir); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!e.endsWith('.ts')) continue;
      let src: string;
      try { src = readFileSync(p, 'utf8'); } catch { continue; }
      /* ★ 在**剥注释后**的代码上匹配 —— 否则 docblock 里的例子会被当成真声明 */
      for (const m of stripCommentsAndStrings(src).matchAll(/export const ([A-Za-z_]\w*)\s*(?::[^=;]+)?=\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*;/g)) {
        if (!out.has(m[1]!)) out.set(m[1]!, Number(m[2]));
      }
    }
  };
  for (const d of PROD_DIRS) walk(join(ROOT, d));
  return out;
}

/* ═══════════════════ 2. 注释感知 + 结构提取 ═══════════════════ */

/* ⚠️ 本节原有 `blockCommentMap()` 与 `structural()` 两个函数,已**删除** ——
   它们被 `maskLines()`/`maskSameLength()` 取代,原因见上面的长注释:
   那两个函数**不保持长度** ⇒ 列号与原文错位 ⇒ 用它取原文会取到错位内容。
   ⇒ 删除是**我自己做的**,因为 verify.ts 的"零引用/死代码"检查会报它们(我也确实不再用)。 */

/**
 * ★★ **等长**掩码:把字符串体与注释体按**原位等长**填成占位符 `\u0001`。
 *
 * ## 为什么必须有这个函数(而不是上面的 `structural`)
 * ```
 * structural() 把 'abc' 压成 '' ⇒ **长度变了** ⇒ 列号不再对应原文
 * ⇒ 我若拿 structural 的列号去 slice 原文字符串,取到的是**错位的内容**
 *   (这不是理论风险:我第一版就是这么写的,导致证据全渲染成 `eq(x,20,'')`)
 * ```
 * ⇒ 等长掩码同时满足两件事:
 * ```
 *   ① 括号/逗号扫描只看真实代码 ⇒ 字符串与注释里的 `(` `,` 不干扰
 *   ② 每个字符的**下标与原文一一对应** ⇒ 可用同一区间去原文取要显示的文本
 * ```
 * ⇒ 于是"解析用掩码、显示用原文"不再需要两套列号。
 */
function maskSameLength(line: string, inComment: boolean): { mask: string; endsInComment: boolean } {
  const F = '\u0001';
  const out: string[] = [];
  let inS: string | null = null;      /* 当前字符串定界符 */
  let inC = inComment;                /* 在块注释里 */
  let inLine = false;                 /* 在行注释里 —— 第一版漏了这个标志 */
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    const c2 = line[i + 1];
    if (inLine) { out.push(F); continue; }
    if (inC) {
      if (c === '*' && c2 === '/') { inC = false; out.push(F, F); i += 1; continue; }
      out.push(F); continue;
    }
    if (inS !== null) {
      /* ★★ **定界符必须原样保留**,只掩字符串**体**。
         ⚠️ 我第一版把收尾引号也掩成 F ⇒ 掩码里字符串**永不闭合**
           (`'abc'` → `'\u0001\u0001\u0001`)⇒ 之后所有文本都被当成"仍在字符串内":
             · `splitTopArgs` 的 inS 再也不复位 ⇒ 后续实参切分全错
             · `isStructBlank`/括号扫描跟着错位
           ⇒ 实测:零信息 **6+2 → 0**(又一个"表面正常、结论全错")
         ⇒ 保留引号后,掩码与原文**逐列对应**且结构完整。 */
      if (c === '\\') { out.push(F); i += 1; if (i < line.length) out.push(F); continue; }
      if (c === inS) { out.push(c); inS = null; continue; }
      out.push(F); continue;
    }
    if (c === '/' && c2 === '*') { inC = true; out.push(F, F); i += 1; continue; }
    if (c === '/' && c2 === '/') { inLine = true; out.push(F, F); i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; out.push(c); continue; }
    /* ★★ 反斜杠转义对也要掩掉 —— 否则**正则字面量**里的 `\(` 会被当成真的左括号:
       ```
       ok(/consumeGroundItem\s*\(/.test(src), ...)
                        ^^ 这不是括号,是转义
       ⇒ 深度虚增 1 ⇒ 该 test 块的深度**永远回不到 0**
       ⇒ 配平失败 ⇒ 整个块被 `if (end < 0) continue` 丢掉
       ```
       ⚠️ 实测:这一步让 **22 个真块**被丢(块数 1373 → 1351),
          而它们全都是货真价实的 `test('...', () => {`(WS-04/WS-07/WS-09/WS-11/FND-* 都有)。
       ⇒ 后果:那 22 个块里的断言不参与分组 ⇒ **漏报**。
       ★ 转义字符恰好 2 个字符 ⇒ 掩成 `F F` 仍保持等长。 */
    if (c === '\\') { out.push(F); i += 1; if (i < line.length) out.push(F); continue; }
    out.push(c);
  }
  return { mask: out.join(''), endsInComment: inC };
}

/**
 * 逐行算等长掩码。
 *
 * ⚠️ 我第一版的 bug(实测暴露:块数 1484 → **1495**,零信息 6 → **0**):
 * ```
 * 我写 `if (c === '/' && c2 === '/') { out.push(F); continue; }`
 *   —— 只把**第一个** '/' 掩了!下一轮 i 指向第二个 '/',而 c2 已不是 '/'
 *   ⇒ 落到最后的 `out.push(c)` ⇒ 行注释**余下全部原样保留**
 * ⇒ 后果:
 *     · 注释里写的 `test('...')` 被当成真块(块数多 11 个)
 *     · 注释里写的 `// eq(x, 1)` 被当成真断言(顶层断言 8124 → 8230)
 *     · 而 `//` 后的内容一进来就把后面的源码遮住 ⇒ 配对判据大面积失效
 *       ⇒ 零信息 **6 → 0**(假绿:看起来"全干净了")
 * ⇒ ★ 又一次"**表面可用、结论全错**":exit=0、自检 14/14、没有异常信号。
 *   抓住它的是**分母变了**(1484→1495)—— 所以分母必须与上次对账,不能只看结论。
 * ```
 */
function maskLines(rawLines: string[]): { masked: string[]; inComment: boolean[] } {
  const masked: string[] = [];
  const starts: boolean[] = [];
  let inC = false;
  for (const l of rawLines) {
    starts.push(inC);
    const r = maskSameLength(l, inC);
    masked.push(r.mask);
    inC = r.endsInComment;
  }
  return { masked, inComment: starts };
}

/**
 * 在**原文**行上找断言。
 *
 * ★★ 返回两个文本,职责**分开**(这条是陷阱 136 的对策):
 * ```
 *   args  ← 从**结构行**(字符串已剥)解析 ⇒ 保证括号配平与实参切分正确
 *   text  ← 从**原文行**摘录         ⇒ 证据可读(带真实消息文本)
 * ```
 * ⚠️ 我第一版把 `text` 也从结构行拼 ⇒ 消息全变成 `''`
 *   (`eq(grew, 20, '')`)⇒ **证据失去了它该有的信息量**。
 *   当时它"看起来正常",因为是**静默降级**:结构行就是这么构成的。
 * ⇒ 而改回原文后,**证据里可能出现源码自己的 `★`** ⇒ 数 `★` 会多算(陷阱 136)。
 *   ⇒ 故显示时给每条命中一个**源码不可能产生的 ASCII 前缀** `[HIT]`,
 *     使"数命中"不依赖任何可能出现在内容里的字符。
 */
type Assertion = { kind: string; line: number; args: string[]; text: string };
const ASSERT_FNS = ['ok', 'eq', 'near', 'includes', 'inRange', 'assert'];

/** 顶层实参切分(深度 0 的逗号)。 */
function splitTopArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = '';
  let inS: string | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (inS !== null) {
      cur += c;
      if (c === inS && s[i - 1] !== '\\') inS = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inS = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/** 扫一个文件:返回所有**顶层**(块体第 1 层)断言,带行号。 */
function topLevelAssertions(rawLines: string[], st: string[]): Assertion[] {
  const out: Assertion[] = [];
  for (let k = 0; k < rawLines.length; k += 1) {
    const s = st[k]!;
    let depth = 0;
    for (let c = 0; c < s.length; c += 1) {
      const ch = s[c]!;
      if (ch === '(') {
        if (depth === 0) {
          const m = /(\b[A-Za-z_]\w*)\s*$/.exec(s.slice(0, c));
          const fname = m?.[1] ?? '';
          if (ASSERT_FNS.includes(fname)) {
            /* 用结构行定位配对右括号,再按同区间从**原文**取文本 */
            let done = false; let dd = 0;
            for (let k2 = k; k2 < rawLines.length && !done; k2 += 1) {
              const s2 = st[k2]!;
              const from = k2 === k ? c : 0;
              for (let c2 = from; c2 < s2.length; c2 += 1) {
                const ch2 = s2[c2]!;
                if (ch2 === '(') { dd += 1; if (dd === 1) continue; }
                else if (ch2 === ')') { dd -= 1; if (dd === 0) { done = true; break; } }
              }
            }
            /* ★★ 两职责分开:掩码定边界(列号与原文**一一对应**),原文取字符。
               ⚠️ 我改写这段时**丢掉了原版的一处 `continue`**,导致实参文本里
                  带上了断言自己的**开括号**:
                    rendered = `(MAX_EVENTS_PER_FRAME, 4096, '……'`
                  ⇒ `splitTopArgs` 一开始就 depth=1 ⇒ 深度 0 的逗号**永不出现**
                  ⇒ `args[0]` 变成**整串** ⇒ `subjectOf()` 拿不到裸标识符
                  ⇒ 全部配对 `continue` ⇒ 零信息 **6+2 → 0**(第三个假绿)。
               ⇒ 修法:首行从开括号的**后一个字符**开始;闭括号用「d2 已经为 0」判定,
                  这样嵌套括号(`((A & (B-1)) === 0)`)也正确。 */
            let rendered = '';           /* 掩码文本 ⇒ 给 splitTopArgs 解析实参 */
            let rawShown = '';           /* 原文文本 ⇒ 给人看的证据 */
            {
              let d2 = 0; let fin = false;
              for (let k2 = k; k2 < rawLines.length && !fin; k2 += 1) {
                const s2 = st[k2]!;
                const raw2 = rawLines[k2] ?? '';
                const from = k2 === k ? c + 1 : 0;   /* ★ +1:跳过断言自己的开括号 */
                let last = s2.length;
                for (let c2 = from; c2 < s2.length; c2 += 1) {
                  const ch2 = s2[c2]!;
                  if (ch2 === '(') { d2 += 1; }
                  else if (ch2 === ')') {
                    if (d2 === 0) { last = c2; fin = true; break; }   /* 本断言的闭括号 */
                    d2 -= 1;
                  }
                }
                /* ★ 掩码与原文**等长** ⇒ 同一区间可直接取两边 */
                rendered += s2.slice(from, last);
                rawShown += raw2.slice(from, last);
                if (!fin) { rendered += ' '; rawShown += ' '; }
              }
            }
            out.push({
              kind: fname, line: k + 1, args: splitTopArgs(rendered),
              text: `${fname}(${rawShown.replace(/\s+/g, ' ')})`.slice(0, 220),
            });
          }
        }
        depth += 1;
      } else if (ch === ')') depth -= 1;
    }
  }
  return out;
}

/* ═══════════════════ 3. 谓词与蕴含判定 ═══════════════════ */

function toNum(expr: string, consts: Map<string, number>): number | null {
  const t = expr.trim();
  if (/^-?[\d.]+(?:e[+-]?\d+)?$/.test(t)) return Number(t);
  if (consts.has(t)) return consts.get(t)!;
  return null;
}

type Pred = { f: (v: number) => boolean; tier: 'A' | 'B'; desc: string };

/**
 * ★★ 「被观测表达式」抽取 —— 这是本工具**最关键的一处**,我第一版在这里错过
 *
 * ```
 * eq(X, 4096)   第 1 实参 = 被观测的表达式  ⇒ subject = "X"
 * ok(X > 1)     第 1 实参 = **整个条件体**  ⇒ subject **不是** "X > 1",而是 "X"
 * ```
 * ⇒ 若直接比 `args[0]`,那么 `eq(...,4096)` 与 `ok(...)` 的 args[0] **永不相等**
 *   ⇒ 所有含 `ok` 的配对**被静默跳过** ⇒ 工具表面可用、实则漏掉一大类。
 * ⇒ 我自己的判据自检(T1/T2/A1-A4 全部报 `skip`)把这个 bug 抓了出来 ——
 *   **这就是"判据自检要有已知答案"的用处**。
 */
function subjectOf(a: Assertion): string | null {
  const A = (a.args[0] ?? '').trim();
  if (A.length === 0) return null;
  if (a.kind === 'eq' || a.kind === 'includes' || a.kind === 'near' || a.kind === 'inRange') {
    /* 这些形态的第 1 实参就是被观测表达式,且必须是**裸标识符**
       (若是 `f(x)` 之类的复合式,值来源不确定 ⇒ 交给未覆盖桶) */
    return /^[A-Za-z_]\w*$/.test(A) ? A : null;
  }
  if (a.kind === 'ok' || a.kind === 'assert') {
    /* ★ 必须整条条件体**就是一次**比较,否则无法约成数值谓词 ⇒ 未覆盖 */
    const m = /^\(*\s*([A-Za-z_]\w*)\s*(===|==|!==|!=|>=|<=|>|<)\s*(-?[\w.]+)\s*\)*$/.exec(A);
    return m === null ? null : m[1]!;
  }
  return null;
}

/** 由一条断言构造「subject 取值 v 时该断言是否为真」的谓词。 */
function buildPred(a: Assertion, consts: Map<string, number>): Pred | null {
  const A = (a.args[0] ?? '').trim();
  if (A.length === 0) return null;
  if (a.kind === 'eq' || a.kind === 'includes') {
    if (subjectOf(a) === null) return null;
    const rhs = a.args[1];
    if (rhs === undefined) return null;
    const n = toNum(rhs, consts);
    if (n === null) return null;
    /* eq 用严格比较;includes 语义不同 ⇒ 只在单值时等价,保守按 eq 处理并降 B 档 */
    const tier: 'A' | 'B' = a.kind === 'eq' ? 'A' : 'B';
    return { f: (v) => v === n, tier, desc: `v === ${n}` };
  }
  if (a.kind === 'near') {
    if (subjectOf(a) === null) return null;
    const rhs = toNum(a.args[1] ?? '', consts);
    if (rhs === null) return null;
    const eps = toNum(a.args[2] ?? '', consts) ?? 0;
    return { f: (v) => Math.abs(v - rhs) <= eps, tier: eps === 0 ? 'A' : 'B', desc: `|v-${rhs}| <= ${eps}` };
  }
  if (a.kind === 'inRange') {
    if (subjectOf(a) === null) return null;
    const lo = toNum(a.args[1] ?? '', consts);
    const hi = toNum(a.args[2] ?? '', consts);
    if (lo === null || hi === null) return null;
    return { f: (v) => v >= lo && v <= hi, tier: 'B', desc: `v in [${lo},${hi}]` };
  }
  if (a.kind === 'ok' || a.kind === 'assert') {
    const m = /^\(*\s*([A-Za-z_]\w*)\s*(===|==|!==|!=|>=|<=|>|<)\s*(-?[\w.]+)\s*\)*$/.exec(A);
    if (m === null) return null;
    const op = m[2]!;
    const num = toNum(m[3]!, consts);
    if (num === null) return null;
    const f = (v: number): boolean => {
      switch (op) {
        case '===': case '==': return v === num;
        case '!==': case '!=': return v !== num;
        case '>': return v > num;
        case '>=': return v >= num;
        case '<': return v < num;
        case '<=': return v <= num;
        default: return false;
      }
    };
    /* 等值式 ⇒ A 档(与域无关);范围式 ⇒ B 档(域内验证) */
    const eqForm = op === '===' || op === '==';
    return { f, tier: eqForm ? 'A' : 'B', desc: `v ${op} ${num}` };
  }
  return null;
}

/** 取值域:整数 + 0.5 小数 + 无理数 + 位运算关键点 + 极值 + NaN/±Inf。 */
function buildDomain(): number[] {
  const d: number[] = [];
  for (let i = -8; i <= 4200; i += 1) d.push(i);
  for (let i = -4; i <= 320; i += 0.5) d.push(i);
  for (const v of [Math.PI, Math.E, Math.SQRT2, Number.EPSILON, 1e-300, 1e6, 1e9, 65535, 65536, 65537,
    Number.MIN_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity,
    255.5, 256.5, 511.9999999, 512.0000001, 1023.5, 1024.5, 4095.5, 4096.5,
    2.9999999, 3.0000001, 99.5, 100.5, 127.5, 128.5]) d.push(v);
  return d;
}
const DOMAIN = buildDomain();

/** ∀v: Pi(v) ⇒ Pj(v)。找到反例即返回。 */
function implies(pi: Pred, pj: Pred): { implies: boolean; cex: number | null; checked: number } {
  let checked = 0;
  for (const v of DOMAIN) {
    let a = false; let b = false;
    try { a = pi.f(v); } catch { continue; }
    try { b = pj.f(v); } catch { continue; }
    checked += 1;
    if (a === true && b === false) return { implies: false, cex: v, checked };
  }
  return { implies: true, cex: null, checked };
}

/* ═══════════════════ 4. 分块 + 审计 ═══════════════════ */

type Block = { name: string; start: number; end: number; assertions: Assertion[] };

function parseFile(path: string): { blocks: Block[]; topCount: number } {
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const raw = src.split('\n');
  /* ★ 用**等长掩码**:列号与原文一一对应 ⇒ 后面可同区间取原文显示 */
  const { masked: st } = maskLines(raw);

  const blocks: Block[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    /* 认定「块首」的判据:
       ```
         (a) 裸 `test(`             —— 本仓 1382 处的绝对主流
         (b) `harness.test(`        —— 实测 1 处,同样是真块
       ```
       ★ 必须**排除** `xxx.test(` 形态(`RegExp.test(src)` / `REQUIRE_WS_RE.test(...)` 等):
         本仓这类有 145 处(实测统计),它们**不是块**,只是正则匹配调用。
         ⚠️ 我最初用 `\btest\s*\(` —— 而 `\b` 在 `.` 之后**照样匹配**
           ⇒ 145 处正则调用被当成"块" ⇒ 块数虚高、断言被错误分组。 */
    const isBlockHead = /(?<![\w.])\btest\s*\(/.test(st[i]!) || /harness\.test\s*\(/.test(st[i]!);
    if (!isBlockHead) continue;
    let d = 0; let seen = false; let end = -1;
    for (let k = i; k < raw.length && end < 0; k += 1) {
      for (const ch of st[k]!) {
        if (ch === '(') { d += 1; seen = true; }
        else if (ch === ')') { d -= 1; if (seen && d === 0) { end = k; break; } }
      }
    }
    if (end < 0) continue;
    const name = /['"`]([^'"`]*)['"`]/.exec(raw.slice(i, i + 3).join(' '))?.[1] ?? '(匿名块)';
    blocks.push({ name, start: i + 1, end: end + 1, assertions: [] });
  }

  /* 只保留**块体第 1 层**的断言:用"该行在块内且其前导深度恰为块体层"近似
     —— 简化做法:块内所有顶层断言按"它是否在块范围内"归入最内层块。 */
  const all = topLevelAssertions(raw, st);
  for (const a of all) {
    const b = blocks.find((x) => x.start <= a.line && a.line <= x.end);
    if (b) b.assertions.push(a);
  }
  for (const b of blocks) b.assertions.sort((x, y) => x.line - y.line);
  return { blocks, topCount: all.length };
}

/** ★ 掩码占位符(字符串体/注释体的填充字符)。 */
const MASK_FILL = '\u0001';

/**
 * 「这一行在**结构上**是空的吗」—— 即去掉掩码占位符后什么都没有。
 *
 * ⚠️ 必须用这个函数,**不能**直接 `s.trim().length === 0`:
 * ```
 * 掩码行把注释体填成 \u0001 ⇒ 纯注释行 trim 后**不空** ⇒ 被当成"有语句"
 * ⇒ 我实测踩到:所有"两条之间有注释"的配对全被 `hasInterveningStatement`
 *   判成"有间隔" ⇒ 零信息 **6 → 0**(又一个假绿)
 * ```
 */
function isStructBlank(s: string): boolean {
  return s.split(MASK_FILL).join('').trim().length === 0;
}

/**
 * ★★★ 「同一 subject ⇒ 同一取值」这个前提**必须被验证** —— 我第一版没验证,报出了假阳性
 *
 * ```
 * 我的判据建立在一个隐含前提上:
 *   两条断言观测同一表达式 X ⇒ 它们的 X **是同一个值**
 * ```
 * ■ 对**生产常量**成立:模块级 `export const` 在运行期不可变 ⇒ 谁在读都是同一个数。
 * ■ 对**局部变量**不成立:两条之间只要有**任何语句**,变量就可能被改写。
 *
 * **我实测到的反例(读原文发现的)**:
 * ```
 * tests/WS-12.test.ts
 *   L248  eq(gx, 20, '权威到达后更新');
 *   L249  apply(telegraphCenterOf(createRoomState('demo'), 'p1'));   ← ★ 状态变了
 *   L250  eq(gx, 20, '再次未知时保持上一帧的权威值');
 * ⇒ 两条**测的是不同的事**:L248「权威到达 ⇒ 更新为 20」、
 *   L250「再次未知 ⇒ **保持**上一帧值」。
 *   若实现错了(未知时退回出生点 8),则 **L248 过、L250 红** ⇒ L250 **有牙**。
 * ⇒ 我的工具把 `eq(gx,20)` 与 `eq(gx,20)` 判成"纯重复" ⇒ **假阳性**。
 * 同形:tests/WS-FND-02.test.ts L158/L162 之间隔着 `off()`。
 * ```
 * ⇒ **修法**(按 subject 的性质分两种处理):
 * ```
 *   甲 subject 是**生产常量**(在常量表里)  ⇒ 不可变,无需看中间语句 ⇒ 照常判定
 *   乙 subject 是**局部变量**(不在表里)      ⇒ 要求两条断言**之间无任何语句**
 *        (只允许空行与注释)⇒ 否则 **不报**(归入"未覆盖",不猜)
 * ```
 * ★ 这个修法**不会制造漏报式的假绿**:它把"看不准"的归入未覆盖,
 *   而不是把它们当成"没问题"。与脚本顶部「我不声称什么」第 2 条一致。
 */
function hasInterveningStatement(
  rawLines: string[], st: string[], fromLine: number, toLine: number,
): boolean {
  /* 检查 (fromLine, toLine) 开区间内是否有非空、非注释的结构行 */
  for (let i = fromLine; i < toLine - 1; i += 1) {
    const s = st[i] ?? '';
    const raw = (rawLines[i] ?? '').trim();
    if (raw.length === 0) continue;                     /* 空行 */
    if (isStructBlank(s)) continue;                     /* 纯注释行(掩码后无实体) */
    return true;
  }
  return false;
}

type ZeroInfo = {
  file: string;
  blockStart: number;
  line: number;
  blockedByLine: number;
  expr: string;
  tier: 'A' | 'B' | 'R';
  text: string;
  blockerText: string;
  subjectKind: '常量' | '局部';
  /** 受害断言里除 subject 外引用的**另一个**模块级符号(空 = 纯结构蕴含) */
  otherSymbols: string[];
};

/**
 * ★★ 第三档「R = 关系守卫」—— 我实测发现的**过宽分类**
 *
 * ```
 * 受害断言形如  ok(INVENTORY_SLOTS >= TOTAL_ITEM_COUNT)   ← 右侧是**另一个**常量
 * ⇒ 我的判据在 TOTAL_ITEM_COUNT **当前值**下算出"蕴含"
 * ⇒ 但若 TOTAL_ITEM_COUNT 从 320 改成 400:
 *     blocker `INVENTORY_SLOTS === 336` 不变,mask 变 `336 >= 400` ⇒ **不蕴含**
 *   ⇒ 那一刻 mask **就能独立失败** ⇒ 它守的是**两个量的关系**(容量装得下内容),
 *     不是"重复陈述同一个数"
 * ⇒ ★ 删掉它 = 丢掉一条真守卫(正是本仓 task-88 在补的那一类)
 * ⇒ 故必须与 A/B 档**分列**,不许混进"零信息"总数
 * ```
 */
function otherModuleSymbols(victimText: string, subject: string, moduleConsts: Set<string>): string[] {
  const ids = [...victimText.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => m[1]!);
  const out: string[] = [];
  for (const x of ids) {
    if (x === subject) continue;
    if (/^(ok|eq|near|inRange|includes|assert|true|false|null|undefined|Number|Math|toFixed|length)$/.test(x)) continue;
    if (moduleConsts.has(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

type FileRow = {
  file: string; blocks: number; asserts: number; zero: ZeroInfo[];
  blockedOnly: number; blocksWithAsserts: number;
};

function auditAll(): { files: FileRow[]; zero: ZeroInfo[] } {
  const consts = collectNumericConsts();
  const moduleConsts = collectModuleLevelConsts();
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts')).sort();
  const out: FileRow[] = [];
  const allZero: ZeroInfo[] = [];

  for (const f of files) {
    const path = join(TESTS_DIR, f);
    const rel = `tests/${f}`;
    const { blocks } = parseFile(path);
    /* ★ 为"中间有没有语句"的检查准备结构行 */
    const rawOfFile = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const stOf = maskLines(rawOfFile).masked;
    let asserts = 0; const zero: ZeroInfo[] = [];

    for (const b of blocks) {
      asserts += b.assertions.length;
      const claimed = new Set<number>();
      for (let i = 0; i < b.assertions.length; i += 1) {
        const ai = b.assertions[i]!;
        for (let j = i + 1; j < b.assertions.length; j += 1) {
          const aj = b.assertions[j]!;
          if (claimed.has(aj.line)) continue;
          const si = subjectOf(ai);
          const sj = subjectOf(aj);
          if (si === null || sj === null || si !== sj) continue;

          /* ★★ 前提核对:同一 subject 是否真是同一个值?
             模块级 export const(不论初值形态)⇒ 运行期不可变 ⇒ 成立。
             局部变量 ⇒ 两条之间若有任何语句就可能被改写 ⇒ **不报**(归未覆盖)。 */
          const isConst = isImmutableSubject(si, consts, moduleConsts);
          if (!isConst && hasInterveningStatement(rawOfFile, stOf, ai.line, aj.line)) continue;

          const pi = buildPred(ai, consts);
          const pj = buildPred(aj, consts);
          if (pi === null || pj === null) continue;
          const r = implies(pi, pj);
          if (r.implies) {
            claimed.add(aj.line);
            const others = otherModuleSymbols(aj.text, si, moduleConsts);
            /* ★ 三档:'R' = 关系守卫(蕴含依赖第二个符号的当前值) */
            const tier: 'A' | 'B' | 'R' = others.length > 0 ? 'R'
              : (pi.tier === 'A' && pj.tier === 'A') ? 'A' : 'B';
            zero.push({
              file: rel, blockStart: b.start, line: aj.line, blockedByLine: ai.line,
              expr: si, tier, text: aj.text, blockerText: ai.text,
              subjectKind: isConst ? '常量' : '局部',
              otherSymbols: others,
            });
            break;
          }
        }
      }
    }

    /* ── 第 2 列「顺序上可被阻断」──
     * ★ 定义必须写清,否则这个数会被误读:
     *   口径 = 块内**非首条**断言数(同块内存在更早的同层断言 ⇒ 更早那条失败会阻断它)
     *   ⇒ 它是一个**保守上界**,且**不是缺陷指标**,是"注入验牙时可能没验到"的规模。
     *   ⚠️ 我第一版这里留了一段死代码(`blockedOnly += 0`)⇒ 删掉,改为直接计算。 */
    const blockedOnly = blocks.reduce((acc, b) => acc + Math.max(0, b.assertions.length - 1), 0);
    const blocksWithAsserts = blocks.filter((b) => b.assertions.length > 0).length;

    out.push({ file: rel, blocks: blocks.length, asserts, zero, blockedOnly, blocksWithAsserts });
    for (const z of zero) allZero.push(z);
  }
  return { files: out, zero: allZero };
}

/* ═══════════════════ 5. 判据自检 ═══════════════════ */

function selftest(): void {
  const consts = collectNumericConsts();
  const mk = (kind: string, args: string[]): Assertion => ({ kind, line: 1, args, text: `${kind}(${args.join(', ')})` });

  let pass = 0;
  console.log('════ 判据自检(合成断言;不读真实文件、不改任何文件)════\n');
  console.log('  口径:① 两条件断言的**被观测 subject 相同** ② ∀v: P_前(v) ⇒ P_后(v)');
  console.log('  ★ T1/T2/A1-A4 正是第一版**漏掉的那一类**:ok(体) 的 args[0] 是整个条件,');
  console.log('     不是被观测量 ⇒ 直接比 args[0] 会让全部含 ok 的配对静默跳过。');
  console.log(`  取值域 = ${DOMAIN.length} 个值\n`);

  /* ── 第一步:断言配对判据(纯函数,不需要源码)── */
  type Case = { name: string; i: Assertion; j: Assertion; want: 'implied' | 'independent' | 'skip' };
  const CASES: Case[] = [
    /* ── 真零信息组(应判 implied)── */
    { name: 'T1 eq(X,3.0) / ok(X>1)', i: mk('eq', ['X', '3.0', "'m'"]), j: mk('ok', ['X > 1', "'m'"]), want: 'implied' },
    { name: 'T2 eq(X,4096) / ok(X>100)', i: mk('eq', ['X', '4096', "'m'"]), j: mk('ok', ['X > 100', "'m'"]), want: 'implied' },
    { name: 'T3 eq(X,512) / eq(X,512) 纯重复', i: mk('eq', ['X', '512', "'m'"]), j: mk('eq', ['X', '512', "'m'"]), want: 'implied' },
    { name: 'T4 eq(X,1) / near(X,1,0)', i: mk('eq', ['X', '1', "'m'"]), j: mk('near', ['X', '1', '0', "'m'"]), want: 'implied' },
    { name: 'T5 eq(X,1) / eq(X,1) 大小写不同写法', i: mk('eq', ['X', '1', "'m'"]), j: mk('eq', ['X', '1', "'m'"]), want: 'implied' },
    /* ── 有牙组(应判 independent)── */
    { name: 'A1 ok(X>0) / eq(X,1024)', i: mk('ok', ['X > 0', "'m'"]), j: mk('eq', ['X', '1024', "'m'"]), want: 'independent' },
    { name: 'A2 eq(X,0) / ok(X>0) 0 不满足', i: mk('eq', ['X', '0', "'m'"]), j: mk('ok', ['X > 0', "'m'"]), want: 'independent' },
    { name: 'A3 ok(X>100) / eq(X,4096)', i: mk('ok', ['X > 100', "'m'"]), j: mk('eq', ['X', '4096', "'m'"]), want: 'independent' },
    { name: 'A4 eq(X,1) / ok(X>2) 上界交叉', i: mk('eq', ['X', '1', "'m'"]), j: mk('ok', ['X > 2', "'m'"]), want: 'independent' },
    { name: 'A5 eq(X,3) / inRange(X,0,1) 区间外', i: mk('eq', ['X', '3', "'m'"]), j: mk('inRange', ['X', '0', '1', "'m'"]), want: 'independent' },
    /* ── 应跳过(判据边界)── */
    { name: 'B1 首参不同(X vs Z)', i: mk('eq', ['X', '3', "'m'"]), j: mk('eq', ['Z', '3', "'m'"]), want: 'skip' },
    { name: 'B2 ok 体非单比较(X>1 && X<5)', i: mk('eq', ['X', '3', "'m'"]), j: mk('ok', ['X > 1 && X < 5', "'m'"]), want: 'skip' },
    /* ⚠️ 「局部变量 + 中间有语句 ⇒ 不报」这条**不放在这里**:
       它需要源码(才有"中间有没有语句"),本表是纯配对判据、没有源码。
       ⇒ 它由下面那段"前提核对自检"用**合成源码**单独验(见 C1/C2)。 */
  ];

  /* ★ C 组需要"两行之间有没有语句"这个信息 ⇒ 单独用一段**合成源码**跑,
     而不是走 atest 的轻量路径。做法:把合成源码喂给 hasInterveningStatement。 */
  {
    console.log('  ── ★ 前提核对自检(局部变量:两条之间有语句 ⇒ 必须不报)\n');
    const synth = [
      'test(\'C1 局部变量\', () => {',
      '  eq(gx, 20, \'到达后更新\');',
      '  apply(telegraphCenterOf(createRoomState(\'demo\'), \'p1\'));',
      '  eq(gx, 20, \'再次未知时保持\');',
      '});',
      '',
      'test(\'C2 局部变量纯相邻\', () => {',
      '  eq(n, 5);',
      '  eq(n, 5);',
      '});',
    ].join('\n');
    const rl = synth.split('\n');
    const stl = maskLines(rl).masked;
    const withStmt = hasInterveningStatement(rl, stl, 2, 4);   /* L2 → L4,中间有 L3 */
    const adjacent = hasInterveningStatement(rl, stl, 8, 9);   /* L8 → L9,相邻 */
    const okk1 = withStmt === true;
    const okk2 = adjacent === false;
    if (okk1) pass += 1;
    if (okk2) pass += 1;
    console.log(`  ${okk1 ? '✓' : '✗'} 中间有语句(apply(...)) ⇒ 报"有间隔"       want=true  got=${withStmt}`);
    console.log(`  ${okk2 ? '✓' : '✗'} 两条相邻(纯重复)      ⇒ 报"无间隔"       want=false got=${adjacent}\n`);
  }

  for (const c of CASES) {
    const si = subjectOf(c.i);
    const sj = subjectOf(c.j);
    let got: string;
    let extra = '';
    if (si === null || sj === null || si !== sj) got = 'skip';
    else {
      const pi = buildPred(c.i, consts);
      const pj = buildPred(c.j, consts);
      if (pi === null || pj === null) got = 'skip';
      else {
        const r = implies(pi, pj);
        got = r.implies ? 'implied' : 'independent';
        if (r.cex !== null) extra = ` cex=${r.cex}`;
      }
    }
    const okk = got === c.want;
    if (okk) pass += 1;
    console.log(`  ${okk ? '✓' : '✗'} ${c.name.padEnd(40)} want=${c.want.padEnd(12)} got=${got}${extra}`);
  }
  const TOTAL = CASES.length + 2;
  console.log(`\n[assertion-order-audit --selftest] ${pass}/${TOTAL} 通过`);
  process.exitCode = pass === TOTAL ? 0 : 1;
}

/* ═══════════════════ 6. 入口 ═══════════════════ */

const argv = process.argv.slice(2);

if (argv.includes('--selftest')) {
  selftest();
} else if (argv.includes('--file')) {
  const f = argv[argv.indexOf('--file') + 1]!;
  const consts = collectNumericConsts();
  const { blocks, topCount } = parseFile(join(ROOT, f));
  console.log(`════ ${f} ════`);
  console.log(`  块 ${blocks.length} 个 / 顶层断言 ${topCount} 条`);
  console.log(`  ★ 只读:本脚本不写任何文件\n`);
  let hits = 0;
  for (const b of blocks) {
    if (b.assertions.length < 2) continue;
    const found: string[] = [];
    for (let i = 0; i < b.assertions.length; i += 1) {
      for (let j = i + 1; j < b.assertions.length; j += 1) {
        const ai = b.assertions[i]!; const aj = b.assertions[j]!;
        const si = subjectOf(ai); const sj = subjectOf(aj);
        if (si === null || sj === null || si !== sj) continue;
        const pi = buildPred(ai, consts); const pj = buildPred(aj, consts);
        if (pi === null || pj === null) continue;
        if (implies(pi, pj).implies) {
          hits += 1;
          found.push(`     ★ L${aj.line} 零信息(被 L${ai.line} 蕴含)\n`
            + `         subject: \`${si}\`\n`
            + `         pred   : ${pi.desc}  ⇒  ${pj.desc}\n`
            + `         blocker: ${ai.text.slice(0, 100)}\n`
            + `         victim : ${aj.text.slice(0, 100)}`);
        }
      }
    }
    if (found.length > 0) {
      console.log(`  ── 块 L${b.start}..L${b.end} 「${b.name.slice(0, 56)}」(${b.assertions.length} 条断言)`);
      for (const x of found) console.log(x);
      console.log('');
    }
  }
  console.log(`  合计零信息:${hits} 条`);
} else {
  const { files, zero } = auditAll();
  console.log('════ 断言「零信息」普查 ════\n');
  console.log('  ★ 只读分析器:不起子进程、不改任何文件、不进退出码。');
  console.log('  ★ **产出不等于"该删的断言名单"** —— 零信息只说明不提供独立信息,');
  console.log('     该留哪条是产品判断(通常留**更严**的那条)。详见脚本 docblock §我不声称什么。');
  console.log('  ★ 口径:① 同块 ② 第 1 顶层实参表达式**文本完全相同** ③ ∀v: P_前(v) ⇒ P_后(v)');
  console.log(`  ★ 取值域 = ${DOMAIN.length} 个值(整数 + 0.5 小数 + 无理数 + 位运算关键点 + 极值 + NaN/±Inf)\n`);

  const totalBlocks = files.reduce((a, f) => a + f.blocks, 0);
  const totalAsserts = files.reduce((a, f) => a + f.asserts, 0);
  const totalBlocked = files.reduce((a, f) => a + f.blockedOnly, 0);
  const totalBlocksWithAsserts = files.reduce((a, f) => a + f.blocksWithAsserts, 0);

  console.log('─'.repeat(84));
  console.log(`  ${'文件'.padEnd(32)} ${'块'.padStart(4)} ${'断言'.padStart(5)} ${'A/B'.padStart(5)} ${'R'.padStart(3)}`);
  for (const f of files) {
    const ab = f.zero.filter((z) => z.tier === 'A' || z.tier === 'B').length;
    const rr = f.zero.filter((z) => z.tier === 'R').length;
    if (f.zero.length === 0 && !argv.includes('--all')) continue;
    console.log(`  ${f.file.padEnd(32)} ${String(f.blocks).padStart(4)} ${String(f.asserts).padStart(5)} ${String(ab).padStart(5)} ${String(rr).padStart(3)}`);
  }
  console.log('─'.repeat(84));

  const tA = zero.filter((z) => z.tier === 'A').length;
  const tB = zero.filter((z) => z.tier === 'B').length;
  const tR = zero.filter((z) => z.tier === 'R').length;
  const tAB = tA + tB;
  console.log('\n  ★★ 三档并列 —— **分别回答不同问题,严禁合成一个数**');
  console.log('');
  console.log(`  A 档 逻辑必然   : **${tA}** 条 —— 两侧都等值于字面量 ⇒ 蕴含与取值域无关`);
  console.log(`  B 档 域内验证   : **${tB}** 条 —— 谓词含范围/不等 ⇒ 仅在有限取值域内 0 反例`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  零信息合计(A+B): **${tAB}** 条 —— 该断言无法提供独立信息 ⇒ 该删/该改`);
  console.log('');
  console.log(`  R 档 关系守卫   : **${tR}** 条 —— ★ **不是零信息,不要按 A/B 处理**`);
  console.log('     ★ 它守的是**两个量之间的关系**(如"容量 ≥ 内容数"),只是**在当前数值下**');
  console.log('       恰好被前一条蕴含。若另一个量变大,mask 立刻能独立失败 ⇒ 它是**真守卫**。');
  console.log('       ⇒ 删掉它 = 丢掉一条守卫(本仓 task-88 正在补的就是这一类)。');
  console.log('       ⇒ 故必须单独列,不许混进"零信息"。');
  console.log('');
  console.log(`  第 2 列 = **顺序上可被阻断**(复核可信度问题,**非缺陷**)        : **${totalBlocked}** 条`);
  console.log('  第 2 列口径(必须与数字同时报):');
  console.log('     块内**非首条**断言数 —— 同块内存在更早的同层断言 ⇒ 更早那条失败即阻断它。');
  console.log('     ⇒ 它是**保守上界**;它说的是"用注入验牙时这些断言可能没被验到",');
  console.log('        而**不是**"这些断言有缺陷"。');
  console.log(`     分母:有断言的块 ${totalBlocksWithAsserts} 个 ⇒ 平均每块 ${(totalBlocked / Math.max(1, totalBlocksWithAsserts)).toFixed(1)} 条非首条`);
  console.log('');
  console.log(`  全局分母:套件 ${files.length} · 块 ${totalBlocks}(有断言 ${totalBlocksWithAsserts}) · 顶层断言 ${totalAsserts}`);
  console.log(`  有零信息的文件:${files.filter((f) => f.zero.length > 0).length} / ${files.length}`);
  /* ★ 权威合计行:与上面三档数字**必须对账**;数命中请数 `[HIT]`(ASCII,源码不可能产生) */
  console.log(`  ── 权威合计:[HIT] A ${tA} + B ${tB} = ${tAB}(零信息) | R ${tR}(**不要删**)`);
  console.log(`     明细对账:[HIT] 出现在 ${files.filter((f) => f.zero.length > 0).length} 个文件`
    + `,逐文件合计之和 = ${zero.length} ⇒ ${zero.length === tAB + tR ? '✓ 与三档之和一致' : '★ 不一致'}`);

  if (argv.includes('--list')) {
    console.log('\n════ 逐条清单(按文件 = 写域分组;由各自写域的人决定删改)════');
    for (const f of files) {
      if (f.zero.length === 0) continue;
      console.log(`\n── ${f.file}  (${f.zero.length} 条)`);
      for (const z of f.zero) {
        /* ★★ `[HIT]` 是 ASCII 且**源码里不可能出现**(JS 标识符/字符串里没有方括号包裹的大写标记)
           ⇒ 用 `grep -c '\[HIT\]'` 数命中**不会**把下一条证据回显当成命中。
           仅用 ★ 计数则会:★ 在本仓注释里满地都是,回显的证据里也有。 */
        console.log(`   [HIT] L${z.line} 档 ${z.tier} ← 被 L${z.blockedByLine} 蕴含   expr=\`${z.expr}\``
          + (z.otherSymbols.length > 0 ? `   另涉符号:${z.otherSymbols.join(',')}` : ''));
        console.log(`       blocker: ${z.blockerText.slice(0, 100)}`);
        console.log(`       victim : ${z.text.slice(0, 100)}`);
        if (z.tier === 'R') {
          console.log(`       ⇒ ★ 关系守卫:在当前 ${z.otherSymbols.join('/')} 取值下被蕴含,`
            + '但那是**数值巧合**,不是逻辑必然 ⇒ **不要删**');
        }
      }
      console.log(`   ─ [HIT] 本文件明细合计:${f.zero.length} 条`
        + `(A/B ${f.zero.filter((z) => z.tier !== 'R').length} · R ${f.zero.filter((z) => z.tier === 'R').length})`);
    }
  }
}
