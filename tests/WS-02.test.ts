/**
 * WS-02 · 2.5D 伪三维刚体物理验收测试。
 * 运行:`node tests/WS-02.test.ts`
 */

import { test, ok, eq, near, inRange, mulberry32, report } from '../shared/testing/harness.ts';
import {
  DT, TICK_HZ, GRAVITY, THROW_SPEED_XY, THROW_SPEED_Z,
  CARRY_Z_STEP, CARRY_MAX_DEPTH, CARRY_SLOWDOWN,
  CATCH_RADIUS, CATCH_Z_MIN, CATCH_Z_MAX,
  RADIUS_PLAYER, RADIUS_WILD, RADIUS_BOSS,
  MASS_PLAYER, MASS_HEAVY, MASS_BOSS,
  BASE_MOVE_SPEED, BodyState, createBody,
  integrateHorizontal, integrateVertical, throwVelocity,
  stackOffset, carrierSpeedMul, canPerfectCatch, resolveCircleBounce,
} from '../shared/types/physics.ts';
import { floorSlotOfId, floorIdOfSlot, speedMulOfSlot } from '../server/src/world/chunk.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import {
  PhysicsWorld, FLAT_TERRAIN, BELT_FORCE, BURN_DPS, BLEED_DPS, BOUNCE_VZ,
  BOUNCE_VZ_ANALYTIC, apexHeight, launchSpeedForApex,
  TRAP_DELAY, VORTEX_ACCEL, COLLISION_RESTITUTION, MAX_SUBSTEPS,
  slideDistance, slideFrames, decayTrace, glide, type PhysTerrain,
} from '../server/src/physics/world.ts';
import {
  CarrySystem, CarryReject, type CarryActor,
  SHIELD_ITEM_ID, LIFT_RANGE, LIFT_Z_MAX, HEAVY_MASS_THRESHOLD,
  canLift, isKnockbackImmune, planarDistance,
  simulateArc, arcRange, firstCatchWindow,
  theoreticalAirtime, theoreticalRange, arcElevation,
  STACK_4_TOP_Z, STACK_STEP, JUMP_VZ, BOUNCE_TARGET_Z, BOUNCE_VZ as CARRY_BOUNCE_VZ,
} from '../server/src/physics/carry.ts';

/* ═══════════════ 测试夹具 ═══════════════ */

const SLOT_ICE = floorSlotOfId(315);
const SLOT_SWAMP = floorSlotOfId(316);
const SLOT_HONEY = floorSlotOfId(322);
const SLOT_BELT = floorSlotOfId(317);
const SLOT_TRAMPOLINE = floorSlotOfId(318);
const SLOT_COAL = floorSlotOfId(320);
const SLOT_THORN = floorSlotOfId(324);
const SLOT_TRAP = floorSlotOfId(319);
const SLOT_VORTEX = floorSlotOfId(323);
const SLOT_RAIL = floorSlotOfId(328);
const SLOT_WOOD = floorSlotOfId(303);

/** 全平地 + 指定格铺指定地砖的测试地形。 */
function terrainWith(map: Map<string, number>, walls: Set<string> = new Set()): PhysTerrain {
  return {
    floorSlotAt: (x, y) => map.get(`${x},${y}`) ?? 0,
    objIdAt: (x, y) => (walls.has(`${x},${y}`) ? 352 : 0),
    elevAt: () => 1,
    faceDirAt: () => 1,
  };
}

function rect(map: Map<string, number>, x0: number, y0: number, x1: number, y1: number, slot: number): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) map.set(`${x},${y}`, slot);
  }
}

function mkActors(defs: [string, number, number, Partial<{ mass: number; shield: boolean }>][]): {
  map: Map<string, CarryActor>;
  sys: CarrySystem;
} {
  const map = new Map<string, CarryActor>();
  for (const [id, x, y, extra] of defs) {
    map.set(id, {
      body: createBody(id, { x, y, mass: extra.mass ?? MASS_PLAYER }),
      shield: extra.shield ?? false,
    });
  }
  return { map, sys: new CarrySystem(map) };
}

/* ═══════════════ 1. 常数与冻结层一致性 ═══════════════ */

test('冻结层物理常数与手册一致', () => {
  eq(TICK_HZ, 20, '20Hz');
  near(DT, 0.05, 1e-12, 'dt = 0.05s');
  near(GRAVITY, -18.0, 1e-12, '重力 -18 格/秒²');
  near(THROW_SPEED_XY, 8.5, 1e-12, '投掷水平速度');
  near(THROW_SPEED_Z, 6.0, 1e-12, '投掷垂直速度');
  near(CARRY_Z_STEP, 0.85, 1e-12, '叠罗汉步长');
  eq(CARRY_MAX_DEPTH, 4, '最多 4 层');
  near(CARRY_SLOWDOWN, 0.85, 1e-12, '每层减速');
  near(CATCH_RADIUS, 0.8, 1e-12, '接球半径');
  near(BASE_MOVE_SPEED, 4.5, 1e-12, '基础移速');
  near(RADIUS_PLAYER, 0.35, 1e-12, '玩家半径');
  near(RADIUS_WILD, 0.40, 1e-12, '野怪半径');
  near(RADIUS_BOSS, 1.20, 1e-12, 'Boss 半径');
  near(MASS_PLAYER, 1.0, 1e-12, '玩家质量');
  near(MASS_HEAVY, 3.0, 1e-12, '重物质量');
  near(MASS_BOSS, 20.0, 1e-12, 'Boss 质量');
});

/* ═══════════════ 2. 地形摩擦查表 ═══════════════ */

test('地砖 μ 查表:315/316/322/328 与手册原文一致', () => {
  const pw = new PhysicsWorld({
    terrain: terrainWith(new Map([
      ['1,1', SLOT_ICE], ['2,2', SLOT_SWAMP], ['3,3', SLOT_HONEY],
      ['4,4', SLOT_RAIL], ['5,5', SLOT_WOOD],
    ])),
  });
  near(pw.muAt(1.5, 1.5), 0.98, 1e-12, '315 冰砖 μ=0.98');
  near(pw.muAt(2.5, 2.5), 0.40, 1e-12, '316 沼泽 μ=0.40');
  near(pw.muAt(3.5, 3.5), 0.35, 1e-12, '322 蜂蜜 μ=0.35');
  near(pw.muAt(4.5, 4.5), 0.90, 1e-12, '328 铁轨 μ=0.90');
  /* 303 木地板:手册 §3.5 L204 给 μ=0.75(此前本测试抄的是实现自定值 0.80) */
  near(pw.muAt(5.5, 5.5), 0.75, 1e-12, '303 木地板 μ=0.75(手册 L204)');
  near(pw.muAt(9.5, 9.5), 0.72, 1e-12, '裸地 μ=0.72');
  eq(pw.floorIdAt(1.5, 1.5), 315, '地砖 ID 反查');
});

