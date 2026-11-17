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
 * 产出侧(破坏掉落 / 拾取 / 退回)必须先 `bindItemSource(…, itemId, purpose)`,否则
 * `checkInventory` 会按「凭空产出」拒(`FROM_NOTHING`)—— 那是设计好的闸,不是障碍。
 * 扣减侧(放置 / 丢弃)必须先问**按件权威读口**(`ownedItemCount`):`itemId` 是报文里
 * 客户端自报的,只靠总量守恒挡不住「丢一件任意 id 再捡起来」。
 *
 * ⚠️ 顺序纪律:**先动世界、再动背包**至少要有一侧是"先扣"的 —— 拾取时先扣地面、
 *   再进背包;放块时先扣背包、再写世界。两边都"先加"就会造出复制品。
 */
import { ITEM_LIST } from '../../../../shared/constants/items.ts';
/* ★ CR-27(P-04):件数放大复用**已有的概率双倍范式** —— `raid.ts` 的 `fnv1a`+`seededRoll`
   (`rng() < chance ? 翻倍 : 不翻`)与 `bosses/raid.ts:409` 的 35% 数量翻倍同源。
   **不另写一份 PRNG**(那会是第二份实现,迟早漂移)。 */
import { fnv1a, seededRoll } from '../../bosses/raid.ts';
/* ★ 审计 P0-2 + P1 的两道口:产出侧铸**绑定令牌**,扣减侧读**按件权威账**。
   见 `item_source.ts` 的文件头 —— 那里是"为什么",这里是"用在哪"。 */
import { ItemSourcePurpose } from '../anticheat.ts';
import { bindItemSource, missingItemReadPort, ownedItemCount } from './item_source.ts';
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
/* ═══════════════ 采集乘子的**件数放大规则**(CR-27 / P-04)═══════════════ */

/**
 * 采集乘子 → **件数翻倍概率**(CR-27 / P-04)。
 *
 * 手册 `602 伐木与采矿速度 +20%` 给的是**乘子**(`gatherMul = 1.2`),而一次 `breakBlock`
 * 只产出 **1** 件 —— 「+20% 采集速度」在没有采集时长的模型里没有可乘的量纲。
 * 裁决:**按概率翻倍件数**,复用已有的 `dropDoubleChance` 范式
 * (见 `bosses/raid.ts:409` 的 `rng() < 0.35 ⇒ 数量翻倍`):
 *
 *   chance = clamp(gatherMul − 1, 0, 1)   // 1.2 ⇒ 20%;1 ⇒ 0%(**不翻倍**)
 *   count  = roll < chance ? 2 : 1        // 期望件数 = 1 + chance = gatherMul
 *
 * ⇒ 乘子的**期望值**被如实表达(1.2 ⇒ 平均 1.2 件),而单次产出永远是整数件,
 *   不会出现「1.2 件」这种非整数库存。
 *
 * ⚠️ `gatherMul ≤ 1` 一律 0 概率 —— 中性值(1)与非法值(NaN/0/负数)都**不翻倍**;
 *   这是负对照要钉的那条(`tests/WS-FND-79` FND79-7/8)。
 */
export function gatherDoubleChance(gatherMul: number): number {
  if (!Number.isFinite(gatherMul) || gatherMul <= 1) return 0;
  return Math.min(1, gatherMul - 1);
}

/**
 * 按给定 `roll`(∈[0,1))结算这一次采集的件数:1 或 2。
 *
 * `roll` 由调用方**注入**,所以规则本身可被判据逐位钉住,不需要统计采样:
 * `gatherCountFor(1.2, 0.19) === 2`、`gatherCountFor(1.2, 0.20) === 1`
 * (边界是**严格小于**,与 `raid.ts:409` 的 `rng() < 0.35` 同口径)。
 */
export function gatherCountFor(gatherMul: number, roll: number): number {
  return roll < gatherDoubleChance(gatherMul) ? 2 : 1;
}

