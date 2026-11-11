/**
 * WS-11 · 社交、打盹与度假子系统(设计手册 §6.4)
 *
 * 覆盖:
 *  1. 切后台 5 秒自动打盹 + 按注入时钟攒「梦境露水」(物品 130);
 *  2. 生态缸挂机模式:隐藏 UI 的微缩景观运镜 + 白噪音混音参数表;
 *  3. 534 迎宾点赞留言信箱:离线留言、贴纸贺卡与礼物;
 *  4. 515 无人自助售货摊:定价、上架、跨房交易结算与抽成;
 *  5. 风筝 Boss 跑道与马拉松跑道毫秒计时。
 *
 * 时间一律来自注入的 `Clock`;不使用任何系统时钟或真 sleep。
 */

import type { Clock } from '../coop/rush_order.ts';
import {
  createRaceTimer,
  formatMs,
  gateStart,
  podiumFinish,
  rankRace,
  type RaceResult,
  type RaceTimer,
} from '../party/scoring.ts';
import { ITEM_BY_ID } from '../../../shared/constants/items.ts';
import { AFK_EXP_RATIO } from '../../../shared/types/entities.ts';

/* ═══════════════════════ 1. 打盹与梦境露水 ═══════════════════════ */

/** 切后台 5 秒即自动进入打盹。 */
export const DOZE_AFTER_SEC = 5;
/** 基础产露率:每 30 秒 1 滴。 */
export const DEW_SEC_PER_UNIT = 30;
/** 501 暖心篝火茶座 4 格内:打盹攒露水速度翻倍。 */
export const DEW_FIRE_BONUS = 2.0;
/** 304 绯樱榻榻米席:打盹攒露水速度额外 +20%。 */
export const DEW_TATAMI_BONUS = 1.2;
/** 摸头(对打盹队友互动)一次性赠露水。 */
export const DEW_PAT_BONUS = 1;
/** 打盹超过 10 分钟转为「深度睡眠」,产出减半(防挂机刷)。 */
export const DEEP_SLEEP_AFTER_SEC = 600;
export const DEEP_SLEEP_MUL = 0.5;
/** 517 云端软绵绵单人床:打盹时每秒恢复 15 HP。 */
export const BED_HP_PER_SEC = 15;

export const DOZE_STATE = {
  AWAKE: 'AWAKE',
  DOZING: 'DOZING',
  DEEP: 'DEEP',
} as const;
export type DozeState = (typeof DOZE_STATE)[keyof typeof DOZE_STATE];

export interface AfkPlayer {
  playerId: string;
  state: DozeState;
  /** 进入后台的时钟时刻;null 表示前台 */
  backgroundedAtSec: number | null;
  /** 已打盹累计秒数 */
  dozedSec: number;
  /** 露水小数累加器,避免浮点截断丢失 */
  dewAcc: number;
  /** 已获得露水总量 */
  dew: number;
  /** 在篝火 4 格内 */
  nearFire: boolean;
  /** 躺在 304 榻榻米上 */
  onTatami: boolean;
  /** 挂在 517 床上 */
  onBed: boolean;
  /** 累计回血 */
  healedHp: number;
}

export function createAfkPlayer(playerId: string): AfkPlayer {
  return {
    playerId,
    state: DOZE_STATE.AWAKE,
    backgroundedAtSec: null,
    dozedSec: 0,
    dewAcc: 0,
    dew: 0,
    nearFire: false,
    onTatami: false,
    onBed: false,
    healedHp: 0,
  };
}

/** 当前产露速率(滴/秒)。 */
export function dewRatePerSec(p: AfkPlayer): number {
  if (p.state === DOZE_STATE.AWAKE) return 0;
  let rate = 1 / DEW_SEC_PER_UNIT;
  if (p.nearFire) rate *= DEW_FIRE_BONUS;
  if (p.onTatami) rate *= DEW_TATAMI_BONUS;
  if (p.state === DOZE_STATE.DEEP) rate *= DEEP_SLEEP_MUL;
  return rate;
}

/** 切到后台。 */
export function goBackground(p: AfkPlayer, atSec: number): void {
  if (p.backgroundedAtSec !== null) return;
  p.backgroundedAtSec = atSec;
  p.state = DOZE_STATE.AWAKE;
  p.dozedSec = 0;
}

/** 切回前台:立即停止产露,状态归 AWAKE。 */
export function goForeground(p: AfkPlayer): void {
  p.backgroundedAtSec = null;
  p.state = DOZE_STATE.AWAKE;
  p.dozedSec = 0;
  p.dewAcc = 0;
}

/**
 * 单步推进打盹:推荐 dt = 0.5s(低频帧)。
 * 返回本步获得的整滴露水数量。
 */
