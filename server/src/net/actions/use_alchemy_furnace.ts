/**
 * `USE_ALCHEMY_FURNACE` —— **在炼金台上炼一件东西**。
 *
 * ## ⚠️ 这一版是**本地确定性实现**;LLM 炼金的接线**不在本轮**
 *
 * 炼金台在内容层是 `536`【AI核心】万物奇想炼金炉(`recipe: {157:4,116:4,130:2}`),
 * 手册给它的功能是「自由放入任意 2~4 件非蓝图物品,**调用大模型** + 特定属性算法
 * 生成全新奇物」;`rooms/effects.ts` 的 `ROOM_EFFECT_DECISION.ALCHEMY_LAB` 也写着
 * 「需 LLM 与陈列系统 ⇒ 未实装」;世界侧的 `WorldSim.forgeAlchemy()` 走的正是
 * `alchemy/index.ts` 的 LLM 编排(`createAlchemyService` + `StubLlmClient`)。
 *
 * ⇒ 那条路**不接外部服务**:本文件**不**调用 `forgeAlchemy`,也**不** import
 *   `server/src/alchemy/**`。接上来的是台面的**确定性**语义:
 * ```ts
 *   站在炼金室(ALCHEMY_LAB) + 内容层已有配方的产物  ⇒ 扣材料、给产物
 * ```
 * 「任意材料 → 全新奇物」(自由炼金)仍然是未实装项,留给 LLM 那一轮;
 * 本文件在回执里如实带上 `freeForge: false`,不假装它已经是自由炼金。
 *
 * ## 站位判定读哪里(以及为什么该口不在契约里)
 *
 * 动作**不**自己识别房间 —— 那会是第二份实现。判定读世界源慢帧的产出
 * `lastRoomEffects[].roomKey`,即 `rooms/effects.ts` 的 `stepRoomEffects`
 * **消费过的那个 `roomKey`**(`WorldSim.tickRoomEffects` 逐玩家写入)。
 * 与 `actions/sleep.ts` 读 `roomEffectOf()` 是**同一手法**。
 *
 * 为什么不是直接 `roomEffectOf()`:`RoomEffectState` 只有
 * `inOnsen/inBedroom/inForge/inCanteen` 四个字段,炼金室是
 * `SYSTEM_UNLOCK`(无逐玩家状态位)⇒ 那个口拿不到 `ALCHEMY_LAB`。
 * `lastRoomEffects` 是同一慢帧的**姊妹产物**,`roomKey` 就在它上面。
 *
 * ⚠️ `ActionContext.host` 声明为 `WorldSaveHost`,而 `lastRoomEffects`
 *   目前**不在**那份结构化契约里(`net/room.ts` 的可选成员清单)。
 *   本次改动只允许碰本文件 ⇒ 用**局部窄类型**读它;缺这一项时动作显式回
 *   `INVALID`,而不是静默跳过。若将来把它正式写进 `WorldSaveHost`,
 *   删掉下面的 `AlchemyLabReadPort` 即可(届时那段 `unknown` 转换也能收掉)。
 *
 * ## 三件必须**在同一处**做的事(照 `craft.ts` / `material.ts` 的纪律)
 *
 *   1 **权限闸**写在这里 —— 世界方法没有「谁」这个参数;权限位以
 *     `ACTION_PERMISSION.USE_ALCHEMY_FURNACE = 'publicStorage'` 为准
 *     ⇒ MEMBER / GUEST 在闸上被拦(`PERMISSION_MATRIX` 里两者都是 `false`),
 *     且**不产生任何副作用**。本文件不发明额外规则。
 *   2 材料扣减与产物入包**都**走 `ctx.applyInventory` —— 反作弊的总量守恒与
 *     凭证链都在那条路上,绕过它 = 绕过了本仓唯一的物品真值来源;
 *     产出侧必须**先** `ctx.grantItemSource` **再** `applyInventory(+n, source)`,
 *     否则 `checkInventory` 会按「凭空产出」拒(`ITEM_FROM_NOTHING`)。
 *   3 事务性:**产物收不下就把材料退回去**(带 source 的 +delta),不吞材料。
 *
 * ## 配方与材料匹配的唯一出处是内容层
 *
 * 只调 `matchRecipeByTags`(`shared/constants/items.ts` 的 CR-17 实现:确定件 +
 * 留白槽逐槽扣减),与 `CRAFT` **同一份**匹配器。这里**不新增配方表**、
 * 不复述留白语义 —— 两份实现今天一致、迟早漂移(`#245` 的「任意染料」)。
 *
 * ⚠️ 报文里的 `have`(背包明细)只能由客户端给:**本仓当前没有服务端按物品明细
 *   的读口**(`RoomRuntime.authoritativeItemTotal()` 只给**总量**;
 *   `WorldSim.inventoryDetailOf()` 按契约返回 `null`;`ActionContext` 既不暴露
 *   `db` 也不暴露那个读口)。⇒ 客户端只说「我有什么」,**扣什么、扣几件仍全由
 *   内容层决定**;能扣多少由权威总量兜底(扣减整批走 `applyInventory`,
 *   声明得比实际多会被反作弊整批拒)。
 *
 * ## 报文契约
 *
 * ```ts
 * { itemId: number, have: Record<number, number> }
 * ```
 */
