# 扩展与升级手册

> 面向「后续要加内容、加子系统、改机制」的人。
> 每个流程都写清了**改哪几个文件、跑什么命令、哪一步会静默出错**。
> 配套工具:`node scripts/content-lock.ts`

---

## 0. 先读这一节:底座现状

交付时 11 个工作流、677 条断言全绿。但「全绿」只说明**已写的东西是对的**,
不说明**加新东西会顺利**。下面这张表是逐项实测的结果,它决定了扩展时哪些地方要小心。

| 扩展点 | 机制 | 状态 |
| :--- | :--- | :--- |
| 魔能电路件 | `registerComponentKind()`(40 个已注册) | ✅ 注册表,加一件是加一行 |
| 野生动物 AI | `MOB_AI_FACTORY` 映射 + `DefaultMobAi` 兜底 | ✅ 工厂,未登记自动回落 |
| 存档 DDL 变更 | `schema_migrations` 表 + checksum,**fail-closed** | ✅ 有迁移机制 |
| 网络协议变更 | `PROTOCOL_VERSION` + 收发两侧校验 | ✅ 有版本门 |
| 免疫清单 | `assertImmunityManifestComplete()` | ✅ 有完整性断言 |
| **物品表** | 裸 `const` 数组 | ⚠️ 无版本、无指纹(已补 `content/registry.ts`) |
| **背包容量** | `INVENTORY_SLOTS = INVENTORY_ROWS × SLOTS_PER_ROW` | ✅ 已解耦(WS-FND-02) |
| **ID 分配** | 无登记 | ⚠️ 余量靠人工数(已补容量账本) |

三处 ⚠️ 是本次底座建设补上的。补的方式不是改机制,而是**给已有内容表加一层可验证外壳**。

「背包容量」一条已在 WS-FND-02 修掉,做法见 §2.2 末尾的「背包容量为什么不再等于物品数」。

---

## 1. 内容容量账本

### 1.1 位域是硬约束

32 位单元的划分(引自冻结层 `tile.ts`,**只读**):

| 字段 | 位宽 | 取值上限 | 说明 |
| :--- | ---: | ---: | :--- |
| `ELEV` | 2 | 3 | 海拔 |
| `BASE` | 4 | 15 | 基底材质 |
| `FLOOR` | 6 | 63 | 地砖槽位 |
| `WIRE` | 4 | 15 | 四色电线各 1 位 |
| `OBJ` | 12 | 4095 | **物品/构件 ID** |
| `META` | 4 | 15 | 元数据 |

合计 32 位。**`OBJ` 只有 12 位**,这是新增内容时最先撞到的墙。

### 1.2 查容量

```bash
node scripts/content-lock.ts --capacity
```

输出:

```
空间                    已用    值域   顶端余量    可用     占用
OBJ 层物品 ID              320   4095    3350   3775    18.2%
FLOOR 地砖槽位               30     63      33     33    47.6%
```

**三个数字含义不同,不要混用**(它们曾经都叫「余量」,是同名不同义的经典陷阱):

| 列 | 含义 | 用于什么决策 |
| :--- | :--- | :--- |
| **值域** | 位宽推出的总宽(OBJ = 2¹²−1 = 4095) | 硬上限,越过就被 `packTile` 静默截断 |
| **顶端余量** | 值域上界 − **最高已用值**(4095 − 745 = 3350) | 判断「追加型增长」还能走多远 |
| **可用** | 真实空闲号数(4095 − 320 = **3775**) | **「我还能加多少件」看这个** |

「可用」大于「顶端余量」是因为 ID 空间**稀疏**:101~745 之间有大段未分配空档。
若只看「顶端余量 3350」会以为只能再加 3350 件,实际可用号有 3775 个。

> **注意与验证器的 320 区分**:`scripts/verify.ts` 里的 `320` 是**内容基线断言**
> (核对手册 §3 的十张分表),属 verify 职责;这里的 `320` 是**已用号数**。
> 两者数值巧合相同,但语义无关 —— 加了物品后前者要改基准、后者自动变 321。

### 1.3 ID 空间的实际形状

**关键事实**:10 张分表的 `range` 全部**紧包**(`range` 宽度 = 物品数),
所以「表内没有空位」。扩展空间在**表与表之间的空档**:

| 空档 | 号数 | 适合放什么 |
| :--- | ---: | :--- |
| 1~100 | 100 | 保留(当前未用) |
| 131~150 | 20 | 接 §3.1 自然资源的衍生品 |
| 171~200 | 30 | 接 §3.2 半成品 |
| **219~220** | **2** | 太窄,无实用价值(CLI 默认不列出) |
| 256~300 | 45 | 接 §3.4 玩具装备 |
| 331~350 | 20 | 接 §3.5 地砖 |
| 386~400 | 15 | 接 §3.6 建筑构件 |
| 441~500 | 60 | 接 §3.7 电路件 |
| 538~600 | 63 | 接 §3.8 家具 |
| 631~700 | 70 | 接 §3.9 料理时装 |
| 746~4095 | 3350 | **大块预留区** |

