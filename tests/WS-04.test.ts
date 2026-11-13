/**
 * WS-04 测试:野生动物 AOI / 三态 FSM / 24 种独特 AI / 驯养 / 刷怪。
 *
 * 运行:`node tests/WS-04.test.ts`(Node 24 原生类型擦除)
 */

import { test, ok, eq, near, includes, inRange, report } from '../shared/testing/harness.ts';
import { mulberry32 } from '../shared/testing/harness.ts';
import { MOB_LIST, MOB_BY_ID, hostileMobs, tameableMobs } from '../shared/constants/mobs.ts';
import { Biome, MobBehavior } from '../shared/types/entities.ts';
import { BASE_MOVE_SPEED, DT, TICK_HZ } from '../shared/types/physics.ts';

import {
  AoiManager, AOI_WAKE_DISTANCE, isInsideAoi, chunkKeyOf, estimateAoiScanCost,
  type AoiPlayer,
} from '../server/src/mobs/aoi.ts';
import {
  MobFsm, MobFsmState, steer45, PROBE_READS_PER_STEP, GRAZE_RADIUS,
  TELEGRAPH_SEC_MIN, TELEGRAPH_SEC_MAX, estimateFsmCostUs, resolveTelegraphHit,
} from '../server/src/mobs/fsm.ts';
import {
  circleWarn, sectorWarn, rectWarn, ringWarn, pointerWarn, insideWarn, insideWarnZ,
  insideWarn3D, pointerAngleDeg, GEOM_EPS, unit, WARN_SHAPES,
} from '../server/src/mobs/geometry.ts';
import {
  BOAR_CHARGE_TILES, BOAR_SELF_STUN_SEC, BOAR_WINDUP_SEC,
  BAT_FALL_SEC, BEETLE_FRONT_DR, CAPYBARA_REFLECT_HEARTS, CHOCO_MELT_FLOOR,
  GINGER_ESCAPE_SEC, KNIGHT_FRONT_DR, KNIGHT_PARALYZE_SEC, SAMURAI_FRONT_ARC_DEG,
  TANUKI_REVEAL_DISTANCE, ITEM, DamageKind, THUNDER_HELM_STACK_MAX,
  HARPY_GUST_FORCE,
  createMobAi, isHostile,
  type MobRuntime, type MobWorld, type WorldPlayer, type GroundItem,
} from '../server/src/mobs/behaviors.ts';
import {
  createPetRecord, feedPet, commandPet, deployLimit, deployPet, sendToRanch,
  tickRanch, carrySlots, TameStage, TameCommand, canTame, tamingCoverage,
  tameableDefs, RANCH_PRODUCE_SEC, DEPLOY_BADGE_ID,
} from '../server/src/mobs/taming.ts';
import {
  BIOME_SPAWN, decideSpawn, lightSuppressed, inSafeZone, safeZoneShield,
  NIGHT_BRICK_ID, STREET_LAMP_ID, STREET_LAMP_RADIUS, TOWN_SAFE_RADIUS,
  biomeCoverage, GLOBAL_MOB_CAP, spawnableMobs, isInsideSafeRadius,
  applySafeZoneShield,
  type SpawnWorld,
} from '../server/src/mobs/spawner.ts';

/* ═════════════════════ 测试用内存世界 ═════════════════════ */

function makeWorld(opts: {
  players?: WorldPlayer[];
  items?: GroundItem[];
  walls?: Set<string>;
  stairs?: Map<string, number>;
} = {}): MobWorld & { events: string[]; spawned: GroundItem[]; floors: Map<string, number>; objs: Map<string, number> } {
  const events: string[] = [];
  const spawned: GroundItem[] = [];
  const floors = new Map<string, number>();
  const objs = new Map<string, number>();
  let items = [...(opts.items ?? [])];
  const players = opts.players ?? [];
  const walls = opts.walls ?? new Set<string>();
  return {
    events, spawned, floors, objs,
    probe: (x: number, y: number) => walls.has(`${Math.round(x)},${Math.round(y)}`),
    players: () => players,
    groundItems: () => items,
    consumeGroundItem: (itemId: number, count: number) => {
      const idx = items.findIndex((g) => g.id === itemId);
      if (idx < 0) return 0;
      const take = Math.min(count, items[idx].count);
      items = items.map((g, i) => (i === idx ? { ...g, count: g.count - take } : g)).filter((g) => g.count > 0);
      return take;
    },
    setFloor: (x: number, y: number, floor: number) => { floors.set(`${x},${y}`, floor); },
    placeObj: (x: number, y: number, obj: number) => { objs.set(`${x},${y}`, obj); },
    spawnItem: (x: number, y: number, itemId: number, count: number) => { spawned.push({ id: itemId, x, y, count }); },
    emit: (kind: string) => { events.push(kind); },
  };
}

function makePlayer(patch: Partial<WorldPlayer> = {}): WorldPlayer {
  return {
    id: 'p1', x: 0, y: 0, z: 0, facingDeg: 0, afk: false, heldItem: 0,
    wearing: [], playingInstrument: false, ...patch,
  };
}

function makeRuntime(mobId: string, patch: Partial<MobRuntime> = {}): MobRuntime {
  const def = MOB_BY_ID.get(mobId)!;
  const fsm = new MobFsm(mobId, {
    homeX: patch.x ?? 0, homeY: patch.y ?? 0, speed: BASE_MOVE_SPEED,
    aggroRadius: 8, attackRadius: 1.5,
    makeTelegraph: (self) => circleWarn(self.x, self.y, 1.5, 0.8),
  }, mulberry32(1));
  return {
    id: mobId, def, x: 0, y: 0, z: 0, hp: def.hp, maxHp: def.hp,
    facingDeg: 0, mem: {}, fsm, alive: true, warns: [], anchorX: 0, anchorY: 0,
    ...patch,
  };
}

/* ═════════════════════ 1. 冻结层消费面 ═════════════════════ */

test('W4-01 消费冻结层:24 种生物全部登记 AI 工厂且无回退实现', () => {
  eq(MOB_LIST.length, 24, '生物总数');
  for (const m of MOB_LIST) {
    const ai = createMobAi(m);
    eq(ai.constructor.name !== 'DefaultMobAi', true, `${m.id} 必须有专属 AI`);
  }
});

test('W4-02 敌对判定与 hostileMobs 冻结函数一致', () => {
  for (const m of MOB_LIST) {
    const expect = m.behavior === MobBehavior.HOSTILE || m.behavior === MobBehavior.HOSTILE_ELITE;
    eq(isHostile(m), expect, `${m.id} 敌对判定`);
  }
  eq(hostileMobs().length, 11, '敌对/精英总数');
  ok(tameableMobs().length >= 6, '可驯养至少 6 种');
});

/* ═════════════════════ 2. AOI 唤醒 / 休眠 ═════════════════════ */

test('W4-03 AOI 边界:恰好 32 格内唤醒、32.000000001 格不唤醒', () => {
  const p: AoiPlayer = { id: 'p', x: 0, y: 0, afk: false };
  eq(isInsideAoi(AOI_WAKE_DISTANCE, 0, [p]), true, '恰好 32 格应在圈内');
  eq(isInsideAoi(AOI_WAKE_DISTANCE + 1e-6, 0, [p]), false, '32+1e-6 应出圈');
  eq(isInsideAoi(-AOI_WAKE_DISTANCE, 0, [p]), true, '负方向 32 格应在圈内');
  const d = Math.SQRT1_2 * AOI_WAKE_DISTANCE;
  eq(isInsideAoi(d, d, [p]), true, '对角恰好 32 格应在圈内');
});

test('W4-04 AOI 挂机玩家不提供唤醒能量', () => {
  const p: AoiPlayer = { id: 'p', x: 1, y: 1, afk: true };
  eq(isInsideAoi(1, 1, [p]), false, '挂机玩家不唤醒');
  const p2: AoiPlayer = { id: 'p2', x: 1, y: 1, afk: false };
  eq(isInsideAoi(1, 1, [p2]), true, '在线玩家唤醒');
});

test('W4-05 AOI activeMobs 集合进出:进入唤醒、离开立即休眠', () => {
  const aoi = new AoiManager();
  aoi.registerMob('m1', 10, 10);
  aoi.registerMob('m2', 100, 100);
  aoi.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
  const r1 = aoi.update();
  eq(aoi.isActive('m1'), true, 'm1 距 14 格应唤醒');
  eq(aoi.isActive('m2'), false, 'm2 距 141 格应休眠');
  eq(r1.woke.length, 1, '唤醒 1 只');
  /* 玩家离开 → m1 立即休眠(无迟滞) */
  aoi.setPlayers([]);
  const r2 = aoi.update();
  eq(aoi.isActive('m1'), false, '玩家离开后立即休眠');
  eq(r2.slept.length, 1, '休眠 1 只');
});

test('W4-06 AOI 逐怪距离过滤:同区块内只有 ≤32 格的怪被唤醒', () => {
  const aoi = new AoiManager();
  /* 反例构造:4 只怪全在同一个 16×16 区块 [0,16)²,但只有 2 只落在 32 格内。
     若实现对「整块」唤醒,这 4 只都会进 activeMobs —— 断言会立刻抓住。 */
  aoi.registerMob('near1', 1, 1);      /* 距 (0,0) = 1.41  → 唤醒 */
  aoi.registerMob('near2', 20, 0);     /* 距 (0,0) = 20    → 唤醒(跨区块但在 32 内) */
  aoi.registerMob('chunk_far', 14, 14); /* 距 (0,0) = 19.8 → 唤醒 */
  aoi.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
  aoi.update();
  /* 同区块 (0,0) 内的 3 只都在 32 格内 → 都唤醒;真正的反例是下面那块 */
  eq(aoi.isActive('near1'), true, '1.41 格唤醒');
  eq(aoi.isActive('near2'), true, '20 格唤醒(跨区块)');
  eq(aoi.isActive('chunk_far'), true, '19.8 格唤醒');

  /* 再来一组真正的「同区块但不该唤醒」:玩家在 (-30,0),
     区块 [0,16)×[0,16) 里的怪分别距 31 格与 45 格 —— 同块不同判。 */
  const aoi2 = new AoiManager();
  aoi2.registerMob('in_block_near', 1, 0);
  aoi2.registerMob('in_block_far', 15, 0);
  eq(chunkKeyOf(1, 0), '0,0', '第一只怪区块键');
  eq(chunkKeyOf(15, 0), '0,0', '两只怪处于同一区块键');
  aoi2.setPlayers([{ id: 'p', x: -30, y: 0, afk: false }]);
  aoi2.update();
  eq(aoi2.isActive('in_block_near'), true, '同块且 31 格 ≤ 32 → 唤醒');
  eq(aoi2.isActive('in_block_far'), false, '同块但 45 格 → 必须休眠(证明是逐怪判定)');
  eq(aoi2.activeMobs.size, 1, '同区块只唤醒 1 只');
});

