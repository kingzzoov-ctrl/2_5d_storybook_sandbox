/**
 * WS-FND-31 —— `USE_ALCHEMY_FURNACE`:**在炼金台上炼一件东西**。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md:87` 把它归为「有相邻机制、缺中间一环」:
 * 炼金台在 `rooms/effects.ts` 只落到「识别 `ALCHEMY_LAB`」,**站台交互一个都没有**
 * ⇒ 玩家盖出炼金实验室,站进去发这条动作只会拿到 `NOT_IMPLEMENTED`。
 *
 * ⚠️ 本轮接的是**本地确定性**那一半(内容层配方的台面交互),**不是** LLM 自由炼金
 *   (`docs/TASK-96` 说的「LLM 炼金的接线」;世界侧入口 `WorldSim.forgeAlchemy()`
 *   需要外部服务 ⇒ 不在本轮,见动作模块文件头)。故断言只钉「配方 → 扣材料 →
 *   产物」这条事务,不声称 `freeForge`。
 *
 * ## 逐条判据(≥6 条)与「改坏哪里会红」
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 站台 + 材料够 ⇒ 成功:材料**真的**减、产物**真的**加 | 去掉 `applyInventory` 的任一侧 |
 * | 2 | 不在炼金室 ⇒ `INVALID` | 去掉站位判定(或写成「任何房间都行」) |
 * | 3 | 材料不够 ⇒ `INVALID`,**一个材料都不扣** | 先扣后判配方(部分扣减) |
 * | 4 | 产物收不下 ⇒ 材料**退回** | 去掉退回路(东西被吞) |
 * | 5 | 越权 ⇒ `PERMISSION` 且背包不动 | 去掉动作里的 `authorize` |
 * | 6 | 配方来源正确:留白槽由内容层匹配器决定 | 配方/留白被硬编成某个 id |
 * | 7 | 房间 key 必须真是 `ALCHEMY_LAB`(别人房间不算) | 把判定写成「在任意房间里」 |
 * | 8 | 产物没有配方 ⇒ `INVALID`(不炼空配方) | 去掉「有配方」这一道 |
 *
 * ## 夹具(真装配,照 `tests/WS-FND-20` / `WS-FND-26` 的手法)
 *
 * `assemble()` + `rt.dispatchAction`:**不**手搓 `rtOpts`、**不**写
 * `rt.worldSaveHost = sim`(那是手动装配,会绕开断言;本仓 8 例「测试全绿 +
 * 生产零消费」的共同形态正是它)。
 *
 * 炼金室照 `WS-FND-26` 盖卧室的手法盖:封闭小屋(351 墙 + 363 门)+ 走的
 * `ALCHEMY_LAB` 必需件 536 / 537,再 `sim.addPlayer()` 并推 20+ 帧 ——
 * 站位判定读的是**慢帧**产物(`WorldSim.lastRoomEffects`),不推帧会读到空数组。
 *
 * ## 为什么断言要装一层 `applyInventory` 观察器
 *
 * 「材料减、产物加」是**逐件**的事实,而本仓**没有按物品明细的服务端读口**:
 * `RoomRuntime.authoritativeItemTotal()` 只给**总量**,`WorldSim.inventoryDetailOf()`
 * 按契约返回 `null`。⇒ 这里一边读**权威总量**(真实写入),一边把动作提交给
 * `applyInventory` 的每一批 ops **原样记下来**(提交了什么),两侧合起来才
 * 排得掉「扣了 A 却加了 A」「产物没带凭证」这类形态。观察器只记录、不改判:
 * 它把调用**原样转发**给真实现。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { ITEM_BY_ID, matchRecipeByTags } from '../shared/constants/items.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

/* ───────────────────────── 内容层 id(语义只写在这里)───────────────────────── */

