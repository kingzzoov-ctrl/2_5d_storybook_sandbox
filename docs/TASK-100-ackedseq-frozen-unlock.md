# TASK-100 · 下行 `ackedSeq` 的冻结层解锁:方案 A / B 提案(供 owner 拍板)

> **性质**:本文是**提案**,不是实现。**不改任何代码**;也**不预设** owner 会选 A 还是 B。
> **上游依据**:`docs/DECISIONS.md` D-08(L90-95,owner 2026-11-16 裁决,生效范围含「`server/src/net/ws_server.ts`(下行 `ackedSeq`)」);
> 既有取证:`docs/TASK-82-prediction-gap.md` L179-183 / L373、`docs/TASK-83-wasd-three-options.md` L92-93。
> **行号口径**:全部**实测**(Read / Select-String),基准 = 当前工作区;未标注年份的行号即"现在这一版"。
> **本次未跑** `scripts/verify.ts --all`(任务约束),故凡标「须实测」处只给判断,不给结论。

---

## 0. 一句话结论:真正的断点是**三段**,冻结层只占其中一段

| # | 断点 | 现状(逐行证据) | 与冻结层的关系 |
| :-- | :--- | :--- | :--- |
| 1 | **上行 `seq` 的生产者** | `client/src/net/input.ts:127` 每次产出 `seq += 1`(首个 = 1);`client/src/main.ts:317-318` 把它交给预测器后就**丢了**;`client/src/main.ts:335` 的 `sendMove` **不带 seq**;`client/src/net/session.ts:236-244` 的 `MoveIntent` **没有 `seq` 字段** | **无关**(全部在冻结层之外) |
| 2 | **服务端"每连接"记账** | `server/src/net/ws_server.ts:344` 声明了 `WsConn.ackedSeq`,只在 `:646` 初始化成 `-1`,**此后全仓没有任何一行写它**;真正被推进的是**全局**变量 `let lastAckedSeq`(`:600` 声明,`:994` 推进,`:1069` 暴露) | **无关** |
| 3 | **下行 ack 通道** | `shared/net/delta.ts` 的包头只有 `ver / op / tick`(L330-334),`decodePacket` 读完后**直接**进载荷(L430);`decodePacket` 返回结构 `DecodedPacket`(L413-420)**没有** ack 字段;`client/src/net/session.ts` 的文本分支只认 `welcome` / `actionResult`(L453/L463) | **← 只有这一段卡冻结层** |

⇒ 因此「卡在冻结层」这句话**只对第 3 段成立**。
**方案 B 能绕开冻结层,但绕不开第 1、2 段**;两方案的**净差**恰好等于第 3 段(1 个冻结文件 + 若干断言)。
本节是本文的核心判据:**"解锁冻结层"不是把这条链做通的充分条件**,owner 在做取舍时应按"净差"而不是按"要不要动冻结层"来投票。

---

## 1. 现状取证(逐文件逐行)

### 1.1 下行二进制包的编码/解码与字节布局(`shared/net/delta.ts`)

写端(`encodeDelta`,L325-391):

```ts
// shared/net/delta.ts
325: export function encodeDelta(prev, next, tick = next.meta.tick): EncodedPacket {
330:   const w = new ByteWriter();
331:   w.u8(PROTOCOL_VERSION);                   // byte0 = 1
332:   w.u8(prev ? PacketOp.DELTA : PacketOp.FULL); // byte1 = 1 / 0
333:   w.u32(tick);                              // byte2..5,小端
367:   w.u16(removed.length);                    // byte6..7 起 + 变长
370:   w.u16(plans.length);                      // 紧随其后 + 变长
```

读端(`decodePacket`,L422-448)与写端**逐字段镜像**,且**顺序强依赖**:

```ts
// shared/net/delta.ts
424:   const version = r.u8();
425:   if (version !== PROTOCOL_VERSION) throw new Error(`协议版本不匹配:${version}`);
426:   const op = r.u8() as PacketOp;
427:   if (op !== PacketOp.FULL && op !== PacketOp.DELTA) throw new Error(`未知 op:${op}`);
428:   const tick = r.u32();
430:   const removedCount = r.u16();   // ← 头一旦变长,老解码器会把 ack 当 removedCount 读
```

| 偏移 | 长度 | 字段 | 编码值域 | 写 | 读 |
| :-- | :-- | :--- | :--- | :--- | :--- |
| 0 | 1 | `version` | `PROTOCOL_VERSION = 1`(L50) | L331 | L424-425(不等即**抛**) |
| 1 | 1 | `op` | 0=FULL / 1=DELTA(L52-55) | L332 | L426-427(其它值**抛**) |
| 2..5 | 4 | `tick` | u32 小端 | L333 | L428 |
| 6.. | 变长 | `removedCount` + `upsertCount` + 载荷 | u16×2 + 变长 | L367-376 | L430-446 |

