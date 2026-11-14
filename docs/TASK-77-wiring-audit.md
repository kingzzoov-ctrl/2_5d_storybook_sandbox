# task-77 报告:两个未登记的生产零引用模块 + 分母对账(98 vs 88)

> 生成时间 2026-11-14 · 作者 build-wiring · 全部数据可用文末命令复跑

---

## 一、我能证明的(每条附命令与输出)

### 1.1 98 与 88 的差 = **恰好 10 个文件,全部是 `shared/` 下非 `src/` 的文件**

```
node scripts/orphan-audit.ts   ⇒ 生产文件 98
node scripts/ts-paths.ts       ⇒ 生产     88
差         = 10
```

我独立复刻两个脚本的遍历器后,**在 A 不在 B 的恰好 10 个**:

```
shared/constants/bosses.ts
shared/constants/items.ts
shared/constants/mobs.ts
shared/net/delta.ts
shared/testing/harness.ts
shared/types/alchemy.ts
shared/types/entities.ts
shared/types/physics.ts
shared/types/tile.ts
shared/types/wire.ts
```

**在 B 不在 A 的 = 0 个** ⇒ **B 是 A 的真子集**,差 100% 来自 A 多算的部分。

### 1.2 根因:`ts-paths.ts:85` 的正则要求 `shared/src/`,而该目录**不存在**

```
ts-paths.ts:83  /** 生产文件(server|client|shared 的 src 下)。 */
ts-paths.ts:85  return /^(server|client|shared)\/src\//.test(...)

实测 shared/ 下的顶层目录:
   shared/constants   存在
   shared/contracts   存在(0 个 .ts)
   shared/net         存在
   shared/testing     存在
   shared/types       存在
   shared/src         ★ 不存在
```

⇒ `/^shared\/src\//` **永远匹配 0 个** ⇒ `shared/` 整棵树被静默排除。

⚠️ **这与陷阱 110 是同一族的新实例,而且方向相反**:
```
陷阱 110:排除规则按**裸目录名**匹配 build ⇒ 误排除 server/src/build/(源码)
本条    :包含规则写死 shared/**src**/     ⇒ 误排除 shared/(源码)
⇒ 共同点:规则用了一个**与"是不是生产源"无关的判据**(目录名 / 目录形状),
   于是它同时圈住了"要排除的"和"不该排除的"。
⇒ 与我在 task-77 前一环踩的"用下划线前缀当'可删'"是同一条判据形态。
```

### 1.3 ★ 哪个口径对:**A(98)对,B(88)漏了 10 个真生产源**

判据不是"谁的文件多",而是**那 10 个是否真的被生产 `server/src`+`client/src` import**。实测:

```
shared/constants/bosses.ts   被 12 个 server|client 文件 import
shared/constants/items.ts    被 19 个
shared/constants/mobs.ts     被  7 个
shared/net/delta.ts          被  6 个
shared/types/alchemy.ts      被  9 个
shared/types/entities.ts     被 18 个
shared/types/physics.ts      被 18 个
shared/types/tile.ts         被 24 个
shared/types/wire.ts         被  4 个
shared/testing/harness.ts    被  0 个(仅注释提及,见 1.6)
```

⇒ 前 9 个是**被大量生产文件 import 的共享契约**,百分之百属于生产分母。
⇒ B 把它们排除,口径**错**。

⚠️ **这条也是 `ts-paths.ts` 自己承诺的失败**:它在 docstring 里写了三条硬规则,
其中第 3 条是「**分母必须与独立来源对账**」——而它自己**没和 orphan-audit 对账**,
于是漏掉 `shared/` 至今无人发现(它自报的 88 看起来完全正常)。

### 1.4 `orphan-audit.ts` 的扫描范围**包含** `shared/` —— 实测确认

```
orphan-audit.ts:122  const PROD_DIRS = ['server/src', 'client/src', 'shared'];
```

