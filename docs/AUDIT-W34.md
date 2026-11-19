# AUDIT-W34 · 八路审计汇编(第 2/8 组)

- **日期**:2026-11-18
- **结论**:八路审计走完全部生产 `.ts`(180/180),发现按 P0..P3 分级 —— **P0 2 条、P1 11 条全部已修且各有判据**;**P2 13 条 / P3 9 条登记未修**(逐条理由见 §4)。本轮唯一的代码改动是让 `RoomRuntime.expireItemSources()` 真的被调用(内存卫生,给 P0-2 收尾)。**2026-11-18 第二批处置**:P2/P3 中 **15 条已修**(判据 `tests/WS-FND-91..94`),**7 条仍登记** —— 逐条见 §3.2 的状态列与新增的 §7。**2026-11-18 第三批处置**:再关 **3 条**(P2-13 上界 / P3-6 钳制选址 / P3-8 双端同源拦截)+ 订正本文件与代码现状矛盾的措辞(P3-9),判据 `tests/WS-FND-95-gate-and-bounds.test.ts`;详见 §7.5 与 §8。**现存仍登记 4 条**:P2-3 / P3-1 / P3-5 / P3-9。
> ★ **本抬头已被 §7–§14 取代**(2026-11-18 第二批起共 8 批):上面「**现存仍登记 4 条**:P2-3 / P3-1 / P3-5 / P3-9」
> 只在**第三批收尾那一刻**成立 —— §9 起逐批处置,`docs/AUDIT-R-ITEMS.md` 已记 **22/22 全部已处置、「仍登记」= 0 条**。
> ⇒ 引用状态一律看 **§3.2 的状态列 / §9–§14 的逐批台账**(每条都点到判据编号),不要引本行的「4 条」与 §4 的旧账本。
- **2026-11-18 第四批处置(第二轮)**:新审计的 **8 条 P1 + 12 条 P2/P3** 全部已修且各有判据(`tests/WS-FND-102..105`,共 42 条判据);逐条见 §9。
- **2026-11-18 第五批处置(第三轮)**:本轮新审计的 **6 条 P1 + 12 条 P2/P3** 全部已修且各有判据,判据落在
  `tests/WS-FND-106-connection-lifecycle.test.ts`(13 条)、`tests/WS-FND-107-idempotency-hardening.test.ts`(9 条)、
  `tests/WS-FND-108-boss-party-bounds.test.ts`(6 条),外加 `tests/WS-FND-98` 的**补正 3 条**(14 → 17);
- **2026-11-19 第五轮处置(第四轮审计 / 第七批)**:**7 条 P1(6 已修 + 1 只登记)+ 22 条 P2/P3**,判据落在
  `tests/WS-FND-113..117`(13 / 13 / 9 / 8 / 6 = **49 条**);FND 号段 **01..117**、全仓 **126 套件 / 2381 条**。
  ★ 本轮靶子是**装配层与跨模块契约**(不是单模块深挖),逐条见 §12。
  逐条见 §10(含世界侧 `tended` 生产者的五处接线)。
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
> ★ **本抬头已被 §9–§14 取代**:下面四条「仍登记」(`P2-3` / `P3-1` / `P3-5` / `P3-9`)在第四批起逐条处置完毕 ——
> 逐条见 §9.2 / §11.2 与 `docs/AUDIT-R-ITEMS.md`(`R1..R22` **22/22 已处置**)。本表**只为回溯**保留当时状态。

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
> ★ **本行已被 §7–§14 取代**:`37 未关闭` 是 2026-11-18 第二批那一刻的读数。现值(2026-11-19 实测,
> 口径来源 `node scripts/backlog.ts`)= **133 条 / 0 未关闭 / 0 阻塞 / 133 已关闭**,与 `docs/AUDIT-R-ITEMS.md`
> 的「仍登记 0 条」一致。
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

## 10 2026-11-18 第三轮处置(第五批:6 条 P1 + 12 条 P2/P3)

> 判据:`tests/WS-FND-106-connection-lifecycle.test.ts`(13 条)、
> `tests/WS-FND-107-idempotency-hardening.test.ts`(9 条)、
> `tests/WS-FND-108-boss-party-bounds.test.ts`(6 条)—— 共 **28 条**,
> 外加 `tests/WS-FND-98-knockback-and-drops.test.ts` 的**补正 3 条**(14 → 17)。
> 下面 18 条按**发现**去重计数(同一修法的正/负对照算一条);严重度按 §2 的定义标注,
> 套件文件头已写明各自的条目归属:**P1 6 条 / P2·P3 12 条**。
> 关闭口径不变:已修 = 标记 ∧ 可查证据(每条点到判据编号)。

### 10.1 判据 ↔ 条目对照

| 套件 | 条数 | 钉住的条目 |
|---|---:|---|
| WS-FND-106 | 13 | P1-A 成员键不一致(1/2/3/4/5)· P1-B 超期回收漏清世界(6/7/8)· P1-C 凭证不续期(9/10/11/12/13) |
| WS-FND-107 | 9 | P1-D 世界侧重放静默出货(5)· P1-E 炼金键命名空间(4)· P2-1 `@DAY` 负小数撞键(1)· P2-2 结算台账无界(2)· P2-3 牧场零产出占键(3/9)· P2-4 预占索引无界(7)· P2-5 跨玩家顶键(6)· P3-1 `buyOnce` `at` 槽口径(8) |
| WS-FND-108 | 6 | P2-6 重复召唤重置满血(1)· P2-7 负伤害回血(2)· P2-8 非有限伤害毒化(3)· P3-2 `evaluateBreak` 缺字段抛(4)· P2-9 `settleBridgeRun` 非幂等(5)· P2-10 急单 `tended` 无生产者(6) |
| WS-FND-98(补正) | +3 | P1-F 击杀掉落丢**实例维**(15/16/17) |

### 10.2 逐条处置(18 条)

**P1(6 条)**

| # | 发现与落点 | 处置(判据) |
|---|---|---|
| P1-A | 连接生命周期:入场者的成员键取**凭证里的 `userId`**,而 `onLeave` / `onMessage` 取 Colyseus 的 `client.sessionId` ⇒ 席位与连接旁表**永不回收**、移动等输入**全部落空** —— `server/src/net/room.colyseus.ts` | 已修:两条路径统一到凭证键(重连换新 `sessionId` 时旧键被拆);判据 FND106-1/2/3/4/5(负对照:同一份报文用 `sessionId` 当键仍 `allowed:false`) |
| P1-B | 超期回收 `reapExpiredDisconnects` 是**唯一**没调 `host.removePlayer` 的移除路径(leave / join 超期都调了)⇒ 宽限超期者世界里留旧刚体,同名重进再 `addPlayer` ⇒ 同一 id 两份刚体 —— `server/src/net/room.ts` | 已修:三条移除路径各调一次;判据 FND106-6/7(负对照:只看房间侧**看不见**这个缺陷)/8(结构守卫:`host.removePlayer(` 与 `purgeSeat(` 的处数) |
| P1-C | 入场凭证**不续期**:token 只在 join/重连时签发 ⇒ 会话超 `JOIN_TOKEN_TTL_MS` 掉线后,`RECONNECT_GRACE_MS` 内用**同一张**凭证重连**必然**被拒 —— `server/src/net/room.ts` | 已修:宽限内过期凭证放行(三态 + 生效值 = 断线时刻 + 30s,且 TTL > 宽限期);判据 FND106-9/10/11/12/13 |
| P1-D | 世界侧**重放**拒绝仍回 `ok:true` ⇒ 静默出货 + 预占滞留(重放有副作用) —— `server/src/net/actions/use_alchemy_furnace.ts` | 已修:重放 ⇒ 整笔失败 + 回滚(撤凭证 / 收产物 / 释放预占 / 退材料);非重放拒绝 ⇒ 产物照发;判据 FND107-5 |
| P1-E | 炼金两套键共用 `ALCHEMY_LAB@ORDER:<串>` 同一个命名空间且不转义 ⇒ 客户端自造 `orderId` 可**顶掉别人的派生键**(服务端事实被客户端改写) —— `server/src/net/actions/use_alchemy_furnace.ts` | 已修:显式订单号与派生键分两个命名空间 + 转义;判据 FND107-4 |
| P1-F | 击杀掉落只吃 `worldSeed`,丢掉**击杀实例维** ⇒ 同一世界里同种怪要么**全掉**要么**全不掉**(概率维退化成常量;两个世界的逐次序列还会变得一样) —— `server/src/sim/world_sim.ts#settleKill` + `server/src/mobs/drops.ts` | 已修:种子 = 世界身份 + 实例 id(`mob_species#序号`);判据 FND98-15/16/17(补正) |

**P2 / P3(12 条)**

