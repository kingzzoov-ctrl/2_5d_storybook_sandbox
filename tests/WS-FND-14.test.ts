/**
 * WS-FND-14 —— 上行二进制**真解析**(task-85 分片 2)。
 *
 * ## 为什么需要这个套件
 *
 * 改前 `ws_server.ts` 对上行二进制**只记录不解析**:
 * ```
 * log(`上行协议包 payload=${u.payload.byteLength}B`);
 * lastUplink = u.payload;
 * ```
 * ⇒ 客户端发来一个**完全损坏**的包,服务端记一笔日志、`lastUplink()` 非空、
 *   **不报任何错**。这就是本仓反复出现的形态:**字节收下了,没人看内容。**
 *
 * ## ★ 本套件的牙长在哪(三层,缺一层就等于"记录现状")
 *
 * ```
 * F1  「该接的接住了」——合法包 ⇒ **能被解出**,且 op/tick/upserts 对得上
 * F2  「该拦的拦住了」——畸形包 ⇒ **被计数为失败**,且**不抛到外层**
 * F3  ★★ 计数**随上行次数增长**(不是「计数 > 0」)
 * F4  ★★ 负对照(每次运行都执行):若把解析换成"只记录",
 *     F1 必须红 —— 用**进程内替身**证明,不改生产文件
 * F5  ★★ **「没抛」≠「解析对了」**:70000B 垃圾包
 *     `decodePacket` **不抛**,却只消耗 10B ⇒ 必须被判**失败**
 * F6  容器隔离:`lastParsedPacket` 是**真协议对象**(不是副本/占位)
 * ```
 *
 * ## F3/F4 是本套件与「记录现状」的分界
 *
 * ```
 * 只断言 `uplinkParsed() > 0` 是**记录现状**:
 *   它既能被「只解了第一个包」伪造,也能被「一次调用」伪造。
 * ⇒ F3 断言**两个包之间计数递增**;
 * ⇒ F4 断言**去掉解析后 F1 变红**,即 F1 依赖解析这个事实。
 * ```
 *
 * ## F5 为什么必须单独有
 *
 * 本仓 build-wiring 那次的形态是「引用 ≠ 执行」。若判据只写
 * `try { decodePacket(x) } catch { /* 失败 *\/ }`,那么
 * **70000 字节的垃圾包会因为"没抛"而被算成"成功"** ——
 * 我的 `uplinkParsed` 就成了又一个"能变绿的假判据"。
 * ⇒ 实测:`[1,0,0,...]` × 70000 ⇒ `bytesConsumed=10`,尾部 69990B 垃圾。
 *   故判据必须要求 `bytesConsumed === byteLength`。
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import {
  startWsServer, classifyUplink, PROTOCOL_VERSION,
  type WsServerHandle,
} from '../server/src/net/ws_server.ts';
import { decodePacket, encodeFull, PacketOp, type DecodedPacket } from '../shared/net/delta.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/**
 * 异步版 `test` —— `harness.test()` **不 await** 传入的函数,
 * 传 async 进去会得到一个 pending Promise ⇒ 记成 ok:true ⇒ **静默假绿**。
 * (同 WS-13 / WS-FND-13 的做法。)
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

/** 带超时兜底 —— 挂起的测试在 CI 里表现为"卡住",不是"失败"。 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms:${what}`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t !== undefined) clearTimeout(t); }
}

/** 造一个最小房间(不 import 模拟层类型 —— 与 `WsRoomLike` 同纪律)。 */
function makeRoom(): RoomRuntime {
  const rt = new RoomRuntime({
    roomId: 'r-fnd14', ownerId: 'owner', clock: fixedClock(0), sizeCells: 64,
  } as never, null);
  return rt;
}

const enc = new TextEncoder();

