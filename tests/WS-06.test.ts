/**
 * WS-06 万物奇想炼金炉 —— 可执行验收用例。
 *
 * 运行:`node tests/WS-06.test.ts`
 * 或:`node scripts/verify.ts --only WS-06`
 *
 * 零依赖:只用 `node:*` 与冻结层。随机源一律来自 `mulberry32(seed)`,
 * 因此每一条 Roll 断言都可逐位复现。
 */

import { test, ok, eq, near, includes, inRange, mulberry32, report } from '../shared/testing/harness.ts';

import {
  ALCHEMY_MAX_INPUTS,
  ALCHEMY_MIN_INPUTS,
  CARRIER_TAGS,
  DEW_ITEM_ID,
  MECHANIC_TAGS,
  RARITY_LABEL,
  RarityTier,
  recipeHash,
  type AlchemyCategory,
  type LLMAlchemyOutputSchema,
} from '../shared/types/alchemy.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
/* CR-17 用命名空间导入:`matchRecipeByTags` 尚不存在时,静态 import 会让整个文件
   加载失败(那不是「断言红」,是「语法错」,证据力弱)。走命名空间后缺失会落在
   断言里,报出我自己写的中文消息 —— 这才是「先红后绿」要的红。 */
import * as itemsMod from '../shared/constants/items.ts';
const ITEM_BY_ID = itemsMod.ITEM_BY_ID;
const satisfiesAnyTagSlot = (id: number, slot: string[]): boolean =>
  itemsMod.satisfiesAnyTagSlot(id, slot);
const matchRecipeByTags = (id, have) => itemsMod.matchRecipeByTags(id, have);
import {
  THROW_SPEED_XY, THROW_SPEED_Z, throwVelocity, resolveCircleBounce,
} from '../shared/types/physics.ts';

import {
  /* 门禁 */
  checkGate, affinityBreakdown, carrierTagsOf, mechanicTagsOf, resonanceTagsOf, gateSelfCheck,
  /* 算法 */
  powerMeanBreakdown, effectiveValue, materialValues, sampleTruncatedNormal, qualityBreakdown,
  rarityTierOf, affixCountOf, budgetOf, splitBudget, rollStats, rollReaction, applyWeightShift,
  weightsSum, selfCheckParams, pickAffixes,
  IMPULSE_BASE, IMPULSE_MUL, UTIL_CAP_PERCENT, RARITY_THRESHOLDS,
  EPSILON_MEAN, EPSILON_SIGMA, EPSILON_MIN, EPSILON_MAX,
  REACTION_RULES, AFFIX_POOL,
  /* 像素 */
  ICON_SIZE, ICON_BYTES, SILHOUETTE_ART, MIN_INK_PIXELS,
  validatePixelMatrix, rasterizePixelIcon, pixelAt, matrixFromRgba, paletteFrom,
  buildCanvasTexturePayload, buildIcon, canonicalArt, selfCheckArt,
  /* 协议 */
  ALCHEMY_JSON_SCHEMA, SYSTEM_PROMPT, FEW_SHOTS, MAX_RETRY, MAX_ITEM_NAME_LEN,
  buildUserPrompt, validateAlchemyOutput, issueMessages, extractJsonObject, selfCheckFewShots,
  /* U4:类别 × 机制交叉矩阵 */
  CATEGORY_MECHANIC_ALLOWED, defaultMechanicFor, isMechanicAllowed, correctMechanic,
  type PromptMaterial,
  /* 降级 */
  degradeGenerate, selfCheckDegrade,
  /* 缓存 */
  MemoryRecipeStore, StubLlmClient, MemoryDewLedger, buildRecipeRow,
  sanitizeDiscoverer, selfCheckCacheModule, SQLITE_DDL, SQL_UPSERT_RECIPE,
  /* 编排 */
  createAlchemyService, generateWithRetry, saneWeights, fnv1a32, promptMaterialsOf,
} from '../server/src/alchemy/index.ts';

/* ══════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════ */

const SWORD_ART_156 = [...SILHOUETTE_ART.SWORD];

function mats(ids: readonly number[]): PromptMaterial[] {
  return promptMaterialsOf(ids);
}

/** 一个合法的 LLM 结构化输出(基于 few-shot #0 克隆,便于逐字段篡改) */
function validOutput(): LLMAlchemyOutputSchema {
  return JSON.parse(JSON.stringify(FEW_SHOTS[0].output)) as LLMAlchemyOutputSchema;
}

/** 把配方 hash 与缓存串起来的便捷 store */
function freshStack(opts: { reply?: unknown; replies?: unknown[]; failWith?: string | Error; delayMs?: number } = {}) {
  const store = new MemoryRecipeStore();
  const llm = new StubLlmClient(opts);
  const ledger = new MemoryDewLedger();
  const svc = createAlchemyService({ store, llm, dewLedger: ledger });
  return { store, llm, ledger, svc };
}

/* ══════════════════════════════════════════════════════════════
 * 一、参数配表与自检(4 条)
 * ══════════════════════════════════════════════════════════════ */

test('A1 全部参数配表内部自洽(反应表/阈值/ε)', () => {
  const r = selfCheckParams();
  ok(r.ok, `参数自检失败:${r.errors.join(' / ')}`);
  eq(RARITY_THRESHOLDS[0], 1.0, '档位下界 1.00');
  eq(RARITY_THRESHOLDS[1], 1.25, '档位下界 1.25');
  eq(RARITY_THRESHOLDS[2], 1.55, '档位下界 1.55');
  near(EPSILON_MEAN, 1.0);
  /*
   * σ = 0.12,不是 0.122。
   *
   * 手册 L568 原文:`\varepsilon \sim \mathcal{N}(1.0, 0.12^2)`,
   * 正态记号里的第二个参数是**方差**?不 —— `\mathcal{N}(μ, σ²)` 是标准记号,
   * 第二个参数写的是 **σ²**。故 σ = 0.12。
   *
   * 原实现取 0.122 且注释自述 `N(1.0, 0.1222)`,与常量自洽但**与手册不符**,
   * 也无任何推导/标定记录 ⇒ 判定为转写笔误。详见 `attributes.ts` 该常量注释。
   */
  near(EPSILON_SIGMA, 0.12);
});

test('A2 门禁白名单来自冻结层且两表不重叠', () => {
  const r = gateSelfCheck();
  ok(r.ok, `门禁白名单自检失败:${r.errors.join(' / ')}`);
  eq(CARRIER_TAGS.length, 32, '载体词条 32 个');
  eq(MECHANIC_TAGS.length, 43, '机制词条 43 个');
  const overlap = CARRIER_TAGS.filter((t) => MECHANIC_TAGS.includes(t));
  eq(overlap.length, 0, '载体与机制不得重叠,否则门禁被绕过');
});

test('A3 九个剪影的规范美术全部合法(16×16 且字符在盘内)', () => {
  const r = selfCheckArt();
  ok(r.ok, `剪影美术自检失败:${r.errors.join(' / ')}`);
  eq(Object.keys(SILHOUETTE_ART).length, 9, '九种剪影');
  /* 期望值写「字面量 16」,不引 `ICON_SIZE`。
   *
   * 16 的独立来源(不是从被测源码抄的):
   *   手册 §5.5「16×16 像素立牌」,本仓落点 `docs/WS-06-alchemy.md:477`
   *   (参数表原文 `ICON_SIZE | 16 | 手册 §5.5 16×16`),同一文档 `:369`
   *   给出 schema 规格 `minItems:16, maxItems:16` —— 两处独立于
   *   `pixel_icon.ts`。
   *
   * 为什么不引 `ICON_SIZE` —— 实测给出两条理由(都不是推理):
   *   1 本 test 上面 :126 的 `ok(r.ok, ...)` 会 throw,而 `selfCheckArt()`
   *     内部已用 `validatePixelMatrix` 比过 `matrix.length` / `row.length`
   *     与 `ICON_SIZE`。故「行数/行宽与常量不符」在 :126 就被拦下,
   *     下面两条在**只改常量**的场景里根本执行不到
   *     (实测:注入 16→8,报错出自 :126,不是这两行)。
   *     ⇒ 引 `ICON_SIZE` 时它们对「常量被改」无区分力(被遮蔽)。
   *   2 写字面量 16 后,它们才在「常量与美术**一起**被改成 8」这种
   *     :126 抓不到的场景里变红 —— 那正是它们**唯一**独立于 :126 的价值。
   *   ※ :127 的「九种剪影」计数不在本条范围内,它由形状枚举独立守着。
   */
  for (const [name, art] of Object.entries(SILHOUETTE_ART)) {
    eq(art.length, 16, `${name} 行数`);
    for (const row of art) eq(row.length, 16, `${name} 行宽`);
  }
});

test('A4 三个 few-shot 全部能通过严格校验器', () => {
  const r = selfCheckFewShots();
  ok(r.ok, `few-shot 自检失败:${r.errors.join(' / ')}`);
  eq(FEW_SHOTS.length, 3, 'few-shot 数量必须为 3');
  for (const fs of FEW_SHOTS) {
    const v = validateAlchemyOutput(fs.output);
    ok(v.ok, `few-shot「${fs.output.item_name}」应通过校验`);
  }
});

/* ══════════════════════════════════════════════════════════════
 * 二、配方哈希与缓存(6 条)
 * ══════════════════════════════════════════════════════════════ */

test('B1 recipeHash 排序稳定:任意输入顺序得同一键', () => {
  eq(recipeHash([712, 116, 125]), '116_125_712');
  eq(recipeHash([116, 125, 712]), '116_125_712');
  eq(recipeHash([125, 712, 116]), '116_125_712');
  eq(recipeHash([156, 126]), '126_156', '双料同样按升序拼接');
});

test('B2 recipeHash 拒绝非法 ID(0/负数/NaN)', () => {
  let caught = 0;
  for (const bad of [[0], [-1], [Number.NaN], [156, 0]]) {
    try {
      recipeHash(bad);
    } catch {
      caught += 1;
    }
  }
  eq(caught, 4, '四种非法输入都必须抛错');
});

test('B3 缓存命中第二次合成 0 Token(LLM 调用次数不增)', async () => {
  const { llm, svc } = freshStack({ reply: validOutput() });
  const req = { itemIds: [156, 126], playerName: '小明' };
  const first = await svc.forge(req);
  ok(first.ok, '首次合成应成功');
  eq(llm.calls, 1, '首次应调 1 次 LLM');
  eq(first.fromCache, false, '首次不是缓存命中');
  ok(first.llmTokensUsed >= 1, '首次应消耗 Token');

  const second = await svc.forge(req);
  ok(second.ok, '第二次合成应成功');
  eq(llm.calls, 1, '第二次必须 0 Token:LLM 调用次数不得增加');
  eq(second.fromCache, true, '第二次应命中缓存');
  eq(second.llmTokensUsed, 0, '缓存命中 Token 消耗必须为 0');
  eq(second.schema.item_name, first.schema.item_name, '同一 hash 必须得到同一件奇物');
});

test('B4 同一 hash 输入顺序不同也命中同一缓存行', async () => {
  const { llm, svc, store } = freshStack({ reply: validOutput() });
  const a = await svc.forge({ itemIds: [156, 126] });
  const b = await svc.forge({ itemIds: [126, 156] });
  ok(a.ok && b.ok);
  eq(a.recipeHash, b.recipeHash, '两者哈希相同');
  eq(llm.calls, 1, '顺序不同不得触发第二次 LLM');
  eq(store.size, 1, '缓存里只允许有一条配方');
});

