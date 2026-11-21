/**
 * WS-FND-176 —— **派对自然超时结算之后必须回 `IDLE` 并收束记分账**(owner 裁定 D-23)
 *
 * 运行:`node tests/WS-FND-176-party-settle-idle.test.ts`
 *
 * ## 修的是什么(Z2 清点时发现的真缺陷,与 D-23 **直接冲突**)
 *
 * ```text
 * 派对自然超时结算 ⇒ 世界的 `partyPhase()` 停在 `'SETTLED'`,**再也不动**
 *   (修前全仓只有 436 哨台按 -1 的 `WorldSim.clearPartyRun()` 会让它回 IDLE)
 *   ⇒ 房间侧 `syncPartyRecord` 的收束支(判据 = 世界回 `'IDLE'`)永不触发
 *   ⇒ 记分账 `PartyRecord` 永远 `RUNNING`
 *   ⇒ `addScore` 继续累计(名次早已定格,分却还在涨 —— 谁最后报分谁赢)
 * ```
 *
 * ⇒ 修点只有一处:`server/src/party/modes.ts` 的 `tickPartyMode` —— 结算**已定格**
 * (`m.settlement !== null`)之后的下一慢帧把相位送回 `IDLE`(见那边的 §6)。
 * 房间侧那条既有收束路径(世界回 `IDLE` + 账本仍 `RUNNING` ⇒ `endParty`)因此
 * 对**自然超时**也真的成立 —— 本套件钉的就是这三件事的**可观测面**。
 *
 * ## 判据清单(9 条,每条都带负对照)
 *
 * | # | 判据 | 负对照 / 反向 |
 * | :-- | :--- | :--- |
 * | FND176-1 | 自然结算后世界相位回 `IDLE`;结算那一帧仍是 `SETTLED` | 刚开局的局仍是 `BUILD`(不是「恒 IDLE」) |
 * | FND176-2 | 账本被 `endParty` 收束(`partyStateOf` 不再是 `RUNNING`) | 结算那一帧账本**还开着**、`endParty` 还没被调过 |
 * | FND176-3 | 收束之后 `addScore` 被拒、分数定格 | 收束**前**同一笔 `addScore` 成功(拒绝来自结算,不是函数坏了) |
 * | FND176-4 | `SETTLED` 恰好停留**一慢帧**(结算帧可见 + 下一慢帧回 `IDLE`) | 同一慢帧内(第 9 快帧)仍是 `SETTLED` / 账本仍 `RUNNING` |
 * | FND176-5 | 裁判 `-1` 收局照旧(相位 `IDLE`、不二次发奖、不二次收束) | 自然结算已发过一次奖 ⇒ 收局不再发 |
 * | FND176-6 | 再推 30 慢帧幂等:相位不弹、账本不再收束、不重开新局、分数不涨 | 同一夹具推多帧后 `partyRecordAdoptCount` 不变 |
 * | FND176-7 | `RESET_WORLD` 换代清场:相位 `IDLE` + 账本收束 + 之后不再计分 | 换代前同一房间:相位非 `IDLE`、账本 `RUNNING` |
 * | FND176-8 | 五个 `settle*` 走**同一条**相位轨(逐个:结算帧 `SETTLED` ⇒ 下一慢帧 `IDLE`) | 第三次 `tickPartyMode` 一个事件都不报(不重复结算) |
 * | FND176-9 | 四种模式在**真实世界**里各自自然结算 ⇒ 同样回 `IDLE` + 账本收束 | 逐个模式都先断言「结算帧是 `SETTLED` 且账本 `RUNNING`」 |
 *
 * ## 判据纪律
 *
 * 1 **不拿实现常量核实现行为**:期望侧写 `'IDLE'` / `'SETTLED'` / `PartyPhase.*`
 *    字面量,行为量由世界侧独立读数(`partyPhase()` / `partySettlement()` /
 *    `partyRewardGrantCount`)与账本读数(`partyStateOf` / `partyRecordEndCount`)给出。
 * 2 **一条正判据配一条负对照**(同一夹具、只改一个输入)。
 * 3 **时序对齐在慢帧边界上**:对局推进只在世界的慢帧(`FAST_PER_SLOW` 快帧 = 1 慢帧)
 *    发生 ⇒ 本套件用**快帧**步进,好把「结算帧」与「回 IDLE 的那一帧」精确分开。
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';
import { makeComponent } from '../server/src/wiring/components.ts';
import { RoomAction, RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import {
  PartyPhase,
  addScore,
  clearPartyRegistry,
  partyStateOf,
  setPartyClock,
} from '../server/src/net/actions/start_party.ts';
import { createManualClock } from '../server/src/coop/rush_order.ts';
import {
  CROWN_WIN_SEC,
  PARTY_PHASE,
  createBridgeRun,
  createCrownRun,
  createJellyBall,
  createPaintWar,
  createRaceRun,
  crownAssignTeam,
  crownPickup,
  modeTotalSec,
  startPartyMode,
  tickCrown,
  tickPartyMode,
  type PartyModeRuntime,
} from '../server/src/party/modes.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

let roomSeq = 0;
/** 每次一个新 `roomId`:账本(`PARTIES`)按 roomId 分桶,复用会串局。 */
function freshRoomId(tag: string): string {
  roomSeq += 1;
  return `room_fnd176_${tag}_${roomSeq}`;
}

