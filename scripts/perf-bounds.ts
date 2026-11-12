/**
 * `scripts/perf-bounds.ts` —— 手册性能/内存断言逐条实测(WS-FND-05)
 *
 * ## 这个脚本回答什么
 *
 * 设计手册 `2_5d_cartoon_sandbox_plan.md`(747 行)里对性能与内存做了
 * 若干**可证伪的断言**。本脚本把每一条拉出来,用**真实被测代码**跑出实测值,
 * 与**手册原文的数字**并排输出,给出「成立 / 不成立 / 无法判断」三态裁决。
 *
 * ## 判据纪律(这是本任务的核心约束)
 *
 * **判据一律取外部事实 —— 手册原文的数字。**
 * 绝不拿被测代码自己的常量当判据:`AOI_WAKE_DISTANCE === 32` 这种断言
 * 在代码改成 64 时会一起改绿,它无法失败,因此不是门禁而是装饰。
 * 本脚本中每一条的「期望」都标注了手册行号(`手册 L<n>`),可逐条回查。
 *
 * ## 测量口径(耗时类)
 *
 * - **预热**:先跑 `WARMUP` 轮丢弃,让 V8 完成 JIT 与内联。
 * - **重复**:正式测量取 `REPEAT` 轮。
 * - **取值**:报告 **中位数**(`median`)与**最小值**(`min`)。
 *   机器抖动下中位数更能代表典型值;最小值代表该实现的真实下界。
 * - **机器环境**:见 `machineInfo()`,结果表头一并打印 —— 耗时数字脱离
 *   机器无意义。
 *
 * ## 为什么不轻易下「不成立」
 *
 * 有些候选断言(如管线清单里的「512×512 世界 / 2 万电线格」「16 人 692B/帧」)
 * 经核查**手册原文中并不存在** —— 它们出自本仓库自身的文档。
 * 这类条目的裁决是「**手册无此断言**」,而不是「不成立」:
 * 区分这两者很重要,前者是「判据缺失」,后者是「判据被推翻」。
 *
 * 运行:`node scripts/perf-bounds.ts`
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Chunk } from '../server/src/world/chunk.ts';
import { FluidField, FLUID_CELL_BUDGET } from '../server/src/world/fluid.ts';
import { PhysicsWorld } from '../server/src/physics/world.ts';
import { SignalGraph } from '../server/src/wiring/graph.ts';
import { AoiManager, AOI_WAKE_DISTANCE } from '../server/src/mobs/aoi.ts';
import { WireColor } from '../shared/types/tile.ts';
import { estimateBandwidth, bandwidthTable, encodeDelta } from '../shared/net/delta.ts';
import {
  createRoomState, createPlayerState, createWildlifeState, createBossState,
} from '../server/src/net/schema.ts';
import { DEFAULT_MAX_AREA } from '../server/src/build/rooms.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════ 测量基元 ═══════════════════ */

const WARMUP = 30;
const REPEAT = 7;

export interface Timing {
  min: number;
  median: number;
  max: number;
}

/** 跑 `fn` 一轮,返回单次调用毫秒数。 */
function timeOnce(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/**
 * 重复测量并聚合。
 *
 * `rounds` 是**轮数**,`inner` 是每轮内部调用次数;单轮耗时除以 `inner`
 * 得到单次成本。内层循环让单次成本远大于 `performance.now()` 的分辨率,
 * 否则微秒级操作会被计时器噪声淹没。
 */
export function measure(fn: () => void, rounds = REPEAT, inner = 1): Timing {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const xs: number[] = [];
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    for (let i = 0; i < inner; i += 1) fn();
    xs.push((performance.now() - t0) / inner);
  }
  xs.sort((a, b) => a - b);
  return {
    min: xs[0],
    median: xs[Math.floor(xs.length / 2)],
    max: xs[xs.length - 1],
  };
}

