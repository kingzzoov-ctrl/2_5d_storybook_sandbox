/**
 * `BUY_ITEM` —— **在无人物货摊(515)上买一件东西**。
 *
 * ## 为什么需要这个动作(WS-FND-77 A-4)
 *
 * 手册 §3.8 与内容表 `515 无人自助售货摊` 的原句是「上架自己爆出的**稀有 Boss
 * 材料**或 **AI 炼金奇物**供游客购买」。而 `systems/depot.ts` 的 `buy()` 此前
 * **只有测试在调** —— 全仓没有任何 `RoomAction` 能表达「我要买这一件」。
 * ⇒ 玩家看见摊位、能上架、能查价,**却无法成交**。
 *
 * ## 判序(每一步对应一条判据,见 `tests/WS-FND-77` FND77-5/6)
 *
 * ```
 * 1 越权                       ⇒ PERMISSION(零副作用)
 * 2 没有世界源                 ⇒ NOT_IMPLEMENTED
 * 3 世界源没有摊位能力         ⇒ NOT_IMPLEMENTED(显式能力缺失,不静默放行)
 * 4 itemId / qty 形状不对      ⇒ INVALID
 * 5 报价不成立(无定价/库存不足)⇒ INVALID,库存一件不少
 * 6 背包收不下                 ⇒ INVALID,库存不动(还没提交)
 * 7 提交被拒                   ⇒ INVALID,背包退回去(不吞东西)
 * 8 成交                       ⇒ OK + effect(itemId / qty / cost / 剩余库存)
 * ```
 *
 * ## ⚠️ 本仓**没有货币账本**(这是如实边界,不是遗漏)
 *
 * 内容表里**没有「金币」这件物品**(`ITEM_LIST` 101~745 里没有),`PlayerState`
 * 也没有货币字段。⇒ 本动作把 `cost`(单价 × 数量)**算出来并回执**,
 * 但**不扣任何货币** —— 扣不了的东西不许假装扣了。
 * 货币化(用哪件物品当钱?还是新加一个玩家字段?)是 owner 裁决,
 * 见本文件末尾的「仍未接」清单。
 *
 * ## 零副作用的地基
 *
 * `depot.buy` 是**纯函数**(在库存副本上算,失败原样退回),所以「报价」不会
 * 动世界;成交后才 `purchaseCommit`。这段拆分的唯一理由就是第 6/7 步:
 * 背包与库存必须**要么都变、要么都不变**。
 */
import { ITEM_BY_ID } from '../../../../shared/constants/items.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 购买(515)。
 *
 * 报文契约:`{ itemId: number, qty: number }`。
 */
export const buyItem: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* 1 权限闸:越权在此返回,且未产生任何副作用。 */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* 2 没有世界源 ⇒ 没有摊位。显式 NOT_IMPLEMENTED(与 `material.ts` 同一取舍)。 */
  if (ctx.host === null) {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: '本房间没有世界源 ⇒ 没有摊位可买(百货店需要世界侧的库存)',
    };
  }
  const host = ctx.host;
  /* 3 能力缺失必须**说出来**:写成 `?.` 之后静默跳过正是本仓反复记的形态。 */
  if (typeof host.purchaseQuote !== 'function' || typeof host.purchaseCommit !== 'function') {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: '世界源没有百货摊位能力(purchaseQuote / purchaseCommit)⇒ 无法成交',
    };
  }

  /* 4 报文形状:不猜默认值(把 `qty` 缺失当成 1 会让「报文写错」变成一次成交)。 */
  const itemId = numField(ctx.payload.itemId);
  const qty = numField((ctx.payload as { qty?: unknown }).qty);
  if (itemId === null || !Number.isInteger(itemId)) {
    return { ok: false, kind: 'INVALID', reason: '需要 itemId(整数,内容表里的物品)' };
  }
  if (qty === null || !Number.isInteger(qty) || qty <= 0) {
    return {
      ok: false, kind: 'INVALID',
      reason: `qty 必须是正整数(实得 ${String((ctx.payload as { qty?: unknown }).qty)})`,
    };
  }
  /* 内容表外编号不认(与 `material.ts` 的「编号空投」同一道闸)。 */
  if (ITEM_BY_ID.get(itemId) === undefined) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }

  /* 5 报价(纯判定,零副作用):无定价 / 库存不足都在这一步被拒。 */
  const quote = host.purchaseQuote(itemId, qty);
  if (!quote.ok) {
    return { ok: false, kind: 'INVALID', reason: quote.reason };
  }

  /* 6 先收进背包(产出侧必须先给凭证再 `applyInventory`,否则按「凭空产出」拒)。 */
  const src = `depot-buy:${itemId}x${qty}`;
  ctx.grantItemSource(ctx.actorId, src);
  const gain = ctx.applyInventory(ctx.actorId, {
    ops: [{ itemId, delta: qty, source: src }],
  });
  if (!gain.allowed) {
    /* 背包收不下 ⇒ 库存**还没动**(提交在第 7 步)⇒ 无需回滚,直接拒。 */
    return {
      ok: false, kind: 'INVALID',
      reason: `背包收不下 ${qty} 件(${gain.rejectCode ?? '被拒'})⇒ 未成交,摊位库存不变`,
    };
  }

  /* 7 提交:成交才写库存。被拒 ⇒ 把刚收进来的东西退回去(不吞)。 */
  const commit = host.purchaseCommit(itemId, qty);
  if (!commit.ok) {
    const refundSrc = `depot-buy-refund:${itemId}x${qty}`;
    ctx.grantItemSource(ctx.actorId, refundSrc);
    const refund = ctx.applyInventory(ctx.actorId, {
      ops: [{ itemId, delta: -qty, source: refundSrc }],
    });
    return {
      ok: false, kind: 'INVALID',
      reason: `成交提交被拒(${commit.reason})⇒ 已退回背包那 ${qty} 件`
        + (refund.allowed ? '' : `(退回也被拒:${refund.rejectCode ?? '被拒'})`),
    };
  }

  /* 8 成交回执。`cost` 只是**算出来的**成本(本仓没有货币账本,见文件头)。 */
  return {
    ok: true, kind: 'OK',
    effect: {
      itemId,
      qty,
      cost: commit.cost,
      stock: quote.stock[itemId] ?? 0,
      roomKey: 'CLOUD_DEPOT',
      charged: false,
    },
  };
};