# WS-04 野生动物生态与零寻路 AI — 细化设计

> 对应设计手册 §2.1 / §2.2 / §4.2;消费冻结层 `shared/constants/mobs.ts` 的 24 种生物。
> 实现文件:`server/src/mobs/{geometry,aoi,fsm,behaviors,taming,spawner}.ts`;测试:`tests/WS-04.test.ts`(53 条断言)。

---

## 1. 职责边界

**本子系统负责**

- 野生生物的**存活模拟**:领域兴趣(AOI)唤醒与休眠、三态有限状态机、45° 偏转避障;
- 24 种生物的**独特行为分支**:每一条 `MobDef.note` 原文都落地为一个可断言的布尔/数值分支;
- 生物与沙盒的**交互收口**:道具交互(`onInteract`)、伤害结算(`onDamage`)、地形改写;
- **驯养链路**:喂食 → 驯化 → 跟随/留守/背物资三指令 → 牧场自动产出 → 出战上限;
- **生态刷新**:群系密度与上限、光照抑制(309 夜路砖 / 522 路灯)、城镇安全区护盾。

**明确不负责**

- 玩家角色物理与背包(`WS-01`/`WS-02`);本模块只读取玩家位置、朝向、手持物、穿戴列表;
- 物品配表的**数值本体**——320 项 ID 一律引用 `shared/constants/items.ts`,不新增、不改号;
- Boss 战阶段与破防(`WS-05`,见 `docs/WS-05-boss-raid.md`);
- 网络同步与房间生命周期:本模块是纯逻辑层,顶层不产生任何副作用;
- 渲染与音效:只通过 `MobWorld.emit(kind, payload)` 抛出事件名,由表现层订阅。

---

## 2. 上游 / 下游接口

**上游(引用冻结层符号,只读)**

| 来源 | 引用符号 | 用途 |
| :--- | :--- | :--- |
| `shared/types/entities.ts` | `MobDef` `MobBehavior` `MobFsmState` `Biome` `BIOME_LABEL` | 生物定义、行为七类、三态枚举、群系 |
| `shared/constants/mobs.ts` | `MOB_LIST` `MOB_BY_ID` `mobsByBiome()` `hostileMobs()` `tameableMobs()` | 24 条配表与派生清单 |
| `shared/types/physics.ts` | `DT` `TICK_HZ` `BASE_MOVE_SPEED` `RADIUS_WILD` `integrateHorizontal` | 20Hz 帧、移速、碰撞半径 |
| `shared/types/tile.ts` | `CHUNK_SIZE=16` `packTile` `unpackTile` `metaState` `faceDir` | 区块键、地形格读写 |
| `shared/constants/items.ts` | 309 / 315 / 318 / 322 / 324 / 522 / 628 | 光照抑制、摩擦、宠物上限 |
| `shared/testing/harness.ts` | `test` `ok` `eq` `near` `inRange` `mulberry32` | 测试桩与确定性随机 |

**下游(本模块对外输出)**

| 输出 | 结构 | 消费方 |
| :--- | :--- | :--- |
| `AoiManager.activeMobs` | `Set<string>` | 主循环:`stepActive` 只遍历该集合 |
| `MobFsm.tick()` | `WarnGeom \| null` | 战斗系统:非 null 表示本帧结算一次区域伤害 |
| `BaseMobAi.onDamage()` | `DamageResult` | 伤害管线:读取 `hpLoss` / `blockedRatio` / `reflectHearts` |
| `MobSpawner` | `SpawnerState` | 生态刷新器 |
| `tickRanch()` | `RanchYield[]` | 牧场产出结算 |

---

## 3. 数据结构

```ts
/** 五类预警几何的统一载体(与 WS-05 共用,定义在 mobs/geometry.ts)。 */
interface WarnGeom {
  kind: 'CIRCLE' | 'SECTOR' | 'RECT' | 'RING' | 'POINTER';
  cx: number; cy: number;            // 格,几何中心
  radius: number;                    // 格,CIRCLE/SECTOR 半径,RING 外径,POINTER 长
  innerRadius: number;               // 格,仅 RING 用(环内径)
  centerDeg: number;                 // 度,轴向/起始角
  halfDeg: number;                   // 度,仅 SECTOR(半张角,0<halfDeg<180)
  halfLen: number; halfWidth: number; // 格,RECT/POINTER 半长轴与半宽
  spinDegPerSec: number;             // 度/秒,仅 POINTER 顺时针角速度
  z: number; zTolerance: number;     // 格,垂直层判定
  warnSec: number;                   // 秒,预警时长
}

/** AOI 玩家记录。afk=true 的玩家不提供唤醒能量。 */
interface AoiPlayer { id: string; x: number; y: number; afk: boolean; }

/** AOI 生物记录(chunkKey 用于 O(1) 跨块迁移)。 */
interface AoiMobRecord { id: string; x: number; y: number; chunkKey: string; }

/** 伤害结算结果。 */
interface DamageResult {
  hpLoss: number;          // 实际扣除血量
  blocked: boolean;        // 是否完全格挡
  blockedRatio: number;    // [0,1] 减伤比例
  reflectHearts: number;   // 卡皮巴拉反弹爱心数
  events: string[];        // 事件名(供表现层与断言)
}

/** 生物运行时状态槽。mem 为按需扩展的数值字典,避免为 24 种各建一个类。 */
interface MobRuntime {
  id: string; def: MobDef;
  x: number; y: number; z: number;   // 格
  hp: number; maxHp: number;
  facingDeg: number;                 // 度,[0,360)
  mem: Record<string, number>;       // AI 独立状态槽
  fsm: MobFsm;
  alive: boolean;
  warns: WarnGeom[];
  anchorX: number; anchorY: number;  // 地形锚点(祭坛/出生点)
}

/** 驯养记录。 */
interface PetRecord {
  mobId: string; name: string;
  stage: 'WILD' | 'FED' | 'TAMED';
  fedCount: number; requiredFeeds: number;
  command: 'FOLLOW' | 'STAY' | 'CARRY';
  saddle: boolean; inRanch: boolean; carryLoad: number; deployed: boolean;
  lastProduceAt: number;             // 秒,牧场产出计时
}
```

