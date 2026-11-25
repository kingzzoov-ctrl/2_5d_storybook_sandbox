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
 *
 * ## ⚠️ 但「本文件能装」≠「生产链装上了」——本仓有**两条**装配路径(task-76)
 *
 * 本文件是 **A 路**;另一条是 **B 路**:`./net/room.colyseus.ts` 的 `onCreate`。
 * 两者各写一份 `rtOpts`、各自 `new RoomRuntime(...)` —— **「两条路」这一点没变**。
 *
 * ```
 * A 路 本文件 assemble()             rtOpts.host = host          ★ 已接上
 * B 路 room.colyseus.ts:onCreate()   rtOpts.host = resolveRoomHost(this.deps)
 *                                    无 deps / 无 host 键 ⇒ createHost()
 *                                    显式 `host: null`   ⇒ 保持 null(负对照入口)
 * ```
 *
 * ★ 2026-11-14:**B 路也接上了**。此前那行是 `this.deps?.host ?? null`,而 `deps`
 *   只由 `withDeps()` 注入、调用点 0 处 ⇒ 「B 路 host 恒为 null」成立。
 *   但**解法原本想错了**:缺的不是注入者,是**没人构造** ——
 *   而 `createHost()` 就在本文件里,且本文件不依赖 Colyseus
 *   ⇒ `room.colyseus.ts` 可以**单向** import 本文件。这就是本轮的修法。
 *
 * ⚠️ 所以「生产装配路径已存在 / host 不再是恒 null」这句现在对**两条路都成立**,
 *   但**仍必须带口径**:它们是**两条**路径,不是一条(各自构造一份 `RoomRuntime`)。
 *   `tests/WS-FND-12-wiring-paths.test.ts` 把这一点变成断言 —— 想合成一句就会红。
 *
 * ⚠️ 而**反方向**仍然不许:本文件一旦 import `./net/room.colyseus.ts`
 *   (**任何**形式,哪怕只为复用装配),本文件立刻变成**不可加载**(实测,见下节第 2 条),
 *   而它是 `PROD_ENTRIES` 成员 ⇒ 门禁的「入口可加载性」当场红。
 *   ⇒ 可行方向**只有** `room.colyseus.ts → 本文件` 这一条;那正是本轮用的方向。
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
 * ★ task-76 实测(把第 2 条从「据说」变成「量过」):构造一个只做
 *   `import './server/src/net/room.colyseus.ts'` 的临时模块,用 `verify.ts`
 *   `entryLoadable()` **同一判据**跑子进程:
 * ```
 * 基线 index.ts 本身            ⇒ ✓ 可加载
 * 闭包里多一个 room.colyseus.ts ⇒ ★ SyntaxError: Invalid or unexpected token
 * ```
 *   ⇒ 即「不可加载」这件事**会经由 import 边传染给 A 路**,不是只影响 B 路自己。
 *
 * ## 可擦除语法铁律(本仓)
 *
 * 禁 `enum` / 构造参数属性 / `namespace` / 装饰器;相对 import **必须带 `.ts`**。
 * 本文件遵守上述全部约束,由 `scripts/verify.ts` 的「可擦除语法」一节守着。
 */

import { WorldSim } from './sim/world_sim.ts';
/* ★ D-06:归档口要接给世界 —— 只 import **类型**与那一个写入函数;
   世界的归档回执形状(`WorldArchiveReceipt`)与 `repo.ts` 的
   `WorldArchiveSummary` 由下面 `makeArchiveSink` 的**字段搬运**对齐
   (对接错误 = 编译期红,而不是运行期一个空 id)。 */
import type { WorldArchiveRequest, WorldArchiveReceipt, WorldArchiveSink } from './sim/world_sim.ts';
/* ★ w85:设计过的世界。放在这里而不是 `net/room.ts`:装配层是**唯一**知道
   「本房间的世界该长什么样」的地方(与 `restoreWorldFromDb` 同处一地 ——
   盖图与读档的**顺序**是语义的一部分,分开写迟早漂移)。
   ⚠️ 文件在 `shared/**` 而不是 `server/**`:客户端要画**同一张图**
   (`client/src/stage/design_world.ts`),而客户端不许 import server。 */
import { applyWorldDesign, DESIGN_CENTER } from '../../shared/world/design.ts';
import {
  overworld, overworldCell, REGION_DEFS, REGION_SEA, SPAWN_POINT, TOWN_RADIUS, WORLD_CENTER, WORLD_SIZE,
} from '../../shared/world/overworld.ts';
import { setActiveNpcs } from './npc/defs.ts';
import { OVERWORLD_NPCS } from './npc/overworld_npcs.ts';
import { addScore, partyStateOf } from './net/actions/start_party.ts';
import { scoreOfPartyEvent } from './party/scoring.ts';
import { sleepStateOf } from './net/actions/sleep.ts';
import { setTownRadiusProvider } from './mobs/spawner.ts';
/* ★ w97:主线订阅器 —— 见下方装配处那条长注释(为什么必须有人调、以及 rebuildWorld 的缺口)。 */
import { attachMainline } from './quests/mainline_wiring.ts';
import { townSafeRadiusProvider } from './net/actions/modify_town.ts';
import { RoomRuntime, type RoomRuntimeOptions, type WorldSaveHost } from './net/room.ts';
import { AccessMode, archiveWorldSnapshot, createUser, getUser } from './db/repo.ts';
import type { DbLike } from './db/repo.ts';
/* ★ task-70:生产入口终于有了 `driver.sqlite.ts` 的**消费者**。
   接线前实测:`db/driver.sqlite.ts` 与 `db/memory_db.ts` 都只被**测试**引用
   (`memory_db` 由测试直接 new,`driver` 亦然)⇒ 生产跑起来永远纯内存
   ⇒ 与「读档恢复」直接冲突(没有库就没有档)。
   ⇒ 见 `AssembleDeps.dbPath` 与 `resolveDb`。 */
