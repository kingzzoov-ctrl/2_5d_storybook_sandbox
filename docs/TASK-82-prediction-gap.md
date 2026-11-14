# task-82 报告:`client/src/net/prediction.ts` 的缺口形态

> 执行者 `mob-boss-ai` · 2026-11-14
> 判定:**丙 —— 形态不匹配**(且比「逐字段改名」深一层:是**数据流缺失**,不是字段名差异)
> ★ 本报告**不改任何代码**。`client/src/net/` 是 client-stage 的活跃写域。

---

## 结论速览

```
快照链路:  服务端 → 客户端 → store → RoomState        ✓ **通**
输入链路:  键鼠 → InputCmd → predictStep → 上行 → 服务端   ✗ **全断**
⇒ 缺口在**输入端**,不在快照端。
```

**判定 = 丙。** 但要紧的是**丙的哪一层**。台账措辞「等客户端网络层消费快照」把
**两件不同的事**合在一句话里,而它们的状态正好相反:

| 那半句 | 实测 |
| :--- | :--- |
| 「等客户端**网络层**」 | **已存在** —— `session.ts:145` 有 `new WebSocket`,且 `main.ts:78` 已装配 |
| 「**消费快照**」 | **已经在消费** —— `session.ts:318` → `store.apply` → `decodePacket` → `RoomState` |

⇒ 所以理由里的两个前提**都已过期**。但 `prediction.ts` 仍不可达 —— 因为:
**网络层消费了快照,却没有任何东西把快照交给预测器;而预测器真正缺的 —— 输入 —— 根本不存在。**

---

## 快照的协议定义

```
RoomState                         shared/types/wire.ts:261
  ├ meta: RoomMetaState           :252   ← meta.tick 在 :253
  ├ players: PlayerState[]        :264   ← PlayerState 在 :192
  ├ wildlife / bosses
PlayerState                       shared/types/wire.ts:192
  ├ id / name / level / hp / maxHp
  ├ x, y, z                       :198-200   ← 位置(已反量化为「格」)
  ├ dir / stateFlag / weaponId / aiWeaponHold...
```

**关键**:位置在线上是 1/1024 格定点(`POS_SCALE = 1024`,`wire.ts:74`),
但 `delta.ts:190` 的 `case FieldType.POS: return dequantizePos(r.i32())`
⇒ **解码后已经是「格」**,与 `prediction.ts` 的 `Vec3` 同单位。
⇒ **不需要单位适配**(这是丙的一个子问题,已排除)。

`prediction.ts` 自己的 `Snapshot`(:177)是 `{tick, x, y, z}` —— 与
`RoomState.meta.tick` + `PlayerState.{x,y,z}` **一一对应**。

---

## 快照的现有写者/读者(逐个列出)

### 写者(服务端 → 客户端)

| 位置 | 动作 |
| :--- | :--- |
| `server/src/net/ws_server.ts:639` | `sendBinary(c, opts.room.snapshotFor(userId))` —— 入场首帧(**全量**) |
| `server/src/net/ws_server.ts:646` | `payload = opts.room.step(prevState)` —— 20Hz 循环(差量) |
| `server/src/net/ws_server.ts:653` | `sendBinary(c, payload)` —— 广播给已握手连接 |
| `server/src/net/room.ts:1956` | `snapshotFor(userId)` —— `encodeFull(...)` 出口 |
| `server/src/net/room.colyseus.ts:160/231` | **B 路**的同步(但 `USE_COLYSEUS_PATCH=false`,该通道关着) |

### 读者(客户端内)

| 位置 | 动作 |
| :--- | :--- |
| `client/src/net/session.ts:318` | `const r = store.apply(cls.payload)` —— **唯一的快照入口** |
| `client/src/net/state_store.ts:143` | `decodePacket(bytes)` |
| `client/src/net/state_store.ts:153` | `this.state_ = applyPacket(this.state_, pkt)` |
| `client/src/net/telegraph_center.ts:66` | `state.players.find(x => x.id === localPlayerId)` |
| `client/src/three/boot.ts:1069` | `telegraphCenterOf(authority.state, ...)` —— **唯一的渲染侧消费者** |
| `client/src/three/boot.ts:1129` | `authorityTick: authority.state.meta.tick` |
| `client/src/three/boot.ts:1132` | 同上(自检口径) |

