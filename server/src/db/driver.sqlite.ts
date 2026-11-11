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
  schemaSqlPath,
  type DbLike,
  type KeyParts,
  type Row,
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

  /** 建表 + 迁移登记。`failClosed` 时 checksum 漂移直接抛错。 */
  bootstrap(nowMs: number, failClosed = true): void {
    const r = migrate(this, nowMs, schemaSqlPath());
    if (r.drift && failClosed) {
      throw new Error('schema_migrations checksum 漂移,拒绝启动(fail-closed)');
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

  select(table: string, where?: KeyParts, limit?: number): Row[] {
    assertTable(table);
    const cols = where ? Object.keys(where) : [];
    for (const c of cols) assertColumn(c);
    const clause = cols.length > 0 ? ` WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}` : '';
    /* LIMIT 取整后内联:它是数字,不构成注入面;而绑参给 LIMIT 在部分引擎上不被接受。 */
    const lim = limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
    const rows = this.conn.all(`SELECT * FROM ${table}${clause}${lim}`, cols.map((c) => toSqlValue(where?.[c])));
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
 *   * 没有 `transaction()`,因此手写 BEGIN/COMMIT/ROLLBACK;
 *   * BLOB 读回是 `Uint8Array`(而非 `Buffer`),由 `normalizeRow` 统一。
 *
 * 加载 `node:sqlite` 会打一条 ExperimentalWarning —— 用
 * `process.getBuiltinModule` 惰性取,避免顶层 import 时任何用法都被警告污染。
 */
export function nodeSqliteConnection(db: NodeSqliteDb): SqlConnection {
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[],
    get: (sql, params) => db.prepare(sql).get(...(params as unknown[])) as Record<string, unknown> | undefined,
    run: (sql, params) => db.prepare(sql).run(...(params as unknown[])),
    transaction: <T,>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
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

/** WAL 下推荐的额外 PRAGMA(连接建立后调用一次即可)。 */
export const RECOMMENDED_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -16000',
];
