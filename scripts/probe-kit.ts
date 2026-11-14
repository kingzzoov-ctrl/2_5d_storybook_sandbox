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

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join as joinPath } from 'node:path';

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
 * ★★★ **首选**入口:把"注入 + 测量 + 还原"包成一个原子操作。
 *
 * ## 为什么必须有它 —— 我的 `inject()` 第一版**自己就是这个陷阱的实例**
 *
 * `inject()` 在 `finally` 里还原,所以下面这个顺序**按构造就是 no-op**:
 * ```
 * inject(file, a, b);        // 写入,然后 finally 还原
 * runSuite('tests/X.test.ts') // ★ 用**原文件**跑 ⇒ 注入从未生效
 * ```
 * 实测(我自己踩的,不是设想):
 * ```
 * 错误顺序  exit 0 / 102-102 / fails 0  ⇒ 看起来"注入没让任何东西红"
 * 正确顺序  exit 1 /  99-102 / fails 3  ⇒ 其中一条正是目标行
 * ⇒ 我据此一度以为「注入后仍全绿 ⇒ 这条断言没牙」——**结论完全反了**。
 * ```
 * ★ 这正是本仓反复出现的形态:**「我以为改坏了其实没改坏」**。
 *   而我是在写**专门用来防这件事**的工具时犯的 —— 所以修法不能是"提醒注意顺序",
 *   必须是**让错误顺序写不出来**:`withInjection` 把 `measure()` 放在还原**之前**。
 *
 * @example
 *   const r = withInjection(FILE, FROM, TO, () => runSuite('tests/WS-10.test.ts'));
 *   log('exit', r.value.exit, 'selfcheckErr', r.selfcheckError, 'restored', r.restored);
 */
export interface WithInjection<T> extends InjectResult {
  /** `measure()` 的返回值。即使 measure 抛错,这里也是 undefined 且 `measureError` 有值。 */
  value?: T;
  /** measure() 自己抛出的错误(与 selfcheckError 区分:后者是注入体的自检) */
  measureError?: string;
}

export function withInjection<T>(
  file: string,
  from: string,
  to: string,
  measure: () => T,
  /** 可选:在 measure **之前**执行,用来证明"注入真的生效了"(读回运行期真值) */
  selfcheck?: () => void,
): WithInjection<T> {
  const orig = readFileSync(file);
  const before = sha16(file);
  const text = orig.toString('utf8');
  if (!text.includes(from)) {
    throw new Error('withInjection: pattern not found in ' + file + ' :: ' + from);
  }
  const out: WithInjection<T> = { restored: false, threw: false };
  try {
    writeFileSync(file, text.replace(from, to));
    log('INJECTED', file, 'sha-before', before, 'sha-now', sha16(file));
    if (selfcheck) {
      try { selfcheck(); } catch (e) {
        out.selfcheckError = e instanceof Error ? e.message : String(e);
        log('*** SELFCHECK THREW ***', out.selfcheckError);
      }
    }
    try { out.value = measure(); } catch (e) {
      out.measureError = e instanceof Error ? e.message : String(e);
      log('*** MEASURE THREW ***', out.measureError);
    }
  } catch (e) {
    out.threw = true;
    log('*** INJECT BODY THREW ***', e instanceof Error ? e.message : String(e));
  } finally {
    writeFileSync(file, orig);
  }
  const after = sha16(file);
  out.restored = after === before;
  log(out.restored ? 'RESTORED byte-identical' : '*** RESTORE MISMATCH ***', file, after);
  return out;
}

