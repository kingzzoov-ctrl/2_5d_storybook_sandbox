# 项目移交包 —— 2.5D 绘本风多人沙盒

> ### 本文性质与有效期
>
> - **性质:当前状态(移交包)。** 本文是给下一位负责人的入口文档:**描述今天的事实**,不是历史记录。
> - **有效期:** 下面带锚点的数字(§一 的 `.ts` 计数 / 套件数 / 装饰器例外、§三 的用例与门禁读数、
>   §九 的 sha256 表)**全部由 `node scripts/sync-docs.ts --write` 生成,勿手改** ——
>   它们是 `README.md` 同一份测量源的产物,比对入口是 `node scripts/sync-docs.ts --check`
>   (`verify.ts::verifyDocsNumbers()` 调它)。判据:改坏任何一个数,`--check` 立刻红。
> - **不受锚点保护的部分:** 散文里的裸数字(例如 `工具` / `文档` / `门禁行数` 这几行)**仍可能陈旧**
>   —— `sync-docs` 的「手工实测数字」扫描会把它们按 `文件:行` 列出来(告警,不改盘)。
>   看到告警:要么加锚点,要么改成引命令。
> - **本文与旧文档冲突时:** 数字类以 `sync-docs --check` 为准,状态类以
>   `docs/AUDIT-R-ITEMS.md` / `docs/WIRING-LEDGER.md`(它们各自写明状态源)为准。
> **本文是移交给下一位负责人/下一个会话的入口文档。**
> 生成时间:2026-11-14 · 基线提交 `bb481e4` · **移交时** HEAD `8678abf`(分支 `main`)
> ⚠️ 上面那个 HEAD 是**移交当时的快照**,不是"现在"(本文件此后又更新过多轮)——
>    要现在的:`git rev-parse HEAD`。**本文件的其余数字都已按最新实测更新,且其中
>    可机检的那些已接入 `verify.ts::verifyHandoverNumbers`(改坏就红)。**
> ★ **2026-11-14 同日「接手者第一轮」的改动尚未提交** —— 清单见本文 **§十一**
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
| 层 | 服务端 `server/src` **101** `.ts` · 客户端 `client/src` **52** · 共享 `shared` **15** ⇒ **生产 .ts 合计 168** |
| 测试 | `tests/*.test.ts` **187** 个套件 |
| 工具 | `scripts/*.ts`(个数**不在这里手抄**:读 README「全仓规模」行的「脚本 N」,由 `sync-docs --write` 写回;口径 = `scripts/` 下全部 `.ts`) |
| 文档 | `docs/` **89** 个 `.md` + 3 个 `.png` = 92 文件 / **3.13 MB** |
| 门禁 | `scripts/verify.ts`(8241 行) |

### ★ 三条不许违反的语法约束(这不是风格问题,是能不能跑的问题)

```
✗ enum            ✗ 构造函数参数属性      ✗ namespace       ✗ 装饰器
✗ 相对导入不写 `.ts` 后缀(node 原生 ESM 要求显式扩展名)
✓ 只允许「可擦除语法(type-erasure only)」
⇒ 门禁有一节专门查这个(「可擦除语法」),全绿
⇒ ✅ **零例外**(2026-11-14 达成):`schema.colyseus.ts` 的 44 处 `@type` 已全部改成
  官方 `defineTypes`,门禁的装饰器例外白名单**已清空**(`DECORATOR_EXEMPT` = ∅)
  ⇒ 装饰器例外 **0** 处。
```

---

## 二、怎么跑(验收命令)

```bash
cd 2_5d_sandbox

# ★ 完整验收(三道闸已默认拦截;旧 --strict-* 全是 no-op —— 理由见下)
node scripts/verify.ts --all

# 常用单跑
node scripts/verify.ts --all          # 全部测试 + 门禁(默认真跑门禁自检,约 180s)
node scripts/gate-selfcheck.ts        # 门禁自检(用例数见其输出,约 3 分钟)
node tests/WS-10.test.ts              # 单个套件
npm run sim                           # 服务端模拟 demo
npm run build:client                  # 客户端构建
```

### ⚠️ 那三个 `--strict-*` **已并入默认口径**(旧参数 = no-op)

```
从 `w34`(commit `78723b4`)起:**可达性 / 同义反复 / 入口执行层**三道闸**默认拦截**,
门禁自检也默认真跑 ⇒ 裸 `node scripts/verify.ts --all` 就是完整验收。
旧参数 `--strict-reach` / `--strict-taut` / `--strict-inert` / `--strict-selfcheck`
保留为 **no-op**(历史命令行照抄仍能跑);要降级成「只告警」必须**显式** `--lenient`,
且汇总行会写明「--lenient 生效」。

⚠️ 升级前(2026-11-12 实测)这里写过相反的话:「裸跑也会印全部通过并返回 0」——
那句在当时是真的,现在是**假的**;别把 `--lenient` 抄进任何验收命令。
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
node scripts/verify.ts --all                     # 旧 --strict-* 已并入默认(no-op;--lenient 才降级)
  ⇒ **exit 0 / 行首 ✗ 0 项**(含自检;全量耗时**分钟级**,本机实测两次 249s / 271s —— 秒数别当基准)
```

| 指标 | 值 | 说明 |
|:---|:---|:---|
| 用例 | **3133 条 / 187 套件** | WS 1014 条 / 14 套件 · 基座 FND 2119 条 / 173 套件(2026-11-19 第六轮:FND 号段已到 **121**;2026-11-19 第七轮增至 **127**(122 协议出口 / 123 Boss 派对投影 / 124 战斗语义 / 125 系统链 / 126 客户端链 / 127 覆盖缺口) —— 61 协同浇水 e2e / 62 世界重置重建 / 63 ackedSeq e2e / 64 世界钟喂进电路 / 65 US2 跨进程 / 66 冻结层解锁 / 71 战斗深度 / 72 归档回滚 / 73 客户端表现 / 74 门禁硬化 / 75 房间系统 / 76 测试欠账 / 77 接线系统 / 78 归档实测 / 86 鉴权令牌 / 87 物品来源 / 88 线上边界 / 89 客户端顶点色 / 90 门禁真话 / 91 战斗与购买闸(视线/定身/重置上限/幂等) / 92 动作闸(箱子距离/放件扣件) / 93 元素抗性接线 / 94 存档与机械不变量 / 95 门禁与边界 / 96 房间幂等与 LOD / 97 房间元素语义 / 98 击退与掉落 / 99 双侧结构化 / 100 坏档分类与流体预算延后 / 101 LOD 合并语义裁决 / 102 击杀掉落与退役 / 103 门禁自证 / 104 归档完整性 / 105 动作侧账 / 106 连接生命周期 / 107 幂等硬化 / 108 Boss 与派对边界 / 109 WorldSim 不变量(扣料回滚 / 炉火可逆 / afkRuns / 派对台账) / 110 蓝图与布线边界(游程上界 / overlap 口径 / 配方层 / 接力选项 / 审计硬编码) / 111 战斗数值边界(元素矩阵 / 有限性门 / 词条池 / hpFlat / 泡泡窗口 / shieldMax) / 112 门禁静默跳过与四组旧判据 / 113 客户端预测链(参数传导 / 渲染消费 / 上行 z / 重连复位 / 单调门) / 114 电路层生产者口径(40 件生产者台账 / 环境注入 / race 停表 / 投影 setSt / 无电路装载) / 115 宿主契约与回执形状(inventoryDetailOf 空桩 / effect 形状 / ActionPayload / WorldSaveHost / partyMode) / 116 加固反向复查(快照 RLE 上界 / 屋顶值域 / 缺口语义 / CHECK 合取 / trim 编码 / setCell 同源) / 117 判据元审计(恒真槽位 / 剥注释重跑 / 下限钉实测) / 118 战斗接线(数值 / 词条 / 幽灵 / 飘字) / 119 系统喂料(牧场 / 温室 / 分拣) / 120 派对与急单接线(哨台开局 / 三个计分发射点 / 结算与奖励 / 播报) / 121 报文与客户端接线(ROOM 字段 / 派对 HUD / 预测链)。第二批 4 个套件共 +41 条:91/92/93/94 = 10/10/6/15;第三批 2 个套件共 +21 条:95/96 = 10/11;第四批 3 个套件共 +28 条:97/98/99 = 6/14/8;第五批 2 个套件共 +16 条:100/101 = 8/8;第六批 4 个套件共 +42 条:102/103/104/105 = 8/13/12/9;第七批 3 个套件 + 1 处补正共 +31 条:106/107/108 = 13/9/6,且 98 由 14 增到 17;第八批 4 个套件共 +42 条:109/110/111/112 = 8/9/11/14;第九批 5 个套件共 +49 条:113/114/115/116/117 = 13/13/9/8/6;第十批 4 个套件共 +48 条:118/119/120/121 = 12/8/15/13;第十一批 6 个套件共 +65 条:122/123/124/125/126/127 = 12/13/10/11/13/6;2026-11-19 第七轮实测重钉 2429/130 → 2494/136;第八轮实测重钉 **2578/141**(基座 1564/127,号段已到 **132** —— 128 不变量 / 129 库存完整性 / 130 物理不变量 / 131 生命周期原子性 / 132 协议边界)) |
| 门禁自检 | **29/29** | 2026-11-14:28→29 修 T37 锚点 bug → 加 T38×2 成 31 → 移除 1 条过期用例成 30 → **2026-11-22(w79):两条 N1 合并成一条**(跑的是同一条 `--integration`、同一处(没有)变异 ⇒ 删的是重复**执行**,不是任何一条断言)成 **29** |
| 跨 WS 集成 | 38/38 | |
| 冻结层不变量 | 17 | |
| 生产可达性 | **158 / 168**(不可达 10 = 白名单 10 + 未登记 0) | 欠账构成:等客户端入口 0 / 等编排层接线 1 / 等服务端机制 1 / 等客户端机制 1 / 等裁决 0(2026-11-19 第六轮:`prank/immunity.ts` 与 `prank/toys.ts` 已经 `party/actions.ts` 值导入可达 ⇒ 白名单 12→10、欠账分母 12→10;第八轮:`server/src/invariants.ts` 以 gate-only 入白名单 10→11、非欠账 6→7) |
| 同义反复候选 | **0 条**(白名单 0) | ★ 2026-11-25 新增 2 条候选**已当场归零**(`WS-FND-172-anticheat-clock::SPEED_WINDOW_TICKS` 期望侧改字面量 20 / `WS-FND-174-cross-clock::SLEEP_DURATION_SEC` 期望侧改字面量 60,共两处;常量全部留在 actual 侧);历史:34 → 9 → 5 → **0**(2026-11-17 最后两条期望值改字面量 + 常量锚点) |
| 类型检查基线 | **257 条 / 指纹 126** | 2026-11-14:267/132 → 265/131 → 261/129(`TS2304` 归零后继续下降);2026-11-18 第四轮实测 **260**(`scripts/data-conformance.ts` 的 1 条 `TS2367` 已修);2026-11-19 第五轮实测 **259**(`tests/WS-FND-10-restore.test.ts` 的 1 条 `TS2339` 已修);2026-11-19 第六轮实测 **257 / 126** ⇒ 比锁 261 **好 4 条**。★ 2026-11-19 第七轮**已按实测重钉**(`node scripts/typecheck-baseline-audit.ts --update`)⇒ 锁文件 = 257 条 / 126 指纹。⚠️ 重钉理由(不是「抬水位」):本锁指纹**含归一化消息文本**(不含行号/绝对路径),而 tsc 打印**字面量联合的成员顺序**按字面量类型 id 排 ⇒ 新增文件即让同一处错误的文本漂移：实测 `tests/WS-FND-08.test.ts` 的 1 条 `TS2339` 从 `GATE`|`LLM`|`ROLL`|`INVENTORY`漂成 `INVENTORY`|`GATE`|`LLM`|`ROLL`,而总错误数**下降**(261→257)⇒ 那条「新增」是文本漂移、不是回归。根治要让 `normalizeMsg` 对联合成员排序(不在本轮写域)。 |
| 未决台账 | **133 条**(0 未关闭 / **0 阻塞** / 133 已关闭) | 2026-11-17 关闭判据收紧(关闭 = 标记 ∧ 可查证据)⇒ 37 条仅标记无据的退回;2026-11-18 全部补齐证据 ⇒ 133/133 有据关闭 |
| PROGRESS 陷阱 | **51 节 / 94..144** | 严格递增 ✓ / 无缺号 ✓ / 无 BOM ✓ / 455146 字节 |


