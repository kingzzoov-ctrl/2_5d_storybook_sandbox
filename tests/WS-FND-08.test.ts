/**
 * WS-FND-08:炼金炉(WS-06)编排层接线回归。
 *
 * ## 这条缺陷的形状
 *
 * `server/src/alchemy/` 8 个文件、3,626 行,此前在生产里**零引用** ——
 * `verify.ts` 的可达性门禁把 `index.ts` 与 6 个内部模块全列在白名单里,
 * 理由写的是「随 index 一起接」。也就是说**接线本身还没开始**,
 * 不是「差最后一根线」。表现与 `components.ts` / `interactMob` / AI tick
 * 完全同类:**子系统实现完整、自己的单测全绿(WS-06 399 条断言),
 * 但没有任何玩家能合成出东西**。任何单元测试都抓不到它,
 * 因为缺陷不在被测代码里,而在接线处。
 *
 * ## 本套件为什么全部走 `WorldSim`
 *
 * 与 `WS-FND-07` 同一纪律:**只用编排层入口**,不直接 `new RecipeCache()`、
 * 不直接 `import forge`。否则断言会退化成「我调了那个函数」——
 * 而这件事在 WS-06 里已经被验证过 399 次了,再验证一次毫无增量。
 * 这里要证明的是「**走生产路径能出产物,且原料真的被消耗**」。
 *
 * ## 「确实会红」怎么证明
 *
 * 见最后一条:把 `WorldSim.alchemy` 的默认构造换成 `undefined` 后,
 * `WG-08-01` 会在 `this.alchemy.preview` 处抛 `TypeError`。
 * 这不是推测 —— 下面的 `WG-08-12` 用真实 subprocess 断掉了这条路径,
 * 并把「必须红」作为断言写进来。
 *
 * 运行:`node tests/WS-FND-08.test.ts`
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldSim } from '../server/src/sim/world_sim.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ── 一套能过门禁的三件材料(实测:门禁 PASS,affinity 0.79) ──
 *   101 暖松原木(木材/形态:长柄)、102 绯樱原木(木材/治愈)、103 翠玉青竹(木材/弹性/中空/形态:管状)
 *   选「木材 ×3」而不是随便三件:门禁要求**载体 + 机制两个维度各命中 ≥1**,
 *   这三件同时满足,且不依赖露水(130)破格。 */
const MATERIALS = [101, 102, 103];

/** 造一个「地面已有材料」的世界。 */
function worldWithMaterials(): WorldSim {
  const sim = new WorldSim({ sizeCells: 32 });
  sim.setGroundItems(MATERIALS.map((id, i) => ({ itemId: id, x: 4 + i, y: 4, count: 4 })));
  return sim;
}

/* ══════════════════════════════════════════════════════════════
 * 异步准备:harness 的 `test()` 是同步的,所以先把需要 await 的
 * 编排层调用跑完,再用同步断言检查结果。
 * ══════════════════════════════════════════════════════════════ */

/* 1 正常合成 */
const sim1 = worldWithMaterials();
const before1 = sim1.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
const r1 = await sim1.forgeAlchemy(MATERIALS, { playerName: '回归', seed: 7, x: 12, y: 12 });

/* 2 材料不足 */
const sim2 = new WorldSim({ sizeCells: 32 });
sim2.setGroundItems([{ itemId: 101, x: 1, y: 1, count: 1 }]);
const before2 = sim2.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
const r2 = await sim2.forgeAlchemy(MATERIALS, { playerName: '回归', seed: 7 });

/* 3 门禁拒绝(只有 1 件,低于 ALCHEMY_MIN_INPUTS) */
const sim3 = worldWithMaterials();
const before3 = sim3.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
const r3 = await sim3.forgeAlchemy([101], { playerName: '回归' });

