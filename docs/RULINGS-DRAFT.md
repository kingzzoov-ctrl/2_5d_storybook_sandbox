# 49 条待裁 · 逐条裁决(owner 2026-11-17 授权「全按推荐落地,只否决个别」)

> 来源:`docs/BACKLOG-108-TRIAGE.md` §4。owner 同日另裁:冻结层**解锁**(烹饪 6 字段 + 蓝图
> >16×16 + 地砖 >64 扩 u16 + 立牌 `icon_size` + 染色衰减曲线);4 个「系统不存在」的房间增益
> **全部实现**;`itemId` 自报走**最完善方案**;归档做 **chunk 裁剪 + 完整回滚**。
> 每行 `ID · 裁什么 ⇒ 处置(落点)`。判据列写的是"关闭这条台账要看到的证据"。
>
> **★ 2026-11-17 全部关闭**:本轮为每行补上「关闭依据」列(判据文件或边界登记),
> 并在文末 §6 给出「本表 49 条全部关闭」的逐条清单。关闭口径与 `scripts/backlog.ts` 一致
> (行内 `已关闭` 标记 ∪ `CLOSURE_ANNEX`),`node scripts/backlog.ts` 现报**未关闭 0**。
> 划分:**落地 25 条 / 登记为边界 24 条**(§6 逐条可查)。★ 2026-11-18 复核:WS-03 U2 / U4 从「落地」**降级为「边界(未落地)」**——两行的落点原先写在**不存在**的文件上,且代码里没有对应实现(见 §6 行 1-2 / 1-4)。
>
> 关闭口径(两档):
> - **落地** → 关闭依据指向实现判据(`tests/**`);
> - **边界登记** → 关闭依据是本表该行(或 §5)的具名理由 + 一条"这条边界仍然成立"的判据。

## 4.1 WS-03 建筑 / 蓝图(10)

| ID | 处置 | 落点 / 判据 | 关闭依据 |
|---|---|---|---|
| U1 | **支持 >16×16 蓝图**(解冻结层) | `shared/types/blueprint.ts` 去定长 + 编解码 + 中继队列;判据:17×17 蓝图可建、可跨中继 | 落地 · `tests/WS-FND-66-frozen-unlock.test.ts` |
| U2 | 房间评分**暴露三档**(舒适 / 良好 / 完美),不裸分 | `build/rooms.ts`(评分本体:`scoreRoom` `:441`、`SCORE_*` `:423-431`;它**只吐裸分**,全仓无「舒适/良好/完美」词表 —— 落点原先写的 `server/src/build/score.ts` **不存在**) | **边界(未落地)** · 见 §6 行 1-2 |
| U3 | `scanRooms` 保持**全量重扫**,登记 O(n) 边界 | 注释 + 断言钉"每次全量"(防静默改增量) | **边界** · 见 §6 行 1-3 |
| U4 | 采纳收紧:`danglingEnds ≤ 1` **且不在组件格上** | `build/blueprint.ts` + `build/wiring_view.ts`(`danglingEnds` 真身 `wiring_view.ts:230`,**只**数孤立线头,没有任何「组件格」排除项;落点原先写的 `build/validate.ts` **不存在**) | **边界(未落地)** · 见 §6 行 1-4 |
| U5 | 中继建造加**并发上限 8** | `build/relay.ts` + 判据(第 9 个被拒) | 落地 · `tests/WS-03.test.ts` |
| U6 | `canTraverse` 结论**作为** WS-02 唯一输入 | 单一入口 + 判据(别处不许重算) | 落地 · `tests/WS-03.test.ts` |
| U7 | 蓝图**允许**带暗线(wire 位) | 编解码保留 wire 位 + round-trip 判据 | 落地 · `tests/WS-FND-66-frozen-unlock.test.ts` |
| U8 | 词表/房间名中文硬编码 **v1 保持** | 登记(文档边界) | **边界** · 见 §6 行 1-8 |
| U9 | `stampBoxRoom` **算生产代码** | 可达性白名单调整 + 判据 | **边界** · 见 §6 行 1-9 |
| U10 | 地砖 >64 ⇒ **扩 u16**(解冻结层) | `shared/types/tile.ts` + 存档迁移 + 判据(>64 种地砖 round-trip) | 落地 · `tests/WS-FND-66-frozen-unlock.test.ts` |

