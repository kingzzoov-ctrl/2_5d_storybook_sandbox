# 守卫契约:28 个「上界由调用方保证」的逐条出处

> **任务**:task-56 · **作者**:`client-stage`(WS-09 客户端渲染与 UI 作者)
> **动机**:`net-persist` 的 `docs/GUARD-AUDIT.md`(task-53)§2 把 48 个函数分四类,
> 其中 28 个判「**上界由调用方保证**」。**但那张表只说了「由调用方保证」,
> 没说清是哪个调用方、在哪一行钳的** —— 因而不可复核。
> 本文件逐条补上 `file:line` 级的出处。
>
> **纪律**:本文件为**只读补充**,不改任何 `server/**` `client/**` `shared/**` `tests/**` `scripts/**`。
> **标注约定**:「**实测**」= 实跑探针、附可复现命令;「**读码**」= 静态读源码;「**未实测**」= 未验证。
> **前作**:`docs/GUARD-AUDIT.md`(task-53)。

---

## 0. 一句话结论

**`GUARD-AUDIT` 的「规则盲区」判断成立,且我实测确认;但它把
`carryCapacityOf` 归为「第二个真缺口」这一定性不成立 —— 而**不成立的理由与 Lead 给的也不完全一样**。**

| 命题 | 谁说的 | 我的独立复核 |
| :--- | :--- | :--- |
| 规则只扫 `export function` ⇒ 类方法零命中 | `GUARD-AUDIT` §4.2 | **成立** —— 实测 `carryCapacityOf` 不在 `export function` 名单内 |
| 因此 `carryCapacityOf` 是「漏报」 | `GUARD-AUDIT` §4.2 | **成立**(「规则看不见它」是事实) |
| **但它是「真缺口」** | `GUARD-AUDIT` §0/§4.2 | **不成立**(见 §2) |
| 它是「契约型风险,不是真缺口」 | Lead(task-56) | **结论正确**,但**理由需要修正**(见 §2.3) |
| 上界来自 `db/repo.ts:246` 的 `clampInt` | Lead | **不成立** —— 那是 **DB 行**的钳制,与 `carryCapacityOf` **不在同一条数据流上** |

**⇒ 两边各有对错,不是一边全错。** 详见 §2。

---

## 1. 28 条「上界由调用方保证」的上界来源

### 1.1 怎么读这张表

`GUARD-AUDIT` §2 的定性是「上界由谁负责」。本表把它展开成三层:

| 列 | 含义 |
| :--- | :--- |
| **钳制点** | **真正做上界限制的那一行**(`file:line` + 表达式)。**这是本文件存在的理由** |
| **调用链** | 从生产入口到该函数实参的路径。**格式:`入口 → … → 实参来源`** |
| **可复核性** | `强` = 钳制点有常量/字面量可查;`弱` = 靠"当前内容表恰好没超";`无` = **找不到任何钳制点** |

**探针自证**(先证明探针能看见,再报数;这是本仓纪律):
```
自证 1  carryCapacityOf  命中 2 处:server/src/net/room.ts:672(CALL) + 同文件 :745(DEF)   ✓
自证 2  computeSlotLayout 命中 2 处:client/src/ui/inventory.ts:81(DEF) + 同文件 :112(CALL)      ✓
阴性   zzzNotAFunctionAtAll 命中 0 处                                        ✓
三项全过才采信下表。
```
探针:`_gc_callsites.ts`(已删),扫描面 = `server/src` + `client/src` 共 **83** 个 `.ts`。

### 1.2 server 侧(9 条)

> ⚠️ **路径一律写根相对全路径,不用 basename。** 理由:本仓有 **2 组重名** ——
> `blueprint.ts` = `server/src/build/blueprint.ts` | `client/src/ui/blueprint.ts`;
> `grid.ts` = `server/src/build/grid.ts` | `server/src/world/grid.ts`。
> 只写 `blueprint.ts:446` **是无法复核的**(说的是哪一份?)。这是我在校验时实测抓到的。

