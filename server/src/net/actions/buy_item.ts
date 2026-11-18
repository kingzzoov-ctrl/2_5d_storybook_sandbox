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
 * ## ★ 同帧多单不再被判重放(审计 P2,见下文 `derivedOrderIdOf`)
 *
 * 修前只把 `{ actorId }` 交给 `purchaseCommit`,幂等键退化成
 * `${actorId}#${itemId}#${frameCount}` ⇒ **同一帧的第二单撞第一单的键**、
 * 回 `replayed: true` 被退回,回执写成 `INVALID`「成交提交被拒」。
 * 现在:报文带 `orderId` 就用它;不带则由服务端派生 `actor#item#tick#序号`。
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
import { ItemSourcePurpose } from '../anticheat.ts';
import { bindItemSource, unbindItemSource } from './item_source.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * `WorldSaveHost.purchaseCommit` 的**带幂等键**形态。
 *
 * `net/room.ts` 里那条声明仍是两参,而世界侧
 * `WorldSim.purchaseCommit(itemId, qty, { actorId, orderId })` 早就接受第三参并回
 * `stockOfItem` / `replayed`。⇒ 在本文件收窄一次,只为三件事:
 *   1. 把 `actorId` 传下去 —— 不传则幂等键退化成 `#itemId#frame`,
 *      **两个不同玩家在同一帧买同一件会撞键**(第二个被当重放拒掉);
 *   2. ★ **把显式 `orderId` 传下去**(见下方「同帧多单」);
 *   3. 拿**提交时**的 `stockOfItem`,而不是报价那张旧快照。
 * 字段逐个写出、不用 `any`:契约补进 `room.ts` 之后删掉这个别名即可。
 */
type PurchaseCommitWithKey = (
  itemId: number,
  qty: number,
  opts?: { actorId?: string; orderId?: string },
) => { ok: boolean; cost: number; reason: string; stockOfItem?: number; replayed?: boolean };

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 从 payload 里取**可选的**订单号:缺项 / 非字符串 / 纯空白 ⇒ `null`。
 *
 * 与 `use_alchemy_furnace.ts` 的同名守卫同一口径(空串不是订单号),**不拒绝** ——
 * 它是可选维:老报文没有 `orderId` 仍然合法,由服务端派生(见下)。
 */
function orderIdField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * ## ★ 同帧多单:显式 `orderId` 由谁给(审计 P2:修前第二单被判重放)
 *
 * 修前本文件只把 `{ actorId }` 传给 `purchaseCommit`,世界侧的幂等键退化成
 * `${actorId}#${itemId}#${frameCount}` ⇒ **同一帧的第二单撞上第一单的键**,
 * 回 `replayed: true` 被退回,而回执写成 `INVALID`「成交提交被拒」。玩家的行为
 * 完全合法(同一帧买两单),却被当成重放 —— 这是键**不唯一**,不是玩家重发。
 *
 * 修法(两层,缺一层都还漏):
 *   1 **客户端给了 `orderId` 就用它**(权威身份;重发同单号 ⇒ 世界侧按重放拒,
 *      `stallStock` 一位不动 —— 幂等仍成立);
 *   2 没给 ⇒ **服务端派生** `${actorId}#${itemId}#${tick}#${seq}`,其中 `seq` 是
 *      本房间本 tick 内 `(actor, item)` 的第几单 ⇒ 同帧多单**必可区分**。
 *
 * ⚠️ 如实边界:没有 `orderId` 时这份派生键**不是**幂等键 —— 服务端无法把
 *   「同一单重发」与「同帧第二单」区分开(两者在报文里完全一样)。扣减仍受
 *   摊位库存与背包容量约束,而真正的重发保护要求客户端带 `orderId`。
 *   这一句写在这里,而不是留成「看起来有幂等」的假象。
 *
 * 状态为什么挂在 `ctx.state` 的**对象身份**上(`WeakMap`):它只是「本房间本 tick
 * 第几单」的计数器,不是账本 —— 按房间实例分桶既不会跨房间串号,也不会随
 * 创建过的房间数增长(房间被回收即随 GC 消失)。
 */
type SeqBucket = { tick: number; byItem: Map<number, number> };
const PURCHASE_SEQ = new WeakMap<object, SeqBucket>();
/** `ctx.state` 不是对象的手搓桩(单测夹具)共用一份 —— 同样按 tick 重置。 */
const STUB_SEQ_BUCKET: SeqBucket = { tick: Number.NaN, byItem: new Map<number, number>() };

