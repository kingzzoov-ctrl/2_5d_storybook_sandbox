/**
 * WS-11 · 胡闹工坊「急单」子系统(设计手册 §6.1 / §6.2)
 *
 * 覆盖:
 *  1. 3 分钟限时急单状态机 + 可复现订单生成器(按房间等级与库存动态选品)+ 交付判定与评级;
 *  2. 高炉 / 汤锅「连续运转 12 秒不翻炒 → 起火冒烟」+ 227 水枪灭火计时(0.5 秒恢复);
 *  3. 急单期间刷新的「偷木板河狸」事件与 222 充气大锤敲晕夺回;
 *  4. 投掷接力链(砍树→隔河扔→空中完美接球→切木机→扔给队友拍地基)的完整事件流与链中断惩罚;
 *  5. 4 人叠罗汉搭人梯(Z=2 果实 / 登 Boss 背部)的高度与移速解算。
 *
 * 硬约束:零运行时依赖;仅调用 `shared/types/physics.ts` 冻结函数(不改 WS-02 任何文件);
 *         禁止 enum / 参数属性 / namespace;相对导入带 `.ts`。
 */

import {
  THROW_SPEED_XY,
  CATCH_RADIUS,
  CARRY_MAX_DEPTH,
  CARRY_Z_STEP,
  CARRY_SLOWDOWN,
  CATCH_Z_MIN,
  CATCH_Z_MAX,
  THROW_SPEED_Z,
  GRAVITY,
  TICK_HZ,
  DT,
  canPerfectCatch,
  stackOffset,
  carrierSpeedMul,
} from '../../../shared/types/physics.ts';
import { ITEM_BY_ID } from '../../../shared/constants/items.ts';

/** 浮点容差:20Hz 逐帧累加后用于比较阈值。 */
export const EPS = 1e-9;

/* ═══════════════════════════════════════════════════════════════════════
 * 0. 可注入时钟(测试里绝不真 sleep)
 * ═══════════════════════════════════════════════════════════════════════ */

export interface Clock {
  /** 返回当前逻辑时间,单位秒。 */
  now(): number;
}

export interface ManualClock extends Clock {
  /** 手动推进逻辑时间,返回推进后的时间。 */
  advance(sec: number): number;
  /** 直接设定逻辑时间。 */
  set(t: number): void;
}

export function createManualClock(startSec = 0): ManualClock {
  let t = startSec;
  return {
    now: (): number => t,
    advance: (sec: number): number => {
      t += sec;
      return t;
    },
    set: (v: number): void => {
      t = v;
    },
  };
}

/** 稳定伪随机源签名(测试传 `mulberry32(seed)`)。 */
export type Rng = () => number;

/* ═══════════════════════════════════════════════════════════════════════
 * 1. 急单订单生成器(可复现)
 * ═══════════════════════════════════════════════════════════════════════ */

/** §6.1:急单整场限时 3 分钟。 */
export const RUSH_ORDER_DURATION_SEC = 180;

export const RUSH_ORDER_STATE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  SETTLED: 'SETTLED',
} as const;
export type RushOrderState = (typeof RUSH_ORDER_STATE)[keyof typeof RUSH_ORDER_STATE];

/**
 * 订单候选池:自然材料(101~130 子集)+ 半成品(151~170 子集)。
 * 全部 ID 必须命中冻结层 `ITEM_BY_ID`,由 `assertOrderPoolClosed()` 在启动时自检。
 */
export const ORDER_POOL: readonly number[] = [
  101, 103, 106, 109, 110, 116, 117,
  151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162,
];

export const ORDER_SLOT_MIN = 2;
export const ORDER_SLOT_MAX = 4;
/** 每 5 级开放 1 个订单位。 */
export const ROOM_LEVEL_PER_SLOT = 5;
export const ORDER_NEED_MIN = 1;
export const ORDER_NEED_MAX = 4;
/** 库存压力单位:手上越少的东西越容易被点名。 */
export const STOCK_PRESSURE_UNIT = 10;
/** 每高 1 级,订单分值 +8%。 */
export const ORDER_LEVEL_VALUE_STEP = 0.08;

/** 评级阈值(按订单完成度)。 */
export const RUSH_GRADE_THRESHOLDS = { S: 1.0, A: 0.75, B: 0.5 } as const;
export const RUSH_GRADE = { S: 'S', A: 'A', B: 'B', C: 'C' } as const;
export type RushGrade = (typeof RUSH_GRADE)[keyof typeof RUSH_GRADE];

export interface RushOrderSlot {
  itemId: number;
  /** 物品名(取自冻结层 ITEM_BY_ID,不硬编码)。 */
  name: string;
  /** 需求数量 */
  need: number;
  /** 已交付数量 */
  delivered: number;
  /** 单件基础价值 V_i */
  unitValue: number;
  /** 选品权重 = V_i × 稀缺系数 × 等级系数 */
  weight: number;
  /** 满分分值 */
  points: number;
}

