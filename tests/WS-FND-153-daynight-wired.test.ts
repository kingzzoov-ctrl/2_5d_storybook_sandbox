/**
 * WS-FND-153 —— **昼夜接上:夜行刷新门吃到真实世界钟**。
 *
 * 背景(`WS-FND-59` 已钉住时钟本身:一天 1200 秒、0 帧 = 06:00、`hourOfDay()` 在走)。
 * 本套件钉的是**下半截**:
 *
 * | # | 事实 | 修前形态 |
 * |---|---|---|
 * | 1 | `isNightNow()` 与 `isNight(hourOfDay())` **同一事实源** | 各处各算一遍,边界漂 |
 * | 2 | 夜的定义只有一处常量(`NIGHT_WINDOW`),派生别名不是第二份 | `19` / `6` 散在多处 |
 * | 3 | 天亮边界 06:00 两侧正反 | 边界附近靠"差不多" |
 * | 4 | 入夜边界 19:00 / 18:00 两侧正反 | 同上 |
 * | 5 | 改窗口常量 ⇒ 判定**立即**跟着变 | 函数体内另有一份字面量 |
 * | 6 | 夜行怪白天被 `DAYLIGHT` 拒、夜里放行;昼行怪昼夜都放行 | `world.isNight()` 恒 false |
 * | 7 | 端到端:同一套"清空后推进"流程,夜里真能刷出 NOCTURNAL,白天一只都没有 | 夜里也刷不出来 |
 * | 8 | 电路侧 `hour` / `night` 键读到的是世界钟,不是缺省 0 | `param('hour')` 恒 0 ⇒ `isNight(0)`=夜 |
 * | 9 | 405 在"没有世界事实"时不再恒亮 | 恒亮,且与"真的入夜"不可区分 |
 *
 * ⚠️ 帧长 0.05 秒(20Hz)⇒ **1000 帧 = 1 游戏小时**。本文件里的小时↔帧换算全部
 * 从裁决值(`WORLD_DAY_SEC` / `WORLD_START_HOUR` / `DT`)派生,不另写魔数。
 * ⚠️ 全程**不改任何数值**:刷怪密度仍来自内容表(`BIOME_SPAWN`),本项只让
 *    "能不能刷夜行怪"随昼夜真实变化。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, near, ok, report, test } from '../shared/testing/harness.ts';
import { WireColor } from '../shared/types/tile.ts';
import { DT } from '../shared/types/physics.ts';
import { SignalGraph, layHorizontal } from '../server/src/wiring/graph.ts';
import {
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
  NIGHT_WINDOW,
  isNight,
  isNightAtHour,
  makeComponent,
} from '../server/src/wiring/components.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import {
  NOCTURNAL,
  SpawnReject,
  decideSpawn,
  isNocturnal,
  nightGateAllows,
  spawnableMobs,
  type SpawnContext,
  type SpawnWorld,
} from '../server/src/mobs/spawner.ts';

const ROOT = join(import.meta.dirname, '..');

/** 1 游戏小时的**帧数**(由裁决值派生:一天 24 小时 ÷ `DT`)。 */
const FRAMES_PER_HOUR = WorldSim.WORLD_DAY_SEC / 24 / DT;

/** 从 06:00(0 帧)推到钟点 `hour` 的帧数(`hour` 允许 ≥ 24 ⇒ 跨日)。 */
function framesToHour(hour: number): number {
  return Math.round((hour - WorldSim.WORLD_START_HOUR) * FRAMES_PER_HOUR);
}

/** 从钟点 `from` 推到钟点 `to` 的帧数(按 24 小时循环算)。 */
function framesBetween(from: number, to: number): number {
  const delta = (((to - from) % 24) + 24) % 24;
  return Math.round(delta * FRAMES_PER_HOUR);
}

/** 一整轮的帧数(24 小时)。 */
const FRAMES_PER_DAY = WorldSim.WORLD_DAY_SEC / DT;

/** 钟点 `hour` 上的世界(不带生物:只测钟)。 */
function simAt(hour: number): WorldSim {
  const s = new WorldSim({ sizeCells: 24, mobs: false });
  s.advance(framesToHour(hour));
  return s;
}

/* ═══════════ 1. 同一事实源 ============ */

