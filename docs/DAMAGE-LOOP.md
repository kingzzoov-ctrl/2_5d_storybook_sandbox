# 伤害闭环:从 AI 的攻击意图到玩家掉血

> 本文记录 `server/src/combat/vitals.ts` 这一层为什么存在、职责边界在哪、
> 以及接线时踩到的三个「不报错但行为全错」的陷阱。

---

## 1. 职责边界

### 这一层**负责**

| 职责 | 说明 |
| :--- | :--- |
| 持有玩家生命值 | `VitalsSystem` 是玩家血量的**唯一**真相来源 |
| 结算生物攻击 | 把 AI 的攻击意图(预警几何 / 事件)与玩家位置对照并扣血 |
| 计时器 | 无敌帧倒计时、受伤后延迟回血 |
| 发受击事件 | `player_hit` / `player_downed`,供 UI 与音效订阅 |

### 这一层**不负责**

| 不负责的事 | 归谁 |
| :--- | :--- |
| 决定 AI 什么时候攻击 | 25 个 AI(`mobs/behaviors.ts`) |
| 玩家攻击生物 | WS-10 的 `computeDamage`(`combat/damage.ts`) |
| 生物死亡与掉落 | 编排层 + `MobHost` |
| 复活流程与重生点 | 服务器层(未实现) |
| 玩家攻击玩家的 PvP 结算 | 未实现(见 §8 U3) |

### 为什么玩家血量不放进 `WorldPlayer`

`WorldPlayer` 是 WS-04(`mobs/behaviors.ts`)的冻结接口。加 `hp` 字段会让
WS-04 的 55 条断言与它的假 `MobWorld` 全部要改。

职责上也对:AI 需要知道「玩家在哪、朝哪、在做什么」,不需要知道
「他剩多少血」—— 血量是战斗结算的输入,不是 AI 决策的输入。

所以玩家血量由**编排层**持有(`WorldSim.vitals`),与 `AoiManager`、
`MobHost` 并列。

---

## 2. 接口

```ts
/* 生命值系统(编排层持有) */
class VitalsSystem {
  constructor(maxHp = PLAYER_BASE_HP)
  register(id: string): PlayerVitals          // 满血登记
  unregister(id: string): boolean
  get(id: string): PlayerVitals | null
  ids(): string[]                             // 顺序稳定(排序过)
  get size(): number
  revive(id: string, hp?: number): boolean
  beginFrame(): void                          // 清空「本帧已命中」集合
  applyHit(attackerId, playerId, level, mul?, distance?): MobHitResult
  heal(id: string, amount: number): number    // 返回实际回复量
  stepTimers(dt: number): void                // 推进无敌帧与回血
  snapshot(): { players, hits, damage, downed }
  readonly totals: { hits, blocked, damage, downed, warnsChecked }
}

/* 纯函数:判定与收集 */
warnHitsPlayer(g: WarnGeom, px, py, pz): boolean
explainMiss(g: WarnGeom, px, py, pz): string
mobHitDamage(level: number, mul?: number): number
resolveStrikes(strikes, players, blockedKeys?, iframePlayers?): { results, warnsChecked }
collectEventStrikes(events, posOf, levelOf): PendingStrike[]
eventStrikeRule(kind: string): { mul, radius } | null

/* 编排层入口 */
WorldSim.vitals: VitalsSystem
WorldSim.addPlayer(id, x, y)      // 自动 vitals.register
WorldSim.removePlayer(id): boolean
WorldSim.healPlayer(id, amount): number
WorldSim.revivePlayer(id, hp?): boolean
WorldSim.lastHits: MobHitResult[]  // 最近一帧的命中(诊断)
WorldSim.hitCount: number
WorldSim.warnsChecked: number      // 累计检查的预警数(为 0 = AI 没产出过)
```

---

## 3. 数据结构

