/**
 * WS-FND-127 —— 三条**零判据的生产路径**(第七轮实测 P1)
 *
 * ## 这个套件钉的三件事(每条都是「有实现、生产里在跑、但没人断言」)
 *
 * | # | 生产路径 | 修前状态 | 本套件的判据 | 负对照 |
 * |---|---------|---------|-------------|--------|
 * | 1 | `RoomRuntime.syncPartyHud()`(`net/room.ts`:写 `meta.partyTimer/scoreA/scoreB`;两个生产写点 = 每帧的 `step()` 与 `SET_PARTY_MODE` 的「同一帧对齐」) | 三个字段**零判据**:`tests/WS-07` 甚至断言它们「从无代码驱动」(第七轮实测已翻面) | FND127-1..4:喂一局 ⇒ 三字段按**权威值**出现;无赛局 ⇒ 全 0;三字段各自夹到值域 | 没开局 / 没站过 435 旗(分不出红蓝)⇒ 如实 0 |
 * | 2 | `CarrySystem.tick()`(`physics/carry.ts`,世界慢帧调用) | 冷却表**永不递减**这类回归无人能发现(表是 private,从外面看不见) | FND127-5:推进时间 ⇒ 冷却到 0 ⇒ 能再举再投 | 不推进时间 ⇒ 仍不可投 |
 * | 3 | `syncFoodFriction()` 的 μ 通道(`sim/world_sim.ts`,慢帧「只推不算」) | 只测了接收端(`PhysicsWorld.setMuMul`) | FND127-6:吃滑溜料理 → 运行帧 → 读回乘子 | 吃**不带** μ 通道的料理 ⇒ 乘子仍 1 |
 *
 * ## 判据纪律
 *
 * 1 **走生产装配**:房间侧一律 `assemble()`(不经手写 host),世界侧一律 `WorldSim`
 *    的真慢帧 —— 否则测的是「我自己手装的那份」,本仓已记 9 例这种假绿。
 * 2 **不直接调被测私有函数**:`syncPartyHud` 是 private,本套件只从**它的生产写点**
 *    间接驱动(`SET_PARTY_MODE`,见 `syncHud()` 的注释);手写快照或反射调用会变成
 *    「测我自己写的那一份」。
 * 3 **期望值写字面量**,实现常量只放 actual 一侧当锚(`eq(MAX_PARTY_TIMER_SEC, 86400)`)。
 * 4 每条正判据配负对照:同一世界、同一帧、**只改一个输入**(开局 / 旗帜 / 时间 / 料理)。
 *
 * 运行:`node tests/WS-FND-127-coverage-gaps.test.ts`
 */

