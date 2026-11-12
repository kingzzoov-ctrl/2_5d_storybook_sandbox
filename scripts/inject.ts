/**
 * 故障注入器 —— **可复用**的「改一处 → 看是否真的变红 → 逐字节还原」工具(task-61)。
 *
 * ## 为什么需要它
 *
 * 「断言有没有牙」不能靠读代码判断,必须**真的把被测代码弄坏一次**,看断言会不会红。
 * 但手写注入器极易自伤。我在 task-57 里为此付出过代价,踩到的坑全部固化在本文件里:
 *
 * ```
 * 坑 1  清理函数杀掉自己            用「CPU < 5s 全杀」⇒ 把自己的注入脚本杀了
 *                                   ⇒ 表现为「基线打完就 exit 1」,误导排查方向
 * 坑 2  CRLF 锚点静默不命中          文件是 CRLF,锚点只写 \n ⇒ replace 命中 0 次
 *                                   ⇒ **无变化但无报错** ⇒ 后续读成「注入无效/不红」
 * 坑 3  超时/崩溃被当成「不红」      注入把文件切成语法坏 ⇒ 测试跑不起来 ⇒ 打印 0 条
 *                                   ⇒ 我一度读成「这条断言不红」
 * 坑 4  进程爆炸                     注入制造了模块循环依赖(测试→verify→测试)
 *                                   ⇒ **无限 fork,122 个 node 进程**,超时拦不住
 * ```
 *
 * ## 四条铁律(实现见下)
 *
 * ```
 * ① 每次注入必须有 **no-change 硬断言**:替换前后字符串必须**真的不同**
 * ② 每次跑测试必须有 **硬超时 + SIGKILL**,且超时/被杀 ⇒ 判定为「注入无效」而非「不红」
 * ③ 清理只杀**子树**里的进程(排除自身与祖先),且**不按 CPU 猜**
 * ④ 支持 **进程树深度上限**:子进程环境变量带深度,超限直接拒绝再派生
 * ```
 *
 * ## 用法
 *
 * ```ts
 * import { runInjections } from './inject.ts';
 *
 * await runInjections({
 *   target: 'server/src/index.ts',
 *   suite: 'tests/WS-FND-09-wiring.test.ts',
 *   markerRe: /✗[^\n]*?FND9-(\d+)/g,
 *   idPrefix: 'FND9-',
 *   cases: [
 *     { id: 'J1', desc: '...', find: '    host,\n', replace: '    host: null,\n',
 *       expect: ['FND9-3', 'FND9-5'] },
 *   ],
 * });
 * ```
 *
 * 直接执行 `node scripts/inject.ts --selftest` 会跑一组**自检注入**,
 * 验证本工具本身的能力(而不是验证业务代码)。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ════════════ 坑 4:进程树深度上限(防无限 fork)════════════ */

/**
 * 子进程派生深度。
 *
 * 注入一旦制造了模块循环依赖(`测试 → 门禁 → 测试`),就会无限 fork。
 * **超时拦不住** —— 每一层都还在超时之前,但每层都在派生子进程。
 * ⇒ 唯一可靠的闸是**深度**:环境变量随派生递增,超过上限直接拒绝。
 *
 * ⚠️ 本工具**自己**派生子进程时会把 `INJECT_DEPTH+1` 放进 env;
 * 被测代码若也派生,就会继承并累加。达到上限时本工具拒绝执行注入,
 * 而不是等系统被拖死。
 */
const DEPTH_ENV = 'DW_INJECT_DEPTH';
const MAX_DEPTH = 3;