import { openNodeSqlite } from './db/driver.sqlite.ts';
import type { Clock } from './net/anticheat.ts';
/* ★ owner 裁定 2026-11-20(自动存档):默认文件库**先建目录再开库** ——
   `node:sqlite` 的 `DatabaseSync(path)` 不会替调用方建父目录,而默认路径
   `./.data/world.db` 的父目录在全新克隆里并不存在(开库当场 ENOENT)。
   只 import 两个 `node:` 内建:模块加载期**不碰文件系统**(见文件末尾的
   `invokedDirectly`,以及 `tests/WS-FND-09` 的 FND9-11)。 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * **服务端默认存档文件**(owner 裁定 2026-11-20:像 Minecraft 一样自动保存)。
 *
 * ## 为什么是相对路径
 * `scripts/play.ts` 用 `process.cwd()` 解析它 ⇒ 在仓根跑 `npm run play`,
 * 存档就落在 `<仓根>/.data/world.db`(`*.db` 已在 `.gitignore` 里)。
 * 换目录跑 = 另一个世界,这是**刻意的**:「我这一局的档在哪」由启动目录回答,
 * 不需要额外的配置项去记。
 *
 * ## 为什么不是 `:memory:`
 * 内存库的存档在进程退出时**全部消失** —— 那正是 owner 这次裁定要修的东西
 * (「像 Minecraft 一样自动保存」的前提是**有地方存**)。内存模式保留为
 * **显式**选项(`--memory` / `AssembleDeps.memory`),不是默认值。
 */
export const DEFAULT_DB_PATH = '.data/world.db';

/** 装配一次世界 + 运行时所需的全部外部依赖。 */
/** 主世界里自然资源被采走后多久长回来(秒)。 */
export const OVERWORLD_REGROW_SEC = 120;

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
   * ★ D-06:**世界归档口**(重置时把旧世界写成一份可回滚快照行)。
   *
   * 缺省时由 `db` **派生**(见下面的 `makeArchiveSink`):给了库就有归档能力,
   * 没给库就是"没有库"(重置会如实回 `archiveError`)。
   *
   * 显式注入这一条存在两个用途:
   *   1 **负对照**:`tests/WS-FND-62` 注入一个抛错的 sink,证明"归档失败
   *      ⇒ `applied` 仍是 true + `archiveError` 非空"。没有这个口就只能在
   *      测试里手动改装配后的对象 —— 而本仓的纪律是"别让测试手动装"。
   *   2 将来的网关/对象存储实现:归档不一定落在 SQLite 上。
   */
  archiveSink?: WorldArchiveSink | null;
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
   * ⇒ 顺序是「**显式注入 > 显式内存模式 > 文件路径 > 环境变量 > 默认文件库**」,不猜。
   *
   * ⚠️ 最后那一段(默认文件库)**只在服务端入口 `createServer()` 生效**,
   *   `assemble()` / `resolveAssembly()` 的零参默认仍是 `null`:
   *   `tests/WS-FND-37` 把「零参默认 = null」钉成 **B 路/A 路一致性**的判据,
   *   在那条判据改写之前,把默认值下沉到 `resolveDb` 会让两条既有断言变红。
   *   ⇒ 裁决落在**入口**(知道自己在跑服务的那一层),而不是解析器 —— 见 `createServer`。
   */
  dbPath?: string;
  /**
   * ★ **显式内存模式**(owner 裁定 2026-11-20):`true` = 不落盘,进程退出即丢。
   *
   * 存在的理由:自动存档成为默认之后,「我不想在磁盘上留东西」必须有**一条明确
   * 的声明路径**,而不是靠「忘了配路径」。CLI 侧对应 `node scripts/play.ts --memory`。
   *
   * 优先级:它只输给显式的 `db`(注对象时调用方自己负责语义),
   * 但**赢过** `dbPath` / `PI_DB_PATH` / 默认文件库 —— 显式关掉就是关掉,
   * 不许被环境变量静默推翻(与 `db: null` 的负对照同一纪律)。
   */
  memory?: boolean;
  /** 世界边长(格),直接透传给 `WorldSim`。 */
  sizeCells?: number;
  /** 模拟随机流;注入后同种子完全可复现(测试用)。 */
  rng?: () => number;
  /** 战斗随机流(与 `rng` 独立,见 `WorldSim` 的 `combatRng` 注释)。 */
  combatRng?: () => number;
  /** 是否生成野生动物(不传 = `WorldSim` 自己的默认)。 */
  mobs?: boolean;
  /**
   * 世界群系(刷怪配表 `BIOME_SPAWN` 的键)。不传 = `WorldSim` 自己的默认 `MEADOW`。
   * 本仓没有每格群系,见 `WorldSim.biomeName` 的注释。
   */
  /**
   * ★ 2026-11-26(w85):**盖上设计过的世界**(`server/src/world/design.ts`)。
   *
   * 不传 / `false` ⇒ **一格都不铺**,与改前逐字不变(世界是空的)。
   * 传 `true`    ⇒ 在 `restoreWorldFromDb` **之前**盖 192×192 的设计图
   * (11 个区 / 环形主干道 + 四条主路 / 跨海栈桥 / 地标)。
   *
   * ⚠️ 为什么必须**在读档之前**:读档的语义是「库里有的块覆盖、缺的块按新世界
   * 默认格」⇒ 先盖设计图,存档里玩家改过的地形才盖得住它。反过来就变成
   * 「每次开服都把玩家动过的地图推平」—— 那种缺陷只在**重启之后**才看得见。
   */
  design?: boolean;
  /**
   * 主世界(`shared/world/overworld.ts`,512×512 的晨曦群岛)。给了它:
   * 边长固定为 512,地形碰撞、围绕玩家刷怪、资源再生一并打开,NPC 名册换成主世界那 19 位,
   * 出生点在镇广场。与 `design` 互斥(两个都给以本项为准)。
   */
  overworld?: boolean;
  biome?: string;
  /** 房间名与准入方式,与 `NetPersistRoom.onCreate` 的同名字段一一对应。 */
  name?: string;
  accessMode?: AccessMode;
  passwordHash?: string | null;
  maxPlayers?: number;
  /**
   * 世界随机种子 —— **房间参数**,由 `rtOpts` 承载,不传给 `WorldSim`。
   *
   * ## 本字段是 task-76 补上的,补的是一个**静默失效**
   *
   * 接线前的实测:`assemble()` 的 `rtOpts` 里写着 `worldSeed: deps.worldSeed`(L174),
   * 而 `AssembleDeps` **没有** `worldSeed` 这个键。两个后果:
   *
   * ```
   * 1 类型层:`tsc --noEmit` 报 TS2339 `Property 'worldSeed' does not exist`
   *    ⇒ 但本仓用 Node 原生类型擦除,**不做类型检查** ⇒ 这条错误从不生效;
   * 2 运行层:调用方传 `assemble({ worldSeed: 7 })`,那 7 **确实**流进了
   *    `rtOpts.worldSeed` —— 因为对象字面量的键在运行期不看类型。
   * ```
   *
   * ⇒ 这不是「坏了」,而是「**类型与实现不一致**」:类型说没有,实现说有,
   *   于是任何**按类型**书写的调用方(以及 IDE 补全)都不会想到可以传种子,
   *   而 `tests/WS-FND-09-wiring.test.ts` 的 FND9-9 一直在传 —— 它踩得到,
   *   只是因为传的是**多余键**,类型擦除后无害。
   * ⇒ 补上声明后,类型与实现一致;这条也是「类型擦除仓里,类型错误
   *   只能靠 `npm run typecheck`(可选步骤)发现」的一个实例。
   */
  worldSeed?: number;
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