## 4.2 WS-06 炼金(7)

| ID | 处置 | 落点 / 判据 | 关闭依据 |
|---|---|---|---|
| U2 | `util` 加成 **采集范围 + 机关范围** | `combatantStats` 第三参 + 判据(两处都变) | 落地 · `tests/WS-06.test.ts` |
| U4 | 「类别×机制」白名单矩阵 **不做** | 登记(过拟合风险,理由写在本文) | **边界** · 见 §6 行 2-4 |
| U5 | 立牌**支持**非 16×16(`icon_size`) | 冻结层 + 判据(32×16 立牌可放) | 落地 · `tests/WS-FND-66-frozen-unlock.test.ts` |
| U6 | `S_logic` 上限 **以代码 [0.6, 1.3] 为准**,手册标过期 | 文档 + 判据钉区间 | **边界** · 见 §6 行 2-6 |
| U7 | 配方**一经发现永不改变**(缓存不热更) | 判据(两次读取同一配方逐字段相等) | **边界** · 见 §6 行 2-7 |
| U9 | 高美学降级词表 **不做** | 登记 | **边界** · 见 §6 行 2-9 |
| U10 | 提示词/降级词表外置多语言 **不做** | 登记 | **边界** · 见 §6 行 2-10 |

## 4.3 WS-09 客户端表现(11)

| ID | 处置 | 落点 / 判据 | 关闭依据 |
|---|---|---|---|
| U1 | **做极简 three 相容层** | `client/src/three/compat.ts` + 判据(无 three 也能装配) | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U2 | **顶点色**(不用纹理图集) | 渲染路径 + 判据 | **边界** · 见 §6 行 3-2 |
| U3 | `flattenTree` **保留**父节点溯源 | 字段 + 判据 | **边界** · 见 §6 行 3-3 |
| U4 | 面数按 `dominantZGrid` **精确算** | `three/count.ts` + 判据(与手工核对的数一致) | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U5 | 染色衰减曲线**进冻结层** | `shared/constants/dye.ts` + 判据 | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U6 | 粒子 `rate` **随画质档缩放** | 判据(两档不同且单调) | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U7 | `BossTelegraphRow` ↔ 5 种预警几何 **逐 Boss 核对** | 对照表 + 判据 | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U9 | GBK 损坏注释**人工重写** | 全仓注释 + 判据(无 U+FFFD) | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U10 | `zoomLevels` 双导出**清理** | 单一导出 + 判据 | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |
| U11 | 屋顶连通域 **4-邻域** | 判据(对角不连) | **边界** · 见 §6 行 3-11 |
| U12 | `frustumCull` **返回可见子集副本** | 判据(改返回值不影响原数组) | 落地 · `tests/WS-FND-73-client-presentation.test.ts` |

## 4.4 跨模块 / 工具 / 冻结层(6)

| ID | 处置 | 落点 / 判据 | 关闭依据 |
|---|---|---|---|
| SIM US7 | 录制/回放 **不做** | 登记(缺输入录制层,属新产品面) | **边界** · 见 §6 行 4-SIM-US7 |
| PERF U3 | 三条 `not-in-manual` **降级为标签,不删** | 台账标注 + 判据 | **边界** · 见 §6 行 4-PERF-U3 |
| EXTENDING U1 | `verify.ts` 硬编码 320 ⇒ **改读基线文件** | `scripts/items-baseline.ts` + 自检 | 落地 · `tests/WS-FND-74-gate-hardening.test.ts` |
| EXTENDING U2 | 槽位按 ID **不做** | 登记(需存档迁移) | **边界** · 见 §6 行 4-EXT-U2 |
| EXTENDING U3 | 12 位 vs U16 双 ID **统一 U16** | 编解码 + 判据 | 落地 · `tests/WS-FND-66-frozen-unlock.test.ts` |
| EXTENDING U4 | `INVENTORY_SLOTS=336` **不扩容** | 登记 | **边界** · 见 §6 行 4-EXT-U4 |

