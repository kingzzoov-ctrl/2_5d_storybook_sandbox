/**
 * 阶段 3 服务端另一半:**零依赖薄 WebSocket 服务端**(task-69)。
 *
 * ## 为什么手写帧协议(不引 `ws`)
 * ```
 * `ws@7.5.13` 是 `@colyseus/ws-transport` 的**传递依赖**。
 * 用它 ⇒ 「一个实现校验自己」:被测的服务端和我验证它的客户端
 * 走的是同一份帧实现 ⇒ 我的断言**证明不了**这道帧解析对不对。
 * ⇒ 故本文件零三方依赖,只用 node:http / node:crypto / node:buffer。
 * ```
 *
 * ## ★★ 本文件的中心:上行/下行的**判据相反**(契约 §12.1)
 * ```
 * 下行(服务端 → 客户端)= **裸协议字节,无 tag**
 *   实测 room.ts 三处出口全部直接返回 `.bytes`:
 *     L642  encodeFull(state, tick).bytes          ← join 时的快照
 *     L1154 step(prev) → encodeDelta(...).bytes 或 Uint8Array(0)  ← 每帧
 *     L1349 snapshotFor(userId) → encodeFull(...).bytes
 *   ⇒ **本服务端绝不给自己下发的内容加 tag。**
 *
 * 上行(客户端 → 服务端)= **[1 字节 tag][payload]**
 *   实测 session.ts L127-133:FRAME_TEXT=0x01 / FRAME_BINARY=0x02
 *   ⇒ **本服务端必须剥掉首字节**再交给 decodePacket。
 * ```
 * ## ★★★ 但分流**不能看 WS opcode**(实测踩到,不是推断)
 * ```
 * 实测:Node 24 内置 WebSocket 把 `Uint8Array` **一律发成 opcode 0x2**,
 *   哪怕它的语义是文本(session.ts:266 传的正是 Uint8Array)。
 * 我第一版把 hello 解析写在 `if (f.op === OP_TEXT)` 里
 *   ⇒ **那个分支永远进不去** ⇒ 握手永不完成
 *   ⇒ 症状:TCP 连上、帧也收到了、**房间却一个人都没有**,且不报错。
 * ⇒ 正确判据:只看**载荷 tag**(与客户端 `decodeClientFrame` 同口径)。
 * ```
 *
 * ## ⚠️ 不剥 tag 会怎样:我按契约 §12.1 复核过 —— **不会静默**
 * ```
 * 契约给的穷举:0/256 个 tag 值静默(全部抛出)
 *   tag=0x02 ⇒ 「协议版本不匹配:2」  ·  tag=0x01 ⇒ 「未知实体种类:0」
 * ⇒ 所以不剥是**一条清晰错误**,不是静默失败。
 * ⇒ 但 WS-13 仍然为它写了负向对照断言:不是因为"可能静默",
 *   而是因为**要证明这条路径真被测到了** —— 一条永远不红的断言等于没写。
 * ```
 *
 * ## ⚠️ 0 字节帧 = 「本 tick 无差量」,**不是坏包**(契约 §12.3)
 * ```
 * room.ts:1154 在 prevSnapshot 为 null 时返回 **空 Uint8Array**。
 * 而空数组交给 decodePacket 会抛(「报文截断:需要 1 字节,剩余 0」)
 * ⇒ 本服务端**跳过**发送 0 字节帧,**不重试、不补发、不当错误**。
 *   (补发会改变协议语义:客户端会把"无差量"当成"有内容")
 * ```
 *
 * ## ★★★ 两个"不报错但全错"的引导期陷阱(都在本文件里修过)
 * ```
 * ① `prevState` 若只在"发出去了"时更新 ⇒ 恒为 null
 *    ⇒ `step(null)` 恒返回空 ⇒ **一个字节都发不出去**、`framesSent` 恒 0
 *    ⇒ 修:**无条件**更新基准(见广播循环里有长注释)
 * ② 断开时若调 `leave()` ⇒ **席位立即删除** ⇒ 30s 宽限期形同不存在
 *    ⇒ 重连变全新加入 ⇒ 玩家**丢掉全部状态**而以为只是重连了一下
 *    ⇒ 修:区分主动退房(收到 0x8)与异常断开,分别 `leave` / `disconnect`
 * ```
 *
 * ## ★★★ userId 必须**跨连接稳定**(契约 §12.2)
 * ```
 * 实测:`input.token` 被读 **0** 次;真判据是 `members.get(input.userId)`
 * ★ 又实测:**客户端 hello 里没有 userId**(session.ts:260-264)
 *   ⇒ 稳定的 id 只能由**握手 URL 的 query** 携带(?userId=xxx)
 * ⇒ 本服务端**不随机生成 id**:URL 优先,退回连接序(带 `c` 前缀)
 *   并在日志里把"拿不到稳定 id"**显式说出来** —— 不许把
 *   "没有重连能力"伪装成"有"。
 * ```
 *
 * ## 职责边界(不做什么)
 * ```
 * · 不做内容协商的**服务端半**(`contentClaim` 服务端还不读 ⇒ 契约 §12.5)
 *   ⇒ 只透传,不据此拒绝(客户端阶段 3 也无从自核)
 * · 不管重连的**语义**(30s 宽限期在 room.ts)⇒ 本文件只保证"id 稳定"
 * · 不主动 ping —— 契约 §13 已如实记为未覆盖项
 * · **不 import world_sim.ts**:推进是 room.step() 的事(task-59 已接),
 *   本文件只调 step() 并广播它的返回值
 * ```
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
/* ★ 2026-11-14(task-85 分片 2):上行二进制**真解析**。
 *
 * ## 为什么**必须** import 而不是在这里自己写一份
 *
 * 本仓 WS-13 §5 的标题就是「★★ CR-20:**不造第二份口径**」。
 * 若我在运输层里手写一个解包器,那就是**第二份协议实现** ——
 * 两份必须永远一致,而它们会漂移(这正是 CR-20 要防的形态)。
 * ⇒ 用 `shared/net/delta.ts` 的 `decodePacket`:协议**只有一份实现**。
 *
 * ## ⚠️ 这与 L721 那条「刻意不 import delta.ts」的关系(必须先说清)
 *
 * L721 说的是 **`PROTOCOL_VERSION` 那个常量**:它在本文件里**仍然**是本地的。
 * 理由没变:常量重复的代价是"两个数要一致",而这一点由 WS-13 §6-1 的
 * `welcome.protocolVersion` 断言**钉住**;而**解析器**不能重复 ——
 * 它的代价是"两份实现要永远等价",没有断言能钉住那个(见上)。
 * ⇒ 常量可复制(有钉)、**逻辑不可复制**(无钉)。这不是自相矛盾,是判据不同。 */