| # | 函数 | GUARD-AUDIT 位置 | **钳制点(全路径 `file:line` + 表达式)** | **调用链** | 可复核性 |
| --: | :--- | :--- | :--- | :--- | :--- |
| 8 | `paintRadius` | `server/src/party/scoring.ts:287` | **`server/src/party/modes.ts:574`** `export const PAINT_BALL_RADIUS = 1` ⇒ 唯一生产调用传的就是它 | `server/src/party/modes.ts:611` → `paintRadius(r.grid, x, y, PAINT_BALL_RADIUS, team)` | **强** |
| 9 | `flightDurationMs` | `server/src/build/blueprint.ts:443` | **`server/src/build/blueprint.ts:446`** `Math.round(raw / Math.max(0.1, buildSpeedMul))`(只有**下界**);`dist` 上界**无钳制点** | 调用在 `server/src/build/blueprint.ts:513`;`dist` 在 **`:512`** `Math.abs(b.x-t.lx)+Math.abs(b.y-t.ly)` | **弱** |
| 13 | `secondsToTicks` | `server/src/wiring/graph.ts:28` | **`server/src/wiring/components.ts:33`** `RELAY_DELAY_SECONDS = Object.freeze([0.2,0.5,1.0,2.0])` + **`:41`** `PULSE_BUTTON_SECONDS = 0.5` | `server/src/wiring/components.ts:37` `.map(s => secondsToTicks(s))`;`:42` `secondsToTicks(PULSE_BUTTON_SECONDS)` | **强** |
| 14 | `ticksFor` | `server/src/wiring/logistics.ts:24` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 16 | `stampBoxRoom` | `server/src/build/rooms.ts:536` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 19 | `mergeFoodBuffs` | `server/src/combat/cooking.ts:479` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 20 | `planSkillHits` | `server/src/combat/damage.ts:593` | **内容表** `SkillDef.hits`;生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 21 | `suggestedPrice` | `server/src/social/afk.ts:355` | **内容表** `def.value`;生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 22 | `stepArm` | `server/src/wiring/logistics.ts:286` | **`server/src/sim/world_sim.ts:2557`** `reach: 3`(字面量) | `server/src/wiring/logistics.ts:592` `stepArm(a.state, world, a.x, a.y, powered.arm)` ← `a.state.reach` | **弱** |

> **#14/#16/#19/#20/#21 的「由调用方保证」是空话**:生产调用 0 处 ⇒ **没有调用方**。
> `GUARD-AUDIT` 已把「生产调用数」单列一栏(这是它做对的地方),此处只是指出:
> 这 5 条的「保证」当前**无主体**。等接线时须重新判定,不能沿用。

### 1.3 client 侧(19 条)

