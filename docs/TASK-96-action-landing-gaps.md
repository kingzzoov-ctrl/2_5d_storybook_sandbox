# TASK-96 动作执行层:**未接线的 `RoomAction` 各自缺什么**

> 判据来源:`docs/COMPLETION-CRITERIA.md` 档 B 的
> 「`RoomAction` 全表里,**该有执行层的那些**真的执行」。
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
> ⚠️ **计数口径**:动作总数与「已接线」条数**不在本文手抄** —— 真值源是
> `server/src/net/actions/action_table.ts#ACTION_HANDLERS`(`Readonly<Record<RoomAction, …>>`,
> 编译期完整性:漏一个成员 tsc 报缺键)与 `tests/WS-FND-18`(逐动作归类,总数从代码取)。
> 本文只负责**名字与缺口**;加动作时那两个地方先绿,本文再补一行。

## 已接线(逐波列在下面;总数从 `ACTION_HANDLERS` 取,不手抄)

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
| `MODIFY_TOWN` | `actions/modify_town.ts` + `mobs/spawner.ts` 的 provider | 城镇配置登记 + `town` 权限裁决;**配置真的生效**(`spawner` 按房间号问 provider ⇒ 安全区判定跟着变) |
| `USE_ALCHEMY_FURNACE` | `actions/use_alchemy_furnace.ts` | 站上炼金台 + 内容层配方;**本地确定性实现**(LLM 自由炼金不在本轮) |

⚠️ 新增四条边界(同样**不计入达成**):
1 `BREED_TAME` 的宠物**不是真生物实体**(没有创建/重新归属任何 `WildlifeState`);但**世界已经知道它被驯服**
  (2026-11-15:`net/room.ts` 的投影读 `tameOwnerOf` ⇒ `state.wildlife[].tameOwnerId` 有主人,判据 `WS-FND-46`);
  未做的是"AI 行为随归属变化"(守卫/跟随),那需要 mob AI 侧接线;
2 `MODIFY_TOWN` 的改造**已生效**(2026-11-15):`spawner.ts` 把半径从常量改成**可注入查询**,
  装配层(`index.ts`)把 `modify_town.ts` 的适配器装上去,世界的 `roomId` 经 `WorldSimOptions.roomId`
  透传进 `SpawnWorld` ⇒ 安全区判定按 per-room 配置。判据:`WS-FND-40`(读取口 8 条)、
  `WS-FND-44`(端到端 4 条:改成 8 之后"24 内、8 外"的点不再算安全区)。
3 `START_PARTY` 的赛局**已经真的计分**(2026-11-15:击杀在 `settleKill` → `notePartyEvent` →
  装配层接 `scoreOfPartyEvent` → `addScore`,判据 `WS-FND-45`);**但只有击杀这一处发射点**,
  采集/到达两类事件世界侧还没发;赛局**不落库**(进程内)。
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

### 二之五、**世界重置**(2026-11-15 接线:**只有动作层那一半**)

| 动作 | 落点 | 说明 |
|---|---|---|
| `RESET_WORLD` | `actions/reset_world.ts` + `WorldSaveHost.resetWorld?` | 权限(`destructive`)/ **显式确认** / 种子校验 / **能力缺失** / 回执 |

⚠️ 宿主那一半**不存在**:`WorldSaveHost.resetWorld` 今天**没有实现者**(`WorldSim` 没提供),
所以生产里走的是「能力缺失 ⇒ **显式** `NOT_IMPLEMENTED`」分支 —— 这是如实回执,不是占位。
落点裁决、逐行证据与**必须 owner 定的存档政策**见 `docs/TASK-97-world-reset-ruling.md`;
判据 `WS-FND-34-world-reset`(6 条,其中一条把"今天确实没有"这个**事实本身**钉住了)。

### 二之六、**使用道具**(2026-11-15 接线,1 个 —— **新动作**)

