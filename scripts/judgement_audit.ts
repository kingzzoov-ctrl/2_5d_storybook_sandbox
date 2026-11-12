/**
 * 断言与判据审计 —— 常驻只读脚本(task-60)。
 *
 * ## 这个脚本要解决的病
 *
 * 本仓记过一个反复复发的形态:**判据的提取口径比事实窄(或宽)**,于是
 * 「有检查」变成「检查了个空」,而门禁仍然全绿。已确认的实例:
 *
 * ```
 * ① @type 数成 49        计数用 /@type/g,把注释里**讨论**该词的行也算成装饰器
 * ② 键提取漏简写           /^\s*(\w+):/ 认不出 `roomId,` 简写属性 ⇒ 少收 1 个键而 missing 判据仍绿
 * ③ 注释里的反例被当 import 对**原文**跑 /from '…'/ ⇒ 注释里引用的反例被当成真 import
 * ④ 剥注释残留 URL         裸的行注释正则会把 'http://x' 从两个斜杠处整段删掉 ⇒ 字符串被截断
 * ⑤ 没有输出被当通过        进程崩/超时/0 条断言 ⇒ 打印 0 条 ✗ ⇒ 被读成「通过」
 * ⑥ 只认 from 的 import 探测 漏裸副作用 import 与动态 import()
 *
 * ⚠️ 本段注释**故意不写出任何以「星号紧跟斜杠」结尾的字面量** ——
 *    那会提前闭合本块注释,让整个文件语法坏。我在写这份脚本时**正好踩了它一次**
 *    (第 4 次犯同族错),故在此留证。需要引用时请写成文字描述,不要复制字面量。
 * ```
 *
 * ## 本脚本的核心纪律:**审计工具自己也要被审计**
 *
 * 我写第一版扫描器时**自己就犯了 ①②③ 里的两个**。所以本脚本每条检测器
 * 都必须通过**区分力自检**(见 `Lab`):
 *
 * ```
 * 每个检测器必须:
 *   在「合成的脏样本」上**报出命中**   ← 否则它是个空壳
 *   在「合成的干净样本」上**不报**      ← 否则它制造噪音
 * 两者都通过,才算这个检测器成立。
 * ```
 *
 * ⇒ 这不是「多加几条断言」,而是**把检测器本身变成被测对象**。
 *   本仓陷阱 44 同族:判据的覆盖面本身需要被验证。
 *
 * ## 只读保证
 *
 * 本脚本**不写任何文件**。它自己在运行前后对所有被扫文件取 SHA-256,
 * 若发现任何变化就 `fail` —— 用**自证**代替「我保证我没改」。
 *
 * ## ⚠️ 两个「扫到自己」的坑(都在开发中真实踩到)
 *
 * ```
 * ① 本工具会扫到**它自己的登记表**(scripts/judgement_baseline.ts)
 *    理由:登记表里逐条抄了被报行的原文当 needle(那是它判定的依据)
 *    ⇒ 若不显式跳过,登记表自己会被扫出 4 处 C 形态
 *    ⇒ 而且它是**永远新增**(自己扫自己)⇒ **门禁永远红,且看起来像"每天多 4 个问题"**
 *    ⇒ 已修:扫到 0 个文件/命中数异常时先看这里
 *
 * ② `where` 的行文本**可能含冒号**,不能用 split(':') 解析
 *    where 的格式是 `path:LINE  行文本`,而行文本自身就常有冒号:
 *       正则里的 \s*:  /  URL 里的 https://  /  三元 a ? b : c
 *    ⇒ `split(':')` 会在行内第一个冒号处截断 ⇒ lineText 只剩半句
 *    ⇒ **已登记的项匹配不上 ⇒ 被误报成「新增」**
 *    ⇒ 实测首跑报了 7 处「新增」,其中 4 处其实是已登记的
 *    ⇒ 已修:用 `indexOf(':')` 只切第一个冒号
 * ```
 *
 * ⇒ 两者的共同形态:**工具的口径比它处理的对象窄,而对象是它自己**。
 *   这类比「扫被测代码」时口径窄更隐蔽 —— 输出看起来像「发现了新问题」。
 *
 * ## 启发式边界要标**在输出上**(不能只写在注释里)
 *
 * 给出 `heuristic` 字段的检测器,其命中会在输出里带 `[X?]` 前缀与说明。
 * 理由:**没人读 JSDoc,但所有人都会读门禁输出**。
 * 不标的话,看输出的人会把「启发式候选」当成「确证缺陷」。
 *
 * 用法:
 * ```
 * node scripts/judgement_audit.ts              # 报告,命中不导致失败
 * node scripts/judgement_audit.ts --baseline   # ★ 门禁模式:只对**超出登记表的新增**报红
 * node scripts/judgement_audit.ts --strict     # 人工审计:任何命中都红(接门禁别用,会全红)
 * ```
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBaseline, JUDGEMENT_BASELINE, G_CANDIDATE_WATERMARK } from './judgement_baseline.ts';

/* ⚠️ 用 `fileURLToPath`,不要手拼 `new URL(...).pathname` ——
   后者在 Windows 上给出 `/C:/…`(带前导斜杠),我第一版就因此扫到 **0 个文件**,
   却仍然「顺利完成」并报告「全仓 0 处命中」。⇒ **这种失败是静默的**:
   没有报错、没有红,只有一个看起来很正常但毫无意义的空结果。
   故本脚本另加「扫描文件数必须 > 0」的自检(见下)。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* ⚠️ 用法
 *   node scripts/judgement_audit.ts             只读扫描,命中不导致失败
 *   node scripts/judgement_audit.ts --strict    命中即 exit 1(**裸 strict,接门禁用这个会全红**)
 *   node scripts/judgement_audit.ts --baseline  **门禁用这个**:只对超出登记表的新增命中报红
 *
 * `--baseline` 与既有登记表(`ENTRY_LOAD_EXEMPT` / 装饰器计数 / 白名单)同模式:
 * 已定性的命中写进 `scripts/judgement_baseline.ts`,门禁只盯**新增**。
 */
const STRICT = process.argv.includes('--strict');
const USE_BASELINE = process.argv.includes('--baseline');
const BASELINE_ONLY = USE_BASELINE;

/* ══════════════════ 基础:扫描与只读自证 ══════════════════ */

const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts', 'dist', 'coverage']);

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');

/** 只读自证:`walk` 出来的全部文件取 SHA-256,前后比对。 */
function snapshot(files: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) {
    try { m.set(f, createHash('sha256').update(readFileSync(f)).digest('hex')); } catch { /* 读不到就不记 */ }
  }
  return m;
}

/* ══════════════════ 剥离工具(本脚本自用)══════════════════ */

/**
 * **位置保持**的词法屏蔽:把注释字符换成空格,**保留换行与全部偏移**。
 *
 * 为什么不用 `.replace()` 拼正则(我第一版的写法)—— 三个实测教训:
 *
 * ```
 * ① 偏移会变 ⇒ 报出的行号是错的(或根本无法定位)
 * ② 更要命:去正则匹配「剥注释的代码」时,该代码**自身**含有
 *    「星号紧跟斜杠」之类序列,剥注释的正则会把它自己当成注释删掉
 *    ⇒ 检测器报 0 条 ⇒ 看起来「全仓干净」
 *    ⇒ 是**区分力自检**当场抓住的(脏样本 0 条)
 * ③ ★ 正则字面量必须当**代码**保留,不能当字符串或注释。
 *    反例:剥块注释的正则字面量,其结尾是「转义斜杠 + 收尾斜杠」,
 *    拼起来正好是两个斜杠 ⇒ 会被误判为**行注释起点** ⇒ 该行起被全部屏蔽
 *    ⇒ 检测器又报 0 条。故本屏蔽器**识别正则字面量**并原样保留。
 * ```
 *
 * `strings: 'keep'` 保留字符串内容(找 import 路径用),
 * `strings: 'blank'` 一并屏蔽字符串(找纯代码构造用)。
 * 正则字面量**两种模式都保留**(它是代码,且检测器的目标就在其中)。
 */
