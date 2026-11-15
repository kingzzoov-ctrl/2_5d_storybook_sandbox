/**
 * `WIRE_EDIT` —— 编辑**一格上的接线**:把某个方向的导线接上 / 断开。
 *
 * ## ⚠️ 三条边界(必须与「已接线」一起读,不许只读前半句)
 *
 * ```ts
 *   1 不碰 wiring/graph.ts 的图:没有 SignalGraph.addWire / removeWire,
 *     也没有 drive / setChannel —— 信号图是**世界侧**的(WorldSim 里那个 SignalGraph),
 *     而 ActionContext 里**没有**它(ctx.host 是 `WorldSaveHost`,契约里不含 graph);
 *   2 不下发任何报文给客户端:回执只有 dispatchAction 那一个 `ActionOutcome`
 *     (effect 只能是扁平字段,net/room.ts:866)—— 没有增量补丁,也没有 WireView 下发报文;
 *   3 ⇒ **电路不会因为这条记录而导通**。build/wiring_view.ts 也仍拿不到这份数据:
 *     它读的是**格子的 Bits 12..15**(shared/types/tile.ts:22 的 WIRE_SHIFT),不是本模块的表。
 *     缺的两件正是 docs/TASK-96-action-landing-gaps.md:104 记的那两件
 *     (**WireView 下发报文 + 铺线 UI 面板**)。
 * ```
 * ⇒ 诚实说法:**「登记 + 可查」已接线;「接上就通电」没有。**
 *   与 `actions/place_automation.ts` / `actions/modify_town.ts` 同一形态的划界。
 *
 * ## 报文契约(客户端只说**做什么**,不说算不算数)
 *
 * ```ts
 *   连接:{ x, y, dir, color, channel }
 *   断开:{ x, y, dir, clear: true }
 * ```
 *
 * - `x` / `y`:有限**整数**格号(小数会让「那一格」落成半格);
 * - `dir`:方向 —— **0=北(-y) 1=东(+x) 2=南(+y) 3=西(-x)**。合法域 = `DIR_VECTORS`
 *   的下标域(`server/src/world/grid.ts:47`)。这不是本文件新立的词表:
 *   `server/src/build/grid.ts:46-47` 的 `DIR_DX`/`DIR_DY`、`server/src/wiring/graph.ts`
 *   的 `DC_DX`/`DC_DY` 三处是**同一个顺序**,本文件直接取 `DIR_VECTORS.length` 作界,
 *   **不自己列**;
 * - `color`:**四色之一**,合法域 = `ALL_COLORS`(`wiring/graph.ts:32`,
 *   即 `WireColor` 0/1/2/3 = 红/蓝/黄/绿),**不自己列**;
 * - `channel`:**无线频道**,合法域 = `[CHANNEL_MIN, CHANNEL_MAX]` =
 *   `[1, 8]`(`wiring/components.ts:52-53`),**不自己列**;
 * - `clear: true`:断开。取值只接受**字面 `true`**(`'true'` / `1` 一律拒);
 *   报文里**同时**给 `clear` 与 `color`/`channel` ⇒ 显式拒绝 —— 「既接又断」到底哪个生效,
 *   不许靠猜。
 *
 * ⚠️ 这四个字段(`dir` / `color` / `channel` / `clear`)**还没有**写进 `ActionPayload`
 * (`net/room.ts:828`;不在本次可改范围里)⇒ 下方用**局部窄类型**读它们,不是第二份协议定义。
 * 真正补进 `ActionPayload` 之后,这个 `as` 就可以收掉。
 *
 * ## 幂等 / 覆盖 / 断开:三条**选定**的口径(不是默认值,故逐条写清理由)
 *
 * ```ts
 *   同一格同一方向再接**同色同通道**  ⇒ OK,**不新增记录**(幂等;effect.changed = 0)
 *   同一格同一方向改接**不同色/通道**  ⇒ OK,**覆盖**(effect 里给 fromColor/fromChannel 与 color/channel)
 *   同一格同一方向**本来就没有** + clear ⇒ **INVALID**(理由写清「本来就没有」)
 * ```
 *
 * 为什么「本来就没有 ⇒ INVALID」而不是回一个含糊的 OK:
 *   那是本仓 `tests/WS-FND-20` FND20-4 的同一条纪律 —— **不给「拆空气」的静默成功**。
 *   代价也照实写:断开因此**不是幂等的** —— 同一个 `clear` 发第二次会得到 INVALID
 *   (而不是假装又断了一次)。取舍的收益是客户端能分辨两种结果:
 *   「**真的删掉了一条**」与「我按错了格 / 重复发了」。这条口径由
 *   `tests/WS-FND-33-wire.test.ts` 判据 5 钉住,不留模糊。
 *
 * ## 判序(逐条对着判据)
 *
 * ```ts
 *   1 authorize 不通过 ⇒ PERMISSION,零状态(闸在第一行)
 *   2 x / y 不是有限整数 ⇒ INVALID,零状态
 *   3 dir 不是 DIR_VECTORS 的下标 ⇒ INVALID,零状态
 *   4 clear 取值含糊 / clear 与 color/channel 混给 ⇒ INVALID,零状态
 *   5 连接:color ∉ ALL_COLORS 或 channel ∉ [1, 8] 的整数 ⇒ INVALID,零状态
 *   6 全部通过 ⇒ 登记 / 覆盖 / 断开(**唯一的写点**)并回 OK + effect
 * ```
 *
 * ## 权限位取自**实际定义**,本模块不写角色表
 *
 * `ACTION_PERMISSION.WIRE_EDIT = 'wiring'`(`net/room.ts:188`),与 `PLACE_AUTOMATION`
 * 同一个位。`wiring` 只有 OWNER / ADMIN / MEMBER 带(`PERMISSION_MATRIX`,
 * `net/room.ts:156`)⇒ GUEST 在 `ctx.authorize`(= `RoomRuntime.authorize`)这一步被拦。
 * 本模块**不发明**额外规则(MEMBER 能布线,因为权限矩阵就是这么定义的)。
 *
 * ## 坐标的界:本动作**不设**世界界(刻意的)
 *
 * `x` / `y` 在这里只是**登记表的键**,不落世界格,也不进任何信号图 ⇒ 与
 * `actions/place_automation.ts:191` 那道 `sizeCells` 防呆界不同,**本文件不判世界越界**:
 * 真要判,得先有世界尺寸进 `ActionContext`(今天没有;`RoomState` 也没有尺寸字段)。
 * 这条是**已知缺口**而非遗漏:越界坐标目前会安静地登记成一条**世界侧永远用不到**的记录。
 *
 * ## 为什么记录放在本模块的 per-room Map(而不是 `RoomState`)
 *
 * 与 `actions/sleep.ts` / `actions/modify_town.ts` / `actions/place_automation.ts` 同一条理由:
 * `ActionContext` 只有一次分派的入参与宿主能力,**没有**可写的世界侧状态;而「哪一格朝哪个方向
 * 接了什么」既不是 `RoomRuntime` 的房间状态,也不是 `vitals` / 背包的字段。放进模块内的
 * `Map<roomId, Map<cellKey, Map<dir, edge>>>` 有三个直接好处:
 *   1 `roomId` 分桶 ⇒ 两个房间的同格同方向互不可见(判据 6 的隔离就靠它);
 *   2 显式查询函数(`wiresOfRoom` / `wireAt`)可被**未来的**世界侧 / 存档侧 / WireView 报文
 *     消费,不需要把 `RoomRuntime` 或 `WorldSim` 交进动作层;
 *   3 一条边只有**一个**写者(本文件的处理器),不会两处各记一份。
 *
 * ⚠️ 不持久化:进程内 Map,房间重建即清空。要落盘得动存档侧,本次范围之外
 *   ⇒ 本文件**不声称**「接过的线会留下来」。
 */
