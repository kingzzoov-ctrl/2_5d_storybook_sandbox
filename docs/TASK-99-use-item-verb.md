# TASK-99 决策稿:`USE_ITEM` 该不该加、以什么形状加

**结论:加。** 新动作 `RoomAction.USE_ITEM`,载荷**复用** `ActionPayload` 现成字段(`itemId` + `targetId`),执序「纯判定 → 扣减 → 写回状态」,权限位 `baseline`。
**边界:本轮只出决策稿,不实现、不改任何其他文件、不跑 `node scripts/verify.ts`、不 commit。**

## 1 动机:三条欠账缺的是同一个动词

| # | 东西 | 现状(函数在、行为对、判据齐 ⇒ 玩家触发不到) |
|---|---|---|
| 1 | 733 羽毛笔 | `server/src/combat/revive.ts:268` `featherRevive`;超距早退 `:274`;规则原文 `:266`「超距直接无效(道具不消耗、不复活),由调用方决定是否退还」。生产调用点 **0**(定义之外只出现在 `tests/` 与 `scripts/` 清单文本,如 `scripts/live-path-audit.ts:93`)。判据齐:`tests/WS-FND-36-dead-items.test.ts` 11 条(`:111` `:120` `:151` `:175` `:197` `:212` `:223` `:241` `:259` `:277` `:299`) |
| 2 | 227 泡泡水枪 | `revive.ts:253` `bubbleGunHit`,生产调用点同样 **0**(判据同上 `:241` `:259`) |
| 3 | 料理 buff | `server/src/combat/cooking.ts:273` `cookSoup` 产出 `CookResult.buff`(`:236`);`server/src/sim/world_sim.ts:4000-4017` 的 `tryCookAt` 里 **`res.buff` 出现 0 次**(`:4003` 只取 `res.itemId`);`FoodBuff`(`cooking.ts:32`)/`mergeFoodBuffs`(`:479`)/`tickFoodBuff`(`:468`)/`cleansePrankBuffs`(`:474`) 在 `world_sim.ts` **全部 0 次** |

⇒ 缺的不是判定、不是数据,是**「对某个目标使用我背包里的一件」这个动词**。加它,三条同时有入口;不加,就只能继续维护零调用者的函数,`scripts/live-path-audit.ts:97` 的 `prodCalls === 0` 过滤器会一直把它们列在候选表里。

**附注(同向,但要更正来源):** `docs/WS10-INVULN-VERDICT.md:17` 与 `docs/TASK-98-archive-c-rulings.md:73` 都说「227 的灭火半边是活的(`interactMob`)」。实测不成立:`interactMob`(`world_sim.ts:1663`)自身生产调用点 **0**,`world_sim.ts:1653` 自述「`MobHost.interact()` 一直存在且完整实现,但**编排层从不调用它**」,全仓唯一调用在 `scripts/verify.ts:5454` ⇒ 227 的灭火半边也没有入口,与本动词同批处理。

## 2 为什么不是别的东西

| 方案 | 改动面 | 与 22 动作的权限/回执纪律 | 对 `WS-FND-38` 派生器 | 裁决 |
|---|---|---|---|---|
| **a** 新动作 `USE_ITEM` | `room.ts:104-127` +1 键、`:176-199` +1 映射、`actions/action_table.ts:52` +1 键(编译期完整性 `:6-9`)、新文件 `actions/use_item.ts`、`scripts/verify.ts:4043` 登记 | 完全沿用:权限走 `can()`(`room.ts:201-205`),成功必带 `effect`(`:883`),失败分四种 `kind`(`:879`) | `total` 22→23、`wired` 多一条 row;脚本**不用改**(`scripts/action-coverage.ts:646` 派生) | **留** |
| b 复用「交互/工具」通道 | 无该动作:`RoomAction` 22 个成员(`room.ts:104-127`)里没有 `INTERACT_MOB`(全仓 0 命中);`interactMob(mobId,itemId,playerId)`(`world_sim.ts:1663`)签名只认生物目标,没有「救哪个玩家」这一维,且自身 0 调用 | 自建通道就不经 `dispatchAction`,绕开 `authorize` + `classifyFailure`(`room.ts:1465`),回执纪律作废 | 派生器只扫 `actions/*.ts` 与 `room.ts`(`tests/WS-FND-38-action-coverage.test.ts:195`),新通道对它**不可见** ⇒ 判据盲区 | **否** |
| c 客户端专用报文 | `room.colyseus.ts` 加第 5 条 `onMessage` + 客户端入口 | 服务端要第二份裁定/回执,与 action 表并存 = 两份实现 | **直接冲突**:`tests/WS-07.test.ts:3991` 断言客户端消息面恰好 4 条,`:4016` 断言能改世界的通道恰好 4 条 | **否** |
| d 让 `CRAFT` 顺便吃 buff | `actions/craft.ts` + `cookSoup` 结果直进状态机 | 权限不同层:`CRAFT` 是 `build`(`room.ts:186`),「吃自己做的菜」应是 `baseline`;守恒判据 `tests/WS-FND-25-craft.test.ts:89`/`:132` 把「材料 -N / 产物 +1」写死,顺手吃 buff 会让产物不再落地 | 无感(仍已接线),但 `wired` 语义变模糊:一个动作两件事 | **否**(两个失败原因混进同一个 `kind`) |

