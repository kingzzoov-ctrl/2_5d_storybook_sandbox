/**
 * WS-FND-77 —— 四个房间系统 + 料理 3 字段**接进生产**的判据。
 *
 * ## 这个套件钉的是什么(与 WS-FND-75 的分工)
 *
 * `tests/WS-FND-75` 钉的是四个系统**自己算得对**(纯函数、材料/产出/定价/分拣)。
 * 本套件钉的是**另一个问题**:它们**被谁调用**。
 *
 * 接线前的实测(本套件写之前的探针):
 * ```
 * settleRanchDay / cellGrowth / brewAndRecord / buy   调用点:只有 tests/WS-FND-75
 * world_sim.ts 对 systems/** 的 import:0 处
 * room.ts 的 RoomAction:22 个,没有一个能表达「买」
 * ```
 * ⇒ 玩家盖出牧场/温室/炼金室/百货店,手册承诺的东西**一件都不发生**,而门禁全绿。
 *   这正是本仓「实现完整、单测全绿、编排层不接」的第 10 例。
 *
 * ## 判据结构(每条都有负对照)
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | 1 | 温室:一天长 1/4;4 天成熟并按 429 分拣 | 夜里露天不长;温室夜里照长 |
 * | 2 | 世界上真的种得下、长得动(耕地 301) | 非耕地播种被拒 |
 * | 3 | 牧场日结:吃 2 件、产 2 份,产出无处落时如实记账 | 没有饲料 ⇒ 一份都不产 |
 * | 4 | 跨日累计:0.4 + 0.6 天 ⇒ 恰好结 1 天 | 非牧场物种不进日结 |
 * | 5 | `BUY_ITEM` 走完生产分派链 | 内容表没有价格 ⇒ 拒 + 库存一件不少 |
 * | 6 | 炼金首创:冠名 + 537 陈列 | 没炼过 ⇒ 馆是空的;1 件材料 ⇒ 拒 |
 * | 7 | 料理 `moveMul`/`gravityMul`/`jumpMul` 推到物理层 | 没吃料理 ⇒ 三张旁表都没有记录 |
 * | 8 | `gatherMul` 归属到发起者 | 不传 actor ⇒ 回执里连键都没有 |
 *
 * ## 期望值从哪来(**不许取自被测模块**)
 *
 * 全部是**手算**(1/4 = 0.25、1/2 = 0.5、4.5 × 1.15 = 5.175、8 × 1.5 = 12、
 * 30 × 2 = 60)或**内容表/冻结层的既有常量**(物品 id、`BASE_MOVE_SPEED`)。
 * 没有一条期望是「跑一遍被测模块然后把输出抄下来」。
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import type { ActionPayload } from '../server/src/net/room.ts';
import { buyItem } from '../server/src/net/actions/buy_item.ts';
import { BASE_MOVE_SPEED } from '../shared/types/physics.ts';
import { BASE_HP } from '../shared/types/physics.ts';
import {
  createRoomSystemsState,
  plantCrop,
  cropAt,
  growCrops,
  galleryDisplay,
  foodPhysicsOf,
} from '../server/src/systems/wiring.ts';
import { SORT_PASS_THROUGH } from '../server/src/systems/greenhouse.ts';

/* ═══════════ 0. 夹具(只声明用到的世界能力) ═══════════ */