export interface RushOrderBoard {
  roomLevel: number;
  seed: number;
  slots: RushOrderSlot[];
  /** 全单满分合计 */
  totalPoints: number;
}

/** 订单池引用闭包自检:任何 ID 不在冻结层配表即抛错。 */
export function assertOrderPoolClosed(pool: readonly number[] = ORDER_POOL): void {
  for (const id of pool) {
    if (!ITEM_BY_ID.has(id)) throw new Error(`ORDER_POOL 悬空引用物品 ID ${id}`);
  }
  if (new Set(pool).size !== pool.length) throw new Error('ORDER_POOL 存在重复 ID');
}

function pickWeighted(cands: readonly RushOrderSlot[], rng: Rng): number {
  let total = 0;
  for (const c of cands) total += c.weight;
  let r = rng() * total;
  for (let i = 0; i < cands.length; i += 1) {
    r -= cands[i].weight;
    if (r <= 0) return i;
  }
  return cands.length - 1;
}

/**
 * 订单生成器(确定性)。
 *
 * - 订单位数量 `slots = clamp(2 + ?0, 2..4)`,由房间等级决定;
 * - 候选权重 `w = V_i × (1 + (STOCK_PRESSURE_UNIT − min(stock,10)) / STOCK_PRESSURE_UNIT) × (1 + 0.08(Lv−1))`;
 * - 需求数量 `need = 1 + floor(rng() × min(Lv,12)/3)`,截断到 [1,4];
 * - 同一 rng 序列 + 同一入参 ⇒ 完全一致的订单板(可复现)。
 */
export function generateOrderBoard(
  rng: Rng,
  roomLevel: number,
  stock: Readonly<Record<number, number>> = {},
  seed = 0,
  pool: readonly number[] = ORDER_POOL,
): RushOrderBoard {
  const lv = Math.max(1, Math.round(roomLevel));
  const slotCount = Math.max(
    ORDER_SLOT_MIN,
    Math.min(ORDER_SLOT_MAX, ORDER_SLOT_MIN + Math.floor((lv - 1) / ROOM_LEVEL_PER_SLOT)),
  );

  const levelMul = 1 + ORDER_LEVEL_VALUE_STEP * (lv - 1);
  const remain: RushOrderSlot[] = pool.map((id) => {
    const def = ITEM_BY_ID.get(id);
    if (!def) throw new Error(`订单池含未知物品 ${id}`);
    const held = Math.min(STOCK_PRESSURE_UNIT, Math.max(0, stock[id] ?? 0));
    const scarcity = 1 + (STOCK_PRESSURE_UNIT - held) / STOCK_PRESSURE_UNIT;
    return {
      itemId: id,
      name: def.name,
      need: ORDER_NEED_MIN,
      delivered: 0,
      unitValue: def.value,
      weight: def.value * scarcity * levelMul,
      points: 0,
    };
  });

  const slots: RushOrderSlot[] = [];
  for (let i = 0; i < slotCount && remain.length > 0; i += 1) {
    const idx = pickWeighted(remain, rng);
    const chosen = remain.splice(idx, 1)[0];
    const span = Math.max(0, Math.floor(Math.min(lv, 12) / 3));
    const need = Math.max(ORDER_NEED_MIN, Math.min(ORDER_NEED_MAX, ORDER_NEED_MIN + Math.floor(rng() * (span + 1))));
    chosen.need = need;
    chosen.points = Math.round(chosen.unitValue * need * levelMul);
    slots.push(chosen);
  }

  const totalPoints = slots.reduce((a, s) => a + s.points, 0);
  return { roomLevel: lv, seed, slots, totalPoints };
}

export interface DeliverResult {
  accepted: boolean;
  itemId: number;
  /** 实际回收数量 */
  consumed: number;
  /** 本次获得分值 */
  points: number;
  slotFilled: boolean;
  reason: string;
}

/** 交付判定:同一物品可能被多张订单点名,按槽位顺序消耗。 */
export function deliverItem(board: RushOrderBoard, itemId: number, qty: number): DeliverResult {
  if (qty <= 0) {
    return { accepted: false, itemId, consumed: 0, points: 0, slotFilled: false, reason: 'QTY_INVALID' };
  }
  const slot = board.slots.find((s) => s.itemId === itemId && s.delivered < s.need);
  if (!slot) {
    return { accepted: false, itemId, consumed: 0, points: 0, slotFilled: false, reason: 'NOT_ORDERED' };
  }
  const remaining = slot.need - slot.delivered;
  const consumed = Math.min(qty, remaining);
  slot.delivered += consumed;
  const perUnit = slot.points / slot.need;
  const points = Math.round(perUnit * consumed);
  return {
    accepted: true,
    itemId,
    consumed,
    points,
    slotFilled: slot.delivered >= slot.need,
    reason: 'OK',
  };
}

