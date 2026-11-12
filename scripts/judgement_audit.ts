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
 * 用法:
 * ```
 * node scripts/judgement_audit.ts          # 报告
 * node scripts/judgement_audit.ts --strict # 有未登记命中即 exit 1
 * ```
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBaseline, JUDGEMENT_BASELINE } from './judgement_baseline.ts';

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

/* E 不是独立检测器:它是**自检框架**本身(每个检测器都要过区分力自检)。 */
const DETECTORS: readonly Detector[] = [DET_A, DET_B, DET_C, DET_D, DET_F];

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
  for (const f of scanFiles) {
    const src = readFileSync(f, 'utf8');
    /* 跳过本脚本自身:B 形态在本脚本里是**故意带防护的**,不应被自己报。
       ⚠️ 同时跳过**登记表**:它里面逐条抄了被报行的原文作为 needle
       ⇒ 不跳过的话,登记表自己会被扫出 4 处 C 形态,且是**永远新增**(自己扫自己)。 */
    const rf = rel(f);
    if (rf === 'scripts/judgement_audit.ts' || rf === 'scripts/judgement_baseline.ts') continue;
    for (const where of d.detect(src, rel(f))) {
      const reg = findBaseline(d.id, where);
      hits.push({
        detector: d.id,
        where,
        registered: reg !== undefined,
        verdict: reg?.verdict ?? '未登记(新增)',
      });
    }
  }
  perDetector.set(d.id, hits);
  allHits.push(...hits);

  const selfOk = selfResults.find((r) => r.id === d.id)?.ok === true;
  const newCount = hits.filter((h) => !h.registered).length;
  const mark = newCount === 0 ? '✓' : '⚠';
  console.log(`  ${mark} ${d.id} ${d.what}:${hits.length} 处${newCount > 0 ? ` —— 新增 ${newCount}` : ''}${selfOk ? '' : '(自检未过,勿信)'}`);
  for (const h of hits) {
    const tag = h.registered ? `[已登记·${h.verdict}]` : '[新增]';
    console.log(`      ${tag} ${h.where}`);
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
console.log(`  合计命中:${allHits.length} 处;其中 **新增 ${newHits.length}** 处,已登记 ${allHits.length - newHits.length} 处`);

const bad = selfFail > 0 || changed.length > 0;

/* ⚠️ 两种失败**必须分开**:
   `--strict`  裸严格:任何命中都红(人工审计用;**接门禁别用它**,已登记项会被误杀)
   `--baseline` 门禁模式:只看**超出登记表的新增**(与 ENTRY_LOAD_EXEMPT 等登记表同模式) */
if (USE_BASELINE && (bad || newHits.length > 0)) {
  if (bad) {
    console.log('\n[--baseline] ✗ 检测器自检失败或只读被破坏 ⇒ exit 1');
  } else {
    console.log(`\n[--baseline] ✗ 有 ${newHits.length} 处**未登记**的新增命中 ⇒ exit 1`);
    console.log('  逐条处置:① 修 ② 定性后登记进 scripts/judgement_baseline.ts ③ 修检测器(若是假阳性)');
    for (const h of newHits) console.log(`      [${h.detector}] ${h.where}`);
  }
  process.exit(1);
}
if (STRICT && (bad || allHits.length > 0)) {
  console.log(`\n[--strict] ${bad ? '检测器自检失败或只读被破坏' : `有 ${allHits.length} 处命中(含已登记)`} ⇒ exit 1`);
  process.exit(1);
}
if (bad) process.exit(1);
console.log('\n✓ 审计完成(未加 --strict / --baseline,命中不导致失败)');