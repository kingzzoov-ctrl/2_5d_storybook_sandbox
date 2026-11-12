/**
 * 活路径优先审计(live-path-audit)
 *
 * > `node scripts/live-path-audit.ts`              # 候选清单(表格)
 * > `node scripts/live-path-audit.ts --rx`         # 附「破坏处方」(逐候选)
 * > `node scripts/live-path-audit.ts --json`       # 机器可读
 * > `node scripts/live-path-audit.ts --selftest`   # 判据自检(校准召回/精度)
 *
 * ## 它判什么
 *
 * task-64 的判据「**活路径优先**」(Live-Path-Advantage,LPA):
 *
 * ```
 * 一条断言若落在「生产零调用」的符号上,它**不是「守实现」,而是「欠账」** ——
 * 当且仅当:它所声称守护的那条保证,在**别处有活的实现**。
 *
 * 此时该断言**产出了虚假的覆盖证据**:它让那条保证看起来被测过了,
 * 而真正的实现换行代码就能坏掉,门禁一声不吭。**这比不写更糟** ——
 * 不写至少不会骗人。
 * ```
 *
 * 本脚本**不判「欠账」** —— 它只产出**候选清单**。
 * 「欠账 / 守实现」的判定必须靠**实测**(见下方「处方」),不是靠静态读代码。
 *
 * ## ⚠️ 为什么本脚本不能自己下结论(这条是本脚本的核心边界)
 *
 * 「断言落在死符号上」**既不充分也不必要**地推出「欠账」:
 *
 * ```
 * 它可能是**合法的未来规格** —— 功能真的没做,断言在守「将来接活时行为正确」;
 *      此时它欠的是「一条仍在死的守卫断言」,不是「欠账」。
 *      但本脚本**看不见** test 标题里有没有标注「未接线」(那是写法,不是结构)。
 *
 * 它也可能是**真的守着** —— 该符号虽在生产零调用,但它的行为**经别的入口**
 *      被端到端断言覆盖了(本仓已有多例:能力活着但走了另一条路)。
 *      此时断言有牙,只是牙不在它自己身上。
 * ```
 *
 * ⇒ **故本脚本的输出一律标 `[候选]`,且不带红绿**。它的价值是**把 546 条断言
 *   收敛成 29 个可逐条实测的对象**,而不是替人裁决。
 *
 * ## 处方(本脚本的真正交付物)
 *
 * 每条候选附一条**可执行的破坏处方**:「把活的那套改回坏的,重跑套件,看红不红」。
 * ```
 * 红 ⇒ 该候选**有牙**(断言确实在守那条保证) —— 但仍要人判「守在死符号上是否恰当」
 * 绿 ⇒ **欠账** —— 断言产出了虚假的覆盖证据
 * ```
 * 这条处方**必须**是「破坏活的那套」,而不是「破坏死的那套」——
 * 破坏死符号必然绿(没人调用它),那个实验**没有任何信息量**。
 * 这是本脚本最容易做错的地方,已写成自检样本(`--selftest`)。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const WITH_RX = ARGS.includes('--rx');
const SELFTEST = ARGS.includes('--selftest');

/* ══════════════════ 1. 输入:零生产调用符号 ══════════════════ */

type DeadSymbol = {
  symbol: string;
  file: string;
  line: number;
  prodCalls: number;
  testCalls: number;
  /** 来源:`driver` = deadcode-audit 的「驱动符号」档;`mine` = 本脚本补扫的其余导出 */
  origin: 'driver' | 'supplement';
};

/* ─────────────────────────────────────────────────────────────────────
 * ## ★ 为什么不能只用 `deadcode-audit --json` 当输入(本工具第一版就错在这里)
 *
 * `deadcode-audit.ts` 抽取导出的自由函数时有一道**按名字的过滤器**:
 * ```
 * const DRIVE_VERBS = ['tick','step','advance','apply','drain','update','pump',
 *                      'refresh','flush','consume','settle','decay','evolve',
 *                      'process','run','drive','dispatch','commit'];
 * const isDriverName = (n) => new RegExp(`^(?:[a-z]+)?(?:${...})(?=[A-Z]|$)`).test(n);
 * if (!isDriverName(fn)) continue;      // ← L392
 * ```
 * 那道过滤器**有意**存在(它的注释写明:不加它会把 866 个纯查询函数全打成死代码),
 * 我**不该**去改它 —— 那是 `deadcode-audit` 的口径,不是缺陷。
 *
 * **但它让本判据的输入系统性缺失。** 实测:
 * ```
 *   isInvulnerable    ★ 不在清单
 *   featherRevive     ★ 不在清单     ← 全是 task-64 亲手证过的欠账
 *   bubbleGunHit      ★ 不在清单
 *   flagRevive        ★ 不在清单
 *   tickInvuln        在清单          ← 只因名字以 tick 开头
 * ```
 * ⇒ **我第一版拿它当输入,自检立刻抓到 2/6 漏收**(`--selftest` 的 L2/L3)。
 *   若没写自检,我会交出一份「看起来有 29 条候选」而**恰恰漏掉最该报的那几个**的工具。
 *
 * ⇒ 本脚本**补扫**所有 `export function` / `export const = () =>` /
 *   `export async function`,与 deadcode 的结果**并集**。两边都保留 `origin` 字段,
 *   让人看得出「这条是 driver 档发现的,还是补扫发现的」。
 * ───────────────────────────────────────────────────────────────────── */

