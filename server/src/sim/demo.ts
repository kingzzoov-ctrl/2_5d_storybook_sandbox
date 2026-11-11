/**
 * 世界模拟冒烟可执行例 —— 「让世界真的跑起来」的最小证明。
 *
 * 这个文件不是测试(`tests/` 里那些是),它是**可手动运行的演示**:
 * 建一个小世界、铺地板、灌水、拉电线、投玩家与生物,跑若干秒,
 * 然后把慢帧账本打印成表。
 *
 * 为什么需要它:交付时 677 条断言全绿,但**没有任何代码同时驱动地形、
 * 物理、电路、生物** —— 每个 WS 的测试都只在自建对象上断言,世界从未跑起来过。
 * 这个演示是那个空白的填补物,也是 `npm run sim` 的入口。
 *
 * 运行:
 *   node server/src/sim/demo.ts          # 默认 10 秒
 *   node server/src/sim/demo.ts 60       # 跑 60 秒
 */
import { WorldSim, FAST_PER_SLOW, SIM_FAST_DT, SIM_SLOW_DT } from './world_sim.ts';
import { WireColor } from '../../../shared/types/tile.ts';

const SECONDS = Math.max(1, Number(process.argv[2] ?? 10));

/** 建一个内容一致的演示世界(被调用两次:一次统计、一次逐帧打印)。 */
function makeWorld(): WorldSim {
  const sim = new WorldSim({ sizeCells: 64 });

  /* 地形:一片 32×32 草地 */
  sim.fillRect(8, 8, 39, 39, { floor: 1, elev: 1 });

  /* 流体:往中央低洼处灌水(流体场与位平面是两个独立结构) */
  for (let y = 30; y < 34; y += 1) {
    for (let x = 30; x < 34; x += 1) sim.fluid.addWater(x, y, 4);
  }

  /* 电路:一条 10 格红线 + 一个常亮驱动源。
     注意 `SignalGraph.drive(x, y, color, on)` 接的是**格坐标**,不是组件 ID —— 
     传 ID 会因 `index()` 越界而静默返回,表现为「布线成功但永远不通电」。 */
  for (let x = 10; x < 20; x += 1) sim.wiring.addWire(x, 10, WireColor.RED);
  sim.wiring.addComponent({
    id: 'src1',
    /*
     * kind 必须与 `components.ts` 注册的名字**逐字一致**。
     * 原先写的是 `'LEVER'` —— 注册表里根本没有这个名字(正确名是
     * `'SENSOR_LEVER'`,403 双态机械拉杆),于是这个件成了**永不求值的空壳**:
     * `addComponent` 收下了它、`tick` 也会遍历它,但 `REGISTRY.get('LEVER')`
     * 永远是 undefined,行为函数一行都不跑。
     *
     * 这类错误的隐蔽性在于:**不报错、不抛异常、测试也不会红** ——
     * 它只是静静地什么都不做。`deadcode-audit.ts` 的第四探测器就是为它写的。
     */
    kind: 'SENSOR_LEVER',
    x: 10,
    y: 10,
    params: {},
    outputs: [WireColor.RED],
    state: {},
    latencyTicks: 0,
    pending: [],
    lastOut: {},
  });
  /* 每个慢帧都重新驱动一次(驱动态是帧内状态,不是持久开关)。 */
  sim.addWireDrive(10, 10, WireColor.RED, true);

  /* 实体:2 玩家 + 3 生物 */
  sim.addPlayer('p1', 12, 12);
  sim.addPlayer('p2', 20, 14);
  sim.addMob('m1', 'PLAINS', 16, 18);
  sim.addMob('m2', 'PLAINS', 18, 18);
  sim.addMob('m3', 'FOREST', 22, 20);

  return sim;
}

console.log('══════ 世界模拟冒烟 ══════');
const sim = makeWorld();
console.log(`尺寸          ${sim.sizeCells} × ${sim.sizeCells} 格`);
console.log(`快帧 / 慢帧   ${SIM_FAST_DT}s (20Hz) / ${SIM_SLOW_DT}s (2Hz),比例 1:${FAST_PER_SLOW}`);
console.log(`初始快照      ${JSON.stringify(sim.snapshot())}`);
console.log('');
console.log('帧序  相位    模拟秒   刚体  流体处理  通电格  泛洪增量  活跃生物');
console.log('────────────────────────────────────────────────────────────────────');

const total = Math.round(SECONDS * 20);
const t0 = performance.now();
/* 保留完整 reports:自检需要逐帧读 `componentsEvaluated`
   (证明电路**件**真的被求值,而不只是「线通」)。 */
const run = sim.run(total);
const { frames, slowFrames } = run;
const elapsed = performance.now() - t0;

/* 逐帧打印走一个独立实例,避免"打印用的推进"污染统计 */
const show = makeWorld();
let printed = 0;
const SHOW_MAX = 12;
for (let i = 0; i < total && printed < SHOW_MAX; i += 1) {
  const r = show.tick();
  if (r.phase !== 'SLOW') continue;
  console.log(
    `${String(r.frame).padStart(4)}  ${r.phase}   ${r.simSeconds.toFixed(2).padStart(6)}` +
      `${String(r.physics?.bodies ?? '-').padStart(6)}` +
      `${String(r.fluidProcessed).padStart(10)}` +
      `${String(r.wireCellsLive).padStart(8)}` +
      `${String(r.wireCellsFlooded).padStart(10)}` +
      `${String(r.activeMobs).padStart(10)}`,
  );
  printed += 1;
}
if (printed === 0) console.log('(运行时长不足一个慢帧)');

