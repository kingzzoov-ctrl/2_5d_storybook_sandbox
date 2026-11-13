/**
 * 生产装配入口 —— 本仓**唯一**的「把世界装进房间」的地方。
 *
 * ## 为什么需要这个文件(task-57 的根因)
 *
 * `RoomRuntime` 有一个可选契约字段 `worldSaveHost`(见 `./net/room.ts` 的
 * `WorldSaveHost` 接口)。实测它在本文件出现之前的状况:
 *
 * ```
 * server/src/** 里 `worldSaveHost = ...` 赋值:**0 处**
 * 全部 6 处赋值在:scripts/_us2_*.ts (5) + tests/WS-FND-02.test.ts (1)
 * ⇒ 运行期恒为 null ⇒ room.ts 里所有 `if (this.worldSaveHost)` 整段不进
 * ⇒ 「世界状态低频落盘」与「等级投影」运行期从不发生
 * ```
 *
 * 而这**不是**「忘了接一行」:契约、字段、构造参数(`RoomRuntimeOptions.host`)
 * 全都齐备,**只差有人真的构造它**。没有人构造,就没有任何东西会报错 ——
 * `worldSaveHost` 是结构化接口 + 装配处用了 `?? null` ⇒ 漏掉是**静默**的。
 *
 * 这是本仓「测试全绿 + 生产零消费」家族的第 9 例,也是前 8 例共同的形状:
 * **检验的是「类能不能工作」,而不是「生产里它被装上了没有」。**
 *
 * ## 本文件的定位:装配的**单一定义点**
 *
 * ⚠️ 关键纪律:`assemble()` 产出的 `rtOpts` 与 `NetPersistRoom.onCreate` 里
 * 构造的那一份**是同一份记录**,见 `./net/room.colyseus.ts` 的 `rtOpts` 字面量
 * (在那里的行号会漂移,以字段名为准,共 9 个):
 *
 * ```
 *   roomId / ownerId / clock / name / accessMode /
 *   passwordHash / maxPlayers / worldSeed / host
 * ```
 *
 * **两边字段必须逐一对齐**。若在此处新增字段而不改房间那一份(或反之),
 * 会出现**两份装配并存** —— 那正是第 9 例的成因,不是它的解法。
 *
 * ## 为什么不直接 import `./net/room.colyseus.ts`
 *
 * 它**当前无法被 Node 加载**,有两个独立原因(均已实测):
 *
 * 1. 命名导入自 CommonJS:`import { Room, Client } from 'colyseus'` →
 *    `SyntaxError: Named export 'Client' not found.`
 * 2. 传递依赖 `./net/schema.colyseus.ts` 含 **44** 处 `@type` 装饰器
 *    (Colyseus 运行时必需,而 Node strip-only 无法擦除装饰器)
 *
 * ⇒ 本入口**刻意只装到 `RoomRuntime` 这一层**,不依赖 Colyseus 包。
 *   于是「世界被装进运行时」这件事今天就能被**加载、构造、断言**。
 *   房间那一层(把 rtOpts 交给 colyseus 壳)等 CR 裁决后,只需在此加一行转发。
 *
 * ## 可擦除语法铁律(本仓)
 *
 * 禁 `enum` / 构造参数属性 / `namespace` / 装饰器;相对 import **必须带 `.ts`**。
 * 本文件遵守上述全部约束,由 `scripts/verify.ts` 的「可擦除语法」一节守着。
 */

import { WorldSim } from './sim/world_sim.ts';
import { RoomRuntime, type RoomRuntimeOptions, type WorldSaveHost } from './net/room.ts';
import { AccessMode } from './db/repo.ts';
import type { DbLike } from './db/repo.ts';
/* ★ task-70:生产入口终于有了 `driver.sqlite.ts` 的**消费者**。
   接线前实测:`db/driver.sqlite.ts` 与 `db/memory_db.ts` 都只被**测试**引用
   (`memory_db` 由测试直接 new,`driver` 亦然)⇒ 生产跑起来永远纯内存
   ⇒ 与「读档恢复」直接冲突(没有库就没有档)。
   ⇒ 见 `AssembleDeps.dbPath` 与 `resolveDb`。 */
import { openNodeSqlite } from './db/driver.sqlite.ts';
import type { Clock } from './net/anticheat.ts';

