/**
 * 内容扩容非破坏性演练(EXTENDING drill)。
 *
 * 用法:
 *   node scripts/extension-drill.ts            # 全量演练,逐条打印不变量结论
 *   node scripts/extension-drill.ts --quiet    # 只打印失败项与汇总
 *   node scripts/extension-drill.ts --json     # 输出机器可读结论(供 CI 消费)
 *
 * ## 这个脚本解决什么问题
 *
 * 「加一件物品会不会弄坏别的东西」这个问题,在本项目里**已经出现过一次**:
 * `INVENTORY_SLOTS` 曾 = `TOTAL_ITEM_COUNT`,于是内容 320 → 330 时
 * 背包变成 `330/16 = 20.625` 行(半行),且 `SLOTS_PER_PAGE` 恰好 = 320
 * 使分页路径**从未被执行**过 —— 潜伏的分页 bug 要等到扩容那一刻才首次触发。
 *
 * 那次修复(WS-FND-02)只解决了背包一处。本脚本把「同一形态的耦合」
 * 逐条找出来,并用**内存假内容集**驱动,证明扩容时每条逻辑是否保持。
 *
 * ## 为什么用内存假内容集,而不是改真实常量
 *
 * `shared/**` 是冻结层,改了全员返工。更根本的原因是:**改常量只能测一种扩容**,
 * 而耦合点的失效往往是「跨过某个阈值才暴露」(例如正好整除、正好装满一页)。
 * 内存副本可以穷举 320 / 330 / 400 / 4096 等**边界值**,真实常量做不到。
 *
 * ## 判据为什么不能取被测代码自己的常量
 *
 * 这是本项目反复踩的坑(见 `registry.ts` 的 `auditContent` 注释:
 * 「用从 ITEM_LIST 自建的集合做校验」⇒ `has(it.category)` 恒真 ⇒ 检查永不失败)。
 *
 * 所以本脚本所有断言的**判据都取外部事实**:
 *   - 位宽判据取 `shared/types/tile.ts` 的 `OBJ_MASK`(冻结层),不取 `FIELD_MAX.OBJ`
 *     (后者是 `server/src/content/registry.ts` 自己算的,拿它自证是同义反复);
 *   - 布局判据取「整除」这一数学事实,不取 `INVENTORY_SLOTS % SLOTS_PER_ROW`
 *     (那是被测代码自己声明的对齐);
 *   - 容量判据取 `(1 << bits) - 1` 的算术,不取任何实现的输出。
 */

import { ITEM_LIST, ITEM_TABLES, TOTAL_ITEM_COUNT } from '../shared/constants/items.ts';
import { OBJ_MASK, OBJ_SHIFT, packTile, unpackTile } from '../shared/types/tile.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import { computeSlotLayout, SLOTS_PER_ROW, SLOTS_PER_PAGE, INVENTORY_SPARE_ROWS } from '../client/src/ui/inventory.ts';import { FIELD_MAX, contentCapacity, freeIdCount, freeIdSegments } from '../server/src/content/registry.ts';
import { auditExtensions, type ContentExtension } from '../server/src/content/baseline.ts';
import { FIELD_TABLE, FIELD_TYPE_BYTES } from '../server/src/net/schema.ts';
import { checkInventory, InventoryReject, type PlayerAntiCheatState } from '../server/src/net/anticheat.ts';
import { FOODS } from '../server/src/combat/cooking.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/* ══════════════════════════════════════════════════════════════
 * 0. 演练框架(零依赖,与 shared/testing/harness 同风格)
 * ══════════════════════════════════════════════════════════════ */

interface DrillResult {
  /** 耦合点编号,与 docs/EXTENDING.md 的表格一一对应 */
  point: string;
  title: string;
  ok: boolean;
  detail: string;
  /** 该条在哪些扩容规模下被验证过 */
  scales: string[];
}

const results: DrillResult[] = [];
const quiet = process.argv.includes('--quiet');
const jsonMode = process.argv.includes('--json');

