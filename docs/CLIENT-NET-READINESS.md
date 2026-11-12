# 客户端网络层与「输入 → 报文」链路盘点(task-52)

> **用途**:US2(`task-47`)「attack 报文接通」的客户端侧前置。
> **范围**:纯盘点,**未改任何 `.ts` 源码**。
> `我实测`(有 `file:line` 证据)与 `我认为`(推论)全程分开;不确定的写「未实测」。

---

## 0. 一句话结论

**客户端不是「网络层差一条接线」,而是「链路四个环节一个都没有」。**

实测:`client/src/` **24 个 `.ts` 文件里含 `WebSocket` / `colyseus` / `fetch` / `XMLHttpRequest` 的 = 0 个**。
既没有连接对象,也没有序列化,更没有「意图对象」——
输入事件的处理器**直接改本地渲染状态**,不产生任何可发送的数据。

⇒ US2 在客户端侧**不是接线,是先造一条链路**。且有一个**仓库级前置**:客户端 SDK (`colyseus.js`) **根本不是本仓依赖**。

---

## 1. 入口盘点:`index.html` → `main.ts` 之后有没有网络连接?

### 实测:没有。链路在 `boot()` 处终止于渲染。

**入口链**(3 跳,全部实测):

| 环节 | 位置 | 内容 |
| :-- | :-- | :-- |
| HTML | `client/index.html:52` | `<script type="module" src="./src/main.ts"></script>` |
| JS 入口 | `client/src/main.ts:21` | `import { boot, type BootHandle } from './three/boot.ts';` ← **全文件唯一 import** |
| 装配层 | `client/src/three/boot.ts` | 建 three 场景、绑事件、起 `requestAnimationFrame` 循环 |
| 终止 | `client/src/three/boot.ts:1061-1063` | `raf = requestAnimationFrame(tick);` / `raf = requestAnimationFrame(tick);` |

`main.ts` 全文 **56 行**,只做两件事(其自述 L6-L7):「找到容器、启动引擎」。
它甚至**刻意不 import three**(L7:「也**不** import three」)——
分层是 `main.ts(无三方依赖) → three/boot.ts(可 import three) → stage/*.ts(纯逻辑)`。
**这个分层里没有任何一层是网络层。**

### 实测:全客户端零网络能力

```
grep -E "WebSocket|colyseus|Client\(|fetch\(|XMLHttpRequest|EventSource|navigator\.sendBeacon" client/src/**/*.ts
→ 0 处命中
```

客户端 24 个 `.ts`(实测分布:`net/` 1、`stage/` 10、`three/` 4、`ui/` 7,加根目录 `main.ts` + `audio.ts` = 24 ✓ 与 Lead 观察一致)。

### `client/src/net/` 那 1 个文件是什么?—— **它不连任何东西**

文件是 **`client/src/net/prediction.ts`(456 行,17,292 字节)**。内容是 **WS-07 的纯算法层**,不是网络层:

| 导出 | 作用 |
| :-- | :-- |
| `predictStep` / `normalizeInput` / `maxSpeed` | 客户端移动预测(数学) |
| `reconcile` / `absorbOffset` / `resimulate` / `pruneCmds` | 服务端权威校正(数学) |
| `Interpolator` / `simulateInterpolation` / `secondDiffRms` | 远端实体插值(数学) |
| `LossyChannel` | **丢包/延迟信道 —— 但它是「数学模拟」,不是真连接** |
| `RECONCILE_DEADZONE` 等 7 个常量 | 阈值表 |

它的唯一 import 是 `shared/types/physics.ts`(L17,`BASE_MOVE_SPEED, DT, TICK_HZ`)。

**关键辨析**:`LossyChannel` 很容易被误读成「客户端已有网络层」。实测它内部是
`mulberry32` 同款 LCG 自造随机数(L306-L317)、`send()` 只把数据压进内存数组 `this.queue`(L319-L329)、
`advanceTo(ms)` 按虚拟时钟出队(L331-L339)。**它一根网线都不碰 ——
它是给测试用的确定性信道模型**(其自述 L290:「确定性丢包/延迟信道……保证测试可复现」)。

⇒ **`net/` 这个目录名是误导性的。** 客户端**有网络数学,没有网络。**

> **为什么 `prediction.ts` 在 `UNREACHABLE_EXEMPT` 白名单里**:它是纯逻辑,由 `tests/WS-07.test.ts` 消费,
> 生产路径零引用,**且尚未被 `main.ts` 闭包包含**。这正是「测试全绿 + 生产永不执行」那一档的合法登记项。

