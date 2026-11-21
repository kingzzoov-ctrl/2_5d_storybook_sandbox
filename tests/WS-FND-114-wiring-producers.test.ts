/**
 * WS-FND-114 —— 电路层的**生产者口径**(第五轮实测的 P1/P2 五处)。
 *
 * 运行:`node tests/WS-FND-114-wiring-producers.test.ts`
 *
 * ## 这个套件钉的五件事
 *
 * | # | 缺陷 | 本套件怎么钉 |
 * | :-- | :--- | :--- |
 * | 1 | 40 项件**生产侧无生产者**(`if (wiringOn)` 求值块空转) | 台账 40 行全 `NONE` + **静态扫描**三类调用点(FND114-12) |
 * | 2 | 环境注入只答 `hour` / `night` ⇒ 输入判据恒假、`moored===0` 恒真 | 逐格键真的按世界事实回答(FND114-2..9),台账覆盖由**记录型环境口**跑遍 40 件(FND114-1) |
 * | 3 | `graph.race` 第二场**永不停表** | 两场都停、第二场是新值(FND114-10) |
 * | 4 | `STATE_DEFAULTS` 的投影字段从不 `setSt`(读数恒 0) | 件状态与线输出**两极性双向对账**(FND114-11) |
 * | 5 | `wiringOn=false` 时 `loadConveyorAt` 说成功而货永不回写 | 无电路 ⇒ 拒绝装载且货留地面(FND114-13) |
 *
 * ## 判据纪律(为什么这个套件有牙)
 *
 * 1 **注入验证**:FND114-2 / 9 / 1 都有一条**摘掉环境口 ⇒ 退回旧形态**的对照 ——
 *    「接线断了」与「世界真的没有那个东西」在读数上都是 0,只有把口子摘掉才能
 *    证明本套件读的是**那口接线**,而不是某个恰好为 0 的常量。
 * 2 **负对照**:每个逐格键都配一格「同一世界、同一帧、但不是这一格」的对照
 *    (空格上的压力板 / 范围外的生物 / 上方没人但同格有人 / 空领奖台)。
 *    ⇒ 判据抓的是「按格」,不是「世界里有没有任何东西」。
 * 3 **不拿实现常量核实现行为**:数字取手册/内容表字面量(7 格半径、5×5=25、
 *    `elapsedTicks × 500ms`),或由**世界侧独立读数**给出(`sim.hourOfDay()`)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { WireColor } from '../shared/types/tile.ts';
import { SignalGraph, layHorizontal } from '../server/src/wiring/graph.ts';
import {
  COMPONENT_PRODUCER_LEDGER,
  COMPONENT_SPECS,
  ENV_KEY_LEDGER,
  WORLD_ENV_KEYS,
  auditComponentProducers,
  makeComponent,
} from '../server/src/wiring/components.ts';
import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import type { GroundItem } from '../server/src/mobs/behaviors.ts';

const ROOT = join(import.meta.dirname, '..');

/** 一张干净的 16×16 图(没有世界环境口 ⇒ `param()` 缺失一律 0)。 */
function bareGraph(): SignalGraph {
  return new SignalGraph(16, 16);
}

/** 给图**注入**一个可控的环境口(判据用:精确决定「世界说有什么」)。 */
function injectEnv(g: SignalGraph, values: Record<string, number>): void {
  g.setEnvSource((key: string): number => values[key] ?? 0);
}

/* ═══════════ 1. 台账:40 件真会问的键,一个都不能漏 ============ */

