/**
 * WS-FND-167 —— B3 审计实测的**连接与降级**缺口(6 条),逐条给出可跑的判据。
 *
 * ```text
 * 1 无 connect / welcome 超时   ⇒ 黑洞端口永远停在「连接连接中」
 * 2 重连固定 1.5s、无上限无退避 ⇒ 死服务每 1.5s 无限空转,界面也看不出下次何时拨
 * 3 `/src/main.ts` 404 ⇒ 纯白屏:`window.onerror` 捕不到 module 脚本加载失败
 * 4 坏包 / 空帧 / 旧帧零界面提示(只在 `__stageReady` 计数里)
 * 5 图集失败只进 summary;HUD 无 loading 指示
 * 6 纯 canvas UI ⇒ 读屏器看不到任何面板;分类标签 10px、描边对比度 ≈1.4:1
 * ```
 *
 * ## 判据设计纪律(与 `WS-FND-150` / `-163` 同款)
 * ```text
 * 1 从**生产入口**出发:`createSession()` / `backoffDelayMs()` / `createA11yMirror()` /
 *   `index.html` 里那段**真执行**的兜底脚本 —— 不手写被测动作;
 * 2 每条都配**负对照**:合规输入下同一个量必须**不动**(或检测器必须报红);
 * 3 文本类判据一律**剥注释**后断言(否则注释里的同一句话会把判据撑绿 —— 本仓咬过两次);
 * 4 不测"参数被传进去"这种形态,只测"到了点真的判死 / 真的显示出来"。
 * ```
 *
 * ⚠️ 异步用例必须用 `atest`(`harness.test()` 不 await ⇒ 传 async 进去会**静默假绿**)。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, results, report } from '../shared/testing/harness.ts';
import { PROTOCOL_VERSION } from '../shared/net/delta.ts';
import {
  CONNECT_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, RECONNECT_FACTOR, RECONNECT_MAX_MS,
  backoffDelayMs, createSession,
} from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import {
  A11Y_BG, A11Y_EDGE, A11Y_PANELS, MIN_NON_TEXT_CONTRAST, MIN_TEXT_CONTRAST, MIN_TEXT_PX,
  a11yStyleProblems, contrastRatio, createA11yMirror,
} from '../client/src/ui/a11y.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** 剥注释(口径与 `WS-FND-138` / `-145` / `-151` 一致:`//` 前排除 `:`)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** 异步版 `test`(`harness.test()` 不 await ⇒ 传 async 进去会**静默假绿**)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

/* ═══════════════════ 假 socket(可控:手动触发四种事件)═══════════════════ */

interface FakeSock {
  binaryType: string;
  readyState: number;
  sent: Uint8Array[];
  closed: boolean;
  send(d: Uint8Array): void;
  close(): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  fire(type: string, ev?: unknown): void;
}

/**
 * ⚠️ `close()` **不自动** fire('close'):真 WebSocket 会,但"关掉之后回调里做了什么"
 * 正是本文件要逐条控制的东西(黑洞端口那一条恰恰是"三个事件一个都不来")。
 */
function fakeSocket(): FakeSock {
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  const sent: Uint8Array[] = [];
  const sock: FakeSock = {
    binaryType: 'blob',
    readyState: 1,
    sent,
    closed: false,
    send(d: Uint8Array): void { sent.push(d); },
    close(): void { sock.closed = true; sock.readyState = 3; },
    addEventListener(type: string, fn: (ev: unknown) => void): void {
      const arr = handlers.get(type) ?? [];
      arr.push(fn);
      handlers.set(type, arr);
    },
    fire(type: string, ev?: unknown): void {
      for (const fn of handlers.get(type) ?? []) fn(ev ?? {});
    },
  };
  return sock;
}

function welcomeText(playerId = 'p167'): string {
  return JSON.stringify({
    t: 'welcome', playerId, roomId: 'r167',
    protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-x',
  });
}

/* ═══════════════════ 1/2 超时 ═══════════════════ */

