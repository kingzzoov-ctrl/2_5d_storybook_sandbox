/**
 * WS-FND-21 —— **动作通道的端到端**(真 socket + 真客户端模块 + 真房间)。
 *
 * ## 与既有两个 e2e 的分工
 *
 * ```
 * WS-FND-13  裸 WebSocket 测**服务端**一侧(帧可解码、世界帧单调增长)
 * WS-FND-15  真客户端模块测**握手/快照/圆心**那一半
 * WS-FND-21  真客户端模块测**动作上行**:发 → 服务端执行 → 回执 → 世界变了
 * ```
 *
 * ## 为什么必须端到端,而不是各自单测
 *
 * `TASK-96` 那 17 个动作"没有执行层"时,**每一段单看都正常**:
 * 房间有 `dispatchAction`、动作名在新层能解析、客户端也有 `send` 通道。
 * 缺的是**中间那根线**。⇒ 本套件每条断言都要求三处同时成立:
 *
 * ```
 * 1 客户端能发出去            sendAction ⇒ true
 * 2 服务端真的执行了          世界里的那一格真的变了(不是"回了 OK")
 * 3 客户端真的收到了分类回执   ok / kind / reason 逐字段
 * ```
 *
 * ## 逐条的注入靶子
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 发 → 执行 → 回执 + 世界变了 | 删掉 `ws_server` 的 `t:'action'` 分支 |
 * | 2 | 越权 → `PERMISSION`(不是沉默) | 去掉 `dispatchAction` 里的 `authorize` |
 * | 3 | 未知动作名 → `NOT_IMPLEMENTED` + 理由 | `default:` 分支改成回 OK |
 * | 4 | 缺 `action` 名 → `INVALID` 回执 | 空名字改成直接 return(不回执) |
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';

import { assemble } from '../server/src/index.ts';
import { startWsServer } from '../server/src/net/ws_server.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import { createSession, type ActionIntent, type ActionResultFrame } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/** 异步版 `test`(理由同 WS-FND-13/15:同步 `test()` 不 await ⇒ 断言没跑完就报绿)。 */
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

/** 测试里用的建材 id:`101 暖松原木`。 */
const LOG = 101;

type MatLike = {
  blockAt(x: number, y: number): number;
  placeBlock(x: number, y: number, objId: number): { ok: boolean; reason?: string };
};

/**
 * 起一个**真服务端**(`startWsServer` + `assemble` 造的**生产世界**),
 * 用**真客户端模块**连上去,并把动作回执收进 `box`。
 *
 * ⚠️ 房间里 `mobs: false`:本套件测动作通道,不想让自发改刷的怪参与
 *   (`WS-FND-20` 已经单独测过生物那一侧)。
 */
async function wire(roomId: string, userId: string) {
  const a = assemble({
    roomId, ownerId: 'u_owner', clock: fixedClock(0),
    sizeCells: 64, mobs: false,
  });
  const mat = (a.host as unknown as { materials(): MatLike }).materials();
  const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20 });
  const store = new ClientStateStore();
  const box: { reply: ActionResultFrame | null } = { reply: null };
  const session = createSession({
    /* ★ 2026-11-17:鉴权上线 —— `?userId=` 只是**声明**,`?token=`(HMAC 凭证)才是证据。
       token 由**生产的签发入口** `runtime.issueJoinToken` 现签(与 `join` 里验签的
       同一把密钥),不硬编码、也不跳过鉴权。 */
    url: `ws://127.0.0.1:${srv.port}/ws?userId=${encodeURIComponent(userId)}`
      + `&token=${encodeURIComponent(a.runtime.issueJoinToken(userId))}`,
    store,
    events: {
      onFrame: () => undefined,
      onActionResult: (r) => { box.reply = r; },
    },
  });
  /* 等握手完成:**早于 hello 的动作意图会被服务端丢弃**(设计如此,见 onAction)——
     所以每条断言都必须先等到 live,否则测到的是"被丢弃"而不是"被执行"。 */
  for (let i = 0; i < 120 && session.state !== 'live'; i += 1) await sleep(25);
  return {
    a, mat, session, box,
    close: async () => {
      try { session.close(); } catch { /* 已关 */ }
      await srv.close();
    },
  };
}

