/**
 * WS-07 · `DbLike` 的内存实现(零依赖)。
 *
 * 用途:测试与本地冒烟。它实现了与 `driver.sqlite.ts` 完全一致的**语义契约**:
 *   * 主键唯一性由 `TABLE_PRIMARY_KEYS` 决定,重复插入抛错;
 *   * 外键与级联由 `FOREIGN_KEYS` 表驱动,删除父行时按策略处理子行;
 *   * `exec()` 解析 DDL 文本,所以 `schema.sql` 的表/列/索引真的会被落地 ——
 *     测试因此能通过 `db.tableNames()` 反查 DDL 是否与代码同步。
 *
 * 它**不是** SQL 引擎:不解析 SELECT / JOIN / CHECK / VIEW / TRIGGER。
 * 需要真 SQL 语义的场景走 `driver.sqlite.ts`(依赖注入 better-sqlite3)。
 */

import { TABLE_PRIMARY_KEYS, type DbLike, type KeyParts, type Row } from './repo.ts';

/** 外键 -> 删除策略。`CASCADE` 删子行;`SET NULL` 置空可空列。 */
export const FOREIGN_KEYS: readonly {
  from: string;
  fromCol: string;
  to: string;
  toCol: string;
  onDelete: 'CASCADE' | 'SET NULL';
}[] = [
  { from: 'rooms', fromCol: 'owner_id', to: 'users', toCol: 'id', onDelete: 'CASCADE' },
  { from: 'user_sessions', fromCol: 'user_id', to: 'users', toCol: 'id', onDelete: 'CASCADE' },
  { from: 'user_sessions', fromCol: 'room_id', to: 'rooms', toCol: 'id', onDelete: 'SET NULL' },
  { from: 'room_players', fromCol: 'room_id', to: 'rooms', toCol: 'id', onDelete: 'CASCADE' },
  { from: 'room_players', fromCol: 'user_id', to: 'users', toCol: 'id', onDelete: 'CASCADE' },
  { from: 'room_chunks', fromCol: 'room_id', to: 'rooms', toCol: 'id', onDelete: 'CASCADE' },
  { from: 'ai_alchemy_recipes', fromCol: 'first_crafter_id', to: 'users', toCol: 'id', onDelete: 'SET NULL' },
  { from: 'ai_item_instances', fromCol: 'owner_id', to: 'users', toCol: 'id', onDelete: 'CASCADE' },
  { from: 'ai_item_instances', fromCol: 'recipe_hash', to: 'ai_alchemy_recipes', toCol: 'recipe_hash', onDelete: 'SET NULL' },
  { from: 'ai_item_instances', fromCol: 'bound_room_id', to: 'rooms', toCol: 'id', onDelete: 'SET NULL' },
  { from: 'room_events', fromCol: 'room_id', to: 'rooms', toCol: 'id', onDelete: 'CASCADE' },
];

/**
 * 从 DDL 解析出的列级约束。
 *
 * ## 为什么必须解析,而不是硬编码
 *
 * `schema.sql` 里有 **70 个 NOT NULL + 27 个 CHECK + 26 个 DEFAULT + 11 个外键**,
 * 而 `MemoryDb` 原先**一条都不强制**:它只查主键冲突。后果(
 * 用 `node:sqlite` 拿真实引擎逐项对照,实测 **7 项分歧 / 3 项一致**):
 *
 * | 场景 | MemoryDb(改前) | 真实 SQLite |
 * | :--- | :--- | :--- |
 * | 插入指向不存在父行的子行 | **接受** | 抛 `FOREIGN KEY constraint failed` |
 * | 插入缺 NOT NULL 列 | **接受** | 抛 `NOT NULL constraint failed` |
 * | `update` 把 NOT NULL 列写成 null | **接受** | 抛 `NOT NULL constraint failed` |
 * | CHECK 约束写非法值 | **接受** | 抛 `CHECK constraint failed` |
 * | 改 `rooms.status` | 不写审计事件 | 触发器写一条 `ROOM_STATUS` |
 *
 * 这是最贵的一类返工陷阱:**22 处 WS-07 测试全部建立在宽松行为上**,
 * 内存测试全绿,而装上 `better-sqlite3` 切到真实库存档时报错。
 *
 * 所以约束必须**从 `schema.sql` 解析**——硬编码会与 DDL 漂移,
 * 而漂移本身就是这次要修的病。
 */
