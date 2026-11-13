/**
 * ★ task-81:文档里的 `path.ts:NNN` 引用**行号**普查。
 *
 * 起因(实测):
 *   `docs/AUTHORITY-MAP.md` 三处写 `net/anticheat.ts:76` 是 `interface Clock`,
 *   而实测该接口在 **L203**;L76 是一段注释。
 *   ⇒ 文档的读者没有编译器(陷阱 92),这类错**永远不会被现有门禁发现**。
 *
 * 本器件做**完全机械**的两件事(都能确认对错,不需推断):
 *   ① `行号 > 文件总行数` ⇒ **确定陈旧**(文件缩了)
 *   ② 把该行的**实际内容打印出来** ⇒ 人一眼可判断"这是我说的那个符号吗"
 *
 * ★ 为什么不做"自动判断语义是否匹配":
 *   那需要知道"文档这句话指向哪个符号"—— 属推断意图 ⇒ 按本仓分水岭
 *   **只出清单,不判红**。硬判会造成两类误报:
 *     · 引用的是"该行所在的块"而非该行本身
 *     · 引用的是"这个文件里关于 X 的说明"而不是"X 的定义"
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const walkMd = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') walkMd(join(dir, e.name), out); }
    else if (e.isFile() && e.name.endsWith('.md')) out.push(join(dir, e.name));
  }
  return out;
};

/** 提取 `something.ts:123` / `something.ts:123-456` */
const REF = /([A-Za-z0-9_./\-]+\.(?:ts|tsx|md|json|sql)):(\d+)(?:\s*[-–~]\s*(\d+))?/g;

interface Ref { doc: string; docLine: number; target: string; line: number; end?: number; snippet: string }
const refs: Ref[] = [];

for (const d of walkMd(ROOT)) {
  const L = readFileSync(d, 'utf8').split(/\r?\n/);
  L.forEach((ln, i) => {
    REF.lastIndex = 0;
    for (const m of ln.matchAll(REF)) {
      refs.push({
        doc: relative(ROOT, d).replace(/\\/g, '/'), docLine: i + 1,
        target: m[1]!, line: Number(m[2]), end: m[3] ? Number(m[3]) : undefined,
        snippet: ln.trim().slice(0, 130),
      });
    }
  });
}

console.log('══ 0 分母 ══');
console.log(`   扫描 .md 文件 ${walkMd(ROOT).length} 份`);
console.log(`   提取出 \`路径:行号\` 引用 **${refs.length}** 处`);

/* 解析 target 到实际文件:相对仓库根 → 相对文档所在目录 → **按 basename 全仓搜**
 * ★ 第一版只有前两种,实测报「文件不存在 658 处」—— 而绝大多数是**裸文件名**引用
 *   (`verify.ts:918` / `anticheat.ts:4`),文档里根本没写路径。
 *   ⇒ 那是**我的解析器太窄**,不是文档错(同一个错误的第 5 次:
 *     「我的判据比它要测的东西窄一格」)。
 *   ⇒ 修法:补上按 basename 全仓搜索;若同名多个,报出来让人判(不猜)。 */
const basenameIndex = new Map<string, string[]>();
const buildIndex = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      buildIndex(join(dir, e.name));
    } else if (e.isFile()) {
      const list = basenameIndex.get(e.name) ?? [];
      list.push(join(dir, e.name));
      basenameIndex.set(e.name, list);
    }
  }
};
buildIndex(ROOT);

const resolve = (doc: string, target: string): { file: string } | { ambiguous: string[] } | null => {
  const cands = [
    join(ROOT, target),
    join(ROOT, doc, '..', target),
    join(ROOT, '2_5d_sandbox', target),
  ];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return { file: c };
  /* 按 basename 搜 */
  const base = target.split('/').pop()!;
  const hits = basenameIndex.get(base) ?? [];
  if (hits.length === 1) return { file: hits[0]! };
  if (hits.length > 1) {
    /* 若 target 含目录片段,用它过滤 */
    const parts = target.split('/');
    const filtered = hits.filter((h) => parts.every((p) => h.includes(p)));
    if (filtered.length === 1) return { file: filtered[0]! };
    return { ambiguous: hits.map((h) => relative(ROOT, h).replace(/\\/g, '/')) };
  }
  return null;
};

let missing = 0;
let overrun = 0;
let ambiguous = 0;
const ok: Ref[] = [];
const bad: { r: Ref; why: string; actual: string }[] = [];

for (const r of refs) {
  const res = resolve(r.doc, r.target);
  if (res === null) { missing += 1; bad.push({ r, why: '文件不存在', actual: '' }); continue; }
  if ('ambiguous' in res) {
    ambiguous += 1;
    bad.push({ r, why: `同名 ${res.ambiguous.length} 个(需人判)`, actual: res.ambiguous.slice(0, 3).join(' | ') });
    continue;
  }
  const f = res.file;
  const L = readFileSync(f, 'utf8').split(/\r?\n/);
  if (r.line > L.length) {
    overrun += 1;
    bad.push({ r, why: `行号 ${r.line} > 文件总行数 ${L.length}`, actual: relative(ROOT, f).replace(/\\/g, '/') });
    continue;
  }
  ok.push(r);
  r.snippet = `${L[r.line - 1]!.trim().slice(0, 120)}`;
}

