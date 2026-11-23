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
 * ★ 第十轮审计 P1(WS-FND-138):**同一形态又出现一次**,而且这次是四个:
 * ```
 * BREED_TAME            服务端 actions/breed_tame.ts 已接线   ← 客户端零入口
 * BUY_ITEM              服务端 actions/buy_item.ts 已接线     ← 客户端零入口
 * USE_ALCHEMY_FURNACE   服务端 actions/use_alchemy_furnace.ts ← 客户端零入口
 * PLACE_AUTOMATION      服务端 actions/place_automation.ts    ← 客户端零入口(连组件形态都没有)
 * ```
 * 「零入口」不会让任何断言变红:门禁查的是**服务端**的行为,而「玩家按得到吗」
 * 不在任何判据里。⇒ 本文件补齐这四个构建器,键位在 `net/action_binding.ts`
 * 的 `HOTBAR_KEYS`(数字热键),`main.ts` 把宿主参数注进去。
 * ⚠️ 仍然**没接**的形态如实登记在 `wiring_ledger.ts` 的 `CLIENT_ENTRY_LEDGER`:
 * `PLACE_AUTOMATION` 的「分拣带 lane 配置」形态(报文键 `lane` 不属 `ActionPayload`)、
 * 以及管理类动作(`KICK_MEMBER` / `SET_ROOM_ACCESS` / `SET_PARTY_MODE` /
 * `SET_MEMBER_ROLE` / `RESET_WORLD` / `CLOSE_ROOM` / `MODIFY_TOWN` / `WIRE_EDIT`)
 * —— 它们**至今没有客户端入口**,按同一套口径登记,而不是假装做了。
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

/* ── ★ 第十轮(WS-FND-138):四个此前「服务端有、客户端零入口」的动作 ──────────
 *
 * 键名逐条取自 `server/src/net/room.ts` 的 `ActionPayload`:
 * ```
 * BREED_TAME          op / petId / mobId / mateId(+ itemId,投喂用)
 * BUY_ITEM            itemId / qty / orderId
 * USE_ALCHEMY_FURNACE itemId / orderId
 * PLACE_AUTOMATION    x / y / kind(组件形态)或 itemId(播种形态)
 * ```
 * ⚠️ `qty` 是**必填**不是"默认 1":服务端 `actions/buy_item.ts` 的判序第 4 步
 *   对缺失的 `qty` 直接 `INVALID`("缺省不等于 1")。在入口就拦掉,省一条注定被拒的往返。
 */

/**
 * `BREED_TAME` 的 `op` 取值 —— **字面写死在本层**,因为客户端不能 import 服务端
 * (`client/` 不许把 `server/**` 拖进浏览器包)。防漂移靠判据而不靠注释:
 * `tests/WS-FND-138-client-entry-parity.test.ts` 拿服务端导出的 `TameOp`
 * 逐个对账(漂了当场红)。
 */
export const CLIENT_TAME_OPS: readonly string[] = ['FEED', 'TAME', 'BREED', 'RANCH'];

/**
 * `BREED_TAME` 的入参 —— **一个动作、四个子操作**(`op` 选分支)。
 *
 * ```ts
 * { op: 'FEED',  petId, itemId, mobId? }   // 投喂:首次投喂即「登记」⇒ mobId 必填
 * { op: 'TAME',  petId }                   // 驯服:好感达标 + 无主
 * { op: 'BREED', petId, mateId }           // 繁殖:两只都归自己且都达标
 * { op: 'RANCH', petId }                   // ★ 送进牧场(WS-FND-119 的真实入口)
 * ```
 * `petId` 是**非空字符串**(世界侧的生物实例 id),不是内容表编号 ——
 * 与 `mobId`(物种 id)是两层,别混(见 `mobs/spawner.ts` 的 id 规则)。
 */
