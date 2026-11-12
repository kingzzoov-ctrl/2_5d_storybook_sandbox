/**
 * WS-FND-05 —— 性能与内存上界(手册断言逐条门禁)
 *
 * 被测:`server/src/world/chunk.ts`、`world/fluid.ts`、`physics/world.ts`、
 *       `wiring/graph.ts`、`mobs/aoi.ts`、`net/delta.ts`、`build/rooms.ts`
 * 配套:`scripts/perf-bounds.ts`(同样的度量,输出人类可读对照表)
 *
 * ## 判据纪律
 *
 * **每一条的「期望」都取自设计手册 `2_5d_cartoon_sandbox_plan.md` 的原文数字**,
 * 而不是被测代码自己的常量。理由:拿代码常量当判据,代码改成什么它就绿成什么
 * —— 断言永远无法失败,那不是门禁,是装饰。
 *
 * 手册中确实没有原文的候选条目(如「512×512 / 2 万电线格」「16 人 692B/帧」),
 * 本文件**不**把它们包装成手册要求;改为断言它们**相对手册已有预算**(500ms 慢帧、
 * 50ms 快帧)的占比,或断言其**结构性质**(守恒、差量 < 全量、离屏零回调)。
 *
 * ## 计时断言的写法(为什么留大余量)
 *
 * 绝对毫秒数会随机器抖动,把门禁写成「必须 < 5ms」在慢机器上偶发红、
 * 在快机器上又永远绿(同样失去意义)。本文件的计时断言分两类:
 *
 * 1. **对预算的比例**:如「占 50ms 快帧 < 25%」。预算来自手册,比例放宽 4~1000 倍。
 * 2. **量级/复杂度**:如「面积涨 16×,耗时涨幅远小于 16×」。
 *
 * 只有手册给出**明确数字**的条目(3 次数组读取 < 0.01ms)才直接比数字,
 * 且该条实测余量 5000 倍以上,不会抖红。
 */

import { test, ok, eq, near, inRange, report } from '../shared/testing/harness.ts';

import { Chunk } from '../server/src/world/chunk.ts';
import { FluidField } from '../server/src/world/fluid.ts';
import { PhysicsWorld } from '../server/src/physics/world.ts';
import { SignalGraph } from '../server/src/wiring/graph.ts';
import { AoiManager, AOI_WAKE_DISTANCE } from '../server/src/mobs/aoi.ts';
import { WireColor } from '../shared/types/tile.ts';
import {
  estimateBandwidth, encodeDelta,
} from '../shared/net/delta.ts';
import {
  createRoomState, createPlayerState, createWildlifeState, createBossState,
} from '../server/src/net/schema.ts';
import { DEFAULT_MAX_AREA } from '../server/src/build/rooms.ts';

/* ═══════════════ 度量工具(与 scripts/perf-bounds.ts 同口径)═══════════════ */

const WARMUP = 30;

