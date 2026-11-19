/**
 * 客户端**动作入口层**(纯逻辑那一半)+ **注入式**发送端口。
 *
 * ## 本层只做一件事
 * ```
 *   玩家按了/点了  ⇒  「要发哪个动作 + 什么载荷」  ⇒  交给人注入进来的 `sendAction`
 * ```
 * 于是 `RoomAction` 里已经**有执行层**的那几个
 * (`CRAFT` / `SLEEP` / `OPEN_CHEST` / `USE_OWN_CHEST` / `START_PARTY`,
 *  以及 `docs/TASK-99-use-item-verb.md` 裁决出来的 `USE_ITEM`)
 * 第一次有了**客户端入口** —— 此前它们的全部接线在服务端,客户端**零调用点**,
 * 表现就是「服务端能跑、玩家按了没反应」。
 *
 * ## ★ 边界:本层**不做**下面这些(别越界,越界就是第二份实现)
 * ```
 * 不预测            —— 本地先动、事后校正 = `net/prediction.ts` / `net/predictor.ts`
 * 不做乐观更新      —— 本层**不**写 store、**不**动角色坐标、**不**改背包数量;
 *                      服务端回什么就是什么(`snapshot` 是唯一真值来源)
 * 不判定动作结果    —— 判定在 `RoomRuntime.dispatchAction`;本层只把回执翻成一句话
 * 不碰 socket       —— `sendAction` 由**注入**进来(见 `ActionPorts`),本文件
 *                      顶层**没有**任何 `WebSocket` / `SessionHandle` 的 import
 *                      (本文件事实上有 0 个 import:零依赖、可单测)
 * 不碰 DOM          —— 键位/按钮那层在 `net/action_binding.ts`,且可在无 DOM 下驱动
 * 不发明协议        —— 动作名与载荷键**逐条**取自 `server/src/net/room.ts` 的
 *                      `RoomAction` / `ActionPayload`(只读它,没有第二张表)
 * ```
 *
 * ## 为什么"拒绝"必须有出路(第 3 条判据的由来)
 *
 * 没有本层时,被拒的形态是「我发了、什么都没发生」—— 而 `ws_server.onAction`
 * 其实**每一条都回执**(`OK` / `INVALID` / `PERMISSION` / `NOT_IMPLEMENTED` /
 * `ROOM_CLOSED`,以及 WS-FND-134 新增的 `INTERNAL` = 服务端执行抛错)。
 * 回执到了却没人读,等于没回。⇒ `describeEntryReceipt` 是那条出路:
 * **五种失败给五句不同的话**(越权 / 参数状态不对 / 这一版没做 / 房间关了 /
 * 服务端内部错),混成一句"操作失败"就等于把服务端辛苦分开的分类又丢了。
 *
 * ## 幂等口径(第 5 条判据:重复触发不串包)
 * ```
 * 一次触发 = 构建**一份新的** request(载荷是**拷贝**,不与调用方共享引用)
 *          + 恰好调用 `sendAction` **一次**
 *          + 不发就一个字节都不写(非法参数 / 未连接)
 * 本层**没有**待确认队列、没有"最近一次动作"的复用缓冲 ⇒ 结构上不可能串包。
 * 重复触发同一动作 = 发第二条独立报文(这是**如实的语义**):
 *   · 服务端的 `SLEEP` 自己幂等(不叠加计时);
 *   · 服务端的 `START_PARTY` 会在第二局上回 `INVALID`(不许叠开);
 *   · 回执按报文自带的 `action` 字段归位,不按"谁最后发的"猜。
 * ```
 */

/* ═══════════════════════════ 1. 形状(与协议对齐) ═══════════════════════════ */

/**
 * 一份**已经构建好、可以发**的请求。
 *
 * 线上是**扁平**的一层 JSON(`{ action, x, y, itemId, ... }`),不是
 * `{ action, payload: {...} }` —— 见 `net/session.ts` 的 `encodeActionUplink`
 * (`JSON.stringify({ ...intent, t: 'action' })`)与 `ws_server.onAction`
 * (它把整条报文原样当 payload 交给 `dispatchAction`)。
 * 本层用 `payload` 这一格,只是为了让"动作名"和"参数"在**测试里**能分开断言;
 * 铺平由 `ActionEntry.submit` 做,**只此一处**。
 */
export interface ActionRequest {
  /** 线上动作名:`server/src/net/room.ts` 的 `RoomAction` 之一(字符串形式)。 */
  action: string;
  /** 该动作的载荷;**键名逐条取自服务端 `ActionPayload`**。 */
  payload: Record<string, unknown>;
}

