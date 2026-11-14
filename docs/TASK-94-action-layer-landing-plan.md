# TASK-94 · 动作执行层「施工落点清单」(2026-11-14)

> 本文是 `docs/TASK-91-action-layer-audit.md`(审计)的**施工侧**补件。
> TASK-91 回答「缺什么」;本文回答「**每一步改哪个文件的哪一行**」。
> **本文所有 `path:line` 都是本次实测核对过的**,不是从别的文档抄的。

> ⚠️ **行号口径**:本文所有 `path:line` 是 2026-11-14 **接手者编辑 `scripts/verify.ts` 之后**实测的
> (同一轮给该文件加了 1 行 import 与一个 `checkCountAudit()` 函数 ⇒ 其后的行号整体偏移);
> 若日后对不上,**请按文中给出的符号名 Grep**,不要据行号判断"这里没有"。
> 引用的原件语句保持原样。

---

## 一、结论先说(三句)

```
1 RoomAction 有 22 个动作,handler 的**成功分支为空** ⇒ "授权存在、执行不存在"且失败静默。
2 但**不是 22 个都要新写执行器** —— 其中 5 个的宿主方法**已经存在且已可达**,
  接线不需要新增任何业务逻辑、不改可达性数字(88/98)、不动承重文件。
3 剩下的 17 个里,**有 6 个在仓库里根本不存在落点**(BREAK_BLOCK / DROP_ITEM /
   OPEN_CHEST / USE_OWN_CHEST / RESET_WORLD / MODIFY_TOWN)⇒ 不是接线问题,是功能缺口。
```

---

## 二、缺口本体(逐字引用)

### 2.1 `RoomAction` 的形态与 22 个成员

`server/src/net/room.ts:97` → `room.ts:120`,形态是 **`as const` 常量对象**,不是 union / 数组 / interface:

```ts
export const RoomAction = {
```

`room.ts:121`:

```ts
export type RoomAction = (typeof RoomAction)[keyof typeof RoomAction];
```

22 个成员(**逐条实测行号**):

| # | 成员 | 行 | # | 成员 | 行 |
|---|---|---|---|---|---|
| 1 | `MOVE` | 98 | 12 | `START_PARTY` | 109 |
| 2 | `ATTACK` | 99 | 13 | `SET_ROOM_ACCESS` | 110 |
| 3 | `PLACE_BLOCK` | 100 | 14 | `SET_PARTY_MODE` | 111 |
| 4 | `BREAK_BLOCK` | 101 | 15 | `KICK_MEMBER` | 112 |
| 5 | `PICKUP_ITEM` | 102 | 16 | `SET_MEMBER_ROLE` | 113 |
| 6 | `DROP_ITEM` | 103 | 17 | `RESET_WORLD` | 114 |
| 7 | `CRAFT` | 104 | 18 | `CLOSE_ROOM` | 115 |
| 8 | `USE_ALCHEMY_FURNACE` | 105 | 19 | `MODIFY_TOWN` | 116 |
| 9 | `OPEN_CHEST` | 106 | 20 | `PLACE_AUTOMATION` | 117 |
| 10 | `USE_OWN_CHEST` | 107 | 21 | `WIRE_EDIT` | 118 |
| 11 | `SLEEP` | 108 | 22 | `BREED_TAME` | 119 |

### 2.2 静默失败点(`server/src/net/room.colyseus.ts:328-331`,socket 事件名 `'action'`)

```ts
    this.onMessage('action', (client, msg: { action: Parameters<RoomRuntime['authorize']>[1] }) => {
      const gate = this.runtime.authorize(client.sessionId, msg.action);
      if (!gate.allowed) client.send('reject', { kind: 'PERMISSION', reason: gate.reason });
    });
```

「成功分支为空」的**精确形态**:没有 `else`,且 `L330` 的单行 `if` 与 `});` 之间**没有任何语句**
⇒ `allowed === true` 时直接返回:**零执行、零回执、零日志**。
(不是"空 `if` 体"——那个形态会被 `verify.ts` 的入口执行层门禁查出来。)

