/**
 * WS-FND-119 —— 三个「喂料口」**接进真实动作路径**的判据(第六轮实测 P0)。
 *
 * ## 缺陷(实测,不是推测)
 *
 * `WorldSim` 的三个写入口在 `server/**` 内**零调用**,唯一调用方是 `tests/**`:
 *
 * ```
 * setRanchPets    圈养名单 ⇒ 生产恒空 ⇒ settleRanchIfDayChanged 每慢帧空跑(牧场无产出)
 * plantCrop       耕地作物 ⇒ 生产恒空 ⇒ advanceRoomSystems 的温室分支连入参都不建
 * setSortFilters  429 过滤 ⇒ 生产恒空 ⇒ sortHarvest 恒回 -1(分拣道恒 -1)
 * ```
 *
 * ⇒ 校验全绿、回执全对、世界里什么都没发生(「实现完整、生产零消费」家族第 11 例)。
 *
 * ## 修法(只接动作层,不改平衡数字)
 *
 * ```
 * BREED_TAME 的 RANCH 子操作                 → host.setRanchPets
 * PLACE_AUTOMATION 的播种形态({itemId,x,y})  → host.plantCrop     (经 plant_crop.ts)
 * PLACE_AUTOMATION 放下 429 且带 lane/itemId → host.setSortFilters
 * ```
 * 判定全在 `systems/intake.ts`(纯函数),世界写入仍只由宿主做。
 *
 * ## 判据结构(每条都写清「怎么变红」)
 *
 * | # | 正面(喂了 ⇒ 有产出) | 负对照 / 注入(不喂 ⇒ 空跑) |
 * | :--- | :--- | :--- |
 * | 1 | 投票:喂满 + 驯服 + RANCH ⇒ `ranchPets` 非空,2 天日结吃 2 件、产 2 份并落槽 | 同一套夹具**跳过 RANCH** ⇒ 名单空、一份产出都没有、饲料一件没动 |
 * | 2 | RANCH 后 `petId` 去重键原样进世界(再送一次不增行) | 未驯服 / 别人驯服 / 非牧场物种 ⇒ 拒,名单一位不变 |
 * | 3 | 播种 ⇒ `crops()` 有 1 格、种子被扣、慢帧 1 天长 0.25 | 非耕地 / 不是种子 / 背包没有 / 同格再种 ⇒ 拒,作物与背包零变化 |
 * | 4 | 放 429 带 lane ⇒ `sortFilters()` 非空 ⇒ 收获按道分拣(2) | 不带参数 ⇒ 规则不变;`lane: -1` ⇒ 拒且规则/登记/背包零变化 |
 * | 5 | 新房间:三个入口都是空 ⇒ `grown 0 / produced 0 / lane -1` | 同上,再用**同一调用**喂过之后给出非零(互为反证) |
 * | 6 | `systems/intake.ts` 的纯判定:羊 ✅ 松鼠 ❌、123 ✅ 可种 / 101 ❌、lane 2 ✅ / -1 ❌ | 每个函数都有一条「拒」的输入 |
 * | 7 | 宿主**没有**写口 ⇒ `NOT_IMPLEMENTED`(注入:证明这三口只有一条路) | 拒绝路径上宠物状态与背包都零变化 |
 *
 * ## 期望值从哪来(**不许取自被测模块**)
 *
 * 手算(2 天 × 1 份/天 = 2;1/4 天 = 0.25)或内容表 / 冻结层的既有常量
 * (物品 id 123/126/101/429、`SORT_PASS_THROUGH = -1`)。引用被测算法的常量只做**锚点**
 * (如 `CROP_MATURE_DAYS`),不复用它充当期望。
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome, type ActionPayload } from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { RoomStatus } from '../server/src/db/repo.ts';
import { breedTame, forgetRoom, petsOfRoom } from '../server/src/net/actions/breed_tame.ts';
import { placementAt, placeAutomation as placeAutomationFor } from '../server/src/net/actions/place_automation.ts';
import { addPetToRanch, addSortFilter, sowableReasonOf, SOWABLE_ITEM_IDS } from '../server/src/systems/intake.ts';
import { CROP_MATURE_DAYS } from '../server/src/systems/wiring.ts';
import { RANCH_AFFINITY_MIN, RANCH_PRODUCE_BY_SPECIES } from '../server/src/systems/ranch.ts';

/* ═══════════ 0. 夹具 ═══════════ */