---

## 4. 算法与公式

### 4.1 AOI 唤醒 / 休眠(复杂度 O(P·C + Σ|bucket|))

```
update():
  visited ← ∅; scannedChunks ← 0
  for each 非挂机玩家 p:
      c0x..c1x = floor((p.x ± 32) / 16)      # 每轴 5 块
      c0y..c1y = floor((p.y ± 32) / 16)
      for each 区块 (cx, cy) in 包围盒:
          visited ← visited ∪ {(cx,cy)} ∪ {所有该块内的 mobId}
  candidates ← visited 中的 mobId ∪ 当前 activeMobs     # 后者用于检测「出圈」
  for each mob in candidates:
      d2 = (mob.x - p.x)² + (mob.y - p.y)²
      inside = ∃p : d2 ≤ (32 × (1 + 1e-9))²             # 逐怪精确判定
      inside → activeMobs.add(id) ; else activeMobs.delete(id)
```

**关键不变量**:唤醒判定是**逐怪**的,不是「整块唤醒」。同区块内距玩家 31 格与 45 格的两只怪,前者唤醒、后者休眠(`W4-06` 用该反例锁死)。

休眠后的零开销是**结构性**的:`stepActive(fn)` 只遍历 `activeMobs`,`dormantStepCalls` 永不增长。测试用「100 帧后 `activeStepCalls` 完全不变」+「回调里抛异常也永不触发」双重锁定。

### 4.2 45° 三向探针避障(固定 3 次数组读)

```
steer45(dir, x, y, probe):
  u   ← unit(dir);  θ ← atan2(u.y, u.x)
  forward ← probe(x + cos θ   · 1.0, y + sin θ   · 1.0)      # 读 1
  left    ← probe(x + cos(θ-45°) · 1.0, y + sin(θ-45°) · 1.0) # 读 2
  right   ← probe(x + cos(θ+45°) · 1.0, y + sin(θ+45°) · 1.0) # 读 3
  if ¬forward            → (u, turn=0)
  elif ¬left             → (dir(θ-45°), turn=-1)   # 左撇优先,行为确定可复现
  elif ¬right            → (dir(θ+45°), turn=+1)
  else                   → (-u, turn=0)            # 全堵原路折返,仍只读 3 次
  return { dir, turn, reads: 3 }
```

**零寻路证明**:任意地形下读取次数恒为 3,不递归展开、不建导航网格、不做 A\*。这是「零寻路 AI」的核心论据。

### 4.3 三态 FSM

| 状态 | 进入条件 | 每帧行为 | 退出条件 |
| :--- | :--- | :--- | :--- |
| `IDLE_GRAZE` | 初始 / 脱战 | 朝出生点 4 格内的随机点慢走(0.4× 基速);计时 3~5s 后重选点 | 玩家进入 `aggroRadius` |
| `ALERT_FLEE_OR_CHASE` | 感知到玩家 | `steer45` 追击(或受惊逃跑 = 方向取反);距离 ≤ `attackRadius` 且 `attackCd≤0` → 起手 | 距离 > 24 格 → 回 IDLE |
| `TELEGRAPH_ATTACK` | 起手 | 倒计时 `warnSec`;**到期当帧返回几何并置 `attackCd = 1.2`** | 结算后回 ALERT |

**「预警—结算」严格 1:1**:结算瞬间置 `attackCd=1.2s`,`beginTelegraph` 额外要求 `attackCd≤0`,因此同帧不可能二次起手、也不会漏结算。

### 4.4 五类几何的精确点在几何内判定

统一采用**相对容差** `GEOM_EPS = 1e-12`(双精度累积误差 ~1e-16 的 1e4 倍,远小于题目要求的 1e-9 步长),因此「恰好落在边界」判 `true`、「差 1e-9」判 `false`。

