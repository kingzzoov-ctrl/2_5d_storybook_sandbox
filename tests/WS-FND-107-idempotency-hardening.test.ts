/**
 * WS-FND-107 —— 幂等边界的**第三轮硬化**(审计实测 6 条)。
 *
 * 这一轮的 6 条都长在「第一轮/第二轮修过的幂等层」上,形态是「修法只对了一半」:
 *
 * | # | 判据 | 修的是什么 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | `@DAY` 键:负小数(-0.5)一律 `null`,不再与**合法第 0 天**撞键 | `Math.trunc(-0.5) === -0` 而 `-0 < 0` 为 false | `settleKeyOf` 改回「先 trunc 再判 `<0`」 |
 * | 2 | 结算台账**有界**:`claims` 恒 ≤ `SETTLEMENT_LEDGER_CAPACITY`,FIFO 淘汰最老 | `claims` 只增不删(键的一维客户端可控) | 删掉 `claimSettlement` 里的淘汰循环 |
 * | 3 | 牧场**零产出:出账但不占键**(空账不占该日,补齐后同一天仍能真结算) | 只看 `result.days > 0`(请求天数)就 `claimSettlement` | `settleRanchDayOnce` 改回「`days > 0` 就占键」 |
 * | 4 | 炼金两套键**不同命名空间 + 转义**:自造 `orderId` 造不出别人的派生键 | 显式订单号与派生键共用 `ALCHEMY_LAB@ORDER:<串>` | `furnaceOrderIdOf` 去掉前缀 / 不转义 |
 * | 5 | 世界侧**重放**拒绝 ⇒ **整笔失败 + 回滚**(撤凭证 / 收产物 / 释放预占 / 退材料);非重放拒绝 ⇒ 产物照发 | 世界侧拒仍回 `ok:true`(静默出货 + 预占滞留) | 去掉 `if (worldRejectionLooksLikeReplay(...))`(改回无条件回滚) |
 * | 6 | 跨玩家顶键:动作面 A 自造 `= B` 的派生串 ⇒ **两人各成交一次** | 两套键撞同一把(第 4 条的运行时面) | `furnaceClaimKeyOf` 去掉命名空间 |
 * | 7 | 炼金**预占索引**也有界(FIFO):填满后最老的一条重新可占 | `FURNACE_CLAIMS` 同样只增不删 | 删掉 `claimFurnaceOrder` 里的淘汰循环 |
 * | 8 | `buyOnce` 台账 `at` 槽 = **成交成本**(钉住注释口径,不是时刻) | 注释把「存 cost」念成「已结算过 cost」 | (注释口径,由 `settlementSeenAt === cost` 钉) |
 * | 9 | 世界侧封装 `settleRanchOnce`:零产出**出账但不占该日**(第 3 条的运行时面) | 同上 | 同第 3 条 |
 *
 * ## 断言右侧一律是**字面量**
 *
 * `'ECO_RANCH@DAY:0'` / `4096` / `20` 等手写;只有「契约本身」(两个命名空间前缀)
 * 才引用被测模块的导出口,因为它们**就是**规格。
 *
 * ## 夹具的诚实边界
 *
 * 判据 5/6 用**手搓 `ctx`**(动作层的单元面):`applyInventory` 的闸按
 * `anticheat.checkInventory` 的同一条规则实现 —— 正 delta 必须带一张**已登记的
 * 来源串**(无凭证 ⇒ `ITEM_FROM_NOTHING`),负 delta 必须够件。它不是那份实现的
 * 复制品;真闸的验签/一次性/tick 绑定在 `WS-FND-87` / `WS-FND-105` 里钉。
 *
 * 运行:`node tests/WS-FND-107-idempotency-hardening.test.ts`
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  SETTLEMENT_LEDGER_CAPACITY,
  claimSettlement,
  createSettlementLedger,
  settleKeyOf,
  settlementKeyCount,
  settlementSeenAt,
  type SettlementLedger,
} from '../server/src/systems/idempotency.ts';
import {
  settleRanchDay,
  settleRanchDayOnce,
  type RanchAnimal,
} from '../server/src/systems/ranch.ts';
import { buyOnce } from '../server/src/systems/depot.ts';
import { createRoomSystemsState, settleRanchOnce } from '../server/src/systems/wiring.ts';
import {
  FURNACE_KEY_NS_DERIVED,
  FURNACE_KEY_NS_EXPLICIT,
  claimFurnaceOrder,
  furnaceClaimKeyOf,
  furnaceOrderIdOf,
  useAlchemyFurnace,
} from '../server/src/net/actions/use_alchemy_furnace.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import type { ActionOutcome } from '../server/src/net/room.ts';

/* ───────────────────────── 内容层锚点(字面量取自冻结表) ───────────────────────── */

