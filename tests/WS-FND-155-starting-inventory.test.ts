/**
 * WS-FND-155 · **新玩家进场有起始背包**(不必先拆方块)。
 *
 * ## 这一版修的是什么
 *
 * 新玩家开场手里一件东西都没有,而 `Q` / `G` / `F` / `N` / `T` / `2` / `3` / `4`
 * 都要一个「最近碰过的物品 id」(`PLAY.md` 的「**都有一个前置:必须碰过一件东西**」
 * 那一节如实写着这件事)⇒ 实测的第一步**固定**是「按 E 拆一块」。现在进场时发一份
 * **保守**的起始包,「有材料可用」不再等于「先拆一块」;而「最近物品」那条前置
 * **仍然成立**(它只能来自回执,不是背包里有什么就能发出去)。
 *
 * ## 判据(9 条)
 * ```text
 * FND155-1 表本身:每件都在冻结内容表里 / 件数合法 / 合计 7 ≤ Lv.1 容量 8 /
 *             含**最低阶**工具(201,配方只含自然材料)+ 它的配方原料逐件给够
 * FND155-2 ★★ 首次入场真的发:账 +7 件、回执 GRANTED、容量取自权威读口
 * FND155-3 ★★ 重连不重发:resumed 那次是 SKIPPED,账仍 7(14 会红)
 * FND155-4 ★ 退房重进不重发(席位清干净了也不再发)
 * FND155-5 ★★ 容量不足 ⇒ 按优先级截断,回执逐条如实,发出去的件数 ≤ 容量
 * FND155-6 ★ 内容合法性 / 坏容量 ⇒ 整批不发(不给半份、fail-closed)
 * FND155-7 ★★ 入场中途失败 ⇒ 起始背包**整批撤回**、零痕迹、幂等账不卡死
 * FND155-8 ★ `RESET_WORLD` 之后**不**重发(裁决 + 三条理由写在用例里)
 * FND155-9 ★ 两条守卫独立:账里已有东西的人不发(跨进程重复发放被收窄)
 * ```
 *
 * ## 怎么变红(每条都靠注入证明自己有牙)
 * ```text
 * FND155-1 把表里任何一件换成表外 id / 删掉 201 ⇒ 对应断言红
 * FND155-2 把发放挪到 `join` 之外(只留声明)⇒ 断言 3/4/5 全红
 * FND155-3 删掉闸 1(房间账)⇒ 断言 2 红(账变 14);顺便断言回执被**重写**过
 * FND155-4 把闸 1 换成「看世界侧 CREATED」(退房会清世界账)⇒ 断言 3 红
 * FND155-5 把截断改成「超容量就整项丢」/ 不算容量 ⇒ 断言 3/5/6 之一红
 * FND155-6 把内容检查挪到截断**之后**(或跳过坏条继续发)⇒ 断言 3 红
 * FND155-7 删掉 catch 里的 `rollbackStartingInventory` ⇒ 断言 3/5/7 红
 * FND155-8 在 RESET_WORLD 成功时清 `startingInventoryGranted` ⇒ 断言 4/7 红
 * FND155-9 把闸 2 删掉、只留闸 1(房间账)⇒ 断言 2/5 红
 * ```
 *
 * 运行:`node tests/WS-FND-155-starting-inventory.test.ts`
 */
import { carryItemCapacity, ITEMS_PER_CARRY_SLOT } from '../server/src/combat/progression.ts';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { RoomRuntime, WorldSaveHost, StartingInventoryReport } from '../server/src/net/room.ts';
import { carryCapacityOfLevel } from '../server/src/combat/progression.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import {
  STARTING_INVENTORY,
  planStartingInventory,
} from '../shared/constants/starting_inventory.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { addItemInstance, createUser, migrate } from '../server/src/db/repo.ts';

/* ───────────────────────── 内容层锚点(字面量取自冻结表) ───────────────────────── */

