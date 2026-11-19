/**
 * WS-FND-123 —— boss 投影 / 两套开局打通 / 结算幂等 / 播报与 RUSH_GRADE 下发(第七轮实测 P1)
 *
 * 运行:`node tests/WS-FND-123-boss-party-projection.test.ts`
 *
 * ## 这个套件钉的六件事
 *
 * | # | 缺陷(第七轮实测) | 本套件怎么钉 |
 * | :-- | :--- | :--- |
 * | 1 | `upsertBoss` 零调用 ⇒ `state.bosses` 恒空(客户端血条/预警走兜底) | FND123-1/2/3/4:每帧投影 10 字段;召唤可见、消失清账;摘掉读口即回到旧形态 |
 * | 2 | 哨台开局只建赛局、`START_PARTY` 只建记账 ⇒ `partyStateOf()` 恒 null | FND123-5/6/7:任一路径都「记账 + 赛局」,各有负对照 |
 * | 3 | `clearPartyRun` 不查 `lastPartySettlement` ⇒ 自然结算后又按 -1 再发一遍奖 | FND123-9/10:同一 settlement 只发一次;但「收局即唯一结算」时仍发一次 |
 * | 4 | 播报只 `bus.emit('party_broadcast')`,server 侧 `.bus.on(` 零处 | FND123-8/12:房间订阅并积压;摘掉 `bus` 即 0 条 |
 * | 5 | `rushSettlement()` 只在测试里被读 ⇒ `RUSH_GRADE` 出不了进程 | FND123-13:成功回执的 `effect.rushGrade`;摘掉读口则无此键 |
 * | 6 | `settleRace` 的 `rewards` 全 `team/playerId=null` ⇒ `targets=[]` 静默不发 | FND123-11:归属按结算自己的名次表补全;无表的负对照计入未归属 |
 *
 * ## 判据纪律
 *
 * 1 **注入验证**:FND123-4(摘 `bossSnapshots`)/ 12(摘 `bus`)/ 13(摘 `rushSettlement`)
 *   都是「把那一口接线摘掉 ⇒ 退回旧形态」—— 不摘的话「接线了但这帧无事」与
 *   「根本没接线」在读数上一样是 0。
 * 2 **负对照**:每条正判据都配一条「同一夹具、只改一个输入」的对照
 *   (没有 boss / 没人站哨台 / 没开过局 / 结算表里没有该名次)。
 * 3 **不拿实现常量核实现行为**:字段集合取 `BOSS_FIELD_TABLE`,模式键取 `PartyMode`,
 *   行为量由世界侧独立读数(`partyPhase()` / `partySettlement()` / 成长档案)给出。
 */
