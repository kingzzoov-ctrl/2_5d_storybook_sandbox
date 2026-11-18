/**
 * 动作层与「物品真值」之间的**两道口**,一个文件放齐:
 *
 * ```
 * bindItemSource(ctx, itemId, purpose)  产出侧:铸一张绑定凭证并登记
 * ownedItemCount(ctx, itemId)           扣减侧:这件物品**真的**有几件
 * authoritativeStock(ctx)               扣减侧:整份「物品 id → 件数」明细
 * ```
 *
 * ## 为什么要有这个文件(审计 P0-2 + P1)
 *
 * 修前两处各是半截:
 *   1 **产出侧**:`ctx.grantItemSource(actorId, 'break:1,2:101')` 登记的是**裸字符串**,
 *      `checkInventory` 只判「串在不在集合里」⇒ 客户端拿自己刚拆块的那个串去铸
 *      `{ itemId: 733, delta: 999 }` —— 一张凭证任意物品;而且凭证从不失效。
 *   2 **扣减侧**:`DROP_ITEM` / `OPEN_CHEST`(存入)/ `BREED_TAME`(投喂)/ `CRAFT`
 *      的 `itemId` 与材料明细全是**客户端自报**,只被「总量守恒」兜着
 *      ⇒ 「丢一件任意 id + 捡起来」= 背包任意换 id。
 *
 * 现在:产出侧只铸**令牌**(`mintItemSourceToken`,绑定 actor/itemId/用途/tick,
 * 一次性);扣减侧只读**按件权威账**(`RoomRuntime.itemCountOf`,与
 * `use_item.ts` 同口径)。两条口都 fail-closed:没有读口 ⇒ `NOT_IMPLEMENTED`,
 * 不退回「信客户端」—— 那正是要修的缺陷。
 *
 * ⚠️ 本文件**不重复实现**任何判定:令牌的铸与验在 `anticheat.ts`,按件账在
 *   `room.ts`(`applyItemCountDelta` 是唯一写入口)。这里只做接线与窄化。
 */
import type { ActionOutcome, ItemReadPort } from '../room.ts';
import { mintItemSourceToken } from '../anticheat.ts';
import type { ItemSourcePurpose } from '../anticheat.ts';
import type { ActionContext } from './types.ts';

/**
 * 铸一张**绑定**的产出凭证并登记到服务端凭证集,返回要放进 `op.source` 的令牌。
 *
 * 顺序纪律:**必须早于**对应的正向 `applyInventory`(否则被按「凭空产出」拒)。
 * 令牌的 tick 取 `ctx.state.meta.tick` —— 与 `RoomRuntime.applyInventory` 判过期
 * 用的那个 tick **是同一个值**,不是两次读时钟。
 */
export function bindItemSource(
  ctx: ActionContext,
  itemId: number,
  purpose: ItemSourcePurpose,
): string {
  /* ⚠️ `ctx.state` 在**单测桩**里可能是 `null`(WS-FND-77 的 BUY_ITEM 夹具)。
     那种情况下没有「当前 tick」可绑 ⇒ 用 0;而 0 与真实房间的 tick 几乎必然不等,
     ⇒ 令牌会被 `checkInventory` 按 `ITEM_SOURCE_EXPIRED` 拒(**fail-closed**:
     宁可这件东西进不了包,也不让凭证变成一张"永远有效"的空头承诺)。
     生产路径的 `ctx` 一定带 `state`(见 `room.ts` 的 `actionContextFor`)。 */
  const state = ctx.state as unknown as { meta?: { tick?: number } } | null | undefined;
  const tick = typeof state?.meta?.tick === 'number' ? state.meta.tick : 0;
  const token = mintItemSourceToken({
    actorId: ctx.actorId,
    itemId,
    purpose,
    tick,
  });
  ctx.grantItemSource(ctx.actorId, token);
  return token;
}

/**
 * **撤销**一张已登记的产出凭证 —— 正向发放失败时的显式回撤入口。
 *
 * ## 为什么需要它(审计 P3:令牌先登记后正向失败不回撤)
 *
 * `bindItemSource` 是**登记**,`applyInventory(+, source)` 才是**发放**。两者的
 * 顺序保证是对的(先登记后发放),但**发放被拒时不回撤登记** ⇒ 一张铸好却没用掉的
 * 令牌留到 tick 末,`expireItemSources` 之前它一直是「服务端认可过的来源」。
 * 同一 tick 内只要另一条分支拿它去铸 +delta,`checkInventory` 就会按「登记过」放行
 * —— 那正是「凭证链只约束产出侧」被绕开的形态。
 *
 * ⇒ 失败路径**显式**撤销,而不是靠「消耗侧不读」兜(那不是判据,是巧合)。
 *
 * 撤销是**幂等**的:串不在集合里就什么都不做(重复调用安全)。
 * 宿主没有撤销口(手搓 `ctx` 的测试桩)⇒ 返回 `false`,调用方据此知道
 * 「这条链没接撤销口」—— 与 `missingItemReadPort` 同一条 fail-closed 纪律:
 * 不把「没接」当成「撤过了」。
 */
export function unbindItemSource(ctx: ActionContext, source: string): boolean {
  if (typeof ctx.revokeItemSource !== 'function') return false;
  ctx.revokeItemSource(ctx.actorId, source);
  return true;
}

/**
 * 「按件权威读口」的结构化窄化(`RoomRuntime` 把绑定函数挂进上下文)。
 *
 * 与 `use_item.ts` 的 `ctx as unknown as Partial<ItemReadPort>` 同一条口径:
 * 类型在 `room.ts`,本层只**读**。缺读口时返回 `null`,由调用方显式拒绝。
 */
function portOf(ctx: ActionContext): Partial<ItemReadPort> {
  return ctx as unknown as Partial<ItemReadPort>;
}

/** 该玩家**真的**持有多少件 `itemId`;宿主未接读口 ⇒ `null`(不等于 0!)。 */
export function ownedItemCount(ctx: ActionContext, itemId: number): number | null {
  const port = portOf(ctx);
  if (typeof port.itemCountOf !== 'function') return null;
  const n = port.itemCountOf(ctx.actorId, itemId);
  return Number.isFinite(n) ? n : 0;
}

/** 整份「物品 id → 件数」明细(只含 > 0);宿主未接读口 ⇒ `null`。 */
export function authoritativeStock(ctx: ActionContext): Record<number, number> | null {
  const port = portOf(ctx);
  if (typeof port.itemCountOf !== 'function' || typeof port.itemIdsOf !== 'function') {
    return null;
  }
  const stock: Record<number, number> = {};
  for (const id of port.itemIdsOf(ctx.actorId)) {
    const n = ownedItemCount(ctx, id);
    if (n !== null && n > 0) stock[id] = n;
  }
  return stock;
}

/**
 * 缺读口的**统一回执**。
 *
 * 为什么是 `NOT_IMPLEMENTED` 而不是 `INVALID`:这是**链路没接好**(服务端没有
 * 按件账读口),不是玩家报文错。写成 `INVALID` 会让「宿主忘了接线」和
 * 「玩家作弊」在两个计数器上无法区分 —— 本仓反复记的那类归因失真。
 */
export function missingItemReadPort(ctx: ActionContext): ActionOutcome {
  return {
    ok: false,
    kind: 'NOT_IMPLEMENTED',
    reason: `${ctx.action} 缺少按件库存读口(服务端无法确认 itemId 的真伪)`,
  };
}