function maskComments(src: string, strings: 'keep' | 'blank'): string {
  const out = src.split('');
  const blank = (i: number): void => { if (i < src.length && src[i] !== '\n') out[i] = ' '; };
  /** 上一个有意义的代码字符 —— 用于判断 `/` 是除法还是正则起点。 */
  let prev = '';
  let i = 0;
  const n = src.length;

  /** 正则字面量能否从这里开始:前面不是「值的结尾」。 */
  const regexCanStart = (ch: string): boolean =>
    ch === '' || !/[A-Za-z0-9_$)\]]/.test(ch);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    /* 块注释 */
    if (c === '/' && c2 === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i += 1; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    /* 行注释 */
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { blank(i); i += 1; } continue; }

    /* 字符串:单引号 / 双引号 / 模板 */
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

    /* ★ 正则字面量 —— 当代码**原样保留**(见上文教训 ③)。
       判据:`/` 且「上一个有意义字符不是值结尾」且不是注释开头。 */
    if (c === '/' && regexCanStart(prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                    /* 未闭合:不当正则 */
        if (d === '[') { inClass = true; j += 1; continue; }
        if (d === ']') { inClass = false; j += 1; continue; }
        if (d === '/' && !inClass) { closed = true; j += 1; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j] ?? '')) j += 1;   /* flags */
        i = j;
        prev = '/';
        continue;
      }
      /* 未闭合 ⇒ 按除法处理,落下去 */
    }

    if (c !== undefined && !/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

/** 代码区(注释与字符串都已屏蔽)—— 找**代码构造**用。 */
export const codeOnlyMask = (src: string): string => maskComments(src, 'blank');

/** 代码区 + **保留字符串内容** —— 找 import 路径等字符串内容用。 */
export const codeKeepStrings = (src: string): string => maskComments(src, 'keep');

/** 在 `mask` 里定位 `needle`,返回**掩码后仍为代码/字符串**的那些行号。 */
function findMasked(masked: string, needle: string): number[] {
  const lines: number[] = [];
  let idx = masked.indexOf(needle);
  while (idx >= 0) {
    if (masked[idx] !== ' ') lines.push(masked.slice(0, idx).split('\n').length);
    idx = masked.indexOf(needle, idx + 1);
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

/* ══════════════════ E:区分力自检框架 ══════════════════ */

type Detector = {
  /** 形态编号 A~F */
  id: string;
  /** 一句话说明「什么形状算命中」 */
  what: string;
  /** 为什么这算问题 */
  why: string;
  /**
   * ★ 启发式标记 —— **标注边界必须标在输出上,不能只标在 JSDoc 里(没人读 JSDoc)**。
   *
   * 给出这个字段的检测器,其每条命中都会带上 `[C?]` 前缀与这里的说明。
   * 用途:防止看门禁输出的人把「启发式候选」当成「确证缺陷」。
   *
   * 留空 = 该检测器的判定是**确定性**的(命中即确证形态存在)。
   */
  heuristic?: string;
  /**
   * ★ 本检测器与**门禁**的关系(默认 `'block'`)。
   *
   * ```
   * 'block'  —— 未登记的命中 ⇒ 门禁红。适用于「命中即确证坏形状」的判据
   *             (A/B/C/D/F:报的是**具体代码形状**,能逐条定性)
   * 'advise' —— 未登记的命中 ⇒ **只告警,不拦门禁**;但**数量增长**会拦。
   *             适用于「命中只是候选,要看差异才能定性」的判据(目前只有 G)
   * ```
   *
   * ## 为什么需要 `'advise'`(2026-11-13,Lead 裁决「甲」)
   *
   * ```
   * G 一接入 --baseline,门禁立刻红了 42 处 —— 而这**不是"交了坏东西"**,
   * 是「新检测器的初始语料尚未定性」。
   * ⇒ 若让 42 条候选直接决定门禁红绿,所有人要立刻面对 42 条人工判断
   * ⇒ 门禁变成噪声源 ⇒ **最终没人看门禁**(比不接更糟)
   * ```
   *
   * ⇒ 正确的门禁语义是「**把"数量增长"当信号,而不是把"有没有"当信号**」:
   * ```
   * 今天 42 条 ⇒ 告警,门禁绿(存量已知)      ← 水位 G_CANDIDATE_WATERMARK
   * 明天 43 条 ⇒ **门禁红**(有人新引入了这类形态)
   * ```
   * ⇒ 同时满足:① 不阻塞别人 ② G 的价值保留(人能看到候选)
   *   ③ 不变成永久噪声(**增长**仍会红)。
   */
  gate?: 'block' | 'advise';
  /**
   * ★ 可选:**需要全局视野**的检测器用这个,与 `detect` 并存但不互相替代。
   *
   * 给出的检测器,主扫描循环会**改调它**(而不是逐文件调 `detect`)。
   * `detect` 仍必须实现 —— 因为区分力自检(框架 E)只在**单段样本**上跑它。
   *
   * ⇒ 用途:像 G 这种「跨文件同名不同物」的判据**结构上**做不到逐文件判定,
   *   但它单文件内也成立(同文件两个容器共享领域字段),故两者是同一判据的
   *   两个视野,不是两份实现。
   */
  detectAll?: (files: readonly string[]) => string[];
  /** 在给定源码文本上找命中项(返回人可读的定位串) */
  detect: (source: string, path: string) => string[];
  /** ★ 区分力自检:脏样本必须命中,干净样本必须不命中 */
  dirty: string;
  clean: string;
  /** 脏样本里期望被报出的条数(至少这么多) */
  minDirtyHits: number;
};

type SelfTestResult = { id: string; ok: boolean; detail: string };

/** 跑一个检测器的区分力自检。**这是本脚本的骨架**:不过自检的检测器结果不可信。 */
function selfTest(d: Detector): SelfTestResult {
  let dirtyHits: string[] = [];
  let cleanHits: string[] = [];
  try {
    dirtyHits = d.detect(d.dirty, '<dirty-sample>');
  } catch (e) {
    return { id: d.id, ok: false, detail: `脏样本上抛错:${(e as Error).message.slice(0, 80)}` };
  }
  try {
    cleanHits = d.detect(d.clean, '<clean-sample>');
  } catch (e) {
    return { id: d.id, ok: false, detail: `干净样本上抛错:${(e as Error).message.slice(0, 80)}` };
  }
  if (dirtyHits.length < d.minDirtyHits) {
    return {
      id: d.id, ok: false,
      detail: `脏样本只报 ${dirtyHits.length} 条(应 ≥${d.minDirtyHits})⇒ **该检测器抓不到它声称要抓的东西**`,
    };
  }
  if (cleanHits.length > 0) {
    return {
      id: d.id, ok: false,
      detail: `干净样本误报 ${cleanHits.length} 条(${cleanHits.slice(0, 2).join(' | ')})⇒ 噪音检测器`,
    };
  }
  return { id: d.id, ok: true, detail: `脏样本 ${dirtyHits.length} 条 / 干净样本 0 条` };
}

/* ══════════════════ 六个检测器(A/B/C/D/F 检测 + E 自检框架)══════════════════ */

/* 检测器一律在 `codeOnlyMask` / `codeKeepStrings` 的结果上判定 ——
   那两个函数**位置保持**,所以行号可靠;且正则字面量被当代码保留,
   于是「扫描剥注释代码」不会再把自己剥掉(我第一版正是这么失效的)。 */

/** A:对象字面量键提取只认 `k:`,未处理简写 `k,`。 */
const DET_A: Detector = {
  id: 'A',
  what: '对象字面量键提取只认 k 加冒号,未处理简写属性 k 加逗号',
  why: '简写属性不会被「行首 k 加冒号」的正则命中 ⇒ 少收键;而「缺了哪些键」判据仍绿 ⇒ 少收是静默的(task-57 实例:报 8 个键,实为 9)',
  detect: (source, path) => {
    const out: string[] = [];
    const masked = codeOnlyMask(source);
    const lines = masked.split('\n');
    lines.forEach((l, i) => {
      /* 目标:字面量里出现 `(\w+)` 且随后跟「冒号」类匹配 —— 即键提取正则 */
      const looksLikeKeyExtract = /\\w\+\)\\s\*:/.test(l) || /\(\\w\+\):/.test(l);
      if (!looksLikeKeyExtract) return;
      /* 就近 ±14 行内是否有「行首 k 加逗号」的简写处理或明示注释 */
      const near = lines.slice(Math.max(0, i - 14), i + 14).join('\n');
      const handlesShorthand = /\\w\+\)\\s\*,\s*\\s\*\$/.test(near) || /简写|shorthand/i.test(near);
      if (handlesShorthand) return;
      out.push(`${path}:${i + 1}  ${(source.split('\n')[i] ?? '').trim().slice(0, 92)}`);
    });
    return out;
  },
  dirty: 'const ks = [...body.matchAll(/^\\s*(\\w+):/gm)].map((m) => m[1]);',
  clean: [
    'const ks = [',
    '  ...[...body.matchAll(/^\\s*(\\w+)\\s*:/gm)].map((m) => m[1]),',
    '  ...[...body.matchAll(/^\\s*(\\w+)\\s*,\\s*$/gm)].map((m) => m[1]), // 简写属性',
    '];',
  ].join('\n'),
  minDirtyHits: 1,
};

/** B:剥行注释的正则缺 `(^|[^:])` 前缀。 */
/**
 * ## ⚠️ 挂账说明(2026-11-13,Lead 裁决「挂账,不跑取证」)
 *
 * ```
 * 已知 7 处,当前触发 0 处 ⇒ **挂 CR-18 同批处理**,不在本轮修。
 * ```
 *
 * **为什么挂账而不是修**:
 * ```
 * ① 两函数语义**相反**,不能统一(实测证伪了「统一到 stripCommentsAndStrings」的方案):
 *      stripCommentsOnly        保留字符串内容  ⇒ 找 import 路径用
 *      stripCommentsAndStrings  **销毁**字符串  ⇒ 找标识符用
 *    ⇒ 若统一到后者,FND9-2 从「抓到 5 个 import」变成「**0 个**」= 断言恒真。
 * ② 7 处里只有 WS-07 一处被扫文本含 URL,而**没有任何证据表明它影响判定**
 *    ⇒ 本仓惯例是「先有红的证据再改」;无可复现失效就动 7 个文件是反过来的。
 * ③ 工具已就位:`scripts/inject.ts` 能在**真的被触发时**造出红的证据
 *    ⇒ 正确的处置时机是「触发时」,不是现在。
 * ```
 *
 * **正确修法(挂账时一并记下,避免后人重造)**:
 * ```
 * 新建 scripts/strip_source.ts 导出**两个**函数(不是合成一个):
 *   stripCommentsOnly(src)        保留字符串(找路径)
 *   stripCommentsAndStrings(src)  销毁字符串(找标识符)
 * 再改 7 处 —— 每处必须先判定它属于哪一类,不能一刀切。
 * ```
 *
 * ⇒ 下一个人看到这 7 处时:**这不是漏修,是已定性挂账**。
 *   登记表 `scripts/judgement_baseline.ts` 里有逐条 reason。
 */
const NEEDLE_LINE_COMMENT = '.replace(/\\/\\/[^\\n]*/g';

const DET_B: Detector = {
  id: 'B',
  what: '剥行注释的正则缺 (^|[^:]) 前缀',
  why: 'URL 里的两个斜杠会被当注释起点 ⇒ 整行从那里截断 ⇒ 字符串内容与后续真代码一起丢 ⇒ 判据静默失效',
  detect: (source, path) => {
    const out: string[] = [];
    const masked = codeOnlyMask(source);
    const lines = masked.split('\n');
    const srcLines = source.split('\n');
    lines.forEach((l, i) => {
      if (!l.includes(NEEDLE_LINE_COMMENT)) return;
      /* 防护可能写在同一行,也可能在上一行(多行链式写法) */
      const window = `${lines[i - 1] ?? ''}\n${l}`;
      if (window.includes('[^:]')) return;
      out.push(`${path}:${i + 1}  ${(srcLines[i] ?? '').trim().slice(0, 92)}`);
    });
    return out;
  },
  dirty: `const a = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')${NEEDLE_LINE_COMMENT}, '');`,
  clean: `const a = src.replace(/(^|[^:])${NEEDLE_LINE_COMMENT}, '$1');`,
  minDirtyHits: 1,
};

/** C:import 探测只认 from。 */
/**
 * ★ 逃逸地狱的根治:先把源码里所有反斜杠**去掉**,再做纯字面量子串判断。
 *
 * 我在这条检测器上**连栽三版**,全是同一个原因:要匹配的是**别人写的正则字面量**,
 * 而我在自己的正则里去匹配它 ⇒ 需要两层转义,极易错一层。而那类错误的表现是
 * **静默的**:检测器报 0 条或误报,看起来都「正常」。
 * ⇒ 改法:不去匹配「带反斜杠的原文」,而是把它**规范化**成无反斜杠文本,
 *   然后用 `includes()` 做**普通字符串**判断 —— 不再有任何转义层。
 *
 * ```
 * 原文(别人写的)        规范化后(本检测器判定的形态)
 * import\s*['"]      →  imports*['"]
 * import\s*\(        →  imports*(
 * from\s*['"]        →  froms*['"]
 * ```
 * 判定:
 * - 含 `froms*[` 或 `froms+[`      ⇒ 是「从 from 取路径」的探测
 * - 含 `imports*[` 或 `imports+[`  ⇒ 已覆盖**裸副作用导入**
 * - 含 `imports*(` 或 `imports+(`  ⇒ 已覆盖**动态 import()**
 */
const deEscape = (s: string): string => s.replace(/\\/g, '');

/**
 * 覆盖判定 —— 在**无反斜杠**的规范化文本上做普通子串判断。
 *
 * ⚠️ **本判定是启发式的,已知会漏判 —— 这是本检测器的最大局限**:
 *
 * ```
 * 我在这上面连栽三版,全是同一形态:
 *   「检测器自己的覆盖判定比被测代码的真实覆盖**窄**」⇒ 假阳性
 *
 * 第 1 版  只认 `import\s*\(` 这种独立写法
 *          ⇒ 漏判「同一正则里 | 分隔的组合写法」
 * 第 2 版  正则转义写错 ⇒ 脏样本报 0 条(反向失效,更危险)
 * 第 3 版  漏判 `^\s*import\b`(用 \b 而非 \s*['"])与 `import\(`(无 \s*)
 *          ⇒ tests/WS-07.test.ts:3591 被误报成「未覆盖」
 * ```
 *
 * ⇒ 结论:**报出来的「未覆盖」必须逐条人工复核**,不能直接当成缺陷。
 *   (已登记的 18 处里,标注为「假阳性」的 5 处正是这类。)
 */
const hasBareImportCoverage = (s: string): boolean =>
  s.includes('imports*[') || s.includes('imports+[') || s.includes('importb');
const hasDynamicImportCoverage = (s: string): boolean =>
  s.includes('imports*(') || s.includes('imports+(') || s.includes('import(');

const DET_C: Detector = {
  id: 'C',
  what: 'import 探测只认 from,未覆盖裸副作用导入与动态 import()',
  /**
   * ★ 启发式边界(Lead 2026-11-13 要求「标注要标在输出上」)。
   *
   * 本检测器**连续三版**都是同一个失效形态:
   * ```
   * 「检测器自己的覆盖判定」比「被测代码的真实覆盖」**窄** ⇒ 假阳性
   * ```
   * 已登记的 18 处里,5 处标注为「假阳性」,全部属于这类。
   * ⇒ 判定偏窄是本检测器的**已知属性**,不是待修 bug
   *   (继续修 = 用工作量换一个仍不完美的判定;不标注 = 用不完美冒充完美)。
   * ⇒ 故输出上必须带 `[C?]`,提示**逐条人工复核**。
   */
  heuristic: '本检测器的「覆盖判定」已知偏窄 —— 报出的「未覆盖」必须逐条人工复核,不能直接当缺陷',
  why: '`import\'./x.ts\'` 与 `await import(\'./x.ts\')` 都不含 from ⇒ 漏检 ⇒ 依赖图少边 ⇒ 可达性/单一来源类判据静默失效(task-57:我 FND9-14 初版即此形态,已修)',
  detect: (source, path) => {
    const out: string[] = [];
    const masked = codeKeepStrings(source);
    const lines = masked.split('\n');
    const srcLines = source.split('\n');
    lines.forEach((l, i) => {
      const flat = deEscape(l);
      const probesFrom = flat.includes('froms*[') || flat.includes('froms+[');
      if (!probesFrom) return;
      const near = deEscape(lines.slice(Math.max(0, i - 22), i + 22).join('\n'));
      const coversBare = hasBareImportCoverage(near);
      const coversDynamic = hasDynamicImportCoverage(near);
      if (coversBare && coversDynamic) return;
      out.push(`${path}:${i + 1}  ${(srcLines[i] ?? '').trim().slice(0, 84)}  [裸=${coversBare ? '有' : '无'} 动态=${coversDynamic ? '有' : '无'}]`);
    });
    return out;
  },
  dirty: `if (/from\\s*['"]/.test(line)) inImport = false;`,
  clean: [
    `const RE = /import[^;]*from\\s*['"]|import\\s*['"]|import\\s*\\(/;`,
    `if (RE.test(line)) inImport = false;`,
  ].join('\n'),
  minDirtyHits: 1,
};

/** D:对未剥注释的原文做计数。 */
const DET_D: Detector = {
  id: 'D',
  what: '对未剥注释的原文做 match(/x/g) 计数',
  why: '注释里讨论该词的行也被计入 ⇒ 计数偏大(task-57 实例:@type 数成 49,实为 44/45)',
  detect: (source, path) => {
    const out: string[] = [];
    const masked = codeOnlyMask(source);
    const lines = masked.split('\n');
    const srcLines = source.split('\n');
    lines.forEach((l, i) => {
      const m = /\.match\(\s*\/([^/\n]{2,})\/g\s*\)/.exec(l);
      if (m === null) return;
      const pat = m[1] ?? '';
      /* 只关心易被注释污染的计数:装饰器/类型/导出/字段 */
      if (!/@|type|export|decorator|field/i.test(pat)) return;
      const near = lines.slice(Math.max(0, i - 10), i + 10).join('\n');
      const stripped = /stripComments|codeOnly|maskComments|剥注释/.test(near);
      if (stripped) return;
      out.push(`${path}:${i + 1}  ${(srcLines[i] ?? '').trim().slice(0, 92)}`);
    });
    return out;
  },
  dirty: 'const n = (src.match(/@type/g) ?? []).length;',
  clean: [
    'const code = stripCommentsOnly(src);',
    'const n = (code.match(/@type/g) ?? []).length;',
  ].join('\n'),
  minDirtyHits: 1,
};

/* ══════════════════ G 的支撑:容器抽取 + 配对判定 ══════════════════ */

/** G 用的类型容器:一个带字段集合的类型声明。 */
type GContainer = {
  /** 人可读名,如 `CombatantStats(interface)` 或 `FoodBuff.statMods`(嵌套) */
  name: string;
  file: string;
  line: number;
  fields: string[];
};

/**
 * ★ **通用字段词表** —— G 判据的核心,**也是最需要人工复核的地方**。
 *
 * 判定原则:一个字段名出现在**任何**实体上都属正常,则收入本表。
 * ```
 * 身份/键      id key name slot type kind
 * 位置         x y z pos position radius range
 * 通用生命     hp maxHp mp def atk damage value amount
 * 时间         time sec dt atSec elapsedSec durationSec remainingSec startedAtSec clock
 * 元数据       desc note label title text msg reason code version hash seed phase
 * 容器/载荷    data extra meta payload options items list rows entries map set table
 * 布尔状态     ok active enabled visible alive downed dead
 * 审计列       created_at updated_at createdAt updatedAt file line verdict
 * ```
 * **不进本表的就是「领域字段」** —— 如 `critDmg` / `moveMul` / `armorPen` /
 * `gravityMul` / `recipe_hash`,它们出现在两个不同容器里才有信息量。
 *
 * ## ⚠️ 已知误报形态(必读 —— 这是"标注边界",不是"假装无边界")
 *
 * ```
 * 1 **同名本身是完全正常的** —— `id` / `name` / `level` / `x` / `y` / `hp`
 *   出现在任何实体上都对。⇒ 所以判据**不是**「同名」,而是
 *   「同名 ∧ **共享 ≥3 个领域字段** ∧ 各有独有字段」。
 *   实测:去掉领域字段这一层,本仓从 42 对(可人工读完)膨胀到 159 对(全是噪音)。
 *
 * 2 **跨文件同名不同物不能只看名字** —— 必须比字段集合。
 *   单个字段名在各处出现是无信息的;「**一整组字段**重合而各自还有独有字段」
 *   才说明两个容器在描述同一概念的不同版本。
 *   ⇒ 已做:判据取的是**字段集合的交集大小**,不是名字是否相同。
 *
 * 3 **同目录/同文件的兄弟接口可能是故意的变体**(窄化的 options、
 *   定义表 vs 聚合统计、运行时态 vs 结果视图),不是缺陷。
 *   实测:真例 `statMods ↔ CombatantStats` **同在 combat/** ⇒
 *   「跨子系统」过滤器**会把它滤掉**(试过,反而更差)。
 *   ⇒ 故**不加**跨目录/跨文件过滤,靠「领域字段」这一层收敛。
 *
 * 4 本词表是启发式的,偏一点候选就翻倍或清空 ⇒ 所以它**只在 `gate:'advise'`
 *   模式下使用**(见 `Detector.gate`),不让它单独决定门禁红绿。
 * ```
 */
const GENERIC_FIELDS = new Set([
  'id', 'key', 'name', 'slot', 'type', 'kind',
  'x', 'y', 'z', 'pos', 'position', 'radius', 'range',
  'hp', 'maxHp', 'mp', 'def', 'atk', 'damage', 'value', 'amount',
  'time', 'sec', 'dt', 'atSec', 'elapsedSec', 'durationSec', 'remainingSec', 'startedAtSec', 'clock',
  'desc', 'note', 'label', 'title', 'text', 'msg', 'reason', 'code', 'version', 'hash', 'seed', 'phase',
  'data', 'extra', 'meta', 'payload', 'options', 'items', 'list', 'rows', 'entries', 'map', 'set', 'table',
  'ok', 'active', 'enabled', 'visible', 'alive', 'downed', 'dead', 'result', 'out',
  'created_at', 'updated_at', 'createdAt', 'updatedAt', 'file', 'line', 'verdict',
  'count', 'size', 'index', 'idx', 'level', 'state', 'flags', 'tags', 'element', 'source',
  'steps', 'float', 'phaseIndex', 'phaseName', 'playerId', 'mobId', 'bossId', 'targetId', 'attackerId',
  'canAttack', 'canBeHealed', 'canBeHit', 'canSpawn', 'canMove',
]);

const isGenericField = (f: string): boolean => GENERIC_FIELDS.has(f);

/**
 * 从一段源码里抽出所有类型容器(interface / type 别名),**含一层嵌套对象**。
 *
 * ## ⚠️ 为什么要支持嵌套(我第一版漏了,三个真例全漏)
 * ```
 * FoodBuff 的形状是:
 *   interface FoodBuff { ...; statMods: { atkMul: number; hpFlat: number; ... }; }
 * ⇒ 只取顶层字段会得到 `statMods` 一个名字,**看不到 atkMul**
 * ⇒ 三个真例(atkMul/critRate/moveMul)**一个都抽不到** ⇒ 检测器形同虚设。
 * ⇒ 故嵌套对象按 `Parent.child` 单独成为一个容器,与真例的表述方式一致。
 * ```
 * 位置靠 `codeOnlyMask`(位置保持)保证 ⇒ 行号可靠。
 */
function collectContainers(source: string, path: string): GContainer[] {
  const text = codeOnlyMask(source);
  const out: GContainer[] = [];
  const RE_DECL = /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)[^\n{]*\{/g;

  for (const m of text.matchAll(RE_DECL)) {
    const kind = m[1] as string;
    const name = m[2] as string;
    const start = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const body = text.slice(start + 1, end);
    const lineOf = (off: number): number => text.slice(0, start + 1 + off).split('\n').length;

    let d = 0;
    let nestedName: string | null = null;
    let nestedStart = 0;
    let offset = 0;
    const top: string[] = [];
    const nested: GContainer[] = [];

    for (const bl of body.split('\n')) {
      const t = bl.trim();
      const open = (bl.match(/\{/g) ?? []).length;
      const close = (bl.match(/\}/g) ?? []).length;
      if (d === 0) {
        const fm = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(t);
        if (fm !== null) {
          const fn = fm[1] as string;
          if (open > close && /:\s*\{\s*$/.test(t)) { nestedName = fn; nestedStart = offset; }
          else top.push(fn);
        }
      } else if (d === 1 && nestedName !== null) {
        const fm = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(t);
        if (fm !== null) {
          let nc = nested[nested.length - 1];
          if (nc === undefined) {
            nc = { name: name + '.' + nestedName, file: path, line: lineOf(nestedStart), fields: [] };
            nested.push(nc);
          }
          nc.fields.push(fm[1] as string);
        }
      }
      d += open - close;
      if (d === 0) nestedName = null;
      offset += bl.length + 1;
    }
    if (top.length > 0) out.push({ name: name + '(' + kind + ')', file: path, line: lineOf(0), fields: top });
    for (const nc of nested) if (nc.fields.length > 0) out.push(nc);
  }
  return out;
}

/** G 的一个命中:两个容器 + 它们的领域字段交集。 */
type GPair = { a: GContainer; b: GContainer; shared: string[] };

/** 判据:非通用共享 ≥3 ∧ 各有独有字段 ∧ 不同容器名。 */
const G_MIN_SHARED = 3;

function gPairs(all: readonly GContainer[]): GPair[] {
  const out: GPair[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i]!;
      const b = all[j]!;
      if (a.name === b.name) continue;
      /* ★ **故意不加「跳过同文件」过滤** —— 实测决定,三次试错:
         保留「跨文件」27 对 ← 去掉 42 对,两者都捞到全部 3 个真例。
         去掉的理由有三条,任一条都足够:
         ① 它**结构上让框架 E 的自检永久失败**:`detect` 自检只传**一个** path
            ⇒ 脏样本里两个接口必然同 file ⇒ 判据永不命中 ⇒
            「脏样本只报 0 条」—— 而扫描却报 27 处(正是"抓不到自己声称要抓的东西")
         ② 更坏的是它让 `detect` 与 `detectAll` **行为不一致且无法察觉**
            ⇒ 这就是本仓反复出现的「两份实现漂移」形态,由我自己引入
         ③ 它的假设(**同文件的两个容器一定是"有意分区"**)从未验证
         (Lead 给的判据是「同名 ∧ 类型/字段集合不同」,本就没有"跨文件"这一条。) */
      const bSet = new Set(b.fields);
      const aSet = new Set(a.fields);
      const shared = [...new Set(a.fields)].filter((f) => bSet.has(f) && !isGenericField(f));
      if (shared.length < G_MIN_SHARED) continue;
      /* 必须**各有独有** —— 两侧字段集完全相同的重复定义是 A 形态的活,不是 G 的 */
      if (a.fields.filter((f) => !bSet.has(f)).length === 0) continue;
      if (b.fields.filter((f) => !aSet.has(f)).length === 0) continue;
      out.push({ a, b, shared });
    }
  }
  return out;
}

/**
 * 把一个 G 命中渲染成 `where` 串。
 *
 * ## ★ 关键:输出**把差异摆出来**,不替人下结论
 * ```
 * 前缀必须保持 `path:LINE  文本` 形态 —— 登记表按 indexOf(':') 解析它。
 * ```
 * ⇒ 每行给出 `[共享]`(领域字段交集,即"疑似同一概念"的证据)
 *   与 `[独有A]/[独有B]`(各自独有,即"两个版本"的证据)。
 * ⇒ **让"是不是同一概念两份实现"这个判断留给人** ——
 *   这正是 C 检测器学到的教训:「启发式判定的诚实做法是标注边界」。
 */
function renderG(p: GPair): string {
  const onlyA = p.a.fields.filter((f) => !new Set(p.b.fields).has(f));
  const onlyB = p.b.fields.filter((f) => !new Set(p.a.fields).has(f));
  const cap = (xs: readonly string[], n = 6): string =>
    xs.length <= n ? xs.join(',') : xs.slice(0, n).join(',') + '…(+' + (xs.length - n) + ')';
  const bShort = p.b.file.split('/').pop() ?? '';
  return p.a.file + ':' + p.a.line + '  ' + p.a.name + ' <-> ' + p.b.name + '@' + bShort + ':' + p.b.line
    + '  共享[' + p.shared.join(',') + ']'
    + '  独有A[' + cap(onlyA) + ']  独有B[' + cap(onlyB) + ']';
}

/** F:派生进程后不看退出码 / 把「无输出」当通过。 */
/**
 * ★ 关键语义区分(我第一版把两者混为一谈,造成 3 处假阳性):
 *
 * ```
 * execFileSync / execSync  —— 子进程非 0 退出时**抛异常**
 *                             ⇒ 不写 `if (r.status)` 也**不是缺陷**:throw 就是检查
 * spawnSync / spawn        —— 返回 `{ status, stdout, stderr, error }`,**从不抛**
 *                             ⇒ 不看 status 才是缺陷:崩溃会被当成正常返回
 * ```
 *
 * 真缺陷还要再满足一步:崩溃时**输出为空**,而判据把「空」解释成「没问题」。
 * 例:`failed = parse( stdout )` → `[]` → `failed.length === 0` 被读成「全部通过」。
 * ⇒ 故本检测器只报 `spawnSync/spawn` 且**不读 status/error**的站点。
 */
const DET_F: Detector = {
  id: 'F',
  what: 'spawnSync/spawn 后不读 status/error(崩溃会被当成正常返回)',
  why: 'spawnSync 从不抛异常;进程崩溃/超时被杀时 status≠0 而 stdout 为空 ⇒ 若判据把空输出读成「无失败」,就是假绿。我在 task-57 故障注入里踩过:文件被切成语法坏 ⇒ 打印 0 条 ⇒ 一度读成通过',
  detect: (source, path) => {
    const out: string[] = [];
    const masked = codeOnlyMask(source);
    const lines = masked.split('\n');
    const srcLines = source.split('\n');
    lines.forEach((l, i) => {
      /* 只认 spawnSync / spawn(process.execPath) —— exec* 会抛,不属此形态 */
      const isSpawnSync = /\bspawnSync\s*\(/.test(l);
      const isSpawnProc = /\bspawn\s*\(/.test(l) && /process\.execPath/.test(l);
      if (!isSpawnSync && !isSpawnProc) return;
      const block = lines.slice(i, Math.min(lines.length, i + 20)).join('\n');
      /* 读 status / error / signal / killed 任意一个都算检查了 */
      const checks = /\bstatus\b|\.error\b|\bsignal\b|\.killed\b/.test(block);
      if (checks) return;
      out.push(`${path}:${i + 1}  ${(srcLines[i] ?? '').trim().slice(0, 88)}`);
    });
    return out;
  },
  dirty: `const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });\nconst failed = parse(r.stdout);\nif (failed.length === 0) console.log('ok');`,
  clean: [
    `const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });`,
    `if (r.status !== 0) fail('子进程退出码 ' + r.status);`,
  ].join('\n'),
  minDirtyHits: 1,
};

/* ══════════════════ G:同名不同物(跨文件符号归属)══════════════════ */

/**
 * ## 为什么 G 与 A~F **不是同一类检测器**(Lead 的 CR-20 判据)
 *
 * ```
 * A~F = **文本形态扫描** —— 在单个文件的一段文本上匹配一个正则/模式
 * G   = **符号归属判定** —— 比较两个**类型容器的字段集合**
 * ⇒ A~F 的判据类型**结构上答不了** G 的问题,不是"还没写正则"
 * ⇒ 所以 G 是「不同种类」的检测器,不是"A~F 之外再多一条正则"
 * ```
 *
 * ## 它抓的具体形态
 * ```
 * 一个标识符作为**字段名**出现在 ≥2 个类型容器里,
 * 而两个容器共享了 ≥3 个**领域字段**且各自还有独有字段。
 *
 * 真例(Lead 与 build-wiring 共同确认 3 个,全部落在 cooking.ts 的 FoodBuff.statMods 上):
 *   atkMul   FoodBuff.statMods ↔ weapons.ts SetBonusDef / BuffInput
 *   critRate FoodBuff.statMods ↔ weapons.ts CombatantStats
 *   moveMul  FoodBuff.statMods ↔ weapons.ts CombatantStats / ArmorDef
 * ```
 *
 * ## 为什么这条判据值得存在(它差点让 B 的结论反过来)
 * ```
 * 查 task-64 任务 B 时,我把「字段名有消费者吗」当判据,得到:
 *   atkMul   ✓9 外部   critRate ✓12 外部   moveMul  ✓13 外部
 * ⇒ 若直接采信计数,结论是「**已有 statMods 消费通道**」⇒ B 的答案完全反了。
 * ⇒ 逐行读每一处才发现:三处**全是同名不同物**
 * ```
 * ⇒ 故 G 的意义 = 把这种"计数看起来有消费者"的形态**在计数阶段就拦住**。
 */
const DET_G: Detector = {
  id: 'G',
  what: '同名不同物:两个类型容器共享 ≥3 个领域字段、各有独有字段',
  why:
    '按字段名计数判断「有没有消费者」时,同名不同物会让计数**看起来有消费者**,'
    + '而实际那个消费点吃的是另一个类型 ⇒ 判据反向。task-64 任务 B 实测:'
    + 'atkMul/critRate/moveMul 三处「外部消费者」全部是同名不同物。',
  heuristic:
    '本检测器输出的是**候选清单,不是缺陷判定** —— 「两个容器共享领域字段」'
    + '既可能是同一概念两份实现(危险),也可能是层间有意传递(正常)。'
    + '必须人工看每条的[共享]/[独有]差异。'
    + '⚠️ 两条已知误报边界:(1) **同名本身完全正常** —— id/name/level/x/y/hp 出现在'
    + '任何实体上都对,故判据不是"同名",而是「同名 ∧ 共享 ≥3 个**领域字段** ∧ 各有独有」;'
    + '(2) **同名不同物不能只靠名字判** —— 必须比字段集合,单个字段名在各处出现是无信息的。'
    + '另:领域词表(GENERIC_FIELDS)本身是启发式的,偏一点候选就翻倍。',
  /* ★ 只告警不拦门禁 —— 理由见 `Detector.gate` 的 JSDoc(Lead 裁决「甲」) */
  gate: 'advise',
  detect: (source, path) => gPairs(collectContainers(source, path)).map(renderG),
  detectAll: (files) => {
    const all: GContainer[] = [];
    for (const f of files) {
      const rf = rel(f);
      /* 跳过本脚本自身与登记表 —— 与主循环同一条理由(它们抄了命中原文,会自扫) */
      if (rf === 'scripts/judgement_audit.ts' || rf === 'scripts/judgement_baseline.ts') continue;
      all.push(...collectContainers(readFileSync(f, 'utf8'), rf));
    }
    return gPairs(all).map(renderG);
  },
  /**
   * ★ 脏样本必须**复刻真例的形状**,包括**嵌套容器**那一步。
   *
   * ⚠️ 我第一版脏样本写错了(自检报「脏样本只报 0 条」,而扫描却有 27 处命中 ——
   *    正是"检测器抓不到它声称要抓的东西"的典型症状):
   * ```
   * 错版:两个假接口只共享 `atkMul` **一个**字段 ⇒ 共享数 1 < 3 ⇒ 判据不命中
   * ⇒ 教训:区分力自检的脏样本**必须是判据的边界构造**,不是"随便造个像的"
   * ```
   * 本版复刻 `FoodBuff.statMods ↔ CombatantStats`
   * (共享 critRate/critDmg/moveMul 三个领域字段;且 A 侧走**嵌套**抽取路径)。
   */
  dirty: [
    'interface FoodBuff {',
    '  durationSec: number;',
    '  statMods: {',
    '    atkMul: number;',
    '    critRate: number;',
    '    critDmg: number;',
    '    moveMul: number;',
    '    hpFlat: number;',
    '  };',
    '}',
    'interface CombatantStats {',
    '  critRate: number;',
    '  critDmg: number;',
    '  moveMul: number;',
    '  armorPen: number;',
    '  baseAtk: number;',
    '}',
  ].join('\n'),
  /**
   * 干净样本守两条边界:
   * ```
   * 1 两容器**字段集完全相同** ⇒ 「各有独有字段」守卫 ⇒ 不报
   * 2 且字段**全是通用词** ⇒ 「非通用共享 ≥3」守卫 ⇒ 不报
   * ⇒ 两条守卫各被 (1)(2) 覆盖。
   * ```
   */
  clean: [
    'interface PlayerRow { id: string; name: string; hp: number; maxHp: number; x: number; y: number; }',
    'interface MobRow { id: string; name: string; hp: number; maxHp: number; x: number; y: number; }',
  ].join('\n'),
  minDirtyHits: 1,
};

/* E 不是独立检测器:它是**自检框架**本身(每个检测器都要过区分力自检)。 */
const DETECTORS: readonly Detector[] = [DET_A, DET_B, DET_C, DET_D, DET_F, DET_G];

/* ══════════════════ 运行 ══════════════════ */

const SCAN_ROOTS = ['scripts', 'tests', 'server/src', 'client/src', 'shared'];
const scanFiles = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r), ['.ts']));
const allFiles = scanFiles;