const WALL = 351;          /* 暖松原木圆墙 */
const DOOR = 363;          /* 温馨圆拱小木门 */
const CORE_FURNACE = 536;  /* 【AI核心】万物奇想炼金炉(ALCHEMY_LAB 必需件) */
const CORE_SHELF = 537;    /* 全服奇物发现博物架(ALCHEMY_LAB 必需件) */
const BED = 517;           /* 云端软绵绵单人床(COZY_BEDROOM 核心件 —— 负对照) */
const SAND = 108;          /* 琉璃石英砂(165 的唯一材料) */
const BOTTLE = 165;        /* 陶瓷空药水瓶:recipe {108:1} + output 3(收不下的那条判据用它) */
const COPPER_ORE = 112;    /* 黄铜矿石(155 的两件材料之一) */
const INGOT = 155;         /* 黄铜金属锭:recipe {112:2, 101:1} —— 缺料判据用它 */
const PAINT_BALL = 237;    /* 七彩颜料水球:recipe {165:1,166:1} + recipeAnyTag [['染料']] */
const DYE_RED = 166;       /* 绯红植物染料:配方里的**登记代表** */
const DYE_AMBER = 167;     /* 琥珀阳光染料:同一留白槽的**另一种**合格件 */
const RAW_NO_RECIPE = SAND;/* 原料没有配方 ⇒ 不能当「炼制产物」 */

/** 取内容层的产物件数(`output`);缺省 1 —— 不在这里另立一份产出规则。 */
function outputOf(itemId: number): number {
  const def = ITEM_BY_ID.get(itemId);
  return Math.max(1, Math.trunc(def?.output ?? 1));
}

/* ───────────────────────── 夹具 ───────────────────────── */

/** 观察器记下的一批 ops(提交给 `applyInventory` 的原样内容 + 反作弊的裁决)。 */
type AppliedBatch = {
  ops: readonly { itemId: number; delta: number; source?: string }[];
  allowed: boolean;
  rejectCode?: string;
};

type Fixture = {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: WorldSim;
  /** 发这条动作的人:正常路径 = 房主 `p1`,越权用例 = 另一个 guest 会话。 */
  actor: string;
  /** 玩家被放在这里(`makeRoom` 决定的房间中心/空地)。 */
  at: { x: number; y: number };
};

/** 只在**读**总量时窄化(`authoritativeItemTotal` 是房间的公开读口,见 WS-FND-20)。 */
type TotalLike = { authoritativeItemTotal(userId: string): number };

type RoomKind = 'LAB' | 'BEDROOM' | 'NOWHERE';

/**
 * 造一个真装配的房间。
 *
 * `where`:
 *   · `LAB`      —— 封闭小屋 + 536/537(应识别为 `ALCHEMY_LAB`),玩家站屋里;
 *   · `BEDROOM`  —— 同样的小屋但核心件是 517(识别为 `COZY_BEDROOM`)⇒ 负对照;
 *   · `NOWHERE`  —— 什么都不盖,玩家站在空地上(不在任何房间内)⇒ 负对照。
 */
