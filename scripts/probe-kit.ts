/* ═══════════════════════════════════════════════════════════════════════════
   临时探针/注入脚本的**共享骨架** —— 用来消灭一类**反复复发**的失败。

   ## 为什么要有这个文件(不是"整洁性",是"止损")

   2026-11-14 一次 8 人并行的作业轮里,**至少 4 名队友**在同一类问题上阵亡:
   ```
   ✗ 把 CJK 正文写进 JS 模板字符串 ⇒ 里面的反引号与 ${} 把 JS 源码本身弄坏
     (SyntaxError,而报错行号指向的是"内容",不是"代码")
   ✗ 用 PowerShell 内联 node -e 传 CJK ⇒ 编码被破坏,读到自己写的乱码
   ✗ PowerShell 重定向 (>) 写文件 ⇒ 编码/换行被改
   ✗ 用 (Get-Content)[N] 取某行 ⇒ 行号偏移 + 类型不是字符串
   ✗ Set-Content -Encoding utf8 ⇒ 悄悄写入 BOM
   ```
   ⇒ 每一次都要花掉**一整轮**才能恢复,而且恢复后往往是"换个写法再说",
     根因没变 ⇒ 下一个人再踩一次。

   ## 本文件提供什么

   1 `runSuite(file)`   —— 用 `spawnSync` 跑一个测试套件,**分别**拿 stdout/stderr。
                          ★ 关键:**失败行在 stderr,不在 stdout**(本仓实测)。
                            只 grep stdout 会得到「失败行 0 条」而套件确实红了。
   2 `sha16(file)`      —— 还原后核对用。**判"还原成功"必须用哈希,不能用 git status**
                          (本仓实测 `git status` 对未改动的文件报假 `M`)。
   3 `inject(file, from, to)` —— 注入 + **生效自检**回调 + **保证还原**。
                          用 try/finally,保证即使中途抛错也还原。
   4 `writeProbe(name, body)` —— 把探针正文写进一个 `.ts` 文件,
                          **正文里不含反引号与 `${}`** 的写法示范。
   5 `log(...)`         —— **只输出 ASCII 的**日志函数。
                          ★ 中文正文一律走 `fs.writeFileSync` 写进 .md/.txt,
                            绝不进模板字符串、绝不进命令行参数。

   ## 用法(照抄)

   ```ts
   import { runSuite, sha16, inject, log } from './scripts/_probe_kit.ts';

   const r = runSuite('tests/WS-10.test.ts');
   log('exit', r.exit, 'pass', r.pass, 'fail-lines', r.stderrFailLines.length);

   const restored = inject('server/src/combat/vitals.ts',
     'export const MAX_CRIT_DMG = 3.0;',
     'export const MAX_CRIT_DMG = 9.9;',
     () => log('selfcheck', 'MAX_CRIT_DMG should read 9.9 now'));
   log('restored-byte-identical', restored);
   ```

   ## 反面示范(**别这样写**)

   ```ts
   // ✗ 反引号 + CJK + ${} 混在一起 ⇒ 一处转义错就毁掉整个文件
   console.log(`★ 结论:${name} 已修`);

   // ✓ 改成:ASCII 日志 + 中文写文件
   log('OK', name, 'fixed');
   fs.appendFileSync('_report.txt', '★ 结论:' + name + ' 已修\n');
   ```
   ═══════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** 只输出 ASCII 的日志 —— CJK 一律不经过 console。 */
export function log(...parts: unknown[]): void {
  const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  /* 非 ASCII 一律转义成 \uXXXX,保证任何终端/代码页都不会把它写坏 */
  process.stdout.write(s.replace(/[^\x20-\x7e\n]/g, (c) => {
    const h = c.codePointAt(0)!.toString(16).padStart(4, '0');
    return '\\u' + h;
  }) + '\n');
}

/** 把中文正文安全地追加进一个文本文件 —— **不经过模板字符串,不经过命令行**。 */
export function appendCJK(file: string, text: string): void {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, prev + text, 'utf8');
}

export interface SuiteResult {
  exit: number;
  pass: number;
  total: number;
  stdout: string;
  stderr: string;
  /** ★ 失败行 —— 在 **stderr**。实测:套件红了而 stdout 只有一行「7/8 通过」。 */
  stderrFailLines: string[];
  /** 含「期望 / 实际」的行 —— 用来确认**是哪一条断言**红的,而不仅是"套件红了" */
  expectLines: string[];
}

