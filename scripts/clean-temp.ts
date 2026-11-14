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
 * node scripts/clean-temp.ts                 # 列出并删除(仓库根 + 扫描根内)
 * node scripts/clean-temp.ts --dry-run       # 只列不删
 * node scripts/clean-temp.ts --keep=_t84     # ★ 保留某前缀(可重复);删除其余
 * node scripts/clean-temp.ts --force         # ★ 超过安全阈值时才可删
 * ```
 *
 * ## ★★★ 2026-11-14 加两道保险(起因是一次实测的**危险**)
 *
 * 实测:8 人并行作业时,裸跑本器件会一次删掉 **342 个**根级残留,
 * 其中 **205 个不是跑它的人的** —— 别人的探针里有些是**刻意保留的实物证据**
 * (如"两版有缺陷的探针",用来记录"探针自己会坏")。
 * ⇒ 本器件的匹配规则写着「按名字匹配就永远会命中不该命中的东西」(见下 `_vss_restore` 那段),
 *   而它此前只有**跳过目录**这一种表达"不该删"的能力,**没有表达"这个文件要留"的能力**。
 * ⇒ 补两道:
 *   1 `--keep=<前缀>`(可重复)⇒ 显式保留。**这是"不该删"的正确表达方式**
 *      (跳过目录表达的是"这里没有残留",保留前缀表达的是"这是有意的产物")。
 *   2 **安全阈值**:一次要删 > 40 个时**必须显式 `--force`**,否则拒绝执行并说明原因。
 *      理由:单次作业的正常残留量是个位数到十几个;
 *      一次 300+ 意味着"这不是残留,是整个车队的产物" ⇒ 该由人决定。
 *
 * ⚠️ 为什么阈值不用"字节数"而用"文件个数":实测 342 个只占 2501.5 KB
 *    (`_vss_restore` 的 44.3 MB 才是大头,而它已被跳过)
 *    ⇒ **按字节设阈值会漏掉这种"很多小文件"的危险**,而它恰恰是并行作业的典型形态。
 *
 * ⚠️ **匹配规则是刻意保守的**:文件名以 `_` 开头 + 常见文本扩展名。
 * 不动 `_design/` `_shots/` `_cdp_profile/`(它们是**目录**,不是残留)。
 * ⇒ 宁可漏掉一个奇怪命名的残留,也不误删正经文件。
 *
 * ⚠️ `_vss_restore/` 也**必须跳过**:那是 2026-11-13 一次误删事故后
 * 从 VSS 卷影副本抢救出来的 **188 个外部文件**(非本仓产物,44.3 MB,
 * 含三个大数据文件)。它的名字以 `_` 开头、内容是 `.ts/.txt` ⇒
 * **恰好落进 TEMP_NAME 规则** ⇒ 若不跳过,`clean-temp` 会把抢救区当残留删掉。
 * ⇒ ★ 这是「清理工具误伤数据」的同一形态第二次出现:匹配规则越保守越安全,
 *   但**只要它按名字匹配,就永远会命中不该命中的东西** ——
 *   故新增任何"抢救/备份"目录时,都要同步加进这里。
 */
import { readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldSkipDir } from './scan-scope.ts';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
/** ★ 显式保留前缀,`--keep=_t84 --keep=_tp91`。可重复。 */
const KEEP = process.argv.filter((a) => a.startsWith('--keep=')).map((a) => a.slice('--keep='.length));
/** ★ 安全阈值:单次删除超过这个数就必须 `--force`(理由见文件头)。 */
const MAX_SILENT = 40;
/* ★ 2026-11-14(接手者):原本这里是**第二份跳过清单**,而注释自己写着
   「与 verify.ts 的 checkTempResidue 保持同一份规则 —— 改一处要改两处」(CR-20 的形态)。
   ⇒ 那份副本已删除:跳过规则改由 `scripts/scan-scope.ts` 唯一提供。
   ⚠️ 本器件是**破坏性工具** ⇒ 变更方向必须**只缩小删除范围**:
      新集合是旧集合的**超集**(新增的 `dist` / `out` / `coverage` / `release` 在根下实测都不存在,
      `_probe_sandbox` 旧表本就有)⇒ **不会让任何此前被保留的文件变成待删**。 */
const SCAN_ROOTS = ['scripts', 'tests', 'server', 'client', 'shared'];
const TEMP_NAME = /^_.*\.(ts|js|mjs|txt|md|log|json)$/;

interface Hit { rel: string; abs: string; size: number; inAuditRoot: boolean; head: string }

const hits: Hit[] = [];
const walk = (dir: string, rel: string): void => {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    if (shouldSkipDir(n)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walk(abs, r); continue; }
    if (!TEMP_NAME.test(n)) continue;
    /* ★ 显式保留:`--keep=<前缀>` 命中 ⇒ **既不列也不删**(它是有意产物,不是残留) */
    if (KEEP.some((p) => p.length > 0 && n.startsWith(p))) continue;
    let head = '';
    try { head = readFileSync(abs, 'utf8').split('\n').find((l) => l.trim())?.slice(0, 66) ?? ''; } catch { /* 二进制 */ }
    hits.push({ rel: r, abs, size: st.size, inAuditRoot: SCAN_ROOTS.some((x) => r.startsWith(`${x}/`)), head });
  }
};
walk(ROOT, '');

console.log(`\n[临时残留清理]${DRY ? ' (--dry-run,不删)' : ''}`);
if (KEEP.length > 0) console.log(`  保留前缀:${KEEP.join(', ')}(这些**不列不删**)`);
if (hits.length === 0) {
  console.log('  ✓ 无残留');
  process.exit(0);
}

/* ★★ 安全阈值:一次删太多 ⇒ 拒绝,除非 --force。
   理由:正常单次作业的残留量是个位数到十几个;一次 300+ 意味着
   "这不是残留,是整个车队的产物" ⇒ 该由人决定,不该由工具静默决定。 */
if (!DRY && !FORCE && hits.length > MAX_SILENT) {
  console.error('');
  console.error(`  ✗✗ 拒绝执行:本次将删除 **${hits.length}** 个,超过安全阈值 ${MAX_SILENT}。`);
  console.error('     这通常意味着"这不是你的残留,是其他人的在途产物" —— 实测一次 342 个里 205 个不是本次作业者的。');
  console.error('     ⇒ 若确实要删,请二选一:');
  console.error('        · 只删你自己的:  node scripts/clean-temp.ts --keep=<别人的前缀> …');
  console.error('        · 确认要全删:    node scripts/clean-temp.ts --force');
  console.error('     (先用 --dry-run 看清清单。**本器件此前没有这道闸,一次能清掉全车队**。)');
  process.exit(2);
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
    if (shouldSkipDir(n)) continue;
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
