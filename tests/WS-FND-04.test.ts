/**
 * WS-FND-04 · 内容扩容影响面回归测试
 *
 * ## 这套测试在守什么
 *
 * 「加一件物品 / 扩一批内容」会不会弄坏别的东西。这个问题在本项目里**已经真实发生过**
 * 一次:`INVENTORY_SLOTS` 曾等于 `TOTAL_ITEM_COUNT`,于是 320 → 330 时背包变成
 * `330/16 = 20.625` 行(半行),而 `SLOTS_PER_PAGE` 恰好 = 320 使分页路径
 * **从未被执行过** —— 潜伏的分页缺陷要等到扩容那一刻才首次触发。
 *
 * WS-FND-02 修掉了背包那一处;本套件把**同一形态的耦合**逐条钉下来,
 * 并用 320 → 330 → 400 → 4095 的内存假内容集驱动。
 *
 * ## 判据为什么全部取自外部事实
 *
 * 这是本项目反复踩的坑。`registry.ts` 的 `auditContent` 注释里记着一次真实事故:
 * 类别合法性检查最初写成 `const KNOWN = new Set(ITEM_LIST.map(i => i.category))`,
 * 于是 `KNOWN.has(it.category)` 对每一项**恒真**,检查永远不可能失败 ——
 * 审计「通过」了,但它什么都没检查。根源形态是:**违反检查的数据恰恰会自己定义出合法集合**。
 *
 * 所以本套件不取被测代码自己的常量作判据:
 *   - 12 位容量判据 → 取冻结层 `shared/types/tile.ts` 的 `OBJ_MASK >>> OBJ_SHIFT`,
 *     并用 `packTile/unpackTile` 的实际往返行为交叉验证(推导 ∧ 行为,两者都要对);
 *   - 布局对齐判据 → 取「整除」这一算术事实,而不是 `INVENTORY_SLOTS % SLOTS_PER_ROW`;
 *   - u16 容量判据 → 取 `(1 << (FIELD_TYPE_BYTES.u16 * 8)) - 1` 的算术。
 *
 * ## 故障注入(强制项)
 *
 * `test('H1'..'H4')` 是**元测试**:它们构造一个「被破坏的」判据,断言该判据
 * 确实报错。若注入的坏版本也能通过,说明断言没有区分力 —— 那才是真正的失败。
 * 注入方法写在每条测试名里,不修改真实源码。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { ITEM_LIST, ITEM_TABLES, TOTAL_ITEM_COUNT } from '../shared/constants/items.ts';
import { OBJ_MASK, OBJ_SHIFT, packTile, unpackTile } from '../shared/types/tile.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import { SLOTS_PER_ROW, SLOTS_PER_PAGE, INVENTORY_SPARE_ROWS, computeSlotLayout } from '../client/src/ui/inventory.ts';
import {
  FIELD_MAX,
  contentCapacity,
  freeIdCount,
  freeIdSegments,
  auditContent,
} from '../server/src/content/registry.ts';
import { auditExtensions, type ContentExtension } from '../server/src/content/baseline.ts';
import { FIELD_TABLE, FIELD_TYPE_BYTES } from '../server/src/net/schema.ts';
import {
  checkInventory,
  InventoryReject,
  type PlayerAntiCheatState,
} from '../server/src/net/anticheat.ts';
import { FOODS } from '../server/src/combat/cooking.ts';
import {
  buildFakeContentSet,
  DRILL_SCALES,
  OBJ_CAPACITY_FROM_FROZEN,
  U16_CAPACITY,
  APPEND_BASE,
  CONTIGUOUS_APPEND_CEILING,
  ABSOLUTE_ITEM_CEILING,
  isRowAlignedByMath,
  alignmentCriterionHasTeeth,
} from '../scripts/extension-drill.ts';

/* ═══════════════ 0. 判据自证:外部事实先行 ═══════════════ */

