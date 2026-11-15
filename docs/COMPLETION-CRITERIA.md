# 完成判据 —— 「什么算做完了」

> **本文的目的**:把「完成」从印象变成**可验证的判据**。
> 本仓门禁已经全绿(1381 条 / 21 套件 / 29 项自检),
> **但门禁全绿 ≠ 项目完成** —— 本文给出区别在哪。

---

## 一、为什么「门禁全绿」不是完成判据

### 实测状态(2026-11-13)

```
$ node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert
  全部通过 · 9111ms · exit 0
  ✓ 用例汇总:1381 条通过(21 个套件)

$ node scripts/gate-selfcheck.ts
  ✓ 门禁自检全部通过(29 通过 / 29 合计)

$ node scripts/backlog.ts
  总计 133 条 / 未关闭 108 条 / 阻塞 0 条 / 已关闭 25 条
```

### 而同一时刻,以下全部为真

| # | 事实 | 证据 |
|---|---|---|
| 1 | **客户端连不上服务器** | `client/**` 里 `colyseus`/`WebSocket`/`fetch(`/`XMLHttpRequest`/`EventSource`/`sendBeacon`/`joinRoom`/`onMessage` …**13 个关键字逐个 grep,全 0 处** |
| 2 | `client/src/net/prediction.ts`(457 行,完整实现) | **生产 import 者 0 处**;`orphan-audit.ts:84` 的白名单理由自己写着「**等客户端网络层**」 |
| 3 | **倒地玩家可被任意传送** | 实测:`applyPlayerMove('p1',32,32)` ⇒ `true`,位移 **33.9 格**(64 格地图的一半) |
| 4 | **倒地玩家可照常打怪** | `attackMob`(L1476-1514,**39 行**)体内 `downed` / `downedStates` / `vitals` **零命中** |
| 5 | 料理 buff 7 个字段无任何消费点 | `hpFlat` / `defFlat` / `gravityMul` / `muOverride` / `jumpMul` / `gatherMul` / `expMul` |
| 6 | 复活宽限无敌**已修但无名** | patch `revive` 回 `iframeSec=0` ⇒ **WS-10 94/94 仍全绿**;`iframeSec`/`.applied`/`blockedByIframe` 在测试里**各 0 次** |

**⇒ 结论:本仓的门禁度量的是「每个模块自己是否自洽」,不是「玩家能否完整走一遍」。**

---

## 二、完成的判据:三档

### 档 A —— 已达成(2026-11-13)

```
[x] 冻结层不变量          17 项全绿
[x] 21 个测试套件         1381 条断言全绿
[x] 门禁自检              30/30    ★ 2026-11-14:28→29(修 T37)→ 31(加 T38×2)→ **30**(移除 1 条过期用例)
[x] 可擦除语法            5 个目录无 enum/参数属性/namespace/装饰器
[x] 内容基线锁            v1-eaefa38b 一致
[x] 文档结构              12 份 WS + 39 份非 WS 全绿
[x] 判据形态审计          59 处已定性,本期新增 0
[x] 临时残留              0
⇒ 判据:**所有质量闸门可复跑且全绿**。已达成。

> ★ **2026-11-14 同日补注(接手者)**:上面这个「档 A」块是 **2026-11-13 的时点快照**。
> 其中**只有「门禁自检」这一项因本轮改动而更新**(29/29 → **31/31**,加了 T38-a / T38-b
> 两条区分力自检);其余数字(套件数 / 断言数 / WS 文档份数 / 判据形态审计处数 / 临时残留)
> **当时是实测的,现在已过期** —— 本次**未**逐项重测、也**未**改动它们,
> 以免制造"已经核对过"的假象。
> 当前值以
> `node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck`
> 的实际输出为准(见 `docs/HANDOVER.md` §三 与 `docs/LEAD-PLAN.md` §7.2.1)。
```

### 档 B —— 「服务端能完整跑一遍」的判据