/** 订单完成度 ∈ [0,1],按需求件数加权。 */
export function boardProgress(board: RushOrderBoard): number {
  let need = 0;
  let got = 0;
  for (const s of board.slots) {
    need += s.need;
    got += Math.min(s.delivered, s.need);
  }
  if (need === 0) return 0;
  return got / need;
}

export function gradeOf(progress: number): RushGrade {
  if (progress >= RUSH_GRADE_THRESHOLDS.S - EPS) return RUSH_GRADE.S;
  if (progress >= RUSH_GRADE_THRESHOLDS.A - EPS) return RUSH_GRADE.A;
  if (progress >= RUSH_GRADE_THRESHOLDS.B - EPS) return RUSH_GRADE.B;
  return RUSH_GRADE.C;
}

export interface RushSettlement {
  grade: RushGrade;
  progress: number;
  score: number;
  /** 奖励物品 ID -> 数量 */
  rewards: Record<number, number>;
}

const REWARD_TABLE: Readonly<Record<RushGrade, Record<number, number>>> = {
  S: { 130: 3, 601: 2 },
  A: { 130: 2, 601: 1 },
  B: { 130: 1 },
  C: {},
};

export function settleRushOrder(board: RushOrderBoard, elapsedSec: number): RushSettlement {
  const progress = boardProgress(board);
  const grade = gradeOf(progress);
  const timeBonus = elapsedSec < RUSH_ORDER_DURATION_SEC / 2 ? 1.15 : 1.0;
  const score = Math.round(board.totalPoints * progress * timeBonus);
  return { grade, progress, score, rewards: { ...REWARD_TABLE[grade] } };
}

/* ═══════════════════════════════════════════════════════════════════════
 * 2. 高炉 / 汤锅过热起火与灭火
 * ═══════════════════════════════════════════════════════════════════════ */

export const STATION_KIND = {
  FURNACE: 'FURNACE',
  POT: 'POT',
  CUTTER: 'CUTTER',
} as const;
export type StationKind = (typeof STATION_KIND)[keyof typeof STATION_KIND];

export const STATION_STATE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  BURNING: 'BURNING',
  EXTINGUISHING: 'EXTINGUISHING',
} as const;
export type StationState = (typeof STATION_STATE)[keyof typeof STATION_STATE];

/** 连续运转 12 秒不翻炒 ⇒ 起火冒烟。 */
export const OVERHEAT_SEC = 12;
/** 227 水枪持续喷射 0.5 秒 ⇒ 恢复正常运转。 */
export const EXTINGUISH_SEC = 0.5;
/** 起火期间每秒对周围玩家造成的灼烧伤害。 */
export const BURN_DAMAGE_PER_SEC = 6;
/** 起火后 0.5 秒开始冒烟(视觉事件)。 */
export const SMOKE_LEAD_SEC = 0.5;

export const EVT_FIRE = 'STATION_FIRE';
export const EVT_DOUSED = 'STATION_DOUSED';
export const EVT_SMOKE = 'STATION_SMOKE';

export interface StationRuntime {
  kind: StationKind;
  state: StationState;
  /** 本轮连续运转秒数(翻炒即归零) */
  runningSec: number;
  /** 已燃烧秒数 */
  burningSec: number;
  /** 灭火累计秒数 */
  dousedSec: number;
  /** 累计被照看秒数 */
  tendedSec: number;
  /** 累计起火次数 */
  fireCount: number;
  /** 累计灼烧伤害 */
  burnDamage: number;
}

export function createStation(kind: StationKind): StationRuntime {
  return {
    kind,
    state: STATION_STATE.IDLE,
    runningSec: 0,
    burningSec: 0,
    dousedSec: 0,
    tendedSec: 0,
    fireCount: 0,
    burnDamage: 0,
  };
}

export function startStation(s: StationRuntime): void {
  if (s.state === STATION_STATE.IDLE) s.state = STATION_STATE.RUNNING;
}

/** 翻炒(212 大铁铲 / 玩家互动):清零过热计时。`dt` 用于累计照看时长。 */
export function tendStation(s: StationRuntime, dt = 0): void {
  if (s.state !== STATION_STATE.RUNNING) return;
  s.runningSec = 0;
  if (dt > 0) s.tendedSec += dt;
}

/**
 * 单步推进(推荐 dt = 0.5s 的低频帧)。
 *
 * @param tended  本步内是否被翻炒
 * @param spraying 本步内是否被 227 泡泡连发水枪喷射
 * @returns 本步产生的事件名列表(供全房播报)
 */
