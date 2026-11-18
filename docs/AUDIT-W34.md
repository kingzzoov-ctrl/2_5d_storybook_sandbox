# AUDIT-W34 · 八路审计汇编(第 2/8 组)

- **日期**:2026-11-18
- **结论**:八路审计走完全部生产 `.ts`(180/180),发现按 P0..P3 分级 —— **P0 2 条、P1 11 条全部已修且各有判据**;**P2 13 条 / P3 9 条登记未修**(逐条理由见 §4)。本轮唯一的代码改动是让 `RoomRuntime.expireItemSources()` 真的被调用(内存卫生,给 P0-2 收尾)。**2026-11-18 第二批处置**:P2/P3 中 **15 条已修**(判据 `tests/WS-FND-91..94`),**7 条仍登记** —— 逐条见 §3.2 的状态列与新增的 §7。**2026-11-18 第三批处置**:再关 **3 条**(P2-13 上界 / P3-6 钳制选址 / P3-8 双端同源拦截)+ 订正本文件与代码现状矛盾的措辞(P3-9),判据 `tests/WS-FND-95-gate-and-bounds.test.ts`;详见 §7.5 与 §8。**现存仍登记 4 条**:P2-3 / P3-1 / P3-5 / P3-9。
- **2026-11-18 第四批处置(第二轮)**:新审计的 **8 条 P1 + 12 条 P2/P3** 全部已修且各有判据(`tests/WS-FND-102..105`,共 42 条判据);逐条见 §9。
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
> **第四批追加**:P1-7(文档数字 / 哈希陈旧)追加判据 `WS-FND-103:13` —— §九 README sha256 过期属同一族(见 §9.3)。

### 3.2 P2 / P3(2026-11-18 第二批 + 第三批:18 条已修 / 4 条仍登记)

