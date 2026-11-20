/**
 * WS-FND-161 —— 第十一轮**并发审计**(连接侧四项)。
 *
 * ## 本套件要回答的四个问题(每条都配**负对照**与**注入**)
 * ```text
 * P1-1 「升级了但没 hello」的连接**既无上限也无超时**
 *      ⇒ 一条只做 Upgrade 的 TCP 永久占一个 socket + 一个 `conns` 槽。
 *      ⇒ 修:入口闸(MAX_PENDING_HELLO_CONNS ⇒ 503 不升级)+ 时间闸
 *        (HELLO_TIMEOUT_MS ⇒ 1008 断开),两个计数**分开**。
 * P1-2 `socket.write` 的**返回值被丢弃** ⇒ 慢客户端在服务端完全不可观测。
 *      ⇒ 修:返回值透出去 + 按「连续 N 次 false」定策略(断开,不是静默丢帧:
 *        下行是差量编码,丢一帧会让该客户端此后每帧都对不上),并计数。
 * P1-3 **离开房间仍收帧**:`kick()` ⇒ `leave()` 只摘席位、不断连接,而广播只看
 *      `helloDone && !closed`(`snapshotFor(_userId)` 又忽略参数)
 *      ⇒ 被踢者继续收**全房 delta**。
 *      ⇒ 修:广播前用 `room.isSeated(userId)` 核对席位,没了 ⇒ 移出广播集。
 *      ★ 这一条**必须用真 socket 验**(本轮任务点名):看代码看不出来"他还收不收"。
 * P2   广播顺序 / 有界:成员判据(上面 P1-3)+ 每 tick 一帧(不放大)+
 *      两道上界(并发量 / 单连接排队量)都要能被断言。
 * ```
 *
 * ## 判据表
 * ```text
 * FND161-1  P1-1 入口闸:待握手满 ⇒ 第 N+1 条**不升级**(503),计数 + 日志
 *           负对照:已 hello 的连接不占额度(它一握手就不算待握手)
 * FND161-2  P1-1 时间闸:超时 ⇒ 断开 + handshakeTimeouts=1 + [ws:conn] 日志
 *           负对照:同一台上**及时 hello** 的连接不被超时切断(仍在收帧)
 * FND161-3  P1-1 注入:超时回调必须**真的**看 `helloDone`
 *           (把那句 no-op 判断去掉 ⇒ 已握手的连接被 300ms 后的定时器杀掉 ⇒ 红)
 * FND161-4  P1-2 正:注入 `write` 恒 false ⇒ 连续到阈值 ⇒ 断开 + 两个计数
 *           负对照:注入之前 writeBackpressure / backpressureDrops 都是 0
 * FND161-5  P1-3 ★真 socket:被踢者(`leave`)之后**一个帧都不再收**,连接仍在
 *           负对照:踢之前两人都在收(否则"不再收帧"可能只是因为从没收到过)
 * FND161-6  P1-3 ★注入对照:同一个 socket 判据,房间**不上报席位**时必然红
 *           (= 把 isSeated 拿掉 ⇒ 被踢者继续收帧)⇒ 证明 FND161-5 有牙
 * FND161-7  P2 顺序:同一连接收到的帧 tick **严格递增**,且 ack 槽按连接填(-1)
 * FND161-8  P2 有界:3 条连接 ⇒ 广播集 = 3 ≤ connCount;每 tick **恰好一帧**
 *           (framesSent 的增量 === 某个客户端收到的帧数增量,不放大)
 * FND161-9  P1-1 默认值在岗:默认配置下 2 条待握手连接**都**被接受
 *           (注入:把默认上界改成 1 ⇒ 红),且默认超时 1.2s 内不触发
 * FND161-10 P1-1 两闸**分开计**:入口闸拒的那条不进 handshakeTimeouts,反之亦然
 * ```
 *
 * ## 判据设计纪律(与 `WS-FND-132` / `-134` 同款)
 * ```text
 * 1 行为判据优先:能真起 startWsServer / 真 socket 就不 grep 源码;
 * 2 每条都配**负对照**:合法输入下同一个数必须**不动**(否则"总是涨"的计数
 *   能把每条断言都变绿);
 * 3 「注入」= 让被测路径真的走另一条分支(改 socket 返回值 / 抽掉 isSeated /
 *   把超时调到很小),再断言判据**变红** —— 而不是把约定从源码里抄一遍。
 * ```
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';
import {
  BACKPRESSURE_DISCONNECT_STRIKES,
  MAX_PENDING_HELLO_CONNS,
  startWsServer,
  type WsServerHandle,
} from '../server/src/net/ws_server.ts';
import { PROTOCOL_VERSION, decodePacket, encodeFull } from '../shared/net/delta.ts';
import { createRoomState } from '../server/src/net/schema.ts';

/* ═══════════════════════════ 0. 夹具 ═══════════════════════════ */

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