function drill(point: string, title: string, scales: readonly (number | string)[], fn: () => string | null): void {
  let ok = true;
  let detail = '';
  try {
    const r = fn();
    if (r !== null) {
      ok = false;
      detail = r;
    } else {
      detail = '不变量保持';
    }
  } catch (err) {
    ok = false;
    detail = `抛错:${err instanceof Error ? err.message : String(err)}`;
  }
  results.push({ point, title, ok, detail, scales: scales.map(String) });
  if (jsonMode) return;
  if (quiet && ok) return;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} [${point}] ${title} — ${detail}`);
}

/* ══════════════════════════════════════════════════════════════
 * 1. 内存假内容集
 * ══════════════════════════════════════════════════════════════ */

/** 假物品的最小结构(与 ItemDef 同形,但独立于冻结层,不写入任何常量) */
export interface FakeItem {
  id: number;
  name: string;
  category: string;
  tags: string[];
  value: number;
  note: string;
}

/** 假分表(与 ITEM_TABLES 同形) */
export interface FakeTable {
  key: string;
  title: string;
  range: [number, number];
  count: number;
  ids: readonly number[];
}

export interface FakeContentSet {
  /** 规模标签,如 '320(真实基线)' */
  scale: string;
  items: FakeItem[];
  tables: FakeTable[];
  /** 本次扩容是否为「末尾追加」(相对真实基线) */
  appendedOnly: boolean;
  /** 本次扩容新增的 ID */
  addedIds: number[];
}

const CATEGORY_ROTATION: readonly string[] = [
  ItemCategory.NATURAL, ItemCategory.REFINED, ItemCategory.FLOOR,
  ItemCategory.BUILDING, ItemCategory.FURNITURE, ItemCategory.AUTOMATION,
];

/**
 * 从真实基线出发构造扩容后的假内容集。
 *
 * @param targetCount 目标总件数。320 = 真实基线(不新增);>320 则按**ID 池**
 *   取号,顺序为:先 746~4095 的大块预留区,再补内部空档(1~100、131~150 …)。
 *
 * ⚠️ 这里暴露了一个**真实容量事实**(初版脚本踩到):
 *   从 746 连续追加的**连续上界**是 `4095 − 745 = 3350` 个号,
 *   即「纯末尾追加」最多做到 `320 + 3350 = 3670` 件。
 *   想再往上到 4095 件,**必须同时动用区间之间的内部空档** ——
 *   这正是手册 `freeIdSegments()` 存在的理由。
 *   所以本函数先吃 746+,不够时再吃内部空档,并在 C2d/C2e 把两个天花板都断言下来。
 */
export function buildFakeContentSet(targetCount: number): FakeContentSet {
  const base = ITEM_LIST.map((it) => ({
    id: it.id,
    name: it.name,
    category: it.category as string,
    tags: [...it.tags],
    value: it.value,
    note: it.note,
  }));
  const items: FakeItem[] = [...base];
  const addedIds: number[] = [];
  const taken = new Set<number>(items.map((i) => i.id));

  /* ID 池分两段:先大块预留区(746+),再内部空档(升序,含 1~100 与各段间隙)。
     0 不取 —— 它是 OBJ_EMPTY,语义上「无物品」。 */
  const pool: number[] = [];
  for (let id = APPEND_BASE; id <= OBJ_CAPACITY_FROM_FROZEN; id += 1) {
    if (!taken.has(id)) pool.push(id);
  }
  for (let id = 1; id < APPEND_BASE; id += 1) {
    if (!taken.has(id)) pool.push(id);
  }

  let pi = 0;
  while (items.length < targetCount) {
    const id = pool[pi];
    if (id === undefined) {
      throw new Error(
        `假内容集无法达到 ${targetCount} 件:12 位值域共 ${OBJ_CAPACITY_FROM_FROZEN} 个可用号,` +
          `扣掉既有 ${TOTAL_ITEM_COUNT} 件后只剩 ${pool.length} 个可用号`,
      );
    }
    pi += 1;
    const cat = CATEGORY_ROTATION[items.length % CATEGORY_ROTATION.length];
    items.push({
      id,
      name: `演练假物品#${id}`,
      category: cat,
      tags: ['演练'],
      value: 10 + (id % 50),
      note: 'extension-drill 的内存副本,不属于真实内容',
    });
    addedIds.push(id);
  }

  const tables: FakeTable[] = ITEM_TABLES.map((t) => ({
    key: t.key,
    title: t.title,
    range: [t.range[0], t.range[1]] as [number, number],
    count: t.ids.length,
    ids: [...t.ids],
  }));
  return {
    scale: targetCount === TOTAL_ITEM_COUNT ? `${targetCount}(真实基线)` : `${targetCount}(假内容集)`,
    items,
    tables,
    appendedOnly: addedIds.every((id) => id >= APPEND_BASE),
    addedIds,
  };
}

/** 供外部(测试)复用的扩容规模清单 */
export const DRILL_SCALES: readonly number[] = [320, 330, 400, 4095];

/* ══════════════════════════════════════════════════════════════
 * 2. 外部事实判据(不取被测代码自己的常量)
 * ══════════════════════════════════════════════════════════════ */

/**
 * 由冻结层 12 位掩码推出的容器上限 —— 判据来自 tile.ts,不是 registry.ts。
 *
 * ⚠️ `OBJ_MASK` 是**已左移**的位段掩码(`0x0fff0000`),不是值掩码。
 * 直接拿它当容量会得到 268369920(0x0FFF0000),是本脚本初版真实踩到的错 ——
 * 而且错误方向是「看起来容量大到不可能有问题」,会让后续所有容量断言失去区分力。
 * 必须先 `>>> OBJ_SHIFT` 回到值域。
 */
export const OBJ_CAPACITY_FROM_FROZEN = OBJ_MASK >>> OBJ_SHIFT;

/** u16 字段上限(网络 weaponId / heldItemId 用) */
export const U16_CAPACITY = (1 << FIELD_TYPE_BYTES.u16 * 8) - 1;

/** 相对真实基线的追加区起点(基线最大 ID + 1) */
export const APPEND_BASE = Math.max(...ITEM_TABLES.map((t) => t.range[1])) + 1;