test('FND114-1 ★ 环境台账覆盖:40 件求值时问到的**每个键**都在 ENV_KEY_LEDGER 里(不靠人肉对账)', () => {
  const g = bareGraph();
  const asked = new Set<string>();
  /* 记录型环境口:只记账、一律答 0 —— 这样 40 件的行为不会互相干扰。 */
  g.setEnvSource((key: string): number => {
    asked.add(key);
    return 0;
  });
  for (const spec of COMPONENT_SPECS) g.addComponent(makeComponent(`c${spec.id}`, spec.id, 2, 2));
  /* 425 / 437 的 `enemyInRange` / `hitMob` 在**断电时不会问**环境(短路求值)⇒
     给它们各自的「电源」静态参数(`loaded` / `fueled`,台账里登记为 NONE 的摆放设置),
     否则本判据会把「没人问」误读成「台账多了一行」。 */
  const turret = g.get('c425');
  const train = g.get('c437');
  if (turret !== undefined) turret.params.loaded = 1;
  if (train !== undefined) train.params.fueled = 1;
  g.run(3);
  eq(g.stats.componentsEvaluated, 40, '前置:40 件都真的被求值(否则收集到的键不完整)');

  /* 正向:问到的键必须登记(将来加键忘了登记 ⇒ 当场红)。 */
  const missing = [...asked].filter((k) => ENV_KEY_LEDGER[k] === undefined).sort();
  eq(missing, [], 'evaluator 问到的键必须都在台账里(新增环境键必须同时登记生产者)');

  /* 反向:登记成 `WORLD` 的键必须**真的有人问** —— 否则世界侧实现的是死代码。 */
  const dead = WORLD_ENV_KEYS.filter((k) => !asked.has(k)).sort();
  eq(dead, [], '标了 WORLD 的键必须真的被某个件问到(不许留没消费者的"接线")');

  /* 11 个世界键:钟 2 + 逐格 8 + morningTick 1(与 `WorldSim.installWorldEnv` 一一对应)。 */
  eq(WORLD_ENV_KEYS.length, 11, 'WORLD 键 = 11(hour/night/entityCount/entityWeight/fluid/crossed/onPodium/payloadAbove/enemyInRange/hitMob/morningTick)');

  /* 「没有生产源」的那批必须**如实登记**,不是被悄悄算成已实现。 */
  const none = Object.keys(ENV_KEY_LEDGER).filter((k) => ENV_KEY_LEDGER[k]?.producer === 'NONE');
  ok(none.length > 0, 'NONE 的欠账必须留在台账里(不许把"没接线"写成"已实现")');
  ok(none.includes('whistle') && none.includes('riderCount'), '交互/载具类输入必须登记为 NONE(它们的出路是动作层)');
});

/* ═══════════ 2. 逐格键:世界真的按「件所在格」回答 ============ */

test('FND114-2 ★ 401 按格读 `entityCount`:有人 1 / 空格 0;摘掉环境口 ⇒ 退回恒假(旧形态)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = sim.wiring;
  const on = makeComponent('plateOn', 401, 6, 6);
  const off = makeComponent('plateOff', 401, 12, 12);
  g.addComponent(on);
  g.addComponent(off);
  /* 红线只在 `on` 的 5×5 读取半径内(距离 2 格)。 */
  layHorizontal(g, 8, 9, 6, WireColor.RED);
  sim.addPlayer('p1', 6, 6);

  g.run(2);
  eq(on.state.pressed, 1, '★ 玩家站在件所在格 ⇒ entityCount=1 ⇒ 压上');
  eq(g.liveAt(9, 6, WireColor.RED), true, '线输出与件状态一致(都是 1)');
  eq(off.state.pressed, 0, '负对照:同一世界、同一帧,空格上的另一块板仍是 0(不是「有人就算」)');

  /* 注入验证:摘掉世界环境口 ⇒ 同一个玩家、同一格,读数退回 0(修前的恒假形态)。 */
  g.setEnvSource(null);
  g.run(2);
  eq(on.state.pressed, 0, '★ 摘掉环境口 ⇒ `entityCount` 缺失=0 ⇒ 恒假 —— 本套件能区分「接了」与「没接」');
});