test('B5 并发去重:同 hash 并发 10 个请求,LLM 只被调 1 次', async () => {
  const { llm, svc } = freshStack({ reply: validOutput(), delayMs: 15 });
  const reqs = Array.from({ length: 10 }, () => svc.forge({ itemIds: [116, 125, 104] }));
  const all = await Promise.all(reqs);

  eq(all.length, 10, '10 个请求都应返回');
  ok(all.every((r) => r.ok), '10 个请求都应成功');
  eq(llm.calls, 1, `并发 10 个同 hash 请求,LLM 只应被调 1 次,实际 ${llm.calls}`);

  const names = new Set(all.map((r) => (r.ok ? r.schema.item_name : 'ERR')));
  eq(names.size, 1, '10 个请求必须拿到同一件奇物(名字集合大小应为 1)');

  const hashes = new Set(all.map((r) => (r.ok ? r.recipeHash : 'ERR')));
  eq(hashes.size, 1, '10 个请求的 recipe_hash 必须一致');

  const stats = svc.stats();
  eq(stats.llmCalls, 1, '统计口径的 LLM 调用数也应为 1');
  eq(stats.dedupedRequests, 9, '应有 9 个请求被单飞锁合并');
  eq(stats.misses, 10, '10 个请求都算未命中(同一时刻)');
});

test('B6 craft_count 随每次合成累加,首发现者只冠名一次', async () => {
  const { svc, store } = freshStack({ reply: validOutput() });
  await svc.forge({ itemIds: [156, 126], playerName: '第一个发现者' });
  const row1 = store.all()[0];
  eq(row1.craft_count, 1, '首次合成 craft_count 应为 1');
  eq(row1.discoverer_name, '第一个发现者', '首发现者应被冠名');

  await svc.forge({ itemIds: [156, 126], playerName: '后来的玩家' });
  await svc.forge({ itemIds: [156, 126], playerName: '第三个人' });
  const row2 = store.all()[0];
  eq(row2.craft_count, 3, '三次合成后 craft_count 应为 3');
  eq(row2.discoverer_name, '第一个发现者', '冠名不得被后续玩家覆盖');
});

/* ══════════════════════════════════════════════════════════════
 * 三、门禁(6 条)
 * ══════════════════════════════════════════════════════════════ */

test('C1 门禁正例:载体 + 机制双命中放行并给出亲和度', () => {
  const g = checkGate({ itemIds: [156, 126] }); // 寒铁锭(金属/锋利) + 爆裂火椒(爆炸/火焰)
  ok(g.pass, `应放行,实际拒绝:${g.message}`);
  eq(g.code, 'PASS');
  eq(g.k, 2);
  includes(g.carrierHits, '金属', '应命中载体「金属」');
  includes(g.mechanicHits, '爆炸', '应命中机制「爆炸」');
  inRange(g.affinity, 0, 1);
  /* 区间取自**手册** §5.3 L568:`S_logic ∈ [0.80, 1.50]`。
     引用实现常量会让「区间内」恒真 —— 实现把区间放宽到 [0,999] 也不会红。 */
  inRange(g.suggested_s_logic, 0.80, 1.50, '契合度建议应落在手册区间');
  ok(g.affinity > 0.5, `双维齐备的亲和度应 > 0.5,实际 ${g.affinity}`);
});

test('C2 门禁反例:只有载体没有机制 → 元素排斥', () => {
  const g = checkGate({ itemIds: [101, 118] }); // 暖松原木(木材) + 柔韧风草(纤维),两者均无机制
  ok(!g.pass, '应拒绝');
  eq(g.code, 'MISSING_MECHANIC');
  eq(g.affinity, 0, '拒绝时亲和度必须为 0');
  ok(g.message.includes('元素排斥'), `提示应含「元素排斥」,实际:${g.message}`);
  ok(g.message.length > 10, '必须给出可读的补救提示');
});

test('C3 门禁反例:只有机制没有载体 → 元素排斥', () => {
  /* 116 萤光魔晶簇(发光/导电/激光)+ 126 爆裂火椒(爆炸/火焰):全是机制,没有载体 */
  const g = checkGate({ itemIds: [116, 126] });
  ok(!g.pass, '应拒绝');
  eq(g.code, 'MISSING_CARRIER');
  eq(g.carrierHits.length, 0, '确实没有命中任何载体词条');
  ok(g.mechanicHits.length > 0, '机制词条应当命中');
  ok(g.message.includes('元素排斥'));
});

test('C4 门禁反例:双维皆空 / k 越界 / 未知 ID', () => {
  const both = checkGate({ itemIds: [237, 701] }); // 七彩颜料水球 + 鲜嫩野味肉块:无载体无机制
  eq(both.code, 'MISSING_BOTH');
  ok(!both.pass);

  const k1 = checkGate({ itemIds: [156] });
  eq(k1.code, 'K_OUT_OF_RANGE', 'k=1 应越界');
  const k5 = checkGate({ itemIds: [156, 126, 116, 125, 104] });
  eq(k5.code, 'K_OUT_OF_RANGE', 'k=5 应越界');
  eq(ALCHEMY_MIN_INPUTS, 2);
  eq(ALCHEMY_MAX_INPUTS, 4);

  const unknown = checkGate({ itemIds: [156, 99999] });
  eq(unknown.code, 'UNKNOWN_ITEM', '未知 ID 应被拒绝');
});

test('C5 露水破格:只缺一个维度时可用露水放行一次', () => {
  const denied = checkGate({ itemIds: [116, 126] }); // 只有机制,缺载体
  ok(!denied.pass, '不放露水应拒绝');
  eq(denied.code, 'MISSING_CARRIER');

  const passed = checkGate({ itemIds: [116, 126], offerDew: true, hasDewInBag: true });
  ok(passed.pass, '投露水应放行');
  eq(passed.code, 'PASS_WITH_DEW');
  ok(passed.dewRelease !== null, '必须给出破格方案');
  eq(passed.dewRelease!.itemId, DEW_ITEM_ID, '消耗品应为梦境露水 #130');
  eq(passed.dewRelease!.amount, 1, '每次消耗 1 份');
  eq(passed.dewRelease!.patches, 'CARRIER', '本次补的是载体维度');
  /* 0.9 取自**设计基线**(手册 §5.3 未给出该折扣系数),不引用实现常量 ——
     引用 `DEW_RELEASE_QUALITY_PENALTY` 会让期望值随实现漂移,断言恒真。 */
  near(passed.dewRelease!.qualityPenalty, 0.9, 1e-9, '露水破格品质折扣应为 0.9');
  ok(passed.affinity < 0.85, '破格放行的亲和度应低于正常放行(有折扣)');
});

test('C6 露水破格的两道闸:已用过 / 背包没有', () => {
  const used = checkGate({ itemIds: [116, 126], offerDew: true, hasDewInBag: true, dewAlreadyUsed: true });
  ok(!used.pass, '同一配方已用过露水应拒绝');
  eq(used.code, 'DEW_ALREADY_USED');

  const noBag = checkGate({ itemIds: [116, 126], offerDew: true, hasDewInBag: false });
  ok(!noBag.pass, '背包无露水应拒绝');
  eq(noBag.code, 'NO_DEW_IN_BAG');

  const okCase = checkGate({ itemIds: [116, 126], offerDew: true, hasDewInBag: true });
  ok(okCase.pass, '对照组:条件齐备时应放行');
});

test('C7 露水计算材料位:塞进材料位的露水不算第 3 件材料', () => {
  const g = checkGate({ itemIds: [156, 126, DEW_ITEM_ID] });
  eq(g.k, 2, '露水被剥离后 k 应为 2');
  eq(g.dewStripped, 1, '应识别出 1 件露水');
  eq(g.usesDew, true, '应标记本次使用露水');
  ok(g.pass, '剥离后双维齐备应放行');
});

/* ══════════════════════════════════════════════════════════════
 * 四、五步属性算法 —— 手算对照(8 条)
 * ══════════════════════════════════════════════════════════════ */

test('D1 手算对照 A:k=2 寒铁锭45 + 爆裂火椒38', () => {
  const pm = powerMeanBreakdown(materialValues([156, 126]));
  eq(pm.k, 2);
  /* 45^1.35 = 170.544176 ; 38^1.35 = 135.740003 */
  near(pm.powered[0], 170.544176, 1e-6, '45^1.35');
  near(pm.powered[1], 135.740003, 1e-6, '38^1.35');
  near(pm.poweredSum, 306.284180, 1e-5, 'ΣV^1.35');
  near(pm.poweredMean, 153.142090, 1e-5, 'Σ/k');
  near(pm.powerMean, 41.551678, 1e-6, '幂平均回开 1/1.35');
  near(pm.kMultiplier, 1.12, 1e-9, '(1+0.12(2-1))');
  near(pm.tEff, 46.537880, 1e-6, 'T_eff = 41.551678 × 1.12');
});

test('D2 手算对照 B:k=3 萤光魔晶50 + 滑溜香蕉28 + 夜光菌木28', () => {
  const pm = powerMeanBreakdown(materialValues([116, 125, 104]));
  eq(pm.k, 3);
  near(pm.powered[0], 196.611767, 1e-6, '50^1.35');
  near(pm.powered[1], 89.880058, 1e-6, '28^1.35');
  near(pm.poweredSum, 376.371882, 1e-5, 'Σ');
  near(pm.poweredMean, 125.457294, 1e-5, 'Σ/3');
  near(pm.powerMean, 35.846059, 1e-6, '回开');
  near(pm.kMultiplier, 1.24, 1e-9, '(1+0.12×2)');
  near(pm.tEff, 44.449114, 1e-6, 'T_eff');
});

test('D3 手算对照 C:k=4 高价值材料 T_eff 与预算', () => {
  const pm = powerMeanBreakdown(materialValues([157, 117, 120, 745]));
  eq(pm.k, 4);
  near(pm.powered[0], 402.453353, 1e-6, '85^1.35');
  near(pm.powered[1], 641.054100, 1e-6, '120^1.35');
  near(pm.powered[2], 170.544176, 1e-6, '45^1.35');
  near(pm.powered[3], 945.283281, 1e-6, '160^1.35');
  near(pm.poweredSum, 2159.334910, 1e-5, 'Σ');
  near(pm.powerMean, 105.656521, 1e-6, '回开');
  near(pm.kMultiplier, 1.36, 1e-9, '(1+0.12×3)');
  near(pm.tEff, 143.692869, 1e-6, 'T_eff');

  /* Q = 1.05 × (1 + 0.02×10 + 0.15) × 1.0 = 1.05 × 1.35 = 1.4175
     Lv_prof 取 10 是**手册 §5.3 L568** 的上限(Lv_prof ∈ [1,10]);
     2026-11 前本测试跟着实现抄了 30,使专精乘子虚高到 1.75。 */
  const q = qualityBreakdown(1.05, 10, true, 1.0);
  near(q.profMultiplier, 1.35, 1e-9, '1+0.2+0.15(手册 L568:Lv_prof 上限 10)');
  near(q.q, 1.4175, 1e-9, 'Q');
  /* 传 30 必须被钳到手册上限 10(证明 PROF_MAX_LEVEL=10 真生效) */
  eq(qualityBreakdown(1.05, 30, true, 1.0).lvProf, 10, 'Lv_prof=30 被钳到 10');
  /* P = round(8.5 × 143.692869^0.82 × 1.8375) = round(918.42…) = 918 */
  eq(budgetOf(pm.tEff, q.q), 708, 'P_budget 手算值');
});

