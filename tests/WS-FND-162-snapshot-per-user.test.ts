/**
 * WS-FND-162 —— 第十二轮 P1:**被踢者不再收帧(装配层 B 路)** + `snapshotFor` 的按人裁剪。
 *
 * ## 本套件要回答的两个问题(以及它们为什么必须分开问)
 * ```text
 * P1-1 装配层(`room.colyseus.ts`)自己的 `this.broadcast('delta', packet)` 路径:
 *      `kick()` 只走 `leave()`(摘席位、**不断连接**)⇒ 被踢者那条 Colyseus
 *      连接还在 `this.clients` 里 ⇒ 继续收**整房** delta。
 *      `WS-FND-161` 修的是**运输层**(`ws_server.ts` 的席位裁剪),
 *      而 B 路(Colyseus 装配)是 `scripts/play.ts` 真正跑的那条 ⇒ 修了一层不等于修了两层。
 * P1-2 `room.ts#snapshotFor(_userId)` 忽略参数:全房共用一份整房快照,
 *      被踢者 / 已离场者也拿得到「全量」。
 * ```
 *
 * ## 权威在哪一层(本条是**设计判据**,不是口号)
 * ```text
 * 「谁还是成员 / 谁的席位还在」 —— 唯一权威 = `RoomRuntime.members`(`room.ts#isSeated`)。
 * 两条投递层(Colyseus 装配 / 裸 WS 运输)都**只查它**,各自都不另存一本裁剪账;
 * 每层只对自己手上的连接集(Colyseus `this.clients` / 运输层 `conns`)负责。
 * ⇒ 两套裁剪不会打架:判据只有一条,被裁的连接不必通知(下一帧自动跟上)。
 * ```
 *
 * ## 判据表(每条都配负对照或注入;★ = 真 socket / 真房间)
 * ```text
 * FND162-1  P1-1 排除集:3 条连接中只有 1 条席位没了 ⇒ **恰好**排除它
 *           (负对照:另外两条不在排除集里 —— 排除集不是「谁都不发」)
 * FND162-2  P1-1 负对照:全员在席位 ⇒ 排除集 = **空数组** ⇒ 生产走**修前那一行裸广播**
 * FND162-3  P1-1 取键口径必须按**成员键**(sessionId ≠ userId):
 *           注入:改用 `client.sessionId` 当键 ⇒ 同一次判定结果翻转(带凭证的人被整片裁掉)
 * FND162-4  ★★ P1-1 真 socket:踢之后**一个 delta 字节都不再收**,而连接仍在;
 *           负对照:踢之前两人都在收(否则「不再收」可能只是「从没收到过」)
 * FND162-5  ★★ P1-1 注入对照:房间把 `isSeated` 换成恒真 ⇒ 同一 socket 判据翻转
 *           (被踢者**继续**收帧)⇒ 证明 FND162-4 有牙(且踢本身仍然成功)
 * FND162-6  ★ P1-1 最小夹具:裁剪发生在**投递那一刻** —— 被踢者仍在 `this.clients`
 *           与装配层自己的 `seatKeys` 里(本层不摘人、不记第二本账),席位真账里已无此人
 * FND162-7  P1-2 `snapshotFor`:成员 ⇒ 非空;**被踢 ⇒ 0 字节**;负对照:同一 id 踢之前非空;
 *           并且成员那份仍是**整房**(含别人 ⇒ 席位级裁剪,不是 AOI)
 * FND162-8  P1-2 边界:`disconnect()`(断线仍在宽限期)⇒ 快照**非空且与断线前逐字节一致**
 *           (注入:把判据写成 `connected` ⇒ 重连快照永远存不进去,这条立刻红)
 * FND162-9  P1-1 入场被拒的连接(伪造 token,从未绑座位)在 stepTick 期间
 *           `enqueueRaw` 恒 0;负对照:同一房里合法入场的连接收到帧
 * FND162-10 P1-1 fail-open:判据自己抛 ⇒ 按「收」处理(排除集为空)且**不**把房间带崩
 * ```
 *
 * ## 判据设计纪律(与 `WS-FND-132` / `-161` 同款)
 * ```text
 * 1 能真跑就不 grep 源码:「被踢者收不收帧」只由**真 socket 上读到的字节**回答;
 * 2 每条都配负对照:合法输入下同一个量必须**不动**;
 * 3 「注入」= 让被测路径真的走另一条分支(把 isSeated 换掉 / 用错取键函数),
 *   再断言判据**变红** —— 而不是把约定从源码里抄一遍。
 * ```
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';
import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { NetPersistRoom, deltaExclusions } from '../server/src/net/room.colyseus.ts';
import { RoomAction, RoomRuntime } from '../server/src/net/room.ts';
import { decodePacket } from '../shared/net/delta.ts';

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

/** 等**状态**,不等时间;失败消息里带实得值(否则「超时」与「值不对」长得一样)。 */
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
 * 桩客户端 —— 装配层只读 `sessionId`(`send` / `leave` / `enqueueRaw` 都是记账)。
 *
 * ⚠️ `enqueueRaw` **必须在**:Colyseus 的 `broadcast` 走的是它(报文编码**一次**后
 *    逐客户端投递),不是 `send`。少了它,「收件人」被命中时会直接抛 ——
 *    那会把「裁剪对不对」测成「夹具崩没崩」。
 */
