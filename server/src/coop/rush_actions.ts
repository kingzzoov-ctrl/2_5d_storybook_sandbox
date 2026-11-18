/**
 * ★ WS-FND-120 · 急单动作层的**读口与小台账**
 *
 * ## 修的是什么(第六轮实测 P1/P2)
 *
 * · `startRushOrder` / `submitDelivery` / `settleSession` 在生产里**零调用**
 *   (`settleSession` 连一处引用都没有 ⇒ `RUSH_GRADE` 永远传不出去);
 * · 世界侧(`sim/world_sim.ts`)只推进 `tickRushOrder`,于是「开工」「交付」「结算回执」
 *   三段全靠测试推。
 *
 * 本文件只提供**动作层与世界侧共用的读口**(订单还差什么、奖励落哪、台账),
 * 判定闸在 `party/actions.ts#gateRushStart` / `gateRushDelivery` —— 两份判定迟早漂移,
 * 故这里**不再判一次**。
 *
 * ## 数值锚(没有新发明的数)
 *
 * | 常量 | 值 | 锚 |
 * | :--- | :--- | :--- |
 * | `RUSH_ENTRY_ROOM_LEVEL` | 1 | `generateOrderBoard` 的 `Math.max(1, Math.round(roomLevel))` 下界 |
 * | `RUSH_DELIVERY_RADIUS` | 1 | 「脚下这一格」= 交付时人与货同格;与 `takeGroundItemNear` 的单格口径一致 |
 *
 * 房间等级本应由**房间侧**注入(房间有 level,世界不持有)—— 那一支仍是欠账,
 * 登记在 `RUSH_ACTION_LEDGER` 的 `EXTRA` 行里。
 */

import { RUSH_ORDER_STATE, type RushOrderSession } from './rush_order.ts';

/** 世界侧开急单时的房间等级:**最低档**(`generateOrderBoard` 的 lv 下界)。 */
export const RUSH_ENTRY_ROOM_LEVEL = 1;

/** 交付半径(格):人与货同格才算「递到手里」。 */
export const RUSH_DELIVERY_RADIUS = 1;

/** 一条还没交满的订单。 */
export interface OpenOrderLine {
  itemId: number;
  need: number;
  delivered: number;
  remaining: number;
  points: number;
}

/** 订单板上**还要货**的行(按槽位顺序)。交付判定只认这些行。 */
export function openOrderLines(s: RushOrderSession): OpenOrderLine[] {
  const out: OpenOrderLine[] = [];
  for (const slot of s.board.slots) {
    const remaining = Math.max(0, slot.need - slot.delivered);
    if (remaining <= 0) continue;
    out.push({
      itemId: slot.itemId, need: slot.need, delivered: slot.delivered, remaining, points: slot.points,
    });
  }
  return out;
}

/** 订单是否还没收工(开工前 / 收工后都不接受交付)。 */
export function rushAcceptsDelivery(s: RushOrderSession): boolean {
  return s.state === RUSH_ORDER_STATE.RUNNING && openOrderLines(s).length > 0;
}

/** 奖励落地点:第一台在场工位的世界格(没有工位 ⇒ null,调用方不得凭空掉落)。 */
export function rushRewardCellOf(s: RushOrderSession): { x: number; y: number } | null {
  for (const st of s.stations) {
    const cell = s.stationCells[st.kind];
    if (cell !== undefined) return { x: cell.x, y: cell.y };
  }
  return null;
}

export interface RushActionRow {
  step: string;
  /** `WIRED:<call site>` / `EXTRA:<欠哪一步>` */
  path: string;
  note: string;
}

/**
 * 急单三段(+ 两段欠账)的**具名台账**。判据见 `tests/WS-FND-120`,
 * 反向断言:`WIRED:` 的调用点必须能在 `sim/world_sim.ts` 里找到。
 */
export const RUSH_ACTION_LEDGER: readonly RushActionRow[] = [
  {
    step: 'START',
    path: 'WIRED:world_sim.tickPartyStep -> startRushRun',
    note: `COZY_CANTEEN 建成 + 三工位在场 + 有人站在工位格 ⇒ 开工,房间等级取 ${RUSH_ENTRY_ROOM_LEVEL}`,
  },
  {
    step: 'DELIVER',
    path: 'WIRED:world_sim.tickPartyStep -> submitDelivery',
    note: '玩家脚下 1 格内有订单点名的地面货 ⇒ 扣货 + 交付(过 gateRushDelivery)',
  },
  {
    step: 'SETTLE',
    path: 'WIRED:world_sim.tickPartyStep -> settleSession',
    note: '状态变 SETTLED 的那一慢帧结算一次,回执 `rushSettlement()`,奖励落 `rushRewardCellOf`',
  },
  {
    step: 'ROOM_LEVEL',
    path: 'EXTRA:房间侧 START_PARTY 动作(不在本任务写域)',
    note: '真实房间等级由房间注入;世界侧今天只能取最低档',
  },
  {
    step: 'RELAY_CHAIN',
    path: 'EXTRA:接力链需要「扔 / 接」的动作输入',
    note: '`advanceRelayChain` 需要 stage + 投掷参数,世界侧没有输入口',
  },
];