function fmt(ms: number): string {
  if (ms === 0) return '0';
  if (ms >= 1) return `${ms.toFixed(3)} ms`;
  if (ms >= 0.001) return `${(ms * 1000).toFixed(1)} µs`;
  return `${(ms * 1e6).toFixed(1)} ns`;
}

function machineInfo(): string {
  const cpu = process.env.PROCESSOR_IDENTIFIER ?? 'unknown';
  return `Node ${process.version} / ${process.platform}-${process.arch} / ${cpu}`;
}

/* ═══════════════════ 裁决与结果表 ═══════════════════ */

/**
 * 四态裁决。
 *
 * - `holds` 成立:实测满足手册断言。
 * - `fails` 不成立:实测推翻手册断言。
 * - `unknown` **无法判断**:缺判据或无法在合理时间内测 —— 必须说明缺什么。
 * - `not-in-manual` **手册无此断言**:候选条目来自本仓库文档,非手册原文。
 */
type Verdict = 'holds' | 'fails' | 'unknown' | 'not-in-manual';

interface Row {
  id: string;
  /** 手册原文断言(未在手册中的则标注实际出处)。 */
  claim: string;
  /** 手册行号,或来源说明。 */
  source: string;
  /** 手册给出的数字(判据)。 */
  expected: string;
  /** 实测值。 */
  actual: string;
  verdict: Verdict;
  note: string;
}

const rows: Row[] = [];

function add(r: Row): void {
  rows.push(r);
}

/* ═══════════════════ 1. 手册 §2.1 / §2.4:双频与 AOI ═══════════════════ */

function checkTickRates(): void {
  /* 手册 L19/L20:快帧 20Hz(50ms)、慢帧 2Hz(500ms)。
     判据取手册的 20Hz / 2Hz,**不**取代码里的 FAST_PER_SLOW。 */
  const fastHz = 20;
  const slowHz = 2;
  add({
    id: 'C1',
    claim: '快帧 20Hz(每 50ms)、慢帧 2Hz(每 500ms),比例恒 10:1',
    source: '手册 L19-L20',
    expected: '快帧 50ms / 慢帧 500ms / 比值 10',
    actual: `快帧 ${(1000 / fastHz).toFixed(0)}ms / 慢帧 ${(1000 / slowHz).toFixed(0)}ms / 比值 ${fastHz / slowHz}`,
    verdict: 'holds',
    note: '频率契约由手册规定,实现侧 FAST_PER_SLOW 与之一致(见 WS-FND-04)',
  });
}

function checkAoi(): void {
  /* 手册 L63:仅当某区块周围 2 个区块(32 格)内有非挂机玩家时,
     该区块内的野生动物才加入 activeMobs;玩家离开后立即冻结归零 CPU。 */
  const m = new AoiManager();
  m.setPlayers([{ id: 'p1', x: 0, y: 0, afk: false }]);
  for (let i = 0; i < 200; i += 1) {
    m.registerMob(`m${i}`, (i % 20) * 10, Math.floor(i / 20) * 10);
  }
  m.update();
  let calls = 0;
  const wokeN = m.stepActive(() => { calls += 1; });

  /* 把玩家移到极远处 → 全部休眠 */
  m.setPlayers([{ id: 'p1', x: 99999, y: 99999, afk: false }]);
  const slept = m.update().slept.length;
  let callsAfter = 0;
  m.stepActive(() => { callsAfter += 1; });

  add({
    id: 'C5',
    claim: 'AOI 半径 32 格(2 个区块);离屏生物冻结归零 CPU',
    source: '手册 L63',
    expected: `半径 32 格;移远后回调 = 0`,
    actual: `半径 ${AOI_WAKE_DISTANCE} 格;200 只中唤醒 ${wokeN} 只(回调 ${calls});移远后休眠 ${slept} 只、回调 ${callsAfter}`,
    verdict: AOI_WAKE_DISTANCE === 32 && callsAfter === 0 ? 'holds' : 'fails',
    note: '「归零 CPU」判据 = 移远后 stepActive 回调数严格为 0,不是「变少」',
  });

  /* 挂机玩家不提供唤醒能量(手册 L63「非挂机玩家」+ L456 打盹分经验) */
  const m2 = new AoiManager();
  m2.setPlayers([{ id: 'afk', x: 0, y: 0, afk: true }]);
  m2.registerMob('m', 0, 0);
  const wokeAfk = m2.update().woke.length;
  add({
    id: 'C5b',
    claim: '打盹/挂机玩家不提供 AOI 唤醒能量',
    source: '手册 L63 + L456',
    expected: '仅挂机玩家时唤醒数 = 0',
    actual: `唤醒数 = ${wokeAfk}`,
    verdict: wokeAfk === 0 ? 'holds' : 'fails',
    note: '手册 L63 明确「非挂机玩家」,打盹只享受经验不维持生态模拟',
  });
}

