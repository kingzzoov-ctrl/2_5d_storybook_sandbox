# WS-11 — 胡闹工坊急单 / 35 种整蛊玩具 / 四大竞技派对模式

> 对应设计手册 §3.4(整蛊玩具 221~255)、§3.7 竞技联动件(410~412 / 433~436)、§6.1 胡闹工坊、§6.2 互坑、§6.3 四大竞技、§6.4 社交度假。
> 实现文件:`server/src/coop/rush_order.ts`、`server/src/prank/toys.ts`、`server/src/prank/immunity.ts`、`server/src/party/modes.ts`、`server/src/party/scoring.ts`、`server/src/social/afk.ts`。
> 测试:`tests/WS-11.test.ts`(79 条断言)。

---

## 1. 职责边界

**本子系统负责**

| 编号 | 职责 | 落点 |
| :--- | :--- | :--- |
| R1 | 3 分钟限时急单状态机(IDLE→RUNNING→SETTLED)、订单生成器、交付判定与评级结算 | `rush_order.ts` |
| R2 | 高炉 / 汤锅「连续运转 12 秒不翻炒 → 起火冒烟」与 227 水枪 0.5 秒灭火计时 | `rush_order.ts` |
| R3 | 急单期间「偷木板河狸」事件刷怪与 222 充气大锤敲晕夺回 | `rush_order.ts` |
| R4 | 投掷接力链六环(砍树→隔河扔→空中接球→切木机→扔给队友→拍地基)的事件流与链中断惩罚 | `rush_order.ts` |
| R5 | 4 人叠罗汉搭人梯的可达高度、移速衰减、Z=2 采集与登 Boss 背判定 | `rush_order.ts` |
| R6 | 35 种整蛊玩具(221~255)全数据化:触发条件 / 半径 / 冲量 / 眩晕 / 变形时长 / 队友侧与怪物侧差异化效果 | `toys.ts` |
| R7 | 218 工程安全帽(和平盾)的三档免疫裁定(ALLY / SELF / HOSTILE)与完整免疫清单 | `immunity.ts` |
| R8 | 四大竞技模式的状态机、计时器、计分、结算与奖励;436/255/411/412/410/433/435/434 的联动 | `modes.ts` |
| R9 | 统一计分板、播报队列、毫秒计时、涂色网格、排名与奖励内核 | `scoring.ts` |
| R10 | 打盹攒露水、生态缸挂机运镜与白噪音混音、534 留言信箱、515 售货摊跨房交易、马拉松与风筝 Boss 跑道计时 | `afk.ts` |

**明确不负责(硬边界)**

1. **不实现物理积分器**。一切位移/投掷/接球/叠罗汉坐标由 WS-02 的 `server/src/physics/**` 推进;本子系统**只读** `shared/types/physics.ts` 的冻结函数与常量(`stackOffset` / `carrierSpeedMul` / `canPerfectCatch` / `throwVelocity` / `CARRY_Z_STEP` / `THROW_SPEED_XY` / `CATCH_RADIUS` / `CARRY_MAX_DEPTH`),不写任何 `server/src/physics/**` 文件。
2. **不实现战斗伤害公式**。玩具对怪物的 `enemyDamage` 只是「伤害输入值」,真正的护甲/克制/暴击由 WS-10 的 `server/src/combat/damage.ts` 结算。
3. **不实现地形与流体**。高炉/汤锅的起火判定与地形无关,只依赖本模块的运转计时器;水体、熔岩、引水渠由 WS-01 负责。
4. **不实现电路信号推进**。410 球门框 / 411 发令门 / 412 领奖台在本模块只被当作「事件触发点」消费,四色线的图推进属 WS-08。
5. **不实现 Boss AI 与破防**。抢皇冠模式的持冠者被 222 击退、登 Boss 背等只产出事件,不驱动 Boss 阶段机(WS-05)。
6. **不实现网络同步**。所有事件均为纯数据返回值,序列化与差量编码由 WS-07 处理。
7. **不实现渲染**。生态缸运镜只输出机位枚举与增益数值,不产出矩阵(WS-09)。
8. **不改 `shared/**` 任何文件**。物品名、价值、注释全部通过 `ITEM_BY_ID` 读取。

---

## 2. 上游 / 下游接口

**上游(只读消费的冻结层符号)**

| 冻结层文件 | 本子系统用到的符号 | 用途 |
| :--- | :--- | :--- |
| `shared/types/physics.ts` | `stackOffset` `carrierSpeedMul` `canPerfectCatch` `CARRY_Z_STEP` `CARRY_MAX_DEPTH` `CARRY_SLOWDOWN` `THROW_SPEED_XY` `THROW_SPEED_Z` `GRAVITY` `CATCH_RADIUS` `CATCH_Z_MIN` `CATCH_Z_MAX` `TICK_HZ` `DT` | 叠罗汉高度、接球窗口、投掷射程、帧步长 |
| `shared/constants/items.ts` | `ITEM_BY_ID`(218 / 221~255 / 101~170 / 303 / 304 / 501 / 505 / 515 / 517 / 534 …) | 名称事实源、价值 V_i(订单权重与售货摊推荐价) |
| `shared/constants/bosses.ts` | `PARTY_MODES`(4 条) | 四大模式的名称与节拍(15/30、180、180、120 秒) |
| `shared/types/entities.ts` | `AFK_EXP_RATIO`(=0.3) | 挂机经验倍率 |
| `shared/testing/harness.ts` | `mulberry32` `test` `ok` `eq` `near` `report` | 测试桩(仅测试侧) |

> 实现层**不 import 测试桩**:`party/scoring.ts` 自带 `makeRng`,与 `harness.mulberry32` 位级一致(测试 J9 逐位对照 200 个随机数验证)。

**下游(向谁输出什么)**

| 消费方 | 输出结构 | 说明 |
| :--- | :--- | :--- |
| WS-02 物理层 | `RelayStageInput.throwDistance` / `catchZ` / `catchDist` | 物理层算完抛物线后回灌给接力链判定 |
| WS-05 Boss 战 | `canMountBossBack(depth)`、`BeeaverRuntime`(由 222 击退事件驱动)、`CROWN` 掉冠事件 | 叠罗汉登背条件、破防窗口 |
| WS-07 网络层 | `RushOrderSession` / `PartySettlement` / `Broadcast[]` 纯数据 | 需序列化,无闭包、无函数字段 |
| WS-08 电路层 | `SCORE_GOAL_ITEM_ID=410` `RACE_START_GATE_ITEM_ID=411` `RACE_FINISH_PODIUM_ITEM_ID=412` 的触发事件名 | 电路把「信号 1」翻译成本模块的事件调用 |
| WS-09 客户端 | `Broadcast.text`(全房播报文案)、`VIVARIUM_CAMERA_SHOTS`、`WHITE_NOISE_MIX` | UI 与音频总线参数 |
| WS-10 战斗层 | `PrankToyDef.enemyEffect.enemyDamage`(伤害输入) | 进入伤害管线 |
| Lead / 验收器 | `node scripts/verify.ts --only WS-11` | — |

---

## 3. 数据结构

### 3.1 时钟与随机源(可注入,零依赖)

```ts
export interface Clock { now(): number; }                       // 逻辑秒
export interface ManualClock extends Clock {
  advance(sec: number): number;                                 // 手动推进
  set(t: number): void;                                         // 直接设定
}
export function createManualClock(startSec?: number): ManualClock;

export type Rng = () => number;                                 // 返回 [0,1)
```

**铁律**:生产代码不读 `Date.now()` / `performance.now()`;测试不真 `sleep`。J6 断言「模拟 180 秒逻辑耗时 < 2000ms」。

### 3.2 订单板

