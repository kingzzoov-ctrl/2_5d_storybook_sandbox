/**
 * WS-FND-102 · 四条审计实测缺陷(全部做到「修了就红、修前必红」的可判定形态)
 *
 * ```
 * P1 击杀掉落从不落地   `world_sim.ts` 的 `settleKill` 把 `rollMobDrops` 只赋给诊断字段
 *                       `lastMobDrops`(全仓无生产读者)⇒ 击杀路径从不调 `dropItem`
 *                       ⇒ 打死怪的地面**永远是空的**
 * P2 `mobOrdinals` 重号  `applyRestore` 按归档 id 重建,而 `rebuildWorld` 已把计数器清 0
 *                       ⇒ 后续发号从 `#1` 起重来,撞上已恢复实例;`addMob` 同 id
 *                       **静默整只替换**(满血 / 丢 FSM),`killLedger` 按 id 去重 ⇒
 *                       击杀被吞(经验不到账、不报错)
 * P2 `removePlayer` 漏清瞬态  未清 `foodBuffs` / `liveBubbles` / `sprayUntil` / `knockbacks`,
 *                       且用 `bodies.delete` 摘物理刚体(五张旁表留着)⇒ 同名重连继承
 *                       上轮料理 buff(且 `hpFlat` 并进上限)/ 泡泡 / 击退
 * P2 `killLedger` 无界  只 add 无淘汰 ⇒ 常驻房间进程生命期内无界增长
 * ```
 *
 * ## 判据(8 条;每条都带负对照或注入)
 *
 * ```
 * 1 击杀掉落真的落地:地面 = 内容表写的那两件(701×2 / 702×2),坐标 = 击杀点
 * 2 掉落走 `dropItem`/`mobGround` 口径(生产拾取路径拿得到);负对照:尸体再打不掉
 * 3 负对照:同一实例二次结算(`addMob` 同 id 覆盖后)不得给第二份掉落
 * 4 注入 + 负对照:恢复后序号水位推进到已恢复的最大序号;没恢复过的物种仍为 0;
 *   `mob_boar`(无号)/ `mob_boar#0` / `mob_boar#x` 三种脏 id 都**不动水位**
 * 5 端到端:恢复全部可刷物种的 `#1` 之后,真刷出来的新怪不许撞号(修前 = 整只替换)
 * 6 `removePlayer` 清料理 buff(上限回落到基准)+ 泡泡 + 击退;重连不继承
 * 7 `removePlayer` 走 `PhysicsWorld.remove`:五张旁表一起回收(`speedCapOf` 回到 null)
 * 8 击杀账有界:FIFO 淘汰最老、窗口内仍去重、`reset()` 清顺序表
 * ```
 *
 * ## 期望值从哪来(不抄被测模块)
 *
 * - `701×2 / 702×2` 是**内容表字面量**(`shared/constants/mobs.ts` 的 `mob_boar`
 *   `drops: { 701: 2, 702: 2 }`,两项都**没有** `dropChance` ⇒ 恒必掉);
 * - 602 的 `hpFlat = 30` 是**手册/配表字面量**(`combat/cooking.ts`);
 * - 恢复用的归档 id(`mob_boar#7` / `mob_sheep#3`)是夹具里手写的常量;
 * - `KILL_LEDGER_CAPACITY` 由**一条锚**钉住(`eq(CONST, 4096)`),其余期望/边界
 *   槽位一律写**字面量 4096** —— 期望侧若也取被测模块的导出常量,断言就退化成
 *   「常量 == 常量」(同义反复候选:改常量时两侧一起变,永远相等)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import { KillLedger, KILL_LEDGER_CAPACITY } from '../server/src/combat/progression.ts';
import { LIVE_BUBBLE_INITIAL } from '../server/src/combat/live_bubble.ts';
import { Chunk } from '../server/src/world/chunk.ts';
import {
  decodeWorldArchive,
  encodeWorldArchive,
  planRestore,
  type RestorePlan,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 夹具(手写常量)═══════════════════════ */

const SIZE = 32;
const SEED = 4242;
const KILL_X = 10.5;
const KILL_Y = 12.5;

