/**
 * WS-FND-158 —— **活性能计数器的每帧预算**(防回归判据)。
 *
 * ## 修的是什么(第九轮留下的欠账)
 *
 * 第九轮把五处「每帧重造」改成复用,并留下**活计数器**(`encodePerf.linearIdLookups`
 * / `WorldSim.syncPlayerObjectAllocs` / `spritePlanSpecAllocs` / 反作弊环形缓冲的
 * 留存长度与丢弃数)。但那些数字当时**只是数字**:
 * ```text
 * · 没有任何东西**阻止**将来把 O(n) 改回 O(n2):改回去只让一个套件红,
 *   而本仓「唯一的完成定义」是 `node scripts/verify.ts` 全绿 ⇒ 门禁口径里看不出差别;
 * · WS-FND-137 判的是「某次调用恰好涨了几个」,不是「**每帧最多**涨几个」
 *   ⇒ 抓不住「同一帧多扫/多建一遍」这类回归 —— 那正是性能回归的常见形态。
 * ```
 *
 * ## 结构(预算与判据**只有一份实现**)
 * ```text
 * scripts/verify.ts   预算常量(具名)+ 合成夹具 + 8 条判据 + 命门自检 —— 进程内接进门禁
 * 本套件            每条判据**一条正例 + 一条反例**,并证明「改预算常量立即反映」
 * ```
 * ⇒ 本套件**import** `judgePerfSample` / `PERF_BUDGET` / 夹具,**不复制**判据 ——
 *   否则「预算」与「判据」会各自漂移(本仓反复踩过的两份实现)。
 *
 * ## 反例的纪律(与 WS-FND-137 同一套)
 * ```text
 * 1 反例的读数必须**来自真实代码路径**,不许手写一个「超预算的 counters 对象」:
 *   C1 落地侧的线性查找 / C2 名册全换血的一帧 / C3 每帧两遍非复用计划 —— 都是真跑出来的;
 *   C4/C5 更狠:把环形容量上界**真的拔掉**(改一份真实副本再加载)再灌 700 条。
 * 2 期望值写字面量,不在期望槽位引用本仓常量(否则上游一改就跟着过)。
 * 3 「改预算常量立即反映」必须用**同一次真实读数** + 改过的常量再判一遍来证明。
 * ```
 *
 * ⚠️ **已知边界(不假装有牙)**:判据 C6(单玩家违规窗口)的实现在 `record()` 里
 * 用 `shift()` 有界,不存在「真实超容读数」这一形态 ⇒ 该条的命门只能是
 * 「常量收紧即转假」,**没有**真实反例。这条边界写在这里,而不是留给人猜。
 *
 * 运行:`node tests/WS-FND-158-perf-budget.test.ts`
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PERF_BUDGET,
  PERF_BUDGET_AC_DROPS_EXCESS,
  PERF_BUDGET_AC_KEEP_PER_PLAYER,
  PERF_BUDGET_AC_RING_LENGTH,
  PERF_BUDGET_DELTA_LINEAR_ID_LOOKUPS_PER_FRAME,
  PERF_BUDGET_SPRITE_ALLOCS_PER_ENTITY_FRAME,
  PERF_BUDGET_SYNC_ALLOCS_PER_PLAYER_FRAME,
  judgePerfSample,
  measurePerfFixture,
  perfBudgetTeeth,
  perfRoomState,
  perfSpriteSource,
  runPerfBudgetCheck,
  type PerfCriterionRow,
  type PerfSample,
} from '../scripts/verify.ts';
import {
  applyPacket, decodePacket, encodeDelta, encodePerf, resetEncodePerf,
} from '../shared/net/delta.ts';
import { cloneRoomState } from '../server/src/net/schema.ts';
import { AntiCheatRoom } from '../server/src/net/anticheat.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import {
  planEntitySpritesInto, resetSpritePlanCounters, spritePlanSpecAllocs,
  type EntitySpriteSpec,
} from '../client/src/stage/entity_sprites.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* 判据 id(与 `judgePerfSample` 的行一一对应;改名 ⇒ 下面的 rowOf 会当场抛错)。 */
const C1 = 'C1 delta.linearIdLookups/帧';
const C2 = 'C2 syncPlayerObjectAllocs/帧';
const C3 = 'C3 spritePlanSpecAllocs/帧';
const C4 = 'C4 反作弊环形缓冲留存长度';
const C5 = 'C5 droppedViolations 只反映有界策略';
const C6 = 'C6 单玩家违规窗口长度';
const C7 = 'C7 环形容量与预算常量同步';
const C8 = 'C8 单玩家窗口容量与预算常量同步';

