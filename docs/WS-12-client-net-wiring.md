# WS-12 客户端联机层接线(最小可行)

> task-67 阶段 3。目标:**让预警圈圆心 == 权威玩家位置**。
> 交付物:`client/src/net/{telegraph_center,state_store,session}.ts` + 本套件。

## 1. 职责边界

| 模块 | 职责 | **不做** |
| :--- | :--- | :--- |
| `session.ts` | **唯一**碰 `WebSocket` 的地方:连接、握手、帧分派 | 不解释协议字节、不持有状态语义 |
| `state_store.ts` | 持有 `RoomState`;解包 → 合入 → 换掉 | 不碰网络、不碰 three |
| `telegraph_center.ts` | 从权威状态取**本地玩家**位置 | 不碰相机、不碰 `pan` |
| `three/boot.ts` | 渲染循环:每帧读 store 取圆心画预警圈 | 不自己推测玩家位置 |

**分界线**:通道 / 状态 / 几何三层,任一层都不许把另两层的东西抄进来。
判据:`telegraph_center.ts` 与 `state_store.ts` 的**代码**里不出现 `WebSocket`
(由 WS-12 断言)—— 这保证它们在 Node 里可直接 import,从而**可测**。

## 2. 接口

```ts
/* 几何:权威状态 → 圆心(null = 权威未知,不是 {0,0}) */
telegraphCenterOf(state: RoomState, localPlayerId: string): {cx, cy} | null

/* 状态 */
class ClientStateStore {
  get state(): RoomState            // 只读;每帧是新对象
  get localPlayerId(): string
  get decodeErrors(): number        // 坏包
  get emptyFrames(): number         // 空帧(≠ 坏包)
  apply(bytes: Uint8Array | null): ApplyResult   // 不抛
}

/* 会话 */
createSession(opts: { url, store?, makeSocket?, events }): SessionHandle
```

`ApplyResult.skipped` 的取值域:`'empty-frame' | 'decode-failed' | null`。
★ 这两个值**必须区分**:前者是协议的正常部分,后者是数据损坏。

## 3. 数据结构

```
上行帧 = [u8 tag][payload]        tag: 0x01 文本(握手 JSON) / 0x02 二进制(协议包)
下行帧 = **服务端发裸协议字节(无 tag)**;客户端四种形态都认(见下方分派)
HelloFrame   = { t:'hello', protocolVersion, contentClaim: null }
WelcomeFrame = { t:'welcome', playerId, roomId, protocolVersion, contentClaim: string }
```

