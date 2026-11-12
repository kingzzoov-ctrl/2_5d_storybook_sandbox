# 客户端联机层缺口 —— 计划核查报告(task-63 后续)

> **任务**:核查「client 联机层」在**计划上**应不应该存在于本版。
> **范围**:只读 `docs/**` + `client/**` + `shared/**`;**未改任何现有源码**。
> **结论(先说)**:属于**甲 —— 设计上本版就该有联机层,但漏了**。
> 但「漏了」有一处必须说准:**不是漏在客户端,而是漏在「客户端网络层」这个从未被任何
> WS 任务书指派过归属的模块上**。详见 §5。

---

## 0. 一句话结论

```
client/src/net/prediction.ts  是**客户端预测/校正/插值**算法,不是网络层。
它的白名单理由「等客户端网络层」是**准确的** —— 那个「客户端网络层」
在计划里**被明确需要**(3 处独立文档要求),但**从未被任何任务书指派归属**。
⇒ 它不属于"某个人忘了做",属于"**没有任何人该做**"。
```

---

## 1. 我独立复核的数字(不照抄 Lead 的 grep)

**方法**:自己 walk `client/**`(`.ts` + `.html`),逐文件读全文,逐关键字计数。

### 1.1 文件与行数

| 文件 | 行数 |
| :--- | ---: |
| `client/index.html` | 56 |
| `client/src/main.ts` | 56 |
| `client/src/audio.ts` | 396 |
| `client/src/net/prediction.ts` | **457** |
| `client/src/stage/assembly_math.ts` | 578 |
| `client/src/stage/chunk_geometry.ts` | 352 |
| `client/src/stage/demo_world.ts` | 83 |
| `client/src/stage/dye_overlay.ts` | 353 |
| `client/src/stage/entity_sprites.ts` | 470 |
| `client/src/stage/iso_camera.ts` | 288 |
| `client/src/stage/particles.ts` | 400 |
| `client/src/stage/roof_transparency.ts` | 301 |
| `client/src/stage/shaders.ts` | 438 |
| `client/src/stage/tile_mesh.ts` | 405 |
| `client/src/three/audio_out.ts` | 164 |
| `client/src/three/boot.ts` | **1298** |
| `client/src/three/stage_assembly.ts` | 283 |
| `client/src/three/ui_binding.ts` | 648 |
| `client/src/ui/blueprint.ts` | 248 |
| `client/src/ui/boss_hud.ts` | 390 |
| `client/src/ui/inventory.ts` | 424 |
| `client/src/ui/panel_layout.ts` | 440 |
| `client/src/ui/pixel_easel.ts` | 361 |
| `client/src/ui/recipe_tree.ts` | 499 |
| `client/src/ui/state_machine.ts` | 317 |
| **合计** | **25 个文件 / 9,705 行** |

> ⚠️ **与 Lead 盘点有两处差异,以实测为准**:
> - Lead 说「约 1.2 万行」⇒ 实测 **9,705 行**。
> - Lead 说 `src/three/boot.ts` 1190 行 / `ui_binding.ts` 622 行 /
>   `prediction.ts` 427 行 ⇒ 实测 **1298 / 648 / 457**。
>   (Lead 的数字偏小,可能取自较早快照或用了 `Length` 字节数以外的口径。)

### 1.2 零网络断言(13 个关键字,全部 0 处)

```
colyseus        0    WebSocket       0    websocket     0
new WebSocket   0    fetch(          0    XMLHttpRequest 0
EventSource     0    sendBeacon      0    joinRoom      0
onMessage       0    socket          0    ws://         0    wss://  0
```

⇒ **Lead 的「纯离线单机渲染器」判断成立**,且比 Lead 的 4 个关键字更宽(13 个仍全 0)。

### 1.3 `prediction.ts` 的真实依赖面

```
唯一 import:  import { BASE_MOVE_SPEED, DT, TICK_HZ } from '../../../shared/types/physics.ts';
export 常量:  RECONCILE_DEADZONE / RECONCILE_HARD_SNAP / SMOOTH_WINDOW_S /
              INTERP_DELAY_S / SNAPSHOT_BUFFER_S / MAX_EXTRAPOLATE_S / TELEPORT_DISTANCE
```

**全仓 import 它的地方**(自己 walk,不靠 grep 工具):