test('FND114-3 ★ 402 重物板读的是**质量**:1 人 0 / 2 人 1(负对照钉住口径)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const heavy = makeComponent('heavy', 402, 8, 8);
  sim.wiring.addComponent(heavy);
  sim.addPlayer('p1', 8, 8);
  sim.wiring.run(2);
  eq(heavy.state.weight, 1, '1 名玩家 = 质量 1(`MASS_PLAYER`)');
  eq(heavy.state.pressed, 0, '★ 需要 2 ⇒ 1 人压不动(读的是重量,不是「人数 > 0」)');

  sim.addPlayer('p2', 8, 8);
  sim.wiring.run(2);
  eq(heavy.state.weight, 2, '2 名玩家 = 质量 2');
  eq(heavy.state.pressed, 1, '★ 双人 ⇒ 压上');
});

test('FND114-4 ★ 406/407 按格读 `fluid` / `crossed`:有水的格 1、干的格 0;有实体的格 1', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = sim.wiring;
  /* 两格显式写成「有水」/「没水」——不靠世界生成的地形(那会让判据依赖种子)。 */
  sim.setCell(5, 5, { obj: 0 });
  sim.fluid.setCell(5, 5, { amount: 500 });
  sim.setCell(10, 5, { obj: 0 });
  sim.fluid.setCell(10, 5, { amount: 0 });
  const wet = makeComponent('wet', 406, 5, 5);
  const dry = makeComponent('dry', 406, 10, 5);
  const trip = makeComponent('trip', 407, 12, 14);
  g.addComponent(wet);
  g.addComponent(dry);
  g.addComponent(trip);
  sim.addPlayer('p1', 12, 14);

  g.run(2);
  eq(wet.state.wet, 1, '★ 有水的格 ⇒ wet=1(读 `FluidField.amountAt`)');
  eq(dry.state.wet, 0, '负对照:干的格 ⇒ wet=0(同一世界、同一帧)');
  eq(trip.state.lit, 1, '★ 绊线柱:本帧有实体在该格 ⇒ lit=1');
});

test('FND114-5 ★ 412 领奖台按格读 `onPodium`:玩家踏上才停表;空领奖台不停(负对照)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = sim.wiring;
  const podium = makeComponent('podium', 412, 14, 14);
  const empty = makeComponent('podiumEmpty', 412, 20, 20);
  g.addComponent(podium);
  g.addComponent(empty);
  sim.addPlayer('p1', 14, 14);

  g.race.running = 1;
  g.race.startTick = 0;
  g.race.elapsedTicks = 4;
  g.run(1);
  eq(podium.state.finished, 1, '★ 玩家在领奖台上 ⇒ 停表');
  eq(g.race.running, 0, '共享比赛时钟已停');
  eq(podium.state.finishMs, 2000, '没给 `nowMs` ⇒ 按 `elapsedTicks × 500ms` 折算(4 × 500)');

  /* 负对照:把玩家挪走(另一块领奖台从来没人)⇒ 表继续跑。 */
  sim.setPlayerPos('p1', 14, 2);
  g.race.running = 1;
  g.race.startTick = 0;
  g.race.elapsedTicks = 2;
  g.race.finishMs = 0;
  g.run(1);
  eq(empty.state.finished, 0, '负对照:空领奖台不触发 finished');
  eq(g.race.running, 1, '★ 空领奖台不停表 ⇒ `onPodium` 是**按格**读数,不是恒真');
});

test('FND114-6 ★ 422 按格读 `payloadAbove`:上方有载荷才弹;只有同格有人不弹(负对照)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = sim.wiring;
  const spring = makeComponent('spring', 422, 6, 18);
  const idle = makeComponent('springIdle', 422, 14, 18);
  g.addComponent(spring);
  g.addComponent(idle);
  /* 两块垫子分别通电(红线在各自 2 格内)。 */
  layHorizontal(g, 8, 8, 18, WireColor.RED);
  layHorizontal(g, 16, 16, 18, WireColor.RED);
  g.drive(8, 18, WireColor.RED, true);
  g.drive(16, 18, WireColor.RED, true);
  /* spring 的**上方**(6,17)站人;idle 只有**同格**(14,18)站人。 */
  sim.addPlayer('p1', 6, 17);
  sim.addPlayer('p2', 14, 18);

  g.run(2);
  eq(spring.state.launches, 1, '★ 上方有载荷 ⇒ 弹射 1 次');
  eq(idle.state.launches, 0, '负对照:载荷在**同格**而不是上方 ⇒ 不弹(证明读的是上方那一格)');
});