interface Fixture {
  sim: WorldSim;
  rt: RoomRuntime;
  roomId: string;
}

/**
 * 一房一世界:`owner` 站 436 哨台格(5.5,5.5)⇒ **世界侧自然开局**(没人发 `START_PARTY`
 * 报文 —— 这正是「自然超时」那条路的前提);`p1` 也进房(计分对象)。
 */
function arena(mode: number): Fixture {
  clearPartyRegistry();
  const roomId = freshRoomId('arena');
  const c = fixedClock(1_700_000_000_000);
  /* 账本模块自带可注入时钟(它拿不到房间的 clock);用**同一个**固定时钟,
     `meta.partyTimer` 才是确定的。 */
  setPartyClock(() => c.clock.nowMs());
  const rt = new RoomRuntime({ roomId, ownerId: 'owner', clock: c.clock });
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.wiring.addComponent(makeComponent('desk', 436, 5, 5, { params: { mode } }));
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  ok(rt.join({ userId: 'owner' }).ok, '前置:房主进场');
  ok(rt.join({ userId: 'p1' }).ok, '前置:p1 进场');
  sim.setPlayerPos('owner', 5.5, 5.5);
  sim.setPlayerPos('p1', 8.5, 5.5);
  return { sim, rt, roomId };
}

/** 推 `n` 个**快帧**(房间一帧 = 一快帧;世界的对局段只在每 `FAST_PER_SLOW` 帧跑一次)。 */
function stepFrames(rt: RoomRuntime, n: number): void {
  for (let i = 0; i < n; i += 1) rt.step();
}

/**
 * 一快帧一步推到「世界侧自然结算」那一帧,返回用掉的快帧数(`-1` = 到上限还没结算)。
 * 返回时必然停在**慢帧边界**上(结算由慢帧段产出)⇒ 之后的 `stepFrames(FAST_PER_SLOW)`
 * 恰好跨过一个慢帧边界。
 */
function stepToNaturalSettle(rt: RoomRuntime, sim: WorldSim, maxFrames: number): number {
  for (let k = 0; k < maxFrames; k += 1) {
    rt.step();
    if (sim.partySettlement() !== null) return k;
  }
  return -1;
}

/** 按模式总时长算一个宽松上限(慢帧数 × 每慢帧快帧数)。 */
function settleBudget(modeIndex: number): number {
  const total = [45, 180, 180, 120][modeIndex - 1] ?? 180;
  return (total * 2 + 20) * FAST_PER_SLOW;
}

/** 世界里的 436 哨台(收局命令的写入点)。 */
function deskOf(sim: WorldSim): { params: Record<string, number> } {
  const desk = [...sim.wiring.components.values()].find((x) => x.kind === 'ARENA_REFEREE_DESK');
  ok(desk !== undefined, '前置:哨台在');
  return desk as unknown as { params: Record<string, number> };
}

/* ══════════════ 1. 自然超时:回 IDLE(FND176-1)══════════════ */