## 3 形状

- **动作名** `USE_ITEM`(与 `PICKUP_ITEM` / `DROP_ITEM` 同族,`room.ts:109-110`)。
- **payload** `{ itemId: number, targetId?: string }`:两格都已在 `ActionPayload` 里(`room.ts:867` 的 `itemId`、`room.ts:847` 的 `targetId`)⇒ **不改 `ActionPayload`、不改 wire**;`targetId` 缺省 = 对自己用。**不用**客户端坐标:目标解析走 `ctx.hostPositionOf`(`actions/types.ts:57`)+ `world_sim.ts:2234` 的 `downedOf`,与 `DROP_ITEM`「落点取权威位置」同理(`material.ts:128-130`)。
- **`effect` 只放标量**(`room.ts:883` 只收 `string|number|boolean`):`{ itemId, consumed: 1, revived: 1, hpAfter, invulnSec }`,`targetId` 若给则回带;件数用 `consumed`(0/1),层数/buff 明细不许塞嵌套对象。
- **失败显式**:未生效 ⇒ `kind: 'INVALID'`(`room.ts:879`),`reason` 带上限原文(如「距离 6.1 > 6 格」),以便复用 `WS-FND-36:151` 的「入参逐字段未改动」比对口径。

## 4 事务纪律

1. **纯判定先行、零写入**:先用 `featherRevive({ distance, downed, progress })`(`revive.ts:268`)跑一次 —— 纯函数,返回新对象、不碰入参(`WS-FND-36:151` `:277` 钉着)。`revived: false` ⇒ 直接 `INVALID`,此时背包零字节变化、`DownedState` 逐字段不变 —— 这就是「超距不许消耗」(`revive.ts:266`)的落地方式。
2. **先扣减、再写回**。扣减走唯一入口 `ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] })`(`actions/types.ts:60`)。**不要**照抄 `placeBlock` 的「先扣 → 世界拒绝 → 退回」(`material.ts:62` `:70-75`):那里世界侧可反演,复活一旦写了 `vitals` 无法反演,「先写后扣」等于白送。把**唯一会失败的 IO 放在写之前**,写回是纯内存、无失败分支 ⇒ 不需要退回路径。
3. **写回只一处**:照 `world_sim.ts:2337` 的既有形态 `this.vitals.revive(id, out.result.hpAfter, out.result.invulnSec)` + `:2338` 的 `downedStates.delete(id)`。⚠️ `invulnSec` **必须**转写进 `vitals.iframeSec`(`world_sim.ts:2331-2336` 记着不转写就是「复活后零宽限无敌」;`revive.ts` 的 `isInvulnerable` 生产 0 调用)。
4. **扣减被拒**(总量为负,`anticheat.ts:825-829` 的 `NEGATIVE`)⇒ `INVALID` + 理由,**不写任何世界状态**。该闸只校**总量**(`anticheat.ts:818` 累加 `net`),不校「你有没有那一件」—— 见 §8。
5. **将来若写回长出失败分支**:退回必须带凭证,模板 `material.ts:72-74`(`grantItemSource('use-item-refund:…')` + `delta: +1`),不许静默吞掉。

## 5 权限位:`baseline`,不新造角色位

`ACTION_PERMISSION.USE_ITEM = 'baseline'`。同族 `PICKUP_ITEM` / `DROP_ITEM` / `USE_OWN_CHEST` / `BREED_TAME` 都是 `baseline`(`room.ts:179-183`):用自己背包里的东西是「捡/丢」同层能力。若挂 `build`(`CRAFT` 那一档,`room.ts:186`),按 `PERMISSION_MATRIX` 的 GUEST 行(`:169-172`)GUEST 连「给队友扔羽毛笔」都做不了,而 GUEST 本来能捡能丢。
**不新造位**:权限位 9 个(`room.ts:130-149`),被 `tests/WS-07.test.ts:2549` 逐角色断言 `Object.keys(p).length === 9` 钉死,`:2545` 标题还写着「4 角色 × 9 权限位 × 22 动作」;新造位要同时改 4 行矩阵 + 该断言 + 文档口径,而 `baseline` 已能表达本动作语义。

