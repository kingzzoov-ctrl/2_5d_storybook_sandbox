/**
 * NPC 对话 + 任务状态机(**纯函数**,车道 C / WS-FND-186)。
 *
 * ## 为什么是纯函数
 * 本仓的形状是「判定在纯函数里,世界/房间只做投影与落库」。任务领奖是最容易被
 * 写成"改一下玩家对象"的一类逻辑,而那种写法的后果是**奖励可以被刷**:
 * 同一份请求回放两次就发两次,而且不报错。所以这里:
 * ```text
 * 输入 = (npcId, 只读玩家状态)      输出 = (新状态, 这一次真的发了什么)
 * ```
 * 没有时间、没有随机、没有全局变量 ⇒ 同输入同输出(`talk` 判据直接钉这一点)。
 *
 * ## 状态机(三个状态,单向)
 * ```text
 * available ──acceptQuest──▶ accepted ──acceptQuest(物品够)──▶ completed
 *                                            │
 *                                     awarded = 奖励(仅这一次)
 * ```
 * - `available` = 还没接(MISSING = 账本里没有这一条,与"接了"必须可区分);
 * - `accepted`  = 接了没交;
 * - `completed` = 交了 + **已经发过奖**。
 *
 * ## ★ 重复领不许重复发奖(本模块唯一的硬规则)
 * 发奖**只**发生在 `accepted → completed` 这一次转移上,而且只在**返回的新状态**里
 * 记成 `completed`。于是:
 * ```text
 * 第 1 次  available → accepted     awarded = null
 * 第 2 次  accepted  → completed    awarded = 奖励        ← 唯一一次
 * 第 3 次  completed → completed    awarded = null
 * ...第 N 次 同上                   awarded = null
 * ```
 * ⚠️ 纯函数**没有记忆**:它"记得发过奖"的唯一依据是传进来的状态。
 * ⇒ 调用方(房间)必须**把返回的新状态落库**再接着用旧状态算第二次,
 *   才算幂等。用旧 `state` 重放同一个请求仍会走到 completed 分支 —— 这是
 *   纯函数能给出的最强保证("给定状态,奖励至多一次"),也是判据
 *   `FND186-7/8` 钉住的口径。
 *
 * ## 为什么 `talk` 里也要带 offer
 * "能说什么"与"能给什么"必须同源:如果 UI 先 `talk` 再单独问"有什么任务",
 * 两句答案就可能来自不同时刻的状态。这里一次返回,`offer` 里带
 * `status/have/canAccept/canTurnIn` —— UI 不需要再算一遍门槛。
 */

import { NPCS, npcById, type NpcDef, type NpcQuest } from './defs.ts';

/** 任务在**某个玩家账本**里的状态。 */
export type QuestStatus = 'available' | 'accepted' | 'completed';

/**
 * 玩家的 NPC/任务状态(只读快照)。
 *
 * `inventory` 与"背包总量"无关:这里只读**物品 id → 数量**这一个映射,
 * 不关心负重上限/槽位(那是 `carry`/`inventory` 系统的事)。
 */
export interface NpcPlayerState {
  /** 背包:物品 id → 数量。本模块**从不修改**它。 */
  inventory: Readonly<Record<number, number>>;
  /** 任务账本:`questId` → 状态。缺省 = `available`。 */
  quests: Readonly<Record<string, QuestStatus>>;
}

/** 对话返回里的"这次能接/能交吗"。 */
export interface NpcOffer {
  questId: string;
  title: string;
  needItemId: number;
  needCount: number;
  rewardItemId: number;
  rewardCount: number;
  status: QuestStatus;
  /** 背包里已有多少件 `needItemId`。 */
  have: number;
  /** 现在调用 `acceptQuest` 会"接任务"。 */
  canAccept: boolean;
  /** 现在调用 `acceptQuest` 会"交任务并发奖"。 */
  canTurnIn: boolean;
}

