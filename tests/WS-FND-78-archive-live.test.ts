/**
 * WS-FND-78 —— 归档 / 回滚**接进生产**:`RestorePlan` 真的能落回 `WorldSim`。
 *
 * ## 这个套件钉的是什么
 *
 * `server/src/world/archive.ts` 已经把三段全做完了(解码 → 裁剪 → 回滚计划),
 * `tests/WS-FND-72` 也钉住了「计划 → 应用到**空世界描述** ⇒ 逐字段相等」。
 * 但那份能力当时停在**计划层**:
 *
 * ```
 * world/archive.ts  applyRestorePlan(plan) → RestoreWorldState   (纯数据)
 * world_sim.ts      applyRestore(plan)     → 不存在              ← 缺口
 * ```
 *
 * ⇒ 归档能写、计划能算,**世界回不去**。玩家点了「重置世界」之后,「回滚到上一版」
 *   在数据上是自洽的,在运行期没有任何落点。本套件钉的就是这条落点。
 *
 * 另外钉住 D-19 第 5 条的另一半:`archiveBeforeReset` / `index.ts:makeArchiveSink`
 * 此前把 `trim`(裁了几块 / 多少字节 / 为什么)在**两处**丢掉,于是
 * 「归档成功了」与「归档是裁过的」在回执里完全一样。
 *
 * ## 判据结构
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | 1 | 归档 → 重置 → `applyRestore` ⇒ 再归档的解码结果**逐字段相等** | 重置后(未恢复)`obj` 为 0、帧号 0 |
 * | 2 | 地形逐格还原(家具 351 回到那一格) | 重置后那格是空的 |
 * | 3 | 玩家位置 / 等级 / seed / 帧号逐个相等 | 重置后玩家在出生点 |
 * | 4 | 计划自足(从空世界走一遍也成立) | 世界边长不同的计划 ⇒ **拒绝**且世界一字未改 |
 * | 5 | `trim` 四件原样透传到回执 | 没裁过 ⇒ `trim` 键**缺席**(不是写一个零) |
 * | 6 | `planRestore` 的 `missingChunks` 与回执 `trim.droppedChunks` **同源** | 未裁剪快照 ⇒ `missingChunks = 0` |
 *
 * ## 期望值从哪来
 *
 * 全部取自**内容表**(物品 id 351 / 102)、**冻结层**(chunk 坐标与打包单元)
 * 或**手算**(seed 4242 → 999 → 回滚到 4242;帧号 40)。没有一条是
 * 「把被测模块的输出抄下来」。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import {
  decodeWorldArchive,
  planRestore,
  applyRestorePlan,
  encodeWorldArchive,
  describeDecodedWorld,
  diffWorldState,
  TRIM_RULE_ID,
  type ArchiveTrimReport,
} from '../server/src/world/archive.ts';
import { Chunk, idx } from '../server/src/world/chunk.ts';
import { packTile, unpackTile } from '../shared/types/tile.ts';

/* ═══════════ 0. 夹具 ═══════════ */

interface SimHandle {
  readonly frame: number;
  readonly worldSeed: number;
  setCell(x: number, y: number, fields: { obj?: number }): void;
  blockAt(x: number, y: number): number;
  dropItem(x: number, y: number, itemId: number, count: number): void;
  addMob(id: string, biome: string, x: number, y: number): void;
  poseOf(id: string): { x: number; y: number; z: number } | null;
  levelOf(id: string): number;
  advance(n?: number): number;
  resetWorld(opts: { seed: number; nowMs?: number }): {
    applied: boolean;
    seed: number;
    archive: {
      id: string;
      seed: number;
      archived_at: number;
      bytes: number;
      trim?: { status: string; droppedChunks: number; droppedBytes: number; reason: string; rule: string };
    } | null;
    archiveError?: string;
  };
  applyRestore(plan: unknown): {
    ok: boolean;
    reason?: string;
    applied?: { chunks: number; players: number; mobs: number; ground: number; seed: number; frame: number };
  };
}

const CELL_X = 3;
const CELL_Y = 4;
const FURNITURE = 351; /* 暖松原木圆墙(内容表 351):玩家建造物,seed 重建不出来 */
const DROPPED_ITEM = 102; /* 绯樱原木 */