const LOG = 101;                 /* 暖松原木 */
const STONE = 106;               /* 云母圆石 */
const GRASS = 118;               /* 柔韧风草 */
const AXE = 201;                 /* 暖松石刃斧 —— 最低阶工具 */
const ROPE = 160;                /* 结实风草绳(第二阶,起点) */
const SHOVEL = 205;              /* 改地水渠木铲 —— 要 155 黄铜锭 ⇒ 第二阶 */

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 世界侧能力(**只声明用到的**)—— 与 WS-FND-129 / WS-FND-131 同一手法:
 * 测试要断言的是世界内部可观测的状态,而 `net/room.ts` 不认识模拟层。
 */
interface SimHandle {
  progressOf(playerId: string): { carrySlots: number };
  playerPosition(playerId: string): { x: number; y: number; z: number } | null;
}

const simOf = (host: WorldSaveHost): SimHandle => host as unknown as SimHandle;

/** 幂等账(私有字段)的读口 —— 只读,用于断言「撤回把这条也解掉了」。 */
const grantedIdsOf = (rt: RoomRuntime): Set<string> =>
  (rt as unknown as { startingInventoryGranted: Set<string> }).startingInventoryGranted;

let roomSeq = 0;
type Fixture = { rt: RoomRuntime; sim: SimHandle; db: MemoryDb | null; roomId: string };

/** 建一个**真装配**出来的房间(不手搓 rtOpts —— 那会绕开 `assemble()` 的接线)。 */
function makeRoom(o: { ownerId?: string; db?: MemoryDb | null } = {}): Fixture {
  roomSeq += 1;
  const roomId = `r_fnd155_${roomSeq}`;
  const db = o.db ?? null;
  const a = assemble({
    roomId,
    ownerId: o.ownerId ?? 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 16,
    /* 本套件不测生物 AI:关掉免得自发改刷干扰背包账。 */
    mobs: false,
    db,
  });
  return { rt: a.runtime, sim: simOf(a.host), db, roomId };
}

/** 一份**迁移过**的内存库 + 一个真用户行(`rooms.owner_id` 要它)。 */
function freshDb(ownerId: string): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: ownerId, displayName: 'A', nowMs: 1000 });
  return db;
}

/** 表里那一项的件数(找不到 = 0)。 */
const countInTable = (itemId: number, table = STARTING_INVENTORY): number =>
  table.find((e) => e.itemId === itemId)?.count ?? 0;

/** `{itemId, count}[]` → `['101x2', ...]`(给 eq 一个可读的定序形状)。 */
const asPairs = (rows: readonly { itemId: number; count: number }[]): string[] =>
  rows.map((r) => `${r.itemId}x${r.count}`);

const lastReport = (rt: RoomRuntime): StartingInventoryReport => {
  const r = rt.lastStartingInventory;
  ok(r !== null, '回执必须存在(`lastStartingInventory`)—— 发放不许静默');
  return r as StartingInventoryReport;
};

/* ═════════════════ 1. 表本身 ═════════════════ */

