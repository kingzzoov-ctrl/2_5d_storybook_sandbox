# US2 网关契约:RoomRuntime ↔ WorldSim 的唯一权威与单向投影

> **状态**:契约已定,实现进行中(阶段 4)
> **裁决来源**:Lead(2026-11-13 用户四项裁决)+ `docs/ARCH-GAPS.md` 第四/五/六层
> **本文件是实现的**唯一**接口依据** —— 任何实现与本文件冲突,以本文件为准(改动须回改本文件并记 CR)

---

## 1. 职责边界

| 组件 | 职责 | **不**负责 |
| :--- | :--- | :--- |
| `WorldSim` | **领域状态唯一真源(SSOT)**:玩家位置/生命/等级/背包/预警/生物 AI/流体/电路 | 网络帧号、报文校验、连接生命周期 |
| `VitalsSystem` | `hp`/`maxHp` 的**直接持有者**与不变量守卫 | 等级派生(它**接收**派生结果) |
| `progression` | **等级 → 属性**的唯一算子(`statsAtLevel`) | 持有生命运行时状态 |
| `AntiCheatRoom` | 报文可信性:坐标/帧号/攻速/背包增量 | 领域语义(它不知道"等级"是什么) |
| `RoomRuntime` | **编排**:接报文 → 反作弊 → 驱动仿真 → 投影出网 | 自己持有领域状态 |
| `room.state.players[]` | 20Hz 广播的**只读投影视图** | **任何**领域决策 |

### ★ 一条贯穿全篇的判据(CR-14 U1/U2)

```
客户端输入一律是「申请」,不是「事实」。
所有来自报文的字段 ⇒ 必须经反作弊或服务端派生才能进入领域状态。
所有服务端派生字段 ⇒ 客户端**只读**,不得回写。
```

---

## 2. 接口

### 2.1 裁决 1 —— `maxHp` 以 `progression` 派生值为准

```
权威:`server/src/combat/progression.ts` 的 `recompute()` → `statsAtLevel(level).maxHp`
     实测公式 = 100 + 15(L−1) ⇒ Lv.1 = 100,Lv.30 = **535**(已核)
`server/src/combat/vitals.ts` 的 `PLAYER_BASE_HP = 100`
     ⇒ 降级为「**Lv.1 初始默认值**」,不再是权威上限
```

**★★ 结构性约束(实现前必读)**:`VitalsSystem.maxHp` 是**构造器参数**,
被**所有玩家共享**(实测:两个 register 的玩家共用同一 `maxHp`)。
⇒ **不能**通过「给构造器传等级」实现每玩家派生 —— 那只能表达一个等级。
⇒ 唯一正确形态:**逐玩家更新 `v.maxHp`**(`get()` 返回同一引用,可直接改字段)。

**新增接口(在 `VitalsSystem` 上)**:

```ts
/**
 * 把 per-player 上限同步到派生值。**唯一**写 v.maxHp 的入口。
 * @param id 玩家
 * @param derivedMaxHp 由 progression.statsAtLevel(level).maxHp 得到
 * @returns 是否发生了变更(便于调用方避免同帧重复投影)
 */
syncMaxHp(id: string, derivedMaxHp: number): boolean
```

**⚠️ 未裁决的子问题(实现时**必须**按此保守取值,并标为待裁)**:改上限后 `hp` 怎么办?
```
策略 A 补满差额 ⇒ 升级即回满血
策略 B 按同比例  ⇒ hp *= derived/old
策略 C 只抬上限,hp 绝对值不变  ← **本契约取此**
⇒ 理由:C 是唯一**不给玩家凭空回血**的选项;A 会与「温泉 +30% 生命上限」叠加出
  「升级顺带回血」的玩法后果,而那是**玩法裁决**,不是接线能定的。
⇒ 若日后裁决为 A/B,只需改 `syncMaxHp` 一处 —— 故本函数必须把该策略**收在自身内部**,
  不得散到调用方。
```
**⚠️ 且 `syncMaxHp` 必须钳 `hp`**:`hp = min(hp, derivedMaxHp)`
(否则**降级**会再造出 `hp > maxHp`,即 W1 的镜像)。

### 2.2 裁决 2 —— `room.PlayerState.level` 保留,补齐写者