const SAND = 108;     /* 琉璃石英砂:165 陶瓷空药水瓶的唯一材料 */
const BOTTLE = 165;   /* 产物,`output: 3` */
const CROWN = 704;    /* 内容表里真实存在的物品(百货买它) */

/** 牧场:一只养熟的绵羊(饲料 = 内容表 `tameItem` 123 黄金小麦)。 */
const SHEEP: readonly RanchAnimal[] = [{ speciesId: 'mob_sheep', affinity: 0.9 }];
const SHEEP_FEED: Readonly<Record<number, number>> = { 123: 4 };

/* ═════════════════ 1. @DAY 键:负小数不撞合法第 0 天 ═════════════════ */

/** **修前形态**的 `@DAY` 键(先 trunc 再判 `< 0`)—— 只用于证明撞键真的存在。 */
function buggyDayKeyOf(room: string, day: number): string | null {
  if (!Number.isFinite(day)) return null;
  const d = Math.trunc(day);
  if (d < 0) return null;
  return `${room}@DAY:${d}`;
}

test('FND107-1 @DAY 键:负小数一律 null(不再伪装成第 0 天);正小数口径不变', () => {
  /* 合法第 0 天:键就是它,反过来说明「撞上它」的后果。 */
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: 0 }), 'ECO_RANCH@DAY:0', '合法第 0 天必须给 @DAY:0');

  /* ★ 修复点:负小数(以及一切负数)一律 null。 */
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: -0.5 }), null, '★ -0.5 必须非法(修前给 @DAY:0)');
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: -1.5 }), null, '-1.5 必须非法');
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: -1 }), null, '负整数必须非法');
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: Number.NaN }), null, 'NaN 非法');
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: Number.NEGATIVE_INFINITY }), null, '-∞ 非法');

  /* 正小数仍是「向下取整」(既有契约,见 WS-FND-96:173)。 */
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: 3.9 }), 'ECO_RANCH@DAY:3', '正小数仍向下取整');

  /* ★ 注入验证:修前形态**真的**会造出与合法第 0 天相同的键。 */
  eq(buggyDayKeyOf('ECO_RANCH', -0.5), 'ECO_RANCH@DAY:0', '注入:修前 -0.5 造出 @DAY:0');
  eq(buggyDayKeyOf('ECO_RANCH', -0.5), buggyDayKeyOf('ECO_RANCH', 0),
    '★ 注入:修前 -0.5 与合法第 0 天是**同一把键**(这就是要修的撞键)');
  ok(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: -0.5 }) !== settleKeyOf('ECO_RANCH', { kind: 'DAY', day: 0 }),
    '★ 修后 -0.5 不再是第 0 天那一把');
});

/* ═════════════════ 2. 结算台账有界(FIFO) ═════════════════ */

