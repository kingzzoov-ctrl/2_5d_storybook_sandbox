# TASK-91:动作执行层定性 + 承接方归属 + 接线红线

> **状态**:第 1/2/3 步完成(只读)。**零代码改动,零行接线。**
> **本卡不问「怎么接」,只答「接之前必须知道什么」。**
>
> 撰写人:`coop-party` · 写域:`docs/TASK-91-action-layer-audit.md`(本文件,新建)
> 探针:仓库根 `_t91_*.ts`,**用完逐个删除**(见 §7,零残留已核)

---

## 0. 结论速览(一句话)

> **`action` 通道对全部 22 个动作都是「只判权限、不执行」——
> 不是「18 个没接、4 个接了」,而是「0 个接了」。**
>
> 差异不在通道里,在**通道之外**:22 个动作里 **12 个连宿主都没有**,
> 5 个有宿主但零生产调用者,只有 5 个既有宿主又有生产调用者 ——
> 而**那 5 个的生产调用者也全部不经过 `action` 报文**(它们走 `onDispose` /
> `demo.ts` / 内部调用)。⇒ **接线时不能「接到宿主上」就算完,
> 必须接到「报文 → 宿主」这一段,而这一段现在完全不存在。**

---

## 1. 我能证明的 / 2. 我不能证明的
### 1.1 我能证明的(每条附 file:line + 原文)

| # | 命题 | 证据 |
| ---: | :--- | :--- |
| P1 | `action` handler 只调 `authorize`,**无第二处 runtime 调用** | `room.colyseus.ts:328-331`(原文见 §3.1) |
| P2 | 该 handler **没有 `else`** ⇒ `allowed=true` 时静默返回,**连回执都没有** | 同上;行为断言 `WS-07.test.ts:3923-3924` |
| P3 | 全仓**无** `applyAction` / `dispatchAction` / `executeAction` / `runAction` / `handleAction` | 实测:唯一命中是 `world_sim.ts:92` 的**注释**,自述「全仓也没有」 |
| P4 | 22 个 `RoomAction` 逐个枚举无遗漏 | `Object.values(RoomAction).length === 22`,`room.ts:97-120` |
| P5 | **接线即红 = 恰好 2 条断言**(注入实测,不是读出来的) | §6 注入 INJ-91 |
| P6 | 门禁**另有**「登记失真」判据会在接线时报错 | §6:`✗ 入口执行层登记失真(1 处)` |
| P7 | 5 个「有宿主」的方法**零生产调用者**(只有测试调) | §4.2 逐个调用点计数 |
| P8 | `room.colyseus.ts` **不能 import**;而 `ws_server.ts` **能** | §5 实测(这是第三层,不是本卡的层,但影响验收方式) |

### 1.2 我不能证明的(明确列出)

```
N1 「无任何文档指派过动作执行层的归属」是「**未找到**」,不是「证明不存在」。
   我读了 ARCH-GAPS / WS-11 doc / SIM-orchestration 的可疑段落;
   ★ 但 ARCH-GAPS:521 自己就把这件事列成**未决问题**:
     「「动作执行」到底归 WS-07 还是各子系统 WS?(本文结论:失败模式归谁比执行归谁更该定)」
     ⇒ 所以准确说法是:**归属问题已被登记为未决,而不是被指派**。这与「漏了」不同。
N2 「12 个动作连宿主都没有」依赖我给的**符号名候选**。命名与设计意图不符时,
   我的探针会漏判(把「有宿主但名字不同」误报成「无宿主」)。
   ⇒ 已用**多候选名**(每个动作 2-3 个)降低该风险,但**不能消除**。
N3 我没有测「22 个动作各自**在玩法上是否必要**」。有的动作可能设计上就不该由客户端发起
   (ARCH-GAPS:521 提的正是这个),那类应判 D 而不是 C —— **我没有判据去区分**,见 §4.3。
N4 我没有验证 `RoomAction` 的 22 个键与手册(320 件物品/四模式)的动作需求是否**一一对应**。
   可能缺动作,也可能有冗余动作。**未查**。
N5 「接线后行为正确」未验 —— 本卡不实现,故不存在该证据。
```

---

## 3. 第 1 步:22 个动作逐个定性(A/B/C)+ file:line + 原文

### 3.1 `action` 通道的原文(全部证据的立足点)

`server/src/net/room.colyseus.ts:328-331`(**逐字**):
```ts
    this.onMessage('action', (client, msg: { action: Parameters<RoomRuntime['authorize']>[1] }) => {
      const gate = this.runtime.authorize(client.sessionId, msg.action);
      if (!gate.allowed) client.send('reject', { kind: 'PERMISSION', reason: gate.reason });
    });
```

