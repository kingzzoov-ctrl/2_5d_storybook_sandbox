# 架构空缺:三层「等架构决策」的代码

> **本文性质**:决策文档。收口本会话散落在 5 份任务报告里的**系统性架构空缺**。
>
> **为什么单独成文**:这批代码不是「欠账」,是「**等一个架构决策**」。
> 散在各任务报告里各报一次,会永远没人做 —— 每份报告都合理地说「它等一个还不存在的容器」,
> 而**没有任何一份能被立项**。
>
> **全部结论均有实测证据**(`file:line` 或命令输出原文)。凡本文出现的行号,以实际代码为准。
>
> 联署:`mob-boss-ai`(task-41)、`net-persist`(task-38)。

---

## 三层空缺

三层是**叠加**的:只解决下层,上层依然堵着。**这是本文最重要的一句话** ——
若专项只做「容器层」,`rush_order.ts` 那类模块**仍然收不到动作**,会二次返工。

```
第三层  入口可跑性      可达 ≠ 可跑          ← 门禁结构上查不到
第二层  动作执行层      授权存在、执行不存在  ← 失败是静默的
第一层  容器层          room 不认识 sim      ← 有书面自述
```

---

### 第一层:容器层 —— `room` 不认识 `sim`

#### 现象

生产有「房间」容器(`server/src/net/room.ts` 的 `RoomRuntime`,**自定义**、零依赖,
不是 colyseus `Room`;colyseus 只是 `room.colyseus.ts` 的薄装配层),
但**「房间」≠「对局」** —— 没有「一局玩法」这一层。

#### 实测证据

**书面自述**(不是推断)—— `server/src/net/room.ts:270-286`:

```
L275:  * `RoomRuntime` 至今**不认识**模拟层(US2「room 持有 sim」仍未开)。
L276:  * 为了落盘而在 `net/room.ts` 里 import 它,会凭空造出一条
L277:  * `net → sim → db` 的编译期依赖,并把它变成 `room.ts` 的硬约束 ——
L278:  * 那是本任务不需要的耦合。
L283:  * ⚠️ 注意:本文件**有意不出现**模拟层的类型名 —— 一旦这里 import 了它,
L284:  * US2 才真的变成过时条目(`scripts/backlog.ts` 的 US2 探针正盯着本文件)。
L285:  * 现在两者依然互不依赖,只是**结构上可组合**。
```

**运行/文本实测**:

| 探针 | 结果 |
| :--- | :--- |
| `world_sim.ts` 含 `partyMode` | **0 处** |
| `world_sim.ts` 含 `rush`(忽略大小写) | **0 处** |
| `room.ts` 含 `tickPartyMode` | **false** |
| `room.ts` 含 `RoomMode` / `matchState` / `roomMode` | **全部 false** |
| 全仓 `server/src` 含 `RoomMode` / `MatchState` / `matchState` / `roomMode` | **各 0 处** |

`server/src/net/room.ts` 去注释后含 `WorldSim|world_sim` → **false**
(这一条是刻意验的:探针若跑在**含注释**的文本上,会匹配到 L275 那句
「**至今不认识**」的自述 —— 那是**说明它还没做**的话,却会被当成「已经做了」。
`scripts/backlog.ts` 的 `stripComments` 注释里记着这个坑,实测确认去注释后判定正确。)

#### 为什么门禁查不到

门禁的**接口**是「可达性」:它问「从生产入口能不能走到这个文件」。
`room.ts` 与 `world_sim.ts` **各自都可达** —— 缺的不是可达性,
是**两者之间那条边**,而「少一条边」在可达性判据里表现为「两个可达模块」,
**与「两个互不相关的可达模块」无法区分**。

#### 影响面

「一局玩法」的概念无处存放。凡需要「开局 / 进行中 / 结算」三段式的模块,
全部无法落地(见下方模块清单)。

---

### 第二层:动作执行层 —— 权限层与执行层之间的**静默落差**

> ⚠️ **措辞必须写准**:报「**权限层与执行层之间的静默落差**」,
> **不是**「WS-07 有缺陷」。后者会被「这是分工」正当反驳(见本节末「职责边界」)。

#### 现象

**「授权」存在,「执行」不存在** —— 而且**失败模式是静默的**。

#### 实测证据

| 事实 | 证据 |
| :--- | :--- |
| `RoomAction` 定义了 **22 个**动作 | `Object.values(RoomAction).length` = **22** |
| 客户端消息面**只有 4 条** | `onMessage` 实测 4 处:`move` / `attack` / `inventory` / `action` |
| **`action` 的成功分支是空的** | `room.colyseus.ts:184-187`,见下 |
| `RoomAction` **无分发器** | grep `switch(action)` / `actionMap` / `dispatchAction` / `ACTION_HANDLERS` 全生产树 → **0** |
| `ACTION_PERMISSION` 是**权限位映射** | 每个动作映射到权限位名(`'build'` / `'wiring'` / `'party'` / `'baseline'`…) |
| 房间管理整体未接网络 | `kick` / `setMemberRole` / `setAccess` / `setPartyModeBy` 生产调用点**全部 0 处**(只有测试调) |

`server/src/net/room.colyseus.ts:184-187`(原文):

```ts
this.onMessage('action', (client, msg: { action: Parameters<RoomRuntime['authorize']>[1] }) => {
  const gate = this.runtime.authorize(client.sessionId, msg.action);
  if (!gate.allowed) client.send('reject', { kind: 'PERMISSION', reason: gate.reason });
  // ← allowed=true 时无任何语句:无 else、不调用任何执行方法、无成功回执
});
```

#### ⚠️ 一条**不成立**的归因(务必写明,否则会被再次采纳)

**曾出现过这个推理**:

> 「房主逐个发送全部 22 个 `RoomAction`,全部 **允许 22/22**;
> 跑完后快照 320 字节 → 320 字节,**逐字节相同** ⇒ **没有执行层**。」

**⇒ 这个推理不成立。** 理由:同一文件 `server/src/net/room.ts:555-563` 的
`authorize` 是**纯查表函数** —— 函数体内**零赋值**,只有 `can()` 查表 + 在线检查 + `return`:

```ts
authorize(userId: string, action: RoomAction): { allowed: boolean; reason?: string; role?: RoomRole } {
  const m = this.members.get(userId);
  if (!m || !m.connected) return { allowed: false, reason: '不在房间内' };
  const role = m.role;
  if (!can(role, action)) {
    return { allowed: false, reason: `角色 ${role} 无权执行 ${action}`, role };
  }
  return { allowed: true, role };
}
```

