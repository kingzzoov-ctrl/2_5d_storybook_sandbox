/**
 * WS-FND-128 —— **手工快照不变量自检**(可被门禁直接调用的那一步)。
 *
 * ## 它做什么
 *
 * ```text
 * 一组**手工构造**的快照(1 个正例 + 8 个反例,每个反例只踩一条不变量)
 *   ⇒ 跑 `server/src/invariants.ts` 的全部 8 条
 *   ⇒ 打印:每条反例被哪一条抓到、是不是**只**被那一条抓到、
 *            以及「把那条改成恒真之后它还抓不抓得到」
 * ```
 *
 * ## 为什么反例要「只踩一条」,而且还要做**注入**
 *
 * ```text
 * 只断言「反例被抓到了」是不够的 —— 那可能与这条判据无关:
 *   · 反例可能**顺手**踩了别的条目(抓到它的不是我想证明的那一条);
 *   · 那条判据可能**本来就是恒真的**(「抓到」这件事与它无关);
 *   · 它甚至可能**恒假**(任何快照都报违反 ⇒ 它没有区分力)。
 * ⇒ 故三条断言一起上:
 *   1 caught        该反例确实被抓到,且 detail 指到了具体 id / 差值;
 *   2 onlyExpected  违规集合**恰好**是 {该条} ⇒ 归因唯一(不是被别的条目顺手抓到);
 *   3 injected      把该条换成**恒真** ⇒ 不再被抓到 ⇒ 抓到它的正是这一条(有牙)。
 *   ── 另有正例侧的反向断言:正例快照下 8 条**全过** ⇒ 没有一条是恒假。
 * ```
 *
 * ## 接进门禁(改的是 `scripts/verify.ts`,本文件不动它)
 *
 * ```text
 * 位置:`scripts/verify.ts` 的 import 区(第 31 行 `import { DamageKind, ITEM } ...` 之后)
 *   +  `scripts/verify.ts` 的 main 里第 8097 行 `if (!frozenOnly && !only) checkBomGuard();` 之后
 * 三行改法:
 *   1  import { runSelfcheck } from './invariants.ts';
 *   2  if (!frozenOnly && !only) { const inv = runSelfcheck(); if (!inv.ok) fail(`不变量自检 ${inv.summaryLine}`); else pass(`不变量自检 ${inv.summaryLine}`); }
 * ```
 * ⚠️ 用**进程内调用**(而不是 `spawnSync`)的理由:本自检是纯函数(不读盘、不启子进程),
 *   进程内调用会把它算进 `pass`/`fail` 计数与退出码 ——
 *   子进程形态在"脚本被删"时会静默变成「没跑」。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/invariants.ts          # 人读输出;不通过则 exit 1
 * node scripts/invariants.ts --json   # 机读:整份 SelfcheckReport
 * ```
 */

import {
  INVARIANT_CODES,
  checkAll,
  registryProblems,
  summarize,
} from '../server/src/invariants.ts';
import type {
  InvariantCheck,
  InvariantCode,
  InvariantResult,
  InvSnapshot,
} from '../server/src/invariants.ts';

/* ═══════════════════════ 1 正例快照 ═══════════════════════ */

/**
 * 一份**自洽**的快照:8 条不变量全部成立。
 *
 * ⚠️ 每次调用都新建对象 —— 反例是**从这个正例派生**的(改一处),
 *   共用一个可变对象会让「反例只踩一条」这件事失效(污染会串台)。
 *
 * 数值都是**刻意选在边界上**的:
 * ```text
 * chest_1  2/2        容器「恰好装满」必须**通过**(≤ 不是 <)
 * frame    900/1200   有余量;上界边界另有单测(容差取 0)
 * m2       alive:false + DEAD   「互斥」的正例形态
 * p2       BUBBLED    单独一个状态位是合法的(互斥只在**同时**成立时违反)
 * ```
 */
