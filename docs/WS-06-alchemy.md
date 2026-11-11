# WS-06 万物奇想炼金炉 —— 细化设计文档

> 对应设计手册 §5.1 ~ §5.6;冻结契约为 `shared/types/alchemy.ts` 与 `shared/contracts/FREEZE.md`。
> 实现位于 `server/src/alchemy/`,验收用例为 `tests/WS-06.test.ts`(55 个测试块 / 399 条断言)。

---

## 1. 职责边界

### 1.1 本子系统负责

| # | 职责 | 落点 |
| :--- | :--- | :--- |
| R1 | **逻辑门禁**:判定 2~4 件投料是否具备「形体 + 机制」双维度骨架,不合格返回「元素排斥」 | `gate.ts` |
| R2 | **亲和度初判**:把投料组合的「有戏程度」量化成 `[0,1]` 标量,并映射为交给 LLM 的 `s_logic` 初值 | `gate.ts` |
| R3 | **配方哈希与全服缓存**:保证同一配方全服只生成一次、只花一次 Token,并记录首发现者与合成次数 | `cache.ts` + `recipeHash()` |
| R4 | **并发去重**:同 hash 的并发请求单飞合并,只打一次 LLM | `cache.ts` |
| R5 | **LLM 结构化协议**:严格 JSON Schema、中文绘本提示词、3 个 few-shot、校验失败错误回灌重试 | `prompt.ts` |
| R6 | **五步确定性属性算法**:`T_eff → Q → 稀有度 → P_budget → 四维切分` | `attributes.ts` |
| R7 | **双词条化学反应突变**:10 条规则的概率表与数值修正 | `attributes.ts` |
| R8 | **16×16 像素立牌**:调色盘字符矩阵 → RGBA → CanvasTexture 载荷 | `pixel_icon.ts` |
| R9 | **无网络降级**:LLM 不可用时的本地确定性回退生成器 | `degrade.ts` |
| R10 | **链路编排**:把 R1~R9 串成单次 `forge()` 调用,保证顺序与不变量 | `index.ts` |

### 1.2 本子系统**明确不**负责

- **不做落库**。SQLite 的打开、事务、连接池、WAL 配置属于部署层;本模块只提供 `RecipeStore` 接口与建表 DDL 文本。
- **不做网络**。HTTP 客户端、重试退避、密钥管理、限流属于网关层;本模块只依赖 `LlmClient.generateJson()`。
- **不做战斗结算**。`atk/def/hp/impulse/util` 只是**物品实例数值**;把它们代入伤害公式、抗性、Buff 叠加是 WS-04 战斗子系统的事。
- **不做客户端渲染**。本模块只输出 `CanvasTexturePayload`;`THREE.DataTexture` 的实例化、材质绑定、UI 排布属于客户端。
- **不做与敌方/掉落/物价的联动**。产物的经济价值(卖店价、掉落权重)由 WS-07 经济子系统基于 `budget` 自行定价。
- **不修改冻结层**。`CARRIER_TAGS`/`MECHANIC_TAGS`/`RARITY_LABEL`/`recipeHash()` 一律只读引用。

---

## 2. 上游 / 下游接口

### 2.1 上游(本模块引用的冻结符号)

| 符号 | 来源 | 用途 |
| :--- | :--- | :--- |
| `ALCHEMY_MIN_INPUTS=2` / `ALCHEMY_MAX_INPUTS=4` | `shared/types/alchemy.ts` | 门禁 k 区间 |
| `CARRIER_TAGS`(32 条) | 同上 | 载体维度白名单 |
| `MECHANIC_TAGS`(43 条) | 同上 | 机制维度白名单 |
| `AlchemyCategory`(7) / `PrimaryMechanic`(10) / `SecondaryElement`(8) / `BaseSilhouette`(9) / `ParticleAura`(7) | 同上 | JSON Schema 的 enum 来源 |
| `StatWeights` / `VisualStyle` / `LLMAlchemyOutputSchema` | 同上 | 协议结构 |
| `RarityTier` / `RARITY_LABEL` | 同上 | 四档稀有度与词条数 |
| `RolledStats` / `ItemInstanceStats` / `AlchemyRecipeRow` | 同上 | 输出结构 |
| `recipeHash(ids)` | 同上 | 配方键(排序拼接) |
| `DEW_ITEM_ID=130` / `BETA_DEW=0.15` | 同上 | 露水破格与品质加成 |
| `ITEM_BY_ID` / `itemName` / `itemTags` / `itemValue` | `shared/constants/items.ts` | 320 项配表的 `value` 与 `tags` |
| `test/ok/eq/near/inRange/includes/mulberry32/report` | `shared/testing/harness.ts` | 可复现断言 |

### 2.2 下游(本模块输出的结构)