**★ 下行分派不能用 tag 判 —— 这里有一个**值碰撞**(实测抓到过的真缺陷):**
```
FRAME_TEXT(0x01) == PROTOCOL_VERSION(1)
而服务端下行是**裸包** ⇒ 首字节就是 1 = 0x01
⇒ 初版写 `if (bytes[0] === FRAME_TEXT) 当 JSON 解析`
  ⇒ 裸包首字节恰好命中 ⇒ 被当 JSON ⇒ JSON.parse 抛 ⇒ 端到端**全线失败**
⇒ 而初版 WS-12 **没测到** —— 夹具 `binaryFrame()` **人为加了 0x02 tag**,
  而真服务端不加 ⇒ **声明的形态与夹具的形态不一致**。
⇒ 现改为按**内容特征**判(`classifyDownlink`,纯函数、已导出、可测):
    · 首字节 `{`(0x7B)             ⇒ 文本(裸 JSON)
    · 首字节 0x01 **且次字节 `{`**   ⇒ 文本(带 tag 的 JSON)
      ★ 看第 2 字节才能与裸包区分:裸包第 2 字节是 op(0/1),不是 `{`
    · 其余 ⇒ 二进制(**原样**,即服务端真实行为)
⇒ ⚠️ 残留歧义(如实):若 `PROTOCOL_VERSION` 将来等于 **2**(== FRAME_BINARY),
  则"裸包首字节"与"tag"**无法区分** ⇒ 规则③**主动不猜**,那时需重测。
```

`RoomState` 的**空 base** 由 `emptyRoomState()` 给(客户端造不出 `createRoomState` ——
它属于「留在 server 的 16 个」)。⚠️ 该字面量是**手写复本**,故有一条判据钉住
「空 base 的键集 == 真实 `RoomState` 的键集」,防协议加字段时静默缺字段。

## 4. 算法

**合入一帧**(`ClientStateStore.apply`):
```
① 0 字节 / null  ⇒ 记 emptyFrames,返回(★ **不进解码器** —— 它必抛)
② decodePacket   ⇒ 抛则记 decodeErrors + lastError,返回(不抛给调用方)
③ applyPacket    ⇒ **必须接返回值**(它返回新对象,不改入参)
④ 换掉 this.state_
```

**取圆心**(`boot.ts` 帧循环,每帧):
```
center = telegraphCenterOf(store.state, store.localPlayerId)
if (center !== null) { playerGx = center.cx; playerGy = center.cy }
/* null ⇒ **保持上一帧**,不清零 —— 否则预警圈会跳到世界原点 */
```

## 5. 参数

| 参数 | 值 | 说明 |
| :--- | :--- | :--- |
| `PROTOCOL_VERSION` | 1 | 取自 `shared/net/delta.ts`,**不写第二份** |
| 预警圈 `radius` / `innerRadius` | 3.5 / 2 | 客户端玩法常数,**不在协议里**(见 §9 未决) |
| `chargeSec` / `danger` | 0.8 / 0.8 | 同上 |
| `binaryType` | `'arraybuffer'` | ★ 真 WebSocket 默认 `'blob'`,不设则**静默丢全部帧** |
| 上行 tag | 0x01 文本 / 0x02 二进制 | 服务端据此分流 |
| 联机开关 | `?server=ws://…` | 不传 = 单机模式(与接线前行为一致) |

## 6. 性能

- store 每帧一次 `cloneRoomState` + 一次 upsert 应用 ⇒ O(玩家数 + 实体数)。
- 帧循环里**不分配**除 `applyPacket` 结果外的东西;`telegraphCenterOf` 是 O(玩家数)
  的线性查找 —— 玩家数在量级上很小(≤ 十),不值得建索引。
- 实测:`encodeFull`(1 玩家)73 B;同态 `encodeDelta` 10 B。
- **未测**:真机延迟 / 丢包。只有 `prediction.ts` 的 `LossyChannel` 模拟。

## 7. 边界

| 输入 | 行为 |
| :--- | :--- |
| `players` 为空(第一帧未到) | `null` ⇒ 保持出生点 |
| `localPlayerId` 为空串 | `null`(★ 即使存在 id 为空的畸形玩家,也不误认) |
| id 不匹配(自己不在场) | `null` —— **不 fallback 到 `players[0]`** |
| 0 字节帧 | `empty-frame`,**不计入** `decodeErrors` |
| 版本不符 | 置 `failed` 并写明原因,**不静默降级** |
| 坏包(截断/未知 op) | 计数 + 记原因,**不抛**;之后仍能合入好包 |
| 载荷是 Blob/字符串/对象 | 丢弃但**计数**(`droppedFrames`)+ 记原因,不崩 |

★ `players.length === 0` 那一行**故意不存在**:它是死代码
(`[].find(pred)` 恒 `undefined`,与 `p === undefined` 分支同结果)。
穷举 12 组输入验证「有无该行输出完全相同」⇒ 留着只会造成"它守住了空态"的错觉。

## 8. 耦合

- 依赖 `shared/net/delta.ts`(协议**唯一**实现)与 `shared/types/wire.ts`(类型)。
- **不**依赖 `three`:几何那半落在 `ui/boss_hud.ts` + `stage/iso_camera.ts`(两者都纯)。
- `boot.ts` 依赖 `session`/`state_store` 的**类型与纯函数**,但不自己建会话。
- 被依赖方(服务端 `RoomRuntime.step`)已返回**编码后字节** ⇒ 客户端无需自己编码。

## 9. 验收

**判据一:预警圈圆心 == 权威玩家位置**
- **强(行为)**:权威位置 → `TelegraphSpec.cx/cy` → `buildTelegraph` → 屏幕顶点
  → `unprojectScreenToGrid` 逆投影 → 重算圆心 → 恒等。
  实测误差 ≤ 3.6e-15(双精度往返)。
  三条对照:**改圆心 ⇒ 查得出**;**相机移到 (9999,−4321) ⇒ 圆心不变**(证明判的是世界坐标);
  非整数/零坐标边界全过。
- **弱(文本)**:`boot.ts` 帧循环里 `center` **直接**绑定 `telegraphCenterOf`,
  且 `playerGx` 的赋值写点恰好 1 处。⚠️ **只证明调用点存在,不证明调用正确**。
- **兜底**:vite 构建门禁(至少保证 `boot.ts` 可被打包)。

**判据二:`applyPacket` 返回值被接住** —— 断言新旧对象不同、旧对象未被就地改。

**判据三:坏包不崩,且 0 字节帧 ≠ 坏包** —— 4 类坏包各自计数;空帧走独立分支。

**故障注入**(11 处,含 3 处曾漏网):全部被抓住,恢复后字节一致。
漏网过并已修的三处:
```
① main.ts 的 store 接线    —— 原断言匹配到了**注释**里的同名字符串(注释污染)
② binaryType 未设          —— 原假 socket 忽略 binaryType,丢帧路径无痕迹 ⇒ 已改为如实建模 + 计数
③ 版本不符静默继续          —— 原只有文本断言,守不住行为 ⇒ 已补真事件流用例
```

**一个"判据有洞"被外部门禁发现的实例(值得记下)**:
```
`judgement_audit` 的 C 检测器报:「import 探测只认 from,未覆盖裸副作用与动态 import()」
命中本文件 §8 的纯净判据(第一版只写了 /from\s*['"].../)。
★ 它是对的 —— 那条判据在它声称的本体上真的有洞:
    import 'three';          (裸副作用导入)  ← 查不到
    await import('three');   (动态导入)      ← 查不到
  ⇒ 两种都能绕过「三个模块零外部依赖」这条判据。
⇒ 修法:正则合并三种形态,并补**三组阴性对照**证明它真能抓
  (把三种形态各喂一条,必须各抓到 1 条且模块名是 three;相对导入 0 命中)。
⇒ 教训:判据的覆盖面必须**对它声称的本体**完整,不是"能抓到最常见那种就行"。
```

**本文档对应套件:`tests/WS-12.test.ts` —— 43 条断言。**

## 10. 未决

1. **`createRoomState` 是否该上移**:客户端需要 `applyPacket`,却造不出 `RoomState`,
   只能用**手写字面量**当第一个 base。短期正确,长期是同一物两名(CR-20 家族)。
2. **`registry.ts` / `handshake.ts` 上移**:已批准但**排在阶段 3 之后**。
   契约已容纳两侧(收必做、发留空)⇒ 上移后只需填 `hello.contentClaim`。
3. **分帧与 pong**:只处理整帧、只处理 close(**未**回 pong)
   ⇒ 长连接可能被对端判死。接生产前必须处理。
4. **真机延迟/丢包**未测。
5. **协议里没有预警圈几何**:`radius`/`innerRadius`/`chargeSec` 是客户端玩法常数,
   而服务端有 `TelegraphShape`(5 个下标与 `wire.ts` **全部不同**)⇒ 玩法归属待裁。