interface SimHandle {
  readonly frame: number;
  readonly physics: {
    speedCapOf(id: string): number | null;
    gravityMulOf(id: string): number;
    jumpMulOf(id: string): number;
  };
  /** 地形写入走 `grid.setFloor(itemId)` —— `setCell({floor})` 收的是 **6 位槽位**,不是物品 id。 */
  readonly grid: { setFloor(x: number, y: number, itemId: number): void };
  setCell(x: number, y: number, fields: { floor?: number; obj?: number }): void;
  blockAt(x: number, y: number): number;
  plantCrop(x: number, y: number, cropId: number, matureDays?: number): { ok: boolean; reason: string };
  cropAt(x: number, y: number): { cropId: number; progress: number; moisture: number; matureDays: number } | undefined;
  crops(): { x: number; y: number; cropId: number; progress: number }[];
  advanceRoomSystems(dayFraction?: number): {
    grown: number;
    matured: { x: number; y: number; cropId: number; lane: number }[];
    ranchDays: number;
    ranchProduced: number;
    ranchDropped: number;
  };
  setSortFilters(filters: readonly { lane: number; itemIds: readonly number[] }[]): void;
  harvestLog(): { x: number; y: number; cropId: number; lane: number }[];
  setRanchPets(animals: readonly { speciesId: string; affinity: number }[]): void;
  ranchPets(): { speciesId: string; affinity: number }[];
  settleRanchIfDayChanged(days: number): { days: number; produced: number; dropped: number };
  lastRanchSettle(): {
    produce: { speciesId: string; name: string; itemId: number | null; count: number }[];
    feedConsumed: { itemId: number; count: number }[];
    fedCount: number;
    starvedCount: number;
    skippedCount: number;
    unresolved: readonly string[];
    days: number;
  } | null;
  lastRanchDrops(): { dropped: { itemId: number; count: number; x: number; y: number }[]; skipped: string[] };
  dropItem(x: number, y: number, itemId: number, count: number): void;
  groundItemsNear(x: number, y: number, radius: number): { itemId: number; count: number }[];
  brewAtFurnace(actorId: string, itemIds: readonly number[], opts?: Record<string, number>): {
    ok: boolean;
    reason?: string;
    first?: boolean;
    entry?: { recipeHash: string; discovererName: string; itemName: string; craftCount: number; firstAt: number };
    display: { recipeHash: string; discovererName: string; craftCount: number }[];
  };
  galleryProjection(): { recipeHash: string; discovererName: string; craftCount: number }[];
  setStallStock(stock: Readonly<Record<number, number>>): void;
  stallStockOf(): Record<number, number>;
  purchaseQuote(itemId: number, qty: number): { ok: boolean; reason: string; cost: number; stock: Record<number, number> };
  purchaseCommit(itemId: number, qty: number): { ok: boolean; cost: number; reason: string };
  useItem(actorId: string, req: { itemId: number }): { applied: boolean; consume: boolean; reason: string };
  breakBlock(x: number, y: number, actorId?: string):
    { ok: true; objId: number; gatherMul?: number } | { ok: false; reason: string };
  jumpPlayer(playerId: string, baseVz: number): number | null;
  tick(): { phase: string };
  resetWorld(opts: { seed: number; nowMs?: number }): {
    applied: boolean;
    seed: number;
    archive: { id: string; seed: number; archived_at: number; bytes: number; trim?: Record<string, unknown> } | null;
    archiveError?: string;
  };
}

function newWorld(): { rt: ReturnType<typeof assemble>['runtime']; sim: SimHandle } {
  const a = assemble({
    roomId: 'r_fnd77',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 1234,
    db: null,
    archiveSink: null,
  });
  a.runtime.join({ userId: 'p1' });
  return { rt: a.runtime, sim: a.host as unknown as SimHandle };
}

/** 推一个慢帧(帧序 10 的倍数 ⇒ `isSlow`)。 */
function slowFrame(sim: SimHandle): void {
  for (let i = 0; i < 10; i += 1) sim.tick();
}

/* 用到的物品 id(全部来自冻结内容表,不是自造) */
const ITEM_BERRY = 121;   // 露水甜莓(可播种的水果)
const ITEM_PEACH = 122;   // 金秋蜜桃(水豚饲料)
const ITEM_WHEAT = 123;   // 黄金小麦(绵羊饲料)
const ITEM_BOSS_RELIC = 704; // 果冻王凝露皇冠(Boss遗物,V=250,无定价)
const SOIL = 301;         // 肥沃农田耕地
const TROUGH = 529;       // 牧场动物自动饲育槽
const FURNITURE = 351;    // 暖松原木圆墙 · 任意可拆的 obj

/* ═══════════ 1. 温室:纯逻辑(正面 + 两个负对照) ═══════════ */