```
tests/WS-07.test.ts:127   } from '../client/src/net/prediction.ts';
```

⇒ **生产引用 = 0 处**,Lead 这一条成立。

> ⚠️ **一处与 Lead 的差异**:Lead 说白名单在 `scripts/orphan-audit.ts:84`,且只有
> 「tests + orphan-audit 白名单」两处。实测**全仓唯一 import 就是 `tests/WS-07.test.ts:127`**;
> `orphan-audit.ts` 里那处是**白名单 Map 的字符串条目**,不是 import。
> 这个区别要紧:说明它是**真·孤儿**,不是"被脚本间接引用"。

---

## 2. 计划怎么说?(五个调查点的逐条回答)

### 2.1 WS-09 的职责边界:有没有「联机」这一条?

**答:没有。但 §1.1 明确规定了客户端**消费服务端状态**这一职责 —— 即联机是**前提**,不是选项。**

`docs/WS-09-client-render.md:15`(§1.1 首句,**原文**):

> WS-09 是**唯一的出图侧**,把**服务端的权威状态**变成玩家看得见的东西。

`docs/WS-09-client-render.md:26`(§1.2「本模块**不**负责什么」表内,**原文**):

> | 世界的权威状态 | WS-01/WS-04/WS-08 | 客户端**永不**判定,只**渲染收到的状态** |

**⇒ 关键推论:`WS-09` 反复用「收到的状态」「服务端的权威状态」描述自己的输入,
但它的 §1.2 那张"不负责"表里**没有一行**把「接收状态」指派给别人。**

这是本报告最关键的一处:**WS-09 假设自己会收到状态,却没有任何一节说明「谁负责收」。**

### 2.2 WS-07 的协议:有没有规定由谁消费?

**答:有,而且写了三遍。**

`docs/WS-07-net-persist.md:26`(§「职责」):

> 客户端渲染与 Three.js 场景由客户端子域负责;**本子系统只定义线上格式**。

`docs/WS-07-net-persist.md:471`(§8 耦合表,**逐字**):

> | **客户端** | 消费 `delta.ts` 的报文格式、`prediction.ts` 的校正语义;**必须用同一份 `FIELD_TABLE`** |

`docs/WS-07-net-persist.md:15`(验收用例 D 组标题):

> 客户端预测、服务端权威校正与远程实体插值(100ms 延迟 / 5% 丢包)。

⇒ **WS-07 明确把「客户端」列为消费方,并把「用同一份 `FIELD_TABLE`」写成要求。**
⚠️ 但**WS-07 同时声明「只定义线上格式」** ⇒ 它自己**不负责**实现客户端那侧。职责被推给了「客户端子域」。

### 2.3 `prediction.ts` 假设的调用方是谁?

**答:它假设的调用方是「一个已经持有服务端快照的客户端网络层」—— 那个东西不存在。**

`client/src/net/prediction.ts:2-11`(JSDoc 原文):

> `WS-07 · 移动预测、服务端权威校正与插值(零依赖核心)。`
> 1. **客户端预测**(`predictStep`):本地先跑一遍积分,立即出画面。
> 2. **权威校正**(`reconcile`):**收到服务端快照后**决定

`prediction.ts:115`:

> 软校正:客户端拿预测坐标 `predicted` 与**服务端权威** `authoritative` 比较。

`prediction.ts:194`:

> 抖动抑制:插值在**服务端 tick 时间轴**上做…

⇒ **它对调用方的假设是:「有一个地方能拿到服务端快照,并把它喂进 `reconcile`」。**
`reconcile(predicted, authoritative)` 的第二个参数**必须来自网络**。

**⇒ 白名单理由「等客户端网络层」在语义上是**准确的**:缺的正是"喂快照进来的那层"。**

⚠️ 但 `prediction.ts` 里有一个**极易误判点**(`CLIENT-NET-READINESS.md:62-67` 已记录):
`LossyChannel`(L290-339)的 `send()` **不是网络**。实测它是:
`mulberry32` 同款 LCG(L306-317)+ 内存队列 `this.queue`(L319-329)+ 虚拟时钟出队(L331-339)。
它是**给测试用的确定性丢包信道模型**。**它一根网线都不碰。**

### 2.4 `shared/` 里有没有协议 schema 的共享定义?

**答:有类型,但**没有**协议层。**

