/**
 * `USE_ALCHEMY_FURNACE` —— **在炼金台上炼一件东西**。
 *
 * ## ⚠️ 这一版是**本地确定性实现**;LLM 炼金的接线**不在本轮**
 *
 * 炼金台在内容层是 `536`【AI核心】万物奇想炼金炉(`recipe: {157:4,116:4,130:2}`),
 * 手册给它的功能是「自由放入任意 2~4 件非蓝图物品,**调用大模型** + 特定属性算法
 * 生成全新奇物」;`rooms/effects.ts` 的 `ROOM_EFFECT_DECISION.ALCHEMY_LAB` 也写着
 * 「需 LLM 与陈列系统 ⇒ 未实装」;世界侧的 `WorldSim.forgeAlchemy()` 走的正是
 * `alchemy/index.ts` 的 LLM 编排(`createAlchemyService` + `StubLlmClient`)。
 *
 * ⇒ 那条路**不接外部服务**:本文件**不**调用 `forgeAlchemy`,也**不** import
 *   `server/src/alchemy/**`。接上来的是台面的**确定性**语义:
 * ```ts
 *   站在炼金室(ALCHEMY_LAB) + 内容层已有配方的产物  ⇒ 扣材料、给产物
 * ```
 * 「任意材料 → 全新奇物」(自由炼金)仍然是未实装项,留给 LLM 那一轮;
 * 本文件在回执里如实带上 `freeForge: false`,不假装它已经是自由炼金。
 *
 * ## 站位判定读哪里(以及为什么该口不在契约里)
 *
 * 动作**不**自己识别房间 —— 那会是第二份实现。判定读世界源慢帧的产出
 * `lastRoomEffects[].roomKey`,即 `rooms/effects.ts` 的 `stepRoomEffects`
 * **消费过的那个 `roomKey`**(`WorldSim.tickRoomEffects` 逐玩家写入)。
 * 与 `actions/sleep.ts` 读 `roomEffectOf()` 是**同一手法**。
 *
 * 为什么不是直接 `roomEffectOf()`:`RoomEffectState` 只有
 * `inOnsen/inBedroom/inForge/inCanteen` 四个字段,炼金室是
 * `SYSTEM_UNLOCK`(无逐玩家状态位)⇒ 那个口拿不到 `ALCHEMY_LAB`。
 * `lastRoomEffects` 是同一慢帧的**姊妹产物**,`roomKey` 就在它上面。
 *
 * ⚠️ `ActionContext.host` 声明为 `WorldSaveHost`,而 `lastRoomEffects`
 *   目前**不在**那份结构化契约里(`net/room.ts` 的可选成员清单)。
 *   本次改动只允许碰本文件 ⇒ 用**局部窄类型**读它;缺这一项时动作显式回
 *   `INVALID`,而不是静默跳过。若将来把它正式写进 `WorldSaveHost`,
 *   删掉下面的 `AlchemyLabReadPort` 即可(届时那段 `unknown` 转换也能收掉)。
 *
 * ## 三件必须**在同一处**做的事(照 `craft.ts` / `material.ts` 的纪律)
 *
 *   1 **权限闸**写在这里 —— 世界方法没有「谁」这个参数;权限位以
 *     `ACTION_PERMISSION.USE_ALCHEMY_FURNACE = 'publicStorage'` 为准
 *     ⇒ MEMBER / GUEST 在闸上被拦(`PERMISSION_MATRIX` 里两者都是 `false`),
 *     且**不产生任何副作用**。本文件不发明额外规则。
 *   2 材料扣减与产物入包**都**走 `ctx.applyInventory` —— 反作弊的总量守恒与
 *     凭证链都在那条路上,绕过它 = 绕过了本仓唯一的物品真值来源;
 *     产出侧必须**先** `bindItemSource(…, itemId, CRAFT)` **再** `applyInventory(+n, source)`,
 *     否则 `checkInventory` 会按「凭空产出」拒(`ITEM_FROM_NOTHING`)。
 *   3 事务性:**产物收不下就把材料退回去**(带 source 的 +delta),不吞材料。
 *
 * ## 配方与材料匹配的唯一出处是内容层
 *
 * 只调 `matchRecipeByTags`(`shared/constants/items.ts` 的 CR-17 实现:确定件 +
 * 留白槽逐槽扣减),与 `CRAFT` **同一份**匹配器。这里**不新增配方表**、
 * 不复述留白语义 —— 两份实现今天一致、迟早漂移(`#245` 的「任意染料」)。
 *
 * ⚠️ 材料明细**只认服务端按件账**(审计 P1):报文里的 `have` 不再参与结算
 *   —— 修前它既是**唯一**的配方输入,又只有「总量」兜底 ⇒ 总量够就能拿别的
 *   道具冒充配方材料。现在读 `RoomRuntime.authoritativeItemCount`(与
 *   `use_item.ts:145` 同一口径);缺读口 ⇒ `NOT_IMPLEMENTED`,不退回信客户端。
 *
 * ## 报文契约
 *
 * ```ts
 * { itemId: number, orderId?: string }
 * ```
 *
 * ★ `orderId` 是**请求号**(WS-FND-96 幂等键的一维):同一单号重发 ⇒ 世界侧按
 * 「已结算」拒掉,`craftCount` / 冠名 / 537 陈列一位不动。缺省(老客户端没这个
 * 字段)由世界侧退化成 `(actorId, 材料, 帧)` 派生键 —— 本文件**不发明**订单号。
 *
 * ★ **判重前移**(审计 P2,修前判重在发放之后):`orderId` 现在**先预占**再扣料/发放,
 *   见第 7 步的「订单预占」与 `claimFurnaceOrder`。修前的顺序是
 *   `spend → gain → brewAtFurnace(orderId)` ⇒ 同一单重放会**真的炼出第二炉**,
 *   只有 537 陈列被世界侧拒掉;现在预占失败 ⇒ 直接拒且**零副作用**。
 */
