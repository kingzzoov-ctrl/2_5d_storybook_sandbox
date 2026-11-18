/**
 * `PLACE_AUTOMATION` —— 把**一件自动化件落到某个格子**(登记 + 可查)。
 *
 * ## ⚠️ 边界:本动作**不创建世界实体**
 *
 * 本文件**没有** import `world_sim.ts`,也**没有**碰 `wiring/**`。组件形态只做两件事:
 * ```ts
 *   1 用 `hasComponentKind(kind)` 判定 kind 是不是**已注册的逻辑件种类**
 *     —— 唯一出处是 `wiring/graph.ts` 的注册表(由 `wiring/components.ts` 在模块
 *     加载时填满 401~440 那 40 项;本文件 `import { SPEC_BY_KIND }` 只是为了让那张
 *     规格表**在本模块加载时**就完成注册副作用,并顺手读它的 `id` 进回执,
 *     **不另写第二张组件表**);
 *   2 把「谁在哪个房间的哪一格放了什么、什么时候」登记进本模块的 per-room 表。
 * ```
 * ⇒ 所以「放进去了」目前只到 **登记 + 可查**(`placementsOfRoom` / `placementAt`)。
 *   电路求值(`wiring/graph.ts` 的 `SignalGraph.addComponent` / `propagate`)**不会**
 *   因为这条记录而开始工作 —— 世界侧今天**没有任何读者**。要让「放下的件真的参与
 *   求值」,得在世界侧把本表接进 `WorldSim.wiring`(那个 `SignalGraph` 的构造点
 *   `world_sim.ts:917`),那不在本次可改范围内。与 `actions/modify_town.ts` 同一形态
 *   的诚实说法:**「登记 + 可查」已接线;「放下去就通电」没有。**
 *
 * ## ★ WS-FND-119:本动作现在有**两个形态**,其中一个是三个「喂料口」之一
 *
 * 第六轮实测:P0 —— `WorldSim` 的三个写入口(`setRanchPets` / `plantCrop` /
 * `setSortFilters`)在 `server/**` 内**零调用**,唯一调用方是 `tests/**`。
 * ⇒ 生产里 `crops` / `sortFilters` 恒空,温室的 `advanceRoomSystems` 分支与
 * 429 的 `sortHarvest` 每慢帧空跑(牧场那一口在 `BREED_TAME` 的 `RANCH` 子操作上,
 * 见 `breed_tame.ts`)。
 *
 * 本动作因此多了两个**世界侧副作用**(判定在 `systems/intake.ts` 与 `plant_crop.ts`,
 * 世界写入仍只由宿主做,本文件不 import 模拟层):
 *
 * ```
 * { itemId, x, y }                        ⇒ 播种(种子 + 格位)         → host.plantCrop
 * { kind: 'LOGISTICS_SORTER', x, y, lane, itemId }
 *                                        ⇒ 429 的这一道收哪一件       → host.setSortFilters
 * ```
 *
 * ⚠️ 播种为什么挂在本动作而不是一个独立的 `PLANT_CROP`:`RoomAction` 里**没有**播种
 *   动作,加一个要同时改 `net/room.ts`(枚举 + `ACTION_PERMISSION`)、
 *   `actions/action_table.ts` 与「动作数」的一批判据,**三处都不在本线写域**;
 *   而只建一个没人分派的 `plant_*.ts` 正是本仓最忌讳的「实现存在、生产零调用」。
 *   详见 `plant_crop.ts` 文件头(含移出条件)。
 *
 * ## 判序与回执(逐条对着判据)
 *
 * ```ts
 *   1 `authorize` 不通过 ⇒ PERMISSION,**零状态**(闸在第一行;两个形态共用)
 *   2 坐标不是有限整数 ⇒ INVALID,零状态
 *   3 坐标越界 ⇒ INVALID,零状态
 *   4 报文形态:`kind` 与 `itemId` **恰好一种**,两个都没有 ⇒ INVALID,零状态
 *   4' 播种形态(`kind` 缺、`itemId` 是整数)⇒ 立刻交给 `plant_crop.ts`,
 *      它自己再判「是不是种子 / 扣件 / 世界拒绝退回」
 *   5 `hasComponentKind(kind)` 为假 ⇒ INVALID,零状态(判据是注册表,不是本文件的名单)
 *   5' `SPEC_BY_KIND` 里没有这一种的规格 ⇒ NOT_IMPLEMENTED,零状态
 *      (注册表说有、规格表说没有 = 两张表不同步,是链路问题不是报文问题)
 *   6a 该格**已有东西** ⇒ INVALID,原记录一字不动(不可覆盖):
 *       · 本模块登记表里有那一格 ⇒ 拒绝(自动化件之间不覆盖);
 *   6b · 世界物质层(有的话)那一格的 obj 层非空 ⇒ 也拒绝(不盖住玩家的块);
 *   6c 若是 429 且报文带了 `lane` / `itemId` ⇒ 过滤规则**先算完**(读世界现有规则,
 *      合并成新表)`:缺少写口 ⇒ NOT_IMPLEMENTED;参数不合法 ⇒ INVALID` —— 两者都
 *      **零状态**(背包与登记表都还没动);
 *   7 ★ **扣件**:`spec.id` 对应的**实物**要真扣:
 *       · 缺按件权威读口 ⇒ NOT_IMPLEMENTED,零状态(与 `craft.ts` 同口径);
 *       · 不持有(服务端账面 < 1)⇒ INVALID,零状态;
 *       · 扣减走 `ctx.applyInventory`(负 delta);被拒 ⇒ INVALID,零状态
 *   8 全部通过 ⇒ 写登记表,**随后**把 6c 算好的过滤规则落进世界,再回 OK + `effect`
 *      (kind / 坐标 / 时刻 / 谁放的 / `itemId` = 第 7 步**真的扣掉的那一件**,
 *       两处同源 / `sortLane` = 本次写进 429 的道号,`null` = 这次没动规则表)
 * ```
 *
 * ## ★ 放置要**扣件**(owner 裁决;与 `craft.ts` / `material.ts` 同一条扣减口径)
 *
 * 自动化件是**实物**(冻结层 401~440,每一件在 `shared/constants/items.ts` 里都有
 * 自己的 id / 配方),而「放置」在接线时**不扣任何东西** ⇒ 一件 428 定向物流传送带
 * 可以无限放。现在:要放 `kind` ⇒ 必须**真的持有** `SPEC_BY_KIND.get(kind).id` 那一件。
 *
 *   · **哪一件**由服务端注册表决定(`spec.id`),不是报文的值(`kind` 才是报文里的);
 *   · **有没有**由按件权威账决定(`ownedItemCount` ⇒ `RoomRuntime.itemCountOf`),
 *     不是「总量守恒」;缺读口 ⇒ `NOT_IMPLEMENTED`(fail-closed,不退回信客户端);
 *   · 扣减走 `ctx.applyInventory`(唯一写入口;负 delta 不需要 source 凭证);
 *   · 回执的 `itemId` 与**真的扣掉的那一件**是**同一个变量**(`spec.id`)
 *     ⇒ 两处不可能漂。
 *
 * 顺序照 `material.ts` 的 `placeBlock`:**先扣背包、再写世界**(这里「世界」= 登记表)。
 * 登记表写入是同步的、不可能失败 ⇒ 不需要退回路径(与放块不同:那里 `placeBlock`
 * 会拒,所以有 `PLACE_REFUND`)。
 *
 * ## 权限位取自**实际定义**,本模块不写角色表
 *
 * `ACTION_PERMISSION.PLACE_AUTOMATION = 'wiring'`(`net/room.ts:187`)。
 * `wiring` 位只有 OWNER / ADMIN / MEMBER 带(`PERMISSION_MATRIX`,`net/room.ts:156`)
 * ⇒ GUEST 会在 `ctx.authorize`(=`RoomRuntime.authorize`)这一步被拦。
 * 本模块**不发明**额外规则:`MEMBER` 也能放,因为权限矩阵就是这么定义的。
 *
 * ## 坐标的界从哪来(`sizeCells` 可读,则读它)
 *
 * 世界尺寸能**从宿主读到**:`WorldSim.sizeCells`(`world_sim.ts:540` 的
 * `readonly sizeCells`;默认 64、构造时下限 16,见 `world_sim.ts:897`)。
 * 但 `WorldSaveHost` 这份结构化接口里**没有**这一个成员,故照 `actions/sleep.ts:196`
 * 已有的同一手法用**局部窄类型**读它(缺了就用 `FALLBACK_MAX_CELL`)。
 *
 * ⚠️ `FALLBACK_MAX_CELL` 是**防呆界,不是产品规则**:它只用于挡住「坐标跑到世界外」
 *   这类输入,不表达任何玩法设计(取值 511 = 本仓 `SignalGraph` 支持的最大世界
 *   512 格 `graph.ts:11` 的边)。将来 `sizeCells` 正式进入 `ActionContext` / 
 *   `WorldSaveHost` 后,第一选择是删掉这个 fallback,只留宿主读数。
 *
 * ## 为什么状态放在本模块的 per-room Map(而不是 `RoomState`)
 *
 * 与 `actions/sleep.ts` / `actions/modify_town.ts` 同一条理由:`ActionContext` 只有
 * 一次分派的入参与宿主能力,**没有**可写的世界侧状态;而「哪一格放了哪件」既不是
 * `RoomRuntime` 的房间状态,也不是 `vitals` 的字段。放进模块内的
 * `Map<roomId, Map<cellKey, AutomationPlacement>>` 有两个直接好处:
 *   1 `roomId` 分桶 ⇒ 两个房间的同坐标互不可见(判据里那条隔离就靠它);
 *   2 显式查询函数可被**未来的**世界侧/存档侧消费,不需要把 `RoomRuntime` 或
 *     `WorldSim` 交进动作层。
 *
 * ⚠️ 不持久化:进程内 Map,房间重建即清空。要落盘得动存档侧(`host.saveToDb`),
 *   本次范围之外 ⇒ 本文件**不声称**"放置会留下来"。
 *
 * ## 时钟
 *
 * 默认 `Date.now()`,但**可注入**(`setPlacementClock`,照 `actions/sleep.ts:96` 的手法):
 * 判据要能给出确定的 `placedAtMs` 而不依赖真实时间。注入点是模块级的,因为
 * `ActionContext` 没有 `clock`。
 */
