/**
 * `USE_ITEM` —— **使用一件道具**(吃 / 投掷 / 疗伤 / 灭火)。
 *
 * ## 它为什么存在
 *
 * 733 羽毛笔、227 泡泡水枪、料理 buff 三者的**函数与判据都已有**
 * (`combat/revive.ts` 的 `featherRevive` / `bubbleGunHit`、`combat/cooking.ts` 的 buff 链路),
 * 但玩家触发不到 —— 缺的正是这个动词(`docs/TASK-99-use-item-verb.md`)。
 *
 * ## 执序(每一步都能单独被证伪,**拒绝一律零副作用**)
 *
 * 1 权限闸(**第一行**);
 * 2 报文校验:`itemId` 必须是正整数;`targetId` 与 `targetDeviceId` **不许同时给**;
 *    `slot`(可选)必须是非负整数;
 * 3 **语义门**:这件道具**真的**有使用语义吗(查世界侧的 `itemUseKind`,
 *    那是 `useItem` 分派用的**同一张表**)—— 没有 ⇒ 拒,不进背包、不进世界;
 * 4 **★ 权威读口**:服务端**按件**账面里真的有这件吗(`ItemReadPort.itemCountOf`)——
 *    没有 ⇒ 拒,**不发物品、不消耗、不动 buff**;
 * 5 **先扣后生效**(`applyInventory` 的负 delta)—— 扣不动 ⇒ 世界侧**根本没跑**;
 * 6 交给世界:`ctx.host.useItem(...)` —— 语义判断**只在世界侧一处**(它在 `world_sim.ts`);
 * 7 回执:成功带 `effect`(世界侧给的标量表 + `consumed`)。
 *
 * ## ★★ 为什么第 4 步是这次修复的核心
 *
 * 修前本文件的注释写着:「服务端今天**没有按件背包明细读口**,所以 `itemId` 是客户端自报的」。
 * 后果不是「偶尔多扣一件」,而是**白嫖**:背包里一件 733 都没有,也能无限发
 * `{itemId: 733}` —— 扣减只校验「**总量**够不够」,所以随便什么别的道具都能被
 * 当成 733 扣掉(而玩家根本不需要拥有 733)。
 *
 * 修法不是在这里加一个 if,而是**补读口**(`RoomRuntime.authoritativeItemCount`,
 * 账本跟着 `applyInventory` 的唯一写入口维护),然后由本文件**只读**它。
 * 读不到权威(宿主没提供读口)时**不放行**:宁可回 `NOT_IMPLEMENTED`
 * (显式说「这条链没接好」),也不退回「信客户端」——那正是要修的缺陷。
 *
 * ## `slot` 与 `itemId` 的关系
 *
 * `slot` 是**服务端账面**的序号(该玩家持有清单按 `itemId` 升序),不是客户端自报的
 * 物品 id。两个都给了 ⇒ 必须**指同一件**(否则拒):客户端不能用一个 slot 号
 * 去指认一件它没有的东西,也不能在同一个报文里说两套话。
 *
 * ## 两种目标(`targetId` / `targetDeviceId`)
 *
 * `targetId` = **玩家**(救队友 / 困人 / 吃 buff 的对象);`targetDeviceId` = **器件**
 * (227 水枪 / 212 大铁铲 浇灭料理站炉火 —— C3 的灭火半边)。
 * 二者**互斥**:同时给出 ⇒ 报文层直接拒(`INVALID`),不进世界。
 *
 * ## ⚠️ 为什么是"先扣后生效",以及它**曾经**是反的
 *
 * 第一版是"先生效后扣":扣失败时世界侧的改动**已经落地** ⇒ 没有料理也能无限叠 `hpFlat`。
 * 改成先扣之后,白嫖被堵在门口;反过来(扣成功而世界侧未生效 / 无需扣)⇒ **退回**,
 * 补偿走本仓既定的 `grantItemSource` + 正向 ops 机制,不是就地撤销。
 */
