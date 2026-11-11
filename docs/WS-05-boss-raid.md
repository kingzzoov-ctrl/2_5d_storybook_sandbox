# WS-05 八大 Boss 破防战 — 细化设计

> 对应设计手册 §4.3;消费冻结层 `shared/constants/bosses.ts` 的 8 个 Boss 与 `bossScaledHp` 公式。
> 实现文件:`server/src/bosses/{raid,phases,breaks}.ts`;测试:`tests/WS-05.test.ts`(38 条断言)。
> 预警几何内核与 WS-04 **共用** `server/src/mobs/geometry.ts`(圆/扇/矩形/环/指针五类)。

---

## 1. 职责边界

**本子系统负责**

- **祭坛召唤**:8 个祭品(734~741)与 Boss 的一一映射、召唤前置条件校验;
- **人数血量缩放**:调用冻结函数 `bossScaledHp(baseHp, n)`,并保证 N=1..16 严格单调递增;
- **阶段状态机**:按 `hpThreshold` 推进阶段、重置施法冷却、维护阶段专属机制(分身 / 时间护盾);
- **招式预警几何**:8 个 Boss 的全部阶段逐招生成五类地面几何与结算时序;
- **八条沙盒机关破防**:每条落地为**返回 boolean 的纯函数**,输入是可观测的沙盒状态;
- **破防结算**:统一套用眩晕/瘫痪窗口与全队暴击加成;
- **个人独立掉落**:每位参战者各自获得一个仅本人可见可拾的光球。

**明确不负责**

- 掉落物的**物品数值本体**——战利品 ID 一律引用 `shared/constants/items.ts`;
- 野生生物 AI(`WS-04`,见 `docs/WS-04-mob-ai.md`);
- 伤害公式本体与抗性计算(`WS-06`):本模块只提供 `damageBoss` 的护盾吸收顺序;
- 房间匹配与人数统计(`WS-08`):本模块只读取传入的 `playerCount`;
- 机关方块本身的建造合法性(`WS-03`/`WS-07`):本模块只判定「地形是否已就绪」。

---

## 2. 上游 / 下游接口

**上游(引用冻结层符号,只读)**

| 来源 | 引用符号 | 用途 |
| :--- | :--- | :--- |
| `shared/constants/bosses.ts` | `BOSS_LIST` `BOSS_BY_ID` `TOTAL_BOSS_COUNT` `PARTY_MODES` `ROOM_RECIPES` | 8 个 Boss、祭品、战利品、破防原文 |
| `shared/types/entities.ts` | `BossDef` `BossPhase` `bossScaledHp` | 类型、人数缩放公式 |
| `shared/types/entities.ts` | `PARTY_BONUS=0.25` `PARTY_BONUS_THRESHOLD=3` `SHARE_EXP_RADIUS=24` | 团队加成与参与半径 |
| `shared/types/physics.ts` | `RADIUS_BOSS=1.20` `MASS_BOSS=20.0` `CARRY_MAX_DEPTH=4` | 碰撞半径、叠罗汉层数 |
| `shared/constants/items.ts` | 228 / 251 / 315 / 318 / 359 / 419 / 440 / 608 | 八条破防的机关物品 ID |
| `shared/types/tile.ts` | `wire` 层 / `hasWire` / `setWire` / `WireColor` | 四色电路通电判定 |
| `server/src/mobs/geometry.ts` | `WarnGeom` `insideWarn` `insideWarn3D` `circleWarn` `sectorWarn` `rectWarn` `ringWarn` `pointerWarn` | 五类预警几何(**跨 WS 共用**) |

**下游(本模块对外输出)**

| 输出 | 结构 | 消费方 |
| :--- | :--- | :--- |
| `summonBoss()` | `SummonResult{ ok, reason, state, scaledHp }` | 祭坛交互处理器 |
| `skillWarnGeoms()` | `WarnGeom[]` | 战斗结算 + 客户端预警渲染 |
| `evaluateBreak()` | `BreakResult{ ok, reason }` | 机关交互处理器(8 条统一入口) |
| `settleBreak()` | `{ stunSec, critBonus }` | 战斗系统:施加眩晕与全队暴击 |
| `rollPersonalLoot()` | `LootOrb[]` | 掉落系统:逐玩家下发光球 |
| `BossState` | 见 §3 | 全部下游(读血量/阶段/护盾/分身) |

---

## 3. 数据结构