**纯函数当然不改状态。** 那段实验等于「跑了一个必然不改状态的函数,然后得出『状态没变』」——
**它什么都没验证。**

**✓ 成立的证据是另外两条**:
1. **文本证据**:上面那 4 行的**成功分支为空**(这是关键,来源是**文本**,不是运行)。
2. **该代码路径在 Node 里跑不起来**(见第三层)——它**无法被 import**,
   所以那 22 次实验**根本没走到那 4 行**。

**为什么这个区别要紧**:若只把「快照不变」当门禁判据,那么将来有人给 `action`
**加上真执行**、**同时**保持 `authorize` 纯查表,那条门禁会**照样绿** ——
**缺陷回来了而门禁不响**。(`net-persist` 已据此把断言改为**结构断言**
「成功分支为空」,并验证:注入真执行 → 红。)

#### 为什么门禁查不到

`room.ts` 可达、`authorize` 可达、`RoomAction` 可达 —— **全部可达**。
缺的是「**被授权之后的那一步**」。**可达性判据结构上无法表达这种落差。**

#### 职责边界(避免被「这是分工」反驳)

- ✓ `RoomAction` 是**权限登记表**,不是**动作分发器**;动作执行归拥有该子系统的 WS ——
  这**可能是刻意的分层**。`docs/WS-07-net-persist.md:17` 自我定位「权限矩阵(4 角色 × 9 权限位 × 22 动作)」;
  `:465` 把 `PLACE_BLOCK` / `BREAK_BLOCK` / `WIRE_EDIT` 归 **WS-03 建造**。
- ✗ **但**「**授权成功却静默无回执**」**不是任何人的分工**。
  该文档 `:20-26` 的「明确不负责」清单列的是物理(WS-02)/ 地形(WS-01)/
  战斗(WS-05/11)/ 炼金(WS-06)/ 渲染(客户端)—— **没有一条说「动作执行」或「失败模式」归别处**。
- **⇒ 措辞结论**:报「**权限层与执行层之间的静默落差**」而非「WS-07 有缺陷」。
  前者可立项,后者会被「这是分工」反驳。**这个措辞会决定怎么立项。**

#### 影响面

玩家视角:**发 `PLACE_BLOCK` → 服务端回 `allowed` → 什么都没发生。**
无错误、无回执、连 `else` 都没有。**比「拒绝」更难排查** —— 拒绝至少有 `reject` 报文。

---

### 第三层:入口可跑性 —— 「可达」≠「可跑」

#### 现象

`server/src/net/room.colyseus.ts` 是 `PROD_ENTRIES` 之一(**生产入口之一**,
门禁把它当**可达性根**),但它**自己无法被 import**。

```
PROD_ENTRIES 实测 3 个:
  server/src/sim/demo.ts
  server/src/net/room.colyseus.ts   ← 无法 import
  client/src/main.ts                ← 正常(浏览器入口,见下)
```

#### 实测证据:**两条独立阻塞点**

**阻塞点 1:装饰器**(Node 24 strip-only 不解析装饰器语法)

```
server/src/net/schema.colyseus.ts   44 处行首 @type(第一处 L48:`@type('string') id = '';`)
                                    → SyntaxError: Invalid or unexpected token
server/src/net/room.colyseus.ts     自己 0 处 @type,但被上面拖垮 → SyntaxError

最小复现(变量隔离):
  行首装饰器        → ✗ SyntaxError: Invalid or unexpected token
  纯类型标注        → ✓ OK
  const enum        → ✗ SyntaxError: TypeScript enum is not supported in strip-only mode
```

**装饰器计数口径**(两个数都对,别混):
- **44** = 行首真实生效的装饰器
- **45** = `@type(` 出现次数,**含 L182 注释里的残留**(`/* 原先此处有 @type('uint32') tick = 0; */`)

**阻塞点 2:命名导入 ↔ CommonJS**

```
colyseus 包:type=undefined / main=./build/index.js / exports=(无) / 实测 v0.15.57

静态 import { Room, Client } from 'colyseus'   → ✗ Named export 'Room' not found.
                                                  The requested module 'colyseus' is a CommonJS module…
静态 import * as c / 默认导入 + 解构              → ✓ OK
动态 import('colyseus')                        → ✓ OK(keys: RedisDriver, RedisPresence, default, module.exports)
```

> ⚠️ **容易漏判**:动态 `import('colyseus')` **不触发**命名导入的静态检查。
> 用它做探针会**漏掉阻塞点 2**。必须用**静态** import 才能复现。

> ⚠️ **包已装!** `colyseus` 在 `package.json` 的 **`optionalDependencies`**
> (`^0.15.17`,实测 **v0.15.57**),而 `dependencies` 是 `{}`。
> **只看 `dependencies` 会误判为「未安装」** —— 实测踩过。
> ⇒ **真因是语法与模块格式,不是缺包;修法也不同**(缺包 `npm i` 即可,装饰器需构建步骤)。

#### 为什么门禁查不到

门禁查「**可达**」——`room.colyseus.ts` 是**入口根**,门禁「认为」这条链路是活的。
**但它是入口根而不是被遍历到的节点**,所以「它自己能不能被加载」**不在判据里**。

⇒ **那 4 条 handler 零测试可覆盖**:`tests/**` 用零依赖的 `schema.ts` 替身驱动,
套件全绿,而生产装配层**跑不到**。

**这才是「`action` 成功分支为空」从未被发现的结构性原因** ——
不是没人看,是**门禁结构上查不到**。

#### 影响面

**专项若不含这一项,新加的测试也跑不到它** —— 会白做。

---

## 入口可跑性:两条阻塞点与修法清单

| # | 阻塞点 | 现状 | 修法 | 只修另一条的后果 |
| :-: | :--- | :--- | :--- | :--- |
| 1 | **装饰器**(44 处 `@type`) | strip-only 不解析 | 引入构建步骤(TS 编译),或改用零依赖 `schema.ts` | 仍因命名导入失败 |
| 2 | **命名导入 ↔ CJS** | `import { Room, Client } from 'colyseus'` | 改 `import * as colyseus` / 默认导入 + 解构,或开 `esModuleInterop` | 仍因装饰器失败 |

**⇒ 修法清单是两条,不是一条。** 只修一条 ⇒ **必然返工一次。**

---

## 受影响的模块清单

