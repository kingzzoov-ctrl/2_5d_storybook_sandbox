/**
 * WS-FND-156 · **「起始背包已发」跨进程幂等**(房内实例账 ⇒ 库层台账)。
 *
 * ## 这一版修的是什么
 *
 * WS-FND-155 把起始背包接了进来,但「已发」只有一份**房间实例**的内存账
 * (`RoomRuntime.startingInventoryGranted:Set<string>`)⇒
 * ```
 * 服务重启(或换一个 Room 实例)⇒ 同一个 id 再 join ⇒ 集合是空的 ⇒ **再发一份**
 * 同一个 id 在两个进程里各进一次  ⇒ 两份起始包(且都没人觉得哪里不对)
 * ```
 * 现在「已发」写进库(`user_starting_inventory`,主键 = `user_id`):
 * 先查库 → 未领才发 → 发成功再写库,**并发靠库层唯一约束**,失败**撤回**不留半态。
 *
 * ## 判据(13 条)
 * ```text
 * FND156-1  ★ 结构:台账是**独立旁表**(主键 user_id)、不进 schema.sql、
 *              没发放过的库仍是 9 张表 / 零登记行
 * FND156-2  ★★ 有库:首次 join 真的发 + 台账落下**一行**(带发放时的版本号)
 * FND156-3  ★★ 同一用户二次 join(同实例、重连路径)不重发,台账仍 1 行
 * FND156-4  ★★ **换一个房间实例**(同库、同房 id,装配第二个 RoomRuntime)不重发
 * FND156-5  ★★ **有库模式下重启**(文件库:关掉重开 + 新建 Room 与 db)不重发
 * FND156-6  ★★ **并发两次 join 只发一份**:两个实例共享一个库,注入交错 ⇒
 *              一方赢、另一方**撤回**自己的那一份;两账相加 = 7(14 会红)
 * FND156-7  ★★ **旧库迁移后可用**:只跑过基线迁移的旧库 ⇒ 就地补表(不重建)、
 *              既有行不动、再跑一次 migrate 不漂移
 * FND156-8  ★★ `RESET_WORLD` **不清**标记(玩家世代 ≠ 世界世代),重置后重进仍 SKIPPED
 * FND156-9  ★★ 无库模式(`--memory`,`db === null`):退化为进程内账,
 *              同实例不重发,而**新实例会再发一次** —— 这条已知边界被显式断言
 * FND156-10 ★  起始包**版本号**变化的语义 = **不补发**:判据只看「有没有这一行」,
 *              版本号只是审计(不会被二次发放覆盖)
 * FND156-11 ★  台账写库抛错 ⇒ `FAILED` + 账 0 件 + 零行(**不留半态**),修复后能拿到
 * FND156-12 ★  入场中途失败 ⇒ 台账行**一并撤回**(否则重试永远 SKIPPED),重试仍能拿到
 * FND156-13 ★  台账迁移 checksum **漂移** ⇒ 不发(fail-closed,零副作用)
 * ```
 *
 * ## 怎么变红(每条都靠注入证明自己有牙)
 * ```text
 * FND156-1 把台账表塞进 schema.sql(或让它进 migrate())⇒ 断言 2/4 红(9 张表变 10)
 * FND156-2 把 claimStartingInventoryGrant 那一步删掉 ⇒ 断言 3/5 红(库里没有行)
 * FND156-3 删掉闸 0(读台账)⇒ 断言 2 红(新实例又发 7 件)
 * FND156-4 删掉闸 0 或改成只看内存账 ⇒ 断言 2/4 红
 * FND156-5 同上(重启后那两个实例的内存账都是空的)⇒ 断言 3 红
 * FND156-6 把 claim 换成「先查再写」⇒ 断言 4/5 红(两个 7 件 = 14)
 * FND156-7 把「就地补表」改成「重建表」⇒ 断言 5/6 红(既有 users 行没了)
 * FND156-8 在 RESET_WORLD 成功时清台账 ⇒ 断言 3 红
 * FND156-9 给内存模式补一个「假装跨进程」的账(或反过来:让有库模式也退化成内存)⇒ 断言红
 * FND156-10 让版本升高触发补发(或让二次发放覆盖 version)⇒ 断言 3/4 红
 * FND156-11 删掉写库失败时的撤回 ⇒ 断言 4/5 红(账里留下 7 件而库里没有行)
 * FND156-12 删掉 releaseDbGrantIfOurs(或让它删别人的行)⇒ 断言 3 红(重试永远拿不到)
 * FND156-13 让 claim 忽略 migration.drift ⇒ 断言 3 红(漂移的库照发)
 * ```
 *
 * 运行:`node tests/WS-FND-156-crossproc-idempotency.test.ts`
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { RoomRuntime, StartingInventoryReport } from '../server/src/net/room.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  STARTING_INVENTORY_TABLE,
  STARTING_INVENTORY_VERSION,
  STARTING_INVENTORY_MIGRATION_VERSION,
  claimStartingInventoryGrant,
  countStartingInventoryGrants,
  createUser,
  migrate,
  migrateStartingInventory,
  readMigrationRows,
  readStartingInventoryGrant,
  readStartingInventorySql,
  startingInventoryMigrationInstalled,
} from '../server/src/db/repo.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

const OWNER = 'u_owner';
const P = 'u_p';                 /* 玩家 id:台账不引外键,故**不必**有 users 行(访客) */
/** 旧库建库时的时刻(与后续 join 的时刻分开,便于看清「哪一次写的」)。 */
const T0 = 1000;
/** 发放时注入的时钟读数。 */
const T1 = 5000;