/**
 * 把**世界侧读口**装到 host 上(全部注入的**唯一**落点)。
 *
 * ## 为什么必须是"唯一落点"(这条是审查抓出来的真缺陷)
 *
 * 第一版把这几行写在 `assemble()` 里 ⇒ **生产(Colyseus)路径全空**:
 * `room.colyseus.ts` 走 `resolveRoomHost()` → `createHost()`,**不经过 `assemble()`**
 * ⇒ 赛局分数恒 0、`lastRoomEffects[].sleeping` 恒 0、城镇半径永远退回 24,
 * 而 `WS-FND-43/44/45` 三条套件**全绿**(它们都用 `assemble()`)。
 * 这正是本仓点名的「测试手动装、生产没装」形态。
 * ⇒ 装在这里:`createHost()` 是**两条路共同的**造世界入口。
 *
 * ⚠️ `roomId` 必须与运行时用的是**同一个值**;否则世界问的是**别人的**配置
 * (审查 A2:世界拿 `''`、运行时拿 `'room_main'` ⇒ 配置写在 `room_main`、
 * 世界去问 `''` 拿回出厂 24 —— 数值上恰好与"没配"相同,所以没有断言会红)。
 */
function wireHost(host: WorldSaveHost, roomId: string): void {
  /* 1 赛局计分:世界报告事实 → 规则换算 → `addScore`。 */
  const partyHost = host as unknown as {
    attachPartyScoreSink?: (fn: (ev: { kind: string; source?: string }) => void) => void;
  };
  partyHost.attachPartyScoreSink?.((ev) => {
    const st = partyStateOf(roomId);
    if (st === null) return; /* 没开局 ⇒ 不计分(没有"分数"这个对象) */
    if (ev.source === undefined || ev.source === '') return; /* 无归属 ⇒ 不猜谁得分 */
    const award = scoreOfPartyEvent(st.mode, ev);
    if (award.points > 0) addScore(roomId, ev.source, award.points);
  });

  /* 2 城镇配置 → 刷怪器(装配层是唯一同时认识两边的地方,依赖单向)。 */
  setTownRadiusProvider(townSafeRadiusProvider);

  /* 3 睡眠读口:只**读**事实,不改任何回血数值(平衡性是产品裁决,不是接线)。 */
  const sleepHost = host as unknown as { attachSleepSource?: (fn: (u: string) => boolean) => void };
  sleepHost.attachSleepSource?.((userId: string) => sleepStateOf(roomId, userId).sleeping);
}
/**
 * 把 `repo.archiveWorldSnapshot` 适配成世界侧的**归档口**(★ D-06)。
 *
 * 为什么适配住在装配层:`WorldSim` 的 `WorldArchiveRequest` 刻意不 import 存储层
 * 类型(见那边的注释),`repo.ts` 也不认识世界 —— 本文件是**唯一**同时认识两侧的
 * 地方 ⇒ 形状对齐在这里发生,**错了是编译期红**(`archived_at` 拼成 `archivedAt`
 * 会当场 `TS2339`),而不是运行期一个 `undefined` 混进回执。
 *
 * ⚠️ 只搬四个字段:回执要的是"可判定的句柄 + 可显示的摘要",
 * 把整个 `WorldArchiveWriteResult`(含 `pruned` / BLOB)摊给世界没有消费者,
 * 却会把存储层的形状泄漏进模拟层。
 */
