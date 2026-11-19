/**
 * WS-FND-141 —— **第十轮六处小修**(每一处都「看着修了其实没修」或「实现了没出口」)。
 *
 * ## 这六处的共同形态
 * ```text
 * 1 注释自证 `invariants.ts` 自称「每个分支各一个独立反例」,而 VIOLATION_CASES
 *   每 code 仅一个 ⇒ 新增分支(非法地图 / 非法容量 / maxBytes<=0 / 重复 code /
 *   overrides 拼错)全无判据。
 * 2 `worldRejected` 无出口  room.ts 里判出来了,运输层零消费 ⇒ 客户端分不出
 *   「原地不动(回退权威坐标)」与「反作弊拒绝」。
 * 3 同帧二次畸形攻击的 ATTACK_RATE 不进 `room_events`(未 push 到 pendingViolations)。
 * 4 `lastTargetlessAttackTick` 离场不清 ⇒ 旁表跨世代残留。
 * 5 `session` 的 onReject / lastReject / rejectedFrames 三出口**零消费者**。
 * 6 `WS-FND-136` 的负对照是纯 JS 引用语义的恒真式(删掉实现也不会红)。
 * ```
 *
 * ## 判据纪律(与 FND-134/135 同款)
 * ```text
 * · 行为判据优先:能真跑 RoomRuntime / startWsServer / checkAll 就不读源码;
 * · 每条正判据都配**负对照**(合法输入下同一个量必须不动);
 * · 结构性判据(注释 / 源码形态)一律做成**可注入的纯函数**:把旧形态写回去 ⇒ 红,
 *   而不是把当前源码抄一遍(抄一遍的判据在实现改坏时不会红)。
 * ```
 *
 * 运行:`node tests/WS-FND-141-small-cleanups.test.ts`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, report, results, test } from '../shared/testing/harness.ts';

import { checkAll, type InvariantCheck, type InvariantCode } from '../server/src/invariants.ts';
import {
  BRANCH_CASES,
  forceAlwaysOk,
  runSelfcheck,
  type BranchCase,
} from '../scripts/invariants.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import { ViolationKind, fixedClock } from '../server/src/net/anticheat.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { PROTOCOL_VERSION, encodeFull } from '../shared/net/delta.ts';
import { startWsServer, type WsServerHandle } from '../server/src/net/ws_server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 异步版 `test`(`harness.test()` 不 await ⇒ async 进去会**静默假绿**)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const WS_HANDSHAKE_BUDGET_MS = 15000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms:${what}`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

async function waitUntil(
  pred: () => boolean, ms: number, what: string, observe?: () => unknown,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    const waited = Date.now() - started;
    if (waited >= ms) {
      let actual = '(调用方未提供 observe)';
      if (observe !== undefined) {
        try { actual = JSON.stringify(observe()) ?? String(observe()); }
        catch (e) { actual = `observe() 自己抛了:${e instanceof Error ? e.message : String(e)}`; }
      }
      throw new Error(`等待条件超时:${what} —— 等了 ${waited}ms(上限 ${ms}ms),实际值 ${actual}`);
    }
    await sleep(Math.min(5, ms - waited));
  }
}

const enc = new TextEncoder();
/** 上行文本帧 = `0x01` + 载荷(契约 §12.1:上行有 tag、下行没有)。 */
function uplinkText(text: string): Uint8Array {
  const body = enc.encode(text);
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

/* ═══════════ 0. 可注入的「源码形态」纯函数(结构性判据的牙) ═══════════ */

/** 顶部注释里「自证」的问题清单:自称每个分支各有反例却没有 `BRANCH_CASES`。 */
function selfCertProblems(src: string): string[] {
  const out: string[] = [];
  if (src.includes('每个分支各一个独立反例') && !src.includes('BRANCH_CASES')) {
    out.push('注释自称「每个分支各一个独立反例」却没有 BRANCH_CASES(自证)');
  }
  return out;
}

/** 五个必须各有反例的分支(第十轮点名的)。 */
const BRANCH_TOPICS: readonly string[] = ['非法地图', '非法容量', 'maxBytes', '重复 code', 'overrides'];

/** 分支覆盖问题清单(空 = 五个分支各有反例)。 */
function branchCoverageProblems(cases: readonly { owner: string; name: string }[]): string[] {
  const blob = cases.map((c) => `${c.owner} ${c.name}`).join(' | ');
  return BRANCH_TOPICS.filter((t) => !blob.includes(t));
}

/** `WS-FND-136` 里旧「负对照」的问题清单(空 = 已是真负对照)。 */
function tautologyProblems(src: string): string[] {
  const out: string[] = [];
  if (/sameSource\s*=/.test(src)) out.push('仍有 sameSource 自造比较器(与被测实现无数据依赖)');
  if (/sameSource\(\[\.\.\.DYE_PALETTE\]/.test(src)) out.push('仍用 [...DYE_PALETTE] 做恒真负对照');
  if (!/\bCOPY\s*=/.test(src)) out.push('缺少源码形态负对照(COPY)');
  if (!src.includes('copyBack')) out.push('缺少注入样例(copyBack)');
  return out;
}

/** `client/src/main.ts` 消费 reject 的问题清单(空 = 三出口有消费者且不会立刻被盖)。 */
function mainRejectProblems(src: string): string[] {
  const out: string[] = [];
  if (!/onReject\s*:/.test(src)) out.push('未注册 onReject(三出口零消费)');
  if (!/'WORLD_REJECTED'/.test(src)) out.push('未按 WORLD_REJECTED 分档(与反作弊拒绝同形)');
  if (!/let\s+lastReject\b/.test(src)) out.push('没有 lastReject 本地留证(HUD/机读出口)');
  if (!/lastReject,/.test(src)) out.push('lastReject 未进 __stageReady 机读口径');
  if (/if \(s === 'failed'\) console\.warn/.test(src)) out.push('仍只有 failed 告警(closed 带 detail 时拒因被盖掉)');
  return out;
}

const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

let seq = 0;
const freshId = (tag: string): string => { seq += 1; return `fnd141_${tag}_${seq}`; };

/** 一间**没有世界**的房间(畸形攻击的判据不需要世界)。 */
function bareRoom(tag: string): RoomRuntime {
  return new RoomRuntime({
    roomId: freshId(tag),
    ownerId: 'owner',
    clock: fixedClock(1_700_000_000_000).clock,
  });
}

/* ── ws_server 的替身房间(只替身业务,运输层照旧) ── */
type StubRoom = {
  id: string;
  join: () => { ok: boolean };
  leave: () => boolean;
  disconnect: () => boolean;
  step: () => Uint8Array;
  snapshotFor: () => Uint8Array;
  cloneState: () => unknown;
  applyMove: (userId: string, intent: unknown) => unknown;
};
function makeStubRoom(): StubRoom {
  const state = createRoomState('stub141');
  let tick = 0;
  const room: StubRoom = {
    id: 'stub141',
    join: () => ({ ok: true }),
    leave: () => true,
    disconnect: () => true,
    step: () => { tick += 1; return encodeFull(state, tick).bytes; },
    snapshotFor: () => encodeFull(state, 0).bytes,
    cloneState: () => state,
    applyMove: () => ({ allowed: true }),
  };
  return room;
}

type RawClient = {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  opened: Promise<void>;
  done: Promise<void>;
};
function rawConnect(port: number, url: string): RawClient {
  const texts: Record<string, unknown>[] = [];
  const out: RawClient = { ws: null as unknown as WebSocket, texts, opened: null as unknown as Promise<void>, done: null as unknown as Promise<void> };
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`);
  out.ws = ws;
  ws.binaryType = 'arraybuffer';
  let markOpened: () => void = () => undefined;
  out.opened = new Promise<void>((res) => { markOpened = res; });
  out.done = new Promise<void>((res) => {
    ws.addEventListener('open', () => { markOpened(); });
    ws.addEventListener('message', ((ev: { data: unknown }) => {
      const d = ev.data;
      if (typeof d === 'string') { texts.push(JSON.parse(d) as Record<string, unknown>); }
    }) as never);
    ws.addEventListener('close', () => res());
    ws.addEventListener('error', () => res());
  });
  return out;
}
async function teardown(clients: RawClient[], srv: WsServerHandle): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

/* ═══════════════════════════ 判据 ═══════════════════════════ */

  test('FND141-1 ★ invariants.ts 顶部不再自证 + BRANCH_CASES 真的导出', () => {
    const head = readSrc('server/src/invariants.ts');
    eq(selfCertProblems(head), [], `invariants.ts 顶部不许再自证(实测问题:${
      selfCertProblems(head).join(' / ')}）`);
    ok(head.includes('BRANCH_CASES'), '★ 顶部必须点名 BRANCH_CASES(分支反例表的唯一事实源)');
    /* 负对照:把旧那句自证写回一份合成源码 ⇒ 必须被判出问题(证明本判据有牙)。 */
    const stale = ' *   ⇒ 反例表里**每个分支各一个独立反例**(见 `scripts/invariants.ts` 的 VIOLATION_CASES)。\n';
    ok(selfCertProblems(stale).length === 1, '负对照/注入:旧自证句必须被 selfCertProblems 命中');
    ok(readSrc('scripts/invariants.ts').includes('BRANCH_CASES'), 'BRANCH_CASES 必须真的导出在 scripts/invariants.ts');
  });

  /* ── FND141-2(P2-1)五个分支各有反例,且整套自检把它们算进 pass/total ── */
  test('FND141-2 ★ 五个分支各有反例;runSelfcheck 把它算进 pass/total', () => {
    eq(branchCoverageProblems(BRANCH_CASES), [],
      `五个分支必须各有反例(缺:${branchCoverageProblems(BRANCH_CASES).join(',')})`);
    ok(BRANCH_CASES.length >= 5, `分支反例至少 5 个(实测 ${BRANCH_CASES.length})`);
    const r = runSelfcheck();
    eq(r.branches.length, BRANCH_CASES.length, '自检覆盖的分支条数');
    eq(r.branches.filter((b) => !b.ok).map((b) => b.name), [], '不得有没牙的分支');
    eq(r.passed, r.total, 'passed 必须等于 total(分支判定没有被跳过)');
    eq(r.ok, true, `整套自检必须全绿:${r.summaryLine}`);
    /* 负对照/注入:从表里拿掉一个分支 ⇒ 覆盖判据必须红。 */
    const missing = BRANCH_CASES.filter((c: BranchCase) => !c.name.includes('重复 code'));
    ok(branchCoverageProblems(missing).length >= 1, '负对照:缺「重复 code」分支 ⇒ 覆盖判据报问题');
    /* 旧的逐 code 反例表**不许**被动过(它仍是「每条判据有没有牙」的那一层)。 */
    eq(r.cases.length, 8, '逐 code 反例表仍是 8 条(本轮的补丁没有把它顶掉)');
  });

  /* ── FND141-3(P2-1)数据分支:各自被对应判据抓到 + 注入验证 + 归因唯一 ── */
  test('FND141-3 ★ 数据分支:归因唯一 + 注入恒真 ⇒ 静默 + 注入别条 ⇒ 照旧被抓', () => {
    const data = BRANCH_CASES.filter((c) => c.make !== undefined && c.code !== undefined);
    ok(data.length >= 3, `数据分支至少 3 个(非法地图 / 非法容量 / maxBytes<=0),实测 ${data.length}`);
    for (const c of data) {
      const code = c.code as InvariantCode;
      const failing = checkAll(c.make!()).filter((x) => !x.ok).map((x) => x.code);
      eq(failing, [code], `${c.name}:必须**恰好**只被 ${code} 抓到(归因唯一)`);
      /* 注入:把这一条换成恒真 ⇒ 该分支不再被抓到 ⇒ 抓到它的正是这一条。 */
      let used = 0;
      const ov: Partial<Record<InvariantCode, InvariantCheck>> = {};
      ov[code] = forceAlwaysOk(code, () => { used += 1; });
      const injected = checkAll(c.make!(), { overrides: ov });
      eq(used, 1, `${c.name}:注入物必须真的被调用一次`);
      eq(injected.some((x) => x.code === code && !x.ok), false, `${c.name}:注入恒真后不再被抓到`);
      /* 负对照:注入**别的**那一条 ⇒ 本分支照旧被抓到(证明归因不是「顺手」)。 */
      const other = (['BODY_ID_UNIQUE', 'LEDGER_NON_NEGATIVE'].find((x) => x !== code) ?? 'BODY_ID_UNIQUE') as InvariantCode;
      const ovOther: Partial<Record<InvariantCode, InvariantCheck>> = {};
      ovOther[other] = forceAlwaysOk(other);
      ok(checkAll(c.make!(), { overrides: ovOther }).some((x) => x.code === code && !x.ok),
        `负对照:${c.name} 不因别的条目被注入而消失`);
    }
  });

  /* ── FND141-4(P3-4)离场清 `lastTargetlessAttackTick`(行为判据) ── */
  test('FND141-4 ★ leave 清 lastTargetlessAttackTick(负对照:不 leave 则残留)', () => {
    /* 判据:同 id 重进后,**同一 tick** 的畸形攻击若又算「首次」⇒ 旁表被清过;
       若仍算「同帧第二次」⇒ 上一代的帧号残留。 */
    const withLeave = bareRoom('clear');
    withLeave.join({ userId: 'p1' });
    const t0 = withLeave.state.meta.tick;
    eq(withLeave.applyAttack('p1', 0).allowed, true, '前置:首次畸形攻击放行(不占冷却)');
    eq(withLeave.applyAttack('p1', 0).allowed, false, '前置:同帧第二次被攻速闸拒');
    withLeave.leave('p1');
    ok(withLeave.join({ userId: 'p1' }).ok, '前置:重进成功');
    withLeave.state.meta.tick = t0; /* 冻结回原帧号 ⇒ 判据只测「旁表清没清」 */
    eq(withLeave.applyAttack('p1', 0).allowed, true,
      '★★ leave 必须清掉 lastTargetlessAttackTick ⇒ 重进后同帧再打一次又算「首次」');

    /* 负对照:同一序列**不 leave** ⇒ 第三次仍被拒(证明上面那条不是「第三次总放行」)。 */
    const noLeave = bareRoom('stale');
    noLeave.join({ userId: 'p1' });
    const t1 = noLeave.state.meta.tick;
    noLeave.applyAttack('p1', 0);
    noLeave.applyAttack('p1', 0);
    noLeave.state.meta.tick = t1;
    eq(noLeave.applyAttack('p1', 0).allowed, false,
      '★★ 负对照:不清旁表时,同帧第三次照旧被拒(与上面只差一次 leave)');
  });

  /* ── FND141-5(P2-3)同帧二次畸形攻击的 ATTACK_RATE 进流水 ── */
  test('FND141-5 ★ 同帧二次畸形攻击的 ATTACK_RATE 进流水(负对照:首次不进)', () => {
    const rt = bareRoom('viol');
    rt.join({ userId: 'p1' });
    eq(rt.applyAttack('p1', 0).allowed, true, '前置:首次畸形攻击放行');
    eq(rt.drainViolations().length, 0, '负对照:首次畸形攻击**不**进流水(它不是违规)');
    const second = rt.applyAttack('p1', 0);
    eq(second.allowed, false, '前置:同帧第二次被拒');
    eq(second.violation?.kind, ViolationKind.ATTACK_RATE, '前置:违规类型 = ATTACK_RATE');
    const drained = rt.drainViolations();
    eq(drained.length, 1, '★★ 同帧第二次的 ATTACK_RATE 进 `room_events` 流水(修前 push 缺失 ⇒ 0)');
    eq(drained[0]!.kind, ViolationKind.ATTACK_RATE, '流水里的正是那一条');
    eq(rt.drainViolations().length, 0, '负对照:drain 是取走语义(再取为空)');
  });

  /* ── FND141-6(P2-2)`worldRejected` 在运输层有出口,且与世界侧/反作弊可区分 ── */
  await atest('FND141-6 ★ ws_server 下发 WORLD_REJECTED(负对照:放行 / 反作弊拒绝都不发)', async () => {
    const room = makeStubRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: () => undefined });
    const c = rawConnect(srv.port, '/ws?userId=u_141');
    try {
      await withTimeout(c.opened, WS_HANDSHAKE_BUDGET_MS, '连接打开');
      c.ws.send(uplinkText(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null })));
      await waitUntil(() => c.texts.some((m) => m.t === 'welcome'), 5000, 'welcome 到达', () => c.texts);
      const move = JSON.stringify({ t: 'move', tick: 1, x: 5, y: 5, z: 0, seq: 1 });

      /* 世界侧拒收 ⇒ 必须下发 WORLD_REJECTED(带回退后的权威坐标)。 */
      room.applyMove = () => ({ allowed: false, worldRejected: true, corrected: { x: 3, y: 4, z: 0 } });
      c.ws.send(uplinkText(move));
      await waitUntil(() => c.texts.some((m) => m.code === 'WORLD_REJECTED'), 5000,
        'WORLD_REJECTED 到达', () => c.texts.slice(-4));
      const wr = c.texts.find((m) => m.code === 'WORLD_REJECTED')!;
      eq(wr.t, 'reject', '世界侧拒收发的是 reject 报文(客户端 session 认得这个判别式)');
      eq(wr.kind, 'MOVE', '档位分类 = MOVE');
      eq(wr.corrected, { x: 3, y: 4, z: 0 }, '★ 带上回退后的权威坐标(客户端据此静默回退)');
      const before = c.texts.filter((m) => m.code === 'WORLD_REJECTED').length;

      /* 负对照 1:放行 ⇒ 不发。 */
      room.applyMove = () => ({ allowed: true });
      c.ws.send(uplinkText(move));
      await sleep(120);
      /* 负对照 2:反作弊侧拒绝(没有 worldRejected)⇒ 也**不**发 WORLD_REJECTED(两档可区分)。 */
      room.applyMove = () => ({ allowed: false, corrected: { x: 0, y: 0, z: 0 } });
      c.ws.send(uplinkText(move));
      await sleep(120);
      eq(c.texts.filter((m) => m.code === 'WORLD_REJECTED').length, before,
        '★★ 负对照:放行 / 反作弊拒绝都不打 WORLD_REJECTED(否则「世界侧」这个档位没有意义)');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND141-7(P3-5)main.ts 消费 onReject(HUD + 机读),且分档 ── */
  test('FND141-7 ★ main.ts 消费 onReject(HUD + 机读),按 WORLD_REJECTED 分档', () => {
    const src = readSrc('client/src/main.ts');
    eq(mainRejectProblems(src), [], `main.ts 必须消费拒因(实测问题:${mainRejectProblems(src).join(' / ')}）`);
    /* 负对照/注入:把「旧形态」(只注册 onState + 只对 failed warn)写回一份合成源码 ⇒ 必须报问题。 */
    const stale = "events: {\n"
      + "  onState: (s, detail) => { if (s === 'failed') console.warn('[session] 失败:', detail); },\n"
      + "},\n";
    ok(mainRejectProblems(stale).length >= 2, '负对照/注入:旧形态必须被 mainRejectProblems 判出问题');
  });

  /* ── FND141-8(P3-6)WS-FND-136 的负对照不再是恒真式 ── */
  test('FND141-8 ★ WS-FND-136 的负对照不再是恒真式(可注入判定)', () => {
    const src = readSrc('tests/WS-FND-136-constants-single-source.test.ts');
    eq(tautologyProblems(src), [], `136 的负对照必须依赖实现(实测问题:${tautologyProblems(src).join(' / ')}）`);
    /* 负对照/注入:把旧的两行恒真式写回一份合成源码 ⇒ 必须被判出问题。 */
    const stale = "  const sameSource = (a: readonly string[], b: readonly string[]): boolean => a === b;\n"
      + "  eq(sameSource([...DYE_PALETTE], DYE_PALETTE), false, '负对照');\n";
    ok(tautologyProblems(stale).length >= 2, '负对照/注入:旧恒真式必须被 tautologyProblems 判出问题');
  });

report('WS-FND-141-small-cleanups');