import { decodePacket, type DecodedPacket } from '../../../shared/net/delta.ts';

/* ═══════════════════════════ 1. 帧编解码 ═══════════════════════════ */

/** WebSocket 帧 opcode(RFC 6455 §5.2)。 */
export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** 握手用的魔法串(RFC 6455 §1.3)—— 固定值,不是可配置项。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** `Sec-WebSocket-Accept` = base64(sha1(key + GUID))。 */
export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

/**
 * 生成一帧(服务端 → 客户端)。
 *
 * ## ★ 服务端**绝不掩码**(RFC 6455 §5.3)
 * ```
 * 掩码位(MASK,0x80)恒为 0。客户端收到带掩码的帧**必须**断开连接。
 * ```
 * ## 长度三形态(§5.2)—— 这就是 WS-13 的边界测试对象
 * ```
 * len ≤ 125         ⇒ 1 字节长度
 * 126 ≤ len ≤ 65535 ⇒ 126 + 2 字节大端
 * len ≥ 65536       ⇒ 127 + 8 字节大端
 * ⇒ 边界值 125 / 126 / 65535 / 65536 是**编码边界**,不是"大帧/小帧"
 * ```
 */
export function encodeFrame(op: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength;
  let headerLen: number;
  if (len <= 125) headerLen = 2;
  else if (len <= 65535) headerLen = 4;
  else headerLen = 10;

  const out = new Uint8Array(headerLen + len);
  out[0] = 0x80 | op;              /* FIN=1 + opcode */
  if (len <= 125) {
    out[1] = len;
  } else if (len <= 65535) {
    out[1] = 126;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = 127;
    /* ⚠️ 8 字节大端必须**分段写**:JS 的位运算只到 32 位,
       不能写 `len >>> 32`(那是 `>>> 0`,会得到低位)。 */
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    out[2] = (hi >>> 24) & 0xff;
    out[3] = (hi >>> 16) & 0xff;
    out[4] = (hi >>> 8) & 0xff;
    out[5] = hi & 0xff;
    out[6] = (lo >>> 24) & 0xff;
    out[7] = (lo >>> 16) & 0xff;
    out[8] = (lo >>> 8) & 0xff;
    out[9] = lo & 0xff;
  }
  out.set(payload, headerLen);
  return out;
}

/** 解析后的单帧。 */
export type ParsedFrame = {
  op: number;
  fin: boolean;
  payload: Uint8Array;
  /** 本帧在缓冲区里占用的总字节数(含头),供调用方推进游标。 */
  consumed: number;
};

/**
 * 从缓冲区**头部**尝试解析一帧;不足一帧时返回 `null`。
 *
 * ## 为什么允许 `null` 而不是抛
 * ```
 * WS 是字节流 ⇒ 一次 `data` 事件可能带来**半个帧**(TCP 不保证边界),
 * 也可能带来**两个帧**。⇒ 解析器必须"能吃多少吃多少"。
 * ⇒ 返回 consumed 让调用方推进游标;**绝不假设一 data 一帧**。
 * ```
 * ## ★ 客户端 → 服务端的帧**必须带掩码**(§5.3)
 * ```
 * 实测内置 WebSocket 客户端确实掩码。本解析器**要求**掩码位为 1 ——
 * 若为 0 说明对端不是合规 WS 客户端(或字节流错位)⇒ 显式抛错,
 * **不静默按无掩码读**(那会把帧头当载荷,产出看似合理实则垃圾的数据)。
 * ```
 */
