/**
 * `ws_demo.ts` —— 阶段 3 端到端**可跑入口**(task-69 交付物 2)。
 *
 * ```
 * node server/src/sim/ws_demo.ts              # ★ 默认:有界自检(跑完即退,带退出码)
 * node server/src/sim/ws_demo.ts --serve      # 常驻演示服务(端口 8791)
 * node server/src/sim/ws_demo.ts --serve --port 9000
 * ```
 *
 * ## 为什么要分成"自检"与"常驻"两种模式(不是风格选择)
 * ```
 * 本文件是**入口**(与 `server/src/sim/demo.ts` 同类)⇒ 它要进 `PROD_ENTRIES`
 *   ⇒ 而门禁的「入口可加载性」检查会**在子进程里 import 它**
 *     (`verify.ts:998` 的探针:`import(rel).then(() => process.exit(0))`)。
 * ★ 若本文件一被 import 就 `listen` 一个**固定端口**:
 *   · 门禁跑期间会真占端口 ⇒ 与并发的测试/演示**撞端口**;
 *   · 且它会**一直活着** ⇒ 那个探针的 `process.exit(0)` 变成唯一的出路
 *     ⇒ 门禁表面上"通过",而实际上**每次跑门禁都起了一次服务**。
 * ⇒ 故默认走**有界自检**:绑定 `port: 0`(内核分配)、跑完固定动作、
 *   **显式退出**并给出退出码。常驻服务要显式 `--serve`。
 * ⇒ 这与 `demo.ts` 同形(它也是"跑完一段自检就 exit")。
 * ```
 *
 * ## 它做什么(自检模式)
 * ```
 * 1 起 RoomRuntime(真 host,含 addPlayer/advance)
 * 2 起零依赖 WS 服务端(ws_server.ts),绑定 port: 0
 * 3 用 Node 内置 WebSocket **真连一次**,完成握手 + 收 welcome + 收二进制帧
 * 4 逐条断言,打印实测值;任一失败 ⇒ 退出码 1
 * ```
 *
 * ## ★★★ 推进责任:**默认不推**(实测踩到双重推进)
 * ```
 * `room.step()` 里已经接了 `host.advance(1)`(task-59 修了"驱动缺失")
 *   ⇒ 而它由 ws_server 的 50ms 广播循环调用
 * ⇒ 若本文件**也**起一个 50ms 定时器调 advance(1)
 *   ⇒ **每帧推进两次** ⇒ 世界快 2 倍
 *
 * ★ 实测证据(我自己踩到,在第一版里):
 *     `[sim] 已推进 40 快帧 · 世界帧号 80`
 *   —— 我只调了 40 次 advance,世界帧号却是 80 ⇒ **每帧被推了两次**。
 *   而**没有任何断言报红**:welcome 到了、帧也在发、客户端也在更新,
 *   唯一的现象是"世界比它该有的快一倍"。
 * ⇒ ⇒ 这正是本仓反复记录的那类错误(不报错,只是快 2 倍)。
 * ⇒ 故本文件**默认不推进**(推进归 room.step 那条路径);
 *   仅当显式加 `--advance` 时才自推 —— 那条路径**必须**同时让
 *   room 那条失效,否则又是双重推进。
 * ```
 *
 * ## ★★ 双频纪律(本仓世界层有内部双频,错了会让世界快 2 倍)
 * ```
 * WorldSim:TICK_HZ=20 / SLOW_TICK_HZ=2 / FAST_PER_SLOW=10
 * 而 `setSimulationInterval` 也是 20Hz ⇒ **两者嵌套**
 * ⇒ `advance(1)` 对应外部一帧,**恰好 1:1**,不要再乘 FAST_PER_SLOW。
 * 若以为"慢帧 2Hz 所以要乘 10" ⇒ 每慢帧推进两次 AI ⇒ 世界快 2 倍,
 *   而**不报错、测试也可能照过**(world_sim.ts 自己记着这个先例)。
 * ```
 *
 * ## ⚠️ 本文件与 task-59 的关系(边界,不是重复)
 * ```
 * task-59 修的是「**服务器路径**从不推进 sim」(room.ts 里接上 advance)
 * 本文件是**演示入口** —— 它构造自己的 room,因此也会经过那条路径。
 * ⇒ "谁推进"的最终归属由 task-59 决定(已定:room.step)
 *   ⇒ 本文件**不**自己推进。
 * ```
 */