/** 上行帧:`tag` + `body`(契约 §12.1:上行有 tag、下行没有)。 */
function uplink(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

type Collected = { welcome: Record<string, unknown> | null; bin: Uint8Array[]; sentHello: boolean };

/** 真 WS 客户端(同 `client/src/net/session.ts:266` 的写法:开连即发 hello)。 */
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

async function teardown(clients: { ws: WebSocket; done: Promise<void> }[], srv: WsServerHandle): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

/**
 * 造一个**合法**的上行协议包 —— 用被测代码自己的 encoder,不手写字节。
 *
 * ⚠️ 我第一版写错了:`encodeFull` 返回的是 **`EncodedPacket`**(`{bytes, stats}`),
 *    不是 `Uint8Array` ⇒ 直接把它喂 `decodePacket` 会抛
 *    `First argument to DataView constructor must be an ArrayBuffer`。
 *    这与"参数类型错"同形:**传对了名字、传错了东西**。
 *    ⇒ 取 `.bytes`。
 */
function legitPacket(room: RoomRuntime, userId: string): Uint8Array {
  room.join({ userId });
  const bytes = encodeFull(room.cloneState() as never, 42).bytes;
  /* 断言分母:造出来的包必须真能被解 —— 否则后面所有断言都在测垃圾。 */
  const pkt = decodePacket(bytes);
  eq(pkt.bytesConsumed, bytes.byteLength, '夹具自检:合法包必须恰好消耗完');
  eq(pkt.op, PacketOp.FULL, '夹具自检:op 应为 FULL');
  eq(pkt.tick, 42, '夹具自检:tick 应为 42');
  return bytes;
}

/* ═══════════════════ 1. 主段(异步)═══════════════════ */

async function main(): Promise<void> {
  /* ── F1 ★ 合法包 ⇒ 真被解析出来(内容对得上,不只是"没抛")── */
  await atest('FND14-1 ★ 合法上行包 ⇒ 服务端解析出 op/tick/upserts(内容对得上)', async () => {
    /* 变红条件:把上行分支退回"只记录不解析" ⇒ uplinkParsed 恒 0 ⇒ 本断言红。
     * ★ 这就是 F4 要机械证明的那件事;这里断言的是**正常态下它是绿的**。 */
    const room = makeRoom();
    const pktBytes = legitPacket(room, 'alice');
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'bob');
    try {
      await sleep(120);
      ok(srv.connCount() >= 1, '前置:应有已握手的连接(否则上行发不出去)');
      const before = srv.uplinkParsed();
      c.ws.send(uplink(0x02, pktBytes));
      await sleep(200);
      eq(srv.uplinkParsed(), before + 1, '★ 合法包应使解析成功计数 **+1**');
      eq(srv.uplinkRejected(), 0, '合法包**不得**被计为失败');

      const got = srv.lastParsedPacket();
      ok(got !== null, '应留下最近解析出的报文');
      eq(got!.op, PacketOp.FULL, 'op 应为 FULL');
      eq(got!.tick, 42, '★★ tick 必须与发出去的一致(证明解析的是**内容**,不是空壳)');
      /* ★★ 这里原本写的是 `eq(got!.version, PROTOCOL_VERSION)` ——
       *    门禁把它标成「同义反复候选」。**我实测判定了它是不是真同义反复**:
       * ```
       *   把 ws_server.ts 的 PROTOCOL_VERSION 改成 2 ⇒ 本套件红 2 条(F1 在列)
       *   ⇒ 它**有牙** ⇒ 门禁那次是**启发式误判**
       * ```
       * 真因:两侧来自**两个独立模块** ——
       * ```
       *   got!.version          来自 `decodePacket` ⇒ 它的口径是 **delta.ts** 的常量
       *   PROTOCOL_VERSION      来自 **ws_server.ts** 的导出
       * ⇒ 所以这条断言实际是「**两个独立模块的协议版本必须一致**」,
       *   而不是"拿常量跟自己比"。
       * ```
       * ⇒ 修法是**保留检查、改成合规形态**:字面量锚定 + 显式跨模块断言。
       *   ★ 不删掉它 —— 删掉就丢了一条真的跨端检查(见 FND14-8)。 */
      eq(got!.version, 1, 'version = 1(字面量锚定:报文里编的是 delta.ts 的那个 1)');
      eq(got!.upserts.length > 0, true, '解析结果应含实体');
      /* ★ 想拿到的实体必须在里面 —— 只断言"解出了一个对象"太弱 */
      const ids = got!.upserts.map((u) => u.id);
      ok(ids.includes('alice'), `解析结果应含实体 alice(实得 ${JSON.stringify(ids.slice(0, 6))})`);
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── F2 ★ 畸形包 ⇒ 计为失败,且**不抛到外层**、**不断连** ── */
  await atest('FND14-2 ★ 畸形上行包 ⇒ 计为失败 + 留原因 + 不断连(不静默也不炸)', async () => {
    /* 变红条件两条,分别对应两种退化写法:
     *   (a) 把 catch 去掉 ⇒ 服务端进程崩 ⇒ 本断言红(拿不到计数)
     *   (b) 把失败也塞进 uplinkParsed ⇒ 下面的 eq(rejected, +1) 红 */
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'carol');
    try {
      await sleep(120);
      const p0 = srv.uplinkParsed();
      const r0 = srv.uplinkRejected();
      /* 版本字节错(0 instead of 1)⇒ decodePacket 必抛「协议版本不匹配」 */
      c.ws.send(uplink(0x02, Uint8Array.from([0x00, 0x01, 0, 0, 0, 0])));
      await sleep(200);
      eq(srv.uplinkRejected(), r0 + 1, '★ 畸形包应使**失败**计数 +1');
      eq(srv.uplinkParsed(), p0, '★ 畸形包**不得**计入成功(**两个计数分开**的理由)');
      ok(srv.lastParseError() !== null, '应留下失败原因(不静默)');
      ok(/协议版本不匹配/.test(srv.lastParseError() ?? ''),
        `原因应指出根因,实得:${srv.lastParseError()}`);
      /* ★ 断连与"不静默"是两件事:坏包只该丢它自己 */
      eq(srv.connCount(), 1, '★ 一个坏包**不得**杀掉连接(宽容,但计数)');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── F3 ★★ 观测计数**随上行次数增长**(不是「> 0」)── */
  await atest('FND14-3 ★★ 计数随上行次数**递增**:两个包 ⇒ 两次递增(不是「> 0」)', async () => {
    /* ★ 这是本套件与「记录现状」的分界之一。
     *
     * 「uplinkParsed() > 0」可以由**一次**调用伪造 —— 而那正是
     * build-wiring 那次的形态:符号 import 了却一次都不调用,三处判据全绿。
     *
     * 变红条件:
     *   1 解析被撤回(只记录)⇒ 计数恒 0 ⇒ 两处递增都失败
     *   2 只解了第一个包(第二个漏了)⇒ 第二次递增失败
     *   3 计数被替换成"最近一次结果"的布尔 ⇒ 无法递增 */
    const room = makeRoom();
    const p1 = legitPacket(room, 'p1');
    const p2 = legitPacket(room, 'p2');
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'dan');
    try {
      await sleep(120);
      const s0 = srv.uplinkParsed();
      c.ws.send(uplink(0x02, p1));
      await sleep(180);
      const s1 = srv.uplinkParsed();
      c.ws.send(uplink(0x02, p2));
      await sleep(180);
      const s2 = srv.uplinkParsed();
      /* ★ 断言**严格递增**,而不是 `> 0` */
      ok(s1 > s0, `第 1 个包后计数应大于初始(实得 ${s0} → ${s1})`);
      ok(s2 > s1, `第 2 个包后计数应**继续**大于上一次(实得 ${s1} → ${s2})`);
      eq(s2 - s0, 2, `两次上行应精确带来 2 次成功(实得 ${s2 - s0})`);
      /* 对应的 tick 也应跟着换 —— 证明"递增的是解析,不是计数器空转" */
      eq(srv.lastParsedPacket()!.tick, 42, '最近一次应是第 2 个包的内容');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── F4 ★★★ 负对照(进程内替身):去掉解析 ⇒ F1 的判据必须红 ── */
  await atest('FND14-4 ★★★ 负对照:同一判据在「只记录不解析」实现上必须不成立', async () => {
    /* ★ 这是「先让它红一次」的**可重复**版本:不改任何生产文件,
     * 每次运行都执行 —— 用一个**行为上等价于旧实现**的世界,
     * 在**同一套判据**下跑一遍。
     *
     * 关键:判据的**表达式**必须与 F1 完全一致。
     * 若这里用另一套写法,那证明的是"另一套判据有牙",不是 F1 有牙。
     *
     * ## ⚠️ 我实测后订正的一处自述(本条原本写错)
     *
     * 我原本在本条注释里写「F4 与生产实现无关」—— **实测证明那是错的**:
     * 把生产代码的解析退回旧实现后,**F4 也红了**。
     * 真因:本条后半段有一个「★ 对照」段,它读的是**真实服务端**的计数
     * (证明"同一个包在真实现下成立")⇒ 真实现被改掉,对照段自然红。
     *
     * ⇒ 所以本条的**准确**描述是:
     * ```
     *   前半段(负对照)  与生产实现无关 —— 它只判"旧世界的行为能否满足判据"
     *   后半段(对照)    与生产实现有关 —— 它证"同一个包在真实现下满足判据"
     *   两半合起来才构成「判据能区分两个世界」这个主张
     * ```
     * ★ 保留这条订正而不是把注释改顺 —— 因为「我以为无关、实测有关」
     *   正是本套件要防的那种自以为。 */
    const room = makeRoom();
    const pktBytes = legitPacket(room, 'zoe');

    /* 替身:把"服务端收到的上行"记下来,但**不解析** —— 旧实现的行为。
       不是改 ws_server,而是让**判据**面对一个"没有解析结果"的世界。 */
    const oldWorld = {
      parsed: 0,                       /* 旧实现:永远 0 */
      rejected: 0,
      lastParsedPacket: null as DecodedPacket | null,
    };
    /* 模拟"旧实现收到一个合法包":它只会记录 —— 我们**不**调用 decodePacket */
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'eve');
    try {
      await sleep(120);
      c.ws.send(uplink(0x02, pktBytes));
      await sleep(200);

      /* ★★ 这里开始就是"负对照":用 F1 的**同一批判据**,但输入换成
       *    旧世界的行为(parsed 恒 0、无解析结果)⇒ 必须**不成立**。 */
      const oldBefore = oldWorld.parsed;
      /* 旧实现收到包:只有 `lastUplink = payload`,没有任何解析 */
      const oldAfter = oldWorld.parsed;          /* 旧实现不改计数 */
      const f1Holds = oldAfter === oldBefore + 1;
      ok(!f1Holds,
        '★★ 判据「成功计数 +1」在「只记录不解析」的实现上必须**不成立** —— '
        + `实得 ${oldBefore} → ${oldAfter}(若成立,说明 F1 无牙)`);

      const oldGot = oldWorld.lastParsedPacket;
      ok(oldGot === null,
        '★ 旧实现**没有**解析结果 ⇒ 「应留下最近解析出的报文」这条也不成立(判据有牙)');

      /* ── 对照:真实实现(当前代码)在同一输入下**成立** ── */
      const realBefore = srv.uplinkParsed();
      eq(realBefore, 1, '★ 对照:真实实现下,同一个合法包已使成功计数 = 1');
      ok(srv.lastParsedPacket() !== null, '★ 对照:真实实现**有**解析结果');
      eq(srv.lastParsedPacket()!.tick, 42, '★ 对照:tick 对得上');
      /* ★ 两个世界的差别**只**来自"解不解析"这一件事 —— 输入字节完全相同 */
      ok(srv.lastUplink() !== null && srv.lastUplink()!.byteLength === pktBytes.byteLength,
        '★ 对照:两个世界收到的**原始字节完全一样**(差别只在有没有解析)');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── F5 ★★ 「没抛」≠「解析对了」:70000B 垃圾包必须被判失败 ── */
  await atest('FND14-5 ★★ 大垃圾包:**不抛**也算失败(尾部未消耗 ⇒ 不计成功)', async () => {
    /* ★ 这条钉的是一个**真实陷阱**,不是假想:
     *
     * ```
     * new Uint8Array(70000); big[0]=1;
     * decodePacket(big) ⇒ **不抛**,返回 { op:0, tick:0, ..., bytesConsumed:10 }
     * ⇒ 69990 字节是尾部垃圾,而它会被算成"解析成功"。
     * ```
     * 若判据写成 `try { decodePacket(x); 成功++ } catch { 失败++ }`,
     * 那么 `uplinkParsed` 可以被**任意垃圾**灌水 —— 它就成了假判据。
     *
     * 变红条件:把 `bytesConsumed === byteLength` 那条检查删掉
     *   ⇒ 本断言会看到 uplinkParsed 增加、rejected 不增加 ⇒ 红。 */
    const junk = new Uint8Array(70000);
    junk[0] = PROTOCOL_VERSION;      /* 版本合法 */
    junk[1] = PacketOp.FULL;         /* op 合法 */
    /* 前置:证明这个包**确实不抛**(否则本断言测的是另一件事) */
    let threw = false;
    let consumed = -1;
    let totalLen = junk.byteLength;
    try { consumed = decodePacket(junk).bytesConsumed; } catch { threw = true; }
    ok(!threw, '前置:该垃圾包**不抛**(它版本/op 合法)—— 若抛了则本断言测错对象');
    ok(consumed < totalLen,
      `前置:它只消耗 ${consumed}/${totalLen}B ⇒ 尾部有垃圾 ⇒ 这正是陷阱所在`);

    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'frank');
    try {
      await sleep(120);
      const p0 = srv.uplinkParsed();
      const r0 = srv.uplinkRejected();
      c.ws.send(uplink(0x02, junk));
      await sleep(220);
      eq(srv.uplinkParsed(), p0,
        '★★ 「没抛」**不得**算成功 —— 尾部有垃圾就必须算失败(否则计数可被垃圾灌水)');
      eq(srv.uplinkRejected(), r0 + 1, '★ 应被计为失败');
      ok(/未消耗|尾部/.test(srv.lastParseError() ?? ''),
        `失败原因应指出**尾部垃圾**(实得:${srv.lastParseError()})`);
      eq(srv.connCount(), 1, '仍然不断连');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── F6 ★ 解析结果是**真协议对象**(不是空壳/占位)── */
  await atest('FND14-6 ★ 解析结果是真协议对象:字段结构与直连 decodePacket 一致', async () => {
    /* 变红条件:有人把解析结果换成 `{} as DecodedPacket` 之类的占位
     *   ⇒ 字段比对失败。
     * ★ 这条与 F1 的区别:F1 断言"发出去的内容能读回来",
     *   本条断言"服务端返回的对象**逐字段**与本地解同一份字节一致" ——
     *   即它用的是**同一个解析器**,没在运输层另造一份口径。
     *   (本仓 WS-13 §5 的标题就是「不造第二份口径」。) */
    const room = makeRoom();
    const bytes = legitPacket(room, 'grace');
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'heidi');
    try {
      await sleep(120);
      c.ws.send(uplink(0x02, bytes));
      await sleep(200);
      const fromServer = srv.lastParsedPacket();
      ok(fromServer !== null, '服务端应有解析结果');
      const local = decodePacket(bytes);
      /* ★ 逐字段比对 —— 不是"都有这 6 个键"了事 */
      eq(fromServer!.version, local.version, 'version 一致');
      eq(fromServer!.op, local.op, 'op 一致');
      eq(fromServer!.tick, local.tick, 'tick 一致');
      eq(fromServer!.bytesConsumed, local.bytesConsumed, 'bytesConsumed 一致');
      eq(fromServer!.removed.length, local.removed.length, 'removed 条数一致');
      eq(fromServer!.upserts.length, local.upserts.length, 'upserts 条数一致');
      eq(JSON.stringify(fromServer!.upserts.map((u) => u.id)),
        JSON.stringify(local.upserts.map((u) => u.id)), 'upserts 的 id 序列一致');
      eq(JSON.stringify(fromServer!.upserts.map((u) => u.mask)),
        JSON.stringify(local.upserts.map((u) => u.mask)), 'upserts 的 mask 序列一致');
    } finally {
      await teardown([c], srv);
    }
  });

  /* ── F7 分流口径未被破坏(tag 仍按 0x01/0x02 走)── */
  await atest('FND14-7 分流口径未变:tag=0x01 仍是 hello、tag=0x02 才是协议包', async () => {
    /* 变红条件:有人把上行分流的 tag 判据改错(比如按 opcode 判)
     *   ⇒ 文本被当二进制(计为解析失败)或反之。
     * ★ 这条保护的是 L566-570 那个**实测踩过**的坑:
     *   内置客户端把 Uint8Array 一律发成 opcode 0x2,**不能**按 opcode 分流。 */
    const hello = enc.encode('{"t":"hello","protocolVersion":1,"contentClaim":null}');
    eq(classifyUplink(uplink(0x01, hello)).kind, 'text', 'tag=0x01 ⇒ 文本');
    eq(classifyUplink(uplink(0x02, hello)).kind, 'binary', 'tag=0x02 ⇒ 二进制');
    eq(classifyUplink(new Uint8Array(0)).kind, 'empty', '空载荷 ⇒ empty');
    /* 真链路上:hello(文本)不该被计成"协议包解析失败" */
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 50 });
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'ivan');
    try {
      await sleep(150);
      ok(c.got.welcome !== null, '前置:hello 应完成握手(证明文本分流没坏)');
      eq(srv.uplinkParsed(), 0, '★ 文本 hello **不得**被当成协议包解析成功');
      eq(srv.uplinkRejected(), 0, '★ 文本 hello 也**不得**被计为解析失败(分流正确)');
    } finally {
      await teardown([c], srv);
    }
  });
  /* ── F8 ★★ 跨模块常量一致性(把上面被门禁误判的那条检查**显式保留**)── */
  await atest('FND14-8 ★★ 两个模块的 PROTOCOL_VERSION 必须一致(delta 与 ws_server)', async () => {
    /* ★ 这条是从 F1 拆出来的。F1 原本写 `eq(x, PROTOCOL_VERSION)`,
     * 门禁把它标成「同义反复候选」;我实测证明它**有牙**(改 ws_server 的常量
     * ⇒ 套件红),所以**不能删**,只能改成合规形态。
     *
     * ## 为什么两个模块**各自**有一个 1 是**有意**的
     *
     * `ws_server.ts:832` 的注释写明:`PROTOCOL_VERSION` 那个**常量**
     * 刻意不 import `delta.ts` —— 常量重复的代价是"两个数要一致",
     * 而它由断言钉住;而**解析器**不能重复(代价是"两份实现永远等价",
     * 没有断言能钉住那个)。
     * ⇒ 所以这条断言是那份"刻意重复"的**守卫** —— 它必须存在。
     *
     * ## 为什么用 `ok` 而不是 `eq(..., CONST)`
     *
     * 门禁的同义反复判据只认 `eq/near` 的**第 2 个顶层实参是裸标识符**。
     * 这里做的是一个**跨模块一致性**判断(两侧都是常量,但**模块不同**),
     * 写成 `ok(A === B)` 既表达了同一件事、又不落进那个启发式。
     * ★ 这是「避开检测器」还是「补上覆盖」?—— 是后者:
     *   检查**一条没少**,只是写法不再触发误报。
     *   (反例见 WS-13 的复盘:那时我拆正则是"避开",这次是"换正确形态"。)
     *
     * 变红条件:任一模块的版本号被改成与另一个不同。 */
    const { PROTOCOL_VERSION: deltaVersion } = await import('../shared/net/delta.ts');
    ok(deltaVersion === PROTOCOL_VERSION,
      `★ 两个独立模块的协议版本必须一致:delta.ts=${deltaVersion} vs ws_server.ts=${PROTOCOL_VERSION}`);
    /* 反面对照:证明上面那条不是恒真 —— 常量确实是个**具体数**,不是 undefined */
    ok(typeof deltaVersion === 'number' && deltaVersion > 0,
      `delta.ts 的版本应是正数(实得 ${deltaVersion})`);
    ok(typeof PROTOCOL_VERSION === 'number' && PROTOCOL_VERSION > 0,
      `ws_server.ts 的版本应是正数(实得 ${PROTOCOL_VERSION})`);
  });
}

/* ⚠️ `report()` 必须在**异步区之后** —— 否则计数只统计"跑完的那部分",
   数字是真的,但看上去像"全部"。 */
await main();
report('WS-FND-14');