/** 装配一次世界 + 运行时所需的全部外部依赖。 */
export interface AssembleDeps {
  /** 房间 id(落盘时用作主键)。 */
  roomId?: string;
  /** 房间归属者 id(权限判定用)。 */
  ownerId?: string;
  /** 注入时钟;省略则用 `Date.now()`。测试应传 `fixedClock` 以消除时间不确定性。 */
  clock?: Clock;
  /** 数据库;`null` = 纯内存(测试默认)。 */
  db?: DbLike | null;
  /**
   * SQLite 存档文件路径。**给出它就自动开真库**(task-70)。
   *
   * ## 为什么需要这个字段(而不是让调用方自己 `new SqliteDb(...)`)
   *
   * 实测:`db/driver.sqlite.ts` 与 `db/memory_db.ts` 在**生产入口里零消费者** ——
   * 两者都是「按 `DbLike` 结构化类型注入」的设计,而**注入点只有测试**。
   * ⇒ 表现为:生产路径跑起来永远是**纯内存**,重启即丢档,
   *   而这与「读档恢复」直接冲突(没有库就没有档)。
   * ⇒ 故这里给一个**生产入口自己开库**的路径。
   *
   * ## 与 `db` 的关系:`db` 优先
   *
   * `deps.db` 显式给了就用它(测试要注内存库);否则若给了 `dbPath` 就开真库;
   * 两者都没有 ⇒ `null`(纯内存,现状不变)。
   * ⇒ 顺序是「**显式注入 > 文件路径 > 无**」,不猜。
   */
  dbPath?: string;
  /** 世界边长(格),直接透传给 `WorldSim`。 */
  sizeCells?: number;
  /** 模拟随机流;注入后同种子完全可复现(测试用)。 */
  rng?: () => number;
  /** 战斗随机流(与 `rng` 独立,见 `WorldSim` 的 `combatRng` 注释)。 */
  combatRng?: () => number;
  /** 房间名与准入方式,与 `NetPersistRoom.onCreate` 的同名字段一一对应。 */
  name?: string;
  accessMode?: AccessMode;
  passwordHash?: string | null;
  maxPlayers?: number;
}

/** `assemble()` 的产物。`rtOpts` 可直接喂给 `new RoomRuntime(...)`。 */
export interface Assembled {
  /** 构造出来的世界存档源(结构化满足 `WorldSaveHost`)。 */
  host: WorldSaveHost;
  /** 房间运行时的构造参数 —— 与房间那一份**同一份记录**。 */
  rtOpts: RoomRuntimeOptions;
  /** 已装配好的运行时(测试与 `createServer` 都用它)。 */
  runtime: RoomRuntime;
}

/**
 * 构造世界存档源。
 *
 * 返回类型**显式写成 `WorldSaveHost`**(而不是 `WorldSim`):这样若 `WorldSim`
 * 哪天丢了 `saveToDb` / `attackMobAuthorized` / `levelOf` 中任何一个,
 * **本文件编译期就会报错**,而不是等到运行期在房间的 `if (host === null)` 里静默跳过。
 * ⇒ 让「契约被满足」成为编译期事实,而不是注释里的承诺。
 *
 * ⚠️ 但这条纪律的**代价**在 task-70 实测到了,值得写在这里:
 * `WorldSaveHost` 里**可选**(`?`)的成员,若 `WorldSim` 有而接口没声明,
 * 就会被**结构化裁掉** —— 即 `const h: WorldSaveHost = sim` 之后
 * `h.<该方法>` 在类型上**不存在**,而运行期它在。
 * ⇒ 本仓形态:「**能力存在而通路缺失**」(与陷阱 89 同族)。
 * ⇒ 故新增任何 `WorldSim` 能力并打算让房间用时,**必须同时**在
 *    `WorldSaveHost` 里声明,否则这行 `return sim` 会把它悄悄藏起来。
 */
export function createHost(deps: AssembleDeps = {}): WorldSaveHost {
  /* ⚠️ `WorldSimOptions` 只有 `sizeCells` / `fluidBudget` / `wiring` / `mobs` /
     `rng` / `combatRng` / `alchemy` 七个字段 —— **没有 `worldSeed`**。
     故这里只透传 `sizeCells`,并支持注入 `rng`/`combatRng` 以便测试完全可复现
     (`worldSeed` 是**房间参数**,由 `rtOpts` 承载,见 `assemble()`)。 */
  const sim = new WorldSim({
    /* 键**总是出现**(与房间侧 rtOpts 同一纪律:不靠条件展开省键)。 */
    sizeCells: deps.sizeCells,
    rng: deps.rng,
    combatRng: deps.combatRng,
  } as ConstructorParameters<typeof WorldSim>[0]);
  return sim;
}

/**
 * **生产装配路径**。把世界、运行时参数、运行时三件一起产出。
 *
 * ⚠️ 这是本仓唯一被断言覆盖的装配入口。测试**不应**写
 * `rt.worldSaveHost = sim`(那是手动装配,绕过了本函数,也绕过了断言)——
 * 本仓 8 例「测试全绿 + 生产零消费」的共同形态正是:测试手动装,生产没装。
 */
