/**
 * WS-FND-165 —— **重启语义**(B1 审计实测的四条:结算幂等跨进程 / 背包落库 /
 * 经验天赋落库 / 周期玩家快照)。
 *
 * ## 这份套件钉的是什么
 *
 * ```text
 * 1 结算幂等**跨进程**:`roomSystemsState.settled` 与 `roomDayIndex` 修前只活在
 *   WorldSim 的字段里 ⇒ 进程一停就归零 ⇒ 同一 orderId / 牧场「第 0 天」
 *   可以**再成交一次**。现在落 `room_systems_state`(repo §17)并在建房时并回。
 * 2 ★ 背包落库**核实**:A 线加的 `savePlayerLedgers` / `loadPlayerLedger`
 *   (users.inventory_json)是否真的被**周期存档**调用 —— 判据不看注释,
 *   只看「存 → 新 host → 读回逐件一致」与「起始包不重发且包不空」。
 * 3 经验 / 天赋落库:`users.exp` / `users.talent_json` 修前**生产 0 写入**
 *   ⇒ 重启后等级在、经验归零。现在周期快照写、入场读回。
 * 4 周期玩家快照(不只 join/断线):`PLAYER_SNAPSHOT_INTERVAL_MS` = 10 秒,
 *   与 30 秒的自动存档**两条独立的轨**。
 * ```
 *
 * ## 为什么每条都尽量走**生产入口**(`assemble()` / `step()` / `join()`)
 *
 * 本仓反复记的那类缺陷是「单测全绿、生产零消费」。手写 `host.saveToDb(...)`
 * 去测「落库对不对」测的不是这次修的东西 ⇒ 除非必须是故障注入
 * (生产里没有会抛的宿主 / 没有「被拿掉的能力」),其余都从真实入口出发。
 *
 * ## 负对照与注入(每条主判据都配一条)
 * ```text
 * 负对照  另一个房间 / 没有台账的库 / 不恢复的新世界 ⇒ 同一操作**成功**
 *         (证明「只有这一个 orderId / 这一天」被挡,不是整条路被焊死)
 * 注入     拿掉宿主能力 / 让导出抛错 / 往库里写坏 JSON ⇒ 房间**如实分类**
 *         (no-capability / 失败可读 / corrupt),不假装做过
 * ```
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import {
  AUTOSAVE_INTERVAL_MS,
  PLAYER_SNAPSHOT_INTERVAL_MS,
  RoomRuntime,
  type WorldSaveHost,
} from '../server/src/net/room.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  ROOM_SYSTEMS_MIGRATION_VERSION,
  ROOM_SYSTEMS_TABLE,
  createUser,
  getUser,
  loadPlayerSnapshots,
  loadRoomSystemsState,
  migrate,
  saveRoomSystemsState,
  type DbLike,
} from '../server/src/db/repo.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';

const T0 = 1_700_000_000_000;
const ROOM = 'room_restart';
const OWNER = 'u_owner';

const TMP_ROOT = ((): string => {
  const dir = join(process.cwd(), '.data', `wsfnd165-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
})();

let dbSeq = 0;
function freshDbPath(): string {
  dbSeq += 1;
  return join(TMP_ROOT, `world_${dbSeq}.db`);
}

const OPEN_ROOMS: RoomRuntime[] = [];

/** 给真文件库先建表 + 建用户(`createRoom` 要求房主在 `users` 里)。 */
function seedFileDb(path: string): void {
  const db = openNodeSqlite(path);
  try {
    db.bootstrap(T0);
    createUser(db, { id: OWNER, displayName: '房主', nowMs: T0 });
    createUser(db, { id: 'p1', displayName: '甲', nowMs: T0 });
    createUser(db, { id: 'p2', displayName: '乙', nowMs: T0 });
  } finally {
    db.close();
  }
}

/** 生产装配(与 `scripts/play.ts` 同参:世界 + 文件库 + 房间)。 */
function bootWithFile(path: string, clock = fixedClock(T0), roomId: string = ROOM) {
  seedFileDb(path);
  const a = assemble({
    roomId, ownerId: OWNER, clock: clock.clock, sizeCells: 8, dbPath: path,
  });
  ok(a.runtime.db !== null, '夹具:文件库应已开出来');
  OPEN_ROOMS.push(a.runtime);
  return { ...a, clock };
}

