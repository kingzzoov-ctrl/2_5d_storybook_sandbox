/**
 * `CRAFT` —— **通用合成**:客户端说「按某个产物 itemId 合成一份」,服务端照配方结算。
 *
 * 接线前它是 `notImplemented(...)`(`docs/TASK-96-action-landing-gaps.md` 第三节:
 * 「`cooking.ts` 有 `cookSoup`(料理站),但**通用合成**没有入口:缺「配方 →
 * 材料扣减 → 产物」的事务性写入」)。本文件就是那条写入,**只改本文件** ——
 * `action_table.ts` / `room.ts` 一个字都不用动(尚未接线的动作各占一个模块)。
 *
 * ## 报文契约(与 `ActionPayload` 的既有字段并列)
 *
 * ```ts
 * { itemId: number, have: Record<number, number> }
 * ```
 *
 *   · `itemId` = 要合成的**产物**(必须在冻结内容表里、且有配方);
 *   · `have`   = 客户端**背包明细**(`物品 id → 数量`)。
 *
 * ⚠️ `have` 只能由客户端给:**本仓当前没有服务端按物品明细的读口**。
 *   `RoomRuntime.authoritativeItemTotal()` 只给**总量**(读 db 的 `totalItemsOf`),
 *   `WorldSim.inventoryDetailOf()` 如实返回 `null`(模拟层不持有背包明细),
 *   而 `ActionContext` 既不暴露 `db` 也不暴露该读口。⇒ 客户端只说「我有什么」,
 *   **配方怎么扣、扣几件仍全由内容层决定**(见下);能扣多少则由权威总量兜底:
 *   扣减整批走 `ctx.applyInventory`,它按 `beforeTotal` 量守恒,声明得比实际多
 *   会被反作弊按 `ITEM_NEGATIVE` 整批拒(`tests/WS-FND-25` FND25-7 钉这一条)。
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
 * 产出侧必须**先** `ctx.grantItemSource` **再** `applyInventory(+n, source)`,
 * 否则 `checkInventory` 会按「凭空产出」拒(`FROM_NOTHING`)—— 那是设计好的闸。
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
 */
import { ITEM_BY_ID, matchRecipeByTags } from '../../../../shared/constants/items.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/** `effect` 的声明形状:`ActionOutcome['effect']` 的值只允许基本类型(见文件头)。 */
type EffectRecord = NonNullable<ActionOutcome['effect']>;

/**
 * 本动作的报文键。
 *
 * `ActionPayload`(`room.ts`)只声明了**别的**动作用到的字段(`x` / `y` / `itemId` /
 * `count` / ...),而这条通道本就是泛型的:`ws_server.ts` 把客户端 JSON 原样递进来。
 * ⇒ 在**本文件**局部读取自己的键,`room.ts` 一个字不用动(它不在本文件的写域内)。
 */
type CraftPayload = ActionPayload & { have?: unknown };

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 取出「背包明细」(`物品 id → 数量`)。
 *
 * 形状不对就返回 `null`,由调用方给出可读的 `INVALID` —— 不猜默认值
 * (把缺失当成空背包会把「报文写错」与「真的没材料」混成同一个原因)。
 */
function stockField(v: unknown): Record<number, number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<number, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isInteger(id)) return null;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[id] = n;
  }
  return out;
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
  const stock = stockField((ctx.payload as CraftPayload).have);
  if (stock === null) {
    return {
      ok: false, kind: 'INVALID',
      reason: '需要 have(背包明细:{ "物品id": 数量 })—— 服务端没有按物品明细的读口,见本文件头',
    };
  }

  /* 3 产物必须在冻结内容表里、且有配方 —— 「编号空投」与「无配方产物」都拒。 */
  const def = ITEM_BY_ID.get(itemId);
  if (def === undefined) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }
  if (def.recipe === undefined && def.recipeAnyTag === undefined) {
    return { ok: false, kind: 'INVALID', reason: `#${itemId}(${def.name})没有配方,不是可合成产物` };
  }

  /* 4 配方匹配**只走内容层那一份**(`matchRecipeByTags`):先确定件、再逐个填留白槽。
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

  /* 5 **先扣材料**:整批 ops 一次提交 ⇒ 反作弊要么全过要么全拒,不存在「扣了一半」。
     消耗是负 delta,不需要 source(凭证链只约束产出侧)。 */
  const spend = ctx.applyInventory(ctx.actorId, { ops: spendOps });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `材料扣减被拒(${spend.rejectCode ?? '被拒'})⇒ 未消耗任何材料`,
    };
  }

  /* 6 **再给产物**:先 `grantItemSource` 再 `applyInventory(+n, source)`,顺序反过来
     会被反作弊按「凭空产出」拒。产出件数取内容表的 `output`(`151` 是 1 材料 → 2 件)。 */
  const made = Math.max(1, Math.trunc(def.output ?? 1));
  const src = `craft:${itemId}`;
  ctx.grantItemSource(ctx.actorId, src);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: made, source: src }] });
  if (!gain.allowed) {
    /* 7 事务性:产物收不下(容量 ⇒ `ITEM_OVERFLOW`)⇒ **退回材料**,不吞材料。
       退回是正 delta ⇒ 同样必须先给凭证。 */
    const refundSrc = `craft-refund:${itemId}`;
    ctx.grantItemSource(ctx.actorId, refundSrc);
    const refund = ctx.applyInventory(ctx.actorId, {
      ops: spendOps.map((op) => ({ itemId: op.itemId, delta: -op.delta, source: refundSrc })),
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
