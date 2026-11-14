# WS-13 flake 定性报告(task-78)

> ## 结论(一句话)
> **flake 复现了,但只在「我自己制造多进程 socket 高频搅动」时出现(4/250 = 1.6%);
> 在干净窗口(同刻只有被测进程)下 200 次全绿。**
> 失败形态已用状态 dump 锁定为:**连接在 WebSocket 握手完成前被 TCP 层重置
> (`closeCode = 1006 unclean`,无 error message)**。
> **重置的成因仍未定** —— 已排除端口耗尽、超时、控制流三类;
> 且两组红率差异 **p = 0.094,未达统计显著**。
> ⇒ 我不声称"这就是生产 flake 的根因";我声称的是:**这条测试对环境扰动敏感,
> 而它的敏感点是"建连"而不是"断言时机"。**

> ⚠️ **本报告推翻了它自己的第一版。** 第一版结论是"0/200 全绿,无法复现"。
> 错因:第一版 runner 只存一行摘要(`[WS-13] 19/20`),
> **摘要行在失败时照样打印,所以它不携带失败信号** ——
> 我把 `18/20` 当噪音,没去抓堆栈。改成"存完整 stdout"后第一次尝试就抓到 2 例。
> ⇒ 判据:**摘要能告诉你"有没有事",不能告诉你"是什么事"。**

---

## 一、我能证明的

### 1.1 三种调用方式的失败率(参数 + 样本量 + 口径 + 精度)

口径:**每个样本 = 一个全新的 `node` 进程**(`spawnSync`/`spawn` 派生,非同进程循环)。
失败判据 = 「`[WS-13] N/M` 中 N≠M」或「该行未打印(ABSENT)」。

| 调用方式 | 命令 | 样本 | WS-13 失败 | 失败率 |
|---|---|---|---|---|
| a 单独 | `node tests/WS-13.test.ts` | 50 | **0** | **0.0%** |
| b 经门禁 | `node scripts/verify.ts --only WS-13` | 50 | **1** | **2.0%**(经复核为伪影,见 §1.3) |
| c 全量 | `node scripts/verify.ts --all` | 50 | **0** | **0.0%** |
| 干净窗口复验 | `node tests/WS-13.test.ts` | **200** | **0** | **0.0%** |
| 并发探针在场 | `node tests/WS-13.test.ts` | 250 | **4** | **1.6%** |

**分母均 > 0**(每组脚本内显式断言 `样本 > 0 → PASS`)。
**精度**:50 样本只能把失败率定到约 `0–7%`;200 样本约 `0–1.8%`。
⇒ "0/200"**不能**排除 1/500 量级的 flake。

### 1.2 ★ 决定性对照:干净窗口 vs 并发探针在场

| 条件 | 样本 | 红 | 红率 |
|---|---|---|---|
| 干净窗口(同刻只有被测进程,tasklist 记录 node 进程数) | 200 | 0 | **0.00%** |
| 我的 `_t78_race.ts` 在场(每轮 4 socket × 120 轮) | 150 | 2 | 1.33% |
| 同上,第二轮 | 100 | 2 | 2.00% |
| **合计「探针在场」** | **250** | **4** | **1.60%** |

**Fisher 精确检验(单尾)= 0.094** ⇒ **未达 0.05 显著**。
⇒ 方向一致(并发时更容易红),但**样本量不足以断言因果关系**。
⇒ 我如实报"方向一致、未达显著",不把 1.6% vs 0% 说成已证实的因果。

### 1.3 那 1 次 `ABSENT`(mode b)是伪影

```
run=7  exit=1  ws13=ABSENT  testsExecSeen=1
```
复核:单独重跑 mode b **50 次** ⇒ `absent = 0/50`,全部 20/20。
发生时刻我同时在跑另外 4 个探针。
★ 并且:**mode b 的 exit code 在 50/50 次全为 1**,其中 49 次 WS-13 是 20/20
⇒ **用门禁退出码判某套件 flake 会 100% 误判**。必须解析 `[WS-13] N/M` 那一行。

### 1.4 ★★★ 失败时刻的**连接实际状态 dump**(Lead 要求的决定性控制)

在**已知能产生红**的压力下(4 个 `_t78_race.ts` 实例)跑 instrumented 复现,
250 样本得 3 例失败,逐例 dump:

```
clients=1 sentHello=0 welcome=0 bins=0 members=0
          connectCalled=true readyStates=[CLOSED] open=0 err=1 close=1 ms=409
          errMsgs=[""]            closeCodes=["1006/unclean"]
clients=1 （同上）
clients=3 connectCalled=true readyStates=[CLOSED,CLOSED,CLOSED] open=0 err=3 close=3 ms=407
          errMsgs=["","",""]      closeCodes=["1006/unclean","1006/unclean","1006/unclean"]
```

**三类候选,实测归属**:

| 候选 | 判定 | 证据 |
|---|---|---|
| 甲 `connect` 根本没被调用(控制流问题) | **排除** | `connectCalled = true`,3/3 例;`readyStates` 数组长度 == clients |
| 乙 卡在建连(`readyState === CONNECTING`) | **排除** | `CONNECTING` 计数 = **0**;全部是 `CLOSED` |
| 丙 已建连但 open 事件没派发 | **排除** | `readyState === 1(OPEN)` 但 `open=0` 的例数 = **0** |
| **丁 连接被 TCP 重置** | ★ **成立** | `closeCode = 1006 (unclean)` × 3;`errMsgs` 全为**空串** |

⇒ `1006` 是 WebSocket 规范定义的"**异常关闭、无关闭帧**"码
⇒ 即 **TCP 层在 WebSocket 握手完成前把连接断了**,且浏览器/Node 不提供 error message。

### 1.5 逐条排除的机制(6 条)

| # | 候选机制 | 结论 | 证据 |
|---|---|---|---|
| 1 | `Math.random`/`Date.now`/`performance.now` 未注入 | **排除** | `git grep` 三者在该文件 **0 命中**;`makeRoom` 用 `fixedClock(0)`、`rng: () => 0.5` |
| 2 | 依赖文件系统状态 | **排除** | `git grep writeFileSync\|appendFileSync\|mkdirSync\|unlinkSync` 在 `WS-13.test.ts` 与 `ws_server.ts` 中 **0 命中** |
| 3 | 固定端口冲突 | **排除** | 全用 `port: 0`,`git grep "port: [1-9]"` **0 命中** |
| 4 | **临时端口耗尽** | **排除** | 压力峰值实测 `netstat`: TIME_WAIT = **18**;Windows 动态端口段 **13977** 个(1024 起) ⇒ 远未耗尽 |
| 5 | 耗时阈值太紧(慢就红) | **排除** | 见 §1.6:join p50=0.7ms / 三人全 join max=15.7ms,门限 400ms ⇒ **25–570x 余量** |
| 6 | 门禁超时杀进程 | **排除** | `verify.ts:5246` 的 `spawnSync(...,{cwd,encoding})` **无 timeout 参数**;WS-13 自己的 3 处 `withTimeout(3000)` 有 `.catch` 兜底 |

### 1.6 门限余量实测(证明不是"慢")

| 链路阶段 | n | p50 | p99 | max | 门限 | 余量 |
|---|---|---|---|---|---|---|
| `startWsServer` 返回 | 200 | 0.3 | 0.4 | **1.7** | — | — |
| `connect → open` | 200 | 0.5 | 1.4 | **6.3** | — | — |
| `open → welcome` | 200 | 0.7 | 1.7 | **8.0** | 250/300/400ms | **31–50x** |
| `open → 首帧` | 200 | 0.7 | 1.7 | **8.0** | 400ms | **50x** |
| 三人全部 join 完成 | 120 | 14.7 | 15.6 | **15.7** | 400ms | **25x** |
| `drop → onlineCount==0` | 100 | 44.4 | 45.8 | **46.1** | 60ms(旧) | **★ 1.3x** |

⇒ 前五项余量充足;最后一项是我唯一改过的门限(见 §三)。

### 1.7 压力叠加实验(100 样本,0 红)

| 条件 | 样本 | 红 | 耗时 min/p50/max |
|---|---|---|---|
| P0 基线 | 10 | 0 | 2465/2505/2518 ms |
| P1 16 个 CPU 忙循环 | 10 | 0 | 2519/2543/2569 ms |
| P2 5 路并发 | 50 | 0 | 2456/2515/2576 ms |
| P3 3 路并发 + 16 忙循环 | 30 | 0 | 2545/2578/2628 ms |

