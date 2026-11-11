/**
 * WS-06 万物奇想炼金炉 —— 子系统门面。
 *
 * 对外只暴露一个 `forgeAlchemy()` 与一个工厂 `createAlchemyService()`,
 * 内部把六条链路串成一条**同一事务语义**的流水线:
 *
 *   ① gate.checkGate      → 门禁;不过门直接返回「元素排斥」,0 Token
 *   ② cache.RecipeCache   → 命中 → 0 Token 直接出结果;未命中 → 单飞锁
 *   ③ prompt + LlmClient  → 严格 JSON Schema + 校验 + 最多 2 次错误回灌重试
 *   ④ degrade.degradeGenerate → 前三步全失败时的确定性回退(玩法不断线)
 *   ⑤ attributes.rollStats    → 五步属性算法 + 化学反应突变(纯确定性)
 *   ⑥ pixel_icon.buildIcon    → 16×16 RGBA 立牌,可直接喂 CanvasTexture
 *
 * 关键不变量(测试逐条覆盖):
 *   · LLM 永远拿不到数值填写权 —— rolled 的每个数字都由 ⑤ 算出;
 *   · 同一 recipe_hash 全服只生成一次,首发现者冠名,craft_count 累加;
 *   · 同一 hash 并发 N 次 → LLM 只被调 1 次,N 个调用方拿到同一份 schema;
 *   · 门禁失败绝不落库、绝不调 LLM。
 */

import {
  ALCHEMY_MAX_INPUTS,
  ALCHEMY_MIN_INPUTS,
  DEW_ITEM_ID,
  recipeHash,
  type AlchemyRecipeRow,
  type ItemInstanceStats,
  type LLMAlchemyOutputSchema,
  type StatWeights,
} from '../../../shared/types/alchemy.ts';
import { ITEM_BY_ID, itemName, itemTags, itemValue } from '../../../shared/constants/items.ts';
import { checkGate, collectTags, type GateResult } from './gate.ts';
import {
  RecipeCache,
  buildRecipeRow,
  MemoryDewLedger,
  type LlmClient,
  type RecipeStore,
  type CacheStats,
} from './cache.ts';
import {
  ALCHEMY_JSON_SCHEMA,
  MAX_RETRY,
  buildUserPrompt,
  extractJsonObject,
  issueMessages,
  validateAlchemyOutput,
  type PromptMaterial,
} from './prompt.ts';
import { degradeGenerate } from './degrade.ts';
import { rollStats, seededRng, type RollOutcome } from './attributes.ts';
import { buildIcon, normalizeHexColor, type IconBuildResult } from './pixel_icon.ts';

/* ══════════════════════════════════════════════════════════════
 * 1. 请求 / 响应结构
 * ══════════════════════════════════════════════════════════════ */

export interface ForgeRequest {
  /** 投入 2~4 件材料(可含露水) */
  itemIds: readonly number[];
  /** 合成玩家名(用于冠名首发现者) */
  playerName?: string;
  /** 炼金专精等级 */
  lvProf?: number;
  /** 是否使用梦境露水 */
  useDew?: boolean;
  /** 随机种子;缺省时由 recipe_hash 派生(保证服务端权威可复现) */
  seed?: number;
  /** 注入随机源(测试用),优先级高于 seed */
  rng?: () => number;
  /** 禁止降级(测试 LLM 全失败路径用) */
  allowDegrade?: boolean;
}

export interface ForgeSuccess {
  ok: true;
  /** 配方哈希 */
  recipeHash: string;
  /** 是否命中缓存(命中即 0 Token) */
  fromCache: boolean;
  /** 是否走的是本地降级生成器 */
  degraded: boolean;
  /** 门禁结果 */
  gate: GateResult;
  /** LLM / 降级器给出的定性输出 */
  schema: LLMAlchemyOutputSchema;
  /** 入库行 */
  row: AlchemyRecipeRow;
  /** 实例属性(含五步算法全部中间量) */
  instance: ItemInstanceStats;
  /** 五步算法的中间量,便于复核与调试面板 */
  breakdown: RollOutcome['breakdown'];
  /** 化学反应突变(未触发为 null) */
  reaction: { id: string; name: string; lore: string } | null;
  /** 像素立牌 */
  icon: IconBuildResult;
  /** 本次消耗的 Token 次数(0 表示纯缓存命中) */
  llmTokensUsed: number;
}