interface ColumnRules {
  byColumn: Map<
    string,
    {
      notNull: boolean;
      hasDefault: boolean;
      /** DEFAULT 的字面量值(`DEFAULT 1` / `DEFAULT '{}'` / `DEFAULT NULL`)。 */
      defaultValue?: unknown;
      isPrimaryKey?: boolean;
      check?: CheckExpr;
      checkSql?: string;
    }
  >;
  tableChecks: { sql: string; expr: CheckExpr }[];
}

/**
 * 解析 `DEFAULT <字面量>`。
 *
 * 只认字面量(`1` / `-1` / `1.5` / `'{}'` / `NULL`)——
 * 这是 `schema.sql` 里实际用到的全部形态。SQLite 也支持 `DEFAULT (expr)`,
 * 那种形态这里返回 `undefined` 表示「不认识」,由 `enforceConstraints`
 * 按「有 DEFAULT 就不强制 NOT NULL」处理(**偏保守**:宁可少报错,
 * 也不要因为解析不了而误报「缺列」)。
 */
function parseDefault(d: string): unknown {
  const m = /\bDEFAULT\s+('(?:[^']|'')*'|[^\s,)]+)/i.exec(d);
  if (!m) return undefined;
  const raw = m[1];
  if (/^NULL$/i.test(raw)) return null;
  if (/^'/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  const n = Number(raw);
  if (!Number.isNaN(n) && raw.trim() !== '') return n;
  return undefined;
}

export class MemoryDb implements DbLike {
  /** 表名 -> 行数组(插入顺序)。 */
  private tables = new Map<string, Row[]>();
  /** DDL 解析出的索引名集合,供断言。 */
  private indexSet = new Set<string>();
  private viewSet = new Set<string>();
  private triggerSet = new Set<string>();
  /** 事务嵌套深度:>0 时写操作写入暂存区,提交时一次性合并。 */
  private txDepth = 0;
  private txSnapshot: Map<string, Row[]> | null = null;

  /* ── 表结构自省 ── */

  tableNames(): string[] {
    return [...this.tables.keys()].sort();
  }

  indexNames(): string[] {
    return [...this.indexSet].sort();
  }

  viewNames(): string[] {
    return [...this.viewSet].sort();
  }

  triggerNames(): string[] {
    return [...this.triggerSet].sort();
  }

  /** 某表的列集合(由插入过的行 + DDL 声明共同推断)。 */
  columns(table: string): string[] {
    return [...(this.tables.get(table) ?? []).reduce((s, r) => {
      for (const k of Object.keys(r)) s.add(k);
      return s;
    }, new Set<string>())].sort();
  }

  /** DDL 中显式声明的列名(即使没有数据也能断言)。 */
  declaredColumns(table: string): string[] {
    return this.declared.get(table) ?? [];
  }

  private declared = new Map<string, string[]>();

  /** 表名 -> 从 DDL 解析出的列级与表级约束。 */
  private rules = new Map<string, ColumnRules>();

  /** 某表解析出的约束(供测试断言「约束真的被解析了」)。 */
  constraintSummary(table: string): { columns: number; notNull: number; checks: number } {
    const r = this.rules.get(table);
    if (!r) return { columns: 0, notNull: 0, checks: 0 };
    let notNull = 0;
    let checks = 0;
    for (const c of r.byColumn.values()) {
      if (c.notNull) notNull += 1;
      if (c.check) checks += 1;
    }
    return { columns: r.byColumn.size, notNull, checks: checks + r.tableChecks.length };
  }

  /* ── DDL / PRAGMA ── */

