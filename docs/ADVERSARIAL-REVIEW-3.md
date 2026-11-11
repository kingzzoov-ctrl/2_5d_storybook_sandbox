# 对抗性复核(第 3 批):WS-02 / WS-03 / WS-05

> 任务 `task-19` 的 U4 第三批。前两批见 [ADVERSARIAL-REVIEW.md](ADVERSARIAL-REVIEW.md)、
> [ADVERSARIAL-REVIEW-2.md](ADVERSARIAL-REVIEW-2.md)。
>
> 复核者:`terrain-physicist`。**只读**被复核文件;每次注入 before/after SHA-256 比对,
> 残留即以退出码 3 中止。本文件是唯一新增写入。

---

## 一、范围与并行编辑规避

Lead 指定第三批做 **WS-02 / WS-03 / WS-05**,避开正在被编辑的 WS-01。

开工前查时间戳(当前 17:00):

| 套件 | 最后修改 | 判定 |
| :--- | :--- | :--- |
| `WS-01.test.ts` | 16:58(**3 分钟前**) | **跳过**(Lead 已指示) |
| `WS-02.test.ts` | 16:55(5 分钟前) | 观察后开做,期间未再变动 |
| `WS-03.test.ts` | 00:18(约 17 小时前) | 稳定 |
| `WS-05.test.ts` | 23:58(约 17 小时前) | 稳定 |

三个套件共 **163 条断言**:

| 套件 | 断言数 | 行数 |
| :--- | ---: | ---: |
| WS-02 物理与搬运 | 43 | 858 |
| WS-03 建造与蓝图 | 80 | 958 |
| WS-05 Boss 战 | 40 | 805 |

**三者均不 import `world_sim`**(不走生产编排路径)—— 与第 2 批同一形态,不再重复裁决。

---

## 二、真实假绿清单(3 处,含最小复现)

| 编号 | 套件 | 缺陷类型 | 最小复现 | 严重度 |
| :--- | :--- | :--- | :--- | :--- |
| **G3-1** | WS-03 | **可达分支零覆盖** | `rooms.ts:21` `DEFAULT_MIN_AREA = -9999` → **80/80 全绿** | **高** |
| **G3-2** | WS-05 | 判据取自被测常量(同义反复) | `phases.ts:70` `BREAK_CRIT_BONUS = 12345.0` → **40/40 全绿** | **高** |
| **G3-3** | WS-05 | 判据取自被测常量(同义反复) | `phases.ts:75` `TIME_SHIELD_HEAL_RATIO = 0.99` → **40/40 全绿** | 高 |

### 2.1 G3-1:`AREA_TOO_SMALL` 分支可达,但完全没有断言

**最小复现**:

```
1) 改 server/src/build/rooms.ts:21
   export const DEFAULT_MIN_AREA = 4;   →   = -9999;

2) node tests/WS-03.test.ts

3) 观察:[WS-03] 80/80 通过   ← 全绿
```

**证据链**:

```
grep TOO_SMALL tests/WS-03.test.ts        → 0 处
RoomRejectReason 七个成员:
  NONE             ✓ 内部哨兵,非拒绝码
  AREA_OVERFLOW    ✓ 被 WT-03-20 覆盖
  BOUNDARY_LEAK    ✓ 被 WT-03-17/18/19/20b 覆盖
  AREA_TOO_SMALL   ✗ **零覆盖**
  ASPECT_TOO_LONG  ✓ 被 WT-03-22 覆盖
  ANCHOR_IS_BARRIER ✓ 被 WT-03-21 覆盖
  (另 NO_CORE 覆盖于 WT-03-28)
```

WS-03 的 80 条断言把 `rooms.ts` 的**其余每一个拒绝理由都测了,唯独漏掉 `AREA_TOO_SMALL`**。

#### 该分支**确实可达**(我最初的判断错了,已更正)

我起初推测「面积 < 4 的围合房间在几何上不可能」,于是实际穷举验证 —— **结论推翻了我的推测**:

```
3×3 封闭盒(外圈墙、内部仅 1 格):
  area=1  reject=AREA_TOO_SMALL   ← 可达!

完整穷举(外墙 2..9,共 64 组合):
  3×3=1  AREA_TOO_SMALL     3×4=2  AREA_TOO_SMALL
  3×5=3  AREA_TOO_SMALL     5×3=3  AREA_TOO_SMALL
  4×3=2  AREA_TOO_SMALL     3×6=4  NONE(首个小屋)
```