| 几何 | 判定式 | 边界语义 |
| :--- | :--- | :--- |
| `CIRCLE` | `d² ≤ (r(1+ε))²` | 恰好 r → true;r+1e-9 → false |
| `RING` | `r_in²(1-ε)² ≤ d² ≤ r_out²(1+ε)²` | 内径 -1e-9 → false;外径 +1e-9 → false |
| `SECTOR` | `d² ≤ r²` 且 `(d̂·â) ≥ cos(halfDeg) - ε` | 用**点积法**免 atan2,射线边界无反代误差 |
| `RECT` | 旋转到局部系后 `\|lx\| ≤ hL(1+ε)` 且 `\|ly\| ≤ hW(1+ε)` | 长轴/短轴双边界各自精确 |
| `POINTER` | 同上,但 `a = centerDeg + spin·t`,且 `lx ≥ -hL·ε` 只朝正向延伸 | t=0 末端 +1e-9 → false;负向永不命中 |

**Z 层判定**:`|pz - g.z| ≤ zTolerance(1+ε)`,支持云鲸 P2 的 Z=2 高空吐息。

### 4.5 24 种生物的分支算法(摘录核心 12 条)

| 生物 | 算法要点 | 可断言不变量 |
| :--- | :--- | :--- |
| 野猪 | 蓄力 1.0s(20 tick 原地不动)→ 锁定朝向沿直线以 11 格/秒冲 6 格 | `travel ∈ [6, 6.6]`;`probe` 命中 → `selfStun = 3.0s` |
| 卡皮巴拉 | 攻防全免 + 爱心反弹 | `hpLoss === 0` 恒成立;`reflectHearts === 1`/次;100 次攻击后仍满血 |
| 狸猫 | 伪装 `LANTERN`,玩家 ≤2 格现形 | 距离 2.0 → `disguise=0`,≤1e-6 之内仍伪装 |
| 剑客傀儡 | 朝向 ±60° 内格挡 100% | 恰好 60° 格挡;60°+1e-6 破防;背后 ×1.25 背刺 |
| 音波蝠 | 俯冲发环形音波;三角铁 253 / 音符砖 419 干扰 | 干扰后 `fallSec=4.0` 且坠地期间 `ringCount` 冻结 |
| 紫晶甲虫 | 正面 ±75° 内减伤 80% | 正面 100 → 吃 20;爆破(EXPLOSION)一击碎壳使 `frontDr=0`;掀翻肚皮 ×2 |
| 姜饼小人 | 10 秒逃逸计时 + 边跑边掉糖 | 逃逸精确落在第 200 tick;钩爪把计时 +3s |
| 巧克力盾卫 | 火属性触发融化 + 改写 3×3 地形 | 融化后 `armor=0`、`floors.size===9`;非火焰吃 30% |
| 竖琴风精鸟 | 悬崖边 70° 扇形风压;乐器合奏 5s 赠碎 | `halfDeg===35`;合奏累加不重置;非乐器不累加 |
| 火灵 | 每 0.5s 把脚下 3×3 改写成火炭砖;遇水固化 | 水属性 → 原地生成 `OBSIDIAN_BLOCK(110)` 且转免疫 |
| 发条重骑 | 正面减伤 90%;背后钩爪拔钥匙 | 正面钩 false / 背后钩 true → `paralyzedSec=8.0` |
| 雷云闪电球 | 链接 3 个金属物;引雷头盔吸收转攻速 | `helmAbsorbs` **裸累加**;`helmBuffStacks = min(5, absorbs)` |

其余 12 种(绵羊 / 果冻怪 / 花栗鼠 / 河狸 / 河蟹 / 萤火蛙 / 陆行鸟 / 穿山甲 / 毒尾蝎 / 布丁法师 / 云魔鬼鱼 / 伪装宝箱)同样各有独立分支,见 `behaviors.ts` 与 `W4-23`~`W4-41`。

### 4.6 驯养与牧场

```
feedPet(pet, item):
  if item ≠ def.tameItem → { ok:false, reason:'wrong_item' }   # 计数不增长
  pet.fedCount += 1
  if fedCount ≥ requiredFeeds → stage = TAMED,回赠 drops 首项

部署上限: deployLimit(wearing) = wearing ⊇ {628} ? 2 : 1
牧场产出: 每 RANCH_PRODUCE_SEC(600s) 每只圈养生物产 1 份;
          同类 ≥3 只额外 +1(群体加成)
```

### 4.7 刷怪决策(短路顺序:廉价优先)

```
decideSpawn(ctx, world, roll):
  1. globalCount ≥ 200          → GLOBAL_CAP
  2. 距城镇中心 ≤ 24 格          → SAFE_ZONE
  3. biomeCount ≥ hardCap        → HARD_CAP
  4. biomeCount ≥ softCap 且 roll<0.5 → SOFT_DAMPED
  5. blocked(x,y)                → OBSTRUCTED
  6. 光照抑制(最贵,放最后)    → NIGHT_BRICK / STREET_LAMP
  7. 夜行怪且白天                → DAYLIGHT
  else                           → 放行
```

---

## 5. 参数配表

