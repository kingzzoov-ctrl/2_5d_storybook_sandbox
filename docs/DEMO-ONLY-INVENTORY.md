# demo 独有模块清单与接线分组(task-50)

> **用途**:US2 接线分批派工的依据。
> **口径**:所有数字用 `scripts/verify.ts` **自己的 lexer**(逐字符扫描,跳过注释与字符串)。
> 测量方式见文末「复现」;`我以为` 与 `我实测` 全程分开标注。

---

## 0. 一句话结论

**「demo 独有 39 个」在结构上不是 39 个独立欠账,而是「1 个枢纽 + 38 个挂件」。**

实测:把 `server/src/sim/world_sim.ts` 这**一个文件**并进真入口闭包,39 个里 **38 个立刻变可达**,
只剩 `server/src/sim/demo.ts` 自身(它当然只能由自己进)。逐条证据见 §3。

⇒ **US2 的接线面是 1 条缝,不是 39 个模块。** 挂件不需要逐个接线 —— 它们本来就挂在 `world_sim` 上。
这决定 US2 拆分方式与任务书预设不同,见 §5。

---

## 1. 口径(每个数字说清分母)

| 量 | 值 | 定义 |
| :-- | --: | :-- |
| `prodAll` | **83** | `server/src` + `client/src` 全部 `.ts` |
| `reach` | 76 | 三入口闭包(**Set,含 `shared/**`**) |
| **可达** | **69** | `prodAll ∩ reach` |
| **不可达** | **14** | `prodAll − reach` |
| **demo 独有** | **39** | `可达 − (去 demo 两入口闭包 ∩ prodAll)` |
| 两真入口可达 | 30 | `可达 − demo 独有` |

- **demo 独有 / 可达 = 39/69 = 56.5%** ← 门禁印的就是这个分母
- demo 独有 / 全量 = 39/83 = 47.0%(**另一种口径,不是 56.5% 的那个**)

**与门禁自报逐数吻合**:门禁印「可达 69 / 不可达 14(共 83)」+「demo 独有 39」,本探针三项全部一致。

> ⚠ **源码注释已过时**:`scripts/verify.ts:1340-1347` 的注释写「全仓 83,可达 67,demo 独有 53(79.1%)」。
> 实测现在是 **69 / 39(56.5%)**。注释里那套 53/67 是**接线前的历史值**。
> 本文件不改 `verify.ts`(不属本任务写域),仅在此记录差异。

---

## 2. 39 个模块逐个(按目录分组,含规模与反向引用)

「被引用」= 全仓(含 `tests/**`、`scripts/**`)中 import 它的文件数,用同一套 lexer 计。

### alchemy(7)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/alchemy/index.ts` | 512 | 3 | 无需额外前提:**直接被 `world_sim.ts` import**,枢纽直连 |
| `server/src/alchemy/cache.ts` | 413 | 2 | 同上,枢纽直连 |
| `server/src/alchemy/attributes.ts` | 644 | 5 | 无需额外前提;alchemy 内部互相引用 |
| `server/src/alchemy/degrade.ts` | 390 | 1 | 无需额外前提 |
| `server/src/alchemy/gate.ts` | 398 | 3 | 无需额外前提 |
| `server/src/alchemy/pixel_icon.ts` | 518 | 3 | 无需额外前提 |
| `server/src/alchemy/prompt.ts` | 764 | 2 | 无需额外前提 |

### mobs(6)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/mobs/behaviors.ts` | 1378 | 6 | 无需额外前提(枢纽直连;**注意也被 `scripts/verify.ts` import**) |
| `server/src/mobs/host.ts` | 696 | 2 | **需 tick 驱动**:由 `world_sim` 慢帧推进 |
| `server/src/mobs/aoi.ts` | 272 | 4 | 无需额外前提 |
| `server/src/mobs/spawner.ts` | 270 | 4 | 需世界种子/刷新参数 —— 由 `world_sim` 提供 |
| `server/src/mobs/fsm.ts` | 344 | 3 | 无需额外前提 |
| `server/src/mobs/geometry.ts` | 242 | 7 | 无需额外前提 |

### combat(6)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/combat/weapons.ts` | 859 | 4 | 无需额外前提(枢纽直连) |
| `server/src/combat/damage.ts` | 616 | 2 | 无需额外前提(枢纽直连) |
| `server/src/combat/vitals.ts` | 605 | 1 | 无需额外前提(枢纽直连) |
| `server/src/combat/cooking.ts` | 527 | 6 | 无需额外前提(枢纽直连) |
| `server/src/combat/progression.ts` | 440 | 3 | 无需额外前提 |
| `server/src/combat/revive.ts` | 349 | 2 | 无需额外前提 |

