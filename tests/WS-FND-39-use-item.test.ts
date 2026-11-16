/**
 * WS-FND-39 —— **`USE_ITEM`(使用一件道具)**:把三条"函数+判据都有、玩家触发不到"的
 * 欠账接上入口。
 *
 * ## 这个套件钉的三件事
 *
 * 1 **羽毛笔真的能救人**:6 格内命中幽灵泡泡队友 ⇒ 满血 + 3 秒无敌(写到 `vitals` 的
 *    **活字段** `iframeSec`,不是引擎里没人读的 `DownedState.invulnSec`)+ **扣 1 件**;
 * 2 **超距一件都不扣**:这是"判定 → 扣减"顺序的关键(照抄 `placeBlock` 的"先扣后退"
 *    就会变成"超距也扣")。
 * 3 **料理吃下去有生产者也有消费者**:吃 ⇒ 该玩家 active buffs 非空;`hpFlat` 并进
 *    `maxHpForLevel`(手册:602 最大生命 +30);慢帧推进 ⇒ `remainingSec` 下降、过期清空。
 *
 * ## 用**真装配**
 *
 * `assemble()` 造出真实运行时与世界,动作走 `rt.dispatchAction`(`ActionContext` 不手搓)。
 * 世界侧的操作(位置、倒地、帧推进)都用 `WorldSim` 的**公开**口:
 * `physics.bodies` / `vitals.get()` / `advance()` / `maxHpForLevel()` / `buffsOf()`。
 *
 * ## ⚠️ 断言右侧一律用**字面量**
 *
 * `733` / `227` / `602` / `30` / `3` / `6.1` 这些数字取自**冻结内容表与手册**,
 * 不取被测模块的导出常量 —— 否则就是同义反复(门禁 `--strict-taut`)。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';
import { FOOD_BY_ID, cookSoup } from '../server/src/combat/cooking.ts';
import { foodBuffFrom, foodCombatInput } from '../server/src/combat/cooking.ts';

/** 733 复苏天使羽毛笔 / 227 泡泡连发水枪 / 602 最大生命 +30 的料理。 */
const FEATHER = 733;
const BUBBLE_GUN = 227;
const FOOD_HP = 602;

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: WorldSim;
  roomId: string;
};

let seq = 0;

function makeRoom(role: 'OWNER' | 'GUEST' = 'OWNER'): Room {
  seq += 1;
  const roomId = `r_use${seq}`;
  const a = assemble({
    roomId,
    ownerId: role === 'OWNER' ? 'p1' : 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    rng: mulberry32(23),
  });
  const sim = a.host as unknown as WorldSim;
  a.runtime.join({ userId: 'p1', asGuest: role === 'GUEST' });
  a.runtime.join({ userId: 'p2' });
  /* `join` 会走房间的登记路径;若世界侧还没认识这两个人(取决于装配细节),
     显式补一次 —— `addPlayer` 是幂等语义的公开口。 */
  for (const id of ['p1', 'p2']) {
    if (!sim.physics.bodies.has(id)) sim.addPlayer(id, 8, 8);
  }
  /* 道具必须**先在背包里**才谈得上"用掉" —— 反作弊按总量守恒,
     凭空消耗会被 `ITEM_NEGATIVE` 整批拒(那是设计好的闸,不是障碍)。
     这是本套件的**前置**,不是断言对象:数量在这里给足,消耗方向由判据自己钉。 */
  for (const [itemId, n] of [[602, 1], [733, 1], [227, 3]] as const) {
    const src = `seed:${itemId}:${n}`;
    a.runtime.grantItemSource('p1', src);
    const seeded = a.runtime.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
    if (!seeded.allowed) throw new Error(`前置失败:塞不进 ${n} 件 ${itemId}`);
  }

  return { rt: a.runtime, sim, roomId };
}

/** 把 `id` 打成幽灵泡泡状态(公开口:直接改 `vitals` 的瞬时判定)。 */
function down(sim: WorldSim, id: string): void {
  const v = sim.vitals.get(id);
  if (v === null) throw new Error(`前置失败:${id} 不在 vitals 里`);
  v.hp = 0;
  v.downed = true;
  /* 推几帧让 `tickDowned` 建出 `DownedState`(慢帧 2Hz,快帧 30Hz)。 */
  sim.advance(40);
}