> ✅ **这张表的 9 行数字已全部接入门禁**(2026-11-14,`verify.ts::verifyHandoverNumbers()`)——
> 与 README 用**同一台**校验器 `makeNumberCheck`(两份实现迟早分叉,故只留一份)。
> 每一行都做过注入验证:改成错值 ⇒ 精确报红;还原后整文件锚与注入前相同。
> ⚠️ 在此之前它是**手抄且零校验**的,并因此腐烂过两次(外部审计两次抓到同类陈旧:
> `1526 条 / 28 套件`→`1534/29`、`265 条 / 指纹 131`→`261/129`、
> `47 节 / 94..140 / 453550 字节`→`51 节 / 94..144 / 463346 字节`)。
> ★ 教训不是"抄错了",而是:**手抄的数字不会因为被抄进表里就变成事实**。
> ⇒ 现在两张数字表(本节 §三、§九 的 sha256 表)都由 `node scripts/verify.ts --docs`
>   当场重算并比对;局部口径下算不出的行会明说「**未校验**(不是通过)」,不会静默变绿。
> ⚠️ **「用例」那行括注里的条数与号段是「当轮快照」,不是现值**:`FND` 号段的现值只能现算
> (最大号 = `ls tests/WS-FND-*.test.ts`;条数看 `node scripts/verify.ts --all` 的「用例汇总」行)。
> 本行只留历史 —— 号段走过 **132** 之后**不再回填到这里**,逐轮索引见 `docs/AUDIT-W34.md`。
**可达性 144/154 的 10 条不可达**:4 条欠账 + 6 条非欠账(gate-only 4 + 差集 2)。

> ★ **2026-11-19 第六轮收尾**:本节「用例 / 套件」那一行**已按全绿后的当场读数覆盖**。
> ```
> 第六轮中途(t=0)         :126 套件 / 2381 用例 / 0 个非零退出
> 中途并发写盘后           :128 套件 / 2402 用例 / **6 个套件非零退出**
>   WS-04 · WS-FND-90 · WS-FND-99 · WS-FND-103 · WS-FND-109 · WS-FND-117
>   (成因是同一时刻的接线未收尾:WS-04 的「feedPet 生产调用点 0」实测变 1、
>    FND-99 的合法镜像表少了新增的 `WiringStatus`、FND-90 的 orphan 清单多 1 个文件)
> 收尾(12+4 套件落盘 + 上述 6 处修完):130 套件 / **2429 用例** / 0 个非零退出
> ```
> ⇒ 于是本表写成 **2429 / 130**,与 `verify.ts --all` 的当场输出逐字一致。
> ⚠️ 这条历程值得留着:上一版**刻意不写** 2402 是对的 —— 那次读数里 6 个套件是红的,
>    把红读数写进「N/N ✅」等于把 6 个红标成绿。**改这一行的前提是「全绿」,不是「有数」。**
> ⇒ 逐符号的「有实现、有判据、没接进生产路径」台账:`docs/WIRING-LEDGER.md`(34 行);
>    定性结论:`docs/AUDIT-W34.md §13` —— **全绿 ≠ 可用**。
> ★ **2026-11-25 时间口径更正(D-26)**:32Hz **不是**「落在定时器粒度网格上 ⇒ 两边一致」——
>   本机**真实 WS 循环**实测 `tickMean = 34.6ms` / `28.9fps` ⇒ **倍率 ≈ 1.11**(不是 1);
>   `play` / `soak` 启动打印是唯一权威读数;**Linux / 生产部署必须在目标机实测后回填**。
>   详见 `docs/DECISIONS.md` D-26 的「实测」与「顺带」两条。

---

## 四、目录结构与各目录职责

```
2_5d_sandbox/
├── README.md            唯一入口 · 所有「N/N」自称都在这里(受门禁交叉校验)
├── package.json         28 个 npm scripts · 零运行时依赖
├── tsconfig.json  vite.config.ts
├── server/src/          81 .ts —— 服务端(权威侧)
│   ├── sim/             世界模拟主体(3):world_sim.ts ⚠️ 承重文件
│   ├── world/  physics/ 地形 / 32Hz 刚体
│   ├── build/  wiring/  建造 · 接线层(3)
│   ├── combat/  vitals / revive / progression(7)
│   ├── mobs/  bosses/   生物 AI / Boss(7 + 4)
│   ├── alchemy/  coop/  party/  prank/  social/  各子系统
│   ├── net/             网络层(25)—— ws_server.ts · room.ts · room.colyseus.ts ...
│   ├── content/  db/  events/  rooms/  基础设施
├── client/src/          34 .ts —— 客户端(渲染 + 预测)
│   ├── stage/(10) three/(4) ui/(7) net/(11)
├── shared/              10 .ts —— 两端共享契约
│   ├── types/           tile · entities · physics · wire · alchemy
│   ├── constants/       items · mobs · bosses
│   ├── net/delta.ts     协议编解码
│   └── testing/harness.ts  ★ 测试基座(见第六节,必须理解它是 **throw 式**)
├── tests/               66 .test.ts
├── scripts/             35 .ts —— 门禁与审计器
├── docs/                83 .md + 3 .png / 2.83 MB
│   ├── PROGRESS.md      443 KB ★ 陷阱库(全仓最重要的单份文档)
│   ├── CHANGE_REQUESTS.md 187 KB · ARCH-GAPS.md 90 KB
│   ├── LEAD-PLAN.md     当前计划与快照 ★ 接手先读这份 + PROGRESS
│   ├── WS-01..14-*.md   14 份子系统设计(每份 ≥10 节 / ≥2000 字符,门禁强制)
│   └── 其余 65 份        任务报告 / 审计 / 契约
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
  ⇒ 已建 `scripts/scan-scope.ts` 作**唯一事实源**。
  ★ **已接完(2026-11-14 同日,接手者)**:7/7 —— 新接入 `verify.ts`(两处自写表:
    `diffSetData` / `checkTempResidue`)、`clean-temp.ts`、`gate-selfcheck.ts`(第 7 份)。
  ⇒ 收口时实测「两份副本**已经发散**」:旧 verify 口径 **347** / 旧 clean-temp 口径 **330**,
    差 **17** 条,全部落在 `_probe_sandbox/`(仓库副本)⇒ 是**假红**而非残留。
  ⇒ 并发现跳过表的**作用域**也会分叉:`build` 被当成"任何层都跳过",而 `server/src/build/`
    是**生产源码**(5 个 .ts)⇒ `diffSetData()` 曾算出 **93**(权威 **98**)。
    ⇒ 已把跳过名分两类 + `shouldSkipDirAtDepth()` 做成唯一入口(见 LEAD-PLAN §7.2.1e)。
8 **自省式判据(去活数据里取参数)带回新失效模式**:
  取不到 ⇒ 退化成空操作 ⇒ **恒绿**。
  ⇒ 必须显式区分"有意不改"与"解析失败",并让**后者报错**。
```

---

## 七、当前未完成的活(按优先级)

### 7.1 工作区状态:**已清空**(移交前由 Lead 逐个复核后提交)

```
git status --short  ⇒  (干净)
未推送提交          ⇒  0
★ 移交前工作区里有 5 处**队友已自验但未提交**的改动,已逐个复核后提交(commit 6db6550):
```

| 文件 | 内容 | 复核结论 |
|:---|:---|:---|
| `scripts/count-audit.ts` | 新增 `EXPECTED_TRUTH_KEYS` + 两组断言 | ★ **Lead 已注入验证有牙** |
| `scripts/orphan-audit.ts` | 接 `scan-scope.ts`(第 5 个落位) | ✓ 行为是超集且更正确 |
| `scripts/assertion-order-audit.ts` | **新文件** 49965 字节(net-persist 的普查器) | ✓ 形态合规(只读 / 不起子进程 / 不进退出码) |
| `docs/TASK-85-us2-wiring-plan.md` | 附录 A(+124 行):三条纪律 + A.3 一般判据 | ✓ |
| `docs/TASK-89-terrain-injection-review.md` | +235 行 → 983 行:13→42 的 3.2 倍对照 | ✓ |

**★ 我对 `count-audit` 两组断言的注入验证(在副本内跑,生产零写入)**:
```
基线                                    : exit 0
注入 A 改 `TAUT_SUSPECT_EXEMPT` 名(5 处)
                                        : exit **1** · "★ 正解缺失:1 个应有的 TRUTH 键解析失败"
                                          ✓ 断言 #2 有牙(防"改个声明名 ⇒ 静默恒绿,永远绿")
注入 B README.md:169 自称 白名单 5 → 4
                                        : exit **1** · "★ 陈旧 README.md:169 自称 4 (正解 5)"
                                          ✓ 断言 #1 有牙
⇒ 两组都成立 ⇒ **进链的技术条件已满足**,只差接进 `verify.ts`
  ★ **已接(2026-11-14 同日,接手者)**:`verify.ts` 新增 `checkCountAudit()` + 消费侧三判据
  (汇总行解析不到 / ★陈旧>0 / ★正解缺失 ⇒ 各自 fail),并在 `gate-selfcheck` 补
  **T38-a / T38-b** 两条区分力自检(自检用例数 **29 → 31**)。
  实测两条注入都命中预期消息 ⇒ **这条链有牙,且已被机器钉住**。
```
★ **我自己的量具打偏过一次**:第一次注入 B 我改的是「同义反复候选 5 条」,
而检测器读的是「…**白名单** 5 条」后那个数 ⇒ 报出"未触发"的**假阴性**。
⇒ 这是我的注入打偏,不是断言没生效。⇒ 与陷阱 136/137 同族。

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
第一层 容器层     : ✅ **已修**(2026-11-14):A 路(`server/src/index.ts` 的
                    `assemble()`)与 B 路(`room.colyseus.ts` 的 `onCreate()`)
                    **两条路现在都有世界** —— B 路的 `host` 由
                    `resolveRoomHost(this.deps)` 决定,无注入时自己 `createHost()`,
                    不再恒为 null。
                    ⚠️ 但**仍是两条路**(各自构造一份 `RoomRuntime`),没有合并 ——
                    `tests/WS-FND-12-wiring-paths.test.ts` 同时钉住这两件事
第二层 动作执行层 : `RoomAction` 定义了 22 个,已接 **5 个**(2026-11-14 接线)
                    ⇒ 其余 17 个**显式**返回 `kind:'NOT_IMPLEMENTED'` ——
                    「静默成功」这一类已消灭(成功/失败都有回执);但**功能确实没有**
第三层 入口可跑性 : ✅ **已修**(2026-11-14):44 处装饰器改 `defineTypes`、
                    `Client` 改 type-only、`registerHandlers()` 补调用点
                    ⇒ `node -e "import('./server/src/net/room.colyseus.ts')"` ⇒ `LOADED`
★ 另有:第四层(「玩家 → 怪物」伤害方向**整条不存在**)
       第五层(US2 的真问题是"先裁决唯一所有者" —— 玩家状态有**两套互不相识的实例**)
       第六层(反作弊失明点:一条报文可让两条检查同时失效)★ 已修,见 ARCH-GAPS 状态订正
⇒ 全在 `docs/ARCH-GAPS.md`(90 KB)与 `docs/CHANGE_REQUESTS.md`。
⚠️ **本节是 2026-11-14 早起的分层描述**;上面三层已按同日三轮实测更新
   (§十一 / §十二 + B 路接线)。⇒ 现在**没有**未交付的容器级缺口;
   `room` 与 `sim` 之间已可通(两条路各自通),不再是「不认识」。
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
# 1 确认基线(约 5 分钟)
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck
#   期望 exit 0 / 行首 ✗ 0 项 / 自检 30/30

# 2 读三份文档(按顺序)
#   docs/LEAD-PLAN.md      ← 当前计划与快照(先读这个)
#   docs/PROGRESS.md       ← 陷阱库 47 节,只读你需要的那几节,别通读
#   docs/COMPLETION-CRITERIA.md ← ★ 为什么"门禁全绿 ≠ 项目完成"
#                                  (内含 6 条"同一时刻全部为真"的事实)

# 3 看还有多少活
node scripts/backlog.ts            # 133 条 / 0 未关闭 / 0 阻塞
node scripts/count-audit.ts        # 数字自称与实测是否一致