function currentDepth(): number {
  const raw = process.env[DEPTH_ENV];
  const n = raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/* ════════════ 坑 1:进程清理(只杀子树的旁支,绝不杀自己和祖先)════════════ */

/** 取某 PID 的父 PID(Windows 用 CIM;其它平台返回 null ⇒ 不清理)。 */
function parentOf(pid: number): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
    ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const p = Number.parseInt(out, 10);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** 自身 + 全部祖先 PID —— 这些**永远不杀**。 */
function protectedPids(): Set<number> {
  const keep = new Set<number>([process.pid]);
  let p: number | null = process.pid;
  for (let i = 0; i < 12; i += 1) {
    if (p === null) break;
    p = parentOf(p);
    if (p === null || keep.has(p)) break;
    keep.add(p);
  }
  return keep;
}

/**
 * 清理**旁支**的孤儿 node 进程。
 *
 * ⚠️ 不按 CPU 猜(坑 1 就是这么杀掉自己的):判据是「启动时间晚于本次开始」
 * **且**「PID 不在自身祖先链上」**且**「命令行含本仓路径」。
 */
function reapStrays(startedAfter: number): number {
  if (process.platform !== 'win32') return 0;
  const keep = [...protectedPids()];
  const keepCond = keep.map((k) => `$_.ProcessId -ne ${k}`).join(' -and ');
  const script = [
    `$cut = [datetime]::FromFileTime(${startedAfter})`,
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" |`,
    `  Where-Object { ${keepCond} } |`,
    `  Where-Object { $_.CommandLine -like '*${ROOT.replace(/\\/g, '\\\\')}*' } |`,
    `  Where-Object { $_.CreationDate -gt $cut } |`,
    `  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
  ].join('\n');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' ? 0 : out.split('\n').filter((x) => x.trim() !== '').length;
  } catch { return 0; }
}

/* ════════════ 坑 2:CRLF 感知的文本替换 ════════════ */

type Edit = { find: string; replace: string };

/**
 * 施加替换,并**硬断言真的改变了**。
 *
 * 坑 2 的根:`find` 只写 LF,而文件是 CRLF ⇒ `replace` 命中 0 次 ⇒
 * **文件没变,但不报错**。后续测试自然全绿,于是被读成「这条断言不红」。
 * ⇒ 本函数:先在 LF 化文本上替换,**校验命中次数恰好为 1**,再按原换行风格写回。
 */
function applyEdit(raw: string, edit: Edit): { text: string; ok: boolean; why: string } {
  const crlf = raw.includes('\r\n');
  const lf = raw.replace(/\r\n/g, '\n');
  const findLf = edit.find.replace(/\r\n/g, '\n');
  const replLf = edit.replace.replace(/\r\n/g, '\n');

  const hits = lf.split(findLf).length - 1;
  if (hits !== 1) {
    return { text: raw, ok: false, why: `锚点命中 ${hits} 次(必须恰好 1 次)` };
  }
  const nextLf = lf.replace(findLf, replLf);
  if (nextLf === lf) {
    return { text: raw, ok: false, why: '替换后内容未变化(find 与 replace 等价)' };
  }
  return { text: crlf ? nextLf.replace(/\n/g, '\r\n') : nextLf, ok: true, why: 'ok' };
}

/* ════════════ 坑 3:子进程执行(硬超时 + SIGKILL + 区分「无效」与「不红」)════════════ */

type RunOutcome = {
  /** 是否被杀 / 超时 —— 这种结果**不能**用来判断断言是否变红 */
  aborted: boolean;
  abortedWhy: string;
  /** 退出码 */
  status: number | null;
  stdout: string;
  stderr: string;
  /** 从输出里提取的红项 */
  reds: string[];
};

function runSuite(suite: string, markerRe: RegExp, idPrefix: string, timeoutMs: number, depth: number): RunOutcome {
  let stdout = '';
  let stderr = '';
  let status: number | null = null;
  let aborted = false;
  let abortedWhy = '';

  try {
    stdout = execFileSync(process.execPath, [join(ROOT, suite)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [DEPTH_ENV]: String(depth) },
      maxBuffer: 32 * 1024 * 1024,
    });
    status = 0;
  } catch (e) {
    const err = e as {
      stdout?: string; stderr?: string; status?: number | null;
      killed?: boolean; signal?: string; code?: string; message?: string;
    };
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    status = typeof err.status === 'number' ? err.status : null;
    /* 坑 3 的判据:被杀 / 超时 / 无输出 —— 都不能当作「断言不红」 */
    if (err.signal === 'SIGKILL' || err.killed === true || err.code === 'ETIMEDOUT') {
      aborted = true;
      abortedWhy = '超时被杀(SIGKILL)';
    } else if (err.message !== undefined && /ETIMEDOUT|timed? ?out/i.test(err.message)) {
      aborted = true;
      abortedWhy = '超时';
    }
  }

  const all = `${stdout}${stderr}`;
  const reds = [...new Set([...all.matchAll(markerRe)].map((m) => `${idPrefix}${m[1]}`))]
    .sort((a, b) => Number(a.replace(idPrefix, '')) - Number(b.replace(idPrefix, '')));

  /* ★ 零红 + 无汇总行 ⇒ 说明测试**根本没跑起来**(语法坏/模块加载失败),
     这同样不能用来说明「断言不红」。 */
  if (!aborted && reds.length === 0) {
    const hasSummary = /\[\S+\]\s*\d+\/\d+\s*通过/.test(all) || /\d+\/\d+\s*通过/.test(all);
    const looksLikeCrash = /SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX|Cannot find module|ERR_MODULE_NOT_FOUND/.test(all);
    if (looksLikeCrash && !hasSummary) {
      aborted = true;
      abortedWhy = '测试文件自身加载失败(语法/模块错)—— 结果不可用于判断断言';
    }
  }

  return { aborted, abortedWhy, status, stdout, stderr, reds };
}

/* ════════════ 主流程 ════════════ */

export type InjectionCase = {
  /** 用例 id,只用于报告 */
  id: string;
  /** 一句说明 */
  desc: string;
  /** 原文锚点(必须恰好命中 1 次) */
  find: string;
  /** 替换成 */
  replace: string;
  /** 期望变红的断言 id 集合 —— 必须**精确匹配**(多红少红都算区分力不符) */
  expect: readonly string[];
};

export type InjectionOptions = {
  /** 被注入的文件(仓库相对路径) */
  target: string;
  /** 跑哪个测试文件 */
  suite: string;
  /** 从输出里提取红项的捕获正则,第 1 组是编号 */
  markerRe: RegExp;
  /** 断言 id 前缀,如 `FND9-` */
  idPrefix: string;
  cases: readonly InjectionCase[];
  /** 每次跑测试的硬超时,默认 120s */
  timeoutMs?: number;
};

export type InjectionReport = {
  /** 基线是否干净(必须,否则结论不可信) */
  baselineClean: boolean;
  baselineReds: string[];
  rows: {
    id: string;
    desc: string;
    verdict: 'ok' | 'mismatch' | 'ineffective' | 'aborted';
    actual: string[];
    expect: readonly string[];
    detail: string;
  }[];
  /** SHA-256 还原核对 */
  restored: boolean;
  shaBefore: string;
  shaAfter: string;
  /** 清理掉的旁支进程数 */
  reaped: number;
};

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();

export function runInjections(opts: InjectionOptions): InjectionReport {
  const depth = currentDepth();
  const targetAbs = resolve(ROOT, opts.target);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const startedAfter = Date.now() - 60_000; /* 给一点回溯余量 */

  if (!existsSync(targetAbs)) {
    throw new Error(`注入目标不存在:${opts.target}`);
  }
  /* ★ 坑 4 的闸:深度超限直接拒绝,而不是把系统拖死 */
  if (depth >= MAX_DEPTH) {
    throw new Error(`注入深度已达上限 ${MAX_DEPTH}(${DEPTH_ENV}=${depth})—— 疑似循环派生,拒绝执行`);
  }

  const original = readFileSync(targetAbs, 'utf8');
  const shaBefore = sha(targetAbs);

  /* ── 基线:必须干净 ── */
  const baseline = runSuite(opts.suite, opts.markerRe, opts.idPrefix, timeoutMs, depth + 1);
  const baselineClean = !baseline.aborted && baseline.reds.length === 0;
  if (!baselineClean) {
    return {
      baselineClean: false,
      baselineReds: baseline.reds,
      rows: [],
      restored: true,
      shaBefore,
      shaAfter: sha(targetAbs),
      reaped: 0,
    };
  }

  const rows: InjectionReport['rows'] = [];
  let reaped = 0;

  for (const c of opts.cases) {
    /* 每条前复位,避免用例互相污染 */
    writeFileSync(targetAbs, original);

    const edit = applyEdit(original, { find: c.find, replace: c.replace });
    if (!edit.ok) {
      /* 坑 2:注入**没生效**,必须显式报告为 ineffective,不能当成「不红」 */
      rows.push({
        id: c.id, desc: c.desc, verdict: 'ineffective',
        actual: [], expect: c.expect, detail: edit.why,
      });
      continue;
    }
    writeFileSync(targetAbs, edit.text);

    const run = runSuite(opts.suite, opts.markerRe, opts.idPrefix, timeoutMs, depth + 1);
    if (run.aborted) {
      reaped += reapStrays(startedAfter);
      /* 坑 3:被中断的结果**不可用** */
      rows.push({
        id: c.id, desc: c.desc, verdict: 'aborted',
        actual: run.reds, expect: c.expect, detail: run.abortedWhy,
      });
      continue;
    }

    const same = c.expect.length === run.reds.length && c.expect.every((e) => run.reds.includes(e));
    rows.push({
      id: c.id, desc: c.desc, verdict: same ? 'ok' : 'mismatch',
      actual: run.reds, expect: c.expect,
      detail: same ? '区分力精确匹配' : `多红:${run.reds.filter((r) => !c.expect.includes(r)).join(',') || '无'}; 少红:${c.expect.filter((e) => !run.reds.includes(e)).join(',') || '无'}`,
    });
  }

  /* ── 还原 + 逐字节核对 ── */
  writeFileSync(targetAbs, original);
  reaped += reapStrays(startedAfter);
  const shaAfter = sha(targetAbs);

  return { baselineClean, baselineReds: baseline.reds, rows, restored: shaBefore === shaAfter, shaBefore, shaAfter, reaped };
}

/** 把报告打成可读文本。 */
export function formatReport(r: InjectionReport): string {
  const out: string[] = [];
  out.push(`  基线:${r.baselineClean ? '✓ 干净' : `✗ 不干净(红:${r.baselineReds.join(', ') || '无'})`}`);
  if (!r.baselineClean) {
    out.push('  ⚠️ 基线不绿 ⇒ 本报告的结论**不可信**,先修基线');
    return out.join('\n');
  }
  let ok = 0;
  for (const row of r.rows) {
    const mark = row.verdict === 'ok' ? '✓' : row.verdict === 'ineffective' ? '⊘' : '✗';
    if (row.verdict === 'ok') ok += 1;
    out.push(`  ${mark} ${row.id} ${row.verdict} | 实际红=[${row.actual.join(', ') || '无'}] | 期望红=[${row.expect.join(', ') || '无'}]`);
    out.push(`      ${row.desc}`);
    if (row.verdict !== 'ok') out.push(`      **${row.detail}**`);
  }
  out.push(`  ── 结果:${ok}/${r.rows.length} 区分力精确匹配`);
  out.push(`  还原:SHA-256 ${r.shaBefore.slice(0, 16)}… → ${r.shaAfter.slice(0, 16)}… ${r.restored ? '✓ 逐字节一致' : '✗ **不一致**'}`);
  if (r.reaped > 0) out.push(`  清理旁支进程:${r.reaped} 个`);
  return out.join('\n');
}

/* ════════════ 自检:验证**本工具**而不是业务代码 ════════════ */

if (import.meta.main || process.argv.includes('--selftest')) {
  /**
   * 自检思路:对被注入文件做**已知会产生确定红项**的改动。
   * 目标是 `server/src/index.ts` + `tests/WS-FND-09-wiring.test.ts`
   * (task-57 的交付物,行为已知且稳定)。
   */
  console.log('[inject] 自检模式 —— 验证注入器本身的能力');
  console.log(`  深度:${currentDepth()} / 上限 ${MAX_DEPTH}`);

  const report = runInjections({
    target: 'server/src/index.ts',
    suite: 'tests/WS-FND-09-wiring.test.ts',
    markerRe: /✗[^\n]*?FND9-(\d+)/g,
    idPrefix: 'FND9-',
    cases: [
      {
        id: 'S1',
        desc: 'assemble() 的 host 置 null ⇒ 装配与投影相关断言必须红',
        find: '    host,\n  };',
        replace: '    host: null,\n  };',
        expect: ['FND9-3', 'FND9-5', 'FND9-6', 'FND9-10'],
      },
      {
        id: 'S2',
        desc: '锚点故意写错 ⇒ 必须报告 ineffective(不能算「不红」)',
        find: '这段文本在文件里不存在_zzz',
        replace: 'x',
        expect: ['FND9-3'],
      },
      {
        id: 'S3',
        desc: '制造语法坏 ⇒ 必须报告 aborted(不能算「不红」)',
        find: 'export function createHost(',
        replace: 'export function createHost((((',
        expect: [],
      },
    ],
  });

  console.log(formatReport(report));

  const verdicts = report.rows.map((r) => r.verdict);
  const allGood = report.baselineClean
    && verdicts[0] === 'ok'
    && verdicts[1] === 'ineffective'
    && verdicts[2] === 'aborted'
    && report.restored;
  console.log(`\n  自检结论:${allGood ? '✓ 注入器四道防线全部生效' : '✗ 有防线未生效'}`);
  console.log(`    · 区分力精确匹配(S1)= ${verdicts[0] === 'ok'}`);
  console.log(`    · 无效注入被识别(S2)= ${verdicts[1] === 'ineffective'}`);
  console.log(`    · 语法坏被识别为 aborted 而非「不红」(S3)= ${verdicts[2] === 'aborted'}`);
  console.log(`    · 逐字节还原 = ${report.restored}`);
  if (!allGood) process.exitCode = 1;
}