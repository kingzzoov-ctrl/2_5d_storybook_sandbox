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
 *
 * ★ 本文件末尾还有一节「事件 → 分」的**纯函数**(`scoreOfPartyEvent` /
 *   `tallyPartyScores`):把世界侧赛局里发生的动作换算成「该给谁加多少分」。
 *   那一节的块注释里写着**今天谁调它**(世界侧的 `party_event` 链)与
 *   **分数的真值源链**(事件 → 本函数 → `start_party.ts` 的 `scores` → `TeamScore`)。
 */

import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
import type { Rng } from '../coop/rush_order.ts';
/*
 * 32 颜料色号数的**唯一声明**在冻结层 `shared/constants/dye.ts#DYE_PALETTE_SIZE`
 * (32 色染色枪 / 505 染缸 / 像素画架共用);本文件 import 后只**转发**同名绑定。
 * ⚠️ 下面「事件 → 分」一节里的 `文件.ts:NNN` 判据锚于第九轮按**当时**的文件现状重钉过
 *    (`modes.ts` / `world_sim.ts` 都会继续长行;`world_sim.ts` 尤其快,漂了就按**符号名**搜,
 *    别只改数字 —— 判据 `tests/WS-FND-136` FND136-11 会逐条核对「那一行真的是那个符号」)。
 */
import { DYE_PALETTE_SIZE } from '../../../shared/constants/dye.ts';
export { DYE_PALETTE_SIZE };

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

/*
 * 32 色染料色号(505 炼金调色染缸):**转发**冻结层 `shared/constants/dye.ts` 的那一份。
 * 本文件不再写第二份 `= 32`(改版前这里就是第二个 32 —— 加一种颜色时,
 * 服务端记分槽数会与调色盘静默分叉)。
 */
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

/* ═══════════════════════ 事件 → 分:世界侧唯一计分规则(纯函数) ═══════════════════════ */