/**
 * 发送端口 —— 由**薄绑定**注入(`net/action_binding.ts` / `main.ts`)。
 *
 * 只有两个方法,是因为入口只需要这两件事实:
 * 「现在允许发吗」与「把这条送出去,成不成」。
 * 它不知道 `SessionHandle` 长什么样,也不需要知道。
 */
export interface ActionPorts {
  /** 真发送。返回是否**真的写进了链路**(与 `SessionHandle.sendAction` 同契约:未连接返回 false)。 */
  sendAction(intent: { action: string; [k: string]: unknown }): boolean;
  /** 现在允许发吗(已连接 **且** 握手完成)。`false` ⇒ 入口走"未连接"分支,**一个字节都不发**。 */
  canSend(): boolean;
}

/** 构建结果:要么给出可发的请求,要么给出**可读**的拒绝原因(不猜默认值)。 */
export type BuildOutcome =
  | { ok: true; request: ActionRequest }
  | { ok: false; reason: string };

/** 一次触发的结局。UI 直接显示 `status`;测试断言 `sent` / `code` / `request`。 */
export interface EntryOutcome {
  /** 是否真的发出了报文。 */
  sent: boolean;
  /** 分流用的**结构**(不是靠读中文短语判断)。 */
  code: 'OK' | 'INVALID_INPUT' | 'NOT_CONNECTED';
  /** 给玩家读的一行话。**任何分支都非空** —— 这是"不静默"的出口。 */
  status: string;
  /** 真的发出去的那份请求;未发出为 `null`。 */
  request: ActionRequest | null;
}

/** `CRAFT` 的入参。`have` 是服务端 `craft.ts` 要求的背包明细(见那里文件头)。 */
export interface CraftInput {
  /** 要合成的**产物** id(冻结内容表里的编号)。 */
  itemId?: unknown;
  /** 背包明细:`{ "物品id": 数量 }`。 */
  have?: unknown;
}

/** 开箱(`OPEN_CHEST` / `USE_OWN_CHEST`)的入参 —— 键名取自 `ActionPayload`。 */
export interface ChestInput {
  /** 目标格 x(数字)。 */
  x?: unknown;
  /** 目标格 y(数字)。 */
  y?: unknown;
  /** 要取放的物品 id;省略 = **只打开看**(服务端 `runChestAction` 的 `itemId === null` 分支)。 */
  itemId?: unknown;
  /** 正 = 存入 / 负 = 取出;省略时服务端按 1(存入)。 */
  count?: unknown;
}

/** `START_PARTY` 的入参。 */
export interface PartyInput {
  /**
   * 房间已选模式的**回声**。服务端只拿它做一致性核对(`start_party.ts` 的
   * `resolveMode`):给了且与房间不一致 ⇒ `INVALID`;**省略** ⇒ 不核对。
   * ⚠️ 本动作**不设模式**(设模式是 `SET_PARTY_MODE` 的事)。
   */
  partyMode?: unknown;
}

/**
 * `USE_ITEM` 的入参 —— 两格都**复用** `ActionPayload` 现成字段
 * (`server/src/net/room.ts` 的 `itemId` / `targetId`),故 wire 与 `ActionPayload`
 * 都不动(见 `docs/TASK-99-use-item-verb.md` §3)。
 */
export interface UseItemInput {
  /** 要用掉的那件物品 id(内容表编号;**正整数**)。 */
  itemId?: unknown;
  /**
   * 对**谁**用(玩家 id)。**省略 = 对自己用** —— 服务端 payload 缺省即此语义;
   * ⇒ 本层省略时**整个键不出现**,不写 `undefined`(否则线上会多一个 `"targetId":null`)。
   */
  targetId?: unknown;
}

/**
 * 动作回执的最小形状 —— 与 `net/session.ts` 的 `ActionResultFrame` **结构兼容**
 * (那边多一个 `t`,结构上无妨),但本文件不 import 它:本层零依赖。
 */
export interface EntryReceipt {
  action: string;
  ok: boolean;
  kind: string;
  reason?: string;
  effect?: Record<string, unknown>;
}

/* ═══════════════════════════ 2. 入参守卫(纯) ═══════════════════════════ */

/** 有限数(服务端 `numField` 同一判据)。 */
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 整数(内容表 id / 格坐标 / 件数都是整数)。 */
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 背包明细 `{ "物品id": 数量 }` —— 与 `craft.ts` 的 `stockField` **同一判据**
 * (键能转成整数、值必须是有限数;数组与 null 都不算)。
 *
 * ⚠️ 这是唯一一处"照抄服务端判据"的地方,而它只是**三行守卫**、不是会漂的判定;
 * 真正的配方匹配与扣减仍在内容层(`matchRecipeByTags`),不在客户端。
 */