### ⚠ 仓库级前置:客户端 SDK 不是依赖

| 事实 | 实测 |
| :-- | :-- |
| `colyseus`(服务端)在 `package.json` | ✓ `optionalDependencies.colyseus: ^0.15.17` |
| `@colyseus/schema` 在 `package.json` | ✓ `optionalDependencies: ^2.0.34` |
| **`colyseus.js`(浏览器客户端 SDK)** | ✗ **不在 `package.json` 任何字段** |
| `node_modules/colyseus.js` 是否存在 | ✗ `False` |
| `node_modules/@colyseus/sdk` 是否存在 | ✗ `False` |
| `vite.config.ts` 有无 proxy / ws 转发 | ✗ 只有 `server: { port: 5173, host: true }`,**无 `proxy` 段** |

⇒ **要发报文,先得把客户端 SDK 加进依赖。** 这是 US2 客户端侧的**第一道前置**,且是
依赖决策(新增浏览器侧运行时依赖),不是接线动作。

---

## 2. 输入盘点:按键之后,内存里有没有「我要攻击 mob X」?

### 实测:**没有。处理器直接改本地渲染状态,不产生任何意图对象。**

事件绑定全集(实测 9 处,全在 `three/boot.ts` + `main.ts` 两文件):

| 位置 | 事件 |
| :-- | :-- |
| `boot.ts:950` | `window.addEventListener('keydown', onKeyDown)` |
| `boot.ts:951` | `window.addEventListener('keyup', onKeyUp)` |
| `boot.ts:984` | `cv.addEventListener('pointerdown', onPointerDown)` |
| `boot.ts:985` | `window.addEventListener('pointermove', onPointerMove)` |
| `boot.ts:986` | `window.addEventListener('pointerup', onPointerUp)` |
| `boot.ts:1071` | `window.addEventListener('resize', onResize)` |
| `main.ts:49` | `window.addEventListener('beforeunload', …)` |
| `main.ts:53` | `document.addEventListener('DOMContentLoaded', main)` |

**键盘处理器 `onKeyDown`(`boot.ts:925-948`)的全部行为**:把键名压进 `keys: Set<string>`(L926),
然后 `switch` 里**全是本地 UI 动作** ——
`i`/`r`/`e`/`p` 开关面板、`b` 切换 Boss 显示、`z`/`y`/`x`/`c` 是画板 undo/redo/clear/floodFill、`escape` 关面板。
**没有一个分支产生待发送数据。**

**鼠标/指针处理器**:`onUiPointerDown` 命中 UI 时直接改本地(如 `easel.paint(...)` L862、`paletteIndex = hit.index` L865);
命中世界时只写 `drag = {x,y}`(L885)与 `bpDrag`(L886)—— 那是**相机拖动**与**蓝图框选**,同样不产生报文。

**移动意图的产生方式(关键)**:移动**不是**事件驱动的意图,而是主循环里**按帧读 `keys` 集合算位移**:
```ts
boot.ts:1018-1027
if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
…
if (dx !== 0 || dy !== 0) {
  pan.x += (dx / len) * speed;   // ← 直接改相机位移
  pan.y += (dy / len) * speed;
  syncCamera();
}
```
⇒ 按键的效果是**镜头平移**(`pan`),不是「玩家朝某方向移动的意图」。
连 `prediction.ts` 的 `InputCmd{seq, moveX, moveY, jump}`(L40-L48)**在客户端生产路径上也没有任何构造点**。

### 实测:`attack` 这个概念在客户端根本不存在

```
grep -iE "attack|intent|Intent|send\(" client/src/**/*.ts
→ 命中项全部无关:
  prediction.ts:319  send(tick,x,y,z)      ← LossyChannel 的内存入队,不是网络
  prediction.ts:365  ch.send(t,x,y,z)      ← 同上(simulateInterpolation 内)
  audio.ts:106/133/143/153/164  attack:   ← ADSR 包络的 attack 时间
  audio_out.ts:83    adsr.attack           ← 同上
→ 「攻击」语义命中 = 0
```

**注意 `prediction.ts:319` 的 `send()`**:签名是 `send(tick, x, y, z): boolean`,
看起来像「发送移动报文」。但它是 `LossyChannel.send`,即 §1 那个内存队列。**这是本盘点最容易误判的一点。**