/**
 * 生产路径用的 `roll`:由 **(actorId, 格坐标, 拆下来的 objId, 房间 tick)** 确定性导出。
 *
 * 为什么不在这里 `Math.random()`:本仓的掉落一律走种子化 PRNG(与
 * `rollPersonalLoot` 的 `fnv1a(bossId|ownerId)` 同族),于是同一次拆块在重放/重连下
 * 结果一致;而把 tick 掺进种子又保证「换个格子、换个时刻重拆」会拿到新的 roll
 * —— 不能靠原地反复放块把 20% 固定成必中。
 */
function gatherRollFor(actorId: string, x: number, y: number, objId: number, tick: number): number {
  return seededRoll(fnv1a(`${actorId}|${x}|${y}|${objId}|${tick}`))();
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
  /* ★ 按件权威读口(审计 P1):`itemId` 是**客户端自报**的,总量守恒兜不住它
     —— 「有没有这一件」只能由服务端账本回答。缺读口 ⇒ 显式 NOT_IMPLEMENTED,
     不退回「信客户端」。到这里**世界与背包都还没动**(零副作用)。 */
  const owned = ownedItemCount(ctx, itemId);
  if (owned === null) return missingItemReadPort(ctx);
  if (owned < 1) {
    return { ok: false, kind: 'INVALID', reason: `背包里没有 ${itemId}(服务端账面 ${owned} 件)` };
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
    /* 扣了东西却没放下 ⇒ **退回**。退回是正 delta ⇒ 必须先铸**绑定**凭证
       (绑定 itemId:它只换回这一件,不能拿去铸别的)。 */
    const src = bindItemSource(ctx, itemId, ItemSourcePurpose.PLACE_REFUND);
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
  /* ★ CR-27(P-04):件数放大在此结算 —— 世界源只给**乘子**(`gatherMul`,1 = 中性),
     翻倍与否由本层按概率决定(`dropDoubleChance` 范式,见文件上方
     `gatherDoubleChance` / `gatherCountFor`)。
     种子 = (actorId, 格坐标, objId, 房间 tick):同一次拆块可复现,换格/换时刻换 roll。 */
  const gatherMul = r.gatherMul ?? 1;
  const tick = ctx.state.meta.tick;
  const count = gatherCountFor(gatherMul, gatherRollFor(ctx.actorId, x, y, r.objId, tick));
  /* 拆下来的东西先铸**绑定**凭证再入背包;背包满就落回**原地** —— 不凭空销毁。
     `r.objId` 来自物质层(服务端权威),不是报文里的值 ⇒ 令牌绑的就是这一件。 */
  const src = bindItemSource(ctx, r.objId, ItemSourcePurpose.GATHER);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId: r.objId, delta: count, source: src }] });
  /* `gatherMul` **只在世界源给出非中性值**时才进回执(1 = 中性 ⇒ 键缺席,与
     `WorldArchiveReceipt.trim` 同一纪律:键的存在本身是可判定事实)。
     写成可变对象再按需加键:`effect` 的值域是 `string|number|boolean`,
     用条件展开会把联合类型带进去(TS2322)。
     `gained` / `dropped` 报**实际件数**(1 或 2)—— 旧回执的 1 是它的特例,不是另一个字段。 */
  const effect: Record<string, string | number | boolean> = {
    x, y, objId: r.objId, gained: gain.allowed ? count : 0,
  };
  if (r.gatherMul !== undefined && r.gatherMul !== 1) effect.gatherMul = r.gatherMul;
  if (gain.allowed) return { ok: true, kind: 'OK', effect };
  mat.dropItem(x, y, r.objId, count);
  effect.dropped = count;
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
  /* ★ 按件权威读口(审计 P1 的另一半):丢的是**哪一件**由服务端账本回答。
     修前只做总量守恒 ⇒ 「丢一件任意 id」再捡起来 = 背包任意换 id。
     拒绝时**世界与背包都没动**。 */
  const owned = ownedItemCount(ctx, itemId);
  if (owned === null) return missingItemReadPort(ctx);
  if (owned < count) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里不够 ${count} 个 ${itemId}(服务端账面 ${owned} 件)`,
    };
  }
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
  /* 地上那件是**物质层**给的(`takeGroundItemNear` 已先扣掉它),凭证绑的就是它。 */
  const src = bindItemSource(ctx, itemId, ItemSourcePurpose.PICKUP);
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