function makeArchiveSink(db: DbLike): WorldArchiveSink {
  return (req: WorldArchiveRequest): WorldArchiveReceipt => {
    const r = archiveWorldSnapshot(db, {
      roomId: req.roomId,
      seed: req.seed,
      snapshot: req.snapshot,
      nowMs: req.nowMs,
      worldTick: req.worldTick,
      reason: req.reason,
    });
    const receipt: WorldArchiveReceipt = {
      id: r.archived.id,
      seed: r.archived.seed,
      archived_at: r.archived.archived_at,
      bytes: r.archived.bytes,
    };
    /* ★ B / D-19 第 5 条:**裁剪四件不许丢**。
       此前这里只搬四个字段,于是 `repo.archiveWorldSnapshot` 辛苦算出的
       `trim`(裁了几块 / 多少字节 / 为什么)在装配层**第一次**被丢掉,
       `WorldSim.archiveBeforeReset` 又会再丢一次 —— 结果是「归档成功了」
       与「归档是裁过的」在回执里完全一样,而回滚恰恰要读这个事实
       (`world/archive.ts:planRestore` 的 `missingChunks`)。

       映射是**逐字段原样搬运**:本层不重写原因文本、不算新的计数
       (`reason` / `rule` 都来自 `ArchiveTrimReport`,那是唯一事实源)。
       `status` 在这里恒为 `TRIMMED` —— 没裁过时 `r.trim` 是 `undefined`,
       键**直接缺席**(与 `WorldArchiveTrimReceipt` 的三态纪律一致)。 */
    if (r.trim !== undefined) {
      receipt.trim = {
        status: 'TRIMMED',
        droppedChunks: r.trim.droppedChunks,
        droppedBytes: r.trim.droppedBytes,
        reason: r.trim.reason,
        rule: r.trim.rule,
      };
    }
    return receipt;
  };
}

/**
 * @param db 本房间**正在用的**那个库(由 `assemble` / `resolveAssembly` 解析一次
 *           后传进来)。**不在这里调 `resolveDb`** —— 那会为同一个 `dbPath`
 *           开第二条连接,而 `:memory:` 下那会是**另一个库**:
 *           归档写进 A、房间读 B,于是"重置归档成功但列表里没有" —— 静默错。
 *           缺省 `null` ⇒ 世界没有归档口(重置**如实**回 `archiveError`)。
 */
