/**
 * 换行形态审计 —— 把"最好的状况是没人知道"变成**可查的**。
 *
 * ## 为什么需要它
 *
 * 起因是一次实测:任务书与 `scripts/inject.ts` 都断言「**本仓是 CRLF**」,
 * 而实测 **212 个纯 LF / 9 个纯 CRLF**。前提是假的,只是**没人查**。
 * ⇒ 本仓陷阱 108:「一条只存在于文档里的纪律,在换任务时失效」
 *   ⇒ 纪律必须被**工具**约束,而不是靠记。
 *
 * ## 它报什么(三档,风险递增)
 *
 *   [1] 跨文件不一致      —— 麻烦,不是陷阱;每个文件自洽即可
 *   [2] 文件内部混用      —— ★ 陷阱:同一文件两种换行并存,
 *                           按文本匹配的工具命中的是哪一份变成**非确定**
 *   [3] 带 BOM 的 UTF-8  —— 另一个"看不到的字节":
 *                           `JSON.parse` 会直接抛 `Unexpected token`
 *
 * ## 退出码
 *   默认 **0**(纯报告)。
 *   `--strict` 时 `[2]` 或 `[3]` 非空即 **exit 1**。
 *   ⚠️ 当前仓 `[3]` = 6 个 BOM ⇒ `--strict` **会红** ——
 *      这是**如实反映现状**,不是脚本坏了。故默认不开 strict;
 *      要不要开是"是否现在清"的决定,不是"检测对不对"的问题。
 *   ⇒ 判据:检测器报告**事实**;要不要动是另一个决定
 *     (陷阱 71 反面:不要为了"让它绿"把既存事实写成期望值)。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');
/* ★★★ 2026-11-14:跳过名从**唯一事实源**取,不再各写一份(详见 scan-scope.ts 文件头)。 */
import { shouldSkipDir } from './scan-scope.ts';
const SKIP = { test: (n: string): boolean => shouldSkipDir(n) };

const pureLf: string[] = [];
const pureCrlf: string[] = [];
const mixed: { p: string; crlf: number; loneLf: number }[] = [];
const bom: string[] = [];
let total = 0;

const walk = (d: string): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(join(d, e.name)); continue; }
    if (!/\.(ts|md|json|sql|yml|yaml|txt)$/.test(e.name)) continue;
    const p = join(d, e.name);
    if (statSync(p).size > 5_000_000) continue;
    total += 1;

    const b = readFileSync(p);
    const rel = relative(ROOT, p).replace(/\\/g, '/');

    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom.push(rel);

    /* 用 latin1 逐字节看,避免 UTF-8 解码把非 ASCII 掩盖掉 */
    const s = b.toString('latin1');
    const crlf = (s.match(/\r\n/g) ?? []).length;
    const allNl = (s.match(/\n/g) ?? []).length;
    const loneLf = allNl - crlf;

    if (crlf === 0 && loneLf > 0) pureLf.push(rel);
    else if (loneLf === 0 && crlf > 0) pureCrlf.push(rel);
    else if (crlf > 0 && loneLf > 0) mixed.push({ p: rel, crlf, loneLf });
  }
};
walk('.');

/* ★ 用 `git config` 读,不自己解析 .git/config:
 *   第一版我自己解析 `.git/config` 的文件文本,报出 `(未设)`,
 *   而 `git config core.autocrlf` 实测是 `true` —— 同一事实两个口径。
 *   ⇒ 直接用被验证过的工具,不自己再实现一遍(否则我就是在造第三个口径)。 */
const gitCfg = (k: string): string => {
  try { return execSync(`git config ${k}`, { encoding: 'utf8' }).trim() || '(未设)'; }
  catch { return '(未设)'; }
};

console.log('══ 换行形态审计 ══');
console.log(`   扫描 ${total} 个文件(.ts/.md/.json/.sql/.yml/.txt;`
  + '跳过 node_modules/.git/_design/_shots/_vss_restore/产物)');
console.log('');
console.log(`   [1] 纯 LF          ${pureLf.length}`);
console.log(`   [1] 纯 CRLF        ${pureCrlf.length}${pureCrlf.length > 0 ? '  <- 逐名在下方' : ''}`);
console.log(`   [2] 内部混用       ${mixed.length}   <- 最危险`);
console.log(`   [3] 带 BOM         ${bom.length}`);
console.log('');
console.log(`   git 配置:core.autocrlf = ${gitCfg('core.autocrlf')}`);
console.log(`   .gitattributes ${existsSync('.gitattributes') ? '存在' : '不存在(故无按路径的 eol 强制)'}`);
console.log('   ⚠️ core.autocrlf=true 的含义:签出时 LF->CRLF、提交时 CRLF->LF。');
console.log('      而工作区实测以 LF 为主 ⇒ 这些文件是在 autocrlf 生效之后');
console.log('      由 write/node 工具以 LF 重新写过的;git 不会反向改写工作区。');

if (pureCrlf.length > 0) {
  console.log('\n[1] 纯 CRLF 文件(逐名)');
  for (const f of pureCrlf) console.log(`   ${f}`);
}

if (mixed.length > 0) {
  console.log('\n[2] 内部混用的文件(逐名)—— 最危险');
  for (const m of mixed) console.log(`   ${m.p}   CRLF ${m.crlf} / 单独 LF ${m.loneLf}`);
  console.log('   => 同一文件两种换行并存 => 按文本匹配的工具命中的是哪一份**非确定**;');
  console.log('      且 inject.ts 的"按原风格写回"会把单独 LF 也改掉 => 超出预期改动范围。');
} else {
  console.log('\n[2] 内部混用:无 => 换行差异只存在于文件之间,不在一份文件之内');
}

if (bom.length > 0) {
  console.log('\n[3] 带 BOM 的文件(逐名)');
  for (const f of bom) console.log(`   ${f}`);
  console.log('   ⚠️ 其中 .json 会让 JSON.parse 直接抛错;.ts 会被 Node 容忍但污染首行。');
}

const bad = mixed.length + bom.length;
console.log('\n══ 结论 ══');
console.log(`   风险分级:[2]内部混用(${mixed.length}) = 陷阱;`
  + `[1]跨文件不一致(${pureCrlf.length}) = 麻烦;[3]BOM(${bom.length}) = 隐患`);
if (bad === 0) {
  console.log('   无高危项');
} else {
  console.log(`   有 ${bad} 个高危项([2]+[3])。`);
  console.log('   ⚠️ 本脚本**默认不判红** —— 这些是**既存事实**,不是本轮引入的回归。');
  console.log('      把既存事实写成"期望红"会做成墓碑(陷阱 71);');
  console.log('      正确的门禁是 `scripts/bom-guard.ts`(只拦**本轮新增**的 BOM)。');
}
console.log(`   => --strict 模式:${STRICT ? (bad > 0 ? '红(如实反映现状)' : '绿') : '(未启用;本仓有既存项,故默认关)'}`);

if (STRICT && bad > 0) process.exitCode = 1;