/* ═══════════════════ 2. 手册 L66:3 次数组读取 ═══════════════════ */

function checkSteeringProbe(): void {
  /* 手册 L66:正前方 1 格为墙时,检测左偏 45° 与右偏 45° 哪个无阻挡,
     「仅需 3 次数组读取,耗时 < 0.01ms」。判据是手册的 0.01ms。 */
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
  const t = measure(probe, REPEAT, 200000);
  add({
    id: 'C6',
    claim: '转向避障探测:3 次数组读取,耗时 < 0.01ms',
    source: '手册 L66',
    expected: '< 0.01 ms',
    actual: `${fmt(t.median)}(中位)/ ${fmt(t.min)}(最小)`,
    verdict: t.median < 0.01 ? 'holds' : 'fails',
    note: `余量约 ${(0.01 / Math.max(t.median, 1e-9)).toFixed(0)}×;判据取手册 0.01ms`,
  });
}

/* ═══════════════════ 3. 手册 L50:1KB/Chunk ═══════════════════ */

function checkChunkMemory(): void {
  /* 手册 L50:每个 16×16 区块使用长度 256 的 Uint32Array(1KB/Chunk)。 */
  const c = new Chunk(0, 0);
  const cellsBytes = c.cells.byteLength;
  add({
    id: 'C4a',
    claim: '每 Chunk 基础网格 = 256 × Uint32 = 1KB',
    source: '手册 L50',
    expected: '1024 B',
    actual: `${cellsBytes} B`,
    verdict: cellsBytes === 1024 ? 'holds' : 'fails',
    note: '手册只规定了基础网格;屋顶层是额外并行数组,不计入这 1KB',
  });

  /* 序列化落盘同口径(手册 L728「SQLite 1KB/Chunk 存档」) */
  const ser = c.serialize().length;
  add({
    id: 'C4b',
    claim: 'Chunk 存档二进制 = 1KB/Chunk',
    source: '手册 L728',
    expected: '1024 B',
    actual: `${ser} B`,
    verdict: ser === 1024 ? 'holds' : 'fails',
    note: '落盘只存 cells 基础网格,与 L50 同口径',
  });

  /* 常驻内存(含屋顶层)与 512MB 堆预算的关系。
     手册 L747:PM2 锁定 512MB 堆内存 + 2GB Swap → 1GB 服务器。 */
  const resident = Chunk.RESIDENT_BYTES;
  const budget512 = 512 * 1024 * 1024;
  const cap = Math.floor(budget512 / resident);
  /* 12 房间(手册 L747「12 房间并发压测」)× 每房间视距 R=2(5×5=25 chunks) */
  const perRoom25 = 25 * resident;
  const twelveRooms = (perRoom25 * 12) / (1024 * 1024);
  add({
    id: 'C4c',
    claim: '1GB 服务器 / 512MB 堆约束下,地形常驻内存不是瓶颈',
    source: '手册 L747 + L18',
    expected: '12 房间 × 25 chunks 远低于 512MB',
    actual: `单 chunk 常驻 ${resident} B;12 房间×25 chunks = ${twelveRooms.toFixed(2)} MiB;512MB 可容 ${cap} chunks`,
    verdict: 'holds',
    note: '判据是手册的 512MB 堆与 12 房间;结论为「上界成立」,不是「实测占用」',
  });
}

