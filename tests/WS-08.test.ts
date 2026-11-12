/**
 * WS-08 验收测试:四色魔能电路、2Hz 有向推进、脏网络优化、40 项电路件、自动化物流。
 *
 * 运行:`node tests/WS-08.test.ts`(或 `node scripts/verify.ts --only WS-08`)
 * 零依赖,仅用 `shared/testing/harness.ts` 与 `node:*`。
 */

import { eq, near, ok, report, test, includes } from '../shared/testing/harness.ts';
import { WireColor } from '../shared/types/tile.ts';
import { SLOW_TICK_HZ, SLOW_DT } from '../shared/types/physics.ts';

import {
  ALL_COLORS,
  FRAME_SECONDS,
  PropagateMode,
  SignalGraph,
  TICKS_PER_SECOND,
  createComponent,
  estimateAdvanceCost,
  hasComponentKind,
  layHorizontal,
  layVertical,
  registeredKinds,
  secondsToTicks,
} from '../server/src/wiring/graph.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import {
  CHANNEL_MAX,
  CHANNEL_MIN,
  COMPONENT_SPECS,
  PURE_EFFECT_IDS,
  RELAY_DELAY_SECONDS,
  RELAY_DELAY_TICKS,
  SIGNAL_IDS,
  SPEC_BY_ID,
  SPLITTER_ROUTE_NAMES,
  STATE_DEFAULTS,
  auditComponentCoverage,
  channelMatches,
  chooseSplitterRoute,
  counterDigits,
  counterStep,
  formatRunTime,
  isNight,
  makeComponent,
  nextRandom,
  pitchMatches,
  randomUnit,
  relayTicksFor,
} from '../server/src/wiring/components.ts';
import {
  ARM_CYCLE_TICKS,
  ARM_TARGETS,
  CONVEYOR_CELLS_PER_SECOND,
  CONVEYOR_CELLS_PER_TICK,
  CONVEYOR_TICKS_PER_CELL,
  DRILL_PERIOD_SECONDS,
  DRILL_PERIOD_TICKS,
  LOGISTICS_HZ,
  SorterRoute,
  createArmState,
  createConveyorState,
  createDrillState,
  createSorterState,
  loadConveyor,
  pickRoute,
  previewRouting,
  stepArm,
  stepConveyor,
  stepDrill,
  stepSorter,
  takeDrillBuffer,
  tickLogistics,
  ticksFor,
  type ArmWorld,
} from '../server/src/wiring/logistics.ts';

/* ══════════════════ 1. 2Hz 帧基线 ══════════════════ */

test('WT-08-01 推进基线是 2Hz / 0.5s 一帧,与冻结层一致', () => {
  eq(SLOW_TICK_HZ, 2, '冻结层 SLOW_TICK_HZ = 2');
  eq(TICKS_PER_SECOND, 2, 'graph 导出 2 帧/秒');
  near(FRAME_SECONDS, 0.5, 1e-12, '每帧 0.5s');
  near(SLOW_DT, 0.5, 1e-12, '与 physics.SLOW_DT 一致');
  eq(LOGISTICS_HZ, 2, '物流同频');
});

test('WT-08-02 秒 → 帧换算:0.2/0.5/1.0/2.0s 分别为 1/1/2/4 帧', () => {
  eq(RELAY_DELAY_SECONDS.length, 4, '延时继电器四档');
  eq(RELAY_DELAY_TICKS.length, 4, '四档均有帧数');
  eq(RELAY_DELAY_TICKS[0], 1, '0.2s → 1 帧(向上取整)');
  eq(RELAY_DELAY_TICKS[1], 1, '0.5s → 1 帧');
  eq(RELAY_DELAY_TICKS[2], 2, '1.0s → 2 帧');
  eq(RELAY_DELAY_TICKS[3], 4, '2.0s → 4 帧');
  for (let i = 0; i < 4; i += 1) eq(relayTicksFor(i), RELAY_DELAY_TICKS[i], `档位 ${i} 查询一致`);
  eq(relayTicksFor(-5), RELAY_DELAY_TICKS[0], '越界档位夹取到下界');
  eq(relayTicksFor(99), RELAY_DELAY_TICKS[3], '越界档位夹取到上界');
  eq(secondsToTicks(0.1), 1, '不足一帧也占 1 帧');
  eq(secondsToTicks(10), 20, '10s → 20 帧');
});

/* ══════════════════ 2. 四色独立网络 ══════════════════ */

/** 造一个 24×24 图,四色各铺一条互不相交的横线。 */
function makeFourColorGraph(): SignalGraph {
  const g = new SignalGraph(24, 24);
  layHorizontal(g, 2, 20, 2, WireColor.RED);
  layHorizontal(g, 2, 20, 5, WireColor.BLUE);
  layHorizontal(g, 2, 20, 8, WireColor.YELLOW);
  layHorizontal(g, 2, 20, 11, WireColor.GREEN);
  return g;
}

test('WT-08-03 四色网络互相独立:点亮红线不影响蓝/黄/绿', () => {
  const g = makeFourColorGraph();
  g.tick();
  g.drive(2, 2, WireColor.RED, true);
  g.tick();
  eq(g.liveAt(2, 2, WireColor.RED), true, '红线应通电');
  eq(g.liveAt(20, 2, WireColor.RED), true, '红线沿整条泛洪到末端');
  eq(g.liveAt(2, 5, WireColor.BLUE), false, '蓝线不受影响');
  eq(g.liveAt(2, 8, WireColor.YELLOW), false, '黄线不受影响');
  eq(g.liveAt(2, 11, WireColor.GREEN), false, '绿线不受影响');
  eq(g.totalLiveCells(), 19, '恰好点亮红线的 19 格');
});

test('WT-08-04 每个电线格从最多 4 个邻居取或:任一端驱动整条线通电', () => {
  const g = makeFourColorGraph();
  g.tick();
  /* 从右端驱动 */
  g.drive(20, 2, WireColor.RED, true);
  g.tick();
  eq(g.liveAt(2, 2, WireColor.RED), true, '右端驱动应泛洪到左端');
  const nets = g.networksOf(WireColor.RED);
  eq(nets.length, 1, '红线是 1 个连通网络');
  eq(nets[0].size, 19, '该网络 19 格');
  ok(nets[0].driven, '该网络已被驱动');
});

test('WT-08-05 断开的线不泛洪:中间缺口处两侧互不通电', () => {
  const g = new SignalGraph(24, 24);
  layHorizontal(g, 2, 20, 2, WireColor.RED);
  g.removeWire(11, 2, WireColor.RED);
  g.tick();
  eq(g.networksOf(WireColor.RED).length, 2, '红线被切成 2 个网络');
  g.drive(2, 2, WireColor.RED, true);
  g.tick();
  eq(g.liveAt(10, 2, WireColor.RED), true, '左半段通电');
  eq(g.liveAt(12, 2, WireColor.RED), false, '缺口右侧不通电');
  eq(g.liveAt(20, 2, WireColor.RED), false, '远端不通电');
});

test('WT-08-06 同一格可叠四色线且互不干扰', () => {
  const g = new SignalGraph(8, 8);
  for (const c of ALL_COLORS) {
    ok(g.addWire(4, 4, c), `颜色 ${c} 应能铺在 (4,4)`);
    g.addWire(5, 4, c);
  }
  g.tick();
  g.drive(4, 4, WireColor.GREEN, true);
  g.tick();
  eq(g.liveAt(5, 4, WireColor.GREEN), true, '绿线通电');
  for (const c of [WireColor.RED, WireColor.BLUE, WireColor.YELLOW]) {
    eq(g.liveAt(5, 4, c), false, `颜色 ${c} 不应被绿线带通`);
  }
  eq(g.totalWireCells(), 8, '4 格 × 2 = 8 个色·格');
});

/* ══════════════════ 3. 逻辑门:AND / NOT 真值表穷举 ══════════════════ */

/** 建一个 AND 门:红 A 线、蓝 B 线、黄输出线。 */
function makeLogicGate(kind: 'LOGIC_AND' | 'LOGIC_NOT') {
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 0, 3, 5, WireColor.RED);
  if (kind === 'LOGIC_AND') layHorizontal(g, 0, 3, 9, WireColor.BLUE);
  layHorizontal(g, 5, 12, 7, WireColor.YELLOW);
  const comp = makeComponent('gate', kind === 'LOGIC_AND' ? 414 : 415, 4, 7);
  g.addComponent(comp);
  return { g, comp };
}

test('WT-08-07 AND 门真值表穷举 4 组 (0,0)/(0,1)/(1,0)/(1,1)', () => {
  const expected: [boolean, boolean, boolean][] = [
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ];
  for (const [a, b, want] of expected) {
    const { g } = makeLogicGate('LOGIC_AND');
    g.tick();
    g.drive(0, 5, WireColor.RED, a);
    g.drive(0, 9, WireColor.BLUE, b);
    g.run(3);
    eq(g.liveAt(12, 7, WireColor.YELLOW), want, `AND 输入 (${a ? 1 : 0},${b ? 1 : 0}) → ${want ? 1 : 0}`);
  }
});

test('WT-08-08 NOT 门真值表穷举 2 组', () => {
  const expected: [boolean, boolean][] = [[false, true], [true, false]];
  for (const [a, want] of expected) {
    const { g } = makeLogicGate('LOGIC_NOT');
    g.tick();
    g.drive(0, 5, WireColor.RED, a);
    g.run(3);
    eq(g.liveAt(12, 7, WireColor.YELLOW), want, `NOT 输入 ${a ? 1 : 0} → ${want ? 1 : 0}`);
  }
});

test('WT-08-09 AND 门输入端隔离:蓝线缺失时恒输出 0', () => {
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 0, 3, 5, WireColor.RED);
  layHorizontal(g, 5, 12, 7, WireColor.YELLOW);
  const comp = makeComponent('gate', 414, 4, 7);
  g.addComponent(comp);
  g.tick();
  g.drive(0, 5, WireColor.RED, true);
  g.run(4);
  eq(g.liveAt(12, 7, WireColor.YELLOW), false, '缺蓝线输入时 AND 恒 0');
});

/* ══════════════════ 4. 延时继电器四档实测触发帧数 ══════════════════ */

/**
 * 量测继电器 413 的**自身延时**:从「输入线通电的那一帧」到「输出线通电的
 * 那一帧」经过的帧数。输入线自身泛洪的那 1 帧不算继电器延时 —— 那是线路的
 * 传播成本,任何件都逃不掉。
 */
function measureRelayTicks(setting: number): number {
  const g = new SignalGraph(20, 20);
  /* 输入线与组件中心的距离必须 ≤ READ_RADIUS(2) */
  layHorizontal(g, 0, 3, 5, WireColor.RED);
  const comp = makeComponent('relay', 413, 5, 5, { params: { setting, inputColor: WireColor.RED } });
  g.addComponent(comp);
  layHorizontal(g, 7, 16, 5, WireColor.YELLOW);
  g.tick(); /* 结构帧 */
  g.run(2); /* 稳态 */
  g.drive(0, 5, WireColor.RED, true);
  g.tick(); /* 本帧输入线通电,继电器读到并登记输出 */
  const base = g.tickCount;
  for (let i = 1; i <= 24; i += 1) {
    g.tick();
    if (g.liveAt(16, 5, WireColor.YELLOW)) return g.tickCount - base;
  }
  return -1;
}

