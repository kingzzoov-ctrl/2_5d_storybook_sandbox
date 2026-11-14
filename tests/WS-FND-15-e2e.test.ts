/**
 * WS-FND-15 · **客户端联机层端到端**
 *
 * ## 本套件要回答的问题(以及为什么它必须存在)
 *
 * `docs/COMPLETION-CRITERIA.md` §一说「客户端连不上服务器」,依据是
 * 2026-11-13 的实测:「client/** 里 13 个网络关键字逐个 grep 全 0 处」。
 *
 * 2026-11-14 复测:**那句话已经过期**。`client/src/net/session.ts` 已在岗
 * (`client/src/main.ts:22` import 它、`:76-93` 用 `?server=` 装配),
 * WebSocket + hello + welcome + 二进制快照链路都写好了。
 *
 * ⚠️ 但「代码写好了」与「链路真的通」是两件事 —— 这正是本仓反复点名的
 * 「测试全绿 + 生产零消费」家族的温床。而且 `session.ts` 文件头**自己记着**
 * 一次真实事故:第一版用 `bytes[0] === FRAME_TEXT` 分派,而裸协议包首字节
 * 恰好 = `PROTOCOL_VERSION` = 1 = `FRAME_TEXT` ⇒ **端到端全线失败**,
 * 而 WS-12 **从没测到**(它全用人为加 0x02 tag 的假帧)。
 *
 * ⇒ 所以本套件的判据**不读源码文本、不用替身 socket**,而是:
 * ```
 * 起真 startWsServer → 用**真的** createSession(真 WebSocket)去连
 * → 断言握手与快照字段 → 用真 ClientStateStore 读出权威状态
 * ```
 *
 * ★ 与 `tests/WS-FND-13.test.ts` 的分工:
 *   13 用**裸 WebSocket** 测服务端(帧可解码、世界帧单调增长);
 *   15 用**真客户端模块**测客户端那一半(握手字段、store 合入、圆心)。
 *   两者都过,才说明「两端各自的实现」与「它们之间的契约」同时成立。
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';

import { assemble } from '../server/src/index.ts';
import { startWsServer } from '../server/src/net/ws_server.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import { createSession, type WelcomeFrame } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import { telegraphCenterOf } from '../client/src/net/telegraph_center.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/** 异步版 `test`(理由同 WS-FND-13:同步 `test()` 不会 await ⇒ 里面的断言一个都没跑完)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

/** 带超时兜底 —— 挂起的测试在 CI 里表现为「卡住」而不是「失败」。 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`超时 ${ms}ms:${what}`)), ms);
  });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** 客户端侧收到的可观测事实。 */
type Seen = {
  welcome: WelcomeFrame | null;
  /** 状态机迁移序列 —— 「连上了」与「到了 live」是两件事,分开记。 */
  states: string[];
  /** 有效帧(未跳过)的 tick 序列。 */
  ticks: number[];
  drops: string[];
};

/**
 * 起服务端 + 用**真客户端模块**连上去。
 *
 * ⚠️ `store` 由调用方持有并断言 —— `session.ts` 的接口注释写明「必须由调用方传入」,
 *   因为渲染循环读的是**它自己那个** store;若模块内部另建一个,
 *   就会出现「字节写进了 A、渲染读的是 B」而两边都"正常工作"。
 */
async function connectReal(
  roomId: string,
  userId: string | null,
): Promise<{
  srv: { port: number; close(): Promise<void> };
  store: ClientStateStore;
  session: { readonly state: string; readonly droppedFrames: number; readonly serverContentClaim: string | null; close(): void };
  seen: Seen;
  /** welcome 到了就 resolve。 */
  welcomeArrived: Promise<WelcomeFrame>;
  close(): Promise<void>;
}> {
  const a = assemble({ roomId, ownerId: 'o', clock: fixedClock(0), sizeCells: 64 });
  const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20 });

  const seen: Seen = { welcome: null, states: [], ticks: [], drops: [] };
  const store = new ClientStateStore();

  let resolveWelcome: (w: WelcomeFrame) => void = () => undefined;
  const welcomeArrived = new Promise<WelcomeFrame>((res) => { resolveWelcome = res; });

  const url = userId === null
    ? `ws://127.0.0.1:${srv.port}/ws`
    : `ws://127.0.0.1:${srv.port}/ws?userId=${userId}`;

  const session = createSession({
    url,
    store,
    events: {
      onState: (s) => { seen.states.push(s); },
      onWelcome: (w) => { seen.welcome = w; resolveWelcome(w); },
      onFrame: (r) => { if (r.changed) seen.ticks.push(r.tick); },
      onDrop: (reason) => { seen.drops.push(reason); },
    },
  });

  return {
    srv,
    store,
    session,
    seen,
    welcomeArrived,
    close: async () => {
      try { session.close(); } catch { /* 已关 */ }
      await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
    },
  };
}