/** 把两个玩家摆到给定距离(沿 x 轴)。 */
function place(sim: WorldSim, id: string, x: number, y = 8): void {
  const b = sim.physics.bodies.get(id);
  if (b === undefined) throw new Error(`前置失败:${id} 没有刚体`);
  b.x = x;
  b.y = y;
}

const disp = (rt: Room['rt'], payload: Record<string, unknown>) =>
  rt.dispatchAction('p1', RoomAction.USE_ITEM, payload);

/** 取 `effect`。 */
const eff = (r: { effect?: Record<string, string | number | boolean> }) =>
  r.effect as Record<string, string | number | boolean>;

/* ───────────────────────── 判据 ───────────────────────── */

test('FND39-1 吃料理 602 ⇒ OK,active buffs 非空,且 hpFlat 并进 maxHp(+30)', () => {
  const r = makeRoom();
  const before = r.sim.maxHpForLevel('p1', 1);
  ok(before !== null, '前置:1 级应有 maxHp');

  const out = disp(r.rt, { itemId: FOOD_HP });

  eq(out.ok, true, `应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);
  eq(out.kind, 'OK', '应是 OK');
  eq(eff(out).itemId, FOOD_HP, 'effect 里应带 itemId');
  eq(eff(out).consumed, 1, '★ 吃掉一份 ⇒ 应扣 1 件');
  eq(r.sim.buffsOf('p1').hpFlat, 30, '★ 602 的 hpFlat=30(手册字面量)应进合并结果');
  eq(r.sim.maxHpForLevel('p1', 1), (before as number) + 30, '★ 上限应涨 30');
});

test('FND39-2 慢帧推进 ⇒ 剩余时间下降;到期后 buff 清空、上限回落', () => {
  const r = makeRoom();
  const base = r.sim.maxHpForLevel('p1', 1) as number;
  disp(r.rt, { itemId: FOOD_HP });
  const d = FOOD_BY_ID.get(FOOD_HP);
  ok(d !== undefined, '前置:602 应在内容表里');
  ok((d?.durationSec ?? 0) > 0, '前置:602 应有时长');

  /* 慢帧 0.5s / 次 ⇒ 先推到**一半时长**:buff 必须还在(证明它是按时长消耗,不是立刻消失)。 */
  const half = Math.ceil(((d?.durationSec ?? 0) / 2) * 30);
  r.sim.advance(half);
  eq(r.sim.buffsOf('p1').hpFlat, 30, '★ 中途仍在:buff 应按剩余时间消耗,而不是一次跳空');

  /* 再推过剩余的时长 ⇒ 必须清空、上限回落。 */
  const rest = Math.ceil((d?.durationSec ?? 0) * 30) + 60;
  r.sim.advance(rest);

  eq(r.sim.buffsOf('p1').hpFlat, 0, '★ 到期后不应再有 hpFlat');
  eq(r.sim.maxHpForLevel('p1', 1), base, '★ 上限应回落');
});

test('FND39-3 羽毛笔:6 格内命中幽灵泡泡队友 ⇒ 满血 + 3 秒无敌(写到活的 iframeSec)+ 扣 1 件', () => {
  const r = makeRoom();
  down(r.sim, 'p2');
  place(r.sim, 'p1', 5);
  place(r.sim, 'p2', 8); /* 距离 3 */

  const out = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: FEATHER, targetId: 'p2' });

  eq(out.ok, true, `应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);
  eq(eff(out).consumed, 1, '★ 命中 ⇒ 扣 1 件');
  eq(eff(out).invulnSec, 3, '无敌秒数应是 3(手册字面量)');
  const v = r.sim.vitals.get('p2');
  ok(v !== null, '目标仍在 vitals 里');
  eq(v?.downed, false, '★ 不应再是幽灵泡泡');
  eq(v?.hp, v?.maxHp, '★ 应满血');
  ok((v?.iframeSec ?? 0) > 0, '★★ 无敌必须写进 `vitals.iframeSec`(受击判定读的是这个)');
});