test('FND107-2 结算台账有界:claims 恒 ≤ 上限,FIFO 淘汰最老;重复不扩容', () => {
  eq(SETTLEMENT_LEDGER_CAPACITY, 4096, '上限必须是具名常量 4096(与击杀账本同口径)');

  const ledger = createSettlementLedger();
  const total = SETTLEMENT_LEDGER_CAPACITY + 8;
  for (let i = 0; i < total; i += 1) claimSettlement(ledger, `K:${i}`, i);

  eq(settlementKeyCount(ledger), 4096, '★ 灌入 4104 条 ⇒ 台账仍是 4096(有界)');
  eq(settlementSeenAt(ledger, 'K:0'), undefined, '★ 最老的一条被 FIFO 淘汰');
  eq(settlementSeenAt(ledger, 'K:7'), undefined, '前 8 条都被淘汰');
  eq(settlementSeenAt(ledger, 'K:8'), 8, '第 9 条(仍在窗口内)还在');
  eq(settlementSeenAt(ledger, `K:${total - 1}`), total - 1, '最新的一条仍在,且保留首次时刻');

  /* 重复占同一键:拒 + 不扩容(纪律 3 不被有界淘汰破坏)。 */
  eq(claimSettlement(ledger, `K:${total - 1}`, 99999).ok, false, '第二次同键仍拒');
  eq(settlementKeyCount(ledger), 4096, '重复不得扩容');

  /* 懒建:旧夹具只给 `claims`(不给 order)时也有界。 */
  const lazy: SettlementLedger = { claims: new Map<string, number>() };
  for (let i = 0; i < total; i += 1) claimSettlement(lazy, `L:${i}`, i);
  eq(lazy.claims.size, 4096, '★ 只给 claims 的旧夹具也走有界路径(懒建 order)');

  /* ★ 负对照:绕过 claimSettlement、直接 `set`(修前形态)⇒ 无界。 */
  const raw: SettlementLedger = { claims: new Map<string, number>() };
  for (let i = 0; i < total; i += 1) raw.claims.set(`R:${i}`, i);
  ok(raw.claims.size > 4096, `负对照:只 set 不淘汰 ⇒ 无界(实测 ${raw.claims.size})`);
});

/* ═════════════════ 3. 牧场:零产出不占键 ═════════════════ */

test('FND107-3 牧场:零产出**出账但不占键**(补齐动物/饲料后同一天仍能真结算)', () => {
  const ledger = createSettlementLedger();

  /* 圈里没动物,duration > 0 ⇒ 出空账,但**不得**占该日。 */
  const empty = settleRanchDayOnce(ledger, { animals: [], feed: {}, days: 1, day: 5 });
  eq(empty.accepted, true, '零产出照常出账(世界侧慢帧报告按 accepted 计数)');
  if (!empty.accepted) return;
  eq(empty.key, 'ECO_RANCH@DAY:5', '键仍报得出来');
  eq(empty.result.produce, [], '空账:无产出');
  eq(empty.result.feedConsumed, [], '空账:无饲料消耗');
  eq(settlementKeyCount(ledger), 0, '★ 那一天**没被占死**(修前在这里 claimSettlement)');

  /* ★ 负对照:裸纯函数照样报 `days: 1`,但产出/消耗都是空 —— 修前的判据只看它。 */
  const bare = settleRanchDay({ animals: [], feed: {}, days: 1 });
  eq(bare.days, 1, '负对照:裸函数仍报 days=1(修前据此占键)');
  eq(bare.produce.length, 0, '负对照:却一件都没产出');
  eq(bare.feedConsumed.length, 0, '负对照:也没有饲料被吃');

  /* 有动物但槽里没饲料:同样空账 ⇒ 同样不占键。 */
  const noFeed = settleRanchDayOnce(ledger, { animals: SHEEP, feed: {}, days: 1, day: 6 });
  eq(noFeed.accepted, true, '有动物没饲料 ⇒ 照常出空账');
  eq(settlementKeyCount(ledger), 0, '同样不占键');

  /* ★ 注入:修前的口径(按 `days > 0` 占键)会把该日占死 ⇒ 后一次真结算被当重放。 */
  const injected: SettlementLedger = { claims: new Map<string, number>([['ECO_RANCH@DAY:5', 1]]) };
  const blocked = settleRanchDayOnce(injected, { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: 5 });
  eq(blocked.accepted, false, '注入:按 days>0 占键 ⇒ 补齐后同一天被当重放');
  if (!blocked.accepted) eq(blocked.replayed, true, '注入后它被归类为「重放」');

  /* 修后:同一天补齐动物 + 饲料 ⇒ 真的结得出来,产出到位。 */
  const later = settleRanchDayOnce(ledger, { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: 5 });
  ok(later.accepted, '★ 零产出没占键 ⇒ 同一天补齐饲料后真结算成功');
  if (later.accepted) {
    eq(later.result.produce.length, 1, '产出 1 行');
    eq(later.result.feedConsumed, [{ itemId: 123, count: 1 }], '吃了 1 份 123');
  }
  eq(settlementKeyCount(ledger), 1, '这一次才占键');
});

