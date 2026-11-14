# TASK-85 · US2 网关联动:可行性 + 最小闭环方案

> 交付人:`net-persist` · 日期:2026-11-14 · 状态:**先出方案,未动一行生产代码**

---

## 0. 结论摘要(先说最重要的)

**这张卡的前提已经部分过期。** 卡片说「`RoomRuntime` 与 `WorldSim` **互不依赖** ⇒ 真服务端跑不起世界」。

实测:**两件事同时为真,但含义不同**。

```
1 room.ts 的**代码态**确实 0 处提及 WorldSim     ← 卡的前提成立
2 但 room.step() 里**已经**在调 host.advance(1)  ← 世界**已经**在被驱动
  (server/src/net/room.ts:1546-1548,task-59 接的)
⇒ 「不认识这个名字」≠「不能驱动它」:两者经 WorldSaveHost **结构化接口**交互
```

**端到端实测(本卡最有价值的一条证据):**

```
assemble() 的 runtime 直接喂 startWsServer()
⇒ 收到 39 个二进制帧 · 世界帧 0 → 39(真 WorldSim 在推进)· 协议包可解码
```

⇒ **US2 的功能内核已经通了**。真正剩下的缺口**不是"接线",而是三件别的事**:

| # | 真实缺口 | 性质 |
|---|---|---|
| 1 | **没有一条路径同时具备四件套**(下详) | 装配缺口 |
| 2 | `backlog.ts` 的 US2 探针**量错了对象** | 判据错位 |
| 3 | `SIM-orchestration.md` 账本行已陈旧 | 文档漂移 |

---

## 我能证明的

### 1 立足点复核:「互不 import」三层都成立(附证据)

`_t85_premise.ts`,三层口径(缺一层都不足以称"互不依赖"):

```
第1层 直接 import 边
  room.ts → world_sim:相对依赖 6 个,命中 0 ✓
  world_sim.ts → net/room:相对依赖 36 个,命中 0 ✓
第2层 代码态符号(去注释,与 WS-07 K6 同口径)
  room.ts 提及 WorldSim ⇒ 0 处 ✓
  world_sim.ts 提及 RoomRuntime ⇒ 0 处 ✓
第3层 传递闭包(前两层只看直接边;A→B→world_sim 仍是依赖)
  room.ts 闭包 共 9 个文件,含 sim/world_sim.ts 的 0 个 ✓
  world_sim.ts 闭包 共 50 个文件,含 net/room.ts 的 0 个 ✓
```

**反证(证明提取器有牙,不是恒真):**

```
room.ts 闭包含 shared/types/wire.ts? ✓   含 net/anticheat.ts? ✓   含 db/repo.ts? ✓
world_sim 闭包含 world/grid.ts? ✓        含 physics/world.ts? ✓   含 types/physics.ts? ✓
```

⇒ 立足点**成立**。但注意:`room.ts` 里 `WorldSim` 出现 **16 次,全在注释里**
(`git grep -n WorldSim -- server/src/net/room.ts` ⇒ 16 行,去注释后 0)。

### 2 ★ 世界**已经**在被驱动(这是与卡片前提的关键分歧)

```
_85_iswired.ts
  A 路(assemble):
    step(null) 一次后:frame 0 → 1  (Δ=1)
    连推 4 帧:1 → 2 → 3 → 4 → 5     ⇒ 每帧恰好推进一次
    25 帧后 meta.tick 7 → 32
  B 路(host = null):报文 0B,等级投影整段跳过
```

源码:`server/src/net/room.ts:1546-1548`

```
const host = this.worldSaveHost;
if (host !== null && typeof host.advance === 'function') {
  host.advance(1);
}
```

⇒ **「US2 未接」这个说法,按"房间能不能驱动世界"这个口径,已经是错的。**

### 3 ★★ 最小闭环端到端**已经能跑**

`_t85_e2e2.ts`:真起 `startWsServer`,真连一个 WS 客户端(含完整握手 + 应用层 hello):

