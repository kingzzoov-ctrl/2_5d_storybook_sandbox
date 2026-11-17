/**
 * 玩家语义的**物质层**:`PLACE_BLOCK` / `BREAK_BLOCK` / `DROP_ITEM` / `PICKUP_ITEM`。
 *
 * 四个处理器体逐字搬自 `RoomRuntime.dispatchAction` 的 `switch`
 * (仅 `this.` → `ctx.`、`payload` → `ctx.payload`;理由文本与 `effect` 字段名一个字都没动)。
 * `tests/WS-FND-20`(11 条:双侧账 / 退回 / 守恒)与 `tests/WS-FND-21`(真 socket 端到端)
 * 钉的是那些字面内容与**世界侧真的变了**。
 *
 * ## 接线时三件事必须**在同一处**做,否则就是本仓反复记的那种半截事务
 *
 *   1 **权限闸**写在这里,不写在世界方法里 —— 世界方法没有"谁"这个参数
 *     (与 `CLOSE_ROOM` 同一例外,理由见 `admin.ts`);
 *   2 背包**真的**增减一次,且走 `ctx.applyInventory` —— 反作弊的总量守恒与凭证链
 *     都在那条路上,绕过它 = 绕过了本仓唯一的物品真值来源;
 *   3 世界侧**真的**变了;失败时必须**退回**背包那一件(不做"扣了东西却没放下")。
 *
 * 产出侧(破坏掉落 / 拾取)必须先 `ctx.grantItemSource`,否则 `checkInventory` 会按
 * "凭空产出"拒(`FROM_NOTHING`)—— 那是设计好的闸,不是障碍。
 *
 * ⚠️ 顺序纪律:**先动世界、再动背包**至少要有一侧是"先扣"的 —— 拾取时先扣地面、
 *   再进背包;放块时先扣背包、再写世界。两边都"先加"就会造出复制品。
 */
import { ITEM_LIST } from '../../../../shared/constants/items.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * 拾取半径(格)。
 *
 * 取值理由:与技术无关,是**手感**——1 格要求玩家精确站到那一格上,
 * 3 格会出现"隔着墙把手伸过去捡"。2 格与"站在旁边"的直觉一致。
 * 它与近战 `reach` **无关**:拾取不看朝向、也不看武器。
 */
const PICKUP_RADIUS = 2;

/** 冻结内容表里的合法物品 id。用于拒绝"编号空投"(不在表里的 id 一律不认)。 */
const ITEM_ID_SET: ReadonlySet<number> = new Set(ITEM_LIST.map((i) => i.id));

