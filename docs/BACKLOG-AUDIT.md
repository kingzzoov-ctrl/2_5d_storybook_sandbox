# 未决台账批量核查报告(task-14)

> 核查人:`combat-progress`(WS-10 实现者)
> 写域:`scripts/backlog.ts`、`docs/BACKLOG-AUDIT.md`(**未改动任何 `docs/**` 的未决表格** —— 按 Lead 指令,台账表格由 Lead 集中维护)
> 核查基线:`76 条 / 未关闭 55 / 阻塞 0 / 已关闭 21`(见 §1 的基线漂移说明)
> 复跑:`node scripts/backlog.ts`(台账)、`node scripts/backlog.ts --audit`(探针体检)

---

## 1. 基线与一处必须说明的漂移

开工时实测基线为 **72 条 / 未关闭 53 / 阻塞 0 / 已关闭 19**,与任务书一致。核查进行中台账发生变化:

- 新增 `docs/PERF-BOUNDS.md`(4 条,全部为「缺外部环境,无法判断」类),总数 72 → 76;
- `DAMAGE-LOOP.md D7` 被 task-17 改写为**「部分解决」**并划掉,`SIM-orchestration.md US7` 被改写为「仍开放,已核实」。

因此本报告的结论按**条目号**锚定,不按总数锚定。最终交付时实测 **80 / 56 / 0 / 24**
(期间的两次变动:`PERF-BOUNDS.md` 4 条 + 队友后续新增;以及 Lead 按本报告 §3.2 关掉 3 行)。
这不是我的写操作造成的(我只改 `backlog.ts` 与本文),而是并行队友正在写文档 —— 台账在这段时间里是一个**移动靶**。

### 1.1 关于「探针命中」的定性(初版判断已修正)

初版报告把这件事写成「验收标准互相冲突」,并建议给 `verify.ts` 加 `acknowledged` 放行语义。**这个判断是错的,Lead 已裁决纠正,此处保留记录以示修正:**

- **探针命中不是错误,是信号。** 它说的是「这条未决项该关了」,正确响应是**去关那条台账行**,而不是让门禁放行。
- 加 `acknowledged` 会让机制退化成「漂移白名单」——漂移一旦登记就永久合法,而它本该被修掉。这恰好违反本项目的核心判据:**一个不会失败的断言是装饰**。探针命中后门禁变红,是它**正常工作**的证明。
- 事实基础:我做的对照实验本身没错(注入会命中的探针 → `verify.ts` 退出码 1),错的是**从中推出的结论**。我把「门禁按设计报警」误读成了「门禁设计有缺陷」。
- 关行的正道:`detectStale` 走 `findLedgerRow`,而它**优先取未划掉的那行**(`backlog.ts` 中 `findLedgerRow` 的 `rows.find((r) => !/~~/.test(r))`),所以正确做法是给台账行加 `~~` 或写「已解决」,而不是让探针闭嘴。

**结论(修正后):探针命中 → 关掉对应台账行 → 门禁复绿。这是一个完整闭环,不需要改动 `verify.ts`。**

本报告 §3.2 的 3 条「已实现」判定已按此闭环执行:Lead 原样采纳并关行,`未关闭` 由 55 降至 52(随后因队友新增条目回升至 56)。


---

## 2. 本次对 `scripts/backlog.ts` 的改动

### 2.1 新增 17 条防御性探针(7 → 24)

原有 7 条探针描述的是**已关闭的历史条目**(US1/US3/US8/U5/U8/U1/F1),它们靠文档行被 `~~` 划掉而休眠。
新增 17 条描述的是**当前确实仍开放**的缺口,文档行未划掉,只能靠「实现符号在代码里尚不存在」而休眠。

语义因此更严格:一旦有人真的实现了该功能,探针立刻命中,提醒「这条未决该关了」——这正是台账该做的事。