```
[~] US2 网关联动**端到端**可证:客户端报文 → 房间 → 模拟 → 快照回传
    ★ 现状:room→sim 的**驱动**已接(实测因果:断通路位移 6.0750→0);
            **客户端那一半 2026-11-14 补上**(`net/input.ts` 产 `InputCmd`、
            `net/predictor.ts` 跑预测、`session.sendMove` 上行、
            `ws_server.ts` 按 `t:'move'` 收下并转 `room.applyMove`)。
    ⇒ **仍未勾**:缺一条**跨进程**的端到端断言(真 socket + 真 `RoomRuntime`
      + 客户端帧形态),本轮只做到「两侧各有断言 + 帧形态被钉住」。
[x] 22 个 RoomAction 中,该有执行层的那些**真的执行**
    ★ 现状(2026-11-14 第二轮):已接线 **9 个**
      —— 管理四件(`SET_MEMBER_ROLE` / `KICK_MEMBER` / `SET_ROOM_ACCESS` / `SET_PARTY_MODE`)
      + `CLOSE_ROOM` + **物质层四件套**(`PLACE_BLOCK` / `BREAK_BLOCK` / `DROP_ITEM` /
      `PICKUP_ITEM`);另有 2 个走**专用报文通道**(`MOVE` / `ATTACK`);
      其余 13 个**显式** `NOT_IMPLEMENTED` 并逐条写明缺什么
      (`docs/TASK-96-action-landing-gaps.md`)。归类判据:`tests/WS-FND-18` 四组。
    ★ **网络可达性已补齐**(2026-11-14 第二轮):客户端 `sendAction` →
      `ws_server` 的 `t:'action'` → `RoomRuntime.dispatchAction` → `t:'actionResult'`
      回执(**四种分类都回**:OK / INVALID / PERMISSION / NOT_IMPLEMENTED)。
      判据 `tests/WS-FND-21-action-e2e.test.ts`(真 socket:发 → 执行 → 回执 + 世界真的变了)。
    ★ 物质闭环的行为判据在 `tests/WS-FND-20-material-loop.test.ts`(11 条):
      每条都要求**世界与背包两侧同时**正确 —— 专门覆盖"扣了东西没放下"/
      "凭空多出一个块"/"背包 +1 而地上那件还在"这三种半截事务。
    ⇒ **仍未勾**:剩下的 13 个仍未接线,其中 4 个在全仓**没有任何落地点**
      (`OPEN_CHEST` / `USE_OWN_CHEST` / `RESET_WORLD` / `MODIFY_TOWN`)——
      它们挡住的是「容器 / 世界重置 / 城镇改造」,不再是「建造与拾取」。
[x] 生产入口可跑性:三条阻塞**全部消除**(2026-11-14)
    ① 装饰器:44 处 `@type` → 官方 `defineTypes`,行首计数 **0**;
    ② CJS 命名导入:`Client` 改 `import type`(它本就没有运行时值)、`Room` 改 default 解构;
    ③ `registerHandlers()` 全仓 0 调用点 → 已在 `onCreate` 里加 1 处。
    ⇒ 实测 `node -e "import('./server/src/net/room.colyseus.ts')"` 输出 **LOADED**;
      `entry_load_exempt.ts` 摘掉该条豁免(现只剩浏览器入口 1 条)。
[x] 未决台账 108 条未关闭 → **逐条定性完成**:24 已实现未标 / 31 真欠账 / 49 待裁 /
    **4 我不知道**(独立计数)。合计 108 ✓。逐条表见 `docs/BACKLOG-108-TRIAGE.md`。
⇒ 判据:**从浏览器走一遍多人流程不撞空操作**。**仍未达成** ——
  剩下的阻塞是「已接的动作只有 9/22」(其余显式返回 `NOT_IMPLEMENTED`,
  不再静默,但功能确实没有),以及档 C 的玩法项。

**★ 2026-11-14 同日续:US2 与客户端的真实状态(实测,取代 §一 的旧结论)**

```
US2 网关联动:room → sim 的驱动**已在岗**(实测因果:断通路位移 6.0750→0)。
客户端联机层:**不是"不存在"**。`client/src/net/session.ts` 已在生产链上:
  main.ts:22 import 它;main.ts:76-93 用 `?server=` 装配;
  session.ts 负责 WebSocket + hello + welcome 校验 + 二进制帧 → store.apply。
⇒ §一 那句「13 个关键字逐个 grep 全 0 处」**是 2026-11-13 的实测,现已过期**。
★ 但本轮**实测到一条真的端到端断裂**(它躲过了 WS-12):
  服务端用 **WebSocket 文本帧**发 welcome,而 session.ts 只接受 ArrayBuffer/视图
  ⇒ 文本帧被当「载荷形态不对」丢弃 ⇒ **握手永不完成**(state 恒 connecting)、
    `localPlayerId` 恒空、圆心恒 null,**而二进制快照照常合入**(所以画面在动)。
  ⇒ 已修(文本帧汇入同一 `classifyDownlink` 分派),并有端到端判据
    `tests/WS-FND-15-e2e.test.ts`(真 startWsServer + 真 createSession;
    注入「废掉字符串分支」⇒ 该套件 2/4 红)。
