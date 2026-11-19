/**
 * scripts/sync-docs.ts —— **文档数字的唯一来源**:实测 → 写回 → 复算哈希。
 *
 * ## 为什么存在(根因,不是现象)
 *
 * 八轮里 `README.md` / `docs/HANDOVER.md` 的「用例 / 套件 / 可达性 / 台账 /
 * 类型基线 / 门禁自检 / §九 sha256」被**重钉过 5 次**,每一次都是**人抄**:
 * 抄错、抄漏、抄完没人比。根因不是「不小心」,而是**同一份数字有两个来源**
 * (代码里的实测 + 文档里的手抄),而两个来源**必然**会分叉。
 *
 * ⇒ 本文件把文档侧的数字改成**生成物**:
 *   · `--write`:现算现写(幂等 —— 连跑两次,第二次无变化);
 *   · `--check`:不写盘,只回答「会不会变」;不一致时**直接给出应写的值**,
 *     并提示跑 `node scripts/sync-docs.ts --write`。
 *   · `verify.ts` 不再逐项比对 README/HANDOVER,而是调用本文件的 `--check`
 *     (见 `verify.ts::verifyDocsNumbers()`);**比对只有一份实现**,不会分叉。
 *
 * ## 三种测量源(优先级从高到低)
 *
 * ```
 * 1 --measure=<json>   用 JSON 快照。verify.ts 调用本文件时用它 ——
 *                      它**刚刚**算过同一批数字,再跑一次门禁既慢又会递归。
 *                      ⚠️ 给了它之后**不 spawn 任何子进程**:只有静态量
 *                        (源文件计数 / 行数 / PROGRESS / 哈希)现算。
 * 2 --gate-log=<file>  复用一次已有的门禁输出(`node scripts/verify.ts --all > g.log`)。
 * 3 (默认)              自己 spawn 一次 `node scripts/verify.ts --all` 并解析输出。
 *                      ⚠️ 全量口径:跑全部套件 + 门禁自检,实测约 4 分钟。
 *                        重复比对请用 `--gate-log` 复用,别跑第二遍。
 * ```
 *
 * **未测量 ≠ 通过**:某个字段这次没测到,就打印「未校验」并**不参与比对**,
 * 而不是当成 0 比(那会报假红)或当成对(那是静默绿)。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/sync-docs.ts --check                  # 不写盘,只回答"会不会变"
 * node scripts/sync-docs.ts --write                  # 写回(幂等)
 * node scripts/sync-docs.ts --check --gate-log=g.log # 复用已有门禁输出(快)
 * node scripts/sync-docs.ts --emit-measure           # 打印测量快照(JSON)
 * node scripts/sync-docs.ts --check --root=<dir>     # 换一棵树(测试用)
 * ```
 *
 * 退出码:`0` = 一致 / 已写回;`1` = 有不一致或有锚点错误;`2` = 用法错误。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ───────────────────────── 测量结果的结构 ───────────────────────── */

interface Suites {
  total: number; suites: number;
  wsTotal: number; wsSuites: number;
  fndTotal: number; fndSuites: number;
}
interface Reach { reachable: number; total: number; unreachable: number; whitelist: number }
interface Debt {
  clientShell: number; wiring: number; mechanism: number;
  clientMech: number; decision: number;
  /** 仅用于「出现了没有文档位的新桶」这条自检;文档句式是固定五桶。 */
  dependency: number; other: number;
}
interface Ledger { total: number; open: number; blocking: number; closed: number }
interface Taut { hit: number; whitelist: number }
interface Typecheck { errors: number; fingerprints: number }
interface Inert { registered: number; emptySuccess: number }
interface Progress {
  sections: number; first: number; last: number;
  increasing: boolean; noGap: boolean; hasBom: boolean; bytes: number;
}
interface SrcCounts {
  tests: number; server: number; client: number; scripts: number; shared: number;
  total: number; lines: number;
  /** 生产口径:`server/src` + `client/src` + `shared`(HANDOVER §一 那句话的口径)。 */
  prodServer: number; prodClient: number; prodShared: number; prodTotal: number;
}

/** 一次测量能给出的全部数字;`null` = 本次没有测量源(**未校验**,不是 0)。 */
interface Numbers {
  docStruct: number | null;
  fingerprint: string | null;
  freeIds: number | null;
  strippableDirs: number | null;
  decoratorExempt: number | null;
  inert: Inert | null;
  trustFromClient: number | null;
  suites: Suites | null;
  selfcheck: { passed: number; total: number } | null;
  crossWs: number | null;
  frozen: number | null;
  reach: Reach | null;
  debt: Debt | null;
  nonDebt: number | null;
  diffSet: number | null;
  ledger: Ledger | null;
  taut: Taut | null;
  typecheck: Typecheck | null;
  progress: Progress | null;
  src: SrcCounts | null;
}

const emptyNumbers = (): Numbers => ({
  docStruct: null, fingerprint: null, freeIds: null, strippableDirs: null,
  decoratorExempt: null, inert: null, trustFromClient: null, suites: null,
  selfcheck: null, crossWs: null, frozen: null, reach: null, debt: null,
  nonDebt: null, diffSet: null, ledger: null, taut: null, typecheck: null,
  progress: null, src: null,
});

/** 数字 → 字符串;`null` 保持 `null`(= 该组不参与本次比对)。 */
const s = (v: number | null | undefined): string | null =>
  (v === null || v === undefined ? null : String(v));