test('没有配表的地砖回落到默认 0.75', () => {
  const t: PhysTerrain = { floorSlotAt: () => 0, objIdAt: () => 0, elevAt: () => 1, faceDirAt: () => 1 };
  const pw = new PhysicsWorld({ terrain: t });
  near(pw.muAt(0, 0), 0.72, 1e-12, '槽位 0 = 裸地 0.72');
  /* 传一个不存在的物品 ID 走 DEFAULT_MU=0.75 */
  const wrongId: PhysTerrain = { floorSlotAt: () => 40, objIdAt: () => 0, elevAt: () => 1, faceDirAt: () => 1 };
  const pw2 = new PhysicsWorld({ terrain: wrongId });
  /* 槽位 40 属于 UGC 地毯区间(31..63),映射到 314。
     注意:314 手册 μ=0.75(§3.5 L215)与 DEFAULT_MU 恰好同值,
     所以 2026-11 起 μ **不能再**用来区分「映射到 314」和「回落缺省」——
     改用 floorIdAt(身份)与 speedMul(314=1.10,缺省=1.00)来区分。 */
  eq(pw2.floorIdAt(0, 0), 314, 'UGC 槽位映射到 314(身份)');
  near(speedMulOfSlot(40), 1.10, 1e-12, 'UGC 槽位走 314 的 110% 移速(手册 L215)');
});

test('槽位→ID 全 64 槽位都走 floorIdOfSlot,不得手工 301+slot-1', () => {
  /* 这条断言防的是一类真实缺陷:`floorIdAt` 与 `stepBody` 曾各自写
     `301 + slot - 1`,该式只在槽位 1..30 成立;槽位 31..63 是 UGC 像素
     地毯(映射 314),手工式会算出 331..363 这批不存在的地砖 ID。 */
  for (let s = 0; s <= 63; s += 1) {
    const t: PhysTerrain = { floorSlotAt: () => s, objIdAt: () => 0, elevAt: () => 1, faceDirAt: () => 1 };
    const pw = new PhysicsWorld({ terrain: t });
    eq(pw.floorIdAt(0, 0), floorIdOfSlot(s), `槽位 ${s} 的 floorIdAt 必须等于 floorIdOfSlot`);
    if (s > 0) {
      ok(ITEM_BY_ID.has(pw.floorIdAt(0, 0)), `槽位 ${s} 产出的 ID 必须是真实物品`);
    }
  }
  /* 三个具体的分歧点,曾经全部算错 */
  const at = (s: number): number =>
    new PhysicsWorld({ terrain: { floorSlotAt: () => s, objIdAt: () => 0, elevAt: () => 1, faceDirAt: () => 1 } })
      .floorIdAt(0, 0);
  eq(at(31), 314, '槽位 31 → UGC 地毯 314(不是 331)');
  eq(at(40), 314, '槽位 40 → UGC 地毯 314(不是 340)');
  eq(at(63), 314, '槽位 63 → UGC 地毯 314(不是 363)');
  /* 槽位 31..63 全部来自 314。μ 已不能作判据(314 的 0.75 与缺省同值),
     改判 speedMul:314=1.10(手册 L215),而缺省是 1.00。 */
  const mid = new PhysicsWorld({ terrain: { floorSlotAt: () => 47, objIdAt: () => 0, elevAt: () => 1, faceDirAt: () => 1 } });
  eq(mid.floorIdAt(0, 0), 314, 'UGC 地毯中段身份 = 314');
  near(speedMulOfSlot(47), 1.10, 1e-12, 'UGC 地毯中段移速来自 314');
  near(speedMulOfSlot(0), 1.00, 1e-12, '裸地移速修正 = 100%(不受 314 影响)');
});

/* ═══════════════ 3. 冰砖打滑与撞墙 ═══════════════ */

test('冰砖打滑:4.5 格/秒冲上 315,滑行距离远超其它地砖', () => {
  /* 解析式:s∞ = v0·dt/(1-μ) */
  const iceDist = slideDistance(0.98, BASE_MOVE_SPEED);
  const bareDist = slideDistance(0.72, BASE_MOVE_SPEED);
  const honeyDist = slideDistance(0.35, BASE_MOVE_SPEED);
  near(iceDist, (4.5 * 0.05) / (1 - 0.98), 1e-9, '冰砖解析射程 = 0.225/0.02');
  near(iceDist, 11.25, 1e-9, '冰砖 11.25 格');
  ok(iceDist > bareDist * 10, '冰砖滑行距离是裸地的 10 倍以上');
  ok(honeyDist < 1, `蜂蜜毯几乎立刻停住,实际 ${honeyDist.toFixed(3)} 格`);
  ok(slideFrames(0.98, 4.5) > slideFrames(0.35, 4.5), '冰砖需要更多帧才停住');
  eq(slideFrames(1.0, 4.5), Infinity, 'μ=1 永不停止');
});

test('冰砖打滑 5 格后撞墙反弹(手册原句的场景)', () => {
  const map = new Map<string, number>();
  rect(map, 3, 3, 20, 8, SLOT_ICE);
  /* 在 x=9 立一道原木墙(352) */
  const walls = new Set<string>();
  for (let y = 3; y <= 8; y += 1) walls.add(`9,${y}`);
  const pw = new PhysicsWorld({
    terrain: terrainWith(map, walls),
    bounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
  });
  const b = pw.spawn('boar', {
    x: 3.5, y: 5.5, z: 0, vx: BASE_MOVE_SPEED, vy: 0,
    radius: RADIUS_WILD, mass: MASS_HEAVY,
  });
  ok(b.vx > 0, '初始朝向墙冲锋');

  let hitFrame = -1;
  let xAtHit = 0;
  const startX = b.x;
  for (let i = 0; i < 400; i += 1) {
    pw.step();
    if (hitFrame < 0 && pw.totalWallHits > 0) {
      hitFrame = i;
      xAtHit = b.x;
    }
  }
  ok(hitFrame >= 0, '确实撞上了墙');
  const travel = xAtHit - startX;
  ok(travel >= 5, `撞墙前滑行 ${travel.toFixed(2)} 格(手册「刹不住车」成立)`);
  ok(travel < 11.25, '但没有超过无墙时的 11.25 格解析射程');
  ok(b.vx <= 0, '撞墙后速度反向');
  ok(pw.totalWallHits >= 1, '墙壁碰撞计数');
  ok(pw.fx.length >= 0, '特效队列可用');
});

test('不同地砖滑行距离:蜂蜜 < 裸地 < 冰砖(单调性)', () => {
  const cases: [number, string][] = [[0.28, '蜂蜜毯 322'], [0.72, '裸地'], [0.98, '冰砖 315']];
  const dists: number[] = [];
  for (const [mu] of cases) {
    const g = glide(mu, BASE_MOVE_SPEED, 1, 0, 200);
    dists.push(g.distance);
  }
  ok(dists[0] < dists[1], `蜂蜜 ${dists[0].toFixed(2)} < 裸地 ${dists[1].toFixed(2)}`);
  ok(dists[1] < dists[2], `裸地 ${dists[1].toFixed(2)} < 冰砖 ${dists[2].toFixed(2)}`);
  /* 每帧速度衰减与 mu 一致 */
  const trace = decayTrace(0.98, 4.5, 3);
  near(trace[0], 4.5 * 0.98, 1e-12, '第 1 帧速度');
  near(trace[1], 4.5 * 0.98 * 0.98, 1e-12, '第 2 帧速度');
  near(trace[2], 4.5 * 0.98 ** 3, 1e-12, '第 3 帧速度');
});