export function parseFrame(buf: Uint8Array): ParsedFrame | null {
  if (buf.byteLength < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const op = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.byteLength < off + 2) return null;
    len = (buf[off]! << 8) | buf[off + 1]!;
    off += 2;
  } else if (len === 127) {
    if (buf.byteLength < off + 8) return null;
    /* ⚠️ 分段读:JS 位运算 32 位,不能一次读 8 字节 */
    const hi = (buf[off]! * 0x1000000) + (buf[off + 1]! << 16)
      + (buf[off + 2]! << 8) + buf[off + 3]!;
    const lo = ((buf[off + 4]! << 24) | (buf[off + 5]! << 16)
      | (buf[off + 6]! << 8) | buf[off + 7]!) >>> 0;
    len = hi * 0x100000000 + lo;
    off += 8;
    if (!Number.isSafeInteger(len)) throw new Error(`帧长超安全整数:${len}`);
  }

  if (!masked) {
    throw new Error('客户端帧未掩码(RFC 6455 §5.3 要求客户端必须掩码)');
  }
  if (buf.byteLength < off + 4) return null;
  const mask = [buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!];
  off += 4;

  if (buf.byteLength < off + len) return null;
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) payload[i] = buf[off + i]! ^ mask[i & 3]!;

  return { op, fin, payload, consumed: off + len };
}

/** close 帧的载荷:2 字节大端状态码 + 可选原因。 */
export function encodeClose(code = 1000, reason = ''): Uint8Array {
  const r = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + r.byteLength);
  out[0] = (code >>> 8) & 0xff;
  out[1] = code & 0xff;
  out.set(r, 2);
  return encodeFrame(OP_CLOSE, out);
}

/** 上行的**语义分流**结果 —— 由**载荷 tag** 决定,不由 WS opcode 决定。 */
export type UplinkKind =
  | { kind: 'text'; payload: Uint8Array }
  | { kind: 'binary'; payload: Uint8Array }
  | { kind: 'empty' };

/**
 * ★★★ 上行的**唯一**分流依据:载荷首字节的 tag。
 *
 * ## 为什么**不能**用 WS opcode(实测踩过)
 * ```
 * 客户端 `session.ts:266` 是:
 *   socket.send(encodeClientFrame(json, /*isText=*\/ true));
 *   ⇒ 传的是 **Uint8Array**(不是 string)
 * ⇒ 而 **Node 24 内置 WebSocket 把 `Uint8Array` 一律发成
 *    opcode **0x2(二进制)** 帧** —— 哪怕语义是文本!
 *   实测日志:`[srv] 上行 tag=0x1 payload=53B` ← 它落进了 OP_BINARY 分支
 * ⇒ ⇒ 我第一版把 hello 的解析写在 `if (f.op === OP_TEXT)` 里
 *    ⇒ **永远进不去** ⇒ 握手永不完成(welcome 收不到、members 为空)
 *    ⇒ 症状:TCP 连上、帧也收到了、房间却一个人都没有。
 * ```
 * ## ⇒ 正确判据:tag(与客户端 `decodeClientFrame` 同一口径)
 * ```
 * payload[0] === 0x01 ⇒ 文本(握手 JSON)
 * payload[0] === 0x02 ⇒ 二进制(协议包)
 * 其余/为空          ⇒ 交给内容特征(`{` 开头算文本)兜底
 * ```
 * ## ⚠️ 这与**下行**的处理不对称,而且是**必然**不对称
 * ```
 * 下行:客户端 `classifyDownlink` **不能**信 tag ——
 *   因为 `FRAME_TEXT(0x01)` 与 `PROTOCOL_VERSION(1)` **撞值**,
 *   而服务端下行是**裸包**(首字节就是 1)⇒ 只能靠内容特征(`{`)。
 * 上行:服务端**能且必须**信 tag ——
 *   因为上行**一定**带 tag(`encodeClientFrame` 无条件加),
 *   而 opcode 不可靠(内置客户端对 Uint8Array 一律发二进制)。
 * ⇒ 两个方向判据不同,**不是不一致,是各自的约束不同**。
 * ```
 */
export function classifyUplink(payload: Uint8Array): UplinkKind {
  if (payload.byteLength === 0) return { kind: 'empty' };
  const tag = payload[0]!;
  const body = payload.subarray(1);
  if (tag === 0x01) return { kind: 'text', payload: body };
  if (tag === 0x02) return { kind: 'binary', payload: body };
  /* 无 tag:按内容特征兜底(裸 JSON 或裸协议包) */
  if (tag === 0x7b) return { kind: 'text', payload };
  return { kind: 'binary', payload };
}

/* ═══════════════════════════ 2. 连接与会话 ═══════════════════════════ */

