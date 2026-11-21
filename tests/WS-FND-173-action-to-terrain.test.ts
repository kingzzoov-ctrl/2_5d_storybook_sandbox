/**
 * WS-FND-173 · **真客户端动作 → 地形被写 → chunk 落库**(修前零覆盖的那条链)
 *
 * ## 这条链为什么此前**一条判据都没有**(W3 查明,如实登记)
 *
 * ```text
 * 1 room_chunks 60 分钟零写入**不是产品缺陷**:
 *   夹具的动作轮转里**没有** PLACE_BLOCK(旧 scripts/soak.ts 的 case 表),
 *   而 BREAK_BLOCK / GATHER 打的是**自己脚下那一格** —— 那里是空格,
 *   世界如实回「这一格没有物件」⇒ 一格地形都没改;
 * 2 唯一那颗 load.worldWrites 数的是「物质层五方法被调了几次」:
 *   地面掉落(DROP_ITEM / 拾取)与被拒的拆块都算进它 ⇒ 它涨与「地形被改」无关
 *   (实测 2 秒短跑:worldWrites=4,而 room_chunks=0);
 * 3 WS-FND-164 从 `createHost()` + **手写 `sim.grid.setCell(...)`** 那一步开始
 *   (即「格已经改过」)⇒ 它覆盖的是**存档/读档**,不是「动作 → 地形」这一段;
 * 4 roomChunks 在 scripts/soak.ts 里只是**观测项**(进 samples / SOAK_SERIES),
 *   没有任何断言钉过它。
 * ```
 *
 * ⇒ 本文件补这一段。配套的夹具改动(`scripts/soak.ts`):
 *
 * ```text
 * 1 轮转里加 PLACE_BLOCK(挑**空**格)与「对**有物件**的格 BREAK_BLOCK / GATHER」,
 *   目标格由 `pickCell` 随玩家移动与轮次变化(不是只打脚下);
 * 2 把 worldWrites 拆成三颗**互斥**计数器(定义见 `applyMaterialWrite`):
 *     terrainWrites   真改了 chunk 的(placeBlock / breakBlock 返回 ok:true)
 *     groundWrites    地面物品账的写入(一个字都不改 chunk)
 *     rejectedWrites  地形写口被世界**拒**的次数(ok:false)
 * 3 `placeTarget: 'offworld'` = 负对照:目标恒取世界外那一格 ⇒ 必被拒、零副作用。
 * ```
 *
 * ## 判据(9 条)
 * ```text
 * FND173-1  三桶定义锚:空计数三键为 0 · worldWrites 已拆掉 · 分类规则逐条可判
 * FND173-2  ★★ 核心端到端:真客户端动作 → 地形被写 → 一次自动存档 → room_chunks 有行
 * FND173-3  ★ 双向:terrainWrites > 0 ⇔ room_chunks > 0(正跑成立 / 负跑两边都为 0)
 * FND173-4  ★ 地面掉落**不**计入 terrainWrites(负对照:groundWrites > 0 而 terrainWrites = 0)
 * FND173-5  ★ 被拒的拆块不计入 terrainWrites(unit 级 + 真跑级)
 * FND173-6  ★ PLACE_BLOCK 被世界拒 ⇒ 不落库(存档真的跑了,而 room_chunks 仍是 0)
 * FND173-7  ★ 存档后关掉 host 再开、逐格一致;负对照 = 换个房间号读不到这份地形
 * FND173-8  ★ 采样/汇总面跟得上:三条序列可读、汇总行里有「地形写」
 * FND173-9  ★ 三桶在真跑里单调不减(它们是累计计数,不是瞬时读数)
 * ```
 *
 * ## 纪律
 * ```text
 * 1 端到端那一跑**不手写 `setCell`**:地形只能由真 WS 客户端上行改出来;
 * 2 每条正判据都配负对照(offworld 跑 / 别的房间号 / unit 级分类);
 * 3 真跑走 `createSoakFixture`(assemble + 真 WS + 真文件库),库与日志落在 tmpdir;
 * 4 期望值写字面量(48 / 2 / 0 / 1),不拿被测常量当期望值。
 * ```
 *
 * 运行:`node tests/WS-FND-173-action-to-terrain.test.ts`
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  DEFAULT_SOAK_OPTIONS,
  MATERIAL_WRITE_METHODS,
  SOAK_SERIES,
  applyMaterialWrite,
  createSoakFixture,
  emptyLoadCounters,
  formatSummaryLines,
  seriesValue,
  summarizeSoak,
  type LoadCounters,
  type SoakFixture,
  type SoakOptions,
  type SoakSample,
} from '../scripts/soak.ts';
import { createHost } from '../server/src/index.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import { loadWorldState } from '../server/src/db/repo.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

/* ═══════════════════════════ 夹具参数(字面量)═══════════════════════════ */