```ts
/** Boss 运行时状态(唯一可变体)。 */
interface BossState {
  bossId: string; def: BossDef;
  hp: number; maxHp: number;          // maxHp 已含人数缩放
  x: number; y: number; z: number;    // 格;云鲸 P2 升到 z=2
  phaseIndex: number;                 // 0 基,对应 def.phases
  phaseSec: number;                   // 秒,当前阶段已持续时长
  castCd: number;                     // 秒,下次施法倒计时
  stunnedSec: number;                 // 秒,破防后的眩晕/瘫痪剩余
  shieldSec: number; shieldHp: number; // 时间护盾窗口与护盾血量
  healedBack: number;                 // 护盾未破时累计回血量
  clones: BossClone[];                // 妖狐分身
  breakAchieved: boolean;             // 破防是否已达成
  critBonus: number;                  // 破防窗口内全队暴击倍率增量
  casts: number;                      // 累计施法次数
  pointerDeg: number;                 // 克洛诺斯指针当前角(度,顺时针)
}

interface BossClone { id: number; x: number; y: number; isReal: boolean; chargeSec: number; }

/** 召唤请求 / 结果。 */
interface SummonRequest {
  bossId: string; itemId: number; hasAltar: boolean;
  playerCount: number; alreadyAlive: boolean;
}
interface SummonResult { ok: boolean; reason: SummonReject; state?: BossState; scaledHp: number; }

/** 参战者(个人掉落的输入)。 */
interface RaidParticipant {
  id: string;
  contributed: boolean;   // 是否参战(在 24 格参与半径内且造成过伤害)
  damageDealt: number;    // 累计伤害,用于加权数量
  x: number; y: number;
}

/** 个人独立掉落光球:仅 ownerId 可见可拾。 */
interface LootOrb {
  orbId: string;          // `${bossId}:${ownerId}`
  ownerId: string;
  x: number; y: number;   // 格,在参战者脚下 2.5 格内散布
  entries: { itemId: number; count: number }[];
  exp: number;
  personal: true;         // 恒定 true,标记「个人独立」
}
```

**八条破防的输入结构**(每条都是纯数据,可序列化、可单测):

| 破防 | 输入关键字段 |
| :--- | :--- |
| ① 果冻王 | `phaseIndex, suctionActive, feedItem, lit, distanceToMouth, mouthRadius` |
| ② 河狸 | `damPresent, channelIntact, gateOpened, upstreamHigher` |
| ③ 妖狐 | `clones[], instrumentItem, noteCircuitOn, instrumentReady` |
| ④ 巨蟹 | `floorUnder, speed, slidDistance, obstacleAhead, shellDr` |
| ⑤ 法老蝎 | `forces[], anchored[], aligned[]` |
| ⑥ 姜饼巨魔 | `trampolinePlaced, sugarBallRebounded, darkCuisineFed, containsMushroom, mouthOpen` |
| ⑦ 云鲸 | `crystalBroken[], boardingMethod, stackDepth, withinWindow` |
| ⑧ 克洛诺斯 | `circuitsOn[], platesPressed[], towerPowered, shieldActive` |

---

## 4. 算法与公式

### 4.1 祭坛召唤(短路校验,廉价优先)

```
summonBoss(req):
  1. BOSS_BY_ID 查不到                 → UNKNOWN_BOSS
  2. ¬hasAltar                          → NO_ALTAR
  3. req.itemId ≠ def.summonItem        → WRONG_ITEM
  4. playerCount ∉ [1, 16]              → TOO_MANY_PLAYERS
  5. alreadyAlive                        → BOSS_ALIVE
  else → createBossState, 返回缩放后 maxHp
```

### 4.2 人数血量缩放(冻结公式,不得改写)

```
bossScaledHp(baseHp, n) = round(baseHp × (1 + 0.65(n − 1)))     , n ← max(1, n)
```

**单调性证明**:斜率 `0.65 × baseHp`;最小 baseHp 为 2500 → Δ = 1625 每档,远超 `round` 的 ±0.5 误差。故 n ≥ 1 时**严格递增**。

关键值(逐点与冻结函数比对,`W5-03` 断言 N=1..16 全部一致):

| Boss | baseHp | N=1 | N=4 | N=16 |
| :--- | ---: | ---: | ---: | ---: |
| 果冻国王 | 2500 | 2500 | 7375 | 26875 |
| 机甲河狸 | 4800 | 4800 | 14160 | 51600 |
| 千年妖狐 | 7500 | 7500 | 22125 | 80625 |
| **深渊巨蟹** | **11000** | 11000 | 32450 | **118250** |
| 法老蝎 | 15000 | 15000 | 44250 | 161250 |
| 姜饼巨魔 | 20000 | 20000 | 59000 | 215000 |
| 星穹云鲸 | 26000 | 26000 | 76700 | 279500 |
| **时间巨像** | **38000** | 38000 | 112100 | **408500** |

手算校验:`11000 × (1 + 0.65×15) = 11000 × 10.75 = 118250`;`38000 × 10.75 = 408500`。

**边界语义**:`N=0` 与负值被钳到 `n=1`;小数人数**不取整**(`bossScaledHp(11000, 1.9) = 17435`),调用方需自行传整数——`W5-06` 明确记录该语义。

### 4.3 阶段推进

```
phaseIndexFor(def, hpRatio):
  idx ← 0
  for i in 0..phases.length−1:
      if hpRatio ≤ phases[i].hpThreshold + 1e-9: idx ← i     # 取最后一个满足者
  return idx
```