实测 `shared/` 全部 8 个文件:

```
shared/types/alchemy.ts      shared/constants/mobs.ts      shared/testing/harness.ts
shared/constants/bosses.ts   shared/constants/items.ts     shared/types/physics.ts
shared/types/tile.ts         shared/types/entities.ts
```

- **有**:`shared/types/physics.ts`(`BASE_MOVE_SPEED` / `DT` / `TICK_HZ` / `BodyState`)——
  `prediction.ts` 正是 import 它,证明**物理常量已共享**。
- **无**:任何 `delta` / `packet` / `snapshot` / `protocol` 类型的共享定义。
  `encodeDelta` / `decodePacket` / `applyPacket` 全在 `server/src/net/delta.ts`(`WS-07-net-persist.md:54`),
  **不在 `shared/`**。

⇒ **这是缺口的一处硬化证据**:WS-07 §8 要求「必须用同一份 `FIELD_TABLE`」,
但 `FIELD_TABLE` 在 `server/src/net/schema.ts`。**客户端若要用同一份,必须跨界 import `server/src/`。**
WS-07 已预见到这点(§「零依赖分层」),但**没给出客户端侧该怎么办**。

### 2.5 `docs/ARCH-GAPS.md` 里有没有已经登记这一条?

**答:没有登记"客户端网络层缺失"这一条。但登记了它的**三个**服务端侧前置。**

`ARCH-GAPS.md` 的六层空缺里,第四/五/六层都是 US2 的前置,**但没有一层是"客户端侧"**:

| 层 | 位置 | 内容 | 与客户端的关系 |
| :--- | :--- | :--- | :--- |
| 第一层 | `:43` | 容器层 —— `room` 不认识 `sim` | 纯服务端 |
| 第二层 | `:94` | 动作执行层 —— 权限层与执行层静默落差 | 纯服务端(且指出 15/22 动作无执行器) |
| 第三层 | `:182` | 入口可跑性 —— 「可达」≠「可跑」 | 纯服务端 |
| 第四层 | `:755` | US2 契约前置 —— 调用方自报参数 | 服务端 |
| 第五层 | `:516` | **US2 不是「接线」,是「先裁决唯一所有者」** | 服务端 |
| 第六层 | `:638` | 反作弊失明点 | 服务端 |

`ARCH-GAPS.md:280` 有一句**间接相关**:

> `orphan-audit.ts` 只把 `server/src` + `client/src` 当「生产侧」。

**⇒ `ARCH-GAPS.md` 全文谈的是 US2 的**服务端**前置。它把 US2 定义为
「room 持有 sim」,而 `SIM-orchestration.md:336` 同样这么定义(见 §4)。
两处都没提客户端。**

---

## 3. 决定性证据:`DEV-PLAN.md` 阶段 4 的 4.5

**这一条单独拿出来,因为它是「本版该不该有联机层」的直接答案。**

`docs/DEV-PLAN.md:159-167`(§阶段 4,选 A 之后的四项,**原文**):

| # | 事项 |
| :- | :--- |
| 4.1 | 写 `client/src/main.ts` 装配层(Canvas 初始化、相机、主循环、事件绑定) |
| 4.2 | 把 `three/stage_assembly.ts` 的 `three` 依赖改为可替换的相容层 |
| 4.3 | 接 `stage/*` 8 个模块(2,883 行)到渲染循环 |
| 4.4 | 接 `ui/*` 6 个模块(1,991 行)+ `audio.ts`(396 行) |
| **4.5** | **端到端:浏览器里真正跑起来,与 `RoomRuntime` 通信** |

⇒ **`4.5` 是计划里**唯一**一条把「浏览器 ↔ 服务端」连起来的事项。
它写着「与 `RoomRuntime` 通信」。**

**而实测:4.1 / 4.2 / 4.3 / 4.4 已完成(见 §1.1 文件清单,全部有实现),
4.5 的「通信」部分**完全没做**。**

`DEV-PLAN.md:188`(§四 总量与节奏表):

> | 4 | 客户端 | 3~5 | **浏览器里看得见、动得了** |

⇒ 出口标准是「看得见、**动得了**」。而"动"在多人语境下需要同步 —— 否则每个浏览器各动各的。

---

## 4. 三个「谁负责」的追问(定位"漏在哪")

### 4.1 US2 被定义成什么?