| 参数 | 值 | 单位 | 出处 |
| :--- | :--- | :--- | :--- |
| `AOI_WAKE_DISTANCE` | 32 | 格 | 任务书 §WS-04 AOI 契约 |
| `AOI_EPS` | 1e-9 | — | 边界判定容差 |
| `GEOM_EPS` | 1e-12 | — | 几何相对容差 |
| `CHUNK_SIZE` | 16 | 格 | 冻结 `shared/types/tile.ts` |
| `GRAZE_SEC_MIN/MAX` | 3 / 5 | 秒 | 任务书:闲逛 3~5 秒 |
| `GRAZE_RADIUS` | 4 | 格 | 任务书:出生点 4 格内 |
| `GRAZE_SPEED_MUL` | 0.4 | × | `BASE_MOVE_SPEED × 0.4 = 1.8` 格/秒 |
| `CHASE_SPEED_MUL` | 1.0 | × | 冻结 `BASE_MOVE_SPEED = 4.5` |
| `PROBE_LEN` / `AVOID_ANGLE_DEG` | 1.0 / 45 | 格 / 度 | 任务书:三次数组读取、左右偏 45° |
| `PROBE_READS_PER_STEP` | 3 | 次 | 零寻路证明的硬上界 |
| `TELEGRAPH_SEC_MIN/MAX` | 0.8 / 1.5 | 秒 | 任务书:红圈 0.8~1.5s |
| `ATTACK_COOLDOWN_SEC` | 1.2 | 秒 | 本设计:保证预警-结算 1:1 |
| `DISENGAGE_DISTANCE` | 24 | 格 | 与冻结 `SHARE_EXP_RADIUS` 对齐 |
| `BOAR_WINDUP_SEC` | 1.0 | 秒 | 生物配表野猪 note 原文 |
| `BOAR_CHARGE_TILES` | 6 | 格 | 同上「冲锋 6 格」 |
| `BOAR_CHARGE_SPEED` | 11.0 | 格/秒 | 6 格 / ~0.55s |
| `BOAR_SELF_STUN_SEC` | 3.0 | 秒 | 同上「撞晕 3 秒」 |
| `BAT_FALL_SEC` | 4.0 | 秒 | 同上「坠地」 |
| `BEETLE_FRONT_DR` | 0.80 | — | 同上「免疫 80%」 |
| `BEETLE_FLIP_SEC` | 6.0 | 秒 | 本设计:掀翻暴打窗口 |
| `SAMURAI_FRONT_ARC_DEG` | 120 | 度 | 同上「正面格挡」 |
| `CAPYBARA_REFLECT_HEARTS` | 1 | 颗 | 同上「反弹爱心」 |
| `CHOCO_ARMOR` / `CHOCO_MELT_FLOOR` | 0.70 / 9 | — | 9 为 `BaseFluid.CHOCO` |
| `TANUKI_REVEAL_DISTANCE` | 2 | 格 | 同上「进入 2 格」 |
| `GINGER_ESCAPE_SEC` | 10.0 | 秒 | 同上「10 秒逃逸」 |
| `KNIGHT_FRONT_DR` | 0.90 | — | 同上「正面极难击败」 |
| `KNIGHT_PARALYZE_SEC` | 8.0 | 秒 | 本设计:瘫痪窗口 |
| `LAVA_BURN_RADIUS` | 1 | 格 | 3×3 焦炭改写 |
| `THUNDER_HELM_STACK_MAX` | 5 | 层 | 本设计:攻速层数上限 |
| `HARPY_ENSEMBLE_SEC` | 5.0 | 秒 | 本设计:合奏触发时长 |
| `RANCH_PRODUCE_SEC` | 600 | 秒 | 本设计:1 游戏日产出一份 |
| `DEPLOY_LIMIT_BASE/BADGE` | 1 / 2 | 只 | 物品 628 note 原文 |
| `NIGHT_BRICK_ID` | 309 | ID | 物品表 309 note:「阻止敌对野怪在上面刷新」 |
| `STREET_LAMP_RADIUS` | 5 | 格 | 物品表 522 note:「半径 5 格」 |
| `TOWN_SAFE_RADIUS` | 24 | 格 | 本设计:城镇安全区 |
| `GLOBAL_MOB_CAP` | 200 | 只 | 任务书:200 只野生怪上界 |
| `RANCH_CAPACITY` | 24 | 只 | 本设计:牧场容量 |

群系刷新密度(`BIOME_SPAWN`):`perChunk` 0.5(云海)~1.4(遗迹);`hardCap` 9~18。

---

## 6. 帧预算 / 性能

### 6.1 目标场景:200 只野生怪,其中 30 只被唤醒

| 阶段 | 单次成本 | 20Hz 每帧次数 | 每帧小计 |
| :--- | :--- | :--- | :--- |
| AOI 区块哈希查找 | ~40 ns | 25(单玩家覆盖上界) | 1.0 µs |
| AOI 逐怪精确距离判定 | ~8 ns | 30 | 0.24 µs |
| FSM steering(3 次数组读 + sin/cos) | ~24 ns | 30 | 0.72 µs |
| 位置积分与写回 | ~15 ns | 30 | 0.45 µs |
| 24 种 AI 特有分支 | ~30 ns | 30 | 0.90 µs |
| **合计** | | | **≈ 3.3 µs / 帧** |

