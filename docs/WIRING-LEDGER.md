# WIRING-LEDGER · 「实现了、有判据、没接进生产路径」台账

> **性质:登记,不是修复。** 本文件没有改任何 `.ts`;「现状」列写「已接」时才表示有生产调用点。
> 生成:2026-11-19(第六轮)· 写域:`README.md` · `docs/HANDOVER.md` · `docs/AUDIT-W34.md` · 本文件
> 行号是**撰写时实测**,会漂;符号名与文件路径是稳定锚点。引用时以符号为准,行号当提示。

---

## 0 这份台账解决什么

第六轮的四套判据(`WS-FND-118/119/120/121`)把一批子系统逐条测到「有实现、有判据、全绿」。
但**同一批符号的生产非自身调用点仍是 0** —— 于是同一个词「完成」在三处同时成立、在三处含义不同:

```
模块可达    绿  —— verify.ts 的 import 闭包判定它是边
判据全绿    绿  —— tests 里每个函数都被直接调用过
生产路径    空  —— 除测试与门禁外没有第二个调用者
```

> ⚠️ **读数时点**:本台账是**快照**,不是实时状态。撰写时连测两次:
> `tests/*.test.ts` **126 → 128 套件 / 2381 → 2402 用例**,第二次有 **6 个套件红**
> (全来自并发写盘的另一位写者,清单见 `docs/AUDIT-W34.md §13.4`);
> 第六轮 4 套件里只有 `WS-FND-119`(8/8)已落盘,`118/120/121` 不在磁盘上。
> ⇒ **状态列会被别人改代码改掉**:实测同一时间窗口里 `feedPet` 已从「生产 0」变成「生产 1」
> (WS-04 的一条断言因此变红)。引用某一行前请用 §1 的命令复算一次,别把本表当现状。
>
> ★ **收尾时出现的好消息(也是本表最快的过期点)**:同一时间窗口里新增了
> `server/src/party/actions.ts` · `server/src/prank/actions.ts` · `server/src/coop/rush_actions.ts` ·
> `server/src/net/actions/breed_tame.ts` —— 正是 §2.4 / 2.5 / 2.6 / 2.3 那批「未接」的**接线落点**。
> ⇒ 本表登记的是**接线前**的现状;接完之后应当**逐行改「已接」并给出调用点**,
>   而不是把台账删掉 —— 删掉等于把「当时确实没接」这个事实也删了。

`生产可达性` 只查**文件级** `import` 闭包,查不到「文件可达、符号没人调」;
`入口执行层` 只查 `onMessage` 后面那句 `if (!allowed)`,查不到「handler 调了个空转函数」。
本台账填的是这两道门禁之间的缝:**逐符号**。

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
第六轮反复出现的读错法,就是把这两件事当成同一件:一个函数有 12 条断言、每个断言都过,
仍然可以**一次都没在生产里跑过**。

---

## 2 台账

「现状」只用三个词:

| 词 | 含义 |
|---|---|
| **已接** | 有生产调用点(给出文件与行) |
| **已登记** | 已有白名单位置(给出 `verify.ts` / `orphan-audit.ts` 行号),或已由门禁按计算式归类 |
| **未接** | 生产调用点 0 **且**没有任何白名单位置 —— 门禁结构上看不见它 |

