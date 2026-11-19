/**
 * WS-FND-142 —— **导出覆盖回填**(第十轮导出覆盖矩阵的三条优先级)。
 *
 * ## 为什么有这套件
 *
 * 第十轮矩阵把 2290 个导出分成三档:**真行为 1222 / 只有符号判据 10 / 完全没有 979**
 * (其中 260 个仍挂在生产路径上)。本套件只做矩阵点名的三条**优先级**,不铺开:
 *
 * ```
 * 1 net/actions/item_source.ts   missingItemReadPort(6 处生产调用)
 *                                ownedItemCount(5)   authoritativeStock(2)
 *                                —— 6 个 action 模块依赖它们,却**零直调判据**
 * 2 party/modes.ts 的 contest*(12 个:竞赛结算)
 *   combat/vitals.ts:1197 resolveStrikes(权威状态推进)
 * 3 tests/WS-07.test.ts H11/H12 由「抽源码体 + includes」改为**真 import + 注入**
 *   (改动在 WS-07 里,本文件第 4 节只登记清单)
 * ```
 *
 * ## 判据形态纪律(与本仓既有约定一致)
 *
 * 每条都**调真函数 + 断后果**,并配**负对照**(该拒的必须拒)与**注入验证**
 * (把判据的输入改坏,断言它真的变)。特别地:
 * ```
 * · 无凭证 / 过期 / 不匹配 —— 三个**不同的拒因码**,不是一句 allowed:false
 *   (归因失真会让「宿主没接线」与「玩家作弊」在计数器上无法区分)
 * · 缺读口 ⇒ null,**不是 0** —— 「没有权威账」与「权威账说 0 件」是两件事
 * · 按件账(byItem)与总量账是两个维度 ⇒ 各给一条负对照
 * ```
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 附:第十轮「只有符号判据」10 项 · **具名登记清单**
 *
 * 来源 = 第十轮导出覆盖矩阵(2290 导出 = 真行为 1222 / 只有符号判据 **10** / 完全没有 979)。
 *
 * ⚠️ **该矩阵本身不在本仓**:已扫 `docs/`、`scripts/`、`tests/`(全文搜 `2290` /
 *   `覆盖矩阵` / `符号判据` / `1222`)只有无关命中。⇒ 本清单**只登记能在仓内逐条复核的名字**
 *   (本任务点名的两项),其余 8 个**不编造名字**,留编号待回填矩阵原文。
 *
 * | #  | 导出                          | 出处(生产)                                 | 台账(本轮) |
 * | -- | ----------------------------- | ------------------------------------------ | ---------- |
 * | 1  | `assertFieldTableParity`      | `server/src/net/schema.colyseus.ts:352`    | ✅ **已转真判据** —— `tests/WS-07.test.ts` H12:`from import` 真跑 + **逐类注入**(拿掉该类一条 ⇒ 必须在**那个 label** 上报「多出字段 …」,且只报一条) |
 * | 2  | `assertSchemaReady`           | `server/src/net/schema.colyseus.ts:372`    | ✅ **已转真判据** —— `tests/WS-07.test.ts` H11:注入坏字段表 ⇒ 断言它**真的抛**,且错误正文含问题字段名 |
 * | 3  | (编号待回填矩阵原文)          | —                                          | ⏳ 仍待转(仓内无法复核是哪一项) |
 * | 4  | (同上)                        | —                                          | ⏳ 待转 |
 * | 5  | (同上)                        | —                                          | ⏳ 待转 |
 * | 6  | (同上)                        | —                                          | ⏳ 待转 |
 * | 7  | (同上)                        | —                                          | ⏳ 待转 |
 * | 8  | (同上)                        | —                                          | ⏳ 待转 |
 * | 9  | (同上)                        | —                                          | ⏳ 待转 |
 * | 10 | (同上)                        | —                                          | ⏳ 待转 |
 *
 * 本轮**另外**把下列导出从「完全没有判据」提到「真行为判据」(**不属于**上面 10 项,
 * 它们原本在 979 那一档;列在这里是为了让下一轮矩阵可以勾掉):
 * ```
 * item_source.ts   ownedItemCount / authoritativeStock / missingItemReadPort / bindItemSource(经 checkInventory 端到端)
 * party/modes.ts   contestMode / contestBroadcaster / contestPlaceBoard / contestCapture /
 *                  contestBuiltOf / contestAssignTeam / contestCrownPickup / contestCrownDrop /
 *                  contestCrownHolder / contestBridgeFlagged / contestCrownCooldown /
 *                  contestCrownWinner / contestCrownSecOf / contestSettlement
 * combat/vitals.ts resolveStrikes
 * ```
 * ⚠️ 复核口径(可重跑,不需要那台机器):
 * `ownedItemCount`/`authoritativeStock`/`missingItemReadPort` 在 `tests/` 里的**直调**从 0 → 本文件;
 * `contest*` 在 `tests/` 里的直调同样从 0 → 本文件(此前只有 `tickPartyContest`/容器工厂的间接路径)。
 */
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import {
  authoritativeStock,
  bindItemSource,
  missingItemReadPort,
  ownedItemCount,
} from '../server/src/net/actions/item_source.ts';
import {
  InventoryReject,
  ItemSourcePurpose,
  checkInventory,
  createAcState,
} from '../server/src/net/anticheat.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import {
  BRIDGE_TILES_TO_WIN,
  CROWN_PICKUP_COOLDOWN_SEC,
  PARTY_MODE_KEY,
  PARTY_PHASE,
  contestAssignTeam,
  contestBridgeFlagged,
  contestBroadcaster,
  contestBuiltOf,
  contestCapture,
  contestCrownCooldown,
  contestCrownDrop,
  contestCrownHolder,
  contestCrownPickup,
  contestCrownSecOf,
  contestCrownWinner,
  contestMode,
  contestPlaceBoard,
  contestSettlement,
  createPartyContest,
  startPartyMode,
  tickPartyContest,
} from '../server/src/party/modes.ts';
import { createManualClock } from '../server/src/coop/rush_order.ts';
import { resolveStrikes } from '../server/src/combat/vitals.ts';
import { circleWarn } from '../server/src/mobs/geometry.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 手搓 `ActionContext`:只填动作层真会用到的那几口(与 WS-FND-87 同一手法)。 */
function makeCtx(opts: {
  tick?: number;
  action?: RoomAction;
  grants?: string[];
  port?: {
    itemCountOf?: (userId: string, itemId: number) => number;
    itemIdsOf?: (userId: string) => number[];
  };
} = {}): ActionContext {
  const { tick = 7, action = RoomAction.DROP_ITEM, grants = [], port = {} } = opts;
  const ctx: Record<string, unknown> = {
    actorId: 'p1',
    action,
    payload: {},
    state: { meta: { tick }, roomId: 'r_fnd142' },
    host: null,
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID', reason: 'x' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: () => ({ allowed: true, afterTotal: 0 }),
    grantItemSource: (_userId: string, source: string): void => { grants.push(source); },
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
    ...port,
  };
  return ctx as unknown as ActionContext;
}