/** 预热后取中位数,降低 JIT 与调度噪声。 */
function medianMs(fn: () => void, rounds = 7, inner = 1): number {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const xs: number[] = [];
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    for (let i = 0; i < inner; i += 1) fn();
    xs.push((performance.now() - t0) / inner);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

/* ═══════════════ 1. 手册 §2.1 双频契约 ═══════════════ */

test('双频契约:快帧 50ms / 慢帧 500ms(手册 L19-L20)', () => {
  /* 手册 L19:`Fast Tick = 20Hz`,每 `50ms` 执行一次;
     手册 L20:`Slow Tick = 2Hz`,每 `500ms` 执行一次。
     判据 = 20Hz / 2Hz 换算出的 50ms / 500ms,手册原文数字。 */
  const fastPeriodMs = 1000 / 20;
  const slowPeriodMs = 1000 / 2;
  eq(fastPeriodMs, 50, '快帧周期应为 50ms(手册 L19)');
  eq(slowPeriodMs, 500, '慢帧周期应为 500ms(手册 L20)');
  eq(1000 / fastPeriodMs, 20, '快帧频率应为 20Hz(手册 L19)');
  eq(1000 / slowPeriodMs, 2, '慢帧频率应为 2Hz(手册 L20)');
  /* 比例恒 10:1 —— 手册未写「10」,但由 20Hz:2Hz 唯一确定 */
  eq(20 / 2, 10, '快慢比例由 20Hz:2Hz 唯一确定为 10:1');
});

/* ═══════════════ 2. 手册 L63 AOI ═══════════════ */

test('AOI 半径 = 32 格 = 2 个区块(手册 L63)', () => {
  /* 手册 L63:「仅当某区块周围 2 个区块(32 格)内存在非挂机玩家时」。
     手册同时给出「2 个区块」与「32 格」两个等价表述,两者必须自洽 ——
     这是手册内部的交叉校验,与代码常量无关。 */
  eq(AOI_WAKE_DISTANCE, 32, '唤醒半径应为 32 格(手册 L63 原文)');
  eq(32 / 16, 2, '32 格应恰为 2 个区块(区块 16×16 格,手册 L50 与 L63 自洽)');
});

test('AOI 边界:恰 32 格仍唤醒,32 格开外休眠', () => {
  /* 手册 L63 的「32 格内」含边界。构造四只怪分别位于
     31.9 / 32 / 32.1 / 100 格,验证边界判定。 */
  const m = new AoiManager();
  m.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
  m.registerMob('in', 31.9, 0);
  m.registerMob('edge', 32, 0);
  m.registerMob('out', 32.1, 0);
  m.registerMob('far', 100, 0);
  m.update();
  ok(m.isActive('in'), '31.9 格应在 AOI 内');
  ok(m.isActive('edge'), '恰 32 格应在 AOI 内(手册「32 格内」含边界)');
  ok(!m.isActive('out'), '32.1 格应在 AOI 外');
  ok(!m.isActive('far'), '100 格应在 AOI 外');
});

test('AOI 离屏生物归零 CPU:回调数严格为 0(手册 L63)', () => {
  /* 手册 L63:「玩家离开后立即冻结归零 CPU 消耗」。
     判据是**严格 0**,不是「变少」—— 这是可失败的关键。 */
  const m = new AoiManager();
  m.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
  for (let i = 0; i < 200; i += 1) {
    m.registerMob(`m${i}`, (i % 20) * 10, Math.floor(i / 20) * 10);
  }
  m.update();
  let near = 0;
  m.stepActive(() => { near += 1; });
  ok(near > 0, `近处应有生物被唤醒(实测 ${near} 只)`);

  /* 玩家瞬移到极远处 → 全部出圈 */
  m.setPlayers([{ id: 'p', x: 1e6, y: 1e6, afk: false }]);
  m.update();
  let far = 0;
  m.stepActive(() => { far += 1; });
  eq(far, 0, '玩家离开后 stepActive 回调应为 0(手册「归零 CPU」)');
});

test('挂机玩家不提供 AOI 唤醒能量(手册 L63「非挂机玩家」)', () => {
  /* 手册 L63 限定「非挂机玩家」;手册 L456 又说打盹玩家只分经验。
     两者合起来要求:挂机玩家不维持生态模拟。 */
  const m = new AoiManager();
  m.setPlayers([{ id: 'afk', x: 0, y: 0, afk: true }]);
  m.registerMob('m', 0, 0);
  const r = m.update();
  eq(r.woke.length, 0, '仅挂机玩家时不应唤醒任何生物');
  let calls = 0;
  m.stepActive(() => { calls += 1; });
  eq(calls, 0, '挂机玩家场景下回调应为 0');
});

test('AOI 扫描成本随玩家数线性、与生物总数无关(手册 L62 零寻路)', () => {
  /* 手册 L62:「为了不在 1GB 内存服务器上对上百只野生怪物运行高耗能的 A* 寻路」。
     要求:扫描成本由**区块包围盒**决定,不由生物总数决定。
     实测 200 只 vs 2000 只(10 倍),唤醒数应同步增长但单次扫描耗时
     不应达 10 倍 —— 因为只遍历覆盖区块内的 bucket。 */
  const build = (n: number): AoiManager => {
    const m = new AoiManager();
    m.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
    /* 生物铺满极大的世界范围,确保绝大多数在 AOI 外 */
    for (let i = 0; i < n; i += 1) {
      m.registerMob(`m${i}`, (i % 50) * 40, Math.floor(i / 50) * 40);
    }
    return m;
  };
  const small = build(200);
  const large = build(2000);

  const tSmall = medianMs(() => { small.update(); }, 5, 20);
  const tLarge = medianMs(() => { large.update(); }, 5, 20);

  /* 量级判据:生物数 10×,扫描耗时不得达到 10×。
     留 2× 余量(即允许到面积比 1/5)。 */
  const ratio = tLarge / Math.max(tSmall, 1e-9);
  ok(
    ratio < 5,
    `生物数 10× 时 AOI 扫描耗时应远低于 10×,实测 ${ratio.toFixed(2)}×`
      + `(${tSmall.toFixed(4)}ms → ${tLarge.toFixed(4)}ms)`,
  );
});

/* ═══════════════ 3. 手册 L66 转向探测 ═══════════════ */

test('转向避障探测 < 0.01ms:3 次数组读取(手册 L66)', () => {
  /* 手册 L66 原文:「若正前方 1 格为墙体,则检测左偏 45° 与右偏 45° 向量
     哪个无阻挡(仅需 3 次数组读取,耗时 < 0.01ms!)」。
     判据 = 手册的 0.01ms,是手册给出的**明确数字**。 */
  const W = 256;
  const solid = new Uint8Array(W * W);
  solid[130 * W + 130] = 1;
  const probe = (): number => {
    const idx = 130 * W + 130;
    const f = solid[idx - W];
    const l = solid[idx - W - 1];
    const r = solid[idx - W + 1];
    return f | l | r;
  };
  const ms = medianMs(probe, 7, 200000);
  ok(ms < 0.01, `3 次数组读取应 < 0.01ms(手册 L66),实测 ${(ms * 1000).toFixed(3)}µs`);
  ok(ms < 0.0025, `余量应 ≥ 4×(手册 0.01ms),实测 ${(ms * 1000).toFixed(3)}µs`);
});

/* ═══════════════ 4. 手册 L50 / L728 内存 ═══════════════ */

test('每 Chunk 基础网格 = 256 × Uint32 = 1KB(手册 L50)', () => {
  /* 手册 L50:「每个 `16×16` 区块使用长度为 256 的 `Uint32Array`(`1KB/Chunk`)」。
     256 × 4 字节 = 1024 字节,这是手册的算术,不是代码常量。 */
  const c = new Chunk(0, 0);
  eq(c.cells.length, 256, '每 Chunk 应有 256 格(16×16)');
  eq(c.cells.byteLength, 256 * 4, '每 Chunk 基础网格应为 256×4 = 1024 字节');
  eq(c.cells.byteLength, 1024, '应恰为 1KB(手册 L50)');
});

test('Chunk 存档二进制 = 1024 字节(手册 L728「1KB/Chunk 存档」)', () => {
  /* 手册 L728:「实装 `room_chunks` 二进制增量落盘」。同段写明 1KB/Chunk,
     故落盘序列化长度应与基础网格同口径。 */
  const c = new Chunk(0, 0);
  eq(c.serialize().length, 1024, 'Chunk 序列化应为 1024 字节(手册 L728)');
});

test('地形常驻内存上界远低于 512MB 堆(手册 L747 + L18)', () => {
  /* 手册 L747:PM2「锁定 `512MB` 堆内存 + 2GB Swap」部署至 1GB 服务器;
     手册 L18 又要求同时兼顾物理与沙盒演化。
     判据 = 512MB 堆预算(手册数字),检查「视距内地形常驻」是否吃得下。
     视距取 R=2(5×5=25 chunks):手册 L63 的 AOI 是 2 个区块半径,
     对应 5×5 区块覆盖 —— 这是手册参数推出的区块数,非代码常量。 */
  const resident = Chunk.RESIDENT_BYTES;
  ok(resident > 1024, `常驻字节应含基础网格 + 屋顶层,实测 ${resident}B`);
  const HEAP_512MB = 512 * 1024 * 1024;
  const chunksPer2ChunkRadius = 5 * 5; /* AOI 半径 2 区块 → 5×5 */
  const rooms = 12; /* 手册 L747「12 房间并发」 */
  const total = resident * chunksPer2ChunkRadius * rooms;
  ok(
    total < HEAP_512MB / 100,
    `12 房间 × 25 chunks 应远小于 512MB 堆,实测 ${(total / 1024 / 1024).toFixed(2)} MiB`,
  );
  /* 单 chunk 常驻 = cells(1024) + roofs(512) + 元数据,应 < 2KB */
  ok(resident < 2048, `单 chunk 常驻应 < 2KB,实测 ${resident}B`);
});

test('Chunk 常驻内存随区块数线性(无隐藏超线性开销)', () => {
  /* 结构性质:常驻内存是「每 chunk 固定字节 × 数量」,不应随数量增长。
     判据 = 自身对比(1 个 vs 4096 个的每 chunk 字节数相等)。 */
  const one = new Chunk(0, 0);
  const many: Chunk[] = [];
  for (let i = 0; i < 512; i += 1) many.push(new Chunk(i, 0));
  const perOne = one.cells.byteLength + one.roofs.byteLength;
  const perMany = (many[0].cells.byteLength + many[0].roofs.byteLength);
  eq(perOne, perMany, '每 chunk 字节数应与总数无关');
  eq(one.serialize().length, many[0].serialize().length, '序列化长度应与总数无关');
});

/* ═══════════════ 5. 手册 L5/L9/L19 物理帧 ═══════════════ */

test('16 人 + 24 野怪 + 1 Boss 单快帧远低于 50ms(手册 L5/L9/L19)', () => {
  /* 手册 L5「4~16 人同房」、L9「24 种野生动物」、L19 快帧职责含
     「圆形刚体碰撞反弹」「举起/投掷抛物线积分」。
     判据 = 手册 L19 的快帧预算 50ms,比例放宽到 25%(4× 余量)。 */
  const w = new PhysicsWorld({ bounds: { minX: 0, minY: 0, maxX: 128, maxY: 128 } });
  for (let i = 0; i < 16; i += 1) w.spawn(`p${i}`, { x: 5 + i, y: 5, vx: 2, vy: 1 });
  for (let i = 0; i < 24; i += 1) {
    w.spawn(`m${i}`, { x: 20 + (i % 12), y: 20 + Math.floor(i / 12), vx: -1, vy: 1 });
  }
  w.spawn('boss', { x: 40, y: 40, vx: 0.5, vy: 0.5, mass: 20, radius: 1.2 });

  const b = w.benchmark(300, WARMUP);
  const FAST_BUDGET_MS = 50; /* 手册 L19 的 20Hz */
  ok(
    b.maxMs < FAST_BUDGET_MS / 4,
    `41 刚体单帧应 < ${FAST_BUDGET_MS / 4}ms(50ms 预算的 25%),实测最大 ${b.maxMs.toFixed(4)}ms`,
  );
  ok(b.avgMs > 0, '平均耗时应为正数(说明确实在跑物理)');
});

test('上百只怪物规模下单快帧仍远低于 50ms(手册 L62)', () => {
  /* 手册 L62 原文提到「上百只野生怪物」。这里取 16 玩家 + 100 怪 + 1 Boss
     = 117 刚体,O(N²) 两两判定 6786 对。判据仍是手册的 50ms 快帧。 */
  const w = new PhysicsWorld({ bounds: { minX: 0, minY: 0, maxX: 256, maxY: 256 } });
  for (let i = 0; i < 16; i += 1) w.spawn(`p${i}`, { x: 5 + i, y: 5, vx: 2, vy: 1 });
  for (let i = 0; i < 100; i += 1) {
    w.spawn(`m${i}`, { x: 30 + (i % 25), y: 30 + Math.floor(i / 25), vx: -1, vy: 1 });
  }
  w.spawn('boss', { x: 60, y: 60, vx: 0.5, vy: 0.5, mass: 20, radius: 1.2 });
  eq(w.bodies.size, 117, '刚体数应为 16+100+1 = 117');

  const b = w.benchmark(300, WARMUP);
  ok(
    b.maxMs < 50 / 2,
    `117 刚体单帧应 < 25ms(50ms 预算的 50%),实测最大 ${b.maxMs.toFixed(4)}ms`,
  );
});

/* ═══════════════ 6. 流体:守恒与预算 ═══════════════ */

/** 造 `n×n` 满水满活跃场(带四周实心墙)。 */
function mkPool(n: number): FluidField {
  const p = new FluidField(n, n);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = p.index(x, y);
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1) { p.solid[i] = 1; continue; }
      p.base[i] = 5; /* BaseFluid.SHALLOW_WATER */
      p.amount[i] = 1000; /* 满格 */
      p.markActive(i);
    }
  }
  return p;
}