/* ───────────────────────── 静态测量(不 spawn) ───────────────────────── */

/** 递归取某目录下所有 `.ts`(跳过 `node_modules` 与点目录)。 */
function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 行数口径:**以换行符为界**;文件末尾的换行不额外算一行。
 * (口径必须写下来,否则「15.7 万」与「17.7 万」的差会被当成漂移而不是口径差异。)
 */
function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function measureSrc(root: string): SrcCounts {
  const dir = (rel: string): string[] => walkTs(join(root, rel));
  const tests = dir('tests');
  const server = dir('server');
  const client = dir('client');
  const scripts = dir('scripts');
  const shared = dir('shared');
  const prodServer = dir(join('server', 'src'));
  const prodClient = dir(join('client', 'src'));
  let lines = 0;
  for (const f of [...tests, ...server, ...client, ...scripts, ...shared]) {
    lines += countLines(readFileSync(f, 'utf8'));
  }
  return {
    tests: tests.length, server: server.length, client: client.length,
    scripts: scripts.length, shared: shared.length,
    total: tests.length + server.length + client.length + scripts.length + shared.length,
    lines,
    prodServer: prodServer.length, prodClient: prodClient.length,
    prodShared: shared.length,
    prodTotal: prodServer.length + prodClient.length + shared.length,
  };
}

