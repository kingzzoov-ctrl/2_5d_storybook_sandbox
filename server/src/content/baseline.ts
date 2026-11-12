/**
 * 内容基线锁 —— 把「内容变更」从静默事件变成可见决策点。
 *
 * ## ⚠ 主人归属(task-37 判定,2026-11-12):**门禁**,不是生产编排
 *
 * 本模块在生产运行时**零引用是对的** —— 它的职责是「验证时比对内容」,
 * 不是「运行时执行内容」。实际引用它的有三处门禁/工具(均为代码级 import):
 *   - `scripts/content-lock.ts:22`(内容锁 CLI 的主体)
 *   - `scripts/verify.ts:3212`(动态 import,返回值在 `:3220` 被真正使用)
 *   - `scripts/extension-drill.ts:42`(扩容演练)
 *
 * ⇒ 「生产零引用」**不该被算作欠账**。`orphan-audit.ts` 把它列进去,
 * 是因为该审计只把 `server/src` + `client/src` 当「生产侧」——
 * 这是**审计口径缺陷**,不是代码缺陷(已由 `tests/WS-07.test.ts` 的
 * 「task-37 判定2」钉住)。
 *
 * ⚠ 但**不能**用「把 `scripts/**` 并入生产侧」来修:那会让**只被门禁读一下**
 * 的模块从缺账里消失,而它们运行时仍不执行 —— 属「掩盖型误报」。
 * 正确修法是**新增 `gate-only` 类别**(见 task-37 报告)。
 *
 * ## 问题
 *
 * 内容 ID 被三处引用:
 *   - 存档:`users.held_item_id`、`users.weapon_id`、`users.inventory_json`
 *   - 网络:蓝图里的 12 位 `obj` 字段
 *   - 炼金:`ai_alchemy_recipes.recipe_hash`(由物品 ID 排序拼接而成)
 *
 * 也就是说,**物品 ID 是持久化身份**。而 `shared/constants/items.ts` 是
 * 一个普通数组常量 —— 改动它不会有任何提示:
 *
 *   - 删掉物品 351 → 旧存档里的 351 变成悬空 ID,读到 `undefined`,不报错;
 *   - 把 351 改成别的物品 → 旧存档里的 351 静默变成「另一个东西」;
 *   - 数值调整(hp/exp/value) → 老版本存档的平衡性被追溯改变。
 *
 * 对照:`server/src/db/repo.ts` 的 `schema_migrations` 已经覆盖了 **DDL** 变更
 * (带 checksum,fail-closed),但**内容表**变更无人看管。
 *
 * ## 方案
 *
 * 生成一份**基线锁文件**,记录当前内容的指纹与关键 ID 映射。
 * 每次验证时比对:
 *
 *   - 指纹一致 → 内容未变,基线有效;
 *   - 指纹不一致 → **报出具体差异**(新增/删除/改动/槽位平移),
 *     由人决定这是「有意扩展」还是「意外改动」。
 *
 * 有意扩展时,重新生成基线(`--update-baseline`)并在变更登记里记一笔 ——
 * 这就把一次静默的内容改动,变成了一次**留痕的决策**。
 *
 * ## 槽位平移检测(最容易漏的一类)
 *
 * 背包槽位当前定义为 `ITEM_LIST` 的数组下标。**在非末尾位置插入物品,
 * 会让其后所有物品的槽位平移**,而槽位在 UI 与将来的存档里都被当作「格位」。
 * 平移本身不报错,所以单看指纹变化看不出危险。这里单独检测并**高亮**。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ITEM_LIST } from '../../../shared/constants/items.ts';
import { MOB_LIST } from '../../../shared/constants/mobs.ts';
import { BOSS_LIST, PARTY_MODES, ROOM_RECIPES } from '../../../shared/constants/bosses.ts';
import { contentFingerprints, fnv1a32 } from './registry.ts';

/** 基线文件默认路径:随仓库走,便于 code review 时看到差异。 */
export function defaultBaselinePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'content.baseline.json');
}

/** 基线文件的结构。 */
export interface ContentBaseline {
  /** 生成说明。 */
  _comment: string;
  /** 基线格式版本(与内容指纹版本独立演进)。 */
  baselineFormat: number;
  /** 内容指纹。 */
  fingerprints: ReturnType<typeof contentFingerprints>;
  /** 各类内容数量。 */
  counts: { items: number; mobs: number; bosses: number; modes: number; rooms: number };
  /** 物品 ID → 背包槽位(用于检测槽位平移)。 */
  slots: Record<string, number>;
  /** 物品 ID → 名称(用于检测「同一 ID 换了名字」)。 */
  names: Record<string, string>;
  /** 生物/Boss 的 ID 列表(字符串 ID,仅记存在性)。 */
  mobIds: string[];
  bossIds: string[];
}