```
J1 assemble() 的 runtime 满足 WsRoomLike:需要 6 个方法,缺 0 个 ✓
   它同时满足:id ✓ host 非 null ✓ host 是真 WorldSim ✓
J2 ws 端口 6347,收到二进制帧 39 个(文本帧 1 个 = welcome)
   welcome: {"t":"welcome","playerId":"alice","roomId":"e2e","protocolVersion":1,...}
K2 世界帧 0 → 39  Δ=39          ← 真 WorldSim 在跑,不是假存根
   出现过的 kind:1,2             ← 玩家/野生动物的真实 upsert
J5 帧可 decodePacket ✓
```

⇒ **最小闭环 = `assemble()` 的输出对接 `startWsServer()`,两个现成件对接即可,无需新能力。**

### 4 量纲核查(Lead 专门提醒的第 e 项)

**结论:Lead 担心的量纲风险,在推进主路径上不存在。**

| 常量 | 值 | 量纲 |
|---|---|---|
| `TICK_HZ` | 20 | Hz |
| `SLOW_TICK_HZ` | 2 | Hz |
| `DT` | `1/TICK_HZ` = 0.05 | **秒** |
| `SIM_FAST_DT` | `= DT` = 0.05 | **秒** |
| `SIM_SLOW_DT` | `1/SLOW_TICK_HZ` = 0.5 | **秒** |

`room.ts` 侧:`WorldSaveHost` 共 12 个方法,**只有 1 个带时间参数**:

```
saveToDb(db, roomId, nowMs)   ← 唯一的时间参数
advance(frames)               ← 是**帧数**,不是时间
```

**两处关键判定:**

```
1 step() 是**帧驱动**:调 host.advance(1),代码态**不读** clock.nowMs()
  (花括号配平取全函数体 2934 字符,去注释 1036 字符后判定)
  ⇒ 「秒 vs 毫秒」在 advance 这条接缝上**不出现**
2 nowMs 的唯一下游:saveToDb → saveVitalsToUsers(db,...,nowMs)
                              → saveRoomMobMem(roomId,...,nowMs)
  ⇒ **原样转发给落盘函数,不参与任何模拟算术**
```

⇒ 量纲安全。**但有一个真陷阱**:

```
⚠️ advance(frames) 的参数是**帧**。若有人"接线"时按秒算
   ⇒ advance(0.05) ⇒ Math.trunc(0.05) = **0** ⇒ 世界**永远不动,且不报错**
   (WorldSim.advance 对 n<=0 静默返回 0,不抛错)
⇒ 这不会让时间快 10³ 倍,而是让世界**完全静止** —— 一种更隐蔽的失败。
```

### 5 我自己的两次测量错误(必须记下,因为它们影响结论可信度)

**错 1:窗口过小造成假阴性。** `_t85_dims.ts` v1 用 `room.slice(idx, idx+900)` 截 `step()` 判定"有没有 advance",报 `✗ 否` —— 与源码矛盾。真函数体 **2934 字符**,900 字符只覆盖 **30.7%**,而 `host.advance(1)` 在 **1547 行**,超出窗口。
⇒ **用字符窗口截代码体判"有没有 X",窗口大小本身就是判据的一部分。** 正确做法是按**花括号配平**取全函数体。

**错 2:极性写反。** `_t85_sim.ts` v1 把判据返回值当成"是否红",于是**七条全部报反**。
⇒ `ok(cond)` 在 `cond===true` 时**绿**;`false` 时**红**。凡"两种状态"的判据,先写真值表再跑。

**错 3:用常见自然语言词做过滤器。** `_t85_bones2.ts` 的 T2 规则用注释含「零」过滤,捞出 **29 条**「护盾归零」「计时归零」这类**数值归零**断言,与接线毫无关系。
⇒ 用一个常见词做过滤器 = 没有过滤器。改成按**被测目标名**(`withDeps|host|advance`)过滤。

### 6 `_t85_e2e2.ts` 又抓到两个「在错误的层观测」

