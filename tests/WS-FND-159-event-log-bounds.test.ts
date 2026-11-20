/**
 * WS-FND-159 —— `room_events` 的**有界保留 / 取号 / 读取上界 / WAL 阈值 / VACUUM**。
 *
 * ## 四处数据库侧的长跑问题(审计实测)
 * · P1 `room_events` 全仓没有任何 DELETE,而生产插入点是 `room.colyseus.ts:624`
 *      ⇒ 库文件单调涨(正常玩法≈0 条,作弊客户端可数千条/小时且永不清理);
 * · P1 事件 id 用 `Date.now() * 1000 + rand` ⇒ 同毫秒 >1000 条**撞主键**;
 * · P2 `nextEventId` 用整表 `select` 在 JS 里求 max ⇒ O(N)(接上写入后就是热点);
 * · P2 WAL 只设了 `journal_mode` / `synchronous` / `busy_timeout`,既无
 *      `wal_autocheckpoint`、也无 VACUUM(文件只涨不缩)。
 *
 * ## 判据纪律
 * · 行为判据优先:两种后端(`MemoryDb` 与 `node:sqlite`)都真写;
 * · 每条「有界」判据都配**负对照**(上限以内必须一行不动);
 * · 结构性判据(源码形态 / pragma 列表)一律做成**可注入的纯函数**:
 *   把旧形态喂进去 ⇒ 必须判出问题,而不是把当前源码抄一遍(抄一遍的判据
 *   在实现改坏时不会红)。
 *
 * 运行:`node tests/WS-FND-159-event-log-bounds.test.ts`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import {
  RECOMMENDED_PRAGMAS,
  VACUUM_FREELIST_PCT_THRESHOLD,
  WAL_AUTOCHECKPOINT_PAGES,
  maybeVacuum,
  openNodeSqlite,
} from '../server/src/db/driver.sqlite.ts';
import {
  ROOM_EVENT_LIST_FETCH_MAX,
  ROOM_EVENT_LIST_MAX,
  ROOM_EVENT_LIST_OVERFETCH,
  ROOM_EVENT_RETAIN_LOW_WATER,
  ROOM_EVENT_RETAIN_MAX,
  createRoom,
  createUser,
  eventIdRetryCount,
  listEvents,
  migrate,
  resetEventIdRetryCount,
  trimEvents,
  writeEvent,
  type DbLike,
} from '../server/src/db/repo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = 'r1';
const OTHER = 'r2';

/** 常量副本:断言里用**局部变量**而不是裸常量(裸常量会做成同义反复判据)。 */
const CHECKPOINT_PAGES: number = WAL_AUTOCHECKPOINT_PAGES;

/* ───────────────────────── 两个后端 ───────────────────────── */

/** 内存后端(`MemoryDb` + 真 DDL:约束/触发器/索引都真的被解析)。 */
function memDb(): DbLike {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: ROOM, ownerId: 'u1', nowMs: 1000 });
  createRoom(db, { id: OTHER, ownerId: 'u1', nowMs: 1000 });
  return db;
}

/** 真引擎后端(`node:sqlite`,零依赖)。 */
function sqlDb(): ReturnType<typeof openNodeSqlite> {
  const db = openNodeSqlite(':memory:');
  db.bootstrap(1000, false);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: ROOM, ownerId: 'u1', nowMs: 1000 });
  createRoom(db, { id: OTHER, ownerId: 'u1', nowMs: 1000 });
  return db;
}

/* ─────────────────── 观测用包装(不改变语义) ─────────────────── */

interface SelectCall {
  table: string;
  /** 下推给引擎的读取上界(`undefined` = 没有上界 ⇒ 整表读)。 */
  limit: number | undefined;
  /** **实际物化**的行数 —— 「读了几个」才是与库规模相关的那个量。 */
  rows: number;
}

/** 记录每次 `select` 的上界与物化行数。 */
function spy(db: DbLike): { db: DbLike; calls: SelectCall[] } {
  const calls: SelectCall[] = [];
  const wrapped: DbLike = {
    exec: (sql) => db.exec(sql),
    insert: (table, row) => db.insert(table, row),
    update: (table, key, patch) => db.update(table, key, patch),
    delete: (table, key) => db.delete(table, key),
    get: (table, key) => db.get(table, key),
    select: (table, where, limit, orderBy) => {
      const rows = db.select(table, where, limit, orderBy);
      calls.push({ table, limit, rows: rows.length });
      return rows;
    },
    count: (table) => db.count(table),
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },
  };
  return { db: wrapped, calls };
}