- **总量**:头 **6 字节** + 两级计数 **4 字节** = 10 字节 —— 这一口径写在 L542 的注释里,并被带宽模型 `const header = 10;`(L551)使用。
- **对齐**:全程小端、**无填充、无对齐要求**(`ByteWriter.u16/u32` L82-95,`ByteReader.u16/u32` L135-137)。
- **可复用的"版本位/保留位"**:`byte1` 的 `op` **只用了 0/1 两个值**,其余值在解码端**直接抛**(L427)⇒ 它不是"保留位",而是**未知即拒绝**的强校验;想拿它当标志位必须同时放宽 L427,那会让"坏包"与"新包"混为一谈。**⇒ 没有可安全复用的保留位**。
- **实体级 mask 有 18 个空 bit**(`u32` 掩码 L374:玩家表只用到 bit0..13,`shared/types/wire.ts:106-120` 共 14 个字段)⇒ 技术上塞得下,但那是**每个玩家一个字段**的语义,**不是每连接一个数**;把 ack 塞进去等于把"连接状态"错当成"玩家状态"(而且 `shared/types/wire.ts` 属 `shared/types/**`,是 FREEZE.md §1 L41 明列的冻结文件)。
- `encodeFull`(L394-396)是 `encodeDelta(null, …)` 的**薄壳** ⇒ **三个下行出口共用同一个头**,改头是一次全覆盖、零遗漏的改动。

### 1.2 首帧 / 每帧 / JSON 帧:三条下行路径

| 路径 | 代码位置 | 形态 | 是否逐连接 |
| :--- | :--- | :--- | :--- |
| 首帧快照 | `server/src/net/room.ts:2325-2329` → `encodeFull(this.state, tick).bytes`(整房快照,**不按人过滤**);`ws_server.ts:862` `sendBinary(c, opts.room.snapshotFor(userId))` | 二进制,裸包 | **是**(入参就是 `userId`) |
| 每帧差量 | `ws_server.ts:1001-1015`:`payload = opts.room.step(prevState)` **只算一次**,然后 `for (const c of conns) sendBinary(c, payload)` | 二进制,裸包 | **否 ★ 所有连接共用同一份字节** |
| 0 字节特例 | `room.ts:1827`(非 OPEN)/`room.ts:1908`(`prevSnapshot` 为 null ⇒ 空);`ws_server.ts:1043-1044` 明示"跳过、不补发";`state_store.ts:135-138` 客户端也跳过 | — | — |
| `welcome` JSON | `ws_server.ts:850-860`(`sendJson`,L612-618 发**裸 JSON**,首字节 `{`);已带 `protocolVersion`(L854) | 文本 | 是 |
| `actionResult` / `attackResult` | `ws_server.ts:953/961/966/918` | 文本 | 是 |

★ **`room.step()` 一次算、多连接共用**(L1009-1015)是方案 A 的实现要点:ack 是**每连接**的量,所以运输层必须**逐连接重写包头那 4 字节**(或退化成"全局一个 ack");这一点在 §2.4 的文件清单里是一条显式改动。
★ 顺带取证:`ws_server.ts:599-600`/`:994` 的 `lastAckedSeq` 是**闭包级全局**,`frameMs` 默认 50ms(L584)。多连接下它会**互相冒充**(alice 的 seq=7 会当成 bob 的 ack)⇒ 方案 A/B 都必须先修这条。

### 1.3 客户端在哪消费二进制帧

| 步骤 | 位置 | 判据 |
| :--- | :--- | :--- |
| 载荷规整 | `client/src/net/session.ts:394-443`(文本帧编成字节后**汇入同一分派**;`binaryType='arraybuffer'` 在 L378) | 形态不对 ⇒ `droppedFrames += 1`(L424/L439),**不静默** |
| 下行分类 | `client/src/net/session.ts:202-214` `classifyDownlink`:靠内容特征 `{`(L205)/`0x01`+`{`(L207) | **L196-200 明写残留歧义**:若 `PROTOCOL_VERSION === 2 (= FRAME_BINARY 0x02)`,裸包首字节与 tag **不可区分**,规则 3 主动不猜(L210-213) |
| JSON 分派 | `session.ts:449-477`:只处理 `w.t === 'welcome'`(L453)与 `'actionResult'`(L463),**其它 `t` 被静默忽略** | 老客户端遇到未知 `t` **不报错** ⇒ 方案 B 的兼容性正来自这里,风险也来自这里(§3.3) |
| 二进制消费 | `session.ts:479-480` `store.apply(cls.payload)` → `client/src/net/state_store.ts:130-156` | 0 字节跳过(L135);`decodePacket` 抛则 `decode-failed`(L144-147);`applyPacket` 返回值**必须接住**(L153) |
| ★ 尾字节 | `state_store.ts:130-156` **没有** `bytesConsumed === byteLength` 检查 | ⇒ 当前客户端会**静默忽略**包尾多余字节;而服务端上行路径**恰恰要求恰好消耗完**(`ws_server.ts:794-799`)⇒ 仓内两条口径不一致,这是 §2.1 选"头插"而不是"尾附"的直接理由 |