/* ═══════════════════ 1. 主段(异步)═══════════════════ */

async function main(): Promise<void> {
  /* ── E2E-1 ★★ 主判据:握手往返 + 快照合入 + 圆心 ── */
  await atest('FND15-1 ★★ 端到端:真客户端模块连真服务端 ⇒ 握手 + 快照 + 圆心', async () => {
    /* 变红条件(逐个):
       · 服务端不再发 welcome(`ws_server` 的握手分支改坏)⇒ 超时红;
       · 客户端不再 `setState('live')`(`session.ts` 的校验改坏)⇒ state 断言红;
       · `store.apply` 没接住 `applyPacket` 的返回值(本仓记过的坑 1)⇒
         `state.players` 恒空 ⇒ 这条红;
       · 分派再退回按 `bytes[0] === 0x01` 判文本(本仓记过的真实事故)⇒ welcome 解析失败 ⇒ 红。 */
    const c = await connectReal('r15a', 'e2e');
    try {
      const w = await withTimeout(c.welcomeArrived, 4000, 'welcome 到达');

      eq(w.t, 'welcome', 'welcome 的类型判别字段');
      eq(w.playerId, 'e2e', '★ playerId 来自握手 URL 的 ?userId=(不是随机)');
      eq(w.roomId, 'r15a', 'welcome 带回房间 id');
      /* ⚠️ 这里用**字面量 1** 而不是 import 来的 `PROTOCOL_VERSION`:
         断言的右侧若取自被测模块的导出常量,就是**同义反复**
         (本仓 `--strict-taut` 会当场抓住 —— 实测第一次就是被它抓到的)。 */
      eq(w.protocolVersion, 1, '协议版本必须是 1(字面量锚点,不是 self-reference)');
      ok(w.contentClaim.length > 0, `服务端必须给内容指纹(实得 ${JSON.stringify(w.contentClaim)})`);

      /* 至少等到一帧**已合入**的快照 —— 「连上了」与「状态到了」是两件事。 */
      for (let i = 0; i < 40 && c.seen.ticks.length === 0; i += 1) await sleep(25);
      ok(c.seen.ticks.length > 0, `应至少合入 1 帧快照(实得 ${c.seen.ticks.length} 帧)`);

      eq(c.session.state, 'live', '握手校验通过后状态机应进 live');
      eq(c.store.localPlayerId, 'e2e', '★ store 的本地玩家 id 与 welcome 一致(圆心要用它找"自己")');
      eq(c.store.decodeErrors, 0, '本次链路里不应有解码失败(有则说明线上格式与解码器不符)');
      eq(c.seen.drops.length, 0, '不应有因**载荷形态**丢弃的帧(Blob/非字节)');

      /* ★ 快照字段:玩家必须真的进了权威状态(服务端 join 时 push)。 */
      const me = c.store.state.players.find((p) => p.id === 'e2e');
      ok(me !== undefined,
        `store.state.players 必须含自己(实得 ${c.store.state.players.length} 个:`
        + `${c.store.state.players.map((p) => p.id).join(',') || '空'})`);
      ok(Number.isFinite(c.store.state.meta.tick), 'meta.tick 应是有限数(不是 undefined/NaN)');

      /* ★ 圆心:这是**渲染循环真正消费的那个出口**(`boot.ts` 用它定镜头中心)。
         断言它不仅非 null,而且**等于该玩家的权威坐标** ——
         只断言"非 null"会被一个返回常量的桩骗过。 */
      const center = telegraphCenterOf(c.store.state, c.store.localPlayerId);
      ok(center !== null, '圆心不应为 null(本地玩家在快照里)');
      eq(center!.cx, me!.x, '圆心 cx == 该玩家权威 x');
      eq(center!.cy, me!.y, '圆心 cy == 该玩家权威 y');
    } finally {
      await c.close();
    }
  });

  /* ── E2E-2 有牙对照:playerId 跟随 URL,而不是被写死的常量 ── */
  await atest('FND15-2 有牙对照:换一个 userId ⇒ playerId 跟着换(不是常量)', async () => {
    /* 为什么要这条:E2E-1 断言了 `playerId === 'e2e'`。
       若实现某天退化成「恒返回 'c1'」或「恒返回第一个玩家」,
       换一个 id 再测就会红 —— 单跑 E2E-1 是**看不出来**的。 */
    const c = await connectReal('r15b', 'zoe');
    try {
      const w = await withTimeout(c.welcomeArrived, 4000, 'welcome 到达(对照)');
      eq(w.playerId, 'zoe', '★ 对照:welcome.playerId 必须跟随 URL 的 userId');
      eq(w.roomId, 'r15b', '对照:房间 id 也跟随');
      for (let i = 0; i < 40 && c.seen.ticks.length === 0; i += 1) await sleep(25);
      const c2 = telegraphCenterOf(c.store.state, c.store.localPlayerId);
      ok(c2 !== null, '对照组的圆心也应非 null');
    } finally {
      await c.close();
    }
  });

  /* ── E2E-3 负对照:连不上时必须**明确失败**,而不是假装 live ── */
  await atest('FND15-3 负对照:指向一个没有服务的端口 ⇒ 不得进入 live、不得有 welcome', async () => {
    /* 变红条件:把「连接失败 ⇒ failed」改成「忽略错误、保持 connecting/live」。
       这条守的是 E2E-1 的**非空洞性**:若实现无论连没连上都报 live,
       E2E-1 的 `state === 'live'` 就变成恒真断言(本仓反复点名的形态)。 */
    const store = new ClientStateStore();
    const states: string[] = [];
    let welcome: WelcomeFrame | null = null;
    /* 端口 1 上没有服务 ⇒ ECONNREFUSED。 */
    const s = createSession({
      url: 'ws://127.0.0.1:1/ws?userId=dead',
      store,
      events: {
        onState: (x) => { states.push(x); },
        onWelcome: (w) => { welcome = w; },
        /* `onFrame` 是**必填**(`SessionEvents` 的契约)—— 不填会 TS2741。
           这也是类型系统替我们记住的一条:会话必须把"合入了什么"交给调用方。 */
        onFrame: () => undefined,
      },
    });
    try {
      for (let i = 0; i < 60 && s.state !== 'failed' && s.state !== 'closed'; i += 1) await sleep(25);
      ok(s.state === 'failed' || s.state === 'closed',
        `连不上时必须明确离开 connecting(实得 ${s.state};迁移序列 ${states.join('→')})`);
      eq(welcome, null, '★ 连不上时不得凭空造出 welcome');
      eq(store.localPlayerId, '', '连不上时不得设置本地玩家 id');
    } finally {
      try { s.close(); } catch { /* 已关 */ }
    }
  });

  /* ── E2E-4 客户端侧存储:空帧被区分于坏包 ── */
  await atest('FND15-4 ClientStateStore:0 字节 = 「本 tick 无差量」,**不是**坏包', async () => {
    /* 这条守的是 `state_store.ts` 的坑 2。它属于「客户端联机层」的一部分:
       把空帧当坏包会在空闲房间里把 `decodeErrors` 刷成噪声,而**画面是对的**
       ⇒ 于是真出坏包时没人看得出来。 */
    const store = new ClientStateStore();
    const r = store.apply(new Uint8Array(0));
    eq(r.skipped, 'empty-frame', '空帧应归类为 empty-frame');
    eq(r.changed, false, '空帧不应报告状态变化');
    eq(store.emptyFrames, 1, '空帧计数 +1');
    eq(store.decodeErrors, 0, '★ 空帧**不得**计入解码错误');
  });
}

await main();
/* ⚠️ `report()` 必须在异步区**之后** —— 否则异步断言还没跑完就打完计数了。 */
report('WS-FND-15-e2e');