旁证:`tests/WS-07.test.ts:3921-3925`、`:3978-3980`、`scripts/verify.ts:3698`(VERDICT_HANDLER_KNOWN)。

### 2.3 ★ 另一条**未被 ADR 记录**的事实:`registerHandlers()` **全仓 0 调用点**

```
server/src/net/room.colyseus.ts:279   private registerHandlers(): void {
全仓 grep `registerHandlers` ⇒ 命中 1 处,就是这一行声明;
tests/**、server/src/** 里**没有任何调用点**。
```

⇒ 即使 `room.colyseus.ts` 变得可加载(见 TASK-95),**这 4 条 handler 也不会被注册**。
⇒ 判据:**「入口不可加载」与「入口可加载但没人初始化」是两个独立的缺口**,
   只修前者不会让玩家按得动。本文把它列为**前置 B**。

---

## 三、22 个落点逐条(实测核实)

图例:`✓ 已存在` = 方法现在就在仓库里;`+ 需新增` = 全仓无此业务,要写。

| # | 动作 | 落点 | 状态 |
|---|---|---|---|
| 1 | `MOVE` | `room.ts:1278 applyMove(userId, intent): Verdict` → `world_sim.ts:2333 applyPlayerMove` | ✓ 已存在(**勿接**:已有专用报文,双写者) |
| 2 | `ATTACK` | `room.ts:1339 applyAttack(userId, claimedBonus=0, mobId?)` → `world_sim.ts:1540 attackMobAuthorized` | ✓ 已存在(**勿接**:同上) |
| 3 | `PLACE_BLOCK` | 权威写口 `world_sim.ts:990 setCell(x, y, Partial<TileFields>)`;既有生产者 `world_sim.ts:958 placeObj`、`:1228` | ✓ 底层在,但**无「玩家放块」薄入口** |
| 4 | `BREAK_BLOCK` | 全仓**无** `removeObj` / `breakBlock`(只能复用 `setCell({obj:0})`) | + 需新增 |
| 5 | `PICKUP_ITEM` | `world_sim.ts:1456 consumeGroundItem(itemId, count): number`;背包侧 `room.ts:1397 applyInventory` / `:1438 grantItemSource` | 两半都在,**「地面→背包」的拼装不存在** |
| 6 | `DROP_ITEM` | `WorldSim` **无**公开 spawnItem(唯一写入是私有闭包 `world_sim.ts:961`) | + 需新增 |
| 7 | `CRAFT` | 无通用合成;最近的是 `combat/cooking.ts:428 tryCook` / `:273 cookSoup`,且 `world_sim.ts:3724 tryCookAt` 是私有 | + 需新增 |
| 8 | `USE_ALCHEMY_FURNACE` | `world_sim.ts:1365 async forgeAlchemy(itemIds, opts)`(底层 `alchemy/index.ts:274 createAlchemyService` / `:266 forge`) | ✓ 已存在(**生产调用点 0**) |
| 9 | `OPEN_CHEST` | 全 `server/src` **无容器**概念(只有 `wiring/components.ts:187 SENSOR_CHEST_FULL` 这个信号名) | + 需新增 |
| 10 | `USE_OWN_CHEST` | 同上 | + 需新增 |
| 11 | `SLEEP` | `room.ts:1897 setAfk(userId, afk)` + `world_sim.ts:3568 setPlayerDozing(playerId, atSec)` | ✓ 已存在。⚠️**勿用** `room.ts:1085 sleep()` —— 那是**房间休眠**,由 `room.ts:1934 checkIdleSleep` 调 |
| 12 | `START_PARTY` | `world_sim.ts:3497 startPartyRun(key, refereeId): boolean` | ✓ 已存在(**生产调用点 0**) |
| 13 | `SET_ROOM_ACCESS` | `room.ts:1212 setAccess(actorId, mode, passwordHash)` | ✓ 已存在(**0 调用**) |
| 14 | `SET_PARTY_MODE` | `room.ts:1227 setPartyModeBy(actorId, mode)` | ✓ 已存在(**0 调用**) |
| 15 | `KICK_MEMBER` | `room.ts:1199 kick(actorId, targetId)` | ✓ 已存在(**0 调用**) |
| 16 | `SET_MEMBER_ROLE` | `room.ts:1182 setMemberRole(actorId, targetId, role)` | ✓ 已存在(**0 调用**) |
| 17 | `RESET_WORLD` | 全仓无(唯一的 `reset()` 是 `combat/progression.ts:300` 的 KillLedger,无关) | + 需新增 |
| 18 | `CLOSE_ROOM` | `room.ts:1093 close(): boolean`;现有调用者 `room.colyseus.ts:240`(onDispose)、`room.ts:2122`(reapEvictions) | ✓ 已存在 |
| 19 | `MODIFY_TOWN` | 全仓无(城镇只读:`mobs/spawner.ts:88 townCenter()`、`bosses/raid.ts:98`、`world_sim.ts:3832`) | + 需新增 |
| 20 | `PLACE_AUTOMATION` | `wiring/graph.ts:343 addComponent(node)`;可达句柄 `world_sim.ts:460 readonly wiring: SignalGraph` | ✓ 已存在(生产调用点仅 `sim/demo.ts:37`) |
| 21 | `WIRE_EDIT` | `wiring/graph.ts:266 addWire(x,y,color)` / `:276 removeWire`;`world_sim.ts:1252 addWireDrive` | ✓ 已存在(生产调用点仅 `sim/demo.ts:36`) |
| 22 | `BREED_TAME` | `mobs/taming.ts:118 feedPet` / `:92 createPetRecord` / `:85 canTame` | 半成品:该文件**本身不可达**且**无宠物容器** ⇒ 需新增宿主 |