import { ITEM_BY_ID, matchRecipeByTags } from '../../../../shared/constants/items.ts';
import { SETTLEMENT_ROOMS, settleKeyOf } from '../../systems/idempotency.ts';
import { ItemSourcePurpose } from '../anticheat.ts';
import { authoritativeStock, bindItemSource, missingItemReadPort, unbindItemSource } from './item_source.ts';
import type { ActionOutcome, WorldSaveHost } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * 炼金实验室的房间 key(内容层 `ROOM_RECIPES` 里 `required: [536, 537]` 的那条)。
 *
 * 写成常量而不是散在理由文本里:`stepRoomEffects` / `ROOM_EFFECT_DECISION`
 * 也按同一个字面量判定,两侧必须逐字一致。
 */
export const ALCHEMY_LAB_ROOM_KEY = 'ALCHEMY_LAB';

/**
 * `USE_ALCHEMY_FURNACE` 在世界源上真正需要的那**一项**能力(见文件头的
 * 「站位判定读哪里」)。`WorldSaveHost` 里没有它 ⇒ 局部窄类型 + 显式拒绝。
 */
type AlchemyLabReadPort = {
  lastRoomEffects?: readonly { playerId: string; roomKey: string | null }[];
};

/** `effect` 的声明形状:`ActionOutcome['effect']` 的值只允许基本类型。 */
type EffectRecord = NonNullable<ActionOutcome['effect']>;

/**
 * `WorldSaveHost.brewAtFurnace` 的**带请求号**形态。
 *
 * `net/room.ts` 的契约仍是 `opts { affinity, suggestedSLogic, at }`(本批只允许改本
 * 文件),而世界侧 `WorldSim.brewAtFurnace` 已接受 `opts.orderId` 并把它当**幂等键**
 * (`ALCHEMY_LAB@ORDER:<订单号>`,见 `systems/idempotency.ts`)。
 * ⇒ 这里收窄一次,只为把请求号透传下去;契约补进 `room.ts` 之后删掉本别名。
 */
type FurnaceBrewWithOrder = (
  actorId: string,
  itemIds: readonly number[],
  opts?: { affinity?: number; suggestedSLogic?: number; at?: number; orderId?: string },
) => ReturnType<NonNullable<WorldSaveHost['brewAtFurnace']>>;

/* ═══════════════ 1'. 订单预占(pre-claim):判重前移的落点 ═══════════════ */

/** 一次预占的结果:`ok:false` ⇒ 这张单**已经结算过**,调用方必须整笔拒绝且零副作用。 */
export type FurnaceClaim =
  | { ok: true; key: string; at: number }
  | { ok: false; key: string; seenAt: number; reason: string };