### 小结:三个「不存在」

| 应有物 | 现状 | 判据 |
| :-- | :-- | :-- |
| 连接对象(如 `Room` 客户端实例) | **不存在** | 全客户端 0 处 `WebSocket`/`colyseus` |
| 序列化 / 报文构造 | **不存在** | 无 `send('attack', …)` 类调用;唯一 `send` 是内存模型 |
| 事件绑定 → 意图对象 | **不存在** | `onKeyDown` 全分支为本地 UI;无 `attack` 语义 |
| *(半存在)* 意图数据结构 | `InputCmd` **已定义但无生产构造点** | `prediction.ts:40-48`;仅测试消费 |

---

## 3. 报文面清单:服务端收哪几条 × 客户端能否发送

### 实测:服务端收 **4** 条(与 Lead 引述一致)

服务端入口 `server/src/net/room.colyseus.ts:165-188`,自述 L164「**只有这些入口**能改权威状态」:

| # | 通道 | 载荷 | 下游 | 客户端能否发送 | 判据 |
| --: | :-- | :-- | :-- | :-- | :-- |
| 1 | `move` | `{tick,x,y,z,speedMul?}` | `runtime.applyMove` | **无** | 无连接对象;且无「玩家移动意图」生产点(§2) |
| 2 | `attack` | `{claimedBonus?}` | `runtime.applyAttack` | **无** | 无连接对象;客户端无 `attack` 语义 |
| 3 | `inventory` | `{ops:[{itemId,delta,source?}]}` | `runtime.applyInventory` | **无** | 无连接对象。**注意**:UI 侧有背包交互,但只改本地视图 |
| 4 | `action` | `{action: RoomAction}` | `runtime.authorize` | **无** | 无连接对象;且客户端不 import `RoomAction` |

服务端还会**下发** `correct`(L168)与 `reject`(L172/L182/L186)—— 客户端连**接收**也没有。

### 关于「22 个动作里 18 个没有通道」——实测的结论与任务书预设**不同**

Lead 的任务书基于「`RoomAction` 有 22 个,客户端消息面只有 4 条 ⇒ 18 个没有通道」。
**实测:这个推论的前提有误 —— 那 18 个不是「缺通道」,而是「根本没有执行器」。**

**证据**(全仓 `RoomAction.*` 的**全部**出现点,只有 4 处):
```
room.ts:566  const gate = this.authorize(actorId, RoomAction.SET_MEMBER_ROLE);
room.ts:583  const gate = this.authorize(actorId, RoomAction.KICK_MEMBER);
room.ts:596  const gate = this.authorize(actorId, RoomAction.SET_ROOM_ACCESS);
room.ts:611  const gate = this.authorize(actorId, RoomAction.SET_PARTY_MODE);
```

**`authorize()` 只判权限,不执行任何动作**(`room.ts:555-564` 全文:查成员 → `can(role,action)` → 返回 `{allowed, role}`)。
而这 4 个动作的真实执行器是**另一组方法**(`setMemberRole` L565、`kick` L582、`setAccess` L595、`setPartyModeBy` L610),
它们**各自显式**写死了 `RoomAction.SET_MEMBER_ROLE` 等常量 —— 也就是这 4 个动作**不经过报文**。

而 `action` 通道(`room.colyseus.ts:184-187`)收到任意 `RoomAction` 后,只做:
```ts
const gate = this.runtime.authorize(client.sessionId, msg.action);
if (!gate.allowed) client.send('reject', { kind: 'PERMISSION', reason: gate.reason });
```
**无 `switch`** —— 实测全仓**不存在任何按 `RoomAction` 分派的 dispatcher**
(`grep "switch (action)|action ===|RoomAction\.PLACE_BLOCK|…"` → 0 处命中)。

⇒ **`action` 通道的语义是「权限预检」,不是「执行动作」。** 发 `PLACE_BLOCK` 过去,
最多得到一句「允许/拒绝」,**方块不会被放置**。

### 逐个判据:22 个动作在生产代码里有没有触发路径

Lead 的追问是对的 ——「客户端没有发送代码」**只是必要判据,不是充分判据**。
下面每个动作查**两件事**:(a) 生产代码里有没有 `RoomAction.<它>` 的引用;
(b) 有没有**非报文**的生产触发路径(即服务端内部主动调用)。