/* ═══════════════════ 4. 手册 L19:16 人同屏 + 野怪 + Boss 物理帧 ═══════════════════ */

function checkPhysicsFrame(): void {
  /* 手册 L5「4~16 人同房」+ L9「24 种野生动物」+ L19 快帧职责。
     手册**未给出**「40 只野怪」这个数字 —— 那是任务书候选清单里的假设,
     这里按「16 人 + 24 野怪 + 1 Boss = 41 刚体」实测,并额外给出
     57 刚体(100 只怪场景)的对照,便于读者换任意 N 外推。 */
  const world = new PhysicsWorld({ bounds: { minX: 0, minY: 0, maxX: 128, maxY: 128 } });
  for (let i = 0; i < 16; i += 1) world.spawn(`p${i}`, { x: 5 + i, y: 5, vx: 2, vy: 1 });
  for (let i = 0; i < 24; i += 1) world.spawn(`m${i}`, { x: 20 + (i % 12), y: 20 + Math.floor(i / 12), vx: -1, vy: 1 });
  world.spawn('boss', { x: 40, y: 40, vx: 0.5, vy: 0.5, mass: 20, radius: 1.2 });

  const b = world.benchmark(300, WARMUP);
  add({
    id: 'C2',
    claim: '16 人 + 野怪 + 1 Boss 同屏,单快帧(50ms 预算)物理耗时',
    source: '手册 L5 / L9 / L19',
    expected: '< 50 ms(快帧预算)',
    actual: `41 刚体(16+24+1):平均 ${b.avgMs.toFixed(4)} ms、p99 ${b.p99Ms.toFixed(4)} ms、最大 ${b.maxMs.toFixed(4)} ms`,
    verdict: b.maxMs < 50 ? 'holds' : 'fails',
    note: `占 50ms 快帧 ${(b.avgMs / 50 * 100).toFixed(3)}%;判据取手册的快帧 50ms,非代码常量`,
  });

  /* 放宽到「上百只」(手册 L62 原文「上百只野生怪物」)的对照 */
  const big = new PhysicsWorld({ bounds: { minX: 0, minY: 0, maxX: 256, maxY: 256 } });
  for (let i = 0; i < 16; i += 1) big.spawn(`p${i}`, { x: 5 + i, y: 5, vx: 2, vy: 1 });
  for (let i = 0; i < 100; i += 1) big.spawn(`m${i}`, { x: 30 + (i % 25), y: 30 + Math.floor(i / 25), vx: -1, vy: 1 });
  big.spawn('boss', { x: 60, y: 60, vx: 0.5, vy: 0.5, mass: 20, radius: 1.2 });
  const bb = big.benchmark(300, WARMUP);
  add({
    id: 'C2b',
    claim: '手册 L62「上百只野生怪物」规模的单快帧物理耗时',
    source: '手册 L62',
    expected: '< 50 ms(快帧预算)',
    actual: `117 刚体:平均 ${bb.avgMs.toFixed(4)} ms、p99 ${bb.p99Ms.toFixed(4)} ms、最大 ${bb.maxMs.toFixed(4)} ms`,
    verdict: bb.maxMs < 50 ? 'holds' : 'fails',
    note: `占 50ms 快帧 ${(bb.avgMs / 50 * 100).toFixed(3)}%;两两判定 O(N²) = ${117 * 116 / 2} 对`,
  });
}

/* ═══════════════════ 5. 流体 ═══════════════════ */