const DIR = join(tmpdir(), `ws-fnd-173-${process.pid}`);
mkdirSync(DIR, { recursive: true });
const SIZE = 48;
const ROOM_POS = 'fnd173_pos';
const ROOM_NEG = 'fnd173_neg';
const ROOM_OTHER = 'fnd173_other';
const POS_DB = join(DIR, 'pos.db');
const NEG_DB = join(DIR, 'neg.db');
/** 负对照跑多久(ms):够动作轮转转好几圈,又不必等长跑。 */
const NEG_RUN_MS = 2_500;

const BASE: Partial<SoakOptions> = {
  sampleEveryMs: 500,
  frameMs: 50,
  actionHz: 10,
  moveHz: 5,
  sizeCells: SIZE,
  warmupFrames: 120,
  quiet: true,
  fresh: true,
  clients: 2,
  minutes: 1,
};

function optionsOf(patch: Partial<SoakOptions>): SoakOptions {
  return { ...DEFAULT_SOAK_OPTIONS, ...BASE, ...patch };
}

const POS_OPTIONS = optionsOf({
  roomId: ROOM_POS,
  placeTarget: 'varying',
  dbPath: POS_DB,
  logPath: join(DIR, 'pos.log'),
});
const NEG_OPTIONS = optionsOf({
  roomId: ROOM_NEG,
  placeTarget: 'offworld',
  clients: 1,
  dbPath: NEG_DB,
  logPath: join(DIR, 'neg.log'),
});

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, ms)); });
}

/** 轮询等待一个条件成立(夹具是**真墙钟**,只能等,不能快进)。 */
async function waitUntil(pred: () => boolean, budgetMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

/** 世界侧的地形层(夹具的 `worldSaveHost` 就是生产装配的 `WorldSim`)。 */
function simOf(fx: SoakFixture): WorldSim {
  const host = fx.runtime.worldSaveHost;
  if (host === null) throw new Error('夹具没有 worldSaveHost(装配路径坏了)');
  return host as unknown as WorldSim;
}

/**
 * **逐格**指纹:整个世界的 obj 层(放置 / 破坏改的就是这一层)。
 *
 * 为什么不用「三张表」或 `chunks.keys()`:本判据要比的是**内容**是否逐格一致,
 * 而块集合会因为「读过没写过」而不同(读不建块)。⇒ 按 `sizeCells × sizeCells`
 * 逐格取,缺块一侧自然读成 0 —— 两侧用**同一个**口径,可比。
 */
function objFingerprint(sim: WorldSim, size: number): { line: string; nonZero: number } {
  const out: number[] = [];
  let nonZero = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = sim.grid.objIdAt(x, y);
      out.push(v);
      if (v !== 0) nonZero += 1;
    }
  }
  return { line: out.join(','), nonZero };
}

/** 两段指纹的**第一处**差异(报在断言消息里,否则「不一致」不可定位)。 */
function firstDiff(a: string, b: string, size: number): string {
  const x = a.split(',');
  const y = b.split(',');
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return `格(${i % size},${Math.floor(i / size)}):${x[i] ?? '(缺)'} vs ${y[i] ?? '(缺)'}`;
  }
  return '';
}