```ts
interface PlayerVitals {
  id: string;
  hp: number;
  maxHp: number;
  iframeSec: number;      // 无敌剩余秒数
  sinceHurtSec: number;   // 距上次受伤(用于回血延迟)
  totalTaken: number;     // 累计受伤(观测)
  hitCount: number;
  downed: boolean;
}

interface MobHitResult {
  playerId: string;
  attackerId: string;
  rawDamage: number;       // 按等级算出的原始伤害
  applied: number;         // 实际扣除(0 = 被无敌/已倒下挡掉)
  blockedByIframe: boolean;
  downed: boolean;
  distance: number;        // 命中时与预警中心的距离(诊断)
}

interface PendingStrike {
  attackerId: string;
  attackerLevel: number;
  warn: WarnGeom;
  mul?: number;
}
```

`rawDamage` 与 `applied` **必须分开**:前者是伤害公式的输出,后者是实际
结果。合成一个字段会让「被无敌帧挡下」与「伤害为 0」无法区分,
调平衡时会得出错误结论。

---

## 4. 算法

### 4.1 两条攻击通道

实测确认:25 个 AI 用**两种**形态表达威胁,必须都结算。

| 通道 | 形态 | 实例 | 结算时机 |
| :--- | :--- | :--- | :--- |
| 预警几何 | `WarnGeom`(形状 + 半径 + 时长 + z) | 野猪冲锋、岩元素火环、雷电精灵放电、河蟹、果冻怪、蝙蝠音波、布丁法师 | AI 返回它的那一帧起,`warnSec` 秒内有效 |
| 事件 | `emit('xxx')` | `scorpion_ambush`(伏击)、`pangolin_wall_stun`(滚撞) | 事件被发出的那一帧 |

**只接前者会怎样**:蝎子从沙下钻出来咬你,**不掉血**,而且不报错。
实测:接入事件通道前蝎子命中 0 次;接入后 4 次 / 136 伤害。

### 4.2 命中判定

```
warnHitsPlayer(g, px, py, pz):
  1. 高度:|pz − g.z| ≤ g.zTolerance         // 云鲸高空吐息打不到地面
  2. 平面:按 g.kind 判(x,y):
       CIRCLE  → dist ≤ radius + SLACK
       RING    → innerRadius − SLACK ≤ dist ≤ radius + SLACK
       SECTOR  → 方位角差 ≤ halfDeg(用 centerDeg 定向)
       RECT    → 投到矩形本地轴: |localX| ≤ halfLen, |localY| ≤ halfWidth
       POINTER → along ∈ [0, halfLen], |across| ≤ halfWidth(背后不算)
```

**`SECTOR` 与 `RECT` 是带方向的**,必须用 `centerDeg` 旋转后再判。

### 4.3 一帧的结算顺序

```
tick():
  ├─ 快帧:physics.step → syncPlayers
  ├─ 慢帧:aoi.update() → mobHost.tickMobs() → resolveMobStrikes()
  │        ├─ vitals.beginFrame()           // 清「本帧已命中」
  │        ├─ 收集 strikes(预警几何 + 事件)
  │        ├─ resolveStrikes(...)           // 纯函数,先算全部命中
  │        ├─ vitals.applyHit(...) 逐个提交
  │        └─ vitals.stepTimers(dt)         // 无敌帧与回血
  └─ 每帧末尾:bus.drain()
```

**先算全部再提交**:若边判边改,后续判定会读到已变的血量与位置。

`stepTimers` **即使没有攻击也要调用** —— 否则无敌帧永不结束
(表现是「被打一次之后再也不掉血」),回血也永不发生。

---

## 5. 参数

| 常量 | 值 | 依据 |
| :--- | :--- | :--- |
| `PLAYER_BASE_HP` | 100 | 使「一刀掉多少」与百分比直觉一致 |
| `MOB_HIT_BASE` | 6 | 1 级基础伤害 |
| `MOB_HIT_PER_LEVEL` | 2 | 每级 +2 |
| `MOB_HIT_RADIUS_SLACK` | 0.25 | 吸收浮点边界,小于玩家半径的一半 |
| `PLAYER_IFRAME_SEC` | 0.35 | 防同一帧多个预警叠算 |
| `PLAYER_REGEN_PER_SEC` | 1.0 | 受伤 100 秒回满:慢到不鼓励硬抗,快到不用回城 |
| `PLAYER_REGEN_DELAY_SEC` | 6.0 | 受伤后 6 秒才开始回血 |

