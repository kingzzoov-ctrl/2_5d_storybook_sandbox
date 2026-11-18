/**
 * `CRAFT` —— **通用合成**:客户端说「按某个产物 itemId 合成一份」,服务端照配方结算。
 *
 * 接线前它是 `notImplemented(...)`(`docs/TASK-96-action-landing-gaps.md` 第三节:
 * 「`cooking.ts` 有 `cookSoup`(料理站),但**通用合成**没有入口:缺「配方 →
 * 材料扣减 → 产物」的事务性写入」)。本文件就是那条写入,**只改本文件** ——
 * `action_table.ts` / `room.ts` 一个字都不用动(尚未接线的动作各占一个模块)。
 *
 * ## 报文契约
 *
 * ```ts
 * { itemId: number }
 * ```
 *
 *   · `itemId` = 要合成的**产物**(必须在冻结内容表里、且有配方);
 *   · 材料明细**不再由客户端提供**(审计 P1)。
 *
 * ## ★ 材料明细的权威读口(这次修的洞)
 *
 * 修前报文里的 `have`(客户端自报 `物品 id → 数量`)是**唯一**的配方输入,
 * 服务端只有「总量」兜底 ⇒ 只要总量够,就能用**别的道具**冒充配方材料;
 * 配合 `DROP_ITEM` 的可丢任意 id,背包可以整体「换 id」。
 * 现在改成读 `RoomRuntime.authoritativeItemCount`(按件账,唯一写入口是
 * `applyInventory`)—— 与 `use_item.ts:145` 同一口径;**缺读口 ⇒
 * `NOT_IMPLEMENTED`,不退回信客户端**。报文里带不带 `have` 都不再影响结算。
 *
 * ## 三件必须**在同一处**做的事(照 `material.ts` 的纪律)
 *
 *   1 **权限闸**写在这里 —— 世界/内容方法没有「谁」这个参数
 *     (与 `CLOSE_ROOM` / 物质层同一例外);`ACTION_PERMISSION.CRAFT = 'build'`
 *     ⇒ GUEST 在闸上被拦,且**不产生任何副作用**;
 *   2 材料扣减与产物入包**都**走 `ctx.applyInventory` —— 反作弊的总量守恒与
 *     凭证链都在那条路上,绕过它 = 绕过了本仓唯一的物品真值来源;
 *   3 事务性:**产物收不下就把材料退回去**(带 source 的 +delta),不吞材料。
 *
 * 产出侧必须**先** `bindItemSource(…, itemId, CRAFT)` **再** `applyInventory(+n, source)`:
 * 令牌绑产物 id,只有这一件能凭它入包(`checkInventory` 会核绑定、tick 与一次性)。
 *
 * ## 配方的唯一出处是内容层
 *
 * 匹配只调 `matchRecipeByTags`(冻结层的 CR-17 实现):确定件(`recipe`)+ 留白槽
 * (`recipeAnyTag`)逐槽扣减。这里**不**另写配方表、**不**复述留白语义 ——
 * 两份实现今天一致、迟早漂移(`#245` 的「任意染料」就是被硬编成 166 过的那条)。
 *
 * ⚠️ `ActionOutcome['effect']` 的值类型只声明了基本类型
 *   (`Record<string, string | number | boolean>`),装不下 `consumed` 这份嵌套明细
 *   ⇒ 回执处有一次**显式窄化断言**;运行时它只是一个 `itemId → 数量` 的纯数字字面量,
 *   与客户端读到的 JSON 形状一致(该类型在 `room.ts`,不在本文件的写域内)。
 *
 * ## 高级锻造闸(D-11,owner 2026-11-16 裁)
 *
 * `rooms/effects.ts` 的 `forgeUnlocked`(= 玩家站在 `FORGE_MASTER` 房间里)此前**没有**
 * 消费点。裁决:`解锁 = 能用 **505** 工作台出产的配方`(不新增 `tier` 字段,不动冻结内容表)。
 * ⇒ 本文件按**内容表的 `station`** 判:`station === 505` 的配方要求该玩家已解锁,
 *   锁着 ⇒ **显式** `PERMISSION`(并点明"未解锁高级锻造"),不是静默失败、也不是"照做但没效果"。
 *
 * 事实从**宿主的一个可选方法**取(房间不许自己猜玩家站在哪个房间):
 *
 * ```ts
 * ctx.host.forgeUnlockedOf?(actorId: string): boolean
 * ```
 *
 * 世界侧把 `roomEffects` 的 `forgeUnlocked` 投影成这条读口。宿主**没有**这个方法 ⇒
 * `NOT_IMPLEMENTED` + 可读理由(与 `material.ts` 的 `materialsOf()`、`reset_world.ts` 的
 * `resetWorld` 同契约:能力缺失要**如实**回执,不许当成"锁着",也不许当成"解锁")。
 *
 * ⚠️ 无方法的形态**不做兜底**:今天生产的 `WorldSim` 若还没有这条读口,505 配方一律
 *   `NOT_IMPLEMENTED`(而不是"默认放行")—— 默认放行等于裁决没落地。
 *
 * ⚠️ **非 505 配方完全不受影响**:闸只在 `def.station === 505` 时进(零回归)。
 */