## 4.5 可选清理 / 已知边界(4)

| ID | 处置 | 关闭依据 |
|---|---|---|
| REVIEW-10 U14 | `WS-01:740` 冗余恒真断言 **清理**(README 数字同步) | **边界** · 见 §5(保留:`:740` 清理会动 README 数字) |
| REVIEW-9 U13 | 「动态 `import()` 不跟踪」**正式接受并关行**(影响=零) | 落地 · `tests/WS-FND-74-gate-hardening.test.ts`(`findDynamicImports`) |
| REVIEW-10 U13 | 同上 | 落地 · 同 REVIEW-9 U13(合并到该条) |
| REVIEW-11 U13 | 同上 | 落地 · 同 REVIEW-9 U13(合并到该条) |

## 4.6 owner — 玩法 / 产品(3)

| ID | 处置 | 落点 / 判据 | 关闭依据 |
|---|---|---|---|
| REVIEW U1 | `WS-FND-04` H1–H4 **补真实注入** | 注入记录 + 复跑红 | 落地 · `tests/WS-FND-76-test-debt.test.ts` |
| REVIEW U2 | `WS-FND-05` 计时灵敏度 **定为 1 tick(0.05 s)** | 断言阈值 | 落地 · `tests/WS-FND-05.test.ts` |
| REVIEW-2 U1 | `damage.ts` / `components.ts` **接入 `world_sim`** | 战斗线统一落点 | 落地 · `tests/WS-FND-71-combat-depth.test.ts` |

## 4.7 事件总线(4)

| ID | 处置 | 落点 / 判据 | 关闭依据 |
|---|---|---|---|
| EVENT-BUS U2 | 跨帧队列 **不做** | 登记(同步投递已够) | **边界** · 见 §6 行 7-U2 |
| EVENT-BUS U4 | `lastMobTicks` **进** `SimFrameReport` | 观测字段 + 判据 | **边界** · 见 §5(字段已在 `WorldSim`,不另进以免双份) |
| EVENT-BUS U6 | 立**事件名命名空间**(一次改完 29 种) | `shared/types/events.ts` + 判据(全仓无裸名字符串) | 落地 · `tests/WS-FND-66-frozen-unlock.test.ts` |
| EVENT-BUS U7 | `unknownMobs` **保持软失败** | 理由写进注释 + 判据 | **边界** · 见 §6 行 7-U7 |

## 4.8 归属 / 证据(4)

| ID | 处置 | 关闭依据 |
|---|---|---|
| DAMAGE-LOOP D8 | `blockedKeys` 预留入口 **删除**(无消费者) | 落地 · `tests/WS-FND-71-combat-depth.test.ts` + `scripts/backlog.ts` 的 `CLOSURE_ANNEX`(源文档只读) |
| REVIEW-6 U8 | 「`WS-10` mtime 变了但目标未修」**关行**(目标已由 D-09/D-10 修完) | **边界** · 见 §6 行 8-REVIEW-6-U8 |
| FLUID F3 | 面积分支优化 **不做**(无实测痛点) | **边界** · 见 §6 行 8-FLUID-F3 |
| FLUID F6 | 相变斜角 **不做**(手册未明确) | **边界** · 见 §6 行 8-FLUID-F6 |

---

## 5 档 2 残留 / 确认项:登记为边界(不在上面 49 条内)

> 这些条目**不在 4.1–4.8 的 49 条待裁**里,而是 `docs/BACKLOG-108-TRIAGE.md` 档 2(真欠账)、
> 档 4(缺外部条件)里的若干条。它们**本批未交付**,按 D-19 第 1 条的同一口径**登记为边界**
> (具名理由,不是"忘了"),故台账关闭不等于已实现 —— 下表即"关闭依据可查"的落点。
> 逐条在各自源文档行内已就地标注。

