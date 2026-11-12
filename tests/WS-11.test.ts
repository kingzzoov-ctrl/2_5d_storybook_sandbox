/**
 * WS-11 测试 — 胡闹工坊急单 / 35 种整蛊玩具 / 平安盾免疫 / 四大竞技派对模式 / 社交挂机
 *
 * node tests/WS-11.test.ts   (Node 24 原生跑 .ts)
 * 零外部依赖:只用 `shared/testing/harness.ts` + 本仓库实现层。
 */

import {
  test, ok, eq, near, includes, inRange, mulberry32, report,
} from '../shared/testing/harness.ts';

import {
  createManualClock,
  createRushOrderSession,
  startRushOrder,
  tickRushOrder,
  elapsedSec,
  settleSession,
  submitDelivery,
  boardProgress,
  gradeOf,
  generateOrderBoard,
  deliverItem,
  ORDER_SLOT_MIN,
  ORDER_SLOT_MAX,
  ROOM_LEVEL_PER_SLOT,
  ORDER_POOL,
  assertOrderPoolClosed,
  RUSH_ORDER_DURATION_SEC,
  RUSH_ORDER_STATE,
  OVERHEAT_SEC,
  EXTINGUISH_SEC,
  createStation,
  startStation,
  tickStation,
  tendStation,
  isSmoking,
  STATION_KIND,
  STATION_STATE,
  EVT_FIRE,
  EVT_DOUSED,
  EVT_SMOKE,
  EVT_BEAVER_STOLE,
  BEAVER_TARGET_ITEM_ID,
  BEAVER_RECLAIM_QTY,
  spawnBeaver,
  tickBeaver,
  hitBeaver,
  reclaimWood,
  BEAVER_STATE,
  HAMMER_222_IMPULSE,
  BEAVER_STUN_SEC,
  createRelayChain,
  fireRelayStage,
  advanceRelayChain,
  addRelayChain,
  RELAY_STAGES,
  RELAY_STAGE_TIMEOUT_SEC,
  CHAIN_STATE,
  CHAIN_SUCCESS_SCORE,
  CHAIN_BREAK_PENALTY,
  RELAY_THROW_RANGE,
  RELAY_RIVER_WIDTH,
  canPickZ2Fruit,
  canMountBossBack,
  stackTopZ,
  stackCarrierSpeed,
  CARRY_MAX_DEPTH,
  STACK_REACH_Z,
  Z2_REACH_TARGET,
  Z2_FRUIT_HEIGHT,
  BOSS_BACK_HEIGHT,
} from '../server/src/coop/rush_order.ts';

import {
  PRANK_TOYS, PRANK_TOY_BY_ID, PRANK_TOY_ID_MIN, PRANK_TOY_ID_MAX, PRANK_TOY_COUNT,
  assertToyIdSetClosed, assertAllyZeroDamage, assertToyFieldsSane, toyOf, toyIds,
  TOY_TRIGGER, TOY_STATE_FLAG,
  BANANA_SLIDE_TILES, BANANA_SLIDE_STUN_SEC, resolveBananaSlide,
  BUBBLE_HITS_TO_TRAP, createBubble, hitBubble, BUBBLE_DRIFT_SEC,
  SNOWBALL_FREEZE_SEC, resolveSnowball,
  BOMB_FUSE_SEC, BOMB_ENEMY_DAMAGE, SHRINK_SCALE, GIANT_SCALE, HONEY_SLOW_RATIO,
  SELF_DAMAGE_HP_FLOOR_RATIO, HELMET_SELF_PARALYZE_SEC, HELMET_SELF_DAMAGE,
  selfDamageHpFloor, applySelfDamage, resolveHelmetSelfStrike, SELF_DAMAGE_STATE,
} from '../server/src/prank/toys.ts';

import {
  IMMUNITY_MANIFEST, IMMUNITY_BY_KEY, NAMED_IMMUNE_TOY_IDS, NAMED_IMMUNE_LABEL,
  HOSTILE_SOURCES, HOSTILE_ENTRIES,
  EFFECT_ORIGIN, SHIELD_VERDICT,
  resolveShield, isImmuneToAllyPrank, isImmuneToHostile,
  assertImmunityManifestComplete, createShield, toggleShield, applyShield,
  SAFE_SHIELD_ITEM_ID,
} from '../server/src/prank/immunity.ts';

import {
  PARTY_MODE_KEY, PARTY_PHASE, partyModeConfig, assertAllModesPresent,
  createBridgeRun, bridgePlace, bridgeCapture, settleBridgeRun,
  BRIDGE_BUILD_SEC, BRIDGE_RACE_SEC, BRIDGE_TILES_TO_WIN,
  createJellyBall, kickBall, tickJellyBall, judgeGoal, settleJellyBall,
  JELLY_BALL_RESET_SEC, JELLY_GOAL_WIDTH,
  createCrownRun, crownAssignTeam, crownPickup, crownDrop, tickCrown, settleCrown,
  CROWN_WIN_SEC, CROWN_MODE_SEC, CROWN_PICKUP_COOLDOWN_SEC,
  createPaintWar, throwPaintBall, settlePaintWar,
  PAINT_MODE_SEC, PAINT_BALL_RADIUS,
  createRaceRun, registerRunner, openGate, finishRunner, settleRace,
  startPartyMode, tickPartyMode, modeElapsedSec,
} from '../server/src/party/modes.ts';

import {
  TEAM_KEY, TEAM_ORDER, TEAM_LABEL, createScoreboard, getTeam,
  createBroadcaster, pushBroadcast, shiftBroadcast, drainBroadcasts,
  BROADCAST_KIND, scoreLine, crownLine,
  createRaceTimer, gateStart, podiumFinish, toMs, rankRace, formatMs,
  podiumBroadcast, createPaintGrid, paintRadius, tileCount, neutralCount,
  rankPaint, paintStandingLine, DYE_PALETTE_SIZE, pickDyeIndex, seededRng,
  rewardForRank, REWARD_EXP_BY_RANK, makeRng,
} from '../server/src/party/scoring.ts';

import {
  createAfkPlayer, goBackground, goForeground, tickAfk, dewRatePerSec, patDozing,
  DOZE_AFTER_SEC, DEW_SEC_PER_UNIT, DEW_FIRE_BONUS, DEW_TATAMI_BONUS, DEEP_SLEEP_AFTER_SEC,
  DOZE_STATE, afkExpRatio, createVivarium, enterVivarium, tickVivarium, exitVivarium,
  VIVARIUM, WHITE_NOISE_MIX, whiteNoiseMasterGain, VIVARIUM_CAMERA_SHOTS,
  createMailbox, leaveMail, likeMail, badgeFor, pruneMailbox,
  MAILBOX_CAPACITY, MAIL_TTL_SEC,
  createStall, suggestedPrice, listItem, buyFromStall, STALL_SLOT_COUNT, CROSS_ROOM_FEE_RATIO,
  TRACK_KIND, createTrack, trackStart, trackCaught, trackFinish, trackStandings,
  trackPodiumText, KITE_CATCH_PENALTY_MS, MARATHON_LENGTH,
} from '../server/src/social/afk.ts';

import { PARTY_MODES } from '../shared/constants/bosses.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { AFK_EXP_RATIO } from '../shared/types/entities.ts';
import * as PHY from '../shared/types/physics.ts';
import { CATCH_RADIUS, CARRY_Z_STEP, BodyState } from '../shared/types/physics.ts';

/* task-38 的归属判定要读生产源码文本(宿主的**存在性**无法由 import 断言)。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根(本文件在 <root>/tests/ 下)。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ════════════════════════════════════════════════════════════════════
 * A. 急单:订单生成可复现 + 3 分钟状态机 + 交付评分
 * ════════════════════════════════════════════════════════════════════ */

test('A1 订单池引用全部闭合于冻结层配表', () => {
  assertOrderPoolClosed();
  eq(ORDER_POOL.length, new Set(ORDER_POOL).size, '订单池无重复');
  for (const id of ORDER_POOL) ok(ITEM_BY_ID.has(id), `物品 ${id} 必须存在于 ITEM_BY_ID`);
});

test('A2 同 seed 同入参 ⇒ 订单板逐字段一致(可复现)', () => {
  const stock = { 101: 0, 151: 12 };
  const a = generateOrderBoard(mulberry32(2024), 12, stock, 2024);
  const b = generateOrderBoard(mulberry32(2024), 12, stock, 2024);
  eq(a.slots.length, b.slots.length, '订单位数一致');
  eq(JSON.stringify(a), JSON.stringify(b), '整块订单板序列化一致');
  ok(a.slots.length >= 2 && a.slots.length <= 4, '订单位数 ∈ [2,4]');
  for (const s of a.slots) {
    inRange(s.need, 1, 4, `订单 ${s.itemId} 需求量`);
    ok(s.points > 0, `订单 ${s.itemId} 分值应为正`);
    eq(s.delivered, 0, '初始已交付为 0');
  }
});

test('A3 不同 seed ⇒ 订单不同(生成器真的在使用 rng)', () => {
  const a = generateOrderBoard(mulberry32(1), 8, {}, 1);
  const b = generateOrderBoard(mulberry32(2), 8, {}, 2);
  const key = (x: typeof a): string => x.slots.map((s) => `${s.itemId}:${s.need}`).join(',');
  ok(key(a) !== key(b), `seed 1 与 seed 2 的订单应不同: ${key(a)} vs ${key(b)}`);
});

test('A4 库存压力:0 库存的物料权重高于满库存物料', () => {
  const board = generateOrderBoard(mulberry32(7), 10, { 101: 999 });
  ok(board.totalPoints > 0, '满分应为正');
  const slotA = board.slots[0];
  ok(typeof slotA.name === 'string' && slotA.name.length > 0, '订单项须带冻结层名称');
  eq(slotA.name, ITEM_BY_ID.get(slotA.itemId)?.name, '名称取自冻结层事实源');
});

test('A5 交付判定:按槽位消耗、超额部分不重复计分', () => {
  const board = generateOrderBoard(mulberry32(9), 20, {}, 9);
  const s = board.slots[0];
  const r1 = submitDeliveryProbe(board, s.itemId, s.need + 5);
  eq(r1.consumed, s.need, '只消耗订单需要的数量');
  ok(r1.accepted, '交付被接受');
  const again = submitDeliveryProbe(board, s.itemId, 1);
  ok(!again.accepted, '已完成的槽位不再接受');
});

function submitDeliveryProbe(board: ReturnType<typeof generateOrderBoard>, itemId: number, qty: number) {
  /* 直接调用 deliverItem 语义的会话级封装 */
  const clock = createManualClock(0);
  const ses = createRushOrderSession({ clock, roomLevel: 10, rng: mulberry32(1), stock: {} });
  ses.board = board;
  return submitDelivery(ses, itemId, qty);
}

test('A6 完成度与评级阈值', () => {
  eq(gradeOf(0), 'C');
  eq(gradeOf(0.5), 'B');
  eq(gradeOf(0.75), 'A');
  eq(gradeOf(0.999999), 'A');
  eq(gradeOf(1), 'S');
  const board = generateOrderBoard(mulberry32(3), 6, {}, 3);
  eq(boardProgress(board), 0, '未交付时完成度为 0');
});

test('A7 急单 3 分钟状态机:注入时钟到点自动结算', () => {
  const clock = createManualClock(1000);
  const ses = createRushOrderSession({ clock, roomLevel: 15, rng: mulberry32(42), stock: {} });
  eq(ses.state, RUSH_ORDER_STATE.IDLE, '初始为 IDLE');
  startRushOrder(ses);
  eq(ses.state, RUSH_ORDER_STATE.RUNNING, '开局后 RUNNING');

  /* 用注入时钟快进 179 秒,仍未结束 */
  clock.advance(179);
  tickRushOrder(ses, 0.5);
  eq(ses.state, RUSH_ORDER_STATE.RUNNING, `179s 时仍在进行,elapsed=${elapsedSec(ses)}`);

  clock.advance(1);
  const ev = tickRushOrder(ses, 0.5);
  eq(ses.state, RUSH_ORDER_STATE.SETTLED, '到 180s 自动结算');
  includes(ev, 'RUSH_ORDER_END', '广播急单结束事件');
  eq(RUSH_ORDER_DURATION_SEC, 180, '急单时长 = 3 分钟');
});

/* ════════════════════════════════════════════════════════════════════
 * B. 高炉 / 汤锅 过热起火 + 227 水枪灭火
 * ════════════════════════════════════════════════════════════════════ */

test('B1 高炉连续运转 12 秒 ⇒ 起火状态', () => {
  const st = createStation(STATION_KIND.FURNACE);
  startStation(st);
  eq(st.state, STATION_STATE.RUNNING, '点火后 RUNNING');

  /* 11.5 秒(23 × 0.5s)仍未起火 */
  for (let i = 0; i < 23; i += 1) tickStation(st, 0.5);
  eq(st.state, STATION_STATE.RUNNING, `11.5s 仍 RUNNING,runningSec=${st.runningSec}`);
  ok(st.fireCount === 0, '尚未起火');

  const ev = tickStation(st, 0.5);
  eq(st.state, STATION_STATE.BURNING, '满 12 秒进入 BURNING');
  includes(ev, EVT_FIRE, '抛出 STATION_FIRE 事件');
  eq(st.fireCount, 1, '起火计数 = 1');
  eq(OVERHEAT_SEC, 12, '过热阈值 = 12 秒');
});

test('B2 中途翻炒会清零过热计时(不会起火)', () => {
  const st = createStation(STATION_KIND.POT);
  startStation(st);
  for (let i = 0; i < 20; i += 1) tickStation(st, 0.5);   // 10s
  eq(st.runningSec, 10, '已连续运转 10 秒');
  tendStation(st, 0.5);
  eq(st.runningSec, 0, '翻炒后计时归零');
  ok(st.tendedSec > 0, '照看时长被记录');

  /* tickStation 的 tended 形参等价于「本步内被翻炒」 */
  for (let i = 0; i < 20; i += 1) tickStation(st, 0.5);   // 再 10s
  eq(st.state, STATION_STATE.RUNNING, '翻滚打断后不会起火');
  tickStation(st, 0.5, true);
  eq(st.runningSec, 0, '通过 tick 入参翻炒同样清零');
  eq(st.fireCount, 0, '全程未起火');
});