### 2.1 combat(`server/src/combat/`)

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-CBT-1 | `SkillDef` / `skillOf` / `planSkillHits` | `weapons.ts:164/474` · `damage.ts:659` | **未接**(生产 0) | 40 把武器各自带技能形状(单体/扇形/直线)与命中计划,但 `WorldSim.attackMob` 只走 `computeDamage`,不读 `skillOf` ⇒ 「技能」只存在于表和测试里 | WS-10 |
| R6-CBT-2 | `TALENTS` / `activeTalents` / `isTalentUnlocked` | `progression.ts:39/89/98` | **部分接**:`isTalentUnlocked` 1 处(`world_sim.ts:2907` 的 `hasDreamTalent`) | 天赋表与解锁判据齐备,但「等级天赋生效」没有施加点 —— `activeTalents` 生产 0;唯一被消费的是**梦境天赋**一条 | WS-10 |
| R6-CBT-3 | 反伤:`reflectDamage` / `reflectFrom` / `reflectFloat` | `damage.ts:456`(第 7 步)· `:506` · `:533` | **未接**(`reflectFrom` 生产 0) | `computeDamage` 算出并上报 `reflectDamage`,但**没有消费者**把它打到攻击者身上;`world_sim.ts:2546-2552` 明写「不擅自扣玩家血」⇒ 反伤只存在于返回值里 | WS-10 |
| R6-CBT-4 | 幽灵态:`tickGhostBubble` / `ghostDamageMul` / `ghostControl` | `revive.ts:171/197/202` | **部分接**:`tickGhostBubble` 2 处(`world_sim.ts` 慢帧) | 泡泡漂移真在推进;但「幽灵态能不能动 / 能不能攻击 / 承受倍率」两个判据函数生产 0 消费者 —— 该语义改由 `applyPlayerMove` / `attackMobAuthorized` 的 `DOWNED` 分支实现 ⇒ **同一规则两个真值来源** | WS-10 · FND-111 |
| R6-CBT-5 | 整蛊菜:`PRANK_PRIORITY` / `cookSoup` / `cleansePrankBuffs` | `cooking.ts:168/368/569` | **部分接**:`cookSoup` 1 处(`net/actions/craft.ts`) | 菜能煮出来,但「整蛊 buff 被清除」生产 0;`PRANK` 分支产物进 buff 合并时与普通菜无区别 | WS-10 |
| R6-CBT-6 | 飘字:`FloatSpec` / `floatText` / `reflectFloat` | `damage.ts:270/310/515` | **未接**(生产 0) | 伤害结果里带完整飘字规格(文本/颜色/缩放),客户端**零读者** ⇒ 数据面已接、表现面未接 | WS-10(仅服务端侧) |

### 2.2 world_sim 的三个喂料口(`server/src/sim/world_sim.ts`)

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-SIM-1 | `startRushRun` | `world_sim.ts:6145` | **未接**(生产调用点 0) | 急单会话的**唯一创建入口**没有调用者 ⇒ `this.rushRun` 恒 `null`,`tickRushOrder` 分支永不执行。急单的算法、结算、河狸计时全绿,但世界里没有"开始"这一下 | WS-11 · FND-61 |
| R6-SIM-2 | `roomLevel` / `stock` 两个必填入参 | `world_sim.ts:6145` | **未接**(来源 0) | 只被 `startRushRun` 消费,而它 0 调用者 ⇒ 无来源;`stallStock`(`:7162`)由装载层写,但从不进急单 | FND-109 · FND-56 |
| R6-SIM-3 | `tended` / `spraying` | `world_sim.ts:6293` / `:6280` | **已接** | 慢帧 `tickPartyStep` 从最近一次翻炒/喷水意图派生工位种类,喂给 `tickRushOrder`(D-13)。★ 但它在喂一个**恒 null 的会话**(见 R6-SIM-1)⇒ 「已接」是就这一口而言,不构成「急单可用」 | FND-61 · FND-109 |

### 2.3 taming(整模块)

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-TAME | `mobs/taming.ts` 全模块(27 export / `PetRecord` / `feedPet` / `deployPet` / `tickRanch` / `carrySpeedMul`) | `server/src/mobs/taming.ts` | **已登记**(文件级):`verify.ts:2086`(可达性) + `verify.ts:5116`(可达/orphan 交叉表) · `orphan-audit.ts:139` | 撰写时生产 `import` = 0,且是**显式回避**(`world_sim.ts:6773` / `systems/wiring.ts:45` 都写着「不 import taming,它是白名单成员」);缺的是**宿主**:22 个动作里没有 TAME / FEED / DEPLOY。★ **收尾复测已变**:`feedPet` 拿到第 1 个生产调用点 ⇒ WS-04 的「生产调用点 0」断言已红,`verify.ts:2086` 那句理由**正在过期** —— 这一行是「登记 → 已接」的过渡态,不是稳定态 | WS-04 · FND-29 · FND-41 · FND-46 |

