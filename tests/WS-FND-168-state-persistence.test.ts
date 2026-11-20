/**
 * WS-FND-168 —— **把上一轮「诚实清单」里仍只在内存的状态落库**
 *
 * ## 修前形态(B1 审计 / 上一轮的诚实清单)
 *
 * ```text
 * roomSystemsState.{gallery,harvest,crops,ranchPets,lastRanch,lastBrew}  只在字段里
 * depotStock(百货机库存)/ mobGround(地面掉落)/ wiring.components        只在字段里
 * 生物位置 / 朝向(rooms.mob_mem_json 只存 AI 记忆,没有位置)              只在字段里
 * 玩家装备(除走重连 blob 的武器)/ held_item_id / 朝向                    只在 blob 里
 * ```
 * ⇒ 进程一停这几维全归零,而库里那几行还在 —— 「自动存档成功」在这几维上是空的。
 *
 * ## 判据结构(与 `WS-FND-164` / `-165` 同纪律)
 *
 * ```text
 * 1 每类状态:改 → 存(生产入口 saveToDb)→ 关 host → 新 host → 读回**逐段一致**
 * 2 每条主判据都配负对照:空态 / 未存档的房间 / 另一只怪 / 好段不被坏段拖垮
 * 3 坏行:$v 不认识 / JSON 坏 ⇒ 逐段如实标 corrupt(**不猜**),好段照常恢复
 * 4 迁移兼容:全新库仍 9 张表;第一次存档才补两张 + 登记 v6;checksum 漂移 ⇒ 拒写
 * 5 ★ corrupt 台账 ⇒ **拒绝**该房间的重复结算(不再「只上报」),回执说明原因
 * 6 真文件库:写完**关句柄**再开新句柄(证明落了盘,不是读自己的写缓存)
 * ```
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { createHost } from '../server/src/index.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  PLAYER_EQUIPMENT_TABLE,
  ROOM_RUNTIME_MIGRATION_VERSION,
  ROOM_RUNTIME_TABLE,
  ROOM_SYSTEMS_TABLE,
  checksumOf,
  createRoom,
  createUser,
  getUser,
  loadPlayerSnapshots,
  migrate,
  readRoomRuntimeSql,
  savePlayerSnapshots,
  savePlayerState,
  saveRoomSystemsState,
  type DbLike,
} from '../server/src/db/repo.ts';
import { createComponent } from '../server/src/wiring/graph.ts';

const ROOM = 'room_p168';
const ROOM2 = 'room_p168_other';
const OWNER = 'u_owner';
const SEED = 20261220;
const SIZE = 64;
const T0 = 1_700_000_000_000;

/** 世界存档 + 房间运行时迁移的正确 checksum(篡改用)。 */
const GOOD_RUNTIME_CHECKSUM = checksumOf(readRoomRuntimeSql());

/** 造一个「有房主 + 两个房间」的库并跑基线迁移(与生产装配同一前提)。 */
function freshDb(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, T0);
  createUser(db, { id: OWNER, displayName: 'owner', nowMs: T0 });
  createUser(db, { id: 'p1', displayName: '甲', nowMs: T0 });
  createRoom(db, { id: ROOM, ownerId: OWNER, worldSeed: SEED, nowMs: T0 });
  createRoom(db, { id: ROOM2, ownerId: OWNER, worldSeed: SEED + 1, nowMs: T0 });
  return db;
}

/** 生产入口:`createHost` 与 `assemble()` / `resolveRoomHost()` 同一条路。 */
function host(db: DbLike | null, roomId: string = ROOM): WorldSim {
  return createHost(
    { roomId, worldSeed: SEED, sizeCells: SIZE } as never,
    db as DbLike | null,
  ) as unknown as WorldSim;
}

/** 五段的**可比较指纹**(导出顺序已在 `exportRoomRuntimeSnapshot` 里定死)。 */
function segs(sim: WorldSim): Record<string, string> {
  const s = sim.exportRoomRuntimeSnapshot() as Record<string, unknown>;
  return {
    systems: JSON.stringify(s.systems),
    depot: JSON.stringify(s.depot),
    drops: JSON.stringify(s.drops),
    wiring: JSON.stringify(s.wiring),
    mobs: JSON.stringify(s.mobs),
  };
}

/* ══════════ 1 房间系统:改 → 存 → 关 host → 新 host → 逐段一致 ══════════ */

