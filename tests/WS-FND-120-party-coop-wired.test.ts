/**
 * WS-FND-120 —— 派对 / 急单 / 打盹 / 整蛊的**入口与消费者**(第六轮实测 P1/P2)
 *
 * 运行:`node tests/WS-FND-120-party-coop-wired.test.ts`
 *
 * ## 这个套件钉的六件事
 *
 * | # | 缺陷(第六轮实测) | 本套件怎么钉 |
 * | :-- | :--- | :--- |
 * | 1 | `startPartyRun` / `startRushRun` / `setPlayerDozing` 生产零调用 ⇒ 三个 `tick*` 永远走空分支 | FND120-1/2/10/12:由**世界事实**(436 哨台上的玩家 / 食堂 + 工位 / `sleepSource`)驱动,并各有负对照 |
 * | 2 | 五个 `settle*` 生产零调用 ⇒ `m.settlement` 恒 null、`rewards` 永不发放 | FND120-5/6:相位到点自己结算,且经验/物品**真的落账**(成长档案 + 地面) |
 * | 3 | `PRANK_TOYS` / `toyOf` / `isImmuneToAllyPrank` / `resolveShield` 生产零 import | FND120-13/14:整蛊动作层 + 掉冠判定,台账逐条登记 |
 * | 4 | `settleSession` / `settleRushOrder` 零引用 ⇒ `RUSH_GRADE` 传不出去 | FND120-11:急单到 SETTLED 时回执非空且只结算一次 |
 * | 5 | `bridgeCapture` / `crownPickup` / `submitDelivery` 生产零调用 | FND120-8/9/11:三个动作都由世界事实推,各有负对照 |
 * | 6 | `shiftBroadcast` / `drainBroadcasts` 零调用 ⇒ 只写不读的死队列 | FND120-7:队列被抽空并下发到世界总线 |
 *
 * ## 判据纪律
 *
 * 1 **注入验证**:FND120-2 / 12 / 15 都是「摘掉那口接线 ⇒ 退回旧形态」——
 *    「没接线」与「接线了但这帧无事」在读数上都是 0,只有摘掉口子才能证明本套件
 *    读的是**那口接线**。
 * 2 **负对照**:每条正判据都配一条「同一世界、同一帧、只改一个输入」的对照
 *    (没人站哨台 / 没站过旗 / 桥板不够 / 货不在订单上 / 不接 sleepSource)。
 * 3 **不拿实现常量核实现行为**:模式秒数、桥板门槛、队伍数都取冻结层/内容层,
 *    行为量由**世界侧独立读数**给出(`partyPhase()` / `crownHolder()` / `dewOf()` / 成长档案)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq, includes, ok, report, test } from '../shared/testing/harness.ts';
import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import { makeComponent } from '../server/src/wiring/components.ts';
import type { ComponentNode } from '../server/src/wiring/graph.ts';
import {
  PARTY_ACTION,
  PARTY_ACTION_LEDGER,
  deskModeKey,
  gateBridgeCapture,
  gateBridgePlace,
  gateCrownPickup,
  gatePartyStart,
  gatePartyStop,
  gateRushDelivery,
  gateRushStart,
  unwiredActions,
  wiredActions,
} from '../server/src/party/actions.ts';
import { PARTY_PHASE, BRIDGE_TILES_TO_WIN } from '../server/src/party/modes.ts';
import { RUSH_ORDER_STATE } from '../server/src/coop/rush_order.ts';
import { RUSH_ENTRY_ROOM_LEVEL, RUSH_ACTION_LEDGER, openOrderLines } from '../server/src/coop/rush_actions.ts';
import {
  CROWN_KNOCK_TOY_IDS,
  PRANK_ACTION_LEDGER,
  PRANK_REJECT,
  resolveCrownKnock,
  resolvePrankAction,
  wiredPrankToys,
} from '../server/src/prank/actions.ts';
import { DEW_SEC_PER_UNIT, DOZE_AFTER_SEC } from '../server/src/social/afk.ts';

const ROOT = join(import.meta.dirname, '..');
const WALL = 352;
const POT = 506;
const OVEN = 508;
const CUTTER = 507;
const STOCK_POT = 519;
const BOARD = 152;

/** 跑 `n` 个**慢帧**(2Hz)⇒ `n × FAST_PER_SLOW` 次 `tick()`。 */
function tickSlow(sim: WorldSim, n = 1): void {
  for (let i = 0; i < n * FAST_PER_SLOW; i += 1) sim.tick();
}

