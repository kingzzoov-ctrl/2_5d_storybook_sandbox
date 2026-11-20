/**
 * WS-FND-65 —— **US2 跨进程端到端**:上行 `move` → 世界真的动了 → 下行快照带着新位置回来。
 *
 * ## 为什么这条判据必须**跨模块**
 *
 * `docs/SIM-orchestration.md` 的 US2 记的缺口是「三段各自都"通了",但它们之间的那一跳没人测」:
 * ```
 * 客户端    input.ts → session.sendMove(...)                  ← 有单元测试
 * 运输层    ws_server 收 t:'move' → parseMoveIntent → 调用     ← 有单元测试(替身房间)
 * 模拟层    WorldSim.applyPlayerMove 写 physics.bodies         ← 有单元测试
 * ⇒ 但「客户端发一条,世界里的坐标真的变了,并且**下一条快照把它带回来**」
 *   这一段**从来没有一条断言**(每条判据都只截其中一截)
 * ```
 *
 * ## 本套件用**真件**
 *
 * ```
 * 真 startWsServer(port 0)    真帧循环 + 真 room.step(反作弊水位、投影、编码)
 * 真 RoomRuntime(assemble)    真 worldSaveHost / 真快照
 * 真 WebSocket + 生产编解码    shared/net/delta.ts 的 decodePacket/applyPacket
 *                            (客户端 ClientStateStore 内部用的就是这两个 —— 见 state_store.ts)
 * 真 createSession            FND65-4 用它验生产客户端那一半(握手/快照能看见自己)
 * ```
 *
 * ## 三段因果,逐段断言(否则"没动"与"动了但没回来"分不开)
 *
 * | 段 | 判据 |
 * | :--- | :--- |
 * | 上行被听见 | `connCount() ≥ 1` + 客户端合入过非空快照 |
 * | **世界真的动了** | `sim.playerPosition(id)` 变了(读**权威**刚体) |
 * | **快照带回新位置** | 客户端状态里的 `players[id].x` 等于权威值(1/1024 定点) |
 *
 * ## ⚠️ 2026-11-18 满载偶发红(报「15s socket 超时」)的修法
 *
 * ```
 * 症状:单跑恒 4/4(≈0.9s);门禁满载下偶发红,红的形态是
 *   ✗ [WS-FND-65-us2-crossproc] FND65-1 … 超时 15000ms:socket 打开
 *
 * ★ 上一轮的修法是**加预算**(w36:5s → 15s)。那没修好它,因为预算不是问题:
 *   `await withTimeout(c.opened, 15000, 'socket 打开')` 是**盲等一个 promise**:
 *   · 那一刻套件**没有任何** error/close 监听 ⇒ 握手被拒(1008)与"只是慢"
 *     在报告里长得**一模一样**,消息里只有上限、没有连接终态;
 *   · `markOpened()` 还排在 `ws.send(hello)` **之后** ⇒ `send` 抛一次就等于
 *     永不落定,而报出来的仍是「socket 打开」—— 一个**与真因无关**的消息。
 *   ⇒ 这类等待叫"固定预算":它只买得到时间,买不到**事实**。
 *
 * 修法(只改本文件,与 `tests/WS-13.test.ts` §6.0 同一套):
 *   1 `waitUntil` 轮询条件 ⇒ 返回**等了多久**(ms),`-1` = 等满上限仍未成立;
 *   2 `waitConn` 在连接进终态(error/close)时**提前**结束等待;
 *   3 每个等待配**具名上限** `WS_*_BUDGET_MS`(注释写明它在等哪一段);
 *   4 失败消息带 `waitedText()` + `connState()`(opened/helloSent/closed/err)。
 *   ★ **没有上调任何预算**:open/welcome 仍是 15s,快照仍是 5s。
 *
 * 为什么这**不是掩蔽**:
 *   到点条件仍为假 ⇒ 调用点那条 `ok/eq` **照旧红**(`-1` 不是放行);
 *   提前结束**不改任何状态** ⇒ 只是把"明知不会再来"从"白等 15 秒"变成
 *   "立刻红,并把终态写进消息" ⇒ 报告第一次能分清「握手真没发生」与「只是慢」。
 * ```
 */
