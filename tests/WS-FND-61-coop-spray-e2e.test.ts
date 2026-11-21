/**
 * WS-FND-61 —— D-13「浇水灭 coop 工位」的**端到端**判据。
 *
 * ## 补的是哪条缺口
 *
 * 机制本身已经接上了(`server/src/sim/world_sim.ts`):
 * ```
 * useItem(227/212) → extinguishDeviceByHand 里登记「喷射意图」
 *                  → sprayUntil = 本帧 + FAST_PER_SLOW(= 一个慢帧 = 0.5 秒)
 * 每个慢帧 tickPartyStep → 对**有意图**的玩家调 stationsBeingSprayedBy(会话, 玩家坐标)
 *                        → 得到的工位种类作为 opts.spraying 喂给 tickRushOrder
 *                        → tickStation: BURNING + 累计 EXTINGUISH_SEC(0.5s) ⇒ RUNNING
 * ```
 * 但**判据只到纯函数为止**:`tests/WS-FND-56` 测的是
 * `stationsBeingSprayedBy` 与手工调用的 `tickRushOrder`。
 * 「玩家真的按了 227 ⇒ 工位真的不烧了」这条**端到端路径此前一条断言都没有**
 * ⇒ 把意图窗口整段删掉、或让 `tickPartyStep` 每慢帧无条件喂坐标,
 *   56 号套件**照样全绿**(它连 `useItem` 都没调过一次)。
 *
 * ⇒ 本套件走**真装配**:`new WorldSim` + `setCell(6,6,{obj:508})` +
 *   `addPlayer('p1', 6.5, 6.5)` + `startRushRun(10, …)`,再推帧。
 *
 * ## 读口(owner 已批准)
 *
 * 判据要问「这个工位此刻是不是还在 BURNING」,而此前**没有只读出口**:
 * `RushOrderSession.stations` 是裸数组,会话又被 `WorldSim` 私有持有
 * ⇒ 只能翻 `.stations[0].state`(下标是布局巧合,不是接口;换个工位表就错位)。
 * 故 `rush_order.ts` 新增两个**纯读**读口:
 *   - `stationStateOf(session | null, kind) → StationState | null`
 *   - `sprayableKinds(session | null) → StationKind[]`
 * 本套件用它们读状态;拿会话实例的 `sessionOf(sim)` 是一层**只读**桥
 * (私有字段;本任务不许改 `world_sim.ts`)。
 * ⚠️ 桥不是被测对象 —— 被测对象是世界侧那条路径,见 FND61-3 / FND61-4。
 *
 * ## ⚠️ 断言右侧一律用**字面量**
 *
 * `508` / `227` / `12`(=`OVERHEAT_SEC`)/ `0.5` / `'BURNING'` / `'STATION_DOUSED'`
 * 都写死,不拿被测模块的导出当期望值(门禁 `--strict-taut` 的口径)。
 * ⚠️ **例外**:帧数一律**由秒派生**(`secondsToTicks` / `FAST_PER_SLOW`)—— 写死帧数
 * 会在改 tick 率时静默改变被测时长(见 FND177 的口径)。
 *
 * 运行:`node tests/WS-FND-61-coop-spray-e2e.test.ts`
 */
import { test, ok, eq, near, includes, report } from '../shared/testing/harness.ts';
import { secondsToTicks, ticksToSeconds, TICK_HZ } from '../shared/types/physics.ts';
import { WorldSim, FAST_PER_SLOW, SIM_SLOW_DT } from '../server/src/sim/world_sim.ts';
import {
  EXTINGUISH_SEC,
  OVERHEAT_SEC,
  STATION_SPRAY_RADIUS,
  sprayableKinds,
  stationStateOf,
  stationsBeingSprayedBy,
} from '../server/src/coop/rush_order.ts';
import type { RushOrderSession, StationKind, StationRuntime } from '../server/src/coop/rush_order.ts';

/* 冻结内容表的两个 id(取自 `shared/constants/items.ts`,不取被测模块的导出)。 */
/** 508 披萨炉 —— 料理站里对应 coop「高炉(FURNACE)」工位的那一个。 */
const PIZZA_OVEN = 508;
/** 227 泡泡连发水枪。 */
const BUBBLE_GUN = 227;
/** 披萨炉所在格;玩家坐标是**格中心**,故站位是 (6.5, 6.5)。 */
const OVEN_X = 6;
const OVEN_Y = 6;