**分类合计**:`✓ 已存在` **11 条** · `+ 需新增` **6 条**(4/6/9/10/17/19)· **拼装或宿主缺失** **5 条**(3/5/7/11 已完成但缺编排;22 缺宿主)。
⚠️ 这个"11"里**包含 MOVE / ATTACK 两条不该接的**(它们已有专用报文)⇒ **真正可接的是 9 条**。

---

## 四、★ 为什么第二层被第一层卡住(不是"对象不存在",是"装配路不通")

handler 作用域里**能拿到什么**(实测):

```
this            = NetPersistRoom        room.colyseus.ts:138-141
this.runtime    = RoomRuntime           room.ts:771
                  可用成员:state:775  status:776  accessMode:777  partyMode:780
                            ac:781  members:782  db:786
                            worldSaveHost: WorldSaveHost | null  :793 / :837
this.deps       = NetPersistRoomOptions room.colyseus.ts:51-126(host? 在 :125)
client.sessionId / msg = { action }
```

**`WorldSim` 在这个作用域里不可见**,四条独立证据:

```
(a) room.colyseus.ts:19-24 的 import 面里**没有**模拟层;`WorldSim` 只出现在注释 :97。
(b) tests/WS-07.test.ts:4364-4378(K6)断言 room.ts / room.colyseus.ts 的**代码态**
    不含 /WorldSim|world_sim/ —— 即"net 层不许认识 WorldSim"是被测试钉住的设计。
(c) 唯一把手是结构化窄接口 `WorldSaveHost`(room.ts:353-607),它只暴露
    saveToDb / attackMobAuthorized / levelOf? / applyPlayerMove? / addPlayer? / removePlayer? …
    **没有**方块 / 炼金 / 派对 / 布线 / 驯服。
(d) `room.colyseus.ts:204` 的 host 生产恒 null;`withDeps`(:213)全仓 **0 调用点**
    (tests/WS-FND-12-wiring-paths.test.ts:84-102 把这条钉住)。
    真正 `new WorldSim` 的只有 server/src/index.ts:201-207 createHost() → :239 host
    → :242 new RoomRuntime —— 而**那条路径不拥有 action handler**。
```

⇒ 要接动作,**必须先裁决「谁是玩家状态的唯一所有者」**(ARCH-GAPS 第五层),
  而不是先写 22 个执行器。这是本文与 TASK-91 的**共同结论**。

---

## 五、★ 最小可验证切口(建议的第一步)

**接这 5 个,全部满足:宿主方法已存在 · 纯 `RoomRuntime` · 零新依赖 · 不改可达性(88/98)**

