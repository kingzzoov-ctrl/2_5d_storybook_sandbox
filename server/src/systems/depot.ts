/**
 * WS-FND-75 / 【云端跨服百货店】(`CLOUD_DEPOT`)的**上架 + 购买结算** —— 纯函数。
 *
 * ## 为什么有这个文件
 *
 * 手册 §3.8 与内容表 `515 无人自助售货摊` 的原句:
 * 「上架自己爆出的**稀有 Boss 材料**或 **AI 炼金奇物**供游客购买」。
 * 而 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION.CLOUD_DEPOT` 此前写着
 * 「需商店/交易系统 ⇒ 未实装」。
 *
 * ## 价格从哪来(**本文件最要紧的一条纪律**)
 *
 * 内容是单一事实源。内容表(`shared/constants/items.ts` 的 `ItemDef`)里有
 * `value`(参与炼金 T_eff 的**价值分**),但**没有** `price`(售价)。
 *
 * 因此本模块:
 *   1. **不发明价格** —— 不存在 `DEFAULT_PRICE` / `PRICE_MUL` 这类常数;
 *   2. `contentPriceTable()` 只**读**内容表里真的写了 `price` 的条目;
 *      今天一条都没有 ⇒ 表是空的;
 *   3. 查不到价格 ⇒ `UNPRICED`,**照实返回「无定价」**,并让购买**被拒且库存不变**。
 *
 * ⚠️ 最容易犯的错是把 `value` 当价格(「V=250 ⇒ 250 金」)。那会把
 * 「炼金价值分」偷偷变成「经济定价」—— 一个数与两个语义,而调平衡的人
 * 会以为改的是价值分。所以这里只认名为 `price` 的字段。
 */

import { ITEM_BY_ID, ITEM_LIST, type ItemDef } from '../../../shared/constants/items.ts';

/** 本实现在 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION` 里登记的身份。 */
export const DEPOT_SYSTEM = Object.freeze({
  roomKey: 'CLOUD_DEPOT',
  module: 'server/src/systems/depot.ts',
  entry: 'buy',
});

/**
 * 可上架的两种东西(内容表 `515` 的字面量):
 * 「稀有 Boss 材料」= tag `Boss遗物`(704~708 那一族);
 * 「AI 炼金奇物」   = tag `奇物`(729/730 ……以后由炼金系统产出的也是这类)。
 */
export const LISTABLE_TAGS: readonly string[] = Object.freeze(['Boss遗物', '奇物']);

/** 价格表:物品 ID → 单价。**只**由内容表生成,或由调用方显式喂。 */
export type PriceTable = Readonly<Record<number, number>>;

/**
 * 从内容表里读价格:只认 `price` 字段(有限正数)。
 *
 * ★ WS-FND-77 A-4/D-19:`ItemDef.price?` 现在**已声明**
 * (`shared/types/entities.ts`),所以这里直接读字段,不再走
 * `as unknown as { price?: unknown }` 的临时结构体。
 *
 * ⚠️ 运行期判定**一个字都没改**:仍然是「有限正数才算有价」——
 *   内容表今天一件都没写 `price` ⇒ 表是空的,`priceOf` 照实回「无定价」。
 *   把 `value`(炼金价值分)当价格是**另一件事**,本模块不认(见文件头)。
 */
export function contentPriceTable(items: readonly ItemDef[] = ITEM_LIST): PriceTable {
  const out: Record<number, number> = {};
  for (const item of items) {
    const raw: unknown = item.price;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    out[item.id] = raw;
  }
  return Object.freeze(out);
}

/**
 * **内容表当前的定价表**:今天为空(内容表条目里一个 `price` 都没写)。
 *
 * 判据对着它核「无定价是照实返回,而不是本模块编的」。
 */
export const CONTENT_PRICE_TABLE: PriceTable = contentPriceTable();

/** 查价结果:要么有价,要么**明说**没定价(不是 0、不是默认值)。 */
export type PriceLookup =
  | { kind: 'PRICED'; price: number }
  | { kind: 'UNPRICED'; reason: string };