`docs/SIM-orchestration.md:336`(**原文**):

> | US2 | **网关联动未接** | `RoomRuntime` 与 `WorldSim` 互不依赖 |
> | 两者可组合:`RoomRuntime.step()` 里调 `WorldSim.tick()`,把快照喂给 `encodeDelta`。
> | 当前刻意解耦,便于分别测试 | Lead + WS-07 |

⇒ **US2 的定义完全是服务端的**:`RoomRuntime` + `WorldSim` + `encodeDelta`。
**US2 的验收里没有"客户端能收到"这一条。** 它到 `encodeDelta` 就结束了 ——
**报文产出后由谁送出去、客户端由谁收,US2 都不管。**

### 4.2 `CLIENT-NET-READINESS.md` 已经把这件事查清了一半

`docs/CLIENT-NET-READINESS.md`(**21,703 B**)是 **task-52** 的产物,**已存在**。
它的 §0 结论(**原文**):

> **客户端不是「网络层差一条接线」,而是「链路四个环节一个都没有」。**

它的 §4 给了 6 层缺口表(L0 依赖 → L5 接收),并指出:

> ⚠ 仓库级前置:客户端 SDK **不是依赖**
> `colyseus.js`(浏览器客户端 SDK)✗ **不在 `package.json` 任何字段**
> `node_modules/colyseus.js` 是否存在 ✗ `False`

⇒ **task-52 已经把「缺什么」查得很干净了。它没用一句话回答的是「计划上该不该有」。**
本报告补的正是这一句。

### 4.3 为什么不可能是「本版不做」(排除乙)

三条独立的排除证据:

1. **`DEV-PLAN.md:167` 的 4.5 明确写了「与 `RoomRuntime` 通信」** —— 若本版不做联机,这一条不会出现在阶段 4 的交付清单里。
2. **`WS-07-net-persist.md:471` 把「客户端」写进 §8 耦合表并要求「必须用同一份 `FIELD_TABLE`」** —— 若不做,这条要求没有对象。
3. **`WS-09-client-render.md:15/26` 反复以「收到的状态」为自己定义输入** —— 若不做,WS-09 的输入定义悬空。

**⇒ `乙`(设计上不做)被三条独立证据排除。**

### 4.4 为什么也不可能是「走了另一条路」(排除丙)

Lead 提醒「不要假设零网络代码就是漏了」,并举了 `settleBreak`/`applyBreak` 的先例。**我按这个纪律查了三条可能的替代路径,全部排除:**

| 候选「另一条路」 | 排除证据 |
| :--- | :--- |
| **服务端渲染 / SSR** | `DEV-PLAN.md:153` 明确否决:「C. 用 Node 自带的 `--experimental-strip-types` 服务端渲染 → **不现实(需要 DOM)** → **不可行**」 |
| **另一种同步方式**(如 RPC / 轮询) | 实测 13 个网络关键字全 0,包括 `fetch(` / `XMLHttpRequest` / `EventSource` / `sendBeacon`。**任何同步方式都需要其中一个,一个都没有。** |
| **`LossyChannel` 就是那条路** | `CLIENT-NET-READINESS.md:62-67` 已实测它是**内存队列 + 虚拟时钟**,给测试用。`prediction.ts:290` 自述「确定性丢包/延迟信道……保证测试可复现」。**不碰网线。** |

**⇒ `丙`(另有一条路)也被排除。**

---

## 5. 结论:甲,但「漏」的位置要说准

### 5.1 判定

**甲 —— 设计上本版就该有联机层,但漏了。**

### 5.2 ⚠️ 但「漏」的准确表述(这一条比结论本身更重要)

Lead 的表述是「**client 联机层缺失**」。**这个方向是对的,但会让接任务的人找错地方。**

准确的说法是:

> **缺的不是"客户端里的一段代码",而是"一个从未被指派过归属的模块"。**

证据:`WS-09 §1.2` 的「不负责」表里,**没有一行**说「接收状态归谁」。
`WS-07:26` 说「只定义线上格式」,把实现推给「客户端子域」。
`DEV-PLAN 4.5` 说要做「与 RoomRuntime 通信」,但**阶段 4 的 4.1-4.4 全在列举
`client/src` 内的模块**(main / stage / ui / audio),**4.5 是这四项的"端到端验收",
不是第 5 个交付物**。