# 4 ★ 动手前先读第六节那六条纪律 —— 它们防的是"看起来严谨的错"
```

### 查验本文是否被篡改(sha256 前 12 位)

```
08d4debbcf0e  README.md
8009b71b0684  docs/PROGRESS.md
b387930e1082  docs/LEAD-PLAN.md
db1e4e335354  docs/ARCH-GAPS.md
a346f7ad5f9e  docs/CHANGE_REQUESTS.md
c5794ee63fba  docs/COMPLETION-CRITERIA.md
6c70cf13ebf7  docs/TASK-83-wasd-three-options.md
# ★ 本文件(HANDOVER.md)不进表 —— 它自己就是被校验的对象,任何写入都会改变它自己的哈希。
# 口径:**LF 归一后的字节**(= 索引 blob 的字节),**不是**工作区原始字节。
#   本站 `core.autocrlf=true`:索引恒为 LF、而**新克隆会把全部文件检出成 CRLF**;
#   手抄旧表时的工作区是「3 个 CRLF + 4 个 LF」的混合态 ⇒ 旧表 7 个值里有 3 个
#   (README / PROGRESS / CHANGE_REQUESTS)**只在那一台机器的工作区成立**,
#   换个检出即误报「文档已被篡改」—— 那正是这张表要防的结论。
# 复现:`git cat-file blob HEAD:README.md | sha256sum` 取前 12 位(索引恒 LF);
#   或直接跑 `node scripts/verify.ts --docs` —— 该表**已进**门禁
#   (`verify.ts::verifyHandoverHashes()`,2026-11-14 接入,此前 7 个值无人校验)。
# ⚠️ 因此**改完上述任一文档必须重算本表**,否则门禁红。
```

---

## 十、如实列出:**本文不能证明的**

```
1 上面所有数字是 **2026-11-14 本次实测**;文档改动会移位(尤其 `README.md` 里的
  「可达性 91/100」)。
  ⇒ ★ 新增 `docs/*.md` 会让「非 WS 文档」计数变化 —— 本文落盘时实测 **61** 份
    (门禁 `[文档结构]` 是**第一个**因此变化的数字,它只告警、不拦截;
     README 里**没有**这个数的自称,故无需同步)。
2 可达性 **91/100** 是**当前**口径;新增 `server/src`/`client/src`/`shared` 文件会改变分母
  (本轮正是实例:新增 `net/input.ts` + `net/predictor.ts` ⇒ 分母 98 → 100)
3 「0 阻塞」指台账**自述**无阻塞项,**不等于**没有阻塞
4 第三层「入口不可跑」**已修**(2026-11-14,见 §7.3)—— 本行原写「我**没有**修」,已订正;
  ⚠️ 第一层 **也已修**(2026-11-14 同日第三轮):B 路的 `host` 由 `resolveRoomHost` 决定,
  不再恒为 null。⇒ §7.3 的**前三层现在全部已修**;剩下的容器级议题只有第五层
  (玩家状态的「唯一所有者」裁决)。
5 队友 8 人全部 `inactive` ⇒ **没有任何活正在推进**;第七节列的是"待做",不是"在做"
6 ★ 移交前工作区里 5 处**队友已自验未提交**的改动,**已由 Lead 逐个复核后提交**(6db6550)
  ⇒ 复核方式:逐个看 diff + `node --check` + 对 `count-audit` 的两组断言**注入验证**。
  ⇒ ⚠️ 但**报告正文的逐条结论我只核了结论与形态,未逐条复算数字**
    (`TASK-89` 的 983 行、`TASK-85` 附录 A 的 124 行)
7 根目录 337 个 `_` 临时文件我**一个都没删**(按纪律,等判据齐全再清)
 8 ✓ **已核**:新增 `scripts/assertion-order-audit.ts` 后,可达性**仍是 88/98**(当时口径;本轮已变 91/100)
  (`scripts/**` 不计入生产分母)⇒ 该文件无侧效应,分母未变。
```

---

## 十一、★ 2026-11-14「接手者第一轮」:做了什么 / 改了什么 / **没做什么**

> 本节由接手者在移交当日追加。**所有数字都是当场实测的。**
> ⚠️ 这些改动**尚未提交**(工作区改动,未 `git commit` / 未 `git push`)。

### 11.1 做了什么(三件,全部已验收)

```
1 scan-scope.ts 接完:5/7 → **7/7**
  新接入 verify.ts(两处自写表)、clean-temp.ts、gate-selfcheck.ts。
  ⇒ 顺带实测出两处**此前未登记**的判据缺陷:
     · 两份副本**已经发散**:旧 verify 口径 347 / 旧 clean-temp 口径 330,
       差 17,全部落在 _probe_sandbox(假红,不是残留)
     · 跳过表的**作用域**分叉:diffSetData() 曾算出 93(权威 98)
       —— 陷阱 110 第 4 次复发,已记为 PROGRESS 陷阱 141

2 count-audit.ts 的两组断言**接进退出链**(移交时的状态是"只差接")
  新增 verify.ts::checkCountAudit() + 消费侧三判据
  (汇总行解析不到 / ★陈旧>0 / ★正解缺失 ⇒ 各自 fail)。
  ⇒ 区分力自检:gate-selfcheck 新增 T38-a / T38-b ⇒ 自检 **29 → 31**

3 两条架构缺口的**只读调查**落成文档(**未改任何代码**):
  docs/TASK-94-action-layer-landing-plan.md  ← 22 个动作的逐条落点 + 最小切口
  docs/TASK-95-entry-loadability.md          ← 三重阻塞的实测成因 + 两方案代价
```

### 11.2 改动文件清单(逐条)

| 文件 | 改动 | 性质 |
|:---|:---|:---|
| `scripts/scan-scope.ts` | 跳过名**分两类** + `shouldSkipDirAtDepth()` + `walkRepo()` 默认深度感知 | 结构性 |
| `scripts/verify.ts` | 引 scan-scope(两处自写表);`diffSetData` 改深度感知;新增 `checkCountAudit()`;去掉写死的自检用例数 | 结构性 + 接线 |
| `scripts/clean-temp.ts` | 删掉第二份跳过表,改走 `shouldSkipDir` | 结构性 |
| `scripts/gate-selfcheck.ts` | 删掉第 7 份跳过表;新增 T38-a / T38-b | 结构性 + 自检 |
| `docs/LEAD-PLAN.md` | §7.2.1 数字 + 新增 §7.2.1e | 文档 |
| `docs/PROGRESS.md` | 新增陷阱 **141 / 142** ⇒ 现在 **49 节 / 94..142**(无缺号 / 严格递增 / 无 BOM) | 文档 |
| `docs/COMPLETION-CRITERIA.md` | 档 A 的「门禁自检」29/29 → 31/31 + 加「时点快照」声明 | 文档 |
| `docs/HANDOVER.md` | 本文(§一 / §三 / §六 / §7.1 / §九 / §十一) | 文档 |
| `docs/TASK-94-action-layer-landing-plan.md` | **新文件** | 新文档 |
| `docs/TASK-95-entry-loadability.md` | **新文件** | 新文档 |

### 11.3 验收(实测,命令可复跑)

```
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck
  ⇒ exit 0 / 行首 ✗ 0 项
node scripts/gate-selfcheck.ts        ⇒ **30/30**
node scripts/count-audit.ts           ⇒ exit 0(1 处自称,全部与正解一致)
```

### 11.4 ★ 我**没有**做什么(避免下一个人误判)

```
1 没有 commit、没有 push。工作区是脏的 —— 清单见 §11.2。
2 没有实施动作执行层接线(TASK-94 §五给了切口,但那是**下一步**,不是已完成)。
3 没有修入口可加载性(TASK-95 给了两条修法的代价,两者都**未动**)。
4 没有清任何根级 `_*` 临时物 —— 仍是 **330** 个(本轮从 347 修正而来,原因见 §11.1)。
5 没有处理 §7.2 的 8 条待裁决 U 项 —— 仍**未裁**。
6 没有重测 COMPLETION-CRITERIA「档 A」里**除自检外**的历史数字(已在原处加声明)。
7 没有改 `README.md`(它的 hash 未变 ⇒ 你看到的那份自称与移交时逐字节相同)。
   ⚠️ 这**只对那一轮**成立:2026-11-18 第二批改了 `README.md` 的用例行
   (`99/2111 → 103/2152`、基座 `1097/85 → 1138/89`、号段 `90 → 94`),
   §九 的 README 哈希已同步重算(`eae3eaf079d5`)。
```

### 11.5 下一件的建议顺序(基于本轮实测)

```
① TASK-94 §五 那 5 个动作(SET_MEMBER_ROLE / KICK_MEMBER / SET_ROOM_ACCESS /
   SET_PARTY_MODE / CLOSE_ROOM)—— 唯一一批"宿主已存在、不改可达性、可被现有套件覆盖"的。
   ⚠️ 接线会撞红 6 处既有断言(清单在 TASK-94 §五),那是"接线即红"而非回归。
② 但它的**前置**是 §7.3 的第一层与第五层(谁是玩家状态的"唯一所有者")。
   TASK-94 §四 用四条证据说明:handler 作用域里 **WorldSim 不可见**是**被测试钉住的设计**
   (tests/WS-07.test.ts:4364-4378 断言 net 层代码态不得出现 /WorldSim|world_sim/)。
③ 入口可加载性(TASK-95)可与上面并行,但它**单独修不会让玩家按得动** ——
   因为 `registerHandlers()` 全仓 **0 调用点**(TASK-94 §2.3)。
```

---

## 十二、★ 2026-11-14「接手者第二轮」:按 COMPLETION-CRITERIA §六 推进(序 1–5)

> 承接 §十一。本轮**仍未提交**(工作区改动,未 `git commit` / 未 `git push`)。
> 逐条验收见本节末尾的「判据对照」。

### 12.1 数字(实测,取代 §三 的对应行)

```
verify --all --strict-reach --strict-taut --strict-inert
  ⇒ **exit 0 / 行首 ✗ 0 项**(~26s,不含自检)
 生产可达性  88/98 → **91/100**(摘除 prediction.ts 的白名单条目 + 新增 2 个 client 模块)
用例        1526 → **1561 条 / 33 套件**(WS 1014 / 14 套件 · 基座 547 / 19 套件)
入口可加载性 4 个入口实测可加载 · 1 个已登记豁免(原 2 个 —— room.colyseus.ts 的豁免**已摘**)
入口执行层   1 个 verdict 守卫 handler 已登记,其中**成功路径为空 0 个**(原 1 个)
装饰器例外   **0 处**(原 1 处)
WS-10       102/102(断言调用点 942 → 996)
WS-07       215/215(原 212)
新增套件     tests/WS-FND-15-e2e.test.ts(4 条)
```

### 12.2 做了什么

```
G2 幽灵泡泡规则 3/4(§六 序 2)—— **补齐**
   不能移动:world_sim.ts applyPlayerMove 对倒地玩家返回 false + 可判定理由
   不能攻击:world_sim.ts attackMobAuthorized 返回 rejected:'DOWNED'
   四条共用同一真值来源 VitalsSystem.downed;含**健在负对照**;12 条注入全红

G3 生产入口可加载性(§六 序 3)—— **三条阻塞全消除**
   装饰器 44 → 0(改官方 defineTypes;字段仍 44 个,逐名字逐类型不变)
   Client 改 import type(它本就没有运行时值)、Room 改 default 解构
   registerHandlers() 加了**真实调用点**(onCreate);豁免条目已摘
   ⇒ node -e "import('./server/src/net/room.colyseus.ts')" ⇒ **LOADED**

G4 动作执行层(§六 序 3)—— **接线 + 消灭静默成功**
   新增 RoomRuntime.dispatchAction():5 个动作(成员角色/踢人/房间访问/派对模式/关房)
   真的改可观测状态;未实现的 17 个**显式**返回 kind:'NOT_IMPLEMENTED'
   handler 成功侧发 actionResult、失败侧发 reject(带 kind)
   VERDICT_HANDLER_KNOWN 里 action 那条按门禁自身要求**移出并留档**
   判据:WS-07 的 ACT-1/2/3(行为级 + GUEST 负对照 + 零副作用)

G5 第五层 5 条裁决(§六 序 3 的前提)—— **已裁并落 ARCH-GAPS**
   ★ 实测发现其中 **4 条早已在代码里落地并有断言**,只有第 5 条(mobHitDamage)是本轮新做
   ⇒ 记录在 docs/ARCH-GAPS.md 第五层的「★ 裁决记录」节(含每条钉它的断言在哪)