/** `mob_boar` 的两条掉落(内容表 `drops: { 701: 2, 702: 2 }`;无 `dropChance` ⇒ 必掉)。 */
const BOAR_ITEM_A = 701;
const BOAR_ITEM_A_COUNT = 2;
const BOAR_ITEM_B = 702;
const BOAR_ITEM_B_COUNT = 2;

/** 602 庆典蛋糕:最大生命 +30(`foodBuffFrom` 的 `hpFlat`)。 */
const FOOD_MAX_HP_UP = 602;
const FOOD_MAX_HP_FLAT = 30;
/** 227 泡泡连发水枪(对活人 ⇒ 走 `live_bubble` 状态机,一发起步)。 */
const BUBBLE_GUN = 227;

/** 一块真实地形块体(生产同一个 `serializeSnapshot`)。 */
function chunkBlob(cx: number, cy: number): Uint8Array {
  return new Chunk(cx, cy).serializeSnapshot();
}

/** 造一份**合法**回滚计划:世界身份 + 若干生物 + 一块地形。 */
function restorePlan(
  size: number,
  mobs: { id: string; hp: number; maxHp: number }[],
): RestorePlan {
  const bytes = encodeWorldArchive({
    world: {
      roomId: 'r_fnd102', seed: 777, sizeCells: size,
      biome: 'MEADOW', frame: 0, hourOfDay: 6,
    },
    players: [],
    fluid: { width: size, height: size, levels: [] },
    mobs: mobs.map((m) => ({
      id: m.id, mobId: m.id.split('#')[0]!, x: 8.5, y: 8.5, z: 0, hp: m.hp, maxHp: m.maxHp,
    })),
    ground: [],
    chunks: [{ cx: 0, cy: 0, bytes: chunkBlob(0, 0) }],
  });
  return planRestore(decodeWorldArchive(bytes), null);
}

/** 只有一只野猪的击杀世界(`mobs: false` ⇒ 没有随机刷怪干扰地面账)。 */
function killWorld(): WorldSim {
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: SEED });
  sim.addMob('mob_boar#1', 'MEADOW', KILL_X, KILL_Y);
  return sim;
}

/** 一次**致死**伤害(返回回执;调用方断言前提)。 */
function killBoar(sim: WorldSim) {
  return sim.damageMob('mob_boar#1', 9999, DamageKind.PHYSICAL, 0);
}

/** 击杀点附近的地面快照(`itemId → count`),便于逐位比对。 */
function groundAtKill(sim: WorldSim): Record<number, number> {
  const out: Record<number, number> = {};
  for (const g of sim.groundItemsNear(KILL_X, KILL_Y, 0.01)) {
    out[g.itemId] = (out[g.itemId] ?? 0) + g.count;
  }
  return out;
}

/* ═══════════ 1. P1:击杀掉落真的落地 ═══════════ */

test('FND102-1 ★P1 击杀掉落落地:地面 = 内容表那两件,坐标 = 击杀点', () => {
  /* 怎么变红:
       · `settleKill` 把掉落只赋给 `lastMobDrops`(修前形态)⇒ 第 1/2 条(地面 0 件);
       · 掉在玩家位置而不是怪的倒下位置 ⇒ 第 3 条(坐标);
       · 把件数写成 1 ⇒ 第 2 条。 */
  const sim = killWorld();
  const r = killBoar(sim);
  ok(r !== null && r.hpLoss > 0, '前提:这一次伤害必须真的打死(否则测的是别的东西)');

  eq(
    groundAtKill(sim),
    { [BOAR_ITEM_A]: BOAR_ITEM_A_COUNT, [BOAR_ITEM_B]: BOAR_ITEM_B_COUNT },
    '★ 地面必须真的有两件货(修前:空)',
  );
  const near = sim.groundItemsNear(KILL_X, KILL_Y, 0.01);
  eq(near.length, 2, '两件掉落物(各自一条,不是合并成一条)');
  for (const g of near) {
    eq({ x: g.x, y: g.y }, { x: KILL_X, y: KILL_Y }, '★ 落在**击杀点**(怪倒下的地方)');
  }

  /* 诊断镜像**保留**(不是被地面取代掉的):顺序 = `mobDropTableOf` 的 itemId 升序。 */
  eq(
    sim.lastMobDrops.map((d) => d.itemId),
    [BOAR_ITEM_A, BOAR_ITEM_B],
    '`lastMobDrops` 仍是诊断镜像(itemId 升序)',
  );
  eq(sim.lastMobDrops.map((d) => d.count), [BOAR_ITEM_A_COUNT, BOAR_ITEM_B_COUNT], '镜像件数一致');
});

