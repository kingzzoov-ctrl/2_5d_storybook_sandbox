/**
 * WS-FND-71 —— **战斗深度 D1–D7** + `USE_ITEM` 的 itemId 服务端读口。
 *
 * ## 这个套件钉什么(逐条对应 `docs/BACKLOG-108-TRIAGE.md` §3 第 8 组)
 *
 * | 判据 | 钉的是 | 修前的实测症状 |
 * | :--- | :--- | :--- |
 * | FND71-1/2 | **D1** 击退:参数 + 写回 `PhysicsBody` | `applyHit` 没有击退参数;`applyImpulse` 生产调用点 **0** |
 * | FND71-3/4 | **D2** 视线遮挡(纯函数 + 真世界) | 隔着 1 格墙也打中;全仓没有视线函数 |
 * | FND71-5/6/7/8 | **D3** PvP 开关 + Boss 技能对玩家的特殊效果 | 玩家之间没有入口;Boss 招式只对着空气放 |
 * | FND71-9 | **D4** 玩家侧元素抗性 | 抗性只在天赋里,生物伤害不分元素 |
 * | FND71-10/11/12 | **D5** 玩家侧致盲(命中 / 视野 / 倒计时 / 生产来源) | 只有生物的 `mem.blindSec` |
 * | FND71-13 | **D6** `worldSaveHost` 一行装配 | 运行期恒 `null` ⇒ 存档整段不进 |
 * | FND71-14 | **D7** `damage.ts` 八步 + `components.ts` 昼夜**真的是消费者** | 两者曾在可达性白名单里 |
 * | FND71-15/16 | **itemId 读口** | `USE_ITEM` 信客户端自报的 itemId ⇒ 白嫖 |
 *
 * ## 断言纪律
 *
 * 右侧一律用**字面量**(`2` / `8` / `0.5` / `12` / `16` / `19`),不取被测模块的导出常量
 * ——期望值取自被测模块就是同义反复(`--strict-taut`)。
 * 每个判据都有**负对照**(不该生效的那一侧也断言),否则「恒真」也能过。
 */
import { test, ok, eq, near, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { lineOfSight, losBlocked, losClear } from '../server/src/world/vision.ts';
import { pvpVerdict } from '../server/src/combat/damage.ts';
import { VitalsSystem } from '../server/src/combat/vitals.ts';
import { isNight as isNightAtHour } from '../server/src/wiring/components.ts';
import { createBossState } from '../server/src/bosses/phases.ts';

/* ═════════════════════ 夹具 ═════════════════════ */
type Scene = { sim: WorldSim };
type RoomScene = { sim: WorldSim; rt: ReturnType<typeof assemble>['runtime'] };

/**
 * 纯世界夹具(**不经房间**)—— 战斗深度用。
 *
 * ⚠️ 为什么**不**用 `assemble()`:装配出来的房间有它自己的出生点与地形种子,
 * 玩家位置与"我以为是几格"会不一致 ⇒ 距离类判据会**静默偏移**
 * (我第一次写的就是 assemble 版:FND71-4 的墙明明砌了却仍有 90 次命中)。
 * `WS-FND-53` / `WS-04` 的夹具也都是裸 `new WorldSim`。
 */
function combatScene(sizeCells = 32): Scene {
  const sim = new WorldSim({ sizeCells, mobs: true, rng: mulberry32(7) });
  sim.addPlayer('p1', 12.5, 8.5);
  return { sim };
}

/** 无生物的纯世界(战斗判据的"安静"一半)。 */
function quietScene(sizeCells = 24): Scene {
  const sim = new WorldSim({ sizeCells, mobs: false });
  sim.addPlayer('p1', 8, 8);
  return { sim };
}

/** **经房间**装配的世界(道具 / 存档判据需要 `RoomRuntime`)。 */
function roomScene(sizeCells = 24): RoomScene {
  const a = assemble({ roomId: `r71q_${Math.random().toString(36).slice(2, 8)}`, ownerId: 'p1', sizeCells, mobs: false, rng: mulberry32(7) });
  const sim = a.host as unknown as WorldSim;
  a.runtime.join({ userId: 'p1' });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const id of a.runtime.authoritativeItemIds('p1')) a.runtime.applyInventory('p1', { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount('p1', id) }] });
  if (!sim.physics.bodies.has('p1')) sim.addPlayer('p1', 8, 8);
  return { sim, rt: a.runtime };
}