/** 生成当前内容的基线。 */
export function buildBaseline(): ContentBaseline {
  const slots: Record<string, number> = {};
  const names: Record<string, string> = {};
  ITEM_LIST.forEach((it, i) => {
    slots[String(it.id)] = i;
    names[String(it.id)] = it.name;
  });
  return {
    _comment:
      '内容基线锁。生成:`node scripts/content-lock.ts --update`。' +
      '内容更改后必须重新生成并在 docs/CHANGE_REQUESTS.md 记一笔,否则验证会报出差异。',
    baselineFormat: 1,
    fingerprints: contentFingerprints(),
    counts: {
      items: ITEM_LIST.length,
      mobs: MOB_LIST.length,
      bosses: BOSS_LIST.length,
      modes: PARTY_MODES.length,
      rooms: ROOM_RECIPES.length,
    },
    slots,
    names,
    mobIds: MOB_LIST.map((m) => m.id),
    bossIds: BOSS_LIST.map((b) => b.id),
  };
}

/** 基线漂移报告。 */
export interface BaselineDrift {
  /** 基线文件是否存在。 */
  present: boolean;
  /** 内容是否与基线一致。 */
  inSync: boolean;
  /** 指纹是否一致。 */
  fingerprintMatches: boolean;
  /** 差异条目(人类可读)。 */
  changes: string[];
  /** 槽位平移(单独高亮:这类变化最容易被忽略且后果最重)。 */
  slotShifts: string[];
  /** 新增的物品 ID。 */
  addedIds: number[];
  /** 删除的物品 ID。 */
  removedIds: number[];
  /** 同一 ID 名称改变的条目。 */
  renamedIds: number[];
}

/**
 * 比对当前内容与基线。
 *
 * `baseline` 为 `null` 表示基线文件缺失 —— 这**不是通过**,而是
 * 「无法判断内容是否被改过」。调用方(验证器)应据此报错,
 * 否则首次运行会假绿。
 */
export function diffBaseline(baseline: ContentBaseline | null): BaselineDrift {
  const drift: BaselineDrift = {
    present: baseline !== null,
    inSync: false,
    fingerprintMatches: false,
    changes: [],
    slotShifts: [],
    addedIds: [],
    removedIds: [],
    renamedIds: [],
  };
  if (!baseline) {
    drift.changes.push('基线文件缺失,无法判断内容是否被改动');
    return drift;
  }

  const now = buildBaseline();
  drift.fingerprintMatches = now.fingerprints.overall === baseline.fingerprints.overall;

  /* — 数量差异 — */
  for (const k of ['items', 'mobs', 'bosses', 'modes', 'rooms'] as const) {
    const a = baseline.counts[k];
    const b = now.counts[k];
    if (a !== b) drift.changes.push(`${k} 数量 ${a} → ${b}(${b - a > 0 ? '+' : ''}${b - a})`);
  }

  /* — 指纹分区差异 — */
  for (const k of ['items', 'mobs', 'bosses', 'modes'] as const) {
    if (baseline.fingerprints[k] !== now.fingerprints[k]) {
      drift.changes.push(`${k} 指纹 ${baseline.fingerprints[k]} → ${now.fingerprints[k]}`);
    }
  }

  /* — 新增 / 删除 — */
  const oldIds = new Set(Object.keys(baseline.names).map(Number));
  const newIds = new Set(Object.keys(now.names).map(Number));
  drift.addedIds = [...newIds].filter((id) => !oldIds.has(id)).sort((a, b) => a - b);
  drift.removedIds = [...oldIds].filter((id) => !newIds.has(id)).sort((a, b) => a - b);
  if (drift.addedIds.length > 0) drift.changes.push(`新增物品 ${drift.addedIds.length} 件:${drift.addedIds.join(', ')}`);
  if (drift.removedIds.length > 0) {
    drift.changes.push(`删除物品 ${drift.removedIds.length} 件:${drift.removedIds.join(', ')}(旧存档引用将悬空)`);
  }

  /* — 同 ID 改名 — */
  for (const id of newIds) {
    if (!oldIds.has(id)) continue;
    const a = baseline.names[String(id)];
    const b = now.names[String(id)];
    if (a !== b) {
      drift.renamedIds.push(id);
      drift.changes.push(`物品 ${id} 改名:${a} → ${b}(旧存档会读到「另一个东西」)`);
    }
  }

  /* — 槽位平移:最危险的一类,单独列出 — */
  for (const id of newIds) {
    if (!oldIds.has(id)) continue;
    const a = baseline.slots[String(id)];
    const b = now.slots[String(id)];
    if (a !== undefined && b !== undefined && a !== b) {
      drift.slotShifts.push(`物品 ${id}(${now.names[String(id)]})槽位 ${a} → ${b}`);
    }
  }
  if (drift.slotShifts.length > 0) {
    drift.changes.push(
      `槽位平移 ${drift.slotShifts.length} 项 —— 背包格位定义为 ITEM_LIST 数组下标,` +
        `非末尾插入会让其后全部物品平移。若槽位已被持久化,旧存档背包将整体错位。`,
    );
  }

  /* — 字符串 ID 内容 — */
  const mobAdded = now.mobIds.filter((i) => !baseline.mobIds.includes(i));
  const mobRemoved = baseline.mobIds.filter((i) => !now.mobIds.includes(i));
  if (mobAdded.length) drift.changes.push(`新增生物:${mobAdded.join(', ')}`);
  if (mobRemoved.length) drift.changes.push(`删除生物:${mobRemoved.join(', ')}(旧存档的 AOI 状态会失效)`);
  const bossAdded = now.bossIds.filter((i) => !baseline.bossIds.includes(i));
  const bossRemoved = baseline.bossIds.filter((i) => !now.bossIds.includes(i));
  if (bossAdded.length) drift.changes.push(`新增 Boss:${bossAdded.join(', ')}`);
  if (bossRemoved.length) drift.changes.push(`删除 Boss:${bossRemoved.join(', ')}`);

  drift.inSync = drift.fingerprintMatches && drift.changes.length === 0;
  return drift;
}