| # | 严重度 | 发现与落点 | 处置(判据) |
|---|---|---|---|
| P2-1 | P2 | `@DAY` 键:`Math.trunc(-0.5) === -0` 且 `-0 < 0` 为假 ⇒ 负小数被当成**合法第 0 天**撞键 —— `server/src/systems/idempotency.ts` | 已修:负小数(含负整数 / NaN / -∞)一律 `null`,正小数口径不变;判据 FND107-1 |
| P2-2 | P2 | 结算台账 `claims` 只增不删 ⇒ 常驻房间进程生命期内无界增长 —— `server/src/systems/idempotency.ts` | 已修:按 `SETTLEMENT_LEDGER_CAPACITY` FIFO 淘汰最老,窗口内仍去重;判据 FND107-2 |
| P2-3 | P2 | 牧场**零产出**也占该日键 ⇒ 补齐动物/饲料后同一天再也结算不了(静默 no-op) —— `server/src/systems/ranch.ts`(世界侧封装 `settleRanchOnce` 同一条) | 已修:零产出**出账但不占键**;判据 FND107-3/9 |
| P2-4 | P2 | 炼金**预占索引** `FURNACE_CLAIMS` 只增不删 ⇒ 无界 —— `server/src/net/actions/use_alchemy_furnace.ts` | 已修:FIFO 淘汰最老,最近窗口内仍判重放;判据 FND107-7 |
| P2-5 | P2 | 跨玩家顶键:动作面 A 自造 `= B` 的派生串 ⇒ **两人各成交一次** —— `server/src/net/actions/use_alchemy_furnace.ts` | 已修:两套键不同命名空间(负对照钉「键不同、各成交一次」);判据 FND107-6 |
| P3-1 | P3 | `buyOnce` 台账 `at` 槽的口径靠注释(「成交成本」被读成「已结算过 cost / 时刻」) —— `server/src/systems/depot.ts` | 已钉:判据以 `settlementSeenAt === cost` 固定口径;判据 FND107-8 |
| P2-6 | P2 | `BossRaidRuntime.summon` 自己不查 `states` ⇒ 同 `bossId` 二次召唤把整只 Boss **重置满血**、祭品照扣 —— `server/src/bosses/runtime.ts` | 已修:第二次 `BOSS_ALIVE`、不扣祭品、血量**不被重置**;判据 FND108-1 |
| P2-7 | P2 | `damageBoss` 无入参边界:`hp -= -50` 等于**回血** —— `server/src/bosses/phases.ts` | 已修:负伤害 ⇒ `{0,0}` 且 `hp ≤ maxHp` 仍成立;判据 FND108-2 |
| P2-8 | P2 | 非有限伤害 ⇒ `Math.min(hp, NaN)` 把 `hp` **永久毒化**(阶段永不切换) —— `server/src/bosses/phases.ts` | 已修:血量保持有限数、阶段仍算得出来;判据 FND108-3 |
| P3-2 | P3 | `evaluateBreak` 的「确定结论」承诺只覆盖未知 Boss ⇒ 三条判定对缺字段抛 `TypeError` —— `server/src/bosses/breaks.ts` | 已修:八个 Boss 喂 `{}` 一律 `ok:false`、**不抛**;合法输入语义不变;判据 FND108-4 |
| P2-9 | P2 | `settleBridgeRun` 每次调用都给未夺旗队 `score += built × 2` 且没有相位门槛 —— `server/src/party/modes.ts` | 已修:`settlement !== null` 直接返回(幂等)+ 未到 `SETTLED` 不发安慰分;判据 FND108-5 |
| P2-10 | P2 | `tickRushOrder` 的 `opts.tended` 全仓**没有生产者**:`tickPartyStep` 只算 `spraying` ⇒「连续运转 `OVERHEAT_SEC`(12 秒)不翻炒 ⇒ 起火」在生产里退化成**必然起火** —— `server/src/coop/rush_order.ts`(读口)/ `server/src/sim/world_sim.ts`(生产侧) | 已修(两侧):读口 `stationsBeingTendedBy`(只认 `RUNNING`);世界侧补 `tendUntil` 意图窗并喂进 `tickRushOrder`,见 §10.2.1;判据 FND108-6(含负对照:不喂 `tended` ⇒ 必起火) |

### 10.2.1 生产侧补法(本批唯一改到的 `.ts`)

`server/src/sim/world_sim.ts`,五处(语句锚点,行号会漂):

```
180   import { …, stationsBeingTendedBy } from '../coop/rush_order.ts'
1146  private readonly tendUntil = new Map<string, number>()      ← 与 sprayUntil 同形
3737  removePlayer():  this.tendUntil.delete(id)                  ← 与 sprayUntil 同列清
4895  reset():         this.tendUntil.clear()                     ← 同上
6288  extinguishDeviceByHand(): itemId === SHOVEL_ITEM_ID(212) ⇒ this.tendUntil.set(actorId, frameCount + FAST_PER_SLOW)
6064  tickPartyStep(): 与 spraying 同段用 stationsBeingTendedBy(rushRun, { x: b.x, y: b.y }) 收成 tended,
      再 tickRushOrder(this.rushRun, SIM_SLOW_DT, { spraying, tended })
```

- 只记**刚用过 212** 的玩家(与 D-13 的 `sprayUntil` 同一取舍):否则「站在工位旁边」= 自动翻炒。
- 窗口长度 = 一个慢帧(`FAST_PER_SLOW` 快帧),不新增数值常量;`removePlayer` 的 docblock 同步改成**五张**按 id 索引的瞬态表。
- 未接时的形态就是 FND108-6 的负对照钉住的**必然起火**;接上后「有人翻炒 ⇒ 不起火」在生产里成立。

### 10.3 对前批台账的追加

- §9.1 **P1-A**(击杀掉落落地)追加判据 **FND98-15/16/17** —— 「落得下来」之后**概率维**自己也要有实例维,
  否则 `dropChance` 退化成「该物种在此世界必掉 / 必不掉」(实测 0% 或 100%,且两个世界序列相同)。本条的落点与 P1-A 同一个函数(`settleKill`)。
- §3.2 / §4 的 **P2-3 / R3**(击退)状态不变:98 的 3 条新判据属 P1-A 族,`FND98-1..8` 仍钉着击退上界。
- 本轮清单里**没有**再出现「修法只对了一半」的形态之外的新族;§3.2 末尾的「第四批追加」块不动。

### 10.4 本批验证口径

- `node scripts/verify.ts --all` ⇒ **exit 0 / 行首 ✗ 0 项**(本机 167s,秒数别当基准):
  `用例汇总:2290 条通过(117 个套件;WS-01..11 共 1014 条 / 14 套件;基座 1276 条 / 103 套件)`,
  README 与 HANDOVER 的用例数 / 套件数行由门禁逐条比对通过;`HANDOVER §九 sha256 表自洽` 亦通过。
  唯一的告警是**临时残留 330 个**(审计扫描根之外,按设计只告警、不属三道 strict),不是本批引入。
- `node scripts/typecheck-baseline-audit.ts` ⇒ 基线 **261 条 / 指纹 129**,实测 **261 / 129**(**未新增**)。
  `WS-FND-106` 那 3 条 `TS2339`(判别联合上取 `reason`)已由 `reasonOf()` 收窄,不进基线。
- `docs/HANDOVER.md` §九 sha256 表重算:`README.md` `f7c0030f2fb1 → c3ffd82859ac`;
  `docs/COMPLETION-CRITERIA.md` 不变(`fc1142dd0afb`)。重算用临时脚本副本跑完即删(LF 归一 = 索引 blob 口径)。
- 逐套件:`WS-FND-106` 13/13 · `WS-FND-107` 9/9 · `WS-FND-108` 6/6 · `WS-FND-98` 17/17。
- 未 commit、未碰 `.pi/`、未改 `docs/` 下本轮写权限之外的文件。

---

## 11 2026-11-18 第四轮处置(第六批:5 条 P1 + 28 条 P2/P3)

> 判据:`tests/WS-FND-109-worldsim-invariants.test.ts`(8 条)、
> `tests/WS-FND-110-blueprint-bounds.test.ts`(9 条)、
> `tests/WS-FND-111-combat-numeric-bounds.test.ts`(11 条)、
> `tests/WS-FND-112-gate-no-silent-skip.test.ts`(14 条)—— 共 **42 条**;
> FND 号段 **01..112**、基座 **107 套件**、全仓 **121 套件 / 2332 条**。
> 条数按**发现**去重(同一修法的正 / 负对照算一条):**P1 5 条 / P2·P3 28 条**
> (P2 19 / P3 9)。严重度:`WS-FND-109` 的文件头自带 ★P1 / ★P2 / ★P3 标注,
> **110 / 111 / 112 的文件头未标** ⇒ 下表按 §2 定义**就地判定**(判据编号即证据,可复核)。
> 关闭口径不变:已修 = 标记 ∧ 可查证据(每条点到判据编号)。

### 11.1 判据 ↔ 条目对照

| 套件 | 条数 | 钉住的条目 |
|---|---:|---|
| WS-FND-109 | 8 | R4-P1-5 扣料中途失败不回滚(1/2/3)· R4-P2-1 炉火单向闩锁(4/5)· R4-P2-2 `removePlayer` 漏清 `afkRuns`(6)· R4-P3-1 重复行守卫(7)· R4-P2-3 派对台账只登记(8) |
| WS-FND-110 | 9 | R4-P2-4 蓝图游程**展开前**不判上界(1/2)· R4-P2-5 空蓝图编码入口不收(3)· R4-P2-6 `overlapCells` 口径(4)· R4-P2-7 `serializeWireView` 丢格(5)· R4-P2-8 配方可选件只数 OBJ 层(6/7)· R4-P2-9 接力选项静默夹取(8)· R4-P3-2 `data-conformance` 硬编码 8(9) |
| WS-FND-111 | 11 | R4-P2-10..14 元素矩阵五条(1..5)· R4-P2-15 `vitals.heal`(6)· R4-P2-16 `gainExp`(7)· R4-P2-17 铲子词条池(8)· R4-P2-18 `hpFlat`(9)· R4-P2-19 泡泡连击窗口(10)· R4-P3-3 `createTarget` `shieldMax`(11) |
| WS-FND-112 | 14 | R4-P1-1..4 门禁四处静默跳过 + 计数对账(1..8)· R4-P3-4..9 **旧判据元审计**六条(9..14) |
| 元审计(本轮自查) | — | R4-P2-20 新套件自身的同义反复候选 3 条(见 `[同义反复候选]` 节) |

### 11.2 逐条处置