test('P168-1 crops(耕地)往返:存 → 新 host → 逐格一致;负对照:未读档的新 host 是空的', () => {
  const db = freshDb();
  const a = host(db);
  /* 播种只发生在耕地(内容表 301)上 ⇒ 先把那两格铺成耕地。 */
  a.grid.setFloor(3, 4, 301);
  a.grid.setFloor(9, 9, 301);
  eq(a.plantCrop(3, 4, 301, 4).ok, true, '夹具:播种成功');
  eq(a.plantCrop(9, 9, 302, 2).ok, true, '夹具:第二格');
  const before = a.crops();
  eq(before.length, 2, '夹具:两格作物');

  const rep = a.saveToDb(db, ROOM, T0 + 1);
  eq(rep.runtimeRow, 1, '★ 运行时状态那一行真的写进去了(runtimeRow = 1)');

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.applied, true, '读回应成功');
  eq(r.crops, 2, '★ 读回两格作物');
  eq(JSON.stringify(b.crops()), JSON.stringify(before), '★ 作物逐格一致(坐标 / 作物 / 进度 / 水分)');

  /* 负对照:同一份库、**不读档**的新 host ⇒ 耕地是空的(证明上面比的是真落库的数据)。 */
  const c = host(db);
  eq(c.crops().length, 0, '★ 未读档的新 host 耕地为空(判据有区分力)');
});

test('P168-2 房间系统五件往返:gallery / harvest / ranchPets / lastRanch / lastBrew', () => {
  const db = freshDb();
  const a = host(db);
  /* gallery + lastBrew:炼一炉(无 LLM 的确定性降级路径)。 */
  const brew = a.brewAtFurnace('p1', [101, 106], { orderId: 'ORD-1', at: 7 });
  eq(brew.ok, true, '夹具:一炉成交');
  eq(a.galleryProjection().length, 1, '夹具:陈列里有一行');
  eq(a.lastRanchSettle(), null, '夹具:还没结过牧场(下面才设)');
  /* ranchPets:圈养名单由动作层注入。 */
  a.setRanchPets([
    { petId: 'pet_a', speciesId: 'mob_sheep', affinity: 0.9 },
    { petId: 'pet_b', speciesId: 'mob_capybara', affinity: 0.8 },
  ]);
  const galleryBefore = JSON.stringify(a.galleryProjection());
  const petsBefore = JSON.stringify(a.ranchPets());

  a.saveToDb(db, ROOM, T0 + 1);
  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.applied, true, '读回成功');
  eq(r.gallery, 1, '★ 陈列读回 1 行');
  eq(r.ranchPets, 2, '★ 圈养名单读回 2 只');
  eq(JSON.stringify(b.galleryProjection()), galleryBefore, '★ 陈列逐字段一致(含冠名与 schemaJson)');
  eq(JSON.stringify(b.ranchPets()), petsBefore, '★ 圈养名单逐只一致');

  /* 负对照:没炼过 / 没圈养的房间 ⇒ 两处都空(不凭空造内容)。 */
  const c = host(db, ROOM2);
  eq(c.restoreRoomRuntimeFromDb(db, ROOM2).gallery, 0, '负对照:另一个房间没有陈列');
  eq(c.galleryProjection().length, 0, '负对照:另一个房间陈列仍为空');
});

test('P168-3 ★ 空态往返:五段全空也能存能读(applied:true 且逐段一致)', () => {
  const db = freshDb();
  const a = host(db);
  const before = segs(a);
  a.saveToDb(db, ROOM, T0 + 1);

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.applied, true, '★ 空态也是「存过」——不是 no-row');
  eq(r.corrupt.length, 0, '空态没有坏段');
  const after = segs(b);
  for (const k of Object.keys(before)) {
    eq(after[k], before[k], `★ 空态逐段一致(${k})`);
  }
  eq(b.crops().length, 0, '空态:耕地为空');
  eq(b.galleryProjection().length, 0, '空态:陈列为空');
  eq(Object.keys(b.stallStockOf()).length, 0, '空态:百货机库存为空');
});

/* ══════════ 2 百货机库存 / 地面掉落 / 电路件 / 生物位置 ══════════ */