| 文档 | 条目 | 探针文件 | 探针正则 | 判据 |
| :--- | :--- | :--- | :--- | :--- |
| DAMAGE-LOOP | D1 | `sim/world_sim.ts` | `applyImpulse\(` | 击退需写回物理体 |
| DAMAGE-LOOP | D2 | `sim/world_sim.ts` | `lineOfSight\|hasLineOfSight\|losClear` | 视线遮挡判定 |
| DAMAGE-LOOP | D3 | `combat/damage.ts` | `\bpvp\b\|\bPvp\b\|\bPVP\b` | PvP 分支 |
| DAMAGE-LOOP | D4 | `combat/vitals.ts` | `elementResist\|resistMul\|resistOf` | 玩家侧元素抗性 |
| DAMAGE-LOOP | D5 | `combat/vitals.ts` | `blindSec\|blindUntil\|blindedSec` | 玩家侧致盲状态 |
| DAMAGE-LOOP | D6 | `sim/world_sim.ts` | `createDowned\|touchRevive\|featherRevive\|flagRevive` | 复活流程接入编排层 |
| DAMAGE-LOOP | D7 | `sim/world_sim.ts` | `savePlayerState\|loadPlayerVitals` | 血量端到端落盘 |
| FLUID-BUDGET | F4 | `world/fluid.ts` | `MAX_ACTIVE_CELLS\|ACTIVE_CAP\|activeCap` | 活跃集合封顶 |
| FLUID-BUDGET | F5 | `world/fluid.ts` | `swim\|wade\|submerg\|drown` | 流体↔实体交互 |
| SIM-orchestration | US2 | `net/room.ts` | `WorldSim\|world_sim` | 网关联动 |
| SIM-orchestration | US7 | `sim/world_sim.ts` | `recordFrame\|replayInput\|ReplayLog` | 回放录制 |
| WS-03-build | U3 | `build/rooms.ts` | `scanRoomsIncremental\|dirtyRoomCells\|roomDirty` | 增量重扫 |
| WS-03-build | U5 | `build/blueprint.ts` | `MAX_RELAY_CONCURRENCY\|relayConcurrency\|clampRelay` | 中继并发上限 |
| WS-03-build | U7 | `build/blueprint.ts` | `stripWire\|clearWire\|omitWire` | 蓝图剥离电路 |
| WS-06-alchemy | U4 | `alchemy/gate.ts` | `CATEGORY_MECHANIC_MATRIX\|isLegalCombo\|comboWhitelist` | 类别×机制矩阵 |
| WS-09-client-render | U1 | `three/stage_assembly.ts` | `threeCompat\|ThreeFacade\|createCompatScene` | three 相容层 |
| WS-09-client-render | U11 | `stage/roof_transparency.ts` | `NEIGHBOR8_DX\|NEIGHBOR8_DY` | 8-邻域屋顶连通 |

全部 17 条实测**休眠**(`node scripts/backlog.ts` 仍报 `══ 无过时条目 ══`,`verify.ts` 的台账门禁仍 `✓`)。

### 2.2 修掉一个真实的静默失效(缺陷,非风格问题)

旧的行定位正则 `^\|\s*\*{0,2}${id}\*{0,2}\s*\|` 接受 `| U5 |` 与 `| **U5** |`,但**匹配不到 `| ~~U5~~ |`**。

而 `EVENT-BUS.md` 的 U1/U3/U5/U8 恰好都写成划掉态。后果:该文档下 3 条探针(EVENT-BUS U5/U8/U1)**永远不可能命中** —— 条目行找不到就 `continue`,探针变成死代码。它本应是「条目被重新打开 + 代码回退」的回归报警器。

修法:抽出 `findLedgerRow(docText, id)`,正则允许 `~~` 包裹;**同号多行时优先取未划掉的那一行**(取错会把仍在开放的条目当成已归档,静默漏报)。

对照实验:

```
U2: 旧正则 Y / findLedgerRow Y
U5: 旧正则 N / findLedgerRow Y   <== 修复
D1: 旧正则 Y / findLedgerRow Y
Z9: 旧正则 N / findLedgerRow N
重复编号择优: PASS 取未划掉行
```

### 2.3 新增探针体检 `auditProbes()` + `--audit`

探针表最容易的腐烂方式不是**误报**(会被 verify 立刻拦下),而是**漏报**:文档措辞被改写、编号被划掉、文件被重命名,探针悄悄失效而门禁永远全绿。

`detectStale()` 只回答「有没有过时」;`auditProbes()` 回答「这把尺子还准不准」,对每条探针给六态之一:
`dormant`(在岗)/ `firing`(命中)/ `row-missing`(找不到行)/ `claim-drift`(措辞已变)/ `archived`(已归档)/ `file-missing`。