⇒ 用的是**整棵目录**,不含 `src/` 要求 ⇒ **包含** `shared/`。
且该行上方 L114-121 有一段注释说明"`shared` 必须在列,与 `verify.ts` 的 `prodDirs` 同一口径",
并记录了 2026-11-13 的双向对照(零引用文件放 `shared/types/` ⇒ Δ0 空洞;
放 `server/src/net/` ⇒ Δ1 正确报警)。

⇒ **我的独立复刻复现了这两个数**(98 / 88),故上面结论不是转述注释。

### 1.5 三方口径一致性(第四个独立来源)

```
orphan-audit.ts   PROD_DIRS = ['server/src','client/src','shared']   ⇒ 98
verify.ts:2085    const prodDirs = ['server/src','client/src','shared'] ⇒ 同 A
ts-paths.ts:85    /^(server|client|shared)\/src\//                   ⇒ 88  ★ 唯一异类
我的独立复刻      A 口径 ⇒ 98 / B 口径 ⇒ 88                        ⇒ 与各自一致
```

⇒ **2 : 1**,且异类那边有可证的漏算(1.3)⇒ A 口径对。

### 1.6 `shared/testing/harness.ts` 的生产引用**只在注释里**(引用 ≠ 执行)

任务卡的 Lead 侧取证说它"被全部 23 个测试套件 import"。
我逐行判注释/代码后,发现另一个要紧事实 —— **生产侧 5 处提及全在注释里**:

```
server/src/alchemy/attributes.ts:110  [注释]  * 2. 随机源(与 harness.mulberry32 位级一致,便于测试对照)
server/src/alchemy/attributes.ts:114  [注释]  * Mulberry32。与 `shared/testing/harness.ts` 的 `mulberry32` 逐位一致,
server/src/alchemy/attributes.ts:115  [注释]  * 生产侧用本函数,测试侧可直接注入 harness 的实现,两者可互换。
server/src/party/scoring.ts:12        [注释]  * 本文件不 import 测试桩,自带与 `harness.mulberry32` 位级一致的随机源。
server/src/party/scoring.ts:18        [注释]  * Mulberry32。与 `shared/testing/harness.ts` 的 `mulberry32` 逐位一致,

⇒ 生产侧**代码态**提到 harness 的处数 = 0
```

⇒ 那 2 个文件是**刻意自带一份位级一致的实现**并把这一点写进注释 ——
**不是** import,更不是消费。这正是 Lead 纪律 2「引用 ≠ 执行」的又一例:
**用裸 grep 数 `harness` 会得到 2 个"生产引用",剥掉注释后是 0。**

- 真 import `harness.ts` 的文件 = **26 个**:`tests/` 下 **24** 个 +
  非 tests **2** 个(`scripts/assertion-audit.ts` 门禁自身、`_vss_restore/_ws07_backup.ts` 备份件)
- ⇒ 「生产真 importer = 0」**成立**

### 1.7 测试分母的三个数(顺带厘清,避免下一个对账又对不上)

```
tests/ 下 .ts 总数        = 25   (全部都是 *.test.ts,无辅助文件)
*.test.ts(套件)          = 25
门禁自报"套件"            = 25   ✓ 与上面一致
import harness.ts 的      = 24   ← 差 1
```

⇒ **`25` 与 `24` 都对,口径不同**:25 是 tests/ 全部套件;24 是"真的 import harness.ts"的那些。
⇒ 那 1 个不 import 的套件 = `tests/WS-FND-03.test.ts`(它测 handshake,不需要 harness)。
⇒ 任务卡里"全部 23 个测试套件"的 **23 已过期**(现为 25 个套件 / 24 个消费 harness)。
⇒ README 的旧数「22 个套件 / 1473 用例」也已过期(现 **1500 用例 / 25 套件**)。

### 1.8 orphan 11 条逐项(供验收"逐项对得上")

我独立复刻 `orphan-audit.ts` 的判据(含它那套逐字符 import 扫描器)得到:

```
生产文件 98 / 测试文件 25
实测 orphan:11 个 / 4299 行      ← 与脚本自报**逐字一致**

模块                                                 行数  测试
  server/src/party/modes.ts                           738  WS-11,WS-FND-06
  server/src/db/memory_db.ts                          685  WS-07,WS-FND-02,WS-FND-10-restore
  server/src/social/afk.ts                            495  WS-11
  client/src/net/prediction.ts                        457  WS-07
  server/src/content/handshake.ts                     366  WS-FND-03
  server/src/content/baseline.ts                      302  WS-07,WS-FND-01,WS-FND-04
  server/src/build/wiring_view.ts                     271  WS-03
  server/src/mobs/taming.ts                           269  WS-04
  server/src/index.ts                                 264  WS-07,WS-FND-09-wiring,WS-FND-10-restore,WS-FND-11-afk
  server/src/prank/immunity.ts                        253  WS-11,WS-FND-06
  shared/testing/harness.ts                           199  WS-01..14,FND-01,02,04..11 共 24 套件
```

### 1.9 行数复核(用 node 取,**不用 PowerShell**)

```
server/src/index.ts        264 行 / 8868 字符 / CRLF 263   ← ⚠ 见下
shared/testing/harness.ts  199 行 / 6321 字符 / CRLF   0
```
⇒ 与任务卡给的 264 / 199 **一致** ✓

⚠️ **顺带发现**:`server/src/index.ts` 是 **CRLF(263)**,而同仓其他 `.ts` 基线是 LF。
它可能是新加的、行尾与其他文件不同。**我只报不改**(它在 task-76 写域)。

---

## 二、我不能证明的

```
1 **"88 这个数被谁用过"** —— 我只证了 ts-paths.ts 的 isProd 口径漏 shared/。
   我没有穷举"有没有别的脚本/文档引用了 88 并因此得出错结论"。
   ⚠️ 若 ts-paths.ts 只是被当作"遍历器工具"用,而用它的地方自己另加 shared/,
      那 88 就是无害的历史遗留。**我没法从 ts-paths.ts 本身判断这件事。**

2 **"shared/ 该不该算生产"是口径选择,不是纯事实。**
   我能证明的是:A 口径下那 10 个文件被生产大量 import;
   **不能**证明"生产"这个词在别处(CI / README / 别的门禁)没有被刻意定义成
   "server|client|shared 的 src 下"。若那是刻意定义,则该改的是那些 import,不是正则。
   ⇒ 我倾向 A,但这是**判断**,不是实测。

3 **harness.ts 的"曾经有没有登记过又被删"** —— 任务卡问了这个。
   我只能证明它**现在**在 verify.ts:1508 有登记(见三),
   **不能**证明它在历史上是否被删过(那需要看 git 历史,而我没查)。

4 **24 vs 25 里那 1 个不 import harness 的套件,我已实测确认是 `WS-FND-03.test.ts`**
   (它自带 `ok`/`eq`,见 4.4)。但**我仍然不能证明"它真的不需要 harness"**:
   它可能就是不知道有 harness,而不是刻意不用 —— 该文件头没有说明理由。
   ⇒ "是刻意还是疏漏"我判不了。

5 **那 9 个 shared/ 文件的 import 计数是"提到文件名的文件数",不是"import 语句数"。**
   我用的判据是 `new RegExp(basename).test(整个文件文本)` ⇒
   **没有剥注释** ⇒ 包含注释里提到文件名的情形 ⇒ 是**上界**。
   ⇒ 方向是保守的(只会**高估**它被生产使用),故不影响"它们属于生产源"这一结论;
      但我没给出剥注释后的下界。
```

---

## 三、`harness.ts` 定性:**正常测试基础设施**(而且**它早已登记,任务卡的前提不成立)

### 3.1 ★ 首先纠正任务卡的一个前提:它**不是"未登记"**

任务卡与 `orphan-audit.ts` 的输出都说 `harness.ts` 是"**未登记**"。实测:

```
verify.ts 里 'harness.ts' 出现 1 处,行号 1508:
    L1508 ★ [代码]: ['shared/testing/harness.ts',

⇒ UNREACHABLE_EXEMPT 键 14 个,其中含:
    shared/testing/harness.ts      ← ★ 已在列
    (server/src/index.ts           ← 确实不在列)
```