单帧预算 = 1000 / 20 = **50 ms**,占用 **0.0066%**。8 人同屏时 AOI 查找升到 200 块(去重后 ~60 块)→ 约 5.5 µs/帧,仍 < 0.02%。

### 6.2 休眠怪零开销论证

- **结构上**:休眠生物不在 `activeMobs` 集合里,`stepActive` 的 `for` 循环不会访问其 `MobRuntime`,因此 `totalActiveTicks` 不增长;
- **可测性**:`W4-07` 构造 200 只(30 只近、170 只远),断言 `activeMobs.size === 30`,随后跑 100 帧并断言 `totalActiveTicks` 恰好 +3000;再断言全部休眠后回调**抛异常也永不触发**;
- **内存上界**:每只 `AoiMobRecord` ≈ 80 B + `Map` 条目 ≈ 48 B;200 只 ≈ 26 KB;`chunks` 索引 ≤ 200 个 Set 头(144 B)≈ 29 KB → AOI 总占用 < 64 KB。1 GB 内存约束下可忽略。

### 6.3 实测

`W4-15` 用 `process.hrtime.bigint()` 实测 `steer45` 20000 次:断言单次 **< 10 µs**(实测约 0.1~0.3 µs,远低于任务书要求的 0.01 ms 量级);`estimateFsmCostUs(30) < 10`。

---

## 7. 异常与边界

| 场景 | 处理 |
| :--- | :--- |
| 空玩家列表 | `update()` 将所有唤醒生物休眠;`isInsideAoi` 返回 false |
| 全部玩家挂机 | `setPlayers` 过滤掉 `afk` 后等价于空列表 → 全体休眠 |
| 恰好 32.000000000 格 | 判为圈**内**(`AOI_EPS=1e-9`);32+1e-6 判圈外 |
| 负数坐标 / 跨负区块 | `chunkKeyOf(-1,-1) === '-1,-1'`,`Math.floor` 保证不塌缩 |
| 生物跨区块移动 | `moveMob` 先删旧桶再插新桶,`mobCount` 不变(无重复计数) |
| 生物被注销但仍在唤醒集 | `update()` 中显式 `activeMobs.delete(id)` 并计入 `slept` |
| 三向全堵 | 原路折返,读取次数仍为 3,不递归、不死循环 |
| 无目标(null) | FSM 回 `IDLE_GRAZE`;各 AI 的 `nearest()` 返回 null 时提前 return |
| 零向量方向 | `unit()` 回退 `(0,1)`,不产生 NaN |
| 血量归零 | `alive=false`,AI 不再产出预警几何 |
| 卡皮巴拉血量 | `onDamage` 强制 `hp = def.hp`,任何输入都不下滑 |
| 喂食超上限 | `fedCount` 达 `requiredFeeds` 后 `stage=TAMED`,再喂返回 `already_tamed` 且不重复发奖 |
| 牧场满员 | `RANCH_CAPACITY=24`,超出返回 false |
| 浮点预警边界 | 相对容差 1e-12;「恰好边界」true、「差 1e-9」false,两者各有断言 |
| 网络抖动 / 断线重连 | 本模块无网络状态;重连后由 `registerMob` + `setPlayers` 重建 AOI,幂等 |
| 同帧多次伤害 | `TelegraphState.fired` 单次闸门 + `attackCd` 后摇,双重防重 |

---

## 8. 与其它子系统的耦合点

| 对接方 | 耦合内容 | 方向 |
| :--- | :--- | :--- |
| **WS-01 世界与地形** | `probe(x,y)` 阻挡查询、`setFloor` / `placeObj` 地形改写、`CHUNK_SIZE` 区块 | 本模块 → WS-01 |
| **WS-02 玩家与背包** | `WorldPlayer`(位置/朝向/手持物/穿戴/是否演奏)、喂食物品从背包扣除 | WS-02 → 本模块 |
| **WS-03 物品与合成** | 全部物品 ID 引用 `shared/constants/items.ts`,尤其 309/315/318/522/628 | 双向(只读引用) |
| **WS-05 Boss 战** | 共用 `WarnGeom` 五类几何内核与 `insideWarn*` 判定;`docs/WS-05-boss-raid.md` | 本模块 → WS-05 |
| **WS-06 战斗与伤害管线** | 调用 `onDamage(rt, world, amount, kind, fromDeg)`,消费 `DamageResult` | WS-06 ↔ 本模块 |
| **WS-07 牧场与建筑** | `tickRanch` 产出、`ROOM_RECIPES.ECO_RANCH`(529)识别 | 本模块 ↔ WS-07 |
| **WS-08 网络同步** | `activeMobs` 集合决定哪些生物需要下发快照;休眠生物**零带宽** | 本模块 → WS-08 |
| **WS-09 表现层** | `emit(kind, payload)` 事件名(如 `boar_wall_stun`)驱动特效/音效 | 本模块 → WS-09 |
| **WS-10 成就与统计** | `events[]`(如 `choco_melted`)作为成就触发条件 | 本模块 → WS-10 |

---

## 9. 验收用例

`tests/WS-04.test.ts` 共 **53 条断言**,全部通过。与任务书验收条目一一对应:

| # | 断言 | 用例编号 |
| :--- | :--- | :--- |
| 1 | 24 种生物全部有专属 AI(无回退实现) | `W4-01` |
| 2 | 敌对判定与 `hostileMobs()` 冻结函数一致 | `W4-02` |
| 3 | **AOI 边界:恰好 32 格内唤醒、32+1e-6 不唤醒** | `W4-03` |
| 4 | 挂机玩家不提供唤醒能量 | `W4-04` |
| 5 | `activeMobs` 集合进出:进入唤醒、离开立即休眠 | `W4-05` |
| 6 | **同区块逐怪过滤:31 格唤醒 / 45 格休眠** | `W4-06` |
| 7 | **离开 AOI 后 0 CPU:100 帧调用计数完全冻结** | `W4-07` |
| 8 | 区块键与跨块迁移不重复计数 | `W4-08` |
| 9 | AOI 每帧扫描成本模型 < 50 µs | `W4-09` |
| 10 | **45° 避障:直行优先且恒 3 次数组读** | `W4-10` |
| 11 | 前堵 → 左偏 45°(精确 -45°) | `W4-11` |
| 12 | 左前堵 → 右偏 45°(精确 +45°) | `W4-12` |
| 13 | 三向全堵 → 折返且仍只读 3 次 | `W4-13` |
| 14 | FSM 三态串联 + 预警结算严格 1:1 | `W4-14` |
| 15 | 闲逛点 500 次采样恒在出生点 4 格内 | `W4-15` |
| 16 | 单怪单帧 steering < 0.01 ms(实测) | `W4-16` |
| 17-22 | **五类几何边界:恰好边上 / 差 1e-9,逐类各 6+ 条** | `W4-17`~`W4-22` |
| 23 | 预警圆内/外伤害结算 | `W4-23` |
| 24 | **野猪:蓄力 1s → 冲 6 格 → 撞墙自晕 3s** | `W4-24` |
| 25 | **卡皮巴拉:反弹爱心不损血(100 次攻击仍满血)** | `W4-25` |
| 26 | 狸猫伪装石灯笼直到 2 格 | `W4-26` |
| 27 | 剑客傀儡:正面 100% 格挡 / 背后 ×1.25 / 火椒箭点燃 | `W4-27` |
| 28 | 音波蝠:三角铁干扰后坠地 4 秒 | `W4-28` |
| 29 | 紫晶甲虫:正面减伤 80% / 碎壳 / 肚皮 ×2 | `W4-29` |
| 30 | 姜饼小人 10 秒逃逸(精确第 200 tick)+ 钩回 | `W4-30` |
| 31 | 巧克力盾卫遇火融化 + 9 格地形改写 | `W4-31` |
| 32 | 竖琴风精鸟:扇形风压 + 合奏送星辰碎片 | `W4-32` |
| 33 | 火灵:遇水固化黑曜石 + 焦炭改写 | `W4-33` |
| 34 | 发条重骑:背后钥匙被钩爪拔下后瘫痪 8s | `W4-34` |
| 35 | 河狸偷木板筑坝 + 大锤敲晕夺回 | `W4-35` |
| 36 | **雷霆球对引雷头盔反哺攻速(层数封顶 5)** | `W4-36` |
| 37-41 | 其余生物分支(绵羊/果冻怪/花栗鼠/河蟹/萤火蛙/云魔鬼鱼等) | `W4-37`~`W4-41` |
| 42-46 | 驯养流程 / 边界 / **出战上限 628 解锁第二只** / 牧场产出 / 背物资 | `W4-42`~`W4-46` |
| 47-51 | **309 夜路砖抑制 / 522 路灯 5 格抑制 / 安全区护盾 / 上限 / 配置覆盖** | `W4-47`~`W4-51` |
| 52-53 | **性能:200 只怪 30 只唤醒的每帧估算 + 休眠 170 只零开销** | `W4-52`~`W4-49c` |

### 9.1 安全区护盾三行表(Lead 裁决 3 兜底,`W4-49c`)

| # | 情形 | 规则 | 实现 | 断言 |
| :--- | :--- | :--- | :--- | :--- |
| 一 | 祭坛在安全区内 | 召唤失败 `SAFE_ZONE` | `raid.ts#summonBoss` 复用 `isInsideSafeRadius` | `W5-02b`(6 条) |
| 二 | **Boss 被拉进安全区** | **不受保护**,吃满伤害 | `applySafeZoneShield(..., isBoss=true)` 显式短路 | **`W4-49c`**(4 条) |
| 三 | 玩家在安全区内 | 全额吸收 | `applySafeZoneShield(..., isBoss=false)` | `W4-49` + `W4-49c` |

`W4-49c` 的关键断言:

```ts
applySafeZoneShield(world,   5,   5, 100, false) === 0    // 区内玩家全额吸收
applySafeZoneShield(world, 100, 100, 100, false) === 100  // 区外玩家不吸收
applySafeZoneShield(world,   5,   5, 100, true)  === 100  // ← 区内 Boss 吃满伤害(最重要)
applySafeZoneShield.length === 5                          // 元数锁定,禁止默认值
```