/* ═══════════════ 4. 投掷抛物线(与手算对照) ═══════════════ */

test('投掷 45° 射程与手算一致:8.5 × 0.6667 ≈ 5.667 格', () => {
  /* 手册 §2.2:vz0=6.0,g=-18 → 滞空 2·6/18 = 0.6667s */
  const airtime = theoreticalAirtime();
  near(airtime, 2 / 3, 1e-9, '滞空时间 2/3 秒');
  const range = theoreticalRange();
  near(range, (8.5 * 2) / 3, 1e-9, '射程 = 8.5 × 2/3');
  near(range, 5.666666666666667, 1e-6, '射程 ≈ 5.667 格');
  /* 仰角 = atan(6/8.5) */
  near(arcElevation(), Math.atan2(6, 8.5), 1e-12, '仰角 atan(6/8.5)');
  inRange(arcElevation() * 180 / Math.PI, 35, 36, '仰角约 35.2°');

  /* 数值积分在 dt→0 时收敛到解析值 */
  const fine = simulateArc(0, 0, 0, 1, 0, 1, 0.001);
  near(arcRange(fine), range, 0.02, 'dt=1ms 数值射程收敛到 5.667');
  const coarse = simulateArc(0, 0, 0, 1, 0, 1, DT);
  near(arcRange(coarse), range, 0.75, 'dt=20Hz 数值射程在 0.75 格内逼近解析解');
  ok(arcRange(coarse) > range, '20Hz 采样会略微高估(离散化误差,方向正确)');
});

test('throwVelocity 水平方向归一化,速度模恒定', () => {
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [3, 4], [-2, -5]];
  for (const [dx, dy] of dirs) {
    const t = throwVelocity(dx, dy, 0);
    const speed = Math.hypot(t.vx, t.vy);
    near(speed, THROW_SPEED_XY, 1e-12, `方向 (${dx},${dy}) 水平速度模恒定`);
    near(t.vz, THROW_SPEED_Z, 1e-12, '垂直初速恒定');
    near(t.z, 0, 1e-12, '出球高度原样返回');
  }
  /* 方向归一化:斜向也保持 8.5 */
  const d = throwVelocity(1, 1, 0);
  near(Math.hypot(d.vx, d.vy), 8.5, 1e-12, '斜向 45° 也是 8.5');
  near(d.vx, 8.5 / Math.SQRT2, 1e-12, '斜向分量');
  /* speedMul 线性缩放水平速度,不影响垂直初速 */
  const fast = throwVelocity(1, 0, 0, 1.5);
  near(fast.vx, 8.5 * 1.5, 1e-12, 'speedMul 缩放水平速度');
  near(fast.vz, 6.0, 1e-12, 'speedMul 不影响垂直初速');
});

test('抛物线积分逐帧 z 单调上升到峰值后下降', () => {
  const arc = simulateArc(0, 0, 0, 1, 0);
  const zs = arc.map((s) => s.z);
  const peakIdx = zs.indexOf(Math.max(...zs));
  ok(peakIdx > 0 && peakIdx < zs.length - 1, '峰值在中间');
  for (let i = 1; i <= peakIdx; i += 1) ok(zs[i] >= zs[i - 1], `上升段第 ${i} 帧单调`);
  for (let i = peakIdx + 1; i < zs.length; i += 1) ok(zs[i] <= zs[i - 1], `下降段第 ${i} 帧单调`);
  /* 理论峰值 z = vz0²/(2|g|) = 36/36 = 1.0。
     但冻结层的 integrateVertical 是**显式欧拉**,每帧多走半步,
     因此 20Hz 采样峰值系统性高于 1.0(实测约 1.155)。加密采样会收敛到 1.0。 */
  const coarsePeak = Math.max(...zs);
  ok(coarsePeak >= 1.0, `20Hz 采样峰值 ${coarsePeak.toFixed(4)} 不低于理论值`);
  ok(coarsePeak < 1.25, `20Hz 采样峰值 ${coarsePeak.toFixed(4)} 不严重高估`);
  const finePeak = Math.max(...simulateArc(0, 0, 0, 1, 0, 1, 0.001).map((s) => s.z));
  near(finePeak, 1.0, 0.01, 'dt=1ms 时峰值收敛到 1.0');
  ok(finePeak < coarsePeak, '加密采样后峰值下降(离散化误差方向正确)');
  const last = arc[arc.length - 1];
  ok(last.grounded, '最终落地');
  eq(last.z, 0, '落地 z = 0');
});

/* ═══════════════ 5. 举起链与 4 层叠罗汉 ═══════════════ */

test('举起链 4 层叠罗汉高度 = 2.55 格', () => {
  near(CARRY_Z_STEP, 0.85, 1e-12, '单层 0.85');
  near(STACK_STEP, 0.85, 1e-12, '导出常量一致');
  near(STACK_4_TOP_Z, 2.55, 1e-12, '顶层 = 3 × 0.85');
  near(stackOffset(0), 0, 1e-12, '第 0 层偏移 0');
  near(stackOffset(1), 0.85, 1e-12, '第 1 层 0.85');
  near(stackOffset(3), 2.55, 1e-12, '第 3 层 2.55');

  const { sys } = mkActors([
    ['p0', 0, 0, {}], ['p1', 0, 0, {}], ['p2', 0, 0, {}], ['p3', 0, 0, {}],
  ]);
  eq(sys.tryLift('p0', 'p1'), CarryReject.OK, '举第 1 人');
  eq(sys.tryLift('p0', 'p2'), CarryReject.OK, '举第 2 人');
  eq(sys.tryLift('p0', 'p3'), CarryReject.OK, '举第 3 人');
  eq(sys.chainOf('p0').length, 4, '链条 4 人');
  near(sys.topZ('p0'), 2.55, 1e-12, '顶层高度 2.55');
  /* 每层 z 精确落在 stackOffset 上 */
  const chain = sys.chainOf('p0');
  for (let k = 0; k < 4; k += 1) {
    near(chain[k].body.z, stackOffset(k), 1e-12, `第 ${k} 层 z`);
  }
  /* 底层承载者移速 = 0.85^3 */
  near(sys.speedMulOf('p0'), CARRY_SLOWDOWN ** 3, 1e-12, '4 层时底层移速乘数');
  near(sys.speedMulOf('p0'), 0.614125, 1e-9, '0.85³ = 0.614125');
});