阈值递减 ⇒ 等价于「越过下一档即切换」;`+1e-9` 使「恰好等于阈值」判为**已进入下一阶段**(如巨蟹 50% 判 P2)。血量归零 → 末阶段。

`tickBoss` 每帧顺序:

1. **眩晕优先**:`stunnedSec > 0` → 递减并保持 `critBonus`,**不推进阶段、不施法、不产生几何**;
2. 按 `hp / maxHp` 求 `phaseIndex`,变化则重置 `phaseSec / castCd / pointerDeg`,并初始化阶段专属机制;
3. 克洛诺斯 P1 指针 `pointerDeg += 30·dt`;云鲸 P2 `z = 2`;
4. **时间护盾窗口**(切阶段那一帧不递减,保证窗口严格 8.00s):

```
if shieldSec > 0 ∧ ¬switched:
    shieldSec −= dt
    if shieldSec == 0 ∧ ¬breakAchieved:
        hp += round(maxHp × 0.20)        # 未切断供能 → 回血
```

5. 施法冷却 `castCd −= dt`;到点则 `casts += 1` 并重置冷却。

### 4.4 五类预警几何(逐 Boss 逐阶段)

| Boss | 阶段 | 几何 | 参数 | 预警 |
| :--- | :--- | :--- | :--- | :--- |
| 果冻王 | P1 | 圆环 | 内径 2.5 / 外径 3.5 | 0.8s |
| | P2 | 6 个圆 | 半径 1.2,六边形等分 2.5 格 | 0.8s |
| | P3 | 扇形 | 45°(半张角 22.5°),长 6 | 1.5s |
| 河狸 | P1 | 矩形 | 长 12 / 宽 2(朝向玩家) | 1.0s |
| | P2 | 矩形 | 5×3 木坝掩体区 | 0.8s |
| 妖狐 | P1 | 3×扇形 | 各 30°(半张角 15°),长 8,互隔 25° | 0.9s |
| | P2 | 4×圆 | 半径 2,4 分身各一 | 1.0s |
| 巨蟹 | P1 | 2×矩形 | 宽 0.8 / 长 10,左右各偏 20° | 0.5s |
| | P2 | 圆 | 半径 1.2(弹射) | 0.4s |
| 法老蝎 | P1 | 圆 | 半径 5(向心吸附) | 2.0s |
| | P2 | 矩形 | 1.6×0.35(仅露毒尾,**无大红圈**) | 0.3s |
| 姜饼巨魔 | P1 | 圆 | 半径 4(减速沼泽) | 1.2s |
| | P2 | 圆 | 半径 1.5(锁定持食者) | 0.9s |
| 云鲸 | P1 | 圆环 | 环宽 3 格(9~12) | 1.0s |
| | P2 | 扇形 + Z | 60°(半张角 30°),长 14,**z=2** | 1.5s |
| 克洛诺斯 | P1 | **旋转指针** | 长 12 / 宽 1,30°/s 顺时针 | 0.5s |
| | P2 | 4×环 + 1×圆 | 四角环 0.8~1.5;中央塔半径 2.5 | 0.8s |
| | P3 | 矩形 | 24×24 全场预闪 | 0.6s |

五类几何的**点在几何内**判定见 `docs/WS-04-mob-ai.md` §4.4(共用内核,相对容差 `GEOM_EPS=1e-12`,「恰好边界」true、「差 1e-9」false)。

### 4.5 八条破防的布尔判定

| # | Boss | 判定函数 | 全部满足条件 | 关键否定边界 |
| :--- | :--- | :--- | :--- | :--- |
| ① | 果冻王 | `jellyBreakReady` | `phaseIndex===2` ∧ 吸气中 ∧ 距离 ≤ 嘴半径 ∧(炸弹果 ∧ 已点燃 **或** 荆棘地垫) | 未点燃的炸弹果 → false;P1/P2 → false;超嘴半径 1e-9 → false |
| ② | 河狸 | `beaverBreakReady` | 木坝在 ∧ **引水渠完整** ∧ 拉闸放水 ∧ 上游高于坝体 | **渠道缺一格 → false**;未拉闸 → false |
| ③ | 妖狐 | `foxBreakReady` | 存在分身 ∧(小号 ∧ 乐器可用 **或** 音符砖电路通电) | 无分身 → false;乐器冷却 → false;非小号 → false |
| ④ | 巨蟹 | `crabSlideBreak` | 冰砖(315,μ=0.98)∧ 滑行 ≥ 4 格 → `uncontrolled`;再 ∧ 前方 359 ∧ 速度 ≥ 8.0 → `shattered`,`shellDr 0.90 → 0`,`stun 6.0s` | 滑 3.999 格 → 不失控;撞普通石块 → 不碎壳;速度 8.0−1e-9 → 仅擦碰 |
| ⑤ | 法老蝎 | `pullBreakReady` | 有效人数 ∈ [2,4] ∧ 合力 ≥ 2.0;有效 = 挂稳 ∧ 共线 | 单人 → `too_few`;5 人 → `too_many`;一人未挂稳 → 有效人数掉到 1;侧拉不算 |
| ⑥ | 姜饼巨魔 | `gingerBreakReady` | (蹦床 ∧ 糖球反弹) **或** (黑暗料理 ∧ 含变身菇 ∧ 张嘴) | 铺蹦床但未反弹 → false;料理无变身菇 → false;未张嘴 → false |
| ⑦ | 云鲸 | `whaleBreakReady` | 登背合法(飞艇 **或** 叠罗汉 4 层)∧ **3 颗雷晶全碎** ∧ 6 秒窗口内 | 只碎 2 颗 → false;叠 3 层 → false;超窗口 → false |
| ⑧ | 克洛诺斯 | `chronosBreakReady` | **四色齐备**(电路通 ∧ 压力板压)∧ 中央塔通电 ∧ 护盾仍在 | **三缺一 → false 并精确报出缺失颜色**;塔未通电 → `tower_unpowered` |