/**
 * 每个**房间实例**一份预占表(`WeakMap` 的键是 `ctx.state` 的对象身份)。
 *
 * 为什么按实例身份而不是按 `roomId`:它只是「这一单在本房间里有没有结算过」的
 * 在线索引,随房间销毁一起消失即可;按 `roomId` 会让**重建的同 id 房间**继承
 * 上一个世界的订单(判据夹具里同 id 的两个房间会互相污染)。`WeakMap` 同时
 * 保证它不随创建过的房间数增长。
 */
const FURNACE_CLAIMS = new WeakMap<object, Map<string, number>>();
/** `ctx.state` 不是对象的手搓桩(单测夹具)共用一份 —— 只有那些桩会走到这里。 */
const STUB_FURNACE_CLAIMS = new Map<string, number>();

/** 本房间(或桩)的预占表;懒建。 */
function claimLedgerOf(state: unknown): Map<string, number> {
  if (state === null || typeof state !== 'object') return STUB_FURNACE_CLAIMS;
  const key = state as object;
  let m = FURNACE_CLAIMS.get(key);
  if (m === undefined) {
    m = new Map<string, number>();
    FURNACE_CLAIMS.set(key, m);
  }
  return m;
}

/**
 * 这一单的键 = **世界侧那把键**(`ALCHEMY_LAB@ORDER:<订单号>`),由
 * `systems/idempotency.ts:settleKeyOf` 归一 —— 本文件不另写一份键格式。
 *
 * 没有 `orderId`(老报文)⇒ 退化成与 `WorldSim.brewAtFurnace` **同形**的派生键
 * `${actorId}#<材料升序>#<帧>`:同一炉同一帧重放会撞键(那正是要拒的),
 * 而换材料 / 换人 / 换帧不撞。
 */
export function furnaceClaimKeyOf(
  actorId: string,
  consumedIds: readonly number[],
  tick: number,
  orderId: string | null,
): string {
  const sorted = [...consumedIds].sort((a, b) => a - b);
  if (orderId === null) {
    return settleKeyOf(SETTLEMENT_ROOMS.ALCHEMY_LAB, { kind: 'ORDER', orderId: `${actorId}#${sorted.join('_')}#${tick}` })
      ?? `${ALCHEMY_LAB_ROOM_KEY}@ORDER:${actorId}#${sorted.join('_')}#${tick}`;
  }
  return settleKeyOf(SETTLEMENT_ROOMS.ALCHEMY_LAB, { kind: 'ORDER', orderId })
    ?? `${ALCHEMY_LAB_ROOM_KEY}@ORDER:${orderId}`;
}

/**
 * 占键(判重**前移**的那一步):第一次成功,第二次(以及之后每一次)拒。
 *
 * 与 `claimSettlement` 的语义逐条相同,但台账是**按房间实例**的在线索引
 * (见 `FURNACE_CLAIMS`):权威结算仍在世界侧 `brewAtFurnace`。
 * ⚠️ 失败(材料扣不动 / 产物收不下)必须 `releaseFurnaceOrder` —— 先占键再判成败
 * 会把订单永久锁死,那是比重复结算更坏的缺陷。
 */
export function claimFurnaceOrder(state: unknown, key: string, at: number): FurnaceClaim {
  const ledger = claimLedgerOf(state);
  const seenAt = ledger.get(key);
  if (seenAt !== undefined) {
    return {
      ok: false, key, seenAt,
      reason: `订单 ${key} 已在 ${seenAt} 结算过(重放)`,
    };
  }
  const t = Number.isFinite(at) ? at : 0;
  ledger.set(key, t);
  return { ok: true, key, at: t };
}

/** 释放预占(失败路径专用;**幂等**)。 */
export function releaseFurnaceOrder(state: unknown, key: string): void {
  claimLedgerOf(state).delete(key);
}

/** 丢弃本房间(实例)的全部预占 —— `RESET_WORLD` 成功回执路径调它。 */
export function forgetFurnaceClaims(state: unknown): void {
  claimLedgerOf(state).clear();
}

/** 当前 tick(与 `item_source.ts` 的令牌 tick 同一读数;桩没有 `state` ⇒ 0)。 */
function tickOf(ctx: ActionContext): number {
  const state = ctx.state as unknown as { meta?: { tick?: number } } | null | undefined;
  return typeof state?.meta?.tick === 'number' ? state.meta.tick : 0;
}

