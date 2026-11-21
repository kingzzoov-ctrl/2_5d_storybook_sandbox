# 决策记录 — owner 裁决台账

> 记录**只有 owner 能定**的产品/设计决策,以及裁决依据。
> 工程侧的技术判断不在此列(那些走 CR / 未决台账)。
> 每条必须有:问题、选项、裁决、依据、生效范围。

---
## 索引(D 编号 → 题面)

> **登记规则**:新裁定**先在这里登记一行**,再在文末按「状态 / 问题 / 裁定 / 理由 / 影响 / 判据」展开。
> 本表**只写编号与题面** —— 状态与数值一律读各条正文的 `状态` 行(此处刻意不复制:同一处状态只留一个来源,抄一份就多一处会漂的地方)。
> 「✅ 已裁决 / 已裁(owner)」= 已定;**未定项**在文末「待 owner 裁决(尚未定)」那张表里。

| 编号 | 题面 |
| :- | :--- |
| D-01 | 投影方式:以手册为准(35° 正交等轴测) |
| D-02 | 图集像素基准:保持 `TILE_PX = 16`,装配层缩放 |
| D-03 | Boss 祭品:应当消耗 |
| D-04 | CR-14 U2 的性质:U2-a 是取舍,U2-b 是缺陷 |
| D-05 | 手册自身矛盾:克洛诺斯的「远古」 |
| D-06 | `RESET_WORLD` 的存档政策:归档(旧世界可回滚) |
| D-07 | 世界时钟:20 分钟一天,0 帧 = 06:00 |
| D-08 | 输入语义:镜头跟随角色;主目标是手机虚拟摇杆 |
| D-09 | 受击击退:按伤害折算(伤害 ÷ 20 格,上限 2 格) |
| D-10 | 泡泡水枪连击窗口:5 秒(复用 `BUBBLE_TRAP_SEC`) |
| D-11 | `forgeUnlocked`:以现存 505 工作台为中高级锻造 |
| D-12 | 滑溜料理的 `muOverride`:相乘在地板 μ 上 |
| D-13 | 227 浇灭 coop 工位:补一张坐标映射表 |
| D-14 | `ackedSeq` 走方案 A(改 `shared/net/` 包头,协议 1 → 3) |
| D-15 | `shared/net/` **不算**冻结层(依赖层收紧到显式清单) |
| D-16 | P-04 目标平台:双端,网页优先 |
| D-17 | D-13 允许加**纯读**读口 |
| D-18 | 世界钟喂进电路求值(`hour` 静态参数优先、缺失问环境) |
| D-19 | 一次性做到底:本批 9 条批量裁决 |
| D-20 | 体能数值(料理默认 / 连击窗口 / 锻造档 / 连段链):保留保守默认 |
| D-21 | 平衡值(元素抗性 `0.5` / mob 稀有掉落 `0.15`):保留现值 |
| D-22 | 派对模式:仅开局前可改(不允许中途切换) |
| D-23 | 派对结算:自动回 `IDLE`(不需要玩家确认) |
| D-24 | 急行(急单):世界侧自动触发,不加手动开工入口 |
| D-25 | 浏览器基线:不纳入旧 WebView(Chrome 98+ / Safari 15.4+) |
| D-26 | 时间口径:帧数即时间(世界时间 = `frameCount × DT`,不读挂钟) |

## D-01 投影方式:以手册为准(35° 正交等轴测)

- **状态**:✅ 已裁决(2026-11-11)
- **问题**:用户提供的设计稿 `_design/` 里,HTML 原型用的是**斜投影**(`sx = x·tileW`,`sy = y·tileH`,格子在屏幕上是矩形);而项目手册 L719 明确要求「Vite + Three.js 搭建 **35° 正交相机**舞台」,仓库 `iso_camera.ts` 也已按 35°/45° 等轴测写好。两者视觉不同,点击拾取与 Y 轴排序也随之不同。
- **裁决**:**以手册为准**,即 35° 正交等轴测。设计稿图片**只作参考**。
- **依据**:owner 原话「分歧以原来的规划为准,我给你的图片这些只是参考参照」。
- **佐证**:设计稿的**美术资源**其实与手册一致 —— 用像素测量 12/12 个地形块精灵,顶面宽度呈 12→58→15 的渐变,是**菱形**(等轴测);矛盾只在那个 HTML 原型的代码里。也就是说:手工画的美术是对的,原型的渲染代码写歪了。
- **生效范围**:`client/` 全部渲染;`stage/iso_camera.ts` 公式不变。

---

## D-02 图集像素基准:保持 `TILE_PX = 16`,装配层缩放

- **状态**:✅ 已裁决(2026-11-12)
- **问题**:图集每个地形块最宽 **58px**、反推约 **41px/格**;而 `iso_camera.ts` 锁的是 **TILE_PX = 16**。两者差约 2.6 倍,必须选一条做全局基准。
- **选项**:
  - (a) 保持 16,装配层把 64px 图集缩放约 0.39 倍使用
  - (b) 改成 41px/格,按图集原始精度
  - (c) 地形 16px、立牌用原始 64px 的混合制
- **裁决**:**(a) 保持 16,装配层缩放**。
- **依据**:改动最小。`zoomLevels` 六档、LOD 四档的屏幕阈值、视口包围盒、以及**钉住这些值的测试**全部不用动。选 (b) 会牵动一串已测常量;选 (c) 要额外处理立牌与地形的深度/遮挡。
- **代价(如实记录)**:图集原画的细节会被缩掉一部分。将来若要在高清屏上追求像素锐利,需要重新评估 (b)。
- **生效范围**:`client/` 装配层;`stage/` 纯逻辑不变。