G6 复活宽限「有名」(§六 序 4)—— **补齐缺口**
   机制与主体断言本已存在(94→102);本轮补:逐玩家宽限、读档不发无敌
   注入 iframeSec=0 / invulnSec 缺省改坏 ⇒ 均红

G7 客户端联机层(§六 序 1,关键路径)—— **实测 + 修了一条真断裂**
   ★ 见 COMPLETION-CRITERIA §三 的更新:session.ts **已在生产链上**(不是"不存在")
   ★ 但实测到:服务端用**文本帧**发 welcome,而 session.ts 只收 ArrayBuffer
     ⇒ 握手永不完成(state 恒 connecting)、localPlayerId 恒空、圆心恒 null,
       而**二进制快照照常合入** ⇒ 症状是"画面在动,只是圆心不对"
   ⇒ 已修(文本帧汇入同一 classifyDownlink 分派)+ 端到端判据 WS-FND-15
   ⚠️ prediction.ts **仍未接**:它的卡点在**输入端**(无 InputCmd 生产者),
     而「WASD 是镜头还是角色」是**产品裁决** —— 见 COMPLETION-CRITERIA §三 更新

G8 108 条台账逐条定性(§六 序 5)—— **完成**
   24 已实现未标 / 31 真欠账 / 49 待裁 / **4 我不知道**(独立计数)= **108** ✓
   逐条表:docs/BACKLOG-108-TRIAGE.md(主控抽查 3 组结论,全部成立)
```

### 12.3 本轮改动的文件

```
server/src/combat/vitals.ts        W1 去重(钳制只剩一处)+ mobHitDamage 上界与消毒
server/src/combat/revive.ts        仅注入后逐字节还原,最终与 HEAD 一致
server/src/sim/world_sim.ts        倒地闸 ×2 + 可判定理由字段
server/src/net/room.ts             dispatchAction + ActionPayload/ActionOutcome + classifyFailure
server/src/net/room.colyseus.ts    action handler 接分派 + 双向回执;registerHandlers 调用点;导入修法
server/src/net/schema.colyseus.ts  44 处装饰器 → defineTypes(字段与类型不变)
client/src/net/session.ts          ★ 文本帧分支(修端到端断裂)
scripts/verify.ts                  DECORATOR_EXEMPT 清空;action 移出 VERDICT_HANDLER_KNOWN;去写死数字
scripts/entry_load_exempt.ts       摘 room.colyseus.ts 豁免
scripts/typecheck-baseline.json    基线 265 → 261(只准减不准增,已按脚本建议 --update)
tests/WS-07.test.ts                两条墓碑断言改向 + ACT-1/2/3 + 装饰器口径
tests/WS-10.test.ts                规则 3/4 判据 + 宽限缺口 + 裁决 1/4/5 的判据
tests/WS-FND-09-wiring.test.ts     豁免表断言改向(条数 2 → 1)
tests/WS-FND-12-wiring-paths.test.ts  FND12-8 改向为「必须可加载 + handler 已注册」
tests/WS-FND-15-e2e.test.ts        **新套件**(真客户端模块 ↔ 真服务端)
docs/ARCH-GAPS.md                  第五层裁决记录
docs/COMPLETION-CRITERIA.md        档 B/C 勾选 + §三 更新
docs/BACKLOG-108-TRIAGE.md         **新文档**
docs/PROGRESS.md                   陷阱 143 / 144
```

### 12.4 ★ 本轮**没有**做到(如实)

```
1 档 B 判据「从浏览器走一遍多人流程不撞空操作」—— **仍未达成**。
   已接的动作只有 5/22;其余 17 个**会说话**(NOT_IMPLEMENTED)但**确实没有功能**。
2 档 C 的三项玩法(9 种房间增益 / 料理 buff 消费点 / 三件死道具裁决)——
   按边界 9 **不做**(需 owner 产品裁决)。
