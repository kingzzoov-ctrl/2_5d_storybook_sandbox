/**
 * WS-14 料理站接线(生产路径真的做菜)。
 *
 * ## 为什么单独立套件,而不是并进 WS-06
 *
 * 本套件是 task-39 的断言,原计划并入 `tests/WS-06.test.ts`。**没有并入**,原因有二:
 *
 * 1. **写域冲突**:并入当时 `tests/WS-06.test.ts` 归 task-31(`build-wiring`)独占。
 * 2. **口径不同(这才是主要理由)**:`WS-06` 的 61 条断言测的是**炼金炉**(LLM 门禁 /
 *    哈希缓存 / 五步属性算法 / 像素立牌),而本套件测的是**料理站的运行时接线** ——
 *    它们只是同在 `server/src/combat/cooking.ts` 与 `WS-06` 文档里的**数据**上重叠。
 *    混在一起会让「炼金」与「料理灶台」两个概念在一个套件里互相干扰。
 *
 * ⚠️ **本套件存在的真实理由,是一个实测出来的门禁缺口**:
 * ------------------------------------------------------------------
 * `cooking.ts` 的接线完成后,白名单条目被摘除(它变成「可达」),**但没有任何套件
 * 断言那处接线**。实测 `stationState` / `feedStationAt` / `extinguishStationAt` /
 * `feedStation` / `tryCookAt` 在全仓 19 个套件里**引用数全为 0**;
 * `WS-10` / `WS-FND-04` / `WS-FND-06` 只是 `import { FOODS }` 拿数据比对手册。
 *
 * ⇒ **回退那处接线,门禁会全绿。** 可达性门禁只查「能不能走到」,
 *   查不到「走到了之后有没有真的用」。本套件补的就是这一段。
 * ------------------------------------------------------------------
 *
 * ## 钉住的是什么
 *
 * 接线前:`logistics.ts` 的 `ARM_TARGETS` 含 506 汤锅/508 披萨炉,机械臂**真的会往锅里投料**,
 * 而 `cooking.ts` 生产零调用 ⇒ 货被投进一个「只收货、不产出」的黑洞
 * (实测 5 件材料 → 地面 0 件,**不报错、不落账**)。
 *
 * 接线后:5 件原料 → 1 份 604 星光萤火蘑菇汤,总量守恒。
 *
 * ## 正负对照
 *
 * 每条「生效」断言都配了能证伪的反例:A 投料不足 / B 机械臂断电 / C 火被浇灭 /
 * D 无 cook 入口的站。没有这些负对照,「修复」与「断言恒真」无法区分。
 *
 * 零外部依赖:只用 `shared/testing/harness.ts` + 本仓库实现层。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';

import { WorldSim } from '../server/src/sim/world_sim.ts';
import { WireColor } from '../shared/types/tile.ts';
import { createComponent } from '../server/src/wiring/graph.ts';
import { SOUP_POT_ID, KITCHEN_TABLE_ID, potCount } from '../server/src/combat/cooking.ts';

/** 机械臂(8,8) + 汤锅(8,6) + 材料铺在抓取半径内。 */
function armScene(materials: Array<{ id: number; count: number }>, powered: boolean): WorldSim {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.wiring.addComponent(createComponent('arm1', 'LOGISTICS_ARM', 8, 8, {
    state: { powered: 0, delivered: 0, idleCycles: 0 },
  }));
  if (powered) {
    sim.addWireDrive(8, 8, WireColor.GREEN, true);
    sim.wiring.addWire(8, 8, WireColor.GREEN);
  }
  sim.setCell(8, 6, { obj: SOUP_POT_ID });
  sim.setGroundItems(materials.map((m, i) => ({ id: m.id, x: 7, y: 7 + (i % 3), count: m.count })));
  return sim;
}

/** 只有汤锅 + 地面材料,无机械臂(用于确定性的投料/出锅校验)。 */
function potScene(materials: Array<{ id: number; count: number }>): WorldSim {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.setCell(4, 4, { obj: SOUP_POT_ID });
  sim.setGroundItems(materials.map((m) => ({ id: m.id, x: 4, y: 4, count: m.count })));
  return sim;
}

const ground = (sim: WorldSim): number => sim.groundItems.reduce((s, g) => s + g.count, 0);
const pot = (sim: WorldSim): ReturnType<WorldSim['stationState']> => sim.stationState(SOUP_POT_ID);
const dish = (sim: WorldSim, id: number): number =>
  sim.groundItems.filter((g) => g.id === id).reduce((s, g) => s + g.count, 0);

/* 手册正常配方:104×1 + 124×2 + 121×2 */
const FULL = [{ id: 104, count: 1 }, { id: 124, count: 2 }, { id: 121, count: 2 }];
const FRAMES = 800; /* 80 慢帧 = 20 个机械臂循环,足够投完全部材料 */

/* ════════════════════════════════════════════════════════════════════
 * A. 正例:生产路径(机械臂 → 506 汤锅)真的做出菜
 * ════════════════════════════════════════════════════════════════════ */

test('A1 生产路径上投满配方真的出锅(接线前:cooked=0,货被丢弃)', () => {
  const sim = armScene(FULL, true);
  for (let i = 0; i < FRAMES; i += 1) sim.tick();
  const st = pot(sim);
  ok(st.cooked >= 1,
    `生产路径上投满配方应出锅,实际 cooked=${st.cooked}`
    + '(0 说明 cooking.ts 未被生产调用:货投进锅后被丢弃)');
  eq(st.lastItemId, 604, '出锅的应是 604 星光萤火蘑菇汤(不是别的分支)');
});