test('W4-07 AOI 休眠生物零 CPU:200 只中仅 30 只唤醒,其余 170 只调用计数冻结', () => {
  const aoi = new AoiManager();
  /* 200 只怪:30 只聚在玩家周围(6 列 × 5 行,间距 4.5 格,
     最远 hypot(22.5, 18) = 28.81 格,全部 ≤ 32),其余 170 只在 1000 格外。 */
  const nearby = 30;
  for (let i = 0; i < nearby; i += 1) {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const x = col * 4.5;
    const y = row * 4.5;
    ok(Math.hypot(x, y) <= AOI_WAKE_DISTANCE, `near${i} (${x},${y}) 必须在 32 格内`);
    aoi.registerMob(`near${i}`, x, y);
  }
  for (let i = 0; i < 170; i += 1) {
    aoi.registerMob(`far${i}`, 1000 + i * 40, 1000);
  }
  aoi.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
  aoi.update();
  eq(aoi.activeMobs.size, nearby, '恰好 30 只被唤醒');
  for (const i of [0, 1, 7, 29]) eq(aoi.isActive(`near${i}`), true, `near${i} 应唤醒`);
  for (const i of [0, 42, 169]) eq(aoi.isActive(`far${i}`), false, `far${i} 应休眠`);

  const before = aoi.activeStepCalls;
  const n = aoi.stepActive(() => { /* 模拟 AI tick */ });
  eq(n, nearby, '只对唤醒生物执行');
  eq(aoi.activeStepCalls - before, nearby, 'CPU 记账 = 唤醒数');
  eq(aoi.totalActiveTicks, nearby, '总 tick 数 = 唤醒数');

  /* 全部休眠后,再跑 100 帧:调用计数必须冻结 */
  aoi.setPlayers([]);
  aoi.update();
  eq(aoi.activeMobs.size, 0, '全部休眠');
  const frozen = aoi.activeStepCalls;
  for (let f = 0; f < 100; f += 1) aoi.stepActive(() => { throw new Error('休眠生物不应被调用'); });
  eq(aoi.activeStepCalls, frozen, '休眠 100 帧后 CPU 调用计数完全不变');
});

test('W4-07b AOI 区块键与迁移:跨区块移动不重复计数', () => {
  eq(chunkKeyOf(0, 0), '0,0');
  eq(chunkKeyOf(15, 15), '0,0');
  eq(chunkKeyOf(16, 0), '1,0');
  eq(chunkKeyOf(-1, -1), '-1,-1');
  const aoi = new AoiManager();
  aoi.registerMob('m', 0, 0);
  eq(aoi.mobCount, 1, '注册 1 只');
  aoi.moveMob('m', 100, 0);
  eq(aoi.mobCount, 1, '跨区块移动后仍是 1 只,无重复');
  aoi.unregisterMob('m');
  eq(aoi.mobCount, 0, '注销后归零');
});

test('W4-08 AOI 每帧扫描成本模型:200 只怪 30 只唤醒', () => {
  const cost = estimateAoiScanCost(1, 30);
  eq(cost.chunkLookups, 25, '单玩家覆盖上界 25 区块');
  eq(cost.preciseTests, 30, '精确判定 30 次');
  ok(cost.estimateUs < 50, `扫描成本应 < 50µs(实际 ${cost.estimateUs.toFixed(3)}µs)`);
});

/* ═════════════════════ 3. 三态 FSM 与 45° 避障 ═════════════════════ */

test('W4-09 45° 避障:直行优先,且恒为 3 次数组读取', () => {
  const noWall = () => false;
  const r = steer45(1, 0, 0, 0, noWall);
  eq(r.turn, 0, '无障碍直行');
  eq(r.reads, PROBE_READS_PER_STEP, '读取次数 = 3');
  near(r.dir.x, 1, 1e-12, '方向正确');
});

test('W4-10 45° 避障:前方阻挡时左偏 45°', () => {
  /* 只挡住正前方 → 选左偏 */
  const probe = (x: number) => x > 0.9 && Math.abs(0) < 0.1;
  const r = steer45(1, 0, 0, 0, (x, y) => probe(x) && Math.abs(y) < 0.1);
  eq(r.turn, -1, '左偏 45°');
  near(Math.atan2(r.dir.y, r.dir.x) * 180 / Math.PI, -45, 1e-9, '偏转角恰为 -45°');
});

test('W4-11 45° 避障:左前阻挡时右偏 45°', () => {
  /* 前方与左前方都挡 → 右偏 */
  const r = steer45(1, 0, 0, 0, (x, y) => x > 0.6 && y <= 0.05);
  eq(r.turn, 1, '右偏 45°');
  near(Math.atan2(r.dir.y, r.dir.x) * 180 / Math.PI, 45, 1e-9, '偏转角恰为 +45°');
});

test('W4-12 45° 避障:三向全堵时原路折返且仍只读 3 次', () => {
  const r = steer45(1, 0, 5, 5, () => true);
  eq(r.reads, 3, '全堵时读取次数仍为 3,不递归展开');
  near(r.dir.x, -1, 1e-12, '反向折返');
  eq(r.blocked.forward, true, '前堵');
  eq(r.blocked.left, true, '左堵');
  eq(r.blocked.right, true, '右堵');
});

test('W4-13 FSM 三态:IDLE → ALERT → TELEGRAPH → 结算 → 回 ALERT', () => {
  const fsm = new MobFsm('m', {
    homeX: 0, homeY: 0, speed: BASE_MOVE_SPEED, aggroRadius: 6, attackRadius: 1.2,
    makeTelegraph: (s) => circleWarn(s.x, s.y, 1.5, 0.8),
  }, mulberry32(7));
  eq(fsm.state, MobFsmState.IDLE_GRAZE, '初始 IDLE_GRAZE');
  const noWall = () => false;

  /* 距离 3 格 → 进 ALERT */
  fsm.tick({ x: 3, y: 0 }, noWall);
  eq(fsm.state, MobFsmState.ALERT_FLEE_OR_CHASE, '3 格进入 ALERT');

  /* 贴近 → 进 TELEGRAPH(攻击半径 1.2)。让目标直接压在脚下 */
  let hit: unknown = null;
  for (let i = 0; i < 200 && fsm.state !== MobFsmState.TELEGRAPH_ATTACK; i += 1) {
    hit = fsm.tick({ x: fsm.x, y: fsm.y }, noWall);
  }
  eq(fsm.state, MobFsmState.TELEGRAPH_ATTACK, '进入预警态');
  ok(fsm.telegraph !== null, '预警几何已创建');
  inRange(fsm.telegraph!.geom.warnSec, TELEGRAPH_SEC_MIN, TELEGRAPH_SEC_MAX, '预警时长在 [0.8, 1.5]');

  /* 推进预警时间 → 单次预警只结算 1 次。
     预警时长 0.8s = 16 帧;跑 16 帧恰好结算一次。 */
  const frames = Math.ceil(fsm.telegraph!.geom.warnSec / DT);
  let resolved = 0;
  for (let i = 0; i < frames; i += 1) {
    const g = fsm.tick({ x: fsm.x, y: fsm.y }, noWall);
    if (g) resolved += 1;
  }
  eq(resolved, 1, `单次预警在 ${frames} 帧内只结算一次`);
  eq(fsm.state, MobFsmState.ALERT_FLEE_OR_CHASE, '结算后回 ALERT');
  /* 攻击后摇保证不会同帧连发:再推进 20 帧(1.0s),后摇 1.2s 未结束 → 不再结算 */
  let after = 0;
  for (let i = 0; i < 20; i += 1) if (fsm.tick({ x: fsm.x, y: fsm.y }, noWall)) after += 1;
  eq(after, 0, '后摇期间(1.0s < 1.2s)不重复结算');
  /* 越过 1.2s 后摇,才允许下一轮起手 */
  let next = 0;
  for (let i = 0; i < 40; i += 1) if (fsm.tick({ x: fsm.x, y: fsm.y }, noWall)) next += 1;
  eq(next, 1, '后摇结束后恰好起手并结算第二轮一次');
});

test('W4-14 IDLE_GRAZE 目标点始终在出生点 4 格内', () => {
  const rng = mulberry32(42);
  const fsm = new MobFsm('m', {
    homeX: 10, homeY: 20, speed: BASE_MOVE_SPEED, aggroRadius: 6, attackRadius: 1,
    makeTelegraph: (s) => circleWarn(s.x, s.y, 1, 0.8),
  }, rng);
  for (let i = 0; i < 500; i += 1) {
    if (fsm.grazeTimer <= 0) fsm.resetGraze();
    const d = Math.hypot(fsm.grazeTarget.x - 10, fsm.grazeTarget.y - 20);
    ok(d <= GRAZE_RADIUS + 1e-12, `闲逛点 ${d} 超出半径 ${GRAZE_RADIUS}`);
    fsm.tick(null, () => false);
  }
});

test('W4-15 单怪单帧 steering 成本 < 0.01ms', () => {
  const start = process.hrtime.bigint();
  const ITER = 20000;
  for (let i = 0; i < ITER; i += 1) {
    steer45(Math.cos(i), Math.sin(i), i * 0.01, i * 0.01, () => (i & 1) === 0);
  }
  const perCallUs = Number(process.hrtime.bigint() - start) / 1000 / ITER;
  ok(perCallUs < 10, `单次 steer45 ${perCallUs.toFixed(4)}µs 应 < 10µs(0.01ms)`);
  ok(estimateFsmCostUs(30) < 10, `30 只怪单帧估算 ${estimateFsmCostUs(30)}µs < 10µs`);
});

/* ═════════════════════ 4. 五类预警几何精确判定 ═════════════════════ */

test('W4-16 预警几何:圆 — 边界内 / 恰好边上 / 差 1e-9', () => {
  const g = circleWarn(0, 0, 5);
  eq(insideWarn(g, 0, 0), true, '中心在内');
  eq(insideWarn(g, 4.999999999, 0), true, '略小于半径在内');
  eq(insideWarn(g, 5, 0), true, '恰好落在边上 → true');
  eq(insideWarn(g, 5 + 1e-9, 0), false, '半径 +1e-9 → false');
  eq(insideWarn(g, 5 - 1e-9, 0), true, '半径 -1e-9 → true');
  eq(insideWarn(g, 5 + 1e-12, 0), true, '半径 +1e-12 落在相对容差内 → true');
});

test('W4-17 预警几何:扇 — 半张角与半径双边界', () => {
  const g = sectorWarn(0, 0, 8, 0, 30);  /* 轴角 0°,±30° */
  eq(insideWarn(g, 7, 0), true, '轴向在内');
  eq(insideWarn(g, 4, 4), false, '45° 超出 ±30° → 在外');
  eq(insideWarn(g, Math.cos(30 * Math.PI / 180) * 7, Math.sin(30 * Math.PI / 180) * 7), true, '边界射线在内');
  const over = 30 + 1e-6;
  eq(insideWarn(g, Math.cos(over * Math.PI / 180) * 7, Math.sin(over * Math.PI / 180) * 7), false, '超角 1e-6 → 外');
  eq(insideWarn(g, 8, 0), true, '半径边界在内');
  eq(insideWarn(g, 8 + 1e-9, 0), false, '半径 +1e-9 → 外');
});

