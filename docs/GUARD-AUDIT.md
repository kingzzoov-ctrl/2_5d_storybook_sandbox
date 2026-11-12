# 守卫单向性审计 —— 48 个「有 Math.max 无 Math.min」函数逐条定性

> **任务**:task-53 · **作者**:`net-persist`(`server/src/net/**` 作者,`docs/AUTHORITY-MAP.md` 作者)
> **读取时刻**:2026-11-12 19:40–19:50(+08:00)
> **纪律**:本文件为**只读审计**。未修改任何 `server/**` `client/**` `shared/**` `tests/**` `scripts/**`。
> **标注约定**:「**实测**」= 实跑探针、附可复现命令;「**读码**」= 静态读源码;「**未实测**」= 未验证。
> **前作**:`docs/AUTHORITY-MAP.md`(task-49),本文件是其「单向守卫」发现的展开。

---

## 0. 一句话结论

**这个形状值得查,但不是以 Lead 设想的那 43 个的方式。**
真正的问题不是「43 个里有 1 个真缺口」,而是**规则的命中精度太差**:
它既**漏掉**已确认的真缺陷(类方法里的 `carryCapacityOf`),又**误报**已完整钳制的函数
(`clampCellRange` 用分支实现上界)。

**而我在 48 个里找到 2 个真缺口,其中 1 个是本次审计最重要的发现:**

> **`checkMove` 的 `dtTicks = Math.max(1, intent.tick - s.lastTick)` 无上界,
> 而 `intent.tick` 直接来自网络报文 ⇒ 客户端**一条报文**即可让反作弊完全失明,
> 并让服务端接受伪造坐标、写入权威状态、广播给所有人。**

这是 `anticheat.ts` 本身,**不是** `mobHitDamage` 那种「统计字段吸收荒谬值」——
它的危害比后者严重一个量级。

---

## 1. 我的扫描范围与「43 复现不出来」的诚实交代

### 1.1 复现结果:我得 37 / 48,Lead 报 43

| 读法 | 规则 | 命中 |
| :--- | :--- | ---: |
| **A 严格** | `Math.max>0` ∧ `Math.min==0` ∧ (纯乘号 `*` 或 `Math.round`) | **37** |
| **B 含 `*=`** | 同上,+ 复合赋值 | 38 |
| **C 宽** | `Math.max>0` ∧ `Math.min==0` ∧ (出现 `*` / `/` / `%` 或 `Math.round`) | **48** |
| D 只要出现 `*` `/` `%` | | 48 |

**⇒ Lead 的 43 落在 A(37)与 C(48)之间,我没能复现出他那一个精确读法。**

**但这不是推诿 —— 我做了两件事来保证覆盖面:**

1. **Lead 列的 16 个样本在 C 读法下命中 16/16**(实测,零遗漏)
2. 我**按 C(48 个)全部逐条定性** ⇒ **48 ⊇ 43**,不会因读法差异漏掉 Lead 关心的任何一条

**⇒ 本文件的表是 48 行,不是 43 行。多出的 5 条是 C 读法相对 A 的差集,已一并定性。**

### 1.2 探针自证(纪律 3)

我的第一版探针**没能通过自证**,这是它不可信的证明:

```
识别 export function:     841 个   (Lead 报 843)
已知必在名单的 16 个:     命中 12/16   ← **失败**
漏:contentCapacity, mergeFoodBuffs, stampBoxRoom, applyWeightShift
```

**根因**:我的「含乘法」正则 `\w\s*\*\s*\w` 不匹配 `*=` 复合赋值,而被漏的 4 个
恰好都只有 `*=`(`out.atkMul *= ...` 之类)。
**⇒ 修法:把 `*=`、`/`、`%` 都纳入,并重跑自证到 16/16 才继续。**

**这正是 Lead 那条「探针必须先自证」的用处** —— 若我不自证,就会拿着 36 个报「查完了」。

---

## 2. 48 行定性表

**定性四选一**(与任务描述一致,无「待定」):
`真缺口` / `由调用方保证` / `上界语义不适用` / `上界是数学常量`

我把 **「生产调用者数」** 单列一栏,因为**它是判定「当前能否触发」的硬前提**。

### 2.1 server 侧(22 个)