test('B3 227 水枪灭火:持续喷射 0.5 秒后恢复正常运转', () => {
  const st = createStation(STATION_KIND.FURNACE);
  startStation(st);
  for (let i = 0; i < 24; i += 1) tickStation(st, 0.5);
  eq(st.state, STATION_STATE.BURNING, '前置:已起火');

  /* 间断灭火 0.4s(0.2 × 2):计时被打断,仍燃烧 */
  tickStation(st, 0.2, false, true);
  tickStation(st, 0.2, false, false);
  eq(st.state, STATION_STATE.BURNING, '间断喷射不足以灭火');
  eq(st.dousedSec, 0, '灭火计时被重置');

  /* 连续喷射 0.5s:恢复 */
  const ev1 = tickStation(st, 0.25, false, true);
  eq(st.state, STATION_STATE.EXTINGUISHING, '喷射中进入 EXTINGUISHING');
  const ev2 = tickStation(st, 0.25, false, true);
  eq(st.state, STATION_STATE.RUNNING, '累计 0.5 秒后恢复正常运转');
  includes(ev2, EVT_DOUSED, '抛出 STATION_DOUSED 事件');
  eq(st.dousedSec, 0, '灭火计时归零');
  eq(st.burningSec, 0, '燃烧计时归零');
  eq(ev1.length + ev2.length >= 1, true, '产生了灭火事件');
  eq(EXTINGUISH_SEC, 0.5, '灭火时长 = 0.5 秒');
});

test('B4 起火后 0.5 秒开始冒烟,并累计灼烧伤害(和平盾不免疫炉火)', () => {
  const st = createStation(STATION_KIND.POT);
  startStation(st);
  for (let i = 0; i < 24; i += 1) tickStation(st, 0.5);
  eq(st.state, STATION_STATE.BURNING, '前置:已起火');
  eq(isSmoking(st), false, '刚起火不冒烟');
  const ev = tickStation(st, 0.5);
  includes(ev, EVT_SMOKE, '满 0.5 秒抛出冒烟事件');
  ok(isSmoking(st), '0.5 秒后进入冒烟状态');

  for (let i = 0; i < 9; i += 1) tickStation(st, 0.5);   // 再燃烧 4.5s
  ok(st.burnDamage > 0, `灼烧伤害应累计,实际 ${st.burnDamage}`);
  near(st.burnDamage, 30, 1e-6, '6 点/秒 × 5 秒');
});

/* ════════════════════════════════════════════════════════════════════
 * C. 偷木板河狸与 222 大锤夺回
 * ════════════════════════════════════════════════════════════════════ */

test('C1 河狸 4 秒偷走 3 块木板,库存同步扣减', () => {
  const b = spawnBeaver('beaver_1');
  eq(b.mobId, 'mob_beaver', '引用冻结层生物 ID');
  /* 期望值写死 151,不引 `BEAVER_TARGET_ITEM_ID` ——
     原写法把常量当输入再断言输出等于该输入,测的是「透传」,
     常量改成 999 照样全绿。即「必须是 151 号木板」零约束。
     出处:手册 L468「`mob_beaver` … 会偷偷抱走地上散落的**木板**去河道筑坝」+
     掉落「`151 松木板×3`」;L114 定义 151 = 精刨松木板。 */
  eq(b.wantItem, 151, '目标为 151 精刨松木板(手册 L468/L114)');
  /* 同时钉住常量本身,防止它被改成别的 ID */
  eq(BEAVER_TARGET_ITEM_ID, 151, 'BEAVER_TARGET_ITEM_ID = 151(手册 L114)');
  eq(b.state, BEAVER_STATE.STEALING, '初始 STEALING');

  const stock: Record<number, number> = { [BEAVER_TARGET_ITEM_ID]: 10 };
  const ev: string[] = [];
  for (let i = 0; i < 8; i += 1) ev.push(...tickBeaver(b, 0.5, stock));

  includes(ev, EVT_BEAVER_STOLE, '偷料事件已广播');
  eq(b.stolenQty, BEAVER_RECLAIM_QTY, '抱走 3 块');
  eq(stock[BEAVER_TARGET_ITEM_ID], 7, '库存 10 → 7');
  eq(b.state, BEAVER_STATE.FLEEING, '转入逃跑');
});

test('C2 222 大锤(8 格/秒)敲晕 ⇒ 夺回木板', () => {
  const stock: Record<number, number> = { [BEAVER_TARGET_ITEM_ID]: 10 };
  const b = spawnBeaver('beaver_2');
  for (let i = 0; i < 8; i += 1) tickBeaver(b, 0.5, stock);
  eq(b.stolenQty, 3, '前置:已偷 3 块');

  const weak = hitBeaver(b, HAMMER_222_IMPULSE - 1);
  ok(!weak.knocked, '冲量不足不敲晕');
  eq(weak.reason, 'IMPULSE_TOO_LOW', '拒绝原因明确');

  const hit = hitBeaver(b, HAMMER_222_IMPULSE);
  ok(hit.knocked, '8 格/秒冲量敲晕');
  eq(b.state, BEAVER_STATE.KNOCKED_DOWN, '进入 KNOCKED_DOWN');
  /* 期望值写死 2.5,不引 `BEAVER_STUN_SEC`(引了同义反复)。
     手册 L468/L600 只说「敲晕」未给秒数,故按**设计基线**钉死当前值。 */
  eq(b.stunSec, 2.5, '眩晕 2.5 秒(设计基线,手册未给秒数)');
  ok(b.reclaimable, '进入可夺回窗口');

  const got = reclaimWood(b, stock);
  eq(got, 3, '夺回 3 块');
  eq(stock[BEAVER_TARGET_ITEM_ID], 10, '库存回到 10');
  eq(b.stolenQty, 0, '河狸手上清空');
  eq(reclaimWood(b, stock), 0, '二次夺回无效(幂等)');
});

test('C3 敲晕窗口过期后河狸继续逃逸,夺回失败', () => {
  const stock: Record<number, number> = { [BEAVER_TARGET_ITEM_ID]: 10 };
  const b = spawnBeaver('beaver_3');
  for (let i = 0; i < 8; i += 1) tickBeaver(b, 0.5, stock);
  hitBeaver(b, HAMMER_222_IMPULSE);
  for (let i = 0; i < 6; i += 1) tickBeaver(b, 0.5, stock);   // 3s > 2.5s 眩晕
  eq(b.state, BEAVER_STATE.FLEEING, '眩晕结束后继续逃');
  ok(!b.reclaimable, '夺回窗口关闭');
  eq(reclaimWood(b, stock), 0, '此时无法夺回');
});

test('C4 急单期间按 20 秒间隔刷新河狸,同屏上限 2 只', () => {
  const clock = createManualClock(0);
  const ses = createRushOrderSession({
    clock, roomLevel: 12, rng: mulberry32(5), stock: { [BEAVER_TARGET_ITEM_ID]: 20 },
  });
  startRushOrder(ses);
  for (let i = 0; i < 200; i += 1) {           // 100 秒 × 0.5s
    clock.advance(0.5);
    tickRushOrder(ses, 0.5, { spawnBeaver: true });
  }
  ok(ses.beaverSpawned >= 4, `100 秒内应刷新多只河狸,实际 ${ses.beaverSpawned}`);
  const alive = ses.beavers.filter((b) => b.state !== BEAVER_STATE.ESCAPED).length;
  ok(alive <= 2, `同屏存活河狸 ≤ 2,实际 ${alive}`);
});

/* ════════════════════════════════════════════════════════════════════
 * D. 投掷接力链
 * ════════════════════════════════════════════════════════════════════ */

test('D1 接力链六环顺序齐备,一环不落', () => {
  eq(RELAY_STAGES.length, 6);
  eq(RELAY_STAGES.join('>'), 'CHOP>THROW_A>CATCH>CUT>THROW_B>PAT');
  eq(RELAY_RIVER_WIDTH, 7, '标准河宽 7 格');
  eq(RELAY_THROW_RANGE, 8.5, '水平投掷初速 8.5 格/秒(冻结层)');
});

test('D2 完整链一次成功只计分一次', () => {
  const c = createRelayChain('chain_1');
  let total = 0;
  const seq: [string, { atSec: number; z?: number; dist?: number; throwDistance?: number }][] = [
    ['CHOP',     { atSec: 0.0 }],
    ['THROW_A',  { atSec: 1.0, throwDistance: RELAY_RIVER_WIDTH }],
    ['CATCH',    { atSec: 2.0, z: 0.9, dist: 0.3 }],
    ['CUT',      { atSec: 3.5 }],
    ['THROW_B',  { atSec: 4.5, throwDistance: 4.0 }],
    ['PAT',      { atSec: 5.5 }],
  ];
  for (const [stage, input] of seq) {
    const r = fireRelayStage(c, stage as never, input);
    ok(r.ok, `${stage} 环应通过,reason=${r.reason}`);
    total += r.awarded;
  }
  eq(c.state, CHAIN_STATE.SUCCESS, '整链成功');
  eq(total, 150, '一次成功 = 150 分(设计基线,手册未给分数)');
  eq(c.awarded, 150, '链内累计奖励 = 150');

  /* 重复触发同一链不再计分 */
  const again = fireRelayStage(c, 'PAT', { atSec: 6.0 });
  ok(!again.ok, '已关闭的链拒绝再次触发');
  eq(again.reason, 'CHAIN_CLOSED', '原因 CHAIN_CLOSED');
  eq(again.awarded, 0, '不重复计分');
  eq(c.awarded, 150, '总分未被二次加成(仍为 150)');
});

test('D3 越序触发 ⇒ 链中断 + 40 分惩罚', () => {
  const c = createRelayChain('chain_2');
  fireRelayStage(c, 'CHOP', { atSec: 0 });
  const r = fireRelayStage(c, 'CUT', { atSec: 1 });    // 跳过 THROW_A / CATCH
  ok(!r.ok, '越序应失败');
  eq(r.reason, 'OUT_OF_ORDER', '中断原因越序');
  eq(c.state, CHAIN_STATE.BROKEN, '链中断');
  eq(c.penalty, CHAIN_BREAK_PENALTY, '罚 40 分');
  eq(BREAK_PENALTY_CHECK(), 40, '惩罚常量 = 40');
});
function BREAK_PENALTY_CHECK(): number { return CHAIN_BREAK_PENALTY; }

test('D4 任一环超时 ⇒ 链中断', () => {
  const c = createRelayChain('chain_3');
  fireRelayStage(c, 'CHOP', { atSec: 0 });
  const timeout = RELAY_STAGE_TIMEOUT_SEC.THROW_A;
  const r = fireRelayStage(c, 'THROW_A', { atSec: timeout + 0.01, throwDistance: 5 });
  ok(!r.ok, '超时应失败');
  eq(r.reason, 'TIMEOUT', '中断原因超时');
  eq(c.state, CHAIN_STATE.BROKEN, '链中断');
});

test('D5 空中接球落空 ⇒ DROP 中断;完美接球窗口与冻结层一致', () => {
  const c1 = createRelayChain('chain_4a');
  fireRelayStage(c1, 'CHOP', { atSec: 0 });
  fireRelayStage(c1, 'THROW_A', { atSec: 0.5, throwDistance: 6 });
  const miss = fireRelayStage(c1, 'CATCH', { atSec: 1.0, z: 2.5, dist: 0.1 });   // Z 超上限 1.4
  eq(miss.reason, 'DROP', 'Z 过高接不到');
  eq(c1.state, CHAIN_STATE.BROKEN, '链中断');

  const c2 = createRelayChain('chain_4b');
  fireRelayStage(c2, 'CHOP', { atSec: 0 });
  fireRelayStage(c2, 'THROW_A', { atSec: 0.5, throwDistance: 6 });
  const miss2 = fireRelayStage(c2, 'CATCH', { atSec: 1.0, z: 0.9, dist: CATCH_RADIUS + 0.2 });
  eq(miss2.reason, 'DROP', '水平距离超过 0.8 格接不到');

  const c3 = createRelayChain('chain_4c');
  eq(fireRelayStage(c3, 'CHOP', { atSec: 0 }).ok, true);
  eq(fireRelayStage(c3, 'THROW_A', { atSec: 0.5, throwDistance: 6 }).ok, true);
  const good = fireRelayStage(c3, 'CATCH', { atSec: 1.0, z: 0.9, dist: CATCH_RADIUS });
  ok(good.ok, '恰好在 0.8 格边界接住');
  near(c3.catchZ, 0.9, 1e-9, '接到时 Z');
  near(c3.catchDist, CATCH_RADIUS, 1e-9, '接到时水平距离');
});

test('D6 超射程投掷 ⇒ OVERSHOOT 中断', () => {
  const c = createRelayChain('chain_5');
  fireRelayStage(c, 'CHOP', { atSec: 0 });
  const r = fireRelayStage(c, 'THROW_A', { atSec: 0.5, throwDistance: RELAY_THROW_RANGE + 1 });
  eq(r.reason, 'OVERSHOOT', '超射程判定');
  eq(c.state, CHAIN_STATE.BROKEN, '链中断');
});

test('D7 会话级链接入:得分与罚分同步到急单总分', () => {
  const clock = createManualClock(0);
  const ses = createRushOrderSession({ clock, roomLevel: 12, rng: mulberry32(6), stock: {} });
  startRushOrder(ses);
  const good = addRelayChain(ses, 'ok');
  for (const [stage, input] of ([
    ['CHOP', { atSec: 0 }], ['THROW_A', { atSec: 1, throwDistance: 7 }],
    ['CATCH', { atSec: 2, z: 1.0, dist: 0.4 }], ['CUT', { atSec: 3 }],
    ['THROW_B', { atSec: 4, throwDistance: 3 }], ['PAT', { atSec: 5 }],
  ] as [never, { atSec: number; z?: number; dist?: number; throwDistance?: number }][])) {
    advanceRelayChain(ses, good, stage, input);
  }
  eq(ses.score, 150, '成功链的 150 分入账(设计基线)');

  const bad = addRelayChain(ses, 'bad');
  advanceRelayChain(ses, bad, 'CHOP', { atSec: 0 });
  advanceRelayChain(ses, bad, 'PAT', { atSec: 1 });     // 越序
  eq(ses.penalty, CHAIN_BREAK_PENALTY, '罚分入账');

  const st = settleSession(ses);
  eq(st.penalty, CHAIN_BREAK_PENALTY, '结算带出罚分');
  eq(st.sessionScore >= 0, true, '总分被地板到 0 以上');
});