公式:`MobHit = max(1, round((6 + 2×(level−1)) × mul))`

实测伤害表(节选):

| 生物 | 等级 | 单次伤害 | 占玩家血 |
| :--- | ---: | ---: | ---: |
| 果冻怪 | 2 | 8 | 8% |
| 野猪 | 4 | 12 | 12% |
| 河蟹 | 6 | 16 | 16% |
| 布丁法师 | 16 | 36 | 36% |
| 雷电精灵 | 21 | 46 | 46% |
| 岩元素 | 23 | 50 | 50% |
| 钟表骑士 | 25 | 54 | 54% |

设计意图:敌对生物单次打掉 8%~54%,低等级「被围攻 5~12 次倒下」
(有逃跑窗口但站着不动会死),高等级 2 次就危险。

事件型伤害倍率:`scorpion_ambush` ×1.5(伏击是突袭,高于普攻)、
`pangolin_wall_stun` ×1.0、`tanuki_ambush` 无伤害(只扔迷雾果致盲)。

---

## 6. 性能

| 项 | 成本 |
| :--- | :--- |
| `warnHitsPlayer` | 一次 `hypot` + 一个 `switch`,无分配 |
| `resolveStrikes` | O(strikes × players);实测 24 只 vs 1 玩家 = 55 次判定/慢帧 |
| 每慢帧实际预警数 | 实测 8 只产预警的生物共 4~8 个/慢帧 |
| 生物等级查表 | `runtimeOf` 是 Map 查,实测无热点 |
| 分配 | `resolveStrikes` 每次调用分配一个结果数组;慢帧 2Hz,可忽略 |

慢帧预算 500ms,实测整个 `resolveMobStrikes` 远低于 1ms —— 不是热点。
**真正贵的是 `syncPlayers`**(每快帧重建玩家视图),但它本来就存在。

---

## 7. 边界

| 边界情况 | 行为 |
| :--- | :--- |
| 攻击者不在 `runtimes()` 里 | 跳过该 strike(不抛错) |
| 生物已死(`alive=false`) | 不产生 strike |
| 玩家已倒下 | `applyHit` 直接返回,不再累计 |
| 玩家未登记到 vitals | `applyHit` 返回 0 伤害(**静默** —— 所以 `addPlayer` 必须登记) |
| 目标玩家不存在 | 返回 `applied=0` 的空结果 |
| 同一生物同帧多个预警 | 只算一次伤害(`hitThisFrame` 去重键 `attacker→player`) |
| 多个生物同帧打同一玩家 | 第一个不被挡,其余被无敌帧挡(`blockedByIframe`) |
| 回血上限 | 不超过 `maxHp`,且 `downed` 时不回血 |
| `warns` 为空 | 正常路径,不报错 |
| `strikes` 或 `players` 为空 | 仍推进计时器(见 §4.3) |

---

## 8. 耦合

```
25 个 AI ──返回 WarnGeom──┐
   │                      ├──> VitalsSystem ──> player_hit 事件 ──> UI/音效
   └──emit('xxx')─────────┘         │
                                    └──> WorldSim.lastHits(诊断)
```

依赖方向单向:`AI → 结算 → 事件`。`VitalsSystem` **不反向调用 AI**。

| 上游 | 提供的 |
| :--- | :--- |
| `mobs/behaviors.ts`(WS-04,冻结) | `WarnGeom` 形状语义、`WorldPlayer` |
| `mobs/host.ts` | `tickMobs` 返回的 `warns`、`frameEmits` |
| `mobs/fsm.ts`(WS-04,冻结) | `resolveTelegraphHit`(本文未直接用,见 U1) |
| `combat/damage.ts`(WS-10) | 玩家攻击生物的公式(方向相反,不共用) |