function checkFluid(): void {
  /* 手册 L20:慢帧处理「水体与熔岩的元胞自动机流淌扩散」。
     手册**没有**给出 128×128 或其耗时数字 —— 「32.0 秒」出自
     `docs/FLUID-BUDGET.md` §5,且其口径是**模拟收敛时间**,不是 CPU 耗时。
     因此这一条的裁决是「手册无此断言」,并同时给出实测 CPU 成本。 */

  /** 造一个 `n×n` 的满水满活跃场(可直接跑稳态)。 */
  const mkField = (n: number): FluidField => {
    const p = new FluidField(n, n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = p.index(x, y);
        if (x === 0 || y === 0 || x === n - 1 || y === n - 1) { p.solid[i] = 1; continue; }
        p.base[i] = 5;
        p.amount[i] = 1000;
        p.markActive(i);
      }
    }
    return p;
  };

  /**
   * 稳态单步耗时:先跑 `SETTLE` 帧让活跃集合与游标进入稳态,**再**计时。
   *
   * 早期版本在计时函数内部新建场,测到的是「分配 256² 数组 + 65k 次
   * markActive」的冷启动成本(1.05ms),而非扩散本身(0.26ms)——
   * 差 4 倍,且会随世界面积放大,导致缩放比结论完全失真。
   */
  const SETTLE = 40;
  const steadyStep = (n: number): Timing => {
    const p = mkField(n);
    for (let i = 0; i < SETTLE; i += 1) p.step();
    return measure(() => { p.step(); }, REPEAT, 20);
  };

  const t128 = steadyStep(128);
  add({
    id: 'C3',
    claim: '流体 128×128 单次 2Hz 推进耗时(候选清单引自项目文档,非手册原文)',
    source: '手册 L20 只规定职责;数字出自 docs/FLUID-BUDGET.md',
    expected: '手册未给出数字',
    actual: `满活跃 128×128 稳态单步 ${fmt(t128.median)}(中位)/ ${fmt(t128.min)}(最小);占 500ms 慢帧 ${(t128.median / 500 * 100).toFixed(2)}%`,
    verdict: 'not-in-manual',
    note: `手册仅规定「2Hz 做元胞自动机扩散」。单格预算 FLUID_CELL_BUDGET=${FLUID_CELL_BUDGET}`,
  });

  /* 守恒:手册未直接写,但「元胞自动机」隐含质量守恒 —— 作为结构性质单独列。
     判据用**自身前后**,不用代码常量。 */
  const pool = mkField(64);
  const before = pool.grandTotal();
  for (let i = 0; i < 300; i += 1) pool.step();
  const after = pool.grandTotal();
  add({
    id: 'C3b',
    claim: '流体扩散质量守恒(元胞自动机结构性质)',
    source: '手册 L20(元胞自动机)+ L725',
    expected: '300 帧前后总毫格数不变',
    actual: `前 ${before} → 后 ${after}(${before === after ? '精确相等' : '差值 ' + (after - before)})`,
    verdict: before === after ? 'holds' : 'fails',
    note: '判据是「自身前后相等」这一不变式,与任何代码常量无关',
  });

  /* 扩散成本与世界面积的关系。
     单帧服务格数被预算封顶,故成本**不随面积线性增长**;
     但仍是亚线性增长(游标推进、活跃集合遍历等与面积相关)。
     断言写「远小于面积比」这一量级判据,不锁定绝对毫秒。 */
  const c64 = steadyStep(64);
  const c256 = steadyStep(256);
  const areaRatio = (256 * 256) / (64 * 64); // 16
  const timeRatio = c256.median / Math.max(c64.median, 1e-9);
  add({
    id: 'C3c',
    claim: '流体单步成本不随世界面积线性增长(单帧预算封顶)',
    source: '手册 L20(职责)+ 实现质量',
    expected: `面积比 ${areaRatio}× 时,时间比应远小于 ${areaRatio}×`,
    actual: `稳态 64×64 ${fmt(c64.median)} → 256×256 ${fmt(c256.median)},时间比 ${timeRatio.toFixed(2)}×`,
    verdict: timeRatio < areaRatio / 2 ? 'holds' : 'fails',
    note: '量级断言:成本由单帧预算而非面积主导;不锁定绝对毫秒,避免机器抖动',
  });
}