/** 一件物品的单价;内容表/喂进来的价格表里没有它 ⇒ `UNPRICED`。 */
export function priceOf(itemId: number, table: PriceTable = CONTENT_PRICE_TABLE): PriceLookup {
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { kind: 'UNPRICED', reason: `物品 ID 非法(${itemId})` };
  }
  if (!ITEM_BY_ID.has(itemId)) {
    return { kind: 'UNPRICED', reason: `内容表里没有物品 ${itemId}` };
  }
  const raw = table[itemId];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return { kind: 'UNPRICED', reason: `内容表未给物品 ${itemId} 定价(无定价)` };
  }
  return { kind: 'PRICED', price: raw };
}

/** 上架判定结果。 */
export interface ListableResult {
  ok: boolean;
  reason: string;
}

/**
 * 这件东西能不能上架(内容表 `515`:稀有 Boss 材料 / AI 炼金奇物)。
 *
 * 只按内容表的 tag 判,不看 `value`(价值高的普通木料也不许上架)。
 */
export function listable(itemId: number): ListableResult {
  const def = ITEM_BY_ID.get(itemId);
  if (def === undefined) return { ok: false, reason: `内容表里没有物品 ${itemId}` };
  for (const tag of LISTABLE_TAGS) {
    if (def.tags.includes(tag)) return { ok: true, reason: `内容表 tag «${tag}» 允许上架` };
  }
  return { ok: false, reason: `物品 ${itemId} 既不是 Boss 遗物也不是奇物 ⇒ 不上架` };
}

/** 一次购买的输入。 */
export interface BuyInput {
  itemId: number;
  qty: number;
  /** 摊位当前库存(物品 ID → 件数)。作为**只读**入参,不改它。 */
  stock: Readonly<Record<number, number>>;
  /** 价格表;缺省 = 内容表定价表(今天为空 ⇒ 一切无定价)。 */
  table?: PriceTable;
}

/** 一次购买的结果。失败时 `stock` 与传入的库存**逐字段相同**。 */
export interface BuyResult {
  ok: boolean;
  reason: string;
  cost: number;
  stock: Record<number, number>;
}

/** 库存快照:只保留有限非负整数件数。 */
function snapshot(stock: Readonly<Record<number, number>>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const key of Object.keys(stock)) {
    const id = Number(key);
    const n = stock[id];
    if (!Number.isFinite(id) || id <= 0) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    out[id] = Math.floor(n);
  }
  return out;
}

/**
 * 购买结算:先在**副本**上算出结果,任何一条不通过就原样退回。
 *
 * ## 检查顺序(每一步都对应一条判据)
 *
 * ```
 * 数量不是正整数                       ⇒ 拒绝(BAD_QTY),库存不变
 * 无定价                              ⇒ 拒绝(UNPRICED),库存不变   ← 照实,不编价
 * 库存不足                            ⇒ 拒绝(OUT_OF_STOCK),库存不变
 * 否则                                ⇒ 扣库存,成本 = 单价 × 数量
 * ```
 *
 * ★ 「库存不足 ⇒ 购买被拒且库存不变」是**负对照**:把库存当可变对象就地减,
 *   就会留下"拒了但已经扣了"的半截状态。
 */
export function buy(input: BuyInput): BuyResult {
  const next = snapshot(input.stock);
  const qty = input.qty;
  if (!Number.isInteger(qty) || qty <= 0) {
    return { ok: false, reason: `购买数量必须是正整数(实际 ${qty})`, cost: 0, stock: next };
  }
  const table = input.table ?? CONTENT_PRICE_TABLE;
  const price = priceOf(input.itemId, table);
  if (price.kind === 'UNPRICED') {
    return { ok: false, reason: price.reason, cost: 0, stock: next };
  }
  const have = next[input.itemId] ?? 0;
  if (have < qty) {
    return {
      ok: false,
      reason: `库存不足:只剩 ${have} 件,想买 ${qty} 件`,
      cost: 0,
      stock: next,
    };
  }
  const left = have - qty;
  if (left > 0) next[input.itemId] = left;
  else delete next[input.itemId];
  return { ok: true, reason: '成交', cost: price.price * qty, stock: next };
}