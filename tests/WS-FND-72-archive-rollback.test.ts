/**
 * WS-FND-72 —— 世界归档的**读**那一半(D-19 第 5 条:chunk 裁剪规则 + 完整回滚)
 *
 * ## 这个套件钉的是什么
 *
 * 裁决原文(`docs/DECISIONS.md` **D-19 第 5 条**):
 *   「归档快照 ⇒ **chunk 裁剪规则 + 完整回滚**(不再是"只写不读")」
 *
 * 改前的事实:`WSA1` 快照**只写不读**,而且 `repo.ts` 有 1 MiB BLOB 上限 ⇒
 * 大世界归档直接抛(`archive: null` + `archiveError`,世界照样重建)。
 * 改后的三段各有一条判据:
 *
 * | # | 判据 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 真实写入侧的字节 → 解码 → **逐字段相等**;`encode(decode(x))` 逐字节回到 `x` | 头偏移算错 / 少解一个字段 / 块体长度用错 |
 * | 2 | 小世界 **一块不裁**;超预算世界 ⇒ 裁剪后字节数 ≤ 上限、被裁列表非空、原因可读、玩家建造优先 | 裁了但没用预算 / 静默截断 / 裁掉玩家建造 / 规则不确定 |
 * | 3 | 归档 → 解码 → 计划 → **应用到空世界** ⟷ 归档前描述**逐字段相等** | 计划漏字段 / 把 `current` 混进 ops / 编造格式里没有的值 |
 * | 4 | 超限的 **真实** `WSA1` 走真 SQLite(`:memory:`)能落库,字节数与裁剪摘要都如实 | 还在抛 / 存的是原始(超限)字节 / 摘要只在内存里 |
 * | 5 | 回执:三态 `archive` 不变,`archiveBytes` 是**落库字节**,新增裁剪三项且三态 | 把没报告写成没裁 / 只报字节数不说裁了 |
 *
 * ## 为什么 `:memory:` 真库而不是 mock
 *
 * 「裁剪后还塞得进 BLOB 列」是**存储层的事实**,内存假实现替不了:
 * `snapshot_bytes` 与 BLOB 长度必须一致,而字节数是裁剪的直接后果。
 *
 * ## 断言右侧一律是**字面量**
 *
 * 1 MiB 写 `1048576`、归档上限写死、`hp` 写成 `'hp'` 的子串 —— 不取被测模块的
 * 导出常量(否则就是"用一个值断言它自己")。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { resetWorld } from '../server/src/net/actions/reset_world.ts';
import { assemble } from '../server/src/index.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  archiveWorldSnapshot,
  countWorldArchives,
  loadWorldArchive,
  migrate,
  migrateWorldArchives,
  type DbLike,
} from '../server/src/db/repo.ts';
import { Chunk, idx } from '../server/src/world/chunk.ts';
import { packTile, unpackTile } from '../shared/types/tile.ts';
import {
  applyRestorePlan,
  describeDecodedWorld,
  diffWorldState,
  decodeWorldArchive,
  emptyWorldState,
  encodeWorldArchive,
  fitWorldArchive,
  planChunkTrim,
  planRestore,
  type DecodedWorldArchive,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 装置:真实写入侧 + 合成大世界 ═══════════════════════ */

/** 本套件用到的世界侧能力(**只声明用到的**,与 WS-FND-62 同一手法)。 */
interface SimHandles {
  readonly worldSeed: number;
  readonly frame: number;
  hourOfDay(): number;
  advance(n?: number): number;
  setCell(x: number, y: number, fields: { obj?: number }): void;
  dropItem(x: number, y: number, itemId: number, count: number): void;
  blockAt(x: number, y: number): number;
  poseOf(id: string): { x: number; y: number; z: number } | null;
  levelOf(id: string): number;
  resetWorld(opts: { seed: number; nowMs?: number }): {
    applied: boolean;
    seed: number;
    archive: { id: string; seed: number; archived_at: number; bytes: number } | null;
  };
}

