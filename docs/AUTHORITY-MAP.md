# 服务端权威状态盘点(US2 基础:谁拥有玩家的什么)

> **任务**:task-49 · **作者**:`net-persist`(WS-07 存档与 20Hz 网络协议)
> **读取时刻**:2026-11-12 19:00–19:05(+08:00)
> **纪律**:本文件为**只读盘点**。未修改任何 `server/**` `client/**` `scripts/**` `tests/**`。
> **标注约定**:「**实测**」= 我实跑探针得到、附命令可复现;「**读码**」= 静态读源码;
> 「**未实测**」= 未验证,不得当结论用。

---

## 0. 一句话结论

**玩家的同一份状态在服务端存在两套互不相识的实例**,交集字段(`level` / `hp` / `maxHp` / `x,y,z` / 武器)
**没有任何同步通道**,而 `room.ts` 侧的那一套**只有一半字段有写者**、另一半是**硬编码常量**。
⇒ US2 要做的不是「接线」,是**先裁决每份状态的唯一所有者**,否则接线只会把两份并成三份。

支撑这一句的三条实测依据:

| # | 依据 | 判据 |
| :-- | :--- | :--- |
| 1 | `room.ts` **完全不认识**模拟层 | `git grep` → `room.ts` 含 `WorldSim`:false;含 `world_sim`:false |
| 2 | `room.ts` 的 `PlayerState` **没有 `level` 写者** | `git grep "\.level\s*="` 在 `room.ts` 命中 **0 处**;`join()` 只传 `name/x/y/z` |
| 3 | 模拟层的 `wearing` **无服务端来源** | `wearingOf` 读 `setMobPlayers` 灌入值,而 `playerById`/`syncPlayers` 往外报 `[]` |

---

## 1. 状态清单(每行一个状态)

列含义:
- **现在存在哪** — 实际字段路径(抗行号漂移:同时给唯一上下文片段)
- **谁写 / 谁读** — 只算**生产**调用点(`server/src` + `client/src`),判据见 §5
- **US2 权威** — 我的明确主张(不留「待定」)

### 1.1 生命值族

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `hp` | `VitalsSystem.players.get(id).hp`<br>片段:`v.hp = Math.max(0, v.hp - raw)` | `applyHit`(:403)、`heal`(:426)、`stepTimers` 回血(:452)、`revive`(:345) | `exportVitals`、`snapshot`、`effectiveMaxHp` 不算 | **写 4 条路径 / 读 4** | **`VitalsSystem` 唯一**。`room.PlayerState.hp` 降级为**只读投影** |
| `maxHp` | ① `VitalsSystem.maxHp`(构造常量 100)<br>② `progress.maxHp`(`statsAtLevel(L).maxHp`)<br>③ `RoomEffectState.onsenSec` 派生的倍率 | ①`constructor(maxHp)`<br>②`recompute()`(**纯函数**,返回新对象)<br>③`stepRoomEffects` | `effectiveMaxHp`(:2086)、`revive.ts` 三处 | ①1 ②1 ③2 | **`progression` 推导、`VitalsSystem` 持有**。⚠️ **三处打架**,见 §4.1 |
| `downed`(布尔) | `PlayerVitals.downed` | `applyHit` 置 true(:411);`revive` 置 false(:346) | `tickDowned`(:1708 消费它建泡泡) | 写 2 / 读 1 | **`VitalsSystem` 唯一**(「HP 归零」是瞬时判定) |
| `downed`(结构体) | `WorldSim.downedStates: Map<string, DownedState>`<br>片段:`private readonly downedStates = new Map<string, DownedState>()` | `tickDowned` 建/删/写 | `downedOf` | 写 1 / 读 1 | **`WorldSim` 唯一**。⚠️ 与上一行**同名不同义**,见 §4.2 |
| `iframeSec` / `sinceHurtSec` / `totalTaken` / `hitCount` | `PlayerVitals` | `applyHit`、`stepTimers` | 仅 `applyHit` 自用 | 1 | `VitalsSystem`(纯运行时,不落盘) |