import { eq, near, ok, report, test, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { MAX_PARTY_TIMER_SEC, RoomAction } from '../server/src/net/room.ts';
import {
  addScore,
  clearPartyRegistry,
  endParty,
  partyStateOf,
  resetPartyClock,
  setPartyClock,
} from '../server/src/net/actions/start_party.ts';
import { PartyMode } from '../server/src/db/repo.ts';
import { PARTY_MODES } from '../shared/constants/bosses.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';
import { CarryReject } from '../server/src/physics/carry.ts';
import { makeComponent } from '../server/src/wiring/components.ts';

/* ═════════════════════════ 基础设施 ═════════════════════════ */

/** 跑 `n` 个**慢帧**(2Hz)⇒ `n × FAST_PER_SLOW` 次 `tick()`。 */
function tickSlow(sim: WorldSim, n = 1): void {
  for (let i = 0; i < n * FAST_PER_SLOW; i += 1) sim.tick();
}

/** 写死的时间原点(墙钟)。★ WS-FND-174 起 HUD 的剩余读**世界钟** ⇒ 墙钟只用于
    「墙钟不再参与」那两条负对照。 */
const T0 = 1_700_000_000_000;
/** 435 复活旗(队伍归属的唯一来源)。 */
const BANNER_ITEM = 435;

let seq = 0;

interface HudRoom {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: WorldSim;
  roomId: string;
  /** 推**房间墙钟**(★ WS-FND-174 起它不再参与 HUD 的倒计时;负对照用)。 */
  setNow: (ms: number) => void;
}

type Meta = { meta: { partyMode: number; partyTimer: number; scoreA: number; scoreB: number } };

/** 读快照里的房间级 meta(`cloneState()` 是纯数据快照 ⇒ 读的是真正要下发的值)。 */
function metaOf(r: HudRoom): Meta['meta'] {
  return (r.rt.cloneState() as unknown as Meta).meta;
}

/**
 * 触发一次 HUD 同步 —— 走 `SET_PARTY_MODE` 那条**生产写点**
 * (`room.ts#setPartyModeBy` → `syncPartyHud`,与 `step()` 每帧调的是**同一个函数**)。
 *
 * ⚠️ 三个「不是」:
 *   · 不直接调 `syncPartyHud`(private,反射调用测不到「谁在驱动它」);
 *   · 不手写 `state.meta`(那就变成"测我自己写的那份");
 *   · 也不用 `rt.step()` 作为唯一驱动 —— 它同时推进世界/反作弊/落盘,判据会连带
 *     别的子系统;而这条写点本来就是为「不必等下一帧」而存在的。
 * 模式传**与本局相同**的那个:赛局记录的模式开局即定格,改它不会改记分口径。
 */
function syncHud(r: HudRoom): void {
  ok(r.rt.setPartyModeBy('p1', PartyMode.BRIDGE_CTF).ok, 'HUD 同步:SET_PARTY_MODE 成功');
}

/**
 * 房间夹具:**真装配**(`assemble`)⇒ 世界源 = `WorldSim`,房间侧 = `RoomRuntime`。
 *
 * 两名玩家 p1 / p2,可选手上 435 旗:旗的 `params.team` 决定队伍
 * (0 = RED、1 = BLUE —— 顺序来自 `party/scoring.ts` 的 `TEAM_ORDER`)。
 * ⚠️ 队伍**不是**按加入顺序编的:唯一来源是旗(`world_sim.ts#scanPartyTeams`)。
 */
function hudRoom(opts: { banners?: boolean } = {}): HudRoom {
  seq += 1;
  const roomId = `r_fnd127_hud${seq}`;
  let now = T0;
  clearPartyRegistry();
  setPartyClock(() => now);
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => now },
    sizeCells: 24, mobs: false, rng: mulberry32(127 + seq),
  });
  const sim = a.host as unknown as WorldSim;
  a.runtime.join({ userId: 'p1' });
  a.runtime.join({ userId: 'p2' });
  if (opts.banners !== false) {
    sim.wiring.addComponent(makeComponent('bnr_red', BANNER_ITEM, 8, 5, { params: { team: 0 } }));
    sim.wiring.addComponent(makeComponent('bnr_blue', BANNER_ITEM, 12, 5, { params: { team: 1 } }));
  }
  sim.addPlayer('p1', 8.5, 5.5);
  sim.addPlayer('p2', 12.5, 5.5);
  /* 慢帧扫旗 ⇒ 队伍进 `partyTeams`(拾冠 / 比分都读这一张表)。 */
  tickSlow(sim, 1);
  return { rt: a.runtime, sim, roomId, setNow: (ms) => { now = ms; } };
}

/** 选模式 + 开局(两步是 `START_PARTY` 的前置:它**不设**模式)。 */
function startParty(r: HudRoom): void {
  eq(r.rt.dispatchAction('p1', RoomAction.SET_PARTY_MODE, { partyMode: 'BRIDGE_CTF' }).ok,
    true, '前置:SET_PARTY_MODE 成功');
  eq(r.rt.dispatchAction('p1', RoomAction.START_PARTY, {}).ok, true, '前置:START_PARTY 成功');
}

/* ═════════════ 1. `RoomRuntime.syncPartyHud()`(三个字段的唯一写口)═════════════ */

