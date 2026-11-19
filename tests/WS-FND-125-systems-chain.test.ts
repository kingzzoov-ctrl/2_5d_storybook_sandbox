/**
 * WS-FND-125 —— 四系统链路里**三处「实现完整、生产半截」**的断链(第七轮实测)。
 *
 * ## 修前的三条断链(全部是「一段代码在跑、下一段没人接」)
 *
 * | # | 断在哪 | 症状(实测) |
 * | :--- | :--- | :--- |
 * | P0 | `systems/wiring.ts:growCrops` 成熟即 `st.crops.delete` + `st.harvest.push` | 产物**只活在内存数组**里:地面上没有、背包里没有、428/430 都抓不到;而 `harvestLog()` 全仓无生产读者 ⇒ 「收获」这个词在世界上没有任何痕迹 |
 * | P1-a | `systems/greenhouse.ts:sortHarvest` 拿 `cell.cropId` 当产物 id | 429 的过滤表按**产物** id 写永远不命中(作物 ↔ 产物从没有过映射) |
 * | P1-b | `wiring/logistics.ts:pickRoute` 只读 `filterIds/matchRoute` | 与房间侧的 `sortFilters`(lane 表)是**两套互不相通**的模型 ⇒ 过滤规则从未改变搬运目标 |
 * | P1-c | `mobs/taming.ts:carryLoad` 全仓只写 0 | `carrySpeedMul` 里的 `carryLoad > 0` 恒假 ⇒ 背物资减速是一条**永不成立**的分支 |
 *
 * ## 判据结构(每条都写清「怎么变红」+ 负对照/注入)
 *
 * | # | 正面 | 负对照 / 注入 |
 * | :--- | :--- | :--- |
 * | 1 | 作物→产物映射由**内容表**给 id(123→123 / 126→126) | 未登记的 121 露水甜莓 ⇒ `null`(不编 id) |
 * | 2 | 成熟 ⇒ 产物**真的交给落货口**(地面出现 1 件 123) | 同一格**不注入**落货口 ⇒ `landed: 'NONE'` + `unlanded 1` |
 * | 3 | 落货口回 `'GROUND'` ⇒ 行记 GROUND | 注入一个**回 'NONE'** 的桩 ⇒ 行立刻记 NONE(证明 `landed` 不是恒真) |
 * | 4 | 429 过滤表按**产物** id 命中(lane 2) | 表里写别的物品 ⇒ lane -1(原样留在带上) |
 * | 5 | `pickRoute` 读 429 表(0→左 / 2→右) | 表为空 ⇒ 回老口径;表非空时老字段不再说了算 |
 * | 6 | `tickLogistics` 让规则**真的改方向**(第 0 道 ⇒ 向北) | 不给规则表 ⇒ 老 `defaultRoute`(向南),两条路线的落点不同 |
 * | 7 | 全链:收获落地 → 428 装载 → 429 按产物分道 | 分道用的 id 与收获行 `productId` 是**同一个** |
 * | 8 | `commandPet(CARRY)` ⇒ `carryLoad 4` ⇒ `carrySpeedMul 0.9` | 切回 STAY / 未驯化 ⇒ `0` & `1`;进牧场也卸货 |
 * | 9 | 播种回执带 `productItemId`(动作层,真装配) | 不是种子 ⇒ 拒且回执为空 |
 *
 * ## 世界侧落货口在哪(为什么本判据用注入桩)
 *
 * `GrowInput.deliverHarvest` 由**世界**注入(落地面写 `mobGround`)。本线写域是
 * `systems/**` + `wiring/logistics.ts` + `net/actions/plant_crop.ts`,**不含
 * `sim/world_sim.ts`**(它正在被另一条线改)⇒ 判据用注入式落货口钉机制本身,
 * 并在第 10 条**如实报出**世界当前是否已注入(未注入 ⇒ 打一行 `[WS-FND-125]` 警告,
 * 而不是假装通过 —— 「跳过必须出声」)。
 *
 * 期望值来源:内容表(123/126/121/101)、冻结层常量(`SORT_PASS_THROUGH = -1`)、
 * `carrySlots('mob_sheep') = 4`(`mobs` 表 Lv1)。**不拿被测函数当期望**。
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import {
  HarvestLanding,
  createRoomSystemsState,
  growCrops,
  plantCrop,
  type GrowInput,
  type HarvestDelivery,
  type HarvestRow,
  type RoomSystemsState,
} from '../server/src/systems/wiring.ts';
import {
  HARVEST_YIELD,
  SORT_PASS_THROUGH,
  cropProductIdOf,
  cropProductNameOf,
  sortHarvest,
  type SortFilter,
} from '../server/src/systems/greenhouse.ts';
import {
  LANE_ROUTE,
  SorterRoute,
  applySorterFilters,
  createSorterState,
  loadConveyor,
  pickRoute,
  routeOfLane,
  tickLogistics,
  type ArmWorld,
  type LogisticsLine,
  type SorterLaneRule,
  type SorterState,
  type Stack,
} from '../server/src/wiring/logistics.ts';
import {
  TameCommand,
  carrySlots,
  carrySpeedMul,
  commandPet,
  createPetRecord,
  feedPet,
  sendToRanch,
  undeployPet,
} from '../server/src/mobs/taming.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionPayload } from '../server/src/net/room.ts';

/* ═══════════ 0. 夹具 ═══════════ */

