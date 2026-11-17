/**
 * WS-FND-63 · **下行 `ackedSeq` 端到端**(D-14 / 方案 A:改 `shared/net/` 的包头)
 *
 * ## 本套件存在的理由
 *
 * 上游调查(`docs/TASK-100-ackedseq-frozen-unlock.md`)实测出**三段**断点,
 * 冻结层只占第三段。本套件钉的是**整条链**,不是某一端:
 * ```
 * 1 上行 seq 的生产者      client/src/main.ts 把 cmd.seq 带上(session.ts 的 MoveIntent.seq)
 * 2 服务端每连接记账        WsConn.ackedSeq(旧写法是闭包级全局 ⇒ 多连接互相冒充)
 * 3 下行包头那 4 字节       shared/net/delta.ts 的 byte6..9;广播逐连接重写
 * ```
 *
 * ## 判据(5 条,右侧都是**字面量**,不取自被测常量)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 版本 = 3;`encodeFull`/`encodeDelta`/`decodePacket` 往返自洽(含 byte6..9 = ack) | 常量改回 1/2、占位 4 字节挪位置、解码少读 4 字节 |
 * | 2 | 真 `createSession` + 真 `startWsServer`:上行 seq ⇒ 服务端记 ack ⇒ 包头带回 ⇒ `store.lastAckedSeq` | `main.ts` 不发 seq、服务端不推进 `c.ackedSeq`、广播不重写那 4 字节 |
 * | 3 | 客户端**真的剪枝**(pending 变短、prunedTotal 增长),且数来自**线上** | 剪枝被删 / 计数器不涨 / 本地伪造 ack |
 * | 4 | **多连接不互相冒充**:A 的 ack = A 自己的 5,B 的 = -1(负对照) | 退回闭包级全局 ack(两条连接会读到同一个数) |
 * | 5 | **因果**:`applyMove` 抛错 ⇒ ack 不推进;上行不带 `seq` ⇒ ack 不推进 | 把 ack 推进挪到 `apply` **之前** / 无条件每帧推进 |
 *
 * ★ 与 `tests/WS-FND-58` 的分工:58 钉**预测器**那一半(剪枝语义、摇杆、代码态哨兵);
 *   63 钉**两端之间**那一半(字节真的从服务端走到客户端并剪了队列)。
 *   两者都过,才说明「两端各自的实现」与「它们之间的约定」同时成立。
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';

import { assemble } from '../server/src/index.ts';
import { startWsServer, type WsServerHandle } from '../server/src/net/ws_server.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { createSession, type WelcomeFrame } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import { LocalPredictor } from '../client/src/net/predictor.ts';
import {
  PROTOCOL_VERSION, PacketOp,
  applyPacket, decodePacket, encodeDelta, encodeFull,
} from '../shared/net/delta.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/** 异步版 `test`(`harness.test()` 不 await 传入的函数 ⇒ 传 async 进去会**静默假绿**)。 */
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
 * **握手预算**(不是重试):真 socket + 真房间,满载跑门禁时 `connect → open` 是重尾。
 * 2026-11-17 实测:全量门禁并发下 5 s 会偶发超时(「超时 5000ms:连接打开」),
 * 而单跑该套件每次都在 0.4 s 内到 —— 所以是**预算太紧**,不是时序缺陷(与 WS-13 同族)。
 * 超时仍会红:条件没成立就是没成立,这里只是给它足够时间成立。
 */
const WS_HANDSHAKE_BUDGET_MS = 15000;