test('FND102-2 ★掉落走 `dropItem`/`mobGround` 口径(可拾取);尸体再打不再掉', () => {
  /* 只写诊断字段的实现会让第 1 条就红;这里再钉"两个字段都写"
     (`id` 与 `itemId`)—— 只写一个的表现是 `takeGroundItemNear` 对**确实存在**的货
     返回 false(`consumeGroundItem` 走 `groundItemId`)。 */
  const sim = killWorld();
  killBoar(sim);

  ok(sim.takeGroundItemNear(KILL_X, KILL_Y, BOAR_ITEM_A, 1), '★ 生产拾取路径必须拿得到 701');
  eq(groundAtKill(sim)[BOAR_ITEM_A], BOAR_ITEM_A_COUNT - 1, '拿走一件(剩下 1)');
  ok(sim.takeGroundItemNear(KILL_X, KILL_Y, BOAR_ITEM_A, 1), '再拿一件');
  eq(groundAtKill(sim)[BOAR_ITEM_A], undefined, '701 已拿空');
  eq(groundAtKill(sim)[BOAR_ITEM_B], BOAR_ITEM_B_COUNT, '702 不受影响');

  /* 负对照:尸体再挨一次打 ⇒ 两道防线(`wasAlive` 与账本)都不许再结算、不许再掉。 */
  const settleBefore = sim.killSettleCount;
  const groundBefore = groundAtKill(sim);
  killBoar(sim);
  eq(sim.killSettleCount, settleBefore, '★ 尸体不结算(击杀结算次数不变)');
  eq(groundAtKill(sim), groundBefore, '★ 尸体不再掉落');
});

test('FND102-3 ★负对照:同一实例二次结算不得给第二份掉落(`deduped`)', () => {
  /* 修前的"掉落只进诊断字段"在这里**看不出来**(字段本身是对的),所以这条不是重复:
     它钉的是「掉落与经验/积分同生共死」—— `deduped` 时掉落必须是 0 件。
     注入面:`addMob` 同 id 覆盖一只**活**实例 ⇒ 第二次击杀会走到账本的第二道防线。 */
  const sim = killWorld();
  killBoar(sim);
  const first = groundAtKill(sim);
  ok(first[BOAR_ITEM_A] === BOAR_ITEM_A_COUNT, '前提:第一次击杀真的掉了');

  sim.addMob('mob_boar#1', 'MEADOW', KILL_X, KILL_Y); /* 同 id 覆盖 ⇒ 新的活实例 */
  const r = killBoar(sim);
  ok(r !== null && r.hpLoss > 0, '前提:第二次伤害也确实打死了"新的那只"');
  eq(sim.lastKillSettle?.deduped, true, '★ 账本必须拒绝二次结算');
  eq(sim.lastMobDrops.length, 0, 'deduped ⇒ 掉落清单为空');
  eq(groundAtKill(sim), first, '★ 地面不得多出第二份');
});

/* ═══════════ 2. P2:恢复后序号水位 ═══════════ */