type StubClient = {
  sessionId: string;
  sent: { t: string; m: unknown }[];
  leaveCalls: { code: number; reason: string }[];
  /** `enqueueRaw` 被调用的次数 = 装配层**真的把它算成收件人**了几次。 */
  rawFrames: number;
  send: (t: string, m?: unknown) => void;
  leave: (code?: number, reason?: string) => void;
  enqueueRaw: (bytes: ArrayLike<number>) => void;
};

function makeStubClient(sessionId: string): StubClient {
  const c: StubClient = {
    sessionId,
    sent: [],
    leaveCalls: [],
    rawFrames: 0,
    send: (t, m) => { c.sent.push({ t, m }); },
    leave: (code, reason) => { c.leaveCalls.push({ code: code ?? 0, reason: reason ?? '' }); },
    enqueueRaw: () => { c.rawFrames += 1; },
  };
  return c;
}

/** 真 NetPersistRoom 实例 —— 用结构类型读它的私有成员(理由见各断言)。 */
type RoomInternals = {
  clients: unknown[];
  runtime: RoomRuntime;
  maxClients: number;
  autoDispose: boolean;
  /** 装配层的**座位命名账**(`sessionId → 成员键`),不是席位真账。 */
  seatKeys: Map<string, string>;
  setSimulationInterval: (cb?: () => void, ms?: number) => void;
  onCreate: (o: unknown) => void;
  onJoin: (c: unknown, o: unknown) => void;
  /** 生产帧函数(20Hz 定时器调的就是它)—— 这里由测试**手动**驱动。 */
  stepTick: () => void;
};

let roomSeq = 0;

/**
 * 建一个**真** `NetPersistRoom` 并跑完 `onCreate`(只把两处定时器换掉:
 * Colyseus 构造器建的 50ms patch 表 + `onCreate` 起的 20Hz 仿真表)。
 * `setState` / `registerHandlers` / `new RoomRuntime` / `resolveRoomHost` 都**真跑**。
 */
function makeRoom(): RoomInternals {
  const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
  const realPatchRate = proto.setPatchRate;
  proto.setPatchRate = function stubPatchRate(): void { /* 不建 50ms patch 定时器 */ };
  let room: RoomInternals;
  try {
    room = new NetPersistRoom() as unknown as RoomInternals;
  } finally {
    proto.setPatchRate = realPatchRate;
  }
  /* 关掉「空房自动销毁」定时器(否则它自己 dispose,污染 stderr)。 */
  room.autoDispose = false;
  /* 20Hz 表由测试手动驱动:不起真实定时器,帧号才不会随挂钟漂。 */
  room.setSimulationInterval = () => { /* 手动 stepTick */ };
  roomSeq += 1;
  room.onCreate({ roomId: `room_fnd162_${roomSeq}`, maxPlayers: 16 });
  return room;
}