test('FND155-1 ★ 起始背包表:每件都在冻结内容表里 / 合计 7 ≤ Lv.1 容量 8 / 含最低阶工具', () => {
  /* 变红条件:表里塞一个表外 id、把件数写成 0、删掉 201、或把 201 的配方原料少给一件。 */
  ok(STARTING_INVENTORY.length > 0, '起始背包表不许为空');
  for (const e of STARTING_INVENTORY) {
    ok(Number.isInteger(e.itemId) && ITEM_BY_ID.has(e.itemId),
      `#${String(e.itemId)} 必须在冻结内容表 items.ts 里(不许发明物品 id)`);
    ok(Number.isInteger(e.count) && e.count >= 1, `#${e.itemId} 的件数必须是 ≥1 的整数`);
  }

  const total = STARTING_INVENTORY.reduce((n, e) => n + e.count, 0);
  eq(total, 7, '★ 保守:合计 7 件(2+2+2+1)');
  ok(total <= carryCapacityOfLevel(1),
    `★★ 起始包不许超 1 级容量(${total} ≤ ${carryCapacityOfLevel(1)})`);
  eq(carryCapacityOfLevel(1), 8, '1 级容量 8 —— 出处是 progression 的 statsAtLevel,不复制到表里');

  /* 依据一:201 是**最低阶工具** —— 它的配方只含自然材料(101~130)。 */
  const axe = ITEM_BY_ID.get(AXE);
  ok(axe !== undefined, '内容表里必须有 201 暖松石刃斧');
  eq(axe?.category, ItemCategory.TOOL, '201 是工具(TOOL)');
  eq(axe?.recipe, { [LOG]: 2, [STONE]: 2 }, '内容表里 201 的配方(本表的依据)');
  for (const key of Object.keys(axe?.recipe ?? {})) {
    const id = Number(key);
    ok(id >= 101 && id <= 130, `201 的原料 #${id} 必须是自然采集物(最低阶的判法就在这里)`);
  }
  /* 表里必须**逐件给够**这份配方的原料,并**额外**给一件成品的工具。 */
  ok(countInTable(LOG) >= 2, `表里要给够 201 的松木(实得 ${countInTable(LOG)})`);
  ok(countInTable(STONE) >= 2, `表里要给够 201 的石材(实得 ${countInTable(STONE)})`);
  eq(countInTable(AXE), 1, '★ 一件基础工具:201 自己在表里');

  /* 依据二:「最低阶」不是随手挑的 —— 205 要 155 黄铜锭(半成品)⇒ 它是第二阶。 */
  eq(ITEM_BY_ID.get(SHOVEL)?.recipe, { [LOG]: 2, 155: 1 }, '205 的配方要半成品 155 ⇒ 第二阶(所以不进最低阶起始包)');

  /* 依据三:多给的 118 有明确的下一步(160 → 711),不是凑数。 */
  eq(ITEM_BY_ID.get(ROPE)?.recipe, { [GRASS]: 2 }, '160 结实风草绳 = 118×2');
  ok(countInTable(GRASS) >= 2, '表里给够了 160 的原料');
});

/* ═════════════════ 2. 首次入场:真的发 ═════════════════ */

test('FND155-2 ★★ 首次入场发放:账里真的多了 7 件,回执 GRANTED,容量取自权威读口', () => {
  /* 变红条件:把 `join` 里那行 `grantStartingInventory` 删掉 ⇒ 断言 2~6 全红。 */
  const f = makeRoom();
  const res = f.rt.join({ userId: 'u_a' });
  eq(res.ok, true, '前置:入场成功');

  const rep = lastReport(f.rt);
  eq(rep.verdict, 'GRANTED', '★ 首次出现 ⇒ GRANTED');
  eq(rep.userId, 'u_a', '回执点名是谁的');
  eq(rep.total, 7, '发了 7 件');
  eq(asPairs(rep.granted), ['101x2', '106x2', '118x2', '201x1'], '★ 逐项与冻结表一致');
  eq(rep.truncated, [], '8 格装得下 7 件 ⇒ 没有截断');
  ok(rep.total <= rep.capacity, '★ 发出的件数 ≤ 容量');

  /* 账(权威)—— 不是「回执说有」,而是**真的**在按件账/总量账里可查。 */
  eq(f.rt.authoritativeItemTotal('u_a'), 7, '★★ 权威总量真的多了 7 件');
  eq(f.rt.authoritativeItemIds('u_a'), [LOG, STONE, GRASS, AXE], '★★ 按件账逐件都在(升序)');
  eq(f.rt.authoritativeItemCount('u_a', AXE), 1, '★ 基础工具在账里');
  eq(f.rt.carryCapacityOf('u_a'), rep.capacity, '★ 回执里的容量 = 权威读口(同一出处)');

  /* 负对照:没人进场的房间里,同一个 id 账里是 0 —— 证明上面那 7 件不是「恒真」。 */
  const g = makeRoom();
  eq(g.rt.authoritativeItemTotal('u_a'), 0, '负对照:没进过场 ⇒ 0 件');
});

