/**
 * WS-FND-135 —— 热路径与尸体回收(第九轮实测五处)
 *
 * 运行:`node tests/WS-FND-135-hotpath-and-reap.test.ts`
 *
 * ## 这个套件钉的五件事
 *
 * ```
 * P1 尸体永不回收  击杀只置 after.alive=false,而 mobHost.removeMob / spawner.remove
 *                  全仓零调用 ⇒ 尸体永久留在宿主/AOI/物理三张表里
 *                  (`listWildlife` 每帧仍复制排序它、`resolvePairs` 仍与它配对)
 * P1 ac.move 推进窗口但世界拒收被丢弃
 *                  `room.ts#applyMove` 先无条件把反作弊窗口推到申报坐标,随后
 *                  `host.applyPlayerMove` 的返回值**被丢弃** ⇒ 世界在倒地/眩晕/困住/
 *                  击退窗口拒收坐标时,下一包按**幻影坐标**判跳变 ⇒ 合法玩家被误判
 *                  TELEPORT/SPEED,且 `applyMove` 返回 `allowed:true` **谎报成功**
 * P2 bus.drain 在慢帧块之前
 *                  慢帧系统 emit 的事件要等下一快帧才投递;房间离开 OPEN 后
 *                  `advance` 不再跑 ⇒ 终场播报**永不投递**
 * P2 MAX_ACTIONS_PER_TICK 只有声明无实现
 *                  一帧内多连接 dispatch 无预算兜底
 * P3 攻击冷却水位在结算之前提交
 *                  无世界 / 无 mobId / 世界侧拒绝(超射程、NO_SKILL)都白占 8 帧冷却
 * ```
 *
 * ## 判据纪律(本套件怎么做到「修了就红」)
 *
 * 1 **读数一律取世界/房间的**权威口径**(`mobHost.size` / `aoi.mobCount` /
 *    `physics.bodies` / `spawner.state` / `listWildlife()` / `ac.get().lastX`),
 *    不读实现内部的新字段来证明实现;
 * 2 **注入验证**:FND135-3(绕过编排层只摘宿主一处 ⇒ 另两张表仍持有)、
 *    FND135-5(在慢帧里 emit 的注入源)、FND135-7(手工制造「修前形态」的幻影水位)——
 *    三处都是「不注入的话,正判据与『这一帧本来就没事件/没移动』在读数上一样」;
 * 3 **负对照**:每条正判据都配一条「同一夹具、只改一个输入」的对照
 *    (窗口内不收尸 / 没人站哨台 / 帧外 emit / 没有世界 / 世界不认识这个玩家 /
 *     同 id 覆盖重建 / 无效攻击后再打同一 tick …)。
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';
import { MOB_CORPSE_FRAMES } from '../server/src/mobs/host.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import { MAX_ACTIONS_PER_TICK, RoomAction, RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { ViolationKind, fixedClock } from '../server/src/net/anticheat.ts';
import { makeComponent } from '../server/src/wiring/components.ts';
import { clearPartyRegistry, setPartyClock } from '../server/src/net/actions/start_party.ts';
import { AccessMode, RoomStatus } from '../server/src/db/repo.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const SIZE = 32;
const SEED = 135;

let seq = 0;
function freshId(tag: string): string {
  seq += 1;
  return `fnd135_${tag}_${seq}`;
}

function mobWorld(opts: { sizeCells?: number; combatRng?: boolean } = {}): WorldSim {
  return new WorldSim({
    sizeCells: opts.sizeCells ?? SIZE,
    mobs: false,
    wiring: false,
    seed: SEED,
    ...(opts.combatRng === true ? { combatRng: () => 0.5 } : {}),
  });
}

/** 三张表 + 刷怪计数 + 待收尸体的读数(`killLedger` 之外的全部可观测面)。 */
function tables(sim: WorldSim): {
  host: number; aoi: number; bodies: number; spawner: number; corpses: number;
} {
  return {
    host: sim.mobHost.size,
    aoi: sim.aoi.mobCount,
    bodies: sim.physics.bodies.size,
    spawner: sim.spawner.state.globalCount,
    corpses: sim.corpseCount,
  };
}

function killMob(sim: WorldSim, id: string): void {
  const r = sim.damageMob(id, 9999, DamageKind.PHYSICAL, 0);
  ok(r !== null && r.hpLoss > 0, `前置:${id} 必须被一次打死`);
}

interface RoomFixture {
  rt: RoomRuntime;
  sim: WorldSim;
  clock: ReturnType<typeof fixedClock>;
}

/** 一房一世界(房间把 `WorldSim` 当世界源,与生产装配同形)。 */
function freshRoom(tag: string, opts: { wiring?: boolean } = {}): RoomFixture {
  const clock = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: freshId(tag), ownerId: 'owner', clock: clock.clock });
  const sim = new WorldSim({
    sizeCells: SIZE,
    mobs: false,
    wiring: opts.wiring === true,
    seed: SEED,
    combatRng: () => 0.5,
  });
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  return { rt, sim, clock };
}

