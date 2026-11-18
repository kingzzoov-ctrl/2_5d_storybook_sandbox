# AUDIT-R-ITEMS · §4 R1–R22 决策台账

> 来源:`docs/AUDIT-W34.md` §4「未修项(逐条理由)」。
> 口径:每行一条决策;**位置列已按当前代码逐条核对并订正漂移的行号**。
> 「现状」= 抽取时点的核实结果(带 `Pxx` 台账编号便于回溯);「代价」按改动面估(低 = 单函数/单文件;中 = 跨 2–3 处或需先定常数;高 = 需玩法/视觉裁决 + 多文件)。
> 生成方式:只读审计稿与代码,未改任何代码或其它文档。

## 台账(R1–R22)

### 列含义

- **位置(文件:行)** —— 按当前代码逐条核对过的落点;代码漂移时这一列要跟着订正。
- **现状** —— 「已修 / 已关闭 / 登记」三态;括号内是台账编号与判据套件。
- **代价 / 建议 / 影响面** —— 只是排序依据,不是承诺;真正的排期见文末「排序」。

| ID | 原始发现(一句话) | 位置(文件:行) | 现状(已修/登记) | 修它的代价(低/中/高) | 我的建议(做/不做 + 一句话) | 影响面(改哪个模块) |
|---|---|---|---|---|---|---|
| R1 | 元素抗性整条链「写入侧」无生产写入 ⇒ `setElementResist` 恒无输入,抗性 no-op | `server/src/combat/vitals.ts:522`(写入点 `server/src/rooms/effects.ts:418` `pushRoomElementResist`,调用 `server/src/sim/world_sim.ts:4033`) | 已修(P2-1;FND93-1/3/5/6) | 低 | 不做 — 链已接通,剩余只是待平衡默认值(§7.2),属平衡不属接线 | combat/vitals.ts + rooms/effects.ts |
| R2 | 元素抗性整条链「读取侧」`applyHit` 的抗性无生产写入点 | `server/src/combat/vitals.ts:841`(`resistMul` 取用 `:852`) | 已修(P2-2;FND93-1/2) | 低 | 不做 — 写入侧落地后 `element` 参数已有输入,无需再动 | combat/vitals.ts |
| R3 | 击退无上界钳制 + `mass=NaN` 可经客户端自报质量传播 | `server/src/physics/world.ts:876` `applyImpulse`、`:291` `spawn`、碰撞质量归一 `:842-843/879/894`(`:332` 注释已述拒非有限 mass 的意图) | 登记(P2-3) | 中 | 做 — 先定「最大冲量」玩法上限,再在 `applyImpulse`/质量归一收口(含拒绝非有限 mass) | server/src/physics/world.ts(+ shared/types/physics.ts 常量) |
| R4 | `resetWorld` 不按等级重算 HP 上限(下一帧 `maxHpForLevel` 才覆盖回,窗口 1 tick) | `server/src/sim/world_sim.ts:4358` `resetWorld`(抬上限复用点 `:4714` `maxHpForLevel`+`syncMaxHp`) | 已修(P2-4;FND91-7) | 低 | 不做 — 重置序列已接上限重算,窗口已消 | sim/world_sim.ts |
| R5 | 玩家→生物攻击无视线闸(越墙打怪) | `server/src/sim/world_sim.ts:2175` `losBlocked`(import `:219`;PvP 同族 `:2254`) | 已修(P2-5;FND91-1/2) | 低 | 不做 — 热路径已接 `vision.ts` 且带预算化指标 `:4981-5166` | sim/world_sim.ts + world/vision.ts |
| R6 | 攻击侧不封 `TRAPPED`/`STUNNED`(被夹住/定身仍能挥刀) | **已漂移**:原指 `server/src/net/actions/attack.ts`,该文件现为 14 行 stub(恒 `NOT_IMPLEMENTED`);真正的闸在 `server/src/sim/world_sim.ts:2143`/`:2145`(玩家→生物)、`:2234`/`:2236`(PvP) | 已修(P2-6;FND91-3/4/5/6) | 低 | 不做 — 两台状态机(移动侧/攻击侧)已同源同拒因 | sim/world_sim.ts |
| R7 | `purchaseCommit` 无幂等键 ⇒ 重放同一次购买重复成交 | `server/src/sim/world_sim.ts:6619` `purchaseCommit`(动作侧 `server/src/net/actions/buy_item.ts`) | 已修(P2-7;FND91-8/9/10) | 低 | 不做 — 幂等键 + 提交时实测库存已落地(§7.3) | sim/world_sim.ts + net/actions/buy_item.ts |
| R8 | 箱子存取不比距离(能远程开箱) | `server/src/net/actions/open_chest.ts`(`CHEST_REACH` `:113`、距离闸 `:297-298`) | 已修(P2-8;FND92-1..5/10) | 低 | 不做 — 交互半径常量 + 权威位置距离闸已接 | net/actions/open_chest.ts |
| R9 | `place_automation` 不扣件(放置零消耗) | `server/src/net/actions/place_automation.ts`(扣减 `spend` `:334`,先扣后登记 `:322-342`) | 已修(P2-9;FND92-6..9) | 低 | 不做 — 已按 `placeBlock` 口径「先扣背包、再写世界」 | net/actions/place_automation.ts |
| R10 | `snapshot_blob` 写库无上限(极端账号撑大库) | `server/src/db/repo.ts:430` `assertReconnectSnapshotSize`(常量 `:421`、写点 `:467` `saveReconnectSnapshot`;世界归档 `:1142` `archiveWorldSnapshot`) | 已修(P2-10;FND94-2a/2b) | 低 | 不做 — 1 MiB 同口径上限已卡在写口 | server/src/db/repo.ts |
| R11 | `fluid.clone()` 丢活跃集(读回后水不再自流) | `server/src/world/fluid.ts:775` `clone` | 已修(P2-11;FND94-4a/4b/4c) | 低 | 不做 — clone 已带活跃集,回放/存档行为一致 | server/src/world/fluid.ts |
| R12 | `physics.spawn()` 覆盖同 id 不清旁表(`belt`/`carry`/`carrySlot`) | `server/src/physics/world.ts:291` `spawn`(注释 `:270-288` 述回收口径) | 已修(P2-12;FND94-5a/5b) | 低 | 不做 — `spawn` 已与 `remove` 同口径回收旁表 | server/src/physics/world.ts |
| R13 | `ticks`/`seq` 无上界(可回绕/写错字节) | `shared/net/delta.ts:537` `assertU32('tick',…)`(常量 `:127` `MAX_ACKED_SEQ`);`server/src/net/ws_server.ts:497` `parseMoveIntent`、`:755` `ackSlotValue` | 已修(P2-13;FND95-4/5/6/7) | 低 | 不做 — 口径是抛错/拒,已双端落地(§8.1) | shared/net/delta.ts + server/src/net/ws_server.ts |
| R14 | `applyRestore` 的 chunk 解码在闸后且无 `try`(坏档异常分类不干净) | `server/src/sim/world_sim.ts:6736` `applyRestore` | 登记(P3-1) | 低 | 做 — 单函数加 `try`+错误分类,改动面最小、判据易写(见排序) | sim/world_sim.ts |
| R15 | `setRoof` 静默截 16 位(现为 12 位/4095 校验) | `server/src/world/chunk.ts:635` `setRoof`、`server/src/world/grid.ts:136` | 已修(P3-2;FND94-6) | 低 | 不做 — 写入校验与层规格共用同一事实源,越界即抛 | world/chunk.ts + world/grid.ts |
| R16 | `decodeRoofRle` 的 `tag=0xff` 游程越界 | `server/src/world/chunk.ts:928` `decodeRoofRle`(截断即抛 `:936`) | 已修(P3-3;FND94-7) | 低 | 不做 — 畸形字节流已被拒,非静默 | world/chunk.ts |
| R17 | `fluid.setCell` 可写进实心格 | `server/src/world/fluid.ts:275` `setCell`(注释 `:264`) | 已修(P3-4;FND94-8a/8b) | 低 | 不做 — 实心格不存水已落到 `setCell` 内部 | server/src/world/fluid.ts |
| R18 | 水位预算极端情况下全丢(单帧预算被打满 ⇒ 这一帧水不动) | `server/src/world/fluid.ts:341` `step`/`:39` `FLUID_CELL_BUDGET`;分派点 `server/src/sim/world_sim.ts:6976` | 登记(P3-5) | 中 | 做(低优先) — 只影响「这一帧水不动」不是错值,修法要先定「活跃集是否进存档」口径 | world/fluid.ts + sim/world_sim.ts |
| R19 | `ws/hp` 钳制选址在 `vitals` 而非编码器 | `server/src/combat/vitals.ts:909`(单点约定块;钳制 `:665`);编码器抛错点 `shared/net/delta.ts:400` `toUint` | 已修/已关闭(P3-6;FND95-8) | 低 | 不做 — 已写成单点约定(§7.5),编码器只抛错不圆场 | combat/vitals.ts + shared/net/delta.ts |
| R20 | `node:sqlite` 事务不支持嵌套(现状无嵌套调用点) | `server/src/db/driver.sqlite.ts:244` `transaction`(better-sqlite3 自带 savepoint)、`:315` node:sqlite 层自带 savepoint 语义 | 已修(P3-7;FND94-1a/1b/1c) | 低 | 不做 — 三后端已统一到同名 savepoint 语义 | server/src/db/driver.sqlite.ts |
| R21 | 双端同源检测仍只告警(未进默认拦截) | `scripts/verify.ts:4150` `BOTH_SIDES_GATE`、`:4167` `bothSidesVerdict`、`:4383` 接入判据 | 已修/已关闭(P3-8;FND95-1/2/3) | 低 | 不做 — 实测 0 处,前提满足,已并进默认拦截(§8.2) | scripts/verify.ts |
| R22 | 顶点色 + `aLodMerge` 的 LOD 合并语义未定(合并阈值与插值口径未裁决) | `client/src/three/compat.ts:247-252` `aLodMerge` 属性;`client/src/stage/terrain_vcolor.ts:255-288`(`MERGE_THEN_COLOR`) | 登记(P3-9) | 高 | 做(需先裁决) — 先出「合并阈值 + 顶点色插值」视觉裁决,否则改了也判不了;今天判据只钉属性存在且长度对 | client/src/three/compat.ts + client/src/stage/terrain_vcolor.ts |

## 排序(先做哪几条)

**仍登记的只有 4 条:R3 / R14 / R18 / R22**(与审计稿 §4 抬头「最终仍登记的 4 条:P2-3 / P3-1 / P3-5 / P3-9」一致);其余 18 条(R1、R2、R4–R13、R15–R17、R19–R21)都已修/关闭,不再排期。

**先做顺序:R14 → R3 → R18 → R22。**
理由:先吃「低代价、修法已定型」的 R14(单函数加 `try` + 错误分类,半天级);再 R3(需先定玩法上限,改动局限在 physics 一处);R18 与 R3 同级但影响更轻,可紧随;R22 代价最高且**卡在视觉裁决**上,裁决不出就不动。