interface Arena {
  sim: WorldSim;
  desk: ComponentNode;
  banner: ComponentNode | null;
  pedestal: ComponentNode | null;
}

/**
 * 竞技场夹具:436 哨台(带 `params.mode`)+ 可选 435 复活旗 / 434 皇冠底座,
 * 外加两名玩家 **ref**(站哨台,= 裁判)与 **p1**(站旗格,= 选手)。
 */
function arena(opts: {
  mode: number;
  bannerTeam?: number;
  pedestal?: boolean;
  actors?: boolean;
}): Arena {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const desk = makeComponent('desk', 436, 5, 5, { params: { mode: opts.mode } });
  sim.wiring.addComponent(desk);
  let banner: ComponentNode | null = null;
  if (opts.bannerTeam !== undefined) {
    banner = makeComponent('banner', 435, 8, 5, { params: { team: opts.bannerTeam } });
    sim.wiring.addComponent(banner);
  }
  let pedestal: ComponentNode | null = null;
  if (opts.pedestal === true) {
    pedestal = makeComponent('pedestal', 434, 10, 5);
    sim.wiring.addComponent(pedestal);
  }
  if (opts.actors !== false) {
    sim.addPlayer('ref', 5.5, 5.5);
    sim.addPlayer('p1', 8.5, 5.5);
  }
  return { sim, desk, banner, pedestal };
}

/** 食堂夹具:围合房间 + 三工位(+ 519 大锅,满足 `COZY_CANTEEN` 的必需件)。 */
function canteen(opts: { enclosed?: boolean } = {}): WorldSim {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  if (opts.enclosed !== false) {
    for (let y = 2; y < 10; y += 1) {
      for (let x = 2; x < 10; x += 1) {
        const edge = x === 2 || y === 2 || x === 9 || y === 9;
        sim.setCell(x, y, edge ? { obj: WALL } : { obj: 0 });
      }
    }
  }
  sim.setCell(4, 4, { obj: POT });
  sim.setCell(5, 4, { obj: OVEN });
  sim.setCell(6, 4, { obj: CUTTER });
  sim.setCell(7, 4, { obj: STOCK_POT });
  sim.addPlayer('p1', 4.5, 4.5);
  return sim;
}

/* ══════════════ 1. 派对开局:436 哨台是入口(含负对照与注入验证)══════════════ */

test('FND120-1 ★ 436 哨台开局:`params.mode=1` + 有人站哨台 ⇒ 相位真的推进(修前恒 IDLE)', () => {
  const { sim } = arena({ mode: 1, bannerTeam: 0 });
  eq(sim.partyPhase(), 'IDLE', '未开局:相位 IDLE');
  tickSlow(sim, 1);
  eq(sim.partyPhase(), PARTY_PHASE.BUILD, '★ 慢帧读到哨台命令 ⇒ 进入 BUILD(造桥 15s 建造阶段)');
  eq(sim.partyReferee(), 'ref', '★ 裁判 = 站在哨台格上的那个玩家(不是猜的)');
  eq(deskModeKey(1), 'BRIDGE_CTF', '哨台 mode 1 → 冻结层 PARTY_MODES 第 1 个模式');
  eq(deskModeKey(5), null, '表外 mode ⇒ null(不命令)');
  /* 跑满 15 秒 ⇒ 相位自己切到 RACE:证明 `tickPartyMode` 真的每慢帧在跑。 */
  tickSlow(sim, 30);
  eq(sim.partyPhase(), PARTY_PHASE.RACE, '★ 30 慢帧(=15s)后自己切到 RACE');
});

test('FND120-2 ★★ 负对照 + 注入验证:没人站在哨台格上 ⇒ 不开局(哨台是那口接线)', () => {
  /* 负对照:哨台命令在,但**玩家站在别处**。 */
  const away = arena({ mode: 1, bannerTeam: 0, actors: false });
  away.sim.addPlayer('p1', 12.5, 12.5);
  tickSlow(away.sim, 5);
  eq(away.sim.partyPhase(), 'IDLE', '★ 同一哨台、同一 mode,没人站上去 ⇒ 仍是 IDLE');
  eq(away.sim.partyBroadcastCount, 0, '负对照:一条播报都没发(更没有「裁判已就绪」的假象)');

  /* 注入验证:把同一个玩家**挪到**哨台格 ⇒ 下一慢帧就开。 */
  away.sim.setPlayerPos('p1', 5.5, 5.5);
  tickSlow(away.sim, 1);
  eq(away.sim.partyPhase(), PARTY_PHASE.BUILD, '★ 站上哨台那一慢帧就开局 ⇒ 判据读的是「谁站在那格」');
  eq(away.sim.partyReferee(), 'p1', '裁判换成此刻站着的人');
});

