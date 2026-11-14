# task-84 报告:WS-11 缺口 A(对局运行时)可行性 + 精确方案

> 作者:`build-wiring`　｜　状态:**判定「该接,但接点全在我的写域之外」** ⇒ 请 Lead 裁决接点
> 基线:`node tests/WS-11.test.ts` → **85/85 通过**;`node tests/WS-FND-11-afk.test.ts` → **14/14 通过**(均为改动前实测)
> 本报告**未改动任何生产代码或测试**(0 行改动)

---

## 我能证明的

| # | 结论 | 证据(可复跑) |
| :-- | :--- | :--- |
| 1 | WS-11 自己那份文档**没有**写这两个缺口的处置方案 | 1006 行全文关键词扫描,只有 **3 行**涉及宿主/驱动,且都是「假设」不是「方案」(见 §1) |
| 2 | 但**另一份文档 `docs/ARCH-GAPS.md` 写了**,而且写的是「**这不是接线,是三层叠加专项**」 | `ARCH-GAPS.md:42-43 / 493-523`(见 §1 末) |
| 3 | 可达闭包 = **84 个文件**,其中 party/coop/social/prank = **0** | 口径见 §2.0;探针 `_t84m.ts` |
| 4 | **闭包 ∩ 我的写域 = 0 个文件** | 同上 ⇒ 我在写域内**无法**让这 4 个文件可达 |
| 5 | 唯一 4 个合法接点全在写域外,且 2 个是承重文件 | `index.ts` / `net/room.colyseus.ts` / `net/room.ts`(承重) / `sim/world_sim.ts`(承重) |
| 6 | 卡上「`TeamKey` 全仓 0 个文件含它」**是假命题** | `party/scoring.ts:38` 定义、`party/modes.ts:58` 导入(见 §3b) |
| 7 | `tickRushOrder` **已经内部驱动** `tickStation`/`tickBeaver` | `rush_order.ts:931 / :947` ⇒ 驱动器只需调 **4 个**顶层入口,不是 8 个(见 §3d) |
| 8 | 仓内**已有同族先例**:`wiring/logistics.ts` 由 `world_sim.ts` 慢帧驱动,且**已从白名单摘除** | `world_sim.ts:3686` + `verify.ts` 中 `wiring/logistics.ts` = **false**(见 §3a) |
| 9 | 卡上「13 条必然变红」**口径过宽**:纯 `world_sim` 型驱动器只会红 **3 条** | 逐条语义判定见 §4 |
| 10 | 表征「13」的两个口径**不是同一个数**(巧合同值) | §4.0 |

## 我不能证明的

- 我**不能**证明「把驱动器放进 `world_sim.tick()` 之后,WS-11 的 4 个文件在生产里真的被正确驱动」—— 因为我不被允许改那个文件,无法实测。
- 我**不能**证明 ARCH-GAPS.md 的三层专项里「动作执行层」与「每帧驱动」是**同一件事**还是**两件事**。实测它们**互相独立**(见 §3d 末),但「独立」不等于「不该一起做」。
- 我**不能**给出接线后的确切白名单数字。理由:桶构成由门禁**对理由文本跑正则**算出(Lead 上一轮我刚踩过这个坑),我没法在不改 `scripts/verify.ts` 的前提下复算。

---

## 第 1 步:那份文档是否已写处置方案?

### 1.1 `docs/WS-11-coop-prank-party.md` —— **没有**

全文 1006 行,对 `宿主 / 持有者 / 驱动器 / 接线 / 由谁 / 房间 tick / 每帧 / tick` 做关键词扫描,**只有 3 行**沾边:

```
L74   advance(sec: number): number;   // 手动推进        ← 时钟接口定义,与宿主无关
L699  | 皇冠已有人持有 | crownPickup 返回 false | H3 |    ← 「持有」指持冠,不是持有运行时
L717  - 本子系统全部为单线程事件式接口:同一 session 的写入由房间 tick 串行化,不引入锁。
```

**L717 是整份文档唯一提到驱动的地方**,而它写的是一条**并发假设**,不是方案:它说明了「不许加锁」的**理由**,没有说明「谁、在哪个文件、哪个函数里调 `tickPartyMode`」。

★ 而且文档在 §8 反过来**给接线加了限制**,这条限制直接决定 §3a 的答案:

```
L743  **禁用耦合**
L745  - 不 import `server/src/physics/**`、`server/src/combat/**`、`server/src/net/**`
        (避免循环依赖与 scope 越界)。
```

⇒ **WS-11 模块不许 import `net/**`** ⇒ 驱动器**不可能**住在 party/coop/social 里再由 net 调用;方向只能是 **net/sim → party**,即驱动器必须住在**上游**,而所有上游接点都在我的写域之外。

另:文档 §9 L752 声称「`tests/WS-11.test.ts` 共 **79 条**断言」—— 该文件现为 **1890 行 / 85 条**。这是**理由文本过期**(数字不影响任何门禁,所以从不报警)。我未改它(不在写域)。

### 1.2 `docs/ARCH-GAPS.md` —— **写了,而且比本任务卡更准**

这份文档把「缺口 A」拆成**三层叠加**,并明确说**只做一层会二次返工**:

```
L42  三层是叠加的:只解决下层,上层依然堵着。**这是本文最重要的一句话** ——
L43  若专项只做「容器层」,`rush_order.ts` 那类模块**仍然收不到动作**,会二次返工。

L46-49
      第三层  入口可跑性      可达 ≠ 可跑          ← 门禁结构上查不到
      第二层  动作执行层      授权存在、执行不存在  ← 失败是静默的
      第一层  容器层          room 不认识 sim      ← 有书面自述

L499  **为什么三层必须一起**:它们是叠加的。
L501  - 只做第一层(容器)⇒ `rush_order.ts` 依然收不到动作(第二层堵着)
L502  - 只做第二层(执行)⇒ `room.colyseus.ts` 跑不起来,新测试执行不到(第三层堵着)
L503  - **⇒ 任缺一层,专项都会二次返工。**
```

它甚至已经给出了**验收标准**(L505-516)与**留给 Lead 的未决问题**(L518-523):

```
L521  - 「动作执行」到底归 WS-07 还是各子系统 WS?
         (本文结论:**失败模式归谁**比执行归谁更该定)
```

### 1.3 第 1 步的结论(直接回答)

> **WS-11 那份文档没有写方案;`ARCH-GAPS.md` 写了,但它的结论是「这是三层专项,不是接线」。**
>
> 因此本任务卡的框架(「WS-11 缺口 A = 对局运行时,给接线方案」)**与仓内已有结论不一致**:
> - 卡把缺口 A 当成**一条线**(每帧驱动);
> - `ARCH-GAPS.md` 证明它前面还压着**两层**(容器层:room 不认识 sim;执行层:`RoomAction` 无分发器)。
>
> ★ 我实测了这两层与「每帧驱动」的关系(§3d 末):**它们互相独立**。
> 「每帧驱动」**不需要**「动作分发器」即可落地 —— 只要数据源不是玩家动作,而是房间/世界已有的态。
> ⇒ 所以卡的范围**可以**独立成立。但**不能**把这次接线宣称成「WS-11 已经可用」——
>   玩家**仍无法**触发 `submitDelivery` / `bridgeCapture` / `crownPickup`,因为那需要执行层。

这一条是本报告最要紧的措辞纪律:**接上每帧驱动 ≠ 玩家能玩**。

---

## 缺口 A 的精确方案:a~e 逐项

### 2.0 先把口径钉死(不然所有数字都不可复核)

| 项 | 值 |
| :--- | :--- |
| 可达闭包口径 | 从 `scripts/verify.ts` 的 `PROD_ENTRIES`(5 个根)**出发**,沿**相对 `import` 边**做传递闭包,只用**存在**的文件 |
| 根的实测 | 声明 **5** 个,存在 **5** 个(`sim/ws_demo.ts` / `index.ts` / `sim/demo.ts` / `net/room.colyseus.ts` / `client/src/main.ts`) |
| 闭包大小 | **84** |
| 闭包 ∩ `server/src/{party,coop,social,prank}/` | **0** |
| 闭包 ∩ 我的写域 | **0** |
| 分母 | 84 > 0 ✓ |
| 探针自检 | 全仓 `__zzz_nope__` 命中 **0**(排除 `_` 前缀探针文件后) |

★ 我此前两轮报过 83 / 84 两个数,差异来自「闭包内是否计入根自身」的写法。**定稿 84**,并注明:该数会随任何并发写者新增 import 而变,不是常量。

---

### 3a 驱动器放在哪个文件、哪个函数?

**候选只有 4 个,全部实测**:

| 接点 | 在闭包内 | 在我的写域 | 承重 | 可行性 |
| :--- | :-: | :-: | :-: | :--- |
| `server/src/sim/world_sim.ts` `tick()` | ✓ | **✗** | **✓ 承重** | ★ 唯一符合先例,但须 Lead 授权 |
| `server/src/net/room.ts` `step()` | ✓ | **✗** | **✓ 承重** | 违反 §8 L745(party 不许 import net ⇒ 反向可以,但 net 已 2170 行且是多方共用) |
| `server/src/index.ts` `assemble()` | ✓ | **✗** | 否 | 只在装配期,不是每帧 |
| `server/src/net/room.colyseus.ts` | ✓ | **✗** | 否 | 该文件**当前无法被 Node 加载**(装饰器 + CJS 命名导入)⇒ 新代码测试执行不到 |

#### 推荐:`world_sim.ts` 的 `tick()`,照抄 `wiring/logistics.ts` 的既有形态

仓内**已经有同族先例**,而且它**正好已经通过了门禁**(不在白名单里):

```
world_sim.ts:83    } from '../wiring/logistics.ts';            ← 慢帧模块被 sim import
world_sim.ts:3686        this.tickLogisticsStep();             ← 在 tick() 的 isSlow 块内被调用
```

实测:`'server/src/wiring/logistics.ts'` 在 `verify.ts` 中 = **false**,在 `orphan-audit.ts` 中 = **false**
⇒ 这条模块**已被接线并成功摘出白名单**。它就是把「闭包内的文件(0 个)」变成「1 个」的**唯一已成功先例**。

#### 具体位置(为什么是这个位置,不是别处)

`tick()` 的结构实测(`world_sim.ts:3529` 起):

```
L3530  this.frameCount += 1;
L3532  const isSlow = frame % FAST_PER_SLOW === 0;      ← 双频:快 20Hz / 慢 2Hz
L3547  physics = this.physics.step(SIM_FAST_DT);        ← 快帧
L3548  this.syncPlayers();                              ← 快帧同步玩家
L3560  this.tickDots();                                 ← 快帧 DoT
...
L3660  if (this.wiringOn) {                             ← 慢帧块
L3664    const st = this.wiring.tick();
L3686    this.tickLogisticsStep();                      ← ★ 先例位置
L3687  }
L3689  /* 慢帧 2Hz:建造 / 房间识别 / 蓝图接力(task-36) */
```

⇒ **驱动器应写成 `private tickPartyStep(): void`,在 L3686 之后、L3689 之前调用**,处于 `isSlow` 块内。

**频次必须选慢帧(2Hz)的依据**,不是我挑的,是文档 §6.3 与 §6.1 的数字:

```
§6.1 L648  全部 WS-11 每帧逻辑合计 < 0.05ms,占 20Hz 帧预算的 0.1%
§6.3      低频帧(2Hz)适用性
```

但这**还不够** —— 有两处**必须 20Hz**:
- `tickAfk(p, nowSec, dt)` 的 `dt` 语义是「每帧实际时长」;
- 文档 L3551-3557 记着**同族事故**:DoT 放进 2Hz 却仍按 `0.05s` 折算 ⇒ 总量偏小一个数量级,而「有没有烧」看不出来。

⇒ **必须逐模块定频,不能一刀切 2Hz**:

| 模块入口 | 建议频次 | 依据 |
| :--- | :--- | :--- |
| `tickRushOrder(s, dt, opts)` | **慢帧 2Hz**,`dt = SIM_SLOW_DT` | §6.1 每帧 <0.001ms,工位/河狸是秒级状态机 |
| `tickPartyMode(m)` | **慢帧 2Hz** | 内部用 `clock` 算 elapsed,`dt` 根本不参与 |
| `tickAfk(p, nowSec, dt)` | **快帧 20Hz** | 露水是小数累加器(`dewAcc`),见下 3c |
| `createScoreboard()` | 建一次,不 tick | 纯数据,`scoring.ts` **无任何 tick 导出**(实测) |

★ **`tickPartyMode(m)` 的签名没有 `dt`** —— 它靠 `m.clock.now()` 与 `startedAtSec` 算 elapsed。
⇒ 它的正确性**只依赖时钟**,与驱动频次**无关**。这一点让它可以安全地放慢帧。

---

### 3b `TeamKey` 建在哪?归谁?

★★ **本任务卡的前提是错的,必须先纠正。**

```
卡上原文:「`TeamKey` 概念**全仓 server/src 0 个文件含它** ⇒ 建在哪?归谁?」
```

实测(口径:`\bTeamKey\b` 裸词,全仓 `*.ts`):

```
server/src/party/scoring.ts:38   export type TeamKey = (typeof TEAM_KEY)[keyof typeof TEAM_KEY];   ← 定义
server/src/party/modes.ts:58     type TeamKey,                                                     ← 导入
```

`scoring.ts:32-40`:

```
export const TEAM_KEY = { RED: 'RED', BLUE: 'BLUE', YELLOW: 'YELLOW', GREEN: 'GREEN' } as const;
export type TeamKey = (typeof TEAM_KEY)[keyof typeof TEAM_KEY];
export const TEAM_ORDER: readonly TeamKey[] = ['RED', 'BLUE', 'YELLOW', 'GREEN'];
```

⇒ **`TeamKey` 早就存在,且已在 `scoring.ts`(正确归属:计分域)。不需要新建,不需要搬家。**

**真正缺的是另一件东西**:把「玩家」映射到「队」的**生产者**。实测全部为 0:

```
assignTeam       -> 0 files
playerTeam       -> 0 files
teamOf           -> 0 files
teamOfPlayer     -> 0 files
setTeam          -> 0 files
```

现有签名都**要求调用方自己给 `team`**(即调用方必须已经知道谁在哪个队):

```
modes.ts:241   bridgePlace(r, team: TeamKey, isTrap = false)
modes.ts:252   bridgeCapture(r, team: TeamKey)
modes.ts:479   crownAssignTeam(r, playerId: string, team: TeamKey)   ← ★ 唯一带 playerId 的,但它也是「赋」不是「查」
scoring.ts:278 paint(g, x, y, team: TeamKey)
scoring.ts:298 tileCount(g, team: TeamKey)
```

而 `crownAssignTeam(r, playerId, team)` 的语义是**写入**指派,**它就是那个生产者的入口**,只是**没有调用方**(生产 0 处)。

**⇒ 回答**:
- `TeamKey` **不建**,它在 `party/scoring.ts`,归属**计分域**(现状正确)。
- 缺的是「**开局分队**」这一步:一局开始时把 `players[]` 划分成 2~4 队。它属于**对局层**(缺口 A 的「容器」/「一局玩法」),不属于计分域,也不属于 WS-11。
- ⇒ **它是 `createPartyMode` 的调用方的责任**,而 `createPartyMode` 生产调用 **0 处**。所以这事的正确落点是「谁调 `createPartyMode`」,那个宿主**同时**拥有分队 —— 而不是在 `party/` 里新建一个 `TeamKey` 概念。
- ★ 若强行在 `party/` 里加 `assignTeam`,会**违反 §8 L745 的 scope 边界**(对局层不该住在模式实现里)。

★ 这条与陷阱 96(「需要新增 X」= 未验证的存在性断言)同族:**卡把「缺生产者」误写成「缺类型」**,两者修法完全不同(前者要开对局层,后者只是加个 type — 后者 5 分钟,前者是一个专项)。

---

### 3c 逐参数列出上游要提供什么

#### `tickRushOrder(s: RushOrderSession, dt: number, opts: RushTickOptions = {})`

`RushTickOptions`(`rush_order.ts:914`):

| 参数 | 上游必须提供什么 | 生产侧现有来源 |
| :--- | :--- | :--- |
| `dt` | 本帧实际时长(秒)。慢帧 = `SIM_SLOW_DT = 1/SLOW_TICK_HZ` | `world_sim.ts:240` 有常量,但**没有 per-frame 传入** |
| `opts.tended` | 本帧被「翻炒」的工位种类列表 | **无**。需上游知道「谁在哪个工位操作」⇒ 属执行层 |
| `opts.spraying` | 本帧被水枪喷射的工位种类列表 | **无**,同上 |
| `opts.spawnBeaver` | 布尔,是否允许刷河狸。省略视为允许 | 可不传(默认 true) |

`RushOrderSession` 的**创建**还需(`RushOrderSessionOptions`, `:849`):

| 字段 | 上游必须提供什么 | 生产侧现有来源 |
| :--- | :--- | :--- |
| `clock: Clock` | 时钟接口 | ★ 见下「Clock 双份」 |
| `roomLevel: number` | 房间等级(决定订单槽数/need 范围) | **无**。生产 0 处生产 `roomLevel`(`roomLevel` 仅存在于 `rush_order.ts` 内部) |
| `rng: Rng` | 注入随机流 | `world_sim` 有 `rng`/`combatRng`,但**未暴露**给 party |
| `seed?: number` | 可选 | — |
| `stock?: Record<number, number>` | 物品库存表 | **无**。`room.ts` 有 `inventoryTotals`,但是「总量」不是 `Record<itemId, qty>`(见 W5) |
| `durationSec?: number` | 可选 | — |

⚠️ `opts.tended` / `opts.spraying` / `roomLevel` / `stock` **四项在生产侧全部无来源**。
⇒ ★ **这是本任务真正的成本所在**:驱动器写起来是 20 行,但**喂它 4 个参数**需要先接通
   「玩家在哪个工位」「房间等级」「库存明细」三条数据流 —— 而这三条**都属于 ARCH-GAPS 说的第 1/2 层**。

#### `tickPartyMode(m: PartyModeRuntime): string[]`

| 参数 | 上游必须提供什么 | 生产侧现有来源 |
| :--- | :--- | :--- |
| `m` | 一个 `PartyModeRuntime` | **无**。`createPartyMode` 生产调用 **0 处**(`modes.ts` 自己 + 测试) |

`createPartyMode(opts)`(`:136`)需要:`key: PartyModeKey` / `clock: Clock` / `refereeId: string` / `seed?: number`。
`refereeId` 是「436 哨台归属者」—— 需上游知道**哪个玩家是裁判**。生产侧**无来源**。

★ 但 `tickPartyMode` 内部**只读 `m.clock`**,不读任何玩家数据(实测 `:181-195`:只有 `modeElapsedSec(m)` 与 `m.phase`)。
⇒ **纯计时推进,上游只需给一个 clock**。这是四者里**最容易接**的。

#### `createScoreboard(): Map<TeamKey, TeamScore>`

**零参数。** 且实测 `party/scoring.ts` **无任何 tick 导出**(只有 `create*` / `push*` / `drain*` / `paint*` / `getTeam` / `scoreLine` / `crownLine` / `tileCount`)。
⇒ **它不需要驱动器**,只需要一个持有者(`createPartyMode` 内部已经建了 `board: Map<TeamKey, TeamScore>`,见 `PartyModeRuntime:108`)。
⇒ ★ **「`scoring.ts` 需要接线」这个说法是错的**:它是纯数据模块,可达性只取决于**有没有人 import 它**(现状:`modes` + `afk` 都 import,但都不可达)。

#### `tickAfk(p: AfkPlayer, nowSec: number, dt: number)`

| 参数 | 上游必须提供什么 | 生产侧现有来源 |
| :--- | :--- | :--- |
| `p: AfkPlayer` | 每个玩家一个 | **无**。`createAfkPlayer` 生产调用 **0 处**(`afk.ts` 自己 + 测试) |
| `nowSec` | 逻辑秒(不是毫秒) | `world_sim` 有 `frameCount * dt`,但**未暴露** |
| `dt` | **每帧实际时长** | 同上 |

`AfkPlayer`(`afk.ts:52`)的关键字段与上游依赖:

| 字段 | 上游必须提供什么 | 生产侧现有来源 |
| :--- | :--- | :--- |
| `backgroundedAtSec: number \| null` | 玩家**何时进入后台**(切标签页/失焦) | **无**。`room.ts` 有 `setPlayerAfk?(playerId, afk)`(`:488`),但门禁实测 `tickAfk` 在 room = 0;且客户端**无** `visibilitychange`(见 §4 FND:381) |
| `nearFire` | 是否在篝火 4 格内 | **无** |
| `onTatami` / `onBed` | 是否在 304 榻榻米 / 517 床上 | **无** |
| `dewAcc` / `dew` | 露水小数累加器 + 总量 | 由 `tickAfk` 自己算 |
| `state: DozeState` | 打盹状态机 | 由 `tickAfk` 自己推进 |

★ **`dewAcc` 决定了 `tickAfk` 必须高频**:露水按 `dt` 累加到小数器,若放慢帧且 `dt` 折算错,
   就会重演 `world_sim.ts:3551-3557` 记的 DoT 事故(总量差一个数量级,而「有没有长」看不出来)。
⇒ **`tickAfk` 放快帧 20Hz,`nowSec` 用 `frameCount * SIM_FAST_DT`。**

#### ★ 一个必须点出的既有欠账:`Clock` 有两份同名接口(ARCH-GAPS 的 W7)

```
coop/rush_order.ts   自己声明 Clock
net/anticheat.ts     自己声明 Clock
party/modes.ts:21    import type { Clock, Rng } from '../coop/rush_order.ts';   ← 借 coop 的
```

⇒ `party/` 的时钟类型**依赖 `coop/`**。所以接线次序上 **`coop` 必须先于 `party`**(见 3d)。
这也是为什么 `party` 不能脱离 `coop` 单独可达:它不是「差集条目」而是**结构依赖**。

---

### 3d 次序:先驱动哪个?会不会互相依赖?

#### 内部依赖(实测,按 import 边)

```
modes  →  rush_order          (modes.ts:21 import Clock, Rng 来自 rush_order)
modes  →  scoring             (modes.ts:51-60)
scoring →  rush_order         (类型)
afk    →  rush_order , scoring
```

⇒ 拓扑序:**`rush_order` → `scoring` → `modes` → `afk`**
(`afk` 最后,因为它同时依赖 rush_order 与 scoring;`scoring` 无 tick,先建对象)

#### ★ 关键实测:`tickRushOrder` 已经内部驱动工位与河狸

```
rush_order.ts:931   out.push(...tickStation(st, dt, tended, spraying));   ← 在 tickRushOrder 内
rush_order.ts:947   for (const b of s.beavers) out.push(...tickBeaver(b, dt, s.stock));   ← 在 tickRushOrder 内
```

⇒ **驱动器不需要逐个调 `tickStation` / `tickBeaver`**。这是一个**减少 8 处改动到 4 处**的实测事实,
   也纠正了「tickStation 也要接」的直觉判断。**只需调 4 个顶层入口:**

```
1  createRushOrderSession(...)  → tickRushOrder(s, dt, opts)      ← 含工位/河狸/接力链
2  createScoreboard()           → (无 tick)
3  createPartyMode(...)         → tickPartyMode(m)               ← 需 modes 已可达
4  createAfkPlayer × N          → tickAfk(p, nowSec, dt)         ← 快帧
```

#### ★★ 与「动作执行层」的关系:**互相独立**(这是我实测出来的,不是推断)

`ARCH-GAPS.md` 说三层必须一起。我实测了其中**第二层与「每帧驱动」是否耦合**,答案:**不耦合**:

```
全仓 applyAction / dispatchAction / handleAction / runAction / applyPartyAction  → 各 0 个文件
room.colyseus.ts 的 'action' handler → 只有 authorize + reject,成功分支为空
RoomRuntime 的公开方法里没有 placeBlock / pickup / craft / startParty 之类
```

⇒ 每帧驱动**不经过** `RoomAction`,它读的是「世界/房间已有的态」。
⇒ **可以**只做每帧驱动而不做动作分发器。

**但代价必须写清**:做完之后
- `tickPartyMode` 会推进阶段、会播报 `'PHASE:RACE'` —— 玩家**看得见**;
- 玩家**仍然无法**交单(`submitDelivery`)、夺旗(`bridgeCapture`)、拾冠(`crownPickup`)——
  实测这三个函数的**生产非自身调用点 = 0**。

⇒ ★ **接线后若宣称「WS-11 可用」,那是过度声称。准确说法是「WS-11 的计时/状态机能自己跑了,但玩家还操作不了」。**

#### 与「容器层」的关系:也不耦合,但**分队数据**卡在它上面

「每帧驱动」不需要 `room` 认识 `sim`(驱动器在 `sim` 里,向下调 `party`,符合 §8 方向)。
但 `RushOrderSessionOptions.roomLevel` 与 `stock` 需要**房间级数据**,而 `room` 与 `sim` 之间
`level`/`hp`/`x,y,z`/武器 **8 个字段零同步通道**(ARCH-GAPS 第五层 W6)。
⇒ **可以先接 `tickPartyMode`(只需 clock),`tickRushOrder` 会因缺 `roomLevel` 而只能跑默认值。**

★ 我的建议次序(按「能先验证到什么」):

```
第 0 步(必须,Lead 授权):world_sim.ts 加 tickPartyStep() + 慢帧调用
第 1 步 只接 tickPartyMode —— 它是纯时钟推进,依赖最少,能证明「那条线通了」
第 2 步 接 tickAfk(快帧)—— 需 nowSec/dt,可用 frameCount 派生,不需新数据源
第 3 步 接 tickRushOrder —— ★ 这一步会撞上 roomLevel/stock/tended/spraying 四个无来源参数
第 4 步 scoring —— 无需接线,随 modes 自动可达
```

---

## 4. 13 条否定断言的逐条改法

### 4.0 先纠正三个数字(卡上的口径不对)

```
卡上原文:「`tests/WS-11.test.ts` 有 **9 条**,`tests/WS-FND-11-afk.test.ts` 另有 **2 条** ⇒ 共 **13 条**」
```

实测(口径:`ok(!...)` 且正则读到生产源文本的**断言站点**):

| 文件 | 站点数 | 循环展开后的运行时断言数 |
| :--- | ---: | ---: |
| `tests/WS-11.test.ts` | **13** | 22(= 12 + `:1607` 的循环 4 个...) |
| `tests/WS-FND-11-afk.test.ts` | **4** | 5 |
| 合计 | **17** | 26 |

⇒ 卡上的「9 + 2」**两个数都对不上**。而「13」这个数**碰巧**等于 `WS-11.test.ts` 的**站点数**
—— 与卡上的「13 = 9+2」是**两个不同口径的同值**。这正是「报 0 处必须连口径」的形态:
**数字对上了,但它代表的不是卡以为的那件事。**

### 4.1 ★ 关键:变红的条数**取决于驱动器放在哪**

这是卡上最大的一个未言明前提。**若驱动器放进 `world_sim.ts`(唯一合规的接点,见 3a)**:

- `room.ts` **完全不被改动** ⇒ 所有 `!room.includes(...)` 断言**保持绿**;
- `world_sim.ts` 新增符号 ⇒ `!wildSim.includes(...)` 断言**变红**;
- 若 `world_sim` import `social/afk.ts` ⇒ `FND:307` **变红**。

逐条判定(共 17 站点):

| # | 位置 | 断言(现) | `world_sim` 型驱动器会红? | 归属 |
| --: | :--- | :--- | :-: | :--- |
| 1 | `WS-11:1607-1608` | 循环 4 符号 `!room.includes` | **✗ 不红**(room 不改) | A,但接点在 room |
| 2 | `WS-11:1626` | `!wildSim.includes('partyMode')` | ⚠️ **取决于命名**,不是必然(见 §4.1a) | **A** |
| 3 | `WS-11:1629` | `!wildSim.includes('tickAfk')` | ★ **红** | **A** |
| 4 | `WS-11:1630` | `!room.includes('tickAfk')` | ✗ 不红 | A,但接点在 room |
| 5 | `WS-11:1633` | `!wildSim.includes('resolveShield')` | ✗ 不红 | **B(缺口 B)** |
| 6 | `WS-11:1634` | `!room.includes('resolveShield')` | ✗ 不红 | **B** |
| 7 | `WS-11:1637` | `!/(interface WorldPlayer…pets?)/` | ✗ 不红 | 驯养(WS-04) |
| 8 | `WS-11:1639` | `!wildSim.includes('PetRecord') && !…('feedPet')` | ✗ 不红 | 驯养(WS-04) |
| 9 | `WS-11:1666` | `!checkLine.includes('BRIDGE_FLAG')` | ✗ 不红 | 词表清理 |
| 10 | `WS-11:1667` | `!checkLine.includes('CROWN_RUN')` | ✗ 不红 | 词表清理 |
| 11 | `WS-11:1676` | `!repoVals.includes(...)` | ✗ 不红 | 词表清理 |
| 12 | `WS-11:1687` | `!/露水\|dew/i.test(room)` | ✗ 不红 | A(同名异义),room 不改 |
| 13 | `WS-11:1693` | `!afkSrc.includes('AFK_TIMEOUT_MS')` | ✗ 不红 | A(两套时间线),afk 不改 |
| 14 | `FND:307` | `!/social\/afk\.ts/.test(simSrc)` | ★ **红** | **A** |
| 15 | `FND:308` | `!/social\/afk\.ts/.test(roomSrc)` | ✗ 不红 | A,room 不改 |
| 16 | `FND:381` | 客户端无 `visibilitychange` | ✗ 不红 | A 的前置(client 写域) |
| 17 | `FND:388` | 消息面无 `afk`/`background` | ✗ 不红 | A 的前置(net 写域) |

**⇒ 变红 = 2 条硬红(#3 / #14),加 1 条条件红(#2)。不是 13 条。**

### 4.1a ★ 我自己差点写错的一条:`:1626` 不是必然红

我在上一版报告里把 `:1626` 判成「必然变红」。**那是错的**,原因是**大小写**:

```
断言原文:`ok(!wildSim.includes('partyMode'), ...)`      ← 禁的是小写 p 的 partyMode
而我建议的驱动代码:`tickPartyMode(this.partyRuntime)`   ← 是 `tickPartyMode`,大写 P