const before = snapshot(allFiles);

console.log('[判据审计] 只读扫描,不修改任何文件');
console.log(`  扫描根:${SCAN_ROOTS.join(' / ')}`);
console.log(`  文件数:${scanFiles.length}\n`);

/* ★ 覆盖面自检:扫到 0 个文件时**必须失败**,不能「顺利完成并报 0 处命中」。
   我第一版用 `new URL(...).pathname` 拼 ROOT,Windows 下得到 `/C:/…`,
   `existsSync` 全 false ⇒ **扫了 0 个文件**,而输出看起来完全正常。
   ⇒ 这是形态 ⑤ 的变体:「空结果被当成干净结果」。 */
if (scanFiles.length === 0) {
  console.log('  ✗ 扫描到 0 个文件 —— 说明 ROOT 或扫描根算错了。');
  console.log(`    ROOT = ${ROOT}`);
  console.log('    ⇒ 空结果**不是**「没问题」,是判据没运行。');
  process.exit(1);
}
const missingRoots = SCAN_ROOTS.filter((r) => !existsSync(join(ROOT, r)));
if (missingRoots.length > 0) {
  console.log(`  ⚠️ 以下扫描根不存在:${missingRoots.join(', ')}`);
}

/* ── 1. 区分力自检:先证明检测器本身有效 ── */
console.log('[E] 检测器区分力自检(脏样本必须命中 / 干净样本必须不报)');
const selfResults = DETECTORS.map(selfTest);
let selfFail = 0;
for (const r of selfResults) {
  if (r.ok) {
    console.log(`  ✓ ${r.id}:${r.detail}`);
  } else {
    selfFail += 1;
    console.log(`  ✗ ${r.id}:${r.detail}`);
  }
}
if (selfFail > 0) {
  console.log(`\n  ⚠️ ${selfFail} 个检测器未通过自检 —— **其扫描结果不可信**,下面仍打印但请先修检测器`);
}