```

### 档 C —— 「核心玩法机制成立」的判据

```
[x] 倒地 → 幽灵泡泡:四条硬规则**全部**有实现且有断言(2026-11-14 补齐 3/4)
    [x] 免伤      `vitals.ts:634`(旧文档写的 `:407` 已过期)
    [x] 不能治疗  `vitals.ts:674`(旧文档写的 `:442` 已过期)
    [x] 不能移动  `world_sim.ts:2424-2427`(倒地 ⇒ `applyPlayerMove` 返回 false,
                  理由可判定:`lastMoveRejection === 'DOWNED'`)
    [x] 不能攻击  `world_sim.ts:1596-1598`(倒地 ⇒ `attackMobAuthorized` 返回
                  `rejected: 'DOWNED'`,**不是**静默放行)
    ★ 四条共用**同一个真值来源** `VitalsSystem.downed`(不选 `DownedState` ——
      那个泡泡要慢帧 2Hz 才建,拿它当闸会留最长 0.5s 的窗口)。
    ★ 判据:`tests/WS-10.test.ts` 的 ACT 前置段 —— 含**健在负对照**(同一动作仍允许)
      与注入验证(去掉闸 ⇒ 红)。
[~] 9 种动态房间的玩家增益:**每种都有决定**(`server/src/rooms/effects.ts` 的
    `ROOM_EFFECT_DECISION`,对着冻结层 `ROOM_RECIPES` 逐条核 —— `WS-FND-17` 钉住)。
    细分:4 种有**数值**增益(锻造解锁 / 食堂大餐 / 卧室回血 + 打盹 / 温泉上限)、
    1 种**纯展示**(画廊)、4 种是**系统解锁而系统还不存在**(牧场 / 炼金室 / 温室 / 百货店,
    每条都写明缺什么)。⇒ **仍未勾**:「9 种都有玩家能感知的增益」今天不成立。
[~] 料理 buff 有消费点:大餐乘区(`CANTEEN_MEAL_MUL`)由「在食堂 **且** 带着料理 buff」
    触发;`WS-FND-17` 钉住「字段可达 + 空手站进去不给」。
    ⇒ **仍未勾**:缺**生产者** —— `WorldSim` 还没有「这个玩家身上的 FoodBuff 列表」,
    所以 `hasMealBuff` 在运行期恒为 `undefined`。接 `cooking.ts` 的 buff 队列进
    `WorldSim` 是下一步(与本轮的消费点不是同一件事)。
[x] 三件死道具(733 羽毛笔 / 435 复活旗 / 227 泡泡水枪)有裁决:
    **保留在冻结内容表 + 显式标记未实装**(`scripts/dead_items.ts` 逐条写明缺什么;
    `WS-FND-17` 的 FND17-6 钉住「仍在表里 + 未实装是显式的」)。
⇒ 判据:**手册给玩家的每个机制都能被玩家感知到**。
  今天:1 项完成、2 项部分(各自的「还差什么」已逐条写明,不是笼统的"未达成")。
  ★ 标记约定:`[x]` 达成 / `[~]` 部分(完成度与缺口都已写明)/ `[ ]` 未开始。
```

---

## 三、唯一的全局阻塞项

```
★ client 联机层缺失 —— 它是**唯一**同时挡住档 B 与档 C 的东西:
  · 挡住档 B 的理由:US2 的客户端那一半不存在
  · 挡住档 C 的理由:倒地/房间/料理的"可感知"全都需要它把状态送到屏幕上
  · 挡住"真机 FPS 实测":从未测过(见未决台账)
```

**⇒ 已完成核查(两轮独立)**
```
docs/CLIENT-NET-READINESS.md   21,703 B  task-52:「缺什么」L0-L5 六层已查清
docs/CLIENT-NET-GAP.md         25,223 B  已证「甲:设计上该有,但漏了」+ 三条决定性证据
Lead 全局复核(208 文件含 _design/):
  "客户端 + 网络 + 指派/归属"共现且**非否定**的行 = **0 处**
  ⇒ **没有任何文档指派过客户端网络层的归属** —— 这是**计划层的洞**,不是执行遗漏
```
**⇒ 关于 §三「唯一全局阻塞项」的更新**:
  上面「没有任何文档指派过客户端网络层的归属」是 2026-11-13 的复核结论,
  而**同一天之后** session.ts 就出现了(见上)。⇒ 本节按「历史核查记录」读,
  不要据此认为客户端联机层仍空缺。
  ★ 仍**未**接的是 `prediction.ts`(0 生产引用),而它的卡点在**输入端**:
    预测器要 `InputCmd`,而客户端没有输入生产者(WASD 现在驱动**相机平移**),
    且「WASD 是镜头还是角色」是**产品裁决**(见 docs/TASK-83-wasd-three-options.md)。
    ⇒ 这不是"没人写",是**等一个 owner 决定**。
```