/** 发一条动作并等它的回执。 */
async function act(
  w: Awaited<ReturnType<typeof wire>>, msg: ActionIntent & Record<string, unknown>,
): Promise<ActionResultFrame> {
  w.box.reply = null;
  const sent = w.session.sendAction(msg);
  eq(sent, true, 'live 状态下 sendAction 应返回 true(返回 false 说明连接已不 OPEN)');
  for (let i = 0; i < 80 && w.box.reply === null; i += 1) await sleep(25);
  const r = w.box.reply;
  /* 用 `throw` 而不是 `ok(...)`:这里既要做断言、又要把类型收窄成非 null。
     `ok()` 不返回/不收窄 ⇒ 下面 `return r` 会退化成需要 `as unknown as` 的写法。 */
  if (r === null) {
    throw new Error(`★ 必须收到 actionResult 回执(动作 ${String(msg.action)}),`
      + '否则客户端分不清「被拒」与「服务器没听见」');
  }
  return r;
}

/* ═══════════════════ 1. 主段(异步)═══════════════════ */

async function main(): Promise<void> {
  /* ── FND21-1 ★★ 主判据:发 → 执行 → 回执 + 世界真的变了 ── */
  await atest('FND21-1 ★★ 动作端到端:真客户端发 → 服务端执行 → 回执 + 世界变了', async () => {
    /* 变红条件(逐个):
       · `ws_server` 少了 `t:'action'` 分支 ⇒ 没有回执 ⇒ 超时红;
       · `RoomRuntime.dispatchAction` 少了 BREAK_BLOCK 分支 ⇒ 回 NOT_IMPLEMENTED;
       · 客户端的 `encodeActionUplink` 把类型头写错(如 `{t:'action', ...intent}`)⇒
         服务端按别的报文处理 ⇒ 没有回执;
       · 只回执不执行(把 `breakBlock` 去掉)⇒ `blockAt` 仍是 101 ⇒ 红。 */
    const w = await wire('r21a', 'mat');
    try {
      /* 先在世界里放一个块 —— 用**生产方法**,不手搓网格。 */
      const placed = w.mat.placeBlock(12, 12, LOG);
      ok(placed.ok, `前置:世界里应能放下一个块(${placed.reason ?? ''})`);
      eq(w.mat.blockAt(12, 12), LOG, '前置:块真的在那儿');

      const r = await act(w, { action: 'BREAK_BLOCK', x: 12, y: 12 });
      eq(r.action, 'BREAK_BLOCK', '★ 回执要能对上号(一个连接可能连发多个动作)');
      eq(r.ok, true, `破坏应成功(reason=${r.reason ?? '-'})`);
      eq(r.kind, 'OK', '成功路径必须是 OK');
      eq(w.mat.blockAt(12, 12), 0, '★ **世界真的变了** —— 只收回执不算数');
    } finally { await w.close(); }
  });

  /* ── FND21-2 越权:一路传到回执的分类上 ── */
  await atest('FND21-2 越权:MEMBER 改城镇 ⇒ 回执是 PERMISSION(不是沉默、不是 INVALID)', async () => {
    /* `MODIFY_TOWN` 要 `town` 权限,而 hello 进来的玩家是 MEMBER ⇒ 必被拦。
       ★ 断言的是**分类**:PERMISSION 与 INVALID 的区别就是"你没权"与
         "这事本身不成"—— 客户端要给玩家的提示完全不同。 */
    const w = await wire('r21b', 'mat');
    try {
      /* ⚠️ 用 `SET_ROOM_ACCESS`(权限位 `configure`)而**不是** `MODIFY_TOWN`:
`MOVE` / `ATTACK` **刻意**不走 `action` 通道(见 `docs/TASK-96` 第一节),它们回
NOT_IMPLEMENTED —— 那样测到的是"没实现",而不是"没权限"。
         本条的命题是**权限分类**,所以必须挑一个**已接线且需要更高权限**的动作
         (并且要带一个合法的 mode:参数不全会先回 INVALID,走不到闸)。 */
      const r = await act(w, { action: 'SET_ROOM_ACCESS', mode: 'PUBLIC' });
      eq(r.ok, false, '越权不能成功');
      eq(r.kind, 'PERMISSION', '★ 必须归类为 PERMISSION');
      ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须带原因');
    } finally { await w.close(); }
  });

  /* ── FND21-3 未知动作名也要回执 ── */
  await atest('FND21-3 未知动作名 ⇒ NOT_IMPLEMENTED + 理由(不沉默)', async () => {
    /* 这条守的是 `TASK-96` 那条纪律在网络层的兑现:
       "没有执行层"必须**说出来**,而不是让客户端等到超时。 */
    const w = await wire('r21c', 'mat');
    try {
      const r = await act(w, { action: 'NO_SUCH_ACTION_NAME' });
      eq(r.ok, false, '不存在的动作不能成功');
      eq(r.kind, 'NOT_IMPLEMENTED', '★ 应是 NOT_IMPLEMENTED(房间里 default 分支的产物)');
      ok(typeof r.reason === 'string' && r.reason.length > 0, '必须说明"尚无执行层"');
      /* ★ 再补一条:**已知动作名、但没有执行层**的也必须显式说出来。
         与"未知名字"分开记:前者是"我们还没做",后者是"没有这个东西"。 */
    const known = await act(w, { action: 'MOVE' });
      eq(known.ok, false, '未接线的已知动作不能成功');
      eq(known.kind, 'NOT_IMPLEMENTED', '★ 已知但未接线也应显式 NOT_IMPLEMENTED');
      ok(typeof known.reason === 'string' && known.reason.length > 0, '同上:必须带理由');
    } finally { await w.close(); }
  });

  /* ── FND21-4 缺动作名 ⇒ 显式 INVALID 回执 ── */
  await atest('FND21-4 缺 action 名 ⇒ INVALID 回执(而不是静默丢弃)', async () => {
    const w = await wire('r21d', 'mat');
    try {
      const r = await act(w, { action: '' });
      eq(r.ok, false, '空动作名不能成功');
      eq(r.kind, 'INVALID', '★ 应是 INVALID');
      ok(typeof r.reason === 'string' && r.reason.length > 0, '必须说明缺什么');
    } finally { await w.close(); }
  });

  /* ── FND21-5 世界里的块被拆后,**同一格**可以再放(权威一致性的最小往返) ── */
  await atest('FND21-5 端到端往返:拆掉之后同一格的状态在服务端权威里真的清了', async () => {
    /* 为什么再测一遍(而不是与 FND21-1 合并):FND21-1 断的是"变了",
       这一条断的是"**变了之后还能再变**" —— 若 `breakBlock` 只改快照不改网格,
       第二次放置会被判"该格已有物件"而失败,这里就红。 */
    const w = await wire('r21e', 'mat');
    try {
      ok(w.mat.placeBlock(20, 20, LOG).ok, '前置:放下第一个块');
      const r1 = await act(w, { action: 'BREAK_BLOCK', x: 20, y: 20 });
      eq(r1.kind, 'OK', '第一次拆除应成功');
      const r2 = await act(w, { action: 'BREAK_BLOCK', x: 20, y: 20 });
      eq(r2.ok, false, '同一格再拆应失败(它已经是空的)');
      eq(r2.kind, 'INVALID', '★ 分类应是 INVALID(状态不对),不是 PERMISSION');
    } finally { await w.close(); }
  });
}

await main();
/* ⚠️ `report()` 必须在异步区**之后** —— 否则异步断言还没跑完就打完计数了。 */
report('WS-FND-21-action-e2e');