/** 带超时兜底 —— 挂起的测试在 CI 里表现为「卡住」,不是「失败」。 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms:${what}`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

/**
 * ★ 等**状态**,不等时间:计数的更新发生在**服务端的消息回调**里,
 * 与测试的 `sleep` 没有任何同步关系 ⇒ 「睡够了」不等于「处理完了」(WS-FND-14 复盘)。
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

/** 上行帧 = 1 字节 tag + 载荷(契约 §12.1:上行有 tag、下行没有)。 */
function uplinkText(obj: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

/* ── 1 真客户端模块(生产路径)── */

type RealClient = {
  srv: WsServerHandle;
  store: ClientStateStore;
  session: { readonly state: string; sendMove(i: { tick: number; x: number; y: number; z: number; seq?: number }): boolean; close(): void };
  welcomeArrived: Promise<WelcomeFrame>;
  sawFrame: { count: number };
  close(): Promise<void>;
};

/**
 * 起真服务端 + 用**真 `createSession`**连上去(同 `WS-FND-15` 的做法)。
 *
 * ⚠️ 房间用 `assemble()`,**不传 `clock`** ⇒ 走真时钟:反作弊按「服务端帧水位」
 *   发移动额度(`AntiCheatRoom.tick` 由 `room.step()` 每帧调),固定时钟会让
 *   第 2 条以后的移动全被判 TELEPORT(dtTicks = 0)—— 那是夹具问题,不是被测问题。
 */
async function connectReal(roomId: string, userId: string): Promise<RealClient> {
  const a = assemble({ roomId, ownerId: 'o', sizeCells: 64 });
  const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20 });
  const store = new ClientStateStore();
  const sawFrame = { count: 0 };
  let resolveWelcome: (w: WelcomeFrame) => void = () => undefined;
  const welcomeArrived = new Promise<WelcomeFrame>((res) => { resolveWelcome = res; });

  const session = createSession({
    url: `ws://127.0.0.1:${srv.port}/ws?userId=${userId}`,
    store,
    events: {
      onWelcome: (w) => { resolveWelcome(w); },
      onFrame: (r) => { if (r.changed) sawFrame.count += 1; },
    },
  });

  return {
    srv, store, session, welcomeArrived, sawFrame,
    close: async () => {
      try { session.close(); } catch { /* 已关 */ }
      await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
    },
  };
}

/* ── 2 裸 WebSocket(看**原始字节**,判"每连接的包头里到底写了什么")── */

type RawClient = {
  ws: WebSocket;
  /** 收到的二进制帧(下行裸协议包)。 */
  bin: Uint8Array[];
  welcome: Record<string, unknown> | null;
  opened: Promise<void>;
  done: Promise<void>;
};