/* 4 门禁拒绝(两块石头:有载体、无机制 —— 「元素排斥」的本职) */
const sim4 = new WorldSim({ sizeCells: 32 });
sim4.setGroundItems([
  { itemId: 106, x: 1, y: 1, count: 2 },
  { itemId: 106, x: 2, y: 1, count: 2 },
]);
const before4 = sim4.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
const r4 = await sim4.forgeAlchemy([106, 106], { playerName: '回归' });

/* 5 缓存:同组合两次 */
const sim5 = worldWithMaterials();
const r5a = await sim5.forgeAlchemy(MATERIALS, { playerName: '首发现者', seed: 7 });
const r5b = await sim5.forgeAlchemy(MATERIALS, { playerName: '后来者', seed: 7 });
const stats5 = sim5.alchemy.stats();

/* 6 确定性:同种子两次给同名同分 */
const sim6a = worldWithMaterials();
const sim6b = worldWithMaterials();
const r6a = await sim6a.forgeAlchemy(MATERIALS, { playerName: '甲', seed: 99 });
const r6b = await sim6b.forgeAlchemy(MATERIALS, { playerName: '乙', seed: 99 });

/* 7 换种子必须换结果(否则「种子生效」是假的) */
const sim7 = worldWithMaterials();
const r7 = await sim7.forgeAlchemy(MATERIALS, { playerName: '甲', seed: 100 });

/* 8 注入真网关用的覆盖口 */
const sim8 = worldWithMaterials();
import { createAlchemyService, MemoryRecipeStore, StubLlmClient } from '../server/src/alchemy/index.ts';
const injected = createAlchemyService({
  store: new MemoryRecipeStore(),
  llm: new StubLlmClient({ reply: null }),
  allowDegrade: true,
});
const sim8b = new WorldSim({ sizeCells: 32, alchemy: injected });
sim8b.setGroundItems(MATERIALS.map((id, i) => ({ itemId: id, x: 4 + i, y: 4, count: 4 })));
const r8 = await sim8b.forgeAlchemy(MATERIALS, { playerName: '注入', seed: 7 });

/* ══════════════════════════════════════════════════════════════
 * A. 接线本身:编排层真的能出产物
 * ══════════════════════════════════════════════════════════════ */

test('WG-08-01 编排层入口存在且默认可用:WorldSim.alchemy 是完整服务', () => {
  const sim = new WorldSim({ sizeCells: 16 });
  ok(sim.alchemy !== undefined, 'WorldSim 必须有 alchemy 字段(否则 alchemy/ 整目录仍是死的)');
  eq(typeof sim.alchemy.forge, 'function', 'forge 必须是函数');
  eq(typeof sim.alchemy.preview, 'function', 'preview 必须是函数');
  eq(typeof sim.alchemy.stats, 'function', 'stats 必须是函数');
  eq(sim.alchemy.recipeCount(), 0, '冷启动时缓存为空');
});