export function tickAfk(p: AfkPlayer, nowSec: number, dt: number): number {
  if (dt <= 0) return 0;
  if (p.backgroundedAtSec === null) {
    p.state = DOZE_STATE.AWAKE;
    return 0;
  }

  const bg = nowSec - p.backgroundedAtSec;
  if (bg < DOZE_AFTER_SEC) {
    p.state = DOZE_STATE.AWAKE;
    return 0;
  }

  p.state = p.dozedSec >= DEEP_SLEEP_AFTER_SEC ? DOZE_STATE.DEEP : DOZE_STATE.DOZING;
  p.dozedSec += dt;

  if (p.onBed) p.healedHp += BED_HP_PER_SEC * dt;

  p.dewAcc += dewRatePerSec(p) * dt;
  const whole = Math.floor(p.dewAcc);
  if (whole > 0) {
    p.dewAcc -= whole;
    p.dew += whole;
  }
  return whole;
}

/** 摸头互动:给打盹的队友一次性赠露水并唤醒。 */
export function patDozing(p: AfkPlayer): number {
  if (p.state === DOZE_STATE.AWAKE) return 0;
  p.dew += DEW_PAT_BONUS;
  goForeground(p);
  return DEW_PAT_BONUS;
}

/** 挂机经验倍率(消费冻结层 AFK_EXP_RATIO = 0.3)。 */
export function afkExpRatio(): number {
  return AFK_EXP_RATIO;
}

/* ═══════════════════════ 2. 生态缸挂机模式 ═══════════════════════ */

/** 隐藏 UI 后的微缩景观运镜轨道。 */
export const VIVARIUM_CAMERA_SHOTS = ['ORBIT_SLOW', 'DOLLY_IN', 'TILT_DOWN', 'MACRO_LEAF', 'SUNSET_RIM'] as const;
export type VivariumShot = (typeof VIVARIUM_CAMERA_SHOTS)[number];

export const VIVARIUM = {
  /** 隐藏 UI 的淡出时长(秒) */
  uiFadeSec: 1.2,
  /** 单个运镜时长(秒) */
  shotSec: 24,
  /** 轨道半径(格) */
  orbitRadius: 12,
  /** 相机高度(格) */
  camHeight: 6.5,
  /** 俯角(度) */
  pitchDeg: 38,
  /** 最低帧率保护:低于该值自动退回静态机位 */
  minFps: 24,
} as const;

/** 白噪音混音总线参数(音量 0~1,仅挂机模式生效)。 */
export const WHITE_NOISE_MIX: readonly { key: string; gain: number; label: string }[] = [
  { key: 'rain', gain: 0.32, label: '细雨落瓦' },
  { key: 'stream', gain: 0.28, label: '门前小溪' },
  { key: 'campfire', gain: 0.22, label: '篝火噼啪' },
  { key: 'wind', gain: 0.18, label: '穿过竹林的微风' },
  { key: 'hum', gain: 0.12, label: '波波森灵呼噜' },
];

/** 混音总增益(所有轨道之和)。 */
export function whiteNoiseMasterGain(): number {
  return WHITE_NOISE_MIX.reduce((a, n) => a + n.gain, 0);
}

export interface VivariumState {
  active: boolean;
  /** 进入挂机模式的时钟时刻 */
  enteredAtSec: number;
  shotIndex: number;
  uiHidden: boolean;
  /** 当前混音总增益 */
  masterGain: number;
  /** 因低帧率退回静态机位的次数 */
  fallbackCount: number;
}

export function createVivarium(): VivariumState {
  return { active: false, enteredAtSec: 0, shotIndex: 0, uiHidden: false, masterGain: 0, fallbackCount: 0 };
}

export function enterVivarium(v: VivariumState, atSec: number): void {
  v.active = true;
  v.enteredAtSec = atSec;
  v.shotIndex = 0;
  v.uiHidden = false;
  v.masterGain = 0;
}

/** 推进运镜:经过 uiFadeSec 后 UI 完全隐藏;每 shotSec 切换一次机位。 */
export function tickVivarium(v: VivariumState, nowSec: number, dt: number, fps = 60): VivariumShot | null {
  if (!v.active) return null;
  if (fps < VIVARIUM.minFps) v.fallbackCount += 1;

  const t = nowSec - v.enteredAtSec;
  v.uiHidden = t >= VIVARIUM.uiFadeSec;
  const fade = Math.min(1, t / VIVARIUM.uiFadeSec);
  v.masterGain = fade * whiteNoiseMasterGain();

  const target = Math.floor(t / VIVARIUM.shotSec) % VIVARIUM_CAMERA_SHOTS.length;
  if (target !== v.shotIndex) {
    v.shotIndex = target;
    void dt;
    return VIVARIUM_CAMERA_SHOTS[target];
  }
  void dt;
  return null;
}

