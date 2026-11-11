# WS-02 · 2.5D 伪三维刚体物理与举投系统 细化设计

> 上游契约:`shared/contracts/FREEZE.md`、`shared/types/physics.ts`、`shared/constants/items.ts`
> 实现:`server/src/physics/world.ts`、`server/src/physics/carry.ts`
> 测试:`tests/WS-02.test.ts`(42 条断言,全部通过)

---

## 1. 职责边界

**本子系统负责**

- 20Hz 刚体世界的 `step(dt)`:位置/速度积分、地形摩擦查表、外力(加速带/传送带/漩涡);
- 地砖机关的物理效果:蹦床弹射、火炭灼烧、荆棘流血、落穴延迟;
- 圆形刚体两两碰撞与地形墙壁反弹;
- 举投系统:举起链、4 层叠罗汉、抛物线投掷、完美接球、掼摔/击退冲量与平安盾免疫;
- 数值稳定性兜底:子步拆分、边界钳制、非有限值复位。

**本子系统明确不负责**

- 地形存储与位压缩 —— 属 WS-01,本模块通过 `PhysTerrain` 结构化接口只读访问;
- 伤害结算与血量扣减 —— 属 WS-04 战斗;本模块只产出「每秒灼烧 15 点」的**速率事件**,不扣血;
- 物品栏、装备、平安盾的开关 UI —— 属 WS-07;本模块只接收 `shield: boolean`;
- 动画插值、相机、拖影 —— 属 WS-09;
- 网络同步与预测回滚 —— 属 WS-08;本模块保证 `step(dt)` 是纯确定性函数(给定相同输入与相同浮点环境)。

**边界纪律**:本模块**不写地形**。所有地形交互都是「查询 + 产生特效事件」,实际的方块放置由 WS-01 或玩法层负责。

---

## 2. 上游 / 下游接口

### 2.1 引用的冻结层符号

| 符号 | 用途 |
| :--- | :--- |
| `TICK_HZ` / `DT` | 20Hz / 0.05s |
| `GRAVITY` | −18.0 格/秒² |
| `THROW_SPEED_XY` / `THROW_SPEED_Z` | 8.5 / 6.0 |
| `CARRY_Z_STEP` / `CARRY_MAX_DEPTH` / `CARRY_SLOWDOWN` | 0.85 / 4 / 0.85 |
| `CATCH_RADIUS` / `CATCH_Z_MIN` / `CATCH_Z_MAX` | 0.8 / 0.3 / 1.4 |
| `RADIUS_*` / `MASS_*` | 0.35/0.40/1.20;1.0/3.0/20.0 |
| `BASE_MOVE_SPEED` / `BASE_HP` / `BASE_ATK` | 4.5 / 100 / 10 |
| `BodyState` / `DynamicBody` / `createBody` | 七态状态机与刚体结构 |
| `integrateHorizontal` | 水平摩擦与外力积分 |
| `integrateVertical` | 垂直积分与落地钳制 |
| `throwVelocity` | 抛物线初速度 |
| `stackOffset` / `carrierSpeedMul` | 叠罗汉高度/移速 |
| `canPerfectCatch` | 完美接球判定 |
| `resolveCircleBounce` | 圆形刚体弹性反弹 |

**全部积分都由冻结层承担**,本模块只做组织与规则,不重新定义任何常数。

### 2.2 与 WS-01 的接口(`PhysTerrain`)

```ts
interface PhysTerrain {
  floorSlotAt(wx: number, wy: number): number;  // FLOOR 层原始 6 位槽位
  objIdAt(wx: number, wy: number): number;      // OBJ 层 ID,0 = 空
  elevAt(wx: number, wy: number): number;       // 0..3
  faceDirAt(wx: number, wy: number): number;    // 0=北 1=东 2=南 3=西
  poweredAt?(wx: number, wy: number): boolean;  // WS-06 通电状态
  roofAt?(wx: number, wy: number): number;      // 屋顶(物理不参与)
}
```

### 2.3 向下游输出