### 1.2 成长族

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `level` | ① `PlayerProgress.level`<br>② `room.PlayerState.level`<br>③ `users.level`(DB) | ①`gainExp`(经 `applyShareResult`)、`setLevel`(**生产 0 调用**)<br>②**无写者**(见 §4.3)<br>③`savePlayerState` / `createUser` | ①`attackMob`/`revive`/`settleMobExp`<br>②`carryCapacityOf`<br>③`getUser` | ①2 ②0 ③2 | **`progression` 唯一**。`room` 与 DB 都是**投影** |
| `exp` / `totalExp` | `PlayerProgress` | `gainExp`(`recompute` 纯函数) | `gainExp` 自身 | 1 | `progression` |
| `dmgMul` / `carrySlots` / `talentFlags` | `PlayerProgress`(由 `recompute` 派生) | `recompute` | `attackMob`(经 `combatantStats`)、`carryCapacityOf` **另算一份** | 2 | `progression`。⚠️ `carrySlots` 有第二份实现,见 §4.4 |
| `weaponId` | ① `combatantStats().flags.weaponId`(**派生自 wearing 的第一个武器**)<br>② `room.PlayerState.weaponId`<br>③ `users.weapon_id` | ①`equipSummary` 内 `s.flags.weaponId = w.id`<br>②**无写者**<br>③`savePlayerState` | ①`attackMob`(:1393)<br>②网络编码<br>③`getUser` | ①1 ②0 ③2 | **`wearing` 派生,不独立存储**。⇒ ①②③ 全部改成投影 |

### 1.3 装备族(核心问题 #3)

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `wearing`(装备集合) | `WorldSim.mobPlayers[].wearing`<br>片段:`const p = this.mobPlayers.find((x) => x.id === playerId)` | **只由 `setMobPlayers` 灌入** —— 而它是**测试专用**(§4.5) | `wearingOf` | **生产写 0** / 读 2 | **必须是新结构(玩家档案)**。现在**没有任何生产写者**。⚠️ 语义是「**过滤无效项后取首个被认出的武器**」,不是集合、也不是 `[0]` —— 见 §4.11 |
| `playerById().afk` | `world_sim.ts` `return { id, x, y, z, facingDeg, afk: false, ... }` | **硬编码 `false`** | 无 | 0 | 应由 `room` 的 `memberPresence` 派生(那边**有**完整实现) |
| `playerById().heldItem` | 同上,`heldItem: 0` | **硬编码 `0`** | 无 | 0 | 新结构;`users.held_item_id` 已有列但只存不读回 |
| `playerById().wearing` | 同上,`wearing: []` | **硬编码 `[]`** | 无 | 0 | 同 `wearing` |
| `playerById().playingInstrument` | 同上,`playingInstrument: false` | **硬编码 `false`** | 无 | 0 | 新结构 |
| `syncPlayers()` 的 `wearing` | `wearing: [],`(第二处) | **硬编码 `[]`** | 无 | 0 | 同上 |

> **Lead 说的「`playerById` 一次硬编码 4 个字段」已复核确认** —— 4 个都列在表内,并补上 `syncPlayers` 那处共 **5 处硬编码**。

### 1.4 背包族(核心问题 #2 的重灾区)

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `users.inventory_json` | DB 列 `TEXT NOT NULL DEFAULT '{}'` | `savePlayerState`(仅 `users` 行更新) | `getUser` | 2 | **唯一的持久化真相**。但目前**零读写 API** |
| `inventoryTotals` | `room.ts` `private readonly inventoryTotals = new Map<string, number>()` | `applyItemTotalDelta` | `itemTotalOf` | 2 | ⚠️ **第三份**:只有**总量**,不是明细 |
| `grantedSources` | `room.ts` `private readonly grantedSources = new Map<string, Set<string>>()` | `grantItemSource` | `applyInventory` 校验 | 2 | 反作弊凭证,US2 保留在 room 侧 |
| 背包容量 | `room.ts:747` `return 8 + (lv - 1);` | **内联公式**(不 import `progression`) | `carryCapacityOf` | 1 | **应由 `progression` 派生**。⚠️ 第二份实现,见 §4.4 |

### 1.5 房间效果族

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `roomEffects` | `WorldSim.roomEffects: Map<string, RoomEffectState>`<br>片段:`private readonly roomEffects = new Map<string, RoomEffectState>()` | `tickRoomEffects`(慢帧 2Hz) | `effectiveMaxHp`、`roomEffectOf` | 写 1 / 读 2 | **`WorldSim` 唯一**。⚠️ **不落盘**,见 §4.6 |
| `onsenSec` / `inOnsen` / `inBedroom` / `inForge` | `RoomEffectState` 四字段 | `stepRoomEffects`(纯函数返回新 state) | `maxHpMulOf` | 1 | `WorldSim` 持有、`effects.ts` 判定 |
| `forgeUnlocked` | **不存储** —— `stepRoomEffects` 每帧返回 | — | `tickRoomEffects` 收进 `forgeUnlockedIds` Set | 1 | 现状已对:**只消费一次判定**,不在编排层重判 |