| 动作 | `RoomAction.X` 引用 | 生产触发路径 | 判定 |
| :-- | --: | :-- | :-- |
| `MOVE` | 0 | ✓ 专属通道 `move` → `applyMove`(room.ts:622) | 经报文,已接 |
| `ATTACK` | 0 | ✓ 专属通道 `attack` → `applyAttack`(room.ts:638) | 经报文,已接 |
| `SET_MEMBER_ROLE` | **1** | ✓ `setMemberRole`(L565) | 有执行器,但**调用方只有 `tests/WS-07.test.ts`** |
| `KICK_MEMBER` | **1** | ✓ `kick`(L582) | 同上 |
| `SET_ROOM_ACCESS` | **1** | ✓ `setAccess`(L595) | 同上 |
| `SET_PARTY_MODE` | **1** | ✓ `setPartyModeBy`(L610) | 同上 |
| `SLEEP` | 0 | ✓ `checkIdleSleep()`(L926)→ `sleep()`(L474),由 `step()`(L767/L772)调用;`step()` 由 `room.colyseus.ts:136` 的 20Hz `setSimulationInterval` 驱动(L100) | **真·服务端内部触发**,与报文无关 |
| 其余 15 个 | **0** | **无** | 见下 |

**那 15 个「0 引用 × 无触发路径」的动作是**:
`PLACE_BLOCK` `BREAK_BLOCK` `PICKUP_ITEM` `DROP_ITEM` `CRAFT` `USE_ALCHEMY_FURNACE`
`OPEN_CHEST` `USE_OWN_CHEST` `START_PARTY` `RESET_WORLD` `CLOSE_ROOM` `MODIFY_TOWN`
`PLACE_AUTOMATION` `WIRE_EDIT` `BREED_TAME`。

**判据是三重独立的:**

1. **`RoomAction.<它>` 全仓 0 处引用**(上表逐个数过)
2. **`room.ts` 的 48 个公开方法里没有对应执行器** —— 实测方法名含
   `join, wake, sleep, close, leave, disconnect, authorize, setMemberRole, kick, setAccess,
   setPartyModeBy, applyMove, applyAttack, applyInventory, step, …`,
   其中**没有** `placeBlock` / `breakBlock` / `pickup` / `craft` / `openChest` / `startParty` 之类。
   (`close()` L482 存在,但它是房间生命周期方法,不收 `actorId`、不经 `authorize`,与 `CLOSE_ROOM` 动作无关。)
3. **全仓无 dispatcher** —— `switch (action)` / `switch (msg.action)` / `case 'MOVE'` /
   `case RoomAction` 全部 **0 处**;`action ===` 唯一命中在
   `client/src/three/boot.ts`(画板 `hit.action` 比较,**与 `RoomAction` 无关**)。

⇒ **结论回答 Lead 的问题**:这 15 个**既不是「设计上服务端触发」,也不是「客户端还没做」**。
它们是**服务端自己的欠账** —— `RoomAction` 枚举与 `ACTION_PERMISSION` 权限矩阵
**先行定义了 22 个动作的接口,但其中 15 个连执行代码都还没有**。
即使客户端把 22 个报文全部发出去,也只有 `MOVE` / `ATTACK` 会走到执行器。

> ⚠ **这改变了 US2 的可行性判断**:客户端侧补完链路后,`action` 通道能到的只有 `authorize()`,
> 而那 15 个动作在 `authorize()` 里**会返回 `allowed: true`**(只要角色权限位够)——
> **客户端会收到「允许」,但什么也不会发生**。这比「发不出去」更难查:它看起来成功了。
> **建议 US2 的 `action` 通道加一层「该动作是否有执行器」的显式拒绝**,
> 而不是让 `authorize()` 对空动作返回成功。

**因此 22 个动作的真实分类是**(逐个数过,合计 22;判据见下节):