/** 同一个文件 = 同一个世界,但**新的房间实例**(等价于进程重启后重新装配)。 */
function rebootWithFile(path: string, roomId: string = ROOM) {
  const a = assemble({
    roomId, ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, dbPath: path,
  });
  ok(a.runtime.db !== null, '夹具:重建后库应仍可打开(同一个文件)');
  OPEN_ROOMS.push(a.runtime);
  return a;
}

/** 迁移登记行里的版本集合(「既有库不许重建」靠它证明)。 */
function migrationVersions(db: DbLike): number[] {
  return db.select('schema_migrations').map((r) => Number(r.version)).sort((a, b) => a - b);
}

/**
 * 台账读回结果里的**成因**(`ok:true` 时是 `'ok'`)。
 *
 * 为什么要这个薄函数:`RoomSystemsRead` 是**判别联合**,`reason` 只存在于失败那一支
 * —— 判据里若对它直接取字段,类型上就不成立(而用 `as` 绕过等于把判别丢掉)。
 */
function ledgerReason(r: ReturnType<typeof loadRoomSystemsState>): string {
  return r.ok ? 'ok' : r.reason;
}

/** 百货 / 炼金的成交口(`brewAtFurnace` 的材料件数要求 2..4)。 */
type BrewHost = {
  brewAtFurnace(
    a: string, ids: readonly number[], o?: { orderId?: string },
  ): { ok: boolean; reason?: string };
  galleryProjection(): { recipeHash: string }[];
};

/* ═══════════ 1 结算幂等跨进程:台账落库 ═══════════ */

test('FND165-1 结算台账落库:orderId 的键进了 room_systems_state(就地补表 + 登记 v4)', () => {
  const path = freshDbPath();
  const { runtime, host } = bootWithFile(path);
  const db = runtime.db as DbLike;

  /* 修前这一行是 `no-row`:全新库跑完 `migrate()` 之后这张表还不存在。 */
  eq(loadRoomSystemsState(db, ROOM).ok, false, '存档之前:这间房没有台账');

  const first = (host as unknown as BrewHost).brewAtFurnace('p1', [101, 106], { orderId: 'A1' });
  eq(first.ok, true, `夹具:第一炉应成交(实测 ${String(first.reason)})`);

  eq(runtime.saveWorldNow('manual'), true, '自动存档应成功');
  const rep = runtime.lastSaveReport;
  ok(rep !== null, '要有落盘报告');
  eq(rep?.systemsRow, 1, '★ 台账那一行真的写进去了(1 = 落地)');
  eq(rep?.systemsKeys, 1, '★ 真正落库的键数 1');

  const read = loadRoomSystemsState(db, ROOM);
  eq(read.ok, true, '读回台账应成功');
  ok(read.ok && read.state.keys.length === 1, '台账里恰好 1 个键');
  eq(read.ok ? read.state.keys[0]?.key : '', 'ALCHEMY_LAB@ORDER:A1', '★ 键形与内存台账逐字一致');

  /* 「兼容既有库、不许重建」:v1 基线登记行还在,新增的是 v4。 */
  const versions = migrationVersions(db);
  ok(versions.includes(1), `既有 v1 登记行必须还在(实测 ${versions.join(',')})`);
  ok(versions.includes(ROOM_SYSTEMS_MIGRATION_VERSION), `v${ROOM_SYSTEMS_MIGRATION_VERSION} 已就地登记`);
  eq(db.count(ROOM_SYSTEMS_TABLE), 1, '一间房一行(不是每次存档追加一行)');
});