  exec(sql: string): void {
    /* 不再预先逐行剥 `--`:那是调用方的补丁,掩盖了解析器不识别注释的缺陷。
       现在 `splitStatements` 自己擦注释,原文直传即可(A07b 有专门测试锁住)。 */
    for (const raw of splitStatements(sql)) {
      const stmt = raw.trim();
      if (!stmt) continue;
      if (/^PRAGMA\b/i.test(stmt)) continue;
      if (/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i.test(stmt)) {
        this.applyCreateTable(stmt);
        continue;
      }
      if (/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i.test(stmt)) {
        const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i.exec(stmt);
        if (m) this.indexSet.add(m[1]);
        continue;
      }
      if (/^CREATE\s+VIEW\s+(IF\s+NOT\s+EXISTS\s+)?/i.test(stmt)) {
        const m = /^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i.exec(stmt);
        if (m) this.viewSet.add(m[1]);
        continue;
      }
      if (/^CREATE\s+TRIGGER\s+(IF\s+NOT\s+EXISTS\s+)?/i.test(stmt)) {
        const m = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i.exec(stmt);
        if (m) this.triggerSet.add(m[1]);
        continue;
      }
      throw new Error(`MemoryDb.exec 不支持的语句:${stmt.slice(0, 60)}`);
    }
  }

  private applyCreateTable(stmt: string): void {
    const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*\(/i.exec(stmt);
    if (!m) throw new Error('无法解析 CREATE TABLE');
    const name = m[1];
    if (!this.tables.has(name)) this.tables.set(name, []);
    /* 提取顶层列定义名,用于 declaredColumns 断言。 */
    const body = stmt.slice(m[0].length);
    const cols: string[] = [];
    const rules: ColumnRules = { byColumn: new Map(), tableChecks: [] };
    for (const def of splitTopLevel(body)) {
      const d = def.trim();
      if (!d) continue;
      /* 表级约束:CHECK (...) —— 解析成谓词;不认识的形态也**记下来**(unsupported) */
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(d)) {
        if (/^(CHECK|CONSTRAINT)\b/i.test(d)) {
          const cm = /\bCHECK\s*\(([\s\S]*)\)\s*$/i.exec(d);
          if (cm) rules.tableChecks.push({ sql: cm[1].trim(), expr: parseCheckExpr(cm[1]) });
        }
        continue;
      }
      const cm = /^([A-Za-z_][\w]*)\s+/.exec(d);
      if (!cm) continue;
      const col = cm[1];
      cols.push(col);
      /* 列级约束:NOT NULL / DEFAULT / CHECK(...) */
      const notNull = /\bNOT\s+NULL\b/i.test(d);
      const hasDefault = /\bDEFAULT\b/i.test(d);
      const checkM = /\bCHECK\s*\(([\s\S]*)\)\s*$/i.exec(d);
      const entry: {
        notNull: boolean;
        hasDefault: boolean;
        defaultValue?: unknown;
        isPrimaryKey?: boolean;
        check?: CheckExpr;
        checkSql?: string;
      } = { notNull, hasDefault };
      if (hasDefault) entry.defaultValue = parseDefault(d);
      if (/\bPRIMARY\s+KEY\b/i.test(d)) entry.isPrimaryKey = true;
      if (checkM) {
        entry.check = parseCheckExpr(checkM[1]);
        entry.checkSql = checkM[1].trim();
      }
      rules.byColumn.set(col, entry);
    }
    this.declared.set(name, cols);
    this.rules.set(name, rules);
  }

  /**
   * 无法解析的 CHECK 表达式清单(供测试断言)。
   *
   * 刻意把它暴露出来而不是静默跳过:若将来 `schema.sql` 加了新形态的 CHECK,
   * 这条出口会让「MemoryDb 漏掉了一条约束」变得**可见**。
   * 静默放行才会让门禁变成装饰。
   */
  unsupportedChecks(): { table: string; sql: string }[] {
    const out: { table: string; sql: string }[] = [];
    for (const [table, r] of this.rules) {
      for (const c of r.tableChecks) {
        if (c.expr.kind === 'unsupported') out.push({ table, sql: c.sql });
      }
      for (const [col, c] of r.byColumn) {
        if (c.check && c.check.kind === 'unsupported') {
          out.push({ table, sql: `${col}: ${c.check.sql}` });
        }
      }
    }
    return out;
  }

