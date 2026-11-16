/**
 * WS-FND-42 —— **赛局计分规则**(事件 → 分:纯函数)。
 *
 * ## 这个套件为什么存在
 *
 * `net/actions/start_party.ts` 早就有 `addScore` / `endParty`,但**没有任何生产调用点**
 * ⇒ 分数永远停在 0。缺的那一环正是「游戏里发生的事实」→「该给谁加多少分」的**规则**:
 * 它必须在**世界侧**能被调、必须**纯**(同一输入两次结果相同、不改入参、不看时钟),
 * 否则世界侧的慢帧循环一调它就会把状态搅乱,名次还会随事件到达顺序漂移。
 *
 * 被测:`server/src/party/scoring.ts` 末尾那一节的 `scoreOfPartyEvent` / `tallyPartyScores`。
 * 世界侧今天的落点:`sim/world_sim.ts:4102` 已经把赛局事件送上总线
 * (`this.bus.emit('party_event', { kind: ev })`),再接上本函数 + `addScore` 即可(主线做)。
 *
 * ## 本套件钉的不是「有个数」,而是**数值的锚与边界**
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 击杀按模式给分:BRIDGE_CTF **2** / JELLY_BALL **1** / CROWN_BR **1** / PAINT_WAR **1** | 把某个模式的分改掉(注入验证用的就是这条) |
 * | 2 | 两个模式给分**不同**且都 > 0(击杀 2 vs 1;夺旗 100 vs 涂色 1) | 把模式差异抹平(所有模式同一个数) |
 * | 3 | 未登记事件类型 ⇒ **0 分**(不抛错、不默认给 1) | 加 `?? 1` 兜底 / 让未知类型走默认分支 |
 * | 4 | 纯:同输入两次结果逐字节相同;调用前后入参 `JSON.stringify` 一致(冻结入参也能算) | 往事件对象上写字段(缓存/规范化) |
 * | 5 | 顺序无关:打乱输入后批量结果**逐字节相同**,行序是 `playerId` 码元序 | 用 `Map` 插入序当行序 |
 * | 6 | 分数恒为**有限、整数、非负**;负载里的 `points` / `score` 进不了分 | 拿 `payload` 里的数当分(事件可刷分) |
 * | 7 | 模式未定义/非法(`NONE` / 空串 / 大小写不对)⇒ **显式拒绝**:`accepted=false` + 0 分 + 理由 | 非法模式兜底成某个默认模式 |
 * | 8 | 采集/拾取同样按模式给分;落点 `metric` 与队伍归属可读 | 把落点写死成 `score` / 不回队伍 |
 * | 9 | 批量累加:同批里不同事件按落点拆开(`byMetric`) | 累加时丢掉落点(世界侧就没法落板) |
 *
 * ## 数值的出处(断言右侧的字面量,逐条可查)
 *
 * ```
 *   BRIDGE_CTF 2    modes.ts:213 BRIDGE_SCORE_PER_TILE = 2「每一步建造/冲刺折算的团队分」
 *                   docs/WS-11-coop-prank-party.md:453「未夺旗队 + 2 × built(安慰分)」
 *   BRIDGE_CTF 100  modes.ts:212 BRIDGE_SCORE_PER_FLAG = 100(夺旗分)
 *                   docs/WS-11-coop-prank-party.md:453「夺旗队 +100」
 *   JELLY_BALL 1    modes.ts:405 `ts.score += 1`(进球);docs/…:463「对手队 goals++、score++」
 *   CROWN_BR   1    modes.ts:519 `crownSec += dt` + modes.ts:537 以 crownSec 为团队 value
 *   PAINT_WAR  1    modes.ts:614 `tiles = tiles` + modes.ts:629 以 tiles 为 value
 *   CROWN_BR 到达 0 modes.ts:518-520 分在 `tickCrown` 的持冠秒上累积 ⇒ 拾冠本身不加分
 * ```
 * 事件词表(`party_creature_kill` / `party_gather` / `party_reach_target`)在测试里**写成
 * 字面量**而不是取被测模块的导出常量:这样连词表本身也被钉住(`--strict-taut`)。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { scoreOfPartyEvent, tallyPartyScores } from '../server/src/party/scoring.ts';

/* 三种事件与四个模式的**字面量**(不取被测模块的导出常量)。 */
const KILL = 'party_creature_kill';
const GATHER = 'party_gather';
const REACH = 'party_reach_target';

