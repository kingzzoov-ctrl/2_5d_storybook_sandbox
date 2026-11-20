/**
 * WS-07 · SQL 驱动(`DbLike` → 真实 SQL)。**零外部依赖路径可用。**
 *
 * ## 结构:一份 SQL 翻译 + 两个薄适配器
 *
 * ```
 *   repo.ts (仓储逻辑,零依赖)
 *        │  DbLike: insert/update/delete/get/select/count/transaction
 *        ▼
 *   SqliteDb          ← 全部 SQL 生成、白名单、绑参、BLOB 转换都在这里(唯一实现点)
 *        │  SqlConnection: exec/all/get/run/transaction/pragma
 *        ├──────────────┬──────────────────────┐
 *        ▼              ▼                      ▼
 *   better-sqlite3   node:sqlite          测试内存桩
 *   (optionalDep)    (Node 内置,零依赖)
 * ```
 *
 * ## 为什么要把连接抽出来(而不是保留 `Database` 直连)
 *
 * 本文件原来直接持有 `better-sqlite3` 的 `Database`,于是有 169 行 SQL 逻辑
 * **一行都没被执行过** —— 因为 `better-sqlite3` 是 `optionalDependency`,
 * 默认不装,而所有测试都走 `memory_db.ts`。
 * 文件头那句「换驱动只需再写一个同接口实现」也就从未被验证:
 * 没有任何证据表明这个接缝真的够窄。
 *
 * 抽出 `SqlConnection` 之后,`node:sqlite`(**Node 24 内置**)可以驱动同一份
 * SQL 翻译逻辑,于是:
 *   * 那 169 行在测试里真的跑起来了;
 *   * 「换驱动只需薄适配器」从注释变成**可测量的事实**(适配器约 40 行);
 *   * 生产部署不装 `better-sqlite3` 也能跑,只少一些性能与 WAL 调优。
 *
 * 实测两引擎的 API 差异(这就是适配器必须吸收的全部):
 *
 * | 能力 | better-sqlite3 | node:sqlite |
 * | :--- | :--- | :--- |
 * | 设 PRAGMA | `db.pragma('...')` | 只能 `db.exec('PRAGMA ...')` |
 * | 事务 | `db.transaction(fn)` | 无,需手写 BEGIN/COMMIT/ROLLBACK |
 * | BLOB 读回 | `Buffer` | `Uint8Array` |
 * | 绑 `boolean`/`undefined` | 报错 | 报错 |
 *
 * 注意 `import type { Database } from 'better-sqlite3'` 是**类型导入**,
 * 运行时被擦除 —— 所以本文件在没有装该包时照样能被 import。
 */

import type { Database } from 'better-sqlite3';
import {
  TABLE_PRIMARY_KEYS,
  migrate,
  migrateStartingInventoryIfInstalled,
  /* ★ WS-FND-165:房间系统台账(结算幂等键集)的启动漂移检查 —— 与上面两段同一处置。 */
  migrateRoomSystemsIfInstalled,
  type RoomSystemsBootCheck,
  migrateWorldArchives,
  migrateWorldArchivesIfInstalled,
  schemaSqlPath,
  type DbLike,
  type KeyParts,
  type OrderBy,
  type Row,
  type StartingInventoryBootCheck,
  type WorldArchiveBootCheck,
} from './repo.ts';

/** 允许出现的表名白名单 —— 表名不能被绑参,只能白名单。 */
const ALLOWED_TABLES = new Set(Object.keys(TABLE_PRIMARY_KEYS));

function assertTable(table: string): void {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`未登记的表名:${table}`);
}

/** 列名白名单:只允许 `[a-z_][a-z0-9_]*`,表名以外的标识符一律非法。 */
function assertColumn(col: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(col)) throw new Error(`非法列名:${col}`);
}

