/**
 * **内容计数基线**的唯一事实源(BACKLOG-108 §3 第 6 组 / RULINGS-DRAFT §4.4 EXTENDING U1)。
 *
 * ## 修的是什么
 *
 * `scripts/verify.ts` 的「冻结层不变量」一节里,物品数与十大分表数是**写死的字面量**:
 *
 * ```
 * if (items.ITEM_LIST.length !== 320) fail(...)
 * const expected = { '3.1': 30, '3.2': 20, ... }
 * ```
 *
 * 台账 EXTENDING U1 的自述是「**有意硬编码**;扩容时必须同步」。问题是:
 *
 * 1. 「必须同步」这句话**没有判据**——扩容的人改了 `shared/constants/items.ts`,
 *    门禁只会报「物品总数 330 ≠ 320」,而**那句提示告诉你去改门禁代码**,
 *    也就是**为了加 10 件物品而去改门禁**。这是把「内容变更」与「判据变更」
 *    混成一件事的典型形态(本仓形态 4)。
 * 2. 十条分表数**各抄一遍**在门禁里 ⇒ 与 `ITEM_TABLES[key].count` 是**同一事实的两个来源**
 *    ⇒ 必然漂移(本仓陷阱:一个数被写两次,两个来源迟早不一致)。
 *
 * ## 修法
 *
 * 判据从「**字面量 320**」改成「**基线文件**」。增量成本从「改门禁源码」变成
 * 「跑一条 --update」,而**漂移仍然会红**(并且能报出**差多少**)。
 * 这与 `content-lock.ts` / `typecheck-baseline.json` 是同一思路:
 * **基线锁的语义是「只准按流程变」,不是「永远不变」。**
 *
 * ## 为什么把测量与比对放在本文件,而不是照抄进 verify.ts
 *
 * 若 verify.ts 自带一份测量、本文件自带一份 ⇒ 两份口径必然漂移(陷阱 31/41)。
 * 故 `verify.ts` 只调用 `measureItemCounts` / `readItemBaseline` / `diffItemCounts`,
 * 判据只有一份。
 *
 * ## 用法
 *
 * ```
 * node scripts/items-baseline.ts            # 只报差(与门禁同一判据),有差 exit 1
 * node scripts/items-baseline.ts --update   # 按当前实测重写基线文件(有意扩容时用)
 * ```
 *
 * ⚠️ `--update` **不给门禁自动调用**:那会让「容我之后改」变成「永远一致」,
 * 于是这个数再也不能告诉你任何事(自我复述,不是校验)。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEM_LIST, ITEM_TABLES } from '../shared/constants/items.ts';

/** 仓库根(本文件在 `scripts/` 下)。 */
export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 基线文件位置:`scripts/items-baseline.json`。 */
export const ITEMS_BASELINE_PATH = join(ROOT, 'scripts', 'items-baseline.json');

/** 一张分表的两个数:`count` = 手册声明的条数;`ids` = 代码里真有的条数。 */
export interface TableCount {
  count: number;
  ids: number;
}

/** 内容计数的全部事实。 */
export interface ItemCounts {
  /** `ITEM_LIST.length` —— 真实物品条目数。 */
  itemCount: number;
  /** `ITEM_TABLES.length` —— 分表个数。 */
  tableCount: number;
  /** 各分表:`key` → { 声明条数, 实际条目数 }。 */
  tables: Record<string, TableCount>;
  /** 所有分表**实际条目数**之和(应与 `itemCount` 相等)。 */
  tableSum: number;
}

/** 从 `shared/constants/items.ts` **实测**当前计数(唯一测量口径)。 */
export function measureItemCounts(): ItemCounts {
  const tables: Record<string, TableCount> = {};
  let tableSum = 0;
  for (const t of ITEM_TABLES) {
    tables[t.key] = { count: t.count, ids: t.ids.length };
    tableSum += t.ids.length;
  }
  return { itemCount: ITEM_LIST.length, tableCount: ITEM_TABLES.length, tables, tableSum };
}