test('FND176-1 ★★ 自然超时结算 ⇒ 世界相位离开 SETTLED 回到 IDLE;结算那一帧仍是 SETTLED', () => {
  const { sim, rt } = arena(1);
  /* 负对照(先跑):刚开局的同一夹具 ⇒ 相位在 BUILD,不是 IDLE。 */
  const fresh = arena(1);
  stepFrames(fresh.rt, 2 * FAST_PER_SLOW);
  eq(fresh.sim.partyPhase(), PARTY_PHASE.BUILD,
    '负对照:刚开局的局仍是 BUILD ⇒ 下面的 IDLE 不是「恒 IDLE」');

  const settledAt = stepToNaturalSettle(rt, sim, settleBudget(1));
  ok(settledAt >= 0, '前置:这一局**自然结算**了(没有任何人按 -1)');
  ok(sim.partySettlement() !== null, '前置:结算对象已经产出');
  eq(sim.partyPhase(), PARTY_PHASE.SETTLED,
    '★ 结算那一帧仍报 SETTLED(相位先到位再结算 —— 安慰分只在 SETTLED 折算)');

  stepFrames(rt, FAST_PER_SLOW + 2);
  eq(sim.partyPhase(), PARTY_PHASE.IDLE,
    '★★ 结算之后的下一慢帧:世界相位回 IDLE(修前它**永远**停在 SETTLED,'
    + '只有裁判按 -1 才会离开)');
  ok(sim.partySettlement() !== null, '★ 回 IDLE 不清结算:终端文案 / 名次仍可读');
});

/* ══════════ 2. 账本收束:endParty 真的被调(FND176-2)══════════ */

test('FND176-2 ★★ 账本收束:partyStateOf 不再是 RUNNING,endParty 被调用一次', () => {
  const { sim, rt } = arena(1);
  ok(stepToNaturalSettle(rt, sim, settleBudget(1)) >= 0, '前置:自然结算');

  /* 负对照:结算那一帧账本**还开着** —— 收束不是「结算同帧把账关了」。 */
  eq(partyStateOf(rt.id)?.state, PartyPhase.RUNNING,
    '负对照:结算帧的账本仍是 RUNNING(那一帧的分仍允许,见 FND176-3)');
  eq(rt.partyRecordEndCount, 0, '负对照:那一刻 `endParty` 还没被调过');

  stepFrames(rt, FAST_PER_SLOW + 2);
  eq(sim.partyPhase(), PARTY_PHASE.IDLE, '前置:世界已回 IDLE');
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED,
    '★★ 账本被 `endParty` 收束(修前永远 RUNNING ⇒ 与 D-23「自动回 IDLE」直接冲突)');
  eq(rt.partyRecordEndCount, 1, '★ `endParty` 真的被调了一次');
  eq(partyStateOf(rt.id)?.endedAtMs !== null, true, '★ 结算时刻定格(记账不是被删掉,是被收束)');
});

/* ═════════ 3. 收束之后不再计分(FND176-3)═════════ */

test('FND176-3 ★★ 收束之后 addScore 不再计分(分数定格);收束前同一笔仍然算', () => {
  const { sim, rt } = arena(1);
  ok(stepToNaturalSettle(rt, sim, settleBudget(1)) >= 0, '前置:自然结算');

  /* 正例/负对照:结算帧账本仍开 ⇒ 终场分记得进去(那一笔必须留下)。 */
  const atSettle = addScore(rt.id, 'p1', 7);
  eq(atSettle.ok, true, '★ 负对照:收束**前** `addScore` 成功(拒绝不是「函数坏了」)');
  eq(atSettle.total, 7, '总分 7');

  stepFrames(rt, FAST_PER_SLOW + 2);
  const after = addScore(rt.id, 'p1', 999);
  eq(after.ok, false, '★★ 收束之后 `addScore` 被拒(修前这条恒 true ⇒ 分继续涨,名次早已定格)');
  ok((after.reason ?? '').includes('SETTLED'), `理由写明「已结算」:${after.reason ?? '-'}`);
  eq(partyStateOf(rt.id)?.scores.get('p1'), 7, '★ 分数**定格**在结算那一刻(999 没进去)');
});

