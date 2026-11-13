# task-79 报告:三条可判遗留项

> 执行者 `mob-boss-ai` · 2026-11-14
> 三项**互相独立**,各自给出明确结论。
> ★ 三项都出现了同一模式:**台账/注释的说法与代码实测不符**,且不符的方式各不相同。

---

## 结论速览

| 项 | 台账说法 | 实测结论 | 处置 |
| :--- | :--- | :--- | :--- |
| 1 `TelegraphShape` | 「5/5 下标冲突」 | **不成立** —— 客户端是**字符串**枚举,两边类型不相交,无下标可比 | 修 `wire.ts` 过期注释;**真实缺口改写成「缺映射层」** |
| 2 `TelegraphSpec` 12 vs 10 | 「12 vs 协议 10」 | **口径错了** —— `TelegraphSpec` 不在 `wire.ts`;12 是客户端结构,10 是**整张 Boss 表**;真实比例是 **12 vs 5** | 逐字段表 + 7 个缺失字段各自理由 |
| 3 差集判据 | 「散文与正则不符」 | **成立且比预期严重**:存在**两套同名「差集」**(计算式 5 条 / 字面式 1 条),分类器用字面式 ⇒ 分类取决于**措辞**而非事实 | 列全部命中 + 三条独立证据 + 替换方案 |

---

## 项 1:`TelegraphShape` 冲突 —— **不是冲突,是两套不同词汇**

### 1.1 事实:两边不是同一种东西

```
shared/types/wire.ts:259
  export const TelegraphShape = { NONE: 0, CIRCLE: 1, SECTOR: 2, RECT: 3, RING: 4 }

client/src/ui/boss_hud.ts:26
  export const TelegraphShape = {
    CIRCLE: 'CIRCLE', ANNULUS: 'ANNULUS', CONE: 'CONE', LINE: 'LINE', CROSS: 'CROSS'
  }
```

**成员值是 `number` vs `string` ⇒ 类型不相交。**

所以「5/5 下标冲突」这个说法**在类型层面就无法成立**:
不存在「把服务端数字当客户端数组下标用」这件事的可能 —— 那会直接不被类型检查通过。

### 1.2 注释里的数字版本**从未存在过**

台账与 `wire.ts` 旧注释都说客户端是
`{CIRCLE:0, ANNULUS:1, CONE:2, LINE:3, CROSS:4}`。实测:

```
git log -S "ANNULUS: 1" --oneline --all     ⇒ 0 命中
git log -S "CIRCLE: 0"  --oneline --all     ⇒ 0 命中
git show d10a59f:client/src/ui/boss_hud.ts  ⇒ 首个提交里就是字符串
```

⇒ **那个数字版本从未在这份仓库里存在过。**
这是本仓陷阱 92(「文档的读者没有编译器」)的一个新形态:
**注释描述的不是"过期的实现",而是"从未存在的实现"。**

### 1.3 三个「0 处」:冲突若真存在,必然有痕迹

| 若真有冲突,应出现 | 实测 |
| :--- | :--- |
| 把 wire 数字赋给 client `shape` | **0 处** |
| 客户端读 `boss.telegraphShape` | **0 处** |
| 对 `TELEGRAPH_SHAPES` 做数字下标 | **0 处** |

客户端的预警圈由本地常量驱动(`client/src/three/boot.ts:573` `shape: 'ANNULUS'` 硬编码),
**根本没听协议**。⇒ 无冲突,因为无交集。

### 1.4 ★ 但真正的缺口存在,只是它不是「冲突」

两侧是**两套不同词汇**,不是同一概念的两套编号:

```
仅 wire  : NONE / SECTOR / RECT / RING
仅 client: ANNULUS / CONE / LINE / CROSS
两侧同名: CIRCLE —— 且语义相同(都是实心圆),唯一真同义的一对
```

语义对应关系(**实测推断,非协议所载**):

| wire | client | 语义 |
| :--- | :--- | :--- |
| `CIRCLE`(1) | `CIRCLE` | 实心圆 —— ✓ 拼写与语义都对 |
| `SECTOR`(2) | `CONE` | 扇形 —— 拼写不同 |
| `RECT`(3) | `LINE` | 矩形条 —— 拼写不同 |
| `RING`(4) | `ANNULUS` | 圆环 —— 拼写不同 |
| `NONE`(0) | *(无)* | 无预警 —— 客户端应**不画** |

