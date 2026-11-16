# TASK-98 · 档 C 三项的决策清单

> 一页纸。每条只有:判据原文 → 今天的事实 → 要你答的题 → 选项后果 → 我的推荐。
> 行号均为本次逐条核对过的实测值;与任务书给的数字不符处集中列在 §5。

## §1 9 种房间增益
### 判据原文(逐字 + 文件:行号)
`docs/COMPLETION-CRITERIA.md:145-149`
> [~] 9 种动态房间的玩家增益:**每种都有决定**(`server/src/rooms/effects.ts` 的 `ROOM_EFFECT_DECISION`,对着冻结层 `ROOM_RECIPES` 逐条核 —— `WS-FND-17` 钉住)。细分:4 种有**数值**增益(锻造解锁 / 食堂大餐 / 卧室回血 + 打盹 / 温泉上限)、1 种**纯展示**(画廊)、4 种是**系统解锁而系统还不存在**(…)。⇒ **仍未勾**:「9 种都有玩家能感知的增益」今天不成立。
### 今天的事实
1. `effects.ts:61-75` 9 条决定齐全(4/1/4 分类),`tests/WS-FND-17-room-c-and-dead-items.test.ts:67` 的 FND17-1 逐 key 对着冻结层核 ⇒ **覆盖性已绿**,不成立的是「可感知」。
2. 4 条 `PLAYER_NUMERIC` 里只有**卧室回血**真的到达玩家:`server/src/sim/world_sim.ts:2966` `this.vitals.heal(id, r.healHp)`。
3. `forgeUnlocked()`(`world_sim.ts:2917`)、`effectiveMaxHp()`(`:2989`)生产调用点**均为 0**(全仓只有定义与注释引用)⇒ 锻造解锁、温泉 ×1.3 玩家侧不可感;且 `server/src/combat/vitals.ts` 的 `heal` 按 `v.maxHp` 截断,温泉上限拿不到。
4. 食堂:`effects.ts:119 hasMealBuff?` 在唯一真实调用点 `world_sim.ts:2961` 从不传 ⇒ `:192` 的 `mealMul` 恒 1.0;`RoomEffectResult.mealMul` 也不在 `lastRoomEffects` 类型(`:2881` 只有 healHp/maxHpMul/forgeUnlocked)⇒ 算完即丢。`napping`(`effects.ts:187`)在 world_sim 零读取。
5. `client/**` 对 `roomEffect|ROOM_EFFECT|mealMul` **零出现**;现成的上屏载体只有冻结层 `shared/types/wire.ts:289 RoomState`,而 `effects.ts:21` 自述的设计约束是「不新增冻结层字段,`shared/**` 零改动」。
### 决策点
D1. 温泉 ×1.3 与锻造解锁本版是否**必须让玩家感知**?(否 = 认可「服务端可查、玩家看不到」)
D2. 房间增益是否**上屏**?(要 ⇒ 改冻结层 `shared/types/wire.ts`)
D3. 食堂是否改判为「站进去就给 ×1.4」,去掉「带着料理 buff」前置?
D4. 4 条 `SYSTEM_UNLOCK`(牧场/炼金/温室/百货)是否保持原样、只由 FND17-1 守 key 覆盖?
### 选项与后果
- D1=是 ⇒ 只改 `world_sim.ts`(2917/2989 两处接调用点)±`vitals.ts` 上限口径;不碰冻结层;FND17-1/2/5 都不会红(它们不统计调用点数)。
- D1=否 ⇒ 只改 `docs/COMPLETION-CRITERIA.md:147-149`,把「4 种有数值增益」改成「1 种玩家可达」;零代码、零冻结层、零断言红,但文档降级。
- D2=是 ⇒ 改冻结层 `shared/types/wire.ts` + `client/**` 渲染点;直接违反 `effects.ts:21`;FND17-* 仍全绿(它们不读 client),也就是**改完没有断言能证明它对**。
- D2=否 ⇒ 零改动,残留「服务端算了没人看」。
- D3=是 ⇒ 只改 `effects.ts:192`;会让 `tests/WS-FND-17…:124-145` 的 FND17-4 负对照(`hasMealBuff:false` 断言 1.0)变红,须同步改测试 —— 用一条真红换一条规则。
- D4=是 ⇒ 零改动。
### 我的推荐 + 理由
**D1=是(只补温泉上限),D2=否,D3=否,D4=是。** 理由:`effectiveMaxHp` 已有完整实现、且和 `stepRoomEffects` 共用 `maxHpMulOf` 单一真相,缺的确实只是调用点,是三项欠账里唯一「一行接线换一条可感知增益」的;D3 会把手册写明的「大餐=料理产物」抹掉,并且必须推翻一条已在岗的负对照;D2 改完没有任何断言能红,是纯风险。
### 拍板后能红的断言
- D1 ⇒ 新增:`sim.effectiveMaxHp(p)` 在离开温泉后回落到 `vitals.maxHp`;对照 `effects.ts:141` 注释「查询(`effectiveMaxHp`)与推进(`stepRoomEffects`)必须用同一个函数」。注入 `maxHpMulOf` 恒 1 ⇒ 红。
- D3 ⇒ `WS-FND-17…:137-145` 的 FND17-4 负对照必须反转(行为断言,非新增)。
- D2 ⇒ 无红点,故不推荐。