**所以这不是「实现含不可达分支」,而是一个正常可达路径零覆盖。**

> 这条更正很重要:若我按最初的推测报「建议删除死分支」,
> owner 会删掉一个**正常工作的**拒绝码,把「小屋被明确拒绝」的行为变成静默通过。
> **误报的方向比漏报更危险** —— 它会诱导出错误的修复。
> (本会话第 3 次靠实证拦住自己的先验判断;前两次是 `rowAligned` 与 ws-08 接线。)

#### 为什么会被漏掉

WS-03 的所有房间用例都从 `houseWith()` 构造,而它**默认 7×7、最小也只到 3×23 走廊**;
`stampBoxRoom` 的调用全部 ≥ 3 格宽 —— 没有一条用例落在「3×3 ~ 3×5」这个区间。
断言覆盖面看起来「很全」(80 条、六大拒绝码查了五个),缺口恰好在最小尺寸端。

**修法**:补一条最小尺寸用例,例如

```ts
test('WT-03-20c 小屋(内部 1 格)→ AREA_TOO_SMALL', () => {
  const g = new TileGrid(24, 24);
  stampBoxRoom(g, { x: 2, y: 2, w: 3, h: 3, wallId: WALL, floorId: FLOOR, doorAtCol: -1, extraDoorAtCols: [] });
  const r = floodRoom(g, 3, 3, DEFAULT_SCAN_OPTIONS);
  eq(r.reject, RoomRejectReason.AREA_TOO_SMALL, '内部 1 格应被面积下限拒绝');
  eq(r.area, 1, '上报面积钉死 1');
});
```

补上后,把 `DEFAULT_MIN_AREA` 改成 `-9999` 会让它变红 —— 与现有的 `AREA_OVERFLOW` 用例对称。

### 2.2 G3-2 / G3-3:`eq(x, 被测常量)` 同义反复

**最小复现(G3-2)**:

```
1) 改 server/src/bosses/phases.ts:70
   export const BREAK_CRIT_BONUS = 1.00;   →   = 12345.0;

2) node tests/WS-05.test.ts

3) 观察:[WS-05] 40/40 通过   ← 全绿(暴击加成被改成 12345 倍!)
```

**根因**:`tests/WS-05.test.ts` 三处判据右侧都是被测常量自身:

```ts
:429  eq(r.critBonus, BREAK_CRIT_BONUS, `${b.name} 全队暴击加成`);
:431  eq(s.critBonus, BREAK_CRIT_BONUS, '暴击加成生效');
:437  eq(s.critBonus, BREAK_CRIT_BONUS, '眩晕期间保持暴击加成');
```

实现侧 `phases.ts:318/390/394` 也是 `state.critBonus = BREAK_CRIT_BONUS`。
**两边同源 ⇒ 常量改成任何值都相等 ⇒ 断言恒真。**

G3-3 完全同构:

```
测试 :394  const expectHeal = Math.round(s.maxHp * TIME_SHIELD_HEAL_RATIO);
实现 :351  const heal = Math.round(state.maxHp * TIME_SHIELD_HEAL_RATIO);
```

同一个公式在两边各写一遍,读同一个常量 —— 测的是「两边公式一致」,不是「回血比例是 20%」。

**与第 2 批 G-1 的同一缺陷类**(WS-10 `eq(sep.radius, REFLECT_RADIUS)`)。
本轮再次出现,说明这不是孤例,而是**该项目面对「手册数值」时的系统性写法问题**:
作者倾向于用常量比对来表达「应该等于 xx」,但忘了右侧必须是**独立来源**。

**修法**:右侧换字面量(手册原文数字),与同文件里健康的字面量断言保持一致 ——
`WS-05:444 eq(s.critBonus, 0, ...)` 就是正确写法,它有效(常量改成 12345 时那条没红,
是因为窗口结束后 `critBonus` 被置 0,与该常量无关)。

### 2.3 三处发现的共同点

