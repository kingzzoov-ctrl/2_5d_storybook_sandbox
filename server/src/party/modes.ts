/**
 * WS-11 · 四大竞技派对模式状态机(设计手册 §6.3)
 *
 * 消费冻结层 `PARTY_MODES`(4 条:BRIDGE_CTF / JELLY_BALL / CROWN_BR / PAINT_WAR),
 * 为每个模式实现:状态机 + 计时器 + 计分 + 结算 + 全房播报。
 *
 * 联动件(全部取自冻结层 401~440 配表,不新增 ID):
 *   436 派对裁判控制哨台  → 一键开局
 *   255 裁判金哨子        → 召集与发令
 *   411 跑酷起点发令门    → 个人毫秒计时开始
 *   412 跑酷终点领奖台    → 个人毫秒计时结束 + 前三名播报
 *   410 红蓝计分球门框    → 进球判定 + 比分播报 + 球复位
 *   433 巨型果冻足球生成座 → 球体生成与复位点
 *   435 四色队伍出生复活旗 → 队伍归属与复活点
 *   434 争夺战金皇冠底座  → 持冠计秒
 *
 * 时间一律由外部注入(见 `coop/rush_order.ts` 的 `Clock`),模式内部不读系统时钟。
 */

import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
import type { Clock, Rng } from '../coop/rush_order.ts';
import {
  BROADCAST_KIND,
  TEAM_KEY,
  TEAM_ORDER,
  TEAM_LABEL,
  createBroadcaster,
  createPaintGrid,
  createRaceTimer,
  createScoreboard,
  crownLine,
  gateStart,
  getTeam,
  makeRng,
  modeEndLine,
  modeStartLine,
  paintRadius,
  paintStandingLine,
  podiumBroadcast,
  podiumFinish,
  pushBroadcast,
  rankPaint,
  rankRace,
  rankByDescending,
  rewardForRank,
  rewardsForPlayers,
  rewardsForTeams,
  scoreLine,
  DYE_PALETTE_SIZE,
  pickDyeIndex,
  type Broadcast,
  type Broadcaster,
  type PaintGrid,
  type PaintStanding,
  type RaceResult,
  type RaceTimer,
  type RewardLine,
  type TeamKey,
  type TeamScore,
} from './scoring.ts';

/* ═══════════════════════ 通用模式骨架 ═══════════════════════ */

export const PARTY_MODE_KEY = {
  BRIDGE_CTF: 'BRIDGE_CTF',
  JELLY_BALL: 'JELLY_BALL',
  CROWN_BR: 'CROWN_BR',
  PAINT_WAR: 'PAINT_WAR',
} as const;
export type PartyModeKey = (typeof PARTY_MODE_KEY)[keyof typeof PARTY_MODE_KEY];

export const PARTY_PHASE = {
  IDLE: 'IDLE',
  /** 造桥夺旗的前 15 秒盲盒建造阶段 */
  BUILD: 'BUILD',
  /** 造桥夺旗的后 30 秒冲刺阶段 */
  RACE: 'RACE',
  /** 其它模式的主体进行阶段 */
  PLAY: 'PLAY',
  SETTLED: 'SETTLED',
} as const;
export type PartyPhase = (typeof PARTY_PHASE)[keyof typeof PARTY_PHASE];

export interface PartyModeConfig {
  name: string;
  buildSec: number;
  raceSec: number;
  players: string;
}

/** 从冻结层读模式配置,保证秒数与手册一致。 */
export function partyModeConfig(key: PartyModeKey): PartyModeConfig {
  const m = PARTY_MODES.find((x) => x.key === key);
  if (!m) throw new Error(`PARTY_MODES 缺少 ${key}`);
  return { name: m.name, buildSec: m.buildSec, raceSec: m.raceSec, players: m.players };
}

export interface PartyModeRuntime {
  key: PartyModeKey;
  name: string;
  phase: PartyPhase;
  clock: Clock;
  startedAtSec: number;
  buildSec: number;
  raceSec: number;
  /** 裁判玩家 ID(436 哨台归属者) */
  refereeId: string;
  board: Map<TeamKey, TeamScore>;
  broadcaster: Broadcaster;
  settlement: PartySettlement | null;
  /**
   * ★ WS-FND-120:进入 `SETTLED` 时由 `tickPartyMode` 调用的结算钩子。
   *
   * ## 为什么需要它
   *
   * `tickPartyMode` 只持有 `PartyModeRuntime`,不认识「这是造桥 / 果冻球 / 抢皇冠 / 涂色」
   * 哪一个子运行时 ⇒ 生产里相位到点变成 `SETTLED` 之后,没人去调对应模式的
   * `settle*`(`settleBridgeRun` / `settleJellyBall` / `settleCrown` / `settlePaintWar`
   * 修前**生产零调用**)⇒ `m.settlement` 恒 `null`、`rewards` 永不发放。
   *
   * 由五个 `create*Run` 工厂各自把「自己的结算函数」挂上来(见各工厂末尾),
   * 于是「相位到点 ⇒ 结算」只有**一条**路径,不存在第二份调度表。
   * `null` = 该运行时没有结算语义(裸 `createPartyMode` 的用例)。
   */
  settleHook: (() => PartySettlement) | null;
  rng: Rng;
  /** 累计阶段切换次数 */
  phaseSwitches: number;
}

export interface PartyStandingRow {
  rank: number;
  team: TeamKey;
  label: string;
  value: number;
}

export interface PartySettlement {
  mode: PartyModeKey;
  modeName: string;
  elapsedSec: number;
  /** 团队排名(冠军队在 [0]) */
  standing: PartyStandingRow[];
  rewards: RewardLine[];
  /** 个人名次(跑酷 / 持冠榜) */
  personal: RaceResult[];
  personalRewards: RewardLine[];
  broadcastText: string;
}

export function createPartyMode(opts: {
  key: PartyModeKey;
  clock: Clock;
  refereeId: string;
  seed?: number;
}): PartyModeRuntime {
  const cfg = partyModeConfig(opts.key);
  return {
    key: opts.key,
    name: cfg.name,
    phase: PARTY_PHASE.IDLE,
    clock: opts.clock,
    startedAtSec: 0,
    buildSec: cfg.buildSec,
    raceSec: cfg.raceSec,
    refereeId: opts.refereeId,
    board: createScoreboard(),
    broadcaster: createBroadcaster(),
    settlement: null,
    settleHook: null,
    rng: makeRng(opts.seed ?? 1),
    phaseSwitches: 0,
  };
}