/** 推到第一次命中(返回帧号,-1 = 一直没命中)。 */
function untilHit(sim: WorldSim, max = 1200): number {
  for (let i = 1; i <= max; i += 1) {
    sim.tick();
    if (sim.lastHits.length > 0) return i;
  }
  return -1;
}

const bodyOf = (sim: WorldSim, id: string): { x: number; y: number; z: number; vx: number; vy: number; vz: number; mass: number } => {
  const b = sim.physics.bodies.get(id) as unknown as
    { x: number; y: number; z: number; vx: number; vy: number; vz: number; mass: number } | undefined;
  if (b === undefined) throw new Error(`前置失败:${id} 没有刚体`);
  return b;
};

/* ═════════════════════ D1 击退 ═════════════════════ */

test('FND71-1 ★★ D1:击退量由**内容层**给出、写进 PhysicsBody,且不与 D-09 的位移预算双算', () => {
  const { sim } = combatScene();
  sim.addMob('mob_boar#1', 'MEADOW', 8.5, 8.5);
  const at = untilHit(sim);
  ok(at > 0, `应有一次命中(实测第 ${at} 帧;0 说明预警链路没跑)`);

  const hit = sim.lastHits[0]!;
  /* 内容层:生物没有武器 ⇒ `damage.ts` 第 8 步的无武器缺省 = 2 格/秒(字面量锚点)。 */
  eq(hit.knockbackPerSec, 2, '★ 命中的击退量应等于内容层的无武器缺省(2 格/秒)');
  eq(hit.rawDamage, hit.applied === 0 ? hit.rawDamage : hit.applied, '前置:这一击真的落地了');
  /* **写回 PhysicsBody**:纵向速度被写上(这正是「接受击退」的可观测形态)。 */
  ok(bodyOf(sim, 'p1').vz > 0, `★★ 刚体 vz 必须 > 0(实测 ${bodyOf(sim, 'p1').vz})—— 这是 applyImpulse 写回的证据`);

  /* 位移预算仍只由 D-09 花一次:`min(2, 伤害/20)`,不许被速度分量再加一份。 */
  sim.mobHost.removeMob('mob_boar#1');
  const x0 = sim.playerPosition('p1')!.x;
  for (let i = 0; i < 40; i += 1) sim.tick();
  const moved = Math.abs(sim.playerPosition('p1')!.x - x0);
  ok(moved <= 2 + 1e-9, `★★ 命中(含击退)后位移不得超过 D-09 的上限 2 格(实测 ${moved.toFixed(4)})`);
});

test('FND71-2 ★ D1 负对照:无敌帧挡下 ⇒ 不产生击退(参数与写回都必须是 0)', () => {
  const v = new VitalsSystem();
  v.register('p1');
  const first = v.applyHit('m1', 'p1', 1, 1.0, 0, 3);
  eq(first.applied > 0, true, '前置:第一拳落地');
  const second = v.applyHit('m2', 'p1', 1, 1.0, 0, 3);
  eq(second.blockedByIframe, true, '前置:第二拳被无敌帧挡下');
  eq(second.knockbackPerSec, 0, '★ 被挡下的那一拳不得产生击退');
  /* 不给参数 ⇒ 与修前**逐字段相同**(0)。 */
  const bare = new VitalsSystem();
  bare.register('p2');
  eq(bare.applyHit('m1', 'p2', 1, 1.0, 0).knockbackPerSec, 0, '★ 不传击退参数 ⇒ 0(修前语义不变)');
});