function isDetail(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!Number.isInteger(Number(k))) return false;
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

/* ═══════════════════════════ 3. 六个构建器(纯函数) ═══════════════════════════ */

/**
 * `CRAFT` —— 合成一份产物。
 *
 * ⚠️ `have` **是必填**,不是我们苛刻:服务端 `craft.ts` 没有别的读口
 *    (`authoritativeItemTotal()` 只给总量,`inventoryDetailOf()` 恒 `null`),
 *    缺了它就回 `INVALID`"需要 have"。与其发一条注定被拒的报文,
 *    不如在入口就说清楚 —— 这才是"不发 + 有话说"。
 */
export function craftRequest(input: CraftInput): BuildOutcome {
  if (!isInt(input.itemId)) {
    return { ok: false, reason: 'CRAFT 需要 itemId(整数:内容表里的可合成产物)' };
  }
  if (!isDetail(input.have)) {
    return {
      ok: false,
      reason: 'CRAFT 需要 have(背包明细:{ "物品id": 数量 })'
        + ' —— 服务端没有按物品明细的读口,明细只能由客户端给(见 server/src/net/actions/craft.ts)',
    };
  }
  return {
    ok: true,
    request: { action: 'CRAFT', payload: { itemId: input.itemId, have: { ...input.have } } },
  };
}

/** `SLEEP` —— 上床睡觉。服务端 `ActionPayload` 对它**没有**任何字段 ⇒ 空载荷。 */
export function sleepRequest(): BuildOutcome {
  return { ok: true, request: { action: 'SLEEP', payload: {} } };
}

/** 开箱的共用构建器 —— 两个动作的差别**只有动作名**(容器由服务端那一侧选)。 */
function chestBuild(action: 'OPEN_CHEST' | 'USE_OWN_CHEST', input: ChestInput): BuildOutcome {
  if (!isNum(input.x) || !isNum(input.y)) {
    return { ok: false, reason: `${action} 需要 x / y(数字:目标箱子的格坐标)` };
  }
  const payload: Record<string, unknown> = { x: input.x, y: input.y };
  if (input.itemId !== undefined) {
    if (!isInt(input.itemId)) {
      return { ok: false, reason: `${action} 的 itemId 必须是整数(内容表里的物品 id)` };
    }
    payload.itemId = input.itemId;
  }
  if (input.count !== undefined) {
    /* `count` 的**符号**是方向(正 = 存入 / 负 = 取出),0 与非整数服务端一律拒。
       ⇒ 在入口就拦,省掉一条注定 `INVALID` 的往返。 */
    if (!isInt(input.count) || input.count === 0) {
      return { ok: false, reason: `${action} 的 count 必须是非零整数(正 = 存入 / 负 = 取出)` };
    }
    if (payload.itemId === undefined) {
      /* 服务端的判序是"先看 itemId":没有 itemId 就当**只打开看**,`count` 被忽略。
         静默忽略会让玩家以为存了/取了 —— 故在入口就明确拒绝。 */
      return {
        ok: false,
        reason: `${action} 给了 count 却没给 itemId ⇒ 服务端只会"打开看"并忽略 count`,
      };
    }
    payload.count = input.count;
  }
  return { ok: true, request: { action, payload } };
}

/** `OPEN_CHEST` —— 动那一格的**公共**内容(全房共享一份)。 */
export function openChestRequest(input: ChestInput): BuildOutcome {
  return chestBuild('OPEN_CHEST', input);
}

/** `USE_OWN_CHEST` —— 动那一格里**自己**的私有抽屉(别人看不到也拿不到)。 */
export function useOwnChestRequest(input: ChestInput): BuildOutcome {
  return chestBuild('USE_OWN_CHEST', input);
}

/**
 * `START_PARTY` —— 把房间**已选**的模式开成一局(本动作不改模式)。
 *
 * 不给 `partyMode` 就不带这个键:服务端的核对是"给了才比",
 * 而客户端此刻未必拿得到 `state.meta.partyMode` ⇒ 不知道就别声称。
 */
export function startPartyRequest(input: PartyInput = {}): BuildOutcome {
  const echo = input.partyMode;
  if (echo !== undefined && (typeof echo !== 'string' || echo.length === 0)) {
    return {
      ok: false,
      reason: 'START_PARTY 的 partyMode 若给出必须是非空字符串(它只是与房间已选模式的回声核对)',
    };
  }
  const payload: Record<string, unknown> = {};
  if (echo !== undefined) payload.partyMode = echo;
  return { ok: true, request: { action: 'START_PARTY', payload } };
}