| # | 文件:行 | 函数 | max | min | 生产调用 | 上界由谁负责 | **定性** |
| --: | :--- | :--- | --: | --: | --: | :--- | :--- |
| 1 | `combat/vitals.ts:148` | `mobHitDamage` | 2 | 0 | **2** | **无人** —— `level` 来自 `levelOf(e.source)`,当前内容上限 30 | **真缺口**(§3.1) |
| 2 | `net/anticheat.ts:261` | `checkMove` | 1 | 0 | **1** | **无人** —— `intent.tick` 来自网络报文 | **真缺口**(§3.2)★ |
| 3 | `combat/vitals.ts:169` | `warnHitsPlayer` | 1 | 0 | **1** | — | **上界是数学常量**(返回 `boolean`) |
| 4 | `combat/progression.ts:306` | `levelGapMul` | 1 | 0 | **1** | **函数自身** `Math.max(LEVEL_GAP_MIN=0.1, …)` | **上界是数学常量**(值域 [0.1,1.0],实测) |
| 5 | `combat/revive.ts:331` | `tickInvuln` | 1 | 0 | **0** | — | **上界语义不适用**(倒计时,钳 0,实测) |
| 6 | `prank/toys.ts:448` | `selfDamageHpFloor` | 1 | 0 | **1** | — | **上界语义不适用**(名字即「HP 地板」,下界语义) |
| 7 | `rooms/effects.ts:100` | `stepRoomEffects` | 1 | 0 | **1** | — | **上界语义不适用**(`onsenSec` 重置为常量或钳 0,实测) |
| 8 | `party/scoring.ts:287` | `paintRadius` | 1 | 0 | **1** | **调用方传常量** `PAINT_BALL_RADIUS = 1`(`modes.ts:611`) | **由调用方保证** |
| 9 | `build/blueprint.ts:443` | `flightDurationMs` | 2 | 0 | **1** | **半保证** —— `dist` 由 `\|b.x-t.lx\|+\|b.y-t.ly\|` 算;`buildSpeedMul` 有下界 0.1 | **由调用方保证**(U3) |
| 10 | `alchemy/attributes.ts:449` | `applyWeightShift` | 4 | 0 | **1** | **算法自身** —— 归一化 ⇒ 恒 `sum=1` | **上界是数学常量**(实测 4 组极值全 sum=1) |
| 11 | `content/registry.ts:114` | `contentCapacity` | 1 | 0 | **2** | — | **上界语义不适用**(只读报表,`Math.max(...usedIds)` 求最大 ID) |
| 12 | `wiring/components.ts:158` | `formatRunTime` | 1 | 0 | **0** | — | **上界语义不适用**(输出是字符串,显示用) |
| 13 | `wiring/graph.ts:28` | `secondsToTicks` | 1 | 0 | **2** | **调用方传字面常量** `RELAY_DELAY_SECONDS` 四档 + `PULSE_BUTTON_SECONDS` | **由调用方保证** |
| 14 | `wiring/logistics.ts:24` | `ticksFor` | 1 | 0 | **0** | — | **由调用方保证**(同族纯换算,生产 0 调用) |
| 15 | `wiring/graph.ts:915` | `estimateAdvanceCost` | 1 | 0 | **0** | — | **上界语义不适用**(性能估算报表,非状态) |
| 16 | `build/rooms.ts:536` | `stampBoxRoom` | 1 | 0 | **0** | — | **由调用方保证**(生产 0 调用;实测 1000×1000 耗 12ms) |
| 17 | `build/wiring_view.ts:96` | `buildWireView` | 1 | 0 | **0** | — | **上界语义不适用**(`width*height` 开数组,尺寸由 `TileGridLike` 定) |
| 18 | `combat/cooking.ts:468` | `tickFoodBuff` | 1 | 0 | **0** | — | **上界语义不适用**(倒计时,钳 0) |
| 19 | `combat/cooking.ts:479` | `mergeFoodBuffs` | 1 | 0 | **0** | — | **由调用方保证**(生产 0 调用;接上生产需复查,见 U4) |
| 20 | `combat/damage.ts:593` | `planSkillHits` | 1 | 0 | **0** | — | **由调用方保证**(生产 0 调用;`hits` 来自 `SkillDef` 内容表) |
| 21 | `social/afk.ts:355` | `suggestedPrice` | 1 | 0 | **0** | — | **由调用方保证**(生产 0 调用;`def.value` 来自内容表) |
| 22 | `wiring/logistics.ts:286` | `stepArm` | 2 | 0 | **1** | **半保证** —— `state.reach` 是**可变字段**,`world_sim.ts:2557` 写死 `reach: 3` | **由调用方保证**(U5) |

> 注:`stepArm` 的 `Math.max(1, state.reach | 0)` 是**下界**;上界靠 `reach` 的写入方。
> 实测 `reach=1e4` ⇒ 循环 (2·1e4+1)² ≈ 4×10⁸ 次 ⇒ 若 `reach` 可自外部变则**是真缺口**,见 U5。

### 2.2 client 侧(26 个)