/** `talk()` 的返回:一句台词 + (有任务时)报价。 */
export interface NpcTalk {
  line: string;
  offer?: NpcOffer;
}

/** 一次 `acceptQuest` 的结果。 */
export type QuestOutcome =
  | 'UNKNOWN_NPC'
  | 'NO_QUEST'
  | 'ALREADY_COMPLETED'
  | 'NOT_ENOUGH_ITEMS'
  | 'ACCEPTED'
  | 'COMPLETED';

/** 真的发出去的奖励(没发 ⇒ `null`)。 */
export interface QuestReward {
  itemId: number;
  count: number;
}

/** `acceptQuest()` 的返回:新状态 + 这次发了什么 + 判定结果。 */
export interface QuestActionResult {
  /** **新的**状态(入参不被修改)。 */
  state: NpcPlayerState;
  /** 本次真的发出去的奖励;`null` = 什么都没发。 */
  awarded: QuestReward | null;
  outcome: QuestOutcome;
}

/**
 * 未知 `npcId` 的兜底台词。
 *
 * 为什么要有:动作路由迟早会收到过期的/拼错的 npcId(客户端缓存、版本漂移)。
 * 那时**抛错**会让整帧动作失败,`undefined` 会让 UI 显示空白 —— 两者都比
 * "一个人说了句听得懂的话"更糟。所以这里给一条确定性、非空、**不冒充任何 NPC**
 * 的兜底台词。
 */
export const UNKNOWN_NPC_LINE = '(这里没有可以交谈的人。)';

/** 空账本(新玩家)。 */
export function emptyNpcState(): NpcPlayerState {
  return { inventory: {}, quests: {} };
}

/** 某任务在这个账本里的状态(缺省 = `available`)。 */
export function questStatusOf(state: NpcPlayerState, questId: string): QuestStatus {
  return state.quests[questId] ?? 'available';
}