function makeRoom(where: RoomKind, asGuest = false): Fixture {
  /* ⚠️ 房主与「发动作的人」必须是**两个** id:`join()` 对 `ownerId` 一律给
     OWNER(与 `asGuest` 无关)⇒ 用同一个 id 装不出一个真 GUEST。 */
  const owner = 'p1';
  const actor = asGuest ? 'p_guest' : owner;
  const a = assemble({
    roomId: 'r_alchemy',
    /* `ACTION_PERMISSION.USE_ALCHEMY_FURNACE = 'publicStorage'`,而 MEMBER 也没有
       这一位(见 `PERMISSION_MATRIX`)⇒ 正常路径必须由 OWNER 走。 */
    ownerId: owner,
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    /* 本套件测台面事务:不要让自发改刷的怪混进来(它们会让失败归因变模糊)。 */
    mobs: false,
    rng: mulberry32(11),
  });
  a.runtime.join({ userId: owner });
  if (asGuest) a.runtime.join({ userId: actor, asGuest: true });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const u of asGuest ? [owner, actor] : [owner]) {
    for (const id of a.runtime.authoritativeItemIds(u)) a.runtime.applyInventory(u, { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount(u, id) }] });
  }
  const sim = a.host as unknown as WorldSim;

  let at = { x: 12.5, y: 12.5 };
  if (where !== 'NOWHERE') {
    /* 封闭小屋 9×9:墙 351、南墙开门 363 —— 与 WS-03 / WS-FND-26 同一手法。 */
    const x0 = 3, y0 = 3, w = 9;
    for (let dy = 0; dy < w; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const edge = dx === 0 || dy === 0 || dx === w - 1 || dy === w - 1;
        sim.setCell(x0 + dx, y0 + dy, edge ? { obj: WALL, floor: 1, elev: 1 } : { floor: 1, elev: 1 });
      }
    }
    sim.setCell(x0 + 3, y0 + w - 1, { obj: DOOR, floor: 1, elev: 1 });
    if (where === 'LAB') {
      sim.setCell(6, 6, { obj: CORE_FURNACE });
      sim.setCell(8, 7, { obj: CORE_SHELF });
    } else {
      sim.setCell(6, 6, { obj: BED });
    }
    at = { x: x0 + 4 + 0.5, y: y0 + 4 + 0.5 };
  }

  /* 世界侧要「认识」这个玩家:刚体由 `addPlayer` 建,`tickRoomEffects` 才会计入。 */
  sim.addPlayer(actor, at.x, at.y);
  /* ⚠️ 站位判定与房间识别都挂在**慢帧**(2Hz)⇒ 必须推满两轮(20 帧),
     否则 `lastRoomEffects` 还是空的 / 旧值,动作会把「还没刷新」误报成
     「不在炼金室」。 */
  for (let i = 0; i < 25; i += 1) sim.tick();

  return { rt: a.runtime, sim, actor, at };
}

/** 塞东西进背包 —— 走**生产同一条路**:先 `grantItemSource` 再 `applyInventory`。 */
function seed(fx: Fixture, itemId: number, n: number): void {
  const src = `seed:${fx.actor}:${itemId}:${n}`;
  fx.rt.grantItemSource(fx.actor, src);
  const r = fx.rt.applyInventory(fx.actor, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `前置:应能塞进 ${n} 件 ${itemId}(被拒说明容量/守恒层先坏了)`);
}

/**
 * 给 `rt.applyInventory` 装一层**只读**观察器:原样转发调用,顺带记下每批 ops
 * 与裁决(见文件头「为什么断言要装一层观察器」)。装之前先塞材料 —— 否则
 * 前置的 `seed()` 也会被记进去。
 */
function spyInventory(fx: Fixture): AppliedBatch[] {
  const calls: AppliedBatch[] = [];
  type ApplyFn = (userId: string, input: { ops: readonly { itemId: number; delta: number; source?: string }[] }) =>
    { allowed: boolean; rejectCode?: string };
  const rt = fx.rt as unknown as { applyInventory: ApplyFn };
  const orig: ApplyFn = rt.applyInventory.bind(fx.rt);
  rt.applyInventory = (userId, input) => {
    const r = orig(userId, input);
    calls.push({
      ops: input.ops.map((o) => ({ itemId: o.itemId, delta: o.delta, source: o.source })),
      allowed: r.allowed,
      rejectCode: r.rejectCode,
    });
    return r;
  };
  return calls;
}

const disp = (fx: Fixture, payload: Record<string, unknown>) =>
  fx.rt.dispatchAction(fx.actor, RoomAction.USE_ALCHEMY_FURNACE, payload);

const totalOf = (fx: Fixture) => (fx.rt as unknown as TotalLike).authoritativeItemTotal(fx.actor);

/** 把一批 ops 归一化成可比较的形状(顺序无关)。 */
const normOps = (ops: readonly { itemId: number; delta: number }[]) =>
  ops.map((o) => ({ itemId: o.itemId, delta: o.delta })).sort((a, b) => a.itemId - b.itemId);

/** 一批 ops 里某一件的净变化(没有则为 0)。 */
const deltaOf = (batch: AppliedBatch, itemId: number) =>
  batch.ops.filter((o) => o.itemId === itemId).reduce((s, o) => s + o.delta, 0);