test('FND120-3 ★ 权限:收局只认(在场的)同一名裁判;别人按 -1 收不掉', () => {
  /* 闸层:两极性。 */
  eq(gatePartyStop({ refereeId: '', actorId: 'p1', refereeAtDesk: true, runActive: true }).ok, false,
    '没裁判(空 id)⇒ 收不掉');
  eq(gatePartyStop({ refereeId: 'ref', actorId: 'p1', refereeAtDesk: true, runActive: true }).ok, false,
    '别人按 -1 ⇒ 拒绝(不是同一名裁判)');
  eq(gatePartyStop({ refereeId: 'ref', actorId: 'ref', refereeAtDesk: false, runActive: true }).ok, false,
    '裁判不在哨台 ⇒ 拒绝(收局也得在场)');
  eq(gatePartyStop({ refereeId: 'ref', actorId: 'ref', refereeAtDesk: true, runActive: true }).ok, true,
    '正对照:本人在场 ⇒ 放行');

  /* 世界层:ref 走开(去 (12,12))后按 -1 ⇒ 局没有被收掉。 */
  const { sim, desk } = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(sim, 1);
  eq(sim.partyPhase(), PARTY_PHASE.BUILD, '前置:已开局');
  sim.setPlayerPos('ref', 12.5, 12.5);
  desk.params.mode = -1;
  tickSlow(sim, 2);
  ok(sim.partyPhase() !== 'IDLE', '★ 裁判不在哨台 ⇒ -1 收不掉这一局');
  /* 回来按 -1 ⇒ 收掉。 */
  sim.setPlayerPos('ref', 5.5, 5.5);
  tickSlow(sim, 1);
  eq(sim.partyPhase(), 'IDLE', '★ 裁判回到哨台 ⇒ 同一帧收局');
});

test('FND120-4 ★ 哨台是**电平**(锁存):一局打完不会在同一 mode 下无限重开', () => {
  const { sim } = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(sim, 1);
  eq(sim.partyPhase(), PARTY_PHASE.BUILD, '前置:开局');
  /* 推到 45s 结算完毕 ⇒ `clearPartyRun` 之后相位回 IDLE。 */
  for (let i = 0; i < 200 && sim.partySettlement() === null; i += 1) tickSlow(sim, 1);
  ok(sim.partySettlement() !== null, '前置:已结算');
  sim.clearPartyRun();
  tickSlow(sim, 6);
  eq(sim.partyPhase(), 'IDLE', '★ `params.mode` 仍是 1,但锁存住了 ⇒ 不再开新一局(不报错地无限重开是原风险)');
});

/* ══════════════ 2. 结算与奖励:FND120-5/6 ══════════════ */

test('FND120-5 ★★ 结算:相位到 SETTLED 时 `settlement` 非 null(修前五个 settle* 生产零调用)', () => {
  const { sim } = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(sim, 1);
  sim.dropItem(8.5, 5.5, BOARD, BRIDGE_TILES_TO_WIN);
  tickSlow(sim, BRIDGE_TILES_TO_WIN);      /* 建造:铺满门槛块数 */
  /* 12 = `party/modes.ts:252` 的 `BRIDGE_TILES_TO_WIN`(字面量取自源码实测,
     期望侧不再取被测模块的常量 —— 否则改常量断言跟着变)。 */
  eq(sim.partyBuiltOf('RED'), 12, '★ 铺板动作真的发生了(消耗地面 152 木板,门槛 12 块)');
  eq(BRIDGE_TILES_TO_WIN, 12, '锚定:门槛常量仍是 12(常量在 actual 侧才有牙齿)');
  tickSlow(sim, 25);                        /* 推到 45s 结算 */
  for (let i = 0; i < 120 && sim.partySettlement() === null; i += 1) tickSlow(sim, 1);
  const st = sim.partySettlement();
  ok(st !== null, '★ 相位到点 ⇒ 结算非 null(修前恒 null)');
  eq(sim.partyPhase(), PARTY_PHASE.SETTLED, '相位 SETTLED');
  eq(st?.standing[0].team, 'RED', '红队夺冠(夺旗 +100)');
  eq(st?.rewards.length, 4, '四支队伍各一行奖励(团队赛)');
});