### bosses(4)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/bosses/runtime.ts` | 277 | 2 | 无需额外前提(枢纽直连) |
| `server/src/bosses/raid.ts` | 494 | 3 | 无需额外前提(枢纽直连) |
| `server/src/bosses/breaks.ts` | 447 | 3 | 无需额外前提 |
| `server/src/bosses/phases.ts` | 415 | 4 | 无需额外前提 |

### build(4)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/build/rooms.ts` | 571 | 4 | 无需额外前提(枢纽直连) |
| `server/src/build/blueprint.ts` | 626 | 2 | 无需额外前提(枢纽直连) |
| `server/src/build/autotile.ts` | 473 | 3 | 无需额外前提 |
| `server/src/build/grid.ts` | 182 | 5 | 无需额外前提 |

### wiring(3)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/wiring/components.ts` | 807 | 3 | 无需额外前提(枢纽直连) |
| `server/src/wiring/graph.ts` | 946 | 7 | 无需额外前提(枢纽直连) |
| `server/src/wiring/logistics.ts` | 597 | 3 | 无需额外前提(枢纽直连) |

### world(3)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/world/chunk.ts` | 904 | 9 | 无需额外前提(枢纽直连) |
| `server/src/world/fluid.ts` | 778 | 6 | 无需额外前提(枢纽直连;**也被 `verify.ts` import**) |
| `server/src/world/grid.ts` | 301 | 2 | 无需额外前提(枢纽直连) |

### physics(2)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/physics/world.ts` | 805 | 6 | 无需额外前提(枢纽直连) |
| `server/src/physics/carry.ts` | 565 | 4 | 无需额外前提(枢纽直连;**也被 `verify.ts` import**) |

### sim(2)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/sim/world_sim.ts` | **3074** | 9 | ★ **这是那唯一的「缝」**:被 `demo.ts` 直连 import |
| `server/src/sim/demo.ts` | 213 | 0 | ⚠ 无任何引用方 —— 它是入口(由 `npm run sim` 拉起),不接线 |

### events(1)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/events/bus.ts` | 414 | 3 | 无需额外前提(枢纽直连;也被 `mobs/host.ts` 引用) |

### rooms(1)

| 模块 | 行数 | 被引用 | US2 接线前提 |
| :-- | --: | --: | :-- |
| `server/src/rooms/effects.ts` | 157 | 1 | 无需额外前提(枢纽直连) |

**合计 39 个,行数合计 23,283 行。按目录:alchemy 7 / combat 6 / mobs 6 / bosses 4 / build 4 / wiring 3 / world 3 / physics 2 / sim 2 / events 1 / rooms 1** —— 与 Lead 给的分布**逐个吻合**(Lead 那版是 37,差 2 是口径;本表用门禁印的 39 口径)。

---

## 3. ★ 结构性发现:一条缝,不是 39 个欠账

### 实测证据

```
基线(去 demo,两真入口)= 30 可达
只把 world_sim.ts 并进闭包后  = 68 可达
⇒ 新增可达 = 38
demo 独有 39 个里,这一条缝接通后就可达的 = 38
仍不可达的 = 1  →  server/src/sim/demo.ts(入口本身,理应如此)
```

### 为什么:dependency 形状

```
demo.ts(213 行)
  └─ import { WorldSim, FAST_PER_SLOW, SIM_FAST_DT, SIM_SLOW_DT } from './world_sim.ts'   ← 唯一的生产依赖
  └─ import { WireColor } from 'shared/types/tile.ts'                                       ← shared,已可达
```

`demo.ts` 全仓**只 import 2 个模块**。而 `world_sim.ts` 直接 import **32 个**模块(去重后),其中 **27 个**是 demo 独有;
其余 **10 个** demo 独有模块经 `world_sim` 的下游再传递
(`alchemy/attributes`←`degrade`/`gate`/`index`/`prompt`,`bosses/phases`←`breaks`/`raid`/`runtime`,
`build/autotile`←`rooms`/`wiring_view`,`build/grid`←`autotile`/`blueprint`/`rooms`,
`mobs/fsm`←`behaviors`/`host`,`mobs/geometry`←`phases`/`vitals`/`behaviors`/`fsm`/`host` 等);
再加上 `demo.ts` 自身 = **1 + 27 + 10 + 1 = 39** ✓

### 挂件的耦合程度(用于判断是否需要拆批)

| 类别 | 数量 | 说明 |
| :-- | --: | :-- |
| 仅被 `world_sim.ts` 引用 | 16 | 纯挂件 |
| 另有其他**生产**引用方 | 21 | 内部有子图(如 alchemy 7 个互相引用) |
| 无任何引用(入口自身) | 1 | `demo.ts` |