test('FND153-1 ★ 同一事实源:每个 frameCount 上 isNightNow() === isNight(hourOfDay())', () => {
  /* 覆盖:夜、边界两侧、白天、跨日回落(24 ≡ 0 点)—— 每一档都问一次世界。 */
  for (const h of [0, 5, 5.999, 6, 6.001, 12, 18, 18.999, 19, 23, 24]) {
    const s = simAt(h);
    const hour = s.hourOfDay();
    eq(s.isNightNow(), isNight(hour), `${h} 点:世界判据必须 == 共享常量的判据(否则两处各有一份夜)`);
    near(s.lastHourOfDay, hour, 1e-9, `${h} 点:lastHourOfDay 记的必须是同一次读数`);
  }
});

/* ═══════════ 2. 夜的定义只有一处 ============ */

test('FND153-2 ★ 夜的定义只有一处:NIGHT_WINDOW 冻结,两个别名只是它的读数', () => {
  ok(Object.isFrozen(NIGHT_WINDOW), 'NIGHT_WINDOW 必须冻结(改边界只能改这一个对象)');
  eq(Object.keys(NIGHT_WINDOW).sort(), ['endHour', 'startHour'], '窗口只有起点/终点两个字段');
  eq(NIGHT_START_HOUR, NIGHT_WINDOW.startHour, 'NIGHT_START_HOUR 是**派生**读数,不是第二份事实源');
  eq(NIGHT_END_HOUR, NIGHT_WINDOW.endHour, 'NIGHT_END_HOUR 同上');

  /* 字面量只许出现在一处:窗口的字面定义。 */
  const src = readFileSync(join(ROOT, 'server/src/wiring/components.ts'), 'utf8');
  eq((src.match(/startHour:\s*\d+/g) ?? []).length, 1, '`startHour:` 字面量在 wiring/components.ts 只能有一处');
  eq((src.match(/endHour:\s*\d+/g) ?? []).length, 1, '`endHour:` 字面量同上');
  /* 消费者两个文件都不许自带边界(自带 = 第二份事实源)。 */
  for (const rel of ['server/src/sim/world_sim.ts', 'server/src/mobs/spawner.ts']) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    ok(!/startHour\s*[:=]\s*\d/.test(text), `${rel} 不许自带夜的起点`);
    ok(!/endHour\s*[:=]\s*\d/.test(text), `${rel} 不许自带夜的终点`);
  }
  /* `isNight` 必须就是「拿 NIGHT_WINDOW 调 isNightAtHour」那一次(逐点等价)。 */
  for (let h = 0; h <= 24; h += 0.25) {
    eq(isNight(h), isNightAtHour(h, NIGHT_WINDOW), `${h}:isNight 函数体内不许另有字面量`);
  }
});

/* ═══════════ 3. 天亮边界 06:00 两侧 ============ */

test('FND153-3 ★ 天亮边界:06:00 前一帧是夜、06:00 那帧不是(世界钟两侧)', () => {
  /* 06:00 是**世界日的起点**(0 帧),所以"前一帧"要从上一轮的末尾取。 */
  const before = new WorldSim({ sizeCells: 24, mobs: false });
  before.advance(FRAMES_PER_DAY - 1);
  ok(before.hourOfDay() < NIGHT_END_HOUR, `前置:停在 06:00 之前(实测 ${before.hourOfDay().toFixed(4)} 点)`);
  eq(before.isNightNow(), true, '05:59 仍是夜');
  eq(isNight(before.hourOfDay()), true, '同一读数:常量判据也说是夜');

  const at = simAt(6);
  near(at.hourOfDay(), NIGHT_END_HOUR, 1e-6, '06:00 这一帧的钟点');
  eq(at.isNightNow(), false, '★ 06:00 天亮(值恰好等于边界 ⇒ 不是夜)');
  eq(isNight(NIGHT_END_HOUR), false, '常量判据同侧:边界值本身算白天');

  /* 一整轮之后回到 06:00,结论必须**一模一样**(循环而不是累加溢出)。 */
  const nextDay = new WorldSim({ sizeCells: 24, mobs: false });
  nextDay.advance(FRAMES_PER_DAY);
  near(nextDay.hourOfDay(), NIGHT_END_HOUR, 1e-6, '24 小时后回到 06:00');
  eq(nextDay.isNightNow(), false, '次日 06:00 同样天亮');
});