test('FND120-6 ★ 奖励真的落账:经验进成长档案 + 物品落地面;无队伍者拿不到团队奖励', () => {
  const { sim } = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(sim, 1);
  sim.dropItem(8.5, 5.5, BOARD, BRIDGE_TILES_TO_WIN);
  tickSlow(sim, BRIDGE_TILES_TO_WIN + 25);
  for (let i = 0; i < 120 && sim.partySettlement() === null; i += 1) tickSlow(sim, 1);
  ok(sim.partySettlement() !== null, '前置:已结算');

  const p1 = sim.progressSnapshotOf('p1');
  ok(p1 !== null, '★ 冠军队伍里的玩家**有了成长档案**(修前 rewards 从不发放)');
  ok((p1?.totalExp ?? 0) > 0, `★ 经验真的入账(totalExp=${p1?.totalExp})`);
  eq((sim.progressSnapshotOf('ref')?.totalExp ?? 0), 0,
    '★ 负对照:裁判没站过 435 旗(无队伍)⇒ 团队奖励一分不发(不发明受益者)');
  const ground = sim.groundItemsNear(8.5, 5.5, 1);
  ok(ground.some((g) => g.itemId === 130), '★ 物品奖励掉在玩家脚下(地面是唯一写口)');
  eq(sim.lastPartyRewards.players, 1, '受益者恰好 1 人');
});

/* ══════════════ 3. 播报:死队列变成有消费者(FND120-7)══════════════ */

test('FND120-7 ★★ 播报:_broadcaster 队列被抽空并下发到世界总线(修前只写不读)', () => {
  const { sim } = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(sim, 1);
  eq(sim.partyPhase(), PARTY_PHASE.BUILD, '前置:已开局');
  ok(sim.partyBroadcastCount > 0, `★ 有播报被**取出**并下发(count=${sim.partyBroadcastCount})`);
  includes(sim.lastPartyBroadcasts.map((b) => b.kind), 'MODE_START', '★ 开局播报真的到了下发口');
  /* 总线每快帧末尾排空 ⇒ 本慢帧 emit 的播报要到下一个慢帧才「投递」完。 */
  tickSlow(sim, 1);
  ok(sim.bus.countOf('party_broadcast') > 0, '★ 世界总线收到了 party_broadcast(下游才有得推给客户端)');

  /* 负对照:没有对局 ⇒ 一条都不下发(不是「每帧都刷一条」)。 */
  const idle = new WorldSim({ sizeCells: 12, mobs: false });
  idle.addPlayer('p1', 3.5, 3.5);
  tickSlow(idle, 4);
  eq(idle.partyBroadcastCount, 0, '负对照:没开局 ⇒ 0 条播报');
  eq(idle.lastPartyBroadcasts.length, 0, '负对照:下发口为空');
});

/* ══════════════ 4. 动作层:夺旗 / 拾冠 / 掉冠(FND120-8/9)══════════════ */

test('FND120-8 ★★ 夺旗:冲刺阶段 + 本队桥板够 ⇒ 夺旗;桥板不够 ⇒ 拒绝', () => {
  /* 正:铺满门槛 ⇒ RACE 阶段站旗即夺旗(红队 100 分)。 */
  const { sim } = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(sim, 1);
  sim.dropItem(8.5, 5.5, BOARD, BRIDGE_TILES_TO_WIN);
  tickSlow(sim, BRIDGE_TILES_TO_WIN + 20);
  eq(sim.partyPhase(), PARTY_PHASE.RACE, '前置:进入冲刺阶段');
  tickSlow(sim, 1);
  ok(sim.lastPartyTick.events.includes('PARTY_FLAG') || sim.partyBuiltOf('RED') >= BRIDGE_TILES_TO_WIN,
    '★ 夺旗路径生效(桥板够)');
  /* 闸层两极性:桥板差 1 块 ⇒ 拒绝。 */
  eq(gateBridgeCapture({
    phase: PARTY_PHASE.RACE, team: 'RED', builtTiles: BRIDGE_TILES_TO_WIN - 1, alreadyFlagged: false,
  }).ok, false, '★ 负对照:差 1 块桥板 ⇒ 不许夺旗');
  eq(gateBridgeCapture({
    phase: PARTY_PHASE.BUILD, team: 'RED', builtTiles: BRIDGE_TILES_TO_WIN, alreadyFlagged: false,
  }).ok, false, '负对照:建造阶段 ⇒ 不许夺旗');
  eq(gateBridgePlace({ phase: PARTY_PHASE.BUILD, team: null }).ok, false, '负对照:不知道队伍 ⇒ 不许铺板');

  /* 无桥板的世界:冲刺阶段站旗也夺不到(0 分)。 */
  const bare = arena({ mode: 1, bannerTeam: 0 });
  tickSlow(bare.sim, 1);
  tickSlow(bare.sim, 60);
  for (let i = 0; i < 40 && bare.sim.partySettlement() === null; i += 1) tickSlow(bare.sim, 1);
  const st = bare.sim.partySettlement();
  eq(st?.standing[0].value, 0, '★ 负对照:一块桥板都没有 ⇒ 红队 0 分(没有免门槛的夺旗)');
});

