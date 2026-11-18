/**
 * WS-FND-100 · R14(`applyRestore` 坏档分类 + 「失败时世界一字未改」)
 *            + R18(流体预算打满 ⇒ 只延后流动、不丢水位,并有可判定指标)
 *
 * 台账:`docs/AUDIT-R-ITEMS.md` 的 R14 / R18(两条都是「登记(P3)」)。
 *
 * ## 判据(8 条;每条都带负对照或注入)
 *
 * ```
 * 1 成功路径的负对照:同一份计划 ok:true 且**不带** code(分类器不是常失败)
 * 2 坏档·形态 A:bytes 短于 1024 ⇒ code 'bad-archive',不抛、世界一字未改
 * 3 坏档·形态 B(注入):对**合法块体**只改 2 个字节(屋顶 RLE 0xff 截断)
 *   ⇒ 仍然 'bad-archive';同一份字节不改就解得开(证明是那 2 字节坏的)
 * 4 形状不对:null / 空 ops / chunk 缺 bytes / player.id 不是字符串 / 未知 kind
 *   ⇒ 'shape',世界一字未改
 * 5 尺寸不符:world.sizeCells / fluid 边界 ⇒ 'size',世界一字未改
 * 6 内部异常(注入):op 上读 `cx` 就抛 ⇒ 'internal'(而不是被说成坏档),
 *   且因为闸是纯读 ⇒ 世界一字未改
 * 7 预算打满(手算):4×4 场、两格 400 水 ⇒ 活跃集 8 格;budget 3 ⇒
 *   deferredCells = 5、水位守恒、被延后的格仍在活跃集;负对照 budget 16 ⇒ 0
 * 8 延后不是丢失:16×16 一行 500 水跑 120 帧 × 额度 4 ⇒ 逐帧总账守恒、
 *   湿区扩大;编排层 `lastFluidDeferredCells` 在 fluidBudget=2 时 > 0、默认预算时 = 0
 * ```
 *
 * ## 期望值从哪来(不抄被测模块)
 *
 * - 分类码写**字面量** `'shape' / 'size' / 'bad-archive' / 'internal'`
 *   (只额外断言 `RESTORE_FAIL` 这四个常量确实是这些字面量 —— 契约本身);
 * - 块体快照布局是**冻结契约**:`[0,1024)` 打包单元、`[1024,1120)` 三张位图、
 *   `[1120,1144)` 头、`[1144,...)` 屋顶 RLE ⇒ 手写字面量 1120 / 1136 / 1144;
 * - 活跃集 8 格是**手算**的:`setCell(1,1)` 标 5 格、`setCell(2,1)` 标 5 格、
 *   并集去重 = 8;budget 3 ⇒ 5 格没轮到;
 * - 水位 / 帧号 / 种子 / 家具 id 全是夹具里写死的值(800 / 8000 / 7 / 4242 / 351)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { WorldSim, RESTORE_FAIL } from '../server/src/sim/world_sim.ts';
import { FluidField } from '../server/src/world/fluid.ts';
import { Chunk, idx } from '../server/src/world/chunk.ts';
import { packTile } from '../shared/types/tile.ts';
import {
  decodeWorldArchive,
  encodeWorldArchive,
  planRestore,
  type RestorePlan,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 夹具(全是手写常量)═══════════════════════ */

const SIZE = 32;
const MARK_X = 3;
const MARK_Y = 4;
const FURNITURE = 351; /* 暖松原木圆墙(内容表 351):玩家建造物,seed 重建不出来 */
const CURRENT_OBJ = 201; /* 当前世界那一格的**另一个**物件(用来区分"有没有被重建") */
const WATER_X = 5;
const WATER_Y = 6;
const ARCHIVE_WATER = 700;
const CURRENT_WATER = 250;
const ARCHIVE_SEED = 4242;
const CURRENT_SEED = 999;
const ARCHIVE_FRAME = 7;

/** 块体快照的冻结布局(见文件头):位图区结束 = 1024 + 32*3。 */
const SNAPSHOT_HEAD = 1120;
const RLE_LEN_AT = SNAPSHOT_HEAD + 16; /* 1136:屋顶 RLE 长度字段 */
const RLE_AT = SNAPSHOT_HEAD + 24; /* 1144:屋顶 RLE 起点 */

/** 只在本套件的「坏计划」用例里用:把任意数据当计划喂进去(故意绕类型)。 */
function asPlan(v: unknown): RestorePlan {
  return v as RestorePlan;
}