test('D4 手算对照 D:ε 取上限 1.25 时 Q 与四维切分', () => {
  const pm = powerMeanBreakdown(materialValues([157, 117, 120, 745]));
  const q = qualityBreakdown(1.05, 10, true, 1.25);
  near(q.epsilon, 1.25, 1e-9, 'ε 已被截断到上限');
  near(q.q, 1.771875, 1e-9, 'Q = 1.05×1.35×1.25');
  eq(budgetOf(pm.tEff, q.q), 885, 'P_budget');

  const w = { atk_weight: 0.5, def_weight: 0.2, impulse_weight: 0.2, utility_weight: 0.1 };
  const s = splitBudget(885, w);
  /* ATK = round(885×0.5×1.2) = round(531.0) = 531 */
  eq(s.atk, 531, 'ATK');
  /* DEF = round(885×0.2×0.6) = round(106.2) = 106 */
  eq(s.def, 106, 'DEF');
  /* HP = round(885×0.2×2.5) = round(442.5) = 443 */
  eq(s.hp, 443, 'HP');
  /* F = 3.0 + round(885×0.2×0.15) = 3 + round(26.55) = 3 + 27 = 30 */
  eq(s.impulse, 30, 'F_impulse = 3.0 + round(内层乘积)');
  /* Util = min(50, round(885×0.1×0.4)) = min(50, 35) = 35 */
  eq(s.util, 35, 'Util%');
  /* 中间量必须可复核 */
  near(s.atkRaw, 531.0, 1e-9, 'ATK 中间量');
  near(s.hpRaw, 442.5, 1e-9, 'HP 中间量');
  near(s.impulseRaw, 26.55, 1e-9, 'F_impulse 中间量');
  near(s.utilRaw, 35.4, 1e-9, 'Util 中间量');
});

test('D5 手算对照 E:低契合度 + ε 下限 → 凡品档', () => {
  const pm = powerMeanBreakdown(materialValues([156, 126]));
  /* 传 0.6 低于手册下界 0.80(L568),会被钳到 0.80 ⇒ 取到的是
     「最差可用契合度」= 0.80,而不是旧实现的 0.60。 */
  const q = qualityBreakdown(0.6, 0, false, 0.8);
  eq(q.sLogic, 0.80, 'S_logic 传 0.6 被钳到手册下界 0.80');
  near(q.q, 0.64, 1e-9, 'Q = 0.80 × 1.0 × 0.80');
  eq(rarityTierOf(q.q), RarityTier.COMMON, 'Q<1.00 应落凡品');
  eq(budgetOf(pm.tEff, q.q), 127, 'P_budget');

  const s = splitBudget(127, { atk_weight: 0.5, def_weight: 0.2, impulse_weight: 0.2, utility_weight: 0.1 });
  eq(s.atk, 76, 'round(76.2)');
  eq(s.def, 15, 'round(15.24)');
  eq(s.hp, 64, 'round(63.5)');
  eq(s.impulse, 7, '3 + round(3.81) = 3 + 4');
  eq(s.util, 5, 'round(5.08)');
});

test('D6 四档稀有度边界:1.00 / 1.25 / 1.55 严格分档 + 词条数 1/2/3/4', () => {
  const edges: [number, number][] = [
    [0.9999, 0], [1.0, 1], [1.2499, 1], [1.25, 2],
    [1.5499, 2], [1.55, 3], [9.9, 3],
  ];
  for (const [q, tier] of edges) {
    eq(rarityTierOf(q), tier, `Q=${q} 应落档 ${tier}`);
  }
  eq(RARITY_LABEL[0].affixes, 1);
  eq(RARITY_LABEL[1].affixes, 2);
  eq(RARITY_LABEL[2].affixes, 3);
  eq(RARITY_LABEL[3].affixes, 4);
  eq(affixCountOf(RarityTier.COMMON, false), 1, '凡品 1 词条');
  eq(affixCountOf(RarityTier.LEGENDARY, false), 4, '神品 4 词条');
  eq(affixCountOf(RarityTier.LEGENDARY, true), 5, '突变额外 +1 词条');
});

test('D7 T_eff 幂平均的性质:件数加成单调、垃圾料拖低、严格高于算术平均', () => {
  const two = effectiveValue([45, 38]);
  const three = effectiveValue([45, 38, 38]);
  const four = effectiveValue([45, 38, 38, 38]);
  ok(three > two, `k=3 应优于 k=2(${three} > ${two})`);
  ok(four > three, `k=4 应优于 k=3(${four} > ${three})`);

  const doped = effectiveValue([45, 8]);
  ok(doped < two, '塞低价值材料应拖低 T_eff,而不是被平均掉');

  /* 幂平均 p=1.35 > 1:等值时退化为该值;不等值时严格大于算术平均 */
  const pmEqual = powerMeanBreakdown([40, 40, 40]);
  near(pmEqual.powerMean, 40, 1e-9, '等值时幂平均应精确等于该值');
  near(pmEqual.tEff, 40 * 1.24, 1e-9, '等值时 T_eff = 40 × 1.24');

  const pmSpread = powerMeanBreakdown([120, 8]);
  const arith = (120 + 8) / 2;
  ok(pmSpread.powerMean > arith, `1.35 次幂平均必须严格高于算术平均(${pmSpread.powerMean} > ${arith})`);

  const pmMild = powerMeanBreakdown([45, 38]);
  ok(pmMild.powerMean > (45 + 38) / 2, '接近值同样高于算术平均');
  near(pmMild.powerMean, 41.551678, 1e-6, '手算值复核');
});

test('D8 ε 截断正态:10000 次采样全部落在 [0.80,1.25],均值≈1.0', () => {
  const rng = mulberry32(20260101);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const N = 10000;
  for (let i = 0; i < N; i += 1) {
    const e = sampleTruncatedNormal({ mean: EPSILON_MEAN, sigma: EPSILON_SIGMA, min: EPSILON_MIN, max: EPSILON_MAX }, rng);
    inRange(e, EPSILON_MIN, EPSILON_MAX, `第 ${i} 次采样越出截断区间`);
    sum += e;
    if (e < min) min = e;
    if (e > max) max = e;
  }
  const mean = sum / N;
  near(mean, 1.0, 0.01, `截断后均值应≈1.0,实际 ${mean}`);
  ok(min >= EPSILON_MIN && max <= EPSILON_MAX, '极值必须在截断区间内');
});

/* ══════════════════════════════════════════════════════════════
 * 五、化学反应突变(4 条)
 * ══════════════════════════════════════════════════════════════ */

test('E1 反应表覆盖 10 条规则,概率与预算乘子合法', () => {
  eq(REACTION_RULES.length, 10, '反应规则 10 条');
  const ids = new Set(REACTION_RULES.map((r) => r.id));
  eq(ids.size, 10, '规则 id 不重复');
  for (const r of REACTION_RULES) {
    inRange(r.probability, 0.01, 1, `${r.id} 概率`);
    ok(r.budgetMul >= 1, `${r.id} 预算乘子不应为负收益`);
    eq(r.pair.length, 2, `${r.id} 必须是双词条`);
  }
  includes(REACTION_RULES.map((r) => r.name), '蒸汽冲刺', '必须包含「极滑+火焰→蒸汽冲刺」样例');
});

test('E2 触发条件:两个标签齐备才掷点,单标签不触发', () => {
  const rng = mulberry32(7);
  let hitSingle = 0;
  for (let i = 0; i < 500; i += 1) {
    if (rollReaction(['极滑'], rng)) hitSingle += 1;
  }
  eq(hitSingle, 0, '只有 1 个标签时不得触发任何反应');

  let hitNone = 0;
  for (let i = 0; i < 500; i += 1) {
    if (rollReaction(['木材', '锋利'], rng)) hitNone += 1;
  }
  eq(hitNone, 0, '无关标签不得触发反应');
});

test('E3 概率分布:蒙特卡洛实测频率与配表一致(±0.03)', () => {
  const N = 20000;
  const probes: [string, string[], number][] = [
    ['蒸汽冲刺', ['极滑', '火焰'], 0.55],
    ['镜面溜冰', ['冰冻', '极滑'], 0.5],
    ['齐奏战歌', ['音乐', '战歌'], 0.35],
    ['崩星一击', ['坚硬', '暴击'], 0.3],
  ];
  for (const [name, tags, expected] of probes) {
    const rng = mulberry32(424242);
    let hits = 0;
    for (let i = 0; i < N; i += 1) {
      const hit = rollReaction(tags, rng);
      if (hit && hit.rule.name === name) hits += 1;
    }
    const freq = hits / N;
    near(freq, expected, 0.03, `${name} 实测频率 ${freq.toFixed(4)} 偏离配表 ${expected}`);
  }
});

test('E4 突变效果:覆盖元素/光环、重算权重和为 1、提升预算', () => {
  const base = { atk_weight: 0.4, def_weight: 0.3, impulse_weight: 0.2, utility_weight: 0.1 };
  const steam = REACTION_RULES.find((r) => r.name === '蒸汽冲刺')!;
  const shifted = applyWeightShift(base, steam.weightShift);
  near(weightsSum(shifted), 1, 1e-9, '权重增量后必须重新归一化到 1');
  eq(steam.element, 'FIRE', '蒸汽冲刺覆盖副元素为 FIRE');
  eq(steam.aura, 'FLAME', '蒸汽冲刺覆盖光环为 FLAME');

  /* 同一输入下,带突变标签的 Roll 预算应 ≥ 无突变标签的预算 */
  const tagsNo = ['木材', '锋利'];
  const tagsYes = ['木材', '锋利', '极滑', '火焰'];
  const reqBase = {
    materialIds: [156, 126], logicSynergyScore: 1.0, statWeights: base,
    lvProf: 0, useDew: false, primaryMechanic: 'SLASH_WAVE' as const,
  };
  const noHit = rollStats({ ...reqBase, tags: tagsNo, seed: 999 });
  const withMut = rollStats({ ...reqBase, tags: tagsYes, seed: 999 });
  ok(withMut.breakdown.reaction !== undefined, '带「极滑+火焰」应触发突变');
  ok(withMut.breakdown.budget >= noHit.breakdown.budget, '突变后预算不应低于未突变');
  ok(withMut.stats.rolled.affixes.length >= noHit.stats.rolled.affixes.length, '突变应至少不减少词条数');
  eq(withMut.elementOverride, 'FIRE', '突变后副元素被覆盖');
});

/* ══════════════════════════════════════════════════════════════
 * 六、LLM 协议与 Schema 校验(6 条)
 * ══════════════════════════════════════════════════════════════ */