type Fixture = { rt: RoomRuntime; db: MemoryDb; roomId: string };

let roomSeq = 0;

/** 一份**跑过基线迁移**的库 + 房主与玩家两个 user 行(`room_players.user_id` 是真外键)。 */
function freshDb(ownerId = OWNER): MemoryDb {
  const db = new MemoryDb();
  migrate(db, T0);
  createUser(db, { id: ownerId, displayName: 'O', nowMs: T0 });
  createUser(db, { id: P, displayName: 'P', nowMs: T0 });
  return db;
}

/** 装配一个真房间(不手搓 rtOpts:那会绕开 `assemble()` 的接线)。 */
function makeRoom(o: { db: MemoryDb; roomId?: string; ownerId?: string; clock?: () => number }): Fixture {
  roomSeq += 1;
  const roomId = o.roomId ?? `r_fnd156_${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: o.ownerId ?? OWNER,
    clock: { nowMs: o.clock ?? (() => T1) },
    sizeCells: 16,
    /* 本套件不测生物 AI:关掉免得自发改刷干扰背包账。 */
    mobs: false,
    db: o.db,
  });
  return { rt: a.runtime, db: o.db, roomId };
}

/** 最近一次发放回执(不存在 ⇒ 断言失败:发放不许静默)。 */
function lastReport(rt: RoomRuntime): StartingInventoryReport {
  const r = rt.lastStartingInventory;
  ok(r !== null, '回执必须存在(`lastStartingInventory`)—— 发放不许静默');
  return r as StartingInventoryReport;
}

/** 私有字段的只读观测:进程内幂等账 / 「本进程写成功的台账行」。 */
const memoryGrantedOf = (rt: RoomRuntime): Set<string> =>
  (rt as unknown as { startingInventoryGranted: Set<string> }).startingInventoryGranted;
const dbClaimedOf = (rt: RoomRuntime): Set<string> =>
  (rt as unknown as { dbGrantClaimed: Set<string> }).dbGrantClaimed;

/** 把某张表的 `insert` 换掉(故障/交错注入)。 */
function patchInsert(
  db: MemoryDb,
  hook: (table: string, row: Record<string, unknown>, real: () => void) => void,
): void {
  const real = db.insert.bind(db);
  (db as unknown as { insert: (t: string, r: Record<string, unknown>) => void }).insert = (table, row) => {
    hook(table, row, () => real(table, row));
  };
}

/* ═════════════════ 1. 结构:独立旁表,不进基线 DDL ═════════════════ */

test('FND156-1 ★ 台账是独立旁表(主键 user_id):没发放过的库仍是 9 张表 / 零登记行', () => {
  /* 变红条件:把台账表并进 schema.sql 或让 `migrate()` 建它 ⇒ 「9 张表」当场红。 */
  const sql = readStartingInventorySql();
  ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${STARTING_INVENTORY_TABLE}`),
    '台账 DDL 必须出自**真实文件**(读的是运行时那一份,不复制一份到测试里)');
  ok(sql.includes('PRIMARY KEY'), '★ 主键是并发占位的抓手:缺了它就挡不住两个进程');
  ok(sql.includes('user_id') && sql.includes('version') && sql.includes('granted_at'),
    '台账三列:user_id / version / granted_at');

  const db = freshDb();
  eq(db.tableNames().length, 9, '基线迁移后仍是 9 张表 —— 台账**不在** schema.sql 里');
  eq(startingInventoryMigrationInstalled(db), false, '没发放过 ⇒ 台账迁移**没有**登记行');
  eq(countStartingInventoryGrants(db), 0, '没发放过 ⇒ 零行(而不是「表在但空」)');
  eq(readStartingInventoryGrant(db, P), undefined, '没领过 ⇒ 读口给 undefined(不是空对象)');

  /* 正对照:真的发过一次之后,上面那几条各自的负号都翻过来(证明不是恒假)。 */
  const f = makeRoom({ db });
  f.rt.join({ userId: P });
  eq(startingInventoryMigrationInstalled(db), true, '正对照:发放之后台账迁移被登记了');
  eq(db.tableNames().includes(STARTING_INVENTORY_TABLE), true, '正对照:台账表就地建出来了');
  eq(db.declaredColumns(STARTING_INVENTORY_TABLE), ['user_id', 'version', 'granted_at'],
    '正对照:DDL 声明的就是这三列(与上面那段原文一致)');
});