/** 一块真实的地形块体(生产同一个 `serializeSnapshot`,不是手搓字节)。 */
function chunkBlob(cx: number, cy: number, built: boolean): Uint8Array {
  const c = new Chunk(cx, cy);
  if (built) {
    c.cells[idx(MARK_X, MARK_Y)] = packTile({
      elev: 0, base: 0, floor: 0, wire: 0, obj: FURNITURE, meta: 0,
    });
  }
  return c.serializeSnapshot();
}

/**
 * 一份**合法的**回滚计划(走生产编码器 → 解码器 → `planRestore`)。
 * 世界身份:种子 4242 / 帧号 7 / 边长 32;p1 3 级 73.5 血;水位 (5,6)=700。
 */
function buildPlan(): RestorePlan {
  const bytes = encodeWorldArchive({
    world: {
      roomId: 'r_fnd100', seed: ARCHIVE_SEED, sizeCells: SIZE,
      biome: 'MEADOW', frame: ARCHIVE_FRAME, hourOfDay: 6.25,
    },
    players: [{ id: 'p1', x: 1.5, y: 2.5, z: 0, level: 3, hp: 73.5 }],
    fluid: {
      width: SIZE, height: SIZE,
      levels: [{ x: WATER_X, y: WATER_Y, amount: ARCHIVE_WATER }],
    },
    mobs: [],
    ground: [],
    chunks: [
      { cx: 0, cy: 0, bytes: chunkBlob(0, 0, true) },
      { cx: 1, cy: 0, bytes: chunkBlob(1, 0, false) },
    ],
  });
  return planRestore(decodeWorldArchive(bytes), null);
}

const PLAN = buildPlan();
/** 计划里第一块地形的 op(注入用例要拿它的合法字节/形状来改一处)。 */
const PLAN_CHUNK = PLAN.ops.find((op) => op.kind === 'chunk');

/**
 * 当前世界:**故意与归档不同**(另一件家具 / 另一个种子 / 两名玩家 / 半格水),
 * 于是「失败时世界一字未改」有牙齿:任何一条闸漏在 `rebuildWorld` 之后,
 * 下面 `snap()` 的每一项都会变。
 */
function makeCurrent(): WorldSim {
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: CURRENT_SEED });
  sim.addPlayer('p1', 2.5, 3.5);
  sim.addPlayer('p2', 6.5, 7.5);
  sim.setCell(MARK_X, MARK_Y, { obj: CURRENT_OBJ });
  /* 先把流体层的 `solid` 清成 0(世界生成的物件会投影成实心),再注水;
     否则 `setCell({ amount })` 会以「向实心格注水」拒绝。 */
  sim.setCell(WATER_X, WATER_Y, { obj: 0 });
  sim.fluid.setCell(WATER_X, WATER_Y, { amount: CURRENT_WATER });
  sim.advance(3);
  return sim;
}

/** 「世界一字未改」的可判定快照(身份 / 时钟 / 地形 / 玩家 / 水位 / 活跃集)。 */
function snap(sim: WorldSim): Record<string, unknown> {
  return {
    frame: sim.frame,
    seed: sim.worldSeed,
    block: sim.blockAt(MARK_X, MARK_Y),
    p1: sim.poseOf('p1'),
    p2: sim.poseOf('p2'),
    water: sim.fluid.amountAt(WATER_X, WATER_Y),
    total: sim.fluid.total(),
    active: sim.fluid.activeCount,
  };
}

/**
 * 把一份坏计划喂进去,断言四件事:**不抛** / `ok:false` / 分类码 / **世界一字未改**。
 * 返回 reason(负对照不用它,但断言它不是空串)。
 */
function expectReject(what: string, plan: unknown, code: string): string {
  const sim = makeCurrent();
  const before = snap(sim);
  const r = sim.applyRestore(asPlan(plan));
  eq(r.ok, false, `${what}:必须拒绝(而且**不抛**)`);
  eq(r.code, code, `${what}:分类码`);
  eq(snap(sim), before, `${what}:★ 世界一字未改(帧/种子/地形/玩家/水位/活跃集)`);
  const reason = r.reason ?? '';
  ok(reason.length > 0, `${what}:reason 不能是空串`);
  return reason;
}

/** 把计划里第一块地形换成别的字节(其余 op 原样)。 */
function withChunkBytes(plan: RestorePlan, bytes: Uint8Array): RestorePlan {
  return {
    ...plan,
    ops: plan.ops.map((op) => (op.kind === 'chunk' && op.cx === 0 && op.cy === 0
      ? { ...op, bytes }
      : op)),
  };
}

