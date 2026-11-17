/**
 * WS-FND-54 —— 滑溜料理的 `muOverride` 必须**相乘**在地板 μ 上(裁决 **D-12**)。
 *
 * ## 裁决原文(`docs/DECISIONS.md` D-12)
 * > 最终摩擦 = **地板 μ × `muOverride`**(0.96)⇒ 冰面更滑、湿地更黏,方向一致;**不覆盖**地板值
 *
 * ## 为什么这条判据必须存在
 *
 * 物理层原本只会从 `FLOOR_MU_BY_SLOT` 取地板 μ,没有任何"按刚体的摩擦修正"通道;
 * 于是滑溜料理的 `muOverride` 读得到、**没有消费者**(就是 WS-FND-49 说的那一族:
 * 字段存在、玩家感觉不到)。接线的方向有两条,结果完全不同:
 *
 * | 地板 | 地板 μ | 覆盖(0.96) | 相乘(×0.96) |
 * |---|---|---|---|
 * | 315 镜面极滑冰砖 | 0.98 | **0.96** ⇒ 冰上反而更涩 | **0.9408** ⇒ 更滑 |
 * | 316 紫泥减速沼泽砖 | 0.40 | **0.96** ⇒ 泥里反而更滑 | **0.384** ⇒ 更黏 |
 *
 * 覆盖会让同一份料理在两种地面上方向相反 ⇒ 必须是乘。本套件用**字面量**把
 * 0.9408 与 0.384 钉死:改成覆盖(0.96 / 0.96)或删掉乘子(0.98 / 0.40)都会红。
 *
 * ⚠️ 断言右侧一律**字面量**,不从被测模块取期望值(`FLOOR_MU_BY_SLOT` / `MU_MUL_NEUTRAL`
 * 都不 import —— 否则改数值时两侧一起动,断言永远绿)。
 * ⚠️ 每条"接了"的断言都配**负对照**(没设乘子的刚体逐位不变),否则
 * "改了但没生效"与"没改"分不开。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { PhysicsWorld, type PhysTerrain } from '../server/src/physics/world.ts';

/* FLOOR 层槽位(0~63)。1..30 → 地砖 301..330,故槽位 = 物品 ID - 300。 */
const SLOT_BARE = 0; /* 无铺装裸地,μ = 0.72 */
const SLOT_ICE = 15; /* 315 镜面极滑冰砖,μ = 0.98 */
const SLOT_MUD = 16; /* 316 紫泥减速沼泽砖,μ = 0.40 */

/** 单一地板种类的平地夹具(μ 只取决于槽位,与坐标无关)。 */
function flatSlot(slot: number): PhysTerrain {
  return {
    floorSlotAt: () => slot,
    objIdAt: () => 0,
    elevAt: () => 1,
    faceDirAt: () => 1,
  };
}

/**
 * 造一个只铺了 `slot` 的世界,并在 (8.5, 8.5) 放一个刚体。
 * 关掉 `hazards` / `pairwise`:本套件只测摩擦结算,别让机关与碰撞掺进读数。
 */
function worldOn(slot: number, ids: readonly string[] = ['p1']): PhysicsWorld {
  const w = new PhysicsWorld({ terrain: flatSlot(slot), hazards: false, pairwise: false });
  for (const id of ids) w.spawn(id, { x: 8.5, y: 8.5 });
  return w;
}

/** 一帧之后刚体上的 μ(`b.mu` 在 `stepBody` 里结算,不推进就没有新值)。 */
function muAfterStep(w: PhysicsWorld, id = 'p1'): number {
  w.step();
  return w.get(id)!.mu;
}

/* ══════════════════ 1 中性:逐位不变(接线不得改手感)══════════════════ */

test('FND54-1 ★ 无乘子(中性)⇒ `b.mu` 与改动前**逐位相同**', () => {
  /* 中性乘子的定义值就是 1;没设过的刚体读出来必须正好是 1。 */
  eq(worldOn(SLOT_ICE).muMulOf('p1'), 1, '★ 没设过 ⇒ 乘子是中性 1');

  /* 三个已知地板格,期望值直接写地板表的 μ 字面量(0.72 / 0.98 / 0.40)。 */
  eq(muAfterStep(worldOn(SLOT_BARE)), 0.72, '★ 裸地 0.72 逐位不变');
  eq(muAfterStep(worldOn(SLOT_ICE)), 0.98, '★ 冰面 0.98 逐位不变');
  eq(muAfterStep(worldOn(SLOT_MUD)), 0.4, '★ 湿地 0.40 逐位不变');
});

/* ══════════════════ 2 相乘:地板 μ × 乘子 ══════════════════ */

test('FND54-2 ★★ 设 0.96 ⇒ `b.mu` = 地板 μ × 0.96(冰 0.9408 / 泥 0.384)', () => {
  const ice = worldOn(SLOT_ICE);
  eq(ice.setMuMul('p1', 0.96), true, '前置:合法乘子应被接受');
  eq(ice.muMulOf('p1'), 0.96, '前置:乘子读回 0.96');
  /* 0.98 × 0.96 = 0.9408(裁决原文的算例:「冰面更滑」) */
  eq(muAfterStep(ice), 0.9408, '★★ 冰面必须是 0.9408(= 0.98 × 0.96)');
  ok(ice.get('p1')!.mu < 0.98, '★★ 冰面必须**更滑**(0.9408 < 0.98)');
  ok(ice.get('p1')!.mu !== 0.96, '★ 不得等于 0.96 —— 那个值只可能是"覆盖"');

  const mud = worldOn(SLOT_MUD);
  eq(mud.setMuMul('p1', 0.96), true, '前置:合法乘子应被接受');
  /* 0.40 × 0.96 = 0.384(裁决原文的算例:「湿地更黏」) */
  eq(muAfterStep(mud), 0.384, '★★ 湿地必须是 0.384(= 0.40 × 0.96)');
  ok(mud.get('p1')!.mu < 0.4, '★★ 湿地必须**更黏**(0.384 < 0.40)');
  ok(mud.get('p1')!.mu !== 0.96, '★ 不得等于 0.96 —— 覆盖会把湿地拉高到 0.96,方向反了');
});

