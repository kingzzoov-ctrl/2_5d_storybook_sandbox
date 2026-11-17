# AUDIT-W34 · 八路审计汇编(第 2/8 组)

- **日期**:2026-11-18
- **结论**:八路审计走完全部生产 `.ts`(180/180),发现按 P0..P3 分级 —— **P0 2 条、P1 11 条全部已修且各有判据**;**P2 13 条 / P3 9 条登记未修**(逐条理由见 §4)。本轮唯一的代码改动是让 `RoomRuntime.expireItemSources()` 真的被调用(内存卫生,给 P0-2 收尾)。
- **口径**:本文件是交付物,不新增门禁;`docs/` 下其它文件一概未动。

## 1 覆盖率

### 1.1 普查方法(可复算)

```powershell
# 四个根、递归、只数 .ts;排除非源目录(node_modules/dist/.pi/.git/.baseline/_*)
foreach ($d in 'server/src','shared','client','scripts') {
  (Get-ChildItem $d -Recurse -File -Filter *.ts |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' }).Count
}
```

实测:**四个根下 `*.test.ts` 各为 0 个**(全部测试套件在 `tests/`,共 99 个 `*.test.ts`),故「生产 `.ts`」= 该根下 `.ts` 总数,无需再减。

> 口径提醒:仓库门禁里 README / HANDOVER 的「生产 .ts 合计」只数 `server/` + `client/` + `shared/` 三棵(记录值 143),**不含 `scripts/`**,且 `scripts/ts-paths.ts` 的排除清单把 `server/src/build`(5 个真实源码)当成「确定不含源码」(陷阱 110 的同族误伤)。本表是**全量普查**(180),与那个分母不是同一个东西,不要把两个数互相对账。

| 目录 | 生产 `.ts` | 覆盖路 | 说明 |
|---|---|---|---|
| `server/src/**` | **90** | 路 1/2/3/6/7/8(按子系统分派) | net/ 全棵归路 1/2;world/·physics/·sim/ 归路 3/6/7;combat/·mobs/·systems/·wiring/·build/·party/·coop/·prank/·social/·alchemy/·bosses/·rooms/·events/·content/·db/ 归路 7/8 |
| `shared/**` | **14** | 路 3(主)+ 路 1/2/8(类型复审) | `net/delta.ts`、`types/wire.ts` 是路 3 的核心判据面 |
| `client/**` | **40** | 路 4 | `three/`·`stage/`·`net/`·`ui/`·`main`·`audio` 逐个过 |
| `scripts/**` | **36** | 路 5 | 台账/门禁/审计脚本全棵(含 `verify.ts`、`content-lock.ts`、`typecheck.ts`) |
| **合计** | **180** | **8/8 路** | **覆盖 180/180 = 100%**;每路都留了「未覆盖文件 = 0」的普查输出 |

### 1.2 八路分工(与本文件的发现编号对应)

| 路 | 主题 | 主要判据 |
|---|---|---|
| 路 1 | 鉴权与动作派发 | `tests/WS-FND-86-auth-token.test.ts` |
| 路 2 | 物品真值与产出凭证 | `tests/WS-FND-87-item-source.test.ts` |
| 路 3 | 线格式与边界(编解码) | `tests/WS-FND-88-wire-bounds.test.ts` |
| 路 4 | client 渲染与顶点色 | `tests/WS-FND-89-client-vertexcolor.test.ts` |
| 路 5 | 台账与判据(门禁自己是否可信) | `tests/WS-FND-90-gate-truth.test.ts` |
| 路 6 | 世界内存与物理(本组) | 无独立套件:结论落在登记项 |
| 路 7 | 存档与持久化 | 无独立套件:结论落在登记项 |
| 路 8 | 战斗语义与系统接线 | 无独立套件:结论落在登记项 |

## 2 分级口径

- **P0** 未鉴权的远端可执行 / 可直接伪造服务端事实 —— 见不得光的入口,必须当轮修。
- **P1** 服务端事实可被客户端改写、判据自身失效、静默丢数据 —— 必须当轮修,且要留判据。
- **P2** 功能静默 no-op、可被滥用放大(免费产出/远程操作/重放)、存档或长跑会坏 —— 登记,排期修。
- **P3** 边界与分层位置问题(极端输入、语义未定、告警不升级),不会在常规游玩下被踩到 —— 登记。

## 3 发现台账

### 3.1 P0 / P1(全部已修,各带判据)