test('F1 JSON Schema 严格性:additionalProperties:false + required 全列 + enum 全覆盖', () => {
  const schema = ALCHEMY_JSON_SCHEMA as Record<string, unknown>;
  eq(schema.type, 'object');
  eq(schema.additionalProperties, false, '顶层必须 additionalProperties:false');
  eq(JSON.stringify(schema.required), JSON.stringify([
    'item_name', 'lore_description', 'item_category', 'primary_mechanic',
    'secondary_element', 'logic_synergy_score', 'stat_weights', 'visual_style',
  ]), 'required 必须列全 8 个字段');

  const props = schema.properties as Record<string, Record<string, unknown>>;
  eq(Object.keys(props).length, 8, 'properties 恰好 8 个');
  eq(props.visual_style.additionalProperties, false, 'visual_style 也必须严格');
  eq(props.stat_weights.additionalProperties, false, 'stat_weights 也必须严格');

  const icon = (props.visual_style.properties as Record<string, Record<string, unknown>>).pixel_icon_16x16;
  /* 期望值写**字面量 16**,不引 `ICON_SIZE`。
     schema 的 minItems/maxItems **直接取自 ICON_SIZE**(见 prompt.ts 的 pixel_icon_16x16 定义),
     故引用 `ICON_SIZE` 会让两边同步移动 —— 把常量改成任何值这两条都恒真。
     16 取自**设计基线**(像素阵固定 16×16),下方另用 `eq(ICON_SIZE, 16)` 双向锚定常量本身。 */
  eq(icon.minItems, 16, 'pixel 数组最小 16 项');
  eq(icon.maxItems, 16, 'pixel 数组最大 16 项');
  eq(ICON_SIZE, 16, 'ICON_SIZE 本身 = 16(设计基线,像素阵 16×16)');

  const cats = props.item_category.enum as string[];
  eq(cats.length, 7, '七个类别枚举');
  eq((props.primary_mechanic.enum as string[]).length, 10, '十种主机制');
  eq((props.secondary_element.enum as string[]).length, 8, '八种副元素');
});

test('F2 校验拒绝:权重之和不等于 1 → 归一化;全 0 → 硬失败', () => {
  const o1 = validOutput();
  o1.stat_weights = { atk_weight: 0.5, def_weight: 0.5, impulse_weight: 0.5, utility_weight: 0.5 };
  const r1 = validateAlchemyOutput(o1);
  ok(r1.ok, '和为 2 应被自动归一化而不是拒绝');
  near(weightsSum(r1.value!.stat_weights), 1, 1e-9, '归一化后和必须为 1');
  ok(r1.issues.some((i) => i.code === 'NORMALIZED'), '应记录 NORMALIZED 提示');

  const o2 = validOutput();
  o2.stat_weights = { atk_weight: 0, def_weight: 0, impulse_weight: 0, utility_weight: 0 };
  const r2 = validateAlchemyOutput(o2);
  ok(!r2.ok, '四项全 0 必须硬失败');
  ok(r2.issues.some((i) => i.code === 'ALL_ZERO'), '应给出 ALL_ZERO');

  const o3 = validOutput();
  o3.stat_weights = { atk_weight: 1.5, def_weight: -0.2, impulse_weight: 0, utility_weight: 0 } as never;
  ok(!validateAlchemyOutput(o3).ok, '权重越界 [0,1] 必须拒绝');
});

test('F3 校验拒绝:pixel 行数/行宽/非法字符/category 非法/缺字段/多字段', () => {
  const badRows = validOutput();
  badRows.visual_style.pixel_icon_16x16 = badRows.visual_style.pixel_icon_16x16.slice(0, 15);
  const r1 = validateAlchemyOutput(badRows);
  ok(!r1.ok, '15 行必须拒绝');
  ok(r1.issues.some((i) => i.code === 'PIXEL_MATRIX' && i.detail.includes('16')), '错误应指明行数');

  const badWidth = validOutput();
  badWidth.visual_style.pixel_icon_16x16[3] = '0311300000000';
  ok(!validateAlchemyOutput(badWidth).ok, '行宽 13 必须拒绝');

  const badChar = validOutput();
  badChar.visual_style.pixel_icon_16x16[5] = '0000003X13000000';
  ok(!validateAlchemyOutput(badChar).ok, '非法字符 X 必须拒绝');

  const badCat = validOutput();
  (badCat as unknown as { item_category: string }).item_category = 'WEAPON_NUCLEAR';
  ok(!validateAlchemyOutput(badCat).ok, '类别不在枚举内必须拒绝');

  const missing = validOutput() as unknown as Record<string, unknown>;
  delete missing.lore_description;
  const r5 = validateAlchemyOutput(missing);
  ok(!r5.ok, '缺字段必须拒绝');
  ok(r5.issues.some((i) => i.code === 'MISSING_FIELD'), '应给出 MISSING_FIELD');

  const extra = validOutput() as unknown as Record<string, unknown>;
  extra.attack_power = 9999;
  const r6 = validateAlchemyOutput(extra);
  ok(!r6.ok, '模型私自发 attack_power 必须拒绝(数值不容染指)');
  ok(r6.issues.some((i) => i.code === 'EXTRA_FIELD'), '应给出 EXTRA_FIELD');
});

test('F4 校验拒绝:契合度越界被钳制、名字超长、JSON 围栏可解析', () => {
  const over = validOutput();
  over.logic_synergy_score = 5.5;
  const r1 = validateAlchemyOutput(over);
  ok(r1.ok, '契合度越界不阻断,只钳制');
  /* 1.50 取自**手册** §5.3 L568:`S_logic ∈ [0.80, 1.50]`。
     不引用 `S_LOGIC_MAX` —— 该常量实现里改多少,断言就跟着变多少,等于没断言。
     (此值曾为 1.30,coop-party 按手册改为 1.50;手册才是判据来源。) */
  near(r1.value!.logic_synergy_score, 1.50, 1e-9, '应钳制到手册上限 1.50');

  const longName = validOutput();
  longName.item_name = '一'.repeat(MAX_ITEM_NAME_LEN + 1);
  ok(!validateAlchemyOutput(longName).ok, '名字超长必须拒绝');

  const fenced = '```json\n' + JSON.stringify(validOutput()) + '\n```';
  const p1 = extractJsonObject(fenced);
  ok(p1.ok, 'markdown 围栏应能被抠出来');

  const noisy = '好的,这是结果:\n' + JSON.stringify(validOutput()) + '\n希望你喜欢!';
  ok(extractJsonObject(noisy).ok, '带前后缀的响应应能被抠出来');
  ok(!extractJsonObject('完全不是 JSON').ok, '纯文本应解析失败');
});

test('F5 系统提示词是中文绘本语气,并含反刷数值约束', () => {
  ok(SYSTEM_PROMPT.length > 600, `系统提示词应足够长,实际 ${SYSTEM_PROMPT.length}`);
  ok(/绘本|童话/.test(SYSTEM_PROMPT), '应声明绘本童话语气');
  ok(SYSTEM_PROMPT.includes('炉灵'), '应给出角色设定');
  ok(/不要输出任何攻击力|不要输出任何属性数值/.test(SYSTEM_PROMPT), '必须明令禁止模型输出属性数值');
  ok(SYSTEM_PROMPT.includes('pixel_icon_16x16'), '应包含像素画说明');
  ok(SYSTEM_PROMPT.includes('"0"'), '应解释透明字符');

  const prompt = buildUserPrompt({
    materials: mats([156, 126]),
    affinity: 0.72,
    suggestedSLogic: 1.074,
  });
  ok(prompt.includes('寒铁金属锭'), '提示词应含材料名');
  ok(prompt.includes('0.720') || prompt.includes('0.72'), '应把亲和度写进提示词');
  ok(prompt.includes('不要输出任何属性数值'), '应复述数值禁令');
});

test('F6 重试策略:错误回灌、最多 2 次重试、全失败走降级', async () => {
  eq(MAX_RETRY, 2, '重试上限必须是 2(共 3 次调用)');

  const invalid = validOutput() as unknown as Record<string, unknown>;
  invalid.item_category = 'NOT_A_CATEGORY';

  /* 第一次非法,第二次合法 → 2 次调用,不算降级 */
  const llm1 = new StubLlmClient({ replies: [invalid, validOutput()] });
  const g1 = checkGate({ itemIds: [156, 126] });
  const out1 = await generateWithRetry(llm1, {
    materials: mats([156, 126]), gate: g1, lvProf: 0, useDew: false, allowDegrade: true,
  });
  eq(llm1.calls, 2, '应为 2 次调用');
  eq(out1.degraded, false, '第二轮成功后不应降级');
  eq(out1.attempts.length, 2, '应记录 2 次尝试');
  ok(out1.attempts[0].errors.length > 0, '第一次应记录校验错误');
  ok(llm1.prompts[1].includes('第 1 次重试'), '第二次提示词应标注重试轮次');
  ok(llm1.prompts[1].includes('NOT_A_CATEGORY') || llm1.prompts[1].includes('ENUM'), '错误应被回灌到提示词');

  /* 三次全非法 → 降级 */
  const llm2 = new StubLlmClient({ reply: invalid });
  const out2 = await generateWithRetry(llm2, {
    materials: mats([156, 126]), gate: g1, lvProf: 0, useDew: false, allowDegrade: true,
  });
  eq(llm2.calls, 3, '应打满 3 次调用');
  eq(out2.degraded, true, '全失败应降级');
  ok(out2.degradeReason !== undefined && out2.degradeReason.length > 0, '应给出降级原因');
  ok(out2.schema.item_name.length >= 2, '降级产物也必须有名字');

  /* 网关抛错同样进降级 */
  const llm3 = new StubLlmClient({ failWith: 'ECONNREFUSED' });
  const out3 = await generateWithRetry(llm3, {
    materials: mats([156, 126]), gate: g1, lvProf: 0, useDew: false, allowDegrade: true,
  });
  eq(llm3.calls, 3, '网关连续失败也应打满 3 次');
  eq(out3.degraded, true, '网关不可用应降级');
  ok(out3.attempts[0].errors[0].includes('ECONNREFUSED'), '应记录网关错误原文');
});

/* ══════════════════════════════════════════════════════════════
 * 七、16×16 像素立牌(5 条)
 * ══════════════════════════════════════════════════════════════ */

test('G1 像素校验器:合法通过,行数/行宽/非法字符/全透明全部拦下', () => {
  const good = validatePixelMatrix(SWORD_ART_156);
  ok(good.ok, `规范美术应通过:${good.problems.map((p) => p.detail).join(';')}`);
  eq(good.usedChars.includes('0'), true, '应使用透明色');

  const short = validatePixelMatrix(SWORD_ART_156.slice(0, 10));
  ok(!short.ok);
  ok(short.problems.some((p) => p.code === 'ROW_COUNT'));

  const narrow = [...SWORD_ART_156];
  narrow[2] = '0003113000';
  ok(validatePixelMatrix(narrow).problems.some((p) => p.code === 'ROW_WIDTH'));

  const illegal = [...SWORD_ART_156];
  illegal[4] = '000000341Z000000';
  ok(validatePixelMatrix(illegal).problems.some((p) => p.code === 'BAD_CHAR'));

  const empty = Array.from({ length: 16 }, () => '0'.repeat(16));
  const r4 = validatePixelMatrix(empty);
  ok(!r4.ok, '全透明立牌应判为废图');
  ok(r4.problems.some((p) => p.code === 'EMPTY_ART'));
  eq(MIN_INK_PIXELS, 12);

  ok(!validatePixelMatrix('not-an-array').ok, '非数组应拒绝');
});