/**
 * 「纯末尾追加」的件数天花板:基线 + (12 位值域 − 基线最大 ID)。
 *
 * ⚠️ 必须定义在 `OBJ_CAPACITY_FROM_FROZEN` **之后**:顶层 `const` 之间存在
 * 暂时性死区(TDZ),尽管模块内函数体引用它是安全的 ——
 * 初版把它放在第 1 节,模块加载即 `ReferenceError: Cannot access ... before initialization`。
 * 这类错误只在运行时爆发,`node --check` 看不出来。
 */
export const CONTIGUOUS_APPEND_CEILING = TOTAL_ITEM_COUNT + (OBJ_CAPACITY_FROM_FROZEN - (APPEND_BASE - 1));

/** 值域能容纳的绝对件数上限(含内部空档全填) */
export const ABSOLUTE_ITEM_CEILING = OBJ_CAPACITY_FROM_FROZEN;

/** 布局是否无半行:纯数学判据,不询问被测模块「你自己对齐了吗」 */
export function isRowAlignedByMath(count: number, slotsPerRow: number, spareRows: number): boolean {
  /* 参数本身必须是合法整数 —— 否则「构造出整数行」这句话没有意义。
     注意:`rows * slotsPerRow % slotsPerRow === 0` 是**恒真的**,
     它抓不住任何东西;真正有区分力的是下面的容量/整数性检查。
     保留 mod 检查只为表达意图,判据重心在参数合法性与容量。 */
  if (!Number.isInteger(count) || count < 0) return false;
  if (!Number.isInteger(slotsPerRow) || slotsPerRow <= 0) return false;
  if (!Number.isInteger(spareRows) || spareRows < 0) return false;
  const rows = Math.max(1, Math.ceil(count / slotsPerRow) + spareRows);
  const slots = rows * slotsPerRow;
  return Number.isInteger(rows) && Number.isInteger(slots) && slots >= count;
}

/** 判据区分力自检:证明上面的合法性检查**能**返回假 */
export function alignmentCriterionHasTeeth(): boolean {
  return (
    !isRowAlignedByMath(320, 16.5, INVENTORY_SPARE_ROWS) && // 非整数每行
    !isRowAlignedByMath(-1, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS) && // 负数件数
    !isRowAlignedByMath(320, SLOTS_PER_ROW, -1) && // 负补行
    isRowAlignedByMath(320, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS) // 正例仍为真
  );
}

/* ══════════════════════════════════════════════════════════════
 * 3. 逐耦合点演练
 * ══════════════════════════════════════════════════════════════ */