**P1(5 条,全部已修)**

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R4-P1-1 | P1 | 判据形态审计静默降级:删掉 `scripts/judgement_audit.ts` ⇒ `verify.ts::checkJudgementAudit` 只 `advise`、不进退出码(同族另外四处用的都是 `fail`),「判据还活着吗」这一问**没人回答** | 已修:缺件 ⇒ `fail`(FND112-1;含负对照) |
| R4-P1-2 | P1 | `verify.ts::checkDocs` 在「`docs/WS-*.md` 一份不剩」时直接 `return` ⇒ 非 WS 文档 / 链接存在性 / 未决台账**三段一起**被跳过,README「WS 文档结构」静默降级成「未校验」 | 已修:0 份 ⇒ `fail`,另三段照跑(FND112-2) |
| R4-P1-3 | P1 | `verify.ts::checkClientBuild` 在 `node_modules/vite` 不存在时只 `console.log` + `return` ⇒ 既不计 advise、也不进汇总行;而它是 `client/**/boot.ts` 零测试覆盖下**唯一**的自动化验证 | 已修:降级 ⇒ advise 进汇总(FND112-3) |
| R4-P1-4 | P1 | `scripts/count-audit.ts`:`CLAIM_FLOORS` 里两类下限写 **0**(= 没有保护);`countEntries` 缩进一变返回 **0**(非 `null`)而断言 #2 只查 `undefined` ⇒ 「自称 0 与实测 0」逐字全绿 | 已修:每类具名下限 **≥1**;表数为 0 时报「正解为 0 未登记」(FND112-4..8,含三处注入:改词 / 改缩进 / 清空) |
| R4-P1-5 | P1 | `server/src/sim/world_sim.ts` 的 `forgeAlchemy` 逐项扣料,某项不足就 `return` ⇒ **已扣的永久消失**,与「`ok:false` 时世界完全未被改动」的自述矛盾;且复核只在 `await` **之前** | 已修:`consumeMaterialsFor` 先全量复核 + 还原分支(件数与次序逐字段);`await` 后的复核回到扣减**之前**(FND109-1/2/3,**零调用**通道也有判据) |

**P2 / P3(28 条)**

`WS-FND-109`(`server/src/sim/world_sim.ts`)

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R4-P2-1 | P2 | `extinguishStationAt` 置 `fireOut` 后**全仓无复位路径** ⇒ 一次灭火永久失效(单向闩锁) | 已修:`relightStationAt` 真复位,本来就点着 ⇒ `false`(FND109-4/5) |
| R4-P2-2 | P2 | `removePlayer` 只删连接态 `afkPlayers`,`afkRuns`(`dew` / `backgroundedAtSec` / `dozedSec`)从不清 ⇒ 同名重连继承上一轮的打盹计时 | 已修:`this.afkRuns.delete(id)`;慢帧 `afkTicked` 归零(FND109-6) |
| R4-P3-1 | P3 | `removePlayer` 体内 `this.knockbacks.delete(id);` 有两行**逐字重复**(合并残留) | 已修:只出现 1 次 + `afkRuns.delete` 在册(结构守卫,FND109-7) |
| R4-P2-3 | P2 | 注释声称 `GATHER` / `REACH_TARGET` 有「三个发射点」而实测只有一个;`startPartyRun` 全仓**零调用** ⇒ `partyRun` 恒 `null`、`partyPhase()` 恒 `'IDLE'` | **登记**(不冒充接线):判据钉「零调用 / 零发射点」,缺口写在 `notePartyEvent` / `partyRun` / `startPartyRun` 三处 docblock(FND109-8) |

`WS-FND-110`(`server/src/build/{blueprint,wiring_view,rooms}.ts`)

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R4-P2-4 | P2 | `decodeBlueprint` **先展开游程、后判格数**:`run = 5×10^14` 的一张**小码**就能挂死 / 爆内存 | 已修:上界判断移到展开之前;`MAX_RUN_CELLS` 具名常量 16384(合法),`+1` 非法且不误伤 128×128 单游程(FND110-1/2) |
| R4-P2-5 | P2 | `encodeBlueprint` 不收空 cells ⇒ 产出 `run=0` 码,报错指向**解码器**,根因在编码入口 | 已修:编码入口按 `cells.length !== w*h` 拒(FND110-3) |
| R4-P2-6 | P2 | `overlapCells` 字段文档写「两色以上重叠的**格**数」,实现返回 Σ(色数−1) ⇒ 本地 `overlapCells` 计数成**死代码** | 已修:统一到**格**口径(3 色格只算 1);负对照「无 3 色格时两口径才相等」(FND110-4) |
| R4-P2-7 | P2 | `serializeWireView` 用 `Math.min(run, 255)` 直接**丢掉**溢出格 ⇒ 512 宽一行反序列化错位、丢线且**不报错** | 已修:`>255` 的同值游程**分段发**(FND110-5) |
| R4-P2-8 | P2 | 房间配方只数「内部非 barrier 的 OBJ 层」⇒ `SAKURA_ONSEN`(304 地砖)/ `ECO_RANCH`(357 围合环)的可选件**恒不命中**、加分恒 0 | 已修:OBJ / FLOOR / 围合环三层都数,带「换地砖 / 普通墙 ⇒ 不命中」负对照(FND110-6/7)。纯材料类可选件(109 / 155 / 158)在原理上不在本文件可裁决范围 —— 文件头的「诚实边界」已写明 |
| R4-P2-9 | P2 | `buildRelayQueue` 用 `void options` + `Math.max(1, ...)` **静默夹取**;`perBuilderParallel ≤ 0` 永不派活 | 已修:`assertRelayOptions` 入口**抛**;合法值照常派活(FND110-8) |
| R4-P3-2 | P3 | `scripts/data-conformance.ts` 把「房间配方数」**硬编码成 8**,与表内 9 条恒冲突 ⇒ 该项**恒判 UNKNOWN**(空壳判据) | 已修:期望值取自表本身,断言不再自我比对(FND110-9)。同一文件仍是类型基线里被修掉的 1 条 `TS2367`(见 §11.4) |

`WS-FND-111`(战斗数值层)

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R4-P2-10 | P2 | `ELEMENT_COUNTER` 的 `ICE→SLIME = 1.25` 是全表**唯一**第五档值 | 已修:值域只允许 `{1.0, 1.5, 0.75, 0.5}`,6×6 全覆盖(FND111-1;负对照:把 1.25 写回 ⇒ 值越界 + 反克对不互反两条同时命中) |
| R4-P2-11 | P2 | `SLIME→LIGHTNING = 0.5` 与 `LIGHTNING→SLIME = 1.5` **不成对**(反克对不互反) | 已修:双向互反,全表恰好 6 条克制关系(四元环 4 + 星光克胶质 + 霜冻克胶质)(FND111-2) |
| R4-P2-12 | P2 | `elementMul` 与矩阵表**两份口径** | 已修:逐格等于表;同属性 0.5、`NONE` 行 / 列全 1.0(FND111-3) |
| R4-P2-13 | P2 | `SLIME→LIGHT = 1.0` ⇒ 星光**列**全是 1.0,`LIGHT` 只作攻击方、没有任何目标 | 已修:`SLIME→LIGHT = 0.75`,星光列的非中性项 = 胶质(FND111-4;负对照:改回 1.0 ⇒ `LIGHT` 两侧都不可达) |
| R4-P2-14 | P2 | `ICE` 的行 / 列是**不可达死键**,但没有任何登记 | 已修:`DEAD_ELEMENTS`(`kind = NO_ATTACKER`)与 `WEAPONS` 派生集合**双向**对齐(FND111-5) |
| R4-P2-15 | P2 | `vitals.heal` 收非有限值:`Math.max(0, NaN) = NaN` ⇒ `hp` **永久** NaN | 已修:`!Number.isFinite(amount)` ⇒ 返回 0 且不污染 `hp` / `iframeSec`;正对照(合法治疗、超量钳到上限)与负对照齐全(FND111-6) |
| R4-P2-16 | P2 | `gainExp` 收 NaN:出口 `exp < need` 恒 false ⇒ **Lv.1 + NaN = Lv.30** | 已修:入口拒非有限,档案原样回传;正对照「恰好一级所需经验 ⇒ Lv.2」「0 经验不升级」(FND111-7) |
| R4-P2-17 | P2 | 铲子词条池 7 条里 `dodge_rate` / `knockback_mul` **全仓零读取** ⇒ 606 / 607 的铲子词条是静默 no-op | 已修:池缩到 5 条(全部有 `statMods` 消费者);行为判据:6 道可出锅料理的铲子词条都必须**真的改变**至少一格 `statMods`(FND111-8) |
| R4-P2-18 | P2 | `hpFlat` **线性叠加**:602 × N ⇒ +30N,无封顶 ⇒ 一道菜无限放大生命上限 | 已修:`mergeFoodBuffs` 取最大(三份 ⇒ 仍 30);兼顾既有契约:单份 40 **逐字透传**、两份取强者 = 40(FND111-9) |
| R4-P2-19 | P2 | 倒地泡泡层数只 `+1`、**无衰减路径** ⇒ 任意间隔的第 3 发都「续杯」把 `invulnSec` 重置成 5 秒 | 已修:`BUBBLE_STACK_WINDOW_SEC`(= 困住时长 5s)过期清层,命中把窗口重置为 0(FND111-10;负对照:每发间隔 6s ⇒ 层数只到 1、不许续杯) |
| R4-P3-3 | P3 | `createTarget` 的 `shieldMax` 派生:两行**同条件** `if` 只剩一行 ⇒ 显式 `shieldMax` 的优先级被反转 | 已修:两者都给 ⇒ 显式 `shieldMax` 优先,`shield` 本体不被改写(FND111-11) |

