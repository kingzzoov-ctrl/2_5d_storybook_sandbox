# 炼金 6 模块缺口分析

> **本文档回答一个问题**:`server/src/alchemy/` 那 6 个内部模块
> (`attributes` / `cache` / `degrade` / `gate` / `pixel_icon` / `prompt`),
> **各自到底缺什么上游机制**,以及**最省的那一个为什么可以现在就接上**。
>
> 结论先行:**6 个模块缺的不是「机制」,而是「编排层的一个调用点」** ——
> 唯一的例外是 `cache.ts` 的生产 `LlmClient`,那属于网关层,本仓不该有。
> 按「前置依赖最少」排序,`gate.ts`(已同 `attributes` / `degrade` /
> `pixel_icon` / `prompt` 一起接线)是第一个该接的,实测已完成。
>
> 测量时间:2026-11-12。行数按当时工作实际统计。

---

## 一、对照表:6 模块 × 真实签名 × 上游需求

先给**真实导出签名**(从代码读出,不是推测),再给上游机制。

### 1.1 `gate.ts`(383 行,33 导出)

**核心签名**:

```ts
export function checkGate(req: GateRequest): GateResult
export interface GateRequest {
  itemIds: readonly number[];
  offerDew?: boolean;
  dewAlreadyUsed?: boolean;
  hasDewInBag?: boolean;
}
export function carrierTagsOf(itemId: number): string[]
export function mechanicTagsOf(itemId: number): string[]
export function resonanceTagsOf(materialIds: readonly number[]): string[]
export function collectTags(materialIds: readonly number[]): string[]
```

**上游机制**:无。**纯同步、纯函数、零 I/O**。依赖只有
`shared/types/alchemy.ts`(冻结表)+ `shared/constants/items.ts`(冻结物品表)
+ `./attributes.ts`(只取两个边界常量 `S_LOGIC_MIN` / `S_LOGIC_MAX`)。

**代码里存在吗**:存在,且**完整**。`ITEM_BY_ID` 是冻结层已经建好的 Map,
`CARRIER_TAGS` / `MECHANIC_TAGS` 是冻结层常量。

**缺什么**:只缺「有人调它」。**工作量:0 个新文件,0 条新逻辑。**

### 1.2 `attributes.ts`(618 行,58 导出)

**核心签名**:

```ts
export function rollStats(req: RollRequest): RollOutcome
export interface RollRequest {
  materialIds: readonly number[]; logicSynergyScore: number;
  statWeights: StatWeights; lvProf: number; useDew: boolean;
  tags: readonly string[]; primaryMechanic: PrimaryMechanic;
  rng?: () => number; seed?: number;
}
export function seededRng(seed: number): () => number
export function selfCheckParams(): ParamSelfCheck
```

**上游机制**:一份 `logicSynergyScore` + `statWeights` + `primaryMechanic`。
**这三个值从哪来**:来自 `gate.ts` 的 `suggested_s_logic` 与 LLM/降级器
给出的 `schema.stat_weights` / `schema.primary_mechanic`。

**代码里存在吗**:**全部存在**,且 `index.ts:352-361` 已经把三者串好。

**缺什么**:同 1.1。**工作量:0。**

### 1.3 `degrade.ts`(374 行,28 导出)

**核心签名**:

```ts
export function degradeGenerate(req: DegradeRequest): DegradeResult
export interface DegradeRequest {
  materials: readonly PromptMaterialLike[];
  affinity: number; suggestedSLogic: number; reason?: string;
}
```

**上游机制**:`GateResult.affinity` + `GateResult.suggested_s_logic`。
**触发条件**:LLM 网关失败 / JSON 校验连续 3 轮不过 / **客户端连的是离线单机房间**。

**代码里存在吗**:存在。它是 6 个模块里**唯一被设计为「不需要 LLM」**的,
这正是它能成为解锁点的原因。

**缺什么**:同 1.1。**工作量:0。**

### 1.4 `pixel_icon.ts`(508 行,31 导出)

**核心签名**:

```ts
export function buildIcon(
  matrix: readonly string[] | undefined,
  silhouette: BaseSilhouette,
  style: VisualStyle | (Pick<VisualStyle,'primary_color_hex'|'secondary_color_hex'|'outline_color_hex'> & { pixel_icon_16x16?: string[] }),
  keySource?: string,
): IconBuildResult
export function validatePixelMatrix(matrix: unknown): PixelMatrixCheck
export function rasterizePixelIcon(matrix: readonly string[], palette: Map<string, Rgba>): RasterResult
export function buildCanvasTexturePayload(raster: RasterResult, style: ..., keySource?: string): CanvasTexturePayload
```

