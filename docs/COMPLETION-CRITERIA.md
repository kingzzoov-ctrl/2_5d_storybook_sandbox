# 完成判据 —— 「什么算做完了」

> **本文的目的**:把「完成」从印象变成**可验证的判据**。
> 本仓门禁已经全绿(**2259 条 / 114 套件 / 30 项自检**;2026-11-18 实测,用例数与套件数以 `README.md` 的门禁展示区为准 —— 下面 §一 那段是 2026-11-13 的实录,保留原样),
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
  总计 133 条 / 未关闭 108 条 / 阻塞 0 条 / 已关闭 25 条   # ← 2026-11-13 快照(现值:未关闭 **0** 条)
```

> ★ 2026-11-16:上面这段是 **2026-11-13 的门禁实录**(保留原样,不做后验改写)。
> ★ **2026-11-19(第十轮)**:把它**逐项标成快照** —— 里面每个数都只是 2026-11-13 的读数,
> 已全部过期(`未关闭 108 条` / `1381 条 / 21 套件` / `29/29` **都不是现值**;旧文只在前一句里说
> 「保留原样」,读者仍会把它们当现值读 —— 第十轮实测:同族四处矛盾数字就是这样活了六天)。
> 现值**只有一个来源**:`node scripts/sync-docs.ts --check`(比对 `README.md` 的门禁展示区,
> 由门禁实测写回;调用点 `verify.ts::verifyDocsNumbers()`)。截至 2026-11-19 实测:
> `未决台账 133 条 / **0 未关闭** / 0 阻塞 / 133 已关闭`(唯一口径来源 `node scripts/backlog.ts`)、
> 内容基线指纹 `v2-0afe5562`、`测试执行 146/146 · 2649 个用例`、`文档结构 14 份 WS + 75 份非 WS(= 89)`。
> ⚠️ 手抄这类数字正是本仓反复踩的坑(同一份事实两个来源)⇒ 引用时**引来源命令**,不要引散文里的数。

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

### 档 A —— 已达成(**历史快照:2026-11-13**;带「现值」的行是读出来的,不是重测的)

```
★ 以下 7 项是 **2026-11-13 的读数快照** —— 保留原样、不做后验改写,但**每一项都已过期**;
  现值只在 `README.md` 的门禁展示区(由 `scripts/sync-docs.ts` 从门禁实测写回),本文件不手抄。
[x] 冻结层不变量          17 项全绿
[x] 66 个测试套件         1822 条断言全绿          ← 现值:146 套件 / 2649 用例
[x] 门禁自检              30/30    ★ 2026-11-14:28→29(修 T37)→ 31(加 T38×2)→ **30**(移除 1 条过期用例)
[x] 可擦除语法            5 个目录无 enum/参数属性/namespace/装饰器
[x] 内容基线锁            v1-eaefa38b 一致         ← 现值:指纹 `v2-0afe5562`
[x] 文档结构              12 份 WS + 39 份非 WS 全绿 ← 现值:14 份 WS + 75 份非 WS(= 89;`verify.ts --docs` 实测)
[x] 判据形态审计          59 处已定性,本期新增 0     ← 现值:登记 107 处 / 本期新增 0
[x] 临时残留              0                        ← 现值:`--docs` 实测 330 个(审计扫描根**之外**,只告警)
⇒ 判据:**所有质量闸门可复跑且全绿**。已达成。