test('FND102-4 ★P2 恢复后序号水位推进到已恢复的最大序号(含脏 id 注入)', () => {
  /* 怎么变红:
       · 不推进水位(修前形态)⇒ 第 2/3 条读到 0;
       · 推进成"恢复个数"或"#1"而不是**最大号** ⇒ 第 2 条(7);
       · 不管什么串都去切尾段 ⇒ 第 5 条(`mob_boar#x` 会把水位推到别的地方 / `#0` 推成 0)。 */
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: 11 });
  /* 负对照:全新世界还没有发过号。 */
  eq(sim.mobOrdinalWatermark('mob_boar'), 0, '负对照:全新世界水位 = 0');

  const plan = restorePlan(SIZE, [
    { id: 'mob_boar#7', hp: 5, maxHp: 9 },
    { id: 'mob_sheep#3', hp: 1, maxHp: 3 },
  ]);
  const r = sim.applyRestore(plan);
  ok(r.ok, `合法计划必须应用成功(${r.reason ?? ''})`);
  eq(r.applied?.mobs, 2, '两只生物都放回来了');

  eq(sim.mobOrdinalWatermark('mob_boar'), 7, '★ 水位 = 已恢复的最大序号(7)');
  eq(sim.mobOrdinalWatermark('mob_sheep'), 3, '★ 各物种各自推进(3)');
  eq(sim.mobOrdinalWatermark('mob_slime_green'), 0, '负对照:没恢复过的物种仍是 0');

  /* ── 注入:三种脏 id 都不许动水位 ── */
  const dirty = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: 11 });
  const dirtyPlan = restorePlan(SIZE, [
    { id: 'mob_boar', hp: 5, maxHp: 9 },      /* 老写法:没有序号 */
    { id: 'mob_boar#0', hp: 5, maxHp: 9 },    /* 序号 0(生成器钳成 1 ⇒ 回环对不上) */
    { id: 'mob_boar#x', hp: 5, maxHp: 9 },    /* 尾段不是数字 */
  ]);
  const rd = dirty.applyRestore(dirtyPlan);
  ok(rd.ok, `脏 id 的归档也必须能应用(它们只是不推进水位,${rd.reason ?? ''})`);
  eq(
    dirty.mobOrdinalWatermark('mob_boar'), 0,
    '★ 脏 id 一律不动水位(推错水位同样撞号,而且更隐蔽)',
  );
});

test('FND102-5 ★P2 端到端:恢复 `#1` 之后真刷出来的怪不许撞号', () => {
  /* 场景取自审计实测:**恢复的世界里有 `物种#1`,计数器却是 0**。
     下面恢复 MEADOW 全部可刷物种的 `#1`(羊 / 果冻怪 / 野猪),于是**无论**刷哪一只,
     修前都会撞号:`addMob` 同 id 覆盖 ⇒ 世界里的生物总数**不增长**(整只替换)。
     修后新号从 `#2` 起 ⇒ 总数增长、id 唯一、已恢复实例原样还在(血量仍是我们写的 1/3)。 */
  const sim = new WorldSim({ sizeCells: 64, mobs: true, wiring: false, seed: 7 });
  const restored = [
    { id: 'mob_sheep#1', hp: 1, maxHp: 3 },
    { id: 'mob_slime_green#1', hp: 1, maxHp: 3 },
    { id: 'mob_boar#1', hp: 1, maxHp: 3 },
  ];
  const r = sim.applyRestore(restorePlan(64, restored));
  ok(r.ok, `恢复必须成功(${r.reason ?? ''})`);
  eq(sim.listWildlife().length, 3, '前提:恢复出 3 只');
  eq(sim.mobOrdinalWatermark('mob_boar'), 1, '前提:水位已推进到 1');

  /* 刷怪在慢帧(1/10)走 `tickSpawn`;刷出来的物种是随机的 ⇒ 循环到"刷怪器记过一次"为止。
     ⚠️ "真的刷了一次"看**刷怪器计数**(`spawner.add` 每次 `addMob` 都 +1,**包括同号替换**),
     而"世界里的生物变多了"是下面那条 ★ 断言 —— 两个信号**必须分开**:
     合成一个的话,修前的表现(刷了但整只替换)会被误报成"根本没刷",
     判据的失败点就跑到链上最没信息量的那一环去了。 */
  const countBefore = sim.spawner.state.globalCount;
  eq(countBefore, 3, '前提:恢复的 3 只都进了刷怪计数');
  let spawnedAt = -1;
  for (let i = 1; i <= 2000; i += 1) {
    sim.advance(1);
    if (sim.spawner.state.globalCount > countBefore) { spawnedAt = i; break; }
  }
  ok(spawnedAt > 0, '2000 帧内刷怪器必须真的出手至少一次(否则这条判据不可判定)');

  const after = sim.listWildlife();
  ok(after.length > 3, `★ 生物总数必须增长(修前:同号替换 ⇒ 恒为 3,实测 ${after.length})`);
  const ids = after.map((w) => w.id);
  eq(new Set(ids).size, ids.length, 'id 必须互不相同(没有同号替换)');

  for (const w of restored) {
    const now = after.find((a) => a.id === w.id);
    ok(now !== undefined, `★ 已恢复的 ${w.id} 不许消失`);
    eq(
      { hp: now!.hp, maxHp: now!.maxHp },
      { hp: w.hp, maxHp: w.maxHp },
      `★ ${w.id} 必须是归档里那一只(修前被同号新怪整只替换:满血)`,
    );
  }

  /* 水位只进不退:所有在场实例的序号都 ≤ 水位。 */
  for (const w of after) {
    const species = w.id.slice(0, w.id.lastIndexOf('#'));
    const ordinal = Number(w.id.slice(w.id.lastIndexOf('#') + 1));
    ok(
      ordinal <= sim.mobOrdinalWatermark(species),
      `${w.id} 的序号 ${ordinal} 必须 ≤ 水位 ${sim.mobOrdinalWatermark(species)}(永不复用)`,
    );
  }
});

