/**
 * ★ WS-FND-120 · 派对 / 急单的**动作层闸门**(权限 + 前置校验)
 *
 * ## 修的是什么(第六轮实测 P1)
 *
 * `startPartyRun` / `startRushRun` / `setPlayerDozing` 在生产里**零调用** ⇒
 * `partyRun` / `rushRun` / `afkRuns` 恒空,三个 `tick*` 永远走空分支;
 * 而 `bridgeCapture` / `crownPickup` / `submitDelivery` 这三个「核心动作」
 * 也只有测试在推。根因不是「函数写错了」,是**没有入口**:
 * 谁会开局、谁能夺旗、提交几件 —— 这些判定一条都不存在。
 *
 * 本文件就是那一层:**纯判定**,不推进状态、不读世界、不写世界。
 * 世界侧(`sim/world_sim.ts` 的 party/coop/afk 段)每慢帧从**世界事实**
 * (436 哨台上的玩家、435 复活旗的队伍、434 座上的玩家、地上的货)算出输入,
 * 先过这里的闸,再调真正的动作函数。
 *
 * ## 为什么判定单独成文件(而不是写在 world_sim 里)
 *
 * 1 可单测:每条闸都能用「同一世界、只改一个输入」两极性验证;
 * 2 只有一份:世界侧**不许**再判一次(两份判定=迟早漂移,本仓的老病灶);
 * 3 方向:只 import `party/modes.ts`、`coop/rush_order.ts`、`prank/actions.ts`
 *   与自身,不 import `net/**`、`physics/**`、`combat/**`。
 *
 * ## 具名台账(唯一入口:`PARTY_ACTION_LEDGER`)
 *
 * 每个动作逐条写清**生产里谁在调**:`WIRED:<call site>` 或 `NONE:<欠哪一步>`。
 * 「注释说已生效」不算 —— `tests/WS-FND-120` 直接按这张表断言。
 */

import {
  BRIDGE_TILES_TO_WIN,
  CROWN_PICKUP_COOLDOWN_SEC,
  PARTY_MODE_KEY,
  PARTY_PHASE,
  type PartyPhase,
} from './modes.ts';
import { RUSH_ORDER_STATE, type RushOrderState } from '../coop/rush_order.ts';
import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
import {
  PRANK_REJECT,
  resolveCrownKnock,
  resolvePrankAction,
  type CrownKnockOutcome,
  type PrankActionOutcome,
} from '../prank/actions.ts';
import type { TeamKey } from './scoring.ts';

/** 动作词表。**新增动作必须同时登记台账**(自检会红)。 */
export const PARTY_ACTION = {
  START_PARTY: 'START_PARTY',
  STOP_PARTY: 'STOP_PARTY',
  PLACE_BOARD: 'PARTY_PLACE_BOARD',
  CAPTURE_FLAG: 'PARTY_CAPTURE_FLAG',
  CROWN_PICKUP: 'PARTY_CROWN_PICKUP',
  CROWN_KNOCK: 'PARTY_CROWN_KNOCK',
  RUSH_START: 'RUSH_ORDER_START',
  RUSH_DELIVER: 'RUSH_ORDER_DELIVER',
  RUSH_SETTLE: 'RUSH_ORDER_SETTLE',
  PRANK: 'PRANK_TOY_USE',
} as const;
export type PartyAction = (typeof PARTY_ACTION)[keyof typeof PARTY_ACTION];

/** 拒绝原因(大写下划线,可直接进报文/日志)。 */
export const GATE_REJECT = {
  OK: 'OK',
  UNKNOWN_MODE: 'UNKNOWN_MODE',
  NO_REFEREE: 'NO_REFEREE_AT_DESK',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  NOT_RUNNING: 'NOT_RUNNING',
  WRONG_PHASE: 'WRONG_PHASE',
  NO_TEAM: 'NO_TEAM_BANNER',
  NOT_ENOUGH_TILES: 'NOT_ENOUGH_TILES',
  ALREADY_FLAGGED: 'ALREADY_FLAGGED',
  CROWN_HELD: 'CROWN_HELD',
  CROWN_COOLDOWN: 'CROWN_COOLDOWN',
  CROWN_WON: 'CROWN_WON',
  NOT_AT_PEDESTAL: 'NOT_AT_PEDESTAL',
  STATIONS_NOT_READY: 'STATIONS_NOT_READY',
  NOT_AT_STATION: 'NOT_AT_STATION',
  NOT_ORDERED: 'NOT_ORDERED',
  QTY_INVALID: 'QTY_INVALID',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
} as const;
export type GateReject = (typeof GATE_REJECT)[keyof typeof GATE_REJECT];