export function createHost(deps: AssembleDeps = {}, db: DbLike | null = null): WorldSaveHost {
  /* ★ 房间号的**唯一**默认值:`createHost` 与 `assemble` 的 `rtOpts` 必须同源,
     否则世界与运行时问的是两个房间(A2)。 */
  const roomId = deps.roomId ?? 'room_main';
  /* ★ D-06 归档口:显式注入优先(`deps.archiveSink`),否则由**库**派生。
     `deps.db` 也认(调用方显式给了同一个库对象时,不必再传第二遍)。 */
  const archiveDb = db ?? deps.db ?? null;
  const archiveSink: WorldArchiveSink | null =
    deps.archiveSink ?? (archiveDb === null ? null : makeArchiveSink(archiveDb));
  /* ⚠️ `WorldSimOptions` 透传的口子见那边的 interface。**没有 `worldSeed`**:
     `worldSeed` 是**房间参数**(由 `rtOpts` 承载,见 `assemble()`),而世界侧
     对应的是 `seed`(随机流的**身份**,见 `WorldSimOptions.seed`)。
     ⇒ 两者**同源**但不共用一个名字:房间的 `worldSeed` 是「这一局的世界身份」,
     世界的 `seed` 是「这条随机流的身份」;装配层把它们接成同一个值
     (`seed: deps.worldSeed`),世界内部不再第二份推导。
     ★ 加 `biome` 的理由:本仓没有每格群系,「世界群系」只能是一个**显式选择**,
       而它是刷怪配表的键 ⇒ 不透传就等于让刷怪永远只走兜底。 */
  const ow = deps.overworld === true ? overworld() : null;
  const regionIdAt = (x: number, y: number): string | null => {
    if (ow === null || x < 0 || y < 0 || x >= ow.size || y >= ow.size) return null;
    const r = ow.region[y * ow.size + x]!;
    return r === REGION_SEA ? null : REGION_DEFS[r]!.id;
  };
  const sim = new WorldSim({
    /* 键**总是出现**(与房间侧 rtOpts 同一纪律:不靠条件展开省键)。 */
    sizeCells: ow === null ? deps.sizeCells : WORLD_SIZE,
    ...(ow === null ? {} : {
      regionAt: regionIdAt,
      biomeAt: (x: number, y: number): string | null => {
        const r = ow.region[y * ow.size + x];
        return r === undefined || r === REGION_SEA || x < 0 || y < 0 || x >= ow.size ? null : REGION_DEFS[r]!.biome;
      },
      townCenter: { x: WORLD_CENTER, y: WORLD_CENTER },
      collision: true,
      spawnNearPlayers: true,
      regrowSec: OVERWORLD_REGROW_SEC,
      nativeObjAt: (x: number, y: number): number => overworldCell(ow, x, y)?.obj ?? 0,
    }),
    rng: deps.rng,
    combatRng: deps.combatRng,
    /* ★ 2026-11-14:`mobs` 透传。此前这里只传 sizeCells/rng/combatRng ⇒
       `assemble()` 造出来的世界里**没有怪**,而 `applyAttack` 需要 mobId ⇒
       「能玩」这条路上打怪永远空转。启动器(`scripts/play.ts`)用它把世界填满。 */
    mobs: deps.mobs,
    /* ★ 2026-11-14:`biome` 透传。它与 `mobs` 是一对:不传 `mobs` 世界里没怪,
       不传 `biome` 刷怪只会走 `?? BIOME_SPAWN.MEADOW` 的兜底 ——
       而那个兜底**没有任何地方会显示出来**。 */
    biome: deps.biome,
    /* ★ 房间号透传给世界:刷怪要靠它去问「本房间的安全区半径」
       (`modify_town.ts` 的配置从此真的生效;没给 ⇒ 退回常量 24)。 */
    roomId,
    /* ★ D-06:世界的**种子身份**。没给 ⇒ 世界用它自己的默认 `0x5eed`
       (那确实就是它那条流的种子,如实记,不猜)。 */
    seed: deps.worldSeed,
    /* ★ D-06:归档口。`null` = 没有库 ⇒ 重置回 `archiveError`(如实)。 */
    archiveSink,
  } as ConstructorParameters<typeof WorldSim>[0]);
  /* ★ WS-FND-164(B1 审计 P0):**库里有本房间的世界 ⇒ 读回来**,不按 seed 重生成。
   *
   * ## 为什么挂在这里
   * `createHost()` 是**两条路共同的**造世界入口(`assemble()` 与
   * `room.colyseus.ts` 的 `resolveRoomHost()`),读档必须和造世界同处一地 ——
   * 挂在其中一条路上,另一条路上的进程就会得到一张空地图,而那种缺陷不报错。
   *
   * ## 三态(都由宿主自己判定,这里不替它猜)
   * ```text
   * archiveDb === null  ⇒ 没有库 ⇒ 不读(applied:false, reason:'no-db')
   * 库里没有本房间存档   ⇒ 按 seed 新建(applied:false, reason:'no-save')
   * 库里有存档          ⇒ 逐块读回并重建(applied:true;缺的块按新世界默认格)
   * ```
   * 「读不回来」与「按 seed 新建」都是**正常路径**,所以这里不抛错;
   * 读档口自己会把块数 / 缺块 / 水位格数报出来(`restoreWorldFromDb` 的回执),
   * 需要断言的调用方直接读那个方法即可(它就在返回的 host 上)。
   *
   * ⚠️ 放在 `wireHost()` **之前**:`rebuildWorld` 会换掉世界子系统(地形 / 流体 /
   * 物理 / 生物),而 `wireHost` 挂的是与世代无关的接线(归档口 / 计分 sink /
   * 睡眠读口 / 城镇半径 provider)。先读档再接线 ⇒ 不存在"接线挂在已被换掉的对象上"。
   * `archiveDb` 是「本房间正在用的那个库」(名字来自 D-06,值 = `db ?? deps.db`)。 */
  /* ★ 2026-11-26(w85):设计图 —— **必须**在 `restoreWorldFromDb` 之前盖。
     理由见 `AssembleDeps.design` 的注释(读档只覆盖库里有的块)。 */
  if (ow !== null) {
    /* 主世界整张铺上去(与设计图同一条顺序纪律:先铺图,再读档,存档里改过的块才盖得住它)。 */
    for (let y = 0; y < ow.size; y += 1) {
      for (let x = 0; x < ow.size; x += 1) {
        const c = overworldCell(ow, x, y)!;
        sim.setCell(x, y, { elev: c.elev, base: c.base, floor: c.floor, obj: c.obj });
      }
    }
    setActiveNpcs(OVERWORLD_NPCS);
  } else if (deps.design === true) applyWorldDesign(sim, { size: sim.sizeCells });
  sim.restoreWorldFromDb(archiveDb, roomId);
  wireHost(sim, roomId);
  /* 主世界的镇子比小地图大:安全区至少盖住整个镇区(房主把半径调得更大时以他的为准)。 */
  if (ow !== null) setTownRadiusProvider((id) => Math.max(TOWN_RADIUS, townSafeRadiusProvider(id)));

  /* ★ w97:**主线订阅**。`world_sim` 在六个成功点(采集/合成/放置/换区/击杀/Boss)把事件发到
     自己的 `bus` 上,这里把状态机挂上去 —— 不挂的话 `applyEvent` 永远不被调用,
     主线会**静静停在第一步**(没有任何报错,玩家也看不出)。
     ⚠️ 已知缺口:`WorldSim.rebuildWorld()` 会 `new EventBus()`(换代),
     那一刻订阅会随之消失 ⇒ 重置/读档之后主线不再推进。补齐的做法是在 `rebuildWorld`
     里重新 `attachMainline(this.bus)` —— 那需要 `world_sim` 反向持有订阅器,属下一刀。 */
  attachMainline(sim.bus);
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
  /* ★ 库**只解析一次**,同一个对象交给 host(归档口)与运行时(落盘/读档)。
     分两次解析在 `dbPath` 下会开两条连接、在 `:memory:` 下会是**两个库** ——
     于是"重置归档了一行,房间里读不到"这种静默错就有了入口。 */
  const db = resolveDb(deps);
  /* ★ owner 裁定 2026-11-20(自动存档):**我们自己开的**文件库必须先有房主。
     `Repo.createRoom` 对不存在的房主**直接抛**(「房主不存在」),而
     `RoomRuntime` 的构造器第一步就是 `createRoom` ⇒ 一个全新的
     `./.data/world.db` 上,`assemble({ dbPath })` **根本走不过去**
     (实测:`npm run play` 第一次运行就停在装配那一步)。
     ⇒ 装配层补这一行。它不替**注入的**库做(`deps.db` 由调用方自己负责 ——
       那正是 `tests/**` 里那些夹具的既有语义,不该被这里静默改掉)。
     ⚠️ 只补**房主**:其他用户由 `room.join()` 按需建(`room.ts` 的既有行为)。 */
  if (db !== null && deps.db === undefined) ensureOwnerUser(db, deps.ownerId ?? 'u_owner', deps.clock?.nowMs() ?? Date.now());
  const host = createHost(deps, db);
  const roomId = deps.roomId ?? 'room_main';



  /* 与 `./net/room.colyseus.ts` 的 `rtOpts` 字面量**逐字段对齐**。
     ⚠️ 对齐的是**键集**,不只是「有这些语义」:房间那一份里 9 个键**总是出现**
     (`name` / `maxPlayers` / `worldSeed` 的值可能是 `undefined`,但键在)。
     我第一版用了条件展开 `...(x === undefined ? {} : { x })`,键会缺席 ——
     被 `tests/WS-FND-09-wiring.test.ts` 的 FND9-9 当场抓出。
     ⇒ 这里全部**显式列出**,让两份的键集逐字相等。按键集相等来防分叉,
       比靠人读注释可靠(**这正是「两份装配并存」的检测手段**)。 */
  const rtOpts: RoomRuntimeOptions = {
    roomId,
    ownerId: deps.ownerId ?? 'u_owner',
    clock: deps.clock ?? { nowMs: () => Date.now() },
    name: deps.name,
    accessMode: deps.accessMode ?? AccessMode.PUBLIC,
    passwordHash: deps.passwordHash ?? null,
    maxPlayers: deps.maxPlayers,
    worldSeed: deps.worldSeed,
    /* ★ w85:设计过的世界出生点在地图中心(原点是海)。缺省 `undefined`
       ⇒ `spawnPoint()` 与改前逐字相同。⚠️ 这个键**必须**与
       `room.colyseus.ts` 的 rtOpts 键集一致(FND9-9 守两侧)。 */
    spawnOrigin: deps.design === true ? { x: DESIGN_CENTER, y: DESIGN_CENTER } : undefined,
    /* 主世界的出生点在镇广场(键写在后面 ⇒ 覆盖上一行;两个开关都没给时两行都是 undefined)。 */
    ...(deps.overworld === true ? { spawnOrigin: { x: SPAWN_POINT.x, y: SPAWN_POINT.y } } : {}),
    /* ★ 本行就是第 9 例的修复点:host **在此被真正赋给**运行时契约字段。
       此前全仓 `server/src/**` 里没有任何地方做这件事。
       房间侧对应行是 `host: resolveRoomHost(this.deps)` —— 同一个 seam,
       而它**也已接上**(2026-11-14),所以这块不再是「两条路分叉」,
       只剩「两条路各写一份」这个结构性事实(见 `WS-FND-12`)。 */
    host,
  };

  const runtime = new RoomRuntime(rtOpts, db);

  /* ★ 把**睡眠读口**接进世界:装配层是唯一知道"本房间 id"的地方,
     而 `WorldSim` 不 import `net/actions/**`(那会让 sim 依赖 net)⇒ 在这里注入闭包,依赖单向。
     ⚠️ 只**读**事实("这人正在睡吗"),不改变任何回血数值 —— 平衡性改动是产品裁决,不是接线。 */
  const sleepHost = host as unknown as { attachSleepSource?: (fn: (u: string) => boolean) => void };
  sleepHost.attachSleepSource?.((userId: string) => sleepStateOf(rtOpts.roomId, userId).sleeping);
  return { host, rtOpts, runtime };
}

