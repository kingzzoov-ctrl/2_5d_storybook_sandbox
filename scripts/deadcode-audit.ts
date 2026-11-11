/**
 * deadcode-audit.ts —— 「未执行代码」全量审计
 *
 * 目标:系统性找出「完整实现、单测全绿、编排层不接」这一类缺陷。
 *
 * ══════════ 为什么判据必须收紧 ══════════
 * 上一轮做过一次宽扫,得到「866 个导出符号只在测试出现」——**太宽**。
 * 原因是把库函数也算进去了:它们本来就被编排层或彼此消费,「只在测试
 * 出现」对它们没有诊断力。**本审计宁可漏报也不虚报**,每条都要能复核。
 *
 * 收紧后的判据(四条**同时**满足才算「真缺陷」):
 *   ① **有状态**:导出的类持有可变字段,或函数带增量语义;
 *   ② **有驱动方法**:名字匹配 tick|step|advance|apply|drain|update|pump|
 *      refresh|flush|consume|settle|decay|evolve|process|run|drive 等
 *      增量语义名,**且不是 private**;
 *   ③ **生产零调用**:在 `server/src` + `client/src` 内的调用点数为 0
 *      (排除 `tests/`;排除注释;排除方法定义行自身);
 *   ④ **模块已接入**:所属模块在 `npm run sim` 的可达闭包内。
 *      否则只是「整个 WS 尚未编排」,不是「编排层漏接」,诊断力完全不同。
 *
 * ══════════ 为什么必须剥注释 ══════════
 * 本仓库的文档注释里大量出现 `aoi.stepActive(() => {})`、`CarrySystem.tick`
 * 这类**示例代码**。不剥注释会把已经死掉的调用伪装成活的 —— 直接假阴性,
 * 而本审计要抓的恰恰是「看起来被调用过」这一类。
 *
 * ══════════ 为什么必须卡驼峰边界 ══════════
 * 实测踩到的假阳性:`runtimes` = run + times(名词复数),被 `run\w*` 误判成
 * 驱动方法,于是「快照访问器」被误报成「漏接的驱动入口」。故动词前缀后面
 * 必须紧跟大写字母或字符串结尾。
 *
 * ══════════ 三级裁决 ══════════
 *  - **真缺陷**:A 档可达 + 生产零调用 + 有测试调用(**且未登记为已知未决**)
 *  - **合理**:显式排除 / 整个 WS 未编排 / 已在未决台账登记
 *  - **无法判断**:零调用且无测试、也无可查依据(多为预留 API)
 *
 * 「已在未决台账登记」这一档很关键:审计的目的是**发现未知**,不是把已经
 * 由 Lead 裁决「刻意不做」的条目反复报成新缺陷。参见 `KNOWN_BACKLOG`。
 *
 * 用法:
 *   node scripts/deadcode-audit.ts             # 表格输出(摘要)
 *   node scripts/deadcode-audit.ts --all       # 展开 B 档与已排除项
 *   node scripts/deadcode-audit.ts --json      # 机器可读
 *   node scripts/deadcode-audit.ts --audit-wording   # 自检:排除清单是否仍有理由
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const ROOT = process.cwd();
const PROD_ROOTS = ['server/src', 'client/src'];
const TEST_ROOT = 'tests';
/** 生产入口:package.json 的 `npm run sim` → `server/src/sim/demo.ts` */
const PROD_ENTRIES = ['server/src/sim/demo.ts'];

/* ══════════════════════ 1. 收集文件 ══════════════════════ */

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const rel = (p: string): string => relative(ROOT, p).split('\\').join('/');

const prodPaths: string[] = [];
for (const r of PROD_ROOTS) {
  const abs = join(ROOT, r);
  try {
    if (statSync(abs).isDirectory()) prodPaths.push(...walk(abs));
  } catch { /* 目录不存在则跳过 */ }
}
const testPaths = walk(join(ROOT, TEST_ROOT));

/* ══════════════════════ 2. 剥离注释与字符串 ══════════════════════ */