```ts
export interface RushOrderSlot {
  itemId: number;      // 必须命中 ITEM_BY_ID
  name: string;        // 从冻结层回填,不硬编码
  need: number;        // 1..4
  delivered: number;   // 0..need
  unitValue: number;   // V_i
  weight: number;      // V_i × 稀缺系数 × (1+0.08(Lv−1))
  points: number;      // round(V_i × need × 等级系数)
}
export interface RushOrderBoard {
  roomLevel: number;   // ≥1
  seed: number;
  slots: RushOrderSlot[];   // 2..4 项
  totalPoints: number;
}
```

### 3.3 工位(高炉 / 汤锅 / 切木机)

```ts
export type StationKind = 'FURNACE' | 'POT' | 'CUTTER';
export type StationState = 'IDLE' | 'RUNNING' | 'BURNING' | 'EXTINGUISHING';
export interface StationRuntime {
  kind: StationKind;
  state: StationState;
  runningSec: number;   // 连续运转秒数,翻炒归零
  burningSec: number;   // 已燃烧秒数,灭火归零
  dousedSec: number;    // 灭火累计秒数,间断归零
  tendedSec: number;    // 累计被照看秒数
  fireCount: number;    // 累计起火次数
  burnDamage: number;   // 累计灼烧伤害
}
```

### 3.4 河狸

```ts
export type BeaverState = 'STEALING' | 'FLEEING' | 'KNOCKED_DOWN' | 'ESCAPED';
export interface BeaverRuntime {
  id: string;
  mobId: string;        // 恒为 'mob_beaver'(冻结层 mobs.ts)
  state: BeaverState;
  wantItem: number;     // 恒为 151 木板
  stolenQty: number;    // 已抱走 0..3
  elapsed: number;
  stunSec: number;      // 剩余眩晕
  reclaimable: boolean; // 可夺回窗口
  reclaimed: number;
}
```

### 3.5 接力链

```ts
export type RelayStage = 'CHOP'|'THROW_A'|'CATCH'|'CUT'|'THROW_B'|'PAT';
export type ChainState = 'PENDING'|'SUCCESS'|'BROKEN';
export type ChainBreakReason = 'OUT_OF_ORDER'|'TIMEOUT'|'DROP'|'OVERSHOOT';
export interface RelayChain {
  id: string;
  state: ChainState;
  index: number;                 // 下一个应触发的环 0..6
  lastAtSec: number;             // 上一环时刻
  awarded: number;               // 累计奖励(成功只 +150 一次)
  penalty: number;               // 累计罚分
  breakReason: ChainBreakReason | null;
  catchZ: number; catchDist: number;   // CATCH 环实测值
}
```

### 3.6 整蛊玩具(全 35 项的统一表)

```ts
export interface ToyEffect {
  flag: ToyStateFlag;    // NONE/SLIPPING/STUNNED/BUBBLED/FROZEN/MORPHED/FLOATING/GLUED/CAMOUFLAGED/SHRUNK/GIANT/BLINDED
  moveTiles: number;     // 位移格数 ≥0
  allyDamage: number;    // 对队友伤害,恒 0
  enemyDamage: number;   // 对怪物伤害 ≥0
  rescueWindow: boolean; // 是否开启可夺回/可救援窗口
  note: string;
}
export interface PrankToyDef {
  id: number;            // 221..255
  name: string;          // 冻结层 ITEM_BY_ID 回填
  trigger: ToyTrigger;   // SWING/THROW/PLACE/HELD/WORN/PLAY/USE
  radius: number;        // 格
  impulse: number;       // 格/秒
  stunSec: number;       // 秒
  morphSec: number;      // 秒
  allyEffect: ToyEffect;
  enemyEffect: ToyEffect;
}
```

### 3.7 免疫清单

```ts
export type EffectOrigin = 'ALLY' | 'SELF' | 'HOSTILE';
export type ShieldVerdict = 'IMMUNE' | 'NOT_IMMUNE';
export interface ImmunityEntry {
  key: string;           // 'PRANK:<id>' 或 HostileSource
  label: string;
  toyId: number | null;
  flag: ToyStateFlag | 'DAMAGE';
  allyImmune: boolean;
  selfImmune: boolean;
  hostileImmune: boolean;
  rationale: string;
}
export interface ShieldResolution {
  verdict: ShieldVerdict;
  blocked: boolean;
  flag: ToyStateFlag | 'DAMAGE' | null;
  label: string;
  reason: string;        // SHIELD_OFF / SHIELD_BLOCK_ALLY / SHIELD_PASS_HOSTILE / UNKNOWN_SOURCE
}
```

### 3.8 竞技模式

```ts
export type PartyModeKey = 'BRIDGE_CTF'|'JELLY_BALL'|'CROWN_BR'|'PAINT_WAR';
export type PartyPhase = 'IDLE'|'BUILD'|'RACE'|'PLAY'|'SETTLED';
export interface PartyModeRuntime {
  key: PartyModeKey; name: string; phase: PartyPhase;
  clock: Clock; startedAtSec: number;
  buildSec: number; raceSec: number;
  refereeId: string;
  board: Map<TeamKey, TeamScore>;
  broadcaster: Broadcaster;
  settlement: PartySettlement | null;
  rng: Rng; phaseSwitches: number;
}
export interface TeamScore { team: TeamKey; score: number; goals: number; crownSec: number; tiles: number; }
export interface PartySettlement {
  mode: PartyModeKey; modeName: string; elapsedSec: number;
  standing: { rank: number; team: TeamKey; label: string; value: number }[];
  rewards: RewardLine[];
  personal: RaceResult[];
  personalRewards: RewardLine[];
  broadcastText: string;
}
```

### 3.9 计时与播报

```ts
export interface RaceTimer { playerId: string; startMs: number|null; finishMs: number|null; elapsedMs: number|null; }
export interface RaceResult { rank: number; playerId: string; elapsedMs: number; dnf: boolean; }
export interface Broadcast { kind: BroadcastKind; atSec: number; text: string; priority: number; }
```

### 3.10 社交

```ts
export interface AfkPlayer {
  playerId: string; state: 'AWAKE'|'DOZING'|'DEEP';
  backgroundedAtSec: number|null; dozedSec: number;
  dewAcc: number; dew: number;                       // 露水小数累加器 + 总量
  nearFire: boolean; onTatami: boolean; onBed: boolean;
  healedHp: number;
}
export interface Mail { id: string; from: string; to: string; atSec: number; likes: number; sticker: number; gifts: Record<number,number>; text: string; }
export interface StallListing { itemId: number; qty: number; price: number; sellerId: string; listedAtSec: number; }
```

---

## 4. 算法与公式

### 4.1 订单生成(确定性)

```
输入:rng(可注入)、roomLevel、stock[itemId]、seed、pool
1. lv = clamp(round(roomLevel), 1, +∞)
2. slotCount = clamp(2 + floor((lv−1)/5), 2, 4)
3. 对 pool 每一项 id:
     held      = min(10, max(0, stock[id]))
     scarcity  = 1 + (10 − held)/10            # 0 库存权重最高 ×2
     w[id]      = V_i × scarcity × (1 + 0.08(lv−1))
4. 重复 slotCount 次:
     idx  = 按 w 加权抽取(线性扫描,不用 sort)
     need = clamp(1 + floor(rng() × (floor(min(lv,12)/3)+1)), 1, 4)
     points = round(V_i × need × (1 + 0.08(lv−1)))
5. totalPoints = Σ points
```

输出与 `(rng 序列, roomLevel, stock, pool)` 唯一对应,同入参两次调用 `JSON.stringify` 完全一致(断言 A2)。

**复杂度**:O(P + slotCount),P = `ORDER_POOL.length = 19`,slotCount ≤ 4 ⇒ 常数级,可忽略。

### 4.2 交付判定

```
deliver(board, itemId, qty):
  slot = slots.find(s => s.itemId == itemId && s.delivered < s.need)
  if !slot            → { accepted:false, reason:'NOT_ORDERED' }
  consumed = min(qty, slot.need − slot.delivered)
  slot.delivered += consumed
  points   = round(slot.points / slot.need × consumed)
  slotFilled = slot.delivered == slot.need
```

