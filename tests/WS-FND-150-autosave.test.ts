/**
 * WS-FND-150 —— **自动存档**(owner 裁定 2026-11-20:像 Minecraft 一样
 * 实时/周期自动保存;**不做**手动 `SAVE` / `LOAD` 动作)。
 *
 * ## 这份套件钉的是什么
 *
 * ```
 * 1  装配默认**文件库**(play / 服务端入口),内存模式降为**显式**选项
 * 2  周期自动存档:具名间隔 `AUTOSAVE_INTERVAL_MS`,**推进虚拟时间**即触发
 * 3  事件触发:玩家离场 / 房间销毁(onDispose 同一出口) / `RESET_WORLD` 成功
 * 4  可观测:`lastSaveAt` / `saveCount` / `lastSaveError` / `saveFailCount`
 *    —— 失败**不抛**但也**不静默**
 * 5  真库往返:写 → 销毁房间 → 重建 → 读回一致
 * 6  幂等、无幽灵实体、内存模式仍可用
 * ```
 *
 * ## 为什么每条都从**生产入口**出发(`assemble()` / `createServer()` / `step()`)
 *
 * 本仓反复记的那类缺陷是「单测全绿、生产零消费」:存档能力早就有
 * (`WorldSim.saveToDb`),缺的是**有人按节奏调它**。若这里手写
 * `rt.saveWorldNow()` 来测「存档对不对」,那测的就不是这次修的东西。
 * ⇒ 除了「失败路径」必须注入一个会抛的宿主(生产里没有这种东西),
 *   其余每条都走 `step()` / `leave()` / `close()` / `dispatchAction()` 这些**真实触发点**。
 *
 * ⚠️ 库**只**用两种形态:装配层开出来的真文件库(往返用)、`MemoryDb`(行为用)。
 *   没有第三种「假装是库」的替身。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { DEFAULT_DB_PATH, assemble, createServer } from '../server/src/index.ts';
import {
  AUTOSAVE_FRAME_INTERVAL,
  AUTOSAVE_INTERVAL_MS,
  RoomRuntime,
  type WorldSaveHost,
} from '../server/src/net/room.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  createUser,
  getUser,
  loadRoomMobMem,
  migrate,
  type DbLike,
} from '../server/src/db/repo.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';

const T0 = 1_700_000_000_000;
const ROOM = 'room_autosave';
const OWNER = 'u_owner';

/*
 * 本轮测试的临时目录。**刻意放在仓内 `./.data/` 下**(而不是系统 tmp):
 * 1 断言的正是「装配层把库放到哪、父目录由谁建」—— 系统 tmp 的同名目录不能证明这条;
 * 2 跑完尽力删掉,`*.db` 已在 `.gitignore` 里,不污染版本库。
 */
