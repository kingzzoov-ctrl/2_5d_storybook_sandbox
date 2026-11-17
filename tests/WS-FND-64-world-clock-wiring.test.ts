/**
 * WS-FND-64 —— **世界钟真的喂进电路求值**(D-07 的可观测出口)。
 *
 * ## 为什么需要这个套件
 *
 * D-07 把世界钟落成了 `WorldSim.hourOfDay()`(`frameCount × DT` 派生,20 分钟一天,
 * 06:00 起步)。但 405 昼夜感光器读的是 `ctx.param('hour')`,而组件的 `params` 是
 * **摆放时**的静态表 —— 所以在此之前,"钟"是一个没人读的字段,感光器只会吃摆放者手填的常量。
 *
 * 现在 `SignalGraph` 有一口**世界环境**读数口(`setEnvSource` / `envOf`),`WorldSim` 在
 * **两条**构造路径(构造器 / D-06 的 `rebuildWorld`)都把它挂到 `hour` 与 `night` 上。
 *
 * ## 判据怎么才有牙
 *
 * - 值的来源一律是**世界侧的真读数**(`sim.hourOfDay()`),不是被测模块自己报的数;
 * - ★ FND64-1 最后一条与 FND64-5 是**缺陷形态的负对照**:没挂环境口时 `param('hour')`
 *   缺失 ⇒ 0 ⇒ `isNight(0)` = 夜 ⇒ 405 **恒亮**。也就是说"接线断了"的表现是恒亮,
 *   而不是恒暗 —— 这条对照证明本套件能区分"接了"与"没接"。
 * - ★ FND64-4 钉的是 D-06 的一个真实风险:重置会 `new SignalGraph`,忘了重挂 ⇒
 *   重置过的世界悄悄退回恒亮。
 *
 * ## 为什么不在本套件里"等到 19:00"
 *
 * 一天 = 20 分钟(D-07)⇒ 06:00 → 19:00 是 650 秒 = 13000 帧。本套件用**组合**取证:
 * FND64-2 证明"挂上去的就是世界钟",FND64-3 证明"405 读的就是那一口"。
 * 两条合起来 = 感光器跟着世界钟走,而不把 13000 帧写进套件的运行时间。
 */
import { test, eq, near, report } from '../shared/testing/harness.ts';
import { WireColor } from '../shared/types/tile.ts';
import { SignalGraph, layHorizontal } from '../server/src/wiring/graph.ts';
import { makeComponent, isNight } from '../server/src/wiring/components.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';

/** 405 昼夜感光器(内容表 id,取自 `wiring/components.ts` 的注册行)。 */
const SENSOR_DAYNIGHT = 405;

/** 件 id(摆放者给的名字;405 的 `spec.params` 里**没有** `hour`,所以静态表读不到它)。 */
const SENSOR_ID = 'light';

/** 在一张 10×10 的图上摆一个 405 并拉一条 8 格红线(与 `WS-08` 的 WT-08-25 同一摆法)。 */
function sensorRig(): { g: SignalGraph; lit: () => boolean } {
  const g = new SignalGraph(12, 12);
  layHorizontal(g, 3, 10, 3, WireColor.RED);
  g.addComponent(makeComponent(SENSOR_ID, SENSOR_DAYNIGHT, 2, 3));
  return { g, lit: () => g.liveAt(10, 3, WireColor.RED) };
}

/** 该图上那个 405 的静态参数表(只为了写/删 `hour`)。 */
function paramsOf(g: SignalGraph): Record<string, number> {
  return (g.components.get(SENSOR_ID) as { params: Record<string, number> }).params;
}

/** 取世界侧真的电路图(只读用途;`wiring` 是私有字段,这里只为了摆件与看通断)。 */
function graphOf(sim: WorldSim): SignalGraph {
  return (sim as unknown as { wiring: SignalGraph }).wiring;
}

/* ───────────────────────── 1 语义:静态优先,缺失才问环境 ───────────────────────── */

test('FND64-1 ★ 静态参数优先;缺失才退回环境;摘掉环境口 ⇒ 恒亮(缺陷形态)', () => {
  const { g, lit } = sensorRig();
  /* 环境:22 时(夜)。 */
  let envHour = 22;
  g.setEnvSource((key: string): number => (key === 'hour' ? envHour : 0));

  /* ① 静态参数在,就用静态的(hour=10 是白天)⇒ 不许被环境改掉。 */
  paramsOf(g).hour = 10;
  g.run(2);
  eq(lit(), false, '① 静态 hour=10 ⇒ 白天 ⇒ 暗(环境是 22,不许盖掉静态值)');

  /* ② 静态缺失 ⇒ 退回环境 22 ⇒ 夜 ⇒ 亮。 */
  delete paramsOf(g).hour;
  g.run(2);
  eq(lit(), true, '② 静态缺失 ⇒ 退回环境 22 ⇒ 夜 ⇒ 亮');

  /* ③ 环境换成白天 ⇒ 同一个件灭。 */
  envHour = 10;
  g.run(2);
  eq(lit(), false, '③ 环境换成 10 ⇒ 暗(读数每帧都是新的)');

  /* ④ 摘掉环境口 ⇒ 缺失 = 0 ⇒ isNight(0) = 夜 ⇒ 恒亮。这就是"没接线"的表现。 */
  g.setEnvSource(null);
  g.run(2);
  eq(isNight(0), true, '前提:00:00 属于夜间(isNight 的边界由 components.ts 定)');
  eq(lit(), true, '★ ④ 摘掉环境口 ⇒ 缺失=0 ⇒ 恒亮 —— "接线断了"的形态,套件必须能区分它');
});