| 编号 | 严重度 | 位置 | 状态 |
|---|---|---|---|
| P2-1 | P2 | `server/src/combat/vitals.ts:522` `setElementResist` 生产零写入 ⇒ 元素抗性 no-op | 已修(判据 `tests/WS-FND-93-element-resist-wired.test.ts` FND93-1/3/5/6;写入点是 `rooms/effects.ts` 的 `pushRoomElementResist`) |
| P2-2 | P2 | 击中生物侧:`server/src/combat/vitals.ts:841` `applyHit` 的抗性无生产写入点(`sim/world_sim.ts` 调用处只传倍率) | 已修(判据同 `tests/WS-FND-93` FND93-1/2:写入侧落地后 `applyHit` 的 `element` 参数才有输入) |
| P2-3 | P2 | 击退无上界钳制 + `mass=NaN` 传播:`server/src/physics/world.ts`(`spawn` / `applyImpulse` / 碰撞质量归一) | 登记(理由 R3;第二批对该文件只改了旁表回收) |
| P2-4 | P2 | `resetWorld` 不按等级重算上限:`server/src/sim/world_sim.ts:4301` | 已修(判据 `tests/WS-FND-91-combat-gates.test.ts` FND91-7) |
| P2-5 | P2 | 玩家→生物无视线闸:`server/src/sim/world_sim.ts`(索敌/受击路径未接 `world/vision.ts`) | 已修(判据 `tests/WS-FND-91` FND91-1/2) |
| P2-6 | P2 | 攻击侧不封 `TRAPPED` / `STUNNED`:`server/src/net/actions/attack.ts`(无状态闸) | 已修(判据 `tests/WS-FND-91` FND91-3/4/5/6) |
| P2-7 | P2 | `purchaseCommit` 无幂等键:`server/src/sim/world_sim.ts:6472` | 已修(判据 `tests/WS-FND-91` FND91-8/9/10) |
| P2-8 | P2 | 箱子存取不比距离:`server/src/net/actions/open_chest.ts`(容器模型 `chestsByRoom`) | 已修(判据 `tests/WS-FND-92-action-gates.test.ts` FND92-1..5/10) |
| P2-9 | P2 | `place_automation` 不扣件:`server/src/net/actions/place_automation.ts`(只登记不消耗) | 已修(判据 `tests/WS-FND-92` FND92-6..9) |
| P2-10 | P2 | `snapshot_blob` 写库无上限:`server/src/db/repo.ts`(快照写入点) | 已修(判据 `tests/WS-FND-94-storage-invariants.test.ts` FND94-2a/2b) |
| P2-11 | P2 | `fluid.clone()` 丢活跃集:`server/src/world/fluid.ts:727` | 已修(判据 `tests/WS-FND-94` FND94-4a/4b/4c) |
| P2-12 | P2 | `physics.spawn()` 覆盖同 id 不清旁表:`server/src/physics/world.ts:265` | 已修(判据 `tests/WS-FND-94` FND94-5a/5b) |
| P2-13 | P2 | `ticks` / `seq` 无上界:`shared/net/delta.ts` 帧头 `w.u32(tick)` / `ackedSeq`;上行 `seq` 在 `server/src/net/ws_server.ts`(只查下界) | 已修(2026-11-18 第三批,见 §8.1;判据 `tests/WS-FND-95-gate-and-bounds.test.ts` FND95-4/5/6/7:越界/非有限整数**抛错或拒**,不再 `>>>0` 静默回绕) |
| P3-1 | P3 | `applyRestore` 的 chunk 解码在闸后且无 `try`:`server/src/sim/world_sim.ts:6553` | 登记(理由 R14;第二批改的是玩家/上限/hp 序列,chunk 解码段未动) |
| P3-2 | P3 | `setRoof` 静默截 16 位:`server/src/world/chunk.ts:613` / `server/src/world/grid.ts:136` | 已修(判据 `tests/WS-FND-94` FND94-6) |
| P3-3 | P3 | `decodeRoofRle` 的 `tag=0xff` 越界:`server/src/world/chunk.ts:890` | 已修(判据 `tests/WS-FND-94` FND94-7) |
| P3-4 | P3 | `fluid.setCell` 可写进实心格:`server/src/world/fluid.ts:258` | 已修(判据 `tests/WS-FND-94` FND94-8a/8b) |
| P3-5 | P3 | 水位预算在极端情况下全丢:流体预算分派点(`server/src/world/fluid.ts` / `sim/world_sim.ts`) | 登记(理由 R18;第二批对该文件只改了 `setCell` / `clone`) |
| P3-6 | P3 | `ws/hp` 的钳制选址在 `vitals` 而非编码器:`server/src/combat/vitals.ts` + `shared/net/delta.ts` | 已关闭(2026-11-18 第三批:写成**单点约定**,见 §7.5;判据 `tests/WS-FND-95` FND95-8:编码器对越界 hp **抛错**、vitals 出边一定 `0 ≤ hp ≤ maxHp`) |
| P3-7 | P3 | `node:sqlite` 事务不支持嵌套:`server/src/db/driver.sqlite.ts:233`(`transaction` 直接转发) | 已修(判据 `tests/WS-FND-94` FND94-1a/1b/1c) |
| P3-8 | P3 | 双端同源检测仍只告警:`scripts/verify.ts`(`advise('同义反复', ...)`,不进退出码) | 已修(2026-11-18 第三批:并进**默认拦截**,与三道 strict 同口径、`--lenient` 才降级,汇总行给出条数;见 §8.2;判据 `tests/WS-FND-95` FND95-1/2/3) |
| P3-9 | P3 | client 顶点色与 `aLodMerge` 的 LOD 合并语义未定:`client/src/three/compat.ts`(属性与几何生成)、`client/src/stage/terrain_vcolor.ts` | 登记(理由 R22;要视觉裁决) |
> **第四批追加**:P2-10 追加判据 `WS-FND-104:10/11`;P2-12 追加 `WS-FND-102:7`(同族第二处,见 §9.3)。

## 4 未修项(逐条理由)

> **2026-11-18 第三批之后的读法**:下面这份 R1..R22 是**第二批收尾时**的账本。
> 其中 4 条已被第三批关闭 —— 本文件已在**原地**标注(~~删除线~~ + 处置),
> 未标注的仍然成立。最终仍登记的 4 条:**P2-3 / P3-1 / P3-5 / P3-9**
> (理由见 R3 / R14 / R18 / R22)。