test('FND127-1 ★ 无赛局 ⇒ 三字段**如实**全 0(不是"没有写点",也不是"残留上一局")', () => {
  const r = hudRoom();
  const before = metaOf(r);
  eq([before.partyTimer, before.scoreA, before.scoreB], [0, 0, 0], '没开局 ⇒ 三字段 0');

  /* 选模式会**立刻**同步一次 HUD —— 但房间没有赛局记录 ⇒ 仍如实写 0(分支 1)。 */
  eq(r.rt.dispatchAction('p1', RoomAction.SET_PARTY_MODE, { partyMode: 'BRIDGE_CTF' }).ok,
    true, '前置:选模式成功');
  syncHud(r);
  const after = metaOf(r);
  eq([after.partyTimer, after.scoreA, after.scoreB], [0, 0, 0],
    '★ 只选了模式、没开局 ⇒ 仍全 0(选了模式不等于开了一局)');

  /* 负对照的一半:此刻计分**被拒** ⇒ 上面的 0 不是因为"分被吞了"。 */
  const s = addScore(r.roomId, 'p1', 5);
  eq(s.ok, false, '负对照:没开局 ⇒ addScore 被拒(0 分是真的没有局,不是分丢了)');
  eq(partyStateOf(r.roomId), null, '`partyStateOf` = null(从没开过局,不是"0 分的空局")');
});

test('FND127-2 ★★ 喂一局 ⇒ partyTimer/scoreA/scoreB 按**权威值**出现在快照里', () => {
  const r = hudRoom();
  eq(r.sim.partyTeamOf('p1'), 'RED', '前置:p1 站在 435 红旗下 ⇒ RED');
  eq(r.sim.partyTeamOf('p2'), 'BLUE', '前置:p2 站在 435 蓝旗下 ⇒ BLUE');
  startParty(r);

  /* 权威值 1:计时 = 模式总时长(`buildSec + raceSec`,冻结层 PARTY_MODES) */
  const cfg = PARTY_MODES.find((m) => m.key === 'BRIDGE_CTF');
  ok(cfg !== undefined, '锚:BRIDGE_CTF 在冻结层 PARTY_MODES 里');
  eq(cfg!.buildSec + cfg!.raceSec, 45, '锚:造桥赛总时长 15 + 30 = 45s(字面量)');

  /* 权威值 2:比分来自赛局记录的 `addScore`,队伍归属问世界(435 旗) */
  eq(addScore(r.roomId, 'p1', 4).ok, true, '前置:红队玩家得 4 分');
  eq(addScore(r.roomId, 'p2', 6).ok, true, '前置:蓝队玩家得 6 分');

  syncHud(r);
  const m = metaOf(r);
  eq(m.partyTimer, 45, '★ 剩余 45s = 模式总时长(开局 elapsed 0)');
  eq(m.scoreA, 4, '★ 红队比分 4 = p1 的分数(按旗的队伍归属,不按加入顺序)');
  eq(m.scoreB, 6, '★ 蓝队比分 6 = p2 的分数');


  /* ★ WS-FND-174(**陈旧断言已翻面**):HUD 的剩余现在与世界钟同源 ⇒ 要让它递减,
     必须推进**世界钟**(`sim.advance`,一帧 = 一快帧),而不是房间墙钟。
     10.4 世界秒 ⇒ 45 − quant(10.4) = 45 − 10 = 35(与判定用的同一个数)。 */
  r.sim.advance(10.4 * 20);
  syncHud(r);
  eq(metaOf(r).partyTimer, 35, '★ 世界钟推进 10.4s ⇒ 剩余递减到 35(与判定同源)');
  /* 负对照(同一条判据的另一半):墙钟推进同样的 10.4 秒,**一分不动** ——
     修前的漂移(HUD 比世界早 20% 归零)正是从这一行来的。 */
  r.setNow(T0 + 10_400);
  syncHud(r);
  eq(metaOf(r).partyTimer, 35, '★ 墙钟推进不改变剩余(墙钟不再参与 HUD)');

  /* 分支 2:结算后剩余归 0,但**比分保留**(名次已定格,清掉会让 HUD 闪成 0:0) */
  ok(endParty(r.roomId) !== null, '前置:结算成功');
  syncHud(r);
  const settled = metaOf(r);
  eq(settled.partyTimer, 0, '★ SETTLED ⇒ 剩余秒数归 0');
  eq([settled.scoreA, settled.scoreB], [4, 6], '★ 但比分**保留**(结算不清榜)');
  resetPartyClock();
});