/**
 * `USE_ITEM` —— 对某个目标用掉背包里的**一件**(TASK-99)。
 *
 * `itemId` 必须是**正整数**:服务端 `itemId` 是内容表编号,`0` / 负数 / 小数 /
 * 字符串在那边一律 `INVALID` ⇒ 在入口就拦,省掉一条注定被拒的往返。
 *
 * `targetId` **可选**,省略 = 对自己用。⚠️ 省略时**整个键不出现**(不写 `targetId: undefined`):
 * 本层的载荷会被**逐键**读(判据比对键集合、`ActionEntry.submit` 再展开一次),
 * 挂一个 `undefined` 就在键集合里多出一个键 ⇒ "键不存在"这条性质当场失真;
 * 而服务端认的 `targetId` 只有两种形态:**非空字符串**,或**根本没有这个键**。
 * (给了空串/非字符串则**明确拒绝** —— 那会被读成"有目标但解析不出来",
 * 把「对自己用」变成「目标非法」,两种结果差得很远。)
 */
export function useItemRequest(input: UseItemInput = {}): BuildOutcome {
  if (!isInt(input.itemId) || input.itemId <= 0) {
    return { ok: false, reason: 'USE_ITEM 需要 itemId(正整数:内容表里的物品 id)' };
  }
  const payload: Record<string, unknown> = { itemId: input.itemId };
  if (input.targetId !== undefined) {
    if (typeof input.targetId !== 'string' || input.targetId.length === 0) {
      return {
        ok: false,
        reason: 'USE_ITEM 的 targetId 若给出必须是非空字符串(目标玩家 id);'
          + '想对自己用就**别给**这个键,别给空串',
      };
    }
    payload.targetId = input.targetId;
  }
  return { ok: true, request: { action: 'USE_ITEM', payload } };
}

/* ═══════════════════════════ 4. 回执 → 玩家能读的一句话(纯) ═══════════════════════════ */

/** 动作的**显示名**(只影响文案,不影响协议)。 */
const LABELS: Readonly<Record<string, string>> = {
  CRAFT: '合成',
  SLEEP: '睡觉',
  OPEN_CHEST: '开公共箱',
  USE_OWN_CHEST: '开自己的箱',
  START_PARTY: '派对开局',
  USE_ITEM: '使用道具',
};

/** 把载荷压成一小段可读文本(对象/数组跳过 —— 一行 HUD 塞不下嵌套明细)。 */
function inlinePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || (typeof v === 'object' && v !== null)) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.length === 0 ? '' : ` (${parts.join(' ')})`;
}

/**
 * 把一次 `actionResult` 回执变成**一行玩家能读的话**。
 *
 * 四种失败分类给四句**不同**的话:`PERMISSION`(越权)与 `INVALID`(参数/状态不对)
 * 对玩家是两件不同的事,混成"操作失败"就等于把服务端的分类丢了。
 * `INVALID` 会把服务端给的 `reason` 带出来 —— 那是**可操作**的信息
 * ("只有站在卧室里才能睡觉" / "材料不足:…" / "格 (3,4) 不是箱子")。
 */
export function describeEntryReceipt(r: EntryReceipt): string {
  const what = LABELS[r.action] ?? r.action;
  if (r.ok) return `${what} ✓${inlinePayload(r.effect ?? {})}`;
  switch (r.kind) {
    case 'PERMISSION':
      return `${what} ✗ 你没有这个权限`;
    case 'NOT_IMPLEMENTED':
      return `${what} ✗ 服务端还没有这个动作的执行层`;
    case 'ROOM_CLOSED':
      return `${what} ✗ 房间已关闭`;
    case 'INTERNAL':
      /* ★ WS-FND-134(P2):**内部错**必须是独立的一档 —— 修前服务端把
         "执行抛错"回报成 `INVALID`,玩家读到的是"服务端拒绝了,但没给理由"
         或一句参数错的话,于是"我发错了"与"服务端崩了"在现场同形。
         ⚠️ 文案里点名"已记日志":服务端那侧确实会留痕(见 `ws_server.onAction`
         与 `room.colyseus` 的 action-error),玩家据此可以放心报障。 */
      return `${what} ✗ 服务端内部错误(已记日志)${r.reason === undefined ? '' : `:${r.reason}`}`;
    case 'INVALID':
      return `${what} ✗ ${r.reason ?? '服务端拒绝了,但没给理由'}`;
    default:
      return `${what} ✗ 未知回执 ${r.kind}${r.reason === undefined ? '' : `(${r.reason})`}`;
  }
}