export function tickStation(s: StationRuntime, dt: number, tended = false, spraying = false): string[] {
  const ev: string[] = [];
  if (dt <= 0 || s.state === STATION_STATE.IDLE) return ev;

  if (s.state === STATION_STATE.BURNING || s.state === STATION_STATE.EXTINGUISHING) {
    if (spraying) {
      s.state = STATION_STATE.EXTINGUISHING;
      s.dousedSec += dt;
      if (s.dousedSec >= EXTINGUISH_SEC - EPS) {
        s.state = STATION_STATE.RUNNING;
        s.runningSec = 0;
        s.burningSec = 0;
        s.dousedSec = 0;
        ev.push(EVT_DOUSED);
      }
    } else {
      /* 间断灭火:计时归零,并且退回纯燃烧状态 */
      s.state = STATION_STATE.BURNING;
      s.dousedSec = 0;
      s.burningSec += dt;
      s.burnDamage += BURN_DAMAGE_PER_SEC * dt;
      if (s.burningSec >= SMOKE_LEAD_SEC - EPS && s.burningSec - dt < SMOKE_LEAD_SEC - EPS) {
        ev.push(EVT_SMOKE);
      }
    }
    return ev;
  }

  if (tended) {
    s.runningSec = 0;
    s.tendedSec += dt;
    return ev;
  }

  s.runningSec += dt;
  if (s.runningSec >= OVERHEAT_SEC - EPS) {
    s.state = STATION_STATE.BURNING;
    s.burningSec = 0;
    s.dousedSec = 0;
    s.fireCount += 1;
    ev.push(EVT_FIRE);
  }
  return ev;
}

