/**
 * WS-FND-117 —— 第五轮的**元审计**:对第四轮新增判据里「看起来有牙、实际没有」的槽位
 * 做一次回归锁,并给每台探针配**负对照 + 注入**(本仓 FND-103 的判据纪律)。
 *
 * 这一层比"判据"再高一层:它判的是"那些判据是不是真的会红"。
 *
 * | # | 钉住的槽位 | 第四轮的问题 | 本文件的探针 |
 * | :--- | :--- | :--- | :--- |
 * | 1 | `WS-FND-111:248/249/279/340` + `:298-299/402` | 恒真断言(`30*3===90` / `Math.max(0,NaN)` / 本地数组 / 本地循环)—— 一次也不碰被测模块 | `tautologySlots()`:剥注释后按五条形态扫,≥1 即报 |
 * | 2 | `WS-FND-112:159/163-169` | 对 `checkDocs` 用**未剥注释**的 body 做子串断言 ⇒ 把检查注释成死代码仍可能绿 | 复现"把 `detectStale()` 注释掉 ⇒ 旧判据仍绿 / 剥注释后红" |
 * | 3 | `WS-FND-110:353` | `src.includes('const unusable')` 子串判据 ⇒ 写回字面量仍绿 | `selfCheatSubstrings()` + 真跑 data-conformance 看 ✓ |
 * | 4 | `WS-FND-109:310` | `WORLD_SIM_SRC.includes('零调用')` 子串判据 | 同上 + 真调用 `startPartyRun` |
 * | 5 | `scripts/verify.ts:3777-3780` | 缺 typescript 只 `console.log + return`,不进汇总 | 结构断言 `advise('类型检查基线锁'...)` + 注入换回 console.log |
 * | 6 | `scripts/count-audit.ts:363-367` | 下限=1 只挡 0,没有把下限钉在**实测值**上 | `CLAIM_FLOORS ⇄ CLAIM_MEASURED` 互校 + 降下限负对照 |
 *
 * 运行:`node tests/WS-FND-117-judgement-hardening.test.ts`
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** LF 归一后读源码(CRLF 会让 `\n}\n` 之类的锚点永不到达)。 */
function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 剥掉注释后的**代码** —— 文本判据必须只看代码:说明里会引用被修的写法(本仓惯例)。
 * 逐字符扫(不用正则),故 `https://` 之类的行注释误伤不存在。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      out += ' ';
      continue;
    }
    if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** 抽某个顶层函数的**函数体**(签名 → 行首 `}`);锚点漂移必须抛错。 */
function funcBody(src: string, signature: string): string {
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`源码里找不到 \`${signature}\` ⇒ 本判据的锚点漂移了`);
  const end = src.indexOf('\n}\n', i);
  if (end < 0) throw new Error(`\`${signature}\` 之后找不到行首 \`}\``);
  return src.slice(i, end + 2);
}

/** 抽一个 `test('...', () => { ... });` 用例的完整函数体。 */
function testBody(src: string, marker: string): string {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`找不到用例锚点 \`${marker}\` ⇒ 判据必须因此变红`);
  const end = src.indexOf('\n});', i);
  if (end < 0) throw new Error(`用例 \`${marker}\` 之后找不到行首 \`});\``);
  return src.slice(i, end + 4);
}

const VERIFY_SRC = readSrc('scripts/verify.ts');
const COUNT_SRC = readSrc('scripts/count-audit.ts');
const F109 = readSrc('tests/WS-FND-109-worldsim-invariants.test.ts');
const F110 = readSrc('tests/WS-FND-110-blueprint-bounds.test.ts');
const F111 = readSrc('tests/WS-FND-111-combat-numeric-bounds.test.ts');
const F112 = readSrc('tests/WS-FND-112-gate-no-silent-skip.test.ts');

/* ═══════════════════════ 探针 ═══════════════════════ */

