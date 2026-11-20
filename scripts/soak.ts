/**
 * ★ **真长跑夹具**(WS-FND-169)。
 *
 * ```
 * node scripts/soak.ts --minutes 60 --clients 8 --log <path>
 * node scripts/soak.ts --minutes 1  --clients 8          # 短跑也能出数据(见下)
 * node scripts/soak.ts --minutes 1  --clients 0          # 负对照:无负载
 * ```
 *
 * ## 为什么要有这个文件(它不是「又一个基准脚本」)
 *
 * 前十三轮的「长跑」全部是**虚拟时钟快进**:把 640 帧在一个 for 循环里跑完,
 * 时钟是注入的 `nowMs()`,定时器一次都不触发。那种跑法能证明**逻辑**对不对,
 * 但它证明不了下面这四件事 —— 而它们只在**真墙钟 + 真 I/O + 真 GC** 下才成立:
 *
 * ```text
 * 1 真定时器抖动      20Hz 的 setInterval 在真实负载下的**实际 tick 间隔**(本文件采样)
 * 2 真文件 I/O        自动存档真的写进 SQLite 文件(库文件字节 / 行数增长)
 * 3 真 GC / 真内存    RSS 与 heapUsed 在 60 分钟里是**回落**还是**单调涨**
 * 4 真协议            假客户端走**真 WebSocket**(二进制帧 / tag 分流 / ack)
 * ```
 *
 * ## 装配路径:复用 `scripts/play.ts` 的那一条
 *
 * ```text
 * assemble({ sizeCells, mobs, dbPath })  →  RoomRuntime + WorldSim(生产装配)
 * startWsServer({ room, frameMs })       →  20Hz 广播循环(room.step 在那儿被调)
 * 假客户端:全局 WebSocket(Node 24 内置,零依赖)连 ?userId=&token=
 * ```
 *
 * 刻意**不**另写装配:本仓反复记的形态是「测试手动装、生产没装」。这里与
 * `play.ts` 走同一个 `assemble()` / `startWsServer()`,所以夹具里跑的就是玩家能跑到的那条路。
 *
 * ## 夹具自身要有牙(这是本文件下半部分的全部内容)
 *
 * ```text
 * 1 客户端**真发动作**(move / action / attack 三条上行),不是只连上挂着;
 *   ⇒ `load.movesApplied` / `load.actionsApplied` / `load.worldWrites` 会涨
 * 2 采样**结构化**一行一条(`[soak] {json}`),可被 `parseSampleLine` 读回、逐字段断言
 * 3 采样**追加**到日志(不覆盖):`--minutes 1` 也留下可对账的样本序列
 * 4 `--clients 0` 必须报告 `NO_LOAD`,**不许**假装有负载(负对照组)
 * ```
 *
 * ## 采样读什么(规范要求的那一组)
 *
 * ```text
 * 进程      rssBytes / heapUsedBytes / heapTotalBytes / externalBytes
 * 库        db.mainBytes / db.walBytes / db.totalBytes(+ 每张表的行数)
 * 表        room_events / users / room_players / room_chunks(其余表一并记在 tables)
 * 台账      joinAudits / removalConflicts / removeLog / saveErrors /
 *           playerSnapshotErrors / throttledActions / acViolations / ledgerPrunes
 * 自动存档  count / failCount / lastReason / lastError / inFlight / backoffFrames
 * 帧率      tick.worldTick / observed / meanMs / minMs / maxMs / fps(实际间隔,非标称)
 * 负载      clients / connected / movesApplied / actionsApplied / actionOk /
 *           attacksApplied / worldWrites / sends / framesReceived
 * ```
 *
 * ⚠️ 读数**只读**:本文件不触发存档、不改房间状态。唯一「动」的东西是
 *    `captureProbes()` 给 `step` / `applyMove` / `dispatchAction` / `applyAttack` /
 *    物质层五方法套的一层**计数壳**(只记次数与回执,不改参数、不改返回值)。
 */

import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { assemble } from '../server/src/index.ts';
import { startWsServer, type WsServerHandle } from '../server/src/net/ws_server.ts';
import { TABLE_PRIMARY_KEYS, createUser, getUser, type DbLike } from '../server/src/db/repo.ts';
import type { RoomRuntime } from '../server/src/net/room.ts';
import { PROTOCOL_VERSION } from '../shared/net/delta.ts';

/* ═══════════════════════════ 1. 选项与参数 ═══════════════════════════ */

/** 长跑参数。**小数分钟合法**(测试用 1/30 = 2 秒),但必须 > 0。 */
export type SoakOptions = {
  /** 跑多久(分钟)。 */
  minutes: number;
  /** 并发假客户端数;`0` = 负对照(应当报告 NO_LOAD)。 */
  clients: number;
  /** 采样间隔(ms)。 */
  sampleEveryMs: number;
  /** 服务端帧间隔(ms)。20Hz ⇒ 50。 */
  frameMs: number;
  /** 每客户端每秒**动作**条数(0 = 不发动作)。 */
  actionHz: number;
  /** 每客户端每秒**移动意图**条数(0 = 不移动)。 */
  moveHz: number;
  /** 世界边长(格)。96 与 `play.ts` 的默认同值。 */
  sizeCells: number;
  /** 预热帧数(与 `play.ts` 同一条刷怪路径:世界里先有生物,攻击才有目标)。 */
  warmupFrames: number;
  /** 文件库路径。 */
  dbPath: string;
  /** 采样日志路径(追加写)。 */
  logPath: string;
  /** 房间 id。 */
  roomId: string;
  /** 开跑前删掉旧库 / 旧日志(默认 false = 复用库、日志追加)。 */
  fresh: boolean;
  /** 不往 stdout 打样本行(测试用)。 */
  quiet: boolean;
  /** 每条样本的回调(测试用)。 */
  onSample: ((s: SoakSample) => void) | null;
};

/** 夹具的**默认值**(量纲都写在这里,不散在代码里)。 */
export const DEFAULT_SOAK_OPTIONS: SoakOptions = {
  minutes: 60,
  clients: 8,
  sampleEveryMs: 5_000,
  frameMs: 50,
  actionHz: 1,
  moveHz: 5,
  sizeCells: 96,
  warmupFrames: 400,
  dbPath: '.data/soak.db',
  logPath: '',
  roomId: 'soak',
  fresh: false,
  quiet: false,
  onSample: null,
};

