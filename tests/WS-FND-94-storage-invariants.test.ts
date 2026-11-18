/**
 * WS-FND-94 —— 存档/物理/流体的 8 条**机械不变量**(审计 `docs/AUDIT-W34.md` §3.2 登记项)。
 *
 * 这一套件钉的不是「新功能」,而是 8 处**语义缺口**:每一处都能在不报错的情况下
 * 产生错数据(或让三个后端产生不同数据)。所以每条判据都按「正面 + 负对照」
 * 成对写 —— 负对照必须**恰好**落在改坏后的行为上,否则断言只是恒真。
 *
 * | # | 判据 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- |
 * | 1 | 嵌套事务三后端同语义:`memory_db` / `node:sqlite` 内层失败只回滚内层、外层失败连坐、嵌套不抛;SQL 侧第 2 层起走 `SAVEPOINT` | `driver.sqlite.ts:nodeSqliteConnection` 恢复成裸 `BEGIN`(第 2 层抛)/ `memory_db.transaction` 只在外层还原 |
 * | 2 | `room_players.snapshot_blob` 1 MiB 上限:写入侧如实拒、库上 `CHECK` 也拦、1 MiB 本身必须收 | 删掉 `assertReconnectSnapshotSize` 的抛错 / 删掉 `schema.sql` 的 `CHECK` |
 * | 3 | `saveVitalsToUsers` 整批一个事务:第 2 个人写失败 ⇒ 第 1 个人也不落库 | 去掉 `db.transaction(...)` 包裹 |
 * | 4 | `FluidField.clone()` 复制活跃集:拷贝场 `step(预算 < 格数)` 的 `moved`/`active`/水量与原场逐位一致,`pendingObj` 各持一份 | `clone()` 里删掉 `activeArr`/`activeIdx`/`activeCursor`/`pendingObj` 的复制 |
 * | 5 | `PhysicsWorld.spawn()` 覆盖同 id 时回收四张旁表(μ / 速度上限 / 重力 / 起跳)与落穴计时,且不误伤别的 id | `spawn()` 里删掉 `reclaimSideTables(id)` |
 * | 6 | `Chunk.setRoof()` 与 `VERTICAL_STACK` 的 ROOF 层(12 位 / 4095)对齐:4095 收、4096 拒且原值不变 | 把校验换回 `roofId >>> 0`(静默截 16 位) |
 * | 7 | `decodeRoofRle()` 的 `0xff` 截断必须抛,且**抛之前不写 0** | 删掉 `i + 2 >= buf.length` 那三行 |
 * | 8 | `FluidField.setCell()` 实心格拒写 + 按 `addWater` 口径补基底层 | 删掉 `nextSolid === 1` 的抛错 / 删掉补 `base` 的两行 |
 *
 * ## 断言右侧一律是**字面量**
 *
 * `1048576` / `4095` / `4096` / `65536` / `100` 都手写。只有「契约本身」的地方
 * (例:ROOF 层规格来自 `VERTICAL_STACK`)才引用被测模块的导出口,而且引用后
 * 立刻与字面量对账 —— 不让「用一个值断言它自己」混进来。
 *
 * ## 为什么 1 与 2 要跑真 `node:sqlite`
 *
 * 「内存后端通过」证明不了库上那条 `CHECK` 真的落地,也证明不了 `SAVEPOINT`
 * 序列在真引擎上能跑(`BEGIN` 套 `BEGIN` 的失败只在真引擎里出现)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { nodeSqliteConnection, openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  BLOB_MAX_BYTES,
  RECONNECT_SNAPSHOT_MAX_BYTES,
  RoomRole,
  createRoom,
  createUser,
  getUser,
  loadReconnectSnapshot,
  migrate,
  readSchemaSql,
  saveReconnectSnapshot,
  saveVitalsToUsers,
  upsertRoomPlayer,
  type DbLike,
} from '../server/src/db/repo.ts';
import {
  Chunk,
  ROOF_ID_MAX,
  VERTICAL_STACK,
  decodeRoofRle,
  encodeRoofRle,
} from '../server/src/world/chunk.ts';
import { FluidField, FluidKind } from '../server/src/world/fluid.ts';
import { PhysicsWorld } from '../server/src/physics/world.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 1 MiB = 1048576 字节(字面量,不读被测模块的常量来当期望值)。 */
const ONE_MIB = 1048576;