async function timeoutCases(): Promise<void> {
  await atest('FND167-1 ★ 黑洞端口:具名「连接超时」写进状态与字段;负对照:按时 open ⇒ live 且不判超时', async () => {
    const socks: FakeSock[] = [];
    const details: string[] = [];
    const s = createSession({
      url: 'ws://blackhole:1/ws',
      makeSocket: () => { const f = fakeSocket(); socks.push(f); return f as never; },
      store: new ClientStateStore(),
      connectTimeoutMs: 25,
      handshakeTimeoutMs: 80,
      /* 关掉重连:这条判据只看"第一次拨"的归宿,不要被重连的第二条 socket 干扰。 */
      autoReconnectMs: 0,
      events: { onFrame: () => {}, onState: (_st, d) => { if (d !== undefined) details.push(d); } },
    });
    eq(s.state, 'connecting', '前置:拨出去之后是 connecting(修前会**永远**停在这里)');
    eq(s.lastTimeout, null, '前置:还没到点 ⇒ 没有超时记录');
    eq(socks.length, 1, '前置:只拨了一条');

    for (let i = 0; i < 60 && s.lastTimeout === null; i += 1) await sleep(5);

    ok(s.lastTimeout !== null, '★ 到点必须判死(修前:黑洞端口 open/error/close 都不来 ⇒ 无任何出口)');
    eq(s.lastTimeout!.kind, 'connect', '超时分类 = 连接(不是握手 —— 两者修法不同)');
    ok(s.lastTimeout!.text.includes('连接超时'), `文案必须点名「连接超时」,实际:${s.lastTimeout!.text}`);
    ok(s.lastTimeout!.text.includes('blackhole:1'), '文案必须带地址(否则不知道连的是谁)');
    ok(s.lastTimeout!.text.includes('25ms'), '文案必须带超时值(与传进去的参数是同一个数)');
    eq(s.state, 'failed', '落到既有的 failed(不新造状态机)');
    ok(details.includes(s.lastTimeout!.text), '★ 状态 detail 与 lastTimeout.text 是**同一句**(一处文案)');
    ok(!details.some((d) => d.includes('连接中')), '★ 超时**不许**写成"连接中"');
    ok(socks[0]!.closed, '判死之后那条 socket 被关掉(不留半开连接)');
    s.close();

    /* ── 负对照:同样配置 + 按时握手 ⇒ live,而且过了超时点也不许被判死 ── */
    const socks2: FakeSock[] = [];
    const s2 = createSession({
      url: 'ws://ok:1/ws',
      makeSocket: () => { const f = fakeSocket(); socks2.push(f); return f as never; },
      store: new ClientStateStore(),
      connectTimeoutMs: 25, handshakeTimeoutMs: 80, autoReconnectMs: 0,
      events: { onFrame: () => {} },
    });
    socks2[0]!.fire('open');
    socks2[0]!.fire('message', { data: welcomeText() });
    eq(s2.state, 'live', '负对照:按时握手 ⇒ live');
    await sleep(110);
    eq(s2.lastTimeout, null, '★ 负对照:连上之后**不许**再被判超时(连接超时定时器已作废)');
    eq(s2.state, 'live', '★ 负对照:状态没有被超时覆盖');
    s2.close();
  });

  await atest('FND167-2 ★ 握手超时:open 了但不回 welcome ⇒ 具名「握手超时」;负对照:及时 welcome ⇒ 不判', async () => {
    const socks: FakeSock[] = [];
    const s = createSession({
      url: 'ws://half:1/ws',
      makeSocket: () => { const f = fakeSocket(); socks.push(f); return f as never; },
      store: new ClientStateStore(),
      connectTimeoutMs: 200, handshakeTimeoutMs: 25, autoReconnectMs: 0,
      events: { onFrame: () => {} },
    });
    socks[0]!.fire('open');
    eq(s.state, 'connecting', '前置:open 之后仍是 connecting(还没握手)');
    for (let i = 0; i < 60 && s.lastTimeout === null; i += 1) await sleep(5);
    ok(s.lastTimeout !== null, '★ 连上了但不回 welcome ⇒ 必须判死(修前这里没有出口)');
    eq(s.lastTimeout!.kind, 'handshake', '分类 = 握手(TCP 通了,是服务端没回)');
    ok(s.lastTimeout!.text.includes('握手超时'), `文案点名「握手超时」,实际:${s.lastTimeout!.text}`);
    ok(s.lastTimeout!.text.includes('25ms'), '带上握手超时值');
    eq(s.state, 'failed', '落到 failed');
    s.close();

    /* ── 负对照:welcome 及时到 ⇒ live,且握手定时器被清掉(过了点也不许翻案) ── */
    const socks2: FakeSock[] = [];
    const s2 = createSession({
      url: 'ws://ok:2/ws',
      makeSocket: () => { const f = fakeSocket(); socks2.push(f); return f as never; },
      store: new ClientStateStore(),
      connectTimeoutMs: 200, handshakeTimeoutMs: 25, autoReconnectMs: 0,
      events: { onFrame: () => {} },
    });
    socks2[0]!.fire('open');
    socks2[0]!.fire('message', { data: welcomeText('p2') });
    eq(s2.state, 'live', '前置:welcome 到 ⇒ live');
    await sleep(60);
    eq(s2.lastTimeout, null, '★ 负对照:握手完成后**不许**再判握手超时');
    eq(s2.state, 'live', '★ 负对照:状态仍是 live');
    s2.close();
  });

  test('FND167-3 超时可关(`<= 0` ⇒ 与接线前逐字相同):默认值来自常量,0 不等于默认', () => {
    ok(CONNECT_TIMEOUT_MS > 0 && HANDSHAKE_TIMEOUT_MS > 0, '默认超时必须是正数(省略 ⇒ 启用)');
    const src = stripComments(read('client/src/net/session.ts'));
    ok(src.includes('opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS'), '连接超时的默认值来自常量');
    ok(src.includes('opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS'), '握手超时的默认值来自常量');
    ok(src.includes('if (connectMs > 0)') && src.includes('if (handshakeMs > 0)'),
      '`<= 0` = 显式关闭(单测/冒烟的唯一入口)');
    /* 负对照:两个默认值必须**能分辨**(相等会让"到底是哪一步超时"分不开) */
    const s2 = createSession({
      url: 'ws://x:3/ws',
      makeSocket: () => fakeSocket() as never,
      store: new ClientStateStore(),
      connectTimeoutMs: 0, handshakeTimeoutMs: 0, autoReconnectMs: 0,
      events: { onFrame: () => {} },
    });
    eq(s2.lastTimeout, null, '负对照:两个超时都关掉 ⇒ 不会凭空判死');
    s2.close();
  });
}

/* ═══════════════════ 2 退避 ═══════════════════ */