test('W4-18 预警几何:矩形 — 长轴与短轴双边界 + 旋转', () => {
  const g = rectWarn(0, 0, 5, 2, 0);
  eq(insideWarn(g, 5, 0), true, '长轴边界在内');
  eq(insideWarn(g, 5 + 1e-9, 0), false, '长轴 +1e-9 → 外');
  eq(insideWarn(g, 0, 2), true, '短轴边界在内');
  eq(insideWarn(g, 0, 2 + 1e-9), false, '短轴 +1e-9 → 外');
  eq(insideWarn(g, 4, -4), false, '角落外');
  /* 旋转 45° 后 (0,2) 应变成内部点,(0,2.01) 应在外 */
  const r45 = rectWarn(0, 0, 5, 2, 45);
  eq(insideWarn(r45, 0, 2), true, '旋转 45° 后短轴点在内');
  ok(!insideWarn(r45, 0, 2 + 1e-9) || insideWarn(r45, 0, 2), '旋转后边界容差一致');
});

test('W4-19 预警几何:环 — 内外双边界', () => {
  const g = ringWarn(0, 0, 3, 5, 1.0);
  eq(insideWarn(g, 0, 0), false, '环心为空');
  eq(insideWarn(g, 3, 0), true, '内径边界在内');
  eq(insideWarn(g, 3 - 1e-9, 0), false, '内径 -1e-9 → 外');
  eq(insideWarn(g, 5, 0), true, '外径边界在内');
  eq(insideWarn(g, 5 + 1e-9, 0), false, '外径 +1e-9 → 外');
  eq(insideWarn(g, 4, 0), true, '环带内');
});

test('W4-20 预警几何:旋转指针 — 随时间改变朝向', () => {
  const g = pointerWarn(0, 0, 12, 1, 0, 30, 1.0); /* 30°/s */
  eq(insideWarn(g, 6, 0, 0), true, 't=0 沿 +x 在内');
  eq(insideWarn(g, 0, 6, 0), false, 't=0 垂直于 +y 在外');
  eq(insideWarn(g, 0, 6, 3), true, 't=3s 转 90° → +y 在内');
  eq(insideWarn(g, -6, 0, 3), false, 't=3s 时 -x 在外');
  near(pointerAngleDeg(g, 3), 90, 1e-12, 't=3s 角度 = 90°');
  eq(insideWarn(g, 12, 0, 0), true, '指针末端边界在内');
  eq(insideWarn(g, 12 + 1e-9, 0, 0), false, '指针末端 +1e-9 在外');
  /* 指针锚定中心:负方向不应命中 */
  eq(insideWarn(g, -6, 0, 0), false, '指针只朝正向延伸,负向不命中');
});

test('W4-21 预警几何:五类齐备 + Z 层判定', () => {
  eq(WARN_SHAPES.length, 5, '五类几何齐备');
  const g = circleWarn(0, 0, 3);
  g.z = 2;
  g.zTolerance = 1.6;
  eq(insideWarnZ(g, 2), true, '同层');
  eq(insideWarnZ(g, 3.6), true, '容差边界在内');
  eq(insideWarnZ(g, 3.6 + 1e-9), false, '超出容差');
  eq(insideWarn3D(g, 1, 0, 0), false, '水平在内但 Z 不匹配 → 不结算');
  eq(insideWarn3D(g, 1, 0, 2), true, '水平与 Z 都匹配');
});

test('W4-22 TELEGRAPH_ATTACK 结算:圆内受伤、圆外安全', () => {
  const g = circleWarn(10, 10, 2.5, 1.0);
  eq(resolveTelegraphHit(g, 11, 10), true, '圆内命中');
  eq(resolveTelegraphHit(g, 12.5, 10), true, '边界命中');
  eq(resolveTelegraphHit(g, 12.5 + 1e-9, 10), false, '边界外 1e-9 安全');
});

/* ═════════════════════ 5. 24 种生物独特 AI ═════════════════════ */

test('W4-23 野猪:蓄力 1s → 直线冲锋 6 格 → 撞墙自晕 3s', () => {
  const world = makeWorld({ players: [makePlayer({ x: 11, y: 0 })] });
  const rt = makeRuntime('mob_boar', { x: 0, y: 0 });
  const ai = createMobAi(rt.def);

  /* 蓄力阶段:原地不动,计时 1 秒 */
  ai.tick(rt, world, DT);
  eq(rt.mem.phase, 1, '进入刨蹄蓄力');
  eq(rt.mem.windup, BOAR_WINDUP_SEC, '蓄力 = 1.0s');
  const x0 = rt.x;
  for (let i = 0; i < 19; i += 1) ai.tick(rt, world, DT);
  near(rt.x, x0, 1e-9, '蓄力期间原地不动');
  /* 第 20 帧正好 1.0s → 转冲锋 */
  ai.tick(rt, world, DT);
  eq(rt.mem.phase, 2, '切换为冲锋');

  /* 冲锋:无墙 → 前进到 6 格后停止 */
  for (let i = 0; i < 100 && rt.mem.phase === 2; i += 1) ai.tick(rt, world, DT);
  inRange(rt.mem.travel, BOAR_CHARGE_TILES, BOAR_CHARGE_TILES + 0.6, '冲锋距离 ≈ 6 格');
  eq(rt.mem.phase, 0, '冲锋结束回 idle');

  /* 撞墙 → 自晕 3 秒 */
  const world2 = makeWorld({
    players: [makePlayer({ x: 11, y: 0 })],
    walls: new Set(['2,0', '2,1', '2,-1', '2,0.5']),
  });
  const rt2 = makeRuntime('mob_boar', { x: 0, y: 0 });
  const ai2 = createMobAi(rt2.def);
  for (let i = 0; i < 300 && (rt2.mem.selfStun ?? 0) <= 0; i += 1) ai2.tick(rt2, world2, DT);
  eq(rt2.mem.selfStun, 3.0, '撞墙自晕 3.0s(手册 L466「引它撞墙或踩香蕉皮会自己撞晕 3 秒」)');
  eq(rt2.mem.phase, 0, '冲锋被中断');
  ok(world2.events.includes('boar_wall_stun'), '触发撞墙事件');
});

test('W4-24 卡皮巴拉:攻击反弹爱心、永不掉血', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_capybara');
  const ai = createMobAi(rt.def);
  const r = ai.onDamage(rt, world, 9999, DamageKind.PHYSICAL, 0);
  eq(r.hpLoss, 0, '零损血');
  eq(r.reflectHearts, CAPYBARA_REFLECT_HEARTS, '反弹 1 颗爱心');
  eq(rt.hp, rt.def.hp, 'HP 保持满值');
  eq(rt.alive, true, '不可击杀');
  ok(world.events.includes('capybara_heart_reflect'), '发射反弹爱心事件');
  /* 连续 100 次攻击仍不死 */
  for (let i = 0; i < 100; i += 1) ai.onDamage(rt, world, 500, DamageKind.EXPLOSION, 0);
  eq(rt.hp, rt.def.hp, '100 次攻击后仍满血');
  eq(rt.mem.reflectedHearts, 101, '累计反弹 101 颗');
});

test('W4-25 狸猫:伪装石灯笼直到玩家进入 2 格', () => {
  const far = makeWorld({ players: [makePlayer({ x: 10, y: 0 })] });
  const rt = makeRuntime('mob_tanuki');
  const ai = createMobAi(rt.def);
  ai.tick(rt, far, DT);
  eq(rt.mem.disguise, 1, '远处保持伪装');
  eq(rt.mem.disguiseAs, ITEM.LANTERN, '伪装成石灯笼');
  eq(rt.alive, true, '仍是宝箱/灯笼态');

  /* 玩家推进到恰好 2 格:现形 */
  const at2 = makeWorld({ players: [makePlayer({ x: TANUKI_REVEAL_DISTANCE, y: 0 })] });
  ai.tick(rt, at2, DT);
  eq(rt.mem.disguise, 0, '2 格内现形');
  eq(rt.mem.mistThrown, 1, '扔迷雾果');
  ok(at2.events.includes('tanuki_ambush'), '触发突袭事件');
  ok(at2.spawned.some((s) => s.id === 127), '生成迷雾果(幻彩变身菇)');
});

test('W4-26 剑客傀儡:正面 100% 格挡、背后不格挡、火椒箭点燃失效', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_samurai_bamboo', { facingDeg: 0, hp: 10000 });
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);

  /* 正面(0°)攻击 → 全格挡 */
  const front = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  eq(front.blocked, true, '正面被格挡');
  eq(front.hpLoss, 0, '正面零伤害');
  eq(rt.hp, 10000, 'HP 不变');

  /* 恰好 60°(弧边界)→ 仍格挡 */
  const edge = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, SAMURAI_FRONT_ARC_DEG / 2);
  eq(edge.blocked, true, '弧边界仍格挡');
  /* 差 1e-6 度 → 破防 */
  const justOut = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, SAMURAI_FRONT_ARC_DEG / 2 + 1e-6);
  eq(justOut.blocked, false, '超出弧 1e-6 度即不格挡');

  /* 背后(180°)→ 受伤且带 25% 背刺 */
  const hpBefore = rt.hp;
  const back = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 180);
  eq(back.blocked, false, '背后不格挡');
  near(back.hpLoss, 125, 1e-9, '背刺 125% 伤害');
  eq(rt.hp, hpBefore - 125, 'HP 正确扣除');

  /* 火椒箭 → 点燃干竹叶,格挡失效 */
  ai.onInteract(rt, world, 126, makePlayer());
  eq(rt.mem.armorBurnt, 1, '干竹叶被点燃');
  const burned = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  eq(burned.blocked, false, '点燃后正面不再格挡');
});

test('W4-27 音波蝠:三角铁干扰后坠地 4 秒', () => {
  const world = makeWorld({ players: [makePlayer({ x: 5, y: 0 })] });
  const rt = makeRuntime('mob_bat_sonic', { z: 3 });
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  /* 俯冲 → 发射环形音波 */
  let rings = 0;
  for (let i = 0; i < 40; i += 1) rings += ai.tick(rt, world, DT).length;
  eq(rings >= 1, true, '至少发射一次环形音波');
  eq(rt.mem.ringCount, 1, '环形音波计数');

  /* 敲响三角铁 → 坠地 */
  eq(ai.onInteract(rt, world, ITEM.TRIANGLE, makePlayer()), true, '三角铁生效');
  eq(rt.mem.fallSec, 4.0, '坠地 4.0s(设计基线 docs/WS-04-mob-ai.md §5;手册 L474 只述机制未给数值,见 DATA-CONFORMANCE §3.1)');
  eq(rt.z, 0, '坠地到地面');
  /* 4 秒内保持坠地、不再俯冲 */
  for (let i = 0; i < 79; i += 1) ai.tick(rt, world, DT);
  ok(rt.mem.fallSec > 0, '4 秒未到仍在坠地');
  ok(rt.mem.grounded === 1, '保持在地面');
  const ringsBefore = rt.mem.ringCount;
  for (let i = 0; i < 5; i += 1) ai.tick(rt, world, DT);
  eq(rt.mem.ringCount, ringsBefore, '坠地期间不再发射音波');
  /* 音符砖同样有效 */
  eq(ai.onInteract(rt, world, ITEM.NOTE_BLOCK, makePlayer()), true, '音符砖同样干扰声呐');
});