/* ───────────────────────── 1 ───────────────────────── */

test('FND31-1 站在炼金室 + 材料够 ⇒ 成功后材料减、产物加(两侧账都对)', () => {
  const fx = makeRoom('LAB');
  /* 前置:真的识别成炼金室 —— 否则下面「成功」会在错误的房间里发生。 */
  ok(fx.sim.rooms().some((r) => r.key === 'ALCHEMY_LAB'),
    `前置:应识别出 ALCHEMY_LAB;实测 ${JSON.stringify(fx.sim.rooms().map((r) => r.key))}`);

  seed(fx, SAND, 4);
  eq(totalOf(fx), 4, '前置:背包 4 件');
  const calls = spyInventory(fx);

  /* 期望值**取自内容层**(不在这里手写配方/产出件数)。 */
  const expect = matchRecipeByTags(BOTTLE, { [SAND]: 4 });
  ok(expect.ok, `前置:内容层应能匹配 ${BOTTLE}(实测 ${expect.reason ?? '-'})`);
  const made = outputOf(BOTTLE);

  const r = disp(fx, { itemId: BOTTLE, have: { [SAND]: 4 } });
  eq(r.ok, true, `炼制应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  ok(r.effect !== undefined, '★ `OK` 必须带 effect(不留"回 OK 却无副作用")');
  eq(r.effect!.produced, made, '回执里的产出件数 = 内容层 output');

  /* 两侧账之一:提交给 `applyInventory` 的那两批 ops 逐件对得上。 */
  eq(calls.length, 2, '一次炼制 = 一批扣材料 + 一批给产物');
  eq(normOps(calls[0].ops), normOps(Object.entries(expect.consumed).map(([k, n]) => ({ itemId: Number(k), delta: -n }))),
    '★ 第一批扣的**就是内容层匹配器算出的那几件**(含留白槽选中的那件)');
  eq(calls[1].ops.length, 1, '第二批只给产物一件');
  eq(calls[1].ops[0].itemId, BOTTLE, '★ 产物 = 报文里的 itemId');
  eq(calls[1].ops[0].delta, made, `★ 产物 +${made}(内容层 output)`);
  ok(typeof calls[1].ops[0].source === 'string' && calls[1].ops[0].source.length > 0,
    '★ 产物必须带服务端凭证(不带会被反作弊按"凭空产出"拒)');
  eq(calls[0].allowed && calls[1].allowed, true, '两批都应被反作弊放行(否则下面总量对不上)');

  /* 两侧账之二:**权威总量**真的变了(1 材料 → 3 瓶 = 净 +2)。 */
  eq(totalOf(fx), 4 - 1 + made, `★ 背包总量 4 → ${4 - 1 + made}(材料减、产物加同时成立)`);
  eq(totalOf(fx), 6, '本用例的具体数值(材料 1 件 → 产物 3 件)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND31-2 不在炼金台 ⇒ INVALID 且背包一个数都不动', () => {
  const fx = makeRoom('NOWHERE');
  eq(fx.sim.rooms().length, 0, '前置:空地上没有房间');
  seed(fx, SAND, 4);
  const calls = spyInventory(fx);

  const r = disp(fx, { itemId: BOTTLE, have: { [SAND]: 4 } });
  eq(r.ok, false, '不在炼金室里不能炼');
  eq(r.kind, 'INVALID', '★ 应是 INVALID(不是 NOT_IMPLEMENTED —— 这一层已经接线了)');
  ok(typeof r.reason === 'string' && r.reason.includes('炼金室'),
    `★ 理由要说明站位不对,而不是含糊拒绝(实测:${r.reason ?? '-'})`);
  eq(calls.length, 0, '★ 失败路径**一次都没动背包**(不是"扣了再退")');
  eq(totalOf(fx), 4, '背包不变');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND31-3 材料不够 ⇒ INVALID,一个材料都不扣(不出现"扣了一半")', () => {
  const fx = makeRoom('LAB');
  /* 155 需要 {112:2, 101:1};只给 112×2 ⇒ 缺 101。 */
  seed(fx, COPPER_ORE, 2);
  const calls = spyInventory(fx);

  const expect = matchRecipeByTags(INGOT, { [COPPER_ORE]: 2 });
  eq(expect.ok, false, '前置:内容层判定材料不足');
  eq(expect.consumed[COPPER_ORE], undefined, '前置:缺料时匹配器不消耗任何件');

  const r = disp(fx, { itemId: INGOT, have: { [COPPER_ORE]: 2 } });
  eq(r.ok, false, '材料不足不能炼');
  eq(r.kind, 'INVALID', '★ 应是 INVALID(状态不对,不是越权)');
  ok(typeof r.reason === 'string' && r.reason.includes('材料不足'),
    `理由应指明缺料(实测:${r.reason ?? '-'})`);
  eq(calls.length, 0, '★ 判定在扣减**之前** ⇒ 连一批 ops 都没提交');
  eq(totalOf(fx), 2, '★ 背包原封不动(不是"扣了 112 才说缺 101")');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND31-4 产物收不下 ⇒ 材料**退回**,东西不被吞', () => {
  const fx = makeRoom('LAB');
  /* 一级容量 = 8(见 `RoomRuntime.carryCapacityOf`);塞满到 8,
     再炼一个 output=3 的产物:7 + 3 = 10 > 8 ⇒ 必然溢出。 */
  seed(fx, SAND, 8);
  eq(totalOf(fx), 8, '前置:背包正好到容量上界');
  const calls = spyInventory(fx);

  const made = outputOf(BOTTLE);
  ok(made >= 2, '前提:本用例挑的产物必须一次出多件,否则溢不出来');
  const r = disp(fx, { itemId: BOTTLE, have: { [SAND]: 8 } });
  eq(r.ok, false, '收不下时不能报成功');
  eq(r.kind, 'INVALID', '★ 应是 INVALID');
  ok(typeof r.reason === 'string' && r.reason.includes('退回'),
    `★ 理由要明说材料已退回(实测:${r.reason ?? '-'})`);

  /* 三批:扣材料(过) → 给产物(被容量拒) → 退回材料(过)。 */
  eq(calls.length, 3, '扣 → 给 → 退 三批');
  eq(calls[0].allowed, true, '第一批(扣材料)应通过');
  eq(calls[1].allowed, false, '第二批(给产物)应被拒');
  eq(calls[1].rejectCode, 'ITEM_OVERFLOW', `★ 拒因应是容量溢出(实测 ${calls[1].rejectCode ?? '-'})`);
  eq(calls[2].allowed, true, '退回必须真的发生(否则材料被吞)');
  eq(calls[2].ops.length, 1, '退回就是那一件材料');
  eq(deltaOf(calls[2], SAND), 1, '★ 退回 +1 件材料');
  ok(typeof calls[2].ops[0].source === 'string' && calls[2].ops[0].source.length > 0,
    '退回是正 delta ⇒ 同样必须带凭证');

  /* 最关键的一条:总量回到原值。 */
  eq(totalOf(fx), 8, '★ 材料退回来了("扣了东西却没给出产物"会在这里露出来)');
  eq(deltaOf(calls[1], BOTTLE), made, '产物那一批确实是 +产物(只是被拒了)');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND31-5 越权 ⇒ PERMISSION(不是 INVALID),且背包零变化', () => {
  /* `ACTION_PERMISSION.USE_ALCHEMY_FURNACE = 'publicStorage'`,而 GUEST 无该位。 */
  const fx = makeRoom('LAB', true);
  seed(fx, SAND, 4);
  const calls = spyInventory(fx);

  const r = disp(fx, { itemId: BOTTLE, have: { [SAND]: 4 } });
  eq(r.ok, false, 'GUEST 不能使用炼金台');
  eq(r.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(与"材料不足"混成一个 kind 会让客户端误判)');
  eq(calls.length, 0, '★ 越权**零副作用**:没有副作用就没有 ops 被提交');
  eq(totalOf(fx), 4, '背包不变');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND31-6 配方来源正确:留白槽由内容层匹配器决定(167 也能顶 166)', () => {
  const fx = makeRoom('LAB');
  /* 237 的配方写的是 `{165:1, 166:1}` + 留白槽 [['染料']] ⇒ 166 只是**登记代表**,
     换成 167 照样做得出来。这条把「谁决定配方」变成断言:
     本动作若自己写死 `166`,下面两处会同时红。 */
  const have = { [BOTTLE]: 1, [DYE_AMBER]: 1 };
  const expect = matchRecipeByTags(PAINT_BALL, have);
  ok(expect.ok, `前置:内容层应能匹配 ${PAINT_BALL}(实测 ${expect.reason ?? '-'})`);
  eq(expect.consumed[DYE_AMBER], 1, '★ 留白槽选中了 167(琥珀阳光染料)');
  eq(expect.consumed[DYE_RED], undefined, '★ 登记代表 166 并**没有**被消耗(它只是登记)');

  seed(fx, BOTTLE, 1);
  seed(fx, DYE_AMBER, 1);
  eq(totalOf(fx), 2, '前置:背包 2 件');
  const calls = spyInventory(fx);

  const r = disp(fx, { itemId: PAINT_BALL, have });
  eq(r.ok, true, `炼制应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(normOps(calls[0].ops), normOps(Object.entries(expect.consumed).map(([k, n]) => ({ itemId: Number(k), delta: -n }))),
    '★ 扣减与**内容层匹配器的 consumed** 逐件相同(含它挑中的那件染料)');
  eq(deltaOf(calls[0], DYE_RED), 0, '★ 没有扣 166 —— 硬编配方就会在这里红');
  eq((r.effect as { consumed?: unknown } | undefined)?.consumed, expect.consumed,
    '回执里的 consumed 就是这一份(不是配方需求表)');
  eq(totalOf(fx), 2 - 2 + outputOf(PAINT_BALL), '总量按 2 件材料 → 1 件产物结算');
  eq(totalOf(fx), 1, '本用例的具体数值');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND31-7 判定是「炼金室」而不是「任意房间」:站在卧室里也不行', () => {
  const fx = makeRoom('BEDROOM');
  ok(fx.sim.rooms().some((r) => r.key === 'COZY_BEDROOM'),
    `前置:应识别出 COZY_BEDROOM;实测 ${JSON.stringify(fx.sim.rooms().map((r) => r.key))}`);
  seed(fx, SAND, 4);
  const calls = spyInventory(fx);

  const r = disp(fx, { itemId: BOTTLE, have: { [SAND]: 4 } });
  eq(r.ok, false, '卧室里不能炼金');
  eq(r.kind, 'INVALID', '★ 应是 INVALID');
  ok(typeof r.reason === 'string' && r.reason.includes('COZY_BEDROOM'),
    `★ 理由要报出**实际所在房间**,便于归因(实测:${r.reason ?? '-'})`);
  eq(calls.length, 0, '零副作用');
  eq(totalOf(fx), 4, '背包不变');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND31-8 产物没有配方 ⇒ INVALID(不炼"空配方")', () => {
  const fx = makeRoom('LAB');
  /* 108 是自然采集原料:内容表里**没有** recipe ⇒ 不是炼制产物。 */
  eq(ITEM_BY_ID.get(RAW_NO_RECIPE)?.recipe, undefined, '前置:该 id 在内容表里没有配方');
  seed(fx, SAND, 4);
  const calls = spyInventory(fx);

  const r = disp(fx, { itemId: RAW_NO_RECIPE, have: { [SAND]: 4 } });
  eq(r.ok, false, '没有配方的产物不能炼');
  eq(r.kind, 'INVALID', '★ 应是 INVALID');
  ok(typeof r.reason === 'string' && r.reason.includes('配方'),
    `理由应说明"没有配方"(实测:${r.reason ?? '-'})`);
  eq(calls.length, 0, '零副作用');
  eq(totalOf(fx), 4, '背包不变(不能把原料"炼"成自己)');
});

report('WS-FND-31');