> ★ **2026-11-14 同日补注(接手者)**:上面这个「档 A」块是 **2026-11-13 的时点快照**。
> 其中**只有「门禁自检」这一项因本轮改动而更新**(29/29 → **31/31**,加了 T38-a / T38-b
> 两条区分力自检);其余数字当时是实测的、现在已过期。
> ★ **2026-11-19(第十轮)补注**:块内已逐行标「现值」,并给整块加了快照抬头 ——
> 不带标注的过期数字与现值在读者眼里**同形**,而这一族数字正是「没人管的数」的产地。
> 「现值」那四处是**读**出来的(不是重测的);现值仍然**只有一个来源**:
> `node scripts/sync-docs.ts --check`(比对 `README.md` 的门禁展示区,由门禁实测写回;
> 调用点见 `verify.ts::verifyDocsNumbers()`,人工口径见 `docs/HANDOVER.md` §三 与
> `docs/LEAD-PLAN.md` §7.2.1)。其余各项本文件**不手抄**。
```

### 档 B —— 「服务端能完整跑一遍」的判据

```
[x] US2 网关联动**端到端**可证:客户端报文 → 房间 → 模拟 → 快照回传
    ★ 现状:room→sim 的**驱动**已接(实测因果:断通路位移 6.0750→0);
            **客户端那一半 2026-11-14 补上**(`net/input.ts` 产 `InputCmd`、
            `net/predictor.ts` 跑预测、`session.sendMove` 上行、
            `ws_server.ts` 按 `t:'move'` 收下并转 `room.applyMove`)。
    ⇒ **已勾(2026-11-17)**:跨进程端到端断言已补 —— 判据 `tests/WS-FND-65-us2-crossproc.test.ts`(真 socket + 真 `RoomRuntime` + 真 `createSession`)。历史缺口:缺一条**跨进程**的端到端断言(真 socket + 真 `RoomRuntime`
      + 客户端帧形态),本轮只做到「两侧各有断言 + 帧形态被钉住」。
[x] 24 个 RoomAction 中,该有执行层的那些**真的执行**
    ★ 现状(**2026-11-19 第十轮订正**,取代此前的「23 个 / 已接线 21 个」):
      `RoomAction` 现为 **24 个**(`server/src/net/room.ts#RoomAction`)⇒ **22 个真执行**;
      其余 2 个(`MOVE` / `ATTACK`)走**专用报文通道**,`dispatchAction` 对它们**刻意**回
      `NOT_IMPLEMENTED`(那个码的意思是「别从这里发」,不是「还没做」)。
      22 = 旧文那 19 件(管理四件 `SET_MEMBER_ROLE` / `KICK_MEMBER` / `SET_ROOM_ACCESS` /
      `SET_PARTY_MODE` + `CLOSE_ROOM` + 物质层四件套 `PLACE_BLOCK` / `BREAK_BLOCK` /
      `DROP_ITEM` / `PICKUP_ITEM` + 容器·合成·睡觉四件 `CRAFT` / `SLEEP` / `OPEN_CHEST` /
      `USE_OWN_CHEST` + 派对·驯养·城镇·炼金四件 `START_PARTY` / `BREED_TAME` / `MODIFY_TOWN` /
      `USE_ALCHEMY_FURNACE` + 自动化放置·布线编辑两件 `PLACE_AUTOMATION` / `WIRE_EDIT`)
      + `RESET_WORLD` + `USE_ITEM` + `BUY_ITEM`;后两件是旧文之后新增的(`WS-FND-39/47` 与
      `WS-FND-77`),**加进来时没人数过这一行** ⇒ 旧文「21/23」与 `README.md` 旧文
      「5 个动作真执行」**同时**成假。真值源 = `server/src/net/actions/action_table.ts#ACTION_HANDLERS`
      (`Readonly<Record<RoomAction, ActionHandler>>`,**编译期完整性**:漏一个成员 tsc 报缺键)。
      ⚠️ `RESET_WORLD` 只是**动作层**那半边接了(见下方 2026-11-17 那段),宿主那半边仍不存在。
      归类判据:`tests/WS-FND-18` 四组;各波的**如实边界**见 `docs/TASK-96-action-landing-gaps.md`
      「二之二 ~ 二之四」,**不计入达成**。
    ★ **网络可达性已补齐**(2026-11-14 第二轮):客户端 `sendAction` →
      `ws_server` 的 `t:'action'` → `RoomRuntime.dispatchAction` → `t:'actionResult'`
      回执(**四种分类都回**:OK / INVALID / PERMISSION / NOT_IMPLEMENTED)。
      判据 `tests/WS-FND-21-action-e2e.test.ts`(真 socket:发 → 执行 → 回执 + 世界真的变了)。
    ★ 物质闭环的行为判据在 `tests/WS-FND-20-material-loop.test.ts`(11 条):
      每条都要求**世界与背包两侧同时**正确 —— 专门覆盖"扣了东西没放下"/
      "凭空多出一个块"/"背包 +1 而地上那件还在"这三种半截事务。
    ⇒ **已裁为刻意边界(2026-11-17)**:剩下的 2 个**刻意**不接 —— `MOVE` / `ATTACK`(走专用报文通道,
      `dispatchAction('MOVE')` 回 `NOT_IMPLEMENTED` 是在表示"别从这里发")。
      ★ `RESET_WORLD` 已从这条欠账里**移出**:动作层那一半接了(权限 / 显式确认 /
      种子校验 / 能力缺失 / 回执,判据 `WS-FND-34`),但**宿主那一半不存在** ⇒
      生产里仍然重置不了。落点裁决与**必须 owner 定的存档政策**见
      `docs/TASK-97-world-reset-ruling.md`。
    ★ 容器/合成/睡觉三条的**如实边界**(客户端看不到箱内 / 箱内容不持久化 /
      `SLEEP` 的世界侧读者)已写进 `TASK-96` 的二之七节,**不计入达成**。
      ★ 2026-11-15 更新:`SLEEP` **已有世界侧读者**(`WS-FND-43` 钉住"谁在睡"可见),
      但**回血数值仍未按睡眠改动** —— 那要产品裁决,不是接线。