/**
 * **打开一个可直接用的文件库**(建目录 → 开库 → 建表/迁移)。
 *
 * ## 为什么这三步必须一起做(而不是只 `openNodeSqlite`)
 * 实测过的两个坑,都是「开得开、但一写就炸」:
 * ```
 * 1 `DatabaseSync('./.data/world.db')` 的父目录不存在 ⇒ ENOENT(开库当场抛)
 * 2 开得开但**没建表** ⇒ 第一次 `saveToDb` 抛 `no such table: users`
 *   ⇒ 而那正是自动存档第一次触发时(离场 / 30 秒 / 销毁)才发生的事,
 *     表现为「玩了几分钟,退出时控制台一条错,档没了」
 * ```
 * ⇒ `bootstrap()`(migrate + 归档 checksum 校验)与 `bootstrapWorldArchives()`
 *   (建第 10 张表,`RESET_WORLD` 的归档要有地方写)都在这里做一次。
 *
 * ⚠️ **只对我们自己开的库**做:注入的 `deps.db`(测试的 `MemoryDb` 等)
 *   由调用方自己 `migrate` —— 在装配层替它建表会掩盖「测试漏了 migrate」。
 */
function openDbFile(path: string, nowMs: number): DbLike {
  /* `:memory:` 没有目录可言(`dirname(':memory:')` = '.',建它无害但没意义)。 */
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = openNodeSqlite(path);
  /* 失败**不吞**:迁移漂移是 fail-closed 的(见 `SqliteDb.bootstrap` 的 docblock),
     在这里吞掉等于「带着不确定的结构跑起来」。 */
  db.bootstrap(nowMs);
  db.bootstrapWorldArchives(nowMs);
  return db;
}