/* ═══════════════════════ 1. item_source:三个口 ═══════════════════════ */

test('FND142-1 ownedItemCount:真读口 ⇒ 权威件数;缺读口 ⇒ null(**不是 0**)', () => {
  const ctx = makeCtx({ port: { itemCountOf: (u, i) => (u === 'p1' && i === 733 ? 3 : 0) } });
  eq(ownedItemCount(ctx, 733), 3, '真读口 ⇒ 权威件数');
  eq(ownedItemCount(ctx, 999), 0, '权威账说 0 就是 0(≠「没有读口」)');

  /* 负对照 1:宿主没接读口 ⇒ `null`,调用方据此走「没有权威」分支,而不是把 0 当真值。 */
  eq(ownedItemCount(makeCtx(), 733), null, '★ 缺读口必须回 null(回 0 = 把「不知道」说成「没有」)');

  /* 负对照 2:读口给回非有限值 ⇒ 收成 0,不让 NaN 流进背包账。 */
  eq(ownedItemCount(makeCtx({ port: { itemCountOf: () => Number.NaN } }), 733), 0,
    '非有限件数 ⇒ 0(fail-closed,不把 NaN 当件数)');

  /* 负对照 3:以别人身份读不到 —— 读口的 userId 是**真参数**,不是闭包里写死的。 */
  eq(ownedItemCount(makeCtx({ port: { itemCountOf: (u, i) => (u === 'p2' && i === 733 ? 5 : 0) } }), 733), 0,
    '别的玩家的件数不能被算成本人的');
});