## 6 会牵动的既有判据

| 判据 | 位置 | 同步方式 |
|---|---|---|
| `WS-FND-38` FND38-1 动作总数 = 22 | `tests/WS-FND-38-action-coverage.test.ts:211` `:219` | 22 → 23(标题 + 断言)。**加动作后第一个红点**,比 wired 计数更早 |
| `WS-FND-38` FND38-3/5/9(三份硬编码名单交叉核对) | `:239-249`、`:263`、`:397`;名单在 `tests/WS-07.test.ts:4176`(`MOVE`/`ATTACK`)与 `tests/WS-FND-21-action-e2e.test.ts:173` | 接线则名单不动;只登记 `notImplemented` 桩则必须进名单或在 `ACT2_EXEMPT` 写理由(`:292`、`:435` 会红) |
| `WS-FND-18` FND18-1 归类 | `tests/WS-FND-18-action-ownership.test.ts:46`、`:70`、`:73` | 三处 22 → 23 |
| `WS-07` F13 权限矩阵 / 四条通道 | `:2545`、`:2549`、`:2553`;`:3991`、`:4016` | `:2553` 自动跟随不必改;`:2545` 标题要改;通道数不改(证明方案 c 被否是对的) |
| `WS-FND-17` FND17-6 三件死道具 | `tests/WS-FND-17-room-c-and-dead-items.test.ts:166`、`:180-185` | 733/227 变 `implemented: true` 时 `scripts/dead_items.ts:52-53` / `:69-70` 必须同步给 `consumer`,否则红;`:106` FND17-3 不受影响(测纯函数),它恰是「判据齐而调用点 0」的证据 |
| `WS-FND-35` 客户端入口「五个动作」 | `tests/WS-FND-35-client-entry.test.ts:84`、`:127` | 若同批加 `useItemRequest` 则数量变六;`:127` 自动跟随 |
| `verify.ts` 处理器登记表 | `scripts/verify.ts:4043`、`:4509-4515` | 新文件 `actions/use_item.ts` 必须登记,否则报 unlisted |
| 文档口径 | `docs/TASK-96-action-landing-gaps.md:16`(20/22)、`:103`(2/22);`docs/CLIENT-NET-READINESS.md:168`、`:196` | 改 23;`TASK-96:107` 已写明「新增一个动作而不作决定…都会当场红」 |

`wired` 现状 20(`docs/TASK-96:16`),接线后 21 / total 23 —— 但**第一个红点是 total**,别只盯 wired。

## 7 可验收的判据形态

建议 `tests/WS-FND-39-use-item.test.ts`,核心是一对:

- **正例**:A 持 733、站在幽灵泡泡队友 B 的 3 格外,背包总量 `before = N`;发 `USE_ITEM { itemId: 733, targetId: B }` ⇒ 断言 `out.ok === true`、`kind === 'OK'`、`effect.revived === 1`、`effect.invulnSec === 3`,并**对照世界侧**:`sim.downedOf(B) === undefined`(`world_sim.ts:2234`)、`vitals` HP == `maxHp` 且 `iframeSec >= 3`、背包总量 == `N - 1`。
- **负对照(必须红的那条)**:距离改 6.1 ⇒ `out.ok === false`、`kind === 'INVALID'`、`sim.downedOf(B)` 逐字段等于调用前(`JSON.stringify` 比对)、背包总量仍 `N`、`effect === undefined`。
- **守纪律**:只剩 1 件时连发两次 ⇒ 第二次 `INVALID` 且总量 0,不许「复活了没扣」或「扣了两次」。

## 8 边界与前置依赖

