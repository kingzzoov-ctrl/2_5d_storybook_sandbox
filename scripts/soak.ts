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
 * 1 真定时器抖动      32Hz 的 setInterval 在真实负载下的**实际 tick 间隔**(本文件采样)
 * 2 真文件 I/O        自动存档真的写进 SQLite 文件(库文件字节 / 行数增长)
 * 3 真 GC / 真内存    RSS 与 heapUsed 在 60 分钟里是**回落**还是**单调涨**
 * 4 真协议            假客户端走**真 WebSocket**(二进制帧 / tag 分流 / ack)
 * ```
 *
 * ## 装配路径:复用 `scripts/play.ts` 的那一条
 *
 * ```text
 * assemble({ sizeCells, mobs, dbPath })  →  RoomRuntime + WorldSim(生产装配)
 * startWsServer({ room, frameMs })       →  32Hz 广播循环(room.step 在那儿被调)
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
 *   ⇒ `load.movesApplied` / `load.actionsApplied` / `load.terrainWrites` 会涨;
 *     轮转里含 `PLACE_BLOCK` / `BREAK_BLOCK`,目标格**随玩家移动而变**(不是只打脚下)
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
 *           attacksApplied / terrainWrites / groundWrites / rejectedWrites /
 *           sends / framesReceived
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
import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';

/* ═══════════════════════════ 1. 选项与参数 ═══════════════════════════ */

/** 长跑参数。**小数分钟合法**(测试用 1/30 = 2 秒),但必须 > 0。 */
export type SoakOptions = {
  /** 跑多久(分钟)。 */
  minutes: number;
  /** 并发假客户端数;`0` = 负对照(应当报告 NO_LOAD)。 */
  clients: number;
  /** 采样间隔(ms)。 */
  sampleEveryMs: number;
  /** 服务端帧间隔(ms)。32Hz ⇒ 31.25。 */
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
  /**
   * 放置 / 拆块 / 采集的**挑格策略**(WS-FND-173)。
   *
   * ```text
   * 'varying'   默认:在玩家周围半径 2 内挑「空格」(放)/「有物件的格」(拆),
   *             扫描起点按轮次旋转 ⇒ 目标格随玩家移动**与轮次**都变(不是只打脚下)
   * 'offworld'  负对照:目标恒取**世界外**那一格 ⇒ `placeBlock` / `breakBlock`
   *             一律被世界拒(理由「坐标 … 在世界外」),零副作用、
   *             **一个 chunk 都不改** ⇒ 判据 flags 里 `rejectedWrites > 0`
   *             而 `room_chunks` 与 `terrainWrites` 都不动
   * ```
   *
   * ⚠️ 负对照为什么不用「自己脚下那一格」:实测玩家会走过**生成的地形物件**
   *   (树/矿脉),那时脚下的 `GATHER` / `BREAK_BLOCK` **会成功** ⇒ 负对照自己
   *   造出地形写,判据转假又转真,没有牙。世界外那一格是确定性的零副作用目标。
   */
  placeTarget: 'varying' | 'offworld';
};

/** 夹具的**默认值**(量纲都写在这里,不散在代码里)。 */
export const DEFAULT_SOAK_OPTIONS: SoakOptions = {
  minutes: 60,
  clients: 8,
  sampleEveryMs: 5_000,
  frameMs: DT * 1000,
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
  placeTarget: 'varying',
};