import { ItemSourcePurpose } from '../anticheat.ts';
import { bindItemSource, unbindItemSource } from './item_source.ts';
import type { ActionOutcome, ActionPayload, ItemReadPort } from '../room.ts';
import type { ActionHandler } from './types.ts';
/* ★ WS-FND-122:整蛊玩具表与 218 和平盾的**唯一事实源**。
 *
 * ## 为什么在这里 import(而不是让世界侧再分派一次)
 * `use_item` 的语义门读的是世界侧 `itemUseKind`,而那张表**不认** 221..255
 * (`itemUseKind` 只覆盖 733/227/212/料理)⇒ 玩家对着队友用整蛊玩具时,
 * 动作层在**扣道具之前**就回「没有使用语义」,而 `prank/actions.ts` 的
 * `resolvePrankAction` / `gatePrank` 生产零调用 ⇒ 「玩家→玩家整蛊」不存在。
 *
 * `PRANK_TOYS`(35 件,含 `radius` / `stunSec` / `impulse` / 队友侧效果)本来
 * 就是那张**唯一**表 ⇒ 玩具分支读它,不另写白名单。
 * 判定(表内 / 半径 / 自伤 / 218 盾免疫)一律走 `gatePrank`,本文件不重判。
 */
import { PRANK_TOY_BY_ID, SAFE_SHIELD_ITEM_ID } from '../../prank/toys.ts';
import { gatePrank } from '../../party/actions.ts';

/** 本动作的报文(`itemId` / `targetId` 已在 `ActionPayload` 里声明,这里只做窄化)。 */
type UseItemPayload = ActionPayload & {
  itemId?: unknown;
  targetId?: unknown;
  targetDeviceId?: unknown;
  slot?: unknown;
};

/**
 * 世界侧的**语义读口**(`WorldSim.itemUseKind` 的结构化最小面)。
 *
 * 为什么是可选的:本文件不该假设**所有**宿主都实现了它(老宿主 / 测试桩)。
 * 缺读口时的行为**不是**「跳过检查」,而是「这条链没接好」⇒ 见下面的
 * `NOT_IMPLEMENTED` 分支。
 */
type ItemSemanticPort = { itemUseKind?: (itemId: number) => string | null };

/** 取正整数;不是 ⇒ `null`(不做字符串转换,不猜默认值)。 */
function positiveInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  return v > 0 ? v : null;
}