/**
 * 注入 ⇒ 跑自检 ⇒ **保证还原**(即使自检抛错也还原 —— 已实测)。
 *
 * ⚠️⚠️ **注意:本函数的还原发生在返回之前。**
 * 所以 `inject(f, a, b); runSuite(...)` 是 **no-op** —— 那些测试会用**原文件**跑。
 * **要做"注入后跑测试",请用 `withInjection(f, a, b, () => runSuite(...))`。**
 * 本函数保留给"只要注入的副作用存在过"的场景(如只想证明"文本能被替换")。
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

/* ══════════════════ 控制名必须真实存在 ══════════════════
 *
 * ## 为什么这条要在**这里**(不是文档里的一句话)
 *
 * task-84 实测:我用一个**自己编的**名字 `forgeInspect` 当死 import 扫描器的
 * 对照项,而该符号**在全仓根本不存在**。后果很具体:
 *
 *     扫描器输出的不是「控制名不存在」,而是「1 个死 import」。
 *
 * ⇒ 一个**语法上完全正确**的扫描器,用**不存在的对照项**跑,
 *   会以 100% 的"通过率"告诉你一个它**根本没测到**的东西。
 *   而那个「1」看起来像个真发现,于是没人去查它。
 *
 * 这是陷阱 96(未验证的存在性断言)的**机器化**:
 * 「我说这个符号在代码里」本身就是一个断言,而它**必须被验证**。
 *
 * ## 判据(不是提醒)
 *
 * 控制名/对照项/锚点 —— 任何"扫描器要拿它当参照物"的标识符 ——
 * 若**在生产源码里搜不到**,就是**扫描器自身的错**,
 * 必须在跑出任何数字**之前**抛错。理由:
 * ```
 *   控制名不存在 ⇒ 扫描器的全部读数都不可信
 *   ⇒ 此时「报 0 个」与「报 1 个」都是噪音,继续跑只会掩盖问题
 *   ⇒ 故 fail-fast,不返回任何数字
 * ```
 *
 * ⚠️ **不要**把「搜不到」降级成 warning:那样调用方仍会拿到数字并可能采信。
 *    本仓已多次栽在「判据坏了却伪装成正常结果」上(PROGRESS 陷阱 126)。
 *
 * ## 与 orphan-audit.ts 既有「阳性对照」的关系
 *
 * 那里已有一条**同精神**的锚点检查(`world_sim.ts` 里还有没有裸 import)。
 * 本函数把它**通用化**,让任何探针都能复用 —— 两份防护、同一判据,
 * 与 `stripComments` 的双实现同一用意。
 *
 * @param names  控制名/锚点标识符(必须每个都在源码里真实出现)
 * @param dirs   搜索目录,默认生产三目录
 * @throws       任一名字搜不到 ⇒ 抛错(含全部缺失名,不是只报第一个)
 */
export function assertControlsExist(
  names: readonly string[],
  dirs: readonly string[] = ['server/src', 'client/src', 'shared'],
): void {
  if (names.length === 0) {
    throw new Error('assertControlsExist: names is empty -- nothing verified (denominator 0)');
  }
  const files: string[] = [];
  for (const d of dirs) collectTs(d, files);
  if (files.length === 0) {
    throw new Error('assertControlsExist: no source files under ' + dirs.join(', ')
      + ' -- cannot verify anything (check the paths)');
  }
  const missing: string[] = [];
  for (const n of names) {
    if (n.trim() === '') { missing.push('(empty name)'); continue; }
    const found = files.some((f) => readFileSync(f, 'utf8').includes(n));
    if (!found) missing.push(n);
  }
  if (missing.length > 0) {
    throw new Error('CONTROL NAME NOT FOUND: ' + missing.join(', ')
      + ' -- these appear in no source file under ' + dirs.join(', ')
      + '. A control that does not exist cannot validate anything;'
      + ' a scan using it reports phantom findings instead of failing.'
      + ' Fix the name, or pick a real anchor');
  }
  log('CONTROLS OK', names.length, 'name(s) verified across', files.length, 'file(s)');
}

function collectTs(rel: string, out: string[]): void {
  if (!existsSync(rel)) return;
  for (const n of readdirSync(rel)) {
    const p = joinPath(rel, n);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      collectTs(p, out);
    } else if (n.endsWith('.ts')) out.push(p);
  }
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