/* ═══════════ 4. 入夜边界 19:00 / 18:00 两侧 ============ */

test('FND153-4 ★ 入夜边界:18:00 是白天、19:00 起是夜(两侧都问世界)', () => {
  const day = simAt(18);
  near(day.hourOfDay(), 18, 1e-6, '18:00');
  eq(day.isNightNow(), false, '★ 18:00 仍是白天(夜不是 18:00 开始)');
  eq(isNight(day.hourOfDay()), false, '常量判据同侧');

  const justBefore = new WorldSim({ sizeCells: 24, mobs: false });
  justBefore.advance(framesToHour(19) - 1);
  eq(justBefore.isNightNow(), false, '18:59 仍是白天');

  const night = simAt(19);
  near(night.hourOfDay(), NIGHT_START_HOUR, 1e-6, '19:00');
  eq(night.isNightNow(), true, '★ 19:00 入夜');
  eq(isNight(night.hourOfDay()), true, '常量判据同侧');
});

/* ═══════════ 5. 改常量边界立即反映 ============ */

test('FND153-5 ★ 改窗口边界立即反映:判定只读 NIGHT_WINDOW,换窗口结论当场变', () => {
  const earlier = { startHour: 18, endHour: 6 };
  const laterSunrise = { startHour: 19, endHour: 7 };

  eq(isNight(18), false, '本仓口径:19:00 入夜 ⇒ 18:00 是白天');
  eq(isNightAtHour(18, earlier), true, '把起点改成 18 ⇒ 18:00 **立即**变成夜');
  eq(isNight(6), false, '本仓口径:06:00 天亮');
  eq(isNightAtHour(6, laterSunrise), true, '把天亮改成 07:00 ⇒ 06:00 **立即**算夜');
  /* 交界处不算夜(含起点、不含终点):两个窗口都守这条。 */
  eq(isNightAtHour(NIGHT_WINDOW.startHour, NIGHT_WINDOW), true, '起点含在夜里');
  eq(isNightAtHour(NIGHT_WINDOW.endHour, NIGHT_WINDOW), false, '终点不含在夜里');

  /* 世界侧:同一个 frameCount 的钟点,换个窗口结论就换 ⇒ 世界不另存一份夜。 */
  const s = simAt(18);
  eq(s.isNightNow(), false, '默认窗口下 18:00 是白天');
  eq(isNightAtHour(s.hourOfDay(), earlier), true, '用**同一个 hour** 换个窗口 ⇒ 立刻是夜');
});

/* ═══════════ 6. 刷怪门:夜行 / 昼行 ============ */

/** 判据用的 `SpawnWorld`:格查询一切从简,**只有夜这一项是变量**。 */
function spawnWorldWith(redNight: () => boolean): SpawnWorld {
  return {
    objAt: () => 0,
    floorAt: () => 0,
    blocked: () => false,
    /* 城镇中心放到 (0,0),探针点 (40,40) 在 24 格安全半径之外。 */
    townCenter: () => ({ x: 0, y: 0 }),
    isNight: redNight,
  };
}

function spawnCtx(mobId: string): SpawnContext {
  return { biome: 'RUINS', x: 40, y: 40, biomeCount: 0, globalCount: 0, mobId };
}