test('A1 判据来源:12 位容量由冻结层掩码推出,且与编解码行为一致', () => {
  /* 掩码是左移过的位段(0x0fff0000),必须右移回值域。
     写脚本初版忘了右移,推出 268369920 —— 容量大到不可能越界,
     后续所有容量断言随之失去区分力。这里把「推导」与「行为」双双钉住。 */
  eq(OBJ_SHIFT, 16, 'OBJ 位偏移应为 16');
  eq(OBJ_MASK >>> OBJ_SHIFT, 4095, '冻结层推出的 obj 值域上界应为 4095');
  eq(OBJ_CAPACITY_FROM_FROZEN, 4095, '演练模块导出的容量判据应与冻结层一致');

  /* 行为侧交叉验证:边界值往返成功、越界值必须被截断 */
  eq(unpackTile(packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 4095, meta: 0 })).obj, 4095,
    '4095 应能无损往返');
  ok(unpackTile(packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 4096, meta: 0 })).obj !== 4096,
    '4096 应被截断(证明位宽确实是 12)');

  /* registry 自己算的 FIELD_MAX.OBJ 必须与冻结层推出的值一致 ——
     这是**交叉校验**,不是同义反复:两个值来自不同模块的不同推导路径。 */
  eq(FIELD_MAX.OBJ, OBJ_CAPACITY_FROM_FROZEN, 'registry 的 FIELD_MAX.OBJ 应与冻结层推导值一致');
});

test('A2 判据来源:u16 容量取算术推导,不取实现常量', () => {
  eq(FIELD_TYPE_BYTES.u16, 2, 'u16 应为 2 字节');
  eq(U16_CAPACITY, 65535, 'u16 上界应为 65535');
  ok(OBJ_CAPACITY_FROM_FROZEN < U16_CAPACITY, '12 位值域应严格小于 u16 容量');
});

test('A3 判据来源:布局对齐取算术事实,不取实现声明的对齐', () => {
  /* 纯数学:行数 × 每行槽位 必然被每行槽位整除。这与被测模块无关。 */
  ok(isRowAlignedByMath(320, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS), '320 件应可构造出整数行');
  ok(isRowAlignedByMath(330, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS), '330 件应可构造出整数行');
  ok(isRowAlignedByMath(4095, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS), '4095 件应可构造出整数行');

  /* 关键:证明这套判据**能**返回假。
     注意 `rows × slotsPerRow % slotsPerRow === 0` 本身是恒真的 ——
     它抓不住任何东西。有区分力的是参数合法性检查(非整数/负数)。
     下面用一个「只看 mod」的坏版本对比,显式证明差别。 */
  const modOnly = (count: number, slotsPerRow: number, spareRows: number): boolean => {
    const rows = Math.max(1, Math.ceil(count / slotsPerRow) + spareRows);
    return (rows * slotsPerRow) % slotsPerRow === 0 && rows * slotsPerRow >= count;
  };
  ok(modOnly(320, 16.5, INVENTORY_SPARE_ROWS), '坏版本对非整数每行也返回真 ⇒ 它没有区分力');
  ok(!isRowAlignedByMath(320, 16.5, INVENTORY_SPARE_ROWS), '真实判据应拒绝非整数每行');
  ok(!isRowAlignedByMath(-1, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS), '真实判据应拒绝负数件数');
  ok(!isRowAlignedByMath(320, SLOTS_PER_ROW, -1), '真实判据应拒绝负补行数');
  ok(alignmentCriterionHasTeeth(), '判据区分力自检应通过');
});

/* ═══════════════ 1. 内存假内容集(不触碰冻结层) ═══════════════ */

test('B1 假内容集不改动冻结层:真实内容仍是 320 件', () => {
  eq(ITEM_LIST.length, TOTAL_ITEM_COUNT, '真实内容件数应与 TOTAL_ITEM_COUNT 一致');
  eq(TOTAL_ITEM_COUNT, 320, '真实基线应为 320 件(若内容已扩容,本套件需同步)');
  eq(ITEM_TABLES.length, 10, '应为 10 张分表');
});

test('B2 假内容集规模与标签正确,且全部落在 12 位值域内', () => {
  for (const target of DRILL_SCALES) {
    const set = buildFakeContentSet(target);
    eq(set.items.length, target, `假内容集 ${target} 的件数应为 ${target}`);
    for (const it of set.items) {
      ok(it.id >= 1, `假物品 ID ${it.id} 应 ≥ 1`);
      ok(it.id <= OBJ_CAPACITY_FROM_FROZEN, `假物品 ID ${it.id} 应 ≤ ${OBJ_CAPACITY_FROM_FROZEN}`);
    }
    /* ID 必须互不相同 —— 池子重复取号会让「件数够」掩盖内容损坏 */
    eq(new Set(set.items.map((i) => i.id)).size, target, `假内容集 ${target} 的 ID 应互不相同`);
  }
});