```
错 A:J5 收 0 帧 ⇒ 我先判"链路不通"
      但 srv.framesSent() = 79 ⇒ 服务端**确实在广播**
      真因:我的客户端只做了 WS 协议握手,**没发应用层 hello**
           ⇒ ws_server.ts:653 只在 `c.helloDone` 时发帧 ⇒ 一个字节都不发给我
      ⇒ "我没收到" ≠ "没发出" —— 两个判据,我在错的层数数
错 B:J6 反证用**字节数**判"世界有没有动" ⇒ 得到"host=null 也发了 24 帧"的反直觉结果
      真因:room.step() **总会** `meta.tick += 1` ⇒ tick 字段的差量永远非空(10B)
      ⇒ 「发了非空帧」**不能**证明世界在跑;正确判据是**解包看内容**
```

---

## 我不能证明的

1. **`room.colyseus.ts`(真 colyseus 服务端)生产里到底跑不跑。** 它因 `schema.colyseus.ts` 的 44 处 `@type` 装饰器而**无法被 Node 加载**,所以我**无法**起真 colyseus 服务端做端到端验证。所有端到端证据都来自 `ws_server.ts` 那条路。
2. **环境里有没有装 colyseus 的构建工具链**(tsc + 装饰器)。我没查 `package.json` 的 colyseus 脚本,也没试编译。
3. **"浏览器里真能多人跑"**。我只验到"服务端正确广播合法协议包";客户端渲染、输入上行解析(`ws_server.ts:591` **只 log 不解析**,task-82 已定性)都不在本卡范围。
4. **B 路(部署层注入 deps)是否有仓外调用方。** 仓内 0 调用点,仓外我观测不到。
5. **`demo.ts` 那条路的完整行为**。我只确认它 `new WorldSim` 且不 import RoomRuntime。
6. **four-path 表里的 `W` 是否等价**。`ws_server` 的循环与 `room.colyseus` 的 `setSimulationInterval` 语义相同(都是周期调 step),但我**没有**逐字段比对两者对 `prevState` 的维护是否一致。

---

## 第1步:三种编排方案的代价对比(a~e 五项逐一回答)

### 先答 a:谁持有 `WorldSim` 实例?

`git grep -n 'new WorldSim'` ⇒ **133 处**(分母 > 0 ✓)。按**文件类型**分桶:

| 桶 | 处数 | 说明 |
|---|---|---|
| `docs/**`(文档里的代码示例) | 8 | 不是可执行代码 |
| `scripts/verify.ts` | 15 | 门禁自检 |
| `tests/**` | ~105 | 测试夹具 |
| **生产侧(`server/src/**`)** | **2** | ★ 只有这两处是真装配 |

生产侧仅 2 处:

```
server/src/index.ts:201        const sim = new WorldSim({ ... })   ← A 路
server/src/sim/demo.ts:23      const sim = new WorldSim({ sizeCells: 64 })  ← 手动演示
```

⇒ **`room.ts` / `room.colyseus.ts` / `ws_server.ts` 都从不 new WorldSim。**
⇒ 世界源一律**由外部注入**(经 `RoomRuntimeOptions.host` / `WsServerOptions.room`)。

### ★ 四件套模型(本卡的核心分析工具)

一条能跑的链路需要四件:

```
P = 世界源(真 WorldSim 实例)
R = 房间(RoomRuntime 实例)
W = 驱动循环(周期性调 room.step)
H = room 的 host 指向 P(否则 step 里 host 为 null ⇒ 世界不推进)
```

**逐路径实测(P/R/W/H):**

| 路径 | P | R | W | H | 缺 |
|---|---|---|---|---|---|
| `sim/demo.ts` | ✓ | ✗ | ✗ | ✗ | 纯模拟,无网络 |
| `server/src/index.ts` | ✓ | ✓ | **✗** | ✓ | **没人驱动**(N6 还禁止它自推) |
| `net/room.colyseus.ts` | **✗** | ✓ | ✓ | **~** | host 靠 `withDeps`,调用点 0 |
| `sim/ws_demo.ts` | **✗** | ✓ | ✓ | **~** | host 是**手写假存根**(`DemoHost`) |
| ★ `assemble()` → `startWsServer()` | ✓ | ✓ | ✓ | ✓ | **无(已实测能跑)** |