**P2(原 13 条,现 1 条仍登记:按「会不会被常规游玩踩到 + 修法是否已定型」排序)**
- ~~**R1 / R2 元素抗性整条链没接线**~~ **已关闭(2026-11-18 第二批,本行是第三批的措辞订正)**:生产路径两处**都已经接上** —— 写入侧 `server/src/rooms/effects.ts` 的 `pushRoomElementResist`(调用点在 `sim/world_sim.ts` 的 `tickRoomEffects`)写 `setElementResist`,读取侧 `applyHit` 的 `element` 参数因此才有输入。判据 `tests/WS-FND-93-element-resist-wired.test.ts` FND93-1..6。⚠️ 措辞订正的原因:本行此前仍写着「现在只是 no-op」,而 §3.2 的 P2-1/P2-2 已标已修 —— **同一份文件里两个相反的结论**,读者只能靠猜。数值仍是待平衡默认值(§7.2 第 2 条),那是**另一个**问题(平衡),不是接线。

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
- ~~**R13 `ticks` / `seq` 无上界**~~ **已关闭(2026-11-18 第三批)**:上界门落在两处 —— `shared/net/delta.ts` 的 `assertU32('tick', …)` / `assertAckedSeq` / `ackSlotValue`(帧头两字段),`server/src/net/ws_server.ts` 的 `parseMoveIntent`(上行 `seq`,上界 `MAX_ACKED_SEQ`)+ `onMove` 推进 ack 前的复检。口径是**抛错 / 拒**,不是「加回绕比较」:回绕比较只能让比较结果对,写出来的**字节**仍然是错的。判据 FND95-4/5/6/7。注:R7 里「要靠 seq 拦重放」那句的前提(seq 无上界)已不成立,但 R7 本身(P3? 见 P2-7 已修)以幂等键解决,不依赖本行。
- **R14–R22(P3)**:
  - R14 `applyRestore` 的 chunk 解码在闸后且无 `try` ⇒ 坏档会把异常抛到闸门之后,不会静默,但错误分类不干净。
  - R15 `setRoof` 静默截 16 位 ⇒ 只影响 `roofId ≥ 65536` 的内容,内容基线目前最大号远低于此。
  - R16 `decodeRoofRle` 的 `tag=0xff` 越界 ⇒ 需要构造畸形字节流才触发,属解码健壮性。
  - R17 `fluid.setCell` 可写进实心格 ⇒ 现有调用点都先判了地形,属「口子开着但没人用错」。
  - R18 水位预算极端情况全丢 ⇒ 只在预算被单帧打满时出现,影响的是「这一帧水不动」而不是错值。
  - ~~R19 `ws/hp` 钳制选址在 `vitals` 而非编码器~~ **已关闭(2026-11-18 第三批)**:选址写成**单点约定**(§7.5)——钳制唯一落点是 `server/src/combat/vitals.ts`,编码器只负责**抛错**;判据 FND95-8 同时钉两侧(编码器遇越界 hp 抛错 + vitals 出边恒合法)。
  - R20 `node:sqlite` 事务不支持嵌套 ⇒ 现状没有嵌套调用点;要支持需自带 savepoint,收益低于风险。
  - ~~R21 双端同源检测仍只告警~~ **已关闭(2026-11-18 第三批)**:它的前提是「先把现存命中清零」,而实测已是 **0 处**(`node scripts/verify.ts --docs` 打印 `· 双端同源 0 处`)⇒ 前提满足,已并进默认拦截(§8.2)。判据 FND95-1/2/3。
  - R22 顶点色 + `aLodMerge` 的 LOD 合并语义 ⇒ 视觉语义未定(合并阈值与顶点色的插值口径要先出裁决),今天的判据只钉「属性存在且长度对」。
> **第四批追加(2026-11-18,判据 `WS-FND-102..105`;逐条见 §9)**:
> · **R10** 追加 `WS-FND-104:10/11` —— 1 MiB 上限已进 DDL(`CHECK`),`loadWorldArchive` 拒绝「摘要字节数 ≠ BLOB 长度」的原料;
> · **R12** 追加 `WS-FND-102:7` —— 同族第二处:五张旁表在 `remove` 路径也曾漏收(`removePlayer` 用 `bodies.delete` 绕过 `PhysicsWorld.remove`);
> · **R14** 追加 `WS-FND-102:4/5` —— 同函数另一条:`mobOrdinals` 按归档 id 重建而计数器清 0 ⇒ 发号撞号、同 id 静默整只替换。
> 三行的原状态(已修 / 登记)不变;追加的是**同一族第二条路径**的判据。

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

## 7 2026-11-18 第二批处置(P2 / P3)

四条修复线并行交回,判据落在 4 个新套件:`tests/WS-FND-91-combat-gates.test.ts`(10 条)、
`tests/WS-FND-92-action-gates.test.ts`(10 条)、`tests/WS-FND-93-element-resist-wired.test.ts`(6 条)、
`tests/WS-FND-94-storage-invariants.test.ts`(15 条)—— 共 **41 条**。

### 7.1 判据 ↔ 条目对照(点得开才叫关闭)

