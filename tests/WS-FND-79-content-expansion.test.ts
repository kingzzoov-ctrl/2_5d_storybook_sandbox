/**
 * WS-FND-79 —— **内容表扩编(320 → 329)+ P-01 / P-02 / P-04** 四条线一次钉住。
 *
 * 本批改的是四件「手册写了、代码没表达」的事(见 `docs/CHANGE_REQUESTS.md` [CR-27]):
 *
 * ```
 * 1 内容表      牧场产出 2 件 + 手册 7 件抽象奖励 → 746~754(共 329 件)
 * 2 P-01        Boss 战利品要能带数量(手册 703×10 / 117×15),旧形态仍可读
 * 3 P-02        「任意染料」配方:166/167/168/169 任一都能合成 237 / 245
 * 4 P-04        gatherMul 的件数放大 = **按概率翻倍**(复用 dropDoubleChance 范式)
 * ```
 *
 * ## 判据结构(每条都带**负对照**:没有负对照的判据证明不了它拦得住什么)
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | FND79-1 | 9 件在表、ID 唯一、总数 329 | 7 件抽象奖励的名字必须逐个对上 ID(名字写错即红) |
 * | FND79-2 | 实测计数与 `scripts/items-baseline.json` 差 0 | 拿一份**假基线(320/10 表)**去比 ⇒ 必须报差 |
 * | FND79-3 | 内容指纹与 `content-lock` 基线一致 | `bosses` 分区指纹必须**未变**(证明 `loot` 没被动) |
 * | FND79-4 | 牧场的「毛团/温泉橘」按名字解析出 746/747 且 `dropped` 非空 | 亲和不够 ⇒ `produce` 必须是空的(不是"照样产出") |
 * | FND79-5 | 河狸 703=10 / 云鲸 117=15,其余 1 | 生产掉落里 `437`/`440` 仍被 `lootDeviations` 过滤 |
 * | FND79-6 | 旧形态 `number[]`+`lootQty` 可读 | 0 / 负数 / 非有限数一律归 1(不静默产出 0 件) |
 * | FND79-7 | 237/245 在 166/167/168/169 四色下都能合成(8 条) | 不放染料 ⇒ 必须 `ok:false` |
 * | FND79-8 | ——(纯负对照) | 留白槽**不放宽固有件**:244 用 167 仍然做不出来 |
 * | FND79-9 | 概率翻倍:1000 个 roll 下翻倍率 ≈ 20% | —— |
 * | FND79-10 | ——(纯负对照) | `gatherMul = 1`(中性)⇒ 同样的 1000 个 roll **一次都不翻** |
 * | FND79-11 | 生产处理器真的按乘子给 2 件,且翻倍集合与种子公式逐位一致 | `gatherMul = 1` 时 200 个玩家全部只给 1 件 |
 *
 * ## 期望值从哪来(不是"把被测模块的输出抄下来")
 *
 *   - 329 / 11 张表 / 3.11 区段 — 本批的**验收数字**(owner 裁 D-19:9 件 + §3.11 补录表);
 *   - `703×10` / `117×15` — **手册 L496 / L501 的字面量**;
 *   - 746~754 与 9 个名字 — `docs/WS-04-mob-ai.md:559`(毛团/温泉橘)+ 手册 L496/L500/L502
 *     的抽象奖励原文;
 *   - 染料的四个 ID(166/167/168/169)— 内容表 §3.2 的**全部**染料,逐个枚举而非抽查;
 *   - `gatherMul` 的 20% — 「+20% 采集速度」= 乘子 1.2 ⇒ 期望件数 1.2 ⇒ 翻倍概率 0.2。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  ITEM_BY_ID, ITEM_LIST, ITEM_TABLES, TOTAL_ITEM_COUNT, matchRecipeByTags,
} from '../shared/constants/items.ts';
import { MOB_BY_ID } from '../shared/constants/mobs.ts';
import { BOSS_BY_ID, bossLootEntries, normalizeBossLoot } from '../shared/constants/bosses.ts';
import { effectiveLoot, fnv1a, rollPersonalLoot, seededRoll } from '../server/src/bosses/raid.ts';
import { breakBlock, gatherCountFor, gatherDoubleChance } from '../server/src/net/actions/material.ts';
import { resolveItemByName, settleRanchDay } from '../server/src/systems/ranch.ts';
import { contentFingerprints } from '../server/src/content/registry.ts';
import { diffItemCounts, measureItemCounts, readItemBaseline } from '../scripts/items-baseline.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import type { RoomAction } from '../server/src/net/room.ts';
import type { RaidParticipant } from '../server/src/bosses/raid.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═════════════════ 1. 内容表扩编(320 → 329)═════════════════ */