### 2.4 party 的五个 settle(`server/src/party/modes.ts`)

★ 五条同一成因,**不要当成五条独立欠账**:`settle` 需要一个「本局结束」的调用者,
而 `tickPartyMode`(`modes.ts:181`)到点只发广播、不结算;动作层也没有 END_MODE。

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-PARTY-S1 | `settleBridgeRun` | `modes.ts:281` | **未接**(生产 0) | 见本节成因;`scoring.ts:443` 那处只是**注释**里提到它 | WS-11 · FND-108 |
| R6-PARTY-S2 | `settleJellyBall` | `modes.ts:440` | **未接**(生产 0) | 同上 | WS-11 |
| R6-PARTY-S3 | `settleCrown` | `modes.ts:559` | **未接**(生产 0) | 同上(`scoring.ts:445` 是注释) | WS-11 |
| R6-PARTY-S4 | `settlePaintWar` | `modes.ts:648` | **未接**(生产 0) | 同上(`scoring.ts:446` 是注释) | WS-11 |
| R6-PARTY-S5 | `settleRace` | `modes.ts:721` | **未接**(生产 0) | 同上 | WS-11 |

### 2.5 party 的三个动作

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-PARTY-A1 | `crownPickup` | `modes.ts:508` | **未接**(生产 0) | 拾冠是玩家动作,但 22 个 `RoomAction` 里没有它;`world_sim.ts:137` 已把这一点写在文件头 | WS-11 · FND-108 |
| R6-PARTY-A2 | `bridgeCapture` | `modes.ts:252` | **未接**(生产 0) | 夺旗同族;`world_sim.ts:137` 明写「生产非自身调用点为 0」 | WS-11 · FND-108 |
| R6-PARTY-A3 | `submitDelivery` | `coop/rush_order.ts:1198` | **未接**(生产 0) | 交单是玩家动作,动作层没有 DELIVER;急单因此只能自己超时 | WS-11 · FND-61 |

### 2.6 prank 玩具表

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-PRANK-1 | `PRANK_TOYS` / `toyOf` | `toys.ts:276/284` | **已登记**(文件级,差集型):`verify.ts:2123` | 35 件玩具表 + 6 个结算函数(`resolveBananaSlide:346` / `hitBubble:382` / `resolveSnowball:407` / `applySelfDamage:493` …)生产 0 消费者;唯一生产引用者是 `prank/immunity.ts`,而它自己不可达 ⇒ 按 `isDiffSet()` 归**非欠账**,不是「等接线动作」 | WS-11 |
| R6-PRANK-2 | 缺的那一半:`applyPrank`(施加端) | 全仓不存在 | **未接**(无实现) | 表、免疫、结算都在,但「谁在什么时机把玩具效果打到谁身上」没有任何模块承担;`verify.ts:2123` 的理由已写「等施加整蛊的宿主」 | WS-11 |

### 2.7 social 四段(`server/src/social/afk.ts`;手册 §6.4)