/** 用法(打印在 `--help` / 参数错时)。 */
export function usage(): string {
  return [
    'node scripts/soak.ts [选项]',
    '  --minutes <N>        跑多久(分钟;小数合法)  默认 60',
    '  --clients <N>        并发假客户端数(0 = 负对照)  默认 8',
    '  --sample-every <S>   采样间隔(秒)  默认 5',
    '  --frame-ms <MS>      服务端帧间隔(ms)  默认 50(20Hz)',
    '  --action-hz <N>      每客户端每秒动作条数  默认 1',
    '  --move-hz <N>        每客户端每秒移动意图条数  默认 5',
    '  --size <N>           世界边长(格)  默认 96',
    '  --warmup <N>         预热帧数  默认 400',
    '  --db <PATH>          文件库路径  默认 .data/soak.db',
    '  --log <PATH>         采样日志(追加)  默认 .data/soak-<minutes>m.log',
    '  --room-id <ID>       房间 id  默认 soak',
    '  --fresh              开跑前删掉旧库与旧日志',
    '  --quiet              不往 stdout 打样本行',
  ].join('\n');
}

/** 取一个数值开关;缺席 ⇒ `undefined`(与「给了 0」区分开)。 */
function numFlag(argv: readonly string[], name: string): number | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined) throw new Error(`--${name} 需要一个数值`);
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name} 的值不是有限数:${raw}`);
  return v;
}

/** 取一个字符串开关;缺席 ⇒ `undefined`。 */
function strFlag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined) throw new Error(`--${name} 需要一个值`);
  return raw;
}

/**
 * 解析命令行。**任何非法值都抛**(不静默退回默认值):
 * 一次「我明明给了 --minutes 60 却跑了 5 秒」是排障最贵的那种静默。
 */
export function parseSoakArgs(argv: readonly string[]): SoakOptions {
  const minutes = numFlag(argv, 'minutes') ?? DEFAULT_SOAK_OPTIONS.minutes;
  const clients = numFlag(argv, 'clients') ?? DEFAULT_SOAK_OPTIONS.clients;
  const sampleSeconds = numFlag(argv, 'sample-every');
  const sampleEveryMs = sampleSeconds === undefined
    ? DEFAULT_SOAK_OPTIONS.sampleEveryMs : sampleSeconds * 1_000;
  const frameMs = numFlag(argv, 'frame-ms') ?? DEFAULT_SOAK_OPTIONS.frameMs;
  const actionHz = numFlag(argv, 'action-hz') ?? DEFAULT_SOAK_OPTIONS.actionHz;
  const moveHz = numFlag(argv, 'move-hz') ?? DEFAULT_SOAK_OPTIONS.moveHz;
  const sizeCells = numFlag(argv, 'size') ?? DEFAULT_SOAK_OPTIONS.sizeCells;
  const warmupFrames = numFlag(argv, 'warmup') ?? DEFAULT_SOAK_OPTIONS.warmupFrames;
  const dbPath = strFlag(argv, 'db') ?? DEFAULT_SOAK_OPTIONS.dbPath;
  const roomId = strFlag(argv, 'room-id') ?? DEFAULT_SOAK_OPTIONS.roomId;
  const logFlag = strFlag(argv, 'log');
  const logPath = logFlag !== undefined && logFlag !== ''
    ? logFlag : defaultLogPath(minutes);

  if (!(minutes > 0)) throw new Error(`--minutes 必须 > 0(实际 ${minutes})`);
  if (!Number.isInteger(clients) || clients < 0) {
    throw new Error(`--clients 必须是非负整数(实际 ${clients})`);
  }
  if (!(sampleEveryMs > 0)) throw new Error(`--sample-every 必须 > 0(实际 ${sampleEveryMs}ms)`);
  if (!(frameMs >= 1)) throw new Error(`--frame-ms 必须 ≥ 1(实际 ${frameMs})`);
  if (!(actionHz >= 0)) throw new Error(`--action-hz 必须 ≥ 0(实际 ${actionHz})`);
  if (!(moveHz >= 0)) throw new Error(`--move-hz 必须 ≥ 0(实际 ${moveHz})`);
  if (!Number.isInteger(sizeCells) || sizeCells < 32) {
    throw new Error(`--size 必须是 ≥ 32 的整数(实际 ${sizeCells})`);
  }
  if (!Number.isInteger(warmupFrames) || warmupFrames < 0) {
    throw new Error(`--warmup 必须是非负整数(实际 ${warmupFrames})`);
  }
  if (dbPath === '') throw new Error('--db 不能为空(本夹具只跑文件库版本)');

  return {
    minutes,
    clients,
    sampleEveryMs,
    frameMs,
    actionHz,
    moveHz,
    sizeCells,
    warmupFrames,
    dbPath,
    logPath,
    roomId,
    fresh: argv.includes('--fresh'),
    quiet: argv.includes('--quiet'),
    onSample: null,
  };
}

/** 默认日志名:`soak-<minutes>m.log`(与 `--minutes` 同版,便于对账)。 */
export function defaultLogPath(minutes: number): string {
  const tag = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace('.', '_');
  return `.data/soak-${tag}m.log`;
}

/* ═══════════════════════════ 2. 采样行(结构化,可断言)═══════════════════════════ */

/** 采样行的**唯一**前缀。断言/读取都认它,不认「行里有没有某个字」。 */
export const SAMPLE_PREFIX = '[soak]';

/** 样本阶段:`run` = 跑动中;`final` = 关房/最后一次存档之后(末值)。 */
export type SoakPhase = 'run' | 'final';

/** 负载侧读数(N = 假客户端 + 服务端**真的**应用了多少)。 */
export type SoakLoad = {
  clients: number;
  connected: number;
  framesReceived: number;
  movesApplied: number;
  movesWorldRejected: number;
  actionsApplied: number;
  actionOk: number;
  attacksApplied: number;
  worldWrites: number;
  /** Σ|Δx| + |Δy|(假客户端相对各自出生点的位移)——「世界真的被挪了」。 */
  displacement: number;
  sends: { move: number; action: number; attack: number };
};

/** **一条采样**。字段名是契约:测试与日志读取方按它断言,不许随手改名。 */
export type SoakSample = {
  seq: number;
  phase: SoakPhase;
  /** 自开跑以来的墙钟 ms。 */
  atMs: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  db: { mainBytes: number; walBytes: number; totalBytes: number };
  tables: Record<string, number>;
  events: number;
  users: number;
  roomPlayers: number;
  roomChunks: number;
  ledgers: {
    joinAudits: number;
    removalConflicts: number;
    removeLog: number;
    saveErrors: number;
    playerSnapshotErrors: number;
    throttledActions: number;
    acViolations: number;
    ledgerPrunes: number;
  };
  autosave: {
    count: number;
    failCount: number;
    lastReason: string | null;
    lastError: string | null;
    inFlight: boolean;
    backoffFrames: number;
  };
  tick: {
    worldTick: number;
    observed: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    fps: number;
  };
  load: SoakLoad;
  /** `NO_LOAD` = 「本样本里没有任何动作到达」;负对照组必须落在这里。 */
  verdict: 'NO_LOAD' | 'LOAD';
};

/** 把一条样本拼成**一行**(日志与 stdout 的同一份内容)。 */
export function formatSampleLine(s: SoakSample): string {
  return `${SAMPLE_PREFIX} ${JSON.stringify(s)}`;
}

/** 读回一行样本逻辑。非本前缀 ⇒ 抛(不与其它输出混淆)。 */
export function parseSampleLine(line: string): SoakSample {
  const text = line.trimEnd();
  if (!text.startsWith(`${SAMPLE_PREFIX} `)) {
    throw new Error(`不是采样行(前缀 ${SAMPLE_PREFIX}):${text.slice(0, 60)}`);
  }
  return JSON.parse(text.slice(SAMPLE_PREFIX.length + 1)) as SoakSample;
}

/**
 * 会被跟踪的**序列**(单调性判据的对象)。凡是「只会涨」的东西都在这里;
 * 加上 RSS / heapUsed 这两个**本来就不该单调**的,才能证明判据有牙。
 */
export const SOAK_SERIES: readonly string[] = [
  'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes',
  'db.mainBytes', 'db.walBytes', 'db.totalBytes',
  'events', 'users', 'roomPlayers', 'roomChunks',
  'tables.rooms', 'tables.schema_migrations', 'tables.user_starting_inventory',
  'tables.room_systems_state', 'tables.room_world_state', 'tables.room_chunk_roofs',
  'ledgers.joinAudits', 'ledgers.removeLog', 'ledgers.saveErrors',
  'ledgers.playerSnapshotErrors', 'ledgers.throttledActions', 'ledgers.acViolations',
  'ledgers.removalConflicts', 'ledgers.ledgerPrunes',
  'autosave.count', 'autosave.failCount',
  'tick.worldTick', 'tick.observed',
  'load.movesApplied', 'load.movesWorldRejected', 'load.actionsApplied',
  'load.actionOk', 'load.attacksApplied', 'load.worldWrites', 'load.displacement',
  'load.sends.move', 'load.sends.action', 'load.sends.attack',
];

/** 按点路径取一个数;取不到/不是数 ⇒ `NaN`(由调用方判,不在这里编 0)。 */
export function seriesValue(s: SoakSample, key: string): number {
  let cur: unknown = s;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return Number.NaN;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' ? cur : Number.NaN;
}

/** 一条序列的读数(首/末/峰/谷 + 是否**单调不减**)。 */
export type SeriesReport = {
  key: string;
  steps: number;
  first: number;
  last: number;
  peak: number;
  low: number;
  delta: number;
  monotonic: boolean;
  grew: boolean;
};

/** 逐序列算出报告。非有限值的样本被跳过(而不是当 0 参与比较)。 */
export function seriesReports(samples: readonly SoakSample[]): SeriesReport[] {
  return SOAK_SERIES.map((key) => {
    const vals: number[] = [];
    for (const s of samples) {
      const v = seriesValue(s, key);
      if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) {
      return {
        key, steps: 0, first: Number.NaN, last: Number.NaN, peak: Number.NaN,
        low: Number.NaN, delta: Number.NaN, monotonic: false, grew: false,
      };
    }
    let monotonic = true;
    let peak = vals[0] as number;
    let low = vals[0] as number;
    for (let i = 1; i < vals.length; i += 1) {
      const v = vals[i] as number;
      const p = vals[i - 1] as number;
      if (v < p) monotonic = false;
      if (v > peak) peak = v;
      if (v < low) low = v;
    }
    const first = vals[0] as number;
    const last = vals[vals.length - 1] as number;
    return {
      key, steps: vals.length, first, last, peak, low, delta: last - first,
      monotonic, grew: last > first,
    };
  });
}

/** **单调增长的集合** = 全程不减 **且** 末值 > 首值。这是本轮的抓取目标。 */
export function monotonicGrowers(samples: readonly SoakSample[]): string[] {
  return seriesReports(samples).filter((r) => r.monotonic && r.grew).map((r) => r.key);
}

/** 中途**降过**的集合(GC / 事件裁剪 / 存档失败退避都会落在这里)。 */
export function decreasedSeries(samples: readonly SoakSample[]): string[] {
  return seriesReports(samples).filter((r) => r.steps >= 2 && !r.monotonic).map((r) => r.key);
}

/* ═══════════════════════════ 3. 库/进程读数 ═══════════════════════════ */

/** 文件字节数;不存在/读不到 ⇒ 0(WAL 侧文件可能真的不存在)。 */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 逐表行数(白名单来自 `TABLE_PRIMARY_KEYS` ⇒ 与写库侧同一份表名)。 */
export function tableCounts(db: DbLike): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of Object.keys(TABLE_PRIMARY_KEYS)) {
    try {
      out[table] = db.count(table);
    } catch {
      /* 旧库缺表 ⇒ 记 0,而不是让整个采样抛掉。 */
      out[table] = 0;
    }
  }
  return out;
}

/* ═══════════════════════════ 4. 探针(只计数,不改行为)═══════════════════════════ */

/** 统计型读数(服务端**真的**执行了多少)。 */
export type LoadCounters = {
  movesApplied: number;
  movesWorldRejected: number;
  actionsApplied: number;
  actionOk: number;
  actionKinds: Record<string, number>;
  attacksApplied: number;
  worldWrites: number;
  framesReceived: number;
};

/** 新建一份空计数。 */
export function emptyLoadCounters(): LoadCounters {
  return {
    movesApplied: 0,
    movesWorldRejected: 0,
    actionsApplied: 0,
    actionOk: 0,
    actionKinds: {},
    attacksApplied: 0,
    worldWrites: 0,
    framesReceived: 0,
  };
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * 给对象上的若干方法套一层**计数壳**:只观察(方法名 + 返回值),不改参数、
 * 不改返回值、不吞异常。
 *
 * ⚠️ 为什么套壳而不是改源码:本任务是**夹具**,不是修产品;源码里加计数器会
 * 让「读数存在」变成产品契约的一部分。这里的壳活在长跑进程里,进程退出即消失。
 */
export function wrapMethods(
  target: object,
  names: readonly string[],
  onCall: (name: string, args: readonly unknown[], result: unknown) => void,
): void {
  const t = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const base = t[name];
    if (typeof base !== 'function') continue;
    const bound = (base as AnyFn).bind(target);
    t[name] = (...args: unknown[]): unknown => {
      const result = bound(...args);
      onCall(name, args, result);
      return result;
    };
  }
}

/** 世界侧「真的改了世界」的方法(物质层五件 + 攻击结算)。 */
export const WORLD_WRITE_METHODS: readonly string[] = [
  'dropItem', 'takeGroundItemNear', 'consumeGroundItem', 'placeBlock', 'breakBlock',
];

/* ═══════════════════════════ 5. 假客户端(真 WebSocket)═══════════════════════════ */

/** 浏览器/Node 共有的最小 WebSocket 面(只声明本文件用到的部分)。 */
export type WsLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
};

/** 一个假客户端。 */
type FakeClient = {
  userId: string;
  index: number;
  socket: WsLike | null;
  connected: boolean;
  seq: number;
  /** 已发出的移动条数(只用来自证「客户端一直在发」)。 */
  walkStep: number;
  /** 走法方向(±1);撞墙时由 `intentOf` 翻转。 */
  walkDirX: number;
  walkDirY: number;
  /**
   * ★ 入场时记下的**出生坐标**(第一次拿到权威位置那一刻)。
   * 它是「客户端的动作真的改了世界吗」的基准:末态位移 = |Δx| + |Δy|。
   * 不记它的话,「移动生效」只能靠服务端计数自证 —— 而计数**可以是假的**
   * (调了方法不等于世界变了)。
   */
  spawn: { x: number; y: number } | null;
};

/**
 * 一帧移动的**步长**(每轴,格)。
 *
 * ## 为什么是 0.15 而不是 0.2(实测定的)
 * 假客户端每 100ms 发一条 `move`,斜向走时一步 = `√2 × 步长`。反作弊的窗口均速
 * 判据按**帧**折算(实测 2026-11-25:步长 0.2 ⇒ 读数 `窗口均速 5.66 格/秒 > 上限 5.63`,
 * `weight: 3`,`SPEED` 记录在 30 秒内把 512 格流水灌满)。
 * ⇒ 夹具的走法必须**留余量**,否则长跑里长出来的不是「负载」而是「作弊证据」:
 *   0.15 每轴 ⇒ 折算约 4.24 格/秒,离 5.63 有 25% 余量(判据:FND169-10 的
 *   `acViolations === 0`)。
 */
const WALK_STEP = 0.15;


/** 客户端上行节拍(ms)。10Hz:比服务端 20Hz 慢一档,避免自己把上行灌满。 */
const CLIENT_TICK_MS = 100;

/**
 * 造一条**移动意图**上行。
 *
 * ## 位置为什么取自**服务端权威位置**
 * 假客户端没有客户端那份预测器。若它自己编一个起点(比如世界中心),第一条
 * `move` 就是一个「瞬移」—— 反作弊会把它记成**违规**,于是长跑里长出来的
 * 是「作弊证据」而不是负载。⇒ 以 `playerState()` 的权威坐标为基准挪一小步:
 * 这是「客户端收到了自己的位置」的等价物,报文本身仍然是真协议报文。
 *
 * ## 走法:斜向走到墙角再折回(**不是原地绕圈**)
 * 原地绕一圈的假客户端在采样时刻可能正好回到出生点 ⇒ `displacement` 读成 0,
 * 于是「移动生效了没有」这条读数会**间歇性地说没有**。故意让它一直往一个方向
 * 走、撞到墙才反向:`Σ|Δ|` 除起步那一瞬之外恒为正。
 *
 * ## 边界为什么是 `[0.5, sizeCells − 0.5]`
 * 出生点就是 `(0.5, 0.5)` 这种半格值(见房间的 `spawnPoint()`);把下界抬到 1
 * 会把每一次带负方向的移动都夹回同一点 —— 实测那时 36 条 move 全部「应用成功」
 * 而坐标一格不动(看起来像「移动没接线」,实际是夹具自己夹住了)。
 */
function intentOf(
  rt: RoomRuntime, c: FakeClient, sizeCells: number,
): Record<string, unknown> | null {
  const pos = rt.playerState(c.userId);
  if (pos === undefined) return null;
  const lo = WALK_MIN_CELL;
  const hi = sizeCells - WALK_MIN_CELL;
  let dx = c.walkDirX * WALK_STEP;
  if (pos.x + dx > hi || pos.x + dx < lo) {
    c.walkDirX = -c.walkDirX;
    dx = c.walkDirX * WALK_STEP;
  }
  let dy = c.walkDirY * WALK_STEP;
  if (pos.y + dy > hi || pos.y + dy < lo) {
    c.walkDirY = -c.walkDirY;
    dy = c.walkDirY * WALK_STEP;
  }
  const x = Math.max(lo, Math.min(hi, pos.x + dx));
  const y = Math.max(lo, Math.min(hi, pos.y + dy));
  return { t: 'move', tick: rt.state.meta.tick, x, y, z: pos.z, seq: c.seq };
}

/**
 * 造一条**动作/攻击**上行(轮转)。返回值是完整的上行报文。
 *
 * 轮转表刻意覆盖三条不同的执行层:`material`(丢/拾/拆)、`sleep`、
 * `use_item`、以及战斗那条**独立**的 `attack` 通道 —— 长跑要压的是它们的总和,
 * 不是某一个。
 */
function actionIntentOf(
  rt: RoomRuntime, c: FakeClient, round: number,
): Record<string, unknown> | null {
  const pos = rt.playerState(c.userId);
  const inv = rt.authoritativeItemIds(c.userId);
  const itemId = inv.length > 0 ? (inv[0] as number) : null;
  const wildlife = rt.state.wildlife;
  switch (round % 7) {
    case 0:
      return itemId === null ? null
        : { t: 'action', action: 'DROP_ITEM', x: pos?.x ?? 0, y: pos?.y ?? 0, itemId, count: 1 };
    case 1:
      return itemId === null ? null
        : { t: 'action', action: 'PICKUP_ITEM', x: pos?.x ?? 0, y: pos?.y ?? 0, itemId };
    case 2:
      return { t: 'action', action: 'GATHER', x: pos?.x ?? 0, y: pos?.y ?? 0 };
    case 3:
      return { t: 'action', action: 'SLEEP' };
    case 4:
      return itemId === null ? null : { t: 'action', action: 'USE_ITEM', itemId };
    case 5:
      return { t: 'action', action: 'BREAK_BLOCK', x: pos?.x ?? 0, y: pos?.y ?? 0 };
    default: {
      const mob = wildlife.length > 0 ? (wildlife[0] as { mobId?: string }) : null;
      const mobId = mob?.mobId;
      return typeof mobId === 'string' ? { t: 'attack', mobId } : null;
    }
  }
}

/** 客户端集合(可停)。 */
export type FakeClients = {
  ids: readonly string[];
  sent: { move: number; action: number; attack: number };
  /** 已经完成握手(open)的连接数。 */
  connected(): number;
  /** 连接失败(构造抛 / socket error)的累计次数。 */
  connectFailures(): number;
  /** Σ|Δx| + |Δy|(相对各自的出生点)—— 「客户端的动作真的挪了世界」的读数。 */
  displacement(): number;
  stop(): void;
};

/* ═══════════════════════════ 6. 夹具 ═══════════════════════════ */

/** 一个装好的长跑夹具(测试可以直接用它造一条样本,不必真等 5 秒)。 */
export type SoakFixture = {
  options: SoakOptions;
  runtime: RoomRuntime;
  db: DbLike;
  srv: WsServerHandle | null;
  counters: LoadCounters;
  tickIntervals: number[];
  samples: SoakSample[];
  wsLogs: string[];
  wsLogLines: number;
  clients: FakeClients;
  startedAtMs: number;
  /** 采一条样本(并压入 `samples`)。 */
  sample(phase?: SoakPhase): SoakSample;
  /** 收尾:停客户端 → 关服务端 → 关房(最后一次存档)→ 末样本 → 关库。 */
  close(): Promise<SoakSample>;
};

/** 第 i 个假客户端的 userId(与 `--room-id` 同源 ⇒ 不同世界不会串号)。 */
export function soakClientIds(options: SoakOptions): string[] {
  const out: string[] = [];
  for (let i = 0; i < options.clients; i += 1) out.push(`${options.roomId}_c${i + 1}`);
  return out;
}

/**
 * ★ 把假客户端**预注册**进 `users` —— 这一条是被长跑**逼出来**的:
 *
 * ```text
 * 实测(文件库,2026-11-25):room.join() 自己不建号
 *   room.ts:2797   upsertRoomPlayer(db, ...)  → repo.ts:599 插 room_players
 *   schema.sql:133 FOREIGN KEY (user_id) REFERENCES users(id)
 *   driver.sqlite.ts:505  PRAGMA foreign_keys = ON
 *   ⇒ 库里没有 users 行 ⇒ FOREIGN KEY constraint failed ⇒ 整个入场回滚
 *     (回执 `JOIN_FAILED:加入失败(已回滚…)`);而 MemoryDb 不判外键
 *     ⇒ 100+ 套测试全绿,生产里没人进得来。
 * ```
 *
 * ⚠️ 本夹具**不修产品**(那是 `room.ts` 的活),它只把「玩家已经注册过」这个
 *    现实前提摆好 —— 真人的 `users` 行来自登录 / 注册那一步。
 */
export function ensureSoakUsers(db: DbLike, ids: readonly string[], nowMs: number): void {
  for (const id of ids) {
    if (getUser(db, id) === undefined) createUser(db, { id, displayName: id, nowMs });
  }
}

/** 房主 id(库里的 `users` 第一行;`assemble()` 会确保它存在)。 */
export const SOAK_OWNER_ID = 'u_soak_owner';

/** 世界边长上下界(与服务端的坐标口径一致,避免假客户端把世界走出界)。 */
/** 假客户端的坐标夹取窗口(格):出生点是半格值,见 `intentOf`。 */
export const WALK_MIN_CELL = 0.5;

/**
 * 装配一套真长跑夹具:**生产装配路径 + 真文件库 + 真 WS 服务端 + N 个假客户端**。
 */
export async function createSoakFixture(options: SoakOptions): Promise<SoakFixture> {
  if (options.fresh) {
    rmSync(options.dbPath, { force: true });
    rmSync(`${options.dbPath}-wal`, { force: true });
    rmSync(`${options.dbPath}-shm`, { force: true });
    rmSync(options.logPath, { force: true });
  }
  mkdirSync(dirname(options.dbPath) === '' ? '.' : dirname(options.dbPath), { recursive: true });
  mkdirSync(dirname(options.logPath) === '' ? '.' : dirname(options.logPath), { recursive: true });

  /* ── 6.1 生产装配(`play.ts` 的同一行)── */
  const assembled = assemble({
    roomId: options.roomId,
    ownerId: SOAK_OWNER_ID,
    sizeCells: options.sizeCells,
    mobs: true,
    dbPath: options.dbPath,
  });
  const runtime = assembled.runtime;
  const db = runtime.db;
  if (db === null) throw new Error(`期望文件库(${options.dbPath})但 db 仍是 null —— 落盘不会发生`);

  /* ── 6.2 预热(与 `play.ts` 同一条刷怪路径)── */
  for (let i = 0; i < options.warmupFrames; i += 1) runtime.step(null);

  /* ── 6.3 探针:step 间隔 + 三个执行入口 + 物质层 ── */
  const counters = emptyLoadCounters();
  const tickIntervals: number[] = [];
  let lastStepAt = 0;
  const room = runtime as unknown as Record<string, unknown>;
  const baseStep = (room['step'] as AnyFn).bind(runtime);
  let lastWorldTick = runtime.state.meta.tick;
  room['step'] = (...args: unknown[]): unknown => {
    const now = Date.now();
    if (lastStepAt !== 0) tickIntervals.push(now - lastStepAt);
    lastStepAt = now;
    const out = baseStep(...args);
    lastWorldTick = runtime.state.meta.tick;
    return out;
  };
  wrapMethods(runtime, ['applyMove'], (_n, _a, r) => {
    counters.movesApplied += 1;
    const verdict = r as { worldRejected?: boolean } | null;
    if (verdict !== null && verdict !== undefined && verdict.worldRejected === true) {
      counters.movesWorldRejected += 1;
    }
  });
  wrapMethods(runtime, ['dispatchAction'], (_n, _a, r) => {
    counters.actionsApplied += 1;
    const out = r as { kind?: string } | null;
    const kind = out?.kind ?? 'UNKNOWN';
    counters.actionKinds[kind] = (counters.actionKinds[kind] ?? 0) + 1;
    if (kind === 'OK') counters.actionOk += 1;
  });
  wrapMethods(runtime, ['applyAttack'], () => { counters.attacksApplied += 1; });
  const host = runtime.worldSaveHost;
  if (host !== null) {
    wrapMethods(host, WORLD_WRITE_METHODS, () => { counters.worldWrites += 1; });
  }
  void lastWorldTick;

  /* ── 6.4 真 WS 服务端(20Hz 广播循环)── */
  const wsLogs: string[] = [];
  const srv = await startWsServer({
    port: 0,
    room: runtime as never,
    frameMs: options.frameMs,
    /* 失败日志**不静默**:收进 `wsLogs`(只留最后 200 行),计数另记。 */
    onLog: (m: string) => {
      if (wsLogs.length < 200) wsLogs.push(m);
    },
  });

  const startedAtMs = Date.now();
  const samples: SoakSample[] = [];
  /* ★ 先**预注册**假客户端(理由见 `ensureSoakUsers`):这一步是长跑逼出来的真实前提。 */
  ensureSoakUsers(db, soakClientIds(options), Date.now());
  const clients = startFakeClients(runtime, srv, options, counters);

  const takeSample = (phase: SoakPhase = 'run'): SoakSample => {
    const s = buildSample({
      seq: samples.length + 1,
      phase,
      atMs: Date.now() - startedAtMs,
      db,
      dbPath: options.dbPath,
      runtime,
      counters,
      tickIntervals,
      clients,
    });
    samples.push(s);
    return s;
  };

  let closed = false;
  const close = async (): Promise<SoakSample> => {
    if (!closed) {
      closed = true;
      clients.stop();
      try {
        await srv.close();
      } catch { /* 已关 */ }
      /* `close()` 是「房间销毁」的语义:它含**最后一次存档**(与 `play.ts` 同款),
         所以末样本必须在它之后采 —— 否则报告里的存档次数会少一次。 */
      try {
        runtime.close();
      } catch { /* 关闭路径不因存档失败而中断(失败已记在 saveErrors) */ }
    }
    const finalSample = takeSample('final');
    const closeDb = (db as unknown as { close?: () => void }).close;
    if (typeof closeDb === 'function') {
      try { closeDb.call(db); } catch { /* 已关 */ }
    }
    return finalSample;
  };

  return {
    options,
    runtime,
    db,
    srv,
    counters,
    tickIntervals,
    samples,
    wsLogs,
    wsLogLines: wsLogs.length,
    clients,
    startedAtMs,
    sample: takeSample,
    close,
  };
}

/** 起 N 个假客户端:**真 WebSocket** + 真 hello(带 url 里的 userId 与 token)。 */
function startFakeClients(
  runtime: RoomRuntime, srv: WsServerHandle, options: SoakOptions, counters: LoadCounters,
): FakeClients {
  const sent = { move: 0, action: 0, attack: 0 };
  const state = { connectFailures: 0, connected: 0 };
  const ids: string[] = [];
  const zero = (): FakeClients => ({
    ids,
    sent,
    connected: () => state.connected,
    connectFailures: () => state.connectFailures,
    displacement: () => 0,
    stop: (): void => { /* 没有客户端可停 */ },
  });
  if (options.clients === 0) return zero();
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (typeof Ctor !== 'function') {
    throw new Error('全局 WebSocket 不存在(Node ≥ 22 才有)⇒ 无法起假客户端');
  }
  const clientIds = soakClientIds(options);
  const list: FakeClient[] = [];
  for (let i = 0; i < options.clients; i += 1) {
    const userId = clientIds[i] as string;
    ids.push(userId);
    const token = srv.issueToken(userId);
    const url = `ws://127.0.0.1:${srv.port}/ws?userId=${encodeURIComponent(userId)}`
      + `&token=${encodeURIComponent(token)}`;
    const c: FakeClient = {
      userId, index: i, socket: null, connected: false, seq: 0, walkStep: 0,
      walkDirX: 1, walkDirY: i % 2 === 0 ? 1 : -1, spawn: null,
    };
    list.push(c);
    let socket: WsLike;
    try {
      socket = new Ctor(url);
    } catch {
      state.connectFailures += 1;
      continue;
    }
    c.socket = socket;
    socket.addEventListener('open', () => {
      c.connected = true;
      state.connected += 1;
      socket.send(JSON.stringify({
        t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null,
      }));
    });
    socket.addEventListener('message', () => { counters.framesReceived += 1; });
    socket.addEventListener('error', () => { state.connectFailures += 1; });
  }

  /** 每多少拍发一条移动(0 = 不发)。 */
  const moveEveryTicks = options.moveHz > 0
    ? Math.max(1, Math.round(1_000 / options.moveHz / CLIENT_TICK_MS)) : 0;
  /** 每多少拍发一条动作/攻击(0 = 不发)。 */
  const actionEveryTicks = options.actionHz > 0
    ? Math.max(1, Math.round(1_000 / options.actionHz / CLIENT_TICK_MS)) : 0;
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    for (const c of list) {
      const socket = c.socket;
      if (socket === null || !c.connected || socket.readyState !== 1) continue;
      if (moveEveryTicks > 0 && tick % moveEveryTicks === 0) {
        const pos = runtime.playerState(c.userId);
        if (pos !== undefined) {
          /* 第一次拿到权威坐标 ⇒ 记下出生点(位移读数要以它为基准)。 */
          if (c.spawn === null) c.spawn = { x: pos.x, y: pos.y };
          const msg = intentOf(runtime, c, options.sizeCells);
          if (msg !== null) {
            c.seq += 1;
            c.walkStep += 1;
            socket.send(JSON.stringify(msg));
            sent.move += 1;
          }
        }
      }
      if (actionEveryTicks > 0 && tick % actionEveryTicks === 0) {
        const msg = actionIntentOf(runtime, c, Math.floor(tick / actionEveryTicks) + c.index);
        if (msg !== null) {
          socket.send(JSON.stringify(msg));
          if (msg['t'] === 'attack') sent.attack += 1;
          else sent.action += 1;
        }
      }
    }
  }, CLIENT_TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    ids,
    sent,
    connected: () => state.connected,
    connectFailures: () => state.connectFailures,
    displacement: () => {
      let sum = 0;
      for (const c of list) {
        const pos = runtime.playerState(c.userId);
        if (pos === undefined || c.spawn === null) continue;
        sum += Math.abs(pos.x - c.spawn.x) + Math.abs(pos.y - c.spawn.y);
      }
      return Math.round(sum * 1_000) / 1_000;
    },
    stop: (): void => {
      clearInterval(timer);
      for (const c of list) {
        c.connected = false;
        try { c.socket?.close(); } catch { /* 已断 */ }
      }
    },
  };
}