test('FND165-2 ★ 跨 host:同一 orderId 重建后**只成交一次**,别的单号仍能成交(负对照)', () => {
  const path = freshDbPath();
  const first = bootWithFile(path);
  const h1 = first.host as unknown as BrewHost;
  eq(h1.brewAtFurnace('p1', [101, 106], { orderId: 'A1' }).ok, true, 'host#1 成交 A1');
  /* 陈列行(`gallery`)是**世界内的**首创账,不随本次落库恢复 ⇒ 只能在**同一个
     host 内**比「重放前后有没有多一行」(跨 host 比会把「世界换代」当成缺陷)。 */
  const galleryFirst = h1.galleryProjection().length;
  ok(galleryFirst >= 1, '夹具:成交一炉后陈列里有一行(否则下面那条比的是两个 0)');
  first.runtime.saveWorldNow('manual');
  first.runtime.close();

  /* 重建 = 第二个 host(内存台账从零起)。 */
  const second = rebootWithFile(path);
  const restore = second.runtime.lastRoomSystemsRestore;
  ok(restore !== null, '重建时应有台账恢复读数');
  eq(restore?.applied, true, '★ 冷启动真的把台账并回来了');
  eq(restore?.keys, 1, '并回来 1 个键');
  eq(restore?.added, 1, '新增 1 个键(内存里原本是空表)');

  const h2 = second.host as unknown as BrewHost;
  const galleryBefore = h2.galleryProjection().length;
  const replay = h2.brewAtFurnace('p1', [101, 106], { orderId: 'A1' });
  eq(replay.ok, false, '★ 同一 orderId 跨 host 必须被拒(修前这里会成交第二炉)');
  ok((replay.reason ?? '').length > 0, '拒绝必须有理由(不静默)');
  eq(h2.galleryProjection().length, galleryBefore, '★ 同一 host 内:重放没有多出第二行(账与产物同时不变)');

  /* 负对照:判据只挡「这一个单号」,不是把整条路焊死。 */
  eq(h2.brewAtFurnace('p1', [101, 106], { orderId: 'A2' }).ok, true,
    '另一个单号仍能成交(判据有区分力)');
  eq(loadRoomSystemsState(second.runtime.db as DbLike, ROOM).ok, true, '第二次存档后台账仍在');
});

test('FND165-3 牧场「第 N 天」跨进程:已结算的日号被挡,没台账的房间照常结算(负对照)', () => {
  const path = freshDbPath();
  /* 夹具:直接把「第 0 天已结算」写进库(等价于上一次进程结算过这一天)。 */
  seedFileDb(path);
  const seed = openNodeSqlite(path);
  try {
    saveRoomSystemsState(seed, ROOM, { dayIndex: 0, keys: [{ key: 'ECO_RANCH@DAY:0', at: 0 }] }, T0);
  } finally {
    seed.close();
  }

  const a = assemble({
    roomId: ROOM, ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, dbPath: path,
  });
  OPEN_ROOMS.push(a.runtime);
  const host = a.host as unknown as { settleRanchIfDayChanged(days: number): { days: number } };
  eq(host.settleRanchIfDayChanged(1).days, 0, '★ 已结算的「第 0 天」不许再结一次');

  /* 负对照:同一份库、**另一个房间** ⇒ 键的前缀是房间,应当照常结算。 */
  const other = assemble({
    roomId: 'room_other', ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, dbPath: path,
  });
  OPEN_ROOMS.push(other.runtime);
  const otherHost = other.host as unknown as { settleRanchIfDayChanged(days: number): { days: number } };
  eq(otherHost.settleRanchIfDayChanged(1).days, 1,
    '另一个房间的第 0 天照常结算(房间是键的一维,判据没把整条路焊死)');
});

test('FND165-4 房内日号落库并恢复:只增不减(库里的 7 不会被新世界的 0 冲掉)', () => {
  const path = freshDbPath();
  seedFileDb(path);
  const seed = openNodeSqlite(path);
  try {
    saveRoomSystemsState(seed, ROOM, { dayIndex: 7, keys: [] }, T0);
  } finally {
    seed.close();
  }

  const a = rebootWithFile(path);
  eq(a.runtime.lastRoomSystemsRestore?.dayIndex, 7, '★ 重建后房内日号是 7(修前恒为 0)');
  const db = a.runtime.db as DbLike;
  /* 再存一次:世界侧的日号(max(0,7)=7)不许把库里的 7 写回 0。 */
  a.runtime.saveWorldNow('manual');
  const after = loadRoomSystemsState(db, ROOM);
  eq(after.ok ? after.state.dayIndex : -1, 7, '★ 写回不倒退(只增不减)');

  /* 负对照:没有台账行的房间 ⇒ 日号 0,且 reason 区分得清。 */
  const blank = rebootWithFile(path, 'room_blank');
  eq(blank.runtime.lastRoomSystemsRestore?.applied, false, '没有台账时不许谎报 applied');
  eq(blank.runtime.lastRoomSystemsRestore?.reason, 'no-row', 'reason 如实说「这间房没有台账行」');
  eq(blank.runtime.lastRoomSystemsRestore?.dayIndex, 0, '负对照:日号仍是 0');
});

