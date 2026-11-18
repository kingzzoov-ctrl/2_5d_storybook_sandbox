/**
 * WS-FND-108 —— 第三轮实测的**五处边界缺陷**的判据(Boss 运行时 3 条 + 派对 1 条 + 急单 1 条)。
 *
 * | # | 判据 | 修的是什么 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | 同 `bossId` 召唤两次 ⇒ 第二次 `BOSS_ALIVE`、**不扣祭品**、血量**不被重置** | `BossRaidRuntime.summon` 自己不查 `states`,重复召唤把整只 Boss 重置满血 | `bosses/runtime.ts` 的 `if (this.states.has(req.bossId))` 整段删掉 |
 * | 2 | 负伤害 ⇒ `{0,0}` 且血量**不涨**(`hp ≤ maxHp` 仍成立) | `damageBoss` 无入参边界:`hp -= -50` 等于回血 | `bosses/phases.ts` 的 `!Number.isFinite(amount) \|\| amount < 0` 守卫删掉 |
 * | 3 | `NaN` / `Infinity` 伤害 ⇒ `{0,0}`,血量**仍是有限数**,阶段算得出来 | 同上:`Math.min(hp, NaN)` ⇒ `hp = NaN` 永久毒化(阶段永不切换) | 同上,把守卫改成只判 `amount < 0` |
 * | 4 | 八个 Boss 喂 `{}` ⇒ 一律 `ok:false`、**不抛**;合法输入仍 `ok:true` | `evaluateBreak` 的「确定结论」承诺只覆盖未知 Boss,三条判定对缺字段抛 `TypeError` | `bosses/breaks.ts` 的 `try/catch` 去掉(恢复成直接 `switch`) |
 * | 5 | `settleBridgeRun` **幂等** + **相位门槛**:重复调用不重复加分,未到 `SETTLED` 不发安慰分 | 每次调用给未夺旗队 `score += built × 2`,且没有相位判据 | `party/modes.ts` 的 `if (r.mode.settlement !== null) return ...` 与 `if (phase === SETTLED)` 两道守卫 |
 * | 6 | 「有人翻炒」真的能压住 12 秒过热(喂 `tended` ⇒ 不起火;不喂 ⇒ 必起火);`stationsBeingTendedBy` 的命中/排除口径 | 生产**从不喂** `tended` ⇒ 「12 秒不翻炒起火」退化成**必然起火** | `coop/rush_order.ts` 的 `stationsBeingTendedBy`(删掉 `RUNNING` 过滤 / 坐标口径)与 `tickRushOrder` 的 `tended` 取值 |
 *
 * ## 判据 6 的诚实边界(必须读)
 *
 * 本文件钉的是**急单这一半**:`tickRushOrder` 拿到 `tended` 之后行为正确,
 * 以及「坐标 → 工位」的读口口径。世界侧的**生产者**在 `server/src/sim/world_sim.ts`
 * (`tickPartyStep` 只算 `spraying`,从不传 `tended`)—— 那个文件不属本任务可改范围,
 * 补法写在 `coop/rush_order.ts#stationsBeingTendedBy` 与 `RushTickOptions.tended`
 * 的 docblock 里(一行 `tendUntil` 意图表 + 一次 `stationsBeingTendedBy` 调用)。
 * ⇒ 本判据**不**声称「真房间里已不再必然起火」;它证明的是「喂进去就正确」,
 *   以及「不喂就必然起火」这个退化形态(负对照)。
 *
 * 运行:`node tests/WS-FND-108-boss-party-bounds.test.ts`
 */
import { test, ok, eq, mulberry32, report } from '../shared/testing/harness.ts';
import { BOSS_LIST } from '../shared/constants/bosses.ts';
import { BossRaidRuntime, makeMemoryOfferingPort } from '../server/src/bosses/runtime.ts';
import { createBossState, damageBoss, phaseIndexFor } from '../server/src/bosses/phases.ts';
import { BREAK_BOSS_IDS, breakCoverage, evaluateBreak } from '../server/src/bosses/breaks.ts';
import {
  PARTY_PHASE, bridgeCapture, bridgePlace, createBridgeRun, settleBridgeRun,
  startPartyMode, tickPartyMode,
} from '../server/src/party/modes.ts';
import { TEAM_KEY, getTeam } from '../server/src/party/scoring.ts';
import {
  EVT_FIRE, OVERHEAT_SEC, STATION_KIND, STATION_STATE,
  cellCenterOf, createManualClock, createRushOrderSession, DEFAULT_STATION_CELLS,
  startRushOrder, stationsBeingSprayedBy, stationsBeingTendedBy, tickRushOrder,
} from '../server/src/coop/rush_order.ts';