/** 用到的世界能力(**只声明用到的**,不复制 `WorldSim`)。 */
interface SimHandle {
  readonly grid: { setFloor(x: number, y: number, itemId: number): void };
  setCell(x: number, y: number, fields: { obj?: number }): void;
  blockAt(x: number, y: number): number;
  crops(): { x: number; y: number; cropId: number }[];
  cropAt(x: number, y: number): { cropId: number; matureDays: number; progress: number } | undefined;
  harvestLog(): { x: number; y: number; cropId: number; lane: number }[];
  ranchPets(): { petId?: string; speciesId: string; affinity: number }[];
  sortFilters(): { lane: number; itemIds: number[] }[];
  advanceRoomSystems(dayFraction?: number): { grown: number; matured: { lane: number }[]; ranchProduced: number };
  settleRanchIfDayChanged(days: number): { days: number; produced: number; dropped: number };
  lastRanchSettle(): { feedConsumed: { itemId: number; count: number }[]; produce: { count: number; name: string }[] } | null;
  lastRanchDrops(): { dropped: { itemId: number; count: number }[] };
  dropItem(x: number, y: number, itemId: number, count: number): void;
  groundItemsNear(x: number, y: number, radius: number): { itemId: number; count: number }[];
}

/** 生产装配(与 `WS-FND-77` / `WS-FND-115` 同一条路:`assemble()` ⇒ host 就是 `WorldSim`)。 */
function makeRoom(roomId: string): { rt: ReturnType<typeof assemble>['runtime']; sim: SimHandle } {
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => 0 }, sizeCells: 32, mobs: false,
    worldSeed: 1234, db: null, archiveSink: null,
  });
  a.runtime.join({ userId: 'p1' });
  a.runtime.join({ userId: 'p2' });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const u of ['p1', 'p2']) {
    for (const id of a.runtime.authoritativeItemIds(u)) a.runtime.applyInventory(u, { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount(u, id) }] });
  }
  return { rt: a.runtime, sim: a.host as unknown as SimHandle };
}

/** 走生产同一条路把东西塞进背包(先铸凭证,再 applyInventory)。 */
function seed(
  rt: ReturnType<typeof assemble>['runtime'],
  userId: string,
  itemId: number,
  n: number,
): void {
  const src = `seed:${userId}:${itemId}:${n}`;
  rt.grantItemSource(userId, src);
  const r = rt.applyInventory(userId, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `前置:应能塞进 ${n} 件 #${itemId}(被拒 ${r.rejectCode ?? '?'})`);
}

/** 派一次动作(真装配、真分派)。 */
function disp(
  rt: ReturnType<typeof assemble>['runtime'],
  action: RoomAction,
  payload: Record<string, unknown>,
  actorId = 'p1',
): ActionOutcome {
  return rt.dispatchAction(actorId, action, payload as unknown as ActionPayload);
}

const feed = (petId: string, mobId: string, itemId: number): Record<string, unknown> =>
  ({ op: 'FEED', petId, mobId, itemId });

/** 物品 id 全部来自冻结内容表/组件表(不是自造)。 */
const WHEAT = 123;      // 黄金小麦(绵羊饲料;note 自称「耕地播种收获」⇒ 可播种)
const PEPPER = 126;     // 爆裂火椒(note「耕种收获」⇒ 可播种)
const LOG = 101;        // 暖松原木(不是种子 ⇒ 负对照)
const SOIL = 301;       // 肥沃农田耕地
const STONE_PATH = 302; // 青苔鹅卵石径(不是耕地)
const TROUGH = 529;     // 牧场动物自动饲育槽
const SORTER = 429;     // 智能分拣交叉带(组件的**实物** id)

/* ═══════════ 1. 牧场:喂了 ⇒ 名单非空 ⇒ 有产出 ═══════════ */

