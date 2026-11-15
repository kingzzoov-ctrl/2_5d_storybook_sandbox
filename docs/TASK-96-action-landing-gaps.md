# TASK-96 动作执行层:**未接线的 17 个 `RoomAction` 各自缺什么**

> 判据来源:`docs/COMPLETION-CRITERIA.md` 档 B 的
> 「22 个 `RoomAction` 中,**该有执行层的那些**真的执行」。
>
> 本文回答的是那句里的**「那些」**:逐个动作说明它**有没有执行层**、
> 以及**没有的话缺什么**。`tests/WS-FND-18` 会读本文件核对:
> 「未接线的动作集合 ⊆ 本文列出的动作」,漏写一个就红。
>
> ⚠️ 本文**不是**待办清单的替代品:「缺什么」写的是**具体到机制**的缺口,
> 不是「TODO」。三条判据写在 `server/src/net/room.ts` 的 `dispatchAction` 上:
> ① 已接的直接调宿主方法并把返回值翻译成回执;
> ② 未接的**显式** `kind:'NOT_IMPLEMENTED'` + 理由(消灭静默成功);
> ③ `OK` 必须带 `effect`。

## 已接线(19 / 22)

| 动作 | 落点 | 说明 |
|---|---|---|
| `SET_MEMBER_ROLE` | `RoomRuntime.setMemberRole()` | 自带 `authorize` 闸 |
| `KICK_MEMBER` | `RoomRuntime.kick()` | 自带闸 |
| `SET_ROOM_ACCESS` | `RoomRuntime.setAccess()` | 自带闸 |
| `SET_PARTY_MODE` | `RoomRuntime.setPartyModeBy()` | 自带闸 |
| `CLOSE_ROOM` | `RoomRuntime.close()` | ★ 例外:`close()` 是生命周期方法(还被 `onDispose` / `reapEvictions` 调用)⇒ **不能**自带闸,闸写在 `dispatchAction` 里 |

### 一之二、**物质层**(2026-11-14 接线,4 个)

这四个是「建造 / 拆掉 / 丢下 / 捡起」这条最基本闭环的全部。接线前它们
显式 `NOT_IMPLEMENTED` —— 世界里没有玩家改过的格,背包里的数字也只能从别处来。

| 动作 | 落点 | 说明 |
|---|---|---|
| `PLACE_BLOCK` | `WorldSim.placeBlock()` + `RoomRuntime.applyInventory` | 判世界内 / 该格空 / 该格无实体;扣背包**失败即拒**,世界拒绝则**退回**那一件 |
| `BREAK_BLOCK` | `WorldSim.breakBlock()` + 掉落凭证 | 拆下来的 obj 作为掉落物进背包;背包满则**落回原地**(不凭空销毁) |
| `DROP_ITEM` | `WorldSim.dropItem()` | 落点取**权威位置**,不取客户端报的坐标 |
| `PICKUP_ITEM` | `WorldSim.takeGroundItemNear()` | **先扣地面再进背包**(反过来会造复制品);附近没有就拒 |

四条共同的三点纪律(**都写在 `dispatchAction` 里,不在网络层分叉**):
1 权限闸在这里(世界方法没有"谁"这个参数 —— 与 `CLOSE_ROOM` 同一例外);
2 背包增减一律走 `applyInventory`(总量守恒 + 凭证链都在那条路上);
3 产出侧先 `grantItemSource`,否则被反作弊按"凭空产出"拒 —— 那是设计好的闸。
`docs/TASK-94-action-layer-landing-plan.md` 已实测:这 4 个在全仓**不存在**任何可复用的方法。
判据:`tests/WS-FND-20-material-loop.test.ts`(11 条,双侧账 + 退回 + 守恒)、
`tests/WS-FND-21-action-e2e.test.ts`(5 条,**真 socket** 端到端:发 → 执行 → 回执 + 世界变了)。

### 二之二、**容器 / 合成 / 睡觉**(2026-11-15 接线,4 个)

| 动作 | 落点 | 说明 |
|---|---|---|
| `CRAFT` | `actions/craft.ts` + 内容层 `matchRecipeByTags` | 通用合成:配方**只从内容层读**(不新增配方表);扣料 → 给产物,产物收不下则**退回材料** |
| `SLEEP` | `actions/sleep.ts` | 只登记「谁在睡、睡到何时」(per-room Map);卧室判定复用 `rooms/effects.ts` |
| `OPEN_CHEST` | `actions/open_chest.ts` | 公共箱:同房间**共享**一份内容 |
| `USE_OWN_CHEST` | `actions/use_own_chest.ts` | 私有抽屉:按 playerId 隔离(与公共箱同一套事务引擎) |

⚠️ 三条**如实边界**(都写进各文件头与各自套件,不要当成已实现):
1 箱子内容**不在 wire 上** ⇒ 客户端**看不到**箱内(只有 `OPEN_CHEST` 的只读回执带 `effect.stacks`);
2 箱子内容**不持久化**(进程内 Map,房间重建即空);
3 `SLEEP` 只登记状态,**世界侧还没有读者** ⇒ 现在"站进卧室照旧回血"与是否 dispatch 过 `SLEEP` **无关**。