import { hasComponentKind } from '../../wiring/graph.ts';
import { SPEC_BY_KIND } from '../../wiring/components.ts';
/* ★ 扣件侧的按件权威读口(与 `craft.ts` / `material.ts` 同一份,不另写判定)。 */
import { missingItemReadPort, ownedItemCount } from './item_source.ts';
/* ★ WS-FND-119:三个「喂料口」的判定在 systems 层(纯函数),世界写入仍由宿主做。 */
import { addSortFilter, roomSystemsPortOf } from '../../systems/intake.ts';
import type { SortFilter } from '../../systems/greenhouse.ts';
/* ★ WS-FND-119:播种形态的实现(种子判定 / 扣件 / 退回)。 */
import { plantSeedAt } from './plant_crop.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════ 1. 记录、登记表与时钟 ═══════════════════════ */

/**
 * 一条放置记录(纯数据,便于回执与断言)。
 *
 * `kind` / `placedBy` / `placedAtMs` 是本动作的**结论**;`x` / `y` 只是
 * 「这条记录属于哪一格」的冗余副本(登记表的键里也有),省得每个读者都去拆键。
 */
export interface AutomationPlacement {
  /** 组件种类名(与 `wiring/components.ts` 的 `ComponentSpec.kind` 逐字一致)。 */
  readonly kind: string;
  /** 这一格(格号,整数)。 */
  readonly x: number;
  /** 这一格(格号,整数)。 */
  readonly y: number;
  /** 放置者(userId)。 */
  readonly placedBy: string;
  /** 放置时刻(ms,来自可注入时钟)。 */
  readonly placedAtMs: number;
}