/** 推进房间一帧(与 `step()` 同构:`meta.tick += 1` 之后 `ac.tick`)—— 不推进世界。 */
function bumpTick(rt: RoomRuntime): number {
  rt.state.meta.tick += 1;
  rt.ac.tick(rt.state.meta.tick);
  return rt.state.meta.tick;
}

/** 一个带裁判哨台(436,`params.mode`)的世界 + 房间(哨台判据的夹具)。 */
function deskRoom(): RoomFixture {
  clearPartyRegistry();
  const f = freshRoom('desk', { wiring: true });
  setPartyClock(() => f.clock.clock.nowMs());
  f.sim.wiring.addComponent(makeComponent('desk', 436, 5, 5, { params: { mode: 1 } }));
  f.sim.wiring.addComponent(makeComponent('banner', 435, 8, 5, { params: { team: 0 } }));
  const j = f.rt.join({ userId: 'owner' });
  ok(j.ok, '前置:房主进场');
  f.sim.setPlayerPos('owner', 5.5, 5.5);
  return f;
}

/* ═════════════════ 1. P1:尸体真的被回收(三张表)═════════════════ */

test('FND135-1 ★★ 击杀 ⇒ 延迟窗口内三表仍持有(负对照:不是立即删),过窗口后三表 + 刷怪计数一起归零', () => {
  const sim = mobWorld();
  const ids = ['mob_boar#1', 'mob_boar#2', 'mob_boar#3'];
  ids.forEach((id, i) => sim.addMob(id, 'MEADOW', 6.5 + i, 6.5));
  eq(tables(sim), { host: 3, aoi: 3, bodies: 3, spawner: 3, corpses: 0 }, '前置:三只都进三张表');
  eq(sim.listWildlife().length, 3, '前置:三只都在存活投影里');

  for (const id of ids) killMob(sim, id);
  /* 负对照(窗口内):收尸**不能**在这一帧就发生 —— 死亡那一帧的收尾
     (`settleKill` 读 `after.x/y`、掉落落地)还要读这条运行时。 */
  eq(sim.corpseCount, 3, '★ 击杀 ⇒ 三只都进了待收账(而不是被静默删掉)');
  eq(tables(sim).host, 3, '负对照:同一帧宿主仍持有尸体(死亡帧的收尾还能读到它)');
  eq(sim.mobHost.deadIds().length, 3, '宿主自己能说出「这 3 只是尸体」');
  eq(sim.listWildlife().length, 0, '存活投影立刻不再报它们(尸体不是「活物」)');

  sim.advance(1);
  eq(sim.corpseCount, 3, `负对照:第 1 帧还没到窗口(${MOB_CORPSE_FRAMES} 帧)⇒ 不收`);
  eq(sim.mobsReaped, 0, '负对照:一次都没收');

  sim.advance(1);
  eq(tables(sim), { host: 0, aoi: 0, bodies: 0, spawner: 0, corpses: 0 },
    '★★ 过窗口 ⇒ 宿主 / AOI / 物理 / 刷怪计数**四张账一起**归零');
  eq(sim.mobsReaped, 3, '★ 收尸计数 = 3(不是「表空了但没人知道为什么」)');
  eq(sim.mobHost.deadIds().length, 0, '宿主里没有残留尸体');
});

test('FND135-2 ★★ 死 100 只后三张表不增长(核心判据)', () => {
  const sim = mobWorld({ sizeCells: 64 });
  const ids: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const id = `mob_boar#${i + 1}`;
    ids.push(id);
    sim.addMob(id, 'MEADOW', 4.5 + (i % 20), 4.5 + Math.floor(i / 20));
  }
  const before = tables(sim);
  eq(before.host, 100, '前置:100 只都进宿主表');
  eq(before.aoi, 100, '前置:100 只都进 AOI');
  eq(before.bodies, 100, '前置:100 只都有刚体');
  /* `spawner.add` 自身有 `BIOME_SPAWN.MEADOW.hardCap = 14` 的硬上限 ⇒ 计数被夹在 14。
     判据因此写「收尸后回到 0」而不是「= 100」。 */
  ok(before.spawner <= 14, `前置:刷怪计数被 hardCap 夹住(实得 ${before.spawner})`);

  for (const id of ids) killMob(sim, id);
  eq(sim.corpseCount, 100, '★ 100 具尸体全部进待收账');

  sim.advance(MOB_CORPSE_FRAMES + 1);
  const after = tables(sim);
  eq(after.host, 0, `★ 宿主表不增长(修前恒 100):${after.host}`);
  eq(after.aoi, 0, `★ AOI 表不增长(修前恒 100):${after.aoi}`);
  eq(after.bodies, 0, `★ 物理表不增长(修前恒 100,resolvePairs 仍与尸体配对):${after.bodies}`);
  eq(after.spawner, 0, `★ 刷怪计数对称回落(修前只增不减 ⇒ hardCap 被尸体占满):${after.spawner}`);
  eq(after.corpses, 0, '待收账空');
  eq(sim.mobsReaped, 100, '★ 收尸计数 = 100');
  eq(sim.listWildlife().length, 0, '存活投影 0 条');
});

