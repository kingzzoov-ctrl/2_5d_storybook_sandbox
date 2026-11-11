# WS-08 魔能电路系统 · 四色信号网络 · 逻辑件与自动化物流

> 工作流编号:WS-08
> 代码位置:`server/src/wiring/{graph,components,logistics}.ts`
> 测试:`tests/WS-08.test.ts`(63 条断言,全部通过)
> 上游依赖:WS-01(32 位单元 `WIRE` 位段 12..15)、冻结层 `shared/types/{tile,physics}.ts`、`shared/constants/items.ts`(物品 401~440)
> 下游消费:WS-06(炼金产线的机械臂投喂)、WS-10(防御炮台)、WS-11(派对竞技与载具)

---

## 1. 职责边界

### 1.1 本模块负责什么

把「玩家铺下的四色线 + 摆下的逻辑件」变成一个**每 2Hz 推进一次的离散事件系统**:

1. **四色信号网络(`graph.ts`)** —— 维护红/蓝/黄/绿四个**互相独立**的信号平面。同色线四邻相连即构成一个导电网络;网络内任意一格被驱动,整网通电。不同颜色永不串扰。
2. **逻辑件行为(`components.ts`)** —— 401~440 共 40 项电路物品的行为实现,含传感器、逻辑门、显示、无线、执行器、农业水利、防御、物流、氛围/竞技/载具九组。
3. **自动化物流(`logistics.ts`)** —— 传送带、分拣器、机械臂、采矿钻头的**纯函数式**推进逻辑,不依赖图结构,便于单测与回放。
4. **脏网络增量优化** —— 结构不变时只重算受影响的连通分量,是全模块最重要的**性能**手段。

### 1.2 本模块**不**负责什么

| 不做的事 | 归属 | 原因 |
| :--- | :--- | :--- |
| `WIRE` 位段的打包/解包 | WS-01 + 冻结层 `tile.ts` | 位运算是唯一事实源,本模块只**读**不**改** |
| 线路的渲染与玩家拖拽交互 | WS-09 `client/src/stage/` | 本模块只产出**静态视图数据** |
| 电路件在背包中的合成配方 | WS-06 `alchemy/` | 本模块只关心「放下来之后怎么跑」 |
| 电信号的网络同步 | WS-07 `net/` | 本模块是**服务端权威**推进器,不负责传输 |
| 房间级别的电路验收(如「锅炉房必须点亮」) | WS-03 `build/rooms.ts` | 房间识别只统计物件,不跑时序 |

### 1.3 为什么电路必须服务端权威

逻辑件会驱动门、隐藏墙、活塞臂、火车碾压——**全部是改变碰撞与生存判定的东西**。若推进在客户端,玩家可以用改过的时钟让隐藏墙「永远不升起」或让炮台「不开火」。因此本模块的 `tick()` 只跑在服务端,客户端拿到的是一份只读快照。

代价是服务端每个 2Hz 帧多做一次全图推进。`estimateAdvanceCost()` 给出的估算是 512×512、2 万线格、400 件时 **全量 348µs / 脏网络 2.88µs**,相对 500000µs 的帧预算分别占 **0.07%** 与 **0.0006%**,完全可以接受。

---

## 2. 接口

### 2.1 图(`graph.ts`)