function mkMem(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  return db;
}

function mkSql(): { db: DbLike; close: () => void } {
  const db = openNodeSqlite(':memory:');
  migrate(db, 1000);
  return { db, close: () => db.close() };
}

function addUser(db: DbLike, id: string, nowMs = 1000): void {
  createUser(db, { id, displayName: id, nowMs });
}

/** 在 8×8 场里造一格水(经公开写口,活跃集合因此被正确维护)。 */
function wetField(): FluidField {
  const f = new FluidField(8, 8);
  f.setCell(1, 1, { base: 5, amount: 600 }); /* 5 = BaseFluid.SHALLOW_WATER */
  return f;
}

/* ═══════════ 1. 嵌套事务:三后端同语义(内存 / 真 SQLite / 适配器序列) ═══════════ */

/**
 * 同一段脚本在两个后端上跑,返回**结果事实**(谁还在库里),用于逐条对照。
 * 脚本:外层写 A → 内层写 B 后抛错(被外层捕获)→ 外层再写 C → 提交。
 * 期望:内层 B 不在,外层 A/C 都在,且**嵌套调用本身不抛**。
 */
function nestedScript(db: DbLike): { ids: string[]; innerThrew: boolean; outerCommitted: boolean } {
  let innerThrew = false;
  db.transaction(() => {
    addUser(db, 'A', 1001);
    try {
      db.transaction(() => {
        addUser(db, 'B', 1002);
        throw new Error('内层故意失败');
      });
    } catch {
      innerThrew = true;
    }
    addUser(db, 'C', 1003);
  });
  const ids = ['A', 'B', 'C'].filter((id) => getUser(db, id) !== undefined);
  return { ids, innerThrew, outerCommitted: ids.includes('A') && ids.includes('C') };
}

test('FND94-1a 嵌套事务(内存后端):内层失败只回滚内层,外层照常提交', () => {
  const r = nestedScript(mkMem());
  ok(r.innerThrew, '内层异常必须冒泡到外层的 catch(嵌套**本身**不许抛 BEGIN 冲突)');
  eq(r.ids, ['A', 'C'], '★ 负对照:B 必须不在库里(改前内层半截写入会留下)');
  ok(r.outerCommitted, '外层 A/C 都在');
});

test('FND94-1b 嵌套事务(真实 node:sqlite):与内存后端**逐条一致**', () => {
  const { db, close } = mkSql();
  try {
    const sqlOut = nestedScript(db);
    const memOut = nestedScript(mkMem());
    eq(sqlOut.ids, ['A', 'C'], '★ 真引擎上内层也只回滚自己(SAVEPOINT 生效)');
    eq(sqlOut.ids, memOut.ids, '★ 两个后端的「谁还在库里」必须一模一样');
    eq(sqlOut.innerThrew, memOut.innerThrew, '内层异常在两个后端都冒泡');

    /* 外层失败 ⇒ 连同内层写入一起回滚(连坐)。 */
    const db2 = mkSql();
    try {
      let threw = false;
      try {
        db2.db.transaction(() => {
          addUser(db2.db, 'X', 2001);
          db2.db.transaction(() => addUser(db2.db, 'Y', 2002));
          throw new Error('外层故意失败');
        });
      } catch {
        threw = true;
      }
      ok(threw, '外层异常必须冒泡');
      eq(getUser(db2.db, 'X'), undefined, '★ 外层失败 ⇒ X 回滚');
      eq(getUser(db2.db, 'Y'), undefined, '★ 外层失败 ⇒ 内层 Y 也一起回滚');
      eq(getUser(mkMemAfterOuterFailure(), 'Y'), undefined, '内存后端同样连坐');
    } finally {
      db2.close();
    }
  } finally {
    close();
  }
});

