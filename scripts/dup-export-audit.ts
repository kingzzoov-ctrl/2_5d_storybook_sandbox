/**
 * ★★ 把上一份"同名导出清单"收窄成**可判的那一类**:
 *   同名 + **声明体裁相同** + **内容不同** ⇒ 高信噪比的可疑点。
 *
 * ## 判据的推进
 * 上一版列出了 30 个同名导出,但绝大多数是**同名不同物**(不同域各自合法)。
 * 想再收窄,只有一个机械可做的动作:**比较两个声明的实际内容**。
 *
 *   对 `const`     ⇒ 比较**初始化表达式**(归一化空白)
 *   对 `interface` ⇒ 比较**字段名+类型的有序集合**
 *   对 `type`      ⇒ 比较右侧文本
 *
 * 三种结果:
 *   内容相同  ⇒ (c) 权威 + 再导出,或真重复但未漂移 —— 低优先
 *   内容不同  ⇒ ★ **要么是漂移(缺陷),要么真是两件事(设计)** —— 需人判
 *   体裁不同  ⇒ 低优先(名字撞车)
 *
 * ★ 依然**不判红**:内容不同仍有两种成因。但它把 30 个候选择成个位数,
 *   而剩下那些**每一条都值得人看一眼** —— 这就是"只出清单"的正确粒度。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
/* ★★★ 2026-11-14:跳过名从**唯一事实源**取,不再各写一份。
   起因:仓库根多了 `_probe_sandbox/`(队友的整仓副本),而本文件的局部列表没有它。
   实测当时 7 个判据各写一份,只有 1 个含它(6/7 缺)⇒ 扫副本 ⇒ 把 HEAD 的既有问题
   报成"本轮新增"(假红)。详见 scripts/scan-scope.ts 文件头。 */
import { shouldSkipDir } from './scan-scope.ts';
const SKIP = { test: (n: string): boolean => shouldSkipDir(n) };

/** 收集全部生产 `.ts`(server/ · client/ · shared/,与 `scripts/ts-paths.ts` 的 `isProd` 同口径) */
const walkProd = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walkProd(join(dir, e.name), out); continue; }
    if (!e.isFile() || !e.name.endsWith('.ts')) continue;
    const rel = relative(ROOT, join(dir, e.name)).split('\\').join('/');
    if (/^(server|client|shared)\//.test(rel)) out.push(join(dir, e.name));
  }
  return out;
};

interface Decl { file: string; line: number; name: string; kind: string }
const byName = new Map<string, Decl[]>();

/* ★★ 关键:声明必须在**剥掉注释的文本**上找,不能用 `git grep`。
 *
 * 我第一版用 `git grep -n '^export ...'`,而 `scripts/judgement_audit.ts` 的 D 检测器
 * **抓到过我两次**,两次它都对:
 * ```
 * git grep 的模式是行首锚定 `^export`,但**块注释里的行也可以以 export 开头**:
 *     块注释起始标记
 *     export const X = 1;        ← 行首就是 export ⇒ git grep 照样报出来
 *     块注释结束标记
 * ⇒ 我把**被注释掉的导出**当成真声明 ⇒ 凭空多出一个"同名导出",整份清单被污染
 * ```
 * 我第一次的"修法"是在 grep 输出行上判"这行像不像注释"(跳过 `*` / `//` / 注释起始标记)——
 * **那治不了块注释中间的行**,因为它在输出里长得和真代码一模一样。
 * ⇒ 判据:**判据必须在"剥掉注释的文本"上运行**;在"可能带注释的原文"上运行,
 *   再怎么加行首判断都只是打补丁(陷阱 42 的老规矩)。
 * ⇒ 所以改成:自己在**剥注释后的源码**上逐行找声明。
 */