| # | 函数 | GUARD-AUDIT 位置 | **钳制点(全路径 `file:line` + 表达式)** | **调用链** | 可复核性 |
| --: | :--- | :--- | :--- | :--- | :--- |
| 23 | `maxSpeed` | `client/src/net/prediction.ts:65` | **`server/src/net/anticheat.ts:33`** `MAX_SPEED_BONUS_MUL = 2.55` → `sanitizeMul`(同文件 `:164`);客户端侧**无**钳制 | `client/src/net/prediction.ts:79` `maxSpeed(params.speedMul ?? 1)` | **弱**(客户端无钳,靠服务端兜) |
| 25 | `quadIndexBuffer` | `client/src/stage/assembly_math.ts:107` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 26 | `dyeCost` | `client/src/stage/dye_overlay.ts:342` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 27 | `spriteHeightPx` | `client/src/stage/entity_sprites.ts:76` | **`client/src/stage/entity_sprites.ts:78`** `base * Math.max(0.1, bodyScale)`(只有**下界**);上界**无** | 生产调用 0 处 | **弱**(不可达) |
| 28 | `createCamera` | `client/src/stage/iso_camera.ts:85` | **`window.innerWidth` / `window.innerHeight`**(浏览器保证有限正整数) | `client/src/three/boot.ts` 的 `:148` `:829` `:907` `:990` + `client/src/three/stage_assembly.ts:253` = **5** 处生产调用 | **强**(viewport 天然有限) |
| 29 | `viewBounds` | `client/src/stage/iso_camera.ts:167` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 30 | `followCamera` | `client/src/stage/iso_camera.ts:231` | **`client/src/stage/iso_camera.ts:220`** `function clampToBand(v, lo, hi)`,应用点同文件 **`:252`/`:253`**;生产调用 0 处 | 无 | **弱**(不可达) |
| 31 | `emitBurst` | `client/src/stage/particles.ts:328` | **`BurstConfig.count`**(特效配置);生产调用 0 处 | 无 | **无**(但不可达) |
| 33 | `buildRoofMask` | `client/src/stage/roof_transparency.ts:54` | **`world.width/height`**(世界尺寸,`RoofMask.W`) | `client/src/stage/roof_transparency.ts:295`、`client/src/three/boot.ts:537`、`:1200` 共 **3** 处 | **强** |
| 34 | `rawWorstFaceCount` | `client/src/stage/tile_mesh.ts:364` | **无** —— 生产调用 0 处;名字即「最坏情况估算」 | 无 | **无**(但不可达) |
| 35 | `clampCellRange` | `client/src/ui/blueprint.ts:117` | **★ 函数自身**:默认参 `maxCells = MAX_SELECT_CELLS`(`client/src/ui/blueprint.ts:117`),**`:23`** `MAX_SELECT_CELLS = 64*64`;**上界由分支实现**:同文件 **`:126`** `cap = Math.max(1, Math.trunc(maxCells))`、**`:127`** `if (w*h <= cap) return`、**`:130`** `side = Math.max(1, Math.floor(Math.sqrt(cap)))`(非 `Math.min`) | `client/src/three/boot.ts:911` `clampCellRange(world)` | **强**(但被规则误报,见 §4) |
| 41 | `computeSlotLayout` | `client/src/ui/inventory.ts:81` | **`client/src/ui/inventory.ts:112`** 唯一生产调用传 `INVENTORY_LAYOUT` 常量 | 同文件 `:112` `export const INVENTORY_LAYOUT = computeSlotLayout(...)` | **强** |
| 42 | `slotRect` | `client/src/ui/panel_layout.ts:130` | **`client/src/three/ui_binding.ts:298`** `indexInPage` 来自翻页循环(受 `SLOTS_PER_PAGE` 约束) | 同文件 `:298` `slotRect(L, i)` | **强** |
| 43 | `indentRecipeRows` | `client/src/ui/panel_layout.ts:209` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 44 | `layoutEaselPanel` | `client/src/ui/panel_layout.ts:236` | **`client/src/three/ui_binding.ts:373` / `:584`** 传 `this.w` / `this.h`(viewport) | 同文件 `:373`、`:584` | **强** |
| 45 | `layoutPitchPanel` | `client/src/ui/panel_layout.ts:332` | **`client/src/three/ui_binding.ts:204`** `layoutPitchPanel(w, h)`(viewport) | 同文件 `:204` | **强** |
| 46 | `tilePattern` | `client/src/ui/pixel_easel.ts:334` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |
| 47 | `buildRecipeTree` | `client/src/ui/recipe_tree.ts:87` | **`client/src/ui/recipe_tree.ts:44`** `MAX_DEPTH = 8`(默认参 `maxDepth = MAX_DEPTH`);`depthLimit` 有下界 1 | `client/src/three/boot.ts:459` `buildRecipeTree(RECIPE_ID, RECIPE_BATCHES)` | **强** |
| 48 | `scaleLeaves` | `client/src/ui/recipe_tree.ts:243` | **无** —— 生产调用 0 处(实测) | 无 | **无**(但不可达) |

### 1.4 汇总

| 可复核性 | 条数 | 编号 |
| :--- | --: | :--- |
| **强**(钳制点是常量/字面量/viewport) | **10** | 8 13 28 33 35 41 42 44 45 47 |
| **弱**(只有下界 / 靠服务端兜 / 钳制点在别层) | **4** | 9 22 23 27 |
| **无**(生产调用 0 处,「调用方」不存在) | **14** | 14 16 19 20 21 25 26 29 30 31 34 43 46 48 |
| **合计** | **28** | |