  /**
   * 把一条待写入的行按 DDL 约束校验。
   *
   * 与真实 SQLite 的对应关系(实测对照过):
   *   * `NOT NULL`  -> `NOT NULL constraint failed`
   *   * `CHECK`     -> `CHECK constraint failed`
   *   * 外键        -> `FOREIGN KEY constraint failed`
   *
   * `mode` 区分 insert / update:insert 时缺列且无 DEFAULT 才报错;
   * update 时只校验**被写入的列**(与 SQL 的 UPDATE 语义一致)。
   */
  private enforceConstraints(table: string, row: Row, mode: 'insert' | 'update'): void {
    const r = this.rules.get(table);
    /* 表结构未解析(未跑过 DDL)时不做约束校验 —— 与 SQLite 的「表不存在」一致,
       由 ensure() 抛错,不在这里伪装成约束错误。 */
    if (!r) return;

    for (const [col, rule] of r.byColumn) {
      const present = Object.prototype.hasOwnProperty.call(row, col);
      if (mode === 'update' && !present) continue;
      const v = row[col];
      /* 缺列时:有 DEFAULT(或它是主键)由 SQLite 自动填值,**不算违反 NOT NULL**。
         这是我第一版引入的误报 —— 实测 `user_sessions.revoked`
         (`NOT NULL DEFAULT 0`)不传时被错报 `NOT NULL constraint failed`。 */
      if (!present) {
        if (rule.notNull && !rule.hasDefault && !rule.isPrimaryKey && mode === 'insert') {
          throw new Error(`NOT NULL constraint failed: ${table}.${col}`);
        }
        continue;
      }
      if (rule.notNull && (v === null || v === undefined)) {
        throw new Error(`NOT NULL constraint failed: ${table}.${col}`);
      }
      if (v !== undefined && rule.check && !checkPasses(rule.check, v)) {
        throw new Error(`CHECK constraint failed: ${table}.${col} ${rule.checkSql ?? ''}`);
      }
    }

    /* 表级 CHECK:只对**被写入的列**涉及的表达式求值 ——
       完整求值需要表达式引擎,而这里的目标是「与 SQL 行为一致到能挡住错误写入」。 */
    for (const c of r.tableChecks) {
      if (c.expr.kind === 'unsupported') continue;
      const col = (c.expr as { col: string }).col;
      const present = Object.prototype.hasOwnProperty.call(row, col);
      if (!present) continue;
      const v = row[col];
      if (v === undefined) continue;
      if (!checkPasses(c.expr, v)) {
        throw new Error(`CHECK constraint failed: ${table} ${c.sql}`);
      }
    }

    /* 外键:指向的父行必须存在(与 `PRAGMA foreign_keys = ON` 一致)。
       非空值才校验 —— NULL 外键在 SQLite 里是允许的。 */
    for (const fk of FOREIGN_KEYS) {
      if (fk.from !== table) continue;
      const present = Object.prototype.hasOwnProperty.call(row, fk.fromCol);
      if (mode === 'update' && !present) continue;
      const v = row[fk.fromCol];
      if (v === null || v === undefined) continue;
      const parent = this.tables.get(fk.to) ?? [];
      if (!parent.some((p) => p[fk.toCol] === v)) {
        throw new Error(`FOREIGN KEY constraint failed: ${table}.${fk.fromCol} → ${fk.to}.${fk.toCol}`);
      }
    }
  }

  /* ── 行级 CRUD ── */

  insert(table: string, row: Row): void {
    const rows = this.ensure(table);
    const keys = TABLE_PRIMARY_KEYS[table];
    if (!keys) throw new Error(`MemoryDb 未登记主键的表:${table}`);
    if (rows.some((r) => keys.every((k) => r[k] === row[k]))) {
      throw new Error(`${table} 主键冲突:${keys.map((k) => String(row[k])).join('/')}`);
    }
    /* 与真实 SQLite 一致地强制 DDL 约束(NOT NULL / CHECK / 外键)。
       改前这里只查主键 —— 实测与真实引擎有 7 项语义分歧。 */
    this.enforceConstraints(table, row, 'insert');
    /* 补上 DEFAULT 值,使**存下来的行**与真实 SQLite 一致。
       不做这一步的话,缺列的行在内存里读回是 `undefined`,
       而 SQLite 读回是默认值 —— 又是一处「测试绿、生产异」的分歧。 */
    const filled = this.applyDefaults(table, row);
    rows.push(filled);
  }