client 侧的共同特征:**全部是 UI / 渲染几何**,输入来自布局常量或本机 viewport,
**不来自网络报文**。因此除 `clampCellRange`(已自带钳制,但被规则误报)外,
一律归「由调用方保证」或「语义不适用」。

| # | 文件:行 | 函数 | max | 生产调用 | 上界由谁负责 | **定性** |
| --: | :--- | :--- | --: | --: | :--- | :--- |
| 23 | `net/prediction.ts:65` | `maxSpeed` | 1 | **1** | **调用方** —— `params.speedMul` ← `PredictParams` | **由调用方保证**(服务端侧另有 `sanitizeMul` 钳 2.55,见 U6) |
| 24 | `net/prediction.ts:145` | `absorbOffset` | 1 | **0** | — | **上界语义不适用**(`Math.max(1e-6, windowS)` 防除零,下界) |
| 25 | `stage/assembly_math.ts:107` | `quadIndexBuffer` | 1 | **0** | — | **由调用方保证**(生产 0 调用;仅 `stage_assembly.ts` 有 import,未见调用) |
| 26 | `stage/dye_overlay.ts:342` | `dyeCost` | 2 | **0** | — | **由调用方保证**(生产 0 调用;`surfaceCells` 是本机编辑面格数) |
| 27 | `stage/entity_sprites.ts:76` | `spriteHeightPx` | 1 | **0** | — | **由调用方保证**(生产 0 调用;`bodyScale` 有下界 0.1) |
| 28 | `stage/iso_camera.ts:85` | `createCamera` | 2 | **5** | **调用方** —— `window.innerWidth/innerHeight` | **由调用方保证**(viewport 天然有限) |
| 29 | `stage/iso_camera.ts:167` | `viewBounds` | 3 | **0** | — | **由调用方保证**(生产 0 调用) |
| 30 | `stage/iso_camera.ts:231` | `followCamera` | 2 | **0** | — | **由调用方保证**(生产 0 调用;`clampToBand` 内部再钳) |
| 31 | `stage/particles.ts:328` | `emitBurst` | 1 | **0** | — | **由调用方保证**(生产 0 调用;`cfg.count` 来自特效配置) |
| 32 | `stage/particles.ts:380` | `stepEmitter` | 1 | **0** | — | **上界语义不适用**(累加器,钳 0) |
| 33 | `stage/roof_transparency.ts:54` | `buildRoofMask` | 2 | **3** | **调用方** —— `world.width/height` | **由调用方保证**(世界尺寸) |
| 34 | `stage/tile_mesh.ts:364` | `rawWorstFaceCount` | 1 | **0** | — | **由调用方保证**(生产 0 调用;**名字即「最坏情况估算」**) |
| 35 | `ui/blueprint.ts:117` | `clampCellRange` | 2 | **1** | **函数自身,靠分支** | **由调用方保证** ★ **误报样本**(§4.1) |
| 36 | `ui/boss_hud.ts:93` | `circleVertices` | 1 | **3** | **函数自身** —— **默认路径 `segmentsForRadius` 实测封顶 96** | **上界是数学常量**(显式路径见 U7) |
| 37 | `ui/boss_hud.ts:104` | `coneVertices` | 2 | **1** | **函数自身** —— 同上,`segmentsForRadius × span` | **上界是数学常量** |
| 38 | `ui/boss_hud.ts:116` | `lineVertices` | 2 | **3** | — | **上界语义不适用**(`Math.max(0, length)/2` 下界,输出固定 4 点) |
| 39 | `ui/boss_hud.ts:287` | `decayGhost` | 1 | **0** | — | **上界语义不适用**(衰减到目标值,`halfLifeSec` 有下界 1e-3) |
| 40 | `ui/boss_hud.ts:295` | `hpBarText` | 2 | **1** | — | **上界语义不适用**(输出字符串;`Math.max(1, maxHp)` 防除零) |
| 41 | `ui/inventory.ts:81` | `computeSlotLayout` | 6 | **1** | **调用方传常量** —— 唯一生产调用是 `INVENTORY_LAYOUT` | **由调用方保证** |
| 42 | `ui/panel_layout.ts:130` | `slotRect` | 1 | **1** | — | **由调用方保证**(`indexInPage` 来自翻页循环) |
| 43 | `ui/panel_layout.ts:209` | `indentRecipeRows` | 1 | **0** | — | **由调用方保证**(生产 0 调用;`depths[i]` 来自配方树深度) |
| 44 | `ui/panel_layout.ts:236` | `layoutEaselPanel` | 3 | **2** | **调用方** —— viewport | **由调用方保证** |
| 45 | `ui/panel_layout.ts:332` | `layoutPitchPanel` | 2 | **1** | **调用方** —— viewport | **由调用方保证** |
| 46 | `ui/pixel_easel.ts:334` | `tilePattern` | 2 | **0** | — | **由调用方保证**(生产 0 调用;`copies` 来自 UI 交互) |
| 47 | `ui/recipe_tree.ts:87` | `buildRecipeTree` | 2 | **1** | **调用方** —— `maxDepth = MAX_DEPTH` 默认 | **由调用方保证**(`depthLimit` 有下界 1) |
| 48 | `ui/recipe_tree.ts:243` | `scaleLeaves` | 1 | **0** | — | **由调用方保证**(生产 0 调用;`batches` 有下界 1) |