实跑 `node scripts/backlog.ts --audit`:

```
══ 探针体检 24 条 ══
  已归档          SIM-orchestration.md US1、US3、US8
  已归档          EVENT-BUS.md U5、U8、U1
  已归档          FLUID-BUDGET.md F1
  在岗            DAMAGE-LOOP.md D1..D7
  在岗            FLUID-BUDGET.md F4、F5
  在岗            SIM-orchestration.md US2、US7
  在岗            WS-03-build.md U3、U5、U7
  在岗            WS-06-alchemy.md U4
  在岗            WS-09-client-render.md U1、U11

  在岗/命中 17 条 / 已归档 7 条
  → 无静默失效探针(已归档不算失效:它们守的条目已关闭,属正常退役)。
```

原 7 条显示 `已归档` **是正确终态**(它们守的条目已关,靠 `~~` 归档);新增 17 条显示 `在岗`。

> 设计要点:`archived` 与 `row-missing`/`claim-drift`/`file-missing` **必须分开计数**。
> 前者是探针**使命完成**,后者是探针**悄悄失效**。我第一版把两者合并报「7 条静默失效」,
> 那是把正常退役误判成故障 —— 已在实现中修正。

> 注:`auditProbes()` 不接入 `verify.ts`。把「7 条 archived」当失败接入会立刻把门禁染红,那是把正常归档误判成故障。它只做诊断出口,供人排查。

---

## 3. 三档结论总表(核查时 55 条未关闭)

### 3.1 计数

| 结论 | 条数 | 含义 |
| :--- | ---: | :--- |
| **已实现(Lead 已关行)** | 3 | 代码已有实现且与文档主张矛盾 —— **已按 §1.1 闭环关行** |
| **仍然开放**(文档属实) | 38 | 逐条给出代码证据 |
| **无法判断**(缺外部条件) | 14 | 每条写明缺的是什么证据 |
| 合计 | 55 | 与核查时 `collectOpenItems()` 的 55 条未关闭一致 |

### 3.2 「已实现」的 3 条(Lead 已关行 ✅)

> **闭环状态:3 条全部由 Lead 独立核验后关行。** 关行采用「`~~` 划掉 + 已解决」,
> 符合 §1.1 的正道:`detectStale` 走 `findLedgerRow`(优先取未划掉行),
> 行一旦划掉即视为已归档,探针随之退役 —— 不需要改动 `verify.ts`。

| 条目 | 关行位置 | 关行后的形态 |
| :--- | :--- | :--- |
| WS-09 U8 | `docs/WS-09-client-render.md` | `**已解决** ~~UI 面板的 320 格全展开是否太重~~` |
| WS-11 U1 | `docs/WS-11-coop-prank-party.md` | `**已解决** ~~叠罗汉伸手高度…~~` |
| WS-11 U10 | `docs/WS-11-coop-prank-party.md` | `**已解决** ~~玩具 243 引雷铁锅头盔自伤…~~` |

#### 1 `WS-09-client-render.md U8` —— 分页退化问题已修复【已实现,Lead 已关行】

- 文档主张:`SLOTS_PER_PAGE = 320`,「全展开意味着一帧 320 个 DOM 节点」,建议改分页(如 80/页)。
- 代码事实:`client/src/ui/inventory.ts:39,45,48`
  - `SLOTS_PER_ROW = 16`、`SLOTS_PER_PAGE_ROWS = 10` ⇒ **`SLOTS_PER_PAGE = 160`**,不是 320。
  - `TOTAL_ITEM_COUNT = 320` ⇒ 现在**必然分 2 页**,分页路径不再退化。
  - 该文件头注释第 12 行明确记录了这次修复:「`SLOTS_PER_PAGE` 曾等于 320,320 件时正好 1 页 ⇒ 分页代码路径从未被执行」。
- 判据:文档描述的数值与风险(1 页、无分页)在代码里已不成立,且代码注释显示是**有意修复**。

#### 2 `WS-11-coop-prank-party.md U1` —— 叠罗汉伸手高度已按裁决改常量【已实现,Lead 已关行】