/** 本房间(或桩)的序号桶;`tick` 变了就整桶重置(序号只在本 tick 内有意义)。 */
function seqBucketOf(ctx: ActionContext, tick: number): SeqBucket {
  const state = ctx.state as unknown;
  let bucket: SeqBucket | undefined;
  if (state !== null && typeof state === 'object') {
    bucket = PURCHASE_SEQ.get(state as object);
    if (bucket === undefined) {
      bucket = { tick, byItem: new Map<number, number>() };
      PURCHASE_SEQ.set(state as object, bucket);
    }
  } else {
    bucket = STUB_SEQ_BUCKET;
  }
  if (bucket.tick !== tick) {
    bucket.tick = tick;
    bucket.byItem.clear();
  }
  return bucket;
}

/** 当前 tick(与 `item_source.ts` 的令牌 tick 同一读数;桩没有 `state` ⇒ 0)。 */
function tickOf(ctx: ActionContext): number {
  const state = ctx.state as unknown as { meta?: { tick?: number } } | null | undefined;
  return typeof state?.meta?.tick === 'number' ? state.meta.tick : 0;
}

/** 本帧第几单 `(actor, item)`;从不重复 ⇒ 同帧多单的派生键必不相同。 */
function nextOrderSeq(bucket: SeqBucket, itemId: number): number {
  const n = (bucket.byItem.get(itemId) ?? 0) + 1;
  bucket.byItem.set(itemId, n);
  return n;
}

/** 本文件里唯一的键形(派生形态):`actor#item#tick#序号`。 */
function derivedOrderIdOf(ctx: ActionContext, itemId: number, tick: number, seq: number): string {
  return `${ctx.actorId}#${itemId}#${tick}#${seq}`;
}

/**
 * 购买(515)。
 *
 * 报文契约:`{ itemId: number, qty: number, orderId?: string }`。
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
  /* ★ 可选订单号(见 `derivedOrderIdOf` 上方):给了就原样用,没给由下面派生。 */
  const givenOrderId = orderIdField((ctx.payload as { orderId?: unknown }).orderId);

  /* 5 报价(纯判定,零副作用):无定价 / 库存不足都在这一步被拒。 */
  const quote = host.purchaseQuote(itemId, qty);
  if (!quote.ok) {
    return { ok: false, kind: 'INVALID', reason: quote.reason };
  }

  /* 6 先收进背包(产出侧必须先铸**绑定凭证**再 `applyInventory`,否则按「凭空产出」拒)。 */
  const src = bindItemSource(ctx, itemId, ItemSourcePurpose.PURCHASE);
  const gain = ctx.applyInventory(ctx.actorId, {
    ops: [{ itemId, delta: qty, source: src }],
  });
  if (!gain.allowed) {
    /* 背包收不下 ⇒ 库存**还没动**(提交在第 7 步)⇒ 无需回滚,直接拒。
       ★ 审计 P3:这张凭证已经**登记**过了,而它没有被用掉 ⇒ **显式撤销**,
       否则本 tick 内它一直是「服务端认可过的来源」(靠「消耗侧不读」兜是巧合,不是判据)。 */
    unbindItemSource(ctx, src);
    return {
      ok: false, kind: 'INVALID',
      reason: `背包收不下 ${qty} 件(${gain.rejectCode ?? '被拒'})⇒ 未成交,摊位库存不变`,
    };
  }

  /* 7 提交:成交才写库存。被拒 ⇒ 把刚收进来的东西退回去(不吞)。
     ★ 幂等键:显式 `orderId`(客户端给的,或本帧第几单派生的)—— 见 `derivedOrderIdOf`。 */
  const tick = tickOf(ctx);
  const seq = nextOrderSeq(seqBucketOf(ctx, tick), itemId);
  const orderId = givenOrderId ?? derivedOrderIdOf(ctx, itemId, tick, seq);
  const commitFn = host.purchaseCommit as PurchaseCommitWithKey;
  const commit = commitFn(itemId, qty, { actorId: ctx.actorId, orderId });
  if (!commit.ok) {
    /* ★ 审计 P0-2:退回是**负 delta**(把这 qty 件拿回去),不是产出 ⇒
       **不发凭证**。修前这里 `grantItemSource(refundSrc)` ⇒ 一张退款凭证凭空多出来,
       而且和正向那条一样不绑 itemId。负 delta 也不需要 source(凭证链只约束产出侧)。 */
    const refund = ctx.applyInventory(ctx.actorId, {
      ops: [{ itemId, delta: -qty }],
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
      /* ★ 提交时的实测库存(权威),不是 `quote.stock` 那张报价快照 ——
         两者在「报价之后、提交之前库存又被动过」时会分叉。
         `?? quote...` 只是给**不返回该字段的老世界源/测试桩**兜底:它们连
         第三参都不接,拿不到实测值;权威路径仍是 `commit.stockOfItem`。 */
      stock: commit.stockOfItem ?? quote.stock[itemId] ?? 0,
      /* ★ 本单的幂等键(显式派生或客户端给的)如实回执 —— 「这一单凭什么不被当重放」
         是可判定事实,不该只活在服务端内存里。 */
      orderId,
      roomKey: 'CLOUD_DEPOT',
      charged: false,
    },
  };
};