/**
 * 从 payload 里取**可选的**字符串维:缺项 / 非字符串 / 纯空白 ⇒ `null`。
 *
 * 不猜默认值(空串不是订单号),也不拒绝 —— 这是**可选**维,老报文没有它仍合法;
 * 缺省形态由世界侧给(见文件头)。
 */
function orderIdField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ⚠️ 修前这里有 `AlchemyPayload` / `stockField`:材料明细取自报文里的 `have`
   (客户端自报)。审计 P1 之后材料只从**按件权威账**读,两个符号已删。 */

/**
 * `USE_ALCHEMY_FURNACE`:站上炼金台,按内容层配方炼一份。
 *
 * 判序与回执(逐条对着判据):
 *   1 越权 ⇒ `PERMISSION`(`publicStorage`:MEMBER / GUEST 都无权),**零副作用**;
 *   2 没有世界源 ⇒ `NOT_IMPLEMENTED`(与 `material.ts` 同一契约:没有世界就没有
 *     可站的地面,更谈不上炼金台 —— 不能报成「你没权限」或「参数不对」);
 *   3 拿不到该玩家的房间归属(不在世界里 / 慢帧还没跑到)⇒ `INVALID`;
 *   4 当前房间不是 `ALCHEMY_LAB` ⇒ `INVALID`(失败路径**不动**背包);
 *   5 报文缺项 / 产物不在内容表 / 产物没有配方 ⇒ `INVALID`;
 *   6 配方不满足(材料不足)⇒ `INVALID`,**一个材料都不扣**;
 *   7 ★ **订单预占失败(同一单已结算过)⇒ `INVALID`,材料没扣、产物没发(判重前移)**;
 *   8 材料扣减被拒 ⇒ `INVALID`(预占已释放);
 *   9 产物收不下 ⇒ **退回材料** + `INVALID`(不吞;产物凭证已撤销,预占已释放);
 *  10 成功 ⇒ `OK` + `effect`(材料、产物、实际消耗明细)。
 */