import { eq, includes, ok, report, test } from '../shared/testing/harness.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';
import { makeComponent } from '../server/src/wiring/components.ts';
import { makeMemoryOfferingPort } from '../server/src/bosses/runtime.ts';
import { RoomAction, RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import {
  PartyPhase,
  addScore,
  clearPartyRegistry,
  partyStateOf,
  setPartyClock,
} from '../server/src/net/actions/start_party.ts';
import { PartyMode } from '../server/src/db/repo.ts';
import { BOSS_FIELD_TABLE, TelegraphShape } from '../shared/types/wire.ts';
import { createManualClock } from '../server/src/coop/rush_order.ts';
import {
  createRaceRun,
  finishRunner,
  openGate,
  settleRace,
  type PartySettlement,
} from '../server/src/party/modes.ts';
import { rewardForRank } from '../server/src/party/scoring.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

let roomSeq = 0;
/** 每次一个新 roomId:记账表(`PARTIES`)按 roomId 分桶,复用会串局。 */
function freshRoomId(tag: string): string {
  roomSeq += 1;
  return `room_fnd123_${tag}_${roomSeq}`;
}

/** 跑 `n` 个**慢帧**(2Hz)⇒ `n × FAST_PER_SLOW` 次 `tick()`。 */
function tickSlow(sim: WorldSim, n = 1): void {
  for (let i = 0; i < n * FAST_PER_SLOW; i += 1) sim.tick();
}

/** 摘掉 host 上的若干成员(注入验证用;其余方法照旧可用)。 */
function maskHost<T extends object>(host: T, keys: readonly string[]): T {
  return new Proxy(host, {
    get(target, prop, recv) {
      if (typeof prop === 'string' && keys.includes(prop)) return undefined;
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as T;
}

/**
 * 一个有裁判哨台(436,`params.mode`)与可选复活旗(435)的世界 + 房间。
 *
 * 角色分工:
 * - `owner` 站哨台格 → 既是房主(OWNER,有 `party` 权限)又是裁判;
 * - `p1` 站旗格 → 世界侧队伍 = RED(`scanPartyTeams` 的唯一来源)。
 */
interface Fixture {
  sim: WorldSim;
  rt: RoomRuntime;
  roomId: string;
}

function arena(opts: {
  mode?: number;
  banner?: boolean;
  /** 让 `p1` 也进房间(默认只进 owner)。 */
  joinP1?: boolean;
  /** 不把 owner 放进世界(用于「无裁判」负对照)。 */
  referee?: boolean;
} = {}): Fixture {
  clearPartyRegistry();
  const roomId = freshRoomId('arena');
  const c = fixedClock(1_700_000_000_000);
  /* 记账模块自带可注入时钟(它拿不到房间的 `clock`)。用**同一个**固定时钟,
     `meta.partyTimer` 才是确定的(否则 elapsed = 墙钟 - 固定起点 ⇒ 恒 0)。 */
  setPartyClock(() => c.clock.nowMs());
  const rt = new RoomRuntime({ roomId, ownerId: 'owner', clock: c.clock });
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const desk = makeComponent('desk', 436, 5, 5, { params: { mode: opts.mode ?? 1 } });
  sim.wiring.addComponent(desk);
  if (opts.banner !== false) {
    sim.wiring.addComponent(makeComponent('banner', 435, 8, 5, { params: { team: 0 } }));
  }
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  const j = rt.join({ userId: 'owner' });
  ok(j.ok, '前置:房主进场');
  if (opts.referee !== false) sim.setPlayerPos('owner', 5.5, 5.5);
  if (opts.joinP1 === true) {
    const j2 = rt.join({ userId: 'p1' });
    ok(j2.ok, '前置:p1 进场');
  } else {
    /* 世界里的选手与房间成员是**两件事**:`partyTeamOf` 只看世界刚体。 */
    sim.addPlayer('p1', 8.5, 5.5);
  }
  sim.setPlayerPos('p1', 8.5, 5.5);
  return { sim, rt, roomId };
}

/** 一只有预警几何的 Boss(果冻国王 P1 = 环带 [2.5, 3.5],`warnSec = 0.8`)。 */
function summonJellyKing(sim: WorldSim): void {
  const port = makeMemoryOfferingPort({ p1: { 734: 1 } });
  const r = sim.summonBoss(
    {
      bossId: 'boss_jelly_king', itemId: 734, hasAltar: true,
      /* 祭坛必须在**安全区外**(24 格):`isInsideSafeRadius` 优先于祭品校验。 */
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 1, alreadyAlive: false, ownerId: 'p1',
    },
    port,
  );
  ok(r.ok, '前置:果冻国王召唤成功');
}

/** 推 `slow` 个**慢帧**(房间一帧 = 一快帧;对局运行时只在慢帧推进)。 */
function stepRoom(rt: RoomRuntime, slow = 1): void {
  for (let i = 0; i < slow * FAST_PER_SLOW + 1; i += 1) rt.step();
}

/** FND123-4 的小夹具:一房一世界(房主 + p1 在世界上)。 */
function bossRoom(clock: ReturnType<typeof fixedClock>['clock'], tag: string): Fixture {
  clearPartyRegistry();
  const roomId = freshRoomId(tag);
  const rt = new RoomRuntime({ roomId, ownerId: 'owner', clock });
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 10.5, 10.5);
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  ok(rt.join({ userId: 'owner' }).ok, '前置:进场');
  return { sim, rt, roomId };
}

/* ══════════════ 1. Boss 投影:P1-1 ══════════════ */

test('FND123-1 ★★ Boss 每帧投影:10 个字段与 `BOSS_FIELD_TABLE` 对齐(修前 upsertBoss 零调用)', () => {
  clearPartyRegistry();
  const c = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: freshRoomId('boss'), ownerId: 'owner', clock: c.clock });
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 10.5, 10.5);
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  rt.join({ userId: 'owner' });
  summonJellyKing(sim);

  eq(rt.state.bosses.length, 0, '前置:推进之前 state.bosses 还是空的');
  rt.step();

  eq(rt.state.bosses.length, 1, '★ 一帧之后 boss 出现在线快照里(修前恒空)');
  const b = rt.state.bosses[0]!;
  /* 字段集合取**冻结表**,不抄一份 key 列表 —— 表加了字段,这条断言会按设计变红。 */
  eq(
    Object.keys(b).sort().join(','),
    BOSS_FIELD_TABLE.map((f) => f.key).sort().join(','),
    '★ 10 个字段与 BOSS_FIELD_TABLE 逐字段一致(不多不少)',
  );
  eq(b.bossId, 'boss_jelly_king', 'bossId 来自内容层');
  eq(b.id, 'boss:boss_jelly_king', '实体 id 格式固定且可断言');
  eq(b.phase, 0, '阶段 0(前端读它换阶段色)');
  eq(b.hp, 2500, '血量取自世界快照(baseHp 2500)');
  eq(b.maxHp, 2500, '上限取自世界快照');
  ok(rt.bossProjectionCount >= 1, '★ 投影计数 > 0(证明的是**这一帧的调用**,不是默认值)');

  /* 掉血 ⇒ 线快照跟着变(单向投影,不是一次性快照)。 */
  sim.damageBoss('boss_jelly_king', 500);
  rt.step();
  eq(rt.state.bosses[0]!.hp, 2000, '★ 受到 500 伤害后线快照跟着掉血(每帧投影,不是只投一次)');
});