> **这张表相对 `GUARD-AUDIT` 多出来的信息**:28 条里只有 **10 条**的「上界来源」
> 真的能指到一个常量或一个字面量。**另外 4 条只有下界,14 条根本没有调用方。**
> ⇒ 「由调用方保证」这个定性对 **18/28 条(64%)** 是**空的**。
> 这不是说 `GUARD-AUDIT` 错了 —— 它的定性口径是「当前不构成缺口」,那个口径下这些都能过关;
> 但「上界由调用方保证」**字面上被读成了「有个地方钳住了」,而实际有大半没有这个「地方」**。

---

## 2. ★ `carryCapacityOf`:契约型风险,不是真缺口

### 2.1 `GUARD-AUDIT` §4.2 的原话

```ts
// server/src/net/room.ts:745
carryCapacityOf(userId: string): number {
  const lv = this.state.players.find((p) => p.id === userId)?.level ?? 1;   // :746
  return 8 + (lv - 1);                                                      // :747
}
```

`GUARD-AUDIT` §4.2 据此写:
> **「规则只扫 `export function`,类方法整个不扫」** ⇒ `carryCapacityOf` 零命中
> ⇒ 「这是最严重的一条漏报:它漏的正是**本仓已确认的真缺陷**」

**⇒ 「规则盲区」这一半我实测确认成立:**
```
export function 名单里是否有 carryCapacityOf:否   (实测,83 个生产 .ts 扫描)
```

### 2.2 我的实测:函数本身确实无上界

```ts
// 探针 _gc_carry.ts(已删);阴性对照见下
level 输入 →  carryCapacityOf 返回
  1        →  8
  30       →  37          ← MAX_LEVEL
  31       →  38          ★ 越过上界
  100      →  107         ★
  1e6      →  1000007     ★
  1e9      →  1000000007  ★
  NaN      →  NaN         ★
  Infinity →  Infinity    ★
  -Infinity→  -Infinity   ★
  1e308    →  1e308       ★
  0.5      →  7.5         ★(不做整数截断)
  -5       →  2
```

**阴性对照(必须先过,否则说明探针没接上)**:
```
level=5 → carryCapacityOf = 12  (期望 8+(5-1)=12)   ✓ 通过
```

**与冻结层的分歧**(`statsAtLevel` 在 `shared/types/entities.ts`,`MAX_LEVEL=30`):

| level | `carryCapacityOf` | `statsAtLevel(lv).carrySlots` | 一致? |
| --: | --: | --: | :--- |
| 1 | 8 | 8 | 一致 |
| 5 | 12 | 12 | 一致 |
| 30 | 37 | 37 | 一致 |
| **31** | **38** | **37** | ★ **分歧** |
| **100** | **107** | **37** | ★ 分歧 |
| **1e6** | **1000007** | **37** | ★ 分歧 |
| **NaN** | **NaN** | **NaN** | ★ 分歧 |
| **Infinity** | **Infinity** | **37** | ★ 分歧 |
| **-5** | **2** | **8** | ★ 分歧 |
| **0.5** | **7.5** | **8** | ★ 分歧 |

**⇒ 函数本身确实没有上界,且与冻结层口径分歧。这一半 `GUARD-AUDIT` 是对的。**

### 2.3 ★ 但「真缺口」这个定性不成立 —— 理由与 Lead 也不同

**Lead 的判据是「上界由 `db/repo.ts:246` 保证」。我实测认为这条不成立**,因为
**`server/src/db/repo.ts:246` 钳的是 `users` 表那一行,而 `carryCapacityOf` 读的是 `state.players[]` —— 两者不是同一条数据流。**