/* ═════════════════ 2. 有库:首次真的发 + 台账落一行 ═════════════════ */

test('FND156-2 ★★ 有库首次 join:账里 7 件 + 台账一行(带发放时的版本号)', () => {
  /* 变红条件:删掉 `claimStartingInventoryGrant` 那一步 ⇒ 「台账没有行」红。 */
  const db = freshDb();
  const f = makeRoom({ db });
  const res = f.rt.join({ userId: P });
  eq(res.ok, true, '前置:入场成功');

  const rep = lastReport(f.rt);
  eq(rep.verdict, 'GRANTED', '★ 首次出现 ⇒ GRANTED');
  eq(rep.total, 7, '发了 7 件');
  eq(f.rt.authoritativeItemTotal(P), 7, '★★ 权威账真的多了 7 件');

  const row = readStartingInventoryGrant(db, P);
  ok(row !== undefined, '★★ 台账里必须有这个 id 的行(跨进程真值就落在这里)');
  eq(row?.user_id, P, '台账点名是谁的');
  eq(row?.version, 1, '★ 记的是**发放当时**的版本号(字面量 1 = `STARTING_INVENTORY_VERSION`,不是「领没领过」的布尔)');
  eq(Number(row?.granted_at), T1, '发放时刻取注入时钟');
  eq(countStartingInventoryGrants(db), 1, '一个玩家一行');
  eq(dbClaimedOf(f.rt).has(P), true, '★ 「本进程写成功的台账行」也要记上(撤回时才知道该删谁)');

  /* 负对照:另一间库里同一个人没领过 ⇒ 读口给 undefined(证明上面那行不是恒真)。 */
  const other = freshDb();
  eq(readStartingInventoryGrant(other, P), undefined, '负对照:换一个库 ⇒ 没领过');
});

/* ═════════════════ 3/4. 同实例 / 换实例:都不重发 ═════════════════ */

test('FND156-3 ★★ 同一用户二次 join(重连路径)不重发:台账仍 1 行', () => {
  /* 变红条件:删掉闸 0 ⇒ 闸 1(内存账)仍挡得住这一次;但 FND156-4 会红。 */
  const db = freshDb();
  const f = makeRoom({ db });
  f.rt.join({ userId: P });
  f.rt.disconnect(P);
  const re = f.rt.join({ userId: P });
  eq(re.resumed, true, '前置:走的是重连路径(宽限期内)');

  eq(f.rt.authoritativeItemTotal(P), 7, '★★ 重连后仍是 7 件(重发就会是 14)');
  eq(lastReport(f.rt).verdict, 'SKIPPED', '★ 如实 SKIPPED');
  eq(countStartingInventoryGrants(db), 1, '台账仍是一行');
  eq(lastReport(f.rt).total, 0, '没发的那次件数为 0(回执不许声称发了)');
});

