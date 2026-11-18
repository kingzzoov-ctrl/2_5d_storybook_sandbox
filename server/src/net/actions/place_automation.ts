/**
 * `PLACE_AUTOMATION` —— 把**一件自动化件落到某个格子**(登记 + 可查)。
 *
 * ## ⚠️ 边界:本动作**不创建世界实体**
 *
 * 本文件**没有**碰 `world_sim.ts`,也**没有**碰 `wiring/**`。今天它只做两件事:
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
 * ## 判序与回执(逐条对着判据)
 *
 * ```ts
 *   1 `authorize` 不通过 ⇒ PERMISSION,**零状态**(闸在第一行)
 *   2 坐标不是有限整数 / kind 不是非空字符串 ⇒ INVALID,零状态
 *   3 坐标越界 ⇒ INVALID,零状态
 *   4 `hasComponentKind(kind)` 为假 ⇒ INVALID,零状态(判据是注册表,不是本文件的名单)
 *   4' `SPEC_BY_KIND` 里没有这一种的规格 ⇒ NOT_IMPLEMENTED,零状态
 *      (注册表说有、规格表说没有 = 两张表不同步,是链路问题不是报文问题)
 *   5 该格**已有东西** ⇒ INVALID,原记录一字不动(不可覆盖):
 *       · 本模块登记表里有那一格 ⇒ 拒绝(自动化件之间不覆盖);
 *       · 世界物质层(有的话)那一格的 obj 层非空 ⇒ 也拒绝(不盖住玩家的块);
 *   6 ★ **扣件**:`spec.id` 对应的**实物**要真扣:
 *       · 缺按件权威读口 ⇒ NOT_IMPLEMENTED,零状态(与 `craft.ts` 同口径);
 *       · 不持有(服务端账面 < 1)⇒ INVALID,零状态;
 *       · 扣减走 `ctx.applyInventory`(负 delta);被拒 ⇒ INVALID,零状态
 *   7 全部通过 ⇒ 写登记表并回 OK + `effect`(kind / 坐标 / 时刻 / 谁放的 /
 *      `itemId` = 第 6 步**真的扣掉的那一件**,两处同源)
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
 * ⚠️ `kind` **还没有**写进 `ActionPayload`(`net/room.ts:828`;那不在本次可改范围里)
 * ⇒ 这里的交叉类型只是**读**它用的局部窄类型,不是第二份协议定义:真正的落点仍是
 * `ActionPayload`(`x` / `y` 已经在里面),补进去之后这个 `as` 就可以收掉。
 */
type PlacePayload = ActionPayload & {
  /** 组件种类名(必须是 `wiring` 注册表里已注册的种类)。 */
  kind?: unknown;
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
  /* ── 1 权限闸。`wiring` 位的真实定义见 `ACTION_PERMISSION`,本模块不复制它。 ── */
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

  /* ── 2' kind:非空字符串。是不是**合法种类**由第 4 步的注册表判,不在这里列名单。 ── */
  if (typeof kind !== 'string' || kind.length === 0) {
    return {
      ok: false, kind: 'INVALID',
      reason: `需要 kind(组件种类名,即 wiring 已注册的那 40 个之一;实测 ${show(kind)})`,
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

  /* ── 4 种类必须是**已注册**的逻辑件(唯一判据:`hasComponentKind`)。 ── */
  if (!hasComponentKind(kind)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `未知组件种类 ${kind} —— 不在 wiring 的已注册种类表里`
        + '(判据是 `hasComponentKind`,不是本文件的名单)',
    };
  }

  /* ── 4' 规格:`spec.id` 是**扣件**与**回执**的唯一出处(见文件头「放置要扣件」)。
        注册表(`hasComponentKind`)说有、规格表(`SPEC_BY_KIND`)说没有 = 两张表
        不同步 ⇒ 链路问题,显式 NOT_IMPLEMENTED;**此时背包与登记表都还没动**。
        ⚠️ 不猜默认 id、不放行 —— 那会让「注册表与规格表漂了」表现成「免费放件」。 ── */
  const spec = SPEC_BY_KIND.get(kind);
  if (spec === undefined) {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: `种类 ${kind} 已注册,但 SPEC_BY_KIND 里没有它的规格`
        + ' ⇒ 定不出要扣哪一件实物(零副作用)',
    };
  }

  const roomId = ctx.state.roomId;

  /* ── 5a 本模块登记表:同一格不可覆盖(自动化件之间也一样)。 ── */
  const taken = placementAt(roomId, x, y);
  if (taken !== null) {
    return {
      ok: false, kind: 'INVALID',
      reason: `这一格已经有自动化件 ${taken.kind}(由 ${taken.placedBy} 于 ${taken.placedAtMs}ms 放置)`
        + ' ⇒ 不可覆盖',
    };
  }

  /* ── 5b 世界物质层(有的话)那一格也得是空的:不盖住玩家的块。 ── */
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

  /* ── 6 ★ **扣件**:放置 = 消耗 `spec.id` 那一件**实物**(见文件头「放置要扣件」)。
        顺序照 `material.ts` 的 `placeBlock`:**先扣背包、再写世界**(这里「世界」=登记表)。
        `spec.id` 来自服务端注册表(不是报文的 `kind` 字符串换算的)。 ── */
  const owned = ownedItemCount(ctx, spec.id);
  if (owned === null) return missingItemReadPort(ctx);
  if (owned < 1) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有这件自动化件 ${spec.id}(${spec.name})`
        + `(服务端账面 ${owned} 件)⇒ 放不了 ${kind}`,
    };
  }
  const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId: spec.id, delta: -1 }] });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `背包里没有可放置的 ${spec.id}(${spec.name})(${spend.rejectCode ?? '被拒'})`,
    };
  }

  /* ── 7 写登记表(扣件已在上一步成功)。 ── */
  const placedAtMs = clockMs();
  const record: AutomationPlacement = {
    kind,
    x,
    y,
    placedBy: ctx.actorId,
    placedAtMs,
  };
  bucketOf(roomId).set(cellKey(x, y), record);

  /* 回执的 `itemId` 就是第 6 步**真的扣掉的那一件**(同一个 `spec.id`)——
     冻结层的 401~440 编号,将来接线要用它造 `SignalGraph` 节点。
     ⚠️ 这里**不再**重新 `SPEC_BY_KIND.get(kind)`:两次查表就可能两次给出不同的
     东西(比如表被改),而「回执说 428、实际扣的是 429」正是本判据要钉的缺陷。 */

  return {
    ok: true,
    kind: 'OK',
    effect: {
      roomId,
      x,
      y,
      kind,
      itemId: spec.id,
      placedBy: record.placedBy,
      placedAtMs,
      note: '只登记放置:电路求值(wiring/graph.ts)今天没有任何读者,见本文件开头',
    },
  };
};