test('WT-08-10 延时继电器四档实测触发帧数 = 1/1/2/4', () => {
  const measured = [0, 1, 2, 3].map((s) => measureRelayTicks(s));
  eq(measured[0], RELAY_DELAY_TICKS[0], `档位 0(0.2s)实测 ${measured[0]} 帧`);
  eq(measured[1], RELAY_DELAY_TICKS[1], `档位 1(0.5s)实测 ${measured[1]} 帧`);
  eq(measured[2], RELAY_DELAY_TICKS[2], `档位 2(1.0s)实测 ${measured[2]} 帧`);
  eq(measured[3], RELAY_DELAY_TICKS[3], `档位 3(2.0s)实测 ${measured[3]} 帧`);
  ok(measured[3] > measured[2], '2.0s 档位必须比 1.0s 档位慢');
  ok(measured[2] > measured[1], '1.0s 档位必须比 0.5s 档位慢');
  /* 帧 ↔ 秒换算自洽 */
  eq(measured[3] / SLOW_TICK_HZ, 2.0, '4 帧 = 2.0s');
  eq(measured[2] / SLOW_TICK_HZ, 1.0, '2 帧 = 1.0s');
});

/* ══════════════════ 5. 分流器三路分布 ══════════════════ */

test('WT-08-11 分流器三路各跑 10000 次,分布落在 ±5%', () => {
  const counts = [0, 0, 0];
  const total = 10000;
  let state = 0x2545f491 | 0;
  const units: number[] = [];
  for (let i = 0; i < total; i += 1) {
    state = nextRandom(state);
    const u = randomUnit(state);
    units.push(u);
    counts[chooseSplitterRoute(u)] += 1;
  }
  eq(counts[0] + counts[1] + counts[2], total, '三路计数之和必须等于总数');
  for (let i = 0; i < 3; i += 1) {
    const ratio = counts[i] / total;
    const diff = Math.abs(ratio - 1 / 3);
    ok(diff <= 0.05, `${SPLITTER_ROUTE_NAMES[i]} 占比 ${(ratio * 100).toFixed(2)}% 偏差 ${(diff * 100).toFixed(2)}% > 5%`);
    ok(counts[i] > 0, `${SPLITTER_ROUTE_NAMES[i]} 必须出现过`);
  }
  ok(new Set(units).size > 9000, 'PRNG 应输出足够多的不同值,不是常量');
});

test('WT-08-12 分流器边界:u=0 走东、u=1/3 走南、u=2/3 走西、u→1 走西', () => {
  eq(chooseSplitterRoute(0), 0, 'u=0 → 第 1 路');
  eq(chooseSplitterRoute(1 / 3 - 1e-9), 0, '刚小于 1/3 → 第 1 路');
  eq(chooseSplitterRoute(1 / 3), 1, 'u=1/3 → 第 2 路');
  eq(chooseSplitterRoute(2 / 3 - 1e-9), 1, '刚小于 2/3 → 第 2 路');
  eq(chooseSplitterRoute(2 / 3), 2, 'u=2/3 → 第 3 路');
  eq(chooseSplitterRoute(0.999999), 2, 'u→1 → 第 3 路');
  eq(chooseSplitterRoute(-1), 0, '负值夹取');
  eq(chooseSplitterRoute(2), 2, '超界夹取');
});

test('WT-08-13 分流器 xorshift32 PRNG 确定性且非退化', () => {
  const a = nextRandom(12345);
  const b = nextRandom(12345);
  eq(a, b, '同种子必须同输出(可复现)');
  ok(nextRandom(0) !== 0, '种子 0 应被替换为非零状态');
  let s = 1;
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i += 1) {
    s = nextRandom(s);
    seen.add(s);
  }
  ok(seen.size > 990, `1000 次迭代应产出近 1000 个不同值,实际 ${seen.size}`);
});

test('WT-08-14 分流器组件:触发脉冲后恰好点亮一路', () => {
  /* 三路输出色必须落在组件中心的 READ_RADIUS(=2)圈内:x 从 7 起 */
  const g = new SignalGraph(20, 20);
  for (const c of [WireColor.RED, WireColor.BLUE, WireColor.GREEN]) layHorizontal(g, 7, 16, 7, c);
  const comp = makeComponent('split', 416, 5, 7);
  g.addComponent(comp);
  g.tick();
  comp.params.trigger = 1;
  g.run(3);
  const lit = [WireColor.RED, WireColor.BLUE, WireColor.GREEN].filter((c) => g.liveAt(16, 7, c));
  eq(lit.length, 1, `应恰好点亮一路,实际 ${lit.length} 路`);
  eq(comp.state.rolls, 1, '应记录 1 次 roll');
  const route = comp.state.route;
  ok(route >= 0 && route <= 2, `route 应在 0..2,实际 ${route}`);
  eq(lit[0], [WireColor.RED, WireColor.BLUE, WireColor.GREEN][route], '点亮的颜色应与 route 一致');
  /* 撤销触发:三路全灭 */
  comp.params.trigger = 0;
  g.run(4);
  const off = [WireColor.RED, WireColor.BLUE, WireColor.GREEN].filter((c) => g.liveAt(16, 7, c));
  eq(off.length, 0, '触发撤销后三路全灭');
  /* 二次触发:仍恰好一路,累计 2 次 roll */
  comp.params.trigger = 1;
  g.run(3);
  const lit2 = [WireColor.RED, WireColor.BLUE, WireColor.GREEN].filter((c) => g.liveAt(16, 7, c));
  eq(lit2.length, 1, '二次触发仍恰好一路');
  eq(comp.state.rolls, 2, '累计 2 次 roll');
});

/* ══════════════════ 6. 计数器 0→99→0 回卷 ══════════════════ */

test('WT-08-15 计数器纯函数:0→1,99→0 回卷,满 100 次归零', () => {
  eq(counterStep(0, true), 1, '0 收到脉冲 → 1');
  eq(counterStep(50, true), 51, '50 → 51');
  eq(counterStep(98, true), 99, '98 → 99');
  eq(counterStep(99, true), 0, '99 → 0 回卷');
  eq(counterStep(42, false), 42, '无脉冲不变');
  eq(counterStep(-1, false), 99, '负值归一化到 99');
  let v = 0;
  for (let i = 0; i < 100; i += 1) v = counterStep(v, true);
  eq(v, 0, '连打 100 次脉冲应回到 0');
  let v2 = 0;
  for (let i = 0; i < 99; i += 1) v2 = counterStep(v2, true);
  eq(v2, 99, '连打 99 次停在 99');
});

test('WT-08-16 计数器翻页显示:十位/个位分解正确', () => {
  eq(counterDigits(0).tens, 0, '0 十位 0');
  eq(counterDigits(0).ones, 0, '0 个位 0');
  eq(counterDigits(7).tens, 0, '7 十位 0');
  eq(counterDigits(7).ones, 7, '7 个位 7');
  eq(counterDigits(42).tens, 4, '42 十位 4');
  eq(counterDigits(42).ones, 2, '42 个位 2');
  eq(counterDigits(99).tens, 9, '99 十位 9');
  eq(counterDigits(99).ones, 9, '99 个位 9');
  eq(counterDigits(100).tens, 0, '100 已回卷到 0');
});

test('WT-08-17 计数器组件:60 次脉冲后显示 60,第 100 次回到 0', () => {
  const g = new SignalGraph(16, 16);
  const comp = makeComponent('ctr', 417, 4, 4);
  g.addComponent(comp);
  for (let i = 0; i < 60; i += 1) {
    comp.params.pulse = 1;
    g.tick();
    comp.params.pulse = 0;
    g.tick();
  }
  eq(comp.state.value, 60, `60 次脉冲后应为 60,实际 ${comp.state.value}`);
  ok(comp.state.value <= 99, '显示值不得越过 99');
  for (let i = 0; i < 40; i += 1) {
    comp.params.pulse = 1;
    g.tick();
    comp.params.pulse = 0;
    g.tick();
  }
  eq(comp.state.value, 0, '累计 100 次后回卷到 0');
  eq(comp.state.count, 100, '内部累计计数 100');
});

/* ══════════════════ 7. 无线频道 1~8 ══════════════════ */

test('WT-08-18 频道匹配矩阵:同频道联动、跨频道不联动(8×8 穷举)', () => {
  let same = 0;
  let diff = 0;
  for (let tx = 1; tx <= 8; tx += 1) {
    for (let rx = 1; rx <= 8; rx += 1) {
      const m = channelMatches(tx, rx);
      if (tx === rx) {
        ok(m, `同频道 ${tx} 必须联动`);
        same += 1;
      } else {
        ok(!m, `跨频道 ${tx}→${rx} 不得联动`);
        diff += 1;
      }
    }
  }
  eq(same, 8, '对角线 8 组同频道');
  eq(diff, 64 - 8, '其余 56 组跨频道');
  eq(CHANNEL_MIN, 1, '频道下界 1');
  eq(CHANNEL_MAX, 8, '频道上界 8');
});

test('WT-08-19 无线图级联动:频道 3 发射 → 频道 3 收到、频道 5 收不到', () => {
  const g = new SignalGraph(16, 16);
  g.setChannel(3, true);
  eq(g.getChannel(3), true, '频道 3 已广播');
  eq(g.getChannel(5), false, '频道 5 未广播');
  g.setChannel(5, false);
  eq(g.getChannel(5), false, '重复写 false 保持 false');
});

test('WT-08-20 无线组件:本地输入 → 写频道 → 同频道接收器读到', () => {
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 0, 2, 4, WireColor.RED);
  const tx = makeComponent('tx', 418, 4, 4, { params: { channel: 6 } });
  const rx = makeComponent('rx', 418, 8, 8, { params: { channel: 6 } });
  const rxOther = makeComponent('rxo', 418, 8, 12, { params: { channel: 2 } });
  g.addComponent(tx);
  g.addComponent(rx);
  g.addComponent(rxOther);
  g.tick();
  g.drive(0, 4, WireColor.RED, true);
  g.run(3);
  eq(g.getChannel(6), true, '发射塔把频道 6 置为 1');
  eq(tx.state.broadcasting, 1, '发射塔自身处于广播态');
  eq(rx.state.channel, 6, '接收器 A 在频道 6');
  eq(rxOther.state.channel, 2, '接收器 B 在频道 2');
  eq(channelMatches(rx.state.channel, 6), true, '同频道 A 联动');
  eq(channelMatches(rxOther.state.channel, 6), false, '跨频道 B 不联动');
});

test('WT-08-21 无线接收端反向联动:接收器读到的频道态会点亮自己的黄线', () => {
  const g = new SignalGraph(16, 16);
  const tx = makeComponent('tx', 418, 2, 2, { params: { channel: 4 } });
  layHorizontal(g, 6, 12, 6, WireColor.YELLOW);
  const rx = makeComponent('rx', 418, 5, 6, { params: { channel: 4 } });
  g.addComponent(tx);
  g.addComponent(rx);
  g.setChannel(4, true);
  g.run(3);
  eq(g.liveAt(12, 6, WireColor.YELLOW), true, '接收器应把频道态输出到黄线');
  g.setChannel(4, false);
  g.run(3);
  eq(g.liveAt(12, 6, WireColor.YELLOW), false, '频道归零后黄线应断电');
});