export function exitVivarium(v: VivariumState): void {
  v.active = false;
  v.uiHidden = false;
  v.masterGain = 0;
}

/* ═══════════════════════ 3. 534 迎宾点赞留言信箱 ═══════════════════════ */

export const MAILBOX_ITEM_ID = 534;
export const MAILBOX_CAPACITY = 50;
export const MAIL_TTL_SEC = 7 * 24 * 3600;
export const STICKER_COUNT = 12;

export interface Mail {
  id: string;
  from: string;
  to: string;
  atSec: number;
  /** 点赞数 */
  likes: number;
  /** 贴纸编号 ∈ [0,11] */
  sticker: number;
  /** 附赠礼物:物品 ID -> 数量 */
  gifts: Record<number, number>;
  text: string;
}

export interface Mailbox {
  ownerId: string;
  items: Mail[];
  /** 累计收到点赞数 */
  totalLikes: number;
  /** 因溢出被丢弃的条数 */
  dropped: number;
}

export function createMailbox(ownerId: string): Mailbox {
  return { ownerId, items: [], totalLikes: 0, dropped: 0 };
}

/** 留一条留言;信箱满时丢弃最旧的一条(FIFO)。 */
export function leaveMail(mb: Mailbox, mail: Mail): Mail | null {
  let dropped: Mail | null = null;
  if (mb.items.length >= MAILBOX_CAPACITY) {
    dropped = mb.items.shift() ?? null;
    if (dropped) mb.dropped += 1;
  }
  mb.items.push(mail);
  return dropped;
}

/** 点赞一条留言。 */
export function likeMail(mb: Mailbox, mailId: string): boolean {
  const m = mb.items.find((x) => x.id === mailId);
  if (!m) return false;
  m.likes += 1;
  mb.totalLikes += 1;
  return true;
}

/** 绝赞徽章阈值。 */
export const MAIL_LIKE_BADGES: readonly { atLikes: number; label: string }[] = [
  { atLikes: 10, label: '人气小屋' },
  { atLikes: 50, label: '网红打卡点' },
  { atLikes: 200, label: '全服名胜' },
];

export function badgeFor(mb: Mailbox): string | null {
  let label: string | null = null;
  for (const b of MAIL_LIKE_BADGES) if (mb.totalLikes >= b.atLikes) label = b.label;
  return label;
}

/** 过期清理,返回清理条数。 */
export function pruneMailbox(mb: Mailbox, nowSec: number): number {
  const before = mb.items.length;
  mb.items = mb.items.filter((m) => nowSec - m.atSec < MAIL_TTL_SEC);
  return before - mb.items.length;
}

/* ═══════════════════════ 4. 515 无人自助售货摊 ═══════════════════════ */

export const STALL_ITEM_ID = 515;
export const STALL_SLOT_COUNT = 8;
/** 跨房交易抽成 5%(镇子维护费)。 */
export const CROSS_ROOM_FEE_RATIO = 0.05;
/** 系统推荐价 = V_i × 该系数。 */
export const SUGGESTED_PRICE_MUL = 1.6;
/** 单笔跨房交易上限。 */
export const CROSS_ROOM_MAX_QTY = 999;

export interface StallListing {
  itemId: number;
  qty: number;
  /** 单价 */
  price: number;
  /** 上架方 */
  sellerId: string;
  /** 上架时钟时刻 */
  listedAtSec: number;
}

export interface Stall {
  ownerId: string;
  listings: StallListing[];
  /** 累计成交额 */
  revenue: number;
  /** 累计抽成 */
  feePaid: number;
  /** 售罄下架次数 */
  soldOut: number;
}

export function createStall(ownerId: string): Stall {
  return { ownerId, listings: [], revenue: 0, feePaid: 0, soldOut: 0 };
}

/** 系统推荐价:取冻结层 V_i 事实源 × 系数,向上取整。 */
export function suggestedPrice(itemId: number): number {
  const def = ITEM_BY_ID.get(itemId);
  if (!def) throw new Error(`售货摊不支持未知物品 ${itemId}`);
  return Math.max(1, Math.ceil(def.value * SUGGESTED_PRICE_MUL));
}

/** 上架。返回 false 表示货架已满或参数非法。 */
export function listItem(s: Stall, listing: StallListing): boolean {
  if (s.listings.length >= STALL_SLOT_COUNT) return false;
  if (listing.qty <= 0 || listing.price < 1) return false;
  if (!ITEM_BY_ID.has(listing.itemId)) return false;
  s.listings.push(listing);
  return true;
}

export interface PurchaseResult {
  ok: boolean;
  itemId: number;
  qty: number;
  gross: number;
  fee: number;
  net: number;
  reason: string;
}

