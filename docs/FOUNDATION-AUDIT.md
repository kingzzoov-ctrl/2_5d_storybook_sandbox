# 基座审计:未执行代码全量审计

> 任务:`task-12`
> 工具:`scripts/deadcode-audit.ts`(可复跑)
> 基线:`node scripts/verify.ts` 全绿(集成 38/38)
> 审计时间:2026-11-11

本审计针对一类反复出现的缺陷:**「完整实现、单测全绿、编排层不接」**。
在本次审计之前,这类缺陷已发现 6 例(2 例已修):

| # | 缺陷 | 状态 |
| :--- | :--- | :--- |
| 1 | 25 个 AI 的 `tick` 生产 0 调用 | 已修 CR-6 |
| 2 | `fsm.tick()` → 22/24 生物从不移动 | 已修 CR-9 |
| 3 | `CarrySystem` `new Map()` + 0 调用点 | 已修 CR-10 |
| 4 | `MobHost.interact/damage` 9 种事件永不触发 | 已修 CR-11 |
| 5 | `driver.sqlite.ts` 169 行从未执行 | 已修 CR-12 |
| 6 | `schema.colyseus.ts` + `room.colyseus.ts` 从未执行 | 已登记 |

**本次审计新增 3 条真缺陷**,且都带运行时证据(见 §3)。

---

## 1. 审计方法

### 1.1 为什么上一轮的判据太宽

上一轮做过一次宽扫,得到「**866 个导出符号只在测试出现**」。这个结果没有诊断力 ——
**库函数本来就被编排层或彼此消费**,「只在测试出现」对它们毫无意义。
本审计的原则是**宁可漏报,不可虚报**:每条发现都必须能被人工复核。

### 1.2 收紧后的判据

「真缺陷」需**四条同时**满足:

1. **有状态** —— 导出的类持有可变字段(非 `readonly` / 非 `static`),或函数带增量语义;
2. **有驱动方法** —— 名字匹配 `tick|step|advance|apply|drain|update|pump|refresh|flush|consume|settle|decay|evolve|process|run|drive|dispatch|commit`,**且不是 `private`**;
3. **生产零调用** —— 在 `server/src` + `client/src` 内的调用点数为 **0**(排除 `tests/`、排除注释、排除方法定义行自身);
4. **模块已接入** —— 所属模块在 `npm run sim`(→ `sim/demo.ts` → `world_sim.ts`)的**可达闭包**内。

第 4 条是诊断力的分水岭。本仓 74 个生产文件里**只有 16 个**在可达闭包内,于是:

- **A 档**:模块已接入世界,却漏接了这一个驱动入口 → 这才是「AI tick 零调用」那一类**真缺陷**;
- **B 档**:模块根本不在可达闭包内 → 属于「该 WS 尚未编排」,已由 `SIM-orchestration.md` US2/US3 登记为刻意解耦,裁决为**合理**。

### 1.3 三个必须做对的技术细节

这三处都是**实测踩出来的**,写下来是为了让后人不必再踩:

1. **必须剥注释**。本仓的文档注释里大量出现 `aoi.stepActive(() => {})`、
   `CarrySystem.tick` 这类**示例代码**。不剥注释会把已经死掉的调用伪装成活的 ——
   直接产生假阴性,而本审计要抓的恰恰是「看起来被调用过」这一类。
   剥注释时**必须保留换行**,否则 `file:line` 证据会全部错位、无法复核。

2. **必须卡驼峰词边界**。第一版用 `run\w*` 匹配 `run` 家族,结果 `runtimes`
   (run + times,名词复数)被误判成驱动方法,「快照访问器」被误报成「漏接的驱动入口」。
   修正为「动词前缀后必须紧跟大写字母或字符串结尾」。

3. **注册表类探测器必须用保留字符串的副本**。`kind: 'LEVER'` 在去字符串副本里
   会变成 `kind: '     '`,于是按字符串消费注册表的调用点**全部消失**,
   探测器**静默不报**(自己把自己骗过去)。故审计为每个文件维护两份副本:
   `code`(去注释+去字符串,供调用点统计)与 `linker`(仅去注释,供路径与字面量解析)。

### 1.4 四个探测器