## §2 料理 buff 7 字段
### 判据原文(逐字 + 文件:行号)
`docs/COMPLETION-CRITERIA.md:150-154`
> [~] 料理 buff 有消费点:大餐乘区(`CANTEEN_MEAL_MUL`)由「在食堂 **且** 带着料理 buff」触发;`WS-FND-17` 钉住「字段可达 + 空手站进去不给」。⇒ **仍未勾**:缺**生产者** —— `WorldSim` 还没有「这个玩家身上的 FoodBuff 列表」,所以 `hasMealBuff` 在运行期恒为 `undefined`。

`docs/CHANGE_REQUESTS.md:2335-2341`(CR-21 裁定)
> **「功能未做」,不是「缺一段接线」** … 那是先要回答「这 7 个字段**分别该被谁读**」,再谈实现。⇒ 这是**玩法设计问题**,不是接线问题。

同文件 `:2345-2353` 逐字段「待裁」,`:2381-2382` 「在这之前,**不动 cooking.ts**」。
### 今天的事实
1. `server/src/combat/cooking.ts:32-63` `FoodBuff` 共 **11** 字段;`:479 mergeFoodBuffs` 是纯函数,外部调用 **0**。7 个零消费者字段 = `hpFlat/defFlat/gravityMul/muOverride/jumpMul/gatherMul/expMul`(`:45-63`),另有 1 个 `critDmg`(`:53`)见 §5 第 7 条。
2. `world_sim.ts:4000-4017 tryCookAt`:4003 拿到 `res`,4003-4016 **整段**不读 `res.buff` —— `world_sim.ts` 全文没有 "buff" 一词(只有 `buffer`:3672)⇒ buff 从不进世界。
3. `server/src/combat/weapons.ts:893-897 combatantStats(level, equippedIds=[], buffs: BuffInput={})`;`BuffInput`(`:884-891`)只有 `atkMul/hpMul/critRate/critDmg/allyCount`,**没有** `hpFlat/defFlat/gravityMul/muOverride/jumpMul`;`world_sim.ts:1923` 省略第三参 ⇒ 生产恒 `{}`(唯一非空喂养是 `tests/WS-10.test.ts:1093`)。
4. `gravityMul` 无落点:`shared/types/physics.ts:13 GRAVITY = -18.0` 是模块常量,`:103 vz + GRAVITY*dt` 没有倍率形参 ⇒ 必改冻结层;`muOverride` 有余地形参(`physics.ts:85 mu`),只需改调用方。
5. `gatherMul` 本仓**没有采集系统**;`expMul` 的落点在 `server/src/combat/progression.ts`。
### 决策点
D5. 7 个字段本版是否**全部**要做?(否 ⇒ 只做子集,余下按 CR-19 显式标「未接线」)
D6. 是否只做 `hpFlat` + `defFlat`(战斗内即时可感、不碰冻结层)?
D7. `gravityMul` 是否允许改冻结层 `shared/types/physics.ts`,给 `GRAVITY` 加逐实体倍率?
D8. `gatherMul` 因「无采集系统」本版直接判不做 —— 同意吗?
### 选项与后果
- D5=全做 ⇒ 要新建 `WorldSim.foodBuffs: Map`(CR-21:2362 的形状)+ 扩 `weapons.ts` 的 `BuffInput` + 改冻结层 `physics.ts` + 仍有一个字段没有宿主系统 ⇒ **按定义做不完**。
- D6=只做两项 ⇒ 改 `weapons.ts:884-891/915` + `world_sim.ts:1923` 传参;不碰冻结层;FND17-3(`:106` 标题「7 个关键字段经合并后**可达**」)**不会红**(它测的是 `mergeFoodBuffs` 纯函数可达性,不测有没有人读)。
- D7=是 ⇒ 改冻结层 `physics.ts:13/:103` + `integrateVertical` 签名;会让按冻结层形状写的那类断言波动;`WS-FND-17` 不红(它不 import physics)。
- D7=否 ⇒ `gravityMul`/`muOverride`/`jumpMul` 三项进「本版不做」清单,`cooking.ts` 零改动。
- D8=同意 ⇒ 在 `cooking.ts` 7 字段区加「未接线 + 为什么」注释(CR-19 模式),零行为变化、零断言红。
### 我的推荐 + 理由
**D5=否 → D6=是(只做 `hpFlat`/`defFlat`),D7=否,D8=同意。** 理由:`defFlat` 有现成的减免通道语义、`hpFlat` 有现成的 `maxHp` 派生位(与 §1 的 `effectiveMaxHp` 同一处),这两项是唯一「接一行就被玩家感知」的;重力和摩擦三项改的是**全实体物理**,收益只是一个甜品的滑步手感,不匹配改冻结层的代价;`gatherMul` 没有宿主系统,做了就是第二份死实现(CR-21:2378 的陷阱 54)。
### 拍板后能红的断言
- 生产者到位 ⇒ 新增:同玩家吃完后 `combatantStats(level, eq, {buff})` 的 `def` 比空手高 `defFlat`,对照 `cooking.ts:47` 的字面值;删掉 `world_sim.ts:1923` 的传参 ⇒ 红。
- 现状的**反证**:`WS-FND-17…:106-115` FND17-3 已钉「`mergeFoodBuffs` 可达」—— 它**不能**证明有人读,这正是 CR-21 说的第二份死实现形状。

