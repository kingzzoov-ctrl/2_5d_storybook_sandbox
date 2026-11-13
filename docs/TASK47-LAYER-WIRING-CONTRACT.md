# task-47:US2 之后的分层接线契约

> **状态**:契约冻结(2026-11-13)· Lead 撰写
> **上位文档**:`docs/US2-GATEWAY-CONTRACT.md`(US2 网关契约,已落地)
> **上游缺口**:`docs/ARCH-GAPS.md` 第五层 W1–W7
> **本契约的边界**:只定义「谁接谁、按什么顺序、拿什么验收」——
> 不重述 US2 已冻结的 8 字段投影与 `syncMaxHp` 语义。

---

## §1 职责边界

### 1.1 三层的名字与归属

```
┌─ 编排层(room.ts · RoomRuntime)          ── 只认结构化类型,不 import 模拟层
│    · 会话/成员/断线宽限/角色
│    · 每帧:调 host.advance? → projectPlayer → 编码上报
│    · **不持有** progresses / vitals / physics(possession 在模拟层)
│
├─ 结构契约(WorldSaveHost / SimReadView)   ── 唯一的跨层接触面
│    · 由 `server/src/index.ts` 的 `createHost()` **实现**(不是 room!)
│    · 全部读口 `?` 可选 ⇒ 「接上了」只能靠**运行时断言**钉住(陷阱 89)
│
└─ 权威层(WorldSim · progresses / vitals / physics / profiles)
     · 所有持久化值的**唯一真源**
     · 只经 `WorldSaveHost` 暴露的窄口进出
```

### 1.2 本任务**不做**的事(边界外)

```
[×] 不把 WorldSim 类型 import 进 room.ts(那会让 US2 变过时条目,见 room.ts:326 的既有纪律)
[×] 不为「客户端网络层」相关欠账写服务端替代品 —— 那是**上游不存在**,不是"少接一行"
    (`content/handshake.ts` / `client/src/net/prediction.ts` 属此类)
[×] 不改冻结层 `shared/**`(本仓铁律)
[×] 不为凑数把不可达项从白名单删掉 —— 那只是**掩盖**,可复现性会归零(陷阱 71)
```

### 1.3 什么算「消掉一条欠账」

```
判据(三条**同时**成立才算消,缺一条都只是"看起来消了"):
  1 该文件进入 `PROD_ENTRIES` 的 import 闭包(verify 的可达性判据自己会算)
  2 它的**逻辑**被真执行(不是只被 import 常量:引用 ≠ 执行,见白名单里 modes.ts 的注记)
  3 有一条**穿过 RoomRuntime 与 WorldSaveHost** 的跨层集成测试钉住
    ⇒ 即:测试必须从 `assemble()` 起、走 `rt.step()`,而不是单独 new 一个模块单测
★ 反面:只做 1(import 进去)会把欠账换成**假可达** —— 比欠账更糟。
```

---

## §2 接口

### 2.1 读档恢复口 —— **本任务的第一个实质缺口**

```
现状(实测):
  `loadReconnectSnapshot` 在 room.ts **被 import 但零调用**
    出现处 = L43(import) + L1830(re-export),**再无第三处**
  ⇒ 存档**写了**(disconnect 时 `saveReconnectSnapshot`),
    但**从没读回** —— 这正是陷阱 89 的形态:
    「写侧在位、读侧缺席」,而外部表现与「尚未实现存档」**完全一样**。
```

**新增契约(编排层 → 权威层)**:

```ts
/** 编排层 → 结构契约:把一份存档交回给权威层。**这是恢复的唯一入口**。 */
interface WorldSaveHost {
  /**
   * 用存档**重建权威状态**。返回实际生效的玩家数。
   *
   * ⚠️ 本方法是**唯一**允许写 `progresses` / `vitals` 的恢复口;
   *    编排层**不得**解析存档后直写 `room.state.players[]`(违反 §4.3)。
   */
  restoreFromProfile?(playerId: string, profile: {
    level: number;
    hp: number;
    x: number; y: number; z: number;
    weaponId?: number;
  }): boolean;
}
```

### 2.2 复用而非新增的部分

```
已存在、**不需新增**的权威写口(实测):
  WorldSim.importVitals(data)      —— 走 vitals.revive ⇒ 顺带清 downed/iframe ✓
  WorldSim.setProfile(id, patch)   —— 装备等档案字段
  WorldSim.applyPlayerMove(id,x,y) —— 位置
  WorldSim.syncMaxHp(id, maxHp)    —— US2 已落地的派生上限
  WorldSim.addPlayer(id,x,y)       —— 登记刚体
  progression.setLevel(progress,L) —— 等级(纯函数,返回新对象,需回写 Map)