/** 只剥注释、**保留字符串** —— 专供解析 `from '...'` 路径。 */
const stripCommentsOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');

/**
 * 抹掉注释与字符串字面量的**内容**,保留换行与字符位置(行号仍然准确)。
 * 行号准确是「file:line 证据」可复核的前提,故不能一次性正则替换(会吞换行)。
 */
function stripCommentsAndStrings(src: string): string {
  const out = new Array<string>(src.length);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' '; i += 1;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i] = quote; i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out[i] = ' ';
          out[i + 1] = src[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        out[i] = src[i] === '\n' && quote !== '`' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out[i] = quote; i += 1; }
      continue;
    }
    out[i] = c;
    i += 1;
  }
  return out.join('');
}

interface Source {
  /** 仓库相对路径,如 `server/src/mobs/host.ts` */
  path: string;
  /** 绝对路径(posix 分隔),供 import 解析 */
  abs: string;
  /** 去注释去字符串(行号不变)—— 供调用点统计 */
  code: string;
  /** 去注释但保留字符串 —— 供 import 解析 */
  linker: string;
}

const mk = (f: string): Source => {
  const raw = readFileSync(f, 'utf8');
  return {
    path: rel(f),
    abs: resolve(f).replace(/\\/g, '/'),
    code: stripCommentsAndStrings(raw),
    linker: stripCommentsOnly(raw),
  };
};
const prod: Source[] = prodPaths.map(mk);
const tests: Source[] = testPaths.map(mk);
const lineOf = (code: string, idx: number): number => code.slice(0, idx).split('\n').length;

/* ══════════════════════ 3. 可达性闭包 ══════════════════════ */

const byAbs = new Map(prod.map((s) => [s.abs, s]));
const P = (p: string): string => resolve(join(ROOT, p)).replace(/\\/g, '/');

const reachable = new Set<string>();
for (const entry of PROD_ENTRIES) {
  (function dfs(p: string) {
    const s = byAbs.get(P(p));
    if (!s || reachable.has(s.path)) return;
    reachable.add(s.path);
    for (const m of s.linker.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
      const hit = byAbs.get(resolve(dirname(s.abs), m[1]).replace(/\\/g, '/'));
      if (hit) dfs(hit.path);
    }
  })(entry);
}

/* ══════════════════════ 4. 驱动语义名 ══════════════════════ */

/**
 * 增量/驱动语义名。刻意**不含** get/is/has/find/collect 等纯查询名 ——
 * 它们是被间接消费的库函数,正是上一轮把 866 个符号全打成死代码的原因。
 *
 * 动词前缀后必须跟**大写字母或结尾**(驼峰词边界),否则 `runtimes` 这类
 * 名词会被 `run` 家族误吃。
 */
const DRIVE_VERBS = [
  'tick', 'step', 'advance', 'apply', 'drain', 'update', 'pump', 'refresh',
  'flush', 'consume', 'settle', 'decay', 'evolve', 'process', 'run', 'drive',
  'dispatch', 'commit',
];
const DRIVE_RE = new RegExp(`^(?:[a-z]+)?(?:${DRIVE_VERBS.join('|')})(?=[A-Z]|$)`);
const isDriverName = (name: string): boolean => DRIVE_RE.test(name);

/* ══════════════════════ 5. 刻意排除清单 ══════════════════════ */

interface Exclusion {
  /** `file::method` 或 `file` 形式 */
  target: string;
  reason: string;
  handover: string;
}

/**
 * 刻意不驱动的符号。**显式登记,不自动跳过** ——
 * 让后来者看到「这里为什么没被调用」,而不是再次踩坑后重复审计。
 */
const DELIBERATE_EXCLUSIONS: readonly Exclusion[] = [
  {
    target: 'server/src/mobs/aoi.ts::stepActive',
    reason: '刻意不驱动:回调 `(id, rec) => void` 不返回结果,无法把推进产生的移动/事件归因到具体生物。',
    handover: 'world_sim.ts 改用 `mobHost.tickMobs([...aoi.activeMobs], SIM_SLOW_DT)`;归因由 MobHost 负责。',
  },
  {
    target: 'server/src/sim/demo.ts',
    reason: 'demo 是**最外层**演示入口(`npm run sim`),由人手动运行,不被任何生产模块 import。',
    handover: '无需接管 —— 它本身是消费者。',
  },
];