test('FND77-1 温室:一天长 1/4(4 天成熟);夜里露天不长而温室照长', () => {
  /* 手算:1 / 4 = 0.25;四天累计 1.00 ⇒ 成熟。
     怎么变红:
       · `growCrops` 不乘 `dayFraction` ⇒ 第 2 条(变成 1);
       · 温室与露天共用同一个光照判定 ⇒ 第 4/5 条(夜里温室也不长);
       · 成熟后不从耕地摘走 ⇒ 第 6 条。 */
  const st = createRoomSystemsState();
  st.sortFilters = [{ lane: 1, itemIds: [ITEM_BERRY] }];
  eq(plantCrop(st, 3, 4, ITEM_BERRY, 4).ok, true, '播种应成功');

  const day1 = growCrops(st, {
    dayFraction: 1, night: false, weather: 'CLEAR',
    isGreenhouse: () => false, hasSprinkler: () => false,
  });
  eq(day1.grown, 1, '白天露天已浇透 ⇒ 今天该长');
  eq(day1.matured, [], '刚播种,一天后还不熟');
  near(cropAt(st, 3, 4)!.progress, 0.25, 1e-9, '1/4 = 0.25');

  growCrops(st, { dayFraction: 1, night: false, weather: 'CLEAR', isGreenhouse: () => false, hasSprinkler: () => false });
  growCrops(st, { dayFraction: 1, night: false, weather: 'CLEAR', isGreenhouse: () => false, hasSprinkler: () => false });
  eq(st.crops.size, 1, '三天后还没熟');
  const day4 = growCrops(st, {
    dayFraction: 1, night: false, weather: 'CLEAR',
    isGreenhouse: () => false, hasSprinkler: () => false,
  });
  eq(day4.matured.length, 1, '第四天 0.25×4 = 1.00 ⇒ 成熟');
  eq(st.crops.size, 0, '成熟后从耕地上摘走');
  eq(day4.matured[0].lane, 1, '429 的过滤规则把它分到 1 号道(内容表 429 的语义)');
  eq(st.harvest.length, 1, '收获账只有一条');

  /* ★ 负对照 1:露天 + 夜里 ⇒ 0(不管浇没浇透) */
  const nightSt = createRoomSystemsState();
  plantCrop(nightSt, 5, 5, ITEM_BERRY, 4);
  const nightOpen = growCrops(nightSt, {
    dayFraction: 1, night: true, weather: 'CLEAR',
    isGreenhouse: () => false, hasSprinkler: () => false,
  });
  eq(nightOpen.grown, 0, '★ 露天夜里不长');
  eq(cropAt(nightSt, 5, 5)!.progress, 0, '进度一点都没动');

  /* ★ 负对照 2:同一夜,温室里 ⇒ 照长 0.25(375「全天候透光」) */
  const houseSt = createRoomSystemsState();
  plantCrop(houseSt, 5, 5, ITEM_BERRY, 4);
  const nightHouse = growCrops(houseSt, {
    dayFraction: 1, night: true, weather: 'CLEAR',
    isGreenhouse: () => true, hasSprinkler: () => true,
  });
  eq(nightHouse.grown, 1, '★ 温室夜里照长');
  near(cropAt(houseSt, 5, 5)!.progress, 0.25, 1e-9);

  /* ★ 负对照 3:没浇透(0.2 < 0.35)且没有洒水器 ⇒ 不长 */
  const drySt = createRoomSystemsState();
  drySt.crops.set('7,7', { x: 7, y: 7, cropId: ITEM_BERRY, matureDays: 4, moisture: 0.2, progress: 0 });
  const dry = growCrops(drySt, {
    dayFraction: 1, night: false, weather: 'CLEAR',
    isGreenhouse: () => false, hasSprinkler: () => false,
  });
  eq(dry.grown, 0, '★ 没浇透 ⇒ 今天不长');

  /* ★ 负对照 4:暴风雨露天 ⇒ 不长(二值判定,不是倍率) */
  const stormSt = createRoomSystemsState();
  plantCrop(stormSt, 8, 8, ITEM_BERRY, 4);
  const storm = growCrops(stormSt, {
    dayFraction: 1, night: false, weather: 'STORM',
    isGreenhouse: () => false, hasSprinkler: () => false,
  });
  eq(storm.grown, 0, '★ 暴风雨露天 ⇒ 不长');
});

/* ═══════════ 2. 温室:接到世界上(耕地 / 生长 / 分拣) ═══════════ */