---

## D-03 Boss 祭品:应当消耗

- **状态**:✅ 已裁决(2026-11-12)
- **问题**:Boss 祭品(734~741)是否在召唤时被消耗?手册**没明写**。代码现状是**不消耗**(且 `summonBoss` 只校验、不扣除;全仓 `consumeItem` 只有定义、零调用点)。
- **裁决**:**消耗**。召唤时扣除祭品。
- **依据**:owner 选择「消耗:召唤时扣除祭品」。且「献上祭品唤醒」的语义本身暗示献出即失去。
- **连带影响(重要)**:这使「`boss_ginger_troll` 掉自己的祭品 `739`」成为**必须修的漏洞**:
  - 739 的 tags 是 `['Boss召唤','祭品','甜食','甜点']`,且 734~741 八个祭品**不进任何配方**(实测被配方引用次数 = 0),是纯消耗品;
  - 8 个 Boss 里**唯一**自反馈的就是它(扫 `loot ∩ summonItem` 只命中它);
  - 若不修:打死一次必得 ≥1 个 739 → 再造祭品 → 再召唤,**成本归零**,还每次白送 609。
- **生效范围**:`server/src/bosses/raid.ts` 的 `summonBoss`、`shared/constants/bosses.ts` 的 `loot`。

---

## D-04 CR-14 U2 的性质:U2-a 是取舍,U2-b 是缺陷

- **状态**:✅ 已裁决(2026-11-12)
- **问题**:`applyMove` 的 `speedMul`、`applyAttack` 的 `claimedAttackSpeedBonus` 均取自客户端,可把移速上限抬到约 ×3.19 基线,并绕过装备前置。这算缺陷还是可接受?
- **裁决**:分成两件**不同性质**的事:
  - **U2-a = 可接受的设计取舍,不是缺陷。** 上游只做**钳位**、不做自证(`WS-07-net-persist.md` §7 写明「一律钳到上限,不自证」)。且服务端**物理上没有**可自证的数据:`PlayerState` 只有 `weaponId`、无装备槽;`room.ts` 零穿戴状态;`statsAtLevel` 不含速度字段。真做核算需「新增装备槽 + 从零建服务端速度模型 + 穿戴追踪」,属跨 WS 结构性改动。
  - **U2-b = 真缺陷,已修。** `Math.max(0, {})` = `NaN` ⇒ `dist > NaN` 恒 false ⇒ **瞬移 / 窗口均速 / 攻速三道检查同时静默失效**,单帧跳 200 格直接放行。**与「上限多大」无关** —— 即便上限设 1.0 也照样失守。与 U1 同类:判据本身被污染。路径真实可达(`{"speedMul":{}}` 经 JSON 到 `onMessage`,TS 标注不产生运行时校验)。
- **依据**:owner 未直接裁决此项,由我(Lead)按技术证据判定,并**如实标注 U2-a 是取舍而非修复**。
- **硬性表述要求**:文档里**不许**把 U2-a 写成「已修复」。它由 `WR-14 U2-a` 用例**钉住** —— 将来真做服务端核算,该用例会变红提醒改口径。
- **生效范围**:`server/src/net/anticheat.ts`、`docs/CHANGE_REQUESTS.md`、`docs/WS-07-net-persist.md`。

---

## D-05 手册自身矛盾:克洛诺斯的「远古」

- **状态**:⏸ 建议不改代码,改手册
- **问题**:手册 L502 写「遗迹:发条时间巨像」(**无**「远古」),而 L439 祭品行写「【**远古**发条时间巨像·克洛诺斯】」。代码随 L439。
- **建议**:改手册统一,代码不动。
- **依据**:同一文档内自相矛盾,且代码已按其中一处实现;改代码会牵动已测常量,改手册零成本。
- **生效范围**:手册(非本仓库)。

---

## D-06 `RESET_WORLD` 的存档政策:**归档**(旧世界可回滚)
- **状态**:已裁(owner,2026-11-16)
- **问题**:`docs/TASK-97` §4 的存档政策(覆盖 / 保留 / 归档)未定 ⇒ 世界重置的宿主半边一直没实现
- **裁决**:**归档**。世界按新 seed 在内存重建,**旧世界存成一份可回滚快照行**(不是删掉,也不是原地不管)
- **影响**:需要新增"世界快照"存储与配额;`WorldSim.resetWorld({seed})` 负责内存重建,归档由宿主/DB 侧做
- **生效范围**:`server/src/sim/world_sim.ts`、`server/src/net/actions/reset_world.ts`、`server/src/db/**`、`docs/TASK-97`

---

## D-07 世界时钟:**20 分钟一天**,0 帧 = **06:00**
- **状态**:已裁(owner,2026-11-16)
- **问题**:世界侧没有时钟 ⇒ `WorldSim.isNight()` 恒 `false`;405 昼夜感光器读的 `hour` 参数**全仓 0 个生产者**
- **裁决**:游戏内一天 = **1200 秒(20 分钟)**;世界时间 0 帧对应 **06:00**(天亮)。夜 = **19:00–06:00**(沿用 `wiring/components.ts` 的 `isNight(hour)` 边界)
- **影响**:`isNight()` 改成按世界时间算;`hour` 参数由世界侧喂给组件求值 ⇒ 夜行怪开始按夜晚出没、405 感光器开始有输出
- **生效范围**:`server/src/sim/world_sim.ts`、`server/src/wiring/components.ts`(只喂参数,不改边界)、`server/src/mobs/spawner.ts`