/**
 * 走**真装配**造一份可归档的世界,并在每次重置时把快照字节捕获下来。
 *
 * 为什么从归档口取字节(而不是调 `describeWorldForArchive`):那是 `private`,
 * 而且本套件要的正是「**写入侧真的写出来的字节**」—— 与生产同一条路径。
 */
function captureWorld(): { sim: SimHandle; snaps: Uint8Array[] } {
  const snaps: Uint8Array[] = [];
  const a = assemble({
    roomId: 'r_fnd78',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 4242,
    db: null,
    archiveSink: (req) => {
      snaps.push(req.snapshot.slice());
      return {
        id: `${req.roomId}#${snaps.length}`,
        seed: req.seed,
        archived_at: req.nowMs,
        bytes: req.snapshot.byteLength,
      };
    },
  });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as SimHandle;
  /* 建造一格家具 + 推进 40 帧 + 丢一件东西 + 放一只羊 —— 四类世界世代各来一份。 */
  sim.setCell(CELL_X, CELL_Y, { obj: FURNITURE });
  sim.advance(40);
  sim.dropItem(5.5, 6.5, DROPPED_ITEM, 2);
  sim.addMob('mob_sheep', 'MEADOW', 10.5, 10.5);
  return { sim, snaps };
}

const world = captureWorld();
const sim = world.sim;

/* 归档前的事实(全部手写期望,不从 sim 抄) */
const before = {
  seed: sim.worldSeed,
  frame: sim.frame,
  cell: sim.blockAt(CELL_X, CELL_Y),
  pose: sim.poseOf('p1'),
  level: sim.levelOf('p1'),
};
const reset1 = sim.resetWorld({ seed: 999, nowMs: 1234 });
const snapshot1 = world.snaps[0];
const afterReset = {
  seed: sim.worldSeed,
  frame: sim.frame,
  cell: sim.blockAt(CELL_X, CELL_Y),
  pose: sim.poseOf('p1'),
};
const decoded1 = decodeWorldArchive(snapshot1);

/* ═══════════ 1. 归档 → 重置(负对照先行) ═══════════ */

test('FND78-1 ★负对照:重置之后世界真的变了(obj 清空 / 帧号归零 / 种子换了)', () => {
  /* 怎么变红:
       · 重置没换种子 ⇒ 第 1 条;
       · 重置没清地形 / 没归零帧号 ⇒ 第 3/4 条。
     这一条是 FND78-2/3 的前提:没有它,「回滚成功了」可能只是因为世界根本没变。 */
  ok(reset1.applied, '重置应生效');
  eq(afterReset.seed, 999, '新种子 = 999');
  eq(afterReset.frame, 0, '重置把帧序归零(D-07:0 帧 = 06:00)');
  eq(afterReset.cell, 0, '★ 那格家具被清掉了(新世界里还没有任何建造)');
  eq(before.cell, FURNITURE, '锚:重置前那一格确实是 351');

  /* 归档里的**旧世界**身份/时钟 */
  eq(decoded1.world.seed, 4242, '★ 归档记的是**旧世界**的种子');
  eq(decoded1.world.frame, 40, '★ 归档记的是重置前的帧号(advance(40))');
  eq(decoded1.world.sizeCells, 32);
  eq(decoded1.players.length, 1);
  eq(decoded1.players[0].id, 'p1');
  eq(decoded1.ground.length, 1);
  eq(decoded1.ground[0].itemId, DROPPED_ITEM);
  eq(decoded1.mobs.length, 1);
  eq(decoded1.mobs[0].mobId, 'mob_sheep');
  eq(decoded1.trim, null, '★ 32 格小世界远不到 1 MiB ⇒ 没裁过');
});

/* ═══════════ 2. 回滚:计划 → 世界 ═══════════ */