/**
 * ## 这一节谁在调、分数的真值源在哪
 *
 * **今天的调用者(世界侧;那行接线由主线落)**:`server/src/sim/world_sim.ts` 的赛局推进
 * —— 它每慢帧已经把 WS-11 的事件送上总线
 * —— 那行的形状是 `this.bus.emit('party_event', { kind: ev })`(在 `world_sim.ts` 的
 * 慢帧循环里)。⚠️ 这里**只钉符号名、不钉行号**:`world_sim.ts` 已上万行且每轮都在长,
 * 行号会在几分钟内过期,而符号名不会(判据 `tests/WS-FND-136` FND136-11 两样都核对)。
 * 赛局里**动作类**的事件(击杀生物 / 采集拾取 / 触碰目标件)由世界侧按下面的
 * `PARTY_SCORE_EVENT` 词表发出,走本节换算成「该给谁加多少分」,再把 `award.points`
 * 交给 `server/src/net/actions/start_party.ts:199` 的 `addScore(roomId, playerId, points)`
 * 落账。**本节不调 `addScore`、不读 `PARTIES` 注册表、不写任何状态**:接线是主线的事。
 *
 * **分数的真值源链(自上而下,唯一的一条)**:
 * ```
 *   (1) 事实     世界侧事件(`events/bus.ts` 的 `GameEvent`)        ← 唯一输入
 *   (2) 规则     本节的 `scoreOfPartyEvent` / `tallyPartyScores`    ← 计分规则的唯一实现
 *   (3) 存储     `start_party.ts:102` 的 `PartyRecord.scores`(`addScore` 是唯一写口)
 *   (4) 团队分表 本文件上面的 `TeamScore`(由 `party/modes.ts` 的四个 settle 函数写)
 * ```
 * (2) 与 (4) 是同一套口径的两个投影:`metric` 的四个值**就是** (4) 的字段名
 * (`score` / `goals` / `crownSec` / `tiles`),故本函数给出的分不需要第二张换算表就能落板。
 * 刻意这样对齐:多一张"分 → 板"的换算表,就多一处调参会漂移的地方。
 *
 * **纯(判据 4)**:不读全局(模式词表直接来自冻结层 `PARTY_MODES`,是常量不是状态)、
 * 不看时钟(带时间的事件把秒数放进 `payload`,本函数只搬不算)、不写任何状态、不改入参。
 *
 * ## 数值的锚(判据 1/2:没有一个字面量是拍脑袋来的)
 *
 * 每个模式有一个**最小一档分**(`PARTY_MODE_UNIT_POINTS`)—— 它不是新发明的数,而是该模式
 * **既有实现里已经当作"分"用的那个量**:
 *
 * | 模式 | 最小一档分 | 出处(逐条可查) |
 * | :--- | :--- | :--- |
 * | BRIDGE_CTF | 2 | `modes.ts:258` `BRIDGE_SCORE_PER_TILE = 2`「每一步建造/冲刺折算的团队分」;`settleBridgeRun` 用它算安慰分(`modes.ts:329`),`docs/WS-11-coop-prank-party.md:453`「未夺旗队 + 2 × built(安慰分)」 |
 * | JELLY_BALL | 1 | `modes.ts:479` `ts.score += 1`(进球),`docs/WS-11-coop-prank-party.md:463`「进球 → 对手队 goals++、score++」 |
 * | CROWN_BR | 1 | `modes.ts:597` `ts.crownSec += dt`,且 `settleCrown` 直接以 `crownSec` 为团队 `value`(`modes.ts:614`)⇒ 1 秒持冠 = 1 分 |
 * | PAINT_WAR | 1 | `modes.ts:695` `getTeam(...).tiles = tiles`,且 `settlePaintWar` 以 `tiles` 为 `value`(`modes.ts:706`)⇒ 1 格色块 = 1 分 |
 *
 * 「到达/触碰目标点」按**各模式主目标件**计价(`PARTY_REACH_TARGET_POINTS`):
 * 造桥夺旗 = 100(`modes.ts:257` `BRIDGE_SCORE_PER_FLAG = 100`,手册 §6.3 夺旗分;
 * `docs/WS-11-coop-prank-party.md:453`「夺旗队 +100」)、果冻球 = 1(进球)、涂色 = 1 分/格、
 * 抢皇冠 = **0**(那一模式的分在 `tickCrown` 的持冠秒上累积,拾冠本身不加分,`modes.ts:595-598`)。
 *
 * ## 只有一条"折算"规则,且它写在明面上
 *
 * 手册 §6.3 的四个模式**都没有**给「击杀生物」与「采集/拾取」定价(逐条核过 `modes.ts`
 * 的四个 `settle*` 函数与 `docs/WS-11-coop-prank-party.md` 的 §4.10 四个小节(造桥夺旗/果冻球/
 * 抢皇冠/圈地涂色))。唯一不拍脑袋的
 * 写法是**折合成该模式的最小一档分**(`PARTY_FOREIGN_EVENT_UNITS = 1`):那一档分**就是**
 * 该模式里"一次可玩动作"的计价粒度(1 块桥板 / 1 进球 / 1 秒持冠 / 1 格色块)。
 * 取 **1** 而不是更大的倍数,因为它是**下界**:击杀/采集不会盖过该模式自己的主目标
 * (100 分夺旗 / 进球 / 持冠秒 / 色块)。
 */

/** 计分事件的最小形状:是 `events/bus.ts` 的 `GameEvent` 的**子集**(可直接传整条 `GameEvent`)。 */
export interface PartyScoreEvent {
  /** 事件种类,词表见 `PARTY_SCORE_EVENT`;表外的一律按「未登记事件」处理(0 分)。 */
  kind: string;
  /** 事件负载(原样来自 `GameEvent.payload`);本节只读 `team` 一个键,其余键一概不信(防负载注入分数)。 */
  payload?: Readonly<Record<string, number | string | boolean>>;
  /** 完成动作的玩家 id(原样来自 `GameEvent.source`)。 */
  source?: string;
}

/**
 * 世界侧派给本节的**三种**事件词表(命名与既有 mob 事件同为 `snake_case`,
 * 见 `mobs/behaviors.ts` 的 `world.emit('boar_wall_stun')` 一族)。
 */
export const PARTY_SCORE_EVENT = {
  /** 击杀生物:玩家把生物打到 `alive = false`(`world_sim.ts` 的 `after.alive = false` 分支;同上,不钉行号)。 */
  CREATURE_KILL: 'party_creature_kill',
  /** 采集 / 拾取:玩家把地上的物品收进背包。 */
  GATHER: 'party_gather',
  /** 到达 / 触碰目标点:踩到本模式的**目标件**(435 对岸旗 / 410 球门框 / 434 皇冠底座)。 */
  REACH_TARGET: 'party_reach_target',
} as const;
export type PartyScoreEventKind = (typeof PARTY_SCORE_EVENT)[keyof typeof PARTY_SCORE_EVENT];