/* ═════════════════ 4. 炼金:两套键命名空间 + 转义 ═════════════════ */

test('FND107-4 炼金两套键不同命名空间:自造 orderId 造不出别人的派生键', () => {
  const ids = [SAND];
  /* A 自造 `orderId` = B 的**派生串**(修前两者同形 ⇒ 撞键)。 */
  const craftedForB = `p2#${SAND}#7`;
  const aExplicit = furnaceClaimKeyOf('p1', ids, 7, craftedForB);
  const bDerived = furnaceClaimKeyOf('p2', ids, 7, null);
  const aDerived = furnaceClaimKeyOf('p1', ids, 7, null);

  /* 命名空间前缀就是契约,直接引用导出的常量。 */
  eq(aExplicit, `ALCHEMY_LAB@ORDER:${FURNACE_KEY_NS_EXPLICIT}:p2%23108%237`, '显式键 = 房间@ORDER:req:<转义>');
  eq(bDerived, `ALCHEMY_LAB@ORDER:${FURNACE_KEY_NS_DERIVED}:p2%23108%237`, '派生键 = 房间@ORDER:der:<转义>');
  ok(aExplicit !== bDerived, '★ A 自造的 orderId **造不出** B 的派生键(修前撞同一把)');
  ok(aDerived !== bDerived, '两个玩家的派生键本就不同(actor 维)');

  /* 透传给世界侧的 orderId 与预占键同源(两侧逐字同形)。 */
  eq(furnaceOrderIdOf('p1', ids, 7, craftedForB), `req:p2%23108%237`, '动作侧一律显式喂世界侧命名空间串');
  eq(furnaceOrderIdOf('p2', ids, 7, null), `der:p2%23108%237`);

  /* ★ 注入验证:修前形态(无命名空间、无转义)**真的**会撞同一把。 */
  const oldExplicit = `ALCHEMY_LAB@ORDER:${craftedForB}`;
  const oldDerived = `ALCHEMY_LAB@ORDER:p2#${SAND}#7`;
  eq(oldExplicit, oldDerived, '★ 注入:修前 A 自造串 == B 派生串(永久把 B 判成重放)');
  ok(aExplicit !== oldExplicit, '修后的显式键已经带上命名空间 + 转义');
});

/* ═════════════════ 5/6. 动作面:世界侧拒绝 / 跨玩家顶键 ═════════════════ */

type Op = { itemId: number; delta: number; source?: string };
type Batch = { ops: Op[]; allowed: boolean; rejectCode?: string };

type Rig = {
  ctx: ActionContext;
  counts: Map<number, number>;
  sources: Set<string>;
  revoked: string[];
  batches: Batch[];
  furnaceCalls: string[];
};

/** 世界侧「**重放**」拒绝的理由(与 `systems/wiring.ts:brewInLabOnce` 的措辞同形)。 */
const REPLAY_REASON = '订单 req:x 已在 12 结算过(幂等键 ALCHEMY_LAB@ORDER:req:x)⇒ 拒绝,陈列不变';
/** 世界侧「**非重放**」拒绝的理由(与 `systems/alchemy_lab.ts:brewAndRecord` 同形:1 件材料)。 */
const MATERIAL_REASON = '材料件数 1 不在 [2, 4]';

type RigOptions = {
  actorId?: string;
  tick?: number;
  owns?: Record<number, number>;
  state?: object;
  /** 前 N 次 `brewAtFurnace` 一律拒绝(模拟世界侧判重 / 非重放拒绝)。 */
  rejectFirst?: number;
  /** 拒绝时给的理由(缺省 = 重放措辞);用来区分「重放」与「其它拒绝」。 */
  rejectReason?: string;
};