| 消费者 | 输出 |
| :--- | :--- |
| WS-04 战斗 | `PhysFx{kind:'BURNED', magnitude:15}` 之类的速率事件 |
| WS-08 网络 | `snapshot()` 的紧凑状态数组 |
| WS-09 渲染 | `fx[]` 特效队列(`LANDED`/`BOUNCED`/`WALL_HIT`/`TRAP_OPENED`/`VORTEX_PULL`/`BOUNCE_PAIR`) |
| WS-07 交互 | `CarrySystem.tryLift/throwTop/checkCatch` 与 `CarryReject` 原因码 |

---

## 3. 数据结构

```ts
interface PhysTerrain { /* 见 §2.2 */ }

interface PhysicsWorldOptions {
  terrain?: PhysTerrain;                          // 缺省 FLAT_TERRAIN
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  pairwise?: boolean;                             // 缺省 true
  hazards?: boolean;                              // 缺省 true
}

interface StepReport {
  bodies: number;          // 本帧刚体数
  pairs: number;           // 两两检测次数 = n(n-1)/2
  substeps: number;        // 1..MAX_SUBSTEPS
  bounces: number;         // 蹦床弹射次数
  wallHits: number;        // 墙壁反弹次数
  burns: number;           // 灼烧触发次数
  trapsTriggered: number;  // 落穴触发次数
  milliseconds: number;    // 实测耗时
}

type FxKind =
  | 'LANDED' | 'BOUNCED' | 'WALL_HIT' | 'BURNED'
  | 'TRAP_OPENED' | 'VORTEX_PULL' | 'BOUNCE_PAIR' | 'OUT_OF_WORLD';

interface PhysFx {
  kind: FxKind;
  id: string;
  otherId?: string;   // 仅 BOUNCE_PAIR
  x: number; y: number; z: number;
  magnitude: number;  // 语义随 kind:伤害速率 / 弹射速度 / 法向速度
}

interface CarryActor {
  body: DynamicBody;   // 冻结层刚体
  shield: boolean;     // 平安盾(物品 218)开关
}

const CarryReject = {
  OK, TOO_FAR, NOT_GROUNDED, SHIELDED,
  DEPTH_EXCEEDED, ALREADY_CARRIED, SELF, HEAVY_BOSS,
} as const;

interface CatchCheck {
  caught: boolean;
  z: number;          // 接球瞬间高度
  dist: number;       // 水平距离
  inWindow: boolean;  // z ∈ [0.3, 1.4]
  nearEnough: boolean;// dist ≤ 0.8
}

interface ArcSample {
  t: number; x: number; y: number; z: number; vz: number; grounded: boolean;
}
```

### 3.1 实体单位约定

| 量 | 单位 | 范围 |
| :--- | :--- | :--- |
| 位置 x/y | 格 | 世界坐标,浮点 |
| 位置 z | 格 | ≥ 地面高度(elev−1) |
| 速度 | 格/秒 | 常规 \|v\| < 20 |
| 质量 | 无量纲 | 1.0 / 3.0 / 20.0 |
| 半径 | 格 | 0.35 / 0.40 / 1.20 |
| 摩擦 μ | 无量纲 | (0,1] |
| 冲量 J | 格·质量/秒 | Δv = J/m |

---

## 4. 算法与公式

### 4.1 主循环 `step(dt)`

```
1. 统计 vmax = max|v|(面内)
2. substeps = clamp(ceil(vmax·dt / 0.25), 1, 4)
3. for s in 1..substeps:
     for each body:  stepBody(body, dt/substeps)
     if pairwise:    resolvePairs()
4. for each body: clampBounds(); ensureFinite()
5. tickCount++; elapsed += dt
```

**子步阈值 0.25 格的推导**:一格 1.0,半径最小 0.35,若单步位移 > 0.25 就可能穿过一格厚的墙。`vmax·dt > 0.25` 即触发拆分,上限 4 步(对应 80 格/秒,再快就交给 `ensureFinite` 兜底)。

### 4.2 `stepBody` 单刚体