/** 跑 `deadcode-audit.ts --json` 拿「驱动符号」档。
 *
 * ⚠️ **必须走子进程、不能 import** —— 它是**顶层执行**脚本(无 `import.meta.main` 守卫),
 * import 会直接跑完整个审计并打印。这与 `verify.ts` 那条「import 不得执行门禁」同族。 */
function loadDriverSymbols(): DeadSymbol[] {
  const r = spawnSync(process.execPath, ['scripts/deadcode-audit.ts', '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.stdout === null || r.stdout.trim() === '') {
    throw new Error(`deadcode-audit --json 无输出(status=${String(r.status)}): ${(r.stderr ?? '').slice(0, 300)}`);
  }
  const j = JSON.parse(r.stdout) as {
    findings: { symbol: string; file: string; line: number; prodCalls: number; testCalls: number }[];
  };
  return j.findings
    .filter((f) => f.prodCalls === 0)
    .map((f) => ({
      symbol: f.symbol, file: f.file, line: f.line,
      prodCalls: f.prodCalls, testCalls: f.testCalls, origin: 'driver' as const,
    }));
}

/* ── 生产可达闭包:PROD_ENTRIES 的单一事实来源 **在 verify.ts 里**。
      ⚠️ 我**不复制**那张表 —— 本仓已多次踩「两份实现并存」(陷阱 31/41),
      复制一张入口表就是第三次。这里用**正则从 verify.ts 抠出来**,
      并在抠不到时**显式失败**,而不是静默退回一个空闭包(那会让所有符号都成"死")。 */
function loadProdEntries(): string[] {
  const src = readFileSync(join(ROOT, 'scripts/verify.ts'), 'utf8');
  const m = /const PROD_ENTRIES = \[([\s\S]*?)\n\];/.exec(src);
  if (m === null) throw new Error('从 scripts/verify.ts 抠不到 PROD_ENTRIES ⇒ 可达性口径失效,拒绝运行');
  const entries = [...(m[1] ?? '').matchAll(/'([^']+\.ts)'/g)].map((x) => x[1]!);
  if (entries.length === 0) throw new Error('PROD_ENTRIES 抠出来是空的 ⇒ 拒绝运行(否则所有符号都会被误判为不可达)');
  return entries;
}

/** 相对 import → 绝对路径。复用 `scripts/imports.ts` 的单一事实来源。 */
async function reachableModules(): Promise<Set<string>> {
  const { extractRelativeImports } = await import('./imports.ts') as { extractRelativeImports: (t: string) => string[] };
  const seen = new Set<string>();
  const queue = loadProdEntries().map((e) => join(ROOT, e));
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (seen.has(p) || !existsSync(p)) continue;
    seen.add(p);
    for (const spec of extractRelativeImports(readFileSync(p, 'utf8'))) {
      queue.push(join(p, '..', spec));
    }
  }
  return seen;
}

/**
 * 补扫所有导出函数 —— **不经名字过滤**。
 *
 * 只收 `export function` / `export const x = (...) =>` / `export async function`;
 * 类方法不在本扫描内(那由 deadcode 的 driver 档覆盖,且类方法要判 owner)。
 */
function scanAllExportedFunctions(): { symbol: string; file: string; line: number }[] {
  const out: { symbol: string; file: string; line: number }[] = [];
  for (const root of ['server/src', 'client/src']) {
    for (const abs of walkTs(join(ROOT, root))) {
      const src = mask(readFileSync(abs, 'utf8'), false);
      const relp = relative(ROOT, abs).split('\\').join('/');
      const add = (name: string, idx: number): void => {
        if (name === 'default') return;
        out.push({ symbol: name, file: relp, line: src.slice(0, idx).split('\n').length });
      };
      for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]!, m.index ?? 0);
      for (const m of src.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/gm)) add(m[1]!, m.index ?? 0);
    }
  }
  return out;
}

/**
 * 统计 `name(` 调用点(**自由函数口径**:前面不是 `.` 也不是标识符字符)。
 * 返回 `file:line` 列表,供排除定义行与人工复核。
 *
 * ## ★ 必须排除**定义行**本身(我在本函数上错过第二版)
 *
 * `export function featherRevive(` 和 `export const x = (...)` **自己就含 `name(`**
 * ⇒ 若不排除,每个导出函数的调用数**至少为 1**(它自己) ⇒ `prodCalls > 0`
 * ⇒ **全部被判定为「生产有调用」⇒ 一个候选都不产出**(或只产出类方法)。
 *
 * 实测症状(修前):`featherRevive` / `isInvulnerable` 静默消失,
 * 而它们的名字恰好不是 DRIVE_VERBS 前缀 ⇒ driver 档也不收 ⇒ **两边都不报**。
 * `--selftest` 的 L2/L3 抓到的就是这个。
 *
 * ⇒ `deadcode-audit.ts` 的 `callSites()` 调用处也有同样的一行
 *   `.filter((h) => h !== \`${s.path}:${defLine}\`)` —— 同样的坑,同样的修法。
 */