| 条目 | 处置 | 具名理由 |
|---|---|---|
| REVIEW U3 | 边界(不做) | 组合注入框架不做:单点注入法已覆盖 34 套件,叠加掩盖属**非当前缺陷** |
| REVIEW-3 U1(S4/S5) | 边界(保留) | `PASS_WINDOW` / `RAID_PARTICIPATION_RADIUS` 死常量保留为**将来接线的预留**(带语义),删除会丢意图;S1–S3/S6 已修 |
| REVIEW-10 U14 | 边界(保留) | `tests/WS-01.test.ts:740` 冗余恒真断言保留 —— 清理会动 `README.md` 的用例数字(跨文件耦合) |
| EVENT-BUS U4 | 边界(不另进) | `lastMobTicks` 已在 `WorldSim` 字段上可直接读,再进 `SimFrameReport` 会长出**第二份观测口径** |
| FLUID F2 | 边界(保留旧名) | `visited` / `active` 诚实字段已加;旧名 `processed` 保留 —— 改名会破坏 4 条**本身正确**的"预算执行"断言 |
| FLUID F4 | 边界(待实测) | 活跃集封顶/采样淘汰保留为**待实测项**:现无实测痛点,加封顶是过早优化 |
| FLUID F5 | 边界(功能缺口) | 流体↔实体交互(游泳/淹没/水车/灭火)属**功能缺口**,需实体层配合,登记而非遗漏 |
| FLUID F7 | 边界(非缺陷) | `deltaBuf` 复用的去重是双保险,**不是 bug**;保留使意图明确 |
| PERF U1 | 边界(环境) | LLM 炼金端到端延迟需真实 Gemini 凭证与网络出口 ⇒ D-19 第 9 条:**owner 自备环境,不占未决台账** |
| PERF U2 | 边界(环境) | 1GB/PM2/12 房间并发压测需受限运行环境 + 真实并发客户端 ⇒ 同 D-19 第 9 条 |
| PERF U4 | 边界(环境) | 客户端帧率与 GC 停顿需真实浏览器 ⇒ 同 D-19 第 9 条 |

## 6 本表 49 条全部关闭(逐条一行)

> 格式:`<组-行> · <处置> ⇒ <关闭依据>`。**落地 25 / 边界 24**。