test('FND123-2 ★ 地面预警几何:环带形状/坐标/半径/结算帧都出自世界(不是 0 兜底)', () => {
  clearPartyRegistry();
  const c = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: freshRoomId('tele'), ownerId: 'owner', clock: c.clock });
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 10.5, 10.5);
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  rt.join({ userId: 'owner' });
  summonJellyKing(sim);
  rt.step();

  const b = rt.state.bosses[0]!;
  eq(b.telegraphShape, TelegraphShape.RING, '★ 果冻国王 P1 是环带 ⇒ 线上词 RING(4)');
  ok(b.telegraphR > 0, `★ 半径非 0(R=${b.telegraphR};0 会让客户端画不出预警圈)`);
  ok(b.telegraphEndTick > 0, '★ 结算帧是绝对世界帧(非 0)');
  /* 环带外径 3.5 = `phases.ts` 的内容值;这里只钉「落在世界坐标附近」,
     具体数值由内容层决定(不把 3.5 抄成第二份事实)。 */
  ok(Math.abs(b.telegraphX) < 0.001 && Math.abs(b.telegraphY) < 0.001, '★ 预警中心 = Boss 自己的坐标(0,0),不是玩家坐标/祭坛');
  eq(b.telegraphR, 3.5, '外径 3.5(WarnGeom.radius)');

  /* 负对照:没有被召唤的 Boss ⇒ 一条几何都不发(不是「每只 boss 都有一圈」)。 */
  const idle = new WorldSim({ sizeCells: 12, mobs: false });
  eq(idle.bossHudSnapshots().length, 0, '负对照:没有 Boss 的世界产出 0 条线格式快照');
});

test('FND123-3 ★ 负对照:世界里没有 Boss ⇒ 线快照为空且投影计数为 0', () => {
  clearPartyRegistry();
  const c = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: freshRoomId('none'), ownerId: 'owner', clock: c.clock });
  const sim = new WorldSim({ sizeCells: 12, mobs: false });
  sim.addPlayer('p1', 3.5, 3.5);
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  rt.join({ userId: 'owner' });
  rt.step();
  rt.step();
  eq(rt.state.bosses.length, 0, '负对照:没有 Boss ⇒ state.bosses 保持空');
  eq(rt.bossProjectionCount, 0, '负对照:投影计数 0(不是「每帧都写一条空记录」)');
});