判据:`tests/WS-FND-25-craft.test.ts`(8 条)、`WS-FND-26-sleep.test.ts`(6 条)、`WS-FND-27-chests.test.ts`(7 条)。

### 二之三、**派对 / 驯养 / 城镇 / 炼金**(2026-11-15 接线,4 个)

| 动作 | 落点 | 说明 |
|---|---|---|
| `START_PARTY` | `actions/start_party.ts` | 开局/计分/结算状态机(per-room Map + 可注入时钟);模式**只读**房间已选模式,不写第二份真值 |
| `BREED_TAME` | `actions/breed_tame.ts` | 投喂/驯服/繁殖(**`payload.op` 分支**);宠物是**本模块的记录**,不是世界里的生物实体 |
| `MODIFY_TOWN` | `actions/modify_town.ts` | 城镇配置登记 + `town` 权限裁决;**没有世界侧读者** ⇒ 刷怪/安全区行为一点没变 |
| `USE_ALCHEMY_FURNACE` | `actions/use_alchemy_furnace.ts` | 站上炼金台 + 内容层配方;**本地确定性实现**(LLM 自由炼金不在本轮) |

⚠️ 新增四条边界(同样**不计入达成**):
1 `BREED_TAME` 的宠物**不是真生物实体**(不写 `WildlifeState`,世界/AI 不知道它被驯服);
2 `MODIFY_TOWN` 的改造**没有世界侧读者**(`spawner.ts` 仍读常量 `TOWN_SAFE_RADIUS`);
3 `START_PARTY` 的赛局**没有接到慢帧去真的计分**,也不落库;
4 `USE_ALCHEMY_FURNACE` 的站位读口(`lastRoomEffects[].roomKey`)**不在 `WorldSaveHost` 契约里**,有最多 0.5 s 慢帧延迟。

判据:`WS-FND-28-party`(7)、`WS-FND-29-tame`(10)、`WS-FND-30-town`(8)、`WS-FND-31-alchemy`(8)。

### 二之四、**自动化放置 / 布线编辑**(2026-11-15 接线,2 个)

| 动作 | 落点 | 说明 |
|---|---|---|
| `PLACE_AUTOMATION` | `actions/place_automation.ts` | 落一件自动化件到空格子;种类合法性**只问** `hasComponentKind`(不自造名单),组件规格取自 `wiring/components.ts` |
| `WIRE_EDIT` | `actions/wire_edit.ts` | 接/断一条导线;颜色域取 `ALL_COLORS`、通道域取 `CHANNEL_MIN..MAX`、方向域取 `DIR_VECTORS.length`(**三处都是 import 来的既有表**) |

⚠️ 两条边界(**不计入达成**):
1 两者**都不创建/修改世界实体**,也不写 `wiring/graph.ts` 的图 ⇒ 「放下去就通电」「接上就导通」**都不存在**;
2 `WIRE_EDIT` **不下发任何报文** ⇒ `build/wiring_view.ts` 仍拿不到这份数据(还缺 WireView 下发报文 + 铺线 UI 面板)。

判据:`WS-FND-32-automation`(8)、`WS-FND-33-wire`(7)。

## 未接线(3 / 22)

### 一、**有专用报文通道**、但**不走 `action` 通道**(2 个)

| 动作 | 现状 | 说明 |
|---|---|---|
| `MOVE` | ✅ **真的执行**(经 `onMessage('move')` → `RoomRuntime.applyMove()` → `WorldSim.applyPlayerMove`) | 不走 `action` 是为了保住坐标契约:反作弊 `checkMove` 判的是「绝对位置 + tick」,而 `action` 的泛型 payload 不带这个语义。⇒ `dispatchAction('MOVE')` 返回 `NOT_IMPLEMENTED` 是**刻意**的,表示「别从这里发」 |
| `ATTACK` | ✅ **真的执行**(经 `onMessage('attack')` → `RoomRuntime.applyAttack()` → `WorldSim.attackMobAuthorized`) | 同上。结算值经 `attackResult` 回执 |

> ⚠️ 这两个的「已执行」由 `tests/WS-07` / `WS-10` 的行为断言钉住,
> 不在本文的"缺什么"范围内 —— 但**必须写在这里**,否则读者会以为它们也缺。

### 二、**仓库里完全没有落地点**(1 个)

`docs/TASK-94-action-layer-landing-plan.md` 已实测:这 1 个在全仓**不存在**任何可复用的方法。

| 动作 | 缺什么 |
|---|---|
| `RESET_WORLD` | 无世界重置入口(需要:重建 `WorldSim` + 保留/清除存档的裁决 + 通知所有客户端重新握手) |


## 这张表怎么被维持

```
tests/WS-FND-18
  FND18-1  22 个动作必须由 dispatchAction 逐个归类(不交、不重、全覆盖)
  FND18-2  未接线的必须显式 NOT_IMPLEMENTED + reason 非空 + **出现在本文件里**
  FND18-3  已接线的回 OK 时必须带 effect(不留"回 OK 却无副作用")
  FND18-4  越权必须先被权限闸拦下(类别为 PERMISSION,不是 INVALID/NOT_IMPLEMENTED)
```

⇒ 新增一个动作而不作决定、或把某个未接动作悄悄改成"成功",
**都会当场红**;而「该不该接」仍是产品裁决,不是测试能替的。