test('FND156-4 ★★ 换一个房间实例(同库同房)不重发:闸 0 = 库里的行', () => {
  /* 变红条件:删掉闸 0(或只看内存账)⇒ 新实例的内存账是空的 ⇒ 又发 7 件,断言 3 红。 */
  const db = freshDb();
  const roomId = 'r_fnd156_reinstance';
  const first = makeRoom({ db, roomId });
  first.rt.join({ userId: P });
  eq(first.rt.authoritativeItemTotal(P), 7, '前置:第一个实例发了');

  const second = makeRoom({ db, roomId });
  eq(second.rt.authoritativeItemTotal(P), 0, '前置:新实例的内存账是空的(这就是跨进程的形态)');
  const res = second.rt.join({ userId: P });
  eq(res.ok, true, '前置:新实例入场成功');

  const rep = lastReport(second.rt);
  eq(rep.verdict, 'SKIPPED', '★★ 换了实例也不发 —— 判据来自库,不是内存');
  ok(String(rep.reason).includes('库里'), `理由点明「库里记着」(实得:${rep.reason})`);
  eq(second.rt.authoritativeItemTotal(P), 0, '★ 没发 ⇒ 新实例的账仍是 0(不是 7)');
  eq(countStartingInventoryGrants(db), 1, '★★ 台账没有被写第二行');
  eq(memoryGrantedOf(second.rt).has(P), false, '内存账不许凭空记上「发过」');
});

/* ═════════════════ 5. 有库模式下的**真重启**(文件库) ═════════════════ */

test('FND156-5 ★★ 断电级重启(关掉文件库再重开 + 新建 Room 与 db)不重发', () => {
  /* 变红条件:删掉闸 0 ⇒ 重启后新实例又发一份(断言 4 红)。 */
  const dir = mkdtempSync(join(tmpdir(), 'wsfnd156-'));
  const path = join(dir, 'world.db');
  try {
    /* ── 第一个「进程」 ── */
    const db1 = openNodeSqlite(path);
    db1.bootstrap(T0);
    createUser(db1, { id: OWNER, displayName: 'O', nowMs: T0 });
    /* `room_players.user_id` 是真外键 ⇒ 玩家也要有 users 行(与内存夹具同一前提)。 */
    createUser(db1, { id: P, displayName: 'P', nowMs: T0 });
    const a = assemble({
      roomId: 'r_fnd156_restart', ownerId: OWNER, clock: { nowMs: () => T1 },
      sizeCells: 16, mobs: false, db: db1,
    });
    eq(a.runtime.join({ userId: P }).ok, true, '前置:第一个进程里入场成功');
    eq(lastReport(a.runtime).verdict, 'GRANTED', '前置:第一个进程发了起始包');
    eq(db1.count(STARTING_INVENTORY_TABLE), 1, '前置:台账落到文件库里了');
    db1.close();

    /* ── 「重启」:新建 db 对象(同一个文件)+ 新建 Room ── */
    const db2 = openNodeSqlite(path);
    db2.bootstrap(T0);
    eq(db2.count(STARTING_INVENTORY_TABLE), 1, '★★ 重启后台账还在(这就是「跨进程」的全部含义)');
    const b = assemble({
      roomId: 'r_fnd156_restart', ownerId: OWNER, clock: { nowMs: () => T1 + 60000 },
      sizeCells: 16, mobs: false, db: db2,
    });
    const res = b.runtime.join({ userId: P });
    eq(res.ok, true, '前置:重启后入场成功');

    const rep = lastReport(b.runtime);
    eq(rep.verdict, 'SKIPPED', '★★ 重启后**不**重发(修前这里必发第二份)');
    eq(db2.count(STARTING_INVENTORY_TABLE), 1, '★★ 台账仍是一行');
    /* ★ 真引擎上的唯一约束也要能被识别:同一个 id 再占位 ⇒ `false`(不是抛)。
       这条钉的是 `claimStartingInventoryGrant` 里那两套错误措辞
       (MemoryDb「主键冲突」/ SQLite「UNIQUE constraint failed」)在**真后端**上也生效。 */
    eq(claimStartingInventoryGrant(db2, P, STARTING_INVENTORY_VERSION, T1 + 1), false,
      '★★ 真实 SQLite 上第二次占位返回 false(冲突识别在两个后端都对)');
    /* 如实记边界:背包明细本身**还没有落库路径**(`ai_item_instances` 无生产写口),
       故重启后账里是 0 件 —— 那是既有缺口,不是本次引入的「少发」。 */
    eq(b.runtime.authoritativeItemTotal(P), 0, '重启后内存账为 0(背包本就不跨进程,见注释)');
    db2.close();
  } finally {
    /* 清理临时库。⚠️ 失败**不抛**:Windows 上被占用/未 close 的文件会 EPERM,
       而那个二次异常会把真正的断言失败掩盖掉(排查成本翻倍)。 */
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已尽力清理 */ }
  }
});

