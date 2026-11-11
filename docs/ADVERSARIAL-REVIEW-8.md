# 对抗性复核(第 8 批):修复 S11 门禁对**转发文件**套件的盲区

> 任务 `task-19` 的 F 部分。前七批见
> [ADVERSARIAL-REVIEW.md](ADVERSARIAL-REVIEW.md) ~ [-7](ADVERSARIAL-REVIEW-7.md)。
>
> 复核者:`terrain-physicist`。写域:`scripts/verify.ts` + `docs/ADVERSARIAL-REVIEW*.md`。

---

## 一、缺陷确证:WS-06 对门禁**完全不可见**

Lead 的诊断是「键空间不匹配」。我复核后确认这是**真缺陷**,但根因是**两个独立缺陷叠加**。

### 1.1 缺陷 A:**import 花括号里的注释被当成名字的一部分**

`tests/WS-06.test.ts:41` 的导入块里有注释:

```ts
import {
  /* 门禁 */
  checkGate, affinityBreakdown, /* ... */
  /* 像素 */
  ICON_SIZE, ICON_BYTES, SILHOUETTE_ART, MIN_INK_PIXELS,
} from '../server/src/alchemy/index.ts';
```

门禁原实现对**原文**做 `split(',')`,于是得到这样的段:

```
"/* 像素 */\n  ICON_SIZE"
```

`trim()` 后**不是合法标识符**,却被原实现无条件 `nameToMod.set(local, mod)` 收下。

实测 `nameToMod` 里 **9 个垃圾键**:

```
"/* 门禁 */\n  checkGate"                       → alchemy/index.ts
"/* 算法 */\n  powerMeanBreakdown"              → alchemy/index.ts
"/* 像素 */\n  ICON_SIZE"                       → alchemy/index.ts
"/* 协议 */\n  ALCHEMY_JSON_SCHEMA"             → alchemy/index.ts
"/* U4:类别 × 机制交叉矩阵 */\n  CATEGORY..."    → alchemy/index.ts
"type PromptMaterial"                            → alchemy/index.ts
"/* 降级 */\n  degradeGenerate"                  → alchemy/index.ts
"/* 缓存 */\n  MemoryRecipeStore"                → alchemy/index.ts
"/* 编排 */\n  createAlchemyService"             → alchemy/index.ts
```

**结果:`clean.has('ICON_SIZE') === false`** —— 真正的 `ICON_SIZE` **从未被登记**。

### 1.2 缺陷 B:**导入来源是转发文件,而常量键按定义模块建**

`server/src/alchemy/index.ts` **零个 `export const`**,却转发 155 个符号
(来自 `gate` / `attributes` / `pixel_icon` / `prompt` / `degrade` / `cache` 六个文件)。
WS-06 的 **74 个导入全部指向它**。

而 `collectNumericExports` 按**定义模块**建键:

```
numExports.has('server/src/alchemy/index.ts::ICON_SIZE')  = false
numExports.has('server/src/alchemy/pixel_icon.ts::ICON_SIZE') = true   ← 定义在这里
```

**两个缺陷都在同一处代码,都以「WS-06 恒不可见」表现,但互相独立** ——
只修 A 仍会因 B 查不到定义;只修 B 仍会因 A 拿不到名字。

### 1.3 实证确证

修前注入 `eq(1, S_LOGIC_MAX)` 到 WS-06:

```
i 同义反复候选:命中 32 条(白名单 33 条)
门禁抓到 WS-06::S_LOGIC_MAX: ✗ **否 —— 漏洞确证**
```

---

## 二、修复

在 `scripts/verify.ts` 增加两个辅助函数,替换 `checkTautology` 里原先内联的解析:

### 2.1 `parseNamedImports(src, resolveDef)` — 治缺陷 A

- 先用 **`stripCommentsOnly`** 剥注释(保留字符串,因路径在字符串里)再切分
- 名字段加 `/^[A-Za-z_]\w*$/` 校验,**非法名直接丢弃,不再建垃圾键**
- 顺带处理 `type X` 前缀

### 2.2 `buildReexportMap()` — 治缺陷 B