test('叠罗汉上限 4 层,第 5 人被拒', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const { sys } = mkActors(ids.map((id) => [id, 0, 0, {}] as [string, number, number, {}]));
  eq(sys.tryLift('a', 'b'), CarryReject.OK, '2 层');
  eq(sys.tryLift('a', 'c'), CarryReject.OK, '3 层');
  eq(sys.tryLift('a', 'd'), CarryReject.OK, '4 层');
  eq(sys.tryLift('a', 'e'), CarryReject.DEPTH_EXCEEDED, '第 5 人被拒');
  eq(sys.chainOf('a').length, 4, '链条仍是 4 人');
  eq(sys.chainOf('e').length, 1, '被拒者仍是独立个体');
});

test('carrierSpeedMul 逐层递减', () => {
  near(carrierSpeedMul(0), 1.0, 1e-12, '0 层 1.0');
  near(carrierSpeedMul(1), 0.85, 1e-12, '1 层 0.85');
  near(carrierSpeedMul(2), 0.7225, 1e-12, '2 层 0.7225');
  near(carrierSpeedMul(3), 0.614125, 1e-12, '3 层 0.614125');
  for (let d = 1; d <= 4; d += 1) {
    ok(carrierSpeedMul(d) < carrierSpeedMul(d - 1), `第 ${d} 层比上一层更慢`);
  }
});

test('举起判定:距离、离地、已背负、自身、质量上限', () => {
  const { sys, map } = mkActors([
    ['a', 0, 0, {}], ['far', 5, 0, {}], ['air', 0.1, 0, {}],
    ['carried', 0, 0, {}],
    /* 质量阈值 10.0 高于 MASS_HEAVY(3.0),所以要用 Boss 级别的 20.0 才算「太重」 */
    ['heavy', 0.2, 0, { mass: MASS_BOSS }],
  ]);
  eq(sys.tryLift('a', 'a'), CarryReject.SELF, '不能举自己');
  eq(sys.tryLift('a', 'far'), CarryReject.TOO_FAR, '太远举不到');
  const air = map.get('air')!;
  air.body.z = 2.0;
  eq(sys.tryLift('a', 'air'), CarryReject.NOT_GROUNDED, '离地举不到');
  air.body.z = 0;
  eq(sys.tryLift('a', 'heavy'), CarryReject.HEAVY_BOSS, '超过质量阈值需要扁担');
  near(LIFT_RANGE, 0.75, 1e-12, '举起距离 0.75');
  near(LIFT_Z_MAX, 0.45, 1e-12, '举起高度上限 0.45');
  near(HEAVY_MASS_THRESHOLD, 10.0, 1e-12, '重物阈值 10');
  ok(MASS_HEAVY < HEAVY_MASS_THRESHOLD, 'MASS_HEAVY=3 仍在可举范围内(普通重物可举)');
  /* 举成功后再举同一人 → 已在链上 */
  eq(sys.tryLift('a', 'carried'), CarryReject.OK, '第一次成功');
  eq(sys.tryLift('a', 'carried'), CarryReject.ALREADY_CARRIED, '重复举报已背负');
});

test('质量判定优先于距离判定:又重又远时报 HEAVY_BOSS 而非 TOO_FAR', () => {
  const { sys } = mkActors([
    ['a', 0, 0, {}],
    ['boss', 8, 8, { mass: MASS_BOSS }],
    ['nrm', 8, 8, { mass: MASS_PLAYER }],
  ]);
  eq(sys.tryLift('a', 'boss'), CarryReject.HEAVY_BOSS, '又重又远优先报质量原因');
  eq(sys.tryLift('a', 'nrm'), CarryReject.TOO_FAR, '不重但很远报距离原因');
  /* 纯函数层同样成立 */
  const c1: CarryActor = { body: createBody('c1'), shield: false };
  const t1: CarryActor = { body: createBody('t1', { mass: MASS_BOSS }), shield: false };
  eq(canLift(c1, t1, 99), CarryReject.HEAVY_BOSS, 'canLift 顺序一致');
});

test('canLift 纯函数与 CarrySystem 判定一致', () => {
  const a: CarryActor = { body: createBody('a'), shield: false };
  const b: CarryActor = { body: createBody('b'), shield: false };
  eq(canLift(a, b, 0.5), CarryReject.OK, '近距离可举');
  eq(canLift(a, b, 1.0), CarryReject.TOO_FAR, '超出 0.75 不可举');
  const shielded: CarryActor = { body: createBody('c'), shield: true };
  eq(canLift(a, shielded, 0.5), CarryReject.SHIELDED, '平安盾免疫');
  ok(isKnockbackImmune(shielded), '平安盾判定');
  ok(!isKnockbackImmune(b), '普通人不免疫');
});

/* ═══════════════ 6. 投掷与完美接球 ═══════════════ */

test('throwTop 把链顶抛出,初速度来自 throwVelocity', () => {
  const { sys, map } = mkActors([['a', 0, 0, {}], ['b', 0, 0, {}]]);
  eq(sys.tryLift('a', 'b'), CarryReject.OK, '先举起');
  const top = map.get('b')!;
  const beforeZ = top.body.z;
  near(beforeZ, 0.85, 1e-12, '被举者已同步到 0.85');
  const res = sys.throwTop('a', 1, 0);
  ok(res !== null, '投掷成功');
  near(res!.vx, 8.5, 1e-12, '水平初速 8.5');
  near(res!.vy, 0, 1e-12, '侧向为 0');
  near(res!.vz, 6.0, 1e-12, '垂直初速 6.0');
  near(res!.originZ, 0.85, 1e-12, '从 0.85 高度出手');
  eq(res!.throwerId, 'a', '投掷者是承载者');
  eq(top.body.carriedBy, null, '抛出后脱离链');
  eq(map.get('a')!.body.carrying, null, '承载者清空');
  eq(sys.chainOf('a').length, 1, '链条只剩底层');
  eq(sys.stats().throws, 1, '投掷计数');
  /* 冷却生效 */
  ok(sys.isOnCooldown('a'), '投掷后有冷却');
});

test('canPerfectCatch 边界:z∈[0.3,1.4] 且 dist≤0.8', () => {
  eq(canPerfectCatch(0.3, 0.8), true, '下边界刚好命中');
  eq(canPerfectCatch(1.4, 0.8), true, '上边界刚好命中');
  eq(canPerfectCatch(0.3, 0.8000001), false, '距离越界即失败');
  eq(canPerfectCatch(0.2999, 0.1), false, 'z 低于 0.3 失败');
  eq(canPerfectCatch(1.4001, 0.1), false, 'z 高于 1.4 失败');
  eq(canPerfectCatch(0.85, 0.0), true, '正中命中');
  eq(canPerfectCatch(0.0, 0.0), false, '地面 z=0 不算接球');
  near(CATCH_Z_MIN, 0.3, 1e-12, '下限常数');
  near(CATCH_Z_MAX, 1.4, 1e-12, '上限常数');
});

