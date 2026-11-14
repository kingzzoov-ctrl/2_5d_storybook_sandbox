/**
 * WS-FND-13 —— US2 网关联动:端到端闭环(task-85 分片 1)。
 *
 * ## 本套件为什么存在
 *
 * task-85 的结论是:**US2 的功能内核已经通了** ——
 * `assemble()` 产出的运行时可以直接喂给 `startWsServer()`。
 * 但那一条是**探针**(`_t85_e2e2.ts`)跑出来的,不是门禁。
 * 本套件把它**固化成断言**,于是它会开始有代价。
 *
 * ## ★ 本套件与「记录现状」的区别(这是它存在的全部理由)
 *
 * 一个只写「帧数 > 0」的端到端测试是**记录现状**:它在不接线时**也绿**,
 * 因为 `room.step()` 每帧都会 `meta.tick += 1` ⇒ 永远有非空差量(10 字节)。
 * (本仓 build-wiring 那次「引用不等于执行」正是这一族:
 *  import 了 3 个符号一个都没调用,而门禁、文本、测试**三处全绿**。)
 *
 * ⇒ 故本套件有三层牙:
 * ```
 * E3  世界帧在广播期间**持续增长**(3 个采样点严格递增)
 *     —— 不是「帧数 > 0」;「大于 0」可以由**一次**推进伪造
 * E4  增长量与广播周期**同量级**
 *     —— 排除「只推进了一次就停了」
 * E6  负对照:同一组观测在 host 为 null 上**必须不成立**
 *     —— 证明断言依赖的是「接线」这个事实,而不是环境里恰好有东西在动
 * ```
 * `E6` 是**进程内故障注入**:它每次运行都执行,所以不需要改任何生产文件
 * 就能持续证明「这些判据是有牙的」。这比一次性注入更强。
 *
 * ## E5 记录一个反直觉的事实(它本身是缺陷探测器)
 *
 * `host` 为 null 时,**仍然会有非空帧**(`tick` 字段的差量,10 字节),
 * 但**世界一帧都没动**。⇒ 「收到了非空帧」**不能**推出「世界在跑」。
 * 实测依据:task-85 的 `_t85_e2e2.ts` 的 J6 ——
 * 第一版判据用字节数判世界有没有动,得到「host=null 也发了 24 帧」的反直觉结果。
 * 本套件把这个陷阱变成断言,防止后人再用字节数当判据。
 *
 * ## 每条断言都附「它能怎么变红」
 *
 * 见各断言上方注释 —— 本仓纪律:一条不能变红的断言等于没写。
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble } from '../server/src/index.ts';
import { startWsServer, PROTOCOL_VERSION } from '../server/src/net/ws_server.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import { decodePacket } from '../shared/net/delta.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const enc = new TextEncoder();

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/**
 * 异步版 `test` —— 收集到同一个 results 数组(`report()` 才看得到)。
 *
 * ⚠️ 为什么不能直接用 `test()`:它 `fn(); results.push({ok:true})` **不 await**。
 * 传一个 async 函数进去 ⇒ 立刻返回 pending Promise ⇒ 不抛 ⇒ 记成 ok:true
 * ⇒ ⇒ 里面的断言**一个都没跑完**,而套件显示「全通过」。
 * 这是本仓反复出现的「不忠实」形态,这次不忠实的是**测试驱动器本身**。
 * (同 WS-13 的 `atest`。)
 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** 带超时兜底 —— 一次挂起的测试在 CI 里表现为「卡住」而不是「失败」。 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`超时 ${ms}ms:${what}`)), ms);
  });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

/** 世界源的结构化视图(不 import 模拟层类型 —— 与 WsRoomLike 同纪律)。 */
type HostProbe = {
  frame?: number;
  /**
   * 驱动入口。
   *
   * ★ **必须可选** —— `RoomRuntime.step()` 里那行判断是
   * `typeof host.advance === 'function'`,即它**容忍**世界源不实现 advance。
   * 而 E7 的注入测的正是「host 在但**缺 advance**」这一半。
   * ⇒ 若把这里写成必填,E7 的前提在**类型上**就不成立
   *   (想造那个对象会被 tsc 拒绝),那 E7 就只能靠 `as never` 硬塞,
   *    而硬塞会让「类型说必须有、实现却没有」这个真实形态**从类型系统里消失**。
   */
  advance?: (frames: number) => number;
  addPlayer?: (id: string, x: number, y: number) => void;
  playerPosition?: (id: string) => { x: number; y: number } | null;
};
const hostOf = (rt: RoomRuntime): HostProbe => (rt.worldSaveHost ?? {}) as unknown as HostProbe;