`WS-FND-112`(**旧判据的元审计**:六条)

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R4-P3-4 | P3 | `tests/WS-FND-01` 的 A15 **零断言**(恒绿) | 已修:用例必须有真断言;负对照「抽掉断言后判据必须为 0」(FND112-9) |
| R4-P3-5 | P3 | `tests/WS-09:3832` 写 `eq(L.cols*L.rows, L.cols*L.rows)`(**恒真 / 两侧同源**) | 已修:尺寸自洽可**独立复算**(FND112-10) |
| R4-P3-6 | P3 | `tests/WS-FND-06:1028` 手册不在场 ⇒ `ok(true,'跳过')`,与「通过」**逐字相同** | 已修:跳过必须自报(计入 `SKIPS` + 打汇总行)(FND112-11) |
| R4-P3-7 | P3 | `scripts/doc-line-audit.ts` 只判行区间**起点**,终点越界不报 | 已修:终点越界必须报(FND112-12) |
| R4-P3-8 | P3 | `scripts/eol-audit.ts` 高危项合计只算 `[2] + [3]`,漏 `[1]`(纯 CRLF) | 已修:合计含 `[1]`(FND112-13) |
| R4-P3-9 | P3 | `scripts/dead_items.ts`:`reason` 可为空、`consumer` 可指向**不存在**的文件 | 已修:`reason` 非空 + `consumer` 指向真实文件(FND112-14) |

**元审计(本轮自查,1 条)**

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R4-P2-20 | P2 | **本轮新套件自身**的同义反复:`tests/WS-FND-111` 的 `eq(ba, ELEMENT_REVERSE_MUL)` / `eq(ba, ELEMENT_COUNTER_MUL)` / `eq(h3.downed.invulnSec, BUBBLE_TRAP_SEC)` 把**被测模块的导出常量**放在 expected 一侧(L150 / L152 / L347 / L367 / L371,5 个槽位、3 个常量名) | 已修:期望值全改**字面量**(0.75 / 1.5 / 5),常量只留在 **actual 一侧**当锚点(`eq(BUBBLE_TRAP_SEC, 5)` / `elementMul(...)`)。`[同义反复候选]` 命中 **3 → 0**;两个投影同步(`README.md:183` 与 `docs/HANDOVER.md` §三「同义反复候选」行) |

### 11.3 与交接单的两处**不一致**(如实记)

- `tests/WS-FND-111` 的文件头写「战斗数值层的**五处** P2」,而该文件实际列了 **11 条**判据(元素矩阵 5 + 有限性门 2 + 词条池 / `hpFlat` / 泡泡窗口 / `shieldMax` 各 1)。文件头那句是**选材来源**的残留;条数以判据实数为准(**11**),README / HANDOVER 的用例汇总也按 11 记。同一时期内该文件还带着 3 条同义反复候选(上面 R4-P2-20),两件事同源:**文件头与判据逐条对账没做**。
- §3.2 / §4 的编号(`P2-1..13` / `R1..R22`)是**第二批**的账本,本轮一律用 `R4-P1-*` / `R4-P2-*` / `R4-P3-*` 前缀,避免与旧号相撞。**仍登记的 4 条**(P2-3 击退上界 / P3-1 `applyRestore` chunk 解码 / P3-5 水位预算 / P3-9 顶点色 LOD 语义)**状态不变** —— 本轮的 109 / 110 / 111 / 112 都不覆盖它们。

### 11.4 本批验证口径

- `node scripts/verify.ts --all` ⇒ **exit 0 / 行首 ✗ 0 项**(本机 ≈213s,秒数别当基准):
  `用例汇总:2332 条通过(121 个套件;WS-01..11 共 1014 条 / 14 套件;基座 1318 条 / 107 套件)`;
  `[同义反复候选]` 命中 **0** 条(白名单 0);README 与 HANDOVER 两张数字表由门禁逐行比对通过;
  `HANDOVER §九 sha256 表自洽` 亦通过。唯一的告警是**临时残留**(审计扫描根之外,按设计只告警、不属三道 strict),不是本批引入。
- 逐套件:`WS-FND-109` 8/8 · `WS-FND-110` 9/9 · `WS-FND-111` 11/11 · `WS-FND-112` 14/14。
- `node scripts/typecheck-baseline-audit.ts` ⇒ 基线锁 **261 条 / 指纹 129**,实测 **260 / 129**
  (**未新增**,且 `scripts/data-conformance.ts` 的 1 条 `TS2367` 被本轮修掉)⇒ HANDOVER §三 如实写 **260**,
  并注明「基线锁文件仍是 261,只准减不准增」。**不用** `--update`(本轮不动基线锁)。
- `docs/HANDOVER.md` §九 sha256 表重算:`README.md` `c3ffd82859ac → 0a2bd9115599`,其余 6 个**不变**;
  重算用临时脚本副本跑完即删(LF 归一 = 索引 blob 口径)。
- 数字落点:`README.md:62-64`(121/121 · 2332 个用例;基座 FND-01..112 · 1318 条 / 107 套件)、
  `README.md:309`(121 份测试套件 / 303 个 `.ts`)、`docs/HANDOVER.md:27`(121 个套件)、
  `docs/HANDOVER.md:96`(用例行 + 第八批 109/110/111/112 = 8/9/11/14)、`docs/HANDOVER.md:102`(类型基线 260)、
  本文 §11。号段 **FND-01..112**。
- 未 commit、未碰 `.pi/`;本轮写域:`tests/WS-FND-111-combat-numeric-bounds.test.ts`(仅同义反复槽位)、
  `README.md`、`docs/HANDOVER.md`、`docs/AUDIT-W34.md`。

---

## 12 2026-11-19 第五轮处置(第七批:7 条 P1 + 22 条 P2/P3)

> 判据:`tests/WS-FND-113-client-prediction.test.ts`(13 条)、
> `tests/WS-FND-114-wiring-producers.test.ts`(13 条)、
> `tests/WS-FND-115-host-contract.test.ts`(9 条)、
> `tests/WS-FND-116-hardening-reverse-review.test.ts`(8 条)、
> `tests/WS-FND-117-judgement-hardening.test.ts`(6 条)—— 共 **49 条**判据;
> FND 号段 **01..117**、基座 **112 套件 / 1367 条**、全仓 **126 套件 / 2381 条**。
>
> ★ **本轮的靶子与前四轮不同**:不再往单个模块里挖,而是**装配层**与**跨模块契约**。
> 前四轮的判据几乎全落在「零件」—— 单个函数、单张表、单个守卫;零件全绿,装起来却不对。
> 这一轮专挑三种形态:
> 1 **接线断在装配点**:参数没传、生产者不存在、宿主成员是空桩 —— 每一侧单独测都是「对」,
>   只有整条链测不出来的人才会以为它通;
> 2 **契约与唯一实现不一致**:接口声明 6 个成员而生产实现少一个;回执形状靠 `as unknown as`
>   绕过类型(契约说一套、实际另一套);
> 3 **加固自己长出新缝**:上几轮加的守卫把合法旧字节判成坏数据、把「够长才 decode」当默认。
>
> 条数按**发现**去重(同一修法的正 / 负对照算一条):**P1 7 / P2 14 / P3 8 = 29 条**,
> 其中**产品缺陷 23 条 + 元审计 6 条**(117 判的是「上一轮的判据会不会红」,不是新产品缺陷)。
> 关闭口径不变:已修 = 标记 ∧ 可查证据(每条点到判据编号)。

### 12.1 判据 ↔ 条目对照

| 套件 | 条数 | 钉住的条目 |
|---|---:|---|
| WS-FND-113 | 13 | R5-P1-1 预测参数从没传过 + 预测结果零渲染消费(1..6)· R5-P1-2 `state_store` 无单调门(11/12)· R5-P2-1 上行 z 恒 0(7)· R5-P2-2 重连不复位(8/9/10)· R5-P3-1 装配点只能用源码子串(13,文件头已自报是弱判据) |
| WS-FND-114 | 13 | R5-P1-3 40 项件生产者台账(1/12)· R5-P2-3 环境注入只答 `hour`/`night`(2..9)· R5-P2-4 `graph.race` 第二场永不停表(10)· R5-P2-5 `STATE_DEFAULTS` 的投影字段从不 `setSt`(11)· R5-P2-6 无电路时 `loadConveyorAt` 谎报成功(13) |
| WS-FND-115 | 9 | R5-P1-4 `inventoryDetailOf` 在生产宿主上是空桩(1..3)· R5-P1-5 回执形状靠 `as unknown as` 绕过类型(4..6)· R5-P2-7 `ActionPayload` 缺 7 个动作消费的键 · R5-P2-8 `WorldSaveHost` 漏声明 6 个被实际读取的成员 · R5-P3-2 `partyMode` 两处维护 + `hostPositionOf` 声明 `{x,y}` 而实返含 z |
| WS-FND-116 | 8 | R5-P1-6 快照 RLE 长度越界被静默接受(1)· R5-P1-7 三键齐删后无降级信号(3)· R5-P2-9 屋顶 ID 值域在快照 / 回滚路径同源(2)· R5-P2-10 `CHECK` 合取在内存后端也真的校验(4)· R5-P2-11 编码侧 `trim` 校验与解码同源(5)· R5-P2-12 `fluid.setCell` 实心格判定与写入值同源(6)· R5-P3-3 `parseCheckExpr` 真值表(7)· R5-P3-4 加固不得把合法旧字节 / 未裁剪归档打成坏数据(8) |
| WS-FND-117 | 6 | **元审计**:R5-P2-13 恒真槽位(`WS-FND-111` 的 5 个槽)(1)· R5-P2-14 用未剥注释的 body 做子串断言(`WS-FND-112`)(2)· R5-P3-5 / R5-P3-6 子串判据两处(`WS-FND-110:353` / `WS-FND-109:310`)(3/4)· R5-P3-7 缺 typescript 时 `console.log + return` 不进汇总(`verify.ts:3777-3780`)(5)· R5-P3-8 计数下限只挡 0、没钉在实测值上(`count-audit.ts:363-367`)(6) |

