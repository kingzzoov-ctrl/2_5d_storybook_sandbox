# 模拟编排层(WS-SIM)设计说明

> 代码位置:`server/src/sim/world_sim.ts`(编排)、`server/src/sim/demo.ts`(冒烟可执行例)
> 验证门禁:`node scripts/verify.ts --integration`(14 条跨 WS 断言)
> 上游依赖:WS-01 地形/流体、WS-02 物理、WS-04 AOI/刷怪、WS-08 电路
> 定位:不是新功能,是**把已有 11 个工作流接成一个能跑的世界**

---

## 1. 职责边界

### 1.1 为什么会有这一层

交付时 11 个工作流、677 条断言全绿。但交付后审计发现一个结构性空白:

| 审计项 | 实测结果 |
| :--- | :--- |
| 全仓跨 WS 的 `import` | **仅 1 处**(`build/blueprint.ts → world/chunk.ts`) |
| `PhysicsWorld` 的调用方 | 只有它自己 |
| `FluidField` 的调用方 | 只有它自己 |
| `SignalGraph` 的调用方 | 只有它自己 |
| `MobSpawner` 的调用方 | 只有它自己 |
| 双频调度器 | **不存在**;`SLOW_DT` 只被当常量引用,从不驱动推进 |

也就是说:**677 条断言全绿,但这个世界从未跑起来过。**

这不是写手的疏漏。单元测试的正确形态就是「在自建对象上断言」——11 个套件各自隔离、各自可跑,这是好设计。它留下的盲区是结构性的:**契约断裂只在跨模块时暴露**。参数顺序、容器类型(`Map` vs 数组)、调用顺序(`update()` 与 `stepActive()` 的先后)、两套影子状态的同步——这些错误在单模块测试里**不可能**被发现。

### 1.2 这一层做什么

`WorldSim` 持有全部子系统,并按手册 §2.1 的双频节奏推进:

```
20Hz 快帧(每 50ms)      2Hz 慢帧(每 500ms,即每 10 个快帧)
─────────────────────   ──────────────────────────────
· 物理积分(刚体/举投/      · 流体元胞自动机
  碰撞/反弹)               · 电路信号泛洪
· AOI 活跃生物推进          · AOI 唤醒/休眠决策
                         · 刷怪决策
```

### 1.3 这一层**不**做什么

| 不做的事 | 归属 | 原因 |
| :--- | :--- | :--- |
| 任何子系统的内部逻辑 | 各自的 WS | 编排层只负责**顺序与节奏**,不重复实现 |
| 网络同步与差量编码 | WS-07 | `RoomRuntime` 负责;两者可组合 ⚠️ **但见 US2 —— 「互不依赖」这个措辞已陈旧(2026-11-14 订正)** |
| 生物 FSM 的具体行为 | WS-04 `behaviors.ts` | 它需要 `MobRuntime` 宿主,由调用方注入 |
| 存档 | WS-07 `db/` | — |
| 改冻结层 | — | `shared/**` 一行不动 |

---

## 2. 接口

```ts
export const FAST_PER_SLOW = TICK_HZ / SLOW_TICK_HZ;   // 10
export const SIM_FAST_DT = DT;                          // 0.05
export const SIM_SLOW_DT = 1 / SLOW_TICK_HZ;            // 0.5

export interface WorldSimOptions {
  sizeCells?: number;      // 世界边长(格),默认 64
  fluidBudget?: number;    // 每慢帧流体处理格数,默认 FLUID_CELL_BUDGET
  wiring?: boolean;        // 是否推进电路,默认 true
  mobs?: boolean;          // 是否推进生物,默认 true
  rng?: () => number;      // 确定性随机源,默认 mulberry32
}

export interface SimFrameReport {
  frame: number;
  phase: 'FAST' | 'SLOW';
  simSeconds: number;
  physics: StepReport | null;
  activeMobs: number;
  fluidProcessed: number;
  wireCellsFlooded: number;   // 增量
  wireCellsLive: number;      // 稳态
  spawned: number;
}

export function mulberry32(seed: number): () => number;

export class WorldSim {
  readonly grid: WorldGrid;
  readonly physics: PhysicsWorld;
  readonly fluid: FluidField;
  readonly wiring: SignalGraph;
  readonly aoi: AoiManager;
  readonly spawner: MobSpawner;
  readonly carry: CarrySystem;
  readonly sizeCells: number;

  constructor(opts?: WorldSimOptions);

  setCell(x, y, fields: Partial<TileFields>): void;   // 地形 + 流体投影
  setSolid(x, y, solid?: boolean): void;
  fillRect(x0, y0, x1, y1, fields): number;
  addWireDrive(x, y, color, on?): void;
  addPlayer(id, x, y): void;
  addMob(id, biome, x, y): void;

  tick(): SimFrameReport;
  run(frames: number): { frames; slowFrames; reports };
  runForSeconds(seconds: number): { frames; slowFrames };

  get frame(): number;
  get simSeconds(): number;
  snapshot(): { frame; simSeconds; bodies; chunks; fluidTotal; wireCells; mobs };
}
```