function drillAll(): void {
  const sets = DRILL_SCALES.map(buildFakeContentSet);
  const scalesLabel = DRILL_SCALES.map(String);

  /* ── 点 1:背包槽位布局 / 分页(WS-FND-02 已解耦,复核) ── */
  for (const set of sets) {
    drill('C1', `背包布局无半行 + 装得下(规模 ${set.scale})`, [set.scale], () => {
      const layout = computeSlotLayout(set.items.length, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
      if (!isRowAlignedByMath(set.items.length, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS)) {
        return `数学上不可能对齐(count=${set.items.length})`;
      }
      if (layout.slots % SLOTS_PER_ROW !== 0) return `slots=${layout.slots} 不是 ${SLOTS_PER_ROW} 的整数倍(半行)`;
      if (layout.slots < set.items.length) return `容量 ${layout.slots} 装不下 ${set.items.length} 件`;
      if (layout.fits !== true) return `fits 标志为假`;
      return null;
    });
    drill('C1b', `分页非退化:每页槽位严格小于总容量(规模 ${set.scale})`, [set.scale], () => {
      const layout = computeSlotLayout(set.items.length, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
      if (SLOTS_PER_PAGE >= layout.slots) {
        return `每页 ${SLOTS_PER_PAGE} ≥ 总容量 ${layout.slots} ⇒ 分页代码路径不会被走到`;
      }
      if (layout.pageCount < 1) return `页数 ${layout.pageCount} < 1`;
      return null;
    });
  }

  /* ── 点 2:分页覆盖完整性(所有页的并集 = 全部物品,无重无漏) ── */
  for (const set of sets) {
    drill('C1c', `分页切片无重无漏(规模 ${set.scale})`, [set.scale], () => {
      const layout = computeSlotLayout(set.items.length, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
      const seen = new Set<number>();
      for (let p = 0; p < layout.pageCount; p += 1) {
        for (const it of set.items.slice(p * SLOTS_PER_PAGE, (p + 1) * SLOTS_PER_PAGE)) {
          if (seen.has(it.id)) return `物品 ${it.id} 在分页中重复出现`;
          seen.add(it.id);
        }
      }
      if (seen.size !== set.items.length) return `分页只覆盖 ${seen.size}/${set.items.length} 件`;
      return null;
    });
  }

  /* ── 点 3:蓝图 12 位 obj 字段的容量上界 ── */
  drill('C2', '12 位 obj 容量上界与冻结层掩码一致(判据取 tile.ts)', scalesLabel, () => {
    if (OBJ_CAPACITY_FROM_FROZEN !== 4095) return `冻结层推出值域宽 ${OBJ_CAPACITY_FROM_FROZEN},应为 4095`;
    if (1 << OBJ_SHIFT !== 65536) return `OBJ 位偏移应为 16(值域宽度 65536),实际 ${1 << OBJ_SHIFT}`;
    /* 掩码推导必须与实际编解码行为一致 —— 否则「推导」只是个说法。
       这一步是本脚本初版漏掉的:掩码忘了右移,推导出 268369920,
       所有容量断言随之失去区分力(容量大到不可能越界)。 */
    const okAt = unpackTile(packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 4095, meta: 0 })).obj;
    if (okAt !== 4095) return `边界值 4095 往返失败:得到 ${okAt}`;
    const overflow = unpackTile(packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 4096, meta: 0 })).obj;
    if (overflow === 4096) return '推导与行为不符:4096 竟然往返成功,说明位宽不是 12';
    return null;
  });

  drill('C2b', '超限 ID 被 packTile 静默截断(扩容必须先查容量)', scalesLabel, () => {
    const over = OBJ_CAPACITY_FROM_FROZEN + 1; // 4096
    const packed = unpackTile(packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: over, meta: 0 })).obj;
    if (packed === over) {
      return `未观察到截断 —— 若位宽已扩到能容纳 ${over},需同步更新本演练与该断言`;
    }
    /* 关键:截断结果 0 意味着「物品凭空消失」,而不是报错 */
    if (packed !== 0) return `期望截断为 0,实际 ${packed}`;
    return null;
  });

  drill('C2c', '全部假内容集都落在 12 位值域内', scalesLabel, () => {
    for (const set of sets) {
      for (const it of set.items) {
        if (it.id < 1 || it.id > OBJ_CAPACITY_FROM_FROZEN) {
          return `假内容集 ${set.scale} 的物品 ${it.id} 超出 12 位值域 1~${OBJ_CAPACITY_FROM_FROZEN}`;
        }
      }
    }
    return null;
  });

  /* ── 点 3b:两条容量天花板(纯追加 vs 含空档全填) ──
     这两个数字是扩容决策的关键输入,且很容易被想当然:
     「12 位能装 4095 件」听起来像「我可以再加 3775 件」,
     但**纯末尾追加**只能再加 3350 件(3670 封顶)。差的那 425 件
     必须去动内部空档,而那些空档插进去会不会造成槽位平移是另一回事。 */
  drill('C2d', '纯末尾追加的件数天花板 = 3670(基线 320 + 3350)', scalesLabel, () => {
    if (CONTIGUOUS_APPEND_CEILING !== 3670) {
      return `纯追加天花板应为 3670(320 + 3350),实际算出 ${CONTIGUOUS_APPEND_CEILING}`;
    }
    /* 与真实空闲号数互证:可追加号 = 12 位值域内未用号 */
    const freeAbove = OBJ_CAPACITY_FROM_FROZEN - (APPEND_BASE - 1);
    const freeTotal = freeIdCount();
    if (freeTotal - freeAbove !== 425) {
      return `内部空档应为 ${freeTotal} − ${freeAbove} = 425 个,实际 ${freeTotal - freeAbove}`;
    }
    return null;
  });

  drill('C2e', '值域绝对上限 4095 件可达,但必须动用内部空档', scalesLabel, () => {
    if (ABSOLUTE_ITEM_CEILING !== 4095) return `绝对上限应为 4095,实际 ${ABSOLUTE_ITEM_CEILING}`;
    const maxSet = buildFakeContentSet(ABSOLUTE_ITEM_CEILING);
    if (maxSet.items.length !== ABSOLUTE_ITEM_CEILING) {
      return `最大假内容集只有 ${maxSet.items.length} 件`;
    }
    /* 全部 ID 必须互不相同 —— 池子里若重复取号,件数够但内容坏了 */
    const uniq = new Set(maxSet.items.map((i) => i.id));
    if (uniq.size !== maxSet.items.length) {
      return `最大假内容集有重复 ID:${maxSet.items.length} 件但只有 ${uniq.size} 个不同 ID`;
    }
    /* 4095 件时必然用到了内部空档 ⇒ appendedOnly 应为假 */
    if (maxSet.appendedOnly) {
      return '4095 件竟全部落在末尾预留区 —— 与「纯追加上限 3670」矛盾';
    }
    if (maxSet.items.some((i) => i.id < 1 || i.id > OBJ_CAPACITY_FROM_FROZEN)) {
      return '最大假内容集出现越界 ID';
    }
    return null;
  });

  /* ── 点 4:registry 的容量 / 区间 / freeIdSegments ── */
  drill('C3', '容量账本的 freeCount 恒等于「值域宽 − 已用件数」(数学判据)', scalesLabel, () => {
    const obj = contentCapacity().find((c) => c.space.includes('OBJ'));
    if (!obj) return '容量账本里找不到 OBJ 条目';
    if (obj.freeCount !== OBJ_CAPACITY_FROM_FROZEN - TOTAL_ITEM_COUNT) {
      return `freeCount=${obj.freeCount},应为 ${OBJ_CAPACITY_FROM_FROZEN} − ${TOTAL_ITEM_COUNT} = ${OBJ_CAPACITY_FROM_FROZEN - TOTAL_ITEM_COUNT}`;
    }
    if (obj.capacity !== OBJ_CAPACITY_FROM_FROZEN) return `capacity=${obj.capacity} ≠ 冻结层掩码 ${OBJ_CAPACITY_FROM_FROZEN}`;
    return null;
  });

  drill('C3b', 'freeIdCount() 精确计数,不因 minLength 过滤而漏算短段', scalesLabel, () => {
    const exact = freeIdCount();
    const summed = freeIdSegments().reduce((n, s) => n + (s.to - s.from + 1), 0);
    if (exact !== OBJ_CAPACITY_FROM_FROZEN - TOTAL_ITEM_COUNT) {
      return `精确空闲 ${exact} ≠ ${OBJ_CAPACITY_FROM_FROZEN} − ${TOTAL_ITEM_COUNT}`;
    }
    /* 精确值必须 ≥ 求和值:求和会漏掉 <8 的短段 */
    if (exact < summed) return `精确值 ${exact} 竟小于过滤后求和 ${summed}(过滤逻辑反了)`;
    return null;
  });

  drill('C3c', '分表区间两两不重叠,且并集宽度 = 已用件数(表内紧包)', scalesLabel, () => {
    for (const t of ITEM_TABLES) {
      const span = t.range[1] - t.range[0] + 1;
      if (t.ids.length !== t.count) return `分表 ${t.key} ids.length=${t.ids.length} ≠ count=${t.count}`;
      if (span < t.count) return `分表 ${t.key} 区间宽 ${span} 装不下 ${t.count} 件`;
    }
    const ranges = ITEM_TABLES.map((t) => t.range as [number, number]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i][0] <= ranges[i - 1][1]) {
        return `分表区间重叠:[${ranges[i - 1]}] 与 [${ranges[i]}]`;
      }
    }
    return null;
  });

  drill('C3d', '扩容追加区(746+)与既有分表区间不冲突', scalesLabel, () => {
    if (APPEND_BASE !== 746) return `追加区起点应为 746,实际 ${APPEND_BASE}`;
    for (const t of ITEM_TABLES) {
      if (t.range[1] >= APPEND_BASE) return `分表 ${t.key} 区间上界 ${t.range[1]} 侵入追加区`;
    }
    return null;
  });

  /* ── 点 5:baseline slots/names 与漂移检测 ── */
  drill('C4', '末尾追加不产生槽位平移(最危险的一类静默损坏)', scalesLabel, () => {
    const baseSlots = new Map<number, number>();
    ITEM_LIST.forEach((it, i) => baseSlots.set(it.id, i));
    for (const set of sets) {
      for (let i = 0; i < Math.min(set.items.length, TOTAL_ITEM_COUNT); i += 1) {
        const expected = baseSlots.get(set.items[i].id);
        if (expected !== i) {
          return `假内容集 ${set.scale} 的第 ${i} 位是 ${set.items[i].id},基线槽位应为 ${expected} ⇒ 发生平移`;
        }
      }
    }
    return null;
  });

  drill('C4b', '非末尾插入会被槽位检测捕获(检测器本身有效)', scalesLabel, () => {
    /* 构造一个「在中间插队」的假内容集,验证检测逻辑不是摆设 */
    const items = ITEM_LIST.map((it) => ({ id: it.id, name: it.name }));
    items.splice(5, 0, { id: 9001, name: '插队假物品' });
    const shifted: string[] = [];
    items.forEach((it, i) => {
      const expected = ITEM_LIST.findIndex((b) => b.id === it.id);
      if (expected !== -1 && expected !== i) shifted.push(`${it.id}:${expected}→${i}`);
    });
    if (shifted.length === 0) {
      return '中间插入竟未造成任何平移 —— 检测逻辑失效(断言无区分力)';
    }
    return null;
  });

  /* ── 点 6:网络差量编码里的物品 ID 位宽 ── */
  drill('C5', 'weaponId / heldItemId 用 u16,容量与 12 位 obj 不同(需登记)', scalesLabel, () => {
    const w = FIELD_TABLE.find((f) => f.key === 'weaponId');
    const h = FIELD_TABLE.find((f) => f.key === 'heldItemId');
    if (!w || !h) return 'FIELD_TABLE 缺少 weaponId / heldItemId 字段';
    if (w.type !== 'u16' || h.type !== 'u16') return `期望 u16,实际 ${w.type} / ${h.type}`;
    if (U16_CAPACITY <= OBJ_CAPACITY_FROM_FROZEN) {
      return `u16 上限 ${U16_CAPACITY} 应大于 12 位上限 ${OBJ_CAPACITY_FROM_FROZEN}`;
    }
    /* 关键不变量:凡是「能进蓝图 obj 的 ID」必须同时能被 u16 网络字段承载 */
    if (OBJ_CAPACITY_FROM_FROZEN > U16_CAPACITY) {
      return `12 位值域 ${OBJ_CAPACITY_FROM_FROZEN} 超出 u16 容量 ${U16_CAPACITY} ⇒ 网络层会截断`;
    }
    return null;
  });

  drill('C5b', '两个 ID 通道的位宽差异已登记(12 位是更紧的约束)', scalesLabel, () => {
    const tighter = Math.min(OBJ_CAPACITY_FROM_FROZEN, U16_CAPACITY);
    if (tighter !== OBJ_CAPACITY_FROM_FROZEN) {
      return `更紧的通道应是 12 位 obj(${OBJ_CAPACITY_FROM_FROZEN}),实际 ${tighter}`;
    }
    return null;
  });

  /* ── 点 7:反作弊 checkInventory 的物品 ID 边界 ── */
  drill('C6', '反作弊按「总量守恒」判定,不对 itemId 设上界(扩容不误伤)', scalesLabel, () => {
    const st = { id: 'drill', violations: [], score: 0, kicked: false, lastAttackTick: -1 } as unknown as PlayerAntiCheatState;
    const sources = new Set(['drill:source']);
    /* 用一个远超 12 位值域的 itemId:反作弊只应关心总量,不应因 ID 大而拒绝 */
    const r = checkInventory(st, {
      tick: 1,
      ops: [{ itemId: 99999, delta: 1, source: 'drill:source' }],
      allowedSources: sources,
      beforeTotal: 0,
      capacity: 336,
    });
    if (!r.allowed) return `大 itemId 被拒:${r.rejectCode} —— 反作弊不应与 ID 值域耦合`;
    if (r.afterTotal !== 1) return `afterTotal=${r.afterTotal},应为 1`;
    return null;
  });

  drill('C6b', '反作弊的守恒律仍然有效(大 ID 不绕过检查)', scalesLabel, () => {
    const st = { id: 'drill2', violations: [], score: 0, kicked: false, lastAttackTick: -1 } as unknown as PlayerAntiCheatState;
    /* 凭空产出必须被拒 —— 用大 ID 也一样 */
    const r1 = checkInventory(st, {
      tick: 1, ops: [{ itemId: 99999, delta: 1 }],
      allowedSources: new Set(), beforeTotal: 0, capacity: 336,
    });
    if (r1.allowed || r1.rejectCode !== InventoryReject.FROM_NOTHING) {
      return `凭空产出未被拒(实际 allowed=${r1.allowed} code=${r1.rejectCode})`;
    }
    /* 容量溢出必须被拒:用扩容后的容量 */
    const r2 = checkInventory(st, {
      tick: 2, ops: [{ itemId: 900, delta: 1, source: 'drill:source' }],
      allowedSources: new Set(['drill:source']), beforeTotal: 336, capacity: 336,
    });
    if (r2.allowed || r2.rejectCode !== InventoryReject.OVERFLOW) {
      return `容量溢出未被拒(实际 allowed=${r2.allowed} code=${r2.rejectCode})`;
    }
    return null;
  });

  drill('C6c', '容量参数由调用方传入,扩容只需改传参而不改反作弊代码', scalesLabel, () => {
    const st = { id: 'drill3', violations: [], score: 0, kicked: false, lastAttackTick: -1 } as unknown as PlayerAntiCheatState;
    /* 同一份 ops、同一份 beforeTotal,只因 capacity 不同而结论不同 ⇒ 证明容量是外部输入 */
    const tight = checkInventory(st, {
      tick: 1, ops: [{ itemId: 900, delta: 1, source: 's' }],
      allowedSources: new Set(['s']), beforeTotal: 336, capacity: 336,
    });
    const roomy = checkInventory(st, {
      tick: 2, ops: [{ itemId: 900, delta: 1, source: 's' }],
      allowedSources: new Set(['s']), beforeTotal: 336, capacity: 400,
    });
    if (tight.allowed) return '容量 336 时不应通过';
    if (!roomy.allowed) return '容量 400 时应通过 —— 说明容量未被当作外部输入';
    return null;
  });

  /* ── 点 8:料理 / 配方表对物品 ID 的引用闭合 ── */
  drill('C7', '料理表引用的物品 ID 全部真实存在(无悬空引用)', scalesLabel, () => {
    const ids = new Set(ITEM_LIST.map((i) => i.id));
    for (const f of FOODS) {
      if (!ids.has(f.id)) return `料理 ${f.id}(${f.name})不在物品表中`;
    }
    return null;
  });

  drill('C7b', '假内容集扩容后,既有料理引用仍然闭合(追加不破坏引用)', scalesLabel, () => {
    for (const set of sets) {
      const ids = new Set(set.items.map((i) => i.id));
      for (const f of FOODS) {
        if (!ids.has(f.id)) return `假内容集 ${set.scale} 丢失了料理引用的物品 ${f.id}`;
      }
    }
    return null;
  });

  /* ── 点 9:ITEM_TABLES 分表结构与 freeIdCount ── */
  drill('C8', '分表 count 之和 = 物品件数 = 各表 ids 并集大小(三方互证)', scalesLabel, () => {
    const sumCounts = ITEM_TABLES.reduce((s, t) => s + t.count, 0);
    const union = new Set<number>();
    for (const t of ITEM_TABLES) for (const id of t.ids) union.add(id);
    if (sumCounts !== union.size) return `Σcount=${sumCounts} ≠ 并集=${union.size}(分表之间有重叠或漏登记)`;
    if (sumCounts !== ITEM_LIST.length) return `Σcount=${sumCounts} ≠ ITEM_LIST.length=${ITEM_LIST.length}`;
    if (ITEM_LIST.length !== TOTAL_ITEM_COUNT) return `ITEM_LIST=${ITEM_LIST.length} ≠ TOTAL_ITEM_COUNT=${TOTAL_ITEM_COUNT}`;
    return null;
  });

  drill('C8b', '扩容不改变既有分表结构(追加区独立于十大分表)', scalesLabel, () => {
    for (const set of sets) {
      if (set.tables.length !== ITEM_TABLES.length) {
        return `假内容集 ${set.scale} 的分表数 ${set.tables.length} ≠ ${ITEM_TABLES.length}`;
      }
      for (let i = 0; i < set.tables.length; i += 1) {
        if (set.tables[i].count !== ITEM_TABLES[i].count) {
          return `假内容集 ${set.scale} 的分表 ${set.tables[i].key} count 被改动`;
        }
      }
    }
    return null;
  });

  /* ── 点 10:扩展登记校验 ── */
  drill('C9', '扩展登记:序号连续 / ID 不冲突 / 迁移提示齐备', scalesLabel, () => {
    const good: ContentExtension[] = [
      { seq: 1, summary: '演练:追加预留区物品', ids: [746, 747], needsMigration: true, migrationNote: '旧存档无此 ID,按空处理' },
    ];
    const problems = auditExtensions(good);
    if (problems.length > 0) return `合法登记竟报错:${problems.join(' / ')}`;

    /* 反向:漏写迁移提示必须被捕获 —— 证明校验有区分力 */
    const bad: ContentExtension[] = [
      { seq: 1, summary: '演练:缺迁移提示', ids: [746], needsMigration: true, migrationNote: '' },
    ];
    const badProblems = auditExtensions(bad);
    if (badProblems.length === 0) return '缺迁移提示竟通过 —— 校验无区分力';
    return null;
  });

  drill('C9b', '扩展登记的 ID 与既有内容冲突时必须报错', scalesLabel, () => {
    const clash: ContentExtension[] = [
      { seq: 1, summary: '演练:ID 冲突', ids: [101], needsMigration: false, migrationNote: '' },
    ];
    const p = auditExtensions(clash);
    if (p.length === 0) return 'ID 与既有内容冲突竟通过';
    return null;
  });
}

