/**
 * WS-FND-134 · **失败可观测性**(第九轮实测的五处 + 三个留证字段)。
 *
 * ## 本套件要回答的问题(每一处都配**负对照**与**注入**)
 * ```text
 * P1-1 客户端不认 reject 报文:服务端先发 {t:'reject',reason} 再关连接,
 *      而客户端只判 welcome / actionResult,其余**静默 return**
 *      ⇒ 玩家只看到断线,拒因("缺凭证 / token 过期 / 房满 / 密码错")全部丢失。
 * P1-2 失败日志默认静默 no-op:`onLog ?? (()=>{})`,而两个装配层都没注入
 *      ⇒ 「hello 被拒 / 帧解析失败 / 写失败 / 动作抛错」在生产零出口。
 * P1-3 两处拒收不留证:文本上行非 JSON 的 catch、下行写失败的 catch。
 * P1-4 错误码缺「内部错」档:执行抛错与真参数错同为 `INVALID`。
 * P1-5 入场拒绝无 code:`JoinResult` 只有中文 `reason`,房满 / 密码错 /
 *      token 过期 / 已在线**只能靠比对字符串**区分。
 * P2   三个留证字段(`lastRestoreError` / `lastRemoveError` / `lastJoinAudit`)
 *      在**生产侧 0 个读点** ⇒ 注释承诺的可观测只对测试成立。
 * ```
 *
 * ## 判据设计纪律(与 `tests/WS-FND-132` / `-74` / `-95` 同款)
 * ```text
 * 1 行为判据优先:能真跑 startWsServer / createSession / RoomRuntime / NetPersistRoom
 *   就不读源码。
 * 2 「注入」= **故障注入**:让被测路径真的出现失败(join 拒 / 写抛 / 派发抛 /
 *    logger 自己抛 / 留证字段非空),再断言它**留了痕**——
 *   而不是把约定从源码里抄一遍(抄一遍的判据在实现改坏时不会红)。
 * 3 每条失败出口都配**负对照**:合法输入下同一个数必须**不动**
 *   (否则「计数总是涨」就能把每条断言都变绿)。
 * ```
 *
 * ## 判据表
 * ```text
 * FND134-1  formatWsLogLine:类别标签 + 4 个计数快照(负对照:类别不同 ⇒ 行不同)
 * FND134-2  defaultWsLog **不是** no-op(注入 console.error 监测器)
 * FND134-3  P1-2 注入式 logger 真的被调:join 拒 ⇒ helloRejected=1 + [ws:hello] 行
 *           负对照:同一台上合法入场 ⇒ helloRejected 仍 0,且没有一条 join 拒行
 * FND134-4  P1-3 文本上行非 JSON ⇒ uplinkRejected + [ws:uplink] 行 + lastParseError
 *           负对照:合法 hello / 合法二进制包 ⇒ uplinkRejected 不涨
 * FND134-5  P1-3 下行写失败 ⇒ writeErrors + [ws:write] 行(注入 write 抛)
 * FND134-6  P1-2 注入:logger 自己抛 ⇒ 运输层不崩(连接仍在,后续帧照发)
 * FND134-7  P1-4 注入:房间 dispatchAction 抛 ⇒ 回 kind='INTERNAL'
 *           负对照:参数错(房间回 INVALID)⇒ 回 kind='INVALID'(两档不同码)
 * FND134-8  P1-1 端到端:真 createSession + 真服务端,join 拒 ⇒ lastReject /
 *           rejectedFrames / onReject / state detail **四处都有**;close 后 detail 仍在
 *           负对照:合法 token ⇒ lastReject=null / rejectedFrames=0 / state='live'
 * FND134-9  P1-1 describeReject 容忍老服务端(只有 reason,无 code/kind)
 * FND134-10 P1-1 未知文本报文 ⇒ onDrop 留痕(不再静默),且**不**污染 droppedFrames
 * FND134-11 P1-5 真 RoomRuntime:四个拒绝档各自精确命中;成功入场 code === undefined
 * FND134-12 P1-5 档位**不靠**字符串:改文案不改 code(注入:把 reason 换掉)
 * FND134-13 P1-5 装配层(B 路)把 verdict.code 原样带进 reject 报文 + [room:join-reject]
 * FND134-14 P2 三个留证字段接到出口:[room:restore]/[room:remove]/[room:join-audit]
 *           各一次且**去重**;清除后不再新增(负对照)
 * FND134-15 P1-4 装配层(B 路)dispatchAction 抛 ⇒ reject kind='INTERNAL' + [room:action-error]
 * FND134-16 P1-2 **接线**判据:不传 `onLog` 时失败仍写 `console.error`(默认出口真的接上了)
 * ```
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';

import {
  OP_TEXT,
  acceptKey,
  defaultWsLog,
  encodeFrame,
  formatWsLogLine,
  startWsServer,
  type WsLogCounts,
  type WsServerHandle,
} from '../server/src/net/ws_server.ts';
import { PROTOCOL_VERSION, encodeFull } from '../shared/net/delta.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { createSession, describeReject } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import { NetPersistRoom, RoomSchema } from '../server/src/net/room.colyseus.ts';
import {
  JOIN_TOKEN_TTL_MS,
  RoomRuntime,
  type WorldSaveHost,
} from '../server/src/net/room.ts';
import { AccessMode } from '../server/src/db/repo.ts';
import { assemble } from '../server/src/index.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/** 异步版 `test`(`harness.test()` 不 await ⇒ 传 async 进去会**静默假绿**)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * 具名等待上限(不是重试):真 socket 在满载门禁下是重尾(理由同 `WS-FND-63`)。
 *
 * ★ 与 `tests/WS-13.test.ts` §6.0 / `tests/WS-FND-65` 同一套:每个常量写清"它在等哪一段",
 *   等待形态是**条件 + 具名上限**(`waitConn`),而不是"盲等一个 promise"。
 * ★ 本轮**没有上调任何预算**(上一轮把 open 从 5s 加到 15s 并没修好它):改的是等待形态 ——
 *   条件成立立刻返回、连接进终态提前结束、失败消息带「等了多久 + opened/helloSent/closed/err」。
 */