### 2.3 定性汇总(**由探针逐行复算**,不是手数)

| 定性 | 数量 | 占比 |
| :--- | ---: | ---: |
| **真缺口** | **2** | 4.2% |
| **由调用方保证** | 28 | 58.3% |
| **上界语义不适用** | 13 | 27.1% |
| **上界是数学常量** | 5 | 10.4% |
| **合计** | **48** | 100% |

> ⚠️ **我第一版写的分布是 2 / 20 / 16 / 10 —— 三个数都错**,只有「真缺口 2」蒙对。
> 根因:我**手数**了 48 行分类,而表里有行含两个定性术语。见 §7.5 第 5 条。

**另外的横切统计**:
- **生产调用者 = 0 的:23 个 / 48(47.9%)** —— 这 23 个**当前不可能在生产触发**
  (编号 **5 12 14 15 16 17 18 19 20 21 24 25 26 27 29 30 31 32 34 39 43 46 48**)
- 生产调用者 ≥1 **且实参来自外部输入**:2 个(`mobHitDamage`、`checkMove`)—— **都是真缺口**

**⚠️ 我自己在本表中的两次定性修正(留痕)**:

1. `circleVertices` / `coneVertices` 我**最初**定为「由调用方保证」,实测后发现
   **默认路径 `segmentsForRadius` 自身封顶 96** ⇒ 改定为「**上界是数学常量**」(U7)。
   ⇒ 这是「单点测量」的反面:**我没测 `segmentsForRadius` 就先按「调用方传参」归类了。**
2. `mergeFoodBuffs` 我原文写了「若接上则**真缺口**」,使该行出现**两个定性术语**、
   被计数脚本读成「真缺口」。⇒ 已改成单一术语 + 指向 U4。**一行只能有一个定性。**

---

## 3. 真缺口详解(含危害半径)

### 3.1 `mobHitDamage` —— task-49 已定过性,此处只补审计口径

| 项 | 值 |
| :--- | :--- |
| **缺口** | `Math.max` 有两处,**都是下界**(`lv≥1`、`raw≥1`);**上界无** |
| **调用方自报路径** | `vitals.ts:591` `mobHitDamage(s.attackerLevel, s.mul)` ← `attackerLevel = levelOf(e.source)`(`:527`) |
| **实测无上界(纪律 1,7 点扫描)** | `lv=1→6, 2→8, 30→64, 100→204, 1e3→2004, 1e6→2000004, 1e9→2000000004` ⇒ 严格线性,单调增长 |
| **当前可达性** | **不可达** —— 冻结层 `mobs.ts` 24 个 level∈[1,25]、`bosses.ts` 8 个∈[5,30] ⇒ 最大 30 ⇒ `mobHitDamage(30)=64` |
| **危害半径(task-49 已收窄)** | `hp` 侧**已钳**(`vitals.ts:403 Math.max(0, v.hp - raw)`);`totalTaken` / `totals.damage` / **`applied`** 三个字段吸收荒谬值。**`applied` 是返回值,最容易外流** |
| **定性** | **真缺口 —— 缺少守卫的契约缺陷(非当前可利用)** |

**⇒ 与 `checkMove` 的关键区别**:`mobHitDamage` 的**当前不可达**(内容封顶 30);
`checkMove` 的**当前一条报文即可触发**。两者危害等级不同,不应并列。

### 3.2 ★★ `checkMove` —— 本次审计最重要的发现

#### 缺口本体

```ts
// server/src/net/anticheat.ts:261
export function checkMove(s, intent, limits = DEFAULT_LIMITS, maxZ = 3): Verdict {
  const dtTicks = Math.max(1, intent.tick - s.lastTick);   // ← :267 下界 1,**上界无**
  const dist = Math.hypot(intent.x - s.lastX, intent.y - s.lastY);
  const allowed = maxDisplacementPerTick(intent.speedMul ?? 1, limits) * dtTicks;  // ← 上界被 dtTicks 线性放大
  if (dist > allowed + 1e-9) { /* 拦截 */ }
  ...
  s.lastX = intent.x; s.lastY = intent.y; s.lastZ = intent.z; s.lastTick = intent.tick;  // ← :955-958 污染基准
}
```