/** 真实写入侧(`WorldSim.describeWorldForArchive`)产出的一份快照 + 它对应的世界事实。 */
interface CapturedWorld {
  snapshot: Uint8Array;
  roomId: string;
  seed: number;
  frame: number;
  hourOfDay: number;
  pose: { x: number; y: number; z: number };
  level: number;
  /** 被放了一个家具(351)的那格**打包单元** —— 地形内容真伪的锚点。 */
  cellPacked: number;
  cellX: number;
  cellY: number;
}

const CELL_X = 3;
const CELL_Y = 4;
const FURNITURE = 351;

/**
 * 走**真装配**造一份归档快照:建造 → 推进 40 帧 → 掉落 → 重置(归档口捕获字节)。
 *
 * 为什么不用 `describeWorldForArchive` 直连:那是 `private`,而且本套件的判据
 * 要的正是「**写入侧真的写出来的字节**」—— 从归档口拿,和生产的路径一致。
 */
function captureRealWorld(): CapturedWorld {
  const captured: Uint8Array[] = [];
  const a = assemble({
    roomId: 'r_fnd72',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 4242,
    db: null,
    archiveSink: (req) => {
      captured.push(req.snapshot.slice());
      return {
        id: `${req.roomId}#1`,
        seed: req.seed,
        archived_at: req.nowMs,
        bytes: req.snapshot.byteLength,
      };
    },
  });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as SimHandles;
  sim.setCell(CELL_X, CELL_Y, { obj: FURNITURE });
  sim.advance(40);
  sim.dropItem(5.5, 6.5, 102, 2);
  const pose = sim.poseOf('p1');
  if (pose === null) throw new Error('玩家 p1 必须有位置(否则本套件的前提不成立)');
  const before: Omit<CapturedWorld, 'snapshot' | 'roomId'> = {
    seed: sim.worldSeed,
    frame: sim.frame,
    hourOfDay: sim.hourOfDay(),
    pose,
    level: sim.levelOf('p1'),
    cellPacked: sim.blockAt(CELL_X, CELL_Y),
    cellX: CELL_X,
    cellY: CELL_Y,
  };
  const reset = sim.resetWorld({ seed: 999, nowMs: 1234 });
  ok(reset.applied, '重置应生效(否则写侧没走到归档那一步)');
  if (captured.length !== 1) {
    throw new Error(`归档口应恰好收到 1 份快照(实得 ${captured.length})`);
  }
  return { snapshot: captured[0], roomId: 'r_fnd72', ...before };
}

/** 一块地形块体(用**真实的** `Chunk.serializeSnapshot`,不是手搓字节)。 */
function chunkBlob(cx: number, cy: number, built: boolean): Uint8Array {
  const c = new Chunk(cx, cy);
  if (built) {
    /* obj=351(一种家具)= 玩家建造:seed 重建不出来,裁剪时必须优先留。 */
    c.cells[idx(CELL_X, CELL_Y)] = packTile({
      elev: 0, base: 0, floor: 0, wire: 0, obj: FURNITURE, meta: 0,
    });
  }
  return c.serializeSnapshot();
}

/**
 * 造一份**超 1 MiB** 的合成快照:1000 块地形(每块 ~1.1KB)+ 少量建造块。
 *
 * 为什么合成:`sizeCells` 够大的真世界要 32×32 块才过 1 MiB,而那会把
 * 「裁剪」这条判据变成性能测试。合成用的是**同一个** `encodeWorldArchive`
 * 与**同一份** `Chunk.serializeSnapshot` —— 格式没有被"第二份实现"污染,
 * 未裁剪的字节已经由判据 1 钉在真实写入侧上。
 */
function makeOversizedArchive(chunks: number, builtAt: readonly number[]): Uint8Array {
  const list = [];
  for (let i = 0; i < chunks; i += 1) {
    const cx = i % 32;
    const cy = Math.floor(i / 32);
    list.push({ cx, cy, bytes: chunkBlob(cx, cy, builtAt.includes(i)) });
  }
  return encodeWorldArchive({
    world: {
      roomId: 'r_fnd72_big',
      seed: 777,
      sizeCells: 512,
      biome: 'MEADOW',
      frame: 123,
      hourOfDay: 12.5,
    },
    players: [{ id: 'p1', x: 1.5, y: 2.5, z: 0, level: 3 }],
    mobs: [],
    ground: [],
    chunks: list,
  });
}

