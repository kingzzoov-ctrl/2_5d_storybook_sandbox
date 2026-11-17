/**
 * WS-FND-86 · 审计 P0-1 **身份无鉴权** —— 签发 → join 校验闭环
 *
 * ## 缺陷原文(实测,不是推断)
 * ```
 * 角色只由 input.userId === this.ownerId 决定(room.ts:1264)
 * mintToken() 生成的 token 全仓 0 处校验(ws_server.ts:873 的 join 入参连 token 字段都没有)
 * ⇒ 带 ?userId=u_owner 即成房主
 * ```
 * ⇒ 缺陷不在"角色映射"那一行,而在**它左边的输入可以随便写**:`?userId=` 是客户端串。
 *
 * ## 本套件钉的是"闭环",不是"某个函数存在"
 * ```
 * 签发    room.issueJoinToken(userId, ttl)  →  v3.<载荷hex>.<签名hex>(HMAC-SHA256)
 * 传输    ws_server 从 `?token=` 取凭证,要求它必须存在(默认 requireToken = true)
 * 校验    room.join({ token, requireToken: true }) → verifyRoomToken(同一把密钥、同一份实现)
 * 判定    角色 = 按 **已认证的 userId** 与 this.ownerId(服务端声明)映射
 * 重连    走同一个 join ⇒ 同一道门(不是"第二次就免检")
 * ```
 *
 * ## 判据(7 条,右侧都写清"改坏哪里会红")
 *
 * | # | 判据 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | **无 token ⇒ 拒**:`?userId=u_owner` 没凭证 ⇒ reject 帧 + 连接被关 + 0 席位 | `join` 的认证门被删 / `requireToken` 不传到房间 |
 * | 2 | **伪造 ⇒ 拒**:自签密钥、篡改签名位 ⇒ reject(原因指认"签名不符") | 验签被跳过(`timingSafeEqual` 那一条) |
 * | 3 | **过期 ⇒ 拒**:TTL 1s,推时钟 1001ms ⇒ reject(原因指认"过期") | 过期判据被删(`nowMs >= expiresAtMs`) |
 * | 4 | **合法放行**:真 token ⇒ welcome(playerId 来自凭证)+ 二进制首帧 + 成员在册 | 认证门改成"一律拒" / join 不再回 welcome |
 * | 5 | **房主不可被 userId 冒充**:`?userId=u_owner` + u_evil 的凭证 ⇒ 拒;真房主凭证 ⇒ OWNER | `verifyRoomToken` 的 userId 绑定判据被删 |
 * | 6 | **重连沿用同一校验**:(a) 掉了的席位 + **无**凭证 ⇒ 拒;(b) **同**凭证 ⇒ `resumed: true` | 重连分支绕过认证门(把认证挪到 `existing` 之后) |
 * | 7 | **凭证与本房绑定**:同一密钥签给 room_b 的凭证在 room_a ⇒ 拒;跨房服务端用别房凭证 ⇒ 拒 | `roomId` 判据被删 / 密钥变成全局共享 |
 *
 * ## ★ 注入验证(每条判据都真的能红)
 * 每条断言都在实现里有一条**对应的可改坏点**(上表第三列),逐条改坏 → 本套件红 →
 * 用原字节写回 → SHA256 一致。不做这一步的"判据"只是注释。
 *
 * ## 为什么全部走**真 socket**(而不是直接调 `room.join`)
 * 因为缺陷就在运输层:`?userId=` 是 URL 里的。只测 `join` 会漏掉"运输层没把凭证传下去"
 * —— 而那正是 ws_server.ts:873 的原形态(`join` 入参连 token 字段都没有)。
 */

import { ok, eq, report, results } from '../shared/testing/harness.ts';
import { startWsServer, type WsServerHandle } from '../server/src/net/ws_server.ts';
import { RoomRuntime, signRoomToken, verifyRoomToken, JOIN_TOKEN_MAX_TTL_MS } from '../server/src/net/room.ts';
import { RoomRole } from '../server/src/db/repo.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