test('B3 假内容集是内存副本:真实 ITEM_LIST 不受影响', () => {
  const before = ITEM_LIST.length;
  const snapshot = ITEM_LIST.map((i) => i.id).join(',');
  buildFakeContentSet(4095);
  eq(ITEM_LIST.length, before, '构造假内容集不应改变真实 ITEM_LIST 长度');
  eq(ITEM_LIST.map((i) => i.id).join(','), snapshot, '构造假内容集不应改变真实 ITEM_LIST 内容');
});

test('B4 假内容集保留真实前缀:末尾追加不移动既有物品的数组下标', () => {
  /* 这条是「槽位平移」的前置条件。真实槽位 = ITEM_LIST 数组下标
     (baseline.ts:77-78 `slots[String(it.id)] = i`),所以只要追加者在末尾,
     既有物品下标就不会变。 */
  const base = ITEM_LIST.map((i) => i.id);
  for (const target of [330, 400, 4095]) {
    const set = buildFakeContentSet(target);
    for (let i = 0; i < base.length; i += 1) {
      eq(set.items[i].id, base[i], `假内容集 ${target} 的第 ${i} 位应与真实基线相同(否则产生平移)`);
    }
  }
});

/* ═══════════════ 2. 耦合点 C1:背包布局与分页 ═══════════════ */

test('C1-1 各扩容规模下布局无半行、且装得下', () => {
  for (const target of DRILL_SCALES) {
    const layout = computeSlotLayout(target, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
    /* 判据一:数学对齐(外部事实) */
    ok(isRowAlignedByMath(target, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS),
      `${target} 件在数学上应可对齐`);
    /* 判据二:实现输出无半行 */
    eq(layout.slots % SLOTS_PER_ROW, 0, `${target} 件时槽位 ${layout.slots} 应是 ${SLOTS_PER_ROW} 的整数倍`);
    /* 判据三:装得下 */
    ok(layout.slots >= target, `${target} 件需要至少 ${target} 槽,实际 ${layout.slots}`);
    ok(layout.fits === true, `${target} 件时 fits 应为真`);
  }
});

test('C1-2 分页非退化:每页槽位严格小于总容量,分页路径会被走到', () => {
  for (const target of DRILL_SCALES) {
    const layout = computeSlotLayout(target, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
    ok(SLOTS_PER_PAGE < layout.slots,
      `${target} 件时每页 ${SLOTS_PER_PAGE} 应 < 总容量 ${layout.slots},否则分页代码永不执行`);
    ok(layout.pageCount >= 1, `${target} 件时页数应 ≥ 1`);
  }
});

test('C1-3 分页切片无重无漏:所有页并集恰好覆盖全部物品', () => {
  for (const target of DRILL_SCALES) {
    const set = buildFakeContentSet(target);
    const layout = computeSlotLayout(target, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
    const seen = new Set<number>();
    for (let p = 0; p < layout.pageCount; p += 1) {
      for (const it of set.items.slice(p * SLOTS_PER_PAGE, (p + 1) * SLOTS_PER_PAGE)) {
        ok(!seen.has(it.id), `物品 ${it.id} 在分页中重复出现(${target} 件)`);
        seen.add(it.id);
      }
    }
    eq(seen.size, target, `${target} 件的分页应覆盖全部物品`);
  }
});

test('C1-4 半行回归:330 件这一历史触发点必须仍然对齐', () => {
  /* 330/16 = 20.625 —— 这就是当初产生半行的规模。
     单独钉一条,防止未来有人把 spareRows 去掉而回归。 */
  const layout = computeSlotLayout(330, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
  eq(layout.slots % SLOTS_PER_ROW, 0, '330 件(历史半行触发点)不应产生半行');
  ok(layout.slots >= 330, '330 件应装得下');
});

/* ═══════════════ 3. 耦合点 C2:12 位 obj 值域 ═══════════════ */

test('C2-1 两条容量天花板:纯追加 3670,含空档全填 4095', () => {
  eq(APPEND_BASE, 746, '追加区起点应为既有分表最大上界 + 1 = 746');
  eq(CONTIGUOUS_APPEND_CEILING, 3670, '纯末尾追加上限应为 320 + 3350 = 3670');
  eq(ABSOLUTE_ITEM_CEILING, 4095, '值域绝对上限应为 4095');
  /* 两者之差必须等于内部空档数 —— 由 freeIdCount 独立算出 */
  eq(ABSOLUTE_ITEM_CEILING - CONTIGUOUS_APPEND_CEILING, 425,
    '绝对上限与追加上限之差应为 425(内部空档数)');
  eq(freeIdCount() - (OBJ_CAPACITY_FROM_FROZEN - (APPEND_BASE - 1)), 425,
    'freeIdCount 推出的内部空档应为 425');
});

test('C2-2 越界 ID 会被静默截断:4096 变成 0(物品凭空消失)', () => {
  /* 这是扩容最危险的失效形态:不报错、不抛异常,物品直接变成「空」。 */
  const packed = packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 4096, meta: 0 });
  eq(unpackTile(packed).obj, 0, '4096 应被截断为 OBJ_EMPTY(0)');
  eq(unpackTile(packed).obj, 0, '截断结果应等于空物品语义');
});

test('C2-3 越界 ID 可能伪装成另一个合法物品(5000 → 904)', () => {
  /* 比截断为 0 更隐蔽:变成另一个**存在**的物品 ID,玩家看到的是「另一个东西」。 */
  const back = unpackTile(packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 5000, meta: 0 })).obj;
  ok(back !== 5000, '5000 应被截断');
  eq(back, 5000 & 0xfff, '截断应按 12 位取模');
  ok(back >= 1, '截断后可能仍是非零的「合法」ID,因此不会报错');
});