⇒ **没有任何一份任务书、任何一个 WS、任何一条 DEV-PLAN 条目,把
「实现客户端网络层」本身写成一件要交付的事。**

这是本报告最有价值的发现:**它不是"某人忘了做"(那是执行问题),
而是"职责边界表里有一个洞"(那是计划问题)。** 与 `ARCH-GAPS.md` 反复描述的
「静默落差」同族,但这次落差在**计划层**,不在代码层。

### 5.3 为什么所有测试全绿(陷阱 54 的全局版)

Lead 说「所有测试全绿(1381 条),因为测试测的是各自模块」。**实测支持这个判断,并给出机制**:

- `prediction.ts` 被 `tests/WS-07.test.ts:127` 完整覆盖(D 组 11 条 + G 组端到端),
  **测的是纯数学** —— `reconcile` 的输入由测试**直接构造**,不需要真网络。
- WS-07 F 组 35 条测 `RoomRuntime` 生命周期,`room.colyseus.ts` 的 4 条 `onMessage`
  **用假 client 驱动**。
- ⇒ **每一端都被测了,两端之间的那条线没有任何测试覆盖它** —— 因为那条线**不存在**,
  没有对象可以写断言。

**⇒ 这正是「每块都对、拼起来不通」:两端各自的测试都对,而"能不能联机"这个命题
不属于任何套件。**

---

## 6. 最小可行接入设计(不用实现,给形状)

按 `CLIENT-NET-READINESS.md` §4 的 L0-L5 六层,补上**归属**与**最小验证点**。
**原则:先做能端到端证明"通"的那条最短路径(`move`),不要一次做 4 条通道。**

| 层 | 最小做法 | 端到端验证点(必须能红) |
| :--- | :--- | :--- |
| **L0 依赖** | 加 `colyseus.js` 到 `dependencies`;`vite.config.ts` 加 `proxy` 转发 ws | `import { Client } from 'colyseus.js'` 能被 vite 打包成功 |
| **L1 连接** | 新建 `client/src/net/connection.ts`:`Client` 实例 + `joinOrCreate` + leave + 重连 | 断言 `room.sessionId` 非空;与 `room.colyseus.ts` 真连一次 |
| **L2 序列化** | 复用 `server/src/net/delta.ts` 的 `decodePacket`/`applyPacket`(⚠️ 需裁决:客户端 import `server/src` 是否允许,或把 `delta.ts` 移入 `shared/`) | 用服务端 `encodeDelta` 的产物喂客户端 `applyPacket`,状态逐字节一致 |
| **L3 意图层** | `InputCmd` **已存在**(`prediction.ts:40-48`,无生产构造点)⇒ 在 `boot.ts` 主循环里构造 | `keys` 集合 → `InputCmd` 有非空构造点 |
| **L4 事件绑定** | `boot.ts` 的 `onKeyDown` 只需**追加**分支(不必重写) | 按键后 `InputCmd.seq` 递增 |
| **L5 接收** | 处理 `correct` / `reject`;`correct` 直接喂 `prediction.reconcile`(**算法已就绪**) | 注入一次服务端校正 ⇒ 客户端位置**真的收敛**(可区分力:不喂时位置不动) |

### ⚠️ 补一层:`L2.5 本地权威点清单`(§9 实测后才发现的)

`boot.ts` 里至少有两处在**自己算权威**(§9 实测):

```ts
boot.ts:1033-1034  playerGx = pan.x;   playerGy = pan.y;   // pan 被当玩家位置用
boot.ts:1041       bossHp = Math.max(...);                 // Boss 血量本地递减
```

**⇒ 接通网络前必须先把这些点列全并改成"从快照读"。**
否则接通后的症状是:**网络值与本地值同时写同一个显示** —— 表现为画面抖动/跳变,
**不报错、断言也不会红**(因为断言测的是各模块的纯函数)。

### ⚠️ 三件必须先裁决的事(不是接线,是决策)

1. **`FIELD_TABLE` 放哪?** WS-07:471 要求「必须用同一份」,但它在 `server/src/net/schema.ts`。
   客户端用它 ⇒ 跨界 import `server/src/` ⇒ 破坏「客户端零依赖服务端」的分层。
   **两选项**:把 `FIELD_TABLE` + `delta.ts` 移入 `shared/`,或允许客户端 import `server/src/net/`。
   **我倾向移入 `shared/`** —— 因为 `prediction.ts` 已经只 import `shared/types/physics.ts`,
   证明这个分层是刻意的。