★ 结论:**恢复不需要新的权威写口,只需要一个"把它们按对顺序串起来"的口**
  ⇒ 故 §2.1 的新增口是**编排意图**的表达,内部转发到上述既有方法。
```

### 2.3 装配口(第 2、3 项欠账的落点)

```ts
/* index.ts 已有、但**生产入口从未传值**的参数(实测 confirms): */
export interface AssembleDeps {
  db?: DbLike | null;      /* ← assemble() 里是 `deps.db ?? null` */
  /* …其余 8 个键 */
}
export function assemble(deps: AssembleDeps = {}): Assembled;
```

```
⇒ `db/driver.sqlite.ts` 与 `db/memory_db.ts` 的欠账理由字面写着
   「生产入口尚未注入」,而**seam 已存在**:`assemble(deps.db)` → `new RoomRuntime(rtOpts, db)`
   两个驱动**都 `implements DbLike` 且 7/7 方法齐全**(实测)
⇒ 所以这不是"缺结构",是**缺一次注入** —— 属本契约范围。
```

---

## §3 数据结构

### 3.1 存档形态(已存在,不改)

```
`room_players.snapshot_blob` : Uint8Array
  产出 = `RoomRuntime.snapshotFor(userId)` → `encodeFull(state, tick).bytes`
  读取 = `loadReconnectSnapshot(db, roomId, userId) → Uint8Array | undefined`
⚠️ 它是**整房间状态**的全量编码(encodeFull),不是"单玩家档案" ⇒
   恢复时必须**只取该玩家那一行**,不能把别人的位置也盖回来。
```

### 3.2 恢复用的最小档案(§2.1 形参)

| 字段 | 权威归宿 | 缺失时 |
| :--- | :--- | :--- |
| `level` | `progresses[id].level` | 取 1,并由调用方 `syncMaxHp` 重算上限 |
| `hp` | `vitals[id].hp` | `statsAtLevel(level).maxHp`(满血) |
| `x,y,z` | `physics.bodies[id]` | 出生点(不猜存档里的值) |
| `weaponId` | `profiles[id].wearing` | 保持现状(空手 ≠ 采不到) |

★ **`maxHp` 不进档案**:它是 `level` 的**派生值**(US2 裁决 1),
  `importVitals` 也明写「不信任存档里的 maxHp」⇒ 由 `syncMaxHp` 算,不由存档带。

---

## §4 算法

### 4.1 恢复顺序(不可换)

```
1 校验:该 userId 在本房间**已登记**(members 里有)
    ⇒ 未登记 ⇒ 走正常 join,不恢复(防"凭空造玩家")
2 读档:`loadReconnectSnapshot(db, roomId, userId)` ⇒ blob | undefined
    ⇒ undefined ⇒ 走正常 join(首次进入)
3 解码 blob → 该玩家的 state 行(**只取自己**) 
4 ★ **先写权威**:`host.restoreFromProfile(id, profile)`
    内部顺序:addPlayer → applyPlayerMove → syncMaxHp → importVitals → setProfile
    ⚠️ syncMaxHp 必须在 importVitals **之前**:
       否则 hp 先按旧上限(可能 100)钳住,升级玩家的血会被截回。
5 ★ **再投影**:`projectPlayer(view, id, state.players[i])`(US2 唯一写者)
6 播种反作弊:`ac.join(id, tick, x, y, z)` 用**恢复后**的实际坐标
    ⇒ 不用存档里的坐标:刚体可能因碰撞被推开,两者不同会被判瞬移(实测差 13.649 格)
```

### 4.2 为什么第 4 步必须在第 5 步之前

```
若先投影再写权威 ⇒ 下一帧 `projectPlayer` 会把权威的**旧值**覆盖回 state
  ⇒ 玩家看到自己"恢复了又弹回去"(一帧的错,但可观测)
⇒ 与 US2 §4 同一条纪律:`先 syncMaxHp 再 projectPlayer`。
```

### 4.3 禁止的形态(本任务的核心约束)

```
✗ 从存档解析出 hp/level,直接 `state.players[i].hp = ...`
  ⇒ 那会让 state 变成**第二个权威**;
    而 US2 验收 6 已用**反向注入**证明单向性 —— 直写会被下一帧覆盖,
    更糟的是**读档那一帧会短暂是真值**,使"单向"这条断言变成偶发红。
✗ 在 `join()` 里同时"恢复"和"新建"两套逻辑
  ⇒ 会分叉成两份实现(陷阱 80 的形态)