/**
 * 坐标的**防呆**上界(不含)。见文件头「坐标的界从哪来」:
 * 宿主读不到 `sizeCells` 时用它 —— 它是防呆界,不是产品规则。
 */
export const FALLBACK_MAX_CELL = 511;

/**
 * 冻结层 `429 智能分拣交叉带` 的组件编号(`wiring/components.ts` 的 `LOGISTICS_SORTER`)。
 *
 * 为什么用**编号**判而不是用 `kind` 字符串:编号是冻结层的身份(401~440),
 * `kind` 是逻辑件的名字;而「这一件是不是分拣带」问的是**产品身份**。
 * 两处同源(`SPEC_BY_KIND` 拿到的 `spec.id`)⇒ 这里比对的是服务端注册表给的那个 id,
 * 不是报文里的字符串。
 */
export const SORTER_COMPONENT_ID = 429;

/**
 * 房间 → (格子键 → 放置记录)。**本模块是唯一写者**(`PLACE_AUTOMATION` 的处理器)。
 *
 * 与 `sleep` / `modify_town` 的登记表同款:按 `roomId` 分桶,房间之间互不可见。
 */
const PLACEMENTS = new Map<string, Map<string, AutomationPlacement>>();

/** 可注入时钟(毫秒)。默认墙钟;判据注入假钟,不依赖真实时间。 */
let clockMs: () => number = () => Date.now();