test('FND119-1 ★ 喂满 + 驯服 + RANCH ⇒ 圈养名单非空 ⇒ 2 天日结吃 2 件、产 2 份并落槽', () => {
  /* 怎么变红:
     · `breed_tame.ts` 的 RANCH 分支不调 `host.setRanchPets` ⇒ 第 4/5 条;
     · `world_sim.setRanchPets` 把 `petId` 丢掉 ⇒ 第 6 条(去重键没了);
     · 亲和换算写成常数(例如恒 0.7)⇒ 第 7 条(= 1.0 才成立)。 */
  const { rt, sim } = makeRoom('r119_1');
  seed(rt, 'p1', WHEAT, 3);

  for (let i = 0; i < 3; i += 1) {
    const r = disp(rt, RoomAction.BREED_TAME, feed('pet:sheep', 'mob_sheep', WHEAT));
    eq(r.ok, true, `前置:第 ${i + 1} 口投喂应成功(reason=${r.reason ?? '-'})`);
  }
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'TAME', petId: 'pet:sheep' }).ok, true, '前置:驯服成功');
  eq(sim.ranchPets().length, 0, '★ 只驯服**不算**进牧场(名单仍空 —— 这是 P0 的起点)');

  const toRanch = disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:sheep' });
  eq(toRanch.ok, true, `★ 送进牧场应成功(kind=${toRanch.kind} reason=${toRanch.reason ?? '-'})`);
  eq(toRanch.kind, 'OK', '成功路径必须是 OK');
  eq(sim.ranchPets().length, 1, '★ 生产里 `ranchPets` **不再恒空**(修前这里恒为 0)');
  eq(sim.ranchPets()[0].speciesId, 'mob_sheep', '物种进了世界');
  eq(sim.ranchPets()[0].petId, 'pet:sheep', '★ 去重键 `petId` 原样带进世界(丢了就会 N 倍产出)');
  near(sim.ranchPets()[0].affinity, 1, 1e-9, '好感 3/3 ⇒ 亲和 1.0(≥ RANCH_AFFINITY_MIN)');

  /* 槽 + 地面 3 件饲料 ⇒ 2 天日结 */
  sim.setCell(6, 6, { obj: TROUGH });
  sim.dropItem(1.5, 1.5, WHEAT, 3);
  const settled = sim.settleRanchIfDayChanged(2);
  eq(settled.days, 2, '结算 2 天');
  eq(settled.produced, 1, '一只羊 ⇒ 一行产出');
  const rec = sim.lastRanchSettle()!;
  eq(rec.feedConsumed, [{ itemId: WHEAT, count: 2 }], '2 天 × 1 份/天 ⇒ 吃掉 2 件');
  eq(rec.produce.length, 1, '产出 1 行');
  eq(rec.produce[0].count, 2, '2 天 ⇒ 2 份(毛团)');
  eq(rec.produce[0].name, RANCH_PRODUCE_BY_SPECIES.mob_sheep!, '产出名 = 手册 529 点名的那个');
  ok(sim.lastRanchDrops().dropped.length > 0, '★ 产出真的落到 529 槽上(不是只在回执里算)');
});

/* ═══════════ 2. 牧场负对照:不喂 ⇒ 空跑 ═══════════ */

test('FND119-2 ★负对照:同样的动物与饲料,但**不送进牧场** ⇒ 名单空、一份产出都没有、饲料一件没动', () => {
  /* 怎么变红:把 RANCH 之前那条「只驯服不算进牧场」改成驯服即入圈 ⇒ 第 2/4/5 条全红。 */
  const { rt, sim } = makeRoom('r119_2');
  seed(rt, 'p1', WHEAT, 3);
  for (let i = 0; i < 3; i += 1) disp(rt, RoomAction.BREED_TAME, feed('pet:sheep', 'mob_sheep', WHEAT));
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'TAME', petId: 'pet:sheep' }).ok, true, '前置:驯服成功');
  eq(sim.ranchPets().length, 0, '★ 没走 RANCH ⇒ 名单空');

  sim.setCell(6, 6, { obj: TROUGH });
  sim.dropItem(1.5, 1.5, WHEAT, 3);
  const settled = sim.settleRanchIfDayChanged(2);
  eq(settled.produced, 0, '★ 名单空 ⇒ 产出 0(校验全绿而牧场空转,正是 P0)');
  eq(sim.lastRanchSettle()!.feedConsumed, [], '没有任何动物吃到饲料');
  const left = sim.groundItemsNear(1.5, 1.5, 2).reduce((n, g) => n + g.count, 0);
  eq(left, 3, '★ 3 件饲料还在原地(没被凭空消耗)');
});