### 1.4 上行 `seq` 与"服务端记 ack":三段里断了两段

```ts
// client/src/net/input.ts:123-128
nextCmd(): InputCmd {
  this.seq += 1;                                  // seq 单调递增,首个 = 1
  return { seq: this.seq, moveX: d.moveX, moveY: d.moveY, jump };
}
// client/src/main.ts:317-318
const cmd = mergeCmd(input.nextCmd(), stick.vector());
const p = predictor.step(cmd);                    // ← cmd.seq 到此为止
// client/src/main.ts:334-336
if (session !== null) {
  session.sendMove({ tick: localTick, x: p.x, y: p.y, z: p.z });   // ← 不带 seq
}
```

- `session.ts:236-244` `MoveIntent` 只有 `tick/x/y/z/speedMul`;`encodeMoveUplink`(L254-257)是 `JSON.stringify({ t:'move', ...intent })` ⇒ **接口加 `seq?` 即自动上线,编码器不用动**。
- 服务端**已经**准备好了接收端:`ws_server.ts:419-421`(`parseMoveIntent` 收 `seq`,要求非负整数,坏值当没给)、`ws_server.ts:992-994`(**`applyMove` 成功之后**才推进;抛错路径不推进)。
- 服务端**没**准备好的是"每连接":`:344`/`:646` 的 `c.ackedSeq` 只被初始化;**`:994` 推的是全局** `lastAckedSeq`(`:600`);`WsServerHandle.lastAckedSeq()`(`:512`/`:1069`)因此是**全局**读数。
⇒ 结论:上行 ack 的**判定逻辑在岗**,**生产者(客户端)与"每连接账本"(服务端)都不在岗**。### 1.5 会被触动的既有门禁 / 断言(实测清单)

| 断言(实测行号) | 内容 | 方案 A | 方案 B |
| :--- | :--- | :--- | :--- |
| `tests/WS-FND-58-joystick-prediction.test.ts:255` | `ok(!/ackedSeq/.test(deltaSrc))` —— "未解锁就必须是 0 次" | **必红(这就是解锁信号)** | 绿 |
| `tests/WS-FND-58-…test.ts:259` | `ok(!/ackedSeq/.test(sessionSrc))` | 可保绿(把 ack 落在 `state_store.ts`) | **必红**(ack 分派必须落在 `session.ts`) |
| `tests/WS-FND-58-…test.ts:263-264` | `lastAckedSeq\(\): number` / `lastAckedSeq = intent\.seq` 两条文本判据 | 若把推进目标改成 `c.ackedSeq` ⇒ **红**(须同步改断言) | 同 A |
| `tests/WS-07.test.ts:881` | `eq(pkt.version, 1, …)`(**字面量锚定**,L873-880 写明"线格式 bump 时此处必须同步") | **红,必须同步** | 绿 |
| `tests/WS-07.test.ts:887` | `eq(pkt.bytesConsumed, full.bytes.length)` | 头插 ⇒ 绿;尾附 ⇒ **红** | 绿 |
| `tests/WS-07.test.ts:897` | `eq(bytes[0], 1, …)`;其后 L899-904 遍历 `[0,2,7,255]` 断言解码必抛 | **红**(首字节随 bump 变 3) | 绿 |
| `tests/WS-FND-14.test.ts:253` | `eq(got!.version, 1, …)`(字面量锚定;L238-252 记录它曾被测"+1") | **红,必须同步** | 绿 |
| `tests/WS-FND-14.test.ts:551-552` | `ok(deltaVersion === PROTOCOL_VERSION, …)` 两模块常量一致 | 两处同步 bump ⇒ 绿(只改一处 ⇒ 红,正是它要防的) | 绿 |
| `tests/WS-FND-14.test.ts:278` | 手搓 6 字节坏包 `[0x00,0x01,0,0,0,0]` 造"版本不匹配" | **须实测**(头变长后它仍是坏包,预计仍绿) | 绿 |
| `tests/WS-FND-14.test.ts:204` | `eq(pkt.bytesConsumed, bytes.byteLength)`(夹具自检) | 绿(头变长不影响"恰好消耗完") | 绿 |
| `tests/WS-12.test.ts:442` | `eq(bare[0], 0x01, '★ 裸包首字节是 1')` —— **硬编码 1** | **红,必须同步** | 绿 |
| `tests/WS-12.test.ts:443` / `:953-959` | `eq(bare[0], PROTOCOL_VERSION)` / "客户端用的是 delta.ts 的常量" | L443 绿;L959 `>= 1` 绿 | 绿 |
| `tests/WS-13.test.ts:289`/`295`/`798`/`804`/`1017`/`1029` | 一族"首字节 == `PROTOCOL_VERSION`"(下行无 tag 的证据) | **绿**(仍 equals 常量,值变 3);L278 注释里的"最小 27 字节"是注释、不是断言 | 绿 |
| `tests/WS-FND-24-contract-align.test.ts:343-353` | 头里的 `tick` 被无条件覆盖进 `meta.tick` | **绿**(tick 位置不变) | 绿 |
| `server/src/sim/ws_demo.ts:318` | 每个下行帧首字节 == `PROTOCOL_VERSION` | **绿**(值随常量走);实测 `scripts/verify.ts` 全文只在 L1477/1478/1482/1496/1500/1502 提到它(入口登记),**未见 verify 直接 spawn 它** ⇒ 这是手动入口 | 绿 |
| `scripts/verify.ts:605-647` | HANDOVER §九 sha256 表(7 个 `.md`,`EXPECTED` 写死在 L639-647) | 表内**不含** `docs/WS-07-net-persist.md` ⇒ 改它无影响;**`README.md` 在表内** ⇒ 若动 README 必须重算哈希 | 同 A |
| `scripts/verify.ts:4694-4702` | 文档结构门禁只遍历文件名匹配 `/WS-\d\d-/` 的 `.md` | **本文(`TASK-100-…md`)不匹配 ⇒ 不进该门禁** | 同 A |