统一入口 `evaluateBreak(bossId, input)` 保证调用方**永远拿到一个确定结论**(未知 Boss 返回 `{ok:false, reason:'unsupported'}` 而非抛异常)。

### 4.6 破防结算

```
settleBreak(state, bossId):
  assert state.bossId === bossId            # 防跨 Boss 套用时长
  stunSec   = BREAK_STUN_SEC[bossId]        # 6/6/5/6/6/8/8/6 秒
  critBonus = 1.00                          # 全队暴击 +100%
  state.stunnedSec ← stunSec
  state.shieldSec ← 0; shieldHp ← 0         # 护盾被击穿
  if 妖狐: clones ← []                      # 震碎所有假分身
```

眩晕窗口内 `tickBoss` 完全停摆(无施法、无几何),`critBonus` 保持;窗口结束后归零,且**不回血**。

### 4.7 个人独立掉落

```
rollPersonalLoot(bossId, participants, { partyBonus, dropMul }):
  参战者 = participants 中 contributed = true 的子集
  totalDamage = Σ damageDealt
  for each 参战者 p:
      share = damageDealt / totalDamage          (全为 0 时退化为 1/n)
      rng   = seededRoll(fnv1a(`${bossId}|${p.id}`))   # 确定性:同输入同结果
      entries = def.loot.map(itemId ⇒ 1 + floor(share×2) + (rng()<0.35 ? 1 : 0))
      exp     = round(def.exp × share × (1 + partyBonus))
      orbId   = `${bossId}:${p.id}`               # 唯一
      personal = true
```

**核心不变量**:8 人 → 恰好 **8 个球**,`orbId` 与 `ownerId` 各自唯一,`canLoot(orb, id, afk)` 仅当 `id === ownerId` 且非挂机时为 true。

---

## 5. 参数配表

| 参数 | 值 | 单位 | 出处 |
| :--- | :--- | :--- | :--- |
| `SUMMON_ITEM_MIN/MAX` | 734 / 741 | ID | 手册 §3.10 祭品段 |
| `RAID_MIN/MAX_PLAYERS` | 1 / 16 | 人 | 任务书:`PARTY_MODES` 上界 16 |
| `RAID_PARTICIPATION_RADIUS` | 24 | 格 | 与冻结 `SHARE_EXP_RADIUS` 对齐 |
| 缩放系数 | 0.65 | — | 冻结 `bossScaledHp` |
| `BREAK_STUN_SEC` | 6/6/5/6/6/8/8/6 | 秒 | 冻结 Boss 表 `breakMechanic` 原文(果冻王「眩晕 6 秒」) |
| `BREAK_CRIT_BONUS` | 1.00 | × | 本设计:破防窗口全队暴击 +100% |
| `TIME_SHIELD_SEC` | 8.0 | 秒 | 冻结 Boss 表克洛诺斯 P2 原文「8 秒内未切断供能则回血」 |
| `TIME_SHIELD_HEAL_RATIO` | 0.20 | — | 本设计:回血上限 |
| `FOX_CLONE_COUNT` | 4 | 个 | 冻结 Boss 表妖狐 P2 原文「4 个分身」 |
| `JELLY_SPLIT_COUNT` | 6 | 只 | 冻结 Boss 表果冻王 P2 原文「分裂成 6 只」 |
| `ICE_MU` | 0.98 | — | 物品表 315 note 原文「μ=0.98 极度打滑」 |
| `CRAB_SHELL_DR` | 0.90 | — | 冻结 Boss 表巨蟹 P1 原文「减免 90% 伤害」 |
| `CRAB_UNCONTROLLED_DISTANCE` | 4.0 | 格 | 本设计:失控阈值 |
| `CRAB_SHATTER_SPEED` | 8.0 | 格/秒 | 本设计:碎壳所需撞墙速度 |
| `OBSIDIAN_WALL_STUN_SEC` | 6.0 | 秒 | 与 `BREAK_STUN_SEC` 对齐 |
| `PULL_MIN/MAX_PLAYERS` | 2 / 4 | 人 | 冻结 Boss 表法老蝎原文「2~4 名玩家」 |
| `PULL_FORCE_PER_PLAYER` | 1.0 | — | 本设计:单人拉力上限 |
| `PULL_FORCE_THRESHOLD` | 2.0 | — | 本设计:合力阈值 |
| `PULL_COOP_WINDOW_SEC` | 1.0 | 秒 | 本设计:协作窗口 |
| `WHALE_CRYSTAL_COUNT` | 3 | 颗 | 冻结 Boss 表云鲸原文「背上 3 颗寄生雷晶」 |
| `WHALE_CRYSTAL_WINDOW_SEC` | 6.0 | 秒 | 本设计:同窗口击破 |
| `CARRY_MAX_DEPTH` 引用 | 4 | 层 | 冻结 `physics.ts`:叠罗汉上限 |
| `CHRONOS_CIRCUIT_COUNT` | 4 | 路 | 冻结 Boss 表克洛诺斯原文「四角红/蓝/黄/绿」 |
| `LOOT_SCATTER_RADIUS` | 2.5 | 格 | 本设计:光球散布半径 |
| 双倍掉落概率 | 0.35 | — | 与物品 603 词条「35% 几率翻倍」同源 |