/* ═════════ 4. SETTLED 恰好停留一慢帧(FND176-4)═════════ */

test('FND176-4 ★ SETTLED 恰好停留一慢帧:同一慢帧内仍是 SETTLED+账本开着,跨过边界即 IDLE+收束', () => {
  const { sim, rt } = arena(1);
  ok(stepToNaturalSettle(rt, sim, settleBudget(1)) >= 0, '前置:自然结算');
  eq(sim.partyPhase(), PARTY_PHASE.SETTLED, '前置:结算帧 SETTLED');

  stepFrames(rt, FAST_PER_SLOW - 1);
  eq(sim.partyPhase(), PARTY_PHASE.SETTLED,
    '负对照:同一慢帧内(第 9 快帧)相位仍是 SETTLED —— 不是「结算同帧就消失」');
  eq(partyStateOf(rt.id)?.state, PartyPhase.RUNNING, '★ 那一帧账本还开着(结算前一刻的分仍算得进)');

  rt.step();
  eq(sim.partyPhase(), PARTY_PHASE.IDLE, '★ 跨过慢帧边界:相位回 IDLE');
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED, '★ 同一边界上账本收束');
  eq(rt.partyRecordEndCount, 1, '★ 收束恰好一次');
});

/* ═════════ 5. 裁判 -1 那条路仍正常(FND176-5)═════════ */

test('FND176-5 ★ 裁判按 -1 收局不受影响:相位 IDLE、不二次发奖、账本不二次收束', () => {
  const { sim, rt } = arena(1);
  ok(stepToNaturalSettle(rt, sim, settleBudget(1)) >= 0, '前置:自然结算');
  const granted = sim.partyRewardGrantCount;
  eq(granted, 1, '前置:自然结算发了一次奖(结算只发生一次)');

  stepFrames(rt, FAST_PER_SLOW + 2);
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED, '前置:账本已收束');
  eq(rt.partyRecordEndCount, 1, '前置:收束一次');

  /* 裁判按 -1(哨台命令是电平,直接改 `params.mode`;与 WS-FND-123 FND123-9 同法)。 */
  deskOf(sim).params.mode = -1;
  stepFrames(rt, FAST_PER_SLOW + 2);
  eq(sim.partyPhase(), PARTY_PHASE.IDLE, '★ 收局生效:相位仍是 IDLE');
  eq(sim.partyRewardGrantCount, granted, '★ 同一 settlement 没有二次发奖(-1 这条路不再抢结算)');
  eq(rt.partyRecordEndCount, 1, '★ 账本不重复收束(`endParty` 幂等)');
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED, '★ 账本仍 SETTLED(收局 ≠ 删账)');

  /* 负对照:裁判**不在**哨台格上时,-1 收不掉任何东西(收局不是无条件的;判据同 WS-FND-120)。 */
  const away = arena(1);
  stepFrames(away.rt, 2 * FAST_PER_SLOW);
  ok(away.sim.partyPhase() !== PARTY_PHASE.IDLE, `前置(负对照组):赛局在跑(${away.sim.partyPhase()})`);
  away.sim.setPlayerPos('owner', 20.5, 20.5);
  deskOf(away.sim).params.mode = -1;
  stepFrames(away.rt, 2 * FAST_PER_SLOW);
  eq(away.sim.partyPhase() !== PARTY_PHASE.IDLE, true,
    '负对照:没人站哨台 ⇒ -1 收不掉这一局(这一组还没到结算点,相位仍在 BUILD/RACE)');
});

/* ═════════ 6. 重复推进幂等(FND176-6)═════════ */

