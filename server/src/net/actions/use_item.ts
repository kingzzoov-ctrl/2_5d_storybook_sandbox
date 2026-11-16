/**
 * `USE_ITEM` —— **使用一件道具**(吃 / 投掷)。
 *
 * ## 它为什么存在
 *
 * 733 羽毛笔、227 泡泡水枪、料理 buff 三者的**函数与判据都已有**
 * (`combat/revive.ts` 的 `featherRevive` / `bubbleGunHit`、`combat/cooking.ts` 的 buff 链路),
 * 但玩家触发不到 —— 缺的正是这个动词(`docs/TASK-99-use-item-verb.md`)。
 *
 * ## 执序:**先扣后生效**(不是"先生效后扣",也不是"先扣后退")
 *
 * 1 权限闸(**第一行**,拒绝路径零副作用);
 * 2 报文校验:`itemId` 必须是正整数,`targetId` 与 `targetDeviceId` **不许同时给**(见下);
 * 3 **先扣 1 件**(`applyInventory` 的负 delta)—— 扣不动 ⇒ 世界侧**根本没跑**;
 * 4 交给世界:`ctx.host.useItem(...)` —— 语义判断**只在世界侧一处**(它在 `world_sim.ts`);
 * 5 回执:成功带 `effect`(世界侧给的标量表 + `consumed`)。
 *
 * ## ⚠️ 为什么是"先扣后生效",以及它**曾经**是反的
 *
 * 第一版是"先生效后扣":扣失败时世界侧的改动**已经落地** ⇒ 没有 733 的玩家也能无限救人、
 * 没有料理也能无限叠 `hpFlat`(审查 A3)。改成先扣之后,白嫖被堵在门口。
 * 反过来(扣成功而世界侧未生效 / 无需扣)⇒ **退回**:补偿走本仓既定的
 * `grantItemSource` + 正向 ops 机制,不是就地撤销。
 *
 * ⚠️ 本文**上一版**写着「执序:判定 → 扣减 → 写回(**不是**"先扣后退")」并解释
 *   "为什么**不**照抄 `placeBlock` 的先扣后退" —— 那是 A3 之前的实现,与现在的代码**相反**。
 *   现在的顺序**就是**先扣后退(扣成功 → 世界侧说没生效 ⇒ 退回),区别在于:
 *   退回是**异常路径**(世界侧拒绝),不是正常路径的第二步。
 *
 * ## 两种目标(`targetId` / `targetDeviceId`)
 *
 * `targetId` = **玩家**(救队友 / 困人 / 吃 buff 的对象);`targetDeviceId` = **器件**
 * (227 水枪 / 212 大铁铲 浇灭料理站炉火 —— C3 的灭火半边)。
 * 二者**互斥**:**同时给出 ⇒ 报文层直接拒(`INVALID`),不进世界**。
 * (世界侧另有一道兜底:见到 `targetDeviceId` 就不再读 `targetId`。两道都要 ——
 *  前者防"客户端悄悄多报一个字段改变语义",后者防"将来有人只改一处"。)
 *
 * ## ⚠️ 不校验"该玩家真的有这一件"
 *
 * 服务端今天**没有按件背包明细读口**(`PlayerState` 只有 `heldItemId`),
 * 所以 `itemId` 是客户端自报的。扣减走 `applyInventory`(总量守恒 + 凭证链):
 * 总量不足会被反作弊整批拒(与 `craft.ts` 同款取舍,那边的 `have` 也是自报)。
 * 真要做到"按件权威",先补读口 —— 见 `docs/TASK-99-use-item-verb.md` §8。
 */
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionHandler } from './types.ts';

/** 本动作的报文(`itemId` / `targetId` 已在 `ActionPayload` 里声明,这里只做窄化)。 */
type UseItemPayload = ActionPayload & { itemId?: unknown; targetId?: unknown; targetDeviceId?: unknown };

/** 取正整数;不是 ⇒ `null`(不做字符串转换,不猜默认值)。 */
function positiveInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  return v > 0 ? v : null;
}