/** 一条已升级的 WS 连接。 */
export type WsConn = {
  /** ★ 稳定的 userId —— **不随机**,见文件头。握手后确定。 */
  userId: string | null;
  socket: Socket;
  /** 收帧游标(跨 `data` 事件保留残帧)。 */
  buf: Uint8Array;
  closed: boolean;
  /** 收到过 hello(JSON 文本帧)⇒ 才算完成协议握手。 */
  helloDone: boolean;
  /**
   * 收到过 close 帧(0x8)⇒ 视为**主动退房**。
   *
   * ★ 这一个标志决定断开时用 `leave` 还是 `disconnect`
   *   (详见 socket close 处理处的长注释:错了会让重连**永久失效**)。
   */
  closeFrameSeen: boolean;
  /** hello 里客户端声明的 userId(供重连稳定用)。 */
  declaredUserId: string | null;
  /**
   * ★★ 握手 URL 里 `?userId=` 的值 —— **实测:这是唯一能拿到稳定 id 的地方**。
   *
   * ```
   * 实测 client/src/net/session.ts:260-264,客户端发的 hello 是:
   *   { t:'hello', protocolVersion, contentClaim:null }
   *   ⇒ **没有 userId 字段**!
   * ⇒ 我原本假设能从 hello 里取 ⇒ 那条路**不存在**。
   * ⇒ 于是"稳定的 userId"必须由**连接地址**携带(?userId=xxx)。
   * ⚠️ 这不是实现细节,是**契约级**的事实:
   *   地址携带 ⇒ 客户端**能**在重连时给同一个 id ⇒ 重连可行;
   *   服务端自己派生 ⇒ 服务端**无法**判断两条连接是同一个人
   *     ⇒ 那时"重连"在裸 WS 层**做不到**,只能退化成"新加入"。
   * ⇒ 本服务端两者都支持:URL 优先,没有则退回连接序(带 `c` 前缀),
   *   并在日志里把这两种情况**区分开** —— 不许把"拿不到稳定 id"
   *   伪装成"拿到了"。
   * ```
   */
  urlUserId: string | null;
};

/** 从 `req.url`(如 `/ws?userId=alice`)取 userId;没有则 null。 */
export function readUserIdFromUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  const v = params.get('userId');
  return v !== null && v.length > 0 ? v : null;
}

export type WsServerOptions = {
  port?: number;
  /** 世界源:提供需要的方法(结构化,不 import 具体类)。 */
  room: WsRoomLike;
  /** 每帧间隔 ms(默认 50 = 20Hz,与 room.step 外部驱动对齐)。 */
  frameMs?: number;
  onLog?: (msg: string) => void;
};

/**
 * 本服务端需要的**最小房间接口** —— 结构化类型,不 import `room.ts`。
 * ⚠️ 刻意**不**出现模拟层类型名(US2 探针的同款纪律)。
 */
export type WsRoomLike = {
  readonly id: string;
  step(prevSnapshot: unknown): Uint8Array;
  snapshotFor(userId: string): Uint8Array;
  join(input: { userId: string; passwordHash?: string | null; asGuest?: boolean }): {
    ok: boolean;
    reason?: string;
    resumed?: boolean;
  };
  leave(userId: string): boolean;
  disconnect(userId: string): boolean;
  cloneState(): unknown;
};

/* ═══════════════════════════ 3. 服务端 ═══════════════════════════ */

export type WsServerHandle = {
  readonly port: number;
  /** 当前活跃连接数(供断言)。 */
  connCount(): number;
  /** 已广播的**非空**帧数(0 字节帧不计)—— 供断言区分"发过"与"没发"。 */
  framesSent(): number;
  /** 最近一次广播的字节长度(0 = 未发过)。 */
  lastFrameBytes(): number;
  /** 最近收到的上行载荷(**已剥 tag**)—— 供断言证明剥对了。 */
  lastUplink(): Uint8Array | null;
  /**
   * ★ 2026-11-14(分片 2)上行**真解析**的累计计数。
   *
   * ## 为什么必须给**计数**而不是只给"最近一次的结果"
   *
   * 本仓 build-wiring 那次缺陷的形态是「引用 ≠ 执行」:
   * 符号被 import 了、**一次都没调用**,而门禁/文本/测试**三处全绿**。
   * 只暴露 `lastUplinkDecoded()`(最近一次)会被**一次**调用伪造 ——
   * 与「帧数 > 0」可以被一次推进伪造**同形**。
   *
   * ⇒ 计数是**单调累加**的,故可以断言「随上行次数增长」:
   * ```
   *   发 1 个合法包 ⇒ parsed 从 0 变 1
   *   再发 1 个        ⇒ 变 2          ← 只断言 `> 0` 抓不到"只解了第一个"
   * ```
   * 两个计数**分开**,才能分别断言"该接的接住了"与"该拦的拦住了"
   * (本仓纪律:「不抛错」与「不放行」是两个判据)。
   */
  uplinkParsed(): number;
  /** 解析**失败**的累计次数(与 `uplinkParsed` 分开计,不合并)。 */
  uplinkRejected(): number;
  /** 最近一次成功解析出的报文(**未解析成功时为 null**)。 */
  lastParsedPacket(): DecodedPacket | null;
  /** 最近一次解析失败的原因原文(null = 没失败过)。 */
  lastParseError(): string | null;
  /**
   * 供测试:**模拟异常掉线** —— 直接 destroy 所有底层 TCP,不发 close 帧。
   *
   * ## 为什么需要它(而不是让测试用 `ws.close()`)
   * ```
   * `ws.close()` 会发 **close 帧(0x8)** ⇒ 服务端判「主动退房」⇒ `leave()`
   *   ⇒ 席位被删 ⇒ 重连拿到 `resumed:false`。
   * 而真实的重连场景是**异常断开**(掉网/杀进程/CPU 休眠)——
   *   那种情况**不发 close 帧** ⇒ 服务端应走 `disconnect()` 保留 30s 席位。
   * ⇒ 用 `close()` 测不到 `disconnect` 这条路径,而它正是重连的前提。
   * ⇒ 故开这个测试口:它对服务端而言与"客户端掉线"**不可区分**。
   * ```
   * ⚠️ 仅测试用 —— 生产不该调它(生产靠 socket 自然关闭)。
   */
  dropConnectionsForTest(): Promise<void>;
  close(): Promise<void>;
};