/** 注入时钟。**唯一**的时间来源:登记与回执都走它,不各自读 `Date.now`。 */
export function setPlacementClock(clock: () => number): void {
  clockMs = clock;
}

/** 恢复默认时钟(测试收尾;生产不需要)。 */
export function resetPlacementClock(): void {
  clockMs = () => Date.now();
}

/** 清空全部登记(测试隔离用;生产不需要)。 */
export function clearPlacementRegistry(): void {
  PLACEMENTS.clear();
}

/**
 * 丢弃**某一个房间**的放置登记(保留别的房间)。
 *
 * ## 为什么必须有它(审计 P2:三个侧账无回收)
 *
 * `PLACEMENTS` 是模块级 Map,修前**全仓 0 个回收调用点** ⇒ `RESET_WORLD` 之后
 * 「这一格已经有自动化件 XXX」仍然成立:世界已经按新种子重建(那一格可能成了
 * 水/墙/空地),而登记表还把旧件钉在那儿 —— 既挡住重新放置,又让**放下去的那一件
 * 实物**在账面上继续「存在着」。⇒ 世界重置成功时按 `roomId` 丢掉这一桶。
 *
 * ⚠️ **只删本房间那一桶**:`clearPlacementRegistry` 是测试用的全清,两者不互换 ——
 * 一个房间的重置不许动到另一个房间的登记。
 */
export function forgetPlacements(roomId: string): void {
  PLACEMENTS.delete(roomId);
}

/** 格子键。⚠️ 格式是对外契约的一部分:`` `${x},${y}` ``(整数格号)。 */
function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** 取(必要时创建)某房间的放置登记表。 */
function bucketOf(roomId: string): Map<string, AutomationPlacement> {
  let m = PLACEMENTS.get(roomId);
  if (m === undefined) {
    m = new Map();
    PLACEMENTS.set(roomId, m);
  }
  return m;
}

/**
 * **显式查询**(给未来接线用):本房间登记过的全部放置,键是格子键(`"x,y"`)。
 *
 * 返回**副本**:调用方改它不会影响登记表 —— 唯一写者仍是 `PLACE_AUTOMATION`。
 */
export function placementsOfRoom(roomId: string): ReadonlyMap<string, AutomationPlacement> {
  const m = PLACEMENTS.get(roomId);
  if (m === undefined) return new Map();
  return new Map([...m].map(([k, v]) => [k, { ...v }]));
}

/**
 * **显式查询**(给未来接线用):某房间某一格放了什么;空格 ⇒ `null`。
 *
 * 返回**副本**(改动它不会影响登记表),理由同 `placementsOfRoom`。
 */
export function placementAt(roomId: string, x: number, y: number): AutomationPlacement | null {
  const rec = PLACEMENTS.get(roomId)?.get(cellKey(x, y));
  return rec === undefined ? null : { ...rec };
}

/* ═══════════════════════ 2. 报文参数与宿主读数 ═══════════════════════ */