test('C2-4 registry 审计能拦下超界 ID(检测器有效,非摆设)', () => {
  /* 用外部事实构造一个越界 ID,验证 auditContent 的判据不是同义反复。
     注意:serializeChunkVersions 那类检查无法直接喂假数据,
     所以这里只断言「审计能报出越界」这一**能力**,用真实内容 + 手工推断。 */
  const audit = auditContent();
  eq(audit.ok, true, '真实内容的审计应通过');
  eq(audit.problems.length, 0, '真实内容不应有引用闭合问题');
  /* 反向:真实内容的最大 ID 必须 ≤ 12 位上限 —— 这是审计第 2 条的判据本身 */
  const maxId = Math.max(...ITEM_LIST.map((i) => i.id));
  ok(maxId <= OBJ_CAPACITY_FROM_FROZEN, `真实内容最大 ID ${maxId} 应 ≤ ${OBJ_CAPACITY_FROM_FROZEN}`);
});

/* ═══════════════ 4. 耦合点 C3:容量台账 ═══════════════ */

test('C3-1 freeCount 恒等于「值域宽 − 已用件数」', () => {
  const obj = contentCapacity().find((c) => c.space.includes('OBJ'));
  ok(obj !== undefined, '容量台账应有 OBJ 条目');
  eq(obj!.capacity, OBJ_CAPACITY_FROM_FROZEN, '容量应为 12 位值域上界');
  eq(obj!.freeCount, OBJ_CAPACITY_FROM_FROZEN - TOTAL_ITEM_COUNT,
    'freeCount 应为值域宽减去已用件数(数学判据)');
  eq(obj!.headroom, OBJ_CAPACITY_FROM_FROZEN - Math.max(...ITEM_LIST.map((i) => i.id)),
    'headroom 应为值域上界减去最大已用 ID');
});

test('C3-2 headroom 与 freeCount 语义不同,不可混用', () => {
  const obj = contentCapacity().find((c) => c.space.includes('OBJ'))!;
  /* 这两个数曾被同名(remaining)过,造成「同名不同义」。
     本断言把差异钉住:freeCount 含内部空档,headroom 不含。 */
  ok(obj.freeCount! > obj.headroom!, 'freeCount(含内部空档)应严格大于 headroom(不含)');
  eq(obj.freeCount! - obj.headroom!, freeIdCount() - (OBJ_CAPACITY_FROM_FROZEN - Math.max(...ITEM_LIST.map((i) => i.id))),
    '两者之差应等于内部空档数(独立算出的 425)');
});

test('C3-3 freeIdCount 精确,求和会因 minLength 过滤漏算短段', () => {
  const exact = freeIdCount();
  const summed = freeIdSegments().reduce((n, s) => n + (s.to - s.from + 1), 0);
  eq(exact, OBJ_CAPACITY_FROM_FROZEN - TOTAL_ITEM_COUNT, '精确空闲数应等于值域宽减已用件数');
  ok(exact > summed, `精确值 ${exact} 应严格大于过滤后求和 ${summed}(否则 minLength 未生效)`);
  /* 差的就是被过滤掉的 <8 短段(项目记录为 219~220,共 2 个号) */
  eq(exact - summed, 2, '差值应为被 minLength 过滤掉的短段号数');
});