export const useAlchemyFurnace: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* 1 权限闸:越权在此返回,且**未产生任何副作用**(背包一个数都没动)。 */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* 2 没有世界源 ⇒ 没有地面、没有房间可判。显式 NOT_IMPLEMENTED,
     不写成 `?.` 之后静默跳过(与 `materialsOf() === null` 同一条纪律)。 */
  if (ctx.host === null) {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: '本房间没有世界源 ⇒ 没有炼金室可确认(也就没有可站的炼金台)',
    };
  }

  /* 3/4 站位:只认世界源慢帧的房间判定,不自己识别房间。 */
  const port = ctx.host as unknown as AlchemyLabReadPort;
  const rows = port.lastRoomEffects;
  if (!Array.isArray(rows)) {
    return {
      ok: false, kind: 'INVALID',
      reason: '世界源不提供房间效果判定(lastRoomEffects)⇒ 无法确认是否站在炼金台上',
    };
  }
  const row = rows.find((r) => r.playerId === ctx.actorId);
  if (row === undefined) {
    return {
      ok: false, kind: 'INVALID',
      reason: '拿不到该玩家的房间归属(不在世界里,或房间效果慢帧还没跑到)⇒ 无法确认是否站在炼金台上',
    };
  }
  if (row.roomKey !== ALCHEMY_LAB_ROOM_KEY) {
    return {
      ok: false, kind: 'INVALID',
      reason: `只有站在炼金室(${ALCHEMY_LAB_ROOM_KEY})里才能用炼金台`
        + `(当前所在房间:${row.roomKey ?? '无'})`,
    };
  }

  /* 5 参数:缺项/形状不对一律显式拒绝(不猜默认值)。 */
  const itemId = numField(ctx.payload.itemId);
  if (itemId === null || !Number.isInteger(itemId)) {
    return { ok: false, kind: 'INVALID', reason: '需要 itemId(整数,内容表里的产物)' };
  }
  /* ★ WS-FND-96 请求号(**可选**维):报文给了就透传给世界侧当幂等键
     (`ALCHEMY_LAB@ORDER:<订单号>`);没给由世界侧退化成 `(actorId, 材料, 帧)`。
     它不是必填项 ⇒ 缺了也不拒(老报文的成功路径逐位不变),但**给了就必须原样用**。 */
  const orderId = orderIdField((ctx.payload as { orderId?: unknown }).orderId);
  /* ★ 材料明细只认**服务端按件账**(审计 P1):报文里的 `have` 不再参与结算。
     缺读口 ⇒ 显式 NOT_IMPLEMENTED(不退回"信客户端")。 */
  const stock = authoritativeStock(ctx);
  if (stock === null) return missingItemReadPort(ctx);

  /* 5' 产物必须在冻结内容表里、且有配方 —— 「编号空投」与「无配方产物」都拒。 */
  const def = ITEM_BY_ID.get(itemId);
  if (def === undefined) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }
  if (def.recipe === undefined && def.recipeAnyTag === undefined) {
    return { ok: false, kind: 'INVALID', reason: `#${itemId}(${def.name})没有配方,不是可炼制的产物` };
  }

  /* 6 配方匹配**只走内容层那一份**(`matchRecipeByTags`):先确定件、再逐个填留白槽。
     别在这里再写一遍配方表或留白语义 —— 那就是本仓反复点名的「两份实现」。 */
  const match = matchRecipeByTags(itemId, stock);
  if (!match.ok) {
    /* 材料不足是 **INVALID**(状态不对),**不是** PERMISSION。 */
    return { ok: false, kind: 'INVALID', reason: `材料不足:${match.reason ?? '配方不满足'}` };
  }

  /* 配方里写 0 的登记项(如 `523` 的 `163: 0`)不产生操作:delta 0 不是一次增减。 */
  const spendOps = Object.entries(match.consumed)
    .map(([k, n]) => ({ itemId: Number(k), delta: -n }))
    .filter((op) => op.delta !== 0);

  /* ── 7 ★ **订单预占(判重前移)**:先 claim 订单,再扣料/发放 ──
     审计 P2:修前的顺序是 `spend` → `gain` → `brewAtFurnace(orderId)`,判重发生在
     **发完东西之后** ⇒ 同一单重放时材料被扣、产物被发,**第二炉**已经出来了,
     只有 537 的陈列被世界侧拒掉(回执里那一句 `galleryNote`)。那正是「判重晚一步」。

     现在:预占在本步发生 —— 任何副作用之前。失败 ⇒ 直接拒且**零副作用**
     (材料没扣、产物没发、陈列没动)。预占成功后才扣料/发放;发放失败或产物
     收不下(材料已退回)时**释放预占** —— 那一单并没有结算,补齐条件后同单号仍可炼
     (与 `systems/idempotency.ts` 的纪律 2「只有成功才占键」同口径)。

     ⚠️ 权威结算仍在世界侧 `brewAtFurnace`(它按同一把键 `ALCHEMY_LAB@ORDER:<订单号>`
     记进 `roomSystemsState.settled`)—— 这里**不是第二张结算台账**,而是
     「在扣任何东西之前先确认这单没结算过」的那一步。键由 `settleKeyOf` 归一,
     两侧逐字同形(没有订单号时退化成与 `brewAtFurnace` 同形的
     `${actorId}#<材料升序>#<帧>`)。 */
  const tick = tickOf(ctx);
  const consumedIds = Object.entries(match.consumed)
    .filter(([, n]) => n > 0)
    .map(([k]) => Number(k))
    .sort((a, b) => a - b);
  const claimKey = furnaceClaimKeyOf(ctx.actorId, consumedIds, tick, orderId);
  const claim = claimFurnaceOrder(ctx.state, claimKey, tick);
  if (!claim.ok) {
    return {
      ok: false, kind: 'INVALID',
      reason: `${claim.reason} ⇒ 未消耗任何材料、未产出任何东西`,
    };
  }

  /* 8 **先扣材料**:整批 ops 一次提交 ⇒ 反作弊要么全过要么全拒,
     不存在「扣了一半」。消耗是负 delta,不需要 source(凭证链只约束产出侧)。 */
  const spend = ctx.applyInventory(ctx.actorId, { ops: spendOps });
  if (!spend.allowed) {
    /* 扣料都没成 ⇒ 这一单**没有结算** ⇒ 释放预占(否则一次失败把订单永久锁死)。 */
    releaseFurnaceOrder(ctx.state, claim.key);
    return {
      ok: false, kind: 'INVALID',
      reason: `材料扣减被拒(${spend.rejectCode ?? '被拒'})⇒ 未消耗任何材料`,
    };
  }

  /* 9 **再给产物**:先铸**绑定**凭证再 `applyInventory(+n, source)`,顺序反过来
     会被反作弊按「凭空产出」拒。产出件数取内容表的 `output`(`165` 是 1 → 3 件)。 */
  const made = Math.max(1, Math.trunc(def.output ?? 1));
  const src = bindItemSource(ctx, itemId, ItemSourcePurpose.CRAFT);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: made, source: src }] });
  if (!gain.allowed) {
    /* 10 事务性:产物收不下(容量 ⇒ `ITEM_OVERFLOW`)⇒ **退回材料**,不吞材料。
       退回是正 delta ⇒ **每一件**都要自己的绑定令牌(令牌绑 itemId,不能串用)。
       ★ 审计 P3:产物那张令牌已经登记却没用掉 ⇒ **显式撤销**,不让它留到 tick 末
       变成「服务端认可过的来源」。
       ★ 退回的返回值不再丢弃(与 `craft.ts` 同口径):退回失败必须写进回执。 */
    unbindItemSource(ctx, src);
    releaseFurnaceOrder(ctx.state, claim.key);
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

  /* ★ WS-FND-77 A-3:把这一炉记进**首创冠名陈列**(`systems/alchemy_lab.ts` 的
     `brewAndRecord`,经 `WorldSim.brewAtFurnace` 落到世界上),并把 537
     「全服奇物发现博物架」的陈列投影带进回执。

     ## 为什么在**成功之后**才调
     `brewAndRecord` 会在陈列馆里**留下一条记录**(即使材料被拒也只是返回
     `ok:false` 而不写入)。但本动作的纪律是「失败路径零副作用」——
     把「记账」放在产物入包成功之后,材料不足 / 背包满两种失败就都不会
     在 537 上留下"炼过但没出东西"的痕迹。

     ## 材料清单取哪里
     `match.consumed` 是**真的被扣掉的那几件**(含留白槽选中的那件);
     它同时也是 536 要求的「2~4 件材料」的权威来源 —— 不另抄一份报文。 */
  /* `consumedIds` 已在判重之前算好(见第 7 步的「订单预占」)—— 这里不再算第二遍:
     两次各自排序的写法会在留白槽选中项上分叉,而它正是 `brewAtFurnace` 的键的一维。 */
  /* `brewAtFurnace` 是 `WorldSaveHost` 的**可选**成员:老世界源没有它就
     如实标 `gallery: null`(而不是假装陈列已更新)。

     ★ WS-FND-96:把请求号**透传**下去(第三参 `opts.orderId`)—— 世界侧据此
     判重,同一单号重发 ⇒ `ok:false` + 理由,`craftCount` / 冠名 / 陈列一位不动。
     这一层**不做**判重(那会是第二份实现):键的归一与台账都在
     `systems/idempotency.ts` + `WorldSim.brewAtFurnace`。 */
  let certificate: Record<string, unknown> | null = null;
  let display: unknown = [];
  let brewReason: string | null = null;
  const brew = ctx.host.brewAtFurnace as FurnaceBrewWithOrder | undefined;
  if (typeof brew === 'function') {
    const out = brew.call(ctx.host, ctx.actorId, consumedIds, orderId === null ? undefined : { orderId });
    if (out.ok) {
      certificate = {
        ...(out.entry ?? {}),
        first: out.first === true,
      };
      display = out.display;
    } else {
      brewReason = out.reason ?? '炼金记录被拒';
      display = out.display;
    }
  } else {
    brewReason = '世界源没有炼金陈列能力(brewAtFurnace)⇒ 冠名未记录';
  }

  /* 回执:`consumed` 是**真的被扣掉的那几件**(含留白槽选中的那件),不是配方需求表。
     该字段是嵌套对象,`ActionOutcome['effect']` 的值类型装不下 ⇒ 显式窄化(见文件头)。
     `freeForge: false` 如实标明这一版不是 LLM 自由炼金。 */
  return {
    ok: true, kind: 'OK',
    effect: {
      itemId,
      produced: made,
      consumed: match.consumed,
      roomKey: ALCHEMY_LAB_ROOM_KEY,
      freeForge: false,
      /* 537 陈列:证书(本次首创/复刻的那一行)+ 完整投影 + 记账失败原因。 */
      certificate,
      gallery: display,
      galleryNote: brewReason,
    } as unknown as EffectRecord,
  };
};