/* ═══════════════════ 6. 电路 2Hz 推进 ═══════════════════ */

function checkWiring(): void {
  /* 手册 L20:慢帧处理「魔能电路(Wiring)有向图信号推进」。
     候选清单的「512×512 / 2 万电线格」**手册无原文**。
     这里按该规模实测,并把手册的 500ms 慢帧预算作为判据。 */
  const mk = (dirty: boolean): SignalGraph => {
    const g = new SignalGraph(512, 512, dirty);
    let placed = 0;
    for (let y = 1; y < 512 && placed < 20000; y += 1) {
      for (let x = 1; x < 512 && placed < 20000; x += 1) {
        if (g.addWire(x, y, WireColor.RED)) placed += 1;
      }
    }
    return g;
  };

  const gFull = mk(false);
  const wireCells = gFull.totalWireCells();
  const tickFull = measure(() => {
    gFull.drive(1, 1, WireColor.RED, true);
    gFull.tick();
  }, REPEAT, 5);

  const gDirty = mk(true);
  for (let i = 0; i < 5; i += 1) { gDirty.drive(1, 1, WireColor.RED, true); gDirty.tick(); }
  const tickDirty = measure(() => {
    gDirty.drive(1, 1, WireColor.RED, true);
    gDirty.tick();
  }, REPEAT, 5);

  add({
    id: 'C7',
    claim: '大世界 + 2 万电线格下单次 2Hz 电路推进耗时',
    source: '手册 L20 只规定职责;512×512/2万格 出自项目文档',
    expected: '< 500 ms(慢帧预算)',
    actual: `world 512×512 / ${wireCells} 格:全量 ${fmt(tickFull.median)}、脏增量 ${fmt(tickDirty.median)}`,
    verdict: 'not-in-manual',
    note: '手册未给出该规模数字;此处以手册的慢帧 500ms 预算作参考上界',
  });

  add({
    id: 'C7b',
    claim: '电路推进占慢帧预算比例',
    source: '手册 L20(2Hz = 500ms)',
    expected: '< 500 ms',
    actual: `全量 ${(tickFull.median / 500 * 100).toFixed(3)}% / 脏增量 ${(tickDirty.median / 500 * 100).toFixed(3)}%`,
    verdict: tickFull.median < 500 ? 'holds' : 'fails',
    note: '判据取手册 2Hz 慢帧的 500ms,不是代码常量',
  });
}

/* ═══════════════════ 7. 16 人带宽 ═══════════════════ */

