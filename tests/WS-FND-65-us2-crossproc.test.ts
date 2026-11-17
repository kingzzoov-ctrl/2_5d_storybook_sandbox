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

/** 轮询到条件成立(带超时)。`read` 只在失败时求值,用来把现场写进错误信息。 */
async function waitUntil(cond: () => boolean, ms: number, what: string, read: () => string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return;
    await sleep(15);
  }
  throw new Error(`超时 ${ms}ms:${what}(当前 ${read()})`);
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
  opened: Promise<void>;
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
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?userId=${userId}`);
  ws.binaryType = 'arraybuffer';
  const out: Raw = {
    srv, sim, rt: a.runtime, ws,
    client: createRoomState(roomId),
    packets: { count: 0, lastTick: -1 },
    welcome: null,
    opened: null as unknown as Promise<void>,
    close: async () => undefined,
  };
  let markOpened: () => void = () => undefined;
  out.opened = new Promise<void>((res) => { markOpened = res; });
  ws.addEventListener('open', () => {
    ws.send(uplinkText({ t: 'hello', protocolVersion: 3, contentClaim: null }));
    markOpened();
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

/** 逐条发 move 直到世界真的动了(反作弊额度按服务端帧水位发放)。 */
async function pushUntilMoved(c: Raw, id: string, y0: number): Promise<{ movedTo: { x: number; y: number }; lastSent: number }> {
  const x0 = c.sim.playerPosition(id)!.x;
  let lastSent = x0;
  let moved = false;
  for (let seq = 1; seq <= 12 && !moved; seq += 1) {
    const target = x0 + 0.05 * seq;
    c.ws.send(uplinkText({ t: 'move', tick: seq, x: target, y: y0, z: 0, seq }));
    lastSent = target;
    await sleep(80);
    moved = c.sim.playerPosition(id)!.x > x0 + 1e-9;
  }
  return { movedTo: c.sim.playerPosition(id)!, lastSent };
}

async function main(): Promise<void> {
  /* ── FND65-1 ★★★ 主判据 ── */
  await atest('FND65-1 ★★★ US2 三段因果:上行 move ⇒ 世界坐标真的变 ⇒ 快照带回同一个坐标', async () => {
    const c = await rawConnect('r65us2', 'us2e2e');
    try {
      await withTimeout(c.opened, 5000, 'socket 打开');
      await waitUntil(() => c.welcome !== null, 5000, 'welcome 到达', () => String(c.welcome));
      eq(c.welcome!.playerId, 'us2e2e', '握手给回的 playerId 必须来自 URL 的 ?userId=');
      await waitUntil(() => clientX(c, 'us2e2e') !== undefined, 5000, '客户端快照里出现该玩家', () => where(c, 'us2e2e', Number.NaN));
      ok(c.srv.connCount() >= 1, '服务端应记录这条连接');

      const start = c.sim.playerPosition('us2e2e');
      ok(start !== null, '前置:世界里必须有这个玩家(否则下面在测空气)');
      const x0 = start!.x;
      const y0 = start!.y;
      eq(clientX(c, 'us2e2e'), x0, '前置:客户端与权威在移动**之前**一致');

      /* 段 2:上行。 */
      const push = await pushUntilMoved(c, 'us2e2e', y0);
      ok(push.movedTo.x > x0 + 1e-9, '★★ 世界坐标必须真的变了(修前 applyMove 只改投影、不写 physics.bodies)');
      near(push.movedTo.x, push.lastSent, 1e-9, '★ 权威坐标应等于最后一条**被应用**的声明值');
      eq(push.movedTo.y, y0, '同一条报文里的 y 也要一致(没有被别的路径改写)');

      /* 段 3:下行 —— 快照必须把这个新位置带回来。 */
      await waitUntil(
        () => {
          const x = clientX(c, 'us2e2e');
          return x !== undefined && Math.abs(x - push.movedTo.x) < 1 / 512;
        },
        5000,
        '快照带回新位置',
        () => where(c, 'us2e2e', push.movedTo.x),
      );
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
      await withTimeout(c.opened, 5000, 'socket 打开');
      await waitUntil(() => clientX(c, 'idle65') !== undefined, 5000, '客户端快照里出现该玩家', () => where(c, 'idle65', Number.NaN));
      const a0 = c.sim.playerPosition('idle65')!;
      const s0 = clientX(c, 'idle65')!;
      for (let i = 0; i < 12; i += 1) await sleep(25);
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
      await withTimeout(c.opened, 5000, 'socket 打开');
      await waitUntil(() => c.welcome !== null, 5000, 'welcome 到达', () => String(c.welcome));
      eq(c.welcome!.playerId, 'zoe65', '★ welcome.playerId 跟随 URL');
      await waitUntil(() => clientX(c, 'zoe65') !== undefined, 5000, '客户端快照里出现该玩家', () => where(c, 'zoe65', Number.NaN));
      const p0 = c.sim.playerPosition('zoe65');
      ok(p0 !== null, '★ 世界里登记的是 URL 里那个 id');
      const push = await pushUntilMoved(c, 'zoe65', p0!.y);
      ok(push.movedTo.x > p0!.x + 1e-9, '★ 动的必须是 `zoe65` 这个玩家');
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
    let resolveWelcome: (w: WelcomeFrame) => void = () => undefined;
    const welcome = new Promise<WelcomeFrame>((res) => { resolveWelcome = res; });
    const session = createSession({
      url: `ws://127.0.0.1:${srv.port}/ws?userId=s65`,
      store,
      events: {
        onWelcome: (w) => { resolved = w; resolveWelcome(w); },
        onFrame: () => undefined,
      },
    });
    try {
      const w = await withTimeout(welcome, 5000, 'welcome 到达(生产客户端)');
      eq(w.playerId, 's65', '★ 生产客户端的 playerId 也来自 URL');
      eq(session.state, 'live', '★ 握手通过后会话进 live');
      await waitUntil(
        () => store.state.players.some((p) => p.id === 's65'),
        5000,
        '生产客户端在快照里看到自己',
        () => `players=${store.state.players.map((p) => p.id).join(',') || '空'} decodeErrors=${store.decodeErrors}`,
      );
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