**`prediction.ts` 不在这个列表里 —— 它一次都没被调用过。**

---

## 缺口判定:丙 + 依据

### 为什么不是甲

「甲」= 快照已到客户端,只缺一个调用点喂给 `prediction.ts`。

复检:甲**对 `Interpolator` 成立**。我实测跑通了(见「我的实验」B 段):
```
Interpolator.push({tick:100, x:3.5, y:2.25, z:0})
Interpolator.push({tick:101, x:3.7, y:2.25, z:0})
sampleAtTick(100.5) ⇒ {x:3.6, y:2.25, z:0}     ← 正确线性插值
```
⇒ **快照 → Interpolator 确实只差一个调用点。**

**但 `prediction.ts` 不只含 Interpolator。** 它 33 个导出里,
`predictStep` / `reconcile` / `resimulate` / `pruneCmds` 这一族才是核心,
而它们要的是**输入**,不是快照:

```
predictStep(p: Vec3, cmd: InputCmd, params): Vec3
                         └─ {seq, moveX, moveY, jump}
```

⇒ 客户端**没有任何东西产生 `InputCmd`**。实测证据:

```
git grep moveX/moveY -- client/src
  ⇒ 只有 prediction.ts 自己(:44,:45,:50,:51,:53,:77 —— 全是声明与使用)
  ⇒ **生产调用点 0**

boot.ts:1047-1054  WASD 的真实去向:
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
  ...
  pan.x += (dx / len) * speed;      ← 改的是**相机平移**,不是玩家
  pan.y += (dy / len) * speed;
```

⇒ 甲只能解释 `Interpolator` 那一小块,**解释不了整个文件的不可达**。

### 为什么不是乙

「乙」= 快照根本没到客户端(协议没有 / 服务端不发)。

**证伪**:`ws_server.ts:639` 与 `:653` 确实发送快照,且客户端
`session.ts:318` 确实收到并解码。端到端**通**。
(另:B 路 `USE_COLYSEUS_PATCH = false` 关着,但 **A 路是真服务端**。)

### ⇒ 丙

`prediction.ts` 依赖的数据流与客户端实际存在的数据流**不是一个**:

```
prediction.ts 假设的世界(经典 CS 式客户端预测):
  键鼠 → InputCmd{seq,moveX,moveY} → 本地 predictStep → 立即出画面
       ↘ 同时上行给服务端 → 服务端算权威 → 回发 [权威位置 + 已确认 seq]
                                          ↘ reconcile/resimulate 用 seq 重演

本仓实际的世界:
  键鼠 → 相机 pan(WASD 只平移镜头,玩家位置由服务端定)
  服务端 → 快照 → store → RoomState → 只被 telegraphCenterOf 读(取预警圈圆心)
  客户端**从不发送任何输入**(session.send 生产调用点 0)
  A 路上行二进制包**只 log 不解析**(ws_server.ts:591)
```

**这不是「字段名对不上」,是「客户端根本没有输入上行这条路」。**
⇒ 加一层字段映射的适配层**解决不了**。

---

## 逐字段差异表

### 表 A:`Interpolator` ↔ `RoomState` —— **相容,无需适配**

| Interpolator 要 | RoomState 提供 | 类型 | 单位 | 坐标系 | 判定 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `tick` | `meta.tick` | number | 帧 | 服务端 tick 轴 | ✓ 一致 |
| `x` | `players[i].x` | number | **格** | 世界格 | ✓ 一致(已反量化) |
| `y` | `players[i].y` | number | 格 | 世界格 | ✓ 一致 |
| `z` | `players[i].z` | number | 格 | 世界格 | ✓ 一致 |