function rawConnect(port: number, userId: string): RawClient {
  const bin: Uint8Array[] = [];
  const out: RawClient = {
    ws: null as unknown as WebSocket,
    bin,
    welcome: null,
    opened: null as unknown as Promise<void>,
    done: null as unknown as Promise<void>,
  };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?userId=${userId}`);
  out.ws = ws;
  ws.binaryType = 'arraybuffer';
  let markOpened: () => void = () => undefined;
  out.opened = new Promise<void>((res) => { markOpened = res; });
  out.done = new Promise<void>((res) => {
    ws.addEventListener('open', () => {
      markOpened();
      ws.send(uplinkText({ t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null }));
    });
    ws.addEventListener('message', ((ev: { data: unknown }) => {
      const d = ev.data;
      if (typeof d === 'string') { out.welcome = JSON.parse(d) as Record<string, unknown>; return; }
      if (d instanceof ArrayBuffer) { bin.push(new Uint8Array(d)); return; }
      if (ArrayBuffer.isView(d)) {
        bin.push(new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength));
      }
    }) as never);
    ws.addEventListener('close', () => res());
    ws.addEventListener('error', () => res());
  });
  return out;
}

/** 最后收到的那一帧(断言"包头里写了什么"必须看**原始字节**)。 */
function lastFrame(c: RawClient): Uint8Array {
  ok(c.bin.length > 0, '该连接应至少收到 1 个二进制帧(否则下面的断言在测空气)');
  return c.bin[c.bin.length - 1]!;
}

async function teardown(clients: RawClient[], srv: WsServerHandle): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

/**
 * 替身房间:**每次 `step()` 都给一个非空帧**,且 `applyMove` 可以被"弄抛错"。
 *
 * ## 为什么这里必须用替身
 * 判据 5 要问的是「`applyMove` **抛错**时 ack 还推不推进」——
 * 真房间不会因为一条移动就抛错,这条**在真房间里造不出来**(只能注入,那要改生产文件)。
 * ⚠️ 它**只**替身房间,替身不了运输层:帧仍然要走 `ws_server` 的编帧 + 逐连接写 ack。
 */
function makeStubRoom(): { room: unknown; applied: (number | undefined)[] } {
  const applied: (number | undefined)[] = [];
  const state = createRoomState('stub63');
  let tick = 0;
  const room = {
    id: 'stub63',
    join: (): { ok: boolean } => ({ ok: true }),
    leave: (): boolean => true,
    disconnect: (): boolean => true,
    step: (): Uint8Array => { tick += 1; return encodeFull(state, tick).bytes; },
    snapshotFor: (): Uint8Array => encodeFull(state, 0).bytes,
    cloneState: (): unknown => state,
    applyMove: (_userId: string, intent: { x: number; seq?: number }): unknown => {
      /* x < 0 = "这条移动应用失败"的暗号(真房间那边是抛错)。 */
      if (intent.x < 0) throw new Error('替身房间:故意让 applyMove 抛错');
      applied.push(intent.seq);
      return { allowed: true };
    },
  };
  return { room, applied };
}

/* ═══════════════════ 1. 主段(异步)═══════════════════ */

async function main(): Promise<void> {
  /* ── FND63-1 ★ 版本 = 3 且三个出口自洽(往返 + 那 4 字节的位置)── */
  await atest('FND63-1 ★ 版本 = 3;encodeFull/encodeDelta/decodePacket 自洽(byte6..9 = ack)', async () => {
    const rt = assemble({ roomId: 'codec63', ownerId: 'o', sizeCells: 32 }).runtime;
    rt.join({ userId: 'c1' });
    const state = rt.cloneState();

    const full = encodeFull(state, 7);
    const pkt = decodePacket(full.bytes);
    /* 字面量锚定:右侧**不是** import 来的常量(否则改常量两边一起变)。 */
    eq(pkt.version, 3, '报文头版本号 = 3(字面量锚定)');
    eq(full.bytes[0], 3, '首字节就是版本号(u8)');
    eq(pkt.op, PacketOp.FULL, '全量出口的 op');
    eq(pkt.tick, 7, 'tick 仍是第 3..6 字节');
    /* 编码侧只写占位 ⇒ 解码回来必须是「没有 ack」(-1)。线上编码 = `ackedSeq + 1`。 */
    eq(pkt.ackedSeq, -1, 'encode 侧写占位 0 ⇒ 解码成 -1(「没有 ack」,不是"第 0 条")');
    eq(pkt.bytesConsumed, full.bytes.length, '头变长后仍**恰好**消耗完(尾部不许有垃圾)');

    /* 往返:decode → applyPacket 重建出与源状态一致的房间(头/载荷顺序都对才可能)。 */
    const rebuilt = applyPacket(empty(), pkt);
    eq(rebuilt.meta.tick, 7, 'applyPacket 用包头 tick 覆盖(它不是 diff 字段)');
    eq(rebuilt.players.length, state.players.length, '玩家数往返一致');
    eq(rebuilt.players[0]!.id, 'c1', '玩家 id 往返一致');
    eq(rebuilt.players[0]!.x, state.players[0]!.x, 'x 往返一致(定点量化后)');
    eq(rebuilt.players[0]!.y, state.players[0]!.y, 'y 往返一致');

    /* ★★ 那 4 字节**真的**是 ackedSeq:改它 ⇒ 只有 ack 变,别的字段一个都不许动。 */
    const tampered = Uint8Array.from(full.bytes);
    tampered[6] = 5; tampered[7] = 0; tampered[8] = 0; tampered[9] = 0;
    const t = decodePacket(tampered);
    eq(t.ackedSeq, 4, '★ byte6..9 就是 ackedSeq(小端;线上 5 ⇒ 内部 4)');
    eq(t.removed.length, pkt.removed.length, 'removedCount 仍从 byte10 起(顺序没被破坏)');
    eq(t.upserts.length, pkt.upserts.length, 'upsertCount 与载荷也没被那 4 字节带偏');
    eq(t.bytesConsumed, pkt.bytesConsumed, '长度不变(只覆写 4 字节)');

    /* 差分出口共用**同一个头**(`encodeFull` 是 `encodeDelta(null, ...)` 的薄壳)。 */
    const next = rt.cloneState();
    next.players[0]!.x += 1;
    const delta = encodeDelta(state, next, 8);
    const dp = decodePacket(delta.bytes);
    eq(dp.version, 3, '差分帧的版本同样 = 3');
    eq(delta.bytes[1], 1, 'op = DELTA(1)');
    eq(dp.op, PacketOp.DELTA, '差分帧解出的 op');
    eq(dp.tick, 8, '差分帧的 tick');
    eq(dp.ackedSeq, -1, '差分帧同样只写占位(真值由运输层填)');
    eq(dp.bytesConsumed, delta.bytes.length, '差分帧也恰好消耗完');

    /* 空差量的长度是**布局的地基**:头 10(ver1+op1+tick4+ack4)+ 两级计数 4 = 14。 */
    const same = rt.cloneState();
    eq(encodeDelta(state, same, 9).bytes.length, 14, '空差量 = 14 字节(旧布局是 10)');
    eq(same.meta.tick, state.meta.tick, '前置:两次 clone 之间世界确实没变');
  });

  /* ── FND63-2 ★★ 端到端:上行 seq ⇒ 服务端记账 ⇒ 包头带回 ⇒ 客户端落账 ── */
  await atest('FND63-2 ★★ 端到端:上行 seq ⇒ 服务端 ack ⇒ 包头 ⇒ store.lastAckedSeq', async () => {
    const c = await connectReal('r63e2e', 'e2e63');
    try {
      const w = await withTimeout(c.welcomeArrived, WS_HANDSHAKE_BUDGET_MS, 'welcome 到达');
      eq(w.protocolVersion, 3, 'welcome 带回的协议版本 = 3(字面量;版本门两端都认 3)');
      eq(c.session.state, 'live', '握手通过后应进 live(版本不匹配的话这里就是 failed)');
      eq(c.srv.lastAckedSeqFor('e2e63'), -1, '还没发过带 seq 的 move ⇒ 该连接的 ack 仍是 -1');
      eq(c.srv.lastAckedSeqFor('查无此人'), -1, '不存在的连接 ⇒ -1(不是"全局最高")');

      /* 发 3 条**带 seq** 的移动;每条都等"它被应用"这个**状态**。 */
      for (let seq = 1; seq <= 3; seq += 1) {
        const sent = c.session.sendMove({ tick: seq, x: 0.5 + seq * 0.05, y: 0.5, z: 0, seq });
        ok(sent, `第 ${seq} 条移动应真的发出(未连接时 sendMove 返回 false)`);
        await waitUntil(() => c.srv.lastAckedSeqFor('e2e63') >= seq, 5000,
          `服务端应用 seq=${seq}`, () => c.srv.lastAckedSeqFor('e2e63'));
        /* 让服务端帧水位(反作弊的额度基准)前进 —— 见 connectReal 的注释。 */
        await sleep(60);
      }
      eq(c.srv.lastAckedSeqFor('e2e63'), 3, '★ 服务端记到 3,且**没有**超过发出去的条数');

      /* 下一帧把它带回客户端:store 记的就是**包头里那 4 字节**解出来的数。 */
      await waitUntil(() => c.store.lastAckedSeq === 3, 5000,
        '客户端从包头读到 ack=3', () => c.store.lastAckedSeq);
      eq(c.store.lastAckedSeq, 3, '★★ 包头 ack == 服务端**已应用**的上行 seq');
      ok(c.sawFrame.count > 0, `应至少合入 1 帧快照(实得 ${c.sawFrame.count} 帧)`);
      eq(c.store.decodeErrors, 0, '新头(14 字节)必须被客户端解码器认下来(否则这里 > 0)');
      /* 上行 seq 与 ack 不是同一个数:ack 反映的是"服务端处理到哪",不是"我发了多少" */
      ok(c.store.state.meta.tick > 0,
        `权威状态真的在推进(否则整条链路只是空转);实得 tick=${c.store.state.meta.tick}`);
    } finally {
      await c.close();
    }
  });

  /* ── FND63-3 ★★ 客户端**真的**剪枝,且用的数是线上来的 ── */
  await atest('FND63-3 ★★ 客户端剪枝:pending 变短 + prunedTotal 增长(数来自线上)', async () => {
    const c = await connectReal('r63prune', 'prune63');
    try {
      await withTimeout(c.welcomeArrived, WS_HANDSHAKE_BUDGET_MS, 'welcome 到达');

      /* 预测器先攒 4 条待确认(与生产同一入口 `step`)。 */
      const p = new LocalPredictor();
      for (let seq = 1; seq <= 4; seq += 1) p.step({ seq, moveX: 1, moveY: 0, jump: false });
      eq(p.pendingCount, 4, '先喂 4 条 ⇒ 4 条待确认');
      eq(p.prunedTotal, 0, '基线:还没剪过');

      /* ★ 负对照:没有 ack 时**一条都不剪**(否则"每帧无条件清队列"也能让下面变绿)。 */
      p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0 });
      eq([p.pendingCount, p.prunedTotal], [4, 0], '未给 ackedSeq ⇒ 不剪(降级:靠 MAX_PENDING)');

      for (let seq = 1; seq <= 4; seq += 1) {
        ok(c.session.sendMove({ tick: seq, x: 0.5 + seq * 0.05, y: 0.5, z: 0, seq }), `第 ${seq} 条应发出`);
        await waitUntil(() => c.srv.lastAckedSeqFor('prune63') >= seq, 5000,
          `服务端应用 seq=${seq}`, () => c.srv.lastAckedSeqFor('prune63'));
        await sleep(60);
      }
      await waitUntil(() => c.store.lastAckedSeq === 4, 5000,
        '包头把 ack=4 带回来', () => c.store.lastAckedSeq);
      eq(c.store.lastAckedSeq, 4, '前置:要剪的那个数**确实来自线上的包头**');

      /* ★★ 用它剪:位置取预测器当前位置 ⇒ 零误差(IGNORE 档),断言只测剪枝。 */
      p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: c.store.lastAckedSeq });
      eq(p.pendingCount, 0, '★★ pending 变短(4 → 0)');
      eq(p.prunedTotal, 4, '★★ prunedTotal 增长(0 → 4,单调计数才能证明"剪枝真的跑过")');
      eq(p.lastAckedSeq, 4, '预测器记到 4');

      /* 重复同一个 ack ⇒ 不重复计数(剪枝不是"每帧清空")。 */
      p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 4 });
      eq([p.pendingCount, p.prunedTotal], [0, 4], '重复 ack ⇒ 不重复计数');
    } finally {
      await c.close();
    }
  });

  /* ── FND63-4 ★★ 多连接不互相冒充(负对照:旧全局实现下两条会读到同一个数)── */
  await atest('FND63-4 ★★ 多连接:A 的 ack 是 A 的 5,B 的是 -1(不互相冒充)', async () => {
    const a = assemble({ roomId: 'r63multi', ownerId: 'o', sizeCells: 64 });
    const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20 });
    const A = rawConnect(srv.port, 'alice63');
    const B = rawConnect(srv.port, 'bob63');
    try {
      await withTimeout(Promise.all([A.opened, B.opened]), WS_HANDSHAKE_BUDGET_MS, '两条连接都打开');
      await waitUntil(() => srv.connCount() >= 2, 5000, '服务端握手完成 2 条', () => srv.connCount());

      /* A 连发 5 条带 seq;B **一条都不发**。 */
      for (let seq = 1; seq <= 5; seq += 1) {
        A.ws.send(uplinkText({ t: 'move', tick: seq, x: 0.5 + seq * 0.05, y: 0.5, z: 0, seq }));
        await waitUntil(() => srv.lastAckedSeqFor('alice63') >= seq, 5000,
          `A 的 seq=${seq} 被应用`, () => srv.lastAckedSeqFor('alice63'));
        await sleep(60);
      }
      eq(srv.lastAckedSeqFor('alice63'), 5, 'A 记到 5');
      eq(srv.lastAckedSeqFor('bob63'), -1, 'B 一条都没发 ⇒ 它的账是 -1');

      /* 等两条连接都收到**至少一帧**(ack 是在帧里回来的)。 */
      await waitUntil(() => A.bin.length >= 2 && B.bin.length >= 2, 5000,
        '两条连接各自都收到帧', () => ({ a: A.bin.length, b: B.bin.length }));
      const aPkt = decodePacket(lastFrame(A));
      const bPkt = decodePacket(lastFrame(B));
      eq(aPkt.ackedSeq, 5, '★ A 收到的帧里 ack = A 自己的 5');
      eq(bPkt.ackedSeq, -1, '★ B 收到的帧里 ack = -1(不是 A 的 5)');
      ok(aPkt.ackedSeq !== bPkt.ackedSeq,
        '★★ 负对照:两条连接的包头 ack **不相同** —— 退回闭包级全局实现时这里会相等');
      /* 同一帧序里两条连接的 tick 可能不同(各自收帧时刻不同),但版本必须一样。 */
      eq(aPkt.version, 3, 'A 的帧版本 = 3');
      eq(bPkt.version, 3, 'B 的帧版本 = 3');
    } finally {
      await teardown([A, B], srv);
    }
  });

  /* ── FND63-5 ★★ 因果:ack 由「应用成功 + 带 seq」推进,不是每帧无条件推进 ── */
  await atest('FND63-5 ★★ 因果:applyMove 抛错 / 上行不带 seq ⇒ ack 都不推进', async () => {
    const { room, applied } = makeStubRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
    const c = rawConnect(srv.port, 'causal63');
    try {
      await withTimeout(c.opened, WS_HANDSHAKE_BUDGET_MS, '连接打开');
      await waitUntil(() => srv.connCount() >= 1, 5000, '握手完成', () => srv.connCount());
      await waitUntil(() => c.welcome !== null, 5000, 'welcome 到达');

      /* 1 正常一条:ack 推进到 1。 */
      c.ws.send(uplinkText({ t: 'move', tick: 1, x: 0.5, y: 0.5, z: 0, seq: 1 }));
      await waitUntil(() => srv.lastAckedSeqFor('causal63') === 1, 5000,
        '正常移动把 ack 推到 1', () => srv.lastAckedSeqFor('causal63'));

      /* 2 让 applyMove **抛错**那条(x < 0):ack 必须停在 1。 */
      const framesBefore = srv.framesSent();
      c.ws.send(uplinkText({ t: 'move', tick: 2, x: -1, y: 0.5, z: 0, seq: 2 }));
      /* 先等"服务端确实又跑了若干帧"(否则 ack 没动可能只是因为它还没被读到)。 */
      await waitUntil(() => srv.framesSent() > framesBefore + 4, 5000,
        '广播又跑了若干帧', () => srv.framesSent() - framesBefore);
      await waitUntil(() => applied.includes(undefined) || applied.length > 0, 5000, '第一条已进"已应用"清单',
        () => applied.slice(0, 8));
      eq(srv.lastAckedSeqFor('causal63'), 1, '★ applyMove 抛错 ⇒ ack 停在 1(不许记成"处理过了")');
      ok(!applied.includes(2), '★ 抛错那条**不在**"已应用"清单里(证明它真的没被应用)');

      /* 3 合法但不带 seq 那条:服务端**应用了**它,但没有 ack 可推。 */
      c.ws.send(uplinkText({ t: 'move', tick: 3, x: 0.6, y: 0.5, z: 0 }));
      await waitUntil(() => applied.includes(undefined), 5000,
        '不带 seq 的那条被应用(seq = undefined)', () => applied.slice(0, 8));
      eq(srv.lastAckedSeqFor('causal63'), 1, '★ 没有 seq 就没有 ack(ack 是 seq 的函数,不是帧的函数)');
      ok(applied.length >= 2, `前置:确实有 2 条以上移动进了 applyMove(实得 ${applied.length})`);
    } finally {
      await teardown([c], srv);
    }
  });
}

/** 空白权威状态 —— 与 `state_store.ts` 的 `emptyRoomState` 同源(`applyPacket` 只要形状)。 */
function empty() {
  return createRoomState('r63empty');
}

await main();
/* ⚠️ `report()` 必须在异步区**之后** —— 否则计数只统计"跑完的那部分"。 */
report('WS-FND-63');
