# 阶段 3 契约草案(CR-26 选型未裁 + 接线前置)

> **本文只定契约,不写实现。** 全部形状**读实现实测**,不猜。
> 作者:`client-stage`(task-67 阶段 3)。待 Lead 裁决后再落代码。
> 生成时点:2026-11-13 03:2x(仓库状态:门禁 exit 0 · 1382 条 / 21 套件 · 可达 78/93)

---

## 0. 一句话

**客户端零依赖解一条 20Hz 字节流**;服务端已经在 encode,客户端只缺「收字节 + 解 + 灌进渲染」这三步。
**唯一待裁的是通道形状**(CR-26),它决定握手往哪放、以及 `move` 上行怎么走。

---

## 1. 通道目标形态(CR-26 未裁 —— 我列两条,附实测证据)

### 已实测的硬事实(可直接采信)

```
✓ `shared/net/delta.ts` 的传递闭包 **4 个文件**,全在 shared/,零非相对导入:
    shared/net/delta.ts → types/{entities,physics,wire}.ts
  ⇒ 客户端 import 它零新增依赖 ⇒ 浏览器可直接加载
✓ 往返实测:encodeFull → decodePacket → applyPacket 全通(26 字节)
✓ Node 24 内置 `WebSocket` 二进制帧往返**逐字节一致**(双向 11 B,含阴性对照)
✓ `client/src/three/boot.ts` 的闭包:28 文件,**server 0 个**,唯一三方是 `three`
✓ `server/src/net/room.colyseus.ts:41` `USE_COLYSEUS_PATCH = false`(Colyseus 同步通道已关)
```

### 分支甲 / 乙对照(等 Lead 裁)

| | 甲:colyseus 协议 | 乙:裸 WebSocket(**我倾向**) |
| :--- | :--- | :--- |
| 客户端依赖 | 需 colyseus client | **零**(内置 WebSocket) |
| 握手形状 | 由框架定(join 消息) | 我们自己定(§2) |
| 上行 `move` | `this.onMessage('move', ...)` 现成 | 需自定义帧头 |
| 现状 | 该通道的同步已被 `USE_COLYSEUS_PATCH=false` 关掉 | — |

**⇒ 倾向乙的实测理由**:服务端已有 `encodeFull`/`encodeDelta`/`decodePacket` 全套手写编解码;
而 `room.colyseus.ts:191-239` 的 4 个 `onMessage`(`move`/`attack`/`inventory`/`action`)是**协议语义**,
与运输层无关 —— 换运输层**不丢语义**,只是把「谁来收字节」换掉。
**⚠️ 我不替 Lead 定** —— 选型影响契约形状,这是他要裁的第一项。

---

## 2. 首次握手要交换什么(实测形状,不是设计稿)

### 已有的现成件(实测签名)

```ts
/* server/src/content/handshake.ts —— 实测导出 13 条,关键 4 条 */
interface ClientContentClaim { version: number; overall: string; parts?: {...} }   // L116
function localContentClaim(): ClientContentClaim                                   // L129
function encodeContentClaim(claim?: ClientContentClaim): string                    // L297
function decodeContentClaim(s: string|null|undefined): ClientContentClaim|null     // L307
function verifyContentCompatibility(claim, policy?): ContentCompatResult           // L163
const ContentPolicy = { ... }; const DEFAULT_CONTENT_POLICY = ContentPolicy.STRICT // L101/111
```
**线格式实测**(`encodeContentClaim` L298-303):`v{version}-{overall}` 或 `v{version}-{overall}-{items}.{mobs}.{bosses}.{modes}`
**解析判据实测**(L319):段数必须**恰好 2 或 3** —— 多余段判非法(有注释说明为什么不宽松)。

### ★★ 但这里有一个**必须先裁**的问题(我没有答案,只报事实)