```
若 carriedBy ≠ null:  mu=1.0; return          // 被举者由 CarrySystem 全权托管

stateTimer -= dt; 到 0 时 STUNNED/FROZEN → NORMAL

slot = terrain.floorSlotAt(⌊x⌋, ⌊y⌋)
mu   = FLOOR_MU_BY_SLOT[slot]                 // WS-01 的预计算表,O(1)
若 state ∈ {STUNNED, FROZEN}: vx=vy=0
若 state === SLIPPING:        mu = max(mu, 0.98)

belt = BELT_FORCE[floorId] 若该地砖是加速带且(不需电 或 已通电)
       方向取 terrain.faceDirAt(⌊x⌋,⌊y⌋)

若 hazard 且地板=323: applyVortex()
gMul = 1; 若地板=319: trapTimer += dt; t ≥ 0.4−ε 时触发落穴; gMul = 1.8

(vx,vy) = integrateHorizontal(vx, vy, mu, 0, 0, 0, 0, beltX, beltY, mass, dt)
x += vx·dt;  y += vy·dt

gz = elev(⌊x⌋,⌊y⌋) − 1
若 gMul ≠ 1: vz += GRAVITY·(gMul−1)·dt        // 注入额外下落加速
(z, vz, grounded) = integrateVertical(z, vz, dt)
若 z ≤ gz:
   z = gz
   若地板=318: vz = BOUNCE_VZ; bounces++      // 蹦床
   否则:        vz = 0

火炭/荆棘 → 产出 BURNED 特效(不扣血)
resolveTerrainWalls()
```

### 4.3 墙壁反弹

对圆的四条边各判一次:若圆心到格边的距离 < 半径且相邻格实心(OBJ 351~371),用 `resolveCircleBounce(vx, vy, nx, ny, 1.0)` 反射并把圆心推回格内。

```
西墙:n = (1, 0);  x = ⌊x⌋ + r
东墙:n = (−1,0);  x = ⌊x⌋+1 − r
北墙:n = (0, 1);  y = ⌊y⌋ + r
南墙:n = (0,−1);  y = ⌊y⌋+1 − r
```

### 4.4 两两碰撞(质量加权分离 + 法向冲量)

```
rr = a.r + b.r;  d = |b.pos − a.pos|;  若 d ≥ rr 或 |Δz| > max(r) 跳过
n = (b − a)/d
总质量 M = ma + mb
重叠 overlap = rr − d
a ← a − n · overlap · (mb/M)                 // 按质量反比分离
b ← b + n · overlap · (ma/M)
relN = (b.v − a.v)·n
若 relN < 0:                                  // 正在接近
   shared = 2·relN / M
   a.v = bounce(a.v, n, 1.0) + shared·mb·n
   b.v = b.v − shared·ma·n
```

### 4.5 摩擦滑行解析式(文档与测试的对照基准)

```
s∞ = v0 · dt / (1 − μ)
```

代入 μ=0.98、v0=4.5、dt=0.05:

```
s∞ = 0.225 / 0.02 = 11.25 格
```

对照 μ=0.72(裸地):`s∞ = 0.225/0.28 = 0.804 格`;μ=0.35(蜂蜜毯):`0.225/0.65 = 0.346 格`。

**结论**:冰砖滑行距离是裸地的 **14 倍**、蜂蜜毯的 **32.5 倍**,手册「把冲锋的野猪引到冰砖上,它会刹不住车一头撞在石墙上」在数值上成立。

### 4.6 投掷抛物线(与手算对照)

初速:`v_xy = 8.5`、`v_z = 6.0`,`g = −18.0`。

```
滞空时间  T = 2·v_z/|g| = 12/18 = 2/3 ≈ 0.6667 s
水平射程  R = v_xy · T = 8.5 × 2/3 ≈ 5.6667 格
峰值高度  H = v_z²/(2|g|) = 36/36 = 1.0 格
仰角      θ = atan(6.0/8.5) ≈ 35.2°
```

