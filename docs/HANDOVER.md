# 项目移交包 —— 2.5D 绘本风多人沙盒

> **本文是移交给下一位负责人/下一个会话的入口文档。**
> 生成时间:2026-11-14 · 基线提交 `bb481e4`(分支 `main`,共 185 次提交,已全部推送)
> **本文所有数字都是本次**从磁盘/工具**实测**的,不是从别的文档抄的。
> 抄来的数字会过期;实测的不会。凡本文与旧文档冲突,**以本文为准**,并去修旧文档。

---

## 一、这个项目是什么

```
把 `2_5d_cartoon_sandbox_plan.md`(747 行设计手册)从「想法」细化到「可执行工程契约」。
```

| | |
|:---|:---|
| 运行环境 | **Node v24.13.0**(用原生 TS 类型擦除,无编译步骤) |
| 运行时依赖 | **0 个**(`dependencies = {}`) |
| 开发依赖 | `typescript` · `vite`(仅客户端构建用) |
| 远端 | `https://github.com/kingzzoov-ctrl/2_5d_storybook_sandbox.git` |
| 层 | 服务端 `server/src` **61** `.ts` · 客户端 `client/src` **27** · 共享 `shared` **10** ⇒ **生产 .ts 合计 98** |
| 测试 | `tests/*.test.ts` **28** 个套件 |
| 工具 | `scripts/*.ts` **31** 个 |
| 文档 | `docs/` **75** 个 `.md` + 3 个 `.png` = 78 文件 / **2.64 MB** |
| 门禁 | `scripts/verify.ts`(6120 行) |

### ★ 三条不许违反的语法约束(这不是风格问题,是能不能跑的问题)

```
✗ enum            ✗ 构造函数参数属性      ✗ namespace       ✗ 装饰器
✗ 相对导入不写 `.ts` 后缀(node 原生 ESM 要求显式扩展名)
✓ 只允许「可擦除语法(type-erasure only)」
⇒ 门禁有一节专门查这个(「可擦除语法」),全绿
⇒ ⚠️ 唯一例外:`server/src/net/schema.colyseus.ts` 用了 **44 个装饰器**,
  已在门禁登记为**唯一例外**(`README 装饰器例外条数与实测一致(1)`)
```

---

## 二、怎么跑(验收命令)

```bash
cd 2_5d_sandbox

# ★ 完整验收(必须带全开关 —— 理由见下)
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck

# 常用单跑
node scripts/verify.ts --all          # 全部测试 + 门禁(约 21s)
node scripts/gate-selfcheck.ts        # 门禁自检 29 用例(约 163s)
node tests/WS-10.test.ts              # 单个套件
npm run sim                           # 服务端模拟 demo
npm run build:client                  # 客户端构建
```

### ⚠️ 为什么**必须**带那三个 `--strict-*`

```
裸跑 `node scripts/verify.ts` **也会印「全部通过」并返回 0**,
即使此刻刚新增了没登记的不可达模块 —— 因为**可达性 / 同义反复 / 入口执行层**
这三道门禁在默认口径下**只告警、不拦截**。
⇒ 「verify.ts 全绿」**不覆盖**这三道门禁。
```

### ★★ 读门禁输出的**唯一正确方式**(我在这上面犯过错,记一次)

```
✗ 不要用关键词计数(/✗/)
   门禁自检的输出有**三层嵌套**,`/✗/` 会把三层都匹配:
     ① 真失败(缩进 0 或 2)
     ② ★ **自检内部回显的 ✗**(缩进 12)—— 那是**自检正在工作**,
        把「变异后副本」的门禁输出贴出来当证据,不是失败
     ③ 自检自己的判决行
   ⇒ 实测同一文件:**任意位置匹配=13,行首匹配=0**。
   ⇒ 我用 `/✗/` 数出 11/14/9,真值是 **1**。三个数之间的差异**本身就是我的数法造成的**。
✓ 正确做法:**读门禁自己的汇总行「N 项失败」,或只看行首的 ✗**
```

---

## 三、当前基线(逐项实测)

```
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck
  ⇒ **exit 0 / 行首 ✗ 0 项**(耗时 ~229s,含自检)
```