```
实测 `handshake.ts` 的传递闭包 **6 个文件**,其中 2 个在 server/:
    server/src/content/handshake.ts
    server/src/content/registry.ts     ← ★ 非 shared
    shared/constants/{bosses,items,mobs}.ts
    shared/types/entities.ts
零非相对导入 ⇒ 两个 server 文件**都是纯的**(实测:无 node:*、无 readFileSync、无 process)
⇒ 所以它们与 wire.ts/delta.ts **同性质**:纯逻辑,只是位置在 server/
⇒ 若上移(registry 522 行 + handshake 366 行)⇒ 客户端可**自算指纹** ⇒ 握手可做**双向核对**
⇒ 若不上移 ⇒ 客户端**只能收**服务端的指纹(不能自己核)⇒ 握手退化为单向
对比:`server/src/content/baseline.ts` **不纯**(实测含 node:fs / readFileSync)⇒ 不可上移
```

**⇒ 要 Lead 裁的第二项**:`registry.ts` + `handshake.ts` 是否上移 `shared/content/`?
（我不擅自扩大上移范围 —— delta.ts 那次已经证明「协调面 ≠ 改动面」。）

### 握手内容(我建议的最小集,每项都指出现成来源)

| # | 字段 | 来源 | 现状 |
| :--- | :--- | :--- | :--- |
| 1 | 协议版本 | `delta.ts:50 PROTOCOL_VERSION = 1` | 已存在;`decodePacket` 会**主动校验**(version 不符抛错) |
| 2 | 内容指纹 | `handshake.ts` | 已存在(见上,待裁归属) |
| 3 | 房间号 | `room.colyseus.ts` 的 room 机制 | 甲分支现成;乙分支需自定义 |
| 4 | 玩家 ID | `room.ts` 的 `createPlayerState(id, ...)` | 已存在 |
| 5 | 入场凭据 | `onJoin(client, { passwordHash?, asGuest? })` L134 | 已存在(实测形参) |

**⇒ 我建议**:版本与指纹**必换**(少了会静默错配 —— `WS-FND-03` 已断言"两端内容错配在生产上确实无人拦截");
房间号/玩家 ID 归**分支裁决**;入场凭据沿用现成形状。

---

## 3. 客户端如何消费快照(三步,输入输出形状全部实测)

```ts
/* ① 收字节 → 解包 */
import { decodePacket, type DecodedPacket } from '../../shared/net/delta.ts';
// 实测签名:function decodePacket(bytes: Uint8Array): DecodedPacket
interface DecodedPacket {                        // delta.ts:413 实测
  version: number; op: PacketOp; tick: number;
  removed: { kind: number; id: string }[];
  upserts: { kind: number; id: string; mask: number; fields: Record<string, unknown> }[];
  bytesConsumed: number;
}

/* ② 解包 → 状态(注意:applyPacket 不是原地改!) */
// 实测签名:function applyPacket(base: RoomState, pkt: DecodedPacket): RoomState
// ★ 体内第一行是 `const out = cloneRoomState(base);`(L452)⇒ **返回新对象**,base 不变
//   且 `out.meta.tick = pkt.tick` **无条件覆盖**(L453)—— 注释:「帧号是单调时钟,不是 diff 字段」

/* ③ 状态 → 渲染:*这一步客户端目前完全没有* */
interface RoomState { meta, players[], wildlife[], bosses[] }   // 见 wire.ts
// boot.ts 现在读的是 `playerGx/playerGy`(局部变量)⇒ 阶段 3 要改成从 RoomState 取
```

**⚠️ 两处实测出来的坑(接线时必须处理)**
```
1 `applyPacket` 返回新对象 ⇒ 必须**接住返回值**;写成 applyPacket(s, pkt) 丢掉返回值会静默无效
2 `decodePacket` 对版本不符**抛异常**,对 `op` 未知**抛异常** ⇒ 网络回调里必须 try/catch,
   否则一个坏包会打断整个渲染循环
```

---

## 4. ★ 预测/回滚是否需要(第 4 问,我给了实测依据)

**结论:需要,但 `prediction.ts` 已经写好了,不需要新写。**