/** `docs/PROGRESS.md` 的陷阱台账统计(HANDOVER §三 那一行)。 */
function measureProgress(root: string): Progress | null {
  const p = join(root, 'docs', 'PROGRESS.md');
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const text = buf.toString('utf8');
  const traps = [...text.matchAll(/^##\s+[^、\n]*、陷阱\s+(\d+)/gm)].map((m) => Number(m[1]));
  const first = traps[0];
  const last = traps[traps.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    sections: traps.length,
    first, last,
    increasing: traps.every((v, i) => i === 0 || v > traps[i - 1]!),
    noGap: traps.every((v, i) => i === 0 || v === traps[i - 1]! + 1),
    hasBom: buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF,
    bytes: buf.length,
  };
}

/** 未决台账(`scripts/backlog.ts` 是唯一口径来源 —— 这里只解析它的打印,不重写解析器)。 */
function measureLedger(root: string): Ledger | null {
  const script = join(root, 'scripts', 'backlog.ts');
  if (!existsSync(script)) return null;
  const r = spawnSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  /* 读 status:**子进程崩了不能读成「0 条台账」**(那是把崩溃翻译成"没问题")。 */
  if (r.status !== 0) return null;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /总计 (\d+) 条 \/ 未关闭 (\d+) 条 \/ 阻塞 (\d+) 条 \/ 已关闭 (\d+) 条/.exec(out);
  if (m === null) return null;
  return { total: Number(m[1]), open: Number(m[2]), blocking: Number(m[3]), closed: Number(m[4]) };
}
/* ───────────────────────── 门禁输出解析 ───────────────────────── */

interface GateResult { text: string; exitCode: number | null; source: string }

/**
 * 读一份门禁输出,并**自己判编码**。
 * ⚠️ 实测陷阱:PowerShell 的 `node scripts/verify.ts --all > g.log` 写出的是
 *    **UTF-16LE(带 BOM)**;直接按 utf8 读 ⇒ 中文字段全部匹配不到 ⇒ 所有字段
 *    变「未校验」,而输出里看起来只是"数字没比"。这是「测量源静默失效」,
 *    所以解码必须在这里兜住(BOM 判定是唯一能自证的方式)。
 */
function readGateLog(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8').slice(1);
  }
  return buf.toString('utf8');
}

/** 跑一次全量门禁(或读一份已有的门禁输出)。 */
function readGate(root: string, gateLog: string | undefined): GateResult {
  if (gateLog !== undefined) {
    if (!existsSync(gateLog)) throw new Error(`--gate-log 指向的文件不存在:${gateLog}`);
    return { text: readGateLog(gateLog), exitCode: null, source: `--gate-log ${gateLog}` };
  }
  const verify = join(root, 'scripts', 'verify.ts');
  if (!existsSync(verify)) throw new Error(`找不到 scripts/verify.ts(测量源缺失):${verify}`);
  const r = spawnSync(process.execPath, [verify, '--all'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000,
  });
  return {
    text: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    exitCode: r.status,
    source: 'verify --all(本次现跑)',
  };
}

/**
 * 从门禁输出里取数。**每个字段都必须能被解析出来**,否则该字段进 `missing`
 * (⇒ 打印「未校验」),绝不静默当 0。
 */
function parseGate(text: string): { numbers: Partial<Numbers>; missing: string[] } {
  const n: Partial<Numbers> = {};
  const missing: string[] = [];
  const int = (name: string, re: RegExp, set: (v: number) => void): void => {
    const m = re.exec(text);
    if (m === null) { missing.push(name); return; }
    set(Number(m[1]));
  };
  const need = (name: string, re: RegExp): RegExpExecArray | null => {
    const m = re.exec(text);
    if (m === null) missing.push(name);
    return m;
  };

  int('WS 文档结构份数', /(\d+) 份 WS 文档结构完整/, (v) => { n.docStruct = v; });
  const fp = need('内容基线指纹', /内容与基线一致\((v\d+-[0-9a-f]{8})\)/);
  if (fp !== null) n.fingerprint = fp[1]!;
  int('可用号', /可用号 (\d+)/, (v) => { n.freeIds = v; });
  int('可擦除语法目录数', /全仓可擦除:(\d+) 个目录/, (v) => { n.strippableDirs = v; });
  int('装饰器例外', /装饰器例外 (\d+) 处/, (v) => { n.decoratorExempt = v; });

  const inert = need(
    '入口执行层',
    /入口执行层登记自洽\((\d+) 个 verdict 守卫 handler 已登记;其中 (\d+) 个成功路径为空/,
  );
  if (inert !== null) n.inert = { registered: Number(inert[1]), emptySuccess: Number(inert[2]) };

  int('信任边界', /实测取自客户端 (\d+) 处/, (v) => { n.trustFromClient = v; });

  const su = need(
    '用例汇总',
    /用例汇总:(\d+) 条通过\((\d+) 个套件;WS-01\.\.11 共 (\d+) 条 \/ (\d+) 套件;基座 (\d+) 条 \/ (\d+) 套件\)/,
  );
  if (su !== null) {
    n.suites = {
      total: Number(su[1]), suites: Number(su[2]),
      wsTotal: Number(su[3]), wsSuites: Number(su[4]),
      fndTotal: Number(su[5]), fndSuites: Number(su[6]),
    };
  }

  const cw = need('跨 WS 集成', /── 本节 (\d+)\/(\d+) 条门禁通过 ──/);
  if (cw !== null) n.crossWs = Number(cw[1]);

  /* 冻结层:优先取**门禁自己**比出来的值(HANDOVER 行 → README 行),
     都没有时退回「[冻结层不变量] 节里的 ✓ 条数」——三个来源都拿不到就记未校验。 */
  {
    const m = /冻结层不变量与实测一致\((\d+)\)/.exec(text)
      ?? /冻结层不变量计数与实测一致\((\d+)\)/.exec(text);
    if (m !== null) {
      n.frozen = Number(m[1]);
    } else {
      const sec = /\[冻结层不变量\]([\s\S]*?)(?:\n\[|$)/.exec(text);
      if (sec === null) { missing.push('冻结层不变量'); } else {
        const hits = sec[1]!.split('\n').filter((l) => /^\s+✓/.test(l)).length;
        if (hits === 0) { missing.push('冻结层不变量'); } else n.frozen = hits;
      }
    }
  }

  const rch = need('生产可达性', /生产可达性:可达 (\d+) \/ 不可达 (\d+) \(共 \d+,入口 \d+ 个,白名单 (\d+) 条\)/);
  if (rch !== null) {
    n.reach = {
      reachable: Number(rch[1]), unreachable: Number(rch[2]),
      total: Number(rch[1]) + Number(rch[2]), whitelist: Number(rch[3]),
    };
  }

  const debt = need(
    '欠账构成',
    /欠账构成\((\d+) 条中 (\d+) 条\*\*非欠账\*\*,余 (\d+) 条按卡点分类\):等客户端入口 (\d+) \/ 等编排层接线 (\d+) \/ 等服务端机制 (\d+)(?: \/ 等客户端机制 (\d+))?(?: \/ 等外部依赖 (\d+))? \/ 等裁决 (\d+)/,
  );
  if (debt !== null) {
    n.nonDebt = Number(debt[2]);
    n.debt = {
      clientShell: Number(debt[4]), wiring: Number(debt[5]), mechanism: Number(debt[6]),
      clientMech: debt[7] === undefined ? 0 : Number(debt[7]),
      dependency: debt[8] === undefined ? 0 : Number(debt[8]),
      decision: Number(debt[9]), other: 0,
    };
  }
  int('差集', /差集 (\d+) 条是「有生产引用但引用者也不可达」/, (v) => { n.diffSet = v; });

  const tt = need('同义反复候选', /同义反复候选:命中 (\d+) 条\(白名单 (\d+) 条\)/);
  if (tt !== null) n.taut = { hit: Number(tt[1]), whitelist: Number(tt[2]) };

  const tc = need('类型检查基线', /类型错误未增加\(基线 (\d+) 条 \/ 实测 (\d+) 条;唯一指纹 基线 (\d+) \/ 实测 (\d+)\)/);
  if (tc !== null) n.typecheck = { errors: Number(tc[2]), fingerprints: Number(tc[4]) };

  /* 门禁自检的打印形态实测有两种:`门禁自检全部通过(30/30)` 与 `30 通过 / 30 合计`。
     两种都认 —— 只认一种就会在另一半世界里变成「未校验」。 */
  const sc = need('门禁自检', /门禁自检全部通过\((\d+)\/(\d+)\)/)
    ?? need('门禁自检', /(\d+) 通过 \/ (\d+) 合计/);
  if (sc !== null) n.selfcheck = { passed: Number(sc[1]), total: Number(sc[2]) };

  return { numbers: n, missing };
}

/* ───────────────────────── 测量总装 ───────────────────────── */

interface Measured { numbers: Numbers; source: string; notes: string[] }

function buildNumbers(root: string, gateLog: string | undefined, measurePath: string | undefined): Measured {
  const numbers = emptyNumbers();
  const notes: string[] = [];
  /* 静态量:无论走哪条测量源都自己算(便宜且不会撒谎)。 */
  numbers.src = measureSrc(root);
  numbers.progress = measureProgress(root);

  if (measurePath !== undefined) {
    if (!existsSync(measurePath)) throw new Error(`--measure 指向的文件不存在:${measurePath}`);
    const raw = JSON.parse(readFileSync(measurePath, 'utf8')) as Record<string, unknown>;
    const bag = numbers as unknown as Record<string, unknown>;
    for (const k of Object.keys(numbers)) {
      const v = raw[k];
      if (v !== undefined && v !== null) bag[k] = v;
    }
    /* JSON 里可能带 `ledger`(verify 用 `backlog.ts` 的解析器算的);没有才现跑。 */
    if (numbers.ledger === null) numbers.ledger = measureLedger(root);
    return { numbers, source: `--measure ${measurePath}`, notes };
  }

  const gate = readGate(root, gateLog);
  const parsed = parseGate(gate.text);
  const bag = numbers as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed.numbers)) bag[k] = v;
  if (parsed.missing.length > 0) {
    notes.push(`门禁输出里解析不到:${parsed.missing.join(' / ')} ⇒ 这些字段本次未校验`);
  }
  if (gate.exitCode !== null && gate.exitCode !== 0) {
    notes.push(`门禁本次退出码 ${gate.exitCode}(结论未必可信;只能保证「解析得到的就是当时的实测」)`);
  }
  /* 台账:门禁不打印四个数,直接问唯一口径来源(`backlog.ts` 约 0.1s)。 */
  if (numbers.ledger === null) numbers.ledger = measureLedger(root);
  return { numbers, source: gate.source, notes };
}

/* ───────────────────────── 文档锚点表 ───────────────────────── */

type DocFile = 'README.md' | 'docs/HANDOVER.md';

interface Anchor {
  file: DocFile;
  /** 报错里用的字段名(必须让人一眼定位到文档哪一处)。 */
  name: string;
  /** 必须带 `g`。捕获组 = 我要同步的那些数字,顺序与 `want` 对齐。 */
  re: RegExp;
  /** 每个捕获组的应写值;`null` = 本次未测量,该组不动。 */
  want?: (n: Numbers) => (string | null)[];
  /** 整段替换(与 `want` 二选一):用于要补/重排文字的锚点。`null` = 未测量。 */
  render?: (n: Numbers) => string | null;
}

/** `欠账构成` 那一行的固定五桶句式(verify.ts 的 checkDocs 也按这个形状解析)。 */
function debtLine(d: Debt): string | null {
  if (d.dependency > 0 || d.other > 0) return null;
  return `欠账构成:等客户端入口 ${d.clientShell} / 等编排层接线 ${d.wiring}`
    + ` / 等服务端机制 ${d.mechanism} / 等客户端机制 ${d.clientMech}`
    + ` / 等裁决 ${d.decision}`;
}

const ANCHORS: Anchor[] = [
  /* ── README:首段与门禁块 ── */
  {
    file: 'README.md',
    name: '首段文档结构份数',
    re: /冻结不变量 \+ (\d+) 份文档结构/g,
    want: (n) => [s(n.docStruct)],
  },
  {
    file: 'README.md',
    name: '冻结层不变量',
    re: /冻结层不变量\s+(\d+)\/(\d+)/g,
    want: (n) => [s(n.frozen), s(n.frozen)],
  },
  {
    file: 'README.md',
    name: 'WS 文档结构',
    re: /WS 文档结构\s+(\d+)\/(\d+)/g,
    want: (n) => [s(n.docStruct), s(n.docStruct)],
  },
  {
    file: 'README.md',
    name: '内容基线指纹',
    re: /内容基线锁[^\n]*?指纹 (v\d+-[0-9a-f]{8})/g,
    want: (n) => [n.fingerprint],
  },
  {
    file: 'README.md',
    name: '内容基线可用号',
    re: /可用号 (\d+)/g,
    want: (n) => [s(n.freeIds)],
  },
  {
    file: 'README.md',
    name: '可擦除语法目录数',
    re: /可擦除语法[^\n]*?(\d+) 个目录/g,
    want: (n) => [s(n.strippableDirs)],
  },
  {
    file: 'README.md',
    name: '装饰器例外',
    re: /装饰器例外 (\d+) 处/g,
    want: (n) => [s(n.decoratorExempt)],
  },
  {
    file: 'README.md',
    name: '跨 WS 集成',
    re: /跨 WS 集成\s+(\d+)\/(\d+)/g,
    want: (n) => [s(n.crossWs), s(n.crossWs)],
  },

  /* ── README:用例汇总(四项一起 —— 只比总数会漏「分部错但合计对」) ── */
  {
    file: 'README.md',
    name: '测试执行 / 用例总数',
    re: /测试执行\s+(\d+)\/(\d+)[ \t]*✅[ \t]*共[ \t]*(\d+)[ \t]*个用例/g,
    want: (n) => (n.suites === null
      ? [null, null, null]
      : [s(n.suites.suites), s(n.suites.suites), s(n.suites.total)]),
  },
  {
    file: 'README.md',
    name: 'WS 编号套件',
    re: /WS 编号套件\s+(\d+) 条 \/ (\d+) 套件/g,
    want: (n) => (n.suites === null
      ? [null, null]
      : [s(n.suites.wsTotal), s(n.suites.wsSuites)]),
  },
  {
    file: 'README.md',
    name: '基座套件',
    re: /基座\([^)\n]*\)\s+(\d+) 条 \/ (\d+) 套件/g,
    want: (n) => (n.suites === null
      ? [null, null]
      : [s(n.suites.fndTotal), s(n.suites.fndSuites)]),
  },

  /* ── README:台账 / 可达性 / 欠账构成 ── */
  {
    file: 'README.md',
    name: '未决台账',
    re: /未决台账\s+(\d+) 条[^\n]*?\((\d+) 未关闭 \/ \*\*(\d+) 阻塞\*\* \/ (\d+) 已关闭/g,
    want: (n) => (n.ledger === null
      ? [null, null, null, null]
      : [s(n.ledger.total), s(n.ledger.open), s(n.ledger.blocking), s(n.ledger.closed)]),
  },
  {
    file: 'README.md',
    name: '生产可达性',
    re: /生产可达性\s+(\d+)\/(\d+)[^\n]*?不可达 (\d+) 条 = 白名单 (\d+) 条/g,
    want: (n) => (n.reach === null
      ? [null, null, null, null]
      : [s(n.reach.reachable), s(n.reach.total), s(n.reach.unreachable), s(n.reach.whitelist)]),
  },
  {
    file: 'README.md',
    name: '欠账构成(五桶)',
    re: /欠账构成:[^\n]*?等裁决 \d+/g,
    render: (n) => (n.debt === null ? null : debtLine(n.debt)),
  },
  {
    file: 'README.md',
    name: '欠账 / 非欠账 / 差集构成',
    re: /\*\*\d+ 条中 \d+ 条是欠账\*\*[^\n]*?另 \*\*\d+ 条非欠账\*\*(?:\(其中差集 \*\*\d+\*\* 条 \/ gate-only \*\*\d+\*\* 条\))?。/g,
    render: (n) => {
      const r = n.reach;
      if (r === null || n.nonDebt === null || n.diffSet === null) return null;
      const debt = r.whitelist - n.nonDebt;
      if (debt < 0) return null;
      return `**${r.whitelist} 条中 ${debt} 条是欠账**(有实现、有测试、没有生产入口),`
        + `另 **${n.nonDebt} 条非欠账**(其中差集 **${n.diffSet}** 条 / `
        + `gate-only **${n.nonDebt - n.diffSet}** 条)。`;
    },
  },

  /* ── README:其余门禁行 ── */
  {
    file: 'README.md',
    name: '入口执行层',
    re: /入口执行层\s+(\d+) 个[^\n]*?成功路径为空 (\d+) 个/g,
    want: (n) => (n.inert === null
      ? [null, null]
      : [s(n.inert.registered), s(n.inert.emptySuccess)]),
  },
  {
    file: 'README.md',
    name: '同义反复候选',
    re: /同义反复候选\s+(\d+) 条[^\n]*?白名单 (\d+) 条/g,
    want: (n) => (n.taut === null ? [null, null] : [s(n.taut.hit), s(n.taut.whitelist)]),
  },
  {
    file: 'README.md',
    name: '信任边界取自客户端处数',
    re: /信任边界[^\n]*?取自客户端 (\d+) 处/g,
    want: (n) => [s(n.trustFromClient)],
  },

  /* ── README:全仓规模(五源口径) ── */
  {
    file: 'README.md',
    name: '全仓行数 / .ts 计数',
    re: /全仓约 \*\*([\d.]+) 万行 TypeScript\*\*[^\n]*?含 \*\*(\d+)\*\* 份测试套件[^\n]*?共 \*\*(\d+) 个\*\*[^\n]*?测试 (\d+) \/ 服务端 (\d+) \/ 客户端 (\d+) \/ 脚本 (\d+) \/ 共享 (\d+)/g,
    want: (n) => (n.src === null
      ? [null, null, null, null, null, null, null, null]
      : [
        (n.src.lines / 10000).toFixed(1), s(n.src.tests),
        s(n.src.total), s(n.src.tests), s(n.src.server), s(n.src.client),
        s(n.src.scripts), s(n.src.shared),
      ]),
  },

  /* ── HANDOVER §一 / §三 / §九 ── */
  {
    file: 'docs/HANDOVER.md',
    name: '§一 测试套件数',
    re: /^\| 测试 \| `tests\/\*\.test\.ts` \*\*(\d+)\*\* 个套件/mg,
    want: (n) => (n.suites === null ? [null] : [s(n.suites.suites)]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§一 生产 .ts 合计',
    re: /服务端 `server\/src` \*\*(\d+)\*\* `\.ts` · 客户端 `client\/src` \*\*(\d+)\*\* · 共享 `shared` \*\*(\d+)\*\* ⇒ \*\*生产 \.ts 合计 (\d+)\*\*/g,
    want: (n) => (n.src === null
      ? [null, null, null, null]
      : [s(n.src.prodServer), s(n.src.prodClient), s(n.src.prodShared), s(n.src.prodTotal)]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§一 装饰器例外',
    re: /装饰器例外 \*\*(\d+)\*\* 处/g,
    want: (n) => [s(n.decoratorExempt)],
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 用例',
    re: /^\| 用例 \| \*\*(\d+) 条 \/ (\d+) 套件\*\* \| WS (\d+) 条 \/ (\d+) 套件 · 基座 FND (\d+) 条 \/ (\d+) 套件/mg,
    want: (n) => (n.suites === null
      ? [null, null, null, null, null, null]
      : [
        s(n.suites.total), s(n.suites.suites), s(n.suites.wsTotal),
        s(n.suites.wsSuites), s(n.suites.fndTotal), s(n.suites.fndSuites),
      ]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 门禁自检',
    re: /^\| 门禁自检 \| \*\*(\d+)\/(\d+)\*\*/mg,
    want: (n) => ((n.selfcheck === null ? [null, null] : [s(n.selfcheck.passed), s(n.selfcheck.total)])),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 跨 WS 集成',
    re: /^\| 跨 WS 集成 \| (\d+)\/(\d+)/mg,
    want: (n) => [s(n.crossWs), s(n.crossWs)],
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 冻结层不变量',
    re: /^\| 冻结层不变量 \| (\d+)/mg,
    want: (n) => [s(n.frozen)],
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 生产可达性',
    re: /^\| 生产可达性 \| \*\*(\d+) \/ (\d+)\*\*\(不可达 (\d+) = 白名单 (\d+)/mg,
    want: (n) => (n.reach === null
      ? [null, null, null, null]
      : [s(n.reach.reachable), s(n.reach.total), s(n.reach.unreachable), s(n.reach.whitelist)]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 生产可达性 · 欠账构成',
    re: /欠账构成:[^\n]*?等裁决 \d+/g,
    render: (n) => (n.debt === null ? null : debtLine(n.debt)),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 同义反复候选',
    re: /^\| 同义反复候选 \| \*\*(\d+) 条\*\*\(白名单 (\d+)\)/mg,
    want: (n) => (n.taut === null ? [null, null] : [s(n.taut.hit), s(n.taut.whitelist)]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 类型检查基线',
    re: /^\| 类型检查基线 \| \*\*(\d+) 条 \/ 指纹 (\d+)\*\*/mg,
    want: (n) => (n.typecheck === null
      ? [null, null]
      : [s(n.typecheck.errors), s(n.typecheck.fingerprints)]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 未决台账',
    re: /^\| 未决台账 \| \*\*(\d+) 条\*\*\((\d+) 未关闭 \/ \*\*(\d+) 阻塞\*\* \/ (\d+) 已关闭\)/mg,
    want: (n) => (n.ledger === null
      ? [null, null, null, null]
      : [s(n.ledger.total), s(n.ledger.open), s(n.ledger.blocking), s(n.ledger.closed)]),
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§三 PROGRESS 陷阱',
    re: /^\| PROGRESS 陷阱 \|[^\n]*\|/mg,
    render: (n) => {
      const p = n.progress;
      if (p === null) return null;
      return `| PROGRESS 陷阱 | **${p.sections} 节 / ${p.first}..${p.last}**`
        + ` | 严格递增 ${p.increasing ? '✓' : '✗'} / 无缺号 ${p.noGap ? '✓' : '✗'}`
        + ` / 无 BOM ${p.hasBom ? '✗' : '✓'} / ${p.bytes} 字节 |`;
    },
  },
  {
    file: 'docs/HANDOVER.md',
    name: '§九 backlog 行',
    re: /node scripts\/backlog\.ts[ \t]+# (\d+) 条 \/ (\d+) 未关闭 \/ (\d+) 阻塞/g,
    want: (n) => (n.ledger === null
      ? [null, null, null]
      : [s(n.ledger.total), s(n.ledger.open), s(n.ledger.blocking)]),
  },
];

/* ───────────────────────── §九 sha256 表 ───────────────────────── */

/**
 * 表里**必须**有这 7 行(期望集合写死在这里,而不是「表里有什么就查什么」——
 * 否则删一行 = 少查一个文件 = 静默通过)。`docs/HANDOVER.md` 自己不进表:
 * 它就是被校验的对象,任何写入都会改变它自己的哈希 ⇒ 自校验不可能。
 */
const HASH_FILES = [
  'README.md',
  'docs/PROGRESS.md',
  'docs/LEAD-PLAN.md',
  'docs/ARCH-GAPS.md',
  'docs/CHANGE_REQUESTS.md',
  'docs/COMPLETION-CRITERIA.md',
  'docs/TASK-83-wasd-three-options.md',
];

/** LF 归一后的 sha256 前 12 位(= 索引 blob 的口径,与检出时的 CRLF/LF 无关)。 */
const lfHash = (text: string): string =>
  createHash('sha256').update(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')).digest('hex').slice(0, 12);

interface HashScan { text: string; findings: Finding[]; errors: string[] }

function processHashes(text: string, root: string, readmeNext: string): HashScan {
  const findings: Finding[] = [];
  const errors: string[] = [];
  const rows = [...text.matchAll(/^([0-9a-f]{12})([ \t]+)(\S+\.md)[ \t]*$/gm)];
  if (rows.length === 0) {
    errors.push('docs/HANDOVER.md §九:找不到 sha256 表(12 位十六进制 + .md 的行)');
    return { text, findings, errors };
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const file = r[3]!;
    if (seen.has(file)) errors.push(`§九 sha256 表:出现重复行 ${file}`);
    seen.add(file);
    if (file === 'docs/HANDOVER.md') errors.push('§九 sha256 表:HANDOVER.md 自己进了表(自校验不可能)');
  }
  for (const f of HASH_FILES) {
    if (!seen.has(f)) errors.push(`§九 sha256 表:缺行 ${f}(删行就能让本检查变绿 ⇒ 必须显式补齐)`);
  }
  for (const f of seen) {
    if (!HASH_FILES.includes(f)) {
      errors.push(`§九 sha256 表:未预期行 ${f}(加文件要同步改 sync-docs.ts 的 HASH_FILES)`);
    }
  }

  const edits: { at: number; len: number; next: string }[] = [];
  for (const r of rows) {
    const file = r[3]!;
    const abs = join(root, file);
    if (!existsSync(abs) && file !== 'README.md') {
      errors.push(`§九 sha256 表:${file} 不存在`);
      continue;
    }
    const actual = lfHash(file === 'README.md' ? readmeNext : readFileSync(abs, 'utf8'));
    const line = text.slice(0, r.index).split('\n').length;
    if (r[1] !== actual) {
      findings.push({ file: 'docs/HANDOVER.md', line, name: `§九 sha256 · ${file}`, doc: r[1]!, want: actual });
      edits.push({ at: r.index, len: 12, next: actual });
    }
  }
  edits.sort((a, b) => b.at - a.at);
  let next = text;
  for (const e of edits) next = next.slice(0, e.at) + e.next + next.slice(e.at + e.len);
  return { text: next, findings, errors };
}

/* ───────────────────────── 锚点比对 / 应用 ───────────────────────── */

interface Finding { file: DocFile; line: number; name: string; doc: string; want: string }
interface AnchorScan { text: string; findings: Finding[]; skipped: string[]; errors: string[] }

/**
 * 一趟扫描:比对 + 生成「写回后的文本」。
 * ⚠️ 匹配一律对着**原始文本**做,替换偏移最后统一倒序施加 ——
 *    这样多锚点之间的偏移不会互相污染。
 */
function processAnchors(file: DocFile, text: string, n: Numbers): AnchorScan {
  const findings: Finding[] = [];
  const errors: string[] = [];
  const skipped = new Set<string>();
  const edits: { at: number; len: number; next: string }[] = [];

  for (const a of ANCHORS.filter((x) => x.file === file)) {
    const ms = [...text.matchAll(a.re)];
    if (ms.length === 0) {
      errors.push(`${file} · ${a.name}:找不到锚点(文档形状被改过 ⇒ 无法生成;锚点见 scripts/sync-docs.ts)`);
      continue;
    }
    if (ms.length > 1) {
      errors.push(`${file} · ${a.name}:锚点出现 ${ms.length} 处(影子行:多一处就会让真行静默通过)`);
      continue;
    }
    const m = ms[0]!;
    const line = text.slice(0, m.index).split('\n').length;

    if (a.render !== undefined) {
      const next = a.render(n);
      if (next === null) { skipped.add(`${file} · ${a.name}`); continue; }
      if (next !== m[0]) findings.push({ file, line, name: a.name, doc: m[0].trim(), want: next.trim() });
      edits.push({ at: m.index, len: m[0].length, next });
      continue;
    }

    const wants = a.want === undefined ? [] : a.want(n);
    if (wants.length !== m.length - 1) {
      errors.push(
        `${file} · ${a.name}:正则捕获组 ${m.length - 1} 个,但期望值 ${wants.length} 个`
        + '(sync-docs.ts 自己的 bug)',
      );
      continue;
    }
    let cursor = 0;
    let rebuilt = '';
    let changed = false;
    let locFailed = false;
    for (let g = 1; g < m.length; g++) {
      const docVal = m[g];
      if (docVal === undefined) continue;
      const at = m[0].indexOf(docVal, cursor);
      if (at < 0) { locFailed = true; break; }
      rebuilt += m[0].slice(cursor, at);
      const want = wants[g - 1];
      if (want === null || want === undefined) {
        rebuilt += docVal;
        skipped.add(`${file} · ${a.name}`);
      } else {
        rebuilt += want;
        if (want !== docVal) {
          changed = true;
          findings.push({ file, line, name: a.name, doc: docVal, want });
        }
      }
      cursor = at + docVal.length;
    }
    if (locFailed) {
      errors.push(`${file} · ${a.name}:定位捕获组失败(sync-docs.ts 自己的 bug)`);
      continue;
    }
    rebuilt += m[0].slice(cursor);
    if (changed) edits.push({ at: m.index, len: m[0].length, next: rebuilt });
  }

  /* ★ 重叠自检:两个锚点若匹配到同一段文本,倒序拼接会**互相覆盖** ——
     实测过(内容基线锁那一行同时被「指纹」与「可用号」两个锚点命中):
     结果是少改一处,而且**第一次运行看起来成功**、第二次运行才发现不一致。
     ⇒ 这类结构错误必须当场红,不许留给「复扫」去发现。 */
  edits.sort((a, b) => a.at - b.at);
  for (let i = 1; i < edits.length; i += 1) {
    const prev = edits[i - 1]!;
    const cur = edits[i]!;
    if (cur.at < prev.at + prev.len) {
      errors.push(
        `${file}:两个锚点的匹配区间重叠(${prev.at}..${prev.at + prev.len} 与 ${cur.at}..${cur.at + cur.len})`
        + ' ⇒ 写回会互相覆盖;请把窄锚点改成不覆盖宽锚点的形状',
      );
      return { text, findings, skipped: [...skipped], errors };
    }
  }
  edits.sort((a, b) => b.at - a.at);
  let next = text;
  for (const e of edits) next = next.slice(0, e.at) + e.next + next.slice(e.at + e.len);
  return { text: next, findings, skipped: [...skipped], errors };
}

/* ───────────────────────── CLI ───────────────────────── */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  if (hit !== undefined) return hit.slice(pref.length);
  const i = argv.indexOf(`--${name}`);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : undefined;
}

const HINT = '跑 `node scripts/sync-docs.ts --write` 修';

function usage(): void {
  console.log([
    '用法:',
    '  node scripts/sync-docs.ts --check                 # 不写盘,只回答"会不会变"',
    '  node scripts/sync-docs.ts --write                 # 写回(幂等)',
    '  node scripts/sync-docs.ts --emit-measure          # 打印测量快照(JSON)',
    '选项:',
    '  --gate-log=<file>  复用一次已有的 `verify --all` 输出(不重跑门禁)',
    '  --measure=<json>   用 JSON 快照(verify.ts 调用本文件时用;不 spawn 子进程)',
    '  --root=<dir>       换一棵树(测试用;默认本仓)',
  ].join('\n'));
}

function main(): void {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const emit = argv.includes('--emit-measure');
  if (!write && !check && !emit) { usage(); process.exitCode = 2; return; }
  if (write && check) {
    console.error('  ✗ --write 与 --check 不能同时给(口径歧义)');
    process.exitCode = 2;
    return;
  }

  const root = flagValue('root') ?? REPO_ROOT;
  const gateLog = flagValue('gate-log');
  const measurePath = flagValue('measure');
  if (gateLog !== undefined && measurePath !== undefined) {
    console.error('  ✗ --gate-log 与 --measure 不能同时给(两个测量源)');
    process.exitCode = 2;
    return;
  }

  let measured: Measured;
  try {
    measured = buildNumbers(root, gateLog, measurePath);
  } catch (e) {
    console.error(`  ✗ 测量失败:${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const n = measured.numbers;

  if (emit) {
    console.log(JSON.stringify(n, null, 2));
    return;
  }

  console.log(`[sync-docs] ${write ? '--write' : '--check'} · 测量源:${measured.source}`);
  for (const note of measured.notes) console.log(`  · ${note}`);

  const readmePath = join(root, 'README.md');
  const handoverPath = join(root, 'docs', 'HANDOVER.md');
  if (!existsSync(readmePath) || !existsSync(handoverPath)) {
    console.error(`  ✗ 找不到 README.md / docs/HANDOVER.md(根目录:${root})`);
    process.exitCode = 1;
    return;
  }

  const r = processAnchors('README.md', readFileSync(readmePath, 'utf8'), n);
  const h = processAnchors('docs/HANDOVER.md', readFileSync(handoverPath, 'utf8'), n);
  /* §九 的 README 行必须算「写回后的 README」:否则一次写入会同时报
     「数字不一致」与「哈希不一致」,而它们其实是同一件事。 */
  const hs = processHashes(h.text, root, r.text);

  const findings = [...r.findings, ...h.findings, ...hs.findings];
  const errors = [...r.errors, ...h.errors, ...hs.errors];
  const skipped = [...new Set([...r.skipped, ...h.skipped])];

  console.log(
    `  锚点 ${ANCHORS.length} 处 · 已比对 ${ANCHORS.length - skipped.length} 项`
    + ` · 未校验 ${skipped.length} 项 · §九 哈希表 ${HASH_FILES.length} 行`,
  );
  for (const sk of skipped) console.log(`  · 未校验:${sk}(本次没有测量源 ⇒ 不比对,也不当成通过)`);
  for (const f of findings) {
    console.log(`  ✗ ${f.file}:${f.line} · ${f.name}:文档写「${f.doc}」 ⇒ 应写「${f.want}」`);
  }
  for (const e of errors) console.log(`  ✗ ${e}`);

  if (errors.length > 0) {
    console.error(`  ✗ ${errors.length} 处锚点/表结构错误 —— 未写盘(先修锚点:`);
    console.error('     锚点定义在 scripts/sync-docs.ts 的 ANCHORS / HASH_FILES)');
    process.exitCode = 1;
    return;
  }

  if (!write) {
    if (findings.length === 0) {
      /* ⚠️ 「无变化」与「全部都比过了」是两件事:有字段没测量源时,
         这句话必须**自报**它没覆盖什么,否则它就是「没查」伪装成「查过了」。 */
      console.log(skipped.length === 0
        ? '  ✓ 无变化(全部锚点都已比对;再跑 --write 也不会改盘)'
        : `  ✓ 无变化,但 ${skipped.length} 项**未校验 ⇒ 不是通过**(没有测量源时那一栏没人看)`);
      return;
    }
    console.error(`  ✗ ${findings.length} 处文档数字与实测不一致 —— ${HINT}`);
    process.exitCode = 1;
    return;
  }

  /* ── --write ── */
  if (r.text !== readFileSync(readmePath, 'utf8')) writeFileSync(readmePath, r.text, 'utf8');
  if (hs.text !== readFileSync(handoverPath, 'utf8')) writeFileSync(handoverPath, hs.text, 'utf8');

  /* 收敛自检:写回后**再扫一遍**必须零 findings、零 errors。
     否则说明锚点会互相翻改(写两次结果不同)⇒ 当场红,而不是留给下一次运行发现。 */
  const r2 = processAnchors('README.md', readFileSync(readmePath, 'utf8'), n);
  const h2 = processAnchors('docs/HANDOVER.md', readFileSync(handoverPath, 'utf8'), n);
  const hs2 = processHashes(h2.text, root, r2.text);
  const left = [...r2.findings, ...h2.findings, ...hs2.findings, ...r2.errors, ...h2.errors, ...hs2.errors];
  if (left.length > 0) {
    console.error('  ✗ 写回**不收敛**(再扫一遍仍有差异 ⇒ 锚点互相翻改):');
    for (const f of left) {
      if (typeof f === 'string') console.error(`      ${f}`);
      else console.error(`      ${f.file}:${f.line} · ${f.name}:${f.doc} ⇒ ${f.want}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ 已写回 ${findings.length} 处(README.md / docs/HANDOVER.md);复扫零差异 ⇒ 幂等`);
}

if (import.meta.main) main();