**离散化误差**:冻结层 `integrateVertical` 是显式欧拉(位置用旧速度),每帧多走半步,因此:

| dt | 数值射程 | 数值峰值 |
| :--- | ---: | ---: |
| 0.05s(20Hz) | 6.3750 | 1.1550 |
| 0.01s | 5.7800 | 1.0136 |
| 0.005s | 5.7375 | — |
| 0.001s | 5.6780 | 1.0030 |
| **解析** | **5.6667** | **1.0000** |

20Hz 下射程高估 **12.5%**,加密到 1ms 后误差降到 **0.2%**。这是显式欧拉的一阶误差,不是 bug;测试里两个数都断言,把这件事钉死。

### 4.7 蹦床初速的离散反解

若直接用解析值 `√(2·18·2) = 8.4853`,20Hz 采样峰值是 **2.2176**(超调 10.9%),肉眼可见。因此实现里**反解离散积分器**:

```
launchSpeedForApex(targetZ):
  lo=0, hi=64
  重复 80 次:  mid=(lo+hi)/2
              apexHeight(mid) < targetZ ? lo=mid : hi=mid
  return (lo+hi)/2

apexHeight(vz0):  用冻结层 integrateVertical 跑一条纯垂直轨迹,返回采样峰值
```

得 `BOUNCE_VZ ≈ 8.0444`,采样峰值精确落在 2.0。`BOUNCE_VZ_ANALYTIC = 8.4853` 保留供对照。

### 4.8 举起链与叠罗汉

```
E_k.z = E_0.z + k · CARRY_Z_STEP          // stackOffset(k) = k · 0.85
上层 x/y 吸附到底层(人站在人肩上)
底层移速乘数 = CARRY_SLOWDOWN^depth = 0.85^(层数−1)
```

4 层:`z_top = 3 × 0.85 = **2.55**`,`speedMul = 0.85³ = **0.614125**`。

`tryLift` 判定顺序(从与位置无关到与位置有关):

```
自身 → 冷却 → 已在链上 → 深度上限 → 平安盾 → 质量 → 距离 → 离地
```

顺序是**语义**而非实现细节:又重又远的目标应报 `HEAVY_BOSS` 而不是 `TOO_FAR`,否则调试时会被误导。

### 4.9 冲量与质量反比

```
Δv = J / m
```

| 目标 | 质量 | J=60 时 Δv |
| :--- | ---: | ---: |
| 玩家 | 1.0 | 60 |
| 重物 | 3.0 | 20 |
| Boss | 20.0 | 3 |

动量 `m·Δv = 60` 三者一致 —— 测试里断言了这一点。

---

## 5. 参数配表

### 5.1 冻结层常数(直接引用,不重定义)

| 参数 | 值 | 出处 |
| :--- | ---: | :--- |
| `TICK_HZ` / `DT` | 20 / 0.05s | §2.1 |
| `GRAVITY` | −18.0 | §2.2 |
| `THROW_SPEED_XY` / `THROW_SPEED_Z` | 8.5 / 6.0 | §2.2 |
| `CARRY_Z_STEP` / `CARRY_MAX_DEPTH` / `CARRY_SLOWDOWN` | 0.85 / 4 / 0.85 | §2.2 |
| `CATCH_RADIUS` / `CATCH_Z_MIN` / `CATCH_Z_MAX` | 0.8 / 0.3 / 1.4 | §2.2 |
| `RADIUS_PLAYER/WILD/BOSS` | 0.35 / 0.40 / 1.20 | §2.2 |
| `MASS_PLAYER/HEAVY/BOSS` | 1.0 / 3.0 / 20.0 | §2.2 |
| `BASE_MOVE_SPEED` | 4.5 | §4.1 |

### 5.2 本模块新增参数