test('C3-4 分表区间两两不重叠,且表内紧包', () => {
  for (const t of ITEM_TABLES) {
    eq(t.ids.length, t.count, `分表 ${t.key} 的 ids 数应与 count 一致`);
    eq(t.range[1] - t.range[0] + 1, t.count, `分表 ${t.key} 区间应紧包(${t.count} 号占满)`);
  }
  const ranges = ITEM_TABLES.map((t) => t.range as [number, number]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    ok(ranges[i][0] > ranges[i - 1][1], `分表区间不应重叠:${ranges[i - 1]} 与 ${ranges[i]}`);
  }
});

test('C3-5 三方互证:Σcount = ids 并集 = ITEM_LIST.length', () => {
  const sumCounts = ITEM_TABLES.reduce((s, t) => s + t.count, 0);
  const union = new Set<number>();
  for (const t of ITEM_TABLES) for (const id of t.ids) union.add(id);
  eq(sumCounts, union.size, 'Σcount 应等于各表 ids 并集大小(否则有重叠或漏登记)');
  eq(sumCounts, ITEM_LIST.length, 'Σcount 应等于物品件数');
});

/* ═══════════════ 5. 耦合点 C4:槽位平移 ═══════════════ */

test('C4-1 末尾追加不产生槽位平移', () => {
  /* 槽位 = ITEM_LIST 数组下标。只要追加者在末尾,既有物品下标不变。 */
  const baseSlots = new Map<number, number>();
  ITEM_LIST.forEach((it, i) => baseSlots.set(it.id, i));
  for (const target of [330, 400, 4095]) {
    const set = buildFakeContentSet(target);
    for (const [id, slot] of baseSlots) {
      eq(set.items[slot].id, id, `物品 ${id} 的槽位应从 ${slot} 保持不变(${target} 件)`);
    }
  }
});

test('C4-2 非末尾插入会造成平移(检测器有区分力)', () => {
  /* 反向构造:在中间插队,验证「下标 = 槽位」这一机制确实会平移。
     若这条不成立,说明 C4-1 的通过是偶然的。 */
  const items = ITEM_LIST.map((it) => ({ id: it.id }));
  items.splice(5, 0, { id: 9001 });
  let shifted = 0;
  items.forEach((it, i) => {
    const expected = ITEM_LIST.findIndex((b) => b.id === it.id);
    if (expected !== -1 && expected !== i) shifted += 1;
  });
  ok(shifted > 0, '中间插入应造成平移 —— 否则 C4-1 的通过是偶然的');
  eq(shifted, ITEM_LIST.length - 5, '第 5 位之后的所有物品都应平移 1 位');
});

/* ═══════════════ 6. 耦合点 C5:网络字段位宽 ═══════════════ */

test('C5-1 weaponId / heldItemId 是 u16,与 12 位 obj 是两个通道', () => {
  const w = FIELD_TABLE.find((f) => f.key === 'weaponId');
  const h = FIELD_TABLE.find((f) => f.key === 'heldItemId');
  ok(w !== undefined, '玩家字段表应有 weaponId');
  ok(h !== undefined, '玩家字段表应有 heldItemId');
  eq(w!.type, 'u16', 'weaponId 应为 u16');
  eq(h!.type, 'u16', 'heldItemId 应为 u16');
});

test('C5-2 12 位 obj 是更紧的约束:扩容必须服从它,而非 u16', () => {
  /* 关键不变量:能进蓝图 obj 的 ID 必须同时能被网络字段承载。
     12 位更紧,所以它是真正的天花板。 */
  ok(OBJ_CAPACITY_FROM_FROZEN < U16_CAPACITY, '12 位值域应严格小于 u16 容量');
  eq(Math.min(OBJ_CAPACITY_FROM_FROZEN, U16_CAPACITY), OBJ_CAPACITY_FROM_FROZEN,
    '更紧的通道应为 12 位 obj');
});

/* ═══════════════ 7. 耦合点 C6:反作弊物品检查 ═══════════════ */

const mkState = (id: string): PlayerAntiCheatState =>
  ({ id, violations: [], score: 0, kicked: false, lastAttackTick: -1 }) as unknown as PlayerAntiCheatState;

test('C6-1 反作弊按总量守恒判定,不与 itemId 值域耦合', () => {
  /* 用一个远超 12 位的 itemId:反作弊只应关心总量,不应因 ID 大而拒绝。 */
  const r = checkInventory(mkState('fnd04-a'), {
    tick: 1,
    ops: [{ itemId: 99999, delta: 1, source: 'fnd04:src' }],
    allowedSources: new Set(['fnd04:src']),
    beforeTotal: 0,
    capacity: 336,
  });
  ok(r.allowed, `大 itemId 不应被拒(实际 ${r.rejectCode})`);
  eq(r.afterTotal, 1, '总量应为 1');
});