/** 取一条判据的结论(取不到就是判据表被改名了 ⇒ 本套件失去区分力,必须当场红)。 */
function rowOf(rows: readonly PerfCriterionRow[], id: string): PerfCriterionRow {
  const r = rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`判据 ${id} 不在结论里(判据表被改名?)`);
  return r;
}

/** 判据结论的「是否在预算内」的可读摘要(失败信息里点名是哪条)。 */
function badRows(rows: readonly PerfCriterionRow[]): string {
  return rows.filter((r) => !r.ok).map((r) => `${r.id}:实测 ${r.measured} / 预算 ${r.budget}`).join(';');
}

/* ═══════════ 真实超预算读数(反例素材;全部先量出来,再交给同一份判据)═══════════ */

/** 反例 C1:收包并**落地** ⇒ 落地侧的线性查找被顶上去(生产路径真实计数点)。 */
function landingLinearLookups(): number {
  const prev = perfRoomState();
  const next = cloneRoomState(prev);
  next.players[0].x += 1;
  resetEncodePerf();
  const pkt = decodePacket(encodeDelta(prev, next, 4242).bytes);
  applyPacket(prev, pkt);
  return encodePerf.linearIdLookups;
}

/** 反例 C2:名册**全换血**的一帧(remove 20 / add 20 新 id)⇒ 该帧重建整份投影。 */
function churnSyncAllocs(): number {
  const sim = new WorldSim({ sizeCells: 64, mobs: false });
  for (let i = 0; i < 20; i += 1) sim.addPlayer(`p${i}`, 1 + i, 2);
  sim.tick();
  const before = sim.syncPlayerObjectAllocs;
  for (let i = 0; i < 20; i += 1) sim.removePlayer(`p${i}`);
  for (let i = 0; i < 20; i += 1) sim.addPlayer(`n${i}`, 3 + i, 5);
  sim.tick();
  return sim.syncPlayerObjectAllocs - before;
}

/** 反例 C3:每帧两遍计划、且每遍都传**新数组**(完全不复用槽)。 */
function twoPlansPerFrameAllocs(frames: number): number {
  const src = perfSpriteSource();
  resetSpritePlanCounters();
  for (let f = 0; f < frames; f += 1) {
    planEntitySpritesInto([], src, 'p0');
    planEntitySpritesInto([], src, 'p0');
  }
  return spritePlanSpecAllocs;
}

/** 反例 C4/C5 的载体:一次**真实**灌水(拔掉容量上界的那份副本)的读数。 */
interface FloodReading {
  writes: number;
  retained: number;
  dropped: number;
  /** 注入无效/加载失败时的原因(`null` = 注入有效)。 */
  error: string | null;
}

const AC_SRC_PATH = join(ROOT, 'server/src/net/anticheat.ts');
/** 容量上界的**唯一**锚点(命中数必须恰好 1 —— 否则注入无效,结论不许用)。 */
const AC_BOUND_ANCHOR = 'if (this.log.length < VIOLATION_LOG_CAPACITY) {';
/** 副本要改写的唯一相对说明符(副本在仓外,相对路径会解析失败)。 */
const AC_PHYSICS_SPEC = '../../../shared/types/physics.ts';
const FLOOD_WRITES = 700;

type AntiCheatModule = typeof import('../server/src/net/anticheat.ts');

/**
 * 拔掉容量上界后灌 `FLOOD_WRITES` 条:这是**有界策略被移除**时该计数器的真实读数。
 *
 * 为什么必须用「真副本」而不是手写一个 counters 对象:
 * → 手写对象证明不了「判据咬得住」,它只证明「判据能读到数字」。
 * ⚠️ 副本写在 `tmpdir()` 里、用完即删(不落仓);锚点命中数不等于 1 ⇒ 报错而不是静默继续。
 */