test('FND77-2 世界上真的种得下、长得动:耕地 301 + 一天 1/2(2 天成熟)+ 429 分拣', () => {
  /* 手算:成熟天数 2 ⇒ 每天 1/2 = 0.5;两天 ⇒ 成熟。
     怎么变红:
       · `WorldSim.plantCrop` 不校验耕地 ⇒ 第 2 条;
       · `advanceRoomSystems` 没接 `growCrops` ⇒ 第 3/4 条(进度恒 0);
       · 忘记把 `setSortFilters` 传进纯函数 ⇒ 第 6 条(lane 恒 -1)。 */
  const { sim } = newWorld();
  sim.grid.setFloor(2, 2, SOIL);
  const planted = sim.plantCrop(2, 2, ITEM_BERRY, 2);
  ok(planted.ok, `耕地播种应成功(${planted.reason})`);
  eq(sim.crops().length, 1, '世界上有一格作物');

  const d1 = sim.advanceRoomSystems(1);
  eq(d1.grown, 1, '白天(0 帧 = 06:00,不是夜)露天已浇透 ⇒ 今天该长');
  near(sim.cropAt(2, 2)!.progress, 0.5, 1e-9, '1/2 = 0.5');

  const d2 = sim.advanceRoomSystems(1);
  eq(d2.matured.length, 1, '第二天 0.5×2 = 1.00 ⇒ 成熟');
  eq(sim.cropAt(2, 2), undefined, '成熟后摘走');
  /* ★ 期望值写**字面量 -1**(不能拿 `SORT_PASS_THROUGH` 当期望 —— 那与被测模块同源,断言恒真);
     常量本身的值由紧随其后的**锚点**钉住(常量在 actual 侧才保留牙齿)。 */
  eq(d2.matured[0].lane, -1, '没配过滤规则 ⇒ -1(原样留在带上)');
  eq(SORT_PASS_THROUGH, -1, '锚点:透传道常量 = -1,不得漂移');
  eq(sim.harvestLog().length, 1);

  /* 配了过滤规则之后:同一套生长路径把产物分到指定的道 */
  sim.setSortFilters([{ lane: 2, itemIds: [ITEM_BERRY] }]);
  sim.grid.setFloor(4, 4, SOIL);
  ok(sim.plantCrop(4, 4, ITEM_BERRY, 1).ok);
  const d3 = sim.advanceRoomSystems(1);
  eq(d3.matured[0].lane, 2, '★ 429 的过滤规则真的生效(1 天成熟 ⇒ 当天就收)');

  /* ★ 负对照:不是耕地(301)⇒ 拒绝播种,且世界不变 */
  sim.grid.setFloor(6, 6, 302); /* 青苔鹅卵石径:不是耕地 */
  const bad = sim.plantCrop(6, 6, ITEM_BERRY);
  eq(bad.ok, false, '★ 非耕地不许播种');
  ok(bad.reason.includes('耕地'), `理由要说清是耕地(${bad.reason})`);
  eq(sim.crops().length, 0, '被拒的播种不留任何状态');
});

/* ═══════════ 3. 牧场:日结接到世界上 ═══════════ */

test('FND77-3 牧场日结:吃 2 件饲料、产 2 份;内容表没「毛团」⇒ 如实记账不落货', () => {
  /* 手算:绵羊 1 份/天,2 天 ⇒ 吃 2 件黄金小麦(123)、产 2 份。
     落地 3 件 ⇒ 剩 1 件。
     怎么变红:
       · `settleRanchIfDayChanged` 没接 `settleRanchDay` ⇒ 第 2/3 条;
       · 不扣地面饲料 ⇒ 第 5 条(仍剩 3 件);
       · 给「毛团」编一个物品 id ⇒ 第 6 条(dropped 会非空)。 */
  const { sim } = newWorld();
  sim.setRanchPets([{ speciesId: 'mob_sheep', affinity: 0.9 }]);
  sim.setCell(6, 6, { obj: TROUGH });
  sim.dropItem(1.5, 1.5, ITEM_WHEAT, 3);

  const r = sim.settleRanchIfDayChanged(2);
  eq(r.days, 2, '结算 2 天');
  const settle = sim.lastRanchSettle()!;
  eq(settle.feedConsumed, [{ itemId: ITEM_WHEAT, count: 2 }], '2 天 ⇒ 吃掉 2 件黄金小麦');
  eq(settle.produce.length, 1, '一只动物一行产出');
  eq(settle.produce[0].name, '毛团', '手册点名的产出名(内容表 529 的 note)');
  eq(settle.produce[0].count, 2, '2 天 ⇒ 2 份');
  eq(settle.produce[0].itemId, null, '★ 内容表没有「毛团」⇒ ID 如实为 null');
  eq(settle.fedCount, 1);
  eq(settle.starvedCount, 0);

  /* 地面饲料真的被扣了(世界侧消费点,不是只在回执里算) */
  const left = sim.groundItemsNear(1.5, 1.5, 2).reduce((n, g) => n + g.count, 0);
  eq(left, 1, '3 - 2 = 1 件剩在地面');

  /* 产出无处落:内容表没有那件物品 ⇒ 「没落货」必须说得出来 */
  const drops = sim.lastRanchDrops();
  eq(drops.dropped, [], '★ 没有物品 ID ⇒ 不许凭空造一件落在地上');
  ok(drops.skipped.some((s) => s.includes('毛团')), `账上必须写明缺口(${drops.skipped.join(';')})`);

  /* ★ 负对照:槽里没有饲料 ⇒ 一份都不产,也不报错 */
  const { sim: sim2 } = newWorld();
  sim2.setRanchPets([{ speciesId: 'mob_sheep', affinity: 0.9 }]);
  sim2.setCell(6, 6, { obj: TROUGH });
  const empty = sim2.settleRanchIfDayChanged(1);
  const s2 = sim2.lastRanchSettle()!;
  eq(s2.produce, [], '★ 没有饲料 ⇒ 产出为空');
  eq(s2.starvedCount, 1, '记一条「饿了一天」');
  eq(empty.produced, 0);
  eq(sim2.lastRanchDrops().dropped, []);
});