### 12.2 逐条处置

**P1(7 条:6 已修 + 1 只登记)**

| # | 发现与落点 | 状态 / 判据 |
|---|---|---|
| R5-P1-1 | 客户端预测链**两端都断着**:`main.ts` 全文无 `speedMul` / `frozen` / `mu`(眩晕、击退、背人、装备加速在生产里**必然分歧**);`predictor.renderPos` / `visualOffset` 全仓**零读者**(玩家看到的仍是滞后一个 RTT 的权威位置)—— `client/src/main.ts` + `client/src/net/predictor.ts` | 已修:`predictor.setParams(predictParamsOf(me))` 落在装配点,渲染改读 `predictedRenderPos` / `predictedVisualOffset`;FND113-1..6(注入:不传参数 ⇒ 同场景走 0.225 格;负对照:不校正时 `render == pos`) |
| R5-P1-2 | `ClientStateStore` **无单调门**:`ackedSeq` 可倒退、`meta.tick` 无条件覆盖 ⇒ **旧帧能把权威位置拉回**(静默回退,零报错)—— `client/src/net/state_store.ts` | 已修:新增 `'stale-frame'` 丢弃旧差量、`ackedSeq` 只进不退;FND113-11/12(豁免:旧 FULL 仍接受) |
| R5-P1-3 | 电路 **40 项件生产侧没有任何生产调用点**(只有 `sim/demo.ts` 与 tests)⇒ `WorldSim` 的 `if (wiringOn)` 求值块**空转**;件层判据全绿也测不出 — `server/src/wiring/components.ts` | **登记**(不声称接线):`COMPONENT_PRODUCER_LEDGER` 40 行逐件登记生产者、`NONE` 行如实记为欠账;接线点在 `net/actions/**`,不在本轮写域。FND114-1/12(含三类调用点的静态扫描 + 「无电路 ⇒ 求值块不跑」负对照) |
| R5-P1-4 | 宿主契约**空桩**:`room.ts` 只读 `host.inventoryDetailOf`,而唯一生产宿主 `world_sim.ts` 恒返回 `null` ⇒ 「总量按明细重算」**永不执行**;总量由增量式 `inventoryTotals`、明细由 `itemCounts` 各自维护 ⇒ **漏一帧就永久偏差**(契约 §2.3 的 W5 裁定) | 已修:生产宿主落地该成员;FND115-1..3(增量与明细**两侧对账**) |
| R5-P1-5 | 回执形状不统一:`EffectRecord` 只允许**标量**,而 `craft` / `use_alchemy_furnace` 塞嵌套对象 / 数组并用 `as unknown as EffectRecord` **绕过类型** ⇒ 契约说一套、实际另一套 | 已修:形状收成允许的联合,两处不再靠 `as unknown`;FND115-4..6 |
| R5-P1-6 | 快照 RLE **声明长度超出剩余字节**时被**静默当成「没有屋顶」** ⇒ 坏字节当合法档读回(静默丢数据)—— `server/src/world/chunk.ts` | 已修:`deserializeSnapshot` 抛错;缺屋顶尾段的**旧布局**仍解得开。FND116-1(注入:改回「够长才 decode」⇒ 7/8) |
| R5-P1-7 | 归档头**三键齐删**(`trim` + `chunksTotal` + `chunksChecksum`)⇒ 缺口语义归 0、却没有任何降级信号,「不可判」被读成「完整」—— `server/src/world/archive.ts` | 已修:`planRestore.chunksVerified === false` 是**不可信状态**。FND116-3(注入:删掉那条判定 ⇒ 6/8) |

**P2 / P3(22 条)**

| # | 严重度 | 发现与落点 | 状态 / 判据 |
|---|---|---|---|
| R5-P2-1 | P2 | 上行 `z` 恒为 0:`predictor` 的构造 / `reset` / `onAuthoritative` 三处都写 `z: 0` ⇒ 权威高度被逐帧抹平 | 已修:播种 z=2 ⇒ `pos.z === 2`、回喂 z=3 ⇒ 抬到 3;FND113-7(注入:改回 `z: 0` ⇒ 0) |
| R5-P2-2 | P2 | 重连**不复位**:`reset()` 只在首帧调一次,`InputSource.seq` 与摇杆都还是上一轮的 ⇒ 重连后第一个输入即错位 | 已修:`InputSource.reset`(seq 回 1 / 按键清空)+ `predictor.reset`(队列 / acked / 参数清);FND113-8/9/10(含「被动掉线 ⇒ 自动重连」,否则复位在生产里永不触发) |
| R5-P2-3 | P2 | 环境注入只答 `hour` / `night` ⇒ 该层输入判据恒假、`moored === 0` **恒真**(判据自我实现) | 已修:`WorldSim.installWorldEnv` 逐格真的按世界事实回答(`WORLD` 11 个键),`NONE` 的如实登记为欠账;FND114-2..9(逐格键各配「同一世界同一帧但不是这一格」的负对照) |
| R5-P2-4 | P2 | `graph.race` **第二场永不停表** | 已修:两场都停、第二场是新值;FND114-10 |
| R5-P2-5 | P2 | `STATE_DEFAULTS` 的投影字段从不 `setSt`(读数恒 0)⇒ 件状态与线输出两张皮 | 已修:两极性双向对账;FND114-11 |
| R5-P2-6 | P2 | `wiringOn = false` 时 `loadConveyorAt` 说成功而货**永不回写**(静默吞货) | 已修:无电路 ⇒ 拒绝装载且货留地面;FND114-13 |
| R5-P2-7 | P2 | `ActionPayload` 缺 7 个动作消费的键 ⇒ 各消费方自己补交叉类型 | 已修(契约面):键进接口;FND115 |
| R5-P2-8 | P2 | `WorldSaveHost` 未声明 6 个**被实际读取**的成员 ⇒ 全靠 `as` 交叉类型绕过,与接口自称的「结构化裁剪守卫」相悖 | 已修(契约面):成员补齐;FND115 |
| R5-P3-2 | P3 | `partyMode` 两处维护(`rt.partyMode` 只写不读)+ `hostPositionOf` 声明 `{x,y}` 而实返含 `z`(被静默丢弃) | 已修:单点维护 + 声明与实现一致;FND115 |
| R5-P2-9 | P2 | 屋顶 ID 值域(12 位 / 4095)只在 `setRoof` 强制,**快照 / 回滚路径**不强制 | 已修:`decodeRoofRle` 与 `setRoof` 同源(4095 收);FND116-2 |
| R5-P2-10 | P2 | `snapshot_bytes` 的上下界在**内存后端**不校验(`AND` 合取未被 `parseCheckExpr` 认得)⇒ 双后端行为不一致 | 已修:双后端 −1 / 1 MiB+1 都拦、0 / 1 MiB 都收;FND116-4 |
| R5-P2-11 | P2 | 编码侧对 `trim` 无整数 / 非负校验 ⇒ 能产出「自家解码必抛」的字节(2.5 / −1) | 已修:`trimIntField` 在**编码**就抛,与解码同源;FND116-5 |
| R5-P2-12 | P2 | `fluid.setCell` 的实心格判定用**入参原值**而非写入值 ⇒ `amount: 0.5`(floor 后为 0)被误抛 | 已修:判定与写入值同源(`0.5` / `0.9` 不抛、`1` 仍抛);FND116-6 |
| R5-P3-3 | P3 | `parseCheckExpr` 只「半懂」`AND`:同列合取 / `BETWEEN 1 AND 30` / 跨列合取的归类未钉 | 已修(判据钉真值表):同列 ⇒ `and`、`BETWEEN` 仍 `between`、跨列 ⇒ `unsupported`;FND116-7 |
| R5-P3-4 | P3 | 加固**可能把合法旧字节 / 未裁剪归档打成坏数据** | 已修(反向锁):`encode(decode(x))` 逐字节往返、`ops` 自足、`missing` 不伪造;FND116-8 |
| R5-P2-13 | P2 | **元审计**:`WS-FND-111` 的 5 个槽是**恒真断言**(`30*3===90` / `Math.max(0,NaN)` / 本地数组 / 本地循环),一次也不碰被测模块 | 已修:探针 `tautologySlots()` 剥注释后按五条形态扫,≥1 即报;FND117-1 |
| R5-P2-14 | P2 | **元审计**:`WS-FND-112` 用**未剥注释**的 body 做子串断言 ⇒ 把被检代码注释成死代码仍可能绿 | 已修:先复现「注释掉 ⇒ 旧判据仍绿」、剥注释后必须红;FND117-2 |
| R5-P3-5 | P3 | **元审计**:`WS-FND-110:353` 的 `src.includes('const unusable')` 子串判据,写回字面量仍绿 | 已修:`selfCheatSubstrings()` + 真跑 `data-conformance` 看 ✓;FND117-3 |
| R5-P3-6 | P3 | **元审计**:`WS-FND-109:310` 的 `WORLD_SIM_SRC.includes('零调用')` 同族 | 已修:同上 + 真调用 `startPartyRun`;FND117-4 |
| R5-P3-7 | P3 | **元审计**:`verify.ts:3777-3780` 缺 typescript 只 `console.log + return`,不进汇总行 | 已修:结构断言 `advise('类型检查基线锁'…)`(注入:换回 `console.log` ⇒ 红);FND117-5 |
| R5-P3-8 | P3 | **元审计**:`count-audit.ts:363-367` 的下限 `1` 只挡得住 0,没有钉在**实测值**上 | 已修:`CLAIM_FLOORS ⇄ CLAIM_MEASURED` 互校 + 降下限负对照;FND117-6 |