六个模块(共 **约 3284 行**,`wc -l` 口径)卡在**同一组**空缺上:

| 模块 | 行数 | 等的**接口** | 白名单理由 |
| :--- | ---: | :--- | :--- |
| `server/src/coop/rush_order.ts` | 1009 | 对局层 + 玩家动作输入管线(深于 US2) | 等对局层 + 动作输入 |
| `server/src/party/modes.ts` | 737 | 对局运行时(有枚举与计分字段,无运行时) | 等对局运行时 |
| `server/src/prank/toys.ts` | 524 | 施加整蛊的宿主(与 `immunity.ts` 同一个) | 等施加整蛊的宿主 |
| `server/src/social/afk.ts` | 494 | 房间每帧驱动(与 `room` 的 AFK **同名异义**) | 等房间每帧驱动 |
| `server/src/mobs/taming.ts` | 268 | 宠物容器 + 驯服交互(`tameItem` 无人消费) | 等宠物容器 |
| `server/src/prank/immunity.ts` | 252 | 施加整蛊的宿主(与 `toys.ts` 同一个) | 等施加整蛊的宿主 |
| **合计** | **3284** | | |

**另** `server/src/party/scoring.ts`(401 行)按同一口径也在此类。

### ⚠️ 「三道门禁共有的一个盲区」:`scripts/**` 算不算生产侧(实测)

`orphan-audit.ts` 只把 `server/src` + `client/src` 当「生产侧」。
于是**被 `scripts/**` import 的模块**会被算成「生产零引用」。

**实测(只认真实 `import` 语句)**:13 条登记里 **5 条有脚本侧引用**:

| 模块 | 脚本侧真实引用方 |
| :--- | :--- |
| `party/modes.ts` | `data-conformance.ts` |
| `prank/immunity.ts` | `data-conformance.ts` |
| `build/rooms.ts` | `perf-bounds.ts` |
| `db/memory_db.ts` | `verify.ts` |
| `content/baseline.ts` | `extension-drill.ts`、`verify.ts` |

⚠️ **但「5 条有脚本引用」不等于「5 条不是欠账」。** 分清两件事:
- 门禁**消费它的数据表**(如 `data-conformance.ts` 拿 `modes.ts` 的常量比对手册)
  ⇒ **不证明**它的 738 行**逻辑**被接线了。这 3 条**仍然是欠账**。
- 门禁**就是它的使用者**(`memory_db.ts` / `baseline.ts`)⇒ 这才是 gate-only。

**判据**:看理由怎么写。这 5 条里有 **2 条理由已经准确**
(`memory_db.ts` 写「生产走 sqlite 驱动,仅测试用」、`baseline.ts` 写「仅门禁与测试使用」),
另 3 条写「待接线」—— **后者掩盖了「门禁在用它的数据」这一事实**。

#### 为什么这条要写下来:三道门禁**同时**看不见它

| 门禁 | 为什么看不见 |
| :--- | :--- |
| 可达性 | 不把 `scripts/**` 算进闭包 ⇒ 与 orphan 判定**错得一致** |
| 生产零引用 | 同上的口径 |
| **我新加的 `orphan ⊆ 白名单` 不变量** | 两处口径一致 ⇒ **矛盾根本不出现,不变量自然不响** |

⇒ **一致性不等于正确性。** 两个口径「错得一致」时,任何「两口径是否自洽」的校验
都必然通过 —— 这是**不变量类门禁的固有盲区**:
**它只能抓住「两边不一致」,抓不住「两边一起错」。**

#### 我在这条上连错两次(记录方法教训)

1. 第一版探针报「**13/13** 都是仅脚本引用」—— 明显荒谬。
   真因:我的匹配器只查「路径字符串是否出现在文件里」,而 `orphan-audit.ts` 的
   `ORPHAN_KNOWN` 表**本身就含全部 13 条路径**,`verify.ts` 的 `UNREACHABLE_EXEMPT` 同理。
   ⇒ **清单文件里写着某个路径,不等于它 import 了那个模块。**
2. 改正为「只认 `import` / `export ... from` / 动态 `import()`」后得 **5/13**。

**误报方向是夸大**(把「提了一嘴」算成「被引用」),与 `PROGRESS.md` 记的
「误报方向是掩盖」是同一族的两面:**探针的口径松一格,结论就从「0」跳到「13」。**


### 第四类空缺:「玩家 → 怪物」这条伤害方向**整条不存在**(Lead 实测)

> ## ✅ 2026-11-12 已接线 —— 本节保留作历史,并补一条**尚未闭合**的边界
>
> `combat-progress` 在 `WorldSim.attackMob(playerId, mobId, opts)` 上把这条方向接通了。
> **Lead 独立复现**(走生产入口,不直调 `computeDamage`):
> ```
> 怪 hp 60 → 5 次攻击 → hp 10                         ✓ 真掉血
> 30 次攻击 → hp=0, alive=false                       ✓ 击杀真的发生
> 八步 steps 全部出现:1基础…8击退
> 无武器 final=10 / 712 重剑 final=13 / armorPen:8 → effDef 6→0
> 16 格远 → outOfReach=true                           ✓ 距离校验生效
> ```
> 门禁随之把 `combat/damage.ts` 与 `combat/weapons.ts` 判为「已可达,应移出白名单」。
>
> ### ⚠️ 但**端到端仍未闭合**,而且原因不在接线
>
> | 层 | 状态 |
> | :--- | :--- |
> | 公式 → `WorldSim.attackMob` | ✅ 已通(上面实测) |
> | `attackMob` ← 生产调用者 | ❌ **0**;调用者只有 `tests/` |
> | sim 层的可达入口 | ⚠️ **只有 `demo.ts`**(自述「可手动运行的演示」) |
> | 真服务端 `room.colyseus.ts` 闭包 | ❌ 10 个模块,**不含 `world_sim.ts`** |
>
> `room.ts:275` 自己写着:「`RoomRuntime` 至今**不认识**模拟层
> (US2「room 持有 sim」仍未开)」,`scripts/backlog.ts` 的 **US2「网关联动未接」** 在跟踪它。
>
> ⇒ **这条空缺分两半:公式侧的「没有这条路」已补;网络侧的「没有人在路口」是 US2,
> 属独立的架构前沿,不是接线遗漏。** 「接线了」与「端到端闭合」是两件事。
>
> ⚠️ **另需注意可达性数字的语义**:实测(用 `verify.ts` 自己的 lexer)
> 可达并集 69 个模块中 **33 个(47.8%)去掉 `demo.ts` 入口就不可达**。
> 门禁打印的「**生产**可达性」措辞强于事实 —— 待裁决是否改口径。

