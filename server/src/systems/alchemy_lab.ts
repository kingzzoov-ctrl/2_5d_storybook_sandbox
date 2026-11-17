/**
 * WS-FND-75 / 【奇想炼金实验室】(`ALCHEMY_LAB`)的**全服首创冠名陈列** —— 纯数据结构 + 查询。
 *
 * ## 为什么有这个文件
 *
 * 手册 §3.8 与内容表的两件识别件:
 *   · `536 【AI核心】万物奇想炼金炉` —— 「自由放入任意 **2~4 件**非蓝图物品……生成全新奇物」;
 *   · `537 全服奇物发现博物架`     —— 「自动陈列本房间玩家『**全服首次合成**』的 AI 造物并展示**冠名证书**」。
 *
 * `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION.ALCHEMY_LAB` 此前写着
 * 「需 LLM 与陈列系统 ⇒ 未实装」。⇒ 本文件落地**陈列与冠名**这一半。
 *
 * ## 不联网:复用已有的确定性降级路径
 *
 * 首次合成**不用**调模型,直接走 `alchemy/degrade.ts` 的 `degradeGenerate`
 * (WS-06 的无网络降级生成器:同样的输入永远给同样的产物)。于是
 * 「全服首创」这件事在没有 LLM 的房间里也**可判定**:离线单机房、模型网关
 * 5xx、配额耗尽,冠名照记,产物照出。联网那条路(LLM 成功返回)以后接进来时,
 * 只需把 `schema` 换成模型输出,台账不动。
 *
 * ⚠️ 「同一配方全服只生成一次」是 `alchemy/cache.ts` 的既有纪律:第二次
 * 合成**不再调用生成器**,只把 `craft_count` 加一。本模块照抄这条纪律 ——
 * 于是「首创者」天然等于「第一次那条记录的名字」,不必额外去重。
 */

import { recipeHash, type LLMAlchemyOutputSchema } from '../../../shared/types/alchemy.ts';
import { DEFAULT_DISCOVERER, sanitizeDiscoverer } from '../alchemy/cache.ts';
import { degradeGenerate, type PromptMaterialLike } from '../alchemy/degrade.ts';
import { ITEM_BY_ID } from '../../../shared/constants/items.ts';

/** 本实现在 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION` 里登记的身份。 */
export const ALCHEMY_LAB_SYSTEM = Object.freeze({
  roomKey: 'ALCHEMY_LAB',
  module: 'server/src/systems/alchemy_lab.ts',
  entry: 'brewAndRecord',
});

/** 内容表 `536` 的字面量:一次可放入的材料件数区间 **[2, 4]**。 */
export const MIN_BREW_MATERIALS = 2;
export const MAX_BREW_MATERIALS = 4;

/** 陈列馆的一行(冠名证书)。 */

export interface GalleryEntry {
  /** 配方哈希(材料 ID 升序拼接)—— 全服唯一键。 */
  recipeHash: string;
  /** 冠名:首个合成者的名字(经 `sanitizeDiscoverer` 净化,空名回落「无名炉灵」)。 */
  discovererName: string;
  /** 产物名(降级生成器的产物名)。 */
  itemName: string;
  /** 产物类别(降级生成器给的 `item_category`,原样存,不做二次判断)。 */
  itemCategory: string;
  /** 全服合成次数(首次 = 1)。 */
  craftCount: number;
  /** 首次合成的时间戳(调用方喂进来的逻辑时间,本模块不读时钟)。 */
  firstAt: number;
  /** 产物 schema 的 JSON(与 `AlchemyRecipeRow.llm_schema_json` 同构)。 */
  schemaJson: string;
}

/** 陈列馆:哈希 → 那一行。对外只读;写入一律返回**新**馆。 */
export interface Gallery {
  readonly rows: ReadonlyMap<string, GalleryEntry>;
}

/** 空馆。 */
export function createGallery(): Gallery {
  return { rows: new Map<string, GalleryEntry>() };
}

/**
 * 冠名净化:直接复用 `alchemy/cache.ts` 的**同一处**规则
 * (截断 12 字、抹掉换行/尖括号/反斜杠、空名回落「无名炉灵」)。
 *
 * 为什么不自己写一遍:冠名证书上出现两种净化口径,就会出现
 * 「陈列里显示 A、缓存里存 B」—— 那种"两个实现"是本仓反复踩过的形态。
 */
export function displayNameOf(raw: unknown): string {
  return sanitizeDiscoverer(raw);
}

/** 空名回落值,原样转发 —— 判据可以对着它核「空名不是空字符串」。 */
export const GALLERY_FALLBACK_NAME = DEFAULT_DISCOVERER;

/** 材料 ID 是否在内容表里(不查内容表的一律不许进炉)。 */
export function materialsResolvable(itemIds: readonly number[]): boolean {
  if (itemIds.length === 0) return false;
  for (const id of itemIds) {
    if (!Number.isInteger(id) || id <= 0) return false;
    if (!ITEM_BY_ID.has(id)) return false;
  }
  return true;
}

/** 把内容表里的物品翻成降级生成器要的 `PromptMaterial`;未知 ID 直接过滤掉。 */
export function materialsOf(itemIds: readonly number[]): PromptMaterialLike[] {
  const out: PromptMaterialLike[] = [];
  for (const id of itemIds) {
    const def = ITEM_BY_ID.get(id);
    if (def === undefined) continue;
    out.push({ id: def.id, name: def.name, tags: def.tags, value: def.value });
  }
  return out;
}