---

## D-08 输入语义:**镜头跟随角色**;主目标是**手机虚拟摇杆**,WASD 作桌面兼容
- **状态**:已裁(owner,2026-11-16),取代 `docs/TASK-83-wasd-three-options.md` 的三选一
- **裁决**:① 镜头**跟随角色**(不是自由平移镜头);② 这是一款**手机游戏**,**主输入是虚拟摇杆**(触屏);③ WASD **可以支持角色移动**,作为桌面/调试兼容,但不是主路径
- **影响**:`client/src/net/prediction.ts` 那条链要按"角色移动"重接(含下行 `ackedSeq`);新增虚拟摇杆 UI 与输入适配
- **已澄清(2026-11-17)**:平台问题由 **D-16** 裁定 =「**双端,网页优先**」⇒ 摇杆按网页(DOM)实现,
  平台相关层做成可插拔,小游戏适配后补。它不改变"摇杆优先"这件事。
- **生效范围**:`client/src/net/input.ts`、`client/src/net/prediction.ts`、`client/src/main.ts`、`server/src/net/ws_server.ts`(下行 `ackedSeq`)

---

## D-09 受击击退:**按伤害折算**(伤害 ÷ 20 格,上限 2 格)
- **状态**:已裁(owner,2026-11-16)
- **问题**:`damage.ts` 算出的 `knockbackImpulse` 是**攻方武器**的数,拿它当"被打飞多远"是错借语义;mob→玩家那条路(`vitals.applyHit`)**根本没有击退参数** ⇒ 一直是 no-op
- **裁决**:位移 = `min(2, 实际伤害 / 20)` 格,方向**远离攻击者**
- **影响**:`WS-10` 的三条既有判据(救援半径 / 位置不变)可能被打红 —— 若红,**按本裁决重钉**,不许为了绿而改回 no-op
- **生效范围**:`server/src/sim/world_sim.ts`(受击点)、`tests/WS-10.test.ts`(如需要)

---

## D-10 泡泡水枪连击窗口:**5 秒**(复用 `BUBBLE_TRAP_SEC`)
- **状态**:已裁(owner,2026-11-16)
- **问题**:`liveBubbles` 的层数**永不衰减** ⇒ 跨任意时长能凑满"连中 3 发"
- **裁决**:最后一次命中后 **5 秒**内没再命中 ⇒ 层数归零;**不新增数值常量**(5.0 就是 `BUBBLE_TRAP_SEC`)
- **生效范围**:`server/src/combat/live_bubble.ts`、`server/src/sim/world_sim.ts`(`tickLiveBubbles`)

---

## D-11 `forgeUnlocked`:**以现存 505 工作台为中高级锻造**
- **状态**:已裁(owner,2026-11-16)
- **问题**:`rooms/effects.ts` 的 `forgeUnlocked` 无消费点 —— 内容层没有"中高级锻造"的分档
- **裁决**:解锁 = **能用 505 工作台出产的配方**(不新增 `tier` 字段,不动冻结内容表)
- **影响**:`craft` 路径要按 `station === 505` 与 `forgeUnlocked` 做闸;锁着时显式拒绝(不是静默失败)
- **生效范围**:`server/src/net/actions/craft.ts`、`server/src/sim/world_sim.ts`(把 `forgeUnlocked` 投影成可读事实)

---

## D-12 滑溜料理的 `muOverride`:**相乘**在地板 μ 上
- **状态**:已裁(owner,2026-11-16)
- **裁决**:最终摩擦 = **地板 μ × `muOverride`**(0.96)⇒ 冰面更滑、湿地更黏,方向一致;**不覆盖**地板值
- **影响**:物理层需要一条"按玩家的 μ 乘区"通道(不能改冻结层的 `Body` 结构)
- **生效范围**:`server/src/physics/world.ts`、`server/src/sim/world_sim.ts`

---

## D-13 227 浇灭 coop 工位:**补一张坐标映射表**
- **状态**:已裁(owner,2026-11-16)
- **问题**:`rush_order.ts` 的工位槽位**没有世界坐标** ⇒ 玩家的浇水动作无法映射到 `opts.spraying`
- **裁决**:给工位补"工位 id ↔ 世界格"的映射表,浇水仍按 `STATION_STATE.BURNING` + `EXTINGUISH_SEC` 的既有规则走
- **生效范围**:`server/src/coop/rush_order.ts`、`server/src/sim/world_sim.ts`、`server/src/net/actions/use_item.ts`

---

## D-14 `ackedSeq` 走**方案 A**:改 `shared/net/` 的包头(协议版本 1 → 3)
- **状态**:已裁(owner,2026-11-17)
- **问题**:下行二进制快照没有 `ackedSeq` ⇒ 客户端 `pruneCmds` 在生产里拿不到权威 ack
- **裁决**:按 `docs/TASK-100-ackedseq-frozen-unlock.md` 的**方案 A**:`shared/net/delta.ts` 包头加一个
  uint32 的 `ackedSeq`;**协议版本 1 → 3**(⚠️ 不能是 2 —— 会与既有的 `FRAME_BINARY 0x02` 撞值,
  `session.ts` 里已写明这条);广播是"一份字节发所有人" ⇒ **逐连接重写那 4 字节**
- **附带**(同一次调查实测出的两条真缺陷,一并修):`WsConn.ackedSeq` 声明后**从未推进**
  (真正推进的是全局 `lastAckedSeq` ⇒ 多连接互相冒充);上行 `seq` **没有生产者**
  (`main.ts` 发 move 不带它,`session.ts` 的 `MoveIntent` 无该字段)