**这不是「公式简化」,是「没有这条路」。** 它最初被写成 `task-33` 时,
前提是「八步公式 505 行没接,生产走 `vitals.ts` 简化式,把简化式换成八步即可」。
**实测后发现该前提把两个相反方向混为一谈:**

| 方向 | 函数 | 生产调用点 |
| :--- | :--- | :-: |
| **怪 → 玩家** | `vitals.mobHitDamage(level, mul)` → `VitalsSystem.applyHit` | **2**(在跑) |
| **玩家 → 怪** | `combat/damage.computeDamage(AttackInput)` | **0** |

`computeDamage` 的签名是 `attacker: CombatantStats` → `target: TargetProfile`;
`mobHitDamage(level, mul)` 只吃**等级**与倍率。**两者方向相反、输入类型无交集。**
⇒ 按任务书字面「把 B 换成 A」,等于**用玩家攻击公式去算怪打玩家** —— 那不是修缺陷,是引入缺陷。

#### 真正缺的是什么

`world_sim` 有 `damageMob(mobId, amount, ...)`,但 **`amount` 由调用方给定**,
而**没有任何生产调用方**:

```
damageMob            生产 1 处(只有它自己的定义行)
computeDamage        生产 0 处
applyDamage          生产 0 处
reflectFrom / planSkillHits / healTarget / shieldPercent   全部 0 处
```

`net/room.colyseus.ts:170` 的 `attack` 报文 → `room.ts:638 applyAttack()`,
而 `applyAttack` **只做反作弊**(`this.ac.attack(...)`)——
**它不算伤害、不改任何生物血量、不返回伤害值。**

⇒ **玩家按下攻击键,服务端只校验「你有没有作弊」,然后什么都不发生。**

#### 与第二层是**同一个失败模式**

| | 消息 | 走什么 | 结果 |
| :--- | :--- | :--- | :--- |
| 第二层 | `action` | `authorize()` 纯查表 | **成功分支为空** |
| **第四类** | `attack` | `ac.attack()` 纯查表 | **成功分支为空** |

两者都是「**校验通过 + 无执行**」,且**都不报错**(`action` 至少还会在 `!allowed` 时发 `reject`;
`attack` 连拒绝路径都只有反作弊违规才走)。玩家视角:**攻击键与放置键都是死的,且没有任何反馈。**

#### 为什么门禁结构上查不到 —— 与第三层同因

`combat/damage.ts` 在白名单里,理由是「生产走 `vitals.ts` 简化路径,待接线」。
**这句话半真半假**:怪→玩家确实走简化路径(真的),但**玩家→怪根本没有路径**。
⇒ 白名单理由里的「简化路径」这个说法**掩盖了「另一条方向完全缺失」**——
因为读者会以为「有两条路,一条简化一条完整」,而实际是「**只有一条,且是反向的**」。

**「理由说了什么」必须在门禁里被校验** —— 这正是 `PROGRESS.md` 陷阱 16 的形态
(「事实陈述会过期,必须机器校验」),但这次**理由从一开始就是错的**,不是过期。


### ⚠️ 两道门禁对这批模块的**口径不一致**(实测发现)

| 模块 | `verify.ts` 白名单 | `orphan-audit.ts` | 差异根因 |
| :--- | :-: | :-: | :--- |
| `coop/rush_order.ts` | Y | **n** | 有 3 处**仅类型导入**(`modes.ts` / `scoring.ts` / `afk.ts`) |
| `prank/toys.ts` | Y | **n** | 被 `immunity.ts` 运行时导入 |
| `party/modes.ts` / `social/afk.ts` / `prank/immunity.ts` / `mobs/taming.ts` | Y | Y | 无生产侧导入 |

**`verify.ts` 有 22 条白名单条目,`orphan-audit.ts` 只列 13 条** ——
两者判据不同(`orphan-audit` 把「有生产侧 import」当作已引用,
**不区分运行时导入与仅类型导入**;而仅类型导入**不产生运行时边**)。

> ⚠️ **不要用 `orphan-audit` 的清单来判定「哪些模块该立项」** ——
> 它会漏掉 `rush_order.ts` 这类「有类型导入、无运行时导入」的模块。
> 那次 grep 若看到「有 3 个文件引用它」就以为可达,**会判错。**

---

## 已知的错误判据与修正版

> 这一节的存在理由:本会话两个队友**互相纠正**才逼出正确版本。
> 若不写明错误版,后来者会**重新踩一遍**。

### 错误判据 A:「授权调用后快照不变 ⇒ 无执行层」

- **错在哪**:`authorize` 是**纯查表函数**(零赋值)——**纯函数当然不改状态**,
  那段实验**什么都没验证**。
- **修正版**:用**文本断言**(成功分支为空)+ **可跑性事实**(该路径无法 import)。
- **为什么必须写明**:若只把「快照不变」当门禁,将来**加真执行 + 保持 `authorize` 纯** ⇒
  **门禁照样绿,缺陷回来而不响。**

### 错误判据 B:「凡 `PROD_ENTRIES` 条目必须能被 `await import()` 成功加载」

- **提法来源**:`mob-boss-ai` 起初建议,意在自动化。
- **错在哪**:会**误报**。实测 3 个生产入口,**2 个 import 失败,但其中 1 个是正常的**:

| 入口 | 动态 import 结果 | 判定 |
| :--- | :--- | :--- |
| `server/src/sim/demo.ts` | ✓ OK | — |
| `server/src/net/room.colyseus.ts` | ✗ `SyntaxError: Invalid or unexpected token` | **真问题** |
| `client/src/main.ts` | ✗ `ReferenceError: document is not defined` | **正常**(浏览器入口) |

  `client/src/main.ts` 是**浏览器入口**(其文件头 L2 自述「浏览器入口 —— 极薄」),
  在 Node 里没有 `document` 是**分层设计的必然结果,不是缺陷**。
  ⇒ 按字面实现这条判据,会把一个完全正常的入口报成缺陷。

- **修正版**:不可跑时**必须登记「原因」,且原因必须是「刻意的」**
  (如「浏览器入口,Node 无 DOM」)**而非「意外的」**
  (如「运行时语法不支持」「模块格式不兼容」)。
  判据形态:**「入口的加载失败若是 `SyntaxError`(解析层)⇒ 报;若是 `ReferenceError`(运行时环境)⇒ 不报」**。