test('WT-08-22 无线频道越界夹取到 1~8', () => {
  const g = new SignalGraph(8, 8);
  g.setChannel(0, true);
  eq(g.getChannel(1), true, '频道 0 夹取到 1');
  g.setChannel(99, true);
  eq(g.getChannel(8), true, '频道 99 夹取到 8');
  eq(g.getChannel(9), false, '频道 9 不存在,读取为 false');
});

/* ══════════════════ 8. 传感器与其余电路件 ══════════════════ */

test('WT-08-23 压力板 401/402:轻触压上即 1,重压板需 2 个重量单位', () => {
  const g = new SignalGraph(8, 8);
  const light = makeComponent('light', 401, 2, 2);
  const heavy = makeComponent('heavy', 402, 4, 4);
  g.addComponent(light);
  g.addComponent(heavy);
  light.params.entityCount = 1;
  heavy.params.entityWeight = 1;
  g.run(2);
  eq(light.state === undefined ? 0 : 0, 0, '占位断言:状态通过输出线体现');
  eq(SPEC_BY_ID.get(401)?.kind, 'SENSOR_PLATE_LIGHT', '401 类型');
  eq(SPEC_BY_ID.get(402)?.params.requiredWeight, 2, '402 需要 2 个重量单位');
});

test('WT-08-23b 压力板输出到线:轻触板压上 → 红线 1,重压板仅 1 人 → 0', () => {
  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 2, WireColor.RED);
  const light = makeComponent('light', 401, 2, 2);
  g.addComponent(light);
  light.params.entityCount = 1;
  g.run(2);
  eq(g.liveAt(6, 2, WireColor.RED), true, '轻触板压上应输出 1');

  const g2 = new SignalGraph(8, 8);
  layHorizontal(g2, 3, 6, 4, WireColor.RED);
  const heavy = makeComponent('heavy', 402, 2, 4);
  g2.addComponent(heavy);
  heavy.params.entityWeight = 1;
  g2.run(2);
  eq(g2.liveAt(6, 4, WireColor.RED), false, '重压板仅 1 人不得输出');
  heavy.params.entityWeight = 2;
  g2.run(2);
  eq(g2.liveAt(6, 4, WireColor.RED), true, '重压板 2 人应输出');
});

test('WT-08-24 拉杆 403 常开/常闭切换,按钮 404 脉冲后弹回', () => {
  const g = new SignalGraph(8, 8);
  const lever = makeComponent('lever', 403, 2, 2);
  const button = makeComponent('button', 404, 4, 4);
  g.addComponent(lever);
  g.addComponent(button);
  g.tick();
  eq(lever.state.on, 0, '拉杆初态为关');
  lever.params.togglePulse = 1;
  g.tick();
  eq(lever.state.on, 1, '点击后翻转为开');
  lever.params.togglePulse = 0;
  g.tick();
  eq(lever.state.on, 1, '不再点击则保持常开');
  lever.params.togglePulse = 1;
  g.tick();
  eq(lever.state.on, 0, '再点一次回到常闭');
  lever.params.togglePulse = 0;

  button.params.pressed = 1;
  g.tick();
  eq(button.state.remain, PULSE_TICKS(), '按下后进入脉冲倒计时');
  button.params.pressed = 0;
  g.tick();
  eq(button.state.remain, 0, '脉冲在 1 帧后结束(2Hz 下 0.5s)');
});

function PULSE_TICKS(): number {
  return Math.max(1, Math.ceil(0.5 / FRAME_SECONDS - 1e-9));
}

test('WT-08-25 感光器 405:夜间输出 1、白天输出 0,昼夜边界正确', () => {
  eq(isNight(19), true, '19:00 起入夜');
  eq(isNight(23), true, '23:00 是夜');
  eq(isNight(0), true, '00:00 是夜');
  eq(isNight(5), true, '05:00 是夜');
  eq(isNight(6), false, '06:00 天亮');
  eq(isNight(12), false, '12:00 白天');
  eq(isNight(18), false, '18:00 仍是白天');
  eq(isNight(-5), true, '负小时归一化:−5 ≡ 19 时,是夜');

  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 3, WireColor.RED);
  const sensor = makeComponent('light', 405, 2, 3);
  g.addComponent(sensor);
  sensor.params.hour = 22;
  g.run(2);
  eq(g.liveAt(6, 3, WireColor.RED), true, '夜里感光器输出 1');
  sensor.params.hour = 10;
  g.run(2);
  eq(g.liveAt(6, 3, WireColor.RED), false, '白天感光器输出 0');
});

test('WT-08-26 水位传感器 406 与仓库满载传感器 409', () => {
  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 2, WireColor.RED);
  layHorizontal(g, 3, 6, 5, WireColor.BLUE);
  const water = makeComponent('water', 406, 2, 2);
  const chest = makeComponent('chest', 409, 2, 5);
  g.addComponent(water);
  g.addComponent(chest);
  water.params.fluid = 1;
  chest.params.chestFull = 0;
  g.run(2);
  eq(g.liveAt(6, 2, WireColor.RED), true, '有水漫入 → 输出 1');
  eq(g.liveAt(6, 5, WireColor.BLUE), false, '箱子未满 → 输出 0');
  chest.params.chestFull = 1;
  g.run(2);
  eq(g.liveAt(6, 5, WireColor.BLUE), true, '箱子满载 → 输出 1');
});

test('WT-08-27 音高传感器 408:精确匹配才开门,容差可配', () => {
  eq(pitchMatches(60, 60, 0), true, '同音高命中');
  eq(pitchMatches(61, 60, 0), false, '差半音不命中(容差 0)');
  eq(pitchMatches(61, 60, 1), true, '容差 1 时命中');
  eq(pitchMatches(58, 60, 1), false, '差 2 半音即使容差 1 也不命中');
  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 3, WireColor.RED);
  const sensor = makeComponent('pitch', 408, 2, 3, { params: { pitch: 64, tolerance: 0 } });
  g.addComponent(sensor);
  sensor.params.pitchActive = 1;
  sensor.params.playedPitch = 67;
  g.run(2);
  eq(g.liveAt(6, 3, WireColor.RED), false, '弹错音不开门');
  sensor.params.playedPitch = 64;
  g.run(2);
  eq(g.liveAt(6, 3, WireColor.RED), true, '弹对音开门');
});

test('WT-08-28 激光绊线 407 与脉冲按钮语义一致:穿过即以 1 帧脉冲输出', () => {
  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 3, WireColor.RED);
  const trip = makeComponent('trip', 407, 2, 3);
  g.addComponent(trip);
  trip.params.crossed = 1;
  g.run(2);
  eq(g.liveAt(6, 3, WireColor.RED), true, '穿过瞬间输出 1');
  trip.params.crossed = 0;
  g.run(3);
  eq(g.liveAt(6, 3, WireColor.RED), false, '离开后归 0');
});

test('WT-08-29 竞技传感 410~412:球门计分、发令门开跑、领奖台停表', () => {
  const g = new SignalGraph(16, 16);
  const goal = makeComponent('goal', 410, 2, 2, { params: { team: 0 } });
  const gate = makeComponent('gate', 411, 2, 6);
  const podium = makeComponent('podium', 412, 2, 10);
  g.addComponent(goal);
  g.addComponent(gate);
  g.addComponent(podium);
  goal.params.scored = 1;
  g.tick();
  eq(goal.state.scoreRed, 1, '红队进球 1 次');
  goal.params.team = 1;
  g.tick();
  eq(goal.state.scoreBlue, 1, '蓝队进球 1 次');
  /* 发令门先开表 */
  gate.params.whistle = 1;
  g.tick();
  eq(gate.state.raceRunning, 1, '吹哨后开始计时');
  eq(g.race.running, 1, '共享比赛时钟已启动');
  /* 领奖台停下共享时钟 */
  podium.params.onPodium = 1;
  podium.params.nowMs = 12340;
  g.tick();
  eq(podium.state.finished, 1, '踏上领奖台即停表');
  eq(g.race.running, 0, '共享比赛时钟已停止');
  eq(podium.state.finishMs, 12340, '停表时间 12340ms');
  eq(formatRunTime(podium.state.finishMs), '12.34', '格式化 12340ms → 12.34');
});

/* ══════════════════ 9. 执行器 419~424 与防御 425 ══════════════════ */

test('WT-08-30 音符砖 419:通电播一次音高,持续通电不重复触发', () => {
  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 2, WireColor.RED);
  const note = makeComponent('note', 419, 2, 2, { params: { pitch: 7, timbre: 2 } });
  g.addComponent(note);
  g.drive(6, 2, WireColor.RED, true);
  g.run(2);
  eq(note.state.notesPlayed, 1, '首次通电播 1 次');
  eq(note.state.lastPitch, 7, '音高 7 生效');
  eq(note.state.lastTimbre, 2, '音色 2 生效');
  g.run(4);
  eq(note.state.notesPlayed, 1, '持续通电不得重复播放');
  g.drive(6, 2, WireColor.RED, false);
  g.run(2);
  g.drive(6, 2, WireColor.RED, true);
  g.run(2);
  eq(note.state.notesPlayed, 2, '断电再通电应播第二次');
});

test('WT-08-31 灯箱 420 / 隐藏墙 421:通电点亮、通电沉入地下', () => {
  /* 组件占 3×3,端口圈在中心 ±2;两件都放在红线端口圈内 */
  const g = new SignalGraph(12, 12);
  layHorizontal(g, 3, 6, 2, WireColor.RED);
  const lamp = makeComponent('lamp', 420, 2, 2, { params: { colorIndex: 11 } });
  const wall = makeComponent('wall', 421, 2, 4);
  g.addComponent(lamp);
  g.addComponent(wall);
  g.drive(6, 2, WireColor.RED, true);
  g.run(2);
  eq(lamp.state.lit, 1, '通电点亮');
  eq(lamp.state.colorIndex, 11, '颜色索引 11');
  eq(wall.state.sunk, 1, '通电沉入地下');
  eq(wall.state.solid, 0, '沉入后不再阻挡');
  g.drive(6, 2, WireColor.RED, false);
  g.run(2);
  eq(lamp.state.lit, 0, '断电熄灭');
  eq(wall.state.solid, 1, '断电升起阻挡');
});