2. **`attack` 的目标怎么表达?** `room.ts:638` 的 `applyAttack(userId, claimedBonus)`
   **签名里没有目标 id**;客户端也**没有「打谁」的概念**(`CLIENT-NET-READINESS.md:302-303`)。
   ⇒ **两端接口对不上**,这是 US2 的第四层空缺(`ARCH-GAPS.md:859` 已给出验收标准:
   「客户端报文只允许携带**意图**(打谁 / 朝向)」)。
3. **`action` 通道的语义是"权限预检"而非"执行动作"**。
   `room.colyseus.ts:184-187` 收到 `RoomAction` 后**只调 `authorize()`**,**无 `switch`**。
   15 个动作**无任何执行器**(`CLIENT-NET-READINESS.md:213-216`)。
   ⇒ 客户端发过去会收到 `allowed: true` 但**什么都不会发生** —— 比发不出去更难查。
   **建议 `action` 通道加一层「该动作是否有执行器」的显式拒绝。**

---

## 7. 我能证明的 / 我不能证明的

### 我能证明的(有 file:line + 原文)

1. `client/**` 25 个文件 / 9,705 行,**13 个网络关键字全部 0 处**(自己 walk 逐个计数)。
2. `client/src/net/prediction.ts` 457 行,**全仓唯一 import 是 `tests/WS-07.test.ts:127`**,
   生产引用 0 处(自己 walk `server/src` + `client/src` + `tests` + `scripts` + `shared`)。
3. `DEV-PLAN.md:167` 的 4.5 明确要求「浏览器里真正跑起来,**与 `RoomRuntime` 通信**」。
4. `WS-07-net-persist.md:471` §8 耦合表把「客户端」列为消费方,并要求「必须用同一份 `FIELD_TABLE`」。
5. `WS-09-client-render.md:15` 自述「把**服务端的权威状态**变成玩家看得见的东西」;
   `:26` §1.2 的「不负责」表里**没有**「接收状态」的归属。
6. `SIM-orchestration.md:336` 的 US2 定义**完全是服务端的**(到 `encodeDelta` 为止)。
7. `ARCH-GAPS.md` 六层空缺**全部是服务端侧**,无一条涉及客户端。
8. `DEV-PLAN.md:153` 明确否决了服务端渲染(替代路径丙被排除)。
9. `shared/` 无任何 `delta`/`packet`/`protocol` 类型定义(8 个文件全部读过)。

### 我不能证明的(明确列出)

1. **我没实测「colyseus.js 能否与 vite 8 / target es2022 兼容」** —— 依赖未安装,无法验证。
   (与 `CLIENT-NET-READINESS.md:322` 的"未实测"一致。)
2. **我没实测服务端监听端口与 vite dev server(5173)的联调方式**(是否需 ws proxy)。
3. **我没实测 `RoomSchema`(`schema.colyseus.ts`)与 `prediction.ts` 的 `Snapshot` 字段是否对齐**。
   这需要逐个字段比对 `FIELD_TABLE`(14 字段)与 `Snapshot` 的定义 —— 我没做。
4. **「没有任何任务书指派过客户端网络层」是"未找到"而非"证明不存在"。**
   我读了 `docs/` 下 50 个 `.md` 里的相关项(WS-07/WS-09/DEV-PLAN/ARCH-GAPS/SIM-orchestration/
   CLIENT-NET-READINESS),**但不排除**某个我没读的文档里有指派。
   **⇒ 这一条建议 Lead 用全局 grep 复核**(它是本报告的核心论断,值得二次确认)。
5. ~~我未核实 `boot.ts` 是否有本地权威模型~~ ⇒ **已核实,见 §9。结论:没有权威模型,
   只有量级更小的东西 —— 没有「玩家」这个概念。**

---

## 9. 收尾核查:`boot.ts` 有没有「本地权威」?(原本列在"不能证明"里)

**答:没有权威模型,但有比"缺联机"更基础的一件事 —— 客户端里根本没有「玩家」这个概念。**

### 9.1 实测:`pan` 是**相机**,不是玩家