---

## 2. 方案 A:改冻结层(包头加 `ackedSeq`)

### 2.1 逐字节布局草案

```
偏移  长度  字段            取值                                    写入 / 读取
0     1     version         3(由 1 bump,理由见 §2.2)                  delta.ts:331 / :424-425
1     1     op              0=FULL 1=DELTA                           :332 / :426-427
2..5  4     tick            u32 小端                                 :333 / :428
6..9  4     ackedSeq        u32 小端;0 = 「还没有 ack」,n≥1 = 服务端已应用到第 n 条
10..  变长  两级计数 + 载荷  ★与今天**逐字节相同**(:367-376 / :430-446)
```

- **取值编码不引入哨兵**:客户端 `seq` 从 **1** 起(`input.ts:127`),所以包头用 **`ackedSeq + 1`** 的编码 ⇒ `0` 天然表示"无 ack"(内部 `-1`),不必用 `0xFFFFFFFF` 这种魔法值。解码端 `ackedSeq = raw - 1`。
- **为什么插在 `tick` 之后**而不是包尾:
  1. 它与 `tick` 同族(单调标量、"服务端时钟"性质),放一起语义清楚;
  2. 包尾附加会被本仓**既有纪律**判为垃圾 —— `ws_server.ts:794-799` 明确把"尾部未消耗字节"记成**解析失败**,`tests/WS-07.test.ts:887` 断言 `bytesConsumed === 总长`;
  3. 头插让"头长度"成为版本身份的一部分,老客户端**必然**被版本门拦住(见 §2.3),不留"半懂"状态。
- **冻结层的改动面 = 定义 4 字节槽位 + 解码读它**;那 4 字节的**真值**由运输层按连接覆盖(§2.4-2),所以"推送逻辑"**不进冻结层**。这是本方案"最小面"的关键设计(§4 末)。

### 2.2 版本号:bump 到 **3**,**不能** bump 到 2

- **必须 bump**:`decodePacket` 按顺序读字段(:424-428),老客户端在后 4 字节多出来时会把 ack 当成 `removedCount` 读 ⇒ 轻则抛"报文截断",重则**解出一堆垃圾实体而完全不报错**(本仓最忌的形态)。bump 是唯一能让老客户端**明确失败**的手段(`session.ts:454-457` `协议版本不匹配` ⇒ `setState('failed')`,不进 live)。
- **但不能是 2**:`FRAME_BINARY` 就是 `0x02`(`session.ts:161`),而 `classifyDownlink` 的规则 3 依赖 `PROTOCOL_VERSION !== FRAME_BINARY`(:211);`session.ts:196-200` **已把该陷阱写在注释里**。一旦版本 = 2,"裸包首字节"与"帧 tag"**不可区分** ⇒ 下行分流重新变成不可判定。
  ⇒ **bump 到 3**;`tests/WS-FND-14.test.ts:241` 的注释("把 ws_server 的常量改成 2 ⇒ 本套件红 2 条")正是这个陷阱的另一处留档。
- **连带副作用(须一并登记)**:`server/src/net/room.ts:2433` 的 resume token 串含 `PROTOCOL_VERSION`(`${this.id}-${this.tokenSeq}-${PROTOCOL_VERSION}`)⇒ 版本一变,30s 宽限期内的旧 token 不再匹配(一次性影响,建议在 WS-13 文档写明)。

### 2.3 老客户端兼容策略:版本门(不做双解码器)