/** 本批补录的 9 件:**名字 → ID** 逐个写死(名字写错/ID 挪位都会红)。 */
const APPENDED_EXPECT: readonly [number, string][] = [
  [746, '毛团'],
  [747, '温泉橘'],
  [748, '自动伐木机甲图纸'],
  [749, '姜饼人随从'],
  [750, '纯金通关纪念碑'],
  [751, '稀有甜点食谱'],
  [752, '蓬松彩羽'],
  [753, '稀有树种'],
  [754, '城堡图纸'],
];

test('FND79-1 内容表 329 件:9 件按名查到唯一 ID,且旧 320 件的 ID 一个没动', () => {
  eq(ITEM_LIST.length, 329, '本批扩容后的物品总数');
  eq(TOTAL_ITEM_COUNT, 329, 'TOTAL_ITEM_COUNT 必须与 ITEM_LIST 同步');

  /* 负对照的内建:ID 唯一(重复 ID 会让 ITEM_BY_ID 静默吞掉一件)。 */
  const ids = ITEM_LIST.map((i) => i.id);
  eq(new Set(ids).size, ids.length, 'ID 必须唯一');

  /* 名字 → ID 逐个对上(名字是牧场端 `resolveItemByName` 的**唯一**接口)。 */
  for (const [id, name] of APPENDED_EXPECT) {
    const def = ITEM_BY_ID.get(id);
    ok(def !== undefined, `#${id}(${name})必须在内容表里`);
    eq(def!.name, name, `#${id} 的名字`);
  }
  /* 复用一个 ID 挤掉旧物品是这类扩容最典型的翻车方式:抽查本批边界。 */
  eq(ITEM_BY_ID.get(745)?.name, '怪物生态诱捕笼', '745 仍是原物品');
  eq(ITEM_BY_ID.get(746)?.category, 'NATURAL', '746 毛团是自然产物(无配方)');
  eq(ITEM_BY_ID.get(746)?.recipe, undefined, '数值/配方待平衡 ⇒ 不写 recipe');

  /* 记账:§3.1~§3.10 的号段一个字不动,新增单独成 §3.11(746~754)。 */
  const t311 = ITEM_TABLES.find((t) => t.key === '3.11');
  ok(t311 !== undefined, '§3.11 补录表必须在 ITEM_TABLES 里');
  eq(t311!.count, 9, '§3.11 声明 9 项');
  eq(t311!.range, [746, 754], '§3.11 号段 746~754');
  eq(ITEM_TABLES.find((t) => t.key === '3.10')?.range, [701, 745], '§3.10 号段未被篡改');
  eq(ITEM_TABLES.find((t) => t.key === '3.10')?.count, 45, '§3.10 项数未被篡改');
});

/* ═════════════════ 2. 计数与基线 ═════════════════ */

test('FND79-2 计数与 items-baseline.json 差 0(负对照:假基线必须报差)', () => {
  const measured = measureItemCounts();
  eq(measured.itemCount, 329, '实测物品数');
  eq(measured.tableCount, 11, '实测分表数(§3.1~§3.10 + §3.11)');
  eq(measured.tableSum, 329, 'Σcount 必须等于物品总数');

  const baseline = readItemBaseline();
  ok(baseline !== null, '基线文件必须存在且可解析(缺失 ≠ 通过)');
  eq(diffItemCounts(baseline!, measured), [], '实测与基线必须差 0 处');

  /* 负对照:拿一份**本批之前**的基线(320 件 / 10 张表)去比 ⇒ 必须报差,
     否则说明 `diffItemCounts` 对"内容真的变了"不敏感,上面那条就是同义反复。 */
  const stale = {
    itemCount: 320, tableCount: 10, tableSum: 320,
    tables: { '3.1': { count: 30, ids: 30 }, '3.10': { count: 45, ids: 45 } },
  };
  const staleDiff = diffItemCounts(stale, measured);
  ok(staleDiff.length >= 3, `旧基线必须报出至少 3 处差,实际 ${staleDiff.length}:${staleDiff.join(' | ')}`);
  ok(staleDiff.some((d) => d.includes('物品总数')), '差值里必须点名「物品总数」');
});

