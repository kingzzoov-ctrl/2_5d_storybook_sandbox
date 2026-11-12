# WS-13 — 零依赖薄 WebSocket 服务端与端到端往返(task-69)

> 阶段 3 服务端另一半。客户端侧已于 `0c8b72b` 完成,但**端到端一步都没跑过**
> (只有单测 + 构建)。本文记录服务端这半的**职责边界、实现与实测证据**。
> 全部结论**读实现实测**得出,不猜;三条会静默失败的约定逐条对照
> `docs/STAGE3-CONTRACT-DRAFT.md` §12。

---

## 1. 职责边界

**本套件负责**:把服务端的二进制快照**真的发给客户端**,并证明这条路端到端能跑。

```
server/src/net/ws_server.ts   ← 零依赖薄 WS 服务端(握手 / 帧解析 / 帧生成 / close)
server/src/sim/ws_demo.ts     ← 可跑入口:默认**有界自检**(跑完即退、带退出码)
                                 `--serve` 才是常驻演示服务
tests/WS-13.test.ts           ← 20 条断言(本文档配套)
```

**明确不做**(每条都有理由,不是遗漏):

```
· 不引 `ws` 库 —— 它是 @colyseus/ws-transport 的**传递依赖**,
  用它就是「一个实现校验自己」:被测服务端与验证它的客户端走同一份帧实现,
  断言**证明不了**帧解析对不对。故零三方依赖,只用 node:http / node:crypto。
· 不做内容协商的**服务端半** —— `contentClaim` 服务端还不读(契约 §12.5)。
  本服务端只**透传** welcome 里的指纹,不据此拒绝。
· 不管重连的**语义** —— 30 秒宽限期在 room.ts。本文件只保证「userId 稳定」。
· 不主动 ping —— 契约 §13 已如实记为未覆盖项。
· **不 import world_sim.ts** —— 推进是 `room.step()` 的事(task-59 已接),
  本文件只调 `step()` 并广播它的返回值(运输层不该知道世界节拍)。
```

---

## 2. 接口

### 2.1 对外导出

```ts
/* 帧层(纯函数,可单测) */
acceptKey(key: string): string              // 握手:base64(sha1(key + GUID))
encodeFrame(op: number, payload: Uint8Array): Uint8Array
parseFrame(buf: Uint8Array): ParsedFrame | null   // 不足一帧 ⇒ null(不抛)
encodeClose(code?: number, reason?: string): Uint8Array
classifyUplink(payload: Uint8Array): UplinkKind   // ★ 上行分流的**唯一**依据
readUserIdFromUrl(url: string | undefined): string | null

/* 服务端 */
startWsServer(opts: WsServerOptions): Promise<WsServerHandle>
```

### 2.2 `WsServerHandle`

```ts
port: number
connCount(): number          // 已握手且未断的连接数
framesSent(): number         // ★ 已广播的**非空**帧数(0 字节帧不计)
lastFrameBytes(): number     // 最近一帧字节数
lastUplink(): Uint8Array | null   // ★ 最近收到的上行载荷(**已剥 tag**)
dropConnectionsForTest(): Promise<void>  // 仅供测试:模拟异常掉线
close(): Promise<void>
```

### 2.3 `WsRoomLike`(结构化类型,不 import `room.ts`)

```ts
readonly id: string
step(prevSnapshot: unknown): Uint8Array
snapshotFor(userId: string): Uint8Array
join(input): { ok: boolean; reason?: string; resumed?: boolean }
leave(userId: string): boolean
disconnect(userId: string): boolean
cloneState(): unknown
```

⚠️ **刻意不出现模拟层类型名** —— 与 `room.ts:275` 那条 US2 探针纪律一致。

---

## 3. 数据结构

```ts
type ParsedFrame = {
  op: number;          // opcode(0x1 文本 / 0x2 二进制 / 0x8 close / 0x9 ping / 0xa pong)
  fin: boolean;        // 分片结束位
  payload: Uint8Array; // 已按掩码解出的载荷
  consumed: number;    // ★ 本帧占用的总字节数(含头),供调用方推进游标
};

type WsConn = {
  userId: string | null;        // ★ 稳定 id,**不随机**
  socket: Socket;
  buf: Uint8Array;              // ★ 残帧缓冲区(跨 data 事件保留)
  closed: boolean;
  helloDone: boolean;
  closeFrameSeen: boolean;      // ★ 决定断开时用 leave 还是 disconnect
  declaredUserId: string | null;
  urlUserId: string | null;     // ★ 唯一能拿到稳定 id 的地方
};
```