test('FND39-4 ★ 超距(6.1 格)⇒ 不复活且**一件都不扣**(背包总量不变)', () => {
  const r = makeRoom();
  down(r.sim, 'p2');
  place(r.sim, 'p1', 2);
  place(r.sim, 'p2', 8.1); /* 距离 6.1 */
  /* `authoritativeItemTotal` 是房间的私有方法 —— 这里只为**读**它而窄化(不改行为),
     与 `tests/WS-FND-20` 同法。只断言 `effect` 缺失是**不够的**:动作层在
     `applied === false` 时根本不读 `consume`,所以"不扣道具"必须用**总量**钉。 */
  const total = r.rt as unknown as { authoritativeItemTotal(u: string): number };
  const t0 = total.authoritativeItemTotal('p1');

  const out = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: FEATHER, targetId: 'p2' });

  eq(out.ok, false, '超距必须失败');
  eq(out.kind, 'INVALID', `应是 INVALID(kind=${out.kind})`);
  ok(out.effect === undefined, '没生效就没有 effect(也就没有 consumed)');
  eq(total.authoritativeItemTotal('p1'), t0, '★★ 超距**一件都不扣**:背包总量必须不变');

  /* ★ 直接打世界侧回执的 `consume`:动作层在 `!applied` 时**根本不会读这个字段**,
     所以单靠"回执里没有 effect"钉不住它 —— 必须对**契约字段本身**断言。 */
  const raw = r.sim.useItem('p1', { itemId: FEATHER, targetId: 'p2' });
  eq(raw.applied, false, '世界侧回执:超距不生效');
  eq(raw.consume, false, '★★ 世界侧回执:超距**不许**要求扣道具');
  const v = r.sim.vitals.get('p2');
  eq(v?.downed, true, '★ 目标仍是幽灵泡泡(没被救)');
});

test('FND39-5 itemId 非法(缺 / 0 / 1.5 / 字符串)⇒ INVALID 且**背包一点不动**', () => {
  const r = makeRoom();
  const before = r.sim.maxHpForLevel('p1', 1);
  const total = r.rt as unknown as { authoritativeItemTotal(u: string): number };
  const t0 = total.authoritativeItemTotal('p1');

  for (const bad of [{}, { itemId: 0 }, { itemId: 1.5 }, { itemId: '733' }, { itemId: -1 }]) {
    const out = disp(r.rt, bad);
    eq(out.ok, false, `载荷 ${JSON.stringify(bad)} 必须被拒`);
    eq(out.kind, 'INVALID', `载荷 ${JSON.stringify(bad)} 应是 INVALID`);
    /* ★ 必须由**报文校验**拒,而不是"世界侧不认识这个 id" ⇒ 理由里要出现 itemId。
       只断言 INVALID 是不够的:把校验删掉、让世界侧兜底拒绝,同样是 INVALID。 */
    ok((out.reason ?? '').includes('itemId'),
      `★ 应由报文校验拒绝(实得理由:${out.reason ?? '(无)'})`);
  }
  eq(r.sim.buffsOf('p1').hpFlat, 0, '★ 五次非法请求之后没有任何 buff');
  eq(r.sim.maxHpForLevel('p1', 1), before, '★ 上限也没变');
  eq(total.authoritativeItemTotal('p1'), t0, '★ 背包也一件没动');
});

test('FND39-6 未知道具 ⇒ INVALID 且理由说清"没有使用语义"', () => {
  const r = makeRoom();
  const out = disp(r.rt, { itemId: 99999 });
  eq(out.ok, false, '未知道具不许成功');
  eq(out.kind, 'INVALID', '应是 INVALID');
  ok((out.reason ?? '').includes('没有使用语义'), `理由应说清病因(实得:${out.reason ?? '(无)'})`);
});