| 动作 | 落点 | 说明 |
|---|---|---|
| `USE_ITEM` | `actions/use_item.ts` + `WorldSaveHost.useItem?`(`world_sim.ts` 实现) | 按 `itemId` 分派三种语义:733 救人 / 227 困人 / 料理吃 buff。执序「**判定 → 扣减 → 写回**」 |

⚠️ 三条边界(**不计入达成**):
1 **`itemId` 由客户端自报** —— 服务端没有按件背包明细读口(`PlayerState` 只有 `heldItemId`),
   世界侧只信"是我认识的 id";扣减走 `applyInventory`(总量守恒,不足即整批拒)。
2 **227 的"对活人连中 3 发"半边已建模**(2026-11-15):`combat/live_bubble.ts`(纯状态机,
  常量从 `revive.ts` import)。它与 `DownedState.BUBBLED` **不是两份实现** ——
  `DownedState` 只在**倒地期间**存在,活人没有被困容器;两边是不同主体,共享的只有手册的词与两个数值。
  判据:`WS-FND-39` 的 FND39-14/15。
3 料理 11 个字段里**只有 `hpFlat` 与即时回复**真的到达玩家(`hpFlat` 经 `maxHpForLevel` 并进上限);
   `gravityMul`(冻结层 `integrateVertical` 无参数位)/ `gatherMul`(本仓无采集系统)/ `jumpMul`(无跳跃入口)
   / `defFlat`·`moveMul`·`gravityMul`·`jumpMul`·`gatherMul`·`expMul` **仍是未接**。

   ★ **2026-11-19 更正**:上面这份「未接」清单里的 **`jumpMul` 已不成立** ——
   `parseMoveIntent.jump` → `applyJumpIntent` → `WorldSim.tryPlayerJump` →
   `physics/world.ts#jump` 这条链把 `jumpMul` 结算掉了(判据 `WS-FND-122`);
   `gatherMul` 的缺口**仍然成立**(本仓没有采集子系统,冻结层也没有采集参数位)。
   ★ 2026-11-15 更新:`atkMul` / `critRate` / `critDmg` **已经进战斗管线**
   (`world_sim.ts` 的 `combatantStats` 第三参由 `combat/cooking.ts` 的 `foodCombatInput` 换算;
   ⚠️ 两侧约定不同,`critDmg` 必须 `-1` 换算 —— 直接传会把伤害从 14 抬到 24,这条由 `WS-FND-39` FND39-11/12 钉住)。
   ★ 2026-11-16 更正:`muOverride` **不缺**默认值了 ——"中性"现在有名字
   (`combat/cooking.ts` 的 `MU_OVERRIDE_NONE = 0`),地板侧的默认也在
   (`world/chunk.ts` 的 `DEFAULT_MU` = 0.75、`muOfSlot`;裸地 `BARE_GROUND_MU` = 0.72)。
   它真正缺的是**接线**:滑溜料理(0.96)要不要盖过冰面的 0.98 —— **玩法裁决**,
   不是常量问题。硬编码 `0.75` 的那句错写已在常量 docblock 里点名。

## 二之七、**世界侧读者**这一波(2026-11-15,不动动作表)

这一波不加动作,只把"已接线但世界侧没人读"的四处接上:

| 事项 | 落点 | 判据 |
|---|---|---|
| `SLEEP` 的世界侧读者 | `WorldSim.attachSleepSource` + `lastRoomEffects[].sleeping`,装配层注入 `sleepStateOf` | `WS-FND-43`(6 条) |
| 赛局真的计分 | `WorldSim.notePartyEvent` + 装配层接 `scoreOfPartyEvent` → `addScore`(击杀在 `settleKill` 里发) | `WS-FND-45`(5 条) |
| 城镇配置生效 | `spawner` 的 provider + `WorldSimOptions.roomId` + 装配层装适配器 | `WS-FND-44`(4 条) |
| 宠物被世界看见 | `net/room.ts` 投影读 `tameOwnerOf` ⇒ `state.wildlife[].tameOwnerId` | `WS-FND-46`(3 条) |