⇒ **缺的是一层显式映射函数**,不是"统一编号"。
`wire 数字 → 客户端 shape 字符串` 的转换,当前**不存在**。

### 1.5 处置

- `wire.ts` 的过期注释**已改写**(见改动清单),把「5/5 下标冲突」替换为实测关系。
- 台账这条应**从「冲突」改判为「缺映射层,等客户端开始读协议时补」**。
  ▸ 现在不补是**安全的**,因为客户端完全不听该字段(§1.3 的 0 处)。
  ▸ 不补的条件写进了 `wire.ts` 注释的「何时必须补」段。

---

## 项 2:`TelegraphSpec` 12 vs 10 —— **前提就是错的**

### 2.1 两个关键事实

```
① TelegraphSpec 不在 shared/types/wire.ts,而在 client/src/ui/boss_hud.ts:37
   git grep -n "TelegraphSpec" -- shared/  ⇒ 0 命中

② BOSS_FIELD_TABLE 的 10 个字段是**整张 Boss 表**,不是「预警几何」
   其中 telegraph* 只有 5 个:telegraphShape / X / Y / R / EndTick
```

⇒ 「`TelegraphSpec` 12 个字段 vs 协议 10」是**拿客户端的一个子结构
去比服务端的整张表**。真实比例是 **12 vs 5**。

### 2.2 逐字段对照表(12 个)

| # | 字段 | 可选 | 协议有? | 编码位置 | 判定 / 没进的理由 |
| --: | :--- | :---: | :--- | :--- | :--- |
| 1 | `shape` | | ✓ `telegraphShape` | `wire.ts:143` U8 | 有,但**词表不同**(见项 1)⇒ 需映射 |
| 2 | `cx` | | ✓ `telegraphX` | `wire.ts:144` POS | ✓ 对齐(都是「格」) |
| 3 | `cy` | | ✓ `telegraphY` | `wire.ts:145` POS | ✓ 对齐 |
| 4 | `cz` | | ✗ | — | **没进**。协议只有 X/Y。理由:预警几何**贴地**画,`z` 是渲染用的平面高度(客户端自定) |
| 5 | `radius` | | ✓ `telegraphR` | `wire.ts:146` POS | ✓ 对齐 |
| 6 | `innerRadius` | 可选 | ✗ | — | **没进**。`RING` 语义需要它,但协议只给外半径 ⇒ 内半径只能由客户端当**玩法常数**定 |
| 7 | `facing` | 可选 | ✗ | — | **没进**。`SECTOR` 需要朝向,协议无此字段 ⇒ 扇形无法由协议驱动 |
| 8 | `spreadRad` | 可选 | ✗ | — | **没进**。扇形张角,同上 |
| 9 | `length` | 可选 | ✗ | — | **没进**。`RECT`/`LINE` 需要长度 |
| 10 | `width` | 可选 | ✗ | — | **没进**。同上 |
| 11 | `chargeSec` | | ≈ `telegraphEndTick` | `wire.ts:147` U32 | ★**单位错配**:客户端要**秒**,协议给**绝对 tick** ⇒ 需 `(endTick − now)/TICK_HZ` |
| 12 | `danger` | | ✗ | — | **没进**。纯视觉参数(红色浓度),客户端自定 |

### 2.3 汇总

```
12 个字段:
  ✓ 完全对齐         3  (cx / cy / radius)
  ≈ 有但需换算/映射   2  (shape 需词表映射、chargeSec 需单位换算)
  ✗ 协议未提供        7  (cz / innerRadius / facing / spreadRad / length / width / danger)
```

★ 那 7 个没进的理由**分两类,不能混**:

```
(a) 结构性缺失 —— 协议根本表达不了该形状
    innerRadius / facing / spreadRad / length / width
    ⇒ 结果:wire 的 SECTOR / RECT / RING **发得出、画不出**
    ⇒ 这是**协议缺口**,要改 shared/ 或 server/,需 Lead 裁决

(b) 本该客户端自定 —— 不属于同步数据
    cz / danger
    ⇒ 这是**设计正确**,不是缺口(渲染参数不该上协议)
```