/* ══════════════════════════════════════════════════════════════
 * 5. 真实源码故障注入(显式模式,默认不运行)
 *
 * ## 为什么必须是显式模式,而不是自动跑在测试里
 *
 * 初版把注入写进 `tests/WS-FND-04.test.ts`,由测试自动改真实源码再还原。
 * 那在本项目是**危险**的:8 个 agent 并行共用同一文件系统,
 * 且注入目标(`client/src/ui/inventory.ts`、`server/src/content/baseline.ts`)
 * 根本不在本任务写入范围内。实测抓到过事故现场:
 * 探查时 `extension-drill.ts` 停在注入态(hash 7B0A0309)、且还原被跳过,
 * 若有队友此刻跑 `verify.ts` 就会读到损坏的源码。
 *
 * 教训与 `extension-drill.ts` 自身初版一致 —— **不可重入的副作用不该藏在别人的流程里**。
 * 所以注入改为:显式 `--verify-faults` 才跑、单进程串行、每步核对 hash。
 *
 * 用法:
 *   node scripts/extension-drill.ts --verify-faults
 * ══════════════════════════════════════════════════════════════ */

const ROOT = join(import.meta.dirname, '..');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface FaultSpec {
  /** 相对仓库根 */
  file: string;
  /** 必须存在的锚点,防止源码漂移后误改 */
  find: string;
  replace: string;
  what: string;
  /** 预期变红的用例前缀 */
  expect: readonly string[];
}