| 编号 | 论文式检查能否发现 | 只有注入才能发现? |
| :--- | :--- | :--- |
| G3-1 | 需要跨 6 个枚举成员逐一核对覆盖 | 是(0 处 grep 能找到,但「该不该有」要判断) |
| G3-2 | 需要看 `eq` 右侧来源 | 是(语法上完全正常) |
| G3-3 | 需要比对两侧公式 | 是(更难,两处代码相距 100+ 行) |

> G3-3 是最隐蔽的一类:两侧代码**看起来都正确**,常量名也一致,
> 只有把常量改成荒谬值再跑,才能发现断言其实什么都没钉住。

---

## 三、其余注入结果(证明断言有真实区分力)

### 3.1 WS-02:43 条,注入 10 次(8 次有效)

| # | 注入 | 变红 | 裁决 |
| :--- | :--- | ---: | :--- |
| F1 | `BURN_DPS` 15 → 99 | 1 | ✓ 火炭灼烧 |
| F2 | `BLEED_DPS` 20 → 99 | 1 | ✓ 荆棘流血 |
| F3 | `TRAP_DELAY` 0.4 → 5.0 | 1 | ✓ 落穴延迟 |
| F4 | `LIFT_RANGE` 0.75 → 99 | **3** | ✓ 举起距离(距离/优先级/纯函数三条交叉) |
| F5 | `LIFT_Z_MAX` 0.45 → 9.9 | 1 | ✓ 离地判定 |
| F6 | `PASS_WINDOW` 0.25 → 9 | **0** | ⊘ 见 §3.1.1 |
| F7 | `HEAVY_MASS_THRESHOLD` 10 → 0.1 | **10** | ✓ 最强单点(连带举链/叠罗汉/优先级) |
| F8 | `FLOOR_DEFAULT_MU` 0.75 → 0.2 | **0** | ⊘ 见 §3.1.2 |
| F8b | `FLOOR_UGC_ID` 314 → 999 | 2 | ✓ 替代判据有效 |
| F8c | `FLOOR_DEFAULT_MU` 0.75 → 0.2(复测) | 0 | ⊘ 可复现 |

#### 3.1.1 F6 `PASS_WINDOW`:定义了但从未使用

```
全仓 grep PASS_WINDOW:
  server/src/physics/carry.ts:47: export const PASS_WINDOW = 0.25;
  (仅此一处,无任何消费点)
```

这是一个**死常量**:导出、有注释、但实现与测试都不用它。
「传球窗口」这个行为在 `carry.ts` 里由 `THROW_COOLDOWN` / `registerCatch` 实现,`PASS_WINDOW` 是残留。

**裁决**:不是断言装饰,是**死代码**。建议删除,或说明它与 `THROW_COOLDOWN` 的分工。

#### 3.1.2 F8 `FLOOR_DEFAULT_MU`:测试有意识地换了判据,但新判据没覆盖回落值

WS-02 自己留了注释(第 125-128 行):

```
槽位 40 属于 UGC 地毯区间(31..63),映射到 314。
注意:314 手册 μ=0.75(§3.5 L215)与 DEFAULT_MU 恰好同值,
所以 2026-11 起 μ **不能再**用来区分「映射到 314」和「回落缺省」——
改用 floorIdAt(身份)与 speedMul(314=1.10,缺省=1.00)来区分。
```

**这是一次正确的判据替换**:`μ` 因两个来源同值而失去区分力,作者改用身份 + 移速。
F8b 证明新判据确实有区分力(`FLOOR_UGC_ID` 改坏 → 2 条红)。

**但副作用是**:`FLOOR_DEFAULT_MU` 的**具体值 0.75** 在 WS-02 里再没有任何断言钉住。
F8c 把它改成 0.2 仍 43/43 全绿。

- `WS-01:389` 有 `near(floorMu(999), FLOOR_DEFAULT_MU)` —— 但那是**同源比对**,改常量两边一起变,**也抓不住**。
- `WS-FND-06:233` 是 `ok(FLOOR_DEFAULT_MU >= 0.40 && <= 0.98)` —— **区间断言**,0.2 落在区间外,能抓住。

**裁决**:WS-02 侧**无覆盖**(F8c 实证);WS-FND-06 侧有区间守卫但很宽(0.40~0.98),
把手册值 0.75 改成 0.5 仍会通过。**判为「边界只测一侧」的变体:判据被替换后原值失去锚点。**