| 下游 | 用途 |
| :--- | :--- |
| `WorldSim` | 每慢帧调用 `resolveMobStrikes` |
| UI(待接) | 订阅 `player_hit` / `player_downed` |
| 复活流程(待做) | `revivePlayer` |

**与 WS-10 `computeDamage` 的关系**:两者**不共用代码**,方向相反。
WS-10 是「玩家打生物」,要武器/连段/元素/护盾/反伤;生物打玩家只要
等级缩放。硬合会逼生物也走一遍玩家术式,反而更脆。若将来要做
「Boss 的特殊技也吃元素抗性」,再引入共享的减伤乘区。

---

## 9. 验收

| 验收项 | 断言位置 |
| :--- | :--- |
| 玩家登记后可受伤 | `WS-FND-02 C09/C10` |
| 生物在旁能命中 | `verify.ts`「伤害闭环可达」 |
| 无生物时满血 | `verify.ts`「对照通过」+ `WS-FND-02` |
| 事件型通道可达 | `WS-FND-02 C17` |
| 事件型有距离限制 | `WS-FND-02 C18` |
| 无敌帧去重 | 手动实测:60 秒 7 次命中,间隔 ≥ 180 帧 |
| 倒下后不再受伤 | 手动实测 |
| 同种子确定性 | `WS-FND-02 C07` |

故障注入验证(全部可失败,非装饰):

| 注入 | 结果 |
| :--- | :--- |
| `probe` 极性反转 | C14/C15/C16 三条失败 |
| 移除防穿墙夹取 | C13 失败(穿山甲穿过 1 格墙) |
| 事件通道半径改 0 | C17 失败(伏击 0 命中) |
| `REFLECT_RADIUS` 3.0 → 6.0 | WS-10 变 43/44(修复前 **44/44 全绿**) |
| `BASE_CRIT_DMG` 1.5 → 2.5 | WS-10 变 43/44 |
| `BUBBLE_TRAP_SEC` 5.0 → 9.0 | WS-10 变 43/44 |
| `GHOST_MOVE_MUL` 0 → 0.5 | WS-10 变 43/44 |
| `MIN_DAMAGE` 1 → 0 | WS-10 变 43/44(修复前全绿) |
| `MIN_DAMAGE` 1 → 100 | WS-10 变 39/44(5 条失败) |
| `MAX_DODGE_RATE` 0.75 → 0.99 | WS-10 变 43/44(修复前全绿) |
| `MAX_DODGE_RATE` 0.75 → 0.10 | WS-10 变 43/44 |
| `ARMOR_K` 120 → 240 | WS-10 变 42/44(2 条失败) |

> 上表由 task-23「同义反复定性复查」逐条实测产出。**判定标准是「注入后是否变红」**,
> 不是「断言右侧看起来像不像常量」—— `verify.ts` 亦持此立场(其注释明确写着
> 「真正的判定只能靠注入法」)。
>
> **两类候选必须分开**(task-23 的核心结论):
> - **真缺陷(无守卫)**:`REFLECT_RADIUS`(修前注入 3→6 仍 **44/44 全绿**)、
>   `MIN_DAMAGE` 下界、`MAX_DODGE_RATE` 上界 —— 这三处已改/已加固。
> - **合法候选(有守卫)**:`BASE_CRIT_DMG` / `BUBBLE_TRAP_SEC` / `GHOST_MOVE_MUL`,
>   注入后**会红**(由同套件的字面量断言抓住),属 `verify.ts` 白名单里已登记的候选,
>   是冗余而非漏洞 —— **刻意保留原样**,因为改成字面量会使白名单条目失真,
>   而那需要同步修改 `scripts/verify.ts`(非本任务写域)。


---

## 10. 未决