**这 4 行就是整个动作执行层。** 逐点读:
```
L328  onMessage('action', ...)                     ← 收到动作名
L329  const gate = this.runtime.authorize(...)     ← 只查权限表
L330  if (!gate.allowed) client.send('reject', …)  ← **只有否定分支**
L331  });                                          ← 直接结束
⇒ L330 之后**没有第二条语句**;连 `else` 都不存在。
⇒ allowed=true ⇒ 函数返回 ⇒ 调用方 `client` 收不到任何回执 ⇒ **静默**。
```

### 3.2 `authorize` 的原文(证明它是纯查表)

`server/src/net/room.ts:1171-1180`(**逐字**):
```ts
  /** 权限裁决。越权返回 false 且**不产生副作用**。 */
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
⇒ **无一处状态赋值**。三个 `return` 全是构造返回值。
⇒ 所以「`authorize` 无副作用」这个事实**本身不足以**推出「无执行层」
(纯函数当然不改状态)—— 这是 `WS-07.test.ts:3966-3969` 自己记的一处**证据链错误**,
我复核确认它写得对,并引用为本次定性的方法论警示。

### 3.3 ★ 逐个定性表(A/B/C)

**判据口径**(必须写清,否则「22 个逐个」是空的):
```
A 已实现(有执行体)  —— 该动作**经 `action` 报文**能改变世界
B 只判权限不执行    —— `action` 报文到达后只过 authorize,不动世界
C 分支不存在        —— 连「按动作名分流」的那层 switch/map 都不存在
```
**按这个口径,22 个动作的答案是统一的:**

| # | 动作 | 定性 | 依据 |
| ---: | :--- | :---: | :--- |
| 1 | `MOVE` | **B** | `action` 里的 MOVE 只过 `authorize`;真移动走**另一条报文** `move` → `applyMove` |
| 2 | `ATTACK` | **B** | 同上;真攻击走 `attack` → `applyAttack` |
| 3 | `PLACE_BLOCK` | **B** | 无宿主被 `action` 调用 |
| 4 | `BREAK_BLOCK` | **B** | 同上 |
| 5 | `PICKUP_ITEM` | **B** | 同上 |
| 6 | `DROP_ITEM` | **B** | 同上 |
| 7 | `CRAFT` | **B** | 同上 |
| 8 | `USE_ALCHEMY_FURNACE` | **B** | 同上 |
| 9 | `OPEN_CHEST` | **B** | 同上 |
| 10 | `USE_OWN_CHEST` | **B** | 同上 |
| 11 | `SLEEP` | **B** | `room.ts:1085 sleep()` 存在,但 `action` 不调它 |
| 12 | `START_PARTY` | **B** | `world_sim.ts:3497 startPartyRun()` 存在,但 `action` 不调它 |
| 13 | `SET_ROOM_ACCESS` | **B** | `room.ts:1212 setAccess()` 存在,但 `action` 不调它 |
| 14 | `SET_PARTY_MODE` | **B** | `room.ts:1227 setPartyModeBy()` 存在,但 `action` 不调它 |
| 15 | `KICK_MEMBER` | **B** | `room.ts:1199 kick()` 存在,但 `action` 不调它 |
| 16 | `SET_MEMBER_ROLE` | **B** | `room.ts:1182 setMemberRole()` 存在,但 `action` 不调它 |
| 17 | `RESET_WORLD` | **B** | 无宿主 |
| 18 | `CLOSE_ROOM` | **B** | `room.ts:1093 close()` 存在,但它由 `onDispose` 调,**不由 `action` 调** |
| 19 | `MODIFY_TOWN` | **B** | 无宿主 |
| 20 | `PLACE_AUTOMATION` | **B** | `wiring/graph.ts:343 addComponent()` 存在,但 `action` 不调它 |
| 21 | `WIRE_EDIT` | **B** | `wiring/graph.ts:266 addWire()` 存在,但 `action` 不调它 |
| 22 | `BREED_TAME` | **B** | 无宿主 |

**⇒ 22 / 22 = B。**

**★ 并且通道本身是 C**:`action` handler 里**没有任何按动作名分流的结构** ——
无 `switch`、无 `map`、无 `if (msg.action === …)`。所以「22 个动作」从未被区分过。
`ARCH-GAPS.md:120` 的实测与之一致:
> `RoomAction` **无分发器** — grep `switch(action)` / `actionMap` / `dispatchAction` / `ACTION_HANDLERS` 全生产树 → **0**

**⇒ 所以「B 还是 C」的正确回答是分两层**:
```
通道层 = C(连分流都不存在)
动作层 = 22/22 全是 B(即便你以为某个动作"接上了",它也过不了 action 这条通道)
```

**⚠️ 必须同时写下的一句**:`PLACE_BLOCK` / `PLACE_AUTOMATION` / `WIRE_EDIT` 的宿主
**确实在生产里被调用**(见 §4.2 的调用点)—— 但**那些调用者不是 `action` 报文**。
把它们写成「A 已实现」会**过度声称**,读的人会以为「客户端发 `action` 就能建造」。**不能。**

---

## 4. 第 2 步:承接方归属 + 四类判据

### 4.1 实测的 22 行分类表

判据(全部来自**调用点计数**,不是我的命名猜测):
```
生产有定义  = server/src|shared 里有无该符号的**定义行**
生产调用点  = server/src 里有多少**调用**行(排除定义行)
测试调用点  = tests/ 里的调用行数
```
| 动作 | 生产有定义 | 生产调用点 | 测试调用点 | 判据四类 |
| :--- | ---: | ---: | ---: | :--- |
| `MOVE` | 1 | 1 | 17 | A 有宿主+缺调用点(经 action) |
| `ATTACK` | 1 | 1 | 12 | A 有宿主+缺调用点(经 action) |
| `PLACE_BLOCK` | 2 | 3 | 9 | A 有宿主+缺调用点(经 action) |
| `SLEEP` | 1 | 1 | 10 | A 有宿主+缺调用点(经 action) |
| `CLOSE_ROOM` | 5 | 9 | 16 | A 有宿主+缺调用点(经 action) |
| `PLACE_AUTOMATION` | 1 | 1 | 61 | A 有宿主+缺调用点(经 action) |
| `WIRE_EDIT` | 3 | 3 | 15 | A 有宿主+缺调用点(经 action) |
| `START_PARTY` | 4 | **0** | 7 | **B 缺宿主**(有函数,无生产调用者) |
| `SET_ROOM_ACCESS` | 1 | **0** | 1 | **B 缺宿主** |
| `SET_PARTY_MODE` | 1 | **0** | 3 | **B 缺宿主** |
| `KICK_MEMBER` | 1 | **0** | 3 | **B 缺宿主** |
| `SET_MEMBER_ROLE` | 1 | **0** | 6 | **B 缺宿主** |
| `BREAK_BLOCK` | 0 | 0 | 0 | **C 宿主与调用者都缺** |
| `PICKUP_ITEM` | 0 | 0 | 0 | **C** |
| `DROP_ITEM` | 0 | 0 | 0 | **C** |
| `CRAFT` | 0 | 0 | 0 | **C** |
| `USE_ALCHEMY_FURNACE` | 0 | 0 | 0 | **C** |
| `OPEN_CHEST` | 0 | 0 | 0 | **C** |
| `USE_OWN_CHEST` | 0 | 0 | 0 | **C** |
| `RESET_WORLD` | 0 | 0 | 0 | **C** |
| `MODIFY_TOWN` | 0 | 0 | 0 | **C** |
| `BREED_TAME` | 0 | 0 | 0 | **C** |

```
统计:A 有宿主(缺经 action 的调用)  7 条
      B 有函数体但零生产调用者      5 条
      C 宿主与调用者都缺           10 条
      ────────────────────────────────
      合计                        22 条