test('FND78-2 `applyRestore(plan)` 把地形/玩家/seed/帧号**真的**还回去(逐字段)', () => {
  /* 期望值:
       · seed 回到 4242(**旧世界**的种子);
       · 帧号回到 40;
       · (3,4) 那格回到 351;
       · 玩家回到归档时的坐标与等级。
     怎么变红:
       · `applyRestore` 只重建世界不铺块 ⇒ 第 3 条;
       · 不写回帧号 ⇒ 第 2 条(0);
       · 玩家留在出生点 ⇒ 第 4 条。 */
  const plan = planRestore(decoded1, null);
  eq(plan.source.seed, 4242, '计划来源 = 旧世界');
  eq(plan.ops[0].kind, 'world', '第一个 op 是世界身份(计划自足,不依赖现状)');

  const restored = sim.applyRestore(plan);
  ok(restored.ok, `回滚应成功(${restored.reason ?? ''})`);
  eq(restored.applied!.seed, 4242, '★ 世界种子回到归档那一版');
  eq(restored.applied!.frame, 40, '★ 帧号回到 40');
  eq(sim.worldSeed, before.seed, '种子逐字段相等');
  eq(sim.frame, before.frame, '帧号逐字段相等');
  eq(sim.blockAt(CELL_X, CELL_Y), FURNITURE, '★ 那一格家具回来了(内容表 351)');
  eq(sim.poseOf('p1'), before.pose, '★ 玩家位置逐字段相等');
  eq(sim.levelOf('p1'), before.level, '等级逐字段相等');
  ok(restored.applied!.chunks >= 1, `至少还回 1 块地形(实得 ${restored.applied!.chunks})`);
  eq(restored.applied!.players, 1);
  eq(restored.applied!.mobs, 1);
  eq(restored.applied!.ground, 1);

  /* 地形块体自己也要逐字节相等(不是"看起来有家具") */
  const planChunk = plan.ops.find((op) => op.kind === 'chunk');
  ok(planChunk !== undefined, '计划里必须有 chunk op');
  if (planChunk !== undefined && planChunk.kind === 'chunk') {
    const decodedChunk = Chunk.deserializeSnapshot(planChunk.bytes);
    eq(
      unpackTile(decodedChunk.cells[idx(CELL_X, CELL_Y)]).obj,
      FURNITURE,
      '块体里那一格的 obj 就是 351(内容表语义,不是另一编号)',
    );
    /* 锚:块体的坐标与计划一致(坐标搬家会静默错位) */
    eq(decodedChunk.cx, planChunk.cx);
    eq(decodedChunk.cy, planChunk.cy);
  }
});

test('FND78-3 回滚之后**再归档一次** ⇒ 两份解码结果逐字段相等(闭环)', () => {
  /* 这是「世界回到归档前状态」最硬的形态:不是读几个字段,而是让世界
     **自己再描述一遍**,再与第一份归档比。
     怎么变红:
       · 少了任何一类世界世代(mobs / ground)⇒ 对应字段不等;
       · 地形块体被重新生成而不是搬运 ⇒ `chunks[].bytes` 不等;
       · 帧号/钟点没还原 ⇒ `world.frame` / `world.hourOfDay` 不等。 */
  const r2 = sim.resetWorld({ seed: 555, nowMs: 99 });
  ok(r2.applied, '第二次重置应生效(它同时帮我们把回滚后的世界归档出来)');
  eq(world.snaps.length, 2, '两次归档:重置时(原世界)/ 回滚后的第二次重置(回滚后)');

  const decodedAfterRestore = decodeWorldArchive(world.snaps[1]);

  eq(decodedAfterRestore.world, decoded1.world, '世界世代(身份 + 时钟)逐字段相等');
  eq(decodedAfterRestore.players, decoded1.players, '玩家世代逐字段相等');
  eq(decodedAfterRestore.mobs, decoded1.mobs, '生物世代逐字段相等');
  eq(decodedAfterRestore.ground, decoded1.ground, '地面掉落逐字段相等');
  eq(decodedAfterRestore.totalBytes, decoded1.totalBytes, '★ 总字节数相等(块体字节数一致)');
  eq(
    decodedAfterRestore.chunks.map((c) => ({ cx: c.cx, cy: c.cy, bytes: c.bytes })),
    decoded1.chunks.map((c) => ({ cx: c.cx, cy: c.cy, bytes: c.bytes })),
    '★ 每一块地形的字节都逐位相等(回滚是搬运,不是重新生成)',
  );
  /* 走一遍本仓既有的对照工具:两份「世界描述」不许有任何差异 */
  eq(
    diffWorldState(describeDecodedWorld(decodedAfterRestore), describeDecodedWorld(decoded1)),
    [],
    '★ `diffWorldState` 也必须是空差异',
  );
  /* 计划层那一半:同一份计划从空世界走一遍得到同一份描述 */
  const plan = planRestore(decoded1, null);
  eq(
    diffWorldState(applyRestorePlan(plan), describeDecodedWorld(decoded1)),
    [],
    '计划自足:从空世界按计划走一遍 = 归档描述',
  );
});