export function goodSnapshot(): InvSnapshot {
  return {
    tick: 420,
    map: { w: 32, h: 32, maxZ: 8 },
    frame: { bytes: 900, maxBytes: 1200 },
    bodies: [
      { id: 'p1', kind: 'player', pos: { x: 8.5, y: 4.5, z: 0 }, alive: true, states: [] },
      { id: 'p2', kind: 'player', pos: { x: 12.5, y: 4.5, z: 0 }, alive: true, states: ['BUBBLED'] },
      { id: 'm1', kind: 'mob', pos: { x: 6, y: 9, z: 0 }, alive: true, states: ['STUNNED'] },
      { id: 'm2', kind: 'mob', pos: { x: 7, y: 9, z: 0 }, alive: false, states: ['DEAD'] },
      { id: 'drop_1', kind: 'item', pos: { x: 10, y: 10, z: 0.5 }, alive: true, states: [] },
    ],
    containers: [
      { id: 'bag_p1', capacity: 12, byItem: { '101': 3, '435': 1 }, total: 4 },
      { id: 'bag_p2', capacity: 12, byItem: {}, total: 0 },
      { id: 'chest_1', capacity: 2, byItem: { '712': 2 }, total: 2 },
    ],
    ledger: {
      entries: [
        { id: 'craft_1', delta: 2, balance: 2 },
        { id: 'trade_1', delta: -1, balance: 1 },
      ],
      perItem: { '116': 1, '125': 1 },
      total: 2,
    },
    sideTables: [
      { name: 'carry', keys: ['p1'] },
      { name: 'partyTeam', keys: ['p1', 'p2'] },
      { name: 'cooldown', keys: ['p1', 'm1'] },
      { name: 'lootOwner', keys: ['drop_1'] },
    ],
    knownIds: ['p1', 'p2', 'm1', 'm2', 'drop_1', 'bag_p1', 'bag_p2', 'chest_1', 'craft_1', 'trade_1'],
  };
}

/* ═══════════════════════ 2 反例(每个只踩一条)═══════════════════════ */

/** 一个反例:从正例派生、**只**踩 `code` 这一条,并说明「破了会怎样」。 */
export interface ViolationCase {
  code: InvariantCode;
  name: string;
  why: string;
  /** 造出这份违规快照(每次都从 `goodSnapshot()` 派生 ⇒ 互不污染)。 */
  make: () => InvSnapshot;
}

/**
 * 8 个反例,与 `INVARIANT_CODES` **一一对应**(少一条就有一条没牙)。
 *
 * ⚠️ 「只踩一条」是**设计约束**,不是巧合:注入验证(3 条断言里的第 3 条)
 *   要求违规集合恰好是 `{code}` —— 顺手踩到别的条目会让归因不唯一,
 *   那时该修的是**反例**,不是放宽断言。
 */
