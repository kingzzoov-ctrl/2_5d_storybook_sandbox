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

### ★★★ 2.1.1 契约订正(2026-11-13,Lead 自查发现)**——这一节推翻了 §2.1 的措辞**

```
★ Lead 后来实测发现:**「重建权威」这件事 WorldSim 里**早就有了**,
  而我在 §2.1 让它去"新增一个口然后转发到既有方法" —— 方向多余。

实测(两个方向都查了):
  写侧:`WorldSaveHost.saveToDb(db, roomId, nowMs)`        ← 早有
  读侧:`WorldSim.loadFromDb(db, roomId)`                   ← **也早有**,但**没人调**
        server/src/sim/world_sim.ts:2673
        body: importVitals(loadVitalsFromUsers(db, this.vitals.ids()))
              + importMobMem(loadRoomMobMem(db, roomId))
  ⇒ 与之对偶的 repo 侧 `loadVitalsFromUsers`(repo.ts:786)/ `loadRoomMobMem`(repo.ts:833) 也早有。

⇒ ★★ 所以真正的缺口**比我原来写的更窄**:
     `WorldSaveHost` **没有把 loadFromDb 暴露出去**(11 个成员里 load 侧 **0 个**)
     ⇒ 房间拿不到读口 ⇒ 它只能自己解析 room 快照 ⇒ 而那是**投影值**,不是权威。
```

**订正后的 §2.1 契约(取代上面的 `restoreFromProfile`)**:

```ts
interface WorldSaveHost {
  /**
   * **读档**:从 DB 把权威状态读回世界。与 `saveToDb` 对偶。
   *
   * ⚠️ 这是**结构契约对既有能力的暴露**,不是新机制 ——
   *    内部就是 `WorldSim.loadFromDb`(已存在、已被 WS-FND-02 测试覆盖)。
   * 返回各段落生效计数,供调用方断言(hpApplied / memApplied / memSkipped)。
   */
  loadFromDb?(db: DbLike, roomId: string): {
    hpApplied: number; memApplied: number; memSkipped: number;
  };
}
```

### ★★★ 2.1.2 **再次订正(2026-11-13,`net-persist` 实测反驳,Lead 复算后采纳)**——本节推翻 2.1.1 的结论

```
★★ 我在 2.1.1 把缺口判成「只需暴露 loadFromDb」⇒ **错了。**
   `net-persist` 停手没写一行,先跑了四条实测反驳我。**它是对的**,我逐条复算:

  ── 证据 A(源码,我复核 ✓)──
  `saveVitalsToUsers` 只写 hp:repo.ts:773
      savePlayerState(db, id, { hp: row.hp }, nowMs)
  ⇒ `exportVitals()` 返回的 {hp,maxHp,downed} 里 **maxHp 一读出即丢弃**;
     `progresses`(level/exp)在 `saveToDb` **完全不出场**。
  ⇒ ★ Lead 全仓实测:把 level 写进 DB 的调用点 = **0**(唯一 `update('users')` 在 repo.ts:261,
     而它的 `next` 来自 `savePlayerState` 的 patch ⇒ 没人传过 level)。

  ── 证据 B(源码,我复核 ✓)──
  repo.ts:255-259:`const maxHp = (next.max_hp) ?? cur.max_hp; next.hp = clampIntQuiet(hp,0,maxHp)`
  ⇒ 建号 max_hp=100 ⇒ `savePlayerState({hp:535})` 被钳成 **100**。
     `saveVitalsToUsers` 又**从不传** max_hp ⇒ 连抬上限的机会都没有。
  ⇒ ⇒ **存档层自己就把 hp 封在 100。**

  ── 证据 C(推论,我认可)──
  冷启动走 loadFromDb ⇒ 顶多得到 100/100 ⇒ **验收 2 的 535 达不到**。

  ── 证据 D(源码,我复核 ✓)──
  room.ts `snapshotFor()` = `encodeFull(this.state, tick).bytes`
  ⇒ 它 encode 的是 **`this.state.players[]`(= 投影值)⇒ 含 level**。
  ⇒ ★ 而 `level` 的**唯一**持久化处**就是** `room_players.snapshot_blob`(repo.ts:429)。

  ── 全仓调用点(我实测)──
  `loadReconnectSnapshot` 在 `server/src` 里:**定义在 repo.ts:434,room.ts:1830 仅 re-export,
     真调用点 = 0**(其余 2 处在 tests/WS-07.test.ts:2683/2693)。
  ⇒ ★ 而 `WorldSim.loadFromDb` 走的是 `loadVitalsFromUsers` + `loadRoomMobMem`,
     **完全不经过 room.ts** ⇒ 它**不可能**让验收 1 变绿。
```