test('FND123-4 ★★ 清账与注入:离场即移除;摘掉两个 boss 读口 ⇒ 退回旧形态(空快照)', () => {
  const c = fixedClock(1_700_000_000_000);
  const gone = bossRoom(c.clock, 'gone');
  summonJellyKing(gone.sim);
  gone.rt.step();
  eq(gone.rt.state.bosses.length, 1, '前置:投影成功');

  gone.sim.bossRaid.despawn('boss_jelly_king');
  gone.rt.step();
  eq(gone.rt.state.bosses.length, 0, '★ 不在场的一律移除(否则客户端留一条打不动的血条)');

  /* 注入验证:**摘掉读口** ⇒ 一条都投不出来(`projectBosses` 直接 return)。 */
  const blank = bossRoom(c.clock, 'masked');
  summonJellyKing(blank.sim);
  blank.rt.worldSaveHost = maskHost(
    blank.sim as unknown as WorldSaveHost,
    ['bossSnapshots', 'bossHudSnapshots'],
  );
  blank.rt.step();
  eq(blank.rt.state.bosses.length, 0, '★ 摘掉 read 口 ⇒ 0 条(证明 FND123-1 读的是那口接线)');
  eq(blank.rt.bossProjectionCount, 0, '★ 摘掉 read 口 ⇒ 投影计数 0');
});
/* ══════════════ 2. 两套开局打通:P1-2 ══════════════ */

test('FND123-5 ★★ START_PARTY 路径:记账 + 赛局**同时**成立(修前只建记账)', () => {
  const { sim, rt } = arena({ mode: 1 });
  const setMode = rt.dispatchAction('owner', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.BRIDGE_CTF });
  ok(setMode.ok, '前置:已选模式');

  eq(sim.partyPhase(), 'IDLE', '前置:世界还没有赛局');
  const started = rt.dispatchAction('owner', RoomAction.START_PARTY, { partyMode: PartyMode.BRIDGE_CTF });
  ok(started.ok, '★ START_PARTY 成功');
  eq(partyStateOf(rt.id)?.state, PartyPhase.RUNNING, '★ 记账进入 RUNNING(修前这条本来就有)');
  ok(sim.partyPhase() !== 'IDLE',
    `★ 世界侧的赛局也开了(修前 partyPhase 恒 IDLE):${sim.partyPhase()}`);
  eq(sim.partyReferee(), 'owner', '裁判 = 发起人(唯一来源是世界,不由房间猜)');
  eq(rt.partyRecordStartCount, 1, '★「开赛局」这件事真的发生了一次');
});

test('FND123-6 ★★ 哨台路径:世界先开局 ⇒ 房间补建记账(修前 partyStateOf 恒 null)', () => {
  const { sim, rt } = arena({ mode: 1 });
  stepRoom(rt, 1);

  ok(sim.partyPhase() !== 'IDLE', `★ 哨台入口把赛局开起来了:${sim.partyPhase()}`);
  eq(sim.partyModeKey(), PartyMode.BRIDGE_CTF, '★ 世界报的是本局模式键');
  const snap = partyStateOf(rt.id);
  ok(snap !== null, '★ 记账被补建(修前恒 null ⇒ addScore 永不调用、HUD 恒 0)');
  eq(snap?.state, PartyPhase.RUNNING, '★ 记账处于 RUNNING(可以接受计分)');
  eq(rt.state.meta.partyMode, 1, '★ 哨台的模式命令落进 meta.partyMode(客户端据此显示模式名)');
  eq(rt.partyRecordAdoptCount, 1, '★「补建记账」只发生一次(锁存,不是每帧重开一局)');
  eq(rt.partyRecordSkips, 0, '没有跳过');
  /* 再推几帧:不许每帧重开(重开会把分数清零,而不报错)。 */
  stepRoom(rt, 2);
  eq(rt.partyRecordAdoptCount, 1, '★ 多帧之后仍然只补建一次');
  eq(sim.partyPhase(), 'BUILD', '赛局仍在本局(没有被重开成新局)');
});

