/**
 * WS-FND-171 —— **非房主 join 的真库外键闭环**(P0:`room_players.user_id` 指向没有的 `users` 行)。
 *
 * ## 被真长跑夹具抓到的形态(文件库)
 * ```text
 * room.ts:2797  upsertRoomPlayer(db, ...)   →   repo.ts 的 INSERT room_players
 * schema.sql:131 FOREIGN KEY (user_id) REFERENCES users(id)
 * driver.sqlite.ts:505  PRAGMA foreign_keys = ON
 * ⇒ 库里没有该 id 的 users 行 ⇒ FOREIGN KEY constraint failed ⇒ 整个入场回滚
 *   收执:JOIN_FAILED:加入失败(已回滚...):FOREIGN KEY constraint failed
 * ```
 * `room.join()` **自己从不建号**(只有 `bootstrap()` / `assemble()` 建房主),
 * ⇒ 「非房主第一次进房」在生产(真库)上必然失败。
 *
 * ## 为什么既有测试全绿(这一条比缺陷本身更重要)
 * 全仓 join 夹具**都先 `createUser` 了要进房的那个 id**(例:
 * `tests/WS-FND-156-crossproc-idempotency.test.ts:98` 的 `createUser(db, { id: P })`,
 * 注释还写着「room_players.user_id 是真外键」)—— 于是**外键从来没被真正压到过**:
 * 判据测的是「夹具已经把前提摆好了的世界」,不是生产里那条路径。
 * ⇒ 本套件**不放这种前提**:非房主的 `users` 行必须由被测路径自己产生。
 *
 * ## 判据(10 条;≥8 条硬要求)
 * ```text
 * FND171-1  真库连接上 `PRAGMA foreign_keys` = 1,且**关掉后同一条写入就不再抛**
 *             —— 负对照证明「1」这个读数不是恒真装饰
 * FND171-2  ★ 负对照(判据有牙):绕过 repo 直插 room_players,指向不存在的 user ⇒ 抛 FOREIGN KEY
 * FND171-3  ★★ 生产路径(assemble + 真文件库):**非房主首次 join 成功**(不是 JOIN_FAILED)
 * FND171-4  ★★ join 之后两表行数:`users` 含新号、`room_players` 恰好 1 行(role/joined_at 落地)
 * FND171-5  ★★ 同一玩家二次 join 幂等:仍 1 行、users 行数不变、joined_at 不被改写
 * FND171-6  ★  房主 join 仍正常(role=OWNER,users 不重复建号)
 * FND171-7  ★  guest 入口(asGuest)同样补号(role=GUEST)
 * FND171-8  ★  仓储层自证:空白库上直接 `upsertRoomPlayer` 补号 + 落行(不依赖调用方顺序)
 * FND171-9  ★  改角色那条 update 分支不重复建号(幂等,joined_at 保留)
 * FND171-10 ★  MemoryDb 同判据(两个后端都抛裸插、都接受补号后的 upsert)+ 重开库后行数不变
 * ```
 *
 * ## 怎么变红(每条都指向一个注入点)
 * ```text
 * FND171-1  驱动删掉 RECOMMENDED_PRAGMAS 里的 foreign_keys = ON ⇒ 1/2 红
 * FND171-2  删掉 schema.sql:131 的 FOREIGN KEY(user_id) ⇒ 断言 2 红(裸插不再抛)
 * FND171-3  把 repo.ensureUserRow 删掉 ⇒ 3/4/6/7/8/9 红(回到 JOIN_FAILED)
 * FND171-4  让 ensureUserRow 只在 insert 分支调 ⇒ 9 红(update 分支的前提不再自证)
 * FND171-5  让 upsertRoomPlayer 无条件 createUser(不先 getUser)⇒ 8/9 红(主键冲突)
 * FND171-10 只修真库不修仓储层(或反之)⇒ 10 红(两端行数不同)
 * ```
 *
 * 运行:`node tests/WS-FND-171-join-fk.test.ts`
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import type { RoomRuntime } from '../server/src/net/room.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { RECOMMENDED_PRAGMAS, openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  RoomRole,
  createRoom,
  createUser,
  getUser,
  migrate,
  upsertRoomPlayer,
  type DbLike,
} from '../server/src/db/repo.ts';

/* ═══════════════════════ 0. 夹具(真文件库)═══════════════════════ */

const T0 = 1_700_000_000_000;
const OWNER = 'u_owner_171';
const GUEST = 'u_guest_171';
const AS_GUEST = 'u_asguest_171';
const REPO_ONLY = 'u_repoonly_171';
const GHOST = 'u_ghost_171';
const ROOM = 'room_fk_171';