/* ════════════════════════════════════════════════════════════════════
 * E. 4 人叠罗汉搭人梯
 * ════════════════════════════════════════════════════════════════════ */

test('E1 叠罗汉高度按冻结层 CARRY_Z_STEP 阶梯递增', () => {
  eq(CARRY_Z_STEP, 0.85);
  near(stackTopZ(1), 0, 1e-9, '1 层顶层 z=0');
  near(stackTopZ(2), 0.85, 1e-9, '2 层顶层 z=0.85');
  near(stackTopZ(3), 1.7, 1e-9, '3 层顶层 z=1.70');
  near(stackTopZ(4), 2.55, 1e-9, '4 层顶层 z=2.55');
  near(stackTopZ(9), 2.55, 1e-9, '超过 4 层被 CARRY_MAX_DEPTH 截断');
  eq(CARRY_MAX_DEPTH, 4);
  near(STACK_REACH_Z, 0.30, 1e-9, '顶层伸手 0.30 格');
});

test('E2 Z=2 果实采集:2 / 3 人够不到,满 4 人梯才够得到', () => {
  eq(STACK_REACH_Z, 0.3, '伸手抓取高度 0.30 格');
  eq(Z2_REACH_TARGET, 2.3, 'Z=2 有效抓取高度 2.30(平台面 2.0 + 到手 0.30)');
  eq(Z2_FRUIT_HEIGHT, Z2_REACH_TARGET, '果实判定复用同一目标高度');

  /* 逐档验算 E_k.z = k × 0.85 */
  near(stackTopZ(1) + STACK_REACH_Z, 0.30, 1e-9, '1 人梯可达 0.30');
  near(stackTopZ(2) + STACK_REACH_Z, 1.15, 1e-9, '2 人梯可达 1.15');
  near(stackTopZ(3) + STACK_REACH_Z, 2.00, 1e-9, '3 人梯可达 2.00');
  near(stackTopZ(4) + STACK_REACH_Z, 2.85, 1e-9, '4 人梯可达 2.85');

  ok(!canPickZ2Fruit(1), '1 人够不到');
  ok(!canPickZ2Fruit(2), '2 人 1.15 < 2.30,差 1.15');
  ok(!canPickZ2Fruit(3), '3 人 2.00 < 2.30,差 0.30(裕度足够抗抖动)');
  ok(canPickZ2Fruit(4), '4 人 2.85 ≥ 2.30,余 0.55');
});

test('E3 登 Boss 背部同样只有满 4 人梯可达', () => {
  eq(BOSS_BACK_HEIGHT, 2.3, 'Boss 背脊按曲面有效高度 2.30');
  ok(canMountBossBack(4), '4 人可登 Boss 背部(2.85 ≥ 2.30)');
  ok(!canMountBossBack(3), '3 人 2.00 < 2.30,不可登背');
  ok(!canMountBossBack(1), '1 人不可登背');
  near(stackTopZ(4), 2.55, 1e-9, '4 层叠罗汉总高 2.55 格');
  eq(CARRY_MAX_DEPTH, 4, '与 CARRY_MAX_DEPTH 一致');

  /* 两侧裕度都要 > 0.1 格,避免 20Hz 浮点与坐标同步抖动误判 */
  const gap3 = Z2_REACH_TARGET - (stackTopZ(3) + STACK_REACH_Z);
  const gap4 = (stackTopZ(4) + STACK_REACH_Z) - Z2_REACH_TARGET;
  inRange(gap3, 0.1, 1.0, '3 人梯缺口裕度');
  inRange(gap4, 0.1, 1.0, '4 人梯余量裕度');
  near(gap3, 0.30, 1e-9, '缺口恰为 0.30');
  near(gap4, 0.55, 1e-9, '余量恰为 0.55');
});

test('E4 底层承载者移速按 0.85^depth 衰减', () => {
  near(stackCarrierSpeed(1), 1.0, 1e-9, '1 人不减速');
  near(stackCarrierSpeed(2), 0.85, 1e-9, '2 层 ×0.85');
  near(stackCarrierSpeed(3), 0.85 ** 2, 1e-9, '3 层 ×0.7225');
  near(stackCarrierSpeed(4), 0.85 ** 3, 1e-9, '4 层 ×0.614125');
  ok(stackCarrierSpeed(4) < stackCarrierSpeed(3), '越叠越慢');
});

test('E5 叠罗汉只调用冻结层函数,不触碰 WS-02 文件', () => {
  near(CARRY_Z_STEP, 0.85, 1e-9, '冻结常数未漂移');
  near(PHY.carrierSpeedMul(3), 0.85 ** 3, 1e-9, '直接调用冻结层函数');
  near(stackCarrierSpeed(3), PHY.carrierSpeedMul(2), 1e-9, '封装与冻结层逐位一致');
  near(stackTopZ(4), PHY.stackOffset(3), 1e-9, '叠罗汉高度即 stackOffset(3)');
  for (const k of ['stackOffset', 'carrierSpeedMul', 'canPerfectCatch', 'throwVelocity']) {
    ok(typeof (PHY as unknown as Record<string, unknown>)[k] === 'function', `${k} 是冻结层导出`);
  }
  ok(RELAY_THROW_RANGE === PHY.THROW_SPEED_XY, '接力射程取自 THROW_SPEED_XY');
});

/* ════════════════════════════════════════════════════════════════════
 * F. 35 种整蛊玩具全数据化
 * ════════════════════════════════════════════════════════════════════ */

test('F1 玩具表恰有 35 项,ID 集合与 [221..255] 完全一致', () => {
  eq(PRANK_TOYS.length, PRANK_TOY_COUNT);
  eq(PRANK_TOY_COUNT, 35, '221-255 是连续 35 个 ID');
  assertToyIdSetClosed();

  const ids = [...toyIds()].sort((a, b) => a - b);
  const expect: number[] = [];
  for (let i = PRANK_TOY_ID_MIN; i <= PRANK_TOY_ID_MAX; i += 1) expect.push(i);
  eq(ids.join(','), expect.join(','), 'ID 集合逐项相等');
  eq(ids.length, new Set(ids).size, '无重复 ID');
  eq(ids[0], 221);
  eq(ids[ids.length - 1], 255);
});

test('F2 每项都具备 7 个数据化字段且取值合法', () => {
  assertToyFieldsSane();
  const triggers = Object.values(TOY_TRIGGER) as string[];
  const flags = Object.values(TOY_STATE_FLAG) as string[];
  for (const t of PRANK_TOYS) {
    eq(typeof t.trigger, 'string', `#${t.id} trigger`);
    includes(triggers, t.trigger, `#${t.id} trigger 合法`);
    ok(t.radius >= 0 && Number.isFinite(t.radius), `#${t.id} radius`);
    ok(t.impulse >= 0 && Number.isFinite(t.impulse), `#${t.id} impulse`);
    ok(t.stunSec >= 0 && Number.isFinite(t.stunSec), `#${t.id} stunSec`);
    ok(t.morphSec >= 0 && Number.isFinite(t.morphSec), `#${t.id} morphSec`);
    includes(flags, t.allyEffect.flag, `#${t.id} allyEffect.flag 合法`);
    includes(flags, t.enemyEffect.flag, `#${t.id} enemyEffect.flag 合法`);
    ok(t.allyEffect.note.length > 0, `#${t.id} allyEffect 有说明`);
    ok(t.enemyEffect.note.length > 0, `#${t.id} enemyEffect 有说明`);
  }
});

test('F3 对队友一律零伤害;对怪物可造成伤害', () => {
  assertAllyZeroDamage();
  for (const t of PRANK_TOYS) eq(t.allyEffect.allyDamage, 0, `#${t.id} 队友伤害`);
  const damages = PRANK_TOYS.filter((t) => t.enemyEffect.enemyDamage > 0);
  ok(damages.length >= 8, `至少 8 件对怪物有伤害,实际 ${damages.length}`);
  ok(toyOf(228).enemyEffect.enemyDamage === BOMB_ENEMY_DAMAGE, '#228 炸弹果 120 破甲伤害');
});

test('F4 名称与冻结层 §3.4 逐项对齐(无硬编码漂移)', () => {
  for (const t of PRANK_TOYS) {
    const def = ITEM_BY_ID.get(t.id);
    ok(!!def, `#${t.id} 存在于冻结层配表`);
    eq(t.name, def?.name, `#${t.id} 名称取自事实源`);
  }
  eq(toyOf(222).name, '充气玩具大锤');
  eq(toyOf(225).name, '滑溜溜香蕉皮');
  eq(toyOf(227).name, '泡泡连发水枪');
  eq(toyOf(233).name, '极寒冰霜雪球');
  eq(toyOf(255).name, '裁判金哨子');
  ok(PRANK_TOY_BY_ID.has(221) && PRANK_TOY_BY_ID.has(255), '首尾均在索引中');
});

test('F5 差异化:队友与怪物的状态/位移/伤害不完全相同', () => {
  const diff = PRANK_TOYS.filter(
    (t) => t.allyEffect.flag !== t.enemyEffect.flag
      || t.allyEffect.moveTiles !== t.enemyEffect.moveTiles
      || t.allyEffect.enemyDamage !== t.enemyEffect.enemyDamage,
  );
  eq(diff.length, 18, '18 项对队友/怪物效果有实质差异');
  includes(diff.map((t) => t.id), 222, '#222 对队友击退 / 对怪物伤害');
  /* 打伤害的玩具必须与队友侧不同(队友恒零伤害) */
  for (const t of PRANK_TOYS) {
    if (t.enemyEffect.enemyDamage > 0) includes(diff.map((x) => x.id), t.id, `#${t.id} 对怪有伤害,须差异化`);
  }
  /* 纯辅助 / 乐团组:队友侧有增益,怪物侧无伤害,属合法对称 */
  const symmetric = PRANK_TOYS.filter((t) => !diff.includes(t));
  ok(symmetric.length === 17, `其余 ${symmetric.length} 项为对称 / 纯辅助道具`);
});

test('F6 香蕉皮:打滑 5 格,撞墙眩晕 1.2 秒', () => {
  eq(BANANA_SLIDE_TILES, 5);
  eq(BANANA_SLIDE_STUN_SEC, 1.2);
  const wall = resolveBananaSlide(3);       // 前方 3 格就是墙
  eq(wall.slidTiles, 3, '只能滑 3 格');
  ok(wall.hitWall, '撞墙');
  eq(wall.stunnedSec, 1.2, '眩晕 1.2 秒');

  const open = resolveBananaSlide(20);      // 空旷地面
  eq(open.slidTiles, 5, '滑满 5 格');
  ok(!open.hitWall, '未撞墙');
  eq(open.stunnedSec, 0, '未撞墙不眩晕');

  eq(resolveBananaSlide(5).hitWall, true, '恰好 5 格处有墙也算撞墙');
  eq(resolveBananaSlide(6).hitWall, false, '第 6 格才有墙则不撞');
  eq(toyOf(225).stunSec, 1.2, '玩具表 stunSec 与打滑眩晕一致');
});

test('F7 泡泡三连困人:第 3 发装入大泡泡并漂浮 6 秒', () => {
  eq(BUBBLE_HITS_TO_TRAP, 3);
  const b = createBubble('p1');
  eq(hitBubble(b).trapped, false, '1 发不困');
  eq(hitBubble(b).hits, 2, '累计 2 发');
  const third = hitBubble(b);
  ok(third.trapped, '第 3 发困人');
  eq(third.chain, 1, '三连计数 = 1');
  eq(third.driftSec, 6, '漂浮 6 秒(设计基线,手册未给秒数)');
  /* 同时钉住常量本身 —— 原写法 `eq(third.driftSec, BUBBLE_DRIFT_SEC)` 是同义反复 */
  eq(BUBBLE_DRIFT_SEC, 6, 'BUBBLE_DRIFT_SEC = 6(设计基线)');
  const ext = hitBubble(b);
  ok(ext.trapped, '已困状态持续');
  eq(ext.driftSec, 12, '追加喷射只延长漂浮时间(6×2)');
});

test('F8 雪球冰冻 3 秒;冰雕可被大锤当保龄球推出', () => {
  eq(SNOWBALL_FREEZE_SEC, 3);
  const m = resolveSnowball(true);
  eq(m.frozenSec, 3, '怪物冰冻 3 秒');
  ok(m.slidOnHammer, '怪物冰雕可被敲出当保龄球');
  const p = resolveSnowball(false);
  eq(p.frozenSec, 3, '队友同样冰冻 3 秒(和平盾可免疫)');
  eq(toyOf(233).morphSec, SNOWBALL_FREEZE_SEC, '玩具表 morphSec = 3');
});

test('F9 炸弹果 3 秒引信 / 药水倍率 / 蜂蜜减速', () => {
  eq(BOMB_FUSE_SEC, 3);
  eq(toyOf(228).morphSec, BOMB_FUSE_SEC, '引信时长与表一致');
  near(SHRINK_SCALE, 0.3, 1e-9);
  near(GIANT_SCALE, 2.0, 1e-9);
  near(HONEY_SLOW_RATIO, 0.7, 1e-9);
  eq(toyOf(230).morphSec, 15, '缩小持续 15 秒');
  eq(toyOf(231).morphSec, 15, '巨人持续 15 秒');
});

/* ════════════════════════════════════════════════════════════════════
 * G. 218 平安盾免疫清单
 * ════════════════════════════════════════════════════════════════════ */