### 1.6 复活族

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `reviveProgress` | `WorldSim.downedStates.get(id).reviveProgress`<br>**不在 `vitals` 里** | `touchRevive`(纯函数,返回新 `DownedState`);`tickDowned` 写回 | 仅 `tickDowned` 自身 | 写 1 / 读 1 | **`WorldSim` 唯一**。⚠️ 权威定义在 `revive.ts`,存储与写回在 `WorldSim` |
| `BodyState` 泡泡状态 | 同上 `DownedState.state` | `createDowned` / `tickGhostBubble` | `tickDowned` | 1 | 同上 |
| `levelSnapshot` | `DownedState.levelSnapshot` | `createDowned` 时抓 | `revive.ts` 比 `levelUnchanged` | 1 | 同上 |
| `invulnSec` | `DownedState.invulnSec` | `tickInvuln`(**生产 0 调用**) | `isInvulnerable`(**生产 0 调用**) | **0** | ⚠️ 有实现无接线,见 §4.7 |

### 1.7 位置 / 速度

| 状态 | 现在存在哪 | 现在谁写 | 现在谁读 | 生产调用者数 | US2 应由谁权威 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `x,y,z` | `PhysicsWorld.bodies.get(id)`<br>片段:`this.bodies.set(id, b)` | `PhysicsWorld`(单点写入,:243) | `playerById`(实时读,不缓存) | 写 1 / 读 14 | **`PhysicsWorld` 唯一** ✅ 现状最健康的一个 |
| `facingDeg` | `body.facingDeg` | `PhysicsWorld` | `facingOf` | 1 | `PhysicsWorld` |
| `vx,vy` | `mobs/fsm.ts` 各 FSM 实例 | 各 FSM | 各 FSM | — | `PhysicsWorld`(**注**:FSM 自己有 `vx/vy` 副本,属 §4.8 待判) |
| `room.PlayerState.x,y,z` | `room.ts` `state.players[]` | `join()` 时播种 `spawn.x`;`applyMove` 更新 | 网络编码 | 2 | **投影** —— 必须由 `PhysicsWorld` 单向刷出 |

### 1.8 天气 / 时间

| 状态 | 现在存在哪 | 结论 |
| :--- | :--- | :--- |
| 天气 | **不存在** | `weather` / `Weather` / `season` 在**全部生产文件**中:非注释命中 **0 处** |
| 时间 / 昼夜 | **不存在世界时间** | `timeOfDay` / `dayNight` / `daylight` / `gameTime` / `worldTime`:非注释 **0 处** |
| `Clock`(注入式时钟) | `coop/rush_order.ts:40`、`net/anticheat.ts:76` —— **两个不同的 `Clock` 接口** | ⚠️ 见 §4.9 |

---

## 2. 核心问题 #1:**哪些状态有 ≥2 个写者?**

判据:同一语义在 ≥2 处被**独立赋值**,且两处之间**没有单一真相源**。

| # | 状态 | 写者 A | 写者 B | 是否已收敛 | 危害 |
| :-- | :--- | :--- | :--- | :--- | :--- |
| **W1** | `maxHp` | `VitalsSystem` 构造常量(100) | `progression.recompute`(`statsAtLevel(L).maxHp`,L30=535) | **否** | **可造出 `hp > maxHp`**,见 §3 |
| **W2** | `level` | `PlayerProgress.level` | `room.PlayerState.level`(**无写者**) | 否 | 网络同步的等级与战斗用的等级可永久不同 |
| **W3** | `downed` | `PlayerVitals.downed`(布尔) | `DownedState`(结构体,`downedStates` Map) | 部分(`tickDowned` 单向消费 vitals) | 两个同名状态,语义不同 |
| **W4** | `carrySlots` | `progression` 的 `statsAtLevel(L).carrySlots` | `room.ts:747` 内联 `8 + (lv - 1)` | **否**(仅在 L≤30 巧合相等) | 见 §4.4 |
| **W5** | 背包 | `users.inventory_json`(明细) | `room.inventoryTotals`(**只有总量**) | 否 | 两者可各自漂移 |
| **W6** | `hp` / `x,y,z` / `weaponId` | `VitalsSystem` / `PhysicsWorld` / `equipSummary` | `room.PlayerState` 同名字段 | **否** | 8 个交集字段全无同步通道 |
| **W7** | `Clock` 接口 | `coop/rush_order.ts:40` | `net/anticheat.ts:76` | 否 | 同类不同源,见 §4.9 |

> **Lead 提到的 3 处**(`forgeUnlocked` / 复活半径 / 等级权威)我**没有重复计入**:
> - `forgeUnlocked`:**已经是单一真相** —— 代码态下 `world_sim` 里 `inForge` 命中 **0 处**,
>   编排层只做 `if (r.forgeUnlocked) add` / `else delete`(`:2059-2060`),即**只消费 `effects.ts` 的返回判定**
>   ⇒ **已被修好**
> - 复活半径:**已被修好** —— 代码态下 `bestDist <= TOUCH_RADIUS` 命中 **0 处**。
>   `:1745` 那段是**告诫注释**(「不要在这里加预检查 —— 我加过,是缺陷」)
> - 等级权威:**确认为真** ⇒ 计入 **W2**