**上游机制**:一份 16×16 字符矩阵 + 三个颜色值。**矩阵不合法时自动回退到
`SILHOUETTE_ART[silhouette]`** —— 也就是说,矩阵缺省**不会**让链路断掉。

**代码里存在吗**:**验收标准明确存在** —— 手册 L738:
> 「并在**客户端**实现 `16×16` 像素矩阵动态生成 2.5D 武器立牌」

这条按字面是**客户端**职责。本模块做的是**服务端侧的权威生成**
(调色盘 → RGBA 字节流 → `CanvasTexturePayload`),产出结构化载荷给客户端。

**缺什么**:**客户端渲染侧**(`THREE.DataTexture` 的创建与 `needsUpdate`),
属于 WS-09 的 16 个无构建步骤文件之一。**服务端侧零缺口。**

### 1.5 `prompt.ts`(742 行,31 导出)

**核心签名**:

```ts
export function buildUserPrompt(o: BuildUserPromptOptions): string
export function validateAlchemyOutput(raw: unknown): ValidationResult
export function extractJsonObject(text: string): { ok: boolean; value?: unknown; error?: string }
export function issueMessages(issues: readonly ValidationIssue[], limit: number): string[]
export const ALCHEMY_JSON_SCHEMA: Record<string, unknown>
export const SYSTEM_PROMPT: readonly string[]
export const FEW_SHOTS: readonly FewShot[]
```

**上游机制**:**一个接受 prompt、返回 JSON 的 LLM 网关**。
本模块只做「提示词装配 + 严格校验 + 错误回灌文案」,**不含 HTTP**。

**代码里存在吗**:**不存在,而且不该存在**。`WS-06-alchemy.md` §5 写得很清楚:
> 「不做网络。HTTP 客户端、重试退避、密钥管理、限流属于网关层;
> 本模块只依赖 `LlmClient.generateJson()`。」

**缺什么**:一个 `implements LlmClient` 的生产实现。**这条是真正的「等服务端机制」**,
但注意:**缺它不会阻塞其余 5 个模块** —— 因为 `degrade.ts` 把这条路兜住了。

### 1.6 `cache.ts`(398 行,22 导出)

**核心签名**:

```ts
export class RecipeCache {
  async resolve(hash: string, produce: () => Promise<{row; schema; degraded}>): Promise<CacheEntry>
  getStats(): CacheStats
}
export class MemoryRecipeStore implements RecipeStore
export class StubLlmClient implements LlmClient
export const SQLITE_DDL: readonly string[]
```

**上游机制**:一个 `RecipeStore`(落库)+ 一个 `LlmClient`。
**两者都是依赖注入契约,本仓已有内存实现**。

**代码里存在吗**:**DB 侧存在但未注入** —— `SQLITE_DDL` / `SQL_UPSERT_RECIPE`
只被 `tests/WS-06.test.ts` 引用;`db/driver.sqlite.ts` 在白名单里
(「驱动按 `DbLike` 结构化类型注入,生产入口尚未注入」)。

**缺什么**:把 `MemoryRecipeStore` 换成真 DB 的注入点。**工作量小**(驱动已有),
但**属于 WS-07 的收尾**,不是炼金自己的缺口。

---

## 二、按「前置依赖最少」排序

| # | 模块 | 上游需求 | 现成? | 工作量 | 可否现在接 |
| :- | :--- | :--- | :--- | :--- | :--- |
| 1 | `gate.ts` | 无 | ✅ | **0** | ✅ 已接 |
| 2 | `attributes.ts` | gate 的契合度建议 | ✅ | **0** | ✅ 已接 |
| 3 | `degrade.ts` | gate 的 affinity | ✅ | **0** | ✅ 已接 |
| 4 | `pixel_icon.ts` | 矩阵(可缺省) | ✅ | **0**(服务端) | ✅ 已接 |
| 5 | `cache.ts` | `RecipeStore` 注入 | ✅ 内存版可用 | 小(WS-07) | ✅ 已接(内存) |
| 6 | `prompt.ts` | **真 LLM 网关** | ❌ 本仓不该有 | 网关层任务 | ✅ 已接(降级路径) |