test('W4-28 紫晶甲虫:正面减伤 80%、爆破镐碎壳、掀翻露肚皮', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_beetle_crystal', { facingDeg: 0, hp: 10000 });
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  eq(rt.mem.frontDr, BEETLE_FRONT_DR, '正面减伤 80%');

  const front = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  near(front.hpLoss, 20, 1e-9, '正面 100 伤害只吃 20');

  const back = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 180);
  near(back.hpLoss, 100, 1e-9, '背后吃满伤害');

  /* 爆破冲击镐 → 碎壳,防御归零 */
  const hpBefore = rt.hp;
  const boom = ai.onDamage(rt, world, 50, DamageKind.EXPLOSION, 0);
  eq(rt.mem.shellBroken, 1, '外壳破碎');
  eq(rt.mem.frontDr, 0, '减伤归零');
  near(boom.hpLoss, 50, 1e-9, '碎壳这一击吃满');
  ok(rt.hp < hpBefore, 'HP 下降');
  const after = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  near(after.hpLoss, 100, 1e-9, '碎壳后正面不再减伤');

  /* 弹簧垫掀翻 → 肚皮双倍伤害 6 秒 */
  const rt2 = makeRuntime('mob_beetle_crystal', { facingDeg: 0, hp: 10000 });
  const ai2 = createMobAi(rt2.def);
  ai2.tick(rt2, world, DT);
  eq(ai2.onInteract(rt2, world, ITEM.SPRING_PAD, makePlayer()), true, '弹簧垫生效');
  eq(rt2.mem.bellyUp, 1, '肚皮朝天');
  const belly = ai2.onDamage(rt2, world, 100, DamageKind.PHYSICAL, 0);
  near(belly.hpLoss, 200, 1e-9, '露肚皮双倍伤害');
});

test('W4-29 姜饼小人:10 秒逃逸计时 + 飞索钩回', () => {
  const world = makeWorld({ players: [makePlayer({ x: 3, y: 0 })] });
  const rt = makeRuntime('mob_ginger_imp');
  const ai = createMobAi(rt.def);
  /* 计时器语义:第 1 个 tick 建立 10 秒计时并扣掉该帧 dt。 */
  ai.tick(rt, world, DT);
  near(rt.mem.escapeTimer, GINGER_ESCAPE_SEC - DT, 1e-12, '首帧后剩 9.95s');
  eq(rt.mem.escapeTimer + DT, GINGER_ESCAPE_SEC, '起始严格为 10.00s,未多扣');

  /* 逃逸必须发生在恰好第 200 个 20Hz tick(= 10.00s)。 */
  let escapeTick = -1;
  for (let i = 1; i < 400; i += 1) {
    ai.tick(rt, world, DT);
    if (rt.mem.escaped) { escapeTick = i + 1; break; }
  }
  eq(escapeTick, 200, '逃逸计时精确落在第 200 tick');
  eq(rt.alive, false, '消失');
  ok(world.events.includes('ginger_escaped'), '触发逃逸事件');
  ok(world.spawned.filter((s) => s.id === 128).length >= 9, '边跑边掉糖果(≥9 份)');

  /* 飞索钩爪钩回 */
  const world2 = makeWorld({ players: [makePlayer({ x: 3, y: 0 })] });
  const rt2 = makeRuntime('mob_ginger_imp');
  const ai2 = createMobAi(rt2.def);
  ai2.tick(rt2, world2, DT);
  for (let i = 0; i < 60; i += 1) ai2.tick(rt2, world2, DT); /* 跑到 3 秒 */
  const t3 = rt2.mem.escapeTimer;
  eq(ai2.onInteract(rt2, world2, ITEM.HOOK, makePlayer()), true, '钩爪生效');
  eq(rt2.mem.hooked, 1, '被钩中');
  ok(rt2.mem.escapeTimer > t3, '钩回后计时延长');
  eq(rt2.alive, true, '重新进入可捕捉状态');
});

test('W4-30 巧克力盾卫:遇火融化 70% 护甲并改写 9 格地形', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_choco_golem', { x: 5, y: 5, hp: 10000 });
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  eq(rt.mem.armor, 0.70, '初始护甲 70%');
  const cold = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  near(cold.hpLoss, 30, 1e-9, '非火焰 100 伤害只吃 30');

  /* 火焰攻击 → 融化 */
  const melted = ai.onDamage(rt, world, 100, DamageKind.FIRE, 0);
  eq(rt.mem.melted, 1, '巧克力护甲融化');
  eq(rt.mem.armor, 0, '护甲归零');
  near(melted.hpLoss, 100, 1e-9, '融化瞬间吃满');
  eq(world.floors.size, 9, '生成 3×3 = 9 格巧克力浆');
  eq([...world.floors.values()].every((v) => v === CHOCO_MELT_FLOOR), true, '全部为巧克力浆地形');
  ok(world.events.includes('choco_melted'), '触发融化事件');

  const after = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  near(after.hpLoss, 100, 1e-9, '融化后不再有护甲');
});

test('W4-31 竖琴风精鸟:合奏送星辰碎片', () => {
  const world = makeWorld({ players: [makePlayer({ x: 3, y: 0, playingInstrument: true })] });
  const rt = makeRuntime('mob_harpy_harp');
  const ai = createMobAi(rt.def) as { tick: Function; ensemble: Function };
  ai.tick(rt, world, DT);
  eq(rt.mem.gifted, undefined, '未合奏前无馈赠');
  /* 门禁:非乐器不累加 */
  eq(ai.ensemble(rt, world, 1.0, 101), false, '手持原木不是乐器,拒不累加');
  eq(rt.mem.ensembleSec, undefined, '非乐器完全不进入累计器');
  /* 致命风压:玩家在悬崖边 → 吹落云海 */
  const cliffWorld = makeWorld({ players: [makePlayer({ x: 1, y: 0, playingInstrument: true })] });
  const rtG = makeRuntime('mob_harpy_harp');
  const aiG = createMobAi(rtG.def) as { tick: Function };
  const gusts = aiG.tick(rtG, cliffWorld, DT);
  eq(gusts.length, 1, '悬崖边玩家触发狂风');
  eq(rtG.mem.gustForce, 9.0, '风压 9.0 格/秒(设计基线 docs/WS-04-mob-ai.md §5;手册 L483 只述「吹落云海」未给数值)');
  eq(gusts[0].kind, 'SECTOR', '风压是扇形');
  eq(gusts[0].halfDeg, 35, '70° 扇形(半张角 35°)');
  /* 风向正对玩家(玩家在 (1,0) → 轴向 0°)。 */
  near(gusts[0].centerDeg, 0, 1e-9, '扇形轴角指向玩家');
  eq(insideWarn(gusts[0], 3, 0), true, '扇形轴线上命中');
  eq(insideWarn(gusts[0], 1, 0), true, '玩家所在点命中');
  const edgeDeg = 35;
  eq(insideWarn(gusts[0], Math.cos(edgeDeg * Math.PI / 180) * 5, Math.sin(edgeDeg * Math.PI / 180) * 5),
    true, '恰好在 35° 边界线上命中');
  eq(insideWarn(gusts[0], 0, 3), false, '90° 方向在扇形外');
  eq(insideWarn(gusts[0], 7, 0), false, '超出 6 格长度');
  /* 合奏 5 秒(20Hz × 5s = 100 帧) */
  let got = false;
  for (let i = 0; i < 100; i += 1) {
    if (ai.ensemble(rt, world, DT, 253)) { got = true; break; }
  }
  eq(got, true, '合奏满 5 秒触发馈赠');
  eq(rt.mem.friendly, 1, '转为友好');
  eq(ai.ensemble(rt, world, DT, 253), false, '已友好后不重复馈赠');
  ok(world.spawned.some((s) => s.id === ITEM.STAR_SHARD), '送出极光星辰碎片(117)');
  ok(world.events.includes('harpy_ensemble_gift'), '触发合奏事件');
});

test('W4-32 火灵:遇水固化黑曜石、走过草地变焦炭', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_lava_elem', { x: 3, y: 3 });
  const ai = createMobAi(rt.def);
  /* 走动 1 秒 → 焦炭地形 */
  for (let i = 0; i < 20; i += 1) ai.tick(rt, world, DT);
  ok(world.floors.size >= 9, `地形被改写为焦炭(实际 ${world.floors.size} 格)`);
  ok([...world.floors.values()].includes(320), '写入炙热烫脚火炭砖');

  /* 水枪 → 固化黑曜石 */
  eq(ai.onInteract(rt, world, ITEM.WATER_GUN, makePlayer()), true, '水枪生效');
  eq(rt.mem.solidified, 1, '固化为黑曜石');
  eq(rt.mem.movable, 0, '失去移动能力');
  ok([...world.objs.values()].includes(ITEM.OBSIDIAN_BLOCK), '原地生成黑曜石块(110)');
  const solidified = ai.onDamage(rt, world, 500, DamageKind.PHYSICAL, 0);
  eq(solidified.blocked, true, '固化后不再受伤');
  /* 水属性伤害同样触发固化 */
  const rt2 = makeRuntime('mob_lava_elem', { x: 9, y: 9 });
  const ai2 = createMobAi(rt2.def);
  const w2 = makeWorld();
  const water = ai2.onDamage(rt2, w2, 999, DamageKind.WATER, 0);
  eq(w2.events.includes('lava_solidified'), true, '水属性伤害触发固化');
  eq(water.hpLoss, 0, '固化时以护盾吸收');
});

test('W4-33 发条重骑:背后钥匙被钩爪拔下后瘫痪 8 秒', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_clock_knight', { facingDeg: 0, hp: 10000, x: 0, y: 0 });
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  eq(rt.mem.frontDr, KNIGHT_FRONT_DR, '正面减伤 90%');
  const front = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  near(front.hpLoss, 10, 1e-9, '正面 100 只吃 10');

  /* 从正面钩 → 失败 */
  const frontHook = ai.onInteract(rt, world, ITEM.HOOK, makePlayer({ x: 3, y: 0 }));
  eq(frontHook, false, '正面钩不到钥匙');
  eq(rt.mem.lastHookFromBack, 0, '标记为非背后');

  /* 从背后钩 → 拔下钥匙 → 瘫痪 */
  const backHook = ai.onInteract(rt, world, ITEM.HOOK, makePlayer({ x: -3, y: 0 }));
  eq(backHook, true, '背后钩成功拔下钥匙');
  eq(rt.mem.keyPulled, 1, '钥匙被拔下');
  eq(rt.mem.paralyzedSec, 8.0, '瘫痪 8.0s(设计基线 docs/WS-04-mob-ai.md §5;手册 L487 只述「拔下钥匙使其断电瘫痪」未给时长)');
  ai.tick(rt, world, DT);
  eq(rt.mem.frontDr, 0, '瘫痪后巨甲失效');
  const vuln = ai.onDamage(rt, world, 100, DamageKind.PHYSICAL, 0);
  near(vuln.hpLoss, 200, 1e-9, '瘫痪期间双倍输出');
  ok(world.events.includes('knight_key_pulled'), '触发断电事件');
});