export interface ForgeFailure {
  ok: false;
  /** 失败阶段 */
  stage: 'GATE' | 'LLM' | 'ROLL';
  gate: GateResult;
  message: string;
  /** LLM 阶段的校验错误 */
  errors?: string[];
}

export type ForgeResult = ForgeSuccess | ForgeFailure;

export interface AlchemyServiceOptions {
  store: RecipeStore;
  llm: LlmClient;
  /** 露水使用登记;缺省内存实现 */
  dewLedger?: MemoryDewLedger;
  /** 是否允许降级(默认 true;生产恒为 true 保证不断线) */
  allowDegrade?: boolean;
  /** 实例 id 生成器;缺省用 hash + 序号 */
  instanceIdFactory?: (hash: string, seq: number) => string;
}

/* ══════════════════════════════════════════════════════════════
 * 2. 工具
 * ══════════════════════════════════════════════════════════════ */

/** FNV-1a 32 位:把字符串稳定映射成种子 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function promptMaterialsOf(itemIds: readonly number[]): PromptMaterial[] {
  return itemIds.map((id) => ({
    id,
    name: itemName(id),
    tags: itemTags(id),
    value: itemValue(id),
  }));
}

/** 产物的对外标签(与材料标签合并后用于化学反应判定) */
export function productTags(schema: LLMAlchemyOutputSchema): string[] {
  const out = new Set<string>();
  out.add(schema.item_category);
  out.add(schema.primary_mechanic);
  out.add(schema.secondary_element);
  out.add(schema.visual_style.base_silhouette);
  return [...out];
}

/* ══════════════════════════════════════════════════════════════
 * 3. LLM 生成 + 校验 + 重试
 * ══════════════════════════════════════════════════════════════ */

export interface GenerateAttempt {
  attempt: number;
  ok: boolean;
  errors: string[];
  raw?: string;
}

export interface GenerateOutcome {
  schema: LLMAlchemyOutputSchema;
  degraded: boolean;
  attempts: GenerateAttempt[];
  tokensUsed: number;
  /** 降级原因 */
  degradeReason?: string;
}

export interface GenerateInput {
  materials: readonly PromptMaterial[];
  gate: GateResult;
  lvProf: number;
  useDew: boolean;
  allowDegrade: boolean;
}

/**
 * 走一次「提示词 → LLM → 解析 → 校验」的重试循环(最多 MAX_RETRY 次重试 = 3 次调用),
 * 全失败则回退到 degradeGenerate。**永不抛错**(除非 allowDegrade 为 false)。
 */