| 指标 | 值 | 说明 |
|:---|:---|:---|
| 用例 | **1526 条 / 28 套件** | WS 1011 条 / 14 套件 · 基座 FND 515 条 / 14 套件 |
| 门禁自检 | **29/29** | 2026-11-14 由 28/29 提升(修 T37 锚点换行 bug) |
| 跨 WS 集成 | 38/38 | |
| 冻结层不变量 | 17 | |
| 生产可达性 | **88 / 98**(不可达 10,白名单 10) | 欠账构成:等客户端入口 0 / 等编排层接线 1 / 等服务端机制 3 / 等客户端机制 2 / 等裁决 0 |
| 同义反复候选 | **5 条**(白名单 5) | 历史:34 → 9 → 5 |
| 类型检查基线 | **265 条 / 指纹 131** | 2026-11-14 从 267/132 更新,`TS2304` 归零 |
| 未决台账 | **133 条**(108 未关闭 / **0 阻塞** / 25 已关闭) | |
| PROGRESS 陷阱 | **47 节 / 94..140** | 严格递增 ✓ / 无缺号 ✓ / 无 BOM ✓ / 453550 字节 |

**可达性 88/98 的 10 条不可达**:6 条欠账 + 4 条非欠账(gate-only 2 + 差集 2)。

---

## 四、目录结构与各目录职责

```
2_5d_sandbox/
├── README.md            唯一入口 · 所有「N/N」自称都在这里(受门禁交叉校验)
├── package.json         27 个 npm scripts · 零运行时依赖
├── tsconfig.json  vite.config.ts
├── server/src/          61 .ts —— 服务端(权威侧)
│   ├── sim/             世界模拟主体(3):world_sim.ts ⚠️ 承重文件
│   ├── world/  physics/ 地形 / 20Hz 刚体
│   ├── build/  wiring/  建造 · 接线层(3)
│   ├── combat/  vitals / revive / progression(6)
│   ├── mobs/  bosses/   生物 AI / Boss(7 + 4)
│   ├── alchemy/  coop/  party/  prank/  social/  各子系统
│   ├── net/             网络层(6)—— ws_server.ts · room.ts · room.colyseus.ts …
│   ├── content/  db/  events/  rooms/  基础设施
├── client/src/          27 .ts —— 客户端(渲染 + 预测)
│   ├── stage/(10) three/(4) ui/(7) net/(4)
├── shared/              10 .ts —— 两端共享契约
│   ├── types/           tile · entities · physics · wire · alchemy
│   ├── constants/       items · mobs · bosses
│   ├── net/delta.ts     协议编解码
│   └── testing/harness.ts  ★ 测试基座(见第六节,必须理解它是 **throw 式**)
├── tests/               28 .test.ts
├── scripts/             31 .ts —— 门禁与审计器
├── docs/                75 .md + 3 .png / 2.64 MB
│   ├── PROGRESS.md      443 KB ★ 陷阱库(全仓最重要的单份文档)
│   ├── CHANGE_REQUESTS.md 187 KB · ARCH-GAPS.md 90 KB
│   ├── LEAD-PLAN.md     当前计划与快照 ★ 接手先读这份 + PROGRESS
│   ├── WS-01..14-*.md   14 份子系统设计(每份 ≥10 节 / ≥2000 字符,门禁强制)
│   └── 其余 61 份        任务报告 / 审计 / 契约
└── _*                   临时物,**不参与门禁,但不要随手删**(见第五节)
```

---

## 五、★★★ 根目录的 `_*` 临时物 —— **先读完本节再动手**

**实测规模(2026-11-14)**:

| 目录 | 大小 | 文件数 | 是什么 | 能不能删 |
|:---|--:|--:|:---|:---|
| `_vss_restore/` | 44.35 MB | 189 | 一次恢复操作的**只读留档** | ✗ **保持只读留档**,严禁整目录覆盖回写 |
| `_design/` | 21.92 MB | 30 | 用户提供的设计稿原包 | ✗ 只作参考,**不入库** |
| `_probe_sandbox/` | 4.99 MB | 182 | 队友做隔离实验拷的**整仓副本** | ✗ 活跃使用中 |
| `_shots/` | 1.92 MB | 15 | 验收截图(可重跑生成) | △ 可重建 |
| `_t84_ca/` `_t84_cb/` `_t84_bx_copy/` | 0.78 MB | 10 | 队友的隔离副本 | △ 待清理 |

**根级 `_` 开头文件:337 个 / 2.26 MB**,按前缀:

```
_t85_*  ×58   ← net-persist
_t84*_* ×约130 ← build-wiring(逐字母 aa..cb)
_mb_*   ×37   ← mob-boss-ai
_tp89_* ×21   _tp91_* ×21   _tp93_* ×4   ← terrain-physicist
_t87_*  ×17   _t87b_* ×3    ← 其它
_ic_*   ×11   ← alchemy-core
_ho_*   ×1    ← Lead 本次移交核对脚本
其它(无前缀) ×78
```