/* ═══════════ 4. 牧场:跨日累计 + 非牧场物种 ═══════════ */

test('FND77-4 跨日结算按**整数天**:0.4 + 0.6 天 ⇒ 恰好结 1 天;花栗鼠不进牧场', () => {
  /* 怎么变红:
       · 每个慢帧都结算(把 0.4 天当 1 天)⇒ 第 1 条(ranchDays 变 1);
       · 反过来永远不结算 ⇒ 第 2 条(0.6 之后仍是 0)。 */
  const { sim } = newWorld();
  sim.setRanchPets([{ speciesId: 'mob_squirrel', affinity: 0.95 }]);

  const a = sim.advanceRoomSystems(0.4);
  eq(a.ranchDays, 0, '★ 0.4 天不构成一天 ⇒ 不结算');

  const b = sim.advanceRoomSystems(0.6);
  eq(b.ranchDays, 1, '★ 0.4 + 0.6 = 1 天 ⇒ 恰好在第二次结算');
  const settle = sim.lastRanchSettle()!;
  eq(settle.days, 1);
  eq(settle.skippedCount, 1, '★ 花栗鼠不是手册点名的牧场动物 ⇒ 跳过');
  eq(settle.feedConsumed, [], '它也不吃牧场饲料');
  eq(settle.produce, []);
});

/* ═══════════ 5. 百货店:`BUY_ITEM` 走生产分派链 ═══════════ */

test('FND77-5 ★负对照:内容表没有价格 ⇒ `BUY_ITEM` 被拒且摊位库存一件不少', () => {
  /* 出处:`systems/depot.ts` 的纪律 —— 内容表只有 `value`(价值分),没有 `price`。
     怎么变红:
       · 动作工厂把 `purchaseQuote` 当摆设(直接成交)⇒ 第 3 条;
       · 拿 `value`(704 = 250)当价格 ⇒ 第 2 条(会成交)。 */
  const { rt, sim } = newWorld();
  sim.setStallStock({ [ITEM_BOSS_RELIC]: 5 });
  eq(sim.purchaseQuote(ITEM_BOSS_RELIC, 2).ok, false, '锚:704 在内容表里没有定价');

  const out = rt.dispatchAction(
    'p1', RoomAction.BUY_ITEM, { itemId: ITEM_BOSS_RELIC, qty: 2 } as unknown as ActionPayload,
  );
  eq(out.ok, false, '★ 没有定价 ⇒ 不能成交');
  eq(out.kind, 'INVALID', '状态不对是 INVALID,不是 PERMISSION');
  ok((out.reason ?? '').includes('无定价'), `理由必须说「无定价」(${out.reason ?? ''})`);
  eq(sim.stallStockOf(), { [ITEM_BOSS_RELIC]: 5 }, '★ 被拒时库存一件不少');

  /* ★ 负对照 2:动作确实登记在表里(不是掉进 NOT_IMPLEMENTED) */
  ok(out.kind !== 'NOT_IMPLEMENTED', 'BUY_ITEM 必须有执行者(登记在 ACTION_HANDLERS)');

  /* ★ 负对照 3:没有世界源的房间 ⇒ 显式 NOT_IMPLEMENTED */
  const { rt: rt2 } = newWorld();
  rt2.worldSaveHost = null;
  const noHost = rt2.dispatchAction(
    'p1', RoomAction.BUY_ITEM, { itemId: ITEM_BOSS_RELIC, qty: 1 } as unknown as ActionPayload,
  );
  eq(noHost.kind, 'NOT_IMPLEMENTED', '★ 没有摊位能力要**说出来**,不静默放行');
});