/* ═════════════════ 3. 内容指纹与 content-lock 基线 ═════════════════ */

test('FND79-3 内容指纹与 content-lock 基线一致,且 bosses 分区未被本批改动', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'server/src/content/content.baseline.json'), 'utf8')) as {
    fingerprints: Record<string, unknown>;
    counts: Record<string, unknown>;
  };
  const f = contentFingerprints();
  eq(raw.fingerprints.version, f.version, '算法版本');
  eq(raw.fingerprints.items, f.items, 'items 分区指纹(本批扩容 ⇒ 已同步刷新)');
  eq(raw.fingerprints.mobs, f.mobs, 'mobs 分区指纹(本批不该动)');
  eq(raw.fingerprints.bosses, f.bosses, 'bosses 分区指纹(本批不该动)');
  eq(raw.fingerprints.modes, f.modes, 'modes 分区指纹(本批不该动)');
  eq(raw.fingerprints.overall, f.overall, 'overall 指纹');
  eq(raw.counts.items, 329, '基线记录的内容件数');

  /* ★ 负对照(结构性的):`loot` 是本批**唯一可能**让 bosses 分区漂移的字段。
     它必须仍是 e6bd03cc —— 谁把 746~754 塞进某个 Boss 的 `loot`,这条立刻红
     (那会同时撞红写域外的 `tests/WS-05` 冻结快照与 `WS-FND-01` A13)。 */
  eq(f.bosses, 'e6bd03cc', '8 个 Boss 的 loot 字节级未变(CR-16 的纪律延续到 CR-27)');
});

/* ═════════════════ 4. 牧场产出可解析 ═════════════════ */

test('FND79-4 牧场「毛团/温泉橘」现在能解析到 ID,日结产出非空(负对照:亲和不够则空)', () => {
  eq(resolveItemByName('毛团'), 746, '牧场端按名字查表:毛团');
  eq(resolveItemByName('温泉橘'), 747, '牧场端按名字查表:温泉橘');

  const sheep = MOB_BY_ID.get('mob_sheep');
  const capy = MOB_BY_ID.get('mob_capybara');
  ok(sheep?.tameItem !== undefined && capy?.tameItem !== undefined, '两种牧场动物的饲料必须是内容表条目');
  const feed = { [sheep!.tameItem!]: 5, [capy!.tameItem!]: 5 };

  const fed = settleRanchDay({
    days: 1,
    feed,
    animals: [
      { speciesId: 'mob_sheep', affinity: 1 },
      { speciesId: 'mob_capybara', affinity: 1 },
    ],
  });
  eq(fed.unresolved, [], '不得再有「内容表没有这件物品」的未解析产出');
  eq(fed.produce.map((p) => p.itemId).sort((a, b) => a! - b!),
    [746, 747], '★ 两件产出都拿到了真实 ID(加表之前这里是 [null, null])');
  for (const p of fed.produce) ok(p.count > 0, `产出件数应为正(${p.name})`);

  /* 负对照:亲和不足 ⇒ 不进食、**不产出**(不是"照样给毛团")。 */
  const cold = settleRanchDay({
    days: 1, feed,
    animals: [{ speciesId: 'mob_sheep', affinity: 0.1 }],
  });
  eq(cold.produce, [], '亲和未达标的动物不得产出');
});

/* ═════════════════ 5. P-01:Boss 战利品数量 ═════════════════ */