3 prediction.ts 仍未接(卡在 WASD 产品裁决)。
4 未 commit / 未 push。
5 真机 FPS 仍未实测(合同「我不打算做的事」已声明)。
```

### 12.5 判据对照(逐条)

```
AC1  全量门禁不退化                ✓(exit 0 / 行首 ✗ 0)
AC2  用例数净增                    ✓ 1555 > 1526
AC3  可达性分母变化已解释          ✓ 共 100(本轮新增 2 个 client 模块);不可达 9 条全部登记
AC4  自检区分力                    ✓ gate-selfcheck **30/30** 全过(--strict-selfcheck 已纳入退出码)
AC5  倒地不可移动                  ✓ 注入即红
AC6  倒地不可攻击                  ✓ 注入即红
AC7  入口可加载                    ✓ LOADED
AC8  装饰器归零                    ✓ 44 → 0,字段 44 不变
AC9  handler 已注册                ✓ ≥2
AC10 豁免已摘                      ✓ 表内只剩 1 条
AC11 动作真的执行                  ✓ ACT-1
AC12 静默成功已消灭                ✓ ACT-2 + handler 双向回执断言
AC13 5 条裁决各有断言              ✓ ARCH-GAPS「★ 裁决记录」逐条注明断言位置
AC14 复活宽限有名                  ✓ 注入即红
AC15 prediction 已接               ✓ WASD→InputCmd→predictStep 在生产链上(WS-FND-16 11/11);上行 sendMove→ws_server `t:'move'`→`applyMove`;⚠️ 相机跟随未做
AC16 端到端往返                    ✓ WS-FND-15 4/4
AC17 台账定性完整                  ✓ 24+31+49+4 = 108
AC18 文档数字/哈希自洽             ✓ 两张表**都已进门禁**:§三 9 行(`verifyHandoverNumbers`)/ §九 7 个哈希(`verifyHandoverHashes`)
AC19 无新增依赖                    ✓ dependencies 仍为空
AC20 冻结层未被动                  ✓ --frozen 17 项全绿;shared/** 与 harness.ts 未改
```

> ⚠️ **上面这 20 行 AC 仍是手写的**,没有任何断言读它们 —— 唯一例外是 AC18 指向的那两张表。
> 其中 AC1 / AC2 / AC4 / AC20 的数值确实由门禁当场算出(exit 码 / 用例数 / 自检 30-30 / 冻结层 17),
> 但**这张表本身不参与比对** ⇒ 它同样会腐烂。
> 读它时以 `node scripts/verify.ts --all` 的当场输出为准;若要把它也接进门禁,
> 照 §三 的做法加 `verifyHandoverNumbers` 的同类行即可(`makeNumberCheck` 已经是通用的)。

---

## 十三、★ 本轮(w59–w61):反作弊水位风暴 —— 定因 / 修复 / **未闭环清单** / 自测指南

### 13.1 一句话

`applyMove` 里的反作弊水位(`PlayerAntiCheatState.lastX/Y/Z`)**只在「包被接受」与「世界拒收」
两条路径的末尾重锚**,而权威刚体在 `applyMove` **之外**也会动(物理沉降 / 击退 / `syncPlayers()`
把刚体投影回 `state.players`)⇒ 投影与水位越走越开 ⇒ 客户端按**投影**起算的下一包被判 TELEPORT
⇒ 走那条**早退分支**(它不重锚)⇒ 漂移只增不减。**修法:把水位锚到「此刻的权威刚体」**
(`room.ts#applyMove` 入口、`snapshotMove` 之前),于是 `dist` 变成「申报位置离它**真实所在**有多远」。

### 13.2 三个提交

| commit | 内容 |
| :--- | :--- |
| `799d2ef` | w59:两条路径**末**重锚(`AntiCheatRoom.syncWatermark`)+ D-26 目标机实测回填。**实测不足** —— 见 13.7 |
| `0654d72` | w60:文档口径订正。32Hz 残留 11 处(PLAY.md 4 / README.md 7)· `WIRING-LEDGER` 两行陈账回正 · README「差集」块**反向改错**回正 · §九 sha256 重钉 |
| `1f39349` | w61:**入口重锚** · `WS-FND-178` 4/6 → **7/7**(新增 `FND178-7` 专守入口重锚;注释掉修点 ⇒ 4/7 有牙)· 夹具 `WALK_STEP` 改成**派生**(`BASE_MOVE_SPEED * DT / √2`) |
| `1ea4fff` | w63:**第三修点** —— 客户端帧计数器折算(`normalizeClientTick`;席位 resume 后计数器重置也要重算基准)· `WS-FND-178` 7/7 → **9/9**(+ `FND178-8` / `FND178-9`)· 46 处 20Hz 注释清扫(18 文件,**行数中性**)· `HANDOVER §13.9`(EOL 运维坑) |

### 13.3 判据(可复跑)

| 量 | 修前 | **仅**产品修后 | 产品修 **+** 夹具保真度修后 | 怎么量 |
| :--- | :--- | :--- | :--- | :--- |
| `acViolations`(2.5 分钟 / 8 客户端) | 512(环饱和) | 13 | **0~1** | 探针(见 13.6) |
| `acDroppedViolations` | 69 | 0 | **0** | 同上 |
| `gapBefore` = \|投影 − 水位\| 峰值 | 2.66 | 0.593 | **0.30** | 同上 |
| 被拒的包 | 全 `worldRejected:false`(AC 误判) | 前 8 条里 7 条转 `worldRejected:true` | **全部** `worldRejected:true` | 同上 |
| `WS-FND-178` | — | 7/7 | **9/9**(+ `FND178-8` 客户端计数器折算、`FND178-9` 席位 resume) | `node tests/WS-FND-178-anticheat-watermark-reanchor.test.ts` |

⚠️ 这三列是**三次不同的跑**,别混读:中间那列**只**有产品修;右列另加了**夹具保真度**修
(`scripts/soak.ts` 的 `WALK_STEP`)。把右列的 0~1 说成「产品修的效果」是错的 —— 22 → 0 那一段
主要是夹具从「每包 94.3% 上界」回到「每包 = 标称单帧位移」的结果。
⚠️ **中间那列的两个数(`13` / `0.593`)只有散文自述,仓内没有 probe 存证** —— 它们与
`room.ts` 同口径 docblock 里写的「**9~22 条**」是同一批跑的不同摘录,别当精确值引用。
要精确值就按 §13.6 第 4 条重跑探针,把 `acViolations` 与 `gapBefore` 峰值贴进本节。

**判据常量一个都没动**:单帧上界 `0.225`、`SPEED_WINDOW_TOLERANCE` 1.25、`TELEPORT_SLACK` 1.6、
`maxDisplacementPerTick(1)` —— 全字未改。**改的只有「判据的参考点」与夹具的步长**(后者是保真度)。

### 13.4 ★★ 未闭环清单(接手者先看这张)

| # | 事项 | 状态 | 证据 / 判据 | 下一步 |
| :--- | :--- | :--- | :--- | :--- |
| O-1 | **服务端自己挪刚体**造成的那一类假阳性:一帧内的真击退 / 碰撞分离 / 落地沉降 把刚体挪走,而客户端那一包是按**它读到投影那一刻**起算的 ⇒ 申报位置必然偏出单帧上界 | **已闭环(w65,留 2 条残余 → O-9)** | 判据 = 三角形不等式 `dist ≤ 额度 + W`(`W` = 服务端自位移):满足即归 **`stale`**(照样拒绝、**不计违规不加分**)。**60 分钟实测 60 → 2**(见 O-2) | 完成。⚠️ 取舍(如实登记):`W` 是**服务端侧可触发**的事件 ⇒ 作弊者靠「挨一下击退」可在**那一个包**上多拿 `W`(击退上界 2 格 / 碰撞分离每帧 ≈0.02 格);单帧上界、窗口均速、Z 值域**一个数都没动** |
| O-2 | 60 分钟长跑的 `acViolations` **不是 0** | **已闭环(w65;w79 复核归零)** | 修前基线:**60 条**(w63 构建)/ **63 条**(w61 构建)、`acDroppedViolations = 0`。**修后同一参数(w65 构建,`soak60e`):`acViolations` 0 → 2、`acStaleRejections` 0 → 54、丢弃 0、世界拒收 0、tick 115769 帧 / 31.1ms / 32.15fps、autosave 121/0、RSS 133.3→204.6 MiB** ⇒ **60 条里 54 条被正确归类**,剩下的 2 条另有成因(→ **O-9**)。**w79 第三轮复核(`soak60f`,w76/w78 构建,17:59→18:59 CST):`acViolations` 0 → **0**、`acStaleRejections` 0 → **65**、丢弃 0、世界拒收 0、tick 115756 帧 / 31.11ms / 32.15fps、autosave 121/0、RSS 132.4→201.8 MiB** ⇒ 假阳性**归零**(60e 里那 2 条 O-9 本轮未复现) | **闭环**。判据不再只看一列:`acViolations`(真违规)与 `acStaleRejections`(服务端自位移)**分开读** |
| O-3 | `WIRING-LEDGER` 其余 **34 行**的逐符号状态**没有**复核 | **已闭环(w73:按符号复算)** | 复算口径 = 台账 §1(生产侧出现点 / 排除定义文件 / 不算 `import type`),对表体 **36 行**逐符号数命中。**结果:35 行对得上,1 行依据写错**(`R6-CBT-5`:旧文写「`cookSoup` 1 处(`net/actions/craft.ts`)」—— 真调用在**同模块** `cooking.ts#tryCook`:585,`craft.ts` 只在一句注释里提过 ⇒ 已订正)。★ 两条口径课:①`*/wiring_ledger.ts` 是**台账源文件**(点名不是消费)必须排除;②`PARTY-S1..S4` 的命中读数是 **0**,那是**同文件接线**(`modes.ts` 内 `settleHook = () => settleBridgeRun(run)`)被「排除定义文件」规则吃掉 —— 不是陈账 | 完成。复算脚本在 scratch(`_o3_check.mjs`,可重跑);**表体仍无按符号的门禁**(§3 的三条路不含「逐符号复检」),要不要把它固化成 `scripts/` 下的审计脚本由 owner 定 |
| O-4 | 代码注释里的 20Hz 残留 | **已闭环(w75)** | 三轮合计:w59–w64 清 **46 + 17 = 63 处**(18 个文件,**行数中性**);w75 把**剩下的 39 处逐条分类** ⇒ 只有 **3 处**是「现在时写错值」—— `anticheat.ts` 的分母耦合段(`DT = 50ms` / 「窗口跨的 20 帧」)· `db/schema.sql:25` 的「20Hz 内存态」· `room.ts:1793` 的「供 20Hz 差分编码复用」—— **已改**(行数中性,已复核 LF);其余 36 处是**正当对照 / 历史实测 / 手册原文 / 第三方事实** ⇒ **不改才是对的** | 完成。⚠️ 三条**刻意不改**并附理由:`shared/types/wire.ts:2` 与 `net/schema.ts:2` 的「WS-07 · 20Hz 状态协议」是**表格标签**(`verify.ts:7686/7698` 按原文匹配 README 行);`shared/net/delta.ts:1155` 的带宽模型假设 20Hz 属**未重标定**(D 类,已登记);`shared/contracts/FREEZE.md` 是**冻结层文档**,改措辞要 owner 定 |
| O-5 | `sync-docs --write` 在**并发负载**下不可靠 | **已闭环(w74:已核,**不是**缺陷)** | 读实现:`sync-docs.ts#suiteSourceReport` 拿门禁自称的套件数与树里 `*.test.ts` 的个数**交叉核对**,不符就**直接抛**;注释写明「**不自动重跑** —— 那会把一次日志复用变成一次全量门禁」⇒ 刻意的 fail-closed。★ 当晚两次「不完整」**都是真失败**(`WS-FND-103` §九 哈希没跟着改 / `WS-FND-135` 我自己引入的回归),**不是被抢占** | 处置已固化在报错文案里:`node scripts/verify.ts --all > g.log`,再 `--gate-log=g.log` 复用。详见 **§13.14** |
| O-6 | Windows 本机那份 60 分钟长跑**没有 summary** | **已 superseded(w79)** | 60 分钟那条仍缺:本环境**会回收长命子进程**(实测三种手法各死一次 —— 1 `Start-Process -WindowStyle Hidden` 在父命令返回时被杀(日志停在 13:14:53);2 `schtasks /create` + `/run` 静默失败(任务根本没建档);3 工具自带 background job 在 **28.8 分钟**被回收)。⇒ 改成 **25 分钟**(回收上限内)跑**完整**一轮,拿到 summary:`acViolations` **0 → 0**、`acStaleRejections` **144**、丢弃 0、tick **43851 帧 / 34.26ms / 29.19fps**(Windows 口径,D-26 已记的定时器粒度伪影)、autosave 52/失败 0、RSS 100.2 → 216.9 MiB。⚠️ 顺带实测到一个**平台差异**:`movesWorldRejected` 本机 **5972 / 55032 包(10.9%)** vs 服务器 **0** | **不再需要(w79)**。owner 2026-11-22 裁定:「不要在本机上跑了,只要服务器跑」+「暂时不换机器」⇒ 服务器 `120.79.230.40` 是**唯一运行环境**,本机这条 60 分钟**不再是要还的账**;w72 那份 25 分钟完整跑作为**平台差异证据**保留(见 `§13.15`)。本机 60 分钟若真需要,只剩「拆成两个 30 分钟」一条路,不列为待办 |
| O-7 | 反作弊**丢弃计数**是否进生产可观测面 | **已闭环(w67)** | 核完的答案是**没有**:`droppedViolations` / `staleRejections` 在 `server/` 只剩定义,读取点全在 `tests/` 与 `scripts/soak.ts`(与 `WS-FND-134` 当年修的那一类**同形**)。修法:并进**已有**的唯一出口 `NetPersistRoom.noteRuntimeEvidence()`,新增 `[room:ac-dropped]` / `[room:ac-stale]` 两类行(「变了才报」)。判据 `tests/WS-FND-134` 的 **`FND134-17`**,有牙 **20/20 → 19/20** | 完成。⚠️ `worldMoveRejects` **故意不报**(它是常态:本机 2.5 分钟 81 次 ≈0.54 次/秒,按「变了才报」= 每帧一行的噪声) |
| O-8 | **§6.2 窗口没跟着重锚**:世界把刚体挪走的那段位移照样进 `pathLength` | **实测否证(不成立)** | 探针:满速 32Hz(一帧一包、步长 `BASE_MOVE_SPEED × DT`)+ 窗口内一次真击退(2 格)⇒ **A 段(只走路)** path 4.500 / 32 帧 ⇒ 读数 **4.500** 格/秒、0 条 SPEED;**B 段(击退 + 继续满速)** 读数仍 **4.500**、0 条 SPEED。原因是**结构性的**:击退期间世界**拒收**移动(`worldMoveRejects = 27`),那些申报被世界拒收路径 `rollbackMove` **从窗口里回滚掉**(窗口点数 **33 → 21**、跨度 20 < 32 ⇒ 检查被**跳过**),而击退位移又被慢帧摊进那 1 秒 ⇒ 两项互相抵消。原主张 `4.5 + 2 = 6.5` 漏了「被拒申报会回滚」这一层 | **已做成回归(w79)**:`tests/WS-FND-178` 的 **`FND178-11`**(满速 48 帧 → 一次真击退 → 再 48 帧 ⇒ 窗口读数 ≤ `BASE_MOVE_SPEED × speedWindowTolerance`、**0 条 SPEED**、`worldMoveRejects` 增加、全程 0 违规)。⚠️ **有牙不在**「读数越界」那两条 —— 实测把 `rollbackMove` 里的 `restoreMoveWindow` 摘掉,读数**照样不越界**(幻影申报的 x 本身就跟着投影走,累加不出 2 格跳变),所以真正有牙的是**直接驱动 `snapshotMove` → `move` → `rollbackMove`** 的那条:「放行的一包进窗口(path 增大)、回滚后逐点还原」—— 摘掉 `restoreMoveWindow` ⇒ **12/12 → 11/12**,红点正是它 |
| O-9 | `authorityDrift` 用的是两包之间的**净位移** ⇒ 世界位移**非单调**时低估瞬时偏移,那一包仍会被判 TELEPORT | **关闭(w74:不修 —— 理由与补丁草案见 §13.14)** | 探针实测:`applyKnockback` 推过去(+0.5 格)、客户端读到、再推回来(−0.5 格)⇒ **净位移 = 0 ⇒ `authorityDrift = 0.0000`**,而 `dist = 0.6406 > 额度 + 0 = 0.225` ⇒ `单帧位移 1.141 格 > 上界 0.225`(真 TELEPORT)。`soak60e` 60 分钟 / 8 客户端 / **143856 包**里 2 条(**0.0014%**);**`soak60f`(w76/w78 构建)同参数 0 条** ⇒ 它是**概率事件**,不是稳定复现的形态 | 候选修法:把 `authorityDrift` 从「净位移」改成**每帧位移的路径长度累加**(房间逐帧采样 `hostPositionOf`,O(玩家数));✅ 不放宽任何判据常量,❌ 但会把 `stale` 窗口按**反向的那一段**放大,且要动每帧热路径 ⇒ **本轮不动**,如实登记。⚠️ 危害评估:TELEPORT 权重 4、踢出门槛 12、衰减 0.64/秒 ⇒ 要 6 秒内 3 条才会踢人,而本类是 **1 条/30 分钟**。**w79 已把安全性质钉成基线 `FND178-12`**(这一包不许放行 / 世界与投影都不许被写 / 分类与计分自洽,**刻意不钉走哪一支** —— 将来修 O-9 不该让它红) |

### 13.5 已核实**不是**问题的(免得下一个人重查)

- `R6-CBT-2`「部分接:`isTalentUnlocked` 1 处」**准确**(`world_sim.ts:363` 是 import、`:3856` 是唯一调用点)。
  它与历史 commit message「天赋…全接」措辞不一致,但**账是保守的一方**。
- README 类型检查区的 `205+26+15+10+3 = 259` 是**带日期的历史分布快照**,紧邻一行明写
  「现值…本文件**不手抄**」⇒ 不是漂移。
- `HANDOVER §三` 的「第六轮 121 / 第七轮 127 / 第八轮号段 132」是**带日期的轮次叙述**(不是当前值);
  该行「值」列的数字由 `verify.ts::verifyHandoverNumbers()` 逐行核过。
- 同义反复注记的 `2026-11-25` 在 README / HANDOVER 两处一致。
- **O-8 的「满速 + 击退 ⇒ 判 SPEED」不成立(实测否证)**:击退期间世界**拒收**移动
  (探针实测 `worldMoveRejects = 27`),那些申报被 `applyMove` 的世界拒收路径用 `rollbackMove`
  **从 §6.2 窗口里回滚掉**(窗口点数 **33 → 21**、跨度 20 帧 < 32 ⇒ 检查被**跳过**),
  而击退位移本身又被慢帧摊进那 1 秒 ⇒ **两项互相抵消**。
  实测读数:满速 **4.500** 格/秒、击退后仍 **4.500**,**0 条 SPEED**(步长 = `BASE_MOVE_SPEED × DT`,
  每帧一包 = 32Hz)。原主张的 `4.5 + 2 = 6.5` 漏了「被拒申报会回滚」这一层。
  探针见 scratch 的 `_o8b_probe.ts`(未进仓)。

### 13.6 自测指南

```bash
# ── 1 门禁(约 6 分钟)────────────────────────────────────────
node scripts/verify.ts --all
#   期望:exit 0 · 行首 ✗ 0 项 · 用例汇总 3133 条 / 187 套件 · 自检 29/29
node scripts/typecheck.ts
#   期望:exit 2 / 257 条 —— 这是**在案形态**(基线锁在 --all 里核),别当红
node scripts/sync-docs.ts --check
#   期望:无变化(它内部会**现跑一次** verify --all,所以也要 6 分钟)

# ── 2 单套件(秒级)──────────────────────────────────────────
node tests/WS-FND-178-anticheat-watermark-reanchor.test.ts   # 期望 9/9
node tests/WS-FND-169-soak-harness.test.ts                   # 期望 11/11

# ── 3 真长跑(60 分钟;本机与服务器同一份夹具)──────────────
node scripts/soak.ts --minutes 60 --clients 8 \
  --db ./soak.db --log ./soak.log --fresh --quiet
#   采样在同名的 .log 里(--log 那一路);`.out` 只有启动那几行。
#   读 `soak:summary` 那一行:ledgers.acViolations / ledgers.acDroppedViolations / tick
#   ⚠️ `acViolations` 是**环形流水长度**(容量 512)⇒ **饱和即丢信息**;
#      `acDroppedViolations` 才是「丢了多少条」。判据:后者 === 0。

# ── 4 只想快速看反作弊(2.5 分钟,不必等 60 分钟)───────────
#   核心是**包一层 applyMove**,看「投影 vs 水位」的偏离有没有在累积:
```

