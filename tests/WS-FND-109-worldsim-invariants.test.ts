/**
 * WS-FND-109 —— 第四轮实测里 `server/src/sim/world_sim.ts` 的**五处**缺陷的判据。
 *
 * | # | 判据 | 修的是什么 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | 材料不足 ⇒ `ok:false` **且地面逐字段不变**;够料 ⇒ 每件扣 1 + 产物落地 | `forgeAlchemy` 逐项扣料,某项不足就 `return` ⇒ 已扣的**永久消失**(与「`ok:false` 时世界完全未被改动」自述矛盾) | `consumeMaterialsFor` 的「先全量复核」整段删掉(不再还原) |
 * | 2 | **注入**:第 2 项扣不满 ⇒ `ok:false` + **已扣的全部还原**(件数 + 次序) | 同上 | `consumeMaterialsFor` 里的还原分支(`order/counts` 那三行)删掉 |
 * | 3 | **注入**:`await forge(...)` 期间地面被清空 ⇒ 复核拦在扣减**之前**(`consumeGroundItem` **零调用**) | 复核只在 `await` **之前** ⇒ 那句话到扣料之间可被并发改动 | `consumeMaterialsFor` 里的复核循环(回到「只信 await 之前那次」) |
 * | 4 | 浇灭后 `relightStationAt` 真复位;本来就点着 ⇒ `false` | `extinguishStationAt` 置 `fireOut` 后**全仓无复位路径** ⇒ 一次灭火永久失效 | `relightStationAt` 的 `k.fireOut = false` 删掉(或整方法删掉) |
 * | 5 | 灭火后投料**被拒且料落地**(与 `WS-14` C3 同口径);`relightStationAt` 重新点火后同一批料才进锅 → 出锅 | 同上(单向闩锁) | 源码里 `relightStationAt` 的 `k.fireOut = false` 删掉(此时本条与判据 4 一起红) |
 * | 6 | `removePlayer` 清**玩法表** `afkRuns`(慢帧 `afkTicked` 归零);不调 ⇒ 计数仍 1 | `removePlayer` 只删连接态 `afkPlayers`,`afkRuns`(`dew`/`backgroundedAtSec`/`dozedSec`)从不清 ⇒ 同名重连继承上轮打盹 | `removePlayer` 里的 `this.afkRuns.delete(id);` |
 * | 7 | 结构:`removePlayer` 体内 `this.knockbacks.delete(id);` **只出现 1 次**;`afkRuns.delete` 在册 | 连续两行逐字相同的重复行 | 重复行加回去 |
 * | 8 | 结构 + 行为:生产代码 `.startPartyRun(` **有**调用点;`GATHER` / `REACH_TARGET` 各 **≥1** 个真发射点;真调一次 `startPartyRun` 后 `partyPhase()` **不再 IDLE** | 注释声称「三个发射点」而实测只有一个;`startPartyRun` 全仓零调用 ⇒ `partyRun` 恒 null | 摘掉哨台入口 / 摘掉某一个发射点 |
 *
 * ## 判据 8 的翻面(第六轮:Z3 已接线)
 *
 * 第四轮写这条时,世界侧只发得出 `CREATURE_KILL`,而 `startPartyRun` 全仓零调用 ——
 * 那时判据是「**零**调用 / **零**发射点 / `partyPhase()` 恒 IDLE」。
 * 第六轮 Z3 把哨台入口接进 `tickPartyStep`(`world_sim.ts` 的 `stepRefereeDesk`),
 * 并补上 `REACH_TARGET`(`scanPartyTeams`)与 `GATHER`(`stepRushDelivery`)两个发射点 ⇒
 * **那条台账不再是事实**,判据必须跟着翻面,否则它只是在守一个已经修好的缺陷。
 * 翻面后仍要能证伪,故三件事一起断言:
 * ```
 * 1 `.startPartyRun(` 在生产代码里有调用点(摘掉哨台入口 ⇒ 红);
 * 2 `GATHER` / `REACH_TARGET` 各有一个**真发射点**(用 `this.notePartyEvent({ kind: …`
 *   的**代码形态**计数 —— 只数 `PARTY_SCORE_EVENT.GATHER` 这个词会把注释也算进去,
 *   本文件 `world_sim.ts:3313` 的台账就写着它);
 * 3 **行为**:真调一次 `startPartyRun` ⇒ `partyPhase()` 不再是 `'IDLE'`。
 * ```
 * ⚠️ 第 3 条才是真守卫:前两条只能证明「代码里出现过」,证明不了「真的能开赛」。
 *
 * ## 断言右侧一律用**字面量**
 *
 * `506` / `104` / `124` / `121` / `604` / `101` / `102` / `103` / `1` 取自**冻结内容表**
 * (物件 id、道具 id、`cooking.ts:179` 的 `SOUP_NORMAL_RECIPE` 与 `cooking.ts:384` 的
 * 兜底料理 604),不取被测模块的导出常量 —— 否则就是同义反复。
 *
 * 运行:`node tests/WS-FND-109-worldsim-invariants.test.ts`
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 506 大汤锅(料理站里唯一有 `cookSoup` 实现的那一个)。 */
const SOUP_POT = 506;
/** 一套能过门禁的三件材料(与 `WS-FND-08` 同一组:木材 ×3 命中载体 + 机制)。 */
const MATERIALS = [101, 102, 103];