超额部分被**丢弃**(不转移给其它订单、不重复计分),避免一物多卖刷分(断言 A5)。

### 4.3 急单状态机

```
IDLE --startRushOrder--> RUNNING --elapsed ≥ durationSec--> SETTLED
elapsedSec = clock.now() − startedAtSec
settle:
  progress = Σ min(delivered,need) / Σ need
  grade    = S if progress ≥ 1.00; A if ≥ 0.75; B if ≥ 0.50; else C
  timeBonus = 1.15 if elapsed < duration/2 else 1.0     # 90 秒内交满分给时间奖励
  score    = round(totalPoints × progress × timeBonus)
```

### 4.4 工位过热 / 灭火

```
状态机:
  IDLE ──start──> RUNNING
  RUNNING ──(tended)──> RUNNING, runningSec = 0
  RUNNING ──(runningSec ≥ 12)──> BURNING, fireCount++, emit STATION_FIRE
  BURNING ──(spraying)──> EXTINGUISHING, dousedSec += dt
  EXTINGUISHING ──(dousedSec ≥ 0.5)──> RUNNING, runningSec = burningSec = dousedSec = 0, emit STATION_DOUSED
  EXTINGUISHING ──(!spraying)──> BURNING, dousedSec = 0        # 间断灭火必须重来
  BURNING/EXTINGUISHING 未喷水:burningSec += dt, burnDamage += 6·dt
  burningSec 首次跨过 0.5 秒 ⇒ emit STATION_SMOKE
```

**注意 20Hz / 2Hz 一致性**:用 EPS = 1e-9 做阈值比较,避免 `0.05 × 240 = 11.999999999` 的浮点误差导致 12 秒判不上。断言 J4 在 0.05 / 0.5 / 1.0 三种步长下都必须恰好起火 1 次。

### 4.5 河狸偷料与夺回

```
STEALING: elapsed ≥ 4.0 ⇒ take = min(3, stock[151]); stock[151] −= take;
                          stolenQty = take; state = FLEEING; emit BEAVER_STOLE
FLEEING : elapsed ≥ 10.0 ⇒ state = ESCAPED; emit BEAVER_ESCAPED(材料永久损失)
hitBeaver(impulse):
  impulse < 8        ⇒ reason = IMPULSE_TOO_LOW(拒绝)
  state == ESCAPED   ⇒ reason = ESCAPED
  state == KNOCKED   ⇒ reason = ALREADY_DOWN
  否则 state = KNOCKED_DOWN, stunSec = 2.5, reclaimable = (stolenQty > 0)
KNOCKED_DOWN: stunSec −= dt; ≤0 ⇒ 回到 FLEEING, reclaimable = false
reclaimWood: 仅当 reclaimable && stolenQty > 0,写回 stock,清空 stolenQty(幂等)
```

**8 格/秒**这个阈值直接取自 `items.ts` #222 注释「施加 8 格/秒击退冲量」,与 `TOY_ROWS[222].impulse` 共享同一常量 `HAMMER_222_IMPULSE`,不设第二个魔法数字。

### 4.6 投掷接力链

```
字段:index(下一环)、lastAtSec、state
fireRelayStage(chain, stage, input):
  if state != PENDING                → CHAIN_CLOSED(不重复计分)
  if stage != STAGES[index]          → OUT_OF_ORDER + 罚 40
  if index > 0 && atSec − lastAtSec > TIMEOUT[stage] → TIMEOUT + 罚 40
  if stage == CATCH:
        if !canPerfectCatch(z, dist) → DROP + 罚 40      # 冻结层判定 0.3 ≤ z ≤ 1.4 且 dist ≤ 0.8
  if stage ∈ {THROW_A, THROW_B}:
        if throwDistance > THROW_SPEED_XY(8.5) → OVERSHOOT + 罚 40
  index++; lastAtSec = atSec
  if index == 6 → SUCCESS,awarded += 150(仅此一次)
```

`pollChainTimeout(chain, now)` 供「没有新事件到来」的空转检测:由 `tickRushOrder` 每步调用,超时即中断。

**接球判定完全委托冻结层 `canPerfectCatch`**,本模块不重写 `0.3/1.4/0.8` 三个数(断言 D5 用 `CATCH_RADIUS` 边界值验证)。

### 4.7 叠罗汉可达高度

```
顶层高度  topZ(depth)  = stackOffset(min(depth, CARRY_MAX_DEPTH) − 1) = 0.85 × (depth−1)
可达高度  reach(depth) = topZ(depth) + STACK_REACH_Z(0.30)
Z=2 果实 / 登 Boss 背:Z2_REACH_TARGET = BOSS_BACK_HEIGHT = 2.30(平台面 2.0 + 到手 0.30)
  2 人:0.85 + 0.30 = 1.15  < 2.30  ✗(差 1.15)
  3 人:1.70 + 0.30 = 2.00  < 2.30  ✗(差 0.30)
  4 人:2.55 + 0.30 = 2.85  ≥ 2.30  ✓(余 0.55)
移速衰减  carrierSpeed(depth) = carrierSpeedMul(depth − 1) = 0.85^(depth−1)
```

**为什么伸手高度取 0.30、目标高度取 2.30(Lead 裁决 U1)**:手册明确「4 人叠罗汉搭人梯才能采到 Z=2 果实」,这是设计意图的硬约束。第一版取「伸手 0.25 + 目标 2.0」虽也成立,但 3 人梯 1.95 只差 0.05 格,20Hz 浮点累加与坐标同步抖动足以误判。改为「伸手 0.30 + 有效抓取高度 2.30」后:

- 3 人梯缺口 0.30 格、4 人梯余量 0.55 格,**两侧裕度都 > 0.1 格**,判定稳定;
- 设计意图(只有满 4 人梯能采 Z=2)完整保持;
- 判定逻辑一行未动,只改常量 —— `canReachHeight(depth, targetZ) = stackTopZ(depth) + STACK_REACH_Z >= targetZ` 的形式不变。

`Z2_REACH_TARGET = 2.30` 的语义是「Z=2 层果实/机关的**有效抓取高度**」,即平台面 2.0 再往上 0.30 的到手高度;Boss 背脊是曲面而非平面,落点更靠上,因此共用同一目标高度,避免 3 人梯恰好压在 2.00 边界上抖动。

### 4.8 整蛊玩具触发解算

```
applyToy(toy, origin, target):
  if origin == ALLY && target.shieldOn:
        r = resolveShield(true, toy.id, 'ALLY')
        if r.blocked → 直接返回,不施加 flag / 位移 / 伤害
  target.state      = toy.<side>Effect.flag
  target.stateTimer = toy.stunSec + toy.morphSec
  target 位移       = toy.<side>Effect.moveTiles(方向由施法者指向目标)
  伤害              = toy.<side>Effect.allyDamage 或 enemyDamage(队友侧恒 0)
```

**副作用**:打出 `moveTiles` 在地上就等于「香蕉皮 5 格打滑」这类位移,Boss/野怪撞击结算交给 WS-02 的 `resolveCircleBounce`。

### 4.9 和平盾三档裁定

```
resolveShield(shieldOn, sourceKey, origin):
  entry = IMMUNITY_BY_KEY.get('PRANK:'+id 或 源键)
  未收录                  → NOT_IMMUNE, reason = UNKNOWN_SOURCE(保守放行 + 上层告警)
  !shieldOn               → NOT_IMMUNE, reason = SHIELD_OFF
  origin == ALLY          → entry.allyImmune    (35 项玩具全 true)
  origin == SELF          → entry.selfImmune    (全 false,避免自锁)
  origin == HOSTILE       → entry.hostileImmune (全 false,Boss/环境穿透)
```

**为什么 SELF 与 HOSTILE 都不免疫(Lead 裁决 U10 确认)**:

- SELF 若免疫,玩家给自己丢香蕉皮/水球会毫无反应,与「自己踩自己陷阱」的沙盒直觉冲突;道具失去代价感,也会误导玩家对和平盾的预期(和平盾的语义是「免疫**队友**的物理整蛊」,不是「万能护盾」);
- HOSTILE 若免疫,和平盾就成了无敌挂,直接破坏 WS-05 的 Boss 战平衡。

### 4.9b 自伤独立结算路径(Lead 裁决 U10)

自伤**不走** `resolveShield` —— 它是一条独立代码路径,和平盾开与关结果逐字段相同。

```
applySelfDamage(hp, maxHp, rawDamage):          # 注意:没有 shieldOn 形参,契约层面即解耦
  floor     = max(1, ceil(0.15 × maxHp))         # HP 地板
  cur       = max(0, hp)
  afterRaw  = cur − max(0, rawDamage)
  clamped   = afterRaw < floor
  next      = clamped ? min(cur, floor) : afterRaw    # 地板只防跌,不治疗
  return { hp: next, dealt: cur − next, clamped,
           state: 'STUNNED',                     # 只到感电麻痹
           paralyzedSec: 1.5,
           ghostBubble: false,                   # 永不触发幽灵泡泡倒地
           shielded: false }

resolveHelmetSelfStrike(hp, maxHp) = applySelfDamage(hp, maxHp, 45)
```

**105 的两层「不自锁」保护**:

| 保护 | 规则 | 效果 |
| :--- | :--- | :--- |
| ① HP 硬顶 | 自伤后 HP ≥ `max(1, ceil(0.15 × maxHp))` | 残血玩自伤不会被打死 |
| ② 无倒地 | `state` 只可能是 `STUNNED`,永不 `GHOST_BUBBLE` | 自伤不会把自己送进待救援状态 |

**为什么 `next = min(cur, floor)` 而不是直接 `next = floor`**:地板是一道「防跌护栏」,不是治疗。若玩家已被 Boss 打到残血(如 5 HP),直接跳到 30 HP 会让「被自己电一下反而回血」,荒谬且会被利用来刷血。取 `min(cur, floor)` 后:HP 在护栏之上 → 正常扣血但被截在护栏;HP 已在护栏之下 → 锁定原值,既不跌也不涨。

**与队友路径的对照**:

| 来源 | 代码路径 | 和平盾 | 可致死 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| 队友整蛊(`origin=ALLY`) | `immunity.resolveShield(...)` | **100% 拦截** | 否(队友侧零伤害) | 手册 #218 原句 |
| 自己用道具(`origin=SELF`) | `applySelfDamage(...)` | **不拦截** | 否(HP 硬顶 15%) | U10:保留代价感 + 不自锁 |
| Boss / 野怪 / 环境 | `immunity.resolveShield(..., 'HOSTILE')` | 不拦截 | 是 | 保持战斗平衡 |

### 4.10 四大竞技模式

**① 造桥夺旗(BRIDGE_CTF,15s 建 + 30s 冲刺)**

```
IDLE --startPartyMode--> BUILD --elapsed ≥ buildSec(15)--> RACE --elapsed ≥ 45--> SETTLED
BUILD 阶段:bridgePlace 允许摆板 / 放盲盒陷阱;bridgeCapture 拒绝
RACE  阶段:bridgePlace 拒绝;bridgeCapture 需 built ≥ 12 才成功
结算:夺旗队 +100;未夺旗队 + 2 × built(安慰分);按 score 降序排名
```

**② 4v4 果冻球(JELLY_BALL,180s)**

```
球体:冰面摩擦 μ = 0.98,每步 v *= μ;x += v·dt
进球判定(考虑球半径 0.5 的 AABB 相交):
  ballInGoal(g) = ball.x + 0.5 ≥ g.x && ball.x − 0.5 ≤ g.x + g.w
               && ball.y + 0.5 ≥ g.y && ball.y − 0.5 ≤ g.y + g.h
进球 → 对手队 goals++、score++,emit GOAL(含最新比分),ball.live = false
复位:resetTimer = 1.0s;倒计时归零后 x,y 回到 433 生成座(spawnX/spawnY)
```

**③ 金皇冠大逃杀(CROWN_BR,180s,持冠 60s 胜)**

```
crownPickup: 需 holder == null && cooldownSec == 0 && winner == null && 玩家已登记队伍
tickCrown(dt): holder != null ⇒ 队伍 crownSec += dt、个人 perPlayer += dt
               crownSec ≥ 60 ⇒ winner = 该队,phase = SETTLED,emit CROWN_WIN
crownDrop: holder = null,cooldownSec = 5(防抖冠刷分)
个人榜按持冠秒数**降序**(rankByDescending),不是按耗时升序
```

**④ 圈地涂色(PAINT_WAR,120s)**

```
涂色:paintRadius(grid, x, y, 1, team) 刷 3×3,越界裁剪,重复不计数
取色:dyeIndex = floor(rng() × 32) % 32(32 色对应 505 炼金调色染缸)
排名:按 tiles 降序,同数按 TEAM_ORDER 稳定
播报:「1. 红队 27 格(4.7%)  2. 蓝队 18 格(3.1%) …」
```

**⑤ 跑酷 / 马拉松毫秒计时(计时内核复用)**

```
openGate(atSec, players):对每个未出发玩家 gateStart → startMs = round(atSec × 1000)
finishRunner(atSec):podiumFinish → finishMs = round(atSec × 1000);elapsedMs = finishMs − startMs
rankRace:完赛者按 elapsedMs 升序,DNF 垫底,同毫秒按 playerId 字典序
播报:「前三名:1. p1 12.345s   2. p2 12.456s   3. p3 12.458s」——第四名起不播
风筝 Boss 跑道:每次被追上 elapsedMs += 3000
```

---

## 5. 参数配表

### 5.1 急单

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `RUSH_ORDER_DURATION_SEC` | 180 | 手册 §6.1「3 分钟限时交付」 |
| `ORDER_SLOT_MIN / MAX` | 2 / 4 | 本设计:小房间 2 单,大房间 4 单 |
| `ROOM_LEVEL_PER_SLOT` | 5 | 本设计:每 5 级 +1 订单位 |
| `ORDER_NEED_MIN / MAX` | 1 / 4 | 每单需求件数区间 |
| `STOCK_PRESSURE_UNIT` | 10 | 库存压力归一化基准(手上 0 件 → 权重 ×2) |
| `ORDER_LEVEL_VALUE_STEP` | 0.08 | 每高 1 级订单分值 +8% |
| `RUSH_GRADE_THRESHOLDS` | S 1.00 / A 0.75 / B 0.50 | 评级阈值 |
| 时间奖励 | ×1.15(90 秒内) | 本设计:急单越快越值 |

### 5.2 工位

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `OVERHEAT_SEC` | 12 | 手册 §6.1「连续运转 12 秒不翻炒起火冒烟」 |
| `EXTINGUISH_SEC` | 0.5 | 手册 §6.1「227 水枪灭火 0.5 秒」 |
| `SMOKE_LEAD_SEC` | 0.5 | 起火后冒烟延迟 |
| `BURN_DAMAGE_PER_SEC` | 6 | 本设计:每燃烧秒 6 点灼烧 |

### 5.3 河狸

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `BEAVER_MOB_ID` | `mob_beaver` | mobs.ts「淘气造坝河狸」 |
| `BEAVER_TARGET_ITEM_ID` | 151(木板) | mobs.ts 掉落表 `{703:2, 151:3}` |
| `BEAVER_STEAL_SEC` | 4.0 | 本设计:4 秒内可打断 |
| `BEAVER_ESCAPE_SEC` | 10.0 | 逃跑窗口 |
| `BEAVER_SPAWN_INTERVAL_SEC` | 20.0 | 急单期间刷怪间隔 |
| `BEAVER_MAX_ACTIVE` | 2 | 同屏上限 |
| `BEAVER_RECLAIM_QTY` | 3 | 与 mobs.ts 的 151 掉落数一致 |
| `HAMMER_222_IMPULSE` | 8 | items.ts #222「8 格/秒击退冲量」 |
| `BEAVER_STUN_IMPULSE` | 8 | 达到该冲量即敲晕 |
| `BEAVER_STUN_SEC` | 2.5 | 敲晕窗口 |