⚠️ **仍未做**(如实列在这里,不许当成已支持):
1 赛局只有**击杀**这一处发射点;`GATHER`(采集拾取)与 `REACH_TARGET`(到达目标)两个词表**规则已备但世界侧没有发射点**(`WS-FND-45` FND45-5 把现状钉住);
2 `SLEEP` 的世界侧读者**只记录事实**,不改变任何回血数值(那要产品裁决);
3 城镇配置对 `bosses/raid.ts` 的祭坛校验**不可见**(它仍以默认 24 调用 `isInsideSafeRadius`);
4 宠物归属**不持久化**(模块级 Map,进程重启即空)。
### 二之八、2026-11-16 这一轮接的六处 + 审查抓出的**五个真缺陷**

| 事项 | 落点 | 判据 |
|---|---|---|
| 温泉上限 `×1.3` 到**权威** | 乘区收进 `maxHpForLevel`(上限的**唯一**算子);`baseMaxHp` 备忘防二次乘(×1.69) | `WS-FND-49` FND49-1/2(注入 M1 能红) |
| z 轴两头接通 | 服务端 `applyPlayerMove(pid,x,y,z?)` + 投影从权威读回;客户端 `client/src/net/height_placement.ts` | `WS-FND-49` FND49-3/4/5(注入 M2)·`WS-FND-48` 7 条 |
| 击退真的发生 | `applyKnockback` + 慢帧推位移 + **推进期间拒绝搬家** | `WS-FND-49` FND49-6/7/8(注入 M3) |
| 复活旗 C2 | `tickDowned` 里**旗优先**(旗与救援共用 `reviveProgress` **一个**字段,同时推进就是两份实现抢它) | `WS-FND-49` FND49-9/10(注入 M4) |
| 227 的"困住"有消费者 | `applyPlayerMove` 的 `TRAPPED` 拒绝 | `WS-FND-49` FND49-11(注入 M5) |
| 大餐乘区真的算 | `tickRoomEffects` 喂 `hasMealBuff` + `lastRoomEffects[].mealMul` | `WS-FND-47` 8 条 |

**对抗性审查抓出、已修的真缺陷**(不修都会"算错",每条都配了判据):

1 **三处注入只在 `assemble()`** ⇒ 生产(Colyseus)路径**全空**(赛局恒 0 / `sleeping` 恒 0 / 城镇半径恒 24):全部搬进 `createHost()` 的 `wireHost()`,**两条路共同入口**;
2 **世界与运行时的 roomId 不同源**(`''` vs `'room_main'`)⇒ 城镇配置永远取不到:`createHost`/`assemble` 用**同一个** `roomId` 局部量;
3 **`USE_ITEM` 先生效后扣** ⇒ 没有道具也能无限救人 / 无限叠 `hpFlat`:改成**先扣后生效**(扣不动 ⇒ 世界侧根本没跑);扣了但没生效 ⇒ 用 `grantItemSource` + 正向 ops **退回**;
4 **赛局计分发在去重之前** ⇒ 同一实例二次结算时"经验去重、分数双发":改为 `settleMobExp` 之后、且 `deduped` 时不发;
5 **刷怪去重把尸体也算"已刷"** ⇒ 每个物种杀一只后**永不重生**:`runtimes().filter((rt) => rt.alive)`。

**审查指出、仍未修**(逐条留档,不假装已解决):

1 `liveBubbles` 的层数**不衰减** ⇒ 跨任意时长能凑满"连中 3 发";连击窗口是**平衡数值**,要 owner 裁;
2 `effectiveMaxHp` 与 `maxHpForLevel` 两个读数口并存(前者生产调用点 0)—— `baseMaxHp` 已消掉 ×1.69 风险;**两处旧 docblock 已在下一节改正**(`rooms/effects.ts` / `combat/vitals.ts` / `world_sim.ts` 的 `effectiveMaxHp`);
3 客户端 z 的**相机高度是硬跳变**(真浏览器观感未验)。