/* ═══════════ 3. P2:removePlayer 清瞬态 ═══════════ */

test('FND102-6 ★P2 `removePlayer` 清瞬态:料理 buff / 泡泡 / 击退不跨会话', () => {
  /* 修前只清 7 张表,漏了这四张按 id 索引的瞬态 ⇒ 同名重连继承上一轮。 */
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: 5 });
  sim.addPlayer('p1', 2.5, 2.5);
  /* `?? -1`:判据要给一个**可比较的数**;`maxHpForLevel` 的 `null` 表示"没这个玩家",
     用 -1 把这条语义与"上限 0"分开(TS 也不会误以为 `base` 可能是 null)。 */
  const base = sim.maxHpForLevel('p1', 1) ?? -1;
  ok(base > 0, '前提:1 级玩家的上限可算');

  /* 负对照(前):上 buff 之前上限就是基准。 */
  eq(sim.buffsOf('p1').hpFlat, 0, '前提:还没吃料理');

  const eat = sim.useItem('p1', { itemId: FOOD_MAX_HP_UP });
  eq(eat.applied, true, '前提:602 必须被吃喝路径接受');
  eq(sim.buffsOf('p1').hpFlat, FOOD_MAX_HP_FLAT, '前提:料理 hpFlat 已挂上');
  eq(sim.maxHpForLevel('p1', 1), base + FOOD_MAX_HP_FLAT, '前提:hpFlat 真的进了上限');

  const bubble = sim.useItem('p1', { itemId: BUBBLE_GUN, targetId: 'p1' });
  eq(bubble.applied, true, '前提:227 对活人必须生效');
  eq(sim.liveBubbleOf('p1').stacks, 1, '前提:泡泡叠了 1 层');
  ok(sim.applyKnockback('p1', 100.5, 100.5, 1), '前提:击退窗口建立');
  eq(sim.knockbackOf('p1'), true, '前提:击退窗口在');

  eq(sim.removePlayer('p1'), true, '移除非空玩家');

  eq(sim.buffsOf('p1').hpFlat, 0, '★ 料理 buff 必须清(修前残留 ⇒ 重连上限凭空 +30)');
  eq(sim.liveBubbleOf('p1'), LIVE_BUBBLE_INITIAL, '★ 泡泡状态必须清(回到初值)');
  eq(sim.knockbackOf('p1'), false, '★ 击退窗口必须清');

  /* 负对照(后):同名重连 ⇒ 上限回到基准,不带上轮的 hpFlat。 */
  sim.addPlayer('p1', 2.5, 2.5);
  eq(sim.maxHpForLevel('p1', 1), base, '★ 重连后上限必须回到基准(修前 = 基准 + 30)');
});