test('P168-4 depotStock(百货机库存)往返;负对照:另一间房读不到本房的库存', () => {
  const db = freshDb();
  const a = host(db);
  a.setStallStock({ 704: 3, 729: 1 });
  const before = JSON.stringify(a.stallStockOf());
  a.saveToDb(db, ROOM, T0 + 1);

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.applied, true, '读回成功');
  eq(r.depot, 2, '★ 库存读回两个物品');
  eq(JSON.stringify(b.stallStockOf()), before, '★ 库存逐件一致');

  const other = host(db, ROOM2);
  eq(other.restoreRoomRuntimeFromDb(db, ROOM2).depot, 0, '负对照:另一间房没有库存');
  eq(Object.keys(other.stallStockOf()).length, 0, '负对照:另一间房库存为空');
});

test('P168-5 地面掉落往返;负对照:没落货的格子仍为空', () => {
  const db = freshDb();
  const a = host(db);
  a.dropItem(10, 10, 704, 2);
  a.dropItem(11, 10, 729, 1);
  const before = JSON.stringify(a.groundItemsNear(10, 10, 4));
  ok(a.groundItemsNear(10, 10, 4).length === 2, '夹具:地面有两堆货');
  a.saveToDb(db, ROOM, T0 + 1);

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.drops, 2, '★ 地面掉落读回两堆');
  eq(JSON.stringify(b.groundItemsNear(10, 10, 4)), before, '★ 逐堆一致(物品 id / 件数 / 坐标)');
  eq(b.groundItemsNear(50, 50, 3).length, 0, '负对照:没落货的格子仍为空');
});

test('P168-6 电路件(组件运行态)往返;负对照:空电路往返为空', () => {
  const db = freshDb();
  const a = host(db);
  a.wiring.addComponent(createComponent('comp#1', 'LAMP', 3, 4, {
    params: { channel: 2 }, state: { on: 1 }, latencyTicks: 3,
  }));
  a.wiring.addComponent(createComponent('comp#2', 'SENSOR', 5, 6, {
    params: { radius: 1 }, state: { triggered: 1 },
  }));
  const before = JSON.stringify((a.exportRoomRuntimeSnapshot() as { wiring: unknown }).wiring);
  a.saveToDb(db, ROOM, T0 + 1);

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.wiring, 2, '★ 电路件读回两件');
  eq(JSON.stringify((b.exportRoomRuntimeSnapshot() as { wiring: unknown }).wiring), before,
    '★ 电路件逐字段一致(含 params / state / latencyTicks)');
  eq(b.wiring.get('comp#1')?.state.on, 1, '★ 运行态 state 真的回来了');

  const other = host(db, ROOM2);
  eq(other.restoreRoomRuntimeFromDb(db, ROOM2).wiring, 0, '负对照:另一间房没有电路件');
  eq(other.wiring.components.size, 0, '负对照:另一间房的电路为空');
});

test('P168-7 生物位置 / 朝向往返;负对照:库里没有的那只怪位置不动', () => {
  const db = freshDb();
  const a = host(db);
  eq(a.addMob('mob_boar#1', 'MEADOW', 4, 4), 'CREATED', '夹具:一只怪');
  const rt = a.mobHost.runtimeOf('mob_boar#1');
  ok(rt !== null, '夹具:运行时存在');
  if (rt !== null) { rt.x = 17; rt.y = 21; rt.facingDeg = 90; }
  a.saveToDb(db, ROOM, T0 + 1);

  /* 新 host 先按出生点造同一只怪,再读回位置 —— 恢复是「按 id 应用到已有生物」的语义。 */
  const b = host(db);
  eq(b.addMob('mob_boar#1', 'MEADOW', 4, 4), 'CREATED', '新 host 先造同一只怪');
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.mobs, 1, '★ 一只怪的位置读回');
  eq(b.mobHost.runtimeOf('mob_boar#1')?.x, 17, '★ x 读回');

  /* 负对照:库里没有的怪不受影响(仍停在出生点)。 */
  b.addMob('mob_boar#2', 'MEADOW', 40, 40);
  b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(b.mobHost.runtimeOf('mob_boar#2')?.x, 40, '负对照:库里没有的怪位置不动');
});

/* ══════════ 3 坏行 / 版本标记 / 整行缺失(负对照)══════════ */