import { ITEM_BY_ID, matchRecipeByTags } from '../../../../shared/constants/items.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * 炼金实验室的房间 key(内容层 `ROOM_RECIPES` 里 `required: [536, 537]` 的那条)。
 *
 * 写成常量而不是散在理由文本里:`stepRoomEffects` / `ROOM_EFFECT_DECISION`
 * 也按同一个字面量判定,两侧必须逐字一致。
 */
export const ALCHEMY_LAB_ROOM_KEY = 'ALCHEMY_LAB';

/**
 * `USE_ALCHEMY_FURNACE` 在世界源上真正需要的那**一项**能力(见文件头的
 * 「站位判定读哪里」)。`WorldSaveHost` 里没有它 ⇒ 局部窄类型 + 显式拒绝。
 */
type AlchemyLabReadPort = {
  lastRoomEffects?: readonly { playerId: string; roomKey: string | null }[];
};

/** `effect` 的声明形状:`ActionOutcome['effect']` 的值只允许基本类型。 */
type EffectRecord = NonNullable<ActionOutcome['effect']>;

/**
 * 本动作的报文键。`ActionPayload`(`room.ts`)只声明了别的动作用到的字段,
 * 而这条通道本就是泛型的(`ws_server.ts` 把客户端 JSON 原样递进来)
 * ⇒ 在**本文件**局部读取自己的键,`room.ts` 一个字不用动。
 */
type AlchemyPayload = ActionPayload & { have?: unknown };

/** 从 payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 取出「背包明细」(`物品 id → 数量`)。
 *
 * 形状不对就返回 `null`,由调用方给出可读的 `INVALID` —— 不猜默认值
 * (把缺失当成空背包会把「报文写错」与「真的没材料」混成同一个原因)。
 */
function stockField(v: unknown): Record<number, number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<number, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isInteger(id)) return null;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[id] = n;
  }
  return out;
}

/**
 * `USE_ALCHEMY_FURNACE`:站上炼金台,按内容层配方炼一份。
 *
 * 判序与回执(逐条对着判据):
 *   1 越权 ⇒ `PERMISSION`(`publicStorage`:MEMBER / GUEST 都无权),**零副作用**;
 *   2 没有世界源 ⇒ `NOT_IMPLEMENTED`(与 `material.ts` 同一契约:没有世界就没有
 *     可站的地面,更谈不上炼金台 —— 不能报成「你没权限」或「参数不对」);
 *   3 拿不到该玩家的房间归属(不在世界里 / 慢帧还没跑到)⇒ `INVALID`;
 *   4 当前房间不是 `ALCHEMY_LAB` ⇒ `INVALID`(失败路径**不动**背包);
 *   5 报文缺项 / 产物不在内容表 / 产物没有配方 ⇒ `INVALID`;
 *   6 配方不满足(材料不足)⇒ `INVALID`,**一个材料都不扣**;
 *   7 材料扣减被拒 ⇒ `INVALID`;
 *   8 产物收不下 ⇒ **退回材料** + `INVALID`(不吞);
 *   9 成功 ⇒ `OK` + `effect`(材料、产物、实际消耗明细)。
 */