```

### 4.2 ★ 一条关键发现:「有宿主」的 5 条,宿主是**死的**

`setMemberRole` / `kick` / `setAccess` / `setPartyModeBy` 在 `room.ts` 里
**实现完整**(有权限门、有业务校验、有落盘、有 `touch()`),但:

| 方法 | 定义 | 生产调用者 | 只有测试调 |
| :--- | :--- | :--- | ---: |
| `setMemberRole` | `room.ts:1182` | **0** | 6(`WS-07.test.ts:2473/2529/2573/2586/2589/2590`) |
| `kick` | `room.ts:1199` | **0** | 3(`WS-07.test.ts:2569/2588/2987`) |
| `setAccess` | `room.ts:1212` | **0** | 1(`WS-07.test.ts:2577`) |
| `setPartyModeBy` | `room.ts:1227` | **0** | 3(`WS-07.test.ts:2607/2609/4014`) |

⇒ **它们是「第 9 例测试全绿 + 生产零消费」家族的新成员**:
测试证明这 4 个功能完全可用,**而任何客户端都调不到它们**(没有报文入口)。
⇒ 这比「宿主不存在」更隐蔽:**宿主存在、测试充分、断言全绿**,只是没人接。
⇒ 接线时这 4 条**成本最低**(宿主现成),但**收益也最可疑** —— 见 §4.3 的 D 类问题。

### 4.3 承接方应该住哪个模块(逐条)

**★ 硬约束先立**(这决定了答案的形状):
```
docs/WS-11-coop-prank-party.md:743-746「禁用耦合」逐字:
  - 不 import `server/src/physics/**`、`server/src/combat/**`、`server/src/net/**`
    (避免循环依赖与 scope 越界)。