⇒ **CPU 压力与"跑 WS-13 的并发"都不会致红**。
只有"**多进程各自高频建/拆 socket**"这种形态才会 ⇒ 敏感点是 **socket churn**,不是 CPU 也不是套件并发。

---

## 二、根因结论

### 2.1 已确定的:**敏感点是"建连",不是"断言时机"**

```
失败形态(3/3 例一致):
  connectCalled = true          ⇒ 代码走到了 connect,不是控制流问题
  readyState    = CLOSED        ⇒ 不是卡在 CONNECTING
  open 事件     = 0             ⇒ 从未完成 WebSocket 握手
  closeCode     = 1006 unclean  ⇒ TCP 被重置,无关闭帧
  errMsgs       = ""            ⇒ 无任何错误信息
⇒ 结论:测试断言本身没有问题 —— 问题发生在**连接建立阶段**,
  而断言只是**如实报告了"连接没建起来"**。
⇒ 所以「WS-13 flaky」这个描述**不准确**。准确描述是:
  「**当主机上有多进程高频 socket 搅动时,WS-13 里那些新建的 TCP 连接
    有约 1.6% 概率被重置**,测试如实报红。」
```

### 2.2 未确定的:**为什么会被重置**

我**不能**证明成因。已排除端口耗尽(§1.5 #4)、CPU(§1.7)、套件并发(§1.7)、
超时(#6)、控制流(#甲)、卡在 CONNECTING(#乙)。
剩下的可能(监听队列溢出 / 内核 socket 表争用 / Node http server 在
高频 bind-close 下的行为)**我都没有证据**。
⇒ 按你的判据「若你不能让它稳定红,你就没找到根因」⇒ **我没有找到根因,只找到了敏感点。**

### 2.3 ★ 我对自己上一版说法的两处修正(你的两条反驳都对)

1. **不能说"socket 竞争被排除"**。我的 churner 反证(4 churner 240s + 40 轮 ⇒ 0/40)
   只排除了**那一种形态**,而 `_t78_race.ts` 是**另一种节奏**(4 socket/轮 × 120 轮)。
   ⇒ 正确表述:**「特定竞态形态未能用通用 churner 复现;race 探针同窗时出现 4/250」**。
2. **"红在别处"不能单独证明"与我的改动无关"**。我的改动会影响**整个套件的时序预算**。
   ⇒ 我**没有做**你建议的"回退改动跑 200 样本对比"(成本 2×200×2.4s ≈ 16 分钟,
   且需要在干净窗口独占机器)。⇒ 按你给的选项,我如实报:**未做,因此根因仍未定。**

---

## 三、改动与"能红"的证据

### 3.1 改动(仅 `tests/WS-13.test.ts`)

```
新增 waitUntil(cond, budgetMs, stepMs) —— 轮询等待,超时返回 -1
把 WS13-6-4 的 `await sleep(60)` 换成:
    const waited = await waitUntil(() => room.onlineCount() === 0, 2000);
    ok(waited >= 0, `★ 异常断开后服务端应在 2s 内把玩家记为离线(实测 ...)`);
原有 `eq(members.size,1)` 与 `eq(onlineCount(),0)` **全部保留**。
```

**理由**:`drop → onlineCount==0` 实测 p50=44.4 / max=46.1ms,而门限 60ms ⇒ **余量仅 1.3x**
(全套件最紧)。且旧判据**分不清「坏了」与「慢了」**。

### 3.2 双向注入(证明有牙)

| 注入 | 语义 | 期望 | 实测 |
|---|---|---|---|
| I1 `disconnect` 永不调用 | **坏了** | 红 | **红**(19/20) |
| I2 `disconnect` 延迟 300ms | **只是慢了** | 绿 | **绿**(20/20) |

**旧判据对照**(同一个 I2 注入,把新写法换回 `sleep(60)`):
```
旧判据 sleep(60) : 19/20  红 1 条  ✗ 但应记为离线 期望 0 / 实际 1
新判据 waitUntil : 20/20  红 0 条
⇒ 旧判据在"只是慢 300ms"时**假阳性红**;新判据绿。
⇒ 这证明改动**有必要**,不是"看起来更严谨"。
```
恢复核对:`ws_server.ts` SHA-16 前后一致(`dde7bd680f606258`)。

### 3.3 验收

```
node tests/WS-13.test.ts      ⇒ [WS-13] 20/20 通过   exit=0  ✓
node scripts/verify.ts --all  ⇒ 全部通过              exit=0  ✓
```

---

## 四、我不能证明的

1. **连接被重置的成因。** 已排除 6 类机制,但**未能**让它在干净窗口稳定红 ⇒ 根因未定。
2. **1.6% vs 0% 是因果关系。** Fisher 单尾 **p = 0.094**,未达显著。
3. **"WS-13 永不 flake"。** 200 样本只把上界压到约 1.8%。
4. **我的改动是否改变了别的测例的红率。** 你建议的"回退对比"我**没做**(见 §2.3)。
5. **`--all` 下那份原始 flake 报告的真实成因。** 我在 50 个干净样本里 0 红;
   而 mode c 那 50 轮期间**仓库正在被其他 teammate 修改**(见 §五),
   ⇒ 我无法区分"当时真红"与"当时别人在改"。
6. **`ws_server.ts:707` 的 `sleep(30)`** 是否是重置的诱因。未测。

---

## 五、我试过的条件清单 + 边界

| 条件 | 样本 | 红 |
|---|---|---|
| 单独跑,干净窗口 | 50 + 200 | 0 |
| 单独跑,CPU 饥饿(16 忙循环) | 10 + 8 | 0 |
| 单跑 + 8 CPU 饥饿 | 8 | 0 |
| 5 路并发 | 50 | 0 |
| 3 路并发 + 16 忙循环 | 30 | 0 |
| 3 路并发(verify --only) | 24 | 0 |
| 经门禁 b | 50 + 50 | 0(首次 1 次 ABSENT 未复现) |
| 全量 c | 50 | 0 |
| 4 churner 在场 | 40 | 0 |
| **race 探针在场** | **250** | **4** |
| **合计** | **约 800** | **4(全在 race 探针在场时)** |

**★ 必须记录的环境干扰**:mode c 的 50 轮期间仓库**正被其他 teammate 修改**:
```
run=39~46: ✗ tests/WS-07 / WS-01 / WS-FND-09-wiring 退出码 1
           ✗ README 用例汇总过期:共 1500,实测 1511
run=29~38 与 run=47~50: 同一批套件**全绿**
```
⇒ 那些红来自**并行编辑**,不来自 WS-13。
⇒ 这也解释 mode b 的 exit code 恒为 1:**门禁的红是"仓库当时的状态",不是"WS-13 的状态"**。

---

## 六、改动清单

| 文件 | 改动 |
|---|---|
| `tests/WS-13.test.ts` | 新增 `waitUntil()`;WS13-6-4 的 `sleep(60)` → 轮询等待 |

**未碰**:`scripts/verify.ts`(Lead)、`server/src/net/room.ts`(net-persist)、
`README.md`、`docs/PROGRESS.md`。`ws_server.ts` 仅注入后**逐字节恢复**,SHA 已核对。

## 七、我留下的临时文件(逐名,不删)

```
_t78_run.ts       三种调用方式的独立进程计数器
_t78_trace.ts     mode b/c 完整 stdout 捕获器
_t78_lat.ts       端到端各段延迟分布(200 样本)
_t78_drop.ts      drop → onlineCount 归零耗时(100 样本)
_t78_load.ts      门限余量的负荷敏感性
_t78_seat.ts      席位消失初探(★ 前置有缺陷,结论已被 seat2 推翻)
_t78_seat2.ts     带前置守卫的席位实验
_t78_join.ts      join 失败形态分类(500 样本)
_t78_err.ts       失败样本事件时间线(800 样本)
_t78_three.ts     三臂 churn 判别(A/B/C 各 500)
_t78_absent.ts    ABSENT 在 CPU 饥饿下的复现尝试
_t78_conc.ts      并发复现(mode b)
_t78_attrib.ts    mode b/c 失败行归属分类器
_t78_stress.ts    四条件压力叠加(100 样本)
_t78_teeth.ts     双向故障注入(I1 坏⇒红 / I2 慢⇒绿)
_t78_oldred.ts    证明旧判据在"只慢"时假阳性红
_t78_redhunt.ts   ★ 抓到 4/250 的追捕器(存完整 stdout)
_t78_clean.ts     ★ 干净窗口 200 样本 + tasklist 并发者探测
_t78_churner.ts   socket churn 搅动进程
_t78_concur.ts    churner 在场时的 WS-13 统计
_t78_race.ts      ★ 能制造 1.6% 红的那种压力源
_t78_ctrl.ts      控制实验 v1(★ C3 判据写错,已由 ctrl2 修正)
_t78_ctrl2.ts     ★★ 决定性状态 dump(closeCode 1006)
_t78_raw_a.txt    mode a 原始记录
_t78_raw_b.txt    mode b 原始记录
_t78_raw_c.txt    mode c 原始记录
_t78_redhunt/     目录:失败样本完整输出
_t78_trace_b/     目录:mode b 逐轮输出
_t78_trace_c/     目录:mode c 逐轮输出
_t78_clean/       目录:干净窗口记录
_t78_concur/      目录:churn 实验记录
```

---

## 八、职责边界

本报告只处理「WS-13 在 `--all` 下是否 flaky」。不改生产逻辑(`server/src/net/*`
仅注入后逐字节恢复)、不改门禁(`scripts/verify.ts` 是 Lead 写域)。

## 九、接口

1. `startWsServer({port, room, frameMs})` → `{port, close(), dropConnectionsForTest(), lastUplink()}`
2. `RoomRuntime` 的 `members` / `onlineCount()` / `disconnect(userId)`
3. `tests/WS-13.test.ts` 的 `sleep()` / `withTimeout()` / 新增 `waitUntil()`

## 十、数据结构

测量单位 `{ 样本量 N, 失败数 M, 耗时数组 ms[], 条件 }`。
★ 三条口径必须**分开记**、不可合并:
`WS-13 自身失败` / `命令退出码非零` / `WS-13 那行未打印(ABSENT)` ——
实测在 mode b 下三者是 **0 / 50 / 1**,完全不同。

## 十一、算法

统计:每样本一个 `spawnSync` 新进程;差异显著性用 Fisher 精确检验(单尾)。
追因:分层排除 → 主动改变条件(负荷/并发/churn)→ 失败时 dump 状态。

## 十二、参数与性能

| 参数 | 值 | 来源 |
|---|---|---|
| 原 `sleep` 门限 | 400/300/400/250/250/60/250/300/300 ms | 原文件 |
| 新 `waitUntil` 预算 | 2000 ms | 实测 46ms 的 **43x** |
| `withTimeout` 兜底 | 3000 ms × 3 | 原文件 |
| 单轮进程耗时 | p50 2430 / max 2628 ms | 实测 |
| 门禁给子测试超时 | **无** | `verify.ts:5246` 源码核对 |

## 十三、耦合

`WS-13.test.ts` 依赖 `server/src/net/ws_server.ts`、`room.ts`、`shared/net/delta.ts`、
`shared/testing/harness.ts`;与 `scripts/verify.ts` 的耦合点是
「`[WS-13] N/M 通过` 这一行的格式」(门禁用正则解析)。

## 十四、验收

```
node tests/WS-13.test.ts      ⇒ 20/20  exit=0
node scripts/verify.ts --all  ⇒ 全部通过  exit=0
双向注入:I1 红 / I2 绿 / 恢复后 SHA 一致
旧判据对照:同 I2 注入下旧红新绿
```

## 十五、未决

1. **连接被 TCP 重置(1006)的成因未定** —— 已排除 6 类,需更深的内核/Node 层证据。
2. 1.6% vs 0% 的因果性 **p=0.094,未达显著**,需更大样本。
3. 「回退改动跑 200 样本对比」**未做** ⇒ 无法排除我的改动对红率的间接影响。
4. `ws_server.ts:707` 的 `dropConnectionsForTest()` **内嵌 `sleep(30)`** —— 同类坏形态在生产代码里,
   建议改为等 `socket.once('close')`。**需 Lead 分派。**
5. churn 下另有 0.2–0.6% 的"连接立即被拒"(`_t78_three.ts`:A=0/500, B=1/500, C=3/500),
   形态与本次 1006 不同(那次是 0.1ms 内 error),**未定**。
6. 若将来有人**加速** WS-13,上述敏感区会咬人 —— 建议任何提速改动都必须复跑本报告的对照实验。