import { ok, eq, near, report, results } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { startWsServer, type WsServerHandle } from '../server/src/net/ws_server.ts';
import { createSession, type WelcomeFrame } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import { applyPacket, decodePacket } from '../shared/net/delta.ts';
import { createRoomState, type RoomState } from '../server/src/net/schema.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

/** 异步 `test`(同步 `test()` 不会 await ⇒ 断言一条都跑不完;与 WS-FND-15/63 同法)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`超时 ${ms}ms:${what}`)), ms);
  });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

/* ═══════════════ 具名等待上限(2026-11-18:修满载抖动)═══════════════
 * 每个常量都写清"它在等哪一段异步链";口径与 `tests/WS-13.test.ts` §6.0 同一套
 * (那里有实测:p99 + 一个数量级以上余量 ⇒ 服务端**真坏了**仍会红,只是**慢**不再误红)。
 * ★ 这一轮**没有上调任何预算** —— 上一轮把 open 从 5s 加到 15s 并没修好它;
 *   这次改的是**等待形态**(条件 + 终态 + 现场),不是时间。
 */
/** 等:`startWsServer` 返回 → TCP connect → HTTP Upgrade ⇒ 客户端 `open` 事件。 */
const WS_OPEN_BUDGET_MS = 15000;
/** 等:`open` → 上行 hello → join 进房 → welcome 文本帧回到客户端。 */
const WS_WELCOME_BUDGET_MS = 15000;
/** 等:客户端收到含该玩家的快照 / 快照把新位置带回来(20Hz 广播一拍)。 */
const WS_SNAPSHOT_BUDGET_MS = 15000;
/** 单条 `move` 之后等「权威坐标真的动了」的**上限**(条件一成立立刻返回,
 *  不是 sleep) —— 反作弊额度按服务端帧水位发放,故额度不足时要重发。 */
const WS_MOVE_STEP_MS = 80;
/** `move` 重发次数上限(原写法是 `12 × sleep(80)`:同一个量级,但那时**看不见**等了多久)。 */
const MOVE_PUSH_MAX = 12;
/** 负对照的**观察窗**(不是"等某个事件"):必须让广播真流过若干拍,
 *  否则"不变"只是因为一帧都没收到。原写法 `12 × sleep(25)`,同一个 300ms。 */
const IDLE_OBSERVE_MS = 300;

/**
 * ★ 轮询等待条件成立 —— 返回**等了多久**(ms);`-1` = 等满上限仍未成立。
 *
 * ## 为什么返回 -1 而**不是抛**(这是本轮修抖动的关键形态)
 * ```
 * 抛 ⇒ 失败被压成一句「超时 Nms」,而那一刻**现场**(连接终态、快照到哪一步)
 *     还没被读 ⇒ 报告里「握手真没发生」与「只是慢」不可分。
 * 返回 -1 ⇒ 调用点那条 `ok/eq` **照旧红**,而消息里能同时写
 *     「等了多久」+「opened/helloSent/closed/err」⇒ 红的形态自带诊断。
 * ⚠️ `-1` 不是放行:条件仍为假,断言强度一点没动。
 * ```
 */
async function waitUntil(cond: () => boolean, budgetMs: number, stepMs = 15): Promise<number> {
  const t0 = Date.now();
  /* ★ 用 `>=` 而**不是** `>`:`budgetMs = 0` 必须表示"**当场只看一眼**" ——
     否则 0 会白送一个 stepMs(5/15ms),把上限改成 0 的注入验证就不会红。 */
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 >= budgetMs) return -1;
    await sleep(stepMs);
  }
}