/** 造一个「地面已有材料」的世界。 */
function worldWithMaterials(): WorldSim {
  const sim = new WorldSim({ sizeCells: 32 });
  sim.setGroundItems([
    { id: 101, x: 4, y: 4, count: 4 },
    { id: 102, x: 5, y: 4, count: 4 },
    { id: 103, x: 6, y: 4, count: 4 },
  ]);
  return sim;
}

/** 地面快照:**次序 + 格 + 件数**都记 —— 「世界未被改动」必须是逐字段的。 */
function groundSnapshot(sim: WorldSim): { id: number; x: number; y: number; count: number }[] {
  return sim.groundItems.map((g) => ({ id: g.id, x: g.x, y: g.y, count: g.count }));
}

/** 走够一个慢帧(`FAST_PER_SLOW = 20Hz / 2Hz = 10` 快帧),保证 `tickPartyStep` 真的跑过。 */
/**
 * 推进**恰好一个慢帧**(慢帧 stride = `SLOW_DT` 秒 = `FAST_PER_SLOW` 快帧)。
 *
 * ⚠️ 旧写法默认 10 帧把「20Hz 下的一个慢帧」写死了 —— 32Hz 下 10 帧只有 0.31 秒,
 * 一个慢帧都跑不到 ⇒ 玩法表(`afkRuns` / `lastPartyTick`)永远是空的。
 * 任意 `FAST_PER_SLOW` 个**连续**帧内恰好命中一个慢帧(`frame % stride === 0`)。
 */
function tickSlow(sim: WorldSim, times = FAST_PER_SLOW): void {
  for (let i = 0; i < times; i += 1) sim.tick();
}