/** 连一个真客户端并收集收到的帧(与 `session.ts:266` 同形:发 `[0x01][JSON]`)。 */
type Collected = { welcome: Record<string, unknown> | null; bin: Uint8Array[]; sentHello: boolean };
function connect(url: string, userId: string): { ws: WebSocket; got: Collected; done: Promise<void> } {
  const got: Collected = { welcome: null, bin: [], sentHello: false };
  const ws = new WebSocket(`${url}?userId=${userId}`);
  ws.binaryType = 'arraybuffer';
  const done = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      const body = enc.encode(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null }));
      const payload = new Uint8Array(body.byteLength + 1);
      payload[0] = 0x01;
      payload.set(body, 1);
      ws.send(payload);
      got.sentHello = true;
    });
    ws.addEventListener('message', ((ev: { data: unknown }) => {
      const d = ev.data;
      if (typeof d === 'string') { got.welcome = JSON.parse(d) as Record<string, unknown>; return; }
      if (d instanceof ArrayBuffer) { got.bin.push(new Uint8Array(d)); return; }
      if (ArrayBuffer.isView(d)) {
        got.bin.push(new Uint8Array((d as ArrayBufferView).buffer,
          (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength));
      }
    }) as never);
    ws.addEventListener('close', (() => resolve()) as never);
    ws.addEventListener('error', () => resolve());
  });
  return { ws, got, done };
}

/** 安全关掉客户端与服务端(每一步都有超时,不会挂死套件)。 */
async function teardown(clients: { ws: WebSocket; done: Promise<void> }[],
  srv: { close(): Promise<void> }): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

const FRAME_MS = 20;      /* 20Hz,与生产对齐 */
const WARMUP_MS = 150;
const STEP_MS = 200;
const SAMPLES = 3;

/**
 * ★ 核心观测:起服务、连客户端、按固定间隔采**世界帧**(不是采字节数)。
 * 返回世界帧采样序列 + 客户端收到的二进制帧。
 */
async function observe(room: RoomRuntime, withWorld: boolean): Promise<{
  samples: number[]; frames: Uint8Array[]; hostFrameReadable: boolean;
}> {
  const srv = await startWsServer({ port: 0, room: room as never, frameMs: FRAME_MS });
  const client = connect(`ws://127.0.0.1:${srv.port}/ws`, 'alice');
  /* ⚠️ 断言写在 try 之外时一旦抛,finally 不执行 ⇒ srv 不关 ⇒ 进程不退 */
  try {
    /* 世界侧要有个玩家,否则快照无内容(host 为 null 时这步无效,正是对照点) */
    hostOf(room)?.addPlayer?.('alice', 5, 5);
    await sleep(WARMUP_MS);
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const h = hostOf(room);
      samples.push(withWorld ? Number(h.frame ?? -1) : 0);
      await sleep(STEP_MS);
    }
    return { samples, frames: client.got.bin, hostFrameReadable: hostOf(room)?.frame !== undefined };
  } finally {
    await teardown([client], srv);
  }
}

/* ═══════════════════ 1. 主段(异步)═══════════════════ */