```
保留理由(用户裁决,已核实):level 在 FIELD_TABLE 与 20Hz 增量编码中,
  且是 room.ts carryCapacityOf() 算 8+(lv−1) 的**唯一依据**。
⇒ 删字段会破坏网络协议基线与客户端显示。
```
**写者方向**:`WorldSim.progresses` → `PlayerState.level`(单向,见 2.3)。

### 2.3 裁决 3 —— 8 个交集字段:`WorldSim` → `room.state.players[]` **单向投影**

```
WorldSim(SSOT) --[每帧投影]--> room.state.players[](只读视图)
                                      |
客户端报文 --[反作弊+校验]--> 输入指令 --[驱动]--> WorldSim 变更
```
**禁止双向互抄** —— 否则重演 §W1~W7 的多写者竞态。

**8 个字段**(来自 ARCH-GAPS 第五层实测清单,交集字段):

| # | 字段 | WorldSim 权威来源 | 投影规则 |
| :--- | :--- | :--- | :--- |
| 1 | `level` | `progresses.get(id).level` | 直传 |
| 2 | `hp` | `vitals.get(id).hp` | 直传 |
| 3 | `maxHp` | `vitals.get(id).maxHp` | 直传(它**已**是派生值,见 2.1) |
| 4 | `x` | 物理权威(`physics`) | 直传 |
| 5 | `y` | 同上 | 直传 |
| 6 | `z` | 同上 | 直传 |
| 7 | `weaponId` | 装备权威 | 直传 |
| 8 | `inventory` | `users.inventory_json`(明细) | ⚠️ **只投总量**,见下 |

**⚠️ 第 8 项`inventory` 的已记录分歧(W5)**:
```
room.inventoryTotals 只存总量;users.inventory_json 是明细
⇒ 两者**各自漂**
⇒ 本契约裁定:投影方向 = 明细 → 总量(单向),且
  **投影函数必须是可以从明细重算总量的纯函数**(不得累加式更新)
  ⇒ 累加式更新会因漏一帧而永久偏差。
```
**⚠️ 未裁决**:`inventory` 是否真的逐帧投影(带宽),还是仅变更时投影。
本轮**取「变更时投影」**(`syncMaxHp` 同族的返回 bool 模式),理由:总量字段体积小但每帧 20 次 × N 人无意义。

### 2.4 裁决 4 —— W1 钳制**唯一选址在 `vitals.ts`**

```ts
/* server/src/combat/vitals.ts 的 revive() 内 —— 最终形态(见 §2.4.1 的订正) */
const want = hp ?? v.maxHp;
const safe = Number.isFinite(want) ? want : v.maxHp;
v.hp = Math.min(v.maxHp, Math.max(0, safe));      // ★ 下界 0,不是 1
```
**`revive.ts` 侧职责**:只算期望值 `hpAfter` 并传入,**不重复钳制**(两侧都钳 = 两份实现)。

#### 2.4.1 ★★★ 订正(2026-11-13,Lead):本契约原写的「下界 1」**已被实测推翻**

**原写**:`Math.max(1, hp ?? v.maxHp)`,理由「复活后 hp=0 会立刻再次 downed,是死循环入口」。

**该理由不成立**,三条实测:

```
① hp=0 且 downed=false **不会自动再倒**
   `downed = true` 全仓只有一处:`vitals.ts:520` 的 `if (v.hp === 0)`
   —— 而它在 `applyHit` 里(「被**打到** 0」),`revive()` 自己 `v.downed=false` 且不检查 hp。
   实测:revive(0) 后 hp=0 / downed=false;推进 400 帧后 hp 反而被 regen 抬到 20。

② ★★ 决定性的:hp=0 与 hp=1 挨同一拳,**逐字段完全相同**
     hp=0  起手 → applied=6 hp=0 downed=true
     hp=1  起手 → applied=6 hp=0 downed=true     ← 与 hp=0 **一模一样**
     hp=20 起手 → applied=6 hp=14 downed=false
   ⇒ 一级生物一拳 6 点,1 血与 0 血**都是一拳倒**
   ⇒ **「下界 1」达成不了它声明的目的**(防复活即倒)。

③ 复活侧**根本传不出 0**:`REVIVE_HP_RATIO = 0.5`
     Lv.1  touchRevive = 50 / flagRevive = 50 / featherRevive = 100
     Lv.30 touchRevive = 268 / flagRevive = 268 / featherRevive = 535
   ⇒ Lv.1..30 的最小值是 **50** ⇒ 下界 1 在复活语义下**从未被触发**
   ⇒ 它**唯一**的效果是改掉**读档**语义(`world_sim.ts:2463` `importVitals` 传 `hp=0`)
```