test('FND77-5b 有价时成交:单价 30 × 2 件 = 60,背包 +2,库存 5 → 3(动作层单测)', () => {
  /* 手算:30 × 2 = 60;5 - 2 = 3。价格表由**假世界源**喂 —— 内容表还没有价,
     所以这里验的是动作的**事务分支**,不是定价本身(定价归内容表)。
     怎么变红:
       · 先扣库存再扣背包(顺序反了)⇒ 第 4 条(refund 路径不会触发);
       · 不调 `purchaseCommit` ⇒ 第 3 条(库存仍 5)。 */
  let stock: Record<number, number> = { [ITEM_BOSS_RELIC]: 5 };
  const applied: { ops: readonly { itemId: number; delta: number }[] }[] = [];
  const fakeHost = {
    purchaseQuote: (itemId: number, qty: number) => {
      const price = 30;
      const have = stock[itemId] ?? 0;
      if (have < qty) {
        return { ok: false, reason: `库存不足:只剩 ${have} 件`, cost: 0, stock: { ...stock } };
      }
      return { ok: true, reason: '成交', cost: price * qty, stock: { ...stock, [itemId]: have - qty } };
    },
    purchaseCommit: (itemId: number, qty: number) => {
      const have = stock[itemId] ?? 0;
      if (have < qty) return { ok: false, cost: 0, reason: '库存不足' };
      stock = { ...stock, [itemId]: have - qty };
      return { ok: true, cost: 30 * qty, reason: '成交' };
    },
  };
  const ctx = {
    actorId: 'p1',
    action: RoomAction.BUY_ITEM,
    payload: { itemId: ITEM_BOSS_RELIC, qty: 2 } as unknown as ActionPayload,
    state: null,
    host: fakeHost,
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (_userId: string, input: { ops: readonly { itemId: number; delta: number }[] }) => {
      applied.push(input);
      return { allowed: true, afterTotal: 2 };
    },
    grantItemSource: () => {},
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
  } as unknown as ActionContext;

  const out = buyItem(ctx);
  eq(out.ok, true, `有价且有货 ⇒ 成交(${out.reason ?? ''})`);
  const effect = out.effect as Record<string, unknown>;
  eq(effect.cost, 60, '单价 30 × 2 件 = 60');
  eq(effect.stock, 3, '库存 5 → 3');
  eq(stock[ITEM_BOSS_RELIC], 3, '★ 库存真的落了(不是只在回执里算)');
  eq(applied.length, 1, '背包恰好增减一次');
  eq(applied[0].ops[0].itemId, ITEM_BOSS_RELIC, '背包加的是那一件');
  eq(applied[0].ops[0].delta, 2, '背包 +2');
  ok(typeof (applied[0].ops[0] as unknown as { source?: unknown }).source === 'string', '产出侧必须带凭证(source)');


  /* ★ 负对照:参数不对 ⇒ 一条副作用都不留 */
  const appliedBefore = applied.length;
  const bad = buyItem({
    ...ctx,
    payload: { itemId: ITEM_BOSS_RELIC, qty: 0 } as unknown as ActionPayload,
  } as ActionContext);
  eq(bad.ok, false, 'qty = 0 ⇒ 拒绝');
  eq(applied.length, appliedBefore, '★ 被拒时背包一次都没动');
  eq(stock[ITEM_BOSS_RELIC], 3, '★ 被拒时库存不变');
});

/* ═══════════ 6. 炼金:首创冠名 + 537 陈列 ═══════════ */