/* ───────────── 夹具:召唤请求(8 个 Boss 的祭品 734~741,取表里前两只) ───────────── */

const BOSS_A = BOSS_LIST[0];
const BOSS_B = BOSS_LIST[1];

function summonReq(bossId: string, summonItem: number) {
  return {
    bossId,
    itemId: summonItem,
    hasAltar: true,
    /* 离城镇中心 (0,0) 141 格 —— 远在 `TOWN_SAFE_RADIUS = 24` 之外 */
    altarX: 100,
    altarY: 100,
    townCenterX: 0,
    townCenterY: 0,
    playerCount: 1,
    alreadyAlive: false,
    ownerId: 'alice',
  };
}

/** 断言「这段代码不抛」并返回它真正返回的东西。 */
function attempt<T>(fn: () => T): { threw: boolean; value: T | undefined; err: string } {
  try {
    return { threw: false, value: fn(), err: '' };
  } catch (e) {
    return { threw: true, value: undefined, err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/* ═══════════════ 1. 重复召唤不得把 Boss 重置满血(runtime.ts) ═══════════════ */

test('FND108-1 同 bossId 召唤两次:第二次 BOSS_ALIVE、不扣祭品、血量不被重置', () => {
  const rt = new BossRaidRuntime();
  const port = makeMemoryOfferingPort({ alice: { [BOSS_A.summonItem]: 3 } });
  const req = summonReq(BOSS_A.id, BOSS_A.summonItem);

  const first = rt.summon(req, port);
  eq(first.ok, true, `前置:首次召唤应成功(实测 reason=${first.reason})`);
  eq(first.offeringConsumed, true, '首次真的扣了祭品');
  eq(rt.size, 1, '在场表里有 1 只');
  eq(port.snapshot().alice![BOSS_A.summonItem], 2, '祭品 3 → 2');

  /* 先打掉一截血,再加一个破防标记 —— 重置会用新实例把它们一起抹掉 */
  const before = rt.snapshot(BOSS_A.id)!;
  const dealt = rt.damage(BOSS_A.id, 30);
  eq(dealt?.toHp, 30, '前置:30 点伤害落在血量上(此时无护盾)');
  const wounded = rt.snapshot(BOSS_A.id)!;
  eq(wounded.hp, before.hp - 30, '前置:血量确实掉了 30');

  /* ★ 重复召唤 */
  const second = rt.summon(req, port);
  eq(second.ok, false, '★ 第二次召唤必须被拒(改前会成功并重置满血)');
  eq(second.reason, 'BOSS_ALIVE', '拒因是「同 Boss 在场」');
  eq(second.offeringConsumed, false, '★ 被拒时不得扣祭品');
  eq(port.snapshot().alice![BOSS_A.summonItem], 2, '★ 祭品仍是 2(没有第二次扣减)');
  eq(rt.size, 1, '在场表仍只有 1 只(没有被换掉)');
  eq(rt.snapshot(BOSS_A.id)!.hp, wounded.hp, '★ 血量没有被重置成满血');

  /* 负对照:换一只 Boss 仍能召唤 —— 拒绝不是「一律拒」 */
  const other = rt.summon(summonReq(BOSS_B.id, BOSS_B.summonItem), port);
  eq(other.ok, false, '负对照的前置:alice 没有第二只 Boss 的祭品 ⇒ 拒于 NO_OFFERING');
  eq(other.reason, 'NO_OFFERING', '拒因是缺祭品(不是 BOSS_ALIVE)');
  const port2 = makeMemoryOfferingPort({ alice: { [BOSS_B.summonItem]: 1 } });
  eq(rt.summon(summonReq(BOSS_B.id, BOSS_B.summonItem), port2).ok, true, '负对照:另一只 Boss 照样能召唤');
  eq(rt.size, 2, '在场表 2 只');
});

/* ═══════════════ 2. 负伤害不得回血(phases.ts) ═══════════════ */

test('FND108-2 damageBoss 的负伤害:返回零分配、血量不涨、仍 ≤ maxHp', () => {
  const s = createBossState(BOSS_A.id, 1);
  const hp0 = s.hp;
  eq(hp0, s.maxHp, '前置:满血');

  const neg = damageBoss(s, -50);
  eq(neg.toShield, 0, '★ 负伤害不给护盾分配');
  eq(neg.toHp, 0, '★ 负伤害不给血量分配');
  eq(s.hp, hp0, '★ 血量一格没动(改前 `hp -= -50` 会凭空 +50)');
  ok(s.hp <= s.maxHp, `★ 血量没有越过上限(实测 ${s.hp} / ${s.maxHp})`);

  /* 负对照:正伤害照旧生效(守卫不是「一律不扣」) */
  const pos = damageBoss(s, 30);
  eq(pos.toHp, 30, '负对照:30 点正伤害照常落在血量上');
  eq(s.hp, hp0 - 30, '负对照:血量 = 上限 - 30');

  /* 边界:0 伤害是合法输入(不是「非法」那一档) */
  const zero = damageBoss(s, 0);
  eq(zero.toHp, 0, '0 伤害分配 0');
  eq(s.hp, hp0 - 30, '0 伤害不改血量');
});

/* ═══════════════ 3. NaN / Infinity 不得毒化血量(phases.ts) ═══════════════ */

test('FND108-3 damageBoss 的非有限伤害:血量保持有限,阶段仍算得出来', () => {
  const s = createBossState(BOSS_A.id, 1);
  const hp0 = s.hp;

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const r = damageBoss(s, bad);
    eq(r.toHp, 0, `${String(bad)} 不给血量分配`);
    ok(Number.isFinite(s.hp), `★ ${String(bad)} 之后血量仍是有限数(实测 ${String(s.hp)})`);
    eq(s.hp, hp0, `★ ${String(bad)} 之后血量没变`);
  }

  /* 阶段是按 `hp / maxHp` 求的 —— 血量被毒化成 NaN 时这条链会静默失效 */
  const ratio = s.hp / s.maxHp;
  ok(Number.isFinite(ratio), 'hpRatio 是有限数');
  const idx = phaseIndexFor(s.def, ratio);
  eq(idx, 0, '★ 阶段仍可判定(满血 ⇒ P1);改前这里会是 NaN 比较恒假 / 下标乱跳');
  ok(Number.isInteger(idx) && idx >= 0 && idx < s.def.phases.length, '阶段下标落在 [0, phases.length)');

  /* 负对照:护盾在的时候,合法伤害仍先吃护盾 */
  const shielded = createBossState(BOSS_A.id, 1);
  shielded.shieldHp = 20;
  shielded.shieldSec = 8;
  const r2 = damageBoss(shielded, 50);
  eq(r2.toShield, 20, '负对照:20 点护盾先吃满');
  eq(r2.toHp, 30, '负对照:剩余 30 落到血量');
});

/* ═══════════════ 4. evaluateBreak 对缺字段给确定结论(breaks.ts) ═══════════════ */

test('FND108-4 evaluateBreak 喂 {}:八个 Boss 一律不抛、返回确定结论;合法输入语义不变', () => {
  for (const id of BREAK_BOSS_IDS) {
    const r = attempt(() => evaluateBreak(id, {}));
    ok(!r.threw, `★ ${id} 喂 {} 不得抛(${r.err})`);
    eq(r.value?.ok, false, `${id} 缺字段 ⇒ ok:false`);
    eq(typeof r.value?.ok, 'boolean', `${id} 缺字段 ⇒ ok 仍是严格布尔(改前 beaver 那条的与链给的是 undefined)`);
    ok(typeof r.value?.reason === 'string' && r.value!.reason.length > 0, `${id} 缺字段 ⇒ 给出非空 reason`);
  }

  /* 三条曾抛 TypeError 的判定:拒因单列,便于和「条件不满足」区分 */
  for (const id of ['boss_fox_kitsune', 'boss_scorpion_pharaoh', 'boss_chronos_colossus']) {
    eq(evaluateBreak(id, {}).reason, 'malformed_input', `★ ${id} 的拒因是「入参读不动」`);
  }

  /* 未知 Boss 仍是 unsupported(两条拒因不合并) */
  eq(evaluateBreak('boss_unknown', {}).reason, 'unsupported', '未知 Boss 仍是 unsupported');

  /* `breakCoverage()` 自己就对每个 Boss 喂 `{}` —— 改前它会被自己抛穿 */
  const cov = attempt(() => breakCoverage());
  ok(!cov.threw, `★ breakCoverage() 不得抛(${cov.err})`);
  eq(cov.value?.covered, 8, '覆盖度自检能跑完:8/8');

  /* 负对照:语义没被放宽 —— 四条布尔判定「条件全满足」仍为 ok:true */
  eq(evaluateBreak('boss_beaver_mecha', {
    damPresent: true, channelIntact: true, gateOpened: true, upstreamHigher: true,
  }).ok, true, '负对照:河狸四项全真 ⇒ 破防');
  eq(evaluateBreak('boss_beaver_mecha', {
    damPresent: true, channelIntact: false, gateOpened: true, upstreamHigher: true,
  }).ok, false, '负对照:渠道缺一格 ⇒ 不破防(退化成 false,不是 malformed_input)');
  eq(evaluateBreak('boss_ginger_troll', {}).reason, 'conditions_unmet', '形状合法但不满足 ⇒ conditions_unmet');
});

/* ═══════════════ 5. settleBridgeRun 幂等 + 相位门槛(party/modes.ts) ═══════════════ */

test('FND108-5 settleBridgeRun:相位未到不发安慰分,到点只发一次', () => {
  const clock = createManualClock(0);
  const r = createBridgeRun(clock, 'referee');
  startPartyMode(r.mode);
  eq(r.mode.phase, PARTY_PHASE.BUILD, '前置:造桥夺旗从 BUILD 起步');

  for (let i = 0; i < 12; i += 1) ok(bridgePlace(r, TEAM_KEY.RED), '红队摆满 12 块');
  for (let i = 0; i < 5; i += 1) ok(bridgePlace(r, TEAM_KEY.BLUE), '蓝队摆 5 块(未夺旗)');

  /* ★ 相位门槛:还在建造阶段就结算 ⇒ 不发安慰分,且不占用结算句柄 */
  const early = settleBridgeRun(r);
  eq(getTeam(r.mode.board, TEAM_KEY.BLUE).score, 0, '★ BUILD 阶段结算:蓝队安慰分 0(改前会是 5×2=10)');
  eq(r.mode.settlement, null, '★ 提早结算不占用结算句柄(后面的正常结算仍会发生)');
  eq(early.standing[0].team, TEAM_KEY.RED, '提早结算只是当前排名快照(红队并列时按 TEAM_ORDER 在前)');

  /* 跑到 RACE,红队夺旗 */
  clock.advance(15);
  const ev = tickPartyMode(r.mode);
  ok(ev.includes('PHASE:RACE'), '15s 进 RACE');
  ok(bridgeCapture(r, TEAM_KEY.RED), '红队夺旗成功');
  eq(getTeam(r.mode.board, TEAM_KEY.RED).score, 100, '红队 +100');

  /* RACE 中途结算:同样不发安慰分 */
  settleBridgeRun(r);
  eq(getTeam(r.mode.board, TEAM_KEY.BLUE).score, 0, '★ RACE 中途结算:蓝队仍是 0');

  /* 跑到 SETTLED 再结算 */
  clock.advance(30);
  ok(tickPartyMode(r.mode).includes('PHASE:SETTLED'), '45s 进 SETTLED');
  const st = settleBridgeRun(r);
  eq(getTeam(r.mode.board, TEAM_KEY.BLUE).score, 10, '★ SETTLED 结算:蓝队 5 块 × 2 = 10');
  eq(st.standing[0].team, TEAM_KEY.RED, '红队 100 分夺冠');
  eq(st.standing[0].value, 100, '冠军 100 分');

  /* ★ 幂等:再调一次一分不加,且拿到的是同一份结算 */
  const again = settleBridgeRun(r);
  eq(getTeam(r.mode.board, TEAM_KEY.BLUE).score, 10, '★ 第二次调用:安慰分没有翻倍(改前会变 20)');
  eq(getTeam(r.mode.board, TEAM_KEY.RED).score, 100, '红队仍是 100');
  ok(again === st, '★ 重复调用返回同一份结算对象(幂等)');

  /* 负对照:已夺旗的队伍永远不拿安慰分 */
  eq(getTeam(r.mode.board, TEAM_KEY.RED).score, 100, '负对照:夺旗队不再叠安慰分');
});

/* ═══════════════ 6. 急单:翻炒能压住 12 秒过热(coop/rush_order.ts) ═══════════════ */

function rushSession() {
  const clock = createManualClock(0);
  const s = createRushOrderSession({ clock, roomLevel: 1, seed: 7, rng: mulberry32(7) });
  startRushOrder(s);
  return { clock, s };
}

test('FND108-6 翻炒口:喂 tended ⇒ 12 秒不起火;不喂 ⇒ 必然起火(退化形态)', () => {
  /* 24 步 × 0.5s = 12.0s = `OVERHEAT_SEC` */
  const steps = Math.round(OVERHEAT_SEC / 0.5);

  /* ── 6a 退化形态(负对照):生产今天就是这样,`tended` 恒缺 ── */
  const bare = rushSession();
  let fireEvents = 0;
  for (let i = 0; i < steps; i += 1) {
    fireEvents += tickRushOrder(bare.s, 0.5, { spawnBeaver: false }).filter((e) => e === EVT_FIRE).length;
  }
  eq(fireEvents, 3, `★ 不喂 tended ⇒ 三个工位在 ${OVERHEAT_SEC}s 同时到点起火(实测起火事件 ${fireEvents} 次)`);
  for (const st of bare.s.stations) {
    eq(st.state, STATION_STATE.BURNING, `★ ${st.kind} 进入 BURNING(与「有没有人翻炒」无关)`);
  }

  /* ── 6b 有人翻炒:三个工位每步都被照看 ⇒ 一步过热都不涨 ── */
  const tended = rushSession();
  const all = [STATION_KIND.FURNACE, STATION_KIND.POT, STATION_KIND.CUTTER];
  let tendedFires = 0;
  for (let i = 0; i < steps; i += 1) {
    tendedFires += tickRushOrder(tended.s, 0.5, { tended: all, spawnBeaver: false })
      .filter((e) => e === EVT_FIRE).length;
  }
  eq(tendedFires, 0, `★ 喂了 tended ⇒ ${OVERHEAT_SEC}s 内不起火`);
  for (const st of tended.s.stations) {
    eq(st.state, STATION_STATE.RUNNING, `${st.kind} 仍是 RUNNING`);
    eq(st.runningSec, 0, `${st.kind} 的连续运转秒数被翻炒清零`);
  }

  /* ── 6c 读口口径:只认 RUNNING;位置判到格中心 ── */
  const mixed = rushSession();
  let mixedFires = 0;
  for (let i = 0; i < steps; i += 1) {
    mixedFires += tickRushOrder(mixed.s, 0.5, { tended: [STATION_KIND.POT, STATION_KIND.CUTTER], spawnBeaver: false })
      .filter((e) => e === EVT_FIRE).length;
  }
  eq(mixedFires, 1, '★ 只照看两个工位 ⇒ 只有没人照看的高炉起火(1 次)');
  eq(mixed.s.stations[0].state, STATION_STATE.BURNING, '前置:只让高炉烧起来(另两个被照看)');
  eq(mixed.s.stations[1].state, STATION_STATE.RUNNING, '前置:汤锅没烧');

  const furnaceAt = cellCenterOf(DEFAULT_STATION_CELLS[STATION_KIND.FURNACE]);
  const potAt = cellCenterOf(DEFAULT_STATION_CELLS[STATION_KIND.POT]);
  eq(stationsBeingTendedBy(mixed.s, furnaceAt), [], '★ 在烧的工位不算「可翻炒」(该用 227 灭火)');
  eq(stationsBeingSprayedBy(mixed.s, furnaceAt), [STATION_KIND.FURNACE], '★ 同一格,灭火口认它');
  eq(stationsBeingTendedBy(mixed.s, potAt), [STATION_KIND.POT], '★ RUNNING 的工位按格中心命中');
  eq(stationsBeingTendedBy(mixed.s, potAt, 0), [STATION_KIND.POT], '半径 0 格是**闭区间**:正落格中心 ⇒ 命中');
  eq(stationsBeingTendedBy(null, potAt), [], 'null 会话(没开急单)⇒ 空数组,不抛');
  eq(stationsBeingTendedBy(mixed.s, { x: Number.NaN, y: 0.5 }), [], 'NaN 坐标 ⇒ 空数组');
  eq(stationsBeingTendedBy(mixed.s, potAt, -1), [], '负半径 ⇒ 空数组');
  eq(stationsBeingTendedBy(mixed.s, { x: 0, y: 0 }, 0.5), [], '负对照:半径 0.5 格时格角 (0,0) 落空(判的是格中心)');
});

report('WS-FND-108');