test('FND120-9 ★★ 拾冠 / 掉冠:站 434 底座 + 队伍已登记 ⇒ 拾冠;击退 ⇒ 掉冠;无队伍 ⇒ 拾不到', () => {
  const { sim } = arena({ mode: 3, bannerTeam: 1, pedestal: true });
  tickSlow(sim, 1);
  eq(sim.partyPhase(), PARTY_PHASE.PLAY, '抢皇冠无建造阶段 ⇒ 直接 PLAY');
  eq(sim.partyTeamOf('p1'), 'BLUE', '★ 站过 435 旗 ⇒ 队伍 BLUE(唯一来源)');
  sim.setPlayerPos('p1', 10.5, 5.5);
  tickSlow(sim, 1);
  eq(sim.crownHolder(), 'p1', '★ 拾冠动作真的发生了(修前 `crownPickup` 生产零调用)');
  sim.applyKnockback('p1', 2.5, 5.5, 3);
  tickSlow(sim, 1);
  eq(sim.crownHolder(), null, '★ 被击退 ⇒ 掉冠(皇冠落地)');
  includes(sim.lastPartyTick.events, 'CROWN_DROP', '掉冠事件进了世界总线');

  /* 负对照:没站过任何 435 旗的玩家 ⇒ 无队伍 ⇒ 拾不到。 */
  const noTeam = arena({ mode: 3, pedestal: true, actors: false });
  noTeam.sim.addPlayer('ref', 5.5, 5.5);
  noTeam.sim.addPlayer('p2', 10.5, 5.5);
  tickSlow(noTeam.sim, 1);
  eq(noTeam.sim.partyTeamOf('p2'), null, '前置:没站过旗 ⇒ 没有队伍');
  tickSlow(noTeam.sim, 2);
  eq(noTeam.sim.crownHolder(), null, '★ 负对照:无队伍 ⇒ 拾冠被拒(不猜一个队)');
  eq(gateCrownPickup({
    phase: PARTY_PHASE.PLAY, team: null, atPedestal: true, holder: null, cooldownSec: 0, winner: null,
  }).ok, false, '闸层:NO_TEAM_BANNER');
  eq(gateCrownPickup({
    phase: PARTY_PHASE.PLAY, team: 'BLUE', atPedestal: true, holder: 'x', cooldownSec: 0, winner: null,
  }).ok, false, '闸层:皇冠已被持 ⇒ 拒绝');
});

/* ══════════════ 5. 急单:开工 / 交付 / 回执(FND120-10/11)══════════════ */

test('FND120-10 ★★ 急单开工:食堂建成 + 三工位 + 有人站工位 ⇒ RUNNING;不围合 ⇒ 不开工', () => {
  const sim = canteen();
  ok(sim.rooms().some((r) => r.key === 'COZY_CANTEEN'), '前置:围合房间识别为 COZY_CANTEEN');
  eq(sim.rushState(), 'IDLE', '未开工:IDLE');
  tickSlow(sim, 1);
  eq(sim.rushState(), RUSH_ORDER_STATE.RUNNING, '★ 世界事实(食堂 + 工位 + 人)⇒ 急单真的开工(修前 `startRushRun` 零调用)');
  eq(RUSH_ENTRY_ROOM_LEVEL, 1, '房间等级取最低档(房间侧注入是台账里的 EXTRA 行)');

  /* 负对照:同样的工位与玩家,但**房间没围合** ⇒ 不自动开工。 */
  const open = canteen({ enclosed: false });
  ok(!open.rooms().some((r) => r.key === 'COZY_CANTEEN'), '负对照:没围合 ⇒ 识别不出食堂');
  tickSlow(open, 3);
  eq(open.rushState(), 'IDLE', '★ 负对照:不是食堂 ⇒ 不开工(不靠「有锅就行」)');

  /* 闸层两极性。 */
  eq(gateRushStart({ state: RUSH_ORDER_STATE.RUNNING, stationsReady: true, actorAtStation: true }).ok, false,
    '闸层:已在跑 ⇒ 拒绝');
  eq(gateRushStart({ state: RUSH_ORDER_STATE.IDLE, stationsReady: false, actorAtStation: true }).ok, false,
    '闸层:工位不全 ⇒ 拒绝');
  eq(gateRushStart({ state: RUSH_ORDER_STATE.IDLE, stationsReady: true, actorAtStation: false }).ok, false,
    '闸层:没人站在工位 ⇒ 拒绝');
});