/* ═════════════════ 6. 并发两次 join:只发一份 ═════════════════ */

test('FND156-6 ★★ 并发两次 join 只发一份:库层唯一约束挡住第二次,败方撤回首份', () => {
  /* 变红条件:把 `claimStartingInventoryGrant` 换成「先查一次再写」⇒ 两个实例都查到
     「没有行」⇒ 各发 7 件(账相加 14)⇒ 断言 4/5 红。 */
  const db = freshDb();
  const roomId = 'r_fnd156_race';
  const a = makeRoom({ db, roomId });
  const b = makeRoom({ db, roomId });          /* 另一个 Room 实例 = 另一个进程的装配 */

  /* 注入交错:在 A **写台账的那一瞬**把 B 的整条 join 放进来跑完(查-写之间的窗口)。
     这正是真并发下会发生的事,只是单线程里必须手动安排先后。 */
  let interfered = false;
  patchInsert(db, (table, _row, real) => {
    if (table === STARTING_INVENTORY_TABLE && !interfered) {
      interfered = true;
      eq(b.rt.join({ userId: P }).ok, true, '前置:插进来的那次 join 也成功');
    }
    real();
  });

  const ra = a.rt.join({ userId: P });
  eq(interfered, true, '注入生效:两次 join 真的交错在同一个窗口里');
  eq(ra.ok, true, '★ A 的入场仍然成功(发放失败不该掀掉入场)');
  eq(lastReport(b.rt).verdict, 'GRANTED', '★ B 先写完台账 ⇒ 它保留自己发的那一份');
  eq(lastReport(a.rt).verdict, 'SKIPPED', '★★ A 撞唯一约束 ⇒ 撤回并如实记 SKIPPED');
  ok(String(lastReport(a.rt).reason).includes('唯一约束'), `理由点明唯一约束(实得:${lastReport(a.rt).reason})`);

  eq(a.rt.authoritativeItemTotal(P), 0, '★★ 败方账里一件都不留(撤回是整批的)');
  eq(b.rt.authoritativeItemTotal(P), 7, '★ 胜方账里是 7 件');
  eq(a.rt.authoritativeItemTotal(P) + b.rt.authoritativeItemTotal(P), 7,
    '★★ 两账相加 = 7(并发发出 14 会红)');
  eq(countStartingInventoryGrants(db), 1, '★★ 台账只有一行(库层唯一约束 = 并发判据)');
  eq(dbClaimedOf(a.rt).has(P), false, '★ A 没写成功 ⇒ 不许把这条记成「我们占的」(否则撤回会误删对方那行)');
  eq(dbClaimedOf(b.rt).has(P), true, '★ B 才是那行的主人');
  eq(readStartingInventoryGrant(db, P)?.version, 1, '那行是 B 写的,B 的版本号仍在(字面量 1)');
});

/* ═════════════════ 7. 旧库:就地补表,不重建 ═════════════════ */

test('FND156-7 ★★ 旧库(只跑过基线迁移)迁移后可用:就地补表,既有行不动', () => {
  /* 变红条件:把「就地补表」改成「重建表 / 重建库」⇒ 断言 5/6 红(既有 users 行没了),
     或让旧库直接抛错(那就是「旧库不可用」)。 */
  const db = freshDb();
  /* 旧库里已经有的数据:一个玩家行(证明补表不重建、不丢行)。 */
  createUser(db, { id: 'u_old', displayName: 'old', nowMs: T0 });
  const before = db.tableNames().slice();
  eq(before.length, 9, '前置:旧库是 9 张表(没有台账)');
  eq(startingInventoryMigrationInstalled(db), false, '前置:旧库没有台账登记行');
  eq(readMigrationRows(db).map((r) => Number(r.version)), [1], '前置:旧库只登记了基线版本 1');

  const f = makeRoom({ db });
  const res = f.rt.join({ userId: P });
  eq(res.ok, true, '★★ 旧库上入场照常成功(不抛「结构不认识」)');
  eq(lastReport(f.rt).verdict, 'GRANTED', '★★ 旧库上发放照常发生');

  eq(readMigrationRows(db).map((r) => Number(r.version)).sort((x, y) => x - y), [1, STARTING_INVENTORY_MIGRATION_VERSION],
    '★ 台账迁移就地登记成新的一段(旧的那一段原样保留)');
  eq(db.get('users', { id: 'u_old' })?.display_name, 'old', '★★ 既有行一个都没丢(就地补表,不是重建)');
  eq(db.tableNames().length, 10, '★ 只**多**了台账这一张');
  eq(db.tableNames().filter((t) => before.includes(t)).length, 9, '★★ 原来那 9 张全在');

  /* 旧库在补表之后必须仍能被基线迁移重复跑(幂等),且不判漂移。 */
  const again = migrate(db, T0 + 1);
  eq(again.drift, false, '★★ 补表之后重跑基线迁移:无漂移(旧库没有被改坏)');
  eq(again.applied, false, '基线版本早已登记 ⇒ 不重复登记');
});