/* ── 2. 逐形态扫描 ── */
console.log('\n[命中] 逐形态');
type Hit = { detector: string; where: string; registered: boolean; verdict: string };
const allHits: Hit[] = [];
const perDetector = new Map<string, Hit[]>();

for (const d of DETECTORS) {
  const hits: Hit[] = [];
  /* ★ 有 `detectAll` 的检测器(目前只有 G)走**全局视野** ——
     它的判据是「两个容器的字段集合比较」,结构上做不到逐文件判定。
     ⚠️ 这里**不是两份实现**:`detectAll` 与 `detect` 是同一判据的两个视野
     (同一文件内也成立),且 `detect` 仍被框架 E 的区分力自检使用。 */
  const wheres: string[] = d.detectAll !== undefined
    ? d.detectAll(scanFiles)
    : (() => {
        const acc: string[] = [];
        for (const f of scanFiles) {
          const src = readFileSync(f, 'utf8');
          /* 跳过本脚本自身:B 形态在本脚本里是**故意带防护的**,不应被自己报。
             ⚠️ 同时跳过**登记表**:它里面逐条抄了被报行的原文作为 needle
             ⇒ 不跳过的话,登记表自己会被扫出 4 处 C 形态,且是**永远新增**(自己扫自己)。 */
          const rf = rel(f);
          if (rf === 'scripts/judgement_audit.ts' || rf === 'scripts/judgement_baseline.ts') continue;
          acc.push(...d.detect(src, rf));
        }
        return acc;
      })();
  for (const where of wheres) {
    const reg = findBaseline(d.id, where);
    hits.push({
      detector: d.id,
      where,
      registered: reg !== undefined,
      verdict: reg?.verdict ?? '未登记(新增)',
    });
  }
  perDetector.set(d.id, hits);
  allHits.push(...hits);

  const selfOk = selfResults.find((r) => r.id === d.id)?.ok === true;
  const newCount = hits.filter((h) => !h.registered).length;
  const mark = newCount === 0 ? '✓' : '⚠';
  /* ★ 启发式标记打**在输出上**(不是只在 JSDoc 里 —— 没人读 JSDoc) */
  const hz = d.heuristic === undefined ? '' : ` [${d.id}?]`;
  console.log(`  ${mark} ${d.id} ${d.what}:${hits.length} 处${newCount > 0 ? ` —— 新增 ${newCount}` : ''}${selfOk ? '' : '(自检未过,勿信)'}`);
  if (d.heuristic !== undefined) {
    console.log(`      ⚠️ [${d.id}?] ${d.heuristic}`);
  }
  for (const h of hits) {
    /* ★ 标签必须区分「拦门禁的新增」与「候选型(仅告警)」——
       ⚠️ 这里踩过一次:候选型最初也打 `[新增]`,而 `verify.ts` 的接线
       **正是 grep `[新增]` 明细行**来生成失败项的 ⇒ G 的 42 条进了门禁失败列表,
       门禁红了 8 项,而汇总口径明明写的是"新增 0"。
       ⇒ 教训:**改口径时,输出标签也要跟着改** —— 否则下游按旧标签解析,
         出现「汇总说 0、明细说 42」的自相矛盾(与本仓形态 F 同族:
         两处说法不一致,而任一处都不自称不一致)。 */
    const isAdvise = (d.gate ?? 'block') === 'advise';
    const tag = h.registered
      ? `[已登记·${h.verdict}]`
      : (isAdvise ? '[候选·仅告警]' : '[新增]');
    console.log(`      ${tag}${hz} ${h.where}`);
  }
}