**⇒ 我在 Lead 的 3 处基础上另找到 4 处新双写者(W1 / W4 / W5 / W7),并确认其中 2 处已修好。**

**⚠️ 我自己在这一条上踩了两次坑,记录以免后来者重犯**:
上面两条「已修好」的第一版判定,我用「排除行首 `*`」来去注释 —— 而 `:1745` 是
`/* ⚠ **不要在这里加...`,以 `/*` 开头而非 `*`,**没被排除** ⇒ 把**告诫注释误报成缺陷**。
⇒ 教训:**去注释必须按块注释状态机,不能按行首字符**。而且我误报的那一行,
内容恰恰是「不要这么做」—— 误读方向完全相反。

---

## 3. W1 的实证:能造出 `hp > maxHp`

**实测**(`scripts/_np_maxhp.ts`,已删):

```
t.vitals.revive('p1', 535)  →  hp=535  maxHp=100
⇒ hp > maxHp = **true**
```

链条:
1. `revive.ts:202/267/307` → `const maxHp = input.progress.maxHp;`(取 progression 的 535 @L30)
2. `revive.ts:218` → `hpAfter: Math.round(maxHp * ratio)`
3. `vitals.ts:345` → `v.hp = hp ?? v.maxHp;` —— **`vitals` 侧无任何钳制**
4. 但 `importVitals` 有一条注释明确会钳:`const hp = Math.max(0, Math.min(v.maxHp, row.hp));`

⇒ **同一个 `revive` 入口,「读档」路径有钳、「复活」路径没钳。**

**⚠️ 可达性的诚实分级**(我第一版写「L>1 即可」,**过强,已修正**):

| 层级 | 结论 | 判据 |
| :--- | :--- | :--- |
| **单元层** | **已实测可达** | `t.vitals.revive('p1', 535)` → `hp=535 maxHp=100` ⇒ `hp>maxHp` 为真 |
| **前置条件** | 已实测成立 | `statsAtLevel(L).maxHp` 在 **L=2 就是 115 > 100**;L30 = 535 |
| **端到端** | **未实测**(列入 §6 U8) | `progress.maxHp` 要 >100,须 `progresses` 里那份真到 L2+;而 `setLevel` 是**纯函数**(实测 `setLevel(prog,30)` 返回新对象,`s.progressOf('p1')` 仍是 L1) |

⇒ **WorldSim 内我未找到「把等级写进 `progresses`」的直接入口** —— 等级只能靠击杀经验
(`applyShareResult`)涨。要证端到端可达需跑完整击杀链路,**我未跑** ⇒ 归入未实测。

---

## 4. 逐条争议与「我认为 / 我实测」分界

### 4.1 `maxHp` 三处定义(实测)

| 来源 | 取值 | 判据 |
| :--- | :--- | :--- |
| `VitalsSystem` 构造 | **100 恒定**(`PLAYER_BASE_HP`) | `s.vitals.get('p1').maxHp` = 100,且 L30 后仍是 100 |
| `progression.recompute` | `statsAtLevel(L).maxHp`(L1=100 / L10=235 / L30=535) | `setLevel` 后 `progress.maxHp` 随动 |
| `effects.maxHpMulOf` | 1.0 基准,温泉 ×1.3 | `ONSEN_MAX_HP_MUL = 1.3` |

**实测**:把 `progress` 升到 L30 后,**`vitals.maxHp` 纹丝不动仍是 100**。
⇒ 「等级提升」与「血量上限」之间**没有连接**。

### 4.2 两个 `downed` 是不同的概念(读码 + 实测)

- `vitals.downed: boolean` = 「HP 归零」的**瞬时判定**
- `downedStates: Map<id, DownedState>` = 判定**之后**的持续状态(泡泡/读条/无敌)

`tickDowned` 的注释明确写了这个分工(:1685-1692),代码也一致。
**⇒ 这一处不是缺陷,但两个同名标识符会误导后来者。建议 US2 改名区分。**

### 4.3 `room.PlayerState.level` 没有写者(读码,判据明确)

```
git grep "\.level\s*=" -- server/src/net/room.ts   → 0 处
join() 只传: createPlayerState(userId, { name, x, y, z })
createPlayerState 默认: level: 1
```
⇒ **房间里所有玩家的网络层等级永远是 1**,除非有人 `.push()` 一条假记录。

### 4.4 `carrySlots` 的第二份实现(实测,含我自己的错)