import { RoomRuntime } from '../net/room.ts';
import { fixedClock } from '../net/anticheat.ts';
import { startWsServer, PROTOCOL_VERSION } from '../net/ws_server.ts';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8791;
/* ★ 默认**不**自推 —— 推进归 `room.step()` 里 task-59 接的那条路径。
   加 `--advance` 才会自推(那样必须让 room 那条失效,见文件头)。 */
const SELF_ADVANCE = args.includes('--advance');
/* ★ 默认有界自检;`--serve` 才常驻。理由见文件头(门禁会 import 本文件)。 */
const SERVE = args.includes('--serve');

/** ── 一个极简的"世界"存根:满足 room 需要的结构化接口。 ──
 *  ⚠️ 它**不**是 `WorldSim` —— demo 不需要真物理,只需要"会变"。
 *     真实现由 server/src/sim/world_sim.ts 提供,由装配层注入。 */
type DemoHost = {
  addPlayer(id: string, x: number, y: number): void;
  removePlayer(id: string): boolean;
  applyPlayerMove(id: string, x: number, y: number): boolean;
  playerPosition(id: string): { x: number; y: number } | null;
  advance(frames: number): number;
  saveToDb(...a: unknown[]): { hpSaved: number; hpSkipped: number; memRow: boolean };
  attackMobAuthorized(...a: unknown[]): { ok: boolean; reason?: string };
  levelOf(id: string): number;
};

function makeDemoHost(): DemoHost & { frame(): number; tickCount(): number } {
  const pos = new Map<string, { x: number; y: number }>();
  let frame = 0;
  return {
    addPlayer: (id, x, y) => { pos.set(id, { x, y }); },
    removePlayer: (id) => pos.delete(id),
    applyPlayerMove: (id, x, y) => {
      if (!pos.has(id)) return false;      /* 未登记的玩家不写 —— 与生产同契约 */
      pos.set(id, { x, y });
      return true;
    },
    playerPosition: (id) => pos.get(id) ?? null,
    /* ★★ 推进:一次调用 = **一个快帧**(不是"一秒"、不是"一个慢帧")
       ⇒ 绝不再乘 FAST_PER_SLOW(=10),那会让世界快 2 倍。 */
    advance: (frames) => { frame += frames; return frame; },
    saveToDb: () => ({ hpSaved: 0, hpSkipped: 0, memRow: false }),
    attackMobAuthorized: () => ({ ok: false, reason: 'demo 无战斗' }),
    levelOf: () => 1,
    frame: () => frame,
    tickCount: () => frame,
  };
}

/** 装配一个"有内容"的房间:两个预登记玩家 ⇒ 快照非空,差量看得出变化。 */
function makeDemoRoom(): { room: RoomRuntime; host: ReturnType<typeof makeDemoHost> } {
  const host = makeDemoHost();
  const room = new RoomRuntime({
    roomId: 'demo', ownerId: 'demo-owner', clock: fixedClock(0), maxPlayers: 8,
    passwordHash: null, worldSeed: 20261010, host: host as never,
  } as never);
  /* 预登记两个玩家,让快照里**有内容** —— 空房间的差量恒等,看不出世界在动 */
  room.join({ userId: 'alice' });
  room.join({ userId: 'bob' });
  host.addPlayer('alice', 10, 10);
  host.addPlayer('bob', 20, 12);
  return { room, host };
}

/* ═══════════════════════════ 模式二:常驻演示服务 ═══════════════════════════ */