| ID | 段 | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|---|
| R6-SOC-1 | 水族箱 | `VIVARIUM` / `createVivarium` / `tickVivarium` / `WHITE_NOISE_MIX` | `afk.ts:161/205/218/180` | **未接** | 转播镜头序列与白噪音混音表齐备,但镜头要**客户端 renderer**、混音要音频宿主;`boot.ts` 不读 `VIVARIUM`(客户端音频只走 `three/audio_out.ts`) | WS-11 |
| R6-SOC-2 | 信箱 | `createMailbox` / `leaveMail` / `pruneMailbox` / `badgeFor` | `afk.ts:273/278/311/304` | **未接** | 需要「离线玩家存档容器 + 信箱 UI」;`net/room` 的存档只有 world / player 两块,没有第三个容器 | WS-11 |
| R6-SOC-3 | 摊位 | `createStall` / `listItem` / `buyFromStall` / `suggestedPrice` | `afk.ts:350/362/384/355` | **未接** | ⚠️ 与 `world_sim.ts:7162` 的 `stallStock` **同名异义**(那是百货摊位库存,不是玩家摆摊);交易没有动作入口(BUY / LIST 都不在 22 个动作里) | WS-11 |
| R6-SOC-4 | 赛道 | `createTrack` / `trackStart` / `trackFinish` / `trackStandings` | `afk.ts:433/445/458/472` | **未接** | ⚠️ 与 `party/modes.ts:692` 的 `RaceRuntime` 是**两套**赛道运行时(一套社交计时、一套竞技结算),而 party 那套也是 0 生产调用者 ⇒ 同一玩法两份实现、都没接 | WS-11 |

### 2.8 shared(`shared/**`)

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-SH-1 | `EncodeStats`(网络增量那个) | `shared/net/delta.ts:492` | **已登记**(同名异义):`verify.ts:4611` | 与 `build/blueprint.ts:250` 的 `EncodeStats` 只是名字撞了;生产里出现的 2 次全是**蓝图那个** ⇒ 网络编码度量在生产 0 消费者 | WS-07 · FND-99 |
| R6-SH-2 | `StateFlagIndex` | `shared/types/wire.ts:173` | **未接**(生产 0) | 客户端解 `u8` 状态位的第一张词表;`predictor.ts` 只 import `STATE_FLAG_NAMES`(名字表),索引表无人用 ⇒ 状态位解码只做了一半 | WS-07 |
| R6-SH-3 | `FSM_NAMES` | `shared/types/wire.ts:190` | **未接**(生产 0) | 同上:`wildlife.fsm` 的离线索引 0 消费者 | WS-07 |
| R6-SH-4 | `shared/types/events.ts`(整模块) | — | **已登记**(gate-only):`verify.ts:2158` + 交叉表 `:5131` | 29 个事件名的 SSoT;生产侧事件名仍是扁平字符串 ⇒ 接线动作是「换名字来源」,属编排层 | FND-66 |
| R6-SH-5 | `shared/types/cooking.ts` | — | **已登记**(差集型):`verify.ts:2156` | 只被 `shared/constants/cooking.ts` 引用,后者不可达;生产本批只接了 `defFlat` / `expMul`,其余 4 槽等编排层 | FND-66 |
| R6-SH-6 | `shared/constants/cooking.ts` | — | **已登记**(gate-only):`verify.ts:2157` + 交叉表 `:5135` | 6 槽中性值表,生产 importer 0;反向类型引用不算消费 | FND-66 |
| R6-SH-7 | `diffChunkVersions` | `shared/net/delta.ts:877` | **未接**(生产 0) | 按 chunk 版本做差量下发;没有调用者 ⇒ 客户端把每个 chunk 都当新档收。`schema.colyseus.ts:290` 只把 `chunkVersions` 拼成字符串,不做差量 | WS-07 |

### 2.9 client(`client/src/**`)

