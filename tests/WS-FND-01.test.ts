/**
 * WS-FND-01 内容基座测试套件 —— 覆盖 `server/src/content/registry.ts` 与 `baseline.ts`。
 *
 * ## 为什么需要这一层测试
 *
 * 内容 ID 是**持久化身份**,被三处引用:
 *   - 存档:`users.held_item_id` / `users.weapon_id` / `users.inventory_json`
 *   - 网络:蓝图里的 12 位 `obj` 字段
 *   - 炼金:`ai_alchemy_recipes.recipe_hash`
 *
 * 而 `shared/constants/items.ts` 只是个裸常量数组 —— 改动它不会有任何提示。
 * 这份套件把「内容基座的三条不变量」变成可执行断言:
 *
 *   1. **指纹稳定**:同样的内容必须得到同样的指纹(否则存档无法判断内容被改过);
 *   2. **容量可算**:位宽余量必须能被算出来(否则扩容靠记忆,截断靠运气);
 *   3. **漂移可见**:内容一旦变化,必须报出**具体差异**而不是静默通过。
 *
 * ## 方法与口径
 *
 * 文件中每一条断言都是**先跑探针打印实测值**再写下的。凡涉及真实内容数据的
 * 断言(最大 ID、槽位、名称、指纹),值都从 `ITEM_LIST` / `ITEM_TABLES`
 * **现场推导**,不写死魔数 —— 这样断言在内容扩容后会跟着变,而不是变成噪音。
 *
 * **漂移检测的用例全部使用构造出来的假基线**,不改任何真实内容数据。
 *
 * ## 对齐版本
 *
 * 本套件对齐 `server/src/content/registry.ts` 的 **522 行版本**
 * (2026-11-11 10:56 前后,含 `headroom`/`freeCount` 字段拆分、
 * `freeIdSegments(minLength)` 参数化、`freeIdCount()` 精确计数、
 * 冻结层 `ItemCategory` 权威清单、`capacityReport` 四列 + 脚注)。
 * `baseline.ts` 对齐其 285 行版本(同批未改动)。
 *
 * 若上述任一文件再变,以下断言是最可能先失败的地方:
 *   - `A23` — `headroom` 与 `freeCount` 必须是**两个**字段(不要合并回 `remaining`)
 *   - `A30`/`A31` — `minLength` 过滤与 `freeIdCount()` 的差额恒为 2(219~220)
 *   - `A36` — 类别检查必须用外部权威清单,不得自建集合(否则恒真)
 *   - `A38` — `capacityReport` 行数 = 条目数 + 4
 *   - `B14` — `fingerprintMatches` 只比对 `overall`,分区由独立回路比对
 *
 * 零外部依赖:只用 `node:*` 内建模块。
 */

import { test, ok, eq, near, includes, inRange, report } from '../shared/testing/harness.ts';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CONTENT_FINGERPRINT_VERSION,
  FIELD_BITS,
  FIELD_MAX,
  auditContent,
  canonicalize,
  capacityReport,
  contentCapacity,
  contentFingerprintLine,
  contentFingerprints,
  fnv1a32,
  freeIdCount,
  freeIdSegments,
  idSegments,
} from '../server/src/content/registry.ts';

import {
  auditExtensions,
  buildBaseline,
  defaultBaselinePath,
  diffBaseline,
  extensionFingerprint,
  readBaseline,
  writeBaseline,
  type ContentBaseline,
  type ContentExtension,
} from '../server/src/content/baseline.ts';

import { ITEM_LIST, ITEM_TABLES } from '../shared/constants/items.ts';
import { MOB_LIST } from '../shared/constants/mobs.ts';
import { BOSS_LIST, PARTY_MODES, ROOM_RECIPES } from '../shared/constants/bosses.ts';
import { ItemCategory } from '../shared/types/entities.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 现场推导的实测事实(供多条断言共用,避免重复写死)。 */
const ITEM_COUNT = ITEM_LIST.length;                                    // 实测 320
const ITEM_IDS = ITEM_LIST.map((i) => i.id);
const MAX_ITEM_ID = Math.max(...ITEM_IDS);                              // 实测 745
const MIN_ITEM_ID = Math.min(...ITEM_IDS);                              // 实测 101

/** 写文件,供往返/畸形用例复用。 */
function writeText(path: string, text: string): void {
  writeFileSync(path, text, 'utf8');
}

/** 清理临时文件,不存在也不报错。 */
function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

/** 深拷贝,保证每条漂移用例互不污染真实数据。 */
function cloneBaseline(b: ContentBaseline): ContentBaseline {
  return JSON.parse(JSON.stringify(b)) as ContentBaseline;
}

/* ═══════════════ A. registry.ts — 指纹算法 ═══════════════ */

test('A01 FNV-1a 官方测试向量:fnv1a32("") === "811c9dc5"(32 位 offset basis)', () => {
  eq(fnv1a32(''), '811c9dc5');
});

test('A02 FNV-1a 官方测试向量:fnv1a32("a") === "e40c292c"', () => {
  eq(fnv1a32('a'), 'e40c292c');
  /* 再补两个官方向量,确认真的是标准 FNV-1a 而非近似的自制哈希。 */
  eq(fnv1a32('abc'), '1a47e90b');
  eq(fnv1a32('foobar'), 'bf9cf968');
});

test('A03 fnv1a32 输出恒为 8 位小写 hex,且对大范围输入稳定', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'hello', '中文内容', 'x'.repeat(4096)]) {
    const h = fnv1a32(s);
    eq(h.length, 8, `"${s.slice(0, 12)}" 长度`);
    ok(/^[0-9a-f]{8}$/.test(h), `"${s.slice(0, 12)}" 应为小写 hex,实际 ${h}`);
  }
});

test('A04 fnv1a32 区分相近输入(雪崩性最低要求)', () => {
  /* 一个字符之差必须导致不同指纹,否则「改了内容但指纹没变」会漏报。 */
  ok(fnv1a32('351') !== fnv1a32('352'));
  ok(fnv1a32('item') !== fnv1a32('Item'));
  ok(fnv1a32('a') !== fnv1a32('A'));
  /* 32 位空间里 7 个聚集输入的碰撞概率极低,这里作为回归守卫。 */
  const set = new Set(['', 'a', 'b', 'c', 'aa', 'ab', 'ba'].map(fnv1a32));
  eq(set.size, 7, '相近输入的指纹应互异');
});

/* ═══════════════ A. registry.ts — 规范化序列化 ═══════════════ */