/* ═════════════════ 8. RESET_WORLD:不清标记 ═════════════════ */

test('FND156-8 ★★ `RESET_WORLD` 不清台账:重置后换实例重进仍 SKIPPED', () => {
  /* 变红条件:`RESET_WORLD` 成功时清台账(或把台账按 room_id / 世界世代存)⇒ 断言 3 红。
     裁决理由(与 FND155-8 同一份):台账是**玩家世代**数据(`user_id` → 已领),
     而重置换的是**世界世代**(种子 / 地形 / 生物);清了就是「重置一次每人再白拿一份」。 */
  const db = freshDb();
  const roomId = 'r_fnd156_reset';
  const f = makeRoom({ db, roomId });
  /* 重置是 destructive 动作 ⇒ 只能由 OWNER 发起(`makeRoom` 的 ownerId 就是 OWNER)。 */
  f.rt.join({ userId: OWNER });
  eq(countStartingInventoryGrants(db), 1, '前置:台账有一行');

  const reset = f.rt.dispatchAction(OWNER, RoomAction.RESET_WORLD, { confirm: true, seed: 4242 });
  eq(reset.ok, true, '前置:重置成功(真 WorldSim 有 resetWorld)');
  eq(countStartingInventoryGrants(db), 1, '★★ 重置不清台账(玩家世代 ≠ 世界世代)');
  eq(readStartingInventoryGrant(db, OWNER)?.version, 1, '★ 行内容也没被动过(版本仍是字面量 1)');

  const g = makeRoom({ db, roomId });
  g.rt.join({ userId: OWNER });
  eq(lastReport(g.rt).verdict, 'SKIPPED', '★★ 重置后换实例重进仍不发(7 件变 14 会红)');
  /* ★ WS-FND-163(A4)之后「一件都没多发」换了读数:新实例会把**他自己的**背包账
     从 `users.inventory_json` 读回来(那是他本来就有的东西,不是新发的)。
     ⇒ 判据取**本次发放的件数**(真重发会是 7 ⇒ 红);总量则应当等于第一间房
     发出去的那一份(即「读回来的正是他自己的」)。 */
  eq(lastReport(g.rt).granted.length, 0, '★ 一件都没多发(本次发放 0 件)');
  eq(g.rt.authoritativeItemTotal(OWNER), lastReport(f.rt).total,
    '★ 而总量 = **读回来的他自己的**那份(与第一间房发出去的一致),不是新发的');
});

/* ═════════════════ 9. 无库模式(--memory)的语义 ═════════════════ */