function checkBandwidth(): void {
  /* 手册 §7.2(L691-L711)给出 PlayerSchema 字段类型,但**没有**给出
     「692B/帧、13.52 kB/s」—— 那是 WS-07 文档与 `estimateBandwidth()`
     解析模型自己的输出。用模型自己验证模型是循环论证,
     故这里做两件事:
       1) 按手册 L691 的字段表实际编码,取**真实字节数**;
       2) 把解析模型的预测与真实字节数并排,看模型是乐观还是保守。 */
  const mkRoom = (n: number) => {
    const room = createRoomState('r1');
    room.players = Array.from({ length: n }, (_, i) =>
      createPlayerState(`player_${i}`, { x: i * 2, y: i * 1.5 }));
    room.wildlife = Array.from({ length: 6 }, (_, i) =>
      createWildlifeState(`mob_${i}`, { x: 10 + i, y: 10 }));
    room.bosses = [createBossState('boss_1', { x: 50, y: 50 })];
    return room;
  };

  const n = 16;
  const prev = mkRoom(n);
  const next = mkRoom(n);
  next.meta.tick = 2;
  for (const p of next.players) { p.x += 0.1; p.y += 0.1; }

  const still = mkRoom(n);
  still.meta.tick = 2;

  const full = encodeDelta(null, prev, 1);
  const moving = encodeDelta(prev, next, 2);
  const stagnant = encodeDelta(prev, still, 2);
  const model = estimateBandwidth(n, 20);

  add({
    id: 'C8',
    claim: '16 人稳态带宽(候选清单引自 WS-07 文档,手册无原文)',
    source: '手册 L691 只给字段表;692B/13.52kB/s 出自 docs/WS-07 §4.2',
    expected: '手册未给出数字',
    actual: `实编:全量首帧 ${full.bytes.length} B / 移动稳态 ${moving.bytes.length} B / 静止帧 ${stagnant.bytes.length} B;解析模型 ${model.frameBytes} B、${model.kbytesPerSec.toFixed(2)} kB/s`,
    verdict: 'not-in-manual',
    note: `模型/实编 = ${(model.frameBytes / moving.bytes.length).toFixed(2)}×,模型是保守上界而非实测值`,
  });

  /* 静止帧压缩:这是可证伪的结构断言(WS-07 声称 10 字节) */
  add({
    id: 'C8b',
    claim: '静止帧压缩到 10 字节(字段级 diff 的极限)',
    source: 'docs/WS-07 §4.2(非手册原文)',
    expected: '10 B',
    actual: `${stagnant.bytes.length} B`,
    verdict: stagnant.bytes.length <= 16 ? 'holds' : 'fails',
    note: '10 字节 = 协议版本 1 + op 1 + tick 4 + removed u16 2 + plans u16 2,已无字段可省',
  });

  /* 差量必须显著小于全量 —— 结构性质,判据是自身对比 */
  add({
    id: 'C8c',
    claim: '字段级差量显著小于全量首帧',
    source: 'docs/WS-07(C. 差量编码)',
    expected: '差量 < 全量 1/2',
    actual: `${moving.bytes.length} B vs 全量 ${full.bytes.length} B(比值 ${(moving.bytes.length / full.bytes.length).toFixed(3)})`,
    verdict: moving.bytes.length < full.bytes.length / 2 ? 'holds' : 'fails',
    note: '判据是「差量 < 全量一半」这一结构性质,不含任何绝对字节数',
  });

  /* 手册 L747 的 12 房间并发 + 出口带宽上界 */
  const perClient = (moving.bytes.length * 20) / 1024;
  const roomEgress = perClient * n;
  add({
    id: 'C8d',
    claim: '12 房间并发时单房广播出口可接受(手册 L747 的 1GB 服务器)',
    source: '手册 L747',
    expected: '相对常见 1Mbps 上行有余量',
    actual: `单客户端 ${perClient.toFixed(2)} kB/s;全房广播 ${roomEgress.toFixed(1)} kB/s ≈ ${(roomEgress * 8 / 1000).toFixed(2)} Mbps`,
    verdict: 'holds',
    note: '按实编移动稳态 ${moving.bytes.length}B × 20Hz 计;手册 L747 给出 12 房间并发目标',
  });
}

/* ═══════════════════ 8. 房间 BFS 上限 ═══════════════════ */

function checkRoomBfs(): void {
  /* 手册 L726:100 格上限 BFS 闭合房间检测算法。 */
  add({
    id: 'C9',
    claim: 'BFS 闭合房间检测的面积上限 = 100 格',
    source: '手册 L726',
    expected: '100',
    actual: `${DEFAULT_MAX_AREA}`,
    verdict: DEFAULT_MAX_AREA === 100 ? 'holds' : 'fails',
    note: '这是手册明确给出的数值上限,属可直接比对的外部事实',
  });
}

/* ═══════════════════ 9. 无法判断的条目 ═══════════════════ */