| 编号 | 严重度 | 位置 | 状态 |
|---|---|---|---|
| P0-1 | P0 | `server/src/net/room.ts`(`authorize()` 与入站闸)+ `server/src/net/ws_server.ts` 握手 | 已修(判据 `tests/WS-FND-86-auth-token.test.ts`) |
| P0-2 | P0 | `server/src/net/anticheat.ts:936` `checkInventory` + 同文件 §5.0 凭证段;接线在 `server/src/net/actions/item_source.ts:40` `bindItemSource` | 已修(判据 `tests/WS-FND-87-item-source.test.ts`;内存回收见 §5) |
| P1-1 | P1 | 反作弊拒掉的移动仍推进 ack:`server/src/net/room.ts:1950` `applyMove` | 已修(判据 WS-FND-86 · FND86-7) |
| P1-2 | P1 | `{"action":"constructor"}` 走原形链:`server/src/net/actions/action_table.ts:90` `lookupActionHandler` | 已修(判据 WS-FND-87 · FND87-8) |
| P1-3 | P1 | `itemId` 自报四条路径:`server/src/net/actions/{material,craft,open_chest,breed_tame}.ts` + `item_source.ts` 的按件读口 | 已修(判据 WS-FND-87 · FND87-2/4/6) |
| P1-4 | P1 | 房间级 `chunkVersions` 变长拼接串:`shared/net/delta.ts`(分段编码,§抬头) | 已修(判据 `tests/WS-FND-88-wire-bounds.test.ts`) |
| P1-5 | P1 | 越界值被静默钳位:`shared/net/delta.ts` 字段写入点(`throws` 取代 clamp) | 已修(判据 `tests/WS-FND-88-wire-bounds.test.ts`) |
| P1-6 | P1 | 宽单元(`lo + hi×2^32`)负值回绕:`shared/types/tile.ts` 取值 + `server/src/build/blueprint.ts` varint | 已修(判据 `tests/WS-FND-88-wire-bounds.test.ts`) |
| P1-7 | P1 | `shared/contracts/FREEZE.md` 里的数字陈旧(与实测不符) | 已修(判据 `scripts/verify.ts` docs 计数节:FREEZE / HANDOVER 数字强制与实测对账) |
| P1-8 | P1 | client 顶点色未接线 + 着色器同名重定义:`client/src/three/boot.ts`(矩阵上传)、`client/src/stage/terrain_vcolor.ts`、`client/src/three/compat.ts` | 已修(判据 `tests/WS-FND-89-client-vertexcolor.test.ts`) |
| P1-9 | P1 | 台账关闭靠放宽正则:`scripts/verify.ts` 的同义反复白名单(`TAUT_SUSPECT_EXEMPT`) | 已修(判据 `tests/WS-FND-90-gate-truth.test.ts`;37 条退回未关闭) |
| P1-10 | P1 | `content-lock` 只哈希手挑字段 ⇒ 改别的字段指纹不变:`scripts/content-lock.ts` | 已修(判据 v2 整字段指纹;`node scripts/content-lock.ts --audit`) |
| P1-11 | P1 | 判据「自己比自己」:actual 与 expected 同取自被测模块:`scripts/verify.ts` 同义反复检测 | 已修(判据 `tests/WS-FND-90-gate-truth.test.ts`) |

### 3.2 P2 / P3(登记,未修)