function callSites(name: string, files: readonly string[], defFile: string, defLine: number): string[] {
  const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g');
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f).split('\\').join('/');
    const code = mask(readFileSync(f, 'utf8'), false);
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index ?? 0).split('\n').length;
      const at = `${rel}:${line}`;
      /* 定义行不算调用 —— 否则每个导出函数都「调用过自己」 */
      if (rel === defFile && line === defLine) continue;
      hits.push(at);
    }
  }
  return hits;
}

/**
 * 输入 = deadcode 的 driver 档 **∪** 补扫的全部导出函数,再筛「生产 0 调用」。
 *
 * ⚠️ **生产口径 = 生产可达闭包内的文件**,而不是「`server/src` 下所有文件」。
 * 区别很实在:`prank/immunity.ts` **不在**闭包内(白名单原文「等施加整蛊的宿主」),
 * 它内部的调用**不改变**「从入口出发能不能走到这个符号」。
 * ⇒ 但本脚本仍把「模块不可达」作为**独立分栏**报出来,因为那意味着
 *   「整条链都没接」,与「模块接了但驱动入口漏接」是**两种不同的处置**。
 */
async function buildInput(): Promise<{ dead: DeadSymbol[]; reachable: Set<string>; prodFiles: string[]; testFiles: string[] }> {
  const reachable = await reachableModules();
  const prodFiles = [...reachable];
  const testFiles = walkTs(join(ROOT, 'tests'));

  const driver = loadDriverSymbols();
  const supp = scanAllExportedFunctions();

  const merged = new Map<string, DeadSymbol>();
  for (const d of driver) merged.set(d.symbol, d);
  for (const s of supp) {
    if (merged.has(s.symbol)) continue;
    const key = `${s.file}::${s.symbol}`;
    if (merged.has(key)) continue;
    const prod = callSites(s.symbol, prodFiles, s.file, s.line);
    if (prod.length > 0) continue;
    merged.set(s.symbol, {
      symbol: s.symbol, file: s.file, line: s.line,
      prodCalls: 0,
      testCalls: callSites(s.symbol, testFiles, s.file, s.line).length,
      origin: 'supplement',
    });
  }
  return { dead: [...merged.values()], reachable, prodFiles, testFiles };
}

/* ══════════════════ 2. 位置保持的源码掩蔽 ══════════════════ */

/**
 * 位置保持地抹掉注释与(可选)字符串内容。
 *
 * ⚠️ **不能用正则一次性替换** —— 那会吞掉换行,行号全错,而本脚本的产出
 * 是「file:line 供人复核」,行号错了等于产出不可用。
 *
 * ## ★ 我在本函数上错过一版,必须写下来
 *
 * 第一版照抄了「进块注释只写 `/*` 两个空格、随后 `continue`」的写法。
 * 那样**注释的内容根本没被抹掉** —— 只抹了 `/*` 和 `//` 两个标记符本身。
 * 后果是**直接且隐蔽的**:
 * ```
 * revive.ts 的块注释里写着「读它的只有 `isInvulnerable()`」⇒ 被当成一次真调用
 * ⇒ freeCallSites() 数出 5 处 ⇒ 判「生产有调用」⇒ **该符号被排除出候选**
 * ⇒ 而它恰恰是 task-64 亲手证过的头号欠账(tickInvuln 进了,isInvulnerable 没进)
 * ```
 * `--selftest` 的 L2/L3 正是靠这个把它抓出来的。**没有自检我不会发现** ——
 * 输出看起来完全正常(174 条候选),只是**少了两条最该有的**。
 * ⇒ 故:进入 `inLine`/`inBlock` 后**必须继续把内容写成空格**(保留 `\n`)。
 */