| 类别 | 数量 | 成员 | 说明 |
| :-- | --: | :-- | :-- |
| **经报文 + 有真实执行器** | **2** | `MOVE`、`ATTACK` | **不经过 `action` 通道**:走同名独立通道 `move` → `applyMove`(L622)、`attack` → `applyAttack`(L638)。`RoomAction.MOVE` / `RoomAction.ATTACK` 常量**全仓从未被引用** |
| **有执行器,但生产调用方为 0** | **4** | `SET_MEMBER_ROLE`、`KICK_MEMBER`、`SET_ROOM_ACCESS`、`SET_PARTY_MODE` | 这 4 个是**唯一**被 `RoomAction.X` 显式引用的动作(L566/583/596/611),执行器为 `setMemberRole` / `kick` / `setAccess` / `setPartyModeBy`。⚠ **实测:这 4 个方法的生产调用方 = 0**,只有 `tests/WS-07.test.ts` 在调 |
| **服务端内部触发(与报文无关)** | **1** | `SLEEP` | `checkIdleSleep()`(L926)→ `sleep()`(L474),经 `step()`(L767/L772)由 Colyseus 20Hz `setSimulationInterval` 驱动(`room.colyseus.ts:100/136`)。**唯一真正「设计上不由客户端发起」的动作** |
| **无任何执行器** | **15** | `PLACE_BLOCK` `BREAK_BLOCK` `PICKUP_ITEM` `DROP_ITEM` `CRAFT` `USE_ALCHEMY_FURNACE` `OPEN_CHEST` `USE_OWN_CHEST` `START_PARTY` `RESET_WORLD` `CLOSE_ROOM` `MODIFY_TOWN` `PLACE_AUTOMATION` `WIRE_EDIT` `BREED_TAME` | 只在 `RoomAction` 常量表与 `ACTION_PERMISSION` 权限矩阵里登记,**全仓无执行代码、无触发路径** |

> **计数口径(每个数字给分母)**:对 22 个动作**逐个**匹配 `RoomAction.<名>` 精确引用
> (分母 = `server/src` 59 + `client/src` 24 = 83 个 `.ts`,排除 `_*` 临时脚本)。
> 结果:`RoomAction.X` 形式全仓**仅 4 处**命中(即上表第 2 类),
> 其余 18 个动作**一次都没有以 `RoomAction.X` 形式出现**。合计 2+4+1+15 = 22 ✓。
>
> ⚠ **`inventory` 通道不属于 `RoomAction`**:`applyInventory`(L663)处理物品增减 `ops`,
> 不经过动作枚举。所以「客户端 4 条通道」与「22 个 `RoomAction`」是**两个不同的坐标系**,
> 不能直接相减得「18 个缺通道」——这是任务书那处推论的漏洞来源。

**这张表直接回答 Lead 的问题**(「这 18 个是客户端还没做,还是设计上不由客户端发起?):

**两者都不是 —— 是第三种:服务端自己的欠账。**
- 只有 **1 个**(`SLEEP`)真的是「设计上服务端内部触发」;
- **4 个**有执行器,但**连生产调用方都没有**(只被测试调用)—— 这既不是「客户端还没做」,也不是「服务端主动触发」,而是**管理入口尚未接线**;
- **15 个**的动作层**完全没有实现**(接口先行,实现缺位)。

⇒ 即使客户端把 22 个报文全部发出去,也只有 `MOVE` / `ATTACK` 会走到执行器。

> ⚠ **这是服务端欠账,不在我本次写域**(`server/**` 明确禁止改动)。
> 记录在此因为它**改变 US2 的可行性判断**:见 §5。

---

## 4. 缺口表:每条报文缺什么才能发

按「补什么」排列,自底向上(**下层的缺口不补,上层的活干了也白干**):

| 层 | 缺口 | 具体要补什么 | 阻塞谁 | 实测判据 |
| :-- | :-- | :-- | :-- | :-- |
| **L0 依赖** | 客户端 SDK 不存在 | `package.json` 加 `colyseus.js`(+ 其 `@colyseus/schema` 运行时);确认 vite 能打包 CJS | **全部报文** | `node_modules/colyseus.js` = `False` |
| **L1 连接** | 无连接对象 | 新建客户端网络层(如 `client/src/net/connection.ts`):连 `ws://host:port`、房间 join/leave、生命周期、异常重连 | 全部报文 | 全客户端 0 处 `WebSocket`/`colyseus` |
| **L2 序列化** | 无报文构造/发送 | 定义 `send(channel, payload)`;4 条通道各自载荷类型(可与 `shared/contracts` 复用) | 全部报文 | 无任何 `send('move'…)` 类调用 |
| **L3 意图层** | **无意图对象生产点** | 把输入翻译成意图:移动 = `InputCmd`(**已有结构,无构造点**,`prediction.ts:40`);攻击 = 需**新建** `AttackIntent`(目标选择从哪来?) | `move`/`attack` | 客户端 `attack` 语义 0 命中 |
| **L4 事件绑定** | 事件已绑,但语义不对 | 现有 `onKeyDown`/`onPointerDown` 只需**追加分支**(攻击键 + 目标拾取),不必重写 | `attack` | §2 绑定表 |
| **L5 接收** | 无 `correct`/`reject` 处理 | 处理服务端下发的 2 类消息;`correct` 可喂 `prediction.reconcile`(**算法已就绪**,只缺接线) | 校正/回滚 | `room.colyseus.ts:168/172/182/186` |