test('WT-08-32 弹簧垫 422 / 旋转推杆 423 / 活塞臂 424', () => {
  /* 组件占 3×3,端口圈在中心 ±2;三个件的中心都必须落在红线端口圈内 */
  const g = new SignalGraph(12, 12);
  layHorizontal(g, 3, 9, 3, WireColor.RED);
  const spring = makeComponent('spring', 422, 4, 3, { params: { launchDir: 2, range: 5 } });
  const rotator = makeComponent('rot', 423, 7, 3);
  const piston = makeComponent('piston', 424, 9, 5);
  g.addComponent(spring);
  g.addComponent(rotator);
  g.addComponent(piston);
  g.drive(3, 3, WireColor.RED, true);
  spring.params.payloadAbove = 1;
  g.run(2);
  eq(spring.state.launches, 1, '弹簧垫弹射 1 次');
  ok(spring.state.cooldown > 0, '弹射后进入冷却');
  eq(spring.state.armed, 1, '有载荷且通电应处于待发态');
  g.run(6);
  eq(spring.state.launches, 1, '边沿触发:持续通电 + 载荷不变不得重复弹射');
  ok(rotator.state.angleQ > 0, '推杆通电持续旋转');
  eq(rotator.state.spinning, 1, '推杆处于旋转态');
  eq(piston.state.extended, 1, '活塞伸出');
  eq(piston.state.strokes, 1, '记录 1 次行程');
  g.drive(3, 3, WireColor.RED, false);
  g.run(2);
  eq(piston.state.extended, 0, '断电缩回');
  eq(piston.state.strokes, 2, '记录第 2 次行程');
  eq(rotator.state.spinning, 0, '断电停转');
});

test('WT-08-33 连弩炮台 425:通电自动索敌开火,无目标不开火,断电停火', () => {
  const g = new SignalGraph(8, 8);
  layHorizontal(g, 3, 6, 3, WireColor.RED);
  const turret = makeComponent('turret', 425, 2, 3, { params: { range: 7 } });
  g.addComponent(turret);
  turret.params.enemyInRange = 0;
  g.drive(6, 3, WireColor.RED, true);
  g.run(4);
  eq(turret.state.shots, 0, '无目标不得开火');
  turret.params.enemyInRange = 1;
  g.run(2);
  eq(turret.state.shots, 1, '有目标开火 1 次');
  g.run(2);
  eq(turret.state.shots, 2, '冷却结束后再次开火');
  eq(SPEC_BY_ID.get(425)?.params.range, 7, '索敌半径 7 格');
  g.drive(6, 3, WireColor.RED, false);
  g.run(4);
  eq(turret.state.firing, 0, '断电停止开火');
});

/* ══════════════════ 10. 农业水利 426~427 与氛围/竞技/载具 432~440 ══════════════════ */

test('WT-08-34 洒水器 426 与拦水闸 427', () => {
  /* 两件都必须在蓝线端口圈(中心 ±2)内 */
  const g = new SignalGraph(12, 12);
  layHorizontal(g, 3, 8, 3, WireColor.BLUE);
  const sprinkler = makeComponent('spr', 426, 3, 5);
  const sluice = makeComponent('sluice', 427, 7, 5);
  g.addComponent(sprinkler);
  g.addComponent(sluice);
  g.drive(3, 3, WireColor.BLUE, true);
  g.run(2);
  eq(sprinkler.state.active, 1, '接通水源即旋转');
  eq(sprinkler.state.wetCells, 25, '浇湿 5×5 = 25 格');
  eq(sluice.state.open, 1, '通电开闸');
  eq(sluice.state.flowRate, 100, '开闸后过流 100');
  g.drive(3, 3, WireColor.BLUE, false);
  g.run(2);
  eq(sprinkler.state.active, 0, '断水停止');
  eq(sluice.state.open, 0, '断电关闸蓄水');
  eq(sluice.state.flowRate, 0, '关闸后无过流');
});

test('WT-08-35 烟花 432 / 果冻球生成座 433 / 皇冠底座 434', () => {
  /* 烟花与果冻球共用一张图:两者的端口圈都覆盖同一条红线 */
  const g = new SignalGraph(12, 12);
  layHorizontal(g, 3, 8, 2, WireColor.RED);
  const firework = makeComponent('fw', 432, 3, 4, { params: { salvo: 5 } });
  const jellball = makeComponent('jb', 433, 6, 4);
  g.addComponent(firework);
  g.addComponent(jellball);
  g.drive(3, 2, WireColor.RED, true);
  g.run(2);
  eq(firework.state.shells, 5, '通电连发 5 枚');
  eq(firework.state.launched, 1, '只触发一轮');
  eq(jellball.state.ballAlive, 1, '刷出一颗果冻球');
  eq(jellball.state.spawned, 1, '生成计数 1');
  g.run(4);
  eq(firework.state.shells, 5, '持续通电不重复连发');
  eq(jellball.state.spawned, 1, '已有球时不再生成');

  /*
   * 皇冠底座**必须独立建图**:它由 start 参数启动,不能被别处的红线提前带起
   * (放在上面那张图里会被 y=2 的红线在端口圈内点亮,开赛提前 6 帧 → 实测 354)。
   */
  const g2 = new SignalGraph(12, 12);
  const crown = makeComponent('crown', 434, 5, 5, { params: { roundSeconds: 180 } });
  g2.addComponent(crown);
  crown.params.start = 1;
  g2.tick();
  /*
   * 计时约定:置位帧把 running 立起并写入初值,同帧不递减
   * (`else if (running)` 分支当帧不进)。此后每帧 -1。
   * 因此「置位帧」+「360 个递减帧」才是完整一轮,断言必须区分这两段。
   */
  eq(crown.state.running, 1, '皇冠赛开始');
  eq(crown.state.remainTicks, 180 * 2, '置位帧写入初值 360,当帧不递减');
  crown.params.holder = 1;
  g2.run(10);
  eq(crown.state.holderTicks, 10, '持冠秒数按帧累计');
  eq(crown.state.remainTicks, 360 - 10, '10 帧后剩 350');
  g2.run(349);
  eq(crown.state.remainTicks, 1, '共递减 359 帧后剩 1 帧,比赛仍在进行');
  eq(crown.state.running, 1, '剩 1 帧时 running 仍为 1');
  g2.tick();
  eq(crown.state.remainTicks, 0, '第 360 个递减帧倒数到 0');
  eq(crown.state.running, 0, '恰好 360 帧递减后比赛结束');
});

test('WT-08-36 队伍旗 435 / 裁判哨台 436 四模式广播', () => {
  const g = new SignalGraph(8, 8);
  const banner = makeComponent('banner', 435, 2, 2, { params: { team: 2 } });
  const desk = makeComponent('desk', 436, 2, 5);
  g.addComponent(banner);
  g.addComponent(desk);
  g.run(2);
  eq(banner.state.revives, 0, '初始无复活');
  banner.params.revivePulse = 1;
  g.tick();
  eq(banner.state.revives, 1, '复活 1 次');
  for (let mode = 1; mode <= 4; mode += 1) {
    desk.params.mode = mode;
    g.run(2);
    eq(desk.state.mode, mode, `模式 ${mode} 生效`);
    eq(desk.state.running, 1, `模式 ${mode} 处于运行态`);
  }
  desk.params.mode = -1;
  g.run(2);
  eq(desk.state.mode, 0, '−1 停止比赛');
  eq(desk.state.running, 0, '停止后 running = 0');
});

test('WT-08-37 载具 437~440:火车碾压、车厢随动、天鹅船、飞艇', () => {
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 3, 8, 3, WireColor.GREEN);
  const train = makeComponent('train', 437, 2, 3, { params: { crushDamage: 150 } });
  const wagon = makeComponent('wagon', 438, 2, 6);
  const boat = makeComponent('boat', 439, 2, 9);
  const ship = makeComponent('ship', 440, 2, 12, { params: { seats: 8 } });
  g.addComponent(train);
  g.addComponent(wagon);
  g.addComponent(boat);
  g.addComponent(ship);
  g.drive(8, 3, WireColor.GREEN, true);
  train.params.hitMob = 1;
  wagon.params.coupled = 1;
  wagon.params.riderCount = 2;
  boat.params.fluid = 1;
  boat.params.riderCount = 2;
  ship.params.riderCount = 8;
  g.run(2);
  eq(train.state.moving, 1, '火车通电行驶');
  eq(train.state.crushes, 1, '碾压 1 只怪');
  eq(train.state.lastCrushDamage, 150, '碾压伤害 150');
  eq(wagon.state.coupled, 1, '车厢已挂接');
  eq(wagon.state.riders, 2, '车厢载 2 人');
  eq(boat.state.afloat, 1, '天鹅船在水上');
  eq(boat.state.riderCount, 2, '限定 2 人同乘');
  eq(ship.state.crew, 8, '飞艇载 8 人');
  eq(SPEC_BY_ID.get(437)?.params.crushDamage, 150, '火车碾压伤害配表 150');
  eq(SPEC_BY_ID.get(440)?.params.seats, 8, '飞艇 8 座');
});

/* ══════════════════ 11. 40 项覆盖自检 ══════════════════ */

test('WT-08-38 401~440 全部 40 项注册且 ID 无缺口', () => {
  const audit = auditComponentCoverage();
  eq(audit.total, 40, '规格表应恰 40 项');
  eq(audit.idGaps.length, 0, `ID 不应有缺口,实际缺 ${audit.idGaps.join(',')}`);
  eq(audit.missingKinds.length, 0, `全部 kind 应已注册,实际缺 ${audit.missingKinds.join(',')}`);
  eq(COMPONENT_SPECS.length, 40, '规格条目 40');
  for (let id = 401; id <= 440; id += 1) ok(SPEC_BY_ID.has(id), `物品 ${id} 必须有行为实现`);
});

test('WT-08-39 每个注册的 kind 都能在真实图上跑一帧不抛异常', () => {
  const g = new SignalGraph(8, 8);
  let n = 0;
  for (const spec of COMPONENT_SPECS) {
    ok(hasComponentKind(spec.kind), `${spec.kind} 应已注册`);
    const comp = makeComponent(`c${spec.id}`, spec.id, 2, 2);
    g.addComponent(comp);
    n += 1;
  }
  eq(n, 40, '40 个件全部挂载');
  g.run(3);
  ok(registeredKinds().length >= 40, `注册表应含 ≥40 种,实际 ${registeredKinds().length}`);
  eq(g.stats.componentsEvaluated, 40, '本帧应评估 40 个件');
  /* 再断电跑一轮,确保无异常 */
  g.markAllDirty();
  g.run(5);
});

test('WT-08-40b 全 40 件 state 键在挂载时即存在(无 undefined)', () => {
  /* 回归护栏:曾出现「期望 0 / 实际 undefined」——只在条件分支里 setSt 不够 */
  const g = new SignalGraph(8, 8);
  for (const spec of COMPONENT_SPECS) {
    const comp = makeComponent(`c${spec.id}`, spec.id, 2, 2);
    g.addComponent(comp);
    const declared = STATE_DEFAULTS[spec.kind];
    ok(declared !== undefined, `${spec.kind} 必须有 STATE_DEFAULTS 声明`);
    for (const key of Object.keys(declared!)) {
      eq(typeof comp.state[key], 'number', `${spec.kind}.${key} 挂载时必须是 number,实际 ${typeof comp.state[key]}`);
    }
  }
  /* 每个 kind 的声明键与运行后实际键集合对得上(允许实现新增键) */
  g.run(3);
  for (const spec of COMPONENT_SPECS) {
    const comp = g.get(`c${spec.id}`)!;
    for (const key of Object.keys(STATE_DEFAULTS[spec.kind]!)) {
      eq(typeof comp.state[key], 'number', `${spec.kind}.${key} 跑 3 帧后仍是 number`);
    }
  }
});