const FAULTS: readonly FaultSpec[] = [
  {
    file: 'scripts/extension-drill.ts',
    find: 'export const OBJ_CAPACITY_FROM_FROZEN = OBJ_MASK >>> OBJ_SHIFT;',
    replace: 'export const OBJ_CAPACITY_FROM_FROZEN = OBJ_MASK; // 注入:故意漏掉右移',
    what: '容量判据漏掉 >>> OBJ_SHIFT',
    expect: ['A1 ', 'C3-1'],
  },
  {
    file: 'server/src/content/baseline.ts',
    find:
      '    if (e.needsMigration && e.migrationNote.trim().length === 0) {\n' +
      '      problems.push(`扩展登记 seq=${e.seq} 声明需要迁移但未给出迁移提示`);\n' +
      '    }',
    replace: '    // 注入:故意去掉迁移提示校验',
    what: '扩展登记去掉迁移提示校验',
    expect: ['C9-1'],
  },
  {
    file: 'client/src/ui/inventory.ts',
    find: '  const slots = rows * spr;',
    /* 复用上文已声明的 `n`(= 件数),复现 WS-FND-02 修复前的「槽位 = 件数」形态。
       不可重复声明 `const n`,那会变成语法错误而不是行为注入。 */
    replace: '  const slots = n; // 注入:退回「槽位 = 件数」',
    what: 'computeSlotLayout 退回「槽位 = 件数」',
    expect: ['C1-4'],
  },
];