**⇒ 三条结论(采纳 `net-persist` 的判断)**

```
1 验收 2(注入 level=30/hp=535 ⇒ 两侧 535)**只能走 blob** ——
  因为 level 的唯一持久化处就是 snapshot_blob。
2 验收 1(`loadReconnectSnapshot` 有真调用)⇒ **`loadFromDb` 根本不碰它** ⇒ 照样红。
3 ⇒ `loadFromDb` 消的是**另一条欠账**(HP + 生物 mem 回世界),**不能替代**读档恢复。
  ⇒ ⇒ **两条 seam 是并列关系,不是替换关系。** 本任务需要**两条都做**。
     (或:若只做一条,必须是 blob 那条 —— 它才同时过验收 1 与 2。)
```

**⇒ 我 2.1.1 两条理由的重新裁定(它逐条驳,其中一条我认错)**

```
理由 1 ✗ **我错了**:我写「profile 形态会让房间**先解析出** level/hp ⇒ 第二份派生实现」。
   · 但**我自己设计的 profile 形参里没有 maxHp** —— 房间只传 level 与 hp,
     maxHp 由模拟层 `syncMaxHp` 内部派生。
   · ⇒ 房间**没有算任何派生值** ⇒ 不构成第二份实现。它的反驳**成立**。
   · ⇒ 且它补了实证:`importVitals({hp:535})` 在 maxHp=100 时确实钳成 100
     ⇒ **钳制只有一处实现,没有分叉**。
理由 2 ✓ 成立(它认这条):让 `vitals.ids()` 决定「谁该还原」更对。
   · 但它指出:**这条管的是 DB 的 users 路径**;
     而 blob 路径的作用域是 `(roomId, userId)` ——
     「谁被还原」由**正在 join 的那个人**决定,比 `vitals.ids()` **更窄**,
     ⇒ **不存在幽灵玩家**问题。
   · ⇒ 故理由 2 **不能用来否定 blob 路径**(它作用在不同路径上)。
```

**★ 最终形态(两条并列,均需 `restoreFromProfile` + `loadFromDb`)**

```ts
interface WorldSaveHost {
  /** 读档恢复(blob 路径)—— 验收 1/2/3 靠它。 */
  restoreFromProfile?(playerId: string, profile: {
    level: number; hp: number; x: number; y: number; z: number; weaponId?: number;
  }): boolean;   /* ⚠️ 不含 maxHp —— level 派生值,由模拟层算 */

  /** HP + 生物 mem 从 DB 回世界(users 路径)—— 与上面并列,另一条欠账。 */
  loadFromDb?(db: DbLike, roomId: string): {
    hpApplied: number; memApplied: number; memSkipped: number;
  };
}
```

```
⇒ ★ 而 2.1.1 的 §4.1.1「登记必须先于读档」**仍然成立**(blob 路径同样要先 addPlayer):
   因为它要 `applyPlayerMove` 到实际坐标、且 `projectPlayer` 需要 state 行存在。
```


```
★ 2.1.1 曾用上面三条理由否定 blob 形态 ⇒ ★★ **经 2.1.2 复核,理由 1 与 3 不成立**:
  1 ✗ **错**:房间只传 level/hp,**不传 maxHp** ⇒ 派生仍全在模拟层 ⇒ 无第二份实现。
  2 ✓ 成立,但它管的是 **users 路径**;blob 路径按 `(roomId,userId)` 作用域,**更窄**,
     不存在幽灵玩家 ⇒ 不能用来否定 blob 路径。
  3 ✗ **与结论无关**:它说的是 users 路径的顺序,而 blob 路径的 hp 不走 revive,
     它走 `restoreFromProfile → syncMaxHp → importVitals`;
     ⇒ 顺序约束**仍要**(见 §4.1),但**不构成"因此该选 loadFromDb"的理由**。
```