  /** 用 DDL 的 DEFAULT 补齐缺列(不改入参)。 */
  private applyDefaults(table: string, row: Row): Row {
    const r = this.rules.get(table);
    if (!r) return { ...row };
    const out: Row = { ...row };
    for (const [col, rule] of r.byColumn) {
      if (Object.prototype.hasOwnProperty.call(out, col)) continue;
      if (rule.hasDefault && rule.defaultValue !== undefined) out[col] = rule.defaultValue;
    }
    return out;
  }

  update(table: string, key: KeyParts, patch: Row): number {
    const rows = this.ensure(table);
    let n = 0;
    for (const r of rows) {
      if (!matches(r, key)) continue;
      /* 只校验**被写入的列**,与 SQL 的 UPDATE 语义一致。
         校验在真正写入之前 —— 否则抛错时行已被改坏。 */
      this.enforceConstraints(table, patch, 'update');
      /* 触发器要在**改动之前**看到旧行(SQLite 的 OLD/NEW 语义) */
      const oldRow = { ...r };
      for (const [k, v] of Object.entries(patch)) r[k] = v;
      this.applyTriggers(table, oldRow, r);
      n += 1;
    }
    return n;
  }

  /**
   * 模拟 `schema.sql` 里的触发器。
   *
   * ## 为什么必须实现,而不是「文档里注明不支持」
   *
   * `trg_rooms_status_change` 是 `AFTER UPDATE OF status ON rooms`:
   * 房间状态变更时自动写一条 `ROOM_STATUS` 审计流水。
   * 实测:真实 SQLite 改状态后 `room_events` 多 1 行,MemoryDb 多 0 行 ——
   * 于是**同一段生产代码在两种后端下产生不同的数据**。
   *
   * 这类分歧比「报错」更危险:不抛异常、不报错,只是数据少了。
   * 内存测试全绿,切到真实库才发现审计流水缺失,而历史数据已经不可追。
   *
   * 触发器的 SQL 体无法在这里执行,所以逻辑是**按 DDL 里那一条手写映射**;
   * `triggeredKinds` 暴露已实现的种类,新增触发器时由门禁报出来。
   */
  private applyTriggers(table: string, oldRow: Row, newRow: Row): void {
    if (table !== 'rooms') return;
    if (oldRow.status === newRow.status) return; /* WHEN OLD.status <> NEW.status */
    const events = this.tables.get('room_events');
    if (!events) return;
    const payload = JSON.stringify({ from: oldRow.status, to: newRow.status });
    /* `room_events.id` 是**全表**主键,故取全表 maxId —— 与真实触发器一致
       (SQLite 里 `id INTEGER PRIMARY KEY` 由引擎分配下一个全局行号)。 */
    const maxId = events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    events.push({
      id: maxId + 1,
      room_id: newRow.id,
      tick: newRow.world_tick ?? 0,
      kind: 'ROOM_STATUS',
      actor_id: null,
      payload_json: payload,
      created_at: newRow.last_active_at ?? 0,
    });
  }

  /** 已模拟的触发器(供门禁断言:DDL 里有几个触发器就实现了几个)。 */
  readonly implementedTriggers: readonly string[] = ['trg_rooms_status_change'];

  delete(table: string, key: KeyParts): number {
    const rows = this.ensure(table);
    const keep: Row[] = [];
    const removed: Row[] = [];
    for (const r of rows) (matches(r, key) ? removed : keep).push(r);
    if (removed.length === 0) return 0;
    this.tables.set(table, keep);
    for (const r of removed) {
      for (const fk of FOREIGN_KEYS) {
        if (fk.to !== table) continue;
        const childRows = this.tables.get(fk.from);
        if (!childRows) continue;
        if (fk.onDelete === 'CASCADE') {
          const survivors = childRows.filter((c) => c[fk.fromCol] !== r[fk.toCol]);
          if (survivors.length !== childRows.length) {
            this.tables.set(fk.from, survivors);
            for (const gone of childRows.filter((c) => c[fk.fromCol] === r[fk.toCol])) {
              this.cascadeDelete(fk.from, gone);
            }
          }
        } else {
          for (const c of childRows) {
            if (c[fk.fromCol] === r[fk.toCol]) c[fk.fromCol] = null;
          }
        }
      }
    }
    return removed.length;
  }