⇒ ★ **WS-11 模块不许 import `net/**`** ⇒ 执行层**不能**住在 party/prank/coop 里。
```
`scripts/verify.ts:1492-1496` 已记同一结论(它是 task-84 的接线依据):
> 接线方式(不是「import 一下」):`WorldSim` 慢帧新增 `tickPartyStep()`,
> 位置在 L3686 `this.tickLogisticsStep()` 之后 —— **照抄 `wiring/logistics.ts`
> 这个已成功摘出白名单的先例**。方向是 **sim → party 单向**:
> `docs/WS-11-coop-prank-party.md:745` 的「禁用耦合」不许 WS-11 模块 import `net/**`,
> 故驱动只能住在上游。

⇒ **成功先例的确切形状**(`logistics.ts`):
```
world_sim.ts:72   import { tickLogistics, … } from '../wiring/logistics.ts';
world_sim.ts:3415 private tickLogisticsStep(): void { … tickLogistics(line, this.armWorld(), …) }
world_sim.ts:4002 this.tickLogisticsStep();     ← 慢帧内被调
⇒ 驱动住 WorldSim(上游),被驱动者住自己的 WS 目录(下游),**单向 import**。
```

**逐条归属建议**(按上表分类):

| 类别 | 动作 | 承接方应住哪 | 理由 |
| :--- | :--- | :--- | :--- |
| **A 有宿主** | `MOVE`/`ATTACK` | `net/room.ts`(已有) | 已有 `applyMove`/`applyAttack`;`action` 通道对它们**语义重复**(已有专用报文) |
| **A 有宿主** | `PLACE_BLOCK`/`BREAK_BLOCK` | `build/grid.ts` + `build/` | `grid.ts:100 setObj` 是方块写的现有入口 |
| **A 有宿主** | `PLACE_AUTOMATION`/`WIRE_EDIT` | `wiring/graph.ts`(已有 `addComponent`/`addWire`) | 宿主现成;需权限门 |
| **A 有宿主** | `CLOSE_ROOM` | `net/room.ts:1093 close()`(已有) | 但注意:它已被 `onDispose` 占用,需区分「玩家主动关房」与「服务端释放」 |
| **A 有宿主** | `SLEEP` | `net/room.ts:1085 sleep()`(已有) | 同上,已由 `room.ts:1942` 空闲检测调用 ⇒ 需区分「玩家主动打盹」与「系统判定空闲」 |
| **B 有实现无调用** | `KICK_MEMBER`/`SET_MEMBER_ROLE`/`SET_ROOM_ACCESS`/`SET_PARTY_MODE` | `net/room.ts`(已有,`room.ts:1182-1235`) | **只需加 `action` 分派**,零新宿主 |
| **B 有实现无调用** | `START_PARTY` | `world_sim.ts:3497 startPartyRun()` + `party/modes.ts:161` | 宿主在 sim/party;**驱动同样须住上游**(`tickPartyStep` 已存在) |
| **C 无宿主** | `CRAFT`/`USE_ALCHEMY_FURNACE` | `alchemy/`(WS-06) | 该 WS 拥有炼金子系统 |
| **C 无宿主** | `OPEN_CHEST`/`USE_OWN_CHEST`/`PICKUP_ITEM`/`DROP_ITEM` | `net/room.ts` 的 `applyInventory`(已有)`room.ts:1397` | 背包已有执行体,**但「拾取/开箱进包」这条业务没写** |
| **C 无宿主** | `MODIFY_TOWN` | 需新建(城镇/图腾) | **归属未定** —— 见下 |
| **C 无宿主** | `RESET_WORLD` | 需新建(世界重置) | **归属未定** —— 见下 |
| **C 无宿主** | `BREED_TAME` | `mobs/behaviors.ts`(`TAMEABLE_AI_IDS` 等已在) | 驯服数据在 mobs,但**入口函数不存在** |

**★ 三个「归属未定」的,正是 `ARCH-GAPS.md:521` 登记的那个未决问题**:
> 「动作执行」到底归 WS-07 还是各子系统 WS?(本文结论:**失败模式归谁**比执行归谁更该定)

⇒ **我的判断**(与 ARCH-GAPS 同向,理由更具体):
```
执行体应当住在**拥有该子系统的 WS**(它有自己的状态与不变量);
而「报文 → 执行体」的**分派器**应当住在 net/(WS-07),
因为它要读 RoomRole 与 ACTION_PERMISSION —— 那是 net/ 的知识。

★ 但有一个必须显式定义的东西:**失败回执**(ARCH-GAPS 的「失败模式归谁」)。
  现在 `allowed=true` 时**零回执**;`allowed=false` 时回 `reject{kind:PERMISSION}`。
  ⇒ 接线后必须补第三种:`ok=false`(权限过了但业务失败,如「桥板不足」)
     —— 否则「权限不足」与「业务失败」在客户端**不可区分**,又是一次静默。
  ⇒ 这是本卡**最容易被漏掉**的一条,单列在 §6 的红线清单里。
```

---

## 5. 第三层:`room.colyseus.ts` **不能 import**(影响验收方式)

```
$ node -e "await import('./server/src/net/room.colyseus.ts')"
  ⇒ 不能 import:SyntaxError: Invalid or unexpected token

$ node -e "await import('./server/src/net/ws_server.ts')"
  ⇒ 能 import ✓
```
⇒ 与 `WS-07.test.ts:4065-4080` 的断言一致(依赖链上的
`schema.colyseus.ts` 有 **44 处生效装饰器**,Node strip-only 不解析)。

**⇒ 对本任务的意义(必须写进方案)**:任何「在 `room.colyseus.ts` 里加执行体」的接线,
**无法用运行时断言验证**(该文件加载不起来)⇒ 只能写**文本判据**
(如现有 `WS-07.test.ts:3916-3924` 那样)。
**⇒ 这解释了为什么「成功分支为空」从未被发现** —— ARCH-GAPS:252 说的是同一件事:
> **这才是「`action` 成功分支为空」从未被发现的结构性原因**

**★ 顺带一项实测**(它改变了「三条路」的说法):
```
server/src/net/ws_server.ts (725 行) **能 import**,且它是**零依赖薄 WebSocket 服务端**(task-69)
  但我核实了它的消息面:**它只处理 hello(握手)与二进制载荷的**转发占位**。
  L588-590 自己的注释:
    「★ 二进制 ⇒ 载荷已剥掉 tag(契约 §12.1:上行有 tag、下行没有)。
      (移动/攻击在 room 层;真接生产时在这里把 body 交给 decodePacket)。」
  ⇒ ★ 它**也没有 action 处理**。所以「第三条路」**不构成替代**。
```
⇒ 结论:**两条服务端路径(`room.colyseus.ts` / `ws_server.ts`)都没有动作执行层。**
本卡定性对两者都成立。

---

## 6. 第 3 步:接线会变红的断言(逐条 + 应改成什么)

### 6.1 ★ 注入实测(这是本步的证据,不是读出来的)

**INJ-91**:给 `action` 的成功分支加**一个真执行调用**(模拟「接线」):
```ts
      if (!gate.allowed) client.send('reject', { kind: 'PERMISSION', reason: gate.reason });
      else this.runtime.applyInventory(client.sessionId, { ops: [] }); /* INJ-91 */