- 文档主张:第一版 `STACK_REACH_Z = 0.25` 让 3 人梯只差 0.05 格,浮点抖动足以误判;裁决为「改常量,不改判定逻辑」。
- 代码事实:`server/src/coop/rush_order.ts:738,750`
  - `STACK_REACH_Z = 0.30`、`Z2_REACH_TARGET = 2.30` —— 与裁决数值**逐字一致**。
  - `canReachHeight` 判定式确实一行未动:`stackTopZ(depth) + STACK_REACH_Z >= targetZ - EPS`。
- 测试事实:`tests/WS-11.test.ts:523-528` 断言 `gap3 = 0.30`、`gap4 = 0.55`,`inRange(0.1, 1.0)` 裕度成立。
- 判据:裁决内容已完整落地并有断言锁定。

#### 3 `WS-11-coop-prank-party.md U10` —— 头盔自伤已按裁决实现【已实现,Lead 已关行】

- 文档主张:保留自伤 + 加「不自锁」保护(HP 硬顶 15%、永不触发幽灵泡泡、不受和平盾影响)。
- 代码事实:`server/src/prank/toys.ts`
  - `SELF_DAMAGE_HP_FLOOR_RATIO = 0.15`(L440)、`HELMET_SELF_PARALYZE_SEC = 1.5`(L443)、`HELMET_SELF_DAMAGE = 45`(L445);
  - `selfDamageHpFloor(maxHp)`(L448)= `Math.max(1, Math.ceil(0.15 × maxHp))`;
  - `applySelfDamage(hp, maxHp, rawDamage)`(L493)**签名无 `shieldOn` 参数** —— 结构上保证自伤无法被和平盾拦截;
  - 返回值含 `ghostBubble: false`(L508)、`shielded: false`(L509) —— 字面对应「永不触发幽灵泡泡」「不受和平盾影响」。
- 判据:裁决的 3 条设计意图在代码里各有一个可验证落点。

### 3.3 「无法判断」的 14 条(缺什么证据)

| 文档 | 条目 | 缺的证据 | 说明 |
| :--- | :--- | :--- | :--- |
| WS-09-client-render | U2 | 美术管线决策 | 顶点色 vs 图集是待选方案,不是可实现项 |
| WS-09-client-render | U5 | 手感/美术调参 | 衰减曲线的「柔和度」无客观判据 |
| WS-09-client-render | U6 | 低端机实测帧率 | 需真实浏览器与目标机 |
| WS-09-client-render | U7 | 逐 Boss 人工核对 | 需 WS-05 逐条确认预警形状 |
| WS-09-client-render | U9 | 人工判读有损损坏 | 「字节截断成 `?`」无法自动还原,需人工按上下文重写 |
| WS-09-client-render | U10 | 命名习惯取舍 | 双导出是风格问题 |
| WS-09-client-render | U12 | 未来是否传对象副本 | 当前零拷贝,假设未发生 |
| WS-03-build | U1 | 产品决策(大蓝图) | 改动会波及冻结层 |
| WS-03-build | U2 | 产品决策(评分是否可见) | 需 WS-09 定 UI 呈现 |
| WS-03-build | U8 | 出海决策 | 中文硬编码是否要外置 |
| WS-03-build | U9 | 代码归属决策 | `stampBoxRoom` 是否算生产代码 |
| WS-03-build | U10 | 未来地砖种类数 | 30/64 余量充足,超限才需扩位宽 |
| WS-06-alchemy | U5 | 冻结契约变更决策 | 非 16×16 需改契约 |
| WS-06-alchemy | U9 | 线上观感样本 | 「名字机械」需真人评估 |

**PERF-BOUNDS.md 的 4 条**(U1 Gemini 凭证、U2 压测环境、U3 手册出处、U4 浏览器帧率)文档自身已写明属「无法判断」,与本报告口径一致,计入上表说明但不重复展开。

### 3.4 「仍然开放」的 38 条(逐条证据)

#### DAMAGE-LOOP.md(7 条)