### 5.4 接力链

| 环 | 时限(s) | 备注 |
| :--- | :--- | :--- |
| CHOP | 6.0 | 砍树,允许蓄力 |
| THROW_A | 2.0 | 隔河投掷 |
| CATCH | 2.0 | 空中接球(冻结层窗口) |
| CUT | 3.0 | 切木机加工 |
| THROW_B | 2.0 | 扔给队友 |
| PAT | 2.5 | 拍地基落地 |

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `CHAIN_SUCCESS_SCORE` | 150 | 整链一次成功 |
| `CHAIN_BREAK_PENALTY` | 40 | 任一环中断 |
| `RELAY_THROW_RANGE` | 8.5 | `THROW_SPEED_XY` 冻结层 |
| `RELAY_RIVER_WIDTH` | 7.0 | 隔河标准宽度 |

### 5.5 叠罗汉

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `CARRY_Z_STEP` | 0.85 | physics.ts 冻结 |
| `CARRY_MAX_DEPTH` | 4 | physics.ts 冻结 |
| `CARRY_SLOWDOWN` | 0.85 | physics.ts 冻结 |
| `STACK_REACH_Z` | 0.30 | **Lead 已采纳**(U1):顶层伸手抓取高度 |
| `Z2_REACH_TARGET` | 2.30 | **Lead 已采纳**(U1):Z=2 有效抓取高度(平台面 2.0 + 到手 0.30) |
| `Z2_FRUIT_HEIGHT` | = `Z2_REACH_TARGET`(2.30) | 果实判定复用目标高度 |
| `BOSS_BACK_HEIGHT` | = `Z2_REACH_TARGET`(2.30) | Boss 背脊曲面,落点更靠上,与机关共用 |

### 5.6 整蛊玩具关键数值

| 玩具 | 半径 | 冲量 | 眩晕 | 变形/持续 | 队友侧 | 怪物侧 |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| 221 大力士举重手套 | 1.0 | 0 | 0 | 0 | FLOATING 举起 | STUNNED 举起当炮弹 |
| 222 充气玩具大锤 | 1.4 | 8 | 2.5 | 0 | STUNNED 位移 2,零伤 | STUNNED 位移 2,30 伤 |
| 223 弹簧拳击套 | 4.0 | 6 | 1.0 | 0 | 位移 3 | 位移 3,45 伤 |
| 225 滑溜溜香蕉皮 | 0.8 | 0 | 1.2 | 5 | SLIPPING 滑 5 格 | SLIPPING 滑 5 格 |
| 227 泡泡连发水枪 | 5.0 | 0 | 0 | 6 | 3 发装泡泡 | 破火灵护盾 |
| 228 定时痒痒炸弹果 | 2.5 | 4 | 0.5 | 3 | 炸飞翻滚,零伤 | 120 破甲伤害 |
| 229 幻彩变身吹箭 | 4.0 | 0 | 0 | 10 | MORPHED 小肥鸡 | MORPHED 无害动物 |
| 232 强力粘性蜂蜜罐 | 1.5 | 0 | 0 | 8 | GLUED 减速 70% | GLUED 减速 70% |
| 233 极寒冰霜雪球 | 1.0 | 0 | 0 | 3 | FROZEN 冰雕 3 秒 | FROZEN 可当保龄球 |
| 243 引雷铁锅头盔 | 3.0 | 0 | 1.5 | 0 | 自伤 45,麻痹 1.5s(HP 硬顶 15%) | 90 伤 + 麻痹 |
| 255 裁判金哨子 | 32.0 | 0 | 0 | 0 | 召集小游戏 | 无效果 |

> 全表 35 项见 `server/src/prank/toys.ts` 的 `TOY_ROWS`,`PRANK_TOYS` 会把名称从 `ITEM_BY_ID` 回填。

### 5.6b 自伤(Lead 裁决 U10 采纳值)

| 参数 | 值 | 说明 |
| :--- | :--- | :--- |
| `SELF_DAMAGE_HP_FLOOR_RATIO` | 0.15 | 自伤后 HP 不得低于 `max(1, ceil(0.15 × maxHp))` |
| `HELMET_SELF_PARALYZE_SEC` | 1.5 | 243 感电麻痹时长 |
| `HELMET_SELF_DAMAGE` | 45 | 243 自伤掉血(与对怪物 90 点区分) |
| `SELF_DAMAGE_STATE.STUNNED` | `'STUNNED'` | 自伤唯一可能的战斗状态 |
| `SELF_DAMAGE_STATE.GHOST_BUBBLE` | `'GHOST_BUBBLE'` | 自伤**禁止**到达(与冻结层 `BodyState` 同名) |
| 和平盾参与 | **否** | `applySelfDamage` / `resolveHelmetSelfStrike` 签名无 `shieldOn` |

### 5.7 竞技模式

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `BRIDGE_BUILD_SEC` / `BRIDGE_RACE_SEC` | 15 / 30 | `PARTY_MODES.BRIDGE_CTF` |
| `BRIDGE_TILES_TO_WIN` | 12 | 本设计:过河所需桥板 |
| `BRIDGE_SCORE_PER_FLAG` | 100 | 夺旗分 |
| `JELLY_MU` | 0.98 | 镜面极滑冰砖(items.ts 315) |
| `JELLY_RESTITUTION` | 0.92 | 高弹软包防撞墙 |
| `JELLY_GOAL_WIDTH / DEPTH` | 3 / 1 | 410 球门框「占地 3×1」 |
| `JELLY_BALL_RESET_SEC` | 1.0 | 进球后复位 |
| `CROWN_MODE_SEC` / `CROWN_WIN_SEC` | 180 / 60 | `PARTY_MODES.CROWN_BR` + 手册「先积满 60 秒」 |
| `CROWN_PICKUP_COOLDOWN_SEC` | 5 | 防抖冠刷分 |
| `PAINT_MODE_SEC` | 120 | `PARTY_MODES.PAINT_WAR` |
| `PAINT_BALL_RADIUS` | 1(3×3) | 237 颜料水球 |
| `DYE_PALETTE_SIZE` | 32 | 505 炼金调色染缸「32 色染料」 |
| `KITE_CATCH_PENALTY_MS` | 3000 | 风筝 Boss 追上一次罚 3 秒 |

### 5.8 社交

| 参数 | 值 | 出处 |
| :--- | :--- | :--- |
| `DOZE_AFTER_SEC` | 5 | 手册 §6.4「切后台 5 秒自动打盹」 |
| `DEW_SEC_PER_UNIT` | 30 | 本设计:30 秒 1 滴 |
| `DEW_FIRE_BONUS` | 2.0 | items.ts 501「打盹攒露水速度翻倍」 |
| `DEW_TATAMI_BONUS` | 1.2 | items.ts 304「额外 +20%」 |
| `DEEP_SLEEP_AFTER_SEC` / `MUL` | 600 / 0.5 | 防挂机刷 |
| `BED_HP_PER_SEC` | 15 | items.ts 517「每秒恢复 15 HP」 |
| `VIVARIUM.uiFadeSec` / `shotSec` | 1.2 / 24 | 隐藏 UI 淡出与单镜时长 |
| `WHITE_NOISE_MIX` | 5 轨,gain 合计 1.12 | 本设计 |
| `MAILBOX_CAPACITY` | 50 | 534 留言信箱 |
| `MAIL_TTL_SEC` | 604800(7 天) | 过期清理 |
| `STALL_SLOT_COUNT` | 8 | 515 售货摊 |
| `SUGGESTED_PRICE_MUL` | 1.6 | 推荐价 = V_i × 1.6 |
| `CROSS_ROOM_FEE_RATIO` | 0.05 | 跨房抽成 5% |

---

## 6. 帧预算 / 性能