/**
 * ★ 起火所需的两个数 —— **全部由秒派生**(`OVERHEAT_SEC` / `SIM_SLOW_DT` / `FAST_PER_SLOW`),
 * 不写死帧数(写死的数只在旧 tick 率下是 12 秒)。
 *
 * 工位要连续运转 `OVERHEAT_SEC`(= 12 s)才进 BURNING;
 * `tickRushOrder` 的慢帧 dt 是 `SIM_SLOW_DT`(= 0.5 s)⇒ `BURN_SLOW_FRAMES` 个慢帧;
 * 慢帧 = 每 `FAST_PER_SLOW` 个快帧一次 ⇒ `BURN_TICKS` 次 `sim.tick()`,也就是世界时间 12.00 秒。
 *
 * 两条独立派生(`secondsToTicks` 与「慢帧数 × 每慢帧快帧数」)**必须一致** ⇒ FND61-1 钉住。
 */
const BURN_SLOW_FRAMES = OVERHEAT_SEC / SIM_SLOW_DT;
const BURN_TICKS = secondsToTicks(OVERHEAT_SEC);

/**
 * 拿世界侧那个急单会话。`null` = 本房间没开急单。
 *
 * ⚠️ `rushRun` 是 `WorldSim` 的**私有**字段,而本任务不许动 `world_sim.ts`
 * ⇒ 这里只做**只读**取用(不写、不调私有方法、不改变行为)。
 * 两个读口都显式收 `null`,桥这一层因此不需要任何分支。
 */
function sessionOf(sim: WorldSim): RushOrderSession | null {
  return (sim as unknown as { rushRun: RushOrderSession | null }).rushRun;
}

/** 玩家刚体坐标(格单位、连续值),由物理层持有 —— 判据用它,不用「我传进去的那个数」。 */
function playerAt(sim: WorldSim): { x: number; y: number } {
  const b = sim.physics.bodies.get('p1');
  if (b === undefined) throw new Error('前置失败:玩家 p1 没有刚体');
  return { x: b.x, y: b.y };
}

/** 工位运行时(按**种类**取,不按数组下标取 —— 下标是布局巧合)。 */
function stationRuntimeOf(ses: RushOrderSession, kind: StationKind): StationRuntime {
  const st = ses.stations.find((s) => s.kind === kind);
  if (st === undefined) throw new Error(`前置失败:会话里没有工位 ${kind}`);
  return st;
}

interface Scene {
  sim: WorldSim;
  ses: RushOrderSession;
}

/**
 * 真装配:24×24 的安静图(`mobs: false` 不刷怪、`wiring: false` 不跑电路)
 * + 格 (6,6) 放披萨炉 508 + 玩家 p1 站在该格中心 (6.5,6.5)
 * + 开一场 roomLevel = 10 的急单。
 *
 * 508 会经 `startRushRun → deviceTileOf(PIZZA_OVEN_ID)` 变成 **FURNACE 工位**的世界格
 * (见 FND61-1 的前置断言)⇒「器件坐标 → 工位」这张映射表也在被测路径里。
 */
function scene(): Scene {
  const sim = new WorldSim({ sizeCells: 24, mobs: false, wiring: false });
  sim.setCell(OVEN_X, OVEN_Y, { obj: PIZZA_OVEN });
  sim.addPlayer('p1', OVEN_X + 0.5, OVEN_Y + 0.5);
  eq(sim.startRushRun(10, () => 0.5, {}), true, '前置:急单开局成功');
  const ses = sessionOf(sim);
  if (ses === null) throw new Error('前置失败:开局后世界侧仍没有会话');
  eq(playerAt(sim), { x: 6.5, y: 6.5 }, '前置:玩家站在披萨炉格中心');
  return { sim, ses };
}

/** 推够帧让工位进 BURNING(`BURN_TICKS` 帧 = `OVERHEAT_SEC` 秒,帧数由秒派生)。 */
function burn(sim: WorldSim): void {
  for (let i = 0; i < BURN_TICKS; i += 1) sim.tick();
}

/* ══════════════════ 1 前置:起火 ══════════════════ */