### ★★★ 三条**硬纪律**(全部由真实事故换来的)

```
1 ✗ **不要用通配符删除** —— Lead 曾执行 `Remove-Item _tp131132.py,_tp89*.txt`,
   本意删 1 个,**实际删掉 82 个**(53 个逐组注入输出 + 29 个其它输出),
   **不可恢复**(git 忽略 / 不在回收站 / `_vss_restore` 无 / 副本无)。
   ⇒ 要删就**逐个列全名**;通配符只允许 `_<你自己的前缀>*`,且先 `-WhatIf`。

2 ✗ **工具拦不住手** —— 仓内已有 `clean-temp.ts`(`--keep` + >40 文件须 `--force`),
   但 `Remove-Item` 绕过**所有**仓内守卫。⇒ 危险动作前先**展示影响面**。

3 ✓ `scripts/clean-temp.ts` 裸跑会删 **342** 个根级文件,**其中 205 个不是你的**。
   ⇒ 先 `--dry-run`。阈值按**文件个数**(342 个只占 2.26 MB,
     大头 `_vss_restore` 44 MB 已被跳过 ⇒ 按字节设阈值会漏掉危险)。
```

---

## 六、★★★ 接手必读:六条已确立的**判据纪律**

这六条是 47 节陷阱库的**可执行摘要**。违反它们会产出"看起来严谨的错"。

```
1 ★★ **harness 是 throw 式** —— `shared/testing/harness.ts:28` 的 `ok()`、
   `:162` 的 `eq()` 都是 `throw new Error(...)`。
   ⇒ **一条断言失败即中断整个函数体,其后断言从未执行**。
   ⇒ 后果:凡"某断言被遮蔽"与"某断言没牙"**不可区分**,
     除非你用 **纯求值判据** `∃v : prot(v)=true ∧ mask(v)=false`。
   ⇒ ⚠️ 「去掉遮蔽者后它变红」那一格是**必要但不充分**的
     (它还有第二种成因:顺序中断)。

2 ★★ **「全绿」没有绝对含义,必须附「用什么手段测的」+「看不见什么」**
   实测:同一份代码**零改动** —— 25 条常量注入看见 **13** 处遮蔽,
   225 条变异看见 **42** 处(**3.2 倍**)。
   ⇒ 「能看见多少取决于手段」。⇒ 任何"N/N 通过"都要附手段口径;
     若是下界,**必须写"下界"**。

3 ★★ **若一个计数里混杂着相反的动作,就必须分列**
   实例:工具报"零信息 8 条",其中 2 条实为**关系守卫**
   (`INVENTORY_SLOTS >= TOTAL_ITEM_COUNT` 这类,守**两个量的关系**)——
   删掉会丢真守卫 ⇒ 动作**相反** ⇒ 必须分列并**显式写"不要删"**。

4 ★★ **「我不知道」必须是一个独立且被计数的类别**
   `else { clean++ }` 是"未知折进已知"的标准载体,而默认桶通常是**最大**的那个
   (曾实测 130/158 = 82%)⇒ 错误率最高、可见度最低。
   ⇒ 报数必须给 **可判定 / 无遮蔽 / 仍不可判** 三行 + 合计校验。

5 ★★ **统计门禁输出要先找「权威计数行」,不要关键词计数**
   (见第二节末尾 —— 我在 `/✗/` 上数出 9~14,真值 1)

6 ★★ **报错信息必须区分「症状」与「成因」**
   实例:一条报错说「锚点命中 0 次」,真因是 **CRLF vs LF**
   (`verify.ts` 是 CRLF,`gate-selfcheck.ts` 是 LF,`core.autocrlf=true`)
   ⇒ 锚点在文件里,只是换行不同。而报错的名字指向**已有答案**的方向
   ⇒ 修的人会去修错地方。
```

**另有两条结构性纪律**:
```
7 **同一范围不要写在两处** —— 实测:7 个判据的"跳过目录"列表,
  **只有 1 个**含 `_probe_sandbox`(6/7 缺)⇒ 扫副本 ⇒ 报 3 个 BOM 假红。
  ⇒ 已建 `scripts/scan-scope.ts` 作**唯一事实源**(已接 4 个,
    `verify.ts` / `gate-selfcheck.ts` **尚未接完**)。
8 **自省式判据(去活数据里取参数)带回新失效模式**:
  取不到 ⇒ 退化成空操作 ⇒ **恒绿**。
  ⇒ 必须显式区分"有意不改"与"解析失败",并让**后者报错**。
```

---