/* ═════════════════ 3. 重连 / 重进:都不重发 ═════════════════ */

test('FND155-3 ★★ 重连不重发:resumed 那次是 SKIPPED,账仍 7(14 会红)', () => {
  /* 变红条件:删掉闸 1(`startingInventoryGranted`)⇒ 断言 3 红(账变 14)。 */
  const f = makeRoom();
  f.rt.join({ userId: 'u_a' });
  const first = lastReport(f.rt);
  eq(first.verdict, 'GRANTED', '前置:第一次发了');

  f.rt.disconnect('u_a');
  const re = f.rt.join({ userId: 'u_a' });
  eq(re.resumed, true, '前置:走的是重连路径(宽限期内)');

  eq(f.rt.authoritativeItemTotal('u_a'), 7, '★★ 重连后仍是 7 件 —— 重复发就会是 14');
  const rep = lastReport(f.rt);
  eq(rep.verdict, 'SKIPPED', '★ 回执如实写 SKIPPED(不是「没发生」)');
  ok(String(rep.reason).includes('已经给他发过'), `理由可读(实得:${rep.reason})`);
  ok(first !== rep, '回执被**重写**了 ⇒ 重连真的走了那条尝试,而不是「没调就等于没发」');
  eq(asPairs(rep.granted), [], '没发的那次不许声称发了(granted 为空)');
  eq(rep.total, 0, '同一次 SKIPPED 的件数是 0');
});

test('FND155-4 ★ 退房重进不重发:席位清干净了也不再发', () => {
  /* 变红条件:把判据换成世界侧 `CREATED`(退房会 `removePlayer` 清世界账)⇒ 断言 3 红。 */
  const f = makeRoom();
  f.rt.join({ userId: 'u_a' });
  f.rt.leave('u_a');
  eq(f.rt.isSeated('u_a'), false, '前置:席位已清干净');

  const again = f.rt.join({ userId: 'u_a' });
  eq(again.ok, true, '前置:同名重进成功');
  eq(f.rt.authoritativeItemTotal('u_a'), 7, '★ 仍是 7 件(退房不背包账,重进也不再发)');
  eq(lastReport(f.rt).verdict, 'SKIPPED', '★ 如实 SKIPPED');
});

/* ═════════════════ 4. 与容量闸一致 ═════════════════ */

test('FND155-5 ★★ 容量不足 ⇒ 按优先级截断,回执逐条如实,发出件数 ≤ 容量', () => {
  /* 变红条件:不算容量 / 超了就整项丢 / 截断不写回执 ⇒ 断言 3、6、7 之一红。
     容量走**生产读口**(档案 carrySlots ⇒ `carryCapacityOf`),不注入假值。 */
  const f = makeRoom();
  f.sim.progressOf('u_a').carrySlots = 3;      /* 3 个负重格 */
  f.rt.join({ userId: 'u_a' });

  const live = lastReport(f.rt);
  eq(live.capacity, carryItemCapacity(3), '★ 容量取**实得**档案值(3 格 × 每格件数),不是内联的 8 格');
  eq(live.verdict, 'GRANTED', '★ 照发');
  ok(live.total <= live.capacity, '★★ 发出去的件数 ≤ 容量(与容量闸一致)');
  eq(f.rt.authoritativeItemTotal('u_a'), live.total, '★★ 回执与账一致');

  /* 截断规则本身:一格装 20 件之后,生产读口给不出「装不下 7 件」的容量
     (最小是 1 格 = 20 件)⇒ 截断钉在同一个计划函数上(`join` 调的就是它)。 */
  const rep = planStartingInventory(3);
  eq(rep.ok, true, '★ 截断之后照发(不是「装不下就整包不发」)');
  eq(rep.total, 3, '★ 只发 3 件');
  ok(rep.total <= rep.capacity, '★★ 计划件数 ≤ 容量');
  eq(asPairs(rep.granted), ['101x2', '106x1'], '★★ 按**优先级(表序)**截断:先保表头,末项只发一半');
  eq(asPairs(rep.truncated), ['106x1', '118x2', '201x1'], '★★ 丢掉的逐条如实列出(不静默)');
  const grantSum = rep.granted.reduce((n, e) => n + e.count, 0);
  const dropSum = rep.truncated.reduce((n, e) => n + e.count, 0);
  eq(grantSum + dropSum, 7, '★ 发 + 丢 = 表内 7 件(不许凭空多一件或少一件)');
  ok(rep.truncated.length > 0, '截断必须留下痕迹(否则「如实回执」是空话)');

  /* 负对照:同一间房里的另一个人(默认档案 = 8 格)不截断。 */
  f.rt.join({ userId: 'u_b' });
  eq(lastReport(f.rt).truncated, [], '负对照:8 格的人不被截断');
  eq(f.rt.authoritativeItemTotal('u_b'), 7, '负对照:他拿满 7 件');
});