```ts
export const TICKS_PER_SECOND = 2;        // 2Hz 慢 tick
export const FRAME_SECONDS = 0.5;

export class SignalGraph {
  static readonly READ_RADIUS = 2;        // 端口读取半径,见 §7

  constructor(width: number, height: number, dirtyOptimization = false);

  /* 线路编辑(会置「结构脏」,下一帧全量重算) */
  addWire(x: number, y: number, color: WireColor): boolean;
  removeWire(x: number, y: number, color: WireColor): boolean;
  wireAt(x: number, y: number, color: WireColor): boolean;
  liveAt(x: number, y: number, color: WireColor): boolean;

  /* 端口读取(半径 READ_RADIUS 的方形邻域) */
  readAround(x: number, y: number, color: WireColor): boolean;
  hasWireAround(x: number, y: number, color: WireColor): boolean;

  /* 驱动源 */
  drive(x: number, y: number, color: WireColor, on: boolean): void;

  /* 无线频道 1..8 */
  setChannel(ch: number, on: boolean): void;
  getChannel(ch: number): boolean;

  /* 逻辑件 */
  addComponent(node: ComponentNode): ComponentNode;
  removeComponent(id: string): boolean;
  get(id: string): ComponentNode | undefined;

  /* 推进 */
  tick(): PropagateStats;
  run(ticks: number): PropagateStats;
  runUntil(pred: (g: SignalGraph) => boolean, maxTicks?: number): number;
  markAllDirty(): void;

  /* 统计与诊断 */
  networksOf(color: WireColor): { size: number; driven: boolean; cells: number[] }[];
  totalWireCells(): number;   // 「色·格」总数(按位 popcount)
  totalLiveCells(): number;   // 「通电色·格」总数(按位 popcount)
  wiredCellCount(): number;   // 「至少一色线的格」数(渲染统计用)

  /* 共享跑酷比赛时钟(411 开表 / 412 停表) */
  race: { running: number; startTick: number; elapsedTicks: number; finishMs: number };
}
```

`PropagateStats` 区分两个关键计数:

```ts
export interface PropagateStats {
  cellsFlooded: number;          // 本帧泛洪访问的格数
  cellsScanned: number;          // 本帧扫描的格数(含仅被清零的格)
  colorsFlooded: number;         // 本帧泛洪的颜色数
  mode: string;                  // FULL | DIRTY_ONLY | IDLE
  componentsEvaluated: number;
}
```

### 2.2 逻辑件上下文

```ts
export interface ComponentContext {
  graph: SignalGraph;
  comp: ComponentNode;
  tick: number;
  readWire(color: WireColor): boolean;          // 半径 2 邻域通电
  readAt(dx: number, dy: number, color: WireColor): boolean;  // 精确偏移
  readChannel(ch: number): boolean;
  writeChannel(ch: number, on: boolean): void;  // 本帧 OR 累积
  write(color: WireColor, on: boolean): void;   // 延迟 latencyTicks 帧
  writeNow(color: WireColor, on: boolean): void;// 立即(传感器专用)
  writeAt(dx: number, dy: number, color: WireColor, on: boolean): void;
  st(key: string): number;
  setSt(key: string, v: number): void;
  param(key: string): number;
  race: { running: number; startTick: number; elapsedTicks: number; finishMs: number };
}
```

注册一个新件只需一行:

```ts
registerComponentKind('LOGIC_AND', (ctx) => { /* ... */ });
```

### 2.3 物流(`logistics.ts`)

全部是**无副作用于图**的纯推进函数:

```ts
export const LOGISTICS_HZ = 2;
export const CONVEYOR_CELLS_PER_SECOND = 1;   // 1 格/秒
export const CONVEYOR_TICKS_PER_CELL = 2;     // 2Hz 下 2 帧 1 格
export const ARM_CYCLE_TICKS = 4;             // 机械臂 2.0s 一循环
export const DRILL_PERIOD_TICKS = 20;         // 钻头 10s 一矿

export function stepConveyor(state: ConveyorState, powered: boolean): ConveyorStepResult;
export function stepSorter(state: SorterState, powered: boolean): SorterStepResult;
export function stepArm(state: ArmState, world: ArmWorld, x: number, y: number, powered: boolean): ArmStepResult;
export function stepDrill(state: DrillState, powered: boolean): DrillStepResult;
export function tickLogistics(line: LogisticsLine, world: ArmWorld, powered: {...}): LogisticsTickReport;
```

---

## 3. 数据结构

### 3.1 位平面