/** 436 派对裁判控制哨台 / 255 裁判金哨子 一键开局。 */
export function startPartyMode(m: PartyModeRuntime): Broadcast {
  m.startedAtSec = m.clock.now();
  m.phaseSwitches = 0;
  m.phase = m.buildSec > 0 ? PARTY_PHASE.BUILD : PARTY_PHASE.PLAY;
  return pushBroadcast(m.broadcaster, BROADCAST_KIND.MODE_START, modeStartLine(m.name, m.refereeId), m.clock.now());
}

export function modeElapsedSec(m: PartyModeRuntime): number {
  return m.clock.now() - m.startedAtSec;
}

/** 总时长(建 + 冲)。 */
export function modeTotalSec(m: PartyModeRuntime): number {
  return m.buildSec + m.raceSec;
}

/**
 * 通过**结算钩子**结算一次(`settleHook` 由各 `create*Run` 挂上)。
 *
 * 幂等:`m.settlement` 非空 ⇒ 原样返回那一份,不重算(重复调用一分不加)。
 * `null` = 这个运行时没有结算语义(裸 `createPartyMode`),或钩子还没挂。
 */
export function settlePartyRun(m: PartyModeRuntime): PartySettlement | null {
  if (m.settlement !== null) return m.settlement;
  const hook = m.settleHook;
  if (hook === null) return null;
  return hook();
}

/**
 * 全模式统一推进入口:处理 BUILD→RACE→SETTLED(→IDLE,见 §6)的相位与总时长。
 * 注意 CROWN_BR 由 `tickCrown` 自行判定提前结束,此函数只兜底超时。
 *
 * ★ WS-FND-120:相位走到 `SETTLED` 时**顺便结算**(`settlePartyRun`),不再依赖
 * 上层「记得调 settle*」—— 修前五个 `settle*` 在生产里零调用,`settlement`
 * 恒 `null`、`rewards` 一份不发。现在有两条进入结算的路径,都只走钩子:
 *   · 本函数把相位推到 `SETTLED` 的那一帧(超时);
 *   · 子运行自己提前结束(如 `tickCrown` 的 60 秒持冠)⇒ 走「已 SETTLED 但还没结算」那一支。
 */
export function tickPartyMode(m: PartyModeRuntime): string[] {
  const ev: string[] = [];
  if (m.phase === PARTY_PHASE.IDLE) return ev;
  const t = modeElapsedSec(m);

  /* 已结束:未结算 ⇒ 本帧补结算;结算已定格 ⇒ **自动回 IDLE**(§6,D-23)。 */
  if (m.phase === PARTY_PHASE.SETTLED) {
    if (m.settlement !== null) return autoIdleAfterSettle(m, ev);
    const done = settlePartyRun(m);
    if (done !== null && m.settlement === done) ev.push('PARTY_SETTLED');
    return ev;
  }

  if (m.buildSec > 0 && m.phase === PARTY_PHASE.BUILD && t >= m.buildSec - 1e-9) {
    m.phase = PARTY_PHASE.RACE;
    m.phaseSwitches += 1;
    ev.push('PHASE:RACE');
    pushBroadcast(m.broadcaster, BROADCAST_KIND.PHASE, '建造阶段结束,冲向对岸夺旗!', m.clock.now());
  }

  if (t >= modeTotalSec(m) - 1e-9) {
    m.phase = PARTY_PHASE.SETTLED;
    m.phaseSwitches += 1;
    ev.push('PHASE:SETTLED');
    /* 结算与相位切换**同帧**:`settleBridgeRun` 的安慰分只在 `SETTLED` 折算,
       故必须先置相位再结算(顺序颠倒会把安慰分静默吞掉)。 */
    const done = settlePartyRun(m);
    if (done !== null) ev.push('PARTY_SETTLED');
  }
  return ev;
}

/* ═══════════════════════ 1. 造桥夺旗(15s 建 + 30s 冲刺) ═══════════════════════ */

export const BRIDGE_BUILD_SEC = 15;
export const BRIDGE_RACE_SEC = 30;
export const BRIDGE_TILES_TO_WIN = 12;
/** 435 四色队伍出生复活旗;夺旗目标物为对岸旗帜。 */
export const BRIDGE_FLAG_ITEM_ID = 435;
export const BRIDGE_BOARD_ITEM_ID = 152;
/** 每一步建造/冲刺折算的团队分。 */
export const BRIDGE_SCORE_PER_FLAG = 100;
export const BRIDGE_SCORE_PER_TILE = 2;

export interface BridgeRunRuntime {
  mode: PartyModeRuntime;
  /** 各队已建桥板数 */
  built: Map<TeamKey, number>;
  /** 各队是否已夺旗 */
  flagged: Map<TeamKey, boolean>;
  /** 建造期间布下的盲盒陷阱数 */
  traps: number;
  rng: Rng;
}

export function createBridgeRun(clock: Clock, refereeId: string, seed = 11): BridgeRunRuntime {
  const mode = createPartyMode({ key: PARTY_MODE_KEY.BRIDGE_CTF, clock, refereeId, seed });
  if (mode.buildSec !== BRIDGE_BUILD_SEC || mode.raceSec !== BRIDGE_RACE_SEC) {
    throw new Error('PARTY_MODES 的造桥夺旗节拍与手册 §6.3 的 15s / 30s 不符');
  }
  const run: BridgeRunRuntime = {
    mode,
    built: new Map(TEAM_ORDER.map((t) => [t, 0])),
    flagged: new Map(TEAM_ORDER.map((t) => [t, false])),
    traps: 0,
    rng: makeRng(seed),
  };
  /* ★ WS-FND-120:把结算函数挂到相位钩子上 —— `tickPartyMode` 到点自己结算。 */
  mode.settleHook = () => settleBridgeRun(run);
  return run;
}