/* ═════════════════ 5. 内容合法性 / 坏容量 ⇒ 整批不发 ═════════════════ */

test('FND155-6 ★ 内容合法性:表外 id / 坏件数 / 坏容量 ⇒ 整批不发(fail-closed)', () => {
  /* 变红条件:把内容检查删掉(或挪到截断之后、或跳过坏条继续发)⇒ 断言 2/3/5 红。 */
  const bogus = planStartingInventory(8, [{ itemId: 999999, count: 1 }]);
  eq(bogus.ok, false, '★ 表外 id ⇒ 计划被拒');
  eq(bogus.granted, [], '★ 一个都不发(不给半份)');
  eq(bogus.total, 0, '件数 0');
  ok(bogus.reason.includes('不在冻结内容表'), `理由可读(实得:${bogus.reason})`);

  eq(planStartingInventory(8, [{ itemId: LOG, count: 0 }]).ok, false, '件数 0 ⇒ 拒');
  eq(planStartingInventory(8, [{ itemId: LOG, count: 1.5 }]).ok, false, '件数非整数 ⇒ 拒');

  const mixed = planStartingInventory(8, [{ itemId: LOG, count: 2 }, { itemId: 999999, count: 1 }]);
  eq(mixed.ok, false, '★ 一条坏 ⇒ **整批**停(不跳过坏条继续发:那会把表的错伪装成「少发一件」)');
  eq(mixed.granted, [], '前面那条合法的也不发');

  for (const cap of [0, -1, 2.5, NaN, Infinity]) {
    const p = planStartingInventory(cap);
    eq(p.ok, false, `容量 ${String(cap)} ⇒ 不发(fail-closed:不猜「0 格」也不猜「无限」)`);
    eq(p.granted, [], `容量 ${String(cap)} ⇒ granted 必须为空`);
  }

  /* 正对照:冻结表 + 真容量 ⇒ 逐件发全(证明上面那组不是「恒 false」)。 */
  const good = planStartingInventory(carryCapacityOfLevel(1));
  eq(good.ok, true, '正对照:8 格装得下');
  eq(good.total, 7, '正对照:7 件');
  eq(good.truncated, [], '正对照:不截断');

  /* 房间级:真发出去的那几件**逐个**查得到在内容表里。 */
  const f = makeRoom();
  f.rt.join({ userId: 'u_a' });
  const ids = f.rt.authoritativeItemIds('u_a');
  ok(ids.length > 0, '前提:账里有东西可查');
  for (const id of ids) ok(ITEM_BY_ID.has(id), `账里的 #${id} 必须在冻结内容表里`);
});