- **依据**:`docs/TASK-100-ackedseq-frozen-unlock.md`(方案 A/B 对比、逐行落点、6 条待裁)

---

## D-15 `shared/net/` **不算冻结层**(依赖层收紧到"显式清单")
- **状态**:已裁(owner,2026-11-17)
- **问题**:`FREEZE.md` 的注释把整个 `shared/` 说成"冻结层,只读",但**显式清单里没有 `shared/net/`**
  (`checkFrozen` 只 import constants/types)⇒ "能不能改"一直含糊
- **裁决**:`shared/net/`(协议编解码)**不算冻结层,可以直接改**;
  `shared/constants/**` 与 `shared/types/**` 仍是冻结层(改它们要单独裁决)
- **例外永不解除**:`shared/testing/harness.ts`
- **生效范围**:`shared/net/delta.ts`(D-14 要改的就是它)

---

## D-16 P-04 目标平台:**双端,网页优先**
- **状态**:已裁(owner,2026-11-17),关闭 `DECISIONS` 的 **P-04**
- **裁决**:**网页先发**(当前 `vite` + `client/index.html` 那条链就是交付形态);
  摇杆等**平台相关**的层要做成**可插拔** —— 小游戏适配(canvas 2D + `wx.onTouch*`)**后补**时
  只换那一层,判定/夹取口径(`client/src/net/joystick.ts`)原样保留
- **影响**:不阻塞 D-08 的其余部分;不要求本轮就产出小游戏产物

---

## D-17 D-13 允许加**纯读**读口
- **状态**:已裁(owner,2026-11-17)
- **问题**:`RushOrderSession` 不暴露工位状态 ⇒ "浇水 0.5 秒 ⇒ 从 BURNING 回 RUNNING"这条
  端到端判据写不出来(只能测纯函数)
- **裁决**:允许在 `coop/rush_order.ts` 加**纯读**读口(不改既有签名与语义),用它补端到端判据

---

## D-18 世界钟**喂进电路求值**(`hour` 走"静态参数优先、缺失问环境")
- **状态**:已定(执行侧,2026-11-17;非平衡/存档类,按「有问题的自己决策」处理)
- **问题**:D-07 把钟落成了 `WorldSim.hourOfDay()`,但 405 昼夜感光器读 `ctx.param('hour')`,
  而组件 `params` 是**摆放时**的静态表 ⇒ 钟是个没人读的字段,感光器只会吃摆放者手填的常量;
  更糟的是"缺参数 = 0"⇒ `isNight(0)` = 夜 ⇒ 没接线时感光器**恒亮**,缺陷没有声音。
- **裁决**:
  1. `SignalGraph` 加**世界环境**读数口(`setEnvSource` / `envOf`),语义刻意是**静态优先**:
     `comp.params[key] ?? env(key)` —— 既有组件读数一个都不变,只有"表里没有这个键"时才问环境;
  2. `WorldSim` 在**两条**构造路径(构造器 / D-06 的 `rebuildWorld`)都挂上,且只提供
     `hour`(= `hourOfDay()`)与 `night`(= `isNightNow() ? 1 : 0`)两个键;
  3. 公开读口 `WorldSim.wiringEnvOf(key)` 供判据读"真的挂上了没有"(不是另算一遍)。
- **影响**:`tests/WS-FND-64`(5 条,含"摘掉环境口 ⇒ 恒亮"的缺陷形态负对照与"重置后仍挂着")。
- **为什么不把 19:00 写进断言**:一天 20 分钟 ⇒ 06:00→19:00 是 13000 帧;套件用
  "挂的就是世界钟" + "405 读的就是那一口" 组合取证,不把 20 分钟的钟点塞进运行时间。

---

## D-19 一次性做到底:本批 9 条批量裁决(owner,2026-11-17)
- **状态**:已裁(owner)
- **范围**:把剩余全部项一轮做完。9 条裁定按字面执行,不再逐条追问:
  1. **49 条待裁** = 全按 `docs/RULINGS-DRAFT.md` 的推荐落地(owner 只否决个别行);
  2. **冻结层解锁**:烹饪 6 字段参数槽(`defFlat`/`moveMul`/`gravityMul`/`jumpMul`/`gatherMul`/`expMul`)、
     蓝图 >16×16、地砖 >64 扩 u16、立牌 `icon_size`、染色衰减曲线 —— 少见的例外,仅此一批;`shared/testing/harness.ts` 仍在禁区;
  3. 9 种房间增益里 4 种「系统不存在」的(牧场 / 炼金室 / 温室 / 百货店)**全部实现**;
  4. `useItem` 的 `itemId` 客户端自报 ⇒ **最完善方案**(服务端背包读口,拒自报);
  5. 归档快照 ⇒ **chunk 裁剪规则 + 完整回滚**(不再是"只写不读");
  6. 档 2 第 3 组 ⇒ **34 个套件全补独立注入**(每个 ≥1 次注入 + 字节还原);
  7. 档 2 第 5/6 组 ⇒ **全修**(同义反复清零 + 门禁覆盖 `eq/near` 全实参 + 两白名单交叉标注 + `resolveImport` 复核);
  8. 战斗 D1–D7 ⇒ **全做**;
  9. 真机 FPS 与 `colyseus.js`+vite8 兼容 ⇒ owner 自备环境;本批登记为「等 owner 提供环境」,**不占未决台账**。
