# 事件总线与生物宿主

> 这份文档说明「事件驱动子系统」在编排层里的归属,以及接一个新的
> 事件驱动系统时要做什么。**事件总线是伤害结算 / Boss 阶段 / 炼金 /
> 生物行为四类子系统的共同前置** —— 先定总线形态,能避免它们各自
> 发明一套通知机制。

---

## 0. 先读:为什么需要这一层

`WorldSim` 已经解决了**连续型**子系统的推进问题(双频调度:
物理 20Hz、流体/电路/AOI 2Hz)。但本项目还有**事件型**子系统:
伤害结算、Boss 阶段切换、炼金产出、生物行为触发 —— 它们「有输入才动作」,
不属于「每帧 step」。

这类子系统此前**没有归属**,后果是具体的、可测的:

| 事实(实测) | 后果 |
| :--- | :--- |
| `behaviors.ts` 有 **30 处 `world.emit(kind, payload)`**,覆盖 **29 种事件** | 全部喊给空气:没有任何接收方 |
| `MobWorld` 是 **interface**,全仓**无任何类实现它** | 25 个 AI 类拿不到世界 |
| `createMobAi()` 工厂可用,24 条注册齐全 | 但**没有任何地方调用 `ai.tick()`** |
| 编排层是 `aoi.stepActive(() => {})` —— **空回调** | AOI 遍历了唤醒集合却什么都不做 |
| `MobFsm.tick()` 一个完整实现 + 55 条断言 | 生产代码里**从未被调用**,只在测试里 |

也就是说:生物 AI 的「接入」缺的不是一个宿主类,而是**三件事一起缺** ——
一个适配世界的宿主、一个接收事件的出口、一个把 AOI 结果变成运行时的映射。

---

## 1. 事件总线的契约

`server/src/events/bus.ts`

### 1.1 订阅

```ts
bus.on('boar_wall_stun', handler);  // 精确
bus.on('mimic_*', handler);         // 前缀通配(尾随 *)
bus.on('*', handler);               // 全部
const off = bus.on(...); off();     // 取消订阅
bus.once('*', handler);             // 一次
```

> **写法陷阱(已踩过)**:本项目事件名全是 `snake_case`(`mimic_ambush`),
> 分隔符是**下划线**。我最初只支持 `mimic.*` 这种点分隔前缀 ——
> 实测它**一个事件都匹配不到**,因为没有任何事件名含点。
> 这种「看起来能用但恒不命中」的语法比语法错误更糟:订阅方以为
> 自己订上了,不报错,只是永远收不到。
>
> 现在**尾随 `*` 即前缀匹配**,与命名约定无关。`A03b` 断言把这个陷阱固化。

### 1.2 投递语义

| 性质 | 取值 | 理由 |
| :--- | :--- | :--- |
| 时机 | **当帧**内投递完(`drain()` 每帧一次) | 玩法需要「立刻看到反应」 |
| 顺序 | 同帧 FIFO;订阅按注册顺序 | 可预测 |
| 处理器内 `emit` | 追加到**当帧队列尾**,不递归 | 不加深调用栈 |
| 收件人 | 投递前**快照** | 处理器内增删订阅不影响本次 |
| 抛错 | **隔离**,记入日志,同帧其它照常 | 一个坏处理器不该拖垮一帧 |
| 上限 | 每帧 4096 事件 / 每事件 512 处理器 / 重入深度 8 | 兜住死循环 |
| 超限 | **丢弃并记账**(`dropped` + `<overflow>` 日志) | 不静默吞掉 |
| 确定性 | 无 `Math.random`,同输入必同投递序列 | 回放要求 |

### 1.3 观测

```ts
bus.snapshot()        // { frame, pending, subs, totals }
bus.history()         // 最近 512 条投递记录(含错误与丢弃)
bus.countOf('boar_wall_stun')
bus.totals            // 累计 emitted/delivered/dropped/errors/frames
```

`history()` 是**环形缓冲**且按时间序返回 —— 长跑不会内存增长,
且 `A17` 断言了「环形覆盖后仍是时间序,不是物理序」。

