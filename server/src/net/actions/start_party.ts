/**
 * `START_PARTY` —— **开一局派对赛**(开局 → 计分 → 结算的状态机)。
 *
 * ⚠️ 别与 `SET_PARTY_MODE` 搞混,两者的分工是本模块的第一条纪律:
 * ```
 *   SET_PARTY_MODE  = **设模式**(选哪种玩法;写 rt.partyMode / state.meta / db)
 *   START_PARTY     = **开局**  (把当前已选的模式开成一局,开始计分)
 * ```
 * ⇒ 本动作**不设模式、不写 `rt.partyMode`、不写 `state.meta.partyMode`**;
 *   它只读「房间已选的模式」(`SET_PARTY_MODE` 写下的那一格),没选就拒绝。
 *   两者共用同一个权限位 `party`(`ACTION_PERMISSION.START_PARTY`),
 *   故本动作的闸不发明新规则,只按真实权限矩阵裁决(GUEST / MEMBER 的 `party` 为 false)。
 *
 * ## 为什么赛局状态放在**本模块**的 per-room Map
 *
 * 与 `sleep.ts` 同一处置:`ActionContext` 只有一次分派的入参与宿主能力,**没有**
 * 可写的世界侧状态;而「这一局是谁开的、谁几分、结算了没有」既不是 `RoomRuntime`
 * 的房间状态,也不是 `vitals` / 背包的字段。放进模块内的
 * `Map<roomId, PartyRecord>` 有三个直接好处:
 *   1 `roomId` 分桶 ⇒ 两个房间的 `userId` 不会互相串分(判据 4「只影响该局」);
 *   2 显式查询函数(`partyStateOf` / `addScore` / `endParty`)可被未来的世界侧、
 *     裁判哨台或慢帧调用,不需要把 `RoomRuntime` / `WorldSim` 交进动作层;
 *   3 状态机(未开局 / RUNNING / SETTLED)有**一个**写者,不会两处各推进一格。
 *
 * ## ⚠️ 分数**不写**进玩家血量与背包
 *
 * 血量(`vitals`,权威在 `WorldSim`)与背包(`applyInventory`,权威在反作弊的
 * 总量守恒 + 凭证链)都是**别处的权威**。本模块只维护赛局记录:
 * ```
 *   分数 → 只进 PartyRecord.scores
 *   名次 → 只在 endParty 的回执里
 * ```
 * 若哪天要「赢家拿奖励」,那条路必须走 `ctx.grantItemSource` + `ctx.applyInventory`
 * (见 `material.ts` / `craft.ts`),**不许**在这里直写任何一处。
 *
 * ## 状态机与「不许叠开第二局」
 *
 * ```
 *   (无记录) --START_PARTY--> RUNNING --endParty--> SETTLED
 *                  ↑                                  │
 *                  └──────── START_PARTY ─────────────┘(结算过的记录被**替换** ⇒ 分数从零)
 * ```
 * ⇒ 只有 `RUNNING` 会挡住第二次开局(`INVALID` + 可读理由);`SETTLED` 的记录
 *   保留是为了让结算结果仍可被读到,新的开局会把它整体换掉(旧分数不跨局)。
 *
 * ## 时钟
 *
 * 默认 `Date.now()`,但**可注入**(`setPartyClock`,手法同 `sleep.ts` 的
 * `setSleepClock`):判据要能推进时间而不真等,注入点是模块级的 ——
 * `ActionContext` 没有 `clock`。
 *
 * ## 模式的**唯一**来源
 *
 * 房间已选模式只读 `ctx.state.meta.partyMode`(`SET_PARTY_MODE` 写的那个**下标**),
 * 再按 `Object.values(PartyMode)` 还原 —— 与 `room.ts` 的
 * `Object.values(PartyMode).indexOf(mode)` 是**同一个映射**(下标词表在
 * `shared/types/wire.ts:159` 也逐字记着"0=NONE 1=BRIDGE_CTF 2=JELLY_BALL
 * 3=CROWN_BR 4=PAINT_WAR")。本文件**不另写**一张模式表。
 *
 * 报文里若也带了 `partyMode`,只当**回声**核对:与房间已选模式不一致 ⇒ 显式拒绝
 * (不静默忽略 —— 静默忽略会让客户端以为「我改成了这个模式」)。
 */
import { PartyMode } from '../../db/repo.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════════ 1. 赛局记录 ═══════════════════════════ */

/**
 * 赛局相位。语义只有两个真状态,故用 `as const` 对象(本仓禁 `enum`)。
 *
 * `SETTLED` 的记录**保留**(结算名次仍可读),但不再接受计分,也不算「在局中」。
 */