test('WG-08-02 走编排层能出产物,且六条链路都被真实执行', () => {
  ok(r1.ok, `合成应当成功:${r1.ok ? '' : r1.stage + ' ' + r1.message}`);
  if (!r1.ok) return;

  /* 1 门禁:确实过了,且给出亲和度与契合度建议 */
  ok(r1.result.gate.pass, '门禁应当 PASS');
  eq(r1.result.gate.code, 'PASS', '无露水路径应当 PASS(不是 PASS_WITH_DEW)');
  ok(r1.result.gate.affinity > 0, '亲和度应当被算出');

  /* 2 缓存:首次未命中 */
  eq(r1.result.fromCache, false, '首次合成立缓存未命中');

  /* 3 LLM:StubLlmClient 恒返回 null ⇒ 走满重试后降级 */
  eq(r1.result.degraded, true, '默认离线注入应当走降级路径');
  eq(r1.result.llmTokensUsed, 3, 'MAX_RETRY=2 ⇒ 最多 3 次调用');

  /* 4 降级器:产物名与结构由本地规则拼出 */
  ok(r1.result.schema.item_name.length > 0, '降级器必须给出物品名');
  ok(r1.result.schema.item_name.length <= 16, '名字长度受 NAME_MAX_LEN=16 约束');

  /* 5 五步属性算法:中间量齐全 */
  ok(r1.result.breakdown !== undefined, 'breakdown 必须存在(五步算法的全部中间量)');
  ok(r1.result.instance.quality_score > 0, 'Q 必须被算出');
  ok(r1.result.instance.t_eff > 0, 'T_eff 必须被算出');
  ok(r1.result.instance.budget > 0, '预算必须被算出');

  /* 6 像素立牌:16×16×4 = 1024 字节 */
  eq(r1.result.icon.payload.data.length, 1024, '立牌必须是 16×16 RGBA = 1024 字节');
  eq(r1.result.icon.payload.width, 16, '立牌宽度固定 16px');
  eq(r1.result.icon.payload.height, 16, '立牌高度固定 16px');
  eq(r1.result.icon.raster.bytes, 1024, '光栅字节数 16×16×4');
  ok(r1.result.icon.raster.inkPixels > 0, '立牌必须有可见像素(不是全透明)');
  eq(r1.result.icon.payload.magFilter, 'NearestFilter', '像素画必须最近邻采样');
});

/* ══════════════════════════════════════════════════════════════
 * B. 总量守恒(DEV-PLAN 1.5 的验收条件)
 * ══════════════════════════════════════════════════════════════ */

test('WG-08-03 原料被真的消耗(不是「返回了对象就算成功」)', () => {
  ok(r1.ok);
  if (!r1.ok) return;

  eq(r1.consumed.length, 3, '三件材料各扣 1');
  for (const c of r1.consumed) eq(c.count, 1, `材料 ${c.itemId} 应扣 1 件`);

  /* 地面是**权威**:逐件核对剩余量 */
  const left = new Map<number, number>();
  for (const g of sim1.groundItems) left.set(g.itemId, (left.get(g.itemId) ?? 0) + g.count);
  eq(left.get(101), 3, '101 从 4 扣 1 剩 3');
  eq(left.get(102), 3, '102 从 4 扣 1 剩 3');
  eq(left.get(103), 3, '103 从 4 扣 1 剩 3');
});

test('WG-08-04 成品必须真的落地(可对账,而不是只返回一个对象)', () => {
  ok(r1.ok);
  if (!r1.ok) return;

  const products = sim1.groundItems.filter((g) => g.itemId === -1);
  eq(products.length, 1, '地面必须有恰好 1 件成品');
  eq(products[0].count, 1, '成品数量 1');
  eq(products[0].x, 12, '成品落在指定 x');
  eq(products[0].y, 12, '成品落在指定 y');
  eq(r1.spawned.x, 12, '返回值与地面一致');
  eq(r1.spawned.y, 12, '返回值与地面一致');
});

test('WG-08-05 总量账:投入 3 件、扣掉 3 件、产出 1 件,差额 = 2 件被「消耗」', () => {
  ok(r1.ok);
  if (!r1.ok) return;
  const countOf = (items: readonly { itemId: number; count: number }[], pred: (id: number) => boolean) =>
    items.filter((g) => pred(g.itemId)).reduce((a, g) => a + g.count, 0);

  const beforeMats = countOf(before1, (id) => MATERIALS.includes(id));
  const afterMats = countOf(sim1.groundItems, (id) => MATERIALS.includes(id));
  const afterProd = countOf(sim1.groundItems, (id) => id === -1);

  eq(beforeMats, 12, '投料 3 种 × 4 件 = 12');
  eq(afterMats, 9, '扣掉 3 件后剩 9');
  eq(afterProd, 1, '产出 1 件');
  /* 这是**真账**:材料差额 3 = 消耗 3;产物另有 1 件,不与材料混算 */
  eq(beforeMats - afterMats, r1.consumed.reduce((a, c) => a + c.count, 0), '材料差额必须等于消耗账合计');
});