import type { WireColor } from '../../../../shared/types/tile.ts';
import { DIR_VECTORS } from '../../world/grid.ts';
import { ALL_COLORS } from '../../wiring/graph.ts';
import { CHANNEL_MAX, CHANNEL_MIN } from '../../wiring/components.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════ 1. 记录与登记表 ═══════════════════════ */

/**
 * 一条接线记录:这一格**朝这个方向**的边,用哪种颜色、挂在哪个无线频道上。
 *
 * 为什么频道跟颜色**一起**存在边上(而不是另开一张频道表):这条记录要回答的是
 * 「这一格的这一侧到底接的是什么」—— 颜色与频道是**同一条边**的两个属性,
 * 拆成两张表就会出现「颜色改了频道没改」的半截状态。
 */
export interface WireEdge {
  /** 四色之一(`ALL_COLORS`,即 `WireColor` 0/1/2/3)。 */
  readonly color: WireColor;
  /** 无线频道,`CHANNEL_MIN..CHANNEL_MAX`(今天 = 1..8)。 */
  readonly channel: number;
}

/** 某房间的接线快照:`cellKey`(`"x,y"`)→ 方向 → 边。**只读且是副本**。 */
export type RoomWires = ReadonlyMap<string, ReadonlyMap<number, WireEdge>>;