[x] 生产入口可跑性:三条阻塞**全部消除**(2026-11-14)
    ① 装饰器:44 处 `@type` → 官方 `defineTypes`,行首计数 **0**;
    ② CJS 命名导入:`Client` 改 `import type`(它本就没有运行时值)、`Room` 改 default 解构;
    ③ `registerHandlers()` 全仓 0 调用点 → 已在 `onCreate` 里加 1 处。
    ⇒ 实测 `node -e "import('./server/src/net/room.colyseus.ts')"` 输出 **LOADED**;
      `entry_load_exempt.ts` 摘掉该条豁免(现只剩浏览器入口 1 条)。
[x] 未决台账 108 条未关闭 → **逐条定性完成**:24 已实现未标 / 31 真欠账 / 49 待裁 /
    **4 我不知道**(独立计数)。合计 108 ✓。逐条表见 `docs/BACKLOG-108-TRIAGE.md`。
⇒ 判据:**从浏览器走一遍多人流程不撞空操作**。**仍未达成** ——
  剩下的阻塞是「真执行的动作 **22/24**」(其余 2 个 `MOVE` / `ATTACK` 走专用报文通道、刻意不进 `action`,
  见 `docs/TASK-96` 的「未接线」一节;此前这里写过的 **9/22**(2026-11-13)与 **21/23** 都是当时的动作表),以及档 C 的玩法项。

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
[x] 9 种动态房间的玩家增益:**9 种都有玩家能感知的增益**(2026-11-17 D-19 第 3 条补齐)
    `ROOM_EFFECT_DECISION`,对着冻结层 `ROOM_RECIPES` 逐条核 —— `WS-FND-17` 钉住)。
    细分:4 种有**数值**增益(锻造解锁 / 食堂大餐 / 卧室回血 + 打盹 / 温泉上限)、
    1 种**纯展示**(画廊)、4 种是**系统解锁而系统还不存在**(牧场 / 炼金室 / 温室 / 百货店,
    每条都写明缺什么)。⇒ **已勾(2026-11-17)**:4 个系统已实现,判据 `WS-FND-75` + `WS-FND-77`。