test('FND77-6 炼金首创:冠名 = 合成者、哈希 = 材料升序;第二次只加 craft_count(537 投影)', () => {
  /* 手算:材料 123 + 122 升序拼接 ⇒ "122_123"。
     怎么变红:
       · `brewAtFurnace` 没接 `brewAndRecord` ⇒ 第 1 条(馆恒空);
       · 第二次把冠名覆盖成新玩家 ⇒ 第 5 条;
       · 537 投影不按 `firstAt` 排序 / 不去重 ⇒ 第 6/7 条。 */
  const { sim } = newWorld();
  eq(sim.galleryProjection(), [], '★ 负对照:没炼过 ⇒ 537 是空的');

  const first = sim.brewAtFurnace('阿岚', [ITEM_WHEAT, ITEM_PEACH]);
  ok(first.ok, `首次合成应成功(${first.reason ?? ''})`);
  eq(first.first, true, '第一次 ⇒ 首创');
  eq(first.entry!.recipeHash, '122_123', '配方哈希 = 材料 ID **升序**下划线拼接');
  eq(first.entry!.discovererName, '阿岚', '冠名 = 合成者');
  eq(first.entry!.craftCount, 1);
  eq(first.entry!.firstAt, 0, '逻辑时间戳取自世界帧序(0 帧),不读系统时钟');
  eq(first.display.length, 1, '陈列里出现 1 行');
  eq(galleryDisplay(createRoomSystemsState()), [], '空馆的投影是空数组(同一函数的负对照)');

  const second = sim.brewAtFurnace('小满', [ITEM_PEACH, ITEM_WHEAT]);
  ok(second.ok);
  eq(second.first, false, '第二次不是首创');
  eq(second.entry!.discovererName, '阿岚', '★ 首创者不变(材料顺序不同也算同一配方)');
  eq(second.entry!.craftCount, 2, '全服合成次数 +1');
  eq(second.display.length, 1, '同一配方只陈列一行');

  /* ★ 负对照:1 件材料(< 536 的 2 件下限)⇒ 拒绝,馆不变 */
  const one = sim.brewAtFurnace('小满', [ITEM_BERRY]);
  eq(one.ok, false, '★ 1 件材料不能开炉(内容表 536「任意 2~4 件」)');
  eq(sim.galleryProjection().length, 1, '★ 被拒的合成不留陈列行');

  /* ★ 负对照 2:内容表外编号 ⇒ 拒绝 */
  const unknown = sim.brewAtFurnace('小满', [ITEM_WHEAT, 99999]);
  eq(unknown.ok, false, '内容表里没有的物品不能进炉');
  eq(sim.galleryProjection().length, 1);
});

/* ═══════════ 7. 料理 3 字段:推到物理层(单点结算) ═══════════ */

test('FND77-7 料理 moveMul/gravityMul/jumpMul:慢帧推给物理层,且中性时不设记录', () => {
  /* 手算:
       · 601「移动速度 +15%」 ⇒ 速度上限 = 4.5 × 1.15 = 5.175(4.5 = 冻结层 BASE_MOVE_SPEED)
       · 609「重力降低 70%」 ⇒ 重力乘子 = 0.30
       · 604「跳跃高度 +50%」⇒ 起跳乘子 1.50;8 × 1.5 = 12
     怎么变红:
       · 慢帧不推 ⇒ 第 1 条(speedCapOf 仍是 null);
       · 推中性值 1 而不是撤掉 ⇒ 第 4 条(负对照里旁表非空);
       · `jump()` 不乘 ⇒ 第 6 条(仍是 8)。 */
  const { sim } = newWorld();

  /* ★ 负对照先行:没吃料理 ⇒ 三张旁表都没有记录(中性 = 1 / null) */
  slowFrame(sim);
  eq(sim.physics.speedCapOf('p1'), null, '★ 没吃料理 ⇒ 速度上限**不设记录**');
  eq(sim.physics.gravityMulOf('p1'), 1, '★ 没吃料理 ⇒ 重力乘子恒 1');
  eq(sim.physics.jumpMulOf('p1'), 1, '★ 没吃料理 ⇒ 起跳乘子恒 1');

  /* 吃下三份料理(601 / 609 / 604),再推一个慢帧 */
  eq(sim.useItem('p1', { itemId: 601 }).applied, true, '601 有使用语义');
  eq(sim.useItem('p1', { itemId: 609 }).applied, true);
  eq(sim.useItem('p1', { itemId: 604 }).applied, true);
  slowFrame(sim);

  near(sim.physics.speedCapOf('p1') ?? -1, 4.5 * 1.15, 1e-9, '★ 4.5 × 1.15 = 5.175');
  near(sim.physics.gravityMulOf('p1'), 0.30, 1e-9, '★ 609 的 0.30');
  near(sim.physics.jumpMulOf('p1'), 1.50, 1e-9, '★ 604 的 1.50');
  near(sim.jumpPlayer('p1', 8) ?? -1, 12, 1e-9, '★ 8 × 1.5 = 12(乘区只结算一次)');

  /* ★ 负对照 3:没吃料理的**另一个玩家**不受影响(乘子按刚体 id 索引) */
  eq(sim.physics.speedCapOf('nobody'), null, '★ 不存在的刚体:不设上限,也不报错');
  eq(sim.jumpPlayer('nobody', 8), null, '★ 不存在的刚体:返回 null(不抛错)');

  /* ★ 中性换算单点:`foodPhysicsOf` 对「全是 1」返回三个 null */
  eq(foodPhysicsOf({ moveMul: 1, gravityMul: 1, jumpMul: 1, gatherMul: 1 }), {
    speedCapMul: null, gravityMul: null, jumpMul: null,
  }, '★ 中性值必须是 null(推 1 会让「有没有 buff」不可判定)');
});