图不为每个格子建对象,而是用**三个 `Uint8Array` 位平面**(每格 1 字节,低 4 位对应四色):

| 平面 | 含义 | 512×512 占用 |
| :--- | :--- | ---: |
| `wireBits` | 该格铺了哪些颜色的线 | 262144 B |
| `driveBits` | 该格被哪些颜色的驱动源驱动 | 262144 B |
| `liveBits` | 该格哪些颜色的线当前通电 | 262144 B |

三平面合计 **786432 B ≈ 0.75 MB**,不足 1 GB 内存约束的 0.1%。位序与冻结层 `WIRE_BIT` 一致:`RED=0b0001, BLUE=0b0010, YELLOW=0b0100, GREEN=0b1000`。

### 3.2 逻辑件节点

```ts
export interface ComponentNode {
  id: string;
  kind: string;                    // 注册表键
  x: number; y: number;            // 中心格(占位 3×3)
  params: Record<string, number>;  // 静态参数:音高、频道、过滤 ID
  outputs: WireColor[];            // 该件会点亮哪些色
  state: Record<string, number>;   // 运行态
  latencyTicks: number;            // 固有延迟
  pending: PendingWrite[];         // 到期输出队列
  lastOut: Record<string, number>; // 输出去抖快照
}
```

### 3.3 `STATE_DEFAULTS`——每类件的状态初值表

这是**踩过坑之后的强制约定**:行为实现里只在 `if` 分支里 `setSt` 是不够的,`{ finished: 0 }` 若从未写入,外部读到的就是 `undefined`。因此每类件都必须在 `STATE_DEFAULTS` 里声明全部键,`makeComponent()` 挂载时即填入。

```ts
export const STATE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, number>>>>;
```

`tests/WS-08.test.ts` 的 `WT-08-40b/40c` 会遍历全 40 件,断言每个声明键在挂载时就是 `number`,并在跑 3 帧后仍存在——这是一条**双向对账护栏**。

### 3.4 输出队列

`write()` 把 `{ tick: now + latencyTicks, color, on, cell }` 压入 `pending`;`tick()` 阶段一先提交所有 `tick <= now` 的项。`lastOut` 保证同值不重复入队(`WT-08-57`)。

---

## 4. 算法

### 4.1 单帧推进的四阶段

```
tick():
  ① 提交到期输出      comp.pending 中 tick <= now 的项 → applyDrive
  ② 泛洪             结构脏 → 全量;仅驱动脏 → 分量级;都无 → IDLE
  ③ 评估逻辑件        遍历全部组件,各调一次行为函数
  ④ 提交无线广播      本帧累积的 channelInput → channelBroadcast
```

顺序不可换:①必须在②之前,否则本帧新写入的驱动源要下一帧才生效;③必须在②之后,否则逻辑件读到的是上一帧的通电位。

### 4.2 泛洪

同色线四邻相连构成网络。全量重算:

1. 精确清空**上一帧该色实际通电过的那批格**(`liveCells` 增量清单,不是整平面)。
2. 种子:全部被驱动格的 `READ_RADIUS` 邻域内、该色有线的格。
3. 沿四邻同色线 BFS 扩展。

**关键**:第 1 步不扫全平面。早期版本用 `for (i = 0; i < W*H; i++) liveBits[i] &= ~bit` 清零,代价恒为 O(W·H),与「线有多少」无关——这是 512×512 世界跑不动的根因。改为增量清单后,全量代价 = O(上一帧通电格 + 驱动格 + 本帧泛洪格),**与地图面积无关**。

### 4.3 分量级增量

只改了某格的驱动状态时,不必重算整色:

1. 以该驱动格为种子,BFS 收集所属连通分量(按 `READ_RADIUS` 找种子,见 §7)。
2. 清空该分量的通电位。
3. 从「分量内的驱动格」与「分量外但 `READ_RADIUS` 内覆盖本分量的驱动格」重新泛洪。