/** 建造阶段:摆一块桥板 / 一个盲盒陷阱。冲刺阶段拒绝建造。 */
export function bridgePlace(r: BridgeRunRuntime, team: TeamKey, isTrap = false): boolean {
  if (r.mode.phase !== PARTY_PHASE.BUILD) return false;
  if (isTrap) {
    r.traps += 1;
    return true;
  }
  r.built.set(team, (r.built.get(team) ?? 0) + 1);
  return true;
}

/** 冲刺阶段:过河夺旗。桥板不足 BRIDGE_TILES_TO_WIN 则无法过河。 */
export function bridgeCapture(r: BridgeRunRuntime, team: TeamKey): boolean {
  if (r.mode.phase !== PARTY_PHASE.RACE) return false;
  const built = r.built.get(team) ?? 0;
  if (built < BRIDGE_TILES_TO_WIN) return false;
  if (r.flagged.get(team)) return false;
  r.flagged.set(team, true);
  getTeam(r.mode.board, team).score += BRIDGE_SCORE_PER_FLAG;
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.SCORE, `${TEAM_LABEL[team]} 夺旗成功!`, r.mode.clock.now());
  return true;
}

/**
 * 冲刺阶段结束时结算:未夺旗队伍按已建桥板数折算安慰分。
 *
 * ## ★ 幂等 + 相位门槛(第三轮实测缺陷)
 *
 * 改前这个函数**没有结算标记、也没有相位门槛**:每调一次就
 * `score += built × BRIDGE_SCORE_PER_TILE` 一遍。于是
 *   · 重复调用(编排层重发同一帧、重试、测试里手滑两次)⇒ 安慰分翻倍;
 *   · 建造阶段 / 冲刺中途调用 ⇒ 「没打完就先发安慰分」。
 * 两条都不报错,只是分数悄悄不对 —— 而分数就是本模式的唯一产出。
 *
 * 修法分两步,判据各自独立:
 *   1 **幂等**:`r.mode.settlement` 是既有的结算句柄(`tickPartyMode` 到点把
 *     相位置成 `SETTLED`)。非空 ⇒ 直接返回那一份,**不重算、不加分**;
 *   2 **相位门槛**:只有 `SETTLED` 才折算安慰分,且只有那时才**占用**结算句柄
 *     (`r.mode.settlement` 保持 `null`)—— 提早调用拿到的是一份「当前排名、
 *     无安慰分」的快照,之后的正常结算仍会照常发生。
 */
export function settleBridgeRun(r: BridgeRunRuntime): PartySettlement {
  /* 1 幂等:已结算 ⇒ 原样返回(第二次调用一分不加)。 */
  if (r.mode.settlement !== null) return r.mode.settlement;
  /* 2 相位门槛:只有冲刺阶段走完(SETTLED)才发安慰分。 */
  if (r.mode.phase === PARTY_PHASE.SETTLED) {
    for (const t of TEAM_ORDER) {
      if (!r.flagged.get(t)) getTeam(r.mode.board, t).score += (r.built.get(t) ?? 0) * BRIDGE_SCORE_PER_TILE;
    }
  }
  const rows = TEAM_ORDER.map((t) => ({ team: t, value: getTeam(r.mode.board, t).score }));
  rows.sort((a, b) => (b.value - a.value) || (TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team)));
  const standing: PartyStandingRow[] = rows.map((x, i) => ({
    rank: i + 1, team: x.team, label: TEAM_LABEL[x.team], value: x.value,
  }));
  const winner = standing[0];
  const text = modeEndLine(r.mode.name, `${winner.label} 以 ${winner.value} 分获胜`);
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.MODE_END, text, r.mode.clock.now());
  const settlement: PartySettlement = {
    mode: r.mode.key,
    modeName: r.mode.name,
    elapsedSec: modeElapsedSec(r.mode),
    standing,
    rewards: rewardsForTeams(standing.map((s) => ({ rank: s.rank, team: s.team, tiles: 0, ratio: 0 }))),
    personal: [],
    personalRewards: [],
    broadcastText: text,
  };
  /* 只在相位真的走完时才占用结算句柄(提早调用 ⇒ 不锁死后面的正常结算)。 */
  if (r.mode.phase === PARTY_PHASE.SETTLED) r.mode.settlement = settlement;
  return settlement;
}

/* ═══════════════════════ 2. 4v4 果冻球 ═══════════════════════ */

export const JELLY_TEAM_SIZE = 4;
/** 高弹软包防撞墙弹性系数。 */
export const JELLY_RESTITUTION = 0.92;
/** 镜面冰砖摩擦系数(与 items.ts 315 同档)。 */
export const JELLY_MU = 0.98;
export const JELLY_GOAL_WIDTH = 3;
export const JELLY_GOAL_DEPTH = 1;
/** 410 球门框:进球后 1.0 秒把球复位到 433 生成座。 */
export const JELLY_BALL_RESET_SEC = 1.0;
/** 球体半径。 */
export const JELLY_BALL_RADIUS = 0.5;

export interface JellyBall {
  spawnX: number;
  spawnY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 复位倒计时 */
  resetTimer: number;
  live: boolean;
}