**这 21 个不是「额外工作量」** —— 它们是 `world_sim` 的下游,只要缝通了就一起通。
它们的内部引用关系决定的是**代码组织**,不是接线批次。

---

## 4. 「我认为」与「我实测」分开

### 我实测(有探针输出为证)

1. 可达 69 / 不可达 14 / 共 83,demo 独有 **39**(与门禁三个数字全部吻合)
2. 39 个按目录分布:alchemy 7 / combat 6 / mobs 6 / bosses 4 / build 4 / wiring 3 / world 3 / physics 2 / sim 2 / events 1 / rooms 1
3. `demo.ts` 全仓只 import **2** 个模块(`world_sim.ts` + `shared/types/tile.ts`)
4. 只接 `world_sim.ts` 一条缝 → 38/39 变可达,剩 `demo.ts` 自身
5. 每个模块的行数与反向引用方(§2 全表)
6. `world_sim.ts` 公开面:`WorldSim` 类 + `WorldSimOptions` / `SimFrameReport` / `FAST_PER_SLOW` / `SIM_FAST_DT` / `SIM_SLOW_DT` / `mulberry32`
7. `demo.ts` 驱动 `world_sim` 的方式:`new WorldSim({sizeCells:64})` → `addPlayer` / `addMob` / `fillRect` / `sim.run(total)`(**构造 → 填充 → run**,三段的顺序就是接线契约)

### 我认为(推论,未独立验证)

1. **US2 应以「把 `WorldSim` 挂进 `RoomRuntime`」为单一交付**,而不是「接 39 个模块」。
   依据是 §3 的实测形状,但「挂进去之后语义是否自洽」**未验证**。
2. 38 个挂件**不需要逐个派工**。这是我的判断;若 Lead 要求逐个有 owner,那属于管理选择,不是技术必需。
3. 唯一真正需要设计的接口是 **`WorldSim.run()` ↔ `RoomRuntime` 的 tick 对齐**
   (`RoomRuntime` 用 `DT` 20Hz;`WorldSim` 是「快帧 20Hz / 慢帧 2Hz,比例 1:10」的双频)。
   两套 tick 如何对齐**我未实测**。

### 未实测项

- `WorldSim` 在 `RoomRuntime` 里实例化后的**内存/性能**表现(3074 行 + 32 依赖)
- `world_sim` 的 `snapshot()` 与 `room.colyseus.ts` 的 delta 广播是否字段对齐
- 若 `RoomRuntime` 只接部分子系统(如只接 combat),是否可行 —— **未验证部分接线的可能性**,本文件的「一条缝」结论是「全接」口径

---

## 5. 分批建议(供 US2 拆分)

**不要按 39 个模块拆。** 按「缝 + 前置决策」拆:

| 批次 | 内容 | 前提 | 规模 |
| :-- | :-- | :-- | :-- |
| **US2-a** | 定义 `WorldSim` ↔ `RoomRuntime` 的 tick/状态契约 | 需架构决策 | 小(设计) |
| **US2-b** | 把 `WorldSim` 挂进 `RoomRuntime`(一条缝) | 依赖 a | 小到中 |
| **US2-c** | 验证 38 个挂件真的跟着活起来(按 §2 全表核对) | 依赖 b | **验收,非开发** |
| **US2-d** | 客户端 `attack` 报文接通 | 见 `docs/CLIENT-NET-READINESS.md` | 独立 |

⇒ **真正的工作量在 a + d**,b 是单点,c 是核对表。原任务书预设的「39 个模块分批接线」
会让一个人去接 38 个本来就连着的挂件 —— 那是**把一条缝切成 39 份**。

---

## 6. 复现方式

```bash
cd 2_5d_sandbox
node _di_extract.ts   # 从 verify.ts 抽取 walk/resolveImport/extractRelativeImports/reachableClosure/PROD_ENTRIES
node _di_measure.ts   # 口径 + 39 个清单 + 目录分布
node _di_rows.ts      # 行数 + 反向引用 + demo.ts 直接引用
node _di_hub.ts       # 「一条缝」验证
```

**为什么抽取而不是重写**:本仓已记「判定『谁引用谁』必须共用一套词法」。
手写正则与 `verify.ts` 的字符级 lexer 不同构,会产生第三套判决 ——
Lead 今天正是因自写扫描器漏判多行 `import` 而写出错误任务书(task-42 已作废)。
`_di_extract.ts` 把四个函数**源码文本**抽出后由 Node 自己 strip 类型,
逐字符保证与门禁同一套词法。

### 探针自证(先验已知答案,再量目标)