test('A2 成品必须落到玩家能取的地方(不是出锅后又被机械臂抓回去)', () => {
  /* 这两条补的是「单边盲区」:只断言 cooked/lastItemId 的话,
     产物出锅后又被机械臂抓回锅里,照样全绿 —— cooked 仍是 1、
     lastItemId 仍是 604,只是玩家永远拿不到。 */
  const sim = armScene(FULL, true);
  for (let i = 0; i < FRAMES; i += 1) sim.tick();
  const st = pot(sim);
  eq(dish(sim, 604), 1, '成品应落到地面(机械臂场景下也不能卡在锅里)');
  eq(potCount(st), 0, '出锅后锅内不应残留(成品不该被机械臂抓回去回投)');
});

/* ════════════════════════════════════════════════════════════════════
 * B. 守恒(确定性路径:玩家逐件投料,无机械臂干扰)
 * ════════════════════════════════════════════════════════════════════ */

test('B1 5 件材料 → 1 份成品,总量守恒(投料可对账)', () => {
  const sim = potScene(FULL);
  let fed = 0;
  for (let k = 0; k < 5; k += 1) fed += sim.feedStationAt(SOUP_POT_ID, 4, 4, 1);
  const st = pot(sim);
  eq(fed, 5, '5 件材料应全部被接收(进锅总量可对账)');
  eq(potCount(st), 0, '出锅后锅内原料应被扣净(不残留、不重复计)');
  eq(st.cooked, 1, '满配方应恰好出锅 1 次');
  eq(dish(sim, 604), 1, '成品应作为掉落物落地,件数可对账');
  eq(ground(sim), 1, '地面只应剩那 1 份成品(5 件原料 → 1 份成品)');
});

/* ════════════════════════════════════════════════════════════════════
 * C. 负对照 —— 证伪「断言恒真」的可能性
 * ════════════════════════════════════════════════════════════════════ */

test('C1 负对照:投料不足(只有 1 件)→ 不出锅,且料留在锅里不消失', () => {
  const sim = potScene([{ id: 104, count: 1 }]);
  sim.feedStationAt(SOUP_POT_ID, 4, 4, 1);
  const st = pot(sim);
  eq(st.cooked, 0, '投料不足不应出锅');
  eq(potCount(st), 1, '那 1 件应留在锅内(而不是被丢弃)');
});

test('C2 负对照:机械臂断电 → 完全不投料、地面件数不变', () => {
  const sim = armScene(FULL, false);
  const before = ground(sim);
  for (let i = 0; i < FRAMES; i += 1) sim.tick();
  const st = pot(sim);
  eq(st.fedTotal, 0, '断电时不应有任何投料');
  eq(potCount(st), 0, '断电时锅内应保持空');
  eq(st.cooked, 0, '断电时不应出锅');
  eq(ground(sim), before, '断电时地面件数应保持不变');
});

test('C3 负对照:火被浇灭 → 料不进锅、不出锅,且货留在地面', () => {
  const sim = potScene(FULL);
  sim.extinguishStationAt(SOUP_POT_ID);
  const moved = sim.feedStationAt(SOUP_POT_ID, 4, 4, 5);
  const st = pot(sim);
  eq(moved, 0, '灭火后不应再进料');
  eq(st.fedTotal, 0, '灭火后不应有进料记账');
  eq(st.cooked, 0, '灭火后不应出锅');
  eq(ground(sim), 5, '灭火后材料应留在地面(不被吞掉)');
});

test('C4 负对照:没有 cook 入口的站(507 切菜台)不产出,但照常收料不吞货', () => {
  /* ⚠️ 这条同时是**真实欠账的登记**:507/508/505 有 `FOODS` 数据但无 cook 入口。
     我没有为它们伪造产出 —— 若哪天有人实现了 508 披萨炉,本断言会红,
     那时应改成本断言 + 一条「508 真的出锅」的正例。 */
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.setCell(4, 4, { obj: KITCHEN_TABLE_ID });
  sim.setGroundItems(FULL.map((m) => ({ id: m.id, x: 4, y: 4, count: m.count })));
  const moved = sim.feedStationAt(KITCHEN_TABLE_ID, 4, 4, 5);
  eq(moved, 5, '507 应照常收料(容器本身不区分站,不收就会变成丢货)');
  eq(dish(sim, 604), 0, '507 不应产出汤 —— 它没有 cook 入口(真实欠账,未伪造)');
  ok(potCount(sim.stationState(KITCHEN_TABLE_ID)) === 5, '507 收下的料应记在锅内,不消失');
});

/* ════════════════════════════════════════════════════════════════════
 * D. 缺口守望:接线方法必须被本套件引用(否则门禁对回退无感)
 * ════════════════════════════════════════════════════════════════════ */

test('D1 接线入口在世界模型上真实存在(回退接线则本断言红)', () => {
  const sim = new WorldSim({ sizeCells: 16, mobs: false });
  for (const m of ['stationState', 'feedStationAt', 'extinguishStationAt'] as const) {
    ok(typeof (sim as unknown as Record<string, unknown>)[m] === 'function',
      `WorldSim.${m} 应存在(它是生产接线的入口;删掉它 = 回退 task-39 的接线)`);
  }
  /* 否认对照:随便编一个不存在的方法名,确认上面的检查不是恒真。 */
  ok(typeof (sim as unknown as Record<string, unknown>).__noSuchStationApi__ !== 'function',
    '不存在的 API 不应被误判为存在(证明上一条检查有区分力)');
});

report('WS-14');