/* ── 3. 只读自证 ── */
const after = snapshot(allFiles);
const changed: string[] = [];
for (const [f, h0] of before) {
  const h1 = after.get(f);
  if (h1 !== h0) changed.push(rel(f));
}
console.log('\n[只读自证]');
if (changed.length === 0) {
  console.log(`  ✓ ${allFiles.length} 个文件运行前后 SHA-256 全部一致 —— 本脚本未修改任何文件`);
} else {
  console.log(`  ✗ ${changed.length} 个文件发生变化(不应发生):${changed.slice(0, 5).join(', ')}`);
}

/* ── 4. 汇总 ── */
console.log('\n[汇总]');
console.log(`  检测器:${DETECTORS.length} 个;自检未过:${selfFail} 个`);
for (const d of DETECTORS) {
  const hits = perDetector.get(d.id) ?? [];
  const n = hits.length;
  const nNew = hits.filter((h) => !h.registered).length;
  console.log(`    ${d.id}  ${String(n).padStart(3)} 处(新增 ${nNew})  ${d.what}`);
}
const newHits = allHits.filter((h) => !h.registered);

/* ★ 把「**拦门禁**的」与「**只告警**的」分开 —— 见 `Detector.gate` 的 JSDoc
   (2026-11-13 Lead 裁决「甲」)。两者区别是**结构性的**,不是程度差异:
     block  —— 命中即"坏形状",能逐条定性 ⇒ 未登记就红
     advise —— 命中是"候选",要看差异才能定性 ⇒ 未登记只告警;
               但**数量增长**要红(把"增长"当信号,不是把"有没有"当信号) */