export const VIOLATION_CASES: readonly ViolationCase[] = [
  {
    code: 'POS_FINITE_IN_BOUNDS',
    name: 'NaN 坐标 + 越界刚体',
    why: 'NaN 会静默污染物理与存档;越界的刚体永远走不回可行域(它连碰撞都算不出)',
    make: () => {
      const s = goodSnapshot();
      s.bodies[2]!.pos = { x: Number.NaN, y: 9, z: 0 };
      s.bodies[3]!.pos = { x: 40, y: 9, z: 0 };
      return s;
    },
  },
  {
    code: 'BODY_ID_UNIQUE',
    name: '同一 id 两个刚体',
    why: '旁表 / 存档 / 网络都按 id 找刚体 ⇒ 指向谁变成非确定(且随遍历顺序变)',
    make: () => {
      const s = goodSnapshot();
      s.bodies.push({ id: 'm1', kind: 'mob', pos: { x: 9, y: 9, z: 0 }, alive: true, states: [] });
      return s;
    },
  },
  {
    code: 'CONTAINER_CAPACITY',
    name: '箱子装 3 件而容量 2(按件与总量**一致**地超)',
    why: '两个账都超容量 ⇒ 溢出件要么在下一次落盘时凭空消失,要么无限增长',
    make: () => {
      const s = goodSnapshot();
      const chest = s.containers[2]!;
      chest.byItem['712'] = 3;
      chest.total = 3;
      return s;
    },
  },
  {
    code: 'LEDGER_NON_NEGATIVE',
    name: '账目结余为 -1',
    why: '负结余 = 凭空多出来的东西,而且会一路传下去(取物/合成都不再需要余额)',
    make: () => {
      const s = goodSnapshot();
      s.ledger.entries[1]!.balance = -1;
      return s;
    },
  },
  {
    code: 'PER_ITEM_MATCHES_TOTAL',
    name: '账本按件多出一件、总量账没跟',
    why: '两个数各说各话 ⇒ 按件账越多,越容易「总量看起来没超容量」',
    make: () => {
      const s = goodSnapshot();
      s.ledger.perItem['712'] = 2;
      return s;
    },
  },
  {
    code: 'STATE_EXCLUSION',
    name: '同一刚体同时 BUBBLED + STUNNED',
    why: '两个状态各自的控制流会互相抵消(解除条件互不等价 ⇒ 有一个永远清不掉)',
    make: () => {
      const s = goodSnapshot();
      s.bodies[0]!.states = ['BUBBLED', 'STUNNED'];
      return s;
    },
  },
  {
    code: 'SIDE_TABLE_KEYS',
    name: '旁表指向不存在的 id',
    why: '悬空 key ⇒ 查表拿到 undefined(或留下一辈子清不掉的残留项)',
    make: () => {
      const s = goodSnapshot();
      s.sideTables.push({ name: 'carry', keys: ['p1', 'ghost_9'] });
      return s;
    },
  },
  {
    code: 'FRAME_BYTES_BOUND',
    name: '单帧字节超上界 1 字节',
    why: '差 1 字节就够了:带宽预算被击穿时服务端一切正常,客户端只是卡',
    make: () => {
      const s = goodSnapshot();
      s.frame.bytes = s.frame.maxBytes + 1;
      return s;
    },
  },
];

/* ═══════════════════════ 2b 分支级反例(第十轮补)═══════════════════════ */

/**
 * 一个**分支级**反例:它不新增 `InvariantCode`,只把某个 code 内部的一个**数据分支**
 * 或某个**运行时守卫**(注册表自证 / `overrides` 拼错)单独钉住。
 *
 * ⚠️ 「每 code 一个 `VIOLATION_CASES`」只保证「这条判据**整体**有没有牙」——
 *   它盖不住「一条判据内部有 N 个分支,只测第一条就把整条标成有牙」。
 *   本表就是第十轮点到的那批分支的判据:非法地图 / 非法容量 / `maxBytes<=0` /
 *   重复 code / `overrides` 拼错。
 */
export interface BranchCase {
  /** 归属:哪一条不变量,或哪个运行时守卫。 */
  owner: string;
  name: string;
  why: string;
  /** 数据分支:期望被 `code` 抓到。 */
  make?: () => InvSnapshot;
  code?: InvariantCode;
  /** 运行时守卫:期望**抛**。 */
  trigger?: () => void;
  /** 与 `trigger` 成对的**负对照**:合法形态,期望**不**抛。 */
  control?: () => void;
}

/** 一份「键集与 `INVARIANT_CODES` 完全一致」的占位注册表(只作 `registryProblems` 的对照侧)。 */
function fullChecks(): Record<string, InvariantCheck> {
  const out: Record<string, InvariantCheck> = {};
  for (const c of INVARIANT_CODES) out[c] = () => ({ ok: true, code: c, detail: '占位' });
  return out;
}