```ts
// server/src/db/repo.ts:237 savePlayerState —— 钳 DB 行
if (next.level !== undefined) next.level = clampInt(next.level as number, 1, MAX_LEVEL, 'level');  // :246
//   但 room.ts 全文**没有** import updateUser/savePlayerState,也没用 getUser().level 回填 state

// server/src/net/room.ts:446 —— 建 state.players[] 那一行,**不传 level**
this.state.players.push(createPlayerState(input.userId, { name, x, y, z }));
//   server/src/net/schema.ts:59 createPlayerState 的默认 level 是 1(:63);...patch 在后本可覆盖,但这里没传
```

**实测四条**(探针 `_gc_level.ts`,已删):

```
1 报文能改 level 吗?
   往 applyMove 塞 level:99  → level 仍是 1   ✓ 未被采纳
   往 applyInventory 塞 level:99 → level 仍是 1   ✓ 未被采纳

2 新玩家 join 后 level?
   u2 join → level=1, capacity=8   (createPlayerState 默认值,非从 DB 读)

3 room.ts 里 level 的写点有几个?
   全文含 "level" 的非注释行:**1 行**(server/src/net/room.ts:746,只读)
   赋值行(= 写):**0 个**

4 能改坏吗?(绕开一切报文路径,直接改 state)
   level=30 → 37   level=31 → 38   level=99 → 106
   ⇒ 能改坏,但**必须先拿到 `state` 的引用**,而报文路径拿不到
```

**⇒ 真正的判定依据不是「repo.ts 钳了」,而是:**

| # | 判据 | 结论 |
| --: | :--- | :--- |
| 1 | 上界来自外部输入吗? | **否**。`applyMove`/`applyInventory` 的报文**结构里没有 level**,实测塞不进去 |
| 2 | 函数自己钳吗? | **否**。`room.ts` 全文不含 `MAX_LEVEL`(实测),自己不钳 |
| 3 | 生产里 `level` 会被抬离 1 吗? | **不会**。`server/src/net/room.ts:446` 不传 level ⇒ 恒为 `createPlayerState` 默认的 1;`room.ts` 无一处置位 |
| 4 | 危害半径? | 即使改坏:level=30 ⇒ 37 格;`Infinity` ⇒ `Infinity` 格(不崩,但容量无意义) |

**⇒ 定性:「上界由**当前无写入路径**保证」,而不是「由 `repo.ts` 保证」。**
**这是「不可达」,不是「缺口」。** `GUARD-AUDIT` 定为「真缺口」不成立。

### 2.4 那「契约型风险」体现在哪(这是真问题)

`RoomRuntime` 与模拟层的**成长系统互不相识**:

```ts
// server/src/net/room.ts:275(作者自己写的)
* `RoomRuntime` 至今**不认识**模拟层(US2「room 持有 sim」仍未开)。
// server/src/net/room.ts:283-284
* ⚠️ 注意:本文件**有意不出现**模拟层的类型名 —— 一旦这里 import 了它,
* US2 才真的变成过时条目(`scripts/backlog.ts` 的 US2 探针正盯着本文件)。
```

而**真正的等级成长活在 `WorldSim` 里**:
```ts
// sim/world_sim.ts:518
private readonly progresses = new Map<string, PlayerProgress>();   // ← 这才是"玩家等级"
// :1650 createProgress(id) / :1670 applyShareResult(:407 gainExp :186 升级) —— 全部在 sim 层
```

**⇒ 也就是说:`state.players[].level` 与 `WorldSim.progresses[].level` 是两份独立的等级,**
**后者才是玩家真实的等级,而 `carryCapacityOf` 读的是前者(恒 1)。**

**这才是真正的风险,而且它比「缺上界」严重:**

| 风险 | 说明 |
| :--- | :--- |
| **R1 容量恒为 8** | 玩家升到 30 级,`carryCapacityOf` 仍返回 **8**,而预期是 **37** ⇒ **容量不随等级成长** |
| **R2 两套等级并存** | `RoomRuntime` 与 `WorldSim` 各存一份,US2 接线时若只接 `saveToDb` 而不接等级同步,两份会**静默分叉** |
| **R3 一旦接上即变真缺口** | US2 一旦把 sim 的 level 写进 `state.players[].level`,**`carryCapacityOf` 立刻变真缺口**(它自己不钳,而那时 level 会真的 >30) |