/** 旧的取号形态(整表 `select` + JS 求 max)—— **只**用于负对照。 */
function legacyNextEventId(db: DbLike): number {
  const rows = db.select('room_events');
  let maxId = 0;
  for (const r of rows) maxId = Math.max(maxId, Number(r.id) || 0);
  return maxId + 1;
}

/** 旧的 id 公式(`Date.now()*1000 + rand(0..999)`)的可复现替身。 */
function legacyEventId(nowMs: number, i: number): number {
  return nowMs * 1000 + ((i * 7919) % 1000);
}

/* ─────────────────── 结构性判据(可注入纯函数) ─────────────────── */

/** `RECOMMENDED_PRAGMAS` 的必备项(注掉/删掉任一项都要判红)。 */
function walProblems(pragmas: readonly string[]): string[] {
  const out: string[] = [];
  if (!pragmas.some((p) => /wal_autocheckpoint\s*=\s*\d+$/.test(p.trim()))) {
    out.push('缺 PRAGMA wal_autocheckpoint(检查点阈值交给引擎默认值)');
  }
  if (!pragmas.some((p) => /journal_mode\s*=\s*WAL/i.test(p))) out.push('缺 journal_mode = WAL');
  return out;
}

/**
 * 去掉注释后再查代码形态:判据不能命中**注释里**的示例片断
 * (`verify.ts` 有同款教训 —— 假阳性比漏报更快毁掉门禁)。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 生产插入点的形态判据(只看**可执行代码**)。 */