export const PartyPhase = {
  /** 进行中:接受 `addScore`,`START_PARTY` 会被拒。 */
  RUNNING: 'RUNNING',
  /** 已结算:名次已定格,`addScore` 被拒,再开局会替换本记录。 */
  SETTLED: 'SETTLED',
} as const;
export type PartyPhase = (typeof PartyPhase)[keyof typeof PartyPhase];

/**
 * 模式下标 → 模式的词表,**唯一**出处(`db/repo.ts` 的 `PartyMode` 值顺序)。
 *
 * 下标 `0` = `NONE`(未选模式),故「已选模式」的最小合法下标是 `1`。
 */
const PARTY_MODE_VALUES: readonly PartyMode[] = Object.values(PartyMode);

/** 一局的**唯一**事实来源(模块私有;外部只经下面的导出函数读写)。 */
interface PartyRecord {
  /** 本局采用的模式(开局时定格,局中不可改)。 */
  readonly mode: PartyMode;
  /** 开局时刻(ms,走本模块的可注入时钟)。 */
  readonly startedAtMs: number;
  /** 结算时刻(ms);未结算为 `null`。 */
  endedAtMs: number | null;
  /** 相位。**不叫** `phase`:`state` 是本任务约定的字段名(与 `RoomState` 无关)。 */
  state: PartyPhase;
  /** 开局时在场的玩家(名次的**兜底成员**:零分也进榜,顺序确定)。 */
  readonly participants: readonly string[];
  /** 分数。只有本模块写它;`userId → 累计分`。 */
  readonly scores: Map<string, number>;
}

/** `partyStateOf` 的快照(拷贝;外部改它不会改到赛局)。 */
export interface PartySnapshot {
  mode: PartyMode;
  state: PartyPhase;
  startedAtMs: number;
  endedAtMs: number | null;
  participants: readonly string[];
  scores: ReadonlyMap<string, number>;
}

/** 名次表中的一条。 */
export interface PartyStanding {
  userId: string;
  score: number;
  /** 名次,从 1 起,同分按下面的确定顺序**逐位排开**(不并列)。 */
  rank: number;
}

/** `endParty` 的结算结果。 */
export interface PartySettlement {
  mode: PartyMode;
  startedAtMs: number;
  endedAtMs: number;
  /** 按分数**降序**;同分按 `userId` 码元序(见 `rankingOf`)。 */
  ranking: readonly PartyStanding[];
}

/** `addScore` 的结果:成功时给出累加后的总分,失败时给出可读理由。 */
export interface ScoreResult {
  ok: boolean;
  /** 累加后的总分;仅成功时存在。 */
  total?: number;
  /** 为什么没记上;仅失败时存在。 */
  reason?: string;
}

/**
 * 房间 → 赛局记录。按 `roomId` 分桶(两个房间的 `userId` 可以重名)。
 * 本模块是**唯一写者**;失败路径一律不写(见各处理器与导出函数的注释)。
 */
const PARTIES = new Map<string, PartyRecord>();

/* ═══════════════════════════ 2. 时钟与注册表 ═══════════════════════════ */

/** 可注入时钟(毫秒)。默认墙钟;测试注入假时钟并推进它。 */
let clockMs: () => number = () => Date.now();

/** 注入时钟。**唯一**的时间来源:开局与结算都走它,不各自读 `Date.now`。 */
export function setPartyClock(clock: () => number): void {
  clockMs = clock;
}

/** 恢复默认时钟(测试收尾;生产不需要)。 */
export function resetPartyClock(): void {
  clockMs = () => Date.now();
}

/** 清空全部赛局(测试隔离用;生产不需要)。 */
export function clearPartyRegistry(): void {
  PARTIES.clear();
}

/* ═══════════════════════════ 3. 对外读/写入口(给将来接线用)═══════════════════════════ */

/**
 * 查询某房间当前(或最近一局)的赛局快照。
 *
 * `null` = 这个房间**从没开过局**。返回的是**拷贝**:调用方拿到的 Map / 数组
 * 与赛局记录不共享引用,改它不会改到分数(否则「外部随手改分」就成了第二个写者)。
 */
export function partyStateOf(roomId: string): PartySnapshot | null {
  const rec = PARTIES.get(roomId);
  if (rec === undefined) return null;
  return {
    mode: rec.mode,
    state: rec.state,
    startedAtMs: rec.startedAtMs,
    endedAtMs: rec.endedAtMs,
    participants: [...rec.participants],
    scores: new Map(rec.scores),
  };
}

/**
 * 给某玩家记分(**累加**)。只作用于**该房间当前这一局**。
 *
 * 拒绝的三种情形(都**不写**任何状态,这是判据 4 的另一半):
 *   1 该房间没有赛局(还没 `START_PARTY`);
 *   2 赛局已 `SETTLED`(结算后不再计分 —— 否则名次会退化成「谁最后报分谁赢」);
 *   3 增量不是有限数(`NaN` / `Infinity` 会毒化整张榜与排序)。
 *
 * ⚠️ 本函数**不碰**血量与背包(见文件头)。也**不**校验 `userId` 是否在房间里:
 *   参赛者的资格由调用方(世界侧 / 裁判哨台)决定,本模块只管记录。
 */