const WHEAT = 123;   // 黄金小麦(内容表 note「河谷耕地播种收获」⇒ 可播种)
const PEPPER = 126;  // 爆裂火椒(note「星沙绿洲耕种收获」⇒ 可播种)
const BERRY = 121;   // 露水甜莓(内容表**没有**把它写成耕地作物 ⇒ 产物缺口的负对照)
const LOG = 101;     // 暖松原木(不是种子 ⇒ 负对照)
const SOIL = 301;    // 肥沃农田耕地

function freshState(): RoomSystemsState {
  return createRoomSystemsState();
}

/** 一天的温室输入(温室 + 洒水器 ⇒ 恒浇透、恒有光;判据只关心成熟那一步)。 */
function growInput(over: Partial<GrowInput> = {}): GrowInput {
  return {
    dayFraction: 1,
    night: false,
    weather: 'CLEAR',
    isGreenhouse: () => true,
    hasSprinkler: () => true,
    ...over,
  };
}

interface GroundItemRow { x: number; y: number; itemId: number; count: number }

/**
 * 假地面 + 落货口:**产物真的落地**只能这样验 —— 落货口写它,判据读它。
 * `landing` 可注入(`'NONE'` 用来证明 `landed` 不是恒真)。
 */
function sinkInto(ground: GroundItemRow[], landing: 'GROUND' | 'NONE' = 'GROUND') {
  return (h: HarvestDelivery): 'GROUND' | 'NONE' => {
    if (landing === 'NONE' || h.productId === null) return 'NONE';
    ground.push({ x: h.x, y: h.y, itemId: h.productId, count: h.count });
    return landing;
  };
}

interface DropLog { x: number; y: number; item: Stack }

/** `ArmWorld` 桩:无带可接、无设备,出货口一律**落地**(记在 `drops` 里)。 */
function dropWorld(drops: DropLog[], rules?: () => readonly SorterLaneRule[]): ArmWorld {
  const w: ArmWorld = {
    take: () => null,
    feed: () => true,
    deviceAt: () => 0,
    drop: (x, y, item) => {
      drops.push({ x, y, item });
      return true;
    },
  };
  if (rules !== undefined) w.sortFilters = rules;
  return w;
}

/** 只有一台分拣器的流水线(其余为空)。 */
function sorterLine(x: number, y: number, dir = 1): LogisticsLine {
  return { belts: [], sorters: [{ x, y, state: createSorterState(dir) }], arms: [], drills: [] };
}

