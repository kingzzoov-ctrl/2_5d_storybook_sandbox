# WS-07 · SQLite 存档、Colyseus 20Hz 差量协议与房间生命周期

> 对应设计手册 §7.1(存档与持久化)、§7.2(状态 Schema)、§2.1(20Hz 高频帧)。
> 冻结层依赖:`shared/types/tile.ts`、`shared/types/physics.ts`、`shared/types/entities.ts`、`shared/constants/items.ts`。

---

## 1. 职责边界

**本子系统负责**

- SQLite 全量 DDL(9 表 + 9 索引 + 1 视图 + 1 触发器)、迁移版本表与漂移检测。
- 1KB/Chunk 地形二进制读写(256 格 × Uint32 小端 = `CHUNK_BYTES`)。
- 20Hz 状态字段表、字段级差量编解码、带宽预算。
- 客户端预测、服务端权威校正与远程实体插值(100ms 延迟 / 5% 丢包)。
- 房间生命周期:创建 / 加入 / 离开 / 60 秒无人休眠 / 唤醒 / 30 秒断线重连。
- 权限矩阵(4 角色 × 9 权限位 × 22 动作)。
- 四类反作弊:坐标跳变、移速上限、攻速上限、物品栏守恒。

**明确不负责**

- 物理积分本身(`integrateHorizontal` / `integrateVertical`)由 WS-02 负责;本子系统只消费其结果做校验。
- 地形元胞自动机与脏格位图由 WS-01 负责;本子系统只负责序列化落库。
- 战斗数值、掉落表由 WS-05 / WS-11 负责;本子系统只校验物品总量守恒。
- LLM 炼金生成由 WS-06 负责;本子系统只做配方缓存表与 `craft_count` 计数。
- 客户端渲染与 Three.js 场景由客户端子域负责;本子系统只定义线上格式。

---

## 2. 接口

### 2.1 消费的冻结层符号

| 符号 | 来源 | 用途 |
| :--- | :--- | :--- |
| `CHUNK_BYTES = 1024` / `CHUNK_CELLS = 256` | `tile.ts` | `tiles_blob` 长度约束、`packChunkBlob` 长度校验 |
| `packTile` / `unpackTile` | `tile.ts` | Chunk round-trip 测试的格值构造与解出 |
| `TICK_HZ = 20` / `DT = 0.05` | `physics.ts` | 帧率、单帧位移上界、模拟间隔 |
| `BASE_MOVE_SPEED = 4.5` | `physics.ts` | 移速上限的基线(`§5 参数表`) |
| `BodyState`(七态) | `physics.ts` | `stateFlag` 索引 0..6 的唯一事实源 |
| `MobFsmState`(三态) | `entities.ts` | `WildlifeState.fsm` 索引 |
| `BASE_ATTACK_INTERVAL_S` 对应值 | 手册 §4.1 | 攻速上限基线 0.4s |

### 2.2 对外输出的模块

| 模块 | 导出 | 说明 |
| :--- | :--- | :--- |
| `server/src/db/schema.sql` | — | 纯文本 DDL 产物,`repo.ts` 与测试共读 |
| `server/src/db/repo.ts` | `DbLike` `migrate` `packChunkBlob` `createUser` … | 零依赖仓储核心 |
| `server/src/db/memory_db.ts` | `MemoryDb` | `DbLike` 内存实现(测试/冒烟) |
| `server/src/db/driver.sqlite.ts` | `SqliteDb` `SqlConnection` `openNodeSqlite` `nodeSqliteConnection` `betterSqlite3Connection` | `DbLike` → 真实 SQL。**SQL 翻译层由测试真实执行**(经 `node:sqlite`,零依赖);`better-sqlite3` 仅作类型与可选适配器 |
| `server/src/net/schema.ts` | `FIELD_TABLE` 等四张表、`RoomState` | 零依赖状态核心 |
| `server/src/net/schema.colyseus.ts` | `PlayerSchema` 等 `Schema` 子类 | 装饰器装配(不被测试 import;由 H 组按**源码文本**校验) |
| `server/src/net/delta.ts` | `encodeDelta` `decodePacket` `applyPacket` `estimateBandwidth` | 手写差量编码 |
| `server/src/net/prediction.ts` | `predictStep` `reconcile` `Interpolator` `LossyChannel` | 预测/校正/插值 |
| `server/src/net/anticheat.ts` | `AntiCheatRoom` `checkMove` `checkAttack` `checkInventory` | 四类校验 |
| `server/src/net/room.ts` | `RoomRuntime` `RoomRegistry` `PERMISSION_MATRIX` `AFK_TIMEOUT_MS` `MemberPresence` | 生命周期、权限、在场四态 |
| `server/src/net/room.colyseus.ts` | `NetPersistRoom` `USE_COLYSEUS_PATCH` | Colyseus 薄装配 + 单通道开关 |

**零依赖分层的关键**:`tests/WS-07.test.ts` 只 import `node:*` 与 `shared/**` 与本 WS 的零依赖实现。`schema.colyseus.ts` / `room.colyseus.ts` 承担 Colyseus 依赖,不被测试导入。

`driver.sqlite.ts` 原本也在此列(依赖 `better-sqlite3`),**现已改造成零依赖可测**(CR-12):

```
  repo.ts(仓储逻辑,零依赖)
       │ DbLike
       ▼
  SqliteDb  ← SQL 生成 / 白名单 / 绑参 / BLOB 归一(唯一实现点)
       │ SqlConnection { exec, all, get, run, transaction, close }
       ├──────────────┬────────────────────┐
       ▼              ▼                    ▼
  better-sqlite3   node:sqlite        测试内存桩
  (optionalDep)    (Node 内置,零依赖)
```

