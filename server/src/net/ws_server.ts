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
import {
  MAX_ACKED_SEQ,
  ackSlotValue,
  decodePacket,
  isValidAckedSeq,
  type DecodedPacket,
} from '../../../shared/net/delta.ts';

/* ═══════════════════════════ 1. 帧编解码 ═══════════════════════════ */

/** WebSocket 帧 opcode(RFC 6455 §5.2)。 */
export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/* ═══════════ ★★★ WS-FND-132(P1):WS 层的**帧大小上界** ═══════════
 *
 * ## 修前的洞(第八轮实测)
 * ```ts
 * // parseFrame 里**只有**「数据够不够」这一条判据:
 * if (buf.byteLength < off + len) return null;   // ← 对端不补满 ⇒ 恒 null
 * ```
 * 对端只要在长度域里宣告 `len = 2^40`(它是 `Number.isSafeInteger` 认可的值),
 * 然后**一个字节都不补**:
 * ```text
 * · parseFrame **恒返回 null** ⇒ 调用方的 `for(;;)` 立刻 break;
 * · conn.buf **永不消费** ⇒ 每个 data 事件都为它做一次「整份旧缓冲 + 新块」
 *   的 Uint8Array 重拷 ⇒ **O(n^2)**;
 * · 内存与 CPU **都没有上界**,而**没有任何东西会红**
 *   —— `shared/net/delta.ts` 的三道(MAX_STR_BYTES / need() / 计数越界)
 *   全在**载荷层**,而这里连一个载荷字节都还没解出来。
 * ```
 * 控制帧同病:§5.5 要求 ≤ 125 字节,修前**一条判据都没有**。
 *
 * ## 口径:**在读到长度域的那一刻**判上界,不等"补满"
 * ```text
 * 非控制帧  len > MAX_FRAME_BYTES          ⇒ FrameTooBigError ⇒ 关连接 + 记账
 * 控制帧    len > MAX_CONTROL_FRAME_BYTES  ⇒ 同上(§5.5 的 125)
 * 残帧缓冲  isBufOverflow(conn.buf.length) ⇒ 关连接 + 记账
 * ```
 * ★ 为什么必须"读到就判"、而不是"等数据够了再判":后者**不可能成立** ——
 *   攻击者的全部手法就是**永远不够**。上界晚一步,它就形同不存在。
 *   判据:`tests/WS-FND-132-protocol-bounds.test.ts` 的 FND132-1..4。
 */
/** 单帧**载荷**上界(字节)。1 MiB 远高于任何真实报文(稳态帧 ~40B;
 *  `tests/WS-13` 那条 70000 字节的压测大帧也过得了)。 */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** 控制帧载荷上界:RFC 6455 §5.5 —— 控制帧 ≤ 125 字节且**不可分片**。 */
export const MAX_CONTROL_FRAME_BYTES = 125;
/** 单帧头的最大字节数:2B 基础头 + 8B 扩展长度 + 4B 掩码键 = 14。 */
export const MAX_FRAME_HEADER_BYTES = 14;
/**
 * 单连接**残帧缓冲**上界 = 一个尚未补满的帧的理论最大值(头 + 上界长度的载荷)。
 *
 * ⚠️ 如实记:在 `parseFrame` 的上界正确的前提下,这条门**构造不出来**
 *   (不完整的帧必然 `已收 < 14 + MAX_FRAME_BYTES`:要么帧完成被消费,
 *    要么宣告的长度本身就超界并当场抛)。
 *   ⇒ 它是**两个机制共同的断言**,不是"第二道防线"。
 *   故它只做两件事:(1) 帧上界万一被改坏时**当场出声**;
 *   (2) 把"`conn.buf` 有上界"写成一个**可断言**的量(`isBufOverflow`)——
 *      否则这件事只有"读代码"一条判据。
 */
export const MAX_CONN_BUF_BYTES = MAX_FRAME_HEADER_BYTES + MAX_FRAME_BYTES;

/* ═══════ ★ WS-FND-161:连接侧四项(待握手 / 写背压 / 席位)的上界与阈值 ═══════
 *
 * ## 修前的实测形态(每个常量对应其中一条)
 * ```text
 * 1 `conns.add(conn)` 只认「升级成功」,**没有任何上界**:一条 TCP 连上来、
 *   做完 Upgrade 就沉默 ⇒ 它占一个 Set 槽 + 一个 socket,**永不超时**。
 *   攻击成本 = 一个 TCP 连接(不需要任何协议知识)⇒ 内存/句柄无上界。
 * 2 `c.socket.write(bytes)` 的**返回值被丢弃** ⇒ 慢客户端没有背压信号:
 *   帧照旧进 Node 的发送队列,而「发不出去」这件事在服务端**不可观测**,
 *   直到内存或延迟把它暴露出来(那时已经晚了)。
 * 3 广播只看 `c.helloDone && !c.closed`:席位被房间收走(`kick` ⇒ `leave`)
 *   的连接**仍在广播集里** ⇒ 被踢者继续收全房 delta。
 * 4 于是「广播集」既无成员判据(3)也无上界(1/2)⇒ 有界性只能靠人手推。
 * ```
 */
/**
 * **已升级但还没 hello** 的连接数上界。
 *
 * 为什么在**升级之前**判:101 一发出,对方就已经占到 socket 与 Set 槽;
 * 事后再关,也要先把它收下(见 `HELLO_TIMEOUT_MS` 那条路径的补刀)。
 * ⇒ 两道,**互不替代**:入口闸(这个常量)+ 时间闸(`HELLO_TIMEOUT_MS`)。
 * 64 的依据:真实客户端从 Upgrade 到 hello 是**同一批事件**里的一帧
 * (客户端 `session.ts` 连上即发),64 个并发握手留了足够余量,
 * 而"永远不会 hello"的连接最多只占 64 个槽。
 */
export const MAX_PENDING_HELLO_CONNS = 64;
/**
 * 升级之后必须在这个毫秒数内完成 hello,否则**断开**(并计数 + 日志)。
 *
 * 10s 的依据:真实握手是"立刻"(远慢于此的任何值都是在放行占位),
 * 而它比「永不回收」好无穷倍 —— 后者正是修前的形态。
 */
export const HELLO_TIMEOUT_MS = 10_000;
/**
 * 单连接**连续**「`socket.write` 返回 false」多少次之后断开。
 *
 * ## 为什么策略是「断开」而不是「丢弃最旧」
 * ```text
 * 下行是**差量**编码(delta 相对 `prevState`,见广播循环)⇒ 丢一帧不是
 *   "客户端少看一眼",而是让它**此后每一帧都对不上**(差量链断了)
 *   ⇒ 静默丢帧比断连更坏(它把"卡住"变成"错位",且都不出声)。
 * ⇒ 明确策略:背压持续到阈值 ⇒ 断开该连接(1011)+ 计数 + 日志。
 *   断开之前**不阻塞**(绝不 await 写)、也**不偷偷丢**(`writeBackpressure`
 *   就是"发不出去"这件事的读数)。
 * ```
 * 10 帧 ≈ 20Hz 下 500ms 的持续积压:足够排除一次 TCP 抖动,
 * 又远小于玩家能察觉的"卡住"。
 */
export const BACKPRESSURE_DISCONNECT_STRIKES = 10;

/**
 * 帧超界**专用**错误类 —— 运输层据此回 **1009**(message too big),
 * 而不是把超界与协议错一律回 1002。
 *
 * 为什么单独一个类:调用方要按**类别**分流。若用文案判据
 * (`message.includes('超界')`),一次文案修订就会让它**静默退化**成 1002
 * (本仓反复记的形态:判据盯在会变的字串上)。
 */
export class FrameTooBigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameTooBigError';
  }
}

/**
 * 残帧缓冲是否越界(纯判据)。
 *
 * 为什么抽成函数而不是写成内联条件:它**不可能**从网络侧构造出来
 * (见 `MAX_CONN_BUF_BYTES`),所以只有抽出来才**断得了** —— 否则这条门
 * 就只剩"读代码"一条判据,而那正是本仓不要的东西。
 */
export function isBufOverflow(bufBytes: number): boolean {
  return bufBytes > MAX_CONN_BUF_BYTES;
}

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

  /* ★★★ WS-FND-132(P1):上界**在这里**判 —— 长度域刚解析完,不等到"补满"。
     放在 `masked` 检查之前是有意的:一个宣告了 2^40 的帧连掩码键都还没发到,
     此时唯一正确的动作就是**当场断掉**它(理由见文件里 MAX_FRAME_BYTES 块)。 */
  if ((op & 0x08) !== 0) {
    if (len > MAX_CONTROL_FRAME_BYTES) {
      throw new FrameTooBigError(
        `控制帧载荷超界:${len} > ${MAX_CONTROL_FRAME_BYTES}(RFC 6455 §5.5:控制帧 ≤ 125 字节)`,
      );
    }
  } else if (len > MAX_FRAME_BYTES) {
    throw new FrameTooBigError(
      `帧载荷超界:${len} > ${MAX_FRAME_BYTES}(MAX_FRAME_BYTES)`,
    );
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
 *   因为服务端下行是**裸包**(不带 tag),首字节是 `PROTOCOL_VERSION`
 *   (它**会随版本变**,当前 = 3;而 0x01/0x02 是**帧 tag** 的保留值)
 *   ⇒ 只能靠内容特征(`{`)判文本。
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
  /**
   * ★★ 握手 URL 里 `?token=` 的**加入凭证**(审计 P0-1)。
   *
   * 它是本连接**唯一**可被采纳的身份证据:`urlUserId` 只是"客户端声称自己是谁",
   * 而 `token` 是服务端签的(`signRoomToken`)、只在本房本人生效、且会过期。
   * ⚠️ 位置在 `WsConn`(而不是每次 `onHello` 现取)是有意的:
   * 一条连接开两次 hello 也必须用**第一次那个**凭证 —— 否则客户端可以
   * 先用"无 token"完成一次握手、再用另一个身份重发 hello。
   */
  urlToken: string | null;
  /**
   * ★ D-14(owner 2026-11-17 裁决,方案 A):本连接**已应用成功的最高命令序号**
   * (`-1` = 还没收到 `seq`)。
   *
   * ## 为什么必须**在连接上**(而不是一个闭包级全局)
   * ```
   * 旧写法:let lastAckedSeq(闭包级全局),onMove 推它
   *   ⇒ 多连接下 ack 互相冒充:alice 的 seq=7 会被当成 bob 的 ack
   *   ⇒ bob 的客户端会把 bob 根本没被处理的命令剪掉,且**不报错**
   * ⇒ 现在:每条连接各记各的,推进只由**本连接自己的输入**触发。
   * ```
   *
   * ## 它去哪儿了
   * 下行帧包头 byte6..9(小端 u32,编码 = `ackedSeq + 1`,见
   * `shared/net/delta.ts` 的包头注释)。广播是「`room.step()` 一次算、
   * 一份字节发给所有人」⇒ 运输层必须**逐连接重写那 4 字节**
   * (见广播循环里的 `withAckedSeq`)。读取口:`lastAckedSeqFor(userId)`。
   */
  ackedSeq: number;
  /**
   * ★ WS-FND-161(P1-3):**这条连接是否在广播集里**(= 席位仍在房间)。
   *
   * 为什么需要它(修前实测):`kick()` 走 `leave()` **只摘席位、不断连接**
   * (`room.colyseus.ts`),而广播只看 `helloDone && !closed` ⇒ 被踢者
   * 继续收全房 delta(`snapshotFor(_userId)` 又**忽略参数**,"按人裁剪"从未生效)。
   * ⇒ 运输层自己维护"广播集成员"这一位:握手成功置 `true`,
   *   房间报告席位没了(见 `WsRoomLike.isSeated`)⇒ 置 `false` 并**移出**广播集。
   * ⚠️ 移出广播集**不等于**断开连接:socket 留着(下行停、上行按原纪律处理),
   *   让"被踢"这件事有明确的传输层表现,而不是让被踢者继续看全房。
   */
  inRoom: boolean;
  /**
   * ★ WS-FND-161(P1-2):**连续**「`socket.write` 返回 false」的次数(一次 true 归零)。
   *
   * `write` 的返回值是 Node 唯一的「对端读得慢」信号;修前它被丢弃 ⇒
   * 慢客户端在服务端**不可观测**。到达 `BACKPRESSURE_DISCONNECT_STRIKES`
   * ⇒ 断开(理由见那个常量:「丢帧比断连更坏」)。
   */
  writeStalls: number;
};

