/**
 * WS-11 · 派对竞技计分与播报内核(设计手册 §6.3)
 *
 * 职责:为四大竞技模式提供统一的
 *  1. 队伍/个人比分表(红蓝黄绿四队,对应 435 四色队伍出生复活旗);
 *  2. 全房播报队列(对应 410 计分球门框「全房播报比分」/ 412 领奖台「播报前三名耗时」);
 *  3. 毫秒级赛跑计时(对应 411 跑酷起点发令门 / 412 跑酷终点领奖台);
 *  4. 涂色色块网格计数(对应 237 颜料水球 / 505 染缸 32 色);
 *  5. 结算排名与奖励发放。
 *
 * 零运行时依赖;不使用 Date.now / performance.now,一切时间由外部注入。
 * 本文件不 import 测试桩,自带与 `harness.mulberry32` 位级一致的随机源。
 */

import type { Rng } from '../coop/rush_order.ts';

/**
 * Mulberry32。与 `shared/testing/harness.ts` 的 `mulberry32` 逐位一致,
 * 保证「实现侧同一个 seed」与「测试侧 mulberry32(seed)」产生完全相同的序列。
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TEAM_KEY = {
  RED: 'RED',
  BLUE: 'BLUE',
  YELLOW: 'YELLOW',
  GREEN: 'GREEN',
} as const;
export type TeamKey = (typeof TEAM_KEY)[keyof typeof TEAM_KEY];

export const TEAM_ORDER: readonly TeamKey[] = ['RED', 'BLUE', 'YELLOW', 'GREEN'];

export const TEAM_LABEL: Readonly<Record<TeamKey, string>> = {
  RED: '红队',
  BLUE: '蓝队',
  YELLOW: '黄队',
  GREEN: '绿队',
};

/** 435 复活旗:每队一个出生点。 */
export const SPAWN_FLAG_ITEM_ID = 435;
export const SCORE_GOAL_ITEM_ID = 410;
export const RACE_START_GATE_ITEM_ID = 411;
export const RACE_FINISH_PODIUM_ITEM_ID = 412;
export const REFEREE_STAND_ITEM_ID = 436;
export const GOLD_WHISTLE_ITEM_ID = 255;
export const BALL_SPAWNER_ITEM_ID = 433;
export const CROWN_BASE_ITEM_ID = 434;
export const PAINT_BALL_ITEM_ID = 237;
export const DYE_VAT_ITEM_ID = 505;

export interface TeamScore {
  team: TeamKey;
  score: number;
  /** 进球数(果冻球模式) */
  goals: number;
  /** 持冠秒数(抢皇冠模式) */
  crownSec: number;
  /** 占领色块数(涂色模式) */
  tiles: number;
}

export function createScoreboard(): Map<TeamKey, TeamScore> {
  const m = new Map<TeamKey, TeamScore>();
  for (const t of TEAM_ORDER) m.set(t, { team: t, score: 0, goals: 0, crownSec: 0, tiles: 0 });
  return m;
}

export function getTeam(board: Map<TeamKey, TeamScore>, team: TeamKey): TeamScore {
  const s = board.get(team);
  if (!s) throw new Error(`未知队伍 ${team}`);
  return s;
}

/* ═══════════════════════ 播报队列 ═══════════════════════ */

export const BROADCAST_KIND = {
  SCORE: 'SCORE',
  GOAL: 'GOAL',
  CROWN: 'CROWN',
  RACE_TOP3: 'RACE_TOP3',
  PAINT: 'PAINT',
  MODE_START: 'MODE_START',
  MODE_END: 'MODE_END',
  PHASE: 'PHASE',
} as const;
export type BroadcastKind = (typeof BROADCAST_KIND)[keyof typeof BROADCAST_KIND];

export interface Broadcast {
  kind: BroadcastKind;
  atSec: number;
  text: string;
  /** 播报优先级:数字越小越紧急 */
  priority: number;
}

export interface Broadcaster {
  queue: Broadcast[];
  /** 当前正在展示的播报 */
  current: Broadcast | null;
  /** 已播报条数 */
  emitted: number;
}

export function createBroadcaster(): Broadcaster {
  return { queue: [], current: null, emitted: 0 };
}

const PRIORITY: Readonly<Record<BroadcastKind, number>> = {
  MODE_END: 0,
  GOAL: 1,
  CROWN: 2,
  RACE_TOP3: 3,
  PHASE: 4,
  MODE_START: 5,
  SCORE: 6,
  PAINT: 7,
};

export function pushBroadcast(b: Broadcaster, kind: BroadcastKind, text: string, atSec: number): Broadcast {
  const item: Broadcast = { kind, atSec, text, priority: PRIORITY[kind] };
  b.queue.push(item);
  b.emitted += 1;
  return item;
}