| 参数 | 值 | 依据 |
| :--- | ---: | :--- |
| `BELT_FORCE[317]` | 10.0 格/秒 | 原文「沿箭头方向施加 10 格/秒推力」 |
| `BELT_FORCE[313]` | 3.5 格/秒 | 计速砖,比机关带弱 |
| `BELT_FORCE[330]` | 6.0 格/秒 | 矿车制动加速轨,需通电 |
| `BELT_REQUIRES_POWER` | {330} | 原文「通电时提供推力,断电时作为刹车」 |
| `BOUNCE_VZ` | ≈8.0444 | 离散反解,采样峰值 = 2.0 |
| `BOUNCE_VZ_ANALYTIC` | 8.4853 | √(2·18·2),仅对照 |
| `JUMP_VZ` | ≈6.34 | 离散反解,采样峰值 = 1.0 |
| `BURN_DPS`(320) | 15 | 原文「每秒受 15 点灼烧伤害」 |
| `BLEED_DPS`(324) | 20 | 原文「每秒造成 20 点流血伤害」 |
| `TRAP_DELAY`(319) | 0.4 s | 原文「0.4 秒后咔嚓碎裂」 |
| `TRAP_EPS` | 1e−9 | 吸收 `0.05×8 = 0.39999999999999997` 的浮点误差 |
| `TRAP_FALL_MUL` | 1.8 | 掉坑摔得更快 |
| `VORTEX_RADIUS`(323) | 2.0 格 | 原文「周围 2 格内的怪物被吸向中心」 |
| `VORTEX_ACCEL` | 2.4 格/秒² | 缓慢吸入,不打断行动 |
| `COLLISION_RESTITUTION` | 1.0 | §2.2「弹性碰撞」 |
| `SHIELD_ITEM_ID` | 218 | 原文「工程安全帽(和平盾)」 |
| `LIFT_RANGE` | 0.75 格 | 必须真正贴住 |
| `LIFT_Z_MAX` | 0.45 格 | 离地举不到 |
| `HEAVY_MASS_THRESHOLD` | 10.0 | 超过此质量需扁担 216 |
| `THROW_COOLDOWN` | 0.35 s | 防止瞬间反复抢人 |
| `PASS_WINDOW` | 0.25 s | 空中传球窗口 |
| `STACK_SHED_SPEED` | 2.0 格/秒 | 拆链时上层散开 |
| `MAX_SUBSTEPS` | 4 | 见 §4.1 推导 |
| `SUBSTEP_SPEED_THRESHOLD` | 6.0 格/秒 | 位移 >0.25 格触发拆分 |
| `FINITE_LIMIT` | 1e6 | 超过视为数值异常 |

---

## 6. 帧预算 / 性能

### 6.1 "16 人 + 40 野怪 + 1 Boss 同屏"的单帧耗时推导

**刚体数** `n = 16 + 40 + 1 = 57`。

**两两碰撞对数**:

```
C(n,2) = 57 × 56 / 2 = 1596 对/帧
```

每对约 20 次算术(距离平方、法向、分离、冲量),合计 **≈ 3.2×10⁴ 次浮点运算/帧**。

**单刚体积分**:57 × (摩擦查表 1 次 + `integrateHorizontal` ~15 ops + `integrateVertical` ~8 ops + 墙壁 4 边 × 8 ops) ≈ 57 × 60 ≈ **3.4×10³ ops/帧**。

**总运算量** ≈ 3.5×10⁴ ops/帧,现代 JIT 下 ≈ 3.5×10⁴ / (5×10⁸ ops/s) ≈ **0.07ms**。

**实测**(`tests/WS-02.test.ts` 与手工基准,57 刚体、48×48 混搭地形):

```
平均 0.0126 ms/帧   最大 0.1288 ms    p99 0.0801 ms
```

**20Hz 的帧预算是 50ms/帧**,实测占用 **0.025%**。余量 3950 倍。

**扩展性**:`O(n²)` 在 n=57 时无压力。若同屏刚体涨到 500(大规模 Boss 战),1560 万对 × 20 ops ≈ 3×10⁸ ops ≈ **0.6s**,超预算。此时需换成均匀网格(N=1000 时复杂度降到 O(n)):按 2 格网格分桶,每桶平均 2.5 个刚体,检测量降到 ~10³ —— 这是唯一需要提前准备的优化点,但**当前规模不需要**,避免过早优化。