两个适配器分别约 15 / 25 行 —— **「换驱动只需薄适配器」从注释变成了可测量的实测值**。`node:sqlite` 是 Node 24 内置,所以 `verify.ts` 能零依赖地驱动那份 SQL 翻译逻辑,`openNodeSqlite()` 也让生产部署不装 `better-sqlite3` 时仍可运行。

---

## 3. 数据结构

### 3.1 SQLite 九表

```
schema_migrations(version PK, name UNIQUE, checksum, applied_at)
users(id PK, display_name, level, exp, hp, max_hp,
      pos_x, pos_y, pos_z, dir, state_flag,
      weapon_id, ai_weapon_recipe_hash, held_item_id, carrying_entity_id,
      inventory_json, talent_json, home_room_id, created_at, updated_at)
rooms(id PK, owner_id FK→users, name, access_mode, password_hash,
      max_players, status, party_mode, world_seed, world_tick,
      chunk_radius, created_at, last_active_at, saved_at)
user_sessions(token PK, user_id FK→users, room_id FK→rooms, issued_at, expires_at, revoked)
room_players(room_id+user_id PK, role, snapshot_blob BLOB, joined_at, last_seen_at)
room_chunks(room_id+chunk_x+chunk_y PK, version, tiles_blob BLOB(1024), updated_at) WITHOUT ROWID
ai_alchemy_recipes(recipe_hash PK, input_ids, k_inputs, item_name, category,
                   rarity_tier, t_eff, q_score, p_budget, stats_json, visual_json,
                   pixel_icon_json, llm_model, first_crafter_id, craft_count,
                   created_at, last_crafted_at)
ai_item_instances(instance_id PK, owner_id FK, recipe_hash FK, slot, quantity,
                  equipped, stats_json, bound_room_id FK, created_at, updated_at)
room_events(id PK AUTOINCREMENT, room_id FK, tick, kind, actor_id, payload_json, created_at)
```

**外键 + ON DELETE 策略**

| 子表.列 | 父表.列 | 策略 | 理由 |
| :--- | :--- | :--- | :--- |
| rooms.owner_id | users.id | CASCADE | 删号即删其房 |
| user_sessions.user_id | users.id | CASCADE | 会话随号亡 |
| user_sessions.room_id | rooms.id | SET NULL | 会话不该因房没而消失 |
| room_players.room_id | rooms.id | CASCADE | 成员表随房走 |
| room_players.user_id | users.id | CASCADE | 同上 |
| room_chunks.room_id | rooms.id | CASCADE | 地形随房走 |
| ai_alchemy_recipes.first_crafter_id | users.id | SET NULL | 配方是全服资产,不能随人消失 |
| ai_item_instances.owner_id | users.id | CASCADE | 私有物随号亡 |
| ai_item_instances.recipe_hash | ai_alchemy_recipes.recipe_hash | SET NULL | 实例保留,配方失效 |
| ai_item_instances.bound_room_id | rooms.id | SET NULL | 绑定房没则解绑 |
| room_events.room_id | rooms.id | CASCADE | 审计随房走 |

> `users.ai_weapon_recipe_hash` 与 `users.home_room_id` 是**软引用**(无 FK):`rooms` 与 `ai_alchemy_recipes` 建表晚于 `users`,硬 FK 会形成循环依赖。悬空由 `repo.ts:savePlayerState` 的写入校验兜底。

**索引**(9 个)

| 索引 | 列 | 服务的查询 |
| :--- | :--- | :--- |
| `idx_rooms_status_access` | rooms(status, access_mode, last_active_at DESC) | 大厅列表翻页 |
| `idx_rooms_owner` | rooms(owner_id, created_at DESC) | 我的房间 |
| `idx_room_players_user` | room_players(user_id, last_seen_at DESC) | 重连反查存档 |
| `idx_room_chunks_updated` | room_chunks(room_id, updated_at DESC) | 增量存盘 |
| `idx_ai_alchemy_recipes_craft_count` | ai_alchemy_recipes(craft_count DESC, created_at DESC) | 全服首合榜 |
| `idx_ai_item_instances_owner` | ai_item_instances(owner_id, slot, equipped DESC) | 取背包 |
| `idx_ai_item_instances_recipe` | ai_item_instances(recipe_hash) | 配方反查产出 |
| `idx_user_sessions_user` | user_sessions(user_id, expires_at DESC) | 会话清理 |
| `idx_room_events_room_tick` | room_events(room_id, tick DESC) | 审计回放 |

`room_chunks` 的主键 `(room_id, chunk_x, chunk_y)` 本身就是聚簇索引,`WITHOUT ROWID` 让 1KB blob 直接落在主键 B 树上,单块读写均为一次 B 树查找。

**视图 / 触发器**

- `v_public_rooms`:大厅列表 + `member_count` 子查询,免去应用层 N+1。
- `trg_rooms_status_change`:房间 `status` 变更时自动写一条 `ROOM_STATUS` 审计流水,保证状态迁移不可静默。

### 3.2 协议状态

```ts
interface PlayerState {
  id: string;                 // u8 长度 + 8 字节
  name: string;               // u8 长度 + 9 字节典型
  level: number;              // u8  1..30
  hp: number;                 // u16
  maxHp: number;              // u16
  x: number; y: number; z: number;  // i32 定点,1/1024 格
  dir: number;                // u8  0..3
  stateFlag: number;          // u8  0..6(BodyState 索引)
  weaponId: number;           // u16 0=空手
  aiWeaponRecipeHash: string; // u8 长度 + 12 字节
  heldItemId: number;         // u16 0=空
  carryingEntityId: string;   // u8 长度 + 8 字节
}
```

`WildlifeState`(9 字段)、`BossState`(10 字段,含预警几何)、`RoomMetaState`(5 字段)结构见 `schema.ts`。