- **顺带**:若将来做这条探针,注意 `await import()` 会**执行顶层语句** ——
  `server/src/sim/demo.ts` import 时会**真跑一遍模拟并打印整张报告**
  (实测:56 条非缩进顶层语句全是副作用:建世界 / 跑 200 帧 / `console.log`)。
  做门禁会污染输出与全局状态。故宜用**静态**判据(检查已知阻塞形态)。

### 抽象:判据不得取自结论的下游

上述两种错误 + 另两种同源,合起来是四类:

| # | 表现 | 实例 |
| :-: | :--- | :--- |
| 1 | 期望值取自被测常量 | `eq(slotsAt(1), ORDER_SLOT_MIN)` —— 两边同时变,**恒真** |
| 2 | 选一个**必不触发**的用例 | `authorize` 是纯函数,必不改状态 |
| 3 | 判据取自**不完整字段** | 只读 `dependencies` 漏 `optionalDependencies` ⇒ 误判「未装包」 |
| 4 | 判据值域**覆盖整个输入空间** | `ok(parseInt(version) >= 0)` —— 任何版本号都通过,**恒真** |

**⇒ 统称:「期望值不得取自被测对象本身」(无论是取值、选用例、截取字段,还是放宽到全域)。**

---

## 立项建议与验收标准

### 建议题目(两队友联署)

> **「房间↔模拟层装配 + 动作执行层(含静默成功回执)+ 生产入口可跑性(装饰器 & CJS 双阻塞)」**

**为什么三层必须一起**:它们是**叠加**的。

- 只做第一层(容器)⇒ `rush_order.ts` 依然**收不到动作**(第二层堵着)
- 只做第二层(执行)⇒ `room.colyseus.ts` **跑不起来**,新测试**执行不到**(第三层堵着)
- **⇒ 任缺一层,专项都会二次返工。**

### 验收标准

1. **容器层**:`RoomRuntime` 能持有模拟层实例,且**不引入** `net → sim → db` 的编译期硬约束
   (用结构化接口,参照现有 `WorldSaveHost` 的写法)。
2. **动作执行层**:`RoomAction` 的每个动作必须**要么有执行分支、要么显式拒绝并回执**。
   **禁止静默成功** —— `allowed` 之后必须有回执或副作用,二者之一。
3. **入口可跑性**:`room.colyseus.ts` 能被 `await import()` 成功加载;
   两条阻塞点**都**要处理(装饰器 + 命名导入↔CJS)。
4. **判据修正**:新增的可跑性探针必须按「刻意原因 / 意外原因」分类,
   **不得**把 `client/src/main.ts` 报成缺陷。
5. **回归守卫**:六模块中至少 `coop/rush_order.ts` 摘出白名单后**仍全绿**
   (即白名单摘除与接线必须同步,否则门禁会报「未登记」)。

### 未决(需 Lead 裁决)

- 装饰器修法选**构建步骤**还是**零依赖替身**?(影响 `schema.colyseus.ts` 的存废)
- 「动作执行」到底归 WS-07 还是各子系统 WS?(本文结论:**失败模式归谁**比执行归谁更该定)
- `party` 词表冲突(见下)与本专项是否合并处理?

---

## 第五层空缺:US2 不是「接线」,是「**先裁决唯一所有者**」

**来源**:`task-49`(`net-persist`)的 `docs/AUTHORITY-MAP.md`,Lead 逐条复核。
**这一层是第四层的前提** —— 第四层说「参数从哪来」,这一层回答「**权威是谁**」。

### 现象:同一份玩家状态在服务端有**两套互不相识的实例**

```
room.ts 侧   : state.players[]            ← 网络投影给客户端的
WorldSim 侧  : 5 个 Map(vitals/progresses/…/downedStates)  ← 战斗实际用的
```

**三条硬判据**(Lead 已复核):
```
room.ts 含 WorldSim / world_sim : **false / false**   ← 完全不认识模拟层
room.ts 内 `.level =` 命中      : **0 处**;join() 只传 name/x/y/z
wearing 唯一入口 setMobPlayers  : 生产调用 **0 处**(测试 5 处)
```
⇒ **交集字段(`level` / `hp` / `maxHp` / `x,y,z` / 武器)没有任何同步通道**,
而 `room.ts` 那一套**一半字段没有写者、另一半是硬编码常量**。

**⇒ 这不是「接一条线」能解决的**:必须先裁决谁是唯一所有者,
否则接线只会把两份并成三份。

### 实测:7 处「≥2 个写者」

| # | 状态 | 写者 A | 写者 B | 危害 |
| :-- | :--- | :--- | :--- | :--- |
| W1 | `maxHp` | `VitalsSystem` 构造常量 **100** | `progression.recompute`(L30=**535**) | **可造出 `hp > maxHp`** |
| W2 | `level` | `PlayerProgress.level` | `room.PlayerState.level`(**无写者**) | 网络层等级**永久为 1** |
| W3 | `downed` | `PlayerVitals.downed`(布尔) | `DownedState`(结构体 Map) | 同名不同义 |
| W4 | `carrySlots` | 冻结层 `statsAtLevel` | `room.ts` 内联 `8+(lv-1)` | L>30 分歧 |
| W5 | 背包 | `users.inventory_json`(明细) | `room.inventoryTotals`(仅总量) | 两份各自漂 |
| W6 | `hp`/`x,y,z`/`weaponId` | 模拟层各权威 | `room.PlayerState` 同名字段 | 8 个字段零同步 |
| W7 | `Clock` 接口 | `coop/rush_order.ts` | `net/anticheat.ts` | 两个同名接口 |

**其中 W1 有 Lead 独立复现的实测**:`vitals.revive('p1', 535)` → `hp=535 maxHp=100`。
链条:`revive.ts` 取 `progress.maxHp` → `vitals.ts` 的 `v.hp = hp ?? v.maxHp` **无钳制**。
⚠️ **而同一个入口的读档路径是有钳的**(`importVitals` 里 `Math.min(v.maxHp, row.hp)`)
⇒ **同一入口两条路径行为不一致** —— 这才是缺陷的准确形态。

### ⚠️ 一条**升级后又降级**的发现(`mobHitDamage`)—— 记录方法教训

`net-persist` 报告「**怪物打人无钳!** `level 1e9 → 2000000004`」。
Lead 复核:**函数层成立**(完全复现),但**危害半径要收窄**:

```
vitals.ts:403   v.hp = Math.max(0, v.hp - raw);   ⇒ **HP 侧有钳(钳在 0)**
vitals.ts:406   v.totalTaken += raw;              ⇒ 无钳
vitals.ts:416   this.totals.damage += raw;        ⇒ 无钳
```
⇒ 真实危害是「**统计字段吸收荒谬值**」,不是「玩家掉荒谬的血」。

**可达性**(决定性,Lead 实测):
```
冻结层 mobs.ts  :24 个 level,1..25
冻结层 bosses.ts: 8 个 level,5..30
⇒ 生物最大等级 = 30 ⇒ mobHitDamage(30) = 64  ⇒ **当前内容不可达**
```
⇒ **正确定性:缺少守卫的契约缺陷,不是当前可利用缺陷。**
两者都该记,但**优先级与修法不同**。

**三个未钳字段**(`net-persist` 补了第三个,Lead 复核):
```
:403  v.hp = Math.max(0, v.hp - raw)   ⇒ **已钳**(钳在 0)
:406  v.totalTaken += raw              ⇒ 未钳
:416  this.totals.damage += raw        ⇒ 未钳
:408  base.applied = raw               ⇒ 未钳 ← **最要紧**(它是调用方拿到的返回值)
```

⚠️ **更具体的隐患 —— 但 Lead 在这里算错了一次,记录在案**:
Lead 原写「`2000000004` 距 `INT32_MAX` 只差 `1.4e8` ⇒ 会溢出为负」。
**`net-persist` 实测纠正:阈值是 `level ≥ 1073741822`,不是 `1e9`。**
```
INT32_MAX = 2147483647;  4 + 2·lv > MAX  ⇒  最小 lv = 1073741822
f(1073741822) = 2147483648  ⇒ Int32Array 里为 **-2147483648**(溢出)
f(1e9)        = 2000000004  ≤ MAX,余量 147483643  ⇒ **未溢出**
```
**Lead 的错因与前面几种不同型**:原文写的是「**距** INT32_MAX 只差 1.4e8」——
「距」表示**余量**(还有 1.4e8 空间),Lead 却读成了「差额不足」,于是结论反了。
⇒ **第四种错型:读对了数字,读错了关系。**

**定稿表述**(采纳 `net-persist` 的):风险**不是**溢出,而是
`applied` / `totalTaken` 吸收 `2e9`;int32 只值得记一条**前瞻性**理由 ——
阈值 `1.07e9` 相对内容上限 `30` 有约 `3.6e7` 倍余量,但
**一旦「等级」改成从报文读(US2 正要这么做),越过它只需要一个数字。**

**⇒ 方法教训(与第四层同族,但方向相反)**:
第四层是 Lead **高估**(把封顶误读为无上限);这里是**形容词越界** ——
「无钳」在函数层为真,但读者会理解成「玩家会掉荒谬的血」,而**那是假的**。
**⇒ 报告里的每个形容词也在断言事实。** 与「门禁印的每个数字都在断言事实」同理。

**⇒ 还有一条独立的**:`applied` 那个字段是**调用方拿到的返回值**,
而它无钳。**「内部统计无钳」与「对外返回值无钳」的危害不同** ——
后者会外流(网络差量、客户端显示、存档)。记这一条时**必须区分**。

### 与第四层的关系(为什么两层都要写)

| 层 | 回答的问题 | 若只做这一层 |
| :--- | :--- | :--- |
| 第四层 | 参数**从哪来**(调用方自报 vs 服务端派生) | 把「自报」改成「派生」,但**不知道从哪派生** |
| 第五层 | 谁是**权威所有者** | 知道该派生,但**没有可派生的唯一真相源** |

⇒ **两层合起来才是 US2 的完整前置。** 顺序:先第五层(定所有者)→ 再第四层(定来源)。

### 影响面

US2(`task-47`)已据此把依赖改为 `blocked_by [task-36, task-44, task-49, task-51]`。
**`task-49` 的产出(`docs/AUTHORITY-MAP.md`)是本层的权威依据。**

### 未决(需 Lead 裁决)

- **`maxHp` 以谁为准?** `vitals` 的常量 100 还是 `progression` 的等级派生?
  ⇒ 这决定「温泉 +30% 生命上限」(task-48 已接)该乘在哪个基上。
- **`room.PlayerState.level` 无写者** —— 是**删掉该字段**还是**补写者**?
- **8 个交集字段的同步方向**:服务端权威单向投影,还是双向?
- W1 的修法:在 `revive` 侧钳,还是在 `vitals` 侧钳?
  ⚠️ 两侧都钳会重演「两份实现」—— **必须选一处**。
- `mobHitDamage` 加钳的阈值取什么?(生物最大 30 ⇒ 但不该硬编码 30)

---

## 未决问题

1. **`party_mode` 词表冲突**(实测,`net-persist` 用**真实 SQLite**验证):
   ```
   冻结层 shared/constants/bosses.ts : BRIDGE_CTF / CROWN_BR       (权威,WS-11 的 H0 断言它)
   DDL   schema.sql 的 CHECK         : BRIDGE_FLAG / CROWN_RUN
   ⇒ 4 个模式里 2 个会被 DDL 拒:
      BRIDGE_CTF → CHECK constraint failed: party_mode IN (…)
      CROWN_BR   → CHECK constraint failed: …
      JELLY_BALL / PAINT_WAR → 接受
   ```
   目前**未引爆** —— 因为没有任何生产路径用那两个值调 `setPartyMode`。
   但本专项若落 `party` 状态,会撞上这堵墙。

2. **`coop/rush_order.ts` 的 `deliverItem` 修复与 `docs/WS-11-coop-prank-party.md`
   §10.2 的 U2 决策相抵触** —— U2 记「保持现实现的『先乘后除再取整』,**不做末位补差**」,
   而实测该实现对**切分方式敏感**(1600 块订单板中 769 块 / 48.1% 两种交法得分不同,
   **且两个方向都有**)。**待 Lead 裁决**;若裁决保留原行为,须连同
   `tests/WS-11.test.ts` 的 **K2** 一起回退(只回退代码会让 K2 变红)。

3. **`room.colyseus.ts` 的测试覆盖路径** —— 现有 `tests/WS-07.test.ts` 用
   **文本解析**驱动(`readFileSync`),该做法本身正确(测的是源码事实),
   但其注释里「Colyseus 是 optionalDependency **未安装**」**已过期**(实测已装 v0.15.57),
   且把「不能 import」归给**两个**理由,其中一个是错的。真因只有**装饰器**。
   **归因错会误导后来者。**