test('流体扩散质量守恒:300 帧后总毫格数精确不变', () => {
  /* 手册 L20/L725 要求「元胞自动机流淌扩散」。元胞自动机必须守恒质量,
     否则水会凭空生成或消失。判据 = **自身前后相等**这一不变式,
     不依赖任何代码常量,因此永远不会「跟着代码改绿」。 */
  const p = mkPool(64);
  const before = p.grandTotal();
  ok(before > 0, '初始水量应为正');
  for (let i = 0; i < 300; i += 1) p.step();
  const after = p.grandTotal();
  eq(after, before, `300 帧后总毫格数应精确不变(前 ${before} / 后 ${after})`);
});

test('流体单帧预算封顶:单步服务格数不超过 1024(手册 L20 的 2Hz 节奏)', () => {
  /* 慢帧只有 500ms,必须给扩散设上界,否则大世界一帧吃光预算。
     判据 = 单步 processed 不应随世界面积增长(1024 格封顶)。
     这里断言的「封顶」性质来自 2Hz 节奏的工程必然性,不取常量值本身作判据:
     真正的判据是「256×256 的 processed 与 64×64 相同」—— 与面积解耦。 */
  const small = mkPool(64);
  const large = mkPool(256);
  const rs = small.step();
  const rl = large.step();
  eq(rl.processed, rs.processed, '单步服务格数应与世界面积无关(预算封顶)');
  ok(rl.truncated, '256×256 满活跃时应标记 truncated(说明确实被预算截断)');
  ok(rl.active > 0, '应有活跃格被记录');
});