/** 读取基线文件;不存在或解析失败返回 null。 */
export function readBaseline(path: string = defaultBaselinePath()): ContentBaseline | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ContentBaseline;
  } catch {
    return null;
  }
}

/** 写入基线文件。 */
export function writeBaseline(
  baseline: ContentBaseline = buildBaseline(),
  path: string = defaultBaselinePath(),
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/* ═══════════════════════ 扩展登记的留痕 ═══════════════════════ */

/**
 * 一次内容扩展的登记行。
 *
 * 之所以要这个而不只是「重新生成基线」:基线本身只说「现在长这样」,
 * 不说「**为什么**变成这样」。升级/拓展时最有价值的是一条**可追溯的记录**:
 * 谁、什么时候、加了什么、是否需要存档迁移。
 */
export interface ContentExtension {
  /** 递增序号。 */
  seq: number;
  /** 变更说明。 */
  summary: string;
  /** 涉及的 ID。 */
  ids: number[];
  /** 是否需要存档迁移。 */
  needsMigration: boolean;
  /** 追加的迁移提示(给存档层用)。 */
  migrationNote: string;
}

/**
 * 校验扩展登记的一致性。
 *
 * 检查:序号连续、ID 不与已有内容冲突、声明了迁移需求。
 * 这是「扩展流程」的可执行部分 —— 让流程不靠文档约定,靠断言。
 */
export function auditExtensions(
  extensions: readonly ContentExtension[],
  existingIds: readonly number[] = ITEM_LIST.map((i) => i.id),
): string[] {
  const problems: string[] = [];
  const used = new Set(existingIds);

  extensions.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`扩展登记序号不连续:第 ${i + 1} 条 seq=${e.seq}`);
    if (e.summary.trim().length === 0) problems.push(`扩展登记 seq=${e.seq} 缺少说明`);
    for (const id of e.ids) {
      if (used.has(id)) problems.push(`扩展登记 seq=${e.seq} 的 ID ${id} 与已有内容冲突`);
      used.add(id);
    }
    if (e.needsMigration && e.migrationNote.trim().length === 0) {
      problems.push(`扩展登记 seq=${e.seq} 声明需要迁移但未给出迁移提示`);
    }
  });

  return problems;
}

/** 计算扩展登记的指纹,便于确认「登记与内容同步更新」。 */
export function extensionFingerprint(extensions: readonly ContentExtension[]): string {
  return fnv1a32(JSON.stringify(extensions.map((e) => [e.seq, e.summary, [...e.ids].sort((a, b) => a - b), e.needsMigration])));
}