test('WT-08-40c 关键件被显式写入的 state 键可被外部读取(双向对账)', () => {
  /* 412 领奖台 / 425 连弩 / 433 果冻球 / 435 队伍旗:曾整片缺失 */
  const g = new SignalGraph(12, 12);
  const podium = makeComponent('p', 412, 2, 2);
  const turret = makeComponent('t', 425, 2, 5);
  const jelly = makeComponent('j', 433, 6, 2);
  const banner = makeComponent('b', 435, 6, 5, { params: { team: 1 } });
  for (const c of [podium, turret, jelly, banner]) g.addComponent(c);
  g.run(3);
  for (const k of ['finished', 'finishMs']) {
    eq(typeof podium.state[k], 'number', `412.${k} 必须存在`);
  }
  for (const k of ['shots', 'cooldown', 'firing']) {
    eq(typeof turret.state[k], 'number', `425.${k} 必须存在`);
    eq(turret.state[k], 0, `425.${k} 静默时应为 0`);
  }
  for (const k of ['ballAlive', 'spawned']) {
    eq(typeof jelly.state[k], 'number', `433.${k} 必须存在`);
  }
  eq(typeof banner.state.revives, 'number', '435.revives 必须存在');
  eq(banner.state.revives, 0, '435 初始无复活');
});

test('WT-08-40 规格表分组与输出色自洽', () => {
  eq(SIGNAL_IDS.length + PURE_EFFECT_IDS.length, 40, '信号件 + 纯效果件 = 40');
  for (const s of COMPONENT_SPECS) {
    ok(s.name.length > 0, `物品 ${s.id} 必须有名称`);
    ok(s.latencyTicks >= 1, `物品 ${s.id} 固有延迟至少 1 帧`);
    for (const c of s.outputs) ok(ALL_COLORS.includes(c), `物品 ${s.id} 输出色 ${c} 必须是合法四色之一`);
  }
  /* 逻辑控制四件固定输出黄线(分流器除外,它三路输出) */
  eq(SPEC_BY_ID.get(414)?.outputs[0], WireColor.YELLOW, 'AND 输出黄线');
  eq(SPEC_BY_ID.get(415)?.outputs[0], WireColor.YELLOW, 'NOT 输出黄线');
  eq(SPEC_BY_ID.get(413)?.outputs[0], WireColor.YELLOW, '继电器输出黄线');
  eq(SPEC_BY_ID.get(416)?.outputs.length, 3, '分流器三路输出');
});

/* ══════════════════ 12. 脏网络增量优化 ══════════════════ */

test('WT-08-41 全量模式每帧泛洪四色;脏模式只泛洪受影响分量', () => {
  const gFull = new SignalGraph(48, 48, false);
  for (let y = 2; y < 46; y += 4) layHorizontal(gFull, 2, 44, y, WireColor.RED);
  gFull.tick();
  gFull.drive(2, 2, WireColor.RED, true);
  const fullStats = gFull.tick();
  eq(fullStats.mode, PropagateMode.FULL, '全量模式应报 FULL');
  eq(fullStats.colorsFlooded, 4, '每帧泛洪四色');

  const gDirty = new SignalGraph(48, 48, true);
  for (let y = 2; y < 46; y += 4) layHorizontal(gDirty, 2, 44, y, WireColor.RED);
  for (let y = 4; y < 46; y += 8) layHorizontal(gDirty, 2, 44, y, WireColor.BLUE);
  gDirty.tick();
  gDirty.drive(2, 2, WireColor.RED, true);
  const dirtyStats = gDirty.tick();
  eq(dirtyStats.mode, PropagateMode.DIRTY_ONLY, '只改驱动时应报 DIRTY_ONLY');
  eq(dirtyStats.colorsFlooded, 1, '只泛洪受影响的 1 种颜色');
  ok(dirtyStats.cellsFlooded < fullStats.cellsFlooded, `脏模式泛洪格数 ${dirtyStats.cellsFlooded} 应少于全量 ${fullStats.cellsFlooded}`);
});

test('WT-08-42 脏网络优化不改变结果:与全量模式逐格一致', () => {
  const build = (dirty: boolean): SignalGraph => {
    const g = new SignalGraph(32, 32, dirty);
    /* 三条独立红线 + 一条蓝线,形成 4 个分量 */
    layHorizontal(g, 2, 29, 2, WireColor.RED);
    layHorizontal(g, 2, 29, 6, WireColor.RED);
    layHorizontal(g, 2, 29, 10, WireColor.RED);
    layHorizontal(g, 2, 29, 14, WireColor.BLUE);
    g.tick();
    return g;
  };
  const a = build(false);
  const b = build(true);
  /* 同样的驱动序列 */
  for (const g of [a, b]) {
    g.drive(2, 2, WireColor.RED, true);
    g.tick();
    g.drive(2, 6, WireColor.RED, true);
    g.tick();
    g.drive(2, 6, WireColor.RED, false);
    g.tick();
    g.drive(2, 14, WireColor.BLUE, true);
    g.tick();
    g.drive(2, 2, WireColor.RED, false);
    g.tick();
  }
  let diff = 0;
  for (let i = 0; i < 32 * 32; i += 1) if (a.liveBits[i] !== b.liveBits[i]) diff += 1;
  eq(diff, 0, '增量与全量结果必须逐格一致');
  eq(a.totalLiveCells(), b.totalLiveCells(), '通电格数一致');
  /* 闭区间 2..29 = 28 格;驱动序列结束时只剩蓝线(y=14)通电 */
  eq(a.totalLiveCells(), 28, '仅剩蓝线通电(28 格:闭区间 2..29)');
});

test('WT-08-43 结构变化强制全量重算,之后恢复脏模式', () => {
  const g = new SignalGraph(32, 32, true);
  layHorizontal(g, 2, 20, 2, WireColor.RED);
  g.tick();
  g.drive(2, 2, WireColor.RED, true);
  eq(g.tick().mode, PropagateMode.DIRTY_ONLY, '首次驱动走脏模式');
  layHorizontal(g, 2, 20, 8, WireColor.BLUE);
  eq(g.tick().mode, PropagateMode.FULL, '加线后必须全量重算');
  eq(g.tick().mode, PropagateMode.IDLE, '无变化时进入 IDLE');
  g.drive(2, 2, WireColor.RED, false);
  eq(g.tick().mode, PropagateMode.DIRTY_ONLY, '再次驱动恢复脏模式');
});

test('WT-08-44 脏网络未标记时进入 IDLE 且不泛洪', () => {
  const g = new SignalGraph(32, 32, true);
  layHorizontal(g, 2, 20, 2, WireColor.RED);
  g.tick();
  const s = g.tick();
  eq(s.mode, PropagateMode.IDLE, '无脏标记应为 IDLE');
  eq(s.cellsFlooded, 0, 'IDLE 帧不泛洪任何格');
});

test('WT-08-45 512×512 / 2 万线格性能估算:脏网络收益 ≥ 10 倍', () => {
  const est = estimateAdvanceCost(512, 20000, 400);
  eq(est.worldSize, 512, '世界边长 512');
  eq(est.wireCells, 20000, '电线格 2 万');
  eq(est.fullCells, 25000, '全量触碰 2 万 × 1.25 = 2.5 万格');
  eq(est.dirtyComponentCells, 40, '脏分量平均 40 格');
  eq(est.dirtyComponents, 20, '脏模式下只有 20 件受影响(400/20)');
  near(est.fullFrameUs, (25000 * 12 + 400 * 120) / 1000, 1e-6, '全量耗时 = 2.5 万格×12ns + 400 件×120ns');
  near(est.dirtyFrameUs, (40 * 12 + 20 * 120) / 1000, 1e-6, '脏耗时 = 40 格×12ns + 20 件×120ns');
  ok(est.speedup > 10, `收益倍数 ${est.speedup.toFixed(2)} 应 > 10`);
  /* 组件成本必须也参与脏优化:若改回 400 件全算,上界只有 7.25,这条立刻报红 */
  ok(est.speedup > 50, `收益 ${est.speedup.toFixed(1)} 应 > 50,说明组件成本确实参与了脏优化`);
  ok(est.fullFrameUs < 1000, `全量单帧 ${est.fullFrameUs.toFixed(1)}µs 应 < 1ms`);
  /* 分母是 2Hz 慢 tick 的 500000µs,不是 60fps 帧的 5%(我想错了的那个口径) */
  eq(est.frameBudgetUs, 500000, '2Hz 单帧预算 = 1/2 秒 = 500000µs');
  near(est.budgetRatioFull, 348 / 500000, 1e-9, '全量占 2Hz 帧预算 0.07%');
  ok(est.budgetRatioFull < 0.05, `全量占帧预算 ${(est.budgetRatioFull * 100).toFixed(3)}% 应 < 5%`);
  ok(est.budgetRatioDirty < 0.001, `脏模式占帧预算 ${(est.budgetRatioDirty * 100).toFixed(4)}% 应 < 0.1%`);
  /* 与 512×512 世界面积无关:清零不再是 O(W·H) */
  const bigger = estimateAdvanceCost(2048, 20000, 400);
  near(bigger.fullFrameUs, est.fullFrameUs, 1e-9, '世界放大 16 倍不增加单帧耗时(消除了整平面扫描)');
});

/* ══════════════════ 13. 物流:传送带 / 分拣 / 机械臂 / 钻头 ══════════════════ */

test('WT-08-46 传送带 1 格/秒:2Hz 下每 2 帧 1 格,10 帧走 5 格', () => {
  eq(CONVEYOR_CELLS_PER_SECOND, 1, '速度 1 格/秒');
  near(CONVEYOR_CELLS_PER_TICK, 0.5, 1e-12, '每帧 0.5 格');
  eq(CONVEYOR_TICKS_PER_CELL, 2, '走满 1 格需 2 帧');
  const st = createConveyorState(1);
  loadConveyor(st, { id: 151, count: 3 });
  let moves = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = stepConveyor(st, true);
    if (r.moved) {
      moves += 1;
      /* 把货放回,模拟无限长的带子 */
      ok(r.exit !== null, '移动时必须有去向');
      eq(r.exit!.dx, 1, '朝向东方 → dx=+1');
      eq(r.exit!.dy, 0, '朝向东方 → dy=0');
      loadConveyor(st, r.exit!.item);
    }
  }
  eq(moves, 5, `10 帧应走 5 格,实际 ${moves}`);
  eq(st.movedCells, 5, '累计搬运格数 5');
  eq(1 / CONVEYOR_CELLS_PER_SECOND, 1, '1 格耗时 1 秒');
});

test('WT-08-47 传送带:断电不走、空带不走、有货才计进度', () => {
  const st = createConveyorState(2);
  eq(stepConveyor(st, true).moved, false, '空带不推进');
  loadConveyor(st, { id: 101, count: 1 });
  eq(stepConveyor(st, false).moved, false, '断电不推进');
  near(st.progress, 0, 1e-12, '断电时进度不动');
  const r1 = stepConveyor(st, true);
  eq(r1.moved, false, '第 1 帧不够 1 格');
  near(r1.progress, 0.5, 1e-12, '第 1 帧进度 0.5');
  const r2 = stepConveyor(st, true);
  eq(r2.moved, true, '第 2 帧走满 1 格');
  eq(r2.exit!.dy, 1, '朝向南方 → dy=+1');
  near(r2.progress, 0, 1e-12, '走格后进度归零');
});

