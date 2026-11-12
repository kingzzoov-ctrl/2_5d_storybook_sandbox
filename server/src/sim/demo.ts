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

  /* 实体:2 玩家 + 3 生物
     ⚠️ 这里原先写的是 `'m1'/'m2'/'m3'` —— **三个假 ID**。
     `addMob` 查不到 `MOB_BY_ID` 时**不静默忽略**,而是推进 `unknownMobs`,
     但演示脚本没读它,于是表现为「生物存在但不行为」:
     实测 `unknownMobs = ['m1','m2','m3']`,三个都是空壳,`runtimeOf()` 返回 null。

     **为什么这个 bug 值得留一段注释**:本文件是 `PROD_ENTRIES` 之一,
     是「可达性门禁」里 sim 层的**唯一入口**。一个假 ID 会让整整一层
     「看起来可达、实际什么都没跑」—— 而那正是本仓反复出现的缺陷形态。
     ⇒ 改用冻结层真实 ID(`shared/constants/mobs.ts`),并在下方**自检**非空壳。 */
  sim.addPlayer('p1', 12, 12);
  sim.addPlayer('p2', 20, 14);
  sim.addMob('mob_sheep', 'PLAINS', 16, 18);
  sim.addMob('mob_boar', 'PLAINS', 18, 18);
  sim.addMob('mob_squirrel', 'FOREST', 22, 20);

  return sim;
}

console.log('══════ 世界模拟冒烟 ══════');
const sim = makeWorld();

/* ── 自检:演示世界里不许有空壳生物 ──────────────────────────────
   这段守的是上面那条注释里的 bug。`addMob` 对未知 ID 会推进
   `unknownMobs` 而**不报错**,于是「三个生物全是空壳」与
   「三个生物都在跑」在屏幕上的区别**只有「活跃生物」一列的数字** ——
   而那个数字原先也不为 0(空壳仍被 `spawn` 与 `aoi.registerMob` 登记)。
   ⇒ 不读 `unknownMobs` 就**无法从输出看出问题**。

   为什么做成打印而不是测试断言:本文件是**演示**,不是测试 ——
   它的价值在于「人一眼能看到」。把空壳数打进表头,任何人跑一次就知道。 */
if (sim.unknownMobs.length > 0) {
  console.log(
    `⚠️ 自检失败:演示世界有 ${sim.unknownMobs.length} 个**空壳**生物 `
    + `(${sim.unknownMobs.join(', ')}) —— 它们只被 spawn/AOI 登记,没有任何 AI 行为。\n`
    + '   改用 shared/constants/mobs.ts 里的真实 ID。\n',
  );
  process.exitCode = 1;
}

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

/* ── 自检:参考实现必须**真的能移动玩家** ──
 *
 * ## 为什么这段必须有(task-58 / Lead 定为必修)
 *
 * 此前 `addPlayer('p1', 12, 12)` 之后就再没动过,`makeWorld()` 里的玩家
 * **一直静止**。后果:「模拟层支持玩家移动」这件事**从未被端到端证明过** ——
 * 而 `attackMobAuthorized` 的距离闸读 `physics.bodies`,
 * 玩家不动 ⇒ 距目标恒定 ⇒ 永远 `OUT_OF_AOI`。
 *
 * 本仓铁律是「**参考实现必须端到端能跑**」:`demo.ts` 在 `PROD_ENTRIES` 里,
 * 它是 `npm run sim`。若只接 room 侧而 demo 仍静止,就等于又一次
 * 「测试全绿 + 参考实现不跑」—— 那正是本项目反复出现的病灶。
 *
 * ## 判据必须是**权威位置**的位移,不是「调过方法」
 *
 * 只断言「我调用了 applyPlayerMove」毫无区分力(方法体可以整个空掉)。
 * ⇒ 断言 `playerPosition()`(读 `physics.bodies`)的**前后差值**。
 */
const moveWorld = makeWorld();
const p1Before = moveWorld.playerPosition('p1');
/* 沿 +x 走 20 帧,每帧 0.2 格(≈ BASE_MOVE_SPEED 4.5 × DT 0.05 × 0.89,合法) */
const MOVE_FRAMES = 20;
const MOVE_STEP = 0.2;
for (let i = 0; i < MOVE_FRAMES; i += 1) {
  const now = moveWorld.playerPosition('p1');
  if (now === null) break;
  moveWorld.applyPlayerMove('p1', now.x + MOVE_STEP, now.y);
  moveWorld.tick();
}
const p1After = moveWorld.playerPosition('p1');
const movedX = (p1After?.x ?? 0) - (p1Before?.x ?? 0);
const expectMoved = MOVE_FRAMES * MOVE_STEP;
if (p1Before === null || p1After === null) {
  problems.push('playerPosition() 返回 null —— 玩家不在 physics.bodies 里');
} else if (Math.abs(movedX - expectMoved) > 1e-6) {
  problems.push(
    `玩家位移 ${movedX.toFixed(4)} ≠ 期望 ${expectMoved.toFixed(4)}`
    + `(权威位置 = physics.bodies;若为 0 说明 applyPlayerMove 没写进去)`,
  );
}
/* 派生视图必须跟着走 —— `syncPlayers()` 只在 tick() 里跑。
   这一条同时证明「AI 能看见玩家移动」(mobPlayers 是 AI 的唯一输入源)。 */
const mp1 = moveWorld.mobPlayers.find((m) => m.id === 'p1');
if (mp1 === undefined || Math.abs(mp1.x - (p1After?.x ?? -999)) > 1e-6) {
  problems.push(
    `mobPlayers 里 p1.x=${String(mp1?.x)} 与权威 ${String(p1After?.x)} 不一致`
    + ' ⇒ syncPlayers 没把位置投影出去,生物 AI 将看不见玩家移动',
  );
}

if (problems.length > 0) {
  console.log('自检失败:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('自检通过:');
console.log('  ✓ 世界按 20Hz/2Hz 双频推进,慢帧比例精确 1:10');
console.log('  ✓ 全部子系统可同时实例化并协同运行(地形/物理/流体/电路/AOI/刷怪)');
console.log('  ✓ 电路**件**真的被求值:' + `${evaluatedTotal} 次(线通电 ${snap.wireCells} 格)`);
console.log(
  `  ✓ 玩家**真的能移动**:权威位移 ${movedX.toFixed(3)} 格(${MOVE_FRAMES} 帧 × ${MOVE_STEP}),`
  + `mobPlayers 同步到 ${(mp1?.x ?? 0).toFixed(3)}`,
);
console.log('  ✓ 同种子两次运行终态逐字节一致(确定性成立)');