---

## 6. 帧预算 / 性能

### 6.1 单 Boss 招式生成的每帧成本

| 阶段(几何复杂度) | 生成次数 | 单次成本 | 小计 |
| :--- | :--- | :--- | :--- |
| 简单(1 个圆/矩形/指针) | 1 | ~40 ns | 40 ns |
| 中等(2~3 个扇形/矩形) | 3 | ~40 ns | 120 ns |
| 复杂(6 圆 或 4 环+1 圆) | 6 | ~45 ns | 270 ns |
| `tickBoss` 状态推进 | 1 | ~50 ns | 50 ns |
| **单 Boss 单帧合计** | | | **≈ 320 ns(最坏)** |

### 6.2 极端上界:8 个 Boss 同屏 + 16 人团队

实测(`W5-35`,2000 帧 × 8 Boss)= 16000 次 `tickBoss` + 16000 次 `skillWarnGeoms`:

- 断言 **8 Boss 同屏单帧 < 500 µs**(实测约 30~60 µs);
- 断言 **单 Boss 单帧 < 63 µs**(实测约 4~8 µs)。

单帧预算 50 ms → 8 Boss 同屏占用 **< 0.12%**。这是**刻意夸张的上界**(实际同一房间只会有一个激活 Boss),因此真实占用 < 0.02%。

### 6.3 结算链路成本

| 操作 | 复杂度 | 说明 |
| :--- | :--- | :--- |
| `insideWarn(g, px, py, t)` | O(1) | 最多 1 次 sqrt + 2 次三角函数 |
| `rejectByBounds` 粗筛 | O(1) | 外接圆 + Z 容差剔除,先淘汰远处目标 |
| 8 人 × 20 个几何的结算 | 160 次 O(1) | ≈ 13 µs/帧 |
| `rollPersonalLoot`(仅击杀瞬间) | O(n·loot) | 8 人 × 3 件 = 24 次,一次性 |

### 6.4 内存

`BossState` ≈ 400 B;8 个 Boss 同时存在 ≈ 3.2 KB;`LootOrb` 每个 ≈ 220 B,16 人 × 3 件 ≈ 10 KB。相对 1 GB 约束可忽略。

---

## 7. 异常与边界