/** 异步版 `test`(`harness.test()` 不 await 传入函数 ⇒ 传 async 会**静默假绿**)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** 握手/进程内事件的时间预算(与 WS-13 / WS-FND-63 同口径:是预算,不是重试)。 */
const BUDGET_MS = 15000;

async function waitUntil(pred: () => boolean, what: string, observe?: () => unknown): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    const waited = Date.now() - started;
    if (waited >= BUDGET_MS) {
      const actual = observe === undefined ? '(无)' : (JSON.stringify(observe()) ?? '').slice(0, 600);
      throw new Error(`等待超时:${what}(等了 ${waited}ms),实际 ${actual}`);
    }
    await sleep(5);
  }
}

const ROOM_ID = 'room_auth86';
const OWNER = 'u_owner';

/** **可控时钟** —— 过期判据必须能"推时间"而不是真等(与 `fixedClock` 同一取舍)。 */
let nowMs = 1_000_000;
const clock = { nowMs: (): number => nowMs };

function makeRoom(roomId: string): RoomRuntime {
  return new RoomRuntime({
    roomId,
    ownerId: OWNER,
    clock,
    /* ★ 强制关:网络路径一律要求凭证(与 ws_server 的 `requireToken: true` 双保险)。 */
    requireJoinToken: true,
  }, null);
}

const enc = new TextEncoder();

/** 上行帧 = 1 字节 tag + 载荷(契约 §12.1:上行带 tag、下行不带)。 */
function uplinkText(obj: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

type Collected = {
  /** 收到的文本帧(`reject` / `welcome`),按到达顺序。 */
  texts: Record<string, unknown>[];
  /** 收到的二进制帧(首帧快照)。 */
  bins: Uint8Array[];
  closed: { code: number; reason: string } | null;
  err: string | null;
};

type Conn = { ws: WebSocket; got: Collected; done: Promise<void> };

/**
 * 连真服务端并发 hello。
 *
 * `userId` / `token` 都是 `string | null`:`null` 表示**URL 里不带**该参数
 * (而不是带一个空串 —— 空串会被 `readQueryParam` 归成"没给",那是另一条路径,
 *  这里要能分别构造)。
 */
function connect(srv: WsServerHandle, userId: string | null, token: string | null): Conn {
  const q: string[] = [];
  if (userId !== null) q.push(`userId=${encodeURIComponent(userId)}`);
  if (token !== null) q.push(`token=${encodeURIComponent(token)}`);
  const url = `ws://127.0.0.1:${srv.port}/ws${q.length > 0 ? `?${q.join('&')}` : ''}`;
  const got: Collected = { texts: [], bins: [], closed: null, err: null };
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const done = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      /* 与真客户端同形:`[0x01][JSON]`(session.ts:266 的做法)。 */
      ws.send(uplinkText({ t: 'hello', protocolVersion: 3, contentClaim: null }));
    });
    ws.addEventListener('message', ((ev: { data: unknown }) => {
      const d = ev.data;
      if (typeof d === 'string') { got.texts.push(JSON.parse(d) as Record<string, unknown>); return; }
      if (d instanceof ArrayBuffer) { got.bins.push(new Uint8Array(d)); return; }
      if (ArrayBuffer.isView(d)) {
        const v = d as ArrayBufferView;
        got.bins.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      }
    }) as never);
    ws.addEventListener('close', ((ev: { code: number; reason: string }) => {
      got.closed = { code: ev.code, reason: ev.reason };
      resolve();
    }) as never);
    ws.addEventListener('error', ((ev: { error?: { message?: string } }) => {
      got.err = ev.error?.message ?? 'error(无详情)';
      resolve();
    }) as never);
  });
  return { ws, got, done };
}

/** 第一条 `t === 'reject'` 的帧(没有则 undefined)。 */
function rejectOf(got: Collected): Record<string, unknown> | undefined {
  return got.texts.find((t) => t['t'] === 'reject');
}