**⇒ 结论:真正的状态机不变量是 `0 ≤ hp ≤ maxHp`(不是 `1 ≤ hp ≤ maxHp`)。**
> ★ 判据:「不变量的作用是**排除会引发错误的状态**」。
> `hp=0` 不引发错误(会被 regen 抬起 / 不自动倒 / 一拳倒与 hp=1 无异)⇒ 它不是非法态。

**由此保留的**两条**真缺陷**(与「下界 1」无关,必须照修):
```
(a) `Math.max(1, NaN)` 返回 **NaN** ⇒ 实测 `revive(id, NaN)` 就是 hp=NaN。
    NaN 让所有后续比较恒 false ⇒ 比负数危险 ⇒ 必须用 `Number.isFinite` 兜底。
(b) 无上界 ⇒ `revive(id, 535)` ⇒ hp=535 > maxHp=100(W1 本体)⇒ `Math.min(v.maxHp, …)`。
```
**最终期望值表**:
| 输入 | 期望 | 依据 |
| :--- | :--- | :--- |
| `revive(id, 535)` | `hp == maxHp` | (b) 上界 |
| `revive(id, NaN)` | `hp == maxHp` | (a) 兜底为「默认值」,与 `hp ?? v.maxHp` 同族 |
| `revive(id, -5)` | `hp == 0` | 下界 0;与 `importVitals` 的 `clamp(row.hp,0,maxHp)` **一致** |
| `revive(id, 0)` | `hp == 0` | ★ **订正**:原契约写「⇒ 1」,**撤销**;与读档语义一致 |
| `revive(id, 1)` | `hp == 1` | 直传 |
| `revive(id, undefined)` | `hp == maxHp` | 满血默认 |

**⚠️ 于是原 §9 验收 ⑩「revive(id,0) ⇒ hp==1(行为变更,显式登记)」作废**,
改为「`revive(id,0) ⇒ hp==0`,**与 `importVitals` 读档语义一致**」。

**⚠️ 且这一订正让「选址」变成唯一解**:下界 1 若保留,`importVitals` 的
「忠实还原存档 0 HP」这条**既有契约**(`tests/WS-FND-02.test.ts` C22)就被覆盖 ——
即**地板 1 只伤读档、没换来任何保护**。故不需要 `floor` 参数区分语义(原选项 Y)。

---

## 3. 数据结构

### 3.1 网关骨架(`RoomRuntime` ↔ `WorldSim`)

```ts
/** 投影所需的**只读**读口 —— 网关只经此取数,不直接摸 WorldSim 内部 Map。 */
interface SimReadView {
  levelOf(playerId: string): number;      // progresses
  vitalsOf(playerId: string): { hp: number; maxHp: number; downed: boolean } | null;
  poseOf(playerId: string): { x: number; y: number; z: number } | null;
  weaponOf(playerId: string): string | undefined;
  inventoryTotalOf(playerId: string): { used: number; cap: number } | null;
}
```
**★ 为什么抽 `SimReadView` 而不是直接读 WorldSim**:
```
1 投影的**可测性** —— 用一个假实现就能单测投影逻辑,不必起整个 WorldSim
2 ★★ 更重要的:**它把「投影读了哪些字段」变成显式的** ——
  若哪天有人在投影里读 `room.state.players[].hp` 当权威,
  那是**回抄**,而有了这个接口就能用「假实现不提供该字段」来**结构性挡掉**
```

### 3.2 投影出口

```ts
/** 把 SSOT 投影到只读网络视图。**纯函数语义**:同样输入 ⇒ 同样输出,不读 state 自身。 */
function projectPlayer(view: SimReadView, playerId: string, out: PlayerProjection): boolean
// 返回是否**发生变更**(供 20Hz 差分编码复用)
```

---

## 4. 算法