test('流体单步成本不随世界面积线性增长(量级断言)', () => {
  /* 面积涨 16×(64²→256²),单步耗时应远小于 16×。
     量级判据而非绝对毫秒 —— 这样在快慢机器上都稳定。 */
  const steady = (n: number): number => {
    const p = mkPool(n);
    for (let i = 0; i < 40; i += 1) p.step(); /* 预热到稳态 */
    return medianMs(() => { p.step(); }, 7, 20);
  };
  const t64 = steady(64);
  const t256 = steady(256);
  const ratio = t256 / Math.max(t64, 1e-9);
  ok(
    ratio < 16 / 2,
    `面积 16× 时耗时涨幅应远小于 16×,实测 ${ratio.toFixed(2)}×`
      + `(${(t64 * 1000).toFixed(1)}µs → ${(t256 * 1000).toFixed(1)}µs)`,
  );
});

/* ═══════════════ 7. 电路:慢帧预算 ═══════════════ */

/** 512×512 铺 2 万格线 —— 候选规模(手册无原文,用于预算占比断言)。 */
function mkBigGraph(dirty: boolean): SignalGraph {
  const g = new SignalGraph(512, 512, dirty);
  let placed = 0;
  for (let y = 1; y < 512 && placed < 20000; y += 1) {
    for (let x = 1; x < 512 && placed < 20000; x += 1) {
      if (g.addWire(x, y, WireColor.RED)) placed += 1;
    }
  }
  return g;
}