```

**实测结果(单跑 `node tests/WS-07.test.ts`)**:
```
注入前:  [WS-07] 212/212 通过
注入后:  [WS-07] 210/212 通过        ← 恰好 2 条红

  ✗ task-38 【真缺陷】RoomAction 声明 22 个动作,生产只有 3 条通道能改变世界
      — action handler 除 authorize 外无其它 runtime 调用 ⇒ 授权后**没有执行者**
      (若不为 0,实际调用:applyInventory)  期望 0 / 实际 1

  ✗ task-38 【真缺陷】authorize 是**纯判定**:房主被允许全部 22 个动作,状态却零变化
      — action handler 只有 4 行代码(onMessage 头 / authorize / reject / 收尾)
      ⇒ 成功分支确为空(实际 5 行:…)  期望 4 / 实际 5
```

**门禁层面(`node scripts/verify.ts --all`)**:
```
注入前:  全部通过
注入后:  3 项失败
  ✗ 入口执行层登记失真(1 处):server/src/net/room.colyseus.ts::action
     (不再是该形态 —— 若已加成功执行,应移出登记并记为已修)
  ＋ 上面那 2 条测试
```

### 6.2 逐条清单 + 应改成什么

| # | 位置 | 原文(关键判据) | 接线后应改成 | 性质 |
| ---: | :--- | :--- | :--- | :--- |
| R1 | `tests/WS-07.test.ts:3918-3922` | `eq(otherCalls.length, 0, 'action handler 除 authorize 外无其它 runtime 调用 ⇒ 授权后**没有执行者**')` | 改成 `>= 1`,并把消息改为「除 authorize 外**有**执行分派」;同时把「实际调用」列表纳入断言(钉住**分派器存在**) | **必须改** |
| R2 | `tests/WS-07.test.ts:3923-3924` | `ok(!/else/.test(actionHandler), 'action handler 没有 else 分支 ⇒ allowed=true 时**静默返回**,连回执都没有')` | **反转**:`ok(/else\|dispatch/.test(actionHandler), '成功分支已存在')`;并新增「allowed=true 时**有回执**」断言 | **必须改** |
| R3 | `tests/WS-07.test.ts:3978-3980` | `eq(codeLines2.length, 4, 'action handler 只有 4 行代码 … ⇒ 成功分支确为空')` | **删掉行数断言**。行数是**形态代理**,接线后必然过时;改为断言**行为**(见下「应新增的」) | **必须改(建议删)** |
| R4 | `scripts/verify.ts:3604-3608` | `['server/src/net/room.colyseus.ts::action', { successPath: '**无** —— authorize 是纯查表函数…' }]` | 移出 `VERDICT_HANDLER_KNOWN`(门禁自己会报「登记失真」要求你移),并按 `attack` 的先例写一段**移出依据** | **必须改** |
| R5 | `tests/WS-07.test.ts:4040-4046` | `for (const missing of ['breedTame','startParty','beginPartyMode']) { ok(!new RegExp(...).test(roomSrc), 'room.ts 没有 ${missing}() ⇒ 该动作无执行者') }` | 若接线引入这些方法名 ⇒ 反转;若不引入(推荐住在 sim/party)⇒ **保留但改注释**(它守的是「room.ts 不承担这些业务」,那是**架构约束**,接线后仍成立) | **视方案而定** |
| R6 | `tests/WS-07.test.ts:3934-3935` | `eq(performing.length, 3, '能改变世界的通道恰好 3 条:move→applyMove, attack→applyAttack, inventory→applyInventory')` | 接线后变 **4**;把 `3` 改 `4` 并把 `action→<分派器名>` 加进 `performing` | **必须改** |
| R7 | `tests/WS-07.test.ts:3963-3964` | `eq(JSON.stringify(rt.cloneState()), before, 'authorize 无副作用(纯查表)')` | **保留不动**。它守的是「`authorize` 保持纯」,那是**正确的设计约束**;接线应加**新**方法而**不动** `authorize` | **不应改** |

**★ R3 的说明(我认为这条最值得单列)**:
```
行数断言(4 行)是**形态代理**。它现在能工作,是因为「无执行」恰好对应「4 行」。
接线后它必红,而正确的反应**不是**把 4 改成 N —— 那是「追着实现改断言」,
下次一装饰性改动又红。⇒ 应改成**行为判据**:
  「用假 client 发一次 action ⇒ 断言 runtime 的某个可观测量**变了**」
