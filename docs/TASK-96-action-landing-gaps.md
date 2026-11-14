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

## 已接线(5 / 22)

| 动作 | 落点 | 说明 |
|---|---|---|
| `SET_MEMBER_ROLE` | `RoomRuntime.setMemberRole()` | 自带 `authorize` 闸 |
| `KICK_MEMBER` | `RoomRuntime.kick()` | 自带闸 |
| `SET_ROOM_ACCESS` | `RoomRuntime.setAccess()` | 自带闸 |
| `SET_PARTY_MODE` | `RoomRuntime.setPartyModeBy()` | 自带闸 |
| `CLOSE_ROOM` | `RoomRuntime.close()` | ★ 例外:`close()` 是生命周期方法(还被 `onDispose` / `reapEvictions` 调用)⇒ **不能**自带闸,闸写在 `dispatchAction` 里 |

## 未接线(17 / 22)

### 一、**有专用报文通道**、但**不走 `action` 通道**(2 个)

| 动作 | 现状 | 说明 |
|---|---|---|
| `MOVE` | ✅ **真的执行**(经 `onMessage('move')` → `RoomRuntime.applyMove()` → `WorldSim.applyPlayerMove`) | 不走 `action` 是为了保住坐标契约:反作弊 `checkMove` 判的是「绝对位置 + tick」,而 `action` 的泛型 payload 不带这个语义。⇒ `dispatchAction('MOVE')` 返回 `NOT_IMPLEMENTED` 是**刻意**的,表示「别从这里发」 |
| `ATTACK` | ✅ **真的执行**(经 `onMessage('attack')` → `RoomRuntime.applyAttack()` → `WorldSim.attackMobAuthorized`) | 同上。结算值经 `attackResult` 回执 |

> ⚠️ 这两个的「已执行」由 `tests/WS-07` / `WS-10` 的行为断言钉住,
> 不在本文的"缺什么"范围内 —— 但**必须写在这里**,否则读者会以为它们也缺。

### 二、**仓库里完全没有落地点**(6 个)

`docs/TASK-94-action-layer-landing-plan.md` 已实测:这 6 个在全仓**不存在**任何可复用的方法。

| 动作 | 缺什么 |
|---|---|
| `BREAK_BLOCK` | 无 `removeObj` / `breakBlock` 这类方法。只能退化成 `setCell({obj: 0})`,而那是**底层写口**、不带玩家语义(不掉落、不记归属、不触发事件) |
| `DROP_ITEM` | 无「把背包物品放到地面」的入口。`applyInventory` 只改**总数量差值**,不产生地面实体(`GroundItem`) |
| `OPEN_CHEST` | 无公共储物箱实体与其内容物模型(手册的公共箱是**共享**模型,与 `USE_OWN_CHEST` 不同) |
| `USE_OWN_CHEST` | 无「按玩家自己的箱子」的容器;`RoomRuntime` 只有背包总数与容量 |
| `RESET_WORLD` | 无世界重置入口(需要:重建 `WorldSim` + 保留/清除存档的裁决 + 通知所有客户端重新握手) |
| `MODIFY_TOWN` | 无城镇安全区 / 图腾实体,也无"谁有权改"的裁决 |

### 三、**有相邻机制、但缺中间一环**(9 个)

| 动作 | 缺什么 |
|---|---|
| `PLACE_BLOCK` | 底层有 `WorldSim.setCell()` / `placeObj()`,但**没有「玩家放块」的薄入口**:缺①与物品消耗的绑定(放一块要扣一件)②与 `build` 权限位的连接③重复放置与占用的判定 |
| `PICKUP_ITEM` | 缺**地面物品实体**及其拾取判定(`applyInventory` 只认"总数量变化",不认"地上那一件") |
| `CRAFT` | `cooking.ts` 有 `cookSoup`(料理站),但**通用合成**没有入口:缺「配方 → 材料扣减 → 产物」的事务性写入 |
| `USE_ALCHEMY_FURNACE` | 炼金台在 `rooms/effects.ts` 只落到「识别 `ALCHEMY_LAB`」;缺**站台交互**与 LLM 炼金的接线 |
| `SLEEP` | `RoomRuntime` 有 `sleep()` / `wake()`,但那是**房间休眠**(空闲暂停),**不是**玩家睡觉。玩家睡觉要的「床 + 时长 + 打盹状态」目前只在 `rooms/effects.ts` 的卧室判定里(`napping`),没有动作入口 |
| `START_PARTY` | `PARTY_MODES`(手册 §6.3)已定义四种竞技模式与 `setPartyModeBy`,但**开局/计分/结算**的状态机不存在 |
| `PLACE_AUTOMATION` | 缺自动化件实体与放置校验;`wiring/` 有电路求值,但没有「放置」这一步 |
| `WIRE_EDIT` | 同上:缺布线编辑的落点(`build/wiring_view.ts` 是**只读视图**,且它在 `orphan-audit` 里登记为"缺 WireView 下发报文 + 铺线 UI 面板") |
| `BREED_TAME` | `mobs/taming.ts` 存在但为 **orphan**:缺宠物容器与驯服交互(`feedPet` 零生产调用) |

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
