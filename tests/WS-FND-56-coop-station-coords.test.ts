/**
 * WS-FND-56 —— 裁决 **D-13**:给 coop 工位补一张「工位 id ↔ 世界格」映射表。
 *
 * ## 补的是哪条缺口
 *
 * `rush_order.ts` 的工位槽位**没有世界坐标**,而 `tickRushOrder` 的 `opts.spraying`
 * 只吃 `StationKind[]`。玩家手里的 227 泡泡连发水枪给不出「种类」——
 * 他只知道「我站在哪个格、朝哪儿浇」⇒ 生产侧生产者恒为 0,
 * 「用 227 浇灭正在燃烧的工位」这句话**无法被表达**。
 *
 * 本套件钉的是新加的那一半:`stationCells`(映射表)+ `stationsBeingSprayedBy`
 * (**坐标 → 待浇工位种类**)。灭火规则(`STATION_STATE.BURNING` + `EXTINGUISH_SEC`
 * = 0.5 秒累计)按 D-13 原文**一个字都不动**,FND56-5 顺便把它当负对照钉住。
 *
 * ## 每条"命中"都配了负对照
 *
 * 半径外 / 未燃烧 / 只有相邻的另一个工位 —— 三种"不该返回"各自一条,
 * 否则"命中"与"压根没判"分不开(比如实现里直接 `return session.stations` 也能全绿)。
 *
 * ## ⚠️ 断言右侧一律用**字面量**
 *
 * `3` / `6` / `12` / `0.5` / `'FURNACE,POT,CUTTER'` 都写死,不拿被测模块的导出
 * 当期望值 —— 否则常量改成 99 也照样绿(门禁 `--strict-taut` 的口径)。
 *
 * 运行:`node tests/WS-FND-56-coop-station-coords.test.ts`
 */
import { test, ok, eq, includes, near, report, mulberry32 } from '../shared/testing/harness.ts';

import {
  DEFAULT_STATION_CELLS,
  EVT_DOUSED,
  EXTINGUISH_SEC,
  OVERHEAT_SEC,
  STATION_SPRAY_RADIUS,
  cellCenterOf,
  createManualClock,
  createRushOrderSession,
  startRushOrder,
  stationsBeingSprayedBy,
  tickRushOrder,
} from '../server/src/coop/rush_order.ts';
import type { RushOrderSession, StationKind, WorldCell } from '../server/src/coop/rush_order.ts';

/** 1 个低频帧 = 0.5s(`tickRushOrder` 推荐的 dt)。 */
const STEP = 0.5;

/** 起火烧起来的帧数:12s / 0.5s = 24 帧。 */
const BURN_STEPS = Math.round(OVERHEAT_SEC / STEP);

/** 建一个已开局的急单会话;`patch` 给工位换个位置(D-13 的注入参数)。 */
function mk(patch?: Partial<Record<StationKind, WorldCell>>): RushOrderSession {
  const clock = createManualClock(0);
  const s = createRushOrderSession({
    clock,
    roomLevel: 10,
    rng: mulberry32(56),
    stock: {},
    stationCells: patch,
  });
  startRushOrder(s);
  return s;
}

/** 空 opts 下跑满 12 秒 ⇒ 三个工位**全部**起火(什么都不翻炒、什么都不浇)。 */
function burnAll(s: RushOrderSession): void {
  for (let i = 0; i < BURN_STEPS; i += 1) tickRushOrder(s, STEP, { spawnBeaver: false });
}

/** 三个工位挤在一小片区域(格 0..1),让"距离"不可能成为拒绝的原因。 */
const CLUSTER: Partial<Record<StationKind, WorldCell>> = {
  FURNACE: { x: 0, y: 0 },
  POT: { x: 1, y: 0 },
  CUTTER: { x: 0, y: 1 },
};

/* ══════════════════ 1 正例:半径内的燃烧工位被返回 ══════════════════ */

test('FND56-1 站在燃烧工位的格中心浇水 ⇒ 返回该工位种类(正是 opts.spraying 的形状)', () => {
  const s = mk();
  burnAll(s);
  for (const st of s.stations) eq(st.state, 'BURNING', `前置:${st.kind} 已起火`);

  /* 默认映射表:三个工位沿 +x 一字排开,间距 6 格(2 × 半径 3) */
  eq(s.stationCells.FURNACE, { x: 0, y: 0 }, '默认:高炉在格 (0,0)');
  eq(s.stationCells.POT, { x: 6, y: 0 }, '默认:汤锅在格 (6,0)');
  eq(s.stationCells.CUTTER, { x: 12, y: 0 }, '默认:切木机在格 (12,0)');

  const hit = stationsBeingSprayedBy(s, { x: 0.5, y: 0.5 }, STATION_SPRAY_RADIUS);

  eq(hit, ['FURNACE'], '站在高炉格中心浇水 ⇒ 只命中高炉');
  eq(typeof hit[0], 'string', '★ 返回的是**种类**(字符串),不是槽位下标');
  /* 形状判据:它必须能原样喂给 tickRushOrder(s, dt, { spraying }) */
  eq(hit, ['FURNACE'], '返回数组可直接作为 opts.spraying');
});