test('FND61-1 前置:508 成为 FURNACE 工位格 (6,6);推 `BURN_TICKS` 帧(= OVERHEAT_SEC)后工位 BURNING', () => {
  const { sim, ses } = scene();

  eq(stationStateOf(ses, 'FURNACE'), 'RUNNING', '开局:高炉在运转,还没起火');
  eq(sprayableKinds(ses), [], '开局:没有工位在烧');
  /* 映射表必须来自**真器件格**:纯函数单测里的默认占位格是 (0,0),世界侧必须是 (6,6)。 */
  eq(ses.stationCells.FURNACE, { x: 6, y: 6 }, '★ 披萨炉格 (6,6) 成了高炉工位的世界格');
  eq(BURN_TICKS, BURN_SLOW_FRAMES * FAST_PER_SLOW,
    '★ 起火帧数:两条独立派生必须一致(secondsToTicks(OVERHEAT_SEC) = 慢帧数 × 每慢帧快帧数)');

  /* 边界负对照:第 `BURN_TICKS - 1` 帧 = 11.5 秒 < 12 秒 ⇒ 还没烧起来(11.5 = 少一个慢帧)。
     没有这一条,`BURN_TICKS` 就只是我抄来的常量,不是被量出来的。 */
  for (let i = 0; i < BURN_TICKS - 1; i += 1) sim.tick();
  eq(stationStateOf(ses, 'FURNACE'), 'RUNNING', `★ 第 ${BURN_TICKS - 1} 帧(${(BURN_SLOW_FRAMES - 1) * SIM_SLOW_DT} 秒)仍在 RUNNING`);
  eq(stationRuntimeOf(ses, 'FURNACE').runningSec, (BURN_SLOW_FRAMES - 1) * SIM_SLOW_DT, '★ 累计运转 11.5 秒(= 少一个慢帧)');

  const f = sim.tick();
  eq(f.simSeconds, 12, '★ 第 `BURN_TICKS` 帧的世界时间 = 12.00 秒(= `OVERHEAT_SEC` 的字面值)');
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '★★ 该帧进入 BURNING');
  eq(stationRuntimeOf(ses, 'FURNACE').runningSec, BURN_SLOW_FRAMES * SIM_SLOW_DT, '累计运转 12 秒(= OVERHEAT_SEC)');
  /* 另外两个工位没人照看 ⇒ 一起烧(负对照留给 FND61-3:它们不在喷射半径内)。 */
  eq(sprayableKinds(ses), ['FURNACE', 'POT', 'CUTTER'], '三个工位都在烧,顺序 = 工位表顺序');
});

/* ══════════════════ 2 ★ 负对照:不浇水就不灭火 ══════════════════ */

test('FND61-2 ★ 负对照:站在燃烧的工位旁**不浇水** ⇒ 它仍在 BURNING', () => {
  const { sim, ses } = scene();
  burn(sim);
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '前置:高炉已起火');

  /* ★ 这条负对照的**判别力**全在这里:玩家确实站在喷射半径内,
     纯坐标判定此刻就会命中。⇒ 若接线层每慢帧无条件喂坐标,
     下面这 4 个慢帧(2 秒)就会把它浇灭 —— 而「浇水」不该等于「靠近」。 */
  eq(stationsBeingSprayedBy(ses, playerAt(sim), STATION_SPRAY_RADIUS), ['FURNACE'],
    '★ 玩家确实在半径内(仍不许灭火:没有意图)');

  for (let i = 0; i < 4 * FAST_PER_SLOW; i += 1) sim.tick();

  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '★★ 4 个慢帧过去,没人浇水 ⇒ 高炉仍在 BURNING');
  eq(stationRuntimeOf(ses, 'FURNACE').dousedSec, 0, '★ 灭火计时一次都没被计过(不是「浇了但没浇够」)');
  ok(stationRuntimeOf(ses, 'FURNACE').burningSec > 0,
    `燃烧计时在涨(实测 ${stationRuntimeOf(ses, 'FURNACE').burningSec.toFixed(1)} 秒)`);
  eq(sprayableKinds(ses).includes('FURNACE'), true, '读口仍把它算作「在烧」');
});

/* ══════════════════ 3 ★★ 端到端:227 浇一次 ⇒ 真的不烧了 ══════════════════ */

