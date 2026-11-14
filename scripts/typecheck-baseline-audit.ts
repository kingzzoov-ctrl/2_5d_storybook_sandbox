/**
 * 类型检查**基线锁**。
 *
 * ## 为什么需要它(而不是"把 tsc 接进门禁")
 *
 * `scripts/typecheck.ts` 能跑、结果确定(三次连跑 267 条)、且**真能抓类型错误**
 * (实测:注入一个"把秒时钟传给要毫秒时钟的函数"⇒ TS2345)。
 * 但源码 `verify.ts:2972` 已写明为什么不直接拿它当门禁:
 * ```
 *   tsc ⇒ exit 2,既有错误一片 ⇒ 拿它当门禁 = 一个永远红的门 ⇒ 没人会看它。
 * ```
 * ⇒ 那个取舍**是对的**,"永远红的门"与"没有门"在效果上等价。
 *
 * ★ 但"恒红 ⇒ 不接"漏掉了第三条路:**冻结基线**。
 *   267 条**稳定**(实测 3/3 同)⇒ 它**可以做基线**。
 *   于是判据变成「**错误不增加**」而不是「零错误」——
 *   这与本仓既有的 `content-lock`(内容基线锁)是**同一个思路**。
 *
 * ## 判据的形态
 *
 * ```
 *   错误数 > 基线                      ⇒ **红**(有人引入了新错误)
 *   出现基线里没有的**指纹**            ⇒ **红**(哪怕总数没涨)
 *   错误数 < 基线                      ⇒ **告警**(变好了,该更新基线)
 *   typescript 未安装                  ⇒ **跳过并说明**(本仓默认零依赖,不是缺陷)
 * ```
 *
 * ### ★★ 为什么必须比"指纹"而不只是比"总数"
 * ```
 * 只比总数的话:**修掉 1 条 + 新引入 1 条 ⇒ 总数不变 ⇒ 静默通过**。
 * 这是本仓反复出现的"净额掩盖"(陷阱:差一个正一个)。
 * ⇒ 所以用**指纹多重集**比对:每个指纹带重数,新增/消失都各自报出来。
 * ```
 *
 * ### ★★★ 为什么指纹里**不含行号**
 * ```
 * 行号**(line,col)**在指纹里会让基线**极度脆**:
 *   在某个旧错误上方插入一行 ⇒ 它所有后继错误行号 +1
 *   ⇒ 表现为「267 条全部消失 + 267 条全新」⇒ 基线天天误报。
 * ⇒ 指纹取 `文件 | 错误码 | 归一化消息`,**不带行列**。
 *   代价:同一文件里两条**同码同消息**的错误无法区分 —— 故用**重数**补偿。
 * ★ 而这不是我推理出来的取舍,是**测出来的必要性**:本脚本第一版用
 *   `file(line,col): code` 做指纹,对工作区做一次无关的插行即报"267 新增"。
 * ```
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = join(ROOT, 'scripts', 'typecheck-baseline.json');
const tscJs = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

export interface TypecheckError { file: string; code: string; msg: string; fingerprint: string }

/** 把绝对路径与行号从消息里抹掉 —— 否则同一错误在不同机器/不同行号下指纹不同。 */
function normalizeMsg(msg: string): string {
  return msg
    /* 绝对路径(Windows 与 POSIX 两种形态) */
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<PATH>')
    .replace(/(?<![\w.])\.{0,2}\/[^\s'"]*/g, '<PATH>')
    /* 数字字面量(行号/列号常出现在消息里) */
    .replace(/\b\d+\b/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 跑 tsc 并返回错误列表。未装 typescript 时返回 `null`(调用方应跳过而非报红)。
 *
 * ★★ `spawnSync` 的返回值必须**读全** —— 本仓踩过「跑了子进程但没看退出码 ⇒ 门禁恒绿」
 *    (judgement_audit 的 F 类检测器)。而这里有一个**更细**的陷阱:
 *    ```
 *      tsc 找到类型错误时 **exit 2** ⇒ 所以**不能**用 status !== 0 判"失败"
 *      但 spawn 自身失败(tsc 崩了/被杀/ENOENT)**也**表现为 stdout 空
 *      ⇒ 只读 stdout 的话,这两种情况**完全同形**:
 *          · "没有类型错误" ⇒ 0 条
 *          · "tsc 根本没跑起来" ⇒ 也 0 条 ⇒ **基线锁静默通过**
 *    ⇒ 所以必须读 `r.error`(spawn 层错误)与 `r.signal`,并在**两者任一存在时抛错**,
 *      而不是返回空数组。**"查不出来"绝不许伪装成"没有错误"**。 */
export function runTsc(): TypecheckError[] | null {
  if (!existsSync(tscJs)) return null;
  const r = spawnSync(process.execPath, [tscJs, '-p', join(ROOT, 'tsconfig.json'), '--noEmit'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
  });
  /* ① spawn 层失败(ENOENT / EACCES / OOM 等)⇒ 抛错,不许当成"0 条错误" */
  if (r.error !== undefined && r.error !== null) {
    throw new Error(`tsc 无法启动:${r.error.message} ⇒ 基线锁不能据此判定通过`);
  }
  /* ② 被信号杀掉 ⇒ 同样是"查不出来",抛错 */
  if (r.signal !== null && r.signal !== undefined) {
    throw new Error(`tsc 被信号 ${String(r.signal)} 终止 ⇒ 基线锁不能据此判定通过`);
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const errs: TypecheckError[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (m === null) continue;
    const file = m[1]!.trim().split('\\').join('/');
    const code = m[4]!;
    const msg = m[5]!;
    errs.push({ file, code, msg, fingerprint: `${file}|${code}|${normalizeMsg(msg)}` });
  }
  return errs;
}

/** 多重集:指纹 → 出现次数 */
export function toMultiset(errs: readonly TypecheckError[]): Record<string, number> {
  const ms: Record<string, number> = {};
  for (const e of errs) ms[e.fingerprint] = (ms[e.fingerprint] ?? 0) + 1;
  return ms;
}

const args = process.argv.slice(2);

if (args.includes('--update')) {
  const errs = runTsc();
  if (errs === null) {
    console.log('[typecheck-baseline] 跳过:未安装 typescript —— 基线未更新。');
    process.exit(0);
  }
  const ms = toMultiset(errs);
  const payload = {
    _readme: '类型检查基线:指纹 | 错误码 | 归一化消息(**不含行号**)。'
      + '判据见 scripts/typecheck-baseline-audit.ts 顶部注释。'
      + '更新方式:node scripts/typecheck-baseline-audit.ts --update',
    generated: new Date().toISOString().slice(0, 10),
    total: errs.length,
    fingerprints: ms,
  };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[typecheck-baseline] 已写入 ${BASELINE}`);
  console.log(`  总错误 ${errs.length} 条;唯一指纹 ${Object.keys(ms).length} 个`);
  process.exit(0);
}

/* 默认:比对 */
if (!existsSync(BASELINE)) {
  console.log('[typecheck-baseline] 基线文件不存在 ⇒ 跳过。首次建立:--update');
  process.exit(0);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as { total: number; fingerprints: Record<string, number> };
let cur: TypecheckError[] | null;
try {
  cur = runTsc();
} catch (e) {
  /* ★ "查不出来"必须**红**,不许静默通过 —— 见 runTsc 顶部注释。 */
  console.log(`\n[类型检查基线锁]\n  ✗ 无法取得类型检查结果:${(e as Error).message}`);
  process.exit(1);
}
if (cur === null) {
  console.log('[typecheck-baseline] 跳过:未安装 typescript(本仓默认零依赖 ⇒ 不是缺陷)。');
  process.exit(0);
}
const curMs = toMultiset(cur);

const added: [string, number][] = [];
const removed: [string, number][] = [];
for (const [k, n] of Object.entries(curMs)) {
  const b = base.fingerprints[k] ?? 0;
  if (n > b) added.push([k, n - b]);
}
for (const [k, n] of Object.entries(base.fingerprints)) {
  const c = curMs[k] ?? 0;
  if (c < n) removed.push([k, n - c]);
}

console.log('\n[类型检查基线锁]');
console.log(`  基线 ${base.total} 条 / 实测 ${cur.length} 条;唯一指纹 基线 ${Object.keys(base.fingerprints).length} / 实测 ${Object.keys(curMs).length}`);

if (added.length > 0) {
  console.log(`  ✗ **新增/增多的类型错误 ${added.reduce((s, [, n]) => s + n, 0)} 条**(基线里没有或更少):`);
  for (const [k, n] of added.slice(0, 12)) {
    const [file, code, msg] = k.split('|');
    console.log(`      +${n}  ${file}  ${code}  ${(msg ?? '').slice(0, 68)}`);
  }
  if (added.length > 12) console.log(`      …另有 ${added.length - 12} 个指纹(共 ${added.length})`);
  process.exit(1);
}

if (removed.length > 0) {
  const n = removed.reduce((s, [, v]) => s + v, 0);
  console.log(`  ⚠ 已修掉 ${n} 条(比基线好)⇒ 建议更新基线:node scripts/typecheck-baseline-audit.ts --update`);
  for (const [k, v] of removed.slice(0, 6)) {
    const [file, code] = k.split('|');
    console.log(`      -${v}  ${file}  ${code}`);
  }
}
console.log(`  ✓ 类型错误未增加(≤ 基线 ${base.total})`);
process.exit(0);
