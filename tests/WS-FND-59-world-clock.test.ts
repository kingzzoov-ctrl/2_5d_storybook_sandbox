/**
 * WS-FND-59 —— **世界时钟**(裁决 D-07,见 `docs/DECISIONS.md`)。
 *
 * | 裁决 | 值 |
 * |---|---|
 * | 一天 | **1200 秒(20 分钟)** |
 * | 0 帧 | **06:00**(天亮) |
 * | 夜 | **19:00–06:00**(边界**借用** `wiring/components.ts` 的 `isNight(hour)`,不重写) |
 *
 * ## 为什么这条要单独立套件
 * 世界侧此前**没有时钟** ⇒ `WorldSim.isNight()` 恒 `false`(如实回答"不知道"),
 * 于是夜行怪白天夜里都刷不出来、405 昼夜感光器读的 `hour` 参数全仓 0 个生产者。
 * 时钟接上之后,"**时间真的在走**"这件事必须可断言,而不是看它跑起来像不像。
 *
 * ⚠️ 帧长 = `DT`(`TICK_HZ` 派生):**1 游戏小时的帧数 = `secondsToTicks(一天秒数 / 24)`**。
 * 断言里的帧数一律由它派生,不写死 —— 写死的数只在旧 tick 率下是「1 小时」。
 */
import { secondsToTicks } from '../shared/types/physics.ts';
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';

/**
 * 1 游戏小时的**秒数** = `WorldSim.WORLD_DAY_SEC / 24`(D-07:一天 1200 秒 ⇒ 50 秒)。
 * 帧数由 `secondsToTicks` **派生**(32Hz 下 = 1600),不写死。
 */
const SEC_PER_HOUR = WorldSim.WORLD_DAY_SEC / 24;
/** 1 游戏小时的帧数(派生值)。 */
const FRAMES_PER_HOUR = secondsToTicks(SEC_PER_HOUR);
/** 一整轮(24 小时)的帧数。 */
const FRAMES_PER_DAY = 24 * FRAMES_PER_HOUR;

function sim(): WorldSim {
  return new WorldSim({ sizeCells: 24, mobs: false });
}

/** 推到"从起点算起的第 n 小时";帧数由 `FRAMES_PER_HOUR` 派生,分批推只是批次大小(与时长无关)。 */
function toHour(s: WorldSim, hour: number): void {
  const targetFrames = Math.round(hour * FRAMES_PER_HOUR);
  let done = 0;
  while (done < targetFrames) {
    const step = Math.min(1000, targetFrames - done);
    s.advance(step);
    done += step;
  }
}

test('FND59-1 ★ 0 帧 = 06:00,且白天不是夜(D-07 的起点)', () => {
  const s = sim();
  near(s.hourOfDay(), 6, 1e-9, '世界时间 0 帧应对应 06:00');
  eq(s.isNightNow(), false, '06:00 是白天(夜是 19:00–06:00)');
});

test('FND59-2 ★ 时间真的在走:1 游戏小时(`FRAMES_PER_HOUR` 帧)后到 07:00', () => {
  const s = sim();
  s.advance(FRAMES_PER_HOUR);
  near(s.hourOfDay(), 7, 1e-6, `${FRAMES_PER_HOUR} 帧应正好 1 小时(实测 ${s.hourOfDay().toFixed(4)})`);
  eq(s.isNightNow(), false, '07:00 仍是白天');
});

test('FND59-3 ★ 入夜/天亮两侧:19:00 起是夜,06:00 起不是', () => {
  const s = sim();
  toHour(s, 13); /* 06:00 + 13 h = 19:00 */
  near(s.hourOfDay(), 19, 1e-6, `应到 19:00(实测 ${s.hourOfDay().toFixed(4)})`);
  eq(s.isNightNow(), true, '★ 19:00 起入夜');

  const d = sim();
  toHour(d, 24); /* 次日 06:00 */
  near(d.hourOfDay(), 6, 1e-6, `一整轮后应回到 06:00(实测 ${d.hourOfDay().toFixed(4)})`);
  eq(d.isNightNow(), false, '★ 06:00 天亮(不再是夜)');
});

test('FND59-4 ★ 一整轮(24 小时)后钟点回到起点 —— 日期是循环的,不是累加溢出', () => {
  const s = sim();
  s.advance(FRAMES_PER_DAY);
  near(s.hourOfDay(), 6, 1e-6, `24 小时后应回到 06:00(实测 ${s.hourOfDay().toFixed(4)})`);
});

test('FND59-5 时钟**不读系统时间**:两个独立世界跑同样帧数 ⇒ 同一个钟点(可重放)', () => {
  const a = sim();
  const b = sim();
  a.advance(3 * FRAMES_PER_HOUR);
  b.advance(1 * FRAMES_PER_HOUR);
  b.advance(2 * FRAMES_PER_HOUR); /* 分两段推,总帧数相同 */
  eq(a.hourOfDay(), b.hourOfDay(), '★ 同一帧数 ⇒ 同一钟点(与挂钟无关)');
  near(a.hourOfDay(), 9, 1e-6, '3 小时后是 09:00');
});

test('FND59-6 裁决值就在代码里:一天 1200 秒、起点 06:00(D-07 的字面值)', () => {
  /* 期望值取**裁决原文**(D-07),不是从被测模块推导 —— 改这两个数必须同时改裁决。 */
  eq(WorldSim.WORLD_DAY_SEC, 1200, '一天 = 1200 秒(20 分钟)');
  eq(WorldSim.WORLD_START_HOUR, 6, '0 帧 = 06:00');
});

report('WS-FND-59-world-clock');