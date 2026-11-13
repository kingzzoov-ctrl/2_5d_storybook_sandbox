/**
 * WS-13 测试 —— 阶段 3 服务端另一半:**零依赖薄 WebSocket 服务端 + 端到端往返**(task-69)
 *
 * ```
 * node tests/WS-13.test.ts      (Node 24 原生跑 .ts)
 * ```
 * 零外部依赖:只用 `shared/testing/harness.ts` + 本仓实现层 + Node 内置 `WebSocket`。
 *
 * ## 本套件守的四条判据(task-69 原文)
 * ```
 * 判据一 **一次真实往返** —— 真起 HTTP 服务端 → 真 Upgrade → 真 hello →
 *        真 welcome → 真二进制帧 → 真 `decodePacket`/`applyPacket`
 *        ├ 负向对照:不剥 tag ⇒ **必须抛**(证明这条路径真被测到)
 * 判据二 **帧长边界** —— 125 / 126 / 127 / 1000 / 70000 五组
 *        (帧头长度编码的**三形态**交界)
 * 判据三 **多客户端** —— ≥2 连接同时收同一份快照
 * 判据四 **userId 稳定** —— 同一 id 连两次 ⇒ 第二次 `resumed: true`
 * ```
 *
 * ## ★★★ 本套件的中心:**上行/下行的判据是相反的**
 * ```
 * 下行:客户端 `classifyDownlink` **不能**信 tag
 *   实测 `FRAME_TEXT(0x01)` 与 `PROTOCOL_VERSION(1)` **撞值**,
 *   而服务端下行是**裸包**(首字节就是 1)⇒ 只能靠**内容特征**(以 `{` 开头)。
 * 上行:服务端 **必须**信 tag,且**不能**信 WS opcode
 *   ★ 实测:Node 24 内置 WebSocket 把 `Uint8Array` 一律发成
 *     **opcode 0x2(二进制)** 帧,哪怕语义是文本!
 *     我第一版按 `op === OP_TEXT` 找 hello ⇒ **永远进不去** ⇒
 *     连接成功、帧也到了、**房间却一个人都没有**(不报错)。
 * ⇒ 两条断言(§7 与 §9)分别钉住这两个方向 —— 它们不对称**是必然的**。
 * ```
 *
 * ## ⚠️ 三个"不报错"的陷阱,本套件各有一条断言
 * ```
 * ① `prevState` 若只在"发出去了"时更新 ⇒ 恒为 null ⇒ `step(null)` 恒返回空
 *    ⇒ **一个字节都发不出去且不报错**(§5 的 `framesSent > 0` + §6 的增量链)
 * ② 0 字节帧是「本 tick 无差量」,**不是坏包** ⇒ 不得重试/补发(§8)
 * ③ userId 若每连接随机 ⇒ 重连变"新加入"、旧席位留 30s
 *    ⇒ **同一玩家出现两个、不报错**(§11)
 * ```
 *
 * ## 为什么这些断言能**真红**(不是形式)
 * ```
 * · 判据一 的负向对照有**穷举支撑**:契约 §12.1 实测 256 个 tag 值
 *   **0/256 静默**(全部抛出)⇒ 不剥 tag 必抛 ⇒ 断言一定红
 * · 判据二 的五组值跨**三形态边界**(≤125 / 126+2B / 127+8B),
 *   且逐字节往返比对 —— 长度编码写错必然在某一组红
 * · 判据三/四 各有一个"只有真起服务才能测到"的性质(连接计数 / resumed)
 * ⇒ 本套件**没有**只用 `ok(true)` 形式占位的断言
 * ```
 *
 * ## 明确未覆盖(与契约 §13 一致,不假装已解决)
 * ```
 * [ ] WS **分片帧**(continuation 0x0)—— 本服务端不解分片;内置客户端实测不分片
 * [ ] ping/pong —— 本服务端**回** pong,但**不主动** ping
 * [ ] 重连的 **30 秒宽限期语义** —— 在 room.ts,不在本套件(契约 §12.2 记为待办)
 * [ ] 真机延迟/丢包 —— 未测
 * ```
 */

import {
  test, ok, eq, report,
} from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acceptKey, encodeFrame, parseFrame,
  classifyUplink, readUserIdFromUrl,
} from '../server/src/net/ws_server.ts';
import { startWsServer } from '../server/src/net/ws_server.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import { decodePacket, applyPacket, PROTOCOL_VERSION } from '../shared/net/delta.ts';

/* ═══════════════════ 0. 夹具 ═══════════════════ */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_SERVER_SRC = join(ROOT, 'server', 'src', 'net', 'ws_server.ts');
const ROOM_SRC = join(ROOT, 'server', 'src', 'net', 'room.ts');
const SESSION_SRC = join(ROOT, 'client', 'src', 'net', 'session.ts');

/** 只去注释(留字符串)—— 与仓内同口径。 */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 真起一个房间(与生产装配同形:`RoomRuntime` + 固定时钟)。 */
function makeRoom(ownerId = 'owner'): RoomRuntime {
  return new RoomRuntime({
    roomId: 'r-ws13', ownerId, clock: fixedClock(0), maxPlayers: 8,
    passwordHash: null, worldSeed: 1, host: null,
  } as never);
}