复杂度 O(分量格数),与画面上的线格总数无关。

### 4.4 无线联动的 OR 语义

`WIRELESS_LINK`(418)是最容易写错的件。约定:

- `writeChannel(ch, on)` **只写本地输入**(`readWire(RED) || param('input')`),帧内多发射器取 **OR**。
- `getChannel(ch)` 返回 `channelManual ∪ channelBroadcast`。手动态(`setChannel`)与组件广播态分离,组件帧循环不会把手动态冲掉。
- `readChannel()` 的结果只用于**镜像到黄线输出**,绝不回写频道。

早期版本把 `remote || localInput` 一起写回频道,导致接收器读到的 1 被自己再写成 1——**频道自锁在高位,永远无法归零**(`WT-08-21` 就是这么暴露的)。

### 4.5 逻辑件延迟

`write()` 入队的到期帧是 `now + latencyTicks`,`latencyTicks` 默认 1。于是「输入变化 → 输出线通电」至少要跨一帧(`WT-08-56`),这既符合「电路有一拍延迟」的直觉,也避免了同帧内组合逻辑的无限递归。

延时继电器 413 需要可变延迟,它在行为函数里直接按档位入队,等效覆盖 `latencyTicks`。

### 4.6 边沿触发

弹簧垫 422、火车碾压 437、果冻球生成 433、烟花 432、球门计分 410 都是**事件**而非**电平保持**。一律用「上一帧状态快照 + 本帧状态」组成边沿:

```ts
const contact = powered && hitMob;
if (contact && ctx.st('contact') === 0) { /* 只结算一次 */ }
ctx.setSt('contact', contact ? 1 : 0);
```

电平等触发会让持续接触在**每个 2Hz 帧**重复结算——实测表现为「一帧碾出 2 次伤害」「冷却结束后立刻二次弹射」。

### 4.7 物流推进

`stepConveyor` 用累加器:`progress += 0.5` 每帧,满 1 才移动一格并归零。`stepSorter` 复用传送带的状态机,只在出口处按 `filterId` 重定向方向。`stepArm` 是四阶段状态机 `IDLE(布防) → REACH(抓) → CARRY → DEPOSIT(投喂)`,一个循环 4 帧。`stepDrill` 是 `elapsed` 累加器,满 20 帧产 1 块进 `buffer`。

`tickLogistics` 按「钻头 → 传送带 → 分拣 → 机械臂」**串行**执行,保证同一帧内货物只被搬运一次。

---

## 5. 参数

### 5.1 时序

| 参数 | 值 | 说明 |
| :--- | ---: | :--- |
| `TICKS_PER_SECOND` | 2 | 2Hz 慢 tick,与冻结层 `SLOW_TICK_HZ` 一致 |
| `FRAME_SECONDS` | 0.5 | 每帧 0.5 秒 |
| `INHERENT_LATENCY_TICKS` | 1 | 逻辑件固有延迟 |
| `PULSE_BUTTON_TICKS` | 1 | 0.5s 脉冲 → 1 帧 |
| `SPRING_COOLDOWN_TICKS` | 4 | 弹簧垫冷却 2.0s |
| `ARM_CYCLE_TICKS` | 4 | 机械臂循环 2.0s |
| `DRILL_PERIOD_TICKS` | 20 | 钻头 10s 一矿 |
| `CONVEYOR_TICKS_PER_CELL` | 2 | 传送带 1 格/秒 |

### 5.2 延时继电器四档量化

| 档位 | 设定 | 秒数 | 帧数(`ceil(s/0.5)`) |
| ---: | :--- | ---: | ---: |
| 0 | 0.2s | 0.2 | **1** |
| 1 | 0.5s | 0.5 | **1** |
| 2 | 1.0s | 1.0 | 2 |
| 3 | 2.0s | 2.0 | 4 |