test('W4-34 河狸:偷木板筑坝、充气大锤敲晕夺回', () => {
  const world = makeWorld({ items: [{ id: ITEM.PLANK, x: 1, y: 0, count: 5 }] });
  const rt = makeRuntime('mob_beaver');
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  eq(rt.mem.stolenTotal, 1, '偷走 1 块木板');
  /* 攒 2 块后开始筑坝 */
  for (let i = 0; i < 40; i += 1) ai.tick(rt, world, DT);
  ok((rt.mem.stolenTotal ?? 0) >= 2, '累计偷 ≥2 块');
  /* 推进 3 秒 → 坝体 +1 格 */
  for (let i = 0; i < 70; i += 1) ai.tick(rt, world, DT);
  ok((rt.mem.damCells ?? 0) >= 1, '坝体开始生长');
  ok(world.objs.size >= 1, '放置了坝体方块');

  /* 充气大锤 */
  const carried = rt.mem.carrying ?? 0;
  eq(ai.onInteract(rt, world, ITEM.INFLATE_HAMMER, makePlayer()), true, '大锤敲晕');
  eq(rt.mem.stun, 5.0, '眩晕 5 秒');
  eq(rt.mem.carrying, 0, '掉光木头');
  ok(world.events.includes('beaver_hammered'), '触发夺回事件');
  ok(world.spawned.some((s) => s.id === ITEM.PLANK), '木板掉回地面');
});

test('W4-35 雷云闪电球:链接金属、引雷头盔反哺攻速可叠加', () => {
  const world = makeWorld({
    items: [{ id: 522, x: 1, y: 0, count: 1 }, { id: 155, x: 2, y: 0, count: 1 }, { id: 243, x: 3, y: 0, count: 1 }],
    players: [makePlayer({ wearing: [ITEM.LIGHTNING_HELM] })],
  });
  const rt = makeRuntime('mob_thunder_sprite');
  const ai = createMobAi(rt.def) as { tick: Function; helmAtkSpeedBuff: Function };
  ai.tick(rt, world, DT);
  eq(rt.mem.discharges, 1, '放电一次');
  eq(rt.mem.metalLinks, 3, '链接 3 个金属物体');
  eq(rt.mem.helmAbsorbs, 1, '引雷头盔吸收 1 次');

  /* 连续放电 → 攻速叠加。不变量:层数 == 放电次数,且被 THUNDER_HELM_STACK_MAX 上限截断。 */
  for (let i = 0; i < 200; i += 1) ai.tick(rt, world, DT);
  const buff = ai.helmAtkSpeedBuff(rt, makePlayer({ wearing: [ITEM.LIGHTNING_HELM] }));
  ok(buff > 1, `攻速应被反哺(实际倍率 ${buff.toFixed(2)})`);
  const absorbs = rt.mem.helmAbsorbs;
  eq(absorbs, rt.mem.discharges, '吸收次数 == 放电次数(不重复计数)');
  eq(rt.mem.helmBuffStacks, absorbs, '层数 = 吸收次数,每次 +15%');
  near(buff, 1 + 0.15 * absorbs, 1e-9, `攻速倍率 1+0.15x${absorbs}`);
  /* 上限:继续放电 40 秒,层数封顶 5 且倍率封顶 1.75。
   * 数值锚定**字面量 5**(设计基线:`docs/WS-04-mob-ai.md` §5「THUNDER_HELM_STACK_MAX | 5 |
   * 本设计:攻速层数上限」;手册 L484 只述「吸收闪电转化为自身攻速」未给层数)。
   * 原为 `THUNDER_HELM_STACK_MAX` —— 与被测实现同源 ⇒ 改成 8 后本组仍全绿(实测)。
   * 锚成字面量后,实现若改动上限,`helmBuffStacks` 与 1.75 两处都会立刻报错。 */
  for (let i = 0; i < 800; i += 1) ai.tick(rt, world, DT);
  const capped = ai.helmAtkSpeedBuff(rt, makePlayer({ wearing: [ITEM.LIGHTNING_HELM] }));
  eq(rt.mem.helmBuffStacks, 5, '层数封顶 5(设计基线)');
  near(capped, 1 + 0.15 * 5, 1e-9, '倍率封顶 1.75');
  ok(rt.mem.helmAbsorbs > 5, '原始吸收次数继续累计(不受上限影响)');
  /* 未佩戴 → 无加成 */
  eq(ai.helmAtkSpeedBuff(rt, makePlayer({ wearing: [] })), 0, '未佩戴头盔无加成');
});

test('W4-36 发条伪装宝箱:以宝箱伪装直到被打开', () => {
  const far = makeWorld({ players: [makePlayer({ x: 9, y: 0 })] });
  const rt = makeRuntime('mob_mimic_cog');
  const ai = createMobAi(rt.def);
  ai.tick(rt, far, DT);
  eq(rt.mem.looksLikeChest, 1, '伪装成宝箱');
  eq(rt.mem.disguise, 1, '未暴露');
  const near1 = makeWorld({ players: [makePlayer({ x: 0.5, y: 0 })] });
  ai.tick(rt, near1, DT);
  eq(rt.mem.disguise, 0, '玩家贴近后暴露');
  eq(rt.mem.gearTeeth, 12, '亮出 12 颗齿轮尖牙');
  ok(near1.events.includes('mimic_ambush'), '触发突袭事件');
  /* 喂炸弹果 → 爆金装 */
  const before = near1.spawned.length;
  eq(ai.onInteract(rt, near1, ITEM.BOMB_FRUIT, makePlayer()), true, '炸弹果生效');
  eq(rt.alive, false, '被炸开');
  eq(near1.spawned.length - before, 6, '爆出 6 份金装材料');
});

test('W4-37 毒尾蝎:潜伏沙下 + 引水逼现形 + 毒液球几何', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_scorpion');
  const ai = createMobAi(rt.def) as { tick: Function; onInteract: Function; poisonGeom: Function };
  ai.tick(rt, world, DT);
  eq(rt.mem.buried, 1, '潜伏沙下');
  eq(rt.mem.visible, 0, '不可见');
  /* 5 秒后钻出 */
  for (let i = 0; i < 100; i += 1) ai.tick(rt, world, DT);
  eq(rt.mem.ambush, 1, '钻出突袭一次');
  /* 引水 → 强制现形 */
  const rt2 = makeRuntime('mob_scorpion');
  const ai2 = createMobAi(rt2.def) as { tick: Function; onInteract: Function; poisonGeom: Function };
  ai2.tick(rt2, world, DT);
  eq(ai2.onInteract(rt2, world, ITEM.WATER_GUN, makePlayer()), true, '引水生效');
  eq(rt2.mem.visible, 1, '强制现形');
  eq(rt2.mem.forcedSurface, 1, '记录强制现形');
  const g = ai2.poisonGeom(rt2, 5, 5);
  eq(insideWarn(g, 5, 5), true, '毒液球圆心命中');
  eq(insideWarn(g, 5 + 1.2, 5), true, '毒液球边界命中');
  eq(insideWarn(g, 5 + 1.2 + 1e-9, 5), false, '毒液球边界外 1e-9 安全');
});

test('W4-38 布丁法师:焦糖球困人 + 为果冻怪加血', () => {
  const world = makeWorld({ players: [makePlayer({ x: 5, y: 0 })] });
  const rt = makeRuntime('mob_pudding_mage');
  const ai = createMobAi(rt.def) as { tick: Function; healNearby: Function };
  const warns = ai.tick(rt, world, DT);
  eq(warns.length, 1, '发射 1 个焦糖球预警');
  eq(rt.mem.caramelShots, 1, '焦糖球计数');
  const slimes = [
    { x: 2, y: 0, hp: 10, maxHp: 100 },
    { x: 5, y: 0, hp: 10, maxHp: 100 },
    { x: 100, y: 0, hp: 10, maxHp: 100 },
  ];
  const healed = ai.healNearby(rt, slimes);
  eq(healed, 2, '6 格内 2 只果冻怪被治疗');
  eq(slimes[0].hp, 50, '治疗 +40');
  eq(slimes[2].hp, 10, '范围外不治疗');
});

test('W4-39 陆行鸟:蜂蜜粘脚才能驯服、坐骑移速 +60%', () => {
  const world = makeWorld();
  const rt = makeRuntime('mob_chocobo');
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  eq(rt.mem.speedMul, 2.2, '平时极速奔跑');
  eq(rt.mem.canBeTamed, 0, '跑动中无法驯服');
  /* 跑动中喂食无效 */
  eq(ai.onInteract(rt, world, ITEM.WHEAT, makePlayer()), false, '跑动中喂食被拒');
  /* 蜂蜜罐粘住 */
  eq(ai.onInteract(rt, world, ITEM.HONEY_JAR, makePlayer()), true, '蜂蜜罐生效');
  ai.tick(rt, world, DT);
  eq(rt.mem.speedMul, 0.30, '粘住后移速降到 30%');
  eq(rt.mem.canBeTamed, 1, '粘住后可驯服');
  /* 喂 3 个黄金小麦 */
  ai.onInteract(rt, world, ITEM.WHEAT, makePlayer());
  ai.onInteract(rt, world, ITEM.WHEAT, makePlayer());
  eq(rt.mem.tamed, undefined, '2 个还不够');
  ai.onInteract(rt, world, ITEM.WHEAT, makePlayer());
  eq(rt.mem.tamed, 1, '3 个黄金小麦驯服成功');
  near(rt.mem.mountSpeedMul, 1.6, 1e-9, '坐骑移速 +60%');
});

test('W4-40 穿山甲:滚球撞墙眩晕、充气大锤反抽', () => {
  const world = makeWorld({ players: [makePlayer({ x: 5, y: 0 })] });
  const rt = makeRuntime('mob_pangolin');
  const ai = createMobAi(rt.def);
  ai.tick(rt, world, DT);
  eq(rt.mem.rolling, 1, '缩成石球滚动');
  near(rt.mem.ballRadius, 0.7, 1e-9, '石球半径');
  eq(ai.onInteract(rt, world, ITEM.INFLATE_HAMMER, makePlayer()), true, '大锤反抽生效');
  eq(rt.mem.directionReversed, 1, '方向反转');
  eq(rt.mem.stunSec, 4.0, '眩晕 4 秒');
  ok(world.events.includes('pangolin_batted'), '触发反抽事件');
});