可用号合计 **3775**(占 OBJ 层 92%)。

> `freeIdSegments()` 默认只列出长度 ≥ 8 的连续段(短空隙列出来只会淹没可用号段)。
> 要**精确总数**请用 `freeIdCount()`,不要对 `freeIdSegments()` 的输出求和 ——
> 那会漏算被过滤掉的短段(219~220),得到 3773 而真实是 3775。
> **看起来精确的数字有偏差,比明显错误更危险:读的人不会去验算。**

> **为什么不能随便挑空号**:验证器按 `range` 核对每张分表的数量。
> 往 131~150 放东西后,那张分表的 `range` 就得扩到 `[101, 150]`、`count` 改成 50,
> 而 `range` 宽度就不再等于物品数 —— `idSegments()` 的 `slackInside` 会变成 20,
> 这恰恰是**正确**的告警:该区间现在有 20 个空位未用。

---

## 2. 新增一件物品(最常做的事)

### 2.1 步骤

1. **挑 ID**:查 `--capacity` 的空档表,选一个属于正确章节区间的号。
2. **加条目**:在 `shared/constants/items.ts` 对应的分表数组(`NATURAL` / `REFINED` / …)
   末尾追加 `{ id, name, category, tags, value, note }`。
   - `category` 必须是已有的 12 类之一,否则 `auditContent()` 报错
   - `value` 按手册 §5.3 的标定规则插值
3. **扩分表区间**(若用了空档):把该分表的 `range[1]` 扩到新 ID,`count += 1`。
4. **跑审计**:
   ```bash
   node scripts/content-lock.ts --audit
   ```
5. **刷新基线并登记**:
   ```bash
   node scripts/content-lock.ts --update
   ```
   然后按输出提示在 `docs/CHANGE_REQUESTS.md` 记一笔。

### 2.2 会静默出错的三处

| 陷阱 | 症状 | 怎么发现 |
| :--- | :--- | :--- |
| **ID 超出 4095** | 打包时被静默截断,物品变成别的 | `auditContent()` 报「超出 OBJ 层 12 位上限」 |
| **槽位平移** | 背包格位整体错位 | `--update` 会**高亮**列出;基线比对也报 |
| **引用不闭合** | 生物掉落/Boss 召唤物指向不存在的 ID | `auditContent()` 报「引用了不存在的物品」 |

第三条是新增内容时**最容易漏**的:新加一件武器后忘了把它配进某个 Boss 的战利品表,
游戏里不会崩,只是永远打不到。

#### 背包容量为什么不再等于物品数(WS-FND-02)

原来 `client/src/ui/inventory.ts` 写的是:

```ts
export const INVENTORY_SLOTS = TOTAL_ITEM_COUNT;   // ✗ 容量 = 内容数量
export const SLOTS_PER_PAGE  = SLOTS_PER_ROW * 20; // ✗ 恰好等于 320
```

后果是**加一件物品会同时踩三个坑**:

1. `INVENTORY_SLOTS = 330` 时 `330 / 16 = 20.625` —— **半行**,网格最后一行只有 10 格;
2. 行数不再是整数,依赖行数的布局取整全部错位;
3. 320 件时 `320 / 320 = 1` 页,分页代码**从未被执行**;加到 330 件时页数突然变 2,
   潜伏的分页 bug 才第一次暴露 —— 症状出现在与「加物品」看起来毫无关系的 UI 上。

现在的写法是**容量由布局反推**:

```ts
export const SLOTS_PER_ROW       = 16;
export const INVENTORY_SPARE_ROWS = 1;   // 固定余量行
export const SLOTS_PER_PAGE_ROWS  = 10;  // 每页 10 行,刻意小于总容量
export const SLOTS_PER_PAGE       = SLOTS_PER_ROW * SLOTS_PER_PAGE_ROWS; // 160

export function computeSlotLayout(count, slotsPerRow, spareRows, pageRows): SlotLayout;

export const INVENTORY_ROWS       = 21;   // ceil(320/16) + 1
export const INVENTORY_SLOTS      = 336;  // 21 × 16,恒为 16 的整数倍
export const INVENTORY_PAGE_COUNT = 3;    // ceil(336/160)
```

要点:

- 容量是 `computeSlotLayout` 的**输出**,内容数量只是**输入**。加物品只影响行数下界,
  不可能再产生半行(`slots % slotsPerRow === 0` 由构造保证)。