[x] 料理 buff 有消费点(2026-11-17 补齐 6 字段,判据 WS-FND-71)
    触发;`WS-FND-17` 钉住「字段可达 + 空手站进去不给」。
    ⇒ **已勾(2026-11-17)**(2026-11-15 更正了病因):原本文写「缺**生产者** —— `WorldSim` 还没有
      「这个玩家身上的 FoodBuff 列表」」。**那只是表象,不是病因**:`tryCookAt` 的两个调用者
      (`world_sim.ts:3584` 机械臂投料、`:3989` 站台投料)**都没有玩家身份**,成品落在地面上
      (`:4014` `mobGround.push`)—— 所以 `res.buff` **跟随成品走**,将来属于**捡起来吃掉的人**,
      而不是动手做它的人。⇒ 在 `tryCookAt` 里把 `res.buff` 塞给某个玩家**恰恰是错的**:
      那会让"机器人做的饭"直接给玩家上 buff,同时地上那份成品还能被再吃一次。
      **真正的缺口是「吃」这个动词**:配送/吃掉成品 → 写入该玩家的 active buffs → 慢帧 `tickFoodBuff`
      → 把合并结果(经 `combatantStats` 第三参)喂进战斗。而"吃掉"= 一个 `USE_ITEM` 式动作,
      今天 `RoomAction` 里没有(决策稿:`docs/TASK-99-use-item-verb.md`)。
      ⇒ 这条的**前置依赖是那个动词**,不是一处传参。详见 `docs/TASK-98-archive-c-rulings.md` §2。
> ★ **2026-11-17 收口(D-19)**:上面三条**当时标为 `[~]`** 的条目已**全部转 `[x]`**,依据逐条列在下面 ——
> 1 **US2 跨进程**:真 `startWsServer(port 0)` + 真 `RoomRuntime` + 真 `createSession`,
>   判据 `tests/WS-FND-65-us2-crossproc.test.ts`(4 条,含负对照与 userId 有牙对照)。
> 2 **9 种房间增益**:4 种「系统不存在」的已实现 —— 牧场 `systems/ranch.ts`(日结产毛团/温泉橘)、
>   温室 `systems/greenhouse.ts`(全天候透光 + 洒水 + 429 分拣)、炼金室 `systems/alchemy_lab.ts`
>   (自由炼金 + 首创冠名陈列)、百货店 `systems/depot.ts`(上架 + 购买动作 `BUY_ITEM`);
>   判据 `tests/WS-FND-75-room-systems.test.ts`(23 条)+ 接线 `tests/WS-FND-77-wiring-systems.test.ts`(10 条)。
>   ⚠️ **如实边界**:内容表仍缺「毛团」「温泉橘」两件物品(加物品要动 `content-lock` 指纹与 320 计数),
>   牧场日结在没有这两件时**如实**返回 `dropped: []` + `skipped` 原因,不编 ID。
> 3 **料理 buff 6 字段**:`defFlat`(生物伤害乘区)、`expMul`(经验加成)、`moveMul`/`gravityMul`/`jumpMul`
>   (物理设置口单点推送)、`gatherMul`(采集归属)—— 判据 `tests/WS-FND-71` + `tests/WS-FND-66`。
>   ⚠️ **如实边界**:`gatherMul` 只做到"归属到玩家并把乘子放进回执",件数放大规则(整数件数 vs 概率双倍)
>   未裁决,未编规则。

> ★ **2026-11-16 更正(上两段的结论已过期;改的是结论,不改历史叙述)**
> 1 **"吃掉"这个动词已在**:`RoomAction` 由 22 → **23** 加了 `USE_ITEM`
>   (`docs/TASK-99-use-item-verb.md`);吃料理 ⇒ 写入该玩家 active buffs,`hpFlat` 进
>   `maxHpForLevel`、`atkMul`/`critRate`/`critDmg` 进 `combatantStats`,慢帧到期清空
>   —— 判据 `WS-FND-39`(15 条)与 `WS-FND-47`(大餐乘区 8 条)。
> 2 **三件死道具不再"只剩裁决"**:
>   · 733 羽毛笔 —— 已接(`USE_ITEM` → `featherRevive`,判据 `WS-FND-39` FND39-3);
>   · 435 复活旗 —— 已接(`tickDowned` 的**旗优先**半血复活,判据 `WS-FND-49` FND49-9/10);
>   · 227 水枪 —— 活人半边(`live_bubble.ts`)与**器件半边**(浇灭料理站炉火)都已接,
>     判据 `WS-FND-49` FND49-11 与 `WS-FND-52`(10 条);**仍缺**:火灵护盾、coop 工位灭火。
>   ⇒ `scripts/dead_items.ts` 三条 `reason` 已按"哪半边还缺"重写(不再声称"入口不存在")。
[x] 三件死道具(733 羽毛笔 / 435 复活旗 / 227 泡泡水枪)有裁决:
    **保留在冻结内容表 + 显式标记未实装**(`scripts/dead_items.ts` 逐条写明缺什么;
    `WS-FND-17` 的 FND17-6 钉住「仍在表里 + 未实装是显式的」)。