## 七、当前未完成的活(按优先级)

### 7.1 未提交的改动(4 改 + 1 新,都是队友的,已验过)

| 文件 | 内容 | 状态 |
|:---|:---|:---|
| `scripts/count-audit.ts` | 新增 `EXPECTED_TRUTH_KEYS` + 两组断言 | ★ **我已注入验证有牙**(见下) |
| `scripts/orphan-audit.ts` | 接 `scan-scope.ts` | ✓ |
| `scripts/assertion-order-audit.ts` | **新文件** 49965 字节(net-persist 的普查器) | ✓ 形态合规(只读/不进退出码) |
| `docs/TASK-85-us2-wiring-plan.md` | +124 行 | |
| `docs/TASK-89-terrain-injection-review.md` | +235 行(983 行) | |

**★ 我对 `count-audit` 两组断言的注入验证结果(在副本内跑,生产零写入)**:
```
基线            : exit 0
注入 A 改 `TAUT_SUSPECT_EXEMPT` 名(5 处)
                : exit **1** · "★ 正解缺失:1 个应有的 TRUTH 键解析失败"
                  ✓ 断言 #2 有牙(防"改个声明名 ⇒ 静默恒绿,永远绿")
注入 B README 自称改错(白名单 5 → 4)
                : exit **1** · "★ 陈旧 README.md:169 自称 4 (正解 5)"
                  ✓ 断言 #1 有牙
⇒ 两组都成立 ⇒ **可进退出码**(那是 Lead 的写域,尚未接)
```

### 7.2 待裁决(卡在 Lead 手里,接手者需要知道)

| # | 事项 | 现状 |
|:---|:---|:---|
| **U1** | **WASD 语义** —— 三方案(甲保持现状 / 乙驱角色 / 丙点击移动) | ★ **已停在你这里**:完整代价对比在 `docs/TASK-83-wasd-three-options.md`(含横向对比表 L180-193)。**未选**。 |
| U2 | `maxHp` 以谁为准(`vitals` 常量 vs `progression` 等级派生) | 未裁,影响"温泉 +30% 上限"接在哪 |
| U3 | `room.PlayerState.level` **无写者** ⇒ 删字段还是补写者 | 未裁 |
| U4 | 8 个交集字段的同步方向(单向投影 vs 双向) | 未裁 |
| U5 | W1 的钳加在 `revive` 侧还是 `vitals` 侧(⚠️ 两侧都加会重演"两份实现") | 未裁 |
| U6 | `wearing` 攻击力放大是否需要上限(现 5.43×,而 `dodge/crit` 都有 `MAX_*`) | 未裁 |
| U7 | `comboMul` 是否改签名(接受连段序号而非倍率) | 未裁 |
| U8 | 装饰器修法:构建步骤 vs 零依赖替身(影响 `schema.colyseus.ts` 存废) | 未裁 |

**另有 8 条已裁但未实施** 的 U 项(台账内标 `已闭 U6/U7/...`),以及 5 处**代码内**未决(见 `docs/ARCH-GAPS.md` 的「未决」节)。

### 7.3 架构级缺口(三层,全部有实测证据 —— **不是新发现**)

```
第一层 容器层     : `room` 不认识 `sim`(US2 接线**已通**,39 帧端到端;
                    `RoomRuntime` 不知道 `WorldSim`)
第二层 动作执行层 : `RoomAction` **定义了 22 个**,已接 **0 个**
                    ⇒ 「授权」存在、「执行」不存在,而且**失败模式是静默的**
                    (`action` 消息的成功分支是空的)
第三层 入口可跑性 : `room.colyseus.ts` 导入 `schema.colyseus.ts`(44 装饰器),
                    **零导入者、不可跑**
★ 另有:第四层(「玩家 → 怪物」伤害方向**整条不存在**)
       第五层(US2 的真问题是"先裁决唯一所有者" —— 玩家状态有**两套互不相识的实例**)
       第六层(反作弊失明点:一条报文可让两条检查同时失效)
⇒ 全在 `docs/ARCH-GAPS.md`(90 KB)与 `docs/CHANGE_REQUESTS.md`。
```

### 7.4 已认定但**本轮不做**的项目

| 项目 | 为什么不做 | 在哪 |
|:---|:---|:---|
| `_tp89_inject.ts` 重构(665 行 `main()`) | 53 个用例 = **53 次生产写入**,代价与收益(中间凭证)不成比例 | `CR-26` |
| harness 改为「收集失败后跑完块」 | 改语义 ⇒ **全部 1526 条基线失效** ⇒ 必须单独立项 | 已裁定 |
| WS 分裂帧 / ping-pong / 背压 / 并发连接 | 未测(**已派活**给 net-persist) | `CHANGE_REQUESTS.md` 尾部 |
| `doc-line-audit.ts` 扩到 `.ts`(实测缺口 ~208 处无守卫锚点) | 未立项 | 提案 |