- `INVENTORY_SPARE_ROWS` 让 ±16 件以内的扩容**完全不改行数**,既有槽位保持稳定。
- `SLOTS_PER_PAGE` 明显小于容量(160 < 336),分页路径在**日常测试里就会走到**,
  不会潜伏到某次扩容才首次执行。
- `itemAt(slot)` 的上界取 `min(容量, 内容数)`:容量 336 > 内容 320 是设计目标,
  多出的 16 格是合法空格,返回 `null`;`isEmptySlot(slot)` 供 UI 画空槽。

加物品时**不需要动** `inventory.ts` 里的任何常量 —— 行数会随 `TOTAL_ITEM_COUNT` 自动跟上;
只有当内容涨到需要多一行时,`INVENTORY_ROWS` / `INVENTORY_SLOTS` 才会自己变大,
而那时既有物品的槽位仍然不变(`slotOf` 是 `ITEM_LIST` 下标)。

验收跑 `node tests/WS-09.test.ts`,其中「背包扩容不变量」用例直接喂
`count = 0/1/15/16/17/320/321/328/330/336/337/352/353/1024` 给纯函数,
逐项断言无半行、容量装得下、行数单调不减。

---

## 3. 新增现代码

### 3.1 新电路件(最容易,照抄)

`server/src/wiring/components.ts` 已是注册表模式:

```ts
// 1. 在 COMPONENT_SPECS 里加一行(S() 是构造助手)
S(441, 'SENSOR_NEW_THING', '新传感器名', ComponentGroup.SENSOR, [WireColor.RED]),
// 2. 用 registerComponentKind 注册行为
registerComponentKind('SENSOR_NEW_THING', (ctx) => { /* 读写 ctx */ });
```

`SPEC_BY_ID` / `SPEC_BY_KIND` / `STATE_DEFAULTS` 由表推导,**不用手改**。
唯一要注意:若新件有状态,要在 `STATE_DEFAULTS` 里给它初始状态。

### 3.2 新生物 AI

`server/src/mobs/behaviors.ts`:

```ts
// 1. 写一个继承 BaseMobAi 的类
export class NewMobAi extends BaseMobAi { /* tick 等 */ }
// 2. 注册进 MOB_AI_FACTORY
mob_new_thing: (d) => new NewMobAi(d),
```

未登记的生物 ID 会自动回落到 `DefaultMobAi`,**不会抛异常**。
这是有意的容错设计,但也意味着**拼错 ID 不会报错**,只是生物变傻 ——
所以新增后要确认 `createMobAi(mobDef)` 返回的是你写的类,而不是 `DefaultMobAi`。

#### 新 AI 的攻击要打到玩家,必须用两种通道之一

伤害结算在 `server/src/combat/vitals.ts`(见 [DAMAGE-LOOP.md](DAMAGE-LOOP.md))。
你的 AI 想伤到玩家,**只有两条路**:

| 通道 | 怎么写 | 何时用 |
| :--- | :--- | :--- |
| **预警几何**(推荐) | `tick` 里 `return [circleWarn(x, y, r, warnSec)]` 等 | 有范围、有前摇的攻击(挥砍、火环、吐息) |
| **事件** | `world.emit('xxx')` + 在 `EVENT_STRIKE_RULES` 加规则 | 状态触发的瞬时效果(伏击、撞击) |

**`return []` 表示「我这帧不攻击」** —— 这是合法的。但要知道:
`ClockKnightAi` / `BeetleAi` / `ChocoGolemAi` / `SamuraiAi` 的 `tick` 恒
`return []`,它们的威胁是**被动机制**(正面 90% 减伤,逼玩家绕背),
伤害从 `onDamage` 走玩家攻击路径。这类 AI **不需要**预警。

**漏接的表现**:生物围着你打,但血条不动,**且不报错**。实测踩过 ——
蝎子伏击与穿山甲滚撞走事件通道,只接预警通道时它们的伤害全丢。

#### 移动:两种写法的区别

| 写法 | 后果 |
| :--- | :--- |
| 直接写 `rt.x` / `rt.y` | 有效;宿主会自动做**扫掠防穿墙**夹取 |
| 写 `rt.fsm.x` | **无效**,见 `EVENT-BUS.md` §3(`fsm` 不是移动权威) |

步长超过 1 格时不必自己防穿墙 —— 宿主 `tickMobs` 会在你写完之后
夹取位移(实测覆盖 25 个 AI,`totals.sweepClamped` 可观测)。
但**撞墙后的行为**(自晕/绕行)**要你自己决定**,宿主只负责不让你穿过去。

### 3.3 新 Boss

1. 在 `shared/constants/bosses.ts` 的 `BOSS_LIST` 加条目(含 `phases` 阶段表)
2. 战利品 ID 必须都存在(审计会查)
3. 阶段切换的断点机制 `breakMechanic` 要给出