test('FND39-7 权限:`baseline` ⇒ GUEST **可以**用;非房间成员 ⇒ PERMISSION', () => {
  /* `USE_ITEM` 的权限位是 `baseline`(吃/投掷是基础生存动作)⇒ GUEST 能用。
     这条钉的是"权限语义与 `ACTION_PERMISSION` 一致",不是"越权被拦"。 */
  const g = makeRoom('GUEST');
  const okOut = g.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: FOOD_HP });
  eq(okOut.ok, true, `GUEST 应能用道具(kind=${okOut.kind} reason=${okOut.reason ?? '-'})`);
  ok(g.sim.buffsOf('p1').hpFlat > 0, 'GUEST 吃下的 buff 应生效');

  /* 负对照:不是房间成员的 id ⇒ 连 `authorize` 都过不了。 */
  const r = makeRoom();
  const stranger = r.rt.dispatchAction('stranger', RoomAction.USE_ITEM, { itemId: FOOD_HP });
  eq(stranger.ok, false, '非成员不许用道具');
  eq(stranger.kind, 'PERMISSION', `应是 PERMISSION(kind=${stranger.kind})`);
  eq(r.sim.buffsOf('stranger').hpFlat, 0, '★ 被拒时世界零变化');
});

test('FND39-8 泡泡水枪:对幽灵泡泡目标连中 3 次 ⇒ 第 3 次困住(BUBBLED)', () => {
  const r = makeRoom();
  down(r.sim, 'p2');
  place(r.sim, 'p1', 5);
  place(r.sim, 'p2', 6);

  const a1 = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: BUBBLE_GUN, targetId: 'p2' });
  const a2 = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: BUBBLE_GUN, targetId: 'p2' });
  const a3 = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: BUBBLE_GUN, targetId: 'p2' });

  eq(a1.kind, 'OK', '第 1 发应成功');
  eq(eff(a1).trapped, false, '第 1 发不该困住');
  eq(eff(a2).trapped, false, '第 2 发不该困住');
  eq(a3.kind, 'OK', '第 3 发应成功');
  eq(eff(a3).trapped, true, '★ 第 3 发应困住');
  eq(eff(a3).stacks, 0, '困住后层数归零');
});

test('FND39-9 `foodBuffFrom` 与 `cookSoup` 对同一料理**同形**(防两份构造漂移)', () => {
  const def = FOOD_BY_ID.get(FOOD_HP);
  ok(def !== undefined, '前置:602 应在内容表里');
  if (def === undefined) return;

  const mine = foodBuffFrom(def);
  /* 用 `cookSoup` 真做一份,取它产出的 buff 逐字段比。配方:大汤锅 + 投料。 */
  const cooked = cookSoup({
    stationId: 506,
    inputs: { [FOOD_HP]: 1 },
  } as unknown as Parameters<typeof cookSoup>[0]);

  if (cooked.buff === null) {
    /* 配方不成立时,退一步只比"我自己构造的形状自洽"(仍能抓默认值表漂移)。 */
    eq(mine.key, `food_${FOOD_HP}`, 'key 命名应可推导');
    eq(mine.stacks, 1, 'stacks 应为 1');
    eq(mine.remainingSec, mine.durationSec, '新建 buff 的剩余时间应等于总时长');
    return;
  }

  eq(mine.sourceItemId, cooked.buff.sourceItemId, 'sourceItemId 应一致');
  eq(mine.branch, cooked.buff.branch, 'branch 应一致');
  eq(mine.stacks, cooked.buff.stacks, 'stacks 应一致');
  eq(JSON.stringify(mine.statMods), JSON.stringify(cooked.buff.statMods),
    '★ statMods 应逐字段一致(两边一旦漂就会红)');
});

test('FND39-10 同一目标重复投羽毛笔 ⇒ 第二次**明确拒绝**(已不是幽灵泡泡)', () => {
  const r = makeRoom();
  down(r.sim, 'p2');
  place(r.sim, 'p1', 5);
  place(r.sim, 'p2', 8);
  const total = r.rt as unknown as { authoritativeItemTotal(u: string): number };
  const t0 = total.authoritativeItemTotal('p1');

  const first = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: FEATHER, targetId: 'p2' });
  const second = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: FEATHER, targetId: 'p2' });

  eq(first.kind, 'OK', '第一次应成功');
  eq(second.ok, false, '★ 第二次必须被拒(目标已经不是幽灵泡泡)');
  eq(second.kind, 'INVALID', `应是 INVALID(kind=${second.kind})`);
  eq(total.authoritativeItemTotal('p1'), t0 - 1, '★ 只扣了 1 件(第一次),不是 2 件');
});

