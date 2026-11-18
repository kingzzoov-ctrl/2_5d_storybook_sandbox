/**
 * WS-FND-91 —— **战斗四道门 / 重置上限 / 购买幂等**的判据(owner 裁定的四件事)。
 *
 * ## 本套件钉什么
 *
 * | 判据 | 钉的是 | 修前的实测症状 |
 * | :--- | :--- | :--- |
 * | FND91-1/2 | 玩家→生物**加视线闸** | 隔墙砍怪照掉血(只有 PvP / 生物→玩家有视线) |
 * | FND91-3/4 | 攻击侧封 **STUNNED / TRAPPED** | 被冻住 / 被泡泡装起来**仍能挥刀** |
 * | FND91-5/6 | PvP 攻击侧同一封条 | 同上(玩家→玩家那条路) |
 * | FND91-7 | `resetWorld` **按等级重算上限** | 5 级玩家重置后上限被抓回构造缺省 100 |
 * | FND91-8/9/10 | `purchaseCommit` 幂等键 + 实测库存 | 重放同一提交会**再扣一次库存** |
 *
 * ## 断言纪律
 *
 * 右侧一律是**字面量**(`160` / `100` / `704` / `4` / `1`),不取被测模块的导出常量
 * ——期望值取自被测模块就是同义反复(`--strict-taut`)。每条判据都带**负对照**
 * (该生效的那一侧也断言),否则「恒拒」/「恒真」也能过。
 *
 * ## 每条断言都能变红
 *
 * 本文件是**判据**,不是执行记录:注入证据(改坏 ⇒ 红 ⇒ 原始字节写回 ⇒ SHA256 一致)
 * 记在交付报告里。
 *
 * ⚠️ 价格表:内容表(`ITEM_LIST`)今天**一条 `price` 都没写** ⇒ 缺省的
 * `purchaseQuote/Commit` 恒 `UNPRICED`(那是刻意的「照实无定价」)。所以购买类判据
 * 显式喂一张**手写**价格表(`PRICE`),它只是转发 `depot.buy` 既有的 `table` 入参,
 * 不发明价格。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';

/* ═════════════════════ 夹具 ═════════════════════ */

type Scene = { sim: WorldSim };

/**
 * 玩家→生物的战斗场景:玩家 p1 在 (12.5, 8.5),生物在 (10.5, 8.5)。
 * 平面距离 = 2.0 格 < 裸装 reach(1.8 + 容差 1.5 = 3.3)⇒ **无墙必中**。
 */
function mobScene(): Scene {
  const sim = new WorldSim({ sizeCells: 32, mobs: true, rng: mulberry32(7), combatRng: () => 0.5 });
  sim.addPlayer('p1', 12.5, 8.5);
  sim.addMob('mob_sheep#1', 'MEADOW', 10.5, 8.5);
  return { sim };
}

/** PvP 场景:p1 (8, 8)、p2 (9.5, 8),开关打开。 */
function pvpScene(): Scene {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 8, 8);
  sim.addPlayer('p2', 9.5, 8);
  sim.setPvp(true);
  return { sim };
}

/** 手写价格表(内容表无价;见文件头)。 */
const PRICE = { 704: 30 } as const;

/** 用**世界侧**的 227 泡泡枪连中 3 发把活人困住(不是直接改字段)。 */
function trap(sim: WorldSim, id: string): void {
  for (let i = 0; i < 3; i += 1) sim.useItem('p1', { itemId: 227, targetId: id });
}

/* ═════════════════════ 1. 玩家→生物:视线闸 ═════════════════════ */

test('FND91-1 ★★ 玩家→生物:隔墙 ⇒ LOS_BLOCKED,且生物一点血都不掉', () => {
  const { sim } = mobScene();
  const mob0 = sim.mobHost.runtimeOf('mob_sheep#1')!.hp;
  /* 在玩家(x=12.5)与生物(x=10.5)之间砌一格墙 (11,8)—— supercover DDA 必经过它。 */
  sim.setCell(11, 8, { obj: 351 });
  const out = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  /* 怎么变红:删掉 `attackMobAuthorized` 里的 `losBlocked` 那段 ⇒ rejected 变 null、hit 非 null。 */
  eq(out.rejected, 'LOS_BLOCKED', '★ 拒绝理由必须指认视线(可判定,不是读人类字符串)');
  eq(out.hit, null, '★ 被视线挡下 ⇒ 不产生结算结果');
  eq(out.outcome, 'OUT_OF_AOI', '未结算仍走既有 outcome(机器外契约不动)');
  eq(sim.mobHost.runtimeOf('mob_sheep#1')!.hp, mob0, '★★ 生物 HP 原封不动');
});