/**
 * 握手的 **hello** 帧 —— 客户端的 `HelloFrame` 在服务端的**镜像**(容错解析)。
 *
 * ## ★★★ 为什么用 `export interface`(而不是 `type X = {...}`)
 * ```
 * 客户端 `client/src/net/session.ts:39` 用的是 `export interface HelloFrame`。
 * 本文件第一版写成 `type HelloFrame = {...}` ⇒ **形态不一致** ⇒
 *   WS-13 §5b-1 的机械比对**抠不出服务端这一侧** ⇒ 那条断言当场红。
 * ★ 这不是风格问题:「两侧字段集一致」是本任务被点名要求的跨端断言
 *   (`judgement_baseline.ts:432`),而它**只能按固定形态解析**。
 * ⇒ 形态本身成了契约的一部分 ⇒ 两端都用 `export interface`。
 * ```
 *
 * ## ⚠️ 由此带来的真实风险(Lead 预登记时写明的,逐字在此)
 * ```
 * 「服务端镜像**全字段可选**(容错解析)⇒ 它只表达"可能出现",不表达"必需"。
 *   ⇒ 若客户端给 `hello` **加一个字段**,服务端镜像**不会**自动跟上
 *   ⇒ 那个字段被**静默丢弃** ⇒ **没有任何东西会红**」
 * ```
 * ⇒ 这条风险**已由 WS-13 §5b-1 挡住**(双向差集,多了少了都报)。
 * ⇒ 但**字段可选性**的差异仍在(服务端可选的比客户端多)——
 *   那是**有意的**(服务端必须容错:第三方客户端可能只发一半)。
 *   如实记在 WS-13-ws-server.md §10。
 *
 * ## ★★ `userId` 不在此接口里 —— 而这是**刻意的,且有实测支撑**
 * ```
 * 实测:客户端 `session.ts:260-264` 发的 hello 是
 *   { t, protocolVersion, contentClaim }  **没有 userId**
 * ⇒ 我第一版在这个镜像里加了 `userId?`,理由是"客户端将来可能发"
 *   ⇒ 而 WS-13 §5b-1 立刻报「服务端镜像**多** userId ⇒ 它以为能收到而客户端从不发」
 *   ⇒ ★ 那条断言是对的:一个**谁都不发**的字段,只会让下一个人
 *     以为"已经有这条路了"。这正是契约 §12.2 那个失败模式的镜像。
 * ⇒ 故**删掉它**,稳定的 id 只走 URL query(见 `WsConn.urlUserId`)。
 *   `onHello` 里仍会读 `hello.userId`(容错:若将来真加了就自动生效),
 *   但**类型镜像不宣称它存在** —— "能容忍"与"宣称有"是两件事。
 * ```
 *
 * ## 与客户端逐字段对照(WS-13 §5b-1 守着)
 * ```
 * t / protocolVersion / contentClaim / passwordHash? / asGuest?
 * ⇒ 两侧字段名**完全相同**;服务端把它们**全部**声明为可选。
 * ```
 */
export interface HelloFrame {
  t?: string;
  protocolVersion?: number;
  contentClaim?: unknown;
  passwordHash?: string;
  asGuest?: boolean;
}