---

## 八、九名队友的分工(全部 `inactive`,写域互不重叠)

| 队友 | 写域 | 子系统 |
|:---|:---|:---|
| lead | `docs/PROGRESS.md` `LEAD-PLAN.md` `README.md` `scripts/verify.ts` `probe-kit.ts` `scan-scope.ts` 等门禁器件 | 统筹 |
| terrain-physicist | `server/src/{world,physics}/**` · `tests/WS-01/02/03/WS-FND-01/02` | WS-01/02 地形 · 物理 |
| build-wiring | `server/src/build/**` · `scripts/orphan-audit.ts` · `docs/WS-08-wiring.md` | WS-03/08 建造 · 电路 |
| mob-boss-ai | `server/src/{party,prank,social,coop,mobs,bosses}/**` · `shared/types/wire.ts` | WS-04/05 |
| alchemy-core | `server/src/alchemy/**` · `tests/WS-06` | WS-06 炼金炉 |
| net-persist | `server/src/index.ts` · `server/src/net/**` · `tests/WS-FND-13/14` | WS-07 |
| client-stage | `client/src/net/*` `boot.ts` `main.ts` · `tests/WS-09/12/13` | WS-09 |
| combat-progress | `server/src/combat/{vitals,revive,progression}.ts` · `tests/WS-10/11` | WS-10 |
| coop-party | WS-11 派对模块 | WS-11 |

```
⚠️ `tests/WS-FND-07.test.ts` **无主**(初始作者 kingzzoov-ctrl)。
⚠️ `shared/testing/harness.ts` 与 `server/src/sim/world_sim.ts` 是**承重文件**:
   现有方法体的改动需 **Lead 授权**。
```

---

## 九、接手第一小时建议做的事

```bash
# 1 确认基线(约 4 分钟)
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck
#   期望 exit 0 / 行首 ✗ 0 项 / 自检 29/29

# 2 读三份文档(按顺序)
#   docs/LEAD-PLAN.md      ← 当前计划与快照(先读这个)
#   docs/PROGRESS.md       ← 陷阱库 47 节,只读你需要的那几节,别通读
#   docs/COMPLETION-CRITERIA.md ← ★ 为什么"门禁全绿 ≠ 项目完成"
#                                  (内含 6 条"同一时刻全部为真"的事实)

# 3 看还有多少活
node scripts/backlog.ts            # 133 条 / 108 未关闭 / 0 阻塞
node scripts/count-audit.ts        # 数字自称与实测是否一致

# 4 ★ 动手前先读第六节那六条纪律 —— 它们防的是"看起来严谨的错"
```

### 查验本文是否被篡改(sha256 前 12 位)

```
cb4e45d10156  README.md
2a40385afd64  docs/PROGRESS.md
42728ccb0f17  docs/LEAD-PLAN.md
1a085febc966  docs/ARCH-GAPS.md
0856298d0fb4  docs/CHANGE_REQUESTS.md
76369e63097d  docs/COMPLETION-CRITERIA.md
6c70cf13ebf7  docs/TASK-83-wasd-three-options.md
```

---

## 十、如实列出:**本文不能证明的**

```
1 上面所有数字是 **2026-11-14 本次实测**;文档改动会移位(尤其 `README.md` 里的
  「可达性 88/98」)。
  ⇒ ★ 新增 `docs/*.md` 会让「非 WS 文档」计数变化 —— 本文落盘时实测 **61** 份
    (门禁 `[文档结构]` 是**第一个**因此变化的数字,它只告警、不拦截;
     README 里**没有**这个数的自称,故无需同步)。
2 可达性 **88/98** 是**当前**口径;新增 `server/src`/`client/src`/`shared` 文件会改变分母
3 「0 阻塞」指台账**自述**无阻塞项,**不等于**没有阻塞
4 第三层「入口不可跑」我**没有**修 —— 那是缺口的**描述**,不是已修
5 队友 8 人全部 `inactive` ⇒ **没有任何活正在推进**;第七节列的是"待做",不是"在做"
6 我在本次移交前**未提交**队友那 5 处改动(给接手者决定权,避免覆盖他的判断)
7 根目录 337 个 `_` 临时文件我**一个都没删**(按纪律,等判据齐全再清)
```