async function runInjectedFlood(): Promise<FloodReading> {
  const empty: FloodReading = { writes: 0, retained: 0, dropped: 0, error: null };
  const raw = readFileSync(AC_SRC_PATH, 'utf8');
  const hits = raw.split(AC_BOUND_ANCHOR).length - 1;
  if (hits !== 1) return { ...empty, error: `容量锚点命中 ${hits} 次(必须恰好 1 次)⇒ 注入无效` };
  const patched = raw
    .replace(AC_BOUND_ANCHOR, 'if (true) {')
    .replace(`'${AC_PHYSICS_SPEC}'`, JSON.stringify(pathToFileURL(join(ROOT, 'shared/types/physics.ts')).href));
  if (patched === raw) return { ...empty, error: '替换后内容未变化 ⇒ 注入无效' };

  const tmp = join(tmpdir(), `ws-fnd-158-anticheat-unbounded-${process.pid}.ts`);
  try {
    writeFileSync(tmp, patched, 'utf8');
    const mod = await import(pathToFileURL(tmp).href) as AntiCheatModule;
    const room = new mod.AntiCheatRoom();
    let writes = 0;
    for (let i = 0; i < FLOOD_WRITES; i += 1) {
      const id = `unbounded_${i}`;
      room.join(id, 0, 0, 0, 0);
      room.move({ playerId: id, tick: 1, x: 5000, y: 0, z: 0 }, 3);
      writes += room.get(id)!.violations.length;
    }
    return { writes, retained: room.violations().length, dropped: room.droppedViolations, error: null };
  } catch (e) {
    return { ...empty, error: `注入副本加载/灌水失败:${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(tmp, { force: true });
  }
}

const INJECTED: FloodReading = await runInjectedFlood();

/* ═════════════════════════ 1. 正例 ═════════════════════════ */

test('FND158-1 正例:合成夹具(20 玩家 × 200 实体)的读数逐条在预算内', () => {
  const s = measurePerfFixture();
  const rows = judgePerfSample(s);
  eq(rows.length, 8, '判据 8 条');
  eq(badRows(rows), '', '不允许有超预算判据 —— 每帧预算必须真的被守住');

  /* 实测值逐条写下(字面量 —— 不在期望槽位引用本仓常量)。 */
  eq(s.players, 20, '夹具:玩家 20');
  eq(s.entities, 220, '夹具:实体 220(20 玩家 + 200 生物)');
  eq(s.frames, 8, '夹具:窗口 8 帧');
  eq(s.deltaLinearIdLookups, 0, 'delta 编码侧线性查找 = 0(结构式)');
  eq(s.syncPlayerObjectAllocs, 0, '名册不变的稳态帧:投影零分配');
  eq(s.spritePlanSpecAllocs, 0, '复用槽的稳态帧:立牌槽零新建');
  eq(s.violationWrites, 700, '反作弊灌水 700 条');
  eq(s.violationRetained, 512, '留存被截到 512');
  eq(s.violationDropped, 188, '丢弃 188 条(700 − 512)');
  eq(s.violationPerPlayerMax, 256, '单玩家窗口 256');

  /* 每帧口径:窗口累计值 ÷ 帧数(判据用的就是这个)。 */
  ok(rowOf(rows, C2).budget.includes('20'), 'C2 的预算是「1 × 玩家数」= 20');
  ok(rowOf(rows, C3).budget.includes('220'), 'C3 的预算是「1 × 实体数」= 220');
});

test('FND158-2 ★ 反例(真实读数):落地侧 linearIdLookups > 0 ⇒ C1 转假', () => {
  const landing = landingLinearLookups();
  ok(landing > 0, `前置:落地一包必须让计数器动(实际 ${landing})—— 否则「编码侧 0 次」是死字段`);

  const base = measurePerfFixture();
  const rows = judgePerfSample({ ...base, deltaLinearIdLookups: landing });
  eq(rowOf(rows, C1).ok, false,
    `★ 落地侧的线性查找必须被判超预算(实测 ${landing} 次 / 预算每帧 0)`);
  /* 其余判据不受影响(这条反例只动一个计数器)。 */
  eq(rows.filter((r) => !r.ok).length, 1, '只应有 C1 一条转假');
});

test('FND158-3 ★ 反例(真实读数):名册全换血的一帧 ⇒ 每帧分配 > 玩家数 ⇒ C2 转假', () => {
  const churn = churnSyncAllocs();
  ok(churn > 20, `前置:全换血的一帧分配 ${churn} 个,必须 > 玩家数 20(否则反例不成立)`);

  const base = measurePerfFixture();
  /* 该帧确实贵:窗口按 1 帧算,分配 40 个 > 预算 20。 */
  const rows = judgePerfSample({ ...base, frames: 1, syncPlayerObjectAllocs: churn });
  eq(rowOf(rows, C2).ok, false,
    `★ 整帧重建投影必须被判超预算(实测每帧 ${churn} / 预算每玩家 1 × 20)`);
  eq(rows.filter((r) => !r.ok).length, 1, '只应有 C2 一条转假');
});

test('FND158-4 ★ 反例(真实读数):每帧两遍非复用计划 ⇒ 每帧分配 > 实体数 ⇒ C3 转假', () => {
  const base = measurePerfFixture();
  const two = twoPlansPerFrameAllocs(base.frames);
  const perFrame = two / base.frames;
  ok(perFrame > base.entities,
    `前置:每帧分配 ${perFrame} 个槽,必须 > 实体数 ${base.entities}(否则反例不成立)`);

  const rows = judgePerfSample({ ...base, spritePlanSpecAllocs: two });
  eq(rowOf(rows, C3).ok, false,
    `★ 每帧重建立牌计划必须被判超预算(实测每帧 ${perFrame} / 预算每实体 1 × ${base.entities})`);
  eq(rows.filter((r) => !r.ok).length, 1, '只应有 C3 一条转假');
});

/* ═════════════════ 2. 注入:拔掉容量上界(真实副本)═════════════════ */

test('FND158-5 ★ 反例(注入):拔掉环形容量上界 ⇒ 留存 700 > 512 ⇒ C4 转假', () => {
  eq(INJECTED.error, null, `注入必须有效(${INJECTED.error ?? 'ok'})—— 无效注入不许被当成「没红」`);
  eq(INJECTED.writes, 700, '注入副本里写入仍是 700 条(灌水口径未变)');
  eq(INJECTED.retained, 700, '★ 无界版本把 700 条**全部**留在流水里(真实读数)');
  eq(INJECTED.dropped, 0, '★ 且一条都没丢(容量上界被拔掉了)');

  const base = measurePerfFixture();
  const rows = judgePerfSample({
    ...base,
    violationWrites: INJECTED.writes,
    violationRetained: INJECTED.retained,
    violationDropped: INJECTED.dropped,
  });
  eq(rowOf(rows, C4).ok, false,
    `★ 无界留存必须被判超容(实测留存 ${INJECTED.retained} / 预算 ${PERF_BUDGET_AC_RING_LENGTH})`);
});

test('FND158-6 ★ 反例(注入,同一读数):丢弃 0 ≠ 有界策略的 188 ⇒ C5 转假', () => {
  const base = measurePerfFixture();
  const rows = judgePerfSample({
    ...base,
    violationWrites: INJECTED.writes,
    violationRetained: INJECTED.retained,
    violationDropped: INJECTED.dropped,
  });
  eq(rowOf(rows, C5).ok, false,
    '★ 丢弃数必须有界策略解释:0 ≠ 700 − 512 ⇒ 判据必须转假');
  ok(rowOf(rows, C5).budget.includes(String(PERF_BUDGET_AC_RING_LENGTH)),
    'C5 的依据里必须写出容量(读者不必去翻常量)');

  /* ★ 对照:同一次超容读数,只要把**丢弃余量**常量放宽 ⇒ 判据变绿。
     这证明「常量真的是旋钮」,也说明 C5 守的正是「丢弃数必须恰好反映有界策略」。 */
  const loose = judgePerfSample(
    {
      ...base,
      violationWrites: INJECTED.writes,
      violationRetained: INJECTED.retained,
      violationDropped: INJECTED.dropped,
    },
    { ...PERF_BUDGET, acDropsExcess: 999 },
  );
  eq(rowOf(loose, C5).ok, true, '把余量常量放宽到 999 ⇒ 同一次读数变绿(结论由常量决定)');
});

/* ═════════════ 3. 容量同步正例 + 改预算常量立即反映 ═════════════ */

test('FND158-7 正例 C6/C7/C8:单玩家窗口在预算内,且预算常量与实现容量相同', () => {
  const s = measurePerfFixture();
  const rows = judgePerfSample(s);
  eq(rowOf(rows, C6).ok, true, '单玩家窗口 256 ≤ 预算 256');
  eq(rowOf(rows, C7).ok, true, '环形容量:实现常量 === 预算常量');
  eq(rowOf(rows, C8).ok, true, '单玩家窗口容量:实现常量 === 预算常量');

  /* 其中 C7/C8 是「实现一改容量、预算没跟就红」的那道闸:把预算常量改掉 ⇒ 当场转假。 */
  const drifted = judgePerfSample(s, { ...PERF_BUDGET, acRingLength: PERF_BUDGET_AC_RING_LENGTH - 1 });
  eq(rowOf(drifted, C7).ok, false, '★ 预算常量与实现容量不一致 ⇒ C7 转假(防两处口径漂移)');
});

test('FND158-8 ★ 改预算常量立即反映:同一次真实读数,只看常量怎么改', () => {
  const base = measurePerfFixture();
  const landing = landingLinearLookups();
  const churn = churnSyncAllocs();
  const two = twoPlansPerFrameAllocs(base.frames);
  const landingSample: PerfSample = { ...base, deltaLinearIdLookups: 0 };
  const overDelta: PerfSample = { ...base, deltaLinearIdLookups: landing };
  const overSync: PerfSample = { ...base, frames: 1, syncPlayerObjectAllocs: churn };
  const overSprite: PerfSample = { ...base, spritePlanSpecAllocs: two };
  const overRing: PerfSample = {
    ...base,
    violationWrites: INJECTED.writes,
    violationRetained: INJECTED.retained,
    violationDropped: INJECTED.dropped,
  };

  /* 每一行都是「同一次真实读数 + 改一个常量」⇒ 结论必须跟着常量走。 */
  const cases = [
    { what: 'C1 上限 0 → 实测值(松开)', sample: overDelta, patch: { deltaLinearIdLookupsPerFrame: landing / base.frames }, id: C1, want: true },
    { what: 'C2 每玩家 1 → 2(松开)', sample: overSync, patch: { syncAllocsPerPlayerFrame: 2 }, id: C2, want: true },
    { what: 'C3 每实体 1 → 2(松开)', sample: overSprite, patch: { spriteAllocsPerEntityFrame: 2 }, id: C3, want: true },
    { what: 'C4 容量 512 → 256(收紧)', sample: base, patch: { acRingLength: 256 }, id: C4, want: false },
    { what: 'C6 单玩家窗口 256 → 255(收紧)', sample: base, patch: { acKeepPerPlayer: 255 }, id: C6, want: false },
    { what: 'C5 余量 0 → 999(松开)⇒ 超容读数也能过', sample: overRing, patch: { acDropsExcess: 999 }, id: C5, want: true },
  ];
  for (const c of cases) {
    const rows = judgePerfSample(c.sample, { ...PERF_BUDGET, ...c.patch });
    eq(rowOf(rows, c.id).ok, c.want, `${c.what}:${c.id} 的结论必须随常量变`);
  }

  /* 默认预算下,上面那几条超预算读数必须**全部**为假(常量是唯一旋钮,读数是真的)。 */
  eq(rowOf(judgePerfSample(overDelta), C1).ok, false, '默认预算:C1 超预算');
  eq(rowOf(judgePerfSample(overSync), C2).ok, false, '默认预算:C2 超预算');
  eq(rowOf(judgePerfSample(overSprite), C3).ok, false, '默认预算:C3 超预算');
  eq(rowOf(judgePerfSample(overRing), C4).ok, false, '默认预算:C4 超预算');

  /* 具名常量本身:值写死字面量(actual 侧引用常量,expected 侧用数字)。 */
  eq(PERF_BUDGET_DELTA_LINEAR_ID_LOOKUPS_PER_FRAME, 0, '① 结构式:必须是 0');
  eq(PERF_BUDGET_SYNC_ALLOCS_PER_PLAYER_FRAME, 1, '② 每玩家 1 个');
  eq(PERF_BUDGET_SPRITE_ALLOCS_PER_ENTITY_FRAME, 1, '③ 每实体 1 个');
  eq(PERF_BUDGET_AC_RING_LENGTH, 512, '④ 环形容量');
  eq(PERF_BUDGET_AC_KEEP_PER_PLAYER, 256, '④b 单玩家窗口容量');
  eq(PERF_BUDGET_AC_DROPS_EXCESS, 0, '⑤ 丢弃余量 = 0');
  eq(landingSample.deltaLinearIdLookups, 0, '前置:窗口内 delta 读数确实为 0');
});

/* ═════════════════════ 4. 夹具可测量 / 可复现 ═════════════════════ */

test('FND158-9 夹具可测量且可复现:两次测量逐字段相同,判据纯函数', () => {
  const a = measurePerfFixture();
  const b = measurePerfFixture();
  /* 逐字段比较:任何一处随运行变化(池/槽残留、随机种子)都会在这里露出来。 */
  const keys = Object.keys(a).sort().join(',');
  eq(Object.keys(b).sort().join(','), keys, '两次测量必须给出同一批字段');
  for (const k of Object.keys(a) as (keyof PerfSample)[]) {
    eq(b[k], a[k], `字段 ${k} 必须逐次一致(夹具是确定的合成世界)`);
  }
  /* 判据是纯函数:同一入参两次结论逐条相同。 */
  const r1 = judgePerfSample(a).map((r) => `${r.id}:${r.ok}`);
  const r2 = judgePerfSample(a).map((r) => `${r.id}:${r.ok}`);
  eq(r2, r1, '判据纯函数:同一读数两次结论相同');
  /* 夹具规模自证:读数里的玩家/实体数必须与夹具常量一致(否则判据的分母是假的)。 */
  eq(a.players, 20, '读数里的玩家数来自夹具');
  eq(a.entities, 220, '读数里的实体数来自夹具');
});

/* ═════════════════════════ 5. 入闸形态 ═════════════════════════ */

/** 门禁侧的接线形态:进程内调用 + 失败/通过双支(**同一处** pass/fail)。 */
function hookPresent(src: string): boolean {
  return src.includes('  const pb = runPerfBudgetCheck();')
    && src.includes('if (!pb.ok) fail(`性能预算 ${pb.summaryLine}`);')
    && src.includes('else pass(`性能预算 ${pb.summaryLine}`);');
}

test('FND158-10 入闸:门禁进程内判同一份预算(接线存在 + 注入验证)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8');
  ok(hookPresent(src), 'gate 侧接线必须存在:进程内调用 + fail/pass 双支');

  /* ★ 注入验证:掏空任一分支,探测器必须转假 —— 否则这条判据只是「文件里出现过几个字」。 */
  ok(!hookPresent(src.replace('  const pb = runPerfBudgetCheck();', '')),
    '★ 注入(掏空调用点)后探测器必须转假');
  ok(!hookPresent(src.replace('if (!pb.ok) fail(`性能预算 ${pb.summaryLine}`);', '')),
    '★ 注入(去掉失败支)后探测器必须转假');
  ok(!hookPresent(src.replace('else pass(`性能预算 ${pb.summaryLine}`);', '')),
    '★ 注入(去掉通过支)后探测器必须转假');

  /* 自称数同源:门禁印出的那一行由判据算出(`summaryLine`),不是手写字面量。 */
  ok(src.includes('` · 命门自检 ${teeth.length - blind.length}/${teeth.length}`'),
    '汇总行里的「命门自检 N/M」必须由自检结果算出');

  /* 端到端:门禁用的那份结论必须同时覆盖判据与命门(缺任一支 ⇒ 不许 ok)。 */
  const r = runPerfBudgetCheck();
  eq(r.ok, true, `门禁结论必须通过:${r.summaryLine}`);
  eq(r.rows.length, 8, '结论里 8 条判据');
  eq(r.teeth.length, 6, '命门自检 6 条');
  eq(r.teeth.filter((t) => !t.flipped).length, 0, '命门自检必须全部翻转(否则判据没牙)');
});

test('FND158-11 命门自检本身可被证明有效:注入判据让它变成「没牙」', () => {
  const base = measurePerfFixture();
  const teeth = perfBudgetTeeth(base);
  eq(teeth.length, 6, '六条命门自检');
  eq(teeth.filter((t) => !t.flipped).length, 0, '在本仓当前实现下,六条全部咬得住');
  for (const t of teeth) ok(t.detail !== '', `${t.id} 必须说明「超预算读数从哪来」`);

  /* 反向:如果判据被改成「永远通过」(这里用一个荒谬宽松的预算模拟),
     同一次真实读数就不再翻假 —— 说明上面的 flipped 确实来自判据,而不是常量恒定。 */
  const wide = judgePerfSample({ ...base, deltaLinearIdLookups: 1_000_000 });
  eq(rowOf(wide, C1).ok, false, '真实超预算读数在默认预算下必须转假');
  const fixed = judgePerfSample({ ...base, deltaLinearIdLookups: 5 }, { ...PERF_BUDGET, deltaLinearIdLookupsPerFrame: 99 });
  eq(rowOf(fixed, C1).ok, true, '而上限常量放到 99 ⇒ 同一形态不再报(证明 flipped 由常量与读数共同决定)');
});

report('WS-FND-158');