/** 推帧直到条件成立(`stepTick` 是唯一帧源;`prev === null` 的第一帧是空的,故从第二帧起才有报文)。 */
async function stepUntil(room: RoomInternals, pred: () => boolean, budgetMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    room.stepTick();
    await sleep(4);
    if (pred()) return true;
    if (Date.now() - t0 >= budgetMs) return pred();
  }
}

/* ── 真 socket 侧:一条 TCP 连接 = 一条「Colyseus 连接」 ── */

const DELTA_MARK = Buffer.from('delta', 'utf8');

function countMarks(buf: Buffer): number {
  let n = 0;
  let i = buf.indexOf(DELTA_MARK);
  while (i !== -1) { n += 1; i = buf.indexOf(DELTA_MARK, i + 1); }
  return n;
}

type WirePeer = {
  name: string;
  socket: Socket;
  chunks: Buffer[];
  closed: boolean;
  /** 对端**真的读到**了多少字节 / 多少个 `delta` 报文头(不是服务端「发了多少」)。 */
  bytes: () => number;
  marks: () => number;
  client: StubClient;
};

async function connectPeer(port: number, name: string): Promise<WirePeer> {
  const socket = connect({ host: '127.0.0.1', port });
  const chunks: Buffer[] = [];
  const peer: WirePeer = {
    name,
    socket,
    chunks,
    closed: false,
    bytes: () => Buffer.concat(chunks).length,
    marks: () => countMarks(Buffer.concat(chunks)),
    client: makeStubClient(name),
  };
  socket.on('data', (b: Buffer) => { chunks.push(b); });
  socket.on('close', () => { peer.closed = true; });
  await once(socket, 'connect');
  return peer;
}

/**
 * 把「Colyseus Client」这一端绑到**服务端那条 socket** 上。
 *
 * ⚠️ 必须绑服务端那一头:装配层做的事是「发给这个客户端」,数据要从**服务端**流向对端。
 *    写给客户端 socket 等于自己发给自己 —— 对端一个字节都读不到(实测踩过:
 *    那会把「裁剪对不对」测成「夹具方向反了」,而失败信息长得像「没收到帧」)。
 */
function bindServerSocket(peer: WirePeer, serverSide: Socket): void {
  /* ★ 装配层把报文交给 `enqueueRaw`(`broadcast` 的投递口)⇒ 这里**原样写进真 socket**:
     「收不收帧」于是由对端真的读到了什么决定,而不是由我们记账决定。 */
  peer.client.enqueueRaw = (bytes) => {
    serverSide.write(Buffer.from(Uint8Array.from(bytes)));
  };
  /* `send`(入场快照 / 回执)只留一个可读标记:本套件不判它的内容。 */
  peer.client.send = (t) => { serverSide.write(Buffer.from(`${t}\n`, 'utf8')); };
}

type Fixture = { room: RoomInternals; peers: WirePeer[]; close: () => Promise<void> };