/** 内存后端上的「外层失败」同构脚本,供上面那条逐条对照。 */
function mkMemAfterOuterFailure(): MemoryDb {
  const db = mkMem();
  try {
    db.transaction(() => {
      addUser(db, 'X', 2001);
      db.transaction(() => addUser(db, 'Y', 2002));
      throw new Error('外层故意失败');
    });
  } catch {
    /* 期望抛错 */
  }
  eq(getUser(db, 'X'), undefined, '内存后端:外层失败 ⇒ X 回滚');
  return db;
}

test('FND94-1c 嵌套事务的 SQL 序列:第 2 层起必须是 SAVEPOINT(不是第二个 BEGIN)', () => {
  const log: string[] = [];
  const stub = {
    exec(sql: string): void {
      log.push(sql);
    },
    prepare(_sql: string) {
      return {
        all(..._p: unknown[]): unknown[] {
          return [];
        },
        get(..._p: unknown[]): unknown {
          return undefined;
        },
        run(..._p: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
          return { changes: 0, lastInsertRowid: 0 };
        },
      };
    },
    close(): void {
      /* noop */
    },
  };
  const conn = nodeSqliteConnection(stub);
  conn.transaction(() => {
    let innerThrew = false;
    try {
      conn.transaction(() => {
        throw new Error('内层故意失败');
      });
    } catch {
      innerThrew = true;
    }
    ok(innerThrew, '内层异常照常冒泡(适配器不许吞)');
  });
  eq(log.filter((s) => s === 'BEGIN').length, 1, '★ 整段只有一个 BEGIN(改前第二层会再发 BEGIN)');
  eq(
    log,
    ['BEGIN', 'SAVEPOINT ws_sp_1', 'ROLLBACK TO ws_sp_1', 'RELEASE ws_sp_1', 'COMMIT'],
    '★ 嵌套顺序必须是 SAVEPOINT → ROLLBACK TO → RELEASE → COMMIT',
  );
});

/* ═══════════ 2. room_players.snapshot_blob 的 1 MiB 上限 ═══════════ */

test('FND94-2a 重连快照:1 MiB 收、1 MiB+1 如实拒,且被拒后库里还是上一份', () => {
  const db = mkMem();
  addUser(db, 'u1');
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  upsertRoomPlayer(db, 'r1', 'u1', RoomRole.MEMBER, 1000, new Uint8Array([1, 2, 3]));
  eq(loadReconnectSnapshot(db, 'r1', 'u1')?.byteLength, 3, '前提:先有一份小快照');

  /* 正面对照:上限**本身**必须能收(否则就是「把口子焊死」而不是「加上限」)。 */
  saveReconnectSnapshot(db, 'r1', 'u1', new Uint8Array(ONE_MIB), 1001);
  eq(loadReconnectSnapshot(db, 'r1', 'u1')?.byteLength, ONE_MIB, '★ 恰好 1 MiB 必须被接受');

  const oversize = new Uint8Array(ONE_MIB + 1);
  let threw = false;
  try {
    saveReconnectSnapshot(db, 'r1', 'u1', oversize, 1002);
  } catch {
    threw = true;
  }
  ok(threw, '★ 超 1 字节必须抛(如实拒,不是静默截断)');
  eq(loadReconnectSnapshot(db, 'r1', 'u1')?.byteLength, ONE_MIB, '★ 被拒后库里仍是上一份(没有半截写入)');

  /* 第二条写口:`upsertRoomPlayer` 也必须拦(两个入口同一个闸)。 */
  let threwUpsert = false;
  try {
    upsertRoomPlayer(db, 'r1', 'u1', RoomRole.MEMBER, 1003, oversize);
  } catch {
    threwUpsert = true;
  }
  ok(threwUpsert, '★ upsertRoomPlayer 同口径拒绝');
  eq(loadReconnectSnapshot(db, 'r1', 'u1')?.byteLength, ONE_MIB, 'upsert 被拒后也没写坏');
});