判据:`tests/WS-FND-39-use-item.test.ts`(9 条;4 处注入验证:超距扣道具 / 不写回活的无敌 /
不并 `hpFlat` / 永不扣道具 —— 全部能红且逐字节还原)。


### 二之九、2026-11-16 **第二批**(C3 灭火 / 真网关 / 相机平滑 / 三处更正)

| 事项 | 落点 | 判据 |
|---|---|---|
| **C3 灭火半边**:227 对**器件** | `USE_ITEM` 新增 `targetDeviceId`;**两个目标同时给 ⇒ 动作层直接拒**(`INVALID`,不静默挑一个执行);`WorldSim.useItem` 的 0 号分支 → `extinguishDeviceByHand`(227 / 212,`EXTINGUISH_RADIUS` 3 格内浇灭料理站炉火);`deviceTileOf` 把「图上第一格」的扫描收成**一处**(出锅落点也改用它) | `WS-FND-52`(10 条;四处注入能红) |
| **US2 真网关** | 不动生产码:测试用真 `Server.listen(0)` + 生产注册助手 + `matchMaker.createRoom`,证明 `createHost()/wireHost()` 在网关路径生效 | `WS-FND-50`(7 条;注入 `host: null` 红 4 条) |
| **客户端相机不再硬跳变** | `client/src/net/height_placement.ts` 的 `stepCameraHeight`(纯函数,α 与 dt 挂钩)+ `three/boot.ts` 每帧推进(目标 / 当下分开命名) | `WS-FND-51`(7 条;两种改坏各红 2–3 条) |

**五处更正(前四条改的是描述,第五条改的是行为)**:

1 `muOverride` 不缺默认值 —— 中性值现在有名字(`combat/cooking.ts` 的 `MU_OVERRIDE_NONE`),
  地板侧默认在 `world/chunk.ts`(`DEFAULT_MU` / `muOfSlot`);**缺的是接线口径**(玩法裁决);
2 `rooms/effects.ts` / `combat/vitals.ts` / `world_sim.ts::effectiveMaxHp` 三处 docblock
  原写「倍率不落 `vitals.maxHp`、基准值留在那里」—— 与本版实现相反,已逐处写明更正与理由;
3 本文件 `二之六` 的 `muOverride` 行(见上一节末尾)同步改正。
4 `net/actions/use_item.ts` 的**执序 docblock** 上一版写「判定 → 扣减 → 写回(**不是**先扣后退)」,
  与 A3 之后的代码**相反**(代码就是先扣,世界侧说没生效再退回)—— 已改写并写明历史;
5 **两个目标同时给** 此前只在世界侧"按分支先后静默忽略 `targetId`" ⇒ 现在**报文层直接拒**
  (`INVALID`,理由指认 `targetId` / `targetDeviceId` 互斥,且拒绝发生在扣道具之前);
  `WS-FND-52` FND52-10 同时钉住"报文层拒"与"世界侧兜底(器件优先、不碰玩家)"两道。

**仍未做(逐条给卡点,不假装已支持)**:

1 **受击击退接到受击点** —— `vitals.applyHit` 没有击退参数;内容层唯一的击退量在**武器侧**
  (`weapons.ts` 的 `knockback`,属攻方装备),拿它当"被打飞多远"是**发明数值**;
  实测接上会打红 `WS-10` 三条既有判据 ⇒ **等玩法裁决**;
2 **`liveBubbles` 层数衰减** —— 冻结内容里没有"连中窗口秒数"这个数
  (`shared/constants/items.ts:120` 只写"连射队友 3 发")⇒ **等平衡裁决**;
3 **`forgeUnlocked`** —— `shared/constants/items.ts` 检索 `forge` / `tier` 命中 **0**,
  没有"中高级锻造"的分档可解锁 ⇒ **等内容分档裁决**;
4 **`defFlat` / `gatherMul` / `expMul`**(`moveMul` / `gravityMul` / `jumpMul` 已在 `WS-FND-77` /
  `WS-FND-122` 接线,见上一节更正) —— 冻结层无参数位 或 全仓无该子系统(采集);