**为什么元数也要断言**:`SAFE_SHIELD_MULT = 1.0` ⇒ `incoming × (1−1.0) = 0`。
若有人给 `isBoss` 加个 `= false` 默认值「让调用更省事」,Boss 便**静默获得无敌**
(不抛异常、数值静默变 0)。`fn.length === 5` 把这条退化路径堵死,使约束落在**签名层面**
而非调用约定。

### 9.2 断言必须能区分实现(Lead 确认的两点方法论)

这两条比抽象原则更有指导性,记为后续写手的具体范例。

**(1) 反例构造要能区分两种实现**

`W4-06` 的演进过程值得记录:

| 版本 | 用例 | 问题 |
| :--- | :--- | :--- |
| ❌ 原始 | 200 只怪「散布在各处」,断言「部分唤醒」 | 这是**能通过的测试**,不是**能抓住 bug 的测试**——「整块唤醒」的错误实现同样能通过,因为怪恰好都在 32 格内 |
| ✅ 改后 | **同一区块键 `0,0`** 内放两只怪,玩家在 **(-30,0)**:距 31 格者唤醒、距 45 格者休眠,断言 `activeMobs.size === 1` | 「整块唤醒」的实现会唤醒 2 只,断言立刻失败 —— 这才**区分了两种实现** |

同思路的 `W4-52`:170 只远处 + 2 只 32 格内,断言恰唤醒 2 只、100 帧 × 2 = 200 次调用、
其余 198 只零开销。

**(2) 修测试失败时要看相邻逻辑,不只为变绿而停手**

修「竖琴合奏」失败时,顺带发现**风压扇形轴角 +180° 反了** —— 把玩家往生物方向吹,
而不是吹落悬崖。该 bug 与测试失败**不是同一件事**:只调断言让其变绿,这个方向性真 bug
会一直留到联调。同理,FSM 缺攻击后摇闸门(加 `ATTACK_COOLDOWN_SEC=1.2` 达成「预警—结算」
严格 1:1)与时间护盾窗口被切阶段吞掉 1 帧,都是**实现缺陷**而非测试问题。

验证命令:`node scripts/verify.ts --only WS-04`。

---

## 10. 未决问题

1. **唤醒半径是否随群系变化**:当前统一 32 格。云海为浮空岛,生物密度低,可考虑放宽到 48 格以免「跳岛即空」。留待 Lead 裁决是否需要按群系配置。
2. **`attackCd` 后摇时长**:当前硬编码 1.2s。高速怪(遗迹区)可能希望 0.8s、重型怪 2.0s。建议后续挪到 `MobDef` 扩展字段,但会**改动冻结层**,需走 `docs/CHANGE_REQUESTS.md`。
3. **`mem` 字典的持久化**:休眠生物的 `mem` 目前不落盘,重连/换区后 AI 状态重置(如姜饼小人的逃逸计时归零)。是否需要序列化到存档? —— **部分解决(task-17 通道 + task-21 闭环,详见下)**:序列化通道、db 层读写(`rooms.mob_mem_json`)与房间 `step()` 每 20 帧落盘均已接通并有真实 DB 往返测试;仅剩生产装配未挂 `worldSaveHost`,故线上重启后**仍会丢失**。

### 10.1 `mem` 持久化:原描述准确,通道 + 落盘闭环已补(task-17 / task-21 §430)

**核查结论:该条目原描述属实。** task-17 补上序列化通道,task-21 补上 db 层与房间生命周期接线;**但生产装配尚未挂载**,故「重启后丢失」这一现象**在线上仍然存在**。

**实测证据**(修复前):
| 步骤 | `mem` 内容 |
| :--- | :--- |
| 新生物初始 | `{}` |
| 写入 `escapeTimer=7.5 / friendly=1 / fedCount=3` | `{"escapeTimer":7.5,"friendly":1,"fedCount":3}` |
| **同一宿主**内同 ID 重新登记 | 保留(无丢失) |
| **新建宿主**(重启/换区/重连)后同 ID 登记 | **`{}`(全部丢失)** |

根因:`host.ts:251` 的 `mem: existed?.rt.mem ?? {}` —— `existed` 只在**同一个宿主的 Map** 里查,新宿主必然查不到。且全仓检索确认宿主**没有**任何导出/导入 API(`exportMobs` / `serializeMob` / `saveMobs` 等全部 `undefined`)。

**已修**(task-17:`server/src/mobs/host.ts` + `server/src/sim/world_sim.ts`;task-21:加 db 层与房间接线):