/** 背包里某物品的数量(负数/非数字一律按 0 —— 不信任外部快照)。 */
export function itemCountOf(state: NpcPlayerState, itemId: number): number {
  const n = state.inventory[itemId];
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 台词下标:`available → 0 / accepted → 1 / completed → 2`(超出则回绕)。 */
function lineFor(npc: NpcDef, status: QuestStatus): string {
  const idx = status === 'completed' ? 2 : status === 'accepted' ? 1 : 0;
  /* 理论上不可达:`NPCS` 的 `lines` ≥3 由判据 FND186-2 守着。这里给一条**听得懂**的
     兜底,而不是 `undefined`(后者会让 UI 显示空白,且没有任何东西会报错)。 */
  if (npc.lines.length === 0) return '(无话可说。)';
  return npc.lines[idx % npc.lines.length]!;
}

/** 组装 offer(纯计算,不判门槛的副作用 —— 门槛全在 `acceptQuest`)。 */
function offerOf(quest: NpcQuest, state: NpcPlayerState): NpcOffer {
  const status = questStatusOf(state, quest.id);
  const have = itemCountOf(state, quest.needItemId);
  return {
    questId: quest.id,
    title: quest.title,
    needItemId: quest.needItemId,
    needCount: quest.needCount,
    rewardItemId: quest.rewardItemId,
    rewardCount: quest.rewardCount,
    status,
    have,
    canAccept: status === 'available',
    canTurnIn: status === 'accepted' && have >= quest.needCount,
  };
}

/**
 * 跟一个 NPC 说话:**一句台词 + (有任务时)报价**。
 *
 * 纯函数:输入相同 ⇒ 输出逐字段相同(不取当前时间、不掷骰、不读全局)。
 * 未知 `npcId` ⇒ 兜底台词 + 无 `offer`(**不抛**)。
 */
export function talk(npcId: string, state: NpcPlayerState): NpcTalk {
  const npc = npcById(npcId);
  if (npc === null) return { line: UNKNOWN_NPC_LINE };
  const quest = npc.quest;
  if (quest === undefined) return { line: lineFor(npc, 'available') };
  const status = questStatusOf(state, quest.id);
  return { line: lineFor(npc, status), offer: offerOf(quest, state) };
}

/**
 * **领任务 / 交任务的唯一入口**。
 *
 * 三种正常结果(全部返回**新状态**,入参不被修改):
 * ```text
 * available + 任意背包        → ACCEPTED           awarded = null
 * accepted  + 物品不够        → NOT_ENOUGH_ITEMS   awarded = null
 * accepted  + 物品够          → COMPLETED          awarded = 奖励(唯一一次)
 * completed + 任意            → ALREADY_COMPLETED  awarded = null
 * ```
 * 无任务 / 未知 NPC 也**不抛**:
 * `NO_QUEST` / `UNKNOWN_NPC`,状态原样返回(同一个对象,见下)。
 *
 * ⚠️ 状态"原样返回"是刻意的:没有发生任何变化时返回**同一个对象**,
 * 调用方可以靠 `state === before` 判断"要不要落库"(省一次写盘)。
 */
export function acceptQuest(npcId: string, state: NpcPlayerState): QuestActionResult {
  const npc = npcById(npcId);
  if (npc === null) return { state, awarded: null, outcome: 'UNKNOWN_NPC' };
  const quest = npc.quest;
  if (quest === undefined) return { state, awarded: null, outcome: 'NO_QUEST' };

  const status = questStatusOf(state, quest.id);
  if (status === 'completed') {
    /* ★ 已经交过 ⇒ **绝不**再发奖。(本行是"重复领不许重复发奖"的最后一道闸。) */
    return { state, awarded: null, outcome: 'ALREADY_COMPLETED' };
  }
  if (status === 'available') {
    return {
      state: { inventory: state.inventory, quests: { ...state.quests, [quest.id]: 'accepted' } },
      awarded: null,
      outcome: 'ACCEPTED',
    };
  }
  /* status === 'accepted' */
  const have = itemCountOf(state, quest.needItemId);
  if (have < quest.needCount) {
    return { state, awarded: null, outcome: 'NOT_ENOUGH_ITEMS' };
  }
  return {
    state: { inventory: state.inventory, quests: { ...state.quests, [quest.id]: 'completed' } },
    awarded: { itemId: quest.rewardItemId, count: quest.rewardCount },
    outcome: 'COMPLETED',
  };
}

/** 一行任务进度(给 UI 与判据用)。 */
export interface QuestProgressRow {
  questId: string;
  npcId: string;
  title: string;
  status: QuestStatus;
  /** `completed` ⇔ 已封账(奖励发过了)。 */
  done: boolean;
  needItemId: number;
  needCount: number;
  /** 背包里已有多少件(只读快照,不扣减)。 */
  have: number;
  /** 现在就能交(`accepted` 且物品够)。 */
  ready: boolean;
  rewardItemId: number;
  rewardCount: number;
}

/**
 * 全部任务的进度(按 NPC 声明顺序)。
 *
 * 为什么连 `available` 的也返回:UI 要显示"这条任务存在但还没接";
 * 只返回进行中的会让"账本里有一条 completed"与"账本里根本没有"看起来一样。
 */
export function progressOf(state: NpcPlayerState): QuestProgressRow[] {
  const out: QuestProgressRow[] = [];
  for (const npc of NPCS) {
    const quest = npc.quest;
    if (quest === undefined) continue;
    const status = questStatusOf(state, quest.id);
    const have = itemCountOf(state, quest.needItemId);
    out.push({
      questId: quest.id,
      npcId: npc.id,
      title: quest.title,
      status,
      done: status === 'completed',
      needItemId: quest.needItemId,
      needCount: quest.needCount,
      have,
      ready: status === 'accepted' && have >= quest.needCount,
      rewardItemId: quest.rewardItemId,
      rewardCount: quest.rewardCount,
    });
  }
  return out;
}