/** 用法(打印在 `--help` / 参数错时)。 */
export function usage(): string {
  return [
    'node scripts/soak.ts [选项]',
    '  --minutes <N>        跑多久(分钟;小数合法)  默认 60',
    '  --clients <N>        并发假客户端数(0 = 负对照)  默认 8',
    '  --sample-every <S>   采样间隔(秒)  默认 5',
    '  --frame-ms <MS>      服务端帧间隔(ms)  默认 31.25(32Hz)',
    '  --action-hz <N>      每客户端每秒动作条数  默认 1',
    '  --move-hz <N>        每客户端每秒移动意图条数  默认 5',
    '  --size <N>           世界边长(格)  默认 96',
    '  --warmup <N>         预热帧数  默认 400',
    '  --db <PATH>          文件库路径  默认 .data/soak.db',
    '  --log <PATH>         采样日志(追加)  默认 .data/soak-<minutes>m.log',
    '  --room-id <ID>       房间 id  默认 soak',
    '  --fresh              开跑前删掉旧库与旧日志',
  '  --quiet              不往 stdout 打样本行',
  '  --place-offworld     放置/拆块/采集恒打世界外那格(负对照:必被拒、不改地形)',
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
  /* `--place-offworld` = 负对照开关(布尔 ⇒ 没有「非法值」这种可能):见 `placeTarget`。 */
  const placeOffworld = argv.includes('--place-offworld');
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
    placeTarget: placeOffworld ? 'offworld' : 'varying',
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
  /**
   * ★ WS-FND-173:世界侧三类写法**分开计数**(修前只有一颗 `worldWrites`,
   * 定义见 `applyMaterialWrite`)。判据要的是「地形真的被写」这一维:
   * `terrainWrites > 0 ⇔ room_chunks > 0`。
   */
  /** 真改了 chunk 的地形写次数(`placeBlock` / `breakBlock` 返回 `ok:true`)。 */
  terrainWrites: number;
  /** 地面物品账的写入次数(**一个字都不改 chunk**;`dropItem` / 拾取 / 消耗)。 */
  groundWrites: number;
  /** 地形写口**被世界拒**的次数(`placeBlock` / `breakBlock` 返回 `ok:false`)。 */
  rejectedWrites: number;
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
    /**
     * ★ WS-FND-178(P1):反作弊流水**因环形缓冲满而丢掉**的条数
     * (`AntiCheatRoom.droppedViolations`)。
     *
     * 为什么必须有它:`acViolations` 是**环里还剩多少条**(容量 512),它**饱和**——
     * 长期跑的时候读数是 512 还是 512,「一直在违规」与「511 条是三个月前的」
     * 在日志里长得**一模一样**。丢掉的那一半事实此前没有任何读口 ⇒ 现场只剩
     * 一句「512 条全是一个人的 TELEPORT」。口径:`≥ 512` 就是饱和的证据。
     *
     * ⚠️ **不**进 `SOAK_SERIES`(那是「只该涨」的序列台账,加一条会改序列条数,
     * 牵动 `FND169-11` 的 `reports.length` 与文档里登记的数字);它挂在样本对象上,
     * 需要时按点路径读。
     */
    acDroppedViolations: number;
    /**
     * ★ 被归类成 `stale` 的拒绝**累计条数**(`AntiCheatRoom.staleRejections`)。
     *
     * 这类拒绝**不是违规**:客户端的步长仍在额度内,多出来的距离来自**服务端自己**
     * 在两包之间挪动刚体(击退 / 碰撞分离 / 落地沉降),客户端那一包发出时还不知道
     * (判据见 `checkMove` §6.1 的三角形不等式分类)。⇒ 它与 `acViolations` 分开读,
     * 才能把「有人在作弊」与「服务端在推玩家」分开。
     */
    acStaleRejections: number;
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
  'load.actionOk', 'load.attacksApplied', 'load.terrainWrites',
  'load.groundWrites', 'load.rejectedWrites', 'load.displacement',
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
  /** ★ WS-FND-173:地形写 / 地面写 / 被拒的三颗**互斥**计数器(定义见 `applyMaterialWrite`)。 */
  terrainWrites: number;
  groundWrites: number;
  rejectedWrites: number;
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
    terrainWrites: 0,
    groundWrites: 0,
    rejectedWrites: 0,
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

/** 物质层的全部写口(放置 / 破坏 / 地面掉落三件)。 */
export const MATERIAL_WRITE_METHODS: readonly string[] = [
  'dropItem', 'takeGroundItemNear', 'consumeGroundItem', 'placeBlock', 'breakBlock',
];

/**
 * ★ WS-FND-173:把一次**物质层写法**的返回值分进三个**互斥**计数桶。
 *
 * ## 为什么要拆(修前那颗 `worldWrites` 为什么不够)
 *
 * 修前只有一颗计数器,数的是「物质层五方法被调用了几次」。它把三类写法
 * **混在一个数**里:
 *
 * ```text
 * 真改了地形的        placeBlock / breakBlock 成功
 * 只动地面物品账的    dropItem / 拾取 / 消耗(一个字都不改 chunk)
 * 被世界拒的          placeBlock / breakBlock 失败(「这一格没有物件」…)
 * ```
 *
 * 后果:`load.worldWrites > 0` 被**地面掉落**就能满足 ⇒ 「真客户端动作 →
 * 地形被写 → chunk 落库」这条链**没有任何判据覆盖**(实测:60 分钟长跑里
 * `room_chunks` 恒 0,而 `worldWrites` 一直涨 —— 见 `tests/WS-FND-173` 的文件头)。
 *
 * ## 三个桶的定义(判据用的就是这三条)
 *
 * ```text
 * terrainWrites   真改了 chunk 的:placeBlock / breakBlock 返回 ok:true
 *                 (GATHER 也走 breakBlock ⇒ 自然计入)
 * groundWrites    地面物品账的写入:dropItem 总是写;takeGroundItemNear /
 *                 consumeGroundItem 只在**真的扣到东西**时才算
 * rejectedWrites  地形写口被世界**拒**的次数(placeBlock / breakBlock 返回 ok:false)
 * ```
 *
 * ⚠️ 不变量:`terrainWrites + rejectedWrites` = 地形写的尝试次数;
 *   `terrainWrites` 与 `groundWrites` **互斥**(前者必改 chunk,后者一个字都不改)。
 */
export function applyMaterialWrite(counters: LoadCounters, name: string, result: unknown): void {
  switch (name) {
    case 'placeBlock':
    case 'breakBlock': {
      const ok = (result as { ok?: unknown } | null | undefined)?.ok === true;
      if (ok) counters.terrainWrites += 1;
      else counters.rejectedWrites += 1;
      return;
    }
    case 'dropItem':
      counters.groundWrites += 1;
      return;
    case 'takeGroundItemNear':
      if (result === true) counters.groundWrites += 1;
      return;
    case 'consumeGroundItem':
      if (typeof result === 'number' && result > 0) counters.groundWrites += 1;
      return;
    default:
      return;
  }
}

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
 * ## 真正的天花板是 §6.1 的**单帧上界**(实测定的),不是 §6.2 的窗口均速
 *
 * 假客户端按 `moveHz` 的节拍发包(除数由 `moveEveryTicks` 派生,见 `CLIENT_TICK_MS`),
 * 报文里的 `tick`
 * 取服务器的 `state.meta.tick`;而 `checkMove` 的额度是
 * `maxDisplacementPerTick(1) × dtTicks`,且 `claimedTick` 被
 * `min(…, lastMoveTick + MAX_MOVE_CATCHUP_TICKS(1), …)` 夹住 ⇒ **每包只兑现 1 帧**,
 * 额度 = `BASE_MOVE_SPEED × DT × TELEPORT_SLACK` = 4.5 × 0.03125 × 1.6 = **0.225 格**。
 * 斜向走的单包位移 = `√2 × 步长`;步长由 **「一包 = 一个标称帧的合法位移」** 派生:
 * ```text
 * √2 × WALK_STEP = BASE_MOVE_SPEED × DT = 4.5 × 0.03125 = 0.140625 格
 * ⇒ 占 0.225 的 **62.5%**(余量 0.0844 格)
 * ```
 * 为什么不是「尽量贴近 0.225」:**WS-FND-178 的残余**教的那一课。修前这里写死
 * `0.15`(斜向 0.2121 = 0.225 的 **94.3%**,余量只剩 0.0129 格),而**世界会把刚体
 * 挪走**(击退 / 玩家互相推挤 / 落地)。实测(2.5 分钟 / 8 客户端,逐包读数见
 * `$PI_SCRATCH_DIR/_gap3.ts`):
 * ```text
 * 22 条 AC 侧 TELEPORT / 5472 包;
 * projGap = |投影 − 刚体| = 0        ← **应用那一刻**两者同源(投影已刷新)
 * readGap = |客户端**读**投影时的位置 − 应用时刻刚体| = 0.014 ~ 0.300 格
 *          = 「读 → 服务端应用」之间那**一个服务端帧**里世界把刚体推/击退的距离
 * ⇒ dist = 0.2121 + 那一帧的漂移 > 0.225 ⇒ 逐条判 TELEPORT(全部 dtTicks = 1)
 * ```
 * 其中 **16/22** 条的漂移只有 0.014~0.023 格 —— 它们**完全**是「步长没有余量」
 * 造成的(0.2121 + 0.014 = 0.226 > 0.225);剩下 **6/22** 是真击退(一帧
 * 0.088~0.300 格),那部分是产品固有,见 `server/src/net/room.ts#applyMove` 的
 * 「残余的**归因**」一段(本轮实测:改完本行之后 **22 → 0**)。
 * ⇒ 夹具保真度修:假客户端**每包只走一个标称帧的合法位移**(0.140625),余量
 * 0.0844 格 —— 与生产客户端同档(客户端上行是每帧一包)。
 * ⚠️ 这是**夹具**修,不是判据修:上界 0.225 / 窗口容差 / `MAX_MOVE_CATCHUP_TICKS`
 * **一个数都没动**;真作弊者申报远方坐标照样按真实位移判(`WS-FND-178` 的 FND178-5
 * 仍钉着「不误伤真作弊」)。
 *
 * ⚠️ 修前这段写的是「折算约 4.24 格/秒,离 5.63 有 25% 余量」——**两处口径都错**:
 * ```text
 * (a) 4.24 = 0.2121 × 20 —— 把**报文率**当成服务端帧率,**不是实测值**;
 *     60 分钟 soak 实测的窗口均速读数是 **0.5~1.3 格/秒**(窗口分母走真实跨度
 *     `spanTicks × 帧间隔`,而报文节拍远低于服务端帧率)⇒ 窗口那道闸一直有几十倍余量,
 *     它**从来不是**约束;
 * (b) 真正的约束是上面那条 0.225 的单帧上界 —— 旧步长下它只有 ≈5.7% 余量,而且是
 *     **硬闸**(超一点即判违规),不是「均速超一点才算」。
 * ```
 * 长跑里「长出假阳性」的真实来源也印证了这一点:见 WS-FND-178 —— 假阳性不是
 * 夹具走快了,而是**世界自己挪了刚体**(击退 / 落地 / 撞墙)之后反作弊水位不跟着走。
 * 判据:FND169-10 的 `acViolations === 0`。
 */
const WALK_STEP = BASE_MOVE_SPEED * DT / Math.SQRT2;


/** 客户端上行节拍(ms)。10Hz:比服务端 32Hz 慢几档,避免自己把上行灌满。 */
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

/** 一格(**整格**坐标,不是玩家那种半格浮点位置)。 */
type Cell = { x: number; y: number };

/**
 * 环形扫描的**偏移序列**(由内向外:r=1 的 8 格 → r=2 的 16 格)。
 *
 * 顺序是**确定性**的(不随机、不排序)⇒ 判据里「挑哪一格」可复现;
 * 起点由调用方按轮次旋转 ⇒ 同一次跑动里目标格不会钉死在同一处。
 */
function ringOffsets(radius: number): Cell[] {
  const out: Cell[] = [];
  for (let r = 1; r <= radius; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        out.push({ x: dx, y: dy });
      }
    }
  }
  return out;
}