test('FND156-9 ★★ 无库模式(`--memory`):退化为进程内账,**重启会重发**(如实断言)', () => {
  /* ## 这条判据断言的是**已知边界**,不是理想行为
   * `db === null` 时没有跨进程真值可言 ⇒ 闸 1(内存 Set)是唯一的账:
   * ```
   * 同一个实例里再 join ⇒ SKIPPED(内存账在)
   * 换一个实例(= 进程重启)⇒ **再发一份**  ← ⚠️ 这就是「--memory 模式下重启会重发」
   * ```
   * 修前的行为与此**逐字相同**(本轮不改变无库模式的语义,只把边界写清楚)。
   * 变红条件:让内存模式也「假装跨进程幂等」(例如编一个进程级全局集合)⇒ 断言 5 红;
   *          反过来,把**有库模式**也退化成内存账 ⇒ FND156-4/5/6 红。 */
  const noDb = assemble({
    roomId: 'r_fnd156_memory', ownerId: OWNER, clock: { nowMs: () => T1 },
    sizeCells: 16, mobs: false, db: null,
  });
  eq(noDb.runtime.db, null, '前置:这个房间真的是**无库**模式');

  const rt = noDb.runtime;
  rt.join({ userId: P });
  eq(lastReport(rt).verdict, 'GRANTED', '首次 ⇒ 发');
  eq(rt.authoritativeItemTotal(P), 7, '记了 7 件');

  rt.disconnect(P);
  rt.join({ userId: P });
  eq(lastReport(rt).verdict, 'SKIPPED', '★ 同一实例内不重发(内存账在)');
  eq(rt.authoritativeItemTotal(P), 7, '仍是 7 件');

  /* 「重启」= 新建 RoomRuntime(内存账随进程消失)⇒ 无库模式下只能再发一份。 */
  const restarted = assemble({
    roomId: 'r_fnd156_memory', ownerId: OWNER, clock: { nowMs: () => T1 },
    sizeCells: 16, mobs: false, db: null,
  }).runtime;
  restarted.join({ userId: P });
  eq(lastReport(restarted).verdict, 'GRANTED',
    '⚠️ 无库模式:**重启会重发** —— 这条边界被显式断言(有库模式由 FND156-4/5 钉住相反结论)');
  eq(restarted.authoritativeItemTotal(P), 7, '新进程里又是 7 件(没有跨进程真值可查)');
  eq(memoryGrantedOf(restarted).has(P), true, '★ 新实例的账只有它自己写的那一份');
});

/* ═════════════════ 10. 版本号变化的语义:不补发 ═════════════════ */

test('FND156-10 ★ 起始包版本升高**不补发**:判据只看「有没有这一行」,版本号只作审计', () => {
  /* ## 选「不补发」的理由(完整论证见 `repo.ts` §14)
   * 1 起始包是**入场门槛**的一次性礼包(WS-FND-155 裁定:不是经济补偿);
   * 2 补发没有可靠的动作面 —— 入场是唯一调用点,而入场次数与版本数无关;
   * 3 但版本号必须落库:将来真要补发时,「谁领的是 v1」这个查询要有原料。
   * 变红条件:让版本升高触发补发(或让第二次发放覆盖已存的 version)⇒ 断言 3/4 红。 */
  const db = freshDb();
  const f = makeRoom({ db });
  f.rt.join({ userId: P });
  eq(readStartingInventoryGrant(db, P)?.version, 1, '前置:领的是当前版本(字面量 1)');

  /* 1 「版本更高」的占位请求照样被唯一约束挡住 ⇒ 口径与版本号无关(只看有没有行)。 */
  eq(claimStartingInventoryGrant(db, P, STARTING_INVENTORY_VERSION + 1, T1 + 1000), false,
    '★★ 已有一行 ⇒ 任何版本号的第二次占位都失败(判据只有「有没有行」)');
  eq(readStartingInventoryGrant(db, P)?.version, 1,
    '★★ 已存的版本号**不被覆盖**(字面量 1;它记的是「他领的是哪一版」,是审计原料)');
  eq(countStartingInventoryGrants(db), 1, '台账没有被追加第二行');

  /* 2 换实例重进 ⇒ SKIPPED(而不是按版本补发);账里仍是那 7 件,不是 14。 */
  const g = makeRoom({ db });
  g.rt.join({ userId: P });
  eq(lastReport(g.rt).verdict, 'SKIPPED', '★ 版本号不是「补发开关」');
  eq(g.rt.authoritativeItemTotal(P), 0, '★ 一件都没补(补发是另一笔动作,不挂在入场上)');
});

/* ═════════════════ 11. 写库失败不留半态 ═════════════════ */

