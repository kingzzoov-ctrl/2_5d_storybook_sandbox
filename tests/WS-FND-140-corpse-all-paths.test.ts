/**
 * WS-FND-140 —— 收尸「全路径」与刷怪计数对称(第十轮实测三处)
 *
 * 运行:`node tests/WS-FND-140-corpse-all-paths.test.ts`
 *
 * ## 这个套件钉的三件事
 *
 * ```text
 * P1 收尸只挂一条路径   deadMobs.set 全仓只有 world_sim.ts 的 damageMob 一处,而
 *                       behaviors.ts 有 3 处直接 `rt.alive = false`(汤锅河蟹 /
 *                       姜饼逃逸 / 宝箱自爆)⇒ 这些尸体永不进账、永久留在
 *                       host/AOI/physics 三表;corpseCount 也恒 0(监视器撒谎)
 * P2 spawner 计数不对称 add 触 hardCap 返回 false 不计数,remove 却无条件 -n 夹 0
 *                       ⇒ 清尸时扣的是别的群系的额度,清完计数低于真实存活数
 * P3 deadIds/reapDead 悬空 实现了却只被测试当「注入」用 ⇒ 接上生产收尸
 * ```
 *
 * ## 判据纪律(本套件怎么做到「修了就红」)
 *
 * 1 **读数取世界/宿主/刷怪器的权威口径**(`corpseCount` / `mobHost` / `aoi` /
 *    `physics.bodies` / `spawner.state` / `mobsReaped`),不读实现内部的私有字段;
 * 2 **注入验证**:FND140-3(不经过任何登记、直接把 `alive` 置 false)、
 *    FND140-8(窗口内先手工调一次宿主收尸,再走生产收尸)、FND140-7(构造修前
 *    会破坏不变量的 add/remove 序列)—— 三处都是「不注入的话,正判据与『本来
 *    就没有这种事』在读数上一样」;
 * 3 **负对照**:每条正判据都配「同一夹具、只改一个输入」的对照
 *    (窗口内不收 / 活着的永不被收 / 没记过账的群系 remove 是 no-op /
 *     不存在的 id 不被摘 / 再扣不会为负)。
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { MOB_CORPSE_FRAMES } from '../server/src/mobs/host.ts';
import { DamageKind, ITEM } from '../server/src/mobs/behaviors.ts';
import { BIOME_SPAWN, GLOBAL_MOB_CAP, MobSpawner } from '../server/src/mobs/spawner.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const SIZE = 32;
const SEED = 140;

/**
 * `mobs:false` 的世界:关掉 AOI 的自动 AI 推进与 2Hz 刷怪(那是**生产**的时序),
 * 但帧末的 `reapDeadMobs()` **照常运行**(它不在 `mobsOn` 门里)—— 正是本套件
 * 要单独观测的那一层。AI 侧置死由测试用 `mobHost.tickMobs` 显式驱动。
 */
function mobWorld(sizeCells = SIZE): WorldSim {
  return new WorldSim({ sizeCells, mobs: false, wiring: false, seed: SEED });
}

function killMob(sim: WorldSim, id: string): void {
  const r = sim.damageMob(id, 9999, DamageKind.PHYSICAL, 0);
  ok(r !== null && r.hpLoss > 0, `前置:${id} 必须被一次打死`);
}

/** 三张表 + 刷怪计数 + 待收账(全部可观测面)。 */
function tables(sim: WorldSim): { host: number; aoi: number; bodies: number; spawner: number; corpses: number } {
  return {
    host: sim.mobHost.size,
    aoi: sim.aoi.mobCount,
    bodies: sim.physics.bodies.size,
    spawner: sim.spawner.state.globalCount,
    corpses: sim.corpseCount,
  };
}

/** 刷怪器的「群系计数之和」。不变量:它必须恒等于 `globalCount`。 */
function biomeSum(sp: MobSpawner): number {
  let n = 0;
  for (const v of sp.state.biomeCounts.values()) n += v;
  return n;
}

/* ═════════════ 1. P1:AI 置死也必须被收尸(直击)═════════════════ */