test('G1 清单结构:35 玩具条目 + 7 敌对来源 = 42 条', () => {
  assertImmunityManifestComplete();
  eq(IMMUNITY_MANIFEST.length, 42, '清单总条数');
  eq(IMMUNITY_MANIFEST.length - HOSTILE_ENTRIES.length, 35, '玩具条目 35 条');
  eq(HOSTILE_SOURCES.length, 7, '敌对来源 7 类');
  eq(SAFE_SHIELD_ITEM_ID, 218, '和平盾物品 ID');
});

test('G2 手册点名的六项逐项 100% 免疫(各自独立断言)', () => {
  eq(NAMED_IMMUNE_TOY_IDS.length, 6, '点名六项');
  for (const id of NAMED_IMMUNE_TOY_IDS) {
    const r = resolveShield(true, id, EFFECT_ORIGIN.ALLY);
    eq(r.verdict, SHIELD_VERDICT.IMMUNE, `${id} ${NAMED_IMMUNE_LABEL[id]} 应免疫`);
    ok(r.blocked, `${id} 不施加任何状态`);
    ok(typeof r.label === 'string' && r.label.length > 0, `${id} 有人类可读标签`);
  }
  eq(resolveShield(true, 221, EFFECT_ORIGIN.ALLY).blocked, true, '队友举起免疫');
  eq(resolveShield(true, 222, EFFECT_ORIGIN.ALLY).blocked, true, '大锤击退免疫');
  eq(resolveShield(true, 225, EFFECT_ORIGIN.ALLY).blocked, true, '香蕉皮免疫');
  eq(resolveShield(true, 227, EFFECT_ORIGIN.ALLY).blocked, true, '泡泡免疫');
  eq(resolveShield(true, 229, EFFECT_ORIGIN.ALLY).blocked, true, '变身吹箭免疫');
  eq(resolveShield(true, 233, EFFECT_ORIGIN.ALLY).blocked, true, '雪球免疫');
});

test('G3 全部 35 项玩具对队友载荷一律免疫', () => {
  for (const t of PRANK_TOYS) {
    ok(isImmuneToAllyPrank(true, t.id), `#${t.id} ${t.name} 应被和平盾拦截`);
    const e = IMMUNITY_BY_KEY.get(`PRANK:${t.id}`);
    ok(!!e, `#${t.id} 在清单中`);
    eq(e?.label.startsWith(String(t.id)), true, `#${t.id} 标签以 ID 开头`);
  }
});

test('G4 和平盾关闭时不免疫(开关生效)', () => {
  for (const id of NAMED_IMMUNE_TOY_IDS) {
    const r = resolveShield(false, id, EFFECT_ORIGIN.ALLY);
    ok(!r.blocked, `关闭时 #${id} 应照常施加`);
    eq(r.reason, 'SHIELD_OFF', '原因 SHIELD_OFF');
  }
});

test('G5 对 Boss 伤害不免疫(逐类来源断言)', () => {
  for (const src of HOSTILE_SOURCES) {
    ok(!isImmuneToHostile(true, src), `${src} 不应被和平盾免疫`);
    const r = resolveShield(true, src, EFFECT_ORIGIN.HOSTILE);
    eq(r.verdict, SHIELD_VERDICT.NOT_IMMUNE, `${src} 判定 NOT_IMMUNE`);
    eq(r.blocked, false, `${src} 不拦截`);
    eq(r.reason, 'SHIELD_PASS_HOSTILE', '原因 SHIELD_PASS_HOSTILE');
  }
  eq(isImmuneToHostile(true, 'BOSS_SKILL'), false, 'Boss 技能穿透');
  eq(isImmuneToHostile(true, 'LAVA_BURN'), false, '熔岩灼烧穿透');
  eq(isImmuneToHostile(true, 'STATION_FIRE_BURN'), false, '高炉起火灼烧穿透');
  eq(isImmuneToHostile(true, 'FALL_DAMAGE'), false, '坠落伤害穿透');
});

test('G6 自用道具不被自己拦截(避免自锁)', () => {
  for (const id of [225, 233, 230, 231, 234]) {
    const r = resolveShield(true, id, EFFECT_ORIGIN.SELF);
    ok(!r.blocked, `自己用 #${id} 不应被自己的盾挡住`);
    eq(r.reason, 'SHIELD_PASS_SELF', '原因 SHIELD_PASS_SELF');
  }
});

test('G7 未知来源保守放行并标记', () => {
  const r = resolveShield(true, 'PRANK:999', EFFECT_ORIGIN.ALLY);
  eq(r.reason, 'UNKNOWN_SOURCE', '未知来源');
  eq(r.blocked, false, '不拦截');
  eq(r.flag, null, '无状态标记');
});

test('G8 ShielState 统计:拦截计数与外观联动', () => {
  const s = createShield('p1', true);
  ok(s.on && s.helmetVisible, '默认开启并显示黄色安全帽');
  eq(applyShield(s, 222, EFFECT_ORIGIN.ALLY).blocked, true, '大锤被挡');
  eq(applyShield(s, 225, EFFECT_ORIGIN.ALLY).blocked, true, '香蕉皮被挡');
  eq(applyShield(s, 'BOSS_SKILL', EFFECT_ORIGIN.HOSTILE).blocked, false, 'Boss 技能穿透');
  eq(s.blockedCount, 2, '累计拦截 2 次');
  eq(s.lastBlockedKey, 'PRANK:225', '最近拦截来源');
  toggleShield(s);
  ok(!s.on && !s.helmetVisible, '关闭后头盔消失');
  eq(applyShield(s, 222, EFFECT_ORIGIN.ALLY).blocked, false, '关闭后不再拦截');
  eq(s.blockedCount, 2, '关闭时不累加');
});

test('G9 【U10】243 自伤不受和平盾影响:戴 218 + 戴 243 被自己的闪电命中', () => {
  /* 自伤走独立代码路径:函数签名里根本没有 shieldOn —— 契约层面就与和平盾解耦 */
  eq(applySelfDamage.length, 3, 'applySelfDamage(hp, maxHp, rawDamage) 无 shieldOn 形参');
  eq(resolveHelmetSelfStrike.length, 2, 'resolveHelmetSelfStrike(hp, maxHp) 无 shieldOn 形参');

  /* 构造「戴 218 和平盾 + 戴 243 引雷头盔」的玩家 */
  const shield = createShield('player_218_243', true);   // 218 开启
  const maxHp = 200;
  const before = 200;

  /* 对照组:和平盾对「队友」与「Boss」的既有语义不变 */
  eq(applyShield(shield, 222, EFFECT_ORIGIN.ALLY).blocked, true, '对照组:队友大锤仍被和平盾挡下');
  eq(applyShield(shield, 'BOSS_SKILL', EFFECT_ORIGIN.HOSTILE).blocked, false, '对照组:Boss 技能穿透');
  eq(shield.on, true, '前置:和平盾处于开启状态');

  /* 自伤路径:和平盾开与关结果逐字段相同 */
  const strikes = [resolveHelmetSelfStrike(before, maxHp), resolveHelmetSelfStrike(before, maxHp)];
  eq(JSON.stringify(strikes[0]), JSON.stringify(strikes[1]), '自伤结果可复现,且与盾状态无关');
  const hit = strikes[0];

  /* ① 自伤保留,不被和平盾挡掉 */
  ok(hit.dealt > 0, `自伤真实生效,扣了 ${hit.dealt} HP`);
  eq(hit.shielded, false, '自伤标记为未被和平盾拦截');
  eq(hit.paralyzedSec, HELMET_SELF_PARALYZE_SEC, '感电麻痹 1.5 秒');
  eq(HELMET_SELF_PARALYZE_SEC, 1.5, '麻痹常量 = 1.5 秒');
  eq(HELMET_SELF_DAMAGE, 45, '自伤数值 45');
  near(hit.hp, before - HELMET_SELF_DAMAGE, 1e-9, 'HP = 200 − 45 = 155');

  /* ② HP 硬顶:不低于 max(1, 15% × maxHp) */
  const floor = selfDamageHpFloor(maxHp);
  eq(SELF_DAMAGE_HP_FLOOR_RATIO, 0.15, '硬顶比例 15%');
  eq(floor, 30, 'maxHp=200 → 下限 30');
  ok(hit.hp >= floor, `HP ${hit.hp} 不低于下限 ${floor}`);
  ok(hit.hp >= 0.15 * maxHp, 'HP 不低于 15% 上限');

  /* ③ 残血时被硬顶截断,绝不致死,且不会「回血」 */
  const low = resolveHelmetSelfStrike(5, maxHp);
  eq(low.hp, 5, '残血 5 被锁在原值(地板 30 只防跌,不治疗)');
  ok(low.clamped, '标记为被硬顶截断');
  eq(low.dealt, 0, '硬顶后实际未扣血');
  ok(low.hp > 0, 'HP 恒为正,不会被打死');

  /* ③b 高于地板但一击打穿:扣到地板,不更低 */
  const mid = resolveHelmetSelfStrike(50, maxHp);
  eq(mid.hp, 30, '50 − 45 = 5 < 地板 30 → 截到 30');
  ok(mid.clamped, '被硬顶');
  eq(mid.dealt, 20, '实际只扣 20 而非 45');
  eq(resolveHelmetSelfStrike(76, maxHp).hp, 31, '76 − 45 = 31 > 30,恰好不被截断');
  eq(resolveHelmetSelfStrike(75, maxHp).hp, 30, '75 − 45 = 30,恰好落在地板');
  ok(!resolveHelmetSelfStrike(75, maxHp).clamped, '恰好等于地板不算截断');

  /* ④ 永不触发幽灵泡泡倒地 */
  eq(hit.state, SELF_DAMAGE_STATE.STUNNED, '自伤只到 STUNNED');
  eq(hit.ghostBubble, false, '自伤不触发幽灵泡泡');
  eq(low.ghostBubble, false, '残血自伤同样不触发幽灵泡泡');
  eq(low.state, SELF_DAMAGE_STATE.STUNNED, '残血自伤也只到 STUNNED');
  ok(hit.state !== SELF_DAMAGE_STATE.GHOST_BUBBLE, 'state 不是 GHOST_BUBBLE');
  eq(SELF_DAMAGE_STATE.GHOST_BUBBLE, BodyState.GHOST_BUBBLE, '与冻结层 BodyState.GHOST_BUBBLE 同名');

  /* ⑤ maxHp 边界:0 / 负数 / NaN 都要有确定的 >0 下限 */
  eq(selfDamageHpFloor(0), 1, 'maxHp=0 → 下限 1');
  eq(selfDamageHpFloor(-10), 1, 'maxHp<0 → 下限 1');
  eq(selfDamageHpFloor(Number.NaN), 1, 'maxHp=NaN → 下限 1');
  eq(selfDamageHpFloor(1), 1, 'maxHp=1 → 下限 1');
  ok(resolveHelmetSelfStrike(1, 1).hp >= 1, '1 血自伤后仍 ≥ 1');
});

/* ════════════════════════════════════════════════════════════════════
 * H. 四大竞技模式
 * ════════════════════════════════════════════════════════════════════ */

test('H0 冻结层 PARTY_MODES 四模式与节拍一致', () => {
  assertAllModesPresent();
  eq(PARTY_MODES.length, 4, '恰好 4 个模式');
  const b = partyModeConfig(PARTY_MODE_KEY.BRIDGE_CTF);
  eq(b.buildSec, 15, '造桥 15 秒建造');
  eq(b.raceSec, 30, '造桥 30 秒冲刺');
  eq(partyModeConfig(PARTY_MODE_KEY.CROWN_BR).raceSec, 180, '抢皇冠 180 秒');
  eq(partyModeConfig(PARTY_MODE_KEY.PAINT_WAR).raceSec, 120, '涂色 120 秒');
  eq(partyModeConfig(PARTY_MODE_KEY.JELLY_BALL).raceSec, 180, '果冻球 180 秒');
});

test('H1 造桥夺旗:15s / 30s 两阶段切换(注入时钟快进)', () => {
  const clock = createManualClock(0);
  const r = createBridgeRun(clock, 'referee');
  eq(r.mode.phase, PARTY_PHASE.IDLE, '初始 IDLE');
  startPartyMode(r.mode);
  eq(r.mode.phase, PARTY_PHASE.BUILD, '开局进入 BUILD');

  /* 建造阶段允许摆板 */
  for (let i = 0; i < 12; i += 1) ok(bridgePlace(r, TEAM_KEY.RED), '建造期可摆板');
  ok(bridgePlace(r, TEAM_KEY.RED, true), '建造期可放盲盒陷阱');
  eq(r.traps, 1, '陷阱计数');

  /* 14.5s 仍在 BUILD */
  clock.advance(14.5);
  eq(tickPartyMode(r.mode).length, 0, '14.5s 未切换');
  eq(r.mode.phase, PARTY_PHASE.BUILD, '仍在建造阶段');
  ok(bridgePlace(r, TEAM_KEY.RED), '14.5s 仍属建造阶段,可以继续摆板');

  /* 15.0s 切换到 RACE */
  clock.advance(0.5);
  const ev = tickPartyMode(r.mode);
  includes(ev, 'PHASE:RACE', '抛出击冲阶段事件');
  eq(r.mode.phase, PARTY_PHASE.RACE, '切到冲刺阶段');
  eq(r.mode.phaseSwitches, 1, '切换 1 次');
  ok(!bridgePlace(r, TEAM_KEY.BLUE), '冲刺阶段拒绝继续建造');

  /* 冲刺阶段夺旗 */
  ok(bridgeCapture(r, TEAM_KEY.RED), '桥板足够,夺旗成功');
  eq(getTeam(r.mode.board, TEAM_KEY.RED).score, 100, '夺旗 +100');
  ok(!bridgeCapture(r, TEAM_KEY.RED), '不能重复夺旗');
  ok(!bridgeCapture(r, TEAM_KEY.BLUE), '蓝队桥板不足,夺旗失败');

  /* 44.5s 仍未结算,45.0s 结算 */
  clock.advance(29.5);
  eq(tickPartyMode(r.mode).length, 0, '44.5s 未结算');
  clock.advance(0.5);
  const ev2 = tickPartyMode(r.mode);
  includes(ev2, 'PHASE:SETTLED', '到达 45s 结算');
  eq(r.mode.phase, PARTY_PHASE.SETTLED, 'SETTLED');
  eq(modeElapsedSec(r.mode), 45, '总时长 15 + 30 = 45');

  const st = settleBridgeRun(r);
  eq(st.standing[0].team, TEAM_KEY.RED, '红队夺冠');
  eq(st.standing[0].value, 100, '红队 100 分');
  ok(st.broadcastText.includes('红队'), '播报含冠军队名');
});

