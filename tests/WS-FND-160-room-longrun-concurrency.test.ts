/**
 * WS-FND-160 · 房间**长跑 + 并发**的六处缺陷(实测:16 人房 ~35 SQL/s、证据只剩最后一份)。
 *
 * ## 这一版修的是什么(每一条都有「修前形态 → 现在」)
 * ```text
 * 1 P1 自动存档**双轨倒置**   `autosaveDue()` 先判帧轨 ⇒ 每 20 帧(1 秒)存一次,
 *                            `AUTOSAVE_INTERVAL_MS`(30s)在正常推进下**永不触发**;
 *                            失败后每帧重试(永不退避)。
 * 2 P1 待删**无世代**          `pendingWorldRemovals:Set<userId>` ⇒ 同 id 在重试**之前**重进
 *                            ⇒ 重试把刚重进的刚体删掉,而「房里有他 / 世界没他」无告警。
 * 3 P1 动作预算**不公平**      整房共享 64 且在查 handler/权限**之前**扣格 ⇒ 一个人灌
 *                            垃圾动作,同帧其余人动作全灭;超预算还复用 `INVALID`。
 * 4 P2 证据**单槽**            `lastJoinAudit` / `lastRemoveApplied` / `lastSaveError`
 *                            并发 N 人只剩最后一份。
 * 5 P2 按玩家 Map**离场不清**  `itemCounts` / `inventoryTotals` 只增不删 ⇒ 每个进过房的
 *                            id 留一把钥匙。
 * 6 P2 反作弊流水**全房一本**   512 条是全房共享 ⇒ 一个刷分客户端把别人的证据挤出。
 * 7 P2 模块级侧账**只由 RESET_WORLD 清** ⇒ `onDispose` 不碰,每销毁一间房漏一份。
 * ```
 *
 * ## 判据(14 条;A = 长跑,B = 并发)
 * ```text
 * A  FND160-1  量纲锚:30s 轨 = 30_000ms / 帧节流 = 20 帧 / 整房预算 = 64/帧
 * A  FND160-2 ★★ 640 帧(20Hz × 32s)里自动存档 **2 次**(冷启动 1 + 30s 轨 1);
 *              注入「拔掉帧轨冷启动约束」的真实副本 ⇒ 32 次 ⇒ 判据转假
 * A  FND160-3 ★  冷启动那一次仍在:第 20 帧落盘、报告 tick = 20(帧轨**更慢**不更快)
 * A  FND160-4 ★  相邻两次存档的间隔 ≥ 30s(没有任何路径比墙钟轨更快)
 * A  FND160-5 ★★ 失败宿主:640 帧内尝试 ≤ 12 次(修前 32 次 = 每 20 帧)且退避窗真的在长
 * A  FND160-6 ★  退避成功后归零(失败 → 成功 ⇒ `backoffFrames === 0`)
 * A  FND160-7 ★  在途标志:宿主回调里重入 `saveWorldNow` ⇒ 返回 false 且计数只 +1
 * B  FND160-8 ★★ 8 人并发入场 ⇒ `joinAudits.length === 8`(单槽修前 = 1)
 * B  FND160-9 ★★ 待删 + 重进:重进后 `step()` 不许再删刚体,且撞车留证;
 *              注入「拆掉 join 清账 + 世代校验两道闸」的真实副本 ⇒ 刚体被删 ⇒ 判据转假
 * B  FND160-10 ★ 「房里有他 / 世界没他」可观测(`removalConflicts[].worldMismatch`)
 * B  FND160-11 ★★ 16 人房 p1 刷 100 条 ⇒ p1 收 `THROTTLED`、**p2 同帧照常动作**;
 *              注入「砍掉每玩家份额档」的真实副本 ⇒ p2 同帧被拒 ⇒ 判据转假
 * B  FND160-12 ★  未注册动作(垃圾报文)不吃预算(`used` 不变)
 * B  FND160-13 ★★ 7 人各 3 条早期证据在刷分者 4000 条之后仍在;
 *              注入「永远覆写全局最旧」的真实副本 ⇒ 21 条全被挤没 ⇒ 判据转假
 * B  FND160-14 ★  离场清**空账**、非空账**留着**(退房不吞玩家的东西)+ 销毁清侧账
 * ```
 *
 * ## 反例的纪律(与 WS-FND-137 / WS-FND-158 同一套)
 * ```text
 * 1 反例读数必须来自**真实代码路径** —— 不手写一个「超预算的读数对象」;
 *   A2 / B9 / B11 / B13 都是把源码的**那一行真的拔掉**(副本写在 tmpdir,用完即删),
 *   再跑同一个场景。锚点命中数 ≠ 1 ⇒ 报错,而不是静默继续。
 * 2 期望值写字面量(640 / 2 / 32 / 8 / 30_000 / 20 / 64),不拿被测常量当期望值。
 * 3 每条「修好了」的断言都配一条负对照:同一个读数换个前提必须转假。
 * ```
 *
 * 运行:`node tests/WS-FND-160-room-longrun-concurrency.test.ts`
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTOSAVE_FRAME_INTERVAL,
  AUTOSAVE_INTERVAL_MS,
  MAX_ACTIONS_PER_TICK,
  RoomAction,
  RoomRuntime,
  type RoomRuntimeOptions,
  type WorldSaveHost,
} from '../server/src/net/room.ts';
import { AntiCheatRoom } from '../server/src/net/anticheat.ts';
import { NetPersistRoom } from '../server/src/net/room.colyseus.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { createUser, migrate, type DbLike } from '../server/src/db/repo.ts';
import { createPetRecord, putPetSlot } from '../server/src/mobs/taming.ts';
import { tamedPetsOfRoom } from '../server/src/net/actions/breed_tame.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROOM_SRC = join(ROOT, 'server/src/net/room.ts');
const AC_SRC = join(ROOT, 'server/src/net/anticheat.ts');
const COLYSEUS_SRC = join(ROOT, 'server/src/net/room.colyseus.ts');

const T0 = 1_700_000_000_000;
const OWNER = 'u_owner';
/** 一帧 = 50ms(20Hz)。 */
const FRAME_MS = 50;
/** 长跑窗口:640 帧 = 32 秒(够 30s 轨整整一轮)。 */
const FRAMES = 640;