const POWERED = { belt: true, arm: false, drill: false };

/* 世界侧(真装配:`assemble()` ⇒ `ctx.host` 就是 `WorldSim`,与 WS-FND-77/119 同一条路) */

interface SimHandle {
  readonly grid: { setFloor(x: number, y: number, itemId: number): void };
  plantCrop(x: number, y: number, cropId: number, matureDays?: number): { ok: boolean; reason: string };
  setSortFilters(filters: readonly { lane: number; itemIds: readonly number[] }[]): void;
  advanceRoomSystems(dayFraction?: number): { grown: number; matured: HarvestRow[] };
  harvestLog(): HarvestRow[];
  cropAt(x: number, y: number): { cropId: number; progress: number } | undefined;
}

function makeRoom(roomId: string): { rt: ReturnType<typeof assemble>['runtime']; sim: SimHandle } {
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => 0 }, sizeCells: 32, mobs: false,
    worldSeed: 1234, db: null, archiveSink: null,
  });
  a.runtime.join({ userId: 'p1' });
  return { rt: a.runtime, sim: a.host as unknown as SimHandle };
}

/** 走生产同一条路把东西塞进背包(先铸凭证,再 applyInventory)。 */
function seedBag(rt: ReturnType<typeof assemble>['runtime'], itemId: number, n: number): void {
  const src = `fnd125:${itemId}:${n}`;
  rt.grantItemSource('p1', src);
  const r = rt.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `前置:应能塞进 ${n} 件 #${itemId}(被拒 ${r.rejectCode ?? '?'})`);
}

/* ═══════════ 1. 作物 → 产物:名字是内容表字面量,id 由内容表查 ═══════════ */

test('FND125-1 ★作物→产物映射:123/126 命中内容表;未登记的 121 ⇒ null(不编 id)', () => {
  /* 怎么变红:把映射写成「产物 id = 作物 id」的隐式假设 ⇒ 第 2/3 条失去落点;
     给 121 编一个 id ⇒ 第 4 条。 */
  eq(HARVEST_YIELD, 1, '锚点:一格收 1 件(中性口径,内容表没有产量数字)');
  eq(cropProductNameOf(WHEAT), '黄金小麦', '名字来自内容表(不是本表自造的字面量)');
  eq(cropProductIdOf(WHEAT), WHEAT, '123 黄金小麦 ⇒ 产物就是黄金小麦本身(内容表 note)');
  eq(cropProductIdOf(PEPPER), PEPPER, '126 爆裂火椒 ⇒ 产物就是爆裂火椒本身');

  /* ★ 负对照:内容表没把它写成耕地作物 ⇒ 没有产物(如实 null,不猜) */
  eq(cropProductNameOf(BERRY), null, '★ 未登记的作物没有产物名');
  eq(cropProductIdOf(BERRY), null, '★ 未登记的作物没有产物 id(不许拿自己顶上)');
  eq(cropProductIdOf(LOG), null, '★ 暖松原木不是作物');
  eq(cropProductIdOf(0), null, '非法 id ⇒ null');
});

/* ═══════════ 2. P0:成熟 ⇒ 产物真的交给世界(注入落货口) ═══════════ */