/*
 * 临时目录刻意放在仓内 `./.data/`(与 WS-FND-150 同款):判据要的是「真的落在磁盘上」,
 * 系统 tmp 的同名文件证明不了「库被开到哪」。`*.db` 已 gitignore。
 */
const TMP_ROOT = ((): string => {
  const dir = join(process.cwd(), '.data', `wsfnd171-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
})();

let dbSeq = 0;
function freshDbPath(): string {
  dbSeq += 1;
  return join(TMP_ROOT, `fk_${dbSeq}.db`);
}

/** 本套件开过的库句柄(只为收尾服务:Windows 上不关句柄就删不掉 `.db`)。 */
const OPEN_DBS: DbLike[] = [];

/**
 * 生产装配:真文件库 + 真房间(`scripts/soak.ts` 的同一行 `assemble`)。
 *
 * `dbPath` + 不注入 `db` ⇒ 装配层按裁决调 `ensureOwnerUser`(房主有号),
 * 而**要进房的非房主一个都不预先建** —— 那正是本套件要压的那条路径。
 */
function boot(path: string): { runtime: RoomRuntime; db: DbLike; path: string } {
  const a = assemble({
    roomId: ROOM,
    ownerId: OWNER,
    clock: { nowMs: () => T0 },
    sizeCells: 8,
    /* 本套件不测生物 AI:关掉,免得刷怪干扰行数断言。 */
    mobs: false,
    dbPath: path,
  });
  const db = a.runtime.db;
  ok(db !== null, `夹具:dbPath=${path} 时应开真文件库`);
  OPEN_DBS.push(db as DbLike);
  return { runtime: a.runtime, db: db as DbLike, path };
}

/**
 * **共享**的文件库夹具(FND171-3 … FND171-7 是同一条入场序列的连续判据)。
 *
 * harness 的 `test()` 按定义顺序**同步**执行,故这些判据看到的是同一条世界线 ——
 * 每一步都先断言**前置行数**,失败时能看清断在哪一步(而不是一个孤立的数字)。
 */
let sharedFx: { runtime: RoomRuntime; db: DbLike; path: string } | null = null;
function fx(): { runtime: RoomRuntime; db: DbLike; path: string } {
  if (sharedFx === null) sharedFx = boot(freshDbPath());
  return sharedFx;
}

/** 一个**只有房主**的真文件库(不装配世界:给仓储层判据用,便宜且直白)。 */
function plainFileDb(): DbLike & { bootstrap(nowMs: number): void } {
  const db = openNodeSqlite(freshDbPath());
  db.bootstrap(T0);
  createUser(db, { id: OWNER, displayName: '房主', nowMs: T0 });
  createRoom(db, { id: ROOM, ownerId: OWNER, nowMs: T0 });
  OPEN_DBS.push(db);
  return db;
}

/** 一行 `room_players`(显式列齐,便于「只差 users 行」这一条负对照)。 */
function playerRow(userId: string, role: string): Record<string, unknown> {
  return {
    room_id: ROOM,
    user_id: userId,
    role,
    snapshot_blob: null,
    joined_at: T0,
    last_seen_at: T0,
  };
}

/**
 * 读连接级 `PRAGMA foreign_keys`(1 = 开)。
 *
 * 只借驱动的**自省形状**(`SqliteDb.raw` 的签名),不 import 那个具体类:本套件的
 * 被测对象是「入场写库」,不是驱动自身 —— 写成结构化 cast 可避免把
 * 「驱动类获得行为覆盖」这条账错记到本套件上(那会翻 `docs/COVERAGE-MATRIX.md` 的档)。
 */
function readForeignKeys(db: DbLike): number {
  const rows = (db as unknown as { raw<T>(sql: string): T[] })
    .raw<{ foreign_keys: number }>('PRAGMA foreign_keys');
  return Number(rows[0]?.foreign_keys ?? -1);
}

/* ═══════════════════ 1. 真库的闸真的开着(负对照有牙)═══════════════════ */

test('FND171-1 真文件库连接上 `PRAGMA foreign_keys` = 1,且关掉后同一条写入就不再被拦', () => {
  const { db } = boot(freshDbPath());
  /* 外键是**连接级**开关:`= 1` 这个读数必须是真的(见 `readForeignKeys` 的说明)。 */
  const pragma = readForeignKeys(db);
  eq(pragma, 1, '★ 连接上必须真的开着外键(否则本套件的判据全部恒真)');
  ok(
    RECOMMENDED_PRAGMAS.includes('PRAGMA foreign_keys = ON'),
    '驱动常量里必须列着这条 PRAGMA(装配期接线与判据同源)',
  );

  /* 负对照:「= 1」这个读数**不是**装饰 —— 同一连接上关掉,同一条写入就通过了。
     (库上那条 FK 仍在 DDL 里,变的只是连接级开关 ⇒ 抛错确实来自它。) */
  let threwWithOn = false;
  try {
    db.insert('room_players', playerRow(GHOST, 'MEMBER'));
  } catch (e) {
    threwWithOn = /FOREIGN KEY/.test((e as Error).message);
  }
  ok(threwWithOn, '★ 开着外键时:指向不存在 users 行的子行必须抛 FOREIGN KEY');

  db.exec('PRAGMA foreign_keys = 0');
  let threwWithOff = false;
  try {
    db.insert('room_players', playerRow(`${GHOST}_off`, 'MEMBER'));
  } catch {
    threwWithOff = true;
  }
  eq(threwWithOff, false, '★ 关掉外键后同一条写入必须通过(证明上面那次抛错来自外键闸)');
  db.exec('PRAGMA foreign_keys = ON'); /* 复位:后续判据仍需真闸 */
  eq(readForeignKeys(db), 1, '复位后外键应重新打开');

  /* 把负对照写下的两行清掉(它们不参与后续判据,但留库里会让「行数」类判据无法呼吸)。 */
  db.delete('room_players', { room_id: ROOM, user_id: `${GHOST}_off` });
  eq(db.count('room_players'), 0, '收尾:负对照写在库里的行已清干净');
});

test('FND171-2 ★ 负对照(判据有牙):不建 users 行裸插 room_players 必须抛 FK;补上后同一句成功', () => {
  const db = plainFileDb();
  const row = playerRow(GHOST, 'MEMBER');

  let msg = '';
  try {
    db.insert('room_players', row);
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(msg.includes('FOREIGN KEY constraint failed'), `★ 缺 users 行必须抛 FK(实得:${msg || '未抛'})`);
  eq(db.count('room_players'), 0, '被拒后不留半行');

  /* 正面对照:同一句 SQL,只把父行补上 ⇒ 必须通过。
     两次只差一个变量(users 行在不在)⇒ 上面那次抛错确实由外键引起。 */
  createUser(db, { id: GHOST, displayName: GHOST, nowMs: T0 });
  db.insert('room_players', row);
  eq(db.count('room_players'), 1, '父行补上后同一句必须落行');
});

/* ═══════════════════ 2. 生产路径:非房主首次 join ═══════════════════ */

test('FND171-3 ★★ 真文件库 + assemble:非房主**首次** join 必须成功(不是 JOIN_FAILED)', () => {
  const { runtime, db } = fx();
  eq(db.count('users'), 1, '前置:库里只有房主一个 users 行(要进房的人**没有**预注册)');
  eq(db.count('room_players'), 0, '前置:还没有任何席位行');

  const res = runtime.join({ userId: GUEST });
  ok(res.ok, `★ 非房主首次 join 必须成功(实得:${res.ok ? 'ok' : `${res.code}:${res.reason}`})`);
  eq(res.role, RoomRole.MEMBER, '非房主默认角色 = MEMBER');
  ok(
    res.reason === undefined || !res.reason.includes('FOREIGN KEY'),
    '回执里不许再出现 FOREIGN KEY(修前正是它)',
  );

  /* 三方交叉校验(`auditJoin`):members 与 state 两侧都认这个人 —— 证明入场真的走完了
     2797 那一步之后的成功路径,而不是在更早的地方被「放过」。 */
  eq(runtime.lastJoinAudit?.userId, GUEST, '审计面向的是刚进来的那个人');
  eq(runtime.lastJoinAudit?.members, true, '★ members 侧认他');
  eq(runtime.lastJoinAudit?.state, true, '★ state 侧认他');
});

test('FND171-4 ★★ join 之后两表行数正确:`users` 补出新号、`room_players` 恰好 1 行', () => {
  const { runtime, db } = fx();
  eq(db.count('users'), 2, '★ join 后 users 必须有那个人的行(修前这里是 1 —— 而 join 直接失败)');
  eq(db.count('room_players'), 1, '★ 成员表恰好 1 行(不重复、也没有幽灵席位)');

  const row = db.get('room_players', { room_id: ROOM, user_id: GUEST });
  eq(row?.role, RoomRole.MEMBER, '落地的角色 = MEMBER');
  eq(row?.joined_at, T0, 'joined_at = 入场时刻');
  eq(row?.last_seen_at, T0, 'last_seen_at = 入场时刻');
  ok(row?.snapshot_blob instanceof Uint8Array, '重连快照随之落地(首帧快照)');

  const u = getUser(db, GUEST);
  eq(u?.display_name, GUEST, '就地补的 users 行显示名取 id(与 `ensureOwnerUser` 同款)');
  eq(u?.level, 1, '新号按 createUser 的默认值(level=1)');
  eq(runtime.members.get(GUEST)?.connected, true, '房间侧席位在线');
});

test('FND171-5 ★★ 同一玩家二次 join 幂等:仍 1 行、users 不增、joined_at 不被改写', () => {
  const { runtime, db } = fx();
  const before = db.get('room_players', { room_id: ROOM, user_id: GUEST });
  eq(db.count('room_players'), 1, '前置:1 行');
  eq(db.count('users'), 2, '前置:2 个 users');

  /* 先真的掉线再进 ⇒ 走**重连路径**(与生产里「刷新页面 / 断线重连」同一条路)。 */
  eq(runtime.disconnect(GUEST), true, '夹具:把该玩家标成掉线(仍在宽限期内)');

  const res = runtime.join({ userId: GUEST });
  ok(res.ok, `★ 二次 join 必须成功(实得:${res.ok ? 'ok' : `${res.code}:${res.reason}`})`);
  eq(res.resumed, true, '第二条 join 走重连路径(resumed),不是新席位');

  eq(db.count('room_players'), 1, '★ 仍 1 行(幂等:主键 (room_id, user_id) 不重复插)');
  eq(db.count('users'), 2, '★ users 行数不变(没有重复建号 ⇒ 没有主键冲突)');
  const after = db.get('room_players', { room_id: ROOM, user_id: GUEST });
  eq(after?.joined_at, before?.joined_at, 'joined_at 是首次入场时刻,不被二次 join 改写');
  eq(after?.role, RoomRole.MEMBER, '角色不变');
});

test('FND171-6 ★ 房主 join 仍正常:role=OWNER,且**不**重复建号', () => {
  const { runtime, db } = fx();
  const usersBefore = db.count('users');
  const res = runtime.join({ userId: OWNER });
  ok(res.ok, `★ 房主 join 必须成功(实得:${res.ok ? 'ok' : `${res.code}:${res.reason}`})`);
  eq(res.role, RoomRole.OWNER, '房主恒为 OWNER');

  eq(db.count('users'), usersBefore, '★ users 行数不变(房主已有号 ⇒ ensureUserRow 直接返回)');
  eq(db.count('room_players'), 2, '房主也有一条席位行(共 2 行)');
  eq(db.get('room_players', { room_id: ROOM, user_id: OWNER })?.role, RoomRole.OWNER, '房主席位角色落地');
});

test('FND171-7 ★ guest 入口(asGuest)同样补号:role=GUEST 且 users 里查得到他', () => {
  const { runtime, db } = fx();
  eq(getUser(db, AS_GUEST), undefined, '前置:访客没有 users 行');
  const res = runtime.join({ userId: AS_GUEST, asGuest: true });
  ok(res.ok, `★ 访客首次 join 必须成功(实得:${res.ok ? 'ok' : `${res.code}:${res.reason}`})`);
  eq(res.role, RoomRole.GUEST, 'asGuest ⇒ GUEST');
  eq(getUser(db, AS_GUEST) !== undefined, true, '★ 访客也被补了 users 行(否则 FK 会拒这次 join)');
  eq(db.count('room_players'), 3, '三条席位(房主 + 成员 + 访客)');
});

/* ═══════════════════ 3. 仓储层自证(不依赖调用方顺序)═══════════════════ */

test('FND171-8 ★ 空白库上直接 `upsertRoomPlayer` 必须自己补父行(仓储层不要求调用方先建号)', () => {
  const db = plainFileDb();
  eq(db.count('users'), 1, '前置:只有房主');
  let msg = '';
  try {
    upsertRoomPlayer(db, ROOM, REPO_ONLY, RoomRole.MEMBER, T0);
  } catch (e) {
    msg = (e as Error).message;
  }
  eq(msg, '', `★ upsertRoomPlayer 不该要求调用方先建号(实得抛:${msg})`);
  eq(getUser(db, REPO_ONLY) !== undefined, true, '★ users 行被就地补上');
  eq(getUser(db, REPO_ONLY)?.display_name, REPO_ONLY, '补出来的显示名 = id');
  eq(db.count('room_players'), 1, 'room_players 落了 1 行');
  eq(db.get('room_players', { room_id: ROOM, user_id: REPO_ONLY })?.role, RoomRole.MEMBER, '角色落地');
});

test('FND171-9 ★ 改角色(update 分支)不重复建号:行数不变、role 改写、joined_at 保留', () => {
  const db = plainFileDb();
  upsertRoomPlayer(db, ROOM, REPO_ONLY, RoomRole.MEMBER, T0);
  eq(db.count('users'), 2, '前置:补号后 2 个 users');
  eq(db.count('room_players'), 1, '前置:1 行');

  /* 同一入口、同一个 id、不同角色 ⇒ 走 update 分支(仍是「父行先于子行」那条闸)。 */
  upsertRoomPlayer(db, ROOM, REPO_ONLY, RoomRole.ADMIN, T0 + 5);
  eq(db.count('users'), 2, '★ users 行数不变(重复建号会撞主键 ⇒ 这条能抓住「无条件 createUser」的写法)');
  eq(db.count('room_players'), 1, '★ room_players 仍 1 行');
  const row = db.get('room_players', { room_id: ROOM, user_id: REPO_ONLY });
  eq(row?.role, RoomRole.ADMIN, '角色被改写');
  eq(row?.joined_at, T0, 'joined_at 保留首次入场时刻');
  eq(row?.last_seen_at, T0 + 5, 'last_seen_at 推进');

  /* 第三条:换一个**从未见过**的 id 再走一次 ⇒ 仍必须自己补号(不是「第一次特例」)。 */
  upsertRoomPlayer(db, ROOM, `${REPO_ONLY}_2`, RoomRole.GUEST, T0 + 6);
  eq(getUser(db, `${REPO_ONLY}_2`) !== undefined, true, '★ 每个新 id 都补号(不是只对第一个生效)');
  eq(db.count('users'), 3, '三个 users');
  eq(db.count('room_players'), 2, '两行席位');
});

/* ═══════════════════ 4. 两个后端 + 重开库,行真的在盘上 ═══════════════════ */

test('FND171-10 ★ 双后端同判据(裸插两边都抛、补号后的 upsert 两边都落行)+ 重开文件库行数不变', () => {
  /* 4.1 MemoryDb:与真库**同一条判据**(不是「内存宽一档」)。
     ⚠️ 实测口径:`MemoryDb` 自 `memory_db.ts:328-340`(FK 表 `:41`)起**也**判外键 ——
        既有 join 夹具全绿的原因是它们**先建号**,不是内存后端漏判。 */
  const mem = new MemoryDb();
  migrate(mem, T0);
  createUser(mem, { id: OWNER, displayName: OWNER, nowMs: T0 });
  createRoom(mem, { id: ROOM, ownerId: OWNER, nowMs: T0 });
  let memThrew = false;
  try {
    mem.insert('room_players', playerRow(GHOST, 'MEMBER'));
  } catch {
    memThrew = true;
  }
  ok(memThrew, 'MemoryDb 对缺父行同样抛(与真库同判据,不是「内存不判」)');
  upsertRoomPlayer(mem, ROOM, GHOST, RoomRole.MEMBER, T0);
  eq(mem.count('room_players'), 1, 'MemoryDb:补号后 upsert 落行');
  eq(mem.count('users'), 2, 'MemoryDb:users 被就地补上');

  /* 4.2 真文件库:关句柄 → 重开同一个文件 ⇒ 行数不变(join 写的是**真库**,不是内存假象)。 */
  const { db, path } = fx();
  const usersOnDisk = db.count('users');
  const seatsOnDisk = db.count('room_players');
  eq(usersOnDisk, 3, '前置(共享夹具收尾):3 个 users 已落盘');
  eq(seatsOnDisk, 3, '前置:3 条席位已落盘');

  (db as unknown as { close?: () => void }).close?.();
  const reopened = openNodeSqlite(path);
  try {
    eq(reopened.count('users'), usersOnDisk, '★ 重开同一个文件:users 行数一致');
    eq(reopened.count('room_players'), seatsOnDisk, '★ 重开同一个文件:席位行数一致');
    ok(getUser(reopened, GUEST) !== undefined, '★ 非房主的 users 行真的在盘上(不是只活在内存里)');
    ok(
      getUser(reopened, AS_GUEST) !== undefined,
      '★ 访客的 users 行也在盘上(第二条入口同样落地)',
    );
  } finally {
    reopened.close();
  }
});

/* ── 收尾:尽力而为(Windows 上句柄不关就删不动)── */
for (const db of OPEN_DBS) {
  try {
    (db as unknown as { close?: () => void }).close?.();
  } catch {
    /* 已关 / 内存库无 close */
  }
}
try {
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  /* 句柄仍在:不影响判据 */
}

report('WS-FND-171');
