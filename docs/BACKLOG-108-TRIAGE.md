# 108 条未决台账 · 逐条定性(2026-11-14)

> **来源与口径**:本文是一次**只读普查**的产物(未运行门禁、未改 ROOT 一个字节)。
> 普查者只被要求给事实,不做产品判断。
>
> **主控(Lead)抽查**:抽查了 3 组代表性结论,全部成立 ——
> `server/src/net/ws_server.ts:834` = `export const PROTOCOL_VERSION = 1;`;
> `PASS_WINDOW`(`server/src/physics/carry.ts:47`)与 `RAID_PARTICIPATION_RADIUS`
> (`server/src/bosses/raid.ts:37`)在全仓 158 个 .ts 里**只有定义处、0 消费者**;
> `tests/WS-FND-06.test.ts` 里 `S_LOGIC_MIN` / `PROF_MAX_LEVEL` 各**只出现 1 次**(就是 import 行)⇒ 死导入成立。
>
> ⚠️ **抽查只覆盖 3 组,不是全表复核**。本文的价值是「把 108 条变成可复核的分类」,
> 不是「每一条都已证实」。凡表中写「未核实」的,就是**未核实**。

## 四档合计校验(必须成立)

```
档 1 已实现未标   24
档 2 真欠账       31
档 3 待裁         49
档 4 我不知道      4
                 ---
合计             108   ✓ 与 `node scripts/backlog.ts` 的「未关闭 108」一致
```

★ 「**我不知道**」是**独立且被计数**的一档,没有折进任何默认桶 ——
  这是本仓硬纪律(`docs/PROGRESS.md` 陷阱 131):默认桶通常是最大的那个,
  错误率最高、可见度最低。

## 三个必须一起读的口径警告(出自普查,主控认可)

1. **133 条 ≠ 133 个不同问题**:同一 ID 在 11 份 `ADVERSARIAL-REVIEW` 文档里**大量重复**
   (`U9 两门禁缺交叉标注` 出现 5 次、`WS-01 未复核` 6 次、`动态 import()` 3 次、`PROTOCOL_VERSION` 4 次)。
2. **台账有口径盲区**:`docs/ADVERSARIAL-REVIEW-12.md`(最新、40 KB)**没有「未决」标题**
   ⇒ 它里面的新发现(同义反复 32 条未按可达性拆分、台账「阻塞 0 条」是**恒零常量**)**一条都不在 108 里**。
3. **台账是移动靶**:同一批数字在不同文档里不同(`未关闭 109/24` vs `108/25`;
   同义反复白名单 `32` vs `23`)。**本次未重跑门禁**,凡涉及这些的行都标了「未核实」。

---
﻿# 108 条未决台账逐条定性(只读调查)

ROOT = `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\2_5d_sandbox`
调查方式:**只读**。中间文件只写在 `%TEMP%` 与 scratch;ROOT 下一个字节都没改。
未运行被禁命令(`verify.ts --all` / `--strict-selfcheck` / `gate-selfcheck.ts`)。

## 0. 方法与口径(先纠正任务书的一个前提)

**① 台账没有「数据表」。** 任务书假设「权威来源是 `scripts/backlog.ts` 里的数据表」—— 实测**不成立**。
`scripts/backlog.ts`(623 行)里只有两张东西:
- `STALE_PROBES`(`:156-416`,24 条**过时探针**,不是台账条目);
- `collectOpenItems()`(`:419-457`),它**解析 `docs/*.md`** 的「未决」章节抽取条目(正则见 `:428` `^##+\s*\d*\.?\s*未决`、`:439` 行正则 `^\|\s*\*{0,2}(U|F|D|US)(\d+)\*{0,2}\s*\|`)。
⇒ **权威来源是 `docs/*.md` 的未决表格本身**,`backlog.ts` 只是解析器。
两种取数方式我都用了,结论一致:
- A. 跑 `node scripts/backlog.ts`(输出 `总计 133 条 / 未关闭 108 条 / 阻塞 0 条 / 已关闭 25 条`,重定向到 `%TEMP%` 后分段读;其 `entry.text` 被 `slice(0,110)` 截断,`open=108` 与本文一致);
- B. 按同一正则从 `docs/*.md` 直接抽**未截断原文行**(得到逐条 `doc:line` + 完整表格三列)。
B 更准(A 丢掉了「现状/说明」列),本文逐条表用 B,计数用 A 复核。25 条已关闭条目不计入。

**② 四种档位的判定规则(我实际用的,写清以便复核):**
| 档 | 触发条件(机械规则) |
|---|---|
| 1 已实现未标 | 我能指到**代码/断言**已经满足该条主张的位置(`path:line`),或该条台账行自称「已完成/已修完/无需动作」且我能核到对应实现 |
| 2 真欠账 | 现状确实没有,且台账给出的下一步是**可施工**的(落点能指到文件/函数/断言) |
| 3 待裁 | 台账自己写明需要某方裁决(需要谁列非空),或该条本质是 yes/no 的数值/契约/去留选择 |
| 4 我不知道 | **落点或前提我核不到**(台账未写、doc 内无清单、缺外部条件)。单列计数,**不折进上面任何一档** |

**③ 已知局限(先说,免得被当成结论):**
- 台账是**移动靶**:`docs/ADVERSARIAL-REVIEW-12.md`(`:200`)引用的门禁读数是 `未关闭 109 / 已关闭 24`,我这次跑是 `108 / 25`;`docs/ADVERSARIAL-REVIEW-11.md:187` 报「同义反复候选 命中 32 条(白名单 32 条)」,`docs/TASK-86-tautology-literal-anchors.md:46-47` 报「命中 23 条(白名单 23 条)」。我**没有**重跑门禁(被禁),两处读数不一致 → 相关行的白名单条数标 **未核实**。
- `docs/ADVERSARIAL-REVIEW-12.md`(40 KB,最新 mtime 23:19)**不进台账**:它没有 `## ...未决` 标题 ⇒ 它里面的新发现(同义反复 32 条未按可达性拆分、台账「阻塞 0 条」是恒零常量)**一条都不在 108 里**。这是台账的口径盲区。
- 同一 ID 在 11 份 REVIEW 文档里**大量重复**(例:`U9 两门禁缺交叉标注` 出现 5 次、`WS-01 未复核` 6 次、`动态 import() 不跟踪` 3 次、`PROTOCOL_VERSION` 4 次)⇒ 133 条条目数 ≠ 133 个不同问题。