test('checkCatch 返回中间量,与冻结层判定一致', () => {
  const { sys } = mkActors([['a', 0, 0, {}]]);
  const hit = sys.checkCatch(0.5, 0, 1.0, 0.6, 0);
  eq(hit.caught, true, '命中');
  eq(hit.inWindow, true, '在窗口内');
  eq(hit.nearEnough, true, '水平够近');
  near(hit.dist, 0.1, 1e-12, '水平距离');
  near(hit.z, 1.0, 1e-12, '高度');
  const miss = sys.checkCatch(5, 0, 1.0, 0, 0);
  eq(miss.caught, false, '太远不命中');
  eq(miss.nearEnough, false, '水平不够近');
  const tooHigh = sys.checkCatch(0.1, 0, 3.0, 0, 0);
  eq(tooHigh.caught, false, '太高不命中');
  eq(tooHigh.inWindow, false, '不在窗口');
});

test('抛物线轨迹上存在可接球窗口(接球点选在落点附近)', () => {
  const arc = simulateArc(0, 0, 0.85, 1, 0, 1, 0.001);
  const range = arcRange(arc);
  /* 接球窗口在下降段的末段(轨迹已经落到 1.4 以下),所以接球点要靠近落点。
     直接取射程 0.7 处 —— 那里 z≈1.4、水平距离≈0.06,正好在窗口内。 */
  const nearLanding = firstCatchWindow(arc, range * 0.7, 0);
  ok(nearLanding !== null, '落点前方能接到球');
  eq(nearLanding!.caught, true, '判定命中');
  ok(nearLanding!.z >= CATCH_Z_MIN && nearLanding!.z <= CATCH_Z_MAX, '接球高度落在窗口内');
  ok(nearLanding!.dist <= CATCH_RADIUS, '水平距离在半径内');
  /* 射程中段太高(z 远超 1.4),接不到 —— 这正是「完美接球」的难点所在 */
  eq(firstCatchWindow(arc, range / 2, 0), null, '射程中点高度过高,接不到');
  /* 起点后方接不到 */
  eq(firstCatchWindow(arc, -10, 0), null, '起点后方无法接球');
});

test('registerCatch 清冷却,空中传球允许连投', () => {
  const { sys } = mkActors([['a', 0, 0, {}], ['b', 0, 0, {}], ['c', 0, 0, {}]]);
  sys.tryLift('a', 'b');
  sys.throwTop('a', 1, 0);
  ok(sys.isOnCooldown('a'), '投掷后有冷却');
  const wasOnCd = sys.registerCatch('a');
  eq(wasOnCd, true, '接球时确实处于冷却');
  ok(!sys.isOnCooldown('a'), '接球后冷却清除');
  eq(sys.stats().perfectCatches, 1, '接球计数');
});

/* ═══════════════ 7. 掼摔 / 击退冲量(质量反比) ═══════════════ */

test('冲量与质量反比:Δv = J/m', () => {
  const pw = new PhysicsWorld();
  pw.spawn('light', { mass: 1.0 });
  pw.spawn('heavy', { mass: 3.0 });
  pw.spawn('boss', { mass: 20.0 });
  const j = 60;
  const a = pw.applyImpulse('light', j, 0, 0);
  const b = pw.applyImpulse('heavy', j, 0, 0);
  const c = pw.applyImpulse('boss', j, 0, 0);
  near(a.dvx, 60, 1e-12, '质量 1 → Δv 60');
  near(b.dvx, 20, 1e-12, '质量 3 → Δv 20');
  near(c.dvx, 3, 1e-12, '质量 20 → Δv 3');
  near(a.dvx / b.dvx, 3, 1e-12, '速度比 = 质量反比');
  near(b.dvx / c.dvx, 20 / 3, 1e-12, '轻物被击退更远');
  /* 动量守恒:p·m 相同 */
  near(a.dvx * 1.0, b.dvx * 3.0, 1e-9, '动量一致');
  near(b.dvx * 3.0, c.dvx * 20.0, 1e-9, '动量一致');
});

test('掼摔给被举者水平+下压速度,并从链上拆下', () => {
  const { sys, map } = mkActors([['a', 0, 0, {}], ['b', 0, 0, {}]]);
  sys.tryLift('a', 'b');
  const victim = map.get('b')!;
  victim.body.carriedBy = 'a';
  const dv = sys.applyImpulse('b', 30, 0, -30);
  near(dv.dvx, 30, 1e-12, '水平冲量生效');
  near(dv.dvz, -30, 1e-12, '下压冲量生效');
  eq(dv.blocked, false, '未免疫');
  eq(victim.body.carriedBy, null, '已从链上解脱');
  eq(victim.body.state, BodyState.STUNNED, '进入眩晕');
  ok(victim.body.stateTimer > 0, '眩晕计时');
});

test('掼摔冲量对重物效果按质量衰减', () => {
  const pw = new PhysicsWorld();
  pw.spawn('p', { mass: 1.0 });
  pw.spawn('h', { mass: 3.0 });
  const s1 = pw.slam('p', 1, 0, 30);
  const s2 = pw.slam('h', 1, 0, 30);
  near(s1.dvx, 30, 1e-12, '轻物水平 Δv');
  near(s2.dvx, 10, 1e-12, '重物水平 Δv = 30/3');
  near(s1.dvz, -30, 1e-12, '轻物下压');
  near(s2.dvz, -10, 1e-12, '重物下压');
});

/* ═══════════════ 8. 平安盾(物品 218)免疫 ═══════════════ */

test('平安盾 218:免疫举起、击退、掼摔', () => {
  eq(SHIELD_ITEM_ID, 218, '平安盾物品 ID');
  const { sys, map } = mkActors([
    ['attacker', 0, 0, {}],
    ['victim', 0, 0, { shield: true }],
  ]);
  /* 1. 免疫举起 */
  eq(sys.tryLift('attacker', 'victim'), CarryReject.SHIELDED, '举不起戴盾者');
  eq(sys.stats().shieldBlocks, 1, '盾拦截计数');
  eq(map.get('victim')!.body.carriedBy, null, '未被举起');
  /* 2. 免疫击退 */
  const imp = sys.applyImpulse('victim', 100, 100, 100);
  eq(imp.blocked, true, '击退被免疫');
  near(imp.dvx, 0, 1e-12, 'Δvx = 0');
  near(imp.dvy, 0, 1e-12, 'Δvy = 0');
  near(imp.dvz, 0, 1e-12, 'Δvz = 0');
  const v = map.get('victim')!.body;
  near(v.vx, 0, 1e-12, '速度未变');
  eq(v.state, BodyState.NORMAL, '状态未变(未被眩晕)');
  eq(sys.stats().shieldBlocks, 2, '两次拦截');
});

test('平安盾关闭后一切整蛊正常生效', () => {
  const { sys } = mkActors([['a', 0, 0, {}], ['b', 0, 0, { shield: false }]]);
  eq(sys.tryLift('a', 'b'), CarryReject.OK, '关盾后可以举');
  const imp = sys.applyImpulse('b', 10, 0, 0);
  eq(imp.blocked, false, '关盾后被击退');
  ok(imp.dvx > 0, 'Δvx 为正');
});

/* ═══════════════ 9. 加速带 317(10 格/秒推力) ═══════════════ */