/** 等:`new WebSocket()` → TCP connect → HTTP Upgrade ⇒ 客户端 `open` 事件到达。 */
const WS_OPEN_BUDGET_MS = 15000;
/** 等:握手 / 状态推进(session 进 live、收到 reject、假服务端被连上)。 */
const WS_HANDSHAKE_BUDGET_MS = 15000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms:${what}`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

/** 等**状态**,不等时间(计数的更新发生在服务端回调里,与 sleep 没有同步关系)。 */
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

/**
 * ★ 轮询等待条件成立 —— 返回**等了多久**(ms);`-1` = 等满上限仍未成立。
 *
 * 为什么返回 -1 而**不是抛**(与 `WS-13` §6.0 / `WS-FND-65` 同一形态):
 *   抛 ⇒ 失败被压成一句「超时 Nms」,而那一刻**现场**(连接终态)还没被读
 *        ⇒ 报告里「握手真没发生」与「只是慢」不可分;返回 -1 ⇒ 调用点那条
 *        `ok/eq` **照旧红**,消息里却能同时写「等了多久」+「终态」。
 * ⚠️ `-1` 不是放行:条件仍为假,断言强度一点没动。
 */
async function waitUntilMs(cond: () => boolean, budgetMs: number, stepMs = 5): Promise<number> {
  const t0 = Date.now();
  /* ★ 用 `>=` 而不是 `>`:令 `budgetMs = 0` 精确表示"当场只看一眼"(同 `WS-FND-65`)。 */
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 >= budgetMs) return -1;
    await sleep(stepMs);
  }
}

/** 把 `waitUntilMs` 的返回值写成报告里能读的话:≥0 = 成立耗时,<0 = 等满上限仍未成立。 */
function waitedText(waited: number, budgetMs: number): string {
  return waited < 0 ? `等满 ${budgetMs}ms 仍不成立` : `等了 ${waited}ms`;
}

/** 连接级**终态**的原始记录 —— 只用来解释"为什么红",不参与任何判据。 */
type ConnTrace = {
  /** `open` 事件到达。⚠️ 它**不等于**握手完成(握手是上行 hello 那一步)。 */
  opened: boolean;
  /** 上行 hello 是否真发出去了(`ws.send` 抛过一次的话,这里会留 false + err)。 */
  helloSent: boolean;
  closed: { code: number; reason: string } | null;
  err: string | null;
};

/** 连接终态的可读文本(写进失败消息)。 */
function connState(t: ConnTrace): string {
  const closed = t.closed === null
    ? 'null'
    : String(t.closed.code) + (t.closed.reason ? `(${t.closed.reason})` : '');
  return `opened=${t.opened},helloSent=${t.helloSent},closed=${closed},err=${t.err ?? 'null'}`;
}

/**
 * ★ 等一个**连接级**条件成立;连接一旦进终态(error/close ⇒ 事件**不可能**再来),
 * **提前**结束等待。
 *
 * 为什么提前结束**不是**放行:它不改任何状态 ⇒ 调用点断言的原条件此时仍为假
 *   ⇒ 那条 `ok/eq` **照旧红**;它只是把"白等满上限"换成"立刻红 + 把终态写进消息"。
 */
async function waitConn(cond: () => boolean, t: ConnTrace, budgetMs: number): Promise<number> {
  return await waitUntilMs(() => cond() || t.closed !== null || t.err !== null, budgetMs);
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

/** 上行二进制帧 = `0x02` + 载荷。 */
function uplinkBinary(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength + 1);
  out[0] = 0x02;
  out.set(bytes, 1);
  return out;
}

/**
 * 上行 hello(§12.1:1 字节类型头 `0x01` + JSON)。
 *
 * ★ 顺手把**结果**记进连接终态(`helloSent` / `err`)—— 它**不参与任何判据**,
 *   只在红的消息里分清「发送这一步就没出去」与「发出去了但对面没回」;
 *   与 `WS-FND-65` 的 `conn.helloSent` 同一形态。
 */
function sendHello(c: RawClient): void {
  try {
    c.ws.send(uplinkText(JSON.stringify({
      t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null,
    })));
    c.conn.helloSent = true;
  } catch (e) {
    c.conn.err = `hello 发送失败:${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 替身房间:**只**替身业务,替身不了运输层(帧仍走 `ws_server` 的编帧 / 写法)。
 *
 * `joinRes` 可注入(这是 P1-5 在运输层那一侧的对照入口);
 * `dispatchAction` 可注入(这是 P1-4 的注入入口)。
 */
type StubJoinRes = { ok: boolean; reason?: string; code?: string; resumed?: boolean };

type StubRoom = {
  id: string;
  joinRes: StubJoinRes;
  joinCalls: number;
  join: (input: unknown) => StubJoinRes;
  leave: () => boolean;
  disconnect: () => boolean;
  step: () => Uint8Array;
  snapshotFor: () => Uint8Array;
  cloneState: () => unknown;
  applyMove: (userId: string, intent: unknown) => unknown;
  dispatchAction: (userId: string, action: string, payload?: unknown) => unknown;
};

function makeStubRoom(joinRes: StubJoinRes = { ok: true }): StubRoom {
  const state = createRoomState('stub134');
  let tick = 0;
  const room: StubRoom = {
    id: 'stub134',
    joinRes,
    joinCalls: 0,
    join: (): StubJoinRes => { room.joinCalls += 1; return room.joinRes; },
    leave: (): boolean => true,
    disconnect: (): boolean => true,
    /* 每帧都给一个**非空**帧 ⇒ 广播循环每帧都会调 `write`(写失败注入需要它)。 */
    step: (): Uint8Array => { tick += 1; return encodeFull(state, tick).bytes; },
    snapshotFor: (): Uint8Array => encodeFull(state, 0).bytes,
    cloneState: (): unknown => state,
    applyMove: (): unknown => ({ allowed: true }),
    dispatchAction: (): unknown => ({ ok: true, kind: 'OK' }),
  };
  return room;
}

/** 裸 WebSocket:**看得到 reject 报文原文**,也能发任意上行(含畸形)。 */
type RawClient = {
  ws: WebSocket;
  /** 收到的文本报文(原样 JSON 解析后的对象)。 */
  texts: Record<string, unknown>[];
  /** 收到的二进制帧。 */
  bin: Uint8Array[];
  opened: Promise<void>;
  done: Promise<void>;
  /** 连接级**终态**(只用来解释"为什么红",不参与任何判据;见 `connState`)。 */
  conn: ConnTrace;
};

function rawConnect(port: number, url: string): RawClient {
  const texts: Record<string, unknown>[] = [];
  const bin: Uint8Array[] = [];
  const out: RawClient = {
    ws: null as unknown as WebSocket, texts, bin,
    opened: null as unknown as Promise<void>, done: null as unknown as Promise<void>,
    conn: { opened: false, helloSent: false, closed: null, err: null },
  };
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`);
  out.ws = ws;
  ws.binaryType = 'arraybuffer';
  let markOpened: () => void = () => undefined;
  out.opened = new Promise<void>((res) => { markOpened = res; });
  out.done = new Promise<void>((res) => {
    ws.addEventListener('open', () => { out.conn.opened = true; markOpened(); });
    ws.addEventListener('message', ((ev: { data: unknown }) => {
      const d = ev.data;
      if (typeof d === 'string') { texts.push(JSON.parse(d) as Record<string, unknown>); return; }
      if (d instanceof ArrayBuffer) { bin.push(new Uint8Array(d)); return; }
      if (ArrayBuffer.isView(d)) {
        bin.push(new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength));
      }
    }) as never);
    /* ★ 2026-11-20:新增的**终态**监听 —— 修前这两个事件只用来落定 `done`,
       于是「被拒(1008)/掉线/err」在报告里**完全不可见**,等待只能白等满上限。 */
    ws.addEventListener('close', ((ev: { code: number; reason: string }) => {
      out.conn.closed = { code: ev.code, reason: ev.reason };
      res();
    }) as never);
    ws.addEventListener('error', ((ev?: { error?: { name?: string; message?: string } }) => {
      out.conn.err = ev?.error
        ? `${ev.error.name ?? 'Error'}: ${ev.error.message ?? ''}`
        : 'error(无详情)';
      res();
    }) as never);
  });
  return out;
}

/**
 * ★ 等**连接打开**:条件一成立立刻返回;**连接进终态(error/close)时提前结束**。
 *
 * 老写法是 `await withTimeout(c.opened, WS_HANDSHAKE_BUDGET_MS, '连接打开')` ——
 * 那是"固定预算 / 盲等一个 promise":它只买得到**时间**,买不到**事实**。
 *   · 那一刻套件没有任何 error/close 只读点 ⇒ 握手被拒(1008/426)与"只是满载下慢"
 *     在报告里长得一模一样,消息里只有上限、没有连接终态;
 *   · 老写法连现场都留不下 ⇒ 报告只能印一句「超时 15000ms:连接打开」。
 * ⇒ 改成等条件 + 具名上限 `WS_OPEN_BUDGET_MS`,失败消息带「等了多久 + 终态」
 *   (`opened`/`helloSent`/`closed`/`err`)。**预算没有上调**。
 * ⚠️ 提前结束**不是**放行:条件此时仍为假 ⇒ 下面那条 `ok` 照旧红;
 *   它只是把"明知不会再来"的白等 15 秒换成立刻红 + 现场(与 `WS-FND-65` / `WS-13` §6.0 同法)。
 */
async function waitOpen(c: RawClient): Promise<void> {
  const waited = await waitConn(() => c.conn.opened, c.conn, WS_OPEN_BUDGET_MS);
  ok(c.conn.opened, `连接应打开(${waitedText(waited, WS_OPEN_BUDGET_MS)};${connState(c.conn)})`);
}

async function teardown(clients: RawClient[], srv: WsServerHandle): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

/** 注入式日志收集器(同时是 P1-2 的**证据**:行真的写到了出口)。 */
function logSink(): { lines: string[]; sink: (m: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (m: string): void => { lines.push(m); } };
}

/* ═══════════════════ 1. 纯函数与默认出口 ═══════════════════ */

async function main(): Promise<void> {
  /* ── FND134-1 ★ 日志行 = 类别标签 + 计数快照 ── */
  await atest('FND134-1 ★ formatWsLogLine:类别标签与 4 个计数快照都在行里', async () => {
    /* 变红条件:把 `[ws:${cat}]` 前缀或任一计数从行里拿掉 ⇒ 下面逐条红。 */
    const counts: WsLogCounts = {
      framesRejected: 1, uplinkRejected: 2, helloRejected: 3, writeErrors: 4,
    };
    const line = formatWsLogLine('write', '下行写失败', counts);
    ok(line.startsWith('[ws:write] '), `行的开头必须是类别标签(实得 ${JSON.stringify(line.slice(0, 24))})`);
    ok(line.includes('下行写失败'), '原文必须保留(不许只留一个类别)');
    ok(line.includes('framesRejected=1'), '帧层计数在行里');
    ok(line.includes('uplinkRejected=2'), '载荷层计数在行里');
    ok(line.includes('helloRejected=3'), '入场拒计数在行里');
    ok(line.includes('writeErrors=4'), '写失败计数在行里');
    ok(line.endsWith('}'), '计数快照必须**闭合**(否则读者不知道快照到哪结束)');
    /* ★ 负对照:类别是**结构化**的第一个参数,不是拼进消息的文本 ——
       换类别行必须变,换个消息行也必须变(否则「类别」就是装饰)。 */
    const other = formatWsLogLine('hello', '下行写失败', counts);
    ok(other !== line, '★★ 负对照:类别不同 ⇒ 行必须不同(否则类别参数是装饰)');
    ok(formatWsLogLine('write', '别的消息', counts) !== line, '负对照:消息不同 ⇒ 行必须不同');
    /* 计数是**读数**,不是常量:改一个数行就得跟着变。 */
    const zero = formatWsLogLine('write', '下行写失败', {
      framesRejected: 0, uplinkRejected: 0, helloRejected: 0, writeErrors: 0,
    });
    ok(zero !== line, '负对照:计数不同 ⇒ 行必须不同(快照不是硬编码的模板)');
  });

  /* ── FND134-2 ★ 默认出口**不是** no-op ── */
  await atest('FND134-2 ★ defaultWsLog 真写出去(注入 console.error 监测器)', async () => {
    /* 变红条件:把 `defaultWsLog` 换回 `() => {}` ⇒ 捕获数 = 0 ⇒ 红。
       这是 P1-2 缺陷本体的**直接**判据(修前 `opts.onLog ?? (() => {})`)。 */
    const realError = console.error;
    const captured: string[] = [];
    try {
      console.error = (m?: unknown): void => { captured.push(String(m)); };
      defaultWsLog('[ws:boot] 默认出口自检');
    } finally {
      console.error = realError;
    }
    eq(captured.length, 1, '★ defaultWsLog 必须真的写一行(静默 no-op 会让这里是 0)');
    eq(captured[0], '[ws:boot] 默认出口自检', '写出去的就是传进来的那一行(不加工、不吞)');
    /* ★ 负对照:恢复之后**不许**再有捕获 —— 证明上面那个数不是环境里的噪声。 */
    eq(captured.length, 1, '负对照:恢复 console.error 之后捕获数不再增长');
  });

  /* ── FND134-3 ★ 注入式 logger + join 拒计数(P1-2 / P1-5 运输层侧) ── */
  await atest('FND134-3 ★ join 被拒 ⇒ helloRejected=1 且有一行 [ws:hello](含 code)', async () => {
    const { lines, sink } = logSink();
    const room = makeStubRoom({ ok: false, code: 'ROOM_FULL', reason: '房间已满(替身)' });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: sink });
    /* 没有 token 的上行:**替身房间**的 join 不看它(它只回 joinRes),
       本用例测的是「被拒时的出口」,不是鉴权。 */
    const c = rawConnect(srv.port, '/ws?userId=u_reject134');
    try {
      await waitOpen(c);
      sendHello(c);

      await waitUntil(() => srv.helloRejected() >= 1, 5000, 'hello 被拒被记账', () => srv.helloRejected());
      eq(room.joinCalls, 1, '前置:join 真的被调了一次(否则下面的账是空的)');
      eq(srv.helloRejected(), 1, '★ hello 被拒累计 1(与 uplinkRejected / frameRejected 分开计)');
      eq(srv.uplinkRejected(), 0, '负对照:这不是「载荷解不开」(那是另一个档)');
      eq(srv.frameRejected(), 0, '负对照:也不是「连一帧都没读出来」');
      ok(srv.logLines() > 0, '★ 日志出口真的被调过(只断言\"代码里有 log 调用\"是能变绿的假判据)');
      const rejectLines = lines.filter((l) => l.startsWith('[ws:hello]') && l.includes('被拒'));
      ok(rejectLines.length >= 1, `★ 必须有一行 [ws:hello] 的拒绝日志(实得 ${lines.length} 行,无匹配)`);
      ok(rejectLines.some((l) => l.includes('code=ROOM_FULL')), '★ 日志行必须带**机器可读档位**(否则排障要靠读中文)');
      ok(rejectLines.some((l) => l.includes('helloRejected=1')),
        '行里带**计数快照** ⇒ 「日志出现过」与「发生过几次」是两个可分别断言的量');
      /* 客户端那侧:reject 报文**先于**关闭到达(P1-1 的服务端半边)。 */
      await waitUntil(() => c.texts.length >= 1, 5000, 'reject 报文到达', () => c.texts);
      eq(c.texts[0]!.t, 'reject', '★ 关连接**之前**先发 reject(修前客户端只能看到断线)');
      eq(c.texts[0]!.code, 'ROOM_FULL', '★ reject 带上房间给出的档位');
      await withTimeout(c.done, 5000, '服务端随后关连接');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND134-3 负对照:合法入场时那些数**不许**动 ── */
  await atest('FND134-3b ★ 负对照:合法入场 ⇒ helloRejected 仍 0 且没有 join 拒行', async () => {
    const { lines, sink } = logSink();
    const room = makeStubRoom({ ok: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: sink });
    const c = rawConnect(srv.port, '/ws?userId=u_ok134');
    try {
      await waitOpen(c);
      sendHello(c);
      await waitUntil(() => c.texts.length >= 1, 5000, 'welcome 到达', () => c.texts);
      eq(c.texts[0]!.t, 'welcome', '正对照:合法入场收的是 welcome,不是 reject');
      eq(srv.helloRejected(), 0, '★★ 负对照:合法入场 ⇒ hello 被拒计数**不动**(证明它不是\"总是涨\")');
      eq(lines.filter((l) => l.includes('被拒') && l.startsWith('[ws:hello]')).length, 0,
        '★★ 负对照:一条 join 拒日志都不许有');
      eq(lines.filter((l) => l.includes('被拒')).length, 0, '★★ 负对照:没有任何一行说「被拒」');
      eq(srv.writeErrors(), 0, '负对照:写失败计数也不动');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND134-4 ★ 文本上行非 JSON:不静默(P1-3) ── */
  await atest('FND134-4 ★ 文本上行非 JSON ⇒ uplinkRejected + [ws:uplink] 行 + lastParseError', async () => {
    const { lines, sink } = logSink();
    const room = makeStubRoom({ ok: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: sink });
    const c = rawConnect(srv.port, '/ws?userId=u_badjson134');
    try {
      await waitOpen(c);
      /* ★ 注入:一个**开头是 `{` 但截断**的文本帧 ⇒ 走 text 分支、JSON.parse 抛。 */
      c.ws.send(uplinkText('{"t":"hello","protocolVersion":3'));
      await waitUntil(() => srv.uplinkRejected() >= 1, 5000, '坏文本被记账', () => srv.uplinkRejected());
      eq(srv.uplinkRejected(), 1, '★ 非 JSON 文本帧必须被计数(修前 catch 里既无计数也无日志)');
      ok((srv.lastParseError() ?? '').includes('JSON'), `★ 原因要指认对象(实得 ${JSON.stringify(srv.lastParseError())})`);
      const bad = lines.filter((l) => l.startsWith('[ws:uplink]') && l.includes('不是合法 JSON'));
      eq(bad.length, 1, '★ 必须有一条 [ws:uplink] 日志(修前这里一声不响把连接关掉)');
      ok(bad[0]!.includes('uplinkRejected=1'), '行里带计数快照');
      eq(srv.helloRejected(), 0, '负对照:这不是「人不许进」那一档(计数不混)');
      eq(srv.frameRejected(), 0, '负对照:也不是帧层超界');
      await withTimeout(c.done, 5000, '随后关连接(1003)');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND134-4b 负对照:合法上行不涨 uplinkRejected ── */
  await atest('FND134-4b ★ 负对照:合法 hello / 合法二进制包 ⇒ uplinkRejected 不动', async () => {
    const room = makeStubRoom({ ok: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: () => undefined });
    const c = rawConnect(srv.port, '/ws?userId=u_okbin134');
    try {
      await waitOpen(c);
      sendHello(c);
      await waitUntil(() => c.texts.length >= 1, 5000, 'welcome 到达', () => c.texts);
      eq(srv.uplinkRejected(), 0, '合法 hello ⇒ 载荷层拒收计数不动');

      /* 合法二进制:首字节 `1` 的**空包**会被解码器认下(见 `WS-FND-14`)。 */
      const state = createRoomState('r134ok');
      const good = encodeFull(state, 3).bytes;
      const before = srv.uplinkParsed();
      c.ws.send(uplinkBinary(good));
      await waitUntil(() => srv.uplinkParsed() > before, 5000, '合法包被解析', () => srv.uplinkParsed());
      eq(srv.uplinkRejected(), 0, '★★ 负对照:合法包只进 uplinkParsed,不污染 uplinkRejected');
      ok(srv.uplinkParsed() === before + 1, '正对照:恰好 +1(单调,不是\"被一次调用伪造\")');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND134-5 ★ 下行写失败:不静默(P1-3 下行侧) ── */
  await atest('FND134-5 ★ 下行写失败 ⇒ writeErrors + [ws:write] 行(注入 write 抛)', async () => {
    const { lines, sink } = logSink();
    const room = makeStubRoom({ ok: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: sink });
    const c = rawConnect(srv.port, '/ws?userId=u_write134');
    const net = await import('node:net');
    const proto = net.Socket.prototype as unknown as { write: unknown };
    const realWrite = proto.write;
    try {
      await waitOpen(c);
      sendHello(c);
      await waitUntil(() => c.texts.length >= 1, 5000, 'welcome 到达', () => c.texts);
      eq(srv.writeErrors(), 0, '前置:还没写失败过');

      /* ★ 注入:让底层 socket 的 `write` **只抛一次** —— 服务端下一次广播必然走到
         那个 catch(它把 `writeErrors += 1` 并留一行日志)。
         ⚠️ 单次是刻意的:(1) 计数断言可以精确到 1(不是 `>= 1`);
            (2) 万一窗口比预期长,也只会打坏一次,不会把同一进程里**其它**
                socket(含测试自己的客户端)连着打坏。 */
      let injectedLeft = 1;
      proto.write = function injectedWrite(this: unknown, ...args: unknown[]): unknown {
        if (injectedLeft > 0) { injectedLeft -= 1; throw new Error('注入:下行写失败'); }
        return (realWrite as (...a: unknown[]) => unknown).apply(this, args);
      };
      await waitUntil(() => srv.writeErrors() >= 1, 5000,
        '写失败被记账', () => ({ writeErrors: srv.writeErrors(), logLines: srv.logLines() }));
      eq(srv.writeErrors(), 1, '★ 写失败必须计数(修前 `catch { closed = true }` 一点痕迹都没有)');
      const wr = lines.filter((l) => l.startsWith('[ws:write]'));
      eq(wr.length, 1, '★ 必须有一条 [ws:write] 日志');
      ok(wr[0]!.includes('注入:下行写失败'), '★ 日志带**真错因**(否则只剩\"写失败\"三个字,无从排障)');
      ok(wr[0]!.includes('writeErrors=1'), '行里带计数快照');
      eq(srv.helloRejected(), 0, '负对照:这不是入场拒那一档');
    } finally {
      proto.write = realWrite;
      await teardown([c], srv);
    }
  });

  /* ── FND134-6 ★ 注入:logger 自己抛 ⇒ 运输层不崩 ── */
  await atest('FND134-6 ★ 注入:logger 抛 ⇒ 运输层不崩(连接仍在,帧照发)', async () => {
    let calls = 0;
    const boom = (): void => { calls += 1; throw new Error('注入:logger 自己抛'); };
    const room = makeStubRoom({ ok: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: boom });
    const c = rawConnect(srv.port, '/ws?userId=u_boom134');
    try {
      await waitOpen(c);
      sendHello(c);
      /* 一个坏文本帧 ⇒ 必然触发一次 log(出口会抛)。 */
      c.ws.send(uplinkText('{bad'));
      await waitUntil(() => srv.uplinkRejected() >= 1, 5000, '坏帧被记账(logger 抛也要记)', () => srv.uplinkRejected());
      ok(calls > 0, '注入的 logger **真的被调了**(否则这条注入什么都没测到)');
      const framesBefore = srv.framesSent();
      await waitUntil(() => srv.framesSent() > framesBefore + 2, 5000, '广播继续跑', () => srv.framesSent());
      eq(srv.uplinkRejected(), 1, '★ logger 抛**不**改变记账(宽容 catch 只吞出口自己的错)');
      sendHello(c);
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND134-7 ★ 内部错档(P1-4,运输层侧) ── */
  await atest('FND134-7 ★ 注入:dispatchAction 抛 ⇒ kind=INTERNAL;参数错仍是 INVALID', async () => {
    const { lines, sink } = logSink();
    const room = makeStubRoom({ ok: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: sink });
    const c = rawConnect(srv.port, '/ws?userId=u_internal134');
    try {
      await waitOpen(c);
      sendHello(c);
      await waitUntil(() => c.texts.length >= 1, 5000, 'welcome 到达', () => c.texts);

      /* 1 注入:派发**抛**(内部错)。 */
      room.dispatchAction = (): unknown => { throw new Error('注入:执行抛错'); };
      c.ws.send(uplinkText(JSON.stringify({ t: 'action', action: 'PLACE_BLOCK' })));
      await waitUntil(() => c.texts.some((m) => m.t === 'actionResult' && m.kind === 'INTERNAL'), 5000,
        'INTERNAL 回执到达', () => c.texts);
      const internal = c.texts.find((m) => m.t === 'actionResult' && m.kind === 'INTERNAL')!;
      eq(internal.ok, false, '抛错 ⇒ ok:false');
      ok(String(internal.reason).includes('执行抛错'), '★ 内部错的 reason 是**真错因**,不是一句通用文案');
      ok(lines.some((l) => l.startsWith('[ws:action]') && l.includes('抛错')),
        '★ 抛错必须留一行 [ws:action](修前只有 INVALID,两端都看不出是内崩)');
      eq(internal.action, 'PLACE_BLOCK', '★ 内部错回执带 `action`(一条连接可连发多个动作,回执必须能对上号)');

      /* 2 负对照:真·参数/状态错(房间回 `INVALID`)⇒ 回执档位必须是 `INVALID`。 */
      room.dispatchAction = (): unknown => ({ ok: false, kind: 'INVALID', reason: '参数错(替身)' });
      c.ws.send(uplinkText(JSON.stringify({ t: 'action', action: 'PLACE_BLOCK' })));
      await waitUntil(() => c.texts.some((m) => m.t === 'actionResult' && m.kind === 'INVALID'), 5000,
        'INVALID 回执到达', () => c.texts);
      const invalid = c.texts.find((m) => m.t === 'actionResult' && m.kind === 'INVALID')!;
      ok(internal.kind !== invalid.kind, '★★ 负对照:内部错与参数错**不同档**(修前两者同为 INVALID,不可区分)');
      eq(invalid.kind, 'INVALID', '参数错仍是 INVALID(没有被顺手改成 INTERNAL)');
      /* ★ 判别:整场**只有一条** `[ws:action]` 抛错日志 —— 参数错那条走的是回执档,
         没有经过 throw 路径(否则这里会是 2,而回执的 kind 也就证明不了任何事)。 */
      eq(lines.filter((l) => l.startsWith('[ws:action]') && l.includes('抛错')).length, 1,
        '★★ 只有注入的那一次抛错留了日志;参数错**不留**「抛错」日志');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ═══════════════ 2. 客户端认 reject(P1-1 端到端) ═══════════════ */

  await atest('FND134-8 ★★ 客户端认 reject:四处留证 + close 不吞拒因(P1-1)', async () => {
    /* 变红条件:
         · 回到\"只判 welcome/actionResult,其余静默 return\" ⇒ 第 1 条等待就超时;
         · 删掉 `onReject` 的调用 ⇒ 第 3 条红;
         · 把 close 那句改回 `setState('closed')` ⇒ 第 6 条红(拒因在状态流里消失)。 */
    const a = assemble({ roomId: 'r134reject', ownerId: 'o', sizeCells: 32 });
    const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20, onLog: () => undefined });
    const states: { s: string; d?: string }[] = [];
    const rejects: Record<string, unknown>[] = [];
    const session = createSession({
      /* ★ 不带 token = **生产路径**的鉴权门(ws_server 的 requireToken 默认 true)
         ⇒ 房间回 TOKEN_MISSING。 */
      url: `ws://127.0.0.1:${srv.port}/ws?userId=u_nope134`,
      store: new ClientStateStore(),
      events: {
        onState: (s, d) => { states.push(d === undefined ? { s } : { s, d }); },
        onReject: (r) => { rejects.push(r as unknown as Record<string, unknown>); },
        onFrame: () => undefined,
      },
    });
    try {
      await waitUntil(() => session.lastReject !== null, WS_HANDSHAKE_BUDGET_MS,
        'reject 报文到达客户端', () => ({ lastReject: session.lastReject, state: session.state }));
      eq(session.rejectedFrames, 1, '★ 只收到 1 条 reject(单调计数,不是\"最近一次\"的副本)');
      eq(session.lastReject!.code, 'TOKEN_MISSING', '★ 档位原样来自房间(不是客户端自己猜的)');
      eq(rejects.length, 1, '★ onReject 回调真的被调(P1-1 的\"推送\"出口)');
      eq(rejects[0]!.t, 'reject', '回调拿到的是那条报文原样');

      const failed = states.filter((x) => x.s === 'failed');
      eq(failed.length, 1, '★ 状态流里出现一次 failed(修前被拒的连接只有 connecting → closed)');
      ok((failed[0]!.d ?? '').includes('TOKEN_MISSING'),
        `★ 状态 detail 带档位:实得 ${JSON.stringify(failed[0]!.d)}`);

      await waitUntil(() => session.state === 'closed', 5000, '服务端随后关连接', () => session.state);
      const closed = states.filter((x) => x.s === 'closed').pop()!;
      ok((closed.d ?? '').includes('TOKEN_MISSING'),
        `★★ 被拒后的 close **仍带拒因**(修前写死 setState('closed'),拒因当场被覆盖):实得 ${JSON.stringify(closed.d)}`);
      eq(session.lastReject!.code, 'TOKEN_MISSING', 'close 之后 lastReject 仍在(可拉读数不被清)');
      eq(states.filter((x) => x.s === 'failed' && (x.d ?? '').includes('TOKEN_MISSING')).length, 1,
        '★ failed 那条**留在状态流里**(不是\"最后一次状态\"的临时值)');
    } finally {
      try { session.close(); } catch { /* 已关 */ }
      await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
    }
  });

  await atest('FND134-8b ★ 负对照:合法 token ⇒ live / lastReject=null / 一次 reject 都没有', async () => {
    const a = assemble({ roomId: 'r134ok', ownerId: 'o', sizeCells: 32 });
    const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20, onLog: () => undefined });
    const rejects: unknown[] = [];
    const session = createSession({
      url: `ws://127.0.0.1:${srv.port}/ws?userId=u_ok134e2e`
        + `&token=${encodeURIComponent(a.runtime.issueJoinToken('u_ok134e2e'))}`,
      store: new ClientStateStore(),
      events: { onReject: (r) => { rejects.push(r); }, onFrame: () => undefined },
    });
    try {
      await waitUntil(() => session.state === 'live', WS_HANDSHAKE_BUDGET_MS, '握手进 live', () => session.state);
      eq(session.lastReject, null, '★★ 负对照:合法入场 ⇒ lastReject 仍是 null');
      eq(session.rejectedFrames, 0, '★★ 负对照:rejectedFrames 仍是 0(证明它不是\"总是涨\")');
      eq(rejects.length, 0, '负对照:onReject 一次都不该被调');
    } finally {
      try { session.close(); } catch { /* 已关 */ }
      await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
    }
  });

  await atest('FND134-9 ★ describeReject:老服务端只给 reason 也不许丢原因', async () => {
    const old = describeReject({ t: 'reject', reason: '房间已满' });
    ok(old.includes('房间已满'), `★ 只有 reason 的老报文必须把**原因**带出来:实得 ${JSON.stringify(old)}`);
    const withCode = describeReject({ t: 'reject', code: 'ROOM_FULL', reason: '房间已满' });
    ok(withCode.includes('ROOM_FULL'), '★ 有档位时必须出现档位');
    ok(withCode !== old, '★ 有档位与没档位是**两行不同的话**(否则档位没被用上)');
    const bare = describeReject({ t: 'reject' });
    ok(bare.includes('没给理由'), `★ 连 reason 都没有时要**显式**说\"没给理由\":实得 ${JSON.stringify(bare)}`);
  });

  await atest('FND134-10 ★ 未知文本报文 ⇒ onDrop 留痕(不再静默),且不污染 droppedFrames', async () => {
    /* 用一个**下行可控**的极小服务端:真 ws_server 永远不发未知 `t`,
       而这条判据要的正是\"将来多了一种报文时客户端会怎么办\"。 */
    const { createServer } = await import('node:http');
    /* ⚠️ 用**持有者对象**而不是裸 `let`:TS 的控制流分析看不见闭包里的赋值
       ⇒ 裸 `let` 会被窄化成 `null`,`target?.destroy()` 直接报 TS2339(实测踩到)。 */
    const fake = { socket: null as import('node:net').Socket | null };
    const http = createServer((_q, res) => { res.writeHead(426); res.end(); });
    http.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string' || key.length === 0) { socket.destroy(); return; }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
      fake.socket = socket as unknown as import('node:net').Socket;
    });
    await new Promise<void>((r) => { http.listen(0, r); });
    const addr = http.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const send = (text: string): void => {
      const t = fake.socket;
      if (t === null) throw new Error('前置:客户端已经连上来');
      t.write(encodeFrame(OP_TEXT, enc.encode(text)));
    };
    const drops: string[] = [];
    const session = createSession({
      url: `ws://127.0.0.1:${port}/ws?userId=u_fake134`,
      store: new ClientStateStore(),
      events: { onDrop: (r) => { drops.push(r); }, onFrame: () => undefined },
    });
    try {
      await waitUntil(() => fake.socket !== null, WS_HANDSHAKE_BUDGET_MS, '客户端连上假服务端');
      send(JSON.stringify({
        t: 'welcome', playerId: 'u_fake134', roomId: 'r134',
        protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1',
      }));
      await waitUntil(() => session.state === 'live', 5000, 'welcome 被认下', () => session.state);
      eq(drops.length, 0, '负对照:已知报文**不**触发 onDrop');

      /* ★ 注入:发一种**将来才可能有**的文本报文 ⇒ 修前这里是静默 return。 */
      send(JSON.stringify({ t: 'mystery', payload: 1 }));
      await waitUntil(() => drops.length >= 1, 5000, '未知报文留痕', () => drops);
      ok(drops[0]!.includes('mystery'), `★ 原因必须指认对象:实得 ${JSON.stringify(drops[0])}`);
      eq(session.droppedFrames, 0, '★ 归 onDrop,**不**归 droppedFrames(后者的语义是\"载荷形态坏\")');
      eq(session.state, 'live', '未知报文不改状态(它是\"没被认下\",不是失败)');
      eq(drops.length, 1, '只留一条痕(不重复刷)');
    } finally {
      try { session.close(); } catch { /* 已关 */ }
      try { fake.socket?.destroy(); } catch { /* 已断 */ }
      await withTimeout(new Promise<void>((r) => { http.close(() => r()); }), 3000, '假服务端 close').catch(() => undefined);
    }
  });

  /* ═══════════════ 3. JoinResult.code 与装配层(房间侧) ═══════════════ */

  /** 可控时钟:`RoomRuntime` 判过期 / 宽限的唯一输入(不真等)。 */
  const makeClock = (start = 1_000_000): { clock: { nowMs: () => number }; advance: (ms: number) => void } => {
    let now = start;
    return { clock: { nowMs: () => now }, advance: (ms): void => { now += ms; } };
  };

  await atest('FND134-11 ★★ 五个入场拒绝档各自精确命中;成功入场 code === undefined', async () => {
    /* 变红条件:把 join 里任一 `code:` 删掉 ⇒ 对应那条 eq 立刻红(它比的是**字面量**)。 */
    /* 1 成功:code **不出现**(不是\"给了个假档位\")。 */
    {
      const rt = new RoomRuntime({ roomId: 'rc1', ownerId: 'o', clock: makeClock().clock });
      const r = rt.join({ userId: 'o', token: rt.issueJoinToken('o') });
      eq(r.ok, true, '正:房主带凭证入场成功');
      eq(r.code, undefined, '★ `ok:true` 时不带 code');
    }
    /* 2 ROOM_FULL */
    {
      const rt = new RoomRuntime({ roomId: 'rc2', ownerId: 'o', clock: makeClock().clock, maxPlayers: 1 });
      eq(rt.join({ userId: 'o', token: rt.issueJoinToken('o') }).ok, true, '前置:1 号占住唯一的席');
      const r = rt.join({ userId: 'b', token: rt.issueJoinToken('b') });
      eq(r.code, 'ROOM_FULL', '★★ 房满 ⇒ 精确档位(不是靠\"房间已满\"这五个字)');
      eq(r.reason, '房间已满', 'reason 是给人读的那一句,与档位**同时**存在');
    }
    /* 3 PASSWORD_MISMATCH */
    {
      const rt = new RoomRuntime({
        roomId: 'rc3', ownerId: 'o', clock: makeClock().clock,
        accessMode: AccessMode.PASSWORD, passwordHash: 'hash-ok',
      });
      eq(rt.join({ userId: 'a', passwordHash: 'hash-wrong' }).code, 'PASSWORD_MISMATCH', '★★ 密码错 ⇒ 精确档位');
      eq(rt.join({ userId: 'a', passwordHash: 'hash-ok' }).ok, true, '负对照:对的密码就放行(证明上面那条不是\"总是拒\")');
    }
    /* 4 ALREADY_ONLINE */
    {
      const rt = new RoomRuntime({ roomId: 'rc4', ownerId: 'o', clock: makeClock().clock });
      eq(rt.join({ userId: 'a', token: rt.issueJoinToken('a') }).ok, true, '前置:在线');
      eq(rt.join({ userId: 'a', token: rt.issueJoinToken('a') }).code, 'ALREADY_ONLINE', '★★ 已在线 ⇒ 精确档位');
    }
    /* 5 凭证两档(过期 / 格式非法) */
    {
      const c = makeClock();
      const rt = new RoomRuntime({ roomId: 'rc5', ownerId: 'o', clock: c.clock });
      const tok = rt.issueJoinToken('a', 1000);
      c.advance(2000);
      const expired = rt.join({ userId: 'a', token: tok, requireToken: true });
      eq(expired.code, 'TOKEN_EXPIRED', '★★ 过期 ⇒ 精确档位');
      ok((expired.reason ?? '').includes('过期'), 'reason 里那句\"过期\"仍在(档位不替代散文)');
      eq(rt.join({ userId: 'a', token: 'x.y', requireToken: true }).code, 'TOKEN_MALFORMED',
        '格式非法的凭证是**另一档**(TOKEN_MALFORMED)');
    }
  });

  await atest('FND134-12 ★★ 档位不靠字符串:把 reason 换掉,code 一字不变(注入)', async () => {
    const rt = new RoomRuntime({ roomId: 'rc6', ownerId: 'o', clock: makeClock().clock });
    /* ★ 注入:让验签入口回一句**完全不同**的文案,档位保持 TOKEN_EXPIRED。 */
    (rt as unknown as Record<string, unknown>)['verifyJoinToken'] = (): unknown => ({
      ok: false, code: 'TOKEN_EXPIRED', reason: '注入:换了一句完全不同的话(房间已满 B 版)',
    });
    const injected = rt.join({ userId: 'a', token: 'whatever', requireToken: true });
    eq(injected.code, 'TOKEN_EXPIRED', '★ 文案改了,档位一字不变 ⇒ 客户端不必比对中文');
    ok((injected.reason ?? '').includes('注入'), '而 reason 就是那句新文案(两个字段各司其职)');
    ok(!/[\u4e00-\u9fa5]/.test(injected.code!), '★ 档位里**没有**中文字:它是机器码,不是散文');

    /* 负对照:真那一路上档位相同、文案不同 ⇒ code 与 reason 确实是两个独立字段。 */
    const c = makeClock();
    const rt2 = new RoomRuntime({ roomId: 'rc6b', ownerId: 'o', clock: c.clock });
    const tok = rt2.issueJoinToken('a', 1000);
    c.advance(5000);
    const real = rt2.join({ userId: 'a', token: tok, requireToken: true });
    eq(real.code, 'TOKEN_EXPIRED', '负对照:真过期那条与注入那条**同档**');
    ok(real.reason !== injected.reason, '★ 两句 reason 不同 ⇒ 档位不是在匹配文案');
  });

  /**
   * `room.colyseus.ts` 的装配层夹具(手法同 `WS-FND-106` 的 `makeRoom`:
   * 真跑一次 `onCreate`,只把**副作用**换掉)。
   * `onLog` 注入收集器 —— 这正是 P1-2 那一侧的证据(`deps.onLog` 之前没人传)。
   */
  const makeColyseusRoom = (): {
    room: Record<string, unknown>;
    runtime: RoomRuntime;
    handlers: Map<string, (client: unknown, msg: Record<string, unknown>) => void>;
    lines: string[];
  } => {
    const { lines, sink } = logSink();
    const handlers = new Map<string, (client: unknown, msg: Record<string, unknown>) => void>();
    const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
    const realSetPatchRate = proto['setPatchRate'];
    proto['setPatchRate'] = function stubSetPatchRate(): void { /* 不建定时器 */ };
    const raw = new NetPersistRoom();
    proto['setPatchRate'] = realSetPatchRate;
    const room = raw as unknown as Record<string, unknown>;
    room['autoDispose'] = false;
    room['onMessage'] = (t: string, cb: (client: unknown, msg: Record<string, unknown>) => void): void => {
      handlers.set(t, cb);
    };
    room['setState'] = (s: unknown): void => { room['state'] = s as RoomSchema; };
    room['setSimulationInterval'] = (): void => { /* 不起 20Hz 定时器 */ };
    (raw as unknown as { withDeps: (d: unknown) => void }).withDeps({
      ownerId: 'o', clock: { nowMs: () => 1_000_000 }, db: null, host: null, onLog: sink,
    });
    (room['onCreate'] as (o: Record<string, unknown>) => void)({ roomId: 'room134', maxPlayers: 4 });
    return { room, runtime: room['runtime'] as RoomRuntime, handlers, lines };
  };

  await atest('FND134-13 ★ 装配层(B 路)把凭证档位原样带进 reject 报文 + 留日志', async () => {
    const f = makeColyseusRoom();
    const sent: { t: string; m: Record<string, unknown> }[] = [];
    const left: unknown[] = [];
    const client = {
      sessionId: 'sess134a',
      send: (t: string, m: Record<string, unknown>): void => { sent.push({ t, m }); },
      leave: (...a: unknown[]): void => { left.push(a); },
    };
    (f.room['onJoin'] as (c: unknown, o: Record<string, unknown>) => void)(client, { token: '不是一张凭证' });
    const rej = sent.find((x) => x.t === 'reject');
    ok(rej !== undefined, '★ 凭证被拒必须发一条 reject(修前只有 client.leave(4001))');
    eq(rej!.m['kind'], 'JOIN', 'reject 的分类是 JOIN');
    eq(rej!.m['code'], 'TOKEN_MALFORMED', '★ 档位就是 verdict.code(原样转发,不重写)');
    ok(f.lines.some((l) => l.startsWith('[room:join-reject]') && l.includes('code=TOKEN_MALFORMED')),
      '★ 拒绝要**出声**(修前服务端一个字都不留)');
    eq(left.length, 1, '仍然把连接踢掉(不静默降级成\"没给凭证\")');

    /* 负对照:合法凭证 ⇒ 一条 reject 都没有,且成功入场也留一行。 */
    const f2 = makeColyseusRoom();
    const sent2: { t: string; m: Record<string, unknown> }[] = [];
    const client2 = {
      sessionId: 'sess134b',
      send: (t: string, m: Record<string, unknown>): void => { sent2.push({ t, m }); },
      leave: (): void => undefined,
    };
    (f2.room['onJoin'] as (c: unknown, o: Record<string, unknown>) => void)(client2, { token: f2.runtime.issueJoinToken('u_alice134') });
    eq(sent2.filter((x) => x.t === 'reject').length, 0, '★★ 负对照:合法入场一条 reject 都没有');
    ok(f2.lines.some((l) => l.startsWith('[room:join]') && l.includes('入场 ok')),
      '★ 成功入场也留一行(修前只在失败时 leave(),成功路径一个字都没有)');
  });

  await atest('FND134-14 ★★ 三个留证字段接到出口:各一次、去重、清除后不再新增', async () => {
    const f = makeColyseusRoom();
    /* ⚠️ 必须 `.call(f.room)`:抽出来的方法丢了 `this`(严格模式下 = undefined)
       ⇒ 里面第一句 `this.runtime` 会当场抛,而报错看起来像\"夹具坏了\"。 */
    const step = (): void => { (f.room['stepTick'] as () => void).call(f.room); };
    const countOf = (p: string): number => f.lines.filter((l) => l.startsWith(p)).length;

    step();
    eq(countOf('[room:restore]'), 0, '前置:无读档错 ⇒ 无 restore 行');
    eq(countOf('[room:remove]'), 0, '前置:无移除错 ⇒ 无 remove 行');
    eq(countOf('[room:join-audit]'), 0, '前置:没入场过 ⇒ 无 join-audit 行');

    /* ★ 注入:把 `room.ts` 里那三个\"只写不读\"的留证字段填上。 */
    f.runtime.lastRestoreError = '快照解码失败(u_a):注入';
    f.runtime.lastRemoveError = '反作弊回收失败(u_b):注入';
    f.runtime.lastJoinAudit = { userId: 'u_c', members: true, state: true, world: 'ok' };
    step();
    eq(countOf('[room:restore]'), 1, '★★ lastRestoreError 被搬到出口(**修前生产侧 0 个读点**)');
    eq(countOf('[room:remove]'), 1, '★★ lastRemoveError 被搬到出口');
    eq(countOf('[room:join-audit]'), 1, '★★ lastJoinAudit 被搬到出口');
    ok(f.lines.some((l) => l.startsWith('[room:restore]') && l.includes('注入')), '★ 行里是真错因(不是一句通用文案)');
    ok(f.lines.some((l) => l.startsWith('[room:join-audit]') && l.includes('world=ok')), '★ 审计行的字段是可读的');

    /* ★ 去重:20Hz 的 stepTick 不许把同一行刷成一堵墙。 */
    step(); step();
    eq(countOf('[room:restore]'), 1, '★★ 去重:同一句错因只报一次(否则噪声会让人关掉日志)');
    eq(countOf('[room:remove]'), 1, '★★ 去重:remove 同理');
    eq(countOf('[room:join-audit]'), 1, '★★ 去重:同一个审计对象只报一次');

    /* ★ 负对照:清空字段 ⇒ 不再新增(证明那些数不是\"每帧必写\")。 */
    f.runtime.lastRestoreError = null;
    f.runtime.lastRemoveError = null;
    f.runtime.lastJoinAudit = null;
    step();
    eq(countOf('[room:restore]'), 1, '负对照:清空后不新增');
    eq(countOf('[room:remove]'), 1, '负对照:清空后不新增');
    eq(countOf('[room:join-audit]'), 1, '负对照:清空后不新增');

    /* ★ 换一句新错因 ⇒ 出口必须再报一次(去重靠\"变了才报\",不是\"一生只报一次\")。 */
    f.runtime.lastRestoreError = '快照解码失败(u_d):第二句';
    step();
    eq(countOf('[room:restore]'), 2, '★ 换了错因就再报一次');
  });

  await atest('FND134-15 ★ 装配层(B 路)dispatchAction 抛 ⇒ reject kind=INTERNAL + [room:action-error]', async () => {
    const f = makeColyseusRoom();
    const sent: { t: string; m: Record<string, unknown> }[] = [];
    const client = {
      sessionId: 'sess134c',
      send: (t: string, m: Record<string, unknown>): void => { sent.push({ t, m }); },
      leave: (): void => undefined,
    };
    (f.room['onJoin'] as (c: unknown, o: Record<string, unknown>) => void)(client, { token: f.runtime.issueJoinToken('u_d134') });
    const h = f.handlers.get('action');
    ok(typeof h === 'function', '前置:onCreate 必须注册 action 入口(否则报文会被静默丢弃)');

    /* ★ 注入:派发抛(内部错)。 */
    (f.runtime as unknown as Record<string, unknown>)['dispatchAction'] = (): unknown => {
      throw new Error('注入:装配层执行抛错');
    };
    h!(client, { action: 'PLACE_BLOCK', payload: {} });
    const rej = sent.filter((x) => x.t === 'reject').pop()!;
    eq(rej.m['kind'], 'INTERNAL', '★★ 装配层也把\"执行抛错\"归 INTERNAL(与 ws_server 同一档)');
    eq(rej.m['action'], 'PLACE_BLOCK', '回执带 action ⇒ 一条连接连发多个动作也能对上号');
    ok(String(rej.m['reason']).includes('装配层执行抛错'), '★ 原因是真错因');
    ok(f.lines.some((l) => l.startsWith('[room:action-error]') && l.includes('抛错')),
      '★ 抛错必须留日志(修前直接冒泡进 Colyseus,那条连接只看到连接级错误)');

    /* 负对照:参数错(房间回 INVALID)⇒ 回执档位是 INVALID,且**不留** action-error。 */
    (f.runtime as unknown as Record<string, unknown>)['dispatchAction'] = (): unknown =>
      ({ ok: false, kind: 'INVALID', reason: '参数错(替身)' });
    h!(client, { action: 'PLACE_BLOCK' });
    const rej2 = sent.filter((x) => x.t === 'reject').pop()!;
    eq(rej2.m['kind'], 'INVALID', '★★ 负对照:参数错仍是 INVALID(两档不同码)');
    ok(rej.m['kind'] !== rej2.m['kind'], '★★ 内部错与参数错**可区分**(修前两端都看不出是内崩)');
    eq(f.lines.filter((l) => l.startsWith('[room:action-error]')).length, 1,
      '★ 参数错不留 action-error(只有真的抛错才留)');
  });

  await atest('FND134-16 ★★ 默认出口真的接在 startWsServer 上(不传 onLog ⇒ 失败仍写 console.error)', async () => {
    /* FND134-2 只钉 `defaultWsLog` **函数本体**;这一条钉的是**接线**:
       `const sink = opts.onLog ?? defaultWsLog;`。
       变红条件:把它改回 `?? (() => {})`(修前的形态)⇒ 捕获数 0 ⇒ 红。 */
    const realError = console.error;
    const captured: string[] = [];
    console.error = (m?: unknown): void => { captured.push(String(m)); };
    const room = makeStubRoom({ ok: true });
    let srv: WsServerHandle | null = null;
    let c: RawClient | null = null;
    try {
      /* ⚠️ 这里**刻意不传 onLog** —— 被测的正是\"没注入时默认出口是谁\"。 */
      srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
      c = rawConnect(srv.port, '/ws?userId=u_default134');
      await waitOpen(c);
      c.ws.send(uplinkText('{bad-json'));
      await waitUntil(() => srv!.uplinkRejected() >= 1, 5000, '坏文本被记账', () => srv!.uplinkRejected());
      await waitUntil(() => captured.some((l) => l.startsWith('[ws:uplink]')), 5000,
        '默认出口写出一行 [ws:uplink]', () => captured.slice(-4));
      ok(captured.some((l) => l.startsWith('[ws:uplink]') && l.includes('不是合法 JSON')),
        '★★ 不注入 onLog 时**默认出口**必须真的写出去(把默认改回 no-op ⇒ 这里捕获不到任何一行)');
      ok(captured.some((l) => l.includes('uplinkRejected=1')), '★ 默认出口写的行同样带计数快照(不是裸消息)');
      eq(srv.helloRejected(), 0, '负对照:这不是入场拒那一档');
    } finally {
      console.error = realError;
      if (c !== null) { try { c.ws.close(); } catch { /* 已关 */ } }
      if (srv !== null) {
        await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
      }
    }
  });

  report('WS-FND-134');
}

await main();