export interface ActionGate {
  ok: boolean;
  reason: GateReject | string;
}

const PASS: ActionGate = { ok: true, reason: GATE_REJECT.OK };
function deny(reason: GateReject | string): ActionGate {
  return { ok: false, reason };
}

/* ═══════════════════════ 1. 派对开局 / 收局 ═══════════════════════ */

/** 436 哨台的收局命令(与 `components.ts#ARENA_REFEREE_DESK` 的 `cmd === -1` 同源)。 */
export const REFEREE_DESK_STOP_MODE = -1;

/**
 * 436 哨台的 `params.mode`(1..4)→ 冻结层 `PARTY_MODES` 的模式 key。
 *
 * 为什么从冻结层**顺序**取而不是自己写一张映射表:哨台是「一键开启四种竞技模式」
 * (`shared/constants/items.ts:274`),四种模式的权威顺序在 `PARTY_MODES` 里;
 * 另写一张 `1->BRIDGE,2->JELLY...` 的表,改顺序时两边会静默分叉。
 * 表外(0 / -1 / 5+)⇒ `null`(调用方按「不命令」处理)。
 */
export function deskModeKey(mode: number): string | null {
  const i = Math.trunc(mode) - 1;
  if (!Number.isFinite(i) || i < 0 || i >= PARTY_MODES.length) return null;
  return PARTY_MODES[i].key;
}

/**
 * **权限**:只有**站在 436 派対裁判控制哨台上**的玩家能开局/收局(手册 §6.3
 * 「一键开启」的主体是裁判)。**前置**:模式必须是冻结层 `PARTY_MODES` 的 key,
 * 且同房间不许叠开两局(叠开会让两局的播报/记分串成一锅,且不报错)。
 */
export function gatePartyStart(p: {
  modeKey: string;
  refereeId: string;
  /** 该玩家此刻是否站在哨台格上(世界侧用权威坐标判) */
  refereeAtDesk: boolean;
  runActive: boolean;
}): ActionGate {
  const known = Object.values(PARTY_MODE_KEY) as string[];
  if (!known.includes(p.modeKey)) return deny(GATE_REJECT.UNKNOWN_MODE);
  if (p.refereeId === '' || !p.refereeAtDesk) return deny(GATE_REJECT.NO_REFEREE);
  if (p.runActive) return deny(GATE_REJECT.ALREADY_RUNNING);
  return PASS;
}

/** 收局:**同一名裁判**才能收(别人按哨台不许把别人的局停掉)。 */
export function gatePartyStop(p: {
  refereeId: string;
  actorId: string;
  refereeAtDesk: boolean;
  runActive: boolean;
}): ActionGate {
  if (!p.runActive) return deny(GATE_REJECT.NOT_RUNNING);
  if (p.actorId !== p.refereeId) return deny(GATE_REJECT.NO_REFEREE);
  if (!p.refereeAtDesk) return deny(GATE_REJECT.NO_REFEREE);
  return PASS;
}

/* ═══════════════════════ 2. 造桥:铺板 / 夺旗 ═══════════════════════ */

/** 铺板:只在**建造阶段**、且知道是哪一队(435 复活旗选色)时才许铺。 */
export function gateBridgePlace(p: { phase: PartyPhase; team: TeamKey | null }): ActionGate {
  if (p.phase !== PARTY_PHASE.BUILD) return deny(GATE_REJECT.WRONG_PHASE);
  if (p.team === null) return deny(GATE_REJECT.NO_TEAM);
  return PASS;
}

/**
 * 夺旗:冲刺阶段 + 本队桥板够 `BRIDGE_TILES_TO_WIN` + 还没夺过。
 * 桥板数从**容器**读(`modes.ts#contestBuiltOf`),闸不自己维护第二份计数。
 */
export function gateBridgeCapture(p: {
  phase: PartyPhase;
  team: TeamKey | null;
  builtTiles: number;
  alreadyFlagged: boolean;
}): ActionGate {
  if (p.phase !== PARTY_PHASE.RACE) return deny(GATE_REJECT.WRONG_PHASE);
  if (p.team === null) return deny(GATE_REJECT.NO_TEAM);
  if (p.alreadyFlagged) return deny(GATE_REJECT.ALREADY_FLAGGED);
  if (p.builtTiles < BRIDGE_TILES_TO_WIN) return deny(GATE_REJECT.NOT_ENOUGH_TILES);
  return PASS;
}

/* ═══════════════════════ 3. 抢皇冠:拾冠 / 掉冠 ═══════════════════════ */