export const useAlchemyFurnace: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* 1 权限闸:越权在此返回,且**未产生任何副作用**(背包一个数都没动)。 */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* 2 没有世界源 ⇒ 没有地面、没有房间可判。显式 NOT_IMPLEMENTED,
     不写成 `?.` 之后静默跳过(与 `materialsOf() === null` 同一条纪律)。 */
  if (ctx.host === null) {
    return {
      ok: false, kind: 'NOT_IMPLEMENTED',
      reason: '本房间没有世界源 ⇒ 没有炼金室可确认(也就没有可站的炼金台)',
    };
  }

  /* 3/4 站位:只认世界源慢帧的房间判定,不自己识别房间。 */
  const port = ctx.host as unknown as AlchemyLabReadPort;
  const rows = port.lastRoomEffects;
  if (!Array.isArray(rows)) {
    return {
      ok: false, kind: 'INVALID',
      reason: '世界源不提供房间效果判定(lastRoomEffects)⇒ 无法确认是否站在炼金台上',
    };
  }
  const row = rows.find((r) => r.playerId === ctx.actorId);
  if (row === undefined) {
    return {
      ok: false, kind: 'INVALID',
      reason: '拿不到该玩家的房间归属(不在世界里,或房间效果慢帧还没跑到)⇒ 无法确认是否站在炼金台上',
    };
  }
  if (row.roomKey !== ALCHEMY_LAB_ROOM_KEY) {
    return {
      ok: false, kind: 'INVALID',
      reason: `只有站在炼金室(${ALCHEMY_LAB_ROOM_KEY})里才能用炼金台`
        + `(当前所在房间:${row.roomKey ?? '无'})`,
    };
  }

  /* 5 参数:缺项/形状不对一律显式拒绝(不猜默认值)。 */
  const itemId = numField(ctx.payload.itemId);
  if (itemId === null || !Number.isInteger(itemId)) {
    return { ok: false, kind: 'INVALID', reason: '需要 itemId(整数,内容表里的产物)' };
  }
  const stock = stockField((ctx.payload as AlchemyPayload).have);
  if (stock === null) {
    return {
      ok: false, kind: 'INVALID',
      reason: '需要 have(背包明细:{ "物品id": 数量 })—— 服务端没有按物品明细的读口,见本文件头',
    };
  }

  /* 5' 产物必须在冻结内容表里、且有配方 —— 「编号空投」与「无配方产物」都拒。 */
  const def = ITEM_BY_ID.get(itemId);
  if (def === undefined) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }
  if (def.recipe === undefined && def.recipeAnyTag === undefined) {
    return { ok: false, kind: 'INVALID', reason: `#${itemId}(${def.name})没有配方,不是可炼制的产物` };
  }

  /* 6 配方匹配**只走内容层那一份**(`matchRecipeByTags`):先确定件、再逐个填留白槽。
     别在这里再写一遍配方表或留白语义 —— 那就是本仓反复点名的「两份实现」。 */
  const match = matchRecipeByTags(itemId, stock);
  if (!match.ok) {
    /* 材料不足是 **INVALID**(状态不对),**不是** PERMISSION。 */
    return { ok: false, kind: 'INVALID', reason: `材料不足:${match.reason ?? '配方不满足'}` };
  }

  /* 配方里写 0 的登记项(如 `523` 的 `163: 0`)不产生操作:delta 0 不是一次增减。 */
  const spendOps = Object.entries(match.consumed)
    .map(([k, n]) => ({ itemId: Number(k), delta: -n }))
    .filter((op) => op.delta !== 0);

  /* 7 **先扣材料**:整批 ops 一次提交 ⇒ 反作弊要么全过要么全拒,
     不存在「扣了一半」。消耗是负 delta,不需要 source(凭证链只约束产出侧)。 */
  const spend = ctx.applyInventory(ctx.actorId, { ops: spendOps });
  if (!spend.allowed) {
    return {
      ok: false, kind: 'INVALID',
      reason: `材料扣减被拒(${spend.rejectCode ?? '被拒'})⇒ 未消耗任何材料`,
    };
  }

  /* 8 **再给产物**:先 `grantItemSource` 再 `applyInventory(+n, source)`,顺序反过来
     会被反作弊按「凭空产出」拒。产出件数取内容表的 `output`(`165` 是 1 → 3 件)。 */
  const made = Math.max(1, Math.trunc(def.output ?? 1));
  const src = `alchemy:${itemId}`;
  ctx.grantItemSource(ctx.actorId, src);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: made, source: src }] });
  if (!gain.allowed) {
    /* 9 事务性:产物收不下(容量 ⇒ `ITEM_OVERFLOW`)⇒ **退回材料**,不吞材料。
       退回是正 delta ⇒ 同样必须先给凭证。 */
    const refundSrc = `alchemy-refund:${itemId}`;
    ctx.grantItemSource(ctx.actorId, refundSrc);
    const refund = ctx.applyInventory(ctx.actorId, {
      ops: spendOps.map((op) => ({ itemId: op.itemId, delta: -op.delta, source: refundSrc })),
    });
    return {
      ok: false, kind: 'INVALID',
      reason: `产物收不下(${gain.rejectCode ?? '被拒'})⇒ 材料已退回`
        + (refund.allowed ? '' : `(退回也被拒:${refund.rejectCode ?? '被拒'})`),
    };
  }

  /* 回执:`consumed` 是**真的被扣掉的那几件**(含留白槽选中的那件),不是配方需求表。
     该字段是嵌套对象,`ActionOutcome['effect']` 的值类型装不下 ⇒ 显式窄化(见文件头)。
     `freeForge: false` 如实标明这一版不是 LLM 自由炼金。 */
  return {
    ok: true, kind: 'OK',
    effect: {
      itemId,
      produced: made,
      consumed: match.consumed,
      roomKey: ALCHEMY_LAB_ROOM_KEY,
      freeForge: false,
    } as unknown as EffectRecord,
  };
};