test('A05 canonicalize 键序无关:同一对象不同声明顺序 → 同一字符串', () => {
  eq(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  /* 与 JSON.stringify 对照:后者依赖插入顺序,这正是必须先规范化的原因。 */
  ok(JSON.stringify({ b: 1, a: 2 }) !== JSON.stringify({ a: 2, b: 1 }), '前置确认 JSON.stringify 确实键序敏感');
  eq(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}', '键应按字典序排列');
});

test('A06 canonicalize 嵌套两层也键序无关', () => {
  const n1 = { z: { y: 1, x: 2 }, a: [1, 2] };
  const n2 = { a: [1, 2], z: { x: 2, y: 1 } };
  eq(canonicalize(n1), canonicalize(n2));
  eq(canonicalize(n1), '{"a":[1,2],"z":{"x":2,"y":1}}');
});

test('A07 canonicalize 数组序敏感:[1,2] !== [2,1]', () => {
  ok(canonicalize([1, 2]) !== canonicalize([2, 1]), '数组顺序通常是语义的一部分');
  eq(canonicalize([1, 2]), '[1,2]');
  eq(canonicalize([2, 1]), '[2,1]');
});

test('A08 canonicalize 原始类型各自稳定', () => {
  eq(canonicalize(null), 'null');
  eq(canonicalize(undefined), 'undef');
  eq(canonicalize(5), '5');
  eq(canonicalize(-0), '0');
  eq(canonicalize(NaN), 'NaN');
  eq(canonicalize(true), 'true');
  eq(canonicalize(false), 'false');
  eq(canonicalize('hi'), '"hi"');
  /* 稳定性:同值多次调用结果一致。 */
  eq(canonicalize(null), canonicalize(null));
  eq(canonicalize(5), canonicalize(5));
});

test('A09 canonicalize 区分字符串与数字(避免 "1" 与 1 撞指纹)', () => {
  ok(canonicalize('1') !== canonicalize(1), '字符串带引号,数字不带');
  eq(canonicalize('1'), '"1"');
  eq(canonicalize(1), '1');
});

test('A10 canonicalize 空对象/空数组边界', () => {
  eq(canonicalize({}), '{}');
  eq(canonicalize([]), '[]');
  eq(canonicalize({ a: {} }), '{"a":{}}');
});

/* ═══════════════ A. registry.ts — 内容指纹 ═══════════════ */

test('A11 contentFingerprints() 幂等:连续两次调用结果全等', () => {
  eq(contentFingerprints(), contentFingerprints());
  eq(JSON.stringify(contentFingerprints()), JSON.stringify(contentFingerprints()));
  /* 第三次再确认,排除「缓存首帧」这类假幂等。 */
  eq(contentFingerprints().overall, contentFingerprints().overall);
});

test('A12 四个分区指纹互不相同(items/mobs/bosses/modes)', () => {
  const f = contentFingerprints();
  const set = new Set([f.items, f.mobs, f.bosses, f.modes]);
  eq(set.size, 4, `四分区应互异,实际 ${JSON.stringify([f.items, f.mobs, f.bosses, f.modes])}`);
  for (const [k, v] of Object.entries({ items: f.items, mobs: f.mobs, bosses: f.bosses, modes: f.modes })) {
    ok(/^[0-9a-f]{8}$/.test(v), `${k} 应为 8 位 hex,实际 ${v}`);
  }
});

test('A13 overall 由四分区与算法版本合成,可独立复现', () => {
  const f = contentFingerprints();
  eq(f.version, CONTENT_FINGERPRINT_VERSION);
  eq(CONTENT_FINGERPRINT_VERSION, 1);
  /* 手工按实现公式重算,确认 overall 可复现 —— 而不是「某个神秘数字」。 */
  const expect = fnv1a32(`${f.version}|${f.items}|${f.mobs}|${f.bosses}|${f.modes}`);
  eq(f.overall, expect);
  eq(f.overall, 'fa111d71', '当前内容的总体指纹(实测基准)');
  /* 分区指纹实测基准。 */
  eq(f.items, '0474ce21');
  eq(f.mobs, '624808c4');
  eq(f.bosses, '660c7c9b');
  eq(f.modes, 'b854dbfe');
});

test('A14 contentFingerprintLine() 形如 v1-xxxxxxxx,8 位 hex', () => {
  const line = contentFingerprintLine();
  ok(/^v1-[0-9a-f]{8}$/.test(line), `格式应为 v1-8hex,实际 ${line}`);
  eq(line, `v1-${contentFingerprints().overall}`);
  eq(line, 'v1-fa111d71');
});

test('A15 指纹只反映内容数据:等价的规范输入得到等价指纹', () => {
  /* 这是指纹有用的前提 —— 隔离「数据变更」这一个变量。
   * 用 canonicalize 造两份键序不同、语义相同的 items 视图,指纹必须相同。 */
  const viewA = ITEM_LIST.map((i) => ({ id: i.id, name: i.name, category: i.category, tags: i.tags, value: i.value }));
  const viewB = ITEM_LIST.map((i) => ({ value: i.value, tags: i.tags, category: i.category, name: i.name, id: i.id }));
  eq(fnv1a32(canonicalize(viewA)), fnv1a32(canonicalize(viewB)));
  eq(fnv1a32(canonicalize(viewA)), contentFingerprints().items, '应与 items 分区指纹一致');
});

/* ═══════════════ A. registry.ts — 位域容量账本 ═══════════════ */

test('A16 FIELD_MAX.OBJ === 4095 且 (1<<12)-1 === 4095(位宽推导自洽)', () => {
  eq(FIELD_MAX.OBJ, 4095);
  eq((1 << 12) - 1, 4095);
  eq(FIELD_BITS.OBJ, 12);
});

test('A17 全部六个位域的上限都与位宽自洽', () => {
  eq(FIELD_BITS.ELEV, 2);  eq(FIELD_MAX.ELEV, 3);
  eq(FIELD_BITS.BASE, 4);  eq(FIELD_MAX.BASE, 15);
  eq(FIELD_BITS.FLOOR, 6); eq(FIELD_MAX.FLOOR, 63);
  eq(FIELD_BITS.WIRE, 4);  eq(FIELD_MAX.WIRE, 15);
  eq(FIELD_BITS.OBJ, 12);  eq(FIELD_MAX.OBJ, 4095);
  eq(FIELD_BITS.META, 4);  eq(FIELD_MAX.META, 15);
  /* 逐项验证 (1<<bits)-1。 */
  for (const [k, bits] of Object.entries(FIELD_BITS)) {
    eq(FIELD_MAX[k as keyof typeof FIELD_MAX], (1 << bits) - 1, `${k} 位宽 ${bits}`);
  }
  eq(Object.keys(FIELD_BITS).length, 6, '应有 6 个位域');
});

test('A18 contentCapacity() 返回 6 条,空间名互异', () => {
  eq(contentCapacity().length, 6);
  const spaces = contentCapacity().map((c) => c.space);
  eq(new Set(spaces).size, 6, '空间名应互异');
});

test('A19 物品容量条目:used === 320、capacity === 4095、headroom/freeCount 分离', () => {
  const obj = contentCapacity().find((c) => c.space.includes('OBJ'));
  ok(obj !== undefined, '应有 OBJ 层条目');
  eq(obj.used, ITEM_COUNT, '已用应等于 ITEM_LIST 长度');
  eq(obj.used, 320);
  eq(obj.capacity, FIELD_MAX.OBJ);
  eq(obj.capacity, 4095);
  near(obj.ratio ?? -1, MAX_ITEM_ID / 4095, 1e-9, 'ratio 应为 最大ID/4095');
  /* remaining 已拆成两个字段,见 A23。 */
  eq('remaining' in obj, false, '不应再有含义含混的 remaining');
});

test('A20 物品最大 ID 实测为 745(从 ITEM_LIST 现场算出,不硬编码来源)', () => {
  eq(MAX_ITEM_ID, 745);
  eq(MIN_ITEM_ID, 101);
  eq(ITEM_COUNT, 320);
  const fromTables = ITEM_TABLES.reduce((s, t) => s + t.count, 0);
  eq(fromTables, ITEM_COUNT, '分表 count 之和应等于 ITEM_LIST 长度');
  eq(fromTables, 320);
});

test('A21 FLOOR 条目:capacity === 63、used === 30(headroom 与 freeCount 恰好相等)', () => {
  const floor = contentCapacity().find((c) => c.space.includes('FLOOR'));
  ok(floor !== undefined, '应有 FLOOR 条目');
  eq(floor.capacity, FIELD_MAX.FLOOR);
  eq(floor.capacity, 63);
  eq(floor.used, 30);
  eq(floor.headroom, 33);
  eq(floor.freeCount, 33);
  /* FLOOR 的槽位是密集的 1..63,所以「顶端余量」与「可用数」天然相等
   * —— 这正好反衬 OBJ 那一行两者不等(稀疏 ID 空间),见 A23。 */
  eq(floor.headroom, floor.freeCount, 'FLOOR 密集槽位下两者应相等');
});

test('A22 字符串 ID 类内容无位宽上限(capacity/headroom/freeCount/ratio 均为 null)', () => {
  const cap = contentCapacity();
  for (const name of ['生物', 'Boss', '派对模式', '房间配方']) {
    const e = cap.find((c) => c.space.includes(name));
    ok(e !== undefined, `应有 ${name} 条目`);
    eq(e.capacity, null, `${name} capacity`);
    eq(e.headroom, null, `${name} headroom`);
    eq(e.freeCount, null, `${name} freeCount`);
    eq(e.ratio, null, `${name} ratio`);
    ok(e.note.length > 0, `${name} 应有备注`);
  }
  /* 数量与冻结层一致。 */
  eq(cap.find((c) => c.space.includes('生物'))?.used, MOB_LIST.length);
  eq(cap.find((c) => c.space.includes('Boss'))?.used, BOSS_LIST.length);
  eq(cap.find((c) => c.space.includes('派对模式'))?.used, PARTY_MODES.length);
  eq(cap.find((c) => c.space.includes('房间配方'))?.used, ROOM_RECIPES.length);
});

test('A23 headroom 与 freeCount 是**两个不同概念**,不能共用一个字段名', () => {
  /* 这曾是一个真实缺陷:`remaining` 字段**同名不同义** ——
   *   - OBJ 行算的是 `capacity - maxId`(值域顶端还能放多少);
   *   - FLOOR 行算的是 `capacity - used`(还剩几个可用槽)。
   * 读表的人会按同一含义理解,而其中一行必然是错的。现在拆成:
   *   - `headroom`  = 值域上界 − 最高已用值(值域顶端余量)
   *   - `freeCount` = 真实空闲号数(含中间空档)
   *
   * 关键证据:OBJ 行两者**必须不等**(3350 vs 3775),差额恰为
   * 「中间空档中高于最大已用 ID 的部分之外」的全部空档 —— 即 425 个号。
   * FLOOR 行两者相等(密集槽位)。
   * 若将来有人把它们合并回一个字段,这条断言会立刻失败。 */
  const cap = contentCapacity();
  const obj = cap.find((c) => c.space.includes('OBJ'));
  ok(obj !== undefined);
  eq(obj.headroom, 3350, '值域上界 4095 − 最大 ID 745');
  eq(obj.headroom, obj.capacity! - MAX_ITEM_ID);
  eq(obj.freeCount, 3775, '真实空闲号数(含中间空档)');
  eq(obj.freeCount, freeIdCount(), '应与 freeIdCount() 一致 —— 单一事实源');
  ok(obj.headroom !== obj.freeCount, 'OBJ 行两者必须不同,否则说明字段又被合并了');
  eq(obj.freeCount! - obj.headroom!, 425, '差额 = 746 以下未被占用的空档总数');

  /* 逐条字段存在性:不能有 remaining。 */
  for (const c of cap) {
    eq('remaining' in c, false, `${c.space} 不应有含义含混的 remaining`);
    ok('headroom' in c, `${c.space} 应有 headroom`);
    ok('freeCount' in c, `${c.space} 应有 freeCount`);
  }

  /* 有上限时两个字段都必须有值且非负;无上限时都为 null。 */
  for (const c of cap) {
    if (c.capacity === null) {
      eq(c.headroom, null, `${c.space} 无上限 headroom 应为 null`);
      eq(c.freeCount, null, `${c.space} 无上限 freeCount 应为 null`);
      eq(c.ratio, null, `${c.space} 无上限 ratio 应为 null`);
      continue;
    }
    ok(c.headroom !== null && c.freeCount !== null && c.ratio !== null, `${c.space} 有上限时三者都应有值`);
    ok(c.headroom >= 0, `${c.space} headroom 不应为负`);
    ok(c.freeCount >= 0, `${c.space} freeCount 不应为负`);
    inRange(c.ratio, 0, 1 + 1e-9, `${c.space} ratio 应在 [0,1]`);
  }
});

/* ═══════════════ A. registry.ts — ID 区间登记 ═══════════════ */

test('A24 idSegments() 返回 10 条,与 ITEM_TABLES 一一对应', () => {
  const segs = idSegments();
  eq(segs.length, 10);
  eq(segs.length, ITEM_TABLES.length);
  for (let i = 0; i < segs.length; i += 1) {
    eq(segs[i].key, ITEM_TABLES[i].key, `第 ${i} 段 key`);
    eq(segs[i].from, ITEM_TABLES[i].range[0], `第 ${i} 段 from`);
    eq(segs[i].to, ITEM_TABLES[i].range[1], `第 ${i} 段 to`);
    eq(segs[i].used, ITEM_TABLES[i].count, `第 ${i} 段 used`);
  }
});

test('A25 每个分表区间都是紧包的(slackInside 全为 0)——「区间已满」是设计事实', () => {
  for (const s of idSegments()) {
    eq(s.slackInside, 0, `${s.key} 应紧包`);
    eq(s.to - s.from + 1, s.used, `${s.key} 区间宽应等于 count`);
    ok(s.note.length > 0, `${s.key} 应有说明`);
    ok(s.note.includes('紧包'), `${s.key} 说明应点出「紧包」`);
  }
});

test('A26 idSegments 区间两两不重叠且升序,且覆盖全部物品 ID', () => {
  const segs = idSegments();
  for (let i = 1; i < segs.length; i += 1) {
    ok(segs[i].from > segs[i - 1].to, `${segs[i].key} 应与前一段不重叠且升序`);
    ok(segs[i].from <= segs[i].to, `${segs[i].key} 下界不应大于上界`);
  }
  const covered = new Set<number>();
  for (const s of segs) for (let id = s.from; id <= s.to; id += 1) covered.add(id);
  for (const id of ITEM_IDS) ok(covered.has(id), `物品 ${id} 应落在某个分表区间内`);
});

/* ═══════════════ A. registry.ts — 空闲区间 ═══════════════ */

test('A27 freeIdSegments() 任何一段都不得与已用 ID 重叠(逐段逐号自查)', () => {
  const used = new Set<number>();
  for (const s of idSegments()) for (let id = s.from; id <= s.to; id += 1) used.add(id);

  const def = freeIdSegments();
  let checked = 0;
  for (const f of def) {
    for (let id = f.from; id <= f.to; id += 1) {
      ok(!used.has(id), `空闲段 ${f.key} 的 ${id} 与已用 ID 重叠`);
      checked += 1;
    }
  }
  ok(checked > 3000, `应逐号检查了足够多的号,实际 ${checked}`);
  eq(def.length, 10);

  /* minLength=1 时也要满足同样的不重叠不变量。 */
  for (const f of freeIdSegments(1)) {
    for (let id = f.from; id <= f.to; id += 1) {
      ok(!used.has(id), `minLength=1 时 ${f.key} 的 ${id} 与已用 ID 重叠`);
    }
  }
});

test('A28 freeIdSegments() 默认过滤器生效:每段长度 ≥ 8,slackInside 等于段长', () => {
  const free = freeIdSegments();
  for (const f of free) {
    const len = f.to - f.from + 1;
    ok(len >= 8, `${f.key} 长度 ${len} 应 ≥ 8`);
    eq(f.used, 0, '空闲段 used 应为 0');
    eq(f.slackInside, len, '空闲段的 slackInside 应等于段长');
    ok(f.note.includes(String(len)), `${f.key} 备注应含号数`);
  }
  const lens = free.map((f) => f.to - f.from + 1);
  eq(Math.min(...lens), 15, '最短空闲段实测 15(386~400)');
  eq(Math.max(...lens), 3350, '最长空闲段实测 3350(746~4095)');
});

test('A29 空闲段连续、与用段交替、升序,且首尾覆盖 1 与 4095', () => {
  const free = freeIdSegments();
  for (let i = 1; i < free.length; i += 1) {
    ok(free[i].from > free[i - 1].to, `${free[i].key} 应与前一段不重叠且升序`);
  }
  eq(free[0].from, 1);
  eq(free[0].to, 100);
  eq(free[free.length - 1].to, FIELD_MAX.OBJ);
  eq(free[free.length - 1].from, MAX_ITEM_ID + 1);
});

test('A30 minLength 参数:过滤器可调,且短段确实存在于数据中(219~220)', () => {
  /* 219~220 是 3.3(201~218)与 3.4(221~255)之间的真实空隙,长度仅 2
   * < 默认阈值 8,因此默认调用**不会**列出它。这是有意的取舍:
   * 列出 2 个号的空隙会淹没真正可用的号段。
   *
   * 但「过滤掉的短段仍是真实空闲 ID」—— 所以不能用默认输出求和当总量,
   * 必须用 `freeIdCount()`。下面把这两种口径都固化。 */
  const def = freeIdSegments();          // minLength = 8
  const one = freeIdSegments(1);         // 全列出
  const two = freeIdSegments(2);

  eq(def.length, 10, '默认阈值下 10 段');
  eq(one.length, 11, 'minLength=1 下 11 段(多出 219~220 这一段)');
  eq(two.length, 11, 'minLength=2 下 11 段(219~220 恰好长度 2,刚好通过)');

  /* 219~220 在 minLength=1 时能被列出,默认时不能。 */
  const holder = one.find((s) => s.from === 219);
  ok(holder !== undefined, 'minLength=1 应列出 219 起头的段');
  eq(holder.to, 220, '该段应到 220 结束');
  eq(holder.key, 'FREE_219_220');
  ok(!def.some((s) => s.from <= 219 && s.to >= 220), '默认阈值不应列出 219~220');

  /* 单调性:阈值越小,报出的号越多。 */
  const total = (n: number): number => freeIdSegments(n).reduce((s, x) => s + (x.to - x.from + 1), 0);
  ok(total(1) >= total(2), '阈值 1 报出的号应不少于阈值 2');
  ok(total(2) >= total(8), '阈值 2 报出的号应不少于阈值 8');
  eq(total(1), 3775, 'minLength=1 时报出的号数恰为全部空闲数');
  eq(total(8), 3773, '默认阈值漏掉 219~220 两个号');
});

test('A31 freeIdCount() 给出精确空闲数,不受 minLength 过滤影响', () => {
  /* 这是「看起来精确的偏差」的修复点:早先 CLI 用默认输出求和报了 3773,
   * 而真实空闲是 3775。差的就是 219~220 —— 数字看着精确,反而更危险。 */
  eq(freeIdCount(), 3775);
  eq(freeIdCount(), FIELD_MAX.OBJ - ITEM_COUNT);
  const defSum = freeIdSegments().reduce((s, x) => s + (x.to - x.from + 1), 0);
  ok(freeIdCount() > defSum, '精确值应大于默认输出求和');
  eq(freeIdCount() - defSum, 2, '差额恰为 219~220 两个号');

  /* freeIdCount 与 freeIdSegments(1) 求和必须相等 —— 两种口径互相印证。 */
  eq(freeIdCount(), freeIdSegments(1).reduce((s, x) => s + (x.to - x.from + 1), 0));
});

test('A32 已用 ∪ 空闲(minLength=1) 恰好无缝覆盖 1..4095', () => {
  const used = new Set<number>();
  for (const s of idSegments()) for (let id = s.from; id <= s.to; id += 1) used.add(id);
  const free = new Set<number>();
  for (const s of freeIdSegments(1)) for (let id = s.from; id <= s.to; id += 1) free.add(id);

  eq(used.size, ITEM_COUNT);
  eq(used.size + free.size, FIELD_MAX.OBJ, '两者之和应恰好铺满 OBJ 层');

  const uncovered: number[] = [];
  for (let id = 1; id <= FIELD_MAX.OBJ; id += 1) if (!used.has(id) && !free.has(id)) uncovered.push(id);
  eq(uncovered, [], '不应有既非已用也非空闲的号');

  let overlap = 0;
  for (const id of free) if (used.has(id)) overlap += 1;
  eq(overlap, 0, '不应有重叠');
});

/* ═══════════════ A. registry.ts — 内容审计 ═══════════════ */

test('A33 auditContent().ok === true 且 problems.length === 0', () => {
  const a = auditContent();
  eq(a.ok, true, `应无问题,实际 ${JSON.stringify(a.problems)}`);
  eq(a.problems.length, 0);
});

test('A34 auditContent() 返回值结构完整(ok/fingerprint/capacity/problems/notes)', () => {
  const a = auditContent();
  eq(Object.keys(a).sort(), ['capacity', 'fingerprint', 'notes', 'ok', 'problems']);
  eq(a.capacity.length, 6, 'capacity 应带 6 条');
  eq(Object.keys(a.fingerprint).sort(), ['bosses', 'items', 'mobs', 'modes', 'overall', 'version']);
  ok(Array.isArray(a.problems), 'problems 应为数组');
  ok(Array.isArray(a.notes), 'notes 应为数组');
  /* notes 里那条「类别存在但未使用」是当前内容的真实状态(AI_CRAFTED 尚无物品),
   * 属**信息性**提示,不应影响 ok。 */
  eq(a.ok, true, 'notes 不应让审计判失败');
});

test('A35 auditContent 的指纹与 capacity 与独立调用一致(不因审计而变)', () => {
  const a = auditContent();
  eq(a.fingerprint, contentFingerprints());
  eq(a.capacity, contentCapacity());
  eq(a.fingerprint.overall, auditContent().fingerprint.overall);
});

test('A36 类别检查用冻结层 ItemCategory 作权威清单(非自建集合),并反向列出未使用类别', () => {
  /* 这里曾有一个**恒真式缺陷**:`KNOWN_CATEGORIES` 若从 `ITEM_LIST` 自建,
   * `has(it.category)` 对每一项恒真 —— 检查永远不可能失败(同义反复)。
   * 违反检查的数据会自己定义出合法集合,所以写法上就必须用**外部权威清单**。
   *
   * 现版已改用冻结层 `ItemCategory`,本断言从两个方向固化这个修复:
   *   1. 当前内容的所有类别都必须落在 ItemCategory 内(正向);
   *   2. 冻结层有但内容未使用的类别应出现在 notes 里(反向 —— 这是「检查真的
   *      在拿两份清单比对」的证据;若改回自建集合,notes 必为空)。 */
  const known = new Set<string>(Object.values(ItemCategory));
  eq(known.size, 12, '冻结层 ItemCategory 应有 12 项');

  const usedCats = new Set(ITEM_LIST.map((i) => i.category));
  for (const c of usedCats) ok(known.has(c), `内容类别 ${c} 应在冻结层清单内`);

  const unused = [...known].filter((c) => !usedCats.has(c)).sort();
  eq(unused, ['AI_CRAFTED'], '实测:冻结层有 12 类,当前内容用了 11 类');

  const a = auditContent();
  eq(a.problems.length, 0, '当前内容不应有类别问题');
  for (const c of unused) {
    ok(a.notes.some((n) => n.includes(c)), `notes 应报出未使用类别 ${c}`);
  }
  ok(a.notes.some((n) => n.includes('没有任何物品使用')), 'notes 应说明是「存在但未使用」');
});

test('A37 auditContent 的 notes 里那条是**结构提示**(类别未使用),不是余量告警', () => {
  /* 这条 notes 容易被误读成「容量紧张」。它的真实含义是:
   * `AI_CRAFTED` 是冻结层定义的类别、也是 LLM 炼金产物的类别,
   * 静态内容表里本就不该有 —— 所以「存在但未使用」是**预期结果**,
   * 属信息性结构提示。
   *
   * 而容量告警(ratio > 0.9)当前**不应触发**:两个有位宽的条目
   * 分别是 18.2% 与 47.6%。两类提示要分清楚,否则「有余量问题」会被误判。 */
  const a = auditContent();

  /* 结构提示:确实存在,且措辞是「类别/使用」。 */
  eq(a.notes.length, 1, `实测只有 1 条结构提示,实际 ${JSON.stringify(a.notes)}`);
  ok(a.notes[0].includes('类别'), '该提示应关于类别');
  ok(!a.notes[0].includes('余量'), '该提示不应是余量告警');

  /* 容量告警:不应触发。 */
  for (const c of a.capacity) {
    ok(!(c.ratio !== null && c.ratio > 0.9), `${c.space} ratio ${c.ratio} 不应触发余量告警`);
  }
  ok(!a.notes.some((n) => n.includes('余量紧张')), `不应有余量紧张提示,实际 ${JSON.stringify(a.notes)}`);
  ok(!a.notes.some((n) => n.includes('%')), '余量告警会带百分比,当前不应有');

  /* 正向确认审计确实走过了生物/Boss 的全部引用
     (否则「problems 为空」可能是「根本没检查」)。 */
  let refs = 0;
  for (const m of MOB_LIST) {
    refs += Object.keys(m.drops ?? {}).length;
    if (m.tameItem !== null && m.tameItem !== undefined) refs += 1;
  }
  for (const b of BOSS_LIST) {
    if (b.summonItem !== null && b.summonItem !== undefined) refs += 1;
    refs += (b.loot ?? []).length;
  }
  ok(refs > 0, `应有可检查的引用,实际 ${refs}`);
  eq(a.problems.length, 0, `引用总数 ${refs} 应全部闭合`);
});

test('A38 capacityReport() 含表头、分隔线与脚注,行数 = 条目数 + 4', () => {
  const rep = capacityReport();
  const lines = rep.split('\n');
  eq(lines.length, contentCapacity().length + 4);
  eq(lines.length, 10);
  ok(lines[0].includes('已用'), `表头应含「已用」,实际 ${JSON.stringify(lines[0])}`);
  ok(lines[0].includes('值域'), '表头应含「值域」');
  ok(lines[0].includes('顶端余量'), '表头应含「顶端余量」(headroom)');
  ok(lines[0].includes('可用'), '表头应含「可用」(freeCount)');
  /* 分隔线出现两次,中间是数据行。 */
  ok(lines[1].includes('─'), '第 2 行应为分隔线');
  ok(lines[lines.length - 2].includes('─'), '倒数第 2 行也应为分隔线');
  /* 末行是脚注,解释两个概念的差别 —— 这正是防止再次混淆的护栏。 */
  const footer = lines[lines.length - 1];
  ok(footer.includes('顶端余量'), '脚注应解释顶端余量');
  ok(footer.includes('可用'), '脚注应解释可用');
  ok(footer.includes('含中间空档'), '脚注应点明可用数含中间空档');

  for (const c of contentCapacity()) ok(rep.includes(c.space), `报表应含 ${c.space}`);
  /* 两个概念的值都要打出来。 */
  const obj = contentCapacity().find((c) => c.space.includes('OBJ'));
  ok(obj !== undefined);
  ok(rep.includes(String(obj.headroom)), '应打印 OBJ 的 headroom');
  ok(rep.includes(String(obj.freeCount)), '应打印 OBJ 的 freeCount');
});

test('A39 capacityReport() 对无上限条目用「—」占位,不打印 null/NaN', () => {
  const rep = capacityReport();
  ok(rep.includes('—'), '无上限条目应用「—」占位');
  ok(!rep.includes('null'), '不应把 null 直接打出来');
  ok(!rep.includes('NaN'), '不应出现 NaN');
  ok(!rep.includes('undefined'), '不应出现 undefined');
  ok(rep.includes(String(ITEM_COUNT)), '应打印已用数量');
});

/* ═══════════════ B. baseline.ts — 基线生成 ═══════════════ */

test('B01 buildBaseline() 的 counts 与冻结层内容数量一致', () => {
  const b = buildBaseline();
  eq(b.counts.items, 320);
  eq(b.counts.mobs, 24);
  eq(b.counts.bosses, 8);
  eq(b.counts.items, ITEM_LIST.length);
  eq(b.counts.mobs, MOB_LIST.length);
  eq(b.counts.bosses, BOSS_LIST.length);
  eq(b.counts.modes, PARTY_MODES.length);
  eq(b.counts.rooms, ROOM_RECIPES.length);
});

test('B02 buildBaseline().slots 有 320 个键;slots["101"] === 0;slots["745"] === 319', () => {
  const b = buildBaseline();
  eq(Object.keys(b.slots).length, ITEM_COUNT);
  eq(Object.keys(b.slots).length, 320);
  eq(b.slots['101'], 0, '首个物品槽位为 0');
  eq(b.slots[String(MAX_ITEM_ID)], ITEM_COUNT - 1, '末个物品槽位为 count-1');
  eq(b.slots['745'], 319);
});

test('B03 slots 是 ITEM_LIST 数组下标(逐项验证,非抽查)', () => {
  const b = buildBaseline();
  ITEM_LIST.forEach((it, i) => {
    eq(b.slots[String(it.id)], i, `物品 ${it.id} 槽位`);
  });
  const vals = Object.values(b.slots).sort((x, y) => x - y);
  eq(vals, Array.from({ length: ITEM_COUNT }, (_, i) => i), '槽位值域应为 0..319 的排列');
});

test('B04 buildBaseline().names["101"] === "暖松原木"(从 ITEM_LIST 实测)', () => {
  const b = buildBaseline();
  eq(b.names['101'], '暖松原木');
  eq(b.names['101'], ITEM_LIST[0].name, '应与 ITEM_LIST[0] 一致');
  eq(Object.keys(b.names).length, ITEM_COUNT);
  for (const it of ITEM_LIST) {
    eq(b.names[String(it.id)], it.name, `物品 ${it.id} 名称`);
  }
});

test('B05 buildBaseline() 的其余字段结构完整', () => {
  const b = buildBaseline();
  eq(b.baselineFormat, 1);
  eq(typeof b._comment, 'string');
  ok(b._comment.includes('content-lock.ts'), '注释应指明生成命令');
  eq(b.mobIds, MOB_LIST.map((m) => m.id));
  eq(b.bossIds, BOSS_LIST.map((bs) => bs.id));
  eq(b.mobIds.length, 24);
  eq(b.bossIds.length, 8);
  eq(b.fingerprints, contentFingerprints());
  eq(Object.keys(b).sort(), ['_comment', 'baselineFormat', 'bossIds', 'counts', 'fingerprints', 'mobIds', 'names', 'slots']);
});

/* ═══════════════ B. baseline.ts — 漂移检测(全部用构造的假基线) ═══════════════ */

test('B06 diffBaseline(null) → present === false、inSync === false、changes 非空', () => {
  const d = diffBaseline(null);
  eq(d.present, false, '基线缺失应报 present=false');
  eq(d.inSync, false, '基线缺失**不是通过**');
  eq(d.fingerprintMatches, false);
  ok(d.changes.length > 0, '应给出说明');
  eq(d.changes.length, 1);
  ok(d.changes[0].includes('缺失'), `应说明基线缺失,实际 ${d.changes[0]}`);
  /* 缺失时不应编造差异。 */
  eq(d.slotShifts.length, 0);
  eq(d.addedIds.length, 0);
  eq(d.removedIds.length, 0);
  eq(d.renamedIds.length, 0);
});

test('B07 diffBaseline(buildBaseline()) → inSync === true,changes/slotShifts 均为空', () => {
  const d = diffBaseline(buildBaseline());
  eq(d.present, true);
  eq(d.inSync, true);
  eq(d.fingerprintMatches, true);
  eq(d.changes.length, 0);
  eq(d.slotShifts.length, 0);
  eq(d.addedIds.length, 0);
  eq(d.removedIds.length, 0);
  eq(d.renamedIds.length, 0);
});

test('B08 磁盘上的真实基线文件与当前内容同步(inSync === true)', () => {
  const onDisk = readBaseline();
  ok(onDisk !== null, '基线文件应存在且可解析');
  const d = diffBaseline(onDisk);
  eq(d.inSync, true, `磁盘基线应同步,实际差异 ${JSON.stringify(d.changes)}`);
  eq(d.changes.length, 0);
  eq(onDisk.fingerprints.overall, contentFingerprints().overall);
  eq(onDisk.baselineFormat, 1);
});

test('B09 【漂移-新增】基线不含某 ID → addedIds 非空,changes 含「新增物品」', () => {
  /* 方向说明(探针实测确认,非推断):
   *   addedIds   = 当前内容有、基线没有 → 报「新增物品」
   *   removedIds = 基线有、当前内容没有 → 报「删除物品」+ 旧存档悬空
   *
   * 所以「从基线里删掉一个 ID」得到的是 **addedIds**(机器的视角:
   * 当前内容比基线**多**了这一项)。这与人的直觉相反,是本条断言的重点。
   * 探针实测:删 names/slots 的 745 → addedIds=[745], removedIds=[]。 */
  const fake = cloneBaseline(buildBaseline());
  delete fake.names['745'];
  delete fake.slots['745'];

  const d = diffBaseline(fake);
  eq(d.addedIds, [745], '应报出新增物品 745');
  eq(d.removedIds.length, 0, '这个方向不该产生 removedIds');
  eq(d.inSync, false, '不应判为同步');
  ok(d.changes.some((c) => c.includes('新增物品')), `changes 应含「新增物品」,实际 ${JSON.stringify(d.changes)}`);
  ok(d.changes.some((c) => c.includes('745')), 'changes 应点名具体 ID');

  /* 语义分层(探针实测):`names`/`slots` **不参与**指纹计算,所以只删它们时
   * `fingerprintMatches` 仍为 true;但 `inSync = fingerprintMatches && changes 为空`
   * 因此为 false。两层语义分别固化,避免混为一谈。 */
  eq(d.fingerprintMatches, true, '只改 names/slots 不动指纹字段');
  eq(d.inSync, false, 'inSync 还要求 changes 为空');
});

test('B10 【漂移-删除】基线里塞一个幽灵 ID → removedIds 非空,changes 含「删除物品」', () => {
  /* 这才是 removedIds 的正确构造方向:基线声称有、当前内容没有
   * → 旧存档若引用了它会悬空。 */
  const fake = cloneBaseline(buildBaseline());
  fake.names['9999'] = '幽灵物品';
  fake.slots['9999'] = 320;

  const d = diffBaseline(fake);
  eq(d.removedIds, [9999], '应报出被删除的物品 9999');
  eq(d.addedIds.length, 0, '这个方向不该产生 addedIds');
  eq(d.inSync, false);
  ok(d.changes.some((c) => c.includes('删除物品')), `changes 应含「删除物品」,实际 ${JSON.stringify(d.changes)}`);
  ok(d.changes.some((c) => c.includes('悬空')), '应提示旧存档引用会悬空');
});

test('B11 【漂移-槽位平移】把某 ID 的 slot +1 → slotShifts 非空且 changes 含「槽位平移」', () => {
  const real = buildBaseline();
  const fake = cloneBaseline(real);
  const targetId = 351;
  fake.slots[String(targetId)] = real.slots[String(targetId)] + 1;

  const d = diffBaseline(fake);
  eq(d.slotShifts.length, 1, `应报出 1 项槽位平移,实际 ${JSON.stringify(d.slotShifts)}`);
  eq(d.inSync, false);
  /* 槽位平移必须被单独高亮 —— 这是最容易被忽略、后果最重的一类。 */
  ok(d.changes.some((c) => c.includes('槽位平移')), `changes 应含「槽位平移」,实际 ${JSON.stringify(d.changes)}`);
  ok(d.changes.some((c) => c.includes('非末尾插入')), '应解释成因');
  ok(d.changes.some((c) => c.includes('整体错位')), '应说明后果');
  /* 平移项文本应含 ID、名称与前后槽位。 */
  const s = d.slotShifts[0];
  ok(s.includes(String(targetId)), `平移项应含 ID,实际 ${s}`);
  ok(s.includes(real.names[String(targetId)]), '平移项应含物品名');
  ok(s.includes(String(real.slots[String(targetId)])), '平移项应含原槽位');
  ok(s.includes(String(real.slots[String(targetId)] + 1)), '平移项应含新槽位');
  /* 改名与增删都不该被误报。 */
  eq(d.renamedIds.length, 0);
  eq(d.addedIds.length, 0);
  eq(d.removedIds.length, 0);
});

test('B12 【漂移-改名】改掉某 ID 的名称 → renamedIds 非空,changes 含「改名」', () => {
  const real = buildBaseline();
  const fake = cloneBaseline(real);
  const targetId = 351;
  fake.names[String(targetId)] = '伪造物品名';

  const d = diffBaseline(fake);
  eq(d.renamedIds, [targetId], `应报出 ${targetId} 改名`);
  eq(d.inSync, false);
  eq(d.slotShifts.length, 0, '改名不该产生槽位平移');
  ok(d.changes.some((c) => c.includes('改名')), `changes 应含「改名」,实际 ${JSON.stringify(d.changes)}`);
  ok(d.changes.some((c) => c.includes('伪造物品名')), '应含新名');
  ok(d.changes.some((c) => c.includes(real.names[String(targetId)])), '应含旧名');
  ok(d.changes.some((c) => c.includes('另一个东西')), '应说明旧存档会读到另一个东西');
});

test('B13 【漂移-数量】基线 counts.items 不同 → changes 含「数量」', () => {
  const fake = cloneBaseline(buildBaseline());
  fake.counts.items = 319;

  const d = diffBaseline(fake);
  eq(d.inSync, false);
  const countChanges = d.changes.filter((c) => c.includes('数量'));
  eq(countChanges.length, 1, `应有 1 条数量差异,实际 ${JSON.stringify(d.changes)}`);
  ok(countChanges[0].includes('items'), '应点名 items');
  ok(countChanges[0].includes('319'), '应含基线值');
  ok(countChanges[0].includes('320'), '应含当前值');
  ok(countChanges[0].includes('+1'), '应含增量符号');
  /* 只改 counts、不动物品表 → 增删改名平移都为 0,证明各检查项互不串扰。 */
  eq(d.addedIds.length, 0);
  eq(d.removedIds.length, 0);
  eq(d.renamedIds.length, 0);
  eq(d.slotShifts.length, 0);
});

test('B14 【漂移-分区指纹】分区变化被报出;与 overall 自洽的基线两边都报', () => {
  /* 前置事实:`overall = fnv1a32(version|items|mobs|bosses|modes)`,
   * 即 overall 是四个分区指纹的**函数**。所以「分区变了而 overall 没变」
   * 是一个**逻辑上不可能自洽**的状态。
   *
   * 因此这里分两种用例,各自断言不同的东西:
   *   (a) **自洽**基线:分区与 overall 一起改(按实现公式重算 overall)
   *       → 两边都应被报出,fingerprintMatches=false;
   *   (b) **不自洽**基线(分区变了、overall 留着旧的):这是畸形输入。
   *       实现不应崩溃,且必须仍然报出分区差异、仍判不同步。
   *       注意此时 `fingerprintMatches` 为 true —— 因为它**只比对 overall**,
   *       这正是为什么分区必须被**独立**比对(下面 (b) 就是在守这条)。 */

  /* (a) 自洽:改 items 分区,并按实现公式重算 overall。 */
  const self = cloneBaseline(buildBaseline());
  self.fingerprints.items = 'deadbeef';
  self.fingerprints.overall = fnv1a32(
    `${self.fingerprints.version}|${self.fingerprints.items}|${self.fingerprints.mobs}|${self.fingerprints.bosses}|${self.fingerprints.modes}`,
  );
  ok(self.fingerprints.overall !== buildBaseline().fingerprints.overall, '重算后 overall 应确实变了');

  const da = diffBaseline(self);
  eq(da.fingerprintMatches, false, '自洽基线:overall 不同 → fingerprintMatches=false');
  eq(da.inSync, false);
  ok(da.changes.some((c) => c.includes('items 指纹')), `应报出 items 分区差异,实际 ${JSON.stringify(da.changes)}`);
  ok(da.changes.some((c) => c.includes('deadbeef')), '应含基线的分区值');

  /* (b) 不自洽(畸形):分区变了、overall 留着旧的。 */
  const broken = cloneBaseline(buildBaseline());
  const orig = broken.fingerprints.items;
  broken.fingerprints.items = 'deadbeef';

  const db = diffBaseline(broken);
  eq(db.fingerprintMatches, true, 'fingerprintMatches 只比对 overall,此处 overall 未动');
  eq(db.inSync, false, '但分区差异让整体判为不同步 —— 分区被独立比对');
  ok(db.changes.some((c) => c.includes('items 指纹')), `畸形输入也必须报出分区差异,实际 ${JSON.stringify(db.changes)}`);
  ok(db.changes.some((c) => c.includes(orig) && c.includes('deadbeef')), '应含前后值');
  eq(db.slotShifts.length, 0, '不应牵连槽位');
  eq(db.renamedIds.length, 0, '不应牵连改名');

  /* 五个分区都要能被单独报出(逐个验证比对回路真的接了)。 */
  for (const k of ['items', 'mobs', 'bosses', 'modes'] as const) {
    const f = cloneBaseline(buildBaseline());
    f.fingerprints[k] = '00000000';
    f.fingerprints.overall = fnv1a32(
      `${f.fingerprints.version}|${f.fingerprints.items}|${f.fingerprints.mobs}|${f.fingerprints.bosses}|${f.fingerprints.modes}`,
    );
    const d = diffBaseline(f);
    ok(d.changes.some((c) => c.includes(`${k} 指纹`)), `改了 ${k} 分区应被报出`);
    eq(d.fingerprintMatches, false, `${k}:自洽基线应报 overall 不同`);
    eq(d.inSync, false);
  }
});

test('B15 【漂移-overall】分区都不变但 overall 不同 → fingerprintMatches=false', () => {
  const fake = cloneBaseline(buildBaseline());
  fake.fingerprints.overall = '00000000';
  const d = diffBaseline(fake);
  eq(d.fingerprintMatches, false);
  eq(d.inSync, false, 'overall 不一致即判不同步');
});

test('B16 【漂移-字符串 ID】生物/Boss 增删被单独报出(方向经探针实测)', () => {
  /* 方向(探针实测确认):
   *   基线**多出**一个 ID → 当前内容没有 → 报「删除生物」+ AOI 失效提示
   *   基线**缺少**一个 ID → 当前内容有   → 报「新增生物」
   * 与 B09 的 addedIds/removedIds 同一套视角,不要凭直觉反着写。 */

  /* 基线多一个生物 → 删除。 */
  const ghost = cloneBaseline(buildBaseline());
  ghost.mobIds = [...ghost.mobIds, 'mob_ghost_probe'];
  const dGhost = diffBaseline(ghost);
  eq(dGhost.inSync, false, '生物集合不同应判不同步');
  ok(dGhost.changes.some((c) => c.includes('删除生物')), `应含「删除生物」,实际 ${JSON.stringify(dGhost.changes)}`);
  ok(dGhost.changes.some((c) => c.includes('mob_ghost_probe')), '应点名被删生物');
  ok(dGhost.changes.some((c) => c.includes('AOI')), '应提示旧存档 AOI 状态失效');

  /* 基线少一个生物 → 新增。 */
  const missing = cloneBaseline(buildBaseline());
  const missingId = missing.mobIds[missing.mobIds.length - 1];
  missing.mobIds = missing.mobIds.slice(0, -1);
  const dMissing = diffBaseline(missing);
  ok(dMissing.changes.some((c) => c.includes('新增生物')), `应含「新增生物」,实际 ${JSON.stringify(dMissing.changes)}`);
  ok(dMissing.changes.some((c) => c.includes(missingId)), `应点名新增生物 ${missingId}`);

  /* Boss 同理。 */
  const ghostBoss = cloneBaseline(buildBaseline());
  ghostBoss.bossIds = [...ghostBoss.bossIds, 'boss_ghost_probe'];
  const dBoss = diffBaseline(ghostBoss);
  ok(dBoss.changes.some((c) => c.includes('删除 Boss')), `应含「删除 Boss」,实际 ${JSON.stringify(dBoss.changes)}`);

  const missingBoss = cloneBaseline(buildBaseline());
  missingBoss.bossIds = missingBoss.bossIds.slice(0, -1);
  const dBossAdd = diffBaseline(missingBoss);
  ok(dBossAdd.changes.some((c) => c.includes('新增 Boss')), '应含「新增 Boss」');

  /* 生物数量不变时不应产生任何生物相关差异 —— 防止误报。 */
  const same = diffBaseline(buildBaseline());
  ok(!same.changes.some((c) => c.includes('生物')), '内容未变时不应报生物差异');
});

test('B17 漂移检测不修改输入基线(纯函数)', () => {
  const fake = cloneBaseline(buildBaseline());
  const snapshot = JSON.stringify(fake);
  diffBaseline(fake);
  eq(JSON.stringify(fake), snapshot, 'diffBaseline 不应改动传入的基线');

  const real = buildBaseline();
  const realSnapshot = JSON.stringify(real);
  diffBaseline(real);
  eq(JSON.stringify(real), realSnapshot);
  /* 再确认真实内容没被污染。 */
  eq(buildBaseline().counts.items, 320);
});

/* ═══════════════ B. baseline.ts — 读写往返 ═══════════════ */

test('B18 readBaseline() 对缺失路径返回 null(而非抛错)', () => {
  eq(readBaseline(join(ROOT, 'no', 'such', 'baseline.json')), null);
  eq(readBaseline(join(ROOT, 'tests', 'no_such_file.json')), null);
});

test('B19 readBaseline() 对畸形 JSON 返回 null(而非抛错)', () => {
  const bad = join(ROOT, 'tests', '_probe_bad_baseline.tmp.json');
  try {
    writeText(bad, '{not valid json');
    eq(readBaseline(bad), null, '畸形 JSON 应返回 null');
    writeText(bad, '');
    eq(readBaseline(bad), null, '空文件应返回 null');
    writeText(bad, 'null');
    eq(readBaseline(bad), null, '字面量 null 应返回 null');
  } finally {
    removeIfExists(bad);
  }
});

test('B20 writeBaseline/readBaseline 往返:写出的基线读回后 inSync', () => {
  const tmp = join(ROOT, 'tests', '_probe_roundtrip_baseline.tmp.json');
  try {
    writeBaseline(buildBaseline(), tmp);
    ok(existsSync(tmp), '文件应已写出');
    const back = readBaseline(tmp);
    ok(back !== null, '应能读回');
    eq(diffBaseline(back).inSync, true, '往返后应同步');
    eq(Object.keys(back.slots).length, ITEM_COUNT);
    eq(back.fingerprints.overall, contentFingerprints().overall);
    /* 写出的文件应是格式化 JSON(便于 code review 看差异)。 */
    const text = readFileSync(tmp, 'utf8');
    ok(text.includes('\n  "'), '应为 2 空格缩进的格式化 JSON');
    ok(text.endsWith('\n'), '应以换行结尾');
  } finally {
    removeIfExists(tmp);
  }
});

test('B21 defaultBaselinePath() 指向 content 目录下的 content.baseline.json', () => {
  const p = defaultBaselinePath();
  ok(p.endsWith('content.baseline.json'), `路径应以文件名结尾,实际 ${p}`);
  ok(p.includes('content'), '路径应含 content 目录');
  ok(existsSync(p), '默认路径指向的文件应真实存在');
});

/* ═══════════════ B. baseline.ts — 扩展登记校验 ═══════════════ */

/** 造一条合法扩展登记,再用 overrides 覆盖出各类非法情形。 */
function makeExtension(o: Partial<ContentExtension> = {}): ContentExtension {
  return { seq: 1, summary: '探测用扩展', ids: [900], needsMigration: false, migrationNote: '', ...o };
}

test('B22 auditExtensions([]) → 无问题', () => {
  eq(auditExtensions([]), []);
});

test('B23 auditExtensions 序号不连续时报错(seq=2 作为第一条)', () => {
  const problems = auditExtensions([makeExtension({ seq: 2 })]);
  eq(problems.length, 1);
  ok(problems[0].includes('序号不连续'), `应报序号不连续,实际 ${problems[0]}`);
  ok(problems[0].includes('seq=2'), '应点名实际 seq');

  /* 两条连续的应通过;第二条断号(seq=3)应报错并指出是第 2 条。 */
  eq(auditExtensions([makeExtension(), makeExtension({ seq: 2, ids: [901] })]), []);
  const two = auditExtensions([makeExtension(), makeExtension({ seq: 3, ids: [901] })]);
  eq(two.length, 1);
  ok(two[0].includes('第 2 条'), `应指出是第 2 条,实际 ${two[0]}`);
});

test('B24 auditExtensions ID 冲突时报错(用真实存在的物品 ID 101)', () => {
  const problems = auditExtensions([makeExtension({ ids: [101] })]);
  eq(problems.length, 1);
  ok(problems[0].includes('101'), `应点名冲突 ID,实际 ${problems[0]}`);
  ok(problems[0].includes('冲突'), '应说明是冲突');

  /* 用不存在的 ID 应通过。 */
  eq(auditExtensions([makeExtension({ ids: [9000] })]), []);
  /* 自定义 existingIds 也生效(不依赖真实表)。 */
  eq(auditExtensions([makeExtension({ ids: [5000] })], [101, 102]), [], '5000 不在自定义已有集合里,应通过');
  eq(auditExtensions([makeExtension({ ids: [102] })], [101, 102]).length, 1, '102 在自定义集合里,应报冲突');
});

test('B25 auditExtensions 声明需迁移但 migrationNote 为空时报错', () => {
  const problems = auditExtensions([makeExtension({ needsMigration: true, migrationNote: '' })]);
  eq(problems.length, 1);
  ok(problems[0].includes('需要迁移'), `应说明迁移,实际 ${problems[0]}`);
  ok(problems[0].includes('未给出迁移提示'), '应说明缺提示');

  /* 空白字符不算有效提示。 */
  eq(auditExtensions([makeExtension({ needsMigration: true, migrationNote: '   ' })]).length, 1);
  /* 给了提示就通过。 */
  eq(auditExtensions([makeExtension({ needsMigration: true, migrationNote: '把 900 映射到 901' })]), []);
  /* 不需要迁移时 note 可为空。 */
  eq(auditExtensions([makeExtension({ needsMigration: false, migrationNote: '' })]), []);
});

test('B26 auditExtensions summary 不能为空白', () => {
  const problems = auditExtensions([makeExtension({ summary: '   ' })]);
  eq(problems.length, 1);
  ok(problems[0].includes('缺少说明'), `应报缺少说明,实际 ${problems[0]}`);
});

test('B27 auditExtensions 扩展之间同 ID 冲突也要报(不仅与已有内容比)', () => {
  const problems = auditExtensions([makeExtension({ ids: [900] }), makeExtension({ seq: 2, ids: [900] })]);
  eq(problems.length, 1, `应报 1 条,实际 ${JSON.stringify(problems)}`);
  ok(problems[0].includes('seq=2'), '应点名后一条');
});

test('B28 auditExtensions 能一次报出多条问题', () => {
  const problems = auditExtensions([
    makeExtension({ seq: 5, summary: '', ids: [101], needsMigration: true, migrationNote: '' }),
  ]);
  ok(problems.length >= 3, `应至少报出 3 条,实际 ${JSON.stringify(problems)}`);
  ok(problems.some((p) => p.includes('序号不连续')), '含序号');
  ok(problems.some((p) => p.includes('缺少说明')), '含说明');
  ok(problems.some((p) => p.includes('冲突')), '含冲突');
  ok(problems.some((p) => p.includes('需要迁移')), '含迁移');
});

test('B29 extensionFingerprint 幂等', () => {
  const exts = [makeExtension({ ids: [900, 901] })];
  eq(extensionFingerprint(exts), extensionFingerprint(exts));
  eq(fnv1a32('x'), fnv1a32('x'), '底层哈希也幂等');
  ok(/^[0-9a-f]{8}$/.test(extensionFingerprint(exts)));
  /* 空数组也要有稳定指纹(不抛错、不返回空串)。 */
  const empty = extensionFingerprint([]);
  eq(empty, extensionFingerprint([]));
  ok(/^[0-9a-f]{8}$/.test(empty));
  ok(empty !== extensionFingerprint(exts), '空登记与非空登记应不同');
});

test('B30 extensionFingerprint 对 ID 数组顺序不敏感(内部已 sort)', () => {
  const e1 = [makeExtension({ ids: [900, 901] })];
  const e2 = [makeExtension({ ids: [901, 900] })];
  eq(extensionFingerprint(e1), extensionFingerprint(e2), 'ID 顺序不应影响指纹');
  /* 三元素的乱序也要一致。 */
  const a = [makeExtension({ ids: [900, 901, 902] })];
  const b = [makeExtension({ ids: [902, 900, 901] })];
  const c = [makeExtension({ ids: [901, 902, 900] })];
  eq(extensionFingerprint(a), extensionFingerprint(b));
  eq(extensionFingerprint(a), extensionFingerprint(c));
});

test('B31 extensionFingerprint 对 seq/summary/ids/needsMigration 敏感', () => {
  const base = extensionFingerprint([makeExtension()]);
  ok(extensionFingerprint([makeExtension({ seq: 2 })]) !== base, 'seq 应影响指纹');
  ok(extensionFingerprint([makeExtension({ summary: '别的说明' })]) !== base, 'summary 应影响指纹');
  ok(extensionFingerprint([makeExtension({ ids: [900, 901] })]) !== base, 'ids 应影响指纹');
  ok(extensionFingerprint([makeExtension({ needsMigration: true })]) !== base, 'needsMigration 应影响指纹');
  ok(extensionFingerprint([makeExtension(), makeExtension({ seq: 2, ids: [901] })]) !== base, '条数应影响指纹');
});

test('B32 【已知行为】extensionFingerprint 不纳入 migrationNote', () => {
  /* 指纹只取 [seq, summary, ids, needsMigration] 四元组,`migrationNote`
   * 不参与。这意味着**只改迁移提示不会改变指纹** —— 若将来希望
   * 「迁移提示的每次修订都留痕」,需要把该字段加进指纹元组。
   * 本断言把现状固化,便于将来有意改动时立刻可见。
   *
   * 注意这里**不写死指纹基准值**:基准会随实现(如元组增删字段)变化,
   * 写死只会变成噪音。断言的是「相等/不相等」这个不变关系。 */
  const a = extensionFingerprint([makeExtension({ migrationNote: '' })]);
  const b = extensionFingerprint([makeExtension({ migrationNote: '把 900 映射到 901,并重写背包槽位' })]);
  eq(a, b, 'migrationNote 目前不参与指纹');
  ok(/^[0-9a-f]{8}$/.test(a), '仍应是 8 位 hex');

  /* 对照:needsMigration 是参与的,所以改了它必须变 —— 证明上一条
   * 「不变」不是因为整个函数失灵。 */
  ok(extensionFingerprint([makeExtension({ needsMigration: true })]) !== a, 'needsMigration 应参与(对照组)');
});

test('B33 extensionFingerprint 在 auditExtensions 之外独立可用(不互相依赖)', () => {
  const exts = [makeExtension({ ids: [900] })];
  /* 登记有冲突时,审计报问题,但指纹照常可算。 */
  const bad = [makeExtension({ ids: [101] })];
  ok(auditExtensions(bad).length > 0, '应报冲突');
  eq(extensionFingerprint(bad).length, 8, '指纹仍应可算');
  eq(extensionFingerprint(exts).length, 8);
  ok(/^[0-9a-f]{8}$/.test(extensionFingerprint(exts)));
});

/* ═══════════════ C. 只读校验(源码与基线文件) ═══════════════ */

test('C01 scripts/content-lock.ts 含 --capacity / --update / --audit 三个分支 + 默认比对', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'content-lock.ts'), 'utf8');
  for (const flag of ['--capacity', '--update', '--audit']) {
    ok(src.includes(flag), `源码应含 ${flag}`);
  }
  /* 第四个分支是「不给参数时的默认比对」,不是 --help。 */
  ok(src.includes('argv.includes'), '应通过 argv.includes 解析开关');
  ok(src.includes("has('capacity')"), '应有 capacity 分支');
  ok(src.includes("has('audit')"), '应有 audit 分支');
  ok(src.includes("has('update')"), '应有 update 分支');
  ok(src.includes('══ 内容基线锁 ══'), '应有默认比对分支的输出标记');
  ok(src.includes('process.exit(1)'), '不一致时应以非零码退出');
  ok(src.includes('contentFingerprintLine'), '默认分支应打印当前指纹');
  /* 如实记录:没有 --help。 */
  ok(!src.includes('--help'), '实测源码不含 --help 分支');
});