test('FND135-3 ★ 注入:绕过编排层只摘宿主一处 ⇒ AOI/物理仍持有尸体(判据不是「摘一处就够」)', () => {
  const sim = mobWorld();
  sim.addMob('mob_boar#1', 'MEADOW', 4.5, 4.5);
  killMob(sim, 'mob_boar#1');
  sim.advance(1);   /* 仍在窗口内 ⇒ 生产收尸点这一帧不动它 */
  eq(sim.mobHost.size, 1, '窗口内:宿主也还没摘');

  /* 注入:只调宿主自己的收尸口(修前唯一「看起来合理」的修法)。 */
  eq(sim.mobHost.reapDead(), ['mob_boar#1'], '宿主侧确实摘掉了这一具');
  eq(sim.mobHost.size, 0, '宿主表清了');
  eq(sim.aoi.mobCount, 1, '★★ AOI 仍持有尸体(只摘一处 ⇒ 换一张表继续浪费)');
  eq(sim.physics.bodies.has('mob_boar#1'), true, '★★ 物理表仍持有尸体(两两碰撞仍与它配对)');

  /* 生产收尸点补齐另外两张表(判据:注入之后仍能被收干净)。 */
  sim.advance(MOB_CORPSE_FRAMES);
  eq(sim.aoi.mobCount, 0, '★ 走到生产收尸点 ⇒ AOI 一并清');
  eq(sim.physics.bodies.has('mob_boar#1'), false, '★ 物理一并清');
  eq(sim.spawner.state.globalCount, 0, '★ 刷怪计数对称回落');
  eq(sim.mobsReaped, 1, '收尸计数 1');
});

test('FND135-4 ★ 负对照:同一实例被覆盖式重建 ⇒ 撤销待收标记,新那只**不被收走**', () => {
  const sim = mobWorld();
  sim.addMob('mob_sheep#1', 'MEADOW', 5.5, 5.5);
  killMob(sim, 'mob_sheep#1');
  eq(sim.corpseCount, 1, '前置:已标记待收');

  /* 同 id 再登记(`addMob` 的 REPLACED 档;姜饼小人复活走同一条)。 */
  eq(sim.addMob('mob_sheep#1', 'MEADOW', 5.5, 5.5), 'REPLACED', '前置:同 id 覆盖式重建');
  eq(sim.corpseCount, 0, '★ 再登记撤销待收标记');

  sim.advance(MOB_CORPSE_FRAMES + 1);
  ok(sim.mobHost.runtimeOf('mob_sheep#1') !== null,
    '★★ 新那只没有被收走(漏了撤销 ⇒ 复活后下一帧凭空消失)');
  eq(sim.mobHost.size, 1, '宿主仍有 1 只');
  eq(sim.mobHost.deadIds().length, 0, '它不是尸体');
  eq(sim.mobsReaped, 0, '一次都没收(没有收错对象)');
  eq(sim.corpseCount, 0, '待收账空');
});

/* ═════════════════ 2. P2:事件投递点移到慢帧之后 ═════════════════ */

test('FND135-5 ★★ 慢帧 emit ⇒ **同一 tick 内**投递;每帧只 drain 一次;负对照:帧外 emit 不立即投递', () => {
  const f = freshRoom('bus');
  const j = f.rt.join({ userId: 'p1' });
  ok(j.ok, '前置:世界里有一个登记玩家(`stepDozingEntry` 才会被调到)');

  /* 注入:一个**只可能在慢帧块里**被调用的生产者(`stepDozingEntry` 每慢帧逐玩家问一次),
     它 emit 的事件如果按旧顺序(慢帧块之前 drain)就得等下一快帧。 */
  let fires = 0;
  f.sim.attachSleepSource(() => {
    if (fires === 0) {
      f.sim.bus.emit('fnd135_slow', { at: 1 }, 'fnd135');
      fires += 1;
    }
    return false;
  });
  let received = 0;
  f.sim.bus.on('fnd135_slow', () => { received += 1; });

  let emittedAtFrame = -1;
  let sameTickDelivery = false;
  let drainsPerTick = 0;
  for (let i = 1; i <= FAST_PER_SLOW; i += 1) {
    const gotBefore = received;
    const framesBefore = f.sim.bus.totals.frames;
    f.sim.tick();
    const drains = f.sim.bus.totals.frames - framesBefore;
    if (drains !== 1) drainsPerTick = -1;
    if (fires > 0 && emittedAtFrame < 0) {
      emittedAtFrame = i;
      sameTickDelivery = received > gotBefore;
    }
    if (fires > 0) break;
  }
  ok(fires > 0, `前置:注入的慢帧生产者真的被调到了(第 ${emittedAtFrame} 帧)`);
  eq(fires, 1, '负对照:只 emit 一次(不会把「后面几帧的投递」算成同帧)');
  ok(sameTickDelivery, '★★ 慢帧 emit ⇒ **同一 tick 内**投递(修前:慢帧在 drain 之后,要等下一快帧)');
  eq(drainsPerTick, 0, '★ 每帧只 drain **一次**(是「移点」而不是「加第二次」—— 双 drain 会让事件序列错帧)');
  eq(f.sim.bus.pending, 0, '★ 帧末总线无滞留事件');

  /* 负对照:帧**外** emit 不会立即投递(投递点是帧末,不是 emit 当下)。 */
  let late = 0;
  f.sim.bus.on('fnd135_late', () => { late += 1; });
  f.sim.bus.emit('fnd135_late', {}, 'fnd135');
  eq(late, 0, '负对照:刚 emit 完还没投递');
  eq(f.sim.bus.pending, 1, '它躺在当帧队列里');
  f.sim.tick();
  eq(late, 1, '下一帧的帧末投递(pending 语义照旧)');
});