test('FND156-11 ★ 台账写库抛错 ⇒ FAILED + 账 0 件 + 零行;修复后仍能拿到', () => {
  /* 变红条件:删掉写库失败时的 `rollbackStartingInventory` ⇒ 断言 4/5 红
     (账里留下 7 件、而库里没有行 ⇒ 重启后又会发一份 = 半态)。 */
  const db = freshDb();
  patchInsert(db, (table, _row, real) => {
    if (table === STARTING_INVENTORY_TABLE) throw new Error('注入:台账写库抛(磁盘故障)');
    real();
  });
  const f = makeRoom({ db });
  const res = f.rt.join({ userId: P });
  eq(res.ok, true, '★ 入场本身成功(起始包失败不掀掉入场)');

  const rep = lastReport(f.rt);
  eq(rep.verdict, 'FAILED', '★ 如实 FAILED(不是「没发生」)');
  ok(String(rep.reason).includes('已整批撤回'), `理由说出已撤回(实得:${rep.reason})`);
  eq(f.rt.authoritativeItemTotal(P), 0, '★★ 账里一件都不留(不留半态)');
  eq(countStartingInventoryGrants(db), 0, '★★ 库里也没有行');
  eq(dbClaimedOf(f.rt).has(P), false, '★ 没写成功 ⇒ 不许记成「我们占的」');
  eq(memoryGrantedOf(f.rt).has(P), false, '★ 内存幂等账也解掉了 ⇒ 他还有资格拿到包');
  /* 修好之后(换一个干净的库,避开上面那个抛错的桩):这份包还是他的。 */
  const g = makeRoom({ db: freshDb() });
  const r2 = g.rt.join({ userId: P });
  eq(r2.ok, true, '前置:干净的库上入场成功');
  eq(lastReport(g.rt).verdict, 'GRANTED', '★ 修好后同名再进拿得到(资格没被吞掉)');
  eq(g.rt.authoritativeItemTotal(P), 7, '★ 完整的一份');
});

/* ═════════════════ 12. 入场失败 ⇒ 台账一并撤回 ═════════════════ */

test('FND156-12 ★ 入场中途失败 ⇒ 台账行一并撤回,重试仍能拿到(否则永远 SKIPPED)', () => {
  /* 变红条件:删掉 `releaseDbGrantIfOurs`(或让它删**别人**的行)⇒ 断言 3 红:
     库里那行留着 ⇒ 重试走闸 0 的 SKIPPED ⇒ 同名玩家**永远**拿不到起始包,且不报错。 */
  const db = freshDb();
  let breakNow = true;
  patchInsert(db, (table, _row, real) => {
    if (breakNow && table === 'room_players') throw new Error('注入:落库抛(入场中途失败)');
    real();
  });
  const f = makeRoom({ db });
  const res = f.rt.join({ userId: P });
  eq(res.ok, false, '★ 入场失败');
  eq(res.code, 'JOIN_FAILED', '走 JOIN_FAILED 通道');
  ok(String(res.reason).includes('起始背包已撤回'), `回执点名撤回(实得:${String(res.reason)})`);
  eq(countStartingInventoryGrants(db), 0, '★★ 台账行也撤了(库与账同时回到未发状态)');
  eq(f.rt.authoritativeItemTotal(P), 0, '★★ 账里 0 件');
  eq(dbClaimedOf(f.rt).has(P), false, '★ 撤回之后不再是「我们占的」');

  breakNow = false;
  const retry = f.rt.join({ userId: P });
  eq(retry.ok, true, '前置:修好后重试');
  eq(lastReport(f.rt).verdict, 'GRANTED', '★★ 重试拿得到(台账没把资格卡死)');
  eq(countStartingInventoryGrants(db), 1, '★ 重试后台账一行');
  eq(f.rt.authoritativeItemTotal(P), 7, '★★ 完整的一份');
});

/* ═════════════════ 13. 迁移漂移 ⇒ fail-closed ═════════════════ */

test('FND156-13 ★ 台账迁移 checksum 漂移 ⇒ 不发(fail-closed,零副作用)', () => {
  /* 变红条件:让 claim 忽略 `migration.drift` ⇒ 断言 2/3 红(漂移的库照发)。 */
  const db = freshDb();
  migrateStartingInventory(db, T0);
  eq(startingInventoryMigrationInstalled(db), true, '前置:台账迁移装好了');
  /* 把登记行改成「另一份 DDL」的 checksum ⇒ 结构说不清了。 */
  db.update('schema_migrations', { version: STARTING_INVENTORY_MIGRATION_VERSION }, { checksum: 'fnv1a:deadbeef' });

  const f = makeRoom({ db });
  const res = f.rt.join({ userId: P });
  eq(res.ok, true, '★ 入场照常(起始包 fail-closed 不等于入场失败)');
  const rep = lastReport(f.rt);
  eq(rep.verdict, 'FAILED', '★★ 漂移 ⇒ 不发(fail-closed)');
  ok(String(rep.reason).includes('漂移'), `理由点明漂移(实得:${rep.reason})`);
  eq(f.rt.authoritativeItemTotal(P), 0, '★★ 零副作用:账里一件都没有');
  eq(countStartingInventoryGrants(db), 0, '★★ 也不许往结构说不清的库里写行');
});

report('WS-FND-156');