import { ITEM_BY_ID, matchRecipeByTags } from '../../../../shared/constants/items.ts';
import { ItemSourcePurpose } from '../anticheat.ts';
import { authoritativeStock, bindItemSource, missingItemReadPort, unbindItemSource } from './item_source.ts';
import type { ActionOutcome, WorldSaveHost } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/** `effect` 的声明形状:`ActionOutcome['effect']` 的值只允许基本类型(见文件头)。 */
type EffectRecord = NonNullable<ActionOutcome['effect']>;

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ⚠️ 修前这里还有 `CraftPayload` / `stockField`:它们把报文里的 `have`
   当成**唯一**的材料明细。审计 P1 之后材料只从按件权威账读,两个符号已删 ——
   留着它们就是留一条"客户端还能决定扣什么"的死路。 */

/**
 * 高级锻造台 = **505**(取 `shared/constants/items.ts` 的 `station` 字段)。
 *
 * D-11:「解锁 = 能用 **505** 工作台出产的配方」。本文件**只**读内容表这一个字段,
 * 不另立"中高级"分档表 —— 那会是第二份内容层(迟早与冻结表漂移)。
 */
const ADVANCED_FORGE_STATION = 505;

/**
 * 宿主的**可选**能力:该玩家是否已解锁高级锻造。
 *
 * 世界侧把 `roomEffects` 的 `forgeUnlocked` 投影成这条读口。`?` 是刻意的 ——
 * 老世界源没有它时,505 配方必须**如实**回 `NOT_IMPLEMENTED`,不许默认放行。
 */
type ForgeUnlockedHost = WorldSaveHost & {
  forgeUnlockedOf?(actorId: string): boolean;
};

/**
 * D-11 的闸:`station === 505` 的配方要求该玩家已解锁中高级锻造。
 *
 * 返回 `null` = 放行;非 `null` = 失败回执,调用方**原样**返回(不要二次改写 kind)。
 *
 *   1 宿主没有这条读口(`ctx.host === null` 或方法不存在)⇒ `NOT_IMPLEMENTED` +
 *     可读理由(与 `material.ts` 的 `materialsOf()` / `reset_world.ts` 同契约);
 *   2 读口说"没解锁" ⇒ `PERMISSION`(越权语义:**能力**不够,不是报文/状态不对);
 *   3 只有明确的 `true` 才放行 —— 不猜默认值,失败即锁。
 */
function forgeGate(ctx: ActionContext, itemId: number, name: string): ActionOutcome | null {
  const host = ctx.host as ForgeUnlockedHost | null;
  const read = host === null ? undefined : host.forgeUnlockedOf;
  if (typeof read !== 'function') {
    return {
      ok: false,
      kind: 'NOT_IMPLEMENTED',
      reason:
        `${ctx.action} #${itemId}(${name})要 505 高级锻造台,而宿主没有 forgeUnlockedOf`
        + ' ⇒ 无法判定该玩家是否已解锁高级锻造(D-11,未消耗任何材料)',
    };
  }
  /* `this` 绑回宿主:这是宿主的方法,不是自由函数。 */
  if (read.call(host, ctx.actorId) === true) return null;
  return {
    ok: false,
    kind: 'PERMISSION',
    reason:
      `未解锁高级锻造:#${itemId}(${name})要 505 高级锻造台`
      + '(站在 FORGE_MASTER 房间里才解锁,见 D-11)⇒ 未消耗任何材料',
  };
}

