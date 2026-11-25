/**
 * `NPC_TALK` —— **与 NPC 说话**(★ WS-FND-188)。
 *
 * ## 修前是什么样(本动作要修的那一件事)
 * ```text
 * server/src/npc/defs.ts     有 4 个 NPC(镇长 / 农夫 / 矿工 / 遗迹守卫)
 * server/src/npc/dialogue.ts 有纯函数 talk()/acceptQuest()/progressOf()
 * server/src/npc/defs.ts     有 npcAt(x, y, radius) 空间查询
 * 客户端                     零进口、零立牌、零按键 ⇒ 玩家**看不见也点不到任何人**
 * ```
 * ⇒ 「找谁接任务」这件事在世界上**没有承载体**,而**没有任何东西会红**:
 *   连接是 live、快照照常到、`NPCS` 的判据(`WS-FND-186`)全绿。
 * 本文件是那条缺失通道的**服务端半边**:玩家按 T ⇒ 一条 `NPC_TALK` 动作 ⇒ 台词
 * 经动作回执(`effect.line`)回到客户端 HUD。
 *
 * ## 为什么是动作而不是新报文
 * 说话是**玩家意图**(与采集/开箱同类)⇒ 必须走同一条路由,白拿四件事:
 * 权限位(`baseline`,游客也能问路)/ 单帧动作预算 / 幂等与反作弊 / 回执出口。
 * 另开一条报文等于把那四件事各写一遍 —— 本仓 1 号病根(两份实现迟早漂)。
 *
 * ## 判序(失败一律**零副作用**,与 `gather.ts` 同规)
 * ```text
 * 1 权限             ctx.authorize(动作表已登记 ⇒ baseline)
 * 2 载荷形状         npcId 必须是非空字符串(缺 / 非串 ⇒ INVALID,不猜默认值)
 * 3 权威位置         拿不到 ⇒ INVALID(不在世界里)
 * 4 半径 + 对账      用 npcAt(权威坐标) 求**最近的** NPC:
 *                      半径内没有人            ⇒ INVALID(走近一点)
 *                      最近的人 ≠ 报文里的 npcId ⇒ INVALID(你离另一个更近)
 * 5 库存读口         fail-closed:没有按件账 ⇒ NOT_IMPLEMENTED
 *                    (报价里的 `have` 只能来自真实账本;编一个 0 ⇒ 玩家看到
 *                     "你一件都没有",而那是**假数据**,比拒得更糟)
 * 6 talk()           纯函数,按**任务状态**选一句台词(available/accepted/completed)
 * ```
 * ⚠️ 第 4 步是**距离门**的本体:客户端也判了 2.5 格(为了给 HUD 那一行提示),
 *   但那条判定只影响"按哪个键",**不构成授权** —— 隔着半张地图伪造一条报文
 *   在这里必被拒(与 `gather` 不信客户端坐标同一条纪律)。
 *
 * ## 任务账本住哪(以及为什么现在是**进程内**的)
 * `dialogue.talk` 的入参是一个只读快照 `NpcPlayerState{inventory, quests}`:
 * ```text
 * inventory  取**按件权威账**(actions/item_source.ts 的 authoritativeStock)
 * quests     取本模块的进程内账本(键 = 房间 + 玩家)
 * ```
 * 账本按 `roomId` 分隔(与 `sleep.ts` 的 `SLEEPERS[roomId][playerId]` 同一手法):
 * 同一个 userId 在两个房间里各有一份,不会互相看见。
 * ⚠️ **未持久化**是**如实标注**的残留:进程重启后"已接的任务"回到 `available`。
 *   要落库必须扩展 `net/schema.ts` 的 RoomState 或 db 侧存档(那是另一条线的改动),
 *   本动作**不偷偷**用世界存档位承载它(那会让"任务状态"与"世界状态"混成一个字段)。
 *
 * ## 本动作**只说话**:不接任务、不发奖
 * `acceptQuest()`(领/交 + 发奖)是**写**路径,它需要幂等键 + 账本落库 + 奖励发放
 * 三件事一起改 ⇒ 不在本轮(判据里那条"talk 不发奖"的反向断言守着这一点:
 * 连续说 5 次话,账本与背包一个字节都不变)。
 */