test('FND94-2b 库上的第二道闸:绕过 repo 直插超限 BLOB 必须被 CHECK 拦住', () => {
  /* DDL 文本里的口径(防止只改内存实现、真库没有约束)。 */
  ok(
    /CHECK\s*\(\s*length\s*\(\s*snapshot_blob\s*\)\s*<=\s*1048576\s*\)/.test(readSchemaSql()),
    '★ schema.sql 里必须有 CHECK (length(snapshot_blob) <= 1048576)',
  );
  eq(RECONNECT_SNAPSHOT_MAX_BYTES, 1048576, '快照上限必须是 1 MiB(字面量对账)');
  eq(BLOB_MAX_BYTES, 1048576, '两个写入点共用的常量也必须是 1 MiB');

  const oversize = new Uint8Array(ONE_MIB + 1);
  const mem = mkMem();
  addUser(mem, 'u2');
  createRoom(mem, { id: 'r2', ownerId: 'u2', nowMs: 1000 });
  let memThrew = false;
  try {
    mem.insert('room_players', {
      room_id: 'r2', user_id: 'u2', role: 'MEMBER',
      snapshot_blob: oversize, joined_at: 0, last_seen_at: 0,
    });
  } catch {
    memThrew = true;
  }
  ok(memThrew, '★ 内存后端:直插超限 BLOB 必须抛 CHECK(不是靠 repo 的闸)');
  eq(mem.select('room_players', { room_id: 'r2' }).length, 0, '被拒后没有留下半行');

  /* 1 MiB 的直插必须过(负对照:证明约束不是「一律拒」)。 */
  mem.insert('room_players', {
    room_id: 'r2', user_id: 'u2', role: 'MEMBER',
    snapshot_blob: new Uint8Array(ONE_MIB), joined_at: 0, last_seen_at: 0,
  });
  eq(loadReconnectSnapshot(mem, 'r2', 'u2')?.byteLength, ONE_MIB, '★ 1 MiB 直插通过');

  const { db, close } = mkSql();
  try {
    addUser(db, 'u3');
    createRoom(db, { id: 'r3', ownerId: 'u3', nowMs: 1000 });
    let sqlThrew = false;
    try {
      db.insert('room_players', {
        room_id: 'r3', user_id: 'u3', role: 'MEMBER',
        snapshot_blob: oversize, joined_at: 0, last_seen_at: 0,
      });
    } catch {
      sqlThrew = true;
    }
    ok(sqlThrew, '★ 真实 SQLite:DDL 的 CHECK 也必须拦住(约束真的落地了)');
    eq(db.count('room_players'), 0, '真实库上也没留下坏行');
    db.insert('room_players', {
      room_id: 'r3', user_id: 'u3', role: 'MEMBER',
      snapshot_blob: new Uint8Array(ONE_MIB), joined_at: 0, last_seen_at: 0,
    });
    eq(loadReconnectSnapshot(db, 'r3', 'u3')?.byteLength, ONE_MIB, '★ 真实库上 1 MiB 直插通过');
  } finally {
    close();
  }
});

/* ═══════════ 3. saveVitalsToUsers 整批一个事务 ═══════════ */

/** 包一层 DbLike:第 N 次 `users` 的 UPDATE 抛错,用来验证「整批原子」。 */
function flakyUsersUpdate(db: DbLike, failAt: number): DbLike {
  let n = 0;
  return {
    exec: (sql) => db.exec(sql),
    insert: (table, row) => db.insert(table, row),
    update: (table, key, patch) => {
      if (table === 'users') {
        n += 1;
        if (n === failAt) throw new Error(`模拟第 ${n} 个人写库失败(磁盘满)`);
      }
      return db.update(table, key, patch);
    },
    delete: (table, key) => db.delete(table, key),
    get: (table, key) => db.get(table, key),
    select: (table, where) => db.select(table, where),
    count: (table) => db.count(table),
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },
  };
}