/** 该工位当前是否冒烟(起火 0.5 秒后开始冒烟)。 */
export function isSmoking(s: StationRuntime): boolean {
  return s.state === STATION_STATE.BURNING && s.burningSec >= SMOKE_LEAD_SEC - EPS;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 3. 偷木板河狸事件 + 222 大锤夺回
 * ═══════════════════════════════════════════════════════════════════════ */

export const BEAVER_MOB_ID = 'mob_beaver';
/** 河狸偷的目标:151 木板(mobs.ts 掉落表 {703:2, 151:3})。 */
export const BEAVER_TARGET_ITEM_ID = 151;
export const BEAVER_STEAL_SEC = 4.0;
export const BEAVER_ESCAPE_SEC = 10.0;
export const BEAVER_SPAWN_INTERVAL_SEC = 20.0;
export const BEAVER_MAX_ACTIVE = 2;
/** 从 mobs.ts 掉落数量标定:一次抱走 3 块木板。 */
export const BEAVER_RECLAIM_QTY = 3;
/** items.ts #222 注释:施加 8 格/秒击退冲量。 */
export const HAMMER_222_IMPULSE = 8;
/** 达到该冲量即敲晕(mobs.ts 河狸 note:用充气大锤敲晕它可夺回木头)。 */
export const BEAVER_STUN_IMPULSE = 8;
export const BEAVER_STUN_SEC = 2.5;

export const BEAVER_STATE = {
  STEALING: 'STEALING',
  FLEEING: 'FLEEING',
  KNOCKED_DOWN: 'KNOCKED_DOWN',
  ESCAPED: 'ESCAPED',
} as const;
export type BeaverState = (typeof BEAVER_STATE)[keyof typeof BEAVER_STATE];

export const EVT_BEAVER_STOLE = 'BEAVER_STOLE';
export const EVT_BEAVER_ESCAPED = 'BEAVER_ESCAPED';
export const EVT_BEAVER_KNOCKED = 'BEAVER_KNOCKED';
export const EVT_WOOD_RECLAIMED = 'WOOD_RECLAIMED';

export interface BeaverRuntime {
  id: string;
  mobId: string;
  state: BeaverState;
  wantItem: number;
  /** 已抱走的木板数 */
  stolenQty: number;
  /** 当前状态已持续秒数 */
  elapsed: number;
  /** 敲晕剩余秒数 */
  stunSec: number;
  /** 是否处于可夺回窗口 */
  reclaimable: boolean;
  /** 已归还数量 */
  reclaimed: number;
}

export function spawnBeaver(id: string, itemId = BEAVER_TARGET_ITEM_ID): BeaverRuntime {
  return {
    id,
    mobId: BEAVER_MOB_ID,
    state: BEAVER_STATE.STEALING,
    wantItem: itemId,
    stolenQty: 0,
    elapsed: 0,
    stunSec: 0,
    reclaimable: false,
    reclaimed: 0,
  };
}

/** 推进河狸状态机;`stock` 为可写库存表,偷取时直接扣减。 */
export function tickBeaver(b: BeaverRuntime, dt: number, stock: Record<number, number>): string[] {
  const ev: string[] = [];
  if (dt <= 0 || b.state === BEAVER_STATE.ESCAPED) return ev;

  if (b.state === BEAVER_STATE.STEALING) {
    b.elapsed += dt;
    if (b.elapsed >= BEAVER_STEAL_SEC - EPS) {
      const have = Math.max(0, stock[b.wantItem] ?? 0);
      const take = Math.min(BEAVER_RECLAIM_QTY, have);
      stock[b.wantItem] = have - take;
      b.stolenQty = take;
      b.state = BEAVER_STATE.FLEEING;
      b.elapsed = 0;
      ev.push(EVT_BEAVER_STOLE);
    }
    return ev;
  }

  if (b.state === BEAVER_STATE.FLEEING) {
    b.elapsed += dt;
    if (b.elapsed >= BEAVER_ESCAPE_SEC - EPS) {
      b.state = BEAVER_STATE.ESCAPED;
      ev.push(EVT_BEAVER_ESCAPED);
    }
    return ev;
  }

  b.stunSec -= dt;
  if (b.stunSec <= EPS) {
    b.stunSec = 0;
    b.reclaimable = false;
    b.state = BEAVER_STATE.FLEEING;
    b.elapsed = 0;
  }
  return ev;
}

export interface HammerHitResult {
  knocked: boolean;
  reclaimed: number;
  reason: string;
}

/**
 * 222 充气玩具大锤命中:冲量 ≥ 8 格/秒 ⇒ 敲晕,进入可夺回窗口。
 * 只有该窗口内调用 `reclaimWood` 才能把木板拿回来。
 */
export function hitBeaver(b: BeaverRuntime, impulse: number): HammerHitResult {
  if (b.state === BEAVER_STATE.ESCAPED) return { knocked: false, reclaimed: 0, reason: 'ESCAPED' };
  if (b.state === BEAVER_STATE.KNOCKED_DOWN) return { knocked: false, reclaimed: 0, reason: 'ALREADY_DOWN' };
  if (impulse < BEAVER_STUN_IMPULSE - EPS) return { knocked: false, reclaimed: 0, reason: 'IMPULSE_TOO_LOW' };
  b.state = BEAVER_STATE.KNOCKED_DOWN;
  b.stunSec = BEAVER_STUN_SEC;
  b.elapsed = 0;
  b.reclaimable = b.stolenQty > 0;
  return { knocked: true, reclaimed: 0, reason: 'KNOCKED' };
}

/** 敲晕后夺回木板(写回库存)。 */
export function reclaimWood(b: BeaverRuntime, stock: Record<number, number>): number {
  if (!b.reclaimable || b.stolenQty <= 0) return 0;
  const qty = b.stolenQty;
  stock[b.wantItem] = (stock[b.wantItem] ?? 0) + qty;
  b.reclaimed += qty;
  b.stolenQty = 0;
  b.reclaimable = false;
  return qty;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 4. 投掷接力链
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 完整事件序列(顺序不可乱):
 *   CHOP   砍树
 *   THROW_A 隔河扔向对岸接球员
 *   CATCH  空中完美接球
 *   CUT    送进切木机
 *   THROW_B 扔给队友
 *   PAT    拍下地基
 */
export const RELAY_STAGES = ['CHOP', 'THROW_A', 'CATCH', 'CUT', 'THROW_B', 'PAT'] as const;
export type RelayStage = (typeof RELAY_STAGES)[keyof typeof RELAY_STAGES];

/** 每一环的时限(秒),超时即链中断。 */
export const RELAY_STAGE_TIMEOUT_SEC: Readonly<Record<RelayStage, number>> = {
  CHOP: 6,
  THROW_A: 2,
  CATCH: 2,
  CUT: 3,
  THROW_B: 2,
  PAT: 2.5,
};

/** 接力链一次成功只计分一次。 */
export const CHAIN_SUCCESS_SCORE = 150;
/** 任一环超时/掉落触发「链中断」惩罚。 */
export const CHAIN_BREAK_PENALTY = 40;
/** 隔河投掷最大有效距离 = 冻结层水平投掷初速 8.5 格/秒的可达射程。 */
export const RELAY_THROW_RANGE = THROW_SPEED_XY;
/** 隔河接力的标准河宽(格)。 */
export const RELAY_RIVER_WIDTH = 7.0;

export const CHAIN_STATE = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  BROKEN: 'BROKEN',
} as const;
export type ChainState = (typeof CHAIN_STATE)[keyof typeof CHAIN_STATE];

export const CHAIN_BREAK_REASON = {
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  TIMEOUT: 'TIMEOUT',
  DROP: 'DROP',
  OVERSHOOT: 'OVERSHOOT',
} as const;
export type ChainBreakReason = (typeof CHAIN_BREAK_REASON)[keyof typeof CHAIN_BREAK_REASON];

export interface RelayChain {
  id: string;
  state: ChainState;
  /** 下一个应当触发的环索引 */
  index: number;
  /** 上一环触发的逻辑时间 */
  lastAtSec: number;
  /** 累计已计分 */
  awarded: number;
  /** 累计罚分 */
  penalty: number;
  /** 中断原因 */
  breakReason: ChainBreakReason | null;
  /** CATCH 环的接球质量 */
  catchZ: number;
  catchDist: number;
}

export function createRelayChain(id: string, startSec = 0): RelayChain {
  return {
    id,
    state: CHAIN_STATE.PENDING,
    index: 0,
    lastAtSec: startSec,
    awarded: 0,
    penalty: 0,
    breakReason: null,
    catchZ: 0,
    catchDist: 0,
  };
}

export interface RelayStageInput {
  /** 触发时刻(逻辑秒) */
  atSec: number;
  /** CATCH 环:球的 Z 高度 */
  z?: number;
  /** CATCH 环:与接球员水平距离 */
  dist?: number;
  /** THROW 环:本次投掷水平距离 */
  throwDistance?: number;
}

export interface RelayStageResult {
  ok: boolean;
  stage: RelayStage;
  chainState: ChainState;
  reason: string;
  /** 本次新增得分 */
  awarded: number;
  /** 本次新增罚分 */
  penalty: number;
}

function breakChain(c: RelayChain, reason: ChainBreakReason, stage: RelayStage): RelayStageResult {
  c.state = CHAIN_STATE.BROKEN;
  c.breakReason = reason;
  c.penalty += CHAIN_BREAK_PENALTY;
  return {
    ok: false,
    stage,
    chainState: CHAIN_STATE.BROKEN,
    reason,
    awarded: 0,
    penalty: CHAIN_BREAK_PENALTY,
  };
}

/**
 * 推进接力链的一环。任何越序 / 超时 / 接球落空 / 投掷超射程 ⇒ 链中断 + 罚分。
 * 已关闭的链(SUCCESS/BROKEN)再触发不产生任何效果(保证成功只计分一次)。
 */
export function fireRelayStage(c: RelayChain, stage: RelayStage, input: RelayStageInput): RelayStageResult {
  if (c.state !== CHAIN_STATE.PENDING) {
    return {
      ok: false,
      stage,
      chainState: c.state,
      reason: 'CHAIN_CLOSED',
      awarded: 0,
      penalty: 0,
    };
  }

  const expected = RELAY_STAGES[c.index];
  if (stage !== expected) return breakChain(c, CHAIN_BREAK_REASON.OUT_OF_ORDER, stage);

  if (c.index > 0) {
    const timeout = RELAY_STAGE_TIMEOUT_SEC[expected];
    if (input.atSec - c.lastAtSec > timeout + EPS) return breakChain(c, CHAIN_BREAK_REASON.TIMEOUT, stage);
  }

  if (expected === 'CATCH') {
    const z = input.z ?? 0;
    const dist = input.dist ?? Number.POSITIVE_INFINITY;
    if (!canPerfectCatch(z, dist)) return breakChain(c, CHAIN_BREAK_REASON.DROP, stage);
    c.catchZ = z;
    c.catchDist = dist;
  }

  if (expected === 'THROW_A' || expected === 'THROW_B') {
    const d = input.throwDistance ?? 0;
    if (d > RELAY_THROW_RANGE + EPS) return breakChain(c, CHAIN_BREAK_REASON.OVERSHOOT, stage);
  }

  c.index += 1;
  c.lastAtSec = input.atSec;

  if (c.index >= RELAY_STAGES.length) {
    c.state = CHAIN_STATE.SUCCESS;
    c.awarded += CHAIN_SUCCESS_SCORE;
    return {
      ok: true,
      stage,
      chainState: CHAIN_STATE.SUCCESS,
      reason: 'CHAIN_COMPLETE',
      awarded: CHAIN_SUCCESS_SCORE,
      penalty: 0,
    };
  }

  return { ok: true, stage, chainState: c.state, reason: 'STAGE_OK', awarded: 0, penalty: 0 };
}

/** 单环超时检查(用于没有新事件到来时的空转检测)。 */
export function pollChainTimeout(c: RelayChain, nowSec: number): RelayStageResult | null {
  if (c.state !== CHAIN_STATE.PENDING || c.index === 0) return null;
  const expected = RELAY_STAGES[c.index];
  if (nowSec - c.lastAtSec > RELAY_STAGE_TIMEOUT_SEC[expected] + EPS) {
    return breakChain(c, CHAIN_BREAK_REASON.TIMEOUT, expected);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 5. 4 人叠罗汉搭人梯(与 WS-02 carry 接口对齐,只读冻结函数)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 顶层的伸手抓取高度(格)。
 *
 * 只影响「够不够得着」,不影响承载坐标——坐标仍完全由冻结层 `stackOffset` 决定。
 * 与 `Z2_REACH_TARGET` 配对使用,两侧都留裕度,避免 20Hz 浮点累加与坐标同步抖动误判。
 */
export const STACK_REACH_Z = 0.30;

/**
 * Z=2 层果实 / 机关 / Boss 背部的**有效抓取高度**(格)。
 *
 * 注意:这不是平台面高度(平台面是 2.0),而是「站在平台上还要再往上够」的到手高度。
 * 验算(顶层 E_k.z = k × 0.85):
 *   2 人梯  0.85 + 0.30 = 1.15  < 2.30  差 1.15
 *   3 人梯  1.70 + 0.30 = 2.00  < 2.30  差 0.30  ← 明确够不到,裕度足够抗抖动
 *   4 人梯  2.55 + 0.30 = 2.85  ≥ 2.30  余 0.55  ← 明确够得到
 * 设计意图「只有满 4 人梯能采 Z=2」因此成立,且上下两侧都留有裕度。
 */
export const Z2_REACH_TARGET = 2.30;

/** 叠罗汉队形定义。 */
export const STACK_FORMATIONS = { LADDER4: 4, LADDER3: 3, PAIR: 2 } as const;

/** 第 depth 层队伍的顶层实际高度(底层 index 0)。 */
export function stackTopZ(depth: number): number {
  const d = Math.max(1, Math.min(CARRY_MAX_DEPTH, Math.round(depth)));
  return stackOffset(d - 1);
}

/** 该队形能否够到目标高度(如 Z=2 的高台果实)。 */
export function canReachHeight(depth: number, targetZ: number): boolean {
  return stackTopZ(depth) + STACK_REACH_Z >= targetZ - EPS;
}

/** 底层承载者移速(直接转发冻结层 `carrierSpeedMul`)。 */
export function stackCarrierSpeed(depth: number): number {
  const d = Math.max(0, Math.min(CARRY_MAX_DEPTH, Math.round(depth) - 1));
  return carrierSpeedMul(d);
}

/** Z=2 层果实 / 机关的有效抓取高度(平台面 2.0 + 到手高度 0.30)。 */
export const Z2_FRUIT_HEIGHT = Z2_REACH_TARGET;

/** Z=2 果实采集判定。 */
export function canPickZ2Fruit(depth: number): boolean {
  return canReachHeight(depth, Z2_FRUIT_HEIGHT);
}

/**
 * 登 Boss 背部所需高度。
 *
 * Boss 体型半径 1.20,背脊是「曲面」而非平面,落点比平台更靠上;
 * 因此与 Z=2 机关共用同一有效抓取高度,保持「必须满 4 人梯」的一致性,
 * 也避免 3 人梯恰好等于 2.00 时踩在边界上的抖动误判。
 */
export const BOSS_BACK_HEIGHT = Z2_REACH_TARGET;

export function canMountBossBack(depth: number): boolean {
  return canReachHeight(depth, BOSS_BACK_HEIGHT);
}

/** 冻结层物理量与判定的转发出口(供接力链、整蛊玩具与测试共用)。 */
export {
  canPerfectCatch,
  CATCH_RADIUS,
  CATCH_Z_MIN,
  CATCH_Z_MAX,
  CARRY_MAX_DEPTH,
  CARRY_Z_STEP,
  CARRY_SLOWDOWN,
  THROW_SPEED_XY,
  THROW_SPEED_Z,
  GRAVITY,
  TICK_HZ,
  DT,
};

/* ═══════════════════════════════════════════════════════════════════════
 * 6. 急单会话(把 1~5 全部串起来)
 * ═══════════════════════════════════════════════════════════════════════ */

export interface RushOrderSessionOptions {
  clock: Clock;
  roomLevel: number;
  seed?: number;
  stock?: Record<number, number>;
  /** 注入 rng;省略时用 seed 派生(调用方自行 mulberry32) */
  rng: Rng;
  durationSec?: number;
}

export interface RushOrderSession {
  clock: Clock;
  state: RushOrderState;
  roomLevel: number;
  seed: number;
  durationSec: number;
  startedAtSec: number;
  board: RushOrderBoard;
  stock: Record<number, number>;
  stations: StationRuntime[];
  beavers: BeaverRuntime[];
  chains: RelayChain[];
  events: string[];
  score: number;
  penalty: number;
  rng: Rng;
  beaverTimer: number;
  beaverSpawned: number;
}

export function createRushOrderSession(opts: RushOrderSessionOptions): RushOrderSession {
  const stock = opts.stock ?? {};
  return {
    clock: opts.clock,
    state: RUSH_ORDER_STATE.IDLE,
    roomLevel: opts.roomLevel,
    seed: opts.seed ?? 0,
    durationSec: opts.durationSec ?? RUSH_ORDER_DURATION_SEC,
    startedAtSec: 0,
    board: generateOrderBoard(opts.rng, opts.roomLevel, stock, opts.seed ?? 0),
    stock,
    stations: [createStation(STATION_KIND.FURNACE), createStation(STATION_KIND.POT), createStation(STATION_KIND.CUTTER)],
    beavers: [],
    chains: [],
    events: [],
    score: 0,
    penalty: 0,
    rng: opts.rng,
    beaverTimer: 0,
    beaverSpawned: 0,
  };
}

export function startRushOrder(s: RushOrderSession): void {
  if (s.state !== RUSH_ORDER_STATE.IDLE) return;
  s.state = RUSH_ORDER_STATE.RUNNING;
  s.startedAtSec = s.clock.now();
  for (const st of s.stations) startStation(st);
  s.events.push('RUSH_ORDER_START');
}

export function elapsedSec(s: RushOrderSession): number {
  return s.clock.now() - s.startedAtSec;
}

export interface RushTickOptions {
  /** 本步被翻炒的工位 */
  tended?: readonly StationKind[];
  /** 本步被水枪喷射的工位 */
  spraying?: readonly StationKind[];
  /** 是否允许刷新偷料河狸 */
  spawnBeaver?: boolean;
}

/** 单步推进整场急单。推荐 dt = 0.5s(低频帧)或 0.05s(高频帧)。 */
export function tickRushOrder(s: RushOrderSession, dt: number, opts: RushTickOptions = {}): string[] {
  const out: string[] = [];
  if (s.state !== RUSH_ORDER_STATE.RUNNING || dt <= 0) return out;

  for (const st of s.stations) {
    const tended = (opts.tended ?? []).includes(st.kind);
    const spraying = (opts.spraying ?? []).includes(st.kind);
    out.push(...tickStation(st, dt, tended, spraying));
  }

  if (opts.spawnBeaver !== false) {
    s.beaverTimer += dt;
    if (s.beaverTimer >= BEAVER_SPAWN_INTERVAL_SEC - EPS) {
      s.beaverTimer = 0;
      const alive = s.beavers.filter((b) => b.state !== BEAVER_STATE.ESCAPED).length;
      if (alive < BEAVER_MAX_ACTIVE) {
        s.beaverSpawned += 1;
        s.beavers.push(spawnBeaver(`beaver_${s.beaverSpawned}`));
        out.push('BEAVER_SPAWN');
      }
    }
  }

  for (const b of s.beavers) out.push(...tickBeaver(b, dt, s.stock));

  for (const c of s.chains) {
    const r = pollChainTimeout(c, s.clock.now());
    if (r) {
      s.penalty += r.penalty;
      out.push(`CHAIN_BREAK:${r.reason}`);
    }
  }

  if (elapsedSec(s) >= s.durationSec - EPS) {
    s.state = RUSH_ORDER_STATE.SETTLED;
    out.push('RUSH_ORDER_END');
  }

  s.events.push(...out);
  return out;
}

/** 交付一批物品到订单板并结算分值。 */
export function submitDelivery(s: RushOrderSession, itemId: number, qty: number): DeliverResult {
  const r = deliverItem(s.board, itemId, qty);
  if (r.accepted) s.score += r.points;
  return r;
}

/** 登记一条接力链。 */
export function addRelayChain(s: RushOrderSession, id: string): RelayChain {
  const c = createRelayChain(id, s.clock.now());
  s.chains.push(c);
  return c;
}

/** 推进链条一环并同步总分。 */
export function advanceRelayChain(s: RushOrderSession, c: RelayChain, stage: RelayStage, input: RelayStageInput): RelayStageResult {
  const r = fireRelayStage(c, stage, input);
  s.score += r.awarded;
  s.penalty += r.penalty;
  return r;
}

export interface RushSessionSettlement extends RushSettlement {
  sessionScore: number;
  penalty: number;
  beaversEscaped: number;
  woodStolen: number;
}

export function settleSession(s: RushOrderSession): RushSessionSettlement {
  const base = settleRushOrder(s.board, elapsedSec(s));
  const stolen = s.beavers.reduce((a, b) => a + b.stolenQty + b.reclaimed, 0);
  const escaped = s.beavers.filter((b) => b.state === BEAVER_STATE.ESCAPED).length;
  return {
    ...base,
    sessionScore: Math.max(0, s.score + base.score - s.penalty),
    penalty: s.penalty,
    beaversEscaped: escaped,
    woodStolen: stolen,
  };
}

/** 预热订单池自检(任何写手首次 import 后调用即可发现悬空引用)。 */
assertOrderPoolClosed();