test('C02 content-lock.ts 的三个分支各自以正确退出码收尾', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'content-lock.ts'), 'utf8');
  /* --capacity / --update 是信息性输出 → exit(0)。 */
  ok(/if \(has\('capacity'\)\)[\s\S]*?process\.exit\(0\);/.test(src), '--capacity 应 exit(0)');
  ok(/if \(has\('update'\)\)[\s\S]*?process\.exit\(0\);/.test(src), '--update 应 exit(0)');
  /* --audit 按审计结果决定退出码。 */
  ok(/process\.exit\(audit\.ok \? 0 : 1\);/.test(src), '--audit 应按 ok 决定退出码');
  /* 默认比对:基线缺失 → exit(1);同步 → exit(0);漂移 → exit(1)。 */
  ok(src.includes('基线文件缺失'), '应处理基线缺失');
  ok(src.includes('内容与基线一致'), '应处理同步情形');
  ok(src.includes('内容与基线不一致'), '应处理漂移情形');
});

test('C03 content.baseline.json 存在且可 JSON.parse,含 fingerprints/counts/slots/names 四个键', () => {
  const p = defaultBaselinePath();
  ok(existsSync(p), '基线文件应存在');
  const raw = readFileSync(p, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`基线文件应为合法 JSON:${(e as Error).message}`);
  }
  for (const k of ['fingerprints', 'counts', 'slots', 'names']) {
    ok(k in parsed, `应含 ${k} 键`);
  }
  eq(Object.keys(parsed).sort(), ['_comment', 'baselineFormat', 'bossIds', 'counts', 'fingerprints', 'mobIds', 'names', 'slots']);
  eq(Object.keys(parsed.slots as object).length, ITEM_COUNT);
  eq(Object.keys(parsed.names as object).length, ITEM_COUNT);
  eq((parsed.fingerprints as { overall: string }).overall, contentFingerprints().overall);
});