---

## 3. 数据结构

| 结构 | 说明 |
| :--- | :--- |
| `wireDrives[]` | 每慢帧重放的驱动态 `{x, y, color, on}[]` |
| `players[]` | 从 `physics.bodies` 每帧重建的 AOI 唤醒源 |
| `frameCount` | 全局快帧计数(**永远是快帧单位**) |

`wireDrives` 之所以要单独存:见 §4.5。

---

## 4. 算法

### 4.1 帧类型判定:用帧序取模,不用时间累加

```ts
const isSlow = frame % FAST_PER_SLOW === 0;
```

**不用 `accumulator += dt` 判断。** 那会让「第几次慢帧」受浮点误差影响,长跑后出现 119 或 121 次的偏差——这与 WS-09 粒子发射器踩的是同一个坑(§4.8 那条:200 次 `+0.005` 累加得 `0.9999999999999998` 而非 1)。

用整数帧序取模,慢帧次数**恒等于** `floor(总帧数 / 10)`,不依赖任何浮点状态。

### 4.2 模拟时间基:恒为 `frame / 20`

```ts
simSeconds: frame / TICK_HZ        // ✓
```

**不是** `isSlow ? frame / SLOW_TICK_HZ : frame / TICK_HZ`。帧序永远是快帧计数,它的单位不随相位改变。按相位分支会让慢帧报告的时间**快 10 倍**(第 10 帧报 5.00 秒,真值 0.5 秒)。这个错误我实际写过一次,门禁第一次也没抓到(见 §9.2)。

### 4.3 初始化顺序与推进顺序不同(刻意)

```
初始化:地形 → 物理 → 电路 → 生物
推进:  物理 → 生物 → 电路 → 流体
```

推进时「物理先动、电路后判」是有意的:这样「玩家踩到压力板」与「该板通电」落在**同一帧**,不会被推迟一帧(那是 50ms 的可感知延迟)。

### 4.4 地形到流体场的投影

`WorldGrid` 与 `FluidField` 是**两套独立数据结构**:

| | `WorldGrid` | `FluidField` |
| :--- | :--- | :--- |
| 存什么 | 32 位打包单元(位平面) | `amount` / `base` / `solid` / `elev` 四个数组 |
| 谁的地形权威 | **是** | 否,但仍用自己的副本判流向 |

`setCell` 必须**同时写两处**,否则水永远不扩散而总量不变——没有异常,只是模拟结果静默地不合理。

实测(64×64 世界,左半 `elev=2` 高地、右半 `elev=0` 低地、高地灌 500 单位水):

| 检查 | 结果 |
| :--- | :--- |
| 高地 `(30,32)` | 500 → 4(水离开了) |
| 低地 `(33,32)` | 0 → 8(顺落差倾泻) |
| 总量 | 500 → 500(守恒) |
| 反向:低地灌水后高地 | 恒为 **0**(水不逆流上坡) |

### 4.5 驱动态是帧内的,必须每帧重放

`SignalGraph.drive(x, y, color, on)` 写的是**帧内**驱动态,`tick()` 结束后被消费。所以「接一个常亮拉杆」这件事必须由编排层每帧重放。