/** 把世界身份/流体边界改一处(其余 op 原样)。 */
function withWorld(
  plan: RestorePlan,
  patch: { sizeCells?: number },
): RestorePlan {
  return {
    ...plan,
    ops: plan.ops.map((op) => (op.kind === 'world' ? { ...op, ...patch } : op)),
  };
}

/* ═══════════ 1. 负对照:合法计划必须走成功路径,且**不带** code ═══════════ */

test('FND100-1 ★负对照:合法计划 ok:true、code 缺席、四类世界世代都落地', () => {
  /* 怎么变红:
       · 分类代码把成功路径也说成失败 ⇒ 第 1/2 条;
       · 预解码把块体解坏 / 换成别的坐标 ⇒ 第 6 条(地形);
       · 水位 op 被跳过 ⇒ 第 5 条;
       · 玩家 op 没应用 ⇒ 第 4 条。 */
  eq(RESTORE_FAIL.SHAPE, 'shape', '分类码字面量(契约本身)');
  eq(RESTORE_FAIL.SIZE, 'size', '分类码字面量(契约本身)');
  eq(RESTORE_FAIL.BAD_ARCHIVE, 'bad-archive', '分类码字面量(契约本身)');
  eq(RESTORE_FAIL.INTERNAL, 'internal', '分类码字面量(契约本身)');

  const sim = makeCurrent();
  const r = sim.applyRestore(PLAN);
  ok(r.ok, `合法计划必须应用成功(${r.reason ?? ''})`);
  eq(r.code, undefined, '★ 成功路径**不带** code 键');
  eq(r.applied?.chunks, 2, '两块地形');
  eq(r.applied?.players, 1, '一个玩家');
  eq(r.applied?.fluid, 1, '一条水位 op');
  eq(r.applied?.seed, ARCHIVE_SEED, '种子回到归档那一版');
  eq(r.applied?.frame, ARCHIVE_FRAME, '帧号回到归档值');
  eq(sim.blockAt(MARK_X, MARK_Y), FURNITURE, '★ 地形真的搬回来了(内容表 351)');
  eq(sim.fluid.amountAt(WATER_X, WATER_Y), ARCHIVE_WATER, '★ 水位真的铺回来了');
  ok(sim.fluid.activeCount > 0, '水位经 `setCell` 写 ⇒ 活跃集被重建(下一帧会流动)');
  eq(sim.poseOf('p1'), { x: 1.5, y: 2.5, z: 0 }, '玩家按归档坐标重建');
  eq(sim.poseOf('p2'), null, '归档里没有的玩家不该留在世界(先清空再重建)');
});

/* ═══════════ 2/3. 坏档:两种形态,都不抛、都不改世界 ═══════════ */

test('FND100-2 坏档·形态 A:bytes 短于 1024 ⇒ `bad-archive`,世界一字未改', () => {
  const reason = expectReject(
    'bytes=10',
    withChunkBytes(PLAN, new Uint8Array(10)),
    'bad-archive',
  );
  ok(reason.includes('坏档'), `理由要点名坏档(${reason})`);
});

test('FND100-3 ★注入:合法块体只坏 2 个字节(屋顶 RLE 截断)⇒ 仍 `bad-archive`', () => {
  /* 这是「解码真的被跑了」的注入验证:字节长度、坐标、形状都合法,
     坏的只是内容 —— 改前这条路会在 `rebuildWorld` **之后**抛 RangeError。
     负对照:同一份字节不改这两处就解得开(证明是那 2 字节坏的)。 */
  const clean = chunkBlob(0, 0, true);
  eq(clean.byteLength, 1147, '前提:空屋顶的块体 = 1024+96+24+3 字节');
  const broken = clean.slice();
  broken[RLE_LEN_AT] = 1; /* 屋顶 RLE 声称 1 字节 */
  broken[RLE_AT] = 0xff; /* 0xff 需要 3 字节 ⇒ decodeRoofRle 抛 RangeError */

  /* 负对照:同一布局、不改字节 ⇒ 解得开 */
  ok(Chunk.deserializeSnapshot(clean) instanceof Chunk, '未改的字节必须解得开');
  let threw = false;
  try {
    Chunk.deserializeSnapshot(broken);
  } catch {
    threw = true;
  }
  ok(threw, '★ 注入生效:被改 2 字节的块体解不开(否则这条注入没有牙齿)');

  const reason = expectReject('RLE 截断', withChunkBytes(PLAN, broken), 'bad-archive');
  ok(reason.includes('坏档'), `理由要点名坏档(${reason})`);
});