### 6.2 1GB 内存约束

```
单刚体 DynamicBody ≈ 192 B
  · 6 个 number(x,y,z,vx,vy,vz)      48 B
  · radius/mass/stateTimer/mu         32 B
  · state 字符串引用 + carriedBy/carrying 引用  40 B
  · id 字符串                         24 B
  · V8 对象头与对齐                    48 B

57 个刚体              = 57 × 192   = 10,944 B ≈ 10.7 KiB
Map 哈希槽开销          = 57 × 48    =  2,736 B ≈ 2.7 KiB
─────────────────────────────────────────────────────────
物理世界常驻合计                         ≈ 13.4 KiB
```

对 1GB 预算的占用是 **0.0013%**。即使同屏 1000 个刚体也只有 235 KiB。

**内存的真正大头不在物理层**,而在:

| 项目 | 1GB 中的占比 |
| :--- | ---: |
| 地形 chunk(WS-01) | 25%(256MB) |
| 流体网格(WS-01) | 50% 上限 |
| 实体 + 物理(WS-02) | < 0.01% |
| 网络缓冲 + AI + 渲染 | 剩余 |

在 50% 的流体预算下,每格 7 字节(4+1+1+1),可覆盖 **7.5×10⁷ 格**(约 8600×8600 的地图),远超 57 实体同屏所需。

### 6.3 `step()` 里的常数开销

| 阶段 | 每帧调用次数 | 说明 |
| :--- | ---: | :--- |
| `floorSlotAt` | 57 × substeps | 结构化接口调用,内联后等价于一次数组索引 |
| `FLOOR_MU_BY_SLOT[slot]` | 同上 | `Float64Array` 索引,零哈希 |
| `integrateHorizontal` | 同上 | 冻结层纯函数 |
| `integrateVertical` | 同上 | 冻结层纯函数 |
| `resolveCircleBounce` | ≤ 57×4×substeps | 只在撞墙时调用 |
| 两两检测 | 1596 | 距离平方提前退出 |

---

## 7. 异常与边界

| 场景 | 处理 |
| :--- | :--- |
| `dt ≤ 0` 或非有限 | 直接返回空报告,不推进时间 |
| 速度爆表(1e6) | `substeps` 钳到 4,`ensureFinite` 兜底,实测坐标仍有限 |
| 坐标被注入 NaN | `ensureFinite` 复位到边界内,产出 `OUT_OF_WORLD` 特效 |
| 质量 = 0 | 按 1 处理(冻结层 `integrateHorizontal` 与本地冲量计算都做了) |
| 半径重叠为 0(完全重合) | 法向取 `(1,0)`,按质量反比推开 |
| 被举起的实体 | 物理跳过积分(`mu = 1.0`),由 `CarrySystem` 托管 |
| 链上实体互相碰撞 | 跳过(`carriedBy`/`carrying` 互查),避免自我推挤 |
| 举自己 | 最先判定,返回 `SELF` |
| 目标已在链上 | 返回 `ALREADY_CARRIED`(含承载者自己) |
| 链深度超过 4 | 返回 `DEPTH_EXCEEDED` |
| 顶层层数不足 2 无法投掷 | `throwTop` 返回 `null` |
| 平安盾开启 | 举/击退/掼摔全部 `blocked`，冲量归零 |
| 落穴浮点误差 | `TRAP_EPS = 1e-9` 吸收,精确 8 帧触发 |
| 蹦床落地速度朝上 | 不重复弹射,只在 `z ≤ gz` 且 `vz` 向下时处理 |
| 墙壁内外侧同时判定 | 每边独立判,推进后用新格坐标重算东/南墙 |
| 空世界(`bodies.size === 0`) | `step()` 正常返回,`pairs = 0` |
| 网络抖动 / 丢包 | `snapshot()` 是全量状态,丢一帧可由下一帧覆盖;不做增量依赖 |
| 断线重连 | 刚体由服务端权威持有,客户端全量重建;`CarrySystem` 的链状态可由 `carriedBy`/`carrying` 双向字段无损重建 |