test('FND123-7 ★ 负对照与计分通路:没人站哨台 ⇒ 不开局也不建账;有账之后 addScore 才成立', () => {
  const { sim, rt } = arena({ mode: 1, referee: false });
  sim.setPlayerPos('owner', 20.5, 20.5);
  stepRoom(rt, 2);
  eq(sim.partyPhase(), 'IDLE', '负对照:没人站哨台 ⇒ 世界不开局');
  eq(partyStateOf(rt.id), null, '负对照:也就没有记账(不发明一局)');
  eq(rt.partyRecordSkips, 0, '没有局 ≠ 跳过建账(两者可区分)');
  eq(addScore(rt.id, 'p1', 50).ok, false, '负对照:没有记账 ⇒ 计分被拒(修前的常态)');

  /* 正:同一房间有人站上哨台 ⇒ 记账 + 赛局一起成立,`addScore` 开始能记。 */
  sim.setPlayerPos('owner', 5.5, 5.5);
  stepRoom(rt, 1);
  ok(partyStateOf(rt.id) !== null, '★ 站上哨台 ⇒ 记账出现');
  const s = addScore(rt.id, 'p1', 50);
  eq(s.ok, true, '★ `addScore` 真的能记了(修前恒 false)');
  eq(s.total, 50, '总分 50');
});

test('FND123-8 ★★ HUD 与播报:比分进 meta.scoreA、开局播报经 `.bus.on` 到房间(修前 0 处)', () => {
  const { sim, rt } = arena({ mode: 1 });
  stepRoom(rt, 1);
  ok(partyStateOf(rt.id) !== null, '前置:记账已建');

  eq(rt.state.meta.scoreA, 0, '前置:红队 0 分');
  addScore(rt.id, 'p1', 40);
  rt.step();
  eq(rt.state.meta.scoreA, 40, '★ 比分进线快照(p1 站旗 ⇒ RED;客户端 partyHudOf 读它)');
  eq(rt.state.meta.partyTimer, 45, '★ 剩余秒数 = PARTY_MODES 的 15+30(不是 0)');

  ok(rt.partyBroadcastTotal > 0, `★ 房间从世界总线收到播报(${rt.partyBroadcastTotal} 条)`);
  includes(rt.partyBroadcasts().map((b) => b.kind), 'MODE_START', '★ 开局播报真的到了下发口');
  const drained = rt.drainPartyBroadcasts();
  ok(drained.length > 0, '★ 下发口可被取走(不是只写不读的队列)');
  eq(rt.partyBroadcasts().length, 0, '取走之后积压为空');

  /* 负对照:没有世界(host=null)⇒ 一条都收不到,不假装订阅。 */
  clearPartyRegistry();
  const c = fixedClock(1_700_000_000_000);
  const bare = new RoomRuntime({ roomId: freshRoomId('bare'), ownerId: 'owner', clock: c.clock });
  bare.join({ userId: 'owner' });
  bare.step();
  eq(bare.partyBroadcastTotal, 0, '负对照:没有世界 ⇒ 0 条播报');

  /* 注入验证:摘掉 `bus` ⇒ 同样 0 条(证明 FND123-8 读的就是那口订阅)。 */
  const { sim: sim2, rt: rt2 } = arena({ mode: 1 });
  rt2.worldSaveHost = maskHost(sim2 as unknown as WorldSaveHost, ['bus']);
  stepRoom(rt2, 2);
  ok(sim2.partyPhase() !== 'IDLE', '注入组的赛局照样在跑');
  eq(rt2.partyBroadcastTotal, 0, '★ 摘掉 bus ⇒ 0 条(退回「只 emit 无人接」的旧形态)');
});

/* ══════════════ 3. 结算幂等 + 归属:P1-3 / P1-6 ══════════════ */

/** 推到自然结算(45s = 90 慢帧;`rt.step()` 一次 = 一快帧)。 */
function runToSettlement(rt: RoomRuntime, sim: WorldSim): void {
  const maxSteps = 45 * FAST_PER_SLOW * 3;
  for (let i = 0; i < maxSteps && sim.partySettlement() === null; i += 1) rt.step();
}