/* ═══════════ 2 观测面:无库 / 缺能力 / 坏数据 ═══════════ */

test('FND165-5 无库模式(负对照):如实记 no-db,不假装备份过任何东西', () => {
  const { runtime } = assemble({
    roomId: ROOM, ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, memory: true,
  });
  eq(runtime.db, null, '夹具:内存模式 db = null');
  eq(runtime.lastRoomSystemsRestore?.applied, false, '没有库 ⇒ 没有恢复');
  eq(runtime.lastRoomSystemsRestore?.reason, 'no-db', '★ 跳过原因可读(no-db)');
  eq(runtime.saveWorldNow('manual'), false, '没有库 ⇒ 存不了');
  eq(runtime.lastSaveSkipReason, 'no-db', '跳过原因与台账那一条同源');
});

test('FND165-6 注入:拿掉宿主能力 ⇒ 房间记 no-capability(不假装恢复过)', () => {
  const path = freshDbPath();
  const { runtime, host } = bootWithFile(path);
  ok(runtime.lastRoomSystemsRestore?.applied === false, '夹具:全新库还没有台账');

  /* 故障注入:生产宿主实现了它,**拿掉**之后房间必须自己说清「没有这个能力」。 */
  const mutable = host as unknown as { restoreRoomSystemsFromDb?: unknown };
  const saved = mutable.restoreRoomSystemsFromDb;
  mutable.restoreRoomSystemsFromDb = undefined;
  eq(runtime.restoreRoomSystems(), false, '没有能力 ⇒ 返回 false');
  eq(runtime.lastRoomSystemsRestore?.reason, 'no-capability', '★ 原因可读:no-capability');
  mutable.restoreRoomSystemsFromDb = saved;
  /* 复原之后同一个调用点又能工作 —— 证明上面的读数是**真实来源**,不是常量。 */
  runtime.restoreRoomSystems();
  ok(runtime.lastRoomSystemsRestore?.reason !== 'no-capability', '复原后不再报 no-capability');
});

test('FND165-7 库里是坏 JSON ⇒ 如实报 corrupt,且一位都不动(不猜成空台账)', () => {
  const path = freshDbPath();
  const first = bootWithFile(path);
  const h1 = first.host as unknown as BrewHost;
  h1.brewAtFurnace('p1', [101, 106], { orderId: 'B1' });
  first.runtime.saveWorldNow('manual');
  const db = first.runtime.db as DbLike;
  first.runtime.close();

  /* 故障注入:把行里的 JSON 弄坏(模拟旧版本 / 被截断的存档)。 */
  db.update(ROOM_SYSTEMS_TABLE, { room_id: ROOM }, { settled_json: '{ not json' });
  const second = rebootWithFile(path);
  eq(second.runtime.lastRoomSystemsRestore?.applied, false, '坏数据不许当成「恢复成功」');
  eq(second.runtime.lastRoomSystemsRestore?.reason, 'corrupt',
    '★ 如实分类 corrupt(而不是静默当成空台账 —— 那等于重开重放窗口)');
  eq(second.runtime.lastRoomSystemsRestore?.keys, 0, '坏数据没有任何一位被并进内存');
});

/* ═══════════ 3 背包落库:存 → 新 host → 读回逐件一致 ═══════════ */