/* ═══════════ 真跑 1(正):真客户端动作 → 地形被写 → 一次自动存档 ═══════════
   ⚠️ `harness.test()` 只接同步函数 ⇒ 异步装配在模块层用 top-level await 做完。 */

const pos = await createSoakFixture(POS_OPTIONS);
const posTerrainSeen = await waitUntil(() => pos.counters.terrainWrites > 0, 12_000);
/* 存档**之前**的行数:修前的 60 分钟长跑一直停在这个数上。 */
const posChunksBeforeSave = pos.db.count('room_chunks');
const posSampleAtTerrainWrite = pos.sample('run');
/* 一次自动存档(与周期轨**同一个实现**,不是另开一条写库路径)。 */
const posSavedWhileAlive = pos.runtime.saveWorldNow('manual');
const posChunksAfterSave = pos.db.count('room_chunks');
const posSampleAfterSave = pos.sample('run');
const posSeed = loadWorldState(pos.db, ROOM_POS)?.seed;
const posFinalSample = await pos.close();
const posCounters: LoadCounters = { ...pos.counters };
/* 关掉之后世界里还有什么:客户端放下的地形(setCell 一次都没手写过)。 */
const posSim = simOf(pos);
const posFingerprint = objFingerprint(posSim, SIZE);

/* 关掉 host 再开:新句柄 + 新 host(读自己的写缓存不算落了盘)。 */
const posDb2 = openNodeSqlite(POS_DB);
const posReopened = createHost(
  { roomId: ROOM_POS, worldSeed: posSeed, sizeCells: SIZE, mobs: false }, posDb2,
) as unknown as WorldSim;
const posReopenedFingerprint = objFingerprint(posReopened, SIZE);
/* ★ 负对照:换一个**房间号** ⇒ 库里没有它那一代的存档 ⇒ 读回的是空世界。 */
const otherRoomHost = createHost(
  { roomId: ROOM_OTHER, worldSeed: posSeed, sizeCells: SIZE, mobs: false }, posDb2,
) as unknown as WorldSim;
const otherRoomFingerprint = objFingerprint(otherRoomHost, SIZE);
posDb2.close();

/* ═══════════ 真跑 2(负):目标恒在世界外 ⇒ 必被拒、零地形写 ═══════════ */

const neg = await createSoakFixture(NEG_OPTIONS);
await sleep(NEG_RUN_MS);
const negDirtyBefore = simOf(neg).dirtyChunkCount();
/* 直接从**同一个世界入口**发一次注定失败的放置:证明「被拒的放置」不是脏块来源。
   ⚠️ 这条**不是**端到端那条(端到端那条在真跑 1);它钉的是世界层的零副作用。 */
const directPlace = simOf(neg).materials().placeBlock(SIZE + 4, SIZE + 4, 101);
const negDirtyAfter = simOf(neg).dirtyChunkCount();
const negRejectedAfterDirect = neg.counters.rejectedWrites;
const negChunksBeforeSave = neg.db.count('room_chunks');
const negSavedWhileAlive = neg.runtime.saveWorldNow('manual');
const negChunksAfterSave = neg.db.count('room_chunks');
const negFinalSample = await neg.close();
const negCounters: LoadCounters = { ...neg.counters };

/* ═══════════════════════════ 1. 三桶定义锚 ═══════════════════════════ */