/* ═══════════════════════════ 7. 采样本体 ═══════════════════════════ */

type SampleInput = {
  seq: number;
  phase: SoakPhase;
  atMs: number;
  db: DbLike;
  dbPath: string;
  runtime: RoomRuntime;
  counters: LoadCounters;
  tickIntervals: readonly number[];
  clients: FakeClients;
};

/** 把当前时刻的全部读数拼成一条样本(纯读,无副作用)。 */
function buildSample(input: SampleInput): SoakSample {
  const mem = process.memoryUsage();
  const db = input.db;
  const tables = tableCounts(db);
  const mainBytes = fileBytes(input.dbPath);
  const walBytes = fileBytes(`${input.dbPath}-wal`) + fileBytes(`${input.dbPath}-shm`);
  const rt = input.runtime;

  const intervals = input.tickIntervals;
  let tickMean = 0;
  let tickMin = 0;
  let tickMax = 0;
  if (intervals.length > 0) {
    let sum = 0;
    tickMin = intervals[0] as number;
    tickMax = intervals[0] as number;
    for (const v of intervals) {
      sum += v;
      if (v < tickMin) tickMin = v;
      if (v > tickMax) tickMax = v;
    }
    tickMean = sum / intervals.length;
  }

  const c = input.counters;
  const load: SoakLoad = {
    clients: input.clients.ids.length,
    connected: input.clients.connected(),
    framesReceived: c.framesReceived,
    movesApplied: c.movesApplied,
    movesWorldRejected: c.movesWorldRejected,
    actionsApplied: c.actionsApplied,
    actionOk: c.actionOk,
    attacksApplied: c.attacksApplied,
    worldWrites: c.worldWrites,
    displacement: input.clients.displacement(),
    sends: {
      move: input.clients.sent.move,
      action: input.clients.sent.action,
      attack: input.clients.sent.attack,
    },
  };
  const anyUplink = load.sends.move + load.sends.action + load.sends.attack > 0;
  const anyApplied = load.movesApplied + load.actionsApplied + load.attacksApplied > 0;

  return {
    seq: input.seq,
    phase: input.phase,
    atMs: Math.round(input.atMs),
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    rssBytes: mem.rss,
    externalBytes: mem.external,
    db: { mainBytes, walBytes, totalBytes: mainBytes + walBytes },
    tables,
    events: tables['room_events'] ?? 0,
    users: tables['users'] ?? 0,
    roomPlayers: tables['room_players'] ?? 0,
    roomChunks: tables['room_chunks'] ?? 0,
    ledgers: {
      joinAudits: rt.joinAudits.length,
      removalConflicts: rt.removalConflicts.length,
      removeLog: rt.removeLog.length,
      saveErrors: rt.saveErrors.length,
      playerSnapshotErrors: rt.playerSnapshotErrors.length,
      throttledActions: rt.throttledActions.length,
      acViolations: rt.ac.violations().length,
      ledgerPrunes: rt.ledgerPrunes,
    },
    autosave: {
      count: rt.saveCount,
      failCount: rt.saveFailCount,
      lastReason: rt.lastSaveReason,
      lastError: rt.lastSaveError,
      inFlight: rt.autosaveState().inFlight,
      backoffFrames: rt.autosaveState().backoffFrames,
    },
    tick: {
      worldTick: rt.state.meta.tick,
      observed: intervals.length,
      meanMs: Math.round(tickMean * 100) / 100,
      minMs: tickMin,
      maxMs: tickMax,
      fps: tickMean > 0 ? Math.round((1_000 / tickMean) * 100) / 100 : 0,
    },
    load,
    verdict: anyUplink || anyApplied ? 'LOAD' : 'NO_LOAD',
  };
}