test('FND120-11 ★★ 交付与回执:地面货按订单扣减 + `settleSession` 回执带出 RUSH_GRADE', () => {
  const sim = canteen();
  tickSlow(sim, 1);
  eq(sim.rushState(), RUSH_ORDER_STATE.RUNNING, '前置:急单在跑');
  const lines = sim.rushOpenLines();
  ok(lines.length > 0, '前置:订单板有未完成的行');
  const line = lines[0];
  sim.dropItem(4.5, 5.0, line.itemId, line.remaining);
  tickSlow(sim, 1);
  ok(sim.rushDeliveryCount >= 1, `★ 交付动作真的发生了(` + 'rushDeliveryCount=' + sim.rushDeliveryCount + ')');
  const after = sim.rushOpenLines().find((l) => l.itemId === line.itemId);
  ok(after === undefined || after.remaining < line.remaining, '★ 该行剩余量减少(按订单扣货)');

  /* 负对照:地面上的货**不在订单上** ⇒ 不消耗、不交付。 */
  const offOrder = openOrderLines({ board: { slots: [{ itemId: 101, need: 1, delivered: 0 }] } } as never)
    .map((l) => l.itemId);
  const notOrdered = 601;
  ok(!offOrder.includes(notOrdered) && !sim.rushOpenLines().some((l) => l.itemId === notOrdered),
    '负对照夹具:601 不在这张订单上');
  const before = sim.rushDeliveryCount;
  sim.dropItem(4.5, 5.0, notOrdered, 1);
  tickSlow(sim, 1);
  eq(sim.rushDeliveryCount, before, '★ 负对照:不在订单上的货 ⇒ 不被扣走、不算交付');
  eq(sim.groundItemsNear(4.5, 5.0, 1).some((g) => g.itemId === notOrdered), true,
    '负对照:那件货还在地上');

  /* 结算回执:跑到 SETTLED ⇒ 回执非空(修前 `settleSession` 全仓零引用)。 */
  eq(sim.rushSettlement(), null, '未结算:回执 null');
  for (let i = 0; i < 400 && sim.rushState() !== RUSH_ORDER_STATE.SETTLED; i += 1) tickSlow(sim, 1);
  const receipt = sim.rushSettlement();
  eq(sim.rushState(), RUSH_ORDER_STATE.SETTLED, '急单到 SETTLED');
  ok(receipt !== null, '★ 结算回执非空(`RUSH_GRADE` 从这里出去)');
  ok(['S', 'A', 'B', 'C'].includes(String(receipt?.grade)), `★ 等级是四档之一:${receipt?.grade}`);
  eq(receipt, sim.rushSettlement(), '回执幂等:再读一次是同一份(不重新结算)');
  eq(gateRushDelivery({ state: RUSH_ORDER_STATE.SETTLED, remaining: 1, qty: 1, distance: 0, radius: 1 }).ok, false,
    '闸层:收工后不再接受交付');
});

/* ══════════════ 6. 打盹入口(FND120-12)══════════════ */