### 表 B:`predictStep` ↔ 客户端可得的输入 —— **缺生产者**

| predictStep 要 | 客户端有? | 说明 |
| :--- | :--- | :--- |
| `seq` | ✗ | 无输入序号概念;协议也无回声(见下) |
| `moveX` | ✗ | WASD 只产 `pan` 的 dx/dy(`boot.ts:1047-1050`) |
| `moveY` | ✗ | 同上 |
| `jump` | ✗ | 客户端无跳跃输入 |
| `PredictParams.speedMul` | ✗ | 无来源 |
| `PredictParams.mu` | ✗ | 无来源(`physics.ts` 有 `mu: 0.75` 默认,但客户端不读) |
| `PredictParams.frozen` | ✗ | **无 `stateFlag → frozen` 映射**(`git grep stateFlag -- client` ⇒ 0 命中) |

### 表 C:`reconcile` / `pruneCmds` ↔ 客户端可得的数据 —— **缺两条流**

| 需要 | 来源 | 状态 |
| :--- | :--- | :--- |
| 预测坐标 `predicted` | `predictStep` 的产出 | ✗ 上游缺输入(表 B) |
| 权威坐标 `authoritative` | `store.state.players[i].{x,y,z}` | ✓ **有** |
| `ackedSeq`(给 `pruneCmds`) | 协议里的输入确认 | ✗ **协议无此字段** |

`ackedSeq` 的证伪(实测):
```
git grep -e ackedSeq -e acked -e lastProcessedInput -e inputSeq -- shared/net/delta.ts shared/types/wire.ts
  ⇒ 0 命中
```
⇒ 服务端回的是 `correct {x,y,z}`(`anticheat.ts:250` 的 `corrected`),
**不是「我确认到第几个输入」**。没有 seq,`pruneCmds` / `resimulate`
的「丢弃已确认输入、重演剩余」就**无从建立**。

### 表 D:模型层不匹配(数量级证据)

| 项 | 客户端 `predictStep` | 服务端「速度方案」(`integrateHorizontal`) |
| :--- | :--- | :--- |
| 公式 | `x + dir * v * DT`(不含摩擦) | `v' = v*mu + a*dt + F/m`,再 `x += v'*dt` |
| 一帧位移(v=4.5, mu=0.75) | **0.2250 格** | **0.1688 格** |
| 相对差 | — | **25.0%** |

★ 但 **A 路的 move 通道其实是「位置方案」**,不是速度方案 ——
`world_sim.ts:2154` 的 `writePlayerMove` 直接写位置(`MoveIntent` 携带**目标坐标**,
见 `anticheat.ts:283`)。该文件 `:2160` 已实测记录:速度方案与客户端预测
「**永久对不上**……差 28.0%」。
⇒ 在**位置方案**下,若服务端直接采纳客户端位置,则 `reconcile` 误差恒 ≈ 0,
`SMOOTH`/`SNAP` **永不触发**;而它们真正该触发时(服务端拒绝并回退),
回退位置**没有到达客户端的路径** —— 客户端不解析 `correct` 回执。

实测两个分支:
```
reconcile({1,0,0}, {1,0,0})   ⇒ action=IGNORE,  error=0
reconcile({1,0,0}, {1.3,0,0}) ⇒ action=SMOOTH,  error=0.30
```
⇒ `SMOOTH` 只在权威**回退**时出现,而那条数据流当前**不通**。

---

## 我的实验(命令 + 实际输出)

### 实验 1:快照 → Interpolator 可行性(证「甲对插值器成立」)