test('FND142-2 authoritativeStock:逐件明细只含 > 0;半截读口 ⇒ null', () => {
  const ctx = makeCtx({
    port: {
      itemCountOf: (_u, i) => ({ 733: 3, 101: 0, 5: 2 } as Record<number, number>)[i] ?? 0,
      itemIdsOf: () => [733, 101, 5],
    },
  });
  eq(authoritativeStock(ctx), { 733: 3, 5: 2 }, '★ 明细只含 > 0 的条目(0 件的 id 不占位)');

  /* 负对照:两个方法缺一个 ⇒ null(半截读口不装作「有权威」)。 */
  eq(authoritativeStock(makeCtx()), null, '缺读口 ⇒ null');
  eq(authoritativeStock(makeCtx({ port: { itemCountOf: () => 1 } })), null,
    '只有 itemCountOf、没有 itemIdsOf ⇒ 同样 null');
  eq(authoritativeStock(makeCtx({ port: { itemIdsOf: () => [733] } })), null,
    '只有 itemIdsOf、没有 itemCountOf ⇒ 同样 null');

  /* 负对照:清单里出现 0 件 ⇒ 不进明细(否则「有 0 件」会被写进权威账)。 */
  eq(authoritativeStock(makeCtx({
    port: { itemCountOf: () => 0, itemIdsOf: () => [733] },
  })), {}, '全部 0 件 ⇒ 空明细,而不是 {733: 0}');
});

test('FND142-3 missingItemReadPort:NOT_IMPLEMENTED(**不是** INVALID),理由带动作名', () => {
  const out = missingItemReadPort(makeCtx({ action: RoomAction.DROP_ITEM }));
  eq(out.ok, false, '回执必须是失败');
  eq(out.kind, 'NOT_IMPLEMENTED', '★ 链路没接好 ⇒ NOT_IMPLEMENTED');
  ok(out.kind !== 'INVALID', '★ 负对照:不能写成 INVALID(那会把「宿主忘接线」记成「玩家作弊」)');
  ok((out.reason ?? '').includes(String(RoomAction.DROP_ITEM)),
    `理由要带动作名(便于定位是哪条链没接),实际 ${JSON.stringify(out.reason)}`);

  /* 负对照:同一个回执**不**伪造成功语义 —— 没有 effect。 */
  eq(out.effect, undefined, '失败回执不带 effect(否则调用方会以为有副作用)');
});

