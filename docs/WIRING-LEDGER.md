# WIRING-LEDGER · 「实现了、有判据、没接进生产路径」台账

> ### 本文性质与有效期
>
> - **性质:逐轮台账(活索引),不是修复记录。** 本文件没有改任何 `.ts`;「现状」列写「已接」时才表示有生产调用点。
> - **状态源(唯一真值,先看这里):**
>   `server/src/combat/wiring_ledger.ts#COMBAT_WIRING_LEDGER`(combat 段)、
>   `client/src/wiring_ledger.ts#WIRING_LEDGER` + `#WIRED_WITNESS`(client 段)、
>   `server/src/party/actions.ts#PARTY_ACTION_LEDGER`、`server/src/coop/rush_actions.ts#RUSH_ACTION_LEDGER`。
>   判据来源:`tests/WS-FND-118`(combat 双向)、`tests/WS-FND-120`(party/rush `WIRED:` 行必须有调用点)、
>   `tests/WS-FND-121`(client 见证片段)。**本表与代码台账冲突时以代码台账为准,本表跟着改**(§0.2)。
> - **有效期:** §2.10 的四个桶由表体**实算**(`sync-docs.ts::measureWiring()`,与 §2.10 自报值不符即红);
>   其余散文随每轮复核订正,订正句带「★ 第 N 轮」标记。
> - **位置列一律是符号锚(`文件#符号`),不写行号。** 行号已漂过多次(§2.2 的 `world_sim.ts`
>   在同一窗口里从 8796 行漂到 9200+ 行)⇒ 引用时以**符号**为准;行号只在「复算可见」处作提示。
> - **数字纪律:** 本文件只有两类数字 —— (a) §2.10 的桶计数(表体实算,由 `sync-docs` 核对);
>   (b) 「生产调用点 0 / N 处」这类**计数事实**(复算方式见 §1)。
>   用例数 / 套件数 / 行数**不在本文件出现**;要读数请跑 `node scripts/sync-docs.ts --check`
>   (由 `sync-docs --write` 生成,勿手改)。
> - 生成:2026-11-19(第六轮);**第七轮(同日)逐条复核后订正**;第十轮再订正 §2.9。

---

## 0 这份台账解决什么

第六轮的四套判据(`WS-FND-118/119/120/121`)把一批子系统逐条测到「有实现、有判据、全绿」。
但**同一批符号的生产非自身调用点仍是 0** —— 于是同一个词「完成」在三处同时成立、在三处含义不同:

```
模块可达    绿  —— verify.ts 的 import 闭包判定它是边
判据全绿    绿  —— tests 里每个函数都被直接调用过
生产路径    空  —— 除测试与门禁外没有第二个调用者
```

`生产可达性` 只查**文件级** `import` 闭包,查不到「文件可达、符号没人调」;
`入口执行层` 只查 `onMessage` 后面那句 `if (!allowed)`,查不到「handler 调了个空转函数」。
本台账填的是这两道门禁之间的缝:**逐符号**。

### 0.1 ★ 第七轮撤回的两句话(写错了,不是「过期了」)

```
✗ 「`feedPet` 已从「生产 0」变成「生产 1」」
  实测:server/src/** 对 mobs/taming.ts 的 import = **0**;`feedPet` 只有定义
        (`server/src/mobs/taming.ts#feedPet`)与一处注释(`server/src/mobs/intake.ts` 的注释)。⇒ 驯服的生产导入仍是 0(见 §2.3)。

✗ 「`WS-FND-118/119/121` 撰写时不在磁盘上」
  实测:四个套件(118/119/120/121)都在 tests/ 里,且都是 `*.test.ts` 可单跑。