export interface BreedTameInput {
  /** 子操作:`FEED` / `TAME` / `BREED` / `RANCH`。 */
  op?: unknown;
  /** 宠物 id(非空字符串;缺 ⇒ 拒)。 */
  petId?: unknown;
  /** 物种 id(非空字符串;**首次投喂**必填)。 */
  mobId?: unknown;
  /** 繁殖配对的那一只(`BREED` 必填)。 */
  mateId?: unknown;
  /** 投喂用的那件食物(`FEED` 必填;内容表编号,正整数)。 */
  itemId?: unknown;
}

/** `BUY_ITEM` 的入参(百货店 515 的一件货)。 */
export interface BuyItemInput {
  /** 要买的物品 id(内容表编号,正整数)。 */
  itemId?: unknown;
  /** 件数(正整数;**必填**)。 */
  qty?: unknown;
  /** 客户端请求号(可选幂等键;给了就原样透传)。 */
  orderId?: unknown;
}

/** `USE_ALCHEMY_FURNACE` 的入参(站在炼金台上用一份材料)。 */
export interface AlchemyFurnaceInput {
  /** 投进去的材料 id(内容表编号,正整数)。 */
  itemId?: unknown;
  /** 客户端请求号(可选幂等键;世界侧拿它防"同一单炼出第二炉")。 */
  orderId?: unknown;
}

/**
 * `PLACE_AUTOMATION` 的入参 —— **两种形态**:
 * ```
 * { kind, x, y }      组件形态:kind 必须是 wiring 注册表里的名字
 * { itemId, x, y }    播种形态(WS-FND-119):种子 = itemId
 * ```
 * ⚠️ 客户端**不持有 kind 名单**(那是服务端 `wiring/components.ts` 的注册表):
 * 组件形态的 `kind` 由**调用方**(UI 按钮 / 后续面板)给,键盘路径走**播种形态**
 * (只给 `itemId`)—— 硬编码一份 kind 名单就是"第二份实现",而它迟早漂。
 * 两种都不给 ⇒ 入口**明确拒绝**(服务端判序第 4 步也是 `INVALID`)。
 */
export interface PlaceAutomationInput {
  /** 目标格 x / y(整数)。 */
  x?: unknown;
  y?: unknown;
  /** 组件种类名(非空字符串;组件形态必填)。 */
  kind?: unknown;
  /** 播种形态的种子 id(正整数)。 */
  itemId?: unknown;
}

/**
 * `GATHER` 的入参(★ WS-FND-154)—— 只有**目标格**两个整数(键名取自
 * `ActionPayload` 的 `x` / `y`,与 `PLACE_BLOCK` / `BREAK_BLOCK` 同键)。
 *
 * 客户端**不报**「那一格是什么」:快照里没有格子物件数据,而采什么由服务端从
 * 内容表判(§3.1 自然资源的物件,见 `server/src/net/actions/gather.ts`)。
 */
export interface GatherInput {
  /** 目标格 x(整数)。 */
  x?: unknown;
  /** 目标格 y(整数)。 */
  y?: unknown;
}

/**
 * `NPC_TALK` 的入参(★ WS-FND-188)。
 *
 * `npcId` 取**服务端下发的那张表**里的 `id`(`NpcWireDef.id`,
 * 见 `client/src/three/boot.ts` 的 `nearbyNpc`),不是客户端自己编的编号 ——
 * 服务端只认得 `server/src/npc/defs.ts` 里的 id,编一个只会换来一条 INVALID。
 */
export interface NpcTalkInput {
  /** NPC 的稳定 id(非空字符串)。 */
  npcId?: unknown;
}

/**
 * `SET_PARTY_MODE` 的入参(★ WS-FND-151)。
 *
 * `partyMode` 是**冻结层 `PARTY_MODES` 的 key**(`BRIDGE_CTF` 等),不是下标 ——
 * 服务端 `net/actions/admin.ts:66` 读的就是 `ctx.payload.partyMode` 并原样交给
 * `setPartyModeBy(actorId, mode: PartyMode)`。
 */