function wiringProblems(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  if (!/writeEvent\(\s*db,\s*this\.runtime\.id/.test(code)) {
    out.push('违规流水没有走 writeEvent(绕过了取号与有界保留)');
  }
  if (/Date\.now\(\)\s*\*\s*1000/.test(code)) {
    out.push('id 仍用 Date.now() * 1000(+rand):同毫秒 >1000 条会撞主键');
  }
  if (/\.insert\(\s*'room_events'/.test(code)) out.push("仍有裸 insert('room_events')");
  return out;
}

/** 旧插入点的原文(负对照用)。 */
const LEGACY_WIRING = [
  '        this.runtime.db?.insert(\'room_events\', {',
  '          id: Date.now() * 1000 + Math.floor(Math.random() * 1000),',
  '          room_id: this.runtime.id,',
  '        });',
].join('\n');

/* ═════════════════════════ 1. 有界保留(表规模) ═════════════════════════ */

test('FND159-1 ★ 写入超上限后表规模被削回(两种后端)', () => {
  const backends: { name: string; db: DbLike }[] = [
    { name: 'MemoryDb', db: memDb() },
    { name: 'node:sqlite', db: sqlDb() },
  ];
  const total = ROOM_EVENT_RETAIN_MAX + 900;
  for (const b of backends) {
    resetEventIdRetryCount();
    let trimmed = 0;
    for (let i = 0; i < total; i += 1) {
      trimmed += writeEvent(b.db, ROOM, i, 'K', 'u1', { i }, 9000).trimmed;
    }
    const size = b.db.count('room_events');
    ok(size <= ROOM_EVENT_RETAIN_MAX,
      `${b.name}:写 ${total} 条后表规模必须 ≤ 上限(实测 ${size},上限 ${ROOM_EVENT_RETAIN_MAX})`);
    ok(trimmed > 0, `${b.name}:超了上限却一行没删(trimmed=0)⇒ 保留根本没生效`);
    /* 删的是**最旧**的一批:id 最小 / tick 最小的一批必须已经不在了。 */
    const rest = b.db.select('room_events').map((r) => Number(r.tick));
    const minTick = Math.min(...rest);
    ok(minTick > 0, `${b.name}:trim 必须删最旧的(实测最小 tick 仍是 ${minTick})`);
    eq(Math.max(...rest), total - 1, `${b.name}:最新一条必须还在`);
    eq(eventIdRetryCount(), 0, `${b.name}:正常路径不该依赖取号重试兜底`);
  }
});

test('FND159-2 负对照:上限以内**一行都不删**', () => {
  /* 与 FND159-1 只差「写入总量没超过上限」—— 此时 trimmed 必须恒为 0,
     否则「有界」是靠「边写边乱删」凑出来的,历史会被无谓丢光。 */
  const db = memDb();
  const total = ROOM_EVENT_RETAIN_LOW_WATER;
  let trimmed = 0;
  for (let i = 0; i < total; i += 1) {
    trimmed += writeEvent(db, ROOM, i, 'K', 'u1', {}, i).trimmed;
  }
  eq(trimmed, 0, `未超上限时不该有任何 trim(实测 ${trimmed} 行被删)`);
  eq(db.count('room_events'), total, '未超上限时表规模必须精确等于写入条数');
});

/* ═════════════════════ 2. 同毫秒取号不撞主键 ═════════════════════ */

test('FND159-3 ★ 同毫秒 2000 条不撞主键(旧公式会撞)', () => {
  const db = memDb();
  resetEventIdRetryCount();
  const ids = new Set<number>();
  for (let i = 0; i < 2000; i += 1) {
    ids.add(writeEvent(db, ROOM, i, 'K', 'u1', {}, 1717000000000).id);
  }
  eq(ids.size, 2000, '同一毫秒写的 2000 条 id 必须互不相同');
  eq(db.count('room_events'), 2000, '2000 条都应落库(远在上限以内)');
  eq(eventIdRetryCount(), 0, '不该靠取号重试兜底(兜底会把碰撞吞掉)');
  /* 负对照:旧公式 `now*1000 + rand(0..999)` 按鸽笼原理必然重复。 */
  const legacy = new Set<number>();
  for (let i = 0; i < 2000; i += 1) legacy.add(legacyEventId(1717000000000, i));
  ok(legacy.size < 2000,
    `旧公式在同毫秒 2000 条下必须撞主键(实测唯一值 ${legacy.size})—— 否则本判据没有区分度`);
});

/* ═════════════════════ 3. 读取上界(listEvents) ═════════════════════ */

test('FND159-4 ★ listEvents 只读最近 N(窗口下推到引擎)', () => {
  const mem = memDb();
  for (let t = 1; t <= 60; t += 1) writeEvent(mem, ROOM, t, 'K', 'u1', {}, 1000 + t);
  writeEvent(mem, OTHER, 999, 'K', 'u1', {}, 2000);

  const s = spy(mem);
  const rows = listEvents(s.db, ROOM, 10);
  eq(rows.map((r) => Number(r.tick)), [60, 59, 58, 57, 56, 55, 54, 53, 52, 51],
    '返回的必须是**最近** 10 条(tick 最大的一批,别的房间不算)');
  const call = s.calls[s.calls.length - 1]!;
  eq(call.table, 'room_events', '读的是 room_events');
  ok(call.limit !== undefined,
    'listEvents 必须把读取上界下推给引擎(实测没有 limit ⇒ 整表读,房间历史多长就读多少行)');
  ok(call.limit! <= ROOM_EVENT_LIST_FETCH_MAX,
    `下推的读取上界必须 ≤ 硬上限(实测 ${call.limit} > ${ROOM_EVENT_LIST_FETCH_MAX})`);
  ok(call.rows <= call.limit!,
    `实际物化行数必须 ≤ 下推上界(实测 ${call.rows} > ${call.limit})`);

  /* 负对照:调用方要 10 万条 ⇒ 仍被夹住,读取量不放大。 */
  const big = spy(mem);
  const huge = listEvents(big.db, ROOM, 100000);
  ok(huge.length <= ROOM_EVENT_LIST_MAX,
    `返回条数必须被夹到 LIST_MAX 以内(实测 ${huge.length})`);
  const bigCall = big.calls[big.calls.length - 1]!;
  ok(bigCall.limit !== undefined && bigCall.limit <= ROOM_EVENT_LIST_FETCH_MAX,
    `「要 10 万条」不得把读取量放大(实测 limit=${bigCall.limit})`);
});

/* ═════════════════════ 4. trim 幂等 ═════════════════════ */

test('FND159-5 ★ trim 幂等:未超上限 ⇒ 0 且一行不动', () => {
  const db = memDb();
  for (let i = 0; i < 100; i += 1) writeEvent(db, ROOM, i, 'K', 'u1', {}, i);
  eq(db.count('room_events'), 100, '前置:100 条');
  eq(trimEvents(db), 0, '未超上限 trim 必须返回 0');
  eq(trimEvents(db), 0, '再调一次仍是 0(幂等)');
  eq(db.count('room_events'), 100, '幂等:表规模一点不动');

  /* 超上限之后:自动 trim 生效,随后的显式 trim 必须是 0(已削到低水位)。 */
  for (let i = 0; i < ROOM_EVENT_RETAIN_MAX + 200; i += 1) {
    writeEvent(db, ROOM, 1000 + i, 'K', 'u1', {}, 1000 + i);
  }
  const size = db.count('room_events');
  ok(size <= ROOM_EVENT_RETAIN_MAX, `写入后规模必须 ≤ 上限(实测 ${size})`);
  eq(trimEvents(db), 0, '已上限内 ⇒ 显式 trim 仍返回 0');
  eq(db.count('room_events'), size, '幂等:规模不变');
});

/* ═════════════════════ 5. 具名常量的关系 ═════════════════════ */

test('FND159-6 具名常量:低水位 < 上限;过取不超硬上限;检查点≠引擎默认', () => {
  ok(ROOM_EVENT_RETAIN_LOW_WATER > 0 && ROOM_EVENT_RETAIN_LOW_WATER < ROOM_EVENT_RETAIN_MAX,
    `低水位必须 (0, 上限) 之间(实测 ${ROOM_EVENT_RETAIN_LOW_WATER} vs ${ROOM_EVENT_RETAIN_MAX})`
    + ' —— 否则每写一条都要删一次');
  ok(ROOM_EVENT_LIST_MAX > 0 && ROOM_EVENT_LIST_OVERFETCH >= 1,
    '读取上限与过取倍率都必须 ≥ 1');
  ok(ROOM_EVENT_LIST_MAX * ROOM_EVENT_LIST_OVERFETCH <= ROOM_EVENT_LIST_FETCH_MAX,
    '过取后的窗口必须被硬上限封住(否则过取会变成无界读)');
  ok(CHECKPOINT_PAGES > 0 && CHECKPOINT_PAGES !== 1000,
    `检查点阈值必须 > 0 且 ≠ 引擎默认 1000(实测 ${CHECKPOINT_PAGES})—— 等于默认值时判据没有区分度`);
  ok(VACUUM_FREELIST_PCT_THRESHOLD > 0 && VACUUM_FREELIST_PCT_THRESHOLD < 100,
    'VACUUM 阈值必须在 (0, 100) 之间');
});

/* ═════════════════════ 6. WAL 阈值真的生效 ═════════════════════ */

test('FND159-7 ★ wal_autocheckpoint 生效(真引擎读回 == 常量;负对照:删掉那行即判红)', () => {
  eq(walProblems(RECOMMENDED_PRAGMAS), [],
    `RECOMMENDED_PRAGMAS 必须显式设检查点阈值(实测问题:${walProblems(RECOMMENDED_PRAGMAS).join(' / ')})`);
  const without = RECOMMENDED_PRAGMAS.filter((p) => !/wal_autocheckpoint/.test(p));
  ok(walProblems(without).length >= 1,
    '负对照:去掉 wal_autocheckpoint 那行后必须判出问题(否则判据只是把源码抄了一遍)');

  /* 构造函数按 RECOMMENDED_PRAGMAS 逐条 exec ⇒ 真引擎应读回同一个数。 */
  const db = openNodeSqlite(':memory:');
  try {
    const row = db.raw<Record<string, unknown>>('PRAGMA wal_autocheckpoint', [])[0]!;
    const back: number = Number(row.wal_autocheckpoint);
    eq(back, CHECKPOINT_PAGES, '真引擎读回的检查点阈值必须等于本仓常量');
    ok(back !== 1000, '负对照:读回值不能恰好是引擎默认值 1000(否则「设置生效」无从判定)');
  } finally {
    db.close();
  }
});

/* ═════════════════════ 7. VACUUM 阈值 ═════════════════════ */

test('FND159-8 ★ 超阈值才 VACUUM:空库不跑、真删过才重写', () => {
  const db = sqlDb();
  try {
    /* 启动期维护位:新库没东西可回收 ⇒ 不该整库重写。 */
    const boot = db.lastVacuum;
    ok(boot !== null, 'bootstrap 必须留下启动期维护的结果(不能默默没做)');
    eq(boot!.ran, false, '新库启动期不该 VACUUM(整库重写很贵)');
    ok(boot!.reason === 'empty' || boot!.reason === 'under-threshold',
      `新库的原因应是「没东西可回收」(实测 ${boot!.reason})`);

    const pad = 'x'.repeat(120);
    for (let i = 0; i < 4000; i += 1) writeEvent(db, ROOM, i, 'K', 'u1', { pad }, i);
    /* 一次性删掉 3000 行,之后**不再插入** ⇒ 空页不会被复用(freelist 才留得住)。 */
    const victims = db.select('room_events', undefined, 3000, { column: 'id', dir: 'asc' });
    for (const r of victims) db.delete('room_events', { id: Number(r.id) });

    const pagesBefore = Number(db.raw<Record<string, unknown>>('PRAGMA page_count', [])[0]!.page_count);
    const rep = maybeVacuum(db);
    ok(rep.freePages > 0, `前置:删过 3000 行应留下空闲页(实测 ${rep.freePages})`);
    ok(rep.freePct >= VACUUM_FREELIST_PCT_THRESHOLD,
      `前置:空闲占比应达到阈值(实测 ${rep.freePct.toFixed(1)}% < ${VACUUM_FREELIST_PCT_THRESHOLD}%)`);
    eq(rep.ran, true, '超过阈值必须真的 VACUUM');
    eq(rep.reason, 'ok', '成功路径的 reason 必须是 ok');
    const pagesAfter = Number(db.raw<Record<string, unknown>>('PRAGMA page_count', [])[0]!.page_count);
    ok(pagesAfter < pagesBefore, `VACUUM 后库页数必须下降(${pagesBefore} → ${pagesAfter})`);
    eq(Number(db.raw<Record<string, unknown>>('PRAGMA freelist_count', [])[0]!.freelist_count), 0,
      'VACUUM 后不该再有空闲页');

    /* 负对照:阈值调到 100 ⇒ 不跑(证明判据真的看阈值,而不是每次都 VACUUM)。 */
    const dry = maybeVacuum(db, 100);
    eq(dry.ran, false, '负对照:阈值 100 时不该 VACUUM');
    eq(dry.reason, 'under-threshold', '负对照的原因必须是「没到阈值」');
  } finally {
    db.close();
  }
});

/* ═════════════════════ 8. 取号不再全表读 ═════════════════════ */

test('FND159-9 ★ nextEventId 只读 1 行(旧的全表取数会被测出来)', () => {
  const mem = memDb();
  for (let i = 0; i < 50; i += 1) writeEvent(mem, ROOM, i, 'K', 'u1', {}, i);

  const s = spy(mem);
  resetEventIdRetryCount();
  writeEvent(s.db, ROOM, 999, 'K', 'u1', {}, 999);
  const idCall = s.calls[0]!;
  eq(idCall.table, 'room_events', '写入路径的第一步是取号(读 room_events)');
  eq(idCall.limit, 1, '取号必须只读 1 行(limit=1,落在主键索引上)');
  ok(idCall.rows <= 1, `取号物化行数必须 ≤ 1(实测 ${idCall.rows} ⇒ 还在整表读)`);
  eq(eventIdRetryCount(), 0, '取号不该触发兜底重试');

  /* 负对照:旧实现在**同一张表**上把 51 行全部取回 JS 求 max。 */
  const legacy = spy(mem);
  legacyNextEventId(legacy.db);
  const old = legacy.calls[0]!;
  eq(old.limit, undefined, '负对照:旧形态没有读取上界');
  ok(old.rows > 1, `负对照:旧形态必须把整表取回(实测 ${old.rows} 行)—— 否则判据没有区分度`);
});

/* ═════════════════════ 9. 生产插入点 ═════════════════════ */

test('FND159-10 ★ 生产插入点走 writeEvent(负对照:旧片段必须判出 ≥2 个问题)', () => {
  const src = readFileSync(join(HERE, '..', 'server/src/net', 'room.colyseus.ts'), 'utf8');
  eq(wiringProblems(src), [],
    `违规流水必须走 writeEvent(实测问题:${wiringProblems(src).join(' / ')})`);
  const legacy = wiringProblems(LEGACY_WIRING);
  ok(legacy.length >= 2,
    `负对照:旧插入点片段必须被判出 ≥2 个问题(实测 ${legacy.length}:${legacy.join(' / ')})`);
});

report('WS-FND-159-event-log-bounds');