/**
 * 清理临时探针残留。
 *
 * ## 为什么需要它
 *
 * `.gitignore` 第 37 行是 `_*` ⇒ **临时文件被 git 结构性忽略**
 * ⇒ `git status --porcelain` **看不见它们**
 * ⇒ 而全仓判断「工作区干净」**用的正是那条命令**。
 *
 * 实测(2026-11-13):清点出 **25 个**残留、**111.1 KB**,
 * 最老的跨了 **1 小时 20 分** —— 它的作者以为早删了。
 *
 * ## 为什么它们不只是"脏"
 *
 * ```
 * verify.ts 的「判据形态审计」扫描根 =
 *   ['scripts', 'tests', 'server/src', 'client/src', 'shared']
 * ⇒ 残留落在这些根**之内**时,会**污染那道门禁**造成假红
 *   (实例:`scripts/_cp_strip.ts` 曾被报成「新增 1 处」)
 * ⇒ 假红比脏更坏:它让人开始**忽略那条失败** ⇒ 门禁失效(狼来了)
 * ⇒ 落在根**之外**(仓库根)的只脏、不破坏判据 —— **两者要分开报**
 * ```
 *
 * ## 用法
 *
 * ```
 * node scripts/clean-temp.ts            # 列出并删除(仓库根 + 扫描根内)
 * node scripts/clean-temp.ts --dry-run  # 只列不删
 * ```
 *
 * ⚠️ **匹配规则是刻意保守的**:文件名以 `_` 开头 + 常见文本扩展名。
 * 不动 `_design/` `_shots/` `_cdp_profile/`(它们是**目录**,不是残留)。
 * ⇒ 宁可漏掉一个奇怪命名的残留,也不误删正经文件。
 */
import { readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry-run');
/** 与 verify.ts 的 checkTempResidue 保持**同一份规则** —— 改一处要改两处(CR-20 的形态)。 */
const SCAN_ROOTS = ['scripts', 'tests', 'server', 'client', 'shared'];
const SKIP_DIR = /^(node_modules|_design|_shots|_cdp_profile|\.git)$/;
const TEMP_NAME = /^_.*\.(ts|js|mjs|txt|md|log|json)$/;

interface Hit { rel: string; abs: string; size: number; inAuditRoot: boolean; head: string }

const hits: Hit[] = [];
const walk = (dir: string, rel: string): void => {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    if (SKIP_DIR.test(n)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walk(abs, r); continue; }
    if (!TEMP_NAME.test(n)) continue;
    let head = '';
    try { head = readFileSync(abs, 'utf8').split('\n').find((l) => l.trim())?.slice(0, 66) ?? ''; } catch { /* 二进制 */ }
    hits.push({ rel: r, abs, size: st.size, inAuditRoot: SCAN_ROOTS.some((x) => r.startsWith(`${x}/`)), head });
  }
};
walk(ROOT, '');

console.log(`\n[临时残留清理]${DRY ? ' (--dry-run,不删)' : ''}`);
if (hits.length === 0) {
  console.log('  ✓ 无残留');
  process.exit(0);
}

const bytes = hits.reduce((a, h) => a + h.size, 0);
const inRoot = hits.filter((h) => h.inAuditRoot);
const outRoot = hits.filter((h) => !h.inAuditRoot);
console.log(`  合计 ${hits.length} 个 / ${(bytes / 1024).toFixed(1)} KB`);
console.log(`    ★ 落在审计扫描根内 ${inRoot.length} 个 ⇒ **会污染判据形态审计(假红)**
    · 只在仓库根          ${outRoot.length} 个 ⇒ 只脏,不破坏判据`);

/* ★ 按首行注释里的 task 号归类 —— 让每个残留**有归属**,便于追责与自查 */
const byTask = new Map<string, Hit[]>();
for (const h of hits) {
  const m = h.head.match(/task-(\d+)/i);
  const k = m ? `task-${m[1]}` : '(无 task 标记)';
  if (!byTask.has(k)) byTask.set(k, []);
  byTask.get(k)!.push(h);
}
console.log('  ── 归属 ──');
for (const [k, v] of [...byTask].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${k.padEnd(16)} ${String(v.length).padStart(2)} 个`);
}

console.log('  ── 清单 ──');
for (const h of hits) {
  console.log(`    ${h.inAuditRoot ? '★' : ' '} ${h.rel.padEnd(30)} ${String(h.size).padStart(6)}B`);
}

if (DRY) {
  console.log('\n  (--dry-run:未删除)');
  process.exit(0);
}

let removed = 0;
for (const h of hits) {
  try { rmSync(h.abs, { force: true }); removed += 1; } catch (e) {
    console.error(`    ✗ 删除失败 ${h.rel}: ${String(e).slice(0, 60)}`);
  }
}
/* ★ 自证:重新走一遍,必须为 0 —— 不靠"我删过了"这句话 */
const recheck: string[] = [];
const walk2 = (dir: string, rel: string): void => {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    if (SKIP_DIR.test(n)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walk2(abs, r); continue; }
    if (TEMP_NAME.test(n)) recheck.push(r);
  }
};
walk2(ROOT, '');
console.log(`\n  已删 ${removed} 个`);
console.log(`  复验:残留 ${recheck.length} 个 ${recheck.length === 0 ? '✓' : `✗✗ ${recheck.join(', ')}`}`);
console.log('  ⚠️ 下一步跑 `node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert`');
console.log('     若判据形态审计从红转绿 ⇒ 证实残留**确实**在污染它');
process.exit(recheck.length === 0 ? 0 : 1);
