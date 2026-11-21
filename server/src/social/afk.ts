/**
 * WS-11 · 社交、打盹与度假子系统(设计手册 §6.4)
 *
 * ## 接线状态(★ 唯一处:每段标题里的 `〔WIRED〕` / `〔RESERVED〕` 标记)
 *
 * | 段 | 标记 | 生产入口 / 缺什么 |
 * |---|---|---|
 * | 1 打盹攒露水(物品 130) | `〔WIRED〕` | `sim/world_sim.ts#setPlayerDozing`(装配层 `sleepSource` 注入)+ `#tickPartyStep` 慢帧 `tickAfk` |
 * | 2 生态缸挂机(运镜 + 白噪音) | `〔RESERVED〕` | 缺**客户端**:镜头要 renderer、混音要音频宿主;`three/boot.ts` 不读 `VIVARIUM` |
 * | 3 534 迎宾点赞留言信箱 | `〔RESERVED〕` | 缺**离线存档容器 + 信箱 UI**;`net/room` 的存档只有 world / player 两块,动作面也没有 MAIL 类动词 |
 * | 4 515 无人自助售货摊(**上架行**) | `〔RESERVED〕` | 缺 LIST / BUY 动作;且 515 的**成交权威不在本文件**(`systems/depot.ts` + `world_sim.ts#depotStock`) |
 * | 5 马拉松 / 风筝 Boss 跑道计时 | `〔RESERVED〕` | 玩法赛道的权威在 `party/modes.ts#RaceRuntime`(见下「两套赛道」);本段只做罚时后的耗时展示 |
 *
 * ⇒ **第 2~5 段是「预留·不做」**:有实现、有单元判据,但**生产消费者 0 处**。
 *   不要把第 2~5 段当成「已可用的接口」来引用 —— 要接,先补上面那一列写明的宿主
 *   (客户端 renderer / 音频宿主 / 离线存档 / 动作面),并**同时**做两件事:
 *   ① 把该段标题的标记改成 `〔WIRED:<文件#符号>〕`;② 在 `docs/WIRING-LEDGER.md §2.7`
 *   的理由列写调用点。判据 `tests/WS-FND-149-arch-hazards.test.ts` 是**双向**的:
 *   `RESERVED` 段必须 0 生产消费者,`WIRED` 段必须真有消费者 —— 只改一边当场红。
 *
 * ## 两条**同名边界**(别合并)
 *
 * · **摊位(515)**:本文件的 `Stall` 是「**上架行**」模型(卖家 / 单价 / 跨房 5% 抽成);
 *   `world_sim.ts#depotStock`(`物品 id → 件数`)是 515 那台百货机的**库存**。
 *   两者共用 515 这件家具,**不是同一个模型**;515 的成交权威只有 `systems/depot.ts`
 *   (幂等键 `CLOUD_DEPOT@ORDER:*`),本文件不参与成交。
 * · **赛道**:本文件的 `TrackRuntime` 只做「罚时后耗时排名」的**展示**(不发奖、不播报、
 *   没有自己的 `tick`);带结算 / 发奖 / 全房播报的权威是 `party/modes.ts#RaceRuntime`。
 *   ⇒ 同一 tick 只准推进**一套**;两侧都不许给对方加推进口(判据见 WS-FND-149)。
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

/* ═══════════ 1. 打盹与梦境露水 〔WIRED:world_sim.ts#setPlayerDozing〕 ═══════════ */
/*
 * 生产链:装配层 `sleepSource` → `world_sim.ts#stepDozingEntry` → `#setPlayerDozing`
 * → 本文件的 `goBackground` / `tickAfk`(慢帧 2Hz,`dt = SIM_SLOW_DT = 0.5s`,
 * 与 `tickAfk` 自己写的「推荐 0.5s」逐值吻合)。
 * ⚠️ 与 `room.ts` 的「在场 AFK」**不是同一件事**:那是**连接态**(30 分钟占席位、仍算 online),
 * 本条是**玩法态**(切后台攒露水)。两套时间线各自独立,名字撞了而已(不要互相顶替)。
 */

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
 *
 * ## 时基:世界钟(游戏秒)—— 不是墙钟(★ WS-FND-174)
 *
 * `nowSec` / `dt` 都由世界侧喂(`world_sim.ts#tickPartyStep` 里的
 * `partyClock.advance(SIM_SLOW_DT)`),单位是**世界秒**:`p.dozedSec += dt`、
 * `p.healedHp += BED_HP_PER_SEC * dt`、`p.dewAcc += 速率 × dt` 三处都在这个钟上。
 *
 * ⇒ 「一次打盹的**结束**」也必须在同一个钟上:上游那条窗口
 * (`actions/sleep.ts` 的 `SLEEP_DURATION_SEC = 60`,按世界钟开、按世界钟判到期)
 * 与这里的累加是**同一段时间** —— 睡满 60 世界秒 ⇔ 回血攒了
 * `60 × BED_HP_PER_SEC`。任一边退回墙钟,帧率低于名义 20Hz(实测 ~16Hz)时两边
 * 差约 20%(墙上 60 秒 ≈ 世界 47.8 秒),表现是「睡够了却还在回血 / 没睡够就
 * 停了」,而**不报错**。
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