| 套件 | 钉住的条目 |
|---|---|
| WS-FND-91 | P2-4(FND91-7 重置后 160/160)· P2-5(FND91-1/2 视线)· P2-6(FND91-3..6 定身/困住)· P2-7(FND91-8/9/10 幂等键 + 提交时实测库存) |
| WS-FND-92 | P2-8(FND92-1..5/10 交互半径)· P2-9(FND92-6..9 放件扣件) |
| WS-FND-93 | P2-1 / P2-2(FND93-1..6:唯一推送口 + 清空路径 + 非法值守卫 + 来源链) |
| WS-FND-94 | P3-7(FND94-1a/1b/1c 嵌套事务)· P2-10(FND94-2a/2b 快照 1 MiB)· P2-11(FND94-4a/b/c clone 活跃集)· P2-12(FND94-5a/5b 旁表回收)· P3-2(FND94-6 setRoof 12 位)· P3-3(FND94-7 decodeRoofRle)· P3-4(FND94-8a/8b setCell 实心格) |
> 这张表只覆盖**第二批**;第四批的同类对照在 **§9.1**(判据 `tests/WS-FND-102..105`)。

### 7.2 与交接单的两处**不一致**(如实记)

1. 交接单写「已修的 22 条」,**实测只有 15 条**有能点开的判据(P2-1/2/4/5/6/7/8/9/10/11/12 +
   P3-2/3/4/7)。其余 **7 条本批根本没被触碰**,按本仓「关闭 = 标记 ∧ 可查证据」的口径
   **不能**改成「已修」—— 它们是 P2-3、P2-13、P3-1、P3-5、P3-6、P3-8、P3-9(理由见 §4 与 §3.2 状态列)。
2. 本批的**调用面**还有一处必须与「已修」一起看:`WS-FND-93` 的值取自 `ROOM_ELEMENT_RESIST`
   里的**待平衡默认值**(`PENDING_ELEMENT_RESIST_MUL = 0.5`,元素归属 `ICE`),
   内容表里仍**没有**这个数 ⇒ 判据证明的是「链通了」,不是「数值是最终平衡」。
   接 owner 给了真内容就换掉表里那一行,判据不需要改。

### 7.3 第二批顺带改到的、与 P0/P1 同族的接线

- `server/src/net/actions/buy_item.ts`:`purchaseCommit(itemId, qty, { actorId })` ——
  不传 `actorId` 时幂等键退化成 `#itemId#frame`,**两个玩家同帧买同一件会撞键**(第二个被当重放拒);
  回执的 `stock` 取 `commit.stockOfItem`(提交时实测),不再用报价快照。
  `net/room.ts` 那条两参声明本批不许改,故在动作文件里收窄一次(`PurchaseCommitWithKey`),
  契约补进 `room.ts` 后删掉即可。
- `server/src/sim/world_sim.ts` 两行挂钩:`tickRoomEffects` 里
  `const key = roomAtCell(roomsView, b.x, b.y);` 之后 `pushRoomElementResist(this.vitals, id, key);`
  —— 这是 P2-1 的**生产调用点**,也是 `WS-FND-93` FND93-6 钉的「来源链」。

### 7.4 验证口径

- 未跑 `scripts/verify.ts --all`(本批硬约束)。逐套件直跑:`node tests/<file>` ——
  全仓 **103 个套件 / 2152 个用例全绿**(基座 FND 1138 条 / 89 套件,WS 编号 1014 条 / 14 套件)。
- `node scripts/verify.ts --docs`:见本批交接报告;`node scripts/content-lock.ts` 指纹仍为
  `v2-76694a25`(本批未碰内容表)。`node scripts/backlog.ts`:133 条 / 37 未关闭 / 0 阻塞 / 96 已关闭(未变)。
- `npm run typecheck`:261 条(与基线一致,**未新增**)。

### 7.5 ★ 钳制选址的**单点约定**(审计 P3-6 / 交接单 P3-8)

> 这一节是**约定本身**,不是记录一次改动。同一段话在代码里只出现一次
> (`server/src/combat/vitals.ts` 的「单点约定」块),别处只引用,不复制。

```
钳制(写进状态)   server/src/combat/vitals.ts
                 不变量 0 ≤ hp ≤ maxHp 只在那里成形
                 写点  register / applyDamage / applyHit / heal / revive / syncMaxHp / stepTimers
报错(写出字节)   shared/net/delta.ts 的 toUint
                 越界 hp(> 65535 / 负 / NaN / 非数值)⇒ throw,**不钳**
```

- **为什么钳在 vitals 而不是编码器**:钳在编码器 ⇒ 世界状态里仍然是 `hp=535` / `hp=NaN`,
  只是"发出去的字节"好看;读档、判死、回血、DB 落库全都还错。钳制是**状态不变量**,
  属于状态的唯一持有者(`VitalsSystem`);序列化器只回答「这个值能不能上线」。
- **为什么不能两边都钳**:两份实现日后必然漂移(陷阱 31/41),而且会掩盖上游钳制失效
  —— 编码器一旦替越界值圆场,绕过 vitals 的调用方就再也不会被任何人发现。