  /** 级联删除时继续向孙表传播(深度受限,避免环形外键死循环)。 */
  private cascadeDelete(table: string, row: Row): void {
    for (const fk of FOREIGN_KEYS) {
      if (fk.to !== table) continue;
      const childRows = this.tables.get(fk.from);
      if (!childRows) continue;
      const hit = childRows.filter((c) => c[fk.fromCol] === row[fk.toCol]);
      if (hit.length === 0) continue;
      if (fk.onDelete === 'SET NULL') {
        for (const c of hit) c[fk.fromCol] = null;
      } else {
        this.tables.set(fk.from, childRows.filter((c) => c[fk.fromCol] !== row[fk.toCol]));
      }
    }
  }

  get(table: string, key: KeyParts): Row | undefined {
    return this.ensure(table).find((r) => matches(r, key));
  }

  select(table: string, where?: KeyParts): Row[] {
    const rows = this.ensure(table);
    if (!where) return rows;
    return rows.filter((r) => matches(r, where));
  }

  count(table?: string): number {
    if (!table) {
      let n = 0;
      for (const rows of this.tables.values()) n += rows.length;
      return n;
    }
    return this.ensure(table).length;
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.txSnapshot = new Map();
      for (const [k, v] of this.tables) this.txSnapshot.set(k, v.map((r) => ({ ...r })));
    }
    this.txDepth += 1;
    try {
      const out = fn();
      this.txDepth -= 1;
      if (this.txDepth === 0) this.txSnapshot = null;
      return out;
    } catch (err) {
      this.txDepth -= 1;
      if (this.txDepth === 0 && this.txSnapshot) {
        this.tables = this.txSnapshot;
        this.txSnapshot = null;
      }
      throw err;
    }
  }

  private ensure(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }
}

function matches(row: Row, key: KeyParts): boolean {
  for (const [k, v] of Object.entries(key)) if (row[k] !== v) return false;
  return true;
}

/** 按顶层 `;` 切分,忽略括号内的分号(例如 CHECK (...))与 BEGIN…END 块内的分号(触发器体)。 */
export function splitStatements(sql: string): string[] {
  /* 先**擦掉**注释(而非只跳过),再切分 —— 见 `blankComments` 的说明。 */
  const clean = blankComments(sql);
  const out: string[] = [];
  let depth = 0;
  let beginDepth = 0;
  let start = 0;
  let inStr: string | null = null;
  /* 注释已在 `blankComments` 中处理,这里不再需要状态机。 */
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(') { depth += 1; continue; }
    if (c === ')') { depth -= 1; continue; }
    if (depth === 0 && /[A-Za-z_]/.test(c)) {
      /* 只在深度 0 识别 BEGIN / END 关键字(触发器体)。 */
      const w = /^[A-Za-z_][A-Za-z_]*/.exec(clean.slice(i))?.[0].toUpperCase();
      if (w === 'BEGIN') beginDepth += 1;
      else if (w === 'END' && beginDepth > 0) beginDepth -= 1;
      if (w) { i += w.length - 1; continue; }
      continue;
    }
    if (c === ';' && depth === 0 && beginDepth === 0) {
      out.push(clean.slice(start, i));
      start = i + 1;
    }
  }
  out.push(clean.slice(start));
  return out.filter((s) => s.trim().length > 0);
}

/**
 * 把 SQL 注释**擦成空格**(保持字符偏移不变),字符串字面量内部不动。
 *
 * ## 为什么是「擦成空格」而不是「跳过」
 *
 * 只跳过不擦掉,注释文本仍留在语句里,于是 `/^\s*CREATE\s+TABLE/`
 * 匹配不上以注释开头的语句 —— 实测:`splitStatements(rawSchema)` 里
 * `/^\s*CREATE\s+TABLE/` 匹配 **0 张表**。
 * (`exec()` 原先靠「先逐行剥 `--`」绕开了这个缺陷 ——
 * 那是调用方的补丁,不是解析器的正确性:任何直接传原文的调用方都会中招。)
 *
 * 擦成空格后:偏移不变(报错位置仍准)、语句首尾的 `\s*` 能吞掉注释残留的空白、
 * 字符串里的 `--` 与 `/​*` 不受影响。
 */