## 1. 逐条表(108 条)

图例:档1=已实现未标,档2=真欠账,档3=待裁,档4=我不知道。证据列「无」表示台账行未给落点且我未核到。

### ADVERSARIAL-REVIEW.md(4 条)
| ID | 原文标题(截自台账行) | 档 | 证据(path:line) | 一句话依据 |
|---|---|---|---|---|
| U1 | `WS-FND-04` H1–H4 的措辞与真实回归守卫的关系(F1) | 3 | docs/ADVERSARIAL-REVIEW.md:279 | 台账写「owner 决定是改措辞还是补真实注入」⇒ 要裁 |
| U2 | `WS-FND-05` 计时断言灵敏度 600×(F2) | 3 | docs/ADVERSARIAL-REVIEW.md:280 | 台账写「需明确可接受的最低灵敏度这一产品判断」⇒ 要裁 |
| U3 | 组合注入覆盖缺口(`rowAligned`+`contentRows` 同时坏) | 2 | scripts/inject.ts:332-345(单用例循环)、docs/ADVERSARIAL-REVIEW.md:281 | 缺:组合注入框架;落点=注入器 |
| U4 | 本复核只覆盖三组;其余 13 个套件未做独立注入 | 2 | docs/ADVERSARIAL-REVIEW.md:282 | 缺:13 套件注入;落点 tests/ + 注入器 |

### ADVERSARIAL-REVIEW-2.md(4 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | `damage.ts`/`components.ts` 生产接线 | 3 | docs/ADVERSARIAL-REVIEW-2.md:456 | 「owner 决策何时接入 `world_sim`」⇒ 要裁 |
| U2 | G-1/G-2 两处假绿的修复 | 2 | **G-1 已修**:tests/WS-10.test.ts:1151-1158(改字面量 3);**G-2 未修**:tests/WS-08.test.ts:687 `ok(spring.state.cooldown > 0)` 仍是单侧边界 | 一条已修一条未修 ⇒ 仍欠 G-2 |
| U3 | 剩余 12 个套件未做独立注入 | 2 | docs/ADVERSARIAL-REVIEW-2.md:458 | 人力;落点 tests/ |
| U4 | 8 次注入因名称/签名不符未命中 | 2 | scripts/inject.ts:338-342(只报 `ineffective`) | 缺:符号级注入工具;落点=注入器 |

### ADVERSARIAL-REVIEW-3.md(4 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | S1–S6 六处修复 | 2 | 清单 docs/ADVERSARIAL-REVIEW-3.md:331-336;S4/S5 **仍在**:server/src/physics/carry.ts:47、server/src/bosses/raid.ts:37(全仓仅定义,零引用) | 死常量未删未接 ⇒ 欠 |
| U2 | S7 全仓同义反复专项扫描 | 1 | scripts/verify.ts:63(`--strict-taut`)、:2863「同义反复候选门禁(S11)」、:3395 输出节 | 门禁已实现全仓扫描 |
| U3 | 剩余 9 个套件(WS-01 等)未做独立注入 | 2 | docs/ADVERSARIAL-REVIEW-3.md:353 | 人力;落点 tests/ |
| U4 | 本轮 6 次无效注入 | 2 | docs/ADVERSARIAL-REVIEW-3.md:354 | 同 REVIEW-2 U4 |

### ADVERSARIAL-REVIEW-4.md(5 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | 21 处同义反复修复(S8) | 2 | docs/TASK-86-tautology-literal-anchors.md:46-47(白名单 34→23,摘 11);docs/ADVERSARIAL-REVIEW-12.md:176(报 32 条)**未核实** | 部分已修,仍有白名单登记 |
| U2 | `PROTOCOL_VERSION`(S9) | 1 | server/src/net/ws_server.ts:834 `export const PROTOCOL_VERSION = 1;`(字面量) | 已换字面量 |
| U3 | 11 个「非常量表达式」常量未验证 | 2 | docs/ADVERSARIAL-REVIEW-4.md:291 | 缺:改注入手法;落点 scripts/inject.ts |
| U4 | 3 个死导入 | 2 | tests/WS-FND-06.test.ts:65(`S_LOGIC_MIN`,`S_LOGIC_MAX`,`PROF_MAX_LEVEL` 只在 import 行出现) | 死导入仍在 |
| U5 | S11 静态门禁是否实施 | 1 | scripts/verify.ts:63、:2863、:3395 | 已实施 ⇒ 该条应关 |

### ADVERSARIAL-REVIEW-5.md(6 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | 21 处同义反复修复(各 owner) | 2 | 同 REVIEW-4 U1 | 「进行中」 |
| U2 | `PROTOCOL_VERSION` 已换字面量?(待核) | 1 | server/src/net/ws_server.ts:834 | 已核到字面量 |
| U3 | S11 只覆盖第二实参 | 2 | scripts/verify.ts:3422(门禁正则,被 docs/TASK-86:22 引用) | 门禁覆盖面窄,可扩 |
| U4 | 3 个死导入(REVIEW-4) | 2 | tests/WS-FND-06.test.ts:65 | 同 REVIEW-4 U4 |
| U5 | WS-01 未复核 | 1 | docs/ADVERSARIAL-REVIEW-10.md:132-144(「WS-01 无实质缺陷」)+ tests/WS-01.test.ts | 复核已完成 |
| U7 | U3 剩余 3 项未注入(有区间/字面量锚点) | 4 | 无 | 台账未写是哪 3 项,REVIEW-5 全篇无该清单 ⇒ **我不知道** |

### ADVERSARIAL-REVIEW-6.md(5 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | 21 处同义反复修复 | 2 | 同 REVIEW-4 U1 | 「0/21,尚未开始」 |
| U2 | `PROTOCOL_VERSION` | 1 | server/src/net/ws_server.ts:834 | 现已修(台账写「已核,未修」已陈旧) |
| U3 | `ok(...)` 形态不覆盖 | 1 | 决策 docs/ADVERSARIAL-REVIEW-7.md:284(「已定保持」);门禁现状 scripts/verify.ts:3422 只覆盖 eq/near 第二实参 | 已裁决保持,代码与裁决一致 ⇒ 应关行 |
| U5 | WS-01 未复核 | 1 | 同 REVIEW-5 U5 | 已完成 |
| U8 | `WS-10.test.ts` mtime 变动但目标未修 | 3 | docs/ADVERSARIAL-REVIEW-6.md:180 | 裁:该缺口归 task-16 跟踪还是就此关行(无具名裁决人) |