**⇒ `Math.max(1, …)` 只保证 `dtTicks ≥ 1`,没有任何上界。而 `allowed` 正比于 `dtTicks`。**

#### 多点扫描(纪律 1:≥3 个递增点)

| `intent.tick` | `dtTicks` | `allowed`(格) | 位移 100 格 | 判定 |
| ---: | ---: | ---: | ---: | :--- |
| 2 | 1 | 0.4 | 100 | **拦截** |
| 3 | 2 | 0.7 | 100 | 拦截 |
| 10 | 9 | 3.2 | 100 | 拦截 |
| 100 | 99 | 35.6 | 100 | 拦截 |
| **1000** | 999 | **359.6** | 100 | **★ 放行** |
| 1e6 | 999999 | 359999.6 | 100 | 放行 |
| 1e9 | 999999999 | 359999999.6 | 100 | 放行 |

⇒ **单调增长,无封顶** ⇒ 上界确实不存在(不是「封顶很高」)。

#### 反作弊的两条检查**同时**失明

| 检查 | 绕过手法 | 实测结果 |
| :--- | :--- | :--- |
| **6.1 坐标跳变** | 抬高 `tick` 使 `allowed` 超过位移 | **放行** |
| **6.2 窗口式移速** | 抬高 `tick` 使 `spanTicks` 巨大 ⇒ `observed = path/spanS` 极小 | **放行**(实测 `observed = 1.0e-4` 格/秒 ≪ cap 5.63) |

**⇒ 抬高一个数字,两条检查一起失效。这不是「两个独立绕过」,是同一个根因。**

#### 前置条件:一条报文即可,无需铺垫

```
新建 ac 状态:lastTick = 0,lastX = lastY = lastZ = 0
第一条报文 { tick: 1e9, x: 99999, y: 99999, z: 0 }
  ⇒ allowed = true,violation = undefined
```

**而同样的坐标,只把 `tick` 改成合法值:**
```
第一条报文 { tick: 1, x: 99999, y: 99999, z: 0 }
  ⇒ allowed = false,kind = TELEPORT
```

**⇒ 只差一个字段。这排除了「是否还有别的守卫」的疑问 —— 缺口精确定位在 `tick`。**

#### ★ 对照:同一个函数里 `speedMul` **是有钳的**

| 传入 `speedMul` | `allowed`(格) | 说明 |
| ---: | ---: | :--- |
| 1 | 0.3600 | |
| 2 | 0.7200 | |
| 2.55 | 0.9180 | |
| 5 | 0.9180 | **被钳到上界** |
| 100 | 0.9180 | **被钳到上界** |
| 1e9 | 0.9180 | **被钳到上界** |

`sanitizeMul(declared, 1, MAX_SPEED_BONUS_MUL=2.55)` 把倍率钳死了。

**⇒ 这是「单向守卫」最纯粹的一例:同一个函数、同一个表达式里,
`speedMul` 钳了上界,`dtTicks` 没钳。**
**⇒ 而 `anticheat.ts:157-168` 的长注释详细说明了 `speedMul` 为何只能钳上界 —— 却没提 `tick`。**

#### 危害半径(精确到能说准为止)

**包含:**
1. **服务端接受伪造坐标** → `room.ts:630-632` 写入 `state.players[].x/y/z` ⇒ **广播给所有客户端**
2. **反作弊基准被污染** → `s.lastX/lastY/lastTick` 被写成伪造值 ⇒ 之后所有相对判定以伪造点为基准
3. **不产生任何违规分** → `s.violations.length = 0`,`s.score = 0` ⇒ **漂移检测与踢出机制全部不触发**
4. **水平瞬移能力** —— x、y 想去哪就去哪

**不包含(避免夸大):**
5. **Z 轴仍被独立拦** —— 实测 `z ∈ [-1, 3]` 恒定生效,`z=3.0001` 与 `z=-1.0001` 均被拦 ⇒ **不能飞 / 不能钻地**
6. **速度加成仍被钳** —— `MAX_SPEED_BONUS_MUL=2.55` ⇒ 不能合法地快(但可瞬移,这条意义有限)
7. **不是「无限能力」** —— 只能改位置,不能改血量 / 物品 / 伤害

**⇒ 一句话:危害是「水平瞬移 + 反作弊失明」,不是「玩家无敌」。**

#### 可达性分级