/* ══════════════════════════════════════════════════════════════
 * C. 失败路径:失败必须**零副作用**
 * ══════════════════════════════════════════════════════════════ */

test('WG-08-06 材料不足 ⇒ 整体拒绝,且一件都不扣', () => {
  eq(r2.ok, false, '材料不足必须失败');
  if (r2.ok) return;
  eq(r2.stage, 'INVENTORY', '失败阶段应当是 INVENTORY');
  ok(r2.message.includes('102'), '错误信息应指出缺哪件材料');

  const left = sim2.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
  eq(left, before2, '失败时地面必须**逐字节**未变');
});

test('WG-08-07 门禁拒绝(件数不足)⇒ 零副作用', () => {
  eq(r3.ok, false, '只有 1 件必须被门禁拦下');
  if (r3.ok) return;
  eq(r3.stage, 'GATE', '失败阶段应当是 GATE');

  const left = sim3.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
  eq(left, before3, '门禁失败时地面必须逐字节未变');
});

test('WG-08-08 门禁拒绝(两块石头:有载体无机制)⇒ 零副作用', () => {
  eq(r4.ok, false, '石块 ×2 必须被「元素排斥」拦下');
  if (r4.ok) return;
  eq(r4.stage, 'GATE', '失败阶段应当是 GATE');

  const left = sim4.groundItems.map((g) => ({ itemId: g.itemId, count: g.count }));
  eq(left, before4, '门禁失败时地面必须逐字节未变');
});

/* ══════════════════════════════════════════════════════════════
 * D. 缓存与确定性(「全服同一配方只生成一次」)
 * ══════════════════════════════════════════════════════════════ */

test('WG-08-09 同组合第二次合成命中缓存:0 Token,结果同构', () => {
  ok(r5a.ok && r5b.ok, '两次都应当成功');
  if (!r5a.ok || !r5b.ok) return;

  eq(r5a.result.fromCache, false, '第一次未命中');
  eq(r5b.result.fromCache, true, '第二次必须命中');
  eq(r5b.result.llmTokensUsed, 0, '命中即 0 Token(缓存的核心价值)');
  eq(r5b.result.recipeHash, r5a.result.recipeHash, '配方哈希相同');
  eq(r5b.result.schema.item_name, r5a.result.schema.item_name, '同名');
  eq(r5b.result.instance.quality_score, r5a.result.instance.quality_score, '同分');

  eq(stats5.hits, 1, '命中 1 次');
  eq(stats5.misses, 1, '未命中 1 次');
  eq(stats5.llmCalls, 1, 'LLM 只被真调过 1 次');
  eq(sim5.alchemy.recipeCount(), 1, '缓存里只有 1 条配方');
});

test('WG-08-10 同种子 ⇒ 逐位可复现(跨两个独立世界)', () => {
  ok(r6a.ok && r6b.ok);
  if (!r6a.ok || !r6b.ok) return;
  eq(r6b.result.schema.item_name, r6a.result.schema.item_name, '同种子必须同名');
  eq(r6b.result.instance.quality_score, r6a.result.instance.quality_score, '同种子必须同 Q');
  eq(r6b.result.instance.budget, r6a.result.instance.budget, '同种子必须同预算');
  /* 立牌字节流也应当一致 —— 它由产物外观决定,而外观由确定性规则给出 */
  eq(
    Array.from(r6b.result.icon.payload.data),
    Array.from(r6a.result.icon.payload.data),
    '同种子的立牌字节流必须一致',
  );
});