/** 拾冠:得站在 434 底座上、有队伍、枪没人持、不在冷却、还没出胜者。 */
export function gateCrownPickup(p: {
  phase: PartyPhase;
  team: TeamKey | null;
  atPedestal: boolean;
  holder: string | null;
  cooldownSec: number;
  winner: TeamKey | null;
}): ActionGate {
  if (p.phase === PARTY_PHASE.IDLE || p.phase === PARTY_PHASE.SETTLED) return deny(GATE_REJECT.WRONG_PHASE);
  if (!p.atPedestal) return deny(GATE_REJECT.NOT_AT_PEDESTAL);
  if (p.team === null) return deny(GATE_REJECT.NO_TEAM);
  if (p.winner !== null) return deny(GATE_REJECT.CROWN_WON);
  if (p.holder !== null) return deny(GATE_REJECT.CROWN_HELD);
  if (p.cooldownSec > 0) return deny(GATE_REJECT.CROWN_COOLDOWN);
  return PASS;
}

/**
 * 掉冠:持冠者被整蛊玩具击退 ⇒ 走 `prank/actions.ts#resolveCrownKnock`。
 * 218 和平盾开着且三件候选全被拦 ⇒ 不掉冠(手册 §3.4「和平盾免疫香蕉皮」)。
 */
export function gateCrownKnock(p: { knockback: boolean; shieldOn: boolean }): {
  gate: ActionGate;
  knock: CrownKnockOutcome | null;
} {
  if (!p.knockback) return { gate: deny(GATE_REJECT.NOT_RUNNING), knock: null };
  const knock = resolveCrownKnock({ shieldOn: p.shieldOn });
  if (!knock.drop) return { gate: deny(PRANK_REJECT.SHIELDED), knock };
  return { gate: PASS, knock };
}

/* ═══════════════════════ 4. 急单:开工 / 交付 ═══════════════════════ */

/**
 * 急单开工:**三个工位都在场**(锅 / 炉 / 切菜台,即 `startRushRun` 需要的
 * 世界格)且**有人站在工位旁**(「开工」的手),且当前没有在跑的急单。
 */
export function gateRushStart(p: {
  state: RushOrderState;
  stationsReady: boolean;
  actorAtStation: boolean;
}): ActionGate {
  if (p.state !== RUSH_ORDER_STATE.IDLE) return deny(GATE_REJECT.ALREADY_RUNNING);
  if (!p.stationsReady) return deny(GATE_REJECT.STATIONS_NOT_READY);
  if (!p.actorAtStation) return deny(GATE_REJECT.NOT_AT_STATION);
  return PASS;
}

/**
 * 交付:急单在跑 + 那张订单还要这件货 + 数量合法 + 人在货旁边。
 * `remaining` 由订单板算(`slot.need - slot.delivered`),闸不自己记进度。
 */
export function gateRushDelivery(p: {
  state: RushOrderState;
  remaining: number;
  qty: number;
  distance: number;
  radius: number;
}): ActionGate {
  if (p.state !== RUSH_ORDER_STATE.RUNNING) return deny(GATE_REJECT.NOT_RUNNING);
  if (p.remaining <= 0) return deny(GATE_REJECT.NOT_ORDERED);
  if (!Number.isFinite(p.qty) || p.qty <= 0) return deny(GATE_REJECT.QTY_INVALID);
  if (!Number.isFinite(p.distance) || p.distance > p.radius) return deny(GATE_REJECT.OUT_OF_RANGE);
  return PASS;
}

/* ═══════════════════════ 5. 整蛊(转发到 prank/actions) ═══════════════════════ */

/** 整蛊动作的唯一闸口:权限(不能打自己)+ 前置(表内 / 半径 / 盾)。 */
export function gatePrank(p: {
  actorId: string;
  targetId: string;
  toyId: number;
  distance: number;
  ally: boolean;
  shieldOn: boolean;
}): PrankActionOutcome {
  return resolvePrankAction(p);
}

/* ═══════════════════════ 6. 具名台账 ═══════════════════════ */

export interface ActionLedgerRow {
  action: PartyAction;
  /** `WIRED:<call site>` 或 `NONE:<欠哪一步>` */
  path: string;
  note: string;
}

/**
 * **生产里谁调它**。这份表是 `tests/WS-FND-120` 的判据来源:
 * 说 `WIRED:` 的行必须真的能在生产源码里找到调用点(反向断言),
 * 说 `NONE:` 的行不许出现在任何「已生效」的表述里。
 */