test('FND114-7 ★ 425/437 读 `enemyInRange` / `hitMob`:生物在范围内/同格触发;拉远 ⇒ 不触发', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  const g = sim.wiring;
  const near = makeComponent('turretNear', 425, 8, 8);
  const far = makeComponent('turretFar', 425, 24, 24);
  const train = makeComponent('train', 437, 8, 14);
  const trainIdle = makeComponent('trainIdle', 437, 24, 14);
  for (const c of [near, far, train, trainIdle]) g.addComponent(c);
  /* 装填/加煤是**摆放设置**(台账里登记为 NONE),这里用静态参数给;世界事实只有「生物在哪」。 */
  near.params.loaded = 1;
  far.params.loaded = 1;
  train.params.fueled = 1;
  trainIdle.params.fueled = 1;
  /* 一只**活着的**生物:在 near 的 7 格内,且正踩在 train 那一格。 */
  sim.addMob('mob_boar#1', 'MEADOW', 8, 14);

  g.run(2);
  eq(near.state.shots, 1, '★ 生物在 7 格内 ⇒ 开火 1 次');
  eq(far.state.shots, 0, '负对照:同一个生物离 (24,24) 有 16 格 ⇒ 不开火');
  eq(train.state.crushes, 1, '★ 生物与火车同格 ⇒ 碾压 1 次');
  eq(trainIdle.state.crushes, 0, '负对照:另一列火车那一格没有生物 ⇒ 不碾');
});

test('FND114-8 ★ 426「每早自动洒水」:世界日头一拍触发;过了这一拍就不再触发(负对照)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = sim.wiring;
  const spr = makeComponent('spr', 426, 6, 6);
  g.addComponent(spr);
  eq(Math.floor(sim.hourOfDay()), 6, '前置:世界日从 06:00 起头(D-07)');

  g.run(1);
  eq(spr.state.active, 1, '★ 早上头一拍 ⇒ 自动旋转(**没有**接蓝线)');
  eq(spr.state.wetCells, 25, '浇湿 5×5 = 25 格');

  /* 推**一个慢帧 stride**(= `FAST_PER_SLOW` 快帧;旧写法 10 编码了 20Hz)。
     「早上一拍」= 日头的前 `FAST_PER_SLOW` 帧窗口 ⇒ 推满一个 stride 才走出窗口。 */
  for (let i = 0; i < FAST_PER_SLOW; i += 1) sim.tick();
  eq(Math.floor(sim.hourOfDay()), 6, '前提:钟点仍在这一小时内(06:0x)⇒ `hour` 取整仍是 6');
  g.run(1);
  eq(spr.state.active, 0, '负对照:过了「早上一拍」⇒ 不再洒(证明触发是 `morningTick`,不是 `hour === 6`)');
  eq(spr.state.wetCells, 0, '断电读数必须回 0(不留上一个值的残影)');
});

test('FND114-9 ★ 440 飞艇缺省**系泊**(不是恒飞);松缆或绿线才起飞(负对照)', () => {
  const g = bareGraph();
  const docked = makeComponent('ship', 440, 4, 4);
  const loose = makeComponent('shipLoose', 440, 10, 4);
  g.addComponent(docked);
  g.addComponent(loose);
  loose.params.unmoored = 1;
  g.run(2);
  eq(docked.state.flying, 0, '★ 缺省 = 系泊 ⇒ 不飞(修前 `moored === 0` 与「键缺失」不可区分 ⇒ 恒飞)');
  eq(loose.state.flying, 1, '显式松缆(`unmoored=1`)⇒ 起飞');

  /* 绿线通电仍能起飞(单向依赖保留),且**不会**把别的飞艇带飞。 */
  const wired = makeComponent('shipWired', 440, 4, 10);
  g.addComponent(wired);
  layHorizontal(g, 4, 6, 12, WireColor.GREEN);
  g.drive(6, 12, WireColor.GREEN, true);
  g.run(2);
  eq(wired.state.flying, 1, '绿线通电 ⇒ 起飞');
  eq(docked.state.flying, 0, '负对照:既没松缆也没接绿线的飞艇仍停在码头');
});