/* ══════════════════ 2 负对照:半径外不返回 ══════════════════ */

test('FND56-2 负对照:半径外一个都不返回(空地 / 相邻工位都算)', () => {
  const s = mk();
  burnAll(s);

  /* 1 远离全部工位的空地(格 10,10 ⇒ 到高炉中心 13.4 格) */
  eq(stationsBeingSprayedBy(s, { x: 10.5, y: 10.5 }, STATION_SPRAY_RADIUS), [], '空地上浇水不命中任何工位');

  /* 2 站在**汤锅**格中心:到高炉格中心 6.0 格 > 半径 3 ⇒ 只命中汤锅。
       这一条同时钉住默认布局的间距选择:间距若取 3 格,相邻工位会落在半径边界上
       (格中心距 3.0 ≤ 3),这里就会返回两个。 */
  eq(stationsBeingSprayedBy(s, { x: 6.5, y: 0.5 }, STATION_SPRAY_RADIUS), ['POT'],
    '★ 一枪一个:站在汤锅上只命中汤锅');

  /* 3 非法半径 / 非法坐标 ⇒ 空数组,不抛错(接线层坐标可能还没同步) */
  eq(stationsBeingSprayedBy(s, { x: 0.5, y: 0.5 }, -1), [], '负半径不命中');
  eq(stationsBeingSprayedBy(s, { x: Number.NaN, y: 0.5 }, STATION_SPRAY_RADIUS), [], 'NaN 坐标不命中');
});

/* ══════════════════ 3 负对照:未燃烧的工位不返回 ══════════════════ */

test('FND56-3 负对照:未燃烧(RUNNING)的工位不返回', () => {
  /* 三个工位挤在 1.5 格内 ⇒ 距离绝不可能是拒绝的原因,只有**状态**能是 */
  const s = mk(CLUSTER);
  for (let i = 0; i < BURN_STEPS; i += 1) {
    /* 汤锅 / 切木机每步都被翻炒(runningSec 归零)⇒ 只有高炉会过热 */
    tickRushOrder(s, STEP, { tended: ['POT', 'CUTTER'], spawnBeaver: false });
  }

  eq(s.stations[0].state, 'BURNING', '前置:高炉已起火');
  eq(s.stations[1].state, 'RUNNING', '前置:汤锅被翻炒,未起火');
  eq(s.stations[2].state, 'RUNNING', '前置:切木机被翻炒,未起火');

  eq(stationsBeingSprayedBy(s, { x: 0.5, y: 0.5 }, STATION_SPRAY_RADIUS), ['FURNACE'],
    '★ 三个工位都在 1.5 格内,仍只返回**在烧**的那一个');

  /* 反向:一个都不烧时(刚开局)⇒ 谁也不返回,哪怕站在工位正中心 */
  const idle = mk(CLUSTER);
  eq(stationsBeingSprayedBy(idle, { x: 0.5, y: 0.5 }, STATION_SPRAY_RADIUS), [],
    'RUNNING 状态的工位不是浇水目标');
});

/* ══════════════════ 4 多工位同时在半径内:全返回 + 顺序确定 ══════════════════ */

test('FND56-4 多个工位同时在半径内 ⇒ 全部返回,顺序 = 工位表顺序(不是距离序)', () => {
  const s = mk(CLUSTER);
  burnAll(s);

  /* 站位选在**汤锅**格中心:距离序会是 POT(0) < FURNACE(1) < CUTTER(1.4142),
     而工位表顺序是 FURNACE < POT < CUTTER。两个口径在这一条上是**不同答案**。 */
  const hit = stationsBeingSprayedBy(s, { x: 1.5, y: 0.5 }, STATION_SPRAY_RADIUS);

  eq(s.stations.map((st) => st.kind).join(','), 'FURNACE,POT,CUTTER', '工位表顺序(常量口径)');
  eq(Object.keys(s.stationCells).join(','), 'FURNACE,POT,CUTTER', '映射表键序被归一化,故顺序不可能来自键序');
  eq(hit, ['FURNACE', 'POT', 'CUTTER'], '★ 全部返回,顺序 = 工位表顺序');
  eq(hit.join(','), 'FURNACE,POT,CUTTER', '逐位相等(距离序会给出 POT,FURNACE,CUTTER)');

  /* 同一个局面再问一次:逐位一致(确定性) */
  eq(stationsBeingSprayedBy(s, { x: 1.5, y: 0.5 }, STATION_SPRAY_RADIUS), hit, '两次调用逐位一致');
});

/* ══════════════════ 5 ★ 端到端:接上 tickRushOrder ⇒ 0.5 秒灭火 ══════════════════ */