漏掉这一步的表现:布线正常、组件正常、`wireAt` 正常,但第一帧之后泛洪恒为 0、模式退化成 `IDLE`。看起来像「电路模块坏了」,实际是调用方少写了一次驱动。

**另外**:`drive` 接的是**格坐标**,不是组件 ID。传 ID 会因 `index()` 越界而静默返回。

### 4.6 增量泛洪 vs 稳态通电

| 指标 | 语义 | 稳态值 |
| :--- | :--- | ---: |
| `cellsFlooded` | 本帧**增量**泛洪格数 | **0**(增量优化生效) |
| `totalLiveCells()` | 当前**稳态**通电格数 | 实际值(本例 10) |

把 `cellsFlooded` 当成「电路是否通」会误判:稳态下它一直报 0,看起来像电路断了。报告里两个都给(`wireCellsFlooded` / `wireCellsLive`)。

### 4.7 AOI:先 `update()` 才能 `stepActive()`

```
update()     → 决定谁该被唤醒/休眠(写入 activeMobs 集合)
stepActive() → 遍历 activeMobs,对每个活跃生物调回调
```

只调 `stepActive` 不调 `update`,集合恒为空,表现成「活跃生物数永远 0」「生物不动」——既不报错也不抛异常,只是默默什么都不做。

生态模拟只跑慢帧(手册 §2.4:打盹玩家不提供唤醒能量)。

### 4.8 确定性

全部随机来自注入的 `rng`(默认 `mulberry32(0x5eed)`),**不用 `Math.random`**。同种子两次运行 300 帧后终态逐字节一致,已由门禁断言。

---

## 5. 参数

| 常量 | 值 | 出处 |
| :--- | ---: | :--- |
| 快帧 `DT` | 0.05s | 冻结层 `physics.ts`(手册 §2.1) |
| 慢帧 `SLOW_DT` | 0.5s | 同上 |
| `FAST_PER_SLOW` | **10** | 20Hz / 2Hz 的直接推论 |
| `sizeCells`(默认) | 64 | 4×4 个 Chunk,便于调试 |
| `fluidBudget`(默认) | `FLUID_CELL_BUDGET` = 1024 | WS-01 |

---

## 6. 性能

实测(64×64 世界、5 刚体、4 生物、10 格电线、1024 流体格):

| 指标 | 值 |
| :--- | ---: |
| 200 帧(10 秒模拟)总耗时 | **6.2ms** |
| 每帧 | **0.031ms** |
| 慢帧数 | 20(精确 1:10) |

即模拟本身只占 20Hz 帧预算(50ms)的 **0.06%**。10 秒模拟耗时 6.2ms 意味着**模拟可以跑到 1600 倍实时**——瓶颈显然不在编排层。

---

## 7. 边界

| 输入 | 结果 |
| :--- | :--- |
| `sizeCells < 16` | 夹到 16(至少一个 Chunk) |
| `fluidBudget < 1` | 夹到 1 |
| `run(负数)` | 夹到 0,不推帧 |
| `run(小数)` | `Math.trunc` |
| `fluid.step(0)` / 负数 | `FluidField` 抛 `RangeError`(它自己的契约) |
| `SignalGraph` 未传尺寸 | **构造出 0×0 位平面**,`addWire` 静默返回 false(见 §8.2) |
| `setCell` 坐标越界 | 自动建对应 Chunk(`WorldGrid.ensureChunk`) |
| `setSolid` 越界 | `inBounds` 为假时静默跳过 |

---

## 8. 耦合

### 8.1 依赖矩阵

| 依赖 | 符号 | 方向 |
| :--- | :--- | :--- |
| WS-01 `world/grid.ts` | `WorldGrid` | 编排层拥有 |
| WS-01 `world/fluid.ts` | `FluidField` / `FLUID_CELL_BUDGET` | 拥有 |
| WS-02 `physics/world.ts` | `PhysicsWorld` / `StepReport` | 拥有 |
| WS-02 `physics/carry.ts` | `CarrySystem` | 拥有 |
| WS-04 `mobs/aoi.ts` | `AoiManager` / `AoiPlayer` | 拥有 |
| WS-04 `mobs/spawner.ts` | `MobSpawner` / `SpawnContext` / `SpawnWorld` | 拥有 |
| WS-08 `wiring/graph.ts` | `SignalGraph` | 拥有 |
| 冻结层 `physics.ts` | `TICK_HZ` / `SLOW_TICK_HZ` / `DT` | **只读** |