test('FND135-6 ★★ 生产触发器(裁判哨台):播报与「下发」同帧投递;房间离开 OPEN 后没有滞留', () => {
  const f = deskRoom();
  const { rt, sim, clock } = f;
  eq(sim.partyPhase(), 'IDLE', '负对照(前):没人站哨台 ⇒ 世界侧没有赛局');

  let deskStarts = 0;
  let broadcasts = 0;
  let slowEmits = 0;
  let slowReceived = 0;
  sim.bus.on('party_desk_start', () => { deskStarts += 1; });
  sim.bus.on('party_broadcast', () => { broadcasts += 1; });
  /* 慢帧生产者(注入):每慢帧都 emit 一次 —— 用来钉「最后一帧的事件也不会烂在队列里」。 */
  sim.attachSleepSource((pid) => {
    if (pid === 'owner') { slowEmits += 1; sim.bus.emit('fnd135_tick_mark', { at: slowEmits }, 'fnd135'); }
    return false;
  });
  sim.bus.on('fnd135_tick_mark', () => { slowReceived += 1; });

  let sameTickBroadcast = false;
  let deliveredBefore = 0;
  for (let i = 0; i < FAST_PER_SLOW + 1; i += 1) {
    const drained = sim.partyBroadcastCount;
    const got = broadcasts;
    rt.step();
    if (sim.partyBroadcastCount > drained) {
      sameTickBroadcast = broadcasts > got;
      deliveredBefore = broadcasts;
    }
  }
  ok(deskStarts > 0, '★ 哨台真的开局(慢帧里 emit 了 party_desk_start)');
  ok(sim.partyPhase() !== 'IDLE', '前置:世界侧的赛局在跑');
  ok(deliveredBefore > 0, '前置:世界侧真的下发过播报');
  ok(sameTickBroadcast, '★★ 播报与「下发它的那一帧」**同帧**投递(修前:慢帧发出、下一快帧才投递)');
  eq(sim.bus.pending, 0, '★ 帧末总线无滞留');
  ok(rt.partyBroadcastTotal > 0, `★ 房间订阅**同一帧**收到(修前要等下一快帧,共 ${rt.partyBroadcastTotal} 条)`);
  ok(rt.drainPartyBroadcasts().length > 0, '★ 下发口非空(播报没有卡在总线里)');

  /* ── 房间离开 OPEN ⇒ `advance` 不再跑:最后一帧的事件必须已经投递完 ── */
  const emitsBeforeDisconnect = slowEmits;
  rt.disconnect('owner');
  clock.advance(10_000);       /* 仍在重连宽限(30s)内 ⇒ 世界刚体还在,慢帧生产者仍被调用 */
  let sameTickAfterDisconnect = false;
  for (let i = 0; i < FAST_PER_SLOW; i += 1) {
    const emits = slowEmits;
    const got = slowReceived;
    const frameBefore = sim.frame;
    rt.step();
    ok(sim.frame > frameBefore, '前置:世界仍推进(还没休眠)');
    if (slowEmits > emits) {
      sameTickAfterDisconnect = slowReceived > got;
      break;
    }
  }
  ok(slowEmits > emitsBeforeDisconnect, '前置:断线宽限期内的慢帧生产者仍被调用');
  ok(sameTickAfterDisconnect, '★ 那一帧的事件**帧内**投递完(不是等下一帧)');

  /* 宽限期(30s)过后席位被回收 —— 而**回收本身会刷新活动时间戳**
     (`reapExpiredDisconnects` 的 `touch`),所以休眠必须等「回收之后再静默 60 秒」。 */
  clock.advance(31_000);
  rt.step();
  eq(rt.hasAnyOnlineConnection(), false, '前置:席位已回收 ⇒ 房间里没有在线连接');
  eq(rt.status, RoomStatus.OPEN, '负对照:回收那一刻还不该休眠(活动时间被刷新)');

  clock.advance(60_000);
  const frameBeforeSleep = sim.frame;
  rt.step();
  eq(rt.status, RoomStatus.SLEEPING, '前置:无在线连接 + ≥60s ⇒ 帧末转 SLEEPING');
  ok(sim.frame > frameBeforeSleep, '前置:这一帧世界仍推进(休眠发生在帧末)');
  eq(sim.bus.pending, 0, '★★ 最后一帧结束时总线已排空(修前:慢帧事件留在队列里,而 `advance` 再也不跑)');
  const frameAtSleep = sim.frame;
  rt.step();
  eq(sim.frame, frameAtSleep, '★★ 休眠后 `advance` 不再跑 ⇒ 修前那些「等下一快帧」的事件**永远**投递不了');
  eq(sim.bus.pending, 0, '★ 仍然没有滞留');
});