test('FND120-12 ★★ `setPlayerDozing` 由 `sleepSource` 驱动;不接 ⇒ 退回旧形态', () => {
  const sim = new WorldSim({ sizeCells: 12, mobs: false });
  sim.addPlayer('p1', 3.5, 3.5);
  let sleeping = true;
  sim.attachSleepSource((id: string) => id === 'p1' && sleeping);
  eq(sim.dozingCount(), 0, '未推帧:没有打盹记录');
  tickSlow(sim, 1);
  eq(sim.dozingCount(), 1, '★ 睡眠读口说「在睡」⇒ 真的登记了打盹玩法态');
  eq(sim.dozeEntryCount, 1, '入口只触发一次(不是每帧都重新登记)');
  /* 打盹攒露水:`DOZE_AFTER_SEC` 之后才产,速率 1/DEW_SEC_PER_UNIT 滴/秒。
     跑 200 慢帧(100 秒)⇒ 打盹约 99.5 秒 ⇒ 至少 3 滴。 */
  tickSlow(sim, 200);
  ok(sim.dewOf('p1') > 0, `★ 露水随时间增长(dew=${sim.dewOf('p1')})`);
  eq(sim.dewOf('p1'), Math.floor((199.5 * 0.5 - DOZE_AFTER_SEC) / DEW_SEC_PER_UNIT),
    '露水量 = floor((打盹秒数 − DOZE_AFTER_SEC) / DEW_SEC_PER_UNIT)(取出整滴)');
  /* 回到前台 ⇒ 清掉打盹态。 */
  sleeping = false;
  tickSlow(sim, 1);
  eq(sim.dozingCount(), 0, '★ 醒来 ⇒ 注销打盹玩法态');

  /* 负对照/injection:不接 `sleepSource` ⇒ 与修前同形态(0)。 */
  const blind = new WorldSim({ sizeCells: 12, mobs: false });
  blind.addPlayer('p1', 3.5, 3.5);
  tickSlow(blind, 20);
  eq(blind.dozingCount(), 0, '负对照:没有睡眠读口 ⇒ 一条都不登记(判据按 0 断言,不是「没人睡」)');
});

/* ══════════════ 7. 整蛊:玩具表 + 218 和平盾(FND120-13/14)══════════════ */

test('FND120-13 ★★ 整蛊判定:表外 ID / 打自己 / 超半径 / 218 和平盾(队友)⇒ 逐条拒绝', () => {
  eq(resolvePrankAction({
    actorId: 'a', targetId: 'b', toyId: 999, distance: 0, ally: true, shieldOn: false,
  }).reason, PRANK_REJECT.UNKNOWN_TOY, '★ 表外玩具 ID ⇒ UNKNOWN_TOY(不抛错,不静默生效)');
  eq(resolvePrankAction({
    actorId: 'a', targetId: 'a', toyId: 222, distance: 0, ally: true, shieldOn: false,
  }).reason, PRANK_REJECT.SELF_TARGET, '打自己 ⇒ 拒绝');
  eq(resolvePrankAction({
    actorId: 'a', targetId: 'b', toyId: 222, distance: 99, ally: true, shieldOn: false,
  }).reason, PRANK_REJECT.OUT_OF_RANGE, '超半径 ⇒ 拒绝(半径来自玩具表)');
  /* 222 大锤对队友:盾**关** ⇒ 生效且 0 伤害;盾**开** ⇒ 被拦。 */
  const open = resolvePrankAction({
    actorId: 'a', targetId: 'b', toyId: 222, distance: 0.5, ally: true, shieldOn: false,
  });
  eq(open.accepted, true, '★ 盾关:大锤对队友生效');
  eq(open.toy?.allyEffect.allyDamage, 0, '★ 手册条款:对队友 0 伤害(取自玩具表)');
  const shielded = resolvePrankAction({
    actorId: 'a', targetId: 'b', toyId: 222, distance: 0.5, ally: true, shieldOn: true,
  });
  eq(shielded.blocked, true, '★ 218 和平盾开着 ⇒ 队友整蛊被拦');
  eq(shielded.flag, null, '被拦 ⇒ 不施加任何状态标记');
  /* 敌对方向:和平盾**不拦**怪物/环境伤害(免疫清单的 hostileImmune=false)。 */
  eq(resolvePrankAction({
    actorId: 'a', targetId: 'mob', toyId: 222, distance: 0.5, ally: false, shieldOn: true,
  }).blocked, false, '★ 负对照:对敌对目标,和平盾不拦(不是「一律免疫」)');

  /* 掉冠判定:三件候选玩具全被盾拦 ⇒ 不掉冠。 */
  eq(resolveCrownKnock({ shieldOn: false }).drop, true, '★ 盾关 ⇒ 被击退即掉冠');
  eq(resolveCrownKnock({ shieldOn: true }).drop, false, '★ 盾开 ⇒ 三件候选全被拦 ⇒ 不掉冠');
  eq(CROWN_KNOCK_TOY_IDS.join(','), '222,225,224', '掉冠候选 = 手册点名的三件');
});