test('FND61-3 ★★ 用一次 227 浇它 ⇒ 下一个慢帧后不再是 BURNING(意图窗口真被消费)', () => {
  const { sim, ses } = scene();
  burn(sim);
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '前置:高炉已起火');

  const use = sim.useItem('p1', { itemId: BUBBLE_GUN, targetDeviceId: PIZZA_OVEN });
  eq(use.applied, true, `前置:227 对着 508 生效(reason=${use.reason})`);
  eq(use.consume, true, '前置:这一件真的被用掉');
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '★ 用道具的**当帧**还没灭(灭火要等慢帧)');

  /* 意图窗口 = 一个慢帧 = `FAST_PER_SLOW` 个快帧;推到窗口覆盖的那个慢帧。 */
  for (let i = 0; i < FAST_PER_SLOW; i += 1) sim.tick();

  eq(stationStateOf(ses, 'FURNACE'), 'RUNNING', '★★ 不再是 BURNING(0.5 秒累计达成)');
  eq(sim.rushTicked, 1, '本慢帧确实推进了急单(不是「压根没跑」)');
  includes(sim.lastPartyTick.events, 'STATION_DOUSED', '★ 世界总线真的播了灭火事件');
  eq(sprayableKinds(ses), ['POT', 'CUTTER'], '★ 只有高炉被浇灭,另外两个没人管仍在烧');
  eq(stationRuntimeOf(ses, 'FURNACE').dousedSec, 0, '灭火计时归零');
  eq(stationRuntimeOf(ses, 'FURNACE').burningSec, 0, '燃烧计时归零');
  eq(stationRuntimeOf(ses, 'POT').dousedSec, 0, '负对照:汤锅的灭火计时没被动过');
  eq(stationRuntimeOf(ses, 'POT').state, 'BURNING', '负对照:汤锅仍在烧(喷的是坐标,不是全场)');
});

/* ══════════════════ 4 ★ 负对照:意图会过期 ══════════════════ */

test('FND61-4 ★ 意图会过期:227 用过但窗口内没浇到 ⇒ 之后站在旁边也不再灭火', () => {
  const { sim, ses } = scene();
  burn(sim);
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '前置:高炉已起火');

  eq(sim.useItem('p1', { itemId: BUBBLE_GUN, targetDeviceId: PIZZA_OVEN }).applied, true,
    '前置:227 生效 ⇒ 喷射意图已登记');

  /* 窗口只覆盖 `FAST_PER_SLOW` 个快帧,而慢帧每 `FAST_PER_SLOW` 帧一次 ⇒ **必然**有一个慢帧落在窗口内。
     所以「过期」这件事只能是:窗口内那一次被浪费掉(人不在半径内)。
     位置用 `setPlayerPos` 挪 —— 判据用的是**刚体坐标**(见 `playerAt`),不是入参。 */
  sim.setPlayerPos('p1', OVEN_X + 0.5, OVEN_Y + 4.5);
  for (let i = 0; i < FAST_PER_SLOW; i += 1) sim.tick();
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '窗口内那一慢帧:人不在半径内 ⇒ 没浇到');
  eq(stationRuntimeOf(ses, 'FURNACE').dousedSec, 0, '灭火计时仍为 0');

  /* 再推 2 个慢帧 ⇒ 意图窗口(本帧 + `FAST_PER_SLOW`)过期,账被清掉 */
  for (let i = 0; i < 2 * FAST_PER_SLOW; i += 1) sim.tick();

  /* 回到工位旁:纯坐标判定此刻会命中(与 FND61-2 同形),但**没有新的意图** */
  sim.setPlayerPos('p1', OVEN_X + 0.5, OVEN_Y + 0.5);
  eq(stationsBeingSprayedBy(ses, playerAt(sim), STATION_SPRAY_RADIUS), ['FURNACE'],
    '★ 又站回半径内(若接线层无条件喂坐标,这一步就会灭火)');
  for (let i = 0; i < 2 * FAST_PER_SLOW; i += 1) sim.tick();

  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '★★ 意图过期后站在旁边也不会补浇');
  eq(stationRuntimeOf(ses, 'FURNACE').dousedSec, 0, '★ 全程灭火计时恒为 0');
  eq(sprayableKinds(ses), ['FURNACE', 'POT', 'CUTTER'], '★ 三个工位都还在烧');
  /* 注:这里**不能**用「再补一次 227 就灭了」收尾 —— 508 的炉火已被第一次 227
     浇灭(`fireOut`),第二次会被 `extinguishDeviceByHand` 以「已经灭了」拒掉,
     连意图都不会登记。正向证据由 FND61-3 独立提供(同一套机制、同一个器件)。 */
  eq(sim.stationState(508).fireOut, true, '508 的炉火已被第一次 227 浇灭(故无法再次登记意图)');
});