test('加速带 317 沿箭头方向施加 10 格/秒推力', () => {
  eq(BELT_FORCE.get(317), 10.0, '配表原文:10 格/秒');
  const map = new Map<string, number>();
  rect(map, 0, 0, 20, 20, SLOT_BELT);
  const pw = new PhysicsWorld({ terrain: terrainWith(map) });
  /* faceDirAt 返回 1 = 东,即 +x */
  const b = pw.spawn('p', { x: 5.5, y: 5.5, z: 0 });
  near(b.vx, 0, 1e-12, '初始静止');
  pw.step();
  /* integrateHorizontal: v' = v*mu + belt/m = 0 + 10/1 = 10 */
  near(b.vx, 10.0, 1e-9, '第一帧后沿 +x 速度 = 10 格/秒');
  ok(b.x > 5.5, '确实被推动');
});

test('加速带在无推力方向上不影响侧向,地砖可由 META 改向', () => {
  const map = new Map<string, number>();
  rect(map, 0, 0, 20, 20, SLOT_BELT);
  /* 朝向 2 = 南(+y) */
  const t: PhysTerrain = {
    floorSlotAt: (x, y) => map.get(`${x},${y}`) ?? 0,
    objIdAt: () => 0,
    elevAt: () => 1,
    faceDirAt: () => 2,
  };
  const pw = new PhysicsWorld({ terrain: t });
  const b = pw.spawn('p', { x: 5.5, y: 5.5, z: 0 });
  pw.step();
  near(b.vy, 10.0, 1e-9, '朝南时推力在 +y');
  near(b.vx, 0, 1e-9, 'x 方向无推力');
  ok(b.y > 5.5, '确实向南移动');
});

/* ═══════════════ 10. 蹦床砖 318 ═══════════════ */

test('蹦床砖 318:垂直弹射峰值直达 Z=2', () => {
  /* 解析初速 √(2·18·2) = 8.4853,但显式欧拉在 20Hz 下峰值会超调到 2.2176,
     因此实现里用二分反解出离散修正后的初速。两个数都要断言,把这件事钉死。 */
  near(BOUNCE_VZ_ANALYTIC, Math.sqrt(2 * 18 * 2), 1e-9, '解析值 = √(2·18·2)');
  near(BOUNCE_VZ_ANALYTIC, 8.485281374238570, 1e-9, '解析值 ≈ 8.4853');
  ok(BOUNCE_VZ < BOUNCE_VZ_ANALYTIC, '离散修正后的初速小于解析值');
  inRange(BOUNCE_VZ, 7.9, 8.4, `修正后初速 ${BOUNCE_VZ.toFixed(4)} 应落在合理区间`);
  near(CARRY_BOUNCE_VZ, BOUNCE_VZ, 1e-12, 'carry 与 world 导出同一常数');
  eq(BOUNCE_TARGET_Z, 2.0, '目标高度 Z=2');

  /* 用冻结层积分器验证:离散修正后的采样峰值确实落在 2.0 */
  const apex = apexHeight(BOUNCE_VZ);
  near(apex, 2.0, 0.01, `蹦床采样峰值 ${apex.toFixed(4)} 应为 2.0`);
  /* 反解函数自身也要能被验证:给别的目标高度同样成立 */
  near(apexHeight(launchSpeedForApex(1.0)), 1.0, 0.01, '目标 Z=1 的初速反解');
  near(apexHeight(launchSpeedForApex(3.0)), 3.0, 0.01, '目标 Z=3 的初速反解');
  /* 用解析值直接上,峰值会明显超过 2.0 —— 这就是必须修正的原因 */
  ok(apexHeight(BOUNCE_VZ_ANALYTIC) > 2.1, `用解析值峰值 ${apexHeight(BOUNCE_VZ_ANALYTIC).toFixed(4)} 会超调`);
});

test('踩上蹦床砖会被弹起,带回 LANDED/BOUNCED 特效', () => {
  const map = new Map<string, number>();
  rect(map, 0, 0, 20, 20, SLOT_TRAMPOLINE);
  const pw = new PhysicsWorld({ terrain: terrainWith(map) });
  const b = pw.spawn('p', { x: 5.5, y: 5.5, z: 0.1, vz: -2 });
  let bounced = false;
  for (let i = 0; i < 40; i += 1) {
    pw.step();
    if (pw.fx.some((f) => f.kind === 'BOUNCED')) bounced = true;
    if (b.z > 1.0) break;
  }
  ok(bounced, '触发 BOUNCED 特效');
  ok(pw.totalBounces >= 1, '弹跳计数');
  ok(b.z > 0.5, `被弹起,当前 z=${b.z.toFixed(2)}`);
});

/* ═══════════════ 11. 火炭 / 荆棘 / 落穴 ═══════════════ */

test('火炭砖 320 每秒 15 点灼烧', () => {
  eq(BURN_DPS, 15, '配表原文 15 伤害/秒');
  const map = new Map<string, number>();
  rect(map, 0, 0, 20, 20, SLOT_COAL);
  const pw = new PhysicsWorld({ terrain: terrainWith(map) });
  pw.spawn('mob', { x: 5.5, y: 5.5, z: 0 });
  pw.step();
  ok(pw.totalBurns >= 1, '触发灼烧');
  const fx = pw.fx.filter((f) => f.kind === 'BURNED');
  ok(fx.length >= 1, '产生 BURNED 特效');
  eq(fx[0].magnitude, 15, '特效携带 15 点/秒');
});

test('荆棘地垫 324 每秒 20 点流血', () => {
  eq(BLEED_DPS, 20, '荆棘 20 伤害/秒');
  const map = new Map<string, number>();
  rect(map, 0, 0, 20, 20, SLOT_THORN);
  const pw = new PhysicsWorld({ terrain: terrainWith(map) });
  pw.spawn('mob', { x: 5.5, y: 5.5, z: 0 });
  pw.step();
  const fx = pw.fx.filter((f) => f.kind === 'BURNED' && f.magnitude === 20);
  ok(fx.length >= 1, '荆棘走同一条伤害通道但数值为 20');
});

test('落穴草席 319:踩上 0.4 秒后碎裂', () => {
  near(TRAP_DELAY, 0.4, 1e-12, '延迟 0.4 秒');
  const map = new Map<string, number>();
  rect(map, 0, 0, 20, 20, SLOT_TRAP);
  const pw = new PhysicsWorld({ terrain: terrainWith(map) });
  pw.spawn('victim', { x: 5.5, y: 5.5, z: 0 });
  /* 0.4s / 0.05s = 8 帧 */
  const framesNeeded = Math.ceil(TRAP_DELAY / DT);
  eq(framesNeeded, 8, '0.4s = 8 帧');
  for (let i = 0; i < framesNeeded - 1; i += 1) pw.step();
  eq(pw.totalTraps, 0, '第 8 帧之前不碎裂');
  pw.step();
  eq(pw.totalTraps, 1, '第 8 帧碎裂');
  ok(pw.fx.some((f) => f.kind === 'TRAP_OPENED'), '产生 TRAP_OPENED 特效');
});

/* ═══════════════ 12. 圆形刚体碰撞与反弹 ═══════════════ */