/** 断言 `fn` 抛错,并返回错误消息(用于负对照:坏数据必须说清哪儿坏)。 */
function throwsWith(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${label} 必须抛错(静默放过 = 回滚出一份坏世界)`);
}

/** 逐字节比较两个 Uint8Array。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const real = captureRealWorld();
const decodedReal: DecodedWorldArchive = decodeWorldArchive(real.snapshot);

/* ═══════════════════════ 1. 解码(第 1 段) ═══════════════════════ */

test('FND72-1 真实写入侧的快照 → 解码 → 逐字段相等,且重新编码逐字节回到原文', () => {
  /* ── 世界世代:身份 + 时钟 ── */
  eq(decodedReal.version, 2, '格式版本 = 2(2026-11-17:v2 带玩家 hp 与流体水位)');
  eq(decodedReal.world.roomId, real.roomId, 'roomId');
  eq(decodedReal.world.seed, 4242, '★ seed 是**旧世界**的种子(重置前那个)');
  eq(decodedReal.world.sizeCells, 32, 'sizeCells');
  ok(decodedReal.world.biome.length > 0, `biome 不该为空(实得 ${decodedReal.world.biome})`);
  eq(decodedReal.world.frame, real.frame, '★ 帧号 = 重置前的帧号');
  eq(decodedReal.world.hourOfDay, real.hourOfDay, '★ 钟点 = 重置前的钟点');

  /* ── 玩家世代:位置 + 等级(格式里没有 hp,见判据 3 的边界断言) ── */
  eq(decodedReal.players.length, 1, '一个玩家');
  eq(decodedReal.players[0].id, 'p1', '玩家 id');
  eq(decodedReal.players[0].x, real.pose.x, '玩家 x');
  eq(decodedReal.players[0].y, real.pose.y, '玩家 y');
  eq(decodedReal.players[0].z, real.pose.z, '玩家 z');
  eq(decodedReal.players[0].level, real.level, '玩家等级');

  /* ── 掉落地(世界世代的一部分) ── */
  eq(decodedReal.ground.length, 1, '一件地面掉落');
  eq(decodedReal.ground[0].itemId, 102, '掉落物 id');
  eq(decodedReal.ground[0].count, 2, '掉落数量');

  /* ── 地形 chunk 列表 + 块体内容 ── */
  eq(decodedReal.chunks.length, 1, '32 格世界此刻只有 (0,0) 一块被创建');
  eq(decodedReal.chunks[0].cx, 0, '块 cx');
  eq(decodedReal.chunks[0].cy, 0, '块 cy');
  eq(decodedReal.bodyBytes, decodedReal.chunks[0].byteLength, '块体合计 = 那一块的字节数');
  eq(decodedReal.totalBytes, real.snapshot.byteLength, '总字节 = 入参字节数');
  eq(
    decodedReal.headerBytes + 12 + 4 + decodedReal.bodyBytes,
    real.snapshot.byteLength,
    '12 + headerLen + 4 + body = 总长',
  );
  eq(decodedReal.warnings, [], '★ 真实写入侧的字节解码不该有告警');
  eq(decodedReal.trim, null, '没裁过的快照里没有 trim 摘要');

  /* 块体**内容**真伪:解出来的单元必须等于重置前 `blockAt()` 的值。 */
  const terrain = Chunk.deserializeSnapshot(decodedReal.chunks[0].bytes);
  eq(
    unpackTile(terrain.cells[idx(CELL_X, CELL_Y)]).obj,
    real.cellPacked,
    '★ 地形单元逐位相等(家具还在)',
  );
  eq(decodedReal.chunks[0].builtCells, 1, '建造判据:那一格是 obj≠0');
  eq(decodedReal.chunks[0].tier, 2, 'tier=2 = 玩家建造(裁剪时最值得留)');

  /* ── 往返:encode(decode(x)) 必须逐字节回到 x ── */
  const again = encodeWorldArchive({
    version: decodedReal.version,
    fluid: decodedReal.fluid,
    world: decodedReal.world,
    players: decodedReal.players,
    mobs: decodedReal.mobs,
    ground: decodedReal.ground,
    chunks: decodedReal.chunks,
  });
  ok(bytesEqual(again, real.snapshot), '★ encode(decode(x)) 逐字节 = x(键序/长度/头偏移都没错)');
});

test('FND72-2 解码器对坏字节**抛错并说清哪儿坏**,不是尽力而为', () => {
  const magic = real.snapshot.slice();
  magic[0] = 0x00;
  ok(
    throwsWith(() => decodeWorldArchive(magic), 'magic 改掉').includes('magic'),
    'magic 不对 ⇒ 消息里点名 magic',
  );

  const version = real.snapshot.slice();
  new DataView(version.buffer).setUint32(4, 3, true);
  ok(
    throwsWith(() => decodeWorldArchive(version), '版本改掉').includes('版本'),
    '不认识的版本 ⇒ 点名版本',
  );

  const truncated = real.snapshot.slice(0, real.snapshot.byteLength - 3);
  ok(
    throwsWith(() => decodeWorldArchive(truncated), '截短 3 字节').includes('截断'),
    '块体越界 ⇒ 点名"被截断"',
  );

  /* 尾巴多出来也不行:多出来的字节不是本格式(否则"同一份世界"无从判)。 */
  const padded = new Uint8Array(real.snapshot.byteLength + 4);
  padded.set(real.snapshot, 0);
  ok(
    throwsWith(() => decodeWorldArchive(padded), '尾部补 4 字节').length > 0,
    '尾巴多出字节 ⇒ 抛错',
  );
});

/* ═══════════════════════ 2. 裁剪规则(第 2 段) ═══════════════════════ */

test('FND72-3 小世界:预算够 ⇒ 一块不裁,字节原样返回', () => {
  const fit = fitWorldArchive(real.snapshot, 1048576);
  eq(fit.trimmed, false, '★ 没超上限 ⇒ 不裁');
  eq(fit.report, null, '没裁就没有裁剪报告(不编一份空的)');
  ok(fit.bytes === real.snapshot, '★ 没裁时返回**入参本身**(逐字节可证,不是复制)');

  const plan = planChunkTrim(decodedReal.chunks, 1048576);
  eq(plan.dropped.length, 0, '没有块被裁');
  eq(plan.kept.length, decodedReal.chunks.length, '全部保留');
  ok(plan.reason.includes('预算足够'), `原因要写清"预算足够"(实得 ${plan.reason})`);

  /* 负对照:预算刚好差 1 字节也必须开始裁(边界是逐字节的,不是"大概")。 */
  const tight = planChunkTrim(decodedReal.chunks, decodedReal.bodyBytes - 1);
  ok(tight.dropped.length > 0, '★ 预算少 1 字节 ⇒ 必须裁(否则上限是假的)');
});

test('FND72-4 超预算世界:裁剪后 ≤ 上限、被裁非空、原因可读、玩家建造优先', () => {
  /* 1000 块,其中 i=0 与 i=32(即 (0,0) 与 (0,1))是玩家建造。 */
  const big = makeOversizedArchive(1000, [0, 32]);
  ok(big.byteLength > 1048576, `合成快照必须真的超限(实得 ${big.byteLength})`);
  const fit = fitWorldArchive(big, 1048576);
  ok(fit.trimmed, '★ 超限 ⇒ 裁过');
  const trim = fit.report;
  if (trim === null) throw new Error('裁过必须有报告');
  ok(fit.bytes.byteLength <= 1048576, `★ 裁剪后 ${fit.bytes.byteLength} 字节 ≤ 1048576`);
  ok(trim.droppedChunks > 0, `★ 被裁列表非空(实得 ${trim.droppedChunks})`);
  ok(trim.droppedBytes > 0, '被裁字节数 > 0');
  eq(trim.dropped.length, trim.droppedChunks, '逐块清单条数 = 计数(两处不许对不上)');
  eq(trim.originalBytes, big.byteLength, '报告里的原字节数 = 入参字节数');
  eq(trim.budgetBytes, 1048576, '报告里的预算 = 上限');

  /* 原因**可读**:要能看出优先级与被裁块的下场。 */
  ok(trim.reason.includes('玩家建造'), `原因要点名优先级(实得 ${trim.reason})`);
  ok(trim.reason.includes('原始地形'), '原因要点名"原始地形可重建"那一层');
  ok(trim.reason.includes('不可重建'), '原因要说清被裁块的玩家建造**回不来**');
  eq(trim.rule, 'built>activity>regenerable', '规则标识可被机器判断');

  /* 裁完的字节必须**还能解码**,且块表 = 保留集。 */
  const kept = decodeWorldArchive(fit.bytes);
  eq(kept.chunks.length, trim.keptChunks, '解码出来的块数 = 报告里的保留数');
  ok(kept.trim !== null, '★ 裁剪摘要必须**写进快照头**(以后谁来读都看得出这是裁过的)');
  eq(kept.trim?.droppedChunks, trim.droppedChunks, '头里的 droppedChunks 与报告一致');
  eq(kept.trim?.droppedBytes, trim.droppedBytes, '头里的 droppedBytes 与报告一致');

  /* ★ 玩家建造优先:(0,0) 与 (0,1) 两块建造必须留在保留集里。 */
  const keptKeys = new Set(kept.chunks.map((c) => `${c.cx},${c.cy}`));
  ok(keptKeys.has('0,0'), '★ 建造块 (0,0) 必须保留(裁剪不许裁掉玩家作品)');
  ok(keptKeys.has('0,1'), '★ 建造块 (0,1) 必须保留');

  /* 被裁的块不许"又出现在保留集里"(账要能对)。 */
  for (const d of trim.dropped) {
    ok(!keptKeys.has(`${d.cx},${d.cy}`), `被裁块 (${d.cx},${d.cy}) 不许出现在保留集`);
  }

  /* ★ 规则是**可判定纯函数**:同一输入两次 ⇒ 逐字节同样的输出。 */
  const fit2 = fitWorldArchive(big, 1048576);
  ok(bytesEqual(fit.bytes, fit2.bytes), '★ 同输入两次裁剪 ⇒ 字节完全一致(不许随机/不许按插入顺序)');
  eq(fit2.report?.droppedChunks, trim.droppedChunks, '两次的裁剪计数一致');
});

test('FND72-5 裁剪规则:预算通过 planChunkTrim 逐块判定(全序、无随机)', () => {
  const big = decodeWorldArchive(makeOversizedArchive(200, [7]));
  const body = big.bodyBytes;
  const plan = planChunkTrim(big.chunks, Math.floor(body / 3));
  ok(plan.keptBytes <= plan.budgetBytes, '保留字节 ≤ 块体预算');
  ok(plan.dropped.length > 0, '必然有被裁的块');
  eq(plan.droppedBytes + plan.keptBytes, plan.totalBytes, '★ 裁掉 + 保留 = 全部(字节账不许漏)');
  ok(plan.fits, '装得下(单块比预算大才会 false)');

  /* 建造块 (7%32=7,0) 必须在保留集里。 */
  const keptKeys = new Set(plan.kept.map((c) => `${c.cx},${c.cy}`));
  ok(keptKeys.has('7,0'), '★ 唯一的建造块必须保留');

  /* 重复调用:保留集**逐块**相同(纯函数,不依赖输入顺序)。 */
  const shuffled = big.chunks.slice().reverse();
  const plan2 = planChunkTrim(shuffled, Math.floor(body / 3));
  eq(plan2.kept.map((c) => `${c.cx},${c.cy}`), plan.kept.map((c) => `${c.cx},${c.cy}`),
    '★ 输入顺序反了,保留集必须一样');
});

/* ═══════════════════════ 3. 回滚计划(第 3 段) ═══════════════════════ */

test('FND72-6 回滚计划:按计划应用到空世界 ⟷ 归档前的描述逐字段相等', () => {
  const before = describeDecodedWorld(decodedReal);
  const plan = planRestore(decodedReal, emptyWorldState());
  const applied = applyRestorePlan(plan);
  const diff = diffWorldState(applied, before);
  ok(diff.length === 0, `★ 逐字段相等(差异:${diff.join(' | ')})`);

  /* 世界世代:seed / 帧号 / 钟点 —— 少还一个,"旧世界"就不是同一个。 */
  eq(applied.seed, 4242, '★ 世界 seed 还回去了');
  eq(applied.frame, real.frame, '★ 帧号还回去了');
  eq(applied.hourOfDay, real.hourOfDay, '★ 钟点还回去了');
  eq(applied.roomId, real.roomId, 'roomId 还回去了');
  eq(applied.sizeCells, 32, 'sizeCells 还回去了');

  /* 玩家:位置 + 等级。 */
  eq(applied.players.length, 1, '玩家回来了');
  eq(applied.players[0].x, real.pose.x, '★ 玩家位置 x 还回去了');
  eq(applied.players[0].y, real.pose.y, '玩家位置 y 还回去了');
  eq(applied.players[0].z, real.pose.z, '玩家位置 z 还回去了');
  eq(applied.players[0].level, real.level, '玩家等级还回去了');

  /* 地形:块字节**逐位**还回去(不是"重新生成一份看起来一样的")。 */
  eq(applied.chunks.length, decodedReal.chunks.length, '块数还回去了');
  ok(
    bytesEqual(applied.chunks[0].bytes, decodedReal.chunks[0].bytes),
    '★ 地形 chunk 内容逐字节还回去了',
  );

  /* 计划形状:一条 world + 每个玩家/块/生物/掉落各一条 + v2 的流体水位一条。 */
  eq(
    plan.ops.length,
    1 + decodedReal.players.length + decodedReal.chunks.length
      + decodedReal.mobs.length + decodedReal.ground.length
      + (decodedReal.fluid === null ? 0 : 1),
    'ops 恰好覆盖全部字段(多一条/少一条都要红)',
  );
  eq(plan.ops[0].kind, 'world', '第一条 op 是 world');
  eq(plan.source.seed, 4242, 'source.seed = 旧世界的种子');
  eq(plan.source.frame, real.frame, 'source.frame');
  eq(plan.source.trimmed, false, '这份没裁过');

  /* ★ 格式里没有的东西**不许编**:v2 里 hp **有值** ⇒ 不该进 unavailable;
     真正不可用的只有"这个版本没带"的项(v1 才有 hp 不可用,v2 的判据在 WS-FND-80/81)。 */
  ok(
    !plan.unavailable.some((s) => s.includes('hp')),
    `★ v2 归档里有玩家血量 ⇒ **不该**进 unavailable(实得 ${plan.unavailable.join(' / ')})`,
  );

  /* 纯函数:同一份计划应用两次结果相同;没有 current 也自足。 */
  ok(diffWorldState(applyRestorePlan(plan), applied).length === 0, '同一份计划两次应用结果相同');
  const noCurrent = planRestore(decodedReal, null);
  ok(
    diffWorldState(applyRestorePlan(noCurrent), before).length === 0,
    '★ current=null 时 ops 依然自足(回滚不依赖"当前世界还记得什么")',
  );

  /* current 只影响叙述:与归档一致的当前世界 ⇒ 不该编出 seed 变化。 */
  const same = planRestore(decodedReal, describeDecodedWorld(decodedReal));
  ok(!same.changes.some((s) => s.startsWith('世界 seed')), 'current 与归档一致 ⇒ 不报 seed 变化');
  ok(same.changes.some((s) => s.includes('覆盖')), 'current 有同名块 ⇒ 叙述里要点出"覆盖"');
});

test('FND72-7 裁剪过的归档:回滚计划不伪造缺失块,并把边界写进 unavailable', () => {
  const big = makeOversizedArchive(300, [3]);
  const fit = fitWorldArchive(big, 200000);
  ok(fit.trimmed && fit.report !== null, '200000 字节上限 ⇒ 必然裁过');
  const report = fit.report as NonNullable<typeof fit.report>;
  const trimmed = decodeWorldArchive(fit.bytes);
  eq(trimmed.trim?.dropped.length, 0, '★ 逐块清单**不持久化**(从字节读回时是空数组,省预算)');

  const plan = planRestore(trimmed, null);
  eq(plan.missingChunks, report.droppedChunks, '★ 缺失块数 = 报告里的被裁数');
  eq(plan.source.trimmed, true, '计划来源标注"裁过"');
  eq(
    plan.ops.filter((op) => op.kind === 'chunk').length,
    trimmed.chunks.length,
    '块 op 数 = 归档里真有的块数(一块不多、一块不少)',
  );
  ok(
    plan.unavailable.some((s) => s.includes('裁掉')),
    `★ 被裁块必须写进 unavailable(实得 ${plan.unavailable.join(' / ')})`,
  );

  /* 被裁的块**不许**在计划里出现(否则就是伪造一份地形)。 */
  const droppedKeys = new Set(report.dropped.map((d) => `${d.cx},${d.cy}`));
  for (const op of plan.ops) {
    if (op.kind !== 'chunk') continue;
    ok(!droppedKeys.has(`${op.cx},${op.cy}`), `被裁块 (${op.cx},${op.cy}) 不许出现在计划里`);
  }
  const applied = applyRestorePlan(plan);
  eq(applied.chunks.length, report.keptChunks, '重建出来的块数 = 保留数');
  eq(applied.seed, 777, '合成世界的 seed 还回去了');
});

/* ═══════════════════════ 4. 落库(真 SQLite) ═══════════════════════ */

test('FND72-8 真 SQLite(:memory:):超限的 WSA1 走裁剪落库,字节数与摘要都如实', () => {
  const conn = openNodeSqlite(':memory:');
  const db: DbLike = conn;
  try {
    migrate(db, 1000);
    migrateWorldArchives(db, 1000);
    const big = makeOversizedArchive(1000, [5]);
    ok(big.byteLength > 1048576, `入参必须真的超限(实得 ${big.byteLength})`);

    /* ── 正对照:不再抛,写进去的是**裁过的**字节 ── */
    const out = archiveWorldSnapshot(db, {
      roomId: 'r72',
      seed: 777,
      snapshot: big,
      nowMs: 5000,
      worldTick: 9,
      reason: 'RESET_WORLD(seed 888)',
    });
    ok(out.trim !== undefined, '★ 超限归档不再失败,回执带裁剪报告');
    ok(out.archived.bytes <= 1048576, `★ 落库字节 ${out.archived.bytes} ≤ 1048576`);
    eq(out.trim?.budgetBytes, 1048576, '报告的预算 = 硬上限');
    eq(out.trim?.originalBytes, big.byteLength, '报告记着原字节数(没丢掉"原本多大")');
    eq(out.archived.seed, 777, '归档的 seed 仍是**旧世界**的');

    const loaded = loadWorldArchive(db, out.archived.id);
    ok(loaded !== undefined, '按句柄能取回整行');
    if (loaded === undefined) throw new Error('读口必须给回归档行');
    eq(loaded.snapshot_blob.byteLength, out.archived.bytes, '★ BLOB 长度 = 摘要 bytes');
    eq(loaded.bytes, out.archived.bytes, 'bytes 列与 BLOB 一致');

    const dec = decodeWorldArchive(loaded.snapshot_blob);
    eq(dec.chunks.length, out.trim?.keptChunks, '库里的块数 = 报告里的保留数');
    eq(dec.trim?.droppedChunks, out.trim?.droppedChunks, '★ 裁剪摘要随字节落库(自描述)');
    eq(dec.world.seed, 777, '库里的世界 seed');

    /* ── 负对照:不是 WSA1 的超大字节仍然**拒绝**(没有块可裁,不许截断) ── */
    const notWsa = new Uint8Array(1048577);
    const msg = throwsWith(() => archiveWorldSnapshot(db, {
      roomId: 'r72', seed: 1, snapshot: notWsa, nowMs: 6000,
    }), '非 WSA1 的超限字节');
    ok(msg.includes('1048576'), `拒绝理由要点出上限(实得 ${msg})`);
    eq(countWorldArchives(db, 'r72'), 1, '★ 拒绝之后仍是 1 行(没有写进去半份)');
  } finally {
    conn.close();
  }
});

/* ═══════════════════════ 5. 动作层回执(收尾) ═══════════════════════ */

type ResetHostResult = {
  applied: boolean;
  seed: number;
  reason?: string;
  archive?: { id: string; seed: number; archived_at: number; bytes: number } | null;
  archiveError?: string;
  archiveTrim?: { droppedChunks?: unknown; droppedBytes?: unknown; reason?: unknown } | null;
};

/** 只够本动作用的最小 `ActionContext`(与 WS-FND-57 同一手法)。 */
function makeCtx(reset: (o: { seed: number }) => ResetHostResult): ActionContext {
  const ctx = {
    actorId: 'p1',
    action: 'RESET_WORLD',
    payload: { confirm: true, seed: 888 },
    state: {},
    host: { resetWorld: reset },
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: (_a: string, _b: string, reason?: string) => ({
      ok: false, kind: 'PERMISSION', reason: reason ?? 'PERMISSION',
    }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: () => ({ ok: true, applied: [], rejected: [] }),
    grantItemSource: () => undefined,
    setMemberRole: () => ({ ok: false }),
    kick: () => ({ ok: false }),
    setAccess: () => ({ ok: false }),
    setPartyModeBy: () => ({ ok: false }),
    close: () => false,
  };
  return ctx as unknown as ActionContext;
}

test('FND72-9 回执:archive 三态不变 + 新增"被裁多少 / 为什么",且没归档时不谈裁剪', () => {
  const archived = resetWorld(makeCtx(() => ({
    applied: true,
    seed: 888,
    archive: { id: 'r72#2', seed: 777, archived_at: 7000, bytes: 700000 },
    archiveTrim: { droppedChunks: 12, droppedBytes: 4096, reason: '超预算:地形 1234567 字节 > 块体预算 …' },
  })));
  eq(archived.effect?.archive, 'ARCHIVED', '归档三态不变');
  eq(archived.effect?.archiveBytes, 700000, '★ archiveBytes = **落库**字节(裁后那份)');
  eq(archived.effect?.seed, 888, 'effect.seed 仍是**新**种子(原口径不改)');
  eq(archived.effect?.archiveTrim, 'TRIMMED', '★ 裁过 ⇒ TRIMMED');
  eq(archived.effect?.archiveDroppedChunks, 12, '被裁块数如实');
  eq(archived.effect?.archiveDroppedBytes, 4096, '被裁字节数如实');
  ok(
    String(archived.effect?.archiveTrimReason).includes('预算'),
    `原因必须原样转述(实得 ${String(archived.effect?.archiveTrimReason)})`,
  );

  const intact = resetWorld(makeCtx(() => ({
    applied: true,
    seed: 888,
    archive: { id: 'r72#3', seed: 777, archived_at: 7000, bytes: 1438 },
    archiveTrim: { droppedChunks: 0, droppedBytes: 0 },
  })));
  eq(intact.effect?.archiveTrim, 'INTACT', '没裁 ⇒ INTACT');
  eq(intact.effect?.archiveDroppedChunks, 0, '没裁就是 0(不是缺字段)');
  eq(intact.effect?.archiveTrimReason, undefined, '没原因就不编一句');

  const unreported = resetWorld(makeCtx(() => ({
    applied: true,
    seed: 888,
    archive: { id: 'r72#4', seed: 777, archived_at: 7000, bytes: 1438 },
  })));
  eq(unreported.effect?.archiveTrim, 'UNREPORTED', '★ 宿主没报告 ≠ 没裁');
  eq(unreported.effect?.archiveDroppedChunks, undefined, '没报告就没有数字');

  const half = resetWorld(makeCtx(() => ({
    applied: true,
    seed: 888,
    archive: { id: 'r72#5', seed: 777, archived_at: 7000, bytes: 1438 },
    archiveTrim: { droppedChunks: 3 },
  })));
  eq(half.effect?.archiveTrim, 'UNREPORTED', '半截报告 ⇒ 当没报告(不猜 droppedBytes)');

  const notArchived = resetWorld(makeCtx(() => ({
    applied: true,
    seed: 888,
    archive: null,
    archiveTrim: { droppedChunks: 5, droppedBytes: 100 },
  })));
  eq(notArchived.effect?.archive, 'NOT_ARCHIVED', '明确没归档');
  eq(
    notArchived.effect?.archiveTrim,
    undefined,
    '★ 没归档就不谈裁剪(否则"没归档"看起来像"归档但裁了")',
  );
});
report('WS-FND-72');