test('FND79-5 Boss 战利品数量按手册:703×10 / 117×15,其余 1;生产掉落真的按数量结算', () => {
  /* 手册 L496 / L501 的字面量。 */
  const beaver = bossLootEntries('boss_beaver_mecha');
  eq(beaver.find((e) => e.id === 703)?.count, 10, '河狸钢牙 703 必须 ×10');
  const whale = bossLootEntries('boss_sky_whale');
  eq(whale.find((e) => e.id === 117)?.count, 15, '极光星辰碎片 117 必须 ×15');

  /* 其余 Boss / 其余件:手册没注数量 ⇒ 1(填成 10 会红)。 */
  for (const b of ['boss_jelly_king', 'boss_ginger_troll', 'boss_chronos_colossus']) {
    for (const e of bossLootEntries(b)) eq(e.count, 1, `${b} 的 #${e.id} 应为 1 件`);
  }
  for (const def of [BOSS_BY_ID.get('boss_beaver_mecha')!, BOSS_BY_ID.get('boss_sky_whale')!]) {
    const qty = def.lootQty ?? [];
    eq(qty.length, def.loot.length, `${def.id} 的 lootQty 必须与 loot 逐位等长`);
  }

  /* 生产侧:`rollPersonalLoot` 的每一件都必须 ≥ 手册数量(光球条目按 lootQty 结算),
     且 `437` / `440`(手册里是可造载具,不是战利品)仍被过滤。 */
  const team: RaidParticipant[] = [
    { id: 'p1', contributed: true, damageDealt: 100, x: 0, y: 0 },
    { id: 'p2', contributed: true, damageDealt: 100, x: 0, y: 0 },
  ];
  const orb = rollPersonalLoot('boss_beaver_mecha', team)[0]!;
  const e703 = orb.entries.find((e) => e.itemId === 703);
  ok(e703 !== undefined, '河狸光球必含 703');
  ok(e703!.count >= 10, `703 的掉落数应 ≥ 手册的 10,实际 ${e703!.count}`);
  ok(!orb.entries.some((e) => e.itemId === 437), '437 是载具,不得当战利品发(L496 的偏离)');
  const eff = effectiveLoot(BOSS_BY_ID.get('boss_sky_whale')!);
  ok(!eff.out.includes(440), '440 被 lootDeviations 过滤');
  eq(eff.qty[eff.out.indexOf(117)], 15, '117 的生产数量口径也是手册数');
});

/* ═════════════════ 6. P-01:旧形态仍可读 ═════════════════ */

test('FND79-6 战利品读取同时接受旧 `number[]` 与新 `{id,count}[]`(非法数量归 1)', () => {
  /* 旧形态 + 逐位 lootQty。 */
  eq(normalizeBossLoot([703, 437], [10, 1]),
    [{ id: 703, count: 10 }, { id: 437, count: 1 }], '旧形态:逐位取 lootQty');
  /* 旧形态无 lootQty ⇒ 全 1(缺省不是 0)。 */
  eq(normalizeBossLoot([703, 437]), [{ id: 703, count: 1 }, { id: 437, count: 1 }], '旧形态缺省 1');
  /* 新形态:原样读 count。 */
  eq(normalizeBossLoot([{ id: 703, count: 10 }, { id: 117, count: 15 }]),
    [{ id: 703, count: 10 }, { id: 117, count: 15 }], '新形态原样读 count');
  /* 负对照:0 / 负数 / NaN / 小数 —— 「必掉」列写了就是至少 1 件,不许产出 0 件。 */
  eq(normalizeBossLoot([{ id: 703, count: 0 }, { id: 117, count: -3 }, { id: 745, count: Number.NaN }],
    [0, -3, Number.NaN]),
  [{ id: 703, count: 1 }, { id: 117, count: 1 }, { id: 745, count: 1 }], '非法数量一律归 1');
  eq(normalizeBossLoot(undefined), [], '没有战利品 ⇒ 空数组(不是 undefined)');
  /* 生产路径读的就是这一份归一结果。 */
  eq(BOSS_BY_ID.get('boss_sky_whale')!.loot, [117, 718, 440], '★ 冻结字段 loot 保持旧形态字节不变');
});

/* ═════════════════ 7/8. P-02:任意染料 ═════════════════ */

/** 四色染料 —— 内容表 §3.2 的**全部**染料(手册的「任意染料」就是这四件)。 */
const DYE_IDS: readonly number[] = [166, 167, 168, 169];