- **影响**:`docs/RULINGS-DRAFT.md`(49 条逐条落点)+ 本批全部实现与判据;冻结层解锁必须同步
  `shared/contracts/FREEZE.md` 与门禁里的冻结清单,禁止静默放宽。

---

## D-20 体能数值(料理 5 槽默认 / 连击窗口 / 锻造档 / 连段链):**保留保守默认**
- **状态**:已裁(owner,2026-11-21)—— 内容 = **保留现行为,值不变**
- **问题**:`defFlat +2` / `moveMul ×1.10` / `gravityMul ×0.90` / `jumpMul ×1.05` / `expMul ×1.05`、连击窗口 `0.6s`、锻造档 `0/+1/+2`、连段链 `1.00/1.00/1.25` 全是**手册没给数值**时实现层按保守口径落下的默认值,一直标着「待平衡(owner)」⇒ 每轮审计都把它当"待裁"重问一次。
- **裁定**:**保留当前保守默认**,上述八个值**一位不改**。同时把「待平衡(owner)」这一标记改读作 **「已裁(owner):保留默认值」** —— 变的只是**标记的性质**,不是数值。
- **理由**:这些数是"手册未给值"下的保守默认(取值即当前口径),owner 认为可用;此前"谁来定这一项"没有答案 ⇒ 现由 owner 定为"保留"。数值真要动属**新裁定**,不由实现层顺手调(调了要重钉数值面判据)。
- **影响**:
  ① 标记落点:`server/src/combat/cooking.ts#FOOD_PARAM_DEFAULT_DOSE`(5 槽注释,本次已改标)、`server/src/combat/damage.ts#COMBO_WINDOW_SEC`(注释,本次已改标)、`shared/constants/cooking.ts#FOOD_PARAM_SLOTS`(**未改**:其 `待平衡` 字样被 `tests/WS-FND-66` 逐槽断言钉住)、`server/src/combat/weapons.ts#FORGE_TIER_STAT_BONUS`(**未改**,不在本次范围)。
  ② `tests/WS-FND-152` 的断言消息里仍写着「待平衡(owner)」(测试文件不在本次范围)⇒ 那些字样按本裁定读作"已裁·保留默认值",**不是**待裁。
  ③ 连段链 `COMBO_CHAIN_MUL` 本来就写「手册 §4 的 1.00/1.00/1.25」,无标记要改。
- **判据**:`tests/WS-FND-152-combat-effects-wired.test.ts`(5 槽剂量 / 窗口 `0.6` / 锻造 `0`·`+1`·`+2` / 连段链)+ `tests/WS-FND-111-combat-numeric-bounds.test.ts`(数值边界)。**本裁定不动常量 ⇒ 这两套必须原样绿**;它们变红只可能是有人改了值,那时按新裁定重钉。

---

## D-21 平衡值(元素抗性 `0.5` / mob 稀有掉落 `0.15`):**保留现值**
- **状态**:已裁(owner,2026-11-21)—— 内容 = **保留现行为,值不变**
- **问题**:`PENDING_ELEMENT_RESIST_MUL = 0.5`(房间元素抗性占位系数)与 `MOB_RARE_DROP_CHANCE = 0.15`(稀有材料档掉落率)是仅有的两个**纯数据占位值**;台账 D3 / D4 的 `owner` 字段写着 `待平衡(owner)`,`pendingBalanceRows()` 能枚举出它们 ⇒ 每轮审计按"待裁"重问。
- **裁定**:**两个数都保留现值**(`0.5` / `0.15`),标记改读作 **「已裁(owner):保留现值」**。机器可读的 `owner: '待平衡(owner)'` **不删**(理由见影响 ①)。
- **理由**:`0.15` 有手册唯一出处(L387「稀有材料掉落率 +15%」,引它的是 624 招财进宝猫耳箍);`0.5` 取的是**可观测**(判据能用"同一次元素伤害减半"的关系式钉住,而不是把一个平衡数字抄进断言)。两值作为当前口径成立,不需要新值。
- **影响**:
  ① **机器读的那两处标记按设计保留**:`server/src/sim/world_debts.ts` 的 D3/D4 `owner: '待平衡(owner)'` 是 `pendingBalanceRows()` 的查询键,`tests/WS-FND-147` FND147-10 **逐字断言**它;`shared/constants/mobs.ts` 里的字面 `待平衡(owner)` 是 D4 的 evidence needle(FND147-7 核对)⇒ 裁定以**注释追加**「已裁(owner,D-21):保留现值」落地,needle 字面保留 —— **删 needle 是打红判据,不是"清理"**。
  ② `server/src/rooms/effects.ts` 不在本次可改范围(常量与 `待平衡` needle 都在那里)⇒ 该文件的标记未动,按本裁定读作"已裁·保留现值"。
- **判据**:`tests/WS-FND-147-world-debts.test.ts` FND147-7/8/10(数值一字未改 + 台账与源码不分叉 + 负对照);数值面 `tests/WS-FND-98`(FND98-1 掉落率)· `tests/WS-FND-93` / `WS-FND-97`(元素抗性链)。**本裁定不动数值 ⇒ 这些断言必须原样绿**。

---