/* ═══════════════════════════ 8. 汇总 ═══════════════════════════ */

/** 一条序列的三点读数(首/末/峰)。 */
export type Range3 = { first: number; last: number; peak: number; low: number; delta: number };

/** 长跑汇总 —— 报告里的每个数字都出自这里。 */
export type SoakSummary = {
  verdict: 'NO_LOAD' | 'LOAD';
  clients: number;
  minutes: number;
  durationMs: number;
  samples: number;
  rss: Range3;
  heapUsed: Range3;
  disk: Range3;
  events: Range3;
  tables: Record<string, Range3>;
  tick: { observed: number; meanMs: number; maxMs: number; minMs: number; fps: number };
  autosave: { count: number; failCount: number; lastReason: string | null; lastError: string | null };
  load: SoakLoad;
  actionKinds: Record<string, number>;
  series: SeriesReport[];
  monotonicGrowers: string[];
  decreased: string[];
  wsLogLines: number;
};

function range3(samples: readonly SoakSample[], key: string): Range3 {
  const vals = samples.map((s) => seriesValue(s, key)).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return { first: 0, last: 0, peak: 0, low: 0, delta: 0 };
  let peak = vals[0] as number;
  let low = vals[0] as number;
  for (const v of vals) {
    if (v > peak) peak = v;
    if (v < low) low = v;
  }
  const first = vals[0] as number;
  const last = vals[vals.length - 1] as number;
  return { first, last, peak, low, delta: last - first };
}