test('FND125-2 ★P0 成熟 ⇒ 产物**真的落地**(地面上出现 1 件产物,账与地面一致)', () => {
  /* 怎么变红:
     · 成熟分支只 `st.harvest.push`(修前的原样)⇒ 第 3/4 条(地面空);
     · 把 `deliverHarvest` 的返回值丢掉、始终记 'GROUND' ⇒ 第 5 条(注入桩回 NONE 时仍绿);
     · 分拣写 `cell.cropId` 而不是产物 ⇒ 第 6 条。 */
  const st = freshState();
  ok(plantCrop(st, 3, 4, WHEAT, 1).ok, '前置:播种成功');
  const ground: GroundItemRow[] = [];
  const res = growCrops(st, growInput({ deliverHarvest: sinkInto(ground) }));

  eq(res.matured.length, 1, '一天(成熟天数 1)⇒ 成熟一份');
  eq(res.unlanded, 0, '★ 没有「没落地」的欠账');
  eq(ground, [{ x: 3, y: 4, itemId: WHEAT, count: 1 }], '★ 产物**真的落到世界**(不是只活在数组里)');
  eq(ground[0].itemId, cropProductIdOf(WHEAT), '落到地上的 id 就是映射给的**产物** id');
  eq(st.crops.size, 0, '收下来之后耕地腾空');
  eq(st.harvest.length, 1, '收获账一行');

  const row = res.matured[0];
  eq(row.productId, WHEAT, '行里带产物 id(429 按它分拣)');
  eq(row.count, 1, '行里带件数');
  eq(row.landed, HarvestLanding.GROUND, '★ 行记「真的落地了」');
  eq(HarvestLanding.NONE, 'NONE', '锚点:没落地的取值不得漂移');
  /* ★ 反同义反复:expected 侧写字面量 -1;常量在下一行的**锚点**行。 */
  eq(row.lane, -1, '没配 429 规则 ⇒ 道号 -1(原样留在带上)');
  eq(SORT_PASS_THROUGH, -1, '锚点:透传道 = -1');
});

/* ═══════════ 3. P0 负对照:不注入落货口 ⇒ 账上必须写明「没落地」 ═══════════ */

test('FND125-3 ★P0 负对照:不注入落货口 ⇒ 产物**没落地**要如实记(unlanded=1,不是静默)', () => {
  /* 怎么变红:缺省时假装落地(记 GROUND / unlanded 恒 0)⇒ 第 3/4 条。 */
  const st = freshState();
  ok(plantCrop(st, 5, 6, WHEAT, 1).ok, '前置:播种成功');
  const res = growCrops(st, growInput());

  eq(res.matured.length, 1, '成熟仍然照常摘走并记账(修前的语义不变)');
  eq(res.matured[0].landed, HarvestLanding.NONE, '★ 没有落货口 ⇒ landed 记 NONE');
  eq(res.unlanded, 1, '★ 欠账计数非零(修前这里恒 0 —— 账上是好消息、世界是空的)');
  ok(res.unlandedReasons[0].includes('落货口'), `理由要说清缺什么(${res.unlandedReasons[0]})`);
  eq(st.harvest[0].landed, HarvestLanding.NONE, '账上那一行同样记 NONE(两处同源)');
});

/* ═══════════ 4. P0 注入验证:落货口回什么,账就记什么 ═══════════ */

test('FND125-4 ★注入验证:落货口回 `NONE` ⇒ 同一套夹具立刻变红(landed 不是恒真)', () => {
  /* 怎么变红:实现里把 `'GROUND'` 写死 ⇒ 本条的 landed 会变成 GROUND(红);
     反过来把 `'NONE'` 写死 ⇒ FND125-2 的第 5 条红。两条互为反向注入。 */
  const st = freshState();
  ok(plantCrop(st, 7, 8, WHEAT, 1).ok, '前置:播种成功');
  const ground: GroundItemRow[] = [];
  const res = growCrops(st, growInput({ deliverHarvest: sinkInto(ground, 'NONE') }));

  eq(ground, [], '落货口说收不下 ⇒ 地上不该多出东西');
  eq(res.matured[0].landed, HarvestLanding.NONE, '★ 世界说什么,账就记什么');
  eq(res.unlanded, 1, '★ 欠账如实记');
});

/* ═══════════ 5. P1:429 过滤表按**产物** id 命中 ═══════════ */