/**
 * 本次放置的报文参数。
 *
 * ⚠️ `kind` / `lane` **还没有**写进 `ActionPayload`(`net/room.ts` 不在本次可改范围里)
 * ⇒ 这里的交叉类型只是**读**它们用的局部窄类型,不是第二份协议定义:真正的落点仍是
 * `ActionPayload`(`x` / `y` / `itemId` 已经在里面)。
 *
 * ```
 * { kind, x, y }                  放自动化件(原有形态,种类必须已注册)
 * { kind: 'LOGISTICS_SORTER', x, y, lane, itemId }   同时把「第 lane 道收 itemId」写进 429
 * { itemId, x, y }                ★ WS-FND-119:播种(种子 = itemId,见 `plant_crop.ts`)
 * ```
 * `kind` 与 `itemId` **恰好一种**:两个都给时按组件形态处理(`itemId` 只当 429 的过滤目标;
 * 非 429 的种类忽略它 —— 显式写在这里,而不是留一条静默的隐式规则)。
 */
type PlacePayload = ActionPayload & {
  /** 组件种类名(必须是 `wiring` 注册表里已注册的种类)。 */
  kind?: unknown;
  /** 429 的过滤道号(非负整数;负数是 `SORT_PASS_THROUGH` 的语义,不能当道号)。 */
  lane?: unknown;
};

/**
 * 本动作在世界源上真正需要的那**一项**能力:`sizeCells`。
 *
 * `ActionContext.host` 声明为 `WorldSaveHost`,而 `sizeCells` 不在那份结构化契约里
 * (与 `actions/sleep.ts:196` 的 `roomEffectOf` 同一情形)⇒ 用局部窄类型读它,
 * 读不到就退回 `FALLBACK_MAX_CELL`(防呆界,见文件头)。
 * ⚠️ 若将来把 `sizeCells` 正式写进 `WorldSaveHost`,删除本类型即可。
 */
type SizeCapableHost = { readonly sizeCells?: number };

/** 本房间的坐标上界(不含):宿主的 `sizeCells`,否则 `FALLBACK_MAX_CELL + 1`。 */
function cellBoundOf(ctx: ActionContext): number {
  const size = (ctx.host as unknown as SizeCapableHost | null)?.sizeCells;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    return FALLBACK_MAX_CELL + 1;
  }
  return size;
}

/** 报文值的可读写法(拒绝理由里用:把 `undefined` / `NaN` / 类型都如实印出来)。 */
function show(v: unknown): string {
  return typeof v === 'number' ? String(v) : typeof v;
}

/* ═══════════════════════ 3. 动作处理器 ═══════════════════════ */

/**
 * `PLACE_AUTOMATION`:把一件自动化件登记到某个格子。
 *
 * 判序见文件头。`effect` 的值类型是 `string | number | boolean`(`net/room.ts:866`)
 * ⇒ 回执只放扁平字段(`x` / `y` 分开),不把内部对象漏出去。
 *
 * 显式返回类型:本处理器有多处 `kind: 'OK'` 之外的返回,显式标注让**每一支**各自
 * 对 `ActionOutcome` 校验(与 `actions/material.ts:85` 同一理由)。
 */