/** 汇总一组样本(+ 进程级读数)。 */
export function summarizeSoak(input: {
  options: SoakOptions;
  samples: readonly SoakSample[];
  counters: LoadCounters;
  wsLogLines: number;
  durationMs: number;
}): SoakSummary {
  const samples = input.samples;
  const last = samples[samples.length - 1] as SoakSample;
  void samples[0];
  const tables: Record<string, Range3> = {};
  for (const table of Object.keys(TABLE_PRIMARY_KEYS)) {
    tables[table] = range3(samples, `tables.${table}`);
  }
  /* tick 统计取**最后一条**样本的累计读数(它覆盖整个跑动窗口)。 */
  return {
    verdict: last.verdict,
    clients: input.options.clients,
    minutes: input.options.minutes,
    durationMs: input.durationMs,
    samples: samples.length,
    rss: range3(samples, 'rssBytes'),
    heapUsed: range3(samples, 'heapUsedBytes'),
    disk: range3(samples, 'db.totalBytes'),
    events: range3(samples, 'events'),
    tables,
    tick: {
      observed: last.tick.observed,
      meanMs: last.tick.meanMs,
      maxMs: last.tick.maxMs,
      minMs: last.tick.minMs,
      fps: last.tick.fps,
    },
    autosave: {
      count: last.autosave.count,
      failCount: last.autosave.failCount,
      lastReason: last.autosave.lastReason,
      lastError: last.autosave.lastError,
    },
    load: last.load,
    actionKinds: { ...input.counters.actionKinds },
    series: seriesReports(samples),
    monotonicGrowers: monotonicGrowers(samples),
    decreased: decreasedSeries(samples),
    wsLogLines: input.wsLogLines,
  };
}