编排层是**唯一同时消费 4 个 WS 目录的模块**。除此之外全仓跨 WS 引用只有 1 处。

### 8.2 三类「静默失败」(都踩过)

这三个错误的共同特征:**不抛异常、不报错、日志干净**,只是模拟结果悄悄变得不合理。

1. **`SignalGraph` 漏传尺寸** → `0×0` 位平面 → `index()` 恒 -1 → `addWire` 静默返回 false、`wireAt` 恒 false。表现:「布线成功但永远不通电」,实际一根线都没写进去。
2. **`physics.bodies` 当数组用** → 它是 `Map`,`.length` 得 `undefined`,`?? 0` 静默变 0 → 快照报「0 个刚体」,看起来像世界空了。
3. **地形只写 `WorldGrid` 不投影到 `FluidField`** → 水永远不扩散但总量不变。

对策不是「小心一点」,而是**把它们变成门禁断言**(§9.2)。

---

## 9. 验收

### 9.1 门禁命令

```
node scripts/verify.ts --integration   # 只跑跨 WS 集成(含文档与测试)
node scripts/verify.ts                 # 全量
node server/src/sim/demo.ts 10         # 可运行冒烟演示(默认 10 秒)
```

### 9.2 14 条集成断言

| 组 | 断言 | 能抓住的缺陷 |
| :--- | :--- | :--- |
| 实例化 | 6 个子系统同时构造 | 构造参数不匹配 |
| 双频 | 慢帧数 = 帧数 / **10** | 比例常数被改(见下) |
| 双频 | `FAST_PER_SLOW === 20 / 2` | 常数与手册不符 |
| 时间基 | 任意帧 `simSeconds === frame / 20` | 相位分支污染时间基 |
| 帧序 | 单调推进至总数 | 丢帧 |
| 在动 | 刚体 = 4(2 玩家 + 2 生物) | `Map` 当数组用 |
| 在动 | Chunk > 0 | 地形未建 |
| 在动 | 流体总量 > 0 | 流体未初始化 |
| 在动 | 通电格 > 0 | `SignalGraph` 漏传尺寸 |
| 在动 | **AOI 唤醒数 > 0** | 漏调 `update()` |
| 确定性 | 同种子 300 帧终态一致 | 用了 `Math.random` |
| 投影 | 低地水量 > 0 且高地水量下降 | 地形未投影到流体 |
| 守恒 | 流体总量不变 | 流体账目泄漏 |
| 方向 | 水不上坡 | 流向判定反向 |
| 接线 | 编排层接入 4 个 WS 目录 | 集成退化成空壳 |

### 9.3 门禁自身的两次修正(重要)

首次写完后做**故障注入**,发现两条断言是**同义反复、不可能失败**的:

| 注入的断裂 | 第一次结果 | 原因 |
| :--- | :--- | :--- |
| `FAST_PER_SLOW *= 2` | **通过**(漏) | 期望值用被改的常量算,两边同变,永远相等 |
| 删掉 `aoi.update()` | **通过**(漏) | 断言看 `snapshot().mobs`(已**注册**数),不是已**唤醒**数 |
| `simSeconds` 除以 2 | **通过**(漏) | 门禁当时根本没覆盖时间基 |

修正后重新注入,三种断裂**全部被捕获**:

```
✗ 快慢比例常数 20 ≠ 手册规定的 20/2 = 10
✗ AOI 唤醒未动:期望 > 0(生物被 AOI 唤醒并推进),实际 0
✗ 模拟时间基错误:第 1 帧(FAST)报 0.5,应为 0.05
```

教训与 `verify.ts` 此前两次修正一致:**断言必须能失败,否则它不是门禁,只是装饰**。判据应当是外部事实(手册规定的 20Hz/2Hz),不是被测代码自己的常量。

---

## 10. 未决