| 组合 | 行为 | 判据 |
| :--- | :--- | :--- |
| 老客户端 + 新服务端 | `welcome.protocolVersion(3) !== 本地(1)` ⇒ `session.ts:454-457` 报"协议版本不匹配"并 `failed` | 期望行为:老客户端不懂 10 字节的头,放进去只会解出垃圾 |
| 新客户端 + 老服务端 | 同上 | 同上 |
| 同版本 | 不存在"半懂"状态 —— 头长度就是版本的一部分 | — |

★ **不做**双头协商 / 双解码器:那会长出**第二份实现**(`ws_server.ts:86-101` 与 WS-13 §5「CR-20 不造第二份口径」正是为这个场景写的纪律)。
★ 首帧那条路天然好办:`snapshotFor(userId)`(:2325)与 `sendBinary(...)`(:862)本来就是**逐连接**的,可以在首帧就带正确 ack。

### 2.4 方案 A 改动文件清单(行号 → 改什么)

| # | 文件 | 行号 | 改什么 |
| :-- | :--- | :--- | :--- |
| A-0 | `shared/contracts/FREEZE.md` | L40-50(§1 目录表)| ★ 口径澄清:`shared/` 整目录被 L40 注释为"冻结层,只读",但 L41-44 的**显式清单里没有 `shared/net/`**。若走 A,建议把 `shared/net/delta.ts` 补进清单(或写明豁免) |
| A-1 | **`shared/net/delta.ts`(冻结层)** | L50 | `PROTOCOL_VERSION = 1` → `3` |
| A-1 | 同上 | L330-334 | 头写入 tick 之后**多写 4 字节**(占位 `0`) |
| A-1 | 同上 | L413-420 | `DecodedPacket` 加 `ackedSeq: number` |
| A-1 | 同上 | L422-428 | 读头 4 字节并回填到返回对象 |
| A-1 | 同上 | L542 / L551 | 带宽模型头常量 `10` → `14`(注释与 `const header` 同步) |
| A-1 | 同上 | L88-95 / L137 | **不用改**(`u32` 原语已有) |
| A-2 | `server/src/net/ws_server.ts` | L1099 | `PROTOCOL_VERSION = 1` → `3`(与 `delta.ts` 同值,由 FND14-8 钉住) |
| A-2 | 同上 | L1009-1015 | 广播循环:**逐连接**拷贝 payload 并写 byte6..9 = `c.ackedSeq`(今天是一份字节发给所有人) |
| A-2 | 同上 | L992-994 | ack 推进目标改成 `c.ackedSeq`(顺带决定 `lastAckedSeq()` 语义,见 P-100-4) |
| A-2 | 同上 | L862 / L850-860 | 首帧:由 `snapshotFor` 或 `welcome` 带一次初值(此刻通常是 0 = 无 ack) |
| A-3 | `client/src/net/state_store.ts` | L88-100 / L130-156 | 存下 `pkt.ackedSeq` 并加 getter;`ApplyResult`(L77-86)可选加字段 |
| A-4 | `client/src/main.ts` | L328 / L335 | `onAuthoritative({ …, ackedSeq: handle.store.lastAckedSeq })`;`sendMove({ …, seq: cmd.seq })` |
| A-5 | `client/src/net/session.ts` | L236-244 | `MoveIntent` 加 `seq?: number`(★ 编码器 L254-257 不用改;本文件**不出现 `ackedSeq` 字样** ⇒ L259 那条断言保持绿) |
| A-6 | 测试 | 见 §1.5 表 | 同步:WS-07(881/887/897)、WS-FND-14(253)、WS-12(442)、WS-13(值随常量走,通常无需改)、WS-FND-58(255 **翻面** + 新增端到端剪枝用例) |
| A-7 | 文档 | — | `docs/WS-07-net-persist.md` §4.1 线格式 + §5 参数表;`docs/CLIENT-NET-CONTRACT.md`;`docs/DECISIONS.md` 追加一条(登记本次解锁);`docs/WS-13-ws-server.md` 若改 `lastAckedSeq` 语义 |

**规模:冻结文件 1 · 生产文件 4 · 测试约 5-6 · 文档 3-4。**

### 2.5 方案 A 的代价(如实)

1. **动了冻结层**:FREEZE.md L5「冻结层文件任何人只读、不得改动」——**必须由 owner 明确解锁**,这是收益与代价的核心。
2. **逐连接重写 4 字节**:每连接每帧一次 `Uint8Array` 拷贝(20Hz × 连接数);稳态帧 ~几百 B 量级,拷贝可忽略,但它把"广播一份字节"变成"每连接一份",`framesSent`/`lastFrameBytes`(`:475`/`:477`)口径需重新定义(它们现在是"广播了几次/多大")。
3. **版本门把老客户端挡在门外**:D-08 阶段本来也只有同仓客户端,实际风险低;但发布流程上必须一次升两端。
4. `room.step()` 仍然是**一步一包**;若将来要做"按人裁快照",包头带 ack 反而更容易演化(每一包天然可以带不同 ack)。