| 探测器 | 抓什么失效模式 |
| :--- | :--- |
| 一、驱动入口零调用 | 模块已接入,但某个 `tick`/`step`/`drain` 生产从不被调 |
| 二、只写不读的状态 | 有状态容器只被 `push`/`set`,其内容**没有任何外部读者** |
| 三、注册表提供者不可达 | 模块靠副作用注册行为,但生产从不 `import` 它 → 注册表运行时为空 |
| 四、未注册的 kind 引用 | 生产按字符串构造 `kind='X'`,但注册表里**根本没有 X** |

探测器三、四是互补的:三查「表是空的」,四查「键是错的」。
两者都指向同一个运行后果 —— **静默地什么都不做**。

---

## 2. 裁决口径

| 裁决 | 含义 |
| :--- | :--- |
| **真缺陷** | A 档可达 + 生产零调用 + 有测试调用,**且未登记为已知未决** |
| **合理** | 显式排除 / 整个 WS 未编排 / 已在未决台账登记 |
| **无法判断** | 零调用且无测试、也无可查依据(多为预留 API) |

「**已在未决台账登记**」这一档很关键:审计的目的是**发现未知**,不是把已经由
Lead 裁决「刻意不做」的条目反复报成新缺陷。故审计内置 `KNOWN_BACKLOG` 登记表,
依据 `docs/DAMAGE-LOOP.md`、`docs/SIM-orchestration.md` 与 `node scripts/backlog.ts`。

---

## 3. 发现清单

### 3.1 真缺陷(3 条,均带运行时证据)

#### 缺陷 A:`FluidField.pendingObj` 只进不出 —— 相变产物永远到不了 OBJ 层

- **位置**:`server/src/world/fluid.ts:659`(字段)、`:661`(唯一消费者 `drainPhaseProducts`)
- **零调用证据**:`drainPhaseProducts()` 生产调用 **0** 处 / 测试 3 处(`WS-01.test.ts:619/633/680`)
- **写入证据**:`phasePass()` 在 `fluid.ts:646/647` 每帧 `push` 两个相变产物

运行时复现(构造「水 | 熔岩」接触对,只调 `step()` 模拟生产行为):

```
步进前 pendingObj = 0
步进 1 帧后 pendingObj = 8
再跑 500 帧后 pendingObj = 8
```

`phasePass()` 确实在产出(1 帧内产出 8 条),但**没有任何代码取走它们**。
`world_sim.ts:812` 只调 `this.fluid.step(this.fluidBudget)`,从不调 `drainPhaseProducts()`。

- **后果**:玩家让熔岩与水接触,**看不到黑曜石 / 多孔浮石**(产物永远到不了 `WorldGrid` 的 OBJ 层)。
  同时 `readonly pendingObj` 数组在极端场景会无界增长(内存泄漏形状)。
- **旁证**:`docs/FLUID-BUDGET.md:227` 在「下游耦合」表里宣称由 **`pushPendingObj`**
  写回 OBJ 层 —— 而**该函数全仓不存在**(`grep pushPendingObj` 零命中)。
  文档承诺了一个从未实现的桥接函数,正是它让这个缺口长期不可见。
- **裁决**:**真缺陷**。修法只需一行(在 `world_sim` 的慢帧里 drain 并 `setCell({obj})`),
  但涉及 WS-01 与编排层的写域,故**报告而不自行修改**。

#### 缺陷 B:`components.ts` 不在生产可达闭包内 —— 40 项电路件全是空壳

- **位置**:`server/src/wiring/components.ts`(注册 40 个 kind)
- **证据**:生产目录 `server/src` + `client/src` 内**没有任何文件 `import` 它**;
  唯一的引用来自 `tests/WS-08.test.ts`
- **运行时证据**:

```
未 import components.ts 时:
  hasComponentKind("LEVER")     = false
  hasComponentKind("LOGIC_AND") = false
import components.ts 之后:
  hasComponentKind("LEVER")     = false
  hasComponentKind("LOGIC_AND") = true
```

`graph.ts` 的 `REGISTRY` 由 `components.ts` 在**模块加载时**填充。
生产侧从不 import 它 → 运行时注册表为空 → 所有 kind 都解析成**永不求值的空壳**。