/**
 * 从 `req.url`(如 `/ws?userId=alice&token=...`)取任意 query 参数;没有/空值 ⇒ `null`。
 *
 * ⚠️ 空值必须归 `null`(而不是 `''`):两个调用方(`readUserIdFromUrl` /
 * `readTokenFromUrl`)都要把"参数在、值为空"当成**没给** —— 否则空 token 会
 * 被当成"给了 token"送去验签,而报出来的原因会是"签名不符"而不是"缺少 token",
 * 负对照就指认错了对象。WS-13 §10 对 `readUserIdFromUrl` 已有这条断言。
 */
export function readQueryParam(url: string | undefined, name: string): string | null {
  if (url === undefined) return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  const v = params.get(name);
  return v !== null && v.length > 0 ? v : null;
}

/** 从 `req.url` 取 userId;没有则 null。(行为与重构前逐字一致,WS-13 §10 钉着它。) */
export function readUserIdFromUrl(url: string | undefined): string | null {
  return readQueryParam(url, 'userId');
}

/**
 * 从 `req.url` 取**加入凭证**;没有则 null。
 *
 * ## 为什么凭证走 query,而不是塞进 hello JSON
 * ``` 1 客户端的 `HelloFrame` 只有 { t, protocolVersion, contentClaim, passwordHash?, asGuest? },
 *    而 WS-13 §5b-1 会**逐字段双向比对**两端接口 —— 服务端镜像里多一个 `token`
 *    就会红(它的判据没错:一个客户端从不发的字段,只会让下一个人以为"已经有这条路了")。
 *  2 凭证在**连接建立**时就该到位:Upgrade 之后立刻能判,不必等上行帧;
 *    而握手 URL 本来就是客户端可控的传输细节,不构成"协议字段"。 ```
 * ⚠️ 客户端当前**不**带它(`session.ts` 拼的 URL 只有 `?userId=`)⇒ 那一路会被拒,
 * 这是审计 P0-1 的**预期结果**(见本文件 `onHello` 的注释)。
 */
export function readTokenFromUrl(url: string | undefined): string | null {
  return readQueryParam(url, 'token');
}

export type WsServerOptions = {
  port?: number;
  /** 世界源:提供需要的方法(结构化,不 import 具体类)。 */
  room: WsRoomLike;
  /** 每帧间隔 ms(默认 50 = 20Hz,与 room.step 外部驱动对齐)。 */
  frameMs?: number;
  onLog?: (msg: string) => void;

  /**
   * **加入凭证是否必须**(默认 `true`)。
   *
   * ## 为什么默认必须,而不是"可选开启"
   * 旧实现:身份 = 握手 URL 的 `?userId=` ⇒ `?userId=u_owner` 直接成房主。
   * 一个"默认关闭"的鉴权开关等于**没修**:攻击者不会去帮你打开它。
   * ⇒ 默认 `true`;要放宽必须**显式**写 `false`(留给将来的回放/压测夹具,
   *   那种场景必须写在调用点、看得见)。
   * ⚠️ 即便传 `false`,只要连接带了 `?token=` 就**一定**会验(`onHello` 里
   *   `token !== null` 分支)——"不强制"不等于"伪造也放行"。
   */
  requireToken?: boolean;

  /**
   * ★ WS-FND-161(P1-1):**待握手**(已升级、还没 hello)连接数上限。
   * 默认 `MAX_PENDING_HELLO_CONNS`。可覆盖是为了让判据不必真连 64 条 TCP
   * (理由与 `frameMs` 相同:参数化的是**量**,不是语义 —— 超限一律拒升级)。
   */
  maxPendingHello?: number;
  /**
   * ★ WS-FND-161(P1-1):握手超时 ms。默认 `HELLO_TIMEOUT_MS`。
   * ⚠️ 覆盖它**不改变**语义:超时一律「断开 + 计数 + 一行日志」。
   */
  helloTimeoutMs?: number;
};

/**
 * 本服务端需要的**最小房间接口** —— 结构化类型,不 import `room.ts`。
 * ⚠️ 刻意**不**出现模拟层类型名(US2 探针的同款纪律)。
 */
/** `parseMoveIntent` 的结果 —— 判别联合,而不是 `null` + 原因字符串。 */
export type MoveIntentParse =
  | {
    ok: true;
    intent: {
      tick: number; x: number; y: number; z: number;
      speedMul?: number; seq?: number; jump?: boolean;
    };
  }
  | { ok: false; reason: string };

/**
 * 校验并构造一条**移动意图**(2026-11-14,task-83 选乙)。
 *
 * 为什么必须单独抽成纯函数:它是这条上行里**唯一有分支**的部分,而 `onMove`
 * 本身要一个真连接才跑得到 ⇒ 不抽出来的话,「坏值被拦住」这件事**一条断言都没有**
 * (只会剩下注释在说它被拦了 —— 本仓把那种东西叫「一条不能变红的说明」)。
 *
 * 判据必须**显式**排 `NaN` / `Infinity`:
 *   typeof NaN === 'number'  → true(只查类型拦不住)
 *   NaN > 上限               → false(范围检查也放它过去)
 * ⇒ `Number.isFinite` 是这里**唯一**能拦住它的写法。下游 `checkMove` 的 6.0
 * 值域门是第二道;运输层先拦一道,两道不冲突(也不互相替代)。
 *
 * `speedMul` 是可选:给了但非法(字符串 / NaN)⇒ **当作没给**,而不是整条拒绝。
 * 理由:它是乘数,不是坐标 —— 一个坏乘数不该让整次移动消失。
 *
 * ## ★ `z` 只是**建议值**(WS-FND-147)
 *
 * 运输层对 z 只判**值域**(有限数),**不判语义**:高度归谁说了算是世界侧的裁决
 * (`WorldSim.applyPlayerMove` —— 空中 / 落地 / 蹦床 / 落穴这些**服务端**产生的高度变化
 * 不会被客户端旧报文回拖;静止时仍采纳声明值,见该方法的「z 由谁拥有」一节)。
 * ⇒ 这里**不许**加「z ≤ N」之类的玩法上界:那是第二份判定,必然与世界侧漂移。
 */
export function parseMoveIntent(msg: {
  tick?: unknown; x?: unknown; y?: unknown; z?: unknown;
  speedMul?: unknown; seq?: unknown; jump?: unknown;
}): MoveIntentParse {
  const fields: Array<[string, unknown]> = [
    ['tick', msg.tick], ['x', msg.x], ['y', msg.y], ['z', msg.z],
  ];
  for (const [name, v] of fields) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, reason: `${name}=${String(v)}(要求有限数)` };
    }
  }
  const intent: {
    tick: number; x: number; y: number; z: number;
    speedMul?: number; seq?: number; jump?: boolean;
  } = {
    tick: msg.tick as number,
    x: msg.x as number,
    y: msg.y as number,
    z: msg.z as number,
  };
  if (typeof msg.speedMul === 'number' && Number.isFinite(msg.speedMul)) {
    intent.speedMul = msg.speedMul;
  }
  /* `seq` = 客户端命令序号(D-08 第二步,ack 用)。**可选**,且要求**非负整数**:
     它是"处理到第几条",不是坐标 —— 给 1.5 / NaN / -3 一律当**没给**
     (与 `speedMul` 同一取舍:坏值不该让整次移动消失,只是这次不带 ack)。
  *
  * ★ 审计 P3-6:上界也是这条口径的一部分。修前这里**只查下界** ⇒
     `seq = 4294967296` 被原样接受,登记进 `c.ackedSeq` 后由
     `withAckedSeq` 的 `(ackedSeq+1)>>>0` **回绕成 0**(= "服务端什么都没处理"),
     客户端于是把自己确实被处理过的命令又重发一遍 —— 不报错、只在长跑里表现成延迟。
  *   上界取 `MAX_ACKED_SEQ`(= `2^32 − 2`):线上存的是 `ackedSeq + 1`,
     再大就会撞上 u32 回绕。非法 ⇒ 本次**不带 ack**(`seq` 缺席),移动照常应用。 */
  /* ⚠️ `isValidAckedSeq` 的下界是 **-1**(那是"账本里还没有 ack"的内部哨兵),
     而上行 `seq` 是**客户端命令序号**,不存在"第 -1 条" ⇒ 这里必须**再加 `>= 0`**。
     直接把哨兵值当合法输入登记,会让 `c.ackedSeq` 出现一个客户端永远发不出来的数
     (之后 `intent.seq > c.ackedSeq` 的比较基准被悄悄改掉)。 */
  if (typeof msg.seq === 'number' && msg.seq >= 0 && isValidAckedSeq(msg.seq)) {
    intent.seq = msg.seq;
  }
  /* ★ WS-FND-122:**`jump` 意图位**。修前它**不在字段白名单里** ⇒
     客户端(`input.ts` 的空格锁存 → `main.ts` 的 `session.sendMove({jump})`)
     发上来的 `jump:true` 在这里被**静默丢弃**,服务端 `jumpPlayer` 生产 0 调用。
  *
  * 判据:只接受**字面 `true`**(与 `clear` / `confirm` 同一取舍:报文是外部
  * 输入,`1` / `'true'` / `{}` 一律当作「没按」)。不用 `!== false` ——
  * 那会让任何垃圾值都被当成「按了跳跃」,而跳跃是能改权威 `vz` 的动作。
  * ⚠️ 「能不能起跳」(地面 / 冷却)不在这里判:它要权威刚体状态,
  *    判据在世界侧 `tryPlayerJump`(一处)。 */
  if (msg.jump === true) intent.jump = true;
  return { ok: true, intent };
}