> **⇒ 这三条中,R2/R3 是我在 Lead 的四条判据之外补的,也是「契约型风险」这个定性的真正依据。**
> **R1 我要标「未实测到端到端」**:我只证明了 `state.players[].level` 恒 1、
> `carryCapacityOf` 读它;我**没有**跑一个真实升级流程去观察容量是否卡在 8
> (那需要 `WorldSim` + `RoomRuntime` 处于同一进程且等级已接线,而 US2 未开)。

### 2.5 与 `GUARD-AUDIT` §4.2 的显式对齐

| 命题 | 判定 | 依据 |
| :--- | :--- | :--- |
| 规则只扫 `export function`,类方法零命中 | **成立** | 实测 `carryCapacityOf` 不在 `export function` 名单 |
| `carryCapacityOf` 因此是「规则盲区」 | **成立** | 同上 |
| 它有「无上界」的代码形态 | **成立** | §2.2 实测表(12 点) |
| 它与冻结层 `statsAtLevel` **口径分歧** | **成立** | §2.2 分歧表(6/10 点分歧) |
| **它是「第二个真缺口」** | **★ 不成立** | §2.3 判据 3:生产里 `level` 恒 1,报文塞不进去 ⇒ 不可达 |
| 上界由 `server/src/db/repo.ts:246` 保证(Lead) | **★ 不成立** | §2.3:`server/src/db/repo.ts:246` 钳 DB 行,与 `state.players[]` 不同数据流;`room.ts` 不 import 该写者 |
| 它是「契约型风险」(Lead) | **结论成立,理由需修正** | 真正依据是 `server/src/net/room.ts:275` 明写「不认识模拟层」+ 两套等级并存(§2.4),不是 repo 钳制 |

**⇒ 一句话对齐:`GUARD-AUDIT` 的「规则盲区」判断**成立且重要**;
「缺口定性」**不成立**(应为不可达/契约风险);
Lead 的「契约风险」**结论对**,但把它归因到 `server/src/db/repo.ts:246` **归错了数据流**。**

---

## 3. 为什么不按 Lead 建议加钳(加固未做)

Lead 提议在 `server/src/net/room.ts:746` 加钳 + 注释「为何重复钳」。**我判断不加,理由三条:**

1. **`room.ts` 是 `net-persist` 的写域**(task-47/US2)。开工前实测 `git status`
   显示 `room.ts` 当前**未被修改**,但它随时会动 ⇒ 我改动会与他冲突。
2. **现在加钳是「给一个恒为 1 的值加上界」** —— 按 §2.3,`level` 在生产里恒 1,
   加 `Math.min(MAX_LEVEL, ...)` 是**惰性的**(任务书里 J13 形态:重复钳 + 第二份失效)。
   **加一段永远不生效的代码,比不加更糟** —— 下一个人会以为这里已经有保护。
3. **真正该做的是接等级,不是加钳。** 加钳只掩盖 R1(容量恒 8),不解决它。

**⇒ 建议另立任务(等 US2 接线时一起做),内容应是:**
```
1 让 sim 的 level 成为 state.players[].level 的唯一写入源(接线本身)
2 接线同时给 carryCapacityOf 加上界(那时它才不是惰性的)
3 加断言:level=30 ⇒ 容量 37;level=31(伪造) ⇒ 容量 37 且记违规
4 加断言:升级后容量真的变化(钉住 R1,防"接了两套等级")
```
**若 Lead 坚持现在就加,我按指示执行;但我会在注释里写明「当前惰性,US2 接线后才生效」。**

---

## 4. ★ 一处我要替 `GUARD-AUDIT` 说清的话

Lead 让我「不要因为纠正了一处就否定整份审计」。**我同意,而且这里有具体证据:**