- **后果**:WS-08 的 40 项电路件行为(AND/NOT、延时继电器、分流器、计数器、
  无线广播、执行器、防御、物流……)在生产中**全部不可达**。
  `demo.ts` 建了 `SignalGraph`、铺了 10 格红线,但那个组件不会做任何事。
- **旁证**:`demo.ts` 的冒烟输出里 `通电格=10` 完**全来自** `addWireDrive` 的驱动,
  第 1 帧之后 `泛洪增量` 恒为 `0` —— 组件没有贡献任何信号。
  而 demo 的自检却宣称「全部子系统可同时实例化并协同运行(**电路**……)」——
  **自检只验证了「线能通电」,没验证「件能求值」**,这正是缺陷长期隐形的原因。
- **裁决**:**真缺陷**。修法是编排层 `import '../wiring/components.ts'` 一次
  (副作用注册),属 `world_sim.ts` 写域,故报告不自行修改。

#### 缺陷 C:`demo.ts` 使用了未注册的 kind `'LEVER'`

- **位置**:`server/src/sim/demo.ts:39`
- **证据**:注册表共 40 个 kind,`'LEVER'` **不在其中**;
  正确名是 `'SENSOR_LEVER'`(`components.ts:331`,403 双态机械拉杆)
- **运行时证据**:`hasComponentKind('LEVER') = false`,即使 import 了 `components.ts` 之后仍为 false
- **后果**:即便缺陷 B 被修好,这个组件依然不会求值 —— 字符串拼错,静默无效。
- **裁决**:**真缺陷**。一行修改(`'LEVER'` → `'SENSOR_LEVER'`),但在 `demo.ts` 写域,故报告不自行修改。

### 3.2 A 档 · 无法判断(1 条)

| 符号 | 位置 | 证据 | 说明 |
| :--- | :--- | :--- | :--- |
| `WorldSim::runForSeconds` | `server/src/sim/world_sim.ts:952` | 生产 0 / 测试 0 | `run()` 是生产驱动入口;`runForSeconds()` 是「按秒推」的便利包装,已被 `demo.ts` 的 `sim.run(total)` 取代。疑似预留 API,**无法判断** |

### 3.3 A 档 · 合理(6 条)

| 符号 | 位置 | 证据 | 裁决依据 |
| :--- | :--- | :--- | :--- |
| `AoiManager::stepActive` | `mobs/aoi.ts:224` | 生产 0 / 测试 3 | **刻意排除**:回调签名不返回结果,无法把推进归因到具体生物;已由 `mobHost.tickMobs([...aoi.activeMobs])` 接管 |
| `CarrySystem::applyImpulse` | `physics/carry.ts:435` | 生产 0 / 测试 6 | 已知未决 `DAMAGE-LOOP.md D1`:击退需写回 `PhysicsBody`,涉及移动权威归属 |
| `PhysicsWorld::applyImpulse` | `physics/world.ts:621` | 生产 0 / 测试 6 | 同上(D1 的两个落点之一) |
| `applySafeZoneShield` | `mobs/spawner.ts:210` | 生产 0 / 测试 11 | 已知未决:安全区减伤只落在「生物打玩家」一侧;玩家打生物的伤害走 `damage.ts`(WS-10),该模块整体未编排 |
| `SignalGraph::runUntil` | `wiring/graph.ts:708` | 生产 0 / 测试 3 | 合理:`run()` 是生产入口,`runUntil(pred)` 是「跑到条件成立」的测试便利封装 |
| `decayTrace` | `physics/world.ts:770` | 生产 0 / 测试 1 | 合理:纯观测工具(返回速度序列供断言),不承担世界推进职责 |

### 3.4 第二探测器 · 只写不读状态(3 条)

| 字段 | 位置 | 写入/外部读取 | 裁决 |
| :--- | :--- | :--- | :--- |
| `pendingObj` | `world/fluid.ts:659` | 2 处 / **0 处** | **真缺陷**(= 缺陷 A) |
| `fx` | `physics/world.ts:220` | 12 处 / 0 处 | **合理**:本帧特效队列,由本文件 `step()` 开头 `this.fx.length = 0` 自行消费;表现留给 WS-09 客户端,服务端只保留一帧 |
| `unknownMobs` | `sim/world_sim.ts:670` | 1 处 / 0 处 | **合理**:可观测性字段,记录「传了错 ID」的生物;`EVENT-BUS.md U7` 已登记「是否应为硬失败」为未决 |