### 3.4 新子系统(最重的一类)

参照 `server/src/sim/world_sim.ts` 的编排模式:

1. **模块自己可独立测试** —— 不要依赖别的子系统就能构造
2. **决定节奏归属**:每帧(20Hz)还是慢帧(2Hz)?
   - 20Hz:需要实时响应的(物理、输入)
   - 2Hz:可容忍延迟的(流体、电路、刷怪决策)
3. **接进 `WorldSim`**:加字段 + 在 `tick()` 里按节奏调用
4. **在 `verify.ts` 的 `checkIntegration()` 里加一条「在动」断言** ——
   证明它不是空壳

> 第 4 步是本次底座建设补上的最关键的一条经验:
> 交付时 677 条断言全绿,但**世界从未跑起来过** —— 因为各套件都只在自己建的对象上断言,
> 没有任何测试同时驱动多个子系统。`checkIntegration()` 现在把「能一起跑」变成门禁。

---

## 4. 内容基线锁

### 4.1 为什么需要

物品 ID 是**持久化身份**,被三处引用:

| 引用方 | 字段 |
| :--- | :--- |
| 存档 | `users.held_item_id`、`users.weapon_id`、`users.inventory_json` |
| 网络 | 蓝图里的 12 位 `obj` |
| 炼金 | `ai_alchemy_recipes.recipe_hash`(由物品 ID 排序拼接) |

而 `items.ts` 是普通数组常量,改动它**不会有任何提示**:

- 删掉物品 351 → 旧存档的 351 悬空,读到 `undefined`,不报错
- 把 351 换成别的物品 → 旧存档的 351 静默变成「另一个东西」
- 改数值 → 老存档的平衡性被追溯改变

对照:`repo.ts` 的 `schema_migrations` 已覆盖 **DDL** 变更(带 checksum、fail-closed),
但**内容表**变更原本无人看管。

### 4.2 怎么用

```bash
node scripts/content-lock.ts             # 比对(CI/验证用,有差异退出 1)
node scripts/content-lock.ts --update    # 重新生成基线(有意扩展后)
node scripts/content-lock.ts --capacity  # 容量报表
node scripts/content-lock.ts --audit     # 引用闭合审计
```

基线文件:`server/src/content/content.baseline.json`
(随仓库提交,这样 code review 时能直接看到内容差异)

### 4.3 指纹算法

- `canonicalize()`:把嵌套值排成**唯一**字符串 —— 对象键按字典序,数组保序
- `fnv1a32()`:FNV-1a 32 位,与 WS-07 迁移 checksum 同族
- 分区指纹(items / mobs / bosses / modes)+ 合并指纹

**指纹只反映内容数据,不反映代码。** 改了算法逻辑而内容不变时指纹**应当**不变 ——
这正是它有用的原因:它把「数据变更」这一个变量隔离出来。

### 4.4 基线缺失不算通过

`diffBaseline(null)` 返回 `present: false` / `inSync: false`。
验证器据此报错,而不是静默放行。

> 这一条是从项目既有的失败中学来的:`verify.ts` 早先的 `--docs` 只遍历**已存在**的文档,
> 于是缺失的 WS-03 文档静默通过,门禁假绿。**「没找到问题」和「无法判断」必须区分开。**

---

## 5. 存档迁移

DDL 变更已由 `schema_migrations` 覆盖。**内容变更**需要额外考虑:

| 变更类型 | 是否需要迁移 | 做法 |
| :--- | :--- | :--- |
| 新增物品 | 否 | 旧存档不引用新 ID |
| 删除物品 | **是** | 需把悬空 ID 映射到替代品或标记为无效 |
| 重命名物品 | 否(数据不变) | 仅显示变化 |
| 改数值 | 视情况 | 若影响平衡,需决定是否回溯 |
| **改 ID** | **是** | 等价于「删 + 增」 |

扩展登记结构(`baseline.ts` 的 `ContentExtension`)要求**显式声明** `needsMigration`,
并给出 `migrationNote`。`auditExtensions()` 会检查:序号连续、ID 不冲突、声明了迁移就要给提示。

**为什么做成可执行断言而不是文档约定**:文档约定会被跳过,断言不会。

---

## 6. 验证门禁

```bash
node scripts/verify.ts --all            # 全量
node scripts/verify.ts --frozen         # 冻结层 17 项不变量
node scripts/verify.ts --docs           # 11 份 WS 文档结构 + 与测试集合对账
node scripts/verify.ts --integration    # 跨 WS 集成(世界真的能跑)
node scripts/verify.ts --only WS-09     # 单工作流
node scripts/content-lock.ts            # 内容基线
node scripts/content-lock.ts --audit    # 内容一致性
```