⇒ **准确的说法是**:
```
🔴 它在 verify.ts 的 UNREACHABLE_EXEMPT 里**已登记**(附完整理由,L1508-1515)
🟡 它在 orphan-audit.ts 的 ORPHAN_KNOWN 里**未登记**(9 条,不含它)
⇒ ⇒ 两个白名单口径不同步 —— 这才是那个 "!" 的真实含义。
```

**这是一个"两个白名单各记一半"的问题,不是"漏了一个模块"的问题。**
两表现在分别有 14 条(verify)与 9 条(orphan-audit),覆盖面不同:
`orphan-audit` 只收"生产零引用 + **有测试引用**"的 L2 类,
`verify` 还收"差集引用"等别的类 ⇒ 两条清单**本来就不该等长**,
但**同一文件在两个清单里应当同判**(现在 harness 是 verify 有、orphan 无)。

⇒ ★ 建议:补的是**`orphan-audit.ts` 的 `ORPHAN_KNOWN`**(那是我的写域),
　　**不是** `verify.ts`(那里已经有了,且理由比我写的更完整)。

### 3.2 定性:**正常**(测试基础设施),且判断依据已由 verify.ts 写清

`verify.ts:1508-1515` 的现有理由质量很高,摘其要点:
```
· 生产侧真 importer = 0,只被 tests/ 消费 ⇒ 属「gate-only」家族
· 与 server/src/content/baseline.ts 同判据(门禁真消费它,生产不消费),**不是欠账**
· ★ 关键区别:它住在 shared/(跨层契约目录),客户端与服务端都能 import
  ⇒ 接线条件是「**两侧都不该接**」,不是「等谁接线」
· 若哪天被生产 import,那反而是缺陷(把测试依赖拖进生产闭包)
```

我**独立复核了这段理由的每一条事实**(1.6 节):
- 「生产真 importer = 0」✓(代码态 0,注释 5 处不算)
- 「只被 tests/ 消费」✓(真 import 者 26 个 = tests 24 + 门禁 scripts 1 + 备份件 1;
  那两个非 tests 都不是生产)
- 「若被生产 import 反而是缺陷」✓ 理由成立:它会往生产闭包拖 `results` 这个**可变全局数组**
  与 `report()`(带 `process.exitCode` 副作用)

⇒ **定性:正常(测试基础设施),非欠账。** 理由无需重写,现有文本已完备。

---

## 四、建议的白名单理由文本(直接可粘贴)

### 4.1 给 `orphan-audit.ts` 的 `ORPHAN_KNOWN`(补这一条,**这是真正缺的**)

体例参照同表内的 `server/src/content/baseline.ts`(同为"门禁/测试真消费、生产不消费"):

```ts
  ['shared/testing/harness.ts',
    '测试夹具(ok/eq/test/results 与汇总打印);生产真 importer = 0,只被 tests/ 消费'
    + '(24 个套件 + 门禁脚本自身)。属「gate-only」家族,与 server/src/content/baseline.ts'
    + '同判据,**不是欠账**。'
    + '⚠️ 与其它 gate-only 条目的关键区别:它住在 shared/(跨层契约目录),'
    + '两侧都能 import ⇒ 接线条件是「两侧都不该接」,不是「等谁接线」。'
    + '若哪天被生产 import,那是**缺陷**(会把测试依赖拖进生产闭包),本表自检会报「已可达,应移出」。'],
```

⚠️ 上面这段与 `verify.ts:1508-1515` 的现有理由**语义一致但更短** —— 我的建议是
**让两处文字一致**(或直接引用),避免同一条目两套措辞各自漂移。
⇒ 若 Lead 希望完全复用,把 verify.ts 那段原文整段搬过来亦可(它更长更完整)。

### 4.2 ⚠️ 更正:那处旧数字不在我写域里(实测后修订)

我初稿写"`orphan-audit.ts` 的注释里说 21 个测试文件"—— **实测该说法有误,已更正**:

```
实测 'harness' 在 scripts/orphan-audit.ts 里出现: **0 次**(它根本没提 harness)
实测 '21 个测试文件' / '21 个套件' 的分布:
    scripts/verify.ts   : 5 处   ← ★ 全部在这里
    scripts/orphan-audit.ts : 0 处
```

⇒ **旧数字全在 `verify.ts`(Lead 的写域),我一个字都不能改,只报。**
⇒ 具体位置(供 Lead 决定是否更新):
```
verify.ts:1510  + '它**只被 tests/** 消费**(21 个测试文件的公共 harness)。'   ← 现为 24
verify.ts:3009  **当前全仓 21 个套件触发 0 个**(已逐个实测)                 ← 现为 25
verify.ts:3015  (21 个套件触发 0 个,不是 21 个)                             ← 同上
（另 verify.ts:187 / :5256 / :5291 的 "20 个套件/21 个套件" 出现在**历史引文**
  ——那些是在引用"当时实测的输出",属**正确的历史记录**,不应改。）
```
⇒ ★ 判据:**区分"当前事实"与"历史引文"**。前者过期要更新,后者过期是**正确的**
　　(它记录的是当时看到的东西)。我上面把三类混在一起报了,这里分开列出。

### 4.3 `orphan-audit.ts` 的写域:我**刻意没动**

任务卡允许我"补口径注释"。我实测后判断**不值得改**,理由:
```
· 该文件从未提到 harness ⇒ 它没有"说过 21"这种错话要订正
· 它缺的是 ORPHAN_KNOWN 里的一条(见 4.1)—— 那属**数据**,不是注释
· 而按 task-77 边界,ORSAN_KNOWN 的新条目由 Lead 并表
⇒ 所以我只给提案(4.1),不动文件。实测它仍 exit=0 且 git status 无改动。
```

### 4.4 ★ 顺带发现:一个套件自带 `ok`/`eq`,**不走 harness**(两份实现)

对账测试分母时发现,全仓 25 个套件里有 **1 个**不 import harness:

```
tests/WS-FND-03.test.ts
  L36  const ok = (cond: boolean, msg: string): void => {...}
  L45  const eq = (a, b, msg) => ok(a === b, ...)
  L47  const okHas = (s, sub, msg) => ...
  L572 console.log(`\n[WS-FND-03] ${pass}/${pass + fail} 通过`);
  ⇒ 它与 harness **同形但不共享实现**:自带 pass/fail 计数、自带汇总打印
```

实测影响:
```
✓ 它仍被门禁正确计入(node tests/WS-FND-03.test.ts → [WS-FND-03] 116/116 通过,
   门禁自报 1500 条 / 25 套件 里包含它)
⚠ 但它的 ok 与 harness 的 ok **语义不同**:
    harness.ok 失败时 **throw**(被 test() 捕获并记为该块失败)
    本文件 ok 失败时**只计数、继续跑**(不是 throw)
    ⇒ 两种"失败传播"模型。本文件因此**没有 test() 分块**概念,
      门禁的"逐块断言数"对它只能取总数。
⇒ ★ 这是**刻意的**吗?我没有找到说明为什么不用 harness 的注释(该文件头只写
   "被测:handshake.ts / 性质:纯函数,零依赖")。
⇒ 我**只报不判**:如需统一,应问原作者或 Lead 裁;不在我写域。
```
⇒ 这条与 `verify.ts:1510` 的"21 个测试文件的公共 harness"**互相印证**:
　　harness 从来不是"全部套件"的公共件 ⇒ 该措辞本就该写成"24 个(25 个中 1 个自带实现)"。

---

## 五、★ 98 vs 88 的分母构成表 + 哪个口径对

### 5.1 构成表(按 `xxx/yyy` 二级目录)

| 目录 | A: `orphan-audit.ts`(98 口径) | B: `ts-paths.ts`(88 口径) | 差 |
| :--- | ---: | ---: | ---: |
| `client/src` | 27 | 27 | 0 |
| `server/src` | 61 | 61 | 0 |
| `shared/constants` | 3 | **0** | ★ 3 |
| `shared/net` | 1 | **0** | ★ 1 |
| `shared/testing` | 1 | **0** | ★ 1 |
| `shared/types` | 5 | **0** | ★ 5 |
| **合计** | **98** | **88** | **10** |

