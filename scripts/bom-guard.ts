/**
 * ★ task-79:**把 BOM 从"我记得小心"变成"机器替我拦"**。
 *
 * 事实(陷阱 106):`Set-Content -Encoding UTF8` 在本环境写 BOM
 *   ⇒ 我用它加一行 script,就给 package.json 注入了 EF BB BF
 *   ⇒ JSON.parse 抛 `Unexpected token ''` ⇒ 门禁红在**看起来无关的** WS-07 上
 *   ⇒ 而我**在写下陷阱 106 之后,又用同一把工具犯了同一次**(本轮 `package.json` 再次中招)
 *
 * ⇒ ★ 这证明"记住纪律"不够。被判据约束的是**工具**,不是记忆。
 *   故本脚本把"不许有 BOM"做成一条**可机械校验**的规则,并接进门禁。
 *
 * 判据边界(**重要,避免过度):
 *   · 只报"**本轮新增**的 BOM" ⇒ 需与 git HEAD 比对
 *     (实测 HEAD 里本来就有 4 个带 BOM 的历史文件:
 *      server/src/mobs/{aoi,taming,geometry}.ts 与 docs/WS-05-boss-raid.md
 *      ⇒ 那是既成事实,**不在本检查范围**;报它们等于制造无授权的批量改动)
 *   · BOM 在**运行时会被吞掉**吗?不会 —— `JSON.parse` 会抛,故这是真缺陷
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '_design', '_shots', '_vss_restore', 'dist', 'build']);
const EXTS = ['.ts', '.json', '.md', '.mjs', '.cjs', '.js'];

const hasBom = (p: string): boolean => {
  const b = readFileSync(p);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) {
      out.push(join(dir, e.name));
    }
  }
  return out;
};

/** 该文件在 HEAD 里是否已有 BOM?(用来区分"历史"与"本轮引入") */
const headHasBom = (rel: string): boolean | null => {
  try {
    const b = execSync(`git cat-file blob HEAD:${rel}`, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  } catch { return null; }   /* HEAD 无此文件(新增文件) */
};

const all = walk(ROOT).filter((f) => existsSync(f) && statSync(f).isFile());
const newBoms: string[] = [];
const historic: string[] = [];

for (const f of all) {
  if (!hasBom(f)) continue;
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  const h = headHasBom(rel);
  if (h === true) historic.push(rel);
  else newBoms.push(rel);   /* HEAD 无 BOM 或文件是新增的 ⇒ 本轮引入 */
}

console.log('══ BOM 检查(只看"本轮新增")══');
console.log(`   扫描 ${all.length} 个文件;工作区带 BOM 的 ${newBoms.length + historic.length} 个`);
if (historic.length > 0) {
  console.log(`   ── 历史(HEAD 本来就有,不在本检查范围)${historic.length} 个 ──`);
  for (const f of historic) console.log(`      · ${f}`);
}
if (newBoms.length === 0) {
  console.log('   ✓ **本轮新增 BOM:0 个**');
} else {
  console.log(`   ★ **本轮新增 BOM:${newBoms.length} 个 —— 这些会让 JSON.parse 抛错**`);
  for (const f of newBoms) console.log(`      ★ ${f}`);
}

console.log(`
   ⇒ 判据:报告"本轮新增"而非"全部"。报全部会把 HEAD 里既有的 4 个
     历史文件也算进来 ⇒ 制造无授权的批量改动(陷阱 91)。
   ⇒ 修法(按全名精确剥除,不写"扫全仓剥 BOM"的脚本):
     见 docs/PROGRESS.md 陷阱 106 的处置段。
`);

if (newBoms.length > 0) process.exitCode = 1;