/* ═══════════ 3. 牧场前置:RANCH 的每一条拒绝都零副作用 ═══════════ */

test('FND119-3 ★ RANCH 前置:未驯服 / 不是主人 / 非牧场物种 ⇒ 拒;同一只再送一次不增行', () => {
  /* 怎么变红:去掉 `pet.ownerId !== ctx.actorId` 那条 ⇒ 第 2 条;
     去掉 `systems/intake.ts` 的物种白名单 ⇒ 第 3 条(松鼠会进圈)。 */
  const { rt, sim } = makeRoom('r119_3');
  seed(rt, 'p1', WHEAT, 6);

  /* 1 没有记录 ⇒ 拒 */
  const none = disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:ghost' });
  eq(none.ok, false, '没有记录的宠物不能送进牧场');
  eq(none.kind, 'INVALID', '归为 INVALID(报文/状态不对,不是权限)');
  eq(sim.ranchPets().length, 0, '★ 拒绝路径上名单零变化');

  /* 2 喂满但**未驯服**(无主)⇒ 拒 */
  for (let i = 0; i < 3; i += 1) disp(rt, RoomAction.BREED_TAME, feed('pet:sheep', 'mob_sheep', WHEAT));
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'TAME', petId: 'pet:sheep' }).ok, true, '前置:驯服 pet:sheep');
  const notMine = disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:sheep' }, 'p2');
  eq(notMine.ok, false, '★ 别人不能把 p1 的宠物送进牧场');
  eq(sim.ranchPets().length, 0, '零副作用:名单仍空');

  /* 3 可驯服但**不是**牧场物种(花栗鼠)⇒ 拒 */
  for (let i = 0; i < 3; i += 1) disp(rt, RoomAction.BREED_TAME, feed('pet:squirrel', 'mob_squirrel', WHEAT));
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'TAME', petId: 'pet:squirrel' }).ok, true, '前置:驯服花栗鼠');
  const squirrel = disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:squirrel' });
  eq(squirrel.ok, false, '★ 手册 529 只养绵羊与水豚 ⇒ 花栗鼠进不了牧场');
  ok((squirrel.reason ?? '').includes('牧场'), `拒绝理由要说清是牧场物种(${squirrel.reason ?? '-'})`);
  eq(sim.ranchPets().length, 0, '零副作用:名单仍空');

  /* 4 正例 + 重复送 ⇒ 只有一行(去重键 `petId`) */
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:sheep' }).ok, true, '前置:送进牧场');
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:sheep' }).ok, true, '再送一次:幂等成功');
  eq(sim.ranchPets().length, 1, '★ 同一只宠物只有一行(否则反复送 = N 倍产出)');
  eq(petsOfRoom('r119_3').length, 2, '宠物容器里仍是两只(牧場是投影,不改归属)');
  forgetRoom('r119_3');
});

/* ═══════════ 4. 温室:播种 ⇒ 世界有作物 ⇒ 慢帧真的生长 ═══════════ */