```

⇒ 教训与本表的用途一致:**「某个数字/某个文件在某时刻的样子」不能靠记忆转述**,要用 §1 的命令复算。

### 0.2 状态列的**唯一权威**是三张机器可判的代码台账

本表是**人读的索引**,不是真值源。真值源在代码里,且都有**双向判据**(写错状态就红):

| 覆盖面 | 代码台账 | 判据 |
|---|---|---|
| `server/src/combat/**` | `server/src/combat/wiring_ledger.ts#COMBAT_WIRING_LEDGER`(WIRED / UNWIRED / RESERVED) | `#auditCombatWiring()`:WIRED 要求消费文件里**真有**证据,UNWIRED 要求**任何**其它文件都没有 —— 同一扫描器两个方向 |
| 派对 / 急单动作 | `server/src/party/actions.ts#PARTY_ACTION_LEDGER` · `server/src/coop/rush_actions.ts#RUSH_ACTION_LEDGER` | `tests/WS-FND-120`:标 `WIRED:` 的行必须能在 `sim/world_sim.ts` 里找到调用点 |
| `client/src/**` | `client/src/wiring_ledger.ts#WIRING_LEDGER` + `#WIRED_WITNESS` | `tests/WS-FND-121`:`wired` 必须逐字出现见证片段,`blocked` 必须真的 0 调用点 |

⇒ **两边不一致时以代码台账为准,本表跟着改**(第七轮就是这么做的)。

---

## 1 口径(怎么复算,以及它看不见什么)

```
生产侧 = server/src + client/src + shared
测试侧 = tests
生产引用 = 排除**定义文件自身**后的出现次数(含注释)
```

⇒ **计数是上界**:注释、类型位、同名字符串都算一次。要判「真调用」必须点开那一行看;
本台账的每一行都点开过,「0」表示**连注释都没有**,所以是真 0。

复算(仓根,PowerShell;`rg` 同义):

```powershell
# 1 某符号在生产侧的出现点(排除定义文件)
Get-ChildItem server\src,client\src,shared -Recurse -Filter *.ts |
  Select-String -Pattern '\bskillOf\b' |
  Where-Object { $_.Path -notlike '*combat\weapons.ts' }

# 2 哪些套件钉住它(判据列的来源)
Get-ChildItem tests -Filter *.test.ts |
  Select-String -Pattern '\bskillOf\b' |
  Select-Object -ExpandProperty Filename -Unique
```

★ **判据列 = 「有人在断言它」的证明,不是「它被生产调用」的证明。**

---

## 2 台账

「现状」只用三个词:

| 词 | 含义 |
|---|---|
| **已接** | 有生产调用点(给出文件与符号) |
| **已登记** | 已有白名单位置(给出 `verify.ts` / `orphan-audit.ts` 的符号),或已由门禁按计算式归类 |
| **未接** | 生产调用点 0 **且**没有任何白名单位置 —— 门禁结构上看不见它 |

### 2.1 combat(`server/src/combat/`)

> 状态列**逐条照抄** `combat/wiring_ledger.ts`(唯一状态源)。

| ID | 符号 | 位置(符号锚) | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-CBT-1 | `SkillDef` / `skillOf` / `planSkillHits` | `combat/weapons.ts#skillOf` · `combat/damage.ts#planSkillHits` | **已接**(台账 `skillOf` / `planSkillHits` = WIRED) | 调用点:`world_sim.ts#attackMob`(`useSkill` ⇒ 武器 [Q] 技能;段数取 `plan.ticks.length`、命中区域进 events)。剩余缺口不在战斗侧:**net 没有 [Q] 动作报文**;PvP 仍显式 `skill: null` | WS-10 · FND-118 |
| R6-CBT-2 | `TALENTS` / `activeTalents` / `isTalentUnlocked` | `combat/progression.ts#TALENTS` · `#activeTalents` · `#isTalentUnlocked` | **部分接**:`isTalentUnlocked` 1 处(`world_sim.ts#hasDreamTalent`);台账 `TALENTS` / `activeTalents` = UNWIRED | 天赋表与解锁判据齐备,但「等级天赋生效」没有施加点;唯一被消费的是**梦境天赋**一条。缺的是**玩法裁决**(每条天赋改哪个计算点),不是接线动作 | WS-10 · FND-118 |
| R6-CBT-3 | 反伤:`reflectFrom` / `reflectDamage` / `reflectFloat` | `combat/damage.ts#reflectFrom`(同文件 `#reflectDamage` / `#reflectFloat`) | **已接**(台账 `reflectFrom` = WIRED) | 调用点:`world_sim.ts#resolveMobStrikes`(怪打人 ⇒ 按承伤 × 玩家 `reflectMul` 折算,经 `damageMob` 打回攻击者,反伤可击杀)。`reflectFloat` 仍只有飘字侧未接(见 CBT-6) | WS-10 · FND-118 |
| R6-CBT-4 | 幽灵态:`tickGhostBubble` / `ghostControl` / `ghostDamageMul` | `combat/revive.ts#tickGhostBubble` · `#ghostControl` · `#ghostDamageMul` | **已接**(台账 `ghostControl` = WIRED;`ghostDamageMul` = UNWIRED **且按设计不接**) | 调用点:`world_sim.ts#canActAsPlayer`(两条攻击入口共用 `ghostControl`);`tickGhostBubble` 在世界慢帧。`ghostDamageMul` 与 `vitals.applyHit` 的 `if (v.downed) return` 是**同一条规则**,瞬时真值只在 vitals 手里 ⇒ 接上去就是第二份判据 | WS-10 · FND-111 · FND-118 |
| R6-CBT-5 | 整蛊菜:`cookSoup` / `cleansePrankBuffs` / `PRANK_PRIORITY` | `combat/cooking.ts#cookSoup` · `#cleansePrankBuffs` · `#PRANK_PRIORITY` | **已接**(台账 `cleansePrankBuffs` = WIRED) | `cookSoup` 1 处(`net/actions/craft.ts`);`cleansePrankBuffs` 由 `world_sim.ts#useItem` 的料理分支按内容表 `flags.cleanse` 触发(不写 `itemId === 612` 的第二份判据)。仍缺:`PRANK_PRIORITY` 只在**本模块内**被读(排序),没有第二个读者 | WS-10 · FND-118 |
| R6-CBT-6 | 飘字:`FloatSpec` / `floatText` / `reflectFloat` | `combat/damage.ts#floatText`(同文件 `#float` / `#reflectFloat`;类型 `FloatSpec`) | **未接**(台账 `float` = **RESERVED**:预留) | 伤害结果里带完整飘字规格,客户端**零读者** ⇒ 数据面已就绪、表现面未接(下一步在 UI,不在战斗侧) | WS-10(仅服务端侧) |

### 2.2 world_sim 的三个喂料口(`server/src/sim/world_sim.ts`)

| ID | 符号 | 位置(符号锚) | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-SIM-1 | `startRushRun` | `sim/world_sim.ts#startRushRun` | **已接**(台账 `RUSH_ACTION_LEDGER` 的 `START` = WIRED) | 调用点:`world_sim.ts#stepRushEntry`(慢帧)—— `COZY_CANTEEN` 建成 + 三工位在场 + 有人站在工位格 ⇒ 开工。此前「急单没有『开始』这一下」已消 | WS-11 · FND-120 |
| R6-SIM-2 | `roomLevel` / `stock` 两个必填入参 | `sim/world_sim.ts#startRushRun` · 来源 `coop/rush_actions.ts#RUSH_ENTRY_ROOM_LEVEL` | **已接**(半) | `roomLevel` 有来源(`RUSH_ENTRY_ROOM_LEVEL` = 1,`stepRushEntry` 传入);`stock` 仍传 `{}` —— 台账 `RUSH_ACTION_LEDGER` 的 `ROOM_LEVEL` 行仍是 `EXTRA`(真实等级由房间注入),`stallStock` 也仍未接进急单 | FND-109 · FND-120 |
| R6-SIM-3 | `tended` / `spraying` | `sim/world_sim.ts#tickPartyStep`(该函数里的派生) | **已接** | 慢帧从最近一次翻炒/喷水意图派生工位种类喂给 `tickRushOrder`(D-13)。★ 第六轮记的「喂给一个恒 null 的会话」**已不成立**(SIM-1 接线后会话真的会存在) | FND-61 · FND-120 |

### 2.3 taming(整模块)

| ID | 符号 | 位置(符号锚) | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-TAME | `mobs/taming.ts` 全模块(27 export / `PetRecord` / `feedPet` / `deployPet` / `tickRanch` / `carrySpeedMul`) | `server/src/mobs/taming.ts`(文件级;`#feedPet` / `#deployPet` / `#tickRanch`) | **已登记**(文件级):`verify.ts#UNREACHABLE_EXEMPT` 的可达性项 + 交叉表 · `orphan-audit.ts` 的白名单项 | 生产 `import` 实测 **0**(第七轮复算,见 §0.1),且是**显式回避**(`world_sim.ts` / `systems/wiring.ts` 都写着「不 import taming,它是白名单成员」);缺的是**宿主**:22 个动作里没有 TAME / FEED / DEPLOY。⚠️ `feedPet`(`taming.ts#feedPet`)的调用点仍是 0 | WS-04 · FND-29 · FND-41 · FND-46 |

### 2.4 party 的五个 settle(`server/src/party/modes.ts`)

★ 五条同一成因、同一修法:**`mode.settleHook` 是唯一钩子**,由 `#settlePartyRun`
在相位走到 `SETTLED` 时调用(同帧),而 `#tickPartyMode` ← `world_sim.ts#tickPartyStep`(慢帧)。

| ID | 符号 | 位置(符号锚) | 现状 | 理由(调用点) | 判据 |
|---|---|---|---|---|---|
| R6-PARTY-S1 | `settleBridgeRun` | `party/modes.ts#settleBridgeRun` | **已接** | `mode.settleHook = () => settleBridgeRun(run)`(在 `#settlePartyRun` 里接线)← `settlePartyRun` ← `tickPartyMode` ← 世界慢帧 | WS-11 · FND-120 |
| R6-PARTY-S2 | `settleJellyBall` | `party/modes.ts#settleJellyBall` | **已接** | 同上,钩子在该模式的 `settleHook` 赋值点(同文件) | WS-11 · FND-120 |
| R6-PARTY-S3 | `settleCrown` | `party/modes.ts#settleCrown` | **已接** | 同上,钩子在该模式的 `settleHook` 赋值点(同文件) | WS-11 · FND-120 |
| R6-PARTY-S4 | `settlePaintWar` | `party/modes.ts#settlePaintWar` | **已接** | 同上,钩子在该模式的 `settleHook` 赋值点(同文件) | WS-11 · FND-120 |
| R6-PARTY-S5 | `settleRace` | `party/modes.ts#settleRace` | **已接** | 同上,钩子在该模式的 `settleHook` 赋值点(同文件) | WS-11 · FND-120 |

### 2.5 party 的三个动作

| ID | 符号 | 位置(符号锚) | 现状 | 理由(调用点) | 判据 |
|---|---|---|---|---|---|
| R6-PARTY-A1 | `crownPickup` | `party/modes.ts#crownPickup`(取冠判定 `#contestCrownPickup`) | **已接**(`PARTY_ACTION_LEDGER` 的 `CROWN_PICKUP` = WIRED) | 链:`world_sim.ts#stepPartyContest`(慢帧,玩家站在 434 底座格 + 队伍已由 435 登记)→ `contestCrownPickup` → `crownPickup` | WS-11 · FND-120 |
| R6-PARTY-A2 | `bridgeCapture` | `party/modes.ts#bridgeCapture`(夺取判定 `#contestCapture`) | **已接**(`CAPTURE_FLAG` = WIRED) | 链:`world_sim.ts#stepPartyContest`(冲刺阶段 + 站 435 旗 + 本队桥板 ≥ `BRIDGE_TILES_TO_WIN`)→ `contestCapture` → `bridgeCapture` | WS-11 · FND-120 |
| R6-PARTY-A3 | `submitDelivery` | `coop/rush_order.ts#submitDelivery` | **已接**(`RUSH_DELIVER` = WIRED) | 链:`world_sim.ts#stepRushDelivery`(慢帧,玩家脚下 1 格内有订单点名的地面货 ⇒ 扣货 + 交付) | WS-11 · FND-120 |

### 2.6 prank 玩具表

| ID | 符号 | 位置(符号锚) | 现状 | 理由(调用点) | 判据 |
|---|---|---|---|---|---|
| R6-PRANK-1 | `PRANK_TOYS` / `toyOf` | `prank/toys.ts#PRANK_TOYS` · `#toyOf` | **已接**(表被真消费;**35 件里只有 3 件走到生产**) | 链:`world_sim.ts`(掉冠判定 `gateCrownKnock`)→ `party/actions.ts`(值导入 `prank/actions.ts`)→ `prank/actions.ts`(`toyOf` 三处调用,`PRANK_ACTION_LEDGER` 由 `PRANK_TOYS` 逐条生成)→ `toys.ts`。★ 台账 `WIRED_PRANK_PATHS` 只登记 **222 / 224 / 225**(走 `crown_knock`),其余 32 件是 `NONE`(出路 = `net/actions/use_item` 的 221..255 分支)。`verify.ts` 的 `UNREACHABLE_EXEMPT` 已把 `prank/toys.ts` / `immunity.ts` 从「等施加整蛊的宿主」白名单里**摘除**(宿主已在) | WS-11 · FND-120 |
| R6-PRANK-2 | 缺的那一半:`applyPrank`(施加端) | 全仓不存在(`grep` 0 命中) | **未接**(无实现) | 表、免疫、结算与掉冠判定都在,但「玩家对玩家用玩具」没有任何模块承担;`PARTY_ACTION_LEDGER` 的 `PRANK` 行仍是 `NONE:net/actions/use_item 的 221..255 分支` | WS-11 |

### 2.7 social 四段(`server/src/social/afk.ts`;手册 §6.4)

> ★ **WS-FND-149 登记口径**:这一节四条的「现状」列**刻意保留 `未接`** —— 它们是
> 「**预留·不做**」(登记写在**理由列** + `afk.ts` 每段标题的 `〔RESERVED〕` 标记里,
> 不写成 `已登记`)。
> 为什么不进 `已登记` 桶:`已登记` 指「已有白名单位置 / 由门禁按计算式归类」,
> 而这四段**没有任何门禁位置**,桶计数 (`§2.10` / `README`) 按现状列实算 ——
> 改成 `已登记` 会同时改三处数字,却不会让任何人多接一条。**欠账就是欠账。**
> 判据:`tests/WS-FND-149-arch-hazards.test.ts`(FND149-1..4)双向钉住 ——
> `RESERVED` 段必须**生产侧 0 引用**,`WIRED` 段(第 1 段"打盹攒露水",被
> `world_sim.ts#setPlayerDozing` 消费)必须**真有消费者**。谁接线谁翻标记,当场提示。

| ID | 段 | 符号 | 位置(符号锚) | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|---|
| R6-SOC-1 | 水族箱 | `VIVARIUM` / `createVivarium` / `tickVivarium` / `WHITE_NOISE_MIX` | `social/afk.ts#createVivarium`(表 `#VIVARIUM`) | **未接** | **预留·不做**(`afk.ts` 第 2 段 `〔RESERVED〕`):镜头序列表与白噪音混音表只是**参数**,真正"隐藏 UI 的微缩景观"要**客户端 renderer** 与音频宿主;`three/boot.ts` 不读 `VIVARIUM` ⇒ 缺的是一整个表现层,不是一条接线 | WS-11 · FND-149 |
| R6-SOC-2 | 信箱 | `createMailbox` / `leaveMail` / `pruneMailbox` / `badgeFor` | `social/afk.ts#createMailbox` | **未接** | **预留·不做**(第 3 段 `〔RESERVED〕`):缺「离线玩家存档容器 + 信箱 UI」——`net/room` 的存档只有 world / player 两块,动作面也没有 MAIL 类动词 | WS-11 · FND-149 |
| R6-SOC-3 | 摊位(上架行) | `createStall` / `listItem` / `buyFromStall` / `suggestedPrice` | `social/afk.ts#createStall` | **未接** | **预留·不做**(第 4 段 `〔RESERVED〕`)。★ **同名异义已改名消歧**:这四段是「上架行」模型(卖家 / 单价 / 跨房 5% 抽成),原来撞名的 `world_sim.ts#stallStock` 现名 **`depotStock`**(515 百货机的**库存**,`物品 id → 件数`);515 的成交权威只有 `systems/depot.ts`(幂等键 `CLOUD_DEPOT@ORDER:*`),且动作面没有 LIST / BUY ⇒ 本段不接 | WS-11 · FND-149 |
| R6-SOC-4 | 赛道(社交展示) | `createTrack` / `trackStart` / `trackFinish` / `trackStandings` | `social/afk.ts#createTrack` | **未接** | **预留·不做**(第 5 段 `〔RESERVED〕`)。★ **两套赛道边界已裁决**(写在 `party/modes.ts` §5 与 `afk.ts` 第 5 段):`party/modes.ts#RaceRuntime` = **玩法与结算**的唯一权威(发奖 / 播报 / `PartySettlement`);本段 = **罚时视图**(风筝 Boss 追上 +3s 后的耗时),**没有 `tick`** ⇒ 两者不可能同时推进同一 tick;毫秒表共用 `party/scoring.ts#RaceTimer` | WS-11 · FND-149 |

### 2.8 shared(`shared/**`)

| ID | 符号 | 位置(符号锚) | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-SH-1 | `EncodeStats`(网络增量那个) | `shared/net/delta.ts#EncodeStats` | **已登记**(同名异义):`verify.ts` 的同名异义白名单项 | 与 `build/blueprint.ts` 的 `EncodeStats` 只是名字撞了;生产里出现的真实消费全是**蓝图那个** ⇒ 网络编码度量生产 0 消费者 | WS-07 · FND-99 |
| R6-SH-2 | `StateFlagIndex` | `shared/types/wire.ts#StateFlagIndex` | **未接**(生产 0) | 客户端解 `u8` 状态位的第一张词表;`predictor.ts` 只 import `STATE_FLAG_NAMES`(名字表)⇒ 状态位解码只做了一半 | WS-07 |
| R6-SH-3 | `FSM_NAMES` | `shared/types/wire.ts#FSM_NAMES` | **未接**(生产 0) | 同上:`wildlife.fsm` 的离线索引 0 消费者 | WS-07 |
| R6-SH-4 | `shared/types/events.ts`(整模块) | `shared/types/events.ts` | **已登记**(gate-only):`verify.ts#UNREACHABLE_EXEMPT` + 交叉表 | 29 个事件名的 SSoT;生产侧事件名仍是扁平字符串 ⇒ 接线动作是「换名字来源」,属编排层 | FND-66 |
| R6-SH-5 | `shared/types/cooking.ts` | `shared/types/cooking.ts` | **已登记**(差集型):`verify.ts#UNREACHABLE_EXEMPT`(计算式 `isDiffSet()` 成立,自检在同文件) | 只被 `shared/constants/cooking.ts` 引用,后者不可达;生产本批只接了 `defFlat` / `expMul`,其余 4 槽等编排层 | FND-66 |
| R6-SH-6 | `shared/constants/cooking.ts` | `shared/constants/cooking.ts` | **已登记**(gate-only):`verify.ts#UNREACHABLE_EXEMPT` + 交叉表 | 6 槽中性值表,生产直接 importer 0;反向类型引用不算消费 | FND-66 |
| R6-SH-7 | `diffChunkVersions` | `shared/net/delta.ts#diffChunkVersions` | **未接**(生产 0) | 按 chunk 版本做差量下发;没有调用者 ⇒ 客户端把每个 chunk 都当新档收。`schema.colyseus.ts` 只把 `chunkVersions` 拼成字符串,不做差量 | WS-07 |

### 2.9 client(`client/src/**`)

> 状态列与调用点**逐条照抄** `client/src/wiring_ledger.ts`(唯一状态源,含见证片段)。

| ID | 符号 | 位置(符号锚) | 现状 | 理由(调用点) | 判据 |
|---|---|---|---|---|---|
| R6-CL-1 | `renderPos` / `poseView` / `visualOffset` | `net/predictor.ts#renderPos` · `#poseView` · `#visualOffset` | **已接** | 链一(**具名**读者):`main.ts#__stageReady` 读 `predictor.renderPos`(进自检口径);链二(**渲染**读者):`main.ts` 把 `predictor.poseView` 交给 `three/boot.ts#setPoseSource`,`three/boot.ts#tick` 每帧拉 `poseSource()` 并用 `predicted.render` 定立牌位置。★ **第十轮补查(grep 口径)**:`renderPos` 这个**名字**在 `client/src` 只有 3 处 —— 定义(`net/predictor.ts#renderPos`)、`poseView()` 内部读它、`main.ts#__stageReady`;**`boot.ts` 不按名字读它**(它读的是 `poseView().render`)⇒ 旧文「`main.ts` 与 `three/boot.ts` 消费 `renderPos`」**只对一半**。★ `poseView()` 的 4 个字段:`.render` / `.visualOffset` / `.logical`(自检口径 `boot.ts#summary.predictedLogical`)各有读者,**只剩 `.ackedSeq` 仍是 0 读者**(ack 数走 `predictor.lastAckedSeq` / `store.lastAckedSeq`) | FND-113 · FND-16 |
| R6-CL-2 | `three/stage_assembly.ts` 的 14 个 export | `three/stage_assembly.ts`(文件级;符号名见右列) | **部分接**:4 个(`buildChunkGeometry` / `buildOrthographicCamera` / `buildTerrainMaterial` / `syncTerrainCamera`) | 另 9 个零消费者:`createStage` · `buildShaderMaterial` · `buildPixelTexture` · `buildBillboard` · `attachAuraEmitters` · `applyDyeUniforms` · `gridToVector3` · `projectedToVector2` · `assemblySource` ⇒ 立牌/粒子/染色/拾取投影都还没有渲染入口(台账 `blocked`,每条都有原因) | WS-09 · FND-73 · FND-89 · FND-121 |
| R6-CL-3 | `DragController.drop()` | `ui/state_machine.ts#DragController.drop` | **已接**(台账 `drop` = wired,见证 `dragCtl.drop(hover)`) | 调用点:`three/boot.ts#onUiPointerUp`(★ 改**符号锚** —— 旧文写的行号已漂) —— 抬手**成交**,并把成交凭证写进 `#hint` 与自检口径。修前全 client 零调用(松手走 `cancel()`,永远放不下) | WS-09 · FND-121 |
| R6-CL-4 | `slotTooltip` → `tooltipFor` | `ui/inventory.ts#slotTooltip` · `three/ui_binding.ts#tooltipFor` | **已接**(台账 `tooltipFor` = wired,见证 `this.tooltipFor(`) | 调用点:`three/ui_binding.ts#drawNotes`(悬停格的物品说明) | WS-09 · FND-121 |
| R6-CL-5 | `isoCam.zoom` / `snapZoom` / `stepZoom` / `ZOOM_LEVELS` | `stage/iso_camera.ts#stepZoom` · `#snapZoom` · `#ZOOM_LEVELS` | **已接**(台账 `stepZoom` = wired,见证 `stepZoom(isoCam,`) | 调用点:`three/boot.ts#onKeyDown`(键盘 `[` / `]`;★ 改**符号锚** —— 旧文写的行号已漂)= 6 档缩放唯一的写点。修前无输入绑定 ⇒ 生产 `zoom` 恒 1 | WS-09 · FND-121 |

> **`R6-CL-6`(`#hint` 提示条)整条撤回**:第七轮实测该元素**有**读点与写点 ——
> `three/boot.ts` 的 `document.getElementById('hint')` 与 `hintEl.textContent = text`,
> 且每帧由 `uiState()` 汇总写入(缩放档位 / 查询串 / 拖拽成交 / 派对比分)。
> ⇒ 「元素在 DOM 里,代码从不读它」是**错的**。
> ⚠️ 剩下的事实只有一条(`ui/panel_layout.ts` 的 `PITCH_BOTTOM_CLEARANCE = 56` 仍是写死的下限),
> 那是**布局常数**的小欠账,不构成一条符号级「未接」⇒ 不留在本台账。

### 2.9.1 客户端**入口**台账(`CLIENT_ENTRY_LEDGER` + `CLIENT_ENTRY_HOLDS`,★ WS-FND-145)

> 这一节是 §2.9 的**动作级**补充:§2.9 问「`client/src` 里的符号有没有被调用」,
> 这一节问「**玩家按得到吗**」。唯一状态源是 `client/src/wiring_ledger.ts`
> (`CLIENT_ENTRY_LEDGER` 逐动作覆盖 `RoomAction` 的 24 条;
> `CLIENT_ENTRY_HOLDS` 是那 7 条仍 `missing` 的登记;`CLIENT_ENTRY_GAPS` 是非 `RoomAction` 的两条)。
> 判据:`tests/WS-FND-138`(逐键覆盖 + `wired` 见证片段)与 `tests/WS-FND-145`(登记 + 零入口 + 契约)。

**裁决口径**:第十轮补上 `1`/`2`/`3`/`4` 四条、第十一轮(WS-FND-151)把 `SET_PARTY_MODE`
接上 `M` 模式面板之后,**仍有 7 条**房间管理类动作缺的不是"一行转发",而是那块 UI
(表单 / 成员表 / 确认框 / 线框数据);UI 缺席时接一个裸键 = 一次误触改掉**整个房间**的状态
(其中一半不可逆)⇒ **刻意不提供**,`missing` 这个状态因此保留(它描述"玩家按不到"这个事实),
但每条都必须在登记表里有 `why` / `unblock` / `today` 三段,否则 `validateClientEntryLedger()` 当场红。

★ **`SET_PARTY_MODE` 已接线**(台账 `wired`,对应登记已删)。下表把它**留档**但判定列写「已接」:
文档滞后比代码滞后更贵 —— 代码里已有入口而文档说"没做",后来者会去补第二套 UI。判据
(`FND145-10`)钉的正是"判定列不许再写刻意不提供",而**不是**把这一行删掉。

| 动作 / 缺口 | 判定 | 为什么刻意不提供 | 解锁它的那一件事 | 玩家今天能做到哪一步 |
|---|---|---|---|---|
| `SET_ROOM_ACCESS` | 刻意不提供 | 要房主表单(三选一 + 口令输入 + 回执回读),客户端没有任何房间管理 UI | 房间面板:模式单选 + 口令输入 + `effect.mode` 回读 | 做不到 |
| `SET_PARTY_MODE` | **已接**(★ WS-FND-151) | 修前缺的是**选择器 + 权限位**:裸键表达不出"选哪一档",而模式影响全房(含正在跑的那局) | 已完成:`ui/party_panel.ts` 列出冻结层 `PARTY_MODES` 的全部模式,`net/action_entry.setPartyMode` 发 `{ action, partyMode }` | `M` 开面板、`J`/`L` 选、`Enter` 定(权限由服务端 `authorize` 判,被拒有回执) |
| `KICK_MEMBER` | 刻意不提供 | 踢人不可逆;快照 `PlayerState` 没有 role 字段,列表只能靠猜 | 先下发成员角色,再做成员表 + 踢人按钮 | 做不到 |
| `SET_MEMBER_ROLE` | 刻意不提供 | `role` 是服务端权限位枚举,快照里没有 ⇒ 表达不出"把谁改成什么" | 成员表(数据来自快照)+ 角色下拉 | 做不到 |
| `RESET_WORLD` | 刻意不提供 | 不可逆;服务端要 `confirm: true` 字面量(= 二次确认),客户端没有确认框 | 确认对话框(当前种子 / 新种子)挂进房间面板 | 做不到 |
| `CLOSE_ROOM` | 刻意不提供 | 不可逆(全房被踢);`close()` 是生命周期方法,权限闸在 `actions/admin.ts` | 同 `RESET_WORLD`:面板 + 二次确认 + 权限位 | 做不到 |
| `MODIFY_TOWN` | 刻意不提供 | 要 `radius` / `name` / `totemCell` 三个自由输入,客户端没有拾取坐标的 UI 与文本输入口 | 城镇面板:点格取 `totemCell` + 半径滑杆 + 名字输入 | 做不到 |
| `WIRE_EDIT` | 刻意不提供 | 服务端不下发线框数据 ⇒ 没有可编辑的对象(`dir` / `color` / `channel` / `clear` 都相对它才有意义) | 先下发 WireView,再做接线面板 | 做不到 |
| 急单(rush)开局与交付 | 刻意不提供(世界侧自动) | 三段(`startRushRun` / `submitDelivery` / `settleSession`)全在 `world_sim.tickPartyStep`,都不需要客户端报文 | 不需要新键:玩家侧是工位(`Q` + WASD)与丢货(`G`,`RUSH_DELIVERY_RADIUS = 1`) | 建造工位 → 站上去 → 丢货 = 开工/交付;评级经回执 `effect.rushGrade` 进状态条 |
| 分拣带 `lane` 配置 | 刻意不提供 | `lane` **不在** `ActionPayload` 契约里(`room.ts` 那一格只有 `kind`)⇒ 客户端不替它发明字段 | 先给 `lane` 一个契约位置,再做接线面板 | 键盘 `4` 只走播种形态 |
### 2.10 汇总(按「现状」)

> ★ 第七轮订正:**上一版写「合计 34」,而表体实测 37 行**(算术与表体不一致,且 `CL-6` 那条本身是错的)。
> 本轮按符号逐条复核后 `CL-6` 撤回 ⇒ 表体 **36 行**。下表三格全部按 36 重算。
> ★ 本表由 `sync-docs.ts::measureWiring()` **对表体实算并核对**(不符即红),不是手写合计。

| 现状 | 条数 | 其中仍含「未接」的一半 | 说明 |
|---|--:|--:|---|
| 已接 | 20 | 4 | SIM-1/2/3 · PARTY-S1..S5(5) · PARTY-A1..A3(3) · CBT-1/3/4/5 · CL-1/3/4/5 · PRANK-1;含「半」的 4 条 = **SIM-2**(`stock` 无来源)· **CBT-4**(`ghostDamageMul` 按设计不接)· **CBT-5**(`PRANK_PRIORITY` 只本模块内读)· **PRANK-1**(35 件玩具里 32 件 `NONE`) |
| 已登记 | 5 | 0 | R6-TAME · R6-SH-1/4/5/6(4 条) |
| 部分接 | 2 | 2 | R6-CBT-2(天赋)· R6-CL-2(`stage_assembly` 9/14) |
| 未接(符号级,门禁看不见) | 9 | 9 | CBT-6 · SH-2/3/7 · PRANK-2 · SOC-1..4 |
| **合计** | **36** | **15** | 15 = 9 全未接 + 2 部分接 + 4 已接里仍含未接的一半 |

★ 这 15 条**不进任何现有分母**:`生产可达性` 是**文件级**,这些符号所在的文件大多**可达**。

---

## 3 如何被门禁引用(按粒度选,别混用)

本台账自己**不参与** `verify.ts` 的退出码。要让某条变成机器钉住的事实,只有三条路,
粒度由「不可达的单位是文件还是符号」决定。

### 3.1 文件级 —— 整个模块不可达 ⇒ `scripts/verify.ts#UNREACHABLE_EXEMPT`

```ts
// scripts/verify.ts 的可达性白名单 `UNREACHABLE_EXEMPT`(按**符号名/文件路径**定位,不按行号)
['server/src/mobs/taming.ts',
  'WS-04 牧场驯服,等宠物容器 + 驯服交互(feedPet 零生产调用);'
  + '逐符号现况见 docs/WIRING-LEDGER.md#r6-tame'],
```

同时**必须**在交叉表(同文件的交叉清单)同改,否则 `checkOrphanList` /
`checkWhitelistCross` 两面互不认账。两处都改完的形态见 `taming` 的现成样板。

### 3.2 符号级 —— 文件可达、只有这个符号没人调 ⇒ `scripts/deadcode-audit.ts#KNOWN_BACKLOG`

```ts
// scripts/deadcode-audit.ts 的 KNOWN_BACKLOG(按符号名匹配)
{ symbol: 'crownPickup',
  ledger: 'WIRING-LEDGER.md#r6-party-a1',
  reason: '已知未接:唯一调用者是测试;生产 0 调用点(world_sim.ts 文件头明写)。'
        + '接线点在动作层(22 个 RoomAction 里没有拾冠),不在 sim。' }
```

匹配口径是 `symbol.split('::').pop()`(`#KNOWN_BACKLOG` 的匹配段)⇒ **同名函数会被一起归并**,
登记前先 `Select-String -Pattern '^\s*(export )?function crownPickup' -Path (server,client)` 确认只有一个。
若整文件都是「刻意不驱动」,用 `#DELIBERATE_EXCLUSIONS` 的 `target: 'file::symbol'`。
⚠️ `crownPickup` 现在是**已接**(§2.5),上面只是**格式样板** —— 照抄之前先看清状态列。

### 3.3 死道具形状 —— 要写「缺什么」+「消费点是否存在」⇒ `scripts/dead_items.ts`

```ts
{ id: 0, name: '...', implemented: false, consumer: null,
  reason: '使用入口已接(...),仍缺:...(≥20 字,不许 TODO 开头)' }
```

判据是 `#reasonVerdict`(拒空 / 拒 <20 字 / 拒 `todo|tbd|待办|待补|以后再说` 开头)
与 `#consumerVerdict`(出现的每个 `*.ts` 路径**必须真的存在**)。
⇒ 本台账「位置」列里的**路径**可直接抄进 `consumer`;「理由」列可直接抄进 `reason`
(⚠️ 符号锚里的 `#符号` 部分不要抄进 `consumer`,那里只认路径)。

### 3.4 引用时的四条硬约束(踩过)

```
1 理由文本会被 WL_* 裸正则**自动分桶**(verify.ts 的 WL_* 段,按符号名/常量名定位):
    命中「待接 / 等编排层接线 / 待客户端接线」        ⇒ 等编排层接线
    命中「随...接 / 尚未注入 / 被...聚合 / 等...(层|容器|线|运行时|宿主|驱动|管线)」 ⇒ 等机制
    命中「本仓无装配入口 / 客户端子系统」            ⇒ 等客户端入口
    ⇒ 想换桶就**改措辞**,不要改台账(台账是事实,桶是分类)。
2 理由里**禁止**出现「差集」二字:WL_NON_DEBT_DIFF_TEXT 是裸正则,且
   verify.ts 会拿它和**计算式 isDiffSet()** 做双向自检 ——
   声称是差集但计算式不成立 ⇒ 红;写「不是差集」也会被裸正则判成同一类 ⇒ 红。
3 一个**可达模块内部**的符号**不能**进 UNREACHABLE_EXEMPT:那是文件级表,
   自检只查「文件不存在 / 已可达」,放进去只会得到「已可达却仍在白名单」的假红。
4 别在 tests 里断言本台账的内容 —— 那是**文字判据**,
   什么也不剥就能被注释掉、被改写后照样绿(WS-FND-117 已两次证明这类判据没有牙)。
   ⇒ 引用本台账的正确产物是**上面三种结构化登记**,不是一条 `includes('R6-CBT-1')`。
```

---

## 4 本轮的定性结论(与 AUDIT-W34 §13 同一句)

> **多个系统「有实现、有判据、全绿,但没接进生产路径」。**
> 「全绿」在第六轮被证明**不足以**支撑任何一句「可用」。
> 第七轮复核把这句话**收紧**了一层:36 行里 **15 行仍含未接的一半**、其中 **9 行整条未接**,
> 而这 9 行里有 **8 行所在模块在可达闭包内**(`damage.ts` / `shared/types/wire.ts` /
> `shared/net/delta.ts` / `social/afk.ts`),第 9 行(`PRANK-2 applyPrank`)连实现都没有。
> ⇒ 以后写「X 可用」之前,先回答「X 的生产非自身调用点是多少」;答不出就不是可用,是**已实现**。

---

## 5 下一处接线点(按代价升序,不是排期)

```
1 R6-CBT-6 飘字:服务端数据面已就绪,缺的是客户端 UI 读 floatText(纯表现层)
2 R6-SH-2/3 状态位/FSM 词表:客户端解码侧换成索引表(单文件)
3 R6-SOC-1..4 社交四段:镜头/混音宿主、离线存档容器、BUY/LIST 动作(需玩法裁决)
4 R6-CBT-2 天赋:每条天赋改哪个计算点(table 里逐条裁决)
5 R6-PRANK-2 applyPrank:玩具施加端 + use_item 的 221..255 分支(牵动动作层)
6 R6-TAME:宠物容器 + TAME 动作(牵动存档结构,最后做)
```