export type WsRoomLike = {
  readonly id: string;
  step(prevSnapshot: unknown): Uint8Array;
  snapshotFor(userId: string): Uint8Array;
  /**
   * 加入房间。**凭证必传**(`token`),房间负责验签 —— 运输层不自己造一份校验实现
   * ("不造第二份口径"):密钥在房间里,运输层没有它也**不该**有。
   *
   * `requireToken: true` 是"这条路径来自网络"的表态;`RoomRuntime.join` 据此
   * 把「缺 token」也判死(`token?: string` 只是为了让可信的进程内调用点少写一个字段)。
   */
  join(input: {
    userId: string;
    passwordHash?: string | null;
    asGuest?: boolean;
    token?: string;
    requireToken?: boolean;
  }): {
    ok: boolean;
    reason?: string;
    resumed?: boolean;
    /**
     * ★ WS-FND-134(P2):拒绝**档位**(机器可读)。
     *
     * 修前 `JoinResult` 只有 `reason`(中文散文)⇒ 两个装配层
     * (`ws_server` / `room.colyseus`)与客户端**都只能比对字符串**才能区分
     * 「房满」「密码错」「token 过期」「已在线」—— 而文案一改,判据静默失效
     * (本仓反复记的形态:判据盯在会变的字串上)。
     *
     * ⚠️ 类型写成 `string`(而不是 import `room.ts` 的联合):本文件刻意
     *   **不 import 房间实现**(结构化最小接口,见文件头),多出来的那条 import
     *   会让运输层依赖房间的内容类型。取值口径由 `room.ts` 的 `JoinRejectCode` 定义。
     */
    code?: string;
  };
  /**
   * 签发一张加入凭证。**可选**(结构化最小接口):没有它的房间无法鉴权,
   * `WsServerHandle.issueToken` 会**显式**报错而不是返回一个假凭证。
   */
  issueJoinToken?(userId: string, ttlMs?: number): string;
  leave(userId: string): boolean;
  disconnect(userId: string): boolean;
  /**
   * ★ WS-FND-161(P1-3):这个 userId 现在是否**还在房间里**(可选)。
   *
   * 名字与 `RoomRuntime.isSeated` **逐字一致**是有意的:`RoomRuntime`
   * 结构性满足本接口(见文件头的结构化最小接口纪律),于是两处是**同一份口径**
   * (`members.get(id)?.connected === true`),没有第二个"在不在房里"的判定被写出来。
   *
   * 用途(修前实测的缺陷):`kick()` ⇒ `leave()` 摘掉席位后,广播集
   * **不知道**这件事 ⇒ 被踢者继续收全房 delta。现在每一帧广播前用它核对席位,
   * 没了 ⇒ 移出广播集(`inRoom=false` + 计数 + 一行日志)。
   * ⚠️ 可选:单机演示房 / 测试桩没有席位表 ⇒ 那是"无法得知",
   *   此时**保持旧行为**(不假装知道也没人占位)—— 这类房间本来也没有 kick。
   */
  isSeated?(userId: string): boolean;
  /**
   * 应用一条移动意图。**可选** —— 它只对「真驱动一个模拟层」的房间有意义。
   *
   * ⚠️ 刻意**可选**:`WsRoomLike` 是本文件的**结构化最小接口**,
   * 单机演示房间(与部分测试桩)没有世界可变 —— 逼它们实现一个空方法
   * 就等于把「什么都没做」写成契约。
   * 而"没实现"这条路径在上行里是**出声**的(见 `onMove`),不是静默。
   *
   * 形状与 `RoomRuntime.applyMove(userId, intent)` 一致 ⇒
   * `RoomRuntime` **结构性满足**它,本文件不需要 import `room.ts`。
   */
  applyMove?(userId: string, intent: {
    tick: number; x: number; y: number; z: number; speedMul?: number;
    /** ★ WS-FND-122:空格锁存的意图位(能不能起跳由房间/世界侧判)。 */
    jump?: boolean;
  }): unknown;
  /**
   * 应用一条攻击意图(`RoomRuntime.applyAttack` 的形状)。
   * 可选,理由同 `applyMove`。
   *
   * ★ WS-FND-122:`useSkill` 是 **[Q] 意图位**(只表达「我按了 Q」)。
   * 技能本身由世界侧从**当前武器**取(`skillOf`),报文里不带任何数值 ——
   * 与 `mobId` 的自报纪律同源(`weaponId` / `level` / `wearing` 仍一律不传)。
   */
  applyAttack?(userId: string, claimedBonus?: number, mobId?: string, useSkill?: boolean): unknown;
  /**
   * 应用一条**动作意图**(`RoomRuntime.dispatchAction` 的形状)。
   *
   * 与 `applyAttack` 同一取舍:这里只声明**形状**,不 import 具体层。
   * `action` 收 `string`:房间侧对未知动作名有自己的分支(`NOT_IMPLEMENTED`),
   * 所以网络层不必也不该在这里做一张动作名白名单 —— 那是第二份实现。
   */
  dispatchAction?(userId: string, action: string, payload?: Record<string, unknown>): unknown;
  /** 最近一次攻击结算报告(`RoomRuntime.lastAttackReport`);回给客户端做反馈。 */
  readonly lastAttackReport?: unknown;
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
   * ★ WS-FND-132(P1):**帧层**被拒的累计次数(超界 / 未掩码 / 残帧缓冲越界)。
   *
   * 与 `uplinkRejected` 分开计:那是"载荷解不开",这是"连一帧都没读出来"。
   * 两边的**处置也不同**(帧层当场关连接,载荷层只丢这一包)⇒
   * 合并成一个数就再也分不出是哪一边在响。
   */
  frameRejected(): number;
  /** 最近一次帧层被拒的原因原文(null = 没拒过)。 */
  lastFrameError(): string | null;

  /**
   * ★ WS-FND-134(P1-2):**hello 被拒**的累计次数(缺身份 / join 拒)。
   *
   * 与 `uplinkRejected` 分开计:那是"载荷解不开",这是"人不许进"。
   * 它同时是 P1-1 的服务端半边:客户端能看到 `t:'reject'` 之前,
   * 服务端必须**先**有一条可读的痕迹(否则"玩家说连不上"时无从对账)。
   */
  helloRejected(): number;
  /** ★ WS-FND-134(P2):**下行写失败**的累计次数(修前 `catch` 不留痕)。 */
  writeErrors(): number;
  /**
   * ★ WS-FND-134(P1-2):已经**写出去**的日志行数。
   *
   * 为什么需要它:`log` 被调用 ≠ 出口真的被调过 —— 若哪天有人把默认出口改回
   * `() => {}`,计数仍在(断言"发生过"还是绿),只有这个数会停在 0。
   */
  logLines(): number;
  /**
   * ★ WS-FND-161(P1-1):**当前**已升级但还没 hello 的连接数(≤ 上限,超了不升级)。
   * 它与 `connCount()` 分开:后者是"握过手的人",这是"还没说自己是谁的连接"。
   */
  helloPending(): number;
  /** ★ WS-FND-161(P1-1):因**握手超时**被断开的累计连接数(与下面那条入口闸分开计)。 */
  handshakeTimeouts(): number;
  /** ★ WS-FND-161(P1-1):因**待握手连接满**被拒(不升级,HTTP 503)的累计连接数。 */
  pendingHelloRejected(): number;
  /**
   * ★ WS-FND-161(P1-2):`socket.write` **返回 false**(对端读得慢)的累计次数。
   *
   * ⚠️ 与 `writeErrors` **分开**:那是"写抛了"(帧真的没进 socket),
   * 这是"写排队了"(帧进了 socket,但内核缓冲已满)。两件事两种处置。
   */
  writeBackpressure(): number;
  /** ★ WS-FND-161(P1-2):背压**持续到阈值**因而被断开的累计连接数。 */
  backpressureDrops(): number;
  /**
   * ★ WS-FND-161(P1-3):**当前广播集**大小(握过手 + 席位在 + 未关)。
   *
   * 为什么必须是一个可读的数:`connCount() - broadcastTargets()` 就是
   * 「连着但不在房里的人」(被踢者)⇒ 这条判据能直接问"被踢者还在收帧吗",
   * 而不是读代码猜广播条件。
   */
  broadcastTargets(): number;
  /** ★ WS-FND-161(P1-3):因**席位被房间收走**而移出广播集的累计连接数。 */
  seatsRevoked(): number;
  /**
   * ★ 某条连接**已应用成功的最高客户端命令序号**(`-1` = 该连接还没带过 `seq`)。
   *
   * 这就是下行包头 `ackedSeq` 的**服务端那一半**(D-14 / 方案 A):客户端拿它剪
   * `LocalPredictor.pending`。它按「收到**并应用成功**」的 `seq` 单调推进,
   * 与 `uplinkParsed`(报文解析成功)分开计 —— 两件事,两个数。
   *
   * ## ★ 为什么是 `For(userId)` 而不是一个无参的全局读数
   * 旧接口 `lastAckedSeq(): number` 读的是**闭包级全局**:任一条连接带上来的
   * `seq` 都会推进它 ⇒ 多连接互相冒充,而且它**同时**是"能变绿的假判据"
   * (断言"服务端记到了"与断言"这条连接记到了"在旧接口下不可区分)。
   * ⇒ 改成按连接取;不存在的 userId 返回 `-1`(与"还没收到"同一个值,
   *    这是刻意的:没有连接就没有它自己的账)。
   */
  lastAckedSeqFor(userId: string): number;
  /**
   * ★ 签发一张加入凭证(**鉴权入口的服务端半**)。
   *
   * 生产里由"登录 / 大厅"在**用户身份已经确认**之后调用(比如校验完密码/会话),
   * 再把凭证交给客户端,客户端带 `?token=` 连上来。它**不是**给客户端调的 HTTP 接口 ——
   * 它只是把房间的签名能力暴露给装配层,因为密钥在房间里。
   *
   * ## 为什么不是"运输层自己签"
   * 两份签名实现必然漂移(CR-20 同形)⇒ 签发与校验**共用** `room.issueJoinToken`
   * / `room.join` 这一对。房间没实现它 ⇒ **抛错**:一个鉴权端点返回假凭证
   * 比不可用更糟(它会让人以为身份已经验过了)。
   */
  issueToken(userId: string, ttlMs?: number): string;
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

/* ═══════════ ★ WS-FND-134(P1-2):失败日志的**出口** ═══════════
 * ## 缺陷形态(第九轮实测)
 * ```ts
 * const log = opts.onLog ?? (() => {});
 * ```
 * 默认**静默**,而全仓没有一处装配点传 `onLog` ⇒ 「hello 被拒 / 帧解析失败 /
 * applyMove 抛错」在生产**没有任何出口**:连接被关掉,服务端一条痕迹都不留。
 * ## 修法(三件一起才成立)
 * ```text
 * 1 默认出口 = `defaultWsLog`(真写 console,不再静默)
 * 2 每行带**类别**标签 `[ws:<cat>]`(结构化分派,不靠子串猜)与**计数快照**
 *   `{framesRejected=.. uplinkRejected=.. helloRejected=.. writeErrors=..}`
 * 3 计数本身可从 handle 读到(`frameRejected` / `uplinkRejected` /
 *   `helloRejected` / `writeErrors`),日志行数读 `logLines()`
 * ```
 * ⇒ 「日志出现过」与「这件事发生过几次」变成**两个都能断言的量**。
 *   只断言前者时,「把 log 调用注释掉但计数还在」与「都还在」不可区分 ——
 *   这正是本仓反复点名的「能变绿的假判据」形态。
 */
/** 日志**类别**(唯一的分类来源;`log(cat, msg)` 的第一个参数)。 */
export type WsLogCategory =
  | 'boot' | 'conn' | 'close' | 'frame' | 'uplink'
  | 'hello' | 'move' | 'attack' | 'action' | 'step' | 'write' | 'misc';

/** 每行日志末尾附的**计数快照**(叶子是单调累加量,不是"最近一次")。 */
export interface WsLogCounts {
  framesRejected: number;
  uplinkRejected: number;
  helloRejected: number;
  writeErrors: number;
}

/**
 * 把 (类别, 消息, 计数) 拼成**一行**。
 *
 * 为什么单独抽成导出的纯函数:这样「行里有类别标签、有计数」这件事
 * **可被直接断言**,而不必起一个服务器去读它的输出(判据要能单独变红)。
 */
export function formatWsLogLine(cat: WsLogCategory, msg: string, c: WsLogCounts): string {
  return `[ws:${cat}] ${msg} {framesRejected=${c.framesRejected}`
    + ` uplinkRejected=${c.uplinkRejected} helloRejected=${c.helloRejected}`
    + ` writeErrors=${c.writeErrors}}`;
}

/**
 * **默认**日志出口 —— 真写出去(stderr,因为它是**失败**通道)。
 *
 * ⚠️ 不是 `() => {}`:默认静默等于「生产环境里这条路上什么都没有」,
 *   而那正是本任务 P1-2 的缺陷本体。
 */
export function defaultWsLog(line: string): void {
  try { console.error(line); } catch { /* 控制台不可用时不抛 */ }
}
export async function startWsServer(opts: WsServerOptions): Promise<WsServerHandle> {
  const port = opts.port ?? 0;
  const frameMs = opts.frameMs ?? 50;
  /* ═══════════ ★ WS-FND-134(P1-2):日志**出口**与计数 ═══════════
   * ## 修前(第九轮实测)
   * ```ts
   * const log = opts.onLog ?? (() => { /* 静默 *\/ });
   * ```
   * 而本仓**没有任何**装配点传 `onLog`(唯一的调用点 `server/src/sim/ws_demo.ts` 与
   * 演示脚本显式静音)⇒ 「hello 被拒 / 帧解析失败 / applyMove 抛错」在生产
   * **一条出口都没有**:连接被关、客户端只看到 disconnected,而服务端**不留痕**。
   * ## 现在
   * ```
   * 默认 = `defaultWsLog`(= console,不静默)
   * 每一行都带 **类别标签** `[ws:<cat>]` 与 **计数快照** {framesRejected=... ...}
   * `logLines()` 可断言「日志出口真的被调过」(只断言"代码里有 log 调用"是
   *   本仓反复点名的**不能变红的假判据**:符号被引用 ≠ 被执行)
   * ```
   * ⚠️ 出口本身**抛**不许把运输层带崩(宽容 catch,与断开路径同一纪律):
   *   一个坏 logger 不该让玩家掉线。 */
  const sink = opts.onLog ?? defaultWsLog;
  /** hello 被拒(缺身份 / join 拒)的累计次数 —— 与 `uplinkRejected` 分开计。 */
  let helloRejected = 0;
  /** 下行写失败的累计次数(P2:修前 `catch { closed = true }` 不留痕)。 */
  let writeErrors = 0;
  /** 写出去的日志行数(证明出口真的被调过)。 */
  let logLines = 0;
  /* ═══════ ★ WS-FND-161:连接侧四项的计数与阈值(与上面的失败计数**分开计**) ═══════
   * ```
   * handshakeTimeouts    超时没 hello 被断开     ← P1-1 时间闸
   * pendingHelloRejected 待握手满了拒升级(503)  ← P1-1 入口闸
   * writeBackpressure    write 返回 false 的次数 ← P1-2 背压可见性
   * backpressureDrops    背压到阈值被断开         ← P1-2 明确策略
   * seatsRevoked         席位没了 ⇒ 移出广播集    ← P1-3 被踢者不再收帧
   * ```
   * ⚠️ 五个数**不合并**:合并之后「超时断开」与「入口拒升级」再也分不出来,
   *   而它们的修法完全不同(一个是超时太短,一个是容量太小)。 */
  let handshakeTimeouts = 0;
  let pendingHelloRejected = 0;
  let writeBackpressure = 0;
  let backpressureDrops = 0;
  let seatsRevoked = 0;
  /** 待握手连接数上限(默认 `MAX_PENDING_HELLO_CONNS`)。 */
  const maxPendingHello = opts.maxPendingHello ?? MAX_PENDING_HELLO_CONNS;
  /** 握手超时 ms(默认 `HELLO_TIMEOUT_MS`)。 */
  const helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  /**
   * **唯一**写日志的地方。
   *
   * 为什么类别是参数而不是拼进消息里:拼进消息就等于**没有结构** ——
   * 读者(与断言)只能靠子串匹配,而那正是本仓记过的「判据盯在会变的字串上」。
   */
  const log = (cat: WsLogCategory, msg: string): void => {
    logLines += 1;
    const line = formatWsLogLine(cat, msg, {
      framesRejected, uplinkRejected, helloRejected, writeErrors,
    });
    try { sink(line); } catch { /* 出口自己抛不许把运输层带崩 */ }
  };
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
  /* ★ WS-FND-132(P1):**帧层**被拒的累计次数与最近原因 —— 与上面的 uplink*
     分开计:那是"载荷解析",这是"连一帧都没能读出来"(超界 / 未掩码 /
     残帧缓冲越界)。合并成一个数就分不出"该拦的拦住了"与"该解的没解开"。
     ⚠️ 它必须**单调累加**:一次拒收就能把它推起来的写法是"能变绿的假判据"。 */
  let framesRejected = 0;
  let lastFrameError: string | null = null;
  /* ★ 审计 P0-1:`nextConnSeq` 已删除。
     旧代码在"既没有 hello.userId 也没有 ?userId="时退化为 `c${nextConnSeq++}` ——
     那是**服务端替客户端编一个身份**;现在这条路整段不存在(没凭证 ⇒ 拒),
     所以它没有读者。留着它就等于留着一个"随手能捡回来用"的身份来源。 */
  /** 加入凭证是否必须(默认 true,理由见 `WsServerOptions.requireToken`)。 */
  const requireToken = opts.requireToken ?? true;
  /* ★ 旧的闭包级 `lastAckedSeq` 已删除(D-14):ack 是**每连接**的量,
     全局那一份正是"多连接互相冒充"的成因。见 `WsConn.ackedSeq`。 */

  /**
   * 下发字节。**返回 `socket.write` 的可写性**(true = 直接进了内核缓冲,
   * false = 排进了 Node 的发送队列 = 对端读得慢)。
   *
   * ## ★ WS-FND-161(P1-2):修前这里返回 `void`,**把返回值丢掉了**
   * ```text
   * const write = (c, bytes): void => { try { c.socket.write(bytes); } catch ... }
   * ⇒ 慢客户端**没有任何信号**:帧照旧排队,服务端既不知道"发不出去",
   *  也没有任何上界 ⇒ 内存与延迟都变成攻击面(与帧层那个 O(n^2) 同形)。
   * ⇒ 现在:返回值被**消费**(调用方/计数都看得见),并按下面那条策略处置。
   * ```
   * ⚠️ 「返回 false」**不是丢帧**:Node 的 `write` 返回 false 只是"队列满了",
   *   字节**已经交给** socket ⇒ 计数文案必须说清(否则下一个人会以为帧丢了,
   *   去补一条重发逻辑 —— 那才是把差量协议改坏)。 */
  const write = (c: WsConn, bytes: Uint8Array): boolean => {
    if (c.closed || c.socket.destroyed) return false;
    let writable: boolean;
    try {
      writable = c.socket.write(bytes);
    } catch (e) {
      /* ★ WS-FND-134(P2):修前这里是 `catch { c.closed = true }` ——
         下行写失败**一点痕迹都没有**:报文丢了、连接被标记关闭,
         而调用方看到的是「这个玩家一直没收到帧」。 */
      writeErrors += 1;
      c.closed = true;
      log('write', `下行写失败(bytes=${bytes.byteLength}):${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (writable) {
      /* 一次可写 ⇒ 背压解除("**连续** N 次"的口径靠这一行成立)。 */
      c.writeStalls = 0;
      return true;
    }
    /* ── ★ WS-FND-161(P1-2):背压态 ──
       1 记账:帧**已在** socket 里排队 ⇒ 不许说成"丢帧"(`writeBackpressure`);
       2 连续到阈值 ⇒ **断开**(1011)+ `backpressureDrops`,理由与取舍写在
         `BACKPRESSURE_DISCONNECT_STRIKES` 上(丢帧会打断差量链,比断连更坏)。
       ⚠️ 这里**不阻塞**:`socket.write` 本来就是非阻塞的,而"等它排空再写"
         会让 20Hz 循环的帧率由**最慢的那个客户端**决定 —— 那是把一个人的
         卡顿摊给全房。 */
    writeBackpressure += 1;
    c.writeStalls += 1;
    if (c.writeStalls >= BACKPRESSURE_DISCONNECT_STRIKES) {
      backpressureDrops += 1;
      log('write', `背压持续 ${c.writeStalls} 帧(socket.write 恒 false)⇒ 断开`
        + `${c.userId === null ? '(未握手)' : `,userId=${c.userId}`}`);
      c.closed = true;
      try { c.socket.end(encodeClose(1011, 'backpressure')); } catch { /* 已断 */ }
      try { c.socket.destroy(); } catch { /* 已断 */ }
    }
    return false;
  };

  /**
   * **当前**已升级但还没 hello 的连接数(P1-1 的两个闸都读它)。
   *
   * 为什么必须是"数一遍"而不是维护一个计数变量:连接的进出路径有 3 条
   * (upgrade / error / close)⇒ 手工加减迟早漏一条,而"漏一条"的表现是
   * **上界失效**(正是本轮要修的东西)。数一遍是 O(n),n ≤ 上界。
   */
  const countPending = (): number => {
    let n = 0;
    for (const c of conns) if (!c.helloDone && !c.closed) n += 1;
    return n;
  };

  /**
   * ★ WS-FND-161(P1-3):房间**现在**是否还认这个席位。
   *
   * 三种情况都返回 `true`(不许把"不知道"当成"不在"):
   * ```text
   * 1 还没握手(userId === null):没有席位可言,不参与判定;
   * 2 房间没有 isSeated(单机演示房 / 测试桩):**无法得知** ⇒ 保持旧行为;
   * 3 isSeated 自己抛:断言的现场是"房间实现坏了",而"因为房间抛错就把玩家
   *   静音"会让故障表现成"这个人收不到帧"(静默)—— 故宽容 + 保持旧行为。
   * ```
   */
  const seatAlive = (c: WsConn): boolean => {
    if (c.userId === null) return true;
    const has = opts.room.isSeated;
    if (typeof has !== 'function') return true;
    try { return has.call(opts.room, c.userId) === true; } catch { return true; }
  };

  /**
   * ★ WS-FND-161(P1-3):每一帧广播前把**广播集**与房间的席位表核对一次。
   *
   * ## 修前(实测缺陷)
   * ```text
   * kick() ⇒ leave() 只摘席位、不断连接(room.colyseus.ts),
   * 而广播条件只有 `helloDone && !closed` ⇒ **被踢者继续收全房 delta**;
   * snapshotFor(_userId) 又忽略参数("按人裁剪"从未生效)⇒ 两条路都不裁。
   * ```
   * ## 现在
   * `inRoom=false` + `seatsRevoked += 1` + 一行 `[ws:conn]` 日志。
   * ⚠️ 幂等:只有**真变化**那一次计数(否则这个数会变成"每帧涨 1"的噪声,
   *   而本仓纪律是"计数是单调累加的事实",不是节拍器);
   * 席位回来了(同一条连接上 join 了第二次)⇒ 重新进广播集(自愈)。
   */
  const syncSubscriptions = (): void => {
    for (const c of conns) {
      if (!c.helloDone || c.closed) continue;
      if (seatAlive(c)) { c.inRoom = true; continue; }
      if (c.inRoom) {
        seatsRevoked += 1;
        log('conn', '席位已被房间收走(leave / kick)⇒ 移出广播集'
          + `${c.userId === null ? '' : `,userId=${c.userId}`}`);
      }
      c.inRoom = false;
    }
  };

  /** ★ WS-FND-161(P1-3):广播的**唯一**成员判据(修前只有 `helloDone && !closed`)。 */
  const isBroadcastTarget = (c: WsConn): boolean => c.helloDone && c.inRoom && !c.closed;

  /** 当前广播集大小 —— 供 `broadcastTargets()` 读(与 `connCount()` 的差 = 被踢者)。 */
  const countBroadcastTargets = (): number => {
    let n = 0;
    for (const c of conns) if (isBroadcastTarget(c)) n += 1;
    return n;
  };

  /* ── 包头里 ackedSeq 的位置与编码 ──
     偏移 6(小端 u32),编码 = `ackedSeq + 1`(内部 `-1` ⇒ 线上 `0`)。
     两处必须与 `shared/net/delta.ts` 的写/读顺序一致:
     `ver u8 | op u8 | tick u32 | ackedSeq u32 | 载荷`。
     ⚠️ 这里**只做那 4 字节的按连接覆写**(不改载荷、不改长度)——
     "哪条连接的 ack" 是运输层的事,不进冻结层。 */
  const ACKED_SEQ_OFFSET = 6;
  /**
   * 把包头 byte6..9 覆写成**本条连接**的 ack,返回一份新字节。
   *
   * ## 为什么必须拷贝(而不是就地改共享 payload)
   * 广播循环里 `room.step()` 只算**一次**,那份 `Uint8Array` 会被发给
   * **所有**连接(含后续帧的 `prevState` 演化无关)。就地改它等于
   * "最后一条连接赢" —— 也就是旧全局 ack 那个病换个位置复发。
   * ## 为什么长度不足就原样返回
   * 合法包最短 = 头 10 + 两级计数 4 = 14 字节。短于 10 字节的东西
   * 不可能是本协议的帧(0 字节特例由 `sendBinary` 先拦掉)。
   * 与其写坏内存,不如原样发出去 —— 由客户端的解码器出声。
   */
  const withAckedSeq = (payload: Uint8Array, ackedSeq: number): Uint8Array => {
    if (payload.byteLength < ACKED_SEQ_OFFSET + 4) return payload;
    const out = Uint8Array.from(payload);
    /* ★ 审计 P3-6:换算走冻结层的 `ackSlotValue()`(唯一一处 `ackedSeq+1`),
       它对本连接账本里的非法值**抛错**,而不是 `>>> 0` 静默回绕成 0。
       可达性:`c.ackedSeq` 只有两个写点(建连接时 `-1`、`onMove` 里经
       `isValidAckedSeq` 卡的推进)⇒ 这里抛错意味着账本被别处写坏了,
       那正是必须**出声**的场合(回绕成 0 会让客户端把已处理的命令重发)。 */
    const raw = ackSlotValue(ackedSeq);
    out[ACKED_SEQ_OFFSET] = raw & 0xff;
    out[ACKED_SEQ_OFFSET + 1] = (raw >>> 8) & 0xff;
    out[ACKED_SEQ_OFFSET + 2] = (raw >>> 16) & 0xff;
    out[ACKED_SEQ_OFFSET + 3] = (raw >>> 24) & 0xff;
    return out;
  };

  /**
   * 下发:★ **不加 tag**(契约 §12.1)。
   * ★ WS-FND-161(P1-2):返回值**透出去**(= `socket.write` 的可写性),
   * 广播循环据它记账 —— 修前这里也是 `void`,慢客户端的信号传到一半就断了。
   */
  const sendBinary = (c: WsConn, payload: Uint8Array): boolean => {
    if (payload.byteLength === 0) return false;
    return write(c, encodeFrame(OP_BINARY, payload));
  };
  const sendJson = (c: WsConn, obj: unknown): boolean => {
    /* ★ 下行文本发**裸 JSON**(首字节就是 `{`)。
       客户端 `classifyDownlink` 两条都支持(裸 JSON / `0x01`+JSON),
       但"下行无 tag"是本契约的原则 ⇒ 少一层转换、少一处出错点。 */
    const b = new TextEncoder().encode(JSON.stringify(obj));
    return write(c, encodeFrame(OP_TEXT, b));
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
    /* ── ★ WS-FND-161(P1-1):**入口闸** —— 待握手连接满了就**不升级** ──
       ## 修前
       `conns.add(conn)` 没有任何上界:一条"做完 Upgrade 就沉默"的 TCP
       即可永久占一个 socket + 一个 Set 槽(攻击成本 = 一个连接,不需要
       任何协议知识)⇒ 句柄/内存无上界,而**没有任何东西会红**。
       ## 判据为什么必须在写 101 **之前**
       101 一发出就升级完成了 —— 那时再拒只是"关掉一条已经占过资源的连接",
       闸门拦不住任何东西。故这里先数一遍(`countPending`),再决定给不给 101。
       ⚠️ 与时间闸(`HELLO_TIMEOUT_MS`)**互不替代**:这条管并发量,
         那条管"已经进来的那条能占多久"。 */
    if (countPending() >= maxPendingHello) {
      pendingHelloRejected += 1;
      log('conn', `待握手连接已满(${countPending()}/${maxPendingHello})⇒ 拒绝升级`);
      try { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); } catch { /* 已断 */ }
      try { socket.destroy(); } catch { /* 已断 */ }
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
      /* ★ 凭证在**建连接时**取一次(见 `WsConn.urlToken`:重复 hello 不得换证据)。 */
      urlToken: readTokenFromUrl(req.url),
      ackedSeq: -1,
      /* ★ WS-FND-161:握手成功才进广播集(`onHello` 置 true);背压计数从 0 起。 */
      inRoom: false, writeStalls: 0,
    };
    conns.add(conn);
    log('conn', `upgrade ok,conns=${conns.size}${conn.urlUserId ? `,urlUserId=${conn.urlUserId}` : ''}`);
    /* ── ★ WS-FND-161(P1-1):**时间闸** —— 升级了就必须在 helloTimeoutMs 内 hello ──
       ## 修前
       一条只做 Upgrade、不发 hello 的连接**没有超时**:Upgrade 一成功它就
       永久留在 `conns` 里(没有定时器、没有判据、没有日志)。
       ## 为什么"不清理定时器"是有意的
       回调**自带** no-op 判断(`helloDone || closed` ⇒ 直接返回),而定时器
       `unref()` 掉 ⇒ 它既不占事件循环、也不需要谁记得清它。
       ⇒ 少一个"必须顺手清掉"的 Map,就少一处漏清(本仓反复记的那个形态)。
       ⚠️ 超时**必须出声**:计数 + 一行 `[ws:conn]` 日志 + 回 1008 再 destroy
         (直接 destroy 会让对端把"服务端关我"读成网络抖动)。 */
    const helloTimer = setTimeout(() => {
      if (conn.helloDone || conn.closed) return;
      handshakeTimeouts += 1;
      log('conn', `握手超时(${helloTimeoutMs}ms 内没有 hello)⇒ 断开`
        + `,conns=${conns.size}`);
      write(conn, encodeClose(1008, 'handshake timeout'));
      conn.closed = true;
      try { socket.destroy(); } catch { /* 已断 */ }
    }, helloTimeoutMs);
    if (typeof helloTimer.unref === 'function') helloTimer.unref();

    socket.on('data', (chunk: Buffer) => {
      /* ★ 追加到残帧缓冲区 —— **不假设一 data 一帧**(见 parseFrame) */
      const merged = new Uint8Array(conn.buf.byteLength + chunk.byteLength);
      merged.set(conn.buf, 0);
      merged.set(new Uint8Array(chunk), conn.buf.byteLength);
      conn.buf = merged;

      for (;;) {
        let f: ParsedFrame | null;
        try { f = parseFrame(conn.buf); } catch (e) {
          /* ★ WS-FND-132(P1):帧层拒收**按类别分流**,而且一定要**出声**:
             超界 ⇒ 1009(message too big);未掩码/其余协议错 ⇒ 1002。
             ⚠️ 不许"记一条日志然后继续等" —— 那正是修前的形态:
                对端宣告 2^40 且不补满时,`parseFrame` 连抛都不抛,缓冲无限长。 */
          const tooBig = e instanceof FrameTooBigError;
          framesRejected += 1;
          lastFrameError = e instanceof Error ? e.message : String(e);
          log('frame', `帧解析失败(${tooBig ? '超界' : '协议错'}):${lastFrameError}`);
          write(conn, encodeClose(tooBig ? 1009 : 1002,
            tooBig ? 'message too big' : 'protocol error'));
          try { socket.destroy(); } catch { /* 已断 */ }
          return;
        }
        if (f === null) {
          /* ★ WS-FND-132(P1):残帧缓冲的**累积上界**(见 `isBufOverflow`)。
             ⚠️ 只在"解析不出完整帧"这一刻判:若缓冲里还有完整帧,它会被
                上面的循环消费掉,那时判上界会**误伤**正常粘包/大帧。 */
          if (isBufOverflow(conn.buf.byteLength)) {
            framesRejected += 1;
            lastFrameError = `残帧缓冲超界:${conn.buf.byteLength} > ${MAX_CONN_BUF_BYTES} 字节`;
            log('frame', `残帧缓冲超界 ⇒ 关连接:${lastFrameError}`);
            write(conn, encodeClose(1009, 'message too big'));
            try { socket.destroy(); } catch { /* 已断 */ }
          }
          break;
        }
        conn.buf = conn.buf.subarray(f.consumed);
        handleFrame(conn, f);
        if (conn.closed) return;
      }
    });

    socket.on('error', (e: Error) => {
      conn.closed = true;
      conns.delete(conn);
      /* ★ WS-FND-134(P2):连接层错误此前**一声不响**(无日志、无计数)——
         它恰恰是"连不上"这类工单的第一现场。 */
      log('conn', `socket error:${e instanceof Error ? e.message : String(e)}`);
    });
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
      log('close', `userId=${conn.userId ?? '(未握手)'}`
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
        log('uplink', '忽略空载荷上行(无 tag、无内容)');
        return;
      }
      if (u.kind === 'text') {
        const text = new TextDecoder().decode(u.payload);
        let parsed: HelloFrame & { t?: string };
        try { parsed = JSON.parse(text) as HelloFrame & { t?: string }; }
        catch {
          /* ★ WS-FND-134(P2):修前这里 `catch { close(1003); return }` ——
             既不计数也不出声(对比:帧层拒收 L1042/载荷层拒收 L1213 都记了)。
             ⇒ 一个解析不了的文本帧把连接关掉,而服务端**没有任何痕迹**
             (调用方只看到"连接断了")。
             ⚠️ 归 `uplinkRejected`(载荷层)而不是 `framesRejected`:后者是
             "连一帧都没读出来",这一帧**读出来了**、是内容解不开 ——
             两件事分属不同处置,合并计数会让排障指错方向。
             ⚠️ 为了**能指认对象**,日志里带前 32 字符(不含全文:上行是外部输入)。 */
          uplinkRejected += 1;
          lastParseError = '文本上行不是合法 JSON';
          log('uplink', `文本上行不是合法 JSON ⇒ 关连接(1003),前 32 字符:`
            + `${JSON.stringify(text.slice(0, 32))}`);
          write(c, encodeClose(1003, '文本上行不是合法 JSON'));
          c.closed = true;
          return;
        }
        /* ★ 2026-11-14:文本上行**不再一律当 hello** —— 新增移动意图(`t:'move'`)。
           ⚠️ 判据只看 `t`,其余(含 `t` 缺席)**仍按 hello** ——
              客户端的 hello 帧历史上不带 `t` 也能工作,不能因为加了一条新分支
              就把它判死(那是"顺手放宽/收紧"的另一半)。 */
        if (parsed.t === 'move') {
          onMove(c, parsed as { tick?: unknown; x?: unknown; y?: unknown; z?: unknown; seq?: unknown; jump?: unknown });
          return;
        }
        /* ★ 2026-11-14:`t:'attack'` —— 打怪的落点。判据同 `move`。 */
        if (parsed.t === 'attack') {
          onAttack(c, parsed as { mobId?: unknown; bonus?: unknown; useSkill?: unknown });
          return;
        }
        /* ★ 2026-11-14:`t:'action'` —— 通用动作通道(放置/破坏/丢弃/拾取/...)。
           判据同 `move`/`attack`;判定与执行全在 `room.dispatchAction`。 */
        if (parsed.t === 'action') {
          onAction(c, parsed as { action?: unknown });
          return;
        }
        onHello(c, parsed);
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
      * ⇒ 故**解码器**要求**恰好消耗完**才算成功(`shared/net/delta.ts`:
      *   `r.pos !== bytes.length` ⇒ 抛)。运输层只需把它记成失败
      *   —— 自己**不再重复判一次**(那条分支 2026-11-17 已删,见下面 `decodePacket` 那行)。
       * ⇒ 这样"成功计数"不会被垃圾包灌水 ——
       *   否则我自己的 `uplinkParsed` 就是又一个"能变绿的假判据"。 */
      /* ⚠️ `lastUplink` 仍然无条件记录 —— 它的语义是"最近收到的、已剥 tag 的原始载荷",
         与"能不能解析"**无关**。WS-13 §6-5 用 70000 字节的**非协议**载荷测它
         (那条断言的前提正是"大帧能整到达",不是"大帧能被解析")
         ⇒ 若把它的赋值挪进"解析成功"分支,那条断言会因**无关的改动**而红。 */
      lastUplink = u.payload;
      try {
        const pkt = decodePacket(u.payload);
        /* ★ 2026-11-17:**删掉**了原来的
           `if (pkt.bytesConsumed !== u.payload.byteLength) { …uplinkRejected++… }`
           分支 —— 它已经是**死代码**:
           `decodePacket` 自己在 `r.pos !== bytes.length` 时抛
           (`shared/net/delta.ts`,审计 P1-2),所以能走到这一行时
           `bytesConsumed === byteLength` **必然**成立。
           ⚠️ 保留它 = 第二份「尾部有没有垃圾」的口径(迟早与解码器分叉),
             还会让那条判据看起来有两个来源。
           ★ 判据没丢:`tests/WS-FND-14` 的 F5(70000B 大垃圾包)仍钉着同一件事,
             现在由下面的 catch 分支记账(失败原因文案也来自 `decodePacket`)。
           ⚠️ 也不要把它改成 `if (…) throw`:那是把一条**永假**条件写成"防线"。 */
        uplinkParsed += 1;
        lastParsedPacket = pkt;
        lastParseError = null;
        log('uplink', `上行协议包已解析 op=${pkt.op} tick=${pkt.tick}`
          + ` removed=${pkt.removed.length} upserts=${pkt.upserts.length}`
          + ` ${pkt.bytesConsumed}B`);
      } catch (e) {
        /* ★ 解析失败**不静默**,也**不断连**:
         *   运输层对畸形载荷的纪律与其它路径一致(本文件多处用「宽容」catch)——
         *   一个坏包只该丢它自己,不该杀掉连接。
         *   ⚠️ 但"宽容"不等于"假装没发生" ⇒ 计数 + 原因 + 日志三样都要留。 */
        uplinkRejected += 1;
        lastParseError = e instanceof Error ? e.message : String(e);
        log('uplink', `上行协议包解析失败:${lastParseError}`);
      }
      return;
    }
    /* 未识别的 opcode(如 continuation 0x0):不静默丢 —— 记为一条日志。
       (本服务端不解分片;契约 §13 已记为未覆盖项。) */
    log('frame', `忽略未识别的 opcode=0x${f.op.toString(16)}`);
  }

  function onHello(c: WsConn, hello: HelloFrame): void {
    /* ═══ ★★★ 审计 P0-1:身份 = 服务端签发的**凭证**,不是客户端串 ═══
     *
     * ## 改前的攻击面(实测)
     * ```
     * ws://host/ws?userId=u_owner   + 任意 hello
     * ⇒ declared = 'u_owner' ⇒ room.join({userId:'u_owner'})
     * ⇒ room.ts 的角色判据 input.userId === this.ownerId ⇒ **OWNER**
     * ```
     * 全仓 `token` 被校验 **0** 次(`mintToken` 产出的串只是日志装饰)。
     *
     * ## 改后:三个来源分成"证据"与"声明"两档
     * ```
     * 证据 = ?token=(或 hello.token,若将来客户端带上)  ← 服务端签的,含 userId/roomId/过期
     * 声明 = hello.userId / ?userId=                     ← 客户端自己写的,**只用来与证据比对**
     * ⇒ 声明必须有(否则无从校验),但**声明单独没有任何效力**:
     *   room.join({requireToken:true}) 会先验签,并要求 claims.userId === 声明。
     * ```
     * ## 两个"顺序"是有意的
     * 1 **凭证校验在 join 里,不在本文件** —— 密钥在房间里,运输层没有也不该有
     *   (再造一份校验 = CR-20 的第二份口径)。
     * 2 `c.userId` 只在校验**通过之后**才写 —— 否则被拒的连接在 socket close 时
     *   会带着 `c.userId='u_owner'` 去跑 `room.disconnect('u_owner')`,
     *   那等于给未认证的人一个"踢掉房主"的按钮(同一类缺陷换个门进来)。
     */
    const fromHello = typeof hello.userId === 'string' && hello.userId.length > 0
      ? hello.userId : null;
    const claimed = fromHello ?? c.urlUserId;
    /* ⚠️ `HelloFrame` **不声明** `token`(理由见 `readTokenFromUrl`:WS-13 §5b-1
       逐字段双向比对)。这里按结构化窄化读:客户端将来真带了就生效,**不宣称**它有。 */
    const helloToken = typeof (hello as { token?: unknown }).token === 'string'
      ? (hello as { token: string }).token : null;
    const token = helloToken ?? c.urlToken;
    if (claimed === null) {
      /* 没有声明就无从比对 ⇒ 拒(旧代码在这里**替客户端编**一个 `c1` 身份,
         那正是"身份由服务端凭空产生"的另一面:编出来的身份也能占席位)。 */
      const reason = '缺少 userId(身份无从校验)';
      helloRejected += 1;
      log('hello', `hello 被拒 code=NO_IDENTITY:${reason}`);
      sendJson(c, { t: 'reject', code: 'NO_IDENTITY', reason });
      write(c, encodeClose(1008, reason));
      c.closed = true;
      return;
    }
    const res = opts.room.join({
      userId: claimed,
      passwordHash: hello.passwordHash ?? null,
      asGuest: hello.asGuest === true,
      /* `undefined`(而非 null)⇒ 与 "客户端给了空串" 区分开;
         `requireToken` 让「缺」与「伪造」都落在 join 的同一条拒绝分支里。 */
      token: token ?? undefined,
      requireToken,
    });
    if (!res.ok) {
      /* ★ WS-FND-134(P2):入场被拒必须带**机器可读的 code**(修前只有中文散文
         `reason`,客户端只能靠比对字符串区分"房满 / 密码错 / token 过期 / 已在线")。
         房间侧给出 `res.code`(见 `JoinResult`);同时**出声**(计数 + 日志)。 */
      const code = res.code ?? 'JOIN_REJECTED';
      const reason = res.reason ?? 'join 失败';
      helloRejected += 1;
      log('hello', `join 被拒 code=${code}:${reason}`);
      sendJson(c, { t: 'reject', code, reason });
      write(c, encodeClose(1008, reason));
      c.closed = true;
      return;
    }
    /* ★ 身份**此刻**才落到连接上:join 返回 ok ⇒ 凭证已验过、且 claims.userId === claimed
       (`RoomRuntime.verifyJoinToken` 保证)。在此之前 `c.userId` 保持 null ⇒
       未认证连接的 socket close 不会去 `room.disconnect(声称的 id)`。 */
    c.userId = claimed;
    c.declaredUserId = claimed;
    c.helloDone = true;
    /* ★ WS-FND-161(P1-3):握手成功 ⇒ **进广播集**。
       之后每一帧广播前都会用 `isSeated(userId)` 与房间核对一次;
       席位被收走(kick / leave)⇒ 这一位翻 false,该连接**立刻**不再收帧。 */
    c.inRoom = true;
    /* welcome:字段与客户端 WelcomeFrame 对齐(契约 §12.4) */
    sendJson(c, {
      t: 'welcome',
      /* `playerId` = **已认证**的身份(= 凭证里的 userId),不是客户端声明的那个串。 */
      playerId: claimed,
      roomId: opts.room.id,
      protocolVersion: PROTOCOL_VERSION,
      /* ⚠️ 服务端指纹:阶段 3 的对应物是"只发不校验"。
         契约 §12.5:服务端当前不读客户端的 contentClaim ⇒ 这里给一个
         占位串,**不声称**它是真校验过的。 */
      contentClaim: 'v1-unverified',
      resumed: res.resumed === true,
    });
    /* 首次快照:用 room 的 encodeFull 出口 ⇒ **裸字节**(契约 §12.1) */
    /* 首次快照:用 room 的 encodeFull 出口 ⇒ **裸字节**(契约 §12.1)。
       包头那 4 字节 ack 也按**本连接**填(此刻通常 = 0 ⇒ 「还没有 ack」)。 */
    sendBinary(c, withAckedSeq(opts.room.snapshotFor(claimed), c.ackedSeq));
  }

/**
 * 应用一条**移动意图**(2026-11-14)。WASD 驱角色的服务端落点。
 *
 * ## 为什么放在这里而不是"再开一条下行通道"
 *
 * 移动意图是**上行**,与 `hello` 同一条文本分支 —— 分流靠 `t` 字段。
 * 复用的是同一套「剥 tag → 分类 → 解析」的运输层纪律,不新增帧种类。
 *
 * ## 三个判据都**必须出声**(本仓纪律:静默丢弃比报错更坏)
 *
 * ```
 * 1 还没 hello 就发 move ⇒ 丢弃 + log
 *   (没有 userId 就没法应用;而"没 userId 也照收"会让越权路径看不出痕迹)
 * 2 房间没实现 applyMove ⇒ 丢弃 + log
 *   (`WsRoomLike` 是**结构化最小接口**,单机演示房间没有这个方法。
 *    若这里静默 return,「客户端在发、服务端没接」会表现得像网络丢包)
 * 3 数值不合法(NaN / Infinity / 缺字段)⇒ 丢弃 + log
 *   ⚠️ 这一条尤其重要:`NaN` 的比较恒为 false ⇒ 它会**穿过**绝大多数范围检查,
 *      而下游 `checkMove` 的 6.0 值域门正是为它设的。运输层先拦一道,不冲突。
 * ```
 *
 * ⚠️ `applyMove` 抛错时也**不断连**(与畸形载荷同纪律:一个坏动作只该丢它自己),
 * 但必须计数 + 记原因。
 */
/**
 * 应用一条**攻击意图**(2026-11-14)。打怪的服务端落点。
 *
 * 判据与 `onMove` 同规:未 hello / 房间没实现 / 参数非法 ⇒ **丢弃并出声**。
 * 成功时把 `lastAttackReport` 回给客户端(`t:'attackResult'`)——
 * 否则「打中了」与「什么都没发生」在客户端**不可区分**(本仓反复记的静默形态)。
 */
function onAttack(c: WsConn, msg: { mobId?: unknown; bonus?: unknown; useSkill?: unknown }): void {
  if (!c.helloDone || c.userId === null) {
    log('attack', '攻击意图早于 hello ⇒ 丢弃(还没有 userId,无法应用)');
    return;
  }
  const apply = opts.room.applyAttack;
  if (typeof apply !== 'function') {
    log('attack', '本房间没有 applyAttack ⇒ 攻击无处应用(丢弃,不是丢包)');
    return;
  }
  const mobId = typeof msg.mobId === 'string' ? msg.mobId : '';
  if (mobId === '') {
    log('attack', '攻击意图缺 mobId ⇒ 丢弃(没有目标就没有结算)');
    return;
  }
  const bonus = typeof msg.bonus === 'number' && Number.isFinite(msg.bonus) ? msg.bonus : 0;
  /* ★ WS-FND-122:**[Q] 意图位**。只接受字面 `true`(同 `clear` / `confirm`):
     `1` / `'true'` / `{}` 一律当作「没按 Q」—— 技能是能改结算段数的动作,
     不能靠宽松真值判定放行。
     ⚠️ 「这把武器有没有技能」**不在这里判**(这里没有内容表):判据在世界侧
        `attackMobAuthorized` 的闸 0e(没有技能 ⇒ `rejected:'NO_SKILL'`,
        零副作用),回执里照实带回去。 */
  const useSkill = msg.useSkill === true;
  try {
    apply.call(opts.room, c.userId, bonus, mobId, useSkill);
  } catch (e) {
    log('attack', `applyAttack 抛错(已丢弃该动作,连接保持):${(e as Error).message}`);
    return;
  }
  sendJson(c, {
    t: 'attackResult', report: opts.room.lastAttackReport ?? null, mobId, useSkill,
  });
}

/**
 * 应用一条**动作意图**(2026-11-14)。`RoomAction` 的通用上行落点。
 *
 * ## 为什么 `attack` 之外还要单开一条
 * `move` / `attack` 之所以有**专用报文**,是因为它们自带反作弊要判的语义
 * (绝对坐标 + tick / 目标 id)。其余动作是「做一件事」——
 * 放置 / 破坏 / 丢弃 / 拾取 / 合成 / 睡觉 / 布线 / 驯养 … 二十来个,
 * 共用一个泛型通道更省,而且判定与执行**全在 `RoomRuntime.dispatchAction`**
 * (权限 → 世界 → 背包三段都在那一处,不在网络层分叉)。
 *
 * ## 判据(与 `onMove` / `onAttack` 同规)
 * 未 hello / 房间没有 `dispatchAction` / `action` 不是非空字符串 ⇒ 丢弃并出声。
 * 其余**一切结果都回执**(OK / INVALID / PERMISSION / NOT_IMPLEMENTED),
 * 否则客户端分不清「被拒」与「服务器没听见」。
 *
 * ## ⚠️ 未知动作名**也回执**
 * 房间的 `default:` 分支会给出 `NOT_IMPLEMENTED` + 理由 ⇒ 客户端拿到的是
 * "这个动作没有执行层",而不是沉默。这正是 `TASK-96` 那条纪律在网络层的兑现。
 */
function onAction(c: WsConn, msg: { action?: unknown }): void {
  if (!c.helloDone || c.userId === null) {
    log('action', '动作意图早于 hello ⇒ 丢弃(还没有 userId,无法应用)');
    return;
  }
  const dispatch = opts.room.dispatchAction;
  if (typeof dispatch !== 'function') {
    log('action', '本房间没有 dispatchAction ⇒ 动作无处应用(丢弃,不是丢包)');
    return;
  }
  const action = typeof msg.action === 'string' ? msg.action : '';
  if (action === '') {
    log('action', '动作意图缺 action ⇒ 丢弃(没有动作名就没有执行)');
    sendJson(c, { t: 'actionResult', ok: false, kind: 'INVALID', reason: '缺 action' });
    return;
  }
  let out: unknown;
  try {
    out = dispatch.call(opts.room, c.userId, action, msg);
  } catch (e) {
    log('action', `dispatchAction 抛错(已丢弃该动作,连接保持):${(e as Error).message}`);
    /* ★ WS-FND-134(P2):**内部错**必须与"参数/状态不对"分开档 ——
       修前这里回 `kind:'INVALID'`,与真·参数错同码 ⇒ 客户端(与排障的人)
       把"服务端执行抛错"读成"我发错了",而两者的修法完全不同。 */
    sendJson(c, { t: 'actionResult', action, ok: false, kind: 'INTERNAL', reason: '服务端执行抛错' });
    return;
  }
  /* 回执里带 `action`:一个连接可能连着发多个动作,回执必须能对上号
     (否则客户端"我发的是哪个"只能靠猜)。 */
  sendJson(c, { t: 'actionResult', action, ...(out as Record<string, unknown>) });
}
function onMove(c: WsConn, msg: {
  tick?: unknown; x?: unknown; y?: unknown; z?: unknown;
  speedMul?: unknown; seq?: unknown; jump?: unknown;
}): void {
  /* ⚠️ 两个条件都要查,而不是只查 `helloDone`:类型上 `c.userId` 是 `string | null`,
     而 `applyMove` 要 `string`。只查前者会让类型检查多一条 TS2345
     (本轮实测:基线锁当场抓到 +1)—— 这不是洁癖:若哪天真有连接在
     `helloDone` 之后被清掉 userId,`applyMove(null, …)` 会去查一个不存在的玩家。 */
  if (!c.helloDone || c.userId === null) {
    log('move', '移动意图早于 hello ⇒ 丢弃(还没有 userId,无法应用)');
    return;
  }
  const apply = opts.room.applyMove;
  if (typeof apply !== 'function') {
    log('move', '本房间没有 applyMove ⇒ 移动意图无处应用(丢弃,不是丢包)');
    return;
  }
  const parsed = parseMoveIntent(msg);
  if (!parsed.ok) {
    log('move', `移动意图被拒(${parsed.reason})⇒ 丢弃`);
    return;
  }
  const intent = parsed.intent;
  try {
    const verdict = apply.call(opts.room, c.userId, intent) as
      | { worldRejected?: boolean; corrected?: { x: number; y: number; z: number } }
      | null
      | undefined;
    /* ★ 第十轮 P2:`worldRejected` 的**出口**。修前该字段在运输层零消费:
       客户端只拿到「被纠正」,分不出「世界侧回退到权威坐标(原地不动)」
       与「反作弊拒绝」——两者同形。这里把它单独下发,code 给出稳定档位,
       客户端据 `code==='WORLD_REJECTED'` 与反作弊拒绝分开读(至少日志/状态)。 */
    if (verdict !== null && verdict !== undefined && verdict.worldRejected === true) {
      sendJson(c, {
        t: 'reject',
        kind: 'MOVE',
        code: 'WORLD_REJECTED',
        reason: '世界侧拒收本次移动 ⇒ 回退到权威坐标(不是反作弊拒绝)',
        corrected: verdict.corrected ?? null,
      });
    }
    /* ack 只在**应用成功之后**推进 —— 抛错那条路径不该被记成"服务端处理过了",
       否则客户端会把一条从未生效的命令剪掉(那段位移再也补不回来)。
       ★ 推进的是**本连接**的账(`c.ackedSeq`):多连接不许互相冒充。 */
    /* ★ 审计 P3-6:推进前**再拒一次**非法 seq(不是重复 parse 的检查,而是
       给"绕开 `parseMoveIntent` 的调用方"兜底 —— 例如将来另一个入口直接组 intent)。
       非法 ⇒ 不推进(账本保持不变),并在日志里点名;绝不把回绕值记成 ack。 */
    if (intent.seq !== undefined) {
      if (!(intent.seq >= 0 && isValidAckedSeq(intent.seq))) {
        log('move', `ack 拒收:seq=${String(intent.seq)} 不在 0..${MAX_ACKED_SEQ}(不推进 ack,移动已应用)`);
      } else if (intent.seq > c.ackedSeq) {
        c.ackedSeq = intent.seq;
      }
    }
  } catch (e) {
    log('move', `applyMove 抛错(已丢弃该动作,连接保持):${(e as Error).message}`);
  }
}

  /* ── 20Hz 广播循环 ──
   * ★ WS-FND-161(P2)「广播顺序 / 有界」在这一段里的三条依据:
   * ```text
   * 1 **成员**:先 `syncSubscriptions()` 与房间席位表核对 ⇒ 广播集里
   *   不会有"连着但已被踢"的人(修前只有 `helloDone && !closed`)。
   * 2 **顺序**:`room.step()` 每帧**只算一次**,同一份 payload 按 `conns`
   *   的插入序逐连接发 ⇒ 同一连接收到的帧序 = `step()` 的调用序,
   *   不会被"某条连接的背压"打乱(见 `write`:从不阻塞、从不 await)。
   * 3 **有界**:进来的连接数由 `MAX_PENDING_HELLO_CONNS` + `HELLO_TIMEOUT_MS`
   *   卡住,单连接积压由 `BACKPRESSURE_DISCONNECT_STRIKES` 卡住 ⇒
   *   "广播集大小"与"每条连接的排队量"都不再是无界的。
   * ``` */
  const timer = setInterval(() => {
    /* ★ WS-FND-161(P1-3):**每一帧**先核对席位 —— 被踢者从下一帧起就不再收帧。
       ⚠️ 放在 `step()` 之前:否则被踢者还会多收本帧(而"下一帧"是判据的口径)。 */
    syncSubscriptions();
    let payload: Uint8Array;
    try {
      payload = opts.room.step(prevState);
    } catch (e) {
      log('step', `step 抛错:${(e as Error).message}`);
      return;
    }
    if (payload.byteLength > 0) {
      /* ★★ D-14:包头那 4 字节 ack 是**每连接**的量,而 `step()` 只算一次、
         一份字节要发给所有人 ⇒ 逐连接重写它(拷贝,不动 `payload` 本体)。 */
      for (const c of conns) {
        if (!isBroadcastTarget(c)) continue;
        /* ★ WS-FND-161(P1-2):返回值(= 可写性)被**消费** —— 记账在 `write` 里
           (`writeBackpressure`)。这里**不**据它做分支:false 不是丢帧,
           而是"已排队 + 可能触发了断开",处置只有一处(`write`)。 */
        sendBinary(c, withAckedSeq(payload, c.ackedSeq));
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
    /* ★ WS-FND-132(P1):帧层拒收的累计计数 + 最近原因(见 handle 类型上的说明)。 */
    frameRejected: (): number => framesRejected,
    lastFrameError: (): string | null => lastFrameError,

    /* ★ WS-FND-134(P1/P2):三处**失败出口**的计数。
       ⚠️ 它们与日志行数是**两个判据**:日志证明"说出来了",计数证明"发生过几次"
       —— 只断言其中一个时,"把 log 注释掉"与"把计数删掉"两种走样各自不可见。 */
    helloRejected: (): number => helloRejected,
    writeErrors: (): number => writeErrors,
    logLines: (): number => logLines,
    /* ★ WS-FND-161:连接侧四项的读数(**五个数各自单调,不合并**)。
       ⚠️ `broadcastTargets()` 与 `connCount()` 的差就是「连着但不在房里的人」
         (被踢者)⇒ 判据可以直接问"他还在收帧吗",不必读代码猜广播条件。 */
    helloPending: (): number => countPending(),
    handshakeTimeouts: (): number => handshakeTimeouts,
    pendingHelloRejected: (): number => pendingHelloRejected,
    writeBackpressure: (): number => writeBackpressure,
    backpressureDrops: (): number => backpressureDrops,
    broadcastTargets: (): number => countBroadcastTargets(),
    seatsRevoked: (): number => seatsRevoked,
    /* ★ D-14(2026-11-17):**每连接**的"已应用成功的最高客户端命令序号"。
       与 `uplinkParsed`(报文解析成功)分开计 —— 这是"这条命令生效了"。
       它同时是下行包头 `ackedSeq` 的真值来源(见广播循环)。
       ⚠️ 语义曾经是"全局最高"(多连接互相冒充),现已按连接取。 */
    lastAckedSeqFor: (userId: string): number => {
      for (const c of conns) if (c.userId === userId) return c.ackedSeq;
      return -1;
    },
    /* ★ 鉴权入口的服务端半:转调房间的签发能力(见 `WsServerHandle.issueToken`)。 */
    issueToken: (userId: string, ttlMs?: number): string => {
      const issuer = opts.room.issueJoinToken;
      if (typeof issuer !== 'function') {
        /* 显式失败:返回一个假凭证会让人以为身份已经验过了 —— 比不可用更糟。 */
        throw new Error('本房间没有 issueJoinToken ⇒ 无法签发加入凭证(鉴权不可用)');
      }
      return ttlMs === undefined
        ? issuer.call(opts.room, userId)
        : issuer.call(opts.room, userId, ttlMs);
    },
    /* ★ 模拟异常掉线:destroy 底层 socket(**不发 close 帧**)。
       (原注释见下方:`dropConnectionsForTest` 让"异常断开"与"主动退房"可分别构造。)
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

/** 协议版本 —— 与 shared/net/delta.ts 的 PROTOCOL_VERSION 同值(**3**)。
 *  ⚠️ 这个**常量**刻意不 import delta.ts:常量重复的代价是"两个数要一致",
 *     而它由 WS-13 §6-1 的 `welcome.protocolVersion` 断言、
 *     以及 WS-FND-14 FND14-8(两个独立模块必须同值)钉住。
 *  ★ 2026-11-14(分片 2)订正:上一句原写「本服务端是运输层,不该依赖协议内容」——
 *     那个理由**只对常量成立,对解析器不成立**。运输层现在**确实** import 了
 *     `decodePacket`(见文件头 import 处的长注释):
 *     常量可复制(有断言钉住一致性),**解析逻辑不可复制**(没有任何断言能钉住
 *     "两份实现永远等价")。WS-13 §5「不造第二份口径」正是这条纪律的出处。
 *  ★ 2026-11-17(D-14 / 方案 A):1 → **3**(包头加 4 字节 `ackedSeq`)。
 *     跳过 2 的理由见 `shared/net/delta.ts`:`FRAME_BINARY === 0x02` 会撞值。 */
export const PROTOCOL_VERSION = 3;