async function backoffCases(): Promise<void> {
  test('FND167-4 ★ 退避纯函数:单调不减 + 恰好封顶;负对照:倍率/基数/上限坏值都不许"越等越短"', () => {
    const base = 1500;
    let prev = 0;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const d = backoffDelayMs(attempt, base);
      ok(d >= prev, `第 ${attempt} 次不得比上一次短(${d} vs ${prev})`);
      prev = d;
    }
    eq(backoffDelayMs(1, base), base, '第 1 次 = 基数(与接线前的固定间隔逐字相同)');
    eq(backoffDelayMs(2, base), base * 2, '第 2 次 = 基数 × 2');
    eq(backoffDelayMs(3, base), base * 4, '第 3 次 = 基数 × 4');
    /* ★ 第十一轮:期望侧一律写**字面量 30000**(上限),不拿被测模块的导出常量当期望值 ——
       `eq(backoffDelayMs(...), RECONNECT_MAX_MS)` 是恒真形态(session.ts 的退避读同一个常量,
       改常量两边一起动),门禁的「同义反复候选」正是抓这个(本轮实测:`WS-FND-167-resilience::RECONNECT_MAX_MS`)。
       上面那一行是**锚点**:常量本身对着数值钉一次(锚点走 actual 槽位 ⇒ 不算候选)。 */
    eq(RECONNECT_MAX_MS, 30000, '锚点:退避上限常量 = 30000(30 秒;下面的行为判据写死这个数)');
    eq(backoffDelayMs(50, base), 30000, '★ 再多次也**恰好**封顶(无上限 = 服务回来还要干等)');
    eq(backoffDelayMs(6, base), 30000, '6 次就够到上限(1500×2^5 = 48000 > 30000)');
    eq(backoffDelayMs(5, base), 24000, '5 次还在上限之下(24000 < 30000)');
    eq(backoffDelayMs(0, base), 0, 'attempt 0 ⇒ 0(没有第 0 次重连)');
    eq(backoffDelayMs(Number.NaN, base), 0, 'NaN ⇒ 0(不猜)');
    eq(backoffDelayMs(1, 0), 0, '基数为 0 ⇒ 0(等于不重连,与接线前一致)');
    eq(backoffDelayMs(3, base, 1000), 1000, '上限可注入(判据里用它把等待压到毫秒级)');
    /* 负对照:倍率 < 1 时必须回落(否则下一次比上一次短 ⇒ 空转更凶) */
    eq(backoffDelayMs(2, base, RECONNECT_MAX_MS, 0.5), base * 2,
      '★ 倍率 0.5 被忽略,回落到 2(间隔不许越等越短)');
    eq(backoffDelayMs(3, base, RECONNECT_MAX_MS, RECONNECT_FACTOR), base * 4, '显式传 2 与默认一致');
    eq(backoffDelayMs(3, base, Number.NaN), base * 4, '上限非法 ⇒ 用 RECONNECT_MAX_MS(不返回 NaN)');
  });

  await atest('FND167-5 ★ 生产路径:每次断开按退避排程并封顶;负对照:主动 close() 一次都不排', async () => {
    const socks: FakeSock[] = [];
    const scheduled: { attempt: number; delayMs: number }[] = [];
    const s = createSession({
      url: 'ws://dead:1/ws',
      makeSocket: () => { const f = fakeSocket(); socks.push(f); return f as never; },
      store: new ClientStateStore(),
      /* 30ms 基数 / 2 倍 / 100ms 上限 ⇒ 30 → 60 → 100(第三次就封顶)。 */
      autoReconnectMs: 30, reconnectMaxMs: 100, reconnectFactor: 2,
      connectTimeoutMs: 0, handshakeTimeoutMs: 0,
      events: { onFrame: () => {}, onRetryScheduled: (info) => scheduled.push(info) },
    });
    eq(socks.length, 1, '前置:首连一条');
    eq(s.retryCount, 0, '前置:还没排过');

    for (let i = 0; i < 3; i += 1) {
      eq(s.retryDelayMs, null, `第 ${i + 1} 次断开之前没有待重连`);
      socks[socks.length - 1]!.fire('close');
      eq(s.retryCount, i + 1, `★ 断开 ${i + 1}:retryCount = ${i + 1}`);
      ok(s.retryDelayMs !== null, '★ 断开后排上了一次重连(界面要显示"多久后")');
      ok(s.nextRetryAtMs !== null, '绝对时刻也给了');
      ok(Math.abs((s.nextRetryAtMs! - Date.now()) - s.retryDelayMs!) < 20,
        'nextRetryAtMs ≈ now + retryDelayMs');
      /* 等它真的拨出下一条(把排程变成可观察的事实) */
      const before = socks.length;
      for (let k = 0; k < 100 && socks.length === before; k += 1) await sleep(5);
      eq(socks.length, before + 1, '★ 到点真的拨了**一条**(不是只记了个数)');
    }
    eq(scheduled.map((x) => x.delayMs), [30, 60, 100], '★ 间隔 30 → 60 → 100(封顶),不再固定 30');
    eq(scheduled.map((x) => x.attempt), [1, 2, 3], 'attempt 从 1 起,与 retryCount 同一个数');

    /* ── 负对照:主动 close() ⇒ 一次都不排(它是调用方的决定) ── */
    const socks2: FakeSock[] = [];
    const scheduled2: unknown[] = [];
    const s2 = createSession({
      url: 'ws://x:2/ws',
      makeSocket: () => { const f = fakeSocket(); socks2.push(f); return f as never; },
      store: new ClientStateStore(),
      autoReconnectMs: 10, connectTimeoutMs: 0, handshakeTimeoutMs: 0,
      events: { onFrame: () => {}, onRetryScheduled: (i) => scheduled2.push(i) },
    });
    s2.close();
    await sleep(60);
    eq(socks2.length, 1, '★ 负对照:close() 之后不再拨第二条');
    eq(s2.retryCount, 0, '★ 负对照:retryCount 仍是 0');
    eq(s2.retryDelayMs, null, '★ 负对照:没有待重连间隔');
    eq(scheduled2, [], '★ 负对照:onRetryScheduled 一次都没被调用');
    s.close();
  });

  await atest('FND167-6 ★ 成功 open 后退避归零(服务恢复立刻回到基数);负对照:连续失败不许归零', async () => {
    const socks: FakeSock[] = [];
    const delays: number[] = [];
    const s = createSession({
      url: 'ws://flaky:1/ws',
      makeSocket: () => { const f = fakeSocket(); socks.push(f); return f as never; },
      store: new ClientStateStore(),
      autoReconnectMs: 10, reconnectMaxMs: 1000, reconnectFactor: 2,
      connectTimeoutMs: 0, handshakeTimeoutMs: 0,
      events: { onFrame: () => {}, onRetryScheduled: (i) => delays.push(i.delayMs) },
    });
    const dialNext = async (): Promise<void> => {
      const before = socks.length;
      for (let k = 0; k < 100 && socks.length === before; k += 1) await sleep(5);
      eq(socks.length, before + 1, '前提:又拨了一条');
    };
    socks[0]!.fire('close');
    await dialNext();                       /* 第 1 次失败 ⇒ 10 */
    socks[1]!.fire('close');
    await dialNext();                       /* 第 2 次失败 ⇒ 20 */
    eq(delays, [10, 20], '前提:连续失败是递增的');
    eq(s.retryCount, 2, '前提:排过两次');

    socks[2]!.fire('open');
    eq(s.retryCount, 0, '★ 真的连上之后 retryCount 归零');
    eq(s.retryDelayMs, null, '★ 归零之后没有"待重连"');
    socks[2]!.fire('close');
    eq(s.retryDelayMs, 10, '★ 再断一次 ⇒ 回到**基数**(不是接着 40 等)');
    eq(s.retryCount, 1, '★ 重新从第 1 次算起');
    s.close();
  });
}