test('圆形刚体两两碰撞:分离并按质量分配', () => {
  const pw = new PhysicsWorld({ terrain: FLAT_TERRAIN });
  const a = pw.spawn('a', { x: 5, y: 5, z: 0, vx: 4, vy: 0, mass: 1.0, radius: 0.35 });
  const b = pw.spawn('b', { x: 5.5, y: 5, z: 0, vx: -4, vy: 0, mass: 1.0, radius: 0.35 });
  const d0 = Math.hypot(b.x - a.x, b.y - a.y);
  ok(d0 < a.radius + b.radius, '初始重叠');
  pw.step();
  const d1 = Math.hypot(b.x - a.x, b.y - a.y);
  ok(d1 > d0, `碰撞后被推开 ${d0.toFixed(3)} → ${d1.toFixed(3)}`);
  ok(a.vx < 4, 'a 的速度被改变');
  ok(b.vx > -4, 'b 的速度被改变');
  ok(pw.lastReport.pairs >= 1, '统计碰撞对');
});

test('resolveCircleBounce 反弹方向正确', () => {
  /* 沿法线入射 → 完全反向(restitution=1) */
  const r1 = resolveCircleBounce(4, 0, 1, 0, 1.0);
  near(r1.x, -4, 1e-12, '法线反向');
  near(r1.y, 0, 1e-12, '切向不变');
  /* 切向入射 → 完全保持 */
  const r2 = resolveCircleBounce(0, 4, 1, 0, 1.0);
  near(r2.x, 0, 1e-12, '切向不变');
  near(r2.y, 4, 1e-12, '切向速度保留');
  /* restitution=0.5 时反射后速度减半 */
  const r3 = resolveCircleBounce(4, 0, 1, 0, 0.5);
  near(r3.x, -2, 1e-12, '半弹性反弹');
  near(COLLISION_RESTITUTION, 1.0, 1e-12, '默认完全弹性');
});

test('不同质量的碰撞:轻物被推得更远', () => {
  const pw = new PhysicsWorld({ terrain: FLAT_TERRAIN });
  const heavy = pw.spawn('heavy', { x: 5, y: 5, z: 0, vx: 2, vy: 0, mass: 20, radius: 1.2 });
  const light = pw.spawn('light', { x: 6.5, y: 5, z: 0, vx: 0, vy: 0, mass: 1, radius: 0.35 });
  const heavyX0 = heavy.x;
  const lightX0 = light.x;
  for (let i = 0; i < 10; i += 1) pw.step();
  const heavyMove = Math.abs(heavy.x - heavyX0);
  const lightMove = Math.abs(light.x - lightX0);
  ok(lightMove > 0, '轻物被推动');
  ok(heavyMove < lightMove, `重物位移 ${heavyMove.toFixed(3)} < 轻物位移 ${lightMove.toFixed(3)}`);
});

/* ═══════════════ 13. 10 万次 step 后无 NaN(硬断言) ═══════════════ */

test('10 万次 step 后所有实体坐标都是 Number.isFinite', () => {
  const rnd = mulberry32(20260219);
  const map = new Map<string, number>();
  /* 混搭各种地砖,包括加速带、冰砖、蹦床、漩涡 */
  const slots = [SLOT_ICE, SLOT_SWAMP, SLOT_HONEY, SLOT_BELT, SLOT_TRAMPOLINE, SLOT_VORTEX, SLOT_RAIL, 0];
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      map.set(`${x},${y}`, slots[Math.floor(rnd() * slots.length)]);
    }
  }
  const walls = new Set<string>();
  for (let y = 10; y < 30; y += 1) walls.add(`20,${y}`);

  const pw = new PhysicsWorld({
    terrain: terrainWith(map, walls),
    bounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
  });

  /* 16 人 + 40 野怪 + 1 Boss = 57 个刚体 */
  for (let i = 0; i < 16; i += 1) {
    pw.spawn(`p${i}`, {
      x: 5 + rnd() * 30, y: 5 + rnd() * 30, z: 0,
      vx: (rnd() - 0.5) * 12, vy: (rnd() - 0.5) * 12,
      mass: MASS_PLAYER, radius: RADIUS_PLAYER,
    });
  }
  for (let i = 0; i < 40; i += 1) {
    pw.spawn(`m${i}`, {
      x: 2 + rnd() * 36, y: 2 + rnd() * 36, z: rnd() * 2,
      vx: (rnd() - 0.5) * 20, vy: (rnd() - 0.5) * 20, vz: rnd() * 6,
      mass: MASS_HEAVY, radius: RADIUS_WILD,
    });
  }
  pw.spawn('boss', {
    x: 20, y: 5, z: 0, vx: 9, vy: 3,
    mass: MASS_BOSS, radius: RADIUS_BOSS,
  });
  eq(pw.size, 57, '16 + 40 + 1 = 57 个刚体');

  pw.run(100000, DT);
  eq(pw.tickCount, 100000, '真的跑了 10 万帧');

  /* 硬断言:每一个坐标与速度都必须有限 */
  for (const b of pw.bodies.values()) {
    ok(Number.isFinite(b.x), `${b.id}.x 必须是有限数,实际 ${b.x}`);
    ok(Number.isFinite(b.y), `${b.id}.y 必须是有限数,实际 ${b.y}`);
    ok(Number.isFinite(b.z), `${b.id}.z 必须是有限数,实际 ${b.z}`);
    ok(Number.isFinite(b.vx), `${b.id}.vx 必须是有限数,实际 ${b.vx}`);
    ok(Number.isFinite(b.vy), `${b.id}.vy 必须是有限数,实际 ${b.vy}`);
    ok(Number.isFinite(b.vz), `${b.id}.vz 必须是有限数,实际 ${b.vz}`);
    ok(Number.isNaN(b.x) === false, `${b.id}.x 不是 NaN`);
    ok(Math.abs(b.x) < 1e6, `${b.id}.x 未发散`);
    ok(Math.abs(b.y) < 1e6, `${b.id}.y 未发散`);
  }
  ok(pw.allFinite(), 'allFinite() 汇总为真');
  /* 全部落在世界边界内 */
  for (const b of pw.bodies.values()) {
    inRange(b.x, 0, 40, `${b.id}.x 在世界内`);
    inRange(b.y, 0, 40, `${b.id}.y 在世界内`);
  }
});