/* ═══════════ 8. gatherMul:采集乘子归属到发起者 ═══════════ */

test('FND77-8 gatherMul 归属:吃了 602 的人采集时回执带 1.2;不传 actor 则连键都没有', () => {
  /* 手算:602「伐木与采矿速度 +20%」 ⇒ 1.20。
     怎么变红:
       · `breakBlock` 不收 actor ⇒ 第 1 条(gatherMul 恒 undefined);
       · 对没有 buff 的人也报一个乘子 ⇒ 第 4 条。 */
  const { sim } = newWorld();

  /* ★ 负对照:不传 actor ⇒ 回执与接线前**逐位相同**(没有 gatherMul 键) */
  sim.setCell(9, 9, { obj: FURNITURE });
  const plain = sim.breakBlock(9, 9);
  eq(plain.ok, true);
  eq(Object.prototype.hasOwnProperty.call(plain, 'gatherMul'), false, '★ 不传 actor ⇒ 不多一个键');
  eq(sim.blockAt(9, 9), 0, '块真的被拆了');

  /* 吃了 602 再拆:乘子归属到发起者 */
  eq(sim.useItem('p1', { itemId: 602 }).applied, true, '602 有使用语义');
  sim.setCell(9, 9, { obj: FURNITURE });
  const withActor = sim.breakBlock(9, 9, 'p1');
  eq(withActor.ok, true);
  near(withActor.ok ? (withActor.gatherMul ?? -1) : -1, 1.2, 1e-9, '★ 602 的 1.20');

  /* ★ 负对照 2:没有 buff 的人采集 ⇒ 乘子是 1(中性,如实报,不是编一个数) */
  sim.setCell(10, 10, { obj: FURNITURE });
  const other = sim.breakBlock(10, 10, 'p_other');
  eq(other.ok, true);
  eq(other.ok ? other.gatherMul : undefined, 1, '★ 没吃料理 ⇒ 1(中性)');

  /* ★ 负对照 3:空格 ⇒ 失败,且失败回执里没有乘子字段 */
  const empty = sim.breakBlock(20, 20, 'p1');
  eq(empty.ok, false);
  eq(Object.prototype.hasOwnProperty.call(empty, 'gatherMul'), false);
});

/* ═══════════ 9. 内容表的两个缺口(如实锚定,不做「补全」) ═══════════ */

test('FND77-9 锚:「毛团」/「温泉橘」仍不在内容表 ⇒ 牧场产出 ID 为 null(本线不编 ID)', () => {
  /* 为什么这条留在本套件:`systems/ranch.ts:27-32` 明确把这两件物品的缺口
     设计成「null + unresolved」。owner 的 D-19 若决定补内容表,那是
     **内容层变更**(要同时更新 content baseline 与 docs 计数),
     不能由接线方顺手塞两个 ID 进来。 */
  const { sim } = newWorld();
  sim.setRanchPets([{ speciesId: 'mob_capybara', affinity: 0.8 }]);
  sim.setCell(6, 6, { obj: TROUGH });
  sim.dropItem(2.5, 2.5, ITEM_PEACH, 2);
  const r = sim.settleRanchIfDayChanged(2);
  const settle = sim.lastRanchSettle()!;
  eq(settle.produce[0].name, '温泉橘', '手册点名的产出名');
  eq(settle.produce[0].count, 2, '2 天 ⇒ 2 份');
  eq(settle.produce[0].itemId, null, '★ 内容表没有这件物品 ⇒ ID 如实为 null');
  eq(settle.unresolved, ['温泉橘'], '★ 缺口必须浮在脸上');
  eq(r.dropped, 0, '★ 没有 ID 就不许落货(不编一件"看起来差不多"的物品)');
  /* 冻结层常量顺带锚一下:本套件的倍率手算用的是它 */
  eq(BASE_MOVE_SPEED, 4.5, '锚:冻结层基准移速 4.5 格/秒');
  eq(BASE_HP, 100, '锚:冻结层基础生命 100');
});

report('WS-FND-77');