⇒ 这才是我在 task-84 报告里读到、并在 WS-11 里见到的那种「引用 ≠ 执行」的正确形态。
```

### 6.3 应**新增**的断言(接线时)

```
N1 ★ 「成功分支真的执行了」—— 不能只看「有 else」:
     假 client + OWNER 身份发 START_PARTY ⇒ 断言 sim.partyPhase() 由 IDLE 变 RUNNING
     (照 task-84 已立的口径:`rushRunningSec` 那种「跑了会变」的量,不是存在性)
N2 ★ 「业务失败 ≠ 权限失败」—— 这是 §4.3 那条最易漏的:
     发一个**权限通过但业务失败**的动作 ⇒ 断言收到**第三类回执** ok=false,
     且它**不等于** reject{kind:PERMISSION}
N3 「未登记动作」:发一个不在 RoomAction 里的字符串 ⇒ 断言被拒(不崩、不静默)
N4 「每个动作都有归宿」:遍历 22 个动作 ⇒ 断言每个要么执行、要么显式拒绝并回执
     —— **不允许「静默 allowed 然后什么都不发生」**。这条替代 R3 成为长期守卫。
```

---

## 7. 最小可运行闭环的定义

**必须项(缺任一条就不叫「闭环」)**:
```
M1 分派器存在:报文 action + userId + 载荷 → 找到该动作的执行体(或显式 UNSUPPORTED)
M2 权限门保留:先 authorize,拒绝时回 reject{kind:PERMISSION}(现有行为不变)
M3 ★ 三类回执齐备:ok=true / ok=false(业务失败) / reject(权限失败)
     ⇒ 现在只有第 3 类。缺 M3 的话「桥板不足」与「你不是管理员」在客户端看起来一样。