test('C04 content.baseline.json 的 slots/names 与 buildBaseline() 逐项一致', () => {
  const onDisk = readBaseline();
  ok(onDisk !== null, '应能读回基线');
  const live = buildBaseline();
  eq(onDisk.slots, live.slots, '磁盘槽位应与当前内容一致');
  eq(onDisk.names, live.names, '磁盘名称应与当前内容一致');
  eq(onDisk.counts, live.counts);
  eq(onDisk.mobIds, live.mobIds);
  eq(onDisk.bossIds, live.bossIds);
});

test('C05 被测模块只从 shared/** 读取内容,不反向写入(源码级检查)', () => {
  /* 冻结层只读是硬约束。这两个模块只应 import,不应写 shared/**。 */
  for (const rel of ['server/src/content/registry.ts', 'server/src/content/baseline.ts']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    ok(!/shared[^'"]*['"][\s\S]{0,200}writeFileSync/.test(src), `${rel} 不应写 shared/**`);
    ok(src.includes('shared/constants'), `${rel} 应从 shared/constants 读取内容`);
  }
  /* registry.ts 现在还应从冻结层 types 读 ItemCategory 作权威类别清单。 */
  const reg = readFileSync(join(ROOT, 'server/src/content/registry.ts'), 'utf8');
  ok(reg.includes('ItemCategory'), 'registry.ts 应引用冻结层 ItemCategory');
});

/* ═══════════════ 收尾 ═══════════════ */

report('WS-FND-01');