---

## 3. 方案 B:不动冻结层,ack 走已有 JSON 下行通道

### 3.1 帧形状(与 `welcome` / `actionResult` 同族)

```json
{ "t": "ack", "seq": 7 }
```

- 服务端已经有现成的发送函数 `sendJson`(`ws_server.ts:612-618`,下行**裸 JSON**),以及现成的"未知 `t` 被忽略"的客户端行为(`session.ts:449-471` 的 else 分支什么都不做)。
- 落点二选一(**必须写清选哪条,两者的时序性质完全不同**):
  - **(i) 随广播发**:在 `ws_server.ts:1009-1015` 的循环里,给每个连接在二进制帧之后紧跟一帧 ack(同 tick);
  - **(ii) 仅变化时发**:在 `ws_server.ts:992-994` 之后发(帧更少,但与快照**完全解耦**)。

### 3.2 方案 B 改动文件清单(行号 → 改什么)

| # | 文件 | 行号 | 改什么 |
| :-- | :--- | :--- | :--- |
| B-1 | `server/src/net/ws_server.ts` | L992-994 | ack 推进目标改成 `c.ackedSeq`(使用 `:344`/`:646` 已存在的字段) |
| B-1 | 同上 | L1009-1015 或 L992-994 之后 | `sendJson(c, { t:'ack', seq: c.ackedSeq })`;建议加一个 `ackFramesSent` 计数供断言(照 `:498-500` 的既有风格) |
| B-1 | 同上 | L1069 | `lastAckedSeq()` 语义(同 P-100-4) |
| B-2 | `client/src/net/session.ts` | L49-63 | 加 `AckFrame` 接口(与 `WelcomeFrame` L50-63 同族) |
| B-2 | 同上 | L67-87 | `SessionEvents` 加 `onAck?` |
| B-2 | 同上 | L449-471 | 文本分支加 `else if (w.t === 'ack')` |
| B-3 | `client/src/net/state_store.ts` | L88-100 | 存 `lastAckedSeq`(供 `main.ts` 读) |
| B-4 | `client/src/main.ts` | L328 / L335 | 喂 `ackedSeq` 进 `onAuthoritative`;`sendMove` 带 `seq` |
| B-5 | `client/src/net/session.ts` | L236-244 | `MoveIntent.seq`(同 A-5) |
| B-6 | 测试 | — | `WS-FND-58:259` **翻面**;新增"服务端发了 ack 帧"+"客户端消费了"两条;**无需动 WS-07 / WS-12 / WS-FND-14** |
| B-7 | 文档 | — | `docs/WS-13-ws-server.md`(新帧种类及**时序不对齐**这条已知代价)、`docs/CLIENT-NET-CONTRACT.md` |

**规模:冻结文件 0 · 生产文件 4 · 测试 2-3 · 文档 2。**

### 3.3 方案 B 的缺点(逐条,含"ack 早于快照")

1. **多一条帧**:每 tick 每连接一帧 JSON(`{"t":"ack","seq":7}` ≈ 20-22 B + WS 头 2-4 B)。20Hz × N 连接:4 人 ≈ 1.9 KB/s、16 人 ≈ 7.7 KB/s 的**额外下行**;相对二进制快照是几个百分点的量级(不是数量级)。选 (ii) 能摊薄,但摊薄等于放弃与快照对齐。
2. **与二进制快照不同步**:位置在二进制帧、ack 在文本帧;**两条 WS 消息只保证相对顺序,不保证"同一 tick 的同一批"**。即使服务端在同一 tick 内先发快照再发 ack,客户端也可能在**下一帧快照到达之前**先用新 ack 剪队列。
3. **"ack 早于快照"的具体后果**:`predictor.onAuthoritative`(`client/src/net/predictor.ts:166-199`)先剪(`:172-178`)再重演(`:181`)。若 ack 先到 ⇒ 队列被剪掉,随后到达的**旧快照**(服务端编码时刻早于那条命令的结算)**会**触发 `resimulate(authoritative, 空队列)` ⇒ `reconcile` 判出 SMOOTH/SNAP(:184-195)⇒ 玩家看到**回弹/抖动**。这正是 `predictor.ts:167-171` 三道门在防的方向;方案 B 把这道防线**移交给时序**。
4. **只省了一处,却把工作量留在原地**:§0 的第 1、2 段(上行生产者、每连接账本)两方案**同样都要做**;B 省的只有"1 个冻结文件 + 约 4 处断言同步"。B-1/B-2/B-3/B-4 四处生产改动与 A 的 A-2/A-3/A-4 基本等价。
5. **协议面出现"两种格式表达一件事"**:将来若要做二进制 ack,两条路必须共存或迁移 —— CR-20「不造第二份口径」的同族风险。
6. **老客户端会静默忽略**:`session.ts:449-471` 的 else 什么都不做 ⇒ `t:'ack'` 对老客户端**无害但也无用**,且**没有任何东西会红**:新服务端对着不懂 ack 的客户端会显示"一切正常",而剪枝永不发生。⇒ B 必须**自带**一条"客户端真的消费了 ack"的判据(§5),否则它就是又一个"接不上而无人报错"的形态。---