- **判据(不是说明)**:`tests/WS-FND-95-gate-and-bounds.test.ts` FND95-8 ——
  同一条越界 hp 喂两条路:编码器**抛错**(负对照:`hp=65535` 端点仍可编码);
  同一个病态输入喂 `VitalsSystem.revive()`,出来的一定落在 `[0, maxHp]` 且能正常编码。
- **边界(要人盯)**:`VitalsSystem.get(id)` 返回同一引用,调用方有权直接改字段。
  那是刻意的读口;写法约定是「写 hp 只经本类的方法」。`world_sim.importVitals`
  曾经自带的那份钳制已摘除(见 `revive()` 的注释)。

## 8 2026-11-18 第三批处置(P3-5 / P3-6 / P3-8 / P3-9 口径)

> 说明:交接单把这四条叫 P3-5 / P3-6 / P3-8 / P3-9,而本文件台账用的是
> **P3-8(双端同源)/ P2-13(ticks·seq)/ P3-6(hp 钳制选址)**。下表按**条目内容**
> 对齐,不按编号猜。

### 8.1 `ticks` / `seq` 上界(P2-13)

- `shared/net/delta.ts` 新增 §0:`MAX_U32` / `MIN_ACKED_SEQ` / `MAX_ACKED_SEQ` /
  `isU32` / `assertU32` / `isValidAckedSeq` / `assertAckedSeq` / `ackSlotValue`。
  `encodeDelta` 的 `w.u32(tick)` 改为 `w.u32(assertU32('tick', tick))`。
- `server/src/net/ws_server.ts`:`parseMoveIntent` 的 `seq` 上界改走 `isValidAckedSeq`
  (修前只查 `>= 0`);`onMove` 推进 ack 前再复检一次,非法 ⇒ **不推进**并记日志;
  `withAckedSeq` 的 `(ackedSeq+1)>>>0` 换成 `ackSlotValue()`(唯一的内部域→线上域换算,
  非法即抛错,**不再回绕成 0**)。
- 刻意**不**做「回绕比较」:回绕比较只让比较结果对,写出去的字节仍然是错的。
  解码侧不需要新门:`r.u32()` 的返回值结构上就在 `[0, MAX_U32]`。

### 8.2 双端同源并进默认拦截(P3-8)

- `scripts/verify.ts` 新增 `BOTH_SIDES_GATE` / `bothSidesVerdict(count, lenient)`:
  默认 `count > 0 ⇒ fail()`,`--lenient ⇒ advise()`(与 `strictReach/Taut/Inert` 同口径)。
  旧行是 `advise('同义反复', …)` —— 比"未登记候选"**更强**的证据反而更宽松。
- 汇总行新增 `· 双端同源 N 处`(`bothSidesMeasured`,由 `checkTautology` 填)。
  `ADVISE_UPGRADE` 补键,否则汇总行会把 `--lenient` 下的这条告警说成「不属三道 strict」。
- 升级的前提已验证:`node scripts/verify.ts --docs` 打印 `· 双端同源 0 处`
  ⇒ 现存命中已由前一批清零动作处理完,R21 当时担心的"只会逼人加白名单"不成立。

### 8.3 文档措辞订正(P3-9)

本文件内**自相矛盾**处已逐条改掉(这是本批唯一允许改的 `.md`):

| 位置 | 修前 | 与代码现状的矛盾 |
|---|---|---|
| §4 R1/R2 | 「元素抗性整条链没接线 ⇒ 现在只是 no-op」 | §3.2 已把 P2-1/P2-2 标已修;**同一文件两个相反结论** |
| §4 R13 | 「修法是加回绕比较」 | 见 §8.1:实际口径是抛错 / 拒 |
| §4 R19 | 「钳制选址…登记」 | 见 §7.5:已写成单点约定 |
| §4 R21 | 「升级前必须先清掉现存命中」 | 实测 0 处,前提已满足,见 §8.2 |

**仍未改、需文档 owner 处理的矛盾(不在本批写权限内)**:

1. `docs/DAMAGE-LOOP.md:26`「复活流程与重生点 | 服务器层(未实现)」——
   `server/src/combat/revive.ts` 与 `sim/world_sim.ts` 的复活序列早已在跑
   (判据 `tests/WS-FND-62` / `WS-FND-83`)。该行是**只改了一半的旧账**。
2. `docs/DAMAGE-LOOP.md:27`「PvP 结算 | 未实现(见 §8 U3)」——
   同文件 `:319` 的 D3 已写「已关闭(2026-11-17)」,`pvpVerdict` 是唯一授权判定
   (判据 `tests/WS-FND-71` FND71-5..8)。**同一文件两条互斥陈述**。