function occurrenceCount(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/* ════════════ 1 / 2 / 3:forgeAlchemy 的库存与原子扣料 ════════════ */

/* 1-a 材料不足:早退,地面不动 */
const simShort = new WorldSim({ sizeCells: 32 });
simShort.setGroundItems([{ id: 101, x: 1, y: 1, count: 1 }]);
const beforeShort = groundSnapshot(simShort);
const rShort = await simShort.forgeAlchemy(MATERIALS, { playerName: '回归', seed: 7 });

/* 1-b 够料:扣满 3 件 + 产物落地 */
const simOk = worldWithMaterials();
const rOk = await simOk.forgeAlchemy(MATERIALS, { playerName: '回归', seed: 7, x: 12, y: 12 });

/*
 * 2 注入:第 2 项材料扣不满。
 * 直接改写实例上的 `consumeGroundItem`(扣料的**唯一**通道)⇒ 命中那条防守分支。
 * ⚠️ 断言不能只看 `ok:false`:必须看**地面被还原**。
 */
const simInject = worldWithMaterials();
const beforeInject = groundSnapshot(simInject);
const injectedCalls: number[] = [];
{
  const patch = simInject as unknown as { consumeGroundItem: (itemId: number, count: number) => number };
  const realConsume = patch.consumeGroundItem.bind(simInject);
  patch.consumeGroundItem = (itemId, count) => {
    injectedCalls.push(itemId);
    return itemId === 102 ? 0 : realConsume(itemId, count);
  };
}
const rInject = await simInject.forgeAlchemy(MATERIALS, { playerName: '回归', seed: 7 });

/*
 * 3 注入:`await forge(...)` 期间地面被别的系统清空。
 * 判据不是"返回 ok:false"(那两条实现都返回它),而是**扣料通道一次都没被碰**:
 * 复核必须发生在扣减前一刻(同一段同步代码),而不是只信 `await` 之前那次。
 */
const simRace = worldWithMaterials();
let raceConsumeCalls = 0;
{
  const patch = simRace as unknown as { consumeGroundItem: (itemId: number, count: number) => number };
  const realConsume = patch.consumeGroundItem.bind(simRace);
  patch.consumeGroundItem = (itemId, count) => {
    raceConsumeCalls += 1;
    return realConsume(itemId, count);
  };
  const alch = simRace.alchemy as unknown as { forge: (input: unknown) => Promise<{ ok: boolean }> };
  alch.forge = async () => {
    simRace.setGroundItems([]);
    return { ok: true };
  };
}
const rRace = await simRace.forgeAlchemy(MATERIALS, { playerName: '回归', seed: 7 });

/* ════════════ 4 / 5:炉火的重燃路径 ════════════ */

/** 一张安静的图:506 在 (4,4)。 */
function potScene(): WorldSim {
  const sim = new WorldSim({ sizeCells: 16, mobs: false });
  sim.setCell(4, 4, { obj: SOUP_POT });
  return sim;
}

/* 4 显式复位口 */
const simRelight = potScene();
simRelight.extinguishStationAt(SOUP_POT);
const fireOutAfterExtinguish = simRelight.stationState(SOUP_POT).fireOut;
const relightFirst = simRelight.relightStationAt(SOUP_POT);
const fireOutAfterRelight = simRelight.stationState(SOUP_POT).fireOut;
const relightSecond = simRelight.relightStationAt(SOUP_POT);

/* 5-a 灭火后投料被拒:料留在地面(与 `WS-14` 的 C3 负对照**同口径** —— 灭火不是"投件料就自动好") */
const simFeed = potScene();
simFeed.extinguishStationAt(SOUP_POT);
simFeed.setGroundItems([
  { id: 104, x: 4, y: 4, count: 1 },
  { id: 124, x: 4, y: 4, count: 2 },
  { id: 121, x: 4, y: 4, count: 2 },
]);
const fedWhileOut = simFeed.feedStationAt(SOUP_POT, 4, 4, 9);
const fedWhileOutGround = groundSnapshot(simFeed).length;
const fedWhileOutFireOut = simFeed.stationState(SOUP_POT).fireOut;
const fedWhileOutFed = simFeed.stationState(SOUP_POT).fedTotal;
const fedWhileOutCooked = simFeed.stationState(SOUP_POT).cooked;

/* 5-b **重新点火**之后,同一批料这才进锅 → 出锅(修前 fireOut 永不复位 ⇒ 这口锅永久废掉) */
const relightForFeed = simFeed.relightStationAt(SOUP_POT);
const fedAfterRelight = simFeed.feedStationAt(SOUP_POT, 4, 4, 9);
const feedFireOut = simFeed.stationState(SOUP_POT).fireOut;
const feedCooked = simFeed.stationState(SOUP_POT).cooked;
const feedItemId = simFeed.stationState(SOUP_POT).lastItemId;

/* 5-b 负对照:灭了的锅 + 该格**无货** ⇒ 不得空点火 */
const simEmpty = potScene();
simEmpty.extinguishStationAt(SOUP_POT);
const fedEmpty = simEmpty.feedStationAt(SOUP_POT, 4, 4, 1);
const emptyFireOut = simEmpty.stationState(SOUP_POT).fireOut;

/* ════════════ 6 / 7:removePlayer 的两张表 ════════════ */

const simAfk = new WorldSim({ sizeCells: 16, mobs: false });
simAfk.setPlayerDozing('p1', 10);
simAfk.addPlayer('p1', 8, 8);
tickSlow(simAfk);
const afkTickedBefore = simAfk.lastPartyTick.afkTicked;
const removed = simAfk.removePlayer('p1');
tickSlow(simAfk);
const afkTickedAfter = simAfk.lastPartyTick.afkTicked;
const dozingAfterRemove = simAfk.dozingCount();
const foregroundAfterRemove = simAfk.setPlayerDozing('p1', null);

/* 6 负对照:不调 removePlayer ⇒ 记录留下(证明上面那条不是恒真) */
const simKeep = new WorldSim({ sizeCells: 16, mobs: false });
simKeep.setPlayerDozing('p1', 10);
simKeep.addPlayer('p1', 8, 8);
tickSlow(simKeep);
const keepAfkTicked = simKeep.lastPartyTick.afkTicked;
const keepForeground = simKeep.setPlayerDozing('p1', null);

/* 7 结构:方法体里那一行只许出现一次 */
const WORLD_SIM_SRC = readFileSync(join(ROOT, 'server/src/sim/world_sim.ts'), 'utf8');

/** 摘出某个方法的方法体(签名 → 下一个缩进两格的 `}`)。 */
function bodyOf(src: string, signature: string): string {
  const i = src.indexOf(signature);
  if (i < 0) return '';
  const end = src.indexOf('\n  }', i);
  return end < 0 ? '' : src.slice(i, end);
}

/* ════════════ 8:台账(生产零调用 / 零假发射点)════════════ */

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFilesUnder(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const START_PARTY_CALL = /\.startPartyRun\(/;
const prodFiles = [
  ...tsFilesUnder(join(ROOT, 'server/src')),
  ...tsFilesUnder(join(ROOT, 'shared')),
  ...tsFilesUnder(join(ROOT, 'client/src')),
];
const prodCallers = prodFiles.filter((f) => START_PARTY_CALL.test(readFileSync(f, 'utf8')));
const testCallers = tsFilesUnder(join(ROOT, 'tests')).filter((f) => START_PARTY_CALL.test(readFileSync(f, 'utf8')));

const simParty = new WorldSim({ sizeCells: 16, mobs: false });
simParty.setPlayerDozing('x', 0);
tickSlow(simParty);
const partyTicked = simParty.lastPartyTick.partyTicked;
const afkTickedForParty = simParty.lastPartyTick.afkTicked;
const phase = simParty.partyPhase();

/* ══════════════════════════ 判据 ══════════════════════════ */

test('FND109-1 ★P1 材料不足 ⇒ ok:false 且地面逐字段不变(负对照:够料 ⇒ 扣满 + 产物落地)', () => {
  eq(rShort.ok, false, '材料不足必须被拒(不是假装成功)');
  if (!rShort.ok) eq(rShort.stage, 'INVENTORY', '拒绝要发生在**库存**阶段(不是门禁)');
  eq(groundSnapshot(simShort), beforeShort, '★ 拒绝路径必须一个字段都不动(件数 / 格 / 次序)');

  /* 正对照:同一套材料够 ⇒ 真的扣 */
  eq(rOk.ok, true, `够料必须合成成功:${rOk.ok ? '' : rOk.stage + ' ' + rOk.message}`);
  if (!rOk.ok) return;
  eq(rOk.consumed.length, 3, '三件材料各扣 1(逐项账)');
  for (const c of rOk.consumed) eq(c.count, 1, `材料 ${c.itemId} 应扣 1 件`);
  const after = groundSnapshot(simOk);
  eq(after.length, 4, '★ 3 堆材料各剩 3 件 + 1 件产物 = 4 堆(材料未消失、产物真落地)');
  eq(after[0], { id: 101, x: 4, y: 4, count: 3 }, '101 只被扣 1 件');
  eq(after[3]!.id, -1, '产物用负数占位 ID 落地(0 会被当空槽吞掉)');
});

test('FND109-2 ★P1 注入:扣料中途被改 ⇒ ok:false + 已扣的**全部还原**', () => {
  ok(injectedCalls.length > 0, '前置:注入真的生效了(否则下面的"还原"是在测没跑过的分支)');
  ok(injectedCalls.includes(101), '前置:第一项材料已经被扣下去了(才有"已扣"需要还原)');
  ok(injectedCalls.includes(102), '前置:第二项就是被注入改成 0 的那个');
  eq(rInject.ok, false, '有一项扣不满 ⇒ 整体必须放弃');
  if (!rInject.ok) eq(rInject.stage, 'INVENTORY', '失败阶段如实报 INVENTORY');
  eq(groundSnapshot(simInject), beforeInject, '★★ 已扣的那几项必须**原格原量原次序**放回(修前是永久消失)');
});

test('FND109-3 ★P1 注入:`await forge` 期间地面被清空 ⇒ 复核拦在扣减之前(扣料通道零调用)', () => {
  eq(raceConsumeCalls, 0, '★★ 复核不通过就**一件都不许碰**:扣料通道必须零调用(修前会带着旧的复核结果去扣)');
  eq(rRace.ok, false, '库存已空 ⇒ 必须 ok:false,而不是拿旧结论去扣');
  if (!rRace.ok) eq(rRace.stage, 'INVENTORY', '如实报 INVENTORY');
});

test('FND109-4 ★P2 炉火可逆:`relightStationAt` 真复位;本来就点着 ⇒ false', () => {
  eq(fireOutAfterExtinguish, true, '前置:浇灭真的置位了');
  eq(relightFirst, true, '★ 重燃必须返回 true(修前全仓没有复位路径 ⇒ 灭火是单向闩锁)');
  eq(fireOutAfterRelight, false, '★ 炉火真的重新点着了(不是只回了 true)');
  eq(relightSecond, false, '负对照:本来就点着 ⇒ false(这个 false 是"没改",不是"失败")');
});

test('FND109-5 ★P2 灭火后投料被拒(料落地),`relightStationAt` 重新点火后才出锅', () => {
  eq(fedWhileOut, 0, '负对照(与 WS-14 同口径):火灭着 ⇒ 一件都不收');
  eq(fedWhileOutGround, 3, '★ 灭火后那批料**留在地面**(3 堆,一件都没被吃掉)');
  eq(fedWhileOutFireOut, true, '★ 投料**不会**顺手复燃(否则一次空投就能解除灭火)');
  eq(fedWhileOutFed, 0, '锅里没有进料记账');
  eq(fedWhileOutCooked, 0, '也不出锅');

  eq(relightForFeed, true, '★ 重新点火动作真的改了状态(修前全仓没有复位路径 ⇒ 这口锅永久废掉)');
  eq(fedAfterRelight, 5, '★ 重燃后同一批料才进锅(104×1 + 124×2 + 121×2)');
  eq(feedFireOut, false, '重燃后炉火确实是点着的');
  eq(feedCooked, 1, '★ 重燃后真的出锅(修前 fireOut 恒 true ⇒ 永不出锅)');
  eq(feedItemId, 604, '出锅的是 604(正常配方的兜底料理)');

  eq(fedEmpty, 0, '负对照:该格无货 ⇒ 投不进任何东西');
  eq(emptyFireOut, true, '★★ 负对照:谁都没投进去时**不得**点火');
});

test('FND109-6 ★P2 `removePlayer` 一并清玩法表 `afkRuns`(不调则残留)', () => {
  eq(afkTickedBefore, 1, '前置:慢帧真的跑到了这条登记(玩法表里有 p1)');
  eq(removed, true, '前置:p1 确实在玩家表里,移除返回 true');
  eq(afkTickedAfter, 0, '★★ 移除后慢帧不再点名它(修前 afkRuns 从不清 ⇒ 同名重连继承上轮打盹)');
  eq(dozingAfterRemove, 0, '玩法表里已经没有这条记录');
  eq(foregroundAfterRemove, false, '★ 回前台找不到记录(证明确实删了,而不是只把字段归零)');

  eq(keepAfkTicked, 1, '负对照:不调 removePlayer ⇒ 记录留下 ⇒ 上面那条不是恒真');
  eq(keepForeground, true, '负对照:不调 removePlayer ⇒ 回前台能找到记录');
});

test('FND109-7 ★P3 `removePlayer` 体内击退那一行只出现一次(重复行回归守卫)', () => {
  const body = bodyOf(WORLD_SIM_SRC, 'removePlayer(id: string): boolean {');
  ok(body.length > 0, '前置:方法体摘取成功(否则下面的计数是恒 0 的同义反复)');
  eq(bodyOf(WORLD_SIM_SRC, 'noSuchMethod('), '', '负对照:摘取函数对不存在的签名返回空 ⇒ 它不会什么都匹配');
  eq(occurrenceCount(body, 'this.knockbacks.delete(id);'), 1, '★ 逐字重复的那一行必须只剩一次');
  eq(occurrenceCount(body, 'this.afkRuns.delete(id);'), 1, '★ 玩法表 afkRuns 也在清除名单里');
  ok(body.includes('this.afkPlayers.delete(id);'), '负对照:连接态 afkPlayers 的既有清理不得被顺手删掉(证明这段确实是清除名单)');
});

test('FND109-8 ★P1 接线:`.startPartyRun(` 有生产调用点、`GATHER`/`REACH_TARGET` 各有真发射点、开会后相位不再 IDLE', () => {
  /* ★ 第六轮翻面:Z3 把哨台入口接进了 `tickPartyStep` ⇒ 第四轮那条
     「生产零调用」的台账**不再是事实**。判据改成钉**接线 + 行为**。 */
  ok(prodCallers.length >= 1,
    `★ 生产代码里必须有 \`.startPartyRun(\` 调用点(实测 ${prodCallers.length} 个:${prodCallers.join(', ') || '无'})`);
  ok(prodCallers.some((f) => f.endsWith('world_sim.ts')),
    '★ 那个调用点必须来自**世界侧驱动**(`stepRefereeDesk`),不是装配层的旁路');
  ok(testCallers.some((f) => f.endsWith('WS-11.test.ts')), '负对照:WS-11 里也有调用点 ⇒ 上面的扫描不是恒空');

  /* ★ 判据用**发射形态**而不是词频:`world_sim.ts` 的台账注释里也写着
     `PARTY_SCORE_EVENT.GATHER`(说明「修前无生产者」),只数那个词会让「假发射点」恒真。 */
  const emit = (kind: string): number =>
    occurrenceCount(WORLD_SIM_SRC, `this.notePartyEvent({ kind: PARTY_SCORE_EVENT.${kind}`);
  eq(emit('CREATURE_KILL'), 1, '正对照:击杀那个发射点在册(证明下面两条不是"整个词表都没被用")');
  ok(emit('GATHER') >= 1, '★ `GATHER` 有真发射点(急单交付成功、扣掉地面货的那一刻)');
  ok(emit('REACH_TARGET') >= 1, '★ `REACH_TARGET` 有真发射点(站上 435 旗 / 434 底座 / 410 球门那一慢帧)');
  /* 负对照:不存在的 kind 必须数到 0 —— 否则上面的 ≥1 只是「这个词出现过」。 */
  eq(emit('NO_SUCH_EVENT'), 0, '负对照:未登记的 kind ⇒ 0(发射形态计数不会什么都匹配)');

  /* ★ 行为断言:真调一次 `startPartyRun` ⇒ 相位不再是 IDLE。
     只数调用点证明不了「真能开赛」(方法可以是死桩)。 */
  eq(phase, 'IDLE', '前置:没读过哨台命令的世界从没开过局');
  const started = simParty.startPartyRun('BRIDGE_CTF', 'ref-1');
  eq(started, true, '★ `startPartyRun` 能开赛(方法真实存在,不是死桩)');
  ok(simParty.partyPhase() !== 'IDLE', `★ 开了之后 \`partyPhase()\` 不再是 IDLE(实测 ${simParty.partyPhase()})`);
  simParty.clearPartyRun();
  eq(simParty.partyPhase(), 'IDLE', '收尾:清空后回到 IDLE(未开局的世界由 `partyPhase()` 如实报 IDLE)');

  eq(afkTickedForParty, 1, '正对照:慢帧真的跑过(`tickPartyStep` 每慢帧都执行)');
  eq(partyTicked, 0, '负对照:这张图**没有哨台** ⇒ 慢帧不开局 ⇒ `tickPartyMode` 不推进');
  eq(phase, 'IDLE', '负对照:没有哨台命令 ⇒ `partyPhase()` 仍是 IDLE(不是"世界一 tick 就自动开赛")');
});

process.exit(report('WS-FND-109') === 0 ? 0 : 1);