export interface SetPartyModeInput {
  /** 模式 key(非空字符串;合法性由 `ui/party_panel.partyModeIntent` 在选之前拦)。 */
  partyMode?: unknown;
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

/* ── ★ 第十轮(WS-FND-138):四个补入口的构建器 ──
 *
 * 与上面六个**同一条纪律**:
 *   1 载荷键逐条取自 `ActionPayload`(不发明协议);
 *   2 省掉某个键时**整个键不出现**(不写 `undefined`:线上会多一个 `null`);
 *   3 参数不对 ⇒ 在入口就拒并给**可读**理由,绝不发一条注定被拒的报文。
 */

/**
 * `BREED_TAME` —— 投喂 / 驯服 / 繁殖 / 送进牧场(由 `op` 选分支)。
 *
 * 为什么在这里就把 `op` 的分支校验做完:`op` 打错时服务端回的是
 * 「需要 op(FEED / TAME / BREED / RANCH;实测 …)」—— 那句话在**按键当场**说出来
 * 比等一趟往返有用得多,而且省掉一条注定 `INVALID` 的报文。
 */
export function breedTameRequest(input: BreedTameInput = {}): BuildOutcome {
  const op = input.op;
  if (typeof op !== 'string' || !CLIENT_TAME_OPS.includes(op)) {
    return {
      ok: false,
      reason: `BREED_TAME 需要 op(${CLIENT_TAME_OPS.join(' / ')})=喂/驯/繁/牧;实测 ${JSON.stringify(op)}`,
    };
  }
  if (typeof input.petId !== 'string' || input.petId.length === 0) {
    return {
      ok: false,
      reason: 'BREED_TAME 需要 petId(非空字符串:**离你最近的生物实例 id**,不是物种 id)'
        + ' —— 附近没有生物时按 1 无从驯养,先走过去',
    };
  }
  const payload: Record<string, unknown> = { op, petId: input.petId };
  if (input.mobId !== undefined) {
    if (typeof input.mobId !== 'string' || input.mobId.length === 0) {
      return { ok: false, reason: 'BREED_TAME 的 mobId 若给出必须是非空字符串(物种 id)' };
    }
    payload.mobId = input.mobId;
  }
  if (input.mateId !== undefined) {
    if (typeof input.mateId !== 'string' || input.mateId.length === 0) {
      return { ok: false, reason: 'BREED_TAME 的 mateId 若给出必须是非空字符串(配偶的生物实例 id)' };
    }
    payload.mateId = input.mateId;
  }
  /* `FEED` 的 `itemId` 是**必填**:服务端 `breed_tame.ts` 的 FEED 分支第一句就是
     「FEED 需要 itemId(整数,内容表里的食物)」⇒ 缺了不发,理由在入口给。 */
  if (op === 'FEED' && !isInt(input.itemId)) {
    return {
      ok: false,
      reason: 'BREED_TAME 的 FEED 需要 itemId(整数:投喂的食物)'
        + ' —— 客户端用「最近物品」,还没有就先按 E 拆一块或 F 捡一件',
    };
  }
  if (input.itemId !== undefined) {
    if (!isInt(input.itemId) || input.itemId <= 0) {
      return { ok: false, reason: 'BREED_TAME 的 itemId 必须是正整数(内容表里的物品 id)' };
    }
    payload.itemId = input.itemId;
  }
  /* `BREED` 的 `mateId` 同样必填:服务端那一支要两只宠物,缺一只就没得判。 */
  if (op === 'BREED' && payload.mateId === undefined) {
    return { ok: false, reason: 'BREED_TAME 的 BREED 需要 mateId(配偶的生物实例 id)' };
  }
  return { ok: true, request: { action: 'BREED_TAME', payload } };
}

/**
 * `BUY_ITEM` —— 在无人自助售货摊(515)上买货。
 *
 * `qty` **必填**:服务端 `buy_item.ts` 的判序第 4 步对缺失/非正整数的 `qty`
 * 直接 `INVALID`(注释原文「缺省不等于 1,缺了就是 INVALID」)⇒ 本层不替它猜 1。
 */
export function buyItemRequest(input: BuyItemInput = {}): BuildOutcome {
  if (!isInt(input.itemId) || input.itemId <= 0) {
    return {
      ok: false,
      reason: 'BUY_ITEM 需要 itemId(正整数:内容表里的物品 id)'
        + ' —— 客户端用「最近物品」,还没有就先按 E 拆一块或 F 捡一件',
    };
  }
  if (!isInt(input.qty) || input.qty <= 0) {
    return { ok: false, reason: 'BUY_ITEM 需要 qty(正整数:买几件;服务端对缺省的单位置直接拒)' };
  }
  const payload: Record<string, unknown> = { itemId: input.itemId, qty: input.qty };
  if (input.orderId !== undefined) {
    if (typeof input.orderId !== 'string' || input.orderId.length === 0) {
      return { ok: false, reason: 'BUY_ITEM 的 orderId 若给出必须是非空字符串(幂等请求号)' };
    }
    payload.orderId = input.orderId;
  }
  return { ok: true, request: { action: 'BUY_ITEM', payload } };
}

/**
 * `USE_ALCHEMY_FURNACE` —— 站在炼金台上投一份材料。
 *
 * 站位由**服务端**判(它读 `lastRoomEffects[].roomKey` 的 `ALCHEMY_LAB`),
 * 客户端**不报坐标**:报了也没人读,而"报一个没人读的字段"会让后来者以为它是契约。
 */
export function useAlchemyFurnaceRequest(input: AlchemyFurnaceInput = {}): BuildOutcome {
  if (!isInt(input.itemId) || input.itemId <= 0) {
    return {
      ok: false,
      reason: 'USE_ALCHEMY_FURNACE 需要 itemId(正整数:投进炼金台的材料 id)'
        + ' —— 客户端用「最近物品」,还没有就先按 E 拆一块或 F 捡一件',
    };
  }
  const payload: Record<string, unknown> = { itemId: input.itemId };
  if (input.orderId !== undefined) {
    if (typeof input.orderId !== 'string' || input.orderId.length === 0) {
      return { ok: false, reason: 'USE_ALCHEMY_FURNACE 的 orderId 若给出必须是非空字符串(幂等请求号)' };
    }
    payload.orderId = input.orderId;
  }
  return { ok: true, request: { action: 'USE_ALCHEMY_FURNACE', payload } };
}

/**
 * `PLACE_AUTOMATION` —— 在某一格落一件自动化件(组件形态)或播一颗种子(播种形态)。
 *
 * ⚠️ 组件形态的 `kind` **不由本层核对合法性**(注册表在服务端
 * `wiring/components.ts` 的 `hasComponentKind`)—— 客户端只能把调用方给的名字
 * 原样送上,由服务端回一句话。硬编码名单 = 第二份实现,且必然与服务端漂。
 */
export function placeAutomationRequest(input: PlaceAutomationInput = {}): BuildOutcome {
  if (!isInt(input.x) || !isInt(input.y)) {
    return { ok: false, reason: 'PLACE_AUTOMATION 需要 x / y(整数:目标格坐标)' };
  }
  const hasKind = typeof input.kind === 'string' && input.kind.length > 0;
  const hasItem = isInt(input.itemId) && input.itemId > 0;
  if (input.kind !== undefined && !hasKind) {
    return { ok: false, reason: 'PLACE_AUTOMATION 的 kind 若给出必须是非空字符串(注册表里的种类名)' };
  }
  if (input.itemId !== undefined && !hasItem) {
    return {
      ok: false,
      reason: 'PLACE_AUTOMATION 的 itemId 若给出必须是正整数(播种形态的种子 id)'
        + ' —— 客户端用「最近物品」,还没有就先按 E 拆一块或 F 捡一件',
    };
  }
  if (!hasKind && !hasItem) {
    return {
      ok: false,
      reason: 'PLACE_AUTOMATION 需要 kind(组件形态)或 itemId(播种形态)**至少一种**'
        + ' —— 两种都没有时服务端回 INVALID(判序第 4 步),别发',
    };
  }
  const payload: Record<string, unknown> = { x: input.x, y: input.y };
  if (hasKind) payload.kind = input.kind;
  if (hasItem) payload.itemId = input.itemId;
  return { ok: true, request: { action: 'PLACE_AUTOMATION', payload } };
}

/**
 * `GATHER` —— 采**面前那格**上的可采集物(★ WS-FND-154)。
 *
 * 为什么在入口就要求**整数格**:服务端拿 `Math.floor(x)` 去查格上物件,而浮点坐标
 * (如 12.53)与「玩家以为的那一格」可能差一格 —— 与 `placeAutomation` 的端口必须走
 * `cellUnder` 是同一个理由(修一次,两处同口径)。
 *
 * ⚠️ 本层**不判**那一格能不能采:可采集性(内容表类别)/ 工具族 / 距离三件事只在
 *   `server/src/net/actions/gather.ts` 一处判。客户端替它猜 = 第二份实现,且客户端
 *   快照里**没有**格子物件数据(猜也猜不出来)。
 */
export function gatherRequest(input: GatherInput = {}): BuildOutcome {
  if (!isInt(input.x) || !isInt(input.y)) {
    return { ok: false, reason: 'GATHER 需要 x / y(整数:目标格坐标,取你面前那格)' };
  }
  return { ok: true, request: { action: 'GATHER', payload: { x: input.x, y: input.y } } };
}

/**
 * `NPC_TALK` —— 与身边那个 NPC 说话(★ WS-FND-188)。
 *
 * ## 本层只做一件事:把 `npcId` 原样送上
 * 「附近有没有人」「够不够近」由**两端各自**判:客户端判是为了给 HUD 那一行提示
 * (`three/boot.ts` 的 `nearbyNpc`),服务端判是**授权**(`net/actions/npc_talk.ts`
 * 用权威坐标重算)。⇒ 这里不预判"能不能说" —— 预判一次就是第二份距离口径,
 * 而两份距离口径的偏差只表现为"按了没反应"。
 */
export function npcTalkRequest(input: NpcTalkInput = {}): BuildOutcome {
  const id = input.npcId;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      ok: false,
      reason: 'NPC_TALK 需要 npcId(非空字符串:服务端下发的那张 NPC 表里的 id)',
    };
  }
  return { ok: true, request: { action: 'NPC_TALK', payload: { npcId: id } } };
}