### 门禁的设计原则(踩坑换来的)

**断言必须能失败,否则它不是门禁,只是装饰。**

本项目出现过**五**次「不可能失败的断言 / 检查」:

| 位置 | 错误形态 | 后果 |
| :--- | :--- | :--- |
| `verify.ts` 文档检查 | 只遍历**已存在**的文档 | 缺 WS-03 文档仍全绿 |
| `checkIntegration` 双频 | 期望值用**被测常量**算,两边同变 | 注入 `FAST_PER_SLOW *= 2` 测不出 |
| `checkIntegration` AOI | 断言看「已**注册**数」而非「已**唤醒**数」 | 删掉 `aoi.update()` 测不出 |
| `auditContent` 类别检查 | 合法集合**从被检查数据自建** | `has(category)` 恒真,永远不报错 |
| `contentCapacity` 余量统计 | 用**有损过滤**的输出求和 | 报 3773 而真实 3775 |

前三次的教训是「判据应取外部事实(手册规定的 20Hz/2Hz),不能取被测代码自己的常量」。

第四次更隐蔽,值得单独记住:**违反检查的数据恰恰会自己定义出合法集合。**
`KNOWN_CATEGORIES` 若从 `ITEM_LIST` 自建,那 `has(it.category)` 对每一项恒真 ——
逻辑上不可能报错。修法是改用**冻结层的权威清单**(`ItemCategory`)。

第五次是「有损函数的输出不能当精确统计用」:
`freeIdSegments(minLength = 8)` 会过滤掉短段,对它求和就漏算了 219~220。
**看起来精确的数字有偏差,比明显错误更危险:读的人不会去验算。**

### 同名不同义也是缺陷

`contentCapacity()` 的 `remaining` 字段一度在 OBJ 行表示
「值域上界 − 最高已用值」(3350),在 FLOOR 行表示「capacity − used」(33)。
**读表的人会按同一含义理解,而其中一行必然是错的。**
已拆成 `headroom`(顶端余量)与 `freeCount`(真实可用号)两个明确字段。

同类问题还有 `INVENTORY_SLOTS` 曾等于 `TOTAL_ITEM_COUNT`
(容量与内容数量同名同值)—— 见 §2.2。

**判据:一个字段若在不同行需要不同解释,那它就不是一个字段。**

---

## 7. 需要调试时的工具

```bash
node server/src/sim/demo.ts 10          # 世界冒烟演示(可传秒数)
node server/src/sim/demo.ts 10 | head   # 逐慢帧观测表
node scripts/typecheck.ts               # 类型检查(未装 tsc 时优雅跳过)
```

模拟编排层是**确定性**的:同种子两次运行终态逐字节一致(门禁已断言)。
所以任何 bug 都可以通过「固定种子 + 相同输入序列」稳定复现。

---

## 8. 尚未打好的底座(诚实清单)

| # | 缺口 | 影响 | 建议 |
| :--- | :--- | :--- | :--- |
| F1 | 生物行为未接入编排层 | `behaviors.ts` 的 25 个 `tick` 未跑 | 需 `MobRuntime` 宿主适配 |
| F2 | 网关联动未接 | `RoomRuntime` 与 `WorldSim` 互不依赖 | 两者可组合,当前刻意解耦 |
| F3 | 战斗/炼金未进循环 | 它们是**事件驱动**,非每帧推进 | 需先定事件总线形态 |
| F4 | 大世界流体预算偏低 | 1024 格/慢帧;512×512 世界铺满要 128 秒 | 按玩家距离加权 |
| F5 | `WorldGrid` 与 `FluidField` 双份地形状态 | 靠 `setCell` 显式同步,漏写则水不扩散 | 让 `FluidField` 读 `WorldGrid`(要改 WS-01) |
| F6 | 无回放/录制 | 确定性已成立但未利用 | 录制输入序列即可回放 |
| F7 | `client/src/three/stage_assembly.ts` 零引用 | 需要 `three` 才能跑 | 加兼容门面或改为描述对象 |

这些在 `docs/SIM-orchestration.md` §10 有更细的分析。

---

## 9. 扩容影响面审计(WS-FND-04)

> 本节由 `task-11` 产出。目标不是「把扩容做一遍」,而是**先用假内容集证明扩容不会弄坏东西**,
> 再把结论固化成可失败的断言。演练入口:`node scripts/extension-drill.ts`(34 条不变量);
> 回归套件:`node tests/WS-FND-04.test.ts`(39 条);判据有效性验证:
> `node scripts/extension-drill.ts --verify-faults`(见 §9.7)。

### 9.1 为什么需要这一节