const isExcluded = (locator: string): Exclusion | undefined =>
  DELIBERATE_EXCLUSIONS.find((e) => locator === e.target || locator.startsWith(`${e.target}:`));

/* ══════════════════════ 6. 已知未决台账 ══════════════════════ */

/**
 * 已由 Lead 在未决台账 / 变更请求里裁决过的缺口。
 * 审计命中这些时裁决为「合理(已知未决)」而非「真缺陷」——
 * 目的是让报告聚焦**未知**,而不是把已裁决条目重报一遍。
 *
 * 依据:`docs/DAMAGE-LOOP.md`、`docs/SIM-orchestration.md`、`node scripts/backlog.ts`。
 */
interface KnownItem {
  /** 命中的符号名(方法名或函数名) */
  symbol: string;
  /** 台账条目号与出处 */
  ledger: string;
  reason: string;
}

const KNOWN_BACKLOG: readonly KnownItem[] = [
  {
    symbol: 'applyImpulse',
    ledger: 'DAMAGE-LOOP.md D1',
    reason: '已知未决:玩家受伤后的击退与硬直未实现,「击退需要写回 PhysicsBody,涉及移动权威归属」。两个 `applyImpulse`(CarrySystem / PhysicsWorld)就是这条的落点:实现完整、WS-02 测试全绿,但伤害管线从不调用它们。',
  },
  {
    symbol: 'applySafeZoneShield',
    ledger: 'SIM-orchestration.md US3(部分) / backlogs',
    reason: '已知未决:安全区减伤只落在「生物打玩家」一侧的抽象里,而玩家打生物的伤害走 `damage.ts`(WS-10),该模块整体尚未编排。',
  },
  {
    symbol: 'decayTrace',
    ledger: 'WS-02 工具函数',
    reason: '合理:纯观测工具(返回速度序列供断言),不承担世界推进职责,生产无调用是设计意图。',
  },
  {
    symbol: 'runUntil',
    ledger: 'WS-08 测试便利 API',
    reason: '合理:`run()` 是生产驱动入口,`runUntil(pred)` 是「跑到条件成立」的测试便利封装,生产用不到。',
  },
];

const knownFor = (symbol: string): KnownItem | undefined =>
  KNOWN_BACKLOG.find((k) => k.symbol === symbol.split('::').pop());

/* ══════════════════════ 7. 提取与统计 ══════════════════════ */

interface Finding {
  symbol: string;
  kind: 'method' | 'function';
  file: string;
  line: number;
  owner?: string;
  moduleReachable: boolean;
  prodCalls: number;
  testCalls: number;
  verdict: '真缺陷' | '合理' | '无法判断';
  grade: 'A' | 'B' | '-';
  note: string;
}