| 层级 | 结论 | 判据 |
| :--- | :--- | :--- |
| **函数层** | **可达** | `checkMove` 生产调用 1 处(`anticheat.ts:521`) |
| **服务层** | **可达** | `AntiCheat.move` ← `room.ts:622 applyMove`(生产 1 处) |
| **网络层(代码)** | **可达** | `room.colyseus.ts:166 onMessage('move', (client, msg) => this.runtime.applyMove(client.sessionId, msg))`,`msg` 类型含 `tick: number` |
| **网络层(进程)** | **未实测** | `room.colyseus.ts` 当前**不可 import**(44 装饰器 + CJS 双阻塞,见 `docs/ARCH-GAPS.md`) |

**⇒ 我把它定为「真缺口」的依据是前三行(代码层全链路通),第四行的阻塞属入口可跑性问题,
不改变「这条路径在代码上无守卫」这一事实。**

**修法建议(仅建议,未改代码)**:在 `:267` 加对称上界,例如
`Math.min(MAX_CATCHUP_TICKS, Math.max(1, intent.tick - s.lastTick))`,
`MAX_CATCHUP_TICKS` 取「可容忍网络抖动上限」(如 20–60 帧)。
**⚠️ 这会改变掉线重连的判定语义,需与 `room.ts:452-453` 的 `ac.join` 播种一起看** ⇒ 见 U2。

---

## 4. 分类规则的边界:一条误报 + 两条漏报(实测)

### 4.1 误报:`clampCellRange` —— 上界用**分支**实现,规则看不见

```
client/src/ui/blueprint.ts:117   max=2  min=0   ⇒ 规则判定「命中」
```
但它的上界是完整的:
```ts
const cap = Math.max(1, Math.trunc(maxCells));
if (w * h <= cap) return { ..., clipped: false };
/* 否则居中裁剪成 side×side */
const side = Math.max(1, Math.floor(Math.sqrt(cap)));
```

**实测确认钳住**:`maxCells=16 → side=4`、`=4096 → side=64`。

**⇒ 误报根因:规则用「有没有 `Math.min`」当代理,
而 `Math.min` 只是上界的三种写法之一 —— 另外两种是**分支**与**归一化**
(后者见 `applyWeightShift`)。规则对这两种全盲。**

### 4.2 漏报 A:规则**只扫 `export function`**,类方法整个不扫

```
规则范围:export function  841 个
不扫:     类方法 + 非导出 function  95 个
```

**而我 task-49 已实测的真缺陷恰好落在类方法里:**
```
server/src/net/room.ts:745   carryCapacityOf(userId: string): number {
  ... return 8 + (lv - 1);        ← 无钳制,与 statsAtLevel 分歧
}
```
实测:L31 → `38`,而 `statsAtLevel(31).carrySlots` → `37`。**规则零命中。**

**⇒ 这是最严重的一条漏报**:它漏的正是**本仓已确认的真缺陷**。

### 4.3 漏报 B:放宽成「有 `Math.max` 就算钳过」⇒ 连 `mobHitDamage` 都抓不到

`mobHitDamage` 有 `Math.max ×2`(`lv≥1`、`raw≥1`),**看起来做了双重钳制**。
若规则写成「有 `Math.max` ⇒ 认为有守卫 ⇒ 跳过」,**它立刻漏报**。

**`checkMove` 同理**:有 `Math.max(1, tick-lastTick)`,看似钳过,实为下界。

**⇒ 这是 Lead 已指出的「放宽到能抓 mobHitDamage 时它反而不抓」的机制解释:
`Math.max` 计数与「是否有上界」在 48 个里几乎不相关。**

### 4.4 边界结论

| 判据形态 | 精度 | 漏报 | 评价 |
| :--- | :--- | :--- | :--- |
| A / C「有 max 无 min + 算术」 | **46/48 = 95.8% 误报** | 漏类方法、漏分支/归一化 | **不可用** |
| 「有 max 就算钳过,跳过」 | 低误报 | **漏 `mobHitDamage`、`checkMove`** | **危险**(假安全) |
| 「max 与 min 必须成对」 | 高误报 | 漏所有分支 / 归一化写法 | 不可用 |

---

## 5. ★ 给 Lead 的结论:这条检查该不该做?判据怎么写?

### 5.1 我的判断:**不建议做成门禁,但理由要换一个**

**先说结论:我同意你「不宜做门禁」,但我不同意你的理由。**

你说的是「2.3% 命中率太低」。**我认为命中率不是问题**(低命中率 + 高价值也能做)。
**真正的问题是这条规则与它要检测的属性几乎无关:**