test('FND127-3 ★ 三个字段各自被夹到值域(不负 / 不溢出)', () => {
  const r = hudRoom();
  startParty(r);

  /* 1 比分:U16 上界。1e6 分的累加是合法的(记录是 `number`),但线上字段不是。 */
  eq(addScore(r.roomId, 'p1', 1_000_000).ok, true, '前置:记一笔远超 U16 的分');
  syncHud(r);
  eq(metaOf(r).scoreA, 65535, '★ 比分夹到 U16 上界 65535(否则编码器写垃圾且不报错)');

  /* 2 计时:上界(★ WS-FND-174 起时基是**世界钟**)。世界钟只会前进 ⇒ 剩余不会超过
     总时长(`Math.min(totalSec, ...)` 那一层)。这里用**墙钟回拨**做负对照:
     墙钟已经不再参与 HUD ⇒ 回拨 24 小时对它毫无影响(修前它会靠在
     `Math.max(0, ...)` 上停在 45)。`MAX_PARTY_TIMER_SEC` 那层今天仍**不可达**
     (PARTY_MODES 最长 180s < 86400)⇒ 断言实际值 45,不假设是哪层钳住的。 */
  eq(MAX_PARTY_TIMER_SEC, 86400, '锚:计时上限 24h = 86400s');
  r.setNow(T0 - 90_000_000);
  syncHud(r);
  eq(metaOf(r).partyTimer, 45, '★ 墙钟回拨 ⇒ 剩余照旧停在总时长 45(墙钟不参与,不是「钳住了」)');

  /* 3 计时:下界。**世界钟**走过总时长 ⇒ 剩余为负 ⇒ 夹到 0(不写负数)。 */
  r.sim.advance(45 * 20 + 200);
  syncHud(r);
  const m = metaOf(r);
  eq(m.partyTimer, 0, '★ 世界钟走过 45s ⇒ 夹到 0(绝不写负数)');
  ok(m.partyTimer >= 0 && m.partyTimer <= MAX_PARTY_TIMER_SEC,
    `值域:[0, ${MAX_PARTY_TIMER_SEC}](实测 ${m.partyTimer})`);
  resetPartyClock();
});

test('FND127-4 负对照:没有 435 旗 ⇒ 分不出红蓝 ⇒ 比分 0(但计时照常)', () => {
  const r = hudRoom({ banners: false });
  eq(r.sim.partyTeamOf('p1'), null, '前置:没站过旗 ⇒ 没有队伍');
  startParty(r);
  eq(addScore(r.roomId, 'p1', 4).ok, true, '前置:分数记进了赛局记录');
  syncHud(r);
  const m = metaOf(r);
  eq(m.partyTimer, 45, '★ 计时**照常**(它不依赖世界)');
  eq([m.scoreA, m.scoreB], [0, 0],
    '★ 比分 0:世界没有队伍归属 ⇒ 不按"加入顺序"编一个队(编出来的表现是比分记在别人头上)');
  resetPartyClock();
});

/* ═════════════ 2. `CarrySystem.tick()`(世界慢帧的投掷冷却)═════════════ */