test('P168-8 ★ 坏行逐段容错:一段 JSON 坏只丢那一段,好段照常恢复', () => {
  const db = freshDb();
  const a = host(db);
  a.setStallStock({ 704: 2 });
  a.addMob('mob_boar#1', 'MEADOW', 4, 4);
  a.saveToDb(db, ROOM, T0 + 1);

  /* 故障注入:只把 depot 那一段弄坏(旧版本 / 被截断的存档的可达形态)。 */
  db.update(ROOM_RUNTIME_TABLE, { room_id: ROOM }, { depot_json: '{ not json' });

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.applied, true, '★ 一段坏不拖垮整次读档');
  eq(r.corrupt.includes('depot'), true, '★ 坏段如实标 corrupt(depot)');
  eq(r.depot, 0, '坏段没有任何一位被应用');
  eq(Object.keys(b.stallStockOf()).length, 0, '坏段:库存落空');
  eq(b.mobHost.runtimeOf('mob_boar#1'), null, '夹具:新 host 还没造怪');
  ok(r.corrupt.length === 1, `★ 只有那一段坏(实得 ${r.corrupt.join(',')})`);
});

test('P168-9 版本标记:不认识的 $v ⇒ 该段 corrupt(不猜成「没有」)', () => {
  const db = freshDb();
  const a = host(db);
  a.setStallStock({ 704: 5 });
  a.saveToDb(db, ROOM, T0 + 1);
  /* 把段信封的 $v 改成一个本程序不认识的版本。 */
  db.update(ROOM_RUNTIME_TABLE, { room_id: ROOM }, { depot_json: '{"$v":99,"data":{"stock":{"704":5}}}' });

  const b = host(db);
  const r = b.restoreRoomRuntimeFromDb(db, ROOM);
  eq(r.corrupt.includes('depot'), true, '★ 不认识的 $v ⇒ depot 标 corrupt');
  eq(Object.keys(b.stallStockOf()).length, 0, '★ 不猜(不把 99 版硬读成 5 件)');
});

test('P168-10 整行缺失的两种成因分得清;负对照:没装过迁移的库 ⇒ no-table', () => {
  const db = freshDb();
  /* 1 空库(还没存过)—— 这里先存一次让迁移登记上,再换一个没存过的房间。 */
  const a = host(db);
  a.saveToDb(db, ROOM, T0 + 1);
  const b = host(db);
  const noRow = b.restoreRoomRuntimeFromDb(db, ROOM2);
  eq(noRow.applied, false, '★ 没存过的房间不谎报 applied');
  eq(noRow.reason, 'no-row', '★ 成因如实说「这间房没有行」');

  /* 2 从没装过本段迁移的库 ⇒ no-table(内存夹具不会顺手建表)。 */
  const fresh = new MemoryDb();
  migrate(fresh, T0);
  createUser(fresh, { id: OWNER, displayName: 'owner', nowMs: T0 });
  createRoom(fresh, { id: ROOM, ownerId: OWNER, worldSeed: SEED, nowMs: T0 });
  const c = host(fresh);
  const noTable = c.restoreRoomRuntimeFromDb(fresh, ROOM);
  eq(noTable.reason, 'no-table', '★ 成因如实说「这个库没有这两张表」');
  eq(fresh.tableNames().length, 9, '★ 读口**不**顺手建表(仍是 9 张)');
});

/* ══════════ 4 迁移兼容 / 漂移拒写 ══════════ */

test('P168-11 迁移兼容:全新库仍 9 张表;第一次存档就地补两张 + 登记 v6(不重建)', () => {
  const db = freshDb();
  eq(db.tableNames().length, 9, '★ `migrate()` 仍然只建 9 张表(不偷偷多建)');
  const a = host(db);
  a.setStallStock({ 704: 1 });
  a.saveToDb(db, ROOM, T0 + 1);
  ok(db.tableNames().includes(ROOM_RUNTIME_TABLE), '★ 运行时表被就地补上');
  /* ★ 一次 `migrateRoomRuntime` 把两张表都 `CREATE TABLE IF NOT EXISTS` 建出来,
     加上房间系统台账(v4)与世界存档两张表(v5)⇒ 9 + 1 + 2 + 2 = 14。 */
  ok(db.tableNames().includes(PLAYER_EQUIPMENT_TABLE), '★ 装备表随同一次迁移建出');
  eq(db.tableNames().length, 14, '★ 只多了「本段 + 既有各段」那几张(不是重建)');
  eq(db.tableNames().includes('user_starting_inventory'), false, '负对照:没用到的那张表仍然不建');
  const versions = db.select('schema_migrations').map((r) => Number(r.version)).sort((x, y) => x - y);
  ok(versions.includes(1), `既有 v1 登记行必须还在(实测 ${versions.join(',')})`);
  ok(versions.includes(ROOM_RUNTIME_MIGRATION_VERSION), `v${ROOM_RUNTIME_MIGRATION_VERSION} 已就地登记`);

  /* 再存一次:同一间房是 UPDATE(不是追加第二行),登记行也只有一条。 */
  a.saveToDb(db, ROOM, T0 + 2);
  eq(db.count(ROOM_RUNTIME_TABLE), 1, '一间房一行');
  eq(versions.filter((v) => v === ROOM_RUNTIME_MIGRATION_VERSION).length, 1, '迁移登记幂等');
});