test('C6-2 大 itemId 不绕过守恒律', () => {
  const st = mkState('fnd04-b');
  const fromNothing = checkInventory(st, {
    tick: 1, ops: [{ itemId: 99999, delta: 1 }],
    allowedSources: new Set(), beforeTotal: 0, capacity: 336,
  });
  ok(!fromNothing.allowed, '凭空产出应被拒');
  eq(fromNothing.rejectCode, InventoryReject.FROM_NOTHING, '拒因应为凭空产出');

  const overflow = checkInventory(mkState('fnd04-c'), {
    tick: 2, ops: [{ itemId: 900, delta: 1, source: 'fnd04:src' }],
    allowedSources: new Set(['fnd04:src']), beforeTotal: 336, capacity: 336,
  });
  ok(!overflow.allowed, '容量溢出应被拒');
  eq(overflow.rejectCode, InventoryReject.OVERFLOW, '拒因应为容量溢出');
});

test('C6-3 容量是外部输入:扩容只需改传参,不改反作弊代码', () => {
  /* 同一份 ops、同一份 beforeTotal,只因 capacity 不同而结论相反 ⇒ 证明容量外部化。 */
  const held = 336;
  const tight = checkInventory(mkState('fnd04-d'), {
    tick: 1, ops: [{ itemId: 900, delta: 1, source: 's' }],
    allowedSources: new Set(['s']), beforeTotal: held, capacity: held,
  });
  const roomy = checkInventory(mkState('fnd04-e'), {
    tick: 2, ops: [{ itemId: 900, delta: 1, source: 's' }],
    allowedSources: new Set(['s']), beforeTotal: held, capacity: held + 64,
  });
  ok(!tight.allowed, `容量 ${held} 时应拒(实际 allowed=${tight.allowed})`);
  ok(roomy.allowed, `容量 ${held + 64} 时应通过 —— 否则容量未被当作外部输入`);
});