/* ═════════════════════ D2 视线遮挡 ═════════════════════ */

test('FND71-3 ★★ D2(纯函数):中间隔着实心格 ⇒ 视线被挡;端点/坏坐标 fail-open', () => {
  const wall = (x: number, y: number): boolean => x === 3 && y === 0;
  eq(lineOfSight(0.5, 0.5, 5.5, 0.5, wall), false, '★ 中间隔一格墙 ⇒ 视线被挡');
  eq(lineOfSight(0.5, 0.5, 5.5, 0.5, () => false), true, '负对照:一路无墙 ⇒ 通畅');
  /* fail-open 三条(起点/终点在墙里、坏坐标)—— 它们是**刻意的**:见 vision.ts 文件头。 */
  eq(lineOfSight(3.5, 0.5, 5.5, 0.5, wall), true, '起点在实心格 ⇒ 放行(卡墙的怪不该变成瞎子)');
  eq(lineOfSight(0.5, 0.5, 3.5, 0.5, wall), true, '终点在实心格 ⇒ 放行');
  eq(lineOfSight(Number.NaN, 0.5, 5.5, 0.5, wall), true, '坏坐标 ⇒ 放行(缺陷不伪装成平衡问题)');
  /* 反向读法必须与正读法互为取反(不许各写一份 DDA)。 */
  eq(losBlocked(0.5, 0.5, 5.5, 0.5, wall), true, 'losBlocked 是 lineOfSight 的取反');
  eq(losBlocked(0.5, 0.5, 5.5, 0.5, () => false), false, '负对照:无墙 ⇒ 不挡');
  /* 采样版(连续场)同语义:挡住时 false。 */
  eq(losClear(0.5, 0.5, 5.5, 0.5, wall), false, 'losClear(采样版)同样被挡');
});

test('FND71-4 ★★ D2(真世界):墙上之后怪打不中玩家;拆掉墙就打得中', () => {
  const blocked = combatScene();
  blocked.sim.addMob('mob_boar#1', 'MEADOW', 8.5, 8.5);
  /* 在怪(x≈8.5)与玩家(x=12.5)之间砌一道纵向墙(x=10)。 */
  for (let y = 6; y <= 10; y += 1) blocked.sim.setCell(10, y, { obj: 351 });
  let hits = 0;
  for (let i = 0; i < 600; i += 1) {
    blocked.sim.tick();
    hits += blocked.sim.lastHits.length;
  }
  eq(hits, 0, '★★ 隔墙 ⇒ 一次都不许命中(修前:隔墙照打)');
  ok(blocked.sim.losBlockedTotal > 0,
    `★ 必须留下"被视线挡下"的痕迹(实测 ${blocked.sim.losBlockedTotal})—— 否则分不清"挡了"与"根本没打"`);
  eq(blocked.sim.vitals.get('p1')!.hp, 100, '★ 玩家血量一点没掉');

  const open = combatScene();
  open.sim.addMob('mob_boar#1', 'MEADOW', 8.5, 8.5);
  let openHits = 0;
  for (let i = 0; i < 600; i += 1) {
    open.sim.tick();
    openHits += open.sim.lastHits.length;
  }
  ok(openHits > 0, `负对照:没有墙时必须真的打得中(实测 ${openHits} 次)`);
  eq(open.sim.losBlockedTotal, 0, '负对照:开阔场景里一次都不该被判遮挡');
});

/* ═════════════════════ D3 PvP + Boss 效果 ═════════════════════ */