/* ═══════════ 3. 跑酷第二场必须停表 ============ */

test('FND114-10 ★ 411/412 第二场也停表:开新一场复位 `finishMs`(修前第二场永远停不了表)', () => {
  const g = bareGraph();
  const gate = makeComponent('gate', 411, 4, 4);
  const podium = makeComponent('podium', 412, 4, 10);
  g.addComponent(gate);
  g.addComponent(podium);
  gate.params.whistle = 1;

  /* 第一场:开表 → 踏上 → 停表(显式给了 nowMs)。 */
  g.run(1);
  eq(g.race.running, 1, '第一场:哨响开表');
  podium.params.onPodium = 1;
  podium.params.nowMs = 5000;
  g.run(1);
  eq(g.race.running, 0, '第一场:踏上领奖台停表');
  eq(podium.state.finishMs, 5000, '第一场成绩 = 5000ms');

  /* 离开领奖台 ⇒ 发令门(仍通电)开**第二场**:复位上一场成绩。 */
  delete podium.params.onPodium;
  g.run(1);
  eq(g.race.running, 1, '第二场:重新开表');
  eq(g.race.finishMs, 0, '★ 开新一场必须复位 `finishMs`(否则领奖台的 `finishMs === 0` 守卫永不成立)');

  /* 第二场跑一拍后踏上:按 `elapsedTicks × 500ms` 折算 ⇒ 新值,且表真的停了。 */
  podium.params.onPodium = 1;
  delete podium.params.nowMs;
  g.run(1);
  eq(g.race.running, 0, '★ 第二场也停表(修前:`finishMs !== 0` ⇒ 守卫挡住 ⇒ 表一直跑)');
  eq(g.race.finishMs, 500, '第二场成绩按本场 elapsedTicks(1)折算 = 500ms,不是上一场的 5000');
  eq(podium.state.finishMs, 500, '件状态与共享时钟同值(读数是**本场**结论)');
});

/* ═══════════ 4. 件状态 ⇄ 线输出双向对账 ============ */