export interface JellyGoal {
  team: TeamKey;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface JellyBallRuntime {
  mode: PartyModeRuntime;
  ball: JellyBall;
  goals: JellyGoal[];
  /** 410 触发次数 */
  goalTriggers: number;
  rng: Rng;
}

export function createJellyBall(clock: Clock, refereeId: string, seed = 22): JellyBallRuntime {
  const mode = createPartyMode({ key: PARTY_MODE_KEY.JELLY_BALL, clock, refereeId, seed });
  const run: JellyBallRuntime = {
    mode,
    ball: { spawnX: 20, spawnY: 0, x: 20, y: 0, vx: 0, vy: 0, resetTimer: 0, live: true },
    goals: [
      { team: TEAM_KEY.RED, x: 0, y: -JELLY_GOAL_DEPTH, w: JELLY_GOAL_WIDTH, h: JELLY_GOAL_DEPTH },
      { team: TEAM_KEY.BLUE, x: 0, y: 1, w: JELLY_GOAL_WIDTH, h: JELLY_GOAL_DEPTH },
    ],
    goalTriggers: 0,
    rng: makeRng(seed),
  };
  /* ★ WS-FND-120:同上,果冻球的结算也挂到相位钩子上。 */
  mode.settleHook = () => settleJellyBall(run);
  return run;
}

export function kickBall(r: JellyBallRuntime, vx: number, vy: number): void {
  if (!r.ball.live) return;
  r.ball.vx = vx;
  r.ball.vy = vy;
}

/** 单步推进球体:冰面摩擦 + 复位倒计时。 */
export function tickJellyBall(r: JellyBallRuntime, dt: number): void {
  if (dt <= 0) return;
  if (!r.ball.live) {
    r.ball.resetTimer -= dt;
    if (r.ball.resetTimer <= 0) {
      r.ball.x = r.ball.spawnX;
      r.ball.y = r.ball.spawnY;
      r.ball.vx = 0;
      r.ball.vy = 0;
      r.ball.live = true;
      r.ball.resetTimer = 0;
    }
    return;
  }
  r.ball.vx *= JELLY_MU;
  r.ball.vy *= JELLY_MU;
  r.ball.x += r.ball.vx * dt;
  r.ball.y += r.ball.vy * dt;
}

/** 球是否落在某个球门框内(考虑球半径)。 */
export function ballInGoal(r: JellyBallRuntime, g: JellyGoal): boolean {
  return r.ball.x + JELLY_BALL_RADIUS >= g.x
    && r.ball.x - JELLY_BALL_RADIUS <= g.x + g.w
    && r.ball.y + JELLY_BALL_RADIUS >= g.y
    && r.ball.y - JELLY_BALL_RADIUS <= g.y + g.h;
}

export interface GoalResult {
  scored: boolean;
  scoringTeam: TeamKey | null;
  scoreLine: string;
  text: string;
  /** 球被复位 */
  ballReset: boolean;
}

/**
 * 进球判定:球进入某队球门 ⇒ **对手队**得分。
 * 触发 410 全房播报比分,并把球复位到 433 生成座。
 */
export function judgeGoal(r: JellyBallRuntime): GoalResult {
  const empty: GoalResult = {
    scored: false, scoringTeam: null, scoreLine: scoreLine(r.mode.board), text: '', ballReset: false,
  };
  if (!r.ball.live) return empty;
  for (const g of r.goals) {
    if (!ballInGoal(r, g)) continue;
    const scorer = g.team === TEAM_KEY.RED ? TEAM_KEY.BLUE : TEAM_KEY.RED;
    const ts = getTeam(r.mode.board, scorer);
    ts.goals += 1;
    ts.score += 1;
    r.goalTriggers += 1;
    r.ball.live = false;
    r.ball.resetTimer = JELLY_BALL_RESET_SEC;
    const line = scoreLine(r.mode.board);
    const text = `${TEAM_LABEL[scorer]} 进球!比分 ${line}`;
    pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.GOAL, text, r.mode.clock.now());
    return { scored: true, scoringTeam: scorer, scoreLine: line, text, ballReset: true };
  }
  return empty;
}

export function settleJellyBall(r: JellyBallRuntime): PartySettlement {
  const rows = TEAM_ORDER.map((t) => ({ team: t, value: getTeam(r.mode.board, t).goals }));
  rows.sort((a, b) => (b.value - a.value) || (TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team)));
  const standing: PartyStandingRow[] = rows.map((x, i) => ({
    rank: i + 1, team: x.team, label: TEAM_LABEL[x.team], value: x.value,
  }));
  const text = modeEndLine(r.mode.name, `最终比分 ${scoreLine(r.mode.board)}`);
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.MODE_END, text, r.mode.clock.now());
  const settlement: PartySettlement = {
    mode: r.mode.key,
    modeName: r.mode.name,
    elapsedSec: modeElapsedSec(r.mode),
    standing,
    rewards: rewardsForTeams(standing.map((s) => ({ rank: s.rank, team: s.team, tiles: 0, ratio: 0 }))),
    personal: [],
    personalRewards: [],
    broadcastText: text,
  };
  r.mode.settlement = settlement;
  return settlement;
}

/* ═══════════════════════ 3. 金皇冠大逃杀 ═══════════════════════ */

export const CROWN_MODE_SEC = 180;
/** 先积满 60 秒持冠时间者获胜。 */
export const CROWN_WIN_SEC = 60;
export const CROWN_ITEM_ID = 434;
/** 掉冠后 5 秒才能被再次拾取,防止抖冠刷分。 */
export const CROWN_PICKUP_COOLDOWN_SEC = 5;

export interface CrownRuntime {
  mode: PartyModeRuntime;
  /** 当前持冠者 id;null 表示皇冠落地 */
  holder: string | null;
  /** 当前持冠者所属队伍 */
  holderTeam: TeamKey | null;
  /** 掉冠冷却剩余 */
  cooldownSec: number;
  /** 各玩家累计持冠秒数 */
  perPlayer: Map<string, number>;
  /** 是否已有队伍达标 */
  winner: TeamKey | null;
  /** 全房玩家 -> 所属队伍 */
  teams: Map<string, TeamKey>;
}

export function createCrownRun(clock: Clock, refereeId: string, seed = 33): CrownRuntime {
  const mode = createPartyMode({ key: PARTY_MODE_KEY.CROWN_BR, clock, refereeId, seed });
  if (mode.raceSec !== CROWN_MODE_SEC) throw new Error('抢皇冠模式时长与 PARTY_MODES 的 180s 不符');
  const run: CrownRuntime = {
    mode,
    holder: null,
    holderTeam: null,
    cooldownSec: 0,
    perPlayer: new Map(),
    winner: null,
    teams: new Map(),
  };
  /* ★ WS-FND-120:抢皇冠的胜者由 `tickCrown` 提前置 SETTLED ⇒ 钩子让下一次
     `tickPartyMode` 把 `settleCrown` 真的跑掉(修前它生产零调用)。 */
  mode.settleHook = () => settleCrown(run);
  return run;
}

/** 玩家入座时登记归属队伍(对应 435 复活旗选色)。 */
export function crownAssignTeam(r: CrownRuntime, playerId: string, team: TeamKey): void {
  r.teams.set(playerId, team);
  if (!r.perPlayer.has(playerId)) r.perPlayer.set(playerId, 0);
}