/** 把 `waitUntil` 的返回值写成报告里能读的话:≥0 = 成立耗时,<0 = 等满上限仍未成立。 */
function waitedText(waited: number, budgetMs: number): string {
  return waited < 0 ? `等满 ${budgetMs}ms 仍不成立` : `等了 ${waited}ms`;
}

/** 连接级**终态**的原始记录 —— 只用来解释"为什么红",不参与任何判据。 */
type ConnTrace = {
  /** `open` 事件到达。⚠️ 它**不等于**握手完成(握手是上行 hello 那一步)。 */
  opened: boolean;
  /** 上行 hello 是否真发出去了(`ws.send` 抛过一次的话,这里会留着 false + err)。 */
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
 * ★ 等一个**连接级**条件成立;若连接已进终态(error/close ⇒ 事件**不可能**再来),
 * **提前**结束等待。
 *
 * ## 为什么提前结束**不是**放行
 * ```
 * 它不改任何状态 ⇒ 调用点断言的原条件此时仍为假 ⇒ 那条 `ok/eq` **照旧红**。
 * 它只是把"明知不会再来"的等待从"白等满 15 秒、只报一句超时"变成
 * "立刻红,并把 closed/err 写进消息" ⇒ 报告第一次能分清「握手真没发生」与「只是慢」。
 * ```
 */
async function waitConn(cond: () => boolean, t: ConnTrace, budgetMs: number): Promise<number> {
  return await waitUntil(() => cond() || t.closed !== null || t.err !== null, budgetMs);
}

/** 上行**文本帧**(与服务端分流约定一致:1 字节类型头 0x01 + JSON)。 */
function uplinkText(obj: Record<string, unknown>): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

type Raw = {
  srv: WsServerHandle;
  sim: WorldSim;
  rt: ReturnType<typeof assemble>['runtime'];
  ws: WebSocket;
  /** 客户端状态:**生产编解码**合入的结果(`ClientStateStore` 内部同一对函数)。 */
  client: RoomState;
  packets: { count: number; lastTick: number };
  welcome: WelcomeFrame | null;
  /** 连接级终态(为失败消息而生,见 `connState`)。 */
  conn: ConnTrace;
  close(): Promise<void>;
};

/**
 * 起**真服务端** + 一个**真 WebSocket 客户端**,并用**生产编解码**合入下行。
 *
 * ⚠️ 房间用 `assemble()` 且**不传 `clock`** ⇒ 走真时钟:反作弊按「服务端帧水位」
 *   发移动额度(`AntiCheatRoom.tick` 由 `room.step()` 每帧调)。固定时钟会让移动
 *   全被判 TELEPORT(`dtTicks = 0`)—— 那是**夹具问题**(WS-FND-63 记过同一条)。
 */
async function rawConnect(roomId: string, userId: string): Promise<Raw> {
  const a = assemble({ roomId, ownerId: 'o', sizeCells: 64 });
  const sim = a.host as unknown as WorldSim;
  const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20 });
  /* ★ 2026-11-17:鉴权上线 —— `?userId=` 只是**声明**,`?token=`(HMAC 凭证)才是证据。
     token 由**生产的签发入口** `runtime.issueJoinToken` 现签(与 `join` 里验签的
     是同一把密钥 `authSecret`):不硬编码、也不跳过鉴权(跳过就不是端到端了)。 */
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?userId=${encodeURIComponent(userId)}`
    + `&token=${encodeURIComponent(a.runtime.issueJoinToken(userId))}`);
  ws.binaryType = 'arraybuffer';
  const out: Raw = {
    srv, sim, rt: a.runtime, ws,
    client: createRoomState(roomId),
    packets: { count: 0, lastTick: -1 },
    welcome: null,
    conn: { opened: false, helloSent: false, closed: null, err: null },
    close: async () => undefined,
  };
  /* ★ 2026-11-18:先**登记状态**,再发 hello。
     ⚠️ 老写法是 `ws.send(hello)` **之后**才 `markOpened()` —— 只要 `send` 抛一次
     (满载下真的发生过),那个 promise 就**永不落定** ⇒ 调用点报出来的是
     「超时 15000ms:socket 打开」,而 socket 其实**打开了**。那是"消息与真因无关"的典型:
     现在 `send` 的异常被记进 `conn.err`(+ `helloSent=false`),失败消息里直接看得见。 */
  ws.addEventListener('open', () => {
    out.conn.opened = true;
    try {
      ws.send(uplinkText({ t: 'hello', protocolVersion: 3, contentClaim: null }));
      out.conn.helloSent = true;
    } catch (e) {
      out.conn.err = `hello 发送失败:${e instanceof Error ? e.message : String(e)}`;
    }
  });
  ws.addEventListener('message', ((ev: { data: unknown }) => {
    const d = ev.data;
    if (typeof d === 'string') { out.welcome = JSON.parse(d) as WelcomeFrame; return; }
    if (!(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d)) return;
    const bytes = d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength);
    if (bytes.byteLength === 0) return;
    const pkt = decodePacket(bytes);
    out.client = applyPacket(out.client, pkt);
    out.packets.count += 1;
    out.packets.lastTick = pkt.tick;
  }) as never);
  /* ★ 2026-11-18 新增:以前**没有**这两个监听 ⇒ 连接进终态(被拒 1008 / 掉线 / err)
     这件事在套件里**完全不可见**,等待只能等到上限。 */
  ws.addEventListener('close', ((ev: { code: number; reason: string }) => {
    out.conn.closed = { code: ev.code, reason: ev.reason };
  }) as never);
  ws.addEventListener('error', ((ev: { error?: { name?: string; message?: string } }) => {
    out.conn.err = ev.error
      ? `${ev.error.name ?? 'Error'}: ${ev.error.message ?? ''}`
      : 'error(无详情)';
  }) as never);
  out.close = async () => {
    try { ws.close(); } catch { /* 已关 */ }
    await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
  };
  return out;
}

const clientX = (c: Raw, id: string): number | undefined =>
  c.client.players.find((p) => p.id === id)?.x;

function where(c: Raw, id: string, movedTo: number): string {
  const st = c.rt.state.players.find((p) => p.id === id);
  return `client=${clientX(c, id) ?? '缺玩家'} 服务端state=${st === undefined ? 'n/a' : st.x} 权威=${movedTo} `
    + `packets=${c.packets.count} clientTick=${c.client.meta.tick}`;
}

/**
 * 逐条发 `move` 直到世界真的动了(反作弊额度按服务端帧水位发放)。
 *
 * ★ 2026-11-18:每次发的间隔从 `sleep(80)` 改成**等条件成立**(上限 `WS_MOVE_STEP_MS`)
 *   —— 动了就**立刻**返回(单跑更快),没动则重发(额度还没发下来),重发上限
 *   `MOVE_PUSH_MAX` 与原来的 12 次同量级。返回值带上"重发几次 / 一共等了多久",
 *   失败消息里就能看见「是没动,还是没等到额度」。
 */
async function pushUntilMoved(
  c: Raw, id: string, y0: number,
): Promise<{ movedTo: { x: number; y: number }; lastSent: number; waitedMs: number; attempts: number }> {
  const x0 = c.sim.playerPosition(id)!.x;
  const moved = (): boolean => c.sim.playerPosition(id)!.x > x0 + 1e-9;
  let lastSent = x0;
  let waitedMs = 0;
  let attempts = 0;
  for (let seq = 1; seq <= MOVE_PUSH_MAX; seq += 1) {
    const target = x0 + 0.05 * seq;
    try {
      c.ws.send(uplinkText({ t: 'move', tick: seq, x: target, y: y0, z: 0, seq }));
    } catch (e) {
      /* 发不出去 ⇒ 再等也不会动;下面那条 `ok` 照旧红,现场经 `connState` 报出。 */
      c.conn.err = `move 发送失败:${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    lastSent = target;
    attempts = seq;
    const w = await waitConn(moved, c.conn, WS_MOVE_STEP_MS);
    waitedMs += w < 0 ? WS_MOVE_STEP_MS : w;
    if (moved()) break;
    /* 连接已进终态 ⇒ 不再重发(重发也没人收;`ok` 照旧红)。 */
    if (c.conn.closed !== null || c.conn.err !== null) break;
  }
  return { movedTo: c.sim.playerPosition(id)!, lastSent, waitedMs, attempts };
}