type RtCtor = new (opts: RoomRuntimeOptions, db: DbLike | null) => RoomRuntime;
const RT = RoomRuntime as unknown as RtCtor;

let roomSeq = 0;
function freshId(tag: string): string {
  roomSeq += 1;
  return `r160_${tag}_${roomSeq}`;
}

/* ═══════════════════════════ 0. 夹具 ═══════════════════════════ */

type TestClock = { clock: { nowMs: () => number }; advance: (ms: number) => void };

function makeClock(start = T0): TestClock {
  let now = start;
  return { clock: { nowMs: () => now }, advance: (ms): void => { now += ms; } };
}

type HostKnobs = {
  /** 前 N 次 `saveToDb` 抛(0 = 不抛)。 */
  failTimes: number;
  /** `addPlayer` 登记成 no-op(世界里没有这个人)。 */
  skipAdd: boolean;
  /** 前 N 次 `removePlayer` 抛(0 = 不抛)。 */
  throwRemoveTimes: number;
};

type HostProbe = {
  /** 每次**尝试**存档的注入时钟读数(成功与失败都记)。 */
  saveAttempts: number[];
  saved: number;
  removed: string[];
  bodies: Set<string>;
  knobs: HostKnobs;
  saveToDb: (db: unknown, roomId: string, nowMs: number)
    => { hpSaved: number; hpSkipped: number; memRow: number };
  addPlayer: (id: string, x: number, y: number) => void;
  removePlayer: (id: string) => boolean;
  playerPosition: (id: string) => { x: number; y: number; z: number } | null;
};

function makeHost(knobs: Partial<HostKnobs> = {}): HostProbe {
  const host: HostProbe = {
    saveAttempts: [],
    saved: 0,
    removed: [],
    bodies: new Set<string>(),
    knobs: {
      failTimes: knobs.failTimes ?? 0,
      skipAdd: knobs.skipAdd ?? false,
      throwRemoveTimes: knobs.throwRemoveTimes ?? 0,
    },
    saveToDb: (_db, _roomId, nowMs) => {
      host.saveAttempts.push(nowMs);
      if (host.knobs.failTimes > 0) {
        host.knobs.failTimes -= 1;
        throw new Error('注入:写库抛(模拟磁盘满)');
      }
      host.saved += 1;
      return { hpSaved: 0, hpSkipped: 0, memRow: 1 };
    },
    addPlayer: (id) => {
      if (host.knobs.skipAdd) return;
      host.bodies.add(id);
    },
    removePlayer: (id) => {
      if (host.knobs.throwRemoveTimes > 0) {
        host.knobs.throwRemoveTimes -= 1;
        throw new Error('注入:世界侧移除抛');
      }
      host.removed.push(id);
      host.bodies.delete(id);
      return true;
    },
    playerPosition: (id) => (host.bodies.has(id) ? { x: 0, y: 0, z: 0 } : null),
  };
  return host;
}

/** 干净的内存库(用户行齐了;房间行由 `RoomRuntime` 构造器自己建)。 */
function memoryDb(ids: readonly string[]): MemoryDb {
  const db = new MemoryDb();
  migrate(db, T0);
  for (const id of ids) createUser(db, { id, displayName: id, nowMs: T0 });
  return db;
}

type Fixture = {
  rt: RoomRuntime;
  host: HostProbe;
  clock: TestClock;
  db: MemoryDb;
  roomId: string;
};

function makeRoom(
  ctor: RtCtor,
  o: { tag: string; players?: number; hostKnobs?: Partial<HostKnobs> } = { tag: 'room' },
): Fixture {
  const roomId = freshId(o.tag);
  const players = o.players ?? 16;
  const ids = Array.from({ length: players }, (_v, i) => `p${i + 1}`);
  const db = memoryDb([OWNER, ...ids]);
  const clock = makeClock();
  const host = makeHost(o.hostKnobs);
  const rt = new ctor(
    {
      roomId,
      ownerId: OWNER,
      clock: clock.clock,
      maxPlayers: players,
      host: host as unknown as WorldSaveHost,
    },
    db,
  );
  return { rt, host, clock, db, roomId };
}

/* ═══════════════════ 1. 注入副本(顶层 await:模块级只加载一次)═══════════════════ */