test('FND119-4 ★ PLACE_AUTOMATION 的播种形态 ⇒ `crops()` 非空、种子被扣、1 天长 0.25', () => {
  /* 怎么变红:
     · 播种分支不调 `host.plantCrop` ⇒ 第 2/4 条(修前 `crops` 恒空);
     · 不扣种子 ⇒ 第 3 条;
     · 把成熟天数写死成别的数 ⇒ 第 5 条(1/4 = 0.25 是手算)。 */
  const { rt, sim } = makeRoom('r119_4');
  sim.grid.setFloor(2, 2, SOIL);
  seed(rt, 'p1', WHEAT, 1);
  eq(sim.crops().length, 0, '前置:世界里还没有作物');

  const r = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 2, y: 2, itemId: WHEAT });
  eq(r.kind, 'OK', `★ 播种应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(sim.crops().length, 1, '★ 生产里 `crops` **不再恒空**(修前这里恒为 0)');
  eq(sim.cropAt(2, 2)!.cropId, WHEAT, '种下的就是那件种子(id 同源)');
  /* 4 = `systems/wiring.ts:112` 的 `CROP_MATURE_DAYS`(字面量取自**源码实测**,
     不从被测模块取常量 —— 否则改常量断言跟着变,永远相等)。 */
  eq(sim.cropAt(2, 2)!.matureDays, 4, '锚:成熟天数 = 4 天(wiring.ts 的 CROP_MATURE_DAYS)');
  eq(CROP_MATURE_DAYS, 4, '锚定:常量本身仍是 4(常量在 actual 侧才有牙齿)');
  eq(rt.authoritativeItemCount('p1', WHEAT), 0, '★ 种子被按件扣掉(不是白种)');
  eq(r.effect?.seedItemId, WHEAT, '回执带「种的是哪一件」');

  const day1 = sim.advanceRoomSystems(1);
  eq(day1.grown, 1, '★ 慢帧真的长了(修前温室分支连入参都不建)');
  near(sim.cropAt(2, 2)!.progress, 0.25, 1e-9, '4 天成熟 ⇒ 一天 0.25(手算)');
});

/* ═══════════ 5. 温室负对照:每一条拒绝都零副作用 ═══════════ */

test('FND119-5 ★ 播种负对照:非耕地 / 不是种子 / 背包没有 / 同格再种 / 越界 ⇒ 拒且作物与背包零变化', () => {
  /* 怎么变红:
     · 去掉耕地判定 ⇒ 第 2 条(非耕地也种上了);
     · 去掉种子判定(`sowableReasonOf`)⇒ 第 3 条(木材也能种);
     · 扣件失败不终止 ⇒ 第 4 条(背包为负 / 地里凭空多一格);
     · 世界拒绝不退回 ⇒ 第 2 条的「背包回到 1 件」会变成 0。 */
  const { rt, sim } = makeRoom('r119_5');
  sim.grid.setFloor(3, 3, STONE_PATH); /* 青苔鹅卵石径:不是耕地 */
  sim.grid.setFloor(4, 4, SOIL);
  seed(rt, 'p1', WHEAT, 1);
  seed(rt, 'p1', LOG, 1);

  const notSoil = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 3, y: 3, itemId: WHEAT });
  eq(notSoil.ok, false, '★ 非耕地不许播种');
  eq(notSoil.kind, 'INVALID', '归为 INVALID');
  ok((notSoil.reason ?? '').includes('耕地'), `理由要说清是耕地(${notSoil.reason ?? '-'})`);
  eq(sim.crops().length, 0, '零副作用:一格作物都没有');
  eq(rt.authoritativeItemCount('p1', WHEAT), 1, '★ 世界拒绝 ⇒ 种子**退回**(PLACE_REFUND)');
  const notSeed = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 4, y: 4, itemId: LOG });
  eq(notSeed.ok, false, '★ 不是种子的物品不能播种');
  ok((notSeed.reason ?? '').includes('种子'), `理由要说清不是种子(${notSeed.reason ?? '-'})`);
  eq(sim.crops().length, 0, '零副作用');
  eq(rt.authoritativeItemCount('p1', LOG), 1, '★ 那一件原样还在背包');

  const broke = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 4, y: 4, itemId: PEPPER });
  eq(broke.ok, false, '★ 背包里没有这件种子 ⇒ 拒');
  eq(sim.crops().length, 0, '零副作用:没种下');

  const ok1 = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 4, y: 4, itemId: WHEAT });
  eq(ok1.ok, true, `前置:耕地播种成功(${ok1.reason ?? '-'})`);
  eq(rt.authoritativeItemCount('p1', WHEAT), 0, '前置:种子已被扣');
  const twice = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 4, y: 4, itemId: WHEAT });
  eq(twice.ok, false, '★ 同一格不能重复播种');
  eq(sim.crops().length, 1, '★ 作物还是一格(第二次没把那格覆盖/清掉)');

  const far = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 9999, y: 4, itemId: WHEAT });
  eq(far.ok, false, '越界坐标 ⇒ 拒');
  eq(sim.crops().length, 1, '零副作用');
});

/* ═══════════ 6. 429:过滤规则进世界 ⇒ 收获按道分拣 ═══════════ */

test('FND119-6 ★ 放 429 带 lane/itemId ⇒ `sortFilters()` 非空 ⇒ 收获被分到那一道;非法道号零副作用', () => {
  /* 怎么变红:
     · 429 分支不调 `host.setSortFilters` ⇒ 第 2 条(修前 `sortFilters` 恒空);
     · 用 `setSortFilters([新的一条])` 覆盖整表 ⇒ 第 4 条(第二台 429 抹掉了第一台);
     · 不读 `sortFilters()` 而是从头构造 ⇒ 同样第 4 条;
     · 过滤规则先落表再扣件 ⇒ 第 6 条(非法道号时规则已经变了)。 */
  const { rt, sim } = makeRoom('r119_6');
  seed(rt, 'p1', SORTER, 4);
  eq(sim.blockAt(5, 5), 0, '前置:(5,5) 世界物件层是空的');
  eq(sim.blockAt(6, 5), 0, '前置:(6,5) 空');
  eq(sim.blockAt(8, 5), 0, '前置:(8,5) 空');
  eq(sim.sortFilters(), [], '前置:429 还没有任何过滤规则');

  const first = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 5, y: 5, kind: 'LOGISTICS_SORTER', lane: 2, itemId: WHEAT });
  eq(first.kind, 'OK', `★ 放 429 应成功(kind=${first.kind} reason=${first.reason ?? '-'})`);
  eq(first.effect?.sortLane, 2, '回执如实带本次写进的道号');
  eq(sim.sortFilters(), [{ lane: 2, itemIds: [WHEAT] }], '★ 生产里 `sortFilters` **不再恒空**(修前恒为 [])');
  eq(rt.authoritativeItemCount('p1', SORTER), 3, '429 的实物被扣掉 1 件');

  const second = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 6, y: 5, kind: 'LOGISTICS_SORTER', lane: 3, itemId: PEPPER });
  eq(second.ok, true, `第二台 429 应成功(${second.reason ?? '-'})`);
  eq(sim.sortFilters().map((f) => f.lane), [2, 3], '★ 合并不覆盖整表(两台 429 各管一道)');

  const noParams = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 7, y: 5, kind: 'LOGISTICS_SORTER' });
  eq(noParams.ok, true, `不带过滤参数的 429 只是放件(${noParams.reason ?? '-'})`);
  eq(sim.sortFilters().length, 2, '★ 不带参数 ⇒ 规则表一字不动');
  eq(noParams.effect?.sortLane, null, '回执如实说「这次没动规则表」');

  const bad = disp(rt, RoomAction.PLACE_AUTOMATION, { x: 8, y: 5, kind: 'LOGISTICS_SORTER', lane: -1, itemId: WHEAT });
  eq(bad.ok, false, '★ 道号 -1(= SORT_PASS_THROUGH 的语义)不是合法道号 ⇒ 拒');
  eq(sim.sortFilters().length, 2, '★ 规则表零变化');
  eq(placementAt('r119_6', 8, 5), null, '★ 登记表也零变化(没放下去)');
  eq(rt.authoritativeItemCount('p1', SORTER), 1, '★ 那一件 429 没被扣');

  /* 分拣真的生效:耕地种小麦,第 2 道就是它 */
  sim.grid.setFloor(9, 9, SOIL);
  seed(rt, 'p1', WHEAT, 1);
  eq(disp(rt, RoomAction.PLACE_AUTOMATION, { x: 9, y: 9, itemId: WHEAT }).ok, true, '前置:播种');
  const matured = sim.advanceRoomSystems(CROP_MATURE_DAYS);
  eq(matured.matured.length, 1, '★ 4 天成熟 ⇒ 收下 1 格');
  eq(matured.matured[0].lane, 2, '★ 429 的过滤规则真的生效(第 2 道)');
  eq(sim.harvestLog()[0].cropId, WHEAT, '收获的就是那格作物');
});

/* ═══════════ 7. 负对照:一个「什么都没喂」的房间 ⇒ 三个入口全空、全部空跑 ═══════════ */

test('FND119-7 ★负对照(修前形态):不做任何进料 ⇒ 三个入口全空、grown 0 / produced 0 / lane 恒 -1', () => {
  /* 怎么变红:任何一处「世界侧偷偷自造」都会被这一条抓到
     (例如把 `plantCrop`/`setSortFilters` 的默认值改成非空)。 */
  const { rt, sim } = makeRoom('r119_7');
  eq(sim.ranchPets(), [], '名单空');
  eq(sim.crops(), [], '作物空');
  eq(sim.sortFilters(), [], '过滤规则空');

  sim.grid.setFloor(2, 2, SOIL);
  sim.setCell(6, 6, { obj: TROUGH });
  sim.dropItem(1.5, 1.5, WHEAT, 3);
  eq(sim.advanceRoomSystems(1).grown, 0, '★ 没有作物 ⇒ 温室分支空跑(grown 0)');
  eq(sim.settleRanchIfDayChanged(1).produced, 0, '★ 没有圈养 ⇒ 牧场空跑(produced 0)');

  /* 同一套世界,只要经过动作喂一次,**同一调用**就给出非零 —— 两者互为反证。 */
  seed(rt, 'p1', WHEAT, 4);
  for (let i = 0; i < 3; i += 1) disp(rt, RoomAction.BREED_TAME, feed('pet:sheep2', 'mob_sheep', WHEAT));
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'TAME', petId: 'pet:sheep2' }).ok, true, '前置:驯服');
  eq(disp(rt, RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:sheep2' }).ok, true, '★ 送进牧场');
  eq(disp(rt, RoomAction.PLACE_AUTOMATION, { x: 2, y: 2, itemId: WHEAT }).ok, true, '★ 播种');

  eq(sim.crops().length, 1, '喂过之后作物非空');
  const after = sim.advanceRoomSystems(1);
  eq(after.grown, 1, '★ 同一调用从 0 变 1(证明第 7 条前半不是恒真)');
  /* 牧场那一半看**慢帧回执**(`ranchProduced`):这一拍已经把当天的幂等键占掉,
     再调一次 `settleRanchIfDayChanged` 是**重放**(被拒 ⇒ 0)—— 那测的是幂等,不是产出。 */
  eq(after.ranchProduced >= 1, true, '★ 牧场从「空跑」变成「真出账」');
  eq(sim.harvestLog().length, 0, '一天还没熟(4 天成熟)');
  forgetRoom('r119_7');
});

/* ═══════════ 8. 纯判定 + 注入:宿主没有写口 ⇒ NOT_IMPLEMENTED 且零副作用 ═══════════ */

/** 最小 `ActionContext`(只实现被测 handler 真正会碰的成员;照 `WS-FND-41` 的手法)。 */
function makeCtx(
  roomId: string,
  actorId: string,
  action: RoomAction,
  payload: Record<string, unknown>,
  bag: Map<number, number>,
): ActionContext {
  return {
    actorId,
    action,
    payload: payload as ActionPayload,
    state: createRoomState(roomId),
    host: null,
    status: RoomStatus.OPEN,
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' as const, reason: 'test-stub' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (_userId, input) => {
      for (const op of input.ops) {
        if (op.delta < 0 && (bag.get(op.itemId) ?? 0) + op.delta < 0) {
          return { allowed: false, afterTotal: bag.get(op.itemId) ?? 0, rejectCode: 'ITEM_NEGATIVE' };
        }
      }
      for (const op of input.ops) bag.set(op.itemId, (bag.get(op.itemId) ?? 0) + op.delta);
      let afterTotal = 0;
      for (const n of bag.values()) afterTotal += n;
      return { allowed: true, afterTotal };
    },
    grantItemSource: () => {},
    setMemberRole: () => ({ ok: false }),
    kick: () => ({ ok: false }),
    setAccess: () => ({ ok: false }),
    setPartyModeBy: () => ({ ok: false }),
    close: () => false,
  };
}

test('FND119-8 ★ 注入:宿主没有写口 ⇒ RANCH / 播种都是 NOT_IMPLEMENTED,宠物状态与背包零变化', () => {
  /* 怎么变红:把 `roomSystemsPortOf` 的「缺成员」分支改成「静默成功」⇒ 第 3/5 条;
     这一条同时证明**这三个口只有一条路**(没有第二份旁路偷偷写世界)。 */
  const roomId = 'r119_8';
  forgetRoom(roomId);

  /* 1 RANCH:没有写口 */
  const bag: Map<number, number> = new Map([[WHEAT, 3]]);
  for (let i = 0; i < 3; i += 1) {
    const r = breedTame(makeCtx(roomId, 'p1', RoomAction.BREED_TAME, feed('pet:s', 'mob_sheep', WHEAT), bag));
    eq(r.ok, true, `前置:第 ${i + 1} 口投喂(${r.reason ?? '-'})`);
  }
  eq(breedTame(makeCtx(roomId, 'p1', RoomAction.BREED_TAME, { op: 'TAME', petId: 'pet:s' }, bag)).ok, true, '前置:驯服');
  const noPort = breedTame(makeCtx(roomId, 'p1', RoomAction.BREED_TAME, { op: 'RANCH', petId: 'pet:s' }, bag));
  eq(noPort.ok, false, '★ 没有圈养名单写口 ⇒ 不能假装送成了');
  eq(noPort.kind, 'NOT_IMPLEMENTED', '归为链路问题(NOT_IMPLEMENTED),不是报文问题');
  eq(bag.get(WHEAT), 0, '前置:三口投喂各扣 1 件(没有被额外扣)');
  eq(petsOfRoom(roomId)[0].ownerId, 'p1', '宠物归属零变化');

  /* 2 播种:没有写口 ⇒ NOT_IMPLEMENTED,且那一件种子还在背包里 */
  const bag2: Map<number, number> = new Map([[WHEAT, 1]]);
  const plant = placeAutomationFor(makeCtx(roomId, 'p1', RoomAction.PLACE_AUTOMATION, { x: 2, y: 2, itemId: WHEAT }, bag2));
  eq(plant.ok, false, '★ 没有播种写口 ⇒ 不能假装种上了');
  eq(plant.kind, 'NOT_IMPLEMENTED', '归为链路问题');
  eq(bag2.get(WHEAT), 1, '★ 零副作用:种子一件不少');
  forgetRoom(roomId);

  /* 3 纯判定:三个入口的「拒」也要各自可判(不是只看宿主) */
  eq(addPetToRanch([], { petId: 'p', speciesId: 'mob_squirrel', affinity: 1 }).next.length, 0,
    '★ 花栗鼠进不了牧场(名单来自 ranch.ts 的登记表)');
  eq(addPetToRanch([], { petId: 'p', speciesId: 'mob_sheep', affinity: RANCH_AFFINITY_MIN - 0.01 }).ok, false,
    '★ 亲和低于 ranch.ts 的阈值 ⇒ 拒');
  eq(addPetToRanch([], { petId: 'p', speciesId: 'mob_sheep', affinity: 1 }).next.length, 1, '正例:绵羊进圈');
  eq(SOWABLE_ITEM_IDS.has(WHEAT), true, '内容表里 123 自称「耕地播种收获」⇒ 可播种');
  eq(SOWABLE_ITEM_IDS.has(LOG), false, '★ 101 暖松原木不是种子');
  ok((sowableReasonOf(LOG) ?? '').includes('种子'), '拒因要说清「不是种子」');
  eq(addSortFilter([], { lane: -1, itemIds: [WHEAT] }).ok, false, '★ -1 不是道号');
  eq(addSortFilter([], { lane: 1, itemIds: [999999] }).ok, false, '★ 内容表里没有的物品 id ⇒ 拒');
  eq(addSortFilter([], { lane: 1, itemIds: [] }).ok, false, '★ 空过滤集 ⇒ 拒');
  eq(addSortFilter([], { lane: 1, itemIds: [WHEAT] }).next, [{ lane: 1, itemIds: [WHEAT] }], '正例:第 1 道收小麦');
});

/** `place_automation` 的处理器别名(避免与 `systems/wiring.ts` 的 `plantCrop` 混淆)。 */
report('WS-FND-119');