```
node _mb_t82_probe1.ts
```
```
═══ 实验 B:Interpolator 能否吃 RoomState 的字段 ═══
  push 两个快照后 size = 2, latestTick = 101
  sampleAtTick(100.5) = {"x":3.6,"y":2.25,"z":0}
  ⇒ 字段 {tick,x,y,z} 与 RoomState 的 (meta.tick + player.x/y/z) 可无损拼出

═══ 实验 C:predictStep 需要什么,客户端有没有 ═══
  predictStep({0,0,0}, {seq:1,moveX:1,moveY:0}) = {"x":0.225,"y":0,"z":0}
  ⇒ predictStep 能跑,但它要的是 InputCmd
  ⚠ 客户端没有任何东西产生 InputCmd —— WASD 只驱动相机 pan

═══ 实验 D:reconcile 需要什么 ═══
  reconcile(预测{1.0}, 权威{1.2}) = action=SMOOTH, error=0.2000
  ⚠ 客户端能拿到权威坐标,但拿不到预测坐标
```
⇒ **`Interpolator` 可接(甲);`predictStep`/`reconcile` 不可接(丙)。**

### 实验 2:端到端判定表

```
node _mb_t82_probe3.ts
```
```
✓ 快照到没到客户端: ws_server:639/653 每 20Hz sendBinary(RoomState 差量)
✓ 快照→Interpolator 形态: {tick,x,y,z} ↔ meta.tick+player.{x,y,z} 相容
✗ 客户端有无预测坐标: predictStep 生产调用点 0 ⇒ 无
✗ 客户端有无 InputCmd 生产者: WASD 只驱动相机 pan,不产 moveX/moveY
✗ 客户端有无上行发送调用: session.send 生产调用点 0
✗ 协议有无 ackedSeq 回声: delta.ts / wire.ts 均为 0 命中 ⇒ 无
✗ PredictParams 来源: stateFlag→frozen 无映射、mu 无来源

⇒ 快照链路通,输入链路全断 ⇒ 缺口在输入端,不在快照端
```

### 实验 3:白名单理由过期性

```
node _mb_t82_probe4.ts
```
```
===> 客户端 .ts 文件数 = 27
（白名单注释说「24 个文件里 0 个有 WebSocket」）
  client/src/net/session.ts:145  ?? ((u: string) => new WebSocket(u) ...)
  ⇒ 命中 1 处
  session.ts 存在   : true
  session.ts 有 WS  : true
  main.ts 调 createSession: true
  ⇒ 网络层已存在且已装配进 main.ts ⇒ 理由里的「等客户端网络层」已过期
  ⇒ 快照已被消费:session → store.apply → decodePacket → RoomState
```

### 实验 4:模型量级对比

```
node _mb_t82_probe6.ts
```
```
10 步后 predictStep 位置 = x:2.2500  (每步 0.2250 格)
一帧后 vx = 3.3750(初值 4.5)  ⇒ 位移 0.1688 格
⇒ 相对差 = 25.0%
```

---

## 缺口该由谁提供 / 改什么(任务书要求,不能只说「接不上」)

按缺口**由谁解**分三层,三层的责任人与量级都不同:

### 第 1 层:输入生产者(客户端,client-stage)

```
缺:键鼠 → InputCmd{seq,moveX,moveY,jump} 的翻译层
改:client/src/three/boot.ts 或新建 client/src/net/input.ts
硬约束:WASD 现在驱动的是**相机 pan**(boot.ts:1047-1054)。
       若直接改成驱动 InputCmd,会同时改变**相机行为** ⇒ 必须先裁决
       「WASD 是镜头还是角色」(这是产品裁决,不是接线)
```

### 第 2 层:上行通道(协议 + 服务端,跨写域)

```
缺:客户端把 InputCmd 发出去的调用点
现状:session.send 存在且可用,但**生产调用点 0**
缺:协议里的输入确认(ackedSeq)⇒ pruneCmds/resimulate 需要
改:shared/net/delta.ts(加字段) + ws_server.ts:591 那一行
    ⚠ ws_server.ts:591 现在**只 log 不解析**(注释自述「真接生产时在这里把 body 交给 decodePacket」)
    ⚠ B 路 room.colyseus.ts:280 的 onMessage('move') 语义是**位置**,
      不是方向 ⇒ 两条路的上行语义要先统一(见下)
```

### 第 3 层:语义统一(设计裁决)