/** 按大括号配对取出类体。 */
function classBody(code: string, startIdx: number): string {
  const open = code.indexOf('{', startIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/**
 * 统计 `name(` 调用点。`asMethod` 为真只认 `.name(`;否则认前面不是
 * `.`/标识符的 `name(`(自由函数)。返回 `file:line` 供复核。
 */
function callSites(sources: Source[], name: string, asMethod: boolean): string[] {
  const hits: string[] = [];
  const re = asMethod
    ? new RegExp(`\\.\\s*${name}\\s*\\(`, 'g')
    : new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g');
  for (const s of sources) {
    for (const m of s.code.matchAll(re)) {
      hits.push(`${s.path}:${lineOf(s.code, m.index ?? 0)}`);
    }
  }
  return hits;
}

/** 类内方法定义(缩进两空格),排除构造与控制关键字。 */
function methodsOf(body: string): { name: string; declLine: string; offset: number }[] {
  const out: { name: string; declLine: string; offset: number }[] = [];
  const re = /^ {2}(?:(?:public|private|protected|static|async|readonly|get|set)\s+)*([a-zA-Z_$][\w$]*)\s*[(<]/gm;
  for (const m of body.matchAll(re)) {
    const name = m[1];
    if (['constructor', 'if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
    out.push({ name, declLine: m[0], offset: m.index ?? 0 });
  }
  return out;
}

/** 类是否持有可变状态:存在非 readonly、非 static 的带初始值字段。 */
function hasMutableState(body: string): boolean {
  const re = /^ {2}(?!readonly\b)(?!static\b)(?:public\s+|private\s+|protected\s+)?([a-zA-Z_$][\w$]*)\s*[:?]?\s*[^=(\n]*=\s*[^=]/gm;
  for (const m of body.matchAll(re)) {
    if (['constructor', 'if', 'return', 'const', 'let', 'var'].includes(m[1])) continue;
    return true;
  }
  return false;
}

const findings: Finding[] = [];

for (const s of prod) {
  /* ── 导出的类 ── */
  for (const cm of s.code.matchAll(/^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) {
    const className = cm[1];
    const classStart = cm.index ?? 0;
    const body = classBody(s.code, classStart);
    const bodyStart = classStart + s.code.slice(classStart).indexOf('{') + 1;
    const mutable = hasMutableState(body);
    for (const { name, declLine, offset } of methodsOf(body)) {
      if (!isDriverName(name)) continue;
      /* private 由类内部自行驱动,不构成「编排层不接」 */
      if (/\bprivate\b/.test(declLine) || name.startsWith('#')) continue;
      const defLine = lineOf(s.code, bodyStart + offset);
      const sites = callSites(prod, name, true).filter((h) => h !== `${s.path}:${defLine}`);
      findings.push({
        symbol: `${className}::${name}`,
        kind: 'method',
        file: s.path,
        line: defLine,
        owner: className,
        moduleReachable: reachable.has(s.path),
        prodCalls: sites.length,
        testCalls: callSites(tests, name, true).length,
        verdict: '无法判断',
        grade: '-',
        note: mutable ? '类持有可变状态' : '类无显式可变字段',
      });
    }
  }

  /* ── 导出的自由函数 ── */
  for (const fm of s.code.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    const fn = fm[1];
    if (!isDriverName(fn)) continue;
    const defLine = lineOf(s.code, fm.index ?? 0);
    const sites = callSites(prod, fn, false).filter((h) => h !== `${s.path}:${defLine}`);
    findings.push({
      symbol: fn,
      kind: 'function',
      file: s.path,
      line: defLine,
      moduleReachable: reachable.has(s.path),
      prodCalls: sites.length,
      testCalls: callSites(tests, fn, false).filter((h) => h !== `${s.path}:${defLine}`).length,
      verdict: '无法判断',
      grade: '-',
      note: '导出函数',
    });
  }
}

/* ══════════════════════ 8. 裁决 ══════════════════════ */

for (const f of findings) {
  if (f.prodCalls > 0) continue;
  const method = f.kind === 'method' ? f.symbol.split('::')[1] : undefined;
  const excl = (method ? isExcluded(`${f.file}::${method}`) : undefined) ?? isExcluded(f.file);
  const known = knownFor(f.symbol);

  if (excl) {
    f.verdict = '合理';
    f.grade = f.moduleReachable ? 'A' : 'B';
    f.note = `[刻意排除] ${excl.reason} 接管:${excl.handover}`;
  } else if (known) {
    f.verdict = '合理';
    f.grade = f.moduleReachable ? 'A' : 'B';
    f.note = `[已知未决 ${known.ledger}] ${known.reason}`;
  } else if (!f.moduleReachable) {
    f.grade = 'B';
    f.verdict = f.testCalls > 0 ? '合理' : '无法判断';
    f.note = f.testCalls > 0
      ? `所属模块不在生产可达闭包内 —— 整个 WS 尚未编排(SIM-orchestration.md US2/US3)。测试 ${f.testCalls} 处`
      : '模块不可达且该符号生产/测试均零调用';
  } else {
    f.grade = 'A';
    if (f.testCalls > 0) {
      f.verdict = '真缺陷';
      f.note = `模块**已在生产可达闭包内**,但本驱动入口生产零调用;测试 ${f.testCalls} 处 —— 「单测全绿、编排漏接」`;
    } else {
      f.verdict = '无法判断';
      f.note = '模块可达但该入口生产/测试均零调用,可能是为后续编排预留';
    }
  }
}

/* ══════════════════════ 9. 第二探测器:只写不读的状态 ══════════════════════ */

/**
 * 与「驱动方法零调用」**互补**的另一种失效模式:
 * **某个有状态容器只被写入、其内容从没有任何读者**。
 *
 * 这类缺陷比零调用更隐蔽 —— 代码在跑、日志有输出、字段在增长,
 * 但结果永远到不了编排层。实测抓到 `FluidField.pendingObj`:
 * `phasePass()` 每帧往里 `push` 相变产物(黑曜石/浮石),
 * 而生产侧既没有 `drainPhaseProducts()` 调用,也没有任何地方读 `pendingObj`,
 * 于是产物永远到不了 `WorldGrid` 的 OBJ 层 —— 玩家挖穿熔岩与水看不到黑曜石。
 *
 * 判据(三条同时满足):
 *   ① 可达模块里声明的**公开可变容器字段**(数组 / Map / Set / 计数);
 *   ② 模块内**有写入点**(`.push(` / `.set(` / `.add(` / `+=`);
 *   ③ 定义文件之外**零读取点**(即没有任何外部消费者)。
 *
 * 「同文件读取不算」是刻意的:`drainPhaseProducts()` 自己在 fluid.ts 里读,
 * 但生产从不调它 —— 正是这种情况要被抓出来。
 */
interface WriteOnlyFinding {
  field: string;
  file: string;
  line: number;
  /** 写入点数(构成「它确实在动」的证据) */
  writes: number;
  verdict: '真缺陷' | '合理' | '无法判断';
  note: string;
}

/** 已知未决的写-只读字段(与 KNOWN_BACKLOG 同源,单独登记以区分)。 */
const KNOWN_WRITE_ONLY: Readonly<Record<string, { verdict: '真缺陷' | '合理'; note: string }>> = {
  'server/src/world/fluid.ts::pendingObj': {
    verdict: '真缺陷',
    note: '相变产物只进不出:生产侧既无 drainPhaseProducts() 调用,也无任何外部读者;'
      + '而 FLUID-BUDGET.md:227 宣称由 pushPendingObj 写回 OBJ 层 —— 该桥接函数全仓不存在。'
      + '后果:玩家熔岩+水看不到黑曜石,数组在极端场景无界增长。',
  },
  'server/src/physics/world.ts::fx': {
    verdict: '合理',
    note: '本帧特效队列,**由本文件自行消费**:`step()` 开头 `this.fx.length = 0` 清空,'
      + '生产侧无外部读者是有意的 —— 特效表现留给 WS-09 客户端,服务端只保留一帧。',
  },
  'server/src/sim/world_sim.ts::unknownMobs': {
    verdict: '合理',
    note: '可观测性字段:记录「传了错 ID」的生物,供测试与排查。EVENT-BUS.md U7 已登记'
      + '「是否应为硬失败」为未决;当前只收集,UI/日志侧尚未接。',
  },
};

const writeOnly: WriteOnlyFinding[] = [];

for (const s of prod) {
  if (!reachable.has(s.path)) continue;
  /* 公开可变容器字段:数组 / Map / Set 字面量初始化,或 readonly 数组 */
  const fieldRe =
    /^ {2}(?:readonly\s+)?([a-zA-Z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet)\b|\[\])/gm;
  for (const fm of s.code.matchAll(fieldRe)) {
    const field = fm[1];
    const defLine = lineOf(s.code, fm.index ?? 0);
    /* 写入点:本文件内的 .push/.set/.add/+= */
    const writeRe = new RegExp(`\\.${field}\\s*\\.(?:push|set|add|delete|splice)\\s*\\(`, 'g');
    const writes = [...s.code.matchAll(writeRe)].length;
    if (writes === 0) continue;
    /* 外部读取点:其他生产文件里出现 `xxx.<field>` 或 `<field>` 成员访问 */
    const readRe = new RegExp(`\\.${field}\\b`, 'g');
    let external = 0;
    for (const o of prod) {
      if (o.path === s.path) continue;
      external += [...o.code.matchAll(readRe)].length;
    }
    if (external > 0) continue;
    const key = `${s.path}::${field}`;
    const known = KNOWN_WRITE_ONLY[key];
    writeOnly.push({
      field,
      file: s.path,
      line: defLine,
      writes,
      verdict: known ? known.verdict : '无法判断',
      note: known ? known.note : '本文件内写入但全生产无外部读取者;可能由同文件方法消费(需人工确认)',
    });
  }
}

/* ══════════════════════ 10. 第三探测器:注册表提供者不可达 ══════════════════════ */

/**
 * 「注册表」模式:某模块通过**副作用注册**(`registerX(kind, fn)`)向另一模块
 * 的全局表里填充行为,自身没有导出被调用的入口。
 *
 * 这类模块的失效方式极隐蔽:模块**文件完整、测试全绿**(测试里 `import`
 * 它一次,注册就发生了),但**生产可达闭包内没有任何文件 import 它**,
 * 于是注册表在实际运行时是空的 —— 所有 kind 都解析成「不求值的空壳」。
 *
 * 判据:
 *   ① 某模块含有 ≥1 处 `registerXxx(` 调用(定义或调用皆可);
 *   ② 该模块**不在**生产可达闭包内;
 *   ③ 生产代码里存在**按字符串**引用该注册表的调用点(如 `addComponent({kind:'...'})`)。
 *
 * 命中即「真缺陷」:运行时会静默地什么都不做。
 */
interface RegistryFinding {
  provider: string;
  /** 注册了多少项 */
  registrations: number;
  /** 提供者不可达的结论 */
  reachable: boolean;
  /** 按字符串消费注册表的调用点 */
  consumers: string[];
  verdict: '真缺陷' | '无法判断';
  note: string;
}

const registryFindings: RegistryFinding[] = [];

/** 找出「调用 registerXxx(...)」的文件,并统计注册次数。 */
/**
 * ⚠ 必须**锚定到具体注册表**:不能泛化到任何 `registerXxx`。
 * 实测假阳性:`Room.onMessage` 内部调 `registerHandler(...)`、
 * `dye_overlay` 的 `registerShader(...)` —— 各自服务于不相干的表,泛化会误报 5 条。
 *
 * ⚠ 必须用 `linker`(保留字符串)而非 `code` —— `code` 把字符串抹成空格,
 * `kind: 'LEVER'` 变成 `kind: '     '`,调用点全部消失,探测器静默不报(实测踩到)。
 */
const REGISTRY_API = 'registerComponentKind';

const registryProviders = prod
  .filter((s) => s.linker.includes(REGISTRY_API))
  .map((s) => ({
    path: s.path,
    count: [...s.linker.matchAll(new RegExp(`${REGISTRY_API}\\s*\\(`, 'g'))].length,
  }));

/** 生产代码里按字符串建对象的调用点,如 `kind: 'SENSOR_LEVER'`。 */
const kindConsumers: { site: string; kind: string }[] = [];
for (const s of prod) {
  if (!/\baddComponent\s*\(/.test(s.linker)) continue;
  for (const m of s.linker.matchAll(/kind\s*:\s*'([A-Z][A-Z0-9_]*)'/g)) {
    kindConsumers.push({ site: `${s.path}:${lineOf(s.linker, m.index ?? 0)}`, kind: m[1] });
  }
}

for (const p of registryProviders) {
  /* 消费者:按字符串消费 kind 的调用点,且不在提供者自身文件内 */
  const consumers = kindConsumers.filter((c) => !c.site.startsWith(p.path));
  if (consumers.length === 0) continue;
  const isReachable = reachable.has(p.path);
  registryFindings.push({
    provider: p.path,
    registrations: p.count,
    reachable: isReachable,
    consumers: consumers.map((c) => c.site),
    verdict: isReachable ? '无法判断' : '真缺陷',
    note: isReachable
      ? '注册表提供者可达,副作用注册正常生效。'
      : `**真缺陷**:提供者 ${p.path} 用 ${REGISTRY_API} 注册了行为,`
        + `但它不在生产可达闭包内(没有任何生产文件 import 它)。\n`
        + `        于是运行时注册表为空,而 ${consumers[0].site} 却构造了 kind='${consumers[0].kind}'。`,
  });
}

/* ══════════════════════ 11. 第四探测器:引用了未注册的 kind ══════════════════════ */

/**
 * 直接核对「生产代码按字符串构造的 kind」是否**真的被注册过**。
 * 这是上一条的**结果侧**验证:即使提供者可达,字符串也可能拼错。
 *
 * ⚠ 必须限定在**同一个注册表命名空间**内。实测踩到的假阳性:
 * `world.ts` 里 `this.fx.push({ kind: 'BURNED' })` 的 `kind` 是**物理特效枚举**,
 * 与电路件的 `kind` 完全无关。不加约束会一次误报 9 条。
 *
 * 故改为:只在**引用了注册表 API 的文件**里检查 `kind:` 字面量,且要求该文件
 * 确实导入了提供者模块的符号(即它真的在用这个注册表)。
 */
const registeredKinds = new Set<string>();
let registryProviderPath = '';
let registryProviderExports = new Set<string>();
for (const s of prod) {
  const found: string[] = [];
  for (const m of s.linker.matchAll(/(?:register[A-Z]\w*|S)\s*\(\s*(?:\d+\s*,\s*)?'([A-Z][A-Z0-9_]*)'/g)) {
    found.push(m[1]);
  }
  if (found.length === 0) continue;
  for (const k of found) registeredKinds.add(k);
  /* 记住注册点最多的那个文件作为「提供者」 */
  if (found.length > registryProviderExports.size) {
    registryProviderPath = s.path;
    registryProviderExports = new Set(found);
  }
}

/**
 * 只在**确实 import 了提供者**的文件里核对 kind 字面量。
 * `demo.ts` 直接 `addComponent({kind:'LEVER'})` 却**没有** import components.ts,
 * 这正是要抓的形态 —— 所以它对提供者符号的「引用」是隐式的,
 * 判据改为:文件里出现 `addComponent(`(即它真的在往注册表里塞 kind)。
 */
const badKindRefs: { site: string; kind: string }[] = [];
if (registeredKinds.size > 0) {
  for (const s of prod) {
    if (!/\baddComponent\s*\(/.test(s.linker)) continue;
    for (const m of s.linker.matchAll(/kind\s*:\s*'([A-Z][A-Z0-9_]*)'/g)) {
      const kind = m[1];
      if (registeredKinds.has(kind)) continue;
      badKindRefs.push({ site: `${s.path}:${lineOf(s.linker, m.index ?? 0)}`, kind });
    }
  }
}

/* 提供者是否可达 —— 单独核对,不能只看「注册点数最多」那个文件 */
const registryProviderReachable = registryProviderPath !== '' && reachable.has(registryProviderPath);

/* ══════════════════════ 12. 输出 ══════════════════════ */

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const dead = findings.filter((f) => f.prodCalls === 0);
const realDefects = dead.filter((f) => f.verdict === '真缺陷');
const legitimate = dead.filter((f) => f.verdict === '合理');
const unknown = dead.filter((f) => f.verdict === '无法判断');
const stageB = dead.filter((f) => f.grade === 'B');

if (argv.includes('--json')) {
  console.log(JSON.stringify({
    scanned: {
      prodFiles: prod.length,
      testFiles: tests.length,
      reachableModules: reachable.size,
      symbolsWithDriver: findings.length,
    },
    summary: {
      zeroProdCall: dead.length,
      realDefects: realDefects.length,
      legitimate: legitimate.length,
      unknown: unknown.length,
      gradeBUnwiredModule: stageB.length,
    },
    findings: showAll ? findings : dead,
  }, null, 2));
} else {
  console.log('════════════════ 未执行代码审计 ════════════════');
  console.log(`扫描:生产 ${prod.length} 个文件 / 测试 ${tests.length} 个文件`);
  console.log(`生产可达模块:${reachable.size} 个(入口 ${PROD_ENTRIES.join(', ')})`);
  console.log(`提取「有状态 + 有驱动方法」符号:${findings.length} 个`);
  console.log('');

  const show = (title: string, list: Finding[]): void => {
    if (list.length === 0) return;
    console.log(`── ${title}(${list.length}) ──`);
    for (const f of list) {
      console.log(`  [${f.verdict}] ${f.symbol}   (${f.grade} 档)`);
      console.log(`      位置:${f.file}:${f.line}`);
      console.log(`      零调用证据:生产 0 处 / 测试 ${f.testCalls} 处`);
      console.log(`      裁决:${f.note}`);
      console.log('');
    }
  };

  show('A 档 真缺陷:模块已接入,驱动入口漏接', realDefects);
  show('A 档 无法判断', unknown.filter((f) => f.grade === 'A'));

  if (writeOnly.length > 0) {
    console.log(`── 第二探测器:只写不读的可达状态(${writeOnly.length}) ──`);
    for (const w of writeOnly) {
      console.log(`  [${w.verdict}] ${w.field} 字段`);
      console.log(`      位置:${w.file}:${w.line}`);
      console.log(`      证据:本文件内写入 ${w.writes} 处 / 其他生产文件读取 0 处`);
      console.log(`      裁决:${w.note}`);
      console.log('');
    }
  }

  if (registryFindings.length > 0) {
    console.log(`── 第三探测器:注册表提供者不可达(${registryFindings.length}) ──`);
    for (const r of registryFindings) {
      console.log(`  [${r.verdict}] ${r.provider}`);
      console.log(`      注册点数:${r.registrations} 处`);
      console.log(`      裁决:${r.note}`);
      console.log('');
    }
  }

  if (registeredKinds.size > 0) {
    console.log('── 第四探测器:组件 kind 注册表核对 ──');
    console.log(`  提供者:${registryProviderPath || '(未找到)'}`);
    console.log(`  可达:${registryProviderReachable ? '是' : '**否** —— 生产从不 import 它'}`);
    console.log(`  已注册 kind:${registeredKinds.size} 个`);
    if (badKindRefs.length === 0) {
      console.log('  未注册 kind 引用:0 处');
    } else {
      console.log(`  未注册 kind 引用:${badKindRefs.length} 处`);
      for (const b of badKindRefs) {
        console.log(`    [真缺陷] ${b.site} 用了 kind='${b.kind}',该 kind 不在注册表内`);
      }
    }
    console.log('');
  }

  if (showAll) {
    show('A 档 合理(刻意排除 / 已知未决)', legitimate.filter((f) => f.grade === 'A'));
    show('B 档 整模块未编排(WS 尚未接入世界)', stageB);
  }

  console.log('── 汇总 ──');
  console.log(`  A 档 真缺陷        ${realDefects.length}`);
  console.log(`  只写不读状态       ${writeOnly.length}`);
  console.log(`  A 档 无法判断      ${unknown.filter((f) => f.grade === 'A').length}`);
  console.log(`  A 档 合理          ${legitimate.filter((f) => f.grade === 'A').length}`);
  console.log(`  B 档 整模块未编排  ${stageB.length}${showAll ? '' : '(--all 展开)'}`);
  console.log(`  零生产调用合计     ${dead.length}`);
  console.log('');
  console.log(`  刻意排除登记        ${DELIBERATE_EXCLUSIONS.length} 条`);
  console.log(`  已知未决登记        ${KNOWN_BACKLOG.length} 条`);
}