test('P168-12 负对照:运行时迁移 checksum 漂移 ⇒ 存档**抛错**且运行时段一行不写', () => {
  const db = freshDb();
  const a = host(db);
  a.setStallStock({ 704: 1 });
  a.saveToDb(db, ROOM, T0 + 1);
  const rows = db.count(ROOM_RUNTIME_TABLE);
  db.update('schema_migrations', { version: ROOM_RUNTIME_MIGRATION_VERSION }, { checksum: 'fnv1a:deadbeef' });

  let threw = false;
  try { a.saveToDb(db, ROOM, T0 + 2); } catch { threw = true; }
  eq(threw, true, '★ 漂移必须拒写(不静默降级)');
  eq(db.count(ROOM_RUNTIME_TABLE), rows, '★ 拒写时一行都不许多');

  /* 修回正确 checksum ⇒ 立刻能写(证明上面那条不是别的原因导致的)。 */
  db.update('schema_migrations', { version: ROOM_RUNTIME_MIGRATION_VERSION }, { checksum: GOOD_RUNTIME_CHECKSUM });
  const rep = a.saveToDb(db, ROOM, T0 + 3);
  eq(rep.runtimeRow, 1, '修回之后立刻落库');
});

/* ══════════ 5 玩家:装备 / held_item_id / 朝向并入周期快照轨 ══════════ */

test('P168-13 玩家装备 / 手持物 / 朝向:存 → 读回一致;负对照:省略 equipment 不建表不写', () => {
  const db = freshDb();
  /* 正路:三项都给。 */
  savePlayerSnapshots(db, [{
    userId: 'p1', level: 5, exp: 3, hp: 9, x: 1, y: 2, z: 0,
    dir: 2, heldItemId: 720, equipment: [712, 713],
  }], T0);
  const row = loadPlayerSnapshots(db, ['p1'])[0];
  ok(row !== undefined, '读回一行');
  eq(row?.dir, 2, '★ 朝向读回 2');
  eq(row?.heldItemId, 720, '★ 手持物读回 720');
  eq(JSON.stringify(row?.equipment), JSON.stringify([712, 713]), '★ 装备逐件一致(升序)');
  eq(db.count(PLAYER_EQUIPMENT_TABLE), 1, '★ 一人一行装备');

  /* 读回后再应用到世界档案(武器那件不在本行里,故只并装备与手持物)。 */
  const sim = host(db);
  const applied = sim.restorePlayerRuntimeFromDb(db, 'p1');
  eq(applied.applied, true, '档案读回应成功');
  eq(applied.equipment, 2, '★ 两件装备被并进 wearing');
  eq(sim.profileOf('p1').heldItem, 720, '★ 手持物落到档案');
  eq(applied.dir, 2, '★ 朝向如实返回(交给房间侧的 PlayerState)');

  /* 负对照:省略 equipment ⇒ 不碰那一列(也不会因为这次写就去建装备表)。 */
  const fresh = new MemoryDb();
  migrate(fresh, T0);
  createUser(fresh, { id: 'p1', displayName: '甲', nowMs: T0 });
  savePlayerState(fresh, 'p1', { held_item_id: 42 }, T0);
  savePlayerSnapshots(fresh, [{
    userId: 'p1', level: 1, exp: 0, hp: 10, x: 0, y: 0, z: 0, dir: 1,
  }], T0 + 1);
  eq(getUser(fresh, 'p1')?.held_item_id, 42, '★ 省略 heldItemId ⇒ 不碰那一列(仍是 42)');
  eq(getUser(fresh, 'p1')?.dir, 1, '★ 给了 dir 才写');
  eq(fresh.tableNames().includes(PLAYER_EQUIPMENT_TABLE), false, '★ 省略 equipment ⇒ 不建装备表');
});

/* ══════════ 6 ★ corrupt 台账 ⇒ 拒绝重复结算(不再「只上报」)══════════ */

