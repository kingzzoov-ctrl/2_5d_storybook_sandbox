/**
 * `GATHER` —— **采集**(对「可采集物」执行的第二个物质层动作)。
 *
 * ## 为什么它和 `BREAK_BLOCK` 是两件事(不是重复实现)
 *
 * ```text
 * BREAK_BLOCK  权限位 build;对**任意**格上的物件生效;产出 = 那个物件自身
 * GATHER       权限位 baseline;只对**内容表里的可采集物**生效;
 *              前置 = 距离 + 工具(见下);产出 = 那个资源自身
 * ```
 * 差别是**玩家语义**上的:`GUEST`(游客)没有 `build` 位 ⇒ 今天他一件自然资源都拿不到
 * (手册 §7.1 的 GUEST 是「能玩能捡」)。采集把「从世界里取自然资源」变成一条
 * **基础生存动作**,于是「能捡」这句话在自然资源上才成立。
 *
 * ⚠️ 世界侧**没有**第二条写口:扣减走 `MaterialApi.breakBlock`(格上物件的唯一
 *   清除点,连 `gatherMul` 的归属口都是它给的)。本文件只做**判定**(权限 / 可采集
 *   性 / 距离 / 工具),不重写一遍「怎么把物件从格子上拿掉」——那会是第二份实现。
 *
 * ## 可采集物**以内容表为准**(不发明名单)
 *
 * ```text
 * objId 必须在冻结内容表里(`ITEM_BY_ID`)
 * 且它的 category === ItemCategory.NATURAL
 *    ≡ §3.1「自然采集与奇幻矿物资源表」(101~130)
 * ```
 * `category` 是**内容表自己的字段**(`shared/types/entities.ts` 的 `ItemDef`),
 * 不是本文件另立的一张 id 名单 —— 内容表加一件自然资源,这里自动认得。
 *
 * ## 工具前置:也**从内容表派生**
 *
 * 自然资源的词条(`tags`)里若有与**生产工具表**(§3.3,`category === TOOL`)共享的词条,
 * 那个词条就是它要求的工具族:
 * ```text
 * 101 暖松原木 tags ['木材','燃料','形态:长柄']   ∩ 工具族词条 = '木材' ⇒ 要一件带『木材』的工具(201 斧)
 * 106 云母圆石 tags ['石材','坚硬','钝器']        ∩ 工具族词条 = '石材' ⇒ 要一件带『石材』的工具(203 镐)
 * 121 露水甜莓 tags ['水果','香甜','恢复']        ∩ 工具族词条 = ∅     ⇒ **徒手**可采
 * ```
 * ⇒ 工具族词条集 = `TOOL_TAGS`(从内容表 §3.3 的条目**算出来**,不是手抄)。
 *   「持有」的判据是**按件权威账**(`ownedItemIds`:回执/扣减走上来的服务端账本),
 *   不是客户端自报。
 *
 * ## 产出与 `gatherMul`
 *
 * 一次采集产出 **1 件**(`objId` 自身);`gatherMul`(602「伐木与采矿速度 +20%」)
 * 的件数放大复用 `material.ts` 里那条**唯一**的概率翻倍规则
 * (`gatherDoubleChance` / `gatherCountFor` / `gatherRollFor`)——本文件不另写一份 PRNG
 * 或第二条放大口径(那样两处迟早漂)。背包收不下 ⇒ 落回**原地**(不凭空销毁)。
 *
 * ## 失败一律**零副作用**
 *
 * 下面每一条拒绝都发生在 `breakBlock` / `applyInventory` **之前**,所以格子上那一件
 * 与背包都一个字节都没动:越权(`PERMISSION`)/ 载荷不是数(`INVALID`)/ 没有物质层
 * (`NOT_IMPLEMENTED`)/ 那一格不是可采集物(`INVALID`,含空格、世界外、非自然资源)/
 * 拿不到权威位置(`INVALID`)/ 太远(`INVALID`)/ 缺工具(`INVALID`)/ 缺按件读口
 * (`NOT_IMPLEMENTED`,fail-closed —— 不退回「信客户端」)。
 */