| # | 问题 | 现状 | 建议 | 需谁裁决 |
| :--- | :--- | :--- | :--- | :--- |
| US1 | ~~**生物行为未接入**~~ **已解决(CR-6)** | 已构造 `MobHost` 并每慢帧 `tickMobs([...aoi.activeMobs])`,25 个 AI 的 `tick` 在生产可达(实测 100 帧推进 100 次;8 只生物产出预警) | 移动权威已由 **CR-9 方案 D** 一并解决(FSM 基础移动 + AI 专属动作,位置恒同步;此前 22/24 生物永远站着) | 已解决 |
| US2 | ⚠️ ~~**网关联动未接**~~ **已接线 —— 本行措辞已陈旧(2026-11-14 订正)** | `RoomRuntime` **已经**每帧驱动世界:`room.ts:1547` 的 `host.advance(1)`(task-59 接的)。**端到端实测**(net-persist `docs/TASK-85-us2-wiring-plan.md`):真起 `startWsServer` + 真 WS 客户端 ⇒ 世界帧 **0→39**、`welcome` 收到、帧可 `decodePacket` ⇒ 真 `WorldSim` 在跑 | ★ 原措辞「`RoomRuntime` 与 `WorldSim` **互不依赖**」只对**字面**成立:两者确实互不 `import`,但依赖经 **`WorldSaveHost` 结构化接口**成立 ——**「不认识这个名字」≠「不能驱动它」**。⚠️ 本行此前误导了 backlog 探针:它用**名字口径** `/WorldSim\|world_sim/` 判断,而 `room.ts` 里该名字**只出现在注释**(去注释后 0 命中)⇒ 探针**永远 dormant**,使「已通」长期显示为「未开」。**已裁决改行为口径** `/host\s*\.\s*advance\s*\(/`(`scripts/backlog.ts`) | Lead + WS-07 |7 |
| US3 | ~~**战斗与炼金未进循环**~~ **伤害部分已解决(CR-7)** | 伤害管线已进慢帧循环:`resolveMobStrikes()` 消费预警通道 + 事件通道,`vitals.applyHit` 结算。**炼金(WS-06)与 Boss 阶段(WS-05)仍未进循环** | 剩余:炼金是**交互驱动**(玩家主动合成)而非每帧推进,不需要进循环;WS-05 的 Boss 阶段需接入 `tickMobs` | 部分解决 |
| US4 | ~~**流体预算在大世界偏低**~~ **已修正诊断,见下** | 原判断为「1024 格/慢帧不够,建议提高预算或按玩家距离加权」 | **实测推翻**:512×512 每步仅 0.99ms,占 500ms 慢帧预算的 **0.2%** —— CPU 不是瓶颈。真瓶颈是**覆盖延迟**:纯游标轮询下一格被访问的间隔 = `n/budget` 慢帧,实测 128×128 让水铺 25 行需 **2268 秒**(64×64 只需 39 秒)。已改为「活跃格优先 + 游标兜底」,四数量级世界耗时一致(约 32 秒)。详见 [FLUID-BUDGET.md](FLUID-BUDGET.md) | 已解决 |
| US5 | ~~**`WorldGrid` 与 `FluidField` 的双份状态**~~ **已解决(真缺陷,详见 §10.1)** | **本文档原描述偏轻**:不是「靠 `setCell` 显式同步」,而是**只同步了 `elev`、漏了 `obj→solid`**。`WorldGrid.isSolidAt` 判 351~371 为墙,`FluidField.solid` 却仍是 0 → **水直接穿墙**。实测:左高右低 + x=8 竖一道 351 墙,800 帧后墙右侧积水 **5844 毫格**;补投影后为 **0**。已在 `setCell` 里同步 `solid` | 原建议「让 `FluidField` 读 `WorldGrid`」**不采纳**:`base`/`amount` 是流体独有状态,`WorldGrid` 里没有对应字段,读不到。改为「唯一入口 `setCell` 同时投影 `elev` 与 `solid`,并以 `grid.isSolidAt` 为唯一判据」 | 已解决 |
| US6 | ~~**`snapshot()` 的字段有限**~~ **已解决(前提为假,详见 §10.1)** | `snapshot()` 确实是 7 个粗粒度计数,但「观测哪个生物在动 / 哪条线通了」这层需求**已由别的接口满足**:`SimFrameReport`(每帧)带 `activeMobs` / `fluidActive` / `fluidMoved` / `wireCellsLive` / `spawned`;`MobHost.inspectMob(id)` 给单只 AI 状态;`MobHost.ais()` 给出每只用的 AI 类;`lastMobTicks` 给出逐只 warns/error | 无需再扩 `snapshot()` —— 它是**刻意保守的汇总**,细粒度看 `SimFrameReport`。原「当前够用」的判断成立 | 已解决 |
| US7 | **无回放/录制** | **仍开放,已核实**:全仓检索 `replay` / `record` / `inputQueue` / `applyInput` 等符号,**生产代码零命中**(`grep` 全 `server/src` 仅命中 `Record<...>` 类型与事件总线的 `record()` 私有方法,非输入录制)。确定性**已成立且有门禁**:`verify.ts` 断言同种子 300 帧终态逐字节一致 | 缺的是**输入录制层**:需要(1) 每帧输入的规范化序列(动作 + 帧号),(2) 一个 `ReplayDriver` 用录制回放替代真实输入,(3) 与 `mulberry32` 种子一起打包。`WorldSim` 已把 `rng` 做成注入项(`world_sim.ts:205`),是回放的前提,已在位 | Lead(是否要做) |
| US8 | ~~**`CarrySystem` 已构造但未接入循环**~~ **已解决(CR-10)** | 原状态比描述更严重:不只是 `tick` 未被调用,而是 `new CarrySystem(new Map())` —— 一份**与物理无关的空表**,玩家从未进入,`this.carry.xxx()` 调用点为 **0**。举投(WS-02 核心)在生产中**完全不可达**,而 WS-02 的 43 条断言全绿(因为它们直接 `new CarrySystem(map)` 测,从不经编排层)。已修为 `carryActors()` 活视图(直接读 `physics.bodies`)+ `lift`/`dropTop`/`throwPlayer` 三个入口 + 每慢帧 `carry.tick(0.5)` | 见 `CHANGE_REQUESTS.md` CR-10 | 已解决 |