**唯一「已经准备好了」的一环**:`prediction.ts` 的校正与插值算法
(`reconcile` / `absorbOffset` / `resimulate` / `Interpolator`)是完整的纯逻辑,
一旦 L1-L2 通了,`correct` 处理可以直接消费它 —— **这部分不需要新写算法。**

---

## 5. 对 US2 的结论

### 实测结论

1. **客户端侧不是接线,是造链路。** 4 条通道**全部**「无」,且缺口在 **L0 依赖层**——
   客户端 SDK 连依赖都不是。
2. **`attack` 是 4 条里最难的一条**(不是最简单):
   - `move` 的意图结构 `InputCmd` **已存在**;
   - `attack` 连「打谁」这个数据都没有 —— 需先定**目标选择**语义
     (最近敌人?鼠标拾取的 mob?朝向格?)。
   - `applyAttack(userId, claimedBonus)` 的签名(`room.ts:638`)只收 `claimedBonus`,
     **不含目标 id** ⇒ 服务端也无法知道玩家想打谁。**两端的接口对不上。**
3. **服务端 22 个动作里只有 2 个经报文并真的会执行**(§3:`MOVE`、`ATTACK`)。
   US2 若目标是「attack 生效」,它会一路通到 `applyAttack` —— 而实测 `applyAttack` **只做反作弊校验、不施加伤害**:
   ```ts
   room.ts:638-642   applyAttack → this.ac.attack(...) → 写 pendingViolations → return v
   anticheat.ts:527-533  attack → checkAttack(...) → 返回 Verdict
   ```
   即 **`attack` 报文当前只能产生「违规记录」,不产生伤害**。这是 US2 必须知道的边界。

### 我认为(推论,未独立验证)

1. US2 应拆成 **服务端语义** 与 **客户端链路** 两条独立线,因为二者的缺口类型完全不同
   (前者缺执行器,后者缺依赖+连接+意图三层)。
2. `move` 通道应**先于** `attack` 接通:它的意图结构已存在,可用作 L1-L3 的**首个贯通验证**。
3. 「22 个动作」这个数字不适合当 US2 的进度指标 —— 实测 15 个连服务端执行器都没有,
   客户端补完也只是把报文丢进 `authorize()` 的黑洞;且这两个坐标系(4 条通道 / 22 个动作)不能直接相减。

### 未实测项(明确列出)

- `colyseus.js` 与 vite 8 / `target: es2022` 的打包兼容性 —— **未实测**
- 服务端监听端口与 `vite` dev server(`5173`)的联调方式(是否需 proxy)—— **未实测**
- `RoomSchema`(`schema.colyseus.ts`)与 `prediction.ts` 的 `Snapshot` 字段是否对齐 —— **未实测**
- `correct` 报文的实际载荷形状(`verdict.corrected ?? null`)在客户端如何消费 —— **未实测**
- 移动端(触摸)是否需与键鼠不同的意图路径 —— **未实测**

---

## 6. 附录:`attack` 链路两端对照(US2 的直接输入)

| 环节 | 服务端(已实测) | 客户端(已实测) |
| :-- | :-- | :-- |
| 接收 | `onMessage('attack', msg => …)` `room.colyseus.ts:170` | 无 |
| 载荷 | `{claimedBonus?: number}` | 无对应构造 |
| 校验 | `applyAttack` → `ac.attack` → `checkAttack` `room.ts:638` / `anticheat.ts:527` | — |
| **目标** | **签名里没有目标 id** | **没有「打谁」的概念** |
| 效果 | 仅 `pendingViolations`(反作弊流水),**无伤害** | 无 |
| 失败回执 | `client.send('reject', {kind:'ATTACK'})` `room.colyseus.ts:172` | 无接收处理 |

⇒ **US2「attack 报文接通」需要先裁决三件事**:目标如何表达、伤害由谁施加、以及客户端从哪一层开始造。
这三件都**不是接线问题**。