`boot.ts:710`:
```ts
const pan = { x: WORLD_CELLS / 2, y: WORLD_CELLS / 2 };
```

按键推的是 `pan`(`boot.ts:1022-1026`),而 `pan` 直接喂给相机:
```ts
boot.ts:830-831   cam.focusX = pan.x;  cam.focusY = pan.y;
boot.ts:991-992   c.focusX = pan.x;    c.focusY = pan.y;
```

**⇒ 按下 WASD 的效果是「镜头平移」(与 `CLIENT-NET-READINESS.md:113-124` 一致)。**

### 9.2 但有一行把 `pan` **当成玩家位置**用

```ts
boot.ts:1033-1034   playerGx = pan.x;
                    playerGy = pan.y;
boot.ts:1035        updateRoof(dt / 1000);
```

`playerGx/playerGy` 只传给屋顶透明判定(`boot.ts:568` 的 `componentAt(..., playerGx, playerGy, ...)`)。

**⇒ `pan` 在两个语义之间被复用:相机焦点 + 玩家格坐标。**
目前**不产生 bug**(只有相机在动,所以两者恰好相等),但它意味着:
**接入网络层时,`pan` 必须拆成两个变量** —— 否则"相机看哪"与"玩家在哪"会第一次真正分叉,
而分叉的表现是**屋顶透明在错误的位置淡出**(不报错、不抛异常)。

### 9.3 客户端没有任何玩家实体概念

| 关键字 | `boot.ts` 中出现次数 |
| :--- | ---: |
| `addPlayer` | **0** |
| `spawn` | **0** |
| `entity` | **0** |
| `remote` | **0** |
| `other` | **0** |

`demo_world.ts`(83 行)也**不造玩家** —— 它只造地形 chunk。

**⇒ 客户端里只有一个"视点",没有"这个视点是一个玩家"这个事实。**
⇒ `prediction.ts` 的 `InputCmd` 就算被构造出来,**它也不知道属于谁** ——
因为客户端**没有给自己分配过 id**。

### 9.4 连 Boss 血量也是本地常量

```ts
boot.ts:489   const boss = BOSS_LIST[0] ?? null;
boot.ts:490   let bossHp = boss ? boss.baseHp : 0;
```

Boss 从 `BOSS_LIST`(**冻结层常量**)取,血量**从满血本地自己开始减**:
```ts
boot.ts:1041  bossHp = Math.max(boss.baseHp * 0.18, bossHp - (dt / 1000) * boss.baseHp * 0.035);
```
其自述是「**让血条可见地变化**」。

⇒ **这不是"模拟 Boss",是"给血条做动画"。** 它证明客户端当前的目标是**渲染演示**,
不是**呈现权威状态** —— 与 `WS-09:15` 的职责定义之间**存在方向性差异**:
WS-09 说"把服务端权威状态变成看得见的",而实际实现在**自己造状态**。

**⇒ 这个差异把 §5.2 的结论再推进一层**:
客户端不只是"缺网络层",它当前的**输入定义本身**就是从本地常量来的。
接入时改的不只是"加一个连接",还要把 `bossHp` / `playerGx` 这类**本地权威点**
改成**从快照读**。**这是 §6 那张表 L3 层之前、漏掉的一层:**
**L2.5「本地权威点清单」—— 必须先把客户端里所有"自己算权威"的地方列出来,
否则接通之后会出现"网络值和本地值两个都在写同一个显示"的分叉。**

---

## 8. 附:`prediction.ts` 白名单理由的准确性

`WS-07-net-persist.md:75-76` 记录了该理由的演变(**原文**):

> 搬迁后它**仍不可达**(客户端尚无网络层:`client/src/main.ts` 不 import 它,
> 且全文无 `WebSocket`/`colyseus`/`fetch`),
> 故白名单条目**保留但改理由**:从「待 rollback 路径接入」→「**客户端模块,待客户端网络层**」。

**⇒ 这条理由是**准确的**,且它自己就写着缺口在哪。
`task-40` 的判定「这是**放错位置**,不是**漏接线**」也是对的
(把它硬接进服务端 tick 会造出"服务端预测自己已是权威的东西",`WS-07-net-persist.md:74`)。

**⇒ 所以这不是一条"被错误登记"的白名单项 —— 恰恰相反,它是全仓登记得最准的一条。
它测出了真缺口,只是没人去补。**