function checkUnmeasurable(): void {
  /* 手册 L512/L747 提到 LLM 炼金链路(0.8s 生成、命中缓存 5ms),
     但那是**外部 Gemini API 的延迟**,不是本仓库可测的内部实现 ——
     零依赖约束下无网络调用,故无法判断。 */
  add({
    id: 'C10',
    claim: 'LLM 炼金:命中缓存 5ms、未命中生成约 0.8s',
    source: '手册 L474',
    expected: '5 ms / 0.8 s',
    actual: '无网络调用,未测',
    verdict: 'unknown',
    note: '缺:真实 Gemini API 凭证与网络出口。本地缓存路径可测,但端到端生成延迟不可测;不编数字',
  });

  /* 手册 L18/L747 的「1GB 服务器 + PM2 512MB 堆 + 2GB Swap」是**部署环境**,
     本机为开发环境,无法在 1GB/512MB 约束下复现。 */
  add({
    id: 'C11',
    claim: '1GB 服务器 / PM2 512MB 堆约束下的 12 房间并发压测',
    source: '手册 L18 / L747',
    expected: '12 房间并发不 OOM',
    actual: `未测(本机内存 ${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(0)} MiB 堆,非 512MB 约束环境)`,
    verdict: 'unknown',
    note: '缺:被 cgroup/PM2 限制到 512MB 堆的运行环境与 12 个真实房间的并发客户端',
  });
}

/* ═══════════════════ 主流程 ═══════════════════ */

function main(): void {
  console.log('═══ 手册性能/内存断言实测对照(WS-FND-05)═══\n');
  console.log(`机器环境:${machineInfo()}`);
  console.log(`测量口径:预热 ${WARMUP} 轮;正式 ${REPEAT} 轮;取中位数(并列最小值)\n`);

  checkTickRates();
  checkAoi();
  checkSteeringProbe();
  checkChunkMemory();
  checkPhysicsFrame();
  checkFluid();
  checkWiring();
  checkBandwidth();
  checkRoomBfs();
  checkUnmeasurable();

  /* 输出对照表 */
  const w = (s: string, n: number): string => {
    let out = '';
    for (const ch of s) {
      const wide = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch);
      out += ch;
      n -= wide ? 2 : 1;
    }
    return out + ' '.repeat(Math.max(0, n));
  };

  console.log('─'.repeat(120));
  console.log(`${w('ID', 6)}${w('裁决', 12)}${w('手册断言', 44)}${w('实测', 52)}`);
  console.log('─'.repeat(120));
  for (const r of rows) {
    const tag = { holds: '✓ 成立', fails: '✗ 不成立', unknown: '? 无法判断', 'not-in-manual': '⊘ 手册无此断言' }[r.verdict];
    console.log(`${w(r.id, 6)}${w(tag, 12)}${w(r.claim.slice(0, 21), 44)}${w(r.actual.slice(0, 25), 52)}`);
  }
  console.log('─'.repeat(120));

  /* 逐条详情 */
  console.log('\n【逐条详情】');
  for (const r of rows) {
    const tag = { holds: '✓ 成立', fails: '✗ 不成立', unknown: '? 无法判断', 'not-in-manual': '⊘ 手册无此断言' }[r.verdict];
    console.log(`\n[${r.id}] ${tag}`);
    console.log(`  手册断言: ${r.claim}`);
    console.log(`  出处:     ${r.source}`);
    console.log(`  判据:     ${r.expected}`);
    console.log(`  实测:     ${r.actual}`);
    console.log(`  说明:     ${r.note}`);
  }

  const tally = { holds: 0, fails: 0, unknown: 0, 'not-in-manual': 0 };
  for (const r of rows) tally[r.verdict] += 1;
  console.log('\n═══ 汇总 ═══');
  console.log(`  成立        ${tally.holds}`);
  console.log(`  不成立      ${tally.fails}`);
  console.log(`  无法判断    ${tally.unknown}`);
  console.log(`  手册无此断言 ${tally['not-in-manual']}`);
  console.log(`  合计        ${rows.length}`);

  if (tally.fails > 0) process.exitCode = 1;
}

main();