/** 从 action payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `PLACE_BLOCK`:放块。先扣背包,世界拒绝则**退回**那一件。 */
export const placeBlock: ActionHandler = (ctx: ActionContext) => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
  const x = numField(ctx.payload.x);
  const y = numField(ctx.payload.y);
  const itemId = numField(ctx.payload.itemId);
  if (x === null || y === null || itemId === null) {
    return { ok: false, kind: 'INVALID', reason: '需要 x / y / itemId(数字)' };
  }
  if (!ITEM_ID_SET.has(itemId)) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }
  const mat = ctx.materialsOf();
  if (mat === null) {
    return { ok: false, kind: 'NOT_IMPLEMENTED', reason: '世界源没有物质层 ⇒ 没有世界可放块' };
  }
  /* 先扣背包:没这一件会被反作弊按 NEGATIVE 拒 ⇒ 不可能"凭空空投一个块"。 */
  const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有可放置的 ${itemId}(${spend.rejectCode ?? '被拒'})`,
    };
  }
  const r = mat.placeBlock(x, y, itemId);
  if (!r.ok) {
    /* 扣了东西却没放下 ⇒ **退回**(带凭证,见本文件开头)。 */
    const src = `place-refund:${x},${y}`;
    ctx.grantItemSource(ctx.actorId, src);
    ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: 1, source: src }] });
    return { ok: false, kind: 'INVALID', reason: r.reason };
  }
  return { ok: true, kind: 'OK', effect: { x, y, itemId } };
};

/** `BREAK_BLOCK`:拆块。拆下来的东西先给凭证再入背包;背包满就落回**原地**,不凭空销毁。 */
/* ⚠️ 这里显式写返回类型(`ActionOutcome`):本处理器有**两个** `kind: 'OK'` 的返回
   分支(`gained: 1` 与 `gained: 0, dropped: 1`),若让 TS 去推,会把两支并成一个
   带 `dropped?: undefined` 的联合,而 `effect` 的值类型不含 `undefined` ⇒ 类型报错。
   显式返回类型让**每一支**各自对 `ActionOutcome` 校验(与拆分前 `switch` 里的情形一致)。 */
export const breakBlock: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
  const x = numField(ctx.payload.x);
  const y = numField(ctx.payload.y);
  if (x === null || y === null) return { ok: false, kind: 'INVALID', reason: '需要 x / y(数字)' };
  const mat = ctx.materialsOf();
  if (mat === null) {
    return { ok: false, kind: 'NOT_IMPLEMENTED', reason: '世界源没有物质层 ⇒ 没有世界可拆' };
  }
  /* ★ WS-FND-77(W 线 `gatherMul`):把**发起者**交给物质层 ——
     采集乘子(602「伐木与采矿速度 +20%」)只有知道是谁在采集才归属得出去。
     不传时的旧行为由 `MaterialApi.breakBlock` 的可选参数保证(回执不多键)。 */
  const r = mat.breakBlock(x, y, ctx.actorId);
  if (!r.ok) return { ok: false, kind: 'INVALID', reason: r.reason };
  /* 拆下来的东西先给凭证再入背包;背包满就落回**原地** —— 不凭空销毁。 */
  const src = `break:${x},${y}:${r.objId}`;
  ctx.grantItemSource(ctx.actorId, src);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId: r.objId, delta: 1, source: src }] });
  /* `gatherMul` **只在世界源给出非中性值**时才进回执(1 = 中性 ⇒ 键缺席,与
     `WorldArchiveReceipt.trim` 同一纪律:键的存在本身是可判定事实)。
     写成可变对象再按需加键:`effect` 的值域是 `string|number|boolean`,
     用条件展开会把联合类型带进去(TS2322)。 */
  const effect: Record<string, string | number | boolean> = {
    x, y, objId: r.objId, gained: gain.allowed ? 1 : 0,
  };
  if (r.gatherMul !== undefined && r.gatherMul !== 1) effect.gatherMul = r.gatherMul;
  if (gain.allowed) return { ok: true, kind: 'OK', effect };
  mat.dropItem(x, y, r.objId, 1);
  effect.dropped = 1;
  effect.note = `背包收不下(${gain.rejectCode ?? '被拒'})⇒ 掉在原地`;
  return { ok: true, kind: 'OK', effect };
};

/** `DROP_ITEM`:丢东西。落点取**权威位置**,不取客户端报的坐标。 */
export const dropItem: ActionHandler = (ctx: ActionContext) => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
  const itemId = numField(ctx.payload.itemId);
  const count = numField(ctx.payload.count) ?? 1;
  if (itemId === null) return { ok: false, kind: 'INVALID', reason: '需要 itemId(数字)' };
  if (!Number.isInteger(count) || count <= 0) {
    return { ok: false, kind: 'INVALID', reason: `count 必须是正整数(实测 ${ctx.payload.count})` };
  }
  const mat = ctx.materialsOf();
  if (mat === null) {
    return { ok: false, kind: 'NOT_IMPLEMENTED', reason: '世界源没有物质层' };
  }
  /* ⚠️ 落点取**权威位置**,不取客户端报的坐标:否则玩家可以把东西丢到地图另一头。 */
  const at = ctx.hostPositionOf(ctx.actorId);
  if (at === null) return { ok: false, kind: 'INVALID', reason: '拿不到该玩家的权威位置(不在世界里)' };
  const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -count }] });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里不够 ${count} 个 ${itemId}(${spend.rejectCode ?? '被拒'})`,
    };
  }
  mat.dropItem(at.x, at.y, itemId, count);
  return { ok: true, kind: 'OK', effect: { itemId, count, x: at.x, y: at.y } };
};

/** `PICKUP_ITEM`:捡东西。**先扣地面再进背包**(反过来会造复制品);附近没有就拒。 */
export const pickupItem: ActionHandler = (ctx: ActionContext) => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
  const itemId = numField(ctx.payload.itemId);
  if (itemId === null) return { ok: false, kind: 'INVALID', reason: '需要 itemId(数字)' };
  const mat = ctx.materialsOf();
  if (mat === null) {
    return { ok: false, kind: 'NOT_IMPLEMENTED', reason: '世界源没有物质层' };
  }
  const at = ctx.hostPositionOf(ctx.actorId);
  if (at === null) return { ok: false, kind: 'INVALID', reason: '拿不到该玩家的权威位置(不在世界里)' };
  /* **先扣地面**:没扣到就不要动背包 —— 反过来会造出
     "背包 +1 而地上那件还在"的复制品。 */
  if (!mat.takeGroundItemNear(at.x, at.y, itemId, PICKUP_RADIUS)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `附近 ${PICKUP_RADIUS} 格内没有 ${itemId}(地上那件可能已被别人捡走)`,
    };
  }
  const src = `pickup:${at.x},${at.y}:${itemId}`;
  ctx.grantItemSource(ctx.actorId, src);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: 1, source: src }] });
  if (!gain.allowed) {
    /* 背包满了 ⇒ **放回去**(不能把玩家已经捡起来的东西吞掉)。 */
    mat.dropItem(at.x, at.y, itemId, 1);
    return {
      ok: false, kind: 'INVALID',
      reason: `背包收不下(${gain.rejectCode ?? '被拒'})⇒ 已放回原地`,
    };
  }
  return { ok: true, kind: 'OK', effect: { itemId, x: at.x, y: at.y } };
};