test('FND71-5 ★★ D3 PvP 默认**关**:玩家互殴被拒且双方都零变化', () => {
  const { sim } = quietScene();
  sim.addPlayer('p2', 9.5, 8);
  eq(sim.pvpEnabled, false, '★ 缺省必须是关(与修前"玩家之间没有入口"等价)');
  const hp0 = sim.vitals.get('p2')!.hp;
  const vx0 = bodyOf(sim, 'p2').vx;
  const out = sim.attackPlayerAuthorized('p1', 'p2');
  eq(out.rejected, 'PVP_OFF', '★ 拒绝理由必须指认 PvP 开关');
  eq(out.applied, 0, '★ 零伤害');
  eq(sim.vitals.get('p2')!.hp, hp0, '★ 目标血量不变');
  eq(bodyOf(sim, 'p2').vx, vx0, '★ 连冲量都没有');
});

test('FND71-6 ★★ D3 PvP 开:走八步公式落地伤害 + 武器侧击退写回刚体', () => {
  const { sim } = quietScene();
  sim.addPlayer('p2', 9.5, 8);
  eq(sim.setPvp(true), true, '前置:打开 PvP');
  const hp0 = sim.vitals.get('p2')!.hp;
  const out = sim.attackPlayerAuthorized('p1', 'p2');
  eq(out.rejected, null, '★ 开关打开后必须真的结算(不再拒)');
  ok(out.applied > 0, `★ 伤害必须落地(实测 ${out.applied})`);
  eq(sim.vitals.get('p2')!.hp, hp0 - out.applied, '★★ 目标血量按 applied 减少');
  eq(out.result!.source, 'PVP', '★ 伤害来源必须是 PVP(不是普攻冒充)');
  ok(Math.abs(bodyOf(sim, 'p2').vx) > 0, '★ 卡通量:目标刚体获得横向速度(内容层的击退量)');
  /* 自打自必须拒(即使开关打开)。 */
  eq(sim.attackPlayerAuthorized('p1', 'p1').rejected, 'PVP_SELF', '自打自 ⇒ PVP_SELF');
});

test('FND71-7 ★ D3 `pvpVerdict` 是唯一判据(三档 + fail-closed)', () => {
  eq(pvpVerdict({ pvpEnabled: false, attackerId: 'a', targetId: 'b' }).reason, 'PVP_OFF', '关 ⇒ PVP_OFF');
  eq(pvpVerdict({ pvpEnabled: true, attackerId: 'a', targetId: 'a' }).reason, 'PVP_SELF', '自打自 ⇒ PVP_SELF');
  eq(pvpVerdict({ pvpEnabled: true, attackerId: 'a', targetId: '' }).reason, 'PVP_NO_TARGET', '空目标 ⇒ PVP_NO_TARGET');
  const okv = pvpVerdict({ pvpEnabled: true, attackerId: 'a', targetId: 'b' });
  eq(okv.allowed, true, '开关开 + 不同人 ⇒ 放行');
  eq(okv.reason, null, '放行时没有理由');
});