/**
 * 手搓一个 `ActionContext`(动作层单元面)。
 *
 * `applyInventory` 与 `anticheat.checkInventory` 的关键那条一致:正 delta 必须带一张
 * **已登记**的来源串,负 delta 必须够件,总量不得超容量。`state` 可注入 —— 跨玩家顶键
 * 的那条要让两个玩家**共用同一个 `ctx.state`**(预占台账按它的对象身份分桶)。
 */
function makeRig(o: RigOptions = {}): Rig {
  const actorId = o.actorId ?? 'p1';
  const tick = o.tick ?? 5;
  const counts = new Map<number, number>(Object.entries(o.owns ?? {}).map(([k, v]) => [Number(k), v]));
  const sources = new Set<string>();
  const revoked: string[] = [];
  const batches: Batch[] = [];
  const furnaceCalls: string[] = [];
  let rejectsLeft = o.rejectFirst ?? 0;

  const apply = (ops: readonly Op[]): { allowed: boolean; rejectCode?: string } => {
    const batch: Batch = { ops: ops.map((x) => ({ ...x })), allowed: false };
    batches.push(batch);
    let net = 0;
    for (const op of ops) {
      if (!Number.isInteger(op.delta)) {
        batch.rejectCode = 'MALFORMED';
        return { allowed: false, rejectCode: 'MALFORMED' };
      }
      if (op.delta > 0) {
        if (op.source === undefined || !sources.has(op.source)) {
          batch.rejectCode = 'ITEM_FROM_NOTHING';
          return { allowed: false, rejectCode: 'ITEM_FROM_NOTHING' };
        }
      } else if (op.delta < 0) {
        if ((counts.get(op.itemId) ?? 0) < -op.delta) {
          batch.rejectCode = 'NEGATIVE';
          return { allowed: false, rejectCode: 'NEGATIVE' };
        }
      }
      net += op.delta;
    }
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    if (total + net > 99) {
      batch.rejectCode = 'ITEM_OVERFLOW';
      return { allowed: false, rejectCode: 'ITEM_OVERFLOW' };
    }
    for (const op of ops) {
      if (op.delta === 0) continue;
      const next = (counts.get(op.itemId) ?? 0) + op.delta;
      if (next === 0) counts.delete(op.itemId);
      else counts.set(op.itemId, next);
    }
    batch.allowed = true;
    return { allowed: true };
  };

  const host = {
    lastRoomEffects: [{ playerId: actorId, roomKey: 'ALCHEMY_LAB' }],
    brewAtFurnace: (who: string, _ids: readonly number[], opts?: { orderId?: string }) => {
      furnaceCalls.push(opts?.orderId ?? '(none)');
      if (rejectsLeft > 0) {
        rejectsLeft -= 1;
        return { ok: false, reason: o.rejectReason ?? REPLAY_REASON, display: [] };
      }
      return {
        ok: true,
        first: true,
        entry: {
          recipeHash: 'h', discovererName: who, itemName: 'x', itemCategory: 'y',
          craftCount: 1, firstAt: 0, schemaJson: '{}',
        },
        display: [],
      };
    },
  };

  const state = o.state ?? { roomId: 'wsfnd107', meta: { tick } };
  const ctx = {
    actorId,
    action: RoomAction.USE_ALCHEMY_FURNACE,
    payload: {},
    state,
    host,
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (_u: string, input: { ops: readonly Op[] }) => apply(input.ops),
    grantItemSource: (_u: string, s: string) => { sources.add(s); },
    revokeItemSource: (_u: string, s: string) => { sources.delete(s); revoked.push(s); },
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
    itemCountOf: (_u: string, itemId: number) => counts.get(itemId) ?? 0,
    itemIdsOf: () => [...counts.keys()],
  } as unknown as ActionContext;

  return { ctx, counts, sources, revoked, batches, furnaceCalls };
}

const disp = (rig: Rig, payload: Record<string, unknown>): ActionOutcome =>
  useAlchemyFurnace({ ...rig.ctx, payload } as unknown as ActionContext);