### 12.3 与前批台账 / 交付口的三处**不一致**(如实记)

1 **R5-P1-3 仍是「登记」不是「已修」**:40 项件的接线点在 `net/actions/**`,不在本轮写域,
   所以本文件只记「登记 40 行台账 + 负对照」,不写「电路层可用」。与 §11.2 的 R4-P2-3 同一取舍
   (**不冒充接线**)。它的严重度记 P1 的理由也写在判据里:件层判据全绿、生产求值块空转,
   属「判据面失效」而非「某个功能不灵」。
2 **`WS-FND-113` 的 FND113-13 是弱判据**:`three/boot.ts` 与 `main.ts` 都摸 DOM,node 里 import
   不了,只能做**源码子串**结构守卫;强判据是 1..12(可 import、可注入)。文件头已自报,
   这里一并记,免得下一位把它当成行为判据。
3 **117 不计入产品缺陷**:它的 6 条判的是**上一轮判据的牙口**(恒真槽位 / 未剥注释 / 子串 /
   `console.log + return` / 下限只挡 0),不是新产品缺陷。本文件按「发现」口径把
   **产品 23 条(7 P1 + 12 P2 + 4 P3)与元审计 6 条(2 P2 + 4 P3)** 分开数,29 是两者之和。

### 12.4 本批验证口径

- `node scripts/verify.ts --all` ⇒ **exit 0 / 行首 ✗ 0 项**:
  `用例汇总:2381 条通过(126 个套件;WS-01..11 共 1014 条 / 14 套件;基座 1367 条 / 112 套件);跳过 0 项`,
  `[同义反复候选]` 命中 **0** 条(白名单 0)、`HANDOVER §九 sha256 表自洽`、README 与 HANDOVER 两张数字表逐行比对通过。
- 逐套件实跑(`node tests/<file>`,126 个逐条跑完、**0 个非零退出**):合计 **2381 / 126**;
  本批 5 个套件 `113` 13/13 · `114` 13/13 · `115` 9/9 · `116` 8/8 · `117` 6/6。
- **同义反复候选 0 ⇒ `tests/` 一个字节都没改**:§11.2 的 R4-P2-20 已把 `WS-FND-111` 的 5 个
  槽位改成字面量,本轮 `--all` 复核仍为 0,故「仅同义反复槽位」的写权限**未动用**。
- `node scripts/typecheck-baseline-audit.ts` ⇒ 基线锁 **261 条 / 指纹 129**,实测 **259 / 128**
  (**未新增**:`scripts/data-conformance.ts` 的 `TS2367` 与 `tests/WS-FND-10-restore.test.ts` 的
  `TS2339` 各少 1)⇒ HANDOVER §三如实写 **259**,**不用** `--update`(基线锁仍 261,只准减不准增)。
- `docs/HANDOVER.md` §九 重算:`README.md` `0a2bd9115599 → 99bc3c8e8474`,其余 6 个**不变**;
  重算用临时脚本副本跑完即删(LF 归一 = 索引 blob 口径)。
- 数字落点:`README.md:62-64`(126/126 · 2381 个用例;基座 FND-01..117 · 1367 条 / 112 套件)、
  `README.md:347-348`(类型检查 259 · tests 205 / scripts 15)、`README.md:309`(126 份测试套件 /
  308 个 `.ts` / 约 15 万行,五源口径)、`README.md:315`(带日期的实测快照)、
  `docs/HANDOVER.md:27`(126 个套件)、`:96`(用例行 + 第九批 113..117 = 13/13/9/8/6)、
  `:102`(类型基线 259 / 指纹 128)、本文 §12。号段 **FND-01..117**。
- 未 commit、未碰 `.pi/`;本轮写域:`README.md`、`docs/HANDOVER.md`、`docs/AUDIT-W34.md`。

---

## 13 2026-11-19 第六轮处置(「有实现、有判据、没接进生产路径」)

> **本轮的靶子不是某个缺陷,而是一个反复出现的形态:**
> 一个子系统**实现完整、判据全绿、`verify.ts` 全绿**,却**没有第二个调用者** ——
> 除了测试与门禁,生产路径上没人调它。
>
> 逐条的符号级台账、位置、现状、理由、判据,全部落在 **`docs/WIRING-LEDGER.md`**(**36 行**)。
> 本节只登记**处置**与**结论**;不重复那 36 行正文(两处各写一遍必然发散)。
> ★ 第七轮订正:上一版写「34 行」,而表体实测 **37 行**(算术错),且 `R6-CL-6`(§2.9)整条是**错的**(`#hint` 有读点)
> ⇒ 撤回该条后 **36 行**;`§13.2` / `§13.3` 的三处计数已按 36 重算。

### 13.1 判据 ↔ 条目对照

| 来源 | 覆盖的 R6 条目 | 说明 |
|---|---|---|
| `tests/WS-10.test.ts` · `WS-FND-118` | R6-CBT-1..6 | 技能 / 天赋 / 反伤 / 幽灵 / 整蛊菜 / 飘字:表与算法各有断言;**「生产里谁在调」改由 `combat/wiring_ledger.ts` 双向判据钉住**(FND118) |
| `tests/WS-11.test.ts` · `WS-FND-108` · `WS-FND-120` | R6-PARTY-S1..S5 · A1..A3 · PRANK-1 · SOC-1..4 | 派对 / 玩具 / 社交四段:结算与动作函数逐个测过;接线后 FND120 **反向断言** `PARTY_ACTION_LEDGER` / `RUSH_ACTION_LEDGER` 的 `WIRED:` 行真有调用点 |
| `tests/WS-04.test.ts` · `WS-FND-29/41/46` | R6-TAME | 驯服整模块 27 export 全测过,模块级在可达性白名单里 |
| `tests/WS-07.test.ts` | R6-SH-1..3/7 | 协议表与差量函数:编解码两侧都有判据,客户端只用了名字表(`STATE_FLAG_NAMES`) |
| `tests/WS-FND-66` | R6-SH-4/5/6 | 三条契约先行模块(gate-only / 差集型) |
| `tests/WS-09.test.ts` · `WS-FND-73/89/113/121` | R6-CL-1..5 | 客户端:渲染视图与 UI 控制器逐个测过;`drop()` / `tooltipFor` / `stepZoom` 的接线由 `client/src/wiring_ledger.ts` 的**见证片段**钉住(`CL-6` 已撤回 —— `#hint` 有读写点) |
| `tests/WS-FND-61/109/56` · `WS-FND-120` | R6-SIM-1..3 | world_sim 三个喂料口:`tended`/`spraying` 已接,且会话**不再恒 `null`**(`stepRushEntry` 是生产入口) |

> ★ 第七轮订正:上一版这里写着「第六轮 4 套件(`118/119/120/121`)撰写时不在磁盘上」——
> **四套件都在 `tests/` 里**(`Get-ChildItem tests -Filter 'WS-FND-1*.test.ts'` 可复算),
> 故本表已把它们当判据来源引用。撤回原句,不保留「没落盘」的说法。

### 13.2 逐条处置

口径:`已接` = 有生产调用点 · `已登记` = 已有白名单位置(`verify.ts` / `orphan-audit.ts`)·
`未接` = 生产调用点 0 **且**无白名单位置(门禁结构上看不见)。