export const BRANCH_CASES: readonly BranchCase[] = [
  {
    owner: 'POS_FINITE_IN_BOUNDS',
    name: '非法地图(h 非有限)⇒ 必须先报「判不了」',
    why: '地图边界本身非法时「越界」比较恒假 ⇒ 这一条会对所有坐标放行(那不是「没有越界」)',
    code: 'POS_FINITE_IN_BOUNDS',
    make: () => { const s = goodSnapshot(); s.map.h = Number.NaN; return s; },
  },
  {
    owner: 'CONTAINER_CAPACITY',
    name: '非法容量(NaN)⇒ 必须先报容量非法',
    why: '容量非有限时「是否溢出」无从成立 ⇒ 该条静默放行',
    code: 'CONTAINER_CAPACITY',
    make: () => { const s = goodSnapshot(); s.containers[0]!.capacity = Number.NaN; return s; },
  },
  {
    owner: 'FRAME_BYTES_BOUND',
    name: '单帧上界 maxBytes <= 0 ⇒ 必须先报上界非法',
    why: '上界非正数时这一条没有判据(0 会让任何字节都「超」,负数更荒谬)',
    code: 'FRAME_BYTES_BOUND',
    make: () => { const s = goodSnapshot(); s.frame.maxBytes = 0; return s; },
  },
  {
    owner: 'registryProblems(注册表自证)',
    name: '重复 code ⇒ 报问题(不是静默放行)',
    why: '两条同名 code 会让归因出现两个入口 ⇒ 自证必须抓它',
    trigger: () => {
      const dup = [...INVARIANT_CODES, 'BODY_ID_UNIQUE'] as InvariantCode[];
      /* 守卫「有牙」的形态是**报出问题**(返回值非空,不是抛)。这里把「报出来了」
         翻成一个哨兵抛,与 `BranchReport.caught` 的口径(期望抛)对齐。 */
      if (registryProblems(dup, fullChecks()).length > 0) throw new Error('重复 code 已被报出(守卫有牙)');
    },
    control: () => {
      /* 负对照:合法注册表**不许**报问题 ⇒ 不许抛。 */
      if (registryProblems(INVARIANT_CODES, fullChecks()).length !== 0) throw new Error('合法注册表被误报');
    },
  },
  {
    owner: 'checkAll(overrides 守卫)',
    name: 'overrides 拼错 key ⇒ 抛(不是静默失效)',
    why: '拼错的注入静默不生效 ⇒ 「注入后不再被抓到」会假绿',
    trigger: () => {
      const bad = {
        POS_FINITE_IN_BOUYNDS: forceAlwaysOk('BODY_ID_UNIQUE'),
      } as unknown as Partial<Record<InvariantCode, InvariantCheck>>;
      checkAll(goodSnapshot(), { overrides: bad });
    },
    control: () => {
      checkAll(goodSnapshot(), { overrides: { BODY_ID_UNIQUE: forceAlwaysOk('BODY_ID_UNIQUE') } });
    },
  },
];

/* ═══════════════════════ 3 注入面 ═══════════════════════ */

/**
 * 把某条判据换成**恒真**(不读快照)。
 *
 * `onCall` 用来证明注入物**真的被调用过**:若调用方把 `overrides` 接错了
 * (例如按 detail 的措辞匹配、或把 code 拼错),注入物一次都不会跑,
 * 而「注入后不再被抓到」会**恰好成立** —— 那是最危险的假绿。
 * ⇒ 故断言里带一条 `injectionUsed === 1`。
 */
export function forceAlwaysOk(code: InvariantCode, onCall?: () => void): InvariantCheck {
  return () => {
    if (onCall !== undefined) onCall();
    return { ok: true, code, detail: `注入(恒真):${code} 不读快照` };
  };
}

/* ═══════════════════════ 4 自检 ═══════════════════════ */

/** 单个反例的自检结论(逐条可读 —— 门禁只报 `ok`,人读输出要能指到哪一条没牙)。 */
export interface CaseReport {
  code: InvariantCode;
  name: string;
  why: string;
  /** 该反例确实被抓到(且 detail 非空)。 */
  caught: boolean;
  /** 实测违规集合(期望恰好 `[code]`)。 */
  failing: InvariantCode[];
  /** 归因唯一:违规集合恰好只有该条。 */
  onlyExpected: boolean;
  /** 该条给出的 detail(人读输出 / json 里带出来)。 */
  detail: string;
  /** 注入恒真之后,该条**还**报违反吗(期望 false)。 */
  injectedCaught: boolean;
  /** 注入物被调用次数(期望 1 —— 见 `forceAlwaysOk` 的说明)。 */
  injectionUsed: number;
  ok: boolean;
}