⇒ **所以「12 vs 10」这个台账条目应改写为**:
「协议能支撑**圆形预警**完整;`RING` 缺内半径、`SECTOR`/`RECT` 缺朝向与长宽
⇒ 3 个形状画不出。7 个缺失字段中 5 个是真缺口、2 个是设计如此。」

---

## 项 3:`/差集/` 判据 —— **成立,且发现两套同名口径**

### 3.1 核心发现:仓库里有两个都叫「差集」的东西

```
口径甲(计算式)  差集 = 白名单 ∩ 有生产引用
                 实测 4 条(源码注释称 5,`14 − 9 = 5` 的减法口径)
                 用途:verify.ts 打印「生产零引用清单自洽(...差集 5 条...)」

口径乙(字面式)  差集 = 白名单理由文本里含「差集」二字
                 实测 1 条
                 用途:分类器 WL_NON_DEBT_DIFF,决定「算不算欠账」
```

**这两个口径的条目集合不同**,却共用同一个名字。
⇒ 这就是 Lead 说的「判据与被判对象不同层」的**具体形态**:
分类器不看事实(引用者可达性),只看**人在理由里写了什么词**。

### 3.2 全部命中条目(逐条)

**命中口径乙(`WL_NON_DEBT_DIFF = /差集/`)—— 共 1 条**

| 文件 | 理由原文 | 真「非欠账」? | 独立证据 |
| :--- | :--- | :---: | :--- |
| `server/src/content/registry.ts` | 「内容注册表;被 baseline/handshake 引用但两者均不可达 ⇒ 差集条目,无生产路径」 | **✓ 是** | 生产引用者 2 个(`content/baseline.ts`、`content/handshake.ts`),两者**均不可达**;这两个又各自被 `scripts/content-lock.ts` / `scripts/extension-drill.ts` 与 4 个测试文件消费 ⇒ 它们的岗位在门禁侧,不在生产侧 |

**命中口径甲(计算式,4 条)—— 其中 3 条被归为「欠账」**

| 文件 | 生产引用者 | 理由含「差集」? | 当前被归为 |
| :--- | :--- | :---: | :--- |
| `server/src/content/registry.ts` | baseline, handshake(皆不可达) | ★是 | **非欠账** |
| `server/src/coop/rush_order.ts` | modes, scoring, afk(皆不可达) | 否 | 欠账 |
| `server/src/party/scoring.ts` | modes, afk(皆不可达) | 否 | 欠账 |
| `server/src/prank/toys.ts` | immunity(不可达) | 否 | 欠账 |

★★ **这就是假阴性**:后 3 条的**结构与 registry.ts 完全相同**
(有生产引用 ∧ 引用者全不可达),按散文定义**它们都该是差集**,
但因为理由里没写「差集」二字 ⇒ 被算成欠账。

### 3.3 另一个方向的假阳性:否定式会被误命中

正则 `/差集/` **没有词边界,也没有否定检查**。实测:

```
「不是差集」     ⇒ 命中 ⇒ 会被判为**非欠账**
「非差集条目」   ⇒ 命中 ⇒ 会被判为**非欠账**
「这不算差集」   ⇒ 命中
「并非差集」     ⇒ 命中
「差集?未确认」  ⇒ 命中
```

⇒ 于是**同一件事,写法决定分类**:
```
「这是差集条目」   ⇒ 非欠账,不进欠账分母
「这不属于差集」   ⇒ 也非欠账,不进分母   ← 意思相反,结果相同
```
这是最坏的一种:**语义相反的两种措辞得到同一个分类结果**。

### 3.4 影响量化

```
白名单 14 条
  ├ 非欠账 3 条(baseline gate-only / registry 差集 / harness gate-only)
  └ 欠账  11 条
```

若按**口径甲**(引用者可达性)重新分类,`rush_order` / `scoring` / `toys`
三条应从「欠账」移到「非欠账(差集)」⇒
```
欠账分母 11 → 8    (少算 3 条)
非欠账   3 → 6
```