```
冲突:A 路 move 通道收 MoveIntent{tick,x,y,z} —— **目标位置**
      prediction.ts 产出位移增量(预测坐标)
      world_sim.ts:2154 是「位置方案」(writePlayerMove 直接写位置)
⇒ 若上行发「目标位置」,则客户端预测的**意义被削弱**:
   服务端会直接采纳,reconcile 恒 IGNORE ⇒ 预测层等于没在工作
⇒ 若上行发「方向输入」,则要改服务端 move 通道的语义(反作弊 checkMove
   判的是 dist(新旧坐标),见 world_sim.ts:2169)
⇒ ★ 这是**产品/架构裁决**,不是接线工作
```

### ⚠️ 不建议的做法(写明以免后来者踩)

**不要**只把 `Interpolator` 接上就宣布 `prediction.ts` 已接线。

理由:那只能消掉白名单里的一行,而**文件的其余部分(`predictStep`/`reconcile`/
`resimulate`/`pruneCmds` —— 33 个导出里的大半)仍是死代码**。
更坏的是:一旦移出白名单,可达性门禁**此后再也不看它** ——
而它实际上只接了 1/5 的功能。
这正是你在 task-79 项 3 里查出的那个反面教训:**数字变小 ≠ 事情变好。**

---

## 移出白名单所需的数字

**不给出。** 理由:判定为丙,「可接」这个前提不成立。

若将来三层都补齐,那时才该给数字。现在给会误导——
它会被读成「接上就能摘」,而实际上摘了只会让门禁失明。

参考:当前白名单 **14** 条(实测解析),非欠账 6 条(2 gate-only + 4 差集),
真欠账 8 条 —— 与你给的一致,我不重复论证。

---

## 我留下的临时文件(逐名)

```
_mb_t82_probe1.ts
_mb_t82_probe2.ts
_mb_t82_probe3.ts
_mb_t82_probe4.ts
_mb_t82_probe5.ts
_mb_t82_probe6.ts
```

(共 6 个,仓库根目录,**未删除**,按纪律由你按全名处置。)

---

## 未做项 + 理由

| 未做 | 理由 |
| :--- | :--- |
| 改 `client/src/net/prediction.ts` | **不在我写域**;且本任务默认产出是报告 |
| 改 `client/src/three/boot.ts` | 同上。且改动涉及「WASD 是镜头还是角色」的产品裁决 |
| 接线 `Interpolator` 到 `boot.ts` | 技术上可做(实测相容),但**只接 1/5 会掩盖其余 4/5** —— 见「不建议的做法」 |
| 改 `scripts/verify.ts` 的白名单理由 | 不在我写域。**但那条理由已过期**,我给出订正文本如下 ↓ |
| 改 `server/src/net/ws_server.ts:591` | 不在我写域 |
| 加 `ackedSeq` 到协议 | 不在我写域(协议变更须裁决) |

### 白名单理由的订正文本(供你直接采用)

现文本(`verify.ts:1494`):
```
['client/src/net/prediction.ts', 'WS-07 客户端预测(客户端模块)—— 等客户端网络层消费快照']
```

问题:前提**两个都已过期**(网络层已存在;快照已被消费)。

建议改为:
```
['client/src/net/prediction.ts',
  'WS-07 客户端预测(客户端模块)—— 快照链路已通(网络层在岗、RoomState 进 store),'
  + '但预测器要的是**输入**(InputCmd),而客户端无输入生产者、无上行发送调用、'
  + '协议无输入确认 ⇒ 缺口在**输入端**;且 move 通道语义(位置 vs 方向)待裁决']
```

★ 改后它会落到 `mechanism` 桶还是 `decision` 桶,取决于你——但**不再**是
「等客户端网络层」(那条已不成立)。

---

## 我能证明的

1. **快照链路通**:`ws_server.ts:639`(入场首帧)+ `:653`(20Hz 广播)确实发;
   `session.ts:318` → `state_store.ts:143/153` 确实收并解码成 `RoomState`。