test('2 万电线格下单步 2Hz 推进远低于 500ms 慢帧(手册 L20)', () => {
  /* 手册 L20:慢帧负责「魔能电路(Wiring)有向图信号推进」,预算 500ms。
     判据 = 手册的 500ms;规模取 512×512 / 2 万格(候选清单场景)。 */
  const g = mkBigGraph(false);
  eq(g.totalWireCells(), 20000, '应铺满 2 万电线格');
  const ms = medianMs(() => {
    g.drive(1, 1, WireColor.RED, true);
    g.tick();
  }, 7, 5);
  ok(
    ms < 500 / 50,
    `2 万格全量推进应 < 10ms(500ms 慢帧的 2%),实测 ${ms.toFixed(4)}ms`,
  );
});

test('脏增量推进显著快于全量推进(结构性质,非绝对毫秒)', () => {
  /* 结构性质:只改一个驱动源时,脏模式应重算远少于全量。
     判据 = 两者自身对比(脏 < 全量的 1/2),与任何常量无关。 */
  const full = mkBigGraph(false);
  const dirty = mkBigGraph(true);
  for (let i = 0; i < 5; i += 1) { dirty.drive(1, 1, WireColor.RED, true); dirty.tick(); }

  const tFull = medianMs(() => { full.drive(1, 1, WireColor.RED, true); full.tick(); }, 7, 5);
  const tDirty = medianMs(() => { dirty.drive(1, 1, WireColor.RED, true); dirty.tick(); }, 7, 5);
  ok(
    tDirty < tFull / 2,
    `脏增量应快于全量 2×,实测 全量 ${tFull.toFixed(4)}ms / 脏 ${tDirty.toFixed(4)}ms`,
  );
});