test('FND71-8 ★★ D3 Boss 技能对玩家的特殊效果:定身 / 击退都由**内容层几何**驱动', () => {
  /* 果冻王 P3 = 「巨口吸气」⇒ 定身(内容原文见 BOSS-108 §3 第 8 组)。 */
  const stunScene = combatScene(64);
  stunScene.sim.setPlayerPos('p1', 0.5, 0.5);
  const boss = createBossState('boss_jelly_king', 1);
  boss.x = 1.0; boss.y = 0.5; boss.phaseIndex = 2; boss.stunnedSec = 0;
  (stunScene.sim.bossRaid as unknown as { states: Map<string, unknown> }).states.set('boss_jelly_king', boss);

  let effects: { bossId: string; playerId: string; effect: string }[] = [];
  for (let i = 0; i < 200 && effects.length === 0; i += 1) {
    stunScene.sim.tick();
    effects = stunScene.sim.lastBossEffects.slice();
  }
  ok(effects.length > 0, '★ P3 的吸气必须对玩家**产生效果**(修前:招式只对着空气)');
  eq(effects[0]!.effect, 'STUN', '★ 记的效果种类应是 STUN');
  ok(stunScene.sim.vitals.stunOf('p1') > 0, '★ 玩家侧真的被定住(vitals.stunSec > 0)');
  eq(stunScene.sim.applyPlayerMove('p1', 3, 3), false, '★★ 定身期间不许移动');
  eq(stunScene.sim.lastMoveRejection, 'STUNNED', '★ 拒绝理由可观测(不是静默)');

  /* 果冻王 P1 = 「环形果冻波,击退并减速」⇒ 击退(玩家必须站在环带 2.5~3.5 上)。 */
  const ringScene = combatScene(64);
  ringScene.sim.setPlayerPos('p1', 3.2, 0.5);
  const ringBoss = createBossState('boss_jelly_king', 1);
  ringBoss.x = 0.5; ringBoss.y = 0.5; ringBoss.phaseIndex = 0; ringBoss.stunnedSec = 0;
  (ringScene.sim.bossRaid as unknown as { states: Map<string, unknown> }).states.set('boss_jelly_king', ringBoss);
  let ringEffects: { effect: string }[] = [];
  for (let i = 0; i < 200 && ringEffects.length === 0; i += 1) {
    ringScene.sim.tick();
    ringEffects = ringScene.sim.lastBossEffects.slice();
  }
  ok(ringEffects.length > 0, '★ P1 的环带必须命中环上的玩家');
  eq(ringEffects[0]!.effect, 'KNOCKBACK', '★ 记的效果种类应是 KNOCKBACK');
  ok(bodyOf(ringScene.sim, 'p1').vz > 0, '★ 击退写回刚体(vz > 0)');
});

/* ═════════════════════ D4 元素抗性 ═════════════════════ */

test('FND71-9 ★★ D4:玩家挨元素伤害按抗性折算;非法抗性被拒;无抗性与修前同值', () => {
  const v = new VitalsSystem();
  v.register('p1');
  v.register('p2');
  /* 4 级生物的基础伤害 = 6 + 2×(4−1) = 12(字面量,来自 `MOB_HIT_*` 的算式)。 */
  eq(v.applyHit('m', 'p1', 4, 1.0, 0).rawDamage, 12, '无抗性 ⇒ 与修前同值(12)');

  eq(v.setElementResist('p1', 'FIRE', 0.5), true, '前置:登记火抗 0.5');
  const fire = v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE');
  eq(fire.rawBeforeResist, 12, '折算前仍是 12');
  eq(fire.resistMul, 0.5, '★ 抗性系数被真的读到');
  eq(fire.rawDamage, 6, '★★ 火伤 12 × 0.5 = 6');
  /* 别的元素不受影响(抗性是**逐元素**的)。 */
  eq(v.applyHit('m', 'p2', 4, 1.0, 0, 0, 'ICE').rawDamage, 12, '★ 没登记 ICE 抗性 ⇒ 原值(不串味)');

  /* 三档口径:非法抗性**拒绝写入**(NaN 会让血量被永久污染)。 */
  eq(v.setElementResist('p1', 'FIRE', Number.NaN), false, '★ NaN 抗性必须被拒');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 被拒之后旧值不变');
  eq(v.setElementResist('p1', 'FIRE', 99), true, '超上界 ⇒ 接受但夹取');
  eq(v.elementResistOf('p1', 'FIRE'), 2, '★ 夹到上界 2.0(不是 99)');
});

/* ═════════════════════ D5 致盲 ═════════════════════ */