4. **`await import()` 作探针的副作用** —— 见「已知的错误判据」末段。

---

## 第四层空缺:US2 的**契约前置** —— 调用方自报参数(Lead 实测)

前三层说的是「**东西不在**」(边不在、那一步不在、可加载性不在)。
这一层不同:**东西都在,且跑得通** —— 缺的是「**谁有权写它**」。

⇒ 它是前三层的**前置条件**:容器层接上以后,`room` 拿到的 `WorldSim` 里,
每个玩家字段的**权威所有者**必须先定,否则接线只是把空缺搬了个位置。

### 现象:`attackMob` 的 `opts` 是调用方自报值

`server/src/sim/world_sim.ts` 的 `attackMob(playerId, mobId, opts)` 里,
`opts` 的 `wearing` / `level` / `weaponId` **都有 docstring 自述这是信任边界**:

> ⚠️ **信任边界:`wearing` / `level` / `weaponId` 目前是「调用方自报值」。**
> **但网络层一旦接上(US2),绝不能把客户端报文里的装备/等级直接塞进来** ——
> `opts` 覆盖项应改为**仅测试可见**。

**⇒ 这段 docstring 已经写对了。** 本节的价值不是「发现它」,而是
**把它变成可验收的数字,并指出它缺的那一半。**

### 实测证据(Lead 探针,走真实生产入口,`mob_sheep`)

```
基线(不传 opts)                     final=14   hpLoss=14
───── level:1e9 ─────────────────────────────────────────
  level=  1 → 14      level= 10 → 18      level= 20 → 22
  level= 50 → 27      level= 99 → 27      level= 1e9 → 27
  ⇒ **有钳制**,在 level≈30 封顶。钳制点 weapons.ts:818 `Math.min(MAX_LEVEL, level)`
    (冻结层 `MAX_LEVEL = 30`)⇒ 倍率上限 **1.93×**
───── wearing ───────────────────────────────────────────
  不传 / [] / [1]  → 14    (三者相同 ⇒ 缺省与空数组等价,无双份语义)
  [712]            → 76    5.43×        ← **无钳制**
  [712]×5          → 76    5.43×        (重复不叠加 ⇒ 是集合语义,非计数)
───── comboMul ──────────────────────────────────────────
  comboMul=1 → 14   1.25 → 18   2 → 29   100 → 1429   1e9 → 14285714286
  ⇒ **完全无钳制**(world_sim 直接透传,damage.ts:339 直接相乘)
───── 复合(网络层最坏情形)─────────────────────────────
  level 1e9 单开        27      1.93×
  wearing[712] 单开     76      5.43×
  两者同开              142     10.14×
```

### ⚠️ 一条**被我推翻**的旧结论(务必写明,否则会被再次采纳)