/**
 * 放置/拆块的候选偏移(半径 2)。
 *
 * 半径取 2 的理由:1 格内常常是**玩家自己脚下**或紧贴的墙,`placeBlock` 会因实体
 * 占位被拒;3 格以上开始像「隔空造墙」。2 格既是对「站在旁边动手」的直觉,
 * 又让目标格**不止一格**(坐标真的在变)。
 */
const CELL_OFFSETS: readonly Cell[] = ringOffsets(2);

/** 玩家脚下那一格(整格坐标)。 */
function cellOf(pos: { x: number; y: number }): Cell {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y) };
}

/** 世界侧的**读口**子集(夹具只用它挑格;宿主缺席 ⇒ null)。 */
type MaterialsRead = { blockAt(x: number, y: number): number };

/** 取世界侧物质层的读口;没有世界源 ⇒ `null`(调用方退回脚下那一格)。 */
function materialsOf(rt: RoomRuntime): MaterialsRead | null {
  const host = rt.worldSaveHost;
  if (host === null || host === undefined || typeof host.materials !== 'function') return null;
  return host.materials();
}

/**
 * 在 `at` 周围挑一格满足 `want` 的格子;一圈都挑不到 ⇒ `null`。
 *
 * `spin` 旋转扫描起点(传**轮次**)⇒ 目标格随玩家**移动**与**轮次**都变,
 * 这正是「不要只打脚下」这条要求落到代码上的形态。
 */
