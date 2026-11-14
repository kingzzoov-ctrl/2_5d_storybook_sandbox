# 2.5D 精致绘本风沙盒 · 项目细化执行计划(LEAD-PLAN)

> 本文件是 `2_5d_cartoon_sandbox_plan.md`(747 行设计手册)的**工程化细化版**。
> 手册回答「做什么」,本文件回答「谁做、按什么顺序做、做到什么程度算完、彼此怎么对接」。
> 冻结契约见 `shared/contracts/FREEZE.md`;每个子系统的深度设计见 `docs/WS-XX-*.md`。

---

## 一、细化范围界定

### 1.1 手册 → 工程的映射原则

| 手册内容 | 细化产物 | 归属 |
| :--- | :--- | :--- |
| §2.1 双频主循环 | 20Hz/2Hz 双定时器契约 | FREEZE §2.2 |
| §2.2 刚体与举投 | `PhysicsWorld` + 举投状态机 | WS-02 |
| §2.3 32-bit 位压缩与五层栈 | `Chunk` 位压缩 + 元胞自动机 | WS-01 |
| §2.4 AOI + Steering AI | 三态 FSM + 24 生物行为 | WS-04 |
| §3.1~§3.10 全量 320 项 | `shared/constants/items.ts`(已冻结) | 冻结层 |
| §4.1 等级与共享经验 | 成长/天赋/经验结算 | WS-10 |
| §4.2 24 种野生动物 | `shared/constants/mobs.ts` + 行为实现 | 冻结层 + WS-04 |
| §4.3 8 大 Boss | `shared/constants/bosses.ts` + 破防实装 | 冻结层 + WS-05 |
| §5 万物奇想炼金炉 | LLM 结构化生成 + 确定性算法 | WS-06 |
| §6.1 胡闹工坊急单 | 3 分钟急单状态机 | WS-11 |
| §6.2 互坑物理喜剧 | 35 种玩具数据化 + 平安盾 | WS-11 |
| §6.3 四大竞技派对 | 四模式状态机与计分 | WS-11 |
| §7.1 SQLite DDL | schema.sql + repo 接口 | WS-07 |
| §7.2 20Hz 状态 Schema | 零依赖差量编码核心 + Colyseus 装配层 | WS-07 |
| §8 十周路线图 | 见本文第三节的里程碑与门禁 | Lead |

### 1.2 明确不在本期范围

- 美术资产(贴图、模型、音频文件)本身只出**契约与参数表**,不出二进制素材。
- 商业化系统(支付、内购、广告、运营后台)。
- 云端 LLM 的真实 API Key 与配额管理(WS-06 只出接口与降级路径)。
- 移动端包装(App Store / 应用商店提审)。

---

## 二、工作分解结构(WBS)

| WS | 名称 | 交付目录 | 依赖 | 关键风险 |
| :--- | :--- | :--- | :--- | :--- |
| WS-01 | 地形位压缩与五层数据栈 | `server/src/world/` | 冻结层 | 水体守恒与相变的数值稳定性 |
| WS-02 | 2.5D 伪三维刚体物理 | `server/src/physics/` | 冻结层 | 叠罗汉链的坐标同步抖动 |
| WS-03 | 建造 Auto-Tile 与 BFS 房间识别 | `server/src/build/` | WS-01 | 100 格上限下的漏墙误判 |
| WS-04 | 野生动物 AOI 与 Steering AI | `server/src/mobs/` | WS-01、WS-02 | 24 种行为被合并成通用逻辑而丢失特色 |
| WS-05 | 8 大 Boss 阶段与破防 | `server/src/bosses/` | WS-02、WS-04、WS-03、WS-08 | 破防只能是可判定条件,不能是文字 |
| WS-06 | 万物奇想炼金炉 | `server/src/alchemy/` | 冻结层 | **数值崩坏**;LLM 不得填数值 |
| WS-07 | 存档与 20Hz 差量协议 | `server/src/db/`、`server/src/net/` | WS-01 | 1KB/chunk 落盘与带宽上界 |
| WS-08 | 四色魔能电路与自动化物流 | `server/src/wiring/` | WS-01 | 2Hz 推进的图规模爆炸 |
| WS-09 | 2.5D 正交舞台与 UI | `client/src/` | 冻结层、WS-01 | 面数与 1GB 内存下行带宽 |
| WS-10 | 战斗伤害管线与成长救援 | `server/src/combat/` | 冻结层、WS-06 | 伤害公式链不闭合成乘算黑洞 |
| WS-11 | 急单、整蛊玩具与竞技派对 | `server/src/coop|prank|party/` | WS-02、WS-09 | 竞技模式计时器与并发提交 |

---

## 三、里程碑与门禁(对齐手册 §8 的十周,但按依赖重排)