async function serve(): Promise<void> {
  const { room, host } = makeDemoRoom();
  const srv = await startWsServer({
    port: PORT,
    room: room as never,
    frameMs: 50,
    onLog: (m) => console.log(`  [ws] ${m}`),
  });

  console.log('══ 阶段 3 端到端演示(常驻)══');
  console.log(`  WS 地址:  ws://127.0.0.1:${srv.port}/ws?userId=<任意 id>`);
  console.log(`  房间:     ${room.id} · 成员 ${room.members.size} · 在线 ${room.onlineCount()}`);
  console.log(`  推进:     ${SELF_ADVANCE
    ? '★ 本入口**自推**(--advance)—— 注意 room.step 里那条仍会推,可能双倍'
    : '由 room.step() 内 task-59 接的 host.advance(1) 推进(每帧恰好一次)'}`);
  console.log('  ⚠️ 上行带 1 字节 tag(0x01 文本 / 0x02 二进制);下行**不带**');
  console.log('  停止: Ctrl+C\n');

  /* ── ★ 推进:默认交给 room.step()(它每帧调一次 host.advance(1))──
   *
   * ```
   * 我第一版在这里起了个 50ms 定时器调 host.advance(1)
   *   ⇒ 加上 room.step() 里那次 ⇒ **每帧两次** ⇒ 世界帧号跑成两倍
   *   ⇒ 实测日志 `已推进 40 快帧 · 世界帧号 80` 抓到它。
   * ⇒ 故这里**不再自推**;`--advance` 只用于"想绕开 room 的推进"的场合。
   * ```
   * ⚠️ 计数用 host.frame() 观测 —— 那是**世界侧**的真值,不是本文件的调用次数。
   *    只数自己的调用次数**看不见**双重推进(这正是它隐蔽的原因)。 */
  const OBS_MS = 2000;
  const EXPECT_PER_OBS = OBS_MS / 50;          /* = 40,理论值 */
  let lastFrame = 0;
  const tickTimer = SELF_ADVANCE ? setInterval(() => { host.advance(1); }, 50) : null;
  /* 每 2 秒打印**世界侧**帧号 —— 这是唯一能看出"推了几次"的观测点。
   *
   * ## ⚠️ 为什么容差必须写清(否则观测器自己会误报)
   * ```
   * 期望 40 帧/2 秒(= 50ms × 40),而 `setInterval(50)` **不保证精确 50ms**:
   *   实测在回显较多的进程里会跑成 32 帧/2 秒(= 16Hz 有效)
   * ⇒ 若把"≠40"直接报成缺陷 ⇒ **观测器会常年误报**,然后被人忽略掉。
   * ⇒ 故:只有**接近两倍或一半**才算缺陷(双重推进/完全没推进),
   *   中间区间如实报为"抖动",并打印实测值让人自己判断。
   * ```
   * ★ 这一条很重要:**一个总在误报的观测器等于没有观测器**。 */
  const obsTimer = setInterval(() => {
    const f = host.frame();
    if (lastFrame === 0) { lastFrame = f; return; }
    const delta = f - lastFrame;
    lastFrame = f;
    if (delta >= EXPECT_PER_OBS * 1.5) {
      console.log(`  ★ [obs] ${OBS_MS / 1000} 秒内世界推进了 ${delta} 帧`
        + `(理论 ${EXPECT_PER_OBS})⇒ **双重推进**(快 ~${(delta / EXPECT_PER_OBS).toFixed(1)} 倍)`);
    } else if (delta <= EXPECT_PER_OBS * 0.4) {
      console.log(`  ★ [obs] ${OBS_MS / 1000} 秒内世界只推进了 ${delta} 帧`
        + `(理论 ${EXPECT_PER_OBS})⇒ 推进可能已断`);
    } else if (delta !== EXPECT_PER_OBS) {
      console.log(`  [obs] ${OBS_MS / 1000} 秒推进 ${delta} 帧(理论 ${EXPECT_PER_OBS},`
        + `setInterval 抖动,非缺陷)`);
    }
  }, OBS_MS);

  /* ── 每 4 秒制造一点变化,让差量**真有内容** ── */
  let drift = 0;
  const motionTimer = setInterval(() => {
    drift += 1;
    const x = 10 + ((drift * 3) % 30);
    const y = 10 + ((drift * 2) % 20);
    host.applyPlayerMove('alice', x, y);
    /* ★ 房间侧也要同步,否则快照里 alice 的位置不变 ——
       demo 的目的就是让人**看见**变化。真生产里这条由 applyMove 转发。 */
    const p = room.state.players.find((q) => q.id === 'alice');
    if (p) { p.x = x; p.y = y; }
    console.log(`  [sim] alice → (${x}, ${y}) · 本秒 framesSent=${srv.framesSent()}`
      + ` 末帧=${srv.lastFrameBytes()}B`);
  }, 4000);

  const shutdown = (): void => {
    console.log('\n正在关闭…');
    if (tickTimer !== null) clearInterval(tickTimer);
    clearInterval(obsTimer);
    clearInterval(motionTimer);
    void srv.close().then(() => {
      console.log(`✓ 已关闭 · 共发 ${srv.framesSent()} 帧 · 世界帧号 ${host.frame()}`);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ═══════════════════════════ 模式一:有界自检(默认)═══════════════════════════ */

/**
 * ## ⚠️⚠️ 为什么失败必须走 **stderr**(这不是噪声洁癖,是门禁正确性)
 * ```
 * 若本文件进 `PROD_ENTRIES`,门禁的「入口可加载性」会这样探它
 *   (`verify.ts:998`):
 *     import(rel).then(() => process.exit(0), (e) => ...LOAD_FAIL... )
 * ★ 它**只从 stderr 里找 `LOAD_FAIL::`**,而 `import()` 的成功分支
 *   是"立刻 exit(0)" —— 也就是说:**模块顶层抛错才算失败**。
 * ⇒ 我这种"模块顶层跑完一段自检、内部发现问题、再 `process.exit(1)`"
 *   的形态**不在那条判据的视野内**:
 *     · 探针看到的是"import() 永不 resolve 也不 reject(进程自己退了)"
 *     ⇒ 它拿到 `status=1` ⇒ **会被报成"子进程退出 1"**(那是 `entryLoadable`
 *       的第二条分支,还算能红);
 *   ⇒ ⚠️ 但**不稳**:若哪天有人把探针改成只看 `LOAD_FAIL::` 或只看 reject,
 *     这里就会**静默变绿** —— 自检失败被当成"加载成功"。
 * ⇒ 故:失败时**同时**往 stderr 写一行带 `LOAD_FAIL::` 前缀的标记。
 *   这样两种探针形态**都能判红**,不依赖对方怎么读退出码。
 * ```
 * ★ 一般化:**一个"自己知道失败"的模块,必须让自己的失败以调用方
 *   当前**或将来**能识别的方式离开** —— 只靠退出码是最脆的一种。
 */
const problems: string[] = [];
const okLine = (t: string): void => { console.log(`  ✓ ${t}`); };
const badLine = (t: string): void => { problems.push(t); console.log(`  ✗ ${t}`); };

/** 上行帧:1 字节 tag + 载荷(`session.ts` 的约定)。 */
function uplink(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

async function selfCheck(): Promise<void> {
  console.log('══ ws_demo 有界自检(默认模式)══');
  const { room, host } = makeDemoRoom();
  /* ★ 绑定 port: 0 —— 内核分配空闲端口,绝不与并发进程撞。 */
  const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });

  const got: { welcome: Record<string, unknown> | null; frames: Uint8Array[] } = {
    welcome: null, frames: [],
  };
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?userId=selfcheck`);
  ws.binaryType = 'arraybuffer';

  const done = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      const hello = new TextEncoder().encode(
        JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null }),
      );
      /* ★ 文本语义也要带 tag 0x01(上行约定),并**用 binary 发送** ——
         这正是实测发现的那个陷阱:内置 WebSocket 把 Uint8Array 发成 opcode 0x2,
         服务端**不能**靠 opcode 分流。断言:下面 must-welcome 能过就说明
         服务端确实按**载荷 tag** 分流了。 */
      ws.send(uplink(0x01, hello));
    });
    ws.addEventListener('message', (e: MessageEvent) => {
      const d: unknown = e.data;
      if (typeof d === 'string') {
        try { got.welcome = JSON.parse(d) as Record<string, unknown>; } catch { /* 非 JSON */ }
      } else if (d instanceof ArrayBuffer) {
        got.frames.push(new Uint8Array(d));
      }
    });
    ws.addEventListener('close', () => resolve());
  });

  await new Promise<void>((r) => { setTimeout(r, 700); });

  /* ── 断言 ── */
  if (got.welcome === null) {
    badLine('未收到 welcome(握手未完成 ⇒ 服务端可能按 opcode 而非载荷 tag 分流)');
  } else {
    okLine(`收到 welcome:t=${String(got.welcome.t)} playerId=${String(got.welcome.playerId)}`
      + ` protocolVersion=${String(got.welcome.protocolVersion)}`
      + ` resumed=${String(got.welcome.resumed)}`);
    if (got.welcome.protocolVersion !== PROTOCOL_VERSION) {
      badLine(`welcome.protocolVersion 应为 ${PROTOCOL_VERSION},实得 ${String(got.welcome.protocolVersion)}`);
    }
    /* ★ 稳定 id 来自 URL query —— 契约 §12.2:客户端 hello **不带** userId */
    if (got.welcome.playerId !== 'selfcheck') {
      badLine(`playerId 应取自 URL 的 userId(selfcheck),实得 ${String(got.welcome.playerId)}`
        + ' ⇒ 若随机生成,重连会造出第二个玩家');
    }
  }

  if (got.frames.length === 0) {
    badLine('未收到任何二进制帧 ⇒ 服务端一个字节都没发出去(引导期死锁形态)');
  } else {
    okLine(`收到 ${got.frames.length} 个二进制帧,末帧 ${got.frames[got.frames.length - 1]!.byteLength}B`);
    /* ★ 每个二进制帧的首字节必须是 PROTOCOL_VERSION ——
       若服务端给**下行**加了 tag,首字节会变成 0x02,这里立刻红。 */
    const badFirst = got.frames.filter((f) => f[0] !== PROTOCOL_VERSION).length;
    if (badFirst > 0) {
      badLine(`${badFirst} 个帧首字节不是 PROTOCOL_VERSION(${PROTOCOL_VERSION})`
        + ' ⇒ 下行可能被加了 tag(下行约定:**裸协议字节,无 tag**)');
    } else {
      okLine(`全部 ${got.frames.length} 帧首字节均为 PROTOCOL_VERSION(${PROTOCOL_VERSION})`
        + ' ⇒ 下行**无 tag**,与契约 §12.1 一致');
    }
  }

  /* ★ 世界侧推进观测(不数自己的调用次数 —— 那看不见双重推进) */
  const f0 = host.frame();
  await new Promise<void>((r) => { setTimeout(r, 400); });
  const advanced = host.frame() - f0;
  okLine(`400ms 内世界推进 ${advanced} 帧(room.step 内那条路径在推)`);
  if (advanced === 0) {
    badLine('世界推进为 0 ⇒ task-59 接的推进路径没生效');
  }

  okLine(`房间成员 ${room.members.size} · 在线 ${room.onlineCount()} · 服务端共发 ${srv.framesSent()} 帧`);

  try { ws.close(); } catch { /* 已关 */ }
  await Promise.race([done, new Promise<void>((r) => { setTimeout(r, 500); })]);
  await srv.close();

  console.log('');
  if (problems.length > 0) {
    console.log(`自检失败(${problems.length} 项):`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    /* ★ stderr 上带 LOAD_FAIL:: 标记 —— 让"只在 stderr 找标记"的探针也能判红。
       详见上面 `problems` 声明处的长注释。 */
    process.stderr.write(
      `LOAD_FAIL::SelfCheck | ws_demo 自检失败 ${problems.length} 项:`
      + `${problems.join(' / ').replace(/\s+/g, ' ').slice(0, 200)}\n`,
    );
    process.exit(1);
  }
  console.log('自检通过:');
  console.log('  ✓ 零依赖 WS 服务端真起、真握手、真往返');
  console.log('  ✓ 上行按**载荷 tag** 分流(不是 opcode)');
  console.log('  ✓ 下行**无 tag**,首字节为 PROTOCOL_VERSION');
  console.log('  ✓ 稳定 userId 来自 URL query ⇒ 可重连');
  console.log('  ✓ 世界推进由 room.step() 内那条路径负责(无双重推进)');
}

if (SERVE) await serve();
else await selfCheck();