| R6 条目 | 处置 | 一句话 |
|---|---|---|
| CBT-1 技能 | **已接** | `world_sim.ts#attackMob`(`useSkill`)读 `skillOf` / `planSkillHits`;台账 `COMBAT_WIRING_LEDGER` 两行 = WIRED。剩余缺口不在战斗侧(net 无 [Q] 报文 / PvP 仍 `skill: null`) |
| CBT-2 天赋 | **部分接** | 只有 `isTalentUnlocked` 1 处(梦境天赋);`TALENTS` / `activeTalents` 台账 = UNWIRED |
| CBT-3 反伤 | **已接** | `world_sim.ts#resolveMobStrikes` 把反伤经 `damageMob` 打回攻击者;台账 `reflectFrom` = WIRED |
| CBT-4 幽灵 | **已接** | `ghostControl` 由 `canActAsPlayer` 消费(台账 WIRED);`ghostDamageMul` 台账 UNWIRED **且按设计不接**(规则归 `vitals`) |
| CBT-5 整蛊菜 | **已接** | `cookSoup` 1 处(craft 动作);`cleansePrankBuffs` 由 `useItem` 料理分支按 `flags.cleanse` 触发(台账 WIRED);`PRANK_PRIORITY` 仍只本模块内读 |
| CBT-6 飘字 | **未接** | `FloatSpec` 有完整规格,客户端零读者(台账 = RESERVED) |
| SIM-1 `startRushRun` | **已接** | `stepRushEntry`(慢帧)按「食堂建成 + 三工位 + 有人站工位」开工;`RUSH_ACTION_LEDGER` 的 `START` = WIRED |
| SIM-2 `roomLevel`/`stock` | **已接**(半) | `roomLevel` 取 `RUSH_ENTRY_ROOM_LEVEL` 并由 `stepRushEntry` 传入;`stock` 仍传 `{}`(`ROOM_LEVEL` 行仍是 `EXTRA`) |
| SIM-3 `tended`/`spraying` | **已接** | 慢帧派生并喂入;★ 「喂给恒 `null` 的会话」已不成立(SIM-1 接线后会话真的存在) |
| TAME 整模块 | **已登记** | `verify.ts:2086` + 交叉表 `:5129` + `orphan-audit.ts:143`;缺宿主(无 TAME 动作),`feedPet` 生产调用点仍 0 |
| PARTY-S1..S5 五个 settle | **已接** | 五个 `mode.settleHook` 由 `settlePartyRun` ← `tickPartyMode` ← 世界慢帧驱动(`modes.ts:284/417/552/677/749`) |
| PARTY-A1..A3 三个动作 | **已接** | `world_sim.ts#stepPartyContest` → `contestCrownPickup` / `contestCapture`;`stepRushDelivery` → `submitDelivery`(台账 WIRED) |
| PRANK-1 玩具表 | **已接** | 表被真消费(`party/actions.ts` 值导入 `prank/actions.ts`,`toyOf` + 由表生成的 `PRANK_ACTION_LEDGER`);35 件里只有 222/224/225 走到生产;`verify.ts:2119-2127` 已把 toys/immunity 从白名单摘除 |
| PRANK-2 `applyPrank` | **未接** | 全仓不存在 —— 这是上一条的**真缺口**,不是「等接线」 |
| SOC-1 水族箱 | **未接** | 镜头序列/混音表齐备,客户端宿主不读它 |
| SOC-2 信箱 | **未接** | 需离线存档容器 + 信箱 UI;`net/room` 只有 world/player 两块 |
| SOC-3 摊位 | **未接** | 与 `stallStock` 同名异义;无 BUY/LIST 动作 |
| SOC-4 赛道 | **未接** | 与 `party/modes.ts::RaceRuntime` 是两套实现;竞技那套已接,**社交这套仍 0 调用者** |
| SH-1 `EncodeStats`(网络) | **已登记** | `verify.ts:4615` 同名异义;生产里真实消费的全是蓝图那个 |
| SH-2 `StateFlagIndex` | **未接** | 客户端只 import 名字表 ⇒ 状态位解码只做一半 |
| SH-3 `FSM_NAMES` | **未接** | 同上,`wildlife.fsm` 离线索引 0 消费者 |
| SH-4 `types/events.ts` | **已登记** | `verify.ts:2161` + `:5144`(gate-only) |
| SH-5 `types/cooking.ts` | **已登记** | `verify.ts:2159`(差集型;`isDiffSet()` 自检在 `:3269`) |
| SH-6 `constants/cooking.ts` | **已登记** | `verify.ts:2160` + `:5148`(gate-only) |
| SH-7 `diffChunkVersions` | **未接** | 生产 0 调用者 ⇒ 每个 chunk 都当新档收 |
| CL-1 `renderPos` 系列 | **已接** | 具名读者 = `main.ts#__stageReady`(`predictor.renderPos`);渲染读者 = `main.ts` 把 `poseView` 交给 `boot.ts#setPoseSource`、`boot.ts#tick` 用 `predicted.render` 定立牌(★ 第十轮补查:`boot.ts` **不按名字**读 `renderPos`,旧文「`main.ts` / `boot.ts` 消费」只对一半)。`poseView` 4 字段里只剩 `.ackedSeq` 是 0 读者(`.logical` 已进 `boot.ts#summary` 自检口径) |
| CL-2 `stage_assembly` | **部分接** | 14 export 里接了 4;`createStage`/`buildBillboard`/`applyDyeUniforms` 等 9 个零消费者 |
| CL-3 `DragController.drop()` | **已接** | `boot.ts#onUiPointerUp` `dragCtl.drop(hover)`(客户端台账 `drop` = wired,含见证片段;★ 第十轮改**符号锚** —— 旧文 `boot.ts:1306` 已漂,实测 `:1451`) |
| CL-4 `slotTooltip`/`tooltipFor` | **已接** | `ui_binding.ts:629` `this.tooltipFor(...)`(台账 `tooltipFor` = wired) |
| CL-5 `isoCam.zoom`/`stepZoom` | **已接** | `boot.ts#onKeyDown` 键盘 `[` / `]` 调 `stepZoom`(台账 `stepZoom` = wired;★ 第十轮改**符号锚** —— 旧文 `boot.ts:1351` 已漂,实测 `:1526`) |
| ~~CL-6 `#hint`~~ | **整条撤回** | 实测**有**读点/写点(`boot.ts:574` `getElementById('hint')`、`:593` `textContent = ...`)⇒「代码从不读它」是错的,不再是符号级未接 |

### 13.3 ★ 本轮的定性结论(**这一句是本轮唯一的结论**)

> **多个系统「有实现、有判据、全绿,但没接进生产路径」。**
>
> 不是「某几个函数忘了调」,而是**判据体系的一处结构性盲区**:
> `生产可达性` 查的是**文件级 import 闭包**,`入口执行层` 查的是 **handler 那一句 `if (!allowed)`**;
> 两者之间那条「文件可达、符号没人调」的缝,**没有任何门禁在看**。
> ⇒ 全绿可以同时意味着「这块做完了」和「这块一次都没在生产里跑过」。
>
> **判据纪律(本轮唯一新增的一条)**:写「X 可用」之前先回答「X 的生产非自身调用点是多少」;
> 答不出就只能写「X 已实现」。这两个词的差别不是修辞 ——
> **36 行**台账里 **9 行是全未接、2 行是部分接、20 行已接、5 行已登记**,
> 而其中的未接部分**全部**在现有门禁下是绿的。
> ★ 第七轮订正:上一版写「34 行里 20 行全未接、5 行部分接」—— 三个数都错(表体 37 行、
> 撤回 `CL-6` 后 36 行;按符号逐条复核后,全未接只剩 9 行)。

### 13.4 本批验证口径(以及**没跑什么**)

- 逐套件实跑(`node tests/<file>`,**两次**,同一命令):
  ```
  第一次(t=0)           : 126 套件 / 2381 用例 / **0 个非零退出**(WS 1014·14 · FND 1367·112)
  第二次(t+~40min,并发写盘): 128 套件 / 2402 用例 / **6 个套件非零退出**
    WS-04(56/57) · WS-FND-90(6/7) · WS-FND-99(7/8) · WS-FND-103(12/13)
    WS-FND-109 · WS-FND-117
  ```
 六条全是**另一位写者**同一时刻未收尾的接线,不是本轮产物(抽样复核:
 FND-99 的合法镜像表缺新增的 `WiringStatus`;FND-90 的 orphan 清单多 1 个新文件)。
 ★ 第七轮撤回上一版这里的一句「WS-04 断言的『feedPet 生产调用点 0』实测 **1**」——
 **实测仍是 0**:`server/src/**` 对 `mobs/taming.ts` 的 import = 0,`feedPet` 只有定义
 (`taming.ts:125`)与一处注释(`intake.ts:44`)。⇒ 驯服**没有**在被接,那句话是错的。
- **第六轮 4 套件都在磁盘上**(`WS-FND-118/119/120/121`,`Get-ChildItem tests -Filter 'WS-FND-1*.test.ts'` 可复算)。
  ★ 第七轮撤回上一版「只有 `WS-FND-119` 已落盘,`118/120/121` 仍不在磁盘上」—— 四个都在,故 §13.1 已把它们当判据来源。
  ⇒ README `:62-66` 与 HANDOVER `:27/:96` **本轮不改数**:第一次读数与现值逐字一致(126/2381),
    第二次读数**带 6 个红**,把 2402 写进「N/N ✅ 共 M 个用例」那一行 = **把 6 个红标成绿**。
  ⇒ 这一条比「数字不准」更要紧:本轮审的正是「全绿」这个词值多少钱,
    那就不能在自己刚落盘的文档里先造一个假的绿。**等全绿后由 `verify --all` 的当场输出覆盖。**
  ⚠️ `WS-FND-119` 新增了 1 个同义反复候选(`WS-FND-119-systems-fed::CROP_MATURE_DAYS`),
  `--strict-taut` 会因此红;`tests/` 不在本轮写域,已留给该套件的作者。
- ❌ **未跑 `verify.ts --all`**(本轮硬约束:数字以逐套件实跑为准,不以门禁汇总行为准)。
- ❌ 未跑 `typecheck-baseline-audit`:**同一时刻有其它写者正在改 `world_sim.ts` / `modes.ts` / `delta.ts`**,
  跑出来的红会指向他们的半成品,不是本轮的产物。
- 未改任何 `.ts` / `tests/`;未 commit;未碰 `.pi/`。
- 写域:`README.md` · `docs/HANDOVER.md` · `docs/AUDIT-W34.md` · **新增** `docs/WIRING-LEDGER.md`。

---

## 14 2026-11-19 第九轮处置(错误可观测性 / 热路径与尸体回收 / 常量同源 / 每帧成本 / 检查器自身的牙口)

> 起点是一条**实测命令**,终点是一条**仍未修复的红**:`node scripts/verify.ts --all`
> ⇒ **exit 1 / 6 项失败**(235740ms);此后门禁**崩**在 `server/src/invariants.ts:533`(见 §14.2)。
> 本节只登记**归属**与**元结论**;每条后面给了复算方式。

### 14.1 开工读数:`verify.ts --all` ⇒ **exit 1 / 6 项失败**(行首 ✗ 6)