```
每帧(20Hz)RoomRuntime.step():
  1 AntiCheatRoom.tick(serverTick)            ← 先推服务端时钟(反作弊基准)
  2 消费入站报文队列(已过反作弊)
       · move   → 若 allowed ⇒ 写入物理意图
       · attack → 若 allowed ⇒ 写入攻击意图
       · action → 权限校验后入意图
  3 WorldSim.tick(dt)                          ← 领域推进(**唯一**变更点)
  4 for each 玩家 in 房间:
       level = view.levelOf(id)
       ⚠️ 若 level 变化 ⇒ vitals.syncMaxHp(id, statsAtLevel(level).maxHp)   ← 裁决 1
       projectPlayer(view, id, state.players[i])                            ← 裁决 3
  5 差分编码广播(已有 WS-13 通道)
```

**★ 顺序不可换的两处**:
```
· 1 必须在 2 之前:反作弊的 `s.lastTick` 是「同一帧内重复兑现」的闸门,
  不先推进 ⇒ 闸门失效(正是 task-55 修的那个洞)
· 3 必须在 4 之前:投影必须投**本帧已推进**的状态,
  否则玩家看到的是上一帧(且在 tick 边界会永久滞后一帧)
```

---

## 5. 参数

| 参数 | 值 | 来源 |
| :--- | :--- | :--- |
| `TICK_HZ` | 20 | 冻结层 |
| `SLOW_TICK_HZ` | 2 | 冻结层 |
| `MAX_LEVEL` | 30 | 冻结层 |
| `PLAYER_BASE_HP` | 100 | `vitals.ts` ⇒ **降级为 Lv.1 默认值** |
| `statsAtLevel(L).maxHp` | `100 + 15(L−1)` | **派生权威**;Lv.30 = 535 |
| `REVIVE_HP_RATIO` | 见 `shared/types` | 复活比例 |
| `MANUAL_REVIVE_INVULN` | 0.5 | `revive.ts` |
| `FEATHER_INVULN` | 3.0 | `revive.ts` |
| `PLAYER_IFRAME_SEC` | 0.35 | `vitals.ts` |

---

## 6. 性能

```
投影是 O(玩家数 × 8 字段),每帧一次
⇒ 20Hz × 8 人 × 8 字段 = 1280 次赋值/秒 —— **可忽略**
⇒ ⚠️ 但**不得**在投影里做分配(hypot / 数组新建):
  它是每帧路径,而 60fps 预算下 GC 抖动比计算更贵。
⇒ 实测基线见 `scripts/perf-bounds.ts`
```

---

## 7. 边界

```
[ ] 「升级是否回血」未裁决 ⇒ `syncMaxHp` 取策略 C(只抬上限)并集中在该函数内
[ ] `inventory` 取「变更时投影」而非逐帧 ⇒ 若日后要逐帧,只改投影出口
[ ] 只投影**8 个交集字段**;`room.PlayerState` 的其余字段(如 name)保持既有来源
[ ] `downed` 不进交集字段(它是 `vitals.downed` 与 `DownedState` 两层事实,见 W3)
[ ] 本契约不涉及**双向**投影 —— 若日后要客户端预测,须另立 CR(会重开多写者问题)
```

---

## 8. 耦合

```
上游依赖:progression(statsAtLevel) · vitals(hp/maxHp 持有者) · anticheat(报文可信)
下游消费:room.state.players[](20Hz 差分编码) · 客户端渲染
★ 严禁的耦合方向:
  · client/src → server/**(已有门禁,verify.ts checkCrossLayerImports)
  · 投影函数 → room.state(回抄)⇒ 由 SimReadView 接口结构性挡掉
  · VitalsSystem → progression(反向依赖)⇒ 派生值由**调用方**传入,
    不让 vitals 自己按 level 查表(否则它就成了第二个等级权威)
```

---

## 9. 验收