| 编号 | 严重度 | 位置 | 状态 |
|---|---|---|---|
| P2-1 | P2 | `server/src/combat/vitals.ts:522` `setElementResist` 生产零写入 ⇒ 元素抗性 no-op | 登记(理由 R1) |
| P2-2 | P2 | 击中生物侧:`server/src/combat/vitals.ts:841` `applyHit` 的抗性无生产写入点(`sim/world_sim.ts` 调用处只传倍率) | 登记(理由 R2) |
| P2-3 | P2 | 击退无上界钳制 + `mass=NaN` 传播:`server/src/physics/world.ts`(`spawn` / `applyImpulse` / 碰撞质量归一) | 登记(理由 R3) |
| P2-4 | P2 | `resetWorld` 不按等级重算上限:`server/src/sim/world_sim.ts:4301` | 登记(理由 R4) |
| P2-5 | P2 | 玩家→生物无视线闸:`server/src/sim/world_sim.ts`(索敌/受击路径未接 `world/vision.ts`) | 登记(理由 R5) |
| P2-6 | P2 | 攻击侧不封 `TRAPPED` / `STUNNED`:`server/src/net/actions/attack.ts`(无状态闸) | 登记(理由 R6) |
| P2-7 | P2 | `purchaseCommit` 无幂等键:`server/src/sim/world_sim.ts:6472` | 登记(理由 R7) |
| P2-8 | P2 | 箱子存取不比距离:`server/src/net/actions/open_chest.ts`(容器模型 `chestsByRoom`) | 登记(理由 R8) |
| P2-9 | P2 | `place_automation` 不扣件:`server/src/net/actions/place_automation.ts`(只登记不消耗) | 登记(理由 R9) |
| P2-10 | P2 | `snapshot_blob` 写库无上限:`server/src/db/repo.ts`(快照写入点) | 登记(理由 R10) |
| P2-11 | P2 | `fluid.clone()` 丢活跃集:`server/src/world/fluid.ts:727` | 登记(理由 R11) |
| P2-12 | P2 | `physics.spawn()` 覆盖同 id 不清旁表:`server/src/physics/world.ts:265` | 登记(理由 R12) |
| P2-13 | P2 | `ticks` / `seq` 无上界:`shared/net/delta.ts` 帧头 `w.u32(tick)` / `ackedSeq` | 登记(理由 R13) |
| P3-1 | P3 | `applyRestore` 的 chunk 解码在闸后且无 `try`:`server/src/sim/world_sim.ts:6553` | 登记(理由 R14) |
| P3-2 | P3 | `setRoof` 静默截 16 位:`server/src/world/chunk.ts:613` / `server/src/world/grid.ts:136` | 登记(理由 R15) |
| P3-3 | P3 | `decodeRoofRle` 的 `tag=0xff` 越界:`server/src/world/chunk.ts:890` | 登记(理由 R16) |
| P3-4 | P3 | `fluid.setCell` 可写进实心格:`server/src/world/fluid.ts:258` | 登记(理由 R17) |
| P3-5 | P3 | 水位预算在极端情况下全丢:流体预算分派点(`server/src/world/fluid.ts` / `sim/world_sim.ts`) | 登记(理由 R18) |
| P3-6 | P3 | `ws/hp` 的钳制选址在 `vitals` 而非编码器:`server/src/combat/vitals.ts` + `shared/net/delta.ts` | 登记(理由 R19) |
| P3-7 | P3 | `node:sqlite` 事务不支持嵌套:`server/src/db/driver.sqlite.ts:233`(`transaction` 直接转发) | 登记(理由 R20) |
| P3-8 | P3 | 双端同源检测仍只告警:`scripts/verify.ts`(`advise('同义反复', …)`,不进退出码) | 登记(理由 R21) |
| P3-9 | P3 | client 顶点色与 `aLodMerge` 的 LOD 合并语义未定:`client/src/three/compat.ts`(属性与几何生成)、`client/src/stage/terrain_vcolor.ts` | 登记(理由 R22) |

## 4 未修项(逐条理由)

**P2(13 条,按「会不会被常规游玩踩到 + 修法是否已定型」排序)**