export function addScore(roomId: string, userId: string, n: number): ScoreResult {
  const rec = PARTIES.get(roomId);
  if (rec === undefined) {
    return { ok: false, reason: `房间 ${roomId} 没有进行中的派对赛局(计分必须在 START_PARTY 之后)` };
  }
  if (rec.state !== PartyPhase.RUNNING) {
    return { ok: false, reason: `赛局已结算(state=${rec.state})⇒ 不再计分` };
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    return { ok: false, reason: 'userId 必须是非空字符串' };
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return { ok: false, reason: `分数增量必须是有限数(实测 ${String(n)})` };
  }
  const total = (rec.scores.get(userId) ?? 0) + n;
  if (!Number.isFinite(total)) {
    return { ok: false, reason: `累加后溢出(${String(total)})⇒ 分数必须是有限数` };
  }
  rec.scores.set(userId, total);
  return { ok: true, total };
}

/**
 * **结算**当前这一局:定格名次、把相位推到 `SETTLED`,返回名次表。
 *
 * 返回 `null` = 没有可结算的局(没开过局,或已经结算过)。这个 `null` 是**显式**的:
 * 「结算了」与「本来就没什么可结算」在外部必须可区分(本仓陷阱 89 的形态)。
 */
export function endParty(roomId: string, nowMs: number = clockMs()): PartySettlement | null {
  const rec = PARTIES.get(roomId);
  if (rec === undefined || rec.state !== PartyPhase.RUNNING) return null;
  rec.state = PartyPhase.SETTLED;
  rec.endedAtMs = nowMs;
  return {
    mode: rec.mode,
    startedAtMs: rec.startedAtMs,
    endedAtMs: nowMs,
    ranking: rankingOf(rec),
  };
}

/**
 * 名次表:分数**降序**;同分按 `userId` 的 **UTF-16 码元序**(`a < b`),同分不同名(1..n)。
 *
 * 为什么不用 `localeCompare` 或「Map 插入序」:
 *   · `localeCompare` 的结果随进程 locale 变 ⇒ 同一局在不同机器上名次不同;
 *   · 插入序取决于「谁先报了分」⇒ 名次会随事件到达顺序漂移。
 * 码元序与两者都无关,故是**确定**的(判据 5)。
 *
 * 榜上成员 = 开局时在场的玩家 ∪ 有分数记录的人:
 *   前者让零分玩家也出现在名次里(否则「没得分」与「没参赛」不可区分);
 *   后者兜住「局中才进来并得分」的人(不能把分数丢掉)。
 */
function rankingOf(rec: PartyRecord): PartyStanding[] {
  const ids = new Set<string>(rec.participants);
  for (const id of rec.scores.keys()) ids.add(id);
  const rows = [...ids].map((userId) => ({ userId, score: rec.scores.get(userId) ?? 0 }));
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return rows.map((r, i) => ({ userId: r.userId, score: r.score, rank: i + 1 }));
}

/* ═══════════════════════════ 4. 处理器 ═══════════════════════════ */

/** 模式解析结果:成功给模式;失败给**可读理由**(调用方据此回 `INVALID`)。 */
interface ModeResolution {
  mode: PartyMode | null;
  reason?: string;
}

/**
 * 解析「本局用哪种模式」。
 *
 * ① 房间**没选**模式(`meta.partyMode` 是 `0` = `NONE`,或不是任何合法下标)
 *    ⇒ 拒绝。判据 3 的「未选模式」正是这一支。
 * ② 报文里带了 `partyMode` 且与房间已选模式**不一致** ⇒ 拒绝(含"不是任何合法模式"
 *    的取值)。这一支是刻意的:静默忽略会让客户端以为模式被改了,而本动作**不改**模式。
 */
function resolveMode(ctx: ActionContext): ModeResolution {
  /* `meta.partyMode` 是 `SET_PARTY_MODE` 写下的**下标**(见文件头)。 */
  const idx = ctx.state.meta.partyMode;
  const legal = Number.isInteger(idx) && idx > 0 && idx < PARTY_MODE_VALUES.length;
  if (!legal) {
    return {
      mode: null,
      reason: `尚未选定派对模式(房间当前 meta.partyMode=${String(idx)} 不是任何合法模式)`
        + ' ⇒ 先用 SET_PARTY_MODE 选一个,再开局',
    };
  }
  const mode = PARTY_MODE_VALUES[idx];
  /* 报文里的模式只当**回声**核对(该键由 SET_PARTY_MODE 定义,本动作不写它)。 */
  const declared: unknown = ctx.payload.partyMode;
  if (declared !== undefined && String(declared) !== String(mode)) {
    return {
      mode: null,
      reason: `报文 partyMode=${String(declared)} 与房间已选模式 ${mode} 不一致`
        + '(本动作是**开局**,不改模式)',
    };
  }
  return { mode };
}