test('FND153-6 ★ 夜行门:NOCTURNAL 白天被 DAYLIGHT 拒、夜里放行;昼行怪昼夜都放行', () => {
  /* 名单不新立:夜行取 `NOCTURNAL`,昼行取同一群系里**不在**名单里的物种。 */
  const roster = spawnableMobs('RUINS').map((m) => m.id);
  const nocturnalIds = roster.filter((id) => NOCTURNAL.has(id));
  const diurnalIds = roster.filter((id) => !NOCTURNAL.has(id));
  ok(nocturnalIds.length > 0, '前置:RUINS 的名单里必须有夜行怪(否则本判据空转)');
  ok(diurnalIds.length > 0, '前置:RUINS 的名单里必须有昼行怪');
  const nocturnalId: string = nocturnalIds[0] as string;
  const diurnalId: string = diurnalIds[0] as string;
  ok(isNocturnal(nocturnalId) && !isNocturnal(diurnalId), '名单口径:夜行/昼行由 NOCTURNAL 判定');

  const day = spawnWorldWith(() => false);
  const night = spawnWorldWith(() => true);

  eq(decideSpawn(spawnCtx(nocturnalId), day, 0.9), { spawn: false, reason: SpawnReject.DAYLIGHT },
    '★ 白天:夜行怪被拒,原因是 DAYLIGHT(不是"没名额"也不是"被光照挡")');
  eq(decideSpawn(spawnCtx(nocturnalId), night, 0.9), { spawn: true, reason: SpawnReject.OK },
    '★ 夜里:同一只夜行怪放行');
  eq(decideSpawn(spawnCtx(diurnalId), day, 0.9), { spawn: true, reason: SpawnReject.OK },
    '昼行怪白天照刷(昼夜不改它的概率)');
  eq(decideSpawn(spawnCtx(diurnalId), night, 0.9), { spawn: true, reason: SpawnReject.OK },
    '昼行怪夜里照刷');
  eq(nightGateAllows(nocturnalId, false), false, '门函数本身:夜行 + 白天 = 不放行');
  eq(nightGateAllows(diurnalId, false), true, '门函数本身:昼行 + 白天 = 放行');

  /* 与世界钟接口:夜这一项直接由 `WorldSim.isNightNow()` 喂 ⇒ 判定与钟同源。 */
  const s = simAt(19);
  const byClock = spawnWorldWith(() => s.isNightNow());
  eq(decideSpawn(spawnCtx(nocturnalId), byClock, 0.9).spawn, true, '19:00 的世界 ⇒ 夜行怪可刷');
  s.advance(framesBetween(NIGHT_START_HOUR, WorldSim.WORLD_START_HOUR)); /* 推到次日 06:00 */
  eq(s.isNightNow(), false, '前提:已回到白天');
  eq(decideSpawn(spawnCtx(nocturnalId), spawnWorldWith(() => s.isNightNow()), 0.9).reason,
    SpawnReject.DAYLIGHT, '同一个世界推到天亮 ⇒ 夜行门立刻关上');
});

/* ═══════════ 7. 端到端:夜里真能刷出 NOCTURNAL ============ */

function census(s: WorldSim): { total: number; nocturnal: number } {
  const alive = s.listWildlife();
  return {
    total: alive.length,
    nocturnal: alive.filter((w) => isNocturnal(w.mobId)).length,
  };
}

/** 把它们真的打死并让尸体被收(计数退回 ⇒ 名额释放),而不是手改计数器。 */
function clearMobs(s: WorldSim): void {
  for (let pass = 0; pass < 3; pass += 1) {
    for (const w of s.listWildlife()) s.damageMob(w.id, 1e6, DamageKind.PHYSICAL, 0);
    s.advance(10);
  }
}

/**
 * 同一套流程(推进到某钟点 → 清空 → 再推进 1 小时),**只差在白天还是夜里**。
 * 这样"白天没有夜行怪"就不可能是"这一段没刷怪"造成的。
 */
function spawnWindowAt(startHour: number): { hour: number; night: boolean; pop: number; nocturnal: number } {
  const s = new WorldSim({ sizeCells: 64, mobs: true, biome: 'RUINS' });
  s.advance(framesToHour(startHour));
  clearMobs(s);
  s.advance(FRAMES_PER_HOUR);
  const c = census(s);
  return { hour: s.hourOfDay(), night: s.isNightNow(), pop: c.total, nocturnal: c.nocturnal };
}

test('FND153-7 ★ 端到端:夜里刷得出 NOCTURNAL,白天一只都没有(同一套流程)', () => {
  const day = spawnWindowAt(12);   /* 12:00 → 13:00,全程白天 */
  const night = spawnWindowAt(19); /* 19:00 → 20:00,全程夜里 */

  eq(day.night, false, `白天窗口不该是夜(实测 ${day.hour.toFixed(3)} 点)`);
  eq(night.night, true, `夜里窗口必须是夜(实测 ${night.hour.toFixed(3)} 点)`);

  ok(day.pop > 0, `前置:白天真的刷了怪(${day.pop} 只)—— 否则"没有夜行怪"可能只是"没刷怪"`);
  ok(night.pop > 0, `前置:夜里真的刷了怪(${night.pop} 只)`);

  eq(day.nocturnal, 0, `★ 白天:夜行怪 0 只(实测 ${day.nocturnal} 只)`);
  ok(night.nocturnal > 0, `★ 夜里:夜行怪必须出现(实测 ${night.nocturnal} 只 / 共 ${night.pop} 只)`);
});