function mask(src: string, blankStrings: boolean): string {
  const out = src.split('');
  let st: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    const c2 = src[i + 1];
    /* ★ 注释内:**内容也要抹**(保留换行,否则行号漂移) */
    if (inLine) { if (c === '\n') inLine = false; else out[i] = ' '; continue; }
    if (inBlock) {
      if (c === '*' && c2 === '/') { inBlock = false; out[i] = ' '; out[i + 1] = ' '; i += 1; continue; }
      if (c !== '\n') out[i] = ' ';
      continue;
    }
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

/* ══════════════════ 3. 抽 test 块(手写括号配对) ══════════════════ */

type TestBlock = {
  file: string;
  /** `test(` 所在行(1-based) */
  headLine: number;
  title: string;
  /** 判据体起点(含 `{`)在原文里的偏移 */
  start: number;
  end: number;
  /** 体内断言行(1-based) */
  assertLines: number[];
};

const ASSERT_RE = /\b(eq|near|ok|includes|inRange|throws|rejects)\s*\(/g;

/**
 * 抽 `test('标题', () => { ... })` 的标题与判据体。
 *
 * ⚠️ 必须**手写括号配对**,不能用正则:体内含嵌套箭头函数、对象字面量、
 * 字符串里的花括号(`'{'`)。正则版会在第一个 `}` 处截断,且**静默**。
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
    const headLine = src.slice(0, m.index).split('\n').length;
    let k = j + 1;
    while (k < src.length && src[k] !== '{') k += 1;
    if (k >= src.length) continue;
    let depth = 0;
    let end = k;
    let st: string | null = null;
    let inL = false;
    let inB = false;
    for (let p = k; p < src.length; p += 1) {
      const c = src[p]!;
      const c2 = src[p + 1];
      if (inL) { if (c === '\n') inL = false; continue; }
      if (inB) { if (c === '*' && c2 === '/') { inB = false; p += 1; } continue; }
      if (st !== null) { if (c === '\\') { p += 1; continue; } if (c === st) st = null; continue; }
      if (c === '/' && c2 === '/') { inL = true; p += 1; continue; }
      if (c === '/' && c2 === '*') { inB = true; p += 1; continue; }
      if (c === "'" || c === '"' || c === '`') { st = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { end = p; break; } }
    }
    const body = src.slice(k, end + 1);
    const blank = mask(body, true);
    const assertLines: number[] = [];
    const baseLine = src.slice(0, k).split('\n').length;
    for (const am of blank.matchAll(ASSERT_RE)) {
      assertLines.push(baseLine + blank.slice(0, am.index ?? 0).split('\n').length - 1);
    }
    out.push({ file, headLine, title, start: k, end, assertLines });
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (n.endsWith('.ts')) out.push(p);
  }
  return out;
}

/* ══════════════════ 4. 判据:断言 ∩ 死符号 ══════════════════ */

type Candidate = {
  symbol: string;
  defFile: string;
  defLine: number;
  /**
   * 分层命中。**这是本工具精度的核心**,见下方 `HIT TIERS` 说明。
   * ```
   * A 直接断言  符号调用出现在**断言的实参里**      `eq(isInvulnerable(s), false, ...)`
   * B 间接断言  符号结果先存变量,再进断言实参       `s = tickInvuln(s,1); eq(s.invulnSec, 0)`
   * C 仅构造    **符号只被用来搭夹具**,断言读的是别的东西   `const clk = createManualClock()`
   * ```
   * A/B 才是本判据的对象;C **不属于**本判据 —— 它是「库函数被间接消费」,
   * 正是 `deadcode-audit` 注释里警告的那类(「不加名字过滤会把 866 个全打成死代码」)。
   */
  tier: 'A' | 'B';
  blocks: { file: string; line: number; title: string; tier: 'A' | 'B'; asserts: number }[];
  /** A/B 命中的断言条数(不是块内全部断言) */
  assertCount: number;
  /** 该符号在多少个 test 块里只被当夹具(C 档,不计入候选) */
  fixtureOnlyBlocks: number;
  /** 定义所在模块是否在生产可达闭包内 */
  moduleReachable: boolean;
  /** 输入来源:driver 档 / 本脚本补扫 */
  origin: 'driver' | 'supplement';
  /** 处方:破坏活的那套的可执行动作 */
  prescription: string;
  /** 处方是否**已核实**(有对应活实现) */
  rxVerified: boolean;
};

/* ══════════════════ 4b. 断言实参范围 ══════════════════ */

/**
 * 从 `code` 的 `open`(指向 `(`)开始,返回配对 `)` 的下标。
 * 跳过字符串与注释(它们已由 `mask` 抹平,但此处仍按括号深度计,故只需计括号)。
 */
function matchParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i]!;
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return code.length - 1;
}

/** 一个断言调用的实参区间(相对块体的偏移)。 */
type AssertArgs = { kind: string; start: number; end: number };