function parseFailedNames(out: string): string[] {
  const names: string[] = [];
  for (const m of out.matchAll(/\u2717 \[WS-FND-04\]\s*(.+?)\s*\u2014/g)) names.push(m[1].trim());
  return names;
}

function runFaults(): void {
  console.log('══ 真实源码故障注入(显式模式)══\n');
  console.log('  说明:本模式会**临时修改真实源码**,逐个跑套件后立即还原。');
  console.log('  并发警告:运行期间请勿让其它进程执行 verify.ts 或改这些文件。\n');

  let allOk = true;
  for (const f of FAULTS) {
    const abs = join(ROOT, f.file);
    const original = readFileSync(abs, 'utf8');
    const before = sha256(original);

    if (!original.includes(f.find)) {
      console.log(`  \x1b[33m⊘\x1b[0m ${f.what} — 锚点不存在(源码已漂移),跳过`);
      allOk = false;
      continue;
    }
    const injected = original.replace(f.find, () => f.replace);
    if (injected === original) {
      console.log(`  \x1b[33m⊘\x1b[0m ${f.what} — 替换未改变内容,跳过`);
      allOk = false;
      continue;
    }

    let failed: string[] = [];
    let restoreError: string | null = null;
    try {
      writeFileSync(abs, injected, 'utf8');
      const r = spawnSync(process.execPath, ['tests/WS-FND-04.test.ts'], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, FND04_FAULT_CHILD: '1' },
      });
      failed = parseFailedNames(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    } finally {
      const now = readFileSync(abs, 'utf8');
      if (now === injected) {
        writeFileSync(abs, original, 'utf8');
      } else {
        restoreError = `${f.file} 在注入窗口内被其它进程改写,未自动还原以免覆盖他人改动`;
      }
    }

    const after = sha256(readFileSync(abs, 'utf8'));
    const restored = after === before;
    const hit = f.expect.every((p) => failed.some((n) => n.startsWith(p)));
    const okRow = restored && hit && restoreError === null;
    if (!okRow) allOk = false;

    const mark = okRow ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${f.what}`);
    console.log(`      预期变红:${f.expect.join(', ')} → 实际变红 ${failed.length} 条`);
    /* 打印实际变红项 —— 这是本节最有价值的证据:
       它回答的是「真实源码坏掉时,到底哪几条断言会报警」。 */
    for (const n of failed) console.log(`        · ${n.slice(0, 60)}`);
    if (!hit) console.log(`      \x1b[31m未命中预期用例!\x1b[0m`);
    console.log(`      还原:SHA-256 ${before.slice(0, 16)}… → ${after.slice(0, 16)}… ${restored ? '\x1b[32m一致\x1b[0m' : '\x1b[31m不一致!\x1b[0m'}`);
    if (restoreError) console.log(`      \x1b[31m${restoreError}\x1b[0m`);
    console.log('');
  }

  console.log(
    allOk
      ? '  \x1b[32m✓ 三次注入全部:源码坏 → 套件红 → 已还原(字节一致)\x1b[0m'
      : '  \x1b[31m✗ 有注入未按预期红,或未干净还原\x1b[0m',
  );
  process.exitCode = allOk ? 0 : 1;
}

/* ══════════════════════════════════════════════════════════════
 * 6. 主流程
 *
 * ⚠️ 必须**只在被直接执行时**运行,不能在被 `import` 时运行。
 *
 * `tests/WS-FND-04.test.ts` 会 import 本模块以复用假内容集与判据,
 * 若无条件执行主流程会有两个后果:
 *   1. 测试输出里插进一大段演练日志,把套件的 `N/N 通过` 汇总行冲散 ——
 *      而 `verify.ts` 是靠解析**最后一个** `N/N 通过` 来统计断言数的;
 *   2. 演练失败时它会改写 `process.exitCode`,让「测试通过」却退出码 1。
 *
 * 这正是本脚本初版真实发生的问题(测试输出 38/39 通过但 EXIT=1)。
 * ══════════════════════════════════════════════════════════════ */

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  /* Windows 路径分隔符与大小写都不敏感,统一归一再比 */
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  return norm(import.meta.url).endsWith(norm(entry));
}

if (isDirectRun()) {
  if (process.argv.includes('--verify-faults')) {
    runFaults();
  } else {
    if (!jsonMode) {
      console.log('══ 内容扩容非破坏性演练 ══\n');
      console.log(`  真实基线:${TOTAL_ITEM_COUNT} 件 / ${ITEM_TABLES.length} 分表 / 12 位 obj 值域 ${OBJ_CAPACITY_FROM_FROZEN}`);
      console.log(`  演练规模:${DRILL_SCALES.join(' → ')} 件(内存假内容集,不改冻结层)\n`);
      console.log('  ── 逐耦合点结论 ──');
    }

    drillAll();

    const failed = results.filter((r) => !r.ok);

    if (jsonMode) {
      console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
    } else {
      console.log(`\n  ── 汇总 ──`);
      console.log(`  耦合点演练:${results.length - failed.length}/${results.length} 条不变量保持`);
      if (failed.length > 0) {
        console.log(`\n  \x1b[31m✗ 有 ${failed.length} 条不变量被破坏:\x1b[0m`);
        for (const f of failed) console.log(`    [${f.point}] ${f.title} — ${f.detail}`);
      }
      console.log(`\n  ${failed.length === 0 ? '\x1b[32m✓ 扩容演练通过:追加内容不破坏任何已检查的不变量\x1b[0m' : '\x1b[31m✗ 扩容演练失败\x1b[0m'}`);
    }

    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}