/**
 * `START_PARTY`:把房间已选的派对模式**开成一局**,并返回开局回执。
 *
 * 判序(逐条对着判据):
 *   1 `authorize` 不通过 ⇒ `PERMISSION`(判据 6)。闸在**任何**副作用之前:
 *     被拒时 `partyStateOf(roomId)` 仍是 `null`;
 *   2 已有一局 `RUNNING` ⇒ `INVALID` + 可读理由,**不覆盖**原局(判据 2);
 *   3 没选模式 / 报文模式与房间不一致 ⇒ `INVALID`(判据 3);
 *   4 通过 ⇒ 建记录(`SETTLED` 的旧记录在此被替换 ⇒ 分数从零)并回
 *     `OK` + `effect`(模式 / 开始时刻 / 参局人数,判据 1 与 5)。
 */
export const startParty: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  const roomId = ctx.state.roomId;

  /* ② 不许叠开第二局:原局**一个字段都不动**(判据 2 的后半)。 */
  const cur = PARTIES.get(roomId);
  if (cur !== undefined && cur.state === PartyPhase.RUNNING) {
    return {
      ok: false, kind: 'INVALID',
      reason: `本房间已有一局派对赛进行中(模式 ${cur.mode},开始于 ${cur.startedAtMs} ms,`
        + `参局 ${cur.participants.length} 人)⇒ 不许叠开第二局;要开新局先 endParty 结算`,
    };
  }

  /* ③ 模式必须是房间**已选**的(本动作不设模式)。 */
  const res = resolveMode(ctx);
  if (res.mode === null) {
    return { ok: false, kind: 'INVALID', reason: res.reason ?? '未选模式' };
  }

  /* ④ 开局:**唯一**的写点。参赛名单取房间当前的玩家投影(开局那一刻定格)。 */
  const participants = ctx.state.players.map((p) => p.id);
  const record: PartyRecord = {
    mode: res.mode,
    startedAtMs: clockMs(),
    endedAtMs: null,
    state: PartyPhase.RUNNING,
    participants,
    scores: new Map(),
  };
  PARTIES.set(roomId, record);

  /* ★ 5 WS-FND-122:**把本局模式交给世界侧的 436 哨台**(`params.mode`)。
   *
   * ## 修前是什么样
   * 四模式九闸全部依赖 `ARENA_REFEREE_DESK.params.mode`,而**全仓没有任何写点**:
   * `net` 层写 `params` 的地方 **0 处**,世界电路图在生产里也恒空 ⇒
   * `stepRefereeDesk` 的 `desks.length === 0` 永远成立 ⇒ 开局入口**结构上不可达**,
   * 而且不报错(没有任何断言会红)。
   *
   * ## 为什么是这一处(而不是新造一条 SET_COMPONENT_PARAM 报文)
   * `START_PARTY` 已经把「本局用哪个模式」定下来了,而 436 的 `params.mode`
   * **就是同一套下标**(1=BRIDGE_CTF … 4=PAINT_WAR,见 `deskModeKey`)⇒
   * 直接把那个数交过去,不另立第二张模式表、也不新增协议动词。
   *
   * ⚠️ **世界侧写失败不推翻开局**:赛局记录是房间层的账(计分/结算),
   *    哨台是竞技场层的物理入口。两者失败必须**分别可见** ⇒
   *    `deskApplied` / `deskReason` 进回执,而不是让整个 `START_PARTY` 变成
   *    一个「看起来成功但其实没开局」的 OK。
   */
  const deskMode = PARTY_MODE_VALUES.indexOf(res.mode);
  const desk = ctx.host !== null && typeof ctx.host.setRefereeDeskMode === 'function'
    ? ctx.host.setRefereeDeskMode(deskMode)
    : { applied: false, reason: 'NO_WORLD_DESK_WRITER', deskId: null as string | null, mode: deskMode };

  return {
    ok: true,
    kind: 'OK',
    effect: {
      mode: String(record.mode),
      startedAtMs: record.startedAtMs,
      participants: participants.length,
      state: PartyPhase.RUNNING,
      /* ★ 436 哨台的写入结果(与上面那条 note 分开:一个说「记了账」,一个说「世界收到命令」)。 */
      deskApplied: desk.applied,
      deskMode: desk.mode,
      deskReason: desk.reason,
      note: '本动作只维护赛局记录:分数不动血量与背包;deskMode 交给世界侧 436 哨台',
    },
  };
};