import { ITEM_BY_ID, ITEM_LIST } from '../../../../shared/constants/items.ts';
import { ItemCategory } from '../../../../shared/types/entities.ts';
import { ItemSourcePurpose } from '../anticheat.ts';
import {
  bindItemSource,
  missingItemReadPort,
  ownedItemIds,
  unbindItemSource,
} from './item_source.ts';
/* ★ 件数放大只认这一个出处(与 `BREAK_BLOCK` 同一条规则,不另写一份)。 */
import { gatherCountFor, gatherRollFor } from './material.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * 采集半径(格)。
 *
 * 取值理由(与技术无关,是**手感** + 与既有口径对齐):
 * ```text
 * 拾取 = 2 格(`material.ts:PICKUP_RADIUS`):弯腰捡**脚下附近**的东西
 * 采集 = 3 格                             :站着**面向**一棵树/一块矿脉就够
 * ```
 * 它比拾取宽 1 格是因为「采集」在玩家直觉里是**隔着一格看着的东西**,
 * 而拾取是脚下的东西;3 格仍小于近战 `reach` 的两倍,不会出现「隔着墙把树砍了」
 * (超距时拒因里给出实测距离,玩家能据此走两步)。
 */
export const GATHER_RADIUS = 3;

/** 可采集物的类别(**内容表字段**,不是本文件另立的 id 名单)。 */
export const GATHERABLE_CATEGORY = ItemCategory.NATURAL;

/**
 * **工具族词条** —— 从生产工具表(§3.3)的条目标签**算出来**。
 *
 * 为什么要算而不是手抄:「哪些词条是工具族」本身就是内容表的性质(§3.3 的 18 件
 * 各带自己的词条),抄一份迟早与内容表漂(新加一件斧头,抄来的集合不会变)。
 */
export const TOOL_TAGS: readonly string[] = [
  ...new Set(ITEM_LIST.filter((i) => i.category === ItemCategory.TOOL).flatMap((i) => i.tags)),
].sort();

/**
 * 某一格的物件是不是**可采集物**(内容表判定)。
 *
 * 返回 `name` 只为回执/理由可读(玩家读得到「暖松原木」而不是「101」)。
 */
export function gatherableOf(objId: number): { ok: true; name: string } | { ok: false; reason: string } {
  const def = ITEM_BY_ID.get(objId);
  if (def === undefined) return { ok: false, reason: `物件 ${objId} 不在冻结内容表里(不认编号空投)` };
  if (def.category !== GATHERABLE_CATEGORY) {
    return {
      ok: false,
      reason: `「${def.name}」不是可采集物(内容表类别 ${def.category},采集只认 §3.1 自然资源)`,
    };
  }
  return { ok: true, name: def.name };
}

/**
 * 该资源要求的**工具族词条**;`null` = **徒手可采**。
 *
 * 判据:资源的 `tags` 与 `TOOL_TAGS` 的**第一个交集**(内容表顺序,确定性)。
 */
export function toolTagFor(objId: number): string | null {
  const tags = ITEM_BY_ID.get(objId)?.tags;
  if (tags === undefined) return null;
  for (const t of tags) if (TOOL_TAGS.includes(t)) return t;
  return null;
}

