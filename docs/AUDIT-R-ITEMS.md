# AUDIT-R-ITEMS · §4 R1–R22 决策台账

> ### 本文性质与有效期
>
> - **性质:逐轮台账(活索引)。** 一行 = 一条 2026-11-18 审计的**未修项**(`docs/AUDIT-W34.md` §4 的 R1..R22)
>   自那以后的处置结果。它不是当前状态,也不是判据本体 —— 它回答「这条今天算不算已处置、凭哪份判据」。
> - **状态源(唯一,先看这里):** (a) `docs/AUDIT-W34.md` §9–§14 的逐批处置节(每条点到判据编号);
>   (b) 代码符号本身(本表「位置」列给的就是锚);(c) `tests/WS-FND-9x` / `WS-FND-98` / `WS-FND-100` / `WS-FND-101`
>   套件里的条目号。**本表与代码冲突时以代码 + 套件为准,本表跟着改。**
> - **有效期:** 每条都写着 `Pxx` 台账号与判据名;判据名在 = 可复核,判据名不在 = 退回「登记」。
>   「现状」列的证据是**套件条目号**(可点开),不是本文件的叙述。
> - **数字纪律:** 本表出现的实测数字(如击退钳制 **2 格**、快照上限 **1 MiB**、抗性待平衡 **0.5**)
>   都是**代码里的常量值**,不是文档抄来的统计数;统计类数字(用例 / 套件 / 行数)一律不在本文件出现,
>   要看请跑 `node scripts/sync-docs.ts --check`(由 `sync-docs --write` 生成,勿手改)。
> - **本文件不参与** `verify.ts` 的退出码。

> 来源:`docs/AUDIT-W34.md` §4「未修项(逐条理由)」。
> 口径:每行一条决策;**22 条全部已修,差别只在判据来源**(R1/R2 走抗性链路的两套判据,R3 走击退钳制,
> R14/R18 走 `WS-FND-100`,R22 走 `WS-FND-101`,其余走第二/三批的 `WS-FND-91/92/94/95`)。
> 「代价」按改动面估(低 = 单函数/单文件;中 = 跨 2–3 处或需先定常数;高 = 需玩法/视觉裁决 + 多文件),
> 是**修之前**的估价,保留供回溯。
> 生成方式:只读审计稿与代码,未改任何代码或其它文档。

## 台账(R1–R22)

### 列含义

- **位置 —— 一律是符号锚:`文件#符号`(必要时附 `#常量名`)。**
  ★ 2026-11-18 行号曾逐行重算过;2026-11-19 第七轮起 `world_sim.ts` 又被其它写者改到 9000+ 行,
  **行号从此不写** —— 它已经漂过三次(30~260 行),而每次重算都要读代码、每次读都有新的漂移。
  符号锚的复算方式:`Select-String -Pattern '^\\s*(export )?(function|const|class) <符号>' -Path <文件>`;
  常量与类成员同理。**行号是提示,符号才是判据。**
- **现状 —— 只有两态了:已修**(括号内 = 原台账编号 `Pxx` + 判据套件与条目)。「登记」在本批已清零。
- **代价 / 建议 / 影响面** —— 代价是修前的估价;**建议列已改成「结果」**(一句话说清这条今天是什么状态),
  不再是排期建议。