const BRIDGE = 'BRIDGE_CTF';
const JELLY = 'JELLY_BALL';
const CROWN = 'CROWN_BR';
const PAINT = 'PAINT_WAR';

type Payload = Record<string, number | string | boolean>;

/** 事件构造器:形状与 `events/bus.ts` 的 `GameEvent` 子集一致(`kind` + `source` + `payload`)。 */
function ev(kind: string, source = 'p1', payload?: Payload): { kind: string; source: string; payload?: Payload } {
  return payload === undefined ? { kind, source } : { kind, source, payload };
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND42-1 击杀生物 ⇒ 按模式给分(数值锚:modes.ts:213 / modes.ts:405 / crownSec / tiles)', () => {
  const bridge = scoreOfPartyEvent(BRIDGE, ev(KILL, 'p1'));
  eq(bridge.accepted, true, '击杀是登记事件,必须计价');
  eq(bridge.points, 2, '造桥夺旗:最小一档分 = 一块桥板的 2 分(modes.ts:213)');
  eq(bridge.metric, 'score', '造桥夺旗落团队分');
  eq(bridge.playerId, 'p1', '归属事件的 source');
  ok(bridge.reason.length > 0, '回执要带可读口径(数值 + 它的锚)');

  eq(scoreOfPartyEvent(JELLY, ev(KILL, 'p2')).points, 1, '果冻球:进球级 1 分(modes.ts:405)');
  eq(scoreOfPartyEvent(CROWN, ev(KILL, 'p3')).points, 1, '抢皇冠:1 秒持冠 = 1 分(modes.ts:519/537)');
  eq(scoreOfPartyEvent(PAINT, ev(KILL, 'p4')).points, 1, '涂色:1 格色块 = 1 分(modes.ts:614/629)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND42-2 两个模式给分必须不同,且都大于 0', () => {
  const bridge = scoreOfPartyEvent(BRIDGE, ev(KILL)).points;
  const jelly = scoreOfPartyEvent(JELLY, ev(KILL)).points;
  eq(bridge, 2, '造桥夺旗 2');
  eq(jelly, 1, '果冻球 1');
  ok(bridge > 0 && jelly > 0, '两侧都必须 > 0');
  ok(bridge !== jelly, '★ 模式差异真的存在(不是所有模式同一个数)');

  /* 主目标件的差异更极端:夺旗 100 vs 涂色 1 分/格。 */
  const flag = scoreOfPartyEvent(BRIDGE, ev(REACH)).points;
  const tile = scoreOfPartyEvent(PAINT, ev(REACH)).points;
  eq(flag, 100, '夺旗 = 100 分(BRIDGE_SCORE_PER_FLAG,modes.ts:212)');
  eq(tile, 1, '涂色 1 分/格(settlePaintWar 以 tiles 为 value)');
  ok(flag > tile && tile > 0, '★ 差异与下界同时成立');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND42-3 未登记的事件类型 ⇒ 不给分(不是抛错、也不是默认给 1)', () => {
  for (const kind of ['party_unknown', 'boar_wall_stun', '', 'PARTY_CREATURE_KILL']) {
    const a = scoreOfPartyEvent(BRIDGE, { kind, source: 'p1' });
    eq(a.points, 0, `未登记类型「${kind}」必须 0 分`);
    eq(a.accepted, false, `未登记类型「${kind}」必须被判为未计价`);
    ok(a.reason.length > 0, '被拒也要有可读理由');
  }

  /* 批量入口同一口径:未登记的那条只进 rejectedEvents,不进分。 */
  const rows = tallyPartyScores(BRIDGE, [ev(KILL, 'p1'), { kind: 'boar_wall_stun', source: 'p1' }]);
  eq(rows.length, 1, '只有 p1 有事件');
  eq(rows[0]!.points, 2, '只有登记的那条(击杀 2 分)进分');
  eq(rows[0]!.acceptedEvents, 1, '计价事件数 1');
  eq(rows[0]!.rejectedEvents, 1, '未计价事件数 1');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND42-4 纯函数:同输入两次结果相同,且一个字节都不改入参', () => {
  const event = { kind: REACH, source: 'p1', payload: { team: 'BLUE', points: 9999, atSec: 12.5 } };
  const before = JSON.stringify(event);

  const first = scoreOfPartyEvent(BRIDGE, event);
  const second = scoreOfPartyEvent(BRIDGE, event);

  eq(JSON.stringify(event), before, '★ 调用前后入参 JSON.stringify 一致');
  eq(first, second, '整条回执深比较相同');
  eq(JSON.stringify(first), JSON.stringify(second), '★ 同输入两次结果逐字节相同');

  /* 冻结入参:任何写入都会在严格模式下抛错 —— 这条比"读完再比"更硬。 */
  const frozen = Object.freeze({ kind: GATHER, source: 'p2', payload: Object.freeze({ team: 'RED' }) });
  eq(scoreOfPartyEvent(JELLY, frozen).points, 1, '冻结入参照样能算');

  const events = [ev(KILL, 'p1'), ev(GATHER, 'p2'), ev(REACH, 'p3')];
  const snap = JSON.stringify(events);
  tallyPartyScores(BRIDGE, events);
  eq(JSON.stringify(events), snap, '★ 批量入口也不改入参数组(顺序与内容都不动)');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND42-5 分数不因传入顺序而变(行序是 playerId 码元序,不是到达顺序)', () => {
  const events = [
    ev(KILL, 'p_b'),
    ev(REACH, 'p_a'),
    ev(GATHER, 'p_b'),
    ev(KILL, 'p_a'),
    { kind: 'party_unknown', source: 'p_b' },
  ];

  const forward = tallyPartyScores(BRIDGE, events);
  const reversed = tallyPartyScores(BRIDGE, [...events].reverse());
  const resorted = tallyPartyScores(BRIDGE, [...events].sort((x, y) => (x.kind < y.kind ? 1 : x.kind > y.kind ? -1 : 0)));

  eq(JSON.stringify(reversed), JSON.stringify(forward), '★ 反序后逐字节相同');
  eq(JSON.stringify(resorted), JSON.stringify(forward), '★ 按 kind 重排后逐字节相同');

  eq(forward.map((r) => r.playerId), ['p_a', 'p_b'], '行序按 playerId 码元序(p_a < p_b)');
  eq(forward[0]!.points, 102, 'p_a:夺旗 100 + 击杀 2 = 102');
  eq(forward[1]!.points, 4, 'p_b:击杀 2 + 采集 2 = 4(未登记的 0 分)');
  eq(forward[1]!.rejectedEvents, 1, 'p_b 有 1 条未计价事件');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND42-6 边界:一次事件的分数是有限整数、非负;负载里的数字进不了分', () => {
  const modes = [BRIDGE, JELLY, CROWN, PAINT];
  const kinds = [KILL, GATHER, REACH, 'party_unknown'];
  for (const m of modes) {
    for (const k of kinds) {
      const p = scoreOfPartyEvent(m, ev(k, 'p1')).points;
      ok(Number.isFinite(p), `${m} / ${k}:分数必须有限(实测 ${p})`);
      ok(Number.isInteger(p), `${m} / ${k}:分数必须是整数(实测 ${p})`);
      ok(p >= 0, `${m} / ${k}:分数必须非负(实测 ${p})`);
    }
  }

  const clean = scoreOfPartyEvent(BRIDGE, ev(KILL, 'p1')).points;
  const injected = scoreOfPartyEvent(BRIDGE, ev(KILL, 'p1', { points: 999999, score: -8, units: 1e9 })).points;
  eq(clean, 2, '基线:造桥夺旗击杀 = 2 分');
  eq(injected, 2, '★ 负载里的 points / score / units 一概不进分(否则一条事件就能刷分)');

  eq(scoreOfPartyEvent(BRIDGE, { kind: KILL }).playerId, null, '没有 source ⇒ 归属不到人');
  eq(scoreOfPartyEvent(BRIDGE, { kind: KILL }).points, 2, '没有 source 不影响分数本身');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND42-7 模式未定义 / 非法 ⇒ 明确拒绝(accepted=false + 0 分 + 理由;不抛错)', () => {
  /* 选「返回 0」而不是「抛错」并钉住:世界侧在慢帧循环里逐个事件调它,抛错会把整帧打死。 */
  for (const m of ['NONE', '', 'bridge_ctf', 'BRIDGE', 'party']) {
    const a = scoreOfPartyEvent(m, ev(KILL, 'p1'));
    eq(a.accepted, false, `模式「${m}」必须被拒`);
    eq(a.points, 0, `模式「${m}」必须 0 分`);
    ok(a.reason.includes('模式'), `模式「${m}」的理由必须指明是模式问题`);
  }

  /* 缺参也不崩(JS 调用方没有类型检查)。 */
  const missing = scoreOfPartyEvent(undefined as unknown as string, ev(KILL, 'p1'));
  eq(missing.accepted, false, '没传模式 ⇒ 拒绝');
  eq(missing.points, 0, '没传模式 ⇒ 0 分');

  /* 批量入口同样拒绝:非法模式下不产生任何非零分。 */
  const rows = tallyPartyScores('NONE', [ev(KILL, 'p1'), ev(REACH, 'p2')]);
  eq(rows.map((r) => r.points), [0, 0], '非法模式下每行都是 0 分');
  eq(rows.map((r) => r.rejectedEvents), [1, 1], '两条都记为未计价');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND42-8 采集/拾取按模式给分;落点(metric)与队伍归属可被世界侧读到', () => {
  eq(scoreOfPartyEvent(BRIDGE, ev(GATHER)).points, 2, '造桥夺旗:采集/拾取 2 分');
  eq(scoreOfPartyEvent(JELLY, ev(GATHER)).points, 1, '果冻球:1 分');
  eq(scoreOfPartyEvent(CROWN, ev(GATHER)).points, 1, '抢皇冠:1 分');
  eq(scoreOfPartyEvent(PAINT, ev(GATHER)).points, 1, '涂色:1 分');

  eq(scoreOfPartyEvent(BRIDGE, ev(REACH)).metric, 'score', '夺旗落 score');
  eq(scoreOfPartyEvent(JELLY, ev(REACH)).metric, 'goals', '进球落 goals(与 judgeGoal 的 ts.goals += 1 同一栏)');
  eq(scoreOfPartyEvent(PAINT, ev(REACH)).metric, 'tiles', '涂色落 tiles(与 settlePaintWar 同一栏)');
  eq(scoreOfPartyEvent(CROWN, ev(REACH)).metric, 'crownSec', '抢皇冠落 crownSec');
  eq(scoreOfPartyEvent(CROWN, ev(REACH)).points, 0, '★ 抢皇冠的分在持冠秒上累积 ⇒ 拾冠本身 0 分');

  eq(scoreOfPartyEvent(BRIDGE, ev(REACH, 'p1', { team: 'BLUE' })).team, 'BLUE', '负载里的合法队伍被透传');
  eq(scoreOfPartyEvent(BRIDGE, ev(REACH, 'p1', { team: 'PURPLE' })).team, null, '非四色 ⇒ null(由调用方按玩家归属折算)');
  eq(scoreOfPartyEvent(BRIDGE, ev(REACH)).team, null, '没带 team ⇒ null');
});

/* ───────────────────────── 9 ───────────────────────── */

test('FND42-9 批量累加:同批里不同事件各按其落点拆开(世界侧据此落板)', () => {
  const jelly = tallyPartyScores(JELLY, [ev(REACH, 'p1'), ev(REACH, 'p1'), ev(KILL, 'p1'), ev(GATHER, 'p1')]);
  eq(jelly.length, 1, '同一个玩家一行');
  eq(jelly[0]!.points, 4, '果冻球:2 个进球(1+1)+ 击杀 1 + 采集 1 = 4 分');
  eq(jelly[0]!.byMetric.goals, 2, '进球落 goals 栏');
  eq(jelly[0]!.byMetric.score, 2, '击杀 + 采集落 score 栏');
  eq(jelly[0]!.acceptedEvents, 4, '4 条都计价');
  eq(jelly[0]!.rejectedEvents, 0, '没有未计价事件');

  const bridge = tallyPartyScores(BRIDGE, [ev(REACH, 'p1'), ev(REACH, 'p1'), ev(KILL, 'p1'), ev(GATHER, 'p1')])[0]!;
  eq(bridge.points, 204, '造桥夺旗:2 次夺旗 200 + 击杀 2 + 采集 2 = 204 分');
  eq(bridge.byMetric.score, 204, '夺旗模式的落点全在 score 栏');
  eq(bridge.byMetric.goals, 0, '没出现的落点是 0(键恒在)');
});

report('WS-FND-42');