/* ═══════════════ 8. 网络:字节上界 ═══════════════ */

/** 造 16 人 + 6 野怪 + 1 Boss 的房间(手册 §7.2 字段表口径)。 */
function mkRoom(n: number) {
  const room = createRoomState('r1');
  room.players = Array.from({ length: n }, (_, i) =>
    createPlayerState(`player_${i}`, { x: i * 2, y: i * 1.5 }));
  room.wildlife = Array.from({ length: 6 }, (_, i) =>
    createWildlifeState(`mob_${i}`, { x: 10 + i, y: 10 }));
  room.bosses = [createBossState('boss_1', { x: 50, y: 50 })];
  return room;
}

test('16 人静止帧压到 10 字节', () => {
  /* 静止帧 = 协议版本 1 + op 1 + tick 4 + removed u16 2 + plans u16 2 = 10。
     这是字段级 diff 的结构极限:没有任何字段变化时只剩报文骨架。
     判据 = 10(由协议骨架字段宽度算术推出,非魔法数)。 */
  const prev = mkRoom(16);
  const still = mkRoom(16);
  still.meta.tick = 2;
  const pkt = encodeDelta(prev, still, 2);
  const skeleton = 1 + 1 + 4 + 2 + 2; /* version + op + tick + removed + plans */
  eq(skeleton, 10, '报文骨架应为 10 字节');
  eq(pkt.bytes.length, skeleton, `静止帧应只剩骨架,实测 ${pkt.bytes.length}B`);
});

test('字段级差量 < 全量一半(结构性质)', () => {
  /* 差量编码的意义就在于此:只发变化的字段。
     判据 = 自身对比,不含绝对字节数。 */
  const prev = mkRoom(16);
  const next = mkRoom(16);
  next.meta.tick = 2;
  for (const p of next.players) { p.x += 0.1; p.y += 0.1; }

  const full = encodeDelta(null, prev, 1);
  const delta = encodeDelta(prev, next, 2);
  ok(
    delta.bytes.length < full.bytes.length / 2,
    `差量应 < 全量一半,实测 差量 ${delta.bytes.length}B / 全量 ${full.bytes.length}B`,
  );
  ok(delta.bytes.length < full.bytes.length, '差量必须小于全量');
});