test('FND140-1 ★★ AI 置死(交互路径:宝箱自爆 behaviors.ts:1182)⇒ 进待收账并被三表收尸', () => {
  const sim = mobWorld();
  const id = 'mob_mimic_cog#1';
  /* 交互需要一个玩家(主持有 `playerById`);它只是物理/AOI 的一条旁证,不参与断言计数。 */
  sim.addPlayer('p1', 6.5, 6.5);
  eq(sim.addMob(id, 'RUINS', 6.5, 6.5), 'CREATED', '前置:宝箱已登记');

  /* 修前这条死亡**完全不经过** `damageMob`:AI 的 onInteract 直接把 `alive` 置 false。 */
  eq(sim.interactMob(id, ITEM.BOMB_FRUIT, 'p1'), true, '前置:宝箱 AI 认痒痒炸弹果');
  eq(sim.mobHost.runtimeOf(id)!.alive, false, '★ 死亡来自 behaviors.ts:1182(不是 damageMob)');
  eq(sim.damageMob(id, 1, DamageKind.PHYSICAL, 0) !== null, true, '旁证:宿主仍认识这具尸体(死亡帧收尾可读)');
  eq(sim.corpseCount, 1, '★★ AI 置死的尸体进待收账(修前恒 0 —— 监视器撒谎)');
  eq(sim.mobHost.deadIds(), [id], '宿主能说出「它是尸体」');

  /* 负对照:窗口内三表仍持有(死亡那一帧的收尾还要读这条运行时)。 */
  eq(sim.aoi.getMob(id) !== undefined, true, '负对照:AOI 仍持有');
  eq(sim.physics.bodies.has(id), true, '负对照:物理仍持有');
  eq(sim.listWildlife().length, 0, '存活投影立刻不再报它');

  sim.advance(MOB_CORPSE_FRAMES + 1);
  eq(sim.mobHost.runtimeOf(id), null, '★★ 到窗口 ⇒ 宿主摘掉(修前:永久留着)');
  eq(sim.aoi.getMob(id), undefined, '★ AOI 摘掉');
  eq(sim.physics.bodies.has(id), false, '★ 物理摘掉');
  eq(sim.spawner.state.globalCount, 0, '★ 刷怪计数对称回落');
  eq(sim.mobHost.deadIds().length, 0, '没有残留尸体');
  eq(sim.mobsReaped >= 1, true, '收尸计数 +1');
  eq(sim.corpseCount, 0, '待收账空');
});

test('FND140-2 ★★ AI 置死(tick 路径:姜饼逃逸 behaviors.ts:903)⇒ 同样被收尸', () => {
  const sim = mobWorld();
  const id = 'mob_ginger_imp#1';
  eq(sim.addMob(id, 'MEADOW', 6.5, 6.5), 'CREATED', '前置:姜饼已登记');
  const rt = sim.mobHost.runtimeOf(id)!;

  /* 直驱 AI 20 个慢帧(0.5s/帧):escapeTimer 10.0 → 0,由 tick 内 `rt.alive = false` 置死。
     `tickMobs` 正是生产 AI 入口(生产里由 `aoi.activeMobs` 喂它),这里只是绕过 AOI 门。 */
  for (let i = 0; i < 20; i += 1) {
    const res = sim.mobHost.tickMobs([id], 0.5);
    ok(res.every((r) => r.error === null), `前置:姜饼 tick 不抛错(${res.map((r) => r.error).join(',')})`);
  }
  eq(rt.mem.escaped, 1, '前置:AI 走了「钻进糖果屋」分支');
  eq(rt.alive, false, '★ 死亡来自 behaviors.ts:903(tick 内直接置死)');
  eq(sim.corpseCount, 1, '★★ tick 内的 AI 置死也进待收账(修前恒 0)');

  sim.advance(MOB_CORPSE_FRAMES + 1);
  eq(sim.mobHost.runtimeOf(id), null, '★★ 到窗口 ⇒ 收掉');
  eq(sim.aoi.getMob(id), undefined, '★ AOI 摘掉');
  eq(sim.physics.bodies.has(id), false, '★ 物理摘掉');
  eq(sim.spawner.state.globalCount, 0, '★ 刷怪计数对称回落');
  eq(sim.mobHost.deadIds().length, 0, '没有残留尸体');
  eq(sim.corpseCount, 0, '待收账空');
});

/* ═════════════ 2. P1:corpseCount 监视器 + 窗口负对照 ═════════════ */