/* ══════════════════ 5 读口:未开急单 / 未知 kind ══════════════════ */

test('FND61-5 读口:未开急单(rushRun = null)/ 未知 kind ⇒ 明确返回(null / 空数组),不抛不 undefined', () => {
  /* 1 真装配下的「未开急单」:世界侧的会话**就是** null */
  const bare = new WorldSim({ sizeCells: 24, mobs: false, wiring: false });
  eq(sessionOf(bare), null, '前置:没开急单 ⇒ 世界侧会话为 null');
  eq(stationStateOf(sessionOf(bare), 'FURNACE'), null, '★★ 未开急单 ⇒ null(不抛错)');
  ok(stationStateOf(sessionOf(bare), 'FURNACE') !== undefined, '★ 不许返回 undefined');
  eq(sprayableKinds(sessionOf(bare)), [], '未开急单 ⇒ 空数组');

  const { sim, ses } = scene();

  /* 2 未知 kind:真实会话上传一个不存在的工位种类 */
  eq(stationStateOf(ses, 'WOK' as StationKind), null, '★ 未知 kind ⇒ null');
  ok(stationStateOf(ses, 'WOK' as StationKind) !== undefined, '★ 不许返回 undefined');
  eq(stationStateOf(ses, null as unknown as StationKind), null, '★ kind 是 null ⇒ null');
  eq(sprayableKinds(ses).length, 0, '开局没烧 ⇒ 空数组(长度 0,不是 undefined)');

  /* 3 读口照原样报出 tick 推出来的状态,且**反复调用不改变任何状态** */
  burn(sim);
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '读口报出 BURNING');
  eq(sprayableKinds(ses).join(','), 'FURNACE,POT,CUTTER', '在烧工位,顺序 = 工位表顺序');
  const before = stationRuntimeOf(ses, 'FURNACE').runningSec;
  for (let i = 0; i < 50; i += 1) {
    stationStateOf(ses, 'FURNACE');
    sprayableKinds(ses);
    stationStateOf(null, 'POT');
  }
  eq(stationRuntimeOf(ses, 'FURNACE').runningSec, before, '★ 反复调用读口不推进任何计时(纯读)');
  eq(stationStateOf(ses, 'FURNACE'), 'BURNING', '读口不被自己调用影响');
});

/* ══════════════════ 6 既有规则值不动 ══════════════════ */

test('FND61-6 既有规则不动:EXTINGUISH_SEC = 0.5;意图窗口 = 一个慢帧 = 0.5 秒', () => {
  eq(EXTINGUISH_SEC, 0.5, '227 水枪累计喷射 0.5 秒 ⇒ 恢复正常运转');
  eq(OVERHEAT_SEC, 12, '连续运转 12 秒不翻炒 ⇒ 起火(FND61-1 的 `BURN_TICKS` 由它算出)');
  eq(STATION_SPRAY_RADIUS, 3, '喷射半径 = 3 格(复用料理站灭火常量)');
  eq(FAST_PER_SLOW, secondsToTicks(SIM_SLOW_DT), '一个慢帧 = secondsToTicks(SIM_SLOW_DT) 个快帧(帧数由秒派生)');
  eq(SIM_SLOW_DT, 0.5, '慢帧 dt = 0.5 秒');
  near(ticksToSeconds(FAST_PER_SLOW), 0.5, 1 / TICK_HZ,
    '★ 意图窗口 = 一个慢帧 = 0.5 秒(= `EXTINGUISH_SEC` 的字面值,恰好够累计一次灭火,刻度内)');
  eq(BURN_SLOW_FRAMES * SIM_SLOW_DT, 12, '24 个慢帧 × 0.5 秒 = 12 秒 = OVERHEAT_SEC');
});

report('WS-FND-61');