| 结构 | 消费方 | 说明 |
| :--- | :--- | :--- |
| `ForgeResult`(成功/失败联合) | WS-09 房间逻辑、客户端 UI | 一次合成的全部结果 |
| `ItemInstanceStats` | WS-04 战斗、WS-07 经济 | 物品实例数值 |
| `AlchemyRecipeRow` | 博物架(物品 #537)、WS-08 存档 | 全服配方行,含冠名 |
| `CanvasTexturePayload` | 客户端渲染 | 可直接喂 `DataTexture` |
| `GateResult` | 客户端预校验(`svc.preview()`) | 炉子前面的实时提示 |
| `RecipeStore` / `LlmClient` | 部署层实现 | 依赖注入契约 |

### 2.3 依赖注入契约

```ts
interface LlmClient {
  generateJson(prompt: string, schema: object): Promise<unknown>;
}

interface RecipeStore {
  get(hash: string): AlchemyRecipeRow | undefined;
  put(row: AlchemyRecipeRow): void;
  bumpCount(hash: string): void;
}
```

两个接口都**只承诺同步语义**(`RecipeStore`)或**单次调用语义**(`LlmClient`),不含重试、超时、事务。理由:重试策略属于业务语义(要决定回灌什么、什么时候降级),放在网关层会让「错误回灌重试」失去可控性;超时属于部署策略,不同环境差异极大。默认实现 `MemoryRecipeStore` 与 `StubLlmClient` 都在内存里,测试与离线单机房直接可用,**不 require better-sqlite3,不发起任何网络请求**。

---

## 3. 数据结构

### 3.1 门禁

```ts
interface GateRequest {
  itemIds: readonly number[];      // 投料 ID,可含露水 130
  offerDew?: boolean;              // 是否愿意用露水破格
  dewAlreadyUsed?: boolean;        // 该配方是否已用过露水(同配方只允许一次)
  hasDewInBag?: boolean;           // 背包里是否真有露水
}

type GateCode =
  | 'PASS' | 'PASS_WITH_DEW'
  | 'K_OUT_OF_RANGE' | 'UNKNOWN_ITEM' | 'REPEATED_ITEM'
  | 'MISSING_CARRIER' | 'MISSING_MECHANIC' | 'MISSING_BOTH'
  | 'DEW_ALREADY_USED' | 'NO_DEW_IN_BAG' | 'NON_ALCHEMABLE';

interface GateResult {
  pass: boolean;
  code: GateCode;
  k: number;                       // 材料件数(露水已剥离)
  materialIds: number[];           // 升序
  materialNames: string[];
  usesDew: boolean;
  dewStripped: number;             // 从材料位剥离出的露水件数
  carrierHits: string[];           // 命中的载体词条(去重升序)
  mechanicHits: string[];          // 命中的机制词条(去重升序)
  resonanceTags: string[];         // 跨材料共享标签
  affinity_raw: number;            // 折扣前亲和度
  affinity: number;                // 量化到 3 位小数,∈[0,1]
  suggested_s_logic: number;       // 交给 LLM / 降级器的契合度初值,∈[0.80,1.50]
  dewRelease: DewRelease | null;
  reasons: GateCode[];
  message: string;                 // 玩家可读提示
}
```

### 3.2 五步算法

```ts
interface PowerMeanBreakdown {
  k: number; values: number[];     // 各材料价值分 V_i
  powered: number[];               // V_i^1.35
  poweredSum: number;              // ΣV_i^1.35
  poweredMean: number;             // (1/k)ΣV_i^1.35
  powerMean: number;               // poweredMean^(1/1.35)
  kMultiplier: number;             // 1 + 0.12(k−1)
  tEff: number;                    // T_eff
}

interface QualityBreakdown {
  sLogic: number;                  // 已钳制到 [0.80,1.50]
  lvProf: number;                  // 已钳制到 [0,30]
  useDew: boolean;
  betaDew: number;                 // 0 或 0.15
  profMultiplier: number;          // 1 + 0.02·Lv + β
  epsilon: number;                 // ε ∈ [0.80,1.25]
  q: number;                       // Q,上限 2.5
}

interface SliceBreakdown {
  atkRaw: number; defRaw: number; hpRaw: number;
  impulseRaw: number; utilRaw: number;      // 全部中间量,便于复核
  atk: number; def: number; hp: number;
  impulse: number;                          // 3.0 + round(P·w·0.15)
  util: number;                             // min(50, round(P·w·0.4))
}
```

单位约定:价值分 `V` 为无量纲整数;`T_eff` 与 `V` 同量纲;`Q` 为倍率;`P_budget` 为无量纲预算点;`ATK/DEF/HP` 为战斗数值点;`impulse` 为「格/秒」的等效推力系数;`util` 为百分比(`0~50`)。

### 3.3 缓存

```ts
interface AlchemyRecipeRow {
  recipe_hash: string;             // 唯一键,如 "126_156"
  discoverer_name: string;         // 首发现者(净化后 ≤12 字)
  item_name: string;
  item_category: AlchemyCategory;
  llm_schema_json: string;         // 完整 LLMAlchemyOutputSchema 的 JSON
  craft_count: number;             // 合成次数,原地累加
  created_at: number;              // 毫秒时间戳
}

interface CacheEntry {
  row: AlchemyRecipeRow;
  schema: unknown;                 // 解析后的结构化输出
  fromCache: boolean;              // 首个为 false,被合并的为 true
  degraded: boolean;
}

interface CacheStats {
  hits: number; misses: number; llmCalls: number;
  dedupedRequests: number; llmFailures: number; degraded: number;
}
```

### 3.4 像素立牌

```ts
interface CanvasTexturePayload {
  kind: 'DataTexture';
  width: 16; height: 16;
  data: Uint8Array;                // 1024 = 16×16×4,行主序
  format: 'RGBAFormat'; type: 'UnsignedByteType';
  magFilter: 'NearestFilter'; minFilter: 'NearestFilter';
  wrapS: 'ClampToEdgeWrapping'; wrapT: 'ClampToEdgeWrapping';
  flipY: false; premultiplyAlpha: false; needsUpdate: true;
  pixelRatioHint: 3;               // UI 放大整数倍
  textureKey: string;              // 内容寻址,跨客户端共享
  palette: { primary: string; secondary: string; outline: string };
}
```

调色盘语义:`0` 透明(alpha=0,**RGB 仍写主色**,避免部分混合器出现黑边);`1` 主色;`2` 副色;`3` 描边;`4` 高光(副色向白 lerp 35%)。

---

## 4. 算法与公式

### 4.1 门禁与亲和度

```
输入:itemIds[]
① 去重 → 剥离露水 130 → 排序 → 得 materialIds,k = |materialIds|
② 硬校验:未知 ID / k∉{2,3,4} / 存在 value≤0 的功能件 → 直接拒绝
③ carrierHits = ∪ 各材料 tags ∩ CARRIER_TAGS
   mechanicHits = ∪ 各材料 tags ∩ MECHANIC_TAGS
   resonanceTags = 出现在 ≥2 个不同材料上的标签
④ 双维齐备 → 放行;缺一维 → 露水破格通道;双维皆空 → 直接拒绝
```

亲和度(仅双维齐备时计算):

```
A = 0.55
  + 0.04 · min(|carrierHits|, 3)
  + 0.03 · min(|mechanicHits|, 4)
  + 0.05 · min(|resonanceTags|, 4)
  + 0.03 · (k − 2)
A ← clamp(A, 0, 1)
s_logic 初值 = clamp(0.75 + 0.45·A, 0.80, 1.50)
```

露水破格:在**只缺一个维度**时,消耗 1 份露水补齐该维度;亲和度乘 0.85 折扣,品质 `Q` 再乘 `DEW_RELEASE_QUALITY_PENALTY=0.9`。双维皆空时露水也补不上(需要同时补两个维度),直接拒绝 —— 否则露水会变成万能通行证。

复杂度:`O(k·T)`,`T` 为单件材料词条数(≤6),实际 < 30 次集合查询,可视为 `O(1)`。

### 4.2 五步属性算法

**第一步 · T_eff 幂次聚合**

```
T_eff = ( (1/k) · Σ_{i=1..k} V_i^1.35 )^(1/1.35) × (1 + 0.12(k−1))
```

用 1.35 次幂平均而非算术平均的原因:1.35 > 1 使高价值材料主导,但低价值材料仍会拖低结果(不会像 `max()` 那样被完全忽略),形成「越舍得投入越强、塞垃圾会亏」的手感。k 加成 `1+0.12(k−1)` 让 4 件材料的组合有 36% 的结构性优势,鼓励玩家凑满。

**第二步 · 品质 Q**

```
Q = S_logic × (1 + 0.02·Lv_prof + β_dew) × ε
ε ~ 截断正态 N(1.0, 0.122²),截断区间 [0.80, 1.25]
S_logic ∈ [0.80, 1.50]   (LLM 唯一数值出口,越界即钳制)
Lv_prof ∈ [1, 10]        (每级 +2%,手册 §5.3 L568)
β_dew ∈ {0, 0.15}
Q 上限 2.5
```

ε 用 Box-Muller 生成标准正态,再拒绝采样截断到 `[0.80, 1.25]`,最多 64 轮,兜底取均值 1.0。σ=0.122 使 ±1σ 恰好落在 `[0.878, 1.122]`,截断区间约 ±2σ,拒绝率 < 12%,期望轮数 ≈ 1.13。

**第三步 · 四档稀有度**

| 档 | 条件 | 名称 | 颜色 | 词条数 |
| :--- | :--- | :--- | :--- | :--- |
| 0 | `Q < 1.00` | 凡品·呆萌造物 | 白色 | 1 |
| 1 | `1.00 ≤ Q < 1.25` | 奇巧·脑洞精品 | 翠绿 | 2 |
| 2 | `1.25 ≤ Q < 1.55` | 秘宝·大师奇物 | 星蓝 | 3 |
| 3 | `Q ≥ 1.55` | 神来之笔·传世孤品 | 曜金 | 4 |

**第四步 · 预算**

```
P_budget = clamp( round(8.5 × T_eff^0.82 × Q), 1, 9999 )
```

`T_eff` 走 0.82 次幂,即对材料价值做轻微压缩:投入翻倍不会让预算翻倍,避免高价值材料线性碾压。

**第五步 · 四维切分**

```
ATK       = round(P · w_atk · 1.2)
DEF       = round(P · w_def · 0.6)
HP        = round(P · w_def · 2.5)
F_impulse = 3.0 + round(P · w_imp · 0.15)
Util%     = min(50, round(P · w_util · 0.4))
```

注意 `DEF` 与 `HP` 共用 `w_def`:一个「防御向」的权重会同时给出厚甲与厚血,符合玩家对「肉」的直觉。`Util%` 有 50 的硬上限,防止极端权重让实用度失控。

**随机数消耗顺序(可复现性关键)**

```
① ε 截断正态(每轮 2 次 rng)
② 化学反应突变(按 REACTION_RULES 表序,每条至多 1 次 rng)
③ 词条抽取(每条 1 次 rng)
```

顺序固定,因此同一 `(输入, seed)` 逐位可复现。缺省种子由 `fnv1a32(recipe_hash)` 派生,保证服务端权威且无需下发种子。

### 4.3 双词条化学反应突变

触发条件:两个标签同时出现在「材料标签 ∪ 产物标签」集合中;按表序判定,第一条掷中的规则生效,**一次合成最多 1 个突变**。

| id | 名称 | 标签对 | 概率 | 副元素 | 光环 | 预算乘子 | 权重偏移(atk/def/imp/util) |
| :--- | :--- | :--- | ---: | :--- | :--- | ---: | :--- |
| `STEAM_DASH` | 蒸汽冲刺 | 极滑 + 火焰 | 0.55 | FIRE | FLAME | 1.08 | −0.05 / −0.05 / +0.10 / 0 |
| `ICE_RINK` | 镜面溜冰 | 冰冻 + 极滑 | 0.50 | ICE | SNOW | 1.05 | −0.06 / 0 / +0.06 / 0 |
| `SPRING_COIL` | 雷纹弹簧 | 导电 + 高弹 | 0.45 | LIGHTNING | SPARKLE | 1.12 | +0.04 / −0.04 / 0 / 0 |
| `PRISM_MIRAGE` | 棱光幻影 | 发光 + 致幻 | 0.40 | LIGHT | SPARKLE | 1.10 | 0 / −0.03 / 0 / +0.03 |
| `GOO_BLAST` | 黏胶轰雷 | 爆炸 + 强粘性 | 0.60 | STICKY | SLIME_DRIP | 1.14 | +0.06 / −0.06 / 0 / 0 |
| `GRAND_CHOIR` | 齐奏战歌 | 音乐 + 战歌 | 0.35 | NONE | MUSIC_NOTES | 1.06 | −0.04 / +0.02 / 0 / +0.02 |
| `STARBREAK` | 崩星一击 | 坚硬 + 暴击 | 0.30 | NONE | SPARKLE | 1.18 | +0.09 / −0.06 / −0.03 / 0 |
| `WARM_SNOW` | 暖雪回春 | 寒冷 + 治愈 | 0.50 | ICE | SNOW | 1.07 | −0.07 / +0.05 / 0 / +0.02 |
| `STAR_RAIL` | 星轨炮 | 魔导 + 激光 | 0.42 | LIGHT | SPARKLE | 1.16 | +0.07 / −0.05 / −0.02 / 0 |
| `FLING_SLAM` | 弹射摔跤 | 摔跤 + 击退 | 0.48 | BOUNCY | BUBBLES | 1.09 | −0.02 / 0 / +0.08 / −0.06 |

设计取向:

- **概率与收益反相关**。最容易触发的「黏胶轰雷」(0.60)预算乘子仅 1.14,而最稀有的「崩星一击」(0.30)给到 1.18 且攻击权重 +0.09 —— 让稀有突变成为值得期待的高光时刻。
- **偏移必须可归一化**。权重增量叠加后统一走 `applyWeightShift()`,把每项夹到下限 0.01 再归一化,并将浮点残差补到最大项,保证 `Σw ≡ 1`。任何规则的偏移都不会把某一项压成负数或 0。
- **突变额外 +1 词条**。`affixCountOf(tier, mutated) = RARITY_LABEL[tier].affixes + 1`,且最后一个词条槽位被替换为突变的情绪化名称(如「蒸汽冲刺」),让玩家在词条列表里一眼看到「哦,这两样东西打起来了」。
- **覆盖外观而非覆盖数值**。突变只改 `secondary_element` 与 `particle_aura`,不改 `atk/def/hp`。数值仍由五步算法算出,只是预算乘子参与其中 —— 保证「数值永远来自确定性算法」这条铁律不被突变打破。

### 4.4 缓存与并发去重

```
resolve(hash):
  if store.get(hash) → hits++, bumpCount(hash), return {fromCache:true}      // 0 Token
  if inflight.has(hash) → dedupedRequests++, await 同 Promise, return       // 0 Token
  misses++
  task = (async () => {
    produced = await produce()            // 内部:门禁 → LLM 重试 → 降级
    llmCalls++ ; degraded?
    if store.get(hash) → bumpCount, return
    store.put(produced.row) ; return
  })()
  inflight.set(hash, task)
  try { return await task } finally { inflight.delete(hash) }
```

关键点:

1. `inflight.delete` 放在 `finally`,即使生成抛错也不会让锁泄漏成死锁。
2. `produce()` 内部若发现自己已被别的路径抢先写入(`store.get` 命中),走 `bumpCount` 而不是覆盖 `put` —— 首发现者冠名不可被覆盖。
3. `resolve()` 第一行的 `store.get` 与 `inflight` 检查之间存在微任务间隙,但因为 JS 单线程且两次检查之间没有 `await`,不存在 TOCTOU 竞态。
4. `craft_count` 在 SQLite 侧用 `UPDATE ... SET craft_count = craft_count + 1` 原地递增,不读改写,避免多进程竞态。

SQLite 表结构(DDL 常量见 `SQLITE_DDL`):

```sql
CREATE TABLE IF NOT EXISTS alchemy_recipe (
  recipe_hash     TEXT    PRIMARY KEY,
  discoverer_name TEXT    NOT NULL,
  item_name       TEXT    NOT NULL,
  item_category   TEXT    NOT NULL,
  llm_schema_json TEXT    NOT NULL,
  craft_count     INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alchemy_created  ON alchemy_recipe(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alchemy_category ON alchemy_recipe(item_category);

CREATE TABLE IF NOT EXISTS alchemy_dew_usage (
  recipe_hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL, used_by TEXT NOT NULL
);
```

### 4.5 LLM 结构化协议

`ALCHEMY_JSON_SCHEMA` 的关键约束:

- 顶层与两层嵌套(`stat_weights`、`visual_style`)全部 `additionalProperties: false`;
- `required` 列全 8 个字段;`stat_weights` 列全 4 项;`visual_style` 列全 6 项;
- 5 处 enum 直接取自冻结联合类型(`AlchemyCategory` 7 / `PrimaryMechanic` 10 / `SecondaryElement` 8 / `BaseSilhouette` 9 / `ParticleAura` 7);
- `pixel_icon_16x16`:`{type:'array', minItems:16, maxItems:16, items:{type:'string', minLength:16, maxLength:16, pattern:'^[01234]{16}$'}}`;
- 颜色:`pattern: '^#[0-9a-fA-F]{6}$'`;
- `logic_synergy_score`:`minimum: 0.80, maximum: 1.50`。

**JSON Schema 表达不了、必须由自定义校验器补的约束**:

| 约束 | 为什么 Schema 做不到 | `validateAlchemyOutput` 的处理 |
| :--- | :--- | :--- |
| `Σw = 1` | JSON Schema 无跨字段算术 | 越界 → 自动归一化并记 `NORMALIZED`(不阻断) |
| 四项全为 0 | 归一化无解 | 硬失败 `ALL_ZERO` |
| 名字不含书名号/引号/换行 | 正则可以做但错误信息不友好 | 硬失败 `BAD_CHARS` |
| 至少 12 个非透明像素 | 无法表达「字符 '0' 出现次数 ≤ 244」 | 硬失败 `EMPTY_ART` |
| 权重不得为负 | 可表达但需 4 条独立规则 | 硬失败 `RANGE` |

校验结果分两类:**硬失败**(阻断,触发重试)与**可修复**(钳制/归一化,记录但不重试)。这样划分是为了不浪费「重试一次 = 一次 Token」的预算在玩家无法感知的问题上。

**重试策略**:最多 `MAX_RETRY=2` 次重试(共 3 次调用)。每次重试把上一轮的**结构化错误列表**与**截断后的原始输出**(≤1200 字符)一并回灌,并标注「第 N 次重试」,要求只修正问题。3 次全失败(或网关抛错)则降级。

复杂度:校验为 `O(T·R)`,`T`=16 行,`R`=16 列,固定 256 次字符检查,`O(1)`。

### 4.6 像素立牌

```
validatePixelMatrix(matrix):
  逐行检查字符串类型 → 长度 == 16 → 每个字符 ∈ {'0','1','2','3','4'}
  累计非透明像素 inkPixels,若 < 12 → EMPTY_ART

rasterize(matrix, palette):
  for y in 0..15: for x in 0..15:
    idx = (y·16 + x)·4
    data[idx..idx+3] = palette[matrix[y][x]] ?? 透明
```

返回 `Uint8Array(1024)`,行主序,与 `THREE.DataTexture(data, 16, 16, RGBAFormat, UnsignedByteType)` 直接对齐。`flipY: false` 因为我们的坐标原点在左上,与材质 UV 的默认方向一致。`magFilter/minFilter` 必须是 `NearestFilter`,否则像素画会被插值糊掉。

九个剪影(SWORD/HAMMER/BOW/WAND/POTION/BOMB/HAT/SHIELD/GIZMO)各有一套**手绘规范美术**,既是 LLM 失败时的回退,也是降级器直接使用的素材。`buildIcon()` 在矩阵非法时自动回退到该剪影的规范美术,并把问题保留在返回值里 —— 玩家永远看不到「空气立牌」。

### 4.7 无网络降级

```
tags = ∪ 材料 tags
rule = 按 SILHOUETTE_RULES 表序首个命中 anyTags 的规则(否则 FALLBACK_RULE)
name = composeName(tags, rule.silhouette, materials)   // 逐级降级模板
lore = composeLore(...)                                 // 固定模板
weights = SILHOUETTE_WEIGHTS[rule.silhouette] ± 亲和度微调
s_logic = gate.suggested_s_logic                        // 不随机
icon = canonicalArt(rule.silhouette)                    // 规范美术
```

名字模板按优先级尝试,首个长度落进 `[2,16]` 的胜出:

```
[载体词][机制词][副机制词][名词] → [载体词][机制词][名词] → [机制词][副机制词][名词]
→ [载体词][材料尾字][名词] → [机制词][名词] → [材料尾字][名词] → [名词] → 神秘的[名词]
```

例:`[金属]` 载体词「铁皮」+ `[极滑]`「溜溜」+ `[发光]`「荧光」+ 名词「大剑」→ **「铁皮溜溜荧光大剑」**。

设计取向:**确定性优先**。降级器不碰任何随机源,同样输入永远给同样产物 —— 离线房的两台客户端必须看到同一件东西,否则会出现「我这边叫蕉皮溜溜剑,你那边叫铁皮大剑」的撕裂。这也是它**不复用 `ε`** 的原因:宁可在数值上失去一点不确定性,也不能让定性结果分叉。

复杂度:`O(T + k)`,全是查表与字符串拼接。

---

## 5. 参数配表

### 5.1 门禁参数

| 参数 | 值 | 出处 / 理由 |
| :--- | ---: | :--- |
| `ALCHEMY_MIN_INPUTS` | 2 | 冻结契约 §5.1 |
| `ALCHEMY_MAX_INPUTS` | 4 | 冻结契约 §5.1 |
| `AFFINITY_BASE` | 0.55 | 双维齐备时的基础分 |
| `AFFINITY_CARRIER_STEP` / `_CAP` | 0.04 / 3 | 多命中载体的边际收益递减 |
| `AFFINITY_MECHANIC_STEP` / `_CAP` | 0.03 / 4 | 机制词条更易凑齐,故步长更低 |
| `AFFINITY_RESONANCE_STEP` / `_CAP` | 0.05 / 4 | 「共鸣」是稀有事件,给最高步长 |
| `AFFINITY_K_STEP` | 0.03 | 每多 1 件材料 |
| `S_LOGIC_BASE` / `_SPAN` | 0.75 / 0.45 | `s_logic = 0.75 + 0.45A`,A=1 时得 1.20 |
| `S_LOGIC_MIN` / `MAX` | 0.80 / 1.50 | 手册 §5.3 L568 品质区间 |
| `DEW_RELEASE_QUALITY_PENALTY` | 0.9 | 破格放行的代价 |
| `DEW_ITEM_ID` | 130 | 冻结契约 |
| `BETA_DEW` | 0.15 | 冻结契约 |

### 5.2 五步算法参数

| 参数 | 值 | 出处 / 理由 |
| :--- | ---: | :--- |
| `AGG_EXPONENT` | 1.35 | 手册 §5.3 幂次聚合 |
| `K_BONUS_RATE` | 0.12 | 手册 §5.3 |
| `PROF_RATE_PER_LEVEL` | 0.02 | 手册 §5.3 |
| `PROF_MAX_LEVEL` | 10 | 手册 §5.3 L568 `Lv_prof ∈ [1,10]`(**不**是人物满级 30) |
| `Q_MAX` | 2.5 | 防炸表硬上限 |
| `BUDGET_BASE` | 8.5 | 手册 §5.3 |
| `BUDGET_EXPONENT` | 0.82 | 手册 §5.3 |
| `BUDGET_MIN` / `MAX` | 1 / 9999 | 防 0 与溢出 |
| `EPSILON_MEAN` / `SIGMA` | 1.0 / 0.122 | 手册 §5.3 |
| `EPSILON_MIN` / `MAX` | 0.80 / 1.25 | 手册 §5.3 截断区间 |
| `EPSILON_MAX_ATTEMPTS` | 64 | 拒绝率 <12%,64 轮后兜底 |
| `ATK_MUL` / `DEF_MUL` / `HP_MUL` | 1.2 / 0.6 / 2.5 | 手册 §5.3 |
| `IMPULSE_BASE` / `IMPULSE_MUL` | 3.0 / 0.15 | 手册 §5.3 |
| `UTIL_MUL` / `UTIL_CAP_PERCENT` | 0.4 / 50 | 手册 §5.3 |
| `RARITY_THRESHOLDS` | 1.00 / 1.25 / 1.55 | 冻结契约 `RARITY_LABEL` |
| `WEIGHT_SUM_TOLERANCE` | 1e-6 | 浮点归一化容差 |

### 5.3 像素与协议参数

| 参数 | 值 | 出处 / 理由 |
| :--- | ---: | :--- |
| `ICON_SIZE` | 16 | 手册 §5.5 16×16 |
| `ICON_BYTES` | 1024 | `16×16×4` |
| `MIN_INK_PIXELS` | 12 | 少于 12 个墨点视为废图 |
| `HIGHLIGHT_WHITE_LERP` | 0.35 | 高光 = 副色向白 lerp 35% |
| `TEXTURE_PIXEL_RATIO` | 3 | UI 建议整数放大倍数 |
| `MAX_RETRY` | 2 | 共 3 次 LLM 调用 |
| `MIN/MAX_ITEM_NAME_LEN` | 2 / 16 | 名字长度 |
| `MIN/MAX_LORE_LEN` | 8 / 120 | 简介长度 |

---

## 6. 帧预算 / 性能

### 6.1 各阶段开销

| 阶段 | 复杂度 | 实测/估算 | 频率 |
| :--- | :--- | ---: | :--- |
| 门禁 `checkGate` | `O(k·T)`,k≤4,T≤6 | < 5 µs | 每次投料 + 客户端预校验 |
| 亲和度 | `O(k·T)` | < 3 µs | 同上 |
| Schema 校验 | `O(16×16)` = 256 | < 20 µs | 每次 LLM 响应 |
| 五步算法 | `O(k)` + Box-Muller 期望 1.13 轮 | < 8 µs | 每次合成 |
| 像素光栅化 | 固定 256 像素 | < 10 µs | 每次合成 |
| 降级生成 | `O(T + k)` 查表 | < 15 µs | 仅 LLM 失败时 |
| **本地合计** | — | **< 60 µs / 次** | — |
| LLM 往返 | 1 次网络 | 300 ~ 3000 ms | 仅缓存未命中且非并发合并 |

关键结论:**合成是玩家主动触发的离散事件,不在 20Hz 主循环里**。任何一次合成对帧预算的贡献都是 0 —— 它发生在 UI 交互回调中,本地计算 < 60 µs,远低于 50 ms 的一帧预算。真正的时间成本是 LLM 往返,而缓存把它从「每次合成」降到「每个唯一配方一次」。

### 6.2 1GB 内存约束下的上界

| 常驻结构 | 单条大小 | 规模上界 | 合计 |
| :--- | ---: | ---: | ---: |
| 配方缓存(内存实现) | ~2 KB(`llm_schema_json` 含 16 行像素) | 唯一配方数,设计上界 10 万 | ~200 MB |
| 单飞去重表 | ~200 B | 并发峰值,设计上界 500 | ~100 KB |
| 露水使用登记 | ~80 B | 唯一配方数 | ~8 MB |
| 常量表(9 套美术 + 规则表) | — | 固定 | < 100 KB |
| 测试期 20000 次蒙特卡洛 | 无状态 | — | 0 |

生产侧若改用 SQLite 落盘,内存只保留 LRU 热缓存(建议 5000 条 ≈ 10 MB),其余走磁盘。**降级路径不含任何额外内存分配**(规范美术直接引用常量,`canonicalArt()` 才做浅拷贝)。

### 6.3 Token 成本

| 场景 | LLM 调用 | 说明 |
| :--- | ---: | :--- |
| 首次合成(唯一配方) | 1 | 正常 |
| 同配方再次合成 | 0 | 缓存命中 |
| 同配方并发 10 次 | 1 | 单飞去重合并 9 次 |
| 首次响应结构非法 | 2 | 1 次重试后成功 |
| 连续非法 | 3 | 打满后降级 |
| 网关不可用 | 3 | 打满后降级 |

以「1 万玩家、人均 50 次合成、唯一配方率 20%」估算:总合成 50 万次,唯一配方 10 万,LLM 调用 ≈ 10 万次而非 50 万次,**节省 80%**。

---

## 7. 异常与边界

| 场景 | 处理 | 依据 |
| :--- | :--- | :--- |
| 空输入 `itemIds=[]` | `k=0` → `K_OUT_OF_RANGE`,0 Token | 门禁硬校验 |
| 单件材料 `k=1` | `K_OUT_OF_RANGE` | 同上 |
| 5 件以上 `k≥5` | `K_OUT_OF_RANGE` | 同上 |
| 重复投同一物品 | 去重后重算 k,记 `REPEATED_ITEM` | 防止「两把同样的剑」钻空子 |
| 未知物品 ID | `UNKNOWN_ITEM`,0 Token,不入库 | 冻结层 `ITEM_BY_ID` 查空 |
| `value=0` 功能件(#218) | `NON_ALCHEMABLE` | 它是背包开关,不是材料 |
| 露水塞进材料位 | 自动剥离,不占 k | 露水是催化剂 |
| 同配方重复用露水 | `DEW_ALREADY_USED` | 露水不能变成作弊器 |
| 双维皆空 | `MISSING_BOTH`,露水也补不上 | 骨架全空无法救 |
| LLM 返回带 markdown 围栏 | `extractJsonObject` 抠出首个 `{...}` | 模型常见行为 |
| LLM 返回非 JSON 文本 | `PARSE` 错误 → 回灌重试 | 最多 2 次 |
| LLM 权重和为 2 | 自动归一化,记 `NORMALIZED`,不重试 | 玩家无感知 |
| LLM 权重全 0 | 硬失败 `ALL_ZERO` → 重试 | 无法归一化 |
| LLM 私自加 `attack_power` | 硬失败 `EXTRA_FIELD` → 重试 | **数值不容染指** |
| LLM 契合度给 5.5 | 钳制到 1.50,记 `CLAMPED`,不重试 | 防刷属性 |
| LLM 像素 15 行 | 硬失败 `PIXEL_MATRIX` → 重试 | 尺寸约束 |
| LLM 像素含字符 `X` | 硬失败 `BAD_CHAR` → 重试 | 调色盘约束 |
| LLM 像素全透明 | `EMPTY_ART` → 重试 | 空气立牌不可接受 |
| 3 次全失败 | 降级,`degraded=true`,照常入库 | 玩法不断线 |
| 网关 5xx / 超时 | 同上(每次尝试都算一轮) | 同上 |
| 并发同 hash N 次 | 单飞合并,N−1 个标 `dedupedRequests` | 省 Token |
| 生成过程抛错 | `finally` 清 inflight,不泄漏锁 | 防死锁 |
| 生成中他人抢先写入 | `bumpCount` 而非覆盖 `put` | 冠名不可被覆盖 |
| 玩家名为空/超长/含标签 | 净化后空 → `无名炉灵`;超长截 12 字;剔尖括号与换行 | XSS 与排版防护 |
| 缓存里的 schema 解析失败 | `forge` 返回 `stage:'ROLL'` 失败,不崩溃 | 脏数据隔离 |
| 缓存权重来自旧版本 | `saneWeights()` 再夹一次保证 `Σw=1` | 向前兼容 |
| 同种子两次 Roll | 逐位一致 | 服务端权威可复现 |
| `T_eff` 为 0 / NaN | `budgetOf` 抛错,被 `forge` 捕获为 `stage:'ROLL'` | 显式失败而非静默 0 |
| 极低价值材料(8 分) | 正常参与,T_eff 被拖低 | 设计意图 |

---

## 8. 与其它子系统的耦合点

| 对接方 | 耦合内容 | 方向 | 风险 |
| :--- | :--- | :--- | :--- |
| **WS-01 网格** | 无直接耦合。像素立牌是 UI 贴图,不写进 `Tile` 的 32-bit 字段 | 无 | 低 |
| **WS-02 物理** | `impulse` 字段被解释为「等效推力」,用于投掷/击退初速叠加 | 输出 | 中:若 WS-02 改了 `THROW_SPEED_XY`,需重标定 `IMPULSE_MUL` |
| **WS-03 实体/物品** | 依赖 `ITEM_BY_ID` 的 `tags` 与 `value`;**任何 tags/value 变更都会改变门禁与算法结果** | 输入 | **高**:冻结层改动 = 本模块返工 |
| **WS-04 战斗** | 消费 `atk/def/hp`;需要知道 `rarity_tier` 与词条列表用于 Buff | 输出 | 中:`util` 是百分比,WS-04 必须按 `%` 解释 |
| **WS-05 生物/Boss** | 无直接耦合。Boss 掉落若接入炼金,需要提供 `ITEM_BY_ID` 中已存在的 ID | 无 | 低 |
| **WS-07 经济** | 消费 `budget` 做定价;`craft_count` 可作为稀缺度因子 | 输出 | 中:定价公式需自行夹住上界 |
| **WS-08 存档** | 持久化 `AlchemyRecipeRow` 与 `ItemInstanceStats`;需实现 `RecipeStore` 的 SQLite 适配器 | 双向 | 中:适配器必须实现 `bumpCount` 的原子累加 |
| **WS-09 房间** | 「奇想炼金实验室」识别 `ALCHEMY_FURNACE_ID=536`;博物架 `537` 消费 `SQL_TOP_GALLERY` | 输出 | 低 |
| **WS-10 客户端** | 消费 `CanvasTexturePayload`;需实现「最近邻采样 + 整数倍放大」 | 输出 | 中:若客户端改用 `NearestMipmapNearestFilter` 需评估糊边 |
| **网关层(非 WS)** | 实现 `LlmClient`;负责 HTTP、密钥、退避、限流 | 输入 | 高:网关若自行重试会与本模块的「错误回灌」策略冲突,**网关必须只做单次调用** |

---

## 9. 验收用例

`tests/WS-06.test.ts` 共 **55 个测试块 / 399 条断言**,分 11 组。以下为可执行断言与用例的对应关系(节选 20 条核心):

| # | 用例 | 断言要点 | 测试块 |
| :--- | :--- | :--- | :--- |
| 1 | 参数配表自洽 | 反应表/阈值/σ 全部合法 | `A1` |
| 2 | 门禁白名单 | `CARRIER_TAGS=32`、`MECHANIC_TAGS=43`、两表零重叠 | `A2` |
| 3 | 九剪影美术 | 全部 16 行 × 16 列且字符合法 | `A3` |
| 4 | 三 few-shot | 全部通过严格校验器 | `A4` |
| 5 | 哈希排序稳定 | 6 种排列得同一键 | `B1` |
| 6 | 哈希非法输入 | `0`/负数/`NaN` 全部抛错 | `B2` |
| 7 | **缓存二次 0 Token** | 第二次 `llm.calls` 不增、`fromCache=true`、`llmTokensUsed=0` | `B3` |
| 8 | **并发去重** | 10 并发 → `llm.calls===1`、9 个 `dedupedRequests`、名字集合大小 1 | `B5` |
| 9 | 冠名与计数 | `craft_count` 累加 1→3,`discoverer_name` 不被覆盖 | `B6` |
| 10 | 门禁正例 | 双维命中放行,亲和度 > 0.5 | `C1` |
| 11 | 门禁反例 | 缺载体/缺机制/双空/k 越界/未知 ID 全部拦下,0 Token | `C2`~`C4` |
| 12 | 露水破格 | 补维度、消耗 1 份、亲和度打折 | `C5` |
| 13 | 露水两道闸 | 已用过 / 背包没有 都拒绝 | `C6` |
| 14 | **手算对照 A** | `T_eff=46.537880`、`P=218`、`atk=131/def=26/hp=109` | `D1` |
| 15 | **手算对照 B** | `T_eff=44.449114`、`Q=1.392`、`P=266` | `D2` |
| 16 | **手算对照 C** | `T_eff=143.692869`、`Q=1.4175`、`P=708` | `D3` |
| 17 | **手算对照 D** | `ε=1.25 → Q=1.771875`、`P=885`、四维 `531/106/443/30/35` | `D4` |
| 18 | **手算对照 E** | `Q=0.64 → 凡品`、`P=127`、四维 `76/15/64/7/5` | `D5` |
| 19 | 四档边界 | 0.9999/1.00/1.2499/1.25/1.5499/1.55 严格分档 | `D6` |
| 20 | ε 截断 | 10000 次采样全在 `[0.80,1.25]`,均值≈1.0 | `D8` |
| 21 | 反应概率分布 | 4 条规则蒙特卡洛 20000 次,频率 ±0.03 | `E3` |
| 22 | 突变效果 | 权重归一化、覆盖元素/光环、预算不降 | `E4` |
| 23 | Schema 严格性 | `additionalProperties:false`、`required` 全列、enum 齐全 | `F1` |
| 24 | 权重校验 | 和为 2 → 归一化;全 0 → 硬失败;越界 → 拒绝 | `F2` |
| 25 | 像素校验 | 15 行/行宽 13/字符 X/category 非法/缺字段/多字段 全部拒绝 | `F3` |
| 26 | 重试策略 | 2 次调用成功、错误回灌、3 次全败降级、网关抛错降级 | `F6` |
| 27 | 像素往返 | 九剪影全部 `matrix → RGBA → matrix` 逐字符一致 | `G3` |
| 28 | 纹理载荷 | 字段齐备、最近邻、`flipY:false`、纹理键含主色 | `G4` |
| 29 | 立牌回退 | 非法矩阵自动用规范美术,墨点 ≥ 12 | `G5` |
| 30 | 降级同构 | 产物能通过 LLM 校验器,权重和 = 1 | `H1` |
| 31 | 降级确定性 | 同输入两次调用逐字节相同 | `H2` |
| 32 | 降级可玩 | 降级产物跑完五步算法,数值合法 | `H3` |
| 33 | 端到端 | 七阶段字段全部落位,`instance.t_eff === breakdown.tEff` | `I1` |
| 34 | 门禁失败零副作用 | `llm.calls===0` 且 `store.size===0` | `I2` |
| 35 | 同种子可复现 | 两次 Roll 逐位一致 | `I4` |
| 36 | 全物品遍历 | 319 件材料都可门禁 + Roll,#218 被拒 | `K1` |
| 37 | SQLite DDL | 主键、`craft_count`、索引、露水表齐备 | `J1` |
| 38 | 冠名净化 | 空名兜底、12 字截断、剔除尖括号与换行 | `J2` |
| 39 | 词条不重复 | 200 次抽取无重复,条数受稀有度约束 | `I6` |
| 40 | 亲和度单调 | 命中越多越高,缺维度归零 | `K2` |

### 9.1 手算对照表(三组以上,逐项中间值)

**对照组 A** —— k=2,「寒铁金属锭 #156」V=45 +「爆裂火椒 #126」V=38;`S_logic=1.10`,`Lv=0`,无露水,`ε=1.000`;权重 `w=(0.5, 0.2, 0.2, 0.1)`。

| 步骤 | 计算式 | 中间值 | 结果 |
| :--- | :--- | :--- | ---: |
| V 列表 | — | `[45, 38]` | — |
| V^1.35 | `45^1.35` / `38^1.35` | `170.544176` / `135.740003` | — |
| ΣV^1.35 | `170.544176 + 135.740003` | — | `306.284180` |
| (1/k)Σ | `306.284180 / 2` | — | `153.142090` |
| 幂平均 | `153.142090^(1/1.35)` | — | `41.551678` |
| k 乘子 | `1 + 0.12×(2−1)` | — | `1.1200` |
| **T_eff** | `41.551678 × 1.1200` | — | **`46.537880`** |
| 专精乘子 | `1 + 0.02×0 + 0` | — | `1.0000` |
| **Q** | `1.10 × 1.0000 × 1.000` | — | **`1.100000`** |
| 档位 | `1.00 ≤ 1.10 < 1.25` | — | **奇巧(档 1)** |
| **P_budget** | `round(8.5 × 46.537880^0.82 × 1.10)` = `round(8.5 × 23.313174 × 1.10)` = `round(217.98)` | `23.313174` | **`218`** |
| ATK | `round(218 × 0.5 × 1.2)` = `round(130.8)` | `130.8` | `131` |
| DEF | `round(218 × 0.2 × 0.6)` = `round(26.16)` | `26.16` | `26` |
| HP | `round(218 × 0.2 × 2.5)` = `round(109.0)` | `109.0` | `109` |
| F_impulse | `3.0 + round(218 × 0.2 × 0.15)` = `3 + round(6.54)` | `6.54` | `10` |
| Util% | `min(50, round(218 × 0.1 × 0.4))` = `min(50, 9)` | `8.72` | `9` |

**对照组 B** —— k=3,「萤光魔晶簇 #116」V=50 +「滑溜香蕉 #125」V=28 +「夜光菌木 #104」V=28;`S_logic=1.16`,`Lv=10`,无露水,`ε=1.000`;同一权重。

| 步骤 | 计算式 | 中间值 | 结果 |
| :--- | :--- | :--- | ---: |
| V 列表 | — | `[50, 28, 28]` | — |
| V^1.35 | `50^1.35` / `28^1.35` / `28^1.35` | `196.611767` / `89.880058` / `89.880058` | — |
| ΣV^1.35 | 三项相加 | — | `376.371882` |
| (1/k)Σ | `/ 3` | — | `125.457294` |
| 幂平均 | `^(1/1.35)` | — | `35.846059` |
| k 乘子 | `1 + 0.12×2` | — | `1.2400` |
| **T_eff** | `35.846059 × 1.2400` | — | **`44.449114`** |
| 专精乘子 | `1 + 0.02×10 + 0` | — | `1.2000` |
| **Q** | `1.16 × 1.2000 × 1.000` | — | **`1.392000`** |
| 档位 | `1.25 ≤ 1.392 < 1.55` | — | **秘宝(档 2)** |
| **P_budget** | `round(8.5 × 44.449114^0.82 × 1.392)` = `round(8.5 × 22.451623 × 1.392)` = `round(265.64)` | `22.451623` | **`266`** |
| ATK | `round(266 × 0.5 × 1.2)` = `round(159.6)` | `159.6` | `160` |
| DEF | `round(266 × 0.2 × 0.6)` = `round(31.92)` | `31.92` | `32` |
| HP | `round(266 × 0.2 × 2.5)` = `round(133.0)` | `133.0` | `133` |
| F_impulse | `3.0 + round(266 × 0.2 × 0.15)` = `3 + round(7.98)` | `7.98` | `11` |
| Util% | `min(50, round(266 × 0.1 × 0.4))` = `min(50, 11)` | `10.64` | `11` |

**对照组 C** —— k=4,「秘银魔导锭 #157」V=85 +「极光星辰碎片 #117」V=120 +「幻彩蚕丝 #120」V=45 +「怪物生态诱捕笼 #745」V=160;`S_logic=1.05`,`Lv=30`,**用露水**,`ε=1.000`;同一权重。

| 步骤 | 计算式 | 中间值 | 结果 |
| :--- | :--- | :--- | ---: |
| V 列表 | — | `[85, 120, 45, 160]` | — |
| V^1.35 | 逐项 | `402.453353` / `641.054100` / `170.544176` / `945.283281` | — |
| ΣV^1.35 | 四项相加 | — | `2159.334910` |
| (1/k)Σ | `/ 4` | — | `539.833727` |
| 幂平均 | `^(1/1.35)` | — | `105.656521` |
| k 乘子 | `1 + 0.12×3` | — | `1.3600` |
| **T_eff** | `105.656521 × 1.3600` | — | **`143.692869`** |
| 专精乘子 | `1 + 0.02×10 + 0.15` = `1 + 0.20 + 0.15` | — | `1.3500` |
| **Q** | `1.05 × 1.3500 × 1.000` | — | **`1.417500`** |
| 档位 | `1.25 ≤ 1.4175 < 1.55` | — | **秘宝(档 2)** |
| **P_budget** | `round(8.5 × 143.692869^0.82 × 1.4175)` = `round(8.5 × 58.762042 × 1.4175)` = `round(708.01)` | `58.762042` | **`708`** |
| ATK | `round(708 × 0.5 × 1.2)` = `round(424.8)` | `424.8` | `425` |
| DEF | `round(708 × 0.2 × 0.6)` = `round(84.96)` | `84.96` | `85` |
| HP | `round(708 × 0.2 × 2.5)` = `round(354.0)` | `354.0` | `354` |
| F_impulse | `3.0 + round(708 × 0.2 × 0.15)` = `3 + round(21.24)` | `21.24` | `24` |
| Util% | `min(50, round(708 × 0.1 × 0.4))` = `min(50, 28)` | `28.32` | `28` |

> **注**:本组 `Lv_prof` 取手册 §5.3 L568 的上限 **10**(`Lv_prof ∈ [1,10]`)。2026-11 前此处写 `Lv=30`,是把**人物冒险等级上限 30**(手册 §4.1 L451)误当成了专精等级上限,使专精乘子虚高到 1.75。传 30 会被 `PROF_MAX_LEVEL=10` 钳到 10。

**对照组 D** —— 输入同 C,但 `ε=1.25`(截断上限),考察极端好运。

| 步骤 | 计算式 | 结果 |
| :--- | :--- | ---: |
| **Q** | `1.05 × 1.3500 × 1.25` | **`1.771875`** |
| 档位 | `≥ 1.55` | 神来之笔(档 3) |
| **P_budget** | `round(8.5 × 58.762042 × 1.771875)` = `round(885.01)` | **`885`** |
| ATK | `round(885 × 0.5 × 1.2)` = `round(531.0)` | `531` |
| DEF | `round(885 × 0.2 × 0.6)` = `round(106.2)` | `106` |
| HP | `round(885 × 0.2 × 2.5)` = `round(442.5)` | `443` |
| F_impulse | `3.0 + round(885 × 0.2 × 0.15)` = `3 + round(26.55)` | `30` |
| Util% | `min(50, round(885 × 0.1 × 0.4))` = `min(50, 35.4)` | `35` |

**对照组 E** —— 输入同 A,但手动传 `S_logic=0.60`(LLM 判定为硬凑)、`ε=0.80`(截断下限),考察最差运气。

> 注意:0.60 **低于手册下界 0.80**(L568),会被 `S_LOGIC_MIN` 钳到 **0.80**。
> 所以本组考察的是「**最差仍可用**契合度 0.80」,不是 0.60。

| 步骤 | 计算式 | 结果 |
| :--- | :--- | ---: |
| **Q** | `0.80 × 1.0000 × 0.80` | **`0.640000`** |
| 档位 | `0.64 < 1.00` | **凡品(档 0)** |
| **P_budget** | `round(8.5 × 46.537880^0.82 × 0.64)` = `round(127.30)` | **`127`** |
| ATK | `round(127 × 0.5 × 1.2)` = `round(76.2)` | `76` |
| DEF | `round(127 × 0.2 × 0.6)` = `round(15.24)` | `15` |
| HP | `round(127 × 0.2 × 2.5)` = `round(63.5)` | `64` |
| F_impulse | `3.0 + round(127 × 0.2 × 0.15)` = `3 + round(3.81)` | `7` |
| Util% | `min(50, round(127 × 0.1 × 0.4))` = `min(50, 5.08)` | `5` |

**跨度检验**:同样的「寒铁 + 火椒」组合,最差 `P=127 / ATK=76`(凡品),最好(对照组 A)`P=218 / ATK=131`(奇巧),同权重下攻击力相差 **1.72 倍**。这个跨度既让「运气」有存在感,又因为 `Q` 被 `[0.80,1.50] × [0.80,1.25] × [1,1.35]` 三重夹住而不会失控 —— 极端值 `2.5` 上限在下界被 `Q_MAX` 兜住,即使 LLM 给满分也无法突破。

---

## 10. 未决问题

| # | 问题 | 现状 | 建议 | 需要谁裁决 |
| :--- | :--- | :--- | :--- | :--- |
| U1 | ~~**`impulse` 的量纲**~~ **【Lead 已裁决:不换算、不互换、不相加】**,两者语义不同源 | 已定稿;`attributes.ts` 的 `splitBudget` 含单位注释 | 裁定:仅做数值语义区分,不引入 `impulseToSpeed()` —— 引入换算函数就等于承认两者可互相推导,会把两种物理量错误耦合 | ✅ 已裁决 |

#### U1 裁定详表(Lead 已裁决)

| 量 | 单位 | 语义 | 出处 |
| :--- | :--- | :--- | :--- |
| `THROW_SPEED_XY` = 8.5 | 格/秒 | **主动投掷**被举起实体时的初始水平速度 | 手册 §2.2 |
| `F_impulse` | 格/秒 | **击退冲量** —— 施加于目标后**立刻并入其速度**,随后按地形摩擦 μ 衰减 | 手册 §5.3 公式 |

结论:`F_impulse` 是「一次性加在速度上的增量」,`THROW_SPEED_XY` 是「投掷专属初速」;两者都以格/秒计,但**不同源、不互换、不相加**。落地约束:

1. `attributes.ts#splitBudget` 的 `impulse` 行已加单位注释(见源码)。
2. `RolledStats.impulse` **只**喂给 WS-02 的击退入口(`resolveCircleBounce` 之前的速度增量)。
3. `RolledStats.impulse` **绝不**出现在 `throwVelocity` 的入参里(结构性约束,见测试 `L3`)。
4. 反例断言:构造 `w_imp=1.0 / P=100` 的产物,`F_impulse = 3.0 + round(100×1.0×0.15) = 18`,且断言 `18 !== THROW_SPEED_XY`(不因巧合被当成投掷速度用)。
| U2 | **`util` 的消费口径**。当前是 `0~50` 的整数百分比,但「实用度」具体加成什么(背包容量?采集速度?机关触发范围?)未定义 | 仅存数值 | 建议由 WS-09 玩法层定义映射表,本模块只保证区间 | Lead + WS-09 |
| U3 | **露水破格是否应全局限次**。当前是「每个 recipe_hash 一次」,理论上玩家可以准备 N 个不同配方各破格一次 | 已实现 per-hash 限制 | 若要做「每人每日 N 次」,需 `MemoryDewLedger` 增加 `owner_id` 维度;接口已预留 `used_by` 字段 | Lead |
| U4 | **`item_category` 与 `primary_mechanic` 的自洽性**。当前两者独立 enum,LLM 可能给出「帽子 + 斩击波」这种组合。是否要加交叉约束矩阵 | 未加约束(只做枚举校验) | 建议加一张「类别 × 机制」白名单矩阵,非法组合触发重试。这会让 few-shot 与降级表都要同步扩充 | Lead |
| U5 | **像素立牌是否要支持非 16×16**。当前契约固定 16×16,但 Boss 级产物可能想要 32×32 表现力 | 固定 16×16 | 若要扩展,建议加 `icon_size` 字段并保持 16×16 为默认;**这会改冻结契约** | Lead |
| U6 | **`S_logic` 是否应允许 LLM 完全自由**。当前钳制到 `[0.80,1.50]`(手册 §5.3 L568),意味着「神级搭配」也只能到 1.50。是否要给「四件全高价值 + 完美共鸣」留出 `>1.50` 的通道 | 钳制 | 若要放开,建议走「门禁亲和度 >0.9 时上限提到 1.75」的条件放宽,而不是无条件放开 | Lead |
| U7 | **缓存一致性策略**。当前 `store.get` 命中后直接返回缓存 schema,若之后的算法参数(如 `IMPULSE_MUL`)调整,旧配方会用新参数重算数值 —— 这是**期望行为**(数值可热更),但也意味着「同一配方在不同版本给不同数值」 | 数值热更,定性冻结 | 若要求「配方一经发现永不改变」,需把 `budget`/`rolled` 也落库;建议保持现状(定性冻结、数值热更) | Lead |
| U8 | **`REACTION_RULES` 的 10 条规则是否为最终版**。当前覆盖了 20 个机制标签中的 18 个(「中空」「中空管状」「容器」等结构标签未参与反应) | 已实现 10 条 | 建议按需扩充到 15~20 条,让「结构 + 机制」也能产生反应(如「中空 + 声波 → 回音箱」) | Lead |
| U9 | **降级产物的可读性下限**。当前模板可能产出「铁皮溜溜荧光大剑」这类略显机械的名字。是否需要人工维护一张「高美学降级词表」 | 已可用 | 建议收集线上观感后迭代词表,不改结构 | WS-10 体验 |
| U10 | **多语言**。系统提示词与降级词表全是中文硬编码。若要做多语言,`CARRIER_WORD`/`MECHANIC_WORD`/`SYSTEM_PROMPT` 都要外置成资源包 | 中文硬编码 | 建议 v1 保持中文;若要出海,先把词表抽成 `Record<lang, ...>` | Lead |

---

## 附录 A · 文件清单

| 文件 | 行数量级 | 职责 |
| :--- | ---: | :--- |
| `server/src/alchemy/gate.ts` | ~370 | 门禁、亲和度、露水破格 |
| `server/src/alchemy/attributes.ts` | ~430 | 五步算法、ε 采样、化学反应、词条 |
| `server/src/alchemy/prompt.ts` | ~480 | JSON Schema、系统提示词、3 few-shot、校验器、重试协议 |
| `server/src/alchemy/pixel_icon.ts` | ~400 | 调色盘、9 套剪影美术、校验、光栅化、纹理载荷 |
| `server/src/alchemy/cache.ts` | ~330 | LlmClient/RecipeStore 接口、单飞、SQLite DDL、露水登记 |
| `server/src/alchemy/degrade.ts` | ~290 | 无网络确定性回退 |
| `server/src/alchemy/index.ts` | ~380 | 门面编排、五阶段串联、再导出 |
| `tests/WS-06.test.ts` | ~900 | 55 测试块 / 399 断言 |
| `docs/WS-06-alchemy.md` | 本文 | 设计文档(10 节) |

## 附录 B · 自检入口

```ts
import {
  selfCheckParams, gateSelfCheck, selfCheckArt,
  selfCheckFewShots, selfCheckDegrade, selfCheckCacheModule,
} from './server/src/alchemy/index.ts';

// 六个自检全部返回 { ok: boolean, errors: string[] },可在服务启动期跑一遍
```

## 附录 C · 最小可运行示例

```ts
import {
  createAlchemyService, MemoryRecipeStore, StubLlmClient,
} from './server/src/alchemy/index.ts';

const svc = createAlchemyService({
  store: new MemoryRecipeStore(),
  llm: new StubLlmClient({ reply: /* 结构化输出 */ }),
});

const r = await svc.forge({ itemIds: [156, 126], playerName: '小明', lvProf: 5 });
if (r.ok) {
  console.log(r.schema.item_name, r.instance.rolled);
  // → 用 r.icon.payload 直接构造 DataTexture
}
```