/* ═════════════════ 3. P1:世界拒收 ⇒ 窗口不推进 ═════════════════ */

test('FND135-7 ★★ 世界拒收(倒地)⇒ 反作弊窗口不推进 + 如实回执;注入:幻影水位 ⇒ 合法报文被判 TELEPORT', () => {
  const f = freshRoom('move');
  const j = f.rt.join({ userId: 'p1' });
  ok(j.ok, '前置:进场(世界侧同时登记刚体,与生产同一路径)');
  const { rt, sim } = f;

  /* ── 前置:一步合法移动(把水位 / 窗口 / 权威位置对齐) ── */
  const P = sim.playerPosition('p1')!;
  const t1 = bumpTick(rt);
  const step1 = rt.applyMove('p1', { tick: t1, x: P.x + 0.2, y: P.y, z: 0 });
  eq(step1.allowed, true, '前置:合法小步放行');
  const A = sim.playerPosition('p1')!;
  eq(A.x, P.x + 0.2, '前置:权威位置真的动了');
  const st = rt.ac.get('p1')!;
  eq(st.lastX, A.x, '前置:反作弊水位与权威**同源**');
  const winLen = st.window.length;
  const moveTick = st.lastMoveTick;
  const violBefore = rt.ac.violations().length;

  /* ── 世界拒收:倒地 ── */
  sim.vitals.applyDamage('p1', 1e9, { ignoreIframe: true });
  eq(sim.vitals.get('p1')!.downed, true, '前置:已倒地');
  const phantom = A.x + 0.3;
  const t2 = bumpTick(rt);
  const rejected = rt.applyMove('p1', { tick: t2, x: phantom, y: A.y, z: 0 });
  eq(rejected.allowed, false, '★★ 世界拒收 ⇒ 回执**如实**(修前:allowed:true —— 谎报成功)');
  eq(rejected.worldRejected, true, '★ 拒绝来源标记为世界侧(与反作弊拒绝可区分)');
  eq(rt.worldMoveRejects, 1, '★ 世界拒收计数 = 1');
  eq(rt.lastMoveWorldReject, true, '★ 回滚真的发生了(不是「没状态可回滚」)');
  eq(st.lastX, A.x, '★★ 水位**没有**被推到幻影坐标');
  eq(st.lastMoveTick, moveTick, '★ 申报水位没推进(额度不被白吃)');
  eq(st.window.length, winLen, '★ 窗口没多出一个幻影点(窗口式移速的路径不被污染)');
  eq(sim.playerPosition('p1')!.x, A.x, '刚体位置不变(世界没收)');
  eq(rt.ac.violations().length, violBefore, '★ 零新增违规(世界拒收不是玩家的错)');

  /* ── 复活 + **同一 tick** 的合法重发(按权威坐标)⇒ 必须放行 ── */
  sim.vitals.revive('p1');
  const retry = rt.applyMove('p1', { tick: t2, x: A.x + 0.3, y: A.y, z: 0 });
  eq(retry.allowed, true, '★★ 回滚之后,同 tick 的合法重发必须放行(修前按幻影坐标判跳变)');
  eq(rt.ac.violations().length, violBefore, '★ 仍零违规(TELEPORT / SPEED 都没有)');
  eq(rt.worldMoveRejects, 1, '这次世界收了 ⇒ 计数不变');

  /* ── 注入:手工制造「修前形态」(水位/窗口 = 幻影链),同一条合法报文就该被判跳变 ── */
  const g = freshRoom('move-inject');
  g.rt.join({ userId: 'p1' });
  const B = g.sim.playerPosition('p1')!;
  const t1b = bumpTick(g.rt);
  eq(g.rt.applyMove('p1', { tick: t1b, x: B.x + 0.2, y: B.y, z: 0 }).allowed, true, '注入组前置:合法小步');
  const C = g.sim.playerPosition('p1')!;
  const st2 = g.rt.ac.get('p1')!;
  const t2b = bumpTick(g.rt);
  /* 修前:世界拒收**照样**把窗口与水位推到申报坐标(`applyPlayerMove` 返回值被丢弃);
     客户端带预测连发两包(`C+0.3` / `C+0.6`)⇒ 水位停在 `C+0.6`,刚体还在 `C`。 */
  st2.window.push({ tick: t2b, x: C.x + 0.6, y: C.y });
  st2.lastX = C.x + 0.6;
  st2.lastY = C.y;
  st2.lastMoveTick = t2b;
  g.sim.vitals.revive('p1');
  const falsePositive = g.rt.applyMove('p1', { tick: t2b, x: C.x + 0.3, y: C.y, z: 0 });
  eq(falsePositive.allowed, false, '★★ 注入:幻影水位 ⇒ 同一条**合法**报文被判跳变(修前形态)');
  eq(falsePositive.violation?.kind, ViolationKind.TELEPORT, '★ 违规类型 = TELEPORT(合法玩家被误判)');
  eq(falsePositive.worldRejected, undefined, '负对照:这次是**反作弊侧**拒绝,不是世界侧');
  eq(g.rt.worldMoveRejects, 0, '负对照:世界侧拒收计数不动');
});