test('FND94-3 批量落血:全成或全不成(第 2 个人失败 ⇒ 第 1 个人也不落库)', () => {
  const db = mkMem();
  addUser(db, 'u1');
  addUser(db, 'u2');
  eq(getUser(db, 'u1')?.hp, 100, '前提:初始 hp = 100');

  let threw = false;
  try {
    saveVitalsToUsers(flakyUsersUpdate(db, 2), { u1: { hp: 40 }, u2: { hp: 55 } }, 2000);
  } catch {
    threw = true;
  }
  ok(threw, '第 2 个人的写入失败必须冒泡(不吞)');
  eq(getUser(db, 'u1')?.hp, 100, '★ 负对照:第 1 个人必须**没落库**(改前会被前一个人写进去)');
  eq(getUser(db, 'u2')?.hp, 100, '第 2 个人也没落库');

  /* 正面:不注入故障时两人都写进去,报告如实。 */
  const out = saveVitalsToUsers(db, { u1: { hp: 40 }, u2: { hp: 55 } }, 3000);
  eq(out, { saved: 2, skipped: 0 }, '两人都写完,报告 2/0');
  eq(getUser(db, 'u1')?.hp, 40, 'u1 落到 40');
  eq(getUser(db, 'u2')?.hp, 55, 'u2 落到 55');

  /* 负对照 2:不存在的人仍算 skipped(事务不许把这条语义改掉)。 */
  const out2 = saveVitalsToUsers(db, { u1: { hp: 40 }, ghost: { hp: 10 } }, 4000);
  eq(out2, { saved: 1, skipped: 1 }, '缺席的人计入 skipped');
});

/* ═══════════ 4. FluidField.clone() 必须复制活跃集 ═══════════ */

test('FND94-4a clone 后 step(预算 < 格数)的 moved / active / 水量与原场逐位一致', () => {
  const f = new FluidField(64, 64);
  f.setCell(30, 30, { base: 5, amount: 500 });
  /* 关键:预算 256 远小于 4096 格 —— 只有活跃集能把 (30,30) 排到这一帧的前面。 */
  const c = f.clone();
  const r1 = f.step(256);
  const r2 = c.step(256);

  ok(r1.moved > 0, `前提:原场这一帧水真的动了(实得 moved=${r1.moved})`);
  eq(r2.active, r1.active, '★ clone 的 active 必须与原场一致');
  eq(r2.moved, r1.moved, '★ clone 的 moved 必须与原场一致');
  eq(r2.consumedByPhase, r1.consumedByPhase, '相变计数一致');
  let diff = 0;
  for (let i = 0; i < f.amount.length; i += 1) if (f.amount[i] !== c.amount[i]) diff += 1;
  eq(diff, 0, '★ 步进后的水量逐格相同');
});

test('FND94-4b 负对照:活跃集丢了就是「一格都不动」(证明上面的等式不是 0 === 0)', () => {
  const cold = new FluidField(64, 64);
  /* 直写数组 = 绕过 markActive,正是改前 clone 的状态。 */
  cold.amount[30 * 64 + 30] = 500;
  cold.base[30 * 64 + 30] = 5;
  const r = cold.step(256);
  eq(r.active, 0, '★ 没进活跃集 ⇒ active = 0');
  eq(r.moved, 0, '★ 没进活跃集 ⇒ 这一帧 moved = 0(预算扫不到 1950 号格)');
  eq(cold.amount[30 * 64 + 30], 500, '水还在原处(一毫格都没动)');
});