### ADVERSARIAL-REVIEW-7.md(6 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | 33 条同义反复仍有白名单登记 | 2 | 同 REVIEW-4 U1 | 修复进行中 |
| U2 | `PROTOCOL_VERSION` | 1 | server/src/net/ws_server.ts:834;docs/ADVERSARIAL-REVIEW-7.md:283 自述「已修完并核实(可关闭)」 | 可关未关 |
| U3 | `ok(...)` 形态不覆盖 | 1 | 同 REVIEW-6 U3 | 已定保持 |
| U5 | WS-01 未复核 | 1 | 同 REVIEW-5 U5 | 已完成 |
| U9 | 两门禁缺交叉标注 | 2 | docs/ADVERSARIAL-REVIEW-7.md:135-159(§5.2);构造方案 docs/ADVERSARIAL-REVIEW-12.md:176-192;落点=verify.ts 两白名单输出节(:2674 同义反复白名单 / `UNREACHABLE_EXEMPT`) | 缺:两门禁交叉标注输出,可施工 |
| U10 | 注入工具的还原路径前置检查 | 1 | scripts/inject.ts:306-309(深度闸)、:314-327(基线洁净闸)、:366-371/:391(SHA-256 还原核对) | 「已加」在代码里成立(是否即台账所指那处,未完全核实) |

### ADVERSARIAL-REVIEW-8.md(4 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | `WS-06::ICON_SIZE` 552/553 | 1 | tests/WS-06.test.ts:589-595(期望值改字面量 16 + `eq(ICON_SIZE,16)` 双向锚);docs/ADVERSARIAL-REVIEW-9.md:144(「552/553 已改字面量」) | 已修,台账未关 |
| U5 | WS-01 未复核 | 1 | 同 REVIEW-5 U5 | 已完成 |
| U9 | 两门禁缺交叉标注 | 2 | 同 REVIEW-7 U9 | 可施工 |
| U11 | R6 是否有同类「注释在 import 块」问题 | 2 | docs/ADVERSARIAL-REVIEW-8.md:218(S26:「R6 走 `resolveImport` 路径」) | 缺:一次定向复核;落点 scripts/verify.ts 的 `resolveImport` |

### ADVERSARIAL-REVIEW-9.md(5 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | `WS-06::ICON_SIZE` 的 111/112 | 1 | docs/ADVERSARIAL-REVIEW-9.md:135(实测仍变红,有牙);tests/WS-06.test.ts:128-142 | 「应保留、无需动作」⇒ 应关行 |
| U5 | WS-01 未复核 | 1 | 同 REVIEW-5 U5 | 已完成 |
| U9 | 两门禁缺交叉标注 | 2 | 同 REVIEW-7 U9 | 可施工 |
| U12 | `stripCommentsOnly` 其它调用方是否有同类问题 | 1 | scripts/verify.ts:2808(「必须用代码态扫描(U12):旧版跑 stripCommentsOnly+正则」)、:3232;docs/ADVERSARIAL-REVIEW-11.md:200-201(普查 7 处/同病 4 处) | 普查已做且已修 |
| U13 | 动态 `import()` 不跟踪 | 3 | docs/ADVERSARIAL-REVIEW-8.md:194(全仓无此形态) | 裁:接受该已知边界并关行(无具名裁决人) |

### ADVERSARIAL-REVIEW-10.md(5 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U5 | WS-01 复核 | 1 | docs/ADVERSARIAL-REVIEW-10.md:132-144;tests/WS-01.test.ts | 自查「已完成」未关行 |
| U12 | `stripCommentsOnly` 其它调用方 | 1 | 同 REVIEW-9 U12 + docs/ADVERSARIAL-REVIEW-11.md:226(「已完成」) | 已完成 |
| U13 | 动态 `import()` 不跟踪 | 3 | 同 REVIEW-9 U13 | 同上 |
| U14 | `:740` 冗余清理 | 3 | 落点 tests/WS-01.test.ts:740;docs/ADVERSARIAL-REVIEW-10.md:187(「需 Lead 批」,改测试文件会动 README 数字) | 裁:是否做该可选清理 |
| U9 | 两门禁缺交叉标注 | 2 | 同 REVIEW-7 U9 | 可施工 |

### ADVERSARIAL-REVIEW-11.md(4 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U12 | 「剥注释」调用方普查 | 1 | docs/ADVERSARIAL-REVIEW-11.md:226;scripts/verify.ts:2808 | 已完成 |
| U15 | `backlog.ts` `STALE_PROBES` 代码态化 | 1 | **已在代码里**:scripts/backlog.ts:102(`stripToCode`)、:515、:541(`detectStale` 跑代码态)、:100(实测 17 条探针仍命中) | 台账写「待 Lead 批(S34)」但实现已落地 |
| U13 | 动态 `import()` 不跟踪 | 3 | 同 REVIEW-9 U13 | 同上 |
| U9 | 两门禁缺交叉标注 | 2 | 同 REVIEW-7 U9 | 可施工 |