/** 拾取金皇冠(434 底座)。有冷却、无人持冠或已有胜者时拒绝。 */
export function crownPickup(r: CrownRuntime, playerId: string): boolean {
  if (r.holder !== null || r.cooldownSec > 0 || r.winner !== null) return false;
  const team = r.teams.get(playerId);
  if (!team) return false;
  r.holder = playerId;
  r.holderTeam = team;
  pushBroadcast(
    r.mode.broadcaster,
    BROADCAST_KIND.CROWN,
    `${playerId}(${TEAM_LABEL[team]})举起了金皇冠!`,
    r.mode.clock.now(),
  );
  return true;
}

/** 掉冠(被 222 大锤击退 / 225 香蕉皮 / 224 钩爪拽倒):皇冠落地并进入 5 秒冷却。 */
export function crownDrop(r: CrownRuntime): boolean {
  if (r.holder === null) return false;
  const who = r.holder;
  r.holder = null;
  r.holderTeam = null;
  r.cooldownSec = CROWN_PICKUP_COOLDOWN_SEC;
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.CROWN, `${who} 被撞飞,皇冠落地!`, r.mode.clock.now());
  return true;
}

/** 单步推进持冠计秒。返回事件名列表。 */
export function tickCrown(r: CrownRuntime, dt: number): string[] {
  const ev: string[] = [];
  if (dt <= 0) return ev;
  if (r.mode.phase === PARTY_PHASE.IDLE || r.mode.phase === PARTY_PHASE.SETTLED) return ev;
  if (r.cooldownSec > 0) r.cooldownSec = Math.max(0, r.cooldownSec - dt);
  if (r.holder !== null && r.holderTeam !== null) {
    const ts = getTeam(r.mode.board, r.holderTeam);
    ts.crownSec += dt;
    r.perPlayer.set(r.holder, (r.perPlayer.get(r.holder) ?? 0) + dt);
    if (ts.crownSec >= CROWN_WIN_SEC - 1e-9) {
      r.winner = r.holderTeam;
      r.mode.phase = PARTY_PHASE.SETTLED;
      ev.push('CROWN_WIN');
      pushBroadcast(
        r.mode.broadcaster,
        BROADCAST_KIND.MODE_END,
        modeEndLine(r.mode.name, `${TEAM_LABEL[r.holderTeam]} 持冠满 ${CROWN_WIN_SEC} 秒获胜!`),
        r.mode.clock.now(),
      );
    }
  }
  return ev;
}

export function settleCrown(r: CrownRuntime): PartySettlement {
  const rows = TEAM_ORDER.map((t) => ({ team: t, value: getTeam(r.mode.board, t).crownSec }));
  rows.sort((a, b) => (b.value - a.value) || (TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team)));
  const standing: PartyStandingRow[] = rows.map((x, i) => ({
    rank: i + 1, team: x.team, label: TEAM_LABEL[x.team], value: x.value,
  }));
  const players: { id: string; value: number }[] = [...r.perPlayer.entries()]
    .map(([id, sec]) => ({ id, value: sec }));
  /* 持冠秒数越多越好 → 降序排名 */
  const ranked = rankByDescending(players);
  const personal: RaceResult[] = ranked.map((x) => ({
    rank: x.rank,
    playerId: x.id,
    elapsedMs: Math.round(x.value * 1000),
    dnf: false,
  }));
  const text = modeEndLine(r.mode.name, crownLine(r.mode.board));
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.MODE_END, text, r.mode.clock.now());
  const settlement: PartySettlement = {
    mode: r.mode.key,
    modeName: r.mode.name,
    elapsedSec: modeElapsedSec(r.mode),
    standing,
    rewards: rewardsForTeams(standing.map((s) => ({ rank: s.rank, team: s.team, tiles: 0, ratio: 0 }))),
    personal,
    personalRewards: rewardsForPlayers(personal),
    broadcastText: text,
  };
  r.mode.settlement = settlement;
  return settlement;
}

/* ═══════════════════════ 4. 圈地涂色 ═══════════════════════ */

export const PAINT_MODE_SEC = 120;
export const PAINT_GRID_W = 24;
export const PAINT_GRID_H = 24;
/** 237 颜料水球单次染色半径。 */
export const PAINT_BALL_RADIUS = 1;
/** 505 炼金调色染缸的 32 色染料。 */
export const PAINT_DYE_COUNT = DYE_PALETTE_SIZE;

export interface PaintWarRuntime {
  mode: PartyModeRuntime;
  grid: PaintGrid;
  /** 各队累计投出的水球数 */
  balls: Map<TeamKey, number>;
  /** rng 取色记录(可复现) */
  dyeLog: number[];
  rng: Rng;
}

export function createPaintWar(clock: Clock, refereeId: string, seed = 44): PaintWarRuntime {
  const mode = createPartyMode({ key: PARTY_MODE_KEY.PAINT_WAR, clock, refereeId, seed });
  if (mode.raceSec !== PAINT_MODE_SEC) throw new Error('涂色模式时长与 PARTY_MODES 的 120s 不符');
  const run: PaintWarRuntime = {
    mode,
    grid: createPaintGrid(PAINT_GRID_W, PAINT_GRID_H),
    balls: new Map(TEAM_ORDER.map((t) => [t, 0])),
    dyeLog: [],
    rng: makeRng(seed),
  };
  /* ★ WS-FND-120:涂色的结算同样挂到相位钩子上。 */
  mode.settleHook = () => settlePaintWar(run);
  return run;
}

export interface ThrowPaintResult {
  painted: number;
  dyeIndex: number;
  team: TeamKey;
  tiles: number;
}

/** 投出一颗颜料水球:按注入 rng 取色号,并在落点刷一块色。 */
export function throwPaintBall(r: PaintWarRuntime, team: TeamKey, x: number, y: number): ThrowPaintResult {
  const dyeIndex = pickDyeIndex(r.rng);
  r.dyeLog.push(dyeIndex);
  const painted = paintRadius(r.grid, x, y, PAINT_BALL_RADIUS, team);
  r.balls.set(team, (r.balls.get(team) ?? 0) + 1);
  const tiles = countTiles(r.grid, team);
  getTeam(r.mode.board, team).tiles = tiles;
  return { painted, dyeIndex, team, tiles };
}

function countTiles(g: PaintGrid, team: TeamKey): number {
  let n = 0;
  for (const c of g.cells) if (c === team) n += 1;
  return n;
}