### 2.2 复用而非新增的部分(★ 经 §2.1.1 / §2.1.2 **两次**订正后)

```
已存在、**不需新增**的权威口(实测):
  写侧(经 host):
    WorldSim.importVitals(data)      —— 走 vitals.revive ⇒ 顺带清 downed/iframe ✓
    WorldSim.setProfile(id, patch)   —— 装备等档案字段
    WorldSim.applyPlayerMove(id,x,y) —— 位置
    WorldSim.syncMaxHp(id, maxHp)    —— US2 已落地的派生上限
    WorldSim.addPlayer(id,x,y)       —— 登记刚体
    progression.setLevel(progress,L) —— 等级(纯函数,返回新对象,需回写 Map)
  读侧(★ 两条并列,消**不同**欠账 —— 不可互相替代):
    A `repo.loadReconnectSnapshot(db,roomId,userId)` —— blob(含 level/maxHp),repo.ts:434
        ⇒ **验收 1/2 只靠它**;目前 `server/src` 真调用点 **0**(仅 room.ts:1830 re-export)
    B `WorldSim.loadFromDb(db,roomId)`               —— users.hp + 生物 mem,world_sim.ts:2673
        ⇒ 独立欠账;**不能替代 A**:它不碰 snapshot_blob,也不写 level

★ 结论(**两次**订正后):本任务**有两条 seam,不是一条**。
  · A =「读档恢复」(blob 路径)⇒ 过验收 1/2/3
  · B =「DB 状态回世界」(users 路径)⇒ 过验收 4 的一部分
  ⇒ ⇒ 我(Lead)在 2.1.1 判「只需 B」是**错的**(见 §2.1.2)。
  ⇒ ★ `net-persist` 的处置**值得作为范例**:**方向分歧时先停手、先实测、再让 Lead 裁**,
     而不是"按 Lead 说的先写完"。这一步省下的是整轮返工。
```

### ★★ 2.2.1 一条**结构性**发现(`net-persist` 报出,Lead 复核):`users` 装不下血上限

```
repo.ts:255-259
  const maxHp = (next.max_hp as number) ?? cur.max_hp;
  next.hp = clampIntQuiet(next.hp as number, 0, maxHp);
⇒ `saveVitalsToUsers` 只传 `{ hp }`(repo.ts:773)⇒ `next.max_hp` 恒 undefined
  ⇒ `maxHp` 恒取 `cur.max_hp`(建号 = **100**)
  ⇒ 而 `users.max_hp` **从来没人写**(Lead 实测:全仓把 level 写进 DB 的调用点 = 0)
⇒ ⇒ **存档层自身把 hp 封在 100。** Lv.30 的 535 血**存不下**。

★ 这不是"接线漏了",是**数据模型层面的缺口** ⇒ 属「等裁决」或「等服务端机制」,
  而非「等编排层接线」。
⚠️ 判据:若某条欠账的理由写「待接入」而实际是**数据模型缺字段**,
  那理由是**误导性的** —— 与 `scoring.ts` 那条同族(见 mob-boss-ai 的发现)。
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

### 4.1 恢复顺序(不可换 ★ 经 §2.1.1 订正)

```
1 校验:该 userId 在本房间**已登记**(members 里有)
    ⇒ 未登记 ⇒ 走正常 join,不恢复(防"凭空造玩家")
2 ★ **登记进世界**(顺序关键):`host.addPlayer(id, x, y)`
    ⚠️ 必须在读档**之前**:`loadFromDb` 内部走
       `loadVitalsFromUsers(db, this.vitals.ids())` ——
       而 `vitals.ids()` **只含已登记玩家** ⇒ 未登记则**读不回来**。
       (实测依据:repo.ts:782 docblock「只读**显式给出的** ID」
        + world_sim.ts:2677 传的正是 `this.vitals.ids()`)