建议:在 WS-02 补一条字面量断言 `near(DEFAULT_MU, 0.75, 1e-12)`。

### 3.2 WS-03:80 条,注入 6 次(5 次有效)

| # | 注入 | 变红 | 裁决 |
| :--- | :--- | ---: | :--- |
| G1 | `DEFAULT_MAX_AREA` 100 → 1000 | 1 | ✓ AREA_OVERFLOW |
| G2 | `DEFAULT_MAX_ASPECT` 4.0 → 400 | 1 | ✓ ASPECT_TOO_LONG |
| **G3** | `DEFAULT_MIN_AREA` 4 → 0 | **0** | **✗ 见 G3-1** |
| G3b | `DEFAULT_MIN_AREA` 4 → -9999 | **0** | **✗ 复现** |
| G4 | `BLUEPRINT_SIZE` 16 → 8 | **7** | ✓ 蓝图全套 |
| G5 | `MASK_N` 0b0001 → 0b0010 | **6** | ✓ AutoTile |
| G6 | `SCORE_REQUIRED_BASE` 100 → 1 | **10** | ✓ 评分系统 |

WS-03 整体质量好:G4/G5/G6 都是单点注入命中 6~10 条,说明判据交叉覆盖充分。

### 3.3 WS-05:40 条,注入 11 次(8 次有效)

| # | 注入 | 变红 | 裁决 |
| :--- | :--- | ---: | :--- |
| H1 | 改标识符 `STUN` → `STUN_X` | 崩溃 | ⊘ 无效注入(语法错) |
| H2 | 改标识符 `SHIELD` → `SHIELD_X` | 崩溃 | ⊘ 无效注入 |
| H3 | 改字符串 `SAFE_ZONE` → `SAFE_ZONE_X` | 0 | ⊘ 无效注入(改的是字符串值) |
| H1b | `OBSIDIAN_WALL_STUN_SEC` 6.0 → 99 | 1 | ✓ 巨蟹破防眩晕 |
| H2b | `TIME_SHIELD_SEC` 8.0 → 99 | 1 | ✓ 时间护盾窗口 |
| **H3b** | `TIME_SHIELD_HEAL_RATIO` 0.20 → 0.99 | **0** | **✗ G3-3** |
| **H4** | `BREAK_CRIT_BONUS` 1.00 → **12345** | **0** | **✗ G3-2** |
| H5 | `PULL_MIN_PLAYERS` 2 → 9 | 2 | ✓ 拔河 |
| H6 | `WHALE_CRYSTAL_COUNT` 3 → 7 | 2 | ✓ 云鲸雷晶 |
| H7 | `CHRONOS_CIRCUIT_COUNT` 4 → 3 | **3** | ✓ 四色环(含端到端) |
| H8 | `RAID_PARTICIPATION_RADIUS` 24 → 240 | 0 | ⊘ 见 §3.3.1 |

#### 3.3.1 H8 `RAID_PARTICIPATION_RADIUS`:定义了但实现里零使用

```
raid.ts:37: export const RAID_PARTICIPATION_RADIUS = 24;
全仓引用:仅此一处。
tests/WS-05.test.ts / WS-01 / WS-FND-02:均未 import。
```

注释说「祭坛周围玩家参与判定半径(格):与经验共享半径一致」,
但 `raid.ts` 内部**没有任何代码用它做半径判定** —— 参与判定走的是显式传入的玩家列表。

与 F6 同类:**死常量**。建议删除,或让它真的参与判定。

---

## 四、无法使其失败的断言 —— 诚实归因

| 断言 / 常量 | 我试过的注入 | 为什么没红 | 归因 |
| :--- | :--- | :--- | :--- |
| `PASS_WINDOW` | 0.25 → 9 | 全仓无消费点 | **死代码**,不是断言问题 |
| `RAID_PARTICIPATION_RADIUS` | 24 → 240 | 全仓无消费点 | **死代码** |
| `FLOOR_DEFAULT_MU` | 0.75 → 0.2 | WS-02 无字面量断言;WS-01 是同源比对 | **判据被替换后失去锚点**(§3.1.2) |
| `DEFAULT_MIN_AREA` | 4 → 0 / -9999 | 该分支可达,但无断言覆盖 | **零覆盖**(§2.1) |
| `BREAK_CRIT_BONUS` | 1.00 → 12345 | 两侧同源 | **同义反复**(G3-2) |
| `TIME_SHIELD_HEAL_RATIO` | 0.20 → 0.99 | 两侧同源 | **同义反复**(G3-3) |