/** 120 秒结束后按色块数排名并结算。 */
export function settlePaintWar(r: PaintWarRuntime): PartySettlement {
  const rank: PaintStanding[] = rankPaint(r.grid);
  for (const s of rank) getTeam(r.mode.board, s.team).tiles = s.tiles;
  const standing: PartyStandingRow[] = rank.map((s) => ({
    rank: s.rank, team: s.team, label: TEAM_LABEL[s.team], value: s.tiles,
  }));
  const text = modeEndLine(r.mode.name, paintStandingLine(rank));
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.PAINT, text, r.mode.clock.now());
  const settlement: PartySettlement = {
    mode: r.mode.key,
    modeName: r.mode.name,
    elapsedSec: modeElapsedSec(r.mode),
    standing,
    rewards: rewardsForTeams(rank),
    personal: [],
    personalRewards: [],
    broadcastText: text,
  };
  r.mode.settlement = settlement;
  return settlement;
}

/* ═══════════════════════ 5. 跑酷 / 马拉松毫秒计时 ═══════════════════════ */

/*
 * ★ **赛道运行时的唯一权威(WS-FND-149 边界裁决)**
 *
 * 仓库里有两个"赛道运行时":本段的 `RaceRuntime`(`party/modes.ts`)与
 * `social/afk.ts#TrackRuntime`(马拉松 / 风筝 Boss 跑道的罚时计时)。两者**并存是刻意的**,
 * 但它们不是平级的两套 —— 边界三条,各自有能抓回归的判据
 * (`tests/WS-FND-149-arch-hazards.test.ts`):
 *
 * 1 **结算权在本段**:发奖 / 播报 / `PartySettlement` 只有这里产出
 *   (`podiumBroadcast` / `rewardsForPlayers` / `pushBroadcast` 都只在本文件出现);
 *   `social/afk.ts` 的 import 表里没有这三样,它的赛道段也不定义 `RewardLine` /
 *   `PartySettlement` ⇒ **不存在第二条结算链**。
 * 2 **推进权只有一处**:本段的相位由 `tickPartyContest`(`sim/world_sim.ts` 慢帧)推进;
 *   `social/afk.ts` 的赛道**没有 `tick`**(只有 `trackStart` / `trackFinish` 两个被动计时口)
 *   ⇒「两套同时推进同一 tick」在结构上不可能。
 * 3 **同一只毫秒表**:两套都用 `party/scoring.ts#RaceTimer`
 *   (`createRaceTimer` / `gateStart` / `podiumFinish` / `rankRace`),谁也不许自带第二套时钟
 *   (毫秒口径分叉 = 同一场比赛两个成绩)。
 *
 * ⇒ 一句话:`RaceRuntime` 是**玩法与结算**的赛道,`afk.ts#TrackRuntime` 是**罚时视图**
 *   (风筝 Boss 追上 +3s 后的耗时展示)。要合并就先删掉一方,不要给两边各加一个 tick。
 */

export interface RaceRuntime {
  mode: PartyModeRuntime;
  timers: Map<string, RaceTimer>;
  /** 411 发令门是否已落下(开局) */
  gateOpen: boolean;
  results: RaceResult[];
}

/**
 * 独立跑酷计时赛(借用 BRIDGE_CTF 的配置骨架但覆盖时长)。
 * 411 起点门 + 412 领奖台为本模式的核心联动件。
 *
 * ★ 这是**玩法与结算**的赛道:发奖 / 播报 / `PartySettlement` 只从本运行时出;
 *   `social/afk.ts#TrackRuntime` 是它的**罚时视图**,不结算(边界见本节开头的裁决)。
 */
export function createRaceRun(clock: Clock, refereeId: string, raceSec = 90, seed = 55): RaceRuntime {
  const mode = createPartyMode({ key: PARTY_MODE_KEY.BRIDGE_CTF, clock, refereeId, seed });
  mode.name = '风车跑酷计时赛';
  mode.buildSec = 0;
  mode.raceSec = raceSec;
  const run: RaceRuntime = { mode, timers: new Map(), results: [], gateOpen: false };
  /* ★ WS-FND-120:跑酷结算走同一个相位钩子(修前 `settleRace` 生产零调用)。 */
  mode.settleHook = () => settleRace(run);
  return run;
}

export function registerRunner(r: RaceRuntime, playerId: string): RaceTimer {
  let t = r.timers.get(playerId);
  if (!t) {
    t = createRaceTimer(playerId);
    r.timers.set(playerId, t);
  }
  return t;
}

/** 411 跑酷起点发令门:裁判吹哨后,穿过门的玩家各自开启毫秒计时。 */
export function openGate(r: RaceRuntime, atSec: number, playerIds: readonly string[]): number {
  r.gateOpen = true;
  let n = 0;
  for (const id of playerIds) {
    const t = registerRunner(r, id);
    if (t.startMs === null) {
      gateStart(t, atSec);
      n += 1;
    }
  }
  return n;
}

/** 412 终点领奖台:冲线即停表。 */
export function finishRunner(r: RaceRuntime, playerId: string, atSec: number): boolean {
  return podiumFinish(registerRunner(r, playerId), atSec);
}

/** 结算并播报前三名毫秒耗时。 */
export function settleRace(r: RaceRuntime): PartySettlement {
  const results = rankRace([...r.timers.values()]);
  r.results = results;
  const text = podiumBroadcast(results);
  pushBroadcast(r.mode.broadcaster, BROADCAST_KIND.RACE_TOP3, text, r.mode.clock.now());
  const standing: PartyStandingRow[] = TEAM_ORDER.map((t, i) => ({
    rank: i + 1,
    team: t,
    label: TEAM_LABEL[t],
    value: 0,
  }));
  const settlement: PartySettlement = {
    mode: r.mode.key,
    modeName: r.mode.name,
    elapsedSec: modeElapsedSec(r.mode),
    standing,
    rewards: standing.map((s) => rewardForRank(s.rank)),
    personal: results,
    personalRewards: rewardsForPlayers(results),
    broadcastText: text,
  };
  r.mode.settlement = settlement;
  return settlement;
}

/* ═══════════════════════ 对局容器(子运行 + 相位 + 结算) ═══════════════════════ */