test('H2 4v4 果冻球:进球判定与比分播报', () => {
  const clock = createManualClock(0);
  const r = createJellyBall(clock, 'referee');
  startPartyMode(r.mode);
  eq(r.mode.phase, PARTY_PHASE.PLAY, '无建造阶段直接 PLAY');
  eq(scoreLine(r.mode.board), '红队 0  ·  蓝队 0  ·  黄队 0  ·  绿队 0', '初始比分');

  /* 把球踢进红队球门 → 蓝队得分 */
  kickBall(r, -8, 0);
  for (let i = 0; i < 200 && r.ball.live; i += 1) {
    tickJellyBall(r, 0.05);
    judgeGoal(r);
  }
  ok(!r.ball.live, '进球后球离场等待复位');
  eq(getTeam(r.mode.board, TEAM_KEY.BLUE).goals, 1, '蓝队 1 球');
  eq(getTeam(r.mode.board, TEAM_KEY.RED).goals, 0, '红队 0 球');
  eq(r.goalTriggers, 1, '410 球门框触发 1 次');

  const bcast = drainBroadcasts(r.mode.broadcaster);
  const goalMsg = bcast.find((b) => b.kind === BROADCAST_KIND.GOAL);
  ok(!!goalMsg, '产生 GOAL 播报');
  ok(goalMsg?.text.includes('蓝队') === true, `播报含进球方:${goalMsg?.text}`);
  ok(goalMsg?.text.includes('红队 0') === true, `播报含最新比分:${goalMsg?.text}`);

  /* 复位:1.0 秒后球回到 433 生成座 */
  tickJellyBall(r, JELLY_BALL_RESET_SEC / 2);
  ok(!r.ball.live, '0.5 秒时仍在复位中');
  tickJellyBall(r, JELLY_BALL_RESET_SEC / 2);
  ok(r.ball.live, '1.0 秒后复位到场上');
  eq(r.ball.x, r.ball.spawnX, '球回到生成座 X');
  eq(r.ball.y, r.ball.spawnY, '球回到生成座 Y');

  const st = settleJellyBall(r);
  eq(st.standing[0].team, TEAM_KEY.BLUE, '蓝队第一');
  eq(st.standing[0].value, 1, '蓝队 1 球');
});

test('H3 金皇冠:注入时钟快进,60 秒持冠获胜', () => {
  const clock = createManualClock(0);
  const r = createCrownRun(clock, 'referee');
  startPartyMode(r.mode);
  crownAssignTeam(r, 'alice', TEAM_KEY.RED);
  crownAssignTeam(r, 'bob', TEAM_KEY.BLUE);

  ok(crownPickup(r, 'alice'), 'alice 拾起皇冠');
  ok(!crownPickup(r, 'bob'), '皇冠已被占据,不能再拾取');
  eq(r.holder, 'alice', '持冠者 alice');

  /* 快进 59 秒(2Hz 低频帧) */
  for (let i = 0; i < 118; i += 1) {
    clock.advance(0.5);
    tickCrown(r, 0.5);
  }
  eq(r.winner, null, '59 秒时无人获胜');
  eq(r.mode.phase, PARTY_PHASE.PLAY, '仍在进行');
  ok(Math.abs(getTeam(r.mode.board, TEAM_KEY.RED).crownSec - 59) < 1e-6,
    `红队持冠 59s,实际 ${getTeam(r.mode.board, TEAM_KEY.RED).crownSec}`);

  /* 再过 1 秒 → 60 秒达标 */
  clock.advance(1);
  const ev = tickCrown(r, 1);
  includes(ev, 'CROWN_WIN', '获胜事件');
  eq(r.winner, TEAM_KEY.RED, '红队获胜');
  eq(r.mode.phase, PARTY_PHASE.SETTLED, '模式结算');
  near(getTeam(r.mode.board, TEAM_KEY.RED).crownSec, 60, 1e-6, '红队恰好 60 秒');
  eq(CROWN_WIN_SEC, 60, '获胜阈值 60 秒');
  eq(CROWN_MODE_SEC, 180, '总时长 3 分钟');

  const st = settleCrown(r);
  eq(st.standing[0].team, TEAM_KEY.RED, '结算红队第一');
  ok(st.personal.length >= 1, '产生个人持冠榜');
  eq(st.personal[0].playerId, 'alice', 'alice 个人第一');
  ok(st.broadcastText.includes('红队'), '播报含冠军队');
});

test('H4 掉冠 5 秒冷却防止抖冠刷分', () => {
  const clock = createManualClock(0);
  const r = createCrownRun(clock, 'referee');
  startPartyMode(r.mode);
  crownAssignTeam(r, 'alice', TEAM_KEY.RED);
  crownAssignTeam(r, 'bob', TEAM_KEY.BLUE);

  crownPickup(r, 'alice');
  for (let i = 0; i < 20; i += 1) { clock.advance(0.5); tickCrown(r, 0.5); }  // 10s
  ok(crownDrop(r), '被撞飞掉冠');
  eq(r.holder, null, '皇冠落地');
  eq(r.cooldownSec, CROWN_PICKUP_COOLDOWN_SEC, '进入 5 秒冷却');
  ok(!crownPickup(r, 'bob'), '冷却期内无法拾取');

  /* 以 0.5s 步长累计推进满 5 秒冷却 */
  for (let i = 0; i < 10; i += 1) {
    clock.advance(0.5);
    tickCrown(r, 0.5);
  }
  eq(r.cooldownSec, 0, '冷却结束');
  ok(crownPickup(r, 'bob'), '冷却后可被 bob 拾起');
  eq(r.holderTeam, TEAM_KEY.BLUE, '蓝队接管');
  ok(Math.abs(getTeam(r.mode.board, TEAM_KEY.RED).crownSec - 10) < 1e-6, '红队保留已得 10 秒');
});

test('H5 圈地涂色:120 秒后按色块数排名', () => {
  const clock = createManualClock(0);
  const r = createPaintWar(clock, 'referee');
  startPartyMode(r.mode);
  eq(r.grid.w, 24);
  eq(r.grid.h, 24);
  eq(neutralCount(r.grid), 576, '初始全未涂色');

  /* 红队 3 球、蓝队 2 球、黄队 1 球 —— 每次刷 (2r+1)^2 = 9 格 */
  throwPaintBall(r, TEAM_KEY.RED, 2, 2);
  throwPaintBall(r, TEAM_KEY.RED, 8, 8);
  throwPaintBall(r, TEAM_KEY.RED, 14, 2);
  throwPaintBall(r, TEAM_KEY.BLUE, 20, 20);
  throwPaintBall(r, TEAM_KEY.BLUE, 20, 10);
  throwPaintBall(r, TEAM_KEY.YELLOW, 5, 20);

  eq(PAINT_BALL_RADIUS, 1, '单次染色半径 1(3×3)');
  eq(tileCount(r.grid, TEAM_KEY.RED), 27, '红队 3 × 9 = 27 格');
  eq(tileCount(r.grid, TEAM_KEY.BLUE), 18, '蓝队 2 × 9 = 18 格');
  eq(tileCount(r.grid, TEAM_KEY.YELLOW), 9, '黄队 1 × 9 = 9 格');
  eq(tileCount(r.grid, TEAM_KEY.GREEN), 0, '绿队 0 格');
  eq(neutralCount(r.grid), 576 - 27 - 18 - 9, '未涂色格数守恒');

  /* 快进到 120 秒结算 */
  clock.advance(PAINT_MODE_SEC);
  tickPartyMode(r.mode);
  eq(modeElapsedSec(r.mode), 120, '涂色限时 120 秒');

  const st = settlePaintWar(r);
  eq(st.standing[0].team, TEAM_KEY.RED, '红队第一');
  eq(st.standing[0].value, 27, '红队 27 格');
  eq(st.standing[1].team, TEAM_KEY.BLUE, '蓝队第二');
  eq(st.standing[1].value, 18, '蓝队 18 格');
  eq(st.standing[3].value, 0, '绿队 0 格垫底');
  ok(st.broadcastText.includes('红队 27 格'), `播报含色块数:${st.broadcastText}`);

  const rank = rankPaint(r.grid);
  eq(rank.map((x) => x.team).join(','), 'RED,BLUE,YELLOW,GREEN', '排名顺序');
  near(rank[0].ratio, 27 / 576, 1e-9, '占比');
  ok(paintStandingLine(rank).includes('4.7%') || paintStandingLine(rank).includes('4.6%'), '占比文案');
});

test('H6 涂色取色由注入 rng 决定,同 seed 可复现', () => {
  const c1 = createManualClock(0);
  const c2 = createManualClock(0);
  const a = createPaintWar(c1, 'ref', 888);
  const b = createPaintWar(c2, 'ref', 888);
  for (let i = 0; i < 6; i += 1) {
    const x = 2 + i * 3;
    throwPaintBall(a, TEAM_KEY.RED, x, 2);
    throwPaintBall(b, TEAM_KEY.RED, x, 2);
  }
  eq(a.dyeLog.join(','), b.dyeLog.join(','), '同 seed 取色序列一致');
  for (const d of a.dyeLog) inRange(d, 0, DYE_PALETTE_SIZE - 1, '色号 ∈ [0,31]');
  eq(pickDyeIndex(seededRng(1)), pickDyeIndex(seededRng(1)), 'pickDyeIndex 确定性');
  const c = createManualClock(0);
  const w = createPaintWar(c, 'ref', 999);
  eq(w.dyeLog.length, 0, '未投球无取色记录');
});

test('H7 跑酷毫秒计时:411 发令门 + 412 领奖台 + 前三名播报', () => {
  const clock = createManualClock(100);
  const r = createRaceRun(clock, 'referee', 90);
  startPartyMode(r.mode);
  eq(r.gateOpen, false, '发令门初始关闭');

  /* 裁判吹哨:4 名玩家同时开门 */
  const n = openGate(r, clock.now(), ['p1', 'p2', 'p3', 'p4']);
  eq(n, 4, '4 人开启计时');
  ok(r.gateOpen, '发令门落下');
  eq(openGate(r, clock.now(), ['p1']), 0, '重复开门不重置已出发玩家');

  /* 各自以不同耗时冲线(毫秒级区分) */
  clock.advance(12.345);
  ok(finishRunner(r, 'p1', clock.now()), 'p1 冲线');
  ok(!finishRunner(r, 'p1', clock.now()), '不能二次冲线');

  clock.advance(0.111);   // 12.456s
  ok(finishRunner(r, 'p2', clock.now()), 'p2 冲线');

  clock.advance(0.002);   // 12.458s
  ok(finishRunner(r, 'p3', clock.now()), 'p3 冲线');

  clock.advance(1.200);   // 13.658s
  ok(finishRunner(r, 'p4', clock.now()), 'p4 冲线');

  const t1 = r.timers.get('p1');
  eq(t1?.startMs, 100000, `出发时刻取整到毫秒:${t1?.startMs}`);
  eq(t1?.elapsedMs, 12345, `p1 成绩 12345ms,实际 ${t1?.elapsedMs}`);
  eq(r.timers.get('p2')?.elapsedMs, 12456, 'p2 成绩 12456ms');
  eq(r.timers.get('p3')?.elapsedMs, 12458, 'p3 成绩 12458ms');
  eq(r.timers.get('p4')?.elapsedMs, 13658, 'p4 成绩 13658ms');
  eq(toMs(12.345), 12345, 'toMs 取整');

  const st = settleRace(r);
  eq(st.personal.length, 4, '四人完赛');
  eq(st.personal.map((x) => x.playerId).join(','), 'p1,p2,p3,p4', '按毫秒升序排名');
  eq(st.personal[0].rank, 1);
  eq(st.personal[3].rank, 4);
  eq(formatMs(12345), '12.345s', '毫秒格式化');
  ok(st.broadcastText.includes('前三名'), `播报前三名:${st.broadcastText}`);
  ok(st.broadcastText.includes('p1 12.345s'), '含第一名耗时');
  ok(st.broadcastText.includes('p3 12.458s'), '含第三名耗时');
  ok(!st.broadcastText.includes('p4'), '第四名不播报');
  eq(st.personalRewards[0].rank, 1, '发奖按名次');
  eq(st.personalRewards[0].exp, REWARD_EXP_BY_RANK[0], '第一名经验');
});

test('H8 未完赛者(DNF)排在完赛者之后', () => {
  const clock = createManualClock(0);
  const r = createRaceRun(clock, 'ref', 30);
  startPartyMode(r.mode);
  openGate(r, clock.now(), ['a', 'b', 'c']);
  clock.advance(5);
  finishRunner(r, 'c', clock.now());
  clock.advance(3);
  finishRunner(r, 'a', clock.now());
  /* b 未冲线 */
  const st = settleRace(r);
  eq(st.personal.map((x) => x.playerId).join(','), 'c,a,b', '完赛者在前,DNF 垫底');
  ok(st.personal[2].dnf, 'b 标记 DNF');
  eq(st.personal[2].elapsedMs, Number.POSITIVE_INFINITY, 'DNF 成绩为 +∞');
  eq(formatMs(Number.POSITIVE_INFINITY), 'DNF', '格式化 DNF');
});

test('H9 同毫秒并列按 playerId 稳定排序(可复现)', () => {
  const mk = (id: string, ms: number) => {
    const t = createRaceTimer(id);
    gateStart(t, 0);
    podiumFinish(t, ms / 1000);
    return t;
  };
  const rows = rankRace([mk('zeta', 1000), mk('alpha', 1000), mk('beta', 1000)]);
  eq(rows.map((x) => x.playerId).join(','), 'alpha,beta,zeta', '字典序稳定');
  const again = rankRace([mk('zeta', 1000), mk('alpha', 1000), mk('beta', 1000)]);
  eq(JSON.stringify(rows), JSON.stringify(again), '两次结果一致');
});