**帧号不放进字段表**:`meta.tick` 每帧都变,若纳入 diff 会让每帧多出一次房间级 upsert(≈28 字节,占稳态带宽四成)。改由报文头 u32 承载,`applyPacket` 无条件覆盖。

---

## 4. 算法与公式

### 4.1 字段级差量编码

```
encodeDelta(prev, next, tick):
  w.write(u8  PROTOCOL_VERSION)
  w.write(u8  prev ? DELTA : FULL)
  w.write(u32 tick)
  removed ← { e ∈ prev 且 e.id ∉ next }          // 野怪/ Boss/ 玩家
  w.write(u16 |removed|); for r in removed: w.write(u8 kind, str id)
  plans ← [ room ] ∪ [ 每个 next 实体 ]
    对每个实体:mask = OR(1 << bit) for 字段 where norm(prev) ≠ norm(next)
  w.write(u16 |plans|)
  for p in plans:
    w.write(u8 kind); w.write(str id); w.write(u32 module.mask)
    for f in p.fields(按 bit 升序): w.write(value_of_f)
```

**归一化比较**是关键:浮点坐标先量化到 `round(v × 1024)`,只有量化后不同的字段才进 mask。这样亚分辨率的浮点抖动(`< 1/1024` 格)不会产生任何报文 —— 测试 C07 覆盖。

复杂度:`O(N × F)`,N = 实体数(≤ 16 + 8 + 1),F = 单表字段数(≤ 14)。16 人满房一帧约 350 次整数比较,耗时可忽略。

### 4.2 带宽模型

单玩家每帧贡献(稳态移动):

```
kind 1 + str(id) 9 + mask 4 + x 4 + y 4 + z 4 + dir 1 + 低频摊薄 2 = 29 字节
```

假设:① 20Hz;② 每帧每个玩家都动(最坏情况;现实约 60~80%);③ 每帧变更字段 = x/y/z/dir;④ hp/stateFlag/weaponId 等低频字段按 1/20 概率触发,摊薄记 2 字节;⑤ 野怪 8 只中 6 只动,每只 42 字节;⑥ Boss 1 只 51 字节;⑦ 房间级 meta 稳态摊薄 2 字节/帧;⑧ 报文头 + 两级计数 10 字节。

| 人数 | 每帧字节 | 单客户端下行(kB/s @20Hz) | 全房广播总出口(kB/s) |
| ---: | ---: | ---: | ---: |
| 4 | 344 | 6.72 | 26.9 |
| 8 | 460 | 8.98 | 71.9 |
| 16 | 692 | 13.52 | 216.3 |

16 人单客户端 13.52 kB/s(约 108 kbps),远低于常见 1Mbps 上行;全房广播 216 kB/s 是服务器出口的主要成本,这也是把帧号移出字段表、把静止帧压到 10 字节的直接收益。

### 4.3 预测与校正

```
predictStep:  p' = p + normalize(input) × BASE_MOVE_SPEED × mul × DT
reconcile:    e = |predicted − authoritative|₂
              e < 0.05          → IGNORE
              0.05 ≤ e < 1.5    → SMOOTH(逻辑位置立即对齐,视觉偏移指数吸收)
              e ≥ 1.5           → SNAP(直接吸附,配合输入重演)
absorb:       k = 1 − 100^(−dt/window)  →  一个 window(0.25s)后残余 < 1%
```

### 4.4 插值

客户端以 `serverTime = clientTime − 0.1s` 在快照序列中采样,二分定位区间后线性插值。超过最新帧时线性外推,**最多 5 帧(0.25s)**,再往后冻结。乱序/重复包按 tick 丢弃;位移 > 8 格视为传送,清空历史避免拉长线。

**抖动度量口径(已裁决,不再改动)**

- `jitterAmplification(lossy, ideal)` = **两条渲染曲线**的二阶差分 RMS 之比。实测 5% 丢包相对无损为 **1.105**(阈值 1.15)。
- 说明:本指标度量**渲染曲线**的抖动,**不与服务端真值比较**;真值偏差由 `maxPositionDrift < 0.05` 单独约束。
- 为什么不与真值比:插值是**分段线性**的,段内二阶差分恒为 0、段边界出现脉冲,而真值是光滑曲线 —— 两者二阶差分量纲不同,比值会被人为放大几十倍(曾实测 55.6,无物理意义)。而玩家看到的是渲染曲线,不是真值曲线:真值再光滑,渲染抖就是感觉抖。

### 4.5 成员在场四态

打盹有**两个阶段**,由 `AFK_TIMEOUT_MS`(30 分钟)分开:

| 在场态 | 占席位 | 计入活跃 | 经验 | Boss 个人掉落归属 | 触发房间休眠 |
| :--- | :---: | :---: | :--- | :---: | :---: |
| `ACTIVE` 清醒 | ✓ | ✓ | 100% | ✓ | ✗ |
| `AFK` 打盹 < 30 分钟 | ✓ | ✗ | `AFK_EXP_RATIO` = 30% | ✓ | ✗ |
| `AFK_EXPIRED` 打盹 ≥ 30 分钟 | ✓ | ✗ | 0%(退出分配) | ✗ | ✗ |
| `OFFLINE` 断线 | ✗ | ✗ | 0% | ✗ | 计入 60 秒计时 |

**超时不 disconnect** 的理由:房间上限只有 4~16 人,若打盹 30 分钟就释放名额,16 人房里有人去吃饭、回来时名额可能已被新人占满,他就回不来了。**占着席位比踢掉更友好**,且房间本身有「60 秒无人在线休眠」兜底,资源不会真的被浪费。