test('FND123-9 ★★ 收局不二次发奖:自然结算后裁判按 -1 ⇒ 同一 settlement 只发一次', () => {
  const { sim, rt } = arena({ mode: 1, joinP1: true });
  stepRoom(rt, 1);
  ok(partyStateOf(rt.id) !== null, '前置:记账在');

  runToSettlement(rt, sim);
  ok(sim.partySettlement() !== null, '前置:自然结算已发生');
  eq(sim.partyRewardGrantCount, 1, '★ 自然结算发了一次奖');
  const expAfterSettle = sim.progressSnapshotOf('p1')?.totalExp ?? 0;
  ok(expAfterSettle > 0, `★ 奖励真的入账(totalExp=${expAfterSettle})`);

  /* 裁判按 -1 收局(修前这一步会把同一份 settlement 再发一遍)。 */
  const desk = [...sim.wiring.components.values()].find((x) => x.kind === 'ARENA_REFEREE_DESK');
  ok(desk !== undefined, '前置:哨台在');
  desk!.params.mode = -1;
  stepRoom(rt, 1);
  eq(sim.partyPhase(), 'IDLE', '★ 收局生效');
  eq(sim.partyRewardGrantCount, 1, '★ 同一 settlement **没有**被二次发放(修前此处是 2)');
  eq(sim.progressSnapshotOf('p1')?.totalExp ?? 0, expAfterSettle, '★ 经验没有翻倍');
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED, '★ 记账被 endParty 收束(修前 endParty 零生产调用)');
  eq(rt.partyRecordEndCount, 1, '★ endParty 真的被调了一次');

  /* 再收一次:不重复扣/发(幂等)。 */
  rt.step();
  eq(sim.partyRewardGrantCount, 1, '重复收局不再发奖');
  eq(rt.partyRecordEndCount, 1, '重复收局不再结算记账');
});

test('FND123-10 ★ 反注入:没有自然结算时,收局自己就是**唯一**结算 ⇒ 仍要发一次(不过度修)', () => {
  const { sim, rt } = arena({ mode: 1, joinP1: true });
  stepRoom(rt, 1);
  ok(sim.partyPhase() !== 'IDLE', '前置:赛局在跑');
  eq(sim.partyRewardGrantCount, 0, '前置:还没结算');

  sim.clearPartyRun();
  eq(sim.partyRewardGrantCount, 1, '★ 收局自己结算并发了**一次**奖(没有把奖励整份丢掉)');
  sim.clearPartyRun();
  eq(sim.partyRewardGrantCount, 1, '★ 再收一次不重复发');
  eq(sim.partyPhase(), 'IDLE', '相位回 IDLE');
  /* 记账侧:世界回 IDLE ⇒ 房间 endParty。 */
  rt.step();
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED, '★ 记账随之收束');
});

test('FND123-11 ★★ 奖励归属:settleRace 的 4 行 `team/playerId=null` 按名次表补全(修前静默不发)', () => {
  const { sim } = arena({ mode: 1, joinP1: true });
  tickSlow(sim, 1);
  eq(sim.partyTeamOf('p1'), 'RED', '前置:p1 站 435 旗 ⇒ RED(归属的唯一来源)');

  /* 真结算对象:`party/modes.ts#settleRace` 产出的 4 行 rewards 全是 null 归属。 */
  const manual = createManualClock(0);
  const run = createRaceRun(manual, 'owner', 90);
  openGate(run, 0, ['p1', 'ref']);
  finishRunner(run, 'p1', 10);
  finishRunner(run, 'ref', 12);
  const st = settleRace(run);
  eq(st.rewards.length, 4, '前置:四行团队奖励');
  eq(st.rewards.every((r) => r.team === null && r.playerId === null), true,
    '前置:四行的 team/playerId **全为 null**(这正是缺陷输入)');

  sim.grantPartyRewards(st);
  eq(sim.partyRewardUnattributed, 0, '★ 归属不明的行数 = 0(按 `settlement.standing` 的名次补上了)');
  ok((sim.progressSnapshotOf('p1')?.totalExp ?? 0) > 0,
    '★ 冠军名次(RED)真的把经验发出去了(修前 targets=[] 一分不发)');

  /* 负对照:结算表里没有该名次 ⇒ 仍是「归属不明」,且不发经验。 */
  const orphan: PartySettlement = {
    mode: 'BRIDGE_CTF',
    modeName: '手工局',
    elapsedSec: 0,
    standing: [],
    rewards: [rewardForRank(1)],
    personal: [],
    personalRewards: [],
    broadcastText: '手工局结束',
  };
  const { sim: sim2 } = arena({ mode: 1, joinP1: true });
  tickSlow(sim2, 1);
  sim2.grantPartyRewards(orphan);
  eq(sim2.partyRewardUnattributed, 1, '负对照:名次表为空 ⇒ 记 1 行「归属不明」(不猜)');
  eq(sim2.progressSnapshotOf('p1')?.totalExp ?? 0, 0, '负对照:没有归属就一分不发');
});