```
48 个命中里,「有上界」的有 46 个(95.8%)⇒ 这条规则 96% 的时间在报假警
而真有上界的两种主要写法(分支、归一化)它完全看不见
⇒ 它不是「命中率低」,它是**测错了东西**
```

**⇒ 做成门禁只有两条路,都不行:**
- 大量误报 ⇒ 被迫加白名单(46 条)⇒ **白名单变成真缺陷的藏身处**(`mobHitDamage` 就在名单里)
- 放宽到「有 max 就算过」⇒ **连两条真缺口都抓不到** ⇒ 变成**假安全**,比没有更糟

### 5.2 若要做,判据应该这么写:查**「参数来源」而不是「Math 调用」**

我在逐条定性 48 个后,发现一条**高信噪比**的替代判据:

> **只查「参数直接来自网络报文 / 调用方自报」的函数是否存在上界,
> 而不是查「有没有 Math.min」。**

**为什么这条能成立 —— 实测判据:**
```
48 个里,生产调用者 = 0 的:**23 个(47.9%)**  ⇒ 一律排除,当前不可能触发
剩下 25 个里,实参来自外部输入的:**2 个**      ⇒ mobHitDamage / checkMove
这 2 个**都是真缺口**
⇒ 若判据是「外部输入 ∧ 无上界」,命中 2 / 候选 2 = **100%**,且两条都是真的
```

**这条判据的信噪比是 100%,而原规则是 4.2%。**

**具体写法(三条同时满足才报)**:
1. 函数的某形参**被 `net/**` 的报文类型或 `opts` 自报字段**喂入
2. 该形参在函数内**参与了乘法、数组长度、循环边界、或除法分母**
3. 函数内**没有**对该形参的 `Math.min` / 分支裁剪 / 归一化

**⇒ 但我要如实说清它的代价**:第 1 条**没法可靠静态判定** —— 我这次的「来源」全是**手工追**的
(`checkMove` 追了三层:`room.colyseus.ts:166` ← `room.ts:622` ← `anticheat.ts:521`)。
把它做成门禁意味着**要写一个跨文件的污点分析器**,那是**另一个量级的工程**,
且本仓没有现成基础 ⇒ **我不建议现在做。**

### 5.3 我的最终建议

| 选项 | 建议 |
| :--- | :--- |
| 做成**门禁断言** | **否** —— 见 §5.1 |
| 做成**一次性审计** | **是,已完成(本文件)** |
| 做成**窄口径污点检查** | **否(现在)** —— 需跨文件污点分析,ROI 不成立 |
| **改成「接口设计约束」** | **★ 我推荐这条**,见下 |

**⇒ 我推荐的替代品:不是检查,而是约定。**

```
凡「从网络报文取数」的函数,其形参名必须以 `claimed` 或 `_untrusted` 结尾。
例如 intent.tick → 改名后,checkMove 里一眼能看出「这个值不可信」。
```

理由:**它不误报、不可绕过、零运行时成本,且直接对着根因**。
`anticheat.ts` 已经有 `sanitizeMul(declared, …)` 这个**同思路的先例**
(把不可信值显式命名并钳制)⇒ **沿用既有模式,不另起一套**(这也是你给 task-47 的指示)。

---

## 6. 未实测项(单列,不得当结论)

| # | 项 | 为什么未实测 |
| --: | :--- | :--- |
| U1 | `checkMove` 的 tick 绕过在**真实网络栈**是否可触发 | `room.colyseus.ts` 不可 import(44 装饰器 + CJS 双阻塞);我只证到**代码调用链通**,未跑进程 |
| U2 | 给 `dtTicks` 加上界后,是否**破坏掉线重连**判定 | 需与 `room.ts:452-453` 的 `ac.join(...)` 播种 + `AFK_TIMEOUT_MS` 一起看;未做 |
| U3 | `mobHitDamage` 的 `mul` 在生产是否可能 >1 | `resolveStrikes` 的 `s.mul` 来自 `PendingStrike`,我未追到它的写入方 |
| U4 | `mergeFoodBuffs` 若接上生产,连乘何时溢出 | **已测出边界**:二分得 **1023 个 ×2 buff 仍有限(`8.99e307`),1024 个 → `Infinity`**。⇒ 需要 ≥1024 个同时生效的料理 ⇒ **实际风险远低于我原判**,除非接线时引入「无上限 buff 数组」 |
| U5 | `stepArm` 的 `state.reach` 是否有外部写入路径 | `world_sim.ts:2557` 写死 3;但 `ArmState` 是**可变 interface**,未穷举所有写入点 |
| U6 | `maxSpeed` 的 `speedMul` 在客户端是否可被本机用户改 | 客户端侧参数,未做运行时验证;服务端侧另有 `sanitizeMul` 兜底 |
| U7 | `circleVertices` **显式传 `segments`** 时是否无界 | 实测 `segments=1e7 → 数组长 1e7` ⇒ **无界**;但**默认路径 `segmentsForRadius` 实测封顶 96**(radius 从 100 到 1e6 恒为 96)⇒ 生产 3 个调用点走默认路径 ⇒ **按默认路径定性**。显式路径是否可被外部喂入,未追 |
| U8 | 48 个之外是否还有漏掉的真缺口 | 规则只扫 `export function`;类方法与箭头函数全未扫(见 §4.2)。**这是本审计最大的已知盲区** |