`room.ts:740-747` 自述:「本方法内联同一公式而非 import …… 两者数值必须一致,由 `tests/WS-07.test.ts` 钉住」。

**实测对照**(比的是 room 的**原文**):

| `lv` | room 原文 `8+(lv-1)` | `statsAtLevel(lv).carrySlots` | 一致? |
| ---: | ---: | ---: | :--- |
| 1 | 8 | 8 | ✓ |
| 30 | 37 | 37 | ✓ |
| **31** | **38** | **37** | **✗** |
| **100** | **107** | **37** | **✗** |

⇒ **L>30 不一致**。`statsAtLevel` 对越界是**静默钳到 30**,room 内联版是**静默外推**。

**⚠️ 我自己的错(记录在此)**:第一版探针把两边**都钳了**再比,得到「全部一致」——
那是**同义反复**(期望值取自被测量本身)。这与我此前在 WS-07 犯的
`parseInt(version) >= 0` 恒真是同一类。**已修正为比原文。**

**配套的测试也犯了同一病**(读码):`WS-07.test.ts:2788`
```
eq(rt.carryCapacityOf('atk'), 8, 'Lv1 容量应为 8(8 + (L-1))');
```
**只测 Lv1** —— 单点测量,恰好落在两实现重合的那个点。
⇒ 这正是 Lead 点出的「单点不能区分封顶与非线性」。**若测 Lv31 会红。**

### 4.5 `setMobPlayers` —— 装备的唯一入口是测试专用(实测)

```
setMobPlayers  [生产] 0 处   [测试] 5 处
attackMob      [生产] 1 处(定义)   [测试] 62 处
```
⇒ `wearing` 从 `setMobPlayers` 进,而**没有任何生产代码调用它**。
`attackMob` 的 `opts.wearing` 覆盖参数同理(注释自述「本入口现在只有测试与 scripts 调用」)。

### 4.6 `roomEffects` 不落盘(实测 + 读码)

```
repo.ts    含 roomEffect: **false**
schema.sql 含 room_effect: **false**
exportVitals 含 roomEffect 字段: **不含**
```
`exportVitals()` 的**类型签名**是覆盖面本身:
```ts
Record<string, { hp: number; maxHp: number; downed: boolean }>
```
⇒ 结构上就没有 `roomEffects` / `reviveProgress` / `progress` / `wearing` 的位置。

**这与 build-wiring 的「存档往返后 `roomEffects` 不落盘,重进世界温泉计时归零」一致。**
⇒ **已知权威缺口,予以记录,不在此修。**

### 4.7 `tickInvuln` / `isInvulnerable` 生产 0 调用(实测)

```
tickInvuln     [生产] 0  [测试] 2
isInvulnerable [生产] 0  [测试] 0
```
⇒ `DownedState.invulnSec` 有写无读无驱动。**归入 §6 未实测/待判。**

### 4.8 FSM 自带 `vx/vy`(读码)

`mobs/fsm.ts` 每个 FSM 实例有 `vx`/`vy` 字段并自行积分 `this.x += this.vx * dt`。
⇒ 与 `PhysicsWorld` 的刚体是**两条积分路径**。
**我未实测它们在生产里是否会同时驱动同一个实体** ⇒ 列入 §6。

### 4.9 两个 `Clock` 接口(实测)

```
coop/rush_order.ts:40   export interface Clock { ... }
net/anticheat.ts:76     export interface Clock { ... }
```
两者**同名不同源**。`social/afk.ts:14` 用的是 `rush_order` 的 `Clock`;
`net/anticheat.ts` 用自己那个。⚠️ 但两者可能结构兼容(结构化类型)—— **未实测**。

### 4.10 重连往返:哪些状态活下来(实测)

以真实 `exportVitals` → `importVitals` 往返:

| 状态 | 往返后 | 判据 |
| :--- | :--- | :--- |
| `hp` | **保住** | `{hp:36}` → 新世界 `hp=36` |
| `downed` | **被清成 `false`** | `{downed:true}` → 新世界 `downed=false` |
| `reviveProgress` | **丢失** | 不在签名里 |
| `BodyState` 泡泡 | **丢失** | 同上 |
| `roomEffects` | **丢失** | 同上 |
| `wearing` / `progress` / 位置 | **丢失** | 同上 |

**⚠️ 一个值得注意的实测结果**:倒地玩家(`hp:0, downed:true`)重连后是 **`hp=0, downed=false`**
⇒ **既没死也没活**,处于一个 `vitals` 认为正常、但血量为 0 的状态。
`importVitals` 的注释说明这是**刻意**的(:2135-2136「否则玩家一上线就是倒地不起」),
但代价是**「hp=0 且 downed=false」这个组合没有任何代码路径负责**。