/* ═══════════════════ 3 启动兜底(index.html)═══════════════════ */

interface StubEl {
  tagName?: string;
  src?: string;
  style: { display: string; cssText?: string };
  textContent: string;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
}

interface FallbackRun {
  win: Record<string, unknown> & { __fatal?: (m: string) => void };
  fatal: StubEl;
  timers: { fn: () => void; ms: number }[];
  fireError(ev: unknown): void;
  fireRejection(ev: unknown): void;
}

/** 把 `index.html` 里那段**非 module** 兜底脚本抽出来(判据要求它真的执行)。 */
function fallbackBody(html: string): string {
  const m = html.match(/<script id="boot_fallback">([\s\S]*?)<\/script>/);
  ok(m !== null, '★ index.html 里必须有 `<script id="boot_fallback">`(纯字符串判据之外还要能跑)');
  return m![1] ?? '';
}

function runFallback(html: string): FallbackRun {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const fatal: StubEl = { style: { display: 'none' }, textContent: '', attrs: {}, setAttribute() {} };
  const timers: { fn: () => void; ms: number }[] = [];
  const win = {
    addEventListener: (type: string, fn: (ev: unknown) => void): void => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
  } as Record<string, unknown> & { __fatal?: (m: string) => void };
  const doc = { getElementById: (id: string): StubEl | null => (id === 'fatal' ? fatal : null) };
  const setT = (fn: () => void, ms: number): number => { timers.push({ fn, ms }); return timers.length; };
  /* 真执行(不是正则匹配):`window` / `document` / `setTimeout` 三个桩就够它跑完。 */
  new Function('window', 'document', 'setTimeout', fallbackBody(html))(win, doc, setT);
  return {
    win, fatal, timers,
    fireError: (ev) => { for (const fn of listeners.get('error') ?? []) fn(ev); },
    fireRejection: (ev) => { for (const fn of listeners.get('unhandledrejection') ?? []) fn(ev); },
  };
}