export const PARTY_ACTION_LEDGER: readonly ActionLedgerRow[] = [
  {
    action: PARTY_ACTION.START_PARTY,
    path: 'WIRED:world_sim.tickPartyStep -> startPartyRun',
    note: '436 哨台 params.mode ∈ 1..4 且**有玩家站在哨台格上** ⇒ 开局,裁判 = 那个玩家',
  },
  {
    action: PARTY_ACTION.STOP_PARTY,
    path: 'WIRED:world_sim.tickPartyStep -> clearPartyRun',
    note: '哨台 params.mode = -1 时**同一名裁判**收局(先结算再清空)',
  },
  {
    action: PARTY_ACTION.PLACE_BOARD,
    path: 'WIRED:world_sim.tickPartyStep -> contestPlaceBoard',
    note: '建造阶段:玩家脚下 1 格内有 152 木板 ⇒ 消耗 1 块并铺 1 块桥板',
  },
  {
    action: PARTY_ACTION.CAPTURE_FLAG,
    path: 'WIRED:world_sim.tickPartyStep -> contestCapture',
    note: '冲刺阶段:玩家站上 435 复活旗且本队桥板 ≥ 12 ⇒ 夺旗',
  },
  {
    action: PARTY_ACTION.CROWN_PICKUP,
    path: 'WIRED:world_sim.tickPartyStep -> contestCrownPickup',
    note: '玩家站在 434 金皇冠底座格且队伍已由 435 复活旗登记 ⇒ 拾冠',
  },
  {
    action: PARTY_ACTION.CROWN_KNOCK,
    path: 'WIRED:world_sim.tickPartyStep -> contestCrownDrop',
    note: '持冠者进入击退窗口(`knockbackOf`)⇒ 过 prank 掉冠判定(218 盾可拦)',
  },
  {
    action: PARTY_ACTION.RUSH_START,
    path: 'WIRED:world_sim.tickPartyStep -> startRushRun',
    note: 'COZY_CANTEEN 房间建成 + 三个工位在场 + 有玩家站在工位格上 ⇒ 开工(房间等级取最低档)',
  },
  {
    action: PARTY_ACTION.RUSH_DELIVER,
    path: 'WIRED:world_sim.tickPartyStep -> submitDelivery',
    note: '急单在跑:玩家脚下 1 格内有该订单点名的货 ⇒ 扣地面货 + 交付',
  },
  {
    action: PARTY_ACTION.RUSH_SETTLE,
    path: 'WIRED:world_sim.tickPartyStep -> settleSession',
    note: '急单状态到 SETTLED 的那一慢帧结算一次(回执 `rushSettlement()`),奖励落到工位格地面',
  },
  {
    action: PARTY_ACTION.PRANK,
    path: 'NONE:net/actions/use_item 的 221..255 分支',
    note: '玩具对玩家的施加入口在动作层(`useItem`),不在本任务写域;世界侧目前只走「掉冠」这一条(见 CROWN_KNOCK)',
  },
];

/** 台账里标成 `WIRED:` 的动作(反向断言用)。 */
export function wiredActions(): PartyAction[] {
  return PARTY_ACTION_LEDGER.filter((r) => r.path.startsWith('WIRED:')).map((r) => r.action);
}

/** 台账里标成 `NONE:` 的动作(可读的欠账清单)。 */
export function unwiredActions(): PartyAction[] {
  return PARTY_ACTION_LEDGER.filter((r) => r.path.startsWith('NONE:')).map((r) => r.action);
}

/** 自检:词表与台账**逐个**对齐(新增动作忘了登记 ⇒ 抛错,不静默漏一行)。 */
function assertActionLedgerComplete(): void {
  const all = Object.values(PARTY_ACTION).sort();
  const rows = PARTY_ACTION_LEDGER.map((r) => r.action).sort();
  if (all.join(',') !== rows.join(',')) {
    throw new Error(`动作台账与词表不一致:${rows.join(',')} vs ${all.join(',')}`);
  }
  for (const r of PARTY_ACTION_LEDGER) {
    if (r.path === 'NONE:' || r.path === 'WIRED:') throw new Error(`动作 ${r.action} 的台账行没写清路径`);
    if (!r.path.startsWith('WIRED:') && !r.path.startsWith('NONE:')) {
      throw new Error(`动作 ${r.action} 的台账 path 必须以 WIRED:/NONE: 开头(实测 ${r.path})`);
    }
  }
}
assertActionLedgerComplete();

/** 与 `CROWN_PICKUP_COOLDOWN_SEC` 同源的重导出,便于动作层与文案取同一份数。 */
export const CROWN_COOLDOWN_SEC = CROWN_PICKUP_COOLDOWN_SEC;