function pickCell(
  mat: MaterialsRead, at: Cell, sizeCells: number, spin: number, want: 'empty' | 'occupied',
): Cell | null {
  const n = CELL_OFFSETS.length;
  for (let i = 0; i < n; i += 1) {
    const o = CELL_OFFSETS[(i + spin) % n] as Cell;
    const x = at.x + o.x;
    const y = at.y + o.y;
    if (x < 0 || y < 0 || x >= sizeCells || y >= sizeCells) continue;
    const obj = mat.blockAt(x, y);
    if (want === 'empty' ? obj === 0 : obj !== 0) return { x, y };
  }
  return null;
}

/**
 * 造一条**动作/攻击**上行(轮转)。返回值是完整的上行报文。
 *
 * 轮转表刻意覆盖三条不同的执行层:`material`(丢 / 拾 / 拆 / **放**)、`sleep`、
 * `use_item`、以及战斗那条**独立**的 `attack` 通道 —— 长跑要压的是它们的总和,
 * 不是某一个。
 *
 * ## 为什么必须含 `PLACE_BLOCK` 与「对有物件的格 `BREAK_BLOCK`」(WS-FND-173)
 *
 * 修前的轮转里**一个地形写都没有**:
 *
 * ```text
 * BREAK_BLOCK / GATHER  打的是**自己脚下那一格**(那里是空格)
 *                       ⇒ 世界回「这一格没有物件」⇒ 被拒,chunk 一个字节都不改
 * PLACE_BLOCK           根本不在轮转表里
 * ⇒ 60 分钟长跑里 room_chunks 恒 0 行,而 worldWrites 一直涨
 *   (它数的是地面掉落 + 被拒的拆块)⇒「真客户端动作 → 地形被写 → chunk 落库」
 *   这条链没有任何判据覆盖(见 tests/WS-FND-173 的文件头)
 * ```
 *
 * 现在:
 * ```text
 * PLACE_BLOCK   在玩家周围挑**空**格(obj = 0)放下背包里第一件 ⇒ 真改 chunk
 * BREAK_BLOCK   在玩家周围挑**有物件**的格拆 ⇒ 真改 chunk
 *               (周围一圈都没有物件时退回脚下 ⇒ 如实记一次 rejectedWrites)
 * GATHER        同一条挑格规则(采集的扣减也走 breakBlock)
 * ```
 */