3. `docs/AUTHORITY-MAP.md:162` / `:331-334`、`docs/ARCH-GAPS.md:573-575` 里的
   `vitals.ts:NNN` 行号取自**更早的版本**:例如 `vitals.ts:345` 现在是
   `warnHitsPlayer` 里的 `const dist = Math.hypot(dx, dy);`,而文档说它是
   `v.hp = hp ?? v.maxHp`(那个写法已挪进 `revive()` 并改成两步钳制)。属行号陈旧,不是结论错。
4. `docs/DAMAGE-LOOP.md:320`(D4 元素抗性"已关闭")现在的**结论**是对的,
   但它引的判据 `tests/WS-FND-71` FND71-9 只钉「系数在玩家侧出现」,
   钉不住"生产侧有写入点"—— 后者由 `tests/WS-FND-93` FND93-6 提供。
   建议把 D4 行的判据改成「FND71-9 + FND93-6」。

### 8.4 本批验证口径

- 未跑 `scripts/verify.ts --all`(硬约束)。跑过的:`node scripts/verify.ts --docs`
  (它**包含** `checkTautology` 与本批新汇总行)、`node tests/WS-FND-95-gate-and-bounds.test.ts`、
  `npm run typecheck`(261 条基线,未新增)、`node scripts/verify.ts --frozen`。
- 判据套件:`tests/WS-FND-95-gate-and-bounds.test.ts`(FND95-1..9,含负对照 + 注入)。
- 已知的**非本批**红:`--docs` 有 2 条 HANDOVER 数字红(生产可达性 132/144 vs 实测 133/145、
  生产 .ts 合计 144 vs 145),根因是并行批次新增了 `server/src/systems/idempotency.ts`,
  不是本批四条改动。

## 9 2026-11-18 第四批处置(第二轮:8 条 P1 + 12 条 P2/P3)

> 判据:`tests/WS-FND-102-kill-drops-and-retire.test.ts`(8 条)、
> `tests/WS-FND-103-gate-selfproof.test.ts`(13 条)、
> `tests/WS-FND-104-archive-integrity.test.ts`(12 条)、
> `tests/WS-FND-105-action-ledgers.test.ts`(9 条)—— 共 **42 条判据**。
> 下面的 20 条按**发现**去重计数(同一修法的正/负对照算一条),严重度取套件文件头的标注:
> **P1 8 条 / P2·P3 12 条**。关闭口径不变:已修 = 标记 ∧ 可查证据(每条点到判据编号)。

### 9.1 判据 ↔ 条目对照

| 套件 | 条数 | 钉住的条目 |
|---|---|---|
| WS-FND-102 | 8 | P1-A 击杀掉落落地(102:1/2/3)· P2-A `mobOrdinals` 重号(4/5)· P2-B `removePlayer` 漏清瞬态(6/7)· P2-C `KillLedger` 无界(8) |
| WS-FND-103 | 13 | P1-B 门禁自检默认永不失败(1/2/3)· P1-C 测试门结构性可绕过(4/5/6/7)· P1-D 计数对账无下限(8..12)· P1-E HANDOVER §九 哈希过期(13) |
| WS-FND-104 | 12 | P1-F 归档头裁剪不可见(1/2/5)· P1-G 块表校验和缺失(3/4)· P1-H 迁移版本护栏与漂移顺序(6/7/8/9)· P2-D 1 MiB 兜底 + `loadWorldArchive` 自相矛盾(10/11) |
| WS-FND-105 | 9 | P2-E..P2-K + P3-A 动作层四本侧账与令牌(1..9,逐条见 9.2) |

### 9.2 逐条处置(20 条)

**P1(8 条)**