**排序理由**:1~3 互为一条链且零外部依赖;4 的输入可缺省(有回退);
5 有内存实现可用;6 的缺口**根本不阻塞**——因为 3 把失败路径兜住了。

**关键洞察**:这张表原本被读成「6 个模块都在等上游」。
实际读法是:**6 个模块都在等同一次接线,而接线只需要一个调用点**。

---

## 三、最省的一个:为什么是 `gate.ts` 那条链

### 3.1 选择了什么

把 `alchemy/index.ts`(它再导出全部 6 个模块)接进 `WorldSim`,
新增编排层入口 **`WorldSim.forgeAlchemy()`**。

**为什么不是只接 `gate.ts` 一个**:`index.ts` 的文件头写着
「对外只暴露一个 `forgeAlchemy()` 与一个工厂 `createAlchemyService()`,
内部把六条链路串成一条**同一事务语义**的流水线」。
单独调 `checkGate` 只会得到一个「门禁通过了」的布尔值 —— 那不是合成,
玩家拿不到任何东西。**接 `index.ts` 一次,6 个模块同时进可达闭包。**

### 3.2 为什么离线可用(这是能「现在接」的全部理由)

`createAlchemyService` 接受注入的 `LlmClient`。默认注入 `StubLlmClient`
(`cache.ts:144`,「测试用,**绝不联网**」),它恒返回 `null` ⇒
`generateWithRetry` 走满 `MAX_RETRY`(=2,共 3 次调用)后回退 `degradeGenerate`。

于是**不联网也能出产物**,而六条链路**每一步都被真实执行**:

```
gate.checkGate → cache.RecipeCache → prompt+LlmClient
  → degrade.degradeGenerate → attributes.rollStats → pixel_icon.buildIcon
```

这不是「假装接线」:每一环的产物都被断言过(见 §3.4)。

### 3.3 契约(DEV-PLAN 1.5 的验收条件)

DEV-PLAN 1.5 写的验收是「**合成消耗原料产出成品,总量守恒**」。
拆成三个**可失败**的检查:

1. **消耗必须真的发生** —— 材料按 `gate.materialIds` 从**地面掉落物**逐个扣减;
   扣不满就**整体放弃**(不扣任何料)。先 `preview` 预演门禁,
   门禁不过时**一件都不扣** —— 否则玩家丢错东西就永久损失。
2. **产物必须真的落地** —— 成品作为一件掉落物写回地面,于是
   `材料件数 → 成品件数` **可对账**,而不是只返回一个对象。
3. **失败必须零副作用** —— 三种失败路径(材料不足 / 件数不足 / 元素排斥)
   都断言「地面**逐字节**未变」。

判据是**扣减后的实际地面状态**,不是「我调了 forge」。
只返回 `ForgeResult` 而不动世界,就等于把「函数被调用过」当成「生效了」——
正是本仓反复出现的那类假接线。

### 3.4 怎么证明有效(含「确实会红」)

新增 `tests/WS-FND-08.test.ts`,**16 条用例,16/16 通过**。
与 `WS-FND-07` 同一纪律:全部走编排层入口 `WorldSim`,
**不直接 `new RecipeCache()`、不直接 `import forge`** ——
否则断言会退化成「我调了那个函数」,而这件事 WS-06 已经验证过 399 次。

**故障注入实测(回退 → 变红)**:

| 状态 | 结果 |
| :--- | :--- |
| 接线在位 | **16/16 通过** |
| 把默认构造换成「不接线的假服务」 | **3/16 通过**(13 条干净失败) |

13 条失败**全部是行为断言失败**,不是文件解析失败:

```
✗ WG-08-02 走编排层能出产物… — 合成应当成功:ROLL 未接线
✗ WG-08-03 原料被真的消耗… — 断言失败:期望为真
✗ WG-08-04 成品必须真的落地… — 断言失败:期望为真
✗ WG-08-06 材料不足 ⇒ 整体拒绝… — 失败阶段期望 "INVENTORY" / 实际 "ROLL"
✗ WG-08-07 门禁拒绝(件数不足)… — 失败阶段期望 "GATE" / 实际 "ROLL"
✗ WG-08-09 同组合第二次合成命中缓存… — 两次都应当成功
✗ WG-08-10 同种子 ⇒ 逐位可复现… — 断言失败:期望为真
```