| ID | 原始发现(一句话) | 位置(符号锚) | 现状(已修/登记) | 修它的代价(低/中/高) | 我的建议/处置(一句结果) | 影响面(改哪个模块) |
|---|---|---|---|---|---|---|
| R1 | 元素抗性整条链「写入侧」无生产写入 ⇒ `setElementResist` 恒无输入,抗性 no-op | 写入点 `server/src/combat/vitals.ts#setElementResist`;推送 `server/src/rooms/effects.ts#pushRoomElementResist`;调用点 `server/src/sim/world_sim.ts#tickRoomEffects`(符号名以代码为准:`applyRoomEffects` 全仓 0 命中) | 已修(判据 WS-FND-93:1/3/5/6 + WS-FND-97:1..6 · P2-1) | 低 | 已完成 — 写入侧有生产调用点(`roomAtCell` 定位 → 推送),读取侧 `applyHit` 因此才有 `element` 输入;剩下的 `PENDING_ELEMENT_RESIST_MUL = 0.5` 是数据待平衡,不是接线 | combat/vitals.ts + rooms/effects.ts |
| R2 | 元素抗性整条链「读取侧」`applyHit` 的抗性无生产写入点 | `server/src/combat/vitals.ts#applyHit`(取用点 `resistMul` 在同一函数内) | 已修(判据 WS-FND-93:1/2 + WS-FND-97:3/4 · P2-2) | 低 | 已完成 — 倍率在读取侧真被消费,且换房/进未登记房/出房都有撤销路径(FND97-4/5);数值待平衡同 R1 | combat/vitals.ts |
| R3 | 击退无上界钳制 + `mass=NaN` 可经客户端自报质量传播 | 钳制 `server/src/sim/world_sim.ts#KNOCKBACK_MAX_CELLS`(钳制点在同一函数里的 `Math.min`)、`#applyKnockback`;质量归一 `server/src/physics/world.ts#applyImpulse` / `#safeMass` / `#spawn`(碰撞质量归一在同一函数内) | 已修(判据 WS-FND-98:1..8 · P2-3) | 中 | 已完成 — 总位移钳到 `KNOCKBACK_MAX_CELLS` = **2 格**(D-09 同量级,不是新裁决),非法质量经 `safeMass` 拒绝、不再产出 `NaN` 冲量;1e9 格击退也只推 2 格 | sim/world_sim.ts + physics/world.ts |
| R4 | `resetWorld` 不按等级重算 HP 上限(下一帧 `maxHpForLevel` 才覆盖回,窗口 1 tick) | `server/src/sim/world_sim.ts#resetWorld`(抬上限复用 `#maxHpForLevel` + `#syncMaxHp`) | 已修(判据 WS-FND-91:7 · P2-4) | 低 | 已完成 — 重置序列自己重算上限,1 tick 窗口已消 | sim/world_sim.ts |
| R5 | 玩家→生物攻击无视线闸(越墙打怪) | `server/src/sim/world_sim.ts#losBlocked`(两处调用:玩家→生物 / PvP) | 已修(判据 WS-FND-91:1/2 · P2-5) | 低 | 已完成 — 热路径接 `world/vision.ts` 视线闸,并带预算化指标 | sim/world_sim.ts + world/vision.ts |
| R6 | 攻击侧不封 `TRAPPED`/`STUNNED`(被夹住/定身仍能挥刀) | **已漂移**:原指 `server/src/net/actions/attack.ts`,该文件现为 14 行 stub(恒 `NOT_IMPLEMENTED`);真正的闸在 `server/src/sim/world_sim.ts` 的 `TRAPPED`/`STUNNED` 状态机(符号 `#canActAsPlayer`;玩家→生物与 PvP 各一处) | 已修(判据 WS-FND-91:3..6 · P2-6) | 低 | 已完成 — 移动侧/攻击侧两台状态机同源同拒因(`TRAPPED`/`STUNNED` 逐条对得上) | sim/world_sim.ts |
| R7 | `purchaseCommit` 无幂等键 ⇒ 重放同一次购买重复成交 | `server/src/sim/world_sim.ts#purchaseCommit`;动作侧 `server/src/net/actions/buy_item.ts`(符号 `PurchaseCommitWithKey`) | 已修(判据 WS-FND-91:8/9/10 · P2-7) | 低 | 已完成 — 幂等键已加,回执 `stock` 取「提交时实测」,不再用报价快照(§7.3) | sim/world_sim.ts + net/actions/buy_item.ts |
| R8 | 箱子存取不比距离(能远程开箱) | `server/src/net/actions/open_chest.ts#CHEST_REACH` + 同文件的距离闸(在同一 handler 内) | 已修(判据 WS-FND-92:1..5/10 · P2-8) | 低 | 已完成 — 交互半径成了具名常量,距离按**权威位置**判 | net/actions/open_chest.ts |
| R9 | `place_automation` 不扣件(放置零消耗) | `server/src/net/actions/place_automation.ts`(符号 `spend`:先扣后登记) | 已修(判据 WS-FND-92:6..9 · P2-9) | 低 | 已完成 — 按 `placeBlock` 口径「先扣背包、再写世界」 | net/actions/place_automation.ts |
| R10 | `snapshot_blob` 写库无上限(极端账号撑大库) | `server/src/db/repo.ts#assertReconnectSnapshotSize`(写点 `#saveReconnectSnapshot`;世界归档 `#archiveWorldSnapshot`) | 已修(判据 WS-FND-94:2a/2b · P2-10) | 低 | 已完成 — 1 MiB 同口径上限卡在写口,世界归档与快照共用同一把尺 | server/src/db/repo.ts |
| R11 | `fluid.clone()` 丢活跃集(读回后水不再自流) | `server/src/world/fluid.ts#clone` | 已修(判据 WS-FND-94:4a/4b/4c · P2-11) | 低 | 已完成 — clone 带活跃集,回放/存档后水照样自流 | server/src/world/fluid.ts |
| R12 | `physics.spawn()` 覆盖同 id 不清旁表(`belt`/`carry`/`carrySlot`) | `server/src/physics/world.ts#spawn`(回收口径 `#reclaimSideTables`) | 已修(判据 WS-FND-94:5a/5b · P2-12) | 低 | 已完成 — `spawn` 与 `remove` 同口径回收旁表,覆盖同 id 不留残影 | server/src/physics/world.ts |
| R13 | `ticks`/`seq` 无上界(可回绕/写错字节) | `shared/net/delta.ts#assertU32`(tick 的调用点在 `#encodeDelta`)、`#MAX_ACKED_SEQ`;`server/src/net/ws_server.ts#parseMoveIntent`、`#ackSlotValue` | 已修(判据 WS-FND-95:4..7 · P2-13) | 低 | 已完成 — 口径是**抛错/拒**(不是绕比),双端已落地(§8.1) | shared/net/delta.ts + server/src/net/ws_server.ts |
| R14 | `applyRestore` 的 chunk 解码在闸后且无 `try`(坏档异常分类不干净) | `server/src/sim/world_sim.ts#applyRestore`(分类码 `#RESTORE_FAIL`;三道闸在同一函数内,预检实现 `#restorePreflight`) | 已修(判据 WS-FND-100:1..6 · P3-1) | 低 | 已完成 — 闸内加 `try` + 四类码(`shape` / `size` / `bad-archive` / `internal`),坏档**不抛**;每条判据同时钉「**世界一字未改**」(帧/种子/地形/玩家/水位/活跃集快照比对) | sim/world_sim.ts |
| R15 | `setRoof` 静默截 16 位(现为 12 位/4095 校验) | `server/src/world/chunk.ts#setRoof`、`server/src/world/grid.ts`(层规格) | 已修(判据 WS-FND-94:6 · P3-2) | 低 | 已完成 — 写入校验与层规格共用同一事实源,越界即抛 | world/chunk.ts + world/grid.ts |
| R16 | `decodeRoofRle` 的 `tag=0xff` 游程越界 | `server/src/world/chunk.ts#decodeRoofRle`(截断即抛) | 已修(判据 WS-FND-94:7 · P3-3) | 低 | 已完成 — 畸形字节流被拒(截断即抛),不是静默截断 | world/chunk.ts |
| R17 | `fluid.setCell` 可写进实心格 | `server/src/world/fluid.ts#setCell`(「实心格不存水」在函数内部) | 已修(判据 WS-FND-94:8a/8b · P3-4) | 低 | 已完成 — 「实心格不存水」落在 `setCell` 内部,所有写水路径都过它 | server/src/world/fluid.ts |
| R18 | 水位预算极端情况下全丢(单帧预算被打满 ⇒ 这一帧水不动) | `server/src/world/fluid.ts#step` + `#FLUID_CELL_BUDGET`(报告字段 `deferredCells`);分派点 `server/src/sim/world_sim.ts` 慢帧流体段(符号;回执取 `deferredCells`) | 已修(判据 WS-FND-100:7/8 · P3-5) | 中 | 已完成 — 额度不够只**延后**不**丢失**:`deferredCells`/`deferredAmount` 进 `FluidStepReport`,residual 水位与没轮到的活跃格逐帧守恒(120 帧 × 额度 4 实测),编排层看得见「这一帧延后了几格」 | world/fluid.ts + sim/world_sim.ts |
| R19 | `ws/hp` 钳制选址在 `vitals` 而非编码器 | `server/src/combat/vitals.ts`(单点约定块;出边 `#toUint`);编码器抛错点 `shared/net/delta.ts#toUint` | 已修(判据 WS-FND-95:8 · P3-6) | 低 | 已完成 — 写成单点约定(§7.5),编码器只抛错不圆场,不再有两处各钳一次 | combat/vitals.ts + shared/net/delta.ts |
| R20 | `node:sqlite` 事务不支持嵌套(现状无嵌套调用点) | `server/src/db/driver.sqlite.ts#transaction`(better-sqlite3 转发自带 savepoint;node:sqlite 层手写 `SAVEPOINT` 语义,见同函数) | 已修(判据 WS-FND-94:1a/1b/1c · P3-7) | 低 | 已完成 — 三后端统一到同名 savepoint 语义,嵌套退化成计数而不是抛错 | server/src/db/driver.sqlite.ts |
| R21 | 双端同源检测仍只告警(未进默认拦截) | `scripts/verify.ts#BOTH_SIDES_GATE`、`#bothSidesVerdict`、`#checkTautology` 里的接入判据 | 已修(判据 WS-FND-95:1/2/3 · P3-8) | 低 | 已完成 — 实测 **0 处**命中、升级前提已满足,已并进默认拦截(§8.2) | scripts/verify.ts |
| R22 | 顶点色 + `aLodMerge` 的 LOD 合并语义未定(合并阈值与插值口径未裁决) | `client/src/stage/terrain_vcolor.ts#LOD_MERGE_MAX_DZ`、`#LOD_COLOR_INTERPOLATION`、`#LOD_MERGE_ORDER`、`#lodMergeVerdict`;`client/src/three/compat.ts#LOD_MERGE_ATTRIBUTE`(`aLodMerge`) | 已修(判据 WS-FND-101:1..8 · P3-9) | 高 | 已完成 — 裁决落地:**阈值 `LOD_MERGE_MAX_DZ = 1`**(块内高差 ≤ 1 层才准以合并色出现在粗档)、**插值 `STEP_BY_LAYER`**(按层查调色板,层间阶跃、**不插值**,与 `MERGE_THEN_COLOR` 同序);判据把阈值边界、跨块不合并、法线与合并无关、以及「改任一参数必翻红」都钉住 | client/src/three/compat.ts + client/src/stage/terrain_vcolor.ts |