import { NPC_TALK_RADIUS, npcAt, npcById } from '../../npc/defs.ts';
import { acceptQuest, talk, type NpcPlayerState, type QuestStatus } from '../../npc/dialogue.ts';
import { ItemSourcePurpose } from '../anticheat.ts';
import { authoritativeStock, bindItemSource, missingItemReadPort, unbindItemSource } from './item_source.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * 账本键 —— 房间 + 玩家。
 *
 * 为什么不只用 `actorId`:同一个 userId 可以同时在一个房间里"接了任务"、
 * 在另一个房间里"没接"(房间是独立的世界与进度域)。只用 actorId 会让两个房间
 * 共用一份任务账,而症状是"在 B 房能看到 A 房接过的任务"—— 不报错。
 */
export function npcTalkStateKeyOf(roomId: string, actorId: string): string {
  return `${roomId}\u0000${actorId}`;
}

/**
 * 进程内的任务账本(`键 → NpcPlayerState`)。
 *
 * 只存 `quests`(背包那半**永远**从权威账读,不在这里缓存):
 * 缓存背包 = 与 `RoomRuntime.itemCountOf` 竞争的第二份真值。
 */
const QUEST_LEDGER = new Map<string, NpcPlayerState>();

/** 取一份**可给 `dialogue` 用**的只读快照(缺省 = 新玩家:空背包 + 空账本)。 */
export function npcTalkLedgerOf(roomId: string, actorId: string): NpcPlayerState {
  return QUEST_LEDGER.get(npcTalkStateKeyOf(roomId, actorId))
    ?? { inventory: {}, quests: {} };
}

/** 落账(只有"状态真的变了"才写;`talk` 本身不改状态,留给领奖那条路用)。 */
export function setNpcTalkLedger(roomId: string, actorId: string, state: NpcPlayerState): void {
  QUEST_LEDGER.set(npcTalkStateKeyOf(roomId, actorId), state);
}

/** 清一份账(退房 / 测试夹具用;幂等)。 */
export function forgetNpcTalk(roomId: string, actorId: string): boolean {
  return QUEST_LEDGER.delete(npcTalkStateKeyOf(roomId, actorId));
}

/** 当前账本条数(自检读数:它证明"这条链真的写过东西",而不是只在内存里声明过)。 */
export function npcTalkLedgerSize(): number {
  return QUEST_LEDGER.size;
}

/** `ctx.state` 里那个 `roomId` —— 读不到时给空串(仍是**一个**键,不与别的房间撞)。 */
function roomIdOf(ctx: ActionContext): string {
  const s = ctx.state as unknown as { roomId?: unknown } | null | undefined;
  return typeof s?.roomId === 'string' ? s.roomId : '';
}