/* ═════════════════ 6. 装配失败路径:零副作用 ═════════════════ */

test('FND155-7 ★★ 入场中途失败 ⇒ 起始背包整批撤回(零痕迹),幂等账不卡死', () => {
  /* 变红条件:删掉 `catch` 里的 `rollbackStartingInventory` ⇒ 断言 4/5/8 红
     (账里留下 7 件没人能拿到,而这条 id 从此被记为「发过了」)。 */
  const db = freshDb('u_owner');
  const f = makeRoom({ ownerId: 'u_owner', db });
  const broken = f.db as MemoryDb;
  const realInsert = broken.insert.bind(broken);
  let breakNow = true;
  (broken as unknown as { insert: (t: string, r: Record<string, unknown>) => void }).insert = (table, row): void => {
    if (breakNow && table === 'room_players') throw new Error('注入:落库抛(入场中途失败)');
    realInsert(table, row);
  };

  const res = f.rt.join({ userId: 'u_owner' });
  eq(res.ok, false, '★ 落库抛 ⇒ 入场**失败**(不是「成功了但没人知道」)');
  eq(res.code, 'JOIN_FAILED', '走 JOIN_FAILED 通道');
  ok(String(res.reason).includes('已回滚'), `回执必须说出已回滚(实得:${String(res.reason)})`);
  ok(String(res.reason).includes('起始背包已撤回'), `★★ 回执必须点名撤回起始背包(实得:${String(res.reason)})`);

  eq(f.rt.authoritativeItemTotal('u_owner'), 0, '★★ 账里一件都不许留');
  eq(f.rt.authoritativeItemIds('u_owner'), [], '★★ 按件账也是空的');
  eq(f.rt.authoritativeItemCount('u_owner', AXE), 0, '★ 那件基础工具也不许留');
  eq(grantedIdsOf(f.rt).has('u_owner'), false, '★★ 幂等账也解掉了(否则同名重试永远拿不到包)');
  eq(f.rt.isSeated('u_owner'), false, '席位不残留');
  eq(lastReport(f.rt).rolledBack, true, '★ 回执如实标 rolledBack');

  /* 修好之后同名重试:这份包还是他的(撤回没有把发放资格吞掉)。 */
  breakNow = false;
  const retry = f.rt.join({ userId: 'u_owner' });
  eq(retry.ok, true, '★ 修好后重试成功');
  eq(f.rt.authoritativeItemTotal('u_owner'), 7, '★★ 重试拿到了完整的一份起始包');
  eq(lastReport(f.rt).verdict, 'GRANTED', '重试的回执是 GRANTED');
  eq(lastReport(f.rt).rolledBack, false, '这一次没有被撤回');
  eq(grantedIdsOf(f.rt).has('u_owner'), true, '幂等账重新记上');
});

/* ═════════════════ 7. RESET_WORLD:不重发(裁决) ═════════════════ */