test('FND165-8 背包账:存 → 新 host → 读回逐件一致;起始包不重发且包不空', () => {
  const path = freshDbPath();
  const first = bootWithFile(path);
  const out1 = first.runtime.join({ userId: 'p1', asGuest: true });
  eq(out1.ok, true, '夹具:入场成功');
  eq(first.runtime.lastStartingInventory?.verdict, 'GRANTED', '首次入场:起始包已发');
  const before = first.runtime.exportPlayerLedgers().get('p1');
  ok(before !== undefined, '★ 房间里已有 p1 的按件账(起始包真的进了权威账)');
  ok((before?.total ?? 0) > 0, '★ 包不是空的(修前「领到了但账是空的」)');
  const beforeItems = [...(before?.counts ?? new Map<number, number>()).entries()]
    .filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);

  /* 离场 ⇒ 自动存档(包与账一起落 `users.inventory_json`)。 */
  first.runtime.leave('p1');
  first.runtime.close();

  const second = rebootWithFile(path);
  const out2 = second.runtime.join({ userId: 'p1', asGuest: true });
  eq(out2.ok, true, '重建后入场成功');
  eq(second.runtime.lastStartingInventory?.verdict, 'SKIPPED',
    '★ 起始包**不重发**(库里的发放台账挡住了)');
  eq(second.runtime.lastLedgerRestore?.applied, true, '★ 背包账被读回(库里有明细)');
  const after = second.runtime.exportPlayerLedgers().get('p1');
  const afterItems = [...(after?.counts ?? new Map<number, number>()).entries()]
    .filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  eq(JSON.stringify(afterItems), JSON.stringify(beforeItems),
    '★ 逐件一致(物品 id 与件数都对得上,不是「字段在、值丢了」)');
  eq(after?.total, before?.total, '★ 总量账也一致');
  ok((after?.total ?? 0) > 0, '★ 读回来之后包**仍然不是空的**(永久空手已修)');
});

/* ═══════════ 4 经验 / 天赋落库 + 重建后还在 ═══════════ */

test('FND165-9 ★ 杀怪涨经验 → 周期快照落库 → 重建后经验还在(users.exp / talent_json)', () => {
  const path = freshDbPath();
  const { runtime, host } = bootWithFile(path);
  const db = runtime.db as DbLike;
  const sim = host as unknown as WorldSim & {
    damageMob(id: string, amount: number, kind: DamageKind, fromDeg: number): unknown;
  };
  /* 20 级:有 4 个天赋可写(天赋列不是空的),又**没到满级** ⇒ 击杀仍会涨经验
     (满级不涨经验是既有语义,拿 30 级当夹具会让这条判据测不到东西)。 */
  eq(sim.restoreFromProfile('p1', { level: 20, hp: 100, x: 3, y: 3, z: 0 }) >= 0, true, '夹具:档案落位');
  sim.addMob('mob_boar#1', 'MEADOW', 4, 4);
  sim.damageMob('mob_boar#1', 9999, DamageKind.PHYSICAL, 0);
  const expBefore = sim.progressOf('p1').exp;
  ok(expBefore > 0, `★ 击杀真的涨了经验(实测 exp=${expBefore})`);
  eq(getUser(db, 'p1')?.exp, 0, '落盘前:库里的 exp 还是建号时的 0(判据有区分力)');

  eq(runtime.savePlayerSnapshotsNow('manual'), true, '周期快照应写入');
  eq(runtime.lastPlayerSnapshotReport?.saved, 1, '写了 1 个人的快照');
  eq(getUser(db, 'p1')?.exp, expBefore, '★ users.exp 写进去了(修前生产 0 写入)');
  eq(getUser(db, 'p1')?.level, 20, '等级也一并落库');
  /* 天赋条数**不写死**:`talentFlags` 的键由成长层按等级重算(20 级今天 13 个,
     包含逐个天赋效果的位)⇒ 判据只钉「非空 + 与内存档案逐项一致」,不把内部
     命名当成契约(写死一个数会让成长层的任何扩项都变成假红)。 */
  const talentNow = Object.keys(sim.progressOf('p1').talentFlags).sort();
  const talentJson = JSON.parse(String(getUser(db, 'p1')?.talent_json ?? '[]')) as string[];
  ok(talentNow.length > 0, `夹具:20 级应有天赋位(实测 ${talentNow.length} 个)`);
  eq(talentJson.length, talentNow.length, '★ users.talent_json 写进去了(与内存档案同条数)');
  eq(JSON.stringify([...talentJson].sort()), JSON.stringify(talentNow), '★ 天赋 id 逐个一致');

  /* 重建:新世界没有任何成长档案 ⇒ 必须从库里读回来。 */
  const fresh = new WorldSim({ sizeCells: 8 });
  fresh.addPlayer('p1', 3, 3);
  eq(fresh.progressSnapshotOf('p1'), null, '负对照:没读档的新世界**没有**档案(exp 归零的那个世界)');
  const restored = fresh.restoreProgressionFromDb(db, 'p1');
  eq(restored.applied, true, '读回应成功');
  eq(restored.exp, expBefore, '★ 经验从库读回来了');
  eq(fresh.progressOf('p1').exp, expBefore, '★ 端到端:杀怪涨经验 → 落库 → 重建 → 经验还在');
  eq(fresh.progressOf('p1').level, 20, '等级也读回来了');
  eq(Object.keys(fresh.progressOf('p1').talentFlags).length, talentNow.length, '天赋位按等级重算(与落库前同条数)');
  eq(restored.talent, talentNow.length, '★ 读回时上报的天赋条数与库里一致');

  /* 负对照:没有这一行的 id ⇒ 如实 no-row,不编档案。 */
  const ghost = fresh.restoreProgressionFromDb(db, 'u_ghost');
  eq(ghost.applied, false, '库里没有这个 id ⇒ applied false');
  eq(ghost.reason, 'no-row', 'reason 如实');
});