test('FND56-5 ★ 端到端:返回的列表喂 tickRushOrder ⇒ 累计 0.5 秒 BURNING → RUNNING', () => {
  const s = mk();
  burnAll(s);
  for (const st of s.stations) eq(st.state, 'BURNING', `前置:${st.kind} 已起火`);

  /* 第 1 步 0.25s:进入 EXTINGUISHING,计时只走了一半 */
  const k1 = stationsBeingSprayedBy(s, { x: 0.5, y: 0.5 }, STATION_SPRAY_RADIUS);
  eq(k1, ['FURNACE'], '第 1 步命中高炉');
  const ev1 = tickRushOrder(s, 0.25, { spraying: k1, spawnBeaver: false });
  eq(s.stations[0].state, 'EXTINGUISHING', '0.25 秒只到 EXTINGUISHING(还差一半)');
  ok(!ev1.includes(EVT_DOUSED), '这一步还没灭');
  ok(s.stations[0].dousedSec > 0, '灭火计时开始累计');

  /* ★ 第 2 步:此时状态是 EXTINGUISHING。若 `stationsBeingSprayedBy` 只认 BURNING,
       这一步就会返回空 ⇒ dousedSec 被归零 ⇒ 永远灭不掉(0.5 秒规则形同虚设)。
       故这条断言是「状态口径」的行为证据,不是凑数。 */
  const k2 = stationsBeingSprayedBy(s, { x: 0.5, y: 0.5 }, STATION_SPRAY_RADIUS);
  eq(k2, ['FURNACE'], '★ EXTINGUISHING 也算「在烧」,必须继续被返回');
  const ev2 = tickRushOrder(s, 0.25, { spraying: k2, spawnBeaver: false });

  eq(s.stations[0].state, 'RUNNING', '★★ 累计 0.5 秒后从 BURNING 回到 RUNNING');
  includes(ev2, EVT_DOUSED, '抛出灭火事件');
  eq(s.stations[0].dousedSec, 0, '灭火计时归零');
  eq(s.stations[0].burningSec, 0, '燃烧计时归零');

  /* 灭火规则本身没被 D-13 改动:仍是 0.5 秒累计 */
  eq(EXTINGUISH_SEC, 0.5, '灭火规则未动 = 0.5 秒累计');
  eq(OVERHEAT_SEC, 12, '过热规则未动 = 12 秒连续运转');

  /* 负对照:另外两个工位没被"远程"浇灭(喷的是坐标,不是全场) */
  eq(s.stations[1].state, 'BURNING', '汤锅仍在燃烧');
  eq(s.stations[2].state, 'BURNING', '切木机仍在燃烧');
  eq(s.stations[1].dousedSec, 0, '汤锅的灭火计时没被动过');
});

/* ══════════════════ 6 半径常量与「用格中心判定」的口径 ══════════════════ */

test('FND56-6 半径 = 3 格(复用料理站灭火常量),命中判定用**格中心**', () => {
  /* 半径不是新数值:就是 `cooking.ts` 的 `EXTINGUISH_RADIUS`(212/227 三格内灭火) */
  eq(STATION_SPRAY_RADIUS, 3, '喷射半径 = 3 格(与料理站灭火同一常量)');
  eq(DEFAULT_STATION_CELLS.POT.x - DEFAULT_STATION_CELLS.FURNACE.x, 6, '默认间距 = 2 × 半径 = 6 格');

  eq(cellCenterOf({ x: 0, y: 0 }), { x: 0.5, y: 0.5 }, '格 (0,0) 的中心是 (0.5,0.5)');
  eq(cellCenterOf({ x: 6, y: 0 }), { x: 6.5, y: 0.5 }, '格 (6,0) 的中心是 (6.5,0.5)');

  const s = mk();
  burnAll(s);

  /* 距高炉格中心**恰好** 3.0 格 ⇒ 命中(闭区间) */
  eq(stationsBeingSprayedBy(s, { x: 0.5, y: 3.5 }, STATION_SPRAY_RADIUS), ['FURNACE'],
    '恰好 3.0 格仍命中(闭区间)');
  /* 3.01 格 ⇒ 不命中 */
  eq(stationsBeingSprayedBy(s, { x: 0.5, y: 3.51 }, STATION_SPRAY_RADIUS), [],
    '3.01 格不命中');

  /* ★ 上面那条"恰好 3.0 格命中"只有**以格中心为判定点**才成立:
       同一个点若按格索引 (0,0) 直接比,距离是 hypot(0.5, 3.5) = 3.5355 > 3 ⇒ 会判不中。
       这就是"格中心口径"的判别力所在,不是形式说明。 */
  near(Math.hypot(0.5, 3.5), 3.5355, 1e-4, '按格索引比同一距离是 3.5355 格(该判不中)');

  /* 站在格角 (0,0) 而不是格中心:偏差 0.7071 格,仍在半径内 */
  eq(stationsBeingSprayedBy(s, { x: 0, y: 0 }, STATION_SPRAY_RADIUS), ['FURNACE'],
    '格角到格中心 0.7071 格 ⇒ 仍命中');
  near(Math.hypot(0.5, 0.5), 0.70710678, 1e-8, '格角到格中心 = √2/2');

  /* 半径可注入:给 0.5 格 ⇒ 站在格角就够不着了(证明半径真是入参,不是写死) */
  eq(stationsBeingSprayedBy(s, { x: 0, y: 0 }, 0.5), [], '半径收到 0.5 格时,格角 0.7071 格落空');
});

report('WS-FND-56');