⇒ **★ 关键发现:仓库里**每条**路径都缺一件,而"四件套齐备"的组合**只差把两个现成件对接**。
⇒ 这就是为什么"看起来全都接不上",却"端到端一测就通"。

### 三方案代价对比

| | **候选 A**<br>`room.step() → worldSim.tick()` | **候选 B**<br>worldSim 持有 room 回调 | **候选 C**<br>第三方编排层 |
|---|---|---|---|
| **a 谁持有 WorldSim** | 房间持有(需 `new WorldSim` 进 room.ts) | 模拟层持有,反向调 room | 编排层持有 |
| **b 快照怎么下发** | 天然:step() 直接产出 | 需 room 暴露"我该发什么"回调 | 编排层同时认识两者,自己串 |
| **c 会不会成环** | ★ **不成环**,但**会撞 K6** | ★ **成环**:`world_sim → room → world_sim` | ✓ 不成环,但有**两头耦合** |
| **d 双频怎么对齐** | 1:1,但 room 要知道 `FAST_PER_SLOW` | 同 A | 同 A |
| **e 量纲在哪转** | room 里出现秒/帧混用 ⇒ 风险**最高** | 同 A | 编排层集中转换 ⇒ 风险**最低** |
| **代价** | 与 K6 + N6 + backlog US2 探针**三条判据正面冲突** | 破坏"模拟层不依赖网络层"的**承重分层**;并让 world_sim 也进 `PROD_ENTRIES` 闭包检查 | **新文件** ⇒ 顶掉 README 的 `84/98` 数字(Lead 的警告);且编排层本身需要被装配⇒**多一层没人装** |
| **判定** | ✗ 与现有设计**故意对立** | ✗ 破坏 §立足点(那是全仓的一条承重不变量) | ✓ **但本仓已有它的等价物** |

**★ 我的推荐:候选 C 的一个特例 —— 不新建文件。**

`ws_server.ts` **已经**就是那个编排层:

```
ws_server.ts:333   WsServerOptions.room: WsRoomLike    ← 结构化类型,不 import 任何一层
ws_server.ts:646   payload = opts.room.step(prevState)  ← W(驱动)
ws_server.ts:684   prevState = opts.room.cloneState()   ← 基准维护
```

它**不 import** `room.ts`,也**不 import** `world_sim.ts` —— 依赖方向是"两边都不认识中间人",正是候选 C 想要的性质,而且**已经写好、已经测过(WS-13,14 用例)**。

⇒ **最小闭环的实现成本 ≈ 0 行生产代码。** 缺的只是"把 `assemble()` 接到它上面"的**一个部署层入口**,而 `index.ts` 刻意不 `listen`(CI 铁律)。

---

## 最小可运行闭环的定义(必须项 vs 可延后项)

### 必须项(缺任一条就不算"能跑")

| # | 条件 | 现状 | 证据 |
|---|---|---|---|
| M1 | 一个真 `WorldSim` 实例 | ✓ `assemble()` 内部 new | `index.ts:201` |
| M2 | 一个 `RoomRuntime`,`host` 指向 M1 | ✓ | 实测 `host 非 null` + `host 是真 WorldSim` |
| M3 | 一个周期驱动,每帧恰调 `step()` 一次 | ✓ `ws_server` 的 `setInterval` | `ws_server.ts:643` |
| M4 | `step()` 每帧恰推进世界一次 | ✓ | 实测 frame Δ=1/帧 |
| M5 | 快照经 `encodeDelta` 编码并至少发到一个玩家 | ✓ | 实测收 39 帧,可 `decodePacket` |
| M6 | 玩家位置投影**来自权威**(sim) | ✓ | 实测 `state.players[p1] = (22,10) = sim.playerPosition('p1')` |
| M7 | 两条状态**可区分**(host 有/无) | ✓ | `_t85_minloop.ts`:host=null ⇒ 等级投影整段跳过 |

⇒ **M1~M7 现已全部成立。** 这是本卡最重要的一条结论。