/* ═══════════ 4. 形状不对 ⇒ `shape` ═══════════ */

test('FND100-4 ★负对照:五种形状错误全部 `shape`,不抛、世界一字未改', () => {
  expectReject('null 计划', null, 'shape');
  expectReject('空 ops', { ops: [] }, 'shape');
  expectReject('chunk 缺 bytes', {
    ...PLAN,
    ops: PLAN.ops.map((op) => (op.kind === 'chunk' && op.cx === 0 ? { kind: 'chunk', cx: 0, cy: 0 } : op)),
  }, 'shape');
  expectReject('player.id 非字符串', {
    ...PLAN,
    ops: PLAN.ops.map((op) => (op.kind === 'player' ? { ...op, id: 42 } : op)),
  }, 'shape');
  expectReject('未知 op.kind', {
    ...PLAN,
    ops: [...PLAN.ops, { kind: 'nope' }],
  }, 'shape');
});

/* ═══════════ 5. 尺寸不符 ⇒ `size`(与既有 WS-FND-78/81 同一道闸)═══════════ */

test('FND100-5 ★负对照:世界边长 / 流体场边界不符 ⇒ `size`,世界一字未改', () => {
  const sizeReason = expectReject('sizeCells=16', withWorld(PLAN, { sizeCells: 16 }), 'size');
  ok(sizeReason.includes('边长'), `理由要点名边长(${sizeReason})`);

  const fluidReason = expectReject('fluid 宽度=16', {
    ...PLAN,
    ops: PLAN.ops.map((op) => (op.kind === 'fluid' ? { ...op, width: 16 } : op)),
  }, 'size');
  ok(fluidReason.includes('流体'), `理由要点名流体场(${fluidReason})`);
});

/* ═══════════ 6. 内部异常 ⇒ `internal`(注入:读 cx 就抛)═══════════ */

test('FND100-6 ★注入:闸内意外抛错归 `internal`,不是坏档,世界一字未改', () => {
  /* 为什么需要这条:如果实现把「一切异常」都说成坏档,调用方就无法区分
     「存档坏了(可换一份重试)」与「代码缺陷(重试也没用)」。
     注入方式:把 chunk op 包成 Proxy,一读 `cx` 就抛 TypeError ——
     形状闸是**纯读**且在任何写入之前,所以世界仍然一字未改。 */
  ok(PLAN_CHUNK !== undefined && PLAN_CHUNK.kind === 'chunk', '前提:计划里有 chunk op');
  if (PLAN_CHUNK === undefined || PLAN_CHUNK.kind !== 'chunk') return;
  const boom = new Proxy({ ...PLAN_CHUNK }, {
    get(target, key) {
      if (key === 'cx') throw new TypeError('注入:读 cx 就抛');
      return Reflect.get(target, key);
    },
  });
  const plan = {
    ...PLAN,
    ops: PLAN.ops.map((op) => (op === PLAN_CHUNK ? boom : op)),
  };
  const reason = expectReject('Proxy(cx)', plan, 'internal');
  ok(reason.includes('内部异常'), `理由要点名内部异常(${reason})`);
});

/* ═══════════ 7. R18:预算打满的手算判据(4×4 场)═══════════ */

/** 4×4 场,两格各 400:活跃集 = 5 ∪ 5 去重 = **8 格**(手算)。 */
function smallWet(): FluidField {
  const f = new FluidField(4, 4);
  f.setCell(1, 1, { amount: 400 });
  f.setCell(2, 1, { amount: 400 });
  return f;
}