5 **227 浇灭 coop 工位**(`rush_order.ts` 的 `STATION_STATE.BURNING` / `opts.spraying`)——
  工位槽位**没有世界坐标**,`opts.spraying` 只能按"种类"喂 ⇒ 玩家动作无法映射到它(设计缺口)。

### 二之十、2026-11-16 **第三批**:生物 id 拆成两层(实例 id ≠ 物种 id)

| 事项 | 落点 | 判据 |
|---|---|---|
| 同物种可以存在多只 | `mobs/spawner.ts` 新增三处**唯一**的 id 规则:`MOB_INSTANCE_SEP` / `mobInstanceId` / `mobSpeciesId` / `mobDefOf`;`WorldSim.trySpawnOne` 用 `mobInstanceId(def.id, 序号)` 刷怪并**去掉按物种去重**;序号来自 `mobOrdinals`(单调、永不复用) | `WS-FND-19` FND19-7/8/9/10(10 条) |
| 8 处查表点收成一处 | 世界侧 `settleKill` / `addMob`、驯养层 5 处,原先各自 `MOB_BY_ID.get(id)` —— 全部改走 `mobDefOf(id)` | FND19-8(带序号 ⇒ 查得到;未知物种 ⇒ 仍进 `unknownMobs`) |
| 投影本来就分两层 | `listWildlife()` 早就有 `id` 与 `mobId` 两个字段 ⇒ **网络侧一行没改** | FND19-7(快照里两条各自独立) |

**为什么这次能拆(而前几轮列成"独立一件")**:拆的前提是"8 处查表点全部收口 + 序号永不复用",
两件事都在这一批里做掉了。**注入验证**:M10(让 `mobSpeciesId` 不切序号)⇒ 6 条红;
M11(把按物种去重加回 `trySpawnOne`)⇒ 只有 FND19-10 红 —— 那正是它的存在理由。

**仍未做**:刷满 `BIOME_SPAWN.hardCap` **没有被判据覆盖**(那要靠世界时间,断言它等于让套件等十分钟)
⇒ 本批只钉"契约允许同物种多只 + 刷怪路径真的会刷出第二只",不声称"能刷满"。

## 未接线(按设计只剩两条:走专用报文通道的那两个)

### 一、**有专用报文通道**、但**不走 `action` 通道**(2 个)

| 动作 | 现状 | 说明 |
|---|---|---|
| `MOVE` | ✅ **真的执行**(经 `onMessage('move')` → `RoomRuntime.applyMove()` → `WorldSim.applyPlayerMove`) | 不走 `action` 是为了保住坐标契约:反作弊 `checkMove` 判的是「绝对位置 + tick」,而 `action` 的泛型 payload 不带这个语义。⇒ `dispatchAction('MOVE')` 返回 `NOT_IMPLEMENTED` 是**刻意**的,表示「别从这里发」 |
| `ATTACK` | ✅ **真的执行**(经 `onMessage('attack')` → `RoomRuntime.applyAttack()` → `WorldSim.attackMobAuthorized`) | 同上。结算值经 `attackResult` 回执 |

> ⚠️ 这两个的「已执行」由 `tests/WS-07` / `WS-10` 的行为断言钉住,
> 不在本文的"缺什么"范围内 —— 但**必须写在这里**,否则读者会以为它们也缺。



## 这张表怎么被维持

```
tests/WS-FND-18
  FND18-1  每个动作必须由 dispatchAction 逐个归类(不交、不重、全覆盖;总数从代码取,不写死)
  FND18-2  未接线的必须显式 NOT_IMPLEMENTED + reason 非空 + **出现在本文件里**
  FND18-3  已接线的回 OK 时必须带 effect(不留"回 OK 却无副作用")
  FND18-4  越权必须先被权限闸拦下(类别为 PERMISSION,不是 INVALID/NOT_IMPLEMENTED)
```

⇒ 新增一个动作而不作决定、或把某个未接动作悄悄改成"成功",
**都会当场红**;而「该不该接」仍是产品裁决,不是测试能替的。