### 6.1 每帧开销(20Hz 高频帧 = 50ms 预算)

| 模块 | 单次成本 | 判断 |
| :--- | :--- | :--- |
| `tickStation × 3 工位` | 约 3 次分支 + 6 次浮点加 | < 0.001ms |
| `tickBeaver × ≤2` | 2 次分支 + 1 次减法 | < 0.001ms |
| `pollChainTimeout × ≤4 链` | 4 次比较 | < 0.001ms |
| `tickCrown` | 1 次 Map.get + 2 次浮点加 | < 0.001ms |
| `tickAffk × 16 人` | 16 × (1 次性能比值计算 + 1 次取整) | < 0.01ms |
| `paintRadius`(每球) | 9 次网格写 | < 0.001ms |
| 整蛊玩具查表 | `PRANK_TOY_BY_ID.get` O(1) | < 0.0001ms |

**结论**:全部 WS-11 每帧逻辑合计 **< 0.05ms**,占 20Hz 帧预算的 0.1%。J7 断言 2 万次 O(1) 查表 < 2000ms(实测远低于此)。

### 6.2 内存上界(1GB 约束)

| 结构 | 上界 | 字节估算 |
| :--- | :--- | :--- |
| `PRANK_TOYS`(35 项) | 35 × (8 标量 + 2 × 6 字段 effect + 2 字符串) | ≈ 35 × 400B ≈ **14KB**(常驻) |
| `IMMUNITY_MANIFEST`(42 条) | 42 × (5 字符串 + 4 布尔 + 若干标量) | ≈ **18KB**(常驻) |
| `RushOrderBoard` | 4 槽 × 7 字段 | < 1KB |
| `PaintGrid`(24×24) | 576 × 1 引用 | ≈ **4.6KB** |
| `RushOrderSession`(含 ≤2 河狸、≤4 链、3 工位、订单板) | — | < 10KB |
| `Broadcaster.queue` | 上限 99 条 × 约 100 字符 | ≈ **10KB**(需上层限流,见 §7) |
| 每房间竞技状态(4 模式同时存在) | — | < 40KB |

**单房间 WS-11 常驻 < 100KB**;1000 并发房间 < 100MB,占 1GB 预算 10%。

### 6.3 低频帧(2Hz)适用性

工位过热、打盹产露、持冠计秒全部按 `dt` 累加,在 0.5s 与 0.05s 步长下结论一致(J4 已断言三种步长灭火/起火次数相同)。推荐:

- 工位 / 打盹 / 持冠 → **2Hz**(0.5s)足够,误差 ≤ 0.5s,对 12 秒阈值可接受;
- 果冻球抛物跟踪 / 接力链接球判定 → 必须 **20Hz**(0.05s),否则接球窗口会被跳过。

---

## 7. 异常与边界

| 场景 | 处理 | 断言 |
| :--- | :--- | :--- |
| 订单池出现悬空物品 ID | `assertOrderPoolClosed()` 在模块顶层抛错,**启动即失败** | A1 |
| 交付数量 ≤ 0 | 返回 `QTY_INVALID`,不改状态 | A5 |
| 交付未点名的物品 | 返回 `NOT_ORDERED`,不扣库存 | A5 |
| 交付超额 | 只消耗 `need − delivered`,余量丢弃 | A5 |
| 工位从未 start | `tickStation` 直接返回空事件 | B1 |
| 灭火间断 0.4 秒 | `dousedSec` 归零,状态退回 BURNING | B3 |
| 12 秒阈值浮点误差 | EPS = 1e-9 比较,20Hz/2Hz/1Hz 均只起火 1 次 | J4 |
| 河狸冲量不足 8 | 返回 `IMPULSE_TOO_LOW`,不眩晕 | C2 |
| 河狸已逃逸 | `hitBeaver` 返回 `ESCAPED`,无法夺回 | C2 |
| 敲晕窗口过期 | 状态回 FLEEING,`reclaimWood` 返回 0 | C3 |
| `reclaimWood` 二次调用 | 幂等,返回 0,库存不再增加 | C2 |
| 接力链越序 | `OUT_OF_ORDER` + 罚 40,链关闭 | D3 |
| 接力链接球落空 | Z ∉ [0.3,1.4] 或 dist > 0.8 → `DROP` | D5 |
| 接力链重复触发已成功的链 | `CHAIN_CLOSED`,不加分 | D2 |
| 投掷超射程 | `OVERSHOOT` | D6 |
| 玩具表 ID 缺失 / 越界 / 重复 | `assertToyIdSetClosed()` 抛错 | F1 |
| 玩具对队友产生伤害 | `assertAllyZeroDamage()` 抛错 | F3 |
| 免疫清单漏项 | `assertImmunityManifestComplete()` 抛错 | G1 |
| 未知来源伤害 | `UNKNOWN_SOURCE` 保守放行 + 上层告警 | G7 |
| 涂色越界坐标 | `paint` 返回 false,不写入 | J3 |
| 重复涂同一格 | 返回 false,不重复计数 | J3 |
| 球未复位时再次射门 | `judgeGoal` 直接返回未得分 | H2 |
| 皇冠已有人持有 | `crownPickup` 返回 false | H3 |
| 掉冠冷却期内拾取 | 返回 false,冷却逐 dt 递减 | H4 |
| 玩家未登记队伍就拾冠 | 返回 false(防越权) | — |
| 跑酷二次冲线 | `podiumFinish` 返回 false,不覆盖成绩 | H7 |
| 未完赛玩家 | 排名垫底、`elapsedMs = +∞`、播报跳过 | H8 |
| 同毫秒并列 | `playerId` 字典序稳定,两次排序一致 | H9 |
| 播报队列为空 | `shiftBroadcast` 返回 null | H10 |
| 信箱溢出 | FIFO 丢最旧一条,`dropped++` | I7 |
| 售货摊货架满 / 数量 0 / 价格 < 1 / 未知物品 | `listItem` 返回 false | I8 |
| 跨房交易数量 > 999 | `QTY_INVALID` | I8 |
| 售罄 | 自动下架,`soldOut++` | I9 |
| 售货摊超量购买 | 按库存成交,`qty` 返回实际数 | I9 |
| 未进打盹就摸头 | `patDozing` 返回 0 | I4 |
| 打盹 10 分钟后 | 转 DEEP,速率 ×0.5 | I3 |
| 生态缸低于 24fps | `fallbackCount++`,由客户端退回静态机位 | I6 |

**并发冲突**

- 本子系统全部为**单线程事件式**接口:同一 session 的写入由房间 tick 串行化,不引入锁。
- `submitDelivery` / `bridgeCapture` / `crownPickup` 都设计为**幂等 + 拒绝重复**:重复调用返回 `false` 而不是重复加分,天然抗网络重放。
- 播报队列本身无上限;上层需按 §6.2 建议在 99 条处截断(`drainBroadcasts(b, 99)`)。

**网络抖动 / 断线重连**

- 所有时间来自注入时钟:重连时用「服务端权威时钟 + 客户端快照中的 `startedAtSec`」重建,不依赖客户端本地时间。
- 跑酷计时以服务端 `startMs`/`finishMs` 为准,客户端预测只是视觉平滑(WS-07 §4)。

---

## 8. 与其它子系统的耦合点