| 条目 | 结论 | 证据 |
| :--- | :--- | :--- |
| D1 击退/硬直未实现 | 开放 | `physics/world.ts:621` 有 `applyImpulse`,但**全仓无生产调用点**(仅 `tests/WS-02.test.ts`);`world_sim.ts` 无击退写回 |
| D2 不检查视线 | 开放 | 全仓无 `lineOfSight`/`losClear`;`world_sim.ts:724` 的 `blocked` 只查刷怪占位,不用于攻击结算 |
| D3 PvP 未做 | 开放 | `combat/damage.ts` 无任何 `pvp` 语义;`FROZEN` 只作为 `BodyState` 存在,无玩家冻结流程 |
| D4 无元素抗性 | 开放 | `DamageKind` 只用于**生物受击**(`behaviors.ts:146`);玩家侧 `vitals.ts` 无抗性系数 |
| D5 致盲只有 mem.blindSec | 开放 | `blindSec` 仅 `behaviors.ts:514` 一处(mob 侧);玩家侧无对应状态 |
| D6 倒下后无复活流程 | 开放 | `combat/revive.ts` 完整实现,但**只被 `tests/WS-10.test.ts` 引用**;`world_sim.ts` 只有 `revivePlayer` 手动入口 |
| D8 blockedKeys 编排层不传 | 开放 | `world_sim.ts:688-693` 调用 `resolveStrikes(strikes, players, undefined, ...)` —— 第三参硬编码 `undefined`,与文档描述**完全一致** |

> D1 值得单独说明:这是本次最容易误判的条目。`applyImpulse` 存在会让人以为「击退已实现」,但它的调用点全在测试里。**定义存在 ≠ 功能接入**,这正是 `SIM-orchestration US8`(CarrySystem 同款陷阱)留下的教训。

#### EVENT-BUS.md(4 条)

| 条目 | 结论 | 证据 |
| :--- | :--- | :--- |
| U2 跨帧队列 | 开放 | `bus.ts:265` `this.queue.length = 0` 后立即 drain,当帧投递;无延迟调度层 |
| U4 lastMobTicks 进 SimFrameReport | 开放 | `SimFrameReport` 字段清单里无 `lastMobTicks`;只在 `WorldSim` 字段上可读 |
| U6 事件名命名空间 | 开放 | 实测 `behaviors.ts` 有 **30 处 emit / 29 种**事件,与文档数字一致;全是 snake_case,无正式规范模块 |
| U7 unknownMobs 硬失败 | 开放 | `world_sim.ts` 的 `readonly unknownMobs: string[]` 只 `push`,不抛错 |

#### FLUID-BUDGET.md(6 条,除 F1 已闭)

| 条目 | 结论 | 证据 |
| :--- | :--- | :--- |
| F2 processed 名不副实 | 开放 | `fluid.ts:107` `processed` 仍在,`report.processed = limit`(L360)恒为满额;诚实字段 `visited`/`active` 已加(L108/L116) |
| F3 小世界净开销 | 开放 | `fluid.ts` 无按面积分支的逻辑 |
| F4 活跃集合无上限 | 开放 | `activeArr` 无封顶;`pushActive` 只做去重,不设容量 |
| F5 流体与实体交互全缺 | 开放 | 全仓无 `swim`/`wade`/`submerg`;`extinguishFire` 在 `combat/cooking.ts:389` 操作 `FireCell[]`,**与 `FluidField` 无关** |
| F6 相变只判四邻 | 开放 | `fluid.ts` 相变块只检查 `i±1` 与 `i±width` 四个方向,无斜角 |
| F7 去重双保险 | 开放 | `deltaBuf` 复用 + `delta[i]=0` 使重复访问读到 0 而跳过,与文档描述一致 |

#### SIM-orchestration.md(2 条)

| 条目 | 结论 | 证据 |
| :--- | :--- | :--- |
| US2 网关联动未接 | 开放 | `net/room.ts` 全文无 `WorldSim`/`world_sim`;`RoomRuntime` 与 `WorldSim` 确实互不依赖 |
| US7 无回放/录制 | 开放 | 全仓无 `recordFrame`/`replayInput`/`ReplayLog`;`Record<...>` 类型不计 |

#### WS-03-build.md(7 条)