test('FND125-5 ★429 过滤表按**产物** id 命中(lane 2);写别的物品 ⇒ 原样留在带上', () => {
  /* 怎么变红:实现里拿 `cropId` 之外的东西(或拿**名字**)去 `sortHarvest` ⇒ 第 2 条;
     命中后不区分道号 ⇒ 第 3 条。 */
  const st = freshState();
  st.sortFilters = [{ lane: 2, itemIds: [WHEAT] }] as SortFilter[];
  ok(plantCrop(st, 1, 1, WHEAT, 1).ok, '前置:播种成功');
  const ground: GroundItemRow[] = [];
  const res = growCrops(st, growInput({ deliverHarvest: sinkInto(ground) }));

  eq(sortHarvest(cropProductIdOf(WHEAT)!, st.sortFilters), 2, '判定与判据同源:产物 id 命中第 2 道');
  eq(res.matured[0].lane, 2, '★ 收获行按**产物** id 分到第 2 道');

  /* ★ 负对照:规则表里没有这件产物 ⇒ -1(不是随便挑一道) */
  const st2 = freshState();
  st2.sortFilters = [{ lane: 2, itemIds: [PEPPER] }] as SortFilter[];
  ok(plantCrop(st2, 1, 1, WHEAT, 1).ok, '前置:同一种小麦');
  const g2: GroundItemRow[] = [];
  const res2 = growCrops(st2, growInput({ deliverHarvest: sinkInto(g2) }));
  eq(res2.matured[0].lane, -1, '★ 表里只收火椒 ⇒ 小麦 -1');
  eq(g2.length, 1, '分不到道**不影响落地**:货仍然在地上(道号只决定往哪拐)');
});

/* ═══════════ 6. P1:pickRoute 读 429 过滤表(单一事实源) ═══════════ */

test('FND125-6 ★`pickRoute` 读 429 表(0→左 / 2→右);表空 ⇒ 老口径;表非空时老字段说了不算', () => {
  /* 怎么变红:
     · `pickRoute` 仍只读 `filterIds/matchRoute` ⇒ 第 2/3 条;
     · 道号→三路另写一张表(与本文件的 `LANE_ROUTE` 不一致)⇒ 第 1/2/3 条。 */
  eq(LANE_ROUTE[0], SorterRoute.LEFT, '第 0 道 = 左');
  eq(LANE_ROUTE[1], SorterRoute.FORWARD, '第 1 道 = 前');
  eq(LANE_ROUTE[2], SorterRoute.RIGHT, '第 2 道 = 右');
  eq(routeOfLane(0), 'LEFT', '锚点:字面量');
  eq(routeOfLane(3), null, '★ 表外道号不许猜');
  eq(routeOfLane(-1), null, '★ 负号不是道号(`-1` 是 sortHarvest 的「不分拣」)');
  eq(routeOfLane(1.5), null, '非整数不是道号');

  const s: SorterState = createSorterState(1);
  s.defaultRoute = SorterRoute.FORWARD;
  const table: readonly SorterLaneRule[] = [
    { lane: 0, itemIds: [WHEAT] },
    { lane: 2, itemIds: [PEPPER] },
  ];
  eq(applySorterFilters(s, table), 2, '两条规则生效');
  eq(pickRoute(s, WHEAT), SorterRoute.LEFT, '★ 第 0 道 ⇒ 左');
  eq(pickRoute(s, PEPPER), SorterRoute.RIGHT, '★ 第 2 道 ⇒ 右');
  eq(pickRoute(s, LOG), SorterRoute.FORWARD, '没命中任何规则 ⇒ defaultRoute(不是「猜一路」)');

  /* ★ 表非空时,老的 `filterIds/matchRoute` 不再是事实源 */
  const legacy = createSorterState(1, [WHEAT]);
  legacy.matchRoute = SorterRoute.RIGHT;
  legacy.defaultRoute = SorterRoute.FORWARD;
  eq(pickRoute(legacy, WHEAT), SorterRoute.RIGHT, '老口径:表空时 filterIds 命中 ⇒ matchRoute');
  applySorterFilters(legacy, [{ lane: 0, itemIds: [WHEAT] }]);
  eq(pickRoute(legacy, WHEAT), SorterRoute.LEFT, '★ 灌进 429 表之后 ⇒ 第 0 道(老字段不再说了算)');

  /* 表外道号 / 空 itemIds 在灌入时被丢掉 */
  const dropped = createSorterState(1);
  eq(applySorterFilters(dropped, [{ lane: 9, itemIds: [WHEAT] }]), 1, '道号 9 保留(由 pickRoute 判表外)');
  eq(pickRoute(dropped, WHEAT), dropped.defaultRoute, '★ 表外道号 ⇒ defaultRoute');
  eq(applySorterFilters(dropped, [{ lane: 1, itemIds: [] }]), 0, '空 itemIds 的规则被丢(这一道什么都收不到)');
  eq(pickRoute(dropped, WHEAT), dropped.defaultRoute, '★ 规则表变空 ⇒ 回到老口径');

  /* 结构兼容:房间侧的 `SortFilter[]` 可以直接灌进分拣器(同一个形状) */
  const roomTable: readonly SortFilter[] = [{ lane: 1, itemIds: [WHEAT] }];
  eq(applySorterFilters(dropped, roomTable), 1, '`SortFilter[]` 与 `SorterLaneRule[]` 逐字段兼容');
  eq(pickRoute(dropped, WHEAT), SorterRoute.FORWARD, '第 1 道 ⇒ 前');
});