⇒ 判据:**手册给玩家的每个机制都能被玩家感知到**。
  当时(2026-11-13)的读数:1 项完成、2 项部分(各自的「还差什么」已逐条写明,不是笼统的"未达成");
  **2026-11-17 收口后,本档 C 的各项均已勾 `[x]`**,「如实边界」写在各条目里(见上,不再有"部分")。
  ★ 标记约定:`[x]` 达成 / `[ ]` 未开始;第三档「部分」`[~]` **本文件已无** ——
    最后两条(§五 的 z 轴 / knockback)已随 2026-11-16 第二批收口转 `[x]`,历史原文仍保留在 §五。
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

> ★ **2026-11-17 owner 裁决(D-19 第 9 条)**:上面两项(真机 FPS、`colyseus.js`+vite8 兼容)
> 在本环境**物理不可测**(无真机 / 依赖不在 `node_modules`),现状态改为
> **「等 owner 提供环境」**——不再是"未决欠账",也不再出现在 `node scripts/backlog.ts` 的未关闭里。
> 两者一旦拿到环境,判据分别是:`node scripts/fps-probe.ts` 在真机上的读数、以及真 `colyseus.js` 包的构建产物。
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
[x] z 轴 —— **当时是 `[~]`:只接了 x/y,已于 2026-11-16 第二批收口转 `[x]`**
    (下面的取证段**保留为历史**;当时的原话是「现状已逐行取证」)。
    **现状已逐行取证**(原文引的行号已过期:`room.ts:868` → **`:1686`**)。
    z 在 wire(`wire.ts:114`)与刚体(`shared/types/physics.ts:51` 有 `z`/`vz`)**都有**,
    丢在唯一那条写入链上:`world_sim.ts:2582` 的 `applyPlayerMove(playerId, x, y)` 签名只收
    x/y、`:2606-2607` 只写 `b.x`/`b.y`;而 `room.ts:1692` **仍写** `p.z = intent.z`(声明值),
    又被每帧 `projectAllPlayers` 的权威覆盖 ⇒ `p.z` **有两个语义不同的写者**。
    所需改动已逐行列出(room.ts:491/1624/1681/1686-1692;world_sim.ts:2582/2602/2606-2608/3125)。
    **本轮未改** —— 它在 `dispatchAction` 那条串行接缝上(见下)。
    ⇒ **以上各行是 2026-11-16 之前的现状**;第二批收口后 z 已**两头接通**
      (服务端 `applyPlayerMove(...,z?)` 写刚体 + 投影从权威读回;客户端 `client/src/net/height_placement.ts`)
      ⇒ 本条现记为 `[x]`,判据 `WS-FND-49` FND49-3/4/5 与 `WS-FND-48`。
[x] knockback 与移动的优先级 —— **当时是 `[~]`**:当时的裁决是「今天它是 no-op,不是"谁压住谁"」;
    **已于 2026-11-16 第二批收口转 `[x]`**(证据 `WS-FND-49` FND49-6/7/8)。**下面这段保留为当时的取证与裁决原文**:
    取证:`damage.ts:441-446` 算出 `knockbackImpulse`,但 `attackMob`
    (`world_sim.ts:1939-1999`)**只消费 `result.finalDamage`**;
    `PhysicsWorld.applyImpulse`(`physics/world.ts:621`)生产调用点 **0** ⇒ 事实是"击退未实现"。
    **裁决(给将来接线定规矩)**:击退走**速度**(`applyImpulse`)、移动走**位置**
    (`applyPlayerMove` 直写 `b.x/b.y`、绕过积分)⇒ 只接速度的话,**下一次移动报文会把它抹掉**
    (即"移动优先")。要让击退可见,必须给它一个**短时不可覆盖窗口**(或把移动也改成速度语义)。
    那是独立一件;**本轮未接线**,故本条只到"已裁决"。
    ⇒ **以上各行是 2026-11-16 之前的取证与裁决**;第二批收口后击退**已生效**
      (`applyKnockback` + 慢帧推位移 + 推进期间 `applyPlayerMove` 拒搬,
       `lastMoveRejection = 'KNOCKBACK'`,判据 `WS-FND-49` FND49-6/7/8)⇒ 本条现记为 `[x]`。
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
---

