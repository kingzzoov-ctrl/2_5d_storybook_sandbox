/**
 * WS-FND-163 —— 四条**无需 owner 输入**的边界收口(按优先级):
 *
 * ```text
 * A4 玩家背包明细落库(最优先):自动存档此前只保证「起始包不重发」
 *    (那是发放台账),**背包明细本身没有任何落库路径** ⇒ 进程一停背包回到空。
 * A1 `trimEvents` 接成周期任务:它早已导出且幂等,但触发点只有「写入路径」与
 *    「VACUUM / 外部维护」⇒ **只读房永不 trim**。
 * A2 colyseus patch 定时器过席位判据:`USE_COLYSEUS_PATCH=true` 时
 *    `Room.broadcastPatch()` 把整份 `this.clients` 交给序列化器,**绕过广播门**
 *    ⇒ 被踢者继续收 patch。
 * A3 AOI 级裁剪:`snapshotFor` 此前是**席位级**(成员拿整房)⇒ 远处玩家的变化
 *    每一帧都进我的包。
 * ```
 *
 * ## 判据设计纪律(与 `WS-FND-150` / `-162` 同款)
 * ```text
 * 1 从**生产入口**出发:`assemble()` / `step()` / `leave()` / `broadcastPatch()` /
 *   `snapshotFor()` —— 不手写被测动作(手写就等于测「我以为它做了什么」);
 * 2 每条都配**负对照**:合法输入下同一个量必须**不动**;
 * 3 「注入」= 让被测路径真的走另一条分支(拿掉 `saveToDb` 的第 4 参 /
 *   `isSeated` 恒真 / 删掉自己那一行 state / `count` 抛错),再断言判据**变红**;
 * 4 真库往返用**两个连接**:写完之后**新建**一个 `openNodeSqlite` 句柄读回 ——
 *   同一个句柄读到自己的写缓存不算「落了盘」。
 * ```
 *
 * ## 库只用两种形态(没有第三种「假装是库」的替身)
 * ```text
 * 真文件库  装配层自己开的那条(`assemble({ dbPath })`),往返与读回用
 * MemoryDb  行为用(不与挂钟/文件系统纠缠)
 * ```
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import {
  AUTOSAVE_INTERVAL_MS,
  EVENT_TRIM_INTERVAL_MS,
  IDLE_SLEEP_MS,
  RoomAction,
  RoomRuntime,
  type WorldSaveHost,
} from '../server/src/net/room.ts';
import { NetPersistRoom } from '../server/src/net/room.colyseus.ts';
import {
  ROOM_EVENT_RETAIN_LOW_WATER,
  ROOM_EVENT_RETAIN_MAX,
  RoomStatus,
  createUser,
  loadPlayerLedger,
  migrate,
  writeEvent,
  type DbLike,
} from '../server/src/db/repo.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';
import { createWildlifeState, upsertWildlife } from '../server/src/net/schema.ts';
import { decodePacket, encodeFull } from '../shared/net/delta.ts';
import { AOI_WAKE_DISTANCE } from '../server/src/mobs/aoi.ts';

const T0 = 1_700_000_000_000;
const ROOM = 'room_fnd163';
const OWNER = 'u_owner';

/* 临时目录**刻意放在仓内 `.data/` 下**(与 WS-FND-150 同一取舍):断言的正是
   「装配层把库放到哪、谁来建表」。跑完尽力删掉(`*.db` 已 gitignore)。 */