/** 真房间 + 真 socket:房主走桩(只用来发起踢),其余每条连接一个 peer。 */
async function makeWireFixture(names: string[]): Promise<Fixture> {
  const room = makeRoom();
  const owner = makeStubClient('u_owner');
  room.clients.push(owner);
  room.onJoin(owner, {});

  const accepted: Socket[] = [];
  const server = createServer();
  server.on('connection', (s) => { accepted.push(s); });
  await new Promise<void>((res) => { server.listen(0, '127.0.0.1', () => { res(); }); });
  const port = (server.address() as AddressInfo).port;

  const peers: WirePeer[] = [];
  for (const name of names) {
    peers.push(await connectPeer(port, name));
    /* 等**服务端**真的接下这一条再连下一条 ⇒ 名字与连接的对应不靠竞态。 */
    const want = peers.length;
    await waitUntil(() => accepted.length === want, 5000,
      `服务端接到第 ${want} 条连接`, () => accepted.length);
  }
  for (let i = 0; i < peers.length; i += 1) {
    const p = peers[i] as WirePeer;
    /* ★ 投递口绑**服务端**那头(方向见 `bindServerSocket`)。 */
    bindServerSocket(p, accepted[i] as Socket);
    /* ⚠️ 次序与生产一致:Colyseus 先 `clients.push(client)`、再调 `onJoin`
       (`@colyseus/core/build/Room.js` 的 `_onJoin`)。 */
    room.clients.push(p.client);
    room.onJoin(p.client, {});
    ok(room.runtime.isSeated(p.name), `前置:${p.name} 入场后在席位上`);
  }
  const close = async (): Promise<void> => {
    /* ⚠️ 两侧都要 destroy:只关客户端会导致 `server.close()` 的回调永远不触发
       (实测:`net.Server` 上**没有** `closeAllConnections` —— 那是 http.Server 的),
       表现是整套件在报告打完之后**不退出**。 */
    for (const s of accepted) { try { s.destroy(); } catch { /* 已断 */ } }
    for (const p of peers) { try { p.socket.destroy(); } catch { /* 已断 */ } }
    await new Promise<void>((res) => { server.close(() => { res(); }); });
  };
  return { room, peers, close };
}

const FIXED_NOW = 1_000_000;