test('FND165-10 周期快照轨:具名 10 秒间隔触发,与 30 秒的自动存档是两条独立的轨', () => {
  const path = freshDbPath();
  const { runtime, clock } = bootWithFile(path);
  runtime.join({ userId: 'p1', asGuest: true });
  eq(runtime.playerSnapshotCount, 0, '初值 0');
  eq(runtime.lastPlayerSnapshotAt, null, '初值 null');
  eq(PLAYER_SNAPSHOT_INTERVAL_MS, 10_000, '快照周期是 10 秒(具名常量,不是散落的字面量)');
  ok(PLAYER_SNAPSHOT_INTERVAL_MS < AUTOSAVE_INTERVAL_MS,
    '快照轨比世界存档轨更快(两条轨各自可调,不互相绑架)');

  /* 9 秒:两条轨都还没到点(修前「只在 join/断线时定格」在这里也能过 —— 判据要有区分力)。 */
  clock.advance(PLAYER_SNAPSHOT_INTERVAL_MS - 1_000);
  for (let i = 0; i < 3; i += 1) runtime.step();
  eq(runtime.playerSnapshotCount, 0, '未到点不写(不许退化成每帧写库)');

  clock.advance(1_000);
  runtime.step();
  eq(runtime.playerSnapshotCount, 1, `★ 到点(≥ ${PLAYER_SNAPSHOT_INTERVAL_MS}ms)必须写一次`);
  ok(runtime.lastPlayerSnapshotAt !== null, 'lastPlayerSnapshotAt 可读');
  ok((runtime.lastPlayerSnapshotReport?.saved ?? 0) >= 1, '★ 在场玩家真的写进去了');
  eq(runtime.saveCount, 0, '★ 快照轨独立:30 秒的世界存档这时**还没**触发');
});

test('FND165-11 注入:快照导出抛错 ⇒ step 不掀帧,但错因可读、计数不虚增', () => {
  const path = freshDbPath();
  const { runtime, clock } = bootWithFile(path);
  runtime.join({ userId: 'p1', asGuest: true });
  const host = runtime.worldSaveHost as WorldSaveHost;
  (host as unknown as { exportPlayerSnapshots?: unknown }).exportPlayerSnapshots = (): never => {
    throw new Error('Boom:snapshot export');
  };
  clock.advance(PLAYER_SNAPSHOT_INTERVAL_MS);
  let threw = '';
  try {
    runtime.step();
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw, '', '★ 一次快照写失败不许从 step() 抛出去');
  ok((runtime.lastPlayerSnapshotError ?? '').includes('Boom'),
    `★ 错因可读(实测 ${String(runtime.lastPlayerSnapshotError)})`);
  eq(runtime.playerSnapshotCount, 0, '★ 失败**不算**成功(计数不虚增)');
  eq(runtime.lastPlayerSnapshotAt, null, '失败不动 lastPlayerSnapshotAt');
  eq(runtime.playerSnapshotErrors.length, 1, '失败进环形日志(第二个可读点)');
});