```ts
// probe.ts —— 逐次 move 记「投影 vs 水位」的偏离,并判早退分支
const soak = await import('file:///<repo>/scripts/soak.ts');
const fx = await soak.createSoakFixture({
  ...soak.DEFAULT_SOAK_OPTIONS,
  minutes: 2.5, clients: 8, dbPath: 'p.db', logPath: 'p.db.log', fresh: true, quiet: true,
});
const rt = fx.runtime, orig = rt.applyMove.bind(rt);
const gapOf = (id: string): number => {
  const s = rt.ac.get(id), p = rt.playerState(id);
  return s && p ? Math.hypot(p.x - s.lastX, p.y - s.lastY) : Number.NaN;
};
rt.applyMove = (id: string, intent: unknown) => {
  const before = gapOf(id);
  const r = orig(id, intent);
  const after = gapOf(id);
  // ★ 判据:非世界拒收却被拒,且偏离**没有变小** ⇒ 走的是反作弊早退分支(它不重锚)
  if (!r.allowed && r.worldRejected !== true) console.log('AC-REJECT', { id, before, after });
  return r;
};
const t0 = Date.now();
while (Date.now() - t0 < 150_000) await new Promise((r) => setTimeout(r, 200));
await fx.close();
const vs = rt.ac.violations();
const kinds: Record<string, number> = {};
for (const v of vs) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
console.log('acViolations', vs.length, 'dropped', rt.ac.droppedViolations, 'kinds', kinds);
```

```bash
# ── 5 服务器(本仓当前那台:阿里深圳 · Debian 12 · node v24.13.0)
#   通道:`decodo-recon/rsh.py`(需 RSH_USER / RSH_PASS)
#   ⚠️ 含引号/管道/分号的远端命令一律**写成 .sh 上传再 bash 执行** —— 内联必被三层引号吃掉;
#      长任务用 `setsid nohup node scripts/soak.ts ... < /dev/null &` 起,
#      且**别让 sleep 混在被杀的会话里**。取采样读 **.log**,不读 .out。
```

### 13.7 一次自我更正(记一次)

w59 交付后我写了「已修」—— 随后被**自己的 60 分钟长跑**推翻(`acViolations` 仍 512 饱和、
`acDroppedViolations` 65835/29min ≈ 38/s)。教训:**反作弊这类「判据的参考点」缺陷,2 秒的短跑门禁
与一次探针都可能看不出来** —— 它的 onset ≈ **92 秒**,且只在**长跑**里才累积成风暴。
⇒ 定这类缺陷的**唯一**可信判据是「**长跑台账 + 逐次 `applyMove` 的偏离量**」两件一起看。

### 13.8 第三修点(w63 期间):**客户端帧计数器折算**

**症状(实测复现)**:真实浏览器客户端发的是**它自己的**计数器
(`client/src/main.ts` 的 `localTick`,从 0 起),而 `ac.join` 把 `lastMoveTick` 播种成
**房间帧号**(`room.ts#join` 传 `state.meta.tick`)。只要房间在玩家加入**之前**跑过帧
—— **任何第二个玩家、任何页面重载** —— 两者就差几百帧:

```
房间 meta.tick = 441 · AC 播种 lastMoveTick = 401
客户端计数器 tick=1  ⇒ allowed = false · dtTicks = 0 · 单帧位移 0.141 格 > 上界 0.000
tick=2 / tick=3      ⇒ 同样 false          ← 两套计数器同速增长 ⇒ 永远追不上
```

⇒ **该玩家一步也走不动**(移动写不进世界),而且每包留一条假 `TELEPORT`。

**修法**:`AntiCheatRoom.normalizeClientTick()` 在第一包记下 `(房间帧号 − 客户端计数器)`
作为**基准**(钳到 ≥ 0),之后把申报 tick 折算到房间时钟;折算结果仍要过 `checkMove` 的
**同一对夹取** ⇒ **拿不到任何额外额度**(报一个巨大的首包 tick 也没用)。

**判据**:`tests/WS-FND-178` 的 **`FND178-8`**(房间先跑 60 帧再进人 ⇒ 从 0 起算的四拍全部必须放行)。
有牙实证:**去掉** `room.ts` 里那次折算 ⇒ **9/9 变 8/9**(`FND178-8`);**去掉**
`normalizeClientTick` 里的 `|| reset` ⇒ **9/9 变 8/9**(`FND178-9`)。两者都报「期望 true / 实际 false」。

**附带修**:`WS-FND-178` 里那条**恒真断言** `eq(droppedViolations >= 0, true)` 改成
`eq(droppedViolations, 0)`(前者恒真,什么也钉不住 —— 对抗审查发现的)。

### 13.9 ⚠️ 本环境的运维坑(踩过,记一次)

**本环境的 Edit 工具会把文件写成 CRLF**,而本仓约定 **LF**。后果:`tests/WS-FND-160`
(找 `` 注入\n ``)与 `tests/WS-FND-167`(找 ``      diagLine,\n ``)会**当场红**。
⇒ **每次用 Edit 改完必须复查 EOL**(`\r` 计数应为 0)。本轮 `anticheat.ts` / `README.md` /
`docs/HANDOVER.md` 都被写成过 CRLF,已归一。复查命令:

```powershell
foreach($f in @('server\src\net\anticheat.ts','README.md','docs\HANDOVER.md')){
  $b=[System.IO.File]::ReadAllBytes($f); $cr=0
  for($i=0;$i -lt $b.Length;$i++){ if($b[$i] -eq 13){$cr++} }
  "{0,-40} CR={1}" -f $f,$cr
}
```

**第二个坑(w79 踩到):`git checkout -- <file>` 会把这个文件**写成 CRLF**。**本仓 `core.autocrlf=true`
(实测 `git config --get core.autocrlf` → `true`),而这批文件的 index/blob 是 LF ⇒ checkout 走的是
smudge(LF→CRLF)。**所以「改坏了就 `git checkout --` 还原」在本仓是错的**:还原出来的文件 EOL 变了,
`WS-FND-160`/`WS-FND-167` 会当场红。更坑的是 `git status` 此时给出**自相矛盾**的读数
(` M <file>` 与 `git diff --numstat` 空并存)。正确姿势:

1 还原:`git checkout -- <file>`,再**必须**抹掉 CR;
2 判「内容真的没变」:`git diff --quiet HEAD -- <file>`(exit 0)+ `git rev-parse HEAD:<file>` 与
  `git ls-files -s -- <file>` 的 blob id 相等 —— **不要**信 `git status` 的那一列。

```powershell
node $env:PI_SCRATCH_DIR\_to_lf.mjs server/src/net/anticheat.ts    # 抹 CR,打印抹掉几个与字节变化
node $env:PI_SCRATCH_DIR\_blobcmp.mjs server/src/net/anticheat.ts # 与 HEAD blob 逐字节比 ⇒ 期望 SAME
```

两个脚本都在 session scratch(`_to_lf.mjs` / `_blobcmp.mjs`),**没进仓** —— 它们做的事用 3 行 node 能复现,
进仓会变成「给运维工具付维护费」。★ 另一条同源教训:**PowerShell 管道会改字节**,
`git cat-file blob … | node -e …` 算出来的 sha256 **不可信**(实测同一文件 `wt` 与 `head` 哈希不等,
而 `_blobcmp.mjs` 用 `execFileSync` 拿到 Buffer 后判定 **SAME**)。要比二进制就走 `execFileSync`,别走管道。

### 13.10 对抗审查「同帧连发会被误判」的**实测否证**

第二轮审查提了一条**未验证**的担心:同一服务端帧内连发两包、各带合法位移 ⇒ 第 2 包
`claimedTick` 被夹到 `lastMoveTick` ⇒ `dtTicks = 0` ⇒ 判 TELEPORT ⇒ 计分够就**踢人**。

**实测(3 帧 × 每帧 2 包 = 64Hz 平均发包;每包位移 = 标称单帧合法位移 `0.140625`)**:

```
round=0 pkt=0 clientTick=1 allowed=true   round=0 pkt=1 clientTick=2 allowed=true
round=1 pkt=0 clientTick=3 allowed=true   round=1 pkt=1 clientTick=4 allowed=true
round=2 pkt=0 clientTick=5 allowed=true   round=2 pkt=1 clientTick=6 allowed=true
violations = 0 | dropped = 0 | score = 0 | kicked = false
```

**不成立。** `claimedTick = min(t', lastMoveTick + MAX, lastTick + MAX)`:只要**申报水位还落后于
房间时钟**,同帧内每一包都还能拿到 **1 帧**额度(第 1 包把 `lastMoveTick` 推到 `X+1`,第 2 包
得 `X+1` 与 `X+2` 之间的那个 min ⇒ 仍是 1 帧)。要触发得**同一帧内 3 包以上**(≈96Hz 平均),
而真实客户端是 **1 包/帧**(`main.ts` 的 `setInterval(DT*1000)`),32Hz 抖动离它很远。
⇒ **不登记为缺陷**;此处留证,免得下一轮再被同一条担心占用时间。

### 13.11 第四修点(w65):把「世界自己挪刚体」那一类假阳性**归类**成 `stale`

#### 一句话

前三个修点关掉的是「水位与权威**永久**偏离」的风暴。剩下的是最后一类:
**世界在 `checkMove` 之外自己把刚体挪了** —— 真击退的慢帧两段推 / 互相挤出的碰撞分离
(`resolvePairs`)/ 落地沉降 —— 而客户端那一包是按**它读到投影那一刻**起算的:它不可能知道。

#### 为什么 `dist > 额度` **不等于**作弊

入口重锚把 `lastX/lastY` 钉到**此刻**的权威刚体 ⇒

```text
dist = |客户端申报 − 此刻权威| = |客户端的步长 − W|        (W = 服务端自位移)
三角形不等式:|step − W| ≤ |step| + |W| ≤ 额度 + W          (只要 |step| ≤ 额度)
```

⇒ **`dist ≤ 额度 + W` 时,客户端的步长一定在额度内**,多出来的全是服务端自己的动作。

#### 修法:归类,**不放宽**

- `Verdict` 增 `stale?: boolean`;`AntiCheatRoom` 增 `staleRejections`(soak 台账第 10 项);
- `checkMove` §6.1:`dist > 额度` 且 `dist ≤ 额度 + s.authorityDrift` ⇒ 返回
  `{ allowed:false, stale:true }` —— **照样拒绝**(陈旧申报不许覆盖权威刚体,否则一次击退
  会被客户端的迟到包抹掉),但**不计违规、不加分、不进流水**;
- 单帧上界 / `TELEPORT_SLACK` / 窗口均速 / Z 值域 **一个数都没动**。

#### ⚠️ `authorityDrift` 的来源**必须**是房间自己的读数(第一版在这里摔了两次)

第一版拿 `|新水位 − 旧水位|` 当 `W` ⇒ **当场被两条既有判据打红**:

1. `WS-FND-135` 的注入负对照:它手工把水位改成**幻影**(`st2.lastX = C.x + 2δ`)⇒
   「水位被改坏」也换来宽限 ⇒ 一条合法报文被**静默放过**(`FND135-7` 红);
2. `WS-FND-178-5`:基准若取「进入本包**之前**的权威」,会把**玩家自己那一步**算成世界位移 ⇒
   真作弊包被误归 `stale`(`FND178-5` 红)。

⇒ 现在 `authorityDrift` 由 `room.ts#applyMove` 用**房间自己**的 `hostPositionOf` 读数算:
`|此刻权威 − 上一包**处理完**之后的权威|`,基准存在房间的 `lastMoveAuthority`(入场播种、
三条出路径各自更新、离场随席位清),与 AC 水位**完全解耦** —— 水位怎么变都不影响它。

#### 判据与实测(w65 构建)

| 项 | 值 |
|:---|:---|
| 判据 | `tests/WS-FND-178` 的 **`FND178-10`**:正例归 `stale`、反例(`dist > 额度 + W`)仍 TELEPORT **且计分** |
| 有牙 | 把入口喂给 `ac.noteAuthorityDrift` 的读数按死成 `0` ⇒ **10/10 → 9/10** |
| 修前基线 | 60 分钟实测 `acViolations` **60**(w63)/ **63**(w61),`acDroppedViolations = 0` |
| 本机 2.5 分钟(8 客户端) | `acViolations` **0 → 0**(修前 13~22)· `acStaleRejections` **0 → 1** · 丢弃 0 · 世界拒收 81 |
| 台账 | soak 新增第 10 项 `acStaleRejections` —— 与 `acViolations` **分开读**才能归因 |
| 门禁 | **3131 用例 / 187 套件** · 基座 **2117 / 173** · typecheck **257** |