3 ★ **读档(选路,见 §2.2 两条 seam)**:
    ★ **主路 A(blob)**:`loadReconnectSnapshot(db, roomId, userId)` ⇒ blob | undefined
       ⇒ decodePacket(blob) → 取**自己那一行** ⇒ 得到 { level, hp, maxHp, x, y, z, weaponId }
       ⇒ 这正是**唯一含 level** 的持久化处(§2.2.1:`users` 装不下 level/maxHp)
    ○ 副路 B(users):`host.loadFromDb(db, roomId)` —— 独立欠账,**不替代 A**
       (它只回 hp + 生物 mem;而 hp 在 blob 路里已有更全的副本)
3.5 ★ **先按等级同步 maxHp** 再让 hp 落位(**两条路都要**):
    `projectPlayer` 里 level 先投影 ⇒ `syncMaxHpOf` 用派生值刷新 vitals.maxHp
    ⇒ 若驱逐玩家的 maxHp 仍是 100(旧上限),`importVitals` 会把 535 的存档血钳到 100。
    ⚠️ 实现上最稳的顺序(与 US2 §4 同源):
       先 `syncMaxHpOf(id)`(让上限=当前 level 的派生值)
       → 再到 hp:`restoreFromProfile` 内部顺序
         `addPlayer → applyPlayerMove → syncMaxHp → importVitals → setProfile`
       → 再 `projectPlayer`
4 位置:blob 里的 x/y/z 是**投影值**(encode 时刚从 state 读出)⇒
    ⚠️ **不要**直接采信:刚体可能因碰撞被推开 ⇒ 用 `applyPlayerMove(blob.x, blob.y)`
       **并**最后用 `playerPosition(id)` 的实际值给 `ac.join`
5 ★ **再投影**:`projectPlayer(view, id, state.players[i])`(US2 唯一写者)
6 播种反作弊:`ac.join(id, tick, x, y, z)` 用**恢复后**的实际坐标
    ⇒ 不用存档里的坐标:刚体可能因碰撞被推开,两者不同会被判瞬移(实测差 13.649 格)
```

### 4.1.1 为什么「登记必须先于读档」是硬约束(不是风格)

```
★ 这条是**反直觉**的:直觉上"先读档再登记"更自然(先有数据才有玩家)。
  但实测代码决定了相反的顺序:
    world_sim.ts:2677  loadVitalsFromUsers(db, this.vitals.ids())
    repo.ts:782        只读**显式给出的** ID ——
                       「把全表读进来会让"谁该被还原"取决于 DB 里恰好有谁
                        ⇒ **那正是幽灵玩家的来源**」
  ⇒ 故 `vitals.ids()` 就是「谁该被还原」的**唯一权威**;
    未登记 ⇒ 不在 ids ⇒ 读回 0 条 ⇒ **恢复静默无效**
    (而外部表现与"没有存档"完全一样 —— 又一次陷阱 89 的形态!)
⇒ 判据:**任何"读回"接口,先查它的 id 来源是"我传的"还是"它自己扫的"。**

★ 而 **blob 路径同样要先登记**(理由不同,结论相同):
  它要 `applyPlayerMove` 到实际坐标、且后续 `projectPlayer` 需要 `state.players[]`
  里**已有该行** ⇒ 否则移动被丢弃、投影无处可写(静默,不报错)。
```

### 4.1.2 ★ 一条**只有实测才发现**的形态:`users` 路径**永远过不了**验收 2

```
net-persist 实测(Lead 复核源码后采纳):
  · `saveVitalsToUsers` 只传 `{ hp }` ⇒ `users.max_hp` **从不被写**
  · `savePlayerState` 的钳制:`next.hp = clampInt(hp, 0, cur.max_hp)`(repo.ts:259)
  · 建号 `max_hp = 100` ⇒ **535 存进去读出来是 100**
⇒ ⇒ 于是「冷启动走 loadFromDb ⇒ 断言 535/535」这条验收**在数据模型层面不可能通过**,
     与接线做没做**无关**。