test('W4-41 其余生物分支:绵羊/果冻怪/花栗鼠/河蟹/萤火蛙/云魔鬼鱼', () => {
  /* 绵羊:受惊弹跳逃跑 */
  const ws = makeWorld({ players: [makePlayer({ x: 3, y: 0 })] });
  const rs = makeRuntime('mob_sheep');
  const ais = createMobAi(rs.def);
  ais.tick(rs, ws, DT);
  eq(rs.mem.scared, 1, '5 格内受惊');
  eq(rs.mem.fleeSpeedMul, 1.6, '弹跳逃跑 1.6 倍速');

  /* 果冻怪:优先吃甜莓 */
  const wg = makeWorld({
    players: [makePlayer({ x: 1, y: 0 })],
    items: [{ id: ITEM.BERRY, x: 6, y: 0, count: 1 }],
  });
  const rg = makeRuntime('mob_slime_green', { x: 0, y: 0 });
  const aig = createMobAi(rg.def);
  aig.tick(rg, wg, DT);
  eq(rg.mem.targetIsBerry, 1, '有甜莓时优先吃果,忽略玩家');
  for (let i = 0; i < 400 && !rg.mem.scale; i += 1) aig.tick(rg, wg, DT);
  eq(rg.mem.scale, 2, '吃掉甜莓后变大');

  /* 花栗鼠:跳跃窜动 + 藏松果 */
  const rq = makeRuntime('mob_squirrel');
  const aiq = createMobAi(rq.def);
  aiq.tick(rq, makeWorld(), DT);
  ok(rq.mem.hopZ > 0, '跳跃抛物线离地');
  for (let i = 0; i < 30; i += 1) aiq.tick(rq, makeWorld(), DT);
  eq(rq.mem.stored, 1, '藏 1 颗松果到树洞');

  /* 铁钳河蟹:横移偏向 */
  const wc = makeWorld({ players: [makePlayer({ x: 0, y: 5 })] });
  const rc = makeRuntime('mob_crab_river', { x: 0, y: 0 });
  const aic = createMobAi(rc.def);
  aic.tick(rc, wc, DT);
  near(rc.mem.sideBias, 1.5, 1e-9, '横向偏置 1.5');
  ok(Math.abs(rc.mem.moveX) > Math.abs(rc.mem.moveY), '横向分量占优');

  /* 萤火蛙:吐舌捕虫 + 驯化后当灯 */
  const rf = makeRuntime('mob_glow_frog');
  const wf = makeWorld({ players: [makePlayer({ x: 3, y: 0 })] });
  const aif = createMobAi(rf.def);
  const tongue = aif.tick(rf, wf, DT);
  eq(tongue.length, 1, '吐出舌头(1 条细长矩形)');
  near(tongue[0].halfWidth, 0.15, 1e-9, '舌头宽度 0.3');
  eq(rf.mem.lightRadius, 2, '野生时微光半径 2');
  aif.onInteract(rf, wf, ITEM.BERRY, makePlayer());
  aif.tick(rf, wf, DT);
  eq(rf.mem.lightRadius, 6, '驯化后照明半径 6');

  /* 云魔鬼鱼:背上搭顺风车 */
  const rm = makeRuntime('mob_sky_manta');
  const wm = makeWorld({ players: [makePlayer({ x: 0, y: 0, z: 4 })] });
  const aim = createMobAi(rm.def) as { tick: Function };
  aim.tick(rm, wm, DT);
  near(rm.mem.glideSpeed, 1.8, 1e-9, '滑翔速度 1.8 格/秒');
  ok(rm.mem.rideable === 1, '可搭顺风车');
  for (let i = 0; i < 5; i += 1) aim.tick(rm, wm, DT);
  ok(wm.events.includes('manta_ride'), '载人事件触发');
});

/* ═════════════════════ 6. 驯养 / 牧场 / 出战上限 ═════════════════════ */

test('W4-42 驯养流程:喂食 → 驯化 → 三指令', () => {
  const pet = createPetRecord('mob_sheep')!;
  eq(pet.stage, TameStage.WILD, '初始野生');
  /* 错误物品 */
  const bad = feedPet(pet, 999);
  eq(bad.ok, false, '错误物品被拒');
  eq(bad.reason, 'wrong_item', '拒绝原因');
  eq(pet.fedCount, 0, '计数不增长');
  /* 正确物品 */
  const good = feedPet(pet, 123);
  eq(good.ok, true, '喂食成功');
  eq(pet.stage, TameStage.TAMED, '一次喂食即驯化(绵羊)');
  /* 已驯化再喂 */
  eq(feedPet(pet, 123).reason, 'already_tamed', '重复喂食被拒');
  /* 三指令 */
  for (const c of [TameCommand.FOLLOW, TameCommand.STAY, TameCommand.CARRY] as const) {
    eq(commandPet(pet, c), true, `指令 ${c} 生效`);
    eq(pet.command, c, `指令切到 ${c}`);
  }
});

test('W4-43 驯养边界:未驯化生物拒不服从、不可驯化生物拒绝喂食', () => {
  const pet = createPetRecord('mob_sheep')!;
  eq(commandPet(pet, TameCommand.FOLLOW), false, '野生生物拒不服从');
  eq(createPetRecord('mob_boar'), null, '野猪不可驯养');
  eq(canTame('mob_boar'), false, '敌对生物不可驯养');
  eq(canTame('mob_sheep'), true, '绵羊可驯养');
  const cov = tamingCoverage();
  eq(cov.total, 24, '覆盖 24 种');
  ok(cov.tameable >= 6, `可驯养 ${cov.tameable} 种`);
  /* 陆行鸟需要 3 次喂食 */
  const choco = createPetRecord('mob_chocobo')!;
  eq(choco.requiredFeeds, 3, '陆行鸟需 3 次');
  feedPet(choco, 123);
  eq(choco.stage, TameStage.FED, '1 次后仅 FED');
  feedPet(choco, 123);
  eq(choco.stage, TameStage.FED, '2 次仍 FED');
  feedPet(choco, 123);
  eq(choco.stage, TameStage.TAMED, '3 次驯化');
});

test('W4-44 宠物出战上限:默认 1 只,628 头饰解锁 2 只', () => {
  eq(deployLimit([]), 1, '默认上限 1');
  eq(deployLimit([DEPLOY_BADGE_ID]), 2, '戴头饰上限 2');
  eq(deployLimit([1, 2, 3]), 1, '无关物品不影响');
  const a = createPetRecord('mob_sheep')!;
  const b = createPetRecord('mob_squirrel')!;
  const pets = [a, b];
  feedPet(a, 123); feedPet(b, 121);
  eq(deployPet(pets, a, []).ok, true, '第 1 只出战成功');
  const second = deployPet(pets, b, []);
  eq(second.ok, false, '无头饰时第 2 只被拒');
  eq(second.reason, 'limit_reached', '拒绝原因 = 上限');
  const withBadge = deployPet(pets, b, [DEPLOY_BADGE_ID]);
  eq(withBadge.ok, true, '戴 628 后可出战第 2 只');
  eq(withBadge.deployed, 2, '同时出战 2 只');
  /* 第 3 只仍被拒 */
  const c = createPetRecord('mob_glow_frog')!;
  feedPet(c, 121);
  eq(deployPet([a, b, c], c, [DEPLOY_BADGE_ID]).reason, 'limit_reached', '第 3 只仍被拒');
});

test('W4-45 牧场自动产出:按周期产出,同类 ≥3 只额外 +1', () => {
  const pets = [
    createPetRecord('mob_sheep')!, createPetRecord('mob_sheep')!, createPetRecord('mob_sheep')!,
  ];
  for (const p of pets) { feedPet(p, 123); sendToRanch(pets, p); }
  eq(pets.every((p) => p.inRanch), true, '全部入栏');
  eq(tickRanch(pets, 0).length, 0, '未到周期不产出');
  /* 周期值锚定**字面量 600**(设计基线:`docs/WS-04-mob-ai.md` §5「RANCH_PRODUCE_SEC | 600 |
   * 本设计:1 游戏日产出一份」;手册仅见 L350「每日产出」,未给秒数)。
   * 此处原为 `tickRanch(pets, RANCH_PRODUCE_SEC)` —— 常量既当「时间轴」输入、又是实现内部的
   * 周期阈值,两边同源 ⇒ 把实现改成 607 后 `600+1` 仍会被判为「周期内」,断言全绿(实测)。
   * 锚成字面量后,实现若偏离 600,`y1.length` 会立刻变 0 而报错。 */
  const y1 = tickRanch(pets, 600);
  eq(y1.length, 3, '3 只各处一份(周期 600s 到点)');
  eq(y1[0].count, 2, '同类 3 只 → 额外 +1');
  eq(tickRanch(pets, 601).length, 0, '周期内不重复产出(600s 后 1 秒不再产出)');

  /* 2 只同类无加成 */
  const two = [createPetRecord('mob_sheep')!, createPetRecord('mob_sheep')!];
  for (const p of two) { feedPet(p, 123); sendToRanch(two, p); }
  eq(tickRanch(two, 600)[0].count, 1, '2 只无群体加成');

  /* ── 周期下沿(补齐单边盲区)──────────────────────────────────────────
   * 上面那两条只钉了**上沿**:`tickRanch(pets, 600)` 能产出、
   * `601` 不能。但 `now - lastProduceAt < RANCH` 这个判据对
   * **任何 RANCH ≤ 600** 都成立(600 < RANCH 为假)⇒ 把实现改成
   * `RANCH_PRODUCE_SEC = 2` 或 `10` 时,两条断言仍全绿(实测扫描:
   * 2/10/100/300/500/590/599 **全部漏检**)。
   *
   * 故补一条**受控下沿**:让 `lastProduceAt = 1`,于是
   * `tickRanch(_, 600)` 的 elapsed 恰为 **599**(比周期短 1 秒)。
   * 正确实现必须「不产出」;而 RANCH ≤ 599 的实现会产出 ⇒ 立刻报错。
   * 与上沿合起来,周期值 600 被**双向钉死**。 */
  const edge = [createPetRecord('mob_sheep', 1)!];
  for (const p of edge) { feedPet(p, 123); sendToRanch(edge, p); }
  eq(tickRanch(edge, 600).length, 0, '周期差 1 秒不产出(599s < 600s)');
  eq(tickRanch(edge, 601).length, 1, '满周期即产出(600s,下沿紧邻上沿)');
});

test('W4-46 背物资指令:负载随等级增长、移速惩罚', () => {
  eq(carrySlots('mob_sheep'), 4, 'Lv1 → 4 格');
  eq(carrySlots('mob_clock_knight'), 9, 'Lv25 → 4+5 = 9 格');
  ok(carrySlots('mob_clock_knight') <= 12, '不超过 12 格上限');
  const pet = createPetRecord('mob_sheep')!;
  feedPet(pet, 123);
  commandPet(pet, TameCommand.CARRY);
  eq(carrySlots(pet.mobId), 4, '负载上限');
});

/* ═════════════════════ 7. 刷怪 / 光照抑制 / 安全区 ═════════════════════ */

function spawnWorld(patch: Partial<SpawnWorld> & { floors?: Map<string, number>; objs?: Map<string, number> } = {}): SpawnWorld {
  const floors = patch.floors ?? new Map<string, number>();
  const objs = patch.objs ?? new Map<string, number>();
  return {
    objAt: (x, y) => objs.get(`${x},${y}`) ?? 0,
    floorAt: (x, y) => floors.get(`${x},${y}`) ?? 0,
    blocked: () => false,
    townCenter: () => ({ x: -1000, y: -1000 }),
    isNight: () => true,
    ...patch,
  };
}