/** 等:连接 open / 握手 / 帧到达 的**具名上限**(不是重试,是预算)。 */
const WS_OPEN_BUDGET_MS = 15000;
const WS_HANDSHAKE_BUDGET_MS = 15000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms:${what}`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

/**
 * 等**状态**,不等时间(计数的更新发生在服务端回调里,与 sleep 没有同步关系)。
 * 失败消息里带**实得值**,否则"超时"与"值不对"在报告里长得一样。
 */
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

/** 连接级**终态**的原始记录 —— 只用来解释"为什么红",不参与任何判据。 */
type ConnTrace = {
  opened: boolean;
  helloSent: boolean;
  closed: { code: number; reason: string } | null;
  err: string | null;
};

type RawClient = {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  /** 收到的二进制帧(**WS 载荷本身** = 协议包,没有额外封装)。 */
  bin: Uint8Array[];
  opened: Promise<void>;
  done: Promise<void>;
  conn: ConnTrace;
};

function connState(t: ConnTrace): string {
  const closed = t.closed === null
    ? 'null'
    : String(t.closed.code) + (t.closed.reason ? `(${t.closed.reason})` : '');
  return `opened=${t.opened},helloSent=${t.helloSent},closed=${closed},err=${t.err ?? 'null'}`;
}

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

async function waitOpen(c: RawClient): Promise<void> {
  try {
    await withTimeout(c.opened, WS_OPEN_BUDGET_MS, '连接打开');
  } catch (e) {
    throw new Error(`${(e as Error).message}(连接终态:${connState(c.conn)})`);
  }
}

/** 发 hello(顺手把结果记进终态,只用于解释红因)。 */
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

/** 等 welcome(握手真的完成了,而不是"连接开着")。 */
async function waitWelcome(c: RawClient): Promise<void> {
  try {
    await waitUntil(() => c.texts.length >= 1, WS_HANDSHAKE_BUDGET_MS,
      'welcome 到达', () => ({ texts: c.texts, conn: connState(c.conn) }));
  } catch (e) {
    throw new Error(`${(e as Error).message}`);
  }
  eq(c.texts[0]!.t, 'welcome', `首条文本报文应是 welcome(${connState(c.conn)})`);
}

async function teardown(clients: RawClient[], srv: WsServerHandle): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

function logSink(): { lines: string[]; sink: (m: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (m: string): void => { lines.push(m); } };
}

/**
 * 替身房间:**可以上报席位**(`trackSeats`),也可以**不**上报。
 *
 * 后者是本套件最重要的一条负对照:运输层没有任何别的办法知道"席位被收走了",
 * 所以同一个 socket 判据在那种房间里**必然红**(而它证明前一条有牙)。
 */
type StubRoom = {
  id: string;
  seats: Set<string>;
  joinCalls: number;
  leaveCalls: string[];
  join: (input: { userId: string }) => { ok: boolean; resumed?: boolean };
  leave: (userId: string) => boolean;
  disconnect: (userId: string) => boolean;
  isSeated?: (userId: string) => boolean;
  step: () => Uint8Array;
  snapshotFor: (userId: string) => Uint8Array;
  cloneState: () => unknown;
  applyMove: (userId: string, intent: unknown) => unknown;
  dispatchAction: (userId: string, action: string, payload?: unknown) => unknown;
};

function makeStubRoom(opt: { trackSeats: boolean }): StubRoom {
  const state = createRoomState('stub161');
  let tick = 0;
  const seats = new Set<string>();
  const room: StubRoom = {
    id: 'stub161',
    seats,
    joinCalls: 0,
    leaveCalls: [],
    join: (input) => { room.joinCalls += 1; seats.add(input.userId); return { ok: true, resumed: false }; },
    /* ★ 与 `room.ts#kick` 的落点**同一件事**:踢人 = 摘席位(`leave`)。 */
    leave: (userId) => { room.leaveCalls.push(userId); return seats.delete(userId); },
    disconnect: (userId) => seats.delete(userId),
    /* 每帧都给一个**非空**差量帧 ⇒ 广播循环每 tick 都会真的写一次。 */
    step: () => { tick += 1; return encodeFull(state, tick).bytes; },
    snapshotFor: () => encodeFull(state, 0).bytes,
    cloneState: () => state,
    applyMove: () => ({ allowed: true }),
    dispatchAction: () => ({ ok: true, kind: 'OK' }),
  };
  if (opt.trackSeats) room.isSeated = (userId: string): boolean => seats.has(userId);
  return room;
}