test('FND102-7 ★P2 `removePlayer` 走 `PhysicsWorld.remove`:旁表一起回收', () => {
  /* 修前是 `physics.bodies.delete(id)`:主表摘掉、五张旁表(trapTimers / muMuls /
     speedCaps / gravityMuls / jumpMuls)**留着那条 id**。这里用唯一有公开读口的
     `speedCapOf` 做判据(其余四张同属 `reclaimSideTables`,一条路径)。 */
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: 5 });
  sim.addPlayer('p1', 2.5, 2.5);
  eq(sim.physics.setSpeedCap('p1', 3), true, '前提:速度上限写进旁表');
  eq(sim.physics.speedCapOf('p1'), 3, '前提:旁表里确实有 3');

  eq(sim.removePlayer('p1'), true, '移除玩家');
  eq(sim.physics.bodies.has('p1'), false, '主表摘掉');
  eq(sim.physics.speedCapOf('p1'), null, '★ 旁表也必须回收(修前仍是 3)');
  eq(sim.physics.remove('p1'), false, '负对照:重复移除返回 false(不是"没删干净")');
});

/* ═══════════ 4. P2:击杀账有界 ═══════════ */

test('FND102-8 ★P2 击杀账有界:FIFO 淘汰最老,窗口内仍去重,reset 清顺序表', () => {
  /* 修前 `claim` 只 add ⇒ 第 2 条(容量封顶)必红。

     ⚠️ **期望侧一律写字面量 4096**,不写 `KILL_LEDGER_CAPACITY`:
     期望侧也取被测模块的导出常量 ⇒ 断言退化成「常量 == 常量」,
     改常量时两侧一起变、永远相等(同义反复候选,门禁会报)。
     整个套件**只留一条**读常量的断言 —— 下面这条「锚」,它的作用正是
     把契约常量钉在 4096,于是其余字面量断言才有意义(常量被改成 0 / 4097 时锚先红)。
     (原第 1 条 `ok(Number.isInteger(CAP) && CAP > 0)` 已删:量纲由锚这一条覆盖,
      留着它就是第二处「用被测模块的常量当判据」。) */
  eq(KILL_LEDGER_CAPACITY, 4096, '锚:账本容量 = 4096(字面量锚;判据不读被测模块)');

  const led = new KillLedger();
  /* 负对照(前):同一 id 第二次必须被拒 —— 有界淘汰不许顺手把去重也放宽。 */
  ok(led.claim('mob_boar#1'), '首条入账');
  eq(led.claim('mob_boar#1'), false, '负对照:窗口内同一 id 第二次必须被拒');

  for (let i = 2; i <= 4096; i += 1) led.claim(`mob_boar#${i}`);
  eq(led.size(), 4096, '打满:恰好等于容量 4096');
  ok(led.has('mob_boar#1'), '打满之前一条都不许丢');

  ok(led.claim('mob_boar#overflow'), '容量打满后新账仍能入(不是"满了就拒")');
  eq(
    led.size(), 4096,
    '★ 有界:入账后仍 = 4096(修前 = 4097,且没有上界)',
  );
  eq(led.has('mob_boar#1'), false, '★ 淘汰的是**最老**的那条(FIFO)');
  eq(led.has('mob_boar#2'), true, '★ 只淘汰一条:次老的还在');
  eq(led.has('mob_boar#overflow'), true, '新账在账上');

  /* 不变量「已死实例不会被复用」由**序号单调**保证(见 FND102-4/5):
     淘汰只丢"旧账",不会让一只新怪拿到被淘汰的那个 id ⇒ 不存在"新怪继承旧账"。
     这里用世界侧同一份计数器做一次可判定检查。 */
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: 3 });
  sim.addMob('mob_boar#1', 'MEADOW', 3.5, 3.5);
  const wmBefore = sim.mobOrdinalWatermark('mob_boar');
  sim.applyRestore(restorePlan(SIZE, [{ id: 'mob_boar#9', hp: 2, maxHp: 4 }]));
  ok(
    sim.mobOrdinalWatermark('mob_boar') >= 9 && sim.mobOrdinalWatermark('mob_boar') >= wmBefore,
    '★ 水位只进不退(淘汰旧账不会把"已用过的号"放回去)',
  );

  led.reset();
  eq(led.size(), 0, 'reset 清空判据表');
  ok(led.claim('mob_boar#1'), 'reset 之后同一条 id 可以重新入账(换代语义)');
});

report('WS-FND-102');