test('FND114-11 ★ 「件状态」与「线输出」两极性一致:401/405/406/407/414/415 同时亮、同时灭', () => {
  const g = bareGraph();
  const env: Record<string, number> = {};
  injectEnv(g, env);

  const plate = makeComponent('plate', 401, 3, 3);
  const light = makeComponent('light', 405, 3, 8);
  const water = makeComponent('water', 406, 3, 13);
  const trip = makeComponent('trip', 407, 10, 3);
  const andGate = makeComponent('and', 414, 10, 8);
  const notGate = makeComponent('not', 415, 10, 13);
  for (const c of [plate, light, water, trip, andGate, notGate]) g.addComponent(c);

  /* 输出观测点:每个件各一格线(都在它的 5×5 读取/写入半径 2 内)。 */
  layHorizontal(g, 5, 5, 3, WireColor.RED);   /* 401 */
  layHorizontal(g, 5, 5, 8, WireColor.RED);   /* 405 */
  layHorizontal(g, 5, 5, 13, WireColor.RED);  /* 406 */
  layHorizontal(g, 12, 12, 3, WireColor.RED); /* 407 */
  layHorizontal(g, 12, 12, 8, WireColor.YELLOW);  /* 414 */
  layHorizontal(g, 12, 12, 13, WireColor.YELLOW); /* 415 */
  /* 414 的两路输入 / 415 的输入。 */
  layHorizontal(g, 9, 9, 6, WireColor.RED);
  layHorizontal(g, 11, 11, 6, WireColor.BLUE);
  layHorizontal(g, 9, 9, 12, WireColor.RED);

  /* ── 极性 A:全部「有」。 ── */
  env.entityCount = 1;
  env.hour = 22;      /* 夜 */
  env.fluid = 1;
  env.crossed = 1;
  g.drive(9, 6, WireColor.RED, true);    /* AND 红 = 1 */
  g.drive(11, 6, WireColor.BLUE, true);  /* AND 蓝 = 1 */
  g.drive(9, 12, WireColor.RED, false);  /* NOT 输入 = 0 */
  g.run(2);

  eq([plate.state.pressed, light.state.night, water.state.wet, trip.state.lit], [1, 1, 1, 1],
    '★ 四个传感器的 state 读数必须与「世界说有什么」一致(修前这四个键恒 0)');
  eq([g.liveAt(5, 3, WireColor.RED), g.liveAt(5, 8, WireColor.RED),
    g.liveAt(5, 13, WireColor.RED), g.liveAt(12, 3, WireColor.RED)], [true, true, true, true],
    '线输出与 state 同向(读数不再是"永远是 0"的装饰)');
  eq(andGate.state.out, 1, '414:两路输入都通 ⇒ out=1');
  eq(g.liveAt(12, 8, WireColor.YELLOW), true, '414:黄线同时为 1');
  eq(notGate.state.out, 1, '415:输入 0 ⇒ out=1');
  eq(g.liveAt(12, 13, WireColor.YELLOW), true, '415:黄线同时为 1');

  /* ── 极性 B:全部「没有」—— state 与线必须**同时**归零。 ── */
  delete env.entityCount;
  env.hour = 12;      /* 白天 */
  delete env.fluid;
  delete env.crossed;
  g.drive(9, 6, WireColor.RED, false);
  g.drive(11, 6, WireColor.BLUE, false);
  g.drive(9, 12, WireColor.RED, true);   /* NOT 输入 = 1 */
  g.run(2);

  eq([plate.state.pressed, light.state.night, water.state.wet, trip.state.lit], [0, 0, 0, 0],
    '负对照:世界说「没有」⇒ 四个读数全 0(与线输出一致)');
  eq([g.liveAt(5, 3, WireColor.RED), g.liveAt(5, 8, WireColor.RED),
    g.liveAt(5, 13, WireColor.RED), g.liveAt(12, 3, WireColor.RED)], [false, false, false, false],
    '线输出同步归零');
  eq(andGate.state.out, 0, '414:断了 ⇒ out=0');
  eq(g.liveAt(12, 8, WireColor.YELLOW), false, '414:黄线同时为 0');
  eq(notGate.state.out, 0, '415:输入 1 ⇒ out=0');
  eq(g.liveAt(12, 13, WireColor.YELLOW), false, '415:黄线同时为 0');
});

/* ═══════════ 5. 生产侧生产者:台账 + 静态扫描(两处口径一致) ============ */

/** 递归收集某目录下的 `.ts` 文件(绝对路径)。 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkTs(p, out);
      continue;
    }
    if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * `server/src` 里命中 `callRe` 的**文件**清单(仓库相对路径,已排序)。
 *
 * 注释行(`*` / `//` / `/*` 开头)与 `skip` 命中的行**不算调用点** ——
 * 本仓的 docblock 里大量引用这些名字,不排掉会把「解释」读成「调用」。
 */
function productionCallSites(callRe: RegExp, skip: RegExp | null = null): string[] {
  const files: string[] = [];
  for (const abs of walkTs(join(ROOT, 'server', 'src'))) {
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
    const hit = lines.some((line) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
      if (skip !== null && skip.test(line)) return false;
      return callRe.test(line);
    });
    if (hit) files.push(relative(ROOT, abs).split(sep).join('/'));
  }
  return files.sort();
}