/* ═══════════════════════════ 5. 入口(纯逻辑 + 注入端口) ═══════════════════════════ */

/**
 * 动作入口。
 *
 * 它**没有**任何 IO 能力:发不发得出去由 `ports` 回答,怎么发由 `ports` 做。
 * ⇒ 同一份入口逻辑在测试里注一个记录器、在生产里注 `SessionHandle.sendAction`,
 *   两者跑的是**同一段**判定(这正是本仓反复记的"两处都对、合起来不对"的对照面)。
 */
export class ActionEntry {
  private readonly ports: ActionPorts;
  /** 最近一行可读状态(UI 直接显示)。 */
  private statusText = '动作入口:待命';
  /** 最近真的发出去的那份请求(诊断/自检用,不参与任何判定)。 */
  private lastSent: ActionRequest | null = null;
  /** 真的发出去过几条(断言"没发"用)。 */
  private sends = 0;

  constructor(ports: ActionPorts) {
    this.ports = ports;
  }

  /** 最近一行可读状态。 */
  get status(): string {
    return this.statusText;
  }

  /** 最近真的发出去的请求;从未发出为 `null`。 */
  get lastRequest(): ActionRequest | null {
    return this.lastSent;
  }

  /** 真的发出去过几条。 */
  get sentCount(): number {
    return this.sends;
  }

  /** 合成一份产物。 */
  craft(input: CraftInput): EntryOutcome {
    return this.submit(craftRequest(input));
  }

  /** 上床睡觉。 */
  sleep(): EntryOutcome {
    return this.submit(sleepRequest());
  }

  /** 开公共储物箱(可带 itemId/count 直接存取)。 */
  openChest(input: ChestInput): EntryOutcome {
    return this.submit(openChestRequest(input));
  }

  /** 开自己的储物箱。 */
  useOwnChest(input: ChestInput): EntryOutcome {
    return this.submit(useOwnChestRequest(input));
  }

  /** 派对开局。 */
  startParty(input: PartyInput = {}): EntryOutcome {
    return this.submit(startPartyRequest(input));
  }

  /** 对某个目标用掉一件(省略 `targetId` = 对自己用)。 */
  useItem(input: UseItemInput = {}): EntryOutcome {
    return this.submit(useItemRequest(input));
  }

  /**
   * 回执到达 —— 薄绑定把它挂到 `SessionHandle.onActionResult`。
   *
   * `ok === false` 的四种分类都会被翻成**不同**的一句话(见 `describeEntryReceipt`);
   * 返回值就是新的 `status`,调用方不必再读一次 getter。
   */
  onActionResult(r: EntryReceipt): string {
    this.statusText = describeEntryReceipt(r);
    return this.statusText;
  }

  /** 三条分支:参数不对 ⇒ 不发;未连接 ⇒ 不发;否则**恰好发一次**。 */
  private submit(built: BuildOutcome): EntryOutcome {
    if (!built.ok) {
      this.statusText = built.reason;
      return { sent: false, code: 'INVALID_INPUT', status: built.reason, request: null };
    }
    const request = built.request;
    const what = LABELS[request.action] ?? request.action;

    if (!this.ports.canSend()) {
      const status = `${what} ✗ 未连接(或握手未完成)⇒ 没发出去`;
      this.statusText = status;
      return { sent: false, code: 'NOT_CONNECTED', status, request: null };
    }

    /* ⚠️ 铺平成**一层**(服务端按扁平字段读:`ctx.payload.x` / `ctx.payload.itemId`)。
       顺序是 `{ ...payload, action }`:动作名放在展开**之后**,
       与 `encodeActionUplink` 把 `t` 放在展开之后的纪律一致 ——
       载荷里就算有同名字段也不能覆盖动作名。
       每次触发都新建一份对象 ⇒ 两次触发之间没有共享引用(不串包)。 */
    const accepted = this.ports.sendAction({ ...request.payload, action: request.action });
    if (!accepted) {
      /* 端口说"没写进去"(socket 未开):这**不是**成功,也不假装成功。 */
      const status = `${what} ✗ 链路没写进去(socket 未开)`;
      this.statusText = status;
      return { sent: false, code: 'NOT_CONNECTED', status, request: null };
    }

    this.sends += 1;
    this.lastSent = request;
    const status = `${what} → 已发${inlinePayload(request.payload)}`;
    this.statusText = status;
    return { sent: true, code: 'OK', status, request };
  }
}