test('FND173-1 三桶定义锚:空计数三键为 0、worldWrites 已拆掉、分类规则逐条可判', () => {
  const empty = emptyLoadCounters();
  eq(empty.terrainWrites, 0, '空计数:terrainWrites = 0');
  eq(empty.groundWrites, 0, '空计数:groundWrites = 0');
  eq(empty.rejectedWrites, 0, '空计数:rejectedWrites = 0');
  ok(!Object.prototype.hasOwnProperty.call(empty, 'worldWrites'),
    '★ 旧的 worldWrites 必须**拆掉**(它把三类写法混成一个数,判据没法指向地形)');

  ok(SOAK_SERIES.includes('load.terrainWrites'), '序列表里有 load.terrainWrites');
  ok(SOAK_SERIES.includes('load.groundWrites'), '序列表里有 load.groundWrites');
  ok(SOAK_SERIES.includes('load.rejectedWrites'), '序列表里有 load.rejectedWrites');
  ok(!SOAK_SERIES.includes('load.worldWrites'), '★ 序列表里不再有 load.worldWrites');
  ok(MATERIAL_WRITE_METHODS.length === 5
    && MATERIAL_WRITE_METHODS.includes('placeBlock')
    && MATERIAL_WRITE_METHODS.includes('breakBlock'),
    `物质层写口五个都要挂计数壳(实际 ${MATERIAL_WRITE_METHODS.join(',')})`);

  /* 分类规则:三个桶**互斥**,一条写法只进一个桶。 */
  const c = emptyLoadCounters();
  applyMaterialWrite(c, 'placeBlock', { ok: true });
  eq([c.terrainWrites, c.groundWrites, c.rejectedWrites], [1, 0, 0], '放置成功 ⇒ terrainWrites');
  applyMaterialWrite(c, 'placeBlock', { ok: false, reason: '该格已有物件(351)' });
  eq([c.terrainWrites, c.groundWrites, c.rejectedWrites], [1, 0, 1], '放置被拒 ⇒ rejectedWrites');
  applyMaterialWrite(c, 'breakBlock', { ok: true, objId: 101 });
  eq([c.terrainWrites, c.groundWrites, c.rejectedWrites], [2, 0, 1], '拆块成功 ⇒ terrainWrites');
  applyMaterialWrite(c, 'breakBlock', { ok: false, reason: '这一格没有物件' });
  eq([c.terrainWrites, c.groundWrites, c.rejectedWrites], [2, 0, 2], '拆块被拒 ⇒ rejectedWrites');
  applyMaterialWrite(c, 'dropItem', undefined);
  eq([c.terrainWrites, c.groundWrites, c.rejectedWrites], [2, 1, 2], '落货 ⇒ groundWrites');
  applyMaterialWrite(c, 'takeGroundItemNear', true);
  applyMaterialWrite(c, 'takeGroundItemNear', false);
  eq(c.groundWrites, 2, '★ 拾取**真的拿到**才算一次;拿不到(false)不算');
  applyMaterialWrite(c, 'consumeGroundItem', 3);
  applyMaterialWrite(c, 'consumeGroundItem', 0);
  eq(c.groundWrites, 3, '★ 消耗到东西(>0)才算;0 件不算');
  eq(c.terrainWrites + c.rejectedWrites, 4, '不变量:地形写 + 被拒 = 地形写的尝试次数');
});

/* ═══════════════════════════ 2. ★★ 核心端到端 ═══════════════════════════ */

test('FND173-2 ★★ 真客户端动作 → 地形被写 → 一次自动存档 → room_chunks 有行', () => {
  ok(posTerrainSeen, `12 秒内必须看到**地形写**(实际 ${posCounters.terrainWrites} 次)`
    + ` —— 修前这里恒为 0,而 worldWrites 一直在涨`);
  ok(posCounters.terrainWrites > 0,
    `真客户端(2 个,真 WS)把地形改了 ${posCounters.terrainWrites} 次`);
  eq(posChunksBeforeSave, 0, '★ 存档之前 room_chunks **一行都没有**(修前 60 分钟长跑就停在这里)');
  eq(posSavedWhileAlive, true, '一次自动存档真的跑了(与周期轨同一个实现 saveWorldNow)');
  ok(posChunksAfterSave > 0,
    `★ 存档之后 room_chunks 必须有行(实际 ${posChunksAfterSave} 行)`);
  ok(posFinalSample.roomChunks > 0,
    `末样本(销毁存档之后)读到 room_chunks = ${posFinalSample.roomChunks}(>0)`);
  eq(posSampleAtTerrainWrite.load.terrainWrites, posCounters.terrainWrites,
    '样本读的是同一份计数(不在采样里另算一遍)');
  ok(posSampleAfterSave.roomChunks >= posSampleAtTerrainWrite.roomChunks,
    'roomChunks 是单调观测(存档只增行,不会把已有行删掉)');
  eq(posFinalSample.phase, 'final', '末样本是 final 阶段(销毁存档之后采的)');
  ok(posFinalSample.autosave.lastReason === 'dispose',
    `收尾那一次存档走的是销毁路径(实际 ${String(posFinalSample.autosave.lastReason)})`);
});