const gateOf = (id: string): 'block' | 'advise' =>
  DETECTORS.find((d) => d.id === id)?.gate ?? 'block';
const blockNew = newHits.filter((h) => gateOf(h.detector) === 'block');
const adviseNew = newHits.filter((h) => gateOf(h.detector) === 'advise');

/* ⚠️ 这一行的「新增」口径 = **拦门禁的未登记命中数**(`blockNew`),不是 `newHits`。
   理由:候选型检测器(G)的命中按设计**不要求逐条登记**(靠水位守卫),
   若把它们计入"新增",门禁一接上就 42 条要人工看 ⇒ 变成噪声源(Lead 裁决「甲」)。
   ⇒ 候选型的量在下一行**单独**报出,不藏。
   ⇒ 上游 `verify.ts` 解析本行的第二个数字作为"新增";它另有
     「exit≠0 但新增=0 ⇒ 报不一致」的兜底 —— 于是**水位超限**(exit 1、新增 0)
     仍会让门禁红。这个组合是刻意设计的,不是巧合。 */
console.log(`  合计命中:${allHits.length} 处;其中 **新增 ${blockNew.length}** 处,已登记 ${allHits.length - newHits.length} 处`);
console.log(`     └─ 口径:新增 = **拦门禁**类未登记 ${blockNew.length} 处;候选型未登记 ${adviseNew.length} 处按设计不计入(见水位守卫)`);
if (adviseNew.length > 0) {
  console.log(`    └─ 其中**拦门禁** ${blockNew.length} 处 / **仅告警** ${adviseNew.length} 处(候选型检测器,见下)`);
}

