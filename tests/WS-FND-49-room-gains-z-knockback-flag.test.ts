/**
 * WS-FND-49 —— 「读数口存在但玩家感觉不到」这一族的**接线判据**。
 *
 * ## 冻的是哪四处
 *
 * | 概念 | 接线前 | 接线后 |
 * |---|---|---|
 * | 温泉上限 `×1.3` | `effectiveMaxHp()` 有乘区,但**没人调它** ⇒ 玩家的权威上限没变 | 乘区落在 `maxHpForLevel`(上限的**唯一**算子)⇒ 经 `syncMaxHp` 到权威、从 wire 读得到 |
 * | z 轴 | wire 与刚体都有 `z`,但 `applyPlayerMove` 只收 x/y ⇒ **丢在签名上** | 服务端写进刚体,投影从权威读回 |
 * | 击退 | 冲量算出来了、**没有消费者** | 机制已实现并判据化(`applyKnockback` + 慢帧推位移 + 窗口内拒搬);**尚未接到受击点上** —— 受击推多远是玩法裁决(接上会打红 `WS-10` 三条既有判据,见 `world_sim.ts` 受击点注释) |
 * | 复活旗 C2 | `flagRevive` 有实现、生产调用点 0 | 倒在旗旁 ⇒ 自己读条半血复活 |
 *
 * ⚠️ 断言右侧一律用**字面量**(`130`/`100`/`50`/`3`),不从被测模块取期望值。
 * ⚠️ 每个"接线"都配**负对照**,否则"改了但没生效"与"没改"分不开。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';

const ONSEN_LANTERN = 526; /* 露天温泉石灯笼(温泉馆识别件) */
const REVIVE_FLAG = 435; /* 复活旗 */

/** 一张安静的图:`mobs: false` 不刷怪,`wiring: false` 不挂集成。 */
function bareSim(): WorldSim {
  return new WorldSim({ sizeCells: 24, mobs: false, wiring: false });
}

/** 让房间效果积累(与 WS-03 的 `tickInRoom` 同形:钉住位置再推帧)。 */
function tickAt(sim: WorldSim, id: string, x: number, y: number, ticks = 40): void {
  sim.setPlayerPos(id, x, y);
  for (let i = 0; i < ticks; i += 1) sim.tick();
}

/* ══════════════════ 1 温泉上限:真的到达玩家 ══════════════════ */

test('FND49-1 ★ 温泉乘区真的到权威上限:`maxHpForLevel` → `syncMaxHp` → wire = 130', () => {
  const a = assemble({ roomId: 'r_onsen_wire', ownerId: 'p1', sizeCells: 24, mobs: false });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as WorldSim;
  sim.addPlayer('p1', 12.5, 12.5);
  sim.advance(60); /* 房间效果记录在慢帧里建立(`roomEffectOf` 之后才有对象) */
  a.runtime.step(null);
  eq(a.runtime.state.players.find((x) => x.id === 'p1')?.maxHp, 100, '前置:没有房间效果时上限 100');

  /* 写入温泉的 20 分钟计时 —— 真实世界里这一步由 `stepRoomEffects` 填
     (WS-03 的"计时到点"判据用的是同一个字段,同一手法)。
     这里要钉的是**乘区有没有经算子到达权威**,不是房间识别。 */
  sim.roomEffectOf('p1')!.onsenSec = 100;
  a.runtime.step(null);

  const p = a.runtime.state.players.find((x) => x.id === 'p1');
  /* 手册:「战前泡澡获 20 分钟生命上限 +30%」;1 级基础上限 = 100。 */
  eq(p?.maxHp, 130, '★★ 权威上限必须是 130(乘区接在 `maxHpForLevel` 上才会经 `syncMaxHp` 落到权威)');
});

test('FND49-2 负对照:温泉计时耗尽 ⇒ 权威上限回到 100(不是台阶式只升不降)', () => {
  const a = assemble({ roomId: 'r_onsen_expire', ownerId: 'p1', sizeCells: 24, mobs: false });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as WorldSim;
  sim.addPlayer('p1', 12.5, 12.5);
  sim.advance(60);

  sim.roomEffectOf('p1')!.onsenSec = 100;
  a.runtime.step(null);
  eq(a.runtime.state.players.find((x) => x.id === 'p1')?.maxHp, 130, '前置:先涨到 130');

  sim.roomEffectOf('p1')!.onsenSec = 0;
  a.runtime.step(null);
  eq(a.runtime.state.players.find((x) => x.id === 'p1')?.maxHp, 100,
    '★ 计时到点 ⇒ 权威上限回 100(增益是派生的,不是写进存档的)');
});