| 条目 | 结论 | 证据 |
| :--- | :--- | :--- |
| U3 scanRooms 全量 | 开放 | `rooms.ts:87` 注释明说「全场去重」,无脏格集合 |
| U4 danglingEnds 阈值 ≤1 | 开放 | `wiring_view.ts:230` 实现为 `if (deg <= 1) n += 1`,与文档写的「≤1」一致 |
| U5 中继并发只统计 | 开放 | `blueprint.ts:595` `relayWorkload` 只做 `m.set(owner, count+1)`,无上限、无拒绝 |
| U6 canTraverse 权威性 | 开放 | `autotile.ts:358` 返回 `TraverseVerdict`,仍由调用方裁决 |
| U7 蓝图含暗线 | 开放 | `captureBlueprint` 保留 wire 位,无剥离函数 |
| U4/U6/U7 均属「两处判定可能不一致」的结构性议题,代码现状与文档描述吻合 | | |

#### WS-06-alchemy.md(6 条,除 U1/U3/U8 已闭)

| 条目 | 结论 | 证据 |
| :--- | :--- | :--- |
| U2 util 消费口径 | 开放 | `attributes.ts:58-59` `UTIL_MUL = 0.4`、`UTIL_CAP_PERCENT = 50`,只保证区间,无消费映射 |
| U4 类别×机制无交叉约束 | 开放 | `alchemy/gate.ts` 无白名单矩阵;`degrade.ts:83+` 的模板表是**降级映射**,不是合法性约束 |
| U6 S_logic 钳制 | 开放 | `attributes.ts:40-41` `S_LOGIC_MIN = 0.6` / `S_LOGIC_MAX = 1.3`,与文档「[0.60,1.30]」一致 |
| U7 缓存一致性 | 开放 | `cache.ts:98` `get()` 直接返回 `AlchemyRecipeRow`,数值需重算 —— 与文档「数值热更、定性冻结」一致 |
| U10 多语言 | 开放 | `CARRIER_WORD`/`MECHANIC_WORD` 等仍中文硬编码 |

---

## 4. 交叉核对:常量级证据

除了正则探针,我另做了一次**常量交叉核对** —— 从每条未决行里抽取 `常量名`,回代码找其真实值,比对是否与文档描述一致。这是比「符号存在性」更强的证据。

| 常量 | 代码真值 | 位置 | 对应条目 | 判定 |
| :--- | :--- | :--- | :--- | :--- |
| `STACK_REACH_Z` | `0.30` | `coop/rush_order.ts:738` | WS-11 U1 | 已实现(裁决值) |
| `Z2_REACH_TARGET` | `2.30` | `coop/rush_order.ts:750` | WS-11 U1 | 已实现(裁决值) |
| `SLOTS_PER_PAGE` | `160`(=16×10) | `ui/inventory.ts:48` | WS-09 U8 | **已实现**(文档写 320) |
| `SLOTS_PER_PAGE_ROWS` | `10` | `ui/inventory.ts:45` | WS-09 U8 | 同上 |
| `S_LOGIC_MIN/MAX` | `0.6` / `1.3` | `alchemy/attributes.ts:40-41` | WS-06 U6 | 开放(吻合) |
| `UTIL_CAP_PERCENT` | `50` | `alchemy/attributes.ts:59` | WS-06 U2 | 开放(吻合) |
| `SELF_DAMAGE_HP_FLOOR_RATIO` | `0.15` | `prank/toys.ts:440` | WS-11 U10 | 已实现(裁决值) |
| `HELMET_SELF_PARALYZE_SEC` | `1.5` | `prank/toys.ts:443` | WS-11 U10 | 已实现(裁决值) |
| `BLUEPRINT_CELLS` | `16×16` | `build/blueprint.ts:23` | WS-03 U1 | 开放(吻合) |
| `DEFAULT_MAX_AREA` | `100` | `build/rooms.ts:19` | WS-03 U3 | 开放(吻合) |
| `NEIGHBOR4_DX/DY` | 4 邻 | `stage/roof_transparency.ts:27-28` | WS-09 U11 | 开放(吻合) |
| `PHASE_MIN_AMOUNT` | `50` | `world/fluid.ts:32` | FLUID F6 | 开放(吻合) |
| `ICON_SIZE` | `16` | `alchemy/pixel_icon.ts:23`、`stage/entity_sprites.ts:22` | WS-06 U5 | 开放(吻合) |

---

## 5. 台账自身的口径问题

以下是我在核查中发现的**台账工具**问题。按写域纪律,我只报告并已修其中与探针直接相关的两处(§2.2、§2.3),其余不擅自改动:

1. **`~~U1~~` 类行完全不进台账**(已修 `findLedgerRow` —— 注:该修复只影响**探针的行定位**,`collectOpenItems()` 的条目解析正则未改动)。`EVENT-BUS.md` 有 4 行写成 `| ~~U5~~ |`,旧 `^\|\s*\*{0,2}U5\*{0,2}\s*\|` 匹配不到 ⇒ 该文档下 3 条探针**永远不可能命中**,且这些行既不进「已关闭」计数也不参与过时检测。修复后探针不再失效。

2. **`C1`/`C2` 这类编号不进台账**。`WS-11-coop-prank-party.md:828-829` 有 `| C1 |`、`| C2 |` 两条「需协调方」条目,不在 `(U|F|D|US)` 前缀内。是否该纳入取决于台账口径是否覆盖协调项 —— 建议 Lead 明确。

3. ~~**`detectStale` 与 `verify` 的语义耦合过紧**,建议加 `acknowledged` 只警告不 fail。~~ **【已撤回 —— Lead 裁决纠错】**

   我初版把「探针命中 → `verify.ts` 变红」判为耦合缺陷,建议加放行语义。**这个判断错了**,已在 §1.1 完整记录修正。裁定要点:

   - 探针命中**不是错误,是信号** —— 正确响应是**关掉对应台账行**,不是让门禁闭嘴;
   - 加 `acknowledged` 会把机制退化成「**漂移白名单**」:漂移一旦登记就永久合法,而它本该被修掉;
   - 这违反本项目核心判据 —— **一个不会失败的断言是装饰**;
   - `detectStale` 走 `findLedgerRow`(优先取未划掉行),关行的正道就是加 `~~` 或写「已解决」,闭环完整,**不需要改 `verify.ts`**。

   实测印证:Lead 关掉 §3.2 的 3 行后,门禁自动复绿。

---

## 6. 复跑方式

```bash
node scripts/backlog.ts          # 台账全量 + 过时检测
node scripts/backlog.ts --audit  # 追加探针体检(24 条六态)
node scripts/backlog.ts --blocking
node scripts/backlog.ts --doc DAMAGE-LOOP.md
node scripts/verify.ts           # 全量门禁
```

本次交付后实测(Lead 关行之后复跑):

- `node scripts/backlog.ts` → `══ 无过时条目 ══`(`--audit` 仍为 `在岗/命中 17 条 / 已归档 7 条`)
- `node scripts/verify.ts` → `✓ 未决台账无过时条目`

**关键闭环验证:** §3.2 的 3 条关行采用「`~~` 划掉 + 已解决」。行划掉后 `detectStale` 的 `~~` 分支使其跳过,探针随之退役,**无需改动 `verify.ts`**,门禁保持全绿。这印证了 §1.1 的定性:探针命中是**信号**,响应是**关行**,闭环成立。

README 的两处计数漂移由 Lead 统一收口(不在我的写域)。本任务对 `collectOpenItems()` 的口径**零改动** —— 只新增了 `findLedgerRow` / `auditProbes` 两个纯读取函数。

---

## 7. 本报告自身的待办

> 标题**刻意不写「未决」** —— `collectOpenItems()` 会把任何以 `## …未决` 开头的章节
> 当作台账来源扫描。本文件位于 `docs/`,若标题含该词,报告自身就会被当成一份台账,
> 将来若出现 `| U1 |` 形式的行会静默污染全局计数。

| # | 事项 | 状态 / 说明 |
| :--- | :--- | :--- |
| A1 | 3 条「已实现」是否关行 | ✅ **已闭环**:Lead 核验后关行(WS-09 U8、WS-11 U1/U10),`未关闭` 55→52 |
| A2 | README 台账数字 | 由 Lead 统一收口(不在我写域) |
| A3 | `auditProbes()` 是否接入门禁 | 暂不接入。诊断出口即可;若要接入,必须把 7 条 `archived` 视为**正常终态**(它们守的条目已关) |
| A4 | `C1`/`C2` 编号是否纳入台账 | 口径问题,需 Lead 明确 |
| A5 | 探针语义的长期维护 | 新增 17 条都是「等实现落地就命中」。若某功能实现后**无人关行**,探针会持续报红 —— 这正是**期望行为**(信号,不是故障)。关行即可退役,无需动探针 |