/**
 * WS-FND-37 —— **A 路 / B 路 的「世界 + 库」解析必须同一套规则**。
 *
 * ## 这个套件为什么存在
 *
 * 本仓有两条装配路径,各自 `new RoomRuntime`:
 *   - A 路:`index.ts` 的 `assemble()`(测试与 `createServer()` 走它)
 *   - B 路:`net/room.colyseus.ts` 的 `onCreate()`(Colyseus 实例化房间时走它)
 *
 * 两条路的 `host` 曾经分叉:B 路写过 `?? null`,于是**生产里恒无世界**。
 * 那一条在 2026-11-14 修好了(`resolveRoomHost`)。但**库(db)** 还留着同一个病:
 * B 路写 `this.deps?.db ?? null`,A 路走 `resolveDb`(给了 `dbPath` 就开真库)
 * ⇒ 同一语义两种答案,而两者都"看起来合理"。
 *
 * 本套件钉的就是**这两者不得再分叉**:
 *   1 生产默认支(A 的 `resolveAssembly()` 与 B 的 `resolveRoomDb(undefined)`)取到**同一个值**;
 *   2 「给了 `dbPath` 就开真库」这条规则在共用解析里**真的生效**(不是硬编码 `null`);
 *   3 两条路的「显式关闭」入口(`host: null` / `db: null`)都还在 —— 那是负对照入口,
 *     把 `db === null` 断言成"不会有库"会把这条负对照一起修死。
 *
 * ## ⚠️ 本套件**不**声称的事
 *
 * 它**不**证明"生产会落盘"。今天 `NetPersistRoom` 的 `deps` 恒为 `undefined`
 * (`withDeps` 零调用点,Colyseus 也不会把 deps 传给 `onCreate`)⇒ 解析结果仍是
 * `db: null` ⇒ **落盘/读档不跑**。这是**已知边界**:缺的是「库从哪来」的裁决
 * (文件路径?env?存哪?),不是接线。第 1 条断言就把"今天仍是 null"钉住了,
 * 所以任何"存档已经能用了"的说法都会先在这里红。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { resolveAssembly } from '../server/src/index.ts';
import { resolveRoomDb, resolveRoomHost } from '../server/src/net/room.colyseus.ts';
import type { NetPersistRoomOptions } from '../server/src/net/room.colyseus.ts';

/** 一个**已固定**的时钟(与 `NetPersistRoomOptions` 的形状一致,不含真时间)。 */
const CLOCK = { nowMs: () => 0 };

/* ───────────────────────── 判据 ───────────────────────── */

test('FND37-1 生产默认支:A 的 resolveAssembly() 与 B 的 resolveRoomDb(undefined) 取到同一个 db', () => {
  const a = resolveAssembly();
  const b = resolveRoomDb(undefined);

  /* ① 今天两者都是 null —— 这是**已知边界**,先钉住。 */
  eq(a.db, null, 'A 路的生产默认今天不落盘(已知边界)');
  eq(b, a.db, '★ B 路必须与 A 路取到同一个值 —— 这正是此前分叉的地方');

  /* ② 世界在两条路上都非空(A 路已接上,B 路 2026-11-14 接上)。 */
  ok(a.host !== null, 'A 路的生产默认必须有世界');
  const bh = resolveRoomHost(undefined);
  ok(bh !== null, 'B 路的生产默认必须有世界');
  eq(typeof (bh as { saveToDb?: unknown }).saveToDb, 'function', 'B 路的宿主应是真的世界(有 saveToDb)');
});

test('FND37-2 「给了 dbPath 就开真库」这条规则在共用解析里真的生效(不是硬编码 null)', () => {
  /* `:memory:` 不落盘、无副作用 —— 但它**是**一个真的 DbLike,足够证明规则被走通了。 */
  const withPath = resolveAssembly({ dbPath: ':memory:' });

  ok(withPath.db !== null, '★ 给了 dbPath 就必须拿到库 —— 否则说明"规则"只是摆设');
  ok(withPath.host !== null, '世界与库是同一个解析的两个产物,不能只给一head');
});

test('FND37-3 显式 `db: null`(键在)= 关闭落盘,不许被"顺手修好"', () => {
  eq(resolveRoomDb({ clock: CLOCK, db: null } as unknown as NetPersistRoomOptions), null,
    '显式 null 必须保持 null(负对照入口)');
});

test('FND37-4 显式给了库 ⇒ B 路用它(不被解析覆盖)', () => {
  const db = { exec: () => undefined } as unknown as NonNullable<ReturnType<typeof resolveRoomDb>>;
  const got = resolveRoomDb({ clock: CLOCK, db } as unknown as NetPersistRoomOptions);
  ok(got === db, '★ B 路必须原样返回调用方给的库,不许换成自己开的那个');
});

test('FND37-5 显式 `host: null` 仍然是 null(两条路的关闭入口都在)', () => {
  eq(resolveRoomHost({ clock: CLOCK, db: null, host: null } as unknown as NetPersistRoomOptions),
    null, 'host: null 必须保持 null');
  ok(resolveRoomHost({ clock: CLOCK, db: null } as unknown as NetPersistRoomOptions) !== null,
    '没给 host 键 ⇒ 生产默认造一个');
});

test('FND37-6 两条路的解析各调一次不互相影响(无隐藏单例)', () => {
  const first = resolveAssembly();
  const second = resolveAssembly();
  ok(first.host !== second.host, '★ 每次解析都应是**新的**世界实例,不许偷偷复用单例');
  eq(first.db, second.db, '库的解析结果应稳定(今天都是 null)');
});

test('FND37-7 `PI_DB_PATH` 是**显式部署开关**:给了就开库,不给仍是 null', () => {
  const before = process.env.PI_DB_PATH;
  try {
    delete process.env.PI_DB_PATH;
    eq(resolveAssembly().db, null, '没设环境变量 ⇒ 仍是 null(与今天逐字一致)');

    process.env.PI_DB_PATH = ':memory:';
    const on = resolveAssembly();
    ok(on.db !== null, '★ 设了 `PI_DB_PATH` 就必须真的开库 —— 否则这开关是摆设');
    ok(on.host !== null, '世界与库同一个解析,不能只给一个');
  } finally {
    if (before === undefined) delete process.env.PI_DB_PATH;
    else process.env.PI_DB_PATH = before;
  }
});

test('FND37-8 显式 `db`/`dbPath` 优先于环境变量(顺序不许反)', () => {
  const before = process.env.PI_DB_PATH;
  try {
    process.env.PI_DB_PATH = ':memory:';
    /* 显式 `db: null`(键在)必须赢过环境变量 —— 否则负对照入口被环境静默推翻。 */
    eq(resolveRoomDb({ clock: CLOCK, db: null } as unknown as NetPersistRoomOptions), null,
      '★ 显式 null 优先于 PI_DB_PATH');
  } finally {
    if (before === undefined) delete process.env.PI_DB_PATH;
    else process.env.PI_DB_PATH = before;
  }
});

report('WS-FND-37');