async function bootFallbackCases(): Promise<void> {
  const html = read('client/index.html');

  test('FND167-7 ★ 兜底脚本是**非 module**、排在 module 脚本之前(module 404 时只剩它能跑)', () => {
    const fallbackIdx = html.indexOf('<script id="boot_fallback">');
    const moduleIdx = html.indexOf('<script type="module" src="./src/main.ts">');
    ok(fallbackIdx > 0, '前提:有兜底脚本');
    ok(moduleIdx > 0, '前提:有 module 入口');
    ok(fallbackIdx < moduleIdx, '★ 兜底必须先于 module 脚本(否则它自己也等不到执行机会)');
    eq(/<script[^>]*id="boot_fallback"[^>]*type="module"/.test(html), false,
      '★ 兜底脚本**不能**是 module(module 图挂了它就不跑)');
    ok(fallbackBody(html).includes('window.__fatal'), '兜底挂出 `window.__fatal`(与 main.ts 同一出口)');

    /* ── 负对照:把兜底删掉 ⇒ "有兜底脚本"这条判据必须变红 ── */
    const stripped = html.replace(/<script id="boot_fallback">[\s\S]*?<\/script>/, '');
    ok(stripped !== html, '前提:确实删掉了');
    ok(stripped.indexOf('<script id="boot_fallback">') < 0,
      '★ 删掉之后"有兜底脚本"这条判据必须变红(不是恒真)');
  });

  test('FND167-8 ★ 真执行:module 脚本 404(资源级 error)⇒ #fatal 写明 URL,而不是白屏', () => {
    const r = runFallback(html);
    eq(r.fatal.style.display, 'none', '前置:一开始不显示');
    eq(r.fatal.textContent, '', '前置:#fatal 是空的');
    r.fireError({ target: { tagName: 'SCRIPT', src: 'http://localhost:5173/src/main.ts' } });
    eq(r.fatal.style.display, 'block', '★ 资源级加载失败必须把 #fatal 打开(修前:白屏)');
    ok(r.fatal.textContent.includes('src/main.ts'), `文案点名失败的 URL,实际:${r.fatal.textContent}`);
    ok(r.fatal.textContent.includes('404'), '文案给出最常见原因(404)');
    ok(r.win.__fatalShown === true, '同一次失败被记为"已经显示过"');

    /* 去重:第二次错误不许覆盖第一条(否则真正的成因会被后一条噪声顶掉) */
    const first = r.fatal.textContent;
    r.fireError({ target: { tagName: 'SCRIPT', src: 'http://localhost:5173/src/other.ts' } });
    eq(r.fatal.textContent, first, '★ 只显示第一条(去重)');

    /* ── 负对照:运行时异常走另一条分支(必须显示 stack,而不是"加载失败") ── */
    const r2 = runFallback(html);
    r2.fireError({ target: r2.win, error: { stack: 'Error: boom\n  at x' }, message: 'boom' });
    ok(r2.fatal.textContent.includes('boom'), `运行时异常显示 stack,实际:${r2.fatal.textContent}`);
    ok(!r2.fatal.textContent.includes('启动脚本加载失败'),
      '★ 负对照:运行时异常**不许**被报成"加载失败"(两种成因不同)');
    /* 未处理的 rejection 走第三条路 */
    const r3 = runFallback(html);
    r3.fireRejection({ reason: { stack: 'REJ-STACK' } });
    ok(r3.fatal.textContent.includes('REJ-STACK'), '未处理的 rejection 也显示');
  });

  test('FND167-9 ★ 看门狗:到点还没见到 __stageReady ⇒ 报"启动超时";负对照:已就绪 ⇒ 一个字都不显示', () => {
    const r = runFallback(html);
    eq(r.timers.length, 1, '前提:挂了一个定时器');
    ok(r.timers[0]!.ms >= 4000 && r.timers[0]!.ms <= 30000, `看门狗时长合理(实际 ${r.timers[0]!.ms}ms)`);
    r.timers[0]!.fn();
    eq(r.fatal.style.display, 'block', '★ 模块没跑起来 ⇒ 必须显示(修前:白屏到永远)');
    ok(r.fatal.textContent.includes('启动超时') && r.fatal.textContent.includes('main.ts'),
      `文案点名"启动超时"与 main.ts,实际:${r.fatal.textContent}`);

    /* ── 负对照:模块其实跑起来了(__stageReady 在)⇒ 看门狗必须闭嘴 ── */
    const r2 = runFallback(html);
    r2.win.__stageReady = (): Record<string, unknown> => ({});
    r2.timers[0]!.fn();
    eq(r2.fatal.style.display, 'none', '★ 负对照:已就绪时看门狗不许误报白屏(fps-probe 会因此判红)');
    eq(r2.fatal.textContent, '', '★ 负对照:#fatal 必须保持空(fps-probe 的判据)');
  });
}

/* ═══════════════════ 4/5/6 main.ts 接线(剥注释)═══════════════════ */

function sessionWiringProblems(code: string): string[] {
  const p: string[] = [];
  const i = code.indexOf('session = createSession({');
  if (i < 0) { p.push('main.ts 里没有 createSession({'); return p; }
  const end = code.indexOf('events: {', i);
  const block = end > i ? code.slice(i, end) : '';
  for (const [key, why] of [
    ['connectTimeoutMs: CONNECT_TIMEOUT_MS', '连接超时没接线(黑洞端口会永远"连接中")'],
    ['handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS', '握手超时没接线'],
    ['reconnectMaxMs: RECONNECT_MAX_MS', '退避上限没接线(死服务会无限空转)'],
    ['reconnectFactor: RECONNECT_FACTOR', '退避倍率没接线'],
  ] as const) {
    if (!block.includes(key)) p.push(`createSession 没传 ${key} —— ${why}`);
  }
  if (!code.includes('onRetryScheduled')) p.push('没接 onRetryScheduled —— 界面无从显示"下次重试时间"');
  return p;
}

/** `paintStatus` 的函数体(**唯一**的 HUD 文本出口)。 */
function paintBodyOf(code: string): string {
  const start = code.indexOf('const paintStatus');
  const end = start < 0 ? -1 : code.indexOf('\n  };', start);
  return start < 0 || end < 0 ? '' : code.slice(start, end);
}

/**
 * `const lines = [...]` 那一段(★ 必须切出来再判:`diagLine` 这个名字在函数体里
 * 出现三次 —— 定义、进数组、进镜像面板 —— 只判"函数体里出现过"的负对照**不会变红**,
 * 那种判据等于没判)。
 */
function hudArrayOf(body: string): string {
  const i = body.indexOf('const lines = [');
  const j = i < 0 ? -1 : body.indexOf('];', i);
  return i < 0 || j < 0 ? '' : body.slice(i, j);
}

function diagUiProblems(code: string): string[] {
  const p: string[] = [];
  const body = paintBodyOf(code);
  if (body === '') p.push('main.ts 里找不到 paintStatus(判据会恒真)');
  if (!code.includes('const diagLine')) p.push('没有诊断行(diagLine)');
  for (const f of ['decodeErrors', 'emptyFrames', 'staleFrames', 'droppedFrames', 'rejectedFrames']) {
    if (!code.includes(f)) p.push(`诊断行缺 ${f}`);
  }
  if (!code.includes('handle.store.decodeErrors')) p.push('坏包计数不是从 store 读的');
  if (!hudArrayOf(body).includes('diagLine')) {
    p.push('★ 诊断行没进状态条的 lines 数组(只放进 __stageReady 等于零界面提示)');
  }
  return p;
}