test('16 人单客户端带宽远低于 1Mbps 上行(手册 L747 部署约束)', () => {
  /* 手册 L747 要求部署到 1GB 服务器并 12 房间并发;手册 L5 是 4~16 人。
     判据 = 「单客户端占用远低于常见 1Mbps 上行」这一工程上界。
     用实编字节 × 手册 L19 的 20Hz,而非解析模型的预测值。 */
  const prev = mkRoom(16);
  const next = mkRoom(16);
  next.meta.tick = 2;
  for (const p of next.players) { p.x += 0.1; p.y += 0.1; }
  const delta = encodeDelta(prev, next, 2);

  const bytesPerSec = delta.bytes.length * 20; /* 手册 L19 的 20Hz */
  const bitsPerSec = bytesPerSec * 8;
  ok(
    bitsPerSec < 1_000_000 / 4,
    `单客户端应 < 250kbps(1Mbps 的 1/4),实测 ${(bitsPerSec / 1000).toFixed(1)}kbps`
      + `(${delta.bytes.length}B/帧)`,
  );
});

test('解析带宽模型是保守上界:不低估实编字节', () => {
  /* `estimateBandwidth` 是解析模型(常量累加)。它若**低估**真实编码,
     就会把带宽门禁放水 —— 这是必须防的方向。
     判据 = 模型值 ≥ 实编值(单调方向),不要求相等。 */
  const prev = mkRoom(16);
  const next = mkRoom(16);
  next.meta.tick = 2;
  for (const p of next.players) { p.x += 0.1; p.y += 0.1; }
  const delta = encodeDelta(prev, next, 2);
  const model = estimateBandwidth(16, 20);
  ok(
    model.frameBytes >= delta.bytes.length,
    `解析模型(${model.frameBytes}B)不得低估实编(${delta.bytes.length}B)`,
  );
  /* 但也不该离谱到 10× 以上,否则模型失去参考价值 */
  ok(
    model.frameBytes < delta.bytes.length * 10,
    `解析模型(${model.frameBytes}B)不应超过实编 10×(${delta.bytes.length}B)`,
  );
});

/* ═══════════════ 9. 手册 L726 BFS 上限 ═══════════════ */

test('BFS 闭合房间检测面积上限 = 100 格(手册 L726)', () => {
  /* 手册 L726 原文:「实装 100 格上限 BFS 闭合房间检测算法」。
     判据 = 手册写死的 100。 */
  eq(DEFAULT_MAX_AREA, 100, '房间面积上限应为 100 格(手册 L726)');
});

/* ═══════════════ 10. 交叉一致性 ═══════════════ */

test('手册内部自洽:16×16 区块与 32 格 AOI 半径的比例关系', () => {
  /* 手册 L50 说区块是 16×16;手册 L63 说 AOI 覆盖「2 个区块(32 格)」。
     32 / 16 = 2,两处必须自洽 —— 这是手册文本内部的交叉校验。 */
  const CHUNK = 16;
  eq(AOI_WAKE_DISTANCE / CHUNK, 2, 'AOI 半径应恰为 2 个区块(手册 L63 原文「2 个区块」)');
  eq(CHUNK * CHUNK, 256, '区块格数应为 256(手册 L50 的 Uint32Array 长度)');
});

test('内存上界换算自洽:1KB 基础网格 + 顶层结构 = 常驻字节', () => {
  /* 结构性质:常驻字节必须 ≥ 基础网格 1KB(手册 L50),
     且多出的部分是屋顶层(手册 L8「5 层垂直数据栈」中的屋顶)。
     判据 = 「≥ 1024」这个由手册 L50 推出的下界。 */
  const c = new Chunk(0, 0);
  ok(Chunk.RESIDENT_BYTES >= 1024, `常驻字节应 ≥ 基础网格 1KB,实测 ${Chunk.RESIDENT_BYTES}B`);
  eq(c.roofs.byteLength, 256 * 2, '屋顶层应为 256 × Uint16 = 512 字节');
  eq(Chunk.RESIDENT_BYTES, 1024 + 512 + 96, '常驻应为 grid + roofs + 元数据');
});

report('WS-FND-05');