## ★ 2026-11-16 状态更正(上面五条**当时标为 `[~]`** 的条目的**最新实测**)

| 条目 | 当时的结论 | 实测(2026-11-16) | 证据 |
|---|---|---|---|
| `:68` US2 网关 | 端到端未证 | 仍未证,**但理由要改**:`colyseus` **装着且能解析**(`optionalDependencies` 已装)⇒ **不是"缺依赖"**;缺的是"点燃真网关的端到端用例" ⇒ **本批已补,见下方「第二批收口」** | `node -e "import('colyseus')"` → 可解析:是;`Test-Path node_modules/colyseus` → True |
| `:147` 9 种房间增益 | 到玩家的只有卧室回血 | **温泉 `×1.3` 已到权威**、**大餐乘区已真的算**、卧室回血早就在;**`forgeUnlocked` 仍无消费点** —— 卡点是内容层**没有"中高级锻造"的分档**(`shared/constants/items.ts` 里 `forge|tier` 命中 **0**)⇒ 卡在**内容分档裁决**,不是卡在接线 | `WS-FND-49` FND49-1/2、`WS-FND-47` 8 条 |
| `:152` 料理消费点 | 大餐乘区未触发 | **已触发**(`hasMealBuff` 由 `tickRoomEffects` 喂);**仍未接**的字段:`defFlat`/`moveMul`/`gravityMul`(冻结层无参数位)/`jumpMul`/`gatherMul`(无采集系统)/`expMul`;`muOverride` 的具名中性值**本批补上**(`MU_OVERRIDE_NONE`),缺的是接线口径 | `WS-FND-47`、`WS-FND-39` 15 条 |
| `:273` z 轴 | 只接了 x/y | **两头都接上了**:服务端 `applyPlayerMove(...,z?)` 写刚体 + 投影从权威读回;客户端 `client/src/net/height_placement.ts`(z 只进第三分量,`z=0` 与接线前逐字段相同) | `WS-FND-49` FND49-3/4/5、`WS-FND-48` 7 条 |
| `:280` knockback | no-op | **已生效**:`applyKnockback` + 慢帧推位移 + **推进期间 `applyPlayerMove` 拒搬**(`lastMoveRejection = 'KNOCKBACK'`) | `WS-FND-49` FND49-6/7/8 |

⚠️ **行号漂移**:本轮改动后,本文件与 `HANDOVER`/`TASK-96`/`TASK-98`/`TASK-99` 引用的 `world_sim.ts` / `room.ts` / `cooking.ts` / `effects.ts` 行号**大量失效**(审查 B 给了逐条清单)。**按符号名定位,不要按行号。**

---

## ★ 2026-11-16 第二批收口(上一张表之后的实测)