**没有一项属于「我没想到注入方式」** —— 本轮 6 个未红项全部定位到根因,
其中 4 项是真缺陷(2 同义反复 + **1 可达分支零覆盖** + 1 失去锚点),2 项是死代码。

---

## 五、还原证据(零残留)

每次注入 `writeFileSync(原文: Buffer)` → 改 → 跑 → `finally` 字节级还原 → SHA-256 比对。

| 文件 | 注入次数 |
| :--- | ---: |
| `server/src/physics/world.ts` | 3 |
| `server/src/physics/carry.ts` | 4 |
| `server/src/world/chunk.ts` | 3 |
| `server/src/build/rooms.ts` | 4 |
| `server/src/build/blueprint.ts` | 1 |
| `server/src/build/autotile.ts` | 1 |
| `server/src/bosses/breaks.ts` | 4 |
| `server/src/bosses/phases.ts` | 4 |
| `server/src/bosses/raid.ts` | 2 |

复核结束时三套件复跑:

```
[WS-02] 43/43 通过
[WS-03] 80/80 通过
[WS-05] 40/40 通过
```

本仓无 git,故用逐次 before/after 哈希代替 diff 证明。

---

## 6. 参数

| 参数 | 值 |
| :--- | ---: |
| 复核套件 | 3 |
| 断言总数 | 163 |
| 注入总次数 | 27 |
| 有效注入 | 21 |
| 无效注入(标识符/字符串误改) | 6 |
| 真实假绿 | 3 |
| 死常量 | 2 |
| 零残留 | 全部一致 |

---

## 7. 建议(交 Lead 转发)

| 编号 | 对象 | 建议 | 写域 |
| :--- | :--- | :--- | :--- |
| S1 | WS-03 `rooms.ts:21` + `tests/WS-03.test.ts` | `AREA_TOO_SMALL` 可达但零覆盖 → 补一条 3×3 最小尺寸用例(§2.1 给了完整代码) | build 侧 owner |
| S2 | WS-05 `:429/431/437` | G3-2:右侧换字面量 `2.00`(手册「+100%」) | WS-05 owner |
| S3 | WS-05 `:394/395` | G3-3:右侧换字面量 `Math.round(maxHp * 0.20)` | WS-05 owner |
| S4 | WS-02 `carry.ts:47` | `PASS_WINDOW` 是死常量 → 删除或接入 | WS-02 owner |
| S5 | WS-05 `raid.ts:37` | `RAID_PARTICIPATION_RADIUS` 是死常量 → 删除或接入 | WS-05 owner |
| S6 | WS-02 | 补 `near(DEFAULT_MU, 0.75, 1e-12)` 字面量断言 | WS-02 owner |
| S7 | **全仓** | **G-1 / G3-2 / G3-3 是同一类缺陷(第 2、3 批各现),建议做一次专项扫描:`eq(a, X)` 且 `X` 是被测模块导出常量 → 逐条定性** | Lead |

> S7 值得单独做:三批累计已发现 3 例「`eq(x, 被测常量)`」同义反复,
> 横跨 WS-05、WS-10 两个套件,不是个别疏漏。

---

## 8. 未决

> 条目号用 `U` 前缀 —— `scripts/backlog.ts:290` 的正则只识别 `U|F|D|US`,
> 用其他字母会静默逃出台账(第 2 批已踩过)。

| 编号 | 条目 | 缺什么 | 影响 |
| :--- | :--- | :--- | :--- |
| U1 | S1–S6 六处修复 | owner 动手 | 3 处真实假绿 + 2 处死常量 + 1 处锚点缺失 |
| U2 | S7 全仓同义反复专项扫描 | 需排期 | 三批已现 3 例,可能还有更多未被注入法发现 |
| U3 | 剩余 9 个套件(WS-01 等)未做独立注入 | 人力 + 等 WS-01 稳定 | 其门禁有效性仍只有自测者背书 |
| U4 | 本轮 6 次无效注入(改标识符/字符串导致语法崩溃或无效) | 更细的符号级注入工具 | 这些断言点尚未被验证(不等于装饰) |