| WS | 耦合内容 | 方向 | 约束 |
| :--- | :--- | :--- | :--- |
| **WS-02** 物理 | `stackOffset` `carrierSpeedMul` `canPerfectCatch` `throwVelocity` `CARRY_Z_STEP` `THROW_SPEED_XY` `CATCH_RADIUS` | 读 | **不改任何 physics 文件**;叠罗汉/接球/射程判定全部委托冻结层 |
| **WS-01** 地形 | 无直接依赖 | — | 工位起火与地形解耦 |
| **WS-03** 建造 | 接力链的「拍地基」产出建造事件;桥板 ID 152 | 写事件 | 实际摆放由 WS-03 的 Auto-Tile 处理 |
| **WS-04** 生物 | `mob_beaver` 的偷料 AI;`mob_sound bat` 被三角铁干扰 | 写事件 | 河狸状态机在本模块,AI 寻路由 WS-04 驱动 |
| **WS-05** Boss | `canMountBossBack`、抢皇冠掉冠事件、222 击退 Boss | 写事件 / 读判定 | 不驱动 Boss 阶段机 |
| **WS-07** 网络 | `RushOrderSession` / `PartySettlement` / `Broadcast` 序列化 | 下游 | 结构需保持纯数据(无函数字段) |
| **WS-08** 电路 | 410 / 411 / 412 的触发点常量导出 | 读常量 | 四色推进由 WS-08 负责 |
| **WS-09** 客户端 | `Broadcast.text`、`VIVARIUM_CAMERA_SHOTS`、`WHITE_NOISE_MIX` 增益表 | 下游 | 不产出矩阵 |
| **WS-10** 战斗 | `enemyEffect.enemyDamage` 作为伤害输入;`revive.ts` 消费泡泡/雪球状态 | 上游输入 | 护甲/暴击由 WS-10 结算 |
| **Lead** | `verify.ts --only WS-11` | — | — |

**禁用耦合**

- 不 import `server/src/physics/**`、`server/src/combat/**`、`server/src/net/**`(避免循环依赖与 scope 越界)。
- 不 import `three`、`colyseus`、`better-sqlite3`(零运行时依赖)。

---

## 9. 验收用例

`tests/WS-11.test.ts` 共 **79 条**断言,`report('WS-11')` 输出 `79/79 通过`。分组对应关系:

| 组 | 条数 | 覆盖点 | 关键断言 |
| :--- | ---: | :--- | :--- |
| A 急单 | 7 | 订单池闭合 / 可复现 / 生成器真用 rng / 库存压力 / 交付判定 / 评级 / 3 分钟状态机 | **A2** 同 seed 两次 `JSON.stringify` 完全一致;**A7** 注入时钟 179s 仍在跑、180s 自动 `SETTLED` |
| B 工位 | 4 | 12 秒起火 / 翻炒打断 / **0.5 秒灭火** / 冒烟与灼烧 | **B1** 11.5s 仍 RUNNING,12.0s 转 BURNING 并抛 `STATION_FIRE`;**B3** 间断 0.4s 不灭火,连续 0.5s 必恢复并抛 `STATION_DOUSED` |
| C 河狸 | 4 | 4 秒偷 3 块 / 8 格/秒锤晕夺回 / 窗口过期 / 急单刷怪上限 | **C1** 库存 10 → 7;**C2** 冲量 7 被拒、冲量 8 敲晕、夺回后库存回 10、二次夺回返 0 |
| D 接力链 | 7 | 六环顺序 / 一次计分 / 越序 / 超时 / 接球落空 / 超射程 / 会话集成 | **D2** 整链 150 分且重复触发 `CHAIN_CLOSED` 不再加;**D3/D4/D5/D6** 四种中断原因各一 |
| E 叠罗汉 | 5 | 0.85 阶梯 / Z=2 采集 / 登 Boss 背 / 移速衰减 / 冻结层直连 | **E2** 2 人 1.15、3 人 2.00 都不够,4 人 2.85 才够 2.30;**E3** 双侧裕度 `gap3 = 0.30` / `gap4 = 0.55` 均 > 0.1;**E4** `0.85^3` 逐位对照 |
| F 玩具表 | 9 | 35 项 / 7 字段 / 零伤害 / 名称对齐 / 差异化 / 香蕉皮 / 泡泡三连 / 雪球 / 炸弹与药水 | **F1** ID 集合与 `[221..255]` 逐项相等;**F6** 打滑 5 格撞墙眩晕 1.2s;**F7** 第 3 发装泡泡 |
| G 平安盾 | 9 | 42 条清单 / 点名六项 / 35 项全免疫 / 关闭失效 / **Boss 不免疫** / 自用不拦 / 未知来源 / 计数 / **自伤独立路径** | **G2** 逐项独立断言 221/222/225/227/229/233;**G5** 7 类敌对来源全部 `NOT_IMMUNE`;**G9** 戴 218 + 戴 243 被自己闪电命中 → HP ≥ 15% 上限、`state ≠ GHOST_BUBBLE`、`shielded === false` |
| H 竞技 | 11 | 四模式配置 / 15-30 切换 / 进球播报 / 皇冠 60s / 掉冠冷却 / 涂色 120s / 涂色 rng / 跑酷毫秒 / DNF / 同毫秒 / 播报优先级 / 奖励 | **H1** 14.5s 仍 BUILD、15.0s 切 RACE、45.0s SETTLED;**H3** 59s 未胜、60s 胜;**H5** 120s 后红 27 / 蓝 18 / 黄 9;**H7** `12.345s` 毫秒级成绩与前三名播报 |
| I 社交 | 12 | 5 秒打盹 / 产露速率 / 深睡减半 / 摸头 / 回前台 / 生态缸 / 信箱 / 售货摊 / 售罄 / 马拉松 / 风筝惩罚 / 引用闭合 | **I2** 30 秒恰 1 滴,篝火 ×2,榻榻米 ×1.2;**I8** 跨房抽 5%;**I10** `65.432s` 毫秒计时 |
| J 一致性 | 10 | 四队常量 / 比分文案 / 网格边界 / 20Hz 与 2Hz 一致 / 会话结算 / 零真 sleep / 查表性能 / 冻结层未漂移 / rng 位级一致 / 模式隔离 | **J4** 三种步长起火次数都 = 1;**J6** 模拟 180 秒逻辑 < 2000ms;**J9** 200 个随机数逐位对照 `mulberry32` |

**手册验收清单逐条对账**

| 任务书要求 | 对应断言 | 状态 |
| :--- | :--- | :--- |
| 急单订单生成可复现 | A2 / A3 | ✅ |
| 12 秒起火与灭火计时 | B1 / B3 / J4 | ✅ |
| 河狸偷料与夺回 | C1 / C2 / C3 | ✅ |
| 投掷接力链成功 / 中断 | D2 / D3 / D4 / D5 / D6 | ✅ |
| 叠罗汉 Z=2 采集 | E1 / E2 / E3 | ✅ |
| 平安盾免疫清单逐项 | G2 / G3 / G5 | ✅ |
| **U10 自伤不受和平盾影响 + 不自锁** | G9 | ✅ |
| 香蕉皮打滑 5 格撞墙眩晕 | F6 | ✅ |
| 4v4 进球判定与比分播报 | H2 | ✅ |
| 皇冠 60 秒获胜 | H3 | ✅ |
| 涂色计分 | H5 | ✅ |
| 跑酷毫秒计时 | H7 / H8 / H9 / I10 | ✅ |
| 打盹攒露水速率 | I1 / I2 / I3 | ✅ |
| 泡泡三连困人 | F7 | ✅ |
| 雪球冰冻 3 秒 | F8 | ✅ |
| 35 种玩具全数据化且 ID 集合 = [221..255] | F1 / F2 / F3 / F4 | ✅ |

**执行命令**

```
cd 2_5d_sandbox
node tests/WS-11.test.ts              # [WS-11] 79/79 通过
node scripts/verify.ts --only WS-11   # 全绿
```

---

## 10. 未决问题与 Lead 裁决记录

> **状态说明**:U1 与 U10 已由 Lead 裁决并落地实现;U2–U9、U11、U12 十条调参项按本文档 §5 的取值**采纳**,下方逐条标注最终取值,便于终审对齐。所有「Lead 已采纳」条目均已反映在代码与 `tests/WS-11.test.ts` 中。

### 10.1 已裁决并已落地(2 条)