function loadUiProblems(code: string): string[] {
  const p: string[] = [];
  if (!code.includes('atlasErr')) p.push('图集失败原因没有被消费(修前只进 summary)');
  if (!code.includes('图集 ✗')) p.push('图集失败文案没上界面');
  if (!code.includes("bootStatusEl.style.display = 'none'")) p.push('加载指示永远不会消失(等于没有指示)');
  if (!code.includes('bootStatusEl')) p.push('没有加载指示元素');
  if (!code.includes('atlasNote,')) p.push('atlasNote 没进 __stageReady');
  return p;
}

function a11yHudProblems(code: string): string[] {
  const p: string[] = [];
  const body = paintBodyOf(code);
  const arr = hudArrayOf(body);
  if (!arr.includes('sessionLine')) p.push('连接那一行没进 HUD');
  if (!arr.includes('phaseLine')) p.push('阶段/超时那一行没进 HUD');
  if (!arr.includes('retryLine')) p.push('重试排程那一行没进 HUD');
  if (!body.includes('statusEl.textContent = lines.join')) p.push('#status 没写那个数组(不是一份文本两处消费)');
  /* ★ 镜像面板(读屏器 / Tab 可达)必须真的在每帧被写、并且真的挂进 DOM */
  if (!body.includes('a11y.update(')) p.push('镜像面板没在每帧写(HUD 与读屏器会漂)');
  if (!code.includes('a11y.mount(')) p.push('镜像面板没挂进 DOM');
  return p;
}

function watchdogOrderProblems(code: string): string[] {
  const p: string[] = [];
  const ready = code.indexOf('window.__stageReady = ');
  const clear = code.indexOf('clearTimeout(window.__bootWatchdog)');
  if (ready < 0) p.push('没有 `window.__stageReady = `');
  if (clear < 0) p.push('main() 跑完没撤启动看门狗(8s 后会误报白屏)');
  if (ready >= 0 && clear >= 0 && clear < ready) p.push('看门狗在 __stageReady 之前就撤了(顺序不对)');
  return p;
}

async function wiringCases(): Promise<void> {
  const mainCode = stripComments(read('client/src/main.ts'));

  test('FND167-10 ★ 生产接线:超时 / 退避三件套 / 重连排程都进了 createSession;删掉一条 ⇒ 检测器报红', () => {
    eq(sessionWiringProblems(mainCode), [], 'main.ts 必须把四件事都接线');
    /* ── 负对照(逐条注入):删任何一条 ⇒ 同一个检测器必须报红 ── */
    for (const key of ['connectTimeoutMs: CONNECT_TIMEOUT_MS', 'handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS',
      'reconnectMaxMs: RECONNECT_MAX_MS', 'reconnectFactor: RECONNECT_FACTOR']) {
      const broken = mainCode.replace(key, '');
      ok(broken !== mainCode, `前提:源码里确实有 ${key}`);
      ok(sessionWiringProblems(broken).some((x) => x.includes(key.split(':')[0]!)),
        `★ 删掉 ${key} 之后检测器必须点名它`);
    }
    const noRetry = mainCode.replace(/onRetryScheduled/g, '');
    ok(sessionWiringProblems(noRetry).length > 0, '★ 删掉 onRetryScheduled ⇒ 报红');
  });

  test('FND167-11 ★ 坏包/空帧/旧帧/丢帧/拒收**上界面**(诊断行 + 镜像面板);删掉 ⇒ 报红', () => {
    eq(diagUiProblems(mainCode), [], '五个计数必须进 HUD 与镜像面板');
    /* ★ 负对照必须删**数组里那一行**:`diagLine` 这个名字在 `paintStatus` 里出现三次 */
    const broken = mainCode.replace('      diagLine,\n', '');
    ok(broken !== mainCode, '前提:lines 数组里确实有 diagLine');
    ok(diagUiProblems(broken).some((x) => x.includes('诊断行没进状态条')), '★ 删掉数组里那行 ⇒ 报红');
    /* 与上一条同理:这个片段在 main.ts 里出现两处(诊断行 + `__stageReady`)⇒ 全删。 */
    const noStore = mainCode.split('handle.store.decodeErrors').join('0');
    ok(diagUiProblems(noStore).length > 0, '★ 不当从 store 读坏包数 ⇒ 报红');
  });

  test('FND167-12 ★ 图集失败原因 + loading 指示可见;删掉任意一半 ⇒ 报红', () => {
    eq(loadUiProblems(mainCode), [], '图集失败原因与加载指示都要在 main.ts 里');
    for (const inject of ['atlasErr', '图集 ✗', "bootStatusEl.style.display = 'none'", 'atlasNote,']) {
      /* ⚠️ 必须**全部**替换:`atlasErr` 在 main.ts 里出现 4 次,`replace` 只删第一处
         ⇒ 负对照会"看起来没红",而那是判据自己没删干净(不是接线还在)。 */
      const broken = mainCode.split(inject).join('');
      ok(broken !== mainCode, `前提:源码里有 ${inject}`);
      ok(loadUiProblems(broken).length > 0, `★ 删掉全部 ${inject} ⇒ 报红`);
    }
  });

  test('FND167-13 ★ HUD 一份文本两处消费(#status 与镜像面板):负对照:拆成两份 ⇒ 报红', () => {
    eq(a11yHudProblems(mainCode), [], 'paintStatus 必须产出一个数组给两边用');
    const broken = mainCode.replace(/a11y\.update\(\{[\s\S]*?\n    \}\);/, '');
    ok(broken !== mainCode, '前提:确实有 a11y.update');
    ok(a11yHudProblems(broken).some((x) => x.includes('镜像面板')),
      '★ 删掉镜像面板那一段 ⇒ 报红(说明这条判据不是恒真)');
  });

  test('FND167-14 ★ 看门狗在 main() 成功后被撤(否则 8s 误报白屏);漏撤/顺序反了 ⇒ 报红', () => {
    eq(watchdogOrderProblems(mainCode), [], '撤看门狗必须在 __stageReady 赋值之后');
    const noReady = mainCode.replace('window.__stageReady = ', 'window.__stageReadyX = ');
    ok(watchdogOrderProblems(noReady).length > 0, '★ 没有 __stageReady 时判定必须变红');
    const noClear = mainCode.replace('clearTimeout(window.__bootWatchdog)', '');
    ok(watchdogOrderProblems(noClear).some((x) => x.includes('撤启动看门狗')), '★ 不撤 ⇒ 报红');
  });
}