```

---

## §5 参数

| 参数 | 值 | 来源 |
| :--- | :--- | :--- |
| 断线宽限期 | 既有 `opponent` 宽限逻辑,不改 | room.ts |
| 恢复时的 hp 缺省 | `statsAtLevel(level).maxHp` | §3.2 |
| `PROTOCOL_VERSION` | 不改 | `shared/net/delta.ts` |
| 驱动注入形态 | `assemble({ db: new MemoryDb() })` / `SqliteDb` | §2.3 |

---

## §6 性能

```
恢复是**每次 join/disconnect 一次**的操作,不在每帧路径上
  ⇒ 不设硬预算;但**解码全量 blob 只为取一行**是 O(房间状态)
  ⇒ 若将来房间很大,应改为按行存(记入 §10 未决,本轮不做)
★ 每帧路径**不受本任务影响**:投影仍是 O(玩家数 × 8 字段)(US2 已测)。
```

---

## §7 边界

```
[ ] 快照是 `encodeFull`(**全量**,非增量)⇒ 不是"单玩家档案";
    本契约只取自己那一行,但 blob 里含他人坐标 ⇒ 恢复时**不得**整表回写
[ ] 客户端网络层不存在(`client/src/**` 24 个 .ts 里 0 个有 WebSocket/fetch)
    ⇒ `handshake.ts` / `prediction.ts` 两条欠账**不在本契约范围**
[ ] 真机 FPS/latency 从未实测
[ ] 服务端侧不改 `Tests` 之外的既有断言语义(只增不改)
```

---

## §8 耦合

### 8.1 单向依赖(不可逆)

```
index.ts  →  room.ts  →  WorldSaveHost(结构)  →  WorldSim
   ↑ 反向**禁止**:room.ts 不得 import WorldSim(room.ts:326 既有纪律)
★ 依据:US2 已用「假 `SimReadView` 实现」证明投影可被结构挡掉回抄。
```

### 8.2 两处装配并存的既有风险

```
`index.ts assemble()` 与 `net/room.colyseus.ts` 各有一份 `rtOpts` 字面量
⇒ WS-FND-09 的 FND9-9 用「**键集逐字相等**」防分叉(index.ts:127-133 有注记)
★ 本任务新增 `db` 注入时**必须同时改两处**,否则又分叉。
```

---

## §9 验收

```
1  `loadReconnectSnapshot` 有**真调用点**(不是 import 而已)
   ⇒ 断链判据:`grep` 出现处 ≥ 3 且含一次真调用
2  恢复路径**先写权威再投影**:注入「存档 level=30 / hp=535」⇒
   恢复后 `vitals.maxHp === 535` 且 `state.players[i].maxHp === 535`
   ⇒ 两侧一致才证明投影生效;只断言一侧会被"直写 state"骗过
3  ★ **反向注入**(US2 验收 6 的延续):恢复后手工把 `state.players[i].hp` 改成脏值
   ⇒ 下一帧必须被**权威值**覆盖 ⇒ 证明恢复也是单向的
4  `db/driver.sqlite.ts` + `db/memory_db.ts` 进入可达闭包:
   `assemble({ db: ... })` 后 `runtime` 的 db 非 null,且
   **真跑一次 join → disconnect → join** 走通落盘+读回
5  每消一条欠账,**配套一条跨层集成测试**(≥1 条/欠账,且走 `assemble()`)
6  三条严格旗标零告警:
   `node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert`
7  ★ **计数算术反推**(陷阱 93):
   欠账数变化必须与「消掉的文件数」**算术相等** ——
   `旧欠账 − 消掉数 = 新欠账`,且 README 的构成行同步
   ⇒ 不做这步就不算收尾(本会话已因此漏过两次)
```

---

## §10 未决

| # | 问题 | 现状 | 需谁裁 |
| :--- | :--- | :--- | :--- |
| U1 | 快照为 `encodeFull` 全量 ⇒ 大房间下恢复成本 O(整房) | 未测 | 遇瓶颈再说 |
| U2 | `ws-11` 族(afk/scoring/modes/toys/immunity/rush_order)**是否**该由 room 轴驱动,还是等"对局层" | 白名单理由多写「深于 US2」 | ★ **需用户裁** |
| U3 | `content/handshake.ts` 等客户端网络层 ⇒ 是否本轮就做客户端网络层 | 客户端 0 个网络文件 | 遇 plan 再定 |
| U4 | 两处 `rtOpts` 的键集相等靠断言维持 ⇒ 是否该抽成单一工厂 | 现状可靠但重复 | 低优先 |
| U5 | `maxHp` 是否也该进档案(便于跨版本迁移) | 现在由 level 派生 | 暂不做,记此 |
```