### 5.2 判据来源(两个遍历器各自的条件)

| | 条件 | 含义 |
| :--- | :--- | :--- |
| A `orphan-audit.ts:122` | `PROD_DIRS = ['server/src','client/src','shared']` | `shared/` **整棵树** |
| A `verify.ts:2085` | `prodDirs = ['server/src','client/src','shared']` | 同上(**与 A 一致**) |
| B `ts-paths.ts:85` | `/^(server\|client\|shared)\/src\//` | 要求紧跟 **`src/`** |

### 5.3 哪个口径对 **A** —— 三条独立理由

```
理由 1(直接证据):B 漏掉的那 10 个里,有 9 个被生产大量 import。
   shared/types/tile.ts    被 24 个 server|client 文件 import
   shared/constants/items.ts 被 19 个 · shared/types/entities.ts 18 个 · physics 18 个 …
   ⇒ 把它们排除在"生产"之外**明显不对**。

理由 2(多数一致):A 与 verify.ts:2085 **两个独立位置**取同一口径,B 是唯一异类。

理由 3(自证承诺):ts-paths.ts 自己的 docstring 第 3 条硬规则是
   「**分母必须与独立来源对账**」—— 而它自己没对账 ⇒ 漏 shared/ 至今无人发现。
   ⇒ 修 B 的口径,正是执行它自己写下的规则。
```

### 5.4 ★ 但对"哪个该改"我要给一句保留

**我倾向改 B(`ts-paths.ts:85`)的判据,但这是判断不是实测**:
```
· 若"生产"在本仓就是"三目录的源代码" ⇒ 改 /^(server|client|shared)\//
· 若"生产"被刻意定义成"必须有 src/ 层" ⇒ 那该改的是 10 个 shared/ 文件的位置
⇒ 从 `verify.ts:2085`(Lead 自己的门禁)取三目录**整棵**,我判断前一种才是本仓口径。
```
⇒ ⚠️ 但 `isProd()` 是 `ts-paths.ts` 的**导出函数**,可能被别处消费。
　　**改它之前应先 grep 谁 import 了 `isProd`** —— 这一步我**没做**(见"不能证明的"第 1 条)。

### 5.5 陷阱 110 复核:`server/src/build/` **两边都是 5** ✓

```
server/src/build       A = 5   B = 5     ⇒ 已修好,无差
client/src             A = 27  B = 27
shared/testing         A = 1   B = 0     ★ 不一致
shared/constants       A = 3   B = 0     ★ 不一致
shared/types           A = 5   B = 0     ★ 不一致
shared/net             A = 1   B = 0     ★ 不一致
```
⇒ Lead 上次修好了 `build/`,而**同一条规则的另一个受害者(`shared/`)还在**。
⇒ ★ 教训:**修"排除/包含规则"时,要问"它还会误伤谁"** —— 只修被报告的那一例,
　　下一例会以同样的形状等着。

---

## 六、`server/src/index.ts` 的白名单理由提案

### 6.1 它是什么(读 docstring + 实测)

```
264 行 / 8868 字符
export: AssembleDeps / Assembled / createHost / assemble / AssembledServer / createServer
import 它的文件 = 4(全部在 tests/):
   tests/WS-07.test.ts · WS-FND-09-wiring.test.ts · WS-FND-10-restore.test.ts · WS-FND-11-afk.test.ts
它 import 的下游:WorldSim / RoomRuntime / db/repo / db/driver.sqlite
verify.ts:1187 已在 PROD_ENTRIES:'server/src/index.ts', // 生产装配入口
```

docstring 自述(要点):它是"本仓**唯一**的『把世界装进房间』的地方";
`RoomRuntime` 的 `worldSaveHost` 此前**0 处赋值**(全在 scripts/tests)⇒ 运行期恒为 null;
它刻意只装到 `RoomRuntime` 层(不 import colyseus 壳,因后者有 44 处 `@type` 装饰器)。