---

## 10.1 US5 / US6 / US7 的核查证据(task-17)

### US5 —— 双份状态:从「描述偏轻」到**确认真缺陷**并修复

**核查方法**:不读文档推断,直接跑对照实验 —— 同一场景下比较「只 `setCell({obj})`」与「`setCell` + `setSolid()`」。

**缺陷证据**(修复前):

| 写入方式 | `grid.isSolidAt(8,8)` | `fluid.solid[8,8]` | 800 帧后墙右侧水量 |
| :--- | :--- | :--- | :--- |
| `setCell(8,y,{obj:351})` | `true` | **`0`** | **5844 毫格(水穿墙)** |
| `setCell(8,y,{obj:359})` | `true` | **`0`** | **5844 毫格(水穿墙)** |
| `setCell` + `setSolid(8,y,true)` | `true` | `1` | 0(挡住) |

关键代码链:

- `world_sim.ts:332-334`(修复前)只投影 `elev`:`if (elev !== undefined) this.fluid.setCell(x, y, { elev })` —— **`fields.obj` 被完全忽略**;
- `grid.ts:194-198` `isSolidAt` 的判据是 `obj` ∈ [351, 371];
- `fluid.ts:262` `setCell` 只在 `init.solid !== undefined` 时才写 `solid[]`;
- `world_sim.ts:338` `setSolid()` 是补投影的**唯一入口**,而全仓检索它**零生产调用点**。

**修复**(`world_sim.ts:339-344`):`setCell` 收到 `obj` 时同时投影 `solid`,且以 `grid.isSolidAt(x, y)` 为**唯一判据** —— 不在编排层另立一份墙体 ID 区间,否则又是第二份真相:

```ts
const obj = fields.obj;
if (obj !== undefined && this.fluid.inBounds(x, y)) {
  this.fluid.setCell(x, y, { solid: this.grid.isSolidAt(x, y) });
}
```