const TMP_ROOT = ((): string => {
  const dir = join(process.cwd(), '.data', `wsfnd163-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
})();

let dbSeq = 0;
function freshDbPath(): string {
  dbSeq += 1;
  return join(TMP_ROOT, `w163_${dbSeq}.db`);
}

/** 本套件开过的房间(只为收尾:Windows 上库文件被连接持有 ⇒ 不关句柄就删不动)。 */
const OPEN_ROOMS: RoomRuntime[] = [];

/** 给真文件库建表 + 建号(`createRoom` 要求房主存在;p1/p2 要过台账的外键)。 */
function seedFileDb(path: string, ids: readonly string[]): void {
  const db = openNodeSqlite(path);
  try {
    db.bootstrap(T0);
    createUser(db, { id: OWNER, displayName: '房主', nowMs: T0 });
    for (const id of ids) createUser(db, { id, displayName: id, nowMs: T0 });
  } finally {
    db.close();
  }
}

/** 生产装配(与 `scripts/play.ts` 同参:世界 + 真文件库 + 房间)。 */
function bootWithFile(path: string): { runtime: RoomRuntime; clock: { advance(ms: number): void; nowMs(): number } } {
  const clock = fixedClock(T0);
  const a = assemble({ roomId: ROOM, ownerId: OWNER, clock: clock.clock, sizeCells: 8, dbPath: path });
  ok(a.runtime.db !== null, '夹具:装配层应开出一条真文件库');
  OPEN_ROOMS.push(a.runtime);
  return { runtime: a.runtime, clock };
}

/**
 * 内存库房间(房主先建号 —— `createRoom` 对不存在的房主**直接抛**;
 * `ids` 里的玩家也要先建号:`room_players.user_id` 有外键,
 * 没建号的人入场会**回滚**(那不是本套件要测的)。
 */
function memoryRoom(
  ids: readonly string[] = [],
): { rt: RoomRuntime; db: DbLike; clock: { advance(ms: number): void; nowMs(): number } } {
  const db = new MemoryDb();
  migrate(db, T0);
  createUser(db, { id: OWNER, displayName: '房主', nowMs: T0 });
  for (const id of ids) createUser(db, { id, displayName: id, nowMs: T0 });
  const c = fixedClock(T0);
  const rt = new RoomRuntime({ roomId: ROOM, ownerId: OWNER, clock: c.clock }, db);
  OPEN_ROOMS.push(rt);
  return { rt, db, clock: c };
}

/** 把一个 id 的 entity 行放到指定坐标(**夹具**:`snapshotFor` 的输入是 state)。 */
function place(rt: RoomRuntime, userId: string, x: number, y: number): void {
  const p = rt.state.players.find((q) => q.id === userId);
  ok(p !== undefined, `夹具:${userId} 的实体行存在`);
  (p as { x: number; y: number }).x = x;
  (p as { x: number; y: number }).y = y;
}

function idsIn(snapshot: Uint8Array): string[] {
  return decodePacket(snapshot).upserts.map((u) => u.id).sort();
}

/**
 * 「取到了」+ 断言 + **类型收窄**三合一。
 *
 * 为什么不直接 `ok(x !== undefined)`:`ok` 不是 TypeScript 的断言签名
 * (`asserts`),后续使用仍报 `possibly undefined` —— 那会把判据挤进
 * `typecheck` 的欠账里。这个夹具让「断言过 ⇒ 类型上真的非空」成立。
 */
function must<T>(value: T | undefined, msg: string): T {
  ok(value !== undefined, msg);
  if (value === undefined) throw new Error(msg);
  return value;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 直接写 `room_events`(不经 `writeEvent`):模拟「写入路径之外的流水」—— 触发器 / 遗留库。 */
function fillEvents(db: DbLike, n: number): void {
  for (let i = 1; i <= n; i += 1) {
    db.insert('room_events', {
      id: i, room_id: ROOM, tick: i, kind: 'TEST', actor_id: null,
      payload_json: '{}', created_at: T0,
    });
  }
}

/** 背包账的**逐件**快照(判据只比这一份:排序后 itemId→件数)。 */
function countsOf(map: ReadonlyMap<number, number>): string {
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([id, n]) => `${id}:${n}`).join(',');
}

/* ═══════════════ A4:玩家背包明细落库(最优先)═══════════════ */

test('FND163-1 ★★ A4 自动存档把背包账(按件 + 总量)写进库;**新建连接**读回逐件一致', () => {
  /* 变红条件:
     · 把 `saveWorldNow` 里的第 4 参拿掉(或不调 `exportPlayerLedgers`)⇒
       库里 `users.inventory_json` 仍是 '{}' ⇒ 新连接读到 undefined ⇒ 第二条红
       (该形态由 FND163-4 的注入**单独**钉住);
     · 把总量账写成 Σ明细(看起来更「安全」)⇒ 注入过的漂移不再可观测 ⇒
       FND163-3 的 drift 断言红。 */
  const path = freshDbPath();
  seedFileDb(path, ['p1', 'p2']);
  const { runtime, clock } = bootWithFile(path);

  eq(runtime.join({ userId: 'p1' }).ok, true, '前置:p1 入场成功(起始包是入场段最后一件事)');
  const inRoom = must(runtime.exportPlayerLedgers().get('p1'), '前置:房间里已有 p1 的按件账');
  ok(inRoom.counts.size >= 1,
    `前置:房间里已有按件账(${inRoom.counts.size} 个 itemId / 总量 ${inRoom.total})`);
  /* ★ 负对照:**存档动作之前**库里没有这个人的背包账(否则下面读到的可能是
     「本来就在那儿的东西」,什么也没证明)。 */
  eq(loadPlayerLedger(runtime.db as DbLike, 'p1'), undefined,
    '★ 负对照:自动存档**之前**库里没有 p1 的背包账');

  clock.advance(AUTOSAVE_INTERVAL_MS + 1);
  runtime.step();
  eq(runtime.lastSaveReason, 'interval', '前置:这一次是墙钟轨触发的自动存档');
  ok((runtime.lastSaveReport?.ledgerSaved ?? 0) >= 1,
    `★ 存档报告如实记下「写了 ${runtime.lastSaveReport?.ledgerSaved ?? 0} 个人的背包账」`);

  /* ★★ 关键:换一条**新连接**读回(同一个句柄读到自己的写缓存不算落盘)。 */
  const db2 = openNodeSqlite(path);
  try {
    const back = must(loadPlayerLedger(db2, 'p1'), '★★ 新建连接里读得到这个人的背包账(真的落了盘)');
    eq(countsOf(back.counts), countsOf(inRoom.counts), '★★ 逐件一致(itemId → 件数,逐项相等)');
    eq(back.total, inRoom.total, '★ 总量账也一致(两份账都落了库)');
    eq(back.drift, false, '两份账一致(drift = false:总量账没有被写歪)');
    eq(loadPlayerLedger(db2, 'p2'), undefined, '★ 负对照:没进过房的人库里**没有**账');
  } finally {
    db2.close();
  }
});

test('FND163-2 ★ A4 离场也存:`leave()` 先落盘再摘席位,库里读得到他那一份', () => {
  const path = freshDbPath();
  seedFileDb(path, ['p1', 'p2']);
  const { runtime } = bootWithFile(path);

  eq(runtime.join({ userId: 'p2' }).ok, true, '前置:p2 入场成功');
  const inRoom = must(runtime.exportPlayerLedgers().get('p2'), '前置:房间里记着 p2 的账');
  eq(loadPlayerLedger(runtime.db as DbLike, 'p2'), undefined,
    '★ 负对照:离场**之前**库里没有他的账(下面那份只能是离场那次写的)');

  eq(runtime.leave('p2'), true, '前置:离场受理');
  eq(runtime.lastSaveReason, 'leave', '触发原因应是 leave');
  eq(runtime.state.players.some((p) => p.id === 'p2'), false, '席位照旧被摘掉(存档不影响回收)');

  const db2 = openNodeSqlite(path);
  try {
    const back = must(loadPlayerLedger(db2, 'p2'), '★ 离场那一次把背包账写进了库');
    eq(countsOf(back.counts), countsOf(inRoom.counts), '★ 逐件一致(离场路径与周期路径同一份写口)');
  } finally {
    db2.close();
  }
});

test('FND163-3 ★ A4 新房间实例把账读回来(逐项一致);本地已有账 ⇒ 不被库覆盖', () => {
  const path = freshDbPath();
  seedFileDb(path, ['p1']);
  const first = bootWithFile(path);
  first.runtime.join({ userId: 'p1' });
  first.clock.advance(AUTOSAVE_INTERVAL_MS + 1);
  first.runtime.step();
  ok((first.runtime.lastSaveReport?.ledgerSaved ?? 0) >= 1, '前置:第一间房已把账落库');
  first.runtime.close();

  /* 重建:同一个文件路径 = 同一个世界(第一间房已销毁)。 */
  const second = bootWithFile(path);
  const db2 = second.runtime.db as DbLike;
  const stored = must(loadPlayerLedger(db2, 'p1'), '前置:库里已有账');
  eq(second.runtime.authoritativeItemTotal('p1'), 0,
    '★ 负对照:读回**之前**,新实例的权威总量是 0(内存是空的)');

  eq(second.runtime.join({ userId: 'p1' }).ok, true, '前置:新实例里入场成功');
  eq(second.runtime.lastLedgerRestore?.applied, true, '★ 入场时真的读回了账');
  eq(second.runtime.authoritativeItemTotal('p1'), stored.total, '★ 总量账与库里一致');
  eq(second.runtime.authoritativeItemIds('p1').join(','),
    [...stored.counts.keys()].sort((a, b) => a - b).join(','), '★ 按件账的 id 集合逐项一致');
  for (const [itemId, qty] of stored.counts) {
    eq(second.runtime.authoritativeItemCount('p1', itemId), qty, `★ 逐件一致:item ${itemId}`);
  }

  /* ★ 边界:本地已经有账(内存账**永远不比库旧** —— 离场前已存过一次,
     存失败时库里那份才是更旧的)⇒ 不再从库覆盖。 */
  eq(second.runtime.restorePlayerLedger('p1'), false,
    '★ 本地已有账 ⇒ 读回**不动**内存账(覆盖写会把这一局的产出抹成上一次的存档)');
  eq(second.runtime.authoritativeItemTotal('p1'), stored.total, '负对照:总量没被改');
});

test('FND163-4 ★★ 注入:A4 判据有牙 —— 宿主丢掉第 4 参(老宿主形态)⇒ 库里的背包仍空', () => {
  const path = freshDbPath();
  seedFileDb(path, ['p2']);
  const { runtime, clock } = bootWithFile(path);
  const realHost = runtime.worldSaveHost as WorldSaveHost;

  /* ★ 注入:只改**一处** —— 存档主机的第 4 参被丢掉(接线前的形态)。
     其余方法经原型链照旧 ⇒ 下手的是「这一条判据」,不是「宿主坏了」。 */
  const oldHost = Object.create(realHost) as WorldSaveHost;
  (oldHost as { saveToDb: WorldSaveHost['saveToDb'] }).saveToDb =
    (db, roomId, nowMs) => realHost.saveToDb(db, roomId, nowMs);
  runtime.worldSaveHost = oldHost;

  eq(runtime.join({ userId: 'p2' }).ok, true, '前置:入场成功');
  ok(runtime.exportPlayerLedgers().get('p2') !== undefined,
    '前置:房间里**有**账(否则下面只是「本来就没有」)');

  clock.advance(AUTOSAVE_INTERVAL_MS + 1);
  runtime.step();
  eq(runtime.lastSaveReason, 'interval', '★ 存档本身仍然成功(不是失败路径)');
  eq(runtime.lastSaveReport?.ledgerSaved, 0, '★ 报告如实记 0(没写就是没写)');

  const db2 = openNodeSqlite(path);
  try {
    eq(loadPlayerLedger(db2, 'p2'), undefined,
      '★★ 注入对照:库里的背包**仍然空** ⇒ FND163-1 那条不是恒真');
  } finally {
    db2.close();
  }
});

test('FND163-5 ★ A4 负对照:没有库(纯内存模式)⇒ 不落盘、不谎报', () => {
  const clock = fixedClock(T0);
  const { runtime } = assemble({
    roomId: ROOM, ownerId: OWNER, clock: clock.clock, sizeCells: 8, memory: true,
  });
  eq(runtime.db, null, '前置:内存模式 ⇒ db = null');
  runtime.join({ userId: 'p1', asGuest: true });
  ok(runtime.exportPlayerLedgers().get('p1') !== undefined,
    '前置:内存模式里账照样在(起始包不依赖库)');
  const before = runtime.saveCount;
  clock.advance(AUTOSAVE_INTERVAL_MS + 1);
  runtime.step();
  eq(runtime.saveCount, before, '★ 没有库 ⇒ 一次都不算「存过」');
  eq(runtime.lastSaveReason, null, '★ 也没有「存过」的触发原因');
  eq(runtime.lastSaveReport, null, '不产存档报告(不撒谎说存过了)');
  eq(runtime.saveFailCount, 0, '★ 内存模式**不是失败**(saveFailCount 不动)');
  eq(runtime.lastSaveError, null, '也没有错因(跳过 ≠ 失败)');
  /* 主动问一次:跳过原因本身可读(`no-db`)。而 `step()` 里那段**连问都不问**
     (它在 `if (this.db)` 里)—— 那正是「没有库 ⇒ 不进存档段」的形态。 */
  eq(runtime.saveWorldNow('manual'), false, '手动触发也存不了 ⇒ false');
  eq(runtime.lastSaveSkipReason, 'no-db', '跳过原因可读(no-db)');
  eq(runtime.lastSaveReport, null, '★ 手动那次也不产报告(仍不撒谎)');
});

/* ═══════════════ A1:`trimEvents` 接成周期任务 ═══════════════ */

test('FND163-6 ★★ A1 周期轨:超上限的流水到点被削到低水位,且**幂等**', () => {
  /* 变红条件:
     · 把 `maybeTrimEvents` 的水位闸删掉 ⇒ 第一次 step 就 trim(第一条负对照红);
     · 把它接在 `saveWorldNow` 里 ⇒ 本用例(没有世界源)一行都收不掉 ⇒ 第二条红。 */
  /* ★ 第十一轮:期望侧一律写**字面量 3072**(低水位),不拿被测模块的导出常量当期望值 ——
     `eq(count, ROOM_EVENT_RETAIN_LOW_WATER)` 是恒真形态(repo.ts 的 trimEvents 读同一个常量,
     改常量两边一起动),门禁的「同义反复候选」正是抓这个(本轮实测:`WS-FND-163::ROOM_EVENT_RETAIN_LOW_WATER`)。
     下面这一行是**锚点**:常量本身对着数值钉一次(与实际水位分头独立地钉住),锚点走 actual 槽位 ⇒ 不算候选。 */
  eq(ROOM_EVENT_RETAIN_LOW_WATER, 3072, '锚点:低水位常量 = 3072(repo.ts;下面的行为判据写死这个数)');
  const { rt, db, clock } = memoryRoom();
  const total = ROOM_EVENT_RETAIN_MAX + 500;
  fillEvents(db, total);
  eq(db.count('room_events'), total, '前置:表里确实超了上限');
  eq(rt.worldSaveHost, null, '前置:本房间**没有世界源**(存档轨整段跳过 —— 那正是修前的死角)');

  /* ★ 负对照:水位没到 ⇒ 一行不动。 */
  clock.advance(EVENT_TRIM_INTERVAL_MS - 1);
  rt.step();
  eq(db.count('room_events'), total, '★ 负对照:不到 30 秒 ⇒ 一行都不删(水位闸真的在)');
  eq(rt.lastEventTrim, null, '★ 也**没跑过**(没跑与「跑了删 0 条」可区分)');

  clock.advance(2);
  rt.step();
  eq(db.count('room_events'), 3072,
    `★★ 到点 ⇒ 削到低水位(${ROOM_EVENT_RETAIN_LOW_WATER};删 ${total - ROOM_EVENT_RETAIN_LOW_WATER} 条)`);
  eq(rt.lastEventTrim?.removed, total - 3072, 'removed 如实报');
  eq(rt.eventTrimCount, 1, '成功次数 +1');
  eq(rt.lastEventTrimError, null, '没有失败(不谎报错因)');

  /* ★ 幂等:再等一个周期 ⇒ 未超上限 ⇒ 一行不动(判据是**表规模**而不是调用次数)。 */
  clock.advance(EVENT_TRIM_INTERVAL_MS + 1);
  /* 夹具:这一次推进会让总时长越过 `IDLE_SLEEP_MS`(60 秒)⇒ 房间会休眠并写一条
     `ROOM_STATUS` 事件(触发器),把行数变成 3073 而干扰下面的计数。
     `touch()` 是生产里真正的活跃标记(有人动手就刷新)⇒ 用它把房间留在 OPEN。 */
  rt.touch(clock.nowMs());
  rt.step();
  eq(db.count('room_events'), 3072, '★ 再跑一次 ⇒ 行数不变');
  eq(rt.lastEventTrim?.removed, 0, '★ 幂等:removed = 0');
  eq(rt.eventTrimCount, 2, '这一趟**确实跑了**(不是「没跑也算幂等」)');
});

test('FND163-7 ★ A1 只读房(SLEEPING)照样 trim —— 位置必须在 OPEN 早退**之前**', () => {
  const { rt, db, clock } = memoryRoom();
  fillEvents(db, ROOM_EVENT_RETAIN_MAX + 10);
  clock.advance(IDLE_SLEEP_MS + 1);
  eq(rt.checkIdleSleep(), true, '前置:无人 60 秒 ⇒ 房间进入 SLEEPING');
  eq(rt.status, RoomStatus.SLEEPING, '前置状态确认');
  const tickBefore = rt.state.meta.tick;

  clock.advance(EVENT_TRIM_INTERVAL_MS + 1);
  rt.step();
  eq(db.count('room_events'), 3072,
    '★★ 休眠房也把流水收了(修前这一步永远跑不到 —— 只读房正是休眠的形态)');
  eq(rt.state.meta.tick, tickBefore, '★ 负对照:休眠房**帧号仍不推进**(既有休眠语义没被破坏)');
});

test('FND163-8 ★ A1 负对照:没有库 / 未超上限 ⇒ 一行不动;注入:trim 抛错不掀掉 step()', () => {
  /* a) 没有库:整段跳过,且**不产读数**。 */
  const noDb = new RoomRuntime({ roomId: ROOM, ownerId: OWNER, clock: fixedClock(T0).clock });
  eq(noDb.maybeTrimEvents(), 0, '★ 没有库 ⇒ 0(跳过,不是失败)');
  eq(noDb.lastEventTrim, null, '没有库 ⇒ 不产读数(不撒谎)');
  eq(noDb.lastEventTrimError, null, '也不产错因');

  /* b) 有库但未超上限 ⇒ 一行不动。 */
  const { rt, db, clock } = memoryRoom();
  writeEvent(db, ROOM, 1, 'ONE', null, {}, T0);
  clock.advance(EVENT_TRIM_INTERVAL_MS + 1);
  rt.step();
  eq(db.count('room_events'), 1, '★ 负对照:未超上限 ⇒ 一行不动');
  eq(rt.lastEventTrim?.removed, 0, 'removed = 0');

  /* c) 注入:`count` 抛错(库坏了)⇒ step 不许抛,错因必须可读。 */
  (db as unknown as { count: (t: string) => number }).count = () => { throw new Error('Boom:disk'); };
  clock.advance(EVENT_TRIM_INTERVAL_MS + 1);
  let threw = '';
  try {
    rt.step();
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw, '', '★★ 注入:trim 抛错**不许**掀掉 step()(一次 DELETE 失败不该带走整帧)');
  ok((rt.lastEventTrimError ?? '').includes('Boom'),
    `★ 但绝不静默:错因可读(实得 ${String(rt.lastEventTrimError)})`);
  eq(rt.eventTrimCount, 1, '★ 失败**不算**成功次数(与 saveFailCount 同口径)');
});

/* ═══════════ A2:colyseus patch 定时器过席位判据 ═══════════ */

/** 桩 client:`SchemaSerializer.applyPatches` 只读 `state` + 调 `raw(bytes)`。 */
type PatchClient = {
  sessionId: string;
  /** Colyseus 的 `ClientState.JOINED`(= 1);`applyPatches` 只发给 JOINED。 */
  state: number;
  /** 收到的 patch 字节数(**唯一**判据读的就是它)。 */
  patchBytes: number;
  patchCalls: number;
  raw: (bytes: ArrayLike<number>) => void;
  send: (t: string, m?: unknown) => void;
  leave: (code?: number, reason?: string) => void;
  enqueueRaw: (bytes: ArrayLike<number>) => void;
};

function makePatchClient(sessionId: string): PatchClient {
  const c: PatchClient = {
    sessionId,
    state: 1,
    patchBytes: 0,
    patchCalls: 0,
    raw: (bytes) => { c.patchBytes += bytes.length; c.patchCalls += 1; },
    send: () => { /* 本套件不判 send 的内容 */ },
    leave: () => { /* 被踢只摘席位,不断连接 */ },
    enqueueRaw: () => { /* delta 通道的记账:本套件不判它 */ },
  };
  return c;
}

type PatchRoom = {
  clients: PatchClient[];
  runtime: RoomRuntime;
  autoDispose: boolean;
  /** 序列化器探针(见 `installSerializerSpy`)。 */
  serializer: SerializerSpy;
  setSimulationInterval: (cb?: () => void, ms?: number) => void;
  onCreate: (o: unknown) => void;
  onJoin: (c: unknown, o: unknown) => void;
  stepTick: () => void;
  broadcastPatch: () => boolean;
};

/**
 * 序列化器探针 —— `Room.broadcastPatch()` 把「这一次的收件人集」交给它。
 *
 * ## 为什么钉的是**收件人集**而不是「Colyseus 自己发了几字节」
 * `SchemaSerializer.applyPatches(clients)` 是否真的发字节,取决于 Colyseus 的
 * **变更追踪**(`state.$changes.changes.size > 0`)—— 那是它那一层的事,
 * 而且默认单通道模式下 patch 表根本不存在(`USE_COLYSEUS_PATCH = false`)。
 * 本层(我们覆写的 `broadcastPatch`)唯一能决定的、也是唯一该被钉住的量,
 * 就是**交给序列化器的收件人集**。
 * ⇒ 探针拿到那份集后**按同一份集投递**(每个收件人 `raw()` 记 4 字节),
 *   于是「被踢者不再收 patch 字节」这句话在下行侧同样成立,而字节数由
 *   **生产算出的收件人集**决定(不是探针自己判的)。
 */
type SerializerSpy = {
  /** 每次投递的收件人集(排序后的 sessionId 列表)。 */
  seen: string[][];
  calls: number;
  applyPatches: (clients: readonly PatchClient[], state: unknown) => boolean;
};

const PATCH_PROBE_BYTES = 4;

function installSerializerSpy(room: PatchRoom): SerializerSpy {
  const spy: SerializerSpy = {
    seen: [],
    calls: 0,
    applyPatches: (clients) => {
      spy.calls += 1;
      spy.seen.push(clients.map((c) => c.sessionId).sort());
      for (const c of clients) c.raw(new Array<number>(PATCH_PROBE_BYTES).fill(0));
      return true;
    },
  };
  (room as unknown as { _serializer: unknown })._serializer = spy;
  return spy;
}

/** 最近一次投递的收件人集(还没投过 ⇒ 空)。 */
function lastRecipients(room: PatchRoom): string[] {
  const seen = room.serializer.seen;
  return seen.length === 0 ? [] : (seen[seen.length - 1] as string[]);
}

let roomSeq = 0;

/**
 * 真 `NetPersistRoom`(只把两处定时器换掉:构造器建的 50ms patch 表 +
 * `onCreate` 起的 20Hz 仿真表)。`setState` / `new RoomRuntime` / `onJoin`
 * 都**真跑** ⇒ `_serializer` 是真正的 `SchemaSerializer`。
 */
function makePatchRoom(): PatchRoom {
  const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
  const realPatchRate = proto.setPatchRate;
  proto.setPatchRate = function stubPatchRate(): void { /* 不建 patch 定时器 */ };
  let room: PatchRoom;
  try {
    room = new NetPersistRoom() as unknown as PatchRoom;
  } finally {
    proto.setPatchRate = realPatchRate;
  }
  room.autoDispose = false;
  room.setSimulationInterval = () => { /* 帧由测试手动驱动 */ };
  roomSeq += 1;
  room.onCreate({ roomId: `room_fnd163_${roomSeq}`, maxPlayers: 16 });
  room.serializer = installSerializerSpy(room);
  return room;
}

/** 一帧生产推进 + 一次生产 patch 投递(两者都**真的**跑)。 */
function frame(room: PatchRoom): void {
  room.stepTick();
  room.broadcastPatch();
}

test('FND163-9 ★★ A2 patch 定时器过席位判据:踢后不再收 patch;负对照:踢之前两人都在收', () => {
  /* 变红条件:
     · 删掉 `broadcastPatch` 覆写(回到 Colyseus 的裸实现)⇒ 被踢者的
       `patchBytes` 继续涨 ⇒ 核心断言红;
     · 把判据写成「按 sessionId 查席位」⇒ 带凭证的成员会被**整片**裁掉
       (本夹具的成员键恰好等于 sessionId,故这里钉不到 —— 那条由
       `WS-FND-162` 的 FND162-3 单独钉住,本层复用同一个 `deltaExclusions`)。 */
  const room = makePatchRoom();
  const owner = makePatchClient('u_owner');
  const victim = makePatchClient('u_victim163');
  room.clients.push(owner);
  room.onJoin(owner, {});
  room.clients.push(victim);
  room.onJoin(victim, {});
  eq(room.runtime.isSeated('u_victim163'), true, '前置:两人都在席位上');

  const clientsRef = room.clients;
  frame(room);
  frame(room);
  ok(owner.patchBytes > 0 && victim.patchBytes > 0,
    `★ 负对照:踢之前两人都在收 patch(owner=${owner.patchBytes}B / victim=${victim.patchBytes}B)`
    + ' —— 否则「不再收」可能只是「从没收到过」');
  eq(lastRecipients(room).join(','), 'u_owner,u_victim163',
    '★ 常规路径:没人被裁 ⇒ 收件人集 = 全部连接(走与修前逐字相同的那一行)');
  ok(room.clients === clientsRef, '★ 零裁剪时连收件人数组都不换');
  const frozen = { owner: owner.patchBytes, victim: victim.patchBytes, calls: victim.patchCalls };
  const callsBefore = room.serializer.calls;

  eq(room.runtime.dispatchAction('u_owner', RoomAction.KICK_MEMBER, { targetId: 'u_victim163' }).ok,
    true, '前置:房主踢成功');
  eq(room.runtime.isSeated('u_victim163'), false, '★ 踢的落点 = 席位被摘(权威表已无此人)');

  frame(room);
  frame(room);
  frame(room);
  ok(owner.patchBytes > frozen.owner,
    `负对照:留场者继续收 patch(+${owner.patchBytes - frozen.owner}B —— 否则这只是「投递停了」)`);
  eq(victim.patchBytes, frozen.victim,
    `★★ 被踢者**一个 patch 字节都不再收**(实得 ${frozen.victim} → ${victim.patchBytes})`);
  eq(victim.patchCalls, frozen.calls, '★ 连投递次数都冻结(不是「收了空包」)');
  ok(room.serializer.calls > callsBefore, '★ 投递**照旧发生**(不是「整条通道停了」)');
  eq(lastRecipients(room).includes('u_victim163'), false, '★★ 被踢者不在**收件人集**里');
  ok(lastRecipients(room).includes('u_owner'), '负对照:留场者仍在收件人集里');
  ok(room.clients === clientsRef || (room.clients.includes(victim) && room.clients.length === 2),
    '★ 裁剪只在**那一次投递**里有效:收件人数组换过又换回(否则下一帧会把整个连接集丢掉)');
  ok(room.clients.includes(victim),
    '★ 裁剪发生在**投递那一刻**:被踢者仍在 `clients` 里(本层不摘人、不另记账)');
  ok((room.clients as unknown as unknown[]).includes(owner), '负对照:留场者仍在收件人集里');
});

test('FND163-10 ★★ 注入对照:房间不再上报席位(`isSeated` 恒真)⇒ 被踢者**继续**收 patch', () => {
  /* 这条**故意**断言「修法没生效」:它把 FND163-9 的前提(判据在岗)抽掉,
     同一个 socket 的判据必须翻转 —— 否则 FND163-9 可能只是「恒真」。 */
  const room = makePatchRoom();
  const owner = makePatchClient('u_owner');
  const victim = makePatchClient('u_victim163b');
  room.clients.push(owner);
  room.onJoin(owner, {});
  room.clients.push(victim);
  room.onJoin(victim, {});
  frame(room);
  frame(room);
  ok(victim.patchBytes > 0, `前置:被踢者踢之前真的在收 patch(${victim.patchBytes}B)`);

  /* ★ 注入:只改**判据**这一处。 */
  (room.runtime as unknown as { isSeated: (u: string) => boolean }).isSeated = () => true;
  eq(room.runtime.dispatchAction('u_owner', RoomAction.KICK_MEMBER, { targetId: 'u_victim163b' }).ok,
    true, '★ 踢本身仍然成功(证明下面翻转的是**判据**,不是「踢没生效」)');
  eq(room.runtime.members.get('u_victim163b'), undefined,
    '★ 权威表里真的没有这个人了(注入只动了 `isSeated` 这一个读数)');

  const frozen = victim.patchBytes;
  frame(room);
  frame(room);
  ok(lastRecipients(room).includes('u_victim163b'),
    '★★ 注入对照:他被照旧算进**收件人集**(判据没了 ⇒ 席位不再参与裁剪)');
  ok(victim.patchBytes > frozen,
    `★★ 注入对照:没有席位判据 ⇒ 被踢者**照旧**收 patch(${frozen} → ${victim.patchBytes}B)`
    + ' —— 这一条与 FND163-9 互为对方的前提');
});

/* ═══════════════ A3:AOI 级裁剪 ═══════════════ */

test('FND163-11 ★★ A3 snapshotFor 范围裁剪:远处玩家的变化不进我的包,拉近就进(负对照)', () => {
  /* 变红条件:
     · 把 `snapshotFor` 的最后一行改回 `encodeFull(this.state, ...)` ⇒
       「远处玩家不进包」当场红;
     · 把 `limit` 判据写成 `===`(只收恰好等距的)⇒ 视距内的负对照红。 */
  const { rt } = memoryRoom(['u_me163', 'u_far163', 'u_near163']);
  rt.join({ userId: 'u_me163' });
  rt.join({ userId: 'u_far163' });
  rt.join({ userId: 'u_near163' });
  place(rt, 'u_me163', 0, 0);
  place(rt, 'u_far163', 500, 500);
  place(rt, 'u_near163', 1, 1);

  const near = idsIn(rt.snapshotFor('u_me163'));
  ok(near.includes('u_me163'), '★ 自己恒在(不可见自己 = 客户端把自己删掉)');
  eq(near.includes('u_far163'), false, '★★ 远处玩家(500,500)不进我的包');
  ok(near.includes('u_near163'), '★ 负对照:视距内的玩家**在**包里(不是「谁都不发」)');

  /* 拉进视距 ⇒ 下一份快照里就有他(没有第二处缓存要清)。 */
  place(rt, 'u_far163', 2, 2);
  ok(idsIn(rt.snapshotFor('u_me163')).includes('u_far163'), '★ 走进视距 ⇒ 立刻可见');

  /* 边界:恰好 AOI 半径可见;超 0.5 格不可见(与 `aoi.ts` 的 `<=` 同口径)。 */
  place(rt, 'u_far163', AOI_WAKE_DISTANCE, 0);
  ok(idsIn(rt.snapshotFor('u_me163')).includes('u_far163'),
    `★ 边界:恰好 ${AOI_WAKE_DISTANCE} 格仍可见`);
  place(rt, 'u_far163', AOI_WAKE_DISTANCE + 0.5, 0);
  eq(idsIn(rt.snapshotFor('u_me163')).includes('u_far163'), false,
    `★ 边界外 0.5 格 ⇒ 不可见(判据是既有常量,不是新造的半径)`);
});

test('FND163-12 ★ A3 可见性**按人**算(同一帧两个观察者 ⇒ 两份不同的包)', () => {
  const { rt } = memoryRoom(['u_a163', 'u_b163']);
  rt.join({ userId: 'u_a163' });
  rt.join({ userId: 'u_b163' });
  place(rt, 'u_a163', 0, 0);
  place(rt, 'u_b163', 500, 500);

  const forA = idsIn(rt.snapshotFor('u_a163'));
  const forB = idsIn(rt.snapshotFor('u_b163'));
  ok(forA.includes('u_a163') && forA.includes('u_b163') === false,
    '★ A 的包里只有自己(远端 B 被裁)');
  ok(forB.includes('u_b163') && forB.includes('u_a163') === false,
    '★ B 的包里也只有自己 —— 同一份世界、按观察者各算一次');
  /* ★ 这条钉的是「判据只有一个、但它**真的按人**」:若哪天有人把它换成
     「一次全局裁剪」(对全员用同一个视野)⇒ 两条断言里必有一条红。 */
  ok(!sameBytes(rt.snapshotFor('u_a163'), rt.snapshotFor('u_b163')),
    '★ 两份包逐字节不同(不是整房共用的那一份)');
});

test('FND163-13 ★ A3 全员在 AOI 内 ⇒ 与整房编码**逐字节相同**(常规路径零改动)', () => {
  const { rt } = memoryRoom(['u_c163', 'u_d163']);
  rt.join({ userId: 'u_c163' });
  rt.join({ userId: 'u_d163' });
  place(rt, 'u_c163', 4, 4);
  place(rt, 'u_d163', 5, 5);
  const full = encodeFull(rt.cloneState(), rt.state.meta.tick).bytes;
  ok(sameBytes(rt.snapshotFor('u_c163'), full),
    '★ 零改动短路:全员可见时快照与修前(整房编码)**逐字节相同**');
});

test('FND163-14 ★ A3 wildlife 同一份判据;注入:视野源缺失 ⇒ fail-open 退回整房', () => {
  const { rt } = memoryRoom(['u_e163', 'u_f163']);
  rt.join({ userId: 'u_e163' });
  rt.join({ userId: 'u_f163' });
  place(rt, 'u_e163', 0, 0);
  place(rt, 'u_f163', 500, 500);
  upsertWildlife(rt.state, createWildlifeState('w_far163', { x: 400, y: 400 }));
  upsertWildlife(rt.state, createWildlifeState('w_near163', { x: 3, y: 3 }));

  const ids = idsIn(rt.snapshotFor('u_e163'));
  eq(ids.includes('w_far163'), false, '★ 远处的 wildlife 也不进包(与玩家同一份判据)');
  ok(ids.includes('w_near163'), '★ 负对照:视距内的 wildlife 在包里');

  /* ★ 注入:把自己那一行 state 删掉(极端:投影尚未跑)⇒ 没有视野源。
     fail-open 退回整房 —— 宁可多发,也不静默把人裁成空世界。 */
  rt.state.players = rt.state.players.filter((p) => p.id !== 'u_e163');
  const after = idsIn(rt.snapshotFor('u_e163'));
  ok(after.includes('u_f163') && after.includes('w_far163'),
    '★★ 注入:视野源缺失 ⇒ 退回**整房**(远端实体回来了)');
  ok(after.length > 0,
    '★ 负对照:成员表判据仍然在岗(快照**不是空包** —— 0 字节是「席位没了」的表达)');
});

/* 收尾:关句柄(Windows 上不关就删不动文件),再尽力删临时目录。 */
for (const rt of OPEN_ROOMS) {
  try { (rt.db as unknown as { close?: () => void } | null)?.close?.(); } catch { /* 已关 */ }
}
try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 句柄仍在 */ }

report('WS-FND-163');