/* ═══════════ 3. 拒绝:世界边长不可回滚 ═══════════ */

test('FND78-4 ★负对照:计划的世界边长不同 ⇒ 拒绝回滚,且世界一字未改', () => {
  /* 网格 / 流体场 / 物理边界都是按 `sizeCells` 构造的 ⇒ 换尺寸 = 换世界实例。
     怎么变红:
       · 硬铺块(无视尺寸)⇒ 第 2 条(ok 变 true);
       · 先重建后检查 ⇒ 第 3/4 条(世界已经被改了)。 */
  const plan = planRestore(decoded1, null);
  const bad = {
    ...plan,
    ops: plan.ops.map((op) => (op.kind === 'world' ? { ...op, sizeCells: 64 } : op)),
  };
  const frameBefore = sim.frame;
  const seedBefore = sim.worldSeed;
  const cellBefore = sim.blockAt(CELL_X, CELL_Y);

  const r = sim.applyRestore(bad as unknown as Parameters<SimHandle['applyRestore']>[0]);
  eq(r.ok, false, '★ 尺寸不同必须拒绝');
  ok((r.reason ?? '').includes('边长'), `理由要说清是边长(${r.reason ?? ''})`);
  eq(sim.frame, frameBefore, '★ 帧号一字未改');
  eq(sim.worldSeed, seedBefore, '★ 种子一字未改');
  eq(sim.blockAt(CELL_X, CELL_Y), cellBefore, '★ 地形一字未改');

  /* ★ 负对照 2:形状不对的计划也拒(不抛错、不改世界) */
  eq(sim.applyRestore(null).ok, false, 'null 计划 ⇒ 拒绝');
  eq(sim.applyRestore({ ops: [] }).ok, false, '没有 world 段的计划 ⇒ 拒绝');
});

/* ═══════════ 4. `trim` 四件不许丢(★ B 的另一半) ═══════════ */

test('FND78-5 ★`trim` 四件原样透传:块数 / 字节 / 原因 / 状态;没裁过则键缺席', () => {
  /* 为什么这条属于「接线」:两个位置各丢一次 ——
       `index.ts:makeArchiveSink` 只搬四字段、`world_sim:archiveBeforeReset` 又新建回执。
     怎么变红:
       · 任一层丢掉 trim ⇒ 第 1 条(键不存在);
       · 重新算一个计数 / 重写原因文本 ⇒ 第 2-4 条(与 sink 给的不等);
       · 没裁过也写一个 `{status:'KEPT', ...}` ⇒ 第 5 条(键存在)。 */
  const trimSent: { status: 'TRIMMED'; droppedChunks: number; droppedBytes: number; reason: string; rule: string } = {
    status: 'TRIMMED',
    droppedChunks: 7,
    droppedBytes: 7 * 1145,
    reason: '手写的裁剪原因:预算 1 MiB,按 built>activity>regenerable 裁了 7 块',
    rule: TRIM_RULE_ID,
  };
  const a = assemble({
    roomId: 'r_fnd78_trim',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 1,
    db: null,
    archiveSink: (req) => ({
      id: `${req.roomId}#1`,
      seed: req.seed,
      archived_at: req.nowMs,
      bytes: req.snapshot.byteLength,
      trim: trimSent,
    }),
  });
  a.runtime.join({ userId: 'p1' });
  const s = a.host as unknown as SimHandle;
  const out = s.resetWorld({ seed: 2, nowMs: 5 });
  ok(out.archive !== null, '归档应成功');
  eq(out.archive!.trim, trimSent, '★ 四件**原样**上报(块数 / 字节 / 原因 / 状态都不许重写)');
  eq(out.archive!.trim!.rule, TRIM_RULE_ID, '规则标识也在(机器可判)');

  /* ★ 负对照:sink 不给 trim ⇒ 回执里**没有这个键**(而不是零值) */
  const b = assemble({
    roomId: 'r_fnd78_notrim',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 1,
    db: null,
    archiveSink: (req) => ({
      id: `${req.roomId}#1`,
      seed: req.seed,
      archived_at: req.nowMs,
      bytes: req.snapshot.byteLength,
    }),
  });
  b.runtime.join({ userId: 'p1' });
  const s2 = b.host as unknown as SimHandle;
  const out2 = s2.resetWorld({ seed: 2, nowMs: 5 });
  ok(out2.archive !== null);
  eq(Object.prototype.hasOwnProperty.call(out2.archive, 'trim'), false, '★ 没裁过 ⇒ `trim` 键缺席');
});