| # | 红项(位置 · 报错原文) | 本轮谁该修 |
|---|---|---|
| 1 | `tests/WS-07.test.ts` 退出码 1:`[WS-07] G04 端到端:四类作弊在完整房间流程中都被拒绝 — 同一 tick 二次攻击应被拒 期望 false / 实际 true`;`[WS-07] WR-14 U2-b 经真实入口 applyMove / applyAttack 同样挡住 — 同一 tick 二次攻击必须被拒(非数字声明不豁免攻速) 期望 false / 实际 true` | net-persist(WS-07 写域) |
| 2 | `tests/WS-09.test.ts` 退出码 1:`[WS-09] 染色批量喷色:整片墙 1 次调用,材质实例按表面数增长而非调用数 — 15 格内满强度 期望 1 / 实际 0.5` | client-stage(WS-09 写域) |
| 3 | `tests/WS-FND-99-both-sides-structured.test.ts` 退出码 1:`FND99-6 真实仓库:命中清单逐条锚定(文件:行 + 两侧值),合法镜像 0 误报 — …[3]:期望 "DYE_PALETTE_SIZE" / 实际 "EncodeStats"` | FND-99 套件作者(常量同源的连带,见 R9-3) |
| 4 | `[同义反复候选]`:`新增未登记的同义反复候选 1 个(--strict-taut):WS-FND-137-frame-cost::VIOLATION_KEEP_PER_PLAYER`(`tests/WS-FND-137-frame-cost.test.ts:350`) | 137 套件作者(T1 复测已归 0 ⇒ 已修) |
| 5 | `[同义反复候选]`:`双端同源(结构化)登记表失真(登记的名字已不再命中,应移出):DYE_PALETTE_SIZE` | 常量同源执行者(见 R9-3) |
| 6 | `[门禁自检]`:`README.md / docs/HANDOVER.md 的数字与实测不一致` **17 处** | **本轮(已由 `sync-docs --write` 消掉,见 R9-6)** |

### 14.2 收工读数:门禁**自己崩了**(比上面 6 条更硬)

```text
node scripts/verify.ts --all  ⇒  exit 1,且**跑不完第一个检查节**
file:///…/server/src/invariants.ts:533
TypeError: Cannot destructure property 'live' of 's.triSide' as it is undefined.
    at triSideMatch (server/src/invariants.ts:533:11)
    at server/src/invariants.ts:699:15
    at checkAll (server/src/invariants.ts:696:26)
    at runSelfcheck (scripts/invariants.ts:274:42)
    at scripts/verify.ts:7809:15
```

- 复算(1 秒,免跑全量门禁):`node -e "import('./scripts/invariants.ts').then(m=>console.log(m.runSelfcheck().summaryLine))"`;
  连跑 7 次(约 12 分钟)**每次都崩** ⇒ 不是瞬态、不是并发写盘撞出来的。
- 归属:`server/src/invariants.ts` + `scripts/invariants.ts`(不变量自检那条线)。**本轮不改**(不是本轮写域)。
- ★ 为什么这条要单列:崩点在 `checkBomGuard()` 之后、`checkFrozen()` 之前 ⇒
  **其后的每一节(含「文档数字比对」)一条都不执行**。「后面都绿」这句话此刻没有任何依据 ——
  这与 §13.4 记的是同一条纪律:崩溃点之后不存在判据,只有不存在。

### 14.3 R9 台账(靶子 ↔ 本轮事实 ↔ 归属)

| 编号 | 靶子 | 本轮事实(实测) | 归属 |
|---|---|---|---|
| R9-1 | **错误可观测性** | 新套件 `tests/WS-FND-134-failure-observability.test.ts` **已落盘**(单跑 18/18 绿);但实测到一条「红的看不见」的通道:**`用例汇总` 把退出非 0 的套件整条排除在总数之外**(`verify.ts:7641 suiteHadFailure = true; continue;`)⇒ 红套件**不在总账里**,总账只**变小**:T0 读数 142 套件 / 2303 条(当时磁盘上 145 个套件文件,WS-07 / WS-09 / WS-FND-99 因红被剔除),T1 读数 145 / 2424。⇒ **「总数变小」不能读成「用例变少」** | 门禁汇总口径(Lead / `verify.ts`) |
| R9-2 | 热路径与尸体回收 | `tests/WS-FND-135-hotpath-and-reap.test.ts` 已落盘(单跑 13/13 绿),本轮无它的红 | — |
| R9-3 | **常量同源** | `DYE_PALETTE_SIZE` 已收敛到 `shared/constants/dye.ts` 单源(`tests/WS-FND-136-constants-single-source.test.ts` 用三处 `eq(..., DYE_PALETTE_SIZE)` 钉同源,12/12 绿)⇒ **同源化让「两端各声明一份」这件事消失**,于是两条**旧检查同时失真**:(a)`[双端同源(结构化)]` 报「登记表失真(登记的名字已不再命中,应移出):DYE_PALETTE_SIZE」;(b)`tests/WS-FND-99` 的 FND99-6「真实命中清单」仍写着旧名(红)。⇒ 这两条红**不是同源化做错了**,是检查器侧的登记/清单没跟着收窄 | 常量同源执行者 + FND-99 作者 |
| R9-4 | **每帧成本** | `tests/WS-FND-137-frame-cost.test.ts` 已落盘(单跑 16/16 绿);但 T0 漏出 1 条同义反复候选(见 §14.1 第 4 条),T1 复测已归 0 ⇒ **常量在 actual 侧才有牙齿**这条老纪律的又一次复发 | 137 套件作者(已修) |
| R9-5 | **不变量检查器自身的牙口** | 见 §14.2:不变量自检**自己崩** —— `triSideMatch()` 解构 `s.triSide` 时它已是 `undefined`(快照工厂与不变量对不上)。「检查器有牙」这件事本身没有牙去保证 | 不变量线作者 |
| R9-6 | 文档数字 / §九 哈希 | 17 处(T0)⇒ 由 `node scripts/sync-docs.ts --write` 写回(含 §九 README 哈希);幂等由**工具收尾复扫零差异**与随后 `--check` 双重证明(§14.5) | **本轮(已完成)** |

### 14.4 两个元结论

**R9-M1 `sync-docs` 消掉了「人抄」这个易腐点。**
本轮唯一属于文档侧的红(§14.1 第 6 条)不再用手改:`--write` 一次写回 17 处(+4 处静态量漂移),
写回后**同一测量源**下 `--check` 报「✓ 无变化」、工具收尾复扫零差异 ⇒ 「同一份数字有两个来源」
这件事被消掉了:文档侧的数字现在只有一个来源(门禁实测),人不再有地方抄错。
⚠️ **但它消掉的是「抄错」,不是「判据错」**,且覆盖面**只到锚点**:
· 值是什么仍取决于门禁怎么量 —— 例如 R9-1 的「红套件不进总账」,工具照抄该口径;
· 锚点**之外**的散文仍是手抄、仍会腐化:实测 `README.md:75` 与 `docs/HANDOVER.md:96` 里的
  「基座(FND-01..132)」号段**不会被工具更新**(锚点只捕获数字,不捕获括注里的号段)
  ⇒ 新套件 134..137 已落盘,而那两处仍写「..132」。

**R9-M2 检查器也会腐化 —— 「不变量检查器自身改窄不报」是本轮的一个实例。**
把 `DYE_PALETTE_SIZE` 收敛到单源之后,检查器原本要看的**那条缝变窄到 0**:
`[双端同源(结构化)]` 的登记名不再命中、FND-99 的期望清单仍写旧名(R9-3)。
⇒ 关键不在「同源化做错了」,而在于:**登记/清单是手写的期望,被检查对象改窄后它们不会自己改窄**,
它们只是「不再命中」——而「不再命中」在旧读数里与「已修好」同形。
配套证据:本轮**有**反向自检的地方当场被抓(登记名不再命中 ⇒ 红);
而 `[判据形态审计]` 自报「该检测器覆盖判定已知偏窄」却没报具体是哪一条 ⇒ 同一类问题在**没有反向自检**的检查器上是静默的。
⇒ 结论:**「检查器有牙」不是一次性属性**;「让缺陷不可能发生」的修法必须**同时收窄检查器自己的登记**,
否则检查器会从「守一条缝」退化成「守一条已经不存在的缝」,它仍然绿、仍然看起来有牙。

### 14.5 本批验证口径(以及**没跑什么**)

- T0(开工)`node scripts/verify.ts --all` ⇒ **exit 1 / 6 项失败**(见 §14.1)。
- T1(收工前复测,`sync-docs --check` 现跑的那次)⇒ 应写值已变:`145 套件 / 2424 条`、
  `WS 799 条 / 13 套件`、`基座 1625 条 / 132 套件`、同义反复 **0 条**、`§九 README 哈希 6abccada8ecf`。
- ❌ **T2 起门禁跑不完**(§14.2 的 TypeError)⇒ **无法**再用「现跑门禁」当测量源。
- `node scripts/sync-docs.ts --write --gate-log=<T0 门禁输出>` ⇒ 写回 17 处,复扫零差异(幂等);
  随后 `node scripts/sync-docs.ts --check --gate-log=<同一份>` ⇒ **✓ 无变化**(exit 0)。
  故:**写回的数是 T0 门禁读数 × 写回那一刻的静态量**;README 的「146 份测试套件 / 342 个 .ts」
  是静态现算(与 T0 门禁里的 145/341 差 1 —— 两次写之间磁盘又变了)⇒ 这类数**只能读成时刻快照**。
- ⚠️ **待办(必须重跑)**:`server/src/invariants.ts:533` 修好后,再跑一次
  `node scripts/sync-docs.ts --write` —— 现在的文档数字是 T0 快照,而 T1 已经漂了;
  且 `README.md:198` 的「同义反复候选」在 T0 是 1 条、T1 已归 0,散文里的 ✅/「当前相等」由下一次写回的上下文决定。
- 未 commit;未碰 `.pi/`;未改任何 `.ts` / `tests/`。
- 本轮写域:`README.md` · `docs/HANDOVER.md` · `docs/AUDIT-W34.md`(数字全部由 `sync-docs` 写回,**零手抄**)。