/** 取出一条播报(按优先级 + 先到先服务);队列空返回 null。 */
export function shiftBroadcast(b: Broadcaster): Broadcast | null {
  if (b.queue.length === 0) {
    b.current = null;
    return null;
  }
  let best = 0;
  for (let i = 1; i < b.queue.length; i += 1) {
    const a = b.queue[i];
    const c = b.queue[best];
    if (a.priority < c.priority || (a.priority === c.priority && a.atSec < c.atSec)) best = i;
  }
  const item = b.queue.splice(best, 1)[0];
  b.current = item;
  return item;
}

export function drainBroadcasts(b: Broadcaster, limit = 99): Broadcast[] {
  const out: Broadcast[] = [];
  while (out.length < limit) {
    const n = shiftBroadcast(b);
    if (!n) break;
    out.push(n);
  }
  return out;
}

/** 比分播报文案(410 球门框触发)。 */
export function scoreLine(board: Map<TeamKey, TeamScore>): string {
  return TEAM_ORDER
    .map((t) => `${TEAM_LABEL[t]} ${getTeam(board, t).goals}`)
    .join('  ·  ');
}

/* ═══════════════════════ 毫秒计时 ═══════════════════════ */

export interface RaceTimer {
  playerId: string;
  /** 出发时间(毫秒精度,来自注入时钟) */
  startMs: number | null;
  /** 冲线时间(毫秒) */
  finishMs: number | null;
  /** 最终成绩(毫秒) */
  elapsedMs: number | null;
}

export function createRaceTimer(playerId: string): RaceTimer {
  return { playerId, startMs: null, finishMs: null, elapsedMs: null };
}

/** 秒 -> 毫秒,并取整到整毫秒(412 领奖台播报粒度)。 */
export function toMs(sec: number): number {
  return Math.round(sec * 1000);
}

export function gateStart(t: RaceTimer, atSec: number): void {
  if (t.startMs !== null) return;
  t.startMs = toMs(atSec);
}

export function podiumFinish(t: RaceTimer, atSec: number): boolean {
  if (t.startMs === null || t.finishMs !== null) return false;
  t.finishMs = toMs(atSec);
  t.elapsedMs = t.finishMs - t.startMs;
  return true;
}

export interface RaceResult {
  rank: number;
  playerId: string;
  elapsedMs: number;
  dnf: boolean;
}

/**
 * 排名:完赛者按毫秒升序;未完赛(DNF)排在末尾。
 * 同毫秒成绩按 playerId 字典序稳定排序,保证可复现。
 */
export function rankRace(timers: readonly RaceTimer[]): RaceResult[] {
  const sorted = [...timers].sort((a, b) => {
    const ad = a.elapsedMs === null;
    const bd = b.elapsedMs === null;
    if (ad !== bd) return ad ? 1 : -1;
    if (!ad && !bd) {
      const diff = (a.elapsedMs as number) - (b.elapsedMs as number);
      if (diff !== 0) return diff;
    }
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
  });
  return sorted.map((t, i) => ({
    rank: i + 1,
    playerId: t.playerId,
    elapsedMs: t.elapsedMs ?? Number.POSITIVE_INFINITY,
    dnf: t.elapsedMs === null,
  }));
}

/** 格式化毫秒成绩:`12.345s`。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return 'DNF';
  return `${(ms / 1000).toFixed(3)}s`;
}

/**
 * 「越大越好」型排名(持冠秒数、色块数、比分):降序;同值按 TEAM/ID 字典序稳定。
 * 与 `rankRace`(越小越好)配对使用。
 */
export function rankByDescending(
  rows: readonly { id: string; value: number }[],
): { rank: number; id: string; value: number }[] {
  const sorted = [...rows].sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.map((r, i) => ({ rank: i + 1, id: r.id, value: r.value }));
}

/** 领奖台播报:前三名耗时(412)。 */
export function podiumBroadcast(results: readonly RaceResult[]): string {
  const top = results.slice(0, 3);
  if (top.length === 0) return '本轮无人完赛';
  const seg = top.map((r) => `${r.rank}. ${r.playerId} ${formatMs(r.elapsedMs)}`).join('   ');
  return `前三名:${seg}`;
}

/* ═══════════════════════ 涂色网格 ═══════════════════════ */

export interface PaintGrid {
  w: number;
  h: number;
  /** 每格归属队伍;null 表示未涂色 */
  cells: (TeamKey | null)[];
}

export function createPaintGrid(w: number, h: number): PaintGrid {
  return { w, h, cells: new Array<TeamKey | null>(w * h).fill(null) };
}

export function idx(g: PaintGrid, x: number, y: number): number {
  return y * g.w + x;
}