★ 注意方向:**这是"欠账被多算",不是"假非欠账"**。
任务书假设的「假的非欠账」(让分母**少算**)在本仓**当前不存在** ——
`registry.ts` 是真非欠账。实际问题是**反的**:真差集被当成了欠账。

### 3.5 更可靠的判据建议(**不改 `verify.ts`,方案供你裁决**)

```
现状:if (WL_NON_DEBT_GATE.test(reason) || WL_NON_DEBT_DIFF.test(reason))
      ⇒ 按**文本**判,人写什么就是什么

建议:把「差集」从**文本判据**改为**计算判据**

  差集(计算) = { f ∈ 白名单 | 生产引用者(f) ≠ ∅ ∧ ∀r ∈ 生产引用者(f): r 不可达 }

  实现路径:verify.ts 已有可达集(它已经在算「可达 84 / 不可达 14」),
            把「引用者可达性」这一个布尔直接接进分类器即可,
            不需要新数据源。
```

★ **但有一个必须处理的边界**,否则会引入新错:

```
`gate-only` 与 `差集` 是**两个不同的"非欠账"理由**,不能合并:
  gate-only  = 「有引用者,且引用者**可达**」—— 但可达的是 scripts/,不是生产
                ⇒ 事实:生产引用者 = 0
  diff       = 「有生产引用者,但引用者**不可达**」
                ⇒ 事实:生产引用者 ≥ 1

而 scripts/ 算不算生产会影响这个判据(见 ARCH-GAPS 第八层 §二·补的归口约定)。
⇒ 若按「生产引用者 = 0」来判 gate-only,则 baseline / harness 会被算成
   **普通欠账**(因为它们生产引用者确实是 0)——
   而它们的真实性质是「岗位在门禁侧,永不该进生产」。
```

⇒ **两条判据必须分开,且都要计算化**:

| 非欠账子类 | 计算式 | 当前命中 |
| :--- | :--- | :--- |
| gate-only | 生产引用者 = 0 **且** 被 `scripts/` 消费 | `baseline.ts`、`harness.ts` |
| 差集 | 生产引用者 ≠ ∅ **且** 引用者全不可达 | `registry.ts`、`rush_order.ts`、`scoring.ts`、`toys.ts` |

⇒ 建议**保留理由文本里的「gate-only」「差集」作为人类可读说明**,
但**分类改由计算决定**;并增加一条自检:
```
若 理由含「差集」但 计算式不满足 ⇒ 报红(理由与事实不符)
若 计算式满足 但 理由不含任何非欠账关键词 ⇒ 报红(该登记却漏登)
```
这正好把 §3.3 的**否定式误命中**也一并堵住 ——
因为"写错词"不再能改变分类,只能触发一条告警。

### 3.6 顺带发现:`WL_NON_DEBT_DIFF` 的散文与实现**不是同一个数**

```
verify.ts 注释(锚文本:`差集        9          5`)  ⇒ 称差集 5
运行期打印                                       ⇒ 「差集 5 条」
分类器 WL_NON_DEBT_DIFF 实际命中                  ⇒ **1 条**
```
⇒ 同一份文件里,「差集」这个词在**三处指三个不同的集合**。
这是本项的**根因**:名字复用了,判据没复用。

---

## 改动清单

| 文件 | 改动 | 理由 |
| :--- | :--- | :--- |
| `shared/types/wire.ts` | 改写 `TelegraphShape` 的 docblock(+34/−6) | 原注释描述的「数字版本客户端枚举」**从未存在**;替换为实测关系 + 真实缺口(缺映射层)+ 何时必须补 |
| `docs/TASK-79-three-legacy-items.md` | 新建(本报告) | — |

**未改动**:
- `client/src/ui/boss_hud.ts` —— 实测**无需对齐**(它没有错,错的是描述它的注释)
- `server/src/net/schema.ts` —— 不在我写域
- `scripts/verify.ts` —— 不在我写域(方案写在 §3.5)

**没有新增/删除任何 .ts 源码符号。**

---

## 临时文件(逐名,留原地未删)

```
_mb_t79_probe1.ts
_mb_t79_probe2.ts
_mb_t79_probe3.ts
_mb_t79_probe4.ts
_mb_t79_probe5.ts
_mb_t79_probe6.ts
_mb_t79_probe7.ts
_mb_t79_probe8.ts
```