### 3.5 B 档 · 整模块未编排(37 条符号 / 22 个模块)

这些模块**完整、测试全绿**,但整个 WS 尚未接入世界。有测试调用、属「尚未编排」,
**不是编排层漏接**,故裁决为合理。按模块归并:

| 模块 | 符号数 | 归属 WS |
| :--- | ---: | :--- |
| `party/modes.ts` | 8 | WS-11 四大竞技模式状态机 |
| `coop/rush_order.ts` | 5 | WS-11 抢单协作 |
| `social/afk.ts` | 3 | WS-11 挂机/生态箱 |
| `combat/damage.ts` | 2 | WS-10 八步伤害公式(生产不可达 —— 见下) |
| `combat/progression.ts` | 2 | WS-10 击杀结算 |
| `combat/revive.ts` | 2 | WS-10 复活/无敌 |
| `physics/world.ts`(私有件) | 2 | `stepBody` / `applyVortex` 为 `private`,由 `step()` 内部驱动 |
| `bosses/phases.ts` | 1 | WS-05 Boss 阶段 —— `US3` 明确「需接入 `tickMobs`」,尚未做 |
| `bosses/breaks.ts` | 1 | WS-05 破防 |
| `build/blueprint.ts` | 1 | WS-03 接力队列 |
| `combat/cooking.ts` | 1 | WS-06 食物增益 |
| `db/repo.ts` | 1 | WS-07 仓库 |
| `net/delta.ts` | 1 | WS-07 增量同步(US2「刻意解耦」) |
| `mobs/taming.ts` | 1 | WS-04 牧场 |
| `prank/immunity.ts` | 1 | WS-11 免疫 |
| `party/scoring.ts` | 1 | WS-11 计分 |
| `wiring/logistics.ts` | 1 | WS-08 物流(见 §3.6) |
| `client/src/*`(6 个) | 6 | WS-09 客户端渲染 —— 本仓无客户端入口 |

### 3.6 一个值得单独指出的结构性问题:WS-10 伤害链整体不可达

`combat/` 下 5 个模块(damage 458 行 / weapons 794 行 / progression 383 行 /
revive 311 行 / cooking 360 行,**合计约 2300 行**)**只被测试 import**:

```
tests/WS-10.test.ts:  import ... from '../server/src/combat/{weapons,damage,progression,revive,cooking}.ts'
tests/WS-FND-04.test.ts: import { FOODS } from '../server/src/combat/cooking.ts'
生产目录:              零命中
```

而 `world_sim.ts` 走的是**另一条**伤害路径:`VitalsSystem.applyHit` ——
它是「生物打玩家」的**简化版**(`mobHitDamage(level, mul)`),与 `damage.ts` 的
**八步公式**(暴击/闪避/格挡/元素/击退/吸血/破盾)完全不是同一套。

- **后果**:玩家打生物的完整伤害公式在生产中不可达;`damage.ts` 算出的
  `knockbackImpulse` 字段**生产内零消费者**(击退冲量算了但没人施加)。
- **交叉印证**:这与 `DAMAGE-LOOP.md D1`(击退未实现)、`US3`(「伤害部分已解决」)
  相互印证 —— 已登记的「玩家受伤无击退」的下半段,即「玩家攻击走简化路径」,
  **此前未被明确指出**。
- **裁决**:**合理(已知未决,但诊断需细化)**。US3 只说「伤害部分已解决」,
  容易被读成「WS-10 已接入」;实际接入的是**生物→玩家**方向,
  **玩家→生物**方向仍走简化路径。建议在 `US3` 补一句方向性说明。

### 3.7 顺带发现:生产入口的自检口径偏弱

`demo.ts` 的自检断言「全部子系统可同时实例化并协同运行(地形/物理/流体/**电路**/AOI/刷怪)」,
但如 §3.1 缺陷 B 所述,`电路` 只验证了**线能通电**(`wireCells=10` 来自 `addWireDrive`),
**没有验证件能求值**。建议把自检改为「铺一条线 + 放一个 `SENSOR_LEVER` + 断言其 `state` 发生变化」,
这样缺陷 B 会立刻变成红灯。