test('FND91-2 ★★ 负对照:同距离、拆掉墙 ⇒ 打得中(否则 FND91-1 是恒真的)', () => {
  const { sim } = mobScene();
  const mob0 = sim.mobHost.runtimeOf('mob_sheep#1')!.hp;
  const open = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  /* 怎么变红:把视线闸写成「恒挡」⇒ 第 1 条红。 */
  eq(open.rejected, null, '★ 无墙 ⇒ 不拒');
  ok(open.hit !== null, '前置:结算结果存在');
  ok(open.hit!.hpLoss > 0, '★★ 无墙 ⇒ 同一距离真的打出伤害(不是"碰巧打不动")');
  eq(sim.mobHost.runtimeOf('mob_sheep#1')!.hp, mob0 - open.hit!.hpLoss, '★ 生物血量按 hpLoss 真的被扣');
});

/* ═════════════════════ 2. 玩家→生物:STUNNED / TRAPPED ═════════════════════ */

test('FND91-3 ★★ 攻击侧封 STUNNED:被定身的玩家砍不中生物;解除后能砍中', () => {
  const { sim } = mobScene();
  const mob0 = sim.mobHost.runtimeOf('mob_sheep#1')!.hp;
  sim.vitals.applyStun('p1', 3);
  eq(sim.vitals.stunOf('p1') > 0, true, '前置:真的被定住');
  const locked = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  /* 怎么变红:删掉攻击侧的 `stunOf` 闸 ⇒ rejected 变 null、生物掉血。 */
  eq(locked.rejected, 'STUNNED', '★ 定身期间攻击必须被拒(与移动侧同一拒因名)');
  eq(locked.hit, null, '★ 不产生结算');
  eq(sim.mobHost.runtimeOf('mob_sheep#1')!.hp, mob0, '★★ 生物没掉血');
  /* 负对照:定身清除(复活)后同一攻击必须打得中。 */
  sim.vitals.revive('p1');
  eq(sim.vitals.stunOf('p1'), 0, '前置:定身已清');
  const free = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  eq(free.rejected, null, '★ 未定身 ⇒ 不再拒(否则闸是恒拒的)');
  ok(free.hit !== null && free.hit.hpLoss > 0, '★ 真的打出伤害');
});

test('FND91-4 ★★ 攻击侧封 TRAPPED:被泡泡困住的玩家砍不中生物;别的玩家照打', () => {
  const { sim } = mobScene();
  const mob0 = sim.mobHost.runtimeOf('mob_sheep#1')!.hp;
  trap(sim, 'p1');
  eq(sim.liveBubbleOf('p1').trapSec > 0, true, '前置:真的被困住(世界侧状态机)');
  const out = sim.attackMobAuthorized('p1', 'mob_sheep#1');
  /* 怎么变红:删掉攻击侧的 `isTrapped` 闸 ⇒ rejected 变 null、生物掉血。 */
  eq(out.rejected, 'TRAPPED', '★ 被困期间攻击必须被拒');
  eq(out.hit, null, '★ 不产生结算');
  eq(sim.mobHost.runtimeOf('mob_sheep#1')!.hp, mob0, '★★ 生物没掉血');
  /* 负对照:同一世界里一个**没被困**的玩家 p2 打同一只生物 ⇒ 打中。 */
  sim.addPlayer('p2', 12.5, 8.5);
  const free = sim.attackMobAuthorized('p2', 'mob_sheep#1');
  eq(free.rejected, null, '★ 没被困 ⇒ 不拒(封的是攻击者,不是"这只生物免疫")');
  ok(free.hit !== null && free.hit.hpLoss > 0, '★ p2 真的打出伤害');
});

/* ═════════════════════ 3. PvP:STUNNED / TRAPPED ═════════════════════ */