/** 读基线文件。`null` = 文件缺失或不可解析(**不是**"通过")。 */
export function readItemBaseline(path = ITEMS_BASELINE_PATH): ItemCounts | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      itemCount?: unknown; tableCount?: unknown; tableSum?: unknown; tables?: unknown;
    };
    if (typeof raw.itemCount !== 'number' || typeof raw.tableCount !== 'number'
      || typeof raw.tableSum !== 'number' || raw.tables === null || typeof raw.tables !== 'object') {
      return null;
    }
    const tables: Record<string, TableCount> = {};
    for (const [k, v] of Object.entries(raw.tables as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') return null;
      const c = (v as { count?: unknown }).count;
      const i = (v as { ids?: unknown }).ids;
      if (typeof c !== 'number' || typeof i !== 'number') return null;
      tables[k] = { count: c, ids: i };
    }
    return { itemCount: raw.itemCount, tableCount: raw.tableCount, tableSum: raw.tableSum, tables };
  } catch {
    return null;
  }
}

/**
 * 比对基线 vs 实测,返回**人类可读的差**(空数组 = 一致)。
 *
 * ⚠️ 两个方向都报:基线比实测大(内容被删)与基线比实测小(内容被加)是
 * **不同的事件**,提示语也不同 —— 只报"不一致"会让读者不知道往哪边改。
 */
export function diffItemCounts(baseline: ItemCounts, measured: ItemCounts): string[] {
  const out: string[] = [];
  if (baseline.itemCount !== measured.itemCount) {
    out.push(
      `物品总数:基线 ${baseline.itemCount} / 实测 ${measured.itemCount}`
      + `(差 ${measured.itemCount - baseline.itemCount > 0 ? '+' : ''}${measured.itemCount - baseline.itemCount})`,
    );
  }
  if (baseline.tableCount !== measured.tableCount) {
    out.push(`分表个数:基线 ${baseline.tableCount} / 实测 ${measured.tableCount}`);
  }
  if (baseline.tableSum !== measured.tableSum) {
    out.push(`分表条目合计:基线 ${baseline.tableSum} / 实测 ${measured.tableSum}`);
  }
  const keys = [...new Set([...Object.keys(baseline.tables), ...Object.keys(measured.tables)])].sort();
  for (const k of keys) {
    const b = baseline.tables[k];
    const m = measured.tables[k];
    if (b === undefined) { out.push(`分表 ${k}:基线里没有,实测 ${m?.ids ?? '?'} 条`); continue; }
    if (m === undefined) { out.push(`分表 ${k}:基线有 ${b.ids} 条,实测**整表消失**`); continue; }
    if (b.ids !== m.ids) out.push(`分表 ${k} 条目数:基线 ${b.ids} / 实测 ${m.ids}`);
    if (b.count !== m.count) out.push(`分表 ${k} 声明数(count):基线 ${b.count} / 实测 ${m.count}`);
  }
  /* 基线文件自己也要自洽:否则"基线"本身是错的,比对就是两个错互相确认 */
  if (baseline.tableSum !== baseline.itemCount) {
    out.push(`基线文件**自身不自洽**:分表合计 ${baseline.tableSum} ≠ 物品总数 ${baseline.itemCount}`);
  }
  return out;
}

/** 把实测写回基线文件(有意扩容时用)。 */
export function writeItemBaseline(measured: ItemCounts, path = ITEMS_BASELINE_PATH): void {
  const body = {
    _readme:
      '内容计数基线(物品 / 十大分表)。判据见 scripts/items-baseline.ts 顶部注释。'
      + '有意扩容时:node scripts/items-baseline.ts --update;并同步 README 与手册。',
    generated: new Date().toISOString().slice(0, 10),
    itemCount: measured.itemCount,
    tableCount: measured.tableCount,
    tableSum: measured.tableSum,
    tables: measured.tables,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function main(): void {
  const measured = measureItemCounts();
  const update = process.argv.includes('--update');
  if (update) {
    writeItemBaseline(measured);
    console.log(`✓ 已写入基线:${ITEM_LIST.length} 件 / ${ITEM_TABLES.length} 张分表 / 合计 ${measured.tableSum}`);
    return;
  }
  const baseline = readItemBaseline();
  if (baseline === null) {
    console.error(`  ✗ 基线文件缺失或不可解析:${ITEMS_BASELINE_PATH}`);
    console.error('    修法:node scripts/items-baseline.ts --update');
    process.exitCode = 1;
    return;
  }
  const diff = diffItemCounts(baseline, measured);
  if (diff.length > 0) {
    console.error(`  ✗ 基线文件与实测有 ${diff.length} 处差:`);
    for (const d of diff) console.error(`      · ${d}`);
    console.error('    修法:宽带确认后 node scripts/items-baseline.ts --update,并同步 README / 手册');
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ 基线一致(${measured.itemCount} 件 / ${measured.tableCount} 张分表 / 合计 ${measured.tableSum})`);
}

if (import.meta.main) main();