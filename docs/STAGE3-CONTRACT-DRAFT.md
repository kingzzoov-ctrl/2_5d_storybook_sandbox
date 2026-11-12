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