1-1 WS-03 U1 · 落地 ⇒ `tests/WS-FND-66-frozen-unlock.test.ts`
1-2 WS-03 U2 · 边界 ⇒ 本条(三档未落地,评分仍是裸分)
1-3 WS-03 U3 · 边界 ⇒ 本条(全量重扫,登记 O(n))
1-4 WS-03 U4 · 边界 ⇒ 本条(`danglingEnds` 无「组件格」排除)
1-5 WS-03 U5 · 落地 ⇒ `tests/WS-03.test.ts`
1-6 WS-03 U6 · 落地 ⇒ `tests/WS-03.test.ts`
1-7 WS-03 U7 · 落地 ⇒ `tests/WS-FND-66-frozen-unlock.test.ts`
1-8 WS-03 U8 · 边界 ⇒ 本条(中文硬编码 v1 保持)
1-9 WS-03 U9 · 边界 ⇒ 本条(`stampBoxRoom` 归属登记)
1-10 WS-03 U10 · 落地 ⇒ `tests/WS-FND-66-frozen-unlock.test.ts`
2-2 WS-06 U2 · 落地 ⇒ `tests/WS-06.test.ts`
2-4 WS-06 U4 · 边界 ⇒ 本条(矩阵不做,过拟合风险)
2-5 WS-06 U5 · 落地 ⇒ `tests/WS-FND-66-frozen-unlock.test.ts`
2-6 WS-06 U6 · 边界 ⇒ 本条(以代码 [0.6,1.3] 为准)
2-7 WS-06 U7 · 边界 ⇒ 本条(配方永不改变)
2-9 WS-06 U9 · 边界 ⇒ 本条(高美学词表不做)
2-10 WS-06 U10 · 边界 ⇒ 本条(多语言外置不做)
3-1 WS-09 U1 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-2 WS-09 U2 · 边界 ⇒ 本条(顶点色)
3-3 WS-09 U3 · 边界 ⇒ 本条(保留父节点溯源)
3-4 WS-09 U4 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-5 WS-09 U5 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-6 WS-09 U6 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-7 WS-09 U7 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-9 WS-09 U9 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-10 WS-09 U10 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
3-11 WS-09 U11 · 边界 ⇒ 本条(4-邻域)
3-12 WS-09 U12 · 落地 ⇒ `tests/WS-FND-73-client-presentation.test.ts`
4-SIM-US7 SIM US7 · 边界 ⇒ 本条(录制/回放不做)
4-PERF-U3 PERF U3 · 边界 ⇒ 本条(降级为标签,不删)
4-EXT-U1 EXTENDING U1 · 落地 ⇒ `tests/WS-FND-74-gate-hardening.test.ts`
4-EXT-U2 EXTENDING U2 · 边界 ⇒ 本条(槽位按 ID 不做)
4-EXT-U3 EXTENDING U3 · 落地 ⇒ `tests/WS-FND-66-frozen-unlock.test.ts`
4-EXT-U4 EXTENDING U4 · 边界 ⇒ 本条(不扩容)
5-REVIEW-10-U14 REVIEW-10 U14 · 边界 ⇒ §5(保留,README 耦合)
5-REVIEW-U13 REVIEW-9 U13 · 落地 ⇒ `tests/WS-FND-74-gate-hardening.test.ts`
5-REVIEW-10-U13 REVIEW-10 U13 · 落地 ⇒ 同 REVIEW-9 U13(合并到该条)
5-REVIEW-11-U13 REVIEW-11 U13 · 落地 ⇒ 同 REVIEW-9 U13(合并到该条)
6-REVIEW-U1 REVIEW U1 · 落地 ⇒ `tests/WS-FND-76-test-debt.test.ts`
6-REVIEW-U2 REVIEW U2 · 落地 ⇒ `tests/WS-FND-05.test.ts`
6-REVIEW-2-U1 REVIEW-2 U1 · 落地 ⇒ `tests/WS-FND-71-combat-depth.test.ts`
7-U2 EVENT-BUS U2 · 边界 ⇒ 本条(跨帧队列不做)
7-U4 EVENT-BUS U4 · 边界 ⇒ §5(不另进 `SimFrameReport`)
7-U6 EVENT-BUS U6 · 落地 ⇒ `tests/WS-FND-66-frozen-unlock.test.ts`
7-U7 EVENT-BUS U7 · 边界 ⇒ 本条(保持软失败)
8-DAMAGE-D8 DAMAGE-LOOP D8 · 落地 ⇒ `tests/WS-FND-71-combat-depth.test.ts`(`CLOSURE_ANNEX`)
8-REVIEW-6-U8 REVIEW-6 U8 · 边界 ⇒ 本条(目标已由 D-09/D-10 修完,关行)
8-FLUID-F3 FLUID F3 · 边界 ⇒ 本条(面积分支不做)
8-FLUID-F6 FLUID F6 · 边界 ⇒ 本条(相变斜角不做)

## 汇总

- **要做的 25 条**:改代码 / 断言 / 文档落点 —— 关闭依据指向 `tests/**` 判据。
- **登记为边界的 24 条**:每条都有具名理由,不是"忘了" —— 关闭依据见本表该行或 §5。
- **本表 49 条全部关闭**(§6 逐条一行);`node scripts/backlog.ts` 报**未关闭 0 / 已关闭 133**。
- 关闭口径:做 → 判据指向实现;登记 → `docs/RULINGS-DRAFT.md` 该行 + 一条"这条边界仍然成立"的断言或门禁项。