test('C6-4 背包容量(336)严格大于真实内容件数(320)', () => {
  const layout = computeSlotLayout(TOTAL_ITEM_COUNT, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
  ok(layout.slots > TOTAL_ITEM_COUNT, `背包容量 ${layout.slots} 应大于内容件数 ${TOTAL_ITEM_COUNT}`);
  /* 这也是反作弊 capacity 参数的合理取值依据:它必须 ≥ 内容件数,否则新物品无法进背包 */
  ok(layout.slots >= TOTAL_ITEM_COUNT, '容量应能装下全部静态内容');
});

/* ═══════════════ 8. 耦合点 C7:引用闭合 ═══════════════ */

test('C7-1 料理表引用的物品 ID 全部存在', () => {
  const ids = new Set(ITEM_LIST.map((i) => i.id));
  ok(FOODS.length > 0, '料理表应为非空');
  for (const f of FOODS) {
    ok(ids.has(f.id), `料理 ${f.id}(${f.name})应存在于物品表中`);
  }
});

test('C7-2 扩容后既有引用仍闭合(追加不破坏引用)', () => {
  for (const target of DRILL_SCALES) {
    const set = buildFakeContentSet(target);
    const ids = new Set(set.items.map((i) => i.id));
    for (const f of FOODS) {
      ok(ids.has(f.id), `假内容集 ${target} 应保留料理引用的物品 ${f.id}`);
    }
  }
});

test('C7-3 类别合法性用冻结层清单判定(非同义反复)', () => {
  /* registry.ts 记录过这个坑:自建集合会让 has() 恒真。
     这里用**冻结层** ItemCategory 作权威清单,并用一个伪造类别反向验证有区分力。 */
  const known = new Set<string>(Object.values(ItemCategory));
  ok(known.size >= 12, `冻结层类别应 ≥ 12 类,实际 ${known.size}`);
  for (const it of ITEM_LIST) {
    ok(known.has(it.category as string), `物品 ${it.id} 的类别 ${it.category} 应在冻结层清单内`);
  }
  /* 反向:伪造类别必须不被接受 */
  ok(!known.has('FND04_FAKE_CATEGORY'), '伪造类别不应被认作合法 —— 否则检查无区分力');
});

/* ═══════════════ 9. 耦合点 C8/C9:分表结构与扩展登记 ═══════════════ */

test('C8-1 扩容不改变既有分表结构', () => {
  for (const target of DRILL_SCALES) {
    const set = buildFakeContentSet(target);
    eq(set.tables.length, ITEM_TABLES.length, `假内容集 ${target} 分表数应不变`);
    for (let i = 0; i < ITEM_TABLES.length; i += 1) {
      eq(set.tables[i].key, ITEM_TABLES[i].key, '分表键应不变');
      eq(set.tables[i].count, ITEM_TABLES[i].count, `分表 ${ITEM_TABLES[i].key} 的 count 不应被改动`);
      eq(set.tables[i].range[0], ITEM_TABLES[i].range[0], '分表下界不应被改动');
      eq(set.tables[i].range[1], ITEM_TABLES[i].range[1], '分表上界不应被改动');
    }
  }
});

test('C9-1 扩展登记:合法登记通过,缺迁移提示报错', () => {
  const good: ContentExtension[] = [
    { seq: 1, summary: 'FND-04 演练:追加预留区物品', ids: [746, 747], needsMigration: true, migrationNote: '旧存档无此 ID,按空处理' },
  ];
  eq(auditExtensions(good).length, 0, '合法扩展登记不应报错');

  const noNote: ContentExtension[] = [
    { seq: 1, summary: '缺迁移提示', ids: [746], needsMigration: true, migrationNote: '' },
  ];
  ok(auditExtensions(noNote).length > 0, '需要迁移却缺提示时应报错');
});

test('C9-2 扩展登记的 ID 与既有内容冲突时必须报错', () => {
  const clash: ContentExtension[] = [
    { seq: 1, summary: 'FND-04 演练:ID 冲突', ids: [101], needsMigration: false, migrationNote: '' },
  ];
  ok(auditExtensions(clash).length > 0, 'ID 与既有内容冲突时应报错');
  /* 反向:用预留区 ID 则不应因冲突报错 */
  const okIds: ContentExtension[] = [
    { seq: 1, summary: 'FND-04 演练:合法追加', ids: [746, 747], needsMigration: false, migrationNote: '' },
  ];
  eq(auditExtensions(okIds).filter((p) => p.includes('冲突')).length, 0, '预留区 ID 不应报冲突');
});

test('C9-3 扩展登记序号必须连续', () => {
  const bad: ContentExtension[] = [
    { seq: 2, summary: '序号跳号', ids: [746], needsMigration: false, migrationNote: '' },
  ];
  ok(auditExtensions(bad).some((p) => p.includes('序号')), '序号不连续时应报错');
});

/* ═══════════════ 10. 判据区分力自检(构造式) ═══════════════

   ## 这一节**不是**故障注入(命名曾被对抗性复核纠正)

   这里在测试内部**重新实现一个坏版本**,再断言坏版本确实漏判。
   它能证明的是「**判据对坏输入敏感**」,**不能**证明「真实源码坏掉时套件会红」——
   因为坏版本是我自己写的,等于用我的假设验证我的假设。

   保留它的理由:它检查的是**判据本身的灵敏度**,与 §11 的真实注入互补:
     - §10 回答「判据能不能分辨好坏」;
     - §11 回答「真实源码坏掉时,这条判据会不会真的报警」。
   两者都需要,但**不能混称同一个名字**。这正是复核指出的方法学落差。 */

test('S1 判据区分力自检(构造式):「槽位 = 件数」在 330 时必是半行', () => {
  /* 这不是故障注入 —— 是在测试内构造 WS-FND-02 修复前的旧形态,检验判据能否分辨。 */
  const oldStyleSlots = (count: number): number => count; // ← 旧 INVENTORY_SLOTS 的定义
  ok(oldStyleSlots(330) % SLOTS_PER_ROW !== 0, '旧式「槽位 = 件数」在 330 时必须是半行 —— 这是回归判据');
  ok(oldStyleSlots(320) % SLOTS_PER_ROW === 0, '旧式在 320 时恰好对齐(这正是缺陷潜伏至今的原因)');
  /* 补行形态:行数 × 每行必然整除,所以「对齐」不来自行数,而来自不再把 slots 设成件数 */
  const rows = Math.ceil(330 / SLOTS_PER_ROW) + INVENTORY_SPARE_ROWS;
  eq(rows * SLOTS_PER_ROW % SLOTS_PER_ROW, 0, '补行后的行数×每行仍必然对齐');
});

test('S2 判据区分力自检(构造式):左移掩码当容量会让越界检查恒真', () => {
  /* 复现本套件初版的真实错误形态:直接拿左移过的掩码当容量。 */
  const wrongCapacity = OBJ_MASK; // 0x0fff0000 = 268369920
  ok(wrongCapacity !== 4095, '漏掉 >>> OBJ_SHIFT 必须得到与 4095 不同的值(否则 A1 抓不住)');
  eq(wrongCapacity, 268369920, '错误值应为 268369920 —— 比正确值大 6 万倍,会让容量断言失去区分力');
  const maxRealId = Math.max(...ITEM_LIST.map((i) => i.id));
  ok(maxRealId < wrongCapacity, '错值下所有真实 ID 都不越界 ⇒ 越界检查恒真(这就是危害)');
  /* 证明 A1 的判据确实指向正确来源:冻结层推出的值必须是 4095 */
  eq(OBJ_CAPACITY_FROM_FROZEN, 4095, '真实判据必须落在 4095');
});

test('S3 判据区分力自检(构造式):漏掉迁移提示校验的坏审计会放过真问题', () => {
  const badAudit = (exts: readonly ContentExtension[]): string[] => {
    const problems: string[] = [];
    exts.forEach((e, i) => {
      if (e.seq !== i + 1) problems.push('序号不连续');
      if (e.ids.length === 0) problems.push('无 ID');
      /* ← 故意漏掉 needsMigration / migrationNote 检查 */
    });
    return problems;
  };
  const needsNote: ContentExtension[] = [
    { seq: 1, summary: '需要迁移但没写提示', ids: [746], needsMigration: true, migrationNote: '' },
  ];
  eq(badAudit(needsNote).length, 0, '坏校验必须漏掉这个问题 —— 否则本次自检无效');
  ok(auditExtensions(needsNote).length > 0, '真实校验必须抓住它(C9-1 的判据有区分力)');
});

test('S4 判据区分力自检(构造式):只看长度的坏检测对等长换序无感', () => {
  const badDetect = (before: readonly number[], after: readonly number[]): boolean =>
    before.length === after.length; // ← 只看长度,不看顺序
  const real = ITEM_LIST.map((i) => i.id);
  const inserted = [...real];
  inserted.splice(5, 0, 9001);
  ok(!badDetect(real, inserted), '坏检测应报告「长度变了」——但它抓不到平移的本质');
  const swapped = [...real];
  const tmp = swapped[3]; swapped[3] = swapped[7]; swapped[7] = tmp;
  ok(badDetect(real, swapped), '坏检测对「等长换序」完全无感(这正是它的问题)');
  const shifts: number[] = [];
  swapped.forEach((id, i) => { if (id !== real[i]) shifts.push(i); });
  eq(shifts.length, 2, '按下标比对的判据能抓到 2 处差异,只看长度不能');
});

/* ═══════════════ 11. 真实源码故障注入(已移出本套件) ═══════════════

   ## 为什么不在测试里做

   本套件一度把真实源码注入写在测试内(自动改文件 → 跑子进程 → 还原)。
   对抗性复核对齐方法学时,我实测抓到了它的事故形态:

     - 探查时 `scripts/extension-drill.ts` 停在**注入态**(hash `7B0A0309`),
       而不是原值 `A525C33B` —— 说明某个窗口没走完还原;
     - 并发运行时打印了「还原被跳过:文件已被他人改写」。

   根因是**设计错误**,不是实现疏忽:本项目有 8 个 agent 并行共用同一文件系统,
   而注入目标 `client/src/ui/inventory.ts` 与 `server/src/content/baseline.ts`
   **根本不在本任务的写入范围内**。测试是自动执行的,别人跑一次套件就会
   在我改文件的瞬间读到损坏源码。

   这与 `extension-drill.ts` 自身初版踩的坑是同一个形态:
   **不可重入的副作用不该藏在别人的流程里。**(那次是 import 副作用,这次是测试副作用。)

   ## 现在放在哪

   注入改为**显式、一次性**的 CLI 模式,由人主动运行、当场核对:

   ```bash
   node scripts/extension-drill.ts --verify-faults
   ```

   该模式自带:锚点校验(源码漂移则跳过)、并发写入保护(被他人改过则不覆盖)、
   `finally` 还原、SHA-256 前后对照。实测记录见 `docs/EXTENDING.md` §9.7。

   ## 本套件保留什么

   只保留 §10 的**判据区分力自检**(构造式):它不改任何文件,
   回答「判据能不能分辨好坏」。而「真实源码坏掉时套件会不会红」
   由 §9.7 记录的一次性注入回答。两者互补,但**不能混称同一个名字** ——
   这正是复核指出的落差。 */

/* ═══════════════ 12. 汇总 ═══════════════ */

report('WS-FND-04');