test('FND176-6 ★ 再推 30 慢帧幂等:相位不弹、不重开新局、账本与分数都不动', () => {
  const { sim, rt } = arena(1);
  ok(stepToNaturalSettle(rt, sim, settleBudget(1)) >= 0, '前置:自然结算');
  addScore(rt.id, 'p1', 5);
  stepFrames(rt, FAST_PER_SLOW + 2);
  const endCount = rt.partyRecordEndCount;
  const adoptCount = rt.partyRecordAdoptCount;
  const grantCount = sim.partyRewardGrantCount;
  eq(endCount, 1, '前置:收束一次');
  ok(adoptCount >= 1, `前置:账本补建过一次(${adoptCount})`);
  eq(partyStateOf(rt.id)?.scores.get('p1'), 5, '前置:终场分定格在 5');

  stepFrames(rt, 30 * FAST_PER_SLOW);
  eq(sim.partyPhase(), PARTY_PHASE.IDLE, '★ 30 慢帧之后相位仍是 IDLE(不弹回 SETTLED / 不重开)');
  eq(rt.partyRecordEndCount, endCount, '★ `endParty` 不再被调(收束幂等)');
  eq(rt.partyRecordAdoptCount, adoptCount, '★ 不重开新局(哨台 `params.mode` 仍是 1,被锁存住)');
  eq(partyStateOf(rt.id)?.scores.get('p1'), 5, '★ 分数不涨');
  eq(sim.partyRewardGrantCount, grantCount, '★ 奖励不二次发放');
});

/* ═════════ 7. RESET_WORLD 清场(FND176-7)═════════ */