1. **本轮只出决策稿,不实现。** §6 所有同步动作留给实现轮。
2. **服务端读不到「背包里有哪几件」。** wire 的 `PlayerState` 只有 `heldItemId`(`shared/types/wire.ts:192-207`,`server/src/net/schema.ts:71` 默认 0);`world_sim.ts:2856-2858` 的 `inventoryDetailOf()` 如实返回 `null`;`actions/craft.ts:18-20` 已把这条写成文件头取舍。⇒ **「用哪一件」只能由客户端自报**(同 `craft.ts` 的 `have`,`client/src/net/action_entry.ts:173-187` 甚至设为必填)。
3. **自报的后果**:`applyInventory` 的闸只校**总量**(`anticheat.ts:818` `:825-829`),故「持 3 根胡萝卜的玩家」理论上可以声称用 733,只要总量 ≥ 1 就扣得动 ⇒ 本动作在补按件读口之前是「客户端声明 + 总量守恒」等级的可信度,与 `CRAFT` 同级,不更高。
4. **两条路,实现轮必须先答**:(a) 客户端自报 `itemId`(复用 `craft.ts` 口径,零 wire 改动);(b) 先补按件读口(要动 `PlayerState` 字段表 —— `tests/WS-FND-24-contract-align.test.ts:210` 断言字段表恰 14 项 / bit 0..13,还要过 `schema.ts:55` 的 32 字段掩码上限与 `WS-FND-24:308`「Snapshot 只覆盖 3/14」)。**推荐先 (a)**,(b) 单列为独立欠账:它牵动 4 张表与整套编解码判据。

## 9 核对记录(全部用 `Select-String` 跑过)

| 引用 | 核对方式 | 结果 |
|---|---|---|
| `revive.ts:268` / `:253` | `Select-String -Path server\src\combat\revive.ts -Pattern "export function"` | 命中 `253 bubbleGunHit`、`268 featherRevive` ✅ |
| 两者生产调用点 0 | 对 `server,client` 全量 grep `featherRevive\|bubbleGunHit` | 仅 `revive.ts` 自身 + `tests/` + `scripts/` 清单 ✅ |
| `cooking.ts:273` / `:236` / `:479` | 同文件 `Pattern "buff\|export function"` | `273 cookSoup`、`236 buff`、`479 mergeFoodBuffs` ✅ |
| `world_sim.ts:4000-4017` | `Select-String "tryCookAt"` | 定义 `:4000`,内部调用 `:3989` ✅ |
| `res.buff` 被丢弃 | `Select-String -Path server\src\sim\world_sim.ts -Pattern "res\.buff"` | **0 命中**(见更正 3) ✅ |
| 22/22、9 位、4 角色 | 数 `room.ts:104-127`、`:176-199`、`:130-149`、`:156-173` | 22 / 22 / 9 / 4 ✅ |
| `effect` 只收标量 | `room.ts:883` | `Record<string, string \| number \| boolean>` ✅ |
| `interactMob` / `INTERACT_MOB` | 全量 grep | `interactMob` 仅定义 `world_sim.ts:1663` + `scripts/verify.ts:5454`;**`INTERACT_MOB` 0 命中** ✅ |
| `checkInventory` 只校总量 | `anticheat.ts:805-834` | 累加 `net`、比 `beforeTotal + net` ✅ |
| `inventoryDetailOf` 恒 null | `world_sim.ts:2856-2858` | `return null` ✅ |

**任务书里数字/事实有误的清单:**

1. **「227 现在就走 `interactMob`」不成立**:`interactMob` 自身 0 生产调用(`world_sim.ts:1653` 自述「编排层从不调用它」)。该说法出自 `docs/WS10-INVULN-VERDICT.md:17`、`docs/TASK-98-archive-c-rulings.md:73`(并据此把 D11 判成「复用既有 `interactMob` 灭火路径」,`:86`)⇒ **两份文档这条结论需一并更正**。
2. **「既有 `INTERACT_MOB` 动作」不存在**:22 个 `RoomAction`(`room.ts:104-127`)无此名,全仓 0 命中。
3. **「`tryCookAt` 把 `res.buff` 丢掉」措辞不准**:world_sim 里 `res.buff` 出现 0 次 —— 不是丢弃,是整条 buff 通路零引用。结论同向,证据更强。
4. **「`WS-FND-36` 11 条含 11 处注入验证」后半句不成立**:11 条 `test(` 正确,但「注入」只在文件头注释(`:25` `:79` `:82`);与「入参逐字段未改动」直接相关的是 `:151`(及 `:277` 逐字比对),其余是边界/负对照。
5. **「wired 20 → 21」方向对但不完整**:wired=20 属实(`docs/TASK-96:16`),但**先红的是 total**(`WS-FND-38:219`),另有 `WS-FND-18:70`、`WS-07:2545` 两处 22 字面量要先改。
6. **`WS-07` ACT-2 名单**现为 `MOVE`/`ATTACK`(`tests/WS-07.test.ts:4176`):本动作**接线**则名单**不变**,只有做成 `notImplemented` 桩才要动 —— 任务书把两件事并列,口径要收紧。