## D-22 派对模式:**仅开局前可改**(不允许中途切换)
- **状态**:已裁(owner,2026-11-21)—— 内容 = **保留现行为**(不新增门,也不开中途切换)
- **问题**:`SET_PARTY_MODE` 的写口只过权限闸(`RoomRuntime.setPartyModeBy` → `authorize`),动作层没有「赛局进行中 ⇒ 拒」这一条 ⇒ "模式能不能在局中换"缺的是**玩法口径**,不是接线动作。
- **裁定**:**仅开局前可改**。局中不换本局的计分模式。
- **理由(照 owner 口径)**:**已计分的归属无歧义** —— 模式决定本局**怎么计分**;一旦有比分落账,再换模式就会让"已得的那些分算哪个模式下的"变成两套规则混在一局里,名次与奖励**判不出归属**。开局前定格 ⇒ 归属始终只有一种读法。
- **影响**:
  ① **本裁定不新增任何门**,现状即"开局定格":账本 `PartyRecord.mode` 是 `readonly` 且注释写明"开局时定格,局中不可改"(`server/src/net/actions/start_party.ts`);`RoomRuntime.startWorldPartyRun` 在 `partyPhase() !== 'IDLE'` 时**不重开**(重开会把正在跑的那局连同比分丢掉);`state.meta.partyMode` 只表示"下一局用哪档 + HUD 显示",不改正在跑的那一局。
  ② 理由写进台账:`docs/WIRING-LEDGER.md` §2.9.1 的 `SET_PARTY_MODE` 行(本次已补"为什么不允许中途切换")。
- **判据**:`tests/WS-FND-151-party-ui.test.ts`(面板 → `SET_PARTY_MODE` 接线)· `tests/WS-FND-120-party-coop-wired.test.ts`(party/rush 的 `WIRED:` 行必须有调用点)· `tests/WS-07.test.ts`(权限闸:GUEST 被拒、OWNER 通过)。

---

## D-23 派对结算:**自动回 `IDLE`**(不需要玩家确认)
- **状态**:已裁(owner,2026-11-21)—— 内容 = **保留现行为**(不引入确认步骤)
- **问题**:一局派对打完后,是自动收束,还是等玩家点确认?
- **裁定**:**自动回 `IDLE`**,不引入任何"确认结算"步骤。
- **理由**:结算与相位切换**同帧**(相位到 `SETTLED` 那一帧就结算并落账),名次与奖励已经确定;"确认"只多出一个**能把全房卡住的状态**(有人不点 ⇒ 房间停在结算态),不增加任何信息。
- **影响**:
  ① 现状路径(无需改动):`tickPartyMode` 把相位推到 `SETTLED` 并同帧结算(`server/src/party/modes.ts`);世界侧 `clearPartyRun()` 清空容器 ⇒ `partyPhase()` 的 `IDLE` 定义 = "没有赛局容器"(`server/src/sim/world_sim.ts`);房间侧 `syncPartyRecord` 见"世界回 `IDLE` + 账本仍 `RUNNING`"即自动 `endParty` 收束(`server/src/net/room.ts`)。
  ② 不新增确认 UI / 不新增动作报文。
  ③ 哨台 STOP(`stepRefereeDesk` 的 `-1` 档)是**收起一局**的入口、不是结算确认,不受本裁定影响。
- **判据**:`tests/WS-FND-120-party-coop-wired.test.ts`(相位到 `SETTLED` 同帧结算)· `tests/WS-FND-123-boss-party-projection.test.ts`(世界 → 房间的投影)· `tests/WS-11.test.ts`(对局运行时)· `tests/WS-FND-176-party-settle-idle.test.ts`(自然结算后回 `IDLE` 并收束记分账 —— 本裁定的直接判据;原「结算后停在 `SETTLED`」缺陷已修)。

---

## D-24 急行(急单):**世界侧自动触发**,不加手动开工入口
- **状态**:已裁(owner,2026-11-21)—— 内容 = **保留现行为**
- **问题**:急单三段都在世界侧,玩家侧**没有专用键** ⇒ 要不要补一个"手动开工"入口?
- **裁定**:**不加入口**,维持世界侧自动触发。三段(`startRushRun` / `submitDelivery` / `settleSession`)全部由 `WorldSim.tickPartyStep` 推;**玩家看提示行即可,不需操作**。
- **理由**:开工条件是世界状态(食堂建成 → 三工位在场 → 有人站在工位格上),而这三件事玩家**已经**在做(建造 / 站上去 / 丢货);再加一个键等于给同一件事造第二个真相源,还会把"为什么没开工"变成两个问题(键没按 vs 条件没满足)。
- **影响**:
  ① 现状即如此:`server/src/sim/world_sim.ts#stepRushEntry` 是顺序三条 `return`(条件不满足**不报错**,所以必须让玩家**看得见**)⇒ `client/src/ui/rush_readiness.ts` 把三条条件做成**三态清单**(`met` / `unmet` / `unknown`;快照拿不到的房间与器件数据如实报 `unknown`),摆在 HUD 上;玩家侧动作仍是工位(`Q` + WASD)与丢货(`G`,半径 `RUSH_DELIVERY_RADIUS = 1`)。
  ② 台账侧:`docs/WIRING-LEDGER.md` §2.9.1 的急单行(本次已补"世界侧自动 + 玩家看提示行")。
  ③ **不加**手动开工键 / 不加动作报文。
- **判据**:`tests/WS-FND-151-party-ui.test.ts`(急行条件清单三态:三项各自的正例 / 反例 / 未知例)· `tests/WS-FND-120-party-coop-wired.test.ts`(`RUSH_ACTION_LEDGER` 的 `WIRED:` 行必须有世界侧调用点)。

---