本仓早前(含 `task-47` 的任务描述)写过:
> `level: 999(荒谬) → final=27 ← **无上限钳制**」,并据此算出「7.6 倍放大」。

**这句是错的。** `level=27` 不是「无钳制地放大到 999」,而是**恰好封顶后的值**。
我的第一版探针**只测了 `999` 一个点**,于是把「封顶」误读成「线性放大」。

**⇒ 方法教训:单点测量不能区分「封顶」与「非线性」。**
判「有/无上限」必须做**邻近点扫描**(本例加了 20/50/99 就立刻看出来)。

**这个错误的危害是双向的**:
- 高估:报出 7.6× 的放大倍数(实际 1.93×),会让优先级判断失真;
- 误导修法:若照「无上限」去修,会加一个**多余的**钳制,
  而真正的缺口(`comboMul`、`wearing`)**被这个假发现掩盖**。

### 真正缺的是什么

| 字段 | 钳制 | 合法值域有定义吗 | 缺的是 |
| :--- | :--- | :--- | :--- |
| `level` | ✓ `MAX_LEVEL=30` | ✓ 冻结层有 | **权威**(服务端该从档案读) |
| `wearing` | ✗ | ✗ | **权威 + 值域** |
| `weaponId` | — | 部分(未注册静默退化) | **失败语义**(未注册该拒还是退化) |
| `comboMul` | ✗ | 疑为 `{1.00, 1.00, 1.25}` 三值 | **值域 + 拒绝语义** |
| `skill` | 部分(`damage.ts` 有 `MAX_*`) | 部分 | 权威 |

**⇒ 五种参数、三种不同的缺法。** 这不是「一个 bug」,是
「**玩家面板的权威归属从未定义**」这一个结构问题的五个面。

### 为什么门禁结构上查不到

- `attackMob` 有 **0 个生产调用者**(仅测试调),所以
  「客户端能不能塞 `wearing`」**在生产路径上不可观测** —— 没有生产路径。
- 现有门禁查的是「有没有人引用」「能不能走到」。
  **「谁能写这个字段」不是节点也不是边**(与前三层同因)。
- 反作弊层(`anticheat.ts`)只管**坐标跳变/移速/攻速**等**时序量**,
  不管**面板派生量** —— 它的输入是 `intent`,而面板不在 `intent` 里。

### 与既有纪律的关系(这是**已定纪律的新实例**,不是新原则)

`docs/CHANGE_REQUESTS.md` 的 **CR-14 U1** 已裁定:
`allowedSources` / `capacity` 一律**服务端派生**,不信客户端。
**U2** 又修掉了 `intent.speedMul` / `claimedAttackSpeedBonus`。

⇒ 本条与它们是**同一族**:「**判据取自客户端输入**」。
**但它更隐蔽**:前两条的字段名自带 `claimed`/`由调用方传` 的暗示,
而 `opts.level` / `opts.wearing` 看起来只是「参数覆盖」——
**直到你注意到 `attackMob` 在生产里一个调用者都没有。**

### 影响面

若 US2 把客户端报文直接透传进 `opts`:
```
服务端 playerById / syncPlayers 硬编码 wearing: []   ← 服务端存的是空的
客户端报文可任意覆盖 opts.wearing                    ← 客户端传什么就用什么
⇒ **「服务端存空 + 客户端全权」= 最坏组合**(比两个都错更坏:正确性完全由客户端决定)
```
且**不会有任何门禁报红**。

### 验收标准(供 US2 的专项引用)

1. **权威**:`level` / `wearing` / `weaponId` **一律由服务端从玩家权威状态派生**;
   客户端报文只允许携带**意图**(打谁 / 朝向)。
2. **覆盖项降级**:`opts` 的三个覆盖参数**仅测试可见**
   (做法可以是改名如 `__testOverrides`、或收进一个显式带 `TEST_ONLY` 的类型)。
3. **值域**:`comboMul` / `wearing` 的合法值域**要有定义**;
   非法值的语义(**拒绝** vs **夹取**)必须**显式选定并写进断言** ——
   ⚠️ 二者语义不同,`Math.min` 是夹取,**不适用于离散合法集合**。
4. **可观测**:三者都要有**反作弊断言** ——
   伪造客户端面板的报文 ⇒ 服务端派生的面板**不受影响**。
5. **不得**借 US2 顺手改 `damage.ts` 的公式(那是 task-33 的已完成契约);
   本条只定**参数从哪来**,不定**公式怎么算**。

### 未决(需 Lead 裁决)

- `wearing` 的**攻击力**放大是否需要上限?(现 5.43×)`dodge/crit` 已有 `MAX_*`,
  唯攻击力无 —— 是刻意还是遗漏?
- `weaponId` 未注册时**静默退化**为裸装,与「拒绝」相比哪个对?现行为确认为**退化**。
- `comboMul` 若确认合法值是离散三值,是否应**改签名**(接受连段序号而非倍率)?

---

## 数据结构、算法与参数

### 数据结构:三层各自缺的那个类型

| 层 | 现存结构 | **缺的结构** |
| :--- | :--- | :--- |
| 容器层 | `RoomRuntime`(成员 `Map`、`partyMode` 枚举、`scoreA`/`scoreB` 字段) | **对局态**(一局的开始/进行/结算,及它的生命周期归属) |
| 动作执行层 | `RoomAction`(22 键的常量对象)+ `ACTION_PERMISSION`(动作 → 权限位名) | **动作 → 执行**的映射(目前**不存在**,`grep` 全生产树 0 处) |
| 入口可跑性 | `PROD_ENTRIES`(字符串数组) | 每个入口的**可加载性 + 刻意原因**(目前无此结构) |

现有可复用的结构范式:`server/src/net/room.ts:287` 的
`export interface WorldSaveHost { saveToDb(db, roomId, nowMs): { hpSaved; hpSkipped; memRow } }`
—— **只声明用到的那一个方法的接口**,是「不引入编译期硬约束而建立装配」的现成做法,
接容器层时建议沿用。

### 算法:为什么现有两类判据都表达不了

- **`orphan-audit.ts` 的判据**:遍历生产文件,解析每个文件的 import 说明符,
  看是否命中目标。它的词法自检覆盖 16 种 import 形态(含 `import type`)。
  ⇒ **算法问的是「有没有边」**。本三层的问题**不是缺边**,而是缺边**之间的东西**,
  故它结构上无法表达。
- **`verify.ts` 的可达性**:从 `PROD_ENTRIES` 出发做**图遍历**,收集可达集合,
  与不可达集合求差,再对照白名单(`UNREACHABLE_EXEMPT`,22 条)。
  ⇒ **算法问的是「根能不能走到」**。
  (a) 两个可达模块之间少一条边 ⇒ 两个都进可达集合,**看不出来**;
  (b) 入口自己是**根**,不被遍历 ⇒ **入口自身可加载性不在判据里**。

**⇒ 两类算法都建立在「节点 + 边」上,而三层缺的都是「非节点、非边」的东西。**

### 参数(实测值,供验收比对)

| 参数 | 值 | 出处 |
| :--- | ---: | :--- |
| `RoomAction` 动作数 | **22** | `Object.values(RoomAction).length` |
| 客户端消息面条数 | **4** | `onMessage` 出现 4 次 |
| `action` 成功分支语句数 | **0** | `room.colyseus.ts:184-187` |
| `schema.colyseus.ts` 行首装饰器 | **44**(含注释计数 45) | `L48` 起 |
| `room.colyseus.ts` 自身装饰器 | **0** | 被上面拖垮 |
| `colyseus` 实测版本 | **v0.15.57**(声明 `^0.15.17`) | `optionalDependencies` |
| `PROD_ENTRIES` 条目数 | **3** | `verify.ts` |
| `UNREACHABLE_EXEMPT` 条目数 | **22** | `verify.ts:619` |
| `orphan-audit` 已登记 orphan | **13** 条 / 5895 行 | 其自身输出 |
| 六模块合计 | **3284** 行 | `wc -l` 口径 |
| 仿真双频 | 慢帧 `SIM_SLOW_DT = 0.5`s / 快帧 0.05s(20Hz),比例 **1:10** | `world_sim.ts` |

### 性能:两条与性能相关的实测

1. **`await import()` 有副作用,量级不可忽略** —— import
   `server/src/sim/demo.ts` 会**真跑一遍模拟**:200 帧、64×64 格、
   打印整张报告(实测耗时 8.4ms / 0.042ms 每帧)。
   ⇒ 若把「入口可跑性探针」做成**动态 import**,每次跑门禁都会
   **多付一次仿真开销 + 污染 stdout + 可能改全局状态**。
   **故探针宜用静态判据**(检查已知阻塞形态),而非动态 import。
2. **两种加载失败的代价不同,但都不能靠重试解决** —— 阻塞点 1(装饰器)与
   阻塞点 2(命名导入↔CJS)都是**模块解析期**失败,在 `import` 的第一步即抛出,
   **没有运行时开销可谈**;它们的代价是**整条网络面零测试覆盖**(见第三层影响面)。

---

## 附:三层空缺与判据演进的耦合关系

这三层空缺是**同一类结构问题**在三个高度的投影:

| 层 | 缺的东西 | 可达性判据能否表达 |
| :--- | :--- | :--- |
| 容器层 | 一条**边**(`room` → `sim`) | ✗(两个可达模块之间少一条边,看起来一样) |
| 动作执行层 | **授权与执行之间的那一步** | ✗(三者全可达) |
| 入口可跑性 | **入口自身的可加载性** | ✗(入口是根,不被遍历) |

**⇒ 三层都不是「某个文件没人引用」,而是「节点都在、它们之间的东西不在」。**
这正是 `orphan-audit`(查「有没有被引用」)与 `verify.ts` 可达性(查「能不能走到」)
**两类判据都覆盖不到**的原因 —— 也是本文必须存在、而不能靠某一条新断言了事的原因。