/* ══════════════════ 2 z 轴:服务端 ══════════════════ */

test('FND49-3 ★ 权威 z 真的进刚体(不再丢在签名上)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.playerPosition('p1')!.z, 0, '前置:新玩家高度 0');

  eq(sim.applyPlayerMove('p1', 12.5, 12.5, 3), true, '带 z 的移动应被接受');
  eq(sim.playerPosition('p1')!.z, 3, '★★ 权威高度必须是 3');
});

test('FND49-4 z 非有限 ⇒ 与 x/y 同一道门(拒绝,且不写半个状态)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.applyPlayerMove('p1', 12.5, 12.5, 3), true, '前置:先有一个合法高度');

  eq(sim.applyPlayerMove('p1', 13.5, 13.5, Number.NaN), false, 'NaN 高度必须被拒');
  eq(sim.lastMoveRejection, 'NON_FINITE', '拒绝理由应为 NON_FINITE(与 x/y 同码)');
  eq(sim.playerPosition('p1')!.z, 3, '★ 被拒时高度不得被改');
  eq(sim.playerPosition('p1')!.x, 12.5, '★ 被拒时平面也不得被改(整条报文一起拒)');
});

test('FND49-5 负对照:省略 z ⇒ 不改高度(老调用方行为逐字不变)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  sim.applyPlayerMove('p1', 12.5, 12.5, 5);
  eq(sim.applyPlayerMove('p1', 14.5, 14.5), true, '不带 z 的移动仍应被接受');
  eq(sim.playerPosition('p1')!.x, 14.5, '平面按新值');
  eq(sim.playerPosition('p1')!.z, 5, '★ 高度保持 5(省略 ≠ 归零)');
});

/* ══════════════════ 3 击退:位移真的发生 ══════════════════ */

test('FND49-6 ★ 击退**机制**:位移真的发生(不是 no-op;⚠️ 尚未接到受击点上)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.applyKnockback('p1', 10.5, 12.5, 2), true, '前置:施加 2 格的击退');
  eq(sim.knockbackOf('p1'), true, '★ 击退窗口打开');

  for (let i = 0; i < 60; i += 1) sim.tick();
  const pos = sim.playerPosition('p1')!;
  ok(pos.x > 13.5, `★ 必须被推开(从攻击者 (10.5) 反方向;实测 x=${pos.x.toFixed(3)})`);
  eq(sim.knockbackOf('p1'), false, '推完 ⇒ 窗口关闭');
});

test('FND49-7 ★ 击退窗口内**不接受位置搬家**(否则下一帧报文就把击退抹掉)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  sim.applyKnockback('p1', 10.5, 12.5, 2);

  eq(sim.applyPlayerMove('p1', 99, 99), false, '窗口内移动报文必须被拒');
  eq(sim.lastMoveRejection, 'KNOCKBACK', '★ 拒绝理由应为 KNOCKBACK(可观测,不是静默 true)');
  eq(sim.playerPosition('p1')!.x, 12.5, '★ 位置不得被搬家');

  for (let i = 0; i < 60; i += 1) sim.tick();
  eq(sim.applyPlayerMove('p1', 5, 5), true, '窗口关闭后移动恢复');
  eq(sim.playerPosition('p1')!.x, 5, '★ 恢复后按报文走');
});

test('FND49-8 负对照:距离非正 / 与攻击者重合 ⇒ 不击退(不随便挑方向)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.applyKnockback('p1', 10.5, 12.5, 0), false, '距离 0 不算击退');
  eq(sim.applyKnockback('p1', 12.5, 12.5, 2), false, '与攻击者重合 ⇒ 没有方向可言');
  eq(sim.knockbackOf('p1'), false, '★ 两次都不该打开窗口');
});

/* ══════════════════ 4 复活旗(C2)══════════════════ */

test('FND49-9 ★ 倒在复活旗旁 ⇒ 自己读条、半血复活', () => {
  const sim = bareSim();
  sim.setCell(6, 6, { obj: REVIVE_FLAG });
  sim.addPlayer('p1', 6.5, 6.5);

  const v = sim.vitals.get('p1')!;
  v.hp = 0;
  v.downed = true;
  /* 4 个慢帧 = 2.0 s = `FLAG_REVIVE_TIME`;给 400 快帧留足余量。 */
  for (let i = 0; i < 400; i += 1) sim.tick();

  eq(sim.vitals.get('p1')!.downed, false, '★★ 站在旗旁读条必须复活(此前生产调用点 0 ⇒ 永远躺在地上)');
  eq(sim.vitals.get('p1')!.hp, 50, '★ 半血复活(手册口径;1 级上限 100 的一半)');
});