export function assemble(deps: AssembleDeps = {}): Assembled {
  const host = createHost(deps);

  /* 与 `./net/room.colyseus.ts` 的 `rtOpts` 字面量**逐字段对齐**。
     ⚠️ 对齐的是**键集**,不只是「有这些语义」:房间那一份里 9 个键**总是出现**
     (`name` / `maxPlayers` / `worldSeed` 的值可能是 `undefined`,但键在)。
     我第一版用了条件展开 `...(x === undefined ? {} : { x })`,键会缺席 ——
     被 `tests/WS-FND-09-wiring.test.ts` 的 FND9-9 当场抓出。
     ⇒ 这里全部**显式列出**,让两份的键集逐字相等。按键集相等来防分叉,
       比靠人读注释可靠(**这正是「两份装配并存」的检测手段**)。 */
  const rtOpts: RoomRuntimeOptions = {
    roomId: deps.roomId ?? 'room_main',
    ownerId: deps.ownerId ?? 'u_owner',
    clock: deps.clock ?? { nowMs: () => Date.now() },
    name: deps.name,
    accessMode: deps.accessMode ?? AccessMode.PUBLIC,
    passwordHash: deps.passwordHash ?? null,
    maxPlayers: deps.maxPlayers,
    worldSeed: deps.worldSeed,
    /* ★ 本行就是第 9 例的修复点:host **在此被真正赋给**运行时契约字段。
       此前全仓 `server/src/**` 里没有任何地方做这件事。
       房间侧对应行是 `host: this.deps?.host ?? null` —— 同一个 seam。 */
    host,
  };

  const runtime = new RoomRuntime(rtOpts, resolveDb(deps));
  return { host, rtOpts, runtime };
}

/**
 * 解析 `deps` 里的数据库来源(task-70)。
 *
 * ## 为什么把它抽成一个函数
 *
 * 「显式注入 > 文件路径 > 无」这个**优先级**本身是一条规则,
 * 散在 `assemble()` 里会与 `rtOpts` 的构造纠缠,看不清。
 * 抽出来之后它有一个**可单测的单一入口**,也便于将来加第三来源。
 *
 * ## 为什么开库放在这里而不是模块顶层
 *
 * 模块顶层开库会在**任何** import 本文件的场合(包括
 * `scripts/verify.ts` 的「入口可加载性」子进程检查)都去碰文件系统 ——
 * 那会让一个只读的加载性检查产生副作用。故只在**真的装配**时开。
 */
function resolveDb(deps: AssembleDeps): DbLike | null {
  /* 1 显式注入优先 —— 测试与别处已有连接都走这条,行为与接线前**逐字一致**。 */
  if (deps.db !== undefined) return deps.db;
  /* 2 给了路径 ⇒ 开真库。`openNodeSqlite` 是零依赖实现(见其 docblock)。 */
  if (typeof deps.dbPath === 'string' && deps.dbPath !== '') {
    return openNodeSqlite(deps.dbPath);
  }
  /* 3 两者都没有 ⇒ 纯内存(现状:不落盘)。 */
  return null;
}

/** `createServer()` 的产物。刻意不 `listen`,便于 CI 与测试零副作用地检查装配。 */
export interface AssembledServer {
  assembled: Assembled;
  /** 房间名 → 装配好的运行时。将来接 colyseus 时,这里换成 `Server` 实例。 */
  rooms: Map<string, RoomRuntime>;
  /** 装配摘要(供直接执行本文件时打印,不含任何密钥)。 */
  summary: string;
}

/**
 * 装配一个可用的服务端(**只装配,不监听端口**)。
 *
 * 为什么不在本函数里 `listen`:`scripts/verify.ts` 的「入口可加载性」检查会在
 * **子进程**里加载本文件,若是这里起了服务,CI 会挂住。⇒ 监听留给显式的
 * CLI 分支(见文件末尾的 `isMain` 段)。
 */
export function createServer(deps: AssembleDeps = {}): AssembledServer {
  const assembled = assemble(deps);
  const rooms = new Map<string, RoomRuntime>();
  rooms.set(assembled.runtime.id, assembled.runtime);

  const summary = [
    `装配完成:房间 ${assembled.runtime.id}`,
    `  世界存档源:${assembled.host === null ? 'null(异常)' : '已装配'}`,
    `  契约方法:saveToDb=${typeof assembled.host.saveToDb}`
      + ` / attackMobAuthorized=${typeof assembled.host.attackMobAuthorized}`
      + ` / levelOf=${typeof assembled.host.levelOf}`,
    `  运行时字段 worldSaveHost:${assembled.runtime.worldSaveHost === null ? 'null(异常)' : '非 null'}`,
  ].join('\n');

  return { assembled, rooms, summary };
}

/* ═══════════════════════ 直接执行时:只打印摘要,不监听 ═══════════════════════
 *
 * `process.argv[1]` 与 `import.meta.filename` 比较是 Node 里判断
 * 「本模块是否被直接运行」的标准做法。用 `endsWith` 而非 `===`,
 * 以兼容 Windows 的路径分隔符与大小写差异。
 *
 * ⚠️ 这里**不调用 `listen`**:本仓铁律是「CI 里不该起真服务」。
 * 将来若要真监听,应放在 `package.json` 的显式脚本里,并复用 `createServer()`。
 */
const invokedDirectly = ((): boolean => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const self = new URL(import.meta.url).pathname;
  return decodeURIComponent(self).endsWith(entry.replace(/\\/g, '/').split('/').slice(-3).join('/'));
})();

if (invokedDirectly) {
  const { summary } = createServer();
  console.log(`[server/src/index.ts] 装配入口(不监听端口)\n${summary}`);
}