test('FND176-7 ★ RESET_WORLD 换代:相位回 IDLE、账本收束、之后不再计分', () => {
  const { sim, rt } = arena(1);
  stepFrames(rt, 3 * FAST_PER_SLOW);
  ok(sim.partyPhase() !== PARTY_PHASE.IDLE, `前置:赛局在跑(${sim.partyPhase()})`);
  eq(partyStateOf(rt.id)?.state, PartyPhase.RUNNING, '前置:账本 RUNNING(可以计分)');
  eq(addScore(rt.id, 'p1', 2).ok, true, '前置:换代前记得进去');

  const r = rt.dispatchAction('owner', RoomAction.RESET_WORLD, { seed: 4242, confirm: true });
  eq(r.ok, true, `★ RESET_WORLD 成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(sim.partyPhase(), PARTY_PHASE.IDLE, '★ 换代 ⇒ 旧局连容器一起作废 ⇒ 相位 IDLE');

  stepFrames(rt, FAST_PER_SLOW + 2);
  eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED,
    '★★ 账本被收束(修前:换代后账本仍 RUNNING ⇒ `addScore` 继续收分)');
  eq(rt.partyRecordEndCount, 1, '★ `endParty` 调了一次');
  const after = addScore(rt.id, 'p1', 3);
  eq(after.ok, false, '★ 换代之后 `addScore` 被拒(不再收分)');
  eq(partyStateOf(rt.id)?.scores.get('p1'), 2, '★ 分数定格在换代前那一笔');
});

/* ═════════ 8. 五个 settle* 同一条相位轨(FND176-8)═════════ */

interface SettleCase {
  label: string;
  clock: ReturnType<typeof createManualClock>;
  mode: PartyModeRuntime;
  /** 已经提前宣胜(抢皇冠 60 秒持冠那条路)⇒ 进入本函数时相位已是 SETTLED。 */
  preSettled?: boolean;
  /** 结算对象真的产出了(每个模式自己的产出面)。 */
  settled: () => boolean;
}

/** 五个结算点各建一局:四个超时 + 抢皇冠的**提前宣胜**。 */
function settleTrackCases(): SettleCase[] {
  const c1 = createManualClock(0);
  const bridge = createBridgeRun(c1, 'ref');
  const c2 = createManualClock(0);
  const jelly = createJellyBall(c2, 'ref');
  const c3 = createManualClock(0);
  const crown = createCrownRun(c3, 'ref');
  startPartyMode(crown.mode);
  crownAssignTeam(crown, 'p1', 'RED');
  crownPickup(crown, 'p1');
  tickCrown(crown, CROWN_WIN_SEC);
  const c4 = createManualClock(0);
  const paint = createPaintWar(c4, 'ref');
  const c5 = createManualClock(0);
  const race = createRaceRun(c5, 'ref', 90);
  return [
    { label: 'settleBridgeRun', clock: c1, mode: bridge.mode, settled: () => bridge.mode.settlement !== null },
    { label: 'settleJellyBall', clock: c2, mode: jelly.mode, settled: () => jelly.mode.settlement !== null },
    {
      label: 'settleCrown(提前宣胜)', clock: c3, mode: crown.mode, preSettled: true,
      settled: () => crown.mode.settlement !== null,
    },
    { label: 'settlePaintWar', clock: c4, mode: paint.mode, settled: () => paint.mode.settlement !== null },
    { label: 'settleRace', clock: c5, mode: race.mode, settled: () => race.mode.settlement !== null },
  ];
}

test('FND176-8 ★★ 五个 settle* 停在 SETTLED 的**同一处**:结算帧可见 ⇒ 下一慢帧 IDLE(逐个核)', () => {
  const cases = settleTrackCases();
  eq(cases.length, 5, '锚:五个结算点都在夹具里(桥牌/彩球/抢冠/画战/竞速)');
  for (const c of cases) {
    const m = c.mode;

    if (c.preSettled !== true) startPartyMode(m);
    /* 推进到总时长之外:超时那一条;抢皇冠已是 SETTLED(提前宣胜)。 */
    c.clock.set(modeTotalSec(m) + 1);

    const ev1 = tickPartyMode(m);
    eq(m.phase, PARTY_PHASE.SETTLED, `★ ${c.label}:结算那一帧相位是 SETTLED`);
    ok(c.settled(), `★ ${c.label}:结算对象真的产出了(settlement 非 null)`);
    eq(ev1.includes('PARTY_SETTLED'), true, `★ ${c.label}:结算事件报出来了`);
    eq(ev1.includes('PHASE:IDLE'), false, `★ ${c.label}:结算那一帧**不**报 IDLE(不提前关账)`);

    const ev2 = tickPartyMode(m);
    eq(m.phase, PARTY_PHASE.IDLE, `★★ ${c.label}:下一慢帧自动回 IDLE(修前永远停在 SETTLED)`);
    eq(ev2.join(','), 'PHASE:IDLE', `★ ${c.label}:该帧只报 PHASE:IDLE(不重复结算)`);
    eq(m.settlement !== null, true, `★ ${c.label}:回 IDLE 不清结算`);
    eq(tickPartyMode(m).length, 0, `★ ${c.label}:第三次推进一个事件都不报(幂等)`);
    eq(m.phase, PARTY_PHASE.IDLE, `★ ${c.label}:相位停在 IDLE`);
  }
});

/* ═════════ 9. 四种模式在真实世界里同修(FND176-9)═════════ */

test('FND176-9 ★★ 四种模式逐个跑完自然超时:相位回 IDLE + 账本收束(SETTLED 无例外)', () => {
  const names = ['BRIDGE_CTF', 'JELLY_BALL', 'CROWN_BR', 'PAINT_WAR'];
  for (let mode = 1; mode <= 4; mode += 1) {
    const label = names[mode - 1]!;
    const { sim, rt } = arena(mode);
    ok(stepToNaturalSettle(rt, sim, settleBudget(mode)) >= 0, `前置:${label} 自然结算`);
    eq(sim.partyModeKey(), label, `★ ${label}:世界报的就是本局模式键`);
    eq(sim.partyPhase(), PARTY_PHASE.SETTLED, `★ ${label}:结算帧 SETTLED`);
    eq(partyStateOf(rt.id)?.state, PartyPhase.RUNNING, `★ ${label}:结算帧账本仍 RUNNING(可以收尾计分)`);

    stepFrames(rt, FAST_PER_SLOW + 2);
    eq(sim.partyPhase(), PARTY_PHASE.IDLE, `★★ ${label}:同一个模式表里的其余模式一样回 IDLE(没有例外)`);
    eq(partyStateOf(rt.id)?.state, PartyPhase.SETTLED, `★ ${label}:账本收束`);
    eq(rt.partyRecordEndCount, 1, `★ ${label}:endParty 一次`);
    eq(partyStateOf(rt.id)?.endedAtMs !== null, true, `★ ${label}:收束是「定格」而不是删账`);
    eq(addScore(rt.id, 'p1', 1).ok, false, `★ ${label}:收束之后不再计分`);
  }
});

report('WS-FND-176');