| # | 发现 | 处置 |
|---|---|---|
| P1-A | 击杀掉落从不落地:`server/src/sim/world_sim.ts` 的 `settleKill` 把 `rollMobDrops()` 只写进诊断字段 `lastMobDrops`(生产 0 读者),从不调 `dropItem` ⇒ 打死怪的地面永远是空的 | 已修:击杀路径真调 `dropItem`,落地件数/坐标/内容按内容表(`shared/constants/mobs.ts`);负对照钉「同一实例二次结算不给第二份」(102:1/2/3) |
| P1-B | 门禁自检默认永不失败:`scripts/verify.ts::checkGateSelfcheck` 非 `--strict-selfcheck` 时 `advise()` + `return`(exit 0)⇒ 「唯一证明各门有牙」的东西自己默认必绿 | 已修:默认口径**真跑**,`--lenient` 才降级;`selfcheckPolicy` / `selfcheckOutcome` 是判据面(103:1/2/3) |
| P1-C | 测试门结构性可绕过:`tests/` 缺失或 0 套件只 `console.log` 后 return;套件不打印 `N/M 通过` 则 `if (c)` 静默跳过(实测 `--only __NOMATCH__` ⇒ exit 0 + 「全部通过」) | 已修:`suiteSetVerdict` / `assertionCountVerdict` / `parseAssertionCounts` 三处判据:0 套件即 fail、缺 `N/M` 即 fail(103:4/5/6/7) |
| P1-D | 计数对账可无为通过:`scripts/count-audit.ts` 只认 4 条固定措辞,改个词 ⇒ hits=0 仍印「一致 0」exit 0;`verify.ts` 对缺 `count-audit.ts` 只 `advise` | 已修:命中数有具名下限、被扫文件必须在、文件缺失 ⇒ fail(103:8..12) |
| P1-E | `docs/HANDOVER.md` §九 的 README sha256 已过期(表 `a38cb95b2d4b` / 实测 `d3604da144a2`) | 已修:表值改由重算脚本写入(本批改 README 后再次重算,见 9.4);判据钉「表值 = LF 归一后的实测值」(103:13) |
| P1-F | 归档头裁剪不可见:头里没有 `chunksTotal` / `chunksChecksum`,删掉 `trim` 键即等同「没裁过」 | 已修:`server/src/world/archive.ts` 写两键;`planRestore.missingChunks` 恒按 `chunksTotal − 实际块数` 报缺口;旧字节(两键缺)⇒ `chunksChecksumOk === null`(**不可判 ≠ 通过**)(104:1/2/5) |
| P1-G | 块表被改(cx / 长度)静默接受:解码器不核对块表校验和;改小 `chunksTotal` 同样被接受 | 已修:校验和规范文本含块数与每块 cx/长度 ⇒ 不匹配**抛错**(104:3/4) |
| P1-H | 迁移既无版本护栏、漂移判定又在 DDL 之后:`migrate()` 对未知版本 99 / 更旧版本 0 不拒;同版本 checksum 漂移时 DDL 已执行;归档迁移漂移仍能写入;`bootstrap()` 会偷建第 10 张表 | 已修:`assertMigrationVersionSupported` 先判;漂移返回 `drift` 且判在 `db.exec(ddl)` 之前;`archiveWorldSnapshot` 遇漂移抛错且一行不写;`bootstrap()` 保持 9 张表(104:6/7/8/9) |

**P2 / P3(12 条)**

| # | 发现 | 处置 |
|---|---|---|
| P2-A | `mobOrdinals` 重号:`applyRestore` 按归档 id 重建,而 `rebuildWorld` 已把计数器清 0 ⇒ 后续发号从 `#1` 起重来、撞上已恢复实例;`addMob` 同 id **静默整只替换**(满血/丢 FSM),`killLedger` 按 id 去重 ⇒ 击杀被吞(经验不到账、不报错) | 已修:序号水位推进到「已恢复的最大序号」;`mob_boar`(无号)/ `mob_boar#0` / `mob_boar#x` 三种脏 id 不动水位;端到端钉「真刷出来的新怪不撞号」(102:4/5) |
| P2-B | `removePlayer` 漏清瞬态:未清 `foodBuffs` / `liveBubbles` / `sprayUntil` / `knockbacks`,且用 `bodies.delete` 摘物理刚体(五张旁表留着)⇒ 同名重连继承上轮料理 buff(且 `hpFlat` 并进上限)/ 泡泡 / 击退 | 已修:瞬态逐项清;摘刚体改走 `PhysicsWorld.remove`,`speedCapOf` 回 `null`(102:6/7) |
| P2-C | `KillLedger` 无界:只 add 无淘汰 ⇒ 常驻房间进程生命期内无界增长 | 已修:`server/src/combat/progression.ts` 的 `KillLedger` 按 `KILL_LEDGER_CAPACITY` FIFO 淘汰最老、窗口内仍去重、`reset()` 清顺序表(102:8) |
| P2-D | 写库无 DDL 兜底,且 `loadWorldArchive` 会交出「摘要字节数 ≠ BLOB 长度」的自相矛盾原料 | 已修:`server/src/db/schema_world_archive.sql` 带 `CHECK (length(snapshot_blob) <= 1048576)`(两后端 1048577 均被拦、1048576 收);摘要与 BLOB 不等 ⇒ `undefined`(104:10/11) |
| P2-E | `BUY_ITEM` 幂等键缺 actor 维:`purchaseCommit` 只传 `actorId` ⇒ 键退化成 `item#frame`,同帧同玩家第二单被判重放 | 已修:键带 actor,同帧第二单不再被拒;显式 `orderId` 重发仍按重放拒(105:1) |
| P2-F | 同一键的另一个面:同帧**两个玩家**买同一件会撞键 ⇒ 第二个被当重放拒 | 已修:负对照钉「键不同、各成交一次」(105:2) |
| P2-G | `USE_ALCHEMY_FURNACE` 判重发生在 `spend` + `gain` **之后** ⇒ 重放有副作用(再扣料 / 出第二炉 / 再 `brewAtFurnace`) | 已修:先 `claimFurnaceOrder` 再扣/产,重放**零副作用**(105:3) |
| P2-H | 炼金订单预占在失败后不释放 ⇒ 同一单号补齐条件也炼不了(订单被锁死) | 已修:失败路径 `releaseFurnaceOrder`,同单号补齐后可炼(105:4) |
| P2-I | 正向发放失败不撤销凭证:`bindItemSource` 之后 `!gain.allowed` 直接返回 ⇒ 那张串仍是合法来源 | 已修:`unbindItemSource` 撤销,撤销后同串被拒(105:5) |
| P2-J | 退回失败被吞:`ctx.applyInventory` 的返回值被丢 ⇒ `use_item` / `place_block` 的退回失败不进回执,退回凭证也不撤 | 已修:`refund()` 带返回值并入回执、退回凭证一并撤销(105:6) |
| P2-K | `RESET_WORLD` 不清本房间侧账:箱子 / 放置 / 宠物三本模块级 Map 全仓 0 个回收点 ⇒ 重置后残留到下一局 | 已修:`server/src/net/actions/reset_world.ts` 的 `forgetRoomSideLedgers` 挂在**成功**回执路径,**另一个房间不动**;`applied:false` 时一本都不动(105:7/8) |
| P3-A | 令牌只增不减:`RoomRuntime` 没有撤销口(P3) | 已修:新增 `revokeItemSource`;在真 `RoomRuntime` 上复核「登记过的令牌就是合法来源 / 撤销后同串被拒」(105:9) |