async function main(): Promise<void> {
  /* ── FND65-1 ★★★ 主判据 ── */
  await atest('FND65-1 ★★★ US2 三段因果:上行 move ⇒ 世界坐标真的变 ⇒ 快照带回同一个坐标', async () => {
    const c = await rawConnect('r65us2', 'us2e2e');
    try {
      /* 前置 1:连接打开 —— **等条件成立**(上限具名);到点仍为假 ⇒ 下面这条 ok 照旧红。 */
      const tOpen = await waitConn(() => c.conn.opened, c.conn, WS_OPEN_BUDGET_MS);
      ok(c.conn.opened,
        `socket 应打开(${waitedText(tOpen, WS_OPEN_BUDGET_MS)};${connState(c.conn)})`);
      /* 前置 2:握手 welcome 到达。 */
      const tWelcome = await waitConn(() => c.welcome !== null, c.conn, WS_WELCOME_BUDGET_MS);
      ok(c.welcome !== null,
        `welcome 应到达(${waitedText(tWelcome, WS_WELCOME_BUDGET_MS)};${connState(c.conn)})`);
      eq(c.welcome!.playerId, 'us2e2e', '握手给回的 playerId 必须来自 URL 的 ?userId=');
      /* 前置 3:客户端快照里出现自己。 */
      const tSnap = await waitConn(
        () => clientX(c, 'us2e2e') !== undefined, c.conn, WS_SNAPSHOT_BUDGET_MS,
      );
      ok(clientX(c, 'us2e2e') !== undefined,
        `客户端快照里应出现该玩家(${waitedText(tSnap, WS_SNAPSHOT_BUDGET_MS)};`
        + `${where(c, 'us2e2e', Number.NaN)};${connState(c.conn)})`);
      ok(c.srv.connCount() >= 1, '服务端应记录这条连接');

      const start = c.sim.playerPosition('us2e2e');
      ok(start !== null, '前置:世界里必须有这个玩家(否则下面在测空气)');
      const x0 = start!.x;
      const y0 = start!.y;
      eq(clientX(c, 'us2e2e'), x0, '前置:客户端与权威在移动**之前**一致');

      /* 段 2:上行。 */
      const push = await pushUntilMoved(c, 'us2e2e', y0);
      ok(push.movedTo.x > x0 + 1e-9,
        '★★ 世界坐标必须真的变了(修前 applyMove 只改投影、不写 physics.bodies;'
        + `重发 ${push.attempts} 次、${waitedText(push.waitedMs, WS_MOVE_STEP_MS)};`
        + `${connState(c.conn)})`);
      near(push.movedTo.x, push.lastSent, 1e-9, '★ 权威坐标应等于最后一条**被应用**的声明值');
      eq(push.movedTo.y, y0, '同一条报文里的 y 也要一致(没有被别的路径改写)');

      /* 段 3:下行 —— 快照必须把这个新位置带回来。 */
      const back = (): boolean => {
        const x = clientX(c, 'us2e2e');
        return x !== undefined && Math.abs(x - push.movedTo.x) < 1 / 512;
      };
      const tBack = await waitConn(back, c.conn, WS_SNAPSHOT_BUDGET_MS);
      ok(back(),
        `★★★ 下行快照应带回新位置(${waitedText(tBack, WS_SNAPSHOT_BUDGET_MS)};`
        + `${where(c, 'us2e2e', push.movedTo.x)};${connState(c.conn)})`);
      const got = clientX(c, 'us2e2e')!;
      /* 线上是 1/1024 定点 ⇒ 容差 1/512;断言的是"带着新位置回来",不是逐位相等。 */
      ok(Math.abs(got - push.movedTo.x) < 1 / 512, `★★★ 下行快照 x == 权威(${where(c, 'us2e2e', push.movedTo.x)})`);
      ok(got > x0 + 1e-9, `★★ 快照里的位置必须**与起点不同**(起点 ${x0} / 快照 ${got})`);
      near(clientX(c, 'us2e2e')!, c.rt.state.players.find((p) => p.id === 'us2e2e')!.x, 1 / 512,
        '★ 客户端的 x 必须等于服务端 state.players[].x(投影 → 编码 → 解码 三段一致)');
    } finally {
      await c.close();
    }
  });

  /* ── FND65-2 ★ 负对照:不发 move ⇒ 都不动 ── */
  await atest('FND65-2 ★ 负对照:一条 move 都不发 ⇒ 权威坐标与快照坐标都不变', async () => {
    const c = await rawConnect('r65idle', 'idle65');
    try {
      const tOpen = await waitConn(() => c.conn.opened, c.conn, WS_OPEN_BUDGET_MS);
      ok(c.conn.opened,
        `socket 应打开(${waitedText(tOpen, WS_OPEN_BUDGET_MS)};${connState(c.conn)})`);
      const tSnap = await waitConn(
        () => clientX(c, 'idle65') !== undefined, c.conn, WS_SNAPSHOT_BUDGET_MS,
      );
      ok(clientX(c, 'idle65') !== undefined,
        `客户端快照里应出现该玩家(${waitedText(tSnap, WS_SNAPSHOT_BUDGET_MS)};`
        + `${where(c, 'idle65', Number.NaN)};${connState(c.conn)})`);
      const a0 = c.sim.playerPosition('idle65')!;
      const s0 = clientX(c, 'idle65')!;
      /* ⚠️ 这是**观察窗**而不是"等某个事件":负对照要证明"不发就不动",
         故必须让 20Hz 广播真流过若干拍(否则"不变"只是因为没收到帧)。 */
      await sleep(IDLE_OBSERVE_MS);
      const a1 = c.sim.playerPosition('idle65')!;
      const s1 = clientX(c, 'idle65')!;
      eq(a1.x, a0.x, '★ 没有上行 ⇒ 权威 x 不变');
      eq(a1.y, a0.y, '★ 没有上行 ⇒ 权威 y 不变');
      eq(s1, s0, '★ 快照 x 也不变');
      ok(c.packets.count > 1, '期间快照确实在推进(否则"不变"只是因为没收到任何帧)');
    } finally {
      await c.close();
    }
  });

  /* ── FND65-3 ★ 有牙对照:换一个 userId ⇒ 动的是那一个玩家 ── */
  await atest('FND65-3 ★ 有牙对照:换一个 userId ⇒ 动的正是那一个玩家(不是常量/第一个)', async () => {
    const c = await rawConnect('r65who', 'zoe65');
    try {
      const tOpen = await waitConn(() => c.conn.opened, c.conn, WS_OPEN_BUDGET_MS);
      ok(c.conn.opened,
        `socket 应打开(${waitedText(tOpen, WS_OPEN_BUDGET_MS)};${connState(c.conn)})`);
      const tWelcome = await waitConn(() => c.welcome !== null, c.conn, WS_WELCOME_BUDGET_MS);
      ok(c.welcome !== null,
        `welcome 应到达(${waitedText(tWelcome, WS_WELCOME_BUDGET_MS)};${connState(c.conn)})`);
      eq(c.welcome!.playerId, 'zoe65', '★ welcome.playerId 跟随 URL');
      const tSnap = await waitConn(
        () => clientX(c, 'zoe65') !== undefined, c.conn, WS_SNAPSHOT_BUDGET_MS,
      );
      ok(clientX(c, 'zoe65') !== undefined,
        `客户端快照里应出现该玩家(${waitedText(tSnap, WS_SNAPSHOT_BUDGET_MS)};`
        + `${where(c, 'zoe65', Number.NaN)};${connState(c.conn)})`);
      const p0 = c.sim.playerPosition('zoe65');
      ok(p0 !== null, '★ 世界里登记的是 URL 里那个 id');
      const push = await pushUntilMoved(c, 'zoe65', p0!.y);
      ok(push.movedTo.x > p0!.x + 1e-9,
        `★ 动的必须是 \`zoe65\` 这个玩家(重发 ${push.attempts} 次、`
        + `${waitedText(push.waitedMs, WS_MOVE_STEP_MS)};${connState(c.conn)})`);
      ok(clientX(c, 'zoe65') !== undefined, '★ 快照里也是同一 id(不是别人的位置)');
    } finally {
      await c.close();
    }
  });

  /* ── FND65-4 ★ 生产客户端模块(`createSession`)那一半:握手 + 快照里能看见自己 ── */
  await atest('FND65-4 ★ `createSession`:真客户端模块能连上、进 live,并在快照里看到自己', async () => {
    const a = assemble({ roomId: 'r65session', ownerId: 'o', sizeCells: 64 });
    const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20 });
    const store = new ClientStateStore();
    let resolved: WelcomeFrame | null = null;
    const session = createSession({
      /* ★ token 用**生产的签发入口**现签(见 `rawConnect` 的注释:鉴权已上线) */
      url: `ws://127.0.0.1:${srv.port}/ws?userId=s65`
        + `&token=${encodeURIComponent(a.runtime.issueJoinToken('s65'))}`,
      store,
      events: {
        onWelcome: (w) => { resolved = w; },
        onFrame: () => undefined,
      },
    });
    /* ★ 2026-11-18:这个客户端**没有** `Raw` 那套连接级监听,故终态取自
       生产的状态机 `session.state`('closed' / 'failed') + 丢帧账
       ⇒ 失败消息同样能区分「握手真没发生」与「只是慢」。 */
    const sessDiag = (): string =>
      `state=${session.state} decodeErrors=${store.decodeErrors}`
      + ` droppedFrames=${session.droppedFrames} lastDrop=${session.lastDropReason ?? 'null'}`;
    try {
      const tWelcome = await waitUntil(
        () => resolved !== null || session.state === 'closed' || session.state === 'failed',
        WS_WELCOME_BUDGET_MS,
      );
      ok(resolved !== null,
        `welcome 应到达(生产客户端)(${waitedText(tWelcome, WS_WELCOME_BUDGET_MS)};${sessDiag()})`);
      const w = resolved!;
      eq(w.playerId, 's65', '★ 生产客户端的 playerId 也来自 URL');
      eq(session.state, 'live', `★ 握手通过后会话进 live(${sessDiag()})`);
      const seen = (): boolean => store.state.players.some((p) => p.id === 's65');
      const tSeen = await waitUntil(seen, WS_SNAPSHOT_BUDGET_MS);
      ok(seen(),
        `生产客户端应在快照里看到自己(${waitedText(tSeen, WS_SNAPSHOT_BUDGET_MS)};`
        + `players=${store.state.players.map((p) => p.id).join(',') || '空'};${sessDiag()})`);
      eq(store.localPlayerId, 's65', '★ store 的本地玩家 id 与 welcome 一致(圆心要用它)');
      eq(store.decodeErrors, 0, '★ 线上格式与客户端解码器一致');
      eq(resolved!.roomId, 'r65session', '★ welcome 带回房间 id');
    } finally {
      try { session.close(); } catch { /* 已关 */ }
      await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
    }
  });
}

await main();
/* ⚠️ `report()` 必须在异步区**之后**(否则异步断言还没跑完就打完计数了)。 */
report('WS-FND-65-us2-crossproc');