| ID | 符号 | 位置 | 现状 | 理由 | 判据 |
|---|---|---|---|---|---|
| R6-CL-1 | `renderPos` / `poseView` / `visualOffset` | `net/predictor.ts:206/253/163` | **已接** | `main.ts:441-442` 与 `three/boot.ts:1582` 消费;★ 但 `poseView()` 的 4 个字段里 `logical` / `ackedSeq` 生产 0 读者 —— 「接了这个视图」不等于「视图每一格都被用」 | FND-113 · FND-16 |
| R6-CL-2 | `three/stage_assembly.ts` 的 14 个 export | `three/stage_assembly.ts` | **部分接**:4 个(`buildChunkGeometry:109` / `buildOrthographicCamera:77` / `buildTerrainMaterial:138` / `syncTerrainCamera:151`,`boot.ts:246` 起) | 另 9 个零消费者:`createStage:319` · `buildShaderMaterial:186` · `buildPixelTexture:227` · `buildBillboard:239` · `attachAuraEmitters:255` · `applyDyeUniforms:285` · `gridToVector3:343` · `projectedToVector2:354` · `assemblySource:164` ⇒ 立牌/粒子/染色/拾取投影都还没有渲染入口 | WS-09 · FND-73 · FND-89 |
| R6-CL-3 | `DragController.drop()` | `ui/state_machine.ts:301` | **未接**(生产 0) | `boot.ts` 只用 `pickUp`(:983/1100)/ `hoverAt`(:984/1141)/ `isDragging`(:1038)/ `cancel`(:1159)⇒ 拖拽能拿起、能高亮,**松手走 cancel** ⇒ 永远放不下;`drop()` 的 `{fromSlot,toSlot}` 契约零调用者 | WS-09 |
| R6-CL-4 | `slotTooltip` → `tooltipFor` | `ui/inventory.ts:410` · `three/ui_binding.ts:618` | **未接**(`tooltipFor` 生产 0) | 文本能从 inventory 取,但 Canvas2D 覆盖层不接 hover 事件 ⇒ 没有呈现面 | WS-09 |
| R6-CL-5 | `isoCam.zoom` / `snapZoom` / `stepZoom` / `ZOOM_LEVELS` | `stage/iso_camera.ts:65/283/297/98` | **未接**(`stepZoom` 生产 0) | 6 档缩放表与吸附逻辑齐备,但没有任何输入绑定 ⇒ 生产 `zoom` 恒 1(`:115`),只有测试会调 `stepZoom` | WS-09 |
| R6-CL-6 | `#hint` 提示条 | `client/index.html:24/49` · `ui/panel_layout.ts:330` | **未接** | 元素在 DOM 里,代码**从不读它**:面板只是把 `PITCH_BOTTOM_CLEARANCE = 56` 写死(注释自称「让开 `#hint`」)⇒ 改字号/换文案不会重排,56 也是猜的 | WS-09 |

### 2.10 汇总(按「现状」)

| 现状 | 条数 | 其中含「未接」的 | 说明 |
|---|--:|--:|---|
| 已接 | 2 | 0 | R6-SIM-3(喂料口)· R6-CL-1(renderPos 系列) |
| 已登记 | 6 | 0 | R6-TAME · R6-PRANK-1 · R6-SH-1/4/5/6(4 条) |
| 部分接 | 5 | 5 条都同时列出未接的那一半 | R6-CBT-2/4/5 · R6-CL-2 |
| 未接(符号级,门禁看不见) | 20 | 20 | CBT-1/3/6 · SIM-1/2 · PARTY-S1..S5/A1..A3 · PRANK-2 · SOC-1..4 · SH-2/3/7 · CL-3/4/5/6 |
| **合计** | **34** | **25** | 25 = 20 全未接 + 5 部分接 |

★ 这 25 条**不进任何现有分母**:`生产可达性 134/146` 是**文件级**,这 25 个符号所在的文件大多**可达**;

---

## 3 如何被门禁引用(按粒度选,别混用)

本台账自己**不参与** `verify.ts` 的退出码。要让某条变成机器钉住的事实,只有三条路,
粒度由「不可达的单位是文件还是符号」决定:

### 3.1 文件级 —— 整个模块不可达 ⇒ `verify.ts::UNREACHABLE_EXEMPT`

```ts
// scripts/verify.ts:1867(可达性白名单)
['server/src/mobs/taming.ts',
  'WS-04 牧场驯服,等宠物容器 + 驯服交互(feedPet 零生产调用);'
  + '逐符号现况见 docs/WIRING-LEDGER.md#r6-tame'],
```