/**
 * 把 `server/src/**` 的**真实源码**复制到 tmpdir,**拔掉指定的一行/一段**后再加载。
 *
 * 三件事缺一不可:
 * 1 锚点命中数必须**恰好 1**(改措辞/改缩进 ⇒ 注入无效,结论不许用);
 * 2 所有相对说明符改成 `file://` 绝对 URL(副本在仓外,相对路径会解析失败);
 * 3 用完即删(不落仓)。
 */
async function loadPatched(
  srcPath: string,
  patches: readonly { from: string; to: string }[],
  tag: string,
): Promise<Record<string, unknown>> {
  const raw = readFileSync(srcPath, 'utf8');
  const dir = dirname(srcPath);
  let patched = raw.replace(
    /(from\s+)'(\.{1,2}\/[^']+)'/g,
    (_m: string, pre: string, rel: string) => `${pre}'${pathToFileURL(resolve(dir, rel)).href}'`,
  );
  for (const p of patches) {
    const hits = patched.split(p.from).length - 1;
    if (hits !== 1) {
      throw new Error(`注入锚点「${p.from}」命中 ${hits} 次(必须恰好 1 次)⇒ 注入无效`);
    }
    patched = patched.replace(p.from, p.to);
  }
  const tmp = join(tmpdir(), `ws-fnd-160-${tag}-${process.pid}.ts`);
  writeFileSync(tmp, patched, 'utf8');
  try {
    return await import(pathToFileURL(tmp).href) as Record<string, unknown>;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/* 1 帧轨优先(修前形态):拔掉「只在还没成功存过时才走帧轨」那道约束。 */
const INJ_FRAME_TRACK = await loadPatched(ROOM_SRC, [{
  from: 'if (this.saveCount === 0 && tick % AUTOSAVE_FRAME_INTERVAL === 0) return \'frame\';',
  to: 'if (tick % AUTOSAVE_FRAME_INTERVAL === 0) return \'frame\';',
}], 'frametrack');
/* 2 世代两道闸都拆掉(待删 + 重进 ⇒ 刚体重进后又被删)。 */
const INJ_GENERATION = await loadPatched(ROOM_SRC, [
  { from: 'if (pendingBefore !== undefined) {', to: 'if (false) {' },
  { from: 'if (liveEpoch !== undefined && liveEpoch !== entry.epoch) {', to: 'if (false) {' },
], 'generation');
/* 3 只剩整房预算(修前形态:一个人能把 64 格吃光)。 */
const INJ_SHARED_BUDGET = await loadPatched(ROOM_SRC, [
  { from: 'if (mine >= this.perPlayerActionLimit) {', to: 'if (false) {' },
], 'sharedbudget');
/* 4 反作弊流水永远覆写全局最旧(修前形态:别人的证据被挤掉)。 */
const INJ_AC_GLOBAL_EVICT = await loadPatched(AC_SRC, [{
  from: 'if (mine >= this.perPlayerShare()) this.overwriteOldestOf(v.playerId, entry);',
  to: 'if (false) this.overwriteOldestOf(v.playerId, entry);',
}], 'acglobalevict');

const RT_FRAME_TRACK = INJ_FRAME_TRACK['RoomRuntime'] as unknown as RtCtor;
const RT_GENERATION = INJ_GENERATION['RoomRuntime'] as unknown as RtCtor;
const RT_SHARED_BUDGET = INJ_SHARED_BUDGET['RoomRuntime'] as unknown as RtCtor;
const AC_GLOBAL_EVICT = INJ_AC_GLOBAL_EVICT['AntiCheatRoom'] as unknown as typeof AntiCheatRoom;

/* ═══════════════════════════ 2. 判据本体 ═══════════════════════════ */

/** A:长跑一次存档节奏的读数。 */
type CadenceReading = {
  frames: number; elapsedMs: number; saves: number; times: number[]; minGapMs: number;
};

/**
 * 判据 A(自动存档节奏):**墙钟轨的量级** —— 存档次数不许超过「30s 一次」的上界,
 * 且任意相邻两次的间隔 ≥ 30s。
 *
 * 为什么把两个上界都写进来:`saves <= 墙钟上界` 抓「帧轨顶掉墙钟轨」,
 * `minGap >= 30s` 抓「某一帧被两个触发源各推一次」。
 */
function judgeCadence(r: CadenceReading): boolean {
  const wallClockCeiling = Math.floor(r.elapsedMs / AUTOSAVE_INTERVAL_MS) + 1;
  const frameTrackRate = Math.floor(r.frames / AUTOSAVE_FRAME_INTERVAL);
  return r.saves <= wallClockCeiling
    && r.saves * 3 < frameTrackRate
    && r.saves >= 1
    && r.minGapMs >= AUTOSAVE_INTERVAL_MS;
}

function measureCadence(ctor: RtCtor): CadenceReading {
  const f = makeRoom(ctor, { tag: 'cadence', players: 16 });
  for (let i = 1; i <= 16; i += 1) f.rt.join({ userId: `p${i}` });
  for (let i = 0; i < FRAMES; i += 1) {
    f.clock.advance(FRAME_MS);
    f.rt.step(null);
  }
  const times = f.host.saveAttempts.slice();
  let minGapMs = 0;
  if (times.length >= 2) {
    minGapMs = Number.POSITIVE_INFINITY;
    for (let i = 1; i < times.length; i += 1) {
      minGapMs = Math.min(minGapMs, (times[i] as number) - (times[i - 1] as number));
    }
  }
  return {
    frames: FRAMES,
    elapsedMs: FRAMES * FRAME_MS,
    saves: times.length,
    times,
    minGapMs,
  };
}

/** B(动作预算):同帧「一个人刷 + 邻居动一下」的读数。 */
type BudgetReading = {
  players: number; limit: number; playerLimit: number; used: number;
  neighborKind: string; throttledByShare: number; throttled: number;
};

/**
 * 判据 B(预算公平):一个人刷满自己的份之后,**邻居在同一帧仍然动作**
 * (邻居的 kind 不是 `THROTTLED`),且被拒确实记在「每玩家份额」这一档上。
 *
 * 反例(修前形态):整房共享 64 ⇒ 刷满之后邻居收到的也是 `THROTTLED`
 * —— 也就是「邻居什么都没干却被判超预算」。
 */
function judgeBudgetFairness(r: BudgetReading): boolean {
  return r.neighborKind !== 'THROTTLED'
    && r.throttledByShare > 0
    && r.used <= r.limit
    && r.playerLimit * r.players <= r.limit
    && r.playerLimit >= 1;
}

function measureBudget(ctor: RtCtor): BudgetReading {
  const f = makeRoom(ctor, { tag: 'budget', players: 16 });
  for (let i = 1; i <= 16; i += 1) f.rt.join({ userId: `p${i}` });
  /* p1 刷 100 条(**同一帧**,中间不 step)。动作本身越权(SET_ROOM_ACCESS 是管理动作),
     但预算闸在 handler 之前 —— 越权与「参数错」都不该成为免单理由。 */
  for (let i = 0; i < 100; i += 1) {
    f.rt.dispatchAction('p1', RoomAction.SET_ROOM_ACCESS, { mode: 'PUBLIC' });
  }
  /* 邻居:同一帧同一房间,只发一条。 */
  const neighbor = f.rt.dispatchAction('p2', RoomAction.SET_ROOM_ACCESS, { mode: 'PUBLIC' });
  const b = f.rt.actionBudgetState();
  return {
    players: 16,
    limit: b.limit,
    playerLimit: b.playerLimit,
    used: b.used,
    neighborKind: String(neighbor.kind),
    throttledByShare: f.rt.actionsThrottledByPlayerShare,
    throttled: f.rt.actionsThrottled,
  };
}

/** B(反作弊流水):刷分者灌水之后,别人的早期证据还在不在。 */
type EvidenceReading = {
  others: number; flooder: number; total: number; ordered: boolean;
};

/**
 * 判据 B(证据不被别人挤掉):7 名旁观者各 3 条**早期**证据,在刷分者 4000 条之后
 * 仍然一条不少;总长度仍 ≤ 512(有界口径不变)。
 */
function judgeEvidence(r: EvidenceReading): boolean {
  return r.others === 21 && r.total <= 512 && r.flooder >= 1 && r.flooder <= 512 && r.ordered;
}

function measureEvidence(ctor: typeof AntiCheatRoom): EvidenceReading {
  const ac = new ctor();
  const others = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
  const flooder = 'cheat';
  let tick = 0;
  for (const id of [...others, flooder]) ac.join(id, 0, 0, 0, 0);
  const jump = (id: string): void => {
    tick += 1;
    ac.tick(tick);
    ac.move({ playerId: id, tick, x: 5000, y: 0, z: 0 }, 3);
  };
  for (const id of others) for (let i = 0; i < 3; i += 1) jump(id);
  const beforeBurst = countOfPlayer(ac.violations(), others);
  for (let i = 0; i < 4000; i += 1) jump(flooder);

  const log = ac.violations();
  const afterBurst = countOfPlayer(log, others);
  let ordered = true;
  for (let i = 1; i < log.length; i += 1) {
    if ((log[i] as { tick: number }).tick < (log[i - 1] as { tick: number }).tick) ordered = false;
  }
  return {
    others: afterBurst === beforeBurst ? afterBurst : 0,
    flooder: log.filter((v) => v.playerId === flooder).length,
    total: log.length,
    ordered,
  };
}

function countOfPlayer(log: readonly { playerId: string }[], ids: readonly string[]): number {
  let n = 0;
  for (const v of log) if (ids.includes(v.playerId)) n += 1;
  return n;
}

/** B(待删 + 重进):重进之后那具刚体还在不在世界侧。 */
type RejoinReading = { conflicts: number; bodyRemoved: boolean; seated: boolean; pending: number };

/**
 * 判据 B(世代):重进之后 ——
 * ```text
 * 席位在(members) ∧ 世界侧刚体也在 ∧ 这次撞车留了证 ∧ 待删队列已清
 * ```
 * 修前:第三/四项恒 0,而世界侧刚体被删(`bodyRemoved === true`)。
 */
function judgeRejoin(r: RejoinReading): boolean {
  return r.seated && !r.bodyRemoved && r.conflicts >= 1 && r.pending === 0;
}

function measureRejoin(ctor: RtCtor): RejoinReading {
  const f = makeRoom(ctor, { tag: 'rejoin', players: 4, hostKnobs: { throwRemoveTimes: 2 } });
  f.rt.join({ userId: 'p1' });
  /* 离场:世界侧两次都抛 ⇒ 进待删队列(这一步两条实现相同)。 */
  f.rt.leave('p1');
  /* 下一帧之前重进(消息处理与 step 之间就是这个顺序)。 */
  f.rt.join({ userId: 'p1' });
  /* 下一帧:重试待删(修前:把刚重进的刚体删掉)。 */
  f.rt.step(null);
  return {
    conflicts: f.rt.removalConflicts.length,
    bodyRemoved: f.host.removed.includes('p1'),
    seated: f.rt.isSeated('p1'),
    pending: f.rt.retryPendingWorldRemovals().length,
  };
}

/* ═══════════════════════════ 3. A 组:长跑 ═══════════════════════════ */

test('FND160-1 量纲锚:墙钟轨 = 30 秒 / 帧节流 = 20 帧 / 整房预算 = 64 条', () => {
  /* 期望侧写字面量:常量**改了这条会红**,而不是跟着改。 */
  eq(AUTOSAVE_INTERVAL_MS, 30_000, '墙钟轨 30 秒(不是一个散落的数字)');
  eq(AUTOSAVE_FRAME_INTERVAL, 20, '帧节流 20 帧(= 20Hz 下的 1 秒)');
  eq(MAX_ACTIONS_PER_TICK, 64, '整房动作预算 64/帧');
  eq(Math.floor(64 / 16), 4, '16 人房的人均份额 = 4(判据里的算式在这里落一次地)');
});

test('FND160-2 ★★ A 长跑:640 帧里自动存档 2 次(不是每 20 帧一次)', () => {
  const real = measureCadence(RT);
  eq(real.saves, 2, `★ 实测:640 帧 / 32 秒内只存 2 次(冷启动 1 + 墙钟 1);实际 ${real.saves} 次`);
  eq(judgeCadence(real), true, '判据在真实读数上为真');

  /* ★ 注入:把「帧轨只在还没成功存过时成立」那道约束拔掉(修前的先判形态)。 */
  const injected = measureCadence(RT_FRAME_TRACK);
  eq(injected.saves, 32, `★ 注入(帧轨先判)⇒ 640 帧存 32 次(每 20 帧一次);实际 ${injected.saves}`);
  eq(judgeCadence(injected), false,
    '★★ 负对照:同一个判据在「每 20 帧一次」的读数上必须转假(否则判据没有牙)');
});

test('FND160-3 ★ 冷启动那一次仍在:第 20 帧落盘、报告 tick = 20', () => {
  /* 变红条件:把帧轨整条删掉 ⇒ 下面两条红(而 FND150-5 也会红)。
     这条的作用是钉住「帧轨**更慢**不更快」没有顺手把冷启动也砍了。 */
  const real = measureCadence(RT);
  eq(real.saves >= 1, true, '前置:至少有一次存档');
  const f = makeRoom(RT, { tag: 'coldstart', players: 2 });
  f.rt.join({ userId: 'p1' });
  for (let i = 0; i < AUTOSAVE_FRAME_INTERVAL; i += 1) f.rt.step(null);
  eq(f.rt.saveCount, 1, '空库的第 20 帧落了一次盘(冷启动垫底)');
  eq(f.rt.lastSaveReason, 'frame', '触发原因是 frame(不是 interval)');
  eq(f.rt.lastSaveReport?.tick, 20, '报告里的 tick 与落盘帧号同版(字面量 20)');
});

test('FND160-4 ★ 相邻两次存档的间隔 ≥ 30 秒(没有路径比墙钟轨更快)', () => {
  const real = measureCadence(RT);
  ok(real.times.length >= 2, `前置:至少两次存档(实际 ${real.times.length})`);
  ok(real.minGapMs >= AUTOSAVE_INTERVAL_MS,
    `★ 最小间隔 ${real.minGapMs}ms ≥ ${AUTOSAVE_INTERVAL_MS}ms`);
  /* 负对照:同一读数把「墙钟轨」改成 1 秒的假设下,间隔当然也不小于它 ——
     所以这条判据的真正牙口在**上一条**(次数),这里只钉间隔。 */
  eq((real.times[real.times.length - 1] as number) - (real.times[0] as number), 30_000,
    '★ 第二次存档落在第一次之后 **整 30 秒**(不是 2s / 3s 那种帧轨节奏)');
});

test('FND160-5 ★★ A 长跑:写库一直失败 ⇒ 尝试次数按**帧指数**退避(不是每帧重试)', () => {
  const f = makeRoom(RT, {
    tag: 'backoff', players: 8, hostKnobs: { failTimes: 10_000 },
  });
  for (let i = 1; i <= 8; i += 1) f.rt.join({ userId: `p${i}` });
  for (let i = 0; i < FRAMES; i += 1) {
    f.clock.advance(FRAME_MS);
    f.rt.step(null);
  }
  const attempts = f.host.saveAttempts.length;
  ok(attempts >= 2, `★ 至少试过两次(退避不是「一次就永久放弃」);实际 ${attempts}`);
  ok(attempts <= 12, `★★ 640 帧里尝试 ≤ 12 次(每 20 帧重试会是 32 次);实际 ${attempts}`);
  ok(f.rt.autosaveState().backoffFrames >= AUTOSAVE_FRAME_INTERVAL,
    `★ 退避窗真的在长(实际 ${f.rt.autosaveState().backoffFrames} 帧)`);
  eq(f.rt.saveCount, 0, '成功计数仍是 0(失败不算成功)');
  ok(f.rt.saveErrors.length > 1, '★ 失败台账留了多份(单槽修前只剩最后一份)');
});

test('FND160-6 ★ 退避:失败两次后成功 ⇒ 窗口归零、计数只 +1', () => {
  const f = makeRoom(RT, { tag: 'backoffreset', players: 2, hostKnobs: { failTimes: 2 } });
  f.rt.join({ userId: 'p1' });
  for (let i = 0; i < FRAMES; i += 1) {
    f.clock.advance(FRAME_MS);
    f.rt.step(null);
  }
  ok(f.rt.saveFailCount >= 2, `前置:失败过两次(实际 ${f.rt.saveFailCount})`);
  ok(f.rt.saveCount >= 1, '★ 之后成功存过(退避没有变成永久放弃)');
  eq(f.rt.autosaveState().backoffFrames, 0, '★★ 成功一次 ⇒ 退避窗口归零');
  eq(f.rt.lastSaveError, null, '成功之后错因字段被清(不撒谎说还错着)');
});

test('FND160-7 ★ 在途闸:宿主回调里重入 saveWorldNow ⇒ 返回 false 且计数只 +1', () => {
  const f = makeRoom(RT, { tag: 'inflight', players: 2 });
  f.rt.join({ userId: 'p1' });
  let inner: boolean | null = null;
  let inFlightSeen = false;
  const host = f.rt.worldSaveHost as unknown as HostProbe;
  const real = host.saveToDb;
  /* 宿主在写库**过程中**回头再存一次(重入 / 两个触发源互相插队)。 */
  host.saveToDb = (db, roomId, nowMs) => {
    inFlightSeen = f.rt.autosaveState().inFlight;
    inner = f.rt.saveWorldNow('manual');
    return real(db, roomId, nowMs);
  };
  const outer = f.rt.saveWorldNow('manual');
  eq(outer, true, '外层那次成功');
  eq(inner, false, '★★ 重入那次被在途闸拒掉(不许两次写同一份档)');
  eq(inFlightSeen, true, '★ 写库期间 `autosaveState().inFlight === true`(标志真的立过)');
  eq(f.rt.saveCount, 1, '成功计数只 +1(重入没有把两次写当成两次存档)');
  eq(f.rt.autosaveState().inFlight, false, '收尾后标志落回 false');
});

/* ═══════════════════════════ 4. B 组:并发 ═══════════════════════════ */

test('FND160-8 ★★ B 并发:8 人入场 ⇒ 审计台账 8 条(不是只剩最后一份)', () => {
  const f = makeRoom(RT, { tag: 'joins', players: 8 });
  for (let i = 1; i <= 8; i += 1) f.rt.join({ userId: `p${i}` });
  eq(f.rt.joinAudits.length, 8, '★ 8 个人各一条(单槽修前 = 1)');
  const seen = new Set(f.rt.joinAudits.map((a) => a.userId));
  eq(seen.size, 8, '★ 8 条覆盖 8 个不同的 userId(不是同一个人重复记 8 次)');
  for (const a of f.rt.joinAudits) {
    eq([a.members, a.state, a.world], [true, true, 'ok'], `入场三方校验:${a.userId}`);
  }
  eq(f.rt.lastJoinAudit?.userId, 'p8', '单槽读口仍指向**最后**那一条(兼容旧读法)');
});

test('FND160-9 ★★ B 并发:重进之后 step() 不许再删刚体(待删带世代)', () => {
  const real = measureRejoin(RT);
  eq(real.seated, true, '★ 重进之后席位在');
  eq(real.bodyRemoved, false, '★★ 世界侧刚体**没被**上一轮的待删重试删掉');
  eq(real.conflicts, 1, '★ 撞车留了一条证据(`removalConflicts`)');
  eq(real.pending, 0, '待删队列已清(不会在下一帧再来一次)');
  eq(judgeRejoin(real), true, '判据在真实读数上为真');

  const injected = measureRejoin(RT_GENERATION);
  eq(injected.bodyRemoved, true,
    '★★ 负对照(注入:两道世代闸都拆掉)⇒ 重进后 step() 真的把刚体删了');
  eq(injected.conflicts, 0, '★ 且一条证据都没有(修前形态)');
  eq(judgeRejoin(injected), false, '★★ 同一个判据在修前形态上必须转假');
});

test('FND160-10 ★ B:「房里有他 / 世界没他」可观测(worldMismatch)', () => {
  /* 场景:世界侧登记是 no-op(宿主没这个人)+ 移除一直抛 ⇒ 待删 + 重进撞车。
     修前这种态**一个字段都没有**;现在 `removalConflicts[].worldMismatch` 直接说
     「房间侧认他、世界侧查不到」。 */
  const f = makeRoom(RT, {
    tag: 'mismatch', players: 4, hostKnobs: { skipAdd: true, throwRemoveTimes: 2 },
  });
  f.rt.join({ userId: 'p1' });
  f.rt.leave('p1');
  f.rt.join({ userId: 'p1' });
  const c = f.rt.removalConflicts[0];
  ok(c !== undefined, '撞车必须留证');
  eq(c?.worldMismatch, true, '★ worldMismatch = true(世界侧确实没有他)');
  eq(c?.kind, 'rejoined', '证上写明是「重进」这一类(不是「世代过期」)');
  /* 负对照:宿主真的登记时,同一字段必须是 false(否则它只是恒真)。 */
  const g = makeRoom(RT, { tag: 'mismatchok', players: 4, hostKnobs: { throwRemoveTimes: 2 } });
  g.rt.join({ userId: 'p2' });
  g.rt.leave('p2');
  g.rt.join({ userId: 'p2' });
  eq(g.rt.removalConflicts[0]?.worldMismatch, false, '★ 负对照:世界侧有他 ⇒ false');
});

test('FND160-11 ★★ B 并发:一个人刷满自己的份额,p2 同帧照常动作', () => {
  const real = measureBudget(RT);
  eq(real.limit, 64, '整房预算仍是 64/帧(口径没被放宽)');
  eq(real.playerLimit, 4, `★ 16 人房的人均份额 = 4;实际 ${real.playerLimit}`);
  eq(real.throttledByShare, 96, `★ p1 的 96 条被「每玩家份额」这一档拒掉;实际 ${real.throttledByShare}`);
  eq(real.neighborKind, 'PERMISSION',
    '★★ 邻居那条走的是**权限**闸(越过权了),而不是被预算拒 —— 他没被邻居牵连');
  eq(real.used, 5, '本帧执行数 = 4(p1 份额)+ 1(邻居)');
  eq(judgeBudgetFairness(real), true, '判据在真实读数上为真');

  const injected = measureBudget(RT_SHARED_BUDGET);
  eq(injected.neighborKind, 'THROTTLED',
    '★★ 负对照(注入:只剩整房预算)⇒ 邻居同帧被拒(修前形态)');
  eq(judgeBudgetFairness(injected), false, '★★ 同一个判据在修前形态上必须转假');
});

test('FND160-12 ★ B:未注册动作(垃圾报文)不吃预算', () => {
  const f = makeRoom(RT, { tag: 'garbage', players: 4 });
  f.rt.join({ userId: 'p1' });
  f.rt.join({ userId: 'p2' });
  /* 查表**先于**扣格 ⇒ 30 条「报文里不存在的动作名」只花 30 次 Map 查找。 */
  for (let i = 0; i < 30; i += 1) {
    const out = f.rt.dispatchAction('p1', 'NO_SUCH_ACTION_NAME' as RoomAction);
    eq(out.kind, 'NOT_IMPLEMENTED', '未登记 ⇒ 显式 NOT_IMPLEMENTED(既有契约不变)');
  }
  eq(f.rt.actionBudgetState().used, 0, '★ 本帧预算一格没花(修前这 30 条会吃掉 30 格)');
  eq(f.rt.actionsDispatched, 0, '执行计数也没动(没跑任何处理器)');
  /* 负对照:同一个「未注册」动作换成**已注册**的,同一帧立刻吃格。 */
  f.rt.dispatchAction('p2', RoomAction.SET_ROOM_ACCESS, { mode: 'PUBLIC' });
  eq(f.rt.actionBudgetState().used, 1, '★ 负对照:已注册动作**照常**扣格(不是把预算闸关了)');
});

test('FND160-13 ★★ B 并发:刷分者 4000 条之后,别人的 21 条证据仍在', () => {
  const real = measureEvidence(AntiCheatRoom);
  eq(real.others, 21, `★★ 7 人各 3 条早期证据全在;实际 ${real.others}`);
  eq(real.total <= 512, true, `★ 总长仍有界(${real.total} ≤ 512)`);
  ok(real.flooder >= 1 && real.flooder <= 512,
    `★ 刷分者自己也留了证据,但被份额挡住(${real.flooder} 条)`);
  eq(real.ordered, true, '★ 读侧仍「最早在前」(就地覆写没有把顺序打乱)');
  eq(judgeEvidence(real), true, '判据在真实读数上为真');

  const injected = measureEvidence(AC_GLOBAL_EVICT);
  eq(injected.others, 0, '★★ 负对照(注入:永远覆写全局最旧)⇒ 别人的 21 条全被挤没');
  eq(judgeEvidence(injected), false, '★★ 同一个判据在修前形态上必须转假');
});

test('FND160-14 ★「离场清空账、非空账留着」+ 销毁清模块级侧账', () => {
  const f = makeRoom(RT, { tag: 'ledger', players: 4 });
  /* 1 有东西的人退房:账**不许**被清(退房不吞玩家的东西 —— 既有判据 FND155-4)。 */
  f.rt.join({ userId: 'p1' });
  eq(f.rt.authoritativeItemTotal('p1'), 7, '前置:起始背包 7 件');
  f.rt.leave('p1');
  eq(f.rt.authoritativeItemTotal('p1'), 7, '★★ 退房不背包账:7 件还在');
  eq(f.rt.ledgerPrunes, 0, '★ 非空账没有被摘掉(负对照:清账≠清全部)');

  /* 2 空账的人退房:那一把钥匙要被摘掉(长跑房不再「每个进过房的 id 一条」)。 */
  f.rt.join({ userId: 'p2' });
  const drained = f.rt.applyInventory('p2', {
    ops: [
      { itemId: 101, delta: -2 },
      { itemId: 106, delta: -2 },
      { itemId: 118, delta: -2 },
      { itemId: 201, delta: -1 },
    ],
  });
  eq(drained.allowed, true, '前置:把 7 件消耗光(合法扣减)');
  eq(f.rt.authoritativeItemTotal('p2'), 0, '前置:账变 0');
  f.rt.leave('p2');
  eq(f.rt.ledgerPrunes, 1, '★ 空账在离场时被摘掉(并计数)');

  /* 3 销毁 ⇒ 模块级侧账按 roomId 清(修前只有 RESET_WORLD 清)。 */
  const colyseus = makeColyseusRoom();
  const petRecord = createPetRecord('mob_sheep');
  ok(petRecord !== null, '前置:绵羊有宠物记录');
  putPetSlot(colyseus.roomId, {
    petId: 'pet_1', ownerId: 'p1', bond: 1, record: petRecord as NonNullable<typeof petRecord>,
  });
  putPetSlot('r160_other_room', {
    petId: 'pet_2', ownerId: 'p1', bond: 1, record: petRecord as NonNullable<typeof petRecord>,
  });
  eq(tamedPetsOfRoom(colyseus.roomId).length, 1, '前置:本房间有 1 只有主宠物');
  colyseus.room.onDispose();
  eq(tamedPetsOfRoom(colyseus.roomId).length, 0, '★★ 销毁 ⇒ 本房间的宠物账被清(修前没人清)');
  eq(tamedPetsOfRoom('r160_other_room').length, 1, '★ 负对照:别的房间不受影响(只删本房的键)');
  eq(colyseus.room.runtime.status, 'CLOSED', '销毁路径照旧把房间状态收掉');
});

test('FND160-15 ★ 源码级:`onDispose` 真的调三本侧账的回收口(注入拆掉 ⇒ 判据转假)', () => {
  const src = readFileSync(COLYSEUS_SRC, 'utf8');
  eq(countForgetCallsInOnDispose(src), 3, '★ onDispose 窗口里 forgetChests / forgetPlacements / forgetRoom 各一次');
  /* 注入:**只分析文本**(删掉那三行)⇒ 判据必须转假 —— 证明它读的是真代码,不是硬编码的 3。 */
  const patched = src
    .replace('    forgetChests(this.runtime.id);\n', '')
    .replace('    forgetPlacements(this.runtime.id);\n', '')
    .replace('    forgetRoom(this.runtime.id);\n', '');
  ok(patched !== src, '前置:注入真的改到了源码(三行都在)');
  eq(countForgetCallsInOnDispose(patched), 0, '★★ 注入(删掉三行)⇒ 判据读到 0(有牙)');
});

/** `onDispose` 方法窗口里三个回收口的调用次数(扫描器:只认**调用**,不认注释)。 */
function countForgetCallsInOnDispose(src: string): number {
  const start = src.indexOf('override onDispose(): void {');
  if (start < 0) return -1;
  const end = src.indexOf('\n  }', start);
  if (end < 0) return -1;
  const body = src.slice(start, end);
  let n = 0;
  for (const fn of ['forgetChests', 'forgetPlacements', 'forgetRoom']) {
    if (new RegExp(`^\\s*${fn}\\(this\\.runtime\\.id\\);`, 'm').test(body)) n += 1;
  }
  return n;
}

/* ══════════════ 5. 真 Colyseus 房间(只为本套件的销毁路径)══════════════ */

type RoomInternals = {
  runtime: RoomRuntime;
  onDispose: () => void;
  onCreate: (o: Record<string, unknown>) => void;
  setState: (s: unknown) => void;
  setSimulationInterval: (fn?: () => void, ms?: number) => void;
  onMessage: (t: string, cb: (c: unknown, m: Record<string, unknown>) => void) => void;
};

/**
 * 真 `NetPersistRoom` 跑一次 `onCreate()`,只把定时器副作用换掉
 * (手法与 `WS-FND-131` 的 `makeRoom` 同源:不起 patch 定时器、不起 20Hz 定时器)。
 */
function makeColyseusRoom(): { room: RoomInternals; roomId: string } {
  const roomId = freshId('dispose');
  const clock = makeClock();
  const host = makeHost();
  const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
  const realPatch = proto['setPatchRate'];
  proto['setPatchRate'] = function stubSetPatchRate(): void { /* 不建定时器 */ };
  const raw = new NetPersistRoom();
  proto['setPatchRate'] = realPatch;

  const room = raw as unknown as RoomInternals & { autoDispose: boolean };
  room.autoDispose = false;
  room.onMessage = (): void => { /* 本套件不发报文 */ };
  room.setState = (): void => { /* Schema 不是本套件的判据 */ };
  room.setSimulationInterval = (): void => { /* 不起 20Hz */ };
  (raw as unknown as { withDeps: (d: unknown) => void }).withDeps({
    ownerId: OWNER,
    clock: clock.clock,
    db: null,
    host: host as unknown as WorldSaveHost,
  });
  room.onCreate({ roomId, maxPlayers: 4 });
  return { room, roomId };
}

report('WS-FND-160');