test('FND135-8 ★ 负对照:没有世界 / 旧世界源(拿不到权威)/ 世界不认识这个玩家 ⇒ 行为逐字不变', () => {
  /* (a) 没有世界:照旧放行(`levelOf`/`saveToDb` 同一 null 契约) */
  const bare = new RoomRuntime({ roomId: freshId('nw'), ownerId: 'owner', clock: fixedClock(1).clock });
  bare.join({ userId: 'p1' });
  const v0 = bare.applyMove('p1', { tick: bumpTick(bare), x: 0.7, y: 0.5, z: 0 });
  eq(v0.allowed, true, '没有世界 ⇒ 不制造假拒绝');
  eq(v0.worldRejected, undefined, '也不打「世界侧」标记');
  eq(bare.worldMoveRejects, 0, '不计数');

  /* (b) 旧世界源:有 `applyPlayerMove` 却**没有** `playerPosition` ⇒ 拿不到权威 ⇒ 退回旧行为 */
  const legacy = {
    saveToDb: () => ({ hpSaved: 0, hpSkipped: 0, memRow: 0 }),
    applyPlayerMove: () => false,
  };
  const rtLegacy = new RoomRuntime({
    roomId: freshId('legacy'), ownerId: 'owner', clock: fixedClock(1).clock, host: legacy as never,
  });
  rtLegacy.join({ userId: 'p1' });
  const v1 = rtLegacy.applyMove('p1', { tick: bumpTick(rtLegacy), x: 0.7, y: 0.5, z: 0 });
  eq(v1.allowed, true, '★ 拿不到权威位置 ⇒ **不**判「世界拒收」(否则旧世界源会把每次移动都判死)');
  eq(rtLegacy.worldMoveRejects, 0, '不计数');

  /* (c) 世界**认识**这个玩家却拒收 ⇒ 如实拒绝 + 计数(与 (b) 成对:判据是「有没有权威刚体」) */
  const f = freshRoom('stun');
  f.rt.join({ userId: 'p1' });
  const Q = f.sim.playerPosition('p1')!;
  f.sim.vitals.applyStun('p1', 5);
  eq(f.sim.vitals.stunOf('p1') > 0, true, '前置:已眩晕');
  const v2 = f.rt.applyMove('p1', { tick: bumpTick(f.rt), x: Q.x + 0.1, y: Q.y, z: 0 });
  eq(v2.allowed, false, '★ 眩晕 ⇒ 世界拒收 ⇒ 如实拒绝');
  eq(v2.worldRejected, true, '标记世界侧');
  eq(v2.corrected?.x, Q.x, '回执带回**权威**坐标(客户端据此静默回退)');
  eq(f.rt.worldMoveRejects, 1, '计数 1');
});

/* ═════════════════ 4. P2:单帧动作预算真实现 ═════════════════ */

test('FND135-9 ★★ 单帧动作预算:前 64 条真执行,第 65 条起被拒 + 计数 + 明细;帧推进后重开', () => {
  const rt = new RoomRuntime({ roomId: freshId('budget'), ownerId: 'owner', clock: fixedClock(1).clock });
  rt.join({ userId: 'owner' });
  const b0 = rt.actionBudgetState();
  eq(b0.used, 0, '前置:本帧还没执行过动作');
  /* ── 量纲锚:预算 = 64/帧(字面量)。判据其余处一律写 **64** 这个字面量 ——
     期望侧若也取被测模块的导出常量,断言就退化成「常量 == 常量」
     (门禁 `--strict-taut` 的同义反复候选正是这么判的)。 ── */
  eq(MAX_ACTIONS_PER_TICK, 64, '锚:单帧动作预算 = 64');
  eq(b0.limit, 64, '预算口径 = 64(不再只是声明)');
  eq(rt.actionsThrottled, 0, '前置:没有超预算记录');

  let executed = 0;
  for (let i = 0; i < 64; i += 1) {
    if (rt.dispatchAction('owner', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC }).ok) executed += 1;
  }
  eq(executed, 64, '★ 前 64 条**真的执行了**(ok:true —— 不是「计数了但没跑」)');
  eq(rt.actionBudgetState().used, 64, '预算用满');
  eq(rt.actionsDispatched, 64, '执行计数同步');

  const over = rt.dispatchAction('owner', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC });
  eq(over.ok, false, '★★ 第 65 条被拒(修前**没有任何兜底**:照样执行)');
  /* ★ P1(2026-11-21):超预算的档位从 `INVALID` 改成**独立**的 `THROTTLED` ——
     修前那条「不是权限 / 参数问题」的注释与回执内容自相矛盾(客户端读到的是
     「你参数错了」)。这条断言跟着改,其余三处(计数 / 明细 / 帧边界)未变。 */
  eq(over.kind, 'THROTTLED', '回执类别:预算档(不是权限 / 参数问题,也不是 INVALID)');
  ok((over.reason ?? '').includes('预算'), `理由写明是预算:${over.reason}`);
  eq(rt.actionsThrottled, 1, '★ 被拒计数(可观测 —— 静默丢弃才是缺陷)');
  eq(rt.throttledActions.length, 1, '★ 明细留下(谁 / 哪个动作 / 哪一帧)');
  eq(rt.throttledActions[0]!.actorId, 'owner', '明细里的 actor');
  eq(rt.throttledActions[0]!.action, RoomAction.SET_ROOM_ACCESS, '明细里的动作名');

  /* 负对照:帧不推进 ⇒ 仍然被拒(预算不会自己回满)。 */
  eq(rt.dispatchAction('owner', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC }).ok, false,
    '负对照:帧没推进 ⇒ 仍被拒');
  eq(rt.actionsThrottled, 2, '继续计数');

  /* 帧边界重开。 */
  rt.state.meta.tick += 1;
  eq(rt.actionBudgetState().used, 0, '★ 帧推进 ⇒ 预算重开');
  eq(rt.dispatchAction('owner', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC }).ok, true,
    '★ 新一帧第一条放行');
  eq(rt.actionBudgetState().used, 1, '新一帧用掉 1 格');
});