## §3 三件死道具
### 判据原文(逐字 + 文件:行号)
`docs/COMPLETION-CRITERIA.md:155-157`
> [x] 三件死道具(733 羽毛笔 / 435 复活旗 / 227 泡泡水枪)有裁决:**保留在冻结内容表 + 显式标记未实装**(`scripts/dead_items.ts` 逐条写明缺什么;`WS-FND-17` 的 FND17-6 钉住「仍在表里 + 未实装是显式的」)。
### 今天的事实
1. 判据原文只要求「**有裁决**」,不要求实装 ⇒ `scripts/dead_items.ts:49-73` 三条 `implemented: false` + `consumer: null` + 逐条 `reason`(`:54-56` / `:63-64` / `:71-72`),加 `tests/WS-FND-17…:166` FND17-6 ⇒ **本条已关闭**,`COMPLETION-CRITERIA.md:155` 的 `[x]` 站得住。
2. 剩下的是**实现缺口,不是判据缺口**:`docs/WS10-INVULN-VERDICT.md:15` C1(733)=「设计上该有但漏了,证据最强:冻结层 note 写明了行为」、`:16` C2(435)= 复活行为漏接且计分/出生旗用途已被 `party/scoring.ts` 取代、`:17` C3(227)= **灭火半边是活的**(`interactMob`),困人半边漏。
3. 三件的冻结层配方与 note 都在(`docs/WS10-INVULN-VERDICT.md:256-261`)⇒ 实装**不需要**动内容表。
4. `dead_items.ts:44-45` 的类型注释要求 `implemented: true` 时 `consumer` 必填,但仓里没有任何断言强制这条(只有类型,无测试)。
### 决策点
D9. 733 本版是否接线(投掷命中 6 格内幽灵泡泡队友 ⇒ 满血复活 + 3 秒无敌)?
D10. 435 是否**降级为纯出生点装饰**(四队归属/计分交给已存在的 `party/scoring.ts`)?
D11. 227 是否只上「灭火半边」,困人半边继续留在 `dead_items.ts` 标未实装?
D12. 是否加一条断言强制「`implemented: true` ⇒ `consumer` 非空」?
### 选项与后果
- D9=是 ⇒ 改 `server/src/combat/revive.ts`(或新增投掷命中队友的消费点)+ `dead_items.ts:50-56` 的 `implemented/consumer`;不碰冻结层;FND17-6 **可能变红**(它断言的是「三件仍在表里 + 未实装是显式的」,见 §5)。
- D9=否 ⇒ 零改动,`COMPLETION-CRITERIA.md:155` 保持 `[x]`,手册里 733 继续是未实装。
- D10=是 ⇒ 改 `dead_items.ts:59-65` 的 `reason` 指向 `party/scoring.ts`;不碰代码表;FND17-6 不红(仍 `implemented: false`)。
- D10=否 ⇒ 要实现四色队伍状态机,成本本节最高。
- D11=是 ⇒ 改 `dead_items.ts:67-73`(reason 收窄到「困人半边」)+ 复用既有 `interactMob` 灭火路径;不碰冻结层、不红。
- D12=是 ⇒ 新增 1 条 `tests/` 断言扫 `DEAD_ITEMS` 的 `implemented/consumer` 一致性;纯加断言,零行为变化。
### 我的推荐 + 理由
**D9=是,D10=是,D11=是,D12=是 —— 顺序 D12 → D10 → D11 → D9。** 理由:判据已满足,现在花的是「实现缺口」的钱,所以先花 1 条断言(D12)把钱锁住;435 的用途已被 `party/scoring.ts` 取代,是**减工**(降级即可,不需要队伍状态机);227 的灭火半边本来就活,只需把登记文本收窄;733 是唯一真正要写新判定点的,放最后。
### 拍板后能红的断言
- D12 ⇒ `DEAD_ITEMS` 里任一条 `implemented: true` 而 `consumer === null` ⇒ 红;负对照:三件现状(`false/null`)必须仍绿。
- D9 ⇒ 幽灵泡泡队友在 6 格内被 733 命中 ⇒ 满血 + `invulnSec > 0`;第 7 格 ⇒ 无变化(负对照)。
- D10/D11 ⇒ 无红点(只改登记文本)。