⇒ ★ 这一条的价值:**它把一个"接线任务"重新分类成"数据模型缺口"**。
   若不实测,执行者会以为是接线没做,反复接线却永远不绿 ——
   而**每次失败的形态都像"还差一点"**。
⇒ ★★ 判据(可迁移):**当一条验收"怎么接都不绿"时,先怀疑它在数据模型层面不可满足,
   而不是继续接线。**
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

## §9.1 ★★ 验收**执行结果**(2026-11-13,Lead 亲自实现并逐条实测)

> 本节的数字**全部来自实测**,不是计划值。
> 套件:`tests/WS-FND-10-restore.test.ts`(13 条,只走 `assemble()`)。

```
验收 1  loadReconnectSnapshot 有真调用点
        ⇒ ✓ room.ts 里 3 处(import / re-export / 真调用 `loadReconnectSnapshot(this.db`)
        ⇒ 断链判据由 T5 + T9 两条断言钉住
验收 2  两侧一致(权威 与 投影)
        ⇒ ✓ T3:权威 maxHp=535 / hp=535;投影 maxHp=535 / hp=535 / level=30
        ⇒ ★ 且**只断言一侧会被"直写 state"骗过** —— 故两侧都断
验收 3  反向注入:改脏 state ⇒ 下一帧被权威覆盖
        ⇒ ✓ T4:注入 hp=77 ⇒ 下一帧回 535
验收 4  driver.sqlite.ts + memory_db.ts 进可达闭包
        ⇒ ✓ T0(assemble({db}) ⇒ runtime.db 非 null)+ T2(真跑 saveToDb)
验收 5  每消一条欠账配套跨层集成测试
        ⇒ ✓ 本文件 13 条,全部走 assemble()
验收 6  三旗标零告警
        ⇒ 见 §9.2
验收 7  计数算术反推
        ⇒ 见 §9.3
```

### ★★ 执行中实测抓到的**一条真缺陷**(不在原计划内)

```
RoomRuntime 的构造器**无条件** `createRoom`,而 `createRoom` 对已存在的 id
**抛异常**(`repo.ts:328`)。
⇒ 后果:
   服务重启(DB 里已有该房)
   ⇒ `assemble()` ⇒ `new RoomRuntime(...)` ⇒ 抛「房间已存在」
   ⇒ 装配直接失败 ⇒ **冷启动读档在架构上不可达**
实测:
   new RoomRuntime(opts, db) 第一次 ⇒ OK
   new RoomRuntime(opts, db) 第二次 ⇒ ★ 抛「房间已存在:room_a」
   assemble({db}) 第二次          ⇒ ★ 同上
⇒ ⇒ 而本任务的名字**就是冷启动**。即:本任务的主验收路径被一个
   **与本任务无关的守卫**堵死,而在此之前没有任何测试走到过那里
   (因为所有存量测试都用**新库** —— 陷阱 74:夹具形态掩盖了生产形态)。
修:构造器改成**先查后建**(幂等),不碰 `createRoom` 自身的守卫
   (实测有断言依赖它抛)。
```

### ★★ 执行中实测抓到的**两处覆盖缺口**(负向验证抓出)

```
我第一版的 11 条测试在 9 条注入中**放过 2 条**:
 I3 去掉 room 侧的 `addPlayer` ⇒ 测试仍绿
    (因为 restoreFromProfile **自己**也登记 ⇒ 行为上观察不到)
    ⇒ 缺口:补 T11(结构断言:检查源码里 addIdx < restoreIdx)
 I9 sim 把武器写进 heldItem(而非 wearing)⇒ 测试仍绿
    ⇒ 缺口:补 T10(武器端到端往返 —— 契约 §2.1 的 weaponId 字段当时形同虚设)

补完后 9/9 注入全部被抓到,**仍绿 = 0**。

⇒ ★ 教训:11/11 通过**不代表**覆盖了 11 件事。
   判据不是"测试有多少条",而是「**打坏被测的东西,它会不会红**」;
   而负向验证**必须先取基线**(陷阱 79:没有基线的负向验证会以
   100% 的"通过率"告诉你一个它没测过的东西)。
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