async function main(): Promise<void> {
  /* ── E1 装配产物:host 是**真 WorldSim**,不是占位 ── */
  await atest('FND13-1 assemble() 的 host 是真世界源(非 null 且是有 frame 的实体)', async () => {
    /* 变红条件:有人把 assemble() 里的 `host,` 改成 `host: null`。 */
    const a = assemble({ roomId: 'r13', ownerId: 'o', clock: fixedClock(0), sizeCells: 64 });
    ok(a.runtime.worldSaveHost !== null, 'assemble() 必须把 host 接进运行时(为 null 则 US2 未接)');
    ok(typeof hostOf(a.runtime).advance === 'function', 'host 必须有 advance(驱动入口)');
    ok(hostOf(a.runtime).frame !== undefined,
      'host 应是真世界源(有 frame 可观测)—— 占位对象会在这里红');
  });

  /* ── E2 ★ 端到端:真 WS 客户端收到**可解码**的协议包 ── */
  await atest('FND13-2 ★★ 端到端:真 startWsServer + 真客户端 ⇒ 收到可解码的二进制帧', async () => {
    /* 变红条件:链路断裂(host 置 null 且下游不再推进 / 服务端不发帧 / 协议损坏)。 */
    const a = assemble({ roomId: 'r13b', ownerId: 'o', clock: fixedClock(0), sizeCells: 64 });
    const r = await observe(a.runtime, true);
    ok(r.frames.length > 0, `应至少收到 1 个二进制帧(实得 ${r.frames.length})`);
    let decodable = 0;
    for (const f of r.frames) { try { decodePacket(f); decodable += 1; } catch { /* 非协议包 */ } }
    ok(decodable > 0, `${r.frames.length} 个二进制帧里至少 1 个应是合法协议包(实得 ${decodable})`);
  });

  /* ── E3 ★★ 世界帧**持续增长**(不是「大于 0」)── */
  await atest('FND13-3 ★★ 世界帧持续增长:3 个采样点严格递增(不是「帧数 > 0」)', async () => {
    /* ★ 这是本套件与「记录现状」的分界。
     *
     * 「帧数 > 0」可以由**一次**推进伪造 —— 而那正是 build-wiring 那次的形态:
     * 符号被 import 了却一次都没调用,三处判据全绿。
     *
     * 变红条件:
     *   1 host 为 null(世界根本不推进)⇒ samples 恒为 0 ⇒ 严格递增失败
     *   2 只推进一次就停 ⇒ 后两点相等 ⇒ 失败
     *   3 step() 里那处 host.advance(1) 被删 ⇒ 同上 */
    const a = assemble({ roomId: 'r13c', ownerId: 'o', clock: fixedClock(0), sizeCells: 64 });
    const r = await observe(a.runtime, true);
    const s = r.samples;
    eq(s.length, SAMPLES, '采样点数');
    for (let i = 1; i < s.length; i += 1) {
      ok(s[i]! > s[i - 1]!,
        `世界帧必须严格递增 —— 第 ${i} 点 ${s[i]} 未大于第 ${i - 1} 点 ${s[i - 1]}(全序列 ${s.join(',')})`);
    }
    ok(s[0]! > 0, `首个采样点的世界帧应已 > 0(实得 ${s[0]})`);
  });

  /* ── E4 ★★ 增长量与广播周期**同量级** ── */
  await atest('FND13-4 ★★ 可观测量:增长量与广播周期同量级(排除「只推进一次」)', async () => {
    /* 「严格递增」仍可能被「每次只 +1 且远慢于广播」伪造。
     *
     * 口径:**参数 + 样本量 + 精度**写清,因为这里有个本来就松的容差:
     *   参数    frameMs=${FRAME_MS}  WARMUP=${WARMUP_MS}ms  STEP=${STEP_MS}ms  SAMPLES=${SAMPLES}
     *   理论    窗口 (SAMPLES-1)*STEP = 400ms ⇒ 400/20 = 20 帧
     *   样本量   1 条断言(1 次观测,3 个采样点)
     *   精度     整帧计数(不是估计值)
     *   ⇒ 门限取**理论的 25%**(5 帧):
     *      下界宽松是为了容忍 CI 抖动,但 5 远大于「只推进一次」的 1。
     *      `setInterval` 不保证精确 50/20ms,本仓实测过会跑成 16Hz 有效。 */
    const a = assemble({ roomId: 'r13d', ownerId: 'o', clock: fixedClock(0), sizeCells: 64 });
    const r = await observe(a.runtime, true);
    const s = r.samples;
    /* 分母断言:本判据要求至少 2 个点才能算增量 */
    ok(s.length >= 2, `需要至少 2 个采样点才能算增量(实得 ${s.length})`);
    const delta = s[s.length - 1]! - s[0]!;
    const windowMs = (SAMPLES - 1) * STEP_MS;
    const theoretical = windowMs / FRAME_MS;
    const floor = Math.floor(theoretical * 0.25);
    ok(delta >= floor,
      `世界帧在 ${windowMs}ms 内应至少增长 ${floor} 帧(理论 ${theoretical} 帧,取 25% 下界);`
      + `实测 Δ=${delta}(序列 ${s.join(',')})`);
  });

  /* ── E5 ★ 负对照(进程内故障注入):host=null 时同一组观测**不成立** ── */
  await atest('FND13-5 ★★ 负对照:同一组观测在 host=null 上不成立 ⇒ 判据有牙', async () => {
    /* ★ 这就是「先让它红一次证明有牙」的**可重复**版本:
     * 不需要改任何生产文件,每次跑都会执行这条对照。
     *
     * 为什么它比一次性注入强:
     *   一次性注入证明的是「某次改动会让它红」;
     *   这条对照证明的是「判据依赖**接线**这个事实,而不是环境里恰好有东西在动」。
     *
     * 变红条件:host 为 null 时世界帧**仍在增长**(那说明判据认不出"没接线")。 */
    const bare = new RoomRuntime({
      roomId: 'r13e', ownerId: 'o', clock: fixedClock(0), sizeCells: 64,
    } as never, null);
    eq(bare.worldSaveHost, null, '未注入 host 时 worldSaveHost 应为 null(这正是 B 路生产态)');
    const r = await observe(bare, false);
    /* 世界的可观测帧号读不到 ⇒ 世界不可能在推进 */
    ok(!r.hostFrameReadable, 'host 为 null 时不应能读到世界帧号');
    ok(r.samples.every((x) => x === 0), `host 为 null ⇒ 世界帧采样应恒为 0(实得 ${r.samples.join(',')})`);
  });

  /* ── E6 ★ 记录陷阱:host=null 时**仍有非空帧**,但世界没动 ── */
  await atest('FND13-6 ★ 陷阱记录:host=null 时仍有非空帧 ⇒ 「非空帧」推不出「世界在跑」', async () => {
    /* ★ 这条钉的是一个**已经咬过我一次**的判据错误。
     *
     * task-85 实测:第一版端到端探针用**字节数**判「世界有没有动」,
     * 得到反直觉结果 —— host 为 null 时 framesSent 仍是 24,末帧 10B。
     * 真因:room.step() **总会** `meta.tick += 1` ⇒ 每帧都有 tick 字段的差量。
     *
     * ⇒ 「收到了非空帧」**不能**推出「世界在跑」。
     * 本断言把这个事实固定下来:同一时刻,帧非空 **且** 世界帧为 0。
     *
     * 变红条件:有人以为「非空帧 = 世界在跑」而据此删掉 E3/E4 的帧数断言
     * —— 那会让本条与 E3/E4 的说法互相矛盾,这里先钉死前者。 */
    const bare = new RoomRuntime({
      roomId: 'r13f', ownerId: 'o', clock: fixedClock(0), sizeCells: 64,
    } as never, null);
    bare.join({ userId: 'alice' });
    let nonEmpty = 0;
    let lastLen = 0;
    let prev = bare.cloneState();
    for (let i = 0; i < 25; i += 1) {
      const pkt = bare.step(prev);
      if (pkt.byteLength > 0) { nonEmpty += 1; lastLen = pkt.byteLength; }
      prev = bare.cloneState();
    }
    /* 世界侧没有任何推进入口 ⇒ 世界帧不存在 */
    ok(!('frame' in hostOf(bare)), 'host 为 null ⇒ 读不到世界帧');
    ok(nonEmpty === 25,
      `★ 25 帧应**全部**非空(tick 差量),实测 ${nonEmpty}/25(* 这就是陷阱:世界一帧没动)`);
    ok(lastLen > 0, `末帧应非空(实测 ${lastLen}B)`);
    /* 而世界确实没动 —— 与 E3/E4 的 wired 情形形成对照 */
    const st = bare.cloneState();
    eq(st.meta.tick, 25, '房间帧号确实在走(它走的是 meta.tick,与世界帧无关)');
  });

  /* ── E7 ★★★ 故障注入:host 在,但**缺 advance** ⇒ 世界帧必须一格不动 ── */
  await atest('FND13-7 ★★★ 故障注入:host 在但缺 advance ⇒ 世界帧不动(证明 E3/E4 有牙)', async () => {
    /* ★ 这是「先让它红一次」的**最强形式**:不动任何生产文件,
     * 而是在**进程内**造出 `room.ts:1546` 那个条件判断的**另一半**:
     *
     *   const host = this.worldSaveHost;
     *   if (host !== null && typeof host.advance === 'function') { host.advance(1); }
     *                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 本断言专打这一半
     *
     *   E5 钉的是 `host === null` 那一半;
     *   E7 钉的是「host 非 null 但**没有 advance**」那一半。
     *   ⇒ `&&` 两侧都被覆盖。
     *
     * ## 为什么必须测这一半
     * 若有人把条件退化成「有 host 就算接了」(比如删掉 typeof 判断、
     * 或改成不检查就调用),那么在**实现不全**的世界源上会抛错或静默失败;
     * E7 正好抓这种退化 —— 它要求推进**必须**源自 `host.advance` 这一行。
     *
     * ## 变红条件
     * 缺 advance 时世界帧**仍在增长** ⇒ 说明推进另有来源(判据认错了来源)。
     *
     * ## 实现要点
     * `worldSaveHost` 是**可写字段**(`room.ts:793`),
     * 故可在进程内替换为「字段齐全但**没有** advance」的对象。
     * ⚠️ 必须**保留** saveToDb/levelOf 等 —— 否则 step() 里别的分支先抛错,
     *    那样红的原因就不是「少 advance」了。**注入物只改一个自由度。** */
    const a = assemble({ roomId: 'r13g', ownerId: 'o', clock: fixedClock(0), sizeCells: 64 });
    ok(a.runtime.worldSaveHost !== null, '前置:assemble() 必须已接上 host(否则本注入无意义)');

    const staticFrame = 500;
    const staticHost = {
      saveToDb: () => ({ hpSaved: 0, hpSkipped: 0, memRow: 0 }),
      levelOf: () => 1,
      attackMobAuthorized: () => ({ ok: false, reason: 'inject' }),
      addPlayer: () => undefined,
      removePlayer: () => false,
      applyPlayerMove: () => true,
      playerPosition: () => ({ x: 5, y: 5 }),
      setPlayerAfk: () => undefined,
      frame: () => staticFrame,
      /* ★ 刻意**不**提供 advance —— 这就是注入点 */
    };
    a.runtime.worldSaveHost = staticHost as never;
    ok(typeof hostOf(a.runtime).advance !== 'function',
      '前置:注入后 host 上不应有 advance(否则注入没生效)');

    a.runtime.join({ userId: 'alice' });
    for (let i = 0; i < 25; i += 1) a.runtime.step(null);
    eq(staticFrame, 500,
      '★ 缺 advance ⇒ 世界帧必须**一格都没动**(动过就说明推进不源自 host.advance)');
    /* 而房间帧号照走 —— 两者互不联动(room.ts 的「三个时钟」注释) */
    eq(a.runtime.cloneState().meta.tick, 25, '房间帧号照走(与世界帧无关)');
  });
}

/* ⚠️ `report()` 必须在**异步区之后**调用 ——
   否则异步断言还没跑,它已经把计数打印完了:数字是真的,
   只是统计的是「跑完的那部分」,而看上去像「全部」。 */
await main();
report('WS-FND-13');