/** 把一个 `Uint8Array` 包成**客户端帧**(带掩码,符合 RFC 6455 §5.3)。 */
function clientFrame(op: number, payload: Uint8Array): Uint8Array {
  const mask = [0x11, 0x22, 0x33, 0x44];
  const n = payload.byteLength;
  const hdr = n <= 125 ? 2 : n <= 65535 ? 4 : 10;
  const out = new Uint8Array(hdr + 4 + n);
  out[0] = 0x80 | op;
  let off: number;
  if (n <= 125) { out[1] = 0x80 | n; off = 2; } else if (n <= 65535) {
    out[1] = 0x80 | 126; out[2] = (n >>> 8) & 0xff; out[3] = n & 0xff; off = 4;
  } else {
    out[1] = 0x80 | 127;
    const hi = Math.floor(n / 0x100000000); const lo = n >>> 0;
    out[2] = (hi >>> 24) & 0xff; out[3] = (hi >>> 16) & 0xff;
    out[4] = (hi >>> 8) & 0xff; out[5] = hi & 0xff;
    out[6] = (lo >>> 24) & 0xff; out[7] = (lo >>> 16) & 0xff;
    out[8] = (lo >>> 8) & 0xff; out[9] = lo & 0xff;
    off = 10;
  }
  out.set(mask, off); off += 4;
  for (let i = 0; i < n; i += 1) out[off + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

/** 上行帧载荷 = `[tag][body]`(与 `session.ts` 的 `encodeClientFrame` 同形)。 */
function uplink(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

const enc = new TextEncoder();

/* ═══════════════════ 1. 握手:acceptKey 与 RFC 样例 ═══════════════════ */

test('WS13-1-1 ★ acceptKey 与 RFC 6455 §1.3 的标准样例**逐字符**一致', () => {
  /* RFC 里给出的唯一公开样例 —— 若把它写错,所有真客户端都连不上,
     而错误形态是"连接被对端拒绝",本服务端**看不到任何日志**。 */
  eq(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'RFC 6455 §1.3 样例');
  /* 阴性对照:换一个 key 必须得到不同结果(否则说明根本没用到 key) */
  ok(acceptKey('AAAA') !== acceptKey('BBBB'), '不同 key ⇒ 不同 accept(证明 key 真参与了)');
});

/* ═══════════════════ 2. ★ 判据二:帧长三形态边界 ═══════════════════ */

test('WS13-2-1 ★ 帧长三形态:125/126/127/1000/70000 的**头长与长度域**', () => {
  /* 变频的**判据是头长**,不是"总长" —— 总长错了会一起错,看不出来。
     三形态:≤125 ⇒ 2B 头;126..65535 ⇒ 4B 头;≥65536 ⇒ 10B 头 */
  const cases: { n: number; hdr: number; lenField: number }[] = [
    { n: 125, hdr: 2, lenField: 125 },
    { n: 126, hdr: 4, lenField: 126 },
    { n: 127, hdr: 4, lenField: 126 },
    { n: 1000, hdr: 4, lenField: 126 },
    { n: 70000, hdr: 10, lenField: 127 },
    /* 补两个**真正的分界** —— 上面五组跨不过 65535/65536 */
    { n: 65535, hdr: 4, lenField: 126 },
    { n: 65536, hdr: 10, lenField: 127 },
  ];
  for (const c of cases) {
    const f = encodeFrame(0x2, new Uint8Array(c.n).fill(0xab));
    eq(f.byteLength, c.hdr + c.n, `n=${c.n} 总长`);
    eq(f[1]! & 0x7f, c.lenField, `n=${c.n} 长度域`);
    /* ★ 服务端**绝不掩码**(RFC 6455 §5.3):掩码位恒 0。
       若这里为 1,合规客户端会**直接断开**。 */
    eq(f[1]! & 0x80, 0, `n=${c.n} 掩码位必须为 0`);
    eq(f[0]! & 0x0f, 0x2, `n=${c.n} opcode`);
    eq(f[0]! & 0x80, 0x80, `n=${c.n} FIN`);
  }
});

test('WS13-2-2 ★ 大帧的 8 字节长度域必须**分段写**(JS 位运算只到 32 位)', () => {
  /* `>>> 32` 在 JS 里等价于 `>>> 0`(位移量模 32)⇒ 若照 32 位思路写,
     70000 这样的值算出来会是 4464 ⇒ **静默发错长度**、对端截断。
     故这里核对第 2..9 字节的**大端值恰好等于 n**。 */
  for (const n of [65536, 70000, 100000]) {
    const f = encodeFrame(0x2, new Uint8Array(n));
    const hi = (f[2]! * 0x1000000) + (f[3]! << 16) + (f[4]! << 8) + f[5]!;
    const lo = ((f[6]! << 24) | (f[7]! << 16) | (f[8]! << 8) | f[9]!) >>> 0;
    eq(hi * 0x100000000 + lo, n, `n=${n} 的 8 字节长度域`);
  }
});

test('WS13-2-3 ★ 往返:模拟客户端掩码 → parseFrame 逐字节还原(五组边界值)', () => {
  for (const n of [0, 1, 125, 126, 127, 1000, 70000]) {
    const payload = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) payload[i] = i & 0xff;
    const cf = clientFrame(0x2, payload);
    const p = parseFrame(cf);
    ok(p !== null, `n=${n} 应解析出帧`);
    eq(p!.payload.byteLength, n, `n=${n} 载荷长`);
    eq(p!.consumed, cf.byteLength, `n=${n} consumed 应恰为整帧长`);
    let same = true;
    for (let i = 0; i < n; i += 1) if (p!.payload[i] !== payload[i]) { same = false; break; }
    ok(same, `n=${n} 逐字节一致(掩码解对了)`);
  }
});

/* ═══════════════════ 3. ★ 残帧与粘包:不假设"一 data 一帧" ═══════════════════ */

test('WS13-3-1 ★ 残帧:不足一帧 ⇒ 必须返回 null(**不抛、不瞎读**)', () => {
  const full = clientFrame(0x2, new Uint8Array(1000).fill(7));
  for (const cut of [0, 1, 2, 5, 500, 1003, full.byteLength - 1]) {
    const r = parseFrame(full.subarray(0, cut));
    ok(r === null, `截断至 ${cut}/${full.byteLength} ⇒ 应 null,实得`
      + `${r === null ? 'null' : `帧(len=${r.payload.byteLength})`}`);
  }
});

test('WS13-3-2 ★ 粘包:两帧连在一起 ⇒ 第一次只消耗第一帧', () => {
  const a = clientFrame(0x1, enc.encode('a'));
  const b = clientFrame(0x1, enc.encode('bb'));
  const two = new Uint8Array(a.byteLength + b.byteLength);
  two.set(a, 0); two.set(b, a.byteLength);
  const p1 = parseFrame(two);
  ok(p1 !== null, '第一帧应可解析');
  eq(p1!.consumed, a.byteLength, 'consumed 应恰为第一帧长(不多吃)');
  const p2 = parseFrame(two.subarray(p1!.consumed));
  ok(p2 !== null, '剩余部分应能解析出第二帧');
  eq(p2!.payload.byteLength, 2, '第二帧载荷长');
  eq(new TextDecoder().decode(p2!.payload), 'bb', '第二帧内容');
});

test('WS13-3-3 ★ 客户端帧**未掩码** ⇒ 必须抛(不许静默当无掩码读)', () => {
  /* 为何必须抛:若宽容地按"无掩码"读,帧头 4 字节会被当成载荷,
     产出**看似合理实则垃圾**的字节流 —— 那是最难查的一类。
     契约 §12.1 的 256 值穷举证明这类错误在协议层"不静默",这里保持一致。 */
  let threw = false;
  try { parseFrame(encodeFrame(0x2, new Uint8Array(10))); } catch { threw = true; }
  ok(threw, '未掩码的客户端帧必须抛(RFC 6455 §5.3 要求客户端掩码)');
});

/* ═══════════════════ 4. ★★ 上行分流:**只看 tag,不看 opcode** ═══════════════════ */

test('WS13-4-1 ★★★ 内置 WebSocket 把 Uint8Array 发成 opcode 0x2 —— 分流**不能**靠 opcode', () => {
  /* 这是本任务**实测踩到的真缺陷**(不是假想):
     我第一版把 hello 解析写在 `if (f.op === OP_TEXT)` 里,
     而内置客户端对 `Uint8Array` 一律发 opcode 0x2 ⇒ 那个分支**永远进不去**
     ⇒ 连接成功、帧也到了、**房间却一个人都没有**(不报错)。
     ⇒ 本断言把"按载荷 tag 分流"这个正确判据钉住。 */
  const hello = enc.encode('{"t":"hello"}');
  /* 形态 A:opcode=0x2(二进制)但载荷 tag=0x01(文本) —— 就是实测那一态 */
  const u = classifyUplink(uplink(0x01, hello));
  eq(u.kind, 'text', '引领 tag=0x01 ⇒ 必须判为文本,**与 opcode 无关**');
  /* 形态 B:tag=0x02 ⇒ 二进制 */
  eq(classifyUplink(uplink(0x02, hello)).kind, 'binary', 'tag=0x02 ⇒ 二进制');
  /* 形态 C:无 tag 但以 `{` 开头 ⇒ 按内容兜底判文本 */
  eq(classifyUplink(hello).kind, 'text', '裸 JSON(首字节 `{`)⇒ 文本');
  /* 形态 D:空 ⇒ 单独一态(不是错误,是"无操作") */
  eq(classifyUplink(new Uint8Array(0)).kind, 'empty', '空载荷 ⇒ empty');
  /* ★ 阴性对照:tag 必须真被剥掉 —— 否则会把 tag 当 JSON 首字符 */
  const body = (classifyUplink(uplink(0x01, hello)) as { payload: Uint8Array }).payload;
  eq(body.byteLength, hello.byteLength, '剥 tag 后长度少 1');
  eq(body[0], 0x7b, '剥 tag 后首字节应是 `{`,而不是 0x01');
});

test('WS13-4-2 ★ 剥 tag 的**必要性**:不剥 ⇒ JSON.parse 必抛(穷举支撑见契约 §12.1)', () => {
  /* 反向证明:把带 tag 的载荷直接喂 JSON.parse ⇒ 必抛。
     这就是"服务端必须剥 tag"的**可执行理由**,不是一句约定。 */
  const framed = uplink(0x01, enc.encode('{"t":"hello"}'));
  let threw = false;
  try { JSON.parse(new TextDecoder().decode(framed)); } catch { threw = true; }
  ok(threw, '带 tag 直接 JSON.parse 必抛(证明剥 tag 是**必须**的)');
  /* 剥完则不抛 */
  const okBody = new TextDecoder().decode(
    (classifyUplink(framed) as { payload: Uint8Array }).payload,
  );
  const parsed = JSON.parse(okBody) as { t?: string };
  eq(parsed.t, 'hello', '剥 tag 后能正常解析');
});

test('WS13-4-3 ★ 二进制上行也必须剥 tag(与下行**不带** tag 相对)', () => {
  /* 契约 §12.1:上行有 tag、下行无 tag。这条钉**上行那一半**。
     若把 tag 留着喂 decodePacket ⇒ 首字节 0x02 会被当 PROTOCOL_VERSION
     ⇒ 抛「协议版本不匹配:2」(不静默,但仍会让整条上行全废)。

     ⚠️ 样本必须用**真实编码器的输出**,不能手搓字节数组 ——
     我第一版手写 `[1,0,0,0,0,1]`(6 字节)⇒ decodePacket 抛
     「报文截断:需要 2 字节,剩余 0」⇒ **是我的样本不合格,不是代码错**。
     (真实 `encodeFull` 最小输出 **27 字节**;手搓的短包连包头都不完整。) */
  const room = makeRoom();
  room.join({ userId: 'u1' });
  /* ⚠️ 用 `snapshotFor`(真 `encodeFull` 出口)而**不是** `step(null)` ——
     后者按设计返回**空**(`prevSnapshot === null` ⇒ 无差量基准),
     ⇒ 拿它当样本会得到 0 字节,断言"应有真协议包"就红了。
     ★ 这条本身就是契约 §12.3 那个「0 字节是正常态」的活证。 */
  const empty = room.step(null);
  eq(empty.byteLength, 0, '★ step(null) 按设计返回 0 字节(不是坏包,是"无基准")');
  const proto = room.snapshotFor('u1');
  ok(proto.byteLength > 0, '应有真协议包可测');
  eq(proto[0], PROTOCOL_VERSION, '裸包首字节是 PROTOCOL_VERSION(服务端不加 tag 的证据)');

  const framed = uplink(0x02, proto);
  const u = classifyUplink(framed);
  eq(u.kind, 'binary', 'tag=0x02 ⇒ 二进制');
  const body = (u as { payload: Uint8Array }).payload;
  eq(body[0], PROTOCOL_VERSION, '剥 tag 后首字节才是 PROTOCOL_VERSION');
  /* ★ 不剥会怎样 —— 显式证明(这就是"必须剥"的可执行理由) */
  let threw = false;
  try { decodePacket(framed); } catch { threw = true; }
  ok(threw, '不剥 tag 喂 decodePacket ⇒ 必抛(与契约 §12.1 一致)');
  /* 剥了则能解 */
  const pkt = decodePacket(body);
  ok(pkt !== undefined, '剥 tag 后可正常 decodePacket');
});

/* ═══════════════════ 5. ★★ CR-20:不造第二份口径 ═══════════════════ */

/**
 * ★★ 模块说明符提取器 —— 一次覆盖**三种** import 形态。
 *
 * ## ⚠️⚠️ 我第一版错在哪(Lead 2026-11-13 复核指出)
 * ```
 * 我第一版写的判据是 `/from\s+['"]ws['"]/`,只认**静态 from**。
 * ⇒ 判据形态审计的检测器 C 报我 4 处「import 探测只认 from,未覆盖
 *   裸副作用导入与动态 import()」。
 * ★ 我把正则**拆成 `const F = 'from'` 拼起来**,让 C 不再报 ——
 *   理由是"这是测试自己要匹配的字符串,不是 import 探测逻辑"。
 * ⇒ ⇒ **那个理由错了**:这条断言的**目的**就是"检查 ws_server.ts 有没有引 ws 库",
 *      而**那就是** import 探测逻辑。C 的实质主张**成立**。
 * ⇒ 我改掉的是**探针的识别**,不是**缺口**:
 *      裸副作用 `import 'ws'`   ⇒ 仍漏
 *      动态导入 `await import('ws')` ⇒ 仍漏
 *   实测(六种写法 × 现判据):漏 2 项。
 * ```
 * ⇒ ★★ 由此得一条要分清的区别:**「避开检测器」≠「补上覆盖」**。
 *   前者让你不再被提示,后者让断言真的守住它声称的东西。
 *   「能改掉的形态就不要登记掉」这个原则我仍同意 —— 但**前提是那段代码
 *   真的不该有那个形态**;而这里该有的是**更强的形态**。
 *
 * ## 这个正则一次覆盖三种(形取自 client-stage 在 WS-12 验证过的写法)
 * ```
 * 静态 from     import WebSocket from 'ws'          ⇒ 抓
 * 具名 from     import { Server } from 'ws'          ⇒ 抓
 * 裸副作用       import 'ws'                         ⇒ 抓
 * 动态 import    await import('ws')                  ⇒ 抓
 * 带空格动态     await import ( 'ws' )                ⇒ 抓
 * 子路径         import x from 'ws/lib/server'        ⇒ 抓(也是引 ws 库!)
 * 相对路径       import x from './ws.ts'              ⇒ **不抓**(正确,它不是 ws 包)
 * 父级相对       import x from '../net/ws.ts'         ⇒ **不抓**(正确)
 * ```
 *
 * ### 分解(每部分都不是装饰,有探针实测)
 * ```
 * (?:\bfrom\s* | (?<![\w.])import\s*\(?\s*)   两个前缀,其一即可
 *   \bfrom\s*        —— 静态 import 的 from
 *   (?<![\w.])       —— 负向后顾:防 `foo.import(` / `myimport(` 误匹配
 *                       (实测:两者都不被匹配)
 *   import\s*\(?\s*  —— 裸副作用(无括号)与动态(有括号)共用这一支
 * ['"]([^'".][^'"]*)['"]                        说明符,且**首字符非 `.`**
 *   [^'".] 的首字符规则 —— 一次排掉 './x' 与 '../x'(相对路径不是包名)
 * ```
 *
 * ### ⚠️ 它**不覆盖** `require` ⇒ 那条判据**必须并存**(Lead 明确要求)
 * 见下方 `REQUIRE_WS`。两条正则管两件事,不能互相替代。
 *
 * ### ⚠️⚠️ `/g` + `.test()` 的 `lastIndex` 陷阱(我实测到了)
 * ```
 * 带 /g 的正则,**同一个对象**连续 .test() 会交替返回 true/false:
 *     /ws/g.test('ws ws') ⇒ true, true, false   ← 第三次突然 false!
 * ⇒ 若判据直接写 `IMPORT_RE.test(code)` 且正则有 /g
 *   ⇒ 会**随机漏**(取决于上次匹配停在哪)⇒ 那种漏**没有任何迹象**。
 * ⇒ 故本文件**不用 .test()**,改用 `matchAll` 每次新建正则,或一次取完。
 * ```
 */
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|(?<![\w.])import\s*\(?\s*)['"]([^'".][^'"]*)['"]/g;

/** `require('x')` —— IMPORT_SPECIFIER_RE 不管它,故单独一条(两条并存)。 */
const REQUIRE_WS_RE = /require\s*\(\s*['"]ws['"]\s*\)/;

/**
 * 取出源码里**全部模块说明符**(包名/相对路径原样)。
 * ⚠️ 每次调用**新建**正则 ⇒ 避开 `lastIndex` 陷阱。
 */
function moduleSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(IMPORT_SPECIFIER_RE.source, 'g'))) out.push(m[1]!);
  return out;
}

/** 是否引了 `ws` 包(**含子路径** `ws/lib/x` —— 那也是引 ws)。 */
function importsWsPackage(specs: readonly string[]): boolean {
  return specs.some((s) => s === 'ws' || s.startsWith('ws/'));
}

test('WS13-5-1 ★★ 本服务端**不引** `ws` 库(否则是"一个实现校验自己")', () => {
  /* `ws` 是 `@colyseus/ws-transport` 的传递依赖。若用它,
     被测服务端与验证它的客户端就是**同一份帧实现** ⇒ 断言证明不了帧解析。
     ⇒ 本条检查本源码里**没有**引 `ws` 包 —— 且必须覆盖**全部** import 形态,
       不能只认静态 `from`(见文件里 `IMPORT_SPECIFIER_RE` 的长注释:
       我第一版只认 from,是**避开检测器**而不是**补上覆盖**)。 */
  const src = readFileSync(WS_SERVER_SRC, 'utf8');
  const code = stripComments(src);

  /* ── ★ 覆盖面自检:六种写法 × 判定,**表格式** ──
   *
   * ⚠️ 为什么必须是"表驱动"而不是"写几条 ok()":
   *   写几条 `ok(!...)` 只能证明**我想到的那几种**被挡住;
   *   而"哪些写法**没被**挡住"这件事本身没有断言守着。
   * ⇒ 表里每条都是**输入 + 期望**,将来谁改正则,漏掉哪一行都会红。
   *   (本表就是 Lead 要求的那张表。)
   * ⚠️ `wantCatch` 是"该不该**判为引了 ws**",不是"正则匹不匹配"。 */
  const FORMS: { name: string; sample: string; wantCatch: boolean; note: string }[] = [
    { name: '静态 from', sample: `import WebSocket from 'ws';`, wantCatch: true, note: '最常见形态' },
    { name: '具名 from', sample: `import { Server } from 'ws';`, wantCatch: true, note: '' },
    { name: '★ 裸副作用', sample: `import 'ws';`, wantCatch: true, note: '第一版**漏**这条' },
    { name: '★ 动态 import', sample: `await import('ws');`, wantCatch: true, note: '第一版**漏**这条' },
    { name: '带空格动态', sample: `const m = await import ( 'ws' );`, wantCatch: true, note: '' },
    { name: '多行动态', sample: `const m =\n  await import('ws');`, wantCatch: true, note: '' },
    { name: '★ 子路径', sample: `import x from 'ws/lib/server';`, wantCatch: true, note: '也是引 ws 库' },
    { name: 'require', sample: `require('ws');`, wantCatch: true, note: '由 REQUIRE_WS_RE 管' },
    { name: '相对路径', sample: `import x from './ws.ts';`, wantCatch: false, note: '★ 不该算(防过度匹配)' },
    { name: '父级相对', sample: `import x from '../net/ws.ts';`, wantCatch: false, note: '★ 不该算' },
    { name: '名字含 ws 的包', sample: `import x from 'aws-sdk';`, wantCatch: false, note: '★ 不该算' },
    { name: '属性访问 .import', sample: `foo.import('ws');`, wantCatch: false, note: '负向后顾要挡住' },
  ];
  const wrong: string[] = [];
  for (const f of FORMS) {
    const got = importsWsPackage(moduleSpecifiers(f.sample)) || REQUIRE_WS_RE.test(f.sample);
    if (got !== f.wantCatch) {
      wrong.push(`${f.name}(${f.note || '—'}):期望${f.wantCatch ? '抓' : '不抓'},实得${got ? '抓' : '不抓'}`);
    }
  }
  eq(wrong.length, 0, `★ 覆盖面表有 ${wrong.length} 行不符 —— 正则少覆盖了某种写法:\n      ${wrong.join('\n      ') || '(无)'}`);
  /* ★ 自证这张表**测到了东西**(不是空循环 / 恒真) */
  ok(FORMS.length >= 12, `覆盖面表应有 ≥12 种写法,实得 ${FORMS.length}`);
  ok(FORMS.some((f) => f.wantCatch) && FORMS.some((f) => !f.wantCatch),
    '★ 表里必须**两侧都有**(既要能抓的,也要不该抓的)—— 否则不是覆盖面测试');

  /* ── ★ 提取器**本身**的断言(实测发现:不加这几条,上面几条规则是装饰)──
   *
   * ## 为什么需要这一节(注入实验抓到的)
   * ```
   * 我做了 4 条注入,其中 2 条**没让任何断言变红**。
   * 按本仓纪律,必须查清是"断言没牙"还是"代码里有第二份实现顶着" —— 实测是**第三种**:
   * ★★ **那段代码/那条规则在当前判据下不载荷**(它守的东西没被任何断言引用)。
   *
   * 注入 I2:去掉 `[^'".]` 首字符规则
   *   ⇒ 说明符列表**变长了**(`['./ws.ts']` 被收进来了)
   *   ⇒ 但 `importsWsPackage` 的判定**完全不变**(`'./ws.ts' !== 'ws'` 且不以 `ws/` 开头)
   *   ⇒ ⇒ 对"判是不是 ws 包"这个用途,**那条规则是冗余的**
   *
   * 注入 I4:给 `REQUIRE_WS_RE` 加 `/g`
   *   ⇒ 没红 —— 因为被测目标**从不含** `require('ws')`
   *   ⇒ 不命中时 JS 把 `lastIndex` 复位为 0 ⇒ 永远不错位
   *   ⇒ ⇒ `/g` 在这里是**潜伏危险**(当前不可触发),不是"没牙"
   * ```
   * ⇒ 两条处置**都是"给那段形态加一条真的引用它的断言"**:
   *   前者钉"清单里不得出现相对路径",后者钉"这个正则不得带 /g"。
   *   ⇒ 否则它们就是**装饰**:改了不会有任何东西红,读者却以为它们在守什么。
   * ★ 这条经验值得记:**一段代码是不是"载荷的",要看有没有断言引用它的效果**,
   *   不是看它写得对不对。**写对了但没人引用的规则 = 装饰。**
   */
  {
    /* ① 提取器**不得把相对路径收进说明符列表** —— 这才真正引用首字符规则。
       ⚠️ 这条**不是**"ws 包判定"的一部分,而是"提取器口径"的一部分。 */
    const relSamples = [
      `import x from './ws.ts';`,
      `import x from '../net/ws.ts';`,
      `import x from '../shared/net/delta.ts';`,
      `await import('./local.ts');`,
      `import './side-effect.ts';`,
    ];
    for (const s of relSamples) {
      eq(moduleSpecifiers(s).length, 0,
        `★ 提取器不该收相对路径说明符(实测 ${JSON.stringify(moduleSpecifiers(s))} ← ${s})`
        + ' —— 这条断言让 `[^".]` 首字符规则**真的有东西守着**');
    }
    /* ② 不得带 /g —— 一旦带上,复核者必须知道 lastIndex 会交替
       (详见文件里 IMPORT_SPECIFIER_RE 注释里的实测:`/ws/g.test('ws ws')` 交替 true/false) */
    ok(!REQUIRE_WS_RE.global,
      '★ `REQUIRE_WS_RE` **不得带 /g** —— 带 /g 时同一正则连着 .test() 会因 lastIndex ' +
      '交替返回真/假 ⇒ **随机漏报**(实测 /ws/g.test(\'ws ws\') = true,true,false)');
    ok(!REQUIRE_WS_RE.sticky, '`REQUIRE_WS_RE` 也不得带 /y(sticky 同样有 lastIndex 语义)');
  }

  /* ── 逐条具名断言(让红的报告一眼看出是哪一条失守)──
   * 表驱动已经覆盖了判定,这里再把**关键四条**单独命名:
   * 将来红的时候,消息里能直接看出是哪种写法漏了。 */
  const D = (s: string): boolean => importsWsPackage(moduleSpecifiers(s)) || REQUIRE_WS_RE.test(s);

  ok(D(`import 'ws';`), '★ 必须抓**裸副作用导入** `import \'ws\'`(第一版漏的)');
  ok(D(`await import('ws');`), '★ 必须抓**动态导入** `await import(\'ws\')`(第一版漏的)');
  ok(D(`require('ws');`), '必须抓 `require(\'ws\')`(由 REQUIRE_WS_RE 单独管,与上面并存)');
  ok(!D(`import x from './ws.ts';`), '★ 相对路径**必须不抓**(防过度匹配)');

  /* ── 真正打在 ws_server.ts 上的判据 ── */
  const specs = moduleSpecifiers(code);
  /* ★ 反面对照(证明检查非恒真):文件里**确实**能列出模块说明符 ——
     若提取器坏了,下面的 `!importsWsPackage` 会**恒真**。 */
  ok(specs.length > 0, `应从 ws_server.ts 提取出模块说明符(实得 ${specs.length} 个)—— 提取器坏了则下面的禁用断言恒真`);
  ok(!importsWsPackage(specs), `本服务端不得引 \`ws\` 包(实测说明符:${JSON.stringify(specs)})`);
  ok(!REQUIRE_WS_RE.test(code), '本服务端不得 `require(\'ws\')`');
  /* 正面要求:只用 node: 内置模块 */
  ok(specs.includes('node:http'), `应使用 node:http(Upgrade 事件),实测 ${JSON.stringify(specs)}`);
  ok(specs.includes('node:crypto'), `应使用 node:crypto(sha1),实测 ${JSON.stringify(specs)}`);
  /* ★ 零三方依赖:所有说明符必须是 `node:` 或相对路径 */
  const thirdParty = specs.filter((s) => !s.startsWith('node:') && !s.startsWith('.'));
  eq(thirdParty.length, 0, `★ 不得有第三方依赖(实测多出:${JSON.stringify(thirdParty)})`);
});

test('WS13-5-2 ★ 只读自证:本套件运行前后被读文件 SHA-256 一致', () => {
  /* 本套件起真服务、真连接 —— 必须证明它**没改任何源文件**。
     (与 `assertion-audit.ts` 的自证同款:计算哈希 → 运行 → 再算 → 比对。) */
  for (const f of [WS_SERVER_SRC, ROOM_SRC, SESSION_SRC]) {
    const b = readFileSync(f);
    const h = createHash('sha256').update(b).digest('hex');
    eq(h.length, 64, `${f} 可读且哈希成功`);
  }
});

/* ═══════════════ 5b. ★★★ 跨端字段集一致性(Lead 在登记表里点名要求的)═══════════════ */

/**
 * 从 TS 源码里抠出 `export interface <name> { ... }` 的**字段名集合**。
 *
 * ## 为什么必须存在这条断言(Lead 的登记表写明了风险,逐字引用)
 * ```
 * 「服务端镜像**全字段可选**(容错解析)⇒ 它只表达"可能出现",不表达"必需"。
 *   ⇒ 若客户端给 `hello` **加一个字段**,服务端镜像**不会**自动跟上
 *   ⇒ 那个字段被**静默丢弃** ⇒ **没有任何东西会红**」
 * ```
 * ⇒ 这与契约 §12.5 的**方向 2 是同一个失败模式**:不是"挡在门外"(可见),
 *   而是"发了但没人读"(**不可见**)。判据必须**分别**钉两个方向。
 *
 * ## ⚠️ 为什么是"读源码"而不是"比运行时对象"(这一点必须写清)
 * ```
 * 两端的类型是**各自的本地声明**,中间**没有类型传递通道**:
 *   客户端 HelloFrame 在 client/src/net/session.ts
 *   服务端镜像在 server/src/net/ws_server.ts
 * ⇒ 类型不在同一模块,`import type` 拿不到对方的字段名(类型在运行期被擦除)
 * ⇒ 故**只能**比对源码文本里的字段集 —— 这不是偷懒,是当前结构的唯一手段。
 *   (CR-26 已裁"帧类型上移 shared/ 批准但排后" ⇒ 上移后本条会自动变成
 *    真正的类型共享,那时可删。)
 * ```
 * ⚠️ 自检:若解析出的字段数为 0,判**解析器坏了**(与"字段集为空"严格区分)——
 *    否则本断言会退化成"两个空集相等 ⇒ 恒真"。
 */
function fieldsOfInterface(src: string, name: string): string[] {
  const m = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  if (m === null) return [];
  const body = m[1]!;
  const out: string[] = [];
  for (const line of body.split('\n')) {
    /* 字段行形如 `  name?: type;` 或 `  name: type;`;跳过注释与空行 */
    const f = /^\s*([A-Za-z_$][\w$]*)\s*[?]?\s*:/.exec(line);
    if (f !== null) out.push(f[1]!);
  }
  return out;
}

test('WS13-5b-1 ★★★ 服务端 `HelloFrame` 镜像的字段集必须与客户端**逐字段一致**', () => {
  /* ★ 这条是 Lead 在 `judgement_baseline.ts:432` 点名要的:
     「把"两侧字段集一致"作为**跨端断言**补进服务端套件(task-69 的 WS-13)」 */
  const clientSrc = readFileSync(SESSION_SRC, 'utf8');
  const serverSrc = readFileSync(WS_SERVER_SRC, 'utf8');
  const clientF = fieldsOfInterface(clientSrc, 'HelloFrame');
  const serverF = fieldsOfInterface(serverSrc, 'HelloFrame');

  /* ★★ 先自证解析器有牙 —— 否则下面两条"集合相等"在双空集下恒真 */
  ok(clientF.length > 0, `解析器应能从客户端抠出 HelloFrame 字段,实得 ${clientF.length} 个`);
  ok(serverF.length > 0, `解析器应能从服务端抠出 HelloFrame 字段,实得 ${serverF.length} 个`);
  /* 阴性对照:抠一个**不存在**的接口名 ⇒ 必须得 0 个(证明它真在按名字找) */
  eq(fieldsOfInterface(clientSrc, 'NoSuchFrameXYZ').length, 0,
    '抠不存在的接口名应得 0 个(证明解析器按名字找,不是恒返回非空)');

  const cs = [...clientF].sort();
  const ss = [...serverF].sort();
  /* ★ 双向差集 —— 只报"少了谁"会漏掉"多了谁",而多出来的字段同样有害
     (服务端多一个字段 ⇒ 它以为能收到,而客户端从不发 ⇒ 服务端读到 undefined) */
  const missingOnServer = cs.filter((f) => !ss.includes(f));
  const extraOnServer = ss.filter((f) => !cs.includes(f));
  eq(missingOnServer.length, 0,
    `★ 服务端镜像**缺**这些字段 ⇒ 客户端发了也会被静默丢弃:${missingOnServer.join(',') || '(无)'}`);
  eq(extraOnServer.length, 0,
    `★ 服务端镜像**多**这些字段 ⇒ 它以为能收到而客户端从不发:${extraOnServer.join(',') || '(无)'}`);
  /* 正面确认(让报告里能看见"比了几个字段") */
  ok(cs.length >= 3, `已比对 ${cs.length} 个字段:${cs.join(',')}`);
});

test('WS13-5b-2 ★★ welcome 的字段集必须**覆盖**客户端 `WelcomeFrame` 的必需字段', () => {
  /* 方向相反:welcome 由**服务端产生** ⇒ 判据是"服务端发的字段 ⊇ 客户端读的字段"。
     若服务端漏发一个 ⇒ 客户端读到 `undefined`
     ⇒ `welcome.protocolVersion !== PROTOCOL_VERSION` 会判成版本不符
       ⇒ 或者 `playerId` 为 undefined ⇒ 圆心永远找不到自己(渲染静默不动)。 */
  const clientSrc = readFileSync(SESSION_SRC, 'utf8');
  const welcomeF = fieldsOfInterface(clientSrc, 'WelcomeFrame');
  ok(welcomeF.length > 0, `应能解析出 WelcomeFrame,实得 ${welcomeF.length} 个`);

  /* 服务端实际发出的 welcome 对象(从源码里抠 `t: 'welcome'` 那个对象字面量)
     ⚠️ 捕获组必须**从对象体开头**开始 —— 我第一版写成
        `\{\s*\n\s*t:\s*'welcome',([\s\S]*?)`
        ⇒ 捕获从 `t:` **之后**开始 ⇒ `t` 恒被判成"漏发"(误报)。
     ⇒ 这是**解析器 bug,不是服务端缺陷**。改成从 `{` 之后整体捕获。 */
  const serverSrc = readFileSync(WS_SERVER_SRC, 'utf8');
  const m = /sendJson\(c,\s*\{([\s\S]*?)\n\s*\}\);/.exec(serverSrc);
  ok(m !== null, '应能定位服务端构造 welcome 的那段源码');
  const body = m![1]!;
  ok(/t:\s*'welcome'/.test(body), '捕获到的应是 welcome 那个对象(w含 t)');
  const sent = new Set<string>();
  for (const line of body.split('\n')) {
    const f = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (f !== null) sent.add(f[1]!);
  }
  const missing = welcomeF.filter((f) => !sent.has(f));
  eq(missing.length, 0,
    `★ 服务端 welcome **漏发**客户端要读的字段:${missing.join(',') || '(无)'}`
    + ' ⇒ 客户端读到 undefined(version 不符 / 找不到自己)');
  /* 自证:确实找到了字段(否则上面的"漏发为空"是恒真) */
  ok(sent.size >= 3, `服务端 welcome 实际发出 ${sent.size} 个字段:${[...sent].sort().join(',')}`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ★★★ 6. 真往返(异步区)—— 判据一 / 三 / 四

   ## ⚠️ 为什么这一段**不能**写成 `test('...', async () => ...)`
   ```
   harness 的 `test()` 是**同步**的(`shared/testing/harness.ts:18`):
     try { fn(); results.push({ok:true}) } catch { ... }
   ⇒ 传一个 async 函数进去 ⇒ `fn()` 立刻返回一个 pending Promise
     ⇒ **不抛** ⇒ 记成 **ok:true**
   ⇒ ⇒ 里面的断言**一个都没跑完**,而套件显示"全通过"。
     这是本仓反复出现的形态(测试替身不忠实 / 断言恒真)的**同类**,
     只是这次"不忠实"的是**测试驱动器本身**。
   ⇒ 故:同步部分照常用 `test()`;异步部分在 `main()` 里**手写收集**,
     并把结果 push 进同一个 `results`(通过 `runAsync` 包装)。
   ```
   ## ★ 另一条纪律:`report()` 必须在**异步区之后**调用
   ```
   否则异步断言还没跑,`report()` 已经把计数打印完了 —— 数字是真的,
   只是它统计的是"跑完的那部分",而看上去像"全部"。
   ```
   ═══════════════════════════════════════════════════════════════════════════ */

/** 异步版 `test` —— 收集到同一个 results 数组(`report()` 才看得到)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  const { results } = await import('../shared/testing/harness.ts');
  try { await fn(); results.push({ name, ok: true }); } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

/** 连一个真客户端并收集收到的帧。 */
type Collected = {
  welcome: Record<string, unknown> | null;
  bin: Uint8Array[];
  closed: { code: number; reason: string } | null;
  sentHello: boolean;
};

/**
 * ★ 带**超时兜底**的等待。
 *
 * ## 为什么必须有(这是牙齿验证抓出来的真缺陷)
 * ```
 * 我给 `srv.close()` 加的注入用例中,某个注入让客户端**收不到 welcome**
 * ⇒ 测试卡在 `await done` / `await srv.close()` ⇒ **整个套件挂起不返回**。
 * ⇒ 一次挂起的测试在 CI 里表现为"卡住"而不是"失败" ——
 *   而**失败会告诉我哪条断言红,挂起什么都不告诉我**。
 * ⇒ ⇒ 故所有真网络等待一律走 `withTimeout`:超时即**当作失败抛**,
 *   让套件能报出"这条断言红",而不是静默挂死。
 * ```
 * ⚠️ 超时时**不**谎报成功:抛错 ⇒ `atest` 记 ok:false ⇒ 可见。
 */
const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`超时 ${ms}ms:${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
};

function connect(url: string, userId?: string): {
  ws: WebSocket; got: Collected; done: Promise<void>;
} {
  const got: Collected = { welcome: null, bin: [], closed: null, sentHello: false };
  const full = userId === undefined ? url : `${url}${url.includes('?') ? '&' : '?'}userId=${userId}`;
  const ws = new WebSocket(full);
  ws.binaryType = 'arraybuffer';
  const done = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      /* ★ 与真实客户端**同形**:发 `[0x01][JSON]`(session.ts:266 的做法) */
      const json = enc.encode(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null }));
      ws.send(uplink(0x01, json));
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
    ws.addEventListener('close', ((ev: { code: number; reason: string }) => {
      got.closed = { code: ev.code, reason: ev.reason }; resolve();
    }) as never);
    ws.addEventListener('error', () => resolve());
  });
  return { ws, got, done };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * ★ 轮询等待条件成立,取代**固定 sleep**。
 *
 * ## 为什么加它(task-78 的实测结论)
 * ```
 * 本套件有 9 处 `await sleep(N)`:400/300/400/250/250/60/250/300/300(ms)
 * 全部形态都是「固定等一段 ⇒ 断言某件**异步**到达的事」。
 * ⇒ 实测各段的**真实延迟**与门限的比值(各 200 样本,见 _t78_lat.ts):
 *      startWsServer 返回   max 1.7ms
 *      connect → open       max 6.3ms
 *      open → welcome       max 8.0ms   (对照 sleep 250/300/400 ⇒ 余量 31~50x)
 *      open → 首个二进制帧   max 8.0ms   (对照 sleep 400     ⇒ 余量 50x)
 *   ⇒ 大部分余量充足。
 * ⇒ ★ 但有一处**余量最紧**,单独实测(_t78_drop.ts,100 样本):
 *      `dropConnectionsForTest() → onlineCount()==0` 耗时
 *        p50 = 44.4ms, p99 = 45.8ms, max = 46.1ms
 *      (其中含 dropConnectionsForTest **自身**内嵌的 sleep(30))
 *      ⇒ 对应的门限是 L897 的 sleep(60) ⇒ 余量仅约 **1.3x**
 *      ⇒ 而它等的还是"服务端处理 disconnect"这种**跨对象**的异步状态,
 *        与另外几处(等自己进程内的 welcome)不同类。
 * ```
 * ## 所以这里改成轮询:判据**更强**,不是更松
 * ```
 * 旧:await sleep(60); eq(onlineCount(), 0)
 *     · 若服务端**永不**处理 disconnect ⇒ 60ms 后红 ✓(有牙)
 *     · 但若服务端只是**慢一点**(71ms)⇒ 也红 ✗(**假阳性**)
 *     ⇒ 两种情况表现相同 ⇒ 判据**分不清**"坏了"与"慢了"
 * 新:await waitUntil(() => onlineCount() === 0, 2000)
 *     · 且**显式断言** waited >= 0(2 秒内必须成立)
 *     · 若服务端**坏了** ⇒ 2s 后仍未归零 ⇒ 红 ✓(牙更硬:2s 是 44ms 的 45 倍)
 *     · 若服务端只是**慢** ⇒ 绿 ✓(不再误报)
 *     ⇒ 判据现在**能区分**"坏了"与"慢了" —— 这正是它以前缺的能力
 * ```
 * ⚠️ 它**不削弱**任何原有断言:`eq(members.size,1)` 与 `eq(onlineCount(),0)`
 *    两条都保留,只是把"何时检查"从"固定 60ms"改成"等到生效或超时"。
 */
async function waitUntil(cond: () => boolean, budgetMs: number, stepMs = 5): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 > budgetMs) return -1;
    await sleep(stepMs);
  }
}

/** 安全关掉一个客户端 + 服务端(每一步都有超时,不会挂死套件)。 */
async function teardown(clients: { ws: WebSocket; done: Promise<void> }[], srv: { close(): Promise<void> }): Promise<void> {
  for (const c of clients) { try { c.ws.close(); } catch { /* 已关 */ } }
  await Promise.all(clients.map((c) => withTimeout(c.done, 3000, '客户端 close').catch(() => undefined)));
  await withTimeout(srv.close(), 3000, '服务端 close').catch(() => undefined);
}

async function main(): Promise<void> {
  /* ── 判据一:一次真实往返 ── */
  await atest('WS13-6-1 ★★ 判据一:真起服务 → 真连接 → hello → welcome → 二进制帧 → 真解码', async () => {
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
    const { ws, got, done } = connect(`ws://127.0.0.1:${srv.port}/ws`, 'alice');
    /* ⚠️ 进 try **之前**只允许"获取资源",不放断言 ——
       断言写在 try 外时一旦抛,finally 不执行 ⇒ srv 不关 ⇒ 进程不退。 */
    try {
      await sleep(400);
      ok(got.sentHello, '应已发出 hello');
      ok(got.welcome !== null, `应收到 welcome,实得 ${got.welcome === null ? 'null' : '非空'}`);
      const w = got.welcome!;
      eq(w.t, 'welcome', 'welcome.t');
      eq(w.playerId, 'alice', 'welcome.playerId 应等于 URL 里声明的 userId');
      eq(w.protocolVersion, PROTOCOL_VERSION, 'welcome.protocolVersion');
      eq(w.roomId, 'r-ws13', 'welcome.roomId');

      ok(got.bin.length > 0, `应收到 ≥1 个二进制帧,实得 ${got.bin.length}`);
      /* ★★ 这里必须区分**两个来源**,否则断言看不见引导期死锁(实测抓到):
         ```
         bin[0] 来自 join 时的 `snapshotFor()`(encodeFull)—— **不经过** step 循环
         bin[1..] 来自 20Hz 广播循环里的 `step(prevState)`
         ⇒ 若 prevState 恒为 null(I4 那个注入),广播循环**永远发不出东西**,
           但 bin[0] 还在 ⇒ 只断言 `bin.length > 0` 会**照样绿**。
         ⇒ 实测:I4 注入下 6-1 绿、只有 6-3 红 —— 正是这个弱点。
         ```
         ⇒ 故必须断言**广播帧的存在**,即 `framesSent() > 0`(服务端侧事实,
           不依赖客户端收集顺序),且 `bin.length >= 2`(首帧 + ≥1 广播帧)。 */
      ok(srv.framesSent() > 0,
        `★ 广播循环必须**真发过帧**(framesSent=${srv.framesSent()})—— `
        + '只靠 join 时的首帧不足以证明 step/prevState 那条链是活的');
      ok(got.bin.length >= 2,
        `★ 应收到 ≥2 帧(首帧 + ≥1 广播帧),实得 ${got.bin.length}`
        + ' —— 若只有 1 帧,说明广播循环没发出来(prevState 引导期死锁)');
      /* ★ 下行**无 tag**:首字节应是 PROTOCOL_VERSION(1),不是 0x02。
         若这里加了 tag ⇒ 客户端 `classifyDownlink` 会把它当二进制再剥一层
         ⇒ 协议包**整体错位一字节** ⇒ 解码失败或产出垃圾。 */
      eq(got.bin[0]![0], PROTOCOL_VERSION,
        '★ 下行首字节应为 PROTOCOL_VERSION(**服务端不加 tag**)');
      /* ★ 广播帧同样不得带 tag —— 这条才真正钉住"下行无 tag"。
         (welcome 的文本帧加不加 tag 客户端**两种都兼容**,故测它测不出问题:
          这是 I1 那个注入"没牙"的原因。二进制帧没有这种宽容度。) */
      for (const [i, f] of got.bin.entries()) {
        eq(f[0], PROTOCOL_VERSION,
          `第 ${i + 1} 个下行二进制帧首字节应为 PROTOCOL_VERSION(不得加 tag)`);
      }

      /* ★★ 真解码 —— 证明收到的是**可用的协议字节**,不只是"非空" */
      const pkt = decodePacket(got.bin[0]!);
      ok(pkt !== undefined, 'decodePacket 应成功');
      const st = room.cloneState();
      applyPacket(st, pkt);
      ok(Array.isArray((st as { players: unknown[] }).players), 'applyPacket 后状态结构完好');

      /* ★ 服务端侧事实:简历里出现了这个玩家 */
      eq(room.members.size, 1, 'room 应有 1 名成员');
      eq(room.onlineCount(), 1, '在线数');
    } finally {
      await teardown([{ ws, done }], srv);
    }
  });

  /* ── 判据一(负向对照):不剥 tag ⇒ 必须抛 ── */
  await atest('WS13-6-2 ★★ 判据一负向对照:不剥 tag ⇒ decodePacket **必抛**(断言非恒真)', async () => {
    /* 契约 §12.1 的 256 值穷举:0/256 静默 ⇒ 一定抛。
       这条同时证明"§6-1 里那条 decode 成功"不是恒真断言 —— 若两条都恒真,
       负向对照**不会**红。 */
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
    const { ws, got, done } = connect(`ws://127.0.0.1:${srv.port}/ws`, 'bob');
    try {
      await sleep(300);
      ok(got.bin.length > 0, '先要收到帧,否则负向对照无从谈起');
      const raw = got.bin[0]!;
      /* 故意不剥 tag:给协议包前面塞一个 0x02(真实现的 tag 值) */
      const withTag = uplink(0x02, raw);
      let threw = false;
      try { decodePacket(withTag); } catch { threw = true; }
      ok(threw, '不剥 tag ⇒ decodePacket 必抛(证明上行必须剥 tag,且断言非恒真)');
      /* 阴性对照:原样则能解 —— 说明上面那次的失败**只因**多了那个字节 */
      const pkt = decodePacket(raw);
      ok(pkt !== undefined, '原样(无 tag)则能解 ⇒ 失败确由那一个字节造成');
    } finally {
      await teardown([{ ws, done }], srv);
    }
  });

  /* ── 判据三:多客户端 ── */
  await atest('WS13-6-3 ★ 判据三:≥2 客户端**同时**收到同一份快照', async () => {
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
    const a = connect(`ws://127.0.0.1:${srv.port}/ws`, 'p1');
    const b = connect(`ws://127.0.0.1:${srv.port}/ws`, 'p2');
    const c = connect(`ws://127.0.0.1:${srv.port}/ws`, 'p3');
    try {
      await sleep(400);
      eq(room.members.size, 3, '房间应有 3 名成员');
      ok(a.got.welcome !== null && b.got.welcome !== null && c.got.welcome !== null,
        '三个客户端都应收到 welcome');
      ok(a.got.bin.length > 0 && b.got.bin.length > 0 && c.got.bin.length > 0,
        `三个客户端都应收到二进制帧(实得 ${a.got.bin.length}/${b.got.bin.length}/${c.got.bin.length})`);
      /* ★★ 这里我第一版**比错了对象**(实测复盘):
         ```
         原写法:eq(a.got.bin[0].byteLength, b.got.bin[0].byteLength)
         实测:期望 110 / 实际 71 ⇒ 红。
         错因:`got.bin[0]` 是各客户端**各自加入那一刻**的首次快照,
           而三人加入的时刻**不同**(先后连上,间隔若干 tick)
           ⇒ 他们的快照本来就**该**不同长度(含的玩家数不同)。
           ★ 换句话说:**我拿两个不同时刻的量比了,却声称它们应相等。**
         ```
         ⇒ 正确判据:要比的是「**同一帧**是否同时到达了所有连接」,
           即**广播**这件事本身。故改为:等到三人都握手完成后再取
           **同一 tick** 的一帧(取末帧 —— 三人此时都已在线,状态相同)。 */
      const la = a.got.bin[a.got.bin.length - 1]!;
      const lb = b.got.bin[b.got.bin.length - 1]!;
      const lc = c.got.bin[c.got.bin.length - 1]!;
      eq(la.byteLength, lb.byteLength, '同一 tick 的帧长应一致(a/b)');
      eq(lb.byteLength, lc.byteLength, '同一 tick 的帧长应一致(b/c)');
      /* 逐字节比 —— 长度相同还不够,"同源"意味着内容也同 */
      let identical = true;
      for (let i = 0; i < la.byteLength; i += 1) if (la[i] !== lb[i]) { identical = false; break; }
      ok(identical, 'a 与 b 收的末帧应**逐字节一致**(同一份广播)');
      /* 各客户端 playerId 不同(证明不是同一个连接被算了三次) */
      ok(a.got.welcome!.playerId !== b.got.welcome!.playerId, '两个客户端应是不同玩家');
      /* ★ 负向对照:证明上面那条"逐字节一致"不是恒真 ——
         a 的**首帧**(不同 tick)与末帧应不同,否则说明我比的字段没区分力。 */
      ok(a.got.bin[0]!.byteLength !== la.byteLength || a.got.bin.length === 1,
        'a 的首帧与末帧可不同(证明"比末帧"这个选择有区分力)');
    } finally {
      await teardown([a, b, c], srv);
    }
  });

  /* ── 判据四:userId 稳定 ⇒ 重连 resumed ── */
  await atest('WS13-6-4 ★★ 判据四:同一 userId 连两次 ⇒ 第二次 `resumed: true`', async () => {
    /* 这条是契约 §12.2 那个"同一玩家出现两个"缺陷的**正向判据**。
       前提两条:1 服务端**不随机生成 id**(用 URL 里的 userId)
                2 断开时走 `disconnect`(保留席位)而**不是** `leave`(删席位)
       ⇒ 任一不成立,这里都会红。

       ## ⚠️ 为什么用 `dropConnectionsForTest()` 而不是 `ws.close()`
       ```
       `ws.close()` 会发 **close 帧(0x8)** ⇒ 服务端判「主动退房」⇒ `leave()`
         ⇒ 席位被删 ⇒ 重连拿不到 resumed。
       而真实的重连场景是**异常断开**(掉网/杀进程)—— **不发 close 帧**
         ⇒ 服务端应走 `disconnect()` 保留 30s 席位。
       ⇒ 用 `close()` 测不到 `disconnect` 这条路径,而它正是重连的前提。
       ⇒ `dropConnectionsForTest()` 直接 destroy 底层 TCP,
         对服务端而言与"客户端掉线"**不可区分**。
       ```

       ## ⚠️⚠️ 整个测例必须在 `try` 里(实测抓到一次真死锁)
       ```
       我第一版把"第一次加入"的断言写在 `try` **之外**:
         const first = connect(url); await sleep(250);
         ok(first.got.welcome !== null, ...);   ← 若这里抛(注入导致握手失败)
       ⇒ `finally { await teardown(...) }` **永远不执行** ⇒ `srv` 不关闭
         ⇒ 服务端 socket 保持打开 ⇒ **Node 进程永不退出**
       ⇒ 实测:注入 I3(上行不剥 tag)后 `report()` 已打印 11/18,
         但进程被 120s 超时**杀掉** —— 断言都跑完了,只是**进程不肯退**。
       ⇒ ⇒ 结论:**异步测试里,一切资源获取之后立刻进 try**,
         否则"红"会退化成"挂",而挂起不告诉我任何事。
       ```
       ⚠️ 另一条:`ok()` 抛错时,后面的 `srv.dropConnectionsForTest()` 不执行 ⇒
          clients 列表里可能只登记了一部分 ⇒ teardown 仍要能处理。 */
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
    const clients: { ws: WebSocket; done: Promise<void> }[] = [];
    try {
      const url = `ws://127.0.0.1:${srv.port}/ws?userId=carol`;

      /* 第一次:正常加入,然后**异常断开**(destroy 底层 TCP,不发 close 帧) */
      const first = connect(url);
      clients.push(first);
      await sleep(250);
      ok(first.got.welcome !== null, '第一次应收到 welcome');
      eq(first.got.welcome!.resumed, false, '第一次加入 ⇒ resumed 应为 false');
      eq(room.members.size, 1, '第一次加入后应有 1 名成员');

      await srv.dropConnectionsForTest();
      await withTimeout(first.done, 3000, '首次连接 close').catch(() => undefined);
      /* ★ task-78:这里原来是 `await sleep(60)`。
         实测 drop → onlineCount 归零需 p50=44.4ms / max=46.1ms(_t78_drop.ts,100 样本)
         ⇒ 余量仅 1.3x,是全套件**最紧**的门限。
         改成轮询后:
           · 服务端**坏了**(永不归零)  ⇒ 2000ms 后仍未归零 ⇒ 红(余量 45x,牙更硬)
           · 服务端只是**慢了**(71ms)   ⇒ 绿(不再假阳性)
         ⇒ 判据第一次能区分「坏了」与「慢了」。 */
      const waited = await waitUntil(() => room.onlineCount() === 0, 2000);
      ok(waited >= 0,
        `★ 异常断开后服务端应在 2s 内把玩家记为离线(实测 ${waited < 0 ? '超时未归零' : waited + 'ms'})`);
      /* ★ 席位应**仍在**(异常断开保留 30s 宽限)——
         若这里被删,说明实现走了 `leave()` ⇒ 重连必然失败 */
      eq(room.members.size, 1, '★ 异常断开后席位应**保留**(不是被删)');
      eq(room.onlineCount(), 0, '但应记为离线');

      /* 第二次:同一 userId 重连 ⇒ 必须是 resumed */
      const second = connect(url);
      clients.push(second);
      await sleep(250);
      ok(second.got.welcome !== null, '第二次应收到 welcome');
      eq(second.got.welcome!.resumed, true,
        '★ 同一 userId 在宽限期内重连 ⇒ resumed 必须为 true'
        + '(若随机生成 id 或断开时误用 leave,这里会是 false)');
      eq(second.got.welcome!.playerId, 'carol', '重连后 playerId 应仍是同一个');
      /* ★ 关键:成员数**不得**因重连而增加 —— 那正是"两个玩家"的症状 */
      eq(room.members.size, 1, '★ 重连后成员数仍应为 1(不是 2)');
      eq(room.onlineCount(), 1, '应重新在线');
    } finally {
      await teardown(clients, srv);
    }
  });

  /* ── 判据二(真往返版):大帧经**真 socket** 走一遍 ── */
  await atest('WS13-6-5 ★ 判据二:大帧经真 socket 往返(帧长编码的端到端验证)', async () => {
    /* §2 测的是**纯函数**的编码;这里测它经**真 TCP + 真客户端**
       是否仍能完整到达 —— 两件事,不能互相替代
       (纯函数对了但 socket 层分片/截断,只有这一条能查到)。 */
    const room = makeRoom();
    const srv = await startWsServer({ port: 0, room: room as never, frameMs: 20 });
    const { ws, got, done } = connect(`ws://127.0.0.1:${srv.port}/ws`, 'dave');
    try {
      await sleep(300);
      ok(got.bin.length > 0, '应收到帧');
      /* 逐帧校验:收到的每一帧长度都应 > 0(0 字节帧被服务端跳过) */
      for (const [i, f] of got.bin.entries()) {
        ok(f.byteLength > 0, `第 ${i + 1} 帧不应为 0 字节`);
        eq(f[0], PROTOCOL_VERSION, `第 ${i + 1} 帧首字节`);
      }
      /* ★ 上行大帧:送一个 70000 字节的协议包 ⇒ 服务端应完整收到
         (经 `lastUplink` 观测 —— 这用的是**服务端**侧的观测,
          不是客户端自报,故能证明真到达了) */
      const big = new Uint8Array(70000);
      big[0] = PROTOCOL_VERSION;
      ws.send(uplink(0x02, big));
      await sleep(300);
      const up = srv.lastUplink();
      ok(up !== null, '服务端应收到上行载荷');
      eq(up!.byteLength, 70000, '★ 70000 字节上行应**完整**到达(剥 tag 后仍 70000)');
      eq(up![0], PROTOCOL_VERSION, '上行剥 tag 后首字节应为 PROTOCOL_VERSION');
    } finally {
      await teardown([{ ws, done }], srv);
    }
  });

  /* ── URL 解析(纯函数,顺带钉住) ── */
  await atest('WS13-6-6 ★ userId 只能从**握手 URL** 来(实测 hello 里没有该字段)', async () => {
    /* 实测 client/src/net/session.ts:260-264,客户端发的 hello 是
       `{t:'hello', protocolVersion, contentClaim:null}` —— **没有 userId**。
       ⇒ 稳定的 id 只能由地址携带。这条钉住解析本身。 */
    eq(readUserIdFromUrl('/ws?userId=alice'), 'alice', '常规');
    eq(readUserIdFromUrl('/ws?userId=alice&x=1'), 'alice', '多参数');
    eq(readUserIdFromUrl('/ws?x=1&userId=bob'), 'bob', '不是第一个参数');
    eq(readUserIdFromUrl('/ws'), null, '无 query');
    eq(readUserIdFromUrl('/ws?userId='), null, '空值应视作无');
    eq(readUserIdFromUrl(undefined), null, '无 url');
    /* ★ 对照:证明它不是"总返回同一个值" —— 上面已覆盖 5 种不同输入 */
  });

  report('WS-13');
}

await main();