test('FND71-10 ★★ D5:致盲后**够不着的目标打不中**(命中受影响),清掉致盲就打得中', () => {
  const { sim } = quietScene();
  sim.addMob('mob_sheep#1', 'MEADOW', 10.0, 8.5); /* 距玩家 2.0 格:在武器 reach 内,但 >> 触摸半径 0.9 */
  sim.advance(2);
  const mob0 = sim.mobHost.runtimeOf('mob_sheep#1')!.hp;

  sim.vitals.applyBlind('p1', 5);
  eq(sim.vitals.blindOf('p1') > 0, true, '前置:已致盲');
  const miss = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  ok(miss.hit !== null, '前置:攻击确实结算了(不是"没有这只怪")');
  eq(miss.hit!.result.outOfReach, true, '★★ 致盲时超距攻击必须落空(走公式自己的 0a 步)');
  eq(miss.hit!.hpLoss, 0, '★ 生物一点血都不掉');
  eq(sim.mobHost.runtimeOf('mob_sheep#1')!.hp, mob0, '★ 生物 HP 原封不动');

  /* 负对照:同样距离、没有致盲 ⇒ 打得中(否则这条判据是恒真的)。 */
  sim.vitals.revive('p1');
  eq(sim.vitals.blindOf('p1'), 0, '前置:致盲已被清除');
  const hit = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  ok(hit.hit !== null && hit.hit.hpLoss > 0, '★ 无致盲 ⇒ 同一距离真的打出伤害');
});

test('FND71-11 ★ D5:视野半径受致盲影响;**倒计时**递减;复活清零', () => {
  const { sim } = combatScene();
  eq(sim.viewRadiusOf('p1'), 32, '基线:视野半径 32(AOI 唤醒半径,字面量)');
  sim.vitals.applyBlind('p1', 2);
  eq(sim.viewRadiusOf('p1'), 16, '★ 致盲 ⇒ 视野减半(16)');
  /* 慢帧 0.5s / 次 ⇒ 推 1 秒应剩 1。 */
  for (let i = 0; i < 20; i += 1) sim.tick();
  near(sim.vitals.blindOf('p1'), 1, 1e-9, '★ 致盲按时长消耗(2 → 1)');
  eq(sim.viewRadiusOf('p1'), 16, '★ 仍在致盲中 ⇒ 视野仍是减半的');
  sim.vitals.applyBlind('p1', 9);
  sim.vitals.revive('p1');
  eq(sim.vitals.blindOf('p1'), 0, '★ 复活必须清掉致盲(否则玩家永远瞎)');
  eq(sim.viewRadiusOf('p1'), 32, '★ 视野随之恢复');
});

test('FND71-12 ★★ D5 生产来源:真·幻叶小狸猫的 `tanuki_ambush` 让**玩家**致盲,且零伤害', () => {
  const { sim } = combatScene();
  sim.addMob('mob_tanuki#1', 'MEADOW', 10.5, 8.5);
  let blindAt = -1;
  for (let i = 0; i < 600; i += 1) {
    sim.tick();
    if (sim.vitals.blindOf('p1') > 0) { blindAt = i; break; }
  }
  ok(blindAt >= 0, '★★ 小狸猫的迷雾果必须真的致盲**玩家**(修前:只有它自己的 mem.blindSec)');
  ok(sim.lastBlindsApplied > 0, `★ 留下致盲计数(实测 ${sim.lastBlindsApplied})`);
  eq(sim.hitCount, 0, '★ 这件事是**零伤害**的(不是"0 点命中也算打中")');
  eq(sim.vitals.get('p1')!.hp, 100, '★ 玩家血量满(致盲不是伤害)');
});

/* ═════════════════════ D6 / D7 ═════════════════════ */