/** 安全算哈希:非法 ID 返回 `null`(查询口不该因为脏输入抛异常)。 */
function hashOf(itemIds: readonly number[]): string | null {
  for (const id of itemIds) {
    if (!Number.isInteger(id) || id <= 0) return null;
  }
  if (itemIds.length === 0) return null;
  return recipeHash(itemIds);
}

/** 一次合成的输入。 */
export interface BrewInput {
  /** 放进去的材料 ID(2~4 件,且都必须在内容表里)。 */
  itemIds: readonly number[];
  /** 门禁亲和度 0..1 —— 只影响降级生成器的权重倾斜。 */
  affinity: number;
  /** 门禁建议的契合度初值。 */
  suggestedSLogic: number;
  /** 合成者名字(冠名用)。 */
  discovererName: string;
  /** 逻辑时间戳(调用方喂,本模块不读时钟 ⇒ 判据可复现)。 */
  at: number;
}

/** 一次合成的结果:`ok` 为假时**馆不变**(与"拒绝"语义一致)。 */
export type BrewOutcome =
  | { ok: true; gallery: Gallery; entry: GalleryEntry; first: boolean }
  | { ok: false; reason: string; gallery: Gallery };

/**
 * 合成一次并记账:
 *
 * ```
 * 材料不在内容表 / 件数不在 [2,4]  ⇒ 拒绝(馆不变)
 * 该配方哈希已在馆里              ⇒ craftCount + 1,冠名**不动**,不再生成(= 0 Token)
 * 新配方                          ⇒ 跑 degradeGenerate 出产物,按净化后的名字冠名
 * ```
 *
 * ★ 「没炼过 ⇒ 陈列里没有」是负对照的地基:`createGallery()` 是空馆,
 *   任何查询都返回空 / `null`,不会凭空出现一行。
 */
export function brewAndRecord(gallery: Gallery, input: BrewInput): BrewOutcome {
  const itemIds = input.itemIds;
  if (itemIds.length < MIN_BREW_MATERIALS || itemIds.length > MAX_BREW_MATERIALS) {
    return {
      ok: false,
      reason: `材料件数 ${itemIds.length} 不在 [${MIN_BREW_MATERIALS}, ${MAX_BREW_MATERIALS}]`,
      gallery,
    };
  }
  if (!materialsResolvable(itemIds)) {
    return { ok: false, reason: '材料不在内容表里(或 ID 非法)', gallery };
  }
  const hash = hashOf(itemIds);
  if (hash === null) return { ok: false, reason: '材料 ID 非法', gallery };

  const rows = new Map<string, GalleryEntry>(gallery.rows);
  const existing = rows.get(hash);
  if (existing !== undefined) {
    const bumped: GalleryEntry = { ...existing, craftCount: existing.craftCount + 1 };
    rows.set(hash, bumped);
    return { ok: true, gallery: { rows }, entry: bumped, first: false };
  }

  const materials = materialsOf(itemIds);
  const degraded = degradeGenerate({
    materials,
    affinity: input.affinity,
    suggestedSLogic: input.suggestedSLogic,
    reason: '炼金实验室首创:无 LLM 时的确定性降级',
  });
  const schema: LLMAlchemyOutputSchema = degraded.output;
  const entry: GalleryEntry = {
    recipeHash: hash,
    discovererName: displayNameOf(input.discovererName),
    itemName: schema.item_name,
    itemCategory: schema.item_category,
    craftCount: 1,
    firstAt: Number.isFinite(input.at) ? input.at : 0,
    schemaJson: JSON.stringify(schema),
  };
  rows.set(hash, entry);
  return { ok: true, gallery: { rows }, entry, first: true };
}

/**
 * 这个配方在**全服首个**合成者是谁;没炼过 ⇒ `null`。
 *
 * 与 `brewAndRecord` 的 `first: true` 分支必须是同一份事实 —— 判据两边都问。
 */
export function firstDiscovererOf(gallery: Gallery, itemIds: readonly number[]): string | null {
  const hash = hashOf(itemIds);
  if (hash === null) return null;
  return gallery.rows.get(hash)?.discovererName ?? null;
}

/** 某配方的那一行(没炼过 ⇒ `undefined`)。 */
export function galleryEntryOf(gallery: Gallery, itemIds: readonly number[]): GalleryEntry | undefined {
  const hash = hashOf(itemIds);
  if (hash === null) return undefined;
  return gallery.rows.get(hash);
}

/**
 * 陈列顺序:**先发现的先陈列**(`firstAt` 升序),同一时间戳按哈希升序。
 *
 * 为什么按首次时间而不是按热度:`537` 的原句是「陈列**全服首次合成**的 AI 造物」,
 * 陈列的是历史,不是排行榜 —— 按 `craftCount` 排会让冠军随热度变动,
 * 而「首创」是不变的。
 */
export function galleryOrder(gallery: Gallery): GalleryEntry[] {
  return [...gallery.rows.values()].sort((a, b) => {
    if (a.firstAt !== b.firstAt) return a.firstAt - b.firstAt;
    return a.recipeHash < b.recipeHash ? -1 : a.recipeHash > b.recipeHash ? 1 : 0;
  });
}