export function paint(g: PaintGrid, x: number, y: number, team: TeamKey): boolean {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return false;
  const i = idx(g, x, y);
  if (g.cells[i] === team) return false;
  g.cells[i] = team;
  return true;
}

/** 以 (cx,cy) 为中心刷一块 radius 的方形色块。 */
export function paintRadius(g: PaintGrid, cx: number, cy: number, radius: number, team: TeamKey): number {
  let n = 0;
  const r = Math.max(0, Math.round(radius));
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (paint(g, cx + dx, cy + dy, team)) n += 1;
    }
  }
  return n;
}

export function tileCount(g: PaintGrid, team: TeamKey): number {
  let n = 0;
  for (const c of g.cells) if (c === team) n += 1;
  return n;
}

/** 未涂色格数。 */
export function neutralCount(g: PaintGrid): number {
  let n = 0;
  for (const c of g.cells) if (c === null) n += 1;
  return n;
}

export interface PaintStanding {
  rank: number;
  team: TeamKey;
  tiles: number;
  ratio: number;
}

/** 涂色排名:按色块数降序,同数按 TEAM_ORDER 稳定。 */
export function rankPaint(g: PaintGrid): PaintStanding[] {
  const total = g.w * g.h;
  const rows = TEAM_ORDER.map((team) => ({ team, tiles: tileCount(g, team) }));
  rows.sort((a, b) => (b.tiles - a.tiles) || (TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team)));
  return rows.map((r, i) => ({ rank: i + 1, team: r.team, tiles: r.tiles, ratio: total === 0 ? 0 : r.tiles / total }));
}

/* ═══════════════════════ 彩色喷枪的确定性取色 ═══════════════════════ */

/** 32 色染料色号(505 炼金调色染缸)。 */
export const DYE_PALETTE_SIZE = 32;
/** 与 TEAM_ORDER 一一对应的队伍色号。 */
export const TEAM_DYE_INDEX: Readonly<Record<TeamKey, number>> = {
  RED: 0, BLUE: 1, YELLOW: 2, GREEN: 3,
};

/** 由注入 rng 取一个色号 ∈ [0,31],同一 seed 完全可复现。 */
export function pickDyeIndex(rng: Rng): number {
  return Math.floor(rng() * DYE_PALETTE_SIZE) % DYE_PALETTE_SIZE;
}

/** 便捷构造:用 seed 直接造一个 rng(与测试里的 mulberry32(seed) 同序列)。 */
export function seededRng(seed: number): Rng {
  return makeRng(seed);
}

/* ═══════════════════════ 结算与奖励 ═══════════════════════ */

export interface RewardLine {
  rank: number;
  team: TeamKey | null;
  playerId: string | null;
  /** 物品 ID -> 数量 */
  rewards: Record<number, number>;
  /** 经验奖励 */
  exp: number;
}

export const REWARD_EXP_BY_RANK: readonly number[] = [600, 400, 250, 150];
export const REWARD_ITEM_BY_RANK: readonly Record<number, number>[] = [
  { 130: 3 },
  { 130: 2 },
  { 130: 1 },
  {},
];

export function rewardForRank(rank: number): RewardLine {
  const i = Math.max(0, Math.min(REWARD_EXP_BY_RANK.length - 1, rank - 1));
  return {
    rank,
    team: null,
    playerId: null,
    rewards: { ...REWARD_ITEM_BY_RANK[i] },
    exp: REWARD_EXP_BY_RANK[i],
  };
}

/** 团队结算:冠军队伍拿 #1 奖励,其余按名次递减。 */
export function rewardsForTeams(standing: readonly PaintStanding[]): RewardLine[] {
  return standing.map((s) => ({ ...rewardForRank(s.rank), team: s.team }));
}

/** 个人结算:按玩家排名发奖。 */
export function rewardsForPlayers(results: readonly RaceResult[]): RewardLine[] {
  return results.map((r) => ({ ...rewardForRank(r.rank), playerId: r.playerId }));
}

/** 全房播报模式开始/结束文案。 */
export function modeStartLine(modeName: string, refereeId: string): string {
  return `【${modeName}】开始!裁判 ${refereeId} 吹响金哨。`;
}

export function modeEndLine(modeName: string, winnerLine: string): string {
  return `【${modeName}】结束 — ${winnerLine}`;
}

export function crownLine(board: Map<TeamKey, TeamScore>): string {
  return TEAM_ORDER.map((t) => `${TEAM_LABEL[t]} ${getTeam(board, t).crownSec.toFixed(1)}s`).join('  ');
}

export function paintStandingLine(s: readonly PaintStanding[]): string {
  return s.map((r) => `${r.rank}. ${TEAM_LABEL[r.team]} ${r.tiles} 格(${(r.ratio * 100).toFixed(1)}%)`).join('  ');
}