function toSqlValue(v: unknown): unknown {
  /* Uint8Array / Buffer 都能被两个引擎接受,不必再包一层 Buffer.from ——
     后者会把 node:sqlite 的入参类型收窄到 Buffer,徒增耦合。 */
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function fromSqlValue(v: unknown): unknown {
  /* better-sqlite3 给 Buffer,node:sqlite 给 Uint8Array —— 统一成 Uint8Array,
     与 `packChunkBlob`/`assertChunkBlob` 的期望类型一致。 */
  if (v instanceof Uint8Array) return new Uint8Array(v);
  return v;
}

function normalizeRow(row: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = fromSqlValue(v);
  return out;
}

/* ═══════════════════════════ 1. 连接抽象 ═══════════════════════════ */

/**
 * SQL 引擎需要提供的最小能力。
 *
 * 刻意保持**同步**:`DbLike` 全同步,而 SQLite 本地文件本质同步。
 * 若将来要接网络数据库,应在 `DbLike` 层面引入 async,而不是在这里做假同步。
 */
export interface SqlConnection {
  /** 执行 DDL / 多语句批 / PRAGMA。 */
  exec(sql: string): void;
  /** 绑参查询,返回全部行。 */
  all(sql: string, params: readonly unknown[]): Record<string, unknown>[];
  /** 绑参查询,返回首行或 `undefined`。 */
  get(sql: string, params: readonly unknown[]): Record<string, unknown> | undefined;
  /** 绑参写入,返回受影响行数。 */
  run(sql: string, params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** 事务:回调抛错则回滚。 */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** 表/索引自省(两引擎都支持 `sqlite_master` 查询,故放在共用层)。 */
function tableNamesOf(db: SqliteDb): string[] {
  return db
    .raw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    )
    .map((r) => r.name);
}

/* ═══════════════════════════ 2. SqliteDb ═══════════════════════════ */

/** 把任意 `SqlConnection` 包装成 `DbLike`。 */
export class SqliteDb implements DbLike {
  private conn: SqlConnection;

  /** ★ 审计 P2:最近一次启动期维护(VACUUM)的结果;`null` = 还没跑过。 */
  lastVacuum: VacuumReport | null = null;

  /**
   * @param conn 连接。传 `better-sqlite3` 的 `Database` 会自动适配
   *   (保留旧调用方式),也可直接传 `SqlConnection`。
   */
  constructor(conn: SqlConnection | Database) {
    this.conn = isSqlConnection(conn) ? conn : betterSqlite3Connection(conn);
    for (const p of RECOMMENDED_PRAGMAS) this.conn.exec(p);
  }

  /** 逃生通道:自省查询用。业务代码不应调用。 */
  raw<T>(sql: string, params: readonly unknown[] = []): T[] {
    return this.conn.all(sql, params) as T[];
  }

  /**
   * 建表 + 迁移登记。`failClosed` 时 checksum 漂移直接抛错。
   *
   * ## 归档迁移也在这里(审计 P1:归档 drift 必须 fail-closed)
   *
   * 改前 `bootstrap()` 只调 `migrate()`:归档那一段 `schema_world_archive.sql`
   * 的 checksum 漂移**只有写归档时**才会碰到,于是「库里的归档表是老 DDL 建的」
   * 这件事可以一直不被发现,直到某次重置。
   *
   * 现在启动就核对一次(`migrateWorldArchivesIfInstalled`):
   *   * 装过归档的库 ⇒ 幂等 DDL + 漂移判定,漂移 ⇒ 拒绝启动;
   *   * 全新的库 ⇒ **不建**那第 10 张表(建表数被既有判据锁在 9 张,见
   *     `schema_world_archive.sql` 文件头);需要「启动即有归档表」的宿主显式调
   *     `bootstrapWorldArchives()`。
   *
   * ## ★ WS-FND-156 起始背包台账也在同一处置里
   * 装过台账的库 ⇒ `checkStartingInventory()`(幂等 DDL + 漂移判定,漂移 ⇒ 拒绝启动);
   * 全新的库 ⇒ 不建那张表(它由**第一次发放**时就地补上,见
   * `schema_starting_inventory.sql` 文件头)。
   */
  bootstrap(nowMs: number, failClosed = true): void {
    const r = migrate(this, nowMs, schemaSqlPath());
    if (r.drift && failClosed) {
      throw new Error('schema_migrations checksum 漂移,拒绝启动(fail-closed)');
    }
    const a = this.checkWorldArchives(nowMs);
    if (a.drift && failClosed) {
      throw new Error(
        'room_world_archives 的迁移 checksum 漂移(schema_world_archive.sql 被改过,'
        + '而库里的表没跟着改)⇒ 拒绝启动(fail-closed):'
        + '归档是回滚原料,带着不确定的结构跑起来,回滚出去的就是坏世界。'
        + '见 docs/WS-07-net-persist.md 的迁移段',
      );
    }
    /* ★ WS-FND-156:起始背包台账的启动检查(装过才查)。
       同一处置:台账是「谁已经领过起始背包」的唯一真值,它的 DDL 漂移会让
       「已领」判断建在一个没人核对过的结构上 ⇒ 拒绝启动而不是等到某次入场。 */
    const s = this.checkStartingInventory(nowMs);
    if (s.drift && failClosed) {
      throw new Error(
        'user_starting_inventory 的迁移 checksum 漂移(schema_starting_inventory.sql 被改过,'
        + '而库里的表没跟着改)⇒ 拒绝启动(fail-closed):'
        + '台账判「已领」靠的是这张表,带着不确定的结构跑起来会重复发或永不发',
      );
    }
    /* ★ WS-FND-165(B1):房间系统台账的启动检查(装过才查)。
       同一处置:这张表记的是「哪几张单已结算 / 房内第几天」,它的 DDL 漂移会让
       「已结算」判断建在一个没人核对过的结构上 ⇒ 拒绝启动,而不是等到某次成交。 */
    const rs = this.checkRoomSystems(nowMs);
    if (rs.drift && failClosed) {
      throw new Error(
        'room_systems_state 的迁移 checksum 漂移(schema_room_systems.sql 被改过,'
        + '而库里的表没跟着改)⇒ 拒绝启动(fail-closed):'
        + '结算幂等靠的是这张表,带着不确定的结构跑起来会让同一张订单再成交一次',
      );
    }
    /* ★ 审计 P2 维护位:启动期检查一次「库是否已经膨胀到该重写」。
       结果落在 `this.lastVacuum` 上 —— 「有没有做、为什么没做」必须可观测。
       注意 VACUUM 是整库重写,**只**在启动期做,不挂写入路径。 */
    this.lastVacuum = maybeVacuum(this);
  }

  /** 归档迁移的启动检查(装过才查;返回值可观测,便于装配层记录/判定)。 */
  checkWorldArchives(nowMs: number): WorldArchiveBootCheck {
    return migrateWorldArchivesIfInstalled(this, nowMs);
  }

  /**
   * ★ WS-FND-165(B1):房间系统台账迁移的启动检查(装过才查;返回值可观测)。
   *
   * 装过 ⇒ 幂等 DDL + checksum 漂移判定(漂移在 `bootstrap` 里 fail-closed);
   * 没装过 ⇒ **不建那张表**(全新库不许在这里多出第 10 张表 —— 建表数被既有判据锁着),
   * 它由第一次存档房间系统状态时就地补上(`saveRoomSystemsState` → `migrateRoomSystems`)。
   */
  checkRoomSystems(nowMs: number): RoomSystemsBootCheck {
    return migrateRoomSystemsIfInstalled(this, nowMs);
  }

  /** ★ WS-FND-156:起始背包台账迁移的启动检查(装过才查;返回值可观测)。 */
  checkStartingInventory(nowMs: number): StartingInventoryBootCheck {
    return migrateStartingInventoryIfInstalled(this, nowMs);
  }

  /**
   * 无条件把归档表建起来(幂等),`failClosed` 时漂移直接抛。
   * 需要「启动即有归档表」的宿主调这个;全新的探针库**不要**调 ——
   * 会多出一张表,把「9 张表」的既有判据打红。
   */
  bootstrapWorldArchives(nowMs: number, failClosed = true): void {
    const r = migrateWorldArchives(this, nowMs);
    if (r.drift && failClosed) {
      throw new Error('room_world_archives 迁移 checksum 漂移,拒绝启动(fail-closed)');
    }
  }

  exec(sql: string): void {
    this.conn.exec(sql);
  }

  insert(table: string, row: Row): void {
    assertTable(table);
    const cols = Object.keys(row);
    for (const c of cols) assertColumn(c);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.conn.run(sql, cols.map((c) => toSqlValue(row[c])));
  }

  update(table: string, key: KeyParts, patch: Row): number {
    assertTable(table);
    const patchCols = Object.keys(patch);
    const keyCols = Object.keys(key);
    for (const c of [...patchCols, ...keyCols]) assertColumn(c);
    if (patchCols.length === 0) return 0;
    const sql =
      `UPDATE ${table} SET ${patchCols.map((c) => `${c} = ?`).join(', ')}` +
      ` WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')}`;
    return this.conn.run(sql, [
      ...patchCols.map((c) => toSqlValue(patch[c])),
      ...keyCols.map((c) => toSqlValue(key[c])),
    ]).changes;
  }

  delete(table: string, key: KeyParts): number {
    assertTable(table);
    const keyCols = Object.keys(key);
    for (const c of keyCols) assertColumn(c);
    const sql = `DELETE FROM ${table} WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')}`;
    return this.conn.run(sql, keyCols.map((c) => toSqlValue(key[c]))).changes;
  }

  get(table: string, key: KeyParts): Row | undefined {
    return this.select(table, key).slice(0, 1)[0];
  }
  /**
   * 按等值条件取行 + 可选的上界(`limit` / `orderBy`)。
   *
   * 上界必须**下推到 SQL**:改前这里虽有 `limit`,但 `repo.ts` 的 `select` 声明
   * 里根本没有它 ⇒ 「只读最近 N 行」只能把整表取回 JS 再裁(`room_events` 就是
   * 这样长跑的)。现在 `ORDER BY` 的列名与方向都过白名单,`LIMIT` 取整内联。
   */
  select(table: string, where?: KeyParts, limit?: number, orderBy?: OrderBy): Row[] {
    assertTable(table);
    const cols = where ? Object.keys(where) : [];
    for (const c of cols) assertColumn(c);
    if (orderBy) assertColumn(orderBy.column);
    const clause = cols.length > 0 ? ` WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}` : '';
    const order = orderBy
      ? ` ORDER BY ${orderBy.column} ${orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    /* LIMIT 取整后内联:它是数字,不构成注入面;而绑参给 LIMIT 在部分引擎上不被接受。 */
    const lim = limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
    const rows = this.conn.all(
      `SELECT * FROM ${table}${clause}${order}${lim}`,
      cols.map((c) => toSqlValue(where?.[c])),
    );
    return rows.map(normalizeRow);
  }


  /** 表名列表(自省用,验证 DDL 是否落地)。 */
  tableNames(): string[] {
    return tableNamesOf(this);
  }

  indexNames(): string[] {
    return this.raw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    ).map((r) => r.name);
  }

  triggerNames(): string[] {
    return this.raw<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      [],
    ).map((r) => r.name);
  }

  count(table?: string): number {
    if (!table) {
      let n = 0;
      for (const t of this.tableNames()) {
        const row = this.conn.get(`SELECT COUNT(*) AS c FROM ${t}`, []) as { c: number };
        n += row.c;
      }
      return n;
    }
    assertTable(table);
    const row = this.conn.get(`SELECT COUNT(*) AS c FROM ${table}`, []) as { c: number };
    return row.c;
  }
  /**
   * 事务。**支持嵌套**,语义与 `memory_db.ts` 逐条一致(三个后端同一口径):
   *
   * | 情形 | 结果 |
   * | :--- | :--- |
   * | 内层抛错、外层捕获后继续 | 只回滚**内层**写入(外层已做的改动保留) |
   * | 外层抛错 | 连同内层写入一起回滚 |
   * | 嵌套调用 | 不抛错(第 2 层起用 `SAVEPOINT`,而不是再 `BEGIN`) |
   *
   * 三层实现:`better-sqlite3` 的 `transaction()` 自带 savepoint;`node:sqlite`
   * 没有,由适配器手写(`nodeSqliteConnection`);`memory_db` 用每层一份快照。
   */
  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn);
  }

  close(): void {
    this.conn.close();
  }
}

/** 判定入参是 `SqlConnection` 还是 `better-sqlite3` 的 `Database`。 */
function isSqlConnection(x: SqlConnection | Database): x is SqlConnection {
  return typeof (x as SqlConnection).all === 'function';
}

/* ═══════════════════════════ 3. 两个适配器 ═══════════════════════════ */

/**
 * `better-sqlite3` 适配器(约 40 行 —— 这就是「换驱动」的全部成本)。
 *
 * 它比 `node:sqlite` 多出 `db.pragma()` 与 `db.transaction()`,
 * 所以这里直接转发,不必手写 BEGIN/COMMIT。
 */
export function betterSqlite3Connection(db: Database): SqlConnection {
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[],
    get: (sql, params) => db.prepare(sql).get(...(params as unknown[])) as Record<string, unknown> | undefined,
    run: (sql, params) => {
      const info = db.prepare(sql).run(...(params as unknown[]));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    /* `better-sqlite3` 的 `transaction()` **自带嵌套处理**(内层自动开 savepoint,
       与 SQLite 的官方语义一致),故直接转发 —— 它就是本仓「嵌套事务」的参考实现。 */
    transaction: <T,>(fn: () => T): T => db.transaction(fn)() as T,
    close: () => db.close(),
  };
}

/** `node:sqlite` 的 `DatabaseSync` 的最小结构(避免顶层 import 触发实验性告警)。 */
interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  close(): void;
}

/**
 * `node:sqlite` 适配器(Node 24 **内置**,零依赖)。
 *
 * 差异都在这几行里被吸收:
 *   * 没有 `pragma()`,因此 `PRAGMA` 走 `exec`;
 *   * 没有 `transaction()`,因此手写 BEGIN/COMMIT/ROLLBACK —— 且**嵌套**时改用
 *     `SAVEPOINT`(SQLite 不允许在事务里再 `BEGIN`;改前第二层会直接抛
 *     `cannot start a transaction within a transaction`,而另外两个后端都能嵌套);
 *   * BLOB 读回是 `Uint8Array`(而非 `Buffer`),由 `normalizeRow` 统一。
 *
 * 加载 `node:sqlite` 会打一条 ExperimentalWarning —— 用
 * `process.getBuiltinModule` 惰性取,避免顶层 import 时任何用法都被警告污染。
 */
export function nodeSqliteConnection(db: NodeSqliteDb): SqlConnection {
  /* 事务嵌套深度:0 = 没有活动事务。>0 时第 N 层用 `SAVEPOINT ws_sp_N`
     (与 `better-sqlite3` 的 `transaction()` 同名语义),而不是再 `BEGIN`。 */
  let txDepth = 0;
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[],
    get: (sql, params) => db.prepare(sql).get(...(params as unknown[])) as Record<string, unknown> | undefined,
    run: (sql, params) => db.prepare(sql).run(...(params as unknown[])),
    transaction: <T,>(fn: () => T): T => {
      const sp = txDepth > 0 ? `ws_sp_${txDepth}` : null;
      if (sp === null) db.exec('BEGIN');
      else db.exec(`SAVEPOINT ${sp}`);
      txDepth += 1;
      try {
        const r = fn();
        txDepth -= 1;
        if (sp === null) db.exec('COMMIT');
        else db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        txDepth -= 1;
        if (sp === null) {
          db.exec('ROLLBACK');
        } else {
          /* 先回到 savepoint,再 `RELEASE` 真正弹出这一层 ——
             只 `ROLLBACK TO` 不 `RELEASE`,savepoint 会一直堆在栈上。 */
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        }
        throw e;
      }
    },
    close: () => db.close(),
  };
}

/**
 * 打开一个零依赖 SQLite 库(内存或文件)。
 *
 * `file` 传 `':memory:'` 得临时库。生产部署若不装 `better-sqlite3`,
 * 用这个工厂即可运行全部仓储逻辑。
 */
export function openNodeSqlite(file = ':memory:'): SqliteDb {
  const nodeSqlite = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: new (path: string) => NodeSqliteDb;
  };
  if (!nodeSqlite) throw new Error('当前 Node 不提供 node:sqlite(需 Node >= 22.5)');
  return new SqliteDb(nodeSqliteConnection(new nodeSqlite.DatabaseSync(file)));
}

/**
 * WAL 自动检查点阈值(页)。
 *
 * 为什么必须**显式**设(审计 P2):`journal_mode = WAL` + `synchronous = NORMAL`
 * 之后,-wal 文件只在 checkpoint 时收缩,而「何时检查点」由 `wal_autocheckpoint`
 * (引擎默认 1000 页)决定。本仓原先只设了前三条 PRAGMA,**没设这一条** ⇒
 * 这个决定交给了引擎默认值:换引擎/换版本就悄悄变了,而它正是长跑里
 * 「-wal 文件涨到几百 MB」的那个开关。
 *
 * 512 页(默认页 4 KiB ⇒ 约 2 MiB 上限)是本仓「20 Hz 写入 + 小库」的折中:
 * 比默认更早回收,又不至于每个事务都检查点一次。
 * ⚠️ 单位是**页**不是字节;`better-sqlite3` 与 `node:sqlite` 接受同一语法。
 */
export const WAL_AUTOCHECKPOINT_PAGES = 512;

/**
 * VACUUM 的触发阈值:空闲页占比 ≥ 该百分比才整库重写。
 *
 * 要不要 VACUUM、什么时候做(结论 + 依据):
 *   结论:只在**启动期**做,且只有超过阈值才做;不挂高频写入路径。
 *   依据:VACUUM 把整库重写一遍(临时文件 + 全表拷贝),代价 O(库大小);
 *   而删行(`room_events` 的有界保留、归档裁剪)**只把页放回 freelist**,
 *   文件字节数不会缩 —— 长跑之后会出现「逻辑规模已封顶、文件仍然很大」。
 *   既不能省(否则文件只涨不缩),也不能随便做(每删一次就真空一次,等于把
 *   删行的收益立刻花掉)⇒ 启动期一次 + 阈值挡住空转 = 折中。
 *
 * 未做(留 owner 裁决):`PRAGMA incremental_vacuum` 需要建库时就定下的
 *   `auto_vacuum = INCREMENTAL`(持久属性),事后改等于改库的物理布局。
 */
export const VACUUM_FREELIST_PCT_THRESHOLD = 25;

/** WAL 下推荐的额外 PRAGMA(连接建立后调用一次即可)。 */
export const RECOMMENDED_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -16000',
  /* ★ 审计 P2:检查点阈值从「引擎默认」变成**本仓的具名常量**。 */
  `PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`,
];

/** 一次启动期维护(VACUUM)的结果。**必须可观测** —— 「默默没做」本身就是缺陷。 */
export interface VacuumReport {
  /** 真的执行了 VACUUM 吗。 */
  ran: boolean;
  /** `ran === false` 的原因:`empty` 空库 / `under-threshold` 没到阈值 /
   *  `in-transaction` 在事务里(SQLite 不允许)/ `failed` 执行抛错。 */
  reason: 'ok' | 'empty' | 'under-threshold' | 'in-transaction' | 'failed';
  /** 空闲页数(`PRAGMA freelist_count`)。 */
  freePages: number;
  /** 库页数(`PRAGMA page_count`)。 */
  pageCount: number;
  /** 空闲页占比(0..100);`pageCount === 0` 时记 0。 */
  freePct: number;
  /** `reason === 'failed'` 时的错误消息。 */
  error?: string;
}

/**
 * 超阈值才 VACUUM。SQLite 不允许在事务里跑 ⇒ 那种情况报 `in-transaction` 而不是
 * 抛错(启动期调用方不该因为「恰好有人开着事务」而崩)。
 */
export function maybeVacuum(
  db: SqliteDb,
  thresholdPct = VACUUM_FREELIST_PCT_THRESHOLD,
): VacuumReport {
  const pragma = (name: string): number => {
    const row = db.raw<Record<string, unknown>>(`PRAGMA ${name}`, [])[0];
    return Number(row?.[name] ?? 0) || 0;
  };
  const freePages = pragma('freelist_count');
  const pageCount = pragma('page_count');
  const freePct = pageCount > 0 ? (freePages / pageCount) * 100 : 0;
  const base = { freePages, pageCount, freePct };
  if (pageCount === 0) return { ran: false, reason: 'empty', ...base };
  if (freePages === 0 || freePct < thresholdPct) {
    return { ran: false, reason: 'under-threshold', ...base };
  }
  try {
    db.exec('VACUUM');
    return { ran: true, reason: 'ok', ...base };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/within a transaction/i.test(msg)) return { ran: false, reason: 'in-transaction', ...base };
    /* 不静默吞:原因与错误文本一起回给调用方,由它决定记日志还是告警。 */
    return { ran: false, reason: 'failed', error: msg, ...base };
  }
}