/* ═══════════ 7. P1:tickLogistics 让过滤规则**真的改方向** ═══════════ */

test('FND125-7 ★`tickLogistics` 把世界 429 表灌进分拣器 ⇒ 出货方向真的变了', () => {
  /* 怎么变红:`tickLogistics` 不调 `applySorterFilters` ⇒ 两次落点相同(第 3/4 条)。 */
  const line = sorterLine(5, 5, 1 /* 朝东 */);
  ok(loadConveyor(line.sorters[0].state.conveyor, { id: WHEAT, count: 1 }), '前置:带上有 1 件小麦');

  const drops: DropLog[] = [];
  const world = dropWorld(drops, () => [{ lane: 0, itemIds: [WHEAT] }]);
  tickLogistics(line, world, POWERED);
  eq(drops.length, 0, '2Hz 下一帧只走半格');
  tickLogistics(line, world, POWERED);
  eq(drops.length, 1, '两帧 = 一格 ⇒ 出货');
  eq(drops[0].x, 5, '★ 第 0 道 = 左 = dir−1(朝北)⇒ x 不变');
  eq(drops[0].y, 4, '★ 第 0 道 ⇒ 向北一格(5,4)');

  /* ★ 负对照:不提供规则表 ⇒ 老 `defaultRoute`(默认 RIGHT = 朝南) */
  const line2 = sorterLine(5, 5, 1);
  ok(loadConveyor(line2.sorters[0].state.conveyor, { id: WHEAT, count: 1 }), '前置:同样 1 件小麦');
  const drops2: DropLog[] = [];
  const world2 = dropWorld(drops2);
  tickLogistics(line2, world2, POWERED);
  tickLogistics(line2, world2, POWERED);
  eq(drops2.length, 1, '同样出货');
  eq({ x: drops2[0].x, y: drops2[0].y }, { x: 5, y: 6 }, '★ 老口径 ⇒ 向南(5,6)');
  ok(drops2[0].y !== drops[0].y, '★ 两条路线的落点不同 ⇒ 过滤规则真的改变了搬运目标');
});

/* ═══════════ 8. 全链:收获落地 → 428 装载 → 429 按产物分道 ═══════════ */