/** 取非负整数(slot 从 0 开始);不是 ⇒ `null`。 */
function nonNegativeInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  return v >= 0 ? v : null;
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
  /* ★ 两个目标**不许同时给**:客户端多报一个字段就能改变语义,是"静默忽略"最坏的一类。
     拒绝理由要**指认字段**,而且要**在扣道具之前**。 */
  if (targetId !== undefined && targetDeviceId !== undefined) {
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 的 targetId 与 targetDeviceId 互斥(只能选一个)`,
    };
  }
  /* `slot`(可选):非负整数;给了就必须能在服务端账面里翻译成一件**真实**道具。 */
  const slot = p.slot === undefined ? undefined : nonNegativeInt(p.slot);
  if (p.slot !== undefined && slot === null) {
    return { ok: false, kind: 'INVALID', reason: `${ctx.action} 的 slot 需要非负整数` };
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

  /* ★ 3a WS-FND-122:**两类道具的语义不在世界侧那张表里**。
   *
   * ```
   * 整蛊玩具 221..255  →  prank/toys.ts#PRANK_TOYS(35 件,含半径/眩晕/冲量)
   * 218 和平盾          →  穿戴件:开关状态在世界侧(`setShieldOn` / `shieldOnOf`)
   * ```
   * ⚠️ 这两类**不能**交给 `itemUseKind` 判:它只覆盖 733/227/212/料理,
   *    `null` 分支会让「对队友用整蛊玩具」在扣道具之前就回「没有使用语义」——
   *    而那不是「没有语义」,是**语义在另一张表里**。
   *
   * ★★ **重叠件:227**(WS-FND-122 实测到的回归)
   * ```ts
   * 227 = 泡泡连发水枪 → prank/toys.ts 的 221..255 表里**也有**它(radius 5, BUBBLED)
   * 227 = 世界侧 itemUseKind 的 'BUBBLE'(连中 3 发才困人 —— 比玩具表更具体)
   * ```
   * 若玩具分支先跑,227 会退化成「一发就 STUNNED」⇒ `WS-FND-53` 的
   * 「第 3 发才困住」当场红。⇒ **世界侧已认的语义优先**,玩具分支只接
   * 「世界侧那张表说 null」的那些 id。
   */
  const toy = PRANK_TOY_BY_ID.get(itemId) ?? null;
  const isShield = itemId === SAFE_SHIELD_ITEM_ID;

  /* ★ 3b **语义门**(纯读):这件道具真的有使用语义吗?
    - 有读口 ⇒ 用世界侧那张**唯一**的语义表(`itemUseKind`);
    - 没读口 ⇒ 跳过这一步,让世界侧自己拒(它们的分支仍然会说"没有使用语义")。
    这一步放在**扣道具之前**:没有语义的 id 不该先被扣一件再退回
    (退回虽正确,但会让"被拒"与"用过又退了"在账面上留下痕迹)。 */
  const semantic = (host as ItemSemanticPort).itemUseKind;
  const semanticKind = typeof semantic === 'function' ? semantic.call(host, itemId) : null;
  /* 玩具分支的判据 = 「在玩具表里」∧「世界侧没有更具体的语义」(见上面 227 那段)。 */
  const prankToy = toy !== null && (typeof semantic !== 'function' || semanticKind === null);
  if (!prankToy && !isShield && typeof semantic === 'function' && semanticKind === null) {
    return { ok: false, kind: 'INVALID', reason: `${ctx.action} 的道具 ${itemId} 没有使用语义` };
  }

  /* ★★ 4 **服务端权威读口**:按件账面里真的有这件吗?
     —— 这是"USE_ITEM 不许再信任客户端自报的 itemId"的落点。
     `ItemReadPort` 由 `RoomRuntime` 提供(见 `room.ts` 的 docblock):
     账本跟着 `applyInventory` 的唯一写入口维护,客户端无法凭空写入。 */
  const port = ctx as unknown as Partial<ItemReadPort>;
  if (typeof port.itemCountOf !== 'function' || typeof port.itemIdsOf !== 'function') {
    /* fail-closed:没有权威读口 ⇒ **不放行**。退回"信客户端"正是要修的缺陷。 */
    return {
      ok: false,
      kind: 'NOT_IMPLEMENTED',
      reason: `${ctx.action} 缺少按件库存读口(服务端无法确认 itemId 的真伪)`,
    };
  }
  const owned = port.itemCountOf(ctx.actorId, itemId);
  if (!Number.isFinite(owned) || owned <= 0) {
    /* ★ 零副作用:到这里**还没**碰背包、没碰世界、没碰 buff。 */
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 没有道具 itemId=${itemId}(服务端账面 ${Number.isFinite(owned) ? owned : 0} 件)`,
    };
  }
  if (slot !== undefined && slot !== null) {
    /* slot → 真实 itemId(服务端定序)。指认不一致 ⇒ 拒(两份声明互相打架时不许挑一个执行)。 */
    const slotIndex = slot;
    const atSlot = port.itemIdsOf(ctx.actorId)[slotIndex];
    if (atSlot === undefined) {
      return { ok: false, kind: 'INVALID', reason: `${ctx.action} 的 slot=${slot} 上没有道具` };
    }
    if (atSlot !== itemId) {
      return {
        ok: false,
        kind: 'INVALID',
        reason: `${ctx.action} 的 slot=${slot} 是 itemId=${atSlot},与申报的 itemId=${itemId} 不符`,
      };
    }
  }

  /* ══════════ ★ WS-FND-122:整蛊玩具(221..255)的**前置判定** ══════════
   *
   * 判定一律走 `party/actions.ts#gatePrank`(→ `prank/actions.ts#resolvePrankAction`),
   * 本文件只提供它要的两个**权威输入**:
   * ```
   * distance  两个玩家的权威坐标差(`hostPositionOf` → physics.bodies)
   * ally      两队归属是否相同(`host.partyTeamOf`,435 复活旗是唯一来源)
   * shieldOn  目标身上 218 和平盾的**真实开关**(`host.shieldOnOf`)
   * ```
   * 位置/队伍拿不到 ⇒ `ally=false`(按敌对算)但**距离必须拿得到**:
   * 拿不到距离就无从判「在不在半径内」⇒ 显式拒(不许当成 0 格放行)。
   *
   * ⚠️ 判序:这一整段在**扣道具之前**且全部是纯读 ⇒ 被拒时**零副作用**
   *    (背包、世界、buff 一个字都没动)。
   */
  let prank: ReturnType<typeof gatePrank> | null = null;
  let prankTarget = '';
  if (prankToy && toy !== null) {
    if (targetDeviceId !== undefined) {
      return {
        ok: false, kind: 'INVALID',
        reason: `${ctx.action} 的整蛊玩具 ${itemId} 只能对**玩家**用(targetDeviceId 不适用)`,
      };
    }
    if (targetId === undefined) {
      /* 整蛊是「对别人」的动词:缺目标时**不**退回「对自己」——
         那会让一次报文失误变成自伤(而 218 盾不免疫自伤)。 */
      return { ok: false, kind: 'INVALID', reason: `${ctx.action} 的整蛊玩具 ${itemId} 需要 targetId(玩家)` };
    }
    prankTarget = targetId;
    const atActor = ctx.hostPositionOf(ctx.actorId);
    const atTarget = ctx.hostPositionOf(prankTarget);
    if (atActor === null || atTarget === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: `${ctx.action} 拿不到 ${atActor === null ? ctx.actorId : prankTarget} 的权威位置 ⇒ 无法判定整蛊半径`,
      };
    }
    const distance = Math.hypot(atTarget.x - atActor.x, atTarget.y - atActor.y);
    const teamOf = host.partyTeamOf;
    const teamA = typeof teamOf === 'function' ? teamOf.call(host, ctx.actorId) : null;
    const teamB = typeof teamOf === 'function' ? teamOf.call(host, prankTarget) : null;
    const ally = teamA !== null && teamB !== null && teamA === teamB;
    const shieldOf = host.shieldOnOf;
    const shieldOn = typeof shieldOf === 'function' ? shieldOf.call(host, prankTarget) === true : false;
    prank = gatePrank({
      actorId: ctx.actorId, targetId: prankTarget, toyId: itemId, distance, ally, shieldOn,
    });
    if (!prank.accepted || prank.blocked) {
      return {
        ok: false, kind: 'INVALID',
        reason: `${ctx.action} 整蛊未施加(${prank.reason}):toy=${itemId}`
          + ` target=${prankTarget} 距离=${distance.toFixed(2)} 半径=${toy.radius}`
          + `${prank.blocked ? '(218 和平盾)' : ''}`,
      };
    }
  }

  /* ══════════ ★ WS-FND-122:218 和平盾(**穿戴件,不消耗**)══════════
   *
   * 修前 `contestCrownDrop` 里写死 `shieldOn: false` ⇒ 盾的「免疫队友整蛊」
   * 恒不成立。这里补的是**生产者**:用一下 218 ⇒ 世界侧的开关真的置真,
   * 之后 `gatePrank` / `gateCrownKnock` 都从 `shieldOnOf` 读到它。
   *
   * ⚠️ **不扣道具**:它是安全帽(穿在身上),不是消耗品。别的道具走
   *    「先扣后生效」,这里**没有**扣减动作 —— 所以也没有退款分支。
   *    权威读口(第 4 步)仍然要求「背包里真的有这件」,凭空开盾不行。
   */
  if (isShield) {
    const setShield = host.setShieldOn;
    if (typeof setShield !== 'function') {
      return {
        ok: false, kind: 'NOT_IMPLEMENTED',
        reason: `${ctx.action} 的世界侧不支持 218 和平盾开关`,
      };
    }
    const changed = setShield.call(host, ctx.actorId, true) === true;
    return {
      ok: true, kind: 'OK',
      effect: { itemId, shieldOn: true, changed, consumed: 0 },
    };
  }

  /* 5 **先扣后生效**。扣不动 ⇒ 世界侧**根本没跑**。 */
  const take = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] });
  if (!take.allowed) {
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 没有这件道具(${take.rejectCode ?? '未知'})`,
    };
  }

  /**
   * 把刚扣掉的那一件退回去(扣成功但本次不该扣 / 世界侧没生效)。
   *
   * @returns `null` = 退回**成功**;非空字符串 = 退回**被拒**的人读说明 ——
   *   调用方必须把它写进回执(审计 P3:修前返回值被丢 ⇒ 退回失败时物品静默消失,
   *   而回执写着「已退回」)。口径与 `craft.ts:206` 的退款分支一致。
   */
  const refund = (): string | null => {
    /* 退回是正 delta ⇒ 必须先铸**绑定**凭证(绑 itemId:只换回这一件)。 */
    const src = bindItemSource(ctx, itemId, ItemSourcePurpose.USE_REFUND);
    const back = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: 1, source: src }] });
    if (back.allowed) return null;
    /* 退回都没成 ⇒ 这张凭证同样没被用掉 ⇒ 显式撤销(不留到 tick 末当来源)。 */
    unbindItemSource(ctx, src);
    return `退回也被拒:${back.rejectCode ?? '被拒'} ⇒ 这一件没能回到背包`;
  };

  /* ══════════ ★ WS-FND-122:整蛊玩具的**效果落点**(判定已在 4b 过完)══════════
   *
   * 顺序仍是「先扣后生效」:道具已经扣了 1 件,世界侧**没施加**就退回并如实
   * 写进回执(退回失败也写 —— 与下面 733 那条同一口径)。
   *
   * ⚠️ 效果**不在这里算数值**:`stunSec` / `moveTiles` / `flag` 来自
   *    `gatePrank` 的裁定(玩具表 + 218 盾 + 敌我),`impulse` 来自玩具表本身。
   *    世界侧只负责落到权威状态(`vitals.applyStun` / `physics.applyImpulse`)。
   */
  if (prankToy && toy !== null && prank !== null) {
    const applyPrank = host.applyPrankToTarget;
    if (typeof applyPrank !== 'function') {
      const refundNote = refund();
      return {
        ok: false, kind: 'NOT_IMPLEMENTED',
        reason: `${ctx.action} 的世界侧不支持整蛊效果`
          + (refundNote === null ? '(道具已退回)' : `(${refundNote})`),
      };
    }
    const applied = applyPrank.call(host, ctx.actorId, prankTarget, {
      toyId: itemId,
      stunSec: prank.stunSec,
      impulse: toy.impulse,
      moveTiles: prank.moveTiles,
      flag: prank.flag ?? 'NONE',
    });
    if (applied.applied !== true) {
      const refundNote = refund();
      return {
        ok: false, kind: 'INVALID',
        reason: `${ctx.action} 整蛊未生效:${applied.reason}`
          + (refundNote === null ? '(道具已退回)' : `(${refundNote})`),
      };
    }
    return {
      ok: true, kind: 'OK',
      effect: {
        itemId, toyId: itemId, targetId: prankTarget,
        flag: applied.flag, moveTiles: applied.moveTiles, stunSec: applied.stunSec,
        ally: prank.origin === 'ALLY', shield: prank.shield !== null,
        consumed: 1,
      },
    };
  }

  /* 缺省字段**不塞 `undefined`**:世界侧用 `in` 语义判"这次有没有给器件目标"。 */
  const req: { itemId: number; targetId?: string; targetDeviceId?: number } = { itemId };
  if (targetId !== undefined) req.targetId = targetId;
  if (targetDeviceId !== undefined && targetDeviceId !== null) req.targetDeviceId = targetDeviceId;
  const out = host.useItem(ctx.actorId, req);
  if (!out.applied) {
    /* 世界侧说"没生效" ⇒ 退回刚才那一扣。733 超距走的就是这条。
       ★ 审计 P3:退回的**结果**必须进回执 —— 退回失败时东西真的没了,
       不能再写「(道具已退回)」骗读回执的人(与 `craft.ts:206` 同口径)。 */
    const refundNote = refund();
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 未生效:${out.reason}`
        + (refundNote === null ? '(道具已退回)' : `(${refundNote})`),
    };
  }

  if (!out.consume) {
    /* 世界侧承认生效但**不需要扣** ⇒ 同样退回;退回被拒同样写进 `effect`。 */
    const refundNote = refund();
    const effect: Record<string, string | number | boolean> = {
      ...(out.effect ?? {}), itemId, consumed: 0,
    };
    if (refundNote !== null) effect.refundRejected = refundNote;
    return { ok: true, kind: 'OK', effect };
  }

  return {
    ok: true,
    kind: 'OK',
    effect: { ...(out.effect ?? {}), itemId, consumed: 1 },
  };
};