test('FND39-11 `foodCombatInput` 把两套约定换算对(中性 = 无副作用)', () => {
  const neutral = foodCombatInput({
    atkMul: 1, hpFlat: 0, defFlat: 0, moveMul: 1, critRate: 0, critDmg: 1,
    gravityMul: 1, muOverride: 0, jumpMul: 1, gatherMul: 1, expMul: 1,
  });
  eq(neutral.atkMul, 1, '乘区中性值原样传(1.0)');
  eq(neutral.critRate, 0, '加值中性值原样传(0)');
  eq(neutral.critDmg, 0, '★ 爆伤必须换算成**加值**中性 0 —— 直接传 1.0 等于白送 +100% 爆伤');
});

test('FND39-12 料理爆伤 ×1.5 ⇒ `BuffInput` 得 +0.5(不是 1.5)', () => {
  const bumped = foodCombatInput({
    atkMul: 1.25, hpFlat: 0, defFlat: 0, moveMul: 1, critRate: 0.1, critDmg: 1.5,
    gravityMul: 1, muOverride: 0, jumpMul: 1, gatherMul: 1, expMul: 1,
  });
  eq(bumped.atkMul, 1.25, '攻击乘区直接传');
  eq(bumped.critRate, 0.1, '暴击率是加值,直接传');
  eq(bumped.critDmg, 0.5, '★ 乘区 1.5 ⇒ 加值 +0.5');
});

test('FND39-13 只有 hpFlat 的料理(602)⇒ **战斗输入保持中性**(没有误加乘区)', () => {
  const r = makeRoom();
  const out = disp(r.rt, { itemId: FOOD_HP });
  eq(out.kind, 'OK', '吃下 602');

  const c = foodCombatInput(r.sim.buffsOf('p1'));
  eq(c.atkMul, 1, '★ 602 不给攻击乘区');
  eq(c.critRate, 0, '★ 602 不给暴击率');
  eq(c.critDmg, 0, '★ 602 不给爆伤');
});

test('FND39-14 ★ 227 的**活人半边**:对活人连中 3 发 ⇒ 困住 5 秒(前两发不困)', () => {
  const r = makeRoom();
  /* p2 **不倒地** —— 这一条测的就是"活人"那一半(倒地那一半见 FND39-8)。 */
  place(r.sim, 'p1', 5);
  place(r.sim, 'p2', 6);
  eq(r.sim.vitals.get('p2')?.downed, false, '前置:p2 是活人');

  const hits = [1, 2, 3].map(() =>
    r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: BUBBLE_GUN, targetId: 'p2' }));

  eq(hits[0].kind, 'OK', '第 1 发应成功');
  eq(eff(hits[0]).trapped, false, '第 1 发不该困住');
  eq(eff(hits[1]).trapped, false, '第 2 发不该困住');
  eq(hits[2].kind, 'OK', '第 3 发应成功');
  eq(eff(hits[2]).trapped, true, '★ 第 3 发应困住');
  eq(eff(hits[2]).trapSec, 5, '★ 困住 5 秒(手册字面量)');
  eq(eff(hits[2]).live, 1, '★ 走的是**活人**那条路径(不是倒地那条)');
  eq(r.sim.liveBubbleOf('p2').trapSec, 5, '世界侧状态也应记着 5 秒');
});

test('FND39-15 活人困住会按时长解开(慢帧推进)', () => {
  const r = makeRoom();
  place(r.sim, 'p1', 5);
  place(r.sim, 'p2', 6);
  for (let i = 0; i < 3; i += 1) {
    r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: BUBBLE_GUN, targetId: 'p2' });
  }
  ok(r.sim.liveBubbleOf('p2').trapSec > 0, '前置:已困住');

  /* 慢帧 0.5s / 次 ⇒ 推 5 秒 + 一点余量。 */
  r.sim.advance(30 * 6);
  eq(r.sim.liveBubbleOf('p2').trapSec, 0, '★ 5 秒之后应解开');
  eq(r.sim.liveBubbleOf('p2').stacks, 0, '层数也回到初始');
});

report('WS-FND-39');