#### 60 分钟复核(w65 构建):`soak60e`(2026-11-22 03:15→04:15 CST,pid 1320493)

| 列 | 修前 `soak60d`(w63) | **修后 `soak60e`(w65)** |
|:---|:---|:---|
| `acViolations` | 0 → **60**(线性,环未饱和) | 0 → **2** |
| `acStaleRejections` | (不存在) | 0 → **54** |
| `acDroppedViolations` | 0 | **0** |
| `movesWorldRejected` | 0 | **0** |
| tick | 115764 帧 / 31.1ms / 32.15fps | 115769 帧 / 31.1ms / 32.15fps |
| autosave | 121 / 失败 0 | 121 / 失败 0 |
| RSS | 133.0 → 220.2 MiB | 133.3 → 204.6 MiB(峰值 205.4) |

⇒ **60 条里 54 条被正确归类**(假阳性从流水里消失、改由独立列承担),
**剩下 2 条 = O-9**(净位移低估瞬时偏移;已给出探针读数与修法候选)。
`soak60e.out` 里那条 `acViolations` 的「单调增长」台账列按设计**仍在**——
它现在只在真有违规时才涨。

⇒ 判据达成:`acViolations` **不是 0,而是 2**(其中 **54 条**已从流水里消失、改由独立列承担);
`acDroppedViolations` **0**、`acStaleRejections` **54**。剩下那 2 条 = **O-9**。

#### 60 分钟复核(第二轮,w79):`soak60f`(w76/w78 构建,2026-11-22 17:59→18:59 CST,pid 1949017)

| 列 | `soak60e`(w65) | **`soak60f`(w76/w78)** |
|:---|:---|:---|
| `acViolations` | 0 → 2 | **0 → 0** |
| `acStaleRejections` | 0 → 54 | 0 → **65** |
| `acDroppedViolations` | 0 | **0** |
| `movesWorldRejected` | 0 | **0** |
| tick | 115769 帧 / 31.1ms / 32.15fps | 115756 帧 / **31.11ms** / 32.15fps(世界钟×墙钟倍率 0.9953) |
| autosave | 121 / 失败 0 | 121 / 失败 0(末次原因 `dispose`) |
| RSS | 133.3 → 204.6 MiB | 132.4 → 201.8 MiB(峰 213.8 / 谷 132.4) |

⇒ **假阳性归零**:`acViolations` 全程 **0**,两个列现在只由「服务端自己挪刚体」那一类(`stale`)承担。
⚠️ **如实登记**:`soak60e` 里那 2 条 **O-9**(世界位移非单调 ⇒ 净位移低估瞬时偏移)在本轮**没有复现** ——
它是概率事件(实测率 0.0014%),`0/60 分钟` 与 `2/60 分钟` 落在同一噪声带内,**不能**据此宣布 O-9 消失。

### 13.12 O-7 闭环(w67):反作弊的两个计数接上**生产**日志出口

O-7 原本是「**未核**」。核完的答案是**没有**:`git grep 'droppedViolations\|staleRejections'`
显示它们在 `server/` 只剩**定义**,读取点全在 `tests/` 与 `scripts/soak.ts`。
这与 `WS-FND-134` 当年修的那一类**同形** —— 字段被认真写入、注释承诺可观测,而生产侧
**0 个读点**,于是「注释里的可观测」只对测试成立。

修法:并进**已有**的唯一出口 `NetPersistRoom.noteRuntimeEvidence()`
(`server/src/net/room.colyseus.ts`,每帧 `stepTick` 都会跑),新增两类行:

```text
[room:ac-dropped] 反作弊流水因环满丢弃 +8(累计 8):被挤掉的证据不可恢复
[room:ac-stale]   世界自位移导致的拒绝 +3(累计 3):不算违规、不计分
```

- 两者都走「**变了才报**」(与既有三个留证字段同一纪律)⇒ 不会把同一件事刷成一堵墙;
- 计数**回退**(房间复用 / AC 被换掉)只更新基准,**不报负增量**;
- ⚠️ 如实登记:`worldMoveRejects`(世界侧拒收移动)**故意不报** —— 它是**常态**
  (倒地 / 眩晕 / 击退窗口都会命中;本机 2.5 分钟实测 **81 次** ≈0.54 次/秒),
  按「变了才报」会变成每帧一行的噪声,而噪声会让人关掉日志 —— 那等于又回到静默。

判据:`tests/WS-FND-134` 新增 **`FND134-17`**(真的把环形流水灌爆 520 条 ⇒ 断言出口出现
一行且带**真累计值**;`stale` 报**增量**;去重;回退不报负增量)。
有牙实证:把 `droppedViolations` 那一路的判据改成 `false && ...` ⇒ **20/20 → 19/20**。

### 13.13 审查回答:`stale` 能不能被作弊者利用?—— **实测否证**

问法:既然 `dist ≤ 额度 + drift` 就归类成 `stale`(不计分),那作弊者能不能把 `drift` 顶大,
**一边瞬移一边不被计分**?更狠一点:能不能借着 `stale` 真的**动过去**?

**实测(注入式,`_stale_exploit_probe.ts`)**:

```text
注入 rt.ac.noteAuthorityDrift('p1', 3.0)     ← 手工把宽限顶到 3 格
作弊包(申报 5 格开外)   allowed=false  stale=false  violation=TELEPORT
刚体 x: 0.6406 -> 0.6406   位移=0.0000        ← 世界**没被写**
投影 x=0.6406                                  ← 投影也没被写
score 0 -> 4    流水 0 -> 1                    ← 照旧计分
第二包(同一份注入)     allowed=false  stale=false  violation=TELEPORT  score=8
```

**三条结论**:

1. **注入无效**:`room.ts#applyMove` 顶部**每一包都重算** `authorityDrift`
   (`|此刻权威 − 上一包处理完之后的权威|`)⇒ 手工塞进去的值在**下一次入口**就被覆盖。
   宽限**不可能被申报方放大** —— 它只反映**房间自己**观测到的权威位移。
2. **`stale` 不动世界**:它仍然 `allowed:false` ⇒ `applyMove` 走早退分支,**不写刚体、不写投影、
   不推进申报水位** ⇒ 即便宽限真的成立,作弊者也**拿不到位置**,只换来「这一包不计分」。
   而拿到宽限的前提是**服务端自己把他推了** —— 那是物理给的事件,不是他能自由放大的量。
3. **坏输入 fail-closed**:`noteAuthorityDrift` 收到 `Infinity` / `-5` / `NaN` ⇒ `drift = 0`
   (实测)。

### 13.14 O-5 与 O-9 的裁决(两条都**不动代码**,但理由不同)

#### O-5 「`sync-docs --write` 在并发负载下不可靠」—— **已核:不是缺陷,是刻意的 fail-closed**

读了实现:`scripts/sync-docs.ts#suiteSourceReport` 拿门禁输出自称的套件数与树里 `*.test.ts`
的个数**交叉核对**,不符就**直接抛**「测量源不可信」。注释把「为什么不自动重跑」写在原地:
`本工具**不自动重跑** —— 那会把一次日志复用变成一次全量门禁`。
⇒ 设计意图明确:宁可不写,也不把「少一个套件的数字」写进 README。

★ 更要紧的是**今晚两次「不完整」都是真失败**,不是被抢占:
`g67` = `WS-FND-135` 红(我自己引入的回归)、`g69` = `WS-FND-103` 红(§九 哈希没跟着改)。
⇒ 工具拒绝写盘**是对的**;旧条目里「子进程被 kill」的归因**没有当晚证据**。
处置(已固化在报错文案里):`node scripts/verify.ts --all > g.log`,再 `--gate-log=g.log` 复用。

#### O-9 「`authorityDrift` 用净位移 ⇒ 世界位移非单调时低估」—— **关闭:不修(附补丁草案)**

裁决:**不修**。三条理由,按权重:

1. **危害量化**:2 条 / 60 分钟 / **143856 包**(0.0014%),且**不可能踢人** ——
   TELEPORT 权重 4、门槛 12、衰减 0.64/秒 ⇒ 要 6 秒内 3 条,而本类是 1 条/30 分钟;
2. **修法要动每帧热路径**:把「净位移」换成「路径长度累加」需要房间**逐帧**对每个玩家
   采样 `hostPositionOf` 并累加 `|Δ|` —— 换来的却是**加宽 `stale` 窗口**(按反向的那一段),
   而 `stale` 只是「计不计分」,不改变「能不能动」;
3. **残余无害**:它仍然**拒绝**那一包(世界不被写),所以没有任何可被利用的位置面。

补丁草案(供 owner 若要零残余时直接落):

```ts
// room.ts:新增 private authorityPath = new Map<string, number>();
// step() 里逐玩家:authorityPath.set(id, (authorityPath.get(id) ?? 0) + |权威(t) − 权威(t−1)|);
// applyMove 入口:const drift = authorityPath.get(userId) ?? 0; authorityPath.set(userId, 0);
//                 （再喂 noteAuthorityDrift;其余一字不改）
```

⚠️ 这会**同时**影响 `stale` 的宽窄与 `acStaleRejections` 的读数 —— 要落就得连同
`FND178-10` 的期望一起重钉,并重跑一轮 60 分钟 soak 作对照。

### 13.15 ★ 把服务器当**唯一运行环境**:踩到的八件事(2026-11-22 owner 裁定「不要在本机上跑,只要服务器跑」)

| # | 症状 | 根因 | 处置 |
|:--|:--|:--|:--|
| 1 | 服务器上 `backlog.ts` 只数到 **8** 条(本机 133);`sync-docs` 报「未决台账 133 ⇒ 应写 8」 | **`git archive` 被 `core.autocrlf=true` 转成了 CRLF**(仓里是 LF:`git ls-files --eol` = `i/lf w/lf`)⇒ 服务器那棵树的文档全是 CRLF,而 `backlog.ts` 的解析**对行尾敏感** | 导出必须写死 **`git -c core.autocrlf=false archive …`**。验证:`tr -cd '\r' < docs/HANDOVER.md \| wc -c` = **0** |
| 2 | `WS-07` 在服务器上 `ERR_MODULE_NOT_FOUND`(只 211/215);`WS-FND-134` 直接抛 | 服务器是**早期的全量快照 + 只对改动文件打补丁**的**残缺树**,且**没有 `node_modules`** | 改成**整棵同步**(`git archive HEAD` 覆盖 `server client shared scripts tests docs assets`)+ 服务器上 `npm install`。同步后 `WS-07` **215/215**、`WS-FND-134` **20/20** |
| 3 | 门禁报「**本轮新增的 BOM:4 个**」(`docs/WS-05-boss-raid.md` / `server/src/mobs/aoi.ts` / `geometry.ts` / `taming.ts`) | 那 4 个 BOM **仓里本来就有**;这条判据拿**未跟踪的 `.baseline/`**(上一轮 verify 输出)当基准 —— 服务器没有它 ⇒ 全都算「新增」 | 把 `.baseline/verify.txt` / `.baseline/orphan.txt` 一并同步。⚠️ **登记为隐患:门禁基线不在 git 里**(换机器就漂) |
| 4 | `WS-FND-112` 的 `FND112-11` 红(「手册在场时也必须打『跳过 0 项』」) | 它断言的手册是**仓外文件** `~/Downloads/2_5d_cartoon_sandbox_plan.md`(`scripts/data-conformance.ts#locatePlan` 的候选之一)。本机有(105 KB),服务器没有 ⇒ `WS-FND-06` 走跳过分支,报「跳过 1 项」 | 把手册放到服务器的 `$HOME/Downloads/`(或设 `PLAN_MD`) |
| 5 | 类型错误 **+1**:`driver.sqlite.ts TS7016 Could not find a declaration file for module 'better-sqlite3'` | 本机**没装** `better-sqlite3`(它不是 `package.json` 的依赖)⇒ TS 走仓内的 ambient 声明;**服务器 `npm install` 把它装上了**却没有类型声明 ⇒ 反而多一条 | 对齐参考环境:`rm -rf node_modules/better-sqlite3` |
| 6 | `§三 PROGRESS 陷阱` 字节数:文档 **463346** / 服务器 **455146** | `docs/PROGRESS.md` 在**本机 worktree 里是 CRLF**(`git ls-files --eol` = `i/lf w/crlf`;**8200 行 ⇒ 恰好差 8200 字节**),提交内容(LF)的真值是 455146 | 已把本机那份归一为 LF,并把文档值订正为 **455146**。⚠️ 教训同 §13.9:**所有「字节数」类判据都会被 worktree 行尾污染**,读数前先看 `git ls-files --eol` |
| 7 | `bom-guard` 报「本轮新增 BOM:4 个」**即使 `.baseline/` 已在位** | `scripts/bom-guard.ts` 用 **`git cat-file blob HEAD:<rel>`** 与 HEAD 比对;服务器**没有 `.git`** ⇒ 比对失败 ⇒ HEAD 里本来就有的 BOM 全算「新增」 | 在服务器建一个与工作区**一致**的 `.git`(`git init` + 一次 commit)。实测:`✓ 本轮新增 BOM:0 个` |
| 8 | `WS-FND-06` 仍报「跳过 1 项」**即使手册已在 `$HOME/Downloads/`** | `tests/WS-FND-06.test.ts` 自己的 `locatePlan()` 候选是 `join(process.env.USERPROFILE ?? '', 'Downloads', …)` —— 服务器 `USERPROFILE` **未设** ⇒ 它退化成**相对路径** `<仓根>/Downloads/…` | 手册放到**仓根的 `Downloads/`**(别放 `docs/`,那样 `FND112-11` 的负对照会红)。实测:`[WS-FND-06] 跳过 0 项`、`FND112-11` **14/14** |