M4 至少一条动作端到端可证:用假 client 发 → 世界状态**真的变了**(可观测量)
M5 未接入的动作**显式拒绝**,不留静默分支
```
**可延后项(明确不算进闭环)**:
```
D1 shared/ 冻结层加「动作→执行体」映射表 —— 冻结层改动须 Lead 批(见 §8 风险)
D2 22 个动作全部接完 —— 本卡建议**先接 1 条走通形状**,再批量
D3 客户端侧发送能力(那是 task-67/client-stage 的写域,不是本卡)
D4 第三层(入口可跑性):room.colyseus.ts 的装饰器阻塞 —— 它让 M4 只能用文本判据
   或改用 ws_server.ts 路径验证。★ 这会影响 M4 的**验证方式**,但不阻塞实现。
```

---

## 8. 我建议的实现顺序(分片,每片独立可验收)

```
分片 1  分派器骨架 + 零动作 + 三条回执通道
        交付:net/ 里一个 dispatch(action, payload) 返回 {ok, reason};action handler 调它
        验收:★ 无行为变化 ⇒ 门禁应**仍全绿**(R1/R2/R3 都不该红)
             这是「先立骨架不动行为」—— 它证明骨架是**纯加**的
        风险:低

分片 2  接 B 类 5 条(宿主现成,零新宿主)
        SET_MEMBER_ROLE / KICK_MEMBER / SET_ROOM_ACCESS / SET_PARTY_MODE / START_PARTY
        验收:改 R1/R2/R4/R6;新增 N1(START_PARTY 真开局的**行为**断言)
        风险:★ START_PARTY 的宿主在 sim/party ⇒ 必须**上游驱动**
              (照 tickPartyStep 先例,不得让 party 模块 import net)

分片 3  接 A 类 7 条(有宿主,但语义可能与专用报文**重复**)
        MOVE/ATTACK 建议**不接** —— 它们已有专用报文,`action` 通道接它们会造成
        **两条路径写同一份状态**(W2「双写者」形态,本仓已多次记录该陷阱)
        ⇒ 建议在 ACTION_PERMISSION 或文档里标注「MOVE/ATTACK 走专用通道」
        验收:A 类逐条给出「接了/不接 + 理由」
        风险:中(双写者)

分片 4  接 C 类 10 条
        ⚠️ 这 10 条**要新建业务**,不是接线 ⇒ 建议**单独立卡**,
           不要塞进本卡的实现范围(否则本卡从「接线」变成「实现半个游戏」)
        风险:高
```

**★ 分片 1 是整个方案的关键**:它让「接线」这件事**可增量验收** ——
骨架先加、门禁不动,然后一片一片让红线翻转。
**若一次性接完再改断言,就没有「骨架是纯加的」这个证据了。**

---

## 9. 与本仓已有登记的对接(避免重复劳动)

```
ARCH-GAPS.md:104   「第二层:动作执行层 —— 权限层与执行层之间的**静默落差**」★ 已登记
ARCH-GAPS.md:120   「RoomAction **无分发器** — grep 全生产树 → 0」      ★ 已实测
ARCH-GAPS.md:933   「缺**动作 → 执行**的映射(目前不存在)」             ★ 已登记
ARCH-GAPS.md:509   「每个动作必须**要么有执行分支、要么显式拒绝并回执**」 ★ 已给出正确口径
ARCH-GAPS.md:521   「「动作执行」归谁**仍是未决**」                      ★ 见 §1.2 N1
verify.ts:3604     VERDICT_HANDLER_KNOWN 里 action 已登记为「无」
verify.ts:3532     attack 已移出(先例:移出时**附可复核证据**)
WS-07.test.ts:3903/3941/4025  task-38 三条断言已钉住现状
```

**⇒ 本卡**没有**新发现「第二层存在」这件事(它早已登记)。
**本卡的增量**是:
```
1 22 个动作**逐个**的 A/A′/C 实测分类(此前只有「22 个」这个总数)
2 ★ 「0 个接了」而非「18 个没接」—— 通道层是 C,动作层全是 B
3 ★ 「有宿主但零生产调用者」的 5 条(第 9 例家族新成员,测试全绿而调不到)
4 ★ 接线即红 = **恰好 2 条断言 + 1 条门禁**(注入实测,不是读的)
5 ★ R3「行数断言是形态代理,应改成行为判据」
6 ★ M3「三类回执」——`ok=false` 缺失会让「业务失败」与「权限失败」不可区分
7 ★ ws_server.ts **也没有** action 处理 ⇒ 「第三条路」不构成替代
8 ★ MOVE/ATTACK 建议**不接**(双写者风险)
```

---

## 10. 我留下的临时文件(逐名)

**我创建的探针(已全部删除,零残留)**:
```
_t91_a.ts  _t91_b.ts  _t91_c.ts  _t91_d.ts  _t91_e.ts  _t91_f.ts  _t91_g.ts
_t91_h.ts  _t91_i.ts  _t91_j.ts  _t91_k.ts  _t91_l.ts  _t91_inj.ts  _t91_final.ts
（均位于仓库根;用 `write` 创建,按**全名**逐个 `Remove-Item`,未用通配符)
```
**核实**:
```
$ Get-ChildItem -Filter "_t91*" -File
  (空)