const TMP_ROOT = ((): string => {
  const dir = join(process.cwd(), '.data', `wsfnd150-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
})();

/** 一个新库路径(每条用例一个文件,互不干扰 —— 它们**真的**落在磁盘上)。 */
let dbSeq = 0;
function freshDbPath(): string {
  dbSeq += 1;
  return join(TMP_ROOT, `world_${dbSeq}.db`);
}

/** 干净的内存库(用户已建;房间由 `RoomRuntime` 构造器自己建)。 */
function memoryDb(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, T0);
  createUser(db, { id: OWNER, displayName: '房主', nowMs: T0 });
  createUser(db, { id: 'p1', displayName: '甲', nowMs: T0 });
  createUser(db, { id: 'p2', displayName: '乙', nowMs: T0 });
  return db;
}

/*
 * 本套件开过的房间(只为**收尾**服务:Windows 上库文件被连接持有 ⇒ 不先关句柄
 * 就删不掉临时 `.db`,于是「跑完测试多一堆垃圾」)。判据不读这个数组。
 */
const OPEN_ROOMS: RoomRuntime[] = [];

/**
 * 给**真文件库**先建表 + 建房主(`repo.createRoom` 要求 `ownerId` 在 `users` 里)。
 *
 * ⚠️ 为什么必须**先**做这一步:`RoomRuntime` 的构造器会 `createRoom`,而
 * `createRoom` 对不存在的房主**直接抛**(`repo.ts` 的「房主不存在」)——
 * 于是 `assemble({ dbPath })` 在一个全新库上根本走不过去。这不是缺陷,是
 * 「房间必须属于一个真实用户」这条约束;夹具照做即可。
 *
 * 用的是**同一个驱动**(`openNodeSqlite`)+ `bootstrap`,与装配层 `openDbFile`
 * 走同一条建表路径 —— 不是「测试自己造一个假库」。
 */
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

/** 生产装配(与 `scripts/play.ts` 同参:世界 + 库 + 房间)。 */
function bootWithFile(path: string, clock = fixedClock(T0)) {
  seedFileDb(path);
  const a = assemble({
    roomId: ROOM, ownerId: OWNER, clock: clock.clock, sizeCells: 8, dbPath: path,
  });
  ok(a.runtime.db !== null, '夹具:文件库应已开出来');
  OPEN_ROOMS.push(a.runtime);
  return { ...a, clock };
}

/** 把一名玩家的 HP 设成 `hp`(**走生产通路** `restoreFromProfile`,不直接改内部结构)。 */
function setHp(host: WorldSaveHost, userId: string, hp: number): void {
  const applied = host.restoreFromProfile?.(userId, { level: 1, hp, x: 2, y: 2, z: 0 });
  ok(typeof applied === 'number' && applied >= 1, `夹具:restoreFromProfile(${userId}) 应生效`);
}

/** 真库里读回一行(不经过运行时,直接读存储层 —— 判据要的是**落地的字节**)。 */
function hpOf(db: DbLike, userId: string): number | undefined {
  const row = getUser(db, userId);
  return row === undefined ? undefined : (row.hp as number);
}

/* ═══════════════════════ 1 装配:默认文件库 / 显式内存模式 ═══════════════════════ */

test('FND150-1 默认库:给了 dbPath 就开**真文件库**,且当场建好表(不是「开得开、一写就炸」)', () => {
  const path = freshDbPath();
  const { runtime } = bootWithFile(path);

  ok(runtime.db !== null, 'runtime.db 应非 null');
  ok(existsSync(path), `库文件应落在磁盘上:${path}`);
  /* 「开得开但没建表」是这次装配的第二个坑:一张表都没有时,第一次
     `saveToDb` 才抛 `no such table` —— 那已经是离场/30 秒之后了。 */
  ok((runtime.db as DbLike).count('users') >= 3, '建表 + 用户行应可查(count(users) ≥ 3)');
  eq(DEFAULT_DB_PATH, '.data/world.db', '默认存档路径是 ./.data/world.db(可配,不是空)');
});

test('FND150-2 服务端入口 createServer 默认落盘;`memory: true` 是**显式**退出口', () => {
  /* 1 默认支:不传 db/dbPath ⇒ 入口补上 `DEFAULT_DB_PATH`。
     ⚠️ 先建库 + 房主(`createRoom` 要求房主存在)。这一步同时**证明**入口真的
     用了默认路径 —— 若它开到别处去,房主就不在,装配当场抛「房主不存在」。 */
  /* ⚠️ 健壮性(2026-11-20):**不依赖「文件原本不存在」** —— 上一次运行 / 别处
     残留的 `.data/world.db` 会让下面 `seedFileDb` 的 `createUser` 撞
     「用户已存在:u_owner」。`.data/` 是测试产物(`*.db` 已 gitignore),不是源码
     ⇒ 先**清态**(把残留的默认库连 `-wal`/`-shm` 一并删掉),再走原判据。 */
  const dropDefaultDb = (): void => {
    for (const p of [DEFAULT_DB_PATH, `${DEFAULT_DB_PATH}-wal`, `${DEFAULT_DB_PATH}-shm`]) {
      try { rmSync(p, { force: true }); } catch { /* 不存在 / 仍被持有 */ }
    }
  };
  dropDefaultDb();
  seedFileDb(DEFAULT_DB_PATH);
  const srv = createServer({
    roomId: 'room_entry', ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8,
  });
  const entryRt = srv.rooms.get('room_entry');
  ok(entryRt !== undefined, '房间表应含 room_entry');
  ok(entryRt?.db !== null && entryRt?.db !== undefined,
    '★ 服务端入口默认必须开库(不再恒为 null)');
  ok(existsSync(DEFAULT_DB_PATH), `默认库文件应存在:${DEFAULT_DB_PATH}`);
  ok(srv.summary.includes('已开库'), '摘要应如实报告「已开库」');

  /* 清理:**无条件**把本测试写下的默认库清掉(它从空态开始,结束时也回到空态)——
     `*.db` 已 gitignore,但「跑一次测试多一个档」不是我们想要的卫生标准。
     Windows 上文件被连接持有 ⇒ 先关句柄再删(否则 EPERM)。 */
  try { (entryRt?.db as unknown as { close?: () => void } | null)?.close?.(); } catch { /* 已关 */ }
  dropDefaultDb();
  try { rmSync(dirname(DEFAULT_DB_PATH), { recursive: false }); } catch { /* 目录非空 */ }

  /* 2 显式内存模式:同一条入口,`memory: true` ⇒ 不落盘。 */
  const mem = createServer({
    roomId: 'room_mem', ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, memory: true,
  });
  eq(mem.assembled.runtime.db, null, '★ memory: true ⇒ db 必须是 null(显式内存模式)');
  ok(mem.summary.includes('内存模式'), '摘要应报告内存模式(不落盘要能被看见)');
});

test('FND150-3 内存模式仍可用:step/leave/close 全都不炸,且**不产生**假的存档报告', () => {
  const { runtime } = assemble({
    roomId: ROOM, ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, memory: true,
  });
  eq(runtime.db, null, '内存模式:db = null');
  runtime.join({ userId: 'p1', asGuest: true });
  for (let i = 0; i < 21; i += 1) runtime.step();
  runtime.leave('p1');
  runtime.close();

  eq(runtime.saveCount, 0, '没有库 ⇒ 一次都不算「存过」');
  eq(runtime.lastSaveReport, null, '没有库 ⇒ 不产 lastSaveReport(不撒谎)');
  eq(runtime.lastSaveError, null, '「没有库可写」是跳过,**不是失败**');
  eq(runtime.lastSaveSkipReason, 'no-db', '跳过原因要可读(no-db)');
});

/* ═══════════════════════ 2 周期:具名间隔 + 虚拟时间 ═══════════════════════ */

test('FND150-4 周期触发:推进虚拟时间 ≥ AUTOSAVE_INTERVAL_MS ⇒ 下一帧就存(不靠帧号)', () => {
  const { runtime, clock } = bootWithFile(freshDbPath());
  runtime.join({ userId: 'p1', asGuest: true });
  /* 第 1 帧(tick=1,既不是帧节流点,墙钟也还没到)⇒ 不该存。 */
  runtime.step();
  eq(runtime.saveCount, 0, '首帧不存(水位 = 建房时刻)');
  eq(runtime.lastSaveAt, null, '从未存过时 lastSaveAt 必须是 null');

  /* 推进 30 秒 + 1ms(刻意**不**推到帧节流点:20 的倍数在这里是干扰项)。 */
  clock.advance(AUTOSAVE_INTERVAL_MS + 1);
  runtime.step();
  eq(runtime.saveCount, 1, `★ 墙钟到点(≥ ${AUTOSAVE_INTERVAL_MS}ms)必须存一次`);
  eq(runtime.lastSaveReason, 'interval', '触发原因应是 interval(而不是 frame)');
  eq(runtime.lastSaveAt, clock.nowMs(), 'lastSaveAt 记的是**存档时刻**的注入时钟');
  ok(runtime.lastSaveReport !== null, '这一次要有落盘报告(不是只在内存里记账)');
});

test('FND150-5 帧节流仍在(既有口径不被周期轨顶掉):第 20 帧一次', () => {
  const { runtime } = bootWithFile(freshDbPath());
  runtime.join({ userId: 'p1', asGuest: true });
  for (let i = 0; i < AUTOSAVE_FRAME_INTERVAL - 1; i += 1) runtime.step();
  eq(runtime.saveCount, 0, `前 ${AUTOSAVE_FRAME_INTERVAL - 1} 帧不存(不许退化成每帧写库)`);
  runtime.step();
  eq(runtime.saveCount, 1, `第 ${AUTOSAVE_FRAME_INTERVAL} 帧应存一次`);
  eq(runtime.lastSaveReason, 'frame', '触发原因应是 frame');
  /* 期望侧写字面量 `20`(不拿 `AUTOSAVE_FRAME_INTERVAL` 当期望值 —— 那是同义反复:
     常量改了这条断言会跟着改,什么也没钉住)。恒量本身另由下面那条 30s 断言钉。) */
  eq(runtime.lastSaveReport?.tick, 20, '报告里的 tick 与落盘帧号同版(第 20 帧,字面量)');
  eq(AUTOSAVE_INTERVAL_MS, 30_000, '周期是 30 秒(具名常量,不是散落的字面量)');
});

/* ═══════════════════════ 3 事件触发:离场 / 销毁 / 重置 ═══════════════════════ */

test('FND150-6 离场触发:先落盘再摘席位(离场者的 HP 真的进了库)', () => {
  const { runtime } = bootWithFile(freshDbPath());
  const db = runtime.db as DbLike;
  runtime.join({ userId: 'p1', asGuest: true });
  setHp(runtime.worldSaveHost as WorldSaveHost, 'p1', 42);
  eq(hpOf(db, 'p1'), 100, '离场前:库里还是建号时的 100');

  const before = runtime.saveCount;
  runtime.leave('p1');
  eq(runtime.saveCount, before + 1, '离场必须存一次');
  eq(runtime.lastSaveReason, 'leave', '触发原因应是 leave');
  eq(hpOf(db, 'p1'), 42, '★ 离场者的 HP 42 已落库(反序摘席位就会丢掉这一段)');
  eq(runtime.state.players.some((p) => p.id === 'p1'), false, '席位仍要被摘掉(存档不影响回收)');
});

test('FND150-7 销毁触发(onDispose 的同一出口 close())且只存一次', () => {
  const { runtime } = bootWithFile(freshDbPath());
  runtime.join({ userId: 'p1', asGuest: true });
  const before = runtime.saveCount;
  eq(runtime.close(), true, '第一次 close() 应生效');
  eq(runtime.saveCount, before + 1, '销毁必须存一次');
  eq(runtime.lastSaveReason, 'dispose', '触发原因应是 dispose');
  eq(runtime.close(), false, '第二次 close() 早退(房间已 CLOSED)');
  eq(runtime.saveCount, before + 1, '★ 第二次 close() 不重复存(销毁幂等)');
});

test('FND150-8 RESET_WORLD 成功后立刻存一次(不等下一个周期)', () => {
  const { runtime } = bootWithFile(freshDbPath());
  runtime.join({ userId: OWNER, asGuest: false });
  const before = runtime.saveCount;
  const out = runtime.dispatchAction(OWNER, 'RESET_WORLD', { seed: 4242, confirm: true });
  eq(out.ok, true, `RESET_WORLD 应成功(实测 ${out.kind}:${out.reason ?? ''})`);
  eq(runtime.saveCount, before + 1, '★ 重置成功 ⇒ 立刻落盘一次(新世代的世界)');
  eq(runtime.lastSaveReason, 'reset', '触发原因应是 reset');
  ok(runtime.lastSaveError === null, '为重置新增的那次存档没失败');
});

/* ═══════════════════════ 4 失败路径:不抛,但绝不静默 ═══════════════════════ */

test('FND150-9 存档失败可观测:lastSaveError / saveFailCount / saveErrors,且不掀掉 step()', () => {
  const db = memoryDb();
  /* 会抛的宿主 —— 生产里没有这种东西,只有注入才构造得出「写失败」这个状态。 */
  const boom: WorldSaveHost = {
    saveToDb: () => { throw new Error('Boom:disk full'); },
    attackMobAuthorized: () => ({ outcome: 'OUT_OF_AOI', hit: null }),
    listWildlife: () => [],
    materials: () => ({
      blockAt: () => 0,
      placeBlock: () => ({ ok: false as const, reason: 'stub' }),
      breakBlock: () => ({ ok: false as const, reason: 'stub' }),
      groundItemsNear: () => [],
      consumeGroundItem: () => 0,
      takeGroundItemNear: () => false,
      dropItem: () => undefined,
    }),
  };
  const c = fixedClock(T0);
  const rt = new RoomRuntime({ roomId: ROOM, ownerId: OWNER, clock: c.clock, host: boom }, db);
  rt.join({ userId: 'p1', asGuest: true });

  eq(rt.saveWorldNow('manual'), false, '失败时返回 false');
  ok(rt.lastSaveError !== null && rt.lastSaveError.includes('Boom'),
    `★ 错因必须可读(实测 ${String(rt.lastSaveError)})`);
  eq(rt.saveFailCount, 1, '失败计数 +1');
  eq(rt.saveCount, 0, '★ 失败**不算**成功(failed ≠ saved)');
  eq(rt.lastSaveAt, null, '失败不动 lastSaveAt(它只描述成功过的时刻)');
  eq(rt.saveErrors.length, 1, '失败进环形日志(第二个可读点)');
  eq(rt.saveErrors[0]?.reason, 'manual', '日志带触发原因');

  /* 关键:step() 里的自动存档**必须**吞掉异常,否则一次写库失败会掀掉整帧/整房。 */
  let threw = '';
  try {
    for (let i = 0; i < AUTOSAVE_FRAME_INTERVAL; i += 1) rt.step();
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw, '', '★ 自动存档失败不许从 step() 抛出去');
  ok(rt.saveFailCount >= 2, `帧节流那次也失败并记账(实测 ${rt.saveFailCount})`);
  ok(rt.saveErrors.length <= 8, '失败日志是环形的(不随房间寿命无限长)');
});

/* ═══════════════════════ 5 真库往返:写 → 销毁 → 重建 → 读回 ═══════════════════════ */

test('FND150-10 真库往返:自动存档写进文件库 ⇒ 销毁房间 ⇒ 重建 ⇒ 读回一致', () => {
  const path = freshDbPath();
  const first = bootWithFile(path);
  first.runtime.join({ userId: 'p1', asGuest: true });
  setHp(first.host, 'p1', 37);
  /* 走**自动**存档(离场),不手写 saveToDb —— 判据要的是「触发点真的写库」。 */
  first.runtime.leave('p1');
  const memBefore = loadRoomMobMem(first.runtime.db as DbLike, ROOM);
  first.runtime.close();

  /* 重建:同一个文件路径 = 同一个世界(第一间房已销毁)。 */
  const second = assemble({
    roomId: ROOM, ownerId: OWNER, clock: fixedClock(T0).clock, sizeCells: 8, dbPath: path,
  });
  ok(second.runtime.db !== null, '重建后库应仍可打开(同一个文件)');
  OPEN_ROOMS.push(second.runtime);
  const db2 = second.runtime.db as DbLike;
  eq(hpOf(db2, 'p1'), 37, '★ 重建后 users.hp 读回 37(与落盘值一致)');
  eq(JSON.stringify(loadRoomMobMem(db2, ROOM)), JSON.stringify(memBefore),
    '★ 生物 mem 也逐字一致(不是「字段在、值丢了」)');

  /* 模拟层侧读回:新世界 `loadFromDb` 必须吃到同一份存档。 */
  const sim2 = new WorldSim({ sizeCells: 8 });
  sim2.addPlayer('p1', 2, 2);
  const loaded = (sim2 as unknown as {
    loadFromDb(db: DbLike, roomId: string): { hpApplied: number };
  }).loadFromDb(db2, ROOM);
  eq(loaded.hpApplied, 1, '新世界读到 1 名玩家的 HP');
  eq(sim2.vitals.get('p1')?.hp, 37, '端到端:HP 37 走完了「写库 → 重建 → 读回」');
});

/* ═══════════════════════ 6 幂等 / 无幽灵实体 / 观测面 ═══════════════════════ */

test('FND150-11 两次保存幂等:世界没变 ⇒ 库里逐字节一样(只是计数 +1)', () => {
  const { runtime } = bootWithFile(freshDbPath());
  const db = runtime.db as DbLike;
  runtime.join({ userId: 'p1', asGuest: true });
  setHp(runtime.worldSaveHost as WorldSaveHost, 'p1', 55);

  const snap = () => JSON.stringify({
    hp: hpOf(db, 'p1'),
    mem: loadRoomMobMem(db, ROOM),
    users: db.count('users'),
    rooms: db.count('rooms'),
    players: db.count('room_players'),
  });

  eq(runtime.saveWorldNow('manual'), true, '第一次存成功');
  const snapA = snap();
  eq(runtime.saveWorldNow('manual'), true, '第二次存成功');
  eq(snap(), snapA, '★ 两次存档的库状态逐字节相同(幂等)');
  eq(runtime.saveCount, 2, '成功计数如实 +2(计数不是「数据变了」的代理)');
});

test('FND150-12 存档不含幽灵实体:已移除的生物 / 已离场的玩家都不进档', () => {
  const { runtime } = bootWithFile(freshDbPath());
  const db = runtime.db as DbLike;
  const sim = runtime.worldSaveHost as unknown as WorldSim & {
    mobHost: { removeMob(id: string): boolean };
  };
  /* 实例 id 必须是**配表里存在的** `mob_*` 定义(`addMob` 用同一个字符串查定义;
     查不到只会被记进 `unknownMobs`,宿主根本不认识它 —— 那样「移除」自然返回 false)。 */
  sim.addMob('mob_sheep', 'MEADOW', 3, 3);
  sim.addMob('mob_slime_green', 'MEADOW', 5, 5);
  eq(sim.mobHost.removeMob('mob_slime_green'), true,
    '夹具:把 mob_slime_green 真的移除(不是杀成尸体)');

  runtime.join({ userId: 'p1', asGuest: true });
  runtime.join({ userId: 'p2', asGuest: true });
  setHp(runtime.worldSaveHost as WorldSaveHost, 'p1', 60);
  setHp(runtime.worldSaveHost as WorldSaveHost, 'p2', 61);

  /* 离场一个人 ⇒ 触发存档(存的是**移除前**的世界,离场者本人的 HP 要保住)。 */
  runtime.leave('p2');
  /* 再存一次(销毁口径):此刻 p2 已不在世界里 ⇒ 这次存档**不该**含它。 */
  runtime.close();
  const rep = runtime.lastSaveReport;
  ok(rep !== null, '销毁那次要有报告');
  eq(rep?.hpSaved, 1, '★ 离场后只剩 1 名玩家被写(没有幽灵玩家行)');
  eq(hpOf(db, 'p2'), 61, '离场者本人的 HP 在**离场那次**已落地(61,不是建号时的 100)');

  const mem = loadRoomMobMem(db, ROOM);
  eq(Object.keys(mem).includes('mob_slime_green'), false, '★ 已移除的生物不在存档里(没有幽灵实体)');
  eq(Object.keys(mem).includes('mob_sheep'), true, '活着的生物仍在存档里(判据有区分力)');
  const live = new Set(sim.listWildlife().map((w) => w.id));
  eq(Object.keys(mem).filter((id) => !live.has(id)).length, 0,
    '存档里的生物 id 全部来自**存活清单**');
});

test('FND150-13 观测面齐全:saveCount / lastSaveAt / lastSaveError / lastSaveReason 都可读', () => {
  const { runtime, clock } = bootWithFile(freshDbPath());
  eq(runtime.saveCount, 0, '初值 0');
  eq(runtime.lastSaveAt, null, '初值 null');
  eq(runtime.lastSaveError, null, '初值 null');
  eq(runtime.lastSaveReason, null, '初值 null');
  eq(runtime.saveErrors.length, 0, '失败日志初值空');

  runtime.join({ userId: 'p1', asGuest: true });
  clock.advance(AUTOSAVE_INTERVAL_MS);
  runtime.step();
  ok(runtime.saveCount >= 1, '推进虚拟时间后应已存过');
  ok(typeof runtime.lastSaveAt === 'number', 'lastSaveAt 是数字(可被日志/面板读)');
  ok(runtime.lastSaveReason !== null, 'lastSaveReason 可读');
});

/* 清理是**尽力而为**:先把句柄关掉(Windows 上不关就删不动),再删临时目录。
   断言已经跑完 —— 清理失败不该把一条成功的判据变成红的。 */
for (const rt of OPEN_ROOMS) {
  try { (rt.db as unknown as { close?: () => void } | null)?.close?.(); } catch { /* 已关 */ }
}
try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 句柄仍在 */ }

report('WS-FND-150');