function actionIntentOf(
  rt: RoomRuntime, c: FakeClient, round: number, options: SoakOptions,
): Record<string, unknown> | null {
  const pos = rt.playerState(c.userId);
  const inv = rt.authoritativeItemIds(c.userId);
  const itemId = inv.length > 0 ? (inv[0] as number) : null;
  const wildlife = rt.state.wildlife;
  const mat = materialsOf(rt);
  const self = pos === undefined ? null : cellOf(pos);
  /**
   * 目标格。负对照(`placeTarget === 'offworld'`)恒取**世界外**那一格:
   * `placeBlock` / `breakBlock` 必被世界拒(零副作用、一个 chunk 都不改)
   * ⇒ 那是「被拒的地形写」那条判据的负对照。
   */
  const targetOf = (want: 'empty' | 'occupied'): Cell => {
    if (options.placeTarget === 'offworld') {
      return { x: options.sizeCells + 4, y: options.sizeCells + 4 };
    }
    if (self === null || mat === null) return self ?? { x: 0, y: 0 };
    return pickCell(mat, self, options.sizeCells, round, want) ?? self;
  };
  switch (round % 8) {
    case 0:
      return itemId === null ? null
        : { t: 'action', action: 'DROP_ITEM', x: pos?.x ?? 0, y: pos?.y ?? 0, itemId, count: 1 };
    case 1:
      return itemId === null ? null
        : { t: 'action', action: 'PICKUP_ITEM', x: pos?.x ?? 0, y: pos?.y ?? 0, itemId };
    case 2: {
      const at = targetOf('occupied');
      return { t: 'action', action: 'GATHER', x: at.x, y: at.y };
    }
    case 3:
      return { t: 'action', action: 'SLEEP' };
    case 4:
      return itemId === null ? null : { t: 'action', action: 'USE_ITEM', itemId };
    case 5: {
      const at = targetOf('occupied');
      return { t: 'action', action: 'BREAK_BLOCK', x: at.x, y: at.y };
    }
    case 6: {
      const at = targetOf('empty');
      return itemId === null ? null
        : { t: 'action', action: 'PLACE_BLOCK', x: at.x, y: at.y, itemId };
    }
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
    wrapMethods(host, MATERIAL_WRITE_METHODS, (name, _args, result) => {
      applyMaterialWrite(counters, name, result);
    });
  }
  void lastWorldTick;

  /* ── 6.4 真 WS 服务端(32Hz 广播循环)── */
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
        const msg = actionIntentOf(runtime, c, Math.floor(tick / actionEveryTicks) + c.index, options);
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

  /* ★ D-26:节拍读数走 8b 的**同一份**实现(`tickRateOf`),这里不再自己算一遍。 */
  const rate = tickRateOf(input.tickIntervals);

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
    terrainWrites: c.terrainWrites,
    groundWrites: c.groundWrites,
    rejectedWrites: c.rejectedWrites,
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
      acDroppedViolations: rt.ac.droppedViolations,
      /* ★ 被归类成 `stale` 的拒绝(服务端自己挪刚体所致的假阳性)—— **不是**违规。
         与 `acViolations` 分开读,才能把「有人在作弊」与「服务端在推玩家」区分开:
         `acViolations = 0` 而这一列在涨 ⇒ 现场是后者。 */
      acStaleRejections: rt.ac.staleRejections,
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
      observed: rate.observed,
      meanMs: rate.meanMs,
      minMs: rate.minMs,
      maxMs: rate.maxMs,
      fps: rate.fps,
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
    `  [soak] tick  ${s.tick.observed} 帧间隔 · 均值 ${s.tick.meanMs}ms · 最大 ${s.tick.maxMs}ms · ${s.tick.fps}fps`
      + ` · 世界钟×墙钟倍率 ${clockRatio(s.tick.fps)}(1200 游戏秒 ≈ ${Math.round(1_200 * clockRatio(s.tick.fps) * 10) / 10} 墙钟秒;`
      + ' 详见 D-26)',
    `  [soak] 负载  move ${s.load.movesApplied} · action ${s.load.actionsApplied}(OK ${s.load.actionOk}) · attack ${s.load.attacksApplied}`
      + ` · 地形写 ${s.load.terrainWrites} · 地面写 ${s.load.groundWrites} · 被拒 ${s.load.rejectedWrites}`,
    `  [soak] 单调增长 ${s.monotonicGrowers.length === 0 ? '(无)' : s.monotonicGrowers.join(', ')}`,
    `  [soak] 中途下降 ${s.decreased.length === 0 ? '(无)' : s.decreased.join(', ')}`,
  ];
}