export async function generateWithRetry(
  llm: LlmClient,
  input: GenerateInput,
): Promise<GenerateOutcome> {
  const attempts: GenerateAttempt[] = [];
  let previousErrors: string[] | undefined;
  let previousRaw: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
    const prompt = buildUserPrompt({
      materials: input.materials,
      affinity: input.gate.affinity,
      suggestedSLogic: input.gate.suggested_s_logic,
      lvProf: input.lvProf,
      useDew: input.useDew,
      attempt,
      previousErrors,
      previousRaw,
    });

    let raw: unknown;
    try {
      raw = await llm.generateJson(prompt, ALCHEMY_JSON_SCHEMA);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ attempt, ok: false, errors: [`[LLM_CALL] 网关调用失败:${msg}`] });
      if (attempt >= MAX_RETRY) break;
      previousErrors = [`最后一轮呼叫炉灵失败了(${msg}),请重新输出完整 JSON。`];
      continue;
    }

    const asText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = extractJsonObject(asText);
    if (!parsed.ok) {
      attempts.push({ attempt, ok: false, errors: [`[PARSE] ${parsed.error}`], raw: asText });
      previousErrors = [`[PARSE] ${parsed.error}`];
      previousRaw = asText;
      continue;
    }

    const validated = validateAlchemyOutput(parsed.value);
    if (!validated.ok) {
      const msgs = issueMessages(validated.issues, 6);
      attempts.push({ attempt, ok: false, errors: msgs, raw: asText });
      previousErrors = msgs;
      previousRaw = asText;
      continue;
    }

    attempts.push({ attempt, ok: true, errors: [], raw: asText });
    return { schema: validated.value!, degraded: false, attempts, tokensUsed: attempt + 1 };
  }

  if (!input.allowDegrade) {
    const last = attempts[attempts.length - 1];
    throw new Error(`LLM 连续 ${MAX_RETRY + 1} 轮校验失败:${(last?.errors ?? []).join(' / ')}`);
  }
  const fb = degradeGenerate({
    materials: input.materials,
    affinity: input.gate.affinity,
    suggestedSLogic: input.gate.suggested_s_logic,
    reason: `LLM 连续 ${MAX_RETRY + 1} 轮未通过校验/调用失败,已启用本地确定性回退`,
  });
  return {
    schema: fb.output,
    degraded: true,
    attempts,
    tokensUsed: attempts.length,
    degradeReason: fb.reason,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 4. 服务工厂
 * ══════════════════════════════════════════════════════════════ */

export interface AlchemyService {
  forge(req: ForgeRequest): Promise<ForgeResult>;
  /** 只做门禁预判,不产生任何副作用(客户端预校验用) */
  preview(itemIds: readonly number[], useDew?: boolean): GateResult;
  stats(): CacheStats;
  /** 缓存里已登记的配方数 */
  recipeCount(): number;
}

export function createAlchemyService(opts: AlchemyServiceOptions): AlchemyService {
  const cache = new RecipeCache({ store: opts.store, llm: opts.llm });
  const dewLedger = opts.dewLedger ?? new MemoryDewLedger();
  const defaultAllowDegrade = opts.allowDegrade ?? true;
  let instanceSeq = 0;

  const preview = (itemIds: readonly number[], useDew = false): GateResult => {
    const h = itemIds.length > 0 ? safeHash(itemIds) : '';
    return checkGate({
      itemIds,
      offerDew: useDew,
      hasDewInBag: useDew,
      dewAlreadyUsed: h ? dewLedger.used(h) : false,
    });
  };

  const forge = async (req: ForgeRequest): Promise<ForgeResult> => {
    /* ① 门禁 */
    const gate = checkGate({
      itemIds: req.itemIds,
      offerDew: req.useDew === true,
      hasDewInBag: req.useDew === true,
      dewAlreadyUsed: false,
    });
    if (!gate.pass) return { ok: false, stage: 'GATE', gate, message: gate.message };

    const materialIds = gate.materialIds;
    const hash = recipeHash(materialIds);
    if (gate.dewRelease) dewLedger.mark(hash, req.playerName ?? '无名炉灵');

    const materials = promptMaterialsOf(materialIds);
    const lvProf = Math.max(0, Math.min(30, Math.trunc(req.lvProf ?? 0)));
    const tags = collectTags(materialIds);
    const seed = req.seed ?? fnv1a32(hash);
    const allowDegrade = req.allowDegrade ?? defaultAllowDegrade;

    let tokensUsed = 0;
    let degraded = false;
    let errors: string[] = [];

    let entry;
    try {
      entry = await cache.resolve(hash, async () => {
        const gen = await generateWithRetry(opts.llm, { materials, gate, lvProf, useDew: gate.usesDew, allowDegrade });
        tokensUsed = gen.tokensUsed;
        degraded = gen.degraded;
        errors = gen.attempts.flatMap((a) => a.errors);
        const row = buildRecipeRow({
          recipe_hash: hash,
          discoverer_name: req.playerName ?? '无名炉灵',
          item_name: gen.schema.item_name,
          item_category: gen.schema.item_category,
          schema: gen.schema,
        });
        return { row, schema: gen.schema, degraded: gen.degraded };
      });
    } catch (err) {
      return {
        ok: false,
        stage: 'LLM',
        gate,
        message: err instanceof Error ? err.message : String(err),
        errors,
      };
    }

    const schema = entry.schema as LLMAlchemyOutputSchema;
    if (!schema || typeof schema !== 'object') {
      return { ok: false, stage: 'ROLL', gate, message: '配方缓存中的 schema 无法解析', errors };
    }
    if (entry.fromCache) degraded = entry.degraded;

    /* ⑤ 五步属性算法 */
    let outcome: RollOutcome;
    try {
      const effectiveSLogic = gate.code === 'PASS_WITH_DEW'
        ? schema.logic_synergy_score * (gate.dewRelease?.qualityPenalty ?? 1)
        : schema.logic_synergy_score;
      outcome = rollStats({
        materialIds,
        logicSynergyScore: effectiveSLogic,
        statWeights: saneWeights(schema.stat_weights),
        lvProf,
        useDew: gate.usesDew,
        tags: [...tags, ...productTags(schema)],
        primaryMechanic: schema.primary_mechanic,
        rng: req.rng ?? seededRng(seed),
      });
    } catch (err) {
      return { ok: false, stage: 'ROLL', gate, message: err instanceof Error ? err.message : String(err), errors };
    }

    /* 突变覆盖外观 */
    const style = {
      ...schema.visual_style,
      ...(outcome.auraOverride ? { particle_aura: outcome.auraOverride as LLMAlchemyOutputSchema['visual_style']['particle_aura'] } : {}),
    };

    /* ⑥ 像素立牌 */
    instanceSeq += 1;
    const icon = buildIcon(style.pixel_icon_16x16, style.base_silhouette, style, hash);

    const instanceId = opts.instanceIdFactory
      ? opts.instanceIdFactory(hash, instanceSeq)
      : `alc-${hash}-${String(instanceSeq).padStart(4, '0')}`;

    const instance: ItemInstanceStats = {
      instance_id: instanceId,
      recipe_hash: hash,
      owner_id: req.playerName ?? 'local-player',
      rarity_tier: outcome.stats.rarity_tier,
      quality_score: outcome.stats.quality_score,
      t_eff: outcome.stats.t_eff,
      budget: outcome.stats.budget,
      rolled: outcome.stats.rolled,
      discoverer_name: entry.row.discoverer_name,
    };

    const reaction = outcome.breakdown.reaction
      ? {
        id: outcome.breakdown.reaction.rule.id,
        name: outcome.breakdown.reaction.rule.name,
        lore: outcome.breakdown.reaction.rule.lore,
      }
      : null;

    return {
      ok: true,
      recipeHash: hash,
      fromCache: entry.fromCache,
      degraded: entry.degraded || degraded,
      gate,
      schema,
      row: entry.row,
      instance,
      breakdown: outcome.breakdown,
      reaction,
      icon,
      llmTokensUsed: entry.fromCache ? 0 : tokensUsed,
    };
  };

  return {
    forge,
    preview,
    stats: () => cache.getStats(),
    recipeCount: () => {
      const s = opts.store as unknown as { size?: number };
      return typeof s.size === 'number' ? s.size : -1;
    },
  };
}

/* ══════════════════════════════════════════════════════════════
 * 5. 防御性归一
 * ══════════════════════════════════════════════════════════════ */

/** 缓存里读出的权重可能来自更早的版本/降级器,这里再夹一次保证 sum=1 */
export function saneWeights(w: StatWeights): StatWeights {
  const raw = [w?.atk_weight, w?.def_weight, w?.impulse_weight, w?.utility_weight].map((v) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { atk_weight: 0.4, def_weight: 0.2, impulse_weight: 0.2, utility_weight: 0.2 };
  return {
    atk_weight: raw[0] / sum,
    def_weight: raw[1] / sum,
    impulse_weight: raw[2] / sum,
    utility_weight: raw[3] / sum,
  };
}

function safeHash(itemIds: readonly number[]): string {
  try {
    return recipeHash(itemIds.filter((id) => id !== DEW_ITEM_ID));
  } catch {
    return '';
  }
}

/* ══════════════════════════════════════════════════════════════
 * 6. 再导出(调用方只 import 本文件即可)
 * ══════════════════════════════════════════════════════════════ */

export {
  checkGate, collectTags, carrierTagsOf, mechanicTagsOf, resonanceTagsOf, affinityBreakdown,
  gateSelfCheck, REJECT_SUBJECT, DEW_RELEASE_QUALITY_PENALTY,
  type GateRequest, type GateResult, type GateCode, type DewRelease, type AffinityBreakdown,
} from './gate.ts';

export {
  powerMeanBreakdown, effectiveValue, materialValues, sampleTruncatedNormal, qualityBreakdown,
  rarityTierOf, affixCountOf, budgetOf, splitBudget, rollStats, rollReaction, applyWeightShift,
  seededRng, weightsSum, clamp, selfCheckParams, pickAffixes,
  AGG_EXPONENT, K_BONUS_RATE, BUDGET_BASE, BUDGET_EXPONENT, ATK_MUL, DEF_MUL, HP_MUL,
  IMPULSE_BASE, IMPULSE_MUL, UTIL_MUL, UTIL_CAP_PERCENT, RARITY_THRESHOLDS,
  EPSILON_MEAN, EPSILON_SIGMA, EPSILON_MIN, EPSILON_MAX, S_LOGIC_MIN, S_LOGIC_MAX,
  REACTION_RULES, AFFIX_POOL,
  type NormalSpec, type QualityBreakdown, type PowerMeanBreakdown, type SliceBreakdown,
  type ReactionRule, type ReactionHit, type RollRequest, type RollOutcome, type RollBreakdown,
} from './attributes.ts';

export {
  ICON_SIZE, ICON_BYTES, PALETTE_CHAR, PALETTE_KEYS, PALETTE_MEANING, MIN_INK_PIXELS,
  SILHOUETTE_ART, validatePixelMatrix, describePixelProblems, rasterizePixelIcon, pixelAt,
  matrixFromRgba, paletteFrom, parseHexColor, normalizeHexColor, buildCanvasTexturePayload,
  buildIcon, canonicalArt, selfCheckArt, TEXTURE_PIXEL_RATIO,
  type Rgba, type PixelMatrixCheck, type PixelMatrixProblem, type RasterResult, type CanvasTexturePayload,
  type IconBuildResult,
} from './pixel_icon.ts';

export {
  ALCHEMY_JSON_SCHEMA, SCHEMA_INVARIANTS, SYSTEM_PROMPT, FEW_SHOTS, MAX_RETRY,
  MAX_ITEM_NAME_LEN, MIN_ITEM_NAME_LEN, MAX_LORE_LEN, MIN_LORE_LEN,
  buildUserPrompt, buildFewShotMessages, describeMaterials, validateAlchemyOutput,
  issueMessages, extractJsonObject, selfCheckFewShots,
  /* U4 交叉矩阵(Lead 裁决):类别 × 机制白名单与确定性纠正 */
  CATEGORY_MECHANIC_ALLOWED, defaultMechanicFor, isMechanicAllowed, correctMechanic,
  type MechanicCorrection,
  type PromptMaterial, type FewShot, type ValidationIssue, type ValidationResult,
  type BuildUserPromptOptions,
} from './prompt.ts';

export {
  degradeGenerate, selectSilhouetteRule, composeName, composeLore, pickColor, pickAura,
  pickElement, tagsOf, selfCheckDegrade, CARRIER_WORD, MECHANIC_WORD, SILHOUETTE_RULES,
  SILHOUETTE_WEIGHTS, SILHOUETTE_NOUN, TAG_COLOR, FALLBACK_RULE,
  type DegradeRequest, type DegradeResult, type NameParts, type SilhouetteRule, type ColorTriple,
} from './degrade.ts';

export {
  MemoryRecipeStore, StubLlmClient, RecipeCache, MemoryDewLedger, buildRecipeRow,
  sanitizeDiscoverer, emptyStats, selfCheckCacheModule, SQLITE_DDL, SQL_UPSERT_RECIPE,
  SQL_BUMP_COUNT, SQL_GET_RECIPE, SQL_TOP_GALLERY, DEFAULT_DISCOVERER,
  type LlmClient, type RecipeStore, type CacheStats, type CacheEntry, type RecipeCacheOptions,
  type StubLlmOptions, type BuildRowInput,
} from './cache.ts';

export type { AlchemyRecipeRow, ItemInstanceStats, LLMAlchemyOutputSchema, StatWeights };