### 可延后项(下一张卡)

- 玩家输入**上行解析**(`ws_server.ts:591` 只 log 不解析 —— task-82 已定性)
- 客户端 prediction / 回滚
- `room.colyseus.ts`(真 colyseus 路径)的 host 注入
- B 路去留的**产品裁决**
- `MemberPresence`/重连语义与世界的耦合

---

## 硬骨头:哪些判据会因接线变红(逐条 文件:行号 + 原文 + 应改成什么)

**方法**:零写入文本级模拟(`_t85_sim.ts`)。判据正则**逐字抄自测试文件**;被测文本换成字符串变量。
**为什么不用真注入**:现在有 **8 个 teammate 并发**(5 个会读 `room.ts`/`index.ts`),真写入会开一个"别人读到我改坏的中间态"的窗口 ⇒ 造成**别人的偶发红**。这个代价不值得付。

### ★ 6 条会因接线变红

| # | 文件:行 | 原文 | 接线动作 | 应改成什么 |
|---|---|---|---|---|
| **B1** | `tests/WS-07.test.ts:4375` | `ok(!/WorldSim\|world_sim/.test(code),` | room.ts 加 `import type { WorldSim }` | **不要**引入该符号。走结构化接口则本条**永不红**;若某方案非引入不可 ⇒ 与本断言的设计意图冲突,需 Lead 裁决 |
| **B2** | 同上(第 2 个文件 `room.colyseus.ts`) | 同上,`files` 数组含两个文件 | 同上 | 同上 |
| **B3** | `tests/WS-07.test.ts:4845` | `ok(!/\b(sim\|world\|host)\s*\.\s*(advance\|tick\|run)\s*\(/.test(stripped),` | `index.ts` 自己加 `host.advance(1)` 或 `sim.tick()` | **装配层不得自推**。驱动归 `RoomRuntime.step()` 一处 ⇒ 这条**不该改**,该改的是接法 |
| **B4** | `tests/WS-07.test.ts:4854` | `eq(hits.length, 1, \`★ room.ts 里 host.advance 恰好 1 处(实测 ${hits.length})\`);` | `room.ts` 出现**第二处** `host.advance(` | 正确接法在 `step()` 内**复用**那一处,不新增 ⇒ 本条**不该改** |
| **B5** | `tests/WS-FND-12-wiring-paths.test.ts:102` | `eq(callSites.length, 0, \`withDeps 应无调用点,实测:${callSites.join(' \| ') \|\| '无'}\`);` | 出现真 `withDeps` 调用点 | **这是我自己的断言,且我自己写了变红条件**(L85 注释:「有人真的调了 withDeps(那就该更新本断言,并宣布 B 路已接上)」)⇒ 改成 `eq(callSites.length, N, ...)` 并同步 L13/L84 的理由文本 |
| **B6** | `tests/WS-FND-12-wiring-paths.test.ts:76-83`(FND12-3) | 断言 `host:\s*this\.deps\?\.host\s*\?\?\s*null` 形态存在于源码 | 把 `?? null` 改成别的 | 这是我钉的**源码形态**断言 ⇒ 若 B 路改动,须同步本条 |

### ☆ 1 条**方向相反**(不红,但翻面)

| 文件:行 | 原文 | 现状 | 接线后 | 该做什么 |
|---|---|---|---|---|
| `scripts/backlog.ts:313` | `probe: /WorldSim\|world_sim/,` | `dormant`(判"未开") | `firing`(判"已落地") | **不是改测试,是改文档**:`SIM-orchestration.md` 的账本行「互不依赖」会变陈旧 |

⚠️ 注意这条的**量纲**:它跑在 `room.ts` 的**代码态**上。所以:
```
只要 room.ts 不引入 WorldSim 这个名字,它**永远 dormant** —— 即使世界早就在跑
```
⇒ 这就是下面第 7 节说的**判据错位**。

### ★ 我自己的 WS-13:**结论是无冲突**(附证据)

Lead 特别要求检查 `tests/WS-13.test.ts`:

```
WS-13 用例数 = 14
提到 WorldSim/world_sim 的行数 = **0**
其中 ok(!...) / eq(...,0) 共 17 处,但**与接线相关的 0 处**
⇒ 它们钉的是「ws_server 不得引 ws 库 / 不得有第三方依赖」,与 US2 接线**不冲突**
```

⇒ **`tests/WS-13.test.ts` 不需要为接线做任何改动。** 这是反直觉的好消息:WebSocket 层的测试刻意用**结构化** `WsRoomLike`,所以它对世界源是真是假**无感**。

### 另:两条**行为态**判据(我的模拟不覆盖,单独标注)

```
tests/WS-FND-09-wiring.test.ts:230  eq(missing.length, 0, ...)   ← 两处 rtOpts 键集
tests/WS-FND-09-wiring.test.ts:233  eq(extra.length, 0, ...)
⇒ 我实测两处键集**现在逐字相等**(各 9 键)
⇒ 若接线只改一侧的键集 ⇒ 这两条**必红**
⇒ 标注:我**未**注入验证(它们是行为态,需真跑 assemble + 真读源码)
```

---

## ★ 额外发现:US2 探针量的不是"能不能驱动世界"

`backlog.ts` 的 US2 探针是 `/WorldSim|world_sim/`,跑在 `room.ts` 的**代码态**上。

```
现状:room.ts 代码态 0 命中 ⇒ 探针判「US2 未开」
实际:room.step() 每帧调 host.advance(1) ⇒ 世界**真的在跑**(实测)
```

⇒ **「探针说未开」与「功能已通」同时为真。** 原因:

```
探针量的是「room 认不认识 WorldSim 这个名字」
US2 真正要的是「房间能不能驱动世界」
⇒ 两者**不等价**,而且设计意图上**就应该不等价**
   —— WS-07 K6 存在的目的,正是**阻止** room.ts 引入这个名字
```

**这是一个判据设计缺陷,而两类互斥的判据正在互相打架:**

```
K6         : room.ts **不得**提及 WorldSim      ← 促成好设计
US2 探针   : room.ts **必须**提及 WorldSim 才算"已开"  ← 期待坏设计
⇒ 二者不可能同时满足。「接线」若照 backlog 的建议做(room.step 里调 worldSim.tick()),
  会让 K6 红;若照 K6 的设计做,US2 探针永远 dormant。
```

⇒ **建议(请 Lead 裁决)**:把 US2 探针从"名字出现"改成"行为成立",例如:
```
新探针:room.ts 代码态含 advance?( 且 含 host.advance(  ⇒ 判"已开"
理由:量"能不能驱动",不量"认不认识名字"
```

**⚠️ 这是脚本改动(`scripts/backlog.ts`),不在我写域**,故只报不改。

---

## 我建议的实现顺序(分片,每片可独立验收)

### 分片 0:判据裁决(**解锁其它片的前提,0 行生产改**)

| 项 | 内容 | 验收 |
|---|---|---|
| 0.1 | 裁决 US2 探针口径(名字 vs 行为) | `backlog.ts` 改后仍能正确分类当前状态 |
| 0.2 | 裁决 B 路去留 | 决定后 B5/B6 随之定稿 |

**理由**:B1~B6 全部是"接法 vs 判据"的取舍,而取舍取决于 0.1/0.2。**不先裁这个,后面每一片都会返工。**

### 分片 1:部署入口(最小闭环落地,建议 ~30 行,1 个新文件)

```
内容:一个显式部署入口(如 scripts/serve.ts 或 server/src/serve.ts),
      内部 assemble() → startWsServer({ room: runtime }),显式 listen。
不做:不 import room.colyseus.ts(那会让入口不可加载);
      不改 index.ts 的"不 listen"铁律(N6)。
验收:起服务 + 真 WS 客户端连上 + 收到可解码帧 + 世界帧随广播增长。
      此验收**现在就成立**(_t85_e2e2.ts 已证),故本片是"把它固化成测试"。
⚠️ 新建文件 ⇒ 顶掉 README 的 84/98 数字 ⇒ **需 Lead 先改 README**(你已提醒)
```