### 6.2 定性:**与 harness.ts 相反 —— 这是真欠账,不是 gate-only**

关键区别:
```
harness.ts   : **两侧都不该 import 它** ⇒ 生产 0 引用是**正确状态**
index.ts     : **它本来就应该被生产 import** ⇒ 生产 0 引用是**缺陷状态**
⇒ 同一个"生产零引用"的数字,两种完全相反的定性。
⇒ 这正是 `orphan-audit.ts` 判据的边界:它只看"有没有生产引用",
   而**看不到"该不该有"** —— 故两个条目都落在同一张表里,却需要截然不同的理由文本。
```

### 6.3 白名单理由提案(体例对齐同表内的 `rush_order.ts` / `taming.ts`)

⚠️ 本仓纪律:理由要写清「**卡在哪**」而不是笼统「待接入」。
且 **`index.ts` 是 task-76 的处理对象** ⇒ 以下为提案,**具体定性由 task-76 定稿**。

```ts
  ['server/src/index.ts',
    '生产装配入口(createHost/assemble/createServer);'
    + '**这是真欠账,不是 gate-only** —— 与 harness.ts 的判据相反:'
    + '它**本就该被生产 import**(把世界装进房间的单一定义点),'
    + '而实测生产侧 0 引用、4 个 import 者全在 tests/ ⇒ 运行期没有任何东西构造它。'
    + '⇒ 缺的不是"一行接线",是**一个生产入口进程**(它自己就是入口,没人启动它)。'
    + '⚠️ 与 task-57 同名但不同因:task-57 是"世界装不进房间",本条是"装好了没人启动"。'],
```

**⚠️ 但我要给 Lead 一句提醒**:这段理由里
「缺的是一个生产入口进程」**是我的推断**,依据是"它导出 createServer 而无人调用"。
我**没有**去查"本仓有没有 package.json 的 main/start 指向它"(那属于 task-76 的范围)。
⇒ 若 task-76 已查明启动路径,应以它的结论为准,**我的文本只作体例样例**。

---

## 七、我留下的临时文件(逐名 —— **未删,等 Lead 批**)

```
_t77_probe.ts        (根,分母对账探针 v1)
_t77_out.txt         (根,v1 输出)
_t77b.ts             (根,登记状态/测试分母探针 v2)
_t77b_out.txt        (根,v2 输出)
_t77c.ts             (根,注释vs代码判据 + index.ts 角色 + orphan 逐条 探针 v3)
_t77c_out.txt        (根,v3 输出)
```

⇒ 共 **6 个**,全部在仓库根(不在 `scripts/`、不在 `tests/`)。
⇒ 按硬纪律**不自行删除**;若批准删除,请按上面**全名逐个**处理。
⇒ 我**未改动** `scripts/orphan-audit.ts`(任务卡允许补口径注释,但我判断
　　"补注释"不如"补 ORPHAN_KNOWN 那一条"实在 —— 而后者属于 Lead 并表,故我只给提案)。
⇒ ⚠️ 因此本任务**没有触碰任何写域文件**,`git status` 里我名下应为 0 个修改
　　(除上述 6 个未跟踪探针)。

---

## 八、验收自检

```
✓ node scripts/orphan-audit.ts 输出与本报告 1.8 节**逐项对得上**
  (生产 98 / 测试 25 / orphan 11 个 4299 行 / 9 条已登记 / 2 个未登记)
  ⇒ 我用独立复刻的判据得到同样数字
✓ 我未补 orphan-audit.ts 的注释 ⇒ 它**未被改动**,仍 exit=0
  (实测:node scripts/orphan-audit.ts → exit=0)
⚠ 全量门禁 `verify.ts --all` 当前 exit=1,原因是**别人**的新文件:
  [新增] scripts/dup-export-audit.ts:68 / :30 判据形态审计未登记
  ⇒ 与本任务无关,且不是我的写域
```

复跑命令:
```
node scripts/orphan-audit.ts
node scripts/ts-paths.ts
node _t77_probe.ts && node _t77b.ts && node _t77c.ts
```