| 接口 | 位置 | 语义 |
| :--- | :--- | :--- |
| `MobHost.exportMem()` | `host.ts:536` | 按 ID 字典序导出全部 `mem`(深拷贝一层,值都是原始类型) |
| `MobHost.importMem(data)` | `host.ts:556` | 只写**已登记**的生物;未登记的计入 `skipped`,不凭空造实体 |
| `WorldSim.exportMobMem()` | `world_sim.ts:559` | 编排层转发 —— 存档系统不必知道宿主存在 |
| `WorldSim.importMobMem(data)` | `world_sim.ts:564` | 对偶入口,返回 `{applied, skipped}` |
| `saveRoomMobMem(db, roomId, mem, nowMs)` | `db/repo.ts` §11 | 落进 `rooms.mob_mem_json`,返回 `UPDATE` 影响行数(**0 = 没落地**) |
| `loadRoomMobMem(db, roomId)` | `db/repo.ts` §11 | 容错解析:坏 JSON / 非对象 / 值非法一律降级为空,**不抛错** |
| `WorldSim.saveToDb` / `loadFromDb` | `world_sim.ts` | 一段式落盘/读回(HP + mem),`db` 走参数注入 |
| `RoomRuntime.step()` 每 20 帧 | `net/room.ts` | 复用既有节流;`worldSaveHost=null` 时**不做任何事** |

**为什么落在 `rooms` 而不是新表**:`verify.ts:1316` 锁死 **9 张表**、`WS-07 A07b:249` 锁死 **11 条外键**,新表会同时打破两者;而 `A07c:304/307` 用的是 `>=`,**加列安全**。故 `rooms` 加一列 `mob_mem_json TEXT NOT NULL DEFAULT '{}'`(实测加列后 `WS-07` 仍 132/132,`unsupportedChecks()` 仍为 2 条)。

**两个设计要点**:

1. **就地覆盖而非替换对象**:`importMem` 逐键写入 `rt.mem`,不 `rt.mem = incoming`。因为 `behaviors.ts` 里 `rt.mem.xxx = ...` 遍布 250+ 处,AI 可能已持有 `mem` 的引用,换掉对象会让旧引用失效。
2. **值是联合类型,不是纯 number**:`mem` 声明为 `Record<string, number>`,但 `GingerImpAi` 实际写入过**字符串**(`behaviors.ts:879` 的 `rt.mem.taunt = '你抓不到我'`)。导出按 `unknown` 透传、按 JSON 实际类型还原 —— 若假设全是 number,`'你抓不到我'` 会在往返中失真。这是一处**既有的类型谎报**,已在 `host.ts` 注释中标注;修正 `mem` 的类型需改 `behaviors.ts` 的 `MobRuntime` 定义(冻结层边缘),未在本任务展开。

**测试覆盖**(`tests/WS-FND-02.test.ts`,「写完读回一致」):

- `C19` 跨宿主往返:导出 → `JSON.stringify` → `JSON.parse` → 导入,断言 `escapeTimer=7.5` / `candyDropped=3` / 野猪 `phase=2` / `travel=4.25` 全部读回一致,且「导出 → 导入 → 再导出」**逐字节相同**;
- `C20` 字符串值 `taunt` 往返不失真(且断言 `typeof` 仍为 `string`,没有变成 `NaN`);未登记生物被跳过且不凭空建实体;
- `C24` **(task-21)真实 DB 往返**:`MemoryDb` + 真实 `repo.ts` 建号建房 → 写入 `escapeTimer=7.5 / candyDropped=3 / taunt='你抓不到我'` / 野猪 `phase=2 / travel=4.25` → `saveToDb()` → **直接查 `rooms.mob_mem_json` 的 JSON 文本** → 换全新世界 `loadFromDb()` → 断言 `memApplied=2` 且各字段读回一致;并断言「存档 → 读档 → 再存档」内容一致,以及房间不存在时 `memRow=0`(**不假装成功**);
- `C25` **(task-21)接线守护**:从 `RoomRuntime.step()` 出发断言第 19 帧前不落盘、第 20 帧落盘、且读的是库里的值;无存档源时 `lastSaveReport` 保持 `null`。

**故障注入**(实测变红后还原):`saveToDb` 里写空对象 → `C24` 红(`Cannot read properties of undefined`);断掉 `step()` 的 `worldSaveHost` 调用 → `C25` 红(`第 20 帧应发生落盘`)。

**仍未做**(明确边界):生产装配 `room.colyseus.ts:97` 未设 `runtime.worldSaveHost`(`RoomRuntime` 至今不持有模拟层,即 US2 未开),故线上重启后 `mem` 仍会归零。补法是装配处一行:`this.runtime.worldSaveHost = sim`。`worldSaveHost === null` 时 `lastSaveReport` 保持 `null` 且 `C25` 专门断言这一点 —— **没接线是可观测的,不会被误当成已完成**。

4. **卡皮巴拉的攻击者反馈**:当前仅反弹爱心,未记录「谁打的」。若要发成就,需要在 `onDamage` 增加 `attackerId` 参数**改动签名**,需 Lead 裁决。
5. **牧场产出的时间基准**:当前用绝对秒(600s 一产)。是否应挂在游戏内「日」周期上(受昼夜系统影响)?
6. **`helmAbsorbs` 无上限累加**:长时间战斗会无限增长(实测 800 帧后 >5)。数值上不影响(层数已封顶),但若要做成就统计需要定期归零策略。
7. **刷怪决策的 `roll` 来源**:测试传入显式 `roll`,生产由服务器 RNG 提供。是否需要用房间种子保证跨服一致?
8. **45° 避障的「左撇优先」**:当前左侧优先。是否应改为「离目标更近的一侧优先」以改善追击手感?会改变确定性,需确认是否影响回放。