`measured[0] === measured[1] === 1` 是**2Hz 低频帧的物理上限**,不是实现缺陷:0.2s 与 0.5s 都落进同一个半秒帧,无法区分。若将来提高 `SLOW_TICK_HZ`,这四档会自动拉开。`tests/WS-08.test.ts` 实测了四档的真实触发帧数(`WT-08-10`),而非只断言常量。

### 5.3 计数器与频道

- `COUNTER_MOD = 100`,量程 0..99,满百回卷。
- `CHANNEL_MIN = 1`,`CHANNEL_MAX = 8`;越界 `setChannel` 夹取,越界 `getChannel` 返回 `false`。

### 5.4 分流器

`SPLITTER_ROUTES = [RED, BLUE, GREEN]`,三路各 1/3。用 xorshift32 PRNG(`nextRandom` + `randomUnit`)保证**可复现**:同种子必同输出。10000 次迭代实测三路占比偏差均在 ±5% 内(`WT-08-11`)。

---

## 6. 性能

### 6.1 估算模型与实测

`estimateAdvanceCost(worldSize, wireCells, components)` 的假设:

| 假设项 | 取值 | 依据 |
| :--- | ---: | :--- |
| 单格清零/入队成本 | 12 ns | `Uint8Array` 命中 + 4 邻索引计算,V8 实测量级 |
| 单件评估成本 | 120 ns | 一次 `Map.get` + 若干算术 |
| 全量触碰格数 | `wireCells × 1.25` | 通电 + 清零各一次 |
| 脏分量平均格数 | 40 | 一次驱动变化影响的典型网络规模 |
| 脏模式重估件数 | `ceil(components / 20)` | 只有与受影响分量相连的件需要重估 |

512×512 / 2 万线格 / 400 件的结论:

| 指标 | 全量 | 脏网络 |
| :--- | ---: | ---: |
| 单帧耗时 | **348 µs** | **2.88 µs** |
| 占 2Hz 帧预算(500000 µs) | 0.07% | 0.0006% |

**收益倍数 = 348 / 2.88 ≈ 120.8×**。

### 6.2 收益来自两处,缺一不可

1. **泛洪**:全量 25000 格 → 脏模式 40 格。
2. **组件评估**:若组件成本仍是 400 件全算,`dirtyFrameUs = (40×12 + 400×120)/1000 = 48.48`,收益上界被钉死在 `348/48.48 ≈ 7.25×`,**无论如何优化泛洪都到不了 10 倍**。

因此 `WT-08-45` 除了断言 `speedup > 10`,还额外断言 `speedup > 50`——若哪天有人把组件成本改回不分摊,这条会立刻报红。这是把「设计决策」写成**可回归的断言**。

### 6.3 `budgetRatioFull` 的分母语义

**分母是 2Hz 慢 tick 的一帧**(`1/TICKS_PER_SECOND` 秒 = 500000 µs),不是 60fps 帧的 5%(830 µs)。

早期版本误用 830 µs 做分母,把 348 µs 的耗时报成 **41.93%** 占用,看着像性能危机,实际只占 0.07%。语义应当是「相对本模块真正运行的那个 tick 频率」。`TICKS_PER_SECOND` 变了,这个比值跟着变,才是对的。

### 6.4 结构不变的稳态帧

没有任何驱动变化时进入 `IDLE` 模式,`cellsFlooded = 0`、`cellsScanned = 0`,只花 400 件的评估成本。绝大多数帧都属于这一类。

### 6.5 实测数据

`WT-08-60` 在真实图上铺满 2 万格并实测:

| 场景 | 扫描格数 |
| :--- | ---: |
| 无驱动源的全量帧 | 0(无事可做,正确行为) |
| 脏模式,1 个驱动格 | ≤ 200(1 条 80 格的线 + 半径) |
| 脏模式,换线驱动 | ≤ 400(2 个分量:关旧 + 开新) |
| 全量模式,全部线均被驱动 | ≥ 20000(扫遍) |