**为什么强调「干净的断言失败」**:任何改坏文件的方式都能让测试变红
(比如写个语法错误),但那**不算证明**。这里注入的是**语法合法、
结构完整、行为全错**的替身,所以变红只能归因于「接线没了」。

**可达性凭证**:`verify.ts` 白名单里 alchemy 的 **7 条已全部摘除**;
可达数 **24 → 31(+7,与摘除条数精确相等)**。
另用一次性脚本按 `verify.ts` 同一套正则(裸副作用导入也匹配)独立复算了可达闭包,
确认这 7 个文件全部在闭包内 —— **独立复算与门禁口径一致**(脚本用完即删)。

### 3.5 诚实边界

- **本文档不声称「炼金已完整」**。接的是**离线/降级路径**;
  真 LLM 网关(HTTP / 密钥 / 退避 / 限流)仍属网关层,本仓不存在。
- **不声称可靠性与真网关一致**。降级器是**确定性**的
  (`degradeGenerate` 不消耗随机源),产物多样性显著低于 LLM 路径。
  这是设计取舍(「离线房的两台客户端必须看到同一件东西」),不是缺陷。
- **`forgeAlchemy` 的产物用占位 ID `-1`**。AI 产物按 `recipe_hash` 标识,
  冻结层**没有为奇物保留数字段位**(已核 `shared/types/alchemy.ts`)。
  真接入背包/掉落系统时需要一条「奇物实例 ↔ 数字 ID」的映射,属后续工作。
- **`-1` 的选择理由**:不能用 `0` —— `0` 是 `BaseFluid.VOID` / 「空槽」的约定值,
  会被掉落物系统当成空槽吞掉。

---

## 四、逐个模块的剩余真缺口(不是「等接线」的那种)

上面 §一 说「缺的是调用点」,那是针对**接线**而言。接线完成后,
以下是**仍然存在**的缺口,按性质分类:

| 模块 | 剩余缺口 | 性质 | 归属 |
| :--- | :--- | :--- | :--- |
| `prompt.ts` | 真 `LlmClient` 实现 | 部署层 | 网关任务(非本仓) |
| `cache.ts` | `SQLITE_DDL` 未在任何生产路径执行 | 接线 | WS-07(`driver.sqlite.ts` 也在白名单) |
| `cache.ts` | → 换真 DB 后「无 db 时的降级路径」未定义 | 设计 | WS-07 |
| `pixel_icon.ts` | 客户端 `THREE.DataTexture` 创建 + `needsUpdate` | 客户端 | WS-09(无构建步骤) |
| `degrade.ts` | 降级词表的美学下限(「铁皮溜溜荧光大剑」) | 体验 | WS-10(已登记 U9) |
| `gate.ts` | **无** | — | — |
| `attributes.ts` | **无**(`EPSILON_SIGMA` 已于 2026-11-12 对齐手册) | — | — |

**读法**:6 个模块里 **2 个已彻底无缺口**,其余 4 个的缺口都**不属于炼金自己** ——
分别是网关、WS-07、WS-09、WS-10 的任务。这正说明「等编排层接线」这个分类
此前把 4 条**别人的债**算在了炼金头上。

---

## 五、以后接同类模块的检查清单

这次接线的经验可复用。判定「某模块是真接线还是假接线」的四条:

1. **入口必须走编排层**。测试里不 `import` 被接模块的内部函数;
   走 `WorldSim` 这样的公开入口。否则是「我调了」,不是「接上了」。
2. **必须有第 2、3 个模块的产物被验证**。只验证「第一个函数被调到」
   等于没验证 —— 六条链路要逐条留痕(`gate.code` / `fromCache` /
   `degraded` / `breakdown` / `payload.data.length`)。
3. **失败路径必须零副作用**。三种失败各断言一次「状态逐字节未变」。
   这一条最容易漏,也最容易掩盖「部分扣料」这类真实伤害。
4. **必须做故障注入**。把接线摘掉、确认测试变红,再还原。
   **变红的必须是断言,不是语法错误** —— 后者不构成证明。

第 4 条是这次唯一「多做的一步」,但它是整份交付里信息量最大的一步:
它把「我认为测试有牙」变成了「测试有牙,实测」。