/** 从 payload 里取 `npcId`(非空字符串);否则 `null`(调用方显式拒绝)。 */
function npcIdOf(ctx: ActionContext): string | null {
  const v: unknown = ctx.payload.npcId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `NPC_TALK`:跟身边那个 NPC 说话,把台词经回执送回客户端。 */
export const npcTalk: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* ── 1 权限(动作表登记的 baseline;游客也能问路)── */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* ── 2 载荷形状 ── */
  const requested = npcIdOf(ctx);
  if (requested === null) {
    return {
      ok: false, kind: 'INVALID',
      reason: 'NPC_TALK 需要 npcId(非空字符串:`server/src/npc/defs.ts` 的 `NpcDef.id`)',
    };
  }
  if (npcById(requested) === null) {
    return {
      ok: false, kind: 'INVALID',
      reason: `没有这个 NPC:${requested}(id 拼错 / 版本漂移 ⇒ 不假装它说了什么)`,
    };
  }

  /* ── 3 权威位置(不用报文里的坐标 —— 客户端报了也不信)── */
  const at = ctx.hostPositionOf(ctx.actorId);
  if (at === null) return { ok: false, kind: 'INVALID', reason: '拿不到该玩家的权威位置(不在世界里)' };

  /* ── 4 半径 + 对账(距离门的本体)── */
  const near = npcAt(at.x, at.y);
  if (near === null) {
    return {
      ok: false, kind: 'INVALID',
      reason: `附近 ${NPC_TALK_RADIUS} 格内没有人(你站在 ${at.x.toFixed(1)},${at.y.toFixed(1)})⇒ 走近一点`,
    };
  }
  if (near.id !== requested) {
    /* 两个 NPC 同时在半径内时,以**最近的**那个为准:否则玩家能站在 A 面前跟 B 说话
       (而 B 在几十格外的农田里)。d 用权威坐标算,报给客户端便于定位。 */
    const d = Math.hypot(at.x - near.home.x, at.y - near.home.y);
    return {
      ok: false, kind: 'INVALID',
      reason: `你离「${near.name}」更近(${d.toFixed(2)} 格)—— 报文里写的是 ${requested}`,
    };
  }

  /* ── 5 库存读口(fail-closed:报价里的 have 不许编)── */
  const stock = authoritativeStock(ctx);
  if (stock === null) return missingItemReadPort(ctx);

  /* ── 6 说话(纯函数:`talk` 只读,不掷骰、不取时间)── */
  const roomId = roomIdOf(ctx);
  const ledger = npcTalkLedgerOf(roomId, ctx.actorId);
  const state: NpcPlayerState = { inventory: stock, quests: ledger.quests };
  const said = talk(requested, state);
  const distance = Math.hypot(at.x - near.home.x, at.y - near.home.y);

  /* ── 6b 说话即推进差事 ──
     第一次搭话 = 接下(台词是开价那句);之后东西带够了再搭话 = 交差:
     扣掉要的东西、发谢礼、封账。裁决仍是 `dialogue.acceptQuest`(纯函数),
     这里只把它的结论落到背包与账本上。`questStatus` 报的是**这次说话之前**的状态,
     `questNow` 是之后的。 */
  let line = said.line;
  let questNow: QuestStatus | undefined;
  const extra: Record<string, string | number | boolean> = {};
  const quest = near.quest;
  if (quest !== undefined) {
    const step = acceptQuest(requested, state);
    questNow = ledger.quests[quest.id] ?? 'available';
    if (step.outcome === 'ACCEPTED') {
      setNpcTalkLedger(roomId, ctx.actorId, { inventory: {}, quests: step.state.quests });
      questNow = 'accepted';
      extra.accepted = true;
    } else if (step.outcome === 'COMPLETED' && step.awarded !== null) {
      const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId: quest.needItemId, delta: -quest.needCount }] });
      if (spend.allowed) {
        const src = bindItemSource(ctx, step.awarded.itemId, ItemSourcePurpose.QUEST_REWARD);
        const gain = ctx.applyInventory(ctx.actorId, {
          ops: [{ itemId: step.awarded.itemId, delta: step.awarded.count, source: src }],
        });
        if (gain.allowed) {
          setNpcTalkLedger(roomId, ctx.actorId, { inventory: {}, quests: step.state.quests });
          questNow = 'completed';
          line = talk(requested, { inventory: stock, quests: step.state.quests }).line;
          extra.turnedIn = true;
          extra.rewardItemId = step.awarded.itemId;
          extra.rewardCount = step.awarded.count;
        } else {
          /* 谢礼收不下 ⇒ 把交上去的东西退回来,差事不封账(腾出地方再来)。 */
          unbindItemSource(ctx, src);
          const back = bindItemSource(ctx, quest.needItemId, ItemSourcePurpose.QUEST_REFUND);
          const refund = ctx.applyInventory(ctx.actorId, {
            ops: [{ itemId: quest.needItemId, delta: quest.needCount, source: back }],
          });
          if (!refund.allowed) unbindItemSource(ctx, back);
          extra.note = '背包装不下谢礼,先腾点地方再来交';
        }
      }
    }
  }

  /* 回执全是**标量**(`EffectRecord` 的 JSON 值域;见 `ActionOutcome.effect` 的说明):
     `line` 就是客户端 HUD 要显示的那一句话,不在这里拼 UI 文案。 */
  const effect: Record<string, string | number | boolean> = {
    npcId: near.id,
    npc: near.name,
    line,
    x: near.home.x,
    y: near.home.y,
    distance: Math.round(distance * 1000) / 1000,
    /* 有任务时才带的那几项(键缺席 = 没任务,而不是"未知")。 */
    ...(near.quest === undefined ? {} : {
      questId: near.quest.id,
      questTitle: near.quest.title,
      questStatus: (ledger.quests[near.quest.id] ?? 'available') satisfies QuestStatus,
      needItemId: near.quest.needItemId,
      needCount: near.quest.needCount,
      have: stock[near.quest.needItemId] ?? 0,
      ...(questNow === undefined ? {} : { questNow }),
    }),
    ...extra,
  };
  return { ok: true, kind: 'OK', effect };
};