修复后实测:351 / 359 全部**挡住**(右侧 0 毫格);`obj=900`(非墙)仍正确放行(5844),证明判据没有过度收紧。

**为什么原建议不采纳**:原建议是「让 `FluidField` 读 `WorldGrid` 而不是自己存 `elev`」。核查后不成立 —— `FluidField` 除 `elev` 外还持有 `base` / `amount`,这两个是流体独有状态,`WorldGrid` 里没有对应字段,读不到。真正的解法是**收敛写入入口**(已做),而不是消灭副本。

### US6 —— 前提已不成立

`snapshot()`(`world_sim.ts:969`)确实只有 7 个粗粒度字段。但「要观测哪个生物在动、哪条线通了」这层需求**已经有接口满足**,不必再扩它:

| 需求 | 已有接口 | 位置 |
| :--- | :--- | :--- |
| 哪个生物在动 | `SimFrameReport.activeMobs`(每帧) | `world_sim.ts:78-88` |
| 逐只的预警与错误 | `lastMobTicks: MobTickResult[]` | `world_sim.ts:196` |
| 电路是否真的通了 | `report.wireCellsLive`(稳态)vs `wireCellsFlooded`(增量) | `world_sim.ts:102-105` |
| 流体是否在工作 | `report.fluidActive` / `fluidMoved` | `world_sim.ts:98-101` |
| 单只 AI 的内部状态 | `MobHost.inspectMob(id)` / `ais()` | `host.ts:514` 附近 |

**结论**:US6 的「当前够用」判断成立,**无需改动**。`snapshot()` 定位是「跑测试时一眼看全局」的保守汇总,细粒度观测是 `SimFrameReport` 的职责,两者分工清晰。

### US7 —— 仍开放(已核实,不是「待定」)

**核实结果**:全仓检索 `replay` / `Replay` / `inputQueue` / `applyInput` / `ReplayDriver`,**生产代码零命中**。唯一命中 `record` 的是事件总线 `bus.ts:347` 的私有 `record(DeliveryRecord)`(投递历史,与输入录制无关)。**没有实现,也没有半成品。**

**已具备的前提**(缺的只是最后一层):

1. 确定性已成立且有门禁 —— `verify.ts` 断言「同种子两次运行 300 帧终态逐字节一致」;
2. 随机源已**注入化** —— `WorldSim` 的 `rng` 是构造参数(`world_sim.ts:205`),`MobHost` 的 `rng` 同样注入(`host.ts` 构造器),全仓生产路径无 `Math.random`(仅 `room.colyseus.ts:152` 用于生成房间 ID,不在模拟内);
3. `tick()` 无隐藏外部输入 —— 所有输入经 `addPlayer` / `setMobPlayers` / `setGroundItems` / `lift` / `dropTop` / `throwPlayer` 等显式入口。

**缺什么**(若要关闭,需要三件):(1) 输入的规范化录制(动作 + 帧号,且顺序稳定);(2) 一个 `ReplayDriver` 用录制序列替代真实输入;(3) 与种子一起打包成可复现文件。**是否要做取决于是否需要 bug 复现工具** —— 这是产品决策,不是技术障碍,故**保留开放**并交由 Lead 裁决。

> **台账计数影响(需 Lead 协调)**:US5 / US6 现在标记为**已解决**,故 `scripts/backlog.ts` 的统计会从 `72 条 / 53 未关闭 / 0 阻塞 / 19 已关闭` 变为 **`72 条 / 51 未关闭 / 0 阻塞 / 21 已关闭`**。而 `verify.ts:1714-1735` 会把该统计与 `README.md` 的「未决台账 72 条(53 未关闭 / 0 阻塞 / 19 已关闭)」逐项对照,**`README.md` 不在本任务写域**(归 Lead)。因此如实标记后,这一条门禁会因 README 数字过期而报红,需 Lead 把 README 更新为 `72 条(51 未关闭 / 0 阻塞 / 21 已关闭)`。
>
> 这里**没有**为了绕开门禁而把结论写成模糊措辞 —— 台账的存在意义就是让「文档与代码不符」变红;这一次它正确地红了,红的不是文档,而是尚待刷新的 README 数字。