/**
 * 确保 `ownerId` 在 `users` 里存在(**只对**装配层自己开的库调用)。
 *
 * 为什么需要它:`repo.createRoom` 有一条守卫「房主不存在」,而
 * `RoomRuntime` 的构造器第一步就是 `createRoom`。于是「默认文件库」这件事
 * 在**全新**路径上第一次就会撞上它 —— 而报错发生在装配,离「存档」很远,
 * 容易被当成两件不相干的事(实测就是如此)。
 *
 * 幂等:已存在就什么都不做(`getUser` 先查)。显示名取 id —— 本仓没有
 * 「真实昵称」这一格,也不该在装配层编一个。
 */
function ensureOwnerUser(db: DbLike, ownerId: string, nowMs: number): void {
  if (ownerId === '' || getUser(db, ownerId) !== undefined) return;
  createUser(db, { id: ownerId, displayName: ownerId, nowMs });
}

/**
 * 解析 `deps` 里的数据库来源(task-70;owner 裁定 2026-11-20 起有**内存模式**)。
 *
 * ## 为什么把它抽成一个函数
 *
 * 「显式注入 > 内存模式 > 文件路径 > 环境变量 > 无」这个**优先级**本身是一条规则,
 * 散在 `assemble()` 里会与 `rtOpts` 的构造纠缠,看不清。
 * 抽出来之后它有一个**可单测的单一入口**,也便于将来加第五来源。
 *
 * ## 为什么开库放在这里而不是模块顶层
 *
 * 模块顶层开库会在**任何** import 本文件的场合(包括
 * `scripts/verify.ts` 的「入口可加载性」子进程检查)都去碰文件系统 ——
 * 那会让一个只读的加载性检查产生副作用。故只在**真的装配**时开。
 *
 * ## 为什么零参默认仍是 `null`(而不是 `DEFAULT_DB_PATH`)
 *
 * `tests/WS-FND-37` 把「`resolveAssembly()` 零参 ⇒ `db === null`」钉成
 * **A 路/B 路一致性 + 负对照入口**的判据。默认文件库是 **owner 的裁决**,
 * 它落在**知道自己在跑服务**的那一层(`createServer` / `scripts/play.ts`),
 * 不落在解析器 —— 否则那两条断言会把「默认值变了」误报成「两条路分叉了」。
 */
function resolveDb(deps: AssembleDeps): DbLike | null {
  const now = deps.clock?.nowMs() ?? Date.now();
  /* 1 显式注入优先 —— 测试与别处已有连接都走这条,行为与接线前**逐字一致**。 */
  if (deps.db !== undefined) return deps.db;
  /* 2 显式内存模式 —— 赢过下面所有「会落盘」的来源(见 `AssembleDeps.memory`)。 */
  if (deps.memory === true) return null;
  /* 3 给了路径 ⇒ 开真库(建目录 + 建表,见 `openDbFile`)。 */
  if (typeof deps.dbPath === 'string' && deps.dbPath !== '') {
    return openDbFile(deps.dbPath, now);
  }
  /* 4 **部署开关**:`PI_DB_PATH`。
   *
   * 为什么要有这一条:在此之前,`assemble()` 与 B 路(`net/room.colyseus.ts`)在生产
   * 都拿不到库 ⇒ 「落盘 / 读档」两条路**永不执行**,而写代码的人以为它们在跑。
   * `PI_DB_PATH=:memory:` 也能用(内存库:路径会真的执行,但不留文件)。
   */
  const fromEnv = typeof process !== 'undefined' ? process.env?.PI_DB_PATH : undefined;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return openDbFile(fromEnv, now);
  }
  /* 5 都没有 ⇒ `null`(不落盘)。**入口**会在需要时补上 `DEFAULT_DB_PATH`,
     见 `createServer` —— 这里不补,理由见上。 */
  return null;
}