```
① 裁决 1:玩家升到 Lv.30 ⇒ v.maxHp == 535(实测,不是读码)
② 裁决 1:降级 ⇒ hp 被钳到新上限(不得出现 hp > maxHp)
③ 裁决 1:两个不同等级玩家在**同一** VitalsSystem 实例里各自正确
   (这是构造器共享常量那个坑的**直接反例**)
④ 裁决 2:PlayerState.level 有**生产**写者(可达性门禁认它)
⑤ 裁决 3:8 字段单向投影 ⇒ 改 WorldSim 侧值,投影后 state 跟着变
⑥ 裁决 3:**反向**注入(改 state 的 hp,不驱动 WorldSim)⇒ 下一帧被**覆盖回来**
   ⇒ 这是「单向」的**唯一**可证伪方式
⑦ 裁决 4:revive(id, 535) ⇒ hp == 100(不超上限)
⑧ 裁决 4:revive(id, NaN) ⇒ hp == maxHp(不是 NaN)
⑨ 裁决 4:revive(id, -5) ⇒ hp == 0(不是负数,与读档一致)
⑩ 裁决 4:revive(id, 0) ⇒ hp == 0(**订正**:与 importVitals 读档语义一致,见 §2.4.1)
⑩b 回归:WS-FND-02 C22 **必须仍绿**(它是「下界 0」的既有契约,订正后应恢复)
⑪ 端到端:真 WS 往返,客户端收到的 level/maxHp 与 SSOT 一致
⑫ 门禁四旗 EXIT=0;新增断言全部有牙(注入必红)
```

---

## 10. 未决

```
1 ★ 「升级是否回血」(策略 A/B/C)⇒ 本契约取 C,待玩法裁决
2 `room.PlayerState.level` 的**写者**是投影出口,还是 WorldSim 在升级时主动推?
  ⇒ 本契约取「投影出口」(与其余 7 字段同路径,单一机制)
3 W4 `carrySlots` 分歧(冻结层 statsAtLevel 给 8+(L−1),room.ts 内联 `8+(lv-1)`)
  ⇒ **实测同式**,但两份实现 ⇒ 应统一到 statsAtLevel;本契约不覆盖(记 CR)
4 W7 `Clock` 两个同名接口(coop/rush_order.ts vs net/anticheat.ts)
  ⇒ 已由 AUTHORITY-MAP 建议改名;本契约不覆盖(记 CR)
5 ★★ 第六层的**连带缺陷**(本轮新发现,见 CR-27):
  `AntiCheatRoom` 构造器接收任意 `limits`;若传入**限值是对象但字段不完整**
  ⇒ `limits.maxMoveCatchupTicks == undefined` ⇒ `claimedTick = NaN`
  ⇒ `allowed = 0.36 × NaN = NaN` ⇒ `dist > NaN` **恒 false** ⇒ **全部放行**
  ⇒ 即「限值缺失 ⇒ 反作弊**静默**失效为全放行」(fail-open)。

  **逐形态实测(10 种输入,Lead 独立复核)**:

  | 传入的 limits | 瞬移(1e5 格)| Z 越界 | 归类 |
  | :--- | :--- | :--- | :--- |
  | `DEFAULT_LIMITS`(对照) | 拦下 TELEPORT | 拦下 | 正常 |
  | `undefined`(⇒ 默认参) | 拦下 TELEPORT | 拦下 | 正常 |
  | `'x'` 字符串 | **放行** | 拦下 | fail-open |
  | `5` 数字 | **放行** | 拦下 | fail-open |
  | `{}` 空对象 | **放行** | 拦下 | fail-open |
  | `{speedWindowTicks:20}` | **放行** | 拦下 | fail-open |
  | 缺 `maxMoveCatchupTicks` | **放行** | 拦下 | fail-open |
  | 全字段在但 `catchup = NaN` | **放行** | 拦下 | fail-open |
  | 全字段在但 `slack = NaN` | **放行** | 拦下 | fail-open |
  | `null` | **抛 TypeError** | — | fail-fast |

  ⇒ ★ **准确表述是「限值是对象但字段不完整/为 NaN ⇒ 静默失效」**,
    **不是**「任何坏 limits 都失效」—— `null` 反而抛异常(看得见)。
  ⇒ ★ 「字段存在但是 `NaN`」与「字段缺失」**同样致命** —— 所以守卫不能只查 `key in obj`,
    必须查 `Number.isFinite`(与同文件 6.0 值域门**同一族**)。
  ⇒ ★ Z 轴检查**在同一条路径上仍然生效**(它不依赖 `dtTicks`)⇒ 危害**仅限水平**。
  ⇒ **可达性**:生产调用点只有 `new AntiCheatRoom()`(room.ts:508)⇒ **当前不可达**。
    定性 = **契约缺守卫,不是当前可利用缺陷**(与 `mobHitDamage` 同类)。
```