test('FND140-3 ★★ 注入:一条「不经过任何登记」的死亡也被计入 corpseCount 并按窗口收尸', () => {
  const sim = mobWorld();
  sim.addMob('mob_boar#1', 'MEADOW', 5.5, 5.5);
  sim.addMob('mob_boar#2', 'MEADOW', 6.5, 6.5);
  killMob(sim, 'mob_boar#1');                 /* 登记路径:damageMob(死亡帧 = 0) */
  eq(sim.corpseCount, 1, '前置:damageMob 击杀进账');

  /* 注入:直接把 #2 置死,模拟「AI 自己置死 / 任何未登记路径」—— 修前的形态。 */
  sim.mobHost.runtimeOf('mob_boar#2')!.alive = false;
  eq(sim.corpseCount, 2, '★★ 未登记的死亡也被计入(修前恒 1:只读 deadMobs)');
  eq(sim.mobHost.deadIds().length, 2, '宿主能说出两只都是尸体');

  /* 负对照(窗口):第 1 帧一具都不收。 */
  sim.advance(1);
  eq(sim.corpseCount, 2, `负对照:${MOB_CORPSE_FRAMES} 帧窗口未满 ⇒ 都不收`);
  eq(sim.mobsReaped, 0, '负对照:一次都没收');

  /* 登记的那具(死亡帧 0)先到点;注入的那具(第 1 帧才被扫描登记)还差一帧。 */
  sim.advance(1);
  eq(sim.mobsReaped, 1, '★ 先到点的那具被收');
  eq(sim.corpseCount, 1, '★ 另一具仍在待收账(不是一起被扫掉)');

  sim.advance(1);
  eq(sim.mobsReaped, 2, '★★ 注入的死亡最终也被收掉');
  eq(tables(sim).host, 0, '宿主空');
  eq(tables(sim).aoi, 0, 'AOI 空');
  eq(tables(sim).bodies, 0, '物理空');
  eq(sim.corpseCount, 0, '待收账空');
});

test('FND140-4 ★ 负对照:活着的永不被收,尸体窗口内也不收', () => {
  const sim = mobWorld();
  sim.addMob('mob_sheep#1', 'MEADOW', 5.5, 5.5);   /* 活 */
  sim.addMob('mob_sheep#2', 'MEADOW', 6.5, 6.5);   /* 待杀 */
  killMob(sim, 'mob_sheep#2');
  eq(sim.corpseCount, 1, '前置:一具尸体');

  sim.advance(1);
  eq(sim.mobsReaped, 0, '负对照:窗口内不收');
  eq(sim.mobHost.runtimeOf('mob_sheep#2') !== null, true, '负对照:尸体仍在宿主');

  sim.advance(MOB_CORPSE_FRAMES + 1);
  eq(sim.mobHost.runtimeOf('mob_sheep#2'), null, '尸体已摘');
  eq(sim.mobHost.runtimeOf('mob_sheep#1') !== null, true, '★★ 活着的那只**没有**被收(不是「清空宿主」)');
  eq(sim.aoi.getMob('mob_sheep#1') !== undefined, true, '活着的仍在 AOI');
  eq(sim.physics.bodies.has('mob_sheep#1'), true, '活着的仍有刚体');
  eq(sim.mobsReaped, 1, '只收了尸体那 1 具');
});

/* ═════════════ 3. P2:刷怪计数对称记账 ═════════════ */

test('FND140-5 ★★ P2 跨群系:超额登记 100 只后清尸,不扣别的群系的额度', () => {
  const sp = new MobSpawner();
  const meadowHard = BIOME_SPAWN.MEADOW.hardCap;

  /* 100 只 MEADOW:只有前 hardCap 只被计数,其余 add 返回 false 且不计数(修前的缺口)。 */
  let counted = 0;
  for (let i = 0; i < 100; i += 1) if (sp.add('MEADOW', 1)) counted += 1;
  eq(counted, meadowHard, `前置:MEADOW 只记到 hardCap(${meadowHard})`);
  eq(sp.state.biomeCounts.get('MEADOW'), meadowHard, '前置:MEADOW 计数 = hardCap');

  /* 另一个群系有 10 只**真实存活**。 */
  for (let i = 0; i < 10; i += 1) eq(sp.add('RUINS', 1), true, '前置:RUINS 记 10 只');
  eq(sp.state.globalCount, meadowHard + 10, '前置:全局 = 24');

  /* 清掉 100 具 MEADOW 尸体(其中 86 具从没被计数)。 */
  for (let i = 0; i < 100; i += 1) sp.remove('MEADOW', 1);
  eq(sp.state.biomeCounts.get('MEADOW') ?? 0, 0, 'MEADOW 计数归零');
  eq(sp.state.biomeCounts.get('RUINS'), 10, '★ RUINS 记录没被动');
  eq(sp.state.globalCount, 10, '★★ 全局计数 = 真实存活(RUINS 10);修前被多扣 86 ⇒ 0');
  eq(sp.state.globalCount, biomeSum(sp), '★★ 不变量:globalCount === Σ biomeCounts');
});