- **R1 / R2 元素抗性整条链没接线**:抗性表在 `vitals` 里可写可读,但生产路径两处(写入侧 `setElementResist`、读取侧 `applyHit`)都没有调用点 ⇒ 现在只是 no-op,不是错值。修法要一起定「哪些生物/元素吃抗性」的内容口径,属设计面,不是一行的 bug。
- **R3 击退无上界 + `mass=NaN`**:NaN 只在客户端自报质量且未经 `sanitize` 的路径上才可能出现(常规路径 `spawn` 给 `MASS_PLAYER`),击退上界需要先定「最大冲量」的玩法上限。
- **R4 `resetWorld` 不按等级重算上限**:重置后玩家 HP 上限沿用旧值,下一帧 `maxHpForLevel` 投影会覆盖回来,窗口只有一个 tick;修法要动 `world_sim` 的重置序列。
- **R5 玩家→生物无视线闸**:越墙打怪能刷,但要接视线就要在热路径上跑 `hasLineOfSight`(每帧 O(格)),与性能预算冲突,需要先量成本。
- **R6 攻击侧不封 `TRAPPED`/`STUNNED`**:状态位存在,攻击动作不读它 ⇒ 被陷阱夹住仍能打。修法明确,但会改动战斗节奏,需要与 `WS-10`/`WS-11` 的用例一起调。
- **R7 `purchaseCommit` 无幂等键**:重放同一次购买会重复成交;真正拦重放要靠动作层的 `seq`,而那一条本身在 R13 里。
- **R8 箱子存取不比距离**:能远程开箱(需要先知道坐标),与 R5 同族的「服务端事实没被用来判距离」;修法要先定交互半径常量。
- **R9 `place_automation` 不扣件**:今天放的件在世界侧**没有读者**(登记在案),所以「不扣件」暂时无收益;接线成真之前补扣件只是把顺序问题提前。
- **R10 `snapshot_blob` 无上限**:单行快照体积随背包/等级增长,极端账号会把库撑大;上限值要配合存档版本迁移一起定。
- **R11 `fluid.clone()` 丢活跃集**:存档/回放路径读回的流体不再自己流动(要等下一次扰动),属「读回后行为与存档前不一致」,修法要定活跃集是否属于存档内容。
- **R12 `physics.spawn()` 覆盖同 id 不清旁表**:只有同 id 重生(换图/重置)才触发,现状由调用方自行保证 id 唯一;清哪几张旁表(`belt`/`carry`/`carrySlot`)需要一次普查。
- **R13 `ticks` / `seq` 无上界**:`u32` 帧号在 20Hz 下约 6.8 年回绕,`ackedSeq` 同量级;修法是加回绕比较,属长跑健壮性。
- **R14–R22(P3)**:
  - R14 `applyRestore` 的 chunk 解码在闸后且无 `try` ⇒ 坏档会把异常抛到闸门之后,不会静默,但错误分类不干净。
  - R15 `setRoof` 静默截 16 位 ⇒ 只影响 `roofId ≥ 65536` 的内容,内容基线目前最大号远低于此。
  - R16 `decodeRoofRle` 的 `tag=0xff` 越界 ⇒ 需要构造畸形字节流才触发,属解码健壮性。
  - R17 `fluid.setCell` 可写进实心格 ⇒ 现有调用点都先判了地形,属「口子开着但没人用错」。
  - R18 水位预算极端情况全丢 ⇒ 只在预算被单帧打满时出现,影响的是「这一帧水不动」而不是错值。
  - R19 `ws/hp` 钳制选址在 `vitals` 而非编码器 ⇒ 分层位置问题,行为正确。
  - R20 `node:sqlite` 事务不支持嵌套 ⇒ 现状没有嵌套调用点;要支持需自带 savepoint,收益低于风险。
  - R21 双端同源检测仍只告警 ⇒ 升级为硬门禁前必须先清掉现存命中(与 P1-9 的 37 条同源),否则只会逼人加白名单。
  - R22 顶点色 + `aLodMerge` 的 LOD 合并语义 ⇒ 视觉语义未定(合并阈值与顶点色的插值口径要先出裁决),今天的判据只钉「属性存在且长度对」。

## 5 本轮代码改动(唯一一处)

`server/src/net/room.ts` 的 `step()`(20Hz 逐帧推进)末尾,`projectWildlife()` 之后、`encodeDelta` 之前,新增:

```ts
/* ★ 审计 P0-2 要求:过期凭证必须真的被回收。… */
this.expireItemSources();
```

- **修的问题**:`grantItemSource` 只增不减,而 `expireItemSources()` 修前**全仓 0 个调用点**(见 `server/src/net/anticheat.ts` §5.0 的「修前」段),未消费的令牌一直留到房间销毁 —— 内存卫生。
- **安全性不依赖它**:令牌自带 tick 且一次性,伪造/复用已由 `checkInventory` 的绑定 + `MAC` 判掉(判据 `tests/WS-FND-87-item-source.test.ts`)。
- **幂等**:`expireItemSources()` 的实现只有 `this.grantedSources.clear()`,重复调用 = 同一空状态,跨 tick 反复调不会产生任何副作用。
- **位置理由**:放在 tick 末而不是动作入口 —— 动作在两次 `step()` 之间到达,照常铸/验;凭证**不跨 tick 累积**。

- **判据副作用(登记在案)**:凭证被清掉后,上一 tick 的令牌在 `checkInventory` 里
  先命中「未被服务端认可」⇒ 拒因从 `ITEM_SOURCE_EXPIRED` 变成 **`ITEM_FROM_NOTHING`**
  (过期即回收,故与凭空不可区分)。`tests/WS-FND-87-item-source.test.ts` 的 FND87-4
  已按此改写:仍钉「同一张凭证推进一帧后必被拒」(隔两帧再断言一次),只是不再要求
  专属拒因码。想恢复过期归因需在 anticheat 里另记一张跨 tick 的「曾签发」集合
  (≈10 行),本轮按「不新增跨 tick 记账」的取舍不做。

## 6 本次未做 / 边界

- **未跑 `scripts/verify.ts --all`**(本轮硬约束)。
- `npm run typecheck` 实测 **261 条**(与 HANDOVER 基线 261 一致,本轮改动**未新增**;`room.ts` 无任何报错)。
- 未 commit、未改 `.pi/`、未动 `docs/` 下其它文件。