**全量的扫描量是脏模式的 50 倍以上**。单次推进实测耗时远低于 500000 µs 的帧预算。

---

## 7. `readAround` 的读取半径——本模块最容易踩的坑

### 7.1 最终方案:固定半径 2(5×5 方形邻域)

```ts
static readonly READ_RADIUS = 2;
```

`readAround` 与 `hasWireAround` **共用这一个常量**,保证「读信号」与「提示线接反了」的口径一致。

### 7.2 为什么是 2

组件在世界里占 **3×3 格**(中心 ±1)。线路端口开在占位框**外侧一圈**,即中心到最近端口恰好是 **2 格**。半径 1 会漏掉这一整圈端口。

实测现象:

```
r=1 readAround RED = false    ← 线是通电的,组件读不到
r=2 readAround RED = true     ← 正确
```

这一条偏差**放大了约 15 条失败断言**:AND/NOT 真值表、继电器四档、分流器三路、无线收发、灯箱/隐藏墙、弹簧垫、洒水器/拦水闸、物流取电、固有延迟。全部是同一个根因。

### 7.3 半径 2 带来的连带修改

半径变了,**泛洪的种子搜索也必须同步**,否则会出现「线通电了但整条线不亮」:

1. `refloodColorFull` 的种子:从「驱动格本身有线」改为「驱动格的半径 2 邻域内有线」。
2. `refloodComponent` 的种子:从「分量内被驱动的格 + 分量外 ±1 的驱动格」改为「分量内被驱动的格 + 分量外驱动格的半径 2 邻域 ∩ 本分量」。

第 2 处尤其隐蔽:`refloodComponent` 原本只扫 ±1,于是「组件中心距线 2 格」这种**最主流的接法**在脏模式下完全不亮,而全量模式下正常——表现为「某些帧亮、某些帧不亮」。

### 7.4 为什么不选「显式端口坐标」

方案 B(给 `ComponentNode` 加 `ports: {inA:{dx,dy}, ...}`)更精确,但要改 40 个 `ComponentSpec`,且端口方向会在旋转时出问题。半径 2 与 3×3 占位自洽、改动面小、不动配表,故选 A。

代价是**精度略降**:半径 2 内任意格通电都算「读到了」。对 2.5D 绘本沙盒的玩法而言,「线铺在件旁边就算接上」比「必须精确对准某个端口格」更符合直觉,也让儿童玩家更容易成功。

### 7.5 由此产生的测试约定

组件的测试几何必须把线放在**中心 ±2 之内**。早期多条测试把线铺在距离 3 格以外(如绿线在 `y=4`、机械臂在 `y=10`),断言当然失败——**那不是实现 bug,是测试构造错误**。写新测试时请先量距离。

---

## 8. 耦合

### 8.1 上游

| 依赖 | 契约 |
| :--- | :--- |
| 冻结层 `tile.ts` | `WireColor`、`WIRE_BIT` 枚举值;本模块**只读** |
| 冻结层 `physics.ts` | `SLOW_TICK_HZ`、`SLOW_DT`;`TICKS_PER_SECOND` 必须与之相等(`WT-08-01` 断言) |
| `items.ts` 401~440 | 物品 ID 与中文名;`COMPONENT_SPECS` 逐条对应 |
| WS-01 位压缩 | `WIRE` 位段 12..15 是「哪些色有线」的唯一事实源 |

### 8.2 下游

| 消费方 | 用途 |
| :--- | :--- |
| WS-06 炼金 | 机械臂把原料投喂给高炉 503 / 灶台 519 等 `ARM_TARGETS` |
| WS-10 防御 | 连弩炮台 425 索敌开火 |
| WS-11 派对 | 410~412 竞技传感、432~436 氛围与裁判、437~440 载具 |
| WS-09 客户端 | `networksOf()` 与位平面快照用于渲染 |
| WS-07 持久化 | `ComponentNode.state` 全量存档;`STATE_DEFAULTS` 保证新存档字段齐全 |