export async function startWsServer(opts: WsServerOptions): Promise<WsServerHandle> {
  const port = opts.port ?? 0;
  const frameMs = opts.frameMs ?? 50;
  const log = opts.onLog ?? ((): void => { /* 静默 */ });
  const conns = new Set<WsConn>();
  /** 上一次广播的状态快照 —— 增量编码的基准。 */
  let prevState: unknown = null;
  let framesSent = 0;
  let lastFrameBytes = 0;
  /** 最近一次收到的**剥离 tag 后**的上行载荷(供断言:证明剥对了)。 */
  let lastUplink: Uint8Array | null = null;
  /* ★ 2026-11-14(分片 2)上行解析的**累计**计数 —— 分开计,不合并。 */
  let uplinkParsed = 0;
  let uplinkRejected = 0;
  let lastParsedPacket: DecodedPacket | null = null;
  let lastParseError: string | null = null;
  let nextConnSeq = 1;

  const write = (c: WsConn, bytes: Uint8Array): void => {
    if (c.closed || c.socket.destroyed) return;
    try { c.socket.write(bytes); } catch { c.closed = true; }
  };

  /** 下发:★ **不加 tag**(契约 §12.1)。 */
  const sendBinary = (c: WsConn, payload: Uint8Array): void => {
    if (payload.byteLength === 0) return;
    write(c, encodeFrame(OP_BINARY, payload));
  };
  const sendJson = (c: WsConn, obj: unknown): void => {
    /* ★ 下行文本发**裸 JSON**(首字节就是 `{`)。
       客户端 `classifyDownlink` 两条都支持(裸 JSON / `0x01`+JSON),
       但"下行无 tag"是本契约的原则 ⇒ 少一层转换、少一处出错点。 */
    const b = new TextEncoder().encode(JSON.stringify(obj));
    write(c, encodeFrame(OP_TEXT, b));
  };

  /* ── HTTP upgrade 握手 ── */
  const server: Server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('需要 WebSocket 升级(Upgrade: websocket)');
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length === 0) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
      + '\r\n',
    );
    const conn: WsConn = {
      userId: null, socket, buf: new Uint8Array(0), closed: false,
      helloDone: false, closeFrameSeen: false, declaredUserId: null,
      /* ★★ userId 从**握手 URL 的 query** 取 —— 实测客户端 hello 里**没有**它。
         见 `WsConn.urlUserId` 的说明。 */
      urlUserId: readUserIdFromUrl(req.url),
    };
    conns.add(conn);
    log(`upgrade ok,conns=${conns.size}${conn.urlUserId ? `,urlUserId=${conn.urlUserId}` : ''}`);

    socket.on('data', (chunk: Buffer) => {
      /* ★ 追加到残帧缓冲区 —— **不假设一 data 一帧**(见 parseFrame) */
      const merged = new Uint8Array(conn.buf.byteLength + chunk.byteLength);
      merged.set(conn.buf, 0);
      merged.set(new Uint8Array(chunk), conn.buf.byteLength);
      conn.buf = merged;

      for (;;) {
        let f: ParsedFrame | null;
        try { f = parseFrame(conn.buf); } catch (e) {
          log(`帧解析失败:${(e as Error).message}`);
          write(conn, encodeClose(1002, 'protocol error'));
          try { socket.destroy(); } catch { /* 已断 */ }
          return;
        }
        if (f === null) break;
        conn.buf = conn.buf.subarray(f.consumed);
        handleFrame(conn, f);
        if (conn.closed) return;
      }
    });

    socket.on('error', () => { conn.closed = true; conns.delete(conn); });
    socket.on('close', () => {
      conn.closed = true;
      conns.delete(conn);
      if (conn.userId !== null) {
        /* ★★★ 断开用 `disconnect`、**不是** `leave` —— 这一个词决定重连能不能用。
         *
         * ## 我第一版写错的后果(实测抓到)
         * ```
         * 第一版:socket 一关就 `room.leave(userId)`
         * ⇒ `leave()` **直接删掉席位**(room.ts:676)
         * ⇒ 宽限期**根本没机会生效** ⇒ 重连只能是「全新加入」
         * ⇒ 实测:`resumed` 恒为 **false**
         * ⇒ 玩家丢掉全部状态(角色/等级/位置),而他自己以为只是重连了一下。
         * ```
         * ## 正确语义:区分「主动退房」与「异常断开」
         * ```
         * 收到 close 帧(客户端说"我要走")⇒ `leave()`    席位立即回收
         * 连接异常断开(TCP 断了)        ⇒ `disconnect()` 保留席位 30s
         * ⇒ 参考实现同款:`room.colyseus.ts:150-152`
         *     if (consented) this.runtime.leave(...)
         *     else            this.runtime.disconnect(...)
         * ```
         * ⇒ 本服务端用 `conn.closeFrameSeen` 区分(收到 0x8 ⇒ 视为主动)。 */
        try {
          if (conn.closeFrameSeen) opts.room.leave(conn.userId);
          else opts.room.disconnect(conn.userId);
        } catch { /* 宽容:断开路径不该因房间抛错而中断 */ }
      }
      log(`close userId=${conn.userId ?? '(未握手)'}`
        + ` ${conn.closeFrameSeen ? '主动' : '异常'} conns=${conns.size}`);
    });
  });

  function handleFrame(c: WsConn, f: ParsedFrame): void {
    if (f.op === OP_CLOSE) {
      c.closeFrameSeen = true;
      write(c, encodeClose(1000, 'bye'));
      c.closed = true;
      try { c.socket.end(); } catch { /* 已断 */ }
      return;
    }
    if (f.op === OP_PING) { write(c, encodeFrame(OP_PONG, f.payload)); return; }
    if (f.op === OP_PONG) return;

    /* ── ★★★ 上行分流:**只看载荷 tag**,不看 opcode ──
       (实测:内置客户端把 Uint8Array 一律发成 opcode 0x2,哪怕语义是文本
        ⇒ 若按 `f.op === OP_TEXT` 找 hello ⇒ **永远进不去** ⇒ 握手永不完成。
        完整理由见 `classifyUplink`。)
       ⚠️ 故 OP_TEXT 与 OP_BINARY 走**同一个**分流函数。 */
    if (f.op === OP_TEXT || f.op === OP_BINARY) {
      const u = classifyUplink(f.payload);
      if (u.kind === 'empty') {
        log('忽略空载荷上行(无 tag、无内容)');
        return;
      }
      if (u.kind === 'text') {
        let hello: HelloFrame;
        try { hello = JSON.parse(new TextDecoder().decode(u.payload)) as HelloFrame; }
        catch {
          write(c, encodeClose(1003, '文本上行不是合法 JSON'));
          c.closed = true;
          return;
        }
        onHello(c, hello);
        return;
      }
      /* ★★★ 2026-11-14(task-85 分片 2):上行二进制 ⇒ **真解析**(原为"只记录不解析")
       *
       * ## 改前是什么
       * ```
       * log(`上行协议包 payload=${u.payload.byteLength}B`);
       * lastUplink = u.payload;
       * ```
       * ⇒ 字节收下了、**没人看内容** ⇒ 客户端发来一个**完全损坏**的包,
       *   服务端照样记一笔日志、`lastUplink()` 照样非空、**不报任何错**。
       *
       * ## 判据(两个,分开)
       * ```
       *   1 解析**成功** ⇒ uplinkParsed 累加,并留下 lastParsedPacket
       *   2 解析**失败** ⇒ uplinkRejected 累加 + 记下原因 + 打日志 ⇒ **不静默**
       * ```
       * ★ 「不抛错」与「不放行」是两个判据 ⇒ 两个计数**分开**,
       *   不能合并成一个 `handled`(合并后无法断言"该拦的拦住了")。
       *
       * ## ⚠️ 一个真实陷阱:「没抛」≠「解析对了」(我实测到的)
       * ```
       * new Uint8Array(70000) 首字节置 1 ⇒ decodePacket **不抛**,
       *   返回 { op:0, tick:0, removed:0, upserts:0, bytesConsumed:10 }
       * ⇒ 69990 字节是**尾部垃圾**,而它被算成"解析成功"。
       * ```
       * ⇒ 故本实现要求**恰好消耗完**才算成功:
       *   `bytesConsumed === byteLength`。有剩余 ⇒ 记为失败(理由写明剩余字节数)。
       * ⇒ 这样"成功计数"不会被垃圾包灌水 ——
       *   否则我自己的 `uplinkParsed` 就是又一个"能变绿的假判据"。 */
      /* ⚠️ `lastUplink` 仍然无条件记录 —— 它的语义是"最近收到的、已剥 tag 的原始载荷",
         与"能不能解析"**无关**。WS-13 §6-5 用 70000 字节的**非协议**载荷测它
         (那条断言的前提正是"大帧能整到达",不是"大帧能被解析")
         ⇒ 若把它的赋值挪进"解析成功"分支,那条断言会因**无关的改动**而红。 */
      lastUplink = u.payload;
      try {
        const pkt = decodePacket(u.payload);
        if (pkt.bytesConsumed !== u.payload.byteLength) {
          uplinkRejected += 1;
          lastParseError = `报文尾部有 ${u.payload.byteLength - pkt.bytesConsumed} 字节未消耗`
            + `(解出 ${pkt.bytesConsumed}/${u.payload.byteLength}B)`;
          log(`上行协议包解析失败:${lastParseError}`);
          return;
        }
        uplinkParsed += 1;
        lastParsedPacket = pkt;
        lastParseError = null;
        log(`上行协议包已解析 op=${pkt.op} tick=${pkt.tick}`
          + ` removed=${pkt.removed.length} upserts=${pkt.upserts.length}`
          + ` ${pkt.bytesConsumed}B`);
      } catch (e) {
        /* ★ 解析失败**不静默**,也**不断连**:
         *   运输层对畸形载荷的纪律与其它路径一致(本文件多处用「宽容」catch)——
         *   一个坏包只该丢它自己,不该杀掉连接。
         *   ⚠️ 但"宽容"不等于"假装没发生" ⇒ 计数 + 原因 + 日志三样都要留。 */
        uplinkRejected += 1;
        lastParseError = e instanceof Error ? e.message : String(e);
        log(`上行协议包解析失败:${lastParseError}`);
      }
      return;
    }
    /* 未识别的 opcode(如 continuation 0x0):不静默丢 —— 记为一条日志。
       (本服务端不解分片;契约 §13 已记为未覆盖项。) */
    log(`忽略未识别的 opcode=0x${f.op.toString(16)}`);
  }

  function onHello(c: WsConn, hello: HelloFrame): void {
    /* ★★★ userId 跨连接稳定:两个来源,按**稳定性**排序(契约 §12.2)。
       ⚠️ **绝不随机** —— 随机会让重连变成「同一玩家出现两个」,且不报错。 */
    const fromHello = typeof hello.userId === 'string' && hello.userId.length > 0
      ? hello.userId : null;
    const declared = fromHello ?? c.urlUserId;
    const userId = declared ?? `c${nextConnSeq++}`;
    if (declared === null) {
      /* ⚠️ 拿不到稳定 id ⇒ 重连在裸 WS 层**做不到**。
         不许静默:`log` 出来让操作者知道这条连接没有重连能力。 */
      log(`⚠️ 无稳定 userId(hello 与 URL 都没有)⇒ 退化为 ${userId},该连接**无法重连**`);
    }
    c.userId = userId;
    c.declaredUserId = declared;
    const res = opts.room.join({
      userId,
      passwordHash: hello.passwordHash ?? null,
      asGuest: hello.asGuest === true,
    });
    if (!res.ok) {
      sendJson(c, { t: 'reject', reason: res.reason ?? 'join 失败' });
      write(c, encodeClose(1008, res.reason ?? 'join 失败'));
      c.closed = true;
      return;
    }
    c.helloDone = true;
    /* welcome:字段与客户端 WelcomeFrame 对齐(契约 §12.4) */
    sendJson(c, {
      t: 'welcome',
      playerId: userId,
      roomId: opts.room.id,
      protocolVersion: PROTOCOL_VERSION,
      /* ⚠️ 服务端指纹:阶段 3 的对应物是"只发不校验"。
         契约 §12.5:服务端当前不读客户端的 contentClaim ⇒ 这里给一个
         占位串,**不声称**它是真校验过的。 */
      contentClaim: 'v1-unverified',
      resumed: res.resumed === true,
    });
    /* 首次快照:用 room 的 encodeFull 出口 ⇒ **裸字节**(契约 §12.1) */
    sendBinary(c, opts.room.snapshotFor(userId));
  }

  /* ── 20Hz 广播循环 ── */
  const timer = setInterval(() => {
    let payload: Uint8Array;
    try {
      payload = opts.room.step(prevState);
    } catch (e) {
      log(`step 抛错:${(e as Error).message}`);
      return;
    }
    if (payload.byteLength > 0) {
      for (const c of conns) {
        if (c.helloDone && !c.closed) sendBinary(c, payload);
      }
      framesSent += 1;
      lastFrameBytes = payload.byteLength;
    }
    /* ★★★ 基准快照**无条件**更新 —— 这一行是引导期的关键。
     *
     * ## 我第一版写错的地方(实测复盘)
     * ```
     * 第一版:只在上面的 `if (payload.byteLength > 0)` **里面**更新 prevState。
     * ⇒ 第一次 step(null) 必然返回**空**(`prevSnapshot === null` ⇒ 空 Uint8Array)
     * ⇒ 那个分支进不去 ⇒ prevState **永远是 null**
     * ⇒ 此后每一帧都走 step(null) ⇒ **永远返回空** ⇒ `framesSent` 恒 0
     * ⇒ 症状:连接成功、welcome 收到、房间有人 —— **但世界一个字节都收不到**,
     *   而且**不报任何错**(服务端认为"本 tick 无差量")。
     * ```
     * ## 为什么必须无条件
     * ```
     * `step(prev)` 的语义是「相对 prev 的差量」。第一帧 prev=null 时它
     * **故意**返回空(见 room.ts:1154)—— 那不是"编码失败",是"还没有基准"。
     * ⇒ 所以基准的推进**与"这帧发不发得出去"无关**:
     *   哪怕本帧没发给任何人,基准也必须走到当前世界,
     *   否则下一帧算出的差量会是"从创世到现在的全部差异"(量级错误)。
     * ⇒ 参考实现同款(`room.colyseus.ts:162` 无条件 cloneState)。
     * ```
     * ## ⚠️ 顺序:必须在 `step()` **之后** clone
     * ```
     * 若在 step() 之前 clone ⇒ 基准 = 上一帧的世界,而 step 已经推进过它
     * ⇒ 差量会比实际少一帧的位移(客户端位置**永久滞后一帧**)。
     * 这类错误不报错,只是慢一点。
     * ``` */
    try { prevState = opts.room.cloneState(); } catch { prevState = null; }
    /* ★ 0 字节 ⇒ 上面整段跳过(契约 §12.3):
       不重试、不补发 —— 那会改变协议语义。 */
  }, frameMs);
  if (typeof timer.unref === 'function') timer.unref();

  await new Promise<void>((resolve) => { server.listen(port, resolve); });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  return {
    port: actualPort,
    connCount: (): number => [...conns].filter((c) => c.helloDone && !c.closed).length,
    framesSent: (): number => framesSent,
    lastFrameBytes: (): number => lastFrameBytes,
    lastUplink: (): Uint8Array | null => lastUplink,
    /* ★ 2026-11-14(分片 2)上行解析的累计计数 + 最近结果。
       两个计数**分开** ⇒ 可分别断言"该接的接住了 / 该拦的拦住了"。 */
    uplinkParsed: (): number => uplinkParsed,
    uplinkRejected: (): number => uplinkRejected,
    lastParsedPacket: (): DecodedPacket | null => lastParsedPacket,
    lastParseError: (): string | null => lastParseError,
    /* ★ 模拟异常掉线:destroy 底层 socket(**不发 close 帧**)。
       服务端侧看到的与"客户端掉网"完全一致 ⇒ 走 `disconnect` 分支。 */
    dropConnectionsForTest: async (): Promise<void> => {
      for (const c of [...conns]) {
        try { c.socket.destroy(); } catch { /* 已断 */ }
      }
      /* 等 socket 'close' 事件跑完(它是异步的) */
      await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
    },
    close: async (): Promise<void> => {
      clearInterval(timer);
      for (const c of conns) {
        write(c, encodeClose(1001, 'server shutdown'));
        try { c.socket.destroy(); } catch { /* 已断 */ }
      }
      conns.clear();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}

/** 协议版本 —— 与 shared/net/delta.ts 的 PROTOCOL_VERSION 同值。
 *  ⚠️ 这个**常量**刻意不 import delta.ts:常量重复的代价是"两个数要一致",
 *     而它由 WS-13 §6-1 的 `welcome.protocolVersion` 断言钉住。
 *  ★ 2026-11-14(分片 2)订正:上一句原写「本服务端是运输层,不该依赖协议内容」——
 *     那个理由**只对常量成立,对解析器不成立**。运输层现在**确实** import 了
 *     `decodePacket`(见文件头 import 处的长注释):
 *     常量可复制(有断言钉住一致性),**解析逻辑不可复制**(没有任何断言能钉住
 *     "两份实现永远等价")。WS-13 §5「不造第二份口径」正是这条纪律的出处。 */
export const PROTOCOL_VERSION = 1;