**不取 5 分钟** 的理由:泡杯茶回来发现被踢是体验灾难。而 `AFK_EXP_RATIO = 0.3` **本身**就是防挂机机制(挂机收益只有 30%),不需要再用短超时叠加第二重惩罚。

---

## 5. 参数配表

| 参数 | 值 | 出处 / 理由 |
| :--- | :--- | :--- |
| `PROTOCOL_VERSION` | 1 | 协议 bump 依据 |
| `POS_SCALE` | 1024 | 1/1024 格 ≈ 0.00098,远低于 0.05 格校正阈值 |
| `TICK_HZ` / `DT` | 20 / 0.05s | §2.1 |
| `BASE_MOVE_SPEED` | 4.5 格/秒 | §4.1 |
| `MAX_SPEED_BONUS_MUL` | 2.55 | 249 军鼓 +25% × 601 果茶 +15% × 719/731 移速 +10% × 619 冰面 +40% = 2.21,再留 1.15 余量 |
| `TELEPORT_SLACK` | 1.6 | 单帧位移容差,补偿时钟抖动 |
| `SPEED_WINDOW_TICKS` | 20(1 秒) | 窗口式移速检测 |
| `SPEED_WINDOW_TOLERANCE` | 1.25 | 窗口均速容许超速比例 |
| `BASE_ATTACK_INTERVAL_S` | 0.4s | 711 普攻三连基线 |
| `MAX_ATTACK_SPEED_BONUS` | 1.0 | 最快 0.2s/次 |
| `MAX_ITEM_DELTA_PER_TICK` | 64 | 防一帧刷满背包 |
| `VIOLATION_SCORE_KICK` | 12 | 违规分踢出阈值 |
| `VIOLATION_SCORE_DECAY_PER_TICK` | 0.02 | 防偶发抖动攒成踢出 |
| `RECONCILE_DEADZONE` | 0.05 格 | 1/20 格,静止不抖 |
| `RECONCILE_HARD_SNAP` | 1.5 格 | 超过即吸附 |
| `SMOOTH_WINDOW_S` | 0.25s | 软误差吸收窗口 |
| `INTERP_DELAY_S` | 0.1s | 渲染延迟,吸收抖动与丢包 |
| `SNAPSHOT_BUFFER_S` | 1.0s | 快照历史窗口(21 项 @20Hz) |
| `MAX_EXTRAPOLATE_S` | 0.25s | 外推上限(5 帧) |
| `TELEPORT_DISTANCE` | 8.0 格 | 超过视为传送,清插值历史 |
| `IDLE_SLEEP_MS` | 60_000 | §7.1 无人休眠 |
| `RECONNECT_GRACE_MS` | 30_000 | §7.1 断线重连 |
| `AFK_TIMEOUT_MS` | 30 * 60 * 1000 | 打盹超时(裁决 1)。取 30 分钟:5 分钟太短,而 `AFK_EXP_RATIO=0.3` 已是防挂机机制。超时**不 disconnect**,只退出经验与掉落归属 |
| `EVICT_MS` | 24h | 休眠房回收 |
| `MAX_LEVEL` | 30 | §4.1 |

---

## 6. 性能

**内存**。1GB 约束下的主要占用:

- `room_chunks`:512×512 世界 = 32×32 = 1024 Chunk × 1KB = **1 MB**/房间。若省内存可只载入玩家周围 `chunk_radius=4` 的 9×9 = 81 块(**81 KB**)。
- 快照结构:`RoomState` 本体的玩家数组 16 × ~120B ≈ 2KB;每个客户端持一份上一帧快照(差量 diff 需要),16 人 ≈ 32KB。
- 插值缓冲:每远程实体 21 个样本 × 40B ≈ 840B;16 人 ≈ 13KB。
- 合计算一个 16 人满房 ≈ **150 KB** 常驻,远低于 1GB。

**CPU**。20Hz 下每帧:

- 差量编码:16 人 + 8 野怪 + 1 Boss ≈ 25 个实体 × 14 字段 = 350 次比较 + 约 700 字节写入,估计 **< 0.1ms**。
- 反作弊:每玩家 1 次距离计算 + 1 次窗口路径长度(< 20 项),16 人 ≈ 320 次浮点运算,**< 0.05ms**。
- 落库:每 20 帧(1 秒)一次 `world_tick` 更新;地形按脏块批量事务写入。WAL 下 `synchronous=NORMAL` 单次事务约 0.1~0.5ms。**不能 20Hz 写库** —— 这是把 tick 落盘降频到 1Hz 的原因。

**带宽**。见 §4.2。16 人单客户端 13.52 kB/s;静止帧压到 10 字节,挂机玩家几乎零成本。

**同步通道:单通道(已裁决)**

Colyseus 的 `State` 只作为 **Room 元数据容器**(存 roomId 与成员容器、作自省出口),**不启用 patch 同步**;所有实体同步走 `delta.ts`。

> **`RoomMetaSchema` 不含 `tick`**(2026-11-11 修正)。原先该类多写了一个 `@type('uint32') tick = 0` —— 但 `ROOM_FIELD_TABLE` 是**故意不含 tick** 的(理由见 §4.2「帧号不放进字段表」)。两者不一致会让 `assertFieldTableParity()` 报「RoomMetaSchema 多出字段 tick」,进而让 `assertSchemaReady()` 在生产 `onCreate` 里**直接抛错、服务端起不来**。又因为本层 patch 同步默认关闭,该字段没有任何读取方,故删除,`syncFrom()` 也不再写 `meta.tick`。帧号一律从 delta 报文头取。此缺陷由 `tests/WS-07.test.ts` H 组断言首次运行时捕获。
>
> 同理,`PlayerSchema.name` 原先漏写 `@type`。Colyseus **只同步带 `@type` 的字段**,未标注者会被静默跳过 —— 玩家昵称永远到不了客户端且不报错。H07 断言现在守住这一点:每个字段都必须有注解。