```
实测 `client/src/net/prediction.ts` 导出 26 条,已含完整预测+和解:
  InputCmd / predictStep / normalizeInput / maxSpeed           ← 预测
  reconcile / ReconcileAction / absorbOffset / resimulate      ← 和解
  Interpolator / Snapshot / simulateInterpolation              ← 插值
  LossyChannel / LossyChannelOptions                           ← 丢包模拟
  常量:RECONCILE_DEADZONE .05 / RECONCILE_HARD_SNAP 1.5 / SMOOTH_WINDOW_S .25
        INTERP_DELAY_S .1 / SNAPSHOT_BUFFER_S 1.0 / MAX_EXTRAPOLATE_S .25 / TELEPORT_DISTANCE 8
实测它的 import **只有一行**:`shared/types/physics.ts` ⇒ **零 server 依赖,零三方** ✓
```
**⇒ 它与协议是**两个正交维度**:协议给「权威状态」,prediction 给「本地立即反馈」。
**⇒ 我建议阶段 3 的**最小接线不接预测**(先让权威位置画对),预测作为紧接的第二步 ——
   因为验收判据是「**预警圈圆心 == 权威玩家位置**」,**那一条恰恰要求"不要被本地预测污染"**。

---

## 5. 写域声明(★ 请先审再批)

### 我打算**新增**

| 文件 | 行数估计 | 作用 |
| :--- | :--- | :--- |
| `client/src/net/session.ts` | ~120 | 连接 + 握手 + 帧循环;**唯一**碰 WebSocket 的地方 |
| `client/src/net/state_store.ts` | ~80 | 持有 `RoomState`,把 `applyPacket` 的结果换进去;对外只读 |
| `tests/WS-09.test.ts`(追加) | ~60 | ① 圆心 == 权威位置 ② `applyPacket` 返回值被接住 ③ 坏包不崩 |

### 我打算**改**

| 文件 | 改动 | 风险 |
| :--- | :--- | :--- |
| `client/src/three/boot.ts` | **删 `:1033-1034`**(`playerGx = pan.x` 那两行);`playerGx/playerGy` 改从 `state_store` 取 | ★ 高 —— 见 §6 |
| `client/src/ui/boss_hud.ts` | `TelegraphShape` 改从 `shared/types/wire.ts` 取(消 5/5 下标冲突) | 中 —— 有既有测试覆盖 |
| `client/src/main.ts` | 启动时建 session | 低 |

### 我**不碰**

```
server/** · shared/** · scripts/** · README.md · docs/PROGRESS.md · docs/CHANGE_REQUESTS.md
tests/WS-FND-*.ts · tests/WS-11.test.ts(除非用户要求)
```

---

## 6. ★ 阶段 1 的 S1/S2 **必须按序**(顺序反了会静默失效)

```
S1 **先删** `boot.ts:1033-1034`:
     L1033: playerGx = pan.x;
     L1034: playerGy = pan.y;
   ⇒ 实测(逐行读):L1030-1032 是三条**无条件**语句(`uiFsm.tick` / 两条赋值前导注释),
     写作点在 L1035 `updateRoof(...)` 之前,L1039 的 `if (bossActive && boss)` 在**它之后**
     ⇒ 即:这两行在**帧循环里每帧无条件执行**(不在任何条件分支内)
   ⇒ 而 `playerGx/playerGy` 的写点**实测共 4 处**:L552/L553(初始化一次)、
     **L1033/L1034(唯一的每帧写点)**
   ⇒ 只要 L1033-1034 还在,后面接的任何权威值都会**在同一帧内被覆盖**
     ⇒ 表现为「接线了但没效果」——不报错,最难查的那一类
S2 **再**把 `playerGx/playerGy` 的来源改成 `state_store` 的权威位置
   ⇒ 顺序反了 = 新代码被静默覆盖
⇒ ★ 验收判据(必须含):`预警圈圆心 == 权威玩家位置`
   (实测该圆心来自 `boot.ts:821-822 cx: playerGx, cy: playerGy`,在 `buildTelegraph` 的
    `TelegraphSpec` 里;`radius: 3.5` / `innerRadius: 2` 是**客户端**玩法常数,不在协议里 —— 见 §7)
```