### 9.3 对前批台账的追加(§3 / §4 / §7 对应条目)

- §3.1 **P1-7**(文档数字/哈希陈旧)追加判据 **WS-FND-103:13**:§九 README sha256 过期属同一族,
  现在由「重算脚本 + 判据」双向钉住(改 README 不同步重算 ⇒ 红)。
- §3.2 **P2-10**(`snapshot_blob` 写库无上限)追加判据 **WS-FND-104:10/11**:1 MiB 上限已进 DDL(`CHECK`),
  `loadWorldArchive` 拒绝自相矛盾原料。
- §3.2 **P2-12**(`physics.spawn()` 覆盖同 id 不清旁表)追加判据 **WS-FND-102:7**:同族第二处 ——
  `removePlayer` 曾用 `bodies.delete` 绕过 `PhysicsWorld.remove`,现两条路同口径回收。
- §4 **R10 / R12 / R14** 三行:在该条列表末尾追加了「第四批追加」块(§4 末,逐条 R10 → `WS-FND-104:10/11`、R12 → `WS-FND-102:7`、R14 → `WS-FND-102:4/5`),原状态不变。
- §7.1 那张「判据 ↔ 条目」表只属第二批;第四批的同类对照在 **§9.1**(已在该表下注明)。

### 9.4 本批验证口径

- **未跑 `scripts/verify.ts --all`**(硬约束)。逐套件直跑 `node tests/<file>`:
  **114 套件 / 2259 用例全绿**(基座 FND 1245 条 / 100 套件,WS 编号 1014 条 / 14 套件);
  4 个新套件 8 / 13 / 12 / 9 条,全部 `N/N`。
- `node scripts/typecheck-baseline-audit.ts` ⇒ **基线 261 条 / 实测 261 条,唯一指纹 129/129**
  (`--docs` 之前先跑过 `node scripts/typecheck.ts`:261 条,与基线逐条一致,**未新增**)。
- `node scripts/verify.ts --docs` ⇒ **exit 1 / 2 项失败**,同一根因(不在本批写权限内):
  `WS-FND-102::KILL_LEDGER_CAPACITY` 被判「同义反复候选」—— 断言右侧取自被测常量
  ⇒ 容量写错也照样绿(README 自己写明「常量要在 actual 侧才保留牙齿」);
  连带 HANDOVER §三「同义反复候选 **0 条**(白名单 0)」与实测 1/0 不符。
  修点在 `tests/WS-FND-102`(期望值改字面量 + 留常量锚点)或 `verify.ts` 白名单;本批**未动**。
- 未跑 `content-lock`(未碰内容表);未 commit、未碰 `.pi/`。