test('FND140-6 ★ P2 负对照:没记过账的群系 remove 是 no-op;扣减不为负', () => {
  const sp = new MobSpawner();
  sp.add('MEADOW', 5);
  const g0 = sp.state.globalCount;
  eq(g0, 5, '前置:MEADOW 记 5 只');

  sp.remove('CAVERN', 3);   /* CAVERN 从没记过账 */
  eq(sp.state.globalCount, g0, '★★ 没记过账的群系 remove 不从全局偷额度(修前:5 → 2)');
  eq(sp.state.biomeCounts.get('CAVERN') ?? 0, 0, '负对照:CAVERN 仍为 0');

  sp.remove('MEADOW', 999); /* 只扣自己记过的 5 */
  eq(sp.state.globalCount, 0, '★ 只扣本群系记过的数');
  eq(sp.state.biomeCounts.get('MEADOW') ?? 0, 0, 'MEADOW 归零');

  sp.remove('MEADOW', 1);   /* 再扣 */
  eq(sp.state.globalCount, 0, '负对照:再扣不会为负');
  eq(sp.state.globalCount, biomeSum(sp), '不变量保持');
});

test('FND140-7 ★★ P2 不变量:任意 add/remove 序列后 globalCount 恒等于 Σ biomeCounts', () => {
  const sp = new MobSpawner();
  /* 一段「修前必破坏不变量」的序列:先超额 add(不计数),再 remove(无条件扣)。 */
  const ops: (() => void)[] = [
    () => { sp.add('MEADOW', BIOME_SPAWN.MEADOW.hardCap); },
    () => { sp.add('MEADOW', 40); },                 /* 触 hardCap ⇒ false、不计数 */
    () => { sp.add('RUINS', 5); },
    () => { sp.add('CAVERN', 3); },
    () => { sp.remove('MEADOW', 50); },              /* 多于被计数 ⇒ 多出的必须 no-op */
    () => { sp.add('OASIS', 2); },
    () => { sp.remove('CAVERN', 100); },
    () => { sp.remove('MEADOW', 1); },
    () => { sp.add('RUINS', 99); },                  /* 触 hardCap ⇒ false */
    () => { sp.remove('RUINS', 5); },
  ];
  for (let i = 0; i < ops.length; i += 1) {
    ops[i]();
    eq(sp.state.globalCount, biomeSum(sp), `★ 第 ${i + 1} 步之后 globalCount === Σ biomeCounts`);
    ok(sp.state.globalCount <= GLOBAL_MOB_CAP, `第 ${i + 1} 步全局不越上限`);
  }
});

/* ═════════════ 4. P3:reapDead 接上生产收尸 ═════════════ */

test('FND140-8 ★★ P3 宿主收尸口接上生产:过滤式只摘到点的,生产收尸仍补齐另三张表', () => {
  const sim = mobWorld();
  const ids = ['mob_boar#1', 'mob_boar#2', 'mob_boar#3'];
  ids.forEach((id, i) => sim.addMob(id, 'MEADOW', 5.5 + i, 5.5));
  for (const id of ids) killMob(sim, id);
  eq(tables(sim), { host: 3, aoi: 3, bodies: 3, spawner: 3, corpses: 3 }, '前置:三具尸体都在三表');

  /* 窗口内显式调用宿主收尸口 —— 这是修前唯一「看起来合理」的修法。 */
  eq(sim.mobHost.reapDead(['mob_boar#1']), ['mob_boar#1'], '★★ 过滤式收尸只摘指定那条(生产用的就是这个签名)');
  eq(sim.mobHost.size, 2, '宿主摘掉了 1 具');
  eq(sim.mobHost.reapDead(['mob_boar#9']), [], '负对照:不存在的 id 不被摘');
  eq(sim.mobHost.reapDead(['mob_boar#2', 'mob_boar#2']).length, 1, '★ 重复 id 去重');

  /* 生产收尸点补齐另三张表(即便宿主侧已被提前摘走)。 */
  sim.advance(MOB_CORPSE_FRAMES + 1);
  eq(sim.aoi.mobCount, 0, '★★ 生产收尸把 AOI 一并清(只摘宿主一处不够)');
  eq(sim.physics.bodies.size, 0, '★★ 物理一并清');
  eq(sim.spawner.state.globalCount, 0, '★★ 刷怪计数对称回落');
  eq(sim.mobHost.deadIds().length, 0, '宿主无残留尸体');
  eq(sim.mobsReaped, 3, '★★ 三具都记入收尸数(不是「表空了但没人知道为什么」)');
});

report('WS-FND-140');