/* ═══════════ 2. 生态缸挂机模式 〔RESERVED:缺客户端 renderer + 音频宿主,生产 0 消费者〕 ═══════════ */
/*
 * 预留·不做:镜头序列表(`VIVARIUM_CAMERA_SHOTS`)与混音表(`WHITE_NOISE_MIX`)只是**参数**,
 * 「隐藏 UI 的微缩景观」要 `three/boot.ts` 的相机与音频总线 —— 两者都在客户端。
 * ⇒ 别把 `tickVivarium` 读成「运镜已生效」:它只算 `masterGain` / `shotIndex` 两个数,没有画面。
 */

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

/* ═══════════ 3. 534 迎宾点赞留言信箱 〔RESERVED:缺离线存档容器 + 信箱 UI,生产 0 消费者〕 ═══════════ */
/*
 * 预留·不做:留言要有**跨会话**的落点(`net/room` 的存档只有 world / player 两块,
 * 没有第三个容器),还要玩家能点的 MAIL 类动作(22 个动作里没有)。
 * ⇒ `leaveMail` / `likeMail` 今天只有套件在调,「信箱」在生产里不存在。
 */

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

/* ═══════════ 4. 515 无人自助售货摊(上架行)〔RESERVED:缺 LIST/BUY 动作,生产 0 消费者〕 ═══════════ */
/*
 * ★ **同名不同物**(本文件唯一一处与 `world_sim.ts` 撞过名的地方,已改名消歧):
 *   · 本段 = 「**上架行**」模型:`StallListing` 带 `sellerId` / `price` / `listedAtSec`,
 *     `Stall` 记 `revenue` / `feePaid`(跨房 5% 抽成)—— 语义是**玩家自发摆摊**;
 *   · `world_sim.ts#depotStock`(`物品 id → 件数`)= 515 那台**百货机**的库存,
 *     成交走 `systems/depot.ts#buyOnce`,幂等键 `CLOUD_DEPOT@ORDER:<订单号>`。
 *   ⇒ 两段共用 515 这件家具、**不是同一个模型**,也不许互喂:本段的 `StallListing[]`
 *     不进 `depotStock`,`depotStock` 也不进 `Stall`。判据 `tests/WS-FND-149`:
 *     两侧符号集交集必须为空,且 `suggestedPrice` / `buyFromStall` / `listItem` /
 *     `createStall` 的生产引用必须是 0(515 的定价与成交只有 depot 一份权威)。
 *   ⇒ 预留·不做:摆摊要有 LIST / BUY 动作面,今天的动作面没有这两个动词。
 */

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

/* ═══════════ 5. 跑道计时(社交展示)〔RESERVED:玩法赛道权威在 party/modes.ts#RaceRuntime〕 ═══════════ */
/*
 * ★ **两套赛道运行时,边界三条**(判据 `tests/WS-FND-149-arch-hazards.test.ts`):
 *   1 **结算权**:只有 `party/modes.ts#RaceRuntime` 能发奖 / 播报
 *     (`podiumBroadcast` / `rewardsForPlayers` / `pushBroadcast`)。本文件的 import 表里
 *     **没有**这三样,本段也不定义 `RewardLine` / `PartySettlement` —— 加一样就红;
 *   2 **推进权**:本段**没有 `tick`**(它是被动的计时器口:`trackStart` / `trackFinish`),
 *     所以「两套同时推进同一 tick」在结构上不可能;世界慢帧只推 `tickPartyContest`;
 *   3 **同一只表**:两套的毫秒计时器都是 `party/scoring.ts#RaceTimer`
 *     (`createRaceTimer` / `gateStart` / `podiumFinish` / `rankRace`),本文件不自带第二套时钟。
 * ⇒ 本段是**玩法赛道结果的罚时视图**(风筝 Boss 追上 +3s 后的耗时),不是第二条结算链。
 * ⇒ **预留·不做**:要真跑这条跑道,先接上面的玩法赛道(`RaceRuntime` 起跑 / 结算 / 发奖),
 *   再把本段当**展示**读;今天它没有任何生产入口,`trackStart` / `trackFinish` 只有套件在调。
 */

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