/**
 * 跑一个测试套件。
 * ★ 必须**分别**收 stdout/stderr:本仓的 harness 把失败详情写 stderr,
 *   而汇总行(`[WS-XX] N/M 通过`)写 stdout。
 *   只 grep stdout ⇒ 你会得到「失败行 0 条」+「7/8」**同时为真**的怪现象。
 */
export function runSuite(file: string, timeoutMs = 600_000): SuiteResult {
  const r = spawnSync(process.execPath, [file], {
    encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const all = stdout + '\n' + stderr;
  /* 汇总行优先从 stdout 找,找不到再看 stderr */
  const m = /\[[^\]]+\]\s*(\d+)\/(\d+)\s*通过/.exec(all);
  const stderrFailLines = stderr.split('\n').filter((l) => /✗|失败|Error|error:/.test(l)).map((l) => l.trim()).filter(Boolean);
  return {
    exit: r.status ?? -1,
    pass: m ? parseInt(m[1]!) : -1,
    total: m ? parseInt(m[2]!) : -1,
    stdout, stderr, stderrFailLines,
    expectLines: all.split('\n').filter((l) => /期望|实际|expected|actual/.test(l)).map((l) => l.trim()),
  };
}

/** 前 16 位 SHA-256 —— 还原核对用。**别用 `git status` 判"没改"。** */
export function sha16(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
}

/**
 * 注入 ⇒ 跑自检 ⇒ **保证还原**(即使自检抛错也还原 —— 已实测)。
 * ★ `selfcheck` 在注入后、还原前调用 —— 用它**读回运行期真实取值**,
 *   证明"我以为改坏了"是真改坏(本仓已两次踩到"注入是语义 no-op")。
 * ★ 自检抛错**不吞掉**:会记进返回值的 selfcheckError,调用方必须看它。
 *   理由:「自检挂了」与「自检通过了」必须可区分 —— 否则又是"判据坏了伪装成正常"。
 * @returns { restored, selfcheckError, threw }
 */
export interface InjectResult {
  /** 还原后与注入前是否**逐字节一致** */
  restored: boolean;
  /** 注入后自检抛出的错误原文(undefined = 自检没抛) */
  selfcheckError?: string;
  /** 注入体本身是否抛错(与 selfcheckError 区分:后者是自检,前者是注入) */
  threw: boolean;
}

export function inject(
  file: string,
  from: string,
  to: string,
  selfcheck?: () => void,
): InjectResult {
  const orig = readFileSync(file);
  const before = sha16(file);
  const text = orig.toString('utf8');
  if (!text.includes(from)) {
    throw new Error('inject: pattern not found in ' + file + ' :: ' + from);
  }
  const result: InjectResult = { restored: false, threw: false };
  try {
    const next = text.replace(from, to);
    writeFileSync(file, next);
    log('INJECTED', file, 'sha-before', before, 'sha-now', sha16(file));
    if (selfcheck) {
      try { selfcheck(); } catch (e) {
        result.selfcheckError = e instanceof Error ? e.message : String(e);
        log('*** SELFCHECK THREW ***', result.selfcheckError);
      }
    }
  } catch (e) {
    result.threw = true;
    log('*** INJECT BODY THREW ***', e instanceof Error ? e.message : String(e));
  } finally {
    writeFileSync(file, orig);
  }
  const after = sha16(file);
  result.restored = after === before;
  if (!result.restored) {
    log('*** RESTORE MISMATCH ***', file, 'before', before, 'after', after);
  } else {
    log('RESTORED byte-identical', file, after);
  }
  return result;
}

/** 断言:分母必须 > 0 —— 本仓纪律,防止"0/0 全绿"。 */
export function assertDenominator(n: number, what: string): void {
  if (!(n > 0)) throw new Error('denominator is zero for: ' + what + ' (got ' + n + ')');
}

/** 剥掉注释 + 字符串字面量 —— 任何"扫代码"的判据都必须先过这一层。
 *  本仓已两次踩到"读到注释里的示例当成代码"。 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += q + q; continue;
    }
    out += c; i++;
  }
  return out;
}