## §4 总表
| 欠账 | 判据出处 | 决策点数 | 碰冻结层? | 成本 | 建议顺序 | 推荐结论 |
|---|---|---|---|---|---|---|
| 9 种房间增益 | COMPLETION-CRITERIA.md:145-149 | 4(D1-D4) | 仅 D2 要(`shared/types/wire.ts`) | 小(2 个调用点) | 1 | 温泉上限接线;食堂/上屏/系统解锁维持现状并写明 |
| 料理 buff 7 字段 | COMPLETION-CRITERIA.md:150-154 · CHANGE_REQUESTS.md:2306-2384 | 4(D5-D8) | D7 要(`shared/types/physics.ts`) | 大(新 Map + 逐字段语义归属) | 2 | 只做 `hpFlat`/`defFlat`,余 5 项标未接线 |
| 三件死道具 | COMPLETION-CRITERIA.md:155-157 | 4(D9-D12) | 否 | 中(3 个独立特性,判据已满足) | 3 | D12 锁门禁 → D10 降级 → D11 收窄 → D9 接线 |

## §5 我未能确认的
**任务书与实测不符(6 条):**
1. `docs/CHANGE-REQUESTS.md` → 实际文件名是 `docs/CHANGE_REQUESTS.md`(下划线)。
2. `world_sim.ts` 在 `server/src/sim/world_sim.ts`,不在 `server/src/`;你给的 2917/2989/2922/2966/1923/4000/4014 **行号全部对**。
3. ★ **`roomEffectOf`(:2922)「生产调用点 = 0」不成立**:`server/src/net/actions/sleep.ts:218` 有真实调用(经 `:197` 声明的可选形 `roomEffectOf?(id)`),另有 2 处测试调用(`tests/WS-03.test.ts:1333`、`tests/WS-FND-26-sleep.test.ts:205`)。`forgeUnlocked`/`effectiveMaxHp` 的「0」成立。
4. `res.buff` 丢掉的位置:4014 是 `mobGround.push`;严格说 4003-4016 **整段**零读取,全文无 "buff" 字样。
5. `world_sim.ts:1923` 是**省略**第三参(走默认 `{}`),不是字面传 `{}` —— 运行后果相同。
6. `physics.ts:103` 准确,但 `GRAVITY` 定义在 `:13`;`muOverride` 的形参在 `:85`。其余全部与任务书一致。

**任务书漏掉的一条(CR-21 自身的洞):** CR-21(`:2319-2320`)说「真正零外部消费者的 7 个字段」、`:2314-2316` 说 3 个是「同名不同物」,但 `FoodBuff` 有 11 字段 —— 第 11 个 `critDmg`(`cooking.ts:53`)两处都没提。它**有**消费形状(`weapons.ts:888/915` 的 `BuffInput.critDmg`)且**有测试**(`tests/WS-10.test.ts:1093`),只差 `world_sim.ts:1923` 传参 ⇒ 真实分类是 11 = 7(零消费者)+ 3(同名不同物)+ 1(差一步接线)。

**我未能确认的:**
- `tests/WS-FND-17…:166` FND17-6 的**函数体**我没读 ⇒ 「把 `implemented` 改成 true 会让它红」是推断,不是实测。
- `forgeUnlocked()` 调用点 0 意味着锻造台当前完全不可用(而非只是房间增益不可感);这条我只从「调用点 0」推出,没验证是否有别的入口。
- `docs/CHANGE_REQUESTS.md:300` 记「料理 buff / 三件死道具的玩法裁决 — 需 owner 决定 — CR-21 / task-64 C 待裁」,与 `COMPLETION-CRITERIA.md:155` 的 `[x]` 并存;两处口径是否要同步,我没裁。