**⇒ 已派 task-67(client-stage 认领),三阶段:**
```
阶段 1  本地权威点清单(只读)—— ★ 必须先做
        理由:boot.ts 至少两处在自己算权威:
              · pan(相机)与 playerGx(玩家格)**同一个变量**
              · bossHp 从冻结层常量起,本地递减(那不是模拟 Boss,是给血条做动画)
        ⇒ 现在恰好相等所以不报错;接入网络后二者第一次分叉,
          表现是「屋顶在错误位置淡出」—— 不报错、断言也不红
阶段 2  协议契约对齐(逐字段比 RoomSchema ↔ prediction.ts 的 Snapshot)
阶段 3  最小可行接线(**不得重写 prediction.ts** —— 它是已有资产)
```

---

## 四、判据纪律:本仓反复踩到的同一种失效

**「测试全绿 + 生产零消费」家族 —— 已确认 8 例以上:**

| # | 实例 | 形态 |
|---|---|---|
| 1 | 25 个 AI 的 `tick` | 生产 0 次调用 |
| 2 | `fsm.tick()` | 22/24 只生物从不移动 |
| 3 | `CarrySystem` | `new Map()` + 0 调用点 |
| 4 | `MobHost.interact/damage` | 9 种事件永不触发 |
| 5 | `driver.sqlite.ts` 169 行 SQL | 从未执行(已修 CR-12) |
| 6 | 9 种房间的玩家增益 | `.rooms()` 只出现在测试里 |
| 7 | `tickLogistics` 丢弃 `exit` | 传送带的货被凭空摧毁(已修) |
| 8 | **幽灵泡泡「不能移动/不能攻击」** | `attackMob` 39 行体内零检查 |
| 9 | `revive` 宽限无敌 | 已修但**无名**(patch 回坏的 ⇒ 94/94 仍绿) |

**⇒ 判据必须从「玩家路径的后果」读,不能从「设计意图的代码载体」读。**
**⇒ 通行的验收手法(已在多轮实测中确立):**
```
① 破坏它声称守护的东西 ⇒ 看它红不红。绿 ⇒ 它不是判据,是**覆盖证据的赝品**。
② 接线类改动必须做**打断通路**的对照 ——
   只证明"改后有位移"证明不了位移来自那条通路,
   因为世界里本来就有别的力会让东西动。
③ 一条注入没红**有两种解释**:断言没牙,或**代码里有第二份实现顶着**。
   必须查清是哪种(已两次实测到后者)。
④ 还原后 **SHA-256 逐字节一致**。
```

---

## 五、未决与边界

### 未实测(明确列出)
```
[x] 真机 FPS —— **headless 实测到数字,真机仍未测**:硬件 ANGLE/D3D11 540 fps、
    SwiftShader 120–182 fps(主线程 0.19–0.38 ms/帧),带**空页对照**证明 540 = 浏览器
    调度上限而非渲染成本。命令 `node scripts/fps-probe.ts [--gl=swiftshader]`;
    全文 `docs/MEASUREMENTS-S5.md` §1。
    ⇒ **仍未测**:真机(本环境没有真机,且 headless 无 vsync)⇒ 这些数**不是**玩家帧率。
[x] colyseus.js 与 vite 8 / es2022 的打包兼容性 —— **未实测,且原因已取证**:
    `colyseus.js` 在 `package.json`(optionalDependencies)与 `node_modules` **都不存在**;
    用真 vite 8 + es2022 建对照包证明构建链本身通,而它在**解析阶段**即死
    (`ERR_MODULE_NOT_FOUND`)。见 `docs/MEASUREMENTS-S5.md` §2。
    ⇒ 「兼容」这一半**没有任何证据**,不许当成"已兼容"。
[x] `RoomSchema` 与 `prediction.ts` 的 `Snapshot` **逐字段**对齐 —— 已出**逐字段表**
    (14 字段 × 在 PlayerSchema?/类型一致?/在 Snapshot?/解码覆盖?),判据
    `tests/WS-FND-24-contract-align.test.ts`(7 条)。查出**两条真实不一致**:
    `dirtyChunkKeys` 声明并登记但 **0 个写入点**(`schema.colyseus.ts:283` / `:319`);
    `tick` **不进**字段表(由报文头承载,`wire.ts:157-163` 无此键)
    ⇒ 按"逐字段对齐"读会误判成缺字段。
[x] #245 玩家可达性 —— ★ **它不是一个 issue 号,是一个物品 id**(`245 手持庆典烟花筒`)。
    命题(237/245 的配方把染料硬编码成 `#166` ⇒ 玩家手握 `167/168/169` 时会失败)
    **已修好且已实测**:两条都保留 `166` 登记键、加 `recipeAnyTag: [['染料']]`
    (`shared/constants/items.ts:142-144`),匹配器 `matchRecipeByTags`(`:494`)。复现:
    `node --input-type=module -e "const m=await import('./shared/constants/items.ts');for(const d of [166,167,168,169])console.log(d,m.matchRecipeByTags(245,{103:1,126:1,[d]:1}).ok)"`
    ⇒ 四色全 `true`、缺染料 `false`。
    ⇒ **仍未做的另一半**是「游戏内真的能合成」:`CRAFT` 至今**没有执行分支**
    (`docs/TASK-96-action-landing-gaps.md` 第三节)—— 那属于档 B 的 13 个未接线动作。