| ID | 问题 | 影响 |
| :--- | :--- | :--- |
| **D1** | 玩家受伤后**击退**与**硬直**未实现:被野猪冲锋撞中,位置不变 | 手感偏硬;击退需要写回 `PhysicsBody`,涉及移动权威归属 |
| **D2** | 生物攻击**不检查视线**:隔着 1 格墙也能打中 | 需在 `resolveStrikes` 里加射线遮挡判定 |
| **D3** | PvP 与「Boss 技能对玩家的特殊效果」(冻结/麻痹)未做 | 依赖状态机层 |
| **D4** | 伤害无**元素抗性**:生物的攻击不区分元素 | 玩家装备的元素抗性目前只对生物生效 |
| **D5** | `tanuki_ambush` 的致盲效果只有 `mem.blindSec`,玩家侧无对应状态 | 致盲需玩家的输入层配合 |
| **D6** | 倒下后无**复活流程**:`downed=true` 后只能靠 `revivePlayer` 手动复活 | 需要死亡界面与重生点 |
| **D7** | 玩家血量**不持久化**:重连后满血 —— **部分解决(task-17 通道 + task-21 闭环,详见下)**:三层(DB 读写 / 编排层 `saveToDb`·`loadFromDb` / 房间 `step()` 每 20 帧)**均已接通并有测试守护**,但生产装配 `room.colyseus.ts` 尚未挂 `worldSaveHost`,故**线上重连仍会满血** | 原描述属实且比文字更严重:`savePlayerState` 在**全仓只有测试调用、零生产调用点**;`vitals.register` 恒设满血(`vitals.ts:310`)。task-21 补齐 db 层与房间生命周期,用 C23/C25 断言读回**状态值**;**剩余工作仅一行装配**(见 §10.1 末表,依赖 US2) |
| **D8** | `resolveStrikes` 的 `blockedKeys` 参数**功能有效但编排层不传它** | 实测:不传 → 命中 1 次;传 `{'m1→p1'}` → 命中 **0** 次。它种下 `used` 集合防同一帧重复命中。编排层当前不传,是因为「同一攻击者同一帧只打一次」已由预警通道的 `warnSec` 到期语义保证。保留它是为**预测式结算**(客户端先报命中、服务端校验)预留的入口 —— 不是死参数 |
| **D9** | ~~与 `MobFsm` 的移动权威缺口(U1)有间接耦合~~ **已随 U1 解决** | `EVENT-BUS.md` U1 已由 CR-9 裁决为**方案 D**(FSM 做基础移动,AI 做专属动作,位置恒同步)。本题的「夹取基于 `rt` 的差值」判断依然正确 —— 同步保证 `rt` 与 `fsm` 不分叉 |

### 10.1 D7 核查证据:玩家 HP 持久化(task-17 通道 / task-21 闭环)—— **部分解决**

**核查结论:原描述属实,且实际情况比文字更严重。** 本任务解决的是「运行时根本没有取值通道」这一段;端到端的落盘接线**仍未完成**,因为它落在 db 层与房间生命周期(他人写域)。

**分层核查**(逐层给出 `file:line`):

| 层 | 现状 | 证据 |
| :--- | :--- | :--- |
| DB 字段 | `users.hp` / `users.max_hp` **存在**,且有钳制逻辑 | `repo.ts:237-262` `savePlayerState`(hp 用 `clampIntQuiet` 静默钳到 `[0, maxHp]`) |
| DB 调用点 | **全仓零生产调用** —— 只有定义与 4 处测试引用 | `repo.ts:237` 定义;`tests/WS-07.test.ts:597/603/607/2211` 为仅有的调用 |
| 运行时取值 | 玩家 HP 由**编排层**持有,不来自 DB | `vitals.ts:287-320` `VitalsSystem`;`world_sim.ts:628` `readonly vitals = new VitalsSystem()` |
| 登记默认值 | **恒满血** —— 重连即回满,与存档无关 | `vitals.ts:310` `hp: this.maxHp` |
| 读档路径 | 无:没有任何地方把 DB 的 `hp` 读进 `VitalsSystem` | 全仓检索 `importVitals` / `loadVitals` 等**,修复前零命中** |