test('FND135-10 ★ 负对照:预算是**帧**预算,不按连接分桶(多连接共享 64)', () => {
  const rt = new RoomRuntime({ roomId: freshId('budget2'), ownerId: 'owner', clock: fixedClock(1).clock });
  rt.join({ userId: 'owner' });
  rt.join({ userId: 'p1' });
  for (let i = 0; i < 32; i += 1) rt.dispatchAction('owner', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC });
  for (let i = 0; i < 32; i += 1) rt.dispatchAction('p1', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC });
  eq(rt.actionBudgetState().used, 64,
    '★ 两个连接**共享**一帧预算(修前:一帧内多连接 dispatch 无兜底)');
  const over = rt.dispatchAction('p1', RoomAction.SET_ROOM_ACCESS, { mode: AccessMode.PUBLIC });
  eq(over.ok, false, '★ 邻居用完预算 ⇒ 这条也被拒');
  eq(rt.actionsThrottled, 1, '被拒计数');
  eq(rt.throttledActions[0]!.actorId, 'p1', '明细记的是**被拒的那条**的 actor(不是别人的)');
});

/* ═════════════════ 5. P3:攻击冷却成功才提交 ═════════════════ */

test('FND135-11 ★★ 超射程 ⇒ 不提交冷却(同 tick 仍可再打);命中 ⇒ 提交(同 tick 第二次被拒)', () => {
  /* ── 超射程:目标 7 格外 ≫ 裸装 reach 3.3 ── */
  const far = freshRoom('atk-far');
  far.rt.join({ userId: 'p1' });
  for (let x = 2; x <= 20; x += 1) far.sim.setCell(x, 8, { obj: 0 });   /* 清出一行开阔地(消掉 LOS 变量) */
  far.sim.setPlayerPos('p1', 17.5, 8.5);
  far.sim.addMob('mob_sheep#1', 'MEADOW', 10.5, 8.5);
  bumpTick(far.rt);
  const v1 = far.rt.applyAttack('p1', 0, 'mob_sheep#1');
  eq(v1.allowed, true, '前置:反作弊放行');
  eq(far.rt.lastAttackReport?.outOfReach, true, '前置:确实超射程');
  eq(far.rt.lastAttackSettled, false, '★ 超射程不算成功');
  eq(far.rt.lastAttackRejection, 'OUT_OF_REACH', '★ 理由可读(不是「什么都没发生」)');
  eq(far.rt.ac.get('p1')!.lastAttackTick, -9999, '★★ 冷却水位**没有**被提交');
  eq(far.rt.applyAttack('p1', 0, 'mob_sheep#1').allowed, true,
    '★★ 无效攻击不占冷却 ⇒ 同一 tick 第二次仍可尝试(修前第二个包被判 ATTACK_RATE)');

  /* ── 命中:目标 2 格(裸装 reach 3.3 之内,WS-FND-91 同一夹具) ── */
  const near = freshRoom('atk-hit');
  near.rt.join({ userId: 'p1' });
  for (let x = 8; x <= 14; x += 1) near.sim.setCell(x, 8, { obj: 0 });
  near.sim.setPlayerPos('p1', 12.5, 8.5);
  near.sim.addMob('mob_sheep#1', 'MEADOW', 10.5, 8.5);
  const hitTick = bumpTick(near.rt);
  const h1 = near.rt.applyAttack('p1', 0, 'mob_sheep#1');
  eq(h1.allowed, true, '前置:反作弊放行');
  ok((near.rt.lastAttackReport?.hpLoss ?? 0) > 0, `前置:真的结算了伤害(${near.rt.lastAttackReport?.hpLoss})`);
  eq(near.rt.lastAttackSettled, true, '★ 命中 ⇒ 成功');
  eq(near.rt.lastAttackRejection, null, '★ 成功的理由字段为空');
  eq(near.rt.ac.get('p1')!.lastAttackTick, hitTick, '★ 成功才提交冷却水位(= 判定那一帧)');
  const h2 = near.rt.applyAttack('p1', 0, 'mob_sheep#1');
  eq(h2.allowed, false, '★ 同一 tick 第二次被攻速闸拒(冷却真的生效)');
  eq(h2.violation?.kind, ViolationKind.ATTACK_RATE, '★ 违规类型 = ATTACK_RATE');
  eq(near.rt.lastAttackRejection, 'RATE', '★ 回执理由 = RATE');
});