实测:'tickPartyMode'.includes('partyMode')  = **false**
⇒ 只调 tickPartyMode 的驱动器,**不会**让 :1626 变红。
```

实测六种「看起来都算接线」的写法,只有两种命中:

| 驱动器里的写法 | `includes('partyMode')` | 结果 |
| :--- | :-: | :--- |
| `import { createPartyMode, tickPartyMode } from …` | false | 仍绿 |
| `const m = tickPartyMode(this.partyRuntime);` | false | 仍绿 |
| `this.partyRuntime = createPartyMode({…});` | false | 仍绿 |
| `import { partyModeConfig } from …` | **true** | **红** |
| `private readonly partyMode: PartyModeRuntime \| null` | **true** | **红** |
| `this.party = { mode, board: createScoreboard() };` | false | 仍绿 |

⇒ ★ **准确的说法是**:`:1626` 变红**当且仅当**驱动器的**持有字段名**叫 `partyMode`(或 import 了
`partyModeConfig` 这类含该子串的符号)。**接线本身不决定它红不红,命名决定。**

这正好是「判据的锚与要判的事无关 = 同族缺陷」的一个实例:`:1626` 的**理由是**
「计分字段无人驱动」,它的**判据**却是「文本里有 partyMode 这个子串」。
两者只在「持有者恰好叫这个名字」时才对得上。

⇒ 所以 §4.2 对 `:1626` 的改法**不能**写成「接线后它必然红」。正确的改法是:
**先按「驱动点唯一 + 行为可见」重写它,让它的判据与它要判的事对齐**;
重写之后,它的红绿**取决于行为**,不再取决于命名。这也正是原断言该被换掉的最强理由。

★ 顺带一个反向证据:`room.ts` **今天就含** `partyMode`(它是选择器)与 `PartyMode`(枚举),
  所以 `:1626` 若改成对 `room` 求值会**立刻红** —— 说明这条判据对「哪个文件」也敏感。
  原断言选了 `world_sim` 而不是 `room`,是为了避开这个已知冲突;换人重写时**必须保留这个选择**。

### 4.1b ★ 另一条我核过的:`FND:307` 的红是**真红**,不是巧合

```
world_sim.ts:503   ⚠️ **不要**与 `social/afk.ts` 的那套「打盹攒露水」玩法合并
```

这行**含** `social/afk.ts` 字样。但我实测它在**块注释内**(`/*` 在 offset 647,`*/` 在 590 ⇒ 在注释里),
而 `tests/WS-FND-11-afk.test.ts` 的 `readCode()` **会去注释**(`:80` 有 `.replace(/\/\*[\s\S]*?\*\//g, ' ')`):

```
FND:307  world_sim.ts  banned='social/afk.ts'
    raw includes = true   | stripped includes = false   ← 现状:去注释后为 false,断言绿
```

⇒ **现状绿是对的**;一旦 `world_sim` 真的 `import ... from '../social/afk.ts'`(代码,非注释),
   去注释后仍为 true ⇒ **红**。这条是**真红**,判据与要判的事对齐(「有没有 import」)。

★ 这也说明两个套件的**口径不同**:`WS-11.test.ts` 用 `readFileSync`(**不去注释**),
  `tests/WS-FND-11-afk.test.ts` 用 `readCode`(**去注释**)。改断言时**不能混用**这两种判据 ——
  否则会把一条注释误判成 import(陷阱 110 同族)。

★ 这不是「卡错了所以不用改」——**这 17 条全部都要审**,只是**改哪几条**取决于接点。
   而卡要求「13 条同批改」若照做,会**主动改坏 10 条与本次改动无关的断言**。

### 4.2 逐条改法(原 → 新,并说明新断言如何**仍能证伪**)

改法原则(来自卡的 ★ 与 Lead 上一轮的裁定):
- 否定断言的作用是「**钉住一个当时的缺陷态**」;接上后该事实**消失了**,但**不能**让它变成无人看管;
- 新形式必须**同时**钉住两件事:(i) 调用点存在,(ii) **行为真的变了** —— 后者才是真守卫;
- 只保留 (i) 的断言是「可达性的弱化版」,门禁已经覆盖了,不是新守卫。

#### #2 `WS-11:1626` —— 条件红(取决于命名),**但必须改**,因为它的判据与它要判的事不对齐

```ts
/* 原 */
ok(!wildSim.includes('partyMode'), 'world_sim 不含 partyMode ⇒ 计分字段无人驱动');
```

**为什么必须改,而不是「反正不红就别动」**:这条的**理由**说的是「计分字段无人驱动」,
而它的**判据**是「文本里有小写子串 `partyMode`」。两者只在「持有字段恰好叫这个名字」时才对得上
(§4.1a 实测)。⇒ **它是一条判据与结论错位的断言**,现在不改,将来换个人重写驱动器就会
莫名其妙地红或绿。这正是「同族缺陷」,和 WS-08 那条套件号错在理由文本里是同一类。

```ts
/* 新:两段式。(i) 驱动点唯一;(ii) ★ 行为 —— 后者才是真守卫 */
{
  const hits = ['server/src/sim/world_sim.ts', 'server/src/net/room.ts']
    .filter((p) => readFileSync(join(ROOT, p), 'utf8').includes('tickPartyMode'));
  eq(hits.length, 1, `tickPartyMode 驱动点恰好 1 处(实测:${hits.join(', ')})`);
}
/* ★ 真守卫:跑一帧,partyTimer 必须前进 —— 不依赖任何命名 */
{
  const sim = new WorldSim({ sizeCells: 8, rng: () => 0.5, combatRng: () => 0.5 });
  sim.partyStart('CROWN_BR', 'p1');              /* 或等效的注入接口 */
  const t0 = sim.partySnapshot().timer;
  for (let i = 0; i < 40; i += 1) sim.tick();    /* 40 帧 = 2 秒逻辑 */
  const t1 = sim.partySnapshot().timer;
  ok(t1 > t0, `partyTimer 由 ${t0} 前进到 ${t1} ⇒ 计分字段真的被驱动`);
}
```

**如何仍能证伪**:(a) 把 `tickPartyStep()` 的调用注掉 ⇒ `t1 === t0` ⇒ **红**(**与命名无关**);
(b) 驱动点加两处 ⇒ 第一条红。

★ 注意新写法**刻意不再测字符串**:这正是修掉「判据的锚与要判的事无关」。
  而我上一轮 task-81 的教训在这里正好用上:**只有 `includes` 那一行是不能证伪的** ——
  把函数定义在 `world_sim` 里但从不调用,`includes` 照样绿。**必须靠 `t1 > t0`。**

#### #3 `WS-11:1629` —— 红,必须改

```ts
/* 原 */
ok(!wildSim.includes('tickAfk'), 'world_sim 不调 tickAfk');
```
```ts
/* 新 */
includes(wildSim, 'tickAfk', 'world_sim 驱动挂机露水');
/* ★ 真守卫:露水必须真的长 —— 用 dewAcc 的小数语义做双向判据 */
const p = createAfkPlayer('p1');
p.backgroundedAtSec = 0;
p.nearFire = true;
const d0 = tickAfk(p, 0, SIM_FAST_DT);
for (let i = 1; i <= 1200; i += 1) tickAfk(p, i * SIM_FAST_DT, SIM_FAST_DT);
ok(p.dew > d0, `露水由 ${d0} 长到 ${p.dew}(20 秒 × 20Hz)⇒ 累加器与帧率无关`);
/* ★ 反向:不 nearFire 时必须不长 —— 否则「大于号」恒真 */
const q = createAfkPlayer('p2');
q.backgroundedAtSec = 0;
const q0 = q.dew;
for (let i = 0; i < 1200; i += 1) tickAfk(q, i * SIM_FAST_DT, SIM_FAST_DT);
eq(q.dew, q0, '不在篝火旁 ⇒ 露水不增长');
```

**如何仍能证伪**:(a) 删驱动调用 ⇒ 第一条红;(b) 若 `tickAfk` 改成无条件加露水 ⇒ **第二条红**。
⇒ 一正一反,**不是恒真**(这正好避开「判据值域覆盖整个输入空间」那一类陷阱)。

#### #4 `WS-11:1630` —— 不红(room 不改),但**要改理由**

```ts
/* 原 */
ok(!room.includes('tickAfk'), 'room.ts 也不调 tickAfk');
```
```ts
/* 新:钉住「驱动层唯一」这条结构事实,而不是「谁没有」 */
const drivers = [
  ['server/src/sim/world_sim.ts', wildSim],
  ['server/src/net/room.ts', room],
].filter(([, src]) => (src as string).includes('tickAfk')).map(([p]) => p as string);
eq(drivers.length, 1,
  `tickAfk 的驱动点必须恰好 1 处(实测:${drivers.join(', ')})`
  + ` —— 两处会让露水按两倍速增长,且不报错`);
```

**如何仍能证伪**:在 `room.ts` 里也调 `tickAfk` ⇒ `drivers.length === 2` ⇒ **红**。
★ 这比原来的 `!room.includes` **更强**:原断言只禁 room 一处,新断言禁**任何第二处**。

#### #1 `WS-11:1607-1608` —— 不红(room 不改),但**这是最需要改的一条**

```ts
/* 原 */
for (const absent of ['tickPartyMode', 'RoomMode', 'MatchState', 'createPartyMode']) {
  ok(!room.includes(absent), …);
}
```
```ts
/* 新:拆成两个方向,因为四个符号的归属不同 */
/* (a) 对局运行时的驱动点必须唯一(与 #4 同一纪律) */
{
  const hits = ['server/src/sim/world_sim.ts', 'server/src/net/room.ts']
    .filter((p) => readFileSync(join(ROOT, p), 'utf8').includes('tickPartyMode'));
  eq(hits.length, 1, `tickPartyMode 驱动点恰好 1 处(${hits.join(', ')})`);
}
/* (b) room 仍不得认识对局层 —— 这条事实没消失,继续钉 */
for (const absent of ['RoomMode', 'MatchState']) {
  ok(!room.includes(absent), `room.ts 仍不得引入对局层类型 ${absent}(§8 禁用耦合)`);
}
/* (c) createPartyMode 的生产调用点必须存在(接线的证据) */
{
  const callers = walkProd().filter((f) =>
    f !== 'server/src/party/modes.ts' && new RegExp('\\bcreatePartyMode\\s*\\(').test(read(f)));
  ok(callers.length >= 1, `createPartyMode 有生产调用点:${callers.join(', ')}`);
}
```

**如何仍能证伪**:(a) 双驱动 ⇒ 红;(b) 把 `RoomMode` 类型搬进 room ⇒ 红;
(c) 摘掉调用 ⇒ 红。**三条各自独立可红**。

#### #5 / #6 `WS-11:1633 / :1634` —— 不红,**属缺口 B,本次不动**

```ts
/* 原样保留 */
ok(!wildSim.includes('resolveShield'), 'world_sim 不调 resolveShield');
ok(!room.includes('resolveShield'), 'room.ts 也不调 resolveShield');
```

**理由**:缺口 B 是 `prank/immunity.ts` + `prank/toys.ts`,本卡明确「不碰 `server/src/prank/**`」。
**这两条应随缺口 B 那张卡一起改**,不在本卡同批。

★ 但**要加一行注释**指向那张卡,否则将来做缺口 B 的人会以为这两条是「无主断言」而删掉:

```ts
/* ★ 本两条随「缺口 B(实体效果施加通道)」那张卡改,不随缺口 A */
```

#### #7 / #8 `WS-11:1637 / :1639` —— 不红,**属驯养(WS-04),与 WS-11 无关**

原样保留。这两条钉的是「`WorldPlayer` 不带宠物字段」,接 WS-11 不会改变它。
★ 但它们**混在 WS-11 的「宿主缺失」组里**,归属是错的 —— 建议(不属本卡写域)移到 WS-04 套件。
**本卡只加注释标注归属,不移动**(移动会改断言数,影响 Lead 的统计)。

#### #9 / #10 / #11 `WS-11:1666 / :1667 / :1676` —— 不红,**词表清理,已完成的守卫**

原样保留。这三条钉「DDL 与 repo 不再残留旧词 `BRIDGE_FLAG` / `CROWN_RUN`」——
这是**已修好**的缺陷守卫,和接线无关。**保留是对的**,它们现在正是「守着一个已修复态」的正面例子。

#### #12 `WS-11:1687` —— 不红(room 不改),但**改为更准的形式**

```ts
/* 原 */
ok(!/露水|dew/i.test(room), '但 room.ts 不含露水/dew ⇒ 与 afk.ts 不是同一件事');
```
```ts
/* 新:钉住「两个 AFK 是不同的东西」这个语义,而不是「room 没有这个词」 */
{
  /* room 的 AFK 是连接态(掉线回收),afk.ts 的 AFK 是挂机攒露水 —— 同名异义 */
  includes(room, 'setPlayerAfk', 'room 的 AFK 是连接态:setPlayerAfk 由 room 推给宿主');
  {
    const afkSrc2 = readFileSync(join(ROOT, 'server/src/social/afk.ts'), 'utf8');
    ok(!afkSrc2.includes('setPlayerAfk'),
      'afk.ts 不消费 room 的 setPlayerAfk ⇒ 两套 AFK 无调用关系(同名异义)');
  }
}
```

**如何仍能证伪**:若有人把 room 的 `setPlayerAfk` 直接接到 `tickAfk` 上(把两套合成一套)⇒ 第二条红。
★ 新形式**不禁止** `world_sim` 出现 `dew`(那是接线后的必然结果),只禁止**混用两个概念** —— 这正是原断言想表达的事。

#### #13 `WS-11:1693` —— 不红,但**这句话本身要复核**

```ts
/* 原 */
ok(!afkSrc.includes('AFK_TIMEOUT_MS'), …);
```

实测 `afk.ts` 是「挂机攒露水」,`AFK_TIMEOUT_MS` 属 `room.ts` 的掉线超时。
接线**不会**让 `afk.ts` 引用它。⇒ **保留原样即可**,它是「两套时间线独立」的有效守卫。

★ 但我提醒:这一条**没有一条断言证明「露水的时间尺度与掉线超时无关」** ——
它只证明了「没引用同一个常量」。若两者将来用**不同名字的相同数值**,这条照样绿。
⇒ 建议补一条数值断言(不属本卡必须项):
```ts
ok(!(DEW_INTERVAL_SEC * 1000 === AFK_TIMEOUT_MS), '两套时间尺度的数值也不得巧合相等');
```

#### #14 `FND:307` —— 必然红(真红),必须改

★ 先说清**口径**:这个套件用 `readCode()`(去注释),而 `WS-11.test.ts` 用 `readFileSync`(不去注释)。
   两者**不可混用**(§4.1b 实测)。

```ts
/* 原 */
ok(!/social\/afk\.ts/.test(simSrc), 'world_sim.ts 不应 import social/afk.ts(代码,不含注释)');
```
```ts
/* 新:由「不许 import」转为「import 了,且驱动点唯一,且行为可见」 */
ok(/social\/afk\.ts/.test(simSrc), 'world_sim.ts 现在 import social/afk.ts(缺口 A 已接)');
/* ★ 真守卫:驱动点唯一 + 露水随帧增长(两条合起来才算接对) */
{
  const srcs = { 'sim/world_sim.ts': simSrc, 'net/room.ts': roomSrc };
  const drivers2 = Object.entries(srcs).filter(([, s]) => s.includes('tickAfk')).map(([p]) => p);
  eq(drivers2.length, 1, `tickAfk 驱动点唯一:${drivers2.join(', ')}`);
}
```

**如何仍能证伪**:把 import 摘掉 ⇒ 第一条红;把驱动加两处 ⇒ 第二条红。
★ 注意第一条**必须用 `simSrc`(去注释版)**:若误用 `readFileSync`,会因为
  `world_sim.ts:503` 那句注释里就写着 `social/afk.ts` 而**恒真**(那条注释现在就在!实测 raw=true / stripped=false)。

#### #15 `FND:308` —— 不红(room 不改),**保留但要改措辞**

```ts
/* 原 */
ok(!/social\/afk\.ts/.test(roomSrc), 'room.ts 不应 import social/afk.ts(代码,不含注释)');
```
```ts
/* 新:这条事实没变(room 仍不 import),但理由要写准 */
ok(!/social\/afk\.ts/.test(roomSrc),
  'room.ts 仍不 import social/afk.ts —— 驱动在 sim 层(§8 禁用耦合:party 不依赖 net,'
  + '方向必须 net/sim → party;若此处需要 import,说明方向反了)');
```

**理由为何要改**:原措辞「不应 import」会被读成「还没做」;
接线后它变成「**不许** import」—— 是同一条断言,但**语义从欠账变成了架构约束**。
★ 这正是 Lead 上一轮踩过的坑:**只改理由文字也会改变判定的含义**。这里我明确只改字符串,不改判定式 ⇒ 不影响任何门禁数字。

#### #16 `FND:381` / #17 `FND:388` —— 不红,**属 A 的前置,但写域在 client/ 与 net/**

```ts
/* 原样保留 */
ok(!/visibilitychange|document\.hidden/.test(clientCodes), …);
ok(!channels.includes('afk') && !channels.includes('background'), …);
```

**理由**:这两条钉的是「客户端没有失焦上报、消息面没有 afk 通道」。
它们是 `tickAfk` 的 `backgroundedAtSec` **数据源**的前置。
⇒ **接好每帧驱动之后,这两条依然是绿的,而 `tickAfk` 的 `backgroundedAtSec` 依然是死字段。**
⇒ ★ **必须在这两条旁边加注释**,否则会形成「WS-11 已接线(绿)+ 客户端无上报(绿)= 看起来完成」的假象:

```ts
/* ★ 缺口 A 只接了「每帧驱动」;backgroundedAtSec 的生产者在上游(客户端上报 + net 通道),
      两者仍缺席 ⇒ 挂机检测目前只能靠「后台标记永为 null」,露水按前台速率增长。
      这不影响本组断言的结论,但「接线 = 功能可用」的推断在此不成立。 */
```

### 4.3 改法汇总

| 分类 | 条数 | 站点 | 处理 |
| :--- | ---: | :--- | :--- |
| **必然红(必须改)** | **2** | #3 `:1629` / #14 `FND:307` | 改成正向 + **加真行为断言** |
| **条件红(也必须改,理由见 §4.1a)** | **1** | #2 `:1626` | 判据与结论错位,改为「驱动点唯一 + 行为可见」 |
| 应改(不红,但理由/强度要变) | 3 | #1 `:1607` / #4 `:1630` / #12 `:1687` | 改为「驱动点唯一」+ 语义钉 |
| 只加注释(归属/前置说明) | 6 | #5 #6(→缺口B)/ #7 #8(→WS-04)/ #16 #17(→上游) | 判定式不动 |
| 原样保留(有效守卫) | 5 | #9 #10 #11 #13 #15 | 不动 |

★ **不是「改 3 条其余删掉」,也不是卡说的「13 条全改」** —— 17 条**逐条给了处置**,其中
3 条必须改、3 条应改、6 条加注释、5 条保留。这一节满足卡的「逐条」要求,同时纠正了「13」的口径。

★ 并且我核出卡漏掉的一层:**变红的条数取决于「驱动器放哪 + 持有字段叫什么」**,
不取决于「接没接」。所以「13 条同批改」这个要求若照字面执行,会主动改坏 10 条与本次改动无关的断言。

---

## 5. 若已实现:能红的证据

**未实现。** 原因见 §6(接点全在写域外,且 2 个是承重文件)。

我**没有**做「先改测试再改代码」—— 因为那会留下一个中间态:断言已放宽、代码未接,
等于**把守卫拆掉而补不上覆盖**(陷阱 84:避开检测器 ≠ 补上覆盖)。

---

## 6. 改动清单(逐文件逐位置)

**本次改动:0 个文件。** 生产代码 0 行、测试 0 行、`scripts/**` 0 行。

唯一新增:`docs/TASK-84-ws11-gap-a-plan.md`(本文件)。

### 若要落地,需 Lead 授权的改动(按依赖排序)

| 序 | 文件 | 位置 | 改动 | 是否承重 | 是否我写域 |
| --: | :--- | :--- | :--- | :-: | :-: |
| 1 | `server/src/sim/world_sim.ts` | 新私有方法(建议紧邻 `tickLogisticsStep`, L3285 附近) | 加 `private tickPartyStep(): void`,持有 `PartyModeRuntime` / `AfkPlayer[]` | **✓ 承重** | **✗** |
| 2 | `server/src/sim/world_sim.ts` | `tick()` L3686 之后、L3689 之前 | 加 `this.tickPartyStep();`(慢帧块内) | **✓ 承重** | **✗** |
| 3 | `server/src/sim/world_sim.ts` | L83 附近 import 区 | 加 `import { createPartyMode, tickPartyMode, type PartyModeRuntime } from '../party/modes.ts';` 等 | **✓ 承重** | **✗** |
| 4 | `tests/WS-11.test.ts` | `:1626` / `:1629` | 按 §4.2 改为正向 + 真行为断言 | ✗ | **✓** |
| 5 | `tests/WS-11.test.ts` | `:1607-1608` / `:1630` / `:1687` | 按 §4.2 改为「驱动点唯一」 | ✗ | **✓** |
| 6 | `tests/WS-FND-11-afk.test.ts` | `:307` | 按 §4.2 改为正向 | ✗ | **✓** |

★ 第 1-3 项**全部是 `world_sim.ts`**,而它是「多方共用的承重文件」⇒ 按卡的硬约束我必须**先报 Lead**。
  第 4-6 项在写域内,但**单独改它们等于拆守卫而不接线**(见 §5),所以我不做。

---

## 7. 请 Lead 改的数字(白名单/可达/欠账/桶构成)

★ 这些数**只在第 1-3 项落地后才该改**。我给出**应改什么**与**口径**;具体值由你复算。

| 项 | 现状 | 缺口 A 落地后 | 说明 |
| :--- | ---: | ---: | :--- |
| `PROD_ENTRIES` 闭包大小 | **84** | **88**(+4) | 若驱动器放 `world_sim`。差集条目随根自动可达 |
| `UNREACHABLE_EXEMPT.size`(门禁打印「白名单 N 条」) | **14** | **10**(−4) | 摘除 4 条,精确行号见下 |
| `UNREACHABLE_EXEMPT` 中 WS-11 条目 | **6** | **2**(剩 immunity / toys) | 缺口 B |
| `ORPHAN_KNOWN.size`(`orphan-audit.ts`) | **9** | **7**(−2) | ★ 只减 2,不是 4 —— 见下的口径陷阱 |
| `TAUT_SUSPECT_EXEMPT.size` | **34**(见下注) | **34**(不变) | 其中 WS-11 占 **8** 条,本次不动 |
| 各桶之和自检 | `Σ桶 + nonDebt === 14` | 需重算 | ★ **我没法算**,见下 |

### 7.1 `UNREACHABLE_EXEMPT` 要摘的 4 条(精确行号,逐个全名列出)

```
L1488  ['server/src/coop/rush_order.ts', 'WS-11 抢单协作,等对局层 + 玩家动作输入管线(深于 US2);'
L1489  + '生产引用者 modes/scoring/afk **全部不可达** ⇒ 差集条目'],

L1540  ['server/src/party/modes.ts',
L1541  'WS-11 竞技模式,等对局运行时(有枚举与计分字段,无运行时);'
L1542  + '注意 data-conformance.ts 只 import 它的**常量**(CROWN_WIN_SEC 等)与手册比对,'
L1543  + '不代表 738 行**逻辑**被接线 —— 引用 ≠ 执行'],

L1545  ['server/src/party/scoring.ts', 'WS-11 计分,待接入;生产引用者 modes/afk **全部不可达** ⇒ 差集条目'],

L1552  ['server/src/social/afk.ts', 'WS-11 挂机攒露水,等房间每帧驱动(与 room 的 AFK 同名异义)'],
```

**保留**:`L1546` immunity、`L1550` toys(缺口 B)。

⚠️ `L1553-1554` 有一段**夹在条目之间的注释**:

```
L1553  /* `wiring/logistics.ts` 已于 2026-11-12 接线(传送带/分拣/机械臂的逐步推进),
L1554  经 `WorldSim` 的慢帧 `tickLogisticsStep` 驱动。已从本表摘除。 */
```

★ **这段注释就是本次接线的模板**,而且它**紧挨着 `afk.ts` 那条**(L1552)。
  摘 L1552 时**不要顺手删掉它** —— 它是「接线成功的先例记录」。摘除时按**全名逐个**处理,不要用区间删。

### 7.2 ★ 口径陷阱:`ORPHAN_KNOWN` 只减 2,不是 4

`orphan-audit.ts` 与 `verify.ts` 的判据**不同**(ARCH-GAPS.md:424-436 已记录):

```
| 模块                    | verify.ts 白名单 | orphan-audit.ts | 差异根因                          |
| coop/rush_order.ts      |       Y          |       n         | 有 3 处仅类型导入 ⇒ 不算孤儿      |
| prank/toys.ts           |       Y          |       n         | 被 immunity.ts 运行时导入         |
| party/modes.ts / social/afk.ts / prank/immunity.ts | Y | Y | 无生产侧导入        |
```

⇒ 缺口 A 的 4 个文件里,`rush_order` 与 `scoring` **本来就不在 `ORPHAN_KNOWN`**。
　 只有 `modes` 与 `afk` 在 ⇒ **`ORPHAN_KNOWN` 9 → 7,减 2 条**。

★ 若照「摘了几条白名单就减几条」去改 `orphan-audit`,会**多减 2 条**,而
   `verify.ts:2540` 的自检 `unreachableCount !== UNREACHABLE_EXEMPT.size + unlisted.length` 会红,
   但**它红的时候看起来像可达性算错了**,不像「我改错表了」。
   ⇒ 这正是「两个白名单各记一半 ≠ 未登记」同族。

### 7.3 桶构成:我算不出,原因是硬的

`verify.ts:2522` 有自检 `if (bucketSum !== UNREACHABLE_EXEMPT.size)` 报错,
且 `:2506` 写明不变量 `Σ(各桶) + nonDebt === UNREACHABLE_EXEMPT.size`。

**而桶的归属是对「理由文本」跑正则得出的**(`WL_NON_DEBT_DIFF_TEXT` 等)。
⇒ 摘除 4 条后 `bucketSum` 与 `nonDebt` **各自都要减**,减多少取决于这 4 条的理由文本落在哪个桶。
　 我**不能**在不改 `scripts/verify.ts` 的前提下复算 —— 而 `scripts/**` 是你的写域。

★ 这正是你上一轮踩过的坑的另一面:**改理由文字会静默改桶归属**。
  所以这里反过来也成立:**摘条目会静默改桶构成**,必须跑一遍门禁看它报的数,不能手算。

### 7.4 ⚠️ 我报数期间发生的**并发漂移**(必须记,否则数字对不上)

我写这份报告的过程中,`scripts/verify.ts` **被另一名队友改动了**(`git diff --stat` = **88 insertions**)。
后果实测:

```
UNREACHABLE_EXEMPT.size   : 14(未变,与本报告一致)
TAUT_SUSPECT_EXEMPT.size  : 我量的时候 33 → 交付前复测 **34**(他人 +1)
WS-11 白名单条目            : 6(未变)
```

⇒ ★ **本报告里所有「白名单 N 条」的说法都带时刻**:以 `UNREACHABLE_EXEMPT` 为准(**14**,稳定);
   `TAUT_SUSPECT_EXEMPT` 已 **34**,若你看到别的数,先看是不是并发写者又动了它。
⇒ 这也是「任何『总数』都必须与独立来源对账」的一个实例:我没法用一次读数锁住一个**正在被改的**文件。
⇒ 我只报告、不改 `scripts/**`(你的写域)。

---

## 8. 我留下的临时文件(逐名,未自删)

`_t84.ts` / `_t84_out.txt`
`_t84b.ts` / `_t84b_out.txt`
`_t84c.ts` / `_t84c_out.txt`
`_t84d.ts` / `_t84d_out.txt`
`_t84e.ts` / `_t84e_out.txt`
`_t84f.ts` / `_t84f_out.txt`
`_t84g.ts` / `_t84g_out.txt`
`_t84h.ts` / `_t84h_out.txt`
`_t84i.ts` / `_t84i_out.txt`
`_t84j.ts` / `_t84j_out.txt`
`_t84k.ts` / `_t84k_out.txt`
`_t84l.ts` / `_t84l_out.txt`
`_t84m.ts` / `_t84m_out.txt`
`_t84n.ts` / `_t84n_out.txt`

共 **28** 个(14 个 `.ts` + 14 个 `_out.txt`)。全部在仓库根,均以 `_` 前缀开头,`walk()` 已排除,
不参与任何可达性口径。**未自删**,等你 `Test-Path` 核过后再处置。

★ 口径提示:我所有探针的 `repo .ts` 分母在 **152 ~ 154** 之间跳动,是因为**并发写者**在增删文件
(实测同一轮内 152 → 153 → 154)。这**不影响**闭包数(84 稳定),但任何「全仓文件数」的说法都要带时刻。

---

## 9. 未做项 + 理由

| 未做 | 理由 |
| :--- | :--- |
| **未实现接线** | 唯一合规接点 `world_sim.ts` 是承重文件且在我写域外。卡明确「若必须改它们 ⇒ 先报 Lead」 |
| 未改 17 条断言 | 单独改 = 拆守卫而不补覆盖(§5)。必须先有接点才能改成「正向 + 真行为」 |
| 未改 `scripts/verify.ts` | 你的写域。我只报告应改什么(§7) |
| 未改 `docs/WS-11-coop-prank-party.md` 的「79 条」 | 文档不在我写域;且它是理由文本过期,不影响门禁 |
| 未动 `prank/**`(缺口 B 的 2 条) | 卡明确不碰 |
| 未复核 `roomLevel` 的正确来源 | 需要「房间等级」的权威归属裁决(ARCH-GAPS 第五层),不是接线问题 |
| 未证明接线后功能可用 | `submitDelivery` / `bridgeCapture` / `crownPickup` 的生产非自身调用点 = **0** ⇒ 执行层仍缺(§3d 末) |

---

## 10. 请 Lead 裁决的三件事

1. **接点授权**:是否允许改 `server/src/sim/world_sim.ts`(加 `tickPartyStep()` + 慢帧调用 + 3 行 import)?
   - 这是唯一符合 §8 禁用耦合与既有先例(`wiring/logistics.ts`)的位置;
   - 若你更愿意自己改这个承重文件,我可以只交付 §4.2 的测试改法,由你接线后我改测试。

2. **范围裁决**:本卡是否**故意**只做「每帧驱动」而不做「动作执行层」?
   - `ARCH-GAPS.md:499-503` 说三层必须一起,否则二次返工;
   - 我实测两者**技术上独立**(§3d),所以**可以**分卡;
   - 但若你的意图是「做完这个 WS-11 就可用」,那**这次接线达不到** —— 请明确口径,我据此写断言措辞。

3. **`ORPHAN_KNOWN` 与桶构成**:§7.2 的「减 2 不是减 4」与 §7.3 的「桶构成必须跑门禁才知道」,
   请确认由你改(我没写域),或授权我改 `scripts/verify.ts` / `scripts/orphan-audit.ts`。