test('FND125-8 ★全链:收获的产物落到地上、被带上装走、按同一张 429 表分流', () => {
  /* 怎么变红:任何一环的 id 不一致(作物 id≠产物 id / 分拣用别的键)⇒ 第 3/4 条。 */
  const st = freshState();
  st.sortFilters = [{ lane: 1, itemIds: [WHEAT] }] as SortFilter[];
  ok(plantCrop(st, 2, 2, WHEAT, 1).ok, '前置:播种成功');

  const ground: GroundItemRow[] = [];
  const harvest = growCrops(st, growInput({ deliverHarvest: sinkInto(ground) }));
  eq(ground.length, 1, '★ 第一步:产物落到地上');
  eq(harvest.matured[0].productId, ground[0].itemId, '收获行与地面是**同一件**产物');

  /* 第二步:428 装载(与 `WorldSim.loadConveyorAt` 同语义:从地上取、装到带上) */
  const line = sorterLine(2, 2, 1);
  const stack: Stack = { id: ground[0].itemId, count: ground[0].count };
  ok(loadConveyor(line.sorters[0].state.conveyor, stack), '第二步:装到 429 的带上');

  /* 第三步:分道(规则表就是房间侧那张 —— 单一事实源) */
  const drops: DropLog[] = [];
  const world = dropWorld(drops, () => st.sortFilters);
  tickLogistics(line, world, POWERED);
  tickLogistics(line, world, POWERED);
  eq(drops.length, 1, '第三步:货按规则出货');
  eq({ x: drops[0].x, y: drops[0].y }, { x: 3, y: 2 }, '★ 第 1 道 = 前 = 朝东(3,2)');
  eq(drops[0].item.id, harvest.matured[0].productId, '★ 全链只用一个 id:产物 id');
});

/* ═══════════ 9. P1:carryLoad 有生产者 ⇒ carrySpeedMul 不再恒 1 ═══════════ */

test('FND125-9 ★`carryLoad` 有生产者:CARRY ⇒ 4 格 & 0.9;STAY/未驯化/进牧场 ⇒ 0 & 1', () => {
  /* 怎么变红:把 `commandPet` 里对 carryLoad 的赋值删掉(修前的原样)⇒ 第 3/4 条;
     减速系数写成 1 ⇒ 第 4 条。 */
  const pet = createPetRecord('mob_sheep')!;
  eq(pet.carryLoad, 0, '初始没背货');
  eq(carrySpeedMul(pet), 1, '★ 负对照:没接 CARRY ⇒ 不减速');

  ok(feedPet(pet, WHEAT).ok, '前置:喂食成功');
  eq(commandPet(pet, TameCommand.CARRY), true, '前置:驯化后接得下 CARRY 指令');
  eq(pet.carryLoad, carrySlots('mob_sheep'), '★ `carryLoad` 有真实生产者');
  eq(carrySlots('mob_sheep'), 4, '锚点:mobs 表 Lv1 ⇒ 4 格(4 + floor(1/5))');
  near(carrySpeedMul(pet), 0.9, 1e-9, '★ 背物资 ⇒ 移速 ×0.9(修前恒 1)');

  eq(commandPet(pet, TameCommand.STAY), true, '切回 STAY');
  eq(pet.carryLoad, 0, '★ 不背了 ⇒ 负载归零');
  eq(carrySpeedMul(pet), 1, '★ 减速随之消失(双向钉住,不是恒 0.9)');

  /* ★ 负对照:未驯化 ⇒ 指令拒收,负载不动 */
  const wild = createPetRecord('mob_sheep')!;
  eq(commandPet(wild, TameCommand.CARRY), false, '野外生物拒不服从');
  eq(wild.carryLoad, 0, '★ 被拒时负载零变化');

  /* 进牧场 = 回 STAY ⇒ 卸货(否则 0.9 会跟一辈子) */
  commandPet(pet, TameCommand.CARRY);
  ok(sendToRanch([pet], pet), '前置:送进牧场');
  eq(pet.carryLoad, 0, '★ 进牧场卸货');
  eq(carrySpeedMul(pet), 1, '★ 移速回到 1');
  commandPet(pet, TameCommand.CARRY);
  undeployPet([pet], pet);
  eq(pet.carryLoad, 0, '★ 收队也卸货');
});

/* ═══════════ 10. 动作侧:播种回执带产物 id ═══════════ */