/** 加分的落点:这四个值**就是** `TeamScore` 的字段名(同一个词表,不另立)。 */
export const PARTY_SCORE_METRIC = {
  SCORE: 'score',
  GOALS: 'goals',
  CROWN_SEC: 'crownSec',
  TILES: 'tiles',
} as const;
export type PartyScoreMetric = (typeof PARTY_SCORE_METRIC)[keyof typeof PARTY_SCORE_METRIC];

/** 一次事件 → 一次加分的**完整回执**(纯值,与入参不共享引用)。 */
export interface PartyScoreAward {
  /** 这次事件是否**按规则计价**(false = 未登记的事件类型 / 模式非法 ⇒ 一律 0 分)。 */
  accepted: boolean;
  /** 事件里的模式(原样回显,便于世界侧核对"这分是哪个模式给的")。 */
  mode: string;
  /** 事件种类(原样回显)。 */
  kind: string;
  /** 本次事件的分数增量:**有限、整数、非负**(判据 6)。 */
  points: number;
  /** 加到计分板的哪一栏。 */
  metric: PartyScoreMetric;
  /** 得分归属玩家(`event.source`;没带 / 空串 ⇒ `null`)。 */
  playerId: string | null;
  /** 得分归属队伍(团队赛用;见 `teamFromPayload`;`null` = 由调用方按玩家归属折算)。 */
  team: TeamKey | null;
  /** 可读口径:数值 + 它的锚(可直接拼进播报文案)。 */
  reason: string;
}

/** 各模式的**最小一档分**(出处见本节块注释的表;键集必须与冻结层 `PARTY_MODES` 一致)。 */
export const PARTY_MODE_UNIT_POINTS: Readonly<Record<string, number>> = {
  BRIDGE_CTF: 2,
  JELLY_BALL: 1,
  CROWN_BR: 1,
  PAINT_WAR: 1,
};

/** 非主目标事件(击杀生物 / 采集拾取)折合几个标准单位。理由见块注释最后一段。 */
export const PARTY_FOREIGN_EVENT_UNITS = 1;

/** 各模式**主目标件**的分(出处见本节块注释)。 */
export const PARTY_REACH_TARGET_POINTS: Readonly<Record<string, number>> = {
  BRIDGE_CTF: 100,
  JELLY_BALL: 1,
  CROWN_BR: 0,
  PAINT_WAR: 1,
};

/** 同上,落点(果冻球算 `goals`、涂色算 `tiles`,与既有 settle 函数读的字段一致)。 */
export const PARTY_REACH_TARGET_METRIC: Readonly<Record<string, PartyScoreMetric>> = {
  BRIDGE_CTF: PARTY_SCORE_METRIC.SCORE,
  JELLY_BALL: PARTY_SCORE_METRIC.GOALS,
  CROWN_BR: PARTY_SCORE_METRIC.CROWN_SEC,
  PAINT_WAR: PARTY_SCORE_METRIC.TILES,
};

/** 最小一档分的锚(写进 `reason`;调这个数时,这条注释必须一起改)。 */
const MODE_UNIT_ANCHOR: Readonly<Record<string, string>> = {
  BRIDGE_CTF: 'modes.ts:258 BRIDGE_SCORE_PER_TILE=2(一块桥板的基础分)',
  JELLY_BALL: 'modes.ts:479 进球 `ts.score += 1`(手册 §6.3「4v4 果冻球」)',
  CROWN_BR: 'modes.ts:597 `crownSec += dt` + modes.ts:614 以 crownSec 为 value ⇒ 1 秒 = 1 分',
  PAINT_WAR: 'modes.ts:695 `tiles = tiles` + modes.ts:706 以 tiles 为 value ⇒ 1 格 = 1 分',
};

/** 主目标件的锚(同上)。 */
const REACH_ANCHOR: Readonly<Record<string, string>> = {
  BRIDGE_CTF: 'modes.ts:257 BRIDGE_SCORE_PER_FLAG=100(手册 §6.3 夺旗分)',
  JELLY_BALL: 'modes.ts:479 进球 `ts.score += 1`(手册 §6.3 进球计分)',
  CROWN_BR: 'modes.ts:595-598 分在 `tickCrown` 的持冠秒上累积 ⇒ 拾冠(434)本身 0 分',
  PAINT_WAR: 'modes.ts:695 与 706 色块数即分数 ⇒ 1 格 1 分',
};