/* ═══════════════════ 1. P1-1 待握手上限 + 握手超时 ═══════════════════ */

async function main(): Promise<void> {
  /* ── FND161-1 ★ 入口闸 ── */
  await atest('FND161-1 ★ P1-1 待握手满 ⇒ 第 N+1 条**不升级**(503)+ 计数 + 日志;负对照:已 hello 不占额度', async () => {
    /* 变红条件:
       · 去掉 upgrade 里的 `countPending() >= maxPendingHello` 那道闸 ⇒ cC 会
         照旧打开(open 事件到达)、pendingHelloRejected 恒 0;
       · 把它写成"数所有连接"⇒ 已 hello 的 cA 也占额度 ⇒ cB 被拒(本例红)。 */
    const { lines, sink } = logSink();
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({
      port: 0, room: room as never, frameMs: 20, onLog: sink,
      /* 只留 1 个待握手槽;超时调大 ⇒ 本例只测**入口闸**,不与时间闸混。 */
      maxPendingHello: 1, helloTimeoutMs: 60_000,
    });
    const cA = rawConnect(srv.port, '/ws?userId=u_a161');
    /* ⚠️ 客户端**按需**建(不是三条一起):三条一起连时,cap=1 会让 cB/cC
       在我读第一行断言之前就被拒(实测:读到 2)——
       那会把"额度怎么算"测成竞态,而我要测的是"额度只算待握手的那条"。 */
    const clients: RawClient[] = [cA];
    try {
      /* 1 正:一条**已完成 hello** 的连接。 */
      await waitOpen(cA);
      sendHello(cA);
      await waitWelcome(cA);
      eq(srv.helloPending(), 0, '★ 握过手的连接**不算**待握手(额度还给它自己)');
      eq(srv.pendingHelloRejected(), 0, '负对照:此时一条都没被拒');

      /* 2 正:第 1 条**待握手**连接 ⇒ 允许(0 < 1)。 */
      const cB = rawConnect(srv.port, '/ws?userId=u_b161');
      clients.push(cB);
      await waitOpen(cB);
      await waitUntil(() => srv.helloPending() === 1, 5000, '待握手计数 = 1', () => srv.helloPending());
      eq(srv.pendingHelloRejected(), 0, '负对照:额度还没用完 ⇒ 不拒');

      /* 3 正:第 2 条待握手连接 ⇒ **拒升级**。 */
      const cC = rawConnect(srv.port, '/ws?userId=u_c161');
      clients.push(cC);
      const waited = await waitUntilMs(() => srv.pendingHelloRejected() === 1, 5000);
      ok(waited >= 0, `★ 超限的那条必须被拒并记账(pendingHelloRejected=${srv.pendingHelloRejected()})`);
      /* 客户端侧:101 没发出 ⇒ open 事件**不会**到达。 */
      await waitUntilMs(() => cC.conn.closed !== null || cC.conn.err !== null, 3000);
      ok(!cC.conn.opened, `★★ 被拒的连接**没有完成升级**(修前它会照旧打开:${connState(cC.conn)})`);
      eq(cC.texts.length, 0, '被拒的连接收不到任何报文(连 welcome 都没有)');
      ok(lines.some((l) => l.startsWith('[ws:conn]') && l.includes('待握手连接已满')),
        '★ 必须有一行 [ws:conn] 说清楚是哪一道闸(计数 + 日志是两个可分别断言的量)');
      /* ⚠️ 行里的计数快照(`{framesRejected=.. ...}`)只含 134 那四个数 ——
         本轮的五个新计数**没有**塞进去(那会改 `WsLogCounts` 的形状,
         而它是 `WS-FND-134` 逐字段钉住的)。⇒ 这里断言行里带**占用/上限**两个数。 */
      ok(lines.some((l) => /待握手连接已满\(\d+\/\d+\)/.test(l)),
        '★ 日志行必须带"占用/上限"两个数(否则排障看不出是容量问题还是别的)');
      /* 4 负对照:拒的是**新来的那条**,已接下的那条不许被牵连。 */
      eq(srv.helloPending(), 1, '★★ 负对照:已接下的 cB 仍是待握手(拒新连接不等于清场)');
      eq(cA.ws.readyState, 1, '★★ 负对照:已握手的 cA 仍是 OPEN(入口闸不碰老连接)');
    } finally {
      await teardown(clients, srv);
    }
  });

  /* ── FND161-2 ★ 时间闸 ── */
  await atest('FND161-2 ★ P1-1 握手超时 ⇒ 断开 + handshakeTimeouts=1 + 日志;负对照:及时 hello 的不被切', async () => {
    /* 变红条件:
       · 删掉 upgrade 里那个 `setTimeout` ⇒ 静默连接永不回收,
         handshakeTimeouts 恒 0 且 cSlow 一直 OPEN;
       · 把回调里的 `helloDone` 判断去掉 ⇒ 下面 cFast 那条负对照红(见 FND161-3)。 */
    const { lines, sink } = logSink();
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({
      port: 0, room: room as never, frameMs: 10, onLog: sink,
      maxPendingHello: 8, helloTimeoutMs: 300,
    });
    const cSlow = rawConnect(srv.port, '/ws?userId=u_slow161');
    const cFast = rawConnect(srv.port, '/ws?userId=u_fast161');
    try {
      await waitOpen(cSlow);
      await waitOpen(cFast);
      sendHello(cFast);
      await waitWelcome(cFast);

      await waitUntil(() => srv.handshakeTimeouts() === 1, 5000,
        '握手超时被记账', () => ({ t: srv.handshakeTimeouts(), pending: srv.helloPending() }));
      /* 慢的那条真的断了(客户端看得到终态)。 */
      await waitUntilMs(() => cSlow.conn.closed !== null || cSlow.conn.err !== null, 3000);
      ok(cSlow.conn.closed !== null || cSlow.conn.err !== null,
        `★ 超时的连接必须真的被断(实得:${connState(cSlow.conn)})`);
      eq(lines.filter((l) => l.startsWith('[ws:conn]') && l.includes('握手超时')).length, 1,
        '★ 必须有一行 [ws:conn] 说明"超时"这个原因');

      /* ★★ 负对照:同一台上的另一条**及时** hello 了 ⇒ 不许被这条定时器牵连。 */
      eq(srv.handshakeTimeouts(), 1, '★★ 负对照:及时 hello 的那条**不**计入超时');
      eq(srv.helloPending(), 0, '超时那条已被移出待握手集(释放额度)');
      const fastFrames = cFast.bin.length;
      await waitUntil(() => cFast.bin.length >= fastFrames + 3, 5000,
        '负对照:已握手的连接在超时窗口之后仍继续收帧', () => ({ fast: cFast.bin.length, conn: connState(cFast.conn) }));
      ok(cFast.conn.closed === null, '★★ 负对照:已握手的连接没有被超时切断');
    } finally {
      await teardown([cSlow, cFast], srv);
    }
  });

  /* ── FND161-3 ★ 注入:超时回调必须真的看 helloDone ── */
  await atest('FND161-3 ★★ P1-1 注入:超时窗口**过去之后**已握手的连接必须还活着(去掉 no-op 判断 ⇒ 红)', async () => {
    /* 这条是 FND161-2 的**注入面**:超时值 200ms,而客户端立刻 hello;
       等 600ms(3 倍窗口)⇒ 若回调少了 `if (conn.helloDone || conn.closed) return;`,
       这条连接会被 200ms 的定时器杀掉 ⇒ 下面两条断言同时红。 */
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({
      port: 0, room: room as never, frameMs: 10, onLog: () => undefined,
      maxPendingHello: 8, helloTimeoutMs: 200,
    });
    const c = rawConnect(srv.port, '/ws?userId=u_quick161');
    try {
      await waitOpen(c);
      sendHello(c);
      await waitWelcome(c);
      await sleep(600);
      eq(srv.handshakeTimeouts(), 0, '★★ 已握手的连接**不许**被握手超时杀掉');
      ok(c.conn.closed === null, `★★ 连接必须仍是 OPEN(实得:${connState(c.conn)})`);
      const n = c.bin.length;
      await waitUntil(() => c.bin.length >= n + 2, 5000, '仍在正常收帧', () => c.bin.length);
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND161-4 ★ 写背压 ── */
  await atest('FND161-4 ★ P1-2 注入 write 恒 false ⇒ 连续到阈值 ⇒ 断开 + 两个计数(负对照:注入前都是 0)', async () => {
    /* 变红条件:
       · 把 `write` 的返回值再丢掉(或删掉 `writeStalls` 那两个分支)⇒
         writeBackpressure / backpressureDrops 恒 0,那条连接永远不断;
       · 把 `writable` 那次 return 写成"总是 false"⇒ 上面的负对照(注入前 = 0)红。 */
    const { lines, sink } = logSink();
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 10, onLog: sink });
    const c = rawConnect(srv.port, '/ws?userId=u_bp161');
    const net = await import('node:net');
    const proto = net.Socket.prototype as unknown as { write: unknown };
    const realWrite = proto.write;
    let injected = false;
    try {
      await waitOpen(c);
      sendHello(c);
      await waitWelcome(c);
      await waitUntil(() => srv.framesSent() >= 2, 5000, '正常广播已经跑了两帧', () => srv.framesSent());
      /* ★★ 负对照:还没注入 ⇒ 两个数**必须**是 0(证明它们不是"总是涨")。 */
      eq(srv.writeBackpressure(), 0, '★★ 负对照:对端读得快 ⇒ 一次背压都不许记');
      eq(srv.backpressureDrops(), 0, '★★ 负对照:也因此一条连接都不许被断');

      /* 注入:**只**对服务端那一侧的 socket 让 `write` 返回 false
         (`localPort === srv.port`;客户端 socket 不受影响)。
         字节**照旧写出去**(返回 false 只表示"队列满了",不是丢帧)。 */
      proto.write = function patchedWrite(this: unknown, ...args: unknown[]): unknown {
        const r = (realWrite as (...a: unknown[]) => unknown).apply(this, args);
        if (injected && (this as { localPort?: number }).localPort === srv.port) return false;
        return r;
      };
      injected = true;

      const framesBefore = srv.framesSent();
      await waitUntil(() => srv.backpressureDrops() === 1, 8000,
        '背压持续到阈值 ⇒ 断开被记账',
        () => ({ bp: srv.writeBackpressure(), drops: srv.backpressureDrops(), framesSent: srv.framesSent() }));
      ok(srv.writeBackpressure() >= BACKPRESSURE_DISCONNECT_STRIKES,
        `★ 返回值必须被记账(实得 ${srv.writeBackpressure()},阈值 ${BACKPRESSURE_DISCONNECT_STRIKES})`);
      eq(srv.backpressureDrops(), 1, '★ 到阈值后**断开**(策略明确:不是静默丢帧)');
      /* ★ 不阻塞:注入期间广播循环照旧在跑(帧率没有塌成 0)。 */
      ok(srv.framesSent() > framesBefore + 2,
        `★★ 写路径**不阻塞**:注入期间 framesSent 仍在增长(${framesBefore} → ${srv.framesSent()})`);
      ok(lines.some((l) => l.startsWith('[ws:write]') && l.includes('背压持续')),
        '★ 必须有一行 [ws:write] 说明"背压持续 ⇒ 断开"');
      eq(srv.writeErrors(), 0, '★★ 负对照:这是"写排队了",**不是**"写抛了"(两个数分开计)');
      /* 连接真的断了(客户端看得到终态)⇒ 那条连接不再占广播集。 */
      await waitUntilMs(() => c.conn.closed !== null || c.conn.err !== null, 3000);
      ok(c.conn.closed !== null || c.conn.err !== null, `★ 断开的连接在客户端也必须可见(${connState(c.conn)})`);
      eq(srv.broadcastTargets(), 0, '被断开的连接同时移出广播集');
    } finally {
      proto.write = realWrite;
      await teardown([c], srv);
    }
  });

  /* ── FND161-5 ★★ P1-3 被踢者不再收帧(真 socket) ── */
  await atest('FND161-5 ★★ P1-3 真 socket:被踢(leave)之后**一个帧都不再收**,而连接仍在;负对照:踢之前两人都在收', async () => {
    /* 这条必须用**真 socket**:本仓的判据纪律是「耦合出来的东西要真跑」——
       只读广播条件(`helloDone && !closed`)看不出"被踢者还在收",那正是修前的形态。
       变红条件:
       · 广播条件改回 `helloDone && !closed`(或删掉 `syncSubscriptions()`)⇒
         被踢者继续收帧 ⇒ 下面 `eq(cB.bin.length, bFrozen)` 红。 */
    const { lines, sink } = logSink();
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 10, onLog: sink });
    const cA = rawConnect(srv.port, '/ws?userId=u_keep161');
    const cB = rawConnect(srv.port, '/ws?userId=u_kick161');
    try {
      await waitOpen(cA);
      await waitOpen(cB);
      sendHello(cA);
      sendHello(cB);
      await waitWelcome(cA);
      await waitWelcome(cB);
      /* ★★ 负对照(前置):**踢之前**两人都在收帧 —— 否则下面"B 不再收"可能
         只是因为 B 从来就没收到过(那就不是判据)。 */
      await waitUntil(() => cA.bin.length >= 3 && cB.bin.length >= 3, 8000,
        '两人都在收帧(踢之前)', () => ({ a: cA.bin.length, b: cB.bin.length, conns: srv.connCount() }));
      eq(srv.broadcastTargets(), 2, '两人都在广播集里');
      eq(srv.seatsRevoked(), 0, '负对照:还没人被踢 ⇒ 这个数是 0');

      /* ★ 踢 = `room.ts#kick` 的落点:`leave(target)`(只摘席位,**不断连接**)。 */
      room.leave('u_kick161');
      await waitUntil(() => srv.seatsRevoked() >= 1, 5000,
        '席位被收走 ⇒ 移出广播集', () => ({ revoked: srv.seatsRevoked(), targets: srv.broadcastTargets() }));
      await waitUntil(() => srv.broadcastTargets() === 1, 5000,
        '广播集缩到 1', () => ({ targets: srv.broadcastTargets(), conns: srv.connCount() }));
      eq(srv.connCount(), 2, '★★ 移出广播集**不等于**断开连接(两条都还连着)');
      ok(cB.conn.closed === null, '被踢者的 socket 仍在(下行停,不是断连)');
      ok(lines.some((l) => l.startsWith('[ws:conn]') && l.includes('移出广播集')),
        '★ 必须有一行 [ws:conn] 说明席位被收走(静默地少一个人比报错更坏)');

      /* ★★ 核心判据:以**留场者**的收帧数作为时间基准(5 帧),被踢者一帧都不许多。 */
      await sleep(60);   /* 让在途帧落地(否则"踢的那一刻正好有一帧在路上") */
      const bFrozen = cB.bin.length;
      const aBefore = cA.bin.length;
      await waitUntil(() => cA.bin.length >= aBefore + 5, 8000,
        '留场者继续收 5 帧(时间基准)', () => ({ a: cA.bin.length, b: cB.bin.length }));
      eq(cB.bin.length, bFrozen,
        `★★ 被踢者**不再收帧**(踢后留场者又收了 ${cA.bin.length - aBefore} 帧,`
        + `而被踢者从 ${bFrozen} 变成 ${cB.bin.length})`);

      /* ★ 负对照(反向):留场者**继续**收 —— gating 不是"谁都不发"。 */
      ok(cA.bin.length >= aBefore + 5, '★★ 负对照:留场者必须继续收帧(否则这只是"广播停了")');
      /* 日志/计数仍是"一次" ⇒ 幂等(不是每帧涨 1 的节拍器)。 */
      eq(srv.seatsRevoked(), 1, '★ 席位回收只记**一次**(每帧涨 1 会让这个数变成噪声)');
    } finally {
      await teardown([cA, cB], srv);
    }
  });

  /* ── FND161-6 ★ 注入对照:房间不上报席位 ⇒ 同一判据必然红 ── */
  await atest('FND161-6 ★★ P1-3 注入对照:房间**不实现** isSeated ⇒ 被踢者继续收帧(证明 FND161-5 有牙)', async () => {
    /* 这条**故意**断言"修法没生效":它把 FND161-5 的前提(`isSeated` 在岗)
       抽掉,而同一个 socket 判据必须翻转 —— 否则 FND161-5 可能只是"恒真"。
       ⚠️ 它同时如实记下本修法的**边界**:房间不上报席位时,运输层无从得知,
         只能保持旧行为。生产里 `RoomRuntime.isSeated` 在岗(`scripts/play.ts`
         把 `assembled.runtime` 直接交给 startWsServer)。 */
    const room = makeStubRoom({ trackSeats: false });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 10, onLog: () => undefined });
    const cA = rawConnect(srv.port, '/ws?userId=u_keep161b');
    const cB = rawConnect(srv.port, '/ws?userId=u_kick161b');
    try {
      await waitOpen(cA);
      await waitOpen(cB);
      sendHello(cA);
      sendHello(cB);
      await waitWelcome(cA);
      await waitWelcome(cB);
      await waitUntil(() => cA.bin.length >= 3 && cB.bin.length >= 3, 8000,
        '两人都在收帧', () => ({ a: cA.bin.length, b: cB.bin.length }));

      room.leave('u_kick161b');
      await sleep(60);
      const bBefore = cB.bin.length;
      const aBefore = cA.bin.length;
      await waitUntil(() => cA.bin.length >= aBefore + 5, 8000, '留场者收 5 帧', () => cA.bin.length);
      ok(cB.bin.length > bBefore,
        `★★ 注入对照:没有 isSeated ⇒ 被踢者**照旧**收帧(${bBefore} → ${cB.bin.length})`
        + ' —— 这一条与 FND161-5 互为对方的前提');
      eq(srv.seatsRevoked(), 0, '不实现 isSeated ⇒ 运输层没有任何"席位没了"的信号');
      eq(srv.broadcastTargets(), 2, '同理,广播集不会缩');
    } finally {
      await teardown([cA, cB], srv);
    }
  });

  /* ── FND161-7 ★ P2 顺序 ── */
  await atest('FND161-7 ★ P2 广播顺序:同一连接收到的帧 tick **严格递增**,ack 槽按连接填(-1 = 还没 ack)', async () => {
    /* 变红条件:
       · 把 `withAckedSeq` 换成整包共享(不逐连接重写)⇒ ack 判据；
       · 广播里对同一条连接重复发同一帧 / 两处发 ⇒ tick 序列不再严格递增。 */
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 10, onLog: () => undefined });
    const c = rawConnect(srv.port, '/ws?userId=u_order161');
    try {
      await waitOpen(c);
      sendHello(c);
      await waitWelcome(c);
      await waitUntil(() => c.bin.length >= 4, 8000, '收到 ≥4 帧', () => c.bin.length);
      const packets = c.bin.map((f) => decodePacket(f));
      ok(packets.length >= 4, `应至少解出 4 个协议包(实得 ${packets.length})`);
      const ticks = packets.map((p) => p.tick);
      for (let i = 1; i < ticks.length; i += 1) {
        ok(ticks[i]! > ticks[i - 1]!,
          `★ tick 必须严格递增(第 ${i} 帧 ${ticks[i]} 不大于第 ${i - 1} 帧 ${ticks[i - 1]}):${ticks.join(',')}`);
      }
      /* ★ ack 槽是**每连接**的:这条连接从没发过 seq ⇒ 解码回 `-1`。 */
      eq(packets.map((p) => p.ackedSeq), packets.map(() => -1),
        '★ 每条连接的下行 ack = 它自己账本里的 -1(没有 ack),不是别人的数');
      /* 账实相符:最近一帧的字节长度 = 客户端收到的最后一帧长度。 */
      eq(srv.lastFrameBytes(), c.bin[c.bin.length - 1]!.byteLength,
        '★ lastFrameBytes() 与实际下发的帧长一致(广播真的发了那一份)');
      eq(srv.broadcastTargets(), 1, '一条连接 ⇒ 广播集 = 1');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── FND161-8 ★ P2 有界:不放大 ── */
  await atest('FND161-8 ★ P2 有界:3 条连接 ⇒ 广播集 = 3 ≤ connCount;每 tick **恰好一帧**(不放大)', async () => {
    /* 变红条件:广播里对每条连接发两遍(或按连接再套一层循环)⇒ 帧数增量翻倍。 */
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 10, onLog: () => undefined });
    const clients = [0, 1, 2].map((i) => rawConnect(srv.port, `/ws?userId=u_bound161_${i}`));
    try {
      for (const c of clients) await waitOpen(c);
      for (const c of clients) sendHello(c);
      for (const c of clients) await waitWelcome(c);
      await waitUntil(() => clients.every((c) => c.bin.length >= 3), 8000,
        '三条连接都在收帧', () => clients.map((c) => c.bin.length));
      eq(srv.broadcastTargets(), 3, '3 条都在广播集里');
      ok(srv.broadcastTargets() <= srv.connCount(), '★ 广播集 ≤ 连接数(子集关系,不是各算各的)');
      eq(srv.connCount(), 3, '3 条连接');

      /* ★ 每 tick 恰好一帧:窗口内 `framesSent` 的增量 === 某个客户端收到的帧数增量。 */
      const c0 = clients[0]!;
      const framesBefore = srv.framesSent();
      const binBefore = c0.bin.length;
      await waitUntil(() => c0.bin.length >= binBefore + 5, 8000, '再收 5 帧', () => c0.bin.length);
      const dFrames = srv.framesSent() - framesBefore;
      const dBin = c0.bin.length - binBefore;
      eq(dFrames, dBin,
        `★ 广播**不放大**:framesSent +${dFrames} 与客户端收到 +${dBin} 必须相等`
        + '(翻倍/重发会让前者大于后者)');
    } finally {
      await teardown(clients, srv);
    }
  });

  /* ── FND161-9 ★ 默认值在岗 ── */
  await atest('FND161-9 ★ P1-1 默认配置在岗:2 条待握手连接都被接受,且默认超时 1.2s 内不触发', async () => {
    /* 变红条件(注入):
       · 把 `MAX_PENDING_HELLO_CONNS` 改成 1 ⇒ 第二条被拒 ⇒ 红;
       · 把 `HELLO_TIMEOUT_MS` 改成 ≤1200 ⇒ 等 1.2s 之后 handshakeTimeouts=1 ⇒ 红。
       ⚠️ 不查"常量字面等于多少"(那是抄一遍约定):这里只问**行为**。 */
    const room = makeStubRoom({ trackSeats: true });
    /* 刻意**不传** maxPendingHello / helloTimeoutMs ⇒ 走默认值。 */
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20, onLog: () => undefined });
    const c1 = rawConnect(srv.port, '/ws?userId=u_def161_1');
    const c2 = rawConnect(srv.port, '/ws?userId=u_def161_2');
    try {
      await waitOpen(c1);
      await waitOpen(c2);
      await waitUntil(() => srv.helloPending() === 2, 5000, '两条待握手', () => srv.helloPending());
      eq(srv.pendingHelloRejected(), 0, '★ 默认上界 ≥ 2(改成 1 会让第二条被 503 拒掉)');
      ok(MAX_PENDING_HELLO_CONNS >= 2, '默认上界至少能容下一个**并发**握手对');
      await sleep(1200);
      eq(srv.handshakeTimeouts(), 0, '★ 默认超时必须 > 1.2s(否则正常建连会被误杀)');
      eq(srv.helloPending(), 2, '两条仍未被断开');
    } finally {
      await teardown([c1, c2], srv);
    }
  });

  /* ── FND161-10 ★ 两闸分开计 ── */
  await atest('FND161-10 ★ P1-1 两个闸**分开计**:入口闸拒的不进 handshakeTimeouts,反之亦然', async () => {
    /* 变红条件:把两个数合并成一个 `rejected` ⇒ 下面两条"另一个数不动"的断言红。 */
    const room = makeStubRoom({ trackSeats: true });
    const srv = await startWsServer({
      port: 0, room: room as never, frameMs: 20, onLog: () => undefined,
      maxPendingHello: 1, helloTimeoutMs: 2500,
    });
    const c1 = rawConnect(srv.port, '/ws?userId=u_gate161_1');
    /* ⚠️ 两条**分步**连(不是同时):cap=1 时同时连会让"谁被拒"变成竞态,
       而本条要测的是**第二个**被入口闸拒(与 FND161-1 同一手法)。 */
    const clients: RawClient[] = [c1];
    try {
      await waitOpen(c1);
      await waitUntil(() => srv.helloPending() === 1, 5000, '第一条待握手', () => srv.helloPending());
      const c2 = rawConnect(srv.port, '/ws?userId=u_gate161_2');
      clients.push(c2);
      await waitUntilMs(() => srv.pendingHelloRejected() === 1, 5000);
      eq(srv.pendingHelloRejected(), 1, '★ 第二条被入口闸拒');
      eq(srv.handshakeTimeouts(), 0, '★★ 入口闸拒的那条**不**计入握手超时(两个数分开计)');

      await waitUntil(() => srv.handshakeTimeouts() === 1, 8000,
        '第一条被时间闸断开', () => ({ t: srv.handshakeTimeouts(), pending: srv.helloPending() }));
      eq(srv.pendingHelloRejected(), 1, '★★ 时间闸触发后,入口闸那个数**不动**(反方向也成立)');
      eq(srv.helloPending(), 0, '两条都不在了');
      /* 客户端侧:两条都进终态(一条 503、一条 1008/断开)。 */
      await waitUntilMs(() => c2.conn.closed !== null || c2.conn.err !== null, 3000);
      ok(!c2.conn.opened, `被入口闸拒的那条不应完成升级(${connState(c2.conn)})`);
    } finally {
      await teardown(clients, srv);
    }
  });

  report('WS-FND-161');
}

/**
 * 等一个条件成立;返回**等了多久**(ms),`-1` = 等满上限仍未成立。
 *
 * 为什么返回 -1 而**不是抛**:抛会把失败压成一句「超时 Nms」,而调用点那条
 * `ok/eq` 照旧会红 —— 差别是消息里还能同时写「等了多久」+ 终态(与 `WS-FND-134`
 * 的 `waitUntilMs` 同法)。
 */
async function waitUntilMs(cond: () => boolean, budgetMs: number, stepMs = 5): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 >= budgetMs) return -1;
    await sleep(stepMs);
  }
}

await main();