test('G2 光栅化:1024 字节、透明像素 alpha=0、颜色取自 visual_style', () => {
  const style = { primary_color_hex: '#4d5a66', secondary_color_hex: '#9fd7c8', outline_color_hex: '#161d24' };
  const palette = paletteFrom(style);
  const raster = rasterizePixelIcon(SWORD_ART_156, palette);

  eq(raster.bytes, ICON_BYTES, '16×16×4 = 1024');
  eq(raster.data.length, 1024);
  eq(ICON_SIZE * ICON_SIZE * 4, 1024);

  const corner = pixelAt(raster.data, 0, 0);
  eq(corner.a, 0, '左上角是 0(透明)');
  eq(corner.r, 0x4d, '透明像素仍写主色 RGB,避免混合黑边');

  /* 第 0 行第 7 列是 '3' = 描边 */
  const outlinePx = pixelAt(raster.data, 7, 0);
  eq(SWORD_ART_156[0][7], '3', '校验坐标对应关系');
  eq(outlinePx.r, 0x16, '描边 R 分量');
  eq(outlinePx.g, 0x1d, '描边 G 分量');
  eq(outlinePx.a, 255, '描边不透明');

  /* 第 3 行第 7 列是 '4' = 高光(副色向白 lerp 35%) */
  eq(SWORD_ART_156[3][7], '4', '坐标应为高光');
  const hi = pixelAt(raster.data, 7, 3);
  eq(hi.r, Math.round(0x9f + (255 - 0x9f) * 0.35), '高光 R = 副色向白 lerp');
  ok(hi.r > 0x9f, '高光必须比副色更亮');
  eq(hi.a, 255, '高光不透明');

  /* 第 3 行第 6 列是 '3' = 描边 */
  eq(SWORD_ART_156[3][6], '3', '坐标应为描边');
  eq(pixelAt(raster.data, 6, 3).r, 0x16, '描边与高光必须是不同像素');
});

test('G3 矩阵 → RGBA → 矩阵 往返完全一致', () => {
  const style = { primary_color_hex: '#4d5a66', secondary_color_hex: '#9fd7c8', outline_color_hex: '#161d24' };
  const palette = paletteFrom(style);
  for (const [name, art] of Object.entries(SILHOUETTE_ART)) {
    const raster = rasterizePixelIcon(art, palette);
    const back = matrixFromRgba(raster.data, palette);
    eq(back.length, 16, `${name} 行数`);
    eq(JSON.stringify(back), JSON.stringify([...art]), `${name} 往返应逐字符一致`);
  }
});

test('G4 CanvasTexture 载荷:字段齐备、最近邻采样、纹理键可寻址', () => {
  const style = { primary_color_hex: '#4d5a66', secondary_color_hex: '#9fd7c8', outline_color_hex: '#161d24' };
  const raster = rasterizePixelIcon(SWORD_ART_156, paletteFrom(style));
  const payload = buildCanvasTexturePayload(raster, style, 'demo');

  eq(payload.kind, 'DataTexture');
  eq(payload.width, 16);
  eq(payload.height, 16);
  eq(payload.format, 'RGBAFormat');
  eq(payload.type, 'UnsignedByteType');
  eq(payload.magFilter, 'NearestFilter', '像素画必须最近邻放大');
  eq(payload.minFilter, 'NearestFilter');
  eq(payload.flipY, false, '纹理坐标不翻转,便于 UI 直接贴');
  eq(payload.needsUpdate, true);
  /* 3 取自**设计基线**(手册仅规定 16×16 像素矩阵,未规定屏幕像素比),
     不引用实现常量,避免期望值随实现漂移。 */
  eq(payload.pixelRatioHint, 3, '像素立牌屏幕像素比应为设计基线 3');
  eq(payload.data.byteLength, 1024);
  ok(payload.textureKey.startsWith('px16:'), '纹理键应带 px16 前缀');
  ok(payload.textureKey.includes('#4d5a66'), '纹理键应包含主色,保证换色即换缓存');
});

test('G5 非法矩阵自动回退到剪影规范美术,玩家永远看不到空气立牌', () => {
  const style = { primary_color_hex: '#c0392b', secondary_color_hex: '#e8b23a', outline_color_hex: '#2a1410' };
  const bad = ['0000000000000000', '短'];

  const r = buildIcon(bad, 'BOMB', style, 'fallback');
  eq(r.check.ok, false, '应报告矩阵非法');
  ok(r.check.problems.length > 0, '应给出具体问题');
  ok(r.raster.inkPixels >= MIN_INK_PIXELS, '回退后必须有足够墨点');
  eq(r.silhouette, 'BOMB');

  const good = buildIcon(canonicalArt('HAMMER'), 'HAMMER', style, 'ok');
  eq(good.check.ok, true, '规范美术应通过校验');
  ok(good.raster.inkPixels > 60, `大锤剪影应有足够墨点,实际 ${good.raster.inkPixels}`);
});

/* ══════════════════════════════════════════════════════════════
 * 八、无网络降级(4 条)
 * ══════════════════════════════════════════════════════════════ */

test('H1 降级器:标签组合拼名字 + 选剪影,输出与 LLM 同构', () => {
  const r = selfCheckDegrade();
  ok(r.ok, `降级配表自检失败:${r.errors.join(' / ')}`);

  const ms = [
    { id: 156, name: '寒铁金属锭', tags: ['金属', '坚固', '锋利'], value: 45 },
    { id: 125, name: '滑溜香蕉', tags: ['水果', '极滑', '摔跤'], value: 28 },
    { id: 116, name: '萤光魔晶簇', tags: ['魔能', '发光', '导电', '激光'], value: 50 },
  ];
  const d = degradeGenerate({ materials: ms, affinity: 0.72, suggestedSLogic: 1.074 });

  ok(d.output.item_name.length >= 2 && d.output.item_name.length <= MAX_ITEM_NAME_LEN,
    `名字长度应合法,实际「${d.output.item_name}」(${d.output.item_name.length})`);
  ok(d.output.lore_description.length >= 8, '简介不得为空');
  ok(!/\d/.test(d.output.item_name), '名字里不应出现数字');
  eq(d.output.visual_style.pixel_icon_16x16.length, 16, '降级产物必须自带 16 行立牌');
  ok(validatePixelMatrix(d.output.visual_style.pixel_icon_16x16).ok, '降级立牌必须合法');
  near(weightsSum(d.output.stat_weights), 1, 1e-9, '降级权重和必须为 1');
  near(d.output.logic_synergy_score, 1.074, 1e-9, '契合度直接取门禁建议值(确定性)');

  const v = validateAlchemyOutput(d.output);
  ok(v.ok, `降级产物必须能通过 LLM 校验器(同构性):${v.errors?.join?.(' ') ?? issueMessages(v.issues).join(' / ')}`);
});

test('H2 降级器确定性:同输入两次调用结果逐字节相同', () => {
  const ms = [
    { id: 126, name: '爆裂火椒', tags: ['蔬果', '辛辣', '爆炸', '火焰'], value: 38 },
    { id: 112, name: '黄铜矿石', tags: ['金属', '导电', '机械'], value: 25 },
  ];
  const a = degradeGenerate({ materials: ms, affinity: 0.6, suggestedSLogic: 1.0 });
  const b = degradeGenerate({ materials: ms, affinity: 0.6, suggestedSLogic: 1.0 });
  eq(JSON.stringify(a.output), JSON.stringify(b.output), '降级必须完全确定性');
});

test('H3 降级产物能跑完五步算法(Roll 不断线)', () => {
  const ms = [
    { id: 126, name: '爆裂火椒', tags: ['蔬果', '辛辣', '爆炸', '火焰'], value: 38 },
    { id: 112, name: '黄铜矿石', tags: ['金属', '导电', '机械'], value: 25 },
  ];
  const d = degradeGenerate({ materials: ms, affinity: 0.6, suggestedSLogic: 1.0 });
  const out = rollStats({
    materialIds: [112, 126],
    logicSynergyScore: d.output.logic_synergy_score,
    statWeights: d.output.stat_weights,
    lvProf: 0,
    useDew: false,
    tags: [...ms.flatMap((m) => m.tags)],
    primaryMechanic: d.output.primary_mechanic,
    seed: 4321,
  });
  ok(out.stats.budget >= 1, '预算必须 ≥1');
  ok(out.stats.rolled.atk >= 0, '攻击不得为负');
  ok(out.stats.rolled.hp >= 0, '血量不得为负');
  inRange(out.stats.rarity_tier, 0, 3, '稀有度必须落 0~3 档');
  inRange(out.stats.rolled.util, 0, UTIL_CAP_PERCENT, 'Util% 不得超过 50');
  ok(out.stats.rolled.impulse >= IMPULSE_BASE, 'F_impulse 不得低于基数 3.0');
  ok(out.stats.rolled.affixes.length >= 1, '至少 1 条词条');
});

test('H4 编排层:LLM 全失败时 forge 仍然返回可用产物(degraded=true)', async () => {
  const { svc, store } = freshStack({ failWith: 'ETIMEDOUT' });
  const r = await svc.forge({ itemIds: [112, 126], playerName: '离线玩家' });
  ok(r.ok, `降级后仍应成功,实际:${r.ok ? '' : r.message}`);
  eq(r.degraded, true, '应标记为降级产物');
  ok(r.instance.rolled.atk >= 0, '属性必须已 Roll 出');
  ok(r.icon.raster.inkPixels >= MIN_INK_PIXELS, '必须给出可用立牌');
  eq(store.size, 1, '降级产物也要入库冠名');
  ok(r.row.discoverer_name.length > 0, '必须冠名');
});

/* ══════════════════════════════════════════════════════════════
 * 九、编排端到端与边界(6 条)
 * ══════════════════════════════════════════════════════════════ */

test('I1 端到端:门禁→缓存→LLM→五步→像素,字段全部落位', async () => {
  const { svc } = freshStack({ reply: validOutput() });
  const r = await svc.forge({ itemIds: [156, 126], playerName: '测试玩家', lvProf: 5 });
  ok(r.ok, `应成功:${r.ok ? '' : r.message}`);
  eq(r.recipeHash, '126_156', '哈希应为升序拼接');
  eq(r.gate.pass, true);
  eq(r.fromCache, false);
  eq(r.degraded, false);
  eq(r.instance.recipe_hash, r.recipeHash, '实例与配方哈希一致');
  eq(r.instance.owner_id, '测试玩家');
  ok(r.instance.instance_id.length > 0, '实例 id 不得为空');
  ok(r.instance.budget >= 1, '预算已算');
  near(r.breakdown.powerMean.tEff, r.instance.t_eff, 1e-9, '实例 t_eff 与中间量一致');
  eq(r.icon.check.ok, true, '立牌通过校验');
  eq(r.icon.raster.bytes, 1024);
  ok(r.row.llm_schema_json.includes(r.schema.item_name), '入库 JSON 含产物名');
});

test('I2 门禁失败时零 Token、零入库、零副作用', async () => {
  const { llm, svc, store } = freshStack({ reply: validOutput() });
  const r = await svc.forge({ itemIds: [101, 118] }); // 无机制
  ok(!r.ok, '应失败');
  eq(r.stage, 'GATE');
  ok(r.message.includes('元素排斥'));
  eq(llm.calls, 0, '门禁失败绝不得调用 LLM(0 Token)');
  eq(store.size, 0, '门禁失败绝不得入库');
});

test('I3 同一配方不同种子:定性一致、数值不同但都在合法区间', async () => {
  const { svc } = freshStack({ reply: validOutput() });
  const a = await svc.forge({ itemIds: [156, 126], seed: 1 });
  const b = await svc.forge({ itemIds: [156, 126], seed: 2 });
  ok(a.ok && b.ok);
  eq(a.schema.item_name, b.schema.item_name, '同名(来自缓存)');
  eq(a.recipeHash, b.recipeHash, '同哈希');
  inRange(a.instance.quality_score, 0, 2.5, 'Q 应在合法区间');
  inRange(b.instance.quality_score, 0, 2.5, 'Q 应在合法区间');
  ok(a.instance.rolled.util <= UTIL_CAP_PERCENT && b.instance.rolled.util <= UTIL_CAP_PERCENT, 'Util 不超上限');
});