2. **`prediction.ts` 生产调用点 = 0**:`git grep prediction -- client tests` 里
   客户端侧唯一命中是 `state_store.ts:9` 的**注释**(「不碰预测」)。
   `tests/WS-07.test.ts:134` 是**测试**引用,不是生产。
3. **客户端无输入生产者**:`moveX/moveY` 在 `client/src` 下只出现在
   `prediction.ts` 内部;`boot.ts:1047-1054` 的 WASD 写的是 `pan`(相机)。
4. **客户端无上行发送**:`session.send` 在 `client/src` 下生产调用点 **0**
   (`session.ts:339` 是它自己的定义,`:266` 是 hello 帧)。
5. **协议无输入确认**:`delta.ts` 与 `wire.ts` 里 `ackedSeq`/`acked`/
   `lastProcessedInput`/`inputSeq` **0 命中**。
6. **`Interpolator` 与 `RoomState` 相容**:实测 `push` 两个快照后
   `sampleAtTick(100.5)` 返回正确的线性插值 `{x:3.6, y:2.25, z:0}`。
7. **位置单位不需要适配**:`delta.ts:190` 用 `dequantizePos` 反量化 ⇒
   解码后已是「格」,与 `Vec3` 同单位。
8. **白名单理由的两个前提都已过期**:客户端现有 **27** 个 .ts(注释说 24),
   其中 `session.ts:145` 有 `new WebSocket`(注释说「0 个有」),
   `main.ts:78` 已调 `createSession`(注释说「客户端仍无网络层」)。
9. **模型量级不同**:`predictStep` 一帧 0.2250 格 vs 服务端速度方案 0.1688 格
   ⇒ 相对差 25.0%。(同源事实: `world_sim.ts:2160` 记的 28.0%,口径略异 —— 见「我不能证明的」4)
10. **`telegraph_center.ts` 是同类先例且可达**:同目录、同形态
    (`RoomState` → 纯函数),**不在白名单** ⇒ 证明「在客户端里让快照被消费」本身可行。

## 我不能证明的

1. **我没有验证客户端是否真能连上 A 路服务端跑起来。**
   `ws_server.ts` 有 `listen`(`:690`),但我没起真服务。
   「快照链路通」是**读码 + 单向实测解码**得出的,不是端到端联调。
2. **「WASD 该驱动镜头还是角色」是产品裁决,我无法判定。**
   我只能证明它**现在**驱动镜头(源码直读)。哪一种对,不在这份证据范围内。
3. **我没有穷举 `prediction.ts` 33 个导出的每一个消费者。**
   我查了 `client/src`、`server/src`、`tests/`、`scripts/`,但
   「`tests/` 引用」是否算「消费」取决于口径。若你采「测试也算」,
   则它**有 1 个消费者**(`tests/WS-07.test.ts:134`)—— 那会把它从
   `orphan` 推向 `gate-only` 家族,不影响本报告的丙判定。
4. **25.0% 与 `world_sim.ts` 记的 28.0% 口径可能不同。**
   我算的是「同 dt 下一帧位移之比」,源码那句没写清是几帧、初速是否同一时刻。
   我没有复现出 28.0% —— 两个数都**不能互相印证**,所以我把我的算法与
   输入都写明了。**若以 28.0% 为准,说明我对该段的理解有偏差。**
5. **我没有核实 B 路(`room.colyseus.ts`)的 `onMessage` 是否真的活着。**
   `USE_COLYSEUS_PATCH = false` 关的是 patch 通道,`onMessage` 通道
   按你的说法是「只剩协议语义」。我没有独立验证 `onMessage` 在
   patch 关掉后仍会被触发。
6. **我没有验证「服务端在位置方案下会直接采纳客户端位置」。**
   我从 `writePlayerMove` 的 docblock 与 `MoveIntent` 的字段推出该语义,
   但没有跑 `applyMove` 观察它是否真采纳。
   ⇒ §「第 3 层」里「reconcile 恒 IGNORE」是**推论,不是实测**。