test('FND107-5 世界侧**重放**拒绝 ⇒ 整笔失败 + 回滚(不发产物)+ 释放预占', () => {
  const rig = makeRig({ tick: 12, owns: { [SAND]: 4 }, rejectFirst: 1 });
  const payload = { itemId: BOTTLE, orderId: 'ORD-W' };

  const out = disp(rig, payload);
  eq(out.ok, false, '★ 世界侧判重那一拒不能报成功(修前回 ok:true,静默出货)');
  eq(out.kind, 'INVALID', '归为状态问题(INVALID)');
  ok((out.reason ?? '').includes('世界侧拒绝'), `理由要指到世界侧拒绝(实测:${out.reason ?? '-'})`);
  ok((out.reason ?? '').includes('回滚'), `理由要说明已回滚(实测:${out.reason ?? '-'})`);
  eq(rig.counts.get(SAND), 4, '★ 材料一件都没被吞(退回)');
  eq(rig.counts.get(BOTTLE), undefined, '★ 产物没有出货(收回)');
  eq(rig.revoked.length, 1, '★ 产物凭证被撤销(不许留到 tick 末)');
  eq(rig.furnaceCalls.length, 1, '世界侧被叫过一次');
  eq(rig.furnaceCalls[0], `req:ORD-W`, '★ 透传给世界侧的是命名空间串(与预占键同源)');

  /* 预占已释放 ⇒ 同一单号补齐条件后可重试(修前会被自己的预占永久锁死)。 */
  const retry = disp(rig, payload);
  ok(retry.ok, `★ 世界侧拒绝后预占必须释放(否则同单号锁死;实测 ${retry.kind} / ${retry.reason ?? '-'})`);
  eq(rig.counts.get(SAND), 3, '重试:这一次真的扣了 1 件');
  eq(rig.counts.get(BOTTLE), 3, '重试:产物进包');
  eq(rig.batches.length, 4 + 2, '第一次:扣/产/收/退 4 批;第二次:扣/产 2 批');

  /* ★ 负对照:世界侧拒因**不是**重放(如 1 件材料进不了 [2,4] 的陈列路径)⇒
     不是「重复出货」,产物照发、`galleryNote` 如实带因(WS-FND-31:1 的契约)。 */
  const rig2 = makeRig({ tick: 13, owns: { [SAND]: 4 }, rejectFirst: 1, rejectReason: MATERIAL_REASON });
  const ship = disp(rig2, { itemId: BOTTLE, orderId: 'ORD-M' });
  eq(ship.ok, true, '★ 非重放的世界侧拒绝不得吞掉产物(否则 1 件材料的确定性配方永远炼不出来)');
  eq(rig2.counts.get(SAND), 3, '材料照常扣掉');
  eq(rig2.counts.get(BOTTLE), 3, '产物照常进包');
  eq(rig2.revoked.length, 0, '没有回滚 ⇒ 没有撤销');
  eq((ship.effect as { galleryNote?: unknown } | undefined)?.galleryNote, MATERIAL_REASON,
    '★ 陈列记不上的原因如实进 `galleryNote`');
});

test('FND107-6 跨玩家顶键(动作面):A 自造 = B 的派生串 ⇒ 两人各成交一次', () => {
  /* 两个玩家共享同一个 `ctx.state`(生产里同房间的动作上下文就是共享的)。 */
  const shared = { roomId: 'wsfnd107_shared', meta: { tick: 7 } };
  const rigA = makeRig({ actorId: 'p1', state: shared, owns: { [SAND]: 4 } });
  const rigB = makeRig({ actorId: 'p2', state: shared, owns: { [SAND]: 4 } });

  /* A 自造 B 的派生串(修前会与 B 的真派生键撞同一把)。 */
  const a = disp(rigA, { itemId: BOTTLE, orderId: `p2#${SAND}#7` });
  const b = disp(rigB, { itemId: BOTTLE });
  eq(a.ok, true, `★ A 自造订单号也应成交(实测 ${a.kind} / ${a.reason ?? '-'})`);
  eq(b.ok, true, `★ B 不含订单号的合法炼金**不得**被当重放(实测 ${b.kind} / ${b.reason ?? '-'})`);
  eq(rigA.counts.get(BOTTLE), 3, 'A 拿到产物');
  eq(rigB.counts.get(BOTTLE), 3, 'B 也拿到产物');
  eq([rigA.furnaceCalls[0], rigB.furnaceCalls[0]],
    [`req:p2%23108%237`, `der:p2%23108%237`],
    '★ 两次世界侧调用的键不同(命名空间把它们分开)');
});