「加一件物品会不会弄坏别的东西」在本项目里**已经真实翻车过一次**:
`INVENTORY_SLOTS` 曾等于 `TOTAL_ITEM_COUNT`,于是 320 → 330 时背包变成
`330 / 16 = 20.625` 行(半行),而 `SLOTS_PER_PAGE` 恰好 = 320 使**分页路径从未被执行过**。
潜伏的分页缺陷不会在 320 时暴露,只在扩容那一刻首次触发。

WS-FND-02 修掉了背包那一处。但「同一个形态还有多少处」当时没人系统查过。本节就是那次普查。

### 9.2 耦合点清单(file:line 证据)

| # | 耦合点 | 位置 | 性质 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| C1 | 背包槽位布局 / 分页 | `client/src/ui/inventory.ts:81-141` | 已解耦 | ✅ `computeSlotLayout()` 纯函数,320/330/400/4095 均无半行且装得下 |
| C1b | 分页非退化 | `client/src/ui/inventory.ts:48` | 已解耦 | ✅ `SLOTS_PER_PAGE=160 < 336`,分页路径会被走到 |
| C2 | 蓝图 `obj` 12 位值域 | `shared/types/tile.ts:26-27` | **硬约束** | ⚠️ 值域 1~4095;越界静默截断 |
| C3 | 容量台账 `freeCount`/`headroom` | `server/src/content/registry.ts:118-131` | 已解耦 | ✅ `freeCount` 按值域宽算,非按 `capacity-maxId` |
| C3b | `freeIdCount()` 精确计数 | `server/src/content/registry.ts:388-395` | 已解耦 | ✅ 不受 `minLength` 过滤影响 |
| C4 | 槽位 = 数组下标 | `server/src/content/baseline.ts:78` | **固有风险** | ⚠️ `slots[String(it.id)] = i`;非末尾插入平移全部后续 |
| C5 | 网络字段 `weaponId`/`heldItemId` | `server/src/net/schema.ts:96,98` | **双通道** | ⚠️ U16(65535)与 12 位(4095)是**两个**宽度 |
| C6 | 反作弊物品检查 | `server/src/net/anticheat.ts:371-402` | 已解耦 | ✅ 按总量守恒判定,`capacity` 由调用方传入 |
| C7 | 料理表引用物品 ID | `server/src/combat/cooking.ts:99-197` | 引用闭合 | ✅ 全部指向存在物品;追加不破坏 |
| C8 | 分表结构 `ITEM_TABLES` | `shared/constants/items.ts` | 稳定 | ✅ 追加区(746+)独立于十大分表 |
| C9 | 扩展登记校验 | `server/src/content/baseline.ts:260-285` | 已具备 | ✅ 序号/冲突/迁移提示三项均能报错 |
| — | 验证器内容基线 | `scripts/verify.ts:125,141` | 硬编码 320 | ⚠️ **有意硬编码**;扩容时必须同步 |

### 9.3 两个容量天花板(最容易被想当然的地方)

「12 位能装 4095 件」听起来像「还能再加 3775 件」。实际是:

| 指标 | 数值 | 算式 |
| :--- | :--- | :--- |
| 纯末尾追加上限 | **3670 件** | `320 + (4095 − 745)` = 320 + 3350 |
| 含内部空档全填的绝对上限 | **4095 件** | 值域宽 |
| 两者之差 = 内部空档数 | **425 个** | `freeIdCount() − 3350` |

差的那 425 件**必须去动区间之间的内部空档**。而那些空档一旦插入,
就会命中 C4 的槽位平移风险。所以「想扩到 3670 以上」这件事本身应当触发一次存档兼容性评审,
而不是当作普通的加内容。

### 9.4 越界 ID 的两种失效形态(都不报错)

实测 `packTile` / `unpackTile` 往返:

| 输入 obj | 往返结果 | 后果 |
| :--- | :--- | :--- |
| 4095 | 4095 | 正常 |
| **4096** | **0** | 物品**凭空消失**(0 = `OBJ_EMPTY`) |
| **5000** | **904** | 变成**另一个合法物品**,玩家看到「另一个东西」 |

两种都**不抛异常、不写日志**。第二种尤其危险:904 是个真实存在的 ID,
画面完全正常,只有内容对比才能发现。这就是「扩容前必须先查容量」的原因,
也是 `auditContent()` 第 2 条检查存在的理由。

### 9.5 演练方法:内存假内容集

```
node scripts/extension-drill.ts          # 全量,逐条打印不变量结论(34 条)
node scripts/extension-drill.ts --quiet  # 只打印失败项
node scripts/extension-drill.ts --json   # 机器可读,供 CI 消费
```

假内容集从真实基线出发,按 **320 → 330 → 400 → 4095** 构造,**只存在于内存**,
不改 `shared/**`、不写基线文件。取号顺序:先吃 746+ 大块预留区,不够再吃内部空档。