- 扫描全仓 `export { ... } from './x.ts'`,建立 `<转发文件>::<导出名> → <定义模块>`
- 逐轮展开(上限 8 轮防环),支持多跳
- 解析不到时**回落到来源模块本身** —— 保持旧行为,不制造新键

**为什么用「沿链解析」而不是「按名字全表查找」**(Lead 建议的回落方案):
实测有 **6 组跨模块重名常量**(`ICON_SIZE` 在 `pixel_icon.ts` / `entity_sprites.ts` 各一份)。
按名字全表查找会撞名、产生歧义;沿链解析**唯一命中** alchemy 链里的那个。
故采用前者,更精确。

### 2.3 无回归验证

| | 修复前 | 修复后 |
| :--- | ---: | ---: |
| 命中数 | 32 | **33** |
| 新增命中 | — | **1** (`WS-06::ICON_SIZE`) |
| **丢失命中** | — | **0** ✓ |

**纯增益,零回归。**

> 我的分析脚本另报了 1 条「仍被丢弃」`WS-09::DYE_PALETTE_SIZE`。查实为**我的脚本假阳性**:
> 它定义形如 `export const DYE_PALETTE_SIZE = DYE_PALETTE.length;` —— 是**派生表达式而非数字字面量**,
> 被 `Number.isFinite(Number(expr))` 过滤是**设计如此**(与 U3 同类:派生常量另有字面量锚定)。
> **不是漏报。**

---

## 三、验收

### 3.1 故障注入(Lead 指定)✓

修后注入 `eq(1, UTIL_CAP_PERCENT)` 到 WS-06(经 `index.ts` 转发):

```
i 同义反复候选:命中 34 条(白名单 33 条),未登记 2 条
· WS-06  ICON_SIZE
· WS-06  UTIL_CAP_PERCENT          ← 修复生效
--strict-taut 退出码 1 ✓
```

> 第一次探针我用 `S_LOGIC_MAX`,**没抓到**。查实原因:**alchemy-core 修复时已把它移出 import 列表**
> —— 探针本身无效,不是门禁问题。换用仍在导入的 `UTIL_CAP_PERCENT` 后立刻命中。
> **「探针没抓到」和「门禁漏报」是两回事,必须先确认探针的前提成立。**

### 3.2 已知答案交叉验证(Lead 指定)✓

alchemy-core 已修的 4 处,当前均**不在**命中集:

| 常量 | 门禁是否报 | 现状 |
| :--- | :--- | :--- |
| `DEW_RELEASE_QUALITY_PENALTY` | ✓ 未报 | `:277` 仅存注释说明「引用会恒真」,断言已改字面量 |
| `S_LOGIC_MAX` | ✓ 未报 | 已移出 import,`:618` 留注释 |
| `TEXTURE_PIXEL_RATIO` | ✓ 未报 | 不在 WS-06 |
| `S_LOGIC_MIN` | ✓ 未报 | 已移出 import |

**「修好的不该再报」成立。**

### 3.3 ⭐ `WS-06::ICON_SIZE` 的定性 —— 本批最有价值的发现

它是**混合性质**候选,我用注入法把两种性质分离出来了。

**注入 `ICON_SIZE` 16→8,WS-06 `61/61 → 49/61`(12 红)。关键在**哪几条**红**:

| 断言行 | 内容 | 数据来源 | 注入后 |
| :--- | :--- | :--- | :--- |
| `:111/112` | `eq(art.length, ICON_SIZE)` | `SILHOUETTE_ART` **字面量美术** | **变红** ⇒ 有牙齿 |
| `:552/553` | `eq(icon.minItems, ICON_SIZE)` | `prompt.ts:144 minItems: ICON_SIZE` | **仍绿** ⇒ **真同义反复** |

**两条 552/553 在常量改变后毫无反应** —— 因为 `prompt.ts:144` 的 `minItems` **直接取自 `ICON_SIZE`**,
两边同步移动。这是教科书式的同义反复。

**所以 `WS-06::ICON_SIZE` 应登记进白名单,而非判为「有牙齿」而忽略。**