/** `CRAFT`:按内容层配方合成一份;材料不足不扣、产物收不下则退回材料。 */
export const craft: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* 1 权限闸:越权在此返回,且**未产生任何副作用**(背包一个数都没动)。 */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* 2 参数:缺项/形状不对一律显式拒绝(不猜默认值)。 */
  const itemId = numField(ctx.payload.itemId);
  if (itemId === null || !Number.isInteger(itemId)) {
    return { ok: false, kind: 'INVALID', reason: '需要 itemId(整数,内容表里的产物)' };
  }
  /* ★ 材料明细只认**服务端按件账**(审计 P1):报文里的 `have` 不再参与结算。
     缺读口 ⇒ 显式 NOT_IMPLEMENTED(不退回"信客户端")。 */
  const stock = authoritativeStock(ctx);
  if (stock === null) return missingItemReadPort(ctx);

  /* 3 产物必须在冻结内容表里、且有配方 —— 「编号空投」与「无配方产物」都拒。 */
  const def = ITEM_BY_ID.get(itemId);
  if (def === undefined) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }
  if (def.recipe === undefined && def.recipeAnyTag === undefined) {
    return { ok: false, kind: 'INVALID', reason: `#${itemId}(${def.name})没有配方,不是可合成产物` };
  }

  /* 4 高级锻造闸(D-11):505 工作台的配方要求该玩家已解锁中高级锻造。
     位置是**契约**:在报文/内容表校验**之后**、配方匹配与扣减**之前** ——
     ⇒ 越权与报文错仍先被拦(判据不因新闸改顺序),而被拒时**一件材料都没扣**。 */
  if (def.station === ADVANCED_FORGE_STATION) {
    const denied = forgeGate(ctx, itemId, def.name);
    if (denied !== null) return denied;
  }

  /* 5 配方匹配**只走内容层那一份**(`matchRecipeByTags`):先确定件、再逐个填留白槽。
     别在这里再写一遍配方表或留白语义 —— 那就是本仓反复点名的「两份实现」。 */
  const match = matchRecipeByTags(itemId, stock);
  if (!match.ok) {
    /* 材料不足是 **INVALID**(参数/状态不对),**不是** PERMISSION ——
       越权与缺料混成同一个 kind 会让客户端与读者都误判。 */
    return { ok: false, kind: 'INVALID', reason: `材料不足:${match.reason ?? '配方不满足'}` };
  }

  /* 配方里写 0 的登记项(如 `523` 的 `163: 0`)不产生操作:delta 0 不是一次增减。 */
  const spendOps = Object.entries(match.consumed)
    .map(([k, n]) => ({ itemId: Number(k), delta: -n }))
    .filter((op) => op.delta !== 0);

  /* 6 **先扣材料**:整批 ops 一次提交 ⇒ 反作弊要么全过要么全拒,不存在「扣了一半」。
     消耗是负 delta,不需要 source(凭证链只约束产出侧)。 */
  const spend = ctx.applyInventory(ctx.actorId, { ops: spendOps });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `材料扣减被拒(${spend.rejectCode ?? '被拒'})⇒ 未消耗任何材料`,
    };
  }

  /* 7 **再给产物**:先铸**绑定**凭证再 `applyInventory(+n, source)`,顺序反过来
     会被反作弊按「凭空产出」拒。产出件数取内容表的 `output`(`151` 是 1 材料 → 2 件)。 */
  const made = Math.max(1, Math.trunc(def.output ?? 1));
  const src = bindItemSource(ctx, itemId, ItemSourcePurpose.CRAFT);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: made, source: src }] });
  if (!gain.allowed) {
    /* ★ 审计 P3:产物这张凭证已经登记、却没有被用掉 ⇒ **显式撤销**。
       修前它留到 tick 末 `expireItemSources` 才消失,期间一直是「服务端认可过的
       来源」—— 本 tick 内另一条分支拿同一张串铸 +delta 会被「登记过」放行。
       (撤销与退回是两件事:退回救玩家那批材料,撤销收回这张没用掉的凭证。) */
    unbindItemSource(ctx, src);
    /* 8 事务性:产物收不下(容量 ⇒ `ITEM_OVERFLOW`)⇒ **退回材料**,不吞材料。
       退回是正 delta ⇒ **每一件**都要自己的绑定令牌(令牌绑 itemId,不能串用)。 */
    const refund = ctx.applyInventory(ctx.actorId, {
      ops: spendOps.map((op) => ({
        itemId: op.itemId,
        delta: -op.delta,
        source: bindItemSource(ctx, op.itemId, ItemSourcePurpose.CRAFT_REFUND),
      })),
    });
    return {
      ok: false, kind: 'INVALID',
      reason: `产物收不下(${gain.rejectCode ?? '被拒'})⇒ 材料已退回`
        + (refund.allowed ? '' : `(退回也被拒:${refund.rejectCode ?? '被拒'})`),
    };
  }

  /* 回执:`consumed` 是**真的被扣掉的那几件**(含留白槽选中的那件),不是配方需求表。
     该字段是嵌套对象,`ActionOutcome['effect']` 的值类型装不下 ⇒ 显式窄化(见文件头)。 */
  return {
    ok: true, kind: 'OK',
    effect: { itemId, produced: made, consumed: match.consumed } as unknown as EffectRecord,
  };
};