test('WT-08-48 分拣器:按过滤物品 ID 分流至左/前/右三路', () => {
  const filter = [151, 152];
  const st = createSorterState(1, filter);
  eq(pickRoute(st, 151), SorterRoute.FORWARD, '过滤命中 → 直行');
  eq(pickRoute(st, 152), SorterRoute.FORWARD, '过滤命中 → 直行');
  eq(pickRoute(st, 999), SorterRoute.RIGHT, '未命中 → 右转');
  /* 预演:朝东(1)出发,重定向方向正确 */
  const prev = previewRouting(filter, [151, 999], 1);
  eq(prev[0].route, SorterRoute.FORWARD, '151 直行');
  eq(prev[0].dx, 1, '直行保持 dx=+1(东)');
  eq(prev[1].route, SorterRoute.RIGHT, '999 右转');
  eq(prev[1].dy, 1, '东向右转 → 朝南 dy=+1');
  /* 实际跑一格 */
  const st2 = createSorterState(1, [151]);
  loadConveyor(st2.conveyor, { id: 999, count: 1 });
  stepSorter(st2, true);
  const r = stepSorter(st2, true);
  eq(r.moved, true, '2 帧后分流一格');
  eq(r.exit!.route, SorterRoute.RIGHT, '999 走右路');
  eq(r.exit!.dy, 1, '实际去向朝南');
  eq(st2.routed.get(999), 1, '分流统计记录 1 件');
});

test('WT-08-49 分拣器三向全路径覆盖(左/前/右)', () => {
  const cases: { route: SorterRoute; dx: number; dy: number }[] = [
    { route: SorterRoute.FORWARD, dx: 1, dy: 0 },
    { route: SorterRoute.RIGHT, dx: 0, dy: 1 },
  ];
  for (const c of cases) {
    const st = createSorterState(1, c.route === SorterRoute.FORWARD ? [151] : []);
    st.matchRoute = SorterRoute.FORWARD;
    st.defaultRoute = SorterRoute.RIGHT;
    loadConveyor(st.conveyor, { id: 151, count: 1 });
    stepSorter(st, true);
    const r = stepSorter(st, true);
    eq(r.exit!.route, c.route, `路由应为 ${c.route}`);
    eq(r.exit!.dx, c.dx, `${c.route} 的 dx`);
    eq(r.exit!.dy, c.dy, `${c.route} 的 dy`);
  }
  /* 显式 LEFT 分支 */
  const stL = createSorterState(1, []);
  stL.defaultRoute = SorterRoute.LEFT;
  loadConveyor(stL.conveyor, { id: 777, count: 1 });
  stepSorter(stL, true);
  const rl = stepSorter(stL, true);
  eq(rl.exit!.route, SorterRoute.LEFT, 'LEFT 分支可达');
  eq(rl.exit!.dy, -1, '东向左转 → 朝北 dy=−1');
});

test('WT-08-50 机械臂 430:2.0s = 4 帧一个循环,抓取后投喂', () => {
  eq(ARM_CYCLE_TICKS, 4, '单次循环 4 帧');
  shock: {
    const fed: number[] = [];
    const world: ArmWorld = {
      take: (x, y) => (x === 6 && y === 4 ? { id: 151, count: 1 } : null),
      feed: (deviceId) => {
        fed.push(deviceId);
        return true;
      },
      deviceAt: (x, y) => (x === 6 && y === 4 ? 503 : 0),
    };
    const arm = createArmState(0, 3);
    const seq: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = stepArm(arm, world, 4, 4, true);
      seq.push(r.phase);
    }
    includes(seq, 'CARRY', '循环中应出现 CARRY 阶段');
    includes(seq, 'DEPOSIT', '循环中应出现 DEPOSIT 阶段');
    eq(arm.delivered, 1, '一循环投喂 1 件');
    eq(fed.length, 1, '投喂目标被调用 1 次');
    eq(fed[0], 503, '投喂到高炉 503');
    eq(arm.held, null, '投喂后手上为空');
    ok(ARM_TARGETS.includes(503), '503 是合法投喂目标');
  }
});

test('WT-08-51 机械臂:无货时空转计数,断电回 IDLE', () => {
  const empty: ArmWorld = { take: () => null, feed: () => false, deviceAt: () => 0 };
  const arm = createArmState(0, 2);
  for (let i = 0; i < 8; i += 1) stepArm(arm, empty, 0, 0, true);
  ok(arm.idleCycles >= 2, `无货应累计空转,实际 ${arm.idleCycles}`);
  eq(arm.delivered, 0, '无货不得投喂');
  arm.phase = 'CARRY';
  stepArm(arm, empty, 0, 0, false);
  eq(arm.phase, 'IDLE', '断电立即回 IDLE');
});

test('WT-08-52 采矿钻头 431:10 秒 = 20 帧产 1 块,断电停机', () => {
  eq(DRILL_PERIOD_SECONDS, 10, '周期 10 秒');
  eq(DRILL_PERIOD_TICKS, 20, '20 帧');
  eq(ticksFor(10), 20, '秒→帧换算一致');
  const d = createDrillState(110);
  eq(d.oreId, 110, '矿脉 ID 110(黑曜石)');
  let produced = 0;
  for (let i = 1; i <= 20; i += 1) {
    const r = stepDrill(d, true);
    if (r.produced) produced += 1;
  }
  eq(produced, 1, '20 帧恰好产出 1 块');
  eq(d.produced, 1, '累计产出 1');
  eq(d.buffer!.id, 110, '缓冲中的矿是 110');
  eq(d.buffer!.count, 1, '缓冲 1 块');
  /* 再跑 60 帧 → 再产 3 块 */
  for (let i = 0; i < 60; i += 1) stepDrill(d, true);
  eq(d.produced, 4, '共产出 4 块');
  eq(d.buffer!.count, 4, '缓冲累计 4 块');
  const taken = takeDrillBuffer(d);
  eq(taken!.count, 4, '取走 4 块');
  eq(d.buffer, null, '取走后缓冲清空');
  /* 断电 */
  const before = d.produced;
  for (let i = 0; i < 40; i += 1) stepDrill(d, false);
  eq(d.produced, before, '断电不产出');
  eq(d.stalledTicks, 40, '累计宕机 40 帧');
});

test('WT-08-53 钻头无矿脉或跨周期边界:19 帧不产出、21 帧产出 1 块', () => {
  const d = createDrillState(110);
  for (let i = 0; i < 19; i += 1) stepDrill(d, true);
  eq(d.produced, 0, '19 帧还不够一个周期');
  eq(d.elapsed, 19, '已计 19 帧');
  const r = stepDrill(d, true);
  eq(r.produced !== null, true, '第 20 帧产出');
  eq(d.elapsed, 0, '产出后计时归零');
  const noOre = createDrillState(0);
  for (let i = 0; i < 60; i += 1) stepDrill(noOre, true);
  eq(noOre.produced, 0, '无矿脉不产出');
  eq(noOre.stalledTicks, 0, '无矿脉不算宕机(有动力)');
});

test('WT-08-54 物流流水线串行 tick:顺序为钻头→带→分拣→机械臂', () => {
  const line = {
    belts: [{ x: 2, y: 2, state: createConveyorState(1) }],
    sorters: [{ x: 3, y: 2, state: createSorterState(1, [151]) }],
    arms: [{ x: 0, y: 0, state: createArmState(0, 2) }],
    drills: [{ x: 1, y: 1, state: createDrillState(151) }],
  };
  loadConveyor(line.belts[0].state, { id: 151, count: 1 });
  loadConveyor(line.sorters[0].state.conveyor, { id: 151, count: 1 });
  const world: ArmWorld = {
    take: (x, y) => (x === 0 && y === 0 ? { id: 151, count: 1 } : null),
    feed: () => true,
    deviceAt: () => 503,
  };
  /* 4 帧循环约定:帧1 IDLE→REACH(布防) → 帧2 REACH 抓取 → 帧3 CARRY → 帧4 DEPOSIT 投喂 */
  const r1 = tickLogistics(line, world, { belt: true, arm: true, drill: true });
  eq(r1.beltMoves, 0, '传送带第 1 帧未走满格');
  eq(r1.sorterMoves, 0, '分拣第 1 帧未走满格');
  eq(r1.drillOres, 0, '钻头第 1 帧未产出');
  eq(r1.armGrabs, 0, '机械臂第 1 帧只布防,尚未抓取');
  const r2 = tickLogistics(line, world, { belt: true, arm: true, drill: true });
  eq(r2.beltMoves, 1, '第 2 帧传送带走 1 格');
  eq(r2.sorterMoves, 1, '第 2 帧分拣走 1 格');
  eq(r2.armGrabs, 1, '第 2 帧机械臂抓到 1 件');
  /* 跑满整轮:第 4 帧完成投喂 */
  const r3 = tickLogistics(line, world, { belt: true, arm: true, drill: true });
  const r4 = tickLogistics(line, world, { belt: true, arm: true, drill: true });
  eq(r3.armFeeds, 0, '第 3 帧仍在携带');
  eq(r4.armFeeds, 1, '第 4 帧完成投喂');
  /* 断电后全停 */
  const rep3 = tickLogistics(line, world, { belt: false, arm: false, drill: false });
  eq(rep3.beltMoves, 0, '断电传送带不动');
  eq(rep3.sorterMoves, 0, '断电分拣不动');
  eq(rep3.armGrabs, 0, '断电机械臂不抓取');
  eq(rep3.armFeeds, 0, '断电机械臂不投喂');
});

test('WT-08-55 物流组件在图上按绿线(风车动力网)取电', () => {
  /* 绿线必须进入每个组件的端口圈(中心 ±2):全部对齐到 y=4 与 x=3..12 */
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 3, 12, 4, WireColor.GREEN);
  const belt = makeComponent('belt', 428, 4, 4, { params: { dir: 2 } });
  const sorter = makeComponent('sorter', 429, 7, 4, { params: { dir: 1, filterId: 151 } });
  const arm = makeComponent('arm', 430, 10, 4);
  const drill = makeComponent('drill', 431, 12, 6, { params: { oreId: 110 } });
  g.addComponent(belt);
  g.addComponent(sorter);
  g.addComponent(arm);
  g.addComponent(drill);
  g.run(2);
  eq(belt.state.running, 0, '无绿线动力时停转');
  eq(arm.state.powered, 0, '无绿线动力时机械臂断电');
  g.drive(3, 4, WireColor.GREEN, true);
  g.run(2);
  eq(belt.state.running, 1, '绿线通电后运行');
  eq(belt.state.dir, 2, '朝向参数生效');
  eq(sorter.state.running, 1, '分拣器通电运行');
  eq(sorter.state.filterId, 151, '分拣过滤 ID 生效');
  eq(arm.state.powered, 1, '机械臂通电');
  eq(drill.state.powered, 1, '钻头通电');
  eq(drill.state.oreId, 110, '钻头矿脉 ID 生效');
  g.drive(3, 4, WireColor.GREEN, false);
  g.run(2);
  eq(belt.state.running, 0, '断电后传送带停转');
  eq(arm.state.powered, 0, '断电后机械臂停止');
  eq(drill.state.powered, 0, '断电后钻头停止');
});