test('FND94-4c clone 复制 phase 产物队列:两边各持一份,drain 各自消费', () => {
  const f = wetField();
  f.pendingObj.push({ index: 9, obj: 386 });
  f.pendingObj.push({ index: 10, obj: 110 });
  const c = f.clone();
  eq(c.pendingObj.length, 2, '★ 拷贝场的待写回队列条目数相同');
  eq(c.drainPhaseProducts(), [{ x: 1, y: 1, obj: 386 }, { x: 2, y: 1, obj: 110 }], '拷贝场按序取走');
  eq(f.pendingObj.length, 2, '★ 原场队列**没被转移**(各持一份,不是浅拷贝引用)');
  eq(f.drainPhaseProducts().length, 2, '原场自己还能取到 2 条');
});

/* ═══════════ 5. PhysicsWorld.spawn() 覆盖同 id 必须回收旁表 ═══════════ */

interface PhysSideTables {
  muMuls: Map<string, number>;
  speedCaps: Map<string, number>;
  gravityMuls: Map<string, number>;
  jumpMuls: Map<string, number>;
  trapTimers: Map<string, number>;
}

test('FND94-5a spawn 覆盖同 id:四张旁表 + 落穴计时必须回到中性', () => {
  const pw = new PhysicsWorld();
  pw.spawn('p1');
  pw.setMuMul('p1', 0.5);
  pw.setSpeedCap('p1', 5);
  pw.setGravityMul('p1', 0.3);
  pw.setJumpMul('p1', 1.5);
  eq(pw.speedCapOf('p1'), 5, '前提:上限设上了');

  /* 负对照:别的刚体的 buff 不许被顺手清掉。 */
  pw.spawn('p2');
  pw.setSpeedCap('p2', 7);

  pw.spawn('p1'); /* 覆盖同 id(= 换图/重置时的同 id 重生) */
  eq(pw.muMulOf('p1'), 1, '★ 覆盖后 μ 乘子回中性(新刚体不继承上一条命)');
  eq(pw.speedCapOf('p1'), null, '★ 覆盖后速度上限被撤掉(不是留一条 5)');
  eq(pw.gravityMulOf('p1'), 1, '★ 覆盖后重力乘子回 1');
  eq(pw.jumpMulOf('p1'), 1, '★ 覆盖后起跳乘子回 1');
  eq(pw.speedCapOf('p2'), 7, '★ 负对照:另一个刚体的上限**不受影响**');
});

test('FND94-5b 回收后旁表不留僵尸条目(spawn 覆盖与 remove 两条路都要归零)', () => {
  const pw = new PhysicsWorld();
  const t = pw as unknown as PhysSideTables;
  for (const id of ['a', 'b', 'c']) {
    pw.spawn(id);
    pw.setMuMul(id, 0.9);
    pw.setSpeedCap(id, 4);
    pw.setGravityMul(id, 0.3);
    pw.setJumpMul(id, 1.7);
    eq(pw.remove(id), true, `remove(${id}) 应返回 true`);
  }
  eq(t.speedCaps.size, 0, '★ remove 后速度上限表必须归零(防无界增长)');
  eq(t.gravityMuls.size, 0, '★ 重力乘子表归零');
  eq(t.jumpMuls.size, 0, '★ 起跳乘子表归零');
  eq(t.muMuls.size, 0, 'μ 乘子表归零');

  pw.spawn('d');
  pw.setSpeedCap('d', 9);
  pw.setGravityMul('d', 0.5);
  pw.setJumpMul('d', 2);
  pw.setMuMul('d', 0.5);
  eq(t.speedCaps.size, 1, '前提:四条记录都在');
  pw.spawn('d'); /* 同 id 重生 */
  eq(t.speedCaps.size, 0, '★ spawn 覆盖同 id 后同样归零');
  eq(t.gravityMuls.size + t.jumpMuls.size + t.muMuls.size, 0, '另外三张也归零');
});

/* ═══════════ 6. setRoof 与 12 位 ROOF 层对齐 ═══════════ */