test('FND79-7 「任意染料」两条配方 × 四色染料:237 / 245 都能合成(负对照:不放染料则拒)', () => {
  for (const dye of DYE_IDS) {
    /* 237 七彩颜料水球 = 陶瓷空药水瓶×1 + 任意染料×1(手册 L178) */
    const r237 = matchRecipeByTags(237, { 165: 1, [dye]: 1 });
    eq(r237.ok, true, `237 用染料 #${dye} 应能合成(${r237.reason ?? 'ok'})`);
    eq(r237.consumed[dye], 1, `237 必须真的扣掉 #${dye} 一件`);
    /* 245 手持庆典烟花筒 = 翠玉青竹×1 + 爆裂火椒×1 + 染料×1(手册 L186) */
    const r245 = matchRecipeByTags(245, { 103: 1, 126: 1, [dye]: 1 });
    eq(r245.ok, true, `245 用染料 #${dye} 应能合成(${r245.reason ?? 'ok'})`);
    eq(r245.consumed[dye], 1, `245 必须真的扣掉 #${dye} 一件`);
  }
  /* 负对照 1:不放染料 ⇒ 拒(否则上面 8 条是"无脑放行")。 */
  eq(matchRecipeByTags(237, { 165: 1 }).ok, false, '不放染料时 237 必须拒');
  eq(matchRecipeByTags(245, { 103: 1, 126: 1 }).ok, false, '不放染料时 245 必须拒');
  /* 负对照 2:非染料不能顶替留白槽(209 染色枪不是染料)。 */
  eq(matchRecipeByTags(237, { 165: 1, 209: 1 }).ok, false, '非染料不得顶替「任意染料」槽');
  /* 负对照 3:数量不足(237 的留白槽只要 1 件,但 #356 要 2 件 —— 别把槽数当摆设)。 */
  eq(matchRecipeByTags(356, { 154: 1, 167: 1 }).ok, false, '356 要 2 个染料,给 1 个必须拒');
  eq(matchRecipeByTags(356, { 154: 1, 167: 2 }).ok, true, '356 给足 2 个应通过');
});

test('FND79-8 负对照:留白槽不放宽固有材料(244 仍专指 168,167 顶不上)', () => {
  eq(matchRecipeByTags(244, { 162: 3, 168: 1 }).ok, true, '244 用它的专指件 168 应通过');
  eq(matchRecipeByTags(244, { 162: 3, 167: 1 }).ok, false, '244 用 167 必须拒(CR-17 的边界)');
  eq(matchRecipeByTags(244, { 162: 3, 166: 1 }).ok, false, '244 用 166 也必须拒');
});

/* ═════════════════ 9/10/11. P-04:gatherMul 概率翻倍 ═════════════════ */

test('FND79-9 gatherMul 的件数放大 = 按概率翻倍(20% ⇒ 期望 1.2 件)', () => {
  /* 规则本身逐位钉住(边界是**严格小于**,与 raid.ts:409 的 `rng() < 0.35` 同口径)。 */
  eq(gatherCountFor(1.2, 0), 2, 'roll=0 ⇒ 必翻倍');
  eq(gatherCountFor(1.2, 0.199), 2, 'roll 小于门槛 ⇒ 翻倍');
  eq(gatherCountFor(1.2, 0.2), 1, 'roll 恰在门槛 ⇒ 不翻(严格小于)');
  eq(gatherCountFor(1.2, 0.999), 1, 'roll 大于门槛 ⇒ 不翻');
  ok(Math.abs(gatherDoubleChance(1.2) - 0.2) < 1e-9, '1.2 ⇒ 20%');
  eq(gatherDoubleChance(2), 1, '2.0 ⇒ 100%(上限夹住,不会溢出成 3 件)');
  eq(gatherCountFor(2, 0.999), 2, '100% 概率时也只翻到 2 件(不是按乘子直接乘)');

  /* 统计:1000 个种子化 roll 下,翻倍率必须落在 20% 附近(证明它是**概率**而非恒真/恒假)。 */
  let doubles = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (gatherCountFor(1.2, seededRoll(fnv1a(`fnd79|${i}`))()) === 2) doubles += 1;
  }
  ok(doubles >= 150 && doubles <= 250,
    `1000 次里翻倍次数应 ≈ 200(±50),实际 ${doubles}`);
});