test('FND135-12 ★ 负对照:无世界 / 无目标 / NO_SKILL / 目标不在册 ⇒ 都不占冷却,且理由可读', () => {
  /* (a) 没有世界 */
  const bare = new RoomRuntime({ roomId: freshId('atk-nw'), ownerId: 'owner', clock: fixedClock(1).clock });
  bare.join({ userId: 'p1' });
  eq(bare.applyAttack('p1', 0, 'mob_sheep#1').allowed, true, '前置:反作弊放行(闸与「有没有世界」无关)');
  eq(bare.lastAttackSettled, false, '★ 没有世界 ⇒ 不算结算');
  eq(bare.lastAttackRejection, 'NO_WORLD', '★ 理由 = NO_WORLD');
  eq(bare.ac.get('p1')!.lastAttackTick, -9999, '★ 冷却没提交');
  eq(bare.applyAttack('p1', 0, 'mob_sheep#1').allowed, true,
    '★ 同一 tick 第二次仍放行(修前:第一次就把 8 帧冷却吃掉)');

  /* (b) 有世界但报文没带 mobId */
  const f = freshRoom('atk-notarget');
  f.rt.join({ userId: 'p1' });
  bumpTick(f.rt);
  eq(f.rt.applyAttack('p1', 0).allowed, true, '前置:放行');
  eq(f.rt.lastAttackRejection, 'NO_TARGET', '★ 理由 = NO_TARGET(与 NO_WORLD 可区分)');
  eq(f.rt.ac.get('p1')!.lastAttackTick, -9999, '★ 冷却没提交');

  /* (c) [Q] 但当前武器没有技能 ⇒ 世界侧 NO_SKILL(零伤害) */
  const g = freshRoom('atk-noskill');
  g.rt.join({ userId: 'p1' });
  bumpTick(g.rt);
  eq(g.rt.applyAttack('p1', 0, 'mob_sheep#1', true).allowed, true, '前置:放行');
  eq(g.rt.lastAttackReport?.rejected, 'NO_SKILL', '前置:世界侧拒因为 NO_SKILL');
  eq(g.rt.lastAttackSettled, false, '★ NO_SKILL 不算结算');
  eq(g.rt.lastAttackRejection, 'NO_SKILL', '★ 理由原样透出');
  eq(g.rt.ac.get('p1')!.lastAttackTick, -9999, '★★ 冷却没提交(修前:按一次 Q 白占 8 帧)');

  /* (d) 目标不在册(世界侧 `hit === null` 且 `rejected === null`) */
  const h = freshRoom('atk-missing');
  h.rt.join({ userId: 'p1' });
  bumpTick(h.rt);
  eq(h.rt.applyAttack('p1', 0, 'mob_not_here').allowed, true, '前置:放行');
  eq(h.rt.lastAttackReport?.hit, false, '前置:没有结算对象');
  eq(h.rt.lastAttackRejection, 'NO_TARGET_MOB', '★ 与「超射程」分开的理由(不合并成 OUT_OF_REACH)');
  eq(h.rt.ac.get('p1')!.lastAttackTick, -9999, '★ 冷却没提交');
});

test('FND135-13 ★ 锚:冷却间隔常量与「8 帧」的量纲一致(判据不把量纲读错)', () => {
  /* 本套件的所有「白占 8 帧」说法都建立在「基线间隔 = 0.4s = 8 帧(@20Hz)」上。
     这里用**函数级**入口把它钉住:第 8 帧放行、第 7 帧被拒 ——
     常量被改掉时这条锚先红,而不是让上面那些行为判据悄悄失去量纲。 */
  const rt = new RoomRuntime({ roomId: freshId('anchor'), ownerId: 'owner', clock: fixedClock(1).clock });
  rt.join({ userId: 'p1' });
  const s = rt.ac.get('p1')!;
  rt.ac.commitAttackOf('p1', 0);
  eq(rt.ac.attackPreview('p1', 7).allowed, false, '第 7 帧仍不够(基线 8 帧)');
  eq(rt.ac.attackPreview('p1', 8).allowed, true, '★ 第 8 帧满足基线间隔');
  eq(s.lastAttackTick, 0, '★ `attackPreview` 不提交水位(判定与提交分开)');
  eq(rt.ac.commitAttackOf('p1', 8), true, '提交成功');
  eq(s.lastAttackTick, 8, '★ 提交后水位 = 8');
  eq(rt.ac.commitAttackOf('p1', 3), true, '负对照:申报一个**更小**的 tick 也「提交成功」');
  eq(s.lastAttackTick, 8, '★ 但水位单调、不会被拉回去(修前 `= tick` 可被回退攻击绕过)');
  eq(rt.ac.attackPreview('p1', 9).allowed, false, '★ 回退申报拿不到新额度');
  eq(rt.ac.commitAttackOf('ghost', 1), false, '未登记的玩家 ⇒ 不提交');
});

report('WS-FND-135');