/**
 * `SET_PARTY_MODE` —— **设模式**(改的是全房"这一局玩什么",不是开局)。
 *
 * ## 与 `START_PARTY` 的分工(别弄反)
 * ```
 * SET_PARTY_MODE  设模式:写 state.meta.partyMode(影响全房,含正在跑的那局)
 * START_PARTY     开局   :只把**房间已选**的模式开成一局(`V` 走的是这条)
 * ```
 * 服务端两条都有执行层(`server/src/net/actions/start_party.ts` 的文件头逐字写着),
 * 客户端此前**零入口** —— 缺的不是一行转发,而是 `ui/party_panel.ts` 那块选择器。
 *
 * ⚠️ 本层**不核对 key 是否合法**(词表在冻结层,选择器已经拦过):把"非法 key"
 * 在这里判一遍就是第二份实现,而与冻结层漂了没人会知道。
 * 权限(OWNER/ADMIN)也**不在这里判** —— 那是服务端 `authorize` 的事,
 * 被拒时会回一条带理由的 `PERMISSION` 回执。
 */
export function setPartyModeRequest(input: SetPartyModeInput = {}): BuildOutcome {
  const mode = input.partyMode;
  if (typeof mode !== 'string' || mode.length === 0) {
    return {
      ok: false,
      reason: 'SET_PARTY_MODE 需要 partyMode(冻结层 PARTY_MODES 的模式 key,如 BRIDGE_CTF)',
    };
  }
  return { ok: true, request: { action: 'SET_PARTY_MODE', payload: { partyMode: mode } } };
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
  /* ★ 第十轮(WS-FND-138):四个补入口的动作也要有**玩家读到的名字** ——
     否则被拒时状态行会显示原始动作名(`BUY_ITEM ✗ ...`),对玩家等于没提示。 */
  BREED_TAME: '驯养',
  BUY_ITEM: '购买',
  USE_ALCHEMY_FURNACE: '炼金台',
  PLACE_AUTOMATION: '放自动化件',
  /* ★ WS-FND-154:采集。没有这一行,被拒时状态行会显示原始动作名 `GATHER ✗ ...`。 */
  GATHER: '采集',
  /* ★ WS-FND-151:模式面板选完模式后,回执那一行读作「派对模式 → 已发」/「派对模式 ✗ ...」 */
  SET_PARTY_MODE: '派对模式',
  /* ★ WS-FND-188:与 NPC 说话。没有这一行,被拒时状态行会显示原始动作名
     (`NPC_TALK ✗ ...`),对玩家等于没提示。 */
  NPC_TALK: '与 NPC 说话',
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

  /* ── ★ 第十轮(WS-FND-138):四个此前**玩家按不到**的动作 ──
     它们和服务端执行层早就存在,缺的只是这一行:入口方法。
     键位/按钮 → 本方法 → `submit`(三支分流)→ 恰好一条报文。 */

  /** 驯养:投喂 / 驯服 / 繁殖 / 送进牧场(由 `op` 选分支)。 */
  breedTame(input: BreedTameInput = {}): EntryOutcome {
    return this.submit(breedTameRequest(input));
  }

  /** 购买(无人货摊 515 的一件货)。 */
  buyItem(input: BuyItemInput = {}): EntryOutcome {
    return this.submit(buyItemRequest(input));
  }

  /** 炼金台:投一份材料进炉。 */
  useAlchemyFurnace(input: AlchemyFurnaceInput = {}): EntryOutcome {
    return this.submit(useAlchemyFurnaceRequest(input));
  }

  /** 落一件自动化件(`kind`)/ 播一颗种子(`itemId`)到某一格。 */
  placeAutomation(input: PlaceAutomationInput = {}): EntryOutcome {
    return this.submit(placeAutomationRequest(input));
  }

  /**
   * 采集(★ WS-FND-154):采「面前那格」上的**可采集物**(内容表 §3.1 自然资源)。
   *
   * ⚠️ 与 `placeAutomation` 同一条纪律:参数只是**格坐标**,「那一格能不能采」
   * (可采集性 / 工具 / 距离)全在服务端一处判 —— 客户端没有格子物件数据,
   * 替它猜就是第二份实现。
   */
  gather(input: GatherInput = {}): EntryOutcome {
    return this.submit(gatherRequest(input));
  }

  /**
   * 与 NPC 说话(★ WS-FND-188):把 `npcId` 送上去,台词随回执的 `effect.line` 回来。
   *
   * ⚠️ 本方法**不判**"附近有没有人":那是**输入层**的事(它才知道玩家在哪、
   * 键位现在归谁)—— 见 `main.ts` 的 `T` 分支与 `three/boot.ts#nearbyNpc`。
   * 这里只负责让那一条报文走**同一条**三支分流(参数不对 / 未连接 / 发)。
   */
  npcTalk(input: NpcTalkInput = {}): EntryOutcome {
    return this.submit(npcTalkRequest(input));
  }

  /**
   * 设派对模式(★ WS-FND-151:选择器在 `ui/party_panel.ts`,本方法只发一条报文)。
   *
   * ⚠️ **不是**开局:`START_PARTY` 仍由 `V` 走,那条只开"房间已选"的模式。
   */
  setPartyMode(input: SetPartyModeInput = {}): EntryOutcome {
    return this.submit(setPartyModeRequest(input));
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