test('FND165-12 迁移兼容:全新库**不**多建表;第一次存档就地补表(不重建)', () => {
  /* 1 全新库:`migrate()` 之后没有这张表(表数仍被既有判据锁在 9 张)。 */
  const mem = new MemoryDb();
  migrate(mem, T0);
  createUser(mem, { id: 'p1', displayName: '甲', nowMs: T0 });
  eq(mem.tableNames().length, 9, '★ `migrate()` 仍然只建 9 张表(不偷偷多建)');
  eq(loadRoomSystemsState(mem, 'room_x').ok, false, '全新库:读台账 ⇒ 没有台账');
  /* 两个后端的措辞**刻意不同**:真 SQLite 抛 `no such table`(no-table),
     内存夹具的 `get` 会顺手建一张空表(no-row)。两者都表示「没有台账」,
     所以判据按**真库**钉 no-table,按内存夹具钉 no-row —— 不把两者压成一个。 */
  eq(ledgerReason(loadRoomSystemsState(mem, 'room_x')), 'no-row', '内存夹具的成因如实标 no-row');
  const realPath = freshDbPath();
  const real = openNodeSqlite(realPath);
  try {
    migrate(real, T0);
    const r = loadRoomSystemsState(real, 'room_x');
    eq(r.ok, false, '真 SQLite:全新库读台账 ⇒ 失败');
    eq(ledgerReason(r), 'no-table', '★ 真库的成因如实标 no-table(与内存夹具分得清)');
  } finally {
    real.close();
  }

  /* 2 第一次写 ⇒ 就地补表(幂等),既有登记行不受影响。 */
  const first = saveRoomSystemsState(
    mem, 'room_x', { dayIndex: 0, keys: [{ key: 'CLOUD_DEPOT@ORDER:Z9', at: 3 }] }, T0,
  );
  eq(first.row, 1, '第一次写落地 1 行');
  ok(mem.tableNames().includes(ROOM_SYSTEMS_TABLE), '表被就地补上');
  eq(mem.tableNames().length, 10, '此后是 10 张表(预期结构,不是重建)');
  saveRoomSystemsState(mem, 'room_x', { dayIndex: 1, keys: [{ key: 'CLOUD_DEPOT@ORDER:Z9', at: 3 }] }, T0);
  eq(mem.count(ROOM_SYSTEMS_TABLE), 1, '同一间房再写是 UPDATE(不是追加第二行)');
  const again = loadRoomSystemsState(mem, 'room_x');
  eq(again.ok ? again.state.dayIndex : -1, 1, '两次写之后读到的是第二次的日号');
  eq(migrationVersions(mem).filter((v) => v === ROOM_SYSTEMS_MIGRATION_VERSION).length, 1,
    '迁移登记行只有一条(幂等,不重复登记)');

  /* 3 读回不认识的格式版本 ⇒ corrupt(不是「空台账」)。 */
  mem.update(ROOM_SYSTEMS_TABLE, { room_id: 'room_x' }, { settled_json: '{"$v":99,"keys":[]}' });
  const bad = loadRoomSystemsState(mem, 'room_x');
  eq(bad.ok, false, '不认识的格式版本 ⇒ 不算读回');
  eq(ledgerReason(bad), 'corrupt', '★ 成因是 corrupt(不猜成空台账)');

  /* 4 `loadPlayerSnapshots` 只读显式给出且真实存在的 id(没有幽灵行)。 */
  const rows = loadPlayerSnapshots(mem, ['p1', 'ghost']);
  eq(rows.length, 1, '内存库里只有 p1 建过号 ⇒ 只读回 1 行');
  eq(rows[0]?.userId, 'p1', '读回的是 p1');
});

for (const rt of OPEN_ROOMS) {
  try { (rt.db as unknown as { close?: () => void } | null)?.close?.(); } catch { /* 已关 */ }
}
try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 句柄仍在 */ }

report('WS-FND-165');