同时**必须**在交叉表(`scripts/verify.ts:5116`)同改,否则 `checkOrphanList` /
`checkWhitelistCross` 两面互不认账。两处都改完的形态见 `taming` 的现成样板。

### 3.2 符号级 —— 文件可达、只有这个符号没人调 ⇒ `scripts/deadcode-audit.ts`

```ts
// scripts/deadcode-audit.ts:261 KNOWN_BACKLOG(按符号名匹配)
{ symbol: 'crownPickup',
  ledger: 'WIRING-LEDGER.md#r6-party-a1',
  reason: '已知未接:唯一调用者是测试;生产 0 调用点(world_sim.ts:137 明写)。'
        + '接线点在动作层(22 个 RoomAction 里没有拾冠),不在 sim。' },
```

匹配口径是 `symbol.split('::').pop()`(`deadcode-audit.ts:285`)⇒ **同名函数会被一起归并**,
登记前先 `Select-String -Pattern '^\s*(export )?function crownPickup' -Path (server,client)` 确认只有一个。
若整文件都是「刻意不驱动」,用 `DELIBERATE_EXCLUSIONS`(`:228`)的 `target: 'file::symbol'`。

### 3.3 死道具形状 —— 要写「缺什么」+「消费点是否存在」⇒ `scripts/dead_items.ts`

```ts
{ id: 0, name: '…', implemented: false, consumer: null,
  reason: '使用入口已接(…),仍缺:…(≥20 字,不许 TODO 开头)' }
```

判据是 `reasonVerdict()`(`dead_items.ts:74`,拒空 / 拒 <20 字 / 拒 `todo|tbd|待办|待补|以后再说` 开头)
与 `consumerVerdict()`(`:92`,出现的每个 `*.ts` 路径**必须真的存在**)。
⇒ 本台账「位置」列里的路径可直接抄进 `consumer`;「理由」列可直接抄进 `reason`
(每行都过了那两条判据的字面要求)。

### 3.4 引用时的四条硬约束(踩过)

```
1 理由文本会被 WL_* 裸正则**自动分桶**(verify.ts:2210-2513):
    命中「待接 / 等编排层接线 / 待客户端接线」        ⇒ 等编排层接线
    命中「随…接 / 尚未注入 / 被…聚合 / 等…(层|容器|线|运行时|宿主|驱动|管线)」 ⇒ 等机制
    命中「本仓无装配入口 / 客户端子系统」            ⇒ 等客户端入口
    ⇒ 想换桶就**改措辞**,不要改台账(台账是事实,桶是分类)。
2 理由里**禁止**出现「差集」二字:WL_NON_DEBT_DIFF_TEXT 是裸正则,且
    verify.ts:3267 会拿它和**计算式 isDiffSet()** 做双向自检 ——
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
> 「全绿」在第六轮被证明**不足以**支撑任何一句「可用」:上表 25 条未接里,
> 有 12 条**所在文件是可达的**、判据全过、`verify.ts` 全绿 —— 它们只是没有第二个调用者。
> ⇒ 以后写「X 可用」之前,先回答「X 的生产非自身调用点是多少」;答不出就不是可用,
> 是**已实现**。这两个词的差别是本轮唯一新增的判据纪律。

---

## 5 下一处接线点(按代价升序,不是排期)

```
1 R6-CL-3 drop():boot.ts 的鼠标松开分支从 cancel() 改成 drop()+提交(单文件、无新依赖)
2 R6-CL-5 stepZoom:绑滚轮/捏合(纯客户端)
3 R6-CL-6 #hint:改成读元素高度,把 56 从常量降为下限
4 R6-SIM-1 startRushRun:动作层加 START_RUSH(需先裁 roomLevel/stock 来源,见 SIM-2)
5 R6-TAME:宠物容器 + TAME 动作(牵动存档结构,最后做)
```