const bad = selfFail > 0 || changed.length > 0;

/* ── ★ 候选型检测器的**水位守卫**(甲方案的核心)──
   ```
   候选数 ≤ 水位 ⇒ 只是告警,门禁绿(存量已知)
   候选数 > 水位 ⇒ **门禁红**(说明有人新引入了这类形态)  ← 这才是信号
   ```
   ⚠️ 为什么这样判:候选型检测器的命中**无法逐条定性**(G 是启发式),
   若让它「有没有」决定红绿,门禁一接上就 42 条要人工看 ⇒ 变成噪声源。
   ⇒ 水位比的是**总命中数**,不是「新增数」。 */
const adviseTotals = new Map<string, number>();
for (const d of DETECTORS) {
  if (d.gate !== 'advise') continue;
  adviseTotals.set(d.id, (perDetector.get(d.id) ?? []).length);
}
console.log('\n[候选型检测器水位守卫]');
let watermarkBreach = false;
for (const [id, total] of adviseTotals) {
  const wm = id === 'G' ? G_CANDIDATE_WATERMARK : 0;
  if (total > wm) {
    watermarkBreach = true;
    console.log(`  ✗ ${id}:候选 ${total} 条 **超过水位 ${wm}** ⇒ 说明新引入了这类形态 ⇒ 必须处理`);
    console.log('     处置:1 若是真·两份实现 ⇒ 修 2 若确认是有意传递 ⇒ 上调 G_CANDIDATE_WATERMARK 并写理由');
  } else {
    console.log(`  ✓ ${id}:候选 ${total} 条 / 水位 ${wm} ⇒ 存量已知,告警不拦`);
  }
}

