/**
 * WS-FND-119 —— 温室「播种」的动作侧实现(由 `PLACE_AUTOMATION` 的播种分支调用)。
 *
 * ## 为什么它在这里,而不是一个独立的 `PLANT_CROP` 动作
 *
 * `RoomAction`(`net/room.ts:106-135`)里**没有**播种动作,`ACTION_HANDLERS`
 * (`actions/action_table.ts`)是 `Readonly<Record<RoomAction, ActionHandler>>`
 * 的完整表 ⇒ 新增一个动作要同时改 `room.ts`(枚举 + `ACTION_PERMISSION`)、
 * `action_table.ts` 与「22/24 个动作」的一批判据,**这三处都不在本线写域**。
 * 而只建一个没人分派的 `plant_*.ts` 就是这个仓库最忌讳的东西:
 * 「实现存在、生产零调用」(本文件的起因正是那一类缺陷)。
 *
 * ⇒ 播种作为 `PLACE_AUTOMATION` 的**第二形态**接线:那个动作本来就是
 *   「在一格上放下实物」(`{kind, x, y}` = 放组件,`{itemId, x, y}` = 下种子),
 *   两者都扣背包里那一件、都写世界那一格、都受同一条权限位管。
 *   ⚠️ 这是**过渡形态**,移出条件是:给 `room.ts` 加 `PLANT_CROP` 动作 +
 *     `ACTION_PERMISSION.PLANT_CROP = 'baseline'` + `action_table.ts` 一行,
 *     然后把本文件改成那个动作的处理器(`plantSeedAt` 一行不改)。
 *
 * ## 判序(每一支失败都**零副作用**)
 *
 * ```ts
 *   1 权限闸在调用方(place_automation 第一行)
 *   2 坐标:有限整数 + 世界内(调用方已判,见 place_automation 第 2/3 步)
 *   3 这一件是不是种子 —— 内容表说(系统 intake.sowableReasonOf),不是本文件列名单
 *   4 宿主有没有播种写口 ⇒ 没有就 NOT_IMPLEMENTED(不假装种上了)
 *   5 这一格有作物了吗 ⇒ 有就拒(世界侧 plantCrop 也会拒,这里先拒是为了**不扣件**)
 *   6 背包里真的有一件吗 ⇒ 按件权威读口(缺失 ⇒ NOT_IMPLEMENTED,不信客户端)
 *   7 扣件(唯一失败的写入口)⇒ 扣失败就结束,世界一格未动
 *   8 世界播种 ⇒ 被拒(非耕地 / 已被占 / 坐标越界)就**退回**那一件(PLACE_REFUND)
 *   9 成功 ⇒ 回 OK + effect(种的是哪件、哪一格、成熟天数)
 * ```
 *
 * ★ 第 7 步先于第 8 步(照 `actions/material.ts` 的 `placeBlock`):先扣背包、
 *   再写世界,世界拒绝就走**退回**。反过来会出现「种上了但没扣件」——
 *   那正是「播种零成本」的形态。
 */

import { roomSystemsPortOf, sowableReasonOf } from '../../systems/intake.ts';
import { ItemSourcePurpose } from '../anticheat.ts';
import { bindItemSource, missingItemReadPort, ownedItemCount, unbindItemSource } from './item_source.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext } from './types.ts';

/**
 * 在 `(x, y)` 播下一件种子。
 *
 * @param itemId 种子物品 id(**调用方已判**它是有限整数);这里再判「是不是种子」。
 */
export function plantSeedAt(
  ctx: ActionContext,
  x: number,
  y: number,
  itemId: number,
): ActionOutcome {
  /* ── 3 这一件能不能当种子:唯一判据是内容表(见 systems/intake.ts) ── */
  const notSeed = sowableReasonOf(itemId);
  if (notSeed !== null) return { ok: false, kind: 'INVALID', reason: notSeed };

  /* ── 4 世界的播种写口(缺 ⇒ 显式 NOT_IMPLEMENTED,零副作用) ── */
  const port = roomSystemsPortOf(ctx.host);
  if (port === null || typeof port.plantCrop !== 'function') {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: '宿主没有播种写口(`plantCrop`)⇒ 没有世界可种(见 systems/intake.ts 的 RoomSystemsPort)',
    };
  }

  /* ── 5 这一格已经有作物 ⇒ 拒。先判是为了**不扣件**:世界侧也会拒,但那时
        背包已经少了一件,得走退回 —— 能不动账就不动账。 ── */
  const occupied = typeof port.cropAt === 'function' ? port.cropAt(x, y) : undefined;
  if (occupied !== undefined) {
    return {
      ok: false, kind: 'INVALID',
      reason: `这一格已经有作物(#${occupied.cropId})⇒ 不能重复播种`,
    };
  }

  /* ── 6 背包里真的有一件(按件权威读口;缺读口 ⇒ NOT_IMPLEMENTED) ── */
  const owned = ownedItemCount(ctx, itemId);
  if (owned === null) return missingItemReadPort(ctx);
  if (owned < 1) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有可播种的 ${itemId}(服务端账面 ${owned} 件)⇒ 一格未种`,
    };
  }

  /* ── 7 扣件(唯一的失败写入口)。被拒 ⇒ 世界一格未动。 ── */
  const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有可播种的 ${itemId}(${spend.rejectCode ?? '被拒'})⇒ 一格未种`,
    };
  }

  /* ── 8 世界播种:耕地(内容表 301)与「空格」都由 `WorldSim.plantCrop` 判 ── */
  const planted = port.plantCrop(x, y, itemId);
  if (!planted.ok) {
    /* 扣了件却没种下 ⇒ **退回**(正 delta 必须先铸绑定凭证,与 placeBlock 同一手法)。 */
    const src = bindItemSource(ctx, itemId, ItemSourcePurpose.PLACE_REFUND);
    const refund = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: 1, source: src }] });
    if (!refund.allowed) unbindItemSource(ctx, src);
    return {
      ok: false, kind: 'INVALID',
      reason: planted.reason
        + (refund.allowed ? '' : `(退回也被拒:${refund.rejectCode ?? '被拒'} ⇒ 这一件没能回到背包)`),
    };
  }

  /* ── 9 回执:种的是哪一件、哪一格、几天成熟(成熟天数**读回来**,不是本文件给的)。 */
  const cell = typeof port.cropAt === 'function' ? port.cropAt(x, y) : undefined;
  return {
    ok: true, kind: 'OK',
    effect: {
      x, y,
      cropId: itemId,
      seedItemId: itemId,
      matureDays: cell?.matureDays ?? null,
      note: '播种成功:温室/露天按内容表成熟天数在慢帧生长(见 systems/greenhouse.ts)',
    },
  };
}