```
✓ server/src/sim/world_sim.ts 被 9 处引用(期望 >= 2)—— 世界编排应被多处引用
✓ server/src/wiring/components.ts 被 3 处引用(期望 >= 1)—— Lead 曾误报它 orphan 的那个
探针自证: 有效 ✓
```

> **计数口径必须写清**(否则同一天两份报告会对同一文件报出不同数字 —— 实测就发生过,见下):
> 我的自证数的是 **「有多少个文件 import 了它」**(文件数,去重)。
> 判据:对每个 `.ts` 用**门禁同源的 lexer** 提取相对导入,解析后与目标路径比对,
> **每个文件最多计 1 次**;排除 `_*` 临时脚本;`tests/**` 与 `scripts/**` **计入**。
>
> | 口径 | `world_sim.ts` | 说明 |
> | :-- | --: | :-- |
> | ①「import 它的**文件数**」 | **9** | ← 我的探针自证用的这个 |
> | ②「import **语句条数**」 | 9 | 本文件恰好一文件一条,故与①相同 |
> | ③「**文本出现** `world_sim` 次数」 | **82**(跨 22 文件) | 含注释/字符串/文件名提及,**不去重** |
>
> **同一文件 9 与 40 的差异不是谁错,是分母不同。**
> 复核时另一份报告对 `world_sim.ts` 报「40 处」,而我用上述三种口径都**没能**得到 40
> (①=9、②=9、③=82)⇒ **两份数字不可直接比较**,因为计数规则不同、且我不掌握对方的规则。
> **本文件所有「被引用」一律用口径①(import 它的文件数,去重)** —— 与 §2 表格一致,
> 这样至少**同一文档内自洽**。若要与他人数字对照,**必须先对齐规则再比**。

### 词法自检 12 形态(11 通过,1 项为**门禁 lexer 的真实盲区**)

| 形态 | 结果 |
| :-- | :-- |
| 单行 + `type` 限定符 | ✓ |
| 多行 import 夹 `type`(Lead 踩的坑) | ✓ |
| 裸 import / 忽略分号 / `export *` / re-export / `import type` / 多行多个 `type` | ✓ |
| 字符串幽灵依赖 / 行注释 / 块注释(必须不抓) | ✓ |
| **动态 `await import('./x.ts')`** | ✗ **抓不到** |

**动态 import 是 `verify.ts` lexer 的真实盲区**:它只在代码态识别 `import` / `from` 关键字后
**紧跟字符串**的形态,而 `import(` 后面跟的是 `(` 不是引号 ⇒ 整条漏掉。

**实测盲区范围(实测 2/11 形态漏抓)**:

| 形态 | lexer 结果 |
| :-- | :-- |
| `await import('./x.ts')` | `[]` ← **漏抓** |
| `import('./x.ts')` | `[]` ← **漏抓** |
| 字符串里提到 / 行注释 / 块注释 | `[]` ← **正确地不抓** |

**关键:必须说清分母。「0 处」只在门禁扫描面内成立。**

| 目录 | `.ts` 文件数 | 动态 import | 是否门禁扫描面 |
| :-- | --: | --: | :-- |
| `server/src` | 59 | **0** | ✓ 扫描 |
| `client/src` | 24 | **0** | ✓ 扫描 |
| `shared` | 8 | 0 | ✗ |
| `scripts` | 10 | **52** | ✗ |
| `tests` | 20 | **11** | ✗ |
| **合计(5 目录)** | **121** | **63** | — |
| 仓库根 `_*.ts`(临时脚本) | 31 个 | 48 | ✗(随时变) |

⇒ 门禁扫描面(`server/src` + `client/src`)**内 0 处**,故**不影响本次数字**。
> ⚠️ **但全仓不是 0 —— 实为 63 处**(`scripts/**` 52:`data-conformance.ts` 28 / `verify.ts` 20 / `orphan-audit.ts` 4;`tests/**` 11)。
> 一个宽松口径(`\bimport\s*\(` 计 63、`import('` 计 57)之间的差也来自「是否含模板串/换行形态」——
> **再小的数字也要给分母**。这一条正是本仓陷阱 27 的形态。

**方向:一旦有人把动态 import 用进生产目录,可达性会偏低**(漏边 ⇒ 多报不可达 ⇒ 掩盖).
本任务不改 `verify.ts`(非本任务写域),仅记录。

---

## 7. 临时脚本

`_di_extract.ts` / `_di_measure.ts` / `_di_rows.ts` / `_di_hub.ts` / `_di_lexcheck.ts` / `_di_lexer.ts`
已在交付前删除(`.gitignore` 覆盖 `_*`);复核后另建的 `_fx_*.ts` / `_v2_*.ts` 同样已删。
复现方式见 §6,可随时重建。