---

## 8. 与其它子系统的耦合点

| 对接 WS | 耦合内容 | 方向 |
| :--- | :--- | :--- |
| **WS-01** 地形 | 依赖 `PhysTerrain`(`floorSlotAt`/`objIdAt`/`elevAt`/`faceDirAt`/`poweredAt`)与 `FLOOR_MU_BY_SLOT` | 入 |
| **WS-01** 地形 | 地砖 351~371 视为实心墙;319/320/323/324/318 触发机关 | 入 |
| **WS-04** 战斗 | 产出 `BURNED{magnitude:15}` / `BURNED{magnitude:20}` 速率事件,由战斗层扣血 | 出 |
| **WS-06** 电路 | 330 加速轨需 `poweredAt()` 为真才推 | 入 |
| **WS-07** 交互 | `CarrySystem` 的举起/投掷/接球 API 与 8 种 `CarryReject` 原因码 | 出 |
| **WS-08** 网络 | `snapshot()` 全量状态、`step(dt)` 确定性 | 双向 |
| **WS-09** 渲染 | `fx[]` 8 类特效事件 | 出 |

**耦合风险点**:`PhysTerrain` 是结构化接口而非 import 具体类,因此 WS-01 的 `WorldGrid` 可以直接当参数传入而无需适配层;但这也意味着**接口签名变更不会被编译器捕获全部调用点**,需要 `--all` 验证兜底。

---

## 9. 验收用例

`tests/WS-02.test.ts` 共 42 条,与下列断言一一对应:

1. **冻结层常数**:16 个常数与手册逐项一致。
2. **μ 查表**:315=0.98、316=0.40、322=0.35、328=0.90、303=0.80、裸地=0.72。
3. **默认 μ**:无铺装走裸地 0.72;UGC 槽位映射 314。
4. **冰砖滑行解析式**:`s∞ = v0·dt/(1−μ) = 11.25 格`;是裸地的 14 倍。
5. **冰砖打滑撞墙**:4.5 格/秒冲上冰砖,滑行 ≥5 格后撞墙反弹,速度反向。
6. **滑行距离单调性**:蜂蜜 < 裸地 < 冰砖。
7. **45° 投掷射程**:`T = 2/3 s`、`R = 5.667 格`、`θ ≈ 35.2°`;1ms 积分收敛到 0.02 格内。
8. **`throwVelocity` 归一化**:7 个方向速度模恒为 8.5;`speedMul` 只缩放水平。
9. **抛物线形状**:上升段单调、下降段单调、落地 `z=0`;峰值 20Hz 采样 1.155、1ms 采样 1.003。
10. **4 层叠罗汉 = 2.55**:`stackOffset(3) = 2.55`,`speedMul = 0.85³ = 0.614125`。
11. **叠罗汉上限**:第 5 人返回 `DEPTH_EXCEEDED`,链条仍 4 人。
12. **`carrierSpeedMul` 单调递减**:0/1/2/3 层逐项。
13. **举起判定**:自身/太远/离地/超重/已背负 5 类拒绝。
14. **质量优先于距离**:又重又远报 `HEAVY_BOSS` 而非 `TOO_FAR`。
15. **`canLift` 纯函数**与 `CarrySystem` 判定一致。
16. **`throwTop`**:初速 8.5/6.0、出手高度 0.85、脱离链、冷却生效。
17. **`canPerfectCatch` 边界**:`z=0.3`/`z=1.4`/`dist=0.8` 恰好命中;越界失败。
18. **`checkCatch` 中间量**:`caught`/`inWindow`/`nearEnough`/`dist`/`z`。
19. **接球窗口**:落点前方能接到;射程中点太高接不到;起点后方接不到。
20. **`registerCatch`**:清冷却、计数。
21. **冲量质量反比**:J=60 时 Δv=60/20/3;动量一致。
22. **掼摔**:水平+下压冲量生效、脱离链、进入 `STUNNED`。
23. **掼摔质量衰减**:重物 Δv = 30/3 = 10。
24. **平安盾 218**:免疫举起 + 免疫击退(Δv 全 0,状态不变)。
25. **关盾后正常**:可举、可击退。
26. **加速带 317 = 10 格/秒**:一帧后 `vx = 10.0`。
27. **加速带方向由 META 决定**:朝南时推力在 +y,`vx = 0`。
28. **蹦床 318**:解析值 8.4853,离散修正 8.0444,采样峰值精确 2.0;反解函数对 1.0/3.0 同样成立。
29. **踩蹦床被弹起**:`BOUNCED` 特效、`totalBounces ≥ 1`。
30. **火炭 320**:每秒 15 点,`BURNED.magnitude = 15`。
31. **荆棘 324**:每秒 20 点。
32. **落穴 319**:0.4s = 8 帧,第 7 帧不碎、第 8 帧碎。
33. **圆形刚体碰撞**:推开、速度改变、`pairs ≥ 1`。
34. **`resolveCircleBounce`**:法线反向、切向保留、半弹性反弹。
35. **质量差异碰撞**:轻物位移 > 重物位移。
36. **10 万次 step 无 NaN(核心)**:57 刚体、混搭地形、10 万帧后逐个 `Number.isFinite` + 未发散 + 在世界边界内。
37. **极端速度无 NaN**:1e6 速度、子步钳制、NaN 注入被复位。
38. **性能**:57 刚体平均单帧 < 50ms(实测 0.0126ms);碰撞对 1596。
39. **内存上界**:57 刚体 ≈ 11KB,含 Map 开销 < 32KB。
40. **`integrateHorizontal` 公式**:摩擦/加速度/冲量三项逐项验证;质量 0 不产生 NaN。
41. **`integrateVertical`**:落地 `z=0`、`vz=0`、`grounded`。
42. **与 `CarrySystem` 协作**:被举者 `z` 不被物理二次积分,`mu = 1.0`。