/**
 * ★ WS-FND-120:四大模式**子运行**的统一容器。
 *
 * ## 为什么需要一个容器(而不是只持 `PartyModeRuntime`)
 *
 * `PartyModeRuntime` 只有相位 / 记分板 / 播报队列;「夺旗」「拾冠」「进球」
 * 这些**动作**全挂在子运行时上(`BridgeRunRuntime` / `CrownRuntime` / ...)。
 * 修前世界侧只持有 `PartyModeRuntime` ⇒ 拿不到子运行 ⇒
 * `bridgeCapture` / `crownPickup` 在生产里**只剩测试一个调用者**。
 *
 * ⇒ 容器把「相位 + 子运行」绑在一起:世界侧(`sim/world_sim.ts`)持容器,
 *   动作层(`party/actions.ts`)只认容器,两者都不需要认识五个子运行类型。
 */
export type PartyContest =
  | { key: typeof PARTY_MODE_KEY.BRIDGE_CTF; bridge: BridgeRunRuntime }
  | { key: typeof PARTY_MODE_KEY.JELLY_BALL; jelly: JellyBallRuntime }
  | { key: typeof PARTY_MODE_KEY.CROWN_BR; crown: CrownRuntime }
  | { key: typeof PARTY_MODE_KEY.PAINT_WAR; paint: PaintWarRuntime };

export function createPartyContest(
  key: PartyModeKey,
  clock: Clock,
  refereeId: string,
  seed = 1,
): PartyContest {
  switch (key) {
    case PARTY_MODE_KEY.BRIDGE_CTF: return { key, bridge: createBridgeRun(clock, refereeId, seed) };
    case PARTY_MODE_KEY.JELLY_BALL: return { key, jelly: createJellyBall(clock, refereeId, seed) };
    case PARTY_MODE_KEY.CROWN_BR: return { key, crown: createCrownRun(clock, refereeId, seed) };
    case PARTY_MODE_KEY.PAINT_WAR: return { key, paint: createPaintWar(clock, refereeId, seed) };
    default: {
      /* 词表来自冻结层 ⇒ 这里不可能到;写成抛错而不是兜底,避免「静默跑错模式」。 */
      const never: never = key;
      throw new Error(`未知派对模式 ${String(never)}`);
    }
  }
}

export function contestMode(c: PartyContest): PartyModeRuntime {
  return c.key === PARTY_MODE_KEY.BRIDGE_CTF ? c.bridge.mode
    : c.key === PARTY_MODE_KEY.JELLY_BALL ? c.jelly.mode
      : c.key === PARTY_MODE_KEY.CROWN_BR ? c.crown.mode
        : c.paint.mode;
}

export function contestBroadcaster(c: PartyContest): Broadcaster {
  return contestMode(c).broadcaster;
}

/**
 * 推进一帧:**子运行在前,相位在后**。
 *
 * 顺序有实质意义:`tickCrown` 会在 60 秒持冠时自己把相位置 `SETTLED`,
 * 紧接着的 `tickPartyMode` 走「已结束但未结算」那一支把 `settleCrown` 跑掉。
 * 反过来先推相位再推子运行,宣胜那一帧就白过。
 */
export function tickPartyContest(c: PartyContest, dt: number): string[] {
  const ev: string[] = [];
  if (c.key === PARTY_MODE_KEY.JELLY_BALL) {
    tickJellyBall(c.jelly, dt);
    const goal = judgeGoal(c.jelly);
    if (goal.scored) ev.push('PARTY_GOAL');
  }
  if (c.key === PARTY_MODE_KEY.CROWN_BR) {
    ev.push(...tickCrown(c.crown, dt));
  }
  ev.push(...tickPartyMode(contestMode(c)));
  return ev;
}

/** 造桥:摆一块桥板(消耗由调用方负责)。非造桥容器 / 相位不对 ⇒ false。 */
export function contestPlaceBoard(c: PartyContest, team: TeamKey, isTrap = false): boolean {
  if (c.key !== PARTY_MODE_KEY.BRIDGE_CTF) return false;
  return bridgePlace(c.bridge, team, isTrap);
}

/** 造桥:夺旗。非造桥容器 ⇒ false。 */
export function contestCapture(c: PartyContest, team: TeamKey): boolean {
  if (c.key !== PARTY_MODE_KEY.BRIDGE_CTF) return false;
  return bridgeCapture(c.bridge, team);
}

/** 造桥:某队已建桥板数(动作层的前置判定与断言用);非造桥 ⇒ null。 */
export function contestBuiltOf(c: PartyContest, team: TeamKey): number | null {
  if (c.key !== PARTY_MODE_KEY.BRIDGE_CTF) return null;
  return c.bridge.built.get(team) ?? 0;
}

/** 抢皇冠:登记玩家队伍(对应 435 复活旗选色)。非抢皇冠容器 ⇒ false。 */
export function contestAssignTeam(c: PartyContest, playerId: string, team: TeamKey): boolean {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return false;
  crownAssignTeam(c.crown, playerId, team);
  return true;
}

/** 抢皇冠:拾冠。非抢皇冠容器 / 未登记队伍 ⇒ false。 */
export function contestCrownPickup(c: PartyContest, playerId: string): boolean {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return false;
  return crownPickup(c.crown, playerId);
}

/** 抢皇冠:掉冠(被整蛊玩具击退)。非抢皇冠容器 ⇒ false。 */
export function contestCrownDrop(c: PartyContest): boolean {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return false;
  return crownDrop(c.crown);
}

/** 抢皇冠:当前持冠者;非抢皇冠 / 皇冠落地 ⇒ null。 */
export function contestCrownHolder(c: PartyContest): string | null {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return null;
  return c.crown.holder;
}

/** 造桥:某队是否已夺过旗;非造桥 ⇒ false。 */
export function contestBridgeFlagged(c: PartyContest, team: TeamKey): boolean {
  if (c.key !== PARTY_MODE_KEY.BRIDGE_CTF) return false;
  return c.bridge.flagged.get(team) === true;
}

/** 抢皇冠:掉冠冷却剩余秒数;非抢皇冠 ⇒ 0。 */
export function contestCrownCooldown(c: PartyContest): number {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return 0;
  return c.crown.cooldownSec;
}

/** 抢皇冠:已达标获胜的队伍;非抢皇冠 / 没人达标 ⇒ null。 */
export function contestCrownWinner(c: PartyContest): TeamKey | null {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return null;
  return c.crown.winner;
}