/* ═════════════════ 7. 炼金预占索引有界 ═════════════════ */

test('FND107-7 炼金预占索引有界:FIFO 淘汰最老,最近窗口内仍判重放', () => {
  const state = {}; /* 一个稳定的对象身份 = 一个房间实例 */
  const total = SETTLEMENT_LEDGER_CAPACITY + 8;
  ok(claimFurnaceOrder(state, 'F:0', 0).ok, '第一条能占');
  for (let i = 1; i < total; i += 1) claimFurnaceOrder(state, `F:${i}`, i);

  /* 最近的键仍然判重放。 */
  eq(claimFurnaceOrder(state, `F:${total - 1}`, 1).ok, false, '最近的一条仍是「已结算过」');
  /* 最老的一条已被淘汰 ⇒ 重新可占。 */
  ok(claimFurnaceOrder(state, 'F:0', 1).ok, '★ 最老的一条被 FIFO 淘汰 ⇒ 重新可占(有界)');

  /* ★ 负对照:裸 Map(修前形态,无淘汰)⇒ 最老的一条永远在,索引无界。 */
  const raw = new Map<string, number>();
  for (let i = 0; i < total; i += 1) raw.set(`G:${i}`, i);
  ok(raw.size > 4096, `负对照:裸 Map 只 set 不淘汰 ⇒ 无界(实测 ${raw.size})`);
  eq(raw.has('G:0'), true, '负对照:最老的一条永远在(所以才有内存增长)');
});

/* ═════════════════ 8. buyOnce 台账口径:at 槽 = 成交成本 ═════════════════ */

test('FND107-8 buyOnce 台账 at 槽 = **成交成本**(钉住注释口径,不是时刻)', () => {
  const ledger = createSettlementLedger();
  const out = buyOnce(ledger, {
    itemId: CROWN, qty: 2, stock: { [CROWN]: 5 }, table: { [CROWN]: 10 }, orderId: 'O-1',
  });
  ok(out.accepted, '前置:应成交');
  eq(settlementSeenAt(ledger, 'CLOUD_DEPOT@ORDER:O-1'), 20, '★ 台账里存的是成本 10×2 = 20(不是 tick / 时刻)');
  const replay = buyOnce(ledger, {
    itemId: CROWN, qty: 2, stock: { [CROWN]: 5 }, table: { [CROWN]: 10 }, orderId: 'O-1',
  });
  eq(replay.accepted, false, '同单号第二次仍拒');
  if (replay.accepted) return;
  ok(replay.reason.includes('20'), `拒绝理由带上那个「成本」值(实测:${replay.reason})`);
});

/* ═════════════════ 9. 世界侧封装:零产出**出账但不占该日** ═════════════════ */

test('FND107-9 settleRanchOnce:零产出**出账但不占该日**;补齐后同一天仍能真结算', () => {
  const st = createRoomSystemsState();
  const zero = settleRanchOnce(st, 2, [], {}, 1);
  eq(zero.accepted, true, '零产出照常出账(世界侧慢帧报告按 accepted 计数)');
  if (zero.accepted) eq(zero.result.produce, [], '回执是空账');
  eq(settlementKeyCount(st.settled), 0, '★ 但该日**没被占**(修前在这里占死)');
  ok(st.lastRanch !== null, '零产出也写回执(WS-FND-77 的空槽负对照要它)');

  const later = settleRanchOnce(st, 2, SHEEP, SHEEP_FEED, 1);
  ok(later.accepted, '★ 同一天补齐动物 + 饲料 ⇒ 真结算成功');
  eq(settlementKeyCount(st.settled), 1, '这一次才占键');
  if (later.accepted) eq(later.result.produce.length, 1, '产出到位');
});

report('WS-FND-107');