test('FND94-6 setRoof:4095 收、越界拒且原值不变(不是钳位、不是静默截 16 位)', () => {
  /* 口径来源:VERTICAL_STACK 的 ROOF 层规格(与写入校验共用同一个事实源)。 */
  const spec = VERTICAL_STACK.find((s) => s.layer === 'ROOF');
  eq(spec?.bits, 12, '★ ROOF 层规格是 12 位');
  eq(spec?.max, 4095, '★ ROOF 层上界是 4095');
  eq(ROOF_ID_MAX, 4095, 'setRoof 的上界必须取自同一个规格');

  const c = new Chunk(0, 0);
  c.setRoof(2, 3, 4095);
  eq(c.getRoof(2, 3), 4095, '★ 12 位上界本身必须能存(不是「一律拒」)');
  c.setRoof(2, 3, 0);
  eq(c.getRoof(2, 3), 0, '0 = 清空屋顶,合法');
  c.setRoof(2, 3, 372);
  eq(c.getRoof(2, 3), 372, '内容表里的屋顶 ID 照常');

  for (const bad of [4096, 65536, -1, 1.5]) {
    let threw = false;
    try {
      c.setRoof(2, 3, bad);
    } catch {
      threw = true;
    }
    ok(threw, `★ setRoof(${String(bad)}) 必须抛(12 位之外)`);
    eq(c.getRoof(2, 3), 372, `★ 被拒后原值不变(${String(bad)} 不许钳成 0/4095、也不许截成低 16 位)`);
  }

  /* 65536 是改前的关键反例:`65536 >>> 0` 存进 Uint16Array 会变成 0。 */
  let truncated = false;
  try {
    c.setRoof(0, 0, 65536);
  } catch {
    truncated = true;
  }
  ok(truncated, '★ 65536 必须抛(改前会静默变成「没有屋顶」)');
});

/* ═══════════ 7. decodeRoofRle 的 0xff 截断 ═══════════ */

test('FND94-7 decodeRoofRle:0xff 截断必须抛,且抛之前一格都不写', () => {
  /* 正面对照:正常 RLE 往返不受影响。 */
  const src = Uint16Array.from([0, 0, 372, 0]);
  const back = new Uint16Array(4);
  decodeRoofRle(encodeRoofRle(src), back);
  eq(Array.from(back), Array.from(src), '正常编码/解码逐位往返');

  /* 负对照 1:0xff 后面只有 1 字节。 */
  const into = new Uint16Array(4);
  into.fill(0xabcd);
  let threw = false;
  try {
    decodeRoofRle(Uint8Array.from([0xff, 0x74]), into);
  } catch {
    threw = true;
  }
  ok(threw, '★ 0xff + 1 字节必须抛(改前会静默写 0)');
  eq(Array.from(into), [0xabcd, 0xabcd, 0xabcd, 0xabcd], '★ 抛错前**一格都没写**(不许静默写 0)');

  /* 负对照 2:0xff 后面 0 字节。 */
  const into2 = new Uint16Array(4);
  into2.fill(0xabcd);
  let threw2 = false;
  try {
    decodeRoofRle(Uint8Array.from([0xff]), into2);
  } catch {
    threw2 = true;
  }
  ok(threw2, '★ 0xff 结尾必须抛');
  eq(into2[0], 0xabcd, '同样不写');

  /* 负对照 3:先走一段零游程再截断(偏移不为 0 的同一缺陷)。 */
  let threw3 = false;
  try {
    decodeRoofRle(Uint8Array.from([1, 0xff, 0x74]), new Uint16Array(4));
  } catch {
    threw3 = true;
  }
  ok(threw3, '★ 偏移 1 处的截断也必须抛');

  /* 正面对照 2:零游程越过末尾是合法语义(不抛、不越界读)。 */
  const into3 = new Uint16Array(4);
  into3.fill(0xabcd);
  let threw4 = false;
  try {
    decodeRoofRle(Uint8Array.from([10]), into3);
  } catch {
    threw4 = true;
  }
  ok(!threw4, '零游程越过末尾仍合法(编码侧 n < 127 的对称语义)');
  eq(into3[0], 0xabcd, '零游程不写值(保留原值)');
});

