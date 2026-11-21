/**
 * WS-FND-177 · **名义 tick 20Hz → 32Hz(31.25ms)后「时长不变」**(秒级语义判据)。
 *
 * ## 这一套判据在守什么
 *
 * 改 tick 率的真实风险**不是**「帧数变了」,而是:
 * 「某个**以帧数计的时长**在改 tick 率时**静默**换了秒数」。
 *
 * ⇒ 本套件一律**用秒断言时长**,并断言「帧数由秒派生」——
 *   这样将来再改 tick 率(16Hz / 64Hz …),只要某个时长漂了,这里就红。
 *
 * ## 判据
 * ```text
 * TICK32-1  单一事实源:TICK_HZ=32 / TICK_MS=31.25 / SIM_DT=DT=1/32;换算助手自洽
 * TICK32-2  慢帧仍是 0.5 秒:SLOW_DT=0.5、FAST_PER_SLOW=16、SIM_SLOW_DT=0.5
 * TICK32-3  快帧步长仍是 1/TICK_HZ 秒:SIM_FAST_DT = 0.03125
 * TICK32-4  跳跃冷却仍是 1.2 秒(声明以秒写、帧数由 secondsToTicks 派生)
 * TICK32-5  游戏日仍是 1200 游戏秒(帧数表示 = 38400 = WORLD_DAY_SEC / DT)
 * TICK32-6  战斗时长仍是秒:无敌 0.35s / 回血延迟 6s / 连击窗 0.6s / 泡泡 5s
 * TICK32-7  收尸窗口仍是 0.1 秒(MOB_CORPSE_SEC,帧数由 secondsToTicks 派生)
 * ```
 *
 * 运行:`node tests/WS-FND-177-tick32-seconds.test.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, near, ok, report, test } from '../shared/testing/harness.ts';
import {
  DT,
  SIM_DT,
  SLOW_DT,
  SLOW_TICK_HZ,
  TICK_HZ,
  TICK_MS,
  msToTicks,
  secondsToTicks,
  ticksToSeconds,
} from '../shared/types/physics.ts';
import { FAST_PER_SLOW, SIM_FAST_DT, SIM_SLOW_DT, WorldSim } from '../server/src/sim/world_sim.ts';
import { MOB_CORPSE_FRAMES, MOB_CORPSE_SEC } from '../server/src/mobs/host.ts';
import { PLAYER_IFRAME_SEC, PLAYER_REGEN_DELAY_SEC } from '../server/src/combat/vitals.ts';
import { COMBO_WINDOW_SEC } from '../server/src/combat/damage.ts';
import { BUBBLE_TRAP_SEC } from '../server/src/combat/revive.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const READ = (rel: string): string => readFileSync(join(resolve(HERE, '..'), rel), 'utf8');

test('TICK32-1 单一事实源:TICK_HZ=32 / TICK_MS=31.25 / SIM_DT=DT=1/32', () => {
  eq(TICK_HZ, 32, '名义 tick 率 = 32Hz(owner 裁定)');
  eq(TICK_MS, 31.25, '标称帧间隔 = 1000 / 32 = 31.25ms');
  near(DT, 1 / 32, 1e-12, '快帧步长 = 1/32 秒');
  near(SIM_DT, DT, 1e-12, 'SIM_DT 与 DT 同源(同一份单步时长)');
  eq(secondsToTicks(1), 32, '1 秒 = 32 帧');
  near(ticksToSeconds(FAST_PER_SLOW), 0.5, 1e-12, '16 帧 = 0.5 秒');
  eq(msToTicks(31.25), 1, '31.25ms = 1 帧');
});

test('TICK32-2 慢帧仍是 0.5 秒(SLOW_DT / FAST_PER_SLOW / SIM_SLOW_DT)', () => {
  eq(SLOW_DT, 0.5, '慢帧时长源头 = 0.5 秒(不随 tick 率漂)');
  eq(SLOW_TICK_HZ, 2, '慢帧频率 = 1 / 0.5 = 2Hz');
  eq(FAST_PER_SLOW, 16, '一个慢帧 = 0.5 秒 = 16 个快帧(32Hz)');
  eq(FAST_PER_SLOW, secondsToTicks(SLOW_DT), '比例由秒派生,不是写死的帧数');
  near(SIM_SLOW_DT, 0.5, 1e-12, '慢帧步长仍是 0.5 秒');
});

test('TICK32-3 快帧步长仍是 1/TICK_HZ 秒', () => {
  near(SIM_FAST_DT, 1 / TICK_HZ, 1e-12, 'SIM_FAST_DT = 1/TICK_HZ');
  near(SIM_FAST_DT, 0.03125, 1e-12, '= 0.03125 秒');
});

test('TICK32-4 跳跃冷却仍是 1.2 秒(帧数由秒派生)', () => {
  near(ticksToSeconds(secondsToTicks(1.2)), 1.2, 1 / TICK_HZ, '1.2 秒的帧数换算回秒仍是 1.2');
  eq(secondsToTicks(1.2), 38, '1.2 秒 ⇒ 32Hz 下 38 帧');
  const src = READ('server/src/sim/world_sim.ts');
  ok(src.includes('JUMP_COOLDOWN_SEC = 1.2'), '跳跃冷却必须以**秒**声明(1.2s)');
  ok(src.includes('JUMP_COOLDOWN_FRAMES = secondsToTicks(WorldSim.JUMP_COOLDOWN_SEC)'),
    '帧数必须由 secondsToTicks(秒) 派生,不许写死 24/38');
});

test('TICK32-5 游戏日仍是 1200 游戏秒(帧数表示 = 38400)', () => {
  eq(WorldSim.WORLD_DAY_SEC, 1200, '一天仍是 1200 游戏秒(20 分钟,D-07)');
  eq(WorldSim.WORLD_START_HOUR, 6, '0 帧仍是 06:00(D-07)');
  eq(WorldSim.WORLD_DAY_SEC / DT, 38400, '帧数表示 = 1200 / (1/32) = 38400');
  eq(secondsToTicks(WorldSim.WORLD_DAY_SEC), 38400, '由秒换算同样得 38400');
  const src = READ('server/src/sim/world_sim.ts');
  ok(src.includes('FRAMES_PER_DAY = WorldSim.WORLD_DAY_SEC / DT'), '世界日长度必须由秒数 / DT 派生');
});

test('TICK32-6 战斗时长仍是秒(无敌/回血/连击/泡泡)', () => {
  eq(PLAYER_IFRAME_SEC, 0.35, '受击无敌仍是 0.35 秒');
  eq(PLAYER_REGEN_DELAY_SEC, 6.0, '回血延迟仍是 6 秒');
  eq(COMBO_WINDOW_SEC, 0.6, '连击窗口仍是 0.6 秒');
  eq(BUBBLE_TRAP_SEC, 5.0, '泡泡困人仍是 5 秒');
});

test('TICK32-7 收尸窗口仍是 0.1 秒(帧数由秒派生)', () => {
  eq(MOB_CORPSE_SEC, 0.1, '尸体保留窗口以秒声明 = 0.1 秒');
  eq(MOB_CORPSE_FRAMES, secondsToTicks(MOB_CORPSE_SEC), '帧数由 secondsToTicks(秒) 派生');
  near(ticksToSeconds(MOB_CORPSE_FRAMES), 0.1, 1 / TICK_HZ, '换算回秒 ≈ 0.1(一个 tick 粒度内)');
});

report('WS-FND-177');