---

## 2. 生物宿主

`server/src/mobs/host.ts` —— `MobWorld` 的第一份真实实现。

### 2.1 职责

```
WorldSim ──窄适配器──> MobHost ──MobWorld 接口──> 25 个 AI 类
                         │
                         └──> EventBus ──> 订阅方
```

- **登记**:`addMob(id, def, x, y)` 造 `MobRuntime`(含跨帧存活的 `mem`)
- **推进**:`tickMobs(ids, dt)` —— 只推进传入的 ID(可见性归 AOI 管)
- **转发**:`damage()` / `interact()` 转到生物的 AI(格挡/反弹才生效)
- **出口**:AI 的 `emit` 走总线

### 2.2 三个不显眼但必须知道的点

**(a) `emit` 的 `source` 由宿主补**

25 个 AI 调用 `world.emit('kind', payload)` 时**不传自己的 ID**。
宿主在 `tickMobs` 里维护「当前正在推进谁」,用它补上 `source`。
所以 `behaviors.ts` 必须只在自己的 `tick` 调用栈内 emit —— 实际用法如此。
`B10` 断言每个事件的 `source` 都是真实生物 ID。

**(b) 未注入总线时事件仍被计数**

`totals.emitted` 照常增长但投递数为 0。表现是
「发出 N 个但投递 0 个」——**可观测**。若连计数都不加,
「忘了接总线」就完全无痕。`B12` 断言这一点。

**(c) 宿主**绝不**调用 `fsm.tick()`**

见下一节。这是本层最重要的设计约束。

**(d) 玩家与生物在 `physics.bodies` 里混在一起**

`addPlayer` 和 `addMob` **都调 `physics.spawn`**,所以刚体表里玩家与生物
无法区分。宿主需要的 `MobWorld.players()` 必须靠**单独的 `playerIds` 记账**
来筛,不能直接把 `bodies` 当玩家列表。

两种错法都不报错:

| 错法 | 表现 |
| :--- | :--- |
| 忘了同步 `mobPlayers` | `nearest()` 恒返回 `null` → **所有追猎行为永不触发**;AI 仍在跑、`mem` 几乎为空(实测 `mob_boar` 的 mem 是 `{}`) |
| 把 `bodies` 直接当玩家列表 | 生物**互相视为玩家** → 野猪冲绵羊、莫名攻击性 |

这不是理论假设:接线时确实先漏了同步(实测 `mobHost.players()` 返回 **0**,
野猪 `mem` 为 `{}`),修好后才变成 **1** 且野猪写出了完整的冲锋状态机
(`lockDeg` / `travel` / `charging` / `selfStun`)。`C09`–`C12` 四条断言
+ verify 两条断言守住,其中 `C12` 是**对照组**(无玩家时不该追猎),
防止 `C11` 退化成恒真。

---

## 3. 已裁决:移动权威 = 方案 D(FSM 基础移动 + AI 专属动作)

> **【CR-9 已裁决】** 本节原写「三个候选方向(A/B/C)都未决,倾向 A」。
> 实测推翻了那个判断 —— 详见下方「为什么 A/B/C 都不选」。

`MobFsm`(`mobs/fsm.ts`)是一个**完整实现的**三态机:
闲逛挑点、45° 避障 steering、预警几何、攻击后摇。它自带
`x` / `y` / `vx` / `vy`,并在 `tick()` 里**自己推进位置**。

而 25 个 AI 子类**各自直接写 `rt.x` / `rt.y`**。实测统计:

```
rt.x = / rt.y = / rt.x += / rt.y +=      共 7 处(4 个 AI 自行移动)
rt.fsm.*  被用到的字段                    只有 2 个:flee(2 处)、state(1 处)
```

### 关键实测:不调 FSM 的后果是「生物永远站着」

原先宿主**绝不调用** `fsm.tick()`(怕两个移动权威互相覆盖)。
但那个保守选择的真实代价是:

| 场景 | 实测(60 秒) |
| :--- | :--- |
| 启用前:**22/24** 生物 | 位移 **0.00 格**,与玩家在不在场**无关** |
| 启用前:仅 `mob_sky_manta` | 37.17 格(它的 AI 自己写位置) |
| `fsm.tick()` 单独跑 120 帧 | 闲逛 **5.44 格**;玩家在 3 格外时追猎至攻击距离 |

也就是说:**「不调 FSM」不是保守,而是让 22 种生物连游荡都不会** ——
而游荡逻辑**只存在于 FSM 里**。

### 为什么 A/B/C 都不选

| 方向 | 为什么不选 |
| :--- | :--- |
| **A. FSM 接管全部移动** | 要删掉 AI 的 7 处位置写入,而那 7 处是**专属运动**:史莱姆跳向甜莓、野猪锁定直线冲撞、穿山甲翻滚、蝠鲼参数化滑翔。它们不是「通用移动」,交给 FSM 就丢了特色(违反 LEAD-PLAN 风险 R2) |
| **B. FSM 退化为纯状态机** | 要删掉 steering —— 实测 `fsm.ts` 里 `steer` 出现 24 次、`probe` 19 次、45° 避障 15 次,那是 WS-04 的核心产出 |
| **C. 双写同步** | 保留 steering 却不能用它移动,属「都不选」的中间态 |

### 方案 D(已实施):按**动作类型**分工

1. **FSM 先算基础移动**(游荡 / 警戒 / 追猎)—— 带 45° 避障,写进 `rt`;
2. **AI 随后执行自己的 `tick`**;
3. **若 AI 写了位置**(与 FSM 落点不同,容差 `1e-6`),就以 AI 为准,
   并把 FSM 的内部位置**同步到 AI 的落点**;
4. **若 AI 没写**,FSM 的位移留下。

判据是「AI 有没有写位置」而**不是**「AI 属于哪一类」——
新增 AI 无需注册,改了某个 AI 的移动也不会悄悄失效。

**效果**:22/24 生物恢复游荡(约 1.8 格/60 秒),玩家在场时追猎
(实测 `mob_ginger_imp` 15.31 格、`mob_boar` 4.25 格)。

### 为什么「同步」是必须的(不是可选的美化)

去掉第 3 步的同步后,故障注入立刻报红:**FSM 与 rt 位置分叉,最大偏差 4.5**。
两条轨迹越走越远,表现就是**生物瞬移** —— 比「生物不动」更难查。
所以正确的不变量不是「不调用」,而是「**调用之后位置不分叉**」。

宿主暴露 `totals.fsmMoves` / `totals.aiOverrides` 两个计数,
用于观测两条路径是否都真的被走到。

---

## 4. 接一个新的「事件型子系统」

以「Boss 阶段切换」为例:

1. **定义事件名**:小写下划线,`<主体>_<动作>`。如 `boss_phase_changed`。
   先在这里登记(见 §5 清单),避免与 AI 事件撞名。
2. **发出**:在状态切换点 `world.emit('boss_phase_changed', { bossId, phase })`
   —— 通过宿主/编排层的出口,不自己造通道。
3. **订阅**:在编排层或该子系统的初始化处 `sim.bus.on('boss_phase_changed', fn)`。
4. **断言**:在对应测试套里订阅并断言「事件发出 N 次且 payload 正确」。
   **不要只断言「没抛错」** —— 那不是门禁。
5. **登记**:更新 `docs/CHANGE_REQUESTS.md` 与本文档 §5。

### 若该子系统不属于「AI 的 emit」

也**照样走总线**。理由:统一出口才能统一观测(`history()` / `totals`)
与统一上限。为某个子系统单开一条通知路径,等于放弃了这两个保障。

---

## 5. 已登记的事件种类(29 种,来自 `behaviors.ts`)

```
bat_sonar_jammed           beaver_dam_built          beaver_hammered
beetle_flipped             boar_charge_end           boar_slip_stun
boar_wall_stun             capybara_heart_reflect    choco_melted
chocobo_feed_failed        chocobo_tamed             crab_soup
ginger_escaped             ginger_hooked             harpy_ensemble_gift
harpy_gust                 knight_key_pulled         lava_solidified
manta_ride                 mimic_ambush              mimic_exploded
pangolin_batted            pangolin_wall_stun        samurai_burning
samurai_ignited            scorpion_ambush           scorpion_forced_surface
tanuki_ambush              thunder_discharge
```