| 场景 | 处理 |
| :--- | :--- |
| 未知 `bossId` | `createBossState` 抛错(编程错误);`evaluateBreak`/`rollPersonalLoot` 返回 `false`/`[]`(数据错误) |
| 祭品不匹配 | `WRONG_ITEM`,不消耗祭品 |
| 无祭坛方块 | `NO_ALTAR`,在祭品校验**之前**返回 |
| **祭坛落在城镇安全区内** | **`SAFE_ZONE` 召唤失败**(详见 §7.1);检查先于祭品校验 |
| 人数 0 / 17 | 钳制:缩放函数钳到 1;召唤校验直接拒绝 |
| 小数人数 | 缩放函数**不取整**(记录语义);生产路径只传整数 |
| 血量恰好等于阈值 | 判为**已进入下一阶段**(`+1e-9`) |
| 血量归零 | `phaseIndexFor` 返回末阶段;不再有下阶段 |
| 阶段倒退攻击 | `phaseIndexFor` 只返回最后一个满足者,天然单调 |
| 破防发生在护盾窗口内 | `applyBreak` 置 `shieldSec = 0`、`shieldHp = 0`,回血不发生 |
| 护盾窗口跨切阶段 | 切阶段那一帧不递减,避免窗口被吞掉 1 帧 |
| 护盾伤害溢出 | 先吃护盾,余量进本体;护盾碎时同步关闭窗口 |
| 眩晕期间再破防 | `settleBreak` 幂等:重置 `stunnedSec` 与 `critBonus`,不叠加 |
| `settleBreak` 传入错 Boss | **抛错**——防止跨 Boss 套用错误时长 |
| **Boss 被拉进安全区** | **照常受伤,不受 `safeZoneShield` 保护**(详见 §7.1) |
| 0 人参战 / 全员挂机 | `rollPersonalLoot` 返回 `[]`;`orbCountFor` 返回 0 |
| 未参战者 | 不产出光球(不参与 `contributed` 过滤) |
| 全员 0 伤害 | 退化为均分 `1/n`,不产生除零 |
| 非本人拾取 | `canLoot` 返回 false;挂机者亦不可拾 |
| 几何参数越界 | `W5-37` 逐 Boss 逐阶段校验:半径 > 0、半张角 ∈ (0,180)、环内径 < 外径 |
| 浮点边界 | 相对容差 `GEOM_EPS=1e-12`;「恰好边界」true、「差 1e-9」false,各有断言 |
| 网络抖动 | 本模块无网络状态;`BossState` 可整体序列化下发,重连后重建 |

### 7.1 城镇安全区与 Boss 战的三条规则(Lead 裁决 3,已落地 + 全部有断言)

安全区护盾(`spawner.ts#safeZoneShield`,`SAFE_SHIELD_MULT = 1.0`)的**受益方是玩家**,不是怪。三条规则彼此独立,必须同时成立:

| # | 情形 | 规则 | 理由 | 断言编号 |
| :--- | :--- | :--- | :--- | :--- |
| 一 | **祭坛在安全区内** | **召唤失败**,返回 `SpawnReject.SAFE_ZONE` | `spawner.ts` 已有语义:安全区禁刷怪。Boss 也是怪,同规则 | **`W5-02b`**(6 条) |
| 二 | **Boss 被拉进安全区** | **不受 `safeZoneShield` 保护**,照常吃满伤害 | 护盾是给玩家的。怪进安全区说明玩家引怪失误,不能因此让 Boss 变无敌 | **`W5-02c` + `W4-49c`** |
| 三 | **玩家在安全区内** | **正常受护盾保护**(全额吸收) | 手册 `535 岛主领地守护图腾` 原文:护盾受益方明确是玩家 | **`W4-49` + `W4-49c`** |

**落地方式**

1. **单一事实源**:安全圆判定抽为 `spawner.ts#isInsideSafeRadius(x, y, cx, cy, radius)`;
   `inSafeZone(world,x,y)`(刷怪路径)与 `summonBoss`(召唤路径)**共用同一函数**,
   杜绝「刷怪说在区外、召唤说在区内」的双标准。`W4-49b` 用 10 个探针点逐点断言两版一致。
2. **召唤校验链**扩为:未知 Boss → 无祭坛 → **安全区** → 祭品不匹配 → 人数越界 → 已存活。
   安全区检查放在祭品校验**之前**,与刷怪的短路顺序一致(`W5-02b` 断言该优先级)。
3. **唯一对外入口** `spawner.ts#applySafeZoneShield(world, x, y, incoming, isBoss)`,
   `isBoss` 为**必填显式参数且无默认值**:

```ts
export function applySafeZoneShield(
  world: SpawnWorld, x: number, y: number, incoming: number, isBoss: boolean,
): number {
  if (isBoss) return incoming;          // ← 显式短路,不依赖调用方
  return safeZoneShield(world, x, y, incoming);
}
```

**为什么 `isBoss` 必须显式传、且禁止加默认值**

`SAFE_SHIELD_MULT = 1.0` ⇒ `incoming × (1 − 1.0) = 0`。若把护盾误接到 Boss 受伤路径,
**Boss 在安全区内完全免伤**——把 Boss 引到城镇附近即可无敌,整场 Boss 战直接崩掉。
这类「沉默失效」错误(不抛异常、数值静默变 0)最难排查,因此把约束放在**签名层面**:
调用方少传一个参数直接编译/运行报错,而不是靠「记得不要对 Boss 调用」。
`W4-49c` 用 `applySafeZoneShield.length === 5` 锁死元数,堵住「加个 `isBoss = false` 默认值
让调用更省事」这条退化路径。

**误用排查结论(侦察记录)**:改造前全仓库检索确认 `safeZoneShield` 只被定义、仅被
`tests/WS-04.test.ts` 调用,**未接进任何真实伤害路径**;`raid.ts` / `phases.ts` / `breaks.ts`
完全不引用 `safeZoneShield`、`SAFE_SHIELD_MULT`、`inSafeZone`。**原先无真 bug,但无任何机制
阻止将来被误接** —— 现在由 `isBoss` 显式参数 + 元数断言双重封堵。