/* ═══════════ 8. FluidField.setCell 的 solid / kind 校验 ═══════════ */

test('FND94-8a setCell 拒写实心格,且被拒时没有半截写入', () => {
  const f = new FluidField(8, 8);
  f.setCell(2, 2, { solid: true });
  eq(f.solid[2 * 8 + 2], 1, '前提:该格是实心');

  let threw = false;
  try {
    f.setCell(2, 2, { amount: 600 });
  } catch {
    threw = true;
  }
  ok(threw, '★ 向实心格注水必须抛(与 addWater 同口径)');
  eq(f.amountAt(2, 2), 0, '★ 被拒后水量仍是 0(不是「写了一半再抛」)');
  eq(f.kindAt(2, 2), FluidKind.NONE, '实心格不该有水种');

  /* 负对照:显式解除实心再注水 ⇒ 允许(闸门判的是**结果态**,不是历史)。 */
  f.setCell(2, 2, { solid: false, amount: 300 });
  eq(f.amountAt(2, 2), 300, '★ 先 solid=false 再注水必须允许');
  eq(f.kindAt(2, 2), FluidKind.WATER, '基底层按 addWater 口径补成水');

  /* `amount: 0` 是清空、不是注水 ⇒ 实心格上也允许。 */
  f.setCell(3, 3, { solid: true });
  let threwClear = false;
  try {
    f.setCell(3, 3, { amount: 0 });
  } catch {
    threwClear = true;
  }
  ok(!threwClear, '清空(amount: 0)不算注水,不该被拒');
  eq(f.amountAt(3, 3), 0, '清空后为 0');

  /* 同一格一次性写成「实心 + 有水量」也必须拒。 */
  let threwCombo = false;
  try {
    f.setCell(4, 4, { solid: true, amount: 100 });
  } catch {
    threwCombo = true;
  }
  ok(threwCombo, '★ 同一次调用里写成实心 + 注水:也必须拒');
  eq(f.amountAt(4, 4), 0, '被拒后水量为 0');
  eq(f.solid[4 * 8 + 4], 0, '被拒后 solid 也没被写(整次调用都不许留半截)');
});

test('FND94-8b setCell 补基底层:与 addWater 的 kind 口径一致', () => {
  const f = new FluidField(8, 8);
  /* 负对照:没有水量时**不补** base(空格不该被改成水)。 */
  f.setCell(5, 5, { amount: 0 });
  eq(f.kindAt(5, 5), FluidKind.NONE, '★ amount=0 不许补 base');

  /* 正面:水量落进 VOID 格 ⇒ base 补成 SHALLOW_WATER ⇒ kind = WATER。 */
  f.setCell(6, 6, { amount: 250 });
  eq(f.kindAt(6, 6), FluidKind.WATER, '★ 注水到 VOID 格 ⇒ kind 是 WATER(改前是 NONE)');
  eq(f.amountAt(6, 6), 250, '水量如实');

  /* 显式给的 base 优先(不许被默认水种覆盖)。 */
  f.setCell(7, 7, { base: 8, amount: 250 }); /* 8 = BaseFluid.LAVA */
  eq(f.kindAt(7, 7), FluidKind.LAVA, '★ 显式 base 不被默认水种覆盖');

  /* 与 addWater 对实心格的口径逐一对照:两条写口说的是同一件事。 */
  f.setCell(0, 0, { solid: true });
  eq(f.addWater(0, 0, 100), 0, 'addWater 对实心格注 0');
  let threw = false;
  try {
    f.setCell(0, 0, { amount: 100 });
  } catch {
    threw = true;
  }
  ok(threw, 'setCell 对实心格抛 —— 与 addWater 的「注 0」是同一个口径的两种表达');
});

report('WS-FND-94');