| `GUARD-AUDIT` 的判断 | 我的复核 |
| :--- | :--- |
| §4.1 `clampCellRange` 是**误报**(上界用分支实现) | **成立**。实测 `client/src/ui/blueprint.ts:117`:`maxCells=64*64` 默认,`if (w*h <= cap) return` + `side = floor(sqrt(cap))` ⇒ 上界完整,只是不用 `Math.min` |
| §4.3 放宽成「有 `Math.max` 就算钳过」会漏掉 `mobHitDamage` | **成立**。它确实有两处 `Math.max` 且都只是下界 |
| §2.3 自己纠正了手数分布(2/20/16/10 → 2/28/13/5) | **方法正确**:派生数字由探针复算 |
| §7.5 自列 6 个错(含 `*=`) | **诚实留痕**,这在本仓是硬要求 |
| §5.2 「查参数来源而非 Math 调用」,信噪比 100% | **方向正确**,且他自己说清了「需跨文件污点分析,ROI 不成立」—— **这个 self-limiting 判断比多报一条缺口更有价值** |

**⇒ 本文件的定位是「补 §2 的出处」+「纠正 §4.2 的一处定性」,
不是重做审计。`GUARD-AUDIT` 的两条真缺口(`mobHitDamage` / `checkMove`)
我没有独立复核(不在本任务范围),也未发现与之矛盾的证据。**

---

## 5. 未实测项(单列,不得当结论)

| # | 项 | 为什么未实测 |
| --: | :--- | :--- |
| C1 | 玩家真实升级后容量是否卡在 8(§2.4 R1) | 需 `WorldSim` + `RoomRuntime` 同进程且等级已接线;US2 未开,无法端到端跑 |
| C2 | `state.players[].level` 是否**任何**写入路径(含未来) | 我只扫了 `server/src` 现有 83 个 `.ts`;新增代码可能引入写点 |
| C3 | `WorldSim.loadFromDb` 是否会把 DB 的 level 灌进 `state.players[]` | 读码显示 `loadFromDb` 作用于 sim 内部,未逐行验证 |
| C4 | 28 条里标注为「强」的 10 条,钳制常量是否**不会被内容表更新掉** | 我核的是当前值与调用点,未做「未来内容表改动」的敏感性分析 |
| C5 | 「规则只扫 `export function`」的次数(`GUARD-AUDIT` 报 841 / 不扫 95) | **我两次测出不同结果,故只报口径不报单值。** 第一版缩进正则过宽,得「类方法 1691」——**明显错误,已弃用**;收紧到「只在 `class` 块内、且排除函数体内的缩进」后得:`export function` **844**、顶层非导出 function **95**、类方法 **90**(扫描面 `server/src`+`client/src`,83 个 `.ts`)。<br>⇒ **`export function` 844 vs 841 差 3**,`room.ts`/`world_sim.ts` 正被并发编辑,**我判为行数漂移,不是口径分歧**。⇒ 「不扫 95」与我的「顶层非导出 95」**数值吻合**,但它是否包含那 90 个类方法无法从 `GUARD-AUDIT` 的措辞判定 ⇒ **标未实测**。<br>**关键**:§2.1 那条结论(「`carryCapacityOf` 不在 `export function` 名单」)用的是**名单成员测试**,与上述计数无关,不受此影响。 |
| C6 | `mobHitDamage` / `checkMove` 两条真缺口 | 不在 task-56 范围;未独立复核 |

---

## 6. 复现方式

```powershell
# 调用点扫描(含三项自证,自证不过则结果不可信)
node _gc_callsites.ts

# carryCapacityOf 的 12 点实测表 + 阴性对照(level=5 → 12)
node _gc_carry.ts

# vs 冻结层 statsAtLevel 的分歧表
node _gc_carry2.ts

# 报文能否改 level / room.ts 有几个 level 写点
node _gc_level.ts
```
**以上 4 个探针均为临时文件,已删除。** 扫描面:`server/src` + `client/src`,共 83 个 `.ts`。

**行号漂移提示**:`room.ts` / `world_sim.ts` 正被并发编辑。本表所有条目已同时给**函数名**
(可用 `grep "function <name>"` 或 `grep "<name>("` 反查),不依赖行号。