test('FND127-5 ★★ 投掷冷却真的会过期:推进时间 ⇒ 能再举再投;不推进 ⇒ 仍不可投', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 8.5, 8.5);
  sim.addPlayer('p2', 8.5, 8.5);

  /* 把某人放回地面同一格(只改"位置"这一个输入,时间不动)。 */
  const placeAt = (id: string, x: number, y: number): void => {
    const b = sim.physics.bodies.get(id);
    ok(b !== undefined, `前置:${id} 有刚体`);
    b!.x = x; b!.y = y; b!.z = 0;
    b!.vx = 0; b!.vy = 0; b!.vz = 0;
  };

  eq(sim.carry.tryLift('p1', 'p2'), CarryReject.OK, '前置:举起成功');
  ok(sim.carry.throwTop('p1', 1, 0) !== null, '前置:投出成功');
  eq(sim.carry.isOnCooldown('p1'), true, '投掷后有冷却(0.35s)');

  /* 负对照:同一几何、同一帧,**只差"时间没推进"** ⇒ 冷却挡住再举。
     `carry.ts:208` 用 `NOT_GROUNDED` 表示「冷却中」—— 这是它的既有取值,不是本次发明的。 */
  placeAt('p2', 8.5, 8.5);
  eq(sim.carry.tryLift('p1', 'p2'), CarryReject.NOT_GROUNDED,
    '★ 不推进时间 ⇒ 冷却仍在 ⇒ 再举被拒("冷却永不过期"就是这个形态)');

  /* 推进一个慢帧 = 0.5s ≥ 0.35s ⇒ 冷却递减到 0(漏掉 `carry.tick` ⇒ 这里永远 true) */
  tickSlow(sim, 1);
  eq(sim.carry.isOnCooldown('p1'), false,
    '★ 慢帧推进 0.5s ⇒ 冷却到 0(生产调用点:`world_sim.ts` 慢帧的 `carry.tick(SIM_SLOW_DT)`)');

  placeAt('p2', 8.5, 8.5);
  eq(sim.carry.tryLift('p1', 'p2'), CarryReject.OK, '★ 冷却到 0 ⇒ 可以再举');
  ok(sim.carry.throwTop('p1', 1, 0) !== null, '★ 因此可以再投(修前形态:一次之后再不能投)');
  eq(sim.carry.stats().throws, 2, '投掷计数 = 2');
});

/* ═════════════ 3. `syncFoodFriction()` 的 μ 通道(端到端)═════════════ */

test('FND127-6 ★★ 吃滑溜料理 ⇒ 运行帧 ⇒ 读回 μ 乘子(只推不算的那一半)', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 8.5, 8.5);
  near(sim.physics.muMulOf('p1'), 1, 1e-12, '前置:没有 buff ⇒ 乘子 = 中性值 1');

  eq(sim.useItem('p1', { itemId: 610 }).applied, true, '前置:610 滑溜料理吃得下');
  near(sim.physics.muMulOf('p1'), 1, 1e-12,
    '★ 吃下去**不当帧**推物理:乘区只在 PhysicsWorld 结算,`syncFoodFriction` 只推乘子(慢帧)');

  tickSlow(sim, 1);
  near(sim.physics.muMulOf('p1'), 0.96, 1e-12,
    '★ 运行一慢帧 ⇒ 乘子 0.96 落进物理层(吃 → 跑帧 → 读回,端到端)');

  /* 负对照:同一路径、同一帧数,吃**不带** μ 通道的料理 ⇒ 乘子仍是中性值 1。
     (buff 的中性值是 0 = "没意见",乘子的中性值是 1 —— 两者不同,不许混。) */
  const other = new WorldSim({ sizeCells: 24, mobs: false });
  other.addPlayer('p1', 8.5, 8.5);
  eq(other.useItem('p1', { itemId: 613 }).applied, true, '前置:613(不带 μ 通道)吃得下');
  tickSlow(other, 1);
  near(other.physics.muMulOf('p1'), 1, 1e-12,
    '负对照:没有 muOverride 的料理 ⇒ 乘子仍 1(不会被写成 0)');
});

report('WS-FND-127');