/* ═══════════════════════════ 3. 双向 ⇔ ═══════════════════════════ */

test('FND173-3 ★ 双向:terrainWrites > 0 ⇔ room_chunks > 0', () => {
  /* 正方向(正跑):有地形写 ⇒ 有行。 */
  ok(posCounters.terrainWrites > 0 && posChunksAfterSave > 0,
    `正跑:地形写 ${posCounters.terrainWrites} ⇒ chunk 行 ${posChunksAfterSave}`);
  /* 反方向(负跑):没有地形写 ⇒ 一行都没有 —— 而且负跑**真的有动作到达**。 */
  eq(negCounters.terrainWrites, 0, '负跑:一次地形写都没有(目标恒在世界外)');
  ok(negCounters.actionsApplied > 0,
    `负跑的动作确实到达了执行层(${negCounters.actionsApplied} 条)—— 否则「0 地形写」是空转`);
  eq(negChunksAfterSave, 0, `负跑:存档之后 room_chunks 仍是 0(实际 ${negChunksAfterSave})`);
  eq(negFinalSample.roomChunks, 0, '负跑末样本 room_chunks = 0');
  /* 负对照的牙:同一个判据在正跑上必须转真。 */
  ok(posChunksAfterSave !== negChunksAfterSave, '★ 同一个判据在两跑上给出不同结论(有牙)');
});

/* ═══════════════════════════ 4. 地面掉落不算地形写 ═══════════════════════════ */

test('FND173-4 ★ 地面掉落**不**计入 terrainWrites(负对照)', () => {
  ok(negCounters.groundWrites > 0,
    `负跑真的落了货 / 捡了货(${negCounters.groundWrites} 次地面账写入)`);
  eq(negCounters.terrainWrites, 0,
    '★ 地面账写了多少次都不进 terrainWrites(修前它们与地形写同挤在 worldWrites 里)');
  /* unit 级:单看落货,只有 groundWrites 动。 */
  const c = emptyLoadCounters();
  applyMaterialWrite(c, 'dropItem', undefined);
  eq([c.terrainWrites, c.rejectedWrites], [0, 0], '落货一个字都不改地形');
  eq(c.groundWrites, 1, '落货只进 groundWrites');
});

/* ═══════════════════════════ 5. 被拒的拆块不算地形写 ═══════════════════════════ */

test('FND173-5 ★ 被拒的拆块不计入 terrainWrites', () => {
  ok(negCounters.rejectedWrites > 0,
    `负跑里确实有被世界拒的地形写(${negCounters.rejectedWrites} 次)`);
  eq(directPlace.ok, false, `直接发的那个放置被世界拒了(${JSON.stringify(directPlace)})`);
  ok(negRejectedAfterDirect >= negCounters.rejectedWrites,
    '被拒的那一次进了 rejectedWrites 而不是被吞掉');
  eq(negCounters.terrainWrites, 0, '★ 被拒的地形写一次都不算进 terrainWrites');
  /* unit 级:拆一个空格。 */
  const c = emptyLoadCounters();
  applyMaterialWrite(c, 'breakBlock', { ok: false, reason: '这一格没有物件' });
  eq([c.terrainWrites, c.rejectedWrites], [0, 1], '空格的拆块 ⇒ 只进 rejectedWrites');
});

/* ═══════════════════════════ 6. 放置失败不落库 ═══════════════════════════ */

test('FND173-6 ★ PLACE_BLOCK 失败时不落库(存档跑了,库仍是空的)', () => {
  eq(negDirtyAfter, negDirtyBefore,
    `被拒的放置不许把 chunk 置脏(${negDirtyBefore} → ${negDirtyAfter})`);
  eq(negDirtyBefore, 0, '负跑全程没有一个脏块');
  eq(negSavedWhileAlive, true, '★ 存档**真的跑了**(不是「没存所以没行」这种假绿)');
  eq(negChunksBeforeSave, 0, '存档前 0 行');
  eq(negChunksAfterSave, 0, '★ 存档后仍是 0 行:被拒的放置没有留下任何地形');
});