export function blankComments(sql: string): string {
  const buf = sql.split('');
  let inStr: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '-' && c2 === '-') {
      let j = i;
      while (j < sql.length && sql[j] !== '\n') { buf[j] = ' '; j += 1; }
      i = j - 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i;
      while (j < sql.length && !(sql[j] === '*' && sql[j + 1] === '/')) {
        if (sql[j] !== '\n') buf[j] = ' '; /* 保留换行,行号不漂 */
        j += 1;
      }
      if (j < sql.length) { buf[j] = ' '; buf[j + 1] = ' '; }
      i = j + 1;
      continue;
    }
  }
  return buf.join('');
}

/**
 * `CHECK (...)` 的**结构化**表示。
 *
 * 之所以不把 SQL 表达式「编译成正则」:那样只能覆盖写死的几种形态,
 * 而且编译失败时无法区分「约束通过」与「约束不认识」。
 * 这里解析成可判定的谓词对象,不认识的形态用 `unsupported` **显式标记** ——
 * 于是「漏掉的约束」是可枚举的,而不是静默放行。
 */
export type CheckExpr =
  | { kind: 'in'; col: string; values: (string | null)[] }
  | { kind: 'between'; col: string; lo: number; hi: number }
  | { kind: 'cmp'; col: string; op: '>' | '>='; n: number }
  | { kind: 'length'; col: string; n: number }
  | { kind: 'unsupported'; sql: string };

/** 解析一条 CHECK 表达式。不认识的形态返回 `{kind:'unsupported'}`(**不是** null)。 */
export function parseCheckExpr(expr: string): CheckExpr {
  const e = expr.trim().replace(/\s+/g, ' ');
  const inM = /^(\w+)\s+IN\s*\(([\s\S]+)\)$/i.exec(e);
  if (inM) {
    const values = inM[2].split(',').map((v) => {
      const t = v.trim();
      if (/^NULL$/i.test(t)) return null;
      return t.replace(/^'|'$/g, '');
    });
    return { kind: 'in', col: inM[1], values };
  }
  const btM = /^(\w+)\s+BETWEEN\s+(-?\d+(?:\.\d+)?)\s+AND\s+(-?\d+(?:\.\d+)?)$/i.exec(e);
  if (btM) return { kind: 'between', col: btM[1], lo: Number(btM[2]), hi: Number(btM[3]) };
  const gtM = /^(\w+)\s*(>=|>)\s*(-?\d+(?:\.\d+)?)$/i.exec(e);
  if (gtM) return { kind: 'cmp', col: gtM[1], op: gtM[2] === '>=' ? '>=' : '>', n: Number(gtM[3]) };
  const lenM = /^length\s*\(\s*(\w+)\s*\)\s*=\s*(\d+)$/i.exec(e);
  if (lenM) return { kind: 'length', col: lenM[1], n: Number(lenM[2]) };
  return { kind: 'unsupported', sql: e };
}

/** 判定一个值是否满足一条 CHECK。`unsupported` 视为通过(由 `unsupportedChecks` 暴露)。 */
export function checkPasses(c: CheckExpr, value: unknown): boolean {
  switch (c.kind) {
    case 'in':
      if (value === null || value === undefined) return c.values.includes(null);
      return c.values.some((v) => v !== null && String(v) === String(value));
    case 'between':
      return typeof value === 'number' && value >= c.lo && value <= c.hi;
    case 'cmp':
      return typeof value === 'number' && (c.op === '>' ? value > c.n : value >= c.n);
    case 'length':
      if (value instanceof Uint8Array) return value.length === c.n;
      return true; /* 长度对非 BLOB 不适用 —— 交给类型层,不在这里误伤 */
    default:
      return true;
  }
}

/** 按顶层 `,` 切分括号体。 */
export function splitTopLevel(body: string): string[] {  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'") { inStr = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}