★ 这八条的共同形状:**「本机能跑绿」依赖了四样不在 git 里的东西** —— 本机的
`core.autocrlf=true`、未跟踪的 `.baseline/`、仓外手册、以及一个**与工作区一致的 `.git`**
(第 7 条)。⇒ 换成「服务器为唯一运行环境」时,这四样必须一起搬过去,
否则门禁的**数字**会静默漂移(而漂移看起来像「代码坏了」)。

★ 服务器侧那 **1 项红**(门禁自检)已在 w79 修掉 —— **不是**硬件限制,是**调度的形状**:
2 核机上两条 `--integration` 互相争用(内层 600 s 预算),而把并发压小又会撞穿外层 900 s 预算。
详见 **§13.16**。修后实测:**29 通过 / 29 合计**、单条长作业 **535.8 s**、自检墙钟 **685 s**。

★ **一次铺齐**:`decodo-recon/provision_2_5d_server.sh`(幂等)把上表要的东西一次做完 ——
整棵 **LF** 快照、`npm install`、去掉 `better-sqlite3`、`.baseline/`、手册**两处**、
以及与工作区一致的 `.git`;末尾还会自动跑 `backlog` / `WS-FND-06` / `WS-07` / `WS-FND-134`
四个自检点。下次换机器或重建,照它跑一遍即可(本地侧的三条 `--put` 写在该脚本头部注释里)。

### 13.16 w79:两条新判据 + 2 核机上自检的**调度修法**(owner 裁定「暂时不换机器」)

#### 做了什么

| # | 改动 | 位置 |
|:--|:--|:--|
| 1 | 并发**分道**:`jobs` 维持 `min(8, max(2, CPU−1))`,长作业(`--integration`)在**核数 < 3** 时走**专线串行**(1 条长作业 + `jobs−1` 路短作业) | `scripts/gate-selfcheck.ts`(`[并发]` 段的分道逻辑) |
| 2 | 成本模型:`--integration` 由 **3 → 6** —— 原值把它排在默认全量 `runTests`(:5)**之后**,与「长作业优先」正好相反(实测单条 **296 s**) | 同上 `caseCost()` |
| 3 | 两条 N1 **合并成一条**(跑的是**同一条** `--integration`、**同一处(没有)变异** ⇒ 删掉的是**重复执行**,不是断言)⇒ 用例总数 30 → **29** | 同上 `CASES` 的 `N1` |
| 4 | **`FND178-11`**:O-8 的否证回归 | `tests/WS-FND-178-anticheat-watermark-reanchor.test.ts` |
| 5 | **`FND178-12`**:O-9 的**安全性**基线,刻意不钉走哪一支 | 同上 |

服务器实测:`[WS-FND-178]` **12/12 通过**;连带 `WS-FND-135` 13/13、`WS-FND-172` 16/16、
`WS-FND-134` 20/20、`WS-FND-169` 11/11、`WS-FND-112` 14/14。

#### ★ 一条**判据自己的缺陷**被「有牙实证」揪了出来(这条值得记)

第一版 `FND178-11` 的机理断言是:「世界拒收 ⇒ 那些申报被 `rollbackMove` 回滚、不进窗口」,
落地写法是 `worldMoveRejects` 变大。拿它去验牙(**把 `anticheat.ts#rollbackMove` 里的
`restoreMoveWindow(s, snap)` 摘掉**),结果 —— **照样 12/12 全绿**:

1. `worldMoveRejects` 是**房间**的计数器,与回滚**无关** ⇒ 那条断言**恒真**,没有牙;
2. 「窗口读数不越界」那两条**本来就不越界**(幻影申报的 `x` 本身就跟着投影走,累加不出 2 格跳变)
   ⇒ 也没有牙。

⇒ 改成**直接驱动 AC 的公开 API**:`snapshotMove` → `move`(放行,窗口路径长度必须**变大**)
→ `rollbackMove`(必须**逐点还原**,`|path − path0| < 1e-12`)。再验牙 ⇒ **12/12 → 11/12**,
红点正是这一条,且**只**红这一条。

**教训:「有牙」不能靠推理,必须真把机制摘掉跑一次。** 否则你只是把「我以为它在守」写成了绿。

#### 2 核机自检:前两版都失败,第三版才对 —— 三个数字定住了形状

| 常量 | 值 | 管什么 |
|:--|:--|:--|
| `verify.ts#VERIFY_TIMEOUT_MS` | 600_000 | 自检内**每条用例**子进程的预算 |
| `verify.ts#SELFCHECK_TIMEOUT_MS` | 900_000 | 外层 `verify --all` 给**整个自检**的预算 |

**第 1 版(修错方向):把并发压成 1 路。** 内层争用没了,但自检总时长推到 **1380 s** ⇒
反过来撞穿**外层 900 s**,`verify --all` 报 `门禁自检失败(exit=null) … ETIMEDOUT`。
⇒ **症状搬家不等于修好**:同一个 `ETIMEDOUT` 文案,前后是**两个不同的预算**。

**第 2 版(分道):1 条长作业专线 + 1 路短作业。** 内层稳住了(单条 533 s < 600 s),但两条 N1
串行 = **927 s**(532.9 + 394.3)⇒ 仍超外层 900 s(**30/30 全绿,整体 951 s**)。

**第 3 版(合并重复执行):两条 N1 并成一条。** 两条的 `from`/`to` **都是空**(无变异),
跑的是**同一条** `--integration`,只是一条断言「某消息不得出现」、另一条断言「另一条消息必须出现」;
而 `runCase` 本来就**同时**支持 `wantMsg` + `notMsg`(见其 1501-1515)⇒ **一次运行给出两个结论,
断言一条不少**。

```text
[并发] 27 个用例 / 2 路(每用例一份独立副本;长作业优先) · 1 条长作业走**专线串行**(核数 2 < 3)
  · [16/27] ✓ 535.8s N1 — --integration:不得报「冻结层不变量...实测 0」,且必须打印「本模式未运行 checkFrozen」
  并发总耗时 660.4s
✓ 门禁自检全部通过(29 通过 / 29 合计)
EXIT=0 WALL=685s
```

⇒ 三个预算全进:单条长作业 **535.8 s < 600 s**、自检墙钟 **685 s < 900 s**、结论 **29/29**。
**判据 / 期望值 / 超时常量一个没动** —— 为迁就机器去放宽门禁超时才是放水。

#### ⚠️ 副作用与遗留(接手者注意)

1. `--all` 在这台 2 核机上总墙钟 ≈ **21 分钟**(自检 ≈11 分钟 + 其余门禁 ≈10 分钟)。
   取用例数/复用日志仍走 `node scripts/verify.ts --all > g.log`,但**必须把 stderr 分流到另一个文件** ——
   `sync-docs --gate-log` 复用这份 log 时,套件的汇总行会被 stderr 的警告**顶替**,
   量出的套件数会**差一个**(这次就踩到了:先写成 `2>&1`,已改成 `2>` 重跑)。
2. 长作业专线跑完长作业后**空着**(不接管短作业)⇒ 2 核上浪费 1–2 分钟。要榨掉它:
   把那条车道尾部改成 `await drain(shortQueue)`(共享游标已支持多车道跑同一队列)。
3. **≥3 核的机器走原样的单队列**(`serialLong === false`),行为与改前**一字不变**。

#### ★ 顺带:`play.ts` 的 `--host`(让服务器上的世界能被**别的机器**打开)

owner 裁定「阿里云是放行的,禁止在本机开服务」⇒ 玩也走服务器。改 `scripts/play.ts` 加 `--host`:

```bash
node scripts/play.ts --host 0.0.0.0        # 服务器上起;浏览器开 http://<服务器IP>:5173/
```

- **真正需要放开的只有 vite**:WS 服务端本来就是 `server.listen(port)`(不传 host ⇒ 绑全部网卡),
  此前打印的 `127.0.0.1` 只是**文案**;`--host` 影响的是 vite 的绑定。
- 浏览器**不需要** `?server=`:客户端默认连 `ws://<当前主机名>:8791/ws`(`client/src/main.ts`)
  ⇒ 从 `http://<服务器IP>:5173/` 打开即连**同一台机器**的 8791。
- 缺省仍是 `127.0.0.1`(只本机玩),与引入 `--host` 之前**逐字相同** ⇒ 不影响任何既有判据/门禁。
- 云主机需在安全组放行 **5173**(页面)与 **8791**(WebSocket)两个 TCP 端口。

#### ★★ 白屏的定因(2026-11-22 当晚实况):**8 秒看门狗 vs dev 模式的模块图**

报错原文(应用自己的看门狗,`client/index.html` 的 `__bootWatchdog`,由 `main.ts` 起来时清掉):

```text
启动超时:8000ms 内 src/main.ts 没有跑起来。
最常见的原因是它 404(路径/文件名不对)或模块解析失败 ⇒ 页面停在白屏。
```

**那句话把排查方向带偏了**:实测 `main.ts` 是 **200**,模块也解析得到 ——
真因是**首屏总量**。按浏览器的方式把整图跑一遍(从另一台机器,12 路并发):

| 口径 | 模块数 / 总字节 | 总墙钟 | 备注 |
|:--|:--|:--|:--|
| **vite dev** | 60 个 / **6.67 MiB** | **109 s** | 逐模块现编译;`three` 预打包 **3.93 MiB / 32 s**;`party_hud.ts`、`stage_assembly.ts` 单请求 >30 s |
| **构建产物 + `vite preview`** | **3 个 / 262 KB(gzip)** | **0.86 s** | `/` 46ms · 入口 89 KB/72ms · `three` chunk 170 KB/744ms |

⇒ 8 s 预算下,**dev 模式必然白屏**;`--dist` 才是能玩的形态。

修法:`scripts/play.ts` 增 **`--dist`**:改用 `npm run preview:client`(`vite preview`)serve
`dist/client`,并在**找不到产物时不启动客户端**而是明说「先跑 `npm run build:client`」
(fail-closed —— 不要起一个必然白屏的页面然后让用户自己猜)。缺省仍是 dev(本机玩要热更),
与改前逐字相同。

```bash
npm run build:client                            # 服务器实测 950ms
node scripts/play.ts --host 0.0.0.0 --dist      # 跨公网玩
```

两条**踩坑记录**:
1. `vite preview --outDir dist/client` 会 **404** —— `vite.config.ts` 的 `root: 'client'`,
   CLI 的 `--outDir` 是相对 **root** 解析的 ⇒ 变成 `client/dist/client`。
   **不要传 `--outDir`**,让它用配置里的 `build.outDir: '../dist/client'`。
2. 图集 `atlas_sprites.png` **2.17 MB 且不压缩**,实测单请求 **34 s**(那条链路当时也不稳)。
   它**不挡启动**(JS 起来就世界可见),但贴图会晚到 —— 这是带宽问题,不是缺陷。
