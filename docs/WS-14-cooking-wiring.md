# WS-14 · 料理站接线(生产路径真的做菜)

> **本文件的存在理由**:`cooking.ts` 的接线完成后,白名单条目被摘除(它变成
> 「可达」),**但全仓没有任何套件断言那处接线**。本套件补的是这段。
> 详见本文 [验收](#验收为什么单独立套件) 一节。

| 项 | 值 |
| :--- | :--- |
| 套件 | `tests/WS-14.test.ts` |
| 断言数 | 8(6 条正例/守恒 + 4 条负对照 + 1 条入口存在性,含否认对照) |
| 被测生产路径 | `WorldSim` 慢帧 `tickLogisticsStep()` → 机械臂 → 506 汤锅 |
| 依赖 | `server/src/combat/cooking.ts`、`server/src/wiring/logistics.ts`、`server/src/sim/world_sim.ts` |
| 零外部依赖 | 是(只用 `shared/testing/harness.ts` + 实现层) |

## 职责边界

**本套件负责**:料理站(`cooking.ts`)在**生产运行时**是否真的被调用、投料是否记账、
出锅是否落地、灭火与断电等边界是否守住。

**本套件不负责**:

| 交给谁 | 内容 |
| :--- | :--- |
| `tests/WS-06.test.ts` | 炼金炉(LLM 门禁 / 配方哈希缓存 / 五步属性算法 / 16×16 像素立牌) |
| `tests/WS-10.test.ts` | 战斗伤害管线、成长曲线、幽灵泡泡救援 |
| `tests/WS-08.test.ts` | 魔能电路推进器与物流组件本身的行为 |
| `tests/WS-FND-04/06` | `FOODS` 数据与手册数据的**内容一致性** |

**为什么与 `WS-06` 分家(而不是并入)**:两者只在
`server/src/combat/cooking.ts` 的**数据表**(`FOODS`)上重叠。`WS-06` 测的是
**炼金**(一个 LLM 驱动的生成系统),本套件测的是**料理灶台的运行时接线** ——
这是两个概念。混在一个套件里会让「炼金炉」与「汤锅」互相干扰,
后来者排查失败时也分不清是数据错了还是接线断了。

> 附带原因:并入当时 `tests/WS-06.test.ts` 归 task-31 独占(写域冲突)。

## 接口

生产侧三个入口,全部由 `WorldSim` 暴露:

```ts
/* 站状态查询 —— 只读,不改变世界 */
WorldSim.stationState(deviceId: number): KitchenState

/* 玩家路径:从 (x,y) 的地面堆里取货投进站 */
WorldSim.feedStationAt(deviceId: number, x: number, y: number, maxCount = 1): number

/* 灭火 —— 置 fireOut,使该站不再收料 */
WorldSim.extinguishStationAt(deviceId: number): void
```

`cooking.ts` 侧被调用的纯函数:

```ts
createKitchenState(): KitchenState
feedStation(k: KitchenState, itemId: number, count: number): number  /* 永远收货,满则挂号待出锅 */
tryCook(k: KitchenState, deviceId: number): CookResult
potCount(k: KitchenState): number
```

**接口契约(本套件断言的)**:
- `feedStation` **永远接受**货物 —— 不接受的后果是丢货(见 [算法](#算法为什么必须永远收货))。
- `feedStationAt` 的返回值 = **实际从地面取走的件数**,必须与地面减少量一致。
- 出锅产物**必须落到地面**(而不是留在返回值里)。
- `fireOut` 为真时 `feedStationAt` 返回 **0** 且不记账。

## 数据结构

```ts
interface KitchenState {
  readonly deviceId: number;
  fedTotal: number;          /* 累计投料件数(对账用) */
  cooked: number;            /* 累计出锅次数 */
  lastItemId: number;        /* 最近一次出锅的菜品 ID(0 = 还没出锅) */
  fireOut: boolean;          /* 火被浇灭 —— 此后不再收料 */
  pot: Map<number, number>;  /* 锅内现有原料:物品 ID → 件数 */
}
```

**为什么 `fedTotal` 与 `pot` 必须分开**:`fedTotal` 是**单调累计量**(只增),`pot` 是
**当前存量**(进出都有)。只断言前者会让「货进去又立刻被扣回去」这种情况全绿;
只断言后者则无法对账。「投料 5 件 / 锅内残留 0 / 地面 1 份成品」三条一起才闭合。

## 算法

### 为什么必须「永远收货」

接线前的真实缺陷:`feed()` 只 `return true` 就丢货。机械臂把 5 件材料投进锅里,
**地面变成 0 件、锅内也是 0 件、不报错、不落账** —— 一个静默的物品黑洞。

`logistics.ts` 的 `ARM_TARGETS = [503, 506, 508, 536, 425, 429, 437]` **含 506 汤锅与
508 披萨炉**,而机械臂接线后**真的会往这些坐标投料**。所以这条路径**今天就在跑**。

⇒ 因此 `feedStation` **无条件接受**货物并记进锅内。配不齐配方时料**留在锅里**,
玩家可以继续补料 —— 这比丢货正确,也比报错友好。

### 出锅与扣料

```
投料 → 锅内 pot 累加,同时 fedTotal 累加
      ↓ 每次投料后尝试结算
      ↓ 配方齐备 ⇒ cooked += 1,lastItemId = 菜品 ID,pot 扣除该配方用量
      ↓ 产物**落地**为 groundItem
```

**关键**:扣的是**配方声明的用量**(如 104×1 + 124×2 + 121×2),不是「锅里全部」。
这保证玩家多投的料会留着,不会被一次出锅吞掉。

## 参数

| 参数 | 值 | 出处 |
| :--- | ---: | :--- |
| 汤锅 ID | `506` | `cooking.ts` 的 `SOUP_POT_ID` |
| 切菜台 ID | `507` | `KITCHEN_TABLE_ID`(无 cook 入口) |
| 披萨炉 ID | `508` | 有数据,无 cook 入口 |
| 正常配方 | `104×1 + 124×2 + 121×2` | 手册正常配方 |
| 产物 | `604` 星光萤火蘑菇汤 | 手册 |
| 机械臂抓取批次 | `ARM_BATCH` | `logistics.ts` |
| 测试跑帧数 | `800`(80 慢帧 / 20 个机械臂循环) | 本套件,足够投完 5 件料 |

## 性能

本套件 8 条断言,**全套跑完 < 1.5 秒**(含 2 次 800 帧模拟)。模拟本身是
`WorldSim({ sizeCells: 32, mobs: false })` —— **关掉生物**是刻意的:本套件测的是
物流与料理,**生物 AI 会引入无关的随机性**,让断言在「生物恰好挡住机械臂」时抖动。

`potCount(k)` 是 `O(pot 条目数)`,而锅内最多只有配方用量的条目数(个位数),故无热点。

## 边界

| 边界 | 行为 | 断言 |
| :--- | :--- | :--- |
| 投料**不足**(只有 1 件) | 不出锅,料**留在锅内** | `C1` |
| 机械臂**断电** | 完全不投料,地面件数不变 | `C2` |
| 火被**浇灭** | 不再收料、不记账、不出锅,货留在地面 | `C3` |
| **无 cook 入口**的站(507) | 照常收料,但**不产出**(真实欠账,未伪造) | `C4` |
| 出锅**产物落地** | 必须落到玩家能取的地方,不能卡在锅里 | `A2` |
| 接线**入口存在性** | `stationState`/`feedStationAt`/`extinguishStationAt` 必须都在 | `D1` |

## 耦合

```
WorldSim.tick()                        (20Hz)
  └─ 慢帧分支(2Hz)
       └─ tickLogisticsStep()
            └─ 机械臂动作
                 ├─ stationState(deviceId)      ← cooking.ts
                 ├─ feedStation(k, id, n)       ← cooking.ts
                 └─ tryCookAt(deviceId)         ← cooking.ts 的 tryCook
                      └─ 产物落地 → groundItems
```

**耦合面收敛于 `WorldSim` 的三个公开入口**。本套件**不 import `logistics.ts` 的内部**,
只通过 `WorldSim` 驱动 —— 这样重构物流内部不会让本套件假红。

**已知的外部耦合**:`cooking.ts` 的 `FOODS` 同时被 `WS-FND-04` / `WS-FND-06` 用于
**内容一致性**比对。若改 `FOODS` 数据,那两个套件会先行报警 —— 本套件只关心
**运行时行为**,数据一致性由它们守。

## 验收:为什么单独立套件

### 那个实测出来的门禁缺口

接线完成后,`cooking.ts` 的白名单条目被摘除(门禁认为它「可达」)。
但**可达 ≠ 被调用** —— 可达性门禁只查「能不能走到」。

实测(全仓 19 个套件):

```
stationState            无任何套件引用
feedStationAt           无任何套件引用
extinguishStationAt     无任何套件引用
tryCookAt               无任何套件引用
feedStation             无任何套件引用
```

`WS-10` / `WS-FND-04` / `WS-FND-06` 对 `cooking.ts` 的引用**只是 `import { FOODS }`**
拿数据比对手册。**⇒ 回退那处接线,门禁会全绿。**

### 本套件的验收标准

1. **先证明生产不通**:接线前同一条 A1 断言跑出红,原文留在 task-39 报告里。
2. **逐条有区分力**(实测,三种注入):

| 注入(用**改名/删调用**形式) | 结果 | 命中的断言 |
| :--- | :--- | :--- |
| 机械臂不再往锅里记账(= 接线前丢货行为) | **6/8 红** | `A1` `A2` |
| `tryCookAt` 不再真的出锅 | **5/8 红** | `A1` `A2` `B1` |
| 出锅产物不落地 | **7/8 红** | `B1` |
| 删掉 `stationState` 定义 | **0/8 红** | `D1` + 全部 |

三种注入的还原**均 SHA-256 逐字节一致**。

3. **负对照必须存在**:`C1`–`C4` 就是。没有它们,「修复」与「断言恒真」无法区分。

4. **不许伪造成绩**:`C4` 钉住 507/508 的**真实欠账**(有 `FOODS` 数据、无 cook 入口)。
   等哪天有人实现了 508 披萨炉,`C4` 会红 —— 那时**应改成「508 真的出锅」的正例**,
   而不是删掉它。

### ⚠️ 一条值得复用的注入教训

本套件做故障注入时,第一版用「**在定义前插入同名方法**」的方式注入
(`feedStationAt(..._) { return 0; }` 插在真定义之前)—— **结果 8/8 全绿,注入静默失效**。
根因:类体里出现**两个同名成员,后者胜**,真实现把注入覆盖了。

**⇒ 可复用的结论**:故障注入若用「插入」形式,**必须先确认不会与既有定义重名**;
用「**改名 / 删调用 / 改字面量**」形式更可靠 —— 它们与既有定义**互斥**,
不会出现「注入了但没生效」。

## 未决

1. **507/508/505 有 `FOODS` 数据但没有 cook 入口**。`cookSoup` 只实现了 506 汤锅。
   508 披萨炉现在**只收货、不出锅**(`C4` 钉住)。这是**真实欠账,不是遗漏** ——
   我没有伪造 508 的产出。立项时需先定「508 的配方与产物从哪来」。

2. **菜品没有任何玩家侧的 buff 消费容器**。`combat/weapons.ts:813` 的 `combatantStats`
   是全仓唯一 buff 汇,**生产调用点 0**;`vitals.ts` / `damage.ts` / `physics/world.ts`
   均无 buff 概念。⇒ 菜**只作为掉落物落地**,增益不被消耗。
   这需要**新数据结构**(见 `docs/ADVERSARIAL-REVIEW-12.md:331`),超出本套件范围。

3. **`GroundItem` 字段名双写**:接口声明 `{id}`(`mobs/behaviors.ts:46`),但生产写入侧
   写 `{itemId}`。实测 `setGroundItems([{id:151,...}])` 后 `consumeGroundItem(151,3)`
   返回 **0**(期望 3)。`world_sim.ts` 用 `groundItemId()` 兼容两侧修好了**读**,
   但**写入侧仍双写**。**根治需统一字段名** —— 影响所有掉落物,不止料理。

4. **`take()` 取整叠却只扣 1 件**(task-37 遗留):「地上少 1、手里报 2」⇒ 5 件料
   投出 8 件的账。已改为 `Math.min(g.count, ARM_BATCH)`,但同类**口径不一致**
   是否还有别处,未系统排查。