$ git status --porcelain -- server/src/net/room.colyseus.ts
  (空)  ⇒ 注入已还原,SHA-256 与注入前逐字节一致
  ✓ 91A468FC9BEAAD0BE0EF2A74C5AE5AFB8FD3B68B187994D25B27DA10F082B8B1
$ Remove-Item "$env:TEMP\rc_backup.ts"
```

**★ 仓库里**别人**的残留(我**没有**删,按**前缀**列出给 Lead 决策)**:

> ⚠️ **我不给精确个数** —— 我有意为之。9:55 与 10:03 两次采样,
> `_t84*` 从 45 变到 90、`_tp89_*` 从 5 变到 35、`scripts/` 下的 6 个从「在」变到「无」。
> **队友仍在并发写**,任何写死的数字在提交后即过期。
> 下面只给**归属前缀**,归属依据 = 前缀命名与各人任务号的自述一致。

```
前缀            归属(依据)                              时间窗
_t84*.ts        build-wiring 的 task-84(WS-11 缺口 A)    8:56–9:58
_t85_*.ts       net-persist 的 task-85(US2 接线)         9:33–9:54
_t87_*.ts       net-persist 的 task-87                    9:44–9:57
_tp89_*.ts      task-89 相关                              9:43–10:01
_ic_q*.ts       task-89 / inj-ctrl 相关(Q1–Q5)           9:55–10:01
_mb_t86*.ts     mob-boss-ai 的 task-86                    9:40–9:44
_den.ts         未知(未读内容,不推测归属)
（另有一批同名 *_out.txt / *_console.txt,是上面那些探针的输出重定向)
```

**★ 一条实测(与 Lead 的 `clean-temp.ts` 防线直接相关)**:
```
10:03 采样:`scripts/` 下的 `_*` 文件 = **0 个**
  ⇒ 9:55 时那里还有 6 个(`_m16.txt` / `_nc_load*.ts` / `_nc_pkg.ts` /
    `_nc_pure.ts` / `_nc_tables.ts`)
  ⇒ 说明**有人已经清掉了**,或者它们被移出了 `scripts/`
  ⇒ ★ 结论:**残留是动态的,不是静态欠账**。门禁的「只告警不拦截」
    设计因此是对的 —— 它每次跑都报**当次**事实,而写死的清单会立刻过期。
  ⇒ 同时说明:**「审计扫描根内不得有临时脚本」这条纪律正在被有效执行**。
```

---

## 11. 未做项 + 理由

| 未做 | 理由 |
| :--- | :--- |
| 未改任何 `server/**` / `tests/**` | 本卡写域只含本文件;Lead 明示「先出方案,等我批」 |
| 未接任何一条动作 | 同上;且 §8 分片 1 必须先立骨架 |
| 未判 D 类(「不该接」) | 见 §1.2 N3:我**没有判据**区分「设计上不该由客户端发起」与「漏了」。ARCH-GAPS:521 把该问题登记为未决,**不应由我单方面裁决** |
| 未验证 22 个动作与手册动作需求是否一一对应 | 见 §1.2 N4 |
| 未在 `room.colyseus.ts` 上做**行为**验证 | 它 import 不起来(§5);该层的行为验证需要先解第三层,或改用 `ws_server.ts` 路径 |
| 未评估 `shared/` 冻结层是否需要加「动作→执行体」表 | 见 §7 D1:冻结层改动须 Lead 批,**不动** |

---

## 12. 一句话给下一个执行者

> **不要从「接哪 18 个动作」开始 —— 从「立分派器骨架 + 三类回执」开始。**
> 因为**通道层是 C(连分流都不存在)**,动作层的 A/B/C 分类只在
> **分派器存在之后**才有意义。先立骨架(门禁应仍全绿),再一片一片翻红线。
> **并且:MOVE/ATTACK 建议不接(双写者),C 类 10 条要新建业务、应单独立卡。**