/** 一格的接线:方向 → 边。 */
type DirWires = Map<number, WireEdge>;

/**
 * 房间 → (格子键 → (方向 → 边))。**本模块是唯一写者**(`WIRE_EDIT` 的处理器)。
 *
 * 与 `sleep` / `modify_town` / `place_automation` 的登记表同款:按 `roomId` 分桶,
 * 房间之间互不可见(判据 6)。
 */
const WIRES = new Map<string, Map<string, DirWires>>();

/** 格子键。⚠️ 格式是对外契约的一部分:`` `${x},${y}` ``(整数格号,不含方向)。 */
function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * **显式查询**(给将来接线用):本房间登记过的全部接线,键是格子键(`"x,y"`)。
 *
 * 返回**副本**(内层 Map 与每条边都是新对象):调用方改它不会影响登记表 ——
 * 唯一写者仍是本文件的处理器。空格的方向表不会出现在结果里(见下方删除空桶的处理)。
 */
export function wiresOfRoom(roomId: string): RoomWires {
  const cells = WIRES.get(roomId);
  if (cells === undefined) return new Map();
  const out = new Map<string, ReadonlyMap<number, WireEdge>>();
  for (const [key, dirs] of cells) {
    const copy = new Map<number, WireEdge>();
    for (const [dir, edge] of dirs) copy.set(dir, { ...edge });
    out.set(key, copy);
  }
  return out;
}

/**
 * **显式查询**(给将来接线用):某房间某一格朝某方向接了什么;没接 ⇒ `null`。
 *
 * 返回**副本**(改动它不会影响登记表),理由同 `wiresOfRoom`。
 * ⚠️ `null` 是**显式**的:「没接」与「接了但我读错了格」必须可区分,
 *   本仓陷阱 89 的形态就是「读不到时返回默认值,于是坏掉看起来像正常」。
 */
export function wireAt(roomId: string, x: number, y: number, dir: number): WireEdge | null {
  const edge = WIRES.get(roomId)?.get(cellKey(x, y))?.get(dir);
  return edge === undefined ? null : { ...edge };
}

/* ═══════════════════════ 2. 报文参数 ═══════════════════════ */

/**
 * 本次接线的报文参数。
 *
 * ⚠️ `dir` / `color` / `channel` / `clear` **还没有**写进 `ActionPayload`
 * (`net/room.ts:828`;不在本次可改范围里)⇒ 这里的交叉类型只是**读**它用的局部窄类型,
 * 不是第二份协议定义:真正的落点仍是 `ActionPayload`(`x` / `y` 已经在里面)。
 * 四个字段都声明为 `unknown`:报文是外部输入,**先当作未知**,再由下面逐项收窄。
 */