test('I4 同一种子两次 Roll 逐位一致(服务端权威可复现)', () => {
  const w = { atk_weight: 0.4, def_weight: 0.3, impulse_weight: 0.2, utility_weight: 0.1 };
  const base = {
    materialIds: [116, 125, 104], logicSynergyScore: 1.16, statWeights: w,
    lvProf: 10, useDew: false, tags: ['极滑', '火焰', '发光'],
    primaryMechanic: 'SLIP_HAZARD' as const, seed: 20261110,
  };
  const a = rollStats({ ...base });
  const b = rollStats({ ...base });
  eq(JSON.stringify(a.stats), JSON.stringify(b.stats), '同种子必须逐位一致');
  near(a.stats.quality_score, b.stats.quality_score, 0, 'Q 完全相等');

  const rngA = mulberry32(777);
  const rngB = mulberry32(777);
  const c = rollStats({ ...base, rng: rngA });
  const d = rollStats({ ...base, rng: rngB });
  eq(JSON.stringify(c.stats), JSON.stringify(d.stats), '注入等种子 rng 也应一致');
});

test('I5 边界:k 越界抛错、权重全 0 兜底、未知物品抛错', () => {
  let caught = 0;
  try { powerMeanBreakdown([45]); } catch { caught += 1; }
  try { powerMeanBreakdown([45, 38, 28, 20, 10]); } catch { caught += 1; }
  try { powerMeanBreakdown([45, 0]); } catch { caught += 1; }
  eq(caught, 3, 'k=1 / k=5 / V=0 都必须抛错');

  const fallbackW = saneWeights({ atk_weight: 0, def_weight: 0, impulse_weight: 0, utility_weight: 0 });
  near(weightsSum(fallbackW), 1, 1e-9, '权重全 0 应兜底成合法分布');

  let threw = false;
  try { materialValues([99999]); } catch { threw = true; }
  ok(threw, '未知物品 ID 必须抛错而不是静默为 0');
});

test('I6 词条抽取不重复且条数受稀有度约束,词条池足够大', () => {
  const rng = mulberry32(31415);
  for (let i = 0; i < 200; i += 1) {
    const n = 1 + (i % 5);
    const picked = pickAffixes(n, rng);
    eq(picked.length, Math.min(n, AFFIX_POOL.length), `应抽到 ${n} 条`);
    eq(new Set(picked).size, picked.length, '词条不得重复');
  }
  ok(AFFIX_POOL.length >= 16, `词条池应足够大,实际 ${AFFIX_POOL.length}`);
});

/* ══════════════════════════════════════════════════════════════
 * 十、缓存/持久化配套(3 条)
 * ══════════════════════════════════════════════════════════════ */

test('J1 SQLite DDL:主键、craft_count 默认、索引、露水表齐备', () => {
  const r = selfCheckCacheModule();
  ok(r.ok, `缓存模块自检失败:${r.errors.join(' / ')}`);
  const all = SQLITE_DDL.join('\n');
  ok(all.includes('CREATE TABLE IF NOT EXISTS alchemy_recipe'), '缺少配方表');
  ok(all.includes('recipe_hash     TEXT    PRIMARY KEY'), '配方表必须以 hash 为主键');
  ok(all.includes('craft_count'), '缺少 craft_count');
  ok(all.includes('idx_alchemy_created'), '缺少发现时间索引(博物架按时间倒序)');
  ok(all.includes('alchemy_dew_usage'), '缺少露水使用登记表(同配方只能用一次)');
  ok(SQL_UPSERT_RECIPE.includes('ON CONFLICT(recipe_hash)'), 'UPSERT 必须原子累加,避免读改写竞态');
});

test('J2 冠名净化:超长截断、空名兜底、危险字符剔除', () => {
  eq(sanitizeDiscoverer(''), '无名炉灵');
  eq(sanitizeDiscoverer(null), '无名炉灵');
  eq(sanitizeDiscoverer('   '), '无名炉灵');
  eq(sanitizeDiscoverer('小明'), '小明');
  eq(sanitizeDiscoverer('一二三四五六七八九十十一十二十三').length, 12, '超长应截断到 12 字');
  ok(!sanitizeDiscoverer('<script>\n小明').includes('<'), '应剔除尖括号');
  ok(!sanitizeDiscoverer('小明\n小红').includes('\n'), '应剔除换行');
});

test('J3 MemoryRecipeStore 与 MemoryDewLedger 的语义', () => {
  const store = new MemoryRecipeStore();
  const row = buildRecipeRow({
    recipe_hash: '126_156',
    discoverer_name: '小明',
    item_name: '火椒铁剑',
    item_category: 'WEAPON_MELEE' as AlchemyCategory,
    schema: { item_name: '火椒铁剑' },
    created_at: 1000,
  });
  eq(row.craft_count, 1, '新建行 craft_count 应为 1');
  store.put(row);
  eq(store.size, 1);
  eq(store.get('126_156')?.item_name, '火椒铁剑');
  store.bumpCount('126_156');
  eq(store.get('126_156')?.craft_count, 2, '累加生效');

  /* 返回的是副本,外部改写不得污染存储 */
  const copy = store.get('126_156')!;
  copy.item_name = '被篡改';
  eq(store.get('126_156')?.item_name, '火椒铁剑', 'get 必须返回副本');

  const ledger = new MemoryDewLedger();
  eq(ledger.used('126_156'), false);
  ledger.mark('126_156', '小明');
  eq(ledger.used('126_156'), true, '标记后应视为已用');

  /* fnv1a32 稳定性 */
  eq(fnv1a32('126_156'), fnv1a32('126_156'), '种子派生必须稳定');
  ok(fnv1a32('a') !== fnv1a32('b'), '不同输入应得不同种子');
});

/* ══════════════════════════════════════════════════════════════
 * 十一、跨层一致性(2 条)
 * ══════════════════════════════════════════════════════════════ */

test('K1 全 320 项物品都能被门禁与算法正确处理(不崩、不越界)', () => {
  let carrierCount = 0;
  let mechanicCount = 0;
  /* 唯一的例外:#218 工程安全帽是初始背包常驻开关,value=0,按契约不进炉 */
  const nonAlchemable = ITEM_LIST.filter((it) => it.value <= 0);
  eq(nonAlchemable.length, 1, '按契约只允许 #218 一件零价值功能件');
  eq(nonAlchemable[0].id, 218, '零价值功能件应为工程安全帽(和平盾)');

  for (const it of ITEM_LIST) {
    const c = carrierTagsOf(it.id);
    const m = mechanicTagsOf(it.id);
    if (c.length > 0) carrierCount += 1;
    if (m.length > 0) mechanicCount += 1;
    if (it.value > 0) ok(Number.isFinite(it.value), `#${it.id} ${it.name} 价值分必须有限`);
  }
  ok(carrierCount > 100, `命中载体词条的物品应足够多,实际 ${carrierCount}`);
  ok(mechanicCount > 60, `命中机制词条的物品应足够多,实际 ${mechanicCount}`);

  /* 零价值功能件必须被门禁挡下,且不消耗 Token */
  const blocked = checkGate({ itemIds: [218, 156] });
  ok(!blocked.pass, '零价值功能件不应能进炉');
  eq(blocked.code, 'NON_ALCHEMABLE');
  ok(blocked.message.includes('元素排斥'));

  /* 抽 40 组随机 2~4 件组合,全部走完门禁 + Roll,不得抛错 */
  const pool = ITEM_LIST.filter((it) => it.value > 0);
  const rng = mulberry32(2026);
  let rolled = 0;
  for (let i = 0; i < 40; i += 1) {
    const k = 2 + Math.floor(rng() * 3);
    const ids: number[] = [];
    for (let j = 0; j < k; j += 1) ids.push(pool[Math.floor(rng() * pool.length)].id);
    const g = checkGate({ itemIds: ids });
    if (!g.pass) continue;
    const out = rollStats({
      materialIds: g.materialIds,
      logicSynergyScore: g.suggested_s_logic,
      statWeights: { atk_weight: 0.4, def_weight: 0.25, impulse_weight: 0.2, utility_weight: 0.15 },
      lvProf: 3,
      useDew: false,
      tags: [...g.carrierHits, ...g.mechanicHits, ...g.resonanceTags],
      primaryMechanic: 'SLASH_WAVE',
      seed: i + 1,
    });
    inRange(out.stats.rarity_tier, 0, 3);
    inRange(out.stats.rolled.util, 0, UTIL_CAP_PERCENT);
    ok(out.stats.budget >= 1);
    rolled += 1;
  }
  ok(rolled >= 10, `随机组合应至少跑通 10 组 Roll,实际 ${rolled}`);
});

test('K2 亲和度与契合度映射单调、边界钳制正确', () => {
  const lo = affinityBreakdown(2, ['金属'], ['锋利'], [], true);
  const hi = affinityBreakdown(4, ['金属', '木材', '石材'], ['锋利', '火焰', '爆炸', '极滑'], ['金属', '锋利'], true);
  ok(hi.affinity > lo.affinity, '命中越多亲和度应越高');
  inRange(lo.affinity, 0, 1);
  inRange(hi.affinity, 0, 1);
  ok(hi.suggestedSLogic >= lo.suggestedSLogic, '契合度建议应随亲和度单调不减');
  inRange(hi.suggestedSLogic, 0.80, 1.50, '契合度建议应落在手册区间');

  const rejected = affinityBreakdown(3, ['金属'], [], [], false);
  eq(rejected.affinity, 0, '缺维度时亲和度必须为 0');
  /* 0.80 取自**手册** §5.3 L568:`S_logic ∈ [0.80, 1.50]`(与 L615 上限对称同病,一并钉死) */
  eq(rejected.suggestedSLogic, 0.80, '缺维度时契合度取手册下限 0.80');

  /* 共鸣标签:两件材料共享的词条 */
  const reso = resonanceTagsOf([156, 126, 116]);
  ok(Array.isArray(reso), '共鸣标签应为数组');
  const resoSelf = resonanceTagsOf([125, 126]);
  ok(resoSelf.length >= 0, '共鸣计算不得抛错');
});

/* ══════════════════════════════════════════════════════════════
 * L 组 —— Lead 裁决落地断言(U1 量纲钉死 / U4 类别×机制交叉矩阵)
 * ══════════════════════════════════════════════════════════════ */