## 排序(先做哪几条)

**22/22 已处置 —— 「仍登记」为 0 条。** 判据来源分四处,不是「一批全修」也不是「四条仍挂着」:

- `R1` / `R2` → `WS-FND-93`(链路)+ `WS-FND-97`(房间元素语义:9 种房一个不漏、未登记房零抗性、换房即换元素);
- `R3` → `WS-FND-98`(击退钳制 2 格 + 质量归一);
- `R4`–`R13`、`R15`–`R17`、`R19`–`R21` → 第二/三批的 `WS-FND-91` / `92` / `94` / `95`;
- `R14` / `R18` → `WS-FND-100`(8 条:R14 错误分类 + 「世界一字未改」;R18 预算延后 + `deferredCells` 指标);
- `R22` → `WS-FND-101`(8 条:阈值 `LOD_MERGE_MAX_DZ = 1` + 插值 `STEP_BY_LAYER`)。

⇒ 排期表已空。**这 22 条之外还剩两个纯数据待平衡值**(接线已通、判据不拦,换常量即可,判据不用改):

1. **元素抗性倍率 `PENDING_ELEMENT_RESIST_MUL = 0.5`**(`server/src/rooms/effects.ts`,元素归属 `ICE`)
   —— 内容表里仍没有这个数,判据证明的是「链通了」,不是「数值是最终平衡」(§7.2 第 2 条)。
2. **mob 稀有掉落概率 `MOB_RARE_DROP_CHANCE = 0.15`**(`shared/constants/mobs.ts#MOB_RARE_DROP_CHANCE`),
   管 `753 稀有树种` / `751 稀有甜点食谱` 两件稀有材料 —— 手册只写「稀有」没写概率,
   0.15 是可判定但未裁决的占位(§7.2 同源问题)。