| # | 议题 | Lead 裁决 | 落地位置 | 验收断言 |
| :--- | :--- | :--- | :--- | :--- |
| **U1** | **已解决** ~~叠罗汉伸手高度:第一版 `STACK_REACH_Z = 0.25` 让 3 人梯只差 0.05 格,20Hz 浮点与坐标同步抖动足以误判~~ | **改常量,不改判定逻辑**。`Z2_REACH_TARGET = 2.30`(Z=2 层果实/机关的有效抓取高度,不再是平台面 2.0);`STACK_REACH_Z = 0.30`。3 人梯 `1.70 + 0.30 = 2.00 < 2.30`(差 0.30);4 人梯 `2.55 + 0.30 = 2.85 ≥ 2.30`(余 0.55)。两侧裕度都 > 0.1,设计意图保持 | `coop/rush_order.ts`:`STACK_REACH_Z = 0.30`、`Z2_REACH_TARGET = 2.30`、`Z2_FRUIT_HEIGHT = Z2_REACH_TARGET`、`BOSS_BACK_HEIGHT = Z2_REACH_TARGET`;`canReachHeight` 判定式一行未动 | **E1 / E2 / E3**(含 `gap3 = 0.30`、`gap4 = 0.55` 的 `inRange(0.1, 1.0)` 裕度断言) |
| **U10** | **已解决** ~~玩具 243 引雷铁锅头盔自伤:是否让和平盾挡住~~ | **保留自伤,加「不自锁」保护**。和平盾语义是「免疫**队友**的物理整蛊」,自伤不属此列,挡掉会让道具失去代价感并误导玩家预期。做法:① 自伤保留(1.5 秒感电麻痹 + 掉血),但 HP 硬顶 `max(1, ceil(15% × maxHp))`;② 自伤**永不触发**幽灵泡泡倒地;③ 自伤与队友伤害**分开两条代码路径**,注释写清「自伤不受和平盾影响」 | `prank/toys.ts`:`applySelfDamage(hp, maxHp, rawDamage)`(**签名无 `shieldOn`**)、`resolveHelmetSelfStrike`、`selfDamageHpFloor`、`SELF_DAMAGE_HP_FLOOR_RATIO = 0.15`、`HELMET_SELF_PARALYZE_SEC = 1.5`、`HELMET_SELF_DAMAGE = 45`;文档 §4.9b 为独立小节 | **G9**(戴 218 + 戴 243 被自己闪电命中 → HP ≥ 15% 上限、`state ≠ GHOST_BUBBLE`、`shielded === false`、`ghostBubble === false`;另含 5/50/75/76 四点硬顶边界) |

### 10.2 调参项(10 条,Lead 已采纳,取值为最终值)

| # | 最终取值 | 落地位置 | 说明 |
| :--- | :--- | :--- | :--- |
| **U2** | 订单单件分 `round(points / need)`(**Lead 已采纳**:保持现实现的「先乘后除再取整」,不做末位补差) | `coop/rush_order.ts` `deliverItem` | 每单最多 4 件,累计舍入误差 ≤ 2 分,对 `totalPoints` 量级可忽略;末位补差需在槽位里额外维护余数状态,复杂度不值得 |
| **U3** | `CHAIN_BREAK_PENALTY = 40`(**Lead 已采纳**:保持固定 40,不做按环递增) | `coop/rush_order.ts` | 单次成功 150 分 / 中断罚 40 分 = 3.75:1,连断 4 次才抵一次成功,惩罚有分量但不劝退;按环递增会让「第 1 环断」几乎无痛、规则难讲解 |
| **U4** | 河狸偷料 4 秒窗口内**无** `RESCUING` 中间态(**Lead 已采纳**:保持直接扣 `stock[151]`) | `coop/rush_order.ts` `tickBeaver` | 抢救态需 WS-04 提供河狸逐帧位置;当前 `mob_beaver` 的 AI 归 WS-04,跨 WS 同步未定型,先按「4 秒内打断」的简单模型交付 |
| **U5** | 掉冠冷却与抢冠冷却**共用** `CROWN_PICKUP_COOLDOWN_SEC = 5`(**Lead 已采纳**:不拆分) | `party/modes.ts` | 两个冷却在语义上都是「皇冠不可拾取」,共用常量让调参只有一处;拆分会引入两套计时器的同步问题 |
| **U6** | 涂色网格 `24×24 = 576` 格,`PAINT_BALL_RADIUS = 1`(3×3)(**Lead 已采纳**) | `party/modes.ts` | 单队满涂约 64 球,120 秒内 4 队争抢的节奏合适;场地放大需同步改半径,否则单球占比过小 |
| **U7** | 白噪音总增益 `1.12`,逻辑层用 `Math.min(1, t/fade)` 钳制(**Lead 已采纳**:保留逻辑层钳制,WS-09 可再加总线归一化) | `social/afk.ts` `tickVivarium` | 逻辑层钳制保证 `masterGain` 值域 ∈ [0, 1.12] 且淡入曲线单调;WS-09 若在总线加 `masterGain` 归一化,两者不冲突 |
| **U8** | 售货摊推荐价 `ceil(V_i × 1.6)`(**Lead 已采纳**:统一系数,不按分类分化) | `social/afk.ts` `suggestedPrice` | 统一系数让玩家一眼能算;Boss 遗物 V=250 → 400 偏高的问题交给玩家自主定价(推荐价只是默认值,可改) |
| **U9** | 急单 S 档时间奖励 `×1.15` 保留(**Lead 已采纳**),`totalPoints` 上限压到 4 位 | `coop/rush_order.ts` `settleRushOrder` | `totalPoints` 由 `V_i × need × 等级系数` 构成,4 单 × 4 件 × V≤85 时约 3400 分,乘 1.15 后 < 4000,4 位数字足够;WS-09 UI 按 4 位设计即可 |
| **U11** | `Broadcaster.queue` **不加**硬上限(**Lead 已采纳**:由上层限流) | `party/scoring.ts` `pushBroadcast` | 加硬上限会在关键时刻丢掉 `MODE_END` 之类最高优先级播报;改为要求上层每帧调用 `drainBroadcasts(b, 99)`,已在 §7 与 §6.2 写明 |
| **U12** | 风筝 Boss 跑道惩罚 3 秒**加在成绩上**(**Lead 已采纳**:不改为冻结计时器) | `social/afk.ts` `trackFinish` | 「罚时」比「罚站」对观战者更直观(名次直接反映),且不阻塞玩家操作;冻结计时器会让玩家在跑道上干等 3 秒,手感更差 |

### 10.3 仍需 WS 间协调(2 条,非阻塞)

| # | 事项 | 需协调方 | 当前状态 |
| :--- | :--- | :--- | :--- |
| C1 | U1 落地后 `STACK_REACH_Z = 0.30`、`Z2_REACH_TARGET = 2.30` 需 WS-09 在角色立牌臂展上做视觉对齐 | WS-09 | 数值已定,视觉待对齐;若美术要求改臂展,只改 `STACK_REACH_Z` 一个常量即可,判定逻辑不受影响 |
| C2 | U7 的音频总线归一化建议由 WS-09 在 `client/src/stage/` 实现 | WS-09 | 逻辑层已钳制,不归一化也不会削波 |

---

## 附:文件清单

| 文件 | 行数量级 | 职责 |
| :--- | ---: | :--- |
| `server/src/coop/rush_order.ts` | ~830 | 急单状态机、订单生成、工位起火、河狸、接力链、叠罗汉、会话 |
| `server/src/prank/toys.ts` | ~430 | 35 项玩具全量表、物理喜剧事件解算、自检 |
| `server/src/prank/immunity.ts` | ~250 | 42 条免疫清单、三档裁定、盾状态 |
| `server/src/party/scoring.ts` | ~400 | 计分板、播报队列、毫秒计时、涂色网格、奖励 |
| `server/src/party/modes.ts` | ~740 | 四大模式状态机 + 跑酷计时 + 结算 |
| `server/src/social/afk.ts` | ~470 | 打盹、生态缸、信箱、售货摊、跑道 |
| `tests/WS-11.test.ts` | ~1550 | 79 条断言 |