/**
 * A/B 两路**共用**的「世界 + 库」解析 —— 存在的唯一理由是**防分叉**。
 *
 * `assemble()`(A 路)与 `net/room.colyseus.ts`(B 路)各自 `new RoomRuntime`,
 * 但两者取 host 与 db 的**规则必须一致**。此前 B 路自己写 `this.deps?.db ?? null`,
 * 于是 deps 缺省时:A 路按 `resolveDb` 走(给了 `dbPath` 就开真库),B 路直接 `null`
 * —— 同一个装配语义有两种答案,而两者都"看起来合理"。
 *
 * 规则与 `resolveDb` 逐条相同:
 *   1 显式 `db` 优先;2 `memory: true` ⇒ `null`;3 给了 `dbPath` ⇒ 开真库;
 *   4 `PI_DB_PATH`;5 都没有 ⇒ `null`(**不落盘** —— 落到**入口**去补默认值)。
 *
 * ⚠️ 第 3 条是**刻意的现状**,不是遗漏:生产里至今没有任何地方给 B 路提供库
 *   (`withDeps` 零调用点,Colyseus 也不会把 deps 传给 `onCreate`),
 *   所以「落盘 / 读档永不发生」是一条**已知边界**,不是 bug。
 *   要让它真的发生,缺的**不是接线**,而是「库从哪来」的裁决(文件路径?env 变量?存哪?)。
 */
export function resolveAssembly(
  deps: AssembleDeps = {},
): { host: WorldSaveHost; db: DbLike | null } {
  /* ★ D-06:库**只解析一次**并同时交给 host(归档口)与房间(落盘/读档)——
     见 `assemble()` 里的同一条注释。 */
  const db = resolveDb(deps);
  return { host: createHost(deps, db), db };
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
 * ★ **服务端默认存档路径的落点**(owner 裁定 2026-11-20:像 Minecraft 一样自动保存)。
 *
 * ## 为什么补默认值的动作在**入口**,不在 `resolveDb`
 *
 * 「默认落盘」是 owner 对**生产服务**的裁决;而 `resolveDb` 是**两条装配路共用**
 * 的解析器,`tests/WS-FND-37` 在那里钉着「零参默认 = `null`」这条
 * A/B 一致性与负对照的判据。把默认值下沉进去,红的是那两条断言 ——
 * 而它们红的时候**看起来像「两条路分叉了」**,不是「默认值变了」。
 * ⇒ 裁决放在唯一知道「我在跑服务」的那一层:`createServer()` 与 `scripts/play.ts`。
 *
 * ## 谁**赢**过这个默认值
 * ```
 * deps.db 有键       ⇒ 用它(含 null:调用方显式接管语义)
 * deps.memory        ⇒ 不落盘(显式内存模式)
 * deps.dbPath        ⇒ 用它
 * PI_DB_PATH 有值    ⇒ 用它(env 是**部署**开关,该盖过默认值,否则线上没法定制路径)
 * 都没有             ⇒ DEFAULT_DB_PATH
 * ```
 */
function withServerDbDefaults(deps: AssembleDeps): AssembleDeps {
  if (deps.db !== undefined) return deps;
  if (deps.memory === true) return deps;
  if (typeof deps.dbPath === 'string' && deps.dbPath !== '') return deps;
  const fromEnv = typeof process !== 'undefined' ? process.env?.PI_DB_PATH : undefined;
  if (typeof fromEnv === 'string' && fromEnv !== '') return deps;
  return { ...deps, dbPath: DEFAULT_DB_PATH };
}

/**
 * 装配一个可用的服务端(**只装配,不监听端口**)。
 *
 * 为什么不在本函数里 `listen`:`scripts/verify.ts` 的「入口可加载性」检查会在
 * **子进程**里加载本文件,若是这里起了服务,CI 会挂住。⇒ 监听留给显式的
 * CLI 分支(见文件末尾的 `isMain` 段)。
 *
 * ★ 2026-11-20:本入口**默认落盘**(`DEFAULT_DB_PATH`),除非调用方显式给
 *   `memory: true`。这是 owner「像 Minecraft 一样自动保存」裁定的**装配侧**一半;
 *   另一半是房间的周期/离场/销毁/重置自动存档(见 `net/room.ts` 的 `saveWorldNow`)。
 */
export function createServer(deps: AssembleDeps = {}): AssembledServer {
  const assembled = assemble(withServerDbDefaults(deps));
  const rooms = new Map<string, RoomRuntime>();
  rooms.set(assembled.runtime.id, assembled.runtime);

  const summary = [
    `装配完成:房间 ${assembled.runtime.id}`,
    `  世界存档源:${assembled.host === null ? 'null(异常)' : '已装配'}`,
    `  契约方法:saveToDb=${typeof assembled.host.saveToDb}`
      + ` / attackMobAuthorized=${typeof assembled.host.attackMobAuthorized}`
      + ` / levelOf=${typeof assembled.host.levelOf}`,
    /* ★ 自动存档的**可观测前提**:没有库就没有档 —— 摘要里必须一眼看出来。 */
    `  数据库:${assembled.runtime.db === null
      ? 'null(内存模式:不落盘,退出即丢)'
      : '已开库(周期/离场/销毁/重置自动存档生效)'}`,
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