---

## 7. 我**不**能证明的(未实测,不当结论)

```
[ ] `@colyseus/ws-transport` 能否挂裸 ws 连接 —— 未测(但若走分支乙则不需要)
[ ] vite 能否把 `shared/**` + 内置 WebSocket 一起打包 —— 未测
[ ] 真机延迟/丢包下的手感 —— 未测(只有 LossyChannel 的模拟)
[ ] `registry.ts` 上移后是否拖入别的 server 依赖 —— 只测了 handshake 闭包,未测 registry 的**下游**
[ ] `boss_hud.ts` 的 `TelegraphSpec` 12 字段中有 5 个不在协议里
    (facing/spreadRad/innerRadius/length/width)⇒ **该由谁读**需玩法裁决
```

---

## 8. 请 Lead 裁的三项

1. **通道**:分支甲(colyseus)还是乙(裸 WebSocket)?
2. **`registry.ts` + `handshake.ts` 是否上移** `shared/content/`?(决定握手能否双向核对)
3. **写域 §5 是否批准**?(尤其 `boot.ts` 那处高危改动)

---

## 9. ✅ 裁决结果(Lead,2026-11-13)

| # | 裁决 |
| :--- | :--- |
| 1 | **分支乙(裸 WebSocket)**。且 Lead 补测:服务端**也能零依赖**(`node:http` upgrade + 手写帧,~90 行),与内置 WebSocket 客户端往返逐字节一致 + 大帧 125/126/127/1000/70000 全过 + 阴性对照。⇒ 两侧都不新增依赖 |
| 2 | **批准上移,但不排在阶段 3 之前**。理由:阶段 3 的验收判据**不需要**双向内容核对。⇒ 契约须**容纳**两侧(收的字段必做、发的留空) |
| 3 | **写域批准**,但三处改:① `boss_hud.ts` 的 `TelegraphShape` 本轮**不做**(那是玩法裁决)② `tests/WS-09` 追加 → 改为**新建 `tests/WS-12.test.ts`** ③ `boot.ts` 删 L1033-1034 批准 |

### 9.1 已按裁决策弱化的未测项(§7 的 5 项 → 2 项)

```
[×] ws-transport 挂裸 ws        ⇒ 不再是决策变量
[×] 内置 WebSocket 二进制往返   ⇒ Lead 已实测(含大帧 + 阴性对照)
[×] vite 能否打包 shared/**     ⇒ ★ 本次证实为**既成事实**(见 9.2)
[×] registry 上移下游           ⇒ Lead 已测(闭包 6 文件 0 不纯);真成本是**协调面 9 点 / 4 写域**
[ ] 真机延迟/丢包              ⇒ 仍未测
[ ] TelegraphSpec 12 vs 协议 10 ⇒ 玩法裁决
```

### 9.2 ★ `shared/**` 进客户端 bundle = **既成事实**,不是待验证项

实测客户端构建闭包(入口 `client/index.html` → `./src/main.ts`)**29 个文件**,
其中 **6 个 shared 文件已在里面**,由 **14 个 import 点**引入:

```
client/src/three/boot.ts:27,91 · ui/boss_hud.ts:16,17 · ui/recipe_tree.ts:39,40
ui/inventory.ts:35,36 · ui/blueprint.ts:19 · stage/{roof_transparency,demo_world,
dye_overlay,entity_sprites,particles,tile_mesh}.ts · three/ui_binding.ts:51
⇒ 涉及 shared/types/{tile,entities,physics,alchemy}.ts + shared/constants/{bosses,items}.ts
```
**⇒ 所以 `shared/net/delta.ts` 进 bundle 不需要任何新配置**(它同为纯 ESM、零 `node:`、零三方)。

**⚠️ 顺带修正一处我自己的混说**:草案 §7 曾把「**打包 shared/**」与「**用内置 WebSocket**」
并成一件事 —— 后者是**宿主全局**,不在 module graph 里,**不需要打包**。两者无关。

---

## 10. ✅ S1 已落地(实测)

```
动作:删 `boot.ts` 原 L1033-1034(`playerGx = pan.x; playerGy = pan.y;`),原处留 18 行说明
原因(实测):`playerGx/playerGy` 写点共 4 处 —— L552/L553(初始化)+ **此处(唯一每帧写点)**
            且该处**在帧循环内无任何条件包裹**(`if (bossActive && boss)` 在其后)
⇒ 不删则任何权威赋值都在同帧被覆盖 ⇒ 「接线了但没效果」,不抛错
⇒ S1→S2 顺序不可交换
门禁:改动前后逐项一致(exit 0 · 1382 条 / 21 套件 · 可达 78/93)
```
**★ 一处对 Lead 预测的实测反驳(如实记)**:
```
Lead 预测:「删后 `pan.x/pan.y` 没人读了 ⇒ 相机平移变死写」
实测:**不成立**。删后仍有 **6 个真读者**:
  L830/L831、L908/L909、L991/L992(后者在 syncCamera() 里)
⇒ pan 仍被相机消费,**不是死写** ⇒ 不需要报这个"既有缺口"
```
**⚠️ S1 的中间态(预期,非缺陷)**:`playerGx/playerGy` 现在**恒为 `WORLD_CELLS/2`**
(写点已断、读者还在:L568 屋顶连通域、L821/L822 预警圈圆心)
⇒ 必须由 S2 接上,否则这段窗口里两处都用出生点算 —— 静默画错位置。

---

## 11. ★★ 验收判据的可测性(已实测,可写成**真行为断言**)

**问题**:判据「预警圈圆心 == 权威玩家位置」若落在 `boot.ts` 上就**不可测** ——
`boot.ts` 闭包含三方 `three`,Node 里 import 不了。
实测:**全仓没有任何测试 import `three/` 下任何文件**(WS-09 的 17 个 client 模块里一个都没有)。

**解法(实测成立)**:判据改为**一次真实往返**,而所用模块**本来就纯、本就被测过**:
```
权威位置 → TelegraphSpec.cx/cy → boss_hud.buildTelegraph → 屏幕顶点
        → iso_camera.unprojectScreenToGrid 逆投影回网格 → 重算圆心 → 断言 == 权威位置

实测:权威 (12.5, 7.25) ⇒ 往返圆心 (12.500000000, 7.250000000)
      误差 x = 3.55e-15 · y = 1.78e-15 ⇒ 双精度下**精确往返**
```

**三条反例对照(证明判据不是恒真)**:
| 对照 | 结果 |
| :--- | :--- |
| A 把 `cx` 改 +2.0 | 圆心实测偏 **2.000** ⇒ 查得出 ✓ |
| B **相机移到 (9999, -4321)** | 圆心**不变**(误差 1e-13)⇒ 判的是**世界坐标**不是相机 ✓ |
| C 非整数边界 (0.5,0.5)/(0.001,0.001)/(12.3333,7.6667)/(0,0) | 误差 ≤ 5.5e-16 全过 ✓ |

**★ 边界(不得 over-claim)**:这条往返判据证明的是**几何命题**(圆心函数是恒等),
**不**证明**接线命题**(`boot.ts` 真把权威值传进去了)。
⇒ WS-12 需要**两条**判据:一条强(行为,往返)、一条弱(文本,接线点),
且弱判据要**显式标注**,不混进「全部通过」。

---

## 12. ★★★ 跨端线上契约(服务端这半**必须**先读这节,否则会独立实现出静默错误)

**背景**:阶段 3 的客户端侧已完成(commit `0c8b72b`),但服务端那半**尚未开工**。
一旦两端独立实现,下面三条各自都会产生**不报错**的失败 ⇒ 所以本节的每一条
都附**实测证据**,不是设计约定。

### 12.1 ★★ 上行/下行**帧头不对称** —— 服务端必须剥第 1 字节

```
下行(服务端 → 客户端)= **裸协议字节,无 tag**
  实测 room.ts 三处出口全部直接返回 .bytes:
    L642   const snapshot = encodeFull(this.state, this.state.meta.tick).bytes;
    L1154  return prevSnapshot ? encodeDelta(prevSnapshot, this.state).bytes : new Uint8Array(0);
    L1349  return encodeFull(this.state, this.state.meta.tick).bytes;
  ⇒ 客户端**已兼容**(首字节不是 0x02 就按裸包处理)✓

上行(客户端 → 服务端)= **[1 字节 tag][payload]**
  实测 client/src/net/session.ts:
    L127  const FRAME_TEXT   = 0x01;   ← 握手 JSON(welcome/hello)
    L128  const FRAME_BINARY = 0x02;   ← 二进制协议包
    L133  out[0] = isText ? FRAME_TEXT : FRAME_BINARY;
  ⇒ ★ **服务端必须剥掉首字节**再交给 `decodePacket`
```

**★ 不剥会怎样?我穷举了全部 256 个 tag 值(实测,不是推断)**:
```
实测:0 / 256 个 tag 值会**静默**通过 —— **全部抛出**。
  · tag = 0x02(真实现)⇒ `协议版本不匹配:2`
  · tag = 0x01(= PROTOCOL_VERSION 的值)⇒ `未知实体种类:0`
⇒ 所以这条**不会静默**,是一条清晰错误 ✓
⇒ ⚠️ 但**仍然是契约的一部分**,理由有两条:
  1 若 `PROTOCOL_VERSION` 将来改成 2,而 tag 恰好也是 2,
    那时的行为**未被验证**(我测的是 PROTOCOL_VERSION=1 的现状)
  2 一条错误的**可读性**不是"可以不写"的理由 —— 对接方会先花时间猜
⇒ 结论:写进契约,并**两侧各留一条断言**(上行带 tag / 下行无 tag)。
```

### 12.2 ★★★ 重连的真相:**靠 `userId`,不靠 token**(注释与实现不符)

```
实测 server/src/net/room.ts:
  L15   注释:「`RECONNECT_GRACE_MS`(30 秒)内用**同一 token** 回来 → 直接恢复快照」
  L574  const existing = this.members.get(input.userId);   ← ★ 真实判据是 **userId**
  L578  const token = this.mintToken();                    ← token 是**造出来返回给客户端**的
  L589  return { ok: true, ..., token, snapshot, resumed: true };
  L1367 private mintToken(): string                        ← 只被调用,从不被读入

  实证:输入里读 token 的次数 = **0**
        `input.token` 0 次 / `input?.token` 0 次 / `.token` 作为读 0 次
        客户端侧:`session.ts` / `main.ts` 里 token 出现 **0 次**
  ⇒ 而 `JoinResult.token?: string`(L251)是**返回类型**里的字段 ⇒ **只写不读**
```

**⇒ 两条不一致(都在服务端写域)**:
```
1 **注释与实现不符** —— 注释说 token,实现用 userId
  ⇒ 危害:对接方读注释 ⇒ 会去实现 token 校验 ⇒ 而它**永远不会被触发**
    ⇒ 「我实现了重连」+「重连从未生效」同时为真
2 ★ 裸 WS 服务端若**每连接随机生成 id** ⇒ 重连走**全新加入**,
  旧席位留在 30 秒宽限期内 ⇒ **同一玩家出现两个**
  ⇒ **不报错、不抛、日志正常** —— 只有玩家自己看到"我重连后变成两个人"
```

**⇒ 硬要求(裸 WS 服务端)**:`userId` 必须**跨连接稳定**,
不能每连接随机生成。若无法稳定 ⇒ 必须在协议里引入客户端侧持有的 id
(但那是**改契约**,会波及黄金形状 ⇒ 需先裁)。

**⚠️ 本轮不动它的理由**:重连**不在**阶段 3 的验收判据内
(判据只有「圆心 == 权威玩家位置」)⇒ 按本仓既有规则
「**一个改动如果服务的功能不在当前验收判据里,就不该挡在关键路径上**」,
记为待办(见 §13),不夹进本轮。

### 12.3 ★★ 0 字节帧是**正常**的,不是坏包

```
实测 room.ts:1154 —— `prevSnapshot` 为 null 时 `step()` 返回 **空 Uint8Array**
而空数组交给 decodePacket 会**抛异常**(`报文截断:需要 1 字节,剩余 0`)
⇒ 服务端侧:0 字节表示「本 tick 无差量」,**不是**错误
⇒ 客户端侧:`session` 必须**跳过** 0 字节帧(已实现,WS-12 有断言)
⇒ ★ 服务端不要把 0 字节当成"编码失败"去重试或补发 —— 那会改变协议语义
```

### 12.4 握手字段的**两侧来源**(已核对,4 个字段无缺)

| 字段 | 服务端从哪来 | 实测 |
| :--- | :--- | :--- |
| `playerId` | `userId`(服务端**自己**产生) | `room.colyseus.ts:136 userId: client.sessionId` |
| `roomId` | `RoomRuntimeOptions.roomId` | `room.ts:259` |
| `protocolVersion` | `PROTOCOL_VERSION` 常量 | `shared/net/delta.ts` |
| `contentClaim` | `encodeContentClaim`(在 `server/content/`) | `handshake.ts` |

**★ 客户端侧 `hello.contentClaim` 阶段 3 恒为 `null`**(实测 `session.ts:210`),
因为指纹算法仍在 `server/`(CR-26 已裁:上移但排后)⇒ 见 §12.5。

### 12.5 ★★★ 「静默丢弃」方向:**服务端当前不读 `contentClaim`**

```
实测:
  client/src/net/session.ts:169  open 里发 hello,**含** contentClaim 字段 ✓
  server/src/net/room.colyseus.ts:134
    override onJoin(client, options: { passwordHash?: string; asGuest?: boolean })
    ⇒ **类型里没有 contentClaim** ⇒ 服务端**根本没读它**
  colyseus.ts 全文 `contentClaim` 出现 **0 次**
```

**⇒ 危害形态与"挡在门外"根本不同**:
```
挡在门外(客户端没发、服务端要校验)⇒ **可见**(没人能进来)⇒ 会有人报
静默丢弃(客户端发了、服务端不读)⇒ 外部**一切正常**,
  而内容指纹**从来没被比对过** ⇒ **没人会来报**
```
⇒ ★ 所以这是**两个方向、两种危害**,判据必须**分别**钉
(WS-FND-03 已补方向 2,见该套件的丙类)。
⇒ ⚠️ 且它**此刻无危害**:客户端发的是**字面 `null`**(丢一个 null 不损失信息)
⇒ 判据钉的是「**线上发的是不是真指纹**」,在**危险那一刻**红,
而不是在"接线中途"红(否则就是陷阱 71:把缺陷编码成期望值)。

---

## 13. ★ 本契约**未**覆盖的(如实,不当已解决)

```
[ ] **重连语义的一致性**(§12.2)—— 注释改对 / userId 跨连接稳定,二者至少要做一个
    ⇒ 不在阶段 3 判据内 ⇒ 记为待办,不挡关键路径
[ ] **WS 分片帧** —— 未测。内置客户端在 70000 B 时未分片,但不保证所有实现都不分片
[ ] **ping/pong** —— 客户端只处理 close(0x8),**未回 pong**
    ⇒ 长连接可能被对端判死;接生产前必须处理
[ ] **真机延迟/丢包手感** —— 未测(只有 prediction.ts 的 LossyChannel 模拟)
[ ] `createdAt` 等 room.ts:259 `RoomRuntimeOptions` 的**其余字段**未逐个核对
[ ] 本节所有实测均在 **PROTOCOL_VERSION = 1** 下取得;
    版本号变更后 §12.1 的"全部 256 个 tag 都抛"**需重测**
```