**同时暴露一个门禁粒度局限**:白名单键是 `(套件::常量)`,而**同一常量在同一套件内可以两种性质并存**。
门禁只能报一条,无法表达「部分同义反复」。**这是固有局限,不是漏报** —— 诚实记为已知边界(下 §四)。

### 3.4 保持 `ICON_SIZE` 的区分:门禁漏报 ≠ 断言无效

Lead 特别提醒的这条,我的实验同时印证了两面:
- **断言有牙齿**:注入实测 12 红,**不是假绿**
- **但确有 2 条真同义反复**:552/553 在注入了仍然绿

**两者并存,都要说。** 若只说「有牙齿」就漏掉真缺陷;若只说「同义反复」就冤枉了 111/112。

### 3.5 最终状态 ✓

```
✓ 断言汇总:1141 条通过(18 个套件)
✓ 生产可达性:可达 24 / 不可达 50 (共 74,入口 2 个,白名单 50 条)
✓ 同义反复候选:命中 33 条(白名单 33 条)
退出码 = 0        ← 连跑 3 次稳定
```

**未改动任何测试文件**(Lead 要求:改测试文件前先报)。WS-06 的 552/553 修复留给 alchemy-core。

---

## 四、已知边界(诚实记录)

| 边界 | 说明 | 定性 |
| :--- | :--- | :--- |
| **粒度**:`(套件::常量)` | 同一常量可两种性质并存(本批 `ICON_SIZE` 即实例),只能报一条 | 固有局限,非缺陷 |
| 只识别 `eq/near` 第二实参 | 第二实参是「期望值」位置,同义反复只可能在那里;第一实参 153 项实测 153/153 健康 | 正确语义选择(REVIEW-6) |
| `ok(...)` 不覆盖 | 无「期望值」语义位置 | 有意为之(REVIEW-6 §2.4) |
| 派生常量不收录 | `= A.length` / `= A*B` 不算数字导出 | 设计如此(U3 同类,另有锚定) |
| 动态 `import()` 不跟踪 | 全仓无此形态 | 与 R6 同 |

---

## 五、参数

| 参数 | 值 |
| :--- | ---: |
| 缺陷数 | **2**(注释解析 + 转发链),独立叠加 |
| 垃圾键 | 9 个 |
| WS-06 导入指向转发文件 | 74 / 74 = **100%** |
| 修复后新增命中 | +1,**丢失 0** |
| 故障注入 | 2 次(1 次探针无效已查清) |
| 已知答案验证 | 4/4 ✓ |
| 最终 | **exit=0**,连跑 3 次稳定 |

---

## 6. 建议

| 编号 | 对象 | 建议 |
| :--- | :--- | :--- |
| **S24** | `tests/WS-06.test.ts:552/553` | 改为字面量 `16` + 保留 `eq(ICON_SIZE, 16)` 锚定(参照 alchemy-core 的修法)。**需先报 Lead**(会改测试文件→README 数字可能飘) |
| S25 | 门禁粒度 | 若要表达「部分同义反复」,需把键细化到 `(套件::常量::断言行)` —— **不建议现在做**(白名单会膨胀 3 倍且易失真) |
| S26 | `parseNamedImports` | 建议其它解析 import 的地方(如 R6)也复用 —— R6 走的是 `resolveImport` 路径,需单独确认是否有同类注释问题 |
| S27 | 回归样例 | 把 `alchemy/index.ts` 转发链做成回归样例,防止有人「简化」掉链解析 |

---

## 7. 未决

| 编号 | 条目 | 缺什么 | 影响 |
| :--- | :--- | :--- | :--- |
| U1 | `WS-06::ICON_SIZE` 552/553 | 待 alchemy-core 改字面量 | 中:2 条恒真断言 |
| **U5** | **WS-01 未复核** | 已可补做 | 最后一个未做注入的活跃套件 |
| U9 | 两门禁缺交叉标注 | 仅人工排序 | 低 |
| U11 | R6 是否有同类「注释在 import 块」问题 | 待查(S26) | 待评估 |