## D-25 浏览器基线:**不纳入旧 WebView** ⇒ Chrome 98+ / Safari 15.4+(`target: 'es2022'`)
- **状态**:已裁(owner,2026-11-21)
- **问题**:要不要为 Android 系统 WebView / 旧内核做降级(语法降级 + 兼容垫片)?
- **裁定**:**不纳入旧 WebView**。基线 = **Chrome 98+ / Safari 15.4+**,构建按 `target: 'es2022'`(`vite.config.ts` 的 `build.target` 现值,与 ES2022 首批完整支持版本一致)。**缺关键 API 时给可读提示,而不是白屏。**
- **理由**:旧 WebView 要降的是**语法 + API 两层**,而降级一旦开始就没有下界(每个旧内核都要重测一遍渲染与输入);明确基线把它变成可判定的问题。代价如实记:**基线之外的浏览器不做兼容承诺**。
- **影响**:
  ① 不新增垫片 / 不降 `target`;`vite.config.ts` 与 `client/` 启动链本次**一行未改**。
  ② "缺关键 API ⇒ 可读提示"这一半**由 T3 的能力探测落地**(探测代码不在本裁定内);可依的同类先例是 `WS-FND-167` 的启动看门狗 + `client/index.html` 的非 module 兜底脚本(`reportFatal` 那条路已把"主模块加载失败"从纯白屏变成可读提示)。
  ③ 本裁定只定**口径**(哪算目标环境 + 失败时给人看的话),不承诺旧 WebView 上的行为。
- **判据**:基线口径由 `vite.config.ts` 的 `build.target` 与本文记录共同承载;"不可见失败最小化"的判据是 `tests/WS-FND-167-resilience.test.ts`(连接 / 握手具名超时 + 兜底致命出口);**能力探测的判据由 T3 那条线补**,不属本裁定,也不因此重开本项。

---

## D-26 时间口径:**帧数即时间**(世界时间 = `frameCount × DT`,**不读挂钟**)
- **状态**:已裁(owner,2026-11-25)
- **问题**:本仓的「秒」有两个来源 —— 世界侧按**帧**推进(20Hz,`DT = 50ms`),进程/网络侧按**墙钟**推进。此前这条口径**从未写下来**,于是十三轮里反复出现同一种误读:「1200 游戏秒」被当成「1200 秒实时」,预热 / 冷却 / 长跑的时长按挂钟估。宿主定时器粒度 > 50ms 的机器上误差是实打实的(本机 20Hz 循环实测 62.77ms/帧 ⇒ **1.2555 倍**)。
- **裁定**:
  1 **世界时间 = `frameCount × DT`(不读挂钟)**。世界里的时长(冷却 / DoT / buff / 赛局 / 打盹 / 昼夜)一律由**帧序**派生;挂钟**不许**进模拟(否则确定性、回放与跨机对账全部失效)。
  2 **「1200 游戏秒 ≠ 1200 墙钟秒」**。60.0 墙钟秒只是「定时器恰好 50ms」的**标称**;粒度更粗的机器上实际节拍更长 —— 本机实测 62.77ms/帧 ⇒ 1200 游戏秒 ≈ 1506.6 墙钟秒。
  3 哪些量**必须**用**墙钟**(与人 / 进程 / 网络有关):自动存档周期、心跳与离线判定、连接与握手超时、重连宽限(退避与下次重试时刻)、会话/令牌时效、炼金缓存时效、**拍卖类限时**(本仓当前无实现 = 0 处;若实现必须用墙钟,否则玩家拖慢世界就能冻结行情)。
  4 哪些量**必须**用**游戏秒**(与世界推进有关):冷却、DoT 每段、buff 到期、赛局时长、打盹 / 露水累计、昼夜(世界钟)。
  5 **两钟交界处必须选一个并保持同源**:跨钟比较必须**显式换算并标单位**(换算只有一处:`DT`),不许把「帧数」当「秒」用。已登记的交界处 —— 自动存档的**稳态**触发是墙钟(与 `AUTOSAVE_INTERVAL_MS` 比,走 `clock.nowMs()`),唯一按帧的那一处是**冷启动垫底**(`saveCount === 0` 期间按 `AUTOSAVE_FRAME_INTERVAL` 节流),它第一次成功存档后即失效,**不许**扩成常态;存档时间戳(unix 毫秒,墙钟)与归档里的 `frame`(游戏)各留原口径、**不互相换算**;派对赛局时长(游戏秒)与重连宽限(墙钟)**不许**相加或比较;心跳踢人(墙钟)**不许**改按帧数(慢机器上会把活人踢掉)。
- **实测(本机,2026-11-25)**:均值间隔 `tickMean = 62.77ms` · `fps = 15.93` · **倍率 = 20 / 15.93 = 1.2555**(复算:`1000 / 62.77 = 15.93`,`20 / 15.93 = 1.2555`;同机复测 300 帧读到 62.79ms / 15.93fps ⇒ 同一个倍率)。
- **理由**:两个钟各有正确用途,**边界**才是风险点。把「谁必须用哪个 + 交界处选一个」写死后,「慢机器上世界钟与墙钟不同步」从**静默偏差**变成**可复算的一个数**(启动打印与汇总行各印一次)。
- **影响**:`scripts/play.ts` 启动 5 秒后打印实测 tick 间隔 / 实际 fps / **世界钟×墙钟倍率**;`scripts/soak.ts` 的汇总行补同款一列(两者**共用** `soak.ts` §8b 的同一份算法,不许各算一遍)。世界侧一行未改(它本来就按帧走)。
- **现状逐条对账**(抽样 17 个字段;**行号是 2026-11-25 的快照**,由判据逐行核对,漂了会点名给出新行号):