test('W4-47 光照抑制:309 夜路砖所在格不刷怪', () => {
  const floors = new Map<string, number>([['10,10', NIGHT_BRICK_ID]]);
  const world = spawnWorld({ floors });
  const at = lightSuppressed(world, 10, 10);
  eq(at.suppressed, true, '砖上被抑制');
  eq(at.reason, 'NIGHT_BRICK', '抑制原因');
  eq(lightSuppressed(world, 11, 10).suppressed, true, '相邻 1 格也被微光抑制');
  eq(lightSuppressed(world, 13, 10).suppressed, false, '3 格外不受影响');
  const dec = decideSpawn(
    { biome: 'MEADOW', x: 10, y: 10, biomeCount: 0, globalCount: 0, mobId: 'mob_boar' },
    world, 0.9,
  );
  eq(dec.spawn, false, '夜路砖上不刷新');
  eq(dec.reason, 'NIGHT_BRICK', '拒绝原因');
});

test('W4-48 光照抑制:522 路灯 5 格内不刷夜行怪', () => {
  const objs = new Map<string, number>([['20,20', STREET_LAMP_ID]]);
  const world = spawnWorld({ objs });
  eq(lightSuppressed(world, 20, 20).suppressed, true, '灯下抑制');
  eq(lightSuppressed(world, 20 + STREET_LAMP_RADIUS, 20).suppressed, true, '恰好 5 格抑制');
  eq(lightSuppressed(world, 20, 20 + STREET_LAMP_RADIUS).suppressed, true, '纵向恰好 5 格抑制');
  eq(lightSuppressed(world, 20 + STREET_LAMP_RADIUS + 1, 20).suppressed, false, '6 格不抑制');
  /* 对角 5 格:半径是欧氏,对角 (4,4) 距离 5.66 > 5 不抑制 */
  eq(lightSuppressed(world, 24, 24).suppressed, false, '对角 (4,4) 距离 5.66 > 5 → 不抑制');
  /* 半径覆盖内的对角点 (3,3)=4.24 → 抑制 */
  eq(lightSuppressed(world, 23, 23).suppressed, true, '对角 (3,3) 距离 4.24 ≤ 5 → 抑制');

  const dec = decideSpawn(
    { biome: 'CAVERN', x: 20, y: 20, biomeCount: 0, globalCount: 0, mobId: 'mob_bat_sonic' },
    world, 0.9,
  );
  eq(dec.spawn, false, '路灯下不刷夜行怪');
});

test('W4-49 城镇安全区:24 格内不刷怪且玩家受护盾', () => {
  /* 半径锚定**字面量 24**(设计基线:`docs/WS-04-mob-ai.md` §5「TOWN_SAFE_RADIUS | 24 |
   * 本设计:城镇安全区」;手册 L356 只述「开启/关闭城镇安全区免怪侵扰护盾」未给半径)。
   * 原为 `TOWN_SAFE_RADIUS` —— 与被测实现同源 ⇒ 改成 31 后本组仍全绿(实测)。
   * 锚成字面量后,实现若改动半径,下面「恰好 24 格」与「24+ε」两条会同时报错。 */
  const world = spawnWorld({ townCenter: () => ({ x: 0, y: 0 }) });
  eq(inSafeZone(world, 24, 0), true, '恰好 24 格在安全区(设计基线)');
  eq(inSafeZone(world, 24 + 1e-6, 0), false, '24+ε 出安全区');
  const dec = decideSpawn(
    { biome: 'MEADOW', x: 5, y: 5, biomeCount: 0, globalCount: 0, mobId: 'mob_boar' },
    world, 0.9,
  );
  eq(dec.spawn, false, '安全区内不刷怪');
  eq(dec.reason, 'SAFE_ZONE', '拒绝原因');
  /* 护盾:区内 100 伤害 → 0 */
  near(safeZoneShield(world, 5, 5, 100), 0, 1e-9, '区内全额吸收');
  near(safeZoneShield(world, 100, 100, 100), 100, 1e-9, '区外不吸收');
});

test('W4-49b 安全区判定为单一事实源:isInsideSafeRadius 与 inSafeZone 语义一致', () => {
  /* 几何版(供 Boss 祭坛召唤复用)与世界查询版必须逐点一致,
     否则会出现「刷怪说在区外、召唤说在区内」的双标准。 */
  const world = spawnWorld({ townCenter: () => ({ x: 30, y: -40 }) });
  /* 几何探针用**字面量 24**(设计基线,同上),不用被测常量。 */
  const r = 24;
  const probes: [number, number][] = [
    [30, -40], [30 + r, -40], [30 - r, -40], [30, -40 + r], [30, -40 - r],
    [30 + r + 1e-6, -40], [30 + r - 1e-6, -40],
    [30 + r * Math.SQRT1_2, -40 + r * Math.SQRT1_2],
    [0, 0], [200, 200],
  ];
  for (const [x, y] of probes) {
    eq(isInsideSafeRadius(x, y, 30, -40), inSafeZone(world, x, y), `(${x},${y}) 两版判定必须一致`);
  }
  /* 边界语义:恰好 24 格在内、24+1e-6 在外 */
  eq(isInsideSafeRadius(30 + r, -40, 30, -40), true, '恰好 24 格 → 区内');
  eq(isInsideSafeRadius(30 + r + 1e-6, -40, 30, -40), false, '24+1e-6 → 区外');
  eq(isInsideSafeRadius(30, -40, 30, -40), true, '圆心在区内');
  /* 自定义半径:半径 0 时只有圆心在内 */
  eq(isInsideSafeRadius(0, 0, 0, 0, 0), true, '半径 0 时圆心在内');
  eq(isInsideSafeRadius(1, 0, 0, 0, 0), false, '半径 0 时圆心外 1 格即在区外');
});

test('W4-49c 安全区护盾三行表:玩家受保护、Boss 不受保护(裁决 3 兜底)', () => {
  const world = spawnWorld({ townCenter: () => ({ x: 0, y: 0 }) });

  /* ── 第三行:玩家在安全区内受保护 ── */
  near(applySafeZoneShield(world, 5, 5, 100, false), 0, 1e-9, '区内玩家全额吸收');
  near(applySafeZoneShield(world, 100, 100, 100, false), 100, 1e-9, '区外玩家不吸收');
  near(applySafeZoneShield(world, 24, 0, 100, false), 0, 1e-9, '恰好 24 格玩家受保护(设计基线)');

  /* ── 第二行:关键反例 —— Boss 在安全区内不受任何保护 ── */
  near(applySafeZoneShield(world, 5, 5, 100, true), 100, 1e-9, '区内 Boss 吃满伤害(最重要的一条)');
  near(applySafeZoneShield(world, 0, 0, 100, true), 100, 1e-9, '安全区圆心的 Boss 也不免伤');
  near(applySafeZoneShield(world, 24, 0, 100, true), 100, 1e-9, '边界上的 Boss 也不免伤');
  near(applySafeZoneShield(world, 100, 100, 100, true), 100, 1e-9, '区外 Boss 不吃护盾');

  /* 玩家与 Boss 在同一坐标必须得到不同结果 —— 这是「护盾受益方是玩家」的核心不变量 */
  ok(applySafeZoneShield(world, 5, 5, 100, false) !== applySafeZoneShield(world, 5, 5, 100, true),
    '同点玩家与 Boss 的结算必须不同');

  /* 伤害为 0 / 负数时不产生 NaN 或反向加血 */
  near(applySafeZoneShield(world, 5, 5, 0, false), 0, 1e-9, '0 伤害仍是 0');
  near(applySafeZoneShield(world, 5, 5, 0, true), 0, 1e-9, 'Boss 0 伤害仍是 0');

  /* ── 参数化守卫:任何人都不能靠「忘记传 isBoss」绕过 ── */
  eq(applySafeZoneShield.length, 5, '元数锁定为 5(isBoss 必须显式传,禁止加默认值)');
  eq(safeZoneShield.length, 4, '底层函数元数 4(不对外,仅供 applySafeZoneShield 调用)');
});

test('W4-50 刷怪上限:群系硬上限 / 全局 200 / 软上限概率减半 / 夜行怪白天不刷', () => {
  const world = spawnWorld();
  const cfg = BIOME_SPAWN.MEADOW;
  eq(decideSpawn({ biome: 'MEADOW', x: 0, y: 0, biomeCount: cfg.hardCap, globalCount: 0, mobId: 'mob_boar' }, world, 0.9).reason, 'HARD_CAP', '硬上限');
  eq(decideSpawn({ biome: 'MEADOW', x: 0, y: 0, biomeCount: 0, globalCount: GLOBAL_MOB_CAP, mobId: 'mob_boar' }, world, 0.9).reason, 'GLOBAL_CAP', '全局上限 200');
  /* 软上限:roll < 0.5 拒绝,roll >= 0.5 放行 */
  eq(decideSpawn({ biome: 'MEADOW', x: 0, y: 0, biomeCount: cfg.softCap, globalCount: 0, mobId: 'mob_boar' }, world, 0.49).reason, 'SOFT_DAMPED', '软上限 half 概率');
  eq(decideSpawn({ biome: 'MEADOW', x: 0, y: 0, biomeCount: cfg.softCap, globalCount: 0, mobId: 'mob_boar' }, world, 0.51).spawn, true, '软上限另一半放行');
  /* 夜行怪白天 */
  const day = spawnWorld({ isNight: () => false });
  eq(decideSpawn({ biome: 'CAVERN', x: 0, y: 0, biomeCount: 0, globalCount: 0, mobId: 'mob_bat_sonic' }, day, 0.9).reason, 'DAYLIGHT', '夜行怪白天不刷');
  eq(decideSpawn({ biome: 'MEADOW', x: 0, y: 0, biomeCount: 0, globalCount: 0, mobId: 'mob_boar' }, day, 0.9).spawn, true, '非夜行怪白天照常刷');
});

test('W4-51 刷怪配置:8 群系全覆盖、可刷怪非空、安全区优先级最高', () => {
  const cov = biomeCoverage();
  eq(Object.keys(BIOME_SPAWN).length, 8, '8 个群系都有配表');
  for (const [b, n] of Object.entries(cov)) {
    ok(n >= 1, `${b} 至少 1 种可刷怪(实际 ${n})`);
  }
  /* 卡皮巴拉不可刷(被动不可击杀) */
  eq(spawnableMobs('SAKURA').some((m) => m.id === 'mob_capybara'), false, '卡皮巴拉不进自然刷新池');
  eq(spawnableMobs('SAKURA').length, 2, '绯樱高地只剩 2 种可刷');
  /* 优先级:安全区先于硬上限判定 */
  const world = spawnWorld({ townCenter: () => ({ x: 0, y: 0 }) });
  eq(decideSpawn({ biome: 'MEADOW', x: 0, y: 0, biomeCount: 999, globalCount: 0, mobId: 'mob_boar' }, world, 0.9).reason, 'SAFE_ZONE', '安全区优先于群系上限');
});

/* ═════════════════════ 8. 性能 ═════════════════════ */