test('FND114-12 ★ 40 件在生产侧**没有**生产者:台账 40 行全 NONE,且三类调用点实测如此', () => {
  eq(auditComponentProducers(), { total: 40, withWorldProducer: 0, placedOnly: 40 },
    '台账读数:40 行、0 个生产造件者、40 个「只登记」');
  eq(COMPONENT_PRODUCER_LEDGER.length, 40, '逐件登记(不是一句注释)');
  eq(COMPONENT_PRODUCER_LEDGER.every((r) => r.worldProducer === 'NONE'), true,
    '★ 一行都不许悄悄改成 PRODUCTION —— 接线的那一天必须同时改台账与本条');
  eq(COMPONENT_PRODUCER_LEDGER.map((r) => r.id), COMPONENT_SPECS.map((s) => s.id), '台账与规格表逐件对齐(401..440)');

  /* 实测:接线到底做了没有。三行都是**可失效**的判据(接线即红,逼着同步改口径)。 */
  eq(productionCallSites(/\.addComponent\(/), ['server/src/sim/demo.ts'],
    '`SignalGraph.addComponent` 的生产调用点只有演示脚本');
  eq(productionCallSites(/\.addWireDrive\(/), ['server/src/sim/demo.ts'],
    '`WorldSim.addWireDrive` 的生产调用点只有演示脚本');
  eq(productionCallSites(/makeComponent\(/, /function /), [],
    '★ `makeComponent` 的生产调用点 = 0(连演示脚本都没用它)');

  /* 口径一致的另一半:`PLACE_AUTOMATION` 只写它自己的登记表,世界侧不读它。 */
  eq(productionCallSites(/place_automation\.ts'/),
    ['server/src/net/actions/action_table.ts', 'server/src/net/actions/reset_world.ts',
      'server/src/net/room.colyseus.ts'],
    '★ 放置登记表的读者 3 处:动作分派 + 世界重置后清桶 + 房间销毁清桶'
    + '(`room.colyseus.ts#onDispose` 的 `forgetPlacements`,**仅清理、非求值** ——'
    + ' 它不建 `ComponentNode`、不进求值);`sim/**` / `wiring/**` 里没有读者');
  /* 登记表自己的模块里有这两个**定义**(所以扫描到它是正常的);要看的是**别的**模块有没有读。 */
  eq(productionCallSites(/placementAt\(|placementsOfRoom\(/)
    .filter((f) => f !== 'server/src/net/actions/place_automation.ts'), [],
  '★ 除登记表自身的定义外,全仓没有「读放置表去造件」的代码 ⇒「已放置」与「可求值」今天不是一回事(台账如实登记)');
});

/* ═══════════ 6. 物流:无电路的世界不许"假装装载成功" ============ */

test('FND114-13 ★ `loadConveyorAt` 口径一致:wiring:true 装载并吃地面货;wiring:false 拒绝且货留地面', () => {
  const ground: GroundItem[] = [{ id: 151, x: 5, y: 5, count: 1 } as GroundItem];

  const on = new WorldSim({ sizeCells: 32, mobs: false });
  on.wiring.addComponent(makeComponent('belt', 428, 5, 5));
  on.setGroundItems([{ ...ground[0]! }]);
  eq(on.loadConveyorAt(5, 5), true, '有电路 ⇒ 装载成功');
  eq(on.groundItems.length, 0, '货离开地面(进了带,之后由 2Hz 物流推进)');

  const off = new WorldSim({ sizeCells: 32, mobs: false, wiring: false });
  off.wiring.addComponent(makeComponent('belt', 428, 5, 5));
  off.setGroundItems([{ ...ground[0]! }]);
  eq(off.loadConveyorAt(5, 5), false, '★ 无电路 ⇒ 拒绝装载(没有推进者,不能许诺一次永远不会发生的搬运)');
  eq(off.groundItems.length, 1, '货仍在地面(既没说成功,也没把货吞掉 —— 两个口径一致)');
});

report('WS-FND-114');