/** 单个**分支级**反例的自检结论(见 `BranchCase`)。 */
export interface BranchReport {
  owner: string;
  name: string;
  why: string;
  /** 数据分支被抓到 / 守卫真的报问题。 */
  caught: boolean;
  /** 归因唯一(数据分支)或负对照通过(守卫)。 */
  confirmed: boolean;
  /** 注入恒真后**不再**被抓到(数据分支);守卫恒为 true(= 不适用)。 */
  silenced: boolean;
  /** 注入物被调用次数(数据分支期望 1;守卫 = -1 表示不适用)。 */
  injectionUsed: number;
  detail: string;
  ok: boolean;
}

/** 整份自检结论。`--json` 输出的就是它。 */
export interface SelfcheckReport {
  ok: boolean;
  /** `N/M 通过(...)` 形态:门禁把它原样打进输出行。 */
  summaryLine: string;
  passed: number;
  total: number;
  invariantCount: number;
  positive: { ok: boolean; failing: InvariantCode[]; detail: string };
  cases: CaseReport[];
  /** ★ 第十轮:分支级反例(每 code 一个的 `cases` 盖不住的那些分支)。 */
  branches: BranchReport[];
}

/**
 * 跑完整套自检(**纯函数**:不打印、不设退出码、不读盘 ⇒ 测试与门禁共用同一份)。
 *
 * 判定的条数(见 `total`):1(正例整体)+ 8(正例逐条通过)+ 每个 code 反例 4 条
 * + 每个**分支级**反例 3 条。示例:1 + 8 + 8×4 + m×3。
 * ⚠️ 这个数是**算出来**的,不是手写的 —— 加一条不变量/反例时它自己会变。
 */
export function runSelfcheck(): SelfcheckReport {
  const goodResults: InvariantResult[] = checkAll(goodSnapshot());
  const positiveSummary = summarize(goodResults);
  const positivePassed = goodResults.filter((r) => r.ok).length;

  const cases: CaseReport[] = [];
  for (const c of VIOLATION_CASES) {
    const snap = c.make();
    const results = checkAll(snap);
    const failing = results.filter((r) => !r.ok).map((r) => r.code);
    const mine = results.find((r) => r.code === c.code);
    const caught = failing.includes(c.code) && (mine?.detail ?? '').trim().length > 0;
    const onlyExpected = caught && failing.length === 1;

    /* 注入:只替换**这一条**,其余照跑。 */
    const overrides: Partial<Record<InvariantCode, InvariantCheck>> = {};
    let injectionUsed = 0;
    overrides[c.code] = forceAlwaysOk(c.code, () => { injectionUsed += 1; });
    const injected = checkAll(snap, { overrides });
    const injectedCaught = injected.some((r) => r.code === c.code && !r.ok);
    const injectedOk = injected.find((r) => r.code === c.code)?.ok === true;

    cases.push({
      code: c.code,
      name: c.name,
      why: c.why,
      caught,
      failing,
      onlyExpected,
      detail: mine?.detail ?? '',
      injectedCaught,
      injectionUsed,
      ok: caught && onlyExpected && !injectedCaught && injectedOk && injectionUsed === 1,
    });
  }

  const branches: BranchReport[] = BRANCH_CASES.map((c) => {
    if (c.make !== undefined && c.code !== undefined) {
      const snap = c.make();
      const results = checkAll(snap);
      const failing = results.filter((r) => !r.ok).map((r) => r.code);
      const caught = failing.includes(c.code);
      const confirmed = caught && failing.length === 1;
      /* 注入:只替换**这一条** ⇒ 若这个分支正是它抓的,注入恒真后就不再被抓到。 */
      let used = 0;
      const overrides: Partial<Record<InvariantCode, InvariantCheck>> = {};
      overrides[c.code] = forceAlwaysOk(c.code, () => { used += 1; });
      const injected = checkAll(snap, { overrides });
      const silenced = !injected.some((r) => r.code === c.code && !r.ok);
      const detail = results.find((r) => r.code === c.code)?.detail ?? '';
      return {
        owner: c.owner, name: c.name, why: c.why,
        caught, confirmed, silenced, injectionUsed: used, detail,
        ok: caught && confirmed && silenced && used === 1,
      };
    }
    /* 运行时守卫:期望报问题(抛);配一条**负对照**(合法形态不许抛)。 */
    let detail = '';
    let caught = false;
    try { c.trigger!(); } catch (e) { caught = true; detail = (e as Error).message; }
    let confirmed = false;
    if (c.control !== undefined) {
      try { c.control(); confirmed = true; } catch { confirmed = false; }
    }
    return {
      owner: c.owner, name: c.name, why: c.why,
      caught, confirmed, silenced: true, injectionUsed: -1, detail,
      ok: caught && confirmed,
    };
  });

  const total = 1 + INVARIANT_CODES.length + cases.length * 4 + branches.length * 3;
  const casesPassed = cases.reduce((n, c) => n
    + (c.caught ? 1 : 0)
    + (c.onlyExpected ? 1 : 0)
    + (c.injectedCaught || c.injectionUsed !== 1 ? 0 : 1)
    + (c.injectionUsed === 1 ? 1 : 0), 0);
  const branchesPassed = branches.reduce((n, b) => n
    + (b.caught ? 1 : 0) + (b.confirmed ? 1 : 0) + (b.silenced ? 1 : 0), 0);
  const passed = (positiveSummary.ok ? 1 : 0) + positivePassed + casesPassed + branchesPassed;

  const badCases = cases.filter((c) => !c.ok).map((c) => c.code);
  const badBranches = branches.filter((b) => !b.ok).map((b) => b.name);
  const summaryLine = `${passed}/${total} 通过(正例快照 1 个 · 反例 ${cases.length} 个 · 分支 ${branches.length} 个 · 不变量 ${INVARIANT_CODES.length} 条)`
    + (badCases.length === 0 ? '' : `;没牙的条目:${badCases.join(',')}`)
    + (badBranches.length === 0 ? '' : `;没牙的分支:${badBranches.join(',')}`);

  return {
    ok: positiveSummary.ok && positivePassed === INVARIANT_CODES.length
      && badCases.length === 0 && badBranches.length === 0,
    summaryLine,
    passed,
    total,
    invariantCount: INVARIANT_CODES.length,
    positive: { ok: positiveSummary.ok, failing: positiveSummary.failed, detail: positiveSummary.detail },
    cases,
    branches,
  };
}