type WireEditPayload = ActionPayload & {
  /** 方向下标(合法域 = `DIR_VECTORS` 的下标域)。 */
  dir?: unknown;
  /** 四色之一(合法域 = `ALL_COLORS`)。 */
  color?: unknown;
  /** 无线频道(合法域 = `[CHANNEL_MIN, CHANNEL_MAX]` 的整数)。 */
  channel?: unknown;
  /** `true` = 断开(只接受字面 true)。 */
  clear?: unknown;
};

/** 报文值的可读写法(拒绝理由里用:把 `undefined` / `NaN` / 类型都如实印出来)。 */
function show(v: unknown): string {
  return typeof v === 'number' ? String(v) : typeof v;
}

/* ═══════════════════════ 3. 动作处理器 ═══════════════════════ */

/**
 * `WIRE_EDIT`:把「这一格朝这个方向」的接线接上 / 覆盖 / 断开。
 *
 * 判序见文件头。`effect` 的值类型是 `string | number | boolean`(`net/room.ts:866`)
 * ⇒ 回执只放扁平字段(方向 / 颜色 / 频道各占一个键),不把 `WireEdge` 对象漏出去。
 *
 * 显式返回类型:本处理器有**多个** `kind: 'OK'` 分支(幂等 / 新增 / 覆盖 / 断开),
 * 若让 TS 去推会并成带 `undefined` 的联合,而 `effect` 的值类型不含 `undefined`
 * ⇒ 显式标注让**每一支**各自对 `ActionOutcome` 校验(理由同 `actions/material.ts:81`、
 * `actions/place_automation.ts:212`)。
 */