### 3.1 ★★★ 上行/下行的帧头**不对称**(契约 §12.1)

```
下行(服务端 → 客户端)= **裸协议字节,无 tag**
  实测 room.ts 三处出口全部直接返回 .bytes:
    L642  encodeFull(state, tick).bytes
    L1154 step(prev) → encodeDelta(...).bytes 或 new Uint8Array(0)
    L1349 snapshotFor(userId) → encodeFull(...).bytes
  ⇒ 本服务端**绝不**给自己下发的内容加 tag。

上行(客户端 → 服务端)= **[1 字节 tag][payload]**
  实测 session.ts L127-133:FRAME_TEXT=0x01 / FRAME_BINARY=0x02
  ⇒ 本服务端**必须**剥掉首字节。
```

**不剥会怎样**:契约 §12.1 的 256 值穷举证明 **0/256 静默**(全部抛出)。
⇒ 所以不剥是一条**清晰错误**;WS-13 仍为它写负向对照,理由不是"可能静默",
而是**要证明这条路径真被测到了** —— 一条永远不红的断言等于没写。

---

## 4. 算法

### 4.1 帧长三形态(`encodeFrame`)

```
len ≤ 125         ⇒ 2 字节头(1B 长度)
126 ≤ len ≤ 65535 ⇒ 4 字节头(126 + 2B 大端)
len ≥ 65536       ⇒ 10 字节头(127 + 8B 大端)
```

⚠️ **8 字节长度域必须分段写**:JS 位运算只到 32 位,`len >>> 32` 等价于
`len >>> 0`(会拿到低位)⇒ 静默发错长度。本实现用
`hi = floor(len / 0x100000000)` + `lo = len >>> 0` 分段。

### 4.2 ◀ 解析必须能吃"半个帧"与"两个帧"

```
WS 是字节流 ⇒ 一次 data 事件可能带来半个帧(TCP 不保证边界),也可能两个。
⇒ parseFrame 不足一帧时返回 null,并给出 consumed 让调用方推进游标。
⇒ **绝不假设一 data 一帧**。
```

### 4.3 ★★★ 上行分流的唯一依据:**载荷 tag**,不是 WS opcode

```
实测:Node 24 内置 WebSocket 把 `Uint8Array` **一律发成 opcode 0x2**,
      哪怕语义是文本(session.ts:266 传的正是 Uint8Array)。
⇒ 第一版把 hello 解析写在 `if (f.op === OP_TEXT)` 里
  ⇒ **那个分支永远进不去** ⇒ 握手永不完成
  ⇒ 症状:TCP 连上、帧也收到了、**房间却一个人都没有**,且不报错。
⇒ 故 OP_TEXT 与 OP_BINARY 走**同一个** classifyUplink(只看 tag)。
```