/* ───────────────────────── 2 世界侧挂的就是世界钟 ───────────────────────── */

test('FND64-2 ★ WorldSim 挂上的就是世界钟(hour 与 night 两个键)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });

  eq(sim.hourOfDay(), 6, '前置:起步 06:00(D-07 的起点)');
  eq(sim.wiringEnvOf('hour'), 6, '★ 环境 hour = 世界钟读数(不是另算一遍)');
  eq(sim.wiringEnvOf('night'), 0, '06:00 不是夜');

  /* 推 240 帧 = 12.00 秒世界时间 ⇒ 钟点前进 12 × (24/1200) = 0.24 小时。 */
  for (let i = 0; i < 240; i += 1) sim.tick();
  /* 世界钟是 `frameCount × DT` 派生的浮点 ⇒ 用 near 比对(期望值由帧数 × 24/1200 算,不取自被测模块)。 */
  near(sim.hourOfDay(), 6.24, 1e-9, '240 帧后 = 06:14:24(世界时间 12.00 秒)');
  near(sim.wiringEnvOf('hour'), 6.24, 1e-9, '★ 环境读数跟着钟走(每个 tick 都是新值)');
  eq(sim.wiringEnvOf('night'), 0, '06:14 仍不是夜');

  /* 未提供的键不许被这个口"发明"出来。 */
  eq(sim.wiringEnvOf('pitch'), 0, '无关的键 ⇒ 0(环境口只提供 hour/night)');
});

/* ───────────────────────── 3 405 读的就是那一口 ───────────────────────── */

test('FND64-3 ★★ 真世界图里的 405:06:00 ⇒ 暗;把那一口换成 22 时 ⇒ 亮', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = graphOf(sim);
  layHorizontal(g, 3, 10, 3, WireColor.RED);
  g.addComponent(makeComponent(SENSOR_ID, SENSOR_DAYNIGHT, 2, 3));

  g.run(2);
  eq(sim.hourOfDay(), 6, '前提:世界钟在 06:00(白天)');
  eq(g.liveAt(10, 3, WireColor.RED), false, '★ 感光器此时输出 0(读的是世界钟那一口,现在是白天)');

  /* 不动 405 的任何静态参数,只把"世界钟那一口"换成夜间读数。 */
  /* 只换 `hour`:`night` 键是"强制夜间"覆盖,留着会把下面那条静态优先的负对照强行点亮。 */
  g.setEnvSource((key: string): number => (key === 'hour' ? 22 : 0));
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), true, '★ 同一个件、同一张图 ⇒ 换成 22 时后输出 1');

  /* 负对照:给件写死静态值,环境就不再是它的来源。 */
  paramsOf(g).hour = 12;
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), false, '负对照:静态 hour=12 压过环境 22 ⇒ 暗(静态优先)');
});

/* ───────────────────── 4 D-06 重置之后仍然挂着(两条构造路径都要) ───────────────────── */

test('FND64-4 ★ D-06 重置后新电路图依旧挂着世界钟(忘了重挂 ⇒ 恒亮)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  for (let i = 0; i < 240; i += 1) sim.tick();
  near(sim.wiringEnvOf('hour'), 6.24, 1e-9, '前置:重置前环境 = 06.24');

  const r = sim.resetWorld({ seed: 7 });
  eq(r.applied, true, '前置:重置成功');
  eq(sim.hourOfDay(), 6, '重置把钟点打回 06:00(D-07:frameCount 归零 ⇒ 结构结果)');
  eq(sim.wiringEnvOf('hour'), 6, '★ 新电路图仍然读得到钟(说明 rebuildWorld 也挂了这一口)');
  eq(sim.wiringEnvOf('night'), 0, '★ 新图的 night 也跟着走');

  /* 新图上重新摆 405:仍然随那一口亮灭。 */
  const g = graphOf(sim);
  layHorizontal(g, 3, 10, 3, WireColor.RED);
  g.addComponent(makeComponent(SENSOR_ID, SENSOR_DAYNIGHT, 2, 3));
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), false, '重置后的图:06:00 ⇒ 暗');
  g.setEnvSource((key: string): number => (key === 'hour' ? 2 : 0));
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), true, '重置后的图:02:00 ⇒ 亮');
});

/* ───────────────────────── 5 负对照:没挂 ⇒ 恒亮(不是恒暗) ───────────────────────── */

test('FND64-5 ★ 负对照:把环境口摘掉 ⇒ 06:00 的白天也恒亮(所以"能区分接没接")', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = graphOf(sim);
  layHorizontal(g, 3, 10, 3, WireColor.RED);
  g.addComponent(makeComponent(SENSOR_ID, SENSOR_DAYNIGHT, 2, 3));

  /* 生产形态:06:00 ⇒ 暗。 */
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), false, '生产形态:06:00 的感光器是暗的');
  eq(sim.hourOfDay(), 6, '此时世界钟确实是白天');

  /* 摘掉(等价于"WorldSim 忘了挂"):同一个白天,件反而亮。 */
  g.setEnvSource(null);
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), true, '★ 摘掉后同一个白天变亮 ⇒ 未接线的缺陷可被本套件看见');

  /* 再挂回去 ⇒ 恢复暗。 */
  g.setEnvSource((key: string): number => (key === 'hour' ? sim.hourOfDay() : 0));
  g.run(2);
  eq(g.liveAt(10, 3, WireColor.RED), false, '挂回去 ⇒ 恢复 06:00 的暗');
});

report('WS-FND-64');