## 4. 推荐:选 **A**,且把冻结层的改动压到一个 uint32

**推荐 A(改冻结层)。理由按权重排序:**

1. **它是唯一能消掉时序耦合的方案**。`resimulate` 的基准就是"权威位置 + 已确认到第几条",这两件事在语义上属于**同一帧的两个数**(`predictor.ts:166-199`);把它们拆到两条 WS 消息里,等于把一个不变量拆成两条时序,并把正确性寄托在"文本帧不会先到"这种**运行时性质**上。
2. **收益对代价**:A 的净增代价是 1 个冻结文件(+约 4 处断言同步 + 逐连接 4 字节补写),换到的是 ack 与快照**天然同帧**;而 B 省下的这几处,仍然要做第 1、2 段同样的工作(§0)。净差很小,收益差别是结构性的。
3. **每一次改动都有现成断言会红**:`WS-FND-58:255`、`WS-07:881/887/897`、`WS-FND-14:253`、`WS-12:442` 就是为这一刻留下的哨兵 —— 解锁动作本身**不会静默**(§5)。
4. **冻结层的改动面可以做成"只加一个 uint32"**,不动字段表、不动载荷格式、不动 `applyPacket`、不新增函数/类型(见下)。冻结层的真正价值是"**别让人偷偷扩协议**",而本提案是把扩协议这件事**摆到台面上一次做完**。

★ **若 owner 选 A,冻结层的最小面就是下面这一句** ——

> **`shared/net/delta.ts` 只在包头加一个 `uint32`**:
> L50 常量 `1 → 3`;L330-334 在 `tick` 之后**多写 4 字节 0**(占位);L413-420 `DecodedPacket` 加一个 `ackedSeq: number`;L422-428 多读 4 字节;L542/L551 头常量 `10 → 14`。
> **不新增类型、不新增函数、不动 `FIELD_TABLE`/`ROOM_FIELD_TABLE`、不动 `encodeFull` 的签名、不动 `applyPacket`、不动 `PROTOCOL_VERSION` 的字面量以外任何常量。**
> "每连接的真值"由运输层写那 4 个字节(`ws_server.ts:1009-1015`),**不进冻结层** —— 于是冻结层只被要求"承认这 4 字节存在",不被要求知道 ack 属于谁。

**若 owner 更看重"冻结层零改动"这一条**,B 是**可用但要显式登记代价**的降级方案:必须在 `docs/WS-13-ws-server.md` 写明"ack 与快照跨通道、不保证同帧,已接受 §3.3-3 的抖动风险",并加上 §5 里那条"客户端真的消费了 ack"的断言。**不建议**把 B 当成"等价但更省"来选 —— 它不是等价的。

---

## 5. 可验证性:每个方案一条"能红的判据"

> 口径沿用本仓纪律:**一条永远不红的断言等于没写**;每处翻面都必须写清"改坏哪里会红"。

### 5.1 方案 A 的判据(落地后 `WS-FND-58:255` **必红**,这就是解锁信号)

`tests/WS-FND-58-joystick-prediction.test.ts:253-255` 现在的写法是"未解锁就必须 0 次"。方案 A 落地后应当**翻面成正向断言**(而不是删掉 —— 删掉就丢掉了"协议被扩了"这件事的可观测性):

```ts
const deltaSrc = readCode('shared/net/delta.ts');
ok(/export function encodeFull\(/.test(deltaSrc), 'encodeFull 仍在冻结层里');
/* ★ 翻面:owner 裁决解锁后,冻结层**应当**出现 ackedSeq */
ok(/ackedSeq/.test(deltaSrc), '冻结层已解锁:包头带 ackedSeq(本行变红 = 有人又把它删了)');
ok(/w\.u32\(0\)/.test(deltaSrc), 'encode 侧确实写出了那 4 字节占位');
```

再补**行为判据**(不要只查文本 —— 本仓对"文本判据"的教训已多次记录):

```ts
/* 1 头布局:编码 → 解码 round-trip 后 ack 占位为 0,且恰好消耗完 */
const pkt = decodePacket(encodeFull(state, 7).bytes);
eq(pkt.ackedSeq, 0, 'encode 侧写占位 0(真值由运输层填)');
eq(pkt.bytesConsumed, encodeFull(state, 7).bytes.length, '头变长后仍恰好消耗完');

/* 2 头插位置:把 byte6..9 改成 5 ⇒ 解码应得 5(证明读的是那 4 字节,不是别处) */
const tampered = Uint8Array.from(encodeFull(state, 7).bytes);
tampered[6] = 5; tampered[7] = 0; tampered[8] = 0; tampered[9] = 0;
eq(decodePacket(tampered).ackedSeq, 5, 'byte6..9 就是 ackedSeq(小端)');
```