test('FND100-7 ★预算打满:deferredCells=7、residual 水位 400 没丢、没轮到的格留在活跃集', () => {
  /* 怎么变红:
       · 预算耗尽时把「没轮到的格」当垃圾摘掉 ⇒ 第 6 条(活跃集缩水);
       · 顺手把 amount 清零 / 重算 ⇒ 第 5 条(总水量变);
       · 指标写死 0 或恒等于 active ⇒ 第 4 条与负对照(第 8 条)至少一条。

     手算(活跃集 8 格的插入序 = `[5,6,4,9,1,7,10,2]`,游标从 0 起):
     额度 1 ⇒ 只服务 index 5 = (1,1)(湿),**另一格湿的** index 6 = (2,1)
     还没轮到 ⇒ 7 格里含 400 毫格水。这条正是「延后的是流动,不是水位」。 */
  const f = smallWet();
  eq(f.activeCount, 8, '前提(手算):2 格水 + 各自四邻去重 = 8 个活跃格');
  const before = f.total();
  eq(before, 800, '前提:400 + 400');

  const r = f.step(1);
  eq(r.active, 8, '本帧开始时的活跃格数');
  eq(r.processed, 1, '额度 1 格');
  eq(r.deferredCells, 7, '★ 8 − 1 = 7 格本该推进却没轮到(R18 指标)');
  eq(r.deferredAmount, 400, '★ 被延后的格里**还存着** 400 毫格水(没被清零)');
  eq(f.total(), before, '★ 这一帧水位一分没丢(延后,不是清零)');
  ok(f.activeCount >= r.deferredCells, `★ 没轮到的格仍在活跃集(active=${f.activeCount} ≥ ${r.deferredCells})`);
  ok(r.moved > 0, `额度内的格仍然流动(moved=${r.moved}),不是"水不动"`);
  eq(r.truncated, true, '额度 < 全图 ⇒ truncated');

  /* ★负对照:同一份夹具、额度够(16 = 全图)⇒ 指标必须归零(不是常量)。 */
  const f2 = smallWet();
  const r2 = f2.step(16);
  eq(r2.deferredCells, 0, '★负对照:额度够 ⇒ deferredCells = 0');
  eq(r2.deferredAmount, 0, '★负对照:额度够 ⇒ deferredAmount = 0');
  eq(r2.truncated, false, '额度 ≥ 格数 ⇒ 不截断');
  eq(f2.total(), 800, '大额度也不丢水');
});

/* ═══════════ 8. R18:延后不是丢失(逐帧守恒 + 湿区扩大 + 编排层指标)═══════════ */

test('FND100-8 ★延后不是丢失:120 帧 × 额度 4 逐帧守恒;编排层看得见 deferred', () => {
  const W = 16;
  const f = new FluidField(W, W);
  for (let x = 0; x < W; x += 1) f.setCell(x, 8, { amount: 500 });
  const total = f.total();
  eq(total, 8000, '前提:16 格 × 500');

  let moved = 0;
  let deferredSeen = 0;
  for (let i = 0; i < 120; i += 1) {
    const r = f.step(4);
    moved += r.moved;
    deferredSeen += r.deferredCells;
    eq(f.total(), total, `第 ${i} 帧:总水量必须守恒(延后不丢水位)`);
  }
  ok(moved > 0, `★ 额度 4 也真的在流(moved=${moved})`);
  ok(deferredSeen > 0, `★ 指标确实看见了延后(累计 ${deferredSeen} 格)`);
  ok(f.activeCount > 4, `活跃集仍大于额度(active=${f.activeCount})`);

  /* 湿区扩大:原本干的格现在有水 —— 「延后」的平均代价只是变慢。 */
  let wet = 0;
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (f.amountAt(x, y) > 0) wet += 1;
    }
  }
  ok(wet > W, `★ 水真的扩散了(湿格 ${wet} > 起始 16)`);
  eq(f.grandTotal(), total, '总账(含相变销毁项)也守恒');

  /* ── 编排层:指标必须被 `WorldSim` 暴露出来(否则判据看不见)── */
  const sim = new WorldSim({ sizeCells: 8, mobs: false, wiring: false, fluidBudget: 2, seed: 7 });
  sim.setCell(2, 2, { obj: 0 });
  sim.setCell(4, 2, { obj: 0 });
  sim.fluid.setCell(2, 2, { amount: 600 });
  sim.fluid.setCell(4, 2, { amount: 600 });
  const simTotal = sim.fluid.total();
  sim.advance(10); /* 第 10 帧 = 2Hz 慢帧 */
  ok(
    sim.lastFluidDeferredCells > 0,
    `★ 编排层可判定:预算 2 打满 ⇒ lastFluidDeferredCells=${sim.lastFluidDeferredCells}`,
  );
  eq(sim.fluid.total(), simTotal, '★ 延后不丢水位(编排层口径)');

  /* ★负对照:默认预算(1024 ≥ 8×8)⇒ 该指标必须为 0。 */
  const wide = new WorldSim({ sizeCells: 8, mobs: false, wiring: false, seed: 7 });
  wide.setCell(2, 2, { obj: 0 });
  wide.fluid.setCell(2, 2, { amount: 600 });
  wide.advance(10);
  eq(wide.lastFluidDeferredCells, 0, '★负对照:额度够 ⇒ 编排层指标 = 0');
  eq(wide.fluid.total(), 600, '水位不变');
});

report('WS-FND-100');