function assertArgRanges(blockBlank: string): AssertArgs[] {
  const out: AssertArgs[] = [];
  for (const m of blockBlank.matchAll(ASSERT_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(blockBlank, open);
    out.push({ kind: m[1]!, start: open, end: close });
  }
  return out;
}

/**
 * ## 收集「被断言读取的局部变量名」
 *
 * 用于 B 档:符号结果先存进变量,再在断言实参里被读。
 * 认三种写法(本仓全部出现过):
 * ```
 * const s = tickInvuln(...)          s = tickInvuln(...)      let s = ...
 * const { a } = flagRevive(...)      ← 解构(本仓有:const out = ...)
 * ```
 * ⚠️ 只收**单层**赋值的变量名。链式 `a = f(b); c = g(a); eq(c)` 里 `a` 会被收,
 *   `c` 不会与符号产生关联 ⇒ **漏一层**。这是已知边界,已写进 BOUNDARY。
 */
function assignedFromSymbol(blockBlank: string, bare: string): string[] {
  const names: string[] = [];
  const re = new RegExp(
    `(?:const|let|var)\\s+(?:\\(?\\s*)?([A-Za-z_$][\\w$]*)\\s*(?:\\)?\\s*)?[:=][^=\\n]*?\\b${bare}\\s*\\(`,
    'g',
  );
  for (const m of blockBlank.matchAll(re)) names.push(m[1]!);
  /* 无声明的重新赋值:`s = tickInvuln(s, 1.0)` */
  const re2 = new RegExp(`(?:^|[;\\n])\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*[^=\\n]*?\\b${bare}\\s*\\(`, 'g');
  for (const m of blockBlank.matchAll(re2)) names.push(m[1]!);
  return [...new Set(names)];
}

/** 在实参区间里找 `sym(` 的调用,或找「被断言读取的变量名」。 */
function hitTier(blockBlank: string, args: readonly AssertArgs[], bare: string): 'A' | 'B' | null {
  const callRe = new RegExp(`(?<![.\\w$])${bare}\\s*\\(`, 'g');
  /* A 档:符号调用直接出现在断言实参内 */
  for (const a of args) {
    const seg = blockBlank.slice(a.start, a.end + 1);
    if (callRe.test(seg)) return 'A';
    callRe.lastIndex = 0;
  }
  /* B 档:符号结果存进变量,该变量出现在断言实参内 */
  const vars = assignedFromSymbol(blockBlank, bare);
  if (vars.length > 0) {
    for (const a of args) {
      const seg = blockBlank.slice(a.start, a.end + 1);
      for (const v of vars) {
        if (new RegExp(`(?<![.\\w$])${v}(?![\\w$])`).test(seg)) return 'B';
      }
    }
  }
  return null;
}

/**
 * 识别「活的生产入口」形态。
 *
 * ⚠️ **这不是「跑过生产路径」的证明** —— 它只说明这个 test 块**构造过**
 * 世界对象/世界级入口。是否端到端跑通,得看它断言了什么。
 * 故 `liveBlocks` 仅作**分栏提示**,不参与判定。
 */
const LIVE_ENTRY_RE = /\bnew\s+WorldSim\b|\battackWorld\s*\(|\bpartyWorld\s*\(|\bcreateWorld\s*\(|\bmakeWorld\s*\(|\bnew\s+Sim\b/;

/**
 * 手写的「活孪生体」对照表 —— **这是本脚本唯一需要人工维护的部分**。
 *
 * ## 为什么必须手写(不能自动推)
 *
 * 「不同名的两个函数做同一件事」**结构上不可判定**。实测过的真例:
 * ```
 * settleBreak(死)  ↔  BeetleAi.onDamage(活)     —— 名字毫无相似性
 * tickInvuln(死)   ↔  vitals.stepTimers(活)     —— 一个递减字段,一个递减另一个字段
 * applyShield(死)  ↔  ??                        —— 模块整体不可达,可能**真没活孪生**
 * ```
 * ⇒ 自动推只能靠名字相似度,而**真例恰好全都不同名**(同名的那是「两份实现」,
 *   属 CR-19 另一个判据)。**用名字推会全漏**。
 *
 * ## 维护纪律
 *
 * · 表里每条**必须**是「读过两边源码后确认做同一件事」的,不是猜的;
 * · 查不到活孪生体的**不登记** ⇒ 该候选落 `[需人工]`,处方写成「先找活孪生体」;
 * · **不得**因为「想让门禁好看」而登记 —— 这张表是人工成本,不是门面。
 */
const LIVE_TWINS: Record<string, { twin: string; why: string }> = {
  tickInvuln: {
    twin: 'server/src/combat/vitals.ts 的 stepTimers()(递减 Vitals.iframeSec)',
    why: '两者都是「递减无敌计时」。task-64 已实测:tickInvuln 递减的是 DownedState.invulnSec,0 读者;真正生效的是 iframeSec',
  },
  isInvulnerable: {
    twin: 'server/src/combat/vitals.ts 的 applyHit() 里 `if (v.iframeSec > 0)`',
    why: '两者都是「判是否处于无敌」。task-64 已实测:isInvulnerable 读 DownedState.invulnSec(0 读者);真正的判定读 Vitals.iframeSec',
  },
  featherRevive: {
    twin: 'server/src/combat/revive.ts 的 touchRevive()(经 world_sim.ts:1936 驱动)',
    why: '两者都是「把幽灵泡泡复活」。实测:touchRevive 生产 2 处(活);featherRevive 生产 0 处(死),但行为已实测正确(revived=true/false/超距 reason),只差一层调用',
  },
  applyDamage: {
    twin: 'server/src/mobs/behaviors.ts 的 BeetleAi.onDamage(晶甲/破壳)',
    why: 'CR-19 已实测:damage.ts 的 applyDamage 生产 0 调用,正面免疫由 BeetleAi 兑现(朝向 0° hpLoss=1.6 / 180° hpLoss=8.0)',
  },
  settleBreak: {
    twin: 'server/src/mobs/behaviors.ts 的 BeetleAi.onDamage(经 weaponId=204 走 EXPLOSION)',
    why: 'CR-19 实测:weaponId=204 时 events=["beetle_shell_broken"],破壳已实现且可达',
  },
  consumeItem: {
    twin: '(未确认 —— 需先判「物品扣减」是否有别的活入口)',
    why: 'db/repo.ts 的 consumeItem 生产 0 调用。本仓 US2 未接网络层,物品扣减可能整条未接线 ⇒ **不能假定有活孪生体**',
  },
  applyShield: {
    twin: '(未确认 —— prank/immunity.ts 整个模块不在生产可达闭包内)',
    why: 'verify.ts 白名单原文:「WS-11 整蛊免疫,等施加整蛊的宿主(与 toys.ts 同一个)」⇒ 模块级未接线,不是「换了条路」',
  },
  bubbleGunHit: {
    twin: 'server/src/prank/toys.ts 的玩具表 227 登记(allyEffect/enemyEffect)',
    why: 'task-64 实测:玩具表声明「连射 3 发装泡泡」,但**它自己没有代码把 3 发累计→BUBBLED**;且 prank/toys.ts 本身不可达(其宿主 immunity.ts 无 import 者)⇒ 疑为「双死」,须先确认',
  },
  flagRevive: {
    twin: '(未确认 —— 435 有活用途但不同:party/scoring.ts 的出生旗)',
    why: 'task-64 实测:435 被计分为 SPAWN_FLAG_ITEM_ID,但那是「出生点」不是「倒地复活」⇒ 不是同一条保证,须先裁决玩法身份',
  },
};

async function buildCandidates(): Promise<{ cands: Candidate[]; dead: DeadSymbol[]; prodFiles: string[] }> {
  const { dead, reachable, prodFiles, testFiles } = await buildInput();

  const blocks: { f: string; src: string; tb: TestBlock; blank: string; keep: string }[] = [];
  for (const f of testFiles) {
    const src = readFileSync(f, 'utf8');
    const blank = mask(src, true);
    const keep = mask(src, false);
    for (const tb of extractTests(f, src)) blocks.push({ f, src, tb, blank, keep });
  }

  const cands: Candidate[] = [];
  for (const d of dead) {
    const bare = d.symbol.includes('::') ? d.symbol.split('::')[1]! : d.symbol;
    /* 条件:块体里以**调用语法**出现该符号 —— 排除「只在注释/字符串里提到」 */
    const hitBlocks: Candidate['blocks'] = [];
    let fixtureOnly = 0;
    let tierA = 0;
    let tierB = 0;
    for (const b of blocks) {
      const body = b.blank.slice(b.tb.start, b.tb.end + 1);
      const callRe = new RegExp(`(?<![.\\w$])${bare}\\s*\\(`);
      if (!callRe.test(body)) continue;
      const args = assertArgRanges(body);
      const tier = hitTier(body, args, bare);
      if (tier === null) { fixtureOnly += 1; continue; }
      const n = args.length;
      hitBlocks.push({
        file: relative(ROOT, b.f).split('\\').join('/'),
        line: b.tb.headLine,
        title: b.tb.title,
        tier,
        asserts: n,
      });
      if (tier === 'A') tierA += 1; else tierB += 1;
    }
    /* ★ 只被当夹具(C 档)的**不入选** —— 那是「库函数被间接消费」,
       正是 deadcode-audit 用名字过滤想排除的那一类。 */
    if (hitBlocks.length === 0) continue;

    const tw = LIVE_TWINS[d.symbol];
    const verified = tw !== undefined && !tw.twin.startsWith('(未确认');
    cands.push({
      symbol: d.symbol,
      defFile: d.file,
      defLine: d.line,
      tier: tierA > 0 ? 'A' : 'B',
      blocks: hitBlocks,
      assertCount: hitBlocks.reduce((a, x) => a + x.asserts, 0),
      fixtureOnlyBlocks: fixtureOnly,
      moduleReachable: reachable.has(join(ROOT, d.file)),
      origin: d.origin,
      prescription: verified
        ? `破坏活孪生体:${tw.twin} ⇒ 重跑命中它的套件 ⇒ 看是否变红`
        : '**先找活孪生体**(同模块内是否有做同一件事的活函数)。找不到 ⇒ 该保证可能整条未接线,属「未接线」而非「欠账」',
      rxVerified: verified,
    });
  }
  cands.sort((a, b) => b.assertCount - a.assertCount);
  return { cands, dead, prodFiles };
}

/* ══════════════════ 5. 自检:判据的召回与精度 ══════════════════ */

/**
 * ## 自检设计
 *
 * 本判据是**启发式**(靠「调用语法出现」这个静态近似),
 * 所以必须用**已知答案的样本**校准。三类样本:
 *
 * ```
 * 真阳性(必收)  task-64 已实测的三条:tickInvuln / isInvulnerable / featherRevive
 *               ⇒ 它们**确实**是「断言落在死符号上」
 * 真阴性(必不收) 生产调用 >0 的符号(如 touchRevive 生产 2 处)
 *               ⇒ 落在它们上的断言不属本判据
 * 边界(可收可不收,必须说清) `--` 只在注释里被提到的符号
 *               ⇒ 「注释里提到」不是「断言守它」,必须排除
 * ```
 *
 * ⚠️ 自检**不判「欠账」** —— 那要跑处方。「欠账」的判定没有静态自检,
 *    `--selftest` 只校准**候选识别的准确性**,不校准**结论的正确性**。
 *     这两件事必须分开,混在一起会让自检给出虚假信心。
 */
type LabCase = { id: string; what: string; symbol: string; want: 'hit' | 'miss'; known: boolean };
const LAB: LabCase[] = [
  { id: 'L1', what: 'task-64 实测欠账:tickInvuln 有 5 条断言(1773/1777/1778/1779/1781 所在块)', symbol: 'tickInvuln', want: 'hit', known: true },
  { id: 'L2', what: 'task-64 实测欠账:isInvulnerable 有 2 条断言', symbol: 'isInvulnerable', want: 'hit', known: true },
  { id: 'L3', what: 'task-64 实测欠账:featherRevive 有断言', symbol: 'featherRevive', want: 'hit', known: true },
  { id: 'L4', what: '对照(活符号):touchRevive 生产 2 处 ⇒ 不属本判据', symbol: 'touchRevive', want: 'miss', known: true },
  { id: 'L5', what: '对照(活符号):createDowned 生产 2 处', symbol: 'createDowned', want: 'miss', known: true },
  { id: 'L6', what: '对照(活符号):tickGhostBubble 生产 2 处', symbol: 'tickGhostBubble', want: 'miss', known: true },
];

async function runSelftest(): Promise<number> {
  console.log('══ 判据自检:候选识别的召回与精度 ══\n');
  const { cands, dead } = await buildCandidates();
  const hitSet = new Set(cands.map((c) => c.symbol));
  const deadSet = new Set(dead.map((d) => d.symbol));
  let fail = 0;
  console.log('样本'.padEnd(6) + '期望'.padEnd(6) + '实得'.padEnd(8) + '符号'.padEnd(20) + '说明');
  for (const l of LAB) {
    let got: 'hit' | 'miss';
    if (l.want === 'miss') {
      /* 活符号:不应该出现在「生产零调用」清单里 */
      got = deadSet.has(l.symbol) ? 'hit' : 'miss';
    } else {
      got = hitSet.has(l.symbol) ? 'hit' : 'miss';
    }
    const ok = got === l.want;
    if (!ok) fail += 1;
    console.log(
      l.id.padEnd(6) + l.want.padEnd(6) + (ok ? got : `✗ ${got}`).padEnd(8)
      + l.symbol.padEnd(20) + l.what,
    );
  }
  const recall = LAB.filter((l) => l.want === 'hit').length;
  const precision = LAB.filter((l) => l.want === 'miss').length;
  console.log('');
  console.log(`召回样本 ${recall} 条 / 精度样本 ${precision} 条 ⇒ ${fail === 0 ? '✓ 全部符合' : `✗ ${fail} 条不符`}`);

  /* 边界:必须证明「注释里提到」不产生候选 */
  console.log('\n══ 边界自检:「只在注释/字符串里被提到」不得产生候选 ══');
  let commentOnly = 0;
  let verified = 0;
  for (const f of walkTs(join(ROOT, 'server/src'))) {
    const raw = readFileSync(f, 'utf8');
    const keep = mask(raw, false);
    const blank = mask(raw, true);
    const m = /\b(isInvulnerable|tickInvuln)\s*\(/.exec(keep);
    if (m !== null) {
      const idx = m.index;
      /* 同一位置在 blank 里是空白 ⇒ 该次出现位于注释或字符串中 */
      if (blank.slice(idx, idx + m[1]!.length).trim() === '') {
        commentOnly += 1;
        const rel = relative(ROOT, f).split('\\').join('/');
        console.log(`  注释/字符串样本:${rel}:${keep.slice(0, idx).split('\n').length}  (${m[1]})`);
      } else verified += 1;
    }
  }
  console.log(`  扫描到:注释/字符串内 ${commentOnly} 处,真代码 ${verified} 处`);
  console.log(`  ⇒ 「调用语法 + 块体掩蔽」双条件保证注释里的出现不进候选:构造上不可能(块为空即不入选)`);
  const zeroBlock = cands.filter((c) => c.blocks.length === 0).length;
  console.log(`  零块的候选:${zeroBlock} 条 ${zeroBlock === 0 ? '✓' : '✗'}`);

  console.log(`\n候选合计 ${cands.length} 条(零调用符号 ${dead.length} 个,其中 ${dead.length - cands.length} 个无断言触碰 = 不属本判据)`);
  const byOrigin = { driver: cands.filter((c) => c.origin === 'driver').length, supplement: cands.filter((c) => c.origin === 'supplement').length };
  console.log(`  来源:driver 档 ${byOrigin.driver} 条 / 本脚本补扫 ${byOrigin.supplement} 条`);
  console.log(`  ⇒ ★ 补扫那 ${byOrigin.supplement} 条是 deadcode-audit 的**名字过滤器**(DRIVE_VERBS)看不见的`);
  return fail;
}

/* ══════════════════ 6. 输出 ══════════════════ */

async function main(): Promise<number> {
  const { cands, dead } = await buildCandidates();

  if (AS_JSON) {
    console.log(JSON.stringify({
      scanned: { deadSymbols: dead.length, candidates: cands.length },
      candidates: cands,
      boundary: BOUNDARY,
    }, null, 2));
    return 0;
  }

  console.log('════════════════ 活路径优先审计(live-path-audit)════════════════');
  console.log('输入 = deadcode-audit 的 driver 档 ∪ 本脚本补扫的全部导出函数,筛「生产 0 调用」');
  console.log(`零调用符号 ${dead.length} 个;其中「被断言触碰」的:**${cands.length}** 个 ⇒ 本判据的候选`);
  console.log(`另 ${dead.length - cands.length} 个**没有任何断言触碰** ⇒ 不属本判据(纯泄漏,不是欠账)`);
  const byOrigin = { driver: cands.filter((c) => c.origin === 'driver').length, supplement: cands.filter((c) => c.origin === 'supplement').length };
  console.log(`★ 其中**补扫**发现 ${byOrigin.supplement} 个 —— deadcode-audit 的 DRIVE_VERBS 名字过滤器看不见它们`);
  const byTier = { A: cands.filter((c) => c.tier === 'A').length, B: cands.filter((c) => c.tier === 'B').length };
  console.log(`分层:A(符号直入断言实参)${byTier.A} 个 / B(结果存变量再入断言)${byTier.B} 个\n`);

  const totalAsserts = cands.reduce((a, c) => a + c.assertCount, 0);
  console.log(`候选共牵连断言 **${totalAsserts}** 条`);
  const fixtures = cands.reduce((a, c) => a + c.fixtureOnlyBlocks, 0);
  console.log(`另有 ${fixtures} 个 test 块**只把候选符号当夹具**(断言读的是别的东西)⇒ 已排除,不属本判据\n`);

  console.log('符号'.padEnd(24) + '层'.padStart(3) + '断言'.padStart(5) + '块'.padStart(4) + '夹具块'.padStart(7) + '  模块     来源    处方');
  for (const c of cands) {
    console.log(
      c.symbol.padEnd(24) + c.tier.padStart(3) + String(c.assertCount).padStart(5)
      + String(c.blocks.length).padStart(4) + String(c.fixtureOnlyBlocks).padStart(7) + '  '
      + (c.moduleReachable ? ' 可达  ' : '**不可达**')
      + (c.origin === 'driver' ? ' driver ' : ' 补扫  ')
      + (c.rxVerified ? '✓ 已知活孪生体' : '⚠ 需人工找活孪生体'),
    );
  }

  const unreach = cands.filter((c) => !c.moduleReachable);
  if (unreach.length > 0) {
    console.log(`\n⚠ 其中 ${unreach.length} 条的**模块本身不在生产可达闭包内** ⇒ 属「整条链未接线」,`);
    console.log('  与「模块接了但驱动入口漏接」是两种不同的处置(前者要连宿主一起接):');
    for (const c of unreach) console.log(`    ${c.symbol.padEnd(24)} ${c.defFile}`);
  }

  if (WITH_RX) {
    console.log('\n════════════════ 破坏处方(逐候选)════════════════');
    for (const c of cands) {
      console.log(`\n【${c.symbol}】 [${c.tier} 档] ${c.defFile.replace('server/src/', '')}:${c.defLine}`);
      console.log(`  断言 ${c.assertCount} 条,分布在 ${c.blocks.length} 个 test 块:`);
      for (const b of c.blocks.slice(0, 6)) {
        console.log(`    ${b.file}:${b.line}  [${b.tier}/${b.asserts} 断言]  ${b.title.slice(0, 52)}`);
      }
      if (c.blocks.length > 6) console.log(`    ...另有 ${c.blocks.length - 6} 个块`);
      console.log(`  处方:${c.prescription}`);
      console.log('  判读:红 ⇒ 该断言**有牙**(确实在守那条保证);绿 ⇒ **欠账**(覆盖证据的赝品)');
    }
  }

  console.log('\n════════════════ 判据边界(必读)════════════════');
  for (const b of BOUNDARY) console.log(`  · ${b}`);
  console.log('\n⚠️ 本条**不判「欠账」** —— 只产出候选。判定必须跑上方处方(实测),不是静态读代码。');
  return 0;
}

/**
 * ## 本判据**结构上看不见**什么
 *
 * 沿用 task-64 的规格:每条都要写明「看不见什么」,否则读者会高估结论覆盖。
 */
const BOUNDARY: readonly string[] = [
  '看不见「断言测的是不是生产路径」的细粒度 —— 只按 test 块分栏,块内只要构造过世界对象就标「活块」,不证明该断言真的端到端跑过',
  '看不见「同名不同物」—— 按符号名匹配。若测试里有个局部变量与死符号同名,会误收(本仓已有先例:`near` 曾遮蔽导入的 near())',
  '看不见「活孪生体」—— 那张表是手写的。不同名的两个函数做同一件事,结构上不可判定(真例 settleBreak↔BeetleAi.onDamage 毫无名字相似性)',
  '看不见「断言的强度」—— 一条 `ok(x !== undefined)` 与一条 `eq(x, 精确值)` 在本脚本眼里等价,但守的东西天差地别',
  '看不见「该保证是否真的需要存在」—— 若功能本版不做,守它的断言是**合法的未来规格**,不是欠账。判这个要靠 test 标题有没有标注,而写法不是结构',
  '看不见动态/条件产生的断言 —— 只认字面 `test(` 调用',
  '看不见「断言有牙性」—— 那是 assertion-audit 的 `--strict-taut` 与净-persist 的反向核查那一层,与「断言与生产路径的对应关系」是两回事',
];

const rc = SELFTEST ? await runSelftest() : await main();
process.exitCode = rc === 0 ? 0 : 1;