/**
 * 模式词表就是冻结层 `PARTY_MODES`(`shared/constants/bosses.ts:247`)。
 * **不另写第二张**:`start_party.ts:87` 与 `party/modes.ts` 都从同一处取词表。
 */
function isLegalPartyMode(mode: unknown): mode is string {
  return typeof mode === 'string' && PARTY_MODES.some((m) => m.key === mode);
}

/** 负载里的 `team` 若不是四色之一(或没带)⇒ `null`(由调用方按玩家归属折算)。 */
function teamFromPayload(payload: PartyScoreEvent['payload']): TeamKey | null {
  if (payload === undefined) return null;
  const t = payload.team;
  if (typeof t !== 'string') return null;
  return (TEAM_ORDER as readonly string[]).includes(t) ? (t as TeamKey) : null;
}

/**
 * **把一个赛局事件换算成「该给谁加多少分」**(纯函数:同一输入两次结果逐位相同、
 * 不改入参、不看时钟、不读状态)。
 *
 * 判序(每条对着一条判据):
 *   1 模式不是冻结层 `PARTY_MODES` 的 key(`NONE` / 空串 / 大小写不对 / 没传)⇒ **显式拒绝**:
 *     `accepted=false` + `points=0` + 可读 `reason`(判据 7)。这里**选"返回 0"而不是"抛错"**:
 *     世界侧在慢帧循环里逐个事件调它,抛错会把一整帧打死,而"模式没选"是配置问题,
 *     不该升级成崩溃。
 *   2 `REACH_TARGET` ⇒ 该模式主目标件的分(判据 1/2)。
 *   3 `CREATURE_KILL` / `GATHER` ⇒ 该模式最小一档分 × `PARTY_FOREIGN_EVENT_UNITS`。
 *   4 其它任何 kind ⇒ **不给分**:`accepted=false` + `points=0`(判据 3,**不抛错、不默认给 1**)。
 *
 * 分数的上界是 100(夺旗)、下界是 0,都是整数 ⇒ 判据 6 恒成立;负载里的数字
 * **不参与计分**(`payload.points` 之类一律无视),故无法用事件刷分。
 */
export function scoreOfPartyEvent(mode: string, event: PartyScoreEvent): PartyScoreAward {
  const kind = typeof event?.kind === 'string' ? event.kind : '';
  const playerId = typeof event?.source === 'string' && event.source.length > 0 ? event.source : null;
  const team = teamFromPayload(event?.payload);

  if (!isLegalPartyMode(mode)) {
    return {
      accepted: false,
      mode: typeof mode === 'string' ? mode : '',
      kind,
      points: 0,
      metric: PARTY_SCORE_METRIC.SCORE,
      playerId,
      team,
      reason: `模式未定义或非法(${String(mode)})⇒ 拒绝计分:模式必须是冻结层 PARTY_MODES 的 key`,
    };
  }

  if (kind === PARTY_SCORE_EVENT.REACH_TARGET) {
    const points = PARTY_REACH_TARGET_POINTS[mode] ?? 0;
    return {
      accepted: true,
      mode,
      kind,
      points,
      metric: PARTY_REACH_TARGET_METRIC[mode] ?? PARTY_SCORE_METRIC.SCORE,
      playerId,
      team,
      reason: `触碰本模式目标件:+${points} 分(锚:${REACH_ANCHOR[mode] ?? '—'})`,
    };
  }

  if (kind === PARTY_SCORE_EVENT.CREATURE_KILL || kind === PARTY_SCORE_EVENT.GATHER) {
    const points = (PARTY_MODE_UNIT_POINTS[mode] ?? 0) * PARTY_FOREIGN_EVENT_UNITS;
    const what = kind === PARTY_SCORE_EVENT.CREATURE_KILL ? '击杀生物' : '采集/拾取';
    return {
      accepted: true,
      mode,
      kind,
      points,
      metric: PARTY_SCORE_METRIC.SCORE,
      playerId,
      team,
      reason: `${what}:折合 ${PARTY_FOREIGN_EVENT_UNITS} 个标准单位 = +${points} 分(锚:${MODE_UNIT_ANCHOR[mode] ?? '—'})`,
    };
  }

  return {
    accepted: false,
    mode,
    kind,
    points: 0,
    metric: PARTY_SCORE_METRIC.SCORE,
    playerId,
    team,
    reason: `未登记的事件类型 ${kind === '' ? '(空)' : kind} ⇒ 0 分(词表见 PARTY_SCORE_EVENT)`,
  };
}