export const stripCommentsKeepStrings = (src: string): string => {
  let out = '';
  let i = 0;
  const n = src.length;
  type S = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let s: S = 'code';
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (s === 'code') {
      if (c === '/' && c2 === '/') { s = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { s = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { s = 'sq'; out += c; i += 1; continue; }
      if (c === '"') { s = 'dq'; out += c; i += 1; continue; }
      if (c === '`') { s = 'tpl'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (s === 'line') {
      if (c === '\n') { s = 'code'; out += c; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (s === 'block') {
      if (c === '*' && c2 === '/') { s = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';   /* 保留换行,行号不漂 */
      i += 1; continue;
    }
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
    if ((s === 'sq' && c === "'") || (s === 'dq' && c === '"') || (s === 'tpl' && c === '`')) s = 'code';
    out += c; i += 1;
  }
  return out;
};

const DECL_RE = /^export (const|function|interface|type|class) (\w+)/;

for (const abs of walkProd(ROOT)) {
  const rel = relative(ROOT, abs).split('\\').join('/');
  /* 与旧版一致:排除 tests/ 与 scripts/(它们在 walkProd 里已不可能出现,保留双保险) */
  if (rel.startsWith('tests/') || rel.startsWith('scripts/')) continue;

  /* ★ 在**剥注释后**的文本上找声明 —— 行号与原文一一对应(剥注释保留了换行) */
  const stripped = stripCommentsKeepStrings(readFileSync(abs, 'utf8'));
  stripped.split('\n').forEach((ln, i) => {
    const m = DECL_RE.exec(ln);
    if (m === null) return;
    const list = byName.get(m[2]!) ?? [];
    list.push({ file: rel, line: i + 1, name: m[2]!, kind: m[1]! });
    byName.set(m[2]!, list);
  });
}

/** 取从 startLine 起、按花括号/圆括号配平的整段声明文本 */
const declText = (file: string, startLine: number, kind: string): string => {
  const L = readFileSync(file, 'utf8').split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let sawOpen = false;
  for (let i = startLine - 1; i < L.length && i < startLine + 120; i++) {
    const ln = L[i]!;
    out.push(ln);
    for (const ch of ln) {
      if ('{([<'.includes(ch)) { depth += 1; sawOpen = true; }
      else if ('})]>'.includes(ch)) depth -= 1;
    }
    if (i === startLine - 1) {
      /* 单行声明:立即收口 */
      if (kind === 'const' || kind === 'type') {
        if (depth <= 0 && /;\s*(\/\/.*)?$/.test(ln)) return ln.trim();
        if (depth <= 0 && i === startLine - 1) return ln.trim();
      }
      if (!sawOpen && (kind === 'const' || kind === 'type')) return ln.trim();
    }
    if (sawOpen && depth <= 0) break;
  }
  return out.join('\n');
};


/** 归一到「内容签名」:去注释、压空白。
 *
 * ⚠️ 这里必须用**状态机**剥,不能用朴素的「正则删两个斜杠到行尾」写法:
 * 后者会把 `const U = 'https://x'` 里的 URL 片段当注释 ⇒ 内容签名被截断
 * ⇒ 两个本应"内容不同"的常量被判成"相同"(**漏报**)。
 * `scripts/judgement_audit.ts` 的 B 检测器抓过我第一版,而**它是真缺陷**。
 *
 * ⚠️ TODO(本文件已踩):本段注释里**不能**出现"星号紧跟斜杠"的字样 ——
 * 那会提前关闭本注释块(实测把整份文件的语法搞坏)。故此处只做文字描述。
 */
const contentSig = (text: string): string => stripCommentsKeepStrings(text)
  .replace(/\s+/g, ' ')
  .trim();

/** interface:只取字段名与类型(顺序敏感) */
const fieldSig = (text: string): string => {
  const body = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'));
  return body.split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z_$][\w$]*\??\s*:/.test(x))
    .map((x) => x.replace(/\s+/g, ' ').replace(/[,;]\s*$/, ''))
    .join(' | ');
};

const rows: string[] = [];
let sameCount = 0;
let diffCount = 0;
const kindMismatch: string[] = [];

for (const [name, decls] of byName) {
  const files = [...new Set(decls.map((d) => d.file))];
  if (files.length < 2) continue;

  const ks = [...new Set(decls.map((d) => d.kind))];
  if (ks.length > 1) { kindMismatch.push(`${name}  [${ks.join('+')}]`); continue; }

  const kind = ks[0]!;
  if (!['const', 'interface', 'type'].includes(kind)) continue;

  const sigs = decls.map((d) => {
    const t = declText(d.file, d.line, kind);
    return kind === 'interface' ? fieldSig(t) : contentSig(t);
  });

  const allSame = sigs.every((s) => s === sigs[0]);
  if (allSame) { sameCount += 1; continue; }

  diffCount += 1;
  rows.push(`\n★★ ${name}   [${kind}]  —— 内容**不同**`);
  decls.forEach((d, i) => {
    rows.push(`     ${d.file}:${d.line}`);
    rows.push(`        ${(sigs[i] ?? '').slice(0, 210)}`);
  });
}

console.log('══ 同名导出:内容对比(生产 .ts,排除 tests/ 与 scripts/)══');
/* ⚠️ 本仓第 4 次踩"定界符字符"坑,记为一条纪律:
 *    注释块与字符串里,**凡是"星号紧跟斜杠"的写法都是地雷** ——
 *    两个字符连起来正好是"注释块结束"标记,会让注释提前关闭、后面的中文变成代码。
 *    方向还有另一种:斜杠紧跟星号 = "注释块开始",在**模板字面量**里出现会把
 *    其后整段当成注释,报 "Expected ';', '}' or <eof>"。
 *    ⇒ 处置:强调标记一律用「」(中文书名号)或普通文字,**永不在强调里贴斜杠**。
 *    ⇒ 这不是"下次小心":本文件自己就因此坏过两次,而两次我都在**修上一个坑**时犯的。 */
console.log(`   内容签名相同 : ${sameCount} 个  —— 低优先(再导出 or 真重复但未漂移)`);
console.log(`   内容**不同**     : ${diffCount} 个  —— ★ 需人判(漂移 or 真是两件事)`);
console.log(`   体裁不同        : ${kindMismatch.length} 个  —— 低优先(名字撞车)`);
console.log(`     ${kindMismatch.slice(0, 14).join(' / ')}`);

console.log('\n══ ★ 内容不同的全部条目(逐条,按文件+行号)══');
if (rows.length === 0) console.log('   (无)');
for (const r of rows) console.log(r);

console.log(`
\n══ ★ 为什么这些值得一条条看 ══
   本仓已确认的同型真缺陷就落在这个集合里:
     · \`rtOpts\` —— 两处字面量,ownerId 来源字段漂移(registryOwnerId vs ownerId)
       ⚠️ **2026-11-14 订正:这一条已修,不再是活缺陷**
         task-76 已把 \`registryOwnerId\` 改名为 \`ownerId\`(两处现在都是 \`ownerId\`);
         \`tests/WS-FND-12-wiring-paths.test.ts\` 的 **FND12-6** 已加断言守住它。
         ★ Lead 实测该断言**有牙**:把 \`room.colyseus.ts:190\` 改回 \`registryOwnerId\`
           ⇒ exit 0→1(FND12-6 指名报错);还原 SHA-256 逐字节一致 ⇒ exit 1→0。
       ⇒ ⇒ 但它仍是**本清单最该保留的样本**:它证明「名字相同、体裁相同、内容不同」
           这个集合里**真的**藏过缺陷 —— 清单的价值不在于当前命中,而在于它已两次命中。
       ⚠ 教训(与陷阱 122「改理由文本会改门禁数字」同族):
         **这段说明文字本身会过期,而没有任何门禁查它。**
         它先前把一条已修好的缺陷说成活缺陷 ⇒ 读者会去追一条不存在的线。
     · \`Clock\` —— 两处接口,一个 \`now()\` 秒、一个 \`nowMs()\` 毫秒
       ⚠️ **2026-11-14 订正定性:不是缺陷,是「检查存在于语言层、被运行时擦除」**
         两者方法名不同(now vs nowMs)⇒ 结构类型上**互相不可赋值** ⇒ TypeScript **会**拦。
         我实测注入一个故意的混用(\`wantsMs(secClock)\`)⇒ \`node scripts/typecheck.ts\`
         报 **TS2345**;而 \`verify.ts --all\` **完全没提类型不匹配**(只发现多了一个文件)。
         ⇒ 即:真实缺口**不是**这两个接口,是**缺一个类型检查步骤** ——
           已于 2026-11-14 以「类型检查基线锁」补上(见 \`typecheck-baseline-audit.ts\`)。
   ⇒ 两者都是"名字相同、体裁相同、内容不同"。
   ⇒ ⇒ 所以本清单**不是猜** —— 它的前几个成员已被验证**值得读**。
     剩下的每一条都值得人读一眼:要么是真漂移,要么该在注释里写清"这是两件事"。
`);