test('FND155-8 ★ `RESET_WORLD` 之后**不**重发(裁决 + 三条理由写在用例里)', () => {
  /* ## 裁决:`RESET_WORLD` 之后**不重发**。三条理由
     ① 背包账是**玩家世代**数据:`rebuildWorld` 的契约明写「清世界世代、留玩家世代」
        (玩家 / 等级 / 档案 / 出生点全部保留,见 `world_sim.ts` 那段「清的与留的」)
        ⇒ 重置**根本没动**那份包,再发就是**静默翻倍**;
     ② 房间侧的 `itemCounts` / `inventoryTotals` 同样不在 `RESET_WORLD` 的通路上
        (那条路只做:换代睡眠登记 / 立刻落盘 / 世界内存重建)⇒ 判据只需要
        「已发过 / 账里已有东西」两条,不给重置开洞;
     ③ 「包花光了再要一份」是**补偿/经济**玩法,不是入场语义 —— 要做得有依据
        (明确的补给动作),不能借重置顺手发。

     变红条件:在 RESET_WORLD 成功时清空 `startingInventoryGranted`(或把发放挂进
     世界重建)⇒ 断言 4 红(7 件变 14),断言 8 也红。 */
  const f = makeRoom({ ownerId: 'u_owner' });
  f.rt.join({ userId: 'u_owner' });
  eq(f.rt.authoritativeItemTotal('u_owner'), 7, '前置:起始包在账里');
  const before = lastReport(f.rt);

  const reset = f.rt.dispatchAction('u_owner', RoomAction.RESET_WORLD, { confirm: true, seed: 4242 });
  eq(reset.ok, true, '前置:房主的重置成功(真 WorldSim 有 resetWorld)');

  eq(f.rt.authoritativeItemTotal('u_owner'), 7, '★★ 重置不重发:账仍是 7(14 会红)');
  eq(f.rt.lastStartingInventory, before, '★★ 连回执都不许被重写 —— 重置通路上没有「发放」这件事');
  eq(grantedIdsOf(f.rt).has('u_owner'), true, '★ 幂等账照旧记着(它不随世界换代清)');

  /* 重置之后**退房再进**:仍不发(两条守卫都还在),而且账没被重置清掉。 */
  f.rt.leave('u_owner');
  const re = f.rt.join({ userId: 'u_owner' });
  eq(re.ok, true, '前置:重置后重进成功');
  eq(f.rt.authoritativeItemTotal('u_owner'), 7, '★★ 重置后重进仍是 7 件');
  eq(lastReport(f.rt).verdict, 'SKIPPED', '★ 如实 SKIPPED');
});

/* ═════════════════ 8. 两条守卫各自独立 ═════════════════ */

test('FND155-9 ★ 两条守卫独立:库里已有东西的人不发(跨进程重复发放被收窄)', () => {
  /* 变红条件:删掉闸 2(权威账 > 0 ⇒ 不发)⇒ 断言 3/4/5 红。
     为什么用**已落盘**那一份而不是先塞房间账:`applyInventory` 要求这个人在反作弊里
     已登记(`ac.join` 是入场时做的)⇒ 入场**之前**唯一能造出「他手里已经有东西」这个
     事实的就是库基线(`ai_item_instances`)。而这正是闸 2 要守的**跨进程**形态:
     房间实例重启后「本房间发过谁」记不住,而库里那份还记着。 */
  const db = freshDb('u_owner');
  /* `ai_item_instances.owner_id → users.id` 是**真外键**(MemoryDb 会当场拒)⇒ 先开用户行。 */
  createUser(db, { id: 'u_a', displayName: 'B', nowMs: 1000 });
  addItemInstance(db, {
    instance_id: 'i155', owner_id: 'u_a', recipe_hash: null, slot: 'bag',
    quantity: 1, equipped: 0, stats_json: '{}', bound_room_id: null,
    created_at: 1000, updated_at: 1000,
  });
  const f = makeRoom({ ownerId: 'u_owner', db });
  eq(f.rt.authoritativeItemTotal('u_a'), 1, '前置:权威账 = 库基线那 1 件');

  f.rt.join({ userId: 'u_a' });
  const rep = lastReport(f.rt);
  eq(rep.verdict, 'SKIPPED', '★★ 账里已有东西 ⇒ 不发(与「本房间已发过」是**两条**独立守卫)');
  ok(String(rep.reason).includes('空手'), `理由点明「不是空手新玩家」(实得:${rep.reason})`);
  eq(f.rt.authoritativeItemTotal('u_a'), 1, '★ 账没被动:仍是原来那 1 件');
  eq(f.rt.authoritativeItemCount('u_a', LOG), 0, '★ 起始包一件都没进(按件账里没有 101)');
  eq(grantedIdsOf(f.rt).has('u_a'), false, '★ 没发过 ⇒ 幂等账不许记上(否则他以后永远拿不到)');
});

report('WS-FND-155');