/** 一批事件的累计结果:一个玩家一行。 */
export interface PartyScoreTally {
  playerId: string;
  /** 本批事件给该玩家的总分(**仅** `accepted` 的事件;有限非负整数)。 */
  points: number;
  /** 按落点拆开:四个键**恒在**(固定的键序,未出现的为 0),便于直接比对序列化结果。 */
  byMetric: Readonly<Record<PartyScoreMetric, number>>;
  /** 计价过的事件数(含 0 分的合法事件,如抢皇冠时的拾冠)。 */
  acceptedEvents: number;
  /** 归属该玩家但**未计价**的事件数(未登记类型 / 模式非法)。 */
  rejectedEvents: number;
}

/** 累计器的内部形态(`byMetric` 可变;对外暴露的 `PartyScoreTally` 是只读视图)。 */
interface TallyAcc {
  points: number;
  byMetric: Record<PartyScoreMetric, number>;
  acceptedEvents: number;
  rejectedEvents: number;
}

/**
 * **一批事件 → 每个玩家加多少分**(世界侧一慢帧收一撮事件后调它,再逐行 `addScore`)。
 *
 * 顺序无关(判据 5):累加走 `Map`,**行序按 `playerId` 的 UTF-16 码元序**,
 * `byMetric` 的键序固定在对象字面量里 ⇒ 打乱输入顺序后 `JSON.stringify` 逐字节相同。
 * 码元序这个约定与 `start_party.ts:256-259` 的 `rankingOf` 同一处理由:
 * `localeCompare` 随 locale 变、`Map` 插入序随事件到达顺序变,两者都会让名次漂移。
 *
 * 没有 `source` 的事件(归属不到人)被**丢弃**:`addScore` 要的正是 `userId`。
 * 调用方按 `row.points > 0` 决定是否落账(`acceptedEvents` 可能 > 0 而 `points` 为 0)。
 */
export function tallyPartyScores(mode: string, events: readonly PartyScoreEvent[]): PartyScoreTally[] {
  const acc = new Map<string, TallyAcc>();
  for (const e of events) {
    const award = scoreOfPartyEvent(mode, e);
    if (award.playerId === null) continue;
    let row = acc.get(award.playerId);
    if (row === undefined) {
      row = { points: 0, byMetric: { score: 0, goals: 0, crownSec: 0, tiles: 0 }, acceptedEvents: 0, rejectedEvents: 0 };
      acc.set(award.playerId, row);
    }
    if (!award.accepted) {
      row.rejectedEvents += 1;
      continue;
    }
    row.points += award.points;
    row.byMetric[award.metric] += award.points;
    row.acceptedEvents += 1;
  }
  return [...acc.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([playerId, r]) => ({
      playerId,
      points: r.points,
      byMetric: r.byMetric,
      acceptedEvents: r.acceptedEvents,
      rejectedEvents: r.rejectedEvents,
    }));
}

/**
 * 自检:三张分表必须与冻结层 `PARTY_MODES` **逐键一致**。
 * 少一个键就抛错,而不是"兜底给 0":那会让该模式的事件**静默落 0 分** ——
 * "看起来能用但一点不干活"比抛错难查得多。
 */
function assertScoringTablesCoverFreezeLayer(): void {
  const frozen = PARTY_MODES.map((m) => m.key).sort();
  const tables: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
    ['PARTY_MODE_UNIT_POINTS', PARTY_MODE_UNIT_POINTS],
    ['PARTY_REACH_TARGET_POINTS', PARTY_REACH_TARGET_POINTS],
    ['PARTY_REACH_TARGET_METRIC', PARTY_REACH_TARGET_METRIC],
  ];
  for (const [name, table] of tables) {
    const here = Object.keys(table).sort();
    if (here.join(',') !== frozen.join(',')) {
      throw new Error(`${name} 的模式键与冻结层 PARTY_MODES 不一致:${here.join(',')} vs ${frozen.join(',')}`);
    }
  }
}

assertScoringTablesCoverFreezeLayer();