实现开关在 `room.colyseus.ts`:

```ts
export const USE_COLYSEUS_PATCH = false;   // 单通道:自研 delta
// onCreate 中:if (!patchEnabled()) this.patchRate = null;
```

关掉的理由:双通道 = **双倍带宽**,且两套 diff 语义在边界情况(实体瞬间增删、Chunk 版本跳变)会互相覆盖 —— Colyseus 的 patch 与我们的字段级 diff 对「同一帧该发什么」的判断并不等价。

装配代码保留(未物理删除):将来若要 `reconnection` 快照校验、或把 Schema 当作服务端状态自省的可视化出口,可把常量翻回 `true` 并恢复 `patchRate`。

### 6.1 装配层与字段表的等价校验(task-13)

`assertFieldTableParity()` 与 `assertSchemaReady()` 是「两份定义只有一个事实源」的守卫,但此前**零测试驱动**。困难在于:装饰器在 Node strip-only 下是**运行时拒绝**(`.ts`/`.js` 都抛 `Invalid or unexpected token`,而 `node --check` 不报错),且 Colyseus 是未安装的 optionalDependency —— **不能 import 该文件来测**。

做法是**文本解析 + 集合比对**,在 `tests/WS-07.test.ts` H 组(17 条)里独立复现判据:

1. 只认**恰好 2 空格缩进**的 `[@type(...)] name = ...` 行 —— 方法体内赋值缩进更深,自然被排除;
2. 4 个可选捕获组覆盖 `@type` 的 4 种参数形态:`'string'`、`{ map: X }`、`['string']`、构造器引用 `X`;
3. 与 4 张字段表做**集合相等**(不多不少)+ **顺序一致**(bit 升序)+ **类型映射一致**(经 `COLYSEUS_TYPE`);
4. 校验 `assertFieldTableParity` 真的覆盖 4 个类、真的检查「缺字段」与「多字段」两个方向;
5. 校验 `room.colyseus.ts` 的 `onCreate` 里**确实调用**了 `assertSchemaReady()`。

这不是退而求其次:它测的是**源码事实**,恰恰是装饰器版本在测试环境里无法暴露的部分。`assertSchemaReady()` 的实现与生产调用点都**保留**,未删除。

**本组断言首次运行即抓到两个真实缺陷**(已修复,断言保留为回归守卫):

| 缺陷 | 后果 | 为什么原检查抓不住 |
| :--- | :--- | :--- |
| `PlayerSchema.name` 漏写 `@type` | 昵称永远同步不到客户端,**且不报错** | `assertFieldTableParity` 用 `Object.keys(sample)`,只看属性名不看装饰器,未标注的字段仍被算作「已声明」 |
| `RoomMetaSchema.tick` 多出字段 | `assertSchemaReady()` 在生产 `onCreate` **抛错,服务端起不来** | 无测试驱动该函数;且该字段无任何读取方(patch 已关),静态阅读不像有害 |

两者方向相反:一个「少了注解却仍在表内」,一个「多了字段却不在表内」。**只有把源码文本与字段表对账才能同时抓住**。

**故障注入已验证**(11 项,见下表)。每项都确认「预期用例确实变红」且还原后复跑全绿,排除断言假绿:

| 注入 | 预期变红的断言 |
| :--- | :--- |
| 删 `PlayerSchema.hp` | H02 H03 H08 H13 H17 |
| `carryingEntityId` 改名 | H03 H08 H13 H17 |
| 多出未登记字段 `extraField` | H02 H03 H13 H17 |
| 抹掉 `name` 的 `@type` | H02 H07 H08 |
| 给 `RoomMetaSchema` 加回 `tick` | H02 H06 H13 H17 |
| `BossSchema.hp` 类型 `uint32`→`uint16` | H08 |
| `COLYSEUS_TYPE.u32` 漂移 | H09 |
| 删 `onCreate` 里的 `assertSchemaReady()` | H10 |
| 对账漏掉 `RoomMetaSchema` | H12 |
| `assertSchemaReady` 只打印不抛错 | H11 |
| 打乱 `x/y/z` 声明顺序 | H17 |

H15 另用自造假源码验证解析器本身**对偏移敏感**(字段改名后解析结果必须跟着变),防止正则失效导致「两边都空」的假绿。

---

## 7. 异常与边界

| 场景 | 处理 |
| :--- | :--- |
| `tiles_blob` 长度 ≠ 1024 | `assertChunkBlob` 抛错,不静默截断;批写入整批回滚 |
| 字符串 > 255 字节 | `ByteWriter.str` 抛错,不截断(截断会造成 id 碰撞) |
| 报文截断 / 版本不符 / 非法 op | `decodePacket` 抛错,不返回半份状态 |
| 浮点坐标抖动 < 1/1024 | 量化后相同 → 不产生字段变更,不刷帧 |
| 乱序 / 重复快照包 | 按 tick 丢弃(`s.tick <= lastTick` 即弃) |
| 位移 > 8 格(传送) | 清空插值历史,避免插值拉出跨图直线 |
| 丢包超过 0.25s | 外推冻结在最后位置,不无限延伸 |
| 空房间 60 秒 | 自动休眠,状态落库、成员保留、帧号冻结 |
| **打盹玩家**(切后台) | **不算无人,不触发休眠**;仍占席位、仍有实体;未超时吃 `AFK_EXP_RATIO=0.3` 经验 |
| 打盹 ≥ 30 分钟 | 进入 `AFK_EXPIRED`:退出经验分配与个人掉落归属,**但仍占席位、仍 online、不 disconnect** |
| 打盹者断线 | 在场态为 `OFFLINE`(断线优先于打盹),不占席位,计入 60 秒休眠计时 |
| 断线 ≤ 30 秒 | 保留席位与快照,重连返回逐字节一致的快照 |
| 断线 > 30 秒 | 席位回收,重进按新加入处理,原 ADMIN 降为 **GUEST** 必须重授权 |
| 同用户多开 | 第二次 join 被拒(`该用户已在线`) |
| 满员 | 按**在线**人数判定(断线占位不占名额) |
| 房主离开 | OWNER 不移交,最早的在线成员升 ADMIN 代管 |
| 迁移 checksum 漂移 | `migrate` 返回 `drift=true`,生产侧 fail-closed 拒绝启动 |
| 客户端自称超高移速/攻速加成 | 一律钳到 `MAX_SPEED_BONUS_MUL` / `MAX_ATTACK_SPEED_BONUS`,不自证 |
| 物品凭空产出 | 拒因码 `ITEM_FROM_NOTHING`,拒绝时总量不变 |