/**
 * 跨房购买:从售货摊出货,`crossRoom=true` 时扣 5% 抽成。
 * 同房间交易零手续费。
 */
export function buyFromStall(s: Stall, itemId: number, qty: number, crossRoom: boolean): PurchaseResult {
  if (qty <= 0 || qty > CROSS_ROOM_MAX_QTY) {
    return { ok: false, itemId, qty, gross: 0, fee: 0, net: 0, reason: 'QTY_INVALID' };
  }
  const idx = s.listings.findIndex((l) => l.itemId === itemId && l.qty > 0);
  if (idx < 0) return { ok: false, itemId, qty, gross: 0, fee: 0, net: 0, reason: 'NOT_LISTED' };

  const l = s.listings[idx];
  const sold = Math.min(qty, l.qty);
  const gross = sold * l.price;
  const fee = crossRoom ? Math.round(gross * CROSS_ROOM_FEE_RATIO) : 0;
  const net = gross - fee;

  l.qty -= sold;
  s.revenue += gross;
  s.feePaid += fee;
  if (l.qty === 0) {
    s.listings.splice(idx, 1);
    s.soldOut += 1;
  }

  return { ok: true, itemId, qty: sold, gross, fee, net, reason: 'OK' };
}

/* ═══════════════════════ 5. 跑道计时 ═══════════════════════ */

export const TRACK_KIND = {
  MARATHON: 'MARATHON',
  KITE_BOSS: 'KITE_BOSS',
} as const;
export type TrackKind = (typeof TRACK_KIND)[keyof typeof TRACK_KIND];

/** 马拉松赛道全长(格)。 */
export const MARATHON_LENGTH = 200;
/** 风筝 Boss 跑道全长(格)。 */
export const KITE_LENGTH = 150;
/** 风筝 Boss 跑道:被追上一次罚 3 秒。 */
export const KITE_CATCH_PENALTY_MS = 3000;

export interface TrackRuntime {
  kind: TrackKind;
  clock: Clock;
  length: number;
  timers: Map<string, RaceTimer>;
  /** 各玩家被风筝 Boss 追上的次数 */
  caught: Map<string, number>;
  results: RaceResult[];
}

export function createTrack(kind: TrackKind, clock: Clock): TrackRuntime {
  return {
    kind,
    clock,
    length: kind === TRACK_KIND.MARATHON ? MARATHON_LENGTH : KITE_LENGTH,
    timers: new Map(),
    caught: new Map(),
    results: [],
  };
}

/** 进入起跑区:开启个人毫秒计时(411 发令门)。 */
export function trackStart(t: TrackRuntime, playerId: string): void {
  if (!t.timers.has(playerId)) t.timers.set(playerId, createRaceTimer(playerId));
  gateStart(t.timers.get(playerId) as RaceTimer, t.clock.now());
}

/** 被风筝 Boss 追上:记一次惩罚。 */
export function trackCaught(t: TrackRuntime, playerId: string): number {
  const n = (t.caught.get(playerId) ?? 0) + 1;
  t.caught.set(playerId, n);
  return n;
}

/** 冲线:把惩罚时间加进成绩(412 领奖台)。 */
export function trackFinish(t: TrackRuntime, playerId: string): boolean {
  const timer = t.timers.get(playerId);
  if (!timer) return false;
  const ok = podiumFinish(timer, t.clock.now());
  if (ok) {
    const pen = (t.caught.get(playerId) ?? 0) * KITE_CATCH_PENALTY_MS;
    if (timer.elapsedMs !== null) {
      timer.elapsedMs += pen;
      timer.finishMs = (timer.finishMs ?? 0) + pen;
    }
  }
  return ok;
}

export function trackStandings(t: TrackRuntime): RaceResult[] {
  t.results = rankRace([...t.timers.values()]);
  return t.results;
}

/** 跑道前三名播报文案。 */
export function trackPodiumText(t: TrackRuntime): string {
  const rows = trackStandings(t);
  const top = rows.slice(0, 3);
  const label = t.kind === TRACK_KIND.MARATHON ? '马拉松' : '风筝 Boss 跑道';
  if (top.length === 0) return `${label}:本轮无人完赛`;
  return `${label}前三名:` + top.map((r) => `${r.rank}.${r.playerId} ${formatMs(r.elapsedMs)}`).join('  ');
}

/* ═══════════════════════ 自检 ═══════════════════════ */

/** 社交子系统引用的物品 ID 必须存在于冻结层配表。 */
export function assertSocialRefsClosed(): void {
  for (const id of [MAILBOX_ITEM_ID, STALL_ITEM_ID, 130, 304, 501, 517]) {
    if (!ITEM_BY_ID.has(id)) throw new Error(`社交子系统引用悬空物品 ID ${id}`);
  }
}

assertSocialRefsClosed();