/* ═══════════════ 8b. 时间口径:帧数即时间(★ D-26)═══════════════ */

/**
 * ★ D-26:**世界时间 = `frameCount × DT`**(不读挂钟)。
 *
 * 标称 31.25ms/帧(32Hz)是**物量纲**,不是墙钟承诺 —— 宿主定时器粒度 > 31.25ms 的机器上,
 * 32Hz 循环的真实节拍更长(本机实测 ≈ 62.77ms/帧):
 *
 * ```text
 * 1200 游戏秒 = 1200 帧 × 31.25ms = 37.5 墙钟秒(标称,只在 31.25ms 粒度机器上成立)
 * 本机实测    1200 帧 × 62.77ms = 75.3 墙钟秒 ⇒ 倍率 = 32 / 15.93 = 2.0088
 * ```
 *
 * 本节四个函数是**唯一**的倍率实现:`play.ts` 的启动打印与 `soak.ts` 的汇总行
 * 都调它们,不许各自再算一遍(判据 `tests/WS-FND-175-clock-convention.test.ts`)。
 */

/** 标称帧间隔(ms)。**必须**等于 `shared/types/physics.ts#DT × 1000`(32Hz ⇒ 31.25)。 */
export const NOMINAL_TICK_MS = DT * 1000;

/** 标称帧率(Hz)。 */
export const NOMINAL_TICK_HZ = 1_000 / NOMINAL_TICK_MS; // 32