---

## 8. 与其它子系统的耦合点

| 子系统 | 耦合内容 |
| :--- | :--- |
| **WS-01** 地形 | 消费 `Chunk.serialize()` 的 1024 字节结果写入 `room_chunks.tiles_blob`;Chunk 版本号经 `bumpChunkVersion` 进入房间 meta |
| **WS-02** 物理 | 消费 `BASE_MOVE_SPEED` / `DT` / `BodyState` 做移速校验与 `stateFlag` 索引;预测的 `predictStep` 必须与 `integrateHorizontal` 的速度项保持一致 |
| **WS-03** 建造 | 权限矩阵的 `PLACE_BLOCK` / `BREAK_BLOCK` / `WIRE_EDIT` 位;房间闭合状态影响 `room_chunks` 脏块范围 |
| **WS-04** 生物 AI | `WildlifeState` 的 `fsm` 字段对接 `MobFsmState`;AOI 唤醒决定哪些野怪进入本帧差量 |
| **WS-05** Boss | `BossState` 的阶段/血量/预警几何字段;`bossScaledHp` 决定 `maxHp` |
| **WS-06** 炼金 | `ai_alchemy_recipes` 表与 `craft_count`;`recipeHash()` 作为主键 |
| **WS-08** 电路 | `room_events` 记录电路触发审计;Chunk 版本号随布线变化 |
| **WS-11** 派对 | `RoomMetaState.partyMode/partyTimer/scoreA/scoreB`;`START_PARTY` 权限位 |
| **客户端** | 消费 `delta.ts` 的报文格式、`prediction.ts` 的校正语义;必须用同一份 `FIELD_TABLE` |

---

## 9. 验收用例

`tests/WS-07.test.ts` 共 **115 条**断言,分八组。与文档条例对应:

| 组 | 条数 | 覆盖 |
| :--- | ---: | :--- |
| A. DDL / SQLite | 28 | 表数 9、语句数 ≥25、关键列名、`tiles_blob` 定长 1024、三个指定索引、外键与 ON DELETE、**FOREIGN_KEYS 常量与 DDL 逐条对账**、`migrate` 幂等与漂移、1024 字节 blob round-trip、批事务回滚、CRUD 钳制、级联删除、`craft_count` 累加、条目守恒、审计倒序;**注释切分(A07b)**、**DDL 约束解析无静默漏项(A07c)**、**NOT NULL/CHECK/外键强制(A07d)**、**DEFAULT 补齐(A07e)**、**触发器写审计(A07f)**、**事件主键全表取号且不依赖重试(A07g)** |
| B. Schema 字段表 | 9 | 14 字段齐全、无 bit 冲突、`fullMask`、定点往返误差、`stateFlag` 七态、单实体字节数 62/51/51/33、chunkVersions 确定性、深拷贝、版本单调 |
| C. 差量编码 | 14 | 全量可解码、**字段级 diff(只含 x/y)**、**差量 < 全量 1/10**、round-trip、删除段、静止帧 10 字节、浮点抖动吸收、编码确定性、版本/op 校验、截断抛错、超长字符串拒绝、带宽三档、带宽拆项自洽、chunk 版本差量 |
| D. 预测 / 插值 | 11 | 单帧位移 0.225、冻结态、校正三档、SMOOTH 单调无过冲残余 <1%、输入重演不重复消费、**100ms+5% 丢包误差 < 0.05 格**、**抖动不放大 ≤1.15**、缓冲窗口与精确插值、乱序去重与外推上限与传送清历史、信道确定性、渲染延迟语义 |
| E. 反作弊 | 13 | 阈值引用 4.5/2.55、**坐标跳变被拒**、**移速窗口超速被拒**、合法移速不误判、加成钳制、Z 越界、**攻速被拒**、**无凭证产出被拒**、合法产出通过、四种物品边界、违规累计踢出、分数衰减、全合法零违规 |
| F. 生命周期 / 权限 | 35 | 角色分配、密码房、满员、**60 秒休眠(注入时钟)**、有人不休眠、**打盹≠离线(7 条,含 30 分钟超时后仍占席位、超时不计入活跃、四态判定)**、唤醒接续、休眠零 CPU、**30 秒重连快照逐字节一致**、超期降级 GUEST、超期清理、**权限矩阵拒绝越权**、MEMBER/ADMIN 边界、矩阵完整性、越权无副作用、房主保护、OWNER 移交、派对模式、tick 推进与 1Hz 落盘、Registry 回收、bootstrap、快照落库、状态迁移、反作弊转发、多玩家重连、close、心跳、多开拒绝 |
| G. 端到端 | 6 | 8 人 60 帧快照→差量→重建一致、存档重启读回逐字节一致、16 人稳态带宽、**四类作弊全拒**、休眠唤醒状态不变、满房踢人重连计数 |

**关键断言(与任务书逐条对应)**