test('L1【U1】F_impulse 与 THROW_SPEED_XY 同量纲但不同源:18 ≠ 8.5', () => {
  /* 构造 w_imp=1.0 / P=100 的产物:impulse = 3.0 + round(100 × 1.0 × 0.15) = 18 */
  const slice = splitBudget(100, {
    atk_weight: 0, def_weight: 0, impulse_weight: 1.0, utility_weight: 0,
  });
  near(slice.impulseRaw, 15, 1e-9, 'impulseRaw = P × w_imp × 0.15 = 15');
  eq(slice.impulse, 18, 'F_impulse = 3.0 + round(15) = 18');
  eq(IMPULSE_BASE, 3.0, 'IMPULSE_BASE 常数为 3.0');
  eq(IMPULSE_MUL, 0.15, 'IMPULSE_MUL 常数为 0.15');

  /* 关键:不能被误当成投掷速度 —— 两者数值必须相异,才可能在联调时被立刻发现 */
  ok(slice.impulse !== THROW_SPEED_XY,
    `F_impulse(${slice.impulse}) 不应等于 THROW_SPEED_XY(${THROW_SPEED_XY}),否则会被误当投掷初速`);

  /* 即使 w_imp 与 P 取极端值,也不得巧合落在投掷速度上 */
  for (const p of [20, 50, 100, 200, 400, 800]) {
    for (const w of [0.1, 0.25, 0.5, 0.75, 1.0]) {
      const s = splitBudget(p, { atk_weight: 0, def_weight: 0, impulse_weight: w, utility_weight: 0 });
      ok(Number.isFinite(s.impulse) && s.impulse >= IMPULSE_BASE,
        `F_impulse 应为有限值且 ≥ 基数:P=${p} w=${w} → ${s.impulse}`);
    }
  }
});

test('L2【U1】击退冲量是速度增量语义:并入速度后按摩擦衰减,不做投掷积分', () => {
  /*
   * 结构性断言:F_impulse 的用法等价于「vx += impulse」,随后由摩擦 μ 衰减;
   * 而投掷走的是 throwVelocity + integrateVertical 的抛物线路径。两者不可互换。
   */
  const slice = splitBudget(100, { atk_weight: 0, def_weight: 0, impulse_weight: 1.0, utility_weight: 0 });
  const fImpulse = slice.impulse;

  /* (a) 击退:一次加法进速度,再按 μ 衰减,数值不会随时间反向增长 */
  let vx = 0;
  vx += fImpulse;
  eq(vx, 18, '击退冲量并入速度:0 + 18 = 18');
  const mu = 0.75;
  vx *= mu;
  near(vx, 13.5, 1e-9, '一帧后按 μ=0.75 衰减到 13.5');
  ok(vx < fImpulse, '摩擦衰减必须使速度单调下降');

  /* (b) 投掷:走冻结层的 throwVelocity,水平初速恒为 THROW_SPEED_XY 方向分量 */
  const t = throwVelocity(1, 0, 0);
  near(Math.hypot(t.vx, t.vy), THROW_SPEED_XY, 1e-9, '投掷水平初速 = THROW_SPEED_XY');
  eq(t.vz, THROW_SPEED_Z, '投掷垂直初速 = +6.0');
  eq(t.x, 0, '投掷起点 x 由调用方给定,不由 impulse 提供');

  /* (c) 反例:若有人把 F_impulse 当投掷速度用,水平初速会变成 18 ≠ 8.5 —— 断言二者相异 */
  ok(Math.abs(fImpulse - THROW_SPEED_XY) > 1e-9,
    'F_impulse 与 THROW_SPEED_XY 数值必须可区分,防止误用后静默通过');
});

test('L3【U1】结构性约束:impulse 只进击退入口,绝不进 throwVelocity 入参', () => {
  /*
   * 这是「最重要的一条」(Lead 裁决原文)。
   * 由于 TS 无运行时类型,这里用「签名元数 + 参数语义」双重断言把契约钉死:
   *   - throwVelocity 的签名只接受方向向量与 z0/speedMul,没有任何 impulse 形参;
   *   - RolledStats 的 impulse 字段名不得出现在 throwVelocity 的参数列表里。
   */
  eq(throwVelocity.length, 3, 'throwVelocity(dirX, dirY, z0[, speedMul]) 基元数 = 3');
  ok(!/impulse/i.test(throwVelocity.toString()),
    'throwVelocity 实现体不得引用 impulse —— 否则击退冲量混进了投掷积分');

  /* 击退入口走的是「速度增量」路径:resolveCircleBounce 只做反射,不含 impulse 参数。
     restitution 有默认值,故 .length 为 4(声明 5 参、末位可选)。 */
  eq(resolveCircleBounce.length, 4, 'resolveCircleBounce(vx, vy, nx, ny[, restitution]) 元数 = 4');
  const bounced = resolveCircleBounce(18, 0, -1, 0, 1.0);
  near(bounced.x, -18, 1e-9, '撞墙反射:入射 18 出射 −18');
  near(bounced.y, 0, 1e-9, '切向分量不变');

  /* 语义固化:两者单位同、来源异,故不存在任何自动换算通道 */
  const slice = splitBudget(100, { atk_weight: 0, def_weight: 0, impulse_weight: 1.0, utility_weight: 0 });
  ok(slice.impulse !== Math.round(THROW_SPEED_XY),
    '击退冲量与投掷初速取整后仍应相异,确保不存在「看起来能换算」的假通道');
});

test('L4【U4】类别×机制交叉矩阵:每个类别的越界机制都被确定性纠正', () => {
  const categories: AlchemyCategory[] = [
    'WEAPON_MELEE', 'WEAPON_RANGED', 'WEAPON_STAFF',
    'PRANK_TOY', 'CONSUMABLE', 'WEARABLE_HAT', 'TRAP_GADGET',
  ];

  /* 每个类别都被显式登记,不存在漏项导致「谁都允许」 */
  eq(Object.keys(CATEGORY_MECHANIC_ALLOWED).length, categories.length,
    '交叉矩阵必须为 7 个类别各登记一行');
  for (const c of categories) {
    ok(Array.isArray(CATEGORY_MECHANIC_ALLOWED[c]) && CATEGORY_MECHANIC_ALLOWED[c].length > 0,
      `${c} 必须有非空白名单`);
    /* includes() 在缺失时自行抛错,不要再套 ok() */
    includes(CATEGORY_MECHANIC_ALLOWED[c], defaultMechanicFor(c),
      `${c} 的默认机制必须落在自己的白名单内`);
  }

  /* Lead 点名的三条禁令 */
  eq(isMechanicAllowed('WEARABLE_HAT', 'SLASH_WAVE'), false, '帽子不允许斩击波');
  eq(isMechanicAllowed('TRAP_GADGET', 'HEAL_AURA'), false, '陷阱装置不允许治疗光环');
  eq(isMechanicAllowed('WEAPON_MELEE', 'MORPH_ANIMAL'), false, '近战武器不允许变形动物');

  /* 合法组合必须原样放行,不得过度纠正 */
  eq(isMechanicAllowed('WEAPON_MELEE', 'SLASH_WAVE'), true, '阔剑 + 斩击波合法');
  eq(isMechanicAllowed('PRANK_TOY', 'SLIP_HAZARD'), true, '整蛊玩具 + 打滑合法');
  eq(isMechanicAllowed('TRAP_GADGET', 'ROCKET_FART'), true, '陷阱 + 火箭屁合法');

  /* 穷举 7×10 全矩阵:越界必被纠正、合法必不纠正 */
  const allMechanics = ['SLASH_WAVE', 'SLIP_HAZARD', 'BOUNCE_IMPULSE', 'BUBBLE_TRAP',
    'FREEZE_SLIDE', 'CHAIN_LIGHTNING', 'MORPH_ANIMAL', 'HEAL_AURA', 'GRAVITY_PULL', 'ROCKET_FART'];
  let correctedCount = 0;
  let passedCount = 0;
  for (const c of categories) {
    for (const m of allMechanics) {
      const allowed = isMechanicAllowed(c, m);
      const fix = correctMechanic(c, m);
      if (allowed) {
        eq(fix, null, `合法组合 ${c}+${m} 不得被纠正`);
        passedCount += 1;
      } else {
        ok(fix !== null, `越界组合 ${c}+${m} 必须被纠正`);
        eq(fix!.from, m, '纠正记录应保留原机制');
        eq(isMechanicAllowed(c, fix!.to), true, `纠正目标 ${fix!.to} 必须落在白名单内`);
        correctedCount += 1;
      }
    }
  }
  eq(passedCount + correctedCount, categories.length * allMechanics.length,
    '全矩阵 7×10 = 70 组合必须全部被裁定');
  ok(correctedCount > 0, '矩阵中确实存在越界组合(否则矩阵形同虚设)');
});

test('L5【U4】越界即纠正:不消耗重试配额,corrected 遥测为真', () => {
  /* 构造 aaaa:帽子 + 斩击波(越界)→ 应被纠正而非触发重试 */
  const out = validOutput();
  out.item_category = 'WEARABLE_HAT';
  out.primary_mechanic = 'SLASH_WAVE';

  const res = validateAlchemyOutput(out);
  eq(res.ok, true, '越界机制属「可修复」,不得判定为硬失败');
  eq(res.corrected, true, 'corrected 遥测必须为真');
  eq(res.corrections.length, 1, '恰好记录一条纠正');
  eq(res.corrections[0].category, 'WEARABLE_HAT', '记录类别');
  eq(res.corrections[0].from, 'SLASH_WAVE', '记录原机制');
  eq(res.value!.primary_mechanic, defaultMechanicFor('WEARABLE_HAT'), '落盘为类别默认机制');
  ok(isMechanicAllowed('WEARABLE_HAT', res.value!.primary_mechanic), '纠正结果必须合法');

  /* 纠正走的是 CORRECTED 记录,不是 BLOCKING —— 因此上层不会重试 */
  const blocking = res.issues.filter((i) => i.code !== 'CORRECTED');
  eq(blocking.length, 0, '纠正不得产生任何阻塞性 issue(否则会白烧一次重试)');

  /* 合法输入不得被标 corrected */
  const clean = validateAlchemyOutput(validOutput());
  eq(clean.corrected, false, '合法输入 corrected 必须为假');
  eq(clean.corrections.length, 0, '合法输入不得产生纠正记录');

  /* 对照:真正的结构性问题仍必须消耗重试(corrected 为假、ok 为假) */
  const badPixel = validOutput();
  badPixel.visual_style.pixel_icon_16x16 = badPixel.visual_style.pixel_icon_16x16.slice(0, 15);
  const bp = validateAlchemyOutput(badPixel);
  eq(bp.ok, false, '像素行数不足属结构性硬失败,必须走重试');
  eq(bp.corrected, false, '结构性失败不产生纠正记录');
  ok(bp.issues.length > 0, '必须给出可回灌的错误说明');

  const badEnum = validOutput();
  (badEnum as { item_category: string }).item_category = 'NOT_A_CATEGORY';
  eq(validateAlchemyOutput(badEnum).ok, false, '非法枚举属结构性硬失败');

  const badName = validOutput();
  badName.item_name = '';
  eq(validateAlchemyOutput(badName).ok, false, '空名字属结构性硬失败');

  /* 权重和 ≠ 1 属「可自动修复」而非硬失败:归一化后放行,0 Token 重试。
     这比 Lead 裁决中「权重和≠1 消耗重试」的底线更优 —— 省一次往返,且结果确定。 */
  const driftWeights = validOutput();
  driftWeights.stat_weights = { atk_weight: 0.5, def_weight: 0.5, impulse_weight: 0.5, utility_weight: 0.5 };
  const dw = validateAlchemyOutput(driftWeights);
  eq(dw.ok, true, '权重和 ≠ 1 应自动归一化放行,而非判定硬失败');
  eq(dw.corrected, false, '归一化属 CLAMPED/NORMALIZED 类修复,不计入 corrected');
  near(weightsSum(dw.value!.stat_weights), 1, 1e-9, '归一化后四项之和必须为 1');
  eq(dw.issues.filter((i) => i.code === 'NORMALIZED').length, 1, '恰好记一条 NORMALIZED 说明');
  eq(dw.issues.filter((i) => i.code !== 'CLAMPED' && i.code !== 'NORMALIZED').length, 0,
    '归一化不得产生阻塞性 issue(否则会白烧一次重试)');

  /* 四项全 0 无法归一化 —— 这才是硬失败 */
  const allZero = validOutput();
  allZero.stat_weights = { atk_weight: 0, def_weight: 0, impulse_weight: 0, utility_weight: 0 };
  const az = validateAlchemyOutput(allZero);
  eq(az.ok, false, '四项全 0 属结构性硬失败');
});