/* ═══════════════════════ 5 CLI ═══════════════════════ */

/** 人读输出。⚠️ 每行都带 ✓/✗ —— 失败时必须能一眼看出是哪一条没牙。 */
function printReport(r: SelfcheckReport): void {
  console.log('[不变量自检] 手工快照 × 纯函数不变量(server/src/invariants.ts)');
  console.log(`  正例快照 ${r.positive.ok ? '✓' : '✗'} ${r.positive.detail}`);
  for (const c of r.cases) {
    console.log(`  ${c.ok ? '✓' : '✗'} 反例「${c.name}」期望被 ${c.code} 抓到`);
    console.log(`      ${c.caught ? '✓' : '✗'} 抓到,违规集合 = [${c.failing.join(', ') || '无'}]`);
    console.log(`      ${c.onlyExpected ? '✓' : '✗'} 归因唯一(只被这一条抓到)`);
    console.log(`      ${c.injectedCaught ? '✗' : '✓'} 注入恒真 ⇒ 不再被抓到(注入被调用 ${c.injectionUsed} 次)`);
    console.log(`      · 为什么这条要守:${c.why}`);
    if (!c.ok) console.log(`      · detail:${c.detail}`);
  }
  for (const b of r.branches) {
    console.log(`  ${b.ok ? '✓' : '✗'} 分支「${b.name}」(${b.owner})`);
    console.log(`      ${b.caught ? '✓' : '✗'} ${b.injectionUsed === -1 ? '守卫报问题' : '被抓到'}`
      + ` · ${b.confirmed ? '✓' : '✗'} ${b.injectionUsed === -1 ? '负对照通过' : '归因唯一'}`
      + ` · ${b.silenced ? '✓' : '✗'} 注入恒真后静默(调用 ${b.injectionUsed} 次)`);
    if (!b.ok) console.log(`      · detail:${b.detail}`);
  }
  console.log(`\n[不变量自检] ${r.summaryLine}`);
}

if (import.meta.main) {
  const report = runSelfcheck();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
  else printReport(report);
  if (!report.ok) process.exitCode = 1;
}