/** 第一条 `t === 'welcome'` 的帧(没有则 undefined)。 */
function welcomeOf(got: Collected): Record<string, unknown> | undefined {
  return got.texts.find((t) => t['t'] === 'welcome');
}

async function teardown(conns: Conn[], srv: WsServerHandle): Promise<void> {
  for (const c of conns) {
    try { c.ws.close(); } catch { /* 已断 */ }
  }
  await sleep(30);
  await srv.close();
}

/* ═══════════════════ 1. 主流程 ═══════════════════ */

async function main(): Promise<void> {
  const rt = makeRoom(ROOM_ID);
  const srv = await startWsServer({ room: rt, frameMs: 100, onLog: (): void => { /* 静音 */ } });
  const otherRt = makeRoom('room_auth86_other');
  const otherSrv = await startWsServer({ room: otherRt, frameMs: 200, onLog: (): void => { /* 静音 */ } });

  /* ─────────────────────── 判据 1:无 token ⇒ 拒(负对照)─────────────────────── */
  await atest('FND86-1 无凭证:`?userId=u_owner` 被拒、连接被关、0 席位', async () => {
    /* 这条就是审计原文的复现路径:改前它会拿到 OWNER。 */
    const c = connect(srv, OWNER, null);
    await waitUntil(() => rejectOf(c.got) !== undefined || c.got.closed !== null,
      '收到 reject 或连接关闭', () => c.got);
    const rej = rejectOf(c.got);
    ok(rej !== undefined, '★ 必须回**错误帧**(不是静默断开)');
    const reason = String(rej?.['reason'] ?? '');
    ok(reason.includes('token'), `拒因必须指认"缺少 token"(实际:${reason})`);
    eq(welcomeOf(c.got), undefined, '★ 不许发出 welcome(未认证的连接连"欢迎"都不该看到)');
    await waitUntil(() => c.got.closed !== null, '连接被服务端关闭', () => c.got.closed);
    eq(c.got.closed?.code, 1008, '关闭码 = 1008(策略违规)');
    eq(rt.members.size, 0, '★ 房间席位表必须为空(未认证的连接不许占位)');
    eq(srv.connCount(), 0, 'connCount 只算已握手连接 ⇒ 必须是 0');
    /* 负对照的另一半:房主席位**不存在**,所以"是不是 OWNER"根本无从谈起。 */
    eq(rt.members.get(OWNER), undefined, '★ 房主席位不存在(旧实现这里会有一个 OWNER)');
  });

  /* ─────────────────────── 判据 2:伪造 token ⇒ 拒 ─────────────────────── */
  await atest('FND86-2 伪造凭证:自签密钥 / 篡改签名位 ⇒ 拒(原因指认签名)', async () => {
    /* (a) 结构完全合法、但密钥不对 —— 攻击者可以用导出的 `signRoomToken` 自己签一张。 */
    const forged = signRoomToken('guess-the-secret', {
      userId: OWNER, roomId: ROOM_ID, expiresAtMs: nowMs + 60_000,
    });
    const a = connect(srv, OWNER, forged);
    await waitUntil(() => rejectOf(a.got) !== undefined || a.got.closed !== null,
      '(a) 收到 reject 或关闭', () => a.got);
    const rejA = rejectOf(a.got);
    ok(rejA !== undefined, '(a) 必须回错误帧');
    ok(String(rejA?.['reason'] ?? '').includes('签名'),
      `(a) 拒因必须指认"签名不符"(实际:${String(rejA?.['reason'] ?? '')})`);

    /* (b) 真凭证 + 改掉签名里的一位十六进制 ⇒ 必须同样被拒。 */
    const real = rt.issueJoinToken(OWNER);
    const parts = real.split('.');
    const sig = parts[2]!;
    const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    const tampered = `${parts[0]!}.${parts[1]!}.${flipped}`;
    ok(tampered !== real, '前置:篡改后的串确实与真凭证不同');
    const b = connect(srv, OWNER, tampered);
    await waitUntil(() => rejectOf(b.got) !== undefined || b.got.closed !== null,
      '(b) 收到 reject 或关闭', () => b.got);
    ok(String(rejectOf(b.got)?.['reason'] ?? '').includes('签名'),
      '(b) 篡改签名(长度不变)也必须判"签名不符"');
    eq(rt.members.size, 0, '★ 两条伪造连接都不许留下席位');
  });

  /* ─────────────────────── 判据 3:过期 ⇒ 拒 ─────────────────────── */
  await atest('FND86-3 过期凭证:TTL 1s,推时钟 1001ms ⇒ 拒(原因指认过期)', async () => {
    const before = nowMs;
    const shortLived = rt.issueJoinToken(OWNER, 1000);
    /* 过期判据在**服务端时钟**上,故推房间时钟就等于"时间过去了" —— 不真等。 */
    nowMs = before + 1001;
    try {
      const c = connect(srv, OWNER, shortLived);
      await waitUntil(() => rejectOf(c.got) !== undefined || c.got.closed !== null,
        '收到 reject 或关闭', () => c.got);
      const rej = rejectOf(c.got);
      ok(rej !== undefined, '必须回错误帧');
      ok(String(rej?.['reason'] ?? '').includes('过期'),
        `拒因必须指认"过期"(实际:${String(rej?.['reason'] ?? '')})`);
      eq(rt.members.size, 0, '★ 过期凭证不许留下席位');
    } finally {
      nowMs = before;
    }
  });

  /* ─────────────────────── 判据 5:房主不可被 userId 冒充 ─────────────────────── */
  await atest('FND86-5 房主不可被 userId 冒充:u_evil 的凭证 + ?userId=u_owner ⇒ 拒', async () => {
    const evilToken = rt.issueJoinToken('u_evil');
    /* 这条是审计原文的核心:'?userId=u_owner' 本身**不再有任何效力**。 */
    const spoof = connect(srv, OWNER, evilToken);
    await waitUntil(() => rejectOf(spoof.got) !== undefined || spoof.got.closed !== null,
      '冒充请求收到 reject 或关闭', () => spoof.got);
    const rej = rejectOf(spoof.got);
    ok(rej !== undefined, '必须回错误帧');
    ok(String(rej?.['reason'] ?? '').includes('userId'),
      `拒因必须指认"与声明的 userId 不符"(实际:${String(rej?.['reason'] ?? '')})`);
    eq(rt.members.get(OWNER), undefined, '★ 冒充者没能拿到房主席位');
    eq(rt.members.size, 0, '★ 也没能拿到任何席位');

    /* 正对照:**真**房主凭证 ⇒ 放行,且角色是 OWNER。少了这一半,
       "全都拒" 也会让上面三条绿(那是"能变绿的假判据"的经典形态)。 */
    const owner = connect(srv, OWNER, rt.ownerToken);
    await waitUntil(() => welcomeOf(owner.got) !== undefined || owner.got.closed !== null,
      '房主收到 welcome 或关闭', () => owner.got);
    ok(welcomeOf(owner.got) !== undefined, '★ 房主的合法凭证必须放行');
    eq(welcomeOf(owner.got)?.['playerId'], OWNER, 'welcome.playerId = 已认证的 userId');
    const member = rt.members.get(OWNER);
    ok(member !== undefined, '房主已在册');
    eq(member?.role, RoomRole.OWNER, '★ 房主角色来自服务端判定的 ownerId(不是客户端说了算)');
    /* 冒充者用的 u_evil 从未进房 ⇒ 也没有任何"被降级成 MEMBER 的 u_owner"。 */
    eq(rt.members.get('u_evil'), undefined, 'u_evil 没有任何席位');
    await waitUntil(() => srv.connCount() === 1, 'connCount = 1', () => srv.connCount());
    /* 清理:让后续判据从"房里只有房主"这一态出发。 */
    owner.ws.close();
    await waitUntil(() => srv.connCount() === 0, '房主主动退房后 connCount = 0', () => srv.connCount());
    await waitUntil(() => rt.members.get(OWNER) === undefined, '主动退房回收席位',
      () => rt.members.size);
  });

  /* ─────────────────────── 判据 4:合法 token ⇒ 放行 ─────────────────────── */
  await atest('FND86-4 合法凭证:放行 + welcome + 二进制首帧 + 成员在册', async () => {
    const token = rt.issueJoinToken('t86');
    const c = connect(srv, 't86', token);
    await waitUntil(() => welcomeOf(c.got) !== undefined || c.got.closed !== null,
      '收到 welcome 或关闭', () => c.got);
    const w = welcomeOf(c.got);
    ok(w !== undefined, '★ 合法凭证必须被放行(否则修复就变成"谁都进不来")');
    eq(w?.['playerId'], 't86', 'playerId = 凭证里的 userId');
    eq(w?.['roomId'], ROOM_ID, 'roomId 是服务端自己的房间 id');
    eq(w?.['resumed'], false, '首次进入 ⇒ resumed = false');
    /* 首帧快照必须真的到(裸协议字节,无 tag)。 */
    await waitUntil(() => c.got.bins.length > 0, '收到二进制首帧', () => c.got.bins.length);
    ok(c.got.bins[0]!.byteLength > 0, '首帧非空');
    const member = rt.members.get('t86');
    ok(member !== undefined, '成员在册');
    eq(member?.role, RoomRole.MEMBER, '非房主 id ⇒ MEMBER(角色映射仍按 ownerId 走)');
    eq(member?.connected, true, 'connected');
    /* 留一条在线连接给判据 6 用。 */
    await waitUntil(() => srv.connCount() === 1, 'connCount = 1', () => srv.connCount());
  });

  /* ─────────────────────── 判据 6:重连沿用同一校验 ─────────────────────── */
  await atest('FND86-6 重连:掉了的席位无凭证 ⇒ 拒;同凭证 ⇒ resumed:true', async () => {
    const token = rt.issueJoinToken('t86');
    /* 异常断开(不发 close 帧)⇒ 席位保留在 30s 宽限期里。 */
    await srv.dropConnectionsForTest();
    await waitUntil(() => rt.members.get('t86')?.connected === false,
      '掉线后席位仍在、connected=false', () => rt.members.get('t86'));
    eq(rt.members.get('t86')?.role, RoomRole.MEMBER, '宽限期内角色保持');

    /* (a) **同 id、无凭证** ⇒ 必须拒:重连不是"免检通道"。 */
    const noToken = connect(srv, 't86', null);
    await waitUntil(() => rejectOf(noToken.got) !== undefined || noToken.got.closed !== null,
      '(a) 重连(无凭证)收到 reject 或关闭', () => noToken.got);
    ok(rejectOf(noToken.got) !== undefined, '(a) 必须回错误帧');
    ok(String(rejectOf(noToken.got)?.['reason'] ?? '').includes('token'),
      `(a) 拒因指认缺少 token(实际:${String(rejectOf(noToken.got)?.['reason'] ?? '')})`);
    eq(rt.members.get('t86')?.connected, false, '★ 被拒的重连**没有**把人放回在线');

    /* (b) 同一张凭证 ⇒ 走重连路径(resumed:true),角色不丢。 */
    const again = connect(srv, 't86', token);
    await waitUntil(() => welcomeOf(again.got) !== undefined || again.got.closed !== null,
      '(b) 重连(带凭证)收到 welcome 或关闭', () => again.got);
    const w = welcomeOf(again.got);
    ok(w !== undefined, '(b) 合法重连必须放行');
    eq(w?.['resumed'], true, '★ resumed = true(证明走的是重连路径,不是"新加入")');
    eq(rt.members.get('t86')?.connected, true, '成员重新在线');
    eq(rt.members.get('t86')?.role, RoomRole.MEMBER, '角色未被重置');
    /* 这条连接**保持在线**:下一条判据要读它的席位状态(主动关闭会回收席位)。 */
  });

  /* ─────────────────────── 判据 7:凭证与本房绑定 ─────────────────────── */
  await atest('FND86-7 凭证绑定房间:别房的凭证进不来(跨房重放)', async () => {
    /* (a) 纯函数层:同一把密钥,签给 room_b 的凭证在 room_a ⇒ 必须"房间不符"。 */
    const verdict = verifyRoomToken('shared-secret-for-unit', signRoomToken('shared-secret-for-unit', {
      userId: 'u1', roomId: 'room_b', expiresAtMs: 2_000_000,
    }), { userId: 'u1', roomId: 'room_a', nowMs: 1_000_000 });
    eq(verdict.ok, false, '★ 别房的凭证必须被拒(租给 room_b 的那张)');
    if (!verdict.ok) {
      ok(verdict.reason.includes('房间'), `拒因必须指认"与房间不符"(实际:${verdict.reason})`);
    }

    /* (b) 端到端:另一个房(另一把密钥)签的凭证拿到本房 ⇒ 也必须拒。 */
    const foreign = otherRt.issueJoinToken('t86');
    const c = connect(srv, 't86', foreign);
    await waitUntil(() => rejectOf(c.got) !== undefined || c.got.closed !== null,
      '(b) 跨房凭证收到 reject 或关闭', () => c.got);
    ok(rejectOf(c.got) !== undefined, '(b) 跨房凭证必须回错误帧');
    /* 两个房间的私钥不同 ⇒ 签名先不符(两层都拦,顺序由验签在前决定)。 */
    const reason = String(rejectOf(c.got)?.['reason'] ?? '');
    ok(reason.includes('签名') || reason.includes('房间'),
      `(b) 拒因必须是"签名"或"房间"(实际:${reason})`);
    eq(rt.members.get('t86')?.role, RoomRole.MEMBER, '★ 席位状态没被跨房凭证动过');
  });

  /* ─────────────────────── 附加:签发侧的两个边界 ─────────────────────── */
  await atest('FND86-8 签发边界:TTL 被钳制(不可能签出"永不过期"),token 不可跨 userId 复用', async () => {
    /* 上限:`Infinity` 不许绕过 —— 这正是"泄漏一次 = 永久身份"的入口。 */
    const inf = rt.issueJoinToken('u_ttl', Number.POSITIVE_INFINITY);
    const claimsInf = rt.verifyJoinToken('u_ttl', inf);
    ok(claimsInf.ok, 'Infinity 的 TTL 仍签出一张**合法**凭证(只是被钳制)');
    if (claimsInf.ok) {
      ok(Number.isFinite(claimsInf.claims.expiresAtMs),
        `★ 过期时刻必须是有限数(实际 ${String(claimsInf.claims.expiresAtMs)})`);
      ok(claimsInf.claims.expiresAtMs <= nowMs + JOIN_TOKEN_MAX_TTL_MS,
        `★ TTL 被钳在上限内(实际 ${claimsInf.claims.expiresAtMs - nowMs}ms > 上限 ${JOIN_TOKEN_MAX_TTL_MS}ms)`);
      ok(claimsInf.claims.expiresAtMs > nowMs, '钳制后的凭证仍然未过期(它只是"不能永不过期")');
    }
    /* 一张凭证只属于一个人:`u_ttl` 的凭证不能给 `u_other` 用。 */
    const other = rt.verifyJoinToken('u_other', inf);
    eq(other.ok, false, '★ 同一张凭证不能换个人用');
    if (!other.ok) ok(other.reason.includes('userId'), '拒因指认 userId 绑定');
  });

  await teardown([], otherSrv);
  await srv.close();
}

await main();
/* ⚠️ `report()` 必须在异步区**之后** —— 否则计数只统计"跑完的那部分"。 */
report('WS-FND-86');