**为什么不用「直接改常量」的方式测**:改常量只能测一种规模,而耦合点失效往往
「跨过某个阈值才暴露」(正好整除、正好装满一页)。内存副本可以穷举边界值。

`tests/WS-FND-04.test.ts` 直接 import 演练模块复用假内容集与判据 ——
所以演练脚本的主流程**只在被直接执行时运行**(`isDirectRun()` 守卫)。
初版没有这个守卫,导致 import 时打印整段演练日志、并改写 `process.exitCode`,
症状是「测试输出 39/39 通过但退出码 1」。这类副作用的判据:
**一个可被 import 的模块,其顶层不应有不可重入的副作用。**

### 9.6 判据必须来自外部事实(本节最重要的一条)

本套件**不取被测代码自己的常量作判据**。原因见 §6 那次事故:
`auditContent` 的类别检查最初从 `ITEM_LIST` 自建合法集合,于是 `has()` 恒真 ——
**违反检查的数据恰恰会自己定义出合法集合**,检查逻辑上不可能失败。

具体做法:

| 判据 | 取什么 | **不**取什么 | 为什么 |
| :--- | :--- | :--- | :--- |
| 12 位容量 | `shared/types/tile.ts` 的 `OBJ_MASK >>> OBJ_SHIFT` | `registry.ts` 的 `FIELD_MAX.OBJ` | 用被测方自证是同义反复 |
| u16 容量 | `(1 << (FIELD_TYPE_BYTES.u16 * 8)) - 1` | 任何实现里的常量 | 算术事实 |
| 布局对齐 | 「整除」这一数学事实 + 参数合法性 | `INVENTORY_SLOTS % SLOTS_PER_ROW` | 后者是被告自己声明的对齐 |
| 空档数 425 | `4095 − 3670` 与 `freeIdCount()` 两条独立路径互证 | 单一来源 | 交叉校验 |

**一个真实踩到的坑**:`OBJ_MASK` 是**已左移**的位段掩码(`0x0fff0000`),不是值掩码。
初版直接拿它当容量,推出 `268369920` —— 比真值大 6 万倍。
错误方向极其恶劣:容量大到**任何 ID 都不越界**,于是所有容量断言恒真、全部失去区分力,
而报告会显示「全绿」。修法是 `>>> OBJ_SHIFT`,并补一条
「掩码推导必须与 `packTile`/`unpackTile` 的实际往返行为一致」的交叉断言。

这条经验值得推广:**判据的推导链若只走一条路,那条路错了就没人能发现。**

### 9.7 证明「断言能失败」:两种方法,名字不能混用

「测试通过」本身不是证据 —— **永真的断言也会显示通过**。但「让断言失败」有两种做法,
证明力完全不同,必须分开命名(此处曾被对抗性复核纠正过):

| 方法 | 做什么 | 能证明 | **不能**证明 |
| :--- | :--- | :--- | :--- |
| **判据区分力自检**(构造式) | 在测试内**重新实现一个坏版本**,断言坏版本漏判 | 判据对坏输入敏感 | 真实源码坏掉时套件会不会红 |
| **故障注入**(真实源码) | **改动真实源码文件**,跑套件,断言预期用例出现在 ✗ 列表 | 真实源码坏 → 套件红 | — |

初版把前者误称为「故障注入」,那等于「用我自己的假设验证我自己的假设」。
两者都要保留,但**名字必须对上**。构造式自检在 `tests/WS-FND-04.test.ts` §10(`S1`–`S4`),
真实注入由下面的显式 CLI 模式承担。

#### 真实注入:为什么必须是显式模式

初版把真实注入写进测试、由套件自动改文件再还原。**这在 8 agent 并行时是危险的** ——
实测抓到了事故形态:

- 探查时 `scripts/extension-drill.ts` 停在**注入态**(hash `7B0A0309`),
  而非原值 `A525C33B` —— 说明有窗口没走完还原;
- 并发运行时打印「还原被跳过:文件已被他人改写」。

根因是**设计错误**:注入目标 `client/src/ui/inventory.ts` 与
`server/src/content/baseline.ts` **不在本任务写入范围内**,而测试是自动执行的 ——
队友跑一次套件就会在我改文件的瞬间读到损坏源码。

这与 `extension-drill.ts` 自身初版踩的坑同形:
**不可重入的副作用不该藏在别人的流程里。**(那次是 import 副作用,这次是测试副作用。)

#### 实测记录(显式模式)

```bash
node scripts/extension-drill.ts --verify-faults
```

该模式自带:锚点校验(源码漂移则跳过)、并发写入保护(被他人改过则不覆盖)、
`finally` 还原、SHA-256 前后对照。**实测结果**:

| # | 注入方式 | 预期变红 | 实际变红 | 还原 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `OBJ_CAPACITY_FROM_FROZEN` 漏 `>>> OBJ_SHIFT` | A1, C3-1 | **15 条**:A1 A2 B2 B3 B4 C1-3 C2-1 C3-1 C3-2 C3-3 C4-1 C5-2 C7-2 C8-1 S2 | ✅ 字节一致 |
| 2 | `baseline.ts` 去掉 `migrationNote` 校验 | C9-1 | **2 条**:C9-1 S3 | ✅ 字节一致 |
| 3 | `computeSlotLayout` 退回「槽位 = 件数」 | C1-4 | **3 条**:C1-1 C1-4 C6-4 | ✅ 字节一致 |

三次 SHA-256 前后对照全部一致,脚本以「三次注入全部:源码坏 → 套件红 → 已还原(字节一致)」退出 0。

第 1 项正是本项目真实踩过的坑(`OBJ_MASK` 当容量 → `268369920`)。
它变红 15 条说明:**判据源头一旦错,整片容量断言同时失去意义** ——
连 S2 这条「自检自己的自检」也会一起塌,两层证明不会互相掩盖。

第 1 项的 15 条比复核者报告的 12 条多 3 条(B4/C7-2/C8-1),因注入发生在完整基线态、覆盖面更全;
第 2、3 项与复核者结论一致。

判据:**注入必须打在真实源码上**。构造式自检只能检验判据灵敏度,
不能用来宣称「已证明套件会红」—— 那正是这次被纠正的落差。

### 9.8 扩容操作清单

按顺序执行,任何一步红都停下:

```bash
# 1. 先证明当前是绿的(否则分不清是谁弄坏的)
node scripts/verify.ts

# 2. 查可用空间,确认目标 ID 段
node scripts/content-lock.ts --capacity

# 3. 加内容(只改 shared/constants/items.ts 的数据,不改结构)
node scripts/content-lock.ts --audit

# 4. 确认是否触发槽位平移(最危险的一步)
node scripts/content-lock.ts

# 5. 有意扩展 → 刷新基线,并到 docs/CHANGE_REQUESTS.md 登记
node scripts/content-lock.ts --update

# 6. 跑扩容演练 + 回归
node scripts/extension-drill.ts
node tests/WS-FND-04.test.ts
node scripts/verify.ts

# 7.(可选)验证判据本身仍有效:临时改坏真实源码,看套件会不会红,再自动还原
#    ⚠️ 单独运行,期间不要让其它进程跑 verify.ts(它会改真实源码,只是马上还原)
node scripts/extension-drill.ts --verify-faults
```

第 4 步若报「槽位平移」,**不要**直接 `--update`。先判断:
这次插入是否在末尾?若不是,已持久化的旧存档背包会整体错位且**不会报错**。

### 未决

> 编号用 `U` 前缀(与全仓其它文档的未决台账一致),这样 `scripts/backlog.ts`
> 会把它们计入台账,不至于成为「写了但没人追踪」的悬空条目。
>
> **这里的标题为什么没有编号** —— 实测发现 `backlog.ts` 的章节标题正则是
> `/^##+\s*\d*\.?\s*未决/`,其中 `\d*\.?` 只吃**一段**数字加一个点,
> 所以 `9.9` 这种两段式编号**匹配不上**(`## 10. 未决` 这类单段形态才行)。
> 只把条目前缀 `E`→`U` 而不动标题,抽出结果是 **0 条**;
> 标题去掉编号后才抽出 5 条。故此处不编号。

| # | 未决项 | 现状 | 建议 |
| :--- | :--- | :--- | :--- |
| U1 | `scripts/verify.ts:125,141` 硬编码 320 | 有意为之(内容基线锁) | 扩容时必须同步改,建议改为读基线文件 |
| U2 | 槽位仍定义为数组下标(`baseline.ts:78`) | 固有风险,已能检测不能消除 | 长期改为按 ID 取槽位,需存档迁移 |
| U3 | 12 位 vs U16 双 ID 宽度 | 两通道并存,12 位更紧 | 新增物品不受影响;但若将来扩 `obj` 位宽,须同步核对网络字段 |
| U4 | `INVENTORY_SLOTS=336` 仅余 16 个空位 | 扩到 337 件即需加行 | 加行是自动的(`computeSlotLayout`),但要重跑 C1 全套 |
| U5 | `AI_CRAFTED` 类别当前无静态物品 | `auditContent()` 以 note 提示,不拦阻 | 运行时生成内容用该类别属预期,无需处理 |

**U1–U5 均不构成阻塞**:它们要么是「有意为之、扩容时同步」的约定,要么是已有检测手段的
固有风险,要么是预期内的空类别。台账统计里它们应全部显示为非阻塞、未关闭。