### DAMAGE-LOOP.md(7 条;D6/D9 已划掉,不计)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| D1 | 玩家受伤后击退与硬直未实现 | 2 | 探针**在岗** scripts/backlog.ts:232-239;docs/BACKLOG-AUDIT.md:199(`applyImpulse` 定义在 server/src/physics/world.ts:621,生产调用点 0) | 缺:写回 PhysicsBody;落点 server/src/sim/world_sim.ts |
| D2 | 生物攻击不检查视线 | 2 | 探针在岗 scripts/backlog.ts:240-247;docs/BACKLOG-AUDIT.md:200 | 缺:射线遮挡;落点 `resolveStrikes`/world_sim.ts |
| D3 | PvP 与「Boss 技能对玩家的特殊效果」未做 | 2 | 探针在岗 scripts/backlog.ts:248-255;docs/BACKLOG-AUDIT.md:201 | 缺:玩家侧状态机/PvP 分支;落点 server/src/combat/damage.ts |
| D4 | 伤害无元素抗性 | 2 | 探针在岗 scripts/backlog.ts:256-263;docs/BACKLOG-AUDIT.md:202 | 缺:玩家侧抗性系数;落点 server/src/combat/vitals.ts |
| D5 | `tanuki_ambush` 致盲只有 `mem.blindSec` | 2 | 探针在岗 scripts/backlog.ts:264-271;docs/BACKLOG-AUDIT.md:203 | 缺:玩家侧 blind 状态;落点 combat/vitals.ts |
| D7 | 玩家血量不持久化(部分解决) | 2 | server/src/index.ts:6-18(自述「server/src/** 里 `worldSaveHost = ...` 赋值 0 处」)、server/src/net/room.ts:793/837;探针在岗 scripts/backlog.ts:280-287 | 缺:一行装配;落点 `room.colyseus.ts` 挂 `worldSaveHost` |
| D8 | `resolveStrikes` 的 `blockedKeys` 编排层不传它 | 3 | docs/BACKLOG-AUDIT.md:205(`world_sim.ts:688-693` 第三参硬编码 `undefined`);docs/DAMAGE-LOOP.md:324(自称「不是死参数」,为预测式结算预留) | 裁:该预留入口是保留还是删除/接线(台账未写裁决人) |

### EVENT-BUS.md(4 条;U1/U3/U5/U8 已归档)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U2 | 事件是否需要跨帧队列 | 3 | docs/BACKLOG-AUDIT.md:213(`bus.ts:265` 当帧 drain) | 裁:是否需要延迟调度层(条件式需求) |
| U4 | `lastMobTicks` 是否要进 `SimFrameReport` | 3 | docs/BACKLOG-AUDIT.md:214 | 裁:观测粒度口径 |
| U6 | 事件名的命名空间 | 3 | docs/BACKLOG-AUDIT.md:215(30 emit / 29 种,全 snake_case,无规范模块) | 裁:是否立命名空间规范(会改契约) |
| U7 | `unknownMobs` 是否应为硬失败 | 3 | docs/BACKLOG-AUDIT.md:216(只 push 不抛) | 裁:硬失败 vs 收集 |

### EXTENDING.md(5 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | `scripts/verify.ts:125,141` 硬编码 320 | 3 | 现状 scripts/verify.ts:596、:612(行号已漂移,值仍在);docs/EXTENDING.md:633 自称「有意为之(内容基线锁)」 | 裁:是否改为读基线文件 |
| U2 | 槽位仍定义为数组下标(`baseline.ts:78`) | 3 | docs/EXTENDING.md:634 | 裁:是否投入「按 ID 取槽位 + 存档迁移」 |
| U3 | 12 位 vs U16 双 ID 宽度 | 3 | docs/EXTENDING.md:635 | 裁:是否统一位宽(涉及网络字段) |
| U4 | `INVENTORY_SLOTS=336` 仅余 16 个空位 | 3 | docs/EXTENDING.md:636 | 裁:何时扩容/加行 |
| U5 | `AI_CRAFTED` 类别当前无静态物品 | 1 | tests/WS-09.test.ts:1616-1617(`eq(n,0,'AI_CRAFTED 为运行期分类,静态物品表中应为 0 项')`)、shared/types/entities.ts:20;scripts/verify.ts:5834(`auditContent()`) | 台账自称「无需处理」且已有断言 ⇒ 应关行 |

### FLUID-BUDGET.md(6 条;F1 已划掉)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| F2 | `processed` 名不副实(全干世界也报 1024) | 2 | server/src/world/fluid.ts:360(`report.processed = limit`)、:361(`report.visited`)、:105 注释(「新代码请读 visited/active」)、:103(4 条锁 `processed===256/1024` 的断言) | 缺:彻底改名(会动 4 条断言);落点 fluid.ts:105/360 |
| F3 | 世界面积小(≤约 1282)时活跃追踪是净开销 | 3 | docs/BACKLOG-AUDIT.md:223(fluid.ts 无按面积分支) | 裁:是否引入按面积分支(现无实测痛点) |
| F4 | 活跃集合无上限 | 2 | 探针在岗 scripts/backlog.ts:289-297;docs/BACKLOG-AUDIT.md:224(`activeArr` 只增不封顶) | 缺:上限/采样淘汰;落点 server/src/world/fluid.ts 活跃集 |
| F5 | 流体与实体交互全缺(游泳/淹没/水车/扑灭火焰) | 2 | 探针在岗 scripts/backlog.ts:298-305;docs/BACKLOG-AUDIT.md:225 | 缺:实体层交互;落点 fluid.ts + 实体层 |
| F6 | 相变只判四邻,不判斜角 | 3 | docs/BACKLOG-AUDIT.md:226 | 手册未明确 ⇒ 裁:是否含斜角 |
| F7 | `deltaBuf` 复用时去重成双保险 | 1 | server/src/world/fluid.ts:172(`deltaBuf`)、:329(`touched = this.fluxPass(...)`)、:340(`for (const i of touched)`)、:411 | 台账自称「这不是 bug…去重仍应保留」⇒ 应关行 |

### PERF-BOUNDS.md(4 条)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | LLM 炼金端到端延迟(5ms 缓存 / 0.8s 生成) | 4 | 无;docs/PERF-BOUNDS.md:293、docs/BACKLOG-AUDIT.md:191(缺 Gemini 凭证与网络出口) | 缺外部条件,**我无法判断**(不折进其它档) |
| U2 | 1GB 服务器 / PM2 512MB 堆 / 12 房间并发压测 | 4 | 无;docs/PERF-BOUNDS.md:294(缺 cgroup/PM2 环境 + 真实并发客户端) | 同上 |
| U3 | 三条候选断言的手册出处 | 3 | docs/PERF-BOUNDS.md:295(手册原文中不存在,已按来源标注) | 裁:三条 `not-in-manual` 是升级为可判定还是删除 |
| U4 | 客户端渲染帧率与 GC 停顿 | 4 | 无;docs/PERF-BOUNDS.md:296(需真实浏览器) | 同上 |

### SIM-orchestration.md(1 条;US1–US6/US8 已划掉)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| US7 | 无回放/录制 | 3 | 探针在岗 scripts/backlog.ts:351-361;docs/BACKLOG-AUDIT.md:234;落点 server/src/sim/world_sim.ts:205(rng 已注入,前提在位) | 归属列写「Lead(是否要做)」⇒ 裁 |

### WS-03-build.md(10 条,**全部归属列非空**)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | 蓝图 16×16 上限 | 3 | docs/WS-03-build.md:507;常量 `BLUEPRINT_CELLS` docs/BACKLOG-AUDIT.md:273 | 裁:做大蓝图?会改契约 + 波及编解码与中继队列 |
| U2 | 房间评分是否要暴露给玩家 | 3 | docs/WS-03-build.md:508 | 裁:UI 呈现(★三档 vs 裸分) |
| U3 | `scanRooms` 是否要增量维护 | 3 | 探针在岗 scripts/backlog.ts:364-371;docs/BACKLOG-AUDIT.md:240(`rooms.ts:87` 全量) | 裁:保持全量还是做增量 |
| U4 | `danglingEnds` 的判定阈值 | 3 | docs/BACKLOG-AUDIT.md:241(`wiring_view.ts:230` `if (deg <= 1)`) | 裁:阈值是否改(需组件位置信息) |
| U5 | 中继建造的并发上限 | 3 | 探针在岗 scripts/backlog.ts:372-379;docs/BACKLOG-AUDIT.md:242(`blueprint.ts:595`) | 裁:是否加并发上限及取值 |
| U6 | `canTraverse` 的权威性 | 3 | docs/BACKLOG-AUDIT.md:243(`autotile.ts:358` 只给建议结论) | 裁:是否收归 WS-02 单点裁决 |
| U7 | 蓝图是否允许含暗线 | 3 | 探针在岗 scripts/backlog.ts:380-387;docs/BACKLOG-AUDIT.md:244 | 裁:蓝图是否剥离 wire 位 |
| U8 | 多语言(词表中文硬编码) | 3 | docs/WS-03-build.md:514 | 裁:是否出海/外置词表 |
| U9 | `stampBoxRoom` 是否属于生产代码 | 3 | docs/WS-03-build.md:515 | 裁:归属(保留 + 文档标注) |
| U10 | `FLOOR_PALETTE` 槽位耗尽的处理 | 3 | docs/WS-03-build.md:516(30/64) | 裁:是否扩 `floor` 位宽(改冻结层) |

### WS-06-alchemy.md(7 条;U1/U3/U8 已划掉)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U2 | `util` 的消费口径 | 3 | docs/BACKLOG-AUDIT.md:251(`attributes.ts:58-59` `UTIL_MUL`/`UTIL_CAP_PERCENT`) | 裁:实用度加成映射(需 WS-09 玩法层) |
| U4 | `item_category` 与 `primary_mechanic` 的自洽性 | 3 | 探针在岗 scripts/backlog.ts:390-397;docs/BACKLOG-AUDIT.md:252 | 裁:是否加「类别×机制」白名单矩阵 |
| U5 | 像素立牌是否要支持非 16×16 | 3 | docs/BACKLOG-AUDIT.md:277(`ICON_SIZE=16`) | 裁:是否加 `icon_size`(改冻结契约) |
| U6 | `S_logic` 是否应允许 LLM 完全自由 | 3 | docs/BACKLOG-AUDIT.md:253(`S_LOGIC_MIN=0.6`/`S_LOGIC_MAX=1.3`;台账正文写 0.80/1.50 —— 两处数字**不一致,未核实**) | 裁:是否设 >上限通道 |
| U7 | 缓存一致性策略 | 3 | docs/BACKLOG-AUDIT.md:254(`cache.ts:98` 直接返回 row) | 裁:数值热更 vs 一经发现永不改变 |
| U9 | 降级产物的可读性下限 | 3 | docs/WS-06-alchemy.md:758(归属「WS-10 体验」) | 裁:是否维护高美学词表 |
| U10 | 多语言(提示词/词表中文硬编码) | 3 | docs/WS-06-alchemy.md:759 | 裁:是否外置资源包 |

### WS-09-client-render.md(11 条;U8 已划掉)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U1 | `stage_assembly.ts` 依赖 `three`,而仓库零依赖 | 3 | 探针在岗 scripts/backlog.ts:400-407 | 裁:是否做 three 相容层 / 改由宿主适配 |
| U2 | 顶点颜色 vs 纹理图集 | 3 | docs/BACKLOG-AUDIT.md:176(归属 Lead + 美术) | 裁:美术管线岔路口 |
| U3 | `flattenTree` 的叶子聚合口径 | 3 | docs/WS-09-client-render.md:718 | 裁:是否保留父节点溯源 |
| U4 | `estimateFaceBreakdown` 的估算精度 | 3 | docs/WS-09-client-render.md:719 | 裁:是否按 Chunk 精确算 |
| U5 | 染色 `sprayAttenuation` 的距离衰减曲线 | 3 | docs/BACKLOG-AUDIT.md:177(归属 美术 + Lead) | 裁:手感调参(无客观判据) |
| U6 | 粒子预设的 `rate` 是否随画质档缩放 | 3 | docs/BACKLOG-AUDIT.md:178(需低端机实测) | 裁:是否加全局系数 |
| U7 | `BossTelegraphRow` 与实际预警圈的字段对齐 | 3 | docs/BACKLOG-AUDIT.md:179(需逐 Boss 人工核对,WS-05) | 裁:谁做逐 Boss 核对 |
| U9 | `client/src/**` 中文注释曾被 GBK 污染 | 3 | docs/BACKLOG-AUDIT.md:180(有损字节需人工重写) | 裁:是否人工重写残留 |
| U10 | `zoomLevels` 与 `ZOOM_LEVELS` 双导出 | 3 | docs/BACKLOG-AUDIT.md:181 | 裁:是否清理并加 deprecation |
| U11 | 4-邻域 vs 8-邻域的屋顶连通域 | 3 | 探针在岗 scripts/backlog.ts:409-415;docs/BACKLOG-AUDIT.md:275(`NEIGHBOR4_DX/DY`) | 裁:是否改 8-邻域/对角权重 |
| U12 | `frustumCull` 返回完整 `ChunkInput` 的内存代价 | 3 | docs/BACKLOG-AUDIT.md:182(当前零拷贝,假设未发生) | 裁:是否需要对象副本 |

### WS-11-coop-prank-party.md(1 条;其余 11 条已划掉)
| ID | 原文标题 | 档 | 证据 | 依据 |
|---|---|---|---|---|
| U2 | 订单单件分改用望远镜差值 `round(P·dn/N) − round(P·dn−1/N)` | 1 | **已实现**:server/src/coop/rush_order.ts:262-263(`awardedBefore`/`awardedAfter`)、:236-257 注释(「原实现每交一次取整一次」→ 已换望远镜差值) | 裁决已落地 ⇒ 应关行 |

## 2. 合计校验

| 档 | 条数 |
|---|---:|
| 档1 已实现未标 | **24** |
| 档2 真欠账 | **31** |
| 档3 待裁 | **49** |
| 档4 我不知道 | **4** |
| **合计** | **108** |

24 + 31 + 49 + 4 = **108** ✓(与 `node scripts/backlog.ts` 的「未关闭 108」逐条对齐,无余数、无四舍五入)

**按文档分档明细(交叉校验,每列合计 = 该文档未关闭条数):**

| 文档 | 未关闭 | 档1 | 档2 | 档3 | 档4 |
|---|---:|---:|---:|---:|---:|
| ADVERSARIAL-REVIEW.md | 4 | 0 | 2 | 2 | 0 |
| ADVERSARIAL-REVIEW-2 | 4 | 0 | 3 | 1 | 0 |
| ADVERSARIAL-REVIEW-3 | 4 | 1 | 3 | 0 | 0 |
| ADVERSARIAL-REVIEW-4 | 5 | 2 | 3 | 0 | 0 |
| ADVERSARIAL-REVIEW-5 | 6 | 2 | 3 | 0 | 1 |
| ADVERSARIAL-REVIEW-6 | 5 | 3 | 1 | 1 | 0 |
| ADVERSARIAL-REVIEW-7 | 6 | 4 | 2 | 0 | 0 |
| ADVERSARIAL-REVIEW-8 | 4 | 2 | 2 | 0 | 0 |
| ADVERSARIAL-REVIEW-9 | 5 | 3 | 1 | 1 | 0 |
| ADVERSARIAL-REVIEW-10 | 5 | 2 | 1 | 2 | 0 |
| ADVERSARIAL-REVIEW-11 | 4 | 2 | 1 | 1 | 0 |
| DAMAGE-LOOP | 7 | 0 | 6 | 1 | 0 |
| EVENT-BUS | 4 | 0 | 0 | 4 | 0 |
| EXTENDING | 5 | 1 | 0 | 4 | 0 |
| FLUID-BUDGET | 6 | 1 | 3 | 2 | 0 |
| PERF-BOUNDS | 4 | 0 | 0 | 1 | 3 |
| SIM-orchestration | 1 | 0 | 0 | 1 | 0 |
| WS-03-build | 10 | 0 | 0 | 10 | 0 |
| WS-06-alchemy | 7 | 0 | 0 | 7 | 0 |
| WS-09-client-render | 11 | 0 | 0 | 11 | 0 |
| WS-11-coop-prank-party | 1 | 1 | 0 | 0 | 0 |
| **合计** | **108** | **24** | **31** | **49** | **4** |

## 3. 档2(真欠账,31 条)按「落点模块」分组

| # | 落点模块 | 条目 ID(带文档前缀) | 缺什么 |
|---:|---|---|---|
| 1 | `tests/WS-08.test.ts:687` | REVIEW-2 U2(剩一半) | 断言只测一侧(`cooldown > 0`),改常量不报警 |
| 2 | `tests/WS-FND-06.test.ts:65` | REVIEW-4 U4、REVIEW-5 U4 | 删 3 个死导入(`S_LOGIC_MIN`/`S_LOGIC_MAX`/`PROF_MAX_LEVEL`) |
| 3 | `tests/`(套件级注入覆盖) | REVIEW U4、REVIEW-2 U3、REVIEW-3 U3 | 13/12/9 个套件未做独立注入 |
| 4 | `scripts/inject.ts`(注入工具) | REVIEW U3、REVIEW-2 U4、REVIEW-3 U4、REVIEW-4 U3 | 组合注入框架 / 符号级注入 / 「非常量表达式」常量注入手法 |
| 5 | `tests/*.test.ts`(同义反复断言换字面量) | REVIEW-4 U1、REVIEW-5 U1、REVIEW-6 U1、REVIEW-7 U1 | 白名单里仍有同义反复(34→23 后仍有 23~32,读数不一致,**未核实**) |
| 6 | `scripts/verify.ts`(门禁覆盖面/交叉标注/resolveImport) | REVIEW-5 U3、REVIEW-7 U9、REVIEW-8 U9、REVIEW-9 U9、REVIEW-10 U9、REVIEW-11 U9、REVIEW-8 U11 | 只覆盖 eq/near 第二实参;两白名单无交叉标注;`resolveImport` 路径未复核 |
| 7 | `server/src/physics/carry.ts:47` + `server/src/bosses/raid.ts:37` | REVIEW-3 U1(剩 S4/S5) | 死常量(`PASS_WINDOW`、`RAID_PARTICIPATION_RADIUS`)全仓仅定义,删除或接入 |
| 8 | `server/src/sim/world_sim.ts` + `server/src/combat/*` | D1、D2、D3、D4、D5、D7 | 击退/硬直写回、视线遮挡、PvP 与 Boss 特殊效果、玩家侧元素抗性、玩家侧致盲、`worldSaveHost` 一行装配 |
| 9 | `server/src/world/fluid.ts` | F2、F4、F5 | `processed` 改名(牵动 4 条断言)、活跃集封顶、流体↔实体交互 |

## 4. 档3(待裁,49 条)逐条「要裁什么」,按「需要谁裁」分组

### 4.1 Lead — WS-03 建筑/蓝图契约(10 条)
| ID | 要裁什么 |
|---|---|
| WS-03 U1 | 是否支持 >16×16 蓝图(须改 `BLUEPRINT_CELLS` 定长假设 + 编解码 + 中继队列) |
| WS-03 U2 | 房间评分 0~123 是否暴露给玩家、以何形态(★三档 vs 裸分) |
| WS-03 U3 | `scanRooms` 保持全量重扫还是做增量维护 |
| WS-03 U4 | `danglingEnds` 阈值(≤1)是否收紧为「≤1 且不在组件格上」 |
| WS-03 U5 | 中继建造是否加并发上限(建议 8) |
| WS-03 U6 | `canTraverse` 的结论是否作为 WS-02 的唯一输入 |
| WS-03 U7 | 蓝图是否允许带暗线(wire 位) |
| WS-03 U8 | 词表/房间名中文硬编码 v1 是否保持 |
| WS-03 U9 | `stampBoxRoom` 是否算生产代码 |
| WS-03 U10 | 地砖超 64 时是否扩 `floor` 位宽(改冻结层) |

### 4.2 Lead — WS-06 炼金契约/玩法(7 条;含 WS-10 体验 1 条)
| ID | 要裁什么 |
|---|---|
| WS-06 U2 | `util`(0~50)具体加成什么(背包/采集/机关范围) |
| WS-06 U4 | 是否加「类别×机制」白名单矩阵(连带扩充 few-shot 与降级表) |
| WS-06 U5 | 立牌是否支持非 16×16(加 `icon_size`,改冻结契约) |
| WS-06 U6 | `S_logic` 是否放开上限(台账写 [0.80,1.50],代码是 [0.6,1.3],**未核实**哪个是准) |
| WS-06 U7 | 缓存一致性:数值热更 vs 配方一经发现永不改变 |
| WS-06 U9 | (WS-10 体验)是否维护「高美学降级词表」 |
| WS-06 U10 | 系统提示词/降级词表是否外置成多语言资源包 |

### 4.3 Lead — WS-09 客户端表现层(11 条;其中 U2/U5 需美术)
| ID | 要裁什么 |
|---|---|
| WS-09 U1 | 是否做极简 three 相容层(还是改由宿主适配) |
| WS-09 U2 | (Lead + **美术**)顶点颜色 vs 纹理图集 |
| WS-09 U3 | `flattenTree` 是否保留「来自哪个父节点」溯源 |
| WS-09 U4 | 面数估算是否按 Chunk 实际 `dominantZGrid` 精确算 |
| WS-09 U5 | (**美术** + Lead)染色距离衰减曲线是否进冻结层 |
| WS-09 U6 | 粒子 `rate` 是否随画质档缩放 |
| WS-09 U7 | `BossTelegraphRow` 与 5 种预警几何的映射谁做逐 Boss 核对 |
| WS-09 U9 | GBK 有损损坏的残留注释是否人工重写 |
| WS-09 U10 | `zoomLevels` 双导出是否清理 |
| WS-09 U11 | 屋顶连通域 4-邻域还是 8-邻域/对角权重 |
| WS-09 U12 | `frustumCull` 是否需要返回可见子集副本 |

### 4.4 Lead — 跨模块/工具/冻结层(6 条)
| ID | 要裁什么 |
|---|---|
| SIM US7 | 回放/录制是否要做(输入录制层 + `ReplayDriver`) |
| PERF U3 | 三条 `not-in-manual` 候选断言(MANUAL 出处不存在)是升级为可判定还是删除 |
| EXTENDING U1 | `verify.ts` 硬编码 320 是否改为读基线文件(自称「有意为之」) |
| EXTENDING U2 | 槽位定义是否从数组下标改成按 ID(需存档迁移) |
| EXTENDING U3 | 12 位 vs U16 双 ID 宽度是否统一 |
| EXTENDING U4 | `INVENTORY_SLOTS=336` 何时扩容加行(需重跑 C1) |

### 4.5 Lead — 可选清理 / 已知边界去留(4 条)
| ID | 要裁什么 |
|---|---|
| REVIEW-10 U14 | `tests/WS-01.test.ts:740` 冗余恒真断言是否清理(会动 README 数字) |
| REVIEW-9 U13 / REVIEW-10 U13 / REVIEW-11 U13 | 「动态 `import()` 不跟踪」这一已知边界(影响=零)是否正式接受并关行(3 条同题,分属 3 份文档) |

### 4.6 owner — 玩法/产品(3 条)
| ID | 要裁什么 |
|---|---|
| REVIEW U1 | `WS-FND-04` H1–H4:改措辞还是补真实注入(owner 决定) |
| REVIEW U2 | `WS-FND-05` 计时断言「可接受的最低灵敏度」是多少 |
| REVIEW-2 U1 | `damage.ts`/`components.ts`(约 2700 行 + 107 断言)何时接入 `world_sim` |

### 4.7 无具名裁决人 — 事件总线设计(4 条)
| ID | 要裁什么 |
|---|---|
| EVENT-BUS U2 | 是否需要跨帧队列(延迟调度层) |
| EVENT-BUS U4 | `lastMobTicks` 是否进 `SimFrameReport`(观测粒度) |
| EVENT-BUS U6 | 是否立事件名命名空间规范(会动 29 种事件名) |
| EVENT-BUS U7 | `unknownMobs` 是否应为硬失败 |

### 4.8 无具名裁决人 / 归属他人 / 缺实测证据(4 条)
| ID | 要裁什么 |
|---|---|
| DAMAGE-LOOP D8 | `blockedKeys` 预留入口:保留并关行,还是删除/接线(台账自称「不是死参数」) |
| REVIEW-6 U8 | 「`WS-10.test.ts` mtime 变动但目标未修」:归 task-16 跟踪还是关行 |
| FLUID F3 | 是否引入「小世界按面积分支」的优化(现无实测痛点,需先有证据) |
| FLUID F6 | 相变是否要判斜角(手册未明确 ⇒ 需手册/设计裁决) |

## 5. `node scripts/backlog.ts` 的「无过时条目」原文与判据

**第 7 项要求原文照抄的输出(运行 `node scripts/backlog.ts` 最后一行):**
```
══ 无过时条目 ══
```
(`--audit` 追加段的原文,一并照抄:)
```
══ 探针体检 24 条 ══
  已归档              SIM-orchestration.md US1
  已归档              SIM-orchestration.md US3
  已归档              EVENT-BUS.md U5
  已归档              EVENT-BUS.md U8
  已归档              SIM-orchestration.md US8
  已归档              EVENT-BUS.md U1
  已归档              FLUID-BUDGET.md F1
  在岗               DAMAGE-LOOP.md D1
  在岗               DAMAGE-LOOP.md D2
  在岗               DAMAGE-LOOP.md D3
  在岗               DAMAGE-LOOP.md D4
  在岗               DAMAGE-LOOP.md D5
  已归档              DAMAGE-LOOP.md D6
  在岗               DAMAGE-LOOP.md D7
  在岗               FLUID-BUDGET.md F4
  在岗               FLUID-BUDGET.md F5
  已归档              SIM-orchestration.md US2
  在岗               SIM-orchestration.md US7
  在岗               WS-03-build.md U3
  在岗               WS-03-build.md U5
  在岗               WS-03-build.md U7
  在岗               WS-06-alchemy.md U4
  在岗               WS-09-client-render.md U1
  在岗               WS-09-client-render.md U11

  在岗/命中 15 条 / 已归档 9 条
  → 无静默失效探针(已归档不算失效:它们守的条目已关闭,属正常退役)。
```

**判据(在 `scripts/backlog.ts` 里找到的位置与逻辑):**
`detectStale()` —— `scripts/backlog.ts:523-546`,逐条遍历 `STALE_PROBES`(`:156-416`,24 条),对每条做**三重合取**:
1. `:535` 用 `findLedgerRow(docText, p.id)`(`:472-477`)在**文档**里找该条目行;找不到 ⇒ 跳过(**不算过时**);
2. `:536` 该行必须仍匹配 `p.claim` 正则(描述同一件事);措辞漂移 ⇒ 跳过(**不算过时**);
3. `:538` 该行含 `~~`(已归档)⇒ 跳过(**不算过时**);
4. `:541` 代码侧:`p.probe.test(stripToCode(codeText))` —— **必须命中**才算「过时」。
即判据 = 「文档行仍在声称未实现 + 代码态文本里已出现该实现符号」。

两个必须点明的口径细节:
- **不是**在原始源码上跑正则,而是在 `stripToCode()`(`:102-133`,先去注释 `stripComments()` `:41-81`,再把字符串内容擦成空格)的**代码骨架**上跑。`:86-101` 的 docblock 记录了原因:字符串里写「US2 仍未接 WorldSim」会让探针**反向**报「已过时」。
- 「代码里出现该符号」不算,必须是**代码态**:`server/src/net/room.ts:1547` 的 `host.advance(1)` 命中(`:344` probe `/host\s*\.\s*advance\s*\(/`),而 `WorldSim` 那 18 处**只在注释里**的提及不计 —— 这正是 `:311-341` 那段长长的「名字口径 → 行为口径」裁决记录。

⇒ 「无过时条目」的实际含义:**在看守的 24 条里,没有任何一条处于「文档说没做、而代码里已经有了」的状态**。它**不**等于「108 条都还没做」,也**不**等于「108 条都是缺陷」。同一批跑出的 `在岗/命中 15 条`(15 条探针守的缺口在代码里确实仍不存在,含 D1–D5/D7、F4/F5、US7、WS-03 U3/U5/U7、WS-06 U4、WS-09 U1/U11)是**第 6 项之外**的独立读数,可直接用作档2 的机器证据(本文 §3 第 7–9 组即据此)。

## 6. 附带发现(不作为 108 的一部分,但影响「逐条定性」的可信度)

1. **任务书的前提需更正**:台账不是我一开始以为的「`scripts/backlog.ts` 数据表」,而是 `docs/*.md` 的未决表格;`backlog.ts` 只是解析器 + 探针表。所有 108 条的 `file:line` 只能来自**文档行号**(`docs/<doc>.md:<line>`)或我去代码里另找的证据。
2. **台账漏了一个文档**:`docs/ADVERSARIAL-REVIEW-12.md`(40 KB,全目录最新 mtime)没有 `## …未决` 标题 ⇒ `collectOpenItems()` 不收它,它的新发现全部不在 108 里。
3. **「阻塞 0 条」是恒零常量**:`blocking` 判据在 `scripts/backlog.ts:450`(`!decided && /阻塞|阻断|需 CR|需先定/`),同时要求不命中 `已采纳|已定稿|已裁决|已解决|已删除|已修正诊断|~~`(`:445`)。实测 133 条里 0 条命中 ⇒ 这个「0」不表示状态健康(与 `docs/ADVERSARIAL-REVIEW-12.md:195-206` 的复核结论一致)。
4. **台账数字是移动靶**:本文取数时 `108 未关闭 / 25 已关闭`;`docs/ADVERSARIAL-REVIEW-12.md:200` 引的是 `109 / 24`。差异发生在 REVIEW-12 落盘前后,我**未核实**是哪一行在动。
5. **「已完成」不在 `closed` 判据里**(`scripts/backlog.ts:451` 只认 `已删除|已解决|已定稿|已采纳|已实现|已修正诊断|~~`)⇒ 至少 4 条档1(REVIEW-10 U5/U12、REVIEW-11 U12,以及未关的 WS-11 U2 类)是因为「已完成」这个词没被识别而**滞留在未关闭计数里**。这是**工具口径缺陷**,不是实现缺陷。
6. **同 ID 大量重复**:52 条 REVIEW 条目里,`U9 两门禁缺交叉标注`×5、`WS-01 未复核`×6、`PROTOCOL_VERSION`×4、`动态 import()`×3、`21 处同义反复`×4、`3 个死导入`×2、`stripCommentsOnly 调用方`×3、`WS-06::ICON_SIZE`×2。**133 条 ≠ 133 个问题**,去重后真实议题数远小于 108。
7. **未核实项一览**(不猜):① 同义反复白名单的**当前**条数(23 还是 32?两文档读数冲突,我没跑门禁);② `WS-06 U6` 的 `S_logic` 区间(台账正文 0.80/1.50 vs BACKLOG-AUDIT 实测 0.6/1.3);③ `EXTENDING U1` 的行号(台账写 `:125,141`,现值在 `:596,612`);④ REVIEW-7 U10「还原路径前置检查」是否就是 `inject.ts` 的两道闸。