---

## 4.11 复核补正 A:`wearing` 的语义要更精确(Lead 找出反例)

我原报「不是纯集合,是**取第一个武器的有序列表**」。**方向对,但我说成了 `[0]`,漏掉跳过语义。**

**判据(实测)**:

| 输入 | 结果 |
| :--- | ---: |
| `[711]` | 31 |
| `[712]` | 76 |
| `[711,712]` | 31 |
| `[712,711]` | 76 |
| `[711,712,1,999999]` | **31**(与 `[711,712]` 完全相同) |
| `[712]×3` | 76(去重安全) |

⇒ **准确表述:取第一个*被认出的*武器** —— 中间的无效项被**跳过**而非中断。
`equipSummary` 源码可证:`if (w && !weaponTaken)` —— `w` 为 undefined 时不置 `weaponTaken`,继续循环。

**⇒ 对 US2 的直接含义**:接线时要「**过滤无效项后取首**」,不能简单写 `wearing[0]`。
(可安全去重;不可排序。)

## 4.12 复核补正 B:「怪物打人无钳」的危害半径要收窄(Lead 纠正,我复算)

我原措辞「**怪物打人无钳!** `level 1e9 → 2000000004`」会被读成「玩家会掉荒谬的血」。**不是。**

| 行 | 表达式 | 实测结果 | 是否钳 |
| :--- | :--- | :--- | :--- |
| `vitals.ts:403` | `v.hp = Math.max(0, v.hp - raw)` | `hp = 0` | **已钳(钳在 0)** |
| `vitals.ts:406` | `v.totalTaken += raw` | `2000000004` | **未钳** |
| `vitals.ts:416` | `this.totals.damage += raw` | 累计 | **未钳** |
| `vitals.ts:408` | `base.applied = raw` | **`2000000004`** | **未钳 ← 我找到的第三个** |

**⇒ 真实危害是「统计字段吸收荒谬值」,不是「玩家掉荒谬的血」。**
而 `applied` 是**调用方拿到的返回值**,比 `totalTaken` 更容易外流到网络/存档。

**可达性(决定性质)**:冻结层 `mobs.ts` 24 个 level∈[1,25]、`bosses.ts` 8 个 ∈[5,30]
⇒ 生物最大等级 **30** ⇒ `mobHitDamage(30) = 64`。**当前内容不可达。**
**⇒ 定性:「缺少守卫的契约缺陷」,不是「当前可利用缺陷」。** 修法:入口加钳 + 断言。

### 4.12.1 ⚠️ 我修正 Lead 的一个数值(他的担忧方向对,数字不成立)

Lead 判「`2000000004` 距 `INT32_MAX` 差 1.4e8 ⇒ 会溢出为负」。**实测不成立**:

```
mobHitDamage(1e9)  = 2000000004
INT32_MAX          = 2147483647
⇒ 未溢出,余量 147483643(1.5e8)

二分实测真阈值(公式 4 + 2·level):
  最小溢出 level = 1073741822  → mobHitDamage = 2147483648
  1073741821     → 2147483646(仍不溢出)
```

**⚠️ 而且我在这一条上犯了自己第 7 个错**:第一版探针里我把结论**写在了计算之前** ——
输出明明打印「是否溢出? = 否」,而我上一句已写成「已经越过」。**已修正。**

**但 Lead 的结论仍成立,只是理由要换**:风险不是溢出,是 `applied` / `totalTaken`
吸收 2e9。不过 int32 值得记一条**前瞻性**理由 —— 阈值 `1.07e9` 相对内容上限 30 只有约 `3.6e7` 倍,
一旦「等级」改成从报文读(US2 正要这么做),**越过它只需要一个数字**。

### 4.12.2 Lead 未验证项 —— 我已补测(行为层)

Lead 试了两次「大 level 时玩家掉血」都得到 `100 → 100`,据此无法判定。**根因是他的调用签名错了**:

```
正确: applyHit(attackerId, playerId, level, mul = 1.0, distance = 0)
Lead: applyHit('p1', 1e9)   ⇒ attackerId='p1', playerId=1e9
     ⇒ 玩家 1e9 不存在 ⇒ :388 `if (!v) return base` 早早返回 ⇒ applied=0
```

**⇒ `100→100` 是「玩家不存在」,不是「伤害被钳」** —— **两个不同原因产生同一观测**,
这正是本仓反复出现的「判据取自不完整观察」。

**正确签名的实测**:

| `level` | `mobHitDamage` | `applied` | `hp` 之后 | `totalTaken` |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 6 | 6 | 94 | 6 |
| 30 | 64 | 64 | 36 | 64 |
| 100 | 204 | 204 | 0 | 204 |
| 1e6 | 2000004 | 2000004 | 0 | 2000004 |
| 1e9 | 2000000004 | 2000000004 | **0** | **2000000004** |

⇒ **行为层证实**:`hp` 侧确实钳在 0(不再只是读码判定);`applied` / `totalTaken` 侧确实无钳。

---

## 5. 方法论:我的判据是怎么定的

| 结论类型 | 判据 | 为什么不用别的 |
| :--- | :--- | :--- |
| 「生产调用者数」 | 代码态(剥注释+字符串)下 `name(` 且**排除定义行 / import 行**;`this.x.name(` **计入** | 只按字符串搜会把定义、注释、import 都算进去(我前两版都错了) |
| 「硬编码」 | 字面量直接赋值,且非 `??` 兜底 | `p?.wearing ?? []` 是**兜底**不是硬编码,两者危害不同 |
| 「无钳制」 | **多点扫描**:至少 5 个量级点 + 两侧边界 | 单点无法区分「封顶」与「非线性」(Lead 教训) |
| 「不存在」 | 全部生产文件**非注释**命中 0 | 只搜一个文件会漏 |
| 「不落盘」 | ①DDL 无列 ②repo 无函数 ③**导出签名无字段** | 三者任一不满足都可落盘 |

**我这轮自己犯并修正的 7 个错**(全部记录,避免下一个人重犯):

1. **调用点统计把方法定义算成调用** —— 第一版报 `applyHit 生产 1 处`,那其实是定义行
2. **过度纠正**:第二版加了 `[^\w.$]` 排除了 `.`,把 `this.vitals.applyHit(` 全漏掉,变成 `生产 0 处`
3. **块注释没跨行剥离** —— 按行剥离导致多行注释内的 `attackMob(` 被算成调用
4. **同义反复**:`carrySlots` 对照把两边都钳了再比 ⇒ 恒真(同 §4.4)
5. **告诫注释被误报成缺陷**:用「排除行首 `*`」去注释,漏掉 `/*` 开头的块注释,
   把 `:1745`「**不要**加预检查」的告诫读成了「有预检查」(§2 末)
6. **可达性结论过强**:把「单元层实测可达」写成了「L>1 即可」(§3 已分级修正)
7. **结论先于计算**:§4.12.1 里输出打印「是否溢出? = 否」,而我上一句已写成「已经越过」
   —— 被同一段输出当场否掉。**另加**:§4.11 把「取第一个*被认出的*」简化成了 `[0]`。

**⇒ 5 / 6 / 7 是同一天内反复犯「结论先于判据」;1–4 是同一天内第四次犯
「定义/调用/注释不分」。** ⇒ 结论:**本仓的多数误判不是来自领域复杂,而来自词法层与
取证顺序不严谨。**

**⇒ 两条可操作的修法**(Lead 也独立踩到同型并给出同向解法):
- **去注释必须用块注释状态机**,不能按行首字符判断
- **探针要先自证**:拿一个已知答案的样本校验探针本身(Lead 的做法:
  `world_sim.ts` 应命中 >10 处才继续),否则探针的 bug 会伪装成世界的 bug

---

## 6. 未实测项(单列,不得当结论)

| # | 项 | 为什么未实测 |
| :-- | :--- | :--- |
| U1 | `room.level > 30` 在生产是否**可达** | `room.ts` 无 `.level =` 写者,故只能由 DB/报文灌入;需要沿网络入口追,超出本次只读盘点范围 |
| U2 | `roomEffects → effectiveMaxHp` 在生产**被谁消费** | `effectiveMaxHp` 的调用者我没数清(它自身在 `world_sim` 内) |
| U3 | FSM 的 `vx/vy` 与 `PhysicsWorld` 是否**同时驱动同一实体** | 需要跑多帧对轨迹,本次未做 |
| U4 | 两个 `Clock` 接口是否**结构兼容** | 未做类型层对照 |
| U5 | `saveVitalsToUsers` / `loadVitalsFromUsers` 的**完整落盘范围** | 只确认了 `exportVitals` 的签名;未逐列核对 DB 写入 |
| U6 | `mobPlayers` 与 `physics.bodies` 的**生命周期是否一致**(谁先删) | 未追 `removePlayer` 路径 |
| U7 | `inventoryTotals` 在有 DB 时是否**真的以库为准** | 注释说「`db === null` 时参与计算」;未实测 |
| U8 | W1(`hp > maxHp`)**端到端**是否可达 | 单元层已实测可达;端到端需 `progresses` 里那份真到 L2+,而 `WorldSim` 内无直接写等级的入口 ⇒ 需跑完整击杀链路(未跑) |
| U9 | `applyShareResult` 涨级后 `vitals.maxHp` 是否被同步 | 同上:需真击杀 |
| U10 | `room.ts:747` 内联公式在**生产**是否可被喂到 `lv > 30` | `room.ts` 无 `.level =` 写者 ⇒ 只能由 DB/报文灌入;未沿网络入口追 |
| U11 | `mobHitDamage` 的常数项为何是 **4** 而非 `MOB_HIT_BASE=6` | 实测拟合 `4 + 2·lv` 六点零误差;源码常量是 6 ⇒ 说明 lv 在某处起算有偏移,**未细查** |