/** 该玩家**持有**一件带 `tag` 的**工具**(按件权威账;`null` = 读口缺失)。 */
function ownsToolTagged(ctx: ActionContext, tag: string): boolean | null {
  const ids = ownedItemIds(ctx);
  if (ids === null) return null;
  for (const id of ids) {
    const def = ITEM_BY_ID.get(id);
    if (def === undefined) continue;
    if (def.category === ItemCategory.TOOL && def.tags.includes(tag)) return true;
  }
  return false;
}

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `GATHER`:采一格上的自然资源。先判完再动世界与背包(失败零副作用)。 */
export const gather: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
  const x = numField(ctx.payload.x);
  const y = numField(ctx.payload.y);
  if (x === null || y === null) return { ok: false, kind: 'INVALID', reason: '需要 x / y(数字)' };
  const mat = ctx.materialsOf();
  if (mat === null) {
    return { ok: false, kind: 'NOT_IMPLEMENTED', reason: '世界源没有物质层 ⇒ 没有世界可采' };
  }
  /* ── 1 这一格上是**什么**:空格 / 世界外 / 非自然资源都在这里被拒(世界与背包都还没动)。 ── */
  const objId = mat.blockAt(x, y);
  if (objId === 0) {
    return {
      ok: false, kind: 'INVALID',
      reason: `格 (${x},${y}) 上没有物件(空格或在世界外 ⇒ 没有可采集物)`,
    };
  }
  const kind = gatherableOf(objId);
  if (!kind.ok) return { ok: false, kind: 'INVALID', reason: `格 (${x},${y}) ${kind.reason}` };

  /* ── 2 距离(权威位置,不取报文里的坐标)── */
  const at = ctx.hostPositionOf(ctx.actorId);
  if (at === null) return { ok: false, kind: 'INVALID', reason: '拿不到该玩家的权威位置(不在世界里)' };
  /* 目标格的**中心**(+0.5)与权威位置比 —— 与 `groundItemsNear` 的格坐标口径一致。 */
  const dist = Math.hypot((Math.floor(x) + 0.5) - at.x, (Math.floor(y) + 0.5) - at.y);
  if (dist > GATHER_RADIUS) {
    return {
      ok: false, kind: 'INVALID',
      reason: `离「${kind.name}」${dist.toFixed(2)} 格 > 采集半径 ${GATHER_RADIUS} 格 ⇒ 走近一点`,
    };
  }

  /* ── 3 工具前置(内容表派生的词条族;读口缺失 ⇒ fail-closed,不假装有工具)── */
  const toolTag = toolTagFor(objId);
  if (toolTag !== null) {
    const hasTool = ownsToolTagged(ctx, toolTag);
    if (hasTool === null) return missingItemReadPort(ctx);
    if (!hasTool) {
      return {
        ok: false, kind: 'INVALID',
        reason: `采「${kind.name}」需要一件带『${toolTag}』词条的工具(背包里没有 ⇒ 零副作用)`,
      };
    }
  }

  /* ═══════════ 判定全部通过:从这里开始才动世界 / 背包 ═══════════ */
  /* 扣减 = 格上那一件消失;世界源同时把 `gatherMul`(602 的 1.20)归属回来。 */
  const r = mat.breakBlock(x, y, ctx.actorId);
  if (!r.ok) return { ok: false, kind: 'INVALID', reason: r.reason };

  /* 件数放大:与 `BREAK_BLOCK` **同一处规则**(`gatherCountFor`),种子 = (actor,格,obj,房间 tick)。 */
  const gatherMul = r.gatherMul ?? 1;
  const state = ctx.state as unknown as { meta?: { tick?: number } } | null | undefined;
  const tick = typeof state?.meta?.tick === 'number' ? state.meta.tick : 0;
  const count = gatherCountFor(gatherMul, gatherRollFor(ctx.actorId, x, y, r.objId, tick));

  /* 产出先进**按件**凭证链,再入背包(`item_source.ts` 的纪律:裸字符串会被按凭空产出拒)。 */
  const src = bindItemSource(ctx, r.objId, ItemSourcePurpose.GATHER);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId: r.objId, delta: count, source: src }] });
  /* `gatherMul` 只在**非中性**时进回执(1 = 中性 ⇒ 键缺席,与 `BREAK_BLOCK` 同一条纪律)。 */
  const effect: Record<string, string | number | boolean> = {
    x, y, objId: r.objId, gained: gain.allowed ? count : 0,
  };
  if (r.gatherMul !== undefined && r.gatherMul !== 1) effect.gatherMul = r.gatherMul;
  if (toolTag !== null) effect.tool = toolTag;
  if (gain.allowed) return { ok: true, kind: 'OK', effect };

  /* 背包收不下 ⇒ 凭证显式撤销 + 落回**原地**(不凭空销毁)。 */
  unbindItemSource(ctx, src);
  mat.dropItem(x, y, r.objId, count);
  effect.dropped = count;
  effect.note = `背包收不下(${gain.rejectCode ?? '被拒'})⇒ 掉在原地`;
  return { ok: true, kind: 'OK', effect };
};