function makeRuntime(roomId: string): RoomRuntime {
  return new RoomRuntime({ roomId, ownerId: 'u_owner', clock: { nowMs: () => FIXED_NOW } });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ═══════════════ 1. P1-1 判据本身(纯函数,可逐条注入)═══════════════ */

async function main(): Promise<void> {
  await atest('FND162-1 ★ P1-1 排除集只含「席位没了」的那一条(负对照:另两条不动)', async () => {
    /* 变红条件:
       · 判据写成「永远都不排除」⇒ 被踢者继续收帧(排除集恒空);
       · 判据写成「不是 'u_a162' 就排除」之类 ⇒ 留场者被牵连(第二条断言红)。 */
    const a = makeStubClient('u_a162');
    const b = makeStubClient('u_b162');
    const c = makeStubClient('u_c162');
    const out = deltaExclusions([a, b, c], (x) => x.sessionId, (u) => u !== 'u_b162');
    eq(out.length, 1, `应恰好排除 1 条(实得 ${out.length})`);
    ok(out[0] === b, '被排除的必须是席位没了的那一条');
    ok(!out.includes(a) && !out.includes(c), '★ 负对照:另两条**不**在排除集里(不是「谁都不发」)');
    eq(deltaExclusions<StubClient>([], (x) => x.sessionId, () => false).length, 0,
      '空连接集 ⇒ 空排除集(空屋里不该凭空造出收件人/被裁者)');
  });

  await atest('FND162-2 ★ P1-1 负对照:全员在席位 ⇒ 排除集为空(生产走**修前那一行裸广播**)', async () => {
    /* 这条钉的是「常规路径零改动」:没人被裁时 `stepTick` 走的是
       `this.broadcast('delta', packet)`(与修前逐字相同),`{ except }` 那条支路不参与。
       变红条件:让判据在「全员在席位」时也返回非空 ⇒ 常规房每帧都走 except 支路。 */
    const a = makeStubClient('u_a162');
    const b = makeStubClient('u_b162');
    eq(deltaExclusions([a, b], (x) => x.sessionId, () => true).length, 0,
      '全员在席位 ⇒ 排除集必须是空数组(否则「没人被踢」这件事会被当成异常处理)');
  });

  await atest('FND162-3 ★ P1-1 取键必须按**成员键**;注入:用 sessionId 当键 ⇒ 结果翻转', async () => {
    /* 带凭证入场的成员键 = 凭证里的 userId,而 `sessionId` 是服务端另生成的连接号。
       本层若拿 sessionId 去查房间,查到的永远是「不在」⇒ 那类成员被**整片**裁掉。
       变红条件:生产路径把 `this.seatKeyOf(c)` 换成 `c.sessionId`(见 room.colyseus.ts 的调用点)。 */
    const sessA = makeStubClient('sess_a162');
    const sessB = makeStubClient('sess_b162');
    const sessC = makeStubClient('sess_c162');
    /* 成员键与连接号**逐字不同**(`bindSeat` 之后 `seatKeys` 就是这个映射):
       下面这张表模拟「房间侧的座位命名账」,而 `members` 模拟**席位真账**。 */
    const keys = new Map([['sess_a162', 'u_a162'], ['sess_b162', 'u_b162'], ['sess_c162', 'u_c162']]);
    const members = new Set(['u_a162', 'u_c162']);
    const seated = (u: string): boolean => members.has(u);
    const good = deltaExclusions([sessA, sessB, sessC], (x) => keys.get(x.sessionId) ?? x.sessionId, seated);
    eq(good.length, 1, `按成员键 ⇒ 恰好排除 1 条(实得 ${good.length})`);
    ok(good[0] === sessB, '被排除的是成员键为 u_b162 的那条连接');
    /* ★ 注入:同一个房间、同一份席位表,只把取键换成连接号。 */
    const injected = deltaExclusions([sessA, sessB, sessC], (x) => x.sessionId, seated);
    eq(injected.length, 3,
      `★★ 注入:用 sessionId 当键 ⇒ **三条全被裁**(实得 ${injected.length})—— `
      + '这正是「判据取错键」的后果,而它看起来只是「大家都安静了」');
  });

  await atest('FND162-10 ★ P1-1 fail-open:判据自己抛 ⇒ 按「收」处理,且房间不被带崩', async () => {
    /* 为什么刻意 fail-open:故障若表现成「这个人收不到帧」,就把「服务端坏了」
       伪装成「网络静了」(本仓反复点名的静默形态)。同款纪律见 `ws_server.ts` 的 `seatAlive`。
       变红条件:把 catch 里的 `seated = true` 改成 `false`(或删掉 try/catch ⇒ 这里抛出去)。 */
    const a = makeStubClient('u_a162');
    const b = makeStubClient('u_b162');
    const boom = (): boolean => { throw new Error('房间实现坏了'); };
    const out = deltaExclusions([a, b], (x) => x.sessionId, boom);
    eq(out.length, 0, '★ 判据抛错 ⇒ 排除集为空(fail-open:不许把「房间坏了」伪装成「他静音了」)');
  });

  /* ═══════════ 2. P1-1 装配层:真 socket(踢后不再收帧)═══════════ */

  await atest('FND162-4 ★★ P1-1 真 socket:被踢后**一个 delta 字节都不再收**,连接仍在;'
    + '负对照:踢之前两人都在收', async () => {
    /* 变红条件:
       · 把 `stepTick` 的那次 broadcast 改回无判据的裸广播(或删掉 `{ except }` 支路)⇒
         被踢者的字节数在踢后继续涨 ⇒ 核心断言红;
       · 把「踢」做成「断连」⇒ `socket` 会 close ⇒ 第三条断言红(本轮修的是**下行**,
         不是连接生命周期)。 */
    const fx = await makeWireFixture(['u_keep162', 'u_kick162']);
    try {
      const keep = fx.peers[0] as WirePeer;
      const kicked = fx.peers[1] as WirePeer;

      /* ★★ 负对照(前置):**踢之前**两人都在收帧 —— 否则下面「B 不再收」可能只是
         因为 B 从来就没收到过(那就不是判据)。 */
      const both = await stepUntil(fx.room, () => keep.marks() >= 3 && kicked.marks() >= 3, 8000);
      ok(both,
        `★★ 前置:两人都在收帧(实得 keep=${keep.marks()} 帧 / ${keep.bytes()} 字节,`
        + `kicked=${kicked.marks()} 帧 / ${kicked.bytes()} 字节)`);

      /* ★ 踢 = 生产路径:`KICK_MEMBER` 经动作宿主落到 `room.ts#kick` → `leave()`
         (只摘席位、**不断连接**)。 */
      const out = fx.room.runtime.dispatchAction('u_owner', RoomAction.KICK_MEMBER, { targetId: 'u_kick162' });
      eq(out.ok, true, `前置:房主踢成功(${out.reason ?? ''})`);
      eq(fx.room.runtime.isSeated('u_kick162'), false, '★ 踢的落点 = 席位被摘掉(权威表已无此人)');

      /* 让在途帧落地,再取**冻结基线**。 */
      await sleep(60);
      const frozenBytes = kicked.bytes();
      const frozenMarks = kicked.marks();
      const keepMarks0 = keep.marks();

      /* 以**留场者**继续收帧作为时间基准(否则「被踢者没收」可能只是广播停了)。 */
      const grew = await stepUntil(fx.room, () => keep.marks() >= keepMarks0 + 3, 8000);
      ok(grew,
        `负对照:留场者必须继续收帧(实得 +${keep.marks() - keepMarks0} 帧)`
        + ' —— 否则这只是「广播停了」');
      eq(kicked.bytes(), frozenBytes,
        `★★ 被踢者**不再收帧**:踢后留场者又多收了 ${keep.bytes() - frozenBytes} 字节,`
        + `而被踢者从 ${frozenBytes} 字节变成 ${kicked.bytes()} 字节`);
      eq(kicked.marks(), frozenMarks,
        `★★ 被踢者的 delta 报文数也必须冻结(实得 ${frozenMarks} → ${kicked.marks()})`);
      ok(!kicked.closed && !kicked.socket.destroyed,
        '★★ 移出广播集 ≠ 断连:被踢者的 socket 仍在(下行停,不是连接没了)');
      ok(fx.room.clients.includes(kicked.client),
        '★ 裁剪发生在**投递那一刻**:被踢者仍在 room.clients 里(本层不摘人、不记第二本账)');
    } finally {
      await fx.close();
    }
  });

  await atest('FND162-5 ★★ P1-1 注入对照:房间不再上报席位(`isSeated` 恒真)⇒ 被踢者**继续**收帧', async () => {
    /* 这条**故意**断言「修法没生效」:它把 FND162-4 的前提(判据在岗)抽掉,
       同一个 socket 判据必须翻转 —— 否则 FND162-4 可能只是「恒真」。
       ⚠️ 它同时如实记下本修法的**边界**:房间不上报席位时,装配层无从得知他的席位没了。 */
    const fx = await makeWireFixture(['u_keep162b', 'u_kick162b']);
    try {
      const keep = fx.peers[0] as WirePeer;
      const kicked = fx.peers[1] as WirePeer;
      const both = await stepUntil(fx.room, () => keep.marks() >= 3 && kicked.marks() >= 3, 8000);
      ok(both, `前置:两人都在收帧(实得 keep=${keep.marks()} / kicked=${kicked.marks()})`);

      /* ★ 注入:只改**判据**这一处。 */
      (fx.room.runtime as unknown as { isSeated: (u: string) => boolean }).isSeated = () => true;

      const out = fx.room.runtime.dispatchAction('u_owner', RoomAction.KICK_MEMBER, { targetId: 'u_kick162b' });
      eq(out.ok, true, '★ 踢本身仍然成功(证明下面翻转的是**判据**,不是「踢没生效」)');
      ok(fx.room.runtime.members.get('u_kick162b') === undefined,
        '★ 权威表里真的没有这个人了(注入只动了 `isSeated` 这一个读数)');

      await sleep(60);
      const frozen = kicked.bytes();
      const keepMarks0 = keep.marks();
      const grew = await stepUntil(fx.room, () => keep.marks() >= keepMarks0 + 3, 8000);
      ok(grew, `留场者收 3 帧(实得 +${keep.marks() - keepMarks0})`);
      ok(kicked.bytes() > frozen,
        `★★ 注入对照:没有席位判据 ⇒ 被踢者**照旧**收帧(${frozen} → ${kicked.bytes()} 字节)`
        + ' —— 这一条与 FND162-4 互为对方的前提');
    } finally {
      await fx.close();
    }
  });

  await atest('FND162-9 ★ P1-1 入场被拒的连接(伪造 token)一帧都不收;负对照:合法连接照收', async () => {
    /* 变红条件:把判据从「按席位」改成「按有没有 sessionId」/「按 clients 下标」⇒
       被拒的连接(它从未绑座位)会被算成收件人 ⇒ 第一条断言红。 */
    const room = makeRoom();
    const legit = makeStubClient('u_legit162');
    room.clients.push(legit);
    room.onJoin(legit, {});
    eq(room.runtime.isSeated('u_legit162'), true, '前置:合法连接入场成功');

    /* 伪造凭证 ⇒ 装配层拒绝(4001),**没有** `bindSeat`(旁表里没有这一条)。 */
    const forged = makeStubClient('sess_forged162');
    room.clients.push(forged);   /* Colyseus 侧的 client 在 leave 生效前仍在 clients 里 */
    room.onJoin(forged, { token: 'not-a-token' });
    ok(forged.sent.some((s) => s.t === 'reject'), '前置:伪造凭证入场被拒并回了 reject');
    eq(forged.leaveCalls.length, 1, '前置:被拒的连接被要求离开');
    eq(room.seatKeys.has('sess_forged162'), false, '前置:被拒的连接**没有**绑座位(旁表里没有它)');

    const okStep = await stepUntil(room, () => legit.rawFrames >= 3, 8000);
    ok(okStep, `★ 负对照:合法连接照旧收帧(实得 ${legit.rawFrames} 帧)`);
    eq(forged.rawFrames, 0,
      `★★ 入场被拒的连接一帧都不收(实得 ${forged.rawFrames})—— 它连席位都没有,`
      + '「没绑座位」与「被踢」在本判据里是同一件事(都不在成员表里)');
  });

  await atest('FND162-6 ★ P1-1 最小夹具:裁剪只读权威表,装配层不摘人不另记账', async () => {
    /* 「哪一层权威」的设计判据:
       装配层的 `seatKeys` 只是「连接 → 成员键」的**命名账**,不是席位真账;
       裁剪只问 `runtime.isSeated`。⇒ 本层不需要通知、也不可能与房间漂。
       变红条件:让 `kick` 路径顺手 `seatKeys.delete(...)`/从 `clients` 摘人 ——
       那会长出第二处状态,重入/重连路径上迟早漏一条。 */
    const room = makeRoom();
    const owner = makeStubClient('u_owner');
    const victim = makeStubClient('u_victim162');
    room.clients.push(owner, victim);
    room.onJoin(owner, {});
    room.onJoin(victim, {});
    const gotFrames = await stepUntil(room, () => victim.rawFrames >= 3, 8000);
    ok(gotFrames, `前置:被踢者踢之前真的在收帧(实得 ${victim.rawFrames})`);

    const kickedAt = victim.rawFrames;
    eq(room.runtime.kick('u_owner', 'u_victim162').ok, true, '前置:踢成功');
    const keepMarks0 = owner.rawFrames;
    const grew = await stepUntil(room, () => owner.rawFrames >= keepMarks0 + 3, 8000);
    ok(grew, `留场者继续收 3 帧(实得 +${owner.rawFrames - keepMarks0})`);
    eq(victim.rawFrames, kickedAt, `★★ 被踢者被裁掉(实得 ${kickedAt} → ${victim.rawFrames})`);

    eq(room.runtime.members.get('u_victim162'), undefined, '权威表(唯一席位真账)里已无此人');
    ok(room.clients.includes(victim), '★ 装配层**没有**把人从 clients 里摘掉(裁剪在投递那一刻做)');
    eq(room.seatKeys.get('u_victim162'), 'u_victim162',
      '★ 装配层的命名账**没被动过**(它只回答「这条连接算谁」,不回答「他还在不在」)');
  });

  /* ═══════════════ 3. P1-2 `snapshotFor` 按人裁剪 ═══════════════ */

  await atest('FND162-7 ★ P1-2 snapshotFor:成员非空、被踢 0 字节;负对照:踢之前非空 + 成员那份仍是整房', async () => {
    /* 变红条件:
       · 把 `this.members.has(userId)` 那行删掉(回到无条件 `encodeFull`)⇒ 第二条断言红;
       · 把空包改成「零实体的合法帧」⇒ `length === 0` 那条红(客户端会把它读成世界换代)。 */
    const rt = makeRuntime('r162_snap');
    rt.join({ userId: 'u_owner' });
    rt.join({ userId: 'u_victim162' });

    const before = rt.snapshotFor('u_victim162');
    ok(before.length > 0, `负对照:踢之前拿得到快照(实得 ${before.length} 字节)`);
    /* 成员拿到的是**整房**快照 ⇒ 里面**含别人**(席位级裁剪,不是 AOI 级)。 */
    const pkt = decodePacket(before);
    ok(pkt.upserts.some((u) => u.id === 'u_owner'),
      '★ 成员快照仍是整房(含房主 ⇒ 本条的裁剪是**席位级**,不是按人做实体过滤)');

    eq(rt.kick('u_owner', 'u_victim162').ok, true, '前置:踢成功');
    eq(rt.snapshotFor('u_victim162').length, 0,
      '★★ 被踢者拿到的是**空包**(0 字节 = ws_server 的 sendBinary 直接不发)');
    eq(rt.snapshotFor('u_ghost162').length, 0, '★ 也不给**从来不在房里**的 id 产出快照');
    ok(rt.snapshotFor('u_owner').length > 0, '负对照:留场者的快照照常产出');
  });

  await atest('FND162-8 ★ P1-2 边界:断线(仍在宽限期)的席位**仍**拿得到快照,且与断线前逐字节一致', async () => {
    /* 变红条件:把判据改成 `members.get(userId)?.connected === true`(看起来更「正确」)
       ⇒ 断线那一瞬间快照变空包 ⇒ 重连快照永远存不进去(库里只是少一行,没人报错)。
       这条就是那个陷阱的守卫。 */
    const rt = makeRuntime('r162_disc');
    rt.join({ userId: 'u_owner' });
    rt.join({ userId: 'u_away162' });
    const online = rt.snapshotFor('u_away162');
    ok(online.length > 0, '前置:在线时非空');

    eq(rt.disconnect('u_away162'), true, '前置:掉线被受理(席位保留、宽限期起算)');
    const offline = rt.snapshotFor('u_away162');
    ok(offline.length > 0,
      `★★ 断线待重连的席位**仍**拿得到快照(实得 ${offline.length} 字节)—— `
      + '判据是「在不在成员表里」,不是「在不在线」');
    ok(sameBytes(offline, online) === true, '★ 且与断线前**逐字节一致**(重连一致性的基础没被这条裁剪动过)');

    /* 负对照的另一半:主动离场(leave)与掉线**不同** —— 那条会摘席位。 */
    eq(rt.leave('u_away162'), true, '前置:主动离场');
    eq(rt.snapshotFor('u_away162').length, 0, '★ 离场者 ⇒ 0 字节(与「断线待重连」区分开)');
  });

  report('WS-FND-162');
}

await main();