console.log(`\n══ 1 机械可判的错误 ══`);
console.log(`   · 目标文件不存在        : ${missing} 处`);
console.log(`   · 同名多文件(需人判)  : ${ambiguous} 处`);
console.log(`   · ★ 行号超出文件总行数  : ${overrun} 处  ← 这一条是 100% 确定的陈旧`);
console.log(`   · 行号在范围内(需人看)  : ${ok.length} 处`);

/* ★ 只把"确定陈旧"的逐条列出;其余只归类报数(它们多半是我的解析器没找到) */
/* ★ 行号越界的清单里,**有些是"故意保留的历史引用"**:
 *   文档在记录"我上次把证据挂错了"时,必须写出**当时那个错的行号**。
 *   把它"修正"成正确行号 = 篡改历史(与 `count-audit.ts` 的 `〔引用〕` 同一处置)。
 * ⇒ 处置:这些行的**上一行或本行**若含 `〔引用〕`,则归类为「历史引用」,
 *   单独列出而**不算作错误**。⚠️ 与 count-audit 同样的约束:
 *   标记必须**逐行显式**,且被跳过的必须**逐条可见**(不静默)。 */
console.log('\n   ── 行号越界(确定陈旧)逐条 ──');
const overruns = bad.filter((b) => b.why.includes('> 文件总行数'));
const hist: typeof overruns = [];
const live: typeof overruns = [];
for (const b of overruns) {
  const docPath = join(ROOT, b.r.doc);
  const DL = existsSync(docPath) ? readFileSync(docPath, 'utf8').split(/\r?\n/) : [];
  const ctx = [DL[b.r.docLine - 2] ?? '', DL[b.r.docLine - 1] ?? ''].join('\n');
  if (ctx.includes('〔引用〕')) hist.push(b); else live.push(b);
}

if (live.length === 0) console.log('      (无)');
for (const b of live) {
  console.log(`   ★ ${b.r.doc}:${b.r.docLine}  →  ${b.r.target}:${b.r.line}  [${b.why}]`);
  console.log(`       实际文件: ${b.actual}`);
  console.log(`       原文: ${b.r.snippet}`);
}
console.log(`\n   ── 历史引用(标了 〔引用〕,**不算错误**)${hist.length} 处 ──`);
for (const b of hist) {
  console.log(`   · ${b.r.doc}:${b.r.docLine}  →  ${b.r.target}:${b.r.line}  [${b.why}]`);
}
console.log(`   ⚠️ 上面 ${hist.length} 处被**跳过**,故它们不受本检测器保护;
      若有人借 〔引用〕 掩盖真陈旧,唯一防线就是这份逐条清单。`);

console.log('\n   ── 文件不存在 / 同名多文件:按目标名归类(前 12 类)──');
const byTarget = new Map<string, number>();
for (const b of bad) {
  if (b.why.includes('> 文件总行数')) continue;
  byTarget.set(b.r.target, (byTarget.get(b.r.target) ?? 0) + 1);
}
for (const [t, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`   ${String(n).padStart(4)} 次  ${t}`);
}
console.log(`   ⇒ ⚠️ 这一类比"行号越界"弱得多:多半是**我的解析器**没找到(裸文件名/别名),
     不一定是文档错 ⇒ 故**不算作错误**,只归类报数。`);

/* ★ 高价值子集:指向 .ts 且行号在范围内 —— 把这些行的实际内容打出来,
   供人扫一遍"这是不是我说的那个符号"。只打印**被引用 ≥2 次**的行(更可能重要) */
console.log('\n══ 2 抽样:被多处引用的 file.ts:行号 的实际内容 ══');
const counts = new Map<string, number>();
for (const r of ok) {
  const k = `${r.target}:${r.line}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
const repeated = ok.filter((r) => (counts.get(`${r.target}:${r.line}`) ?? 0) >= 2);
const seen = new Set<string>();
console.log(`   被 ≥2 处引用: ${repeated.length} 处引用,涉及 ${new Set(repeated.map((r) => `${r.target}:${r.line}`)).size} 个不同行号`);
for (const r of repeated) {
  const k = `${r.target}:${r.line}`;
  if (seen.has(k)) continue;
  seen.add(k);
  const looksEmpty = r.snippet === '' || /^[)}\];,]*$/.test(r.snippet) || /^\s*\/?\*/.test(r.snippet);
  console.log(`   ${looksEmpty ? '★' : '·'} ${k.padEnd(46)} ${r.snippet.slice(0, 90)}`);
}
console.log(`
   ⇒ 标 ★ 的那些行是**空行/纯括号/注释开头** —— 引用它们几乎一定是陈旧行号。
     这是一条**高信噪比**的启发式:定义与实参几乎不会是空行或孤立的 } 。
   ⇒ 但它仍是启发式:**不判红**。要人看。
`);

console.log('\n══ 3 本器件的定位 ══');
console.log(`
   ✅ 能确定:文件缺失、行号越界、被引用行是空行/纯括号
   ❌ 不能确定:"该行的符号是否就是文档说的那个符号"
   ⇒ 故它是**清单工具**,不进退出码。
   ⇒ 要门禁化,只能纳入前两类(那是 100% 可判的),第三类永远需要人。
`);