/* ═══════════════════════════ 7. 关掉 host 再开、逐格一致 ═══════════════════════════ */

test('FND173-7 ★ 存档后关掉 host 再开:地形逐格一致;换房间号读不到(负对照)', () => {
  ok(posFingerprint.nonZero > 0,
    `★ 非空转:关掉之前世界里确实有客户端改出来的非零 obj 格(${posFingerprint.nonZero} 格)`);
  eq(posReopenedFingerprint.line, posFingerprint.line,
    `逐格不一致:${firstDiff(posFingerprint.line, posReopenedFingerprint.line, SIZE)}`);
  eq(posReopenedFingerprint.nonZero, posFingerprint.nonZero, '非零格数也一致');
  /* ★ 负对照:同一个库、**另一个房间号** ⇒ 读不到这一代的地形(空世界)。 */
  eq(otherRoomFingerprint.nonZero, 0,
    `★ 换个房间号就读不到那份存档(实际 ${otherRoomFingerprint.nonZero} 个非零格)`
    + ' —— 证明上面那条「一致」不是因为两边都被重置成空');
  ok(otherRoomFingerprint.line !== posFingerprint.line, '负对照的指纹确实不同');
  ok(posSeed !== undefined, `库里记下了这一代的 seed(${String(posSeed)})`);
});

/* ═══════════════════════════ 8. 采样 / 汇总面 ═══════════════════════════ */

test('FND173-8 ★ 采样与汇总面跟得上:三条序列可读、汇总行里有「地形写」', () => {
  for (const key of ['load.terrainWrites', 'load.groundWrites', 'load.rejectedWrites']) {
    const v = seriesValue(posFinalSample, key);
    ok(Number.isFinite(v) && v >= 0, `序列 ${key} 必须是可读的非负数(实际 ${String(v)})`);
  }
  const summary = summarizeSoak({
    options: POS_OPTIONS,
    samples: pos.samples,
    counters: posCounters,
    wsLogLines: 0,
    durationMs: 1,
  });
  eq(summary.load.terrainWrites, posCounters.terrainWrites, '汇总里的地形写 = 累计计数');
  const lines = formatSummaryLines(summary).join('\n');
  ok(lines.includes('地形写') && lines.includes('被拒'),
    '汇总行必须把三桶都打印出来(否则报告里看不出「地形到底写没写」)');
  ok(SOAK_SERIES.length >= 30, `序列条数仍然够多(实际 ${SOAK_SERIES.length})`);
});

/* ═══════════════════════════ 9. 单调性 ═══════════════════════════ */

test('FND173-9 ★ 三桶在真跑里单调不减(累计计数,不是瞬时读数)', () => {
  for (const key of ['load.terrainWrites', 'load.groundWrites', 'load.rejectedWrites']) {
    let prev = -1;
    for (const s of pos.samples as readonly SoakSample[]) {
      const v = seriesValue(s, key);
      ok(Number.isFinite(v), `${key} 在每条样本里都要有读数`);
      ok(v >= prev, `${key} 不许回落(${prev} → ${v})—— 它是累计计数`);
      prev = v;
    }
  }
  ok(pos.samples.length >= 3,
    `正跑至少采了 3 条样本(基线 + 跑动 + 末)(实际 ${pos.samples.length})`);
});

/* 清理:库与日志都在 tmpdir,跑完即删(WAL/SHM 一并删)。 */
for (const p of [POS_DB, NEG_DB, join(DIR, 'pos.log'), join(DIR, 'neg.log'),
  `${POS_DB}-wal`, `${POS_DB}-shm`, `${NEG_DB}-wal`, `${NEG_DB}-shm`]) {
  try { rmSync(p, { force: true }); } catch { /* 句柄未放时不强求 */ }
}

report('WS-FND-173');