/* ══════════════ 4. 回执出口:P1-4 / P1-5 ══════════════ */

test('FND123-12 ★ 回执带比分播报/终场文案(客户端 inlinePayload 可直接渲染)', () => {
  const { sim, rt } = arena({ mode: 1 });
  stepRoom(rt, 1);
  ok(rt.partyBroadcastTotal > 0, '前置:已收到播报');

  const r = rt.dispatchAction('owner', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.BRIDGE_CTF });
  ok(r.ok, '前置:动作成功');
  const text = r.effect?.partyBroadcast;
  ok(typeof text === 'string' && text.length > 0, '★ 回执里带上了最新播报文案');
  eq(r.effect?.partyBroadcastTotal, rt.partyBroadcastTotal, '★ 条数一致(可供客户端判重)');

  /* 指纹:同一份数据不会在**下一条**回执里重复出现。 */
  const r2 = rt.dispatchAction('owner', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.BRIDGE_CTF });
  ok(r2.ok, '前置:第二个动作成功');
  eq(r2.effect?.partyBroadcast, undefined, '★ 没有新播报 ⇒ 不加这个键(回执形状不漂)');
  ok(sim.partyPhase() !== 'IDLE', '世界侧无关状态不变');
});

test('FND123-13 ★★ RUSH_GRADE 出进程:成功回执的 `effect.rushGrade`;摘掉读口则无此键', () => {
  const c = fixedClock(1_700_000_000_000);
  /* 只实现回执需要的那几口(其余全缺)—— 证明房间对「能力缺失」是显式降级。 */
  const rushOnly: Partial<WorldSaveHost> = {
    rushSettlement: () => ({ grade: 'A', score: 173 }),
  };
  clearPartyRegistry();
  const rt = new RoomRuntime({ roomId: freshRoomId('rush'), ownerId: 'owner', clock: c.clock });
  rt.worldSaveHost = rushOnly as unknown as WorldSaveHost;
  ok(rt.join({ userId: 'owner' }).ok, '前置:进场');

  const r = rt.dispatchAction('owner', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.BRIDGE_CTF });
  ok(r.ok, '前置:动作成功');
  eq(r.effect?.rushGrade, 'A', '★ 评级出了进程(修前 `rushSettlement()` 除测试外零引用)');
  eq(r.effect?.rushScore, 173, '★ 分数一起下发');

  const r2 = rt.dispatchAction('owner', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.BRIDGE_CTF });
  eq(r2.effect?.rushGrade, undefined, '★ 同一评级不在下一条回执里重复');

  /* 注入验证:摘掉 `rushSettlement` ⇒ 没有这个键(退回旧形态)。 */
  clearPartyRegistry();
  const bare = new RoomRuntime({ roomId: freshRoomId('rushnone'), ownerId: 'owner', clock: c.clock });
  bare.worldSaveHost = {} as unknown as WorldSaveHost;
  bare.join({ userId: 'owner' });
  const r3 = bare.dispatchAction('owner', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.BRIDGE_CTF });
  ok(r3.ok, '前置:动作成功');
  eq(r3.effect?.rushGrade, undefined, '★ 摘掉读口 ⇒ 回执里没有 rushGrade(不发明评级)');
});

report('WS-FND-123');