/** 一段帧间隔样本的读数(与样本行里的 `tick` **同一份**)。 */
export type TickRate = {
  observed: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  fps: number;
};

/** 实测帧率(2 位小数);`meanMs <= 0` ⇒ 0(**不编数**)。 */
export function observedFps(meanMs: number): number {
  return meanMs > 0 ? Math.round((1_000 / meanMs) * 100) / 100 : 0;
}

/**
 * 世界钟相对墙钟的**倍率**(4 位小数)= 标称帧率 ÷ 实测帧率。
 *
 * ```text
 * 倍率 1.0    实测节拍 = 标称 ⇒ 游戏秒 与 墙钟秒 同时走
 * 倍率 1.2555 实测 15.93fps ⇒ 1200 游戏秒要走 1506.6 墙钟秒(本机)
 * ```
 *
 * 非正数一律返回 0(由调用方判「不适用」,不在这里假装 1.0)。
 */
export function clockRatio(fps: number, nominalMs: number = NOMINAL_TICK_MS): number {
  if (!(fps > 0) || !(nominalMs > 0)) return 0;
  return Math.round(((1_000 / nominalMs) / fps) * 10_000) / 10_000;
}

/** 由实测**均值间隔**算倍率(先 `observedFps` 再 `clockRatio`,两步各只有一份实现)。 */
export function clockRatioOfMean(meanMs: number, nominalMs: number = NOMINAL_TICK_MS): number {
  return clockRatio(observedFps(meanMs), nominalMs);
}

/** 由一段帧间隔算节拍读数(采样本体与本节的打印**共用**它,不各算一遍)。 */
export function tickRateOf(intervals: readonly number[]): TickRate {
  if (intervals.length === 0) return { observed: 0, meanMs: 0, minMs: 0, maxMs: 0, fps: 0 };
  const first = intervals[0] as number;
  let sum = 0;
  let min = first;
  let max = first;
  for (const v of intervals) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / intervals.length;
  return {
    observed: intervals.length,
    meanMs: Math.round(mean * 100) / 100,
    minMs: min,
    maxMs: max,
    fps: observedFps(mean),
  };
}

/**
 * 「实测节拍」的**一行**(启动打印与汇总行同款同一份实现):
 * 均值/最小/最大间隔 · 实际 fps · **世界钟 × 墙钟倍率** · 1200 游戏秒折算的墙钟秒。
 */
export function formatTickRateLine(
  label: string, r: TickRate, nominalMs: number = NOMINAL_TICK_MS,
): string {
  if (r.observed <= 0) return `${label}: 没采到帧间隔(样本 0 条)⇒ 倍率不适用`;
  if (r.meanMs <= 0) return `${label}: ${r.observed} 个帧间隔但均值 0ms(低于时钟分辨率)⇒ 倍率不适用`;
  const ratio = clockRatio(r.fps, nominalMs);
  const wallSec = Math.round(1_200 * ratio * 10) / 10;
  return `${label}: ${r.observed} 个帧间隔 · 均值 ${r.meanMs}ms · 最小 ${r.minMs}ms · 最大 ${r.maxMs}ms`
    + ` · 实际 ${r.fps}fps(标称 ${nominalMs}ms ⇒ ${NOMINAL_TICK_HZ}fps)`
    + ` · 世界钟×墙钟倍率 ${ratio}(1200 游戏秒 ≈ ${wallSec} 墙钟秒)`;
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