也就是说,D7 不是「存档路径写错了」,而是**存档路径根本不存在**:`savePlayerState` 是一个**只被测试调用的函数**,`users.hp` 字段从来没有被写入过真实玩家的血量,自然也没有读回。

**已修**(task-17 在 `server/src/sim/world_sim.ts`;task-21 续接 db 层与房间生命周期):

| 接口 | 位置 | 语义 |
| :--- | :--- | :--- |
| `WorldSim.exportVitals()` | `world_sim.ts:574` | 导出 `{id: {hp, maxHp, downed}}`,供存档层写进 `users.hp` |
| `WorldSim.importVitals(data)` | `world_sim.ts:591` | 读回并生效,返回生效玩家数 |
| `saveVitalsToUsers(db, vitals, nowMs)` | `db/repo.ts` §11 | 批量写 `users.hp`;**只写 `hp`**,返回 `{saved, skipped}` |
| `loadVitalsFromUsers(db, ids)` | `db/repo.ts` §11 | 按**显式给出的 ID** 读回(不扫全表,避免幽灵玩家) |
| `WorldSim.saveToDb(db, roomId, nowMs)` | `world_sim.ts` | 一段式落盘:HP + mem,返回各段计数 |
| `WorldSim.loadFromDb(db, roomId)` | `world_sim.ts` | 对偶读回:先 HP 后 mem |
| `WorldSaveHost`(结构化接口) | `net/room.ts` | 房间只声明**用到的那个方法**,刻意不 import 模拟层(否则 US2 真成过时条目) |
| `RoomRuntime.step()` 每 20 帧落盘 | `net/room.ts` | 复用既有 20 帧节流,与 `world_tick` 同帧同版;`worldSaveHost=null` 时不做任何事 |

**为什么 `max_hp` 不进运行时**:`users.max_hp` 是**成长派生量**(随等级走),而 `VitalsSystem.maxHp` 是构造期常量(`vitals.ts:291/302`)。拿全局常量去覆盖每个人的成长上限,会让 30 级玩家读档后掉回基础血量 —— 故落盘只写 `hp`。`C23` 用 `max_hp=535` 钉住这一点。

**三个关键语义决定**:

1. **用 `revive(id, hp)` 而不是直接改 `v.hp`**:`revive` 会顺带清掉 `downed` 与 `iframeSec`。否则「倒下状态」会被一起读回来,玩家一上线就是**倒地不起**。写回后断言 `downed === false` 锁住这一点;
2. **钳到 `[0, v.maxHp]`,且**不信任**存档里的 `maxHp`**:`VitalsSystem` 的 `maxHp` 是构造期常量(`vitals.ts:291/302`),应以运行时为准。满血 100 的玩家不该因为一份脏存档变成 5 位数;
3. **脏数据一律跳过而非抛错**:`NaN` / `Infinity` / 缺字段都不改动现值。理由是血量在战斗中高频变化,一次落盘损坏不该连带毁掉整局。

**测试覆盖**(`tests/WS-FND-02.test.ts`,「写完读回一致」):

- `C21` 导出 `hp=37` → `JSON` 往返 → 导入 → 断言读回 `37`(而**不是**满血),且 `downed=false`;
- `C22` 边界:超上限钳到 `maxHp`、负数钳到 `0`、`NaN`/`Infinity`/缺字段被拒且不改动现值、未登记玩家不生效也不凭空注册、`hp=0` 读回保留但 `downed` 被清掉(不会「上线即倒地」);
- `C23` **(task-21)真实 DB 往返**:`MemoryDb` + 真实 `repo.ts` 建号建房 → 打到 `hp=37` → `saveToDb()` → **直接查 `users` 行**断言 `hp=37` → 换全新世界 `loadFromDb()` → 断言读回仍是 `37`。同时断言 `max_hp=535` **未被**运行时常量(100)污染,以及无账号玩家被计入 `hpSkipped` 而非静默丢失;
- `C25` **(task-21)接线守护**:从 `RoomRuntime.step()` 出发 —— 第 19 帧前不落盘(低频节流仍生效)、第 20 帧落盘、且读的是**库里的状态值**(`users.hp=37`、`rooms.mob_mem_json` 内容);并断言无存档源时 `lastSaveReport` 保持 `null`(不假装存过)。