`B11` 断言「实际投递的事件名全部在这 29 种之内」—— 防拼写错误
造出无人订阅的幽灵事件。

---

## 6. 验收

```bash
node tests/WS-FND-02.test.ts      # 48 条断言
node scripts/verify.ts --content  # 内容门禁不受影响
```

故障注入验证(全部被捕获):

| 注入 | 结果 |
| :--- | :--- |
| 宿主给 `fsm = undefined` | ✗ 4 条失败(B03/B04/B05/C04),复现原始的 12.5% 抛错率 |
| 宿主调用 `fsm.tick()` | ✗ B04:`fsm.ticks 期望 0 / 实际 30` |
| 移除编排层 `bus.drain()` | ✗ C02:`drain 次数 期望 100 / 实际 0` |
| 前缀通配退回点分隔 | ✗ A03/A03b:`mimic_* 收 2 / 实际 0` |

---

## 7. 未决

| # | 事项 | 阻塞什么 |
| :-- | :--- | :--- |
| ~~U1~~ | ~~**移动权威**(§3 三方案选哪个)~~ **已裁决并实施(CR-9)** | 选定**方案 D**:FSM 做基础移动(游荡/警戒/追猎),AI 做专属动作;AI 写了位置就以 AI 为准并把 FSM 同步过去。实测依据:启用前 **22/24 生物 60 秒位移为 0**(与玩家在不在场无关)。见 §3 | 已解决 |
| U2 | 事件是否需要**跨帧队列** | 当前当帧投递。若将来要「延迟 2 秒再响应」,得加调度层 |
| ~~U3~~ | ~~事件是否要**持久化/重放**~~ **前提已证伪,关闭(CR-11)** | 原写「回放系统若要做,需先定事件的可序列化边界(**suppress 闭包**)」。实测三点:**(1)** 全仓没有 `suppress` 闭包(`spawner.ts` 里的 `suppressed` 是刷怪光照抑制,与事件无关);**(2)** 可序列化边界**已经由类型定死** —— `EventPayload = Record<string, number \| string \| boolean>`,33 个 emit 点、32 种事件实测全部可 JSON 往返,无函数/undefined/NaN;**(3)** 确定性成立 —— 同种子两次运行事件序列**逐字节一致**。真正缺的不是「定边界」,而是**事件根本没产生**(见 U7) | 已解决 |
| U4 | `lastMobTicks` 是否要进 `SimFrameReport` | 观测粒度;当前只在 `WorldSim` 字段上可读 |
| ~~U5~~ | ~~**生物→玩家的伤害闭环**~~ **已解决(CR-7)** | 已定出口:`VitalsSystem.applyHit(attackerId, playerId, level, mul, distance)`。生物不写玩家 `hp`,而是**产出意图**(预警几何 + `frameEmits` 事件),由编排层 `resolveMobStrikes()` 统一结算。这满足「不越权、语义正确」两个要求 | 已解决 |
| U6 | 事件名的**命名空间** | 当前 29 种全是 snake_case 前缀风格(`boar_*`),无正式规范 |
| U7 | `unknownMobs` 是否应为**硬失败** | 当前只收集。传错 ID 会让生物「存在但不行为」 |
| ~~U8~~ | ~~**靠交互/受击触发的事件在生产中不产生**~~ **已解决(CR-11)** | 32 种事件里 **9 种靠 `onInteract` / `onDamage` 触发**,而 `MobHost.interact()` / `damage()` 虽完整实现,`world_sim.ts` 里**零调用** —— 这 9 种永不发生。已补编排层入口 `interactMob()` / `damageMob()`;实测事件种类 **9 → 18**(只 tick 时 4 种,接上交互/受击后 13 种)。这是本项目**第四次**「完整实现但编排层不接」 | 已解决 |