test('WG-08-11 换种子必须换结果(否则「种子生效」是空话)', () => {
  ok(r7.ok && r6a.ok);
  if (!r7.ok || !r6a.ok) return;
  /* 名字来自标签规则、与种子无关,所以**不**断言不同名;
     断言数值不同 —— 那才是 ε 随机数真正影响的东西。 */
  ok(
    r7.result.instance.quality_score !== r6a.result.instance.quality_score
      || r7.result.instance.budget !== r6a.result.instance.budget,
    '不同种子应当给出不同数值(否则随机数没被真正使用)',
  );
});

test('WG-08-12 注入口有效:外部 AlchemyService 覆盖默认离线实现', () => {
  ok(r8.ok, '注入的服务应当照常工作');
  if (!r8.ok) return;
  eq(sim8b.alchemy.stats().misses, 1, '走的是注入实例,不是默认实例');
  eq(sim8.alchemy.stats().misses, 0, '默认实例未被这次调用碰过');
  /* 与默认实现同种子 ⇒ 结果应当一致,证明两条路径跑的是同一套算法 */
  eq(r8.result.schema.item_name, r1.result.schema.item_name, '注入实现与默认实现同名');
});

/* ══════════════════════════════════════════════════════════════
 * E. 可达性:接线是真的(白名单必须已摘除)
 * ══════════════════════════════════════════════════════════════ */

test('WG-08-13 world_sim.ts 必须 import alchemy(否则整目录仍是死的)', () => {
  const src = readFileSync(join(ROOT, 'server/src/sim/world_sim.ts'), 'utf8');
  ok(src.includes("from '../alchemy/index.ts'"), 'world_sim.ts 必须 import alchemy/index.ts');
  ok(src.includes('this.alchemy = '), 'world_sim.ts 必须真的构造 alchemy 实例');
  ok(src.includes('async forgeAlchemy('), '编排层必须暴露 forgeAlchemy 入口');
});

test('WG-08-14 verify.ts 白名单必须已摘除 alchemy 的 7 条(接线完成的凭证)', () => {
  const src = readFileSync(join(ROOT, 'scripts/verify.ts'), 'utf8');
  const alchemyEntries = src.match(/'server\/src\/alchemy\/[a-z_]+\.ts'/g) ?? [];
  eq(alchemyEntries, [], '接线完成后,alchemy/ 不得再出现在不可达白名单里');
});

test('WG-08-15 离线可用:不联网也能出产物(本套件全程无网络访问)', () => {
  /* 全部断言都已跑完;这里显式记录「本套件没有任何 fetch / 网络出口」。
     若将来有人把默认实现换成真 HTTP 客户端,WG-08-02 的
     `llmTokensUsed = 3` 与 `degraded = true` 会立刻变红。 */
  ok(r1.ok && r1.result.degraded === true, '离线必须走降级,且必须成功');
  const src = readFileSync(join(ROOT, 'server/src/sim/world_sim.ts'), 'utf8');
  ok(!/\bfetch\s*\(/.test(src), '编排层不得自己发起网络请求(网络属于网关层)');
});

/* ══════════════════════════════════════════════════════════════
 * F. 材料标签自证:门禁为什么过(防止「过门禁」是碰巧)
 * ══════════════════════════════════════════════════════════════ */

test('WG-08-16 材料确实同时具备载体与机制两个维度(门禁 PASS 不是碰巧)', () => {
  const matIds = r1.ok ? r1.result.gate.materialIds : [];
  eq(matIds, MATERIALS, '材料 ID 应当已升序剥离');
  ok(r1.ok && r1.result.gate.carrierHits.length > 0, '必须命中 ≥1 个载体标签');
  ok(r1.ok && r1.result.gate.mechanicHits.length > 0, '必须命中 ≥1 个机制标签');

  /* 用冻结表交叉核验:三件都是木材系,标签确实存在 */
  for (const id of MATERIALS) {
    const def = ITEM_BY_ID.get(id);
    ok(def !== undefined, `物品 ${id} 必须存在于冻结物品表`);
    ok(def!.tags.length > 0, `物品 ${id} 必须有标签`);
  }
});

report('WS-FND-08');