/* ── 候选清单单独打印(让人能看到、能人工定性)── */
if (adviseNew.length > 0) {
  console.log('\n[⚠ 需人工定性的候选]');
  for (const h of adviseNew) {
    console.log(`  [${h.detector}?] ${h.where}`);
  }
  const d0 = DETECTORS.find((x) => x.id === adviseNew[0]!.detector);
  if (d0?.heuristic !== undefined) console.log(`  ⚠️ [${d0.id}?] ${d0.heuristic}`);
  console.log('  ⚠️ 上列**不是缺陷**,是「配对存在」的候选 —— 请读每条的[共享]/[独有]差异再定性。');
}

/* ⚠️ 三种出口**必须分开**:
   `--strict`  裸严格:任何命中都红(人工审计用;**接门禁别用它**,已登记项会被误杀)
   `--baseline` 门禁模式:只看**超出登记表的新增**(与 ENTRY_LOAD_EXEMPT 等登记表同模式)
   ★ 且 `--baseline` 下**只有 `gate:'block'` 的检测器**能拦;候选型走水位守卫。 */
if (USE_BASELINE && (bad || blockNew.length > 0 || watermarkBreach)) {
  if (bad) {
    console.log('\n[--baseline] ✗ 检测器自检失败或只读被破坏 ⇒ exit 1');
  } else if (watermarkBreach) {
    console.log('\n[--baseline] ✗ 候选型检测器**超过水位** ⇒ exit 1(见上方水位守卫)');
  } else {
    console.log(`\n[--baseline] ✗ 有 ${blockNew.length} 处**未登记**的新增命中 ⇒ exit 1`);
    console.log('  逐条处置:1 修 2 定性后登记进 scripts/judgement_baseline.ts 3 修检测器(若是假阳性)');
    for (const h of blockNew) {
      const d = DETECTORS.find((x) => x.id === h.detector);
      const hz = d?.heuristic === undefined ? '' : ` [${h.detector}?]`;
      console.log(`      [${h.detector}]${hz} ${h.where}`);
    }
    /* ★ 启发式类的边界说明也要出现在这里 —— 决定「修 or 登记」的人看的是这段输出 */
    const hzUsed = blockNew
      .map((h) => DETECTORS.find((x) => x.id === h.detector))
      .filter((x) => x?.heuristic !== undefined);
    for (const d of new Set(hzUsed)) {
      if (d?.heuristic !== undefined) console.log(`      ⚠️ [${d.id}?] ${d.heuristic}`);
    }
  }
  process.exit(1);
}
if (STRICT && (bad || allHits.length > 0)) {
  console.log(`\n[--strict] ${bad ? '检测器自检失败或只读被破坏' : `有 ${allHits.length} 处命中(含已登记)`} ⇒ exit 1`);
  process.exit(1);
}
if (bad) process.exit(1);
if (USE_BASELINE) {
  const advTotal = [...adviseTotals.values()].reduce((a, b) => a + b, 0);
  console.log(`\n✓ 审计完成(--baseline):拦门禁类新增 0 处;候选型 ${advTotal} 条在水位内(仅告警)`);
} else {
  console.log('\n✓ 审计完成(未加 --strict / --baseline,命中不导致失败)');
}