**端到端判据(生产里真的剪了)** —— 这条最值钱,因为它越过"单元测试各自都过"的边界:

```ts
/* 真 startWsServer + 真 createSession:发一条带 seq 的 move,断言两端都前进 */
// 服务端侧: srv.lastAckedSeq() >= 3 且 数据源是**应用成功之后**(ws_server.ts:992-994)
// 客户端侧: predictor.lastAckedSeq === 3 且 predictor.prunedTotal > 0
/* ⚠️ 不能只看 pendingCount:predictor.ts:132-133 已写明它会同时被
   MAX_PENDING 截断与 SNAP 清空影响 ⇒ 必须配合 prunedTotal(单调) */
```

**负向对照(反作弊)**:`?server=off` 时 `predictor.lastAckedSeq === -1` 必须保持 —— 防止有人"在客户端本地伪造 ack"让上面的断言变绿。

### 5.2 方案 B 的判据(落地后 `WS-FND-58:259` **必红**)

```ts
const sessionSrc = readCode('client/src/net/session.ts');
/* ★ 翻面:ack 分派落在 session.ts(JSON 通道的消费点就在那儿) */
ok(/t === 'ack'/.test(sessionSrc), 'ack 走 JSON 下行通道解析(方案 B)');
ok(!/ackedSeq/.test(readCode('shared/net/delta.ts')), '冻结层仍然 0 次(方案 B 的卖点)');
```

**交叉校验(防"发了但没消费")**:两个数**分开数**,不许合并(照 `ws_server.ts:481-500` 的既有理由):

```ts
ok(srv.ackFramesSent() > 0, '服务端真的发了 ack 帧(不是只在注释里)');
ok(store.lastAckedSeq > 0, '客户端真的消费了 ack(不是被 else 静默吞掉)');
```

**负向对照**:上行**不带** `seq` ⇒ `ackFramesSent` 不增长(否则就是"每帧无条件发 ack",与 FND58-7 同族缺陷)。
**时序判据(方案 B 特有)**:显式断言"先发的快照先被消费"这条**做不到** —— 建议改为**记录**一次跨通道乱序(ack 先到)时的校正档位,把 §3.3-3 的抖动从"未知"变成"已测量的已知量"。

---

## 6. 未决 / 需 owner 拍板

| # | 问题 | 选项 | 影响面 |
| :-- | :--- | :--- | :--- |
| **P-100-1** | 走 **A**(解锁冻结层)还是 **B**(走 JSON) | A / B | 决定 `shared/net/delta.ts` 是否被改 |
| **P-100-2** | 若 A:版本 `1 → 3`(**跳过 2**)是否接受 | 3 / 其它 | 2 会与下行 tag 撞值(`session.ts:196-200`);版本一变,resume token 也要重算(`room.ts:2433`) |
| **P-100-3** | 若 A:ack 放**包头( tick 后)**还是**包尾** | 头(推荐)/ 尾 | 尾附与 `ws_server.ts:794-799`、`WS-07:887` 的"尾字节=垃圾"纪律冲突 |
| **P-100-4** | `WsServerHandle.lastAckedSeq()` 的语义(**现在全局**,多连接互相冒充) | 改 `lastAckedSeqFor(userId)` / 保留全局 + 明确注释 | 方案 A、B **都要**先定这一条(A-2/B-1) |
| **P-100-5** | 老客户端策略:版本门(拒绝)还是双解码器 | 版本门(推荐)/ 双解码 | 双解码器 = 第二份口径(CR-20) |
| **P-100-6** | `shared/net/delta.ts` 是否在"冻结层"里(文档口径不一致,见 §2.4-A-0) | 补进 FREEZE.md 清单 / 明确豁免 | 决定走 A 时是"解锁"还是"本来就不需要解锁" |

---

## 7. 本文的边界与不预设声明

- **本文不改任何代码**:不新增、不修改 `shared/**`、`server/**`、`client/**`、`tests/**`、`scripts/**` 下的任何文件;唯一新增文件就是本文自身。
- **不预设 owner 选哪个方案**:§4 给出推荐 A 及理由,同时把 B 的代价逐条写明;§6 的六个问题等待裁决。
- **行号基准 = 当前工作区**,全部实测(Read / Select-String 交叉核对)。凡标"**须实测**"的条目(§1.5 的 `WS-FND-14:278`)只给判断,不给结论。
- **未跑** `scripts/verify.ts --all`(任务约束)⇒ 本文不声称"落地后门禁全绿",只逐条列出**哪些断言会变、以及为什么**。
- 本文落在 `docs/TASK-100-…md`,**不进入** `verify.ts:4694-4702` 的文档结构门禁(该门禁只遍历文件名匹配 `/WS-\d\d-/` 的 `.md`)。