### 分片 2:上行解析(task-82 的欠账)

`ws_server.ts:591` 从"只 log"改成真 `decodePacket` + 交给 room。独立可验收。

### 分片 3:B 路裁决后的行动

要么删 B 路(含 `withDeps`/`gameServerConfig`),要么保留并写清"仅供部署层"。
**依赖分片 0.2。**

### 分片 4:colyseus 路径(最大、最不确定)

需先解决 `schema.colyseus.ts` 的 44 处装饰器与 Node strip-only 的冲突。
**建议单独立项**,不要在 US2 里做。

---

## 我留下的临时文件(逐名,按纪律未删)

```
_t85_premise.ts      第1步:三层口径复核「互不 import」+ 反证提取器有牙
_t85_iswired.ts      ★ 世界是否已被驱动(A/B 两路行为对比)
_t85_minloop.ts      ★ 四件套齐备时的最小闭环(且带 host=null 反证)
_t85_e2e.ts          端到端 v1(有两个判据错误,保留作为错误证据)
_t85_e2e2.ts         ★★ 端到端 v2:真 WS 客户端 + hello 握手,39 帧通过
_t85_dims.ts         量纲 v1(含窗口过小的假阴性,保留作为错误证据)
_t85_dims2.ts        ★ 量纲 v2:花括号配平取全函数体
_t85_hardbones.ts    硬骨头扫描 v1(宽泛正则)
_t85_bones.ts        硬骨头扫描(按被测文件分组)
_t85_bones2.ts       硬骨头扫描 v2(「零」字过滤 ⇒ 29 条假阳性,保留作为错误证据)
_t85_bones3.ts       ★ 硬骨头扫描 v3(按主角名过滤)
_t85_keysets.ts      ★ 两处 rtOpts 键集对比 + 候选改法 + 探针量纲澄清
_t85_sim.ts          ★★ 零写入模拟:6 条判据的接线后颜色
_t85_inject.ts       真注入方案(★ **未执行** —— 因 8 人并发,改用 _t85_sim.ts)
```

**未产生任何临时目录或副本**(`_t85_inject.ts` 的 `_t85_inj_work/` 从未创建)。

**我的写域内改动:0 行生产代码 + 1 个新文档**(即本报告)。

---

## 未做项 + 理由

| # | 未做 | 理由 |
|---|---|---|
| 1 | **未接线** | 你明确要求"先出方案等我批"。且实测结论是**缺口不在接线**(功能内核已通),贸然接会撞 B1~B6 六条判据 |
| 2 | **未跑真注入验证 B1~B6** | 8 个 teammate 并发,真写入会开"中间态被读到"的窗口 ⇒ 造成别人的偶发红。改用零写入文本模拟(判据等价,因为它们是纯文本函数) |
| 3 | **未验证 FND9-9 的两条键集断言** | 行为态判据,我的模拟不覆盖。只报了"当前键集逐字相等"这个事实 |
| 4 | **未起真 colyseus 服务端** | `room.colyseus.ts` 因 44 处装饰器不可被 Node 加载,起不来 |
| 5 | **未改 `scripts/backlog.ts`** | 不在写域 |
| 6 | **未改 `server/src/sim/world_sim.ts`** | 你禁止 |
| 7 | **未改 `SIM-orchestration.md` 账本行** | 不在写域,且需先有分片 0.1 的裁决 |

---

## 需要 Lead 裁决的三件事

1. **US2 探针口径**:改成"行为成立"(`advance?(` + `host.advance(`)还是保持"名字出现"?**这是分片 0 的前提。**
2. **B 路去留**:保留(写清"仅部署层")还是删除?决定 B5/B6 的走向。
3. **分片 1 要不要做**:它需要新建文件 ⇒ 需你先改 README 的 `84/98`。

**最后一句话**:这张卡的价值可能和预期不同 —— 它**不是**"接线大工程",而是**"三个判据/文档与事实错位"**。功能内核已经通了(39 帧端到端为证),真正的风险是**探针口径互相打架**,让"已通"长期显示为"未开"。