---

## 7. 核心问题 #2 / #3 / #4 的直接回答

### #2 哪些状态**没有任何生产写者**?

| 状态 | 判据 |
| :--- | :--- |
| `room.PlayerState.level` | `room.ts` 内 `.level =` 命中 **0 处** |
| `room.PlayerState.hp` / `maxHp` | 同上,无写者;只有 `createPlayerState` 的默认值 |
| `room.PlayerState.weaponId` | 同上 |
| `wearing`(**生产侧**) | `setMobPlayers` 生产调用 **0 处** |
| `DownedState.invulnSec` | `tickInvuln` 生产调用 **0 处** |
| `users.inventory_json` | 有列、有类型、`getUser` 能读,但**无任何写 API**(只有 `savePlayerState` 整行更新) |

### #3 哪些状态被硬编码成常量?

| 位置 | 硬编码 | 值 |
| :--- | :--- | :--- |
| `playerById()` | `afk` | `false` |
| `playerById()` | `heldItem` | `0` |
| `playerById()` | `wearing` | `[]` |
| `playerById()` | `playingInstrument` | `false` |
| `syncPlayers()` | `wearing` | `[]` |
| `createPlayerState()` | `level` / `hp` / `maxHp` / `weaponId` / … | `1` / `100` / `100` / `0` |
| `VitalsSystem` 构造 | `maxHp` | `PLAYER_BASE_HP = 100`(恒定,不随等级) |

### #4 权威归属主张(不留「待定」)

| 状态族 | **US2 唯一权威** | 其余角色 |
| :--- | :--- | :--- |
| `hp` / `downed`(布尔) / 无敌帧 | **`VitalsSystem`** | `room` = 只读投影 |
| `level` / `exp` / `maxHp` 基准 / `carrySlots` | **`progression`** | `room` / DB = 只读投影;**删除 `room.ts:747` 内联公式** |
| `wearing` / `heldItem` | **新结构「玩家档案」**(现在不存在) | `room` = 投影;`vitals` / `combatantStats` = 消费 |
| `weaponId` | **不存储**,由 `wearing` 派生 | 三个存储点全部改投影 |
| `x,y,z` / `facingDeg` | **`PhysicsWorld`** ✅ 现状已对 | `room` = 投影 |
| 背包明细 | **`users.inventory_json`** | `room.inventoryTotals` = 缓存;`grantedSources` = 反作弊凭证 |
| 复活读条 / 泡泡 | **`WorldSim.downedStates`** | `revive.ts` = 纯规则;`vitals` = 只给瞬时判定 |
| `roomEffects`(温泉等) | **`WorldSim`** | `effects.ts` = 纯规则;**需要新加落盘**,否则 §4.6 缺口常在 |
| AFK / 在线状态 | **`room.memberPresence`** ✅ 现状已对 | `world_sim` 的 `afk: false` 硬编码应改为读它 |

**一条贯穿全表的裁决原则**(我主张写进 US2 设计):

> **纯函数拥有规则,持有者拥有状态,网络层只投影。**
> 本仓已经有一半模块是这个形状(`revive.ts` / `effects.ts` / `progression.ts` 都是纯函数),
> 缺陷全部出在**「持有者」缺席**的地方 —— 于是每个消费者自己造一份。

---

## 8. 复现方式

所有数字来自临时探针(`scripts/_np_*.ts`,**已全部删除**)。核心命令形状:

```powershell
# 生产调用点计数(需 "定义 vs 调用" 判别,简单 grep 会错)
git grep -n "setMobPlayers" -- "server/src" "tests"

# 多点扫描(必须多量级,不能单点)
node <探针>.ts   # new WorldSim + addPlayer + setMobPlayers + addMob + attackMob({...})

# 重连往返
const dump = s.exportVitals();  t.importVitals(dump);
```

**行号漂移提示**:本仓 `world_sim.ts` 正被并发编辑(18:28 有写入)。
表中所有条目已改用**唯一上下文片段**定位(如 `private readonly downedStates = new Map<string, DownedState>()`),
可用 `grep` 反查,不依赖行号。