test('FND78-6 回执的 `trim.droppedChunks` 与 `planRestore().missingChunks` **同源**', () => {
  /* 出处:`server/src/world/archive.ts` 的 `planRestore` 明确从快照头的
     `trim.droppedChunks` 推 `missingChunks`,并把「被裁块不可回滚」写进 `unavailable`。
     这条把「回执里的四件」与「回滚计划的缺口」钉成同一份事实 —— 若接线层
     自己编了个计数,两边就会不等。
     怎么变红:
       · 回执的计数是编的 ⇒ 第 2 条;
       · `planRestore` 不读 trim ⇒ 第 3/4 条。 */
  const trim: ArchiveTrimReport = {
    budgetBytes: 1 << 20,
    originalBytes: (1 << 20) + 3 * 1145,
    keptChunks: 4,
    droppedChunks: 3,
    droppedBytes: 3 * 1145,
    rule: TRIM_RULE_ID,
    reason: '手写:预算不够,裁掉 3 块可重建的地形',
    dropped: [
      { cx: 0, cy: 0, bytes: 1145, reason: 'regenerable' },
      { cx: 1, cy: 0, bytes: 1145, reason: 'regenerable' },
      { cx: 2, cy: 0, bytes: 1145, reason: 'regenerable' },
    ],
  };
  const blob = encodeWorldArchive({
    world: { roomId: 'r_fnd78_plan', seed: 77, sizeCells: 32, biome: 'MEADOW', frame: 12, hourOfDay: 7.5 },
    players: [],
    mobs: [],
    ground: [],
    chunks: [],
    trim,
  });
  const decoded = decodeWorldArchive(blob);
  eq(decoded.trim!.droppedChunks, 3, '解码读得回「裁了几块」');
  eq(decoded.trim!.droppedBytes, 3 * 1145, '解码读得回「裁了多少字节」');
  eq(decoded.trim!.reason, trim.reason, '原因**原样**存回(不重写)');

  const plan = planRestore(decoded, null);
  eq(plan.missingChunks, 3, '★ 计划的缺口 = 回执的 droppedChunks(同一份事实)');
  eq(plan.source.trimmed, true, '计划来源标记为「裁过」');
  ok(
    plan.unavailable.some((u) => u.includes('已裁掉 3 块')),
    `缺口必须写进 unavailable(${plan.unavailable.join(' | ')})`,
  );
  eq(plan.missing.length, 0, '★ 逐块清单**不持久化**(`ArchiveTrimReport.dropped` 的注释):'
    + '从字节读回时是空数组 —— 缺口用 missingChunks 计数,不伪造清单');

  /* ★ 负对照:没裁过的快照 ⇒ 缺口 0,且不在 unavailable 里提「裁掉」 */
  const clean = planRestore(decodeWorldArchive(world.snaps[0]), null);
  eq(clean.missingChunks, 0, '★ 未裁剪 ⇒ 缺口 0');
  eq(clean.source.trimmed, false);
  ok(!clean.unavailable.some((u) => u.includes('已裁掉')), '未裁剪时不许出现「已裁掉」');
});

report('WS-FND-78');