### M1 — 世界骨架可跑(对应第 1~2 周)
- **范围**:WS-01、WS-02。
- **门禁**:
  - `node scripts/verify.ts --frozen` 全绿(17 项不变量)。
  - `node scripts/verify.ts --only WS-01` 与 `--only WS-02` 全绿。
  - `Chunk.serialize()` 字节数恒为 1024;10 万帧 `step()` 后无 NaN。
- **出口物**:可交付的 `Chunk` / `PhysicsWorld` API 文档 + 测试。

### M2 — 能建能挖能通电(对应第 3 周)
- **范围**:WS-03、WS-08。
- **依赖**:M1 的 `Chunk` 读写接口。
- **门禁**:16 种 Auto-Tile 掩码穷举正确;9 种房间配方正反例各一;AND/NOT 真值表;计数器回卷。

### M3 — 世界活着(对应第 5~6 周)
- **范围**:WS-04、WS-05。
- **依赖**:M1(物理)、M2(机关地板与电路,用于 Boss 破防)。
- **门禁**:AOI 32 格内外边界;休眠怪 0 CPU;8 条破防各自可判定;`bossScaledHp(38000, 16)` 为 408500(×10.75)。

### M4 — 数据能存能同步(对应第 4 周,可与 M2/M3 并行)
- **范围**:WS-07。
- **门禁**:DDL 表数与列名断言通过;差量编码只含变化字段且 <全量 1/10;16 人下行带宽有上界;4 类作弊被拒。

### M5 — 造物无限(对应第 7 周)
- **范围**:WS-06。
- **依赖**:冻结的商品表(价值分 V)。
- **门禁**:3 组以上 T_eff 手算对照;**同 hash 第二次调用 LLM 次数不增**;并发 10 请求只调 1 次;四档稀有度边界;像素矩阵 16×16。
- **风险处置**:数值崩坏由 `P_budget = round(8.5 × T_eff^0.82 × Q)` 封顶;LLM 只能出定性与权重,不得出攻击力。

### M6 — 打得爽救得快(对应第 5~6 周并行)
- **范围**:WS-10。
- **门禁**:伤害管线每步有断言;24 格共享经验四例;幽灵泡泡零惩罚;恶作剧锅双分支。

### M7 — 一起笑(对应第 8~9 周)
- **范围**:WS-11、WS-09。
- **依赖**:M1(举投)、M3(Boss 用于登背)、M6(料理)。
- **门禁**:35 项玩具 ID 集合恰为 `[221..255]`;平安盾免疫清单逐项;四模式各自计时与计分断言。

### M8 — 上线(对应第 10 周)
- **范围**:集成、压测、部署说明。
- **门禁**:`node scripts/verify.ts --all` 全绿;冻结层不变量 17 项全绿;文档结构 11 份全通过;给出 1GB 服务器(PM2 512MB 堆 + 2GB Swap)的 12 房间并发压测方案。

---

## 四、冻结层与变更管理

### 4.1 冻结文件清单(改一处 = 全员返工)

```
shared/types/tile.ts        shared/types/physics.ts
shared/types/entities.ts    shared/types/alchemy.ts
shared/constants/items.ts   shared/constants/mobs.ts
shared/constants/bosses.ts  shared/testing/harness.ts
shared/contracts/FREEZE.md
```

### 4.2 变更流程

1. 发现需要改签名 → 写进 `docs/CHANGE_REQUESTS.md`,`[CR-编号] 文件:符号 | 原因 | 影响面 | 建议改法`。
2. Lead 评估影响面 → 决定「拒绝 / 兼容扩展(新增符号,不改旧的)/ 破坏性改动(全员广播)」。
3. 破坏性改动必须:**先改冻结层 + 跑 `--frozen` 全绿 → 再广播给所有写手 → 全员重跑各自 `--only`**。
4. **禁止**任何写手在工作流中途直接 edit 冻结层文件。

### 4.3 已识别的兼容扩展点(不改签名即可加)

- `PhysicsWorld` 可新增 `addForceField()` 而不动物理契约。
- `Chunk` 可新增 `getRoofMask()` 而不动位布局。
- 炼金可新增 `AlchemyRecipeRow` 的可选字段(如 `tags_snapshot`)而不动已冻结必需字段。
- 电路可新增执行器类型(枚举值追加在尾部)而不动已有语义。

---

## 五、集成与验收矩阵