/** 抢皇冠:某玩家累计持冠秒数(诊断用);非抢皇冠 ⇒ null。 */
export function contestCrownSecOf(c: PartyContest, playerId: string): number | null {
  if (c.key !== PARTY_MODE_KEY.CROWN_BR) return null;
  return c.crown.perPlayer.get(playerId) ?? 0;
}

/** 结算结果(未结算 ⇒ null)。 */
export function contestSettlement(c: PartyContest): PartySettlement | null {
  return contestMode(c).settlement;
}

/* ═══════════════════════ 自检 ═══════════════════════ */

/** 冻结层四模式齐备且节拍与手册一致。 */
export function assertAllModesPresent(): void {
  const keys = new Set<string>(PARTY_MODES.map((m) => m.key));
  for (const k of ['BRIDGE_CTF', 'JELLY_BALL', 'CROWN_BR', 'PAINT_WAR']) {
    if (!keys.has(k)) throw new Error(`PARTY_MODES 缺少模式 ${k}`);
  }
  if (PARTY_MODES.length !== 4) throw new Error(`PARTY_MODES 数量 ${PARTY_MODES.length} 不等于 4`);
  const bridge = PARTY_MODES.find((m) => m.key === 'BRIDGE_CTF');
  if (!bridge || bridge.buildSec !== BRIDGE_BUILD_SEC || bridge.raceSec !== BRIDGE_RACE_SEC) {
    throw new Error('造桥夺旗节拍与手册 15s / 30s 不一致');
  }
}

assertAllModesPresent();

/* ═══════════ ★ WS-FND-176 §6:结算之后**自动回 `IDLE`**(owner 裁定 D-23)═══════════
 *
 * ⚠️ 本段放在**文件末**是刻意的:`party/modes.ts` 的上半段有按**行号**钉住的判据锚
 * (`tests/WS-FND-136-constants-single-source.test.ts` 的 257/258/329/479/595-598/
 * 614/695/706),在中间插行会让那些锚整段漂移 ⇒ 追加在这里,它们一行都不动。
 */

/**
 * **结算定格之后把相位送回 `IDLE`** —— D-23「派对结算自动回 `IDLE`」的实现点。
 * 唯一调用点:`tickPartyMode` 的 `SETTLED` 支(`if (m.settlement !== null)`)。
 *
 * ## 修前是什么样(与 D-23 **直接冲突**的缺陷)
 *
 * ```text
 * `phase` 一旦变成 SETTLED 就再也出不去 —— 全仓只有 436 哨台按 -1 的
 * `WorldSim.clearPartyRun()` 清掉赛局容器 ⇒ `partyPhase()` 才回 'IDLE'。
 * 自然超时结算的局没有任何人按 -1:
 *   ⇒ `partyPhase()` 永远停在 'SETTLED'
 *   ⇒ 房间侧 `syncPartyRecord` 的收束支(**判据是 `'IDLE'`**)永不触发
 *   ⇒ 记分账 `PartyRecord` 永远 `RUNNING`,`addScore` 继续累计
 *     (名次早在结算那一刻定格,分却还在涨 —— 谁最后报分谁赢)
 * ```
 *
 * ⇒ 本函数补上那一步:结算**已经定格**之后的下一慢帧,相位回 `IDLE`。
 * `WorldSim.partyPhase()` 的 `'IDLE'`(定义 = 「没有赛局容器」)与这里给出的
 * `'IDLE'` 是**同一个可读值** ⇒ 房间侧那条既有收束路径(D-23 影响 §1:
 * 世界回 `IDLE` + 账本仍 `RUNNING` ⇒ `endParty`)对**自然超时**也真的成立。
 *
 * ## 两条边界(刻意的)
 *
 * ```text
 * 1 结算那一帧仍报 `SETTLED`,**不**提前回 IDLE:
 *   · `settleBridgeRun` 的安慰分只在 `SETTLED` 折算 ⇒ 相位必须先到位再结算;
 *   · 「结算帧可见」被既有冻结判据钉着(WS-FND-120 FND120-5 / WS-FND-142
 *     FND142-11 / WS-11 H1·H3 都在结算帧读 `SETTLED`);
 *   · 那一帧房间的账**还没关**(账本仍 `RUNNING`)⇒ 结算前一刻的分照样算得进去。
 * 2 回 `IDLE` **不**清任何东西:
 *   · `m.settlement` 留在运行时上(名次 / 终端文案 / 回执仍可读 —— 与
 *     `clearPartyRun` 的「清空容器」是两件事);
 *   · `phaseSwitches` 不加:那一格记的是 BUILD→RACE→SETTLED 这类**模式节拍**,
 *     回 IDLE 不是节拍切换(WS-11 H1 钉着切换次数)。
 * ```
 *
 * ## 五个 `settle*` 走的是**同一条**相位轨 ⇒ 一处修好,五处受益
 *
 * `settleBridgeRun` / `settleJellyBall` / `settleCrown` / `settlePaintWar` /
 * `settleRace` 都只经 `tickPartyMode` 推相位(超时那一条,或 `tickCrown` 提前宣胜后
 * 「已 SETTLED 但还没结算」那一条)⇒ 不存在「某个模式要单独再修一次」。
 * ⚠️ `settleJellyBall` / `settleCrown` / `settlePaintWar` / `settleRace` 自己**不查**
 * 幂等(每次调用都重算一遍并覆盖 `m.settlement`);它们共同的护栏是
 * `settlePartyRun` 的「`m.settlement` 非空 ⇒ 原样返回」。本函数只把相位送回 `IDLE`,
 * **不会**触发任何结算:第二次进 `SETTLED` 支时 `m.settlement` 已非空 ⇒ 直接回 `IDLE`。
 *
 * @param m  本局的模式运行时(唯一被改的字段是 `phase`)
 * @param ev 本慢帧的事件列表(原地 push `PHASE:IDLE`,与 `PHASE:SETTLED` 同一词表)
 * @returns `ev`(同引用;`tickPartyMode` 直接把它交出去)
 */
function autoIdleAfterSettle(m: PartyModeRuntime, ev: string[]): string[] {
  m.phase = PARTY_PHASE.IDLE;
  ev.push('PHASE:IDLE');
  return ev;
}