1. 表数 = 9,关键列名逐条存在(A02/A04)。
2. chunk blob 1024 字节 round-trip(A12)。
3. 差量只含变化字段:改一格坐标只出 `x`/`y` 两个 bit(C02)。
4. 差量字节 < 全量 1/10(C03)。
5. 16 人帧字节上界:692B,13.52 kB/s(C12)。
6. 插值收敛:100ms + 5% 丢包下最大误差 < 0.05 格(D06)。
7. 预测校正阈值 0.05 / 1.5(D03)。
8. 60 秒休眠触发(F04)。
9. 重连快照一致(F08/F25)。
10. 权限矩阵拒绝越权(F11/F12)。
11. 移速/攻速作弊被拒(E03/E07)。
12. 物品栏守恒(E08–E10)。
13. 打盹不触发休眠(F05b)。
14. 打盹 30 分钟超时后成员仍在 `members`、仍 `connected`、仍占席位(F05e)。
15. 超时成员不计入 `activePlayerCount`,但计入 `seatCount`(F05f)。
16. 四态在场判定(ACTIVE / AFK / AFK_EXPIRED / OFFLINE)完整(F05g)。

---

## 10. 未决

> **⚠️ 反作弊两条安全缺陷(2026-11-11 复核确认)见本节末尾的表格 U1 / U2。**
> 它们已登记进 `verify.ts` 的「信任边界」门禁,不再依赖人工记忆。

| # | 问题 | 现状 | 建议 | 需要谁裁决 |
| :--- | :--- | :--- | :--- | :--- |
| ~~U1~~ | ~~物品栏反作弊判据取自客户端输入~~ | **已解决(CR-14)**:三字段全改由服务端派生(`grantedSourcesFor` / `authoritativeItemTotal` / `carryCapacityOf`),网络层只接受 `ops`。行为级验收:凭空产出→`ITEM_FROM_NOTHING`、超容量→`ITEM_OVERFLOW`、超量扣减→`ITEM_NEGATIVE`(该分支**已可达**)、合法操作放行、凭证不跨 tick。装配层回归 4 用例 / 14 断言 | — | 已关闭 |
| U2 | **移速/攻速上限随客户端声明等比放大** | `anticheat.ts:209/251` 用 `intent.speedMul`、`:292` 用 `claimedAttackSpeedBonus`,**都来自客户端**。可稳定维持 = 基线 × 声明 × 1.25 ⇒ 声明 2.55 时 **约 3 倍(约 3 倍 格/秒,基线 4.5)**,并**绕过装备前置**。⚠️ **修法与 U1 不同**:需服务端知道玩家装备,而 `PlayerState` 目前**只有 `weaponId`、无装备槽** ⇒ 需新增数据结构 | 二选一:①改 `anticheat.ts:146` 的注释(它写「服务端会与服务端自己的账比对」,与本文件 §7「一律钳到上限,不自证」**矛盾**);②真做服务端核算(需加装备槽)。另:`MAX_SPEED_BONUS_MUL` 注释把「移速 +10%」出处写成 `719/731`,手册里 `719` 无移速、`731` 是攻防,真值是 **`729`**(数值 1.10 对,**引用标错**) | Lead |

> 以下 3 项已由 Lead 裁决并落地(2026-11-10),保留记录以便追溯。

1. ~~**「切后台打盹」与「离线」的判定边界**~~ → **已裁决:`AFK_TIMEOUT_MS = 30 分钟`,超时不 disconnect。**
   取值理由:5 分钟太短(泡杯茶回来发现被踢是体验灾难);`AFK_EXP_RATIO=0.3` 本身已是防挂机机制,不必叠加第二重惩罚。
   超时只做两件事:① `afkSinceMs` 保留不重置(人可能还在);② 退出经验分配与 Boss 个人掉落归属。
   **不 disconnect 的理由**:房间上限只有 4~16 人,若超时释放名额,吃饭回来可能回不来 —— 占着席位比踢掉更友好,且 60 秒无人在线休眠已兜底资源。
   实现:`room.ts` 导出 `AFK_TIMEOUT_MS` + `MemberPresence` 四态;WS-10 算经验分配时必须引用同一常量。断言 F05e / F05f / F05g。

2. ~~**`jitterAmplification` 的度量口径**~~ → **已裁决:保留「两条输出曲线二阶差分之比」,不改。**
   理由:和光滑真值比是错的方向 —— 分段线性插值的二阶差分量纲与真值不同,会得到数值漂亮但**更没用**的指标。而玩家看到的是渲染曲线,渲染抖就是感觉抖。
   保留两条断言互补:① 抖动放大比 ≤ 1.15(实测 1.105);② 相对无损最大位置偏差 < 0.05 格(实测 0.0355,从真值角度校验)。

3. ~~**Colyseus 自动 patch 与自研 delta 双通道并存**~~ → **已裁决:关闭 patch,走自研 delta 单通道。**
   实现:`room.colyseus.ts` 导出 `USE_COLYSEUS_PATCH = false`,并在 `onCreate` 里 `this.patchRate = null`(Colyseus 关闭状态自动同步的官方开关)。
   理由:双通道 = 双倍带宽,且两套 diff 语义在边界情况会互相覆盖。
   装配代码**保留不物理删除**:将来若要 `reconnection` 或 Schema 校验可翻回 `true`。

> 以下 5 项仍待裁决。