test('FND142-4 ★ 无凭证:bindItemSource 登记后放行;不登记 / 压根没凭证 ⇒ 两份不同的拒因', () => {
  const grants: string[] = [];
  const ctx = makeCtx({ tick: 7, grants });
  const token = bindItemSource(ctx, 733, ItemSourcePurpose.GATHER);
  eq(grants.length, 1, 'bindItemSource 是**登记**入口(铸出来的令牌必须登记)');
  eq(grants[0], token, '登记的就是它返回的那一张(不能是另一张)');

  /* 负对照 1:op 里没有 source ⇒ 凭空产出。 */
  const noCred = checkInventory(createAcState('p1', 7), {
    tick: 7,
    ops: [{ itemId: 733, delta: 1 }],
    allowedSources: new Set([token]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(noCred.allowed, false, '没凭证的产出必须拒');
  eq(noCred.rejectCode, InventoryReject.FROM_NOTHING, `拒因应为 FROM_NOTHING(实测 ${String(noCred.rejectCode)})`);

  /* 负对照 2:有令牌串但服务端**没登记**过 ⇒ 同样凭空产出(集合是权威)。 */
  const unregistered = checkInventory(createAcState('p1', 7), {
    tick: 7,
    ops: [{ itemId: 733, delta: 1, source: token }],
    allowedSources: new Set<string>(),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(unregistered.rejectCode, InventoryReject.FROM_NOTHING,
    '★ 凭证集合是**权威**:自己拼一个「看起来对」的串不算登记过');

  /* 对照:登记过的凭证 ⇒ 放行(否则本套件的负对照没有意义)。 */
  const passed = checkInventory(createAcState('p1', 7), {
    tick: 7,
    ops: [{ itemId: 733, delta: 1, source: token }],
    allowedSources: new Set([token]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(passed.allowed, true, `登记过的令牌应放行(实测 ${String(passed.rejectCode ?? '-')})`);
  eq(passed.afterTotal, 1, '放行后总量 +1');
});

test('FND142-5 ★ 过期:令牌绑的 tick ≠ 本次 tick ⇒ SOURCE_EXPIRED(凭证不跨 tick)', () => {
  const grants: string[] = [];
  const token = bindItemSource(makeCtx({ tick: 7, grants }), 101, ItemSourcePurpose.PICKUP);

  const expired = checkInventory(createAcState('p1', 8), {
    tick: 8,
    ops: [{ itemId: 101, delta: 1, source: token }],
    allowedSources: new Set([token]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(expired.allowed, false, '下一 tick 用上一 tick 的凭证必须拒');
  eq(expired.rejectCode, InventoryReject.SOURCE_EXPIRED,
    `拒因应为 SOURCE_EXPIRED(实测 ${String(expired.rejectCode)})`);

  /* 负对照:同一张令牌在**它自己的 tick** 里仍然合法(否则「过期」就退化成「全拒」)。 */
  const sameTick = checkInventory(createAcState('p1', 7), {
    tick: 7,
    ops: [{ itemId: 101, delta: 1, source: token }],
    allowedSources: new Set([token]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(sameTick.allowed, true, '同 tick 应放行 ⇒ 上一条拒的是「过期」,不是「这张令牌坏了」');
});

test('FND142-6 ★ 不匹配 / 伪造:itemId、actorId、验签三条各自回不同的拒因码', () => {
  const token = bindItemSource(makeCtx({ tick: 5 }), 101, ItemSourcePurpose.CRAFT);

  /* 负对照 1:一张凭证铸**任意物品** —— 审计 P0-2 的原形态。 */
  const wrongItem = checkInventory(createAcState('p1', 5), {
    tick: 5,
    ops: [{ itemId: 733, delta: 1, source: token }],
    allowedSources: new Set([token]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(wrongItem.rejectCode, InventoryReject.SOURCE_BINDING,
    `凭证绑 101、申报 733 ⇒ SOURCE_BINDING(实测 ${String(wrongItem.rejectCode)})`);

  /* 负对照 2:别人的凭证。 */
  const wrongActor = checkInventory(createAcState('p2', 5), {
    tick: 5,
    ops: [{ itemId: 101, delta: 1, source: token }],
    allowedSources: new Set([token]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(wrongActor.rejectCode, InventoryReject.SOURCE_BINDING, 'p1 的凭证不能被 p2 用');

  /* 负对照 3:改一个字符 ⇒ 验签失败(**伪造**,与「没凭证」分开归因)。 */
  const forged = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  const forgedRes = checkInventory(createAcState('p1', 5), {
    tick: 5,
    ops: [{ itemId: 101, delta: 1, source: forged }],
    allowedSources: new Set([forged]),
    beforeTotal: 0,
    capacity: 99,
  });
  eq(forgedRes.rejectCode, InventoryReject.SOURCE_FORGED,
    '★ 令牌形态但验签失败 ⇒ SOURCE_FORGED(不是 FROM_NOTHING —— 归因必须可分辨)');
});

test('FND142-7 把权威明细接进按件判据:扣超持有量 ⇒ NEGATIVE;恰好扣完 ⇒ 放行', () => {
  const ctx = makeCtx({
    tick: 3,
    port: { itemCountOf: (_u, i) => (i === 733 ? 2 : 0), itemIdsOf: () => [733] },
  });
  const stock = authoritativeStock(ctx);
  eq(stock, { 733: 2 }, '前置:权威明细是 2 件');
  const beforeByItem = new Map<number, number>(
    Object.entries(stock ?? {}).map(([k, v]) => [Number(k), v]),
  );

  /* 负对照 1(核心形态):总量够、这一件不够 ⇒ 必须拒,且**不夹零**。 */
  const over = checkInventory(createAcState('p1', 3), {
    tick: 3,
    ops: [{ itemId: 733, delta: -3 }],
    allowedSources: new Set<string>(),
    beforeTotal: 10,
    beforeByItem,
    capacity: 99,
  });
  eq(over.allowed, false, '★ 只有 2 件却要扣 3 件 ⇒ 拒');
  eq(over.rejectCode, InventoryReject.NEGATIVE, `拒因应为 NEGATIVE(实测 ${String(over.rejectCode)})`);
  eq(beforeByItem.get(733), 2, '判据不修改调用方的明细视图(它建内部副本)');

  /* 对照:恰好扣完 ⇒ 放行。 */
  const exact = checkInventory(createAcState('p1', 3), {
    tick: 3,
    ops: [{ itemId: 733, delta: -2 }],
    allowedSources: new Set<string>(),
    beforeTotal: 10,
    beforeByItem,
    capacity: 99,
  });
  eq(exact.allowed, true, '恰好扣完应放行');
  eq(exact.afterTotal, 8, '总量随之 -2');

  /* 负对照 2:不给按件账(旧口径)时同一条会放行 —— 这正是「总量守恒」判不住的形态。 */
  const legacy = checkInventory(createAcState('p1', 3), {
    tick: 3,
    ops: [{ itemId: 733, delta: -3 }],
    allowedSources: new Set<string>(),
    beforeTotal: 10,
    capacity: 99,
  });
  eq(legacy.allowed, true,
    '★ 旧口径(只判总量)确实放行 ⇒ 按件账是**必需的那一半**,不是锦上添花');
});

/* ═══════════════════════ 2. party/modes 的 contest*(12)═══════════════════════ */

test('FND142-8 contestMode / contestBroadcaster:四个容器各自解析到自己的子运行', () => {
  const clock = createManualClock(0);
  const bridge = createPartyContest(PARTY_MODE_KEY.BRIDGE_CTF, clock, 'ref');
  const jelly = createPartyContest(PARTY_MODE_KEY.JELLY_BALL, clock, 'ref');
  const crown = createPartyContest(PARTY_MODE_KEY.CROWN_BR, clock, 'ref');
  const paint = createPartyContest(PARTY_MODE_KEY.PAINT_WAR, clock, 'ref');

  /* 引用相等(不是「形状对」):四个分支各回**自己的** mode。
     ⚠️ 用 `subModeOf` 读子运行而不是 `bridge.bridge.mode`:联合类型不窄化到具体分支,
     直接取属性是 TS2339(实测;本条注释就是那次报错的记录)。 */
  const subModeOf = (c: unknown, k: string): unknown =>
    (c as Record<string, { mode?: unknown }>)[k]?.mode;
  ok(contestMode(bridge) === subModeOf(bridge, 'bridge'), 'BRIDGE_CTF ⇒ bridge.mode');
  ok(contestMode(jelly) === subModeOf(jelly, 'jelly'), 'JELLY_BALL ⇒ jelly.mode');
  ok(contestMode(crown) === subModeOf(crown, 'crown'), 'CROWN_BR ⇒ crown.mode');
  ok(contestMode(paint) === subModeOf(paint, 'paint'), 'PAINT_WAR ⇒ paint.mode');

  /* 四个容器的 key 与 mode.key 一致(否则上面四条可能「指到别人的 mode」也成立)。 */
  eq(bridge.key, contestMode(bridge).key, '容器 key 与子运行 key 一致');
  eq(crown.key, contestMode(crown).key, '容器 key 与子运行 key 一致');

  /* broadcaster 是 mode 的**同一个**对象(不是复制)。 */
  ok(contestBroadcaster(crown) === contestMode(crown).broadcaster, 'contestBroadcaster = mode.broadcaster');
  ok(contestBroadcaster(bridge) === contestMode(bridge).broadcaster, '同上(另一分支)');
});

test('FND142-9 造桥:摆板计数 / 相位门槛 / 12 块才能夺旗 / 夺旗一次性', () => {
  const clock = createManualClock(0);
  const c = createPartyContest(PARTY_MODE_KEY.BRIDGE_CTF, clock, 'ref');
  eq(contestMode(c).phase, PARTY_PHASE.IDLE, '前置:开局在 IDLE');
  startPartyMode(contestMode(c));
  eq(contestMode(c).phase, PARTY_PHASE.BUILD, '有 buildSec 的模式开局进 BUILD');

  /* 建造:RED 摆满 12,BLUE 只摆 11(负对照)。 */
  ok(contestPlaceBoard(c, 'RED'), '建造阶段可以摆板');
  for (let i = 1; i < BRIDGE_TILES_TO_WIN; i += 1) ok(contestPlaceBoard(c, 'RED'), `第 ${i + 1} 块`);
  /* ★ 双重锚定:期望值写**字面量**(与实现不同源),常量本身另用 actual 侧锚点钉住。 */
  eq(BRIDGE_TILES_TO_WIN, 12, '锚点:过河所需桥板数 = 12(手册 §6.3)');
  eq(contestBuiltOf(c, 'RED'), 12, '★ 摆板计数真的累加到 12');
  for (let i = 0; i < BRIDGE_TILES_TO_WIN - 1; i += 1) ok(contestPlaceBoard(c, 'BLUE'), 'BLUE 少摆一块');
  eq(contestBuiltOf(c, 'BLUE'), 11, 'BLUE 只差一块');
  /* ⚠️ `contestBuiltOf` 回 `number | null`(非造桥容器 ⇒ null)⇒ 相加前先落到数字,
     否则 TS2531「Object is possibly null」(实测)。 */
  const builtRed = contestBuiltOf(c, 'RED') ?? -1;
  const builtBlue = contestBuiltOf(c, 'BLUE') ?? -1;
  eq(builtRed + builtBlue, 23, '两队各自计数,合计 12+11 = 23(不共享一个累加器)');

  /* 相位门槛负对照:建造阶段不许夺旗。 */
  ok(!contestCapture(c, 'RED'), '★ 建造阶段夺旗必须被拒(相位门槛)');
  ok(!contestBridgeFlagged(c, 'RED'), '被拒的夺旗不能留下「已夺旗」痕迹');

  /* 推进到 RACE:桥板数**不**清零,但建造被拒。 */
  clock.advance(15);
  const ev = tickPartyContest(c, 0.05);
  eq(contestMode(c).phase, PARTY_PHASE.RACE, '★ BUILD → RACE 由 tickPartyContest 真的推进');
  ok(ev.includes('PHASE:RACE'), `推进事件应可观测,实际 ${JSON.stringify(ev)}`);
  ok(!contestPlaceBoard(c, 'RED'), '★ 冲刺阶段拒绝建造(负对照)');
  eq(contestBuiltOf(c, 'RED'), 12, '冲刺阶段板数不变(仍是 12)');

  /* 桥板不足者不能过河;够的可以夺旗,且只能夺一次。 */
  ok(!contestCapture(c, 'BLUE'), '★ 11 块 < 12 不能过河(负对照)');
  ok(contestCapture(c, 'RED'), '12 块 ⇒ 夺旗成功');
  ok(contestBridgeFlagged(c, 'RED'), '★ 夺旗结果真的落账');
  ok(!contestBridgeFlagged(c, 'BLUE'), '未夺旗队保持 false');
  ok(!contestCapture(c, 'RED'), '★ 同一队不能重复夺旗(负对照)');

  /* 非造桥容器:四个口都必须回「不适用」而不是静默成功。 */
  const other = createPartyContest(PARTY_MODE_KEY.PAINT_WAR, createManualClock(0), 'ref');
  eq(contestBuiltOf(other, 'RED'), null, '非造桥容器 ⇒ null');
  ok(!contestPlaceBoard(other, 'RED'), '非造桥容器 ⇒ 摆板 false');
  ok(!contestCapture(other, 'RED'), '非造桥容器 ⇒ 夺旗 false');
  ok(!contestBridgeFlagged(other, 'RED'), '非造桥容器 ⇒ 已夺旗 false');
});

test('FND142-10 抢皇冠:登记队伍 / 拾冠 / 掉冠 / 冷却 / 非该模式的 null 域', () => {
  const clock = createManualClock(0);
  const c = createPartyContest(PARTY_MODE_KEY.CROWN_BR, clock, 'ref');
  startPartyMode(contestMode(c));
  eq(contestCrownHolder(c), null, '开局皇冠落地');
  eq(contestCrownCooldown(c), 0, '开局无冷却');
  eq(contestCrownWinner(c), null, '开局无胜者');

  /* 负对照 1:没登记队伍的人不能拾冠(435 复活旗选色的前置)。 */
  ok(!contestCrownPickup(c, 'p1'), '★ 未登记队伍 ⇒ 拒绝拾冠');

  ok(contestAssignTeam(c, 'p1', 'RED'), '登记队伍成功(真皇冠容器)');
  ok(contestCrownPickup(c, 'p1'), '登记后可以拾冠');
  eq(contestCrownHolder(c), 'p1', '★ 持冠者真的写进运行时');

  /* 负对照 2:皇冠只有一顶 —— 第二个人拾不到(哪怕他也登记了)。 */
  contestAssignTeam(c, 'p2', 'BLUE');
  ok(!contestCrownPickup(c, 'p2'), '★ 已被持有 ⇒ 第二个人拾不到');

  /* 掉冠:落账 + 进 5 秒冷却。 */
  ok(contestCrownDrop(c), '掉冠成功');
  eq(contestCrownHolder(c), null, '掉冠后持冠者为 null');
  eq(CROWN_PICKUP_COOLDOWN_SEC, 5, '锚点:掉冠冷却 = 5 秒(手册 §6.3)');
  eq(contestCrownCooldown(c), 5, '★ 掉冠后真的进 5 秒冷却(期望值用字面量,与实现不同源)');
  ok(!contestCrownDrop(c), '★ 皇冠已落地 ⇒ 再掉冠为 false(负对照)');

  /* 负对照 3:冷却期内不许拾冠。 */
  ok(!contestCrownPickup(c, 'p1'), '★ 冷却期内拾冠必须被拒');

  /* 冷却由 tickCrown 推进(不是时钟自己走)—— 推进满 5 秒后恢复。 */
  tickPartyContest(c, CROWN_PICKUP_COOLDOWN_SEC);
  eq(contestCrownCooldown(c), 0, '推进满冷却秒数后归零');
  ok(contestCrownPickup(c, 'p1'), '冷却结束后可以再次拾冠');

  /* 非抢皇冠容器:null / false / 0 —— 三种「不适用」各自的形状。 */
  const other = createPartyContest(PARTY_MODE_KEY.JELLY_BALL, createManualClock(0), 'ref');
  ok(!contestAssignTeam(other, 'p1', 'RED'), '非抢皇冠容器 ⇒ 登记 false');
  ok(!contestCrownPickup(other, 'p1'), '非抢皇冠容器 ⇒ 拾冠 false');
  ok(!contestCrownDrop(other), '非抢皇冠容器 ⇒ 掉冠 false');
  eq(contestCrownHolder(other), null, '非抢皇冠容器 ⇒ null');
  eq(contestCrownWinner(other), null, '非抢皇冠容器 ⇒ null');
  eq(contestCrownSecOf(other, 'p1'), null, '★ 非抢皇冠容器 ⇒ secOf 为 **null**(不是 0)');
  eq(contestCrownCooldown(other), 0, '非抢皇冠容器 ⇒ 冷却 0');
});

test('FND142-11 抢皇冠结算:持冠计秒 / 60 秒宣胜 / settlement 真的落到容器上', () => {
  const clock = createManualClock(0);
  const c = createPartyContest(PARTY_MODE_KEY.CROWN_BR, clock, 'ref');

  /* 负对照 0:还没开局/没推进 ⇒ 没有结算。 */
  eq(contestSettlement(c), null, '★ 未结算 ⇒ null');

  startPartyMode(contestMode(c));
  contestAssignTeam(c, 'p1', 'RED');
  ok(contestCrownPickup(c, 'p1'), '前置:拾冠');
  eq(contestCrownSecOf(c, 'p1'), 0, '刚拾冠 0 秒');
  eq(contestCrownSecOf(c, 'nobody'), 0, '★ 已登记容器里的未登记玩家 ⇒ 0(与「非该容器」的 null 不同)');

  /* 30 秒:累计但不宣胜(负对照)。 */
  tickPartyContest(c, 30);
  near(contestCrownSecOf(c, 'p1') ?? -1, 30, 1e-9, '★ 持冠秒数真的累加');
  eq(contestCrownWinner(c), null, '★ 未满 60 秒不宣胜(负对照)');
  eq(contestSettlement(c), null, '未宣胜 ⇒ 仍未结算');

  /* 再 30 秒:宣胜 + 同帧结算(settleHook 那条唯一路径)。 */
  const ev = tickPartyContest(c, 30);
  eq(contestCrownWinner(c), 'RED', '★ 满 60 秒宣胜');
  eq(contestMode(c).phase, PARTY_PHASE.SETTLED, '宣胜即置 SETTLED');
  const s = contestSettlement(c);
  ok(s !== null, '★ `contestSettlement` 必须拿到真结算(修前 settle* 生产零调用 ⇒ 恒 null)');
  eq(s?.mode, PARTY_MODE_KEY.CROWN_BR, '结算带模式 key');
  eq(s?.standing[0].team, 'RED', '★ 排名第一是该队(按持冠秒数)');
  near(s?.standing[0].value ?? -1, 60, 1e-9, '冠军持冠 60 秒');
  ok((s?.personal ?? []).some((r) => r.playerId === 'p1' && r.elapsedMs === 60000),
    `个人榜应含 p1 的 60000ms,实际 ${JSON.stringify(s?.personal)}`);
  ok(ev.includes('CROWN_WIN') && ev.includes('PARTY_SETTLED'),
    `★ 宣胜帧必须同时报出「宣胜」与「已结算」两个事件,实际 ${JSON.stringify(ev)}`);
});

/* ═══════════════════════ 3. combat/vitals:resolveStrikes ═══════════════════════ */

test('FND142-12 resolveStrikes:命中/未命中/去重/无敌帧/倍率,且**不修改入参**', () => {
  const warn = circleWarn(0, 0, 1.0);
  const strike = { attackerId: 'm1', attackerLevel: 5, warn };
  const players = [
    { id: 'p1', x: 0, y: 0, z: 0 },
    { id: 'p2', x: 9, y: 0, z: 0 },
  ];

  /* 正对照:圆内命中、圆外不命中,但**两条都算检查过**。 */
  const base = resolveStrikes([strike], players);
  eq(base.warnsChecked, 1, '一次攻击 = 一次检查(与命中数无关)');
  eq(base.results.length, 1, '★ 只命中圆内的 p1(圆外 p2 负对照)');
  eq(base.results[0].playerId, 'p1', '命中对象正确');
  eq(base.results[0].attackerId, 'm1', '攻击者记在结果上');
  eq(base.results[0].element, 'NONE', '缺省元素 = NONE(抗性系数 1.0)');
  eq(base.results[0].rawBeforeResist, base.results[0].applied, '未折算抗性时两者相等(折算只在 applyHit)');
  eq(base.results[0].blockedByIframe, false, '未给无敌集 ⇒ 不挡');
  eq(base.results[0].downed, false, '★ 倒地判定属于 VitalsSystem(本函数不越权)');
  near(base.results[0].distance, 0, 1e-9, '距离可用于诊断');
  ok(base.results[0].rawDamage >= 1, '伤害恒 ≥ 1(mobHitDamage 的下界)');

  /* 负对照 1:z 超出容差 ⇒ 打不到(高空吐息 vs 地面玩家)。 */
  const high = resolveStrikes([strike], [{ id: 'p1', x: 0, y: 0, z: 5 }]);
  eq(high.results.length, 0, '★ z 超容差 ⇒ 不命中');
  eq(high.warnsChecked, 1, '仍然算检查过(否则「没检查」会被读成「没命中」)');

  /* 负对照 2:本帧已用掉的 attacker→player 键 ⇒ 跳过(防重复结算)。 */
  const dedup = resolveStrikes([strike, strike], players, new Set(['m1→p1']));
  eq(dedup.warnsChecked, 2, '两次攻击各算一次检查');
  eq(dedup.results.length, 0, '★ 已用掉的键 ⇒ 不再结算(去重)');

  /* 对照:两个不同攻击者打同一玩家 ⇒ 两条都成立(键是 attacker→player,不是 player)。 */
  const two = resolveStrikes([strike, { ...strike, attackerId: 'm2' }], players);
  eq(two.results.length, 2, '不同攻击者各自命中');
  eq(two.results.map((r) => r.attackerId).sort(), ['m1', 'm2'], '攻击者各记一条');

  /* 负对照 3:无敌帧 ⇒ applied 0,但**原始伤害仍可观测**(便于归因)。 */
  const iframe = resolveStrikes([strike], players, undefined, new Set(['p1']));
  eq(iframe.results.length, 1, '无敌帧不阻止「命中」判定');
  eq(iframe.results[0].applied, 0, '★ 无敌帧 ⇒ 实际扣除 0');
  eq(iframe.results[0].blockedByIframe, true, '并标记被无敌帧挡下');
  ok(iframe.results[0].rawBeforeResist > 0, '原始伤害仍保留(否则「挡了多少」不可观测)');

  /* 倍率(事件型攻击通道):raw 必须按 mul 折算,而不是忽略。 */
  const mul = resolveStrikes([{ ...strike, mul: 2 }], players);
  eq(mul.results[0].rawBeforeResist, resolveStrikes([strike], players).results[0].rawBeforeResist * 2,
    '★ mul=2 ⇒ 原始伤害翻倍(事件型 scorpion_ambush 的 1.5× 走同一条)');

  /* 注入验证:**纯函数** ⇒ 冻结入参不得抛,且结果与未冻结时一致。 */
  const frozenStrike = Object.freeze([Object.freeze({ attackerId: 'm1', attackerLevel: 5, warn: Object.freeze({ ...warn }) })]);
  const frozenPlayers = Object.freeze([Object.freeze({ id: 'p1', x: 0, y: 0, z: 0 })]);
  const frozen = resolveStrikes(frozenStrike, frozenPlayers);
  eq(frozen.results.length, 1, '★ 冻结入参不抛 ⇒ 证明它没写入参(纯函数)');
  eq(frozen.results[0].rawBeforeResist, base.results[0].rawBeforeResist, '冻结与否结果相同');
});

report('WS-FND-142');