| # | 量 | 口径 | 现状(文件:行) | 那一行里的 needle |
| :- | :--- | :--- | :--- | :--- |
| 1 | 自动存档周期(30 秒,墙钟轨) | 墙钟 | `server/src/net/room.ts:163` | `AUTOSAVE_INTERVAL_MS = 30_000` |
| 2 | 心跳 / 离线超时 | 墙钟 | `server/src/net/room.ts:136` | `HEARTBEAT_TIMEOUT_MS = 5_000` |
| 3 | 连接超时 | 墙钟 | `client/src/net/session.ts:54` | `CONNECT_TIMEOUT_MS = 8000` |
| 4 | 握手超时 | 墙钟 | `client/src/net/session.ts:56` | `HANDSHAKE_TIMEOUT_MS = 8000` |
| 5 | 重连宽限上限(退避封顶) | 墙钟 | `client/src/net/session.ts:58` | `RECONNECT_MAX_MS = 30000` |
| 6 | 世界侧墙钟来源(装配) | 墙钟 | `server/src/index.ts:469` | `nowMs: () => Date.now()` |
| 7 | 炼金缓存时效 | 墙钟 | `server/src/alchemy/cache.ts:385` | `at = Date.now()` |
| 8 | 跳跃冷却(帧数门) | 游戏秒 | `server/src/sim/world_sim.ts:10666` | `this.frameCount < ready` |
| 9 | 跳跃冷却帧数 | 游戏秒 | `server/src/sim/world_sim.ts:1221` | `JUMP_COOLDOWN_FRAMES = 24` |
| 10 | DoT 每段结算 | 游戏秒 | `server/src/sim/world_sim.ts:4199` | `tickDot(task, DT)` |
| 11 | 料理 buff 到期 | 游戏秒 | `server/src/sim/world_sim.ts:5499` | `tickFoodBuff(b, dt)` |
| 12 | 昼夜 / 世界日长度 | 游戏秒 | `server/src/sim/world_sim.ts:4678` | `FRAMES_PER_DAY = WorldSim.WORLD_DAY_SEC / DT` |
| 13 | 昼夜判定 | 游戏秒 | `server/src/sim/world_sim.ts:4868` | `this.frameCount % WorldSim.FRAMES_PER_DAY` |
| 14 | 赛局时长(逻辑秒) | 游戏秒 | `server/src/sim/world_sim.ts:8966` | `this.partyClock.advance(SIM_SLOW_DT)` |
| 15 | 打盹 / 露水累计 | 游戏秒 | `server/src/sim/world_sim.ts:9032` | `tickAfk(p, nowSec, SIM_SLOW_DT)` |
| 16 | 世界内时间戳(接力) | 游戏秒 | `server/src/sim/world_sim.ts:2318` | `(this.frameCount / TICK_HZ) * 1000` |
| 17 | 打盹秒累计(纯函数) | 游戏秒 | `server/src/social/afk.ts:148` | `p.dozedSec += dt` |

- **判据**:`tests/WS-FND-175-clock-convention.test.ts`(声明句逐字存在 · 启动打印含倍率 · 上表逐行 `文件:行` + needle 与「口径」列一致 · 倍率可复算 · 负对照:删掉声明句 / 把某行口径改反 ⇒ 必红)。

---
## 待 owner 裁决(尚未定)

| # | 事项 | 影响 | 我的建议 |
| :- | :--- | :--- | :--- |
| ~~P-01~~ | ~~`BossDef.loot` 是 `number[]`,表达不了**数量**(手册写 `703×10`、`117×15`,实际落在 1~3)~~ | **已裁(CR-27,2026-11-17)**:战利品数量归一 —— `shared/types/entities.ts` 新增 `BossLootEntry { id, count }`,`shared/constants/bosses.ts` 新增 `normalizeBossLoot` / `bossLootEntries`,`bosses/raid.ts` 的 `effectiveLoot()` 只在这里归一一次;判据 `tests/WS-FND-79-content-expansion.test.ts` | 已关闭 |
| ~~P-02~~ | ~~`ItemDef.recipe` 键只能是数字 ID,表达不了手册的「**任意染料**」(`#237`/`#245` 被硬编码成 `#166`)~~ | **已裁(CR-27)**:`ItemDef` 新增可选 `recipeAnyTag?: string[][]`(`shared/types/entities.ts`),`net/actions/craft.ts` / `use_alchemy_furnace.ts` 按留白槽逐槽扣减;判据 `tests/WS-06.test.ts`(G-DYE-*) | 已关闭 |
| ~~P-03~~ | ~~手册提到的 7 个**抽象奖励**(自动伐木机甲图纸、姜饼人随从、纯金通关纪念碑、稀有甜点食谱、蓬松彩羽、稀有树种、城堡图纸)在 320 项表里都不存在~~ | **已裁(CR-27,与我的建议相反)**:owner 裁 D-19 改为**入表** —— `items.ts` 新增 `748~754` 七件(内容表 320 → **329**,`TOTAL_ITEM_COUNT` 同步),`bosses.ts` 把这些 id 追加进对应 Boss 的 `loot` / `lootQty`;判据 `tests/WS-FND-79-content-expansion.test.ts` | 已关闭 |
| ~~P-04~~ | ~~微信小游戏 vs 网页~~ | **已裁(D-16)**:双端、**网页优先**;平台相关层可插拔 | 已关闭 |
| P-05 | 真机 FPS 从未实测 | 渲染选型的基线 | 需要真机;当前只有 headless swiftshader 的 60 FPS(不代表真机) |