1. **`access_mode` 是否要第三档「好友可见」**。当前只有 `PUBLIC` / `PASSWORD`(§7.1 原文两档)。若社交系统需要白名单,需要新增 `FRIENDS` 并重审 `rooms` 表的 CHECK 约束。
   > 补注(CR-12):CHECK 约束现在**真的会被强制**了 —— `MemoryDb` 从 DDL 解析 `CHECK (access_mode IN ('PUBLIC','PASSWORD'))`,
     非法值会抛 `CHECK constraint failed`,与真实 SQLite 一致。因此新增 `FRIENDS` 档位时,
     **必须同时改 `schema.sql` 的 CHECK 与两处类型的联合**,否则写入会被拒。这条从「文档提醒」升级成了「运行时会拦」。
2. **`room_events` 的保留策略**。反作弊流水当前无限增长,只做了 `idx_room_events_room_tick`。建议按 `created_at` 保留 7 天并定期 `DELETE`;分区阈值需 Lead 定。
   > 补注(CR-12):清理策略实现时必须注意 `room_events.id` 是**全表**自增主键,
     且 `writeEvent` 用「全表 maxId + 1」取号(取号重试已暴露为 `eventIdRetryCount()`)。
     若将来 `DELETE` 掉尾部行,maxId 会回退,可能与残留行冲突 —— 届时应改为
     数据库侧 `INTEGER PRIMARY KEY` 自增,而不是应用层取号。
3. **物品栏容量的单一事实源**。`statsAtLevel(L).carrySlots = 8 + (L-1)` 来自 `entities.ts`,但反作弊 `checkInventory` 的 `capacity` 由调用方传入。是否应让反作弊直接从冻结核心读?这会影响 `anticheat.ts` 对 `shared/**` 的依赖面。
4. **`ai_item_instances.recipe_hash` 用 SET NULL 是否丢信息**。配方被清后实例失去出处,无法回溯。备选:保留 `recipe_hash` 字符串快照字段(冗余但防丢)。
5. **差量协议的可靠性层**。当前差量是「不可靠有序」假设(每帧独立、丢了就等下一帧)。若要做「关键事件必达」(如 Boss 阶段切换),需要在 delta 之上再叠一个确认重传队列,是新增模块还是并入 `delta.ts` 待定。
6. **`AFK_EXPIRED` 是否应参与派对/竞技模式的计分**。当前只定义了「退出经验与个人掉落」,但大逃杀持冠、涂色计分等玩法里挂机超时者是否仍占一个「计分实体」未定;建议下一轮与 WS-11 一起敲定。
7. **[BLOCKING-候选] 物品栏反作弊的三条判据取自客户端输入**。
   `room.colyseus.ts:174-188` 的 `onMessage('inventory')` 把
   `allowedSources` / `capacity` / `beforeTotal` **三个都取自媒体报文**,传进 `checkInventory`:
   - `allowedSources` 客户端自带 ⇒ `FROM_NOTHING`(凭空产出)**可绕过**;
   - `capacity` 客户端自带 ⇒ `OVERFLOW`(容量溢出)**可绕过**;
   - `beforeTotal = Σ max(0, -delta)` ⇒ 恒有 `after = before + net >= 0` ⇒
     `NEGATIVE` 分支**不可达**(@@重写注:原文此处含实验证据,已移除@@)。
   实质只剩 `BURST`(`MAX_ITEM_DELTA_PER_TICK=64` ⇒ 仅受单帧上限约束,**且无窗口兜底**)与 `FRACTIONAL`。

   铁证是 `:179-180`:`const before = this.runtime.playerState(...); void before;`
   —— **`void` 是刻意抑制未使用警告的写法**,即「权威状态已查到、显式丢弃」,
   属「本打算用、没接上」的痕迹,**不是注释过度承诺**。

   文档口径两处互证支持「这是真缺陷」:`EXTENDING.md:453`「按总量守恒判定」+
   本文件 §7「只校验物品总量守恒」。修法需服务端持有**产出凭证账**与**权威物品总量**
   (`repo.ts:631 totalItemsOf` 已有),属新数据结构 ⇒ **需 CR**。
   ≥ 由 `verify.ts` 的「信任边界」门禁守着(3 处已登记)。
8. **[真缺陷] 移速/攻速上限随客户端声明等比放大**。
   `anticheat.ts:209/251` 的 `intent.speedMul` 与 `:292` 的 `claimedAttackSpeedBonus`
   **都来自客户端**。可稳定维持速度 = 基线 × 声明值 × 1.25 ⇒
   声明 2.55 时 **约 3 倍(约 3 倍 格/秒,基线 4.5)**,且**绕过装备前置**。

   ⚠️ 本条**与第 7 条强度不同**:本文件 §7 已声明
   「客户端自称超高移速/攻速加成 → **一律钳到上限,不自证**」,
   所以「钳到上限」是**已声明设计**(可争),真正的问题是
   **`anticheat.ts:146` 的注释写「服务端会与服务端自己的账比对」—— 与 §7 自相矛盾**。
   二者必须改一个。另:`MAX_SPEED_BONUS_MUL=2.55` 的注释把
   「移速 +10%」的出处写成 `719/731`,而手册里 `719` 无移速、`731` 是攻防,
   真正的是 **`729`** —— 数值 1.10 对得上,**引用标错**。

> **已解决(CR-12,2026-11-11)**:原先隐性存在的两项风险已消除,不再列为未决 ——
> * `driver.sqlite.ts` 的 169 行 SQL 翻译逻辑**从未被执行**过;
>   现由 `node:sqlite`(Node 内置、零依赖)驱动,`verify.ts` 的「真实 SQL 驱动」门禁覆盖
>   DDL/CRUD/触发器/跨房间事件/BLOB/事务/白名单。
> * `MemoryDb`(测试替身)与真实 SQLite 有 **7 项语义分歧**(外键/NOT NULL/CHECK/DEFAULT/触发器);
>   现已从 DDL 解析并强制,10 项对照全部一致,由「双后端语义一致」门禁守着。
>   详见 `CHANGE_REQUESTS.md` CR-12。