| 动作 | 落点 | 现状 |
|---|---|---|
| `SET_MEMBER_ROLE` | `room.ts:1182` | 0 调用 |
| `KICK_MEMBER` | `room.ts:1199` | 0 调用 |
| `SET_ROOM_ACCESS` | `room.ts:1212` | 0 调用 |
| `SET_PARTY_MODE` | `room.ts:1227` | 0 调用 |
| `CLOSE_ROOM` | `room.ts:1093` | 已有 2 个调用者,加第 3 个安全 |

**落点位置**:新分派器**住在 `RoomRuntime`**(不放 `room.colyseus.ts`)——
因为后者不可加载、零测试可覆盖(TASK-95),而 `RoomRuntime` 现在就被 `tests/WS-07.test.ts` 直接驱动。

**测试落点**:`tests/WS-07.test.ts`(已 `import { RoomAction }` :144;已有 F09/F12/F14/F15/F17 于
`:2473` / `:2529` / `:2563-2580` / `:2586-2590` / `:2603-2611`)。

**断言必须走新分派器的行为**,不能断言 handler 内部:
```
rt.members.get('m')?.role === ADMIN      // SET_MEMBER_ROLE
rt.members.has('m') === false            // KICK_MEMBER
rt.accessMode === …                      // SET_ROOM_ACCESS
rt.partyMode === …                       // SET_PARTY_MODE
rt.status === CLOSED                     // CLOSE_ROOM
+ 负对照:GUEST 身份执行同一动作 ⇒ 状态零变化
+ 第三类回执:ok=false 时**必须**有可观测后果(否则又造一个新的静默失败)
```

**接线会立刻撞红的既有断言(必须同步改,这是"接线即红"而非"接线失败")**:
```
tests/WS-07.test.ts:3921-3923 / :3924-3925 / :3935-3936 / :3978-3980 / :4044-4047
scripts/verify.ts:3698 起(VERDICT_HANDLER_KNOWN 注册表)→ :4139 会报「入口执行层登记失真」
```
⇒ 这 6 处的**共同含义**是「handler 的成功路径为空」是**被登记的既定事实**。
  接上执行 ⇒ 那段登记必须改写(它自己就写着「若已加成功执行,应移出登记并记为已修」)。

---

## 六、可达性影响(实测复算)

```
PROD_ENTRIES            = scripts/verify.ts:1141-1209,共 5 个入口:
                          sim/ws_demo.ts:1172 · index.ts:1188 · sim/demo.ts:1189
                          · net/room.colyseus.ts:1190 · client/src/main.ts:1208
UNREACHABLE_EXEMPT      = scripts/verify.ts:1336-1616,共 10 条
复算(复用 scripts/imports.ts 同口径)⇒ 共 98 / 可达 88 / 不可达 10
README.md:64 当前值 88/98 ✓ 一致
```

**接第五节那 5 个动作 ⇒ 数字不变(88/98)**,因为 `room.ts` / `room.colyseus.ts` 本就在闭包内。

**唯一会改数的落点**:`BREED_TAME` 若 import `mobs/taming.ts`
⇒ 可达 88 → **89** / 不可达 10 → **9**,且必须同时:
1 摘掉 `verify.ts:1555` 的白名单条目;2 改 `README.md:64`;
3 注意 `scripts/count-audit.ts` 会解析白名单条数(`:59-62` / `:94-96`)⇒ 它会先报出来。

⚠️ `build/wiring_view.ts` 那条**不应**因此变可达 —— 理由见 `verify.ts:1407-1412`(服务端根本不该接它)。

---

## 七、本文**不能证明**的

```
1 第三节的「状态」列是**静态可达性 + 方法存在性**,不是"接上就行为正确"。
  5 个动作接上后的**语义**(谁能踢谁、角色权限矩阵)本文未定义。
2 「handler 作用域里 WorldSim 不可见」的证据是**四条例证**,不是一次运行时观测
  (该模块当前不可加载 ⇒ 运行时观测**做不到**,这本身是 TASK-95 的后果)。
3 我没有改动任何代码。本文是**施工清单**,实施需单独立项(且应先裁决第五层)。
```