test('FND91-5 ★★ PvP 攻击侧封 STUNNED:被定身的攻击者被拒,目标零变化', () => {
  const { sim } = pvpScene();
  const hp0 = sim.vitals.get('p2')!.hp;
  sim.vitals.applyStun('p1', 3);
  const out = sim.attackPlayerAuthorized('p1', 'p2');
  /* 怎么变红:删掉 `attackPlayerAuthorized` 里的 `stunOf` 闸 ⇒ rejected 变 null、p2 掉血。 */
  eq(out.rejected, 'STUNNED', '★ 定身期间 PvP 也必须被拒');
  eq(out.applied, 0, '★ 零伤害');
  eq(sim.vitals.get('p2')!.hp, hp0, '★★ 目标血量不变');
  /* 负对照:清除定身 ⇒ 同一攻击真的结算(applied > 0)。 */
  sim.vitals.revive('p1');
  const free = sim.attackPlayerAuthorized('p1', 'p2');
  eq(free.rejected, null, '★ 未定身 ⇒ 放行');
  ok(free.applied > 0, '★ 伤害落地');
});

test('FND91-6 ★★ PvP 攻击侧封 TRAPPED:被困的人打不出刀,但**受击方**照常挨打', () => {
  const { sim } = pvpScene();
  const hp2 = sim.vitals.get('p2')!.hp;
  trap(sim, 'p1');
  const out = sim.attackPlayerAuthorized('p1', 'p2');
  /* 怎么变红:删掉 `isTrapped` 闸 ⇒ rejected 变 null、p2 掉血。 */
  eq(out.rejected, 'TRAPPED', '★ 被困期间 PvP 也必须被拒');
  eq(out.applied, 0, '★ 零伤害');
  eq(sim.vitals.get('p2')!.hp, hp2, '★★ 目标血量不变');
  /* 负对照:换一个**没被困**的攻击者 p2 打被困的 p1 ⇒ 真的结算
     (封的是攻击者;被困 ≠ 免伤,那是另一条规则)。 */
  const hp1 = sim.vitals.get('p1')!.hp;
  const mirror = sim.attackPlayerAuthorized('p2', 'p1');
  eq(mirror.rejected, null, '★ 受击方被困不影响攻击者');
  ok(mirror.applied > 0, '★ p1 真的挨打');
  eq(sim.vitals.get('p1')!.hp, hp1 - mirror.applied, '★ 扣血与 applied 一致');
});

/* ═════════════════════ 4. resetWorld 按等级重算上限 ═════════════════════ */

test('FND91-7 ★★ resetWorld 按等级重算上限:5 级玩家重置后是 160/160,不是 100/100', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.addPlayer('p1', 8, 8);
  sim.progressOf('p1').level = 5;
  eq(sim.levelOf('p1'), 5, '前置:等级档案是 5');
  eq(sim.vitals.get('p1')!.maxHp, 100, '前置:注册时上限还是构造缺省(未推等级)');
  const r = sim.resetWorld({ seed: 4242 });
  eq(r.applied, true, '重置生效');
  eq(sim.levelOf('p1'), 5, '★ 等级跨世代保留(它是玩家的,不是世界世代的)');
  /* 怎么变红:删掉 `rebuildWorld` 里 `maxHpForLevel + syncMaxHp + revive` 三行 ⇒ 上限/血量都回到 100。 */
  eq(sim.vitals.get('p1')!.maxHp, 160, '★★ 上限按等级重算(100 + 15 × 4)');
  eq(sim.vitals.get('p1')!.hp, 160, '★★ 满血 = 该等级的上限(不是 100)');
  eq(sim.vitals.get('p1')!.downed, false, '非倒地');
  /* 负对照:1 级玩家重置后仍是 100/100(等级 1 ⇒ 派生值就是 100)。 */
  const low = new WorldSim({ sizeCells: 24, mobs: false });
  low.addPlayer('p2', 8, 8);
  low.resetWorld({ seed: 606 });
  eq(low.vitals.get('p2')!.maxHp, 100, '负对照:1 级 ⇒ 100');
  eq(low.vitals.get('p2')!.hp, 100, '负对照:1 级满血 100');
  /* 边界:升级后重置也要跟着抬(不是\"只有 5 级那一档对\")。 */
  const lv9 = new WorldSim({ sizeCells: 24, mobs: false });
  lv9.addPlayer('p3', 8, 8);
  lv9.progressOf('p3').level = 9;
  lv9.resetWorld({ seed: 707 });
  eq(lv9.vitals.get('p3')!.maxHp, 220, '★ 9 级 ⇒ 100 + 15 × 8 = 220');
  eq(lv9.vitals.get('p3')!.hp, 220, '★ 满血 = 220');
});

/* ═════════════════════ 5. purchaseCommit 幂等键 + 实测库存 ═════════════════════ */

test('FND91-8 ★★ purchaseCommit 幂等键(订单号):同一键第二次被拒且库存不变', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.setStallStock({ 704: 5 });
  const first = sim.purchaseCommit(704, 1, { actorId: 'p1', orderId: 'ORDER-1', table: PRICE });
  eq(first.ok, true, '前置:第一次成交');
  eq(first.replayed, false, '第一次不是重放');
  eq(first.stockOfItem, 4, '前置:库存 5 → 4');
  /* 怎么变红:删掉 `committedPurchaseKeys` 的重放检查 ⇒ 第二次也会成交(库存 4 → 3)。 */
  const again = sim.purchaseCommit(704, 1, { actorId: 'p1', orderId: 'ORDER-1', table: PRICE });
  eq(again.ok, false, '★★ 同一个键的第二次必须被拒');
  eq(again.replayed, true, '★★ 拒因是\"重放\"(可判定,不靠读字符串)');
  eq(again.cost, 0, '重放不产生成本');
  eq(again.stockOfItem, 4, '★★ 库存一位都没动');
  eq(sim.stallStockOf(), { 704: 4 }, '★★ 世界侧库存快照也没动');
  /* 负对照:换一个订单号 ⇒ 是另一笔,照常成交。 */
  const other = sim.purchaseCommit(704, 1, { actorId: 'p1', orderId: 'ORDER-2', table: PRICE });
  eq(other.ok, true, '负对照:不同订单号 = 不同键');
  eq(other.stockOfItem, 3, '负对照:库存 4 → 3');
});

test('FND91-9 ★★ 幂等键退化形态(actorId+摊位+帧):同帧重放被拒;换人不撞键', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.setStallStock({ 704: 5 });
  const a = sim.purchaseCommit(704, 1, { actorId: 'p1', table: PRICE });
  eq(a.ok, true, '前置:第一次成交');
  eq(a.stockOfItem, 4, '前置:库存 5 → 4');
  const replay = sim.purchaseCommit(704, 1, { actorId: 'p1', table: PRICE });
  /* 怎么变红:键里去掉 `actorId` 或 `frameCount` 的重放检查 ⇒ 第二次成交(库存 3)。 */
  eq(replay.ok, false, '★ 同一帧、同人、同摊位 ⇒ 同键 ⇒ 第二次拒');
  eq(replay.replayed, true, '★ 拒因是重放');
  eq(replay.stockOfItem, 4, '★ 库存不变');
  /* 负对照:另一个玩家(不同 actorId)在同一帧买同一件 ⇒ 不同键,照常成交。 */
  const other = sim.purchaseCommit(704, 1, { actorId: 'p2', table: PRICE });
  eq(other.ok, true, '负对照:换人不撞键');
  eq(other.stockOfItem, 3, '负对照:库存 4 → 3');
});

test('FND91-10 ★★ 提交返回的是**提交时**的实测库存,不是报价的旧快照', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  sim.setStallStock({ 704: 5 });
  const quote = sim.purchaseQuote(704, 2, PRICE);
  eq(quote.ok, true, '前置:报价成立');
  eq(quote.stock[704], 3, '前置:报价快照说买完会剩 3');
  /* 报价之后、提交之前,世界又卖掉了 1 件 ⇒ 报价那张快照**已经过期**。 */
  const consume = sim.purchaseCommit(704, 1, { actorId: 'p1', orderId: 'X', table: PRICE });
  eq(consume.ok, true, '前置:另一笔先成交');
  eq(consume.stockOfItem, 4, '前置:库存 5 → 4');
  const commit = sim.purchaseCommit(704, 2, { orderId: 'Y', table: PRICE });
  eq(commit.ok, true, '前置:这笔成交');
  /* 怎么变红:让成功分支返回**提交前**的库存(如复用报价快照)⇒ 这里会是 4,不是 2。 */
  eq(commit.stockOfItem, 2, '★★ 实测:4 − 2 = 2');
  ok(commit.stockOfItem !== quote.stock[704], '★★ 与报价旧值(3)分叉 —— 返回值取自提交那一刻');
  eq(commit.stock, { 704: 2 }, '★ 快照与实测同源');
  /* 负对照:不传价格表 ⇒ 内容表无价 ⇒ 拒,且库存不变(缺省语义一字未改)。 */
  const unpriced = sim.purchaseCommit(704, 1, { orderId: 'Z' });
  eq(unpriced.ok, false, '负对照:缺省价格表无定价 ⇒ 拒');
  eq(unpriced.stockOfItem, 2, '负对照:库存不变');
});

report('WS-FND-91-combat-gates');