export const useItem: ActionHandler = (ctx): ActionOutcome => {
  /* 1 权限闸:第一行。拒绝路径不碰世界、不碰背包。 */
  const verdict = ctx.authorize(ctx.actorId, ctx.action);
  if (!verdict.allowed) {
    return ctx.classifyFailure(ctx.actorId, ctx.action, verdict.reason);
  }

  /* 2 报文:`itemId` 必填正整数。`targetId` 缺 ⇒ 世界侧默认作用于自己(吃料理就是这种)。 */
  const p = ctx.payload as UseItemPayload;
  const itemId = positiveInt(p.itemId);
  if (itemId === null) {
    return { ok: false, kind: 'INVALID', reason: `${ctx.action} 需要 itemId(正整数)` };
  }
  const targetId = typeof p.targetId === 'string' && p.targetId !== '' ? p.targetId : undefined;
  /* 器件目标:报了就必须是**正整数**(器件在内容表里是物件 id)。值不合法 ⇒ 当场拒,
     不退回"对玩家用" —— 那是把报文含义悄悄改掉,比报错更难查。 */
  const targetDeviceId = p.targetDeviceId === undefined ? undefined : positiveInt(p.targetDeviceId);
  if (p.targetDeviceId !== undefined && targetDeviceId === null) {
    return { ok: false, kind: 'INVALID', reason: `${ctx.action} 的 targetDeviceId 需要正整数(器件 id)` };
  }
  /* ★ 两个目标**不许同时给**(审查:`use_item.ts` 的互斥此前只在世界侧按分支先后"静默忽略"
     `targetId`)。报文层直接拒:客户端多报一个字段就能改变语义,是"静默忽略"最坏的一类 ——
     请求里明写着两个意图,服务端挑一个执行,回执看起来却是成功的。
     ⇒ 拒绝理由要**指认字段**,让调用方能改;而且要**在扣道具之前**(拒绝路径不碰背包)。 */
  if (targetId !== undefined && targetDeviceId !== undefined) {
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 的 targetId 与 targetDeviceId 互斥(只能选一个)`,
    };
  }

  /* 3 没有世界源 ⇒ 显式说出来(与 `material.ts` 同一契约,不静默成功)。 */
  const host = ctx.host;
  if (host === null || typeof host.useItem !== 'function') {
    return {
      ok: false,
      kind: 'NOT_IMPLEMENTED',
      reason: `${ctx.action} 的世界侧不支持使用道具`,
    };
  }

  /* ★ **先扣后生效**(审查 A3:此前是"先生效后扣",扣失败时世界侧的改动**已经落地**
     ⇒ 没有 733 的玩家也能无限救人、没有料理也能无限叠 `hpFlat`)。
     扣不动 ⇒ 世界侧**根本没跑** —— 白嫖被堵在门口,不需要"撤销"这个第二份实现。
     反过来(扣成功而世界侧未生效/无需扣)⇒ **退回**,补偿走本仓既定的
     `grantItemSource` + 正向 ops 机制(见 `types.ts` 的契约),不是特例。 */
  const take = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] });
  if (!take.allowed) {
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 没有这件道具(${take.rejectCode ?? '未知'})`,
    };
  }

  /** 把刚扣掉的那一件退回去(扣成功但本次不该扣 / 世界侧没生效)。 */
  const refund = (): void => {
    const src = `use-item-refund:${ctx.actorId}`;
    ctx.grantItemSource(ctx.actorId, src); /* 必须先授予凭证,再做正向 ops */
    ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: 1, source: src }] });
  };

  /* 缺省字段**不塞 `undefined`**:世界侧用 `in` 语义判"这次有没有给器件目标"。 */
  const req: { itemId: number; targetId?: string; targetDeviceId?: number } = { itemId };
  if (targetId !== undefined) req.targetId = targetId;
  if (targetDeviceId !== undefined && targetDeviceId !== null) req.targetDeviceId = targetDeviceId;
  const out = host.useItem(ctx.actorId, req);
  if (!out.applied) {
    /* 世界侧说"没生效" ⇒ 退回刚才那一扣。733 超距走的就是这条。 */
    refund();
    return { ok: false, kind: 'INVALID', reason: `${ctx.action} 未生效:${out.reason}(道具已退回)` };
  }

  if (!out.consume) {
    /* 世界侧承认生效但**不需要扣**(例如只读类的确认)⇒ 同样退回。 */
    refund();
    return {
      ok: true,
      kind: 'OK',
      effect: { ...(out.effect ?? {}), itemId, consumed: 0 },
    };
  }

  return {
    ok: true,
    kind: 'OK',
    effect: { ...(out.effect ?? {}), itemId, consumed: 1 },
  };
};