### 8.3 与 WS-03 的边界

WS-03 的 `wiring_view.ts` 做**静态视图**(读位段、列悬空端点),本模块做**时序推进**。两者都碰 `WIRE` 位段,但一个只读、一个读+写驱动位——`wireBits` 的写入权在客户端编辑操作经 WS-03 校验后才落到本模块。**两人同改一个判定点的风险已在 §7 记录**:读取半径是 `graph.ts` 的单一常量,WS-03 若需要「线是否接到件上」的判定,应调用 `hasWireAround()` 而不是自己重算。

---

## 9. 验收

### 9.1 验收命令

```
node scripts/verify.ts --only WS-08     # 63/63 通过
node scripts/verify.ts --only WS-03     # 80/80 通过(连带回归)
node scripts/verify.ts --docs           # 文档结构完整
```

### 9.2 63 条断言的覆盖分布

| 组 | 断言 | 关键判据 |
| :--- | ---: | :--- |
| 2Hz 帧基线 | 2 | `SLOW_TICK_HZ` 与冻结层一致;秒→帧换算四档 |
| 四色独立网络 | 4 | 四色互不串扰;断开不泛洪;同格叠四色 |
| 逻辑门真值表 | 3 | AND 穷举 4 组、NOT 穷举 2 组、输入端隔离 |
| 继电器四档 | 1 | **实测**触发帧数 = 1/1/2/4 |
| 分流器 | 4 | 10000 次 ±5%;边界;PRNG 确定性;恰好一路 |
| 计数器 | 3 | 0→99→0 回卷;十位/个位分解;60 次实测 |
| 无线 1~8 频道 | 5 | 8×8 穷举;同频道联动;跨频道隔离;越界夹取;反向联动 |
| 传感器与电路件 | 12 | 压力板/拉杆/按钮/感光/水位/音高/绊线/竞技/执行器 |
| 40 项覆盖 | 4 | ID 无缺口;kind 全注册;**state 键双向对账** |
| 脏网络优化 | 5 | **增量与全量逐格一致**;结构变化强制全量;IDLE 语义 |
| 性能 | 1 | 2 万格实测 + 估算模型 |
| 物流 | 10 | 1 格/秒;分拣三向;机械臂 4 帧循环;钻头 20 帧;串行顺序 |
| 时序 | 3 | 固有延迟 1 帧;输出去抖;`runUntil` 语义 |

### 9.3 最有价值的一条断言:增量与全量逐格一致

`WT-08-42` 建两个同构世界(一个开脏优化、一个不开),施加**完全相同的驱动序列**,然后逐格比较 `liveBits`:

```ts
let diff = 0;
for (let i = 0; i < 32 * 32; i += 1) if (a.liveBits[i] !== b.liveBits[i]) diff += 1;
eq(diff, 0, '增量与全量结果必须逐格一致');
```

**`diff === 0` 证明脏网络优化在语义上严格等价于全量重算。** 这是整个 WS 里最强的判据:性能优化最容易出的问题是「快是快了,结果悄悄变了」,而逐格比对把这种风险钉死到零。它和 `terrain-physicist` 的「密封池 2000 帧漂移精确为 0」属于同一类高质量验收——**用精确相等而不是近似容差**。

### 9.4 回归护栏

- `WT-08-40b/40c`:全 40 件的 `state` 声明键在挂载时即存在,杜绝「期望 0 / 实际 undefined」。
- `WT-08-45` 的 `speedup > 50`:把「组件成本参与脏优化」这一设计决策变成可回归断言。
- `WT-08-45` 的「世界放大 16 倍不增加单帧耗时」:把「清零不再是 O(W·H)」钉死。

### 9.5 接受标准