export const placeAutomation: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* ── 1 权限闸。`wiring` 位的真实定义见 `ACTION_PERMISSION`,本模块不复制它。
        ★ WS-FND-119:播种形态**共用**这一道闸(`plant_crop.ts` 文件头写了为什么
        它挂在本动作上而不是一个独立动作)。 ── */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  const p = ctx.payload as PlacePayload;
  const { x, y, kind } = p;

  /* ── 2 坐标:有限**整数**。小数会让「那一格」落成半格,而世界判定按格算;
        `NaN` / `Infinity` 一并被 `Number.isInteger` 挡掉。 ── */
  if (typeof x !== 'number' || !Number.isInteger(x)
    || typeof y !== 'number' || !Number.isInteger(y)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `需要 x / y(有限整数格号;实测 x=${show(x)} / y=${show(y)})`,
    };
  }

  /* ── 3 越界 ⇒ 拒绝。界的出处见文件头(sizeCells 可读则读它)。 ── */
  const bound = cellBoundOf(ctx);
  if (x < 0 || y < 0 || x >= bound || y >= bound) {
    return {
      ok: false, kind: 'INVALID',
      reason: `坐标必须落在世界内 0..${bound - 1}(实测 ${x},${y};界的出处见本文件开头)`,
    };
  }

  /* ── 4 报文形态:`kind`(自动化件)或 `itemId`(种子)—— **恰好一种**。
        ★ WS-FND-119:温室此前**没有任何播种入口**(`WorldSim.plantCrop` 的生产
        调用点 = 0),于是 `crops` 恒空、`advanceRoomSystems` 的温室分支每慢帧空跑。
        第二个形态就挂在这里:两者都是「扣背包里那一件 + 写世界那一格」。 ── */
  const kindGiven = typeof kind === 'string' && kind.length > 0;
  const seedItemId = typeof p.itemId === 'number' && Number.isInteger(p.itemId) ? p.itemId : null;
  if (!kindGiven) {
    if (seedItemId === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: `需要 kind(组件种类名,即 wiring 已注册的那 40 个之一;实测 ${show(kind)})`
          + `或 itemId(播种:内容表里的种子;实测 ${show(p.itemId)})`,
      };
    }
    /* 播种:种子判定 / 按件扣减 / 世界拒绝退回全在 `plant_crop.ts`(权限与坐标已在上面判过)。 */
    return plantSeedAt(ctx, x, y, seedItemId);
  }
  const kindName = kind as string;

  /* ── 5 种类必须是**已注册**的逻辑件(唯一判据:`hasComponentKind`)。 ── */
  if (!hasComponentKind(kindName)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `未知组件种类 ${kindName} —— 不在 wiring 的已注册种类表里`
        + '(判据是 `hasComponentKind`,不是本文件的名单)',
    };
  }

  /* ── 5' 规格:`spec.id` 是**扣件**与**回执**的唯一出处(见文件头「放置要扣件」)。
        ⚠️ 不猜默认 id、不放行 —— 那会让「注册表与规格表漂了」表现成「免费放件」。 ── */
  const spec = SPEC_BY_KIND.get(kindName);
  if (spec === undefined) {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: `种类 ${kindName} 已注册,但 SPEC_BY_KIND 里没有它的规格`
        + ' ⇒ 定不出要扣哪一件实物(零副作用)',
    };
  }

  const roomId = ctx.state.roomId;

  /* ── 6a 本模块登记表:同一格不可覆盖(自动化件之间也一样)。 ── */
  const taken = placementAt(roomId, x, y);
  if (taken !== null) {
    return {
      ok: false, kind: 'INVALID',
      reason: `这一格已经有自动化件 ${taken.kind}(由 ${taken.placedBy} 于 ${taken.placedAtMs}ms 放置)`
        + ' ⇒ 不可覆盖',
    };
  }

  /* ── 6b 世界物质层(有的话)那一格也得是空的:不盖住玩家的块。 ── */
  const mat = ctx.materialsOf();
  if (mat !== null) {
    const obj = mat.blockAt(x, y);
    if (obj !== 0) {
      return {
        ok: false, kind: 'INVALID',
        reason: `这一格已经有世界物件(${obj})⇒ 不可覆盖`,
      };
    }
  }

  /* ── 6c ★ WS-FND-119:429 的过滤规则(此前**零生产调用** ⇒ `sortFilters` 恒空
        ⇒ `sortHarvest` 恒回 -1,分拣道永远不分拣)。

        报文:`{ kind: 'LOGISTICS_SORTER', x, y, lane, itemId }`
          · `lane`   = 这一道接到第几条(非负整数;`-1` 是 `sortHarvest` 的「不分拣」
                       语义,不能当道号);
          · `itemId` = 这一道收哪一件(**不是**要扣的那件:`spec.id`(429)才是);
        两个键都**给了才**动规则表:只放一台 429 不带参数 = 沿用该道的旧规则。

        ⚠️ `lane` 还没写进 `ActionPayload`(`net/room.ts` 不在本线写域)⇒ 走本文件的
          局部窄类型读取,与 `kind` 同一处置(见 `PlacePayload` 的 docblock)。

        ★ 判序:规则**在扣件之前**就要算完(用 `systems/intake.ts` 的 `addSortFilter`
          与世界的只读 `sortFilters()`)—— 这样报错时背包与登记表都还没动;
          而**落表**放在扣件与登记成功之后(见第 8 步)。 */
  const wantsFilter = spec.id === SORTER_COMPONENT_ID
    && (p.lane !== undefined || p.itemId !== undefined);
  const port = wantsFilter ? roomSystemsPortOf(ctx.host) : null;
  let pendingFilters: SortFilter[] | null = null;
  let filterLane: number | null = null;
  if (wantsFilter) {
    if (port === null
      || typeof port.setSortFilters !== 'function'
      || typeof port.sortFilters !== 'function') {
      return {
        ok: false, kind: 'NOT_IMPLEMENTED',
        reason: '宿主没有 429 的过滤规则写口(`setSortFilters` / `sortFilters`)'
          + ' ⇒ 登记了也分不了拣(零副作用)',
      };
    }
    const lane = typeof p.lane === 'number' && Number.isInteger(p.lane) ? p.lane : null;
    if (lane === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: `429 的过滤规则需要 lane(非负整数道号;实测 ${show(p.lane)})`,
      };
    }
    if (seedItemId === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: `429 的过滤规则需要 itemId(这一道收哪一件;实测 ${show(p.itemId)})`,
      };
    }
    const merged = addSortFilter(port.sortFilters(), { lane, itemIds: [seedItemId] });
    if (!merged.ok) return { ok: false, kind: 'INVALID', reason: `429 过滤规则被拒:${merged.reason}` };
    pendingFilters = merged.next;
    filterLane = lane;
  }

  /* ── 7 ★ **扣件**:放置 = 消耗 `spec.id` 那一件**实物**(见文件头「放置要扣件」)。
        顺序照 `material.ts` 的 `placeBlock`:**先扣背包、再写世界**(这里「世界」=登记表)。
        `spec.id` 来自服务端注册表(不是报文的 `kind` 字符串换算的)。 ── */
  const owned = ownedItemCount(ctx, spec.id);
  if (owned === null) return missingItemReadPort(ctx);
  if (owned < 1) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有这件自动化件 ${spec.id}(${spec.name})`
        + `(服务端账面 ${owned} 件)⇒ 放不了 ${kindName}`,
    };
  }
  const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId: spec.id, delta: -1 }] });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有可放置的 ${spec.id}(${spec.name})(${spend.rejectCode ?? '被拒'})`,
    };
  }

  /* ── 8 写登记表(扣件已在上一步成功),随后把 429 的过滤规则落进世界。 ── */
  const placedAtMs = clockMs();
  const record: AutomationPlacement = {
    kind: kindName,
    x,
    y,
    placedBy: ctx.actorId,
    placedAtMs,
  };
  bucketOf(roomId).set(cellKey(x, y), record);

  /* ★ 规则落表在**扣件 + 登记都成功之后**:反过来会出现「规则登记了、件没扣」的
     半截状态(零副作用纪律的另一面)。`setSortFilters` 不返回失败,故这里不会再有分支。 */
  if (pendingFilters !== null && port !== null && typeof port.setSortFilters === 'function') {
    port.setSortFilters(pendingFilters);
  }

  /* 回执的 `itemId` 就是第 7 步**真的扣掉的那一件**(同一个 `spec.id`)——
     冻结层的 401~440 编号,将来接线要用它造 `SignalGraph` 节点。
     ⚠️ 这里**不再**重新 `SPEC_BY_KIND.get(kindName)`:两次查表就可能两次给出不同的
     东西(比如表被改),而「回执说 428、实际扣的是 429」正是本判据要钉的缺陷。
     `sortLane` = 本次写进 429 的道号(`null` = 这次没动规则表)。 */
  return {
    ok: true,
    kind: 'OK',
    effect: {
      roomId,
      x,
      y,
      kind: kindName,
      itemId: spec.id,
      placedBy: record.placedBy,
      placedAtMs,
      sortLane: filterLane,
      sortFilters: pendingFilters === null ? null : pendingFilters.length,
      note: '只登记放置:电路求值(wiring/graph.ts)今天没有任何读者,见本文件开头;'
        + '429 的过滤规则已落进世界(慢帧收获按道分拣)',
    },
  };
};