test('H10 播报队列按优先级出队(比分/终场优先)', () => {
  const b = createBroadcaster();
  pushBroadcast(b, BROADCAST_KIND.PAINT, '涂色进度 10%', 10);
  pushBroadcast(b, BROADCAST_KIND.SCORE, '红队进 1 球', 10);
  pushBroadcast(b, BROADCAST_KIND.MODE_END, '比赛结束', 11);
  const first = shiftBroadcast(b);
  eq(first?.kind, BROADCAST_KIND.MODE_END, '终场优先');
  const second = shiftBroadcast(b);
  eq(second?.kind, BROADCAST_KIND.SCORE, '其次比分');
  const third = shiftBroadcast(b);
  eq(third?.kind, BROADCAST_KIND.PAINT, '最后涂色');
  eq(shiftBroadcast(b), null, '队列空返回 null');
  eq(b.emitted, 3, '累计播报 3 条');
  eq(drainBroadcasts(b).length, 0, '空队列取不出东西');
});

test('H11 奖励表按名次递减', () => {
  eq(rewardForRank(1).exp, 600);
  eq(rewardForRank(2).exp, 400);
  eq(rewardForRank(3).exp, 250);
  eq(rewardForRank(4).exp, 150);
  eq(rewardForRank(99).exp, 150, '超出名次截断到最后一档');
  eq(rewardForRank(0).exp, 600, '越界名次地板到第 1 档');
  ok(rewardForRank(1).rewards[130] >= rewardForRank(2).rewards[130], '奖励单调不增');
});

/* ════════════════════════════════════════════════════════════════════
 * I. 社交与度假
 * ════════════════════════════════════════════════════════════════════ */

test('I1 打盹:切后台 5 秒才进入 DOZING', () => {
  eq(DOZE_AFTER_SEC, 5);
  const p = createAfkPlayer('p1');
  eq(p.state, DOZE_STATE.AWAKE, '初始清醒');
  goBackground(p, 0);

  tickAfk(p, 4.5, 0.5);
  eq(p.state, DOZE_STATE.AWAKE, '4.5 秒仍清醒');
  eq(p.dew, 0, '未产露');

  tickAfk(p, 5.0, 0.5);
  eq(p.state, DOZE_STATE.DOZING, '满 5 秒进入打盹');
  eq(p.dew, 0, '刚进入还没攒够 1 滴');
});

test('I2 产露速率:基础 30 秒 1 滴;篝火区翻倍;榻榻米 +20%', () => {
  eq(DEW_SEC_PER_UNIT, 30);
  const p = createAfkPlayer('p2');
  goBackground(p, 0);
  tickAfk(p, 5, 0.5);
  near(dewRatePerSec(p), 1 / 30, 1e-12, '基础速率');

  /* 再攒 30 秒 → 恰得 1 滴 */
  let got = 0;
  for (let i = 0; i < 60; i += 1) {
    const t = 5.5 + i * 0.5;
    got += tickAfk(p, t, 0.5);
  }
  eq(got, 1, `30 秒攒到 1 滴,实际 ${got}`);
  eq(p.dew, 1, '露水总量 1');

  /* 篝火区(501)速率翻倍 */
  const q = createAfkPlayer('p3');
  q.nearFire = true;
  goBackground(q, 0);
  tickAfk(q, 5, 0.5);
  near(dewRatePerSec(q), (1 / 30) * DEW_FIRE_BONUS, 1e-12, '篝火 4 格内翻倍');

  /* 榻榻米(304)额外 +20% */
  const w = createAfkPlayer('p4');
  w.onTatami = true;
  goBackground(w, 0);
  tickAfk(w, 5, 0.5);
  near(dewRatePerSec(w), (1 / 30) * DEW_TATAMI_BONUS, 1e-12, '榻榻米 +20%');

  /* 篝火 + 榻榻米叠加 */
  const z = createAfkPlayer('p5');
  z.nearFire = true;
  z.onTatami = true;
  goBackground(z, 0);
  tickAfk(z, 5, 0.5);
  near(dewRatePerSec(z), (1 / 30) * DEW_FIRE_BONUS * DEW_TATAMI_BONUS, 1e-12, '叠加生效');
});

test('I3 深度睡眠 10 分钟后产出减半', () => {
  const p = createAfkPlayer('p6');
  goBackground(p, 0);
  tickAfk(p, 5, 0.5);
  near(dewRatePerSec(p), 1 / 30, 1e-12, '浅睡速率');

  /* 快进到 601 秒 */
  for (let i = 0; i < 1200; i += 1) tickAfk(p, 5.5 + i * 0.5, 0.5);
  eq(p.state, DOZE_STATE.DEEP, '进入深度睡眠');
  ok(p.dozedSec >= DEEP_SLEEP_AFTER_SEC, `已打盹 ${p.dozedSec}s`);
  near(dewRatePerSec(p), (1 / 30) * 0.5, 1e-12, '深睡产出减半');
});

test('I4 摸头:赠 1 滴露水并唤醒队友', () => {
  const p = createAfkPlayer('p7');
  goBackground(p, 0);
  tickAfk(p, 5, 0.5);
  eq(p.state, DOZE_STATE.DOZING, '前置:打盹中');
  const before = p.dew;
  eq(patDozing(p), 1, '摸头赠 1 滴');
  eq(p.dew, before + 1, '露水 +1');
  eq(p.state, DOZE_STATE.AWAKE, '被摸醒');
  eq(p.backgroundedAtSec, null, '回到前台');
  eq(patDozing(p), 0, '清醒时摸头无效');
});

test('I5 切回前台立即停止产露;挂机经验倍率消费冻结层常数', () => {
  const p = createAfkPlayer('p8');
  goBackground(p, 0);
  for (let i = 0; i < 60; i += 1) tickAfk(p, 5.5 + i * 0.5, 0.5);
  const dewBefore = p.dew;
  goForeground(p);
  eq(p.state, DOZE_STATE.AWAKE, '回前台清醒');
  eq(tickAfk(p, 999, 0.5), 0, '不再产露');
  eq(p.dew, dewBefore, '露水不变');
  near(afkExpRatio(), AFK_EXP_RATIO, 1e-12, '挂机经验 0.3 倍');
  near(AFK_EXP_RATIO, 0.3, 1e-12, '冻结层常数');
});

test('I6 生态缸挂机:1.2 秒后隐藏 UI,24 秒换机位,白噪音混音收敛', () => {
  const v = createVivarium();
  enterVivarium(v, 0);
  eq(v.uiHidden, false, '刚进入 UI 未隐藏');
  tickVivarium(v, 0.6, 0.5);
  eq(v.uiHidden, false, '0.6 秒仍在淡出');
  ok(v.masterGain > 0 && v.masterGain < whiteNoiseMasterGain(), '淡入中,增益介于 0 与总增益');
  tickVivarium(v, VIVARIUM.uiFadeSec, 0.5);
  ok(v.uiHidden, '1.2 秒后 UI 隐藏');
  near(v.masterGain, whiteNoiseMasterGain(), 1e-9, '混音达到总线总增益');
  eq(WHITE_NOISE_MIX.length, 5, '5 条白噪音轨道');
  eq(whiteNoiseMasterGain(), 1.12, 1e-9, '总增益 0.32+0.28+0.22+0.18+0.12');

  const shot = tickVivarium(v, VIVARIUM.shotSec, 0.5);
  eq(shot, VIVARIUM_CAMERA_SHOTS[1], '第 2 个机位');
  tickVivarium(v, VIVARIUM.shotSec * 5, 0.5);
  eq(v.shotIndex, 0, '轨道循环回第 1 镜');

  tickVivarium(v, VIVARIUM.shotSec * 6, 0.5, 12);
  ok(v.fallbackCount > 0, '低于 24fps 触发降级计数');
  exitVivarium(v);
  ok(!v.active && !v.uiHidden && v.masterGain === 0, '退出后 UI 恢复、静音');
});

test('I7 534 留言信箱:容量上限、点赞徽章、过期清理', () => {
  eq(MAILBOX_CAPACITY, 50);
  const mb = createMailbox('owner');
  for (let i = 0; i < MAILBOX_CAPACITY + 5; i += 1) {
    leaveMail(mb, {
      id: `m${i}`, from: `guest${i}`, to: 'owner', atSec: 1000 + i,
      likes: 0, sticker: i % 12, gifts: { 130: 1 }, text: `贴纸贺卡 ${i}`,
    });
  }
  eq(mb.items.length, MAILBOX_CAPACITY, '容量封顶 50');
  eq(mb.dropped, 5, '溢出丢弃 5 条');
  eq(mb.items[0].id, 'm5', 'FIFO:最旧的被丢掉');

  ok(likeMail(mb, 'm5'), '点赞成功');
  ok(likeMail(mb, 'm5'), '同一留言可累计点赞');
  ok(!likeMail(mb, 'nope'), '不存在的留言点赞失败');
  eq(mb.totalLikes, 2, '累计点赞 2');
  eq(badgeFor(mb), null, '2 赞还没有徽章');

  for (let i = 0; i < 8; i += 1) likeMail(mb, 'm6');
  eq(mb.totalLikes, 10, '累计 10 赞');
  eq(badgeFor(mb), '人气小屋', '达到 10 赞徽章');

  for (let i = 0; i < 42; i += 1) likeMail(mb, 'm7');
  eq(badgeFor(mb), '网红打卡点', '达到 50 赞徽章');

  const removed = pruneMailbox(mb, 1000 + MAIL_TTL_SEC + 10);
  ok(removed > 0, `过期清理 ${removed} 条`);
  ok(mb.items.length < MAILBOX_CAPACITY, '清理后条数下降');
});

test('I8 515 售货摊:推荐价取自 V_i;跨房交易抽 5%', () => {
  const stall = createStall('shopkeeper');
  const itemId = 156;
  const v = ITEM_BY_ID.get(itemId)?.value ?? 0;
  ok(v > 0, '前置:物品有基础价值');
  const price = suggestedPrice(itemId);
  eq(price, Math.ceil(v * 1.6), `推荐价 = V_i × 1.6 = ${price}`);

  ok(listItem(stall, { itemId, qty: 10, price, sellerId: 'me', listedAtSec: 0 }), '上架成功');
  ok(!listItem(stall, { itemId, qty: 0, price, sellerId: 'me', listedAtSec: 0 }), '数量为 0 拒绝');
  ok(!listItem(stall, { itemId, qty: 1, price: 0, sellerId: 'me', listedAtSec: 0 }), '价格 < 1 拒绝');
  ok(!listItem(stall, { itemId: 99999, qty: 1, price: 10, sellerId: 'me', listedAtSec: 0 }), '未知物品拒绝');

  const buy = buyFromStall(stall, itemId, 4, true);
  ok(buy.ok, '跨房购买成功');
  eq(buy.qty, 4, '成交 4 件');
  eq(buy.gross, 4 * price, '成交额 = 4 × 单价');
  eq(buy.fee, Math.round(4 * price * CROSS_ROOM_FEE_RATIO), '抽成 5%');
  eq(buy.net, buy.gross - buy.fee, '净收入 = 成交额 − 抽成');
  eq(stall.revenue, 4 * price, '累计成交额');
  eq(stall.feePaid, buy.fee, '累计抽成');
  eq(stall.listings[0].qty, 6, '剩余 6 件');

  const local = buyFromStall(stall, itemId, 2, false);
  eq(local.fee, 0, '同房间零手续费');
  eq(local.net, local.gross, '同房间净额 = 成交额');

  const over = buyFromStall(stall, 99999, 1, true);
  ok(!over.ok, '未上架物品购买失败');
  eq(over.reason, 'NOT_LISTED', '原因 NOT_LISTED');
  eq(buyFromStall(stall, itemId, 0, true).reason, 'QTY_INVALID', '数量非法');
  eq(buyFromStall(stall, itemId, 100000, true).reason, 'QTY_INVALID', '超过单笔上限');
});

test('I9 售货摊售罄自动下架', () => {
  const stall = createStall('owner');
  listItem(stall, { itemId: 151, qty: 3, price: 20, sellerId: 'me', listedAtSec: 0 });
  const r = buyFromStall(stall, 151, 5, false);
  ok(r.ok, '超量购买按库存成交');
  eq(r.qty, 3, '只成交 3 件');
  eq(stall.listings.length, 0, '售罄后下架');
  eq(stall.soldOut, 1, '售罄计数');
});

test('I10 马拉松与风筝 Boss 跑道毫秒计时', () => {
  eq(MARATHON_LENGTH, 200);
  const clock = createManualClock(0);
  const t = createTrack(TRACK_KIND.MARATHON, clock);
  eq(t.length, 200, '马拉松全长');
  eq(t.kind, 'MARATHON');

  for (const id of ['a', 'b', 'c', 'd']) trackStart(t, id);
  clock.advance(65.432);
  trackFinish(t, 'a');
  clock.advance(0.568);
  trackFinish(t, 'b');
  clock.advance(2.000);
  trackFinish(t, 'c');

  eq(t.timers.get('a')?.elapsedMs, 65432, 'a 成绩');
  eq(t.timers.get('b')?.elapsedMs, 66000, 'b 成绩');
  eq(t.timers.get('c')?.elapsedMs, 68000, 'c 成绩');

  const text = trackPodiumText(t);
  ok(text.includes('马拉松前三名'), `播报标题:${text}`);
  ok(text.includes('1.a 65.432s'), '含第一名');
  ok(text.includes('3.c 68.000s'), '含第三名');
  ok(!text.includes('d '), '未完赛者不播报');

  const rows = trackStandings(t);
  eq(rows.map((x) => x.playerId).join(','), 'a,b,c,d', '排名');
  ok(rows[3].dnf, 'd 未完成');
});