test('L6【U4】降级与 few-shot 也必须满足交叉矩阵(离线路径不得产出非法组合)', () => {
  /* few-shot 三例 */
  for (const fs of FEW_SHOTS) {
    eq(isMechanicAllowed(fs.output.item_category, fs.output.primary_mechanic), true,
      `few-shot「${fs.output.item_name}」的 ${fs.output.item_category} + ${fs.output.primary_mechanic} 必须合法`);
  }

  /* 降级器:对每个剪影规则都构造一次,断言类别×机制合法 */
  const silhouettes = ['SWORD', 'HAMMER', 'BOW', 'WAND', 'POTION', 'BOMB', 'HAT', 'SHIELD', 'GIZMO'];
  const gate = checkGate({ itemIds: [156, 125, 116] });
  let seen = 0;
  for (const sil of silhouettes) {
    const g = degradeGenerate({
      materials: mats([156, 125, 116]),
      affinity: gate.affinity,
      suggestedSLogic: gate.suggestedSLogic,
      silhouette: sil,
    });
    eq(isMechanicAllowed(g.output.item_category, g.output.primary_mechanic), true,
      `降级产物 ${sil}(${g.output.item_category} + ${g.output.primary_mechanic}) 必须合法`);
    const v = validateAlchemyOutput(g.output);
    eq(v.ok, true, `降级产物 ${sil} 必须能通过完整校验器`);
    near(weightsSum(v.value!.stat_weights), 1, 1e-9, `${sil} 降级权重归一化后应为 1`);
    seen += 1;
  }
  eq(seen, silhouettes.length, '9 套剪影全部被检查');

  /* 缺省入参守卫:不传 affinity / suggestedSLogic 时必须给出可用产物,而不是 NaN 权重。
     这是端到端路径上真实会踩的坑 —— 门禁被 NON_ALCHEMABLE/元素排斥拦下时,
     上层仍可能兜底调降级器,此时它拿不到亲和度。 */
  const bare = degradeGenerate({
    materials: mats([156, 125, 116]),
    silhouette: 'SWORD',
  } as never);
  const bv = validateAlchemyOutput(bare.output);
  eq(bv.ok, true, '缺省入参的降级产物仍必须通过校验器(不得产出 NaN 权重)');
  near(weightsSum(bv.value!.stat_weights), 1, 1e-9, '缺省入参时权重仍须归一');
  ok(Number.isFinite(bv.value!.logic_synergy_score), '缺省入参时契合度必须为有限数');
  inRange(bv.value!.logic_synergy_score, 0.80, 1.50, '缺省契合度落在手册合法区间');
});

/* ───────────────────────── 汇总 ───────────────────────── */

/* ══════════ CR-17:「任意染料」配方留白(附加式,冻结字段不改)══════════

 * 手册有 **3 条**配方写「任意染料」,代码把留白**硬编成了 166**:
 *   L178 `237 七彩颜料水球`   = `陶瓷空药水瓶×1 + 任意染料×1`
 *   L186 `245 手持庆典烟花筒` = `翠玉青竹×1 + 爆裂火椒×1 + 染料×1`
 *   L242 `356 哥特彩绘花窗墙` = `全透琉璃板×1 + 任意染料×2`   ← 任务书未列,本次新增发现
 * ⚠️ 第三条不是我顺手加的:它是同一条手册规则的**同一实例**,漏了它就等于
 *    只修一半 —— 玩家拿 167 仍做不出 356。
 *
 * ⚠️ `recipe` **未被** `contentFingerprints()` 哈希(items 分区只哈希
 *    `{id,name,category,tags,value}`)⇒ 改 recipe 不动指纹。
 *    但仍**不删**既有 `recipe` 键(那会让 WS-FND-06 的 237/245 用例与
 *    verify.ts 的引用闭合红)—— 留白以**新增可选字段**并存。
 */

test('G-DYE-1 CR-17 三条「任意染料」配方必须声明留白槽,且不删既有具体键', () => {
  const CASES: [number, string, number, number][] = [
    [237, '七彩颜料水球', 166, 178],
    [245, '手持庆典烟花筒', 166, 186],
    [356, '哥特彩绘花窗墙', 166, 242],
  ];
  for (const [id, name, concrete, line] of CASES) {
    const def = ITEM_BY_ID.get(id);
    ok(def !== undefined, `#${id} ${name} 应存在`);
    /* 负半:既有具体键必须还在(否则 WS-FND-06 的对照会红) */
    ok(def!.recipe !== undefined, `#${id} 既有 recipe 不得被删`);
    ok((def!.recipe ?? {})[concrete] !== undefined,
      `#${id} 既有 recipe 仍须含具体染料 #${concrete}(手册 L${line} 是「任意」,但删键会撞红写域外用例)`);
    /* 正半:留白槽必须被声明 */
    const anyTag = def!.recipeAnyTag ?? [];
    ok(anyTag.length > 0, `#${id} 应声明 recipeAnyTag(手册 L${line}「任意染料」),实际 ${JSON.stringify(anyTag)}`);
    ok(anyTag.some((g) => g.includes('染料')),
      `#${id} 的留白槽应包含「染料」tag,实际 ${JSON.stringify(anyTag)}`);

    /* ⚠️ 关键不变量(易漏):**槽数必须等于「登记代表」在 recipe 里的数量**。
       匹配时代表键被跳过、由槽接管 ⇒ 若代表写着 ×2 而只放 1 个槽,
       整条配方就会少要 1 个染料(356 会退化成「任意染料×1」),而 G-DYE-2 的
       「只给 1 个应拒绝」恰好能抓住这一点 —— 但那是间接的,这里直接钉住数量关系。 */
    const repQty = Object.entries(def!.recipe ?? {})
      .filter(([k]) => anyTag.some((slot) => satisfiesAnyTagSlot(Number(k), slot)))
      .reduce((s, [, v]) => s + v, 0);
    ok(repQty > 0, `#${id} 应有一个「登记代表」写在 recipe 里(实际 ${repQty})`);
    eq(anyTag.length, repQty,
      `#${id} 槽数(${anyTag.length})必须等于登记代表的 recipe 数量(${repQty})`);
  }
});

test('G-DYE-2 CR-17 四色染料必须全部可满足留白槽(166/167/168/169)', () => {
  /* 这是本 CR 的**目的**:167/168/169 此前完全无法用于这三条配方。
     每条配方的「固有材料」也要给全 —— 只给染料是不够的(否则测的是半条配方)。 */
  const dyes = itemsMod.ITEM_LIST.filter((i) => i.tags.includes('染料'));
  eq(dyes.map((i) => i.id).sort((a, b) => a - b), [166, 167, 168, 169],
    '带「染料」tag 的必须是且仅是 166/167/168/169');

  /* 产物 → (固有材料, 每个槽需要的染料数) */
  const RECIPES: [number, Record<number, number>, number][] = [
    [237, { 165: 1 }, 1],              /* 陶瓷空药水瓶×1 + 任意染料×1 */
    [245, { 103: 1, 126: 1 }, 1],      /* 翠玉青竹×1 + 爆裂火椒×1 + 染料×1 */
    [356, { 154: 1 }, 2],              /* 全透琉璃板×1 + 任意染料×2 */
  ];

  let checked = 0;
  for (const dyeId of [166, 167, 168, 169]) {
    for (const [craftId, fixed, needQty] of RECIPES) {
      const r = itemsMod.matchRecipeByTags(craftId, { ...fixed, [dyeId]: needQty });
      eq(r.ok, true, `#${craftId} 应可用染料 #${dyeId}×${needQty} 合成(实际 ${r.reason ?? ''})`);
      checked += 1;
    }
  }
  eq(checked, 12, '4 色 × 3 配方 = 12 组组合全部检查过(防止循环写空)');

  /* 负对照 1:数量不足必须拒绝 —— 证明不是「只要有这个 ID 就算过」。
     356 要 2 个染料;只给 1 个时,**固有件给全**也必须拒绝。 */
  const short = itemsMod.matchRecipeByTags(356, { 154: 1, 167: 1 });
  eq(short.ok, false, '356 需要染料×2,只给 1 个应拒绝');
  eq(itemsMod.matchRecipeByTags(356, { 154: 1, 167: 2 }).ok, true, '给足 2 个应通过');
  eq(itemsMod.matchRecipeByTags(237, { 165: 1, 167: 2 }).ok, true, '给多于所需数量应仍可合成(多余不拦)');

  /* 负对照 2:固有材料不得被留白放宽 —— 只给染料、不给药水瓶必须拒绝 */
  eq(itemsMod.matchRecipeByTags(237, { 167: 1 }).ok, false,
    '237 还缺 165 陶瓷空药水瓶,只给染料应拒绝');

  /* 负对照 3:非染料物不得冒充 —— 209 带「颜料」tag 但不是「染料」 */
  ok(ITEM_BY_ID.get(209)!.tags.includes('颜料'), '前置条件:209 带「颜料」tag');
  eq(ITEM_BY_ID.get(209)!.tags.includes('染料'), false, '前置条件:209 **不带**「染料」tag');
  const fake = itemsMod.matchRecipeByTags(237, { 165: 1, 209: 1 });
  eq(fake.ok, false, '209 是染色枪,不能当「任意染料」用');
  ok((fake.reason ?? '').includes('染料'), `拒绝理由应指向染料槽,实际:${fake.reason ?? ''}`);
});

test('G-DYE-3 CR-17 留白槽不得放宽固有材料:翡翠森林染料仍是 244 的专指件', () => {
  /* 244 手册 L185 写的是 `高弹果冻胶×3 + 翡翠森林染料×1` —— 指名道姓,不是「任意」。
     这一条防的是「把 recipeAnyTag 当成万能后门,顺手给所有配方都开留白」。 */
  const d244 = ITEM_BY_ID.get(244)!;
  eq(d244.recipe, { 162: 3, 168: 1 }, '244 配方必须逐位不变(手册指明 168)');
  eq(d244.recipeAnyTag ?? [], [], '244 不得声明留白槽(手册未写「任意」)');

  /* 负对照:换成另一种染料应当不被接受 */
  eq(itemsMod.matchRecipeByTags(244, { 162: 3, 167: 1 }).ok, false,
    '244 指名 168,换成 167 应拒绝');
  eq(itemsMod.matchRecipeByTags(244, { 162: 3, 168: 1 }).ok, true, '244 用 168 应通过');

  /* 负对照的负对照:只有 3 条配方有留白槽 —— 若谁批量开洞,这条会红 */
  const withSlots = itemsMod.ITEM_LIST.filter((i) => (i.recipeAnyTag ?? []).length > 0);
  eq(withSlots.map((i) => i.id).sort((a, b) => a - b), [237, 245, 356],
    '声明留白槽的必须**恰好**是手册写「任意染料」的那 3 条');
});

report('WS-06');