| 项 | 上一张表说的 | 实测(本批) | 证据 |
|---|---|---|---|
| US2 网关 | "缺的是点燃真网关的用例" | **已证**:真 `Server.listen(0)` + 生产注册助手 `gameServerConfig(...).initializeGameServer` + `matchMaker.createRoom`(房间由 Colyseus 自己 `new`,`onCreate` 真跑)⇒ 断言 `RoomRuntime.host` **非 null**、城镇 provider(24 → 8)与 SLEEP 读口**在网关路径**生效、真 `RoomSchema` 与权威值一致 | `tests/WS-FND-50-gateway-colyseus.test.ts`(7 条);注入 `host: null` ⇒ 4 条变红;未覆盖:真 socket(无 `colyseus.js` 客户端)、patch 同步按设计关闭 |
| C3 灭火半边(227 对器件) | "只认玩家目标" | **已接**:`USE_ITEM` 新增 `targetDeviceId`;227 水枪 / 212 大铁铲 在 `EXTINGUISH_RADIUS`(3 格)内浇灭**料理站**炉火;五种拒绝(道具不对 / 不是料理站 / 图上没有该器件 / 太远 / 已灭)各有判据 + 负对照 | `tests/WS-FND-52-c3-extinguish-device.test.ts`(10 条);三处注入(去掉置位 / 去掉距离门 / 不传 `targetDeviceId`)分别红 4 / 2 / 8 条,全部逐字节还原 |
| 客户端 z 相机 | "硬跳变(观感未验)" | **已平滑**:`stepCameraHeight(当下, 目标, dt)` 纯函数(α = 1 − (1 − ratio)^dt,帧率无关),`boot.ts` 每帧推进且**目标与当下分开命名**;`z = 0` 时目标与当下都逐位 = 0 | `tests/WS-FND-51-client-z-camera-smooth.test.ts`(7 条);真 Chrome 探针(本仓 `fps-probe`)零异常、零 fatal;⚠️ **观感本身仍未验**(无 headless 驱动跳跃的手段) |
| `muOverride` | "缺具名默认值导出" | **更正**:中性值已有名字(`combat/cooking.ts` 的 `MU_OVERRIDE_NONE = 0`),地板侧默认在 `world/chunk.ts`(`DEFAULT_MU` = 0.75 / `muOfSlot`,裸地 0.72);真正缺的是**接线口径**(滑溜料理要不要盖过冰面 0.98)⇒ **玩法裁决** | `docs/TASK-96` 二之六已改正;`world_sim.ts` 计算面板处注释已改正 |
| 受击击退(接到受击点) | "机制已生效" | **仍未接**,且**不是缺常数**:mob → 玩家那条路 `vitals.applyHit` **没有击退参数**;内容层唯一的击退量是**武器侧**(`weapons.ts` 的 `knockback`,属攻方装备)⇒ 拿它当"被打飞多远"是**发明数值**,接上会打红 `WS-10` 三条既有判据 | `world_sim.ts` 受击点注释;本文件 `:280` 的裁决原文("今天它是 no-op") |
| 连击窗口 / 锻造分档 | 需裁决 | **仍未做**:`liveBubbles` 层数不衰减 —— 冻结内容里**没有**"连中窗口秒数"这个数(`shared/constants/items.ts:120` 只写"连射队友 3 发");`forgeUnlocked` **无内容分档**(`items.ts` 检索 `forge` / `tier` 命中 0) | 检索清单见 `docs/TASK-96` 二之九 |
| 同物种只能 1 只(遗留) | "把物种 id 当实例 id" | **本批已修**:`mobs/spawner.ts` 收出唯一的 id 规则(`MOB_INSTANCE_SEP` / `mobInstanceId` / `mobSpeciesId` / `mobDefOf`),实例 id = `物种 id#序号`(序号单调、永不复用);`trySpawnOne` 去掉按物种去重;8 处查表点全部走 `mobDefOf`;网络侧一行没改(`listWildlife()` 本来就有 `id` + `mobId`) | `WS-FND-19` 10 条(FND19-10 是唯一能钉住"刷怪路径不再去重"的判据);注入 M10 红 6 条 / M11 只红 FND19-10,均逐字节还原 |
| `isNight()` 恒 `false`(遗留) | "缺世界时钟" | **仍卡在裁决**:① 世界侧没有时钟 —— `wiring/components.ts` 的 405 昼夜感光器读 `ctx.param('hour')`,而**全仓没有任何地方喂过这个 param**(生产者 0 处);② `WorldSim.isNight: () => false` 是**如实**回答"没有时钟"。⇒ 要接就必须先定"一天几秒 / 从哪一帧起算" = 玩法数值裁决 | 检索:`'hour'` 只出现在 `components.ts` 的两处**读**;`params:` 的生产者只有 `demo.ts` / `graph.ts` 的空表 |
| 一键交接 | — | `README` / `HANDOVER` 的用例数字与 §九 sha256 表已随本批同步(66 套件 / 1826 条) | `node scripts/verify.ts --all` 的「README 用例汇总」「HANDOVER sha256 表」两栏 |