⚠️ **这与下行不对称,而且是必然的**:
```
下行:客户端 classifyDownlink **不能**信 tag ——
  因为 FRAME_TEXT(0x01) 与 PROTOCOL_VERSION(1) **撞值**,
  而服务端下行是裸包(首字节就是 1)⇒ 只能靠内容特征(以 `{` 开头)。
上行:服务端**能且必须**信 tag —— 因为上行一定带 tag,而 opcode 不可靠。
⇒ 两个方向判据不同,不是不一致,是各自的约束不同。
```

### 4.4 ★ 广播循环的引导期

```
step(prev) 的语义是「相对 prev 的差量」。
第一帧 prev=null 时它**故意**返回空(room.ts:1154)——
  那不是"编码失败",是"还没有基准"。
⇒ 基准的推进**与"这帧发不发得出去"无关**:哪怕本帧没发给任何人,
  基准也必须走到当前世界,否则下一帧的差量是"从创世到现在的全部差异"。
```

---

## 5. 参数

| 参数 | 默认 | 说明 |
| :--- | :--- | :--- |
| `port` | `0`(随机) | 传 0 ⇒ 由内核分配,`handle.port` 返回真端口 |
| `frameMs` | `50` | 广播间隔 = **20Hz**,与 `SIM_FAST_DT = 0.05` 对齐 |
| `room` | 必填 | `WsRoomLike` |
| `onLog` | 空函数 | 诊断用 |

**协议常量**:`PROTOCOL_VERSION = 1`(与 `shared/net/delta.ts` 同值,
但**刻意不 import** —— 运输层不该依赖协议内容;一致性由 WS-13 §6-1 断言钉住)。

**握手 URL**:`ws://host:port/ws?userId=<稳定 id>` ——`userId` 是可选 query,
但它**决定这条连接有没有重连能力**(见 §7)。

---

## 6. 性能

```
· 帧生成:O(n) 单次拷贝(n = 载荷字节)。大帧走 10 字节头,无额外分配。
· 帧解析:O(n)。残帧拼接每 data 事件一次 O(buf + chunk) —— 网络正常时
  buf 为空 ⇒ 退化为 O(chunk)。
· 广播:每帧对每个已握手连接一次 socket.write。N 连接 ⇒ O(N × 帧长)。
· 实测(本机):20Hz × 3 连接,末帧 10B(状态未变时),无背压问题。
```

⚠️ **未做的优化**:残帧拼接是整体重分配;若某连接长时间只收到半个大帧,
缓冲区会持续增长。生产接大帧应加**长度上界**(超过即判协议错误断开)。
本实现未加,如实记在 §9。

---

## 7. 边界

### 7.1 会静默失败的三条(全部已实测,参见契约 §12)

```
① **0 字节帧 = 「本 tick 无差量」,不是坏包**(§12.3)
   room.ts:1154 在 prevSnapshot 为 null 时返回空 Uint8Array。
   空数组交给 decodePacket 会抛(「报文截断:需要 1 字节,剩余 0」)。
   ⇒ 本服务端**跳过**发送 0 字节帧,**不重试、不补发、不当错误**。
     (补发会改变协议语义:客户端会把"无差量"当成"有内容")

② ★★★ **userId 必须跨连接稳定**(§12.2)
   实证:`input.token` 被读 **0 次**;真判据是 `members.get(input.userId)`。
   ★ 又实测:**客户端 hello 里没有 userId**(session.ts:260-264 只有
     `{t, protocolVersion, contentClaim}`)。
   ⇒ 稳定的 id 只能由**握手 URL 的 query** 携带。
   ⇒ 本服务端**不随机生成**:URL 优先,退回连接序(带 `c` 前缀),
     并在日志里把"拿不到稳定 id"**显式说出来**。
   ⇒ 若每连接随机:重连走全新加入、旧席位留 30s ⇒ **同一玩家出现两个**,不报错。

③ ★ **断开必须用 `disconnect`,不是 `leave`**
   第一版写错:socket 一关就 `leave()` ⇒ **席位立即删除** ⇒
     宽限期形同不存在 ⇒ 重连变全新加入 ⇒ 玩家丢掉全部状态
     (角色/等级/位置),而他自己以为只是重连了一下。
   实测症状:`resumed` 恒为 **false**。
   ⇒ 正确:收到 close 帧(0x8)⇒ `leave()`;异常断开 ⇒ `disconnect()`。
     参考实现同款:`room.colyseus.ts:150-152`。
```

### 7.2 客户端帧**必须带掩码**(RFC 6455 §5.3)

```
实测内置客户端确实掩码。本解析器**要求**掩码位为 1 ——
若为 0 说明对端不是合规 WS 客户端(或字节流错位)⇒ **显式抛错**,
不静默按无掩码读(那会把帧头当载荷,产出看似合理实则垃圾的数据)。
```

### 7.3 大端 8 字节 / 位运算 32 位

见 §4.1。这是本文件唯一"数学上"容易写错的地方,已由 WS-13 §2-2 钉住。

---

## 8. 耦合

### 8.1 上游依赖(全部实测签名)

```
shared/net/delta.ts        PROTOCOL_VERSION / encodeFull / encodeDelta / decodePacket / applyPacket
server/src/net/room.ts     RoomRuntime: join / step / snapshotFor / cloneState / leave / disconnect
client/src/net/session.ts  帧头约定(FRAME_TEXT=0x01 / FRAME_BINARY=0x02 / JSON_PREFIX=0x7B)
docs/STAGE3-CONTRACT-DRAFT.md §12 跨端线上契约(本文逐条对照)
```

### 8.2 ★ 与 task-59 的关系(不是重复,是两件事)

```
task-59 修「**服务器路径**从不推进 sim」→ room.step() 里接上 host.advance(1)
本任务 修「**服务端根本没把字节发出去**」→ ws_server.ts 从零实现
⇒ 两者是并列的两项:缺任一都不可端到端。
   task-59 修完 ⇒ 世界会跑,但**没有运输层** ⇒ 客户端收不到。
```

### 8.3 ★★ 双重推进:两个 20Hz 嵌套(实测踩到)

```
room.step() 里已接 `host.advance(1)` ⇒ 由 ws_server 的 50ms 广播循环调用。
若 demo **也**起一个 50ms 定时器调 advance(1)
  ⇒ **每帧推进两次** ⇒ 世界快 2 倍。
★ 实测证据(第一版 demo 里):
    `[sim] 已推进 40 快帧 · 世界帧号 80`
  —— 只调了 40 次,世界帧号却是 80 ⇒ 每帧被推两次。
  而**没有任何断言报红**:welcome 到了、帧在发、客户端在更新,
  唯一现象是"世界比它该有的快一倍"。
⇒ 故 demo **默认不自推**;`--advance` 只用于绕开 room 推进的特殊场合,
  并配一个观测器(打印**世界侧**帧号,不是自己的调用次数 ——
  只数调用次数看不见双重推进,这正是它隐蔽的原因)。
```

### 8.4 ★★ 两个新文件的可达性:一条入口登记即可,不必改装配根

```
可达性门禁从 `PROD_ENTRIES` 做 import 闭包。两个新文件若谁都不可达,
会被报成「新增未登记的不可达模块」。三条路:
① 登记进 UNREACHABLE_EXEMPT(把"设计如此"写成"欠账")
② 在装配根 `server/src/index.ts` 里 import 一下
③ ★ 把 `ws_demo.ts` 加进 `PROD_ENTRIES`(它是一个**入口**)
```

**实测选 ③**,且**不需要** ②。证据(闭包探针,对 HEAD 版 `index.ts`):
```
基线(4 个入口)                        闭包 82 个,ws_server.ts **不在**内
加入 'server/src/sim/ws_demo.ts'(5 入口) 闭包 84 个,净增 **2** 个:
                                          + server/src/sim/ws_demo.ts
                                          + server/src/net/ws_server.ts
```
⇒ ★ **一条入口登记同时点亮两个文件** —— 因为 `ws_demo.ts` 本来就
import 了 `ws_server.ts`。这正是"可达性应沿真实的依赖边走"的体现。

### 8.4.1 ★ 我曾走过 ②,实测后**自己撤销了**(留下记录,免得重走)

```
我最初在 `server/src/index.ts` 加了一行 `import { startWsServer }` +
一次 `typeof` 断言,理由是"让装配层认识运输层"。
⇒ 加上它之后量:基线闭包 83(净增 1 个) ⇒ 看似"干净登记"。
★ 但那个 83 是**被我自己改动后的**基线 —— 我把 ② 的成果算进了"存量"。
⇒ 还原 index.ts 再量,才看出:**光靠 ③ 就已经净增 2 个、两个文件都点亮**。
⇒ ⇒ 结论:② 是**多余的**;而且它越界了(task-69 写域不含 `index.ts`)。
⇒ 处置:**已 `git checkout` 还原**,`index.ts` 与 HEAD 逐字节一致。
```

⚠️ 这条值得记下来,因为它是一个**测量陷阱**:
```
我在"已改过 A"的状态下量"再加 B 的效果",然后把 A 的成果当成存量。
⇒ 表现是净增从 2 变成 1,看起来"更干净" ⇒ 反而像是 A 有价值。
⇒ ⇒ 教训:**量"某改动值不值"时,必须从**未改动**的基线量起。**
   否则会把"它已经生效了"误读成"它原来就在那儿"。
```
★ 附带一条:这也说明 **③ 优于 ②** 不只因为少一个改动 ——
`ws_demo.ts` 是**真的入口**(会被运行),`index.ts` 里那行 import
只是为了"被门禁看见"。**让可达性沿真实使用关系走,而不是靠引用占位。**

### 8.5 ★★ `ws_demo.ts` 为什么必须**默认可跑自检**、`--serve` 才常驻

```
本文件是**入口**(与 `server/src/sim/demo.ts` 同类)⇒ 要进 `PROD_ENTRIES`
  ⇒ 而门禁的「入口可加载性」会**在子进程里 import 它**
    (`verify.ts:998` 的探针:`import(rel).then(() => process.exit(0))`)。
★ 若一被 import 就 `listen` 一个**固定端口**:
  · 门禁跑期间会真占端口 ⇒ 与并发测试/演示**撞端口**;
  · 且它会**一直活着** ⇒ 探针的 `process.exit(0)` 成了唯一出路
    ⇒ 门禁表面"通过",实际**每次跑门禁都起了一次服务**。
⇒ 故默认走**有界自检**:绑定 `port: 0`(内核分配)、跑完即**显式退出**并给退出码。
⇒ 与 `demo.ts` 同形(它也是"跑完一段自检就 exit")。
```

### 8.6 ★ 失败必须同时走 **stderr**(门禁正确性,不是噪声洁癖)

```
门禁探针只从 stderr 里找 `LOAD_FAIL::`,而 `import()` 的成功分支是
"立刻 exit(0)" —— 即**只有模块顶层抛错才算失败**。
⇒ "跑完自检、发现问题、再 exit(1)"这种形态不在那条判据的**直读**视野内。
⇒ 故失败时**同时**往 stderr 写一行 `LOAD_FAIL::SelfCheck | ...`。
⇒ 实测牙齿(注入"上行不剥 tag" ⇒ 握手失败 ⇒ 自检必红):
     基线:status=0 无标记
     注入:status=1 **有标记** ✓
     还原:SHA-256 一致,基线复核 status=0
⇒ 两种探针形态都能判红,不依赖对方怎么读退出码。
```

---

## 9. 验收(**实测输出**,非推导)

```
✅ 判据一 一次真实往返       WS13-6-1(20/20 全绿)
✅ 判据一 负向对照(不剥tag必抛) WS13-6-2
✅ 判据二 帧长边界 125/126/127/1000/70000 + 65535/65536  WS13-2-1/2-2/2-3
✅ 判据二 大帧经真 socket     WS13-6-5(70000B 上行完整到达)
✅ 判据三 多客户端 ≥2         WS13-6-3(3 客户端,末帧逐字节一致)
✅ 判据四 userId 稳定 ⇒ resumed WS13-6-4
✅ 零三方依赖                WS13-5-1(源码里无 `from 'ws'`)
✅ 只读自证                  WS13-5-2(SHA-256 一致)
✅ ★★ 跨端字段集一致          WS13-5b-1(双向差集)/ WS13-5b-2(welcome 覆盖)
```

### 9.0 ★★ 新增的跨端断言当场抓出三件事(Lead 在登记表里点名要求的)

`judgement_baseline.ts:432` 预登记时写明:「把"两侧字段集一致"作为**跨端断言**
补进服务端套件(task-69 的 WS-13);**在那之前,这条是登记在案的已知风险**」。
补上之后,它**立刻**抓到三处 —— 每处都是真的:

```
① 服务端镜像写成 `type HelloFrame = {...}`,客户端是 `export interface HelloFrame`
   ⇒ 形态不一致 ⇒ 机械比对**抠不出服务端这一侧** ⇒ 断言当场红。
   ⇒ 修:统一为 `export interface`。★ **形态本身是契约的一部分**。

② 我在镜像里加了 `userId?`(理由:"客户端将来可能发")
   ⇒ 断言报「服务端镜像**多** userId ⇒ 它以为能收到而客户端从不发」
   ⇒ ★ 那条是对的:一个**谁都不发**的字段,只会让下一个人以为
     "已经有这条路了" —— 这正是契约 §12.2 那个失败模式的镜像。
   ⇒ 修:删掉它。稳定 id 只走 URL query。

③ ★ **我自己的解析器有 bug**:welcome 字段提取的正则从 `t:` **之后**开始捕获
   ⇒ `t` 恒被判成"漏发"(误报)。
   ⇒ ★ 这一条尤其值得记:**判据报的第一个嫌疑人可能是判据自己**。
     与 Lead 的陷阱 73(「一个不可能的值要先怀疑判据」)同款。
```

**牙齿**:四条注入(删字段/加字段/漏发 playerId/退回 `type` 形态)全部变红,
SHA-256 全部还原。

---

## 9.1 六条故障注入全部有牙(每条注入后断言变红,SHA-256 全部还原一致)

| 注入 | 内容 | 红的断言 |
| :--- | :--- | :--- |
| I1 | 给**二进制下行**加 0x02 tag | WS13-6-1, 6-2, 6-5 |
| I2 | 帧长分界写错(125 也走 126 分支) | WS13-2-1 |
| I3 | 上行不剥 tag | WS13-4-1, 4-2, 6-1~6-5 |
| I4 | ★ prevState 只在"发出去了"时更新 | WS13-6-1, 6-3 |
| I5 | ★ 断开时用 leave 而不是 disconnect | WS13-6-4 |
| I6 | 不要求客户端帧掩码 | WS13-3-3 |
| J1 | 客户端镜像**少**一个字段(删 contentClaim) | WS13-5b-1 |
| J2 | 客户端镜像**多**一个字段(加 neverSent) | WS13-5b-1 |
| J3 | 服务端 welcome **漏发** playerId | WS13-5b-2, 6-1, 6-3, 6-4 |
| J4 | 镜像退回 `type X = {}` 形态(解析器抠不出) | WS13-5b-1 |

### 9.1 我在本任务里**自己踩到**的三个缺陷(全部已修,已入断言)

```
① **上行分流看 opcode** ⇒ 内置客户端把 Uint8Array 发成 opcode 0x2
   ⇒ hello 分支永远进不去 ⇒ 房间一个人都没有、不报错。
   修:只看载荷 tag。断言:WS13-4-1。

② **prevState 只在"发出去了"时更新** ⇒ 恒为 null ⇒ step(null) 恒返回空
   ⇒ **一个字节都发不出去**,framesSent 恒 0,不报错。
   修:无条件更新基准。断言:WS13-6-1(含 srv.framesSent() > 0)。

③ **断开时用 leave** ⇒ 席位立即删除 ⇒ 宽限期形同不存在
   ⇒ resumed 恒 false ⇒ 重连丢全部状态。
   修:区分主动/异常,分别 leave / disconnect。断言:WS13-6-4。
```

### 9.2 ★ 牙齿验证本身抓出的两个"我的断言不够好"

```
① I1 第一版注入打在 **welcome 文本帧**上 ⇒ **没牙**。
   原因实测:客户端 classifyDownlink **本来就兼容带 tag 的 JSON**
   (它专门写了 `0x01 + {` 那条规则)⇒ 给 welcome 加 tag **不是缺陷**。
   ⇒ 教训:**注入物必须是缺陷本体**;打在"宽容的一侧"测不出来。
   ⇒ 已改注入**二进制下行**那一半。

② I4 第一版只让 6-3 红,6-1 **没红**。
   原因:`bin[0]` 来自 join 时的 `snapshotFor()`,**不经过** step 循环
   ⇒ 只断言 `bin.length > 0` 会**照样绿**。
   ⇒ 已补:断言 `srv.framesSent() > 0` 且 `bin.length >= 2`。
```

### 9.3 ★★★ 我犯的第四个错:**「避开检测器」不是「补上覆盖」**(Lead 复核指出)

```
## 事情经过

WS13-5-1 的**目的**是"检查 ws_server.ts 有没有引 ws 库"。
我第一版写 /from\s+['"]ws['"]/ —— **只认静态 from**。

判据形态审计的检测器 C(judgement_audit.ts:820)报我 4 处未登记命中:
「import 探测只认 from,未覆盖裸副作用导入与动态 import()」。

★ 我把正则**拆成 `const F = 'from'` 拼起来**,让 C 不再报。
   理由写的是:「它们是测试自己要匹配的字符串,不是 import 探测逻辑」。

⇒ ⇒ **那个理由错了**。这条断言的**目的**就是做 import 探测 ——
   而 C 的实质主张**成立**:裸副作用 import 'ws'、动态 await import('ws')
   两种写法**都漏**。
```

#### 实测(修前 × 六种写法,Lead 给的表我独立复现)

| 写法 | 样例 | 修前 | 修后 |
| :--- | :--- | :--- | :--- |
| 静态 from | `import WebSocket from 'ws'` | 抓 ✓ | 抓 ✓ |
| 具名 from | `import { Server } from 'ws'` | 抓 ✓ | 抓 ✓ |
| **裸副作用** | `import 'ws'` | **漏 ★** | **抓 ✓** |
| **动态 import** | `await import('ws')` | **漏 ★** | **抓 ✓** |
| require | `require('ws')` | 抓 ✓ | 抓 ✓ |
| 相对路径(不该算) | `import x from './ws.ts'` | 漏 ✓ | 漏 ✓ |

#### 修法(两条正则**并存**,不能互相替代)

```
IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|(?<![\w.])import\s*\(?\s*)['"]([^'".][^'"]*)['"]/g
REQUIRE_WS_RE       = /require\s*\(\s*['"]ws['"]\s*\)/     // 上一条**不管** require
```
分解:`\bfrom\s*` 管静态;`import\s*\(?\s*` 前加**负向后顾** `(?<![\w.])`
⇒ 一次覆盖裸副作用(无括号)与动态(有括号),同时挡住 `foo.import(`;
`[^'".]` 首字符规则排掉 `./x`、`../x`(相对路径不是包名)。

#### ★★ 由此得一条要分清的差别

```
「避开检测器」  ⇒ 你不再被提示,缺口**还在**
「补上覆盖」    ⇒ 断言真的守住它声称的东西
```
我仍同意「**能改掉的形态就不要登记掉**」—— 但**前提是那段代码真的不该有那个形态**;
而这里该有的是**更强的形态**。

#### 覆盖面做成了**表格式断言**(12 行,不是"我想到的那几种")

```
FORMS = 12 种写法 × {sample, wantCatch}
⇒ 逐行比对,不符即 eq(wrong.length, 0, ...) 并列出是哪几行
⇒ 对将来谁改正则:漏掉哪一行都会红
⚠️ 表里**两侧都有**(要抓的 + 不该抓的)—— 否则不是覆盖面测试
```

#### 四条注入(全部实测有牙,SHA-256 逐字节还原)

```
I1 正则退回「只认 from」(第一版的形态)  ⇒ WS13-5-1 红
I2 去掉首字符规则 [^".]                ⇒ WS13-5-1 红
I3 去掉负向后顾 (?<![\w.])             ⇒ WS13-5-1 红
I4 给 REQUIRE_WS_RE 加 /g              ⇒ WS13-5-1 红
```

#### ⚠️ I2 / I4 第一轮**没牙** —— 查出的原因值得单独记

```
I2 首字符规则:
  去掉它 ⇒ 说明符列表**变长了**(['./ws.ts'] 被收进来)
  ⇒ 但 importsWsPackage 的判定**完全不变**
    (因为 './ws.ts' !== 'ws' 且不以 'ws/' 开头)
  ⇒ ⇒ **那条规则在我的判据下是冗余的** —— 它守的东西没被任何断言引用
  ⇒ 修:加一条断言"提取器不得把相对路径收进说明符列表" ⇒ 它才真的有东西守着
    (★ 这条**不是**"ws 包判定"的一部分,而是"提取器口径"的一部分)

I4 /g:
  没红 —— 因为被测目标**从不含** require('ws')
  ⇒ 不命中时 JS 把 lastIndex 复位为 0 ⇒ 永远不错位
  ⇒ ⇒ /g 在这里是**潜伏危险**(当前不可触发),不是"没牙"
  ⇒ 实测:/ws/g.test('ws ws') 连调 = true, true, false  ← 交替!
      命中后 lastIndex 前移,下一次从那里找 ⇒ 若目标真含 ws 就会**随机漏**
      ⇒ 而那正是判据该红的那天 ⇒ 那时它反而漏
  ⇒ 修:加"REQUIRE_WS_RE 不得带 /g、不得带 /y"的断言
```

#### ★ 一条可复用的判据

```
一段代码是不是「载荷的」,要看**有没有断言引用它的效果**,
不是看它写得对不对。
⇒ **写对了但没人引用的规则 = 装饰**:改了不会有任何东西红,
   读者却以为它在守什么。
```

### 9.4 ★★ 我在 `assertion-audit.ts` 里抓到的两处(同族)

```
1 **行号全部偏错**(最多 -103 行):
  stripCommentsOnly 把跨行块注释压成**一个空格** ⇒ 换行消失 ⇒ 后面行下标前移。
  实测 tests/WS-FND-01.test.ts:1499 行 → 剥后 1331 行(差 168);
  首部 42 行块注释 ⇒ 之后整体 -41;报 L1025 而**真实 L1128**。
  ★ 难发现的原因:**判据结论是对的**,只有行号错
    ⇒ S1~S5 自检全过,没有任何自检能变红。
  ⇒ 修:替换文本保留原注释的**换行数**(非换行字符换空格)。

2 **_ 前缀口径不一致**(Lead 提醒的开放项,我实测确认存在):
  .gitignore:37 是 `_*` ⇒ 这些文件不进交付物。
  verify.ts:1876 / judgement_audit.ts:1650 / 本文件 [g] 的 walk() **都跳过**,
  ★ 而我的主分类器(原 L1581 的 testFiles)**没跳过**。
  实测:放 tests/_xaudit_probe.test.ts ⇒ 文件数 23 → **24**,输出里出现它。
  ⇒ 后果:报的是**不存在于交付物里**的代码 ⇒ 读者永远找不到那个"问题"。
  ⇒ 今天 tests/ 下 0 个 _ 文件 ⇒ **差异当前不可观测** ⇒ 正因如此更该修。
  ⇒ 修:抽成 listTestFiles() **单一实现**,生产与自检都调它。

3 ⚠️ 修 2 时我**又犯了一次 CR-20**(不造第二份口径):
  第一版自检**自己重算了一遍**清单(带自己的 filter)
  ⇒ 注入实测:删掉**生产那条** filter ⇒ 自检**照样绿**(它测的是自己那份副本)。
  ⇒ 修:过滤只出现一次,两段都调 listTestFiles()。
  ⇒ 加了第二条独立守卫(查已有 _ 文件是否漏进) ⇒ 两段**各自载荷**。
  ⇒ 注入 K1(删生产过滤)/ K2(组合:退回重复实现 + 删生产过滤)现在**都判红**。
```

---

## 10. 未决

```
[ ] **WS 分片帧**(continuation 0x0)—— 本服务端不解分片;内置客户端实测不分片。
    未识别 opcode 会记一条日志(不静默丢),但**不重组**。
[ ] **ping/pong** —— 本服务端**回** pong,但**不主动** ping。
    长连接可能被对端判死;接生产前必须处理。
[ ] **残帧缓冲区无上界** —— 长时间只收半个大帧会让缓冲区持续增长。
    生产应加长度上界(超过即判协议错误断开)。本实现未加。
[ ] **重连的 30 秒宽限期语义** —— 在 room.ts,不在本套件。
    本文件只保证"id 稳定",不保证"宽限期行为正确"(契约 §12.2 记为待办)。
[ ] **`contentClaim` 的服务端半** —— 服务端仍不读它(契约 §12.5)。
    客户端阶段 3 恒发 `null` ⇒ 此刻无危害;
    但 WS-FND-03 的丙② 会在 registry 上移后**自然转红**(设计如此)。
[ ] **真机延迟/丢包手感** —— 未测(只有 prediction.ts 的 LossyChannel 模拟)。
[ ] **本套件全部实测在 PROTOCOL_VERSION = 1 下取得**;
    版本号变更后 §12.1 的"全部 256 个 tag 都抛"需重测。
[ ] `ws_demo.ts` 的 `--advance` 开关 —— 它会与 room 那条路径**双重推进**,
    仅作诊断用;真接生产时该开关应删除。
[ ] **HelloFrame 的字段可选性差异** —— 服务端镜像**全字段可选**,
    客户端有 3 个必填。这是**有意的**(服务端必须容错第三方客户端),
    但 ⇒ 服务端**表达不出"必需"**。WS13-5b-1 只守**字段名集合**,
    **不守可选性**。若哪天"必需性"也要守,得另加断言。
[ ] **`join(ROOT, rel)` 型路径本套件不管** —— 与 `assertion-audit.ts` 的
    `[h]` 检测器同族的覆盖缺口(它那 8 处追不到,是我在 task-69 期间
    实测并列表登记的同一条),与本套件无直接关系,但同属"变量路径"这一类。
```