export const wireEdit: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* ── 1 权限闸。`wiring` 位的真实定义见 ACTION_PERMISSION,本模块不复制它。 ── */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  const p = ctx.payload as WireEditPayload;
  const { x, y, dir } = p;

  /* ── 2 坐标:有限**整数**。NaN / Infinity 一并被 Number.isInteger 挡掉。
        界的说明见文件头(本动作不判世界越界,理由是它只进登记表)。 ── */
  if (typeof x !== 'number' || !Number.isInteger(x)
    || typeof y !== 'number' || !Number.isInteger(y)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `需要 x / y(有限整数格号;实测 x=${show(x)} / y=${show(y)})`,
    };
  }

  /* ── 3 方向:合法域 = `DIR_VECTORS` 的下标域(取自该表,不自己列)。 ── */
  if (typeof dir !== 'number' || !Number.isInteger(dir) || dir < 0 || dir >= DIR_VECTORS.length) {
    return {
      ok: false, kind: 'INVALID',
      reason: `需要 dir ∈ 0..${DIR_VECTORS.length - 1}`
        + `(0=北 1=东 2=南 3=西,词表见 world/grid.ts:47 的 DIR_VECTORS;实测 ${show(dir)})`,
    };
  }

  const roomId = ctx.state.roomId;
  const cells = WIRES.get(roomId);
  const dirs = cells?.get(cellKey(x, y));
  const cur = dirs?.get(dir) ?? null;

  /* ══════════ 断开路径(clear: true)══════════ */

  if (p.clear !== undefined) {
    /* ── 4a clear 只接受**字面** true:`'true'` / `1` / `false` 都显式拒,
          否则「到没到断开这条路」会取决于 JS 的真值转换 —— 那是猜,不是契约。 ── */
    if (p.clear !== true) {
      return {
        ok: false, kind: 'INVALID',
        reason: `clear 只接受字面 true(实测 clear=${show(p.clear)})`
          + ";不接受 'true' / 1 这类含糊取值",
      };
    }
    /* ── 4b 「既接又断」不许靠猜:两种意图同时出现 ⇒ 显式拒。 ── */
    if (p.color !== undefined || p.channel !== undefined) {
      return {
        ok: false, kind: 'INVALID',
        reason: 'clear 与 color/channel 不能同时给:一次只表达一件事(接上 或 断开)',
      };
    }
    /* ── 4c 本来就没有 ⇒ INVALID(口径与理由见文件头:不给「拆空气」的静默成功)。 ── */
    if (dirs === undefined || cur === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: `这一格的 dir=${dir} 本来就没有接线(没有可断开的东西)`
          + ' ⇒ 显式失败:重复 clear 会在这里被挡住,而不是假装又断了一次',
      };
    }
    dirs.delete(dir);
    /* 该格再无任何边 ⇒ 连空桶一起摘掉:否则 `wiresOfRoom` 里会出现「有这一格、零条边」,
       让「接过的格数」与「接过的条数」两个口径悄悄分家。 */
    if (dirs.size === 0 && cells !== undefined) cells.delete(cellKey(x, y));
    return {
      ok: true, kind: 'OK',
      effect: {
        roomId, x, y, dir,
        color: cur.color, channel: cur.channel,
        changed: 1,
        note: '已断开这一格这一方向的接线(改前值见 color/channel)',
      },
    };
  }

  /* ══════════ 连接路径(接线 / 覆盖)══════════ */

  const { color, channel } = p;

  /* ── 5a 颜色:判据是 `ALL_COLORS`(唯一出处),不是本文件的名单。 ── */
  if (typeof color !== 'number' || !ALL_COLORS.includes(color as WireColor)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `color 必须是 ALL_COLORS 里的四色之一(${ALL_COLORS.join('/')}:红/蓝/黄/绿;`
        + `实测 ${show(color)})—— 判据取自 wiring/graph.ts:32,不是本文件的名单`,
    };
  }
  /* ── 5b 频道:判据是 `CHANNEL_MIN..CHANNEL_MAX` 且必须是整数(半格频道没有意义)。 ── */
  if (typeof channel !== 'number' || !Number.isInteger(channel)
    || channel < CHANNEL_MIN || channel > CHANNEL_MAX) {
    return {
      ok: false, kind: 'INVALID',
      reason: `channel 必须是 ${CHANNEL_MIN}..${CHANNEL_MAX} 的整数(实测 ${show(channel)})`
        + ' —— 域取自 wiring/components.ts:52-53 的 CHANNEL_MIN / CHANNEL_MAX',
    };
  }

  /* 到这里 color / channel 已各自被**各自的那张表**验过(ALL_COLORS / CHANNEL_*);
     下面只做一次类型收窄 —— 不在这里重新判一遍,否则就是第二份判定。 */
  const wireColor = color as WireColor;

  /* ── 6 幂等:同色同通道 ⇒ 不新增记录(判据 2 的靶子)。 ── */
  if (cur !== null && cur.color === wireColor && cur.channel === channel) {
    return {
      ok: true, kind: 'OK',
      effect: {
        roomId, x, y, dir, color, channel,
        changed: 0,
        note: '这一格这一方向已经接的是同色同通道 ⇒ 幂等,未新增记录',
      },
    };
  }

  /* ── 7 唯一的写点:新增或**覆盖**。改前值一并进回执(判据 3)。 ── */
  const overwritten = cur !== null;
  let cellMap = cells;
  if (cellMap === undefined) {
    cellMap = new Map<string, DirWires>();
    WIRES.set(roomId, cellMap);
  }
  let dirMap = cellMap.get(cellKey(x, y));
  if (dirMap === undefined) {
    dirMap = new Map<number, WireEdge>();
    cellMap.set(cellKey(x, y), dirMap);
  }
  dirMap.set(dir, { color: wireColor, channel });

  return {
    ok: true, kind: 'OK',
    effect: overwritten && cur !== null
      ? {
        roomId, x, y, dir, color, channel,
        changed: 1,
        fromColor: cur.color, fromChannel: cur.channel,
        note: '覆盖了原来那条边(改前 = fromColor/fromChannel,改后 = color/channel)',
      }
      : {
        roomId, x, y, dir, color, channel,
        changed: 1,
        /* `-1` 是**显式哨兵**(「改前没有」),不是默认值:回执里必须能分辨
           「新增了一条」与「覆盖了一条改前值恰为 0/1 的边」。 */
        fromColor: -1, fromChannel: -1,
        note: '此前这一格这一方向没有接线 ⇒ 新增(只登记:电路不会因此导通,见本文件开头)',
      },
  };
};