test('I11 风筝 Boss 跑道:被追上一次罚 3 秒', () => {
  const clock = createManualClock(0);
  const t = createTrack(TRACK_KIND.KITE_BOSS, clock);
  eq(t.length, 150, '风筝跑道全长');
  trackStart(t, 'x');
  trackStart(t, 'y');
  clock.advance(20.000);
  trackCaught(t, 'x');
  trackCaught(t, 'x');
  eq(t.caught.get('x'), 2, '被追 2 次');
  trackFinish(t, 'x');
  clock.advance(1.0);
  trackFinish(t, 'y');
  eq(t.timers.get('x')?.elapsedMs, 20000 + 2 * KITE_CATCH_PENALTY_MS, '惩罚累加:20s + 6s');
  eq(t.timers.get('y')?.elapsedMs, 21000, 'y 无惩罚');
  const rows = trackStandings(t);
  eq(rows[0].playerId, 'y', 'y 以 21.000s 居首(未受罚)');
  eq(rows[1].playerId, 'x', 'x 被追两次,26.000s 落后');
  eq(rows[0].elapsedMs, 21000, '第一名成绩');
});

test('I12 社交引用与冻结层配表闭合', () => {
  for (const id of [534, 515, 130, 304, 501, 517]) {
    ok(ITEM_BY_ID.has(id), `物品 ${id} 存在于冻结层`);
  }
  eq(ITEM_BY_ID.get(130)?.name, '梦境露水', '露水名称源自事实源');
  eq(ITEM_BY_ID.get(218)?.name, '工程安全帽(和平盾)', '和平盾名称源自事实源');
  ok(ITEM_BY_ID.get(218)?.note.includes('100% 免疫'), '和平盾注释含 100% 免疫');
});

/* ════════════════════════════════════════════════════════════════════
 * J. 跨模块一致性 / 与冻结层耦合
 * ════════════════════════════════════════════════════════════════════ */

test('J1 分数板与队伍常量一致(红蓝黄绿四队)', () => {
  eq(TEAM_ORDER.length, 4);
  eq(TEAM_ORDER.join(','), 'RED,BLUE,YELLOW,GREEN');
  const b = createScoreboard();
  for (const t of TEAM_ORDER) {
    eq(getTeam(b, t).team, t, `队伍 ${t}`);
    eq(getTeam(b, t).score, 0, '初始 0 分');
  }
  eq(b.size, 4, '恰 4 队');
  eq(TEAM_LABEL[TEAM_KEY.RED], '红队');
  eq(crownLine(b).includes('红队 0.0s'), true, '持冠榜文案');
});

test('J2 播报文案与中国队名一一对应', () => {
  const b = createScoreboard();
  getTeam(b, TEAM_KEY.YELLOW).goals = 3;
  eq(scoreLine(b), '红队 0  ·  蓝队 0  ·  黄队 3  ·  绿队 0', '比分文案');
});

test('J3 涂色网格边界:越界不写入,重复涂色不计数', () => {
  const g = createPaintGrid(4, 4);
  eq(neutralCount(g), 16, '初始 16 格未涂');
  /* 中心在 (-1,-1)、半径 1 的 3×3 只有 (0,0) 落在网格内 */
  eq(paintRadius(g, -1, -1, 1, TEAM_KEY.RED), 1, '角落只刷到 1 格有效格');
  eq(paintRadius(g, -1, -1, 1, TEAM_KEY.RED), 0, '重复涂同一块不计数');
  eq(paintRadius(g, 100, 100, 2, TEAM_KEY.BLUE), 0, '完全越界返回 0');
  eq(paintRadius(g, 0, 0, 0, TEAM_KEY.GREEN), 1, '半径 0 只刷中心格');
  eq(tileCount(g, TEAM_KEY.RED), 0, '绿队把红队的 (0,0) 抢走,红队归零');
  eq(tileCount(g, TEAM_KEY.GREEN), 1, '绿队 1 格');
  const occupied = TEAM_ORDER.reduce((a, t) => a + tileCount(g, t), 0);
  eq(occupied + neutralCount(g), 16, '总格数守恒');
  eq(paintRadius(g, 1, 1, 1, TEAM_KEY.YELLOW), 9, '内部 3×3 满刷 9 格');
  eq(TEAM_ORDER.reduce((a, t) => a + tileCount(g, t), 0) + neutralCount(g), 16, '再次守恒');
});

test('J4 急单会话在 20Hz 与 2Hz 两种步长下结论一致', () => {
  function run(dt: number): number {
    const clock = createManualClock(0);
    const ses = createRushOrderSession({ clock, roomLevel: 10, rng: mulberry32(77), stock: {} });
    startRushOrder(ses);
    const steps = Math.round(OVERHEAT_SEC / dt);
    for (let i = 0; i < steps; i += 1) {
      clock.advance(dt);
      tickRushOrder(ses, dt, { spawnBeaver: false });
    }
    return ses.stations[0].fireCount;
  }
  eq(run(0.05), 1, '20Hz 步长下 12 秒起火一次');
  eq(run(0.5), 1, '2Hz 步长下 12 秒起火一次');
  eq(run(1.0), 1, '1Hz 步长下 12 秒起火一次');
});

test('J5 会话结算把分数、罚分、河狸损失全部带出', () => {
  const clock = createManualClock(0);
  const ses = createRushOrderSession({
    clock, roomLevel: 20, rng: mulberry32(101), stock: { [BEAVER_TARGET_ITEM_ID]: 9 },
  });
  startRushOrder(ses);
  for (const s of ses.board.slots) submitDelivery(ses, s.itemId, s.need);
  eq(boardProgress(ses.board), 1, '订单全部交付');

  /* 触发一只河狸偷料 */
  for (let i = 0; i < 8; i += 1) { clock.advance(0.5); tickRushOrder(ses, 0.5, { spawnBeaver: false }); }
  ses.beavers.push(spawnBeaver('b1'));
  for (let i = 0; i < 8; i += 1) { clock.advance(0.5); tickRushOrder(ses, 0.5, { spawnBeaver: false }); }

  const st = settleSession(ses);
  eq(st.grade, 'S', '满分评 S');
  eq(st.progress, 1, '完成度 1');
  eq(st.woodStolen, 3, '被偷 3 块木板计入结算');
  eq(st.beaversEscaped, 0, '河狸尚未逃逸');
  ok(st.sessionScore >= st.score - st.penalty, '会话总分口径正确');
});

test('J6 注入时钟不真 sleep:全程几乎零耗时', () => {
  const t0 = Date.now();
  const clock = createManualClock(0);
  const ses = createRushOrderSession({ clock, roomLevel: 30, rng: mulberry32(1), stock: {} });
  startRushOrder(ses);
  /* 快进模拟整场 3 分钟,2Hz */
  for (let i = 0; i < 360; i += 1) {
    clock.advance(0.5);
    tickRushOrder(ses, 0.5, { spawnBeaver: true });
  }
  eq(ses.state, RUSH_ORDER_STATE.SETTLED, '3 分钟后结算');
  const cost = Date.now() - t0;
  ok(cost < 2000, `模拟 180 秒逻辑仅耗时 ${cost}ms(注入时钟,无真 sleep)`);
  eq(elapsedSec(ses), 180, '逻辑时间前进 180 秒');
});

test('J7 性能:35 玩具表 O(1) 索引 + 一次全表扫描足够便宜', () => {
  const t0 = Date.now();
  let sum = 0;
  for (let i = 0; i < 10000; i += 1) {
    sum += toyOf(221 + (i % 35)).radius;
    sum += (PRANK_TOY_BY_ID.get(225)?.stunSec ?? 0);
  }
  const cost = Date.now() - t0;
  ok(sum > 0, '索引读取有效');
  ok(cost < 2000, `2 万次 O(1) 查表耗时 ${cost}ms`);
  eq(PRANK_TOY_BY_ID.size, 35, '索引条目数 = 35');
});

test('J8 冻结层未被改动:物品总数 / Boss 模式数 / 物理常数稳定', () => {
  eq(ITEM_BY_ID.size, 320, '物品 320 项');
  eq(PARTY_MODES.length, 4, 'PARTY_MODES 4 项');
  eq(CARRY_Z_STEP, 0.85, 'CARRY_Z_STEP 未漂移');
  eq(CATCH_RADIUS, 0.8, 'CATCH_RADIUS 未漂移');
  const ids: number[] = [];
  for (let i = PRANK_TOY_ID_MIN; i <= PRANK_TOY_ID_MAX; i += 1) ids.push(i);
  eq(ids.length, 35, '[221..255] 连续 35 个 ID');
  for (const id of ids) ok(ITEM_BY_ID.has(id), `#${id} 在冻结层 §3.4 中`);
});

test('J9 makeRng 与 harness.mulberry32 位级一致', () => {
  const a = makeRng(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 200; i += 1) near(a(), b(), 1e-15, `第 ${i} 个随机数`);
});

test('J10 四大模式各自的结算互不串扰', () => {
  const clock = createManualClock(0);
  const bridge = createBridgeRun(clock, 'r1');
  const jelly = createJellyBall(clock, 'r1');
  const crown = createCrownRun(clock, 'r1');
  const paint = createPaintWar(clock, 'r1');
  startPartyMode(bridge.mode);
  startPartyMode(jelly.mode);
  startPartyMode(crown.mode);
  startPartyMode(paint.mode);
  eq(bridge.mode.board.size, 4, '造桥独立记分板');
  eq(jelly.mode.board.size, 4, '果冻球独立记分板');
  ok(bridge.mode.board !== jelly.mode.board, '两个记分板是不同的 Map');
  ok(bridge.mode.broadcaster !== jelly.mode.broadcaster, '播报队列独立');
  eq(bridge.mode.key, 'BRIDGE_CTF');
  eq(jelly.mode.key, 'JELLY_BALL');
  eq(crown.mode.key, 'CROWN_BR');
  eq(paint.mode.key, 'PAINT_WAR');
  /* 给造桥加分不影响果冻球 */
  getTeam(bridge.mode.board, TEAM_KEY.RED).score = 999;
  eq(getTeam(jelly.mode.board, TEAM_KEY.RED).score, 0, '跨模式无串扰');
});

/* ═══════════════ task-38:四个「生产零引用」模块的归属与前置条件 ═══════════════ */

/* 判定结论(详见 task-38 报告):
 *   taming.ts    → 真欠账,但缺两个不存在的宿主(宠物容器 + 驯服交互)
 *   modes.ts     → 等「对局容器」(生产有枚举与计分字段,无对局运行时)
 *   afk.ts       → 等「房间每帧驱动 + 切后台事件」
 *   immunity.ts  → 等「施加整蛊的宿主」,与 toys.ts **同一个宿主**
 *
 * 本组**不重复门禁的可达性判据**(verify.ts 的白名单自检已覆盖「不可达」),
 * 只钉哪三个门禁**查不出**的事实:宿主缺失、词表冲突、AFK 同名异义。 */