[~] z 轴:只接了 x/y —— **现状已逐行取证**(原文引的行号已过期:`room.ts:868` → **`:1686`**)。
    z 在 wire(`wire.ts:114`)与刚体(`shared/types/physics.ts:51` 有 `z`/`vz`)**都有**,
    丢在唯一那条写入链上:`world_sim.ts:2582` 的 `applyPlayerMove(playerId, x, y)` 签名只收
    x/y、`:2606-2607` 只写 `b.x`/`b.y`;而 `room.ts:1692` **仍写** `p.z = intent.z`(声明值),
    又被每帧 `projectAllPlayers` 的权威覆盖 ⇒ `p.z` **有两个语义不同的写者**。
    所需改动已逐行列出(room.ts:491/1624/1681/1686-1692;world_sim.ts:2582/2602/2606-2608/3125)。
    **本轮未改** —— 它在 `dispatchAction` 那条串行接缝上(见下)。
[~] knockback 与移动的优先级 —— **裁决:今天它是 no-op,不是"谁压住谁"**。
    取证:`damage.ts:441-446` 算出 `knockbackImpulse`,但 `attackMob`
    (`world_sim.ts:1939-1999`)**只消费 `result.finalDamage`**;
    `PhysicsWorld.applyImpulse`(`physics/world.ts:621`)生产调用点 **0** ⇒ 事实是"击退未实现"。
    **裁决(给将来接线定规矩)**:击退走**速度**(`applyImpulse`)、移动走**位置**
    (`applyPlayerMove` 直写 `b.x/b.y`、绕过积分)⇒ 只接速度的话,**下一次移动报文会把它抹掉**
    (即"移动优先")。要让击退可见,必须给它一个**短时不可覆盖窗口**(或把移动也改成速度语义)。
    那是独立一件;**本轮未接线**,故本条只到"已裁决"。
```

### 不能作为判据的
```
✗ 「门禁全绿」            ⇒ 已达成,而档 B/C 未达成(本文第一节)
✗ 「108 条未关闭 = 108 个缺陷」⇒ 台账混了三种:已实现未标、真欠账、待裁
✗ 「某常量 / 某数字」      ⇒ 实测过:某常量从 600 改成 2/10/100/300/500/590/599 全绿,
                             601+ 才红 ⇒ 断言把**一个点**钉住了,以下整条区间没有
```

---

## 六、立项建议(按依赖顺序)

| 序 | 题目 | 前提 | 状态 |
|---|---|---|---|
| 1 | **客户端联机层(本地权威点 → 契约 → 接线)** | 无 | **已派 task-67** |
| 2 | 幽灵泡泡规则 3/4 的实现 **+ 断言** | 1 不阻塞(服务端侧) | CR-23 待裁 |
| 3 | 房间↔模拟层装配 + 动作执行层(**含静默成功回执**)+ 生产入口可跑性 | 无 | `docs/ARCH-GAPS.md` 已立 |
| 4 | 复活宽限的**门禁**断言(它现在无名) | 无 | 已派 coop-party |
| 5 | 108 条未决台账逐条定性 | 无 | 未派 |
| 6 | 料理 buff / 三件死道具的**玩法裁决** | 需 owner 决定 | CR-21 / task-64 C 待裁 |

**⇒ 序 1 是唯一的关键路径** —— 其余五项都与它并行,只有它是「不修则多人游戏不存在」。