/* ══════════════════ 3 非法乘子:拒绝且保持原值 ══════════════════ */

test('FND54-3 ★ `NaN` / `0` / `-1` / `Infinity` ⇒ 被拒且 `b.mu` 不变', () => {
  const w = worldOn(SLOT_ICE);
  w.setMuMul('p1', 0.96);
  eq(muAfterStep(w), 0.9408, '前置:先有一个 0.9408 的读数');

  eq(w.setMuMul('p1', Number.NaN), false, '★ NaN 必须被拒');
  eq(w.setMuMul('p1', 0), false, '★ 0 必须被拒(mu=0 ⇒ 每帧速度归零,刚体原地定住)');
  eq(w.setMuMul('p1', -1), false, '★ 负数必须被拒(每帧反向 ⇒ 指数飞走)');
  eq(w.setMuMul('p1', Number.POSITIVE_INFINITY), false, '★ Infinity 必须被拒');

  eq(w.muMulOf('p1'), 0.96, '★★ 四次非法输入后乘子仍是 0.96(不是被写成 0 或 NaN)');
  eq(muAfterStep(w), 0.9408, '★★ `b.mu` 保持原值(拒绝 ≠ 改成安全值)');

  /* 负对照:从没设过乘子的刚体收到非法输入 ⇒ 仍是纯地板值,不是 0。 */
  const fresh = worldOn(SLOT_ICE);
  eq(fresh.setMuMul('p1', Number.NaN), false, '★ 中性状态下 NaN 同样被拒');
  eq(fresh.muMulOf('p1'), 1, '★ 被拒 ⇒ 乘子仍是中性 1');
  eq(muAfterStep(fresh), 0.98, '★★ 非法输入不得把 μ 变成 0');
  ok(fresh.get('p1')!.mu > 0, '★ μ 必须保持为正(否则刚体再也不会减速)');
});

/* ══════════════════ 4 清回中性:恢复原值 ══════════════════ */

test('FND54-4 ★ 清回中性(1)⇒ 恢复地板原值(逐位)', () => {
  const w = worldOn(SLOT_ICE);
  w.setMuMul('p1', 0.96);
  eq(muAfterStep(w), 0.9408, '前置:先降到 0.9408');

  eq(w.setMuMul('p1', 1), true, '前置:设回中性应被接受');
  eq(w.muMulOf('p1'), 1, '★ 设回 1 ⇒ 读回 1');
  eq(muAfterStep(w), 0.98, '★★ 必须逐位恢复地板原值 0.98(滑溜 buff 到点)');

  /* `clearMuMul` 是同一件事的另一条路径,也得逐位恢复。 */
  w.setMuMul('p1', 0.5);
  eq(muAfterStep(w), 0.49, '前置:0.98 × 0.5 = 0.49');
  eq(w.clearMuMul('p1'), true, '前置:clearMuMul 应返回"确实删掉了记录"');
  eq(w.muMulOf('p1'), 1, '★ 清掉后乘子是中性 1');
  eq(muAfterStep(w), 0.98, '★ clearMuMul 同样逐位恢复 0.98');
});

/* ══════════════════ 5 负对照:按刚体隔离,邻居不受影响 ══════════════════ */

test('FND54-5 负对照:乘子按刚体隔离,没设乘子的邻居逐位不变', () => {
  const w = worldOn(SLOT_ICE, ['p1', 'p2']);
  eq(w.setMuMul('p1', 0.96), true, '前置:只给 p1 设乘子');

  const report1 = w.step();
  eq(report1.bodies, 2, '前置:两个刚体都在世界里');
  eq(w.get('p1')!.mu, 0.9408, '★ 设了的 p1 按乘子结算');
  eq(w.get('p2')!.mu, 0.98, '★★ 没设的 p2 逐位原值(负对照:默认值不掺和)');
  eq(w.muMulOf('p2'), 1, '★ p2 的乘子仍是中性 1');
});

/* ══════════════════ 6 乘子不跨"命"残留 ══════════════════ */

test('FND54-6 ★ 同 id 重生 / 清空世界 ⇒ 不继承上一条命的乘子', () => {
  const w = worldOn(SLOT_ICE);
  w.setMuMul('p1', 0.5);
  eq(w.remove('p1'), true, '前置:先移除刚体');
  w.spawn('p1', { x: 8.5, y: 8.5 });
  eq(w.muMulOf('p1'), 1, '★★ 重生 ⇒ 乘子回到中性(不是继承 0.5)');
  eq(muAfterStep(w), 0.98, '★★ 新刚体的 μ 是纯地板值');

  const w2 = worldOn(SLOT_MUD);
  w2.setMuMul('p1', 0.5);
  w2.clear();
  w2.spawn('p1', { x: 8.5, y: 8.5 });
  eq(w2.muMulOf('p1'), 1, '★ clear() 之后乘子表也空了');
  eq(muAfterStep(w2), 0.4, '★ 清空后重建的刚体 μ = 0.40(纯地板值)');
});

report('WS-FND-54');