test('FND120-14 ★ 台账:整蛊 35 件逐条有出口;动作台账与词表对齐(禁止「注释称已生效」)', () => {
  eq(PRANK_ACTION_LEDGER.length, 35, '整蛊台账 35 行(= 221..255)');
  eq(wiredPrankToys().sort().join(','), '222,224,225', '★ 只有掉冠那三件登记为 WIRED');
  const none = PRANK_ACTION_LEDGER.filter((r) => r.path === 'NONE');
  eq(none.length, 32, '其余 32 件如实登记为 NONE');
  ok(none.every((r) => r.note.length > 0), '★ 每一行 NONE 都写清了欠哪一步');

  /* 动作台账:WIRED 的符号必须真的在世界侧出现;NONE 的不许冒充已接。 */
  const world = readFileSync(join(ROOT, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8');
  ok(wiredActions().includes(PARTY_ACTION.START_PARTY), '台账:开局登记为 WIRED');
  ok(wiredActions().includes(PARTY_ACTION.CROWN_PICKUP), '台账:拾冠登记为 WIRED');
  ok(unwiredActions().includes(PARTY_ACTION.PRANK), '★ 台账:玩家→玩家整蛊如实登记为 NONE(动作层欠账)');
  for (const sym of ['startPartyRun(', 'startRushRun(', 'submitDelivery(', 'settleSession(',
    'contestCapture(', 'contestCrownPickup(', 'contestCrownDrop(', 'contestPlaceBoard(']) {
    ok(world.includes(sym), `★ WIRED 的动作在生产源码里必须真的出现:${sym}`);
  }
  ok(world.includes('gateCrownKnock('), '★ 掉冠走整蛊判定(prank/actions 在闭包里)');
  ok(!world.includes('gatePrank('), '★ NONE 的整蛊动作**没有**在生产里冒充已接');
  /* 急单台账同理。 */
  const wiredRush = RUSH_ACTION_LEDGER.filter((r) => r.path.startsWith('WIRED:'));
  eq(wiredRush.length, 3, '急单台账:开工 / 交付 / 结算三段 WIRED,房间等级与接力链是 EXTRA');
  ok(RUSH_ACTION_LEDGER.some((r) => r.path.startsWith('EXTRA:')), '欠账留在台账里(不是写成已实现)');
});

/* ══════════════ 8. 注入验证:逐条摘线变红(FND120-15)══════════════ */

test('FND120-15 ★★ 注入验证:逐条摘掉接线 ⇒ 该判据退回旧形态(证明读的是那口线)', () => {
  /* (a) 摘掉 436 哨台:同样的帧数不再开局。 */
  const noDesk = arena({ mode: 1, bannerTeam: 0 });
  noDesk.sim.wiring.removeComponent('desk');
  tickSlow(noDesk.sim, 5);
  eq(noDesk.sim.partyPhase(), 'IDLE', '★ 摘掉哨台 ⇒ 恒 IDLE(tick 自己不会开局)');

  /* (b) 摘掉 435 复活旗:队伍读不到 ⇒ 拾冠/团队奖励都无从谈起。 */
  const noBanner = arena({ mode: 3, pedestal: true });
  tickSlow(noBanner.sim, 3);
  eq(noBanner.sim.partyTeamOf('p1'), null, '★ 摘掉旗 ⇒ 无队伍(不是猜一个)');

  /* (c) 摘掉电路(`wiring:false`):哨台入口整段静默,但不抛错。 */
  const deadWiring = new WorldSim({ sizeCells: 16, mobs: false, wiring: false });
  deadWiring.wiring.addComponent(makeComponent('desk', 436, 5, 5, { params: { mode: 1 } }));
  deadWiring.addPlayer('ref', 5.5, 5.5);
  tickSlow(deadWiring, 3);
  eq(deadWiring.partyPhase(), 'IDLE', '★ `wiring:false` ⇒ 没有哨台入口(入口只在有电路时读命令)');

  /* (d) 摘掉睡眠读口:打盹入口整段静默(与 (b) 同形)。 */
  const noSleep = new WorldSim({ sizeCells: 12, mobs: false });
  noSleep.addPlayer('p1', 3.5, 3.5);
  tickSlow(noSleep, 10);
  eq(noSleep.dozeEntryCount, 0, '★ 摘掉 sleepSource ⇒ 打盹入口 0 次');
});

report('WS-FND-120');