test('FND125-10 ★播种回执带 `productItemId`(按它配 429);不是种子 ⇒ 拒且回执为空', () => {
  /* 怎么变红:回执只给 `cropId`(修前的原样)⇒ 第 3 条。 */
  const { rt, sim } = makeRoom('r125_10');
  sim.grid.setFloor(2, 2, SOIL);
  seedBag(rt, WHEAT, 1);
  const out = rt.dispatchAction('p1', RoomAction.PLACE_AUTOMATION, { x: 2, y: 2, itemId: WHEAT } as unknown as ActionPayload);
  eq(out.ok, true, `前置:播种应成功(${out.kind} ${out.reason ?? '-'})`);
  eq(out.effect?.['seedItemId'], WHEAT, '回执带种子 id');
  eq(out.effect?.['productItemId'], WHEAT, '★ 回执带**产物** id(内容表映射)');
  ok(typeof out.effect?.['note'] === 'string' && String(out.effect?.['note']).includes('429'),
    '★ 回执要说清「429 按产物 id 配」');

  /* ★ 负对照:不是种子 ⇒ 拒,且没有回执 */
  seedBag(rt, LOG, 1);
  const bad = rt.dispatchAction('p1', RoomAction.PLACE_AUTOMATION, { x: 3, y: 3, itemId: LOG } as unknown as ActionPayload);
  eq(bad.ok, false, '暖松原木不是种子');
  eq(bad.effect, undefined, '★ 被拒 ⇒ 零回执');
});

/* ═══════════ 11. 世界侧:收获行带产物 id / 道号(如实报落货口状态) ═══════════ */

test('FND125-11 世界侧 `advanceRoomSystems` 的收获行带产物 id 与道号;落货口状态如实报出', () => {
  /* 怎么变红:wiring 拿 cropId 当产物 ⇒ 第 3 条;道号不读 429 表 ⇒ 第 4 条。 */
  const { sim } = makeRoom('r125_11');
  sim.grid.setFloor(2, 2, SOIL);
  ok(sim.plantCrop(2, 2, WHEAT, 1).ok, '前置:耕地上播种');
  sim.setSortFilters([{ lane: 2, itemIds: [WHEAT] }]);

  const d = sim.advanceRoomSystems(1);
  eq(d.matured.length, 1, '一天成熟(成熟天数 1)');
  const row = d.matured[0];
  eq(row.cropId, WHEAT, '作物是小麦');
  eq(row.productId, WHEAT, '★ 记录里带**产物** id');
  eq(row.count, 1, '★ 记录里带件数(锚点见 L181:一格 1 件)');
  eq(row.lane, 2, '★ 429 的过滤表(按产物 id)把它分到第 2 道');
  eq(sim.harvestLog()[0].productId, WHEAT, '收获账与回执同一份');
  eq(sim.harvestLog().length, 1, '账只有一行');

  /*
   * ★ 登记(不是「跳过」):世界侧的落货口 `GrowInput.deliverHarvest` 由
   *   `sim/world_sim.ts` 注入,**不在本线写域**(该文件正被另一条线修改)。
   *   于是这里如实报出「现在有没有人接住产物」—— 未接住时账上就是
   *   `landed: 'NONE'` + `unlanded > 0`,而不是修前那种**无声**的丢货。
   */
  if (row.landed !== HarvestLanding.GROUND && row.landed !== HarvestLanding.INVENTORY) {
    console.warn('[WS-FND-125] world_sim 尚未注入 `GrowInput.deliverHarvest` ⇒ ',
      '收获产物记账为 landed:', row.landed, '(机制已在 FND125-2/3/4 钉住,世界接线待另一条线合并)');
  }
  ok(row.landed === HarvestLanding.GROUND || row.landed === HarvestLanding.INVENTORY
    || row.landed === HarvestLanding.NONE, `landed 只能是三值之一(实得 ${String(row.landed)})`);
  eq(sim.cropAt(2, 2), undefined, '成熟后耕地腾空');
});

report('WS-FND-125');