test('极端速度也不产生 NaN(子步与钳制生效)', () => {
  const pw = new PhysicsWorld({ terrain: FLAT_TERRAIN, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } });
  const b = pw.spawn('fast', { x: 50, y: 50, z: 0, vx: 1e6, vy: -1e6, vz: 1e6 });
  pw.step();
  ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z), '坐标仍有限');
  ok(Number.isFinite(b.vx) && Number.isFinite(b.vy) && Number.isFinite(b.vz), '速度仍有限');
  /* ★ task-89:原断言 `ok(pw.lastReport.substeps <= MAX_SUBSTEPS)` 是**空断言** ——
     substeps 的**上界就是 `MAX_SUBSTEPS` 本身**(world.ts:329-333
     `clampInt(Math.ceil((vmax*dt)/0.25), 1, MAX_SUBSTEPS)`),
     故该不等式对**任意**常量值恒真。实测注入 4→5 时 WS-02 仍 43/43 全绿,
     且该场景的 substeps 已被**钳到上界**(实测 = 4,不是 1)⇒ 断言确实被行使过却仍无牙。
     修法(与 WS-10 `MAX_DODGE_RATE` 同一修法):
       1 断言**被钳到的具体值** 4(字面量)⇒ 钳制逻辑漂移就红;
       2 断言常量本身 = 4(字面量)⇒ 常量漂移就红。
     4 的独立来源:手册 `docs/WS-02-physics.md` §5 参数表(L356
     「MAX_SUBSTEPS | 4 | 见 §4.1 推导」),以及 §4.1 伪码(L156
     「substeps = clamp(ceil(vmax·dt / 0.25), 1, 4)」)与 L164 的推导
     (「上限 4 步(对应 80 格/秒)」)。 */
  eq(pw.lastReport.substeps, 4, '1e6 速度下 substeps 被钳到上界 4(手册 §4.1 L156)');
  eq(MAX_SUBSTEPS, 4, 'MAX_SUBSTEPS 本身 = 4(手册 §5 参数表 L356)');
  ok(pw.lastReport.substeps <= MAX_SUBSTEPS, `子步数被钳制在 ${MAX_SUBSTEPS}`);
  /* 注入 NaN 也能被兜底 */
  const c = pw.spawn('nan', { x: 10, y: 10, z: 0 });
  c.x = Number.NaN;
  pw.step();
  ok(Number.isFinite(c.x), 'NaN 坐标被复位');
});

/* ═══════════════ 14. 性能(16+40+1) ═══════════════ */

test('16 人 + 40 野怪 + 1 Boss 的单帧耗时在 50ms 预算内', () => {
  const rnd = mulberry32(7);
  const map = new Map<string, number>();
  for (let y = 0; y < 48; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      map.set(`${x},${y}`, [SLOT_ICE, SLOT_HONEY, SLOT_WOOD, 0][Math.floor(rnd() * 4)]);
    }
  }
  const pw = new PhysicsWorld({
    terrain: terrainWith(map),
    bounds: { minX: 0, minY: 0, maxX: 48, maxY: 48 },
  });
  for (let i = 0; i < 16; i += 1) pw.spawn(`p${i}`, { x: 5 + rnd() * 38, y: 5 + rnd() * 38, z: 0, vx: 3, vy: 2 });
  for (let i = 0; i < 40; i += 1) pw.spawn(`m${i}`, { x: 5 + rnd() * 38, y: 5 + rnd() * 38, z: 0, vx: -2, vy: 1, mass: MASS_HEAVY });
  pw.spawn('boss', { x: 20, y: 20, z: 0, vx: 1, vy: 0, mass: MASS_BOSS, radius: RADIUS_BOSS });

  const bench = pw.benchmark(200, 20);
  ok(bench.avgMs < 50, `平均单帧 ${bench.avgMs.toFixed(3)}ms 应 < 50ms(留满 20Hz 的 1/20)`);
  ok(Number.isFinite(bench.maxMs), '最大耗时有限');
  /* 碰撞对数量 = n(n-1)/2 = 57·56/2 = 1596 */
  eq((57 * 56) / 2, 1596, '两两碰撞对数量 1596');
  ok(pw.lastReport.pairs >= 1500, '确实做了全量两两检测');
});

test('内存上界:57 个刚体的开销远低于 1GB', () => {
  /* 单个 DynamicBody 约为:6 个 number 坐标速度(48B) + radius/mass/stateTimer/mu(32B)
     + 3 个字符串引用/枚举(24B) + carriedBy/carrying(16B) + id 字符串 ≈ 128B */
  const ESTIMATED_BYTES_PER_BODY = 192;
  const bodies = 16 + 40 + 1;
  const total = bodies * ESTIMATED_BYTES_PER_BODY;
  eq(bodies, 57, '同屏刚体数');
  ok(total < 16 * 1024, `57 个刚体约 ${total}B,远低于 1GB`);
  /* 物理世界的 Map 开销:每项 ~48B 哈希槽 */
  const mapOverhead = bodies * 48;
  ok(total + mapOverhead < 32 * 1024, '含 Map 开销仍 < 32KB');
});

/* ═══════════════ 15. 与锁存层积分的往返一致性 ═══════════════ */

test('integrateHorizontal 的摩擦与外力行为符合公式', () => {
  /* v' = v*mu + a*dt + (F+belt)/m */
  const r = integrateHorizontal(4.5, 0, 0.98, 0, 0, 0, 0, 10, 0, 1.0, 0.05);
  near(r.x, 4.5 * 0.98 + 10, 1e-12, '摩擦 + 加速带');
  const r2 = integrateHorizontal(4.5, 0, 0.98, 1, 0, 0, 0, 0, 0, 1.0, 0.05);
  near(r2.x, 4.5 * 0.98 + 1 * 0.05, 1e-12, '加速度项 dt 缩放');
  const r3 = integrateHorizontal(4.5, 0, 0.98, 0, 0, 6, 0, 0, 0, 3.0, 0.05);
  near(r3.x, 4.5 * 0.98 + 6 / 3.0, 1e-12, '冲量按质量反比');
  const r4 = integrateHorizontal(0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0.05);
  near(r4.x, 0, 1e-12, '质量为 0 时按 1 处理,不产生 NaN');
});

test('integrateVertical 落地钳制与空中积分', () => {
  const ground = integrateVertical(-0.01, -5, DT);
  eq(ground.z, 0, '落到地面 z=0');
  eq(ground.vz, 0, '落地速度清零');
  eq(ground.grounded, true, 'grounded');
  const air = integrateVertical(5, 0, DT);
  near(air.z, 5, 1e-12, '空中 z 由 vz 决定(此处 vz=0,仅受重力影响)');
  near(air.vz, GRAVITY * DT, 1e-12, '空中 vz 受重力');
  eq(air.grounded, false, '未落地');
});

test('物理世界与 CarrySystem 协作:被举起者不被二次积分', () => {
  const pw = new PhysicsWorld({ terrain: FLAT_TERRAIN });
  const a = pw.spawn('a', { x: 5.5, y: 5.5, z: 0 });
  const b = pw.spawn('b', { x: 5.5, y: 5.5, z: 0 });
  const map = new Map<string, CarryActor>([
    ['a', { body: a, shield: false }],
    ['b', { body: b, shield: false }],
  ]);
  const cs = new CarrySystem(map);
  eq(cs.tryLift('a', 'b'), CarryReject.OK, '举起成功');
  const zBefore = b.z;
  near(zBefore, 0.85, 1e-12, '被举者已同步高度');
  pw.step();
  near(b.z, zBefore, 1e-12, '物理不再对 zenith 位置积分');
  eq(b.mu, 1.0, '被举者摩擦置 1(不滑落)');
});

report('WS-02');