| 集成点 | 上游 | 下游 | 验证方式 |
| :--- | :--- | :--- | :--- |
| 地形 → 物理摩擦 | WS-01 FLOOR 层 ID | WS-02 μ 查表 | 断言 315→0.98、316→0.40、322→0.35 |
| 地形 → AI 避障 | WS-01 阻挡查询 | WS-04 45° 三点读 | 假世界里 3 格内墙体导致 P←45° |
| 物理 → 举投玩具 | WS-02 carry | WS-11 玩具 | `stackOffset(3)=2.55`、`carrierSpeedMul(4)=0.522` |
| 电路 → Boss 破防 | WS-08 四色通电 | WS-05 克洛诺斯 | 四角齐备才破盾,缺一不破 |
| 商品表 → 炼金 | 冻结 V 值 | WS-06 T_eff | 手算对照(712+125+116) |
| 炼金 → 客户端 | WS-06 像素矩阵 | WS-09 CanvasTexture | RGBA 长度 1024、行数列数 16 |
| 存档 → 网络 | WS-07 room_chunks | WS-01 反序列化 | 1024 字节 round-trip |
| 成长 → 战斗 | WS-10 等级倍率 | WS-02 移速 | `statsAtLevel(30).dmgMul = 1.87` |

---

## 六、风险登记与对策

| # | 风险 | 概率 | 影响 | 对策 |
| :--- | :--- | :--- | :--- | :--- |
| R1 | 炼金数值崩坏(生成攻击力 99999) | 中 | 高 | LLM 只输出定性 + 权重;数值全走封顶公式;`Util%` 硬顶 50% |
| R2 | 24 种生物 AI 被写成同一套 | 高 | 中 | 每组行为必须有独立断言;Lead 终审 `behaviors.ts` 的行数与分支数 |
| R3 | 8 条破防退化成文字描述 | 中 | 高 | 破防必须是返回 boolean 的判定函数 + 有测试 |
| R4 | 冻结层被写手偷改 | 中 | 高 | `scripts/verify.ts` 每次跑语法扫描 + 不变量;Lead 终审 diff |
| R5 | 2Hz 电路在 2 万格下超时 | 中 | 中 | WS-08 必须给出脏网络增量方案与收益倍数 |
| R6 | 1GB 内存下 chunk 常驻爆掉 | 低 | 高 | WS-01 给出内存上界数字;WS-07 给 60 秒休眠与 LRU 卸载 |
| R7 | 测试依赖第三方导致离线不可跑 | 中 | 中 | FREEZE §0 硬禁;`--only` 跑不通即返工 |
| R8 | 文档深度不足(空壳章节) | 中 | 中 | 验证器强制 10 节关键词 + 2000 字符下限 |
| R9 | 玩家刷经验/刷炼金 | 中 | 中 | WS-10 同怪去重;WS-06 缓存 hash 去重 + craft_count |
| R10 | 20Hz 带宽超手机网络 | 低 | 中 | WS-07 给出三档带宽上界与裁剪策略 |

---

## 七、质量门禁命令清单

```bash
# 冻结层不变量(17 项)
node scripts/verify.ts --frozen

# 单个工作流
node scripts/verify.ts --only WS-01
node scripts/verify.ts --only WS-06

# 文档结构
node scripts/verify.ts --docs

# 全量(冻结 + 文档 + 全部测试)
node scripts/verify.ts --all
```

`--all` 全绿是本项目唯一的「完成」定义。

---

## 七之二、当前进度快照(2026-11-14)

> ★ 本节是**时点快照**,不是冻结契约。冻结层的数字见 `README.md`「已冻结的核心数字」,
> 那一节受门禁校验;本节只做导航,过期不报红。**口径以 `node scripts/verify.ts --all` 的实际输出为准。**

### 7.2.1 门禁状态

```
verify --all --strict-reach --strict-taut --strict-inert  ⇒ **exit 0**(~17s)
用例 **1511 条 / 26 套件**(WS 1011 / 14 套件 · 基座 FND 500 / 12 套件)
跨 WS 集成 38/38 · 冻结层不变量 17 · 可擦除语法全绿
生产可达性 **88/98**(不可达 10 条已全部登记理由;白名单 10 条)
  欠账构成:等客户端入口 0 / 等编排层接线 1 / 等服务端机制 3 / 等客户端机制 2 / 等裁决 0
  ⇒ 10 条中 6 条欠账 + 4 条非欠账(gate-only 2 + 差集 2)
未决台账 133 条(109 未关闭 / **0 阻塞** / 24 已关闭)
```

### 7.2.2 门禁器件清单(除 `verify.ts` 外的独立审计器)

```
scripts/typecheck-baseline-audit.ts   类型检查**基线锁**(2026-11-14 新增,见陷阱 123/124)
scripts/gate-selfcheck.ts             门禁自检(独立复算生产文件数与非欠账分解)
scripts/judgement_audit.ts            判据形态审计(F 类:跑了子进程但没看退出码)
scripts/orphan-audit.ts               生产零引用清单
scripts/doc-line-audit.ts             文档行号引用审计
scripts/dup-export-audit.ts           同名导出审计(找「同名两处不同内容」)
scripts/count-audit.ts                计数对账
scripts/eol-audit.ts / bom-guard.ts   换行风格 / BOM 守卫
scripts/ts-paths.ts                   路径口径
scripts/selftest-exit-audit.ts        自测退出码
scripts/clean-temp.ts                 临时残留
scripts/content-lock.ts               内容基线锁(--capacity / --audit / --update)
```