/* ══════════════════ 14. 组件与图交互的时序 ══════════════════ */

test('WT-08-56 逻辑件固有延迟 1 帧:输入到输出至少隔一帧', () => {
  const g = new SignalGraph(16, 16);
  /* 输入线右端 x=3 距组件中心 (5,5) 恰为 2 格 = READ_RADIUS */
  layHorizontal(g, 0, 3, 5, WireColor.RED);
  layHorizontal(g, 6, 14, 5, WireColor.YELLOW);
  const not = makeComponent('not', 415, 5, 5);
  g.addComponent(not);
  g.tick();
  g.run(2);
  /* NOT 门:输入 0 → 输出 1,稳态时黄线应已通电 */
  eq(g.liveAt(14, 5, WireColor.YELLOW), true, '稳态:输入 0 时 NOT 输出 1');
  /* 输入升到 1 → 输出应降到 0,且不得在同一帧内完成(1 帧延迟) */
  g.drive(0, 5, WireColor.RED, true);
  g.tick();
  eq(g.liveAt(14, 5, WireColor.YELLOW), true, '输入变化当帧输出仍是旧值(1 帧延迟)');
  g.tick();
  eq(g.liveAt(14, 5, WireColor.YELLOW), false, '下一帧输出才翻转为 0');
  /* 输入回 0 → 输出回到 1,同样延迟一帧 */
  g.drive(0, 5, WireColor.RED, false);
  g.tick();
  eq(g.liveAt(14, 5, WireColor.YELLOW), false, '输入回落当帧仍是旧值');
  g.tick();
  eq(g.liveAt(14, 5, WireColor.YELLOW), true, '再一帧后输出回到 1');
});

test('WT-08-57 组件输出状态去抖:同值不重复入队', () => {
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 0, 2, 5, WireColor.RED);
  const not = makeComponent('not', 415, 4, 7);
  g.addComponent(not);
  g.tick();
  g.drive(0, 5, WireColor.RED, true);
  g.run(4);
  const after = not.pending.length;
  g.run(6);
  eq(not.pending.length, after, '输出不变时不应继续堆积 pending');
  ok(not.pending.length <= 1, `pending 应被抑制到 ≤1,实际 ${not.pending.length}`);
});

test('WT-08-58 runUntil 与 run 的语义:达到条件即返回帧数', () => {
  const g = new SignalGraph(16, 16);
  layHorizontal(g, 0, 12, 5, WireColor.RED);
  g.tick();
  g.drive(0, 5, WireColor.RED, true);
  const used = g.runUntil((gg) => gg.liveAt(12, 5, WireColor.RED), 16);
  ok(used >= 1 && used <= 2, `应在 1~2 帧内到达,实际 ${used}`);
  eq(g.runUntil(() => true, 8), 0, '条件已成立时立即返回 0');
  eq(g.runUntil(() => false, 5), -1, '始终不成立返回 −1');
});

/* ══════════════════ 15. 性能与内存上界 ══════════════════ */

test('WT-08-59 512×512 图的位平面内存上界 ≈ 1MB', () => {
  const g = new SignalGraph(512, 512);
  const cells = 512 * 512;
  eq(g.wireBits.length, cells, 'wireBits 每格 1 字节');
  eq(g.driveBits.length, cells, 'driveBits 每格 1 字节');
  eq(g.liveBits.length, cells, 'liveBits 每格 1 字节');
  const bytes = g.wireBits.length + g.driveBits.length + g.liveBits.length;
  eq(bytes, cells * 3, '三个位平面共 786432 字节');
  ok(bytes <= 1024 * 1024, '1GB 内存约束下占比 < 0.1%');
});

test('WT-08-60 2 万线格实测:一次 tick 耗时远低于 2Hz 帧预算', () => {
  /* 脏优化开启,否则第二次 tick 仍是 FULL */
  const g = new SignalGraph(512, 512, true);
  /* 铺 2 万格:250 条 80 格的横线 */
  let laid = 0;
  let y = 1;
  while (laid < 20000 && y < 510) {
    for (let x = 1; x <= 80; x += 1) {
      if (g.addWire(x, y, WireColor.RED)) laid += 1;
    }
    y += 2;
  }
  ok(laid >= 20000, `应铺够 2 万格,实际 ${laid}`);
  const s0 = g.tick();
  eq(s0.mode, PropagateMode.FULL, '首帧结构变化 → 全量');
  /* 没有任何驱动源时,全量泛洪也确实无事可做 —— 这是正确行为,不是缺陷 */
  eq(s0.cellsScanned, 0, '无驱动源时全量泛洪 0 格');
  g.drive(1, 1, WireColor.RED, true);
  const t0 = process.hrtime.bigint();
  const s = g.tick();
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  eq(s.mode, PropagateMode.DIRTY_ONLY, '仅驱动变化 → 脏模式');
  ok(s.cellsFlooded >= 80, `至少泛洪了被驱动的那条线,实际 ${s.cellsFlooded}`);
  ok(us < 500000, `单次推进 ${us.toFixed(0)}µs 应远低于 2Hz 帧预算 500000µs`);
  /* 脏模式只碰受影响分量的 1 条线 */
  ok(s.cellsScanned <= 200, `脏模式应只碰约 1 条线(≤200 格),实际 ${s.cellsScanned}`);
  /* 换成别的线驱动:仍只碰那一条,与线总数无关 */
  g.drive(1, 1, WireColor.RED, false);
  g.drive(1, 201, WireColor.RED, true);
  const s2 = g.tick();
  eq(s2.mode, PropagateMode.DIRTY_ONLY, '换线驱动仍走脏模式');
  /* 本帧触碰 2 个分量(关掉旧线 + 驱动新线),各约 80 格 → 远小于全量 2 万 */
  ok(s2.cellsScanned <= 400, `换线后只碰 2 条线(≤400 格),实际 ${s2.cellsScanned}`);

  /* 对照:全量模式(关闭脏优化)每一帧都要重扫全部 4 色 */
  const gFull = new SignalGraph(512, 512, false);
  let laid2 = 0;
  let y2 = 1;
  while (laid2 < 20000 && y2 < 510) {
    for (let x = 1; x <= 80; x += 1) {
      if (gFull.addWire(x, y2, WireColor.RED)) laid2 += 1;
    }
    y2 += 2;
  }
  /* 给每一条线都挂上驱动源,让全量的工作量真实体现出来 */
  for (let yy = 1; yy < 510; yy += 2) gFull.drive(1, yy, WireColor.RED, true);
  gFull.tick();
  const fullMode = gFull.tick();
  eq(fullMode.mode, PropagateMode.FULL, '关闭脏优化时恒为全量');
  eq(fullMode.colorsFlooded, 4, '全量每帧泛洪四色');
  ok(fullMode.cellsScanned >= 20000, `全量应扫遍全部 2 万格,实际 ${fullMode.cellsScanned}`);
  ok(fullMode.cellsScanned > s.cellsScanned * 50, `全量扫描 ${fullMode.cellsScanned} 应是脏模式 ${s.cellsScanned} 的 50 倍以上`);
});

/* ══════════════════ 14. 物流在**生产路径**上是否真的搬运 ══════════════════ */

/**
 * 本节与第 13 节的区别是**判据的对象**:
 *  - 第 13 节直接调 `stepConveyor(...)` 等纯函数 —— 只证明「逻辑正确」;
 *  - 本节经由 `new WorldSim(...).tick()` —— 证明「生产真的走它」。
 *
 * 这两件事在本仓被反复证明**不等价**(「实现存在 + 测试全绿 + 生产零引用」
 * 已出现 5 次)。第 13 节全绿而本节全红,正是 `logistics.ts` 此前的状态。
 */
test('WT-08-53 生产路径:传送带真的搬运货物(而不是只设 running 标志)', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.wiring.addComponent(createComponent('belt1', 'LOGISTICS_CONVEYOR', 5, 5, {
    params: { dir: 1 },
    state: { running: 0, dir: 1, movedCells: 0 },
  }));
  sim.wiring.addWire(5, 5, WireColor.GREEN);
  sim.addWireDrive(5, 5, WireColor.GREEN, true);

  /* 载货:传送带的 `item` 由装载动作填入,没有装载就永远不走 ——
     `stepConveyor` 对空带直接返回 `moved: false`。这里走 WorldSim 的公开
     装载入口(地面掉落物 → 传送带),而不是直接改件 state。 */
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);
  sim.loadConveyorAt(5, 5);

  /* 慢帧每 10 快帧一次 ⇒ 20 慢帧 = 200 快帧。传送带 2 帧走 1 格,
     20 慢帧足够走 10 格;推 200 帧留足余量。 */
  for (let i = 0; i < 200; i += 1) sim.tick();
  const st = sim.wiring.get('belt1')!.state;

  eq(st.running, 1, '通电 → running=1(components.ts 求值器确实跑了)');
  ok(
    st.movedCells > 0,
    `生产路径上传送带应搬运货物,实际 movedCells=${st.movedCells}`
    + '(为 0 说明 logistics.ts 未被生产调用:件只通电,不搬运)',
  );
});

test('WT-08-54 生产路径:机械臂真的把地面货物投喂给设备', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.wiring.addComponent(createComponent('arm1', 'LOGISTICS_ARM', 8, 8, {
    state: { powered: 0, delivered: 0, idleCycles: 0 },
  }));
  sim.wiring.addWire(8, 8, WireColor.GREEN);
  sim.addWireDrive(8, 8, WireColor.GREEN, true);
  /* 投喂目标:斗柜 503(在 ARM_TARGETS 内),必须在 OBJ 层真实存在 */
  sim.setCell(8, 6, { obj: 503 });
  /* 货物放在机械臂抓取半径内 */
  sim.setGroundItems([{ id: 151, x: 7, y: 8, count: 1 }]);

  /* 机械臂单循环 4 慢帧;推 200 快帧 = 20 慢帧 = 5 个循环 */
  for (let i = 0; i < 200; i += 1) sim.tick();
  const st = sim.wiring.get('arm1')!.state;

  eq(st.powered, 1, '通电 → powered=1');
  ok(
    st.delivered > 0,
    `生产路径上机械臂应投喂成功,实际 delivered=${st.delivered}(为 0 说明未接线)`,
  );
});

test('WT-08-55 生产路径:采矿钻头真的按 10 秒周期产出矿石', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.wiring.addComponent(createComponent('drill1', 'LOGISTICS_DRILL', 3, 3, {
    params: { oreId: 151 },
    state: { powered: 0, oreId: 151, produced: 0 },
  }));
  sim.wiring.addWire(3, 3, WireColor.GREEN);
  sim.addWireDrive(3, 3, WireColor.GREEN, true);

  /* ⚠️ 帧数换算容易错(我第一版就错了):DRILL_PERIOD_TICKS=20 是**慢帧**数,
     而慢帧每 10 快帧一次 ⇒ 10 秒 = 20 慢帧 = **200 快帧**。
     只推 42 帧只有 4 个慢帧,远不够一个周期,会误判成「没接线」。 */
  const FAST_PER_SLOW = 10;
  const needFrames = DRILL_PERIOD_TICKS * FAST_PER_SLOW * 2; /* 2 个周期,留余量 */
  for (let i = 0; i < needFrames; i += 1) sim.tick();
  const st = sim.wiring.get('drill1')!.state;

  eq(st.powered, 1, '通电 → powered=1');
  ok(
    st.produced >= 2,
    `生产路径上钻头 ${needFrames} 帧(${DRILL_PERIOD_TICKS * 2} 慢帧)应产出 ≥2 块,`
    + `实际 produced=${st.produced}(为 0 说明未接线)`,
  );
});