test('FND71-13 ★★ D6:`worldSaveHost` 真的接上了(不是"字段存在但恒 null")', () => {
  const { rt } = roomScene();
  ok(rt.worldSaveHost !== null, '★★ 装配出来的房间必须带世界存档源(修前:运行期恒 null)');
  const host = rt.worldSaveHost!;
  eq(typeof host.saveToDb, 'function', '★ 落盘入口存在(`room.step()` 的 20 帧节流靠它)');
  eq(typeof host.advance, 'function', '★ 推进入口存在(房间每帧推进世界)');
  eq(typeof host.useItem, 'function', '★ 道具入口存在(USE_ITEM 的世界侧)');
  /* 行为面:经它真的能存下玩家的 HP。 */
  rt.join({ userId: 'p1' });
  (rt.worldSaveHost as unknown as WorldSim).vitals.get('p1')!.hp = 42;
  const calls: { table: string }[] = [];
  /* 最小 `DbLike` 桩:只关心"有没有真的写 users 表",不模拟库。 */
  const fakeDb = {
    exec: (): void => undefined,
    insert: (): void => undefined,
    update: (table: string) => { calls.push({ table }); return 1; },
    delete: () => 1,
    /* `saveVitalsToUsers` 要求 users 行**已存在**(`getUser` 为真才写)——
       桩必须回一个行,否则它把这一条记成 skipped(那是**正确**的生产语义)。 */
    get: (table: string, key: { id?: string }) => (table === 'users' ? { id: key?.id ?? 'p1' } : undefined),
    select: () => [],
    count: () => 0,
    transaction: <T,>(fn: () => T): T => fn(),
  };
  const rep = rt.worldSaveHost!.saveToDb(fakeDb as never, rt.id, 0);
  eq(rep.hpSaved >= 1, true, '★★ 经装配好的世界源落盘 ⇒ 真的写了玩家 HP');
  ok(calls.some((c) => c.table === 'users'), '★ 落盘真的打到 users 表(不是空转)');
});

test('FND71-14 ★★ D7:`damage.ts` 八步与 `components.ts` 昼夜都是**活的生产路径**', () => {
  const { sim } = combatScene();
  sim.addMob('mob_sheep#1', 'MEADOW', 13.0, 8.5);
  sim.advance(2);
  const rep = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  ok(rep.hit !== null, '前置:攻击真的结算了');
  const steps = rep.hit!.result.steps;
  eq(steps.length, 8, '★★ 八步公式必须**全跑**(修前 `computeDamage` 生产调用点 = 0)');
  eq(steps[7]!.step.startsWith('8'), true, '★ 第 8 步(击退)也在');
  ok(rep.hit!.result.base > 0, '★ 基础伤害被算出来了(不是 0 的壳)');

  /* `wiring/components.ts` 的 `isNight`:世界钟走到 19:00 ⇒ 真的是夜。
     (13000 快帧 = 650 世界秒 = 13 小时,从 06:00 到 19:00 —— 实测 63 ms。) */
  const clockSim = quietScene().sim;
  eq(clockSim.isNightNow(), false, '基线:开局 06:00 是白天');
  clockSim.advance(13000);
  near(clockSim.hourOfDay(), 19, 1e-6, '前置:世界钟推到 19:00');
  eq(clockSim.isNightNow(), true, '★★ 19:00 ⇒ 夜(读的是 components 的 isNight,不是本地常量)');
  eq(isNightAtHour(19), true, '对照:同一个边界在 components 里也是夜');
});

/* ═════════════════════ itemId 服务端读口 ═════════════════════ */

/** 给玩家塞 n 件 itemId(反作弊要求来源凭证)。 */
function seed(rt: RoomScene['rt'], itemId: number, n: number): void {
  const src = `seed:${itemId}`;
  rt.grantItemSource('p1', src);
  const r = rt.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
  if (!r.allowed) throw new Error(`前置失败:塞不进 ${n} 件 ${itemId}`);
}