/** 汇总前缀(与样本行分开:它是**一段结论**,不是一条时序读数)。 */
export const SUMMARY_PREFIX = '[soak:summary]';

/** 汇总的**一行** JSON(供脚本消费)。 */
export function formatSummaryLine(s: SoakSummary): string {
  return `${SUMMARY_PREFIX} ${JSON.stringify(s)}`;
}

/** 给人看的几行(报告里要的那几个数)。 */
export function formatSummaryLines(s: SoakSummary): string[] {
  const mib = (v: number): string => `${(v / 1048576).toFixed(1)}MiB`;
  return [
    `  [soak] 判定 ${s.verdict} · 客户端 ${s.clients} · ${(s.durationMs / 60_000).toFixed(2)} 分钟 · ${s.samples} 条样本`,
    `  [soak] RSS   首 ${mib(s.rss.first)} → 末 ${mib(s.rss.last)} · 峰 ${mib(s.rss.peak)} · 谷 ${mib(s.rss.low)}`,
    `  [soak] heap  首 ${mib(s.heapUsed.first)} → 末 ${mib(s.heapUsed.last)} · 峰 ${mib(s.heapUsed.peak)}`,
    `  [soak] 库    首 ${s.disk.first}B → 末 ${s.disk.last}B(+${s.disk.delta}B)`,
    `  [soak] 事件  ${s.events.first} → ${s.events.last}(+${s.events.delta}) · room_players ${s.tables['room_players']?.last ?? 0} · users ${s.tables['users']?.last ?? 0}`,
    `  [soak] 存档  成功 ${s.autosave.count} 次 · 失败 ${s.autosave.failCount} 次 · 最近原因 ${s.autosave.lastReason ?? '(无)'}`,
    `  [soak] tick  ${s.tick.observed} 帧间隔 · 均值 ${s.tick.meanMs}ms · 最大 ${s.tick.maxMs}ms · ${s.tick.fps}fps`,
    `  [soak] 负载  move ${s.load.movesApplied} · action ${s.load.actionsApplied}(OK ${s.load.actionOk}) · attack ${s.load.attacksApplied} · 世界写 ${s.load.worldWrites}`,
    `  [soak] 单调增长 ${s.monotonicGrowers.length === 0 ? '(无)' : s.monotonicGrowers.join(', ')}`,
    `  [soak] 中途下降 ${s.decreased.length === 0 ? '(无)' : s.decreased.join(', ')}`,
  ];
}