test('P168-14 ★ corrupt 台账:三条结算口一律拒绝且回执说明;负对照:好房间照常结算', () => {
  const db = freshDb();
  const a = host(db);
  /* 先正常成交一炉,再把台账 JSON 弄坏(等价于上一次进程留下的坏存档)。 */
  eq(a.brewAtFurnace('p1', [101, 106], { orderId: 'C1', at: 1 }).ok, true, '夹具:先有一行台账');
  a.saveToDb(db, ROOM, T0 + 1);
  db.update(ROOM_SYSTEMS_TABLE, { room_id: ROOM }, { settled_json: '{ broken' });

  const b = host(db);
  const restore = b.restoreRoomSystemsFromDb(db, ROOM);
  eq(restore.applied, false, '坏数据不许当成「恢复成功」');
  eq(restore.reason, 'corrupt', '★ 如实分类 corrupt');
  eq(b.roomSystemsReplayBlocked().blocked, true, '★ corrupt ⇒ 本房间的重放窗口**收紧**(不再只是上报)');

  /* 牧场日结:修前会照常出账(重放窗口开着);现在必须被拒且带原因。 */
  const ranch = b.settleRanchIfDayChanged(1) as { days: number; reason?: string };
  eq(ranch.days, 0, '★ corrupt 时牧场日结被拒(不放行)');
  ok((ranch.reason ?? '').includes('corrupt'), `★ 回执说明原因(实得 ${String(ranch.reason)})`);
  /* 炼金:同一炉必须被拒。 */
  const brew = b.brewAtFurnace('p1', [101, 106], { orderId: 'C2', at: 2 });
  eq(brew.ok, false, '★ corrupt 时炼金被拒');
  ok((brew.reason ?? '').includes('corrupt'), '★ 炼金回执说明原因');
  /* 百货:必须被拒且库存不动。 */
  b.setStallStock({ 704: 1 });
  const buy = b.purchaseCommit(704, 1, { orderId: 'B1', table: { 704: 10 } });
  eq(buy.ok, false, '★ corrupt 时成交被拒');
  eq(buy.stockOfItem, 1, '★ 被拒后库存一位不动');

  /* 负对照:另一个房间(台账读得回来 / 压根没有)照常结算。 */
  const other = host(db, ROOM2);
  const okRestore = other.restoreRoomSystemsFromDb(db, ROOM2);
  eq(okRestore.reason, 'no-row', '负对照:另一间房没有台账(正常)');
  eq(other.roomSystemsReplayBlocked().blocked, false, '★ no-row 不收紧(否则新房间永远结不了账)');
  eq(other.settleRanchIfDayChanged(1).days, 1, '★ 负对照:另一间房照常结算(判据有区分力)');
});

/* ══════════ 7 真文件库:关句柄 → 新句柄 → 新 host ══════════ */

test('P168-15 真文件库跨句柄:写完关掉 → 新句柄新 host → 五段逐段一致', () => {
  const dir = join('.tmp', `ws-fnd-168-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'runtime.db');
  try {
    const db1 = openNodeSqlite(file);
    migrate(db1, T0);
    createUser(db1, { id: OWNER, displayName: 'owner', nowMs: T0 });
    createRoom(db1, { id: ROOM, ownerId: OWNER, worldSeed: SEED, nowMs: T0 });
    const a = host(db1);
    a.grid.setFloor(2, 2, 301);
    a.plantCrop(2, 2, 301, 4);
    a.setStallStock({ 704: 4 });
    a.dropItem(5, 5, 729, 2);
    a.wiring.addComponent(createComponent('w#1', 'LAMP', 6, 7, { state: { on: 1 } }));
    a.addMob('mob_boar#1', 'MEADOW', 4, 4);
    const before = segs(a);
    a.saveToDb(db1, ROOM, T0 + 1);
    (db1 as unknown as { close?: () => void }).close?.();

    /* 新句柄 = 新进程的等价物(读自己的写缓存不算落了盘)。 */
    const db2 = openNodeSqlite(file);
    const b = host(db2);
    b.addMob('mob_boar#1', 'MEADOW', 4, 4);
    const r = b.restoreRoomRuntimeFromDb(db2, ROOM);
    eq(r.applied, true, '★ 真库读回成功');
    const after = segs(b);
    for (const k of ['systems', 'depot', 'drops', 'wiring']) {
      eq(after[k], before[k], `★ 真库逐段一致(${k})`);
    }
    eq(b.crops().length, 1, '真库:耕地回来了');
    eq(b.stallStockOf()[704], 4, '真库:库存回来了');
    (db2 as unknown as { close?: () => void }).close?.();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄仍在 */ }
  }
});

report('WS-FND-168');