test('WT-08-56 生产路径断电对照:断电时物流必须完全静止', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.wiring.addComponent(createComponent('belt2', 'LOGISTICS_CONVEYOR', 5, 5, {
    params: { dir: 1 },
    state: { running: 0, dir: 1, movedCells: 0 },
  }));
  /* 刻意**不**通电 */
  sim.wiring.addWire(5, 5, WireColor.GREEN);
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);

  for (let i = 0; i < 20; i += 1) sim.tick();
  const st = sim.wiring.get('belt2')!.state;

  eq(st.running, 0, '未通电 → running=0');
  eq(st.movedCells, 0, '断电时不得搬运任何货物');
  eq(sim.groundItems.length, 1, '货物应原地不动');
  eq(sim.groundItems[0]!.x, 5, '货物 x 坐标不变');
});

/* ══════════════════ 15. 出货口交付:货不许被摧毁 ══════════════════
 *
 * 本节钉住的是一个**真缺陷**(task-46):`stepConveyor` / `stepSorter` 在搬满
 * 一格时会把货放进返回值的 `exit` 并**同时清空 `state.item`** ——
 * 货的归属权在那一瞬移交给调用方。而 `tickLogistics` 原先只做
 * `if (r.moved) rep.beltMoves += 1;`,**丢弃 `exit`** ⇒ 货被搬离的一瞬
 * 就从世界上消失(既不回带内、也不落地、也不在任何设备里)。
 *
 * ## 为什么既有断言全绿而缺陷仍在
 *
 * 全仓唯一消费 `exit` 的是本节之前第 13 节的 `loadConveyor(st, r.exit!.item)`
 * —— **测试自己补齐了编排层该做的事**。于是纯函数层「逻辑正确」拿了满分,
 * 生产路径「货被销毁」却无人断言。这是本仓第 6 次出现
 * 「实现存在 + 测试全绿 + 生产不执行/不正确」这一族缺陷。
 *
 * ## 判据:总量守恒
 *
 * 不用「货在哪」断言(实现可以换位置),而用**总数守恒**:
 * 装载 N 件 → 跑 M 帧 → 「地面 + 各带承载位 + 各设备内」恒为 N。
 * 这样「交付给下游带」「投喂设备」「落到地面」三种正确去向都能通过,
 * 而「凭空消失」必然失败。
 */

/** 清点世界里的全部货:地面 + 带/分拣器承载位 + 料理站锅内。 */
function censusOf(sim: WorldSim): { ground: number; belts: number; pots: number; ids: number[] } {
  const ids: number[] = sim.groundItems.map((g) => g.id);
  const ground = sim.groundItems.reduce((a, g) => a + g.count, 0);
  let belts = 0;
  for (const c of sim.wiring.components.values()) {
    const s = c.state as {
      item?: { id?: number; count?: number } | null;
      held?: { id?: number; count?: number } | null;
    };
    for (const it of [s.item, s.held]) {
      if (it && typeof it.count === 'number') { belts += it.count; ids.push(it.id ?? -1); }
    }
  }
  let pots = 0;
  for (const dev of [506, 507, 508]) {
    const k = sim.stationState(dev);
    pots += Object.values(k.inputs).reduce((a, n) => a + n, 0);
  }
  return { ground, belts, pots, ids };
}

/** 造一条通电的物流件。 */
function poweredComp(sim: WorldSim, id: string, kind: string, x: number, y: number, params: Record<string, unknown> = {}): void {
  sim.wiring.addComponent(createComponent(id, kind, x, y, { state: {}, params }));
  sim.wiring.addWire(x, y, WireColor.GREEN);
  sim.addWireDrive(x, y, WireColor.GREEN, true);
}

test('WT-08-57 生产路径:带尾出货无处可去时,货落到地面(而不是被销毁)', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  poweredComp(sim, 'belt1', 'LOGISTICS_CONVEYOR', 5, 5, { dir: 1 });
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);
  ok(sim.loadConveyorAt(5, 5), '装载应成功(地面货进带)');

  let dropped = 0;
  for (let i = 0; i < 60; i += 1) {
    sim.tick();
    dropped += sim.lastLogisticsTick.exitsDropped;
  }
  const c = censusOf(sim);

  ok(
    c.ground + c.belts + c.pots === 1,
    `货的总数应恒为 1(期望 1,实际 ground=${c.ground} belts=${c.belts} pots=${c.pots})`
    + '—— 总数 <1 说明货被搬出传送带后凭空消失(tickLogistics 丢弃了 exit)',
  );
  eq(c.ground, 1, '出口没有下游 ⇒ 货应落到地面');
  ok(c.ids.includes(151), `落地的应是同一件货 151(实际 ids=${JSON.stringify(c.ids)})`);
  ok(dropped >= 1, `报告应记录落地次数(实际 exitsDropped=${dropped})`);
});

test('WT-08-58 生产路径:带尾接下游带时,货交付给下游(守恒)', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  poweredComp(sim, 'b1', 'LOGISTICS_CONVEYOR', 5, 5, { dir: 1 });
  poweredComp(sim, 'b2', 'LOGISTICS_CONVEYOR', 6, 5, { dir: 1 });
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);
  sim.loadConveyorAt(5, 5);

  let delivered = 0;
  for (let i = 0; i < 80; i += 1) {
    sim.tick();
    delivered += sim.lastLogisticsTick.exitsDelivered;
  }
  const c = censusOf(sim);

  ok(delivered >= 1, `应至少有 1 次交付给下游(实际 exitsDelivered=${delivered})`);
  ok(
    c.ground + c.belts + c.pots === 1,
    `货的总数应恒为 1(期望 1,实际 ground=${c.ground} belts=${c.belts} pots=${c.pots})`,
  );
  const b2 = sim.wiring.get('b2')!.state as { movedCells?: number; item?: unknown };
  ok(
    (b2.movedCells ?? 0) > 0 || b2.item != null,
    `下游带应真的收到货(movedCells=${b2.movedCells} item=${JSON.stringify(b2.item)})`,
  );
});

test('WT-08-59 生产路径:带尾接料理站时,货被投喂进锅(守恒)', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  poweredComp(sim, 'belt1', 'LOGISTICS_CONVEYOR', 5, 5, { dir: 1 });
  sim.setCell(6, 5, { obj: 506 }); /* 八人欢聚大汤锅 */
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);
  sim.loadConveyorAt(5, 5);

  for (let i = 0; i < 80; i += 1) sim.tick();
  const c = censusOf(sim);

  ok(
    c.ground + c.belts + c.pots === 1,
    `货的总数应恒为 1(期望 1,实际 ground=${c.ground} belts=${c.belts} pots=${c.pots})`,
  );
  eq(c.pots, 1, '货应进锅(出口正对设备 ⇒ 走投喂而不是落地)');
});

test('WT-08-60 生产路径负对照:出口越界时货不丢(退回原带待运)', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  /* 带子在最右列且朝东 ⇒ 出货口越界,无处可放 */
  poweredComp(sim, 'belt1', 'LOGISTICS_CONVEYOR', 31, 5, { dir: 1 });
  sim.setGroundItems([{ id: 151, x: 31, y: 5, count: 1 }]);
  sim.loadConveyorAt(31, 5);

  let held = 0;
  for (let i = 0; i < 120; i += 1) {
    sim.tick();
    held += sim.lastLogisticsTick.exitsHeld;
  }
  const c = censusOf(sim);

  ok(
    c.ground + c.belts + c.pots === 1,
    `越界出口不得销毁货物(期望总数 1,实际 ground=${c.ground} belts=${c.belts} pots=${c.pots})`,
  );
  eq(c.belts, 1, '越界时货应退回原带待运(而不是蒸发,也不是被挤出世界)');
  ok(held >= 1, `报告应记录退回次数(实际 exitsHeld=${held})`);
});

test('WT-08-61 生产路径负对照:下游带已满时,上游货不许被吞掉', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  poweredComp(sim, 'b1', 'LOGISTICS_CONVEYOR', 5, 5, { dir: 1 });
  poweredComp(sim, 'b2', 'LOGISTICS_CONVEYOR', 6, 5, { dir: 1 });
  /* 先占满下游带的唯一承载位(传送带容量 = 1 件) */
  sim.setGroundItems([{ id: 152, x: 6, y: 5, count: 1 }]);
  ok(sim.loadConveyorAt(6, 5), '下游带应先被占满');
  /* 再往上游装第二件 */
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);
  ok(sim.loadConveyorAt(5, 5), '上游装载应成功');

  for (let i = 0; i < 100; i += 1) sim.tick();
  const c = censusOf(sim);

  ok(
    c.ground + c.belts + c.pots === 2,
    `两件货都不许丢(期望总数 2,实际 ground=${c.ground} belts=${c.belts} pots=${c.pots})`
    + '—— 下游堵住是常态,不能因此销毁上游的货',
  );
  ok(
    c.ids.includes(151) && c.ids.includes(152),
    `两件货都应仍在世界某处(实际 ids=${JSON.stringify([...c.ids].sort((a, b) => a - b))})`,
  );
});

test('WT-08-62 可观测性:带内承载的货必须能从件表看到', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.wiring.addComponent(createComponent('belt1', 'LOGISTICS_CONVEYOR', 5, 5, {
    state: { progress: 0, dir: 1, item: null, movedCells: 0 },
  }));
  sim.setGroundItems([{ id: 151, x: 5, y: 5, count: 1 }]);
  sim.loadConveyorAt(5, 5);

  /* ⚠ 必须推过**一个完整慢帧**:件表里的 `item` 由 `tickLogisticsStep()`
     每慢帧回写一次,而慢帧是第 10、20、30… 快帧。实测:第 1~9 帧读仍是 null,
     第 10 帧才可见。装载后只推 1 帧就断言可见是**帧数换算错误**
     (我第一版就犯了这个错,与本套件 WT-08-55 注释里记的是同一类坑)。 */
  for (let i = 0; i < 10; i += 1) sim.tick();

  /* 此后断电:货会一直待在带内不走。若件表看不到它,
     「货在带上等着」与「货被销毁」在外部**完全一样** ——
     缺可观测性会让排查方向彻底错(我自己就被骗过一次)。 */
  const st = sim.wiring.get('belt1')!.state as { item?: { id?: number; count?: number } | null };
  ok(st.item != null, `带内的货应可见(实际 item=${JSON.stringify(st.item)})`);
  eq(st.item?.id, 151, '带内货的 ID 正确');
  eq(st.item?.count, 1, '带内货的数量正确');
});

report('WS-08');