---

## 7. 复现方式

全部数字来自临时探针(`scripts/_ga_*.ts`,**已删**)。关键命令形状:

```powershell
# 1 扫描(必须先自证:已知样本 16/16 命中才继续)
node scripts/_ga_scan.ts

# 2 ★ checkMove 绕过(多点扫描 + 自证 + 对照)
node scripts/_ga_checkmove.ts

# 3 其余 server 侧多点扫描
node scripts/_ga_scan_server.ts

# 4 分类边界(误报 / 漏报)
node scripts/_ga_boundary.ts
```

**探针自证要求**(纪律 3;我第一版就是在这里失败的):
```
必在名单的 16 个样本: 命中必须 = 16/16
阴性对照(有 Math.min 的): 必须全部排除
只有两项都过,才允许采信命中数
```

**行号漂移提示**:`world_sim.ts` / `vitals.ts` 正被并发编辑。
本表所有条目已同时给**函数名**(可用 `grep "function <name>"` 反查),不依赖行号。

---

## 7.5 我这轮自己犯的 6 个错(全部留痕)

**1 探针没自证就差点采信** —— 第一版得 36 个、已知 16 个样本只命中 12/16。
**若我不自证,就会拿着 36 个报「查完了」,漏掉 12 个。**

**2 「含乘法」正则漏掉 `*=`** —— 直接导致 `mergeFoodBuffs` / `applyWeightShift` /
`contentCapacity` / `stampBoxRoom` 四个被误判为「不含算术」而排除。
⇒ **`out.atkMul *= b.atkMul` 是乘法,但 `\w\s*\*\s*\w` 匹配不到。**

**3 把「生产调用者 0」误当成定性依据** —— 我一度想把 23 个零调用的直接归为
「由调用方保证」。**这是错的**:零调用只说明**现在不能触发**,
不说明**上界该不该有**。⇒ 表里改成两栏并列(定性 + 生产调用数),不混为一谈。

**4 `circleVertices` 先归类后测量**(§2.3 已记)。

**5 ★ 汇总表的分布数字我第一版是手数的,而且错了**
```
我第一版写:  2 / 20 / 16 / 10
探针复算得:  2 / 28 / 13 /  5
⇒ **三个数都错**,只有「真缺口 2」蒙对
```
**根因**:手数 48 行时,`mergeFoodBuffs` 那行的「若接上则**真缺口**」被当成定性,
加粗前缀又干扰判断 ⇒ **手数分类是不可靠的**。
**⇒ 修法:分布必须由探针从表里反算,不能手写。** 已在 §2.3 标注。

**6(操作层,非分析层)我用 PowerShell `-replace | Set-Content` 改中文文档,
把整个文件写成乱码。** 已按系统提示「用 edit/write 工具而非 shell」重写本文件。
⇒ **凡是含 CJK 的文件,一律不用 shell 做文本替换。**

**⇒ 归纳**:这 6 个错里 **4 个是「先得结论再取证」**,与我在 task-49 犯的第 8 个错同型。
**⇒ 有效对策:探针先自证 + 派生数字由探针复算 + 中文文件不用 shell 改。**

---

## 8. 与 task-49(`docs/AUTHORITY-MAP.md`)的衔接

本文件是 task-49 「单向守卫」一节的展开。两处需要 Lead 注意:

1. **task-49 §4.12.0 说的「下界齐、上界无」在 `checkMove` 上有一个更强的版本**:
   **同一个表达式里** `speedMul` 钳了、`dtTicks` 没钳 ⇒ 比 `mobHitDamage` 更纯粹。
   建议在 `ARCH-GAPS` 引用时用 `checkMove` 当主例,`mobHitDamage` 当次例。

2. **`checkMove` 与本仓既有教训「26/31 双写者」同源**:
   `tick` 的权威在服务端(`state.meta.tick`),但 `checkMove` 用的是**客户端报的 tick**。
   ⇒ **它其实是「权威归属未定义」在反作弊层的表现**,与 task-49 的核心结论一致。