test('W4-52 性能:200 只怪 30 只唤醒时每 20Hz 帧 CPU 估算(休眠 170 只零开销)', () => {
  const active = 30;
  const fsmUs = estimateFsmCostUs(active);
  const aoiUs = estimateAoiScanCost(8, active).estimateUs;
  const totalUs = fsmUs + aoiUs;
  const frameBudgetMs = 1000 / TICK_HZ;
  ok(totalUs < frameBudgetMs * 1000 * 0.01,
    `总开销 ${totalUs.toFixed(2)}µs 应 < 单帧预算 ${frameBudgetMs}ms 的 1%`);
  /* 休眠 170 只的开销为 0(结构证明:不进入 stepActive) */
  const aoi = new AoiManager();
  for (let i = 0; i < 170; i += 1) aoi.registerMob(`far${i}`, 2000 + i * 40, 2000);
  aoi.registerMob('nearA', 0, 0);
  aoi.registerMob('nearB', 20, 20);   /* 距 28.28 格 → 唤醒 */
  aoi.setPlayers([{ id: 'p', x: 0, y: 0, afk: false }]);
  aoi.update();
  eq(aoi.activeMobs.size, 2, '200 只中恰好 2 只落入 32 格 AOI');
  eq(aoi.isActive('nearA'), true, 'nearA 唤醒');
  eq(aoi.isActive('nearB'), true, 'nearB 唤醒');
  const before = aoi.totalActiveTicks;
  for (let f = 0; f < 100; f += 1) aoi.stepActive(() => {});
  eq(aoi.totalActiveTicks - before, 200, '100 帧 × 2 只 = 200 次;其余 198 只零开销');
});

/* ═══════════ task-38:taming.ts 的归属判定与前置条件 ═══════════ */

/* 读生产源码文本 —— 宿主的**存在性**无法用 import 断言。 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const wildSimSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8');
const behavSrc = readFileSync(join(ROOT_DIR, 'server', 'src', 'mobs', 'behaviors.ts'), 'utf8');

/**
 * ★ task-73 新增:全仓生产源扫描器。
 *
 * 为什么需要它 —— 本套件下面几条断言**各只覆盖 1~4 个文件**,而它们的结论句
 * 曾写成「全仓」范围。范围一旦不一致,读的人会拿单例当全称用(陷阱 95)。
 * ⇒ 把「全仓事实」**单独测一遍**,范围偷换就变成**机械可核对**的东西。
 *
 * ⚠️ 判据用**原始文本**(不剥注释) ⇒ 注释里提到该标识符也会计入。
 *    这是**保守**方向:多报会让断言变红,而红可以被看见;少报才会静默。
 */
const SRC_ROOTS = ['server/src', 'client/src', 'shared'];
function collectProdTs(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walkDir = (dir: string): void => {
    for (const e of readdirSync(join(ROOT_DIR, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walkDir(rel);
      else if (e.name.endsWith('.ts')) out.push({ rel, src: readFileSync(join(ROOT_DIR, rel), 'utf8') });
    }
  };
  for (const r of SRC_ROOTS) walkDir(r);
  return out;
}
/** 原始文本里出现该标识符的行(用于「调用点」这类需要排除定义行的判据)。 */
function linesMatching(src: string, re: RegExp): number[] {
  const hits: number[] = [];
  const ls = src.split('\n');
  for (let i = 0; i < ls.length; i += 1) if (re.test(ls[i] as string)) hits.push(i + 1);
  return hits;
}

test('task-38 taming 是**真欠账**,但缺的是两个不存在的宿主(不是缺接线动作)', () => {
  /* 判定:它不是「有人该 import 它却忘了」,而是**两个宿主都不存在**:
   *   ① 宠物容器 —— 生产没有任何「每玩家宠物集合」
   *   ② 驯服交互 —— 没有任何 AI 消费 `mobs.ts` 的 `tameItem`
   *
   * ⚠️ 断言必须读**生产源码文本**(宿主的**存在性**无法用 import 表达)。
   * 且不能用宽词 —— 「有 `pet` 这个子串」会被注释/变量名命中而恒真。 */

  /* ① 宠物容器不存在:world_sim 完全不碰 taming 的任何核心类型。 */
  ok(!/PetRecord|TameStage|feedPet|deployPet|sendToRanch/.test(wildSimSrc),
    'world_sim.ts 不碰 PetRecord/TameStage/feedPet/deployPet/sendToRanch(★ 范围仅此一文件)');

  /* ② 驯服交互不存在:behaviors.ts 里没有 TameableAi,也没有 tameItem 分支。 */
  ok(!/class TameableAi|TameableAi extends/.test(behavSrc),
    'behaviors.ts 没有 TameableAi(★ 范围仅此一文件)');
  /* ⚠️ task-73 修:原结论句为「⇒ 7 种可驯服生物的 tameItem 字段无人消费」——
   *    断言体只测 behaviors.ts(实测 0 次,为真),而结论句把范围写成「该字段」= 全仓
   *    ⇒ **为假**:实测有 3 个文件在读它。全仓事实现由下方 5a 单独钉住(陷阱 95)。 */
  ok(!/tameItem/.test(behavSrc),
    'behaviors.ts 不读 tameItem(★ 范围仅此一文件;全仓事实见下方 5a)');

  /* ③ 反向证据:注册表登记了可驯服名单,却**零引用** ——
   *    这是「登记了但从未被用」的典型信号(比「没登记」更可疑)。 */
  includes(behavSrc, 'TAMEABLE_AI_IDS', 'behaviors.ts 登记了可驯服 AI 名单');
  const tameRefs = [
    readFileSync(join(ROOT_DIR, 'server', 'src', 'mobs', 'behaviors.ts'), 'utf8'),
    readFileSync(join(ROOT_DIR, 'server', 'src', 'mobs', 'host.ts'), 'utf8'),
    readFileSync(join(ROOT_DIR, 'server', 'src', 'mobs', 'spawner.ts'), 'utf8'),
    wildSimSrc,
  ].reduce((n, s) => n + (s.match(/TAMEABLE_AI_IDS/g) ?? []).length, 0);
  eq(tameRefs, 1,
    '这 4 个文件里 TAMEABLE_AI_IDS 只出现 1 次(★ 范围 = 上面这 4 个文件,不是全仓;全仓见下方 5c)');

  /* ═══════════════════════════════════════════════════════════════════════
   * ★★★ 5 ★ task-73 新增:把「全仓事实」**单独立测**,使范围不再被偷换。
   *
   * 背景(陷阱 95):上面第 2 条原先的结论句是
   *     'behaviors.ts 不读 tameItem ⇒ 7 种可驯服生物的 tameItem 字段无人消费'
   *   · 断言体只覆盖 behaviors.ts —— 实测 0 次 ⇒ **为真**,断言**绿**
   *   · 结论句说的是「该字段」= 全仓 —— 实测 3 个文件在读它 ⇒ **为假**
   *   ⇒ 而这句错话被抄进 `scripts/verify.ts` 的白名单理由,当作「有出处的已核实事实」。
   *
   * 修法(**不是删断言**):范围改准确(见上方各处 ★ 标注)+ 另加全仓判据。
   * ⇒ 范围一旦分开写,「单例冒充全称」就从**文本修辞**变成**机械可核对**的东西。
   * ═══════════════════════════════════════════════════════════════════════ */
  const prod = collectProdTs();
  ok(prod.length > 50,
    `自证:生产源码扫到 ${prod.length} 个 .ts(期望 > 50 —— 否则扫描器坏了会**静默恒过**)`);

  /* 5a 全仓**读** `.tameItem` 的文件 —— 实测 3 个。
   *    这条正是「tameItem 字段无人消费」的**反证**。 */
  const tameReaderFiles = prod.filter((p) => /\.tameItem/.test(p.src)).map((p) => p.rel).sort();
  eq(tameReaderFiles,
    ['server/src/content/registry.ts', 'server/src/mobs/taming.ts', 'shared/constants/mobs.ts'],
    `全仓读 .tameItem 的文件共 ${tameReaderFiles.length} 个 ⇒ tameItem **有**消费者(「无人消费」不成立)`);

  /* 5b 真正无人消费的是 `feedPet` 这个**函数**:生产侧调用点 0(只 1 处定义)。 */
  let feedPetCalls = 0;
  for (const p of prod) {
    const ls = p.src.split('\n');
    for (const ln of linesMatching(p.src, /feedPet/)) {
      if (!/export function feedPet/.test(ls[ln - 1] as string)) feedPetCalls += 1;
    }
  }
  eq(feedPetCalls, 0,
    'feedPet 生产调用点 0(1 处定义 + 0 调用)⇒ 无人消费的是**函数**,不是 tameItem 字段');

  /* 5c 全仓**生产侧**该名单只出现 1 次(仅定义处)⇒「从未被生产消费」成立。
   *    ⚠️ 与上方第 3 条范围不同:3 只数 4 个文件;本条数**全部生产文件**。
   *       两者实测**恰好同值 1**,但范围不同,故分开写、分别注明。 */
  const idsProd = prod.reduce((n, p) => n + (p.src.match(/TAMEABLE_AI_IDS/g) ?? []).length, 0);
  eq(idsProd, 1,
    `生产侧(${prod.length} 个文件)TAMEABLE_AI_IDS 只出现 1 次 ⇒ 仅定义处、零生产消费`);

  /* ④ 而 taming.ts 自身是**完整**的(27 个导出、测试全绿)——
   *    所以它是「实现存在 + 宿主缺失」,不是「实现有坑」。 */
  eq(tamingCoverage().tameable, tameableDefs().length,
    'taming.ts 的可驯服覆盖数是自洽的(实现完整)');
  ok(wildSimSrc.indexOf('interactMob') > 0,
    'world_sim 有 interactMob 挂在 MobHost.interact ⇒ 缺的是「tameItem 分支」而非「交互入口」');
});

test('task-38 驯服该按 **itemId** 扣物品,不该照搬 consumeItem(instanceId 口径)', () => {
  /* task-38 要求判定 `consumeItem`。结论:它是**死代码**(0 调用点),
   * 且口径与驯服需求**不同** —— 它按 `instance_id` 扣 `ai_item_instances`,
   * 而驯服喂食是「用掉一个物品 ID」,走的是 `world_sim.consumeGroundItem(itemId, count)`。 */
  const repo = readFileSync(join(ROOT_DIR, 'server', 'src', 'db', 'repo.ts'), 'utf8');
  includes(repo, 'consumeItem(db: DbLike, instanceId: string, n: number',
    'consumeItem 按 **instanceId** 扣减(不是 itemId)');
  ok(/consumeGroundItem\s*\(/.test(wildSimSrc),
    'world_sim 有 consumeGroundItem(itemId, count) —— 这才是驯服该用的口径');

  /* 0 调用点:排除定义体后,生产侧无人调它。 */
  const stripped = wildSimSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/consumeItem\s*\(/.test(stripped),
    'world_sim 不调 consumeItem ⇒ 它仍是死代码');
});

/* ═════════════════════ 汇总 ═════════════════════ */

report('WS-04');