console.log('────────────────────────────────────────────────────────────────────');
console.log('');
console.log('══════ 结果 ══════');
console.log(`推帧总数      ${frames} 帧(${SECONDS}s × 20Hz)`);
console.log(`其中慢帧      ${slowFrames} 帧`);
console.log(`快慢比        ${(frames / Math.max(1, slowFrames)).toFixed(2)} : 1`);
console.log(`终态快照      ${JSON.stringify(sim.snapshot())}`);
console.log(`耗时          ${elapsed.toFixed(1)}ms(${(elapsed / Math.max(1, frames)).toFixed(3)}ms/帧)`);
console.log('');

/* ── 自检:不通过就明确报错退出,不静默放过 ── */
const expectSlow = Math.floor(total / FAST_PER_SLOW);
const problems: string[] = [];
if (slowFrames !== expectSlow) problems.push(`慢帧数 ${slowFrames} ≠ 期望 ${expectSlow}`);
if (sim.frame !== total) problems.push(`帧序 ${sim.frame} ≠ 期望 ${total}`);
const snap = sim.snapshot();
if (snap.bodies !== 5) problems.push(`刚体数 ${snap.bodies} ≠ 5(2 玩家 + 3 生物,同源注册)`);
if (snap.chunks < 1) problems.push('没有任何 Chunk 被创建');
if (snap.fluidTotal <= 0) problems.push(`流体总量 ${snap.fluidTotal} 应 > 0`);
if (snap.wireCells <= 0) problems.push(`电线格 ${snap.wireCells} 应 > 0`);

/*
 * ── 电路件必须**真的被求值**(不是只验「线能通电」) ──
 *
 * 原先这句自检写的是「全部子系统可同时实例化并协同运行(…电路…)」,
 * 但它只看 `wireCells`(即 `totalLiveCells()`)—— 那只证明**线通了**,
 * 完全不证明**件跑了**。
 *
 * 实测过的后果:`components.ts` 曾经整个不在生产可达闭包内,
 * `REGISTRY` 为空,40 项电路件全是「永不求值的空壳」——
 * 而这里的 `wireCells` 照样是 10(泛洪由 `addWireDrive` 驱动,与件无关),
 * 自检**全绿通过**,缺陷因此长期隐身(见 docs/FOUNDATION-AUDIT.md §3.1 缺陷 B)。
 *
 * 所以现在必须**分开验**:
 *   - `wireCellsLive`  ── 线通了;
 *   - `componentsEvaluated` ── 件真的跑过行为函数。
 * 后者为 0 就是接线断了,哪怕前者完全正常。
 */
let evaluatedTotal = 0;
for (const r of run.reports) evaluatedTotal += r.componentsEvaluated;
if (evaluatedTotal <= 0) {
  problems.push(
    '电路件求值计数为 0 —— 线可能通,但**没有任何逻辑件在跑**'
    + '(典型原因:world_sim 缺少 `import \'../wiring/components.ts\'` 副作用注册,'
    + '导致 REGISTRY 为空、40 项件全是空壳)',
  );
}
/* 挂载了几个件,每个慢帧就该求值几次 —— 顺带校验注册表不是「部分缺失」。
   本世界挂了 1 个 SENSOR_LEVER;若某天它不再注册,这里也会红。 */
const slowReports = run.reports.filter((r) => r.phase === 'SLOW').length;
const expectEval = slowReports * 1;
if (evaluatedTotal !== expectEval) {
  problems.push(
    `电路件求值总次数 ${evaluatedTotal} ≠ 期望 ${expectEval}`
    + `(挂载 1 个件 × ${slowReports} 个慢帧)—— 注册表可能部分缺失或有多余件`,
  );
}

/* 确定性:同种子两次运行必须逐帧一致 */
const a = makeWorld();
const b = makeWorld();
const ra = a.run(200);
const rb = b.run(200);
if (ra.slowFrames !== rb.slowFrames) problems.push('同种子两次运行的慢帧数不一致');
const sa = JSON.stringify(a.snapshot());
const sb = JSON.stringify(b.snapshot());
if (sa !== sb) problems.push(`同种子两次运行的终态不一致:\n    A=${sa}\n    B=${sb}`);

if (problems.length > 0) {
  console.log('自检失败:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('自检通过:');
console.log('  ✓ 世界按 20Hz/2Hz 双频推进,慢帧比例精确 1:10');
console.log('  ✓ 全部子系统可同时实例化并协同运行(地形/物理/流体/电路/AOI/刷怪)');
console.log(`  ✓ 电路**件**真的被求值:${evaluatedTotal} 次(线通电 ${snap.wireCells} 格)`);
console.log('  ✓ 同种子两次运行终态逐字节一致(确定性成立)');