---

## 10. 未决问题

1. **显式欧拉的 12.5% 射程高估**是否要在玩法层补偿?当前做法是「文档标注 + 蹦床单独反解」,但投掷射程用的仍是未修正的 `throwVelocity`,因此玩家实际能扔 6.375 格而手册写 5.667。**待裁决**:是改冻结层为半隐式欧拉(需改签名,不动),还是在 WS-07 交互层对 `speedMul` 打折补偿?
2. **`HEAVY_MASS_THRESHOLD = 10.0` 与 `MASS_HEAVY = 3.0` 不匹配**:普通重物(3.0)可以单人举起,只有 Boss 级(20.0)需要扁担。这与物品 216「2~4 人抬起超重型 Boss 战利品」的原文有出入。**待裁决**:阈值应下调到 3.0 吗?
3. **举起的 `STUNNED` 状态**目前让被举者完全无法行动(速度清零)。若设计要「被举者可以挣扎」,需要新增一个 `CARRIED` 状态 —— 但 `BodyState` 是冻结层的七态,不能加。
4. **两两碰撞是 O(n²)**。当前 57 刚体无压力,但 Boss 战若召唤大量小怪(>300)会超预算。**待裁决**:是否现在就把均匀网格写进 `resolvePairs`?建议等实测到具体场景再做。
5. **`TRAP_EPS` 是浮点补丁**。更干净的做法是把所有计时器改成「帧计数器」整数累加,但会与 `dt` 可变的调用方式冲突。**待裁决**:是否统一改为整数帧?
6. **`PhysTerrain` 是结构化接口**,因此 WS-01 改签名时编译器抓不到全部调用点。**待裁决**:是否改成显式 `implements` 或运行时校验?
7. **漩涡 323 的吸力**未考虑「同时踩两个漩涡」的叠加。当前每个刚体只按自己所在格的漩涡计算,若相邻两格都是漩涡则各算各的 —— 实际只算了所在格那一个。是否需要改为范围内所有漩涡求和?