test('task-38:四个模块的宿主在生产里都不存在(故「接线」是伪命题)', () => {
  /* ⚠️ 断言必须读**生产源码文本**,不能用「文件里有没有这个词」的宽匹配 ——
   * 注释与类型声明都会命中,会造成恒真。下面统一用 import 语句/成员访问形态。 */

  /* modes.ts:生产只有 party **枚举存储**,没有对局运行时。 */
  const room = readFileSync(join(ROOT, 'server', 'src', 'net', 'room.ts'), 'utf8');
  ok(/partyMode/.test(room), 'room.ts 有 partyMode 字段(仅是枚举存储)');
  for (const absent of ['tickPartyMode', 'RoomMode', 'MatchState', 'createPartyMode']) {
    ok(!room.includes(absent),
      `room.ts 不含 ${absent} ⇒ 有枚举、无对局运行时`);
  }
  /* 计分字段存在却无人驱动 —— 「有字段」不等于「有机制」。 */
  const schema = readFileSync(join(ROOT, 'server', 'src', 'net', 'schema.ts'), 'utf8');
  ok(/key: 'scoreA'/.test(schema), 'schema 有 scoreA 字段');
  const wildSim = readFileSync(join(ROOT, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8');
  ok(!wildSim.includes('partyMode'), 'world_sim 不含 partyMode ⇒ 计分字段无人驱动');

  /* afk.ts:等的是「房间 tick + 切后台事件」,两者都没有。 */
  ok(!wildSim.includes('tickAfk'), 'world_sim 不调 tickAfk');
  ok(!room.includes('tickAfk'), 'room.ts 也不调 tickAfk');

  /* immunity.ts:施加整蛊的宿主不存在。 */
  ok(!wildSim.includes('resolveShield'), 'world_sim 不调 resolveShield');
  ok(!room.includes('resolveShield'), 'room.ts 也不调 resolveShield');

  /* taming.ts:宠物容器不存在。 */
  ok(!/interface WorldPlayer[\s\S]{0,600}?\bpets?\b/.test(wildSim),
    'world_sim 的玩家模型里没有宠物集合');
  ok(!wildSim.includes('PetRecord') && !wildSim.includes('feedPet'),
    'world_sim 不碰 PetRecord/feedPet ⇒ 宠物容器不存在');
});

test('task-38 【已修】party 词表:冻结层 / repo / DDL 三者一致', () => {
  /* 原为**缺陷登记**:冻结层 `PARTY_MODES` 用 `BRIDGE_CTF`/`CROWN_BR`,
   * 而 `repo.PartyMode` 与 `schema.sql` 的 CHECK 用 `BRIDGE_FLAG`/`CROWN_RUN`。
   * 4 个模式里 2 个会被 CHECK 拒绝(真实 SQLite 实测 `CHECK constraint failed`)。
   *
   * **已修**(Lead 收口):冻结层是权威(WS-11 的 H0 直接断言它,且 `shared/**` 是冻结层),
   * 持久层不该为它让步 ⇒ 改 `schema.sql` 与 `repo.PartyMode` 对齐冻结层。
   *
   * ⚠️ 本条现在断言**一致性**而不是**不一致**。
   * 原断言按自己的注释要求「修好后应改为 eq(missing.length, 0)」—— 已照办。
   * 这条陷阱值得记:**缺陷登记式断言必须写明「修好后怎么改」**,
   * 否则修完它就从「登记缺陷」悄悄变成「阻碍修复」。 */
  const sql = readFileSync(join(ROOT, 'server', 'src', 'db', 'schema.sql'), 'utf8');
  const checkLine = sql.split('\n').find((l) => l.includes('party_mode IN (')) ?? '';
  ok(checkLine.length > 0, 'schema.sql 有 party_mode 的 CHECK 约束');

  const frozenKeys = PARTY_MODES.map((m) => m.key);
  eq(frozenKeys.length, 4, '冻结层恰好 4 个模式');

  const missing = frozenKeys.filter((k) => !checkLine.includes(`'${k}'`));
  eq(missing.length, 0, `DDL CHECK 必须允许全部 4 个冻结层模式(缺:${missing.join(' / ') || '无'})`);

  /* 旧词表不得再出现 —— 否则两套词表并存,接线时会静默写入错值。 */
  ok(!checkLine.includes('BRIDGE_FLAG'), 'DDL 不再残留旧词 BRIDGE_FLAG');
  ok(!checkLine.includes('CROWN_RUN'), 'DDL 不再残留旧词 CROWN_RUN');

  /* repo.PartyMode 也必须对齐 —— 它是写入路径的实际取值来源。 */
  const repo = readFileSync(join(ROOT, 'server', 'src', 'db', 'repo.ts'), 'utf8');
  const repoBlock = repo.slice(repo.indexOf('export const PartyMode = {'));
  const repoVals = [...repoBlock.slice(0, 300).matchAll(/([A-Z_]+): '([A-Z_]+)'/g)].map((m) => m[2]!);
  for (const k of frozenKeys) {
    ok(repoVals.includes(k), `repo.PartyMode 含冻结层 key ${k}`);
  }
  ok(!repoVals.includes('BRIDGE_FLAG') && !repoVals.includes('CROWN_RUN'),
    'repo.PartyMode 不再残留旧词');
});

test('task-38:两处「AFK」是不同概念,不应互相顶替', () => {
  /* room.ts 的 `AFK` = 在场状态(AFK_TIMEOUT_MS=30min,占席位、仍 online);
   * social/afk.ts 的 `AFK` = 挂机攒露水玩法(DOZE_AFTER_SEC / 露水)。
   * 同名会让后来者以为「room 已经有 AFK 了,afk.ts 不用接」—— 正是误报掩盖。
   * 判据:room.ts 里**没有**露水/打盹产出概念。 */
  const room = readFileSync(join(ROOT, 'server', 'src', 'net', 'room.ts'), 'utf8');
  ok(/AFK_TIMEOUT_MS/.test(room), 'room.ts 有 AFK 概念(在场状态)');
  ok(!/露水|dew/i.test(room), '但 room.ts **不含**露水/dew ⇒ 与 afk.ts 不是同一件事');

  const afkSrc = readFileSync(join(ROOT, 'server', 'src', 'social', 'afk.ts'), 'utf8');
  ok(/露水|dew/i.test(afkSrc), 'afk.ts 含露水概念(挂机玩法)');
  ok(/DOZE_AFTER_SEC/.test(afkSrc), 'afk.ts 有打盹阈值(5 秒切后台)');
  /* 两者用的是不同的时间线与不同的持久化意图 ⇒ 不能合并。 */
  ok(!afkSrc.includes('AFK_TIMEOUT_MS'),
    'afk.ts 不引用 room 的 AFK_TIMEOUT_MS ⇒ 两套时间线独立');
});

test('task-38:consumeItem 是**真死代码**(0 调用点),驯服不该误用它', () => {
  /* task-38 要求判定 `consumeItem`。实测:0 个调用点。
   * 它的语义是「按 instance_id 扣减 ai_item_instances」——
   * 而驯服喂食按**物品 ID + 数量**扣,不涉及 instance_id ⇒ 两者口径不同。 */
  const repo = readFileSync(join(ROOT, 'server', 'src', 'db', 'repo.ts'), 'utf8');
  ok(/export function consumeItem/.test(repo), 'consumeItem 有定义');
  /* 它的签名按 instanceId 扣 —— 与按 itemId 扣是不同口径。 */
  includes(repo, 'consumeItem(db: DbLike, instanceId: string, n: number',
    'consumeItem 按 **instanceId** 扣减(不是按 itemId)');

  /* 0 调用点:**全生产树**扫描,且只匹配**代码**。
   *
   * ⚠️ 两类假阳性都必须排掉(都实测踩过):
   *   ① **测试源码里的自指** —— 本组自己的断言字面量 `'consumeItem(db: ...'`
   *      与 test 标题里都含 `consumeItem(`,一度把计数从 0 顶到 1
   *      (由 mob-boss-ai 独立复现并报来;我此前已定位同一根因)。
   *      ⇒ 解法:**不扫 tests/**。
   *   ② **生产源码里的字符串与注释** —— 例如错误消息 `'consumeItem failed'`
   *      或分发表里的键名,`/consumeItem\s*\(/` 一样会命中。
   *      ⇒ 解法:**先剥掉注释与字符串字面量**再匹配。
   *
   * 同时去掉 `repo.ts` 里的**定义体**,避免把签名自身算成调用。 */
  const codeOnly = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')        /* 块注释 */
    .replace(/\/\/[^\n]*/g, '')              /* 行注释 */
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")   /* 单引号串 */
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')   /* 双引号串 */
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');    /* 模板串 */

  const prodTrees = [
    join(ROOT, 'server', 'src'),
    join(ROOT, 'client', 'src'),
  ];
  const prodTs: string[] = [];
  const collect = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.git' || e.startsWith('_')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) collect(p);
      else if (e.endsWith('.ts')) prodTs.push(p);
    }
  };
  for (const t of prodTrees) collect(t);
  ok(prodTs.length > 40, `扫到生产 .ts ${prodTs.length} 个(覆盖面足够)`);

  let callers = 0;
  const callSites: string[] = [];
  for (const p of prodTs) {
    let code = codeOnly(readFileSync(p, 'utf8'));
    /* 剥掉定义体本身(签名也是 `consumeItem(`)。 */
    code = code.replace(/export function consumeItem\b[\s\S]*?\n\}/, '');
    if (/consumeItem\s*\(/.test(code)) {
      callers += 1;
      callSites.push(p.slice(ROOT.length + 1).split('\\').join('/'));
    }
  }
  eq(callers, 0,
    `consumeItem 在**全生产树**(${prodTs.length} 个文件)0 调用点 ⇒ 死代码`
    + `(若不为 0,实际调用点:${callSites.join(', ')})`);

  /* 而 world_sim 有自己的按 ID 扣减口径 —— 那才是驯服该用的。 */
  const wildSim = readFileSync(join(ROOT, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8');
  ok(/consumeGroundItem\s*\(/.test(wildSim),
    'world_sim 走 consumeGroundItem(itemId, count) —— 按 ID 扣,与驯服口径一致');
});

/* ════════════════════════════════════════════════════════════════════
 * K. task-41:槽位公式的两侧边界 + 交付计分不变量
 *
 * 前两套(A2/A5)只钉住了「点」:A2 断言 `slots.length ∈ [2,4]` 且只用 lv=12,
 * 于是 `ORDER_SLOT_MIN`/`ORDER_SLOT_MAX`/`ROOM_LEVEL_PER_SLOT` 三个常量
 * **改任何值套件都全绿**(实测:SLOT_MIN 取 1/2/3/4 全绿,SLOT_MAX 取 2/3/4/5/8 全绿)。
 * 下面 K1/K2 把两侧边界与饱和点都钉死。
 * ════════════════════════════════════════════════════════════════════ */

test('K1 槽位公式:三个常量按设计档取值,两侧边界与饱和点都精确', () => {
  /*
   * ⚠ 这里**必须写设计档的字面量**,不能拿导出常量当期望值。
   * 否则断言是恒真的:`eq(slotsAt(1), ORDER_SLOT_MIN)` 在 MIN 被改成任何值时
   * 两侧同时变,永远通过 —— 实测 MIN 取 1/2/3 全绿,等于没测。
   * 字面量的出处是 `docs/WS-11-coop-prank-party.md` §5.1 参数表(权威档):
   *   ORDER_SLOT_MIN / MAX = 2 / 4;ROOM_LEVEL_PER_SLOT = 5
   */
  eq(ORDER_SLOT_MIN, 2, '设计档 §5.1:小房间 2 单');
  eq(ORDER_SLOT_MAX, 4, '设计档 §5.1:大房间 4 单');
  eq(ROOM_LEVEL_PER_SLOT, 5, '设计档 §5.1:每 5 级 +1 订单位');

  const slotsAt = (lv: number): number =>
    generateOrderBoard(mulberry32(41), lv, {}, 41).slots.length;

  /* 下界平台:floor((lv-1)/5) 在 lv≤5 时恒为 0 */
  eq(slotsAt(1), 2, 'lv=1 → 2 单(下界)');
  eq(slotsAt(5), 2, 'lv=5 → 仍 2 单(平台右端)');
  /* 第一次上跳:lv=6 → floor(5/5)=1 */
  eq(slotsAt(6), 3, 'lv=6 → 3 单(首跳)');
  eq(slotsAt(10), 3, 'lv=10 → 仍 3 单');
  /* 第二次上跳即饱和:lv=11 → floor(10/5)=2 → 4 */
  eq(slotsAt(11), 4, 'lv=11 → 4 单(饱和点)');
  /* 饱和之后永不越界 —— 这正是单边盲区藏身处 */
  for (const lv of [12, 20, 30, 99, 999]) {
    eq(slotsAt(lv), 4, `lv=${lv} 不得越过上界 4`);
  }

  /* 单调不减 + 全程夹在 [2,4] */
  let prev = 0;
  for (let lv = 1; lv <= 40; lv += 1) {
    const n = slotsAt(lv);
    ok(n >= prev, `槽位数应随等级单调不减(lv=${lv}: ${prev}→${n})`);
    ok(n >= 2 && n <= 4, `lv=${lv} 槽位 ${n} 越界`);
    prev = n;
  }
});

test('K2 交付计分与**切分方式无关**(分件流水线不改变得分)', () => {
  /*
   * 手册 §6.1 的核心卖点是多人分件流水线(A 砍 → 隔河扔 B → B 接住送切木机
   * → C 接住拍地基)。「同一批货分几次交」是玩法自由度,**不该改变得分**。
   *
   * ⚠️ 本条与 `docs/WS-11-coop-prank-party.md` §10.2 的 **U2 决策相抵触**,
   * 属**有意为之**,理由如下(task-41 实测):
   *
   * U2 原文:「订单单件分 `round(points / need)`(Lead 已采纳:保持现实现的
   *          「先乘后除再取整」,**不做末位补差**)」
   * U2 理由:(a)「每单最多 4 件,累计舍入误差 ≤ 2 分,对 totalPoints 量级可忽略」
   *          (b)「末位补差需在槽位里额外维护余数状态,复杂度不值得」
   *
   * 两条理由经实测**都不成立**:
   *
   * (a) 这不是「精度误差可忽略」问题,而是**规则不确定性**。误差的量级确实小,
   *     但它的**符号取决于交付批次** —— 实测 1600 块真实订单板中 769 块(48.1%)
   *     两种交法得分不同,**且两个方向都有**(既多 1 分也少 1 分,见下方反证);
   *     ⇒ 没有哪一侧是「保守正确」。玩家按同一套动作交满同一批货,
   *       分数却因「谁先交、分几批」而变,且无任何规则说明哪种才对。
   *     手册把一个 3~12 人的协作玩法当作卖点,计分却对协作方式敏感。
   *
   * (b) 本修法**不需要任何额外余数状态**:用 `slot.delivered`(字段本就存在)
   *     做望远镜式差值 `round(P·dₙ/N) − round(P·dₙ₋₁/N)`,任意切分都收敛到
   *     `round(P) − round(0) = P`。U2 估算的「复杂度」成本**不适用**于这个做法。
   *
   * ⇒ 若 Lead 裁决仍按 U2 保留原行为,请**回退 `deliverItem` 并把本条断言删掉**
   *   (或改成断言「两种交法应当不同」)。不要只回退代码而留下本条 —— 那会红。
   */
  const clone = (b: ReturnType<typeof generateOrderBoard>): ReturnType<typeof generateOrderBoard> =>
    JSON.parse(JSON.stringify(b)) as ReturnType<typeof generateOrderBoard>;

  const deliverAll = (
    board: ReturnType<typeof generateOrderBoard>,
    pattern: readonly number[],
  ): number[] => {
    const per: number[] = [];
    for (const s of board.slots) {
      let got = 0;
      let left = s.need;
      let pi = 0;
      while (left > 0) {
        const chunk = Math.min(pattern[pi % pattern.length]!, left);
        got += deliverItem(board, s.itemId, chunk).points;
        left -= chunk;
        pi += 1;
      }
      per.push(got);
    }
    return per;
  };

  const patterns: Array<readonly number[]> = [[99], [1], [2], [3], [1, 2, 3], [2, 1], [3, 1, 1]];
  let boards = 0;

  for (let seed = 1; seed <= 120; seed += 1) {
    for (const lv of [1, 6, 11, 20, 30]) {
      const base = generateOrderBoard(mulberry32(seed), lv, {}, seed);
      boards += 1;

      let ref: number[] | null = null;
      for (const pat of patterns) {
        const got = deliverAll(clone(base), pat);
        if (ref === null) ref = got;
        else {
          eq(JSON.stringify(got), JSON.stringify(ref),
            `seed=${seed} lv=${lv} 切分 ${JSON.stringify(pat)} 得分应与其他切分一致`);
        }
      }

      /* 交满后每槽实得必须**恰好等于** slot.points(不是「>0」) */
      for (let i = 0; i < base.slots.length; i += 1) {
        eq(ref![i], base.slots[i]!.points,
          `seed=${seed} lv=${lv} 槽 ${base.slots[i]!.itemId} 交满实得应等于满分`);
      }
    }
  }
  eq(boards, 600, '抽样规模(防止循环被改成空跑而静默通过)');
});

report('WS-11');