(共 8 个,全部在仓库根目录。**未删除** —— 按纪律由你按全名处置。)

---

## 未做项 + 理由

| 未做 | 理由 |
| :--- | :--- |
| 改 `client/src/ui/boss_hud.ts` | 实测不需要 —— 该文件本身没有错,错的是**描述它的注释**。改动它反而会引入真实的下标问题 |
| 改 `scripts/verify.ts` | 不在我写域。方案在 §3.5,含两条必须分开的计算式判据 |
| 改 `server/src/net/schema.ts` | 不在我写域。且项 2 的结论是「协议缺口」,修理要动的是 `shared/types/wire.ts` 的字段表(加 `facing`/`spreadRad`/`length`/`width`/`innerRadius`),那是**协议变更**,应经你裁决 |
| 在 `wire.ts` 里加映射函数 | **有意不加**。加它会:(a) 让客户端有权依赖一个尚无消费者的 API;(b) 现在没有任何调用点。按本仓纪律(可达性门禁),加了会成为新欠账 |
| 跑 `verify.ts --all` 到 exit=0 | 那 2 项失败来自你并发的 `scripts/dup-export-audit.ts`,不是我引入的;我没有为通过门禁去改你写域的文件 |
| 更新台账原文 | `docs/CLIENT-NET-CONTRACT.md` / `docs/STAGE3-CONTRACT-DRAFT.md` / `docs/CHANGE_REQUESTS.md` **都不在我写域**(任务书写域只含 `docs/WS-05-*`、`docs/WS-07-*` 与自建报告)。三处台账里「5/5 下标冲突」「12 vs 10」的订正**待你或对应负责人落**;我的结论已放在本报告 §1.5 与 §2.3,可直接引用 |

---

## 验证

```
node tests/WS-05.test.ts    ⇒ [WS-05] 57/57 通过
node tests/WS-09.test.ts    ⇒ [WS-09] 104/104 通过

node scripts/verify.ts --docs
  ✓ 47 份非 WS 文档有实质内容(≥1500 字符、≥3 节)
  ✓ 文档间的相对链接全部有效
  ✓ 未决台账无过时条目(109 条未关闭)
  ✓ 14 份 WS 文档结构完整
  ✓ README 生产可达性与实测一致(84/98)

node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert
  冻结层 ✓ 全部通过
  生产可达性 ✓ 可达 84 / 不可达 14(入口 5,白名单 14)
  文档结构 ✓ 全部通过
  ★ 2 项失败,**均来自 `scripts/dup-export-audit.ts`**(判据形态审计:未登记的命中)
    —— 该文件是**未跟踪的新文件**(git status 显示 `?? scripts/dup-export-audit.ts`),
      由 Lead 在本轮并发创建,**不在我的写域,也不是我的改动所引入**。
      我的改动只有 `shared/types/wire.ts`(+34/−6)与新增本报告。
```

### 关于那 2 项失败的定位(供你直接处理)

```
✗ scripts/dup-export-audit.ts:68  .replace(/\/\/[^\n]*/g, '')      ← 剥注释正则缺 (^|[^:]) 前缀
✗ scripts/dup-export-audit.ts:30  const g = l.match(/^([^:]+):(\d+):export ...)
```
第一条是**已知形态**(判据审计的检测器 B:URL 里的 `//` 被当注释起点)。
正确写法:`.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')`。
两条都只需登记进 `judgement_baseline.ts` 或改写法 —— 都在你写域。

### 这 2 项与我的改动无关(三条独立证据)

```
① git ls-files --error-unmatch scripts/dup-export-audit.ts
   ⇒ error: pathspec ... did not match any file(s) known to git
   ⇒ 该文件**从未进入 git**,是工作区里新出现的未跟踪文件(git status: ?? )

② git grep -n "replace(/\/\/" -- shared/types/wire.ts  ⇒ 0 命中
   ⇒ 我的文件里**没有剥注释正则**,不可能产生该类【新增】命中

③ git diff -- shared/types/wire.ts 的非注释行 diff ⇒ 0 行
   ⇒ 我的改动是**纯注释**(docblock 改写),不含任何正则、不含任何代码
```