> **落点说明**:`applySafeZoneShield` 未放入 `server/src/combat/damage.ts`。该文件属 WS-06
> 写手的活跃 scope,且其抽象基于 `TargetProfile`/`AttackInput`、**不含 `SpawnWorld` 依赖**,
> 就地接入会引入跨层耦合。伤害管线在调用 `applyDamage` 后按本函数返回值缩放即可,
> **位置不影响契约**:关键在 `isBoss` 显式参数与那条 Boss 反例断言。



---

## 8. 与其它子系统的耦合点

| 对接方 | 耦合内容 | 方向 |
| :--- | :--- | :--- |
| **WS-04 野生生物** | **共用** `mobs/geometry.ts` 五类预警几何内核与 `insideWarn*`;`BREAK_STUN_SEC` 与 `breaks.ts` 的 6 秒对齐 | 双向(几何内核由 WS-04 提供) |
| **WS-03 物品与合成** | 祭品 734~741、机关物品 228/251/315/318/359/419/440/608、战利品 ID 全部只读引用 | WS-03 → 本模块 |
| **WS-06 战斗与伤害** | `damageBoss` 提供护盾吸收顺序;`settleBreak` 输出 `critBonus` 供伤害公式乘算 | 双向 |
| **WS-07 机关与建筑** | 冰砖铺设、黑曜石城墙、蹦床、四色电路与压力板、飞艇的建造与状态 | WS-07 → 本模块(`evaluateBreak` 的输入) |
| **WS-08 房间与人数** | `playerCount` 决定缩放;`PARTY_MODES` 上界 16;参与半径 24 格 | WS-08 → 本模块 |
| **WS-09 表现层** | `skillWarnGeoms` 驱动地面预警圈渲染;几何的 `kind` 直接映射到画笔 | 本模块 → WS-09 |
| **WS-10 掉落与成就** | `rollPersonalLoot` 输出光球;`BEAM_*` 事件名驱动成就(如「零破防速通」) | 本模块 → WS-10 |
| **WS-11 主城与安全区** | 祭坛所在位置需在安全区**之外**(否则被 WS-04 的 `SAFE_ZONE` 逻辑禁止刷怪) | WS-11 ↔ WS-04 |

**跨 WS 一致性风险**:WS-04 的 `TOWN_SAFE_RADIUS=24` 会阻止野生怪刷新;祭坛若落在安全区内,召唤出的 Boss 是「非自然刷新」故不受影响,但需要在实现层确认。已记入 §10 未决。

---

## 9. 验收用例

`tests/WS-05.test.ts` 共 **38 条断言**,全部通过。与任务书验收条目一一对应:

| # | 断言 | 用例编号 |
| :--- | :--- | :--- |
| 1 | 8 个 Boss、**祭品 734-741** 一一映射无重无缺 | `W5-01` |
| 2 | 祭坛召唤:正确祭品成功;错祭品/无祭坛/超人数/已存活被拒 | `W5-02` |
| 2b | **祭坛落在安全区(0,0) 半径 24 内 → `SAFE_ZONE` 失败**;恰好 24 格含边界、24+1e-6 放行;安全区优先于祭品校验 | `W5-02b` |
| 2c | **Boss 在安全区内仍吃满伤害**(护盾为玩家专属,不得误用于怪) | `W5-02c` |
| 3 | **`bossScaledHp` N=1..16 严格单调递增**(8 个 Boss 全表) | `W5-03` |
| 4 | **`bossScaledHp(11000, 16) = 118250`** | `W5-04` |
| 5 | **`bossScaledHp(38000, 16) = 408500`** + 全表 N=16 摘要 | `W5-05` |
| 6 | 缩放边界:N=0/负值钳到 1;小数不取整语义 | `W5-06` |
| 7 | 阶段切换:跨阈值推进,阈值含等号(+1e-9) | `W5-07` |
| 8 | **五类几何齐备(圆/扇/矩形/环/指针)** | `W5-08` |
| 9 | 果冻王 P1 环形波:环内命中、环心与环外安全、双边界 1e-9 | `W5-09` |
| 10 | 果冻王 P2 六分裂 / P3 巨口吸气扇形 | `W5-10` |
| 11 | 河狸 P1 长 12 宽 2 矩形 / P2 木坝 5×3 | `W5-11` |
| 12 | 妖狐 P1 三道 30° 风刃 / P2 四分身 | `W5-12` |
| 13 | 巨蟹 P1 双钳射线 / P2 弹射圆 | `W5-13` |
| 14 | 法老蝎 P1 流沙漩涡 / P2 仅露毒尾无大红圈 | `W5-14` |
| 15 | 云鲸 P1 环宽 3 / P2 Z=2 高空 60° 扇形 | `W5-15` |
| 16 | **克洛诺斯 P1 旋转指针**(30°/s)/ P2 四角四色环 / P3 全场改写 | `W5-16` |
| 17 | 阶段推进重置施法冷却与计时 | `W5-17` |
| 18 | 时间护盾 8 秒未破则回血;破防则回血取消 | `W5-18` |
| 19 | 护盾吸收伤害:先吃护盾再扣血 | `W5-19` |
| 20 | **破防后的眩晕窗口时长与全队暴击加成**(8 个 Boss 逐条核对) | `W5-20` |
| 21 | 破防结算一致性:Boss 不匹配必须抛错 | `W5-21` |
| 22 | **破防① 炸弹喂嘴**(未点燃/未吸气/P1 均不成立) | `W5-22` |
| 23 | **破防② 开闸放水冲坝**(渠道缺一格不破) | `W5-23` |
| 24 | **破防③ 小号破幻分身**(无分身/乐器冷却不成立) | `W5-24` |
| 25 | **破防④ 冰砖溜蟹撞黑曜石墙**(μ=0.98 失控、碎壳、防御 90%→0、眩晕 6 秒) | `W5-25` |
| 26 | **破防⑤ 飞索拔河拽出沙面**(1 人不足 / 5 人超限 / 未挂稳不算) | `W5-26` |
| 27 | **破防⑥ 蹦床反弹 + 黑暗料理投喂**(两条并行路径) | `W5-27` |
| 28 | **破防⑦ 飞艇/叠罗汉登背敲雷晶**(只碎 2 颗不破) | `W5-28` |
| 29 | **破防⑧ 四角四色电路通电破时间护盾(三缺一不破,逐色验证)** | `W5-29` |
| 30 | 八条破防统一入口:返回严格 boolean 且覆盖 8 个 Boss | `W5-30` |
| 31 | **端到端串联**:三缺一 → 补四色 → 破盾 → 眩晕 → 暴击 → 输出窗口 → 窗口结束 | `W5-31` |
| 32 | **个人独立掉落:8 人各得一球、球互不相同、仅本人可拾** | `W5-32` |
| 33 | 个人掉落边界:0 人 / 未参与者 / 单人 | `W5-33` |
| 34 | 掉落可复现 + 3 人以上 +25% 经验加成 | `W5-34` |
| 35 | **性能:8 Boss 同屏 16 人团队的每帧生成开销** | `W5-35` |
| 36 | 几何剔除加速与 Z 层判定 | `W5-36` |
| 37 | 全 Boss 技能几何参数域合法(半径>0、扇角∈(0,180)、环内<外) | `W5-37` |
| 38 | 与群系耦合:8 Boss 分属 8 群系、阶段阈值单调不增 | `W5-38` |

验证命令:`node scripts/verify.ts --only WS-05`。

---

## 10. 未决问题

1. **破防眩晕窗口的时长来源**:当前 6/6/5/6/6/8/8/6 秒中,只有果冻王的「6 秒」是冻结表原文,其余为本设计推定。是否需要在 `docs/CHANGE_REQUESTS.md` 申请把精确时长写入冻结层?
2. **`BREAK_CRIT_BONUS = 1.00`(+100%)的数值平衡**:八条破防共用同一系数。强度最高的克洛诺斯与最弱的果冻王是否应差异化?
3. **个人掉落的经验份额分配**:当前按伤害份额。治疗/辅助职业无伤害 → `share ≈ 0` → 经验极低。是否应改为「参与即均分」或引入贡献权重?
4. **`contributed` 的判定阈值**:当前由调用方传入。需要明确「造成多少伤害才算参战」以及「中途加入/中途离开」的边界。
5. **天降 AI 炼金装备的掉落耦合**:物品 708/723 等 Boss 遗物可参与炼金配方。个人掉落是否需要为 AI 炼金产物预留独立光球通道?
6. **克洛诺斯 P2 护盾回血的数值**:当前 `maxHp × 0.20`。8 秒窗口 + 20% 回血是否惩罚过重?需实测。
7. **`evaluateBreak` 的输入类型安全**:当前用 `as` 断言强制转型。若上游传入结构不匹配的对象会静默返回 false。是否需要运行时字段校验(会增加每帧开销)?
8. **云鲸 P2 的 Z 层判定**:`zTolerance=1.6` 意味着地面玩家(z=0)仍可能被判命中 Z=2 的吐息。是需要**强制要求**玩家在 Z=2 才能受伤,还是保留容差以容纳跳跃?
9. **祭坛与安全区的关系**:若祭坛位于 `TOWN_SAFE_RADIUS=24` 内,召唤出的 Boss 是否应受安全区护盾保护玩家?当前未定义,需与 WS-04/WS-11 对齐。
10. **`rollPersonalLoot` 的 `dropMul` 与物品 603 词条**:当前 35% 翻倍概率硬编码;若玩家装备「绯樱蜜桃果酱派」(掉落翻倍),应通过 `dropMul` 还是修改概率传入?