/** ★ 恒真槽位探针:返回命中的「不碰被测模块」的槽位(剥注释后的代码上跑)。 */
function tautologySlots(code: string): string[] {
  const out: string[] = [];
  const rules: [RegExp, string][] = [
    [/Math\.max\(\s*0\s*,\s*Number\.NaN\s*\)/, 'Math.max(0, NaN) 纯 JS 恒真'],
    [/Number\.isNaN\(\s*Math\.min\(\s*120/, 'String(Number.isNaN(Math.min(...))) 重算修前形态'],
    [/\b30\s*\*\s*3\b/, '字面量乘法 30 * 3'],
    [/OLD_POOL\[/, '本地数组模拟 (607+1)%7'],
    [/\boldTrapped\b/, '本地循环恒 true(oldTrapped)'],
  ];
  for (const [re, why] of rules) if (re.test(code)) out.push(why);
  return out;
}

/** ★ 子串判据探针:返回命中的"grep 源码即过"的写法。 */
function selfCheatSubstrings(code: string): string[] {
  const out: string[] = [];
  if (/src\.includes\(\s*'const unusable'\s*\)/.test(code)) out.push('src 子串「const unusable」');
  if (/WORLD_SIM_SRC\.includes\(\s*'零调用'\s*\)/.test(code)) out.push('WORLD_SIM_SRC 子串「零调用」');
  return out;
}

/** 从 data-conformance 输出里取「动态房间配方数」那一行的结论标记(✓/✗/?);找不到 ⇒ null。 */
function roomRowMark(out: string): string | null {
  const m = /([✓?✗])\s+动态房间配方数/.exec(out);
  return m === null ? null : m[1]!;
}

/** 跑一次 data-conformance,**退出码就地取出**(判据要真跑检测器,不是 grep 源码)。 */
function runDataConformance(): { status: number; out: string } {
  const r = spawnSync(process.execPath, [join('scripts', 'data-conformance.ts')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 67108864, timeout: 180_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 从 count-audit 源码里解析一个 `const NAME: ... = { key: N, ... };` 记录。 */
function floorsOf(src: string, name: string): Record<string, number> {
  const re = new RegExp(`const ${name}: [^=]*= \\{([\\s\\S]*?)\\};`);
  const m = re.exec(src);
  if (m === null) return {};
  const out: Record<string, number> = {};
  for (const x of m[1]!.matchAll(/(\S+?):\s*(\d+),/g)) out[x[1]!] = Number(x[2]);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1 WS-FND-111:恒真槽位必须清零(第四轮:`:248/:249/:279/:340` + `:298-299/402`)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND117-1 WS-FND-111 不再有恒真槽位,替代它的是碰模块的真判据', () => {
  eq(tautologySlots(stripComments(F111)), [], '剥注释后不许再有任何"不碰被测模块"的恒真槽位');
  /* 负对照:逐个写回 ⇒ 探针必须报出它(证明探针不是恒空) */
  ok(tautologySlots('  ok(Number.isNaN(Math.max(0, Number.NaN)), "x");').length >= 1,
    '负对照:`Math.max(0, NaN)` 写回后必须被探针看见');
  ok(tautologySlots('  eq(30 * 3, 90, "x");').includes('字面量乘法 30 * 3'),
    '负对照:`30 * 3` 写回后必须被探针点名');
  ok(tautologySlots('  eq(OLD_POOL[(607 + 1) % OLD_POOL.length], "knockback_mul");').includes('本地数组模拟 (607+1)%7'),
    '负对照:本地数组模拟写回后必须被探针点名');
  ok(tautologySlots('  eq(oldTrapped, true, "x");').includes('本地循环恒 true(oldTrapped)'),
    '负对照:oldTrapped 写回后必须被探针点名');
  /* 结构:替代它们的必须真的碰被测模块 */
  const code = stripComments(F111);
  ok(code.includes('codeOf('), '有限性门改成了「读 vitals/progression 源码结构」的真判据');
  ok(code.includes('atWindow'), '泡泡窗口改成了真 `tickGhostBubble` 边界断言');
  ok(code.includes('one.hpFlat * 3'), 'hpFlat 负对照改成了用**模块算出的单份值**');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2 WS-FND-112:FND112-2 只在**剥注释后的代码**上断言
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND117-2 FND112-2 对 checkDocs 剥注释后断言(注释成死代码必须变红)', () => {
  ok(testBody(F112, "test('FND112-2 ").includes("stripComments(funcBody(VERIFY_SRC, 'function checkDocs('"),
    '★ FND112-2 必须对 checkDocs 用 stripComments(第五轮修法)');
  const raw = funcBody(VERIFY_SRC, 'function checkDocs(');
  const blockOf = (b: string): string => b.slice(b.indexOf('files.length === 0'), b.indexOf('const required'));

  /* —— 复现旧洞:把「未决台账检查」注释成死代码 —— */
  const dead = raw.replace('for (const s of detectStale()) {', '// for (const s of detectStale()) {');
  ok(dead !== raw, '注入锚点(detectStale 那一句)必须命中');
  ok(dead.includes('detectStale()'), '旧判据(未剥注释)在检查被注释掉后**仍然是绿的**(这正是自证洞)');
  eq(stripComments(dead).includes('detectStale()'), false, '★★ 剥注释后必须看不见死代码 ⇒ 新判据变红');

  /* —— 复现旧洞:把 0 份分支的 fail 换回早退 —— */
  const early = raw.replace(/    fail\(\n/, '    return;\n');
  ok(early !== raw, '早退注入锚点必须命中');
  eq(/^\s*return;/m.test(stripComments(blockOf(early))), true, '加回 return; 后(剥注释)必须被判据看见 ⇒ 红');

  /* —— 真源码必须通过新判据 —— */
  const realBlock = stripComments(blockOf(raw));
  ok(realBlock.includes('fail('), '真源码那一支必须 fail(不是 console.log + return)');
  eq(/^\s*return;/m.test(realBlock), false, '真源码那一支不许早退');
  ok(stripComments(raw).includes('detectStale()'), '真源码的未决台账检查必须在**代码**里');
  ok(stripComments(raw).includes('MIN_NON_WS_CHARS'), '真源码的非 WS 文档检查必须在**代码**里');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3 WS-FND-110:房间配方判据是**行为**断言(不再 grep `const unusable`)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND117-3 WS-FND-110 的房间配方判据真跑检测器,不再 grep 子串', () => {
  eq(selfCheatSubstrings(stripComments(F110)), [], '剥注释后不许再有 `src.includes(\'const unusable\')` 子串判据');
  ok(stripComments(F110).includes('runDataConformance()'), '★ 改成真跑 data-conformance');
  /* 负对照:把子串判据写回 ⇒ 探针必须报出 */
  const injected = `${stripComments(F110)}\n  ok(src.includes('const unusable'), 'x');\n`;
  ok(selfCheatSubstrings(injected).length === 1, '负对照:探针必须看见 `const unusable` 子串');
  /* 行为:真跑检测器,该行必须是 ✓(MATCH);旧版硬编码 8 ⇒ ?(UNKNOWN) */
  const dc = runDataConformance();
  eq(dc.status, 0, '前置:data-conformance 必须正常退出(退出码 0)');
  eq(roomRowMark(dc.out), '✓', '★ 「动态房间配方数」实跑结论必须是 MATCH');
  const injectedRow = dc.out.replace(/([✓?✗])(\s+动态房间配方数)/, '?$2');
  eq(roomRowMark(injectedRow), '?', '负对照:旧版恒 UNKNOWN 形态必须被判据看见(证明它不是恒真)');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4 WS-FND-109:派对台账判据真调用 `startPartyRun`(不再 grep `零调用`)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND117-4 WS-FND-109 的派对台账判据真调用 startPartyRun,不再 grep 子串', () => {
  eq(selfCheatSubstrings(stripComments(F109)), [], '剥注释后不许再有 `WORLD_SIM_SRC.includes(\'零调用\')` 子串判据');
  ok(stripComments(F109).includes('startPartyRun('), '★ 改成真调用 startPartyRun');
  /* 负对照:把子串判据写回 ⇒ 探针必须报出 */
  const injected = `${stripComments(F109)}\n  ok(WORLD_SIM_SRC.includes('零调用'), 'x');\n`;
  ok(selfCheatSubstrings(injected).length === 1, '负对照:探针必须看见 `零调用` 子串');
  /* 行为:方法真实存在且能开赛 ⇒ 生产的「恒 IDLE」来自零调用,而不是没实现 */
  const sim = new WorldSim({ sizeCells: 16, mobs: false });
  sim.setPlayerDozing('x', 0);
  for (let i = 0; i < 10; i += 1) sim.tick();
  eq(sim.partyPhase(), 'IDLE', '慢帧跑过但生产路径零调用 ⇒ 恒 IDLE');
  eq(sim.startPartyRun('BRIDGE_CTF', 'ref-1'), true, '★ 真调用:startPartyRun 返回 true');
  ok(sim.partyPhase() !== 'IDLE', '真调用后 partyPhase 不再是 IDLE');
  sim.clearPartyRun();
  eq(sim.partyPhase(), 'IDLE', '清空后回到 IDLE(与生产恒 IDLE 同形态)');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5 verify.ts:3777 缺 typescript 必须 advise 进汇总(与 checkClientBuild 同口径)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND117-5 类型检查基线锁缺 typescript 必须 advise 进汇总,不许静默跳过', () => {
  const body = funcBody(VERIFY_SRC, 'function checkTypecheckBaseline(');
  const marker = "!existsSync(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'))";
  const at = body.indexOf(marker);
  ok(at > 0, '必须有「typescript 存在性」判据(锚点漂移即本用例失效)');
  const block = stripComments(body.slice(at, at + 800));
  ok(/advise\(\s*'类型检查基线锁'/.test(block), '缺 typescript 必须 advise("类型检查基线锁", ...) ⇒ 才会进汇总行');
  eq(/console\.log\([^)]*跳过/.test(block), false, '不许退回「只 console.log 一行然后 return」');
  ok(block.indexOf('advise(') < block.indexOf('return;'), 'advise 必须排在 return **之前**(否则仍只是提前退出)');
  /* 注入:换回 console.log ⇒ 判据必须变红 */
  const injected = block.replace(/advise\(\s*'类型检查基线锁'/, "console.log('跳过");
  eq(/advise\(\s*'类型检查基线锁'/.test(injected), false, '负对照:换成 console.log 后 advise 必须消失');
  eq(/console\.log\([^)]*跳过/.test(injected), true, '负对照:console.log 形态必须能被「禁止」那一半看见');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6 count-audit:下限必须钉在**实测值**上(不是只挡 0)
 * ══════════════════════════════════════════════════════════════════════════ */

test('FND117-6 count-audit 的 CLAIM_FLOORS 必须钉在 CLAIM_MEASURED 实测值上', () => {
  const floors = floorsOf(COUNT_SRC, 'CLAIM_FLOORS');
  const measured = floorsOf(COUNT_SRC, 'CLAIM_MEASURED');
  eq(Object.keys(measured).length, 3, '实测基线必须覆盖三类(少一类 = 该类没有保护)');
  eq(Object.keys(floors).length, 3, '下限必须覆盖三类');
  for (const k of Object.keys(measured)) eq(floors[k], measured[k], `${k}:下限必须等于实测值`);
  ok(Object.values(floors).every((v) => v >= 1), '任何下限不许是 0(第四轮已修,不得回退)');
  const mTotal = /const CLAIM_FLOOR_TOTAL = (\d+);/.exec(COUNT_SRC);
  const mMeas = /const CLAIM_MEASURED_TOTAL = (\d+);/.exec(COUNT_SRC);
  ok(mTotal !== null && mMeas !== null, '两个合计常量都必须存在');
  eq(Number(mTotal![1]), Number(mMeas![1]), '合计下限必须等于合计实测值');
  /* 负对照:把某一类下限降到实测之下 ⇒ 互校必须报出 */
  const lowered = COUNT_SRC.replace(/(CLAIM_FLOORS[\s\S]*?可达性白名单: )1,/, '$10,');
  ok(lowered !== COUNT_SRC, '降下限注入锚点必须命中');
  const lf = floorsOf(lowered, 'CLAIM_FLOORS');
  ok(lf['可达性白名单']! < measured['可达性白名单']!, '负对照:下限降到 0 后必须低于实测基线 ⇒ 会被互校抓住');
  /* 行为:真跑 count-audit,默认运行必须 exit 0(下限/互校都成立) */
  const r = spawnSync(process.execPath, [join('scripts', 'count-audit.ts')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 67108864, timeout: 120_000,
  });
  eq(r.status ?? -1, 0, `count-audit 默认运行必须 exit 0(实际 ${String(r.status)})`);
  ok(/自称总数\s*3;与正解一致\s*3/.test(`${r.stdout ?? ''}`), '汇总行:三类自称(合计 3)全部对上');
});

report('WS-FND-117');