⇒ 因此 `--all --strict-*` 的 2 项失败**在我改动之前就已存在**,
且我**没有**为了凑 exit=0 去改你写域的 `scripts/`。

---

## 我能证明的

1. **客户端 `TelegraphShape` 从首个提交起就是字符串**
   `git show d10a59f:client/src/ui/boss_hud.ts` 原文即
   `{CIRCLE:'CIRCLE', ...}`;`git log -S "ANNULUS: 1"` 全仓历史 **0 命中**。
2. **两端类型不相交** —— 成员值分别是 `number` 与 `string`(源码直读)。
3. **三个「0 处」** —— 把 wire 数字赋给 `shape`:0;客户端读 `telegraphShape`:0;
   对 `TELEGRAPH_SHAPES` 数字下标:0。(三者的扫描范围:全 `server/src`+`client/src`)
4. **`TelegraphSpec` 不在 `wire.ts`** —— `git grep "TelegraphSpec" -- shared/` 0 命中;
   定义在 `client/src/ui/boss_hud.ts:37`,12 个字段(逐字段列出见 §2.2)。
5. **`BOSS_FIELD_TABLE` 是 10 个字段,其中 telegraph* 只有 5 个**
   (`wire.ts:137-148`,bit 0..9 逐行读出)。
6. **`/差集/` 字面命中 1 条** —— 用与 `verify.ts` 相同的白名单解析得到 14 条,
   逐条跑 `/差集/`,命中仅 `content/registry.ts`。
7. **`registry.ts` 是真非欠账** —— 生产引用者 2 个(`baseline`、`handshake`),
   二者均不可达;二级证据:它们被 `scripts/content-lock.ts`、
   `scripts/extension-drill.ts` 与 4 个测试文件消费。
8. **后 3 条「被多算成欠账」** —— `rush_order` / `scoring` / `toys` 的生产引用者
   分别为 3 / 2 / 1 个,且**全部不可达**,与 `registry.ts` 结构相同,
   但理由里没有「差集」二字 ⇒ 落到欠账桶。
9. **否定式会误命中** —— `/差集/` 是裸正则,对「不是差集」「非差集条目」
   等**语义相反**的措辞同样命中(逐条验证见 §3.3)。

## 我不能证明的

1. **我没有验证 `WL_NON_DEBT_GATE`(`/gate-only/`)是否存在同样的否定式问题。**
   我只测了 `/差集/` 一个正则。同族风险**很可能**也存在,未测。
2. **我的可达集是我自己实现的**(从 3 个入口做 import 闭包),
   不是 `verify.ts` 的 `reachableClosure`。两者结论一致(都判 `registry.ts`
   的引用者不可达),但**我没有做逐条对齐**;若 `verify.ts` 的闭包处理了
   我漏掉的形式(如动态 `await import`、`export * from`),
   个别条目的可达性可能与我不同。
3. **我没有核实「客户端将来一定会从协议读 `telegraphShape`」。**
   §1.5 说「现在不补是安全的」,依据是**当前** 0 处读取;
   若已有未合入的分支要读它,该结论失效。
4. **`SECTOR↔CONE`、`RECT↔LINE`、`RING↔ANNULUS` 的对应关系是我按语义推断的,
   不是手册或协议里写明的。** 我从 `boss_hud.ts` 的注释
   (「ANNULUS 的语义是环」「扇形(CONE)」「矩形长条(LINE)」「十字(CROSS)」)
   与 wire 的 note(`0=无 1=圆 2=扇 3=矩形 4=环`)对齐得出,
   但**仓里没有一份权威映射表**。若将来发现某一对其实不同义,§1.4 的表要改。
5. **「欠账分母 11 → 8」这个换算是按口径甲重分类的结果,我没有实际运行改造后的分类器**
   (那是 `verify.ts`,不在我写域)。这是**推演值,不是实测值**。
6. **我没有验证 `TelegraphSpec` 的 7 个缺失字段是否在别处(如
   `docs/` 的手册条文里)有定义。** 我只查了 `shared/`、`server/src/`、
   `client/src/`、`tests/`、`scripts/` 五处的代码符号。