/* ═══════════════════════════ 9. 跑一次 ═══════════════════════════ */

/** 一次长跑的全部产物。 */
export type SoakRun = {
  options: SoakOptions;
  samples: readonly SoakSample[];
  summary: SoakSummary;
  /** 写进日志的**样本行**(不含汇总;长度 = 预期样本数 + 1 条基线)。 */
  lines: readonly string[];
  logPath: string;
  dbPath: string;
  durationMs: number;
  /** 收尾时被 `SIGINT` 打断(报告如实标)。 */
  aborted: boolean;
};

/** 预期样本条数(基线 1 条 + 跑动期 N 条)。 */
export function expectedSampleCount(durationMs: number, sampleEveryMs: number): number {
  return Math.max(1, Math.round(durationMs / sampleEveryMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, ms)); });
}

/** 日志追加一行(append,永不覆盖 —— 与「快照」相反)。 */
function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path) === '' ? '.' : dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, 'utf8');
}

/**
 * 跑一次真长跑:装配 → 起客户端 → 按间隔采样(追加日志)→ 收尾存档 → 汇总。
 */
export async function runSoak(opts: Partial<SoakOptions> = {}): Promise<SoakRun> {
  const options: SoakOptions = {
    ...DEFAULT_SOAK_OPTIONS,
    ...opts,
    logPath: opts.logPath !== undefined && opts.logPath !== ''
      ? opts.logPath
      : defaultLogPath(opts.minutes ?? DEFAULT_SOAK_OPTIONS.minutes),
  };
  const durationMs = Math.max(1, Math.round(options.minutes * 60_000));
  const sampleSteps = expectedSampleCount(durationMs, options.sampleEveryMs);
  const perStepMs = durationMs / sampleSteps;

  let aborted = false;
  const onAbort = (): void => { aborted = true; };
  process.on('SIGINT', onAbort);
  process.on('SIGTERM', onAbort);

  const lines: string[] = [];
  const wallStart = Date.now();
  const fixture = await createSoakFixture(options);
  try {
    const header = `# soak start ${new Date().toISOString()} room=${options.roomId}`
      + ` clients=${options.clients} minutes=${options.minutes}`
      + ` frameMs=${options.frameMs} sampleEveryMs=${options.sampleEveryMs} db=${options.dbPath}`;
    lines.push(header);
    appendLine(options.logPath, header);

    const emit = (phase: SoakPhase = 'run'): void => {
      const s = fixture.sample(phase);
      const line = formatSampleLine(s);
      lines.push(line);
      appendLine(options.logPath, line);
      if (!options.quiet) console.log(line);
      if (options.onSample !== null) options.onSample(s);
    };

    /* 基线一条(t≈0):让「首值」不是第一个采样点(否则首值本身已经长过了)。 */
    emit('run');
    for (let i = 0; i < sampleSteps; i += 1) {
      if (aborted) break;
      await sleep(perStepMs);
      if (aborted) break;
      emit('run');
    }
  } finally {
    /* 收尾在**同一处**:异常也要关客户端/服务端/房(
       否则测试里一个抛错就会留下真 socket 与打开的文件句柄)。 */
    await fixture.close();
    process.removeListener('SIGINT', onAbort);
    process.removeListener('SIGTERM', onAbort);
  }

  const summary = summarizeSoak({
    options,
    samples: fixture.samples,
    counters: fixture.counters,
    wsLogLines: fixture.wsLogs.length,
    durationMs: Date.now() - wallStart,
  });
  /* 汇总也进日志(末尾一行,便于事后对账)。 */
  appendLine(options.logPath, formatSummaryLine(summary));

  return {
    options,
    samples: fixture.samples,
    summary,
    lines,
    logPath: options.logPath,
    dbPath: options.dbPath,
    durationMs: summary.durationMs,
    aborted,
  };
}

/* ═══════════════════════════ 10. CLI ═══════════════════════════ */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const options = parseSoakArgs(argv);
  console.log(`  [soak] 装配世界(${options.sizeCells}×${options.sizeCells},带怪)…`);
  const run = await runSoak(options);
  for (const line of formatSummaryLines(run.summary)) console.log(line);
  console.log(formatSummaryLine(run.summary));
  console.log(`  [soak] 日志:${run.logPath}`);
  console.log(`  [soak] 库  :${run.dbPath}`);
}

const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry !== undefined && entry.endsWith('soak.ts')) {
  main().catch((e: unknown) => {
    console.error(`  [soak] 失败:${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}