> 这一类「**自检与实现同步退化**」与本审计抓的「单测全绿但编排不接」是同源问题:
> 验收标准本身太弱时,缺陷可以合法地长期存活。

---

## 4. 排除清单(显式登记)

**刻意不驱动**的符号。列出理由与接管方,**不自动跳过** ——
目的是让后来者一眼看到「这里为什么没被调用」,而不是再次踩坑后重复审计。

| # | 目标 | 理由 | 接管方 |
| ---: | :--- | :--- | :--- |
| 1 | `server/src/mobs/aoi.ts::stepActive` | 回调 `(id, rec) => void` **不返回结果**,无法把推进产生的移动/事件归因到具体生物 | `world_sim.ts` 改用 `mobHost.tickMobs([...aoi.activeMobs], SIM_SLOW_DT)`;归因由 `MobHost` 负责 |
| 2 | `server/src/sim/demo.ts` | 它是**最外层**演示入口(`npm run sim`),由人手动运行,不被任何生产模块 import | 无需接管 —— 它本身是消费者,不是被消费者 |

**已知未决登记**(命中这些的裁决为「合理」,依据台账):

| 符号 | 台账 | 理由 |
| :--- | :--- | :--- |
| `applyImpulse`(×2) | `DAMAGE-LOOP.md D1` | 击退需写回 `PhysicsBody`,涉及移动权威归属 |
| `applySafeZoneShield` | `SIM-orchestration.md US3` | 安全区减伤依赖 WS-10 伤害链接入 |
| `decayTrace` | WS-02 工具函数 | 纯观测工具,不承担推进职责 |
| `runUntil` | WS-08 便利 API | 生产用 `run()`,不需要「跑到条件成立」 |

---

## 5. 复跑方式

```bash
node scripts/deadcode-audit.ts             # 表格输出(摘要)
node scripts/deadcode-audit.ts --all       # 展开 B 档与已排除项
node scripts/deadcode-audit.ts --json      # 机器可读(含全部 finding)
```

输出含四段:**A 档真缺陷** / **A 档无法判断** / **第二探测器(只写不读)** /
**第三、四探测器(注册表)**;`--all` 追加 A 档合理项与 B 档整模块未编排。

---

## 6. 未决

| # | 问题 | 建议 |
| :--- | :--- | :--- |
| DA1 | 缺陷 A/B/C 均在本审计写域外(`fluid.ts` / `world_sim.ts` / `demo.ts`),按任务要求**只报告不修改** | 建议 Lead 分派:三处各约 1~3 行 |
| DA2 | B 档 22 个模块的「是否应当接入」需逐 WS 裁决 | 建议在 `SIM-orchestration.md` 的 US 表里补一行「模块 → 是否需进循环」的显式清单,避免每次审计重新争论 |
| DA3 | 生产入口可达性以 `demo.ts` 为唯一根 | 若将来新增服务端入口(如 `RoomRuntime`),需同步更新 `PROD_ENTRIES`,否则可达闭包会失真 |
| DA4 | 探测器二只覆盖「数组 / Map / Set 字面量初始化」 | 计数器类字段(`this.count = 0`)未覆盖;若需要,应按「字段被 `+=` 且无外部读取」扩展 |
| DA5 | 探测器四只覆盖组件 `kind` 注册表 | 本仓还有事件名、物品 ID 等其他字符串注册表,可用同一模式扩展 |
| DA6 | `README.md` 的断言数与台账数**已过期**:声称 WS-07=115/WS-09=60(实测 132/77)、台账 72/53/0/19(实测 76/55/0/21);另 `tests/WS-FND-06.test.ts` 有 1 条失败(419 音高档数 `undefined`) | **非本审计范围** —— 属其他 agent 正在并行修改的写域(README 与 WS-FND-06 由他人持有);本审计的交付物(`deadcode-audit.ts` / 本文件)**不被任何门禁 import**,不影响这些结果。已在回报中单独上报 Lead |
| DA7 | 审计的「可达性」判定基于**静态 import 闭包**,不覆盖动态 `import()` | 本仓生产代码目前无动态 import;若将来引入(如按需加载),"可达" 会漏判,需按 `import(` 字面量补充边 |