/* ═══════════════════ 6 a11y ═══════════════════ */

/** 旧描边的等效色:`rgba(120,150,210,.22)` 压 `#121a2b`(逐通道混合)。 */
function blendOver(fg: [number, number, number], alpha: number, bg: [number, number, number]): string {
  const ch = fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i]!));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function cssRuleOf(css: string, sel: string): string {
  const esc = sel.replace(/[.#]/g, (c) => `\\${c}`);
  const m = css.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? '';
}

function htmlA11yProblems(html: string): string[] {
  const p: string[] = [];
  const tags: { id: string; must: string[] }[] = [
    { id: 'status', must: ['role="status"', 'aria-live=', 'aria-label=', 'tabindex="0"'] },
    { id: 'bootstatus', must: ['role="status"', 'aria-label='] },
    { id: 'fatal', must: ['role="alert"', 'aria-live=', 'tabindex="0"'] },
    { id: 'hint', must: ['aria-label='] },
  ];
  for (const t of tags) {
    const m = html.match(new RegExp(`<[a-z]+ id="${t.id}"([^>]*)>`));
    if (m === null) { p.push(`没有 #${t.id}`); continue; }
    for (const attr of t.must) {
      if (!m[1]!.includes(attr)) p.push(`#${t.id} 缺 ${attr}(读屏器/键盘可达性)`);
    }
  }
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  for (const sel of ['#hint', '#status', '#bootstatus']) {
    const body = cssRuleOf(style, sel);
    if (body === '') { p.push(`没有 ${sel} 的样式规则`); continue; }
    const fs = Number(/(?:font-size|font):\s*(\d+)px/.exec(body)?.[1] ?? Number.NaN);
    if (!(fs >= MIN_TEXT_PX)) p.push(`${sel} 字号 ${String(fs)}px 低于可读基线 ${MIN_TEXT_PX}px`);
    const hex = /border:\s*[^;]*?(#[0-9a-fA-F]{6})/.exec(body);
    if (hex === null) {
      p.push(`${sel} 的描边不是实色(拿不到 #rrggbb ⇒ 对比度无法保证)`);
      continue;
    }
    const ratio = contrastRatio(hex[1]!, A11Y_BG);
    if (!(ratio >= MIN_NON_TEXT_CONTRAST)) {
      p.push(`${sel} 描边 ${hex[1]} 对比度 ${ratio.toFixed(2)}:1 低于 ${MIN_NON_TEXT_CONTRAST}:1`);
    }
  }
  return p;
}

/** 桩 DOM(`createElement` 只留判据要读的四个面:attrs / style / textContent / children)。 */
function stubDom(): {
  host: { ownerDocument: unknown; root: unknown; appendChild(el: unknown): void };
} {
  const doc = {
    createElement(tag: string): StubEl & { children: unknown[] } {
      const el = {
        tagName: tag.toUpperCase(),
        style: { display: '', cssText: '' },
        textContent: '',
        attrs: {} as Record<string, string>,
        children: [] as unknown[],
        setAttribute(k: string, v: string): void { el.attrs[k] = v; },
        appendChild(c: unknown): void { el.children.push(c); },
      };
      return el;
    },
  };
  const host = {
    ownerDocument: doc,
    root: null as unknown,
    appendChild(el: unknown): void { host.root = el; },
  };
  return { host };
}

async function a11yCases(): Promise<void> {
  test('FND167-15 ★ 字号/对比度常量达标;负对照:10px 与旧描边色必须被判红', () => {
    ok(MIN_TEXT_PX >= 13, `字号基线 ≥13px(实际 ${MIN_TEXT_PX})`);
    eq(a11yStyleProblems(), [], '达标色板 + 基线字号 ⇒ 零违规');
    ok(contrastRatio(A11Y_EDGE, A11Y_BG) >= MIN_NON_TEXT_CONTRAST, '描边过 WCAG 1.4.11(3:1)');
    ok(contrastRatio('#e8eefc', A11Y_BG) >= MIN_TEXT_CONTRAST, '正文过 WCAG 1.4.3 AA(4.5:1)');

    /* ── 负对照 1:字号降到 10px(修前分类标签的档位)⇒ 必须报红 ── */
    const small = a11yStyleProblems({ textPx: 10 });
    ok(small.some((x) => x.includes('字号')), `★ 10px 必须判红,实际:${small.join(' / ')}`);
    /* ── 负对照 2:旧描边 `rgba(120,150,210,.22)` 的等效色 ⇒ 必须报红 ── */
    const oldEdge = blendOver([120, 150, 210], 0.22, [18, 26, 43]);
    ok(contrastRatio(oldEdge, A11Y_BG) < MIN_NON_TEXT_CONTRAST,
      `前提:旧描边等效色 ${oldEdge} 确实低于 3:1(实测 ${contrastRatio(oldEdge, A11Y_BG).toFixed(2)}:1)`);
    ok(a11yStyleProblems({ edge: oldEdge }).some((x) => x.includes('描边')),
      '★ 修前那个描边色必须被同一条判据判红(说明判据有牙齿)');
    /* ── 负对照 3:非法颜色不许被当成"合格" ── */
    eq(contrastRatio('#zzzzzz', A11Y_BG), 0, '非法色 ⇒ 0(必然判红),不是 1');
    ok(a11yStyleProblems({ fg: 'rgba(1,1,1,.2)' }).length > 0, '★ 用 rgba 当正文色 ⇒ 报红');
  });

  test('FND167-16 ★ 镜像面板(桩 DOM 真跑):role / aria-label / tabindex / 字号都在;负对照:未挂载时不写 DOM', () => {
    const { host } = stubDom();
    const mirror = createA11yMirror();
    eq(mirror.mounted, false, '前置:构造时不挂(DOM 访问全在 mount 里)');
    mirror.update({ session: 'S' });          /* 挂之前 update 不许抛 */
    eq(mirror.textOf(), [], '★ 负对照:未挂载时没有任何节点(不静默建 DOM)');

    mirror.mount(host);
    eq(mirror.mounted, true, '挂载后 mounted = true');
    const root = host.root as StubEl & { children: (StubEl & { children: unknown[] })[] };
    eq(root.attrs['role'], 'region', '★ 根节点有 role=region(读屏器据此当一块面板)');
    ok((root.attrs['aria-label'] ?? '') !== '', '★ 根节点有 aria-label');
    eq(root.attrs['tabindex'], '0', '★ tabindex=0 ⇒ 键盘 Tab 能到');
    ok((root.style.cssText ?? '').includes(`${MIN_TEXT_PX}px`), `样式里字号是 ${MIN_TEXT_PX}px(不是 10px)`);
    ok((root.style.cssText ?? '').includes(A11Y_EDGE), '样式里的描边用达标色');
    eq(root.children.length, A11Y_PANELS.length, '每个登记的面板一个节点(清单只有 A11Y_PANELS 一份)');
    for (let i = 0; i < A11Y_PANELS.length; i += 1) {
      const spec = A11Y_PANELS[i]!;
      const node = root.children[i]!;
      eq(node.attrs['role'], spec.role, `${spec.id}: role 来自登记表`);
      ok((node.attrs['aria-label'] ?? '').includes(spec.label.slice(0, 4)),
        `${spec.id}: aria-label 来自登记表(实际 ${node.attrs['aria-label']})`);
      ok(node.attrs['aria-live'] !== undefined, `${spec.id}: 有 aria-live(状态变化会被念出来)`);
    }
    mirror.update({ session: '连接 connecting', diagnostics: '诊断 坏包 3' });
    const text = mirror.textOf().join('\n');
    ok(text.includes('session: 连接 connecting'), `★ update 之后读得到同一句话,实际:${text}`);
    ok(text.includes('diagnostics: 诊断 坏包 3'), '诊断那块同源');
    /* 负对照:未登记的 id 不许凭空长出节点 */
    mirror.update({ nope: 'X' });
    eq(root.children.length, A11Y_PANELS.length, '★ 负对照:未登记的 id 不新建节点');
    ok(!mirror.textOf().join('\n').includes('nope:'), '★ 负对照:未登记的 id 不写进任何节点');
    mirror.dispose();
    eq(mirror.mounted, false, 'dispose 之后 mounted = false');
  });

  test('FND167-17 ★ index.html 的 DOM 层 a11y + 字号/描边;换回旧描边/12px/去掉 tabindex ⇒ 判红', () => {
    const html = read('client/index.html');
    eq(htmlA11yProblems(html), [], 'index.html 的 DOM HUD 必须带 role/aria-label/tabindex 与达标样式');
    /* ── 负对照 1:旧描边(rgba 低透明度)⇒ 报红 ── */
    const oldBorder = html.replace('border: 1px solid #7f9dc9;', 'border: 1px solid rgba(120,150,210,.22);');
    ok(oldBorder !== html, '前提:#hint 的描边确实是实色');
    ok(htmlA11yProblems(oldBorder).some((x) => x.includes('描边')), '★ 换成旧 rgba 描边 ⇒ 报红');
    /* ── 负对照 2:字号退回 12px ⇒ 报红 ── */
    const small = html.replace('font-size: 13px; color: #b9cbe6;', 'font-size: 12px; color: #b9cbe6;');
    ok(small !== html, '前提:#hint 的字号确实是 13px');
    ok(htmlA11yProblems(small).some((x) => x.includes('字号')), '★ 字号退回 12px ⇒ 报红');
    /* ── 负对照 3:去掉 tabindex ⇒ 键盘到不了 ⇒ 报红 ── */
    const noTab = html.replace('aria-label="连接状态与诊断" tabindex="0"', 'aria-label="连接状态与诊断"');
    ok(noTab !== html, '前提:#status 确实有 tabindex');
    ok(htmlA11yProblems(noTab).some((x) => x.includes('tabindex')), '★ 去掉 tabindex ⇒ 报红');
  });
}

/* ═══════════════════ 入口 ═══════════════════ */

async function main(): Promise<void> {
  await timeoutCases();
  await backoffCases();
  await bootFallbackCases();
  await wiringCases();
  await a11yCases();
}

await main();
/* ⚠️ `report()` 必须在异步区**之后** —— 否则计数只统计"跑完的那部分"。 */
report('WS-FND-167');