/* ═══════════ 8. 电路侧读到的是真实钟点 ============ */

test('FND153-8 ★ 电路侧 env 键吃到真实钟点:hour === hourOfDay(),night 随它翻转', () => {
  const s = new WorldSim({ sizeCells: 24, mobs: false });
  /* 0 帧 = 06:00。如果世界侧给的是"恒 0",这一条会立刻变成"0 点(夜)"。 */
  near(s.hourOfDay(), WorldSim.WORLD_START_HOUR, 1e-9, '前置:0 帧 = 06:00');
  near(s.wiringEnvOf('hour'), s.hourOfDay(), 1e-9, '★ 电路侧钟点 == 世界钟(不是缺省 0)');
  eq(s.wiringEnvOf('night'), 0, '06:00 电路侧的 night 键 = 0');
  ok(s.wiringEnvOf('hour') > 0, '★ 反例防线:恒 0 的实现会让这里等于 0(即被判成 0 点=夜)');

  s.advance(framesToHour(19));
  near(s.wiringEnvOf('hour'), NIGHT_START_HOUR, 1e-6, '19:00 电路侧读到 19:00');
  eq(s.wiringEnvOf('night'), 1, '★ 19:00 电路侧的 night 键 = 1(夜行门/感光器都读它)');
  near(s.lastHourOfDay, s.hourOfDay(), 1e-9, 'lastHourOfDay 与 hourOfDay 同一次读数');

  s.advance(framesBetween(NIGHT_START_HOUR, WorldSim.WORLD_START_HOUR)); /* 次日 06:00 */
  eq(s.wiringEnvOf('night'), 0, '天亮后电路侧 night 键回到 0');
});

/* ═══════════ 9. 405:没有世界事实时不再恒亮 ============ */

test('FND153-9 ★ 405 感光器:环境口缺席时如实报 0(不再把"缺省 0"当 0 点),挂上后随钟翻转', () => {
  /* 裸图:没有任何世界环境口 ⇒ `param('hour')` 的 0 是"没有事实"。 */
  const bare = new SignalGraph(8, 8);
  eq(bare.hasEnvSource(), false, '前置:裸图没有世界环境口');
  const naked = makeComponent('lightNaked', 405, 2, 3);
  bare.addComponent(naked);
  layHorizontal(bare, 3, 6, 3, WireColor.RED);
  bare.run(2);
  eq(naked.state.night, 0, '★ 没有世界事实 ⇒ 报 0(修前 `isNight(0)` = 夜 ⇒ 恒亮)');

  /* 挂上世界环境口:同一件随真实钟点翻转。 */
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const g = sim.wiring;
  const sensor = makeComponent('light', 405, 2, 3);
  g.addComponent(sensor);
  layHorizontal(g, 3, 6, 3, WireColor.RED);
  g.run(2);
  eq(sensor.state.night, 0, '06:00 白天 ⇒ 0');
  eq(g.liveAt(6, 3, WireColor.RED), false, '线输出同向(白天不亮)');

  sim.advance(framesToHour(19));
  g.run(2);
  eq(sensor.state.night, 1, '★ 19:00 ⇒ 1(感光器吃到的是世界钟,不是摆放时的常量)');
  eq(g.liveAt(6, 3, WireColor.RED), true, '线输出同向(夜里点亮)');

  /* 摆放者手填的静态 `hour` 仍算已知事实(蓝图/单测的老用法不回归)。 */
  const manual = new SignalGraph(8, 8);
  const placed = makeComponent('lightManual', 405, 2, 3);
  placed.params.hour = 22;
  manual.addComponent(placed);
  manual.run(2);
  eq(placed.state.night, 1, '静态 params.hour = 22 ⇒ 夜(手填钟点仍是合法事实)');
});

report('WS-FND-153-daynight-wired');