- `verify.ts --only WS-08` 全绿,零失败。
- `verify.ts --only WS-03` 保持全绿(本模块改动不得破坏 WS-03)。
- `verify.ts --docs` 不再报「有测试但缺文档:WS-08」。
- `shared/**` 零改动。

---

## 10. 未决

1. **半径 2 与旋转件的交互**:半径是方形邻域,与组件朝向无关。若将来出现「定向输入件」(只认某一侧的线),需要一个 `readFacing()` 系列 API,届时建议同时引入显式端口表。
2. **`channelPending` 目前是死代码**:无线改为「帧内 OR 累积 + 帧末提交」后,`writeChannel` 不再入 `channelPending`。该字段与 `setChannel` 的延迟写入路径应清理或补上「延时频道写入」的真需求。
3. **跨图联动的时序**:两块 `SignalGraph` 之间的信号传递(如分区加载)尚无定义。当前假设全图单实例。
4. **物流与图的桥接**:`logistics.ts` 是纯函数,`components.ts` 里的 428~431 只读绿线取电,两者尚未真正互喂(传送带上的货物还没有实体层)。需要在 WS-06/WS-10 接入实体系统后统一。

5. ~~**`components.ts` 不在生产可达闭包内**~~(**已关闭**)。此前的缺陷是:
   40 项电路件的行为注册(`registerComponentKind`)全在模块加载时以**副作用**发生,
   而生产侧**没有任何文件 import 过 `components.ts`** —— 唯一引用来自
   `tests/WS-08.test.ts`。于是生产运行时 `REGISTRY` 为空,
   `SignalGraph.tick()` 里 `const fn = REGISTRY.get(comp.kind); if (!fn) continue;`
   会**静默跳过每一件**:AND/NOT、继电器、分流器、计数器、无线、出口执行器
   全部成了「永不求值的空壳」。

   这个缺陷的全部隐蔽性来自它**不报错、不抛异常、测试也不红**:
   `addComponent` 照常收下节点,泛洪照常工作(`demo.ts` 冒烟里 `通电格=10`
   全来自 `addWireDrive`,与件无关),而 `demo.ts` 的自检当时只验了「线能通电」,
   就断言「电路可协同运行」。

   修法:由编排层 `world_sim.ts` 用**副作用导入**接管 ——
   `import '../wiring/components.ts';`(裸导入,不取符号;写成具名导入会引入
   未使用变量,反而诱导后人「清理」掉它,那正是这个缺陷会复发的原因)。

   回归断言见 `tests/WS-FND-07.test.ts`:`WF-07-03`~`WF-07-06`。
   其中 `WF-07-06` 是**故障注入型**断言 —— 在干净子进程里先只导入 `graph.ts`
   断言注册表为空,再导入 `world_sim.ts` 断言注册表被填满,
   从而直接证明**那行接线是必要条件**(删掉它,断言当场变红)。
   同时 `demo.ts` 的自检已升级为断言 `componentsEvaluated > 0`,
   不再用「线通」冒充「件跑」。

   可达性门禁现为:**可达 24 / 不可达 50**,`components.ts` 已从
   `scripts/verify.ts` 的 `UNREACHABLE_EXEMPT` 白名单移出。
5. **`estimateAdvanceCost` 的标定**:12 ns/格、120 ns/件 是基于 Node 24 的量级估计,不是本机基准测试。建议在 CI 加一条 `--bench` 实测并用实测值替换,使估算随硬件漂移自动校准。
6. **继电器 0.2s 档位在 2Hz 下的不可区分性**:这是帧率决定的物理上限。若产品要求四档可辨,需把慢 tick 提到 5Hz 以上,那将牵动整个 WS-08 的时序参数——建议先与 `terrain-physicist` 确认冻结层是否允许。
7. **`ARENA_REFEREE_DESK` 的四色模式广播**:目前用「模式 1..4 对应四色」的简单编码,与 WS-11 的派对规则表尚未对齐。