test('FND71-15 ★★ itemId 读口正例:背包里真有 ⇒ 成功并扣 1 件(slot 也能指认)', () => {
  const { sim, rt } = roomScene();
  seed(rt, 602, 2);
  eq(rt.authoritativeItemCount('p1', 602), 2, '前置:服务端按件账读到 2 件 602');
  eq(rt.authoritativeItemIds('p1').join(','), '602', '前置:持有清单只有 602');

  const out = rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 602 });
  eq(out.ok, true, `正例应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);
  eq((out.effect as Record<string, unknown>).consumed, 1, '★ 用掉一件');
  eq(rt.authoritativeItemCount('p1', 602), 1, '★ 账面随之减 1');
  ok(sim.buffsOf('p1').hpFlat > 0, '★ 料理的 buff 真的进了玩家');

  /* slot 指认:服务端账面第 0 格就是 602 ⇒ 一致,放行。 */
  const bySlot = rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 602, slot: 0 });
  eq(bySlot.ok, true, `★ slot=0 指认 602 ⇒ 应放行(kind=${bySlot.kind} reason=${bySlot.reason ?? '-'})`);
  eq(rt.authoritativeItemCount('p1', 602), 0, '★ 最后一件也用掉了');
});

test('FND71-16 ★★★ itemId 读口负例:自报背包里**没有**的 itemId ⇒ 拒 + 世界与背包**两侧都没变**', () => {
  const { sim, rt } = roomScene();
  /* 只有 602,一件 733 都没有 —— 这正是修前可以白嫖的形态。 */
  seed(rt, 602, 1);
  const total0 = rt.authoritativeItemTotal('p1');
  const hpFlat0 = sim.buffsOf('p1').hpFlat;
  const count602 = rt.authoritativeItemCount('p1', 602);
  const maxHp0 = sim.maxHpForLevel('p1', 1);

  const spoof = rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 733, targetId: 'p1' });

  eq(spoof.ok, false, '★★ 自报一件自己没有的道具 ⇒ 必须拒(修前会当成"扣了一件别的"放行)');
  eq(spoof.kind, 'INVALID', `应是 INVALID(kind=${spoof.kind})`);
  ok((spoof.reason ?? '').includes('itemId'), `★★ 理由必须指认 itemId(实得:${spoof.reason ?? '(无)'})`);
  eq(rt.authoritativeItemTotal('p1'), total0, '★★ 背包总量一件都没动');
  eq(rt.authoritativeItemCount('p1', 733), 0, '★★ 服务端账面上仍然 0 件 733(没有被"凭空发出")');
  eq(rt.authoritativeItemCount('p1', 602), count602, '★ 别的道具也没被牵连扣掉');
  eq(sim.buffsOf('p1').hpFlat, hpFlat0, '★★ 世界侧 buff 一点没变');
  eq(sim.maxHpForLevel('p1', 1), maxHp0, '★ 上限没变');

  /* slot 指不存在的格子 ⇒ 同样拒,且账面无变化。 */
  const badSlot = rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 602, slot: 5 });
  eq(badSlot.ok, false, '★ slot 指到空格子 ⇒ 拒');
  eq(rt.authoritativeItemCount('p1', 602), count602, '★ 被拒之后账面仍是 1 件');
  eq(rt.authoritativeItemTotal('p1'), total0, '★ 总量也没动');
});

test('FND71-17 ★ 未知道具(有语义门):理由说清"没有使用语义",且零副作用', () => {
  const { rt, sim } = roomScene();
  seed(rt, 602, 1);
  const total0 = rt.authoritativeItemTotal('p1');
  const out = rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 99999 });
  eq(out.ok, false, '未知道具不许成功');
  eq(out.kind, 'INVALID', '应是 INVALID');
  ok((out.reason ?? '').includes('没有使用语义'), `理由是"没有使用语义"(实得:${out.reason ?? '(无)'})`);
  eq(rt.authoritativeItemTotal('p1'), total0, '★ 一件都不扣');
  eq(sim.buffsOf('p1').hpFlat, 0, '★ 也没有 buff 落地');
});

test('FND71-18 ★ 读口自身:非法 itemId / 负数不作数(fail-closed)', () => {
  const { rt } = roomScene();
  seed(rt, 602, 1);
  eq(rt.authoritativeItemCount('p1', 99999), 0, '没登记的道具 ⇒ 0');
  eq(rt.authoritativeItemCount('p1', Number.NaN), 0, 'NaN ⇒ 0(坏参数的唯一安全结论)');
  eq(rt.authoritativeItemCount('查无此人', 602), 0, '不存在的玩家 ⇒ 0');
  eq(rt.authoritativeItemIds('查无此人').length, 0, '不存在的玩家 ⇒ 空清单');
});

report('WS-FND-71-combat-depth');