test('FND49-10 负对照:半径外没有旗 ⇒ 不复活(旗的判定只认距离)', () => {
  const sim = bareSim();
  sim.setCell(6, 6, { obj: REVIVE_FLAG });
  sim.addPlayer('p1', 20.5, 20.5); /* 离旗 14 格 > 半径 3 */

  const v = sim.vitals.get('p1')!;
  v.hp = 0;
  v.downed = true;
  for (let i = 0; i < 400; i += 1) sim.tick();

  eq(sim.vitals.get('p1')!.downed, true, '★ 半径外不得复活');
  eq(sim.vitals.get('p1')!.hp, 0, '★ 也不该偷偷回血');
});

/* ══════════════════ 5 泡泡困住:227 的"困住"真的有消费者 ══════════════════ */

test('FND49-11 ★ 被泡泡困住 ⇒ 不能移动(227 的"困住 5 秒"不再只是回执里的字段)', () => {
  const a = assemble({ roomId: 'r_trap_wire', ownerId: 'p1', sizeCells: 32, mobs: false });
  a.runtime.join({ userId: 'p1' });
  a.runtime.join({ userId: 'p2' });
  const sim = a.host as unknown as WorldSim;
  if (!sim.physics.bodies.has('p1')) sim.addPlayer('p1', 12.5, 12.5);
  if (!sim.physics.bodies.has('p2')) sim.addPlayer('p2', 13.5, 12.5);
  const src = 'seed:227';
  a.runtime.grantItemSource('p1', src);
  a.runtime.applyInventory('p1', { ops: [{ itemId: 227, delta: 3, source: src }] });

  /* 对**活人**连中 3 发 ⇒ `combat/live_bubble.ts` 判"被困住"(存活半边,见 FND39-14)。 */
  for (let i = 0; i < 3; i += 1) {
    a.runtime.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 227, targetId: 'p2' });
  }

  eq(sim.applyPlayerMove('p2', 20.5, 20.5), false, '★★ 被困住 ⇒ 移动必须被拒');
  eq(sim.lastMoveRejection, 'TRAPPED', '★ 拒绝理由应为 TRAPPED(可观测,不是静默 true)');
});

/* ══════════════════ 6 大餐乘区:世界侧读得到 ══════════════════ */

test('FND49-12 ★ `lastRoomEffects[].mealMul` 真的从世界侧读得到(接在 `tickRoomEffects` 上)', () => {
  const a = assemble({ roomId: 'r_meal_wire', ownerId: 'p1', sizeCells: 24, mobs: false });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as WorldSim;
  sim.addPlayer('p1', 12.5, 12.5);
  sim.advance(60);

  const before = sim.lastRoomEffects.find((r) => r.playerId === 'p1');
  ok(before !== undefined, '前置:房间效果记录应存在');
  /* 不在食堂 ⇒ 1.0(两个条件缺一不行;食堂那一半由 `WS-FND-47` FND47-1 用字面量 1.4 钉住 ——
     在这里盖一间食堂要复刻整间封闭房,而这条要钉的是**世界侧读口存不存在**)。 */
  eq(before?.mealMul, 1, '★ 不在食堂 ⇒ mealMul = 1.0(字段必须存在且是数值)');
  eq(typeof before?.mealMul, 'number', '★ 必须是数值(不是 undefined)');

  /* 吃一份料理 ⇒ 字段仍在、仍 1.0(不在食堂);证明它不是"有 buff 就加"的错口径。 */
  const src = 'seed:602';
  a.runtime.grantItemSource('p1', src);
  a.runtime.applyInventory('p1', { ops: [{ itemId: 602, delta: 1, source: src }] });
  const used = a.runtime.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 602 });
  eq(used.kind, 'OK', '前置:料理应能吃下');
  sim.advance(60);

  const after = sim.lastRoomEffects.find((r) => r.playerId === 'p1');
  eq(after?.mealMul, 1, '★ 有 buff 但不在食堂 ⇒ 仍是 1.0(条件是两个,不是一个)');
});

report('WS-FND-49');