### 7.2.3 尚未闭合的**架构级**缺口(全部有实测证据)

| 缺口 | 一句话 | 证据位置 | 状态 |
| :--- | :--- | :--- | :--- |
| **US2 网关联动** | `RoomRuntime` 与 `WorldSim` 互不依赖 ⇒ **真服务端跑不起世界** | `docs/ARCH-GAPS.md` 六层空缺 | **task-85 调查中** |
| **动作执行层** | `RoomAction` 22 个动作,`action` 报文**成功分支为空** ⇒ 玩家发指令服务端回 `allowed` 然后**什么都没发生**(无错误、无回执、连 `else` 都没有) | `docs/ARCH-GAPS.md` 第二层 | 待立项 |
| **生产入口可跑性** | `room.colyseus.ts` 是可达性**根**却**自己无法被 import**(装饰器 + CJS 命名导入双阻塞)⇒ 那 4 条 handler **零测试可覆盖** | `docs/ARCH-GAPS.md` 第三层 | 待立项 |
| **客户端联机层** | client 25 文件 9705 行,**网络痕迹全 0** ⇒ 是纯离线渲染器 | `docs/CLIENT-NET-GAP.md` | 部分(task-67/83) |

★ 三条缺口**互相咬合**:动作执行层没接,所以网关联动了也"玩家按了没反应";
而入口不可加载,所以动作执行层**结构上查不到**。立项时应一起做。

### 7.2.4 已完成的接线批次(可达性 69 → 88 的构成)

```
2026-11-12  WS-06 炼金 7 条 → WorldSim.forgeAlchemy()
            WS-05 Boss 3 条 → WorldSim 慢帧 bossRaid.tickBosses()
            WS-08 物流 1 条 → WorldSim 慢帧 tickLogisticsStep()
            客户端 8 模块   → three/ui_binding.ts + ui/panel_layout.ts
            客户端入口补齐  → client/index.html + main.ts
2026-11-13  driver.sqlite  → index.ts 注入 openNodeSqlite
2026-11-14  WS-11 缺口 A 4 条 → WorldSim 慢帧 tickPartyStep()(task-84)
            ★ 玩家立牌渲染(客户端首次真正画出玩家)(task-83)
```

### 7.2.5 判据纪律(踩过的坑,新增时请先读)

`docs/PROGRESS.md` 已积累 **124 条陷阱**。最新 6 条与本轮直接相关:

```
119  我把「当前状态」写成「期望值」 ⇒ 墓碑(断言把缺陷态当正确值钉住)
120  第三次踩陷阱 110(walkTs 的 build 跳过表漏掉整棵 server/src/build/)
121  队友标了「推论,不是实测」而我差点当结论写进决策文件
122  **改了一句理由文本,静默改掉一个被门禁校验的数字**(桶由理由文本的正则决定)
123  本仓有**能跑、结果确定、能抓真错误**的类型检查器,**而它不在任何门禁里**
124  **净额掩盖出现在判据设计自身**:只比总数的基线锁会被「修 1 条 + 引 1 条」骗过
```

★ 四条操作性判据(**每次派活都适用**):
```
A 把断言声称要守的东西**改坏** ⇒ 仍然绿 = 装饰
B 接线类改动需要一条**被切断路径**的对照
C 一条注入没红有**两种**解释:断言没牙 / 代码里有第二份实现顶着 —— 必须查清是哪种
D 还原必须 **SHA-256 逐字节一致**
```

---

## 八、未决问题(留待 Lead 终审)

1. **WS-06 双词条化学反应突变**的具体概率表由写手自拟,Lead 需复核是否与「Q 分档」产生数值叠加失控。
2. **WS-02 的叠罗汉 4 层上限**与 WS-11「人梯采集 Z=2」是否需要在 5 层(因为 Z=2 需要 2.55 高度)时放宽 —— 当前 `CARRY_MAX_DEPTH=4` 的高度为 2.55,足够 Z=2 采集,结论:不放宽。
3. **WS-09 LOD 的 <80 万面**是否与 1024×1024 世界的实际需求匹配,需要写手给出实测假设。
4. **WS-07 的 60 秒休眠**与玩家「切后台打盹分经验」是两套机制,需确保打盹玩家不触发房间休眠(打盹 ≠ 离线)。
5. 手册 §3.7 的 437~440 载具被归入 AUTOMATION 分表(40 项内含),与 WS-11 的派对模式存在职责交叉,终审时确认由 WS-11 只做「调用方」。