**故障注入**(三项均实测变红后还原):

| 注入 | 结果 |
| :--- | :--- |
| `saveToDb` 里跳过 HP 落盘 | `C23` 红:`两个有账号的玩家都写进 users 期望 2 / 实际 0` |
| 落盘时误把 `max_hp` 写成运行时常量 100 | `C23` 红:`max_hp 未被运行时常量污染 期望 535 / 实际 100` |
| 断掉 `step()` 里的 `worldSaveHost` 调用 | `C25` 红:`第 20 帧应发生落盘` |

**仍未做**(明确边界,诚实记账):上面两段(task-17 / task-21)只在**编排层、db 层与房间运行时内**闭合。生产装配 `server/src/net/room.colyseus.ts` 目前**没有**把模拟层挂到 `runtime.worldSaveHost` 上,所以线上房间的 HP 仍不会自动落盘:

| 缺口 | 位置 | 现状 | 补法 |
| :--- | :--- | :--- | :--- |
| 生产装配未挂 `worldSaveHost` | `room.colyseus.ts:97` `new RoomRuntime(rtOpts, this.deps?.db ?? null)` | `worldSaveHost` 保持默认 `null` → `step()` 里那段落盘被跳过 | 一行:`this.runtime.worldSaveHost = sim`(需先把 `WorldSim` 放进房间装配,即 US2) |

这不是可以含糊过去的地方:`worldSaveHost === null` 时 `RoomRuntime.lastSaveReport` 保持 `null`,`C25` 专门断言了这一点(**不假装存过了**)。也就是说「没接线」是**可观测**的,而不是一个会被误当成已完成的静默分支。

---

## 附:接线时踩到的三个陷阱

三个都**不报错**,只是行为全错 —— 这类问题的代价最高。

### 陷阱 1 `probe` 极性搞反(全图每格都是障碍)

`MobWorld.probe` 在冻结层里**只有一行签名、没有任何注释** —— 合同缺失。
极性只能从调用方反推:

```ts
const nx = ...; const ny = ...;
if (world.probe(nx, ny)) { /* 撞墙自晕 */ }
rt.x = nx; rt.y = ny;              // 没撞才移动
```

即 `true` = **挡路**。我按「可站立 = true」(名词语义上更自然)写,
结果是**全图 2304 格每格都被判为障碍** → 野猪与穿山甲每帧自晕、永不移动。

实测判据:穿山甲在玩家 10 格外仍 `stunSec=4` 且位移恒为 0。

### 陷阱 2 隧道效应(1 格厚的墙被跨过)

`probe` 只判**终点**,而 AI 步长可达 4.5~5.5 格:

| 墙厚 | 结果 |
| ---: | :--- |
| 1 格 | **穿过** |
| 3 格 | 挡住 |
| 5 格 | 挡住 |

这个 bug **只在薄墙时显形** —— 用 3 格墙测试会永远看不到它。
修在宿主(`probeSweep` / `sweepClampT`),把 AI 写的位移夹到墙前,
一处生效覆盖全部 25 个 AI。

### 陷阱 3 只接了预警通道,漏了事件通道

AI 用两种形态表达威胁(§4.1)。只接前者时,蝎子的伏击、穿山甲的滚撞
**打到玩家不掉血**。两种通道都是设计事实,不是重复实现。

### 另:两条自检教训

1. **静态分析两次都给出错误答案**。我用正则从源码里提取「哪些 AI 产预警」,
   两次得到不同结果,且都与实测矛盾(说野猪不产,实测 40 个)。
   嵌套花括号与超长类体让正则不可靠。**改用实测作为唯一事实来源**。
2. **诊断脚本本身会有 bug**。一个探针把 `s.bus.on(...)` 写在计时循环里,
   得到「宿主 70 次 vs 总线 7 次」的假矛盾。仪器不可信时先验证仪器。