test('FND79-10 负对照:gatherMul = 1(中性)一次都不翻倍', () => {
  eq(gatherDoubleChance(1), 0, '中性乘子 ⇒ 0 概率');
  eq(gatherCountFor(1, 0), 1, 'roll=0 也不翻(mul=1)');
  eq(gatherCountFor(1, 0.999999), 1, '任何 roll 都不翻');
  eq(gatherDoubleChance(0.5), 0, '低于 1 的乘子(非法)不得翻倍');
  eq(gatherDoubleChance(Number.NaN), 0, 'NaN 不得翻倍');
  let doubles = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (gatherCountFor(1, seededRoll(fnv1a(`fnd79|${i}`))()) === 2) doubles += 1;
  }
  eq(doubles, 0, '★ mul=1 时 1000 个 roll 全部只出 1 件');
});

/** 造一个只够 `material.breakBlock` 用的 ActionContext(其余成员不参与这条路径)。 */
function fakeBreakCtx(actorId: string, objId: number, gatherMul: number):
  { ctx: ActionContext; granted: number[] } {
  const granted: number[] = [];
  const ctx = {
    actorId,
    action: 'BREAK_BLOCK' as RoomAction,
    payload: { x: 12, y: 12 },
    state: { meta: { tick: 7 } },
    authorize: () => ({ allowed: true }),
    materialsOf: () => ({
      breakBlock: () => ({ ok: true, objId, gatherMul }),
      dropItem: () => { /* 背包收得下 ⇒ 这条路径不走到 */ },
    }),
    applyInventory: (_userId: string, input: { ops: readonly { delta: number }[] }) => {
      granted.push(input.ops[0]!.delta);
      return { allowed: true };
    },
    grantItemSource: () => { /* 凭证链不参与断言 */ },
  } as unknown as ActionContext;
  return { ctx, granted };
}

test('FND79-11 生产处理器按乘子发 2 件,翻倍集合与种子公式逐位一致(mul=1 全 1 件)', () => {
  const chance = gatherDoubleChance(1.2);
  const expectedDouble = new Set<string>();
  let actualDoubles = 0;

  for (let i = 0; i < 200; i += 1) {
    const actorId = `fnd79-p${i}`;
    const { ctx, granted } = fakeBreakCtx(actorId, 101, 1.2);
    const r = breakBlock(ctx);
    eq(r.ok, true, `拆块应成功(#${i})`);
    eq(granted.length, 1, '一次拆块只有一次背包写入');
    ok(granted[0] === 1 || granted[0] === 2, `件数只能是 1 或 2,实际 ${granted[0]}`);
    eq(r.effect!.gained, granted[0], '回执的 gained 报的是**实际件数**');

    /* 种子公式 = (actorId | x | y | objId | tick),与处理器实现同口径 —— 这条钉住接线。 */
    const roll = seededRoll(fnv1a(`${actorId}|12|12|101|7`))();
    if (roll < chance) { expectedDouble.add(actorId); actualDoubles += 1; }
    const expectCount = roll < chance ? 2 : 1;
    eq(granted[0], expectCount, `${actorId} 的件数应与种子 roll 一致(实际 roll=${roll})`);
  }
  ok(actualDoubles > 0 && actualDoubles < 200,
    `必须有翻倍也必须有未翻倍(实际 ${actualDoubles}/200)—— 否则这条判据分不出两分支`);

  /* 负对照:同一个拆块循环,mul=1 ⇒ 200 个玩家全部只拿 1 件,且回执不带 gatherMul 键。 */
  for (let i = 0; i < 200; i += 1) {
    const { ctx, granted } = fakeBreakCtx(`fnd79-p${i}`, 101, 1);
    const r = breakBlock(ctx);
    eq(granted[0], 1, `mul=1 时 ${i} 号玩家不得翻倍`);
    eq(r.effect!.gatherMul, undefined, '1 是中性值 ⇒ 回执里不该出现 gatherMul 键');
  }
});

report('WS-FND-79');
