/**
 * WS-FND-84 —— CR-28:手册的 **7 件抽象奖励**(748~754)真正接进 Boss 的 `loot`。
 *
 * ## 这个套件补的是哪一段
 *
 * CR-16 把这 7 件登记成 `BossDef.lootAbstract`(纯文字),因为那时 320 项物品表**零命中**;
 * CR-27 把它们补录成物品(§3.11 的 `748~754`),但**没接进任何 Boss 的 `loot`**
 * (接进去会动 `contentFingerprints().bosses` 与 `tests/WS-05` 的冻结快照)。
 *
 * ```
 * shared/constants/items.ts    748~754 已存在(CR-27)              ← 有 ID
 * shared/constants/bosses.ts   loot 里没有这 7 个 ID               ← 缺口(CR-28 补)
 * server/src/bosses/raid.ts    effectiveLoot → rollPersonalLoot     ← 生产路径只认 loot
 * ```
 *
 * ⇒ CR-28 把它们按手册挂到对应 Boss 的 `loot`(无 Boss 归属的 3 件挂最终 Boss),
 *   并同步 `content.baseline.json` 的 `bosses` 分区与 `tests/WS-05` 的冻结快照。
 *   本套件钉的是「挂对了 / 只挂一次 / 没把老的挤掉 / 生产真发」这四件事。
 *
 * ## 判据结构(每一条都带**负对照**,负对照一律在**内存假表**上做,不写死数据)
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | 1 | 7 件各自**恰好**出现在一个 Boss 的 `loot` 里(8 个 Boss 全枚举) | 假表漏挂一件 ⇒ 报「未挂」;假表塞第二份 ⇒ 报「重复掉」 |
 * | 2 | 7 件逐件按 `normalizeBossLoot` / `bossLootEntries` 读出 `count === 1` | 假表把 count 改成 3 ⇒ 红;同时证 703×10 / 117×15 没被抹成 1 |
 * | 3 | 既有 Boss 的原有战利品**一个不丢、一位不挪**(逐 Boss 与 CR-28 前快照比) | 假表删掉 703 ⇒ 红;sky_whale 的 `440` 仍留在 `loot`(冻结字节) |
 * | 4 | 归属与手册逐条一致(748→河狸 / 754·749→姜饼巨魔 / 750→克洛诺斯 / 751·752·753→克洛诺斯里程碑);`lootAbstract` 的手册原文保留 | 假表把 748 挪到克洛诺斯 ⇒ 报「挂错 Boss」 |
 * | 5 | 生产掉落路径真发:7 件所在 Boss 的 `rollPersonalLoot` 光球都含该件、件数 ≥ 1 | 被标 `lootDeviations` 的 `437` / `440` 仍被过滤(接奖励不得顺手放过载具) |
 * | 6 | 指纹与基线同步:`bosses = 8f50dc95`、`overall = 4ae9f66f`,且与 `content.baseline.json` 一致 | 断言 `bosses ≠ e6bd03cc`(否则「什么都没改也能过」) |
 *
 * ## 期望值来源
 *
 * 手册行号/原文来自 `docs/DATA-CONFORMANCE.md:216~220`、`docs/ID-CROSSCHECK.md:276~282`
 * 与 CR-16/CR-27/CR-28 的登记;数量 `1` 不是猜的 —— 手册对这 7 件**没写** `×N`
 * (唯一写了数量的是 L496 的 `703×10` 与 L501 的 `117×15`),所以缺省 1。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  BOSS_LIST,
  BOSS_BY_ID,
  bossLootEntries,
  normalizeBossLoot,
} from '../shared/constants/bosses.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { effectiveLoot, rollPersonalLoot } from '../server/src/bosses/raid.ts';
import { contentFingerprints } from '../server/src/content/registry.ts';
import type { BossLootEntry } from '../shared/types/entities.ts';
import type { RaidParticipant } from '../server/src/bosses/raid.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═════════════════ 0. 判据的输入数据(逐条抄手册 / CR 登记)═════════════════ */

/** 一件抽象奖励的「手册归属 → 应挂 Boss」。`manual` 是依据原文/行号,便于报错时点名。 */
interface Expect {
  readonly id: number;
  readonly name: string;
  readonly boss: string;
  readonly manual: string;
}

/**
 * 7 件抽象奖励 —— **顺序 = 手册 §3.x 的 748~754**。
 *
 * 前 4 件手册有**明确的 Boss 归属**;后 3 件手册把它们写给 **mob**(L467 / L476 / L481),
 * 不属于任何 Boss ⇒ 按「无明确归属 ⇒ 通关里程碑/最终 Boss」挂 `boss_chronos_colossus`
 * (依据同时写在 `shared/constants/bosses.ts` 的该 Boss 注里)。
 */
const ABSTRACT: readonly Expect[] = [
  { id: 748, name: '自动伐木机甲图纸', boss: 'boss_beaver_mecha', manual: 'L496「自动伐木机甲宠物图纸」' },
  { id: 749, name: '姜饼人随从', boss: 'boss_ginger_troll', manual: 'L500「姜饼人随从」' },
  { id: 750, name: '纯金通关纪念碑', boss: 'boss_chronos_colossus', manual: 'L502「纯金通关纪念碑」' },
  { id: 751, name: '稀有甜点食谱', boss: 'boss_chronos_colossus', manual: 'L481 写的是 mob_choco_golem 掉它 ⇒ 无 Boss 归属' },
  { id: 752, name: '蓬松彩羽', boss: 'boss_chronos_colossus', manual: 'L476 写的是 mob_chocobo 掉它 ⇒ 无 Boss 归属' },
  { id: 753, name: '稀有树种', boss: 'boss_chronos_colossus', manual: 'L467 写的是 mob_squirrel 掉它 ⇒ 无 Boss 归属' },
  { id: 754, name: '城堡图纸', boss: 'boss_ginger_troll', manual: 'L500「皇家甜点主题全套城堡图纸」' },
];

/**
 * CR-28 **之前**的逐 Boss 冻结快照(= 手册 L495~L502 里「带 ID 的必掉件」)。
 * CR-28 只允许在**尾部追加**这 7 件,原有位次一个都不许动 ⇒ 下面按前缀逐位对比。
 */
const LOOT_BEFORE_CR28: Record<string, number[]> = {
  boss_jelly_king: [704, 719, 727],
  boss_beaver_mecha: [703, 437],
  boss_fox_kitsune: [705, 720],
  boss_crab_kraken: [706, 721, 728],
  boss_scorpion_pharaoh: [707, 722],
  boss_ginger_troll: [609, 613],
  boss_sky_whale: [117, 718, 440],
  boss_chronos_colossus: [708, 723],
};

/* ═════════════════ 0b. 检查器(纯函数:真表与假表走**同一份**逻辑)═════════════════ */

/** 判据只看 `id` / `loot` / `lootQty` 三个字段 ⇒ 真表(`BossDef`)与假表都能喂。 */
interface LootDriven {
  readonly id: string;
  readonly loot: readonly number[];
  readonly lootQty?: readonly number[];
}

/** 归一后的条目 —— 与生产**同一条**读取路径(`normalizeBossLoot`)。 */
function entriesOf(list: readonly LootDriven[], bossId: string): BossLootEntry[] {
  const b = list.find((x) => x.id === bossId);
  return b === undefined ? [] : normalizeBossLoot(b.loot, b.lootQty);
}

/** #1 / #4:每件「挂了没有 / 挂了几次 / 挂的是不是手册那个 Boss」。返回问题串(空 = 通过)。 */
function placementProblems(list: readonly LootDriven[], expects: readonly Expect[]): string[] {
  const problems: string[] = [];
  for (const e of expects) {
    const hits: string[] = [];
    for (const b of list) {
      for (const entry of normalizeBossLoot(b.loot, b.lootQty)) if (entry.id === e.id) hits.push(b.id);
    }
    if (hits.length === 0) {
      problems.push(`#${e.id} ${e.name} 没挂到任何 Boss 的 loot(手册 ${e.manual})`);
    } else if (hits.length > 1) {
      problems.push(`#${e.id} ${e.name} 重复掉:出现在 ${hits.join(' + ')}(每件只能在一个 Boss 的 loot 里)`);
    } else if (hits[0] !== e.boss) {
      problems.push(`#${e.id} ${e.name} 挂错 Boss:手册归属 ${e.boss},实际 ${hits[0]}(手册 ${e.manual})`);
    }
  }
  return problems;
}

/** #2:每件必须能被读出 `count === 1`(手册没写 ×N ⇒ 不发明数量)。 */
function countProblems(list: readonly LootDriven[], expects: readonly Expect[]): string[] {
  const problems: string[] = [];
  for (const e of expects) {
    const hits = entriesOf(list, e.boss).filter((x) => x.id === e.id);
    if (hits.length !== 1) {
      problems.push(`#${e.id} ${e.name} 在 ${e.boss} 的 loot 里出现 ${hits.length} 次(应恰好 1 次)`);
      continue;
    }
    if (hits[0].count !== 1) {
      problems.push(`#${e.id} ${e.name} 的 count = ${hits[0].count}(手册未写数量 ⇒ 必须 1)`);
    }
  }
  return problems;
}

/** #3:CR-28 之前那一位次上的 ID 必须**逐位不变**(原有战利品一个不丢)。 */
function lossProblems(list: readonly LootDriven[], before: Record<string, number[]>): string[] {
  const problems: string[] = [];
  for (const [bossId, old] of Object.entries(before)) {
    const b = list.find((x) => x.id === bossId);
    if (b === undefined) {
      problems.push(`${bossId} 整只 Boss 不见了(它的 loot 也一起丢了)`);
      continue;
    }
    const ids = normalizeBossLoot(b.loot, b.lootQty).map((x) => x.id);
    for (let i = 0; i < old.length; i += 1) {
      if (ids[i] !== old[i]) {
        problems.push(`${bossId}.loot[${i}] 期望 ${old[i]},实际 ${ids[i] ?? '缺失'}(原有战利品不得丢、不得挪位)`);
      }
    }
  }
  return problems;
}

/* ── 假表构造:一律**新建对象**,绝不动 `BOSS_LIST` 里的真数据 ── */

/** 真表 → 可改的普通对象数组(归一后的形态)。 */
function cloneTable(): { id: string; loot: number[]; lootQty: number[] }[] {
  return BOSS_LIST.map((b) => {
    const ents = normalizeBossLoot(b.loot, b.lootQty);
    return { id: b.id, loot: ents.map((e) => e.id), lootQty: ents.map((e) => e.count) };
  });
}

/** 假表:某 Boss 少一件(注入「漏挂」)。 */
function tableWithout(bossId: string, itemId: number): LootDriven[] {
  return cloneTable().map((b) =>
    b.id === bossId
      ? {
          id: b.id,
          loot: b.loot.filter((x) => x !== itemId),
          lootQty: b.lootQty.filter((_, i) => b.loot[i] !== itemId),
        }
      : b,
  );
}

/** 假表:某 Boss 多一件(注入「重复掉」/「挂错 Boss」)。 */
function tablePlus(bossId: string, itemId: number, count = 1): LootDriven[] {
  return cloneTable().map((b) =>
    b.id === bossId ? { id: b.id, loot: [...b.loot, itemId], lootQty: [...b.lootQty, count] } : b,
  );
}

/** 假表:某 Boss 的某件数量改成 `count`(注入「发明数量」)。 */
function tableWithCount(bossId: string, itemId: number, count: number): LootDriven[] {
  return cloneTable().map((b) =>
    b.id === bossId
      ? { id: b.id, loot: b.loot, lootQty: b.lootQty.map((q, i) => (b.loot[i] === itemId ? count : q)) }
      : b,
  );
}

/* ═════════════════ 1. 7 件都在某个 Boss 的 loot 里,且只出现一次 ═════════════════ */

test('FND84-1 7 件抽象奖励各自恰好出现在一个 Boss 的 loot 里(负对照:漏挂 / 重复掉)', () => {
  eq(ABSTRACT.length, 7, '手册的抽象奖励是 7 件(748~754)');
  eq(BOSS_LIST.length, 8, '8 个 Boss 必须全被枚举到(漏一只 Boss 就等于漏检它的 loot)');

  eq(placementProblems(BOSS_LIST, ABSTRACT), [], '★ 7 件都在 loot 里,且每件只挂一个 Boss');

  /* 交叉验证「同一份断言换个读法也对」:逐 Boss 数出 7 件的命中数,总和必须 = 7。 */
  let total = 0;
  for (const b of BOSS_LIST) {
    const ents = bossLootEntries(b.id);
    for (const e of ABSTRACT) total += ents.filter((x) => x.id === e.id).length;
  }
  eq(total, 7, '7 件在全表的命中总数必须 = 7(不是 0,也不是 14)');

  /* 负对照 1:漏挂一件(河狸少 #748)⇒ 检查器必须报「未挂」。 */
  const missing = placementProblems(tableWithout('boss_beaver_mecha', 748), ABSTRACT);
  ok(missing.some((m) => m.includes('#748') && m.includes('没挂')),
    `漏挂 #748 必须被抓到,实际 ${JSON.stringify(missing)}`);
  ok(missing.length >= 1, '漏挂至少产生 1 条问题');

  /* 负对照 2:重复掉(克洛诺斯再多一份 #754)⇒ 必须报「重复掉」。 */
  const dup = placementProblems(tablePlus('boss_chronos_colossus', 754), ABSTRACT);
  ok(dup.some((m) => m.includes('#754') && m.includes('重复掉')),
    `#754 出现在两只 Boss 上必须被抓到,实际 ${JSON.stringify(dup)}`);
});

/* ═════════════════ 2. 每件都能读出 count = 1 ═════════════════ */

test('FND84-2 7 件逐件按 normalizeBossLoot 读出 count = 1(负对照:改成 3 必须红)', () => {
  for (const e of ABSTRACT) {
    /* 内容表这一端:ID ↔ 名字逐字对上(挂错同名件 = 挂错东西)。 */
    eq(ITEM_BY_ID.get(e.id)?.name, e.name, `#${e.id} 的名字`);

    /* 读取端:生产用的那条归一入口。 */
    const ents = bossLootEntries(e.boss);
    const hit = ents.filter((x) => x.id === e.id);
    eq(hit.length, 1, `${e.boss}.loot 里 #${e.id} 必须恰好 1 条`);
    eq(hit[0].count, 1, `#${e.id} ${e.name} 的 count(手册未写 ×N ⇒ 1)`);
  }

  /* 全表口径:`countProblems` 对真表必须 0 条。 */
  eq(countProblems(BOSS_LIST, ABSTRACT), [], '★ 7 件的 count 全为 1');

  /* 手册写了 ×N 的两件不许被这 7 件带偏(703×10 / 117×15 仍是原值)。 */
  eq(bossLootEntries('boss_beaver_mecha').find((x) => x.id === 703)?.count, 10, '703 仍 ×10(手册 L496)');
  eq(bossLootEntries('boss_sky_whale').find((x) => x.id === 117)?.count, 15, '117 仍 ×15(手册 L501)');
  /* 反向:7 件里没有任何一件拿到 >1 的数量。 */
  for (const b of BOSS_LIST) {
    for (const x of bossLootEntries(b.id)) {
      if (ABSTRACT.some((e) => e.id === x.id)) eq(x.count, 1, `${b.id} 的抽象奖励 #${x.id} 数量必须 1`);
    }
  }

  /* 负对照:把 #750 改成 3 ⇒ 检查器必须红(证明它对「发明数量」敏感)。 */
  const bad = countProblems(tableWithCount('boss_chronos_colossus', 750, 3), ABSTRACT);
  ok(bad.some((m) => m.includes('#750') && m.includes('count = 3')),
    `#750 的数量被改成 3 必须被抓到,实际 ${JSON.stringify(bad)}`);
});

/* ═════════════════ 3. 既有 Boss 的原有 loot 一个不丢 ═════════════════ */

test('FND84-3 既有 Boss 的原有 loot 逐位不丢(负对照:删掉 703 必须红)', () => {
  eq(Object.keys(LOOT_BEFORE_CR28).length, 8, '基准表必须覆盖 8 个 Boss');

  /* 真表:CR-28 之前的位次逐位不变。 */
  eq(lossProblems(BOSS_LIST, LOOT_BEFORE_CR28), [], '★ 8 个 Boss 的原有战利品一位没挪');

  /* 逐 Boss 报一次「新增了什么」—— 新增只允许是那 7 件(不允许夹带别的件)。 */
  const abstractIds = new Set(ABSTRACT.map((e) => e.id));
  for (const [bossId, old] of Object.entries(LOOT_BEFORE_CR28)) {
    const now = normalizeBossLoot(BOSS_BY_ID.get(bossId)!.loot, BOSS_BY_ID.get(bossId)!.lootQty).map((x) => x.id);
    eq(now.length, old.length + now.slice(old.length).length, `${bossId} 的长度记账`);
    for (const added of now.slice(old.length)) {
      ok(abstractIds.has(added), `${bossId} 的新增件 #${added} 必须是 748~754 之一(不许夹带别的件)`);
    }
  }
  /* 新增总数必须正好 7:1(河狸)+ 2(姜饼巨魔)+ 4(克洛诺斯)。 */
  let addedTotal = 0;
  for (const [bossId, old] of Object.entries(LOOT_BEFORE_CR28)) {
    addedTotal += BOSS_BY_ID.get(bossId)!.loot.length - old.length;
  }
  eq(addedTotal, 7, '全表新增条数 = 7(既没多挂也没少挂)');

  /* 冻结字节:`sky_whale` 的 440 仍留在 loot 里(它是 L316 载具,靠 lootDeviations 过滤,
     不是靠删条目)⇒ 这条与 W5-54 同源,防止「接奖励」时顺手把老条目删了。 */
  eq(BOSS_BY_ID.get('boss_sky_whale')!.loot, [117, 718, 440], '★ sky_whale.loot 仍是 CR-16 的字节');
  eq(BOSS_BY_ID.get('boss_beaver_mecha')!.loot.slice(0, 2), [703, 437], '★ 河狸前两位仍是 703 / 437');

  /* 负对照:假表删掉 703 ⇒ 检查器必须红。 */
  const dropped = lossProblems(tableWithout('boss_beaver_mecha', 703), LOOT_BEFORE_CR28);
  ok(dropped.some((m) => m.includes('703')), `删掉 703 必须被抓到,实际 ${JSON.stringify(dropped)}`);
  /* 负对照:假表把 #748 挪到第 0 位(顺序被改)⇒ 也要红。 */
  const shifted = cloneTable().map((b) =>
    b.id === 'boss_beaver_mecha' ? { id: b.id, loot: [748, 703, 437], lootQty: [1, 10, 1] } : b,
  );
  ok(lossProblems(shifted, LOOT_BEFORE_CR28).some((m) => m.includes('boss_beaver_mecha.loot[0]')),
    '把新件插到队首必须被抓到(原有位次不得挪)');
});

/* ═════════════════ 4. 归属必须与手册一致 ═════════════════ */

test('FND84-4 归属逐条对齐手册;手册没有 Boss 归属的 3 件挂最终 Boss(负对照:挂错 Boss)', () => {
  /* 手册写明的 4 件 —— 行号逐条点名。 */
  eq(BOSS_BY_ID.get('boss_beaver_mecha')!.loot.includes(748), true, '748 自动伐木机甲图纸 ← 手册 L496');
  eq(BOSS_BY_ID.get('boss_ginger_troll')!.loot.includes(754), true, '754 城堡图纸 ← 手册 L500');
  eq(BOSS_BY_ID.get('boss_ginger_troll')!.loot.includes(749), true, '749 姜饼人随从 ← 手册 L500');
  eq(BOSS_BY_ID.get('boss_chronos_colossus')!.loot.includes(750), true, '750 纯金通关纪念碑 ← 手册 L502');

  /* 手册把 751/752/753 写给 **mob**(L481 / L476 / L467)⇒ 无 Boss 归属 ⇒ 通关里程碑/最终 Boss。 */
  const chronos = BOSS_BY_ID.get('boss_chronos_colossus')!.loot;
  for (const id of [751, 752, 753]) {
    ok(chronos.includes(id), `#${id} 必须挂在最终 Boss(手册没有 Boss 归属 ⇒ 通关里程碑)`);
  }

  /* 反向:这 7 件不得出现在**别的** Boss 上(逐件 × 逐 Boss 全枚举,不只查命中的那只)。 */
  eq(placementProblems(BOSS_LIST, ABSTRACT), [], '★ 每件的归属都与本表的期望一致');

  /* `lootAbstract` 的手册原文仍保留(接进 loot ≠ 删掉手册登记;WS-05 的 W5-53 也钉着它)。 */
  ok((BOSS_BY_ID.get('boss_beaver_mecha')!.lootAbstract ?? []).some((s) => s.includes('自动伐木机甲')),
    '手册原文「自动伐木机甲宠物图纸」仍登记在 lootAbstract');
  ok((BOSS_BY_ID.get('boss_ginger_troll')!.lootAbstract ?? []).some((s) => s.includes('姜饼人随从')),
    '手册原文「姜饼人随从」仍登记在 lootAbstract');
  ok((BOSS_BY_ID.get('boss_chronos_colossus')!.lootAbstract ?? []).some((s) => s.includes('纯金通关纪念碑')),
    '手册原文「纯金通关纪念碑」仍登记在 lootAbstract');

  /* 负对照 1:把 #748 挪到克洛诺斯(假表)⇒ 必须报「挂错 Boss」。
     ⚠️ `loot` 只能装 `number[]`,所以假表走 `LootDriven` 这一层,不碰真数据。 */
  const moved = tableWithout('boss_beaver_mecha', 748).map((b) => {
    if (b.id !== 'boss_chronos_colossus') return b;
    const ents = normalizeBossLoot(b.loot, b.lootQty);
    return { id: b.id, loot: [...ents.map((x) => x.id), 748], lootQty: [...ents.map((x) => x.count), 1] };
  });
  const wrong = placementProblems(moved, ABSTRACT);
  ok(wrong.some((m) => m.includes('#748') && m.includes('挂错 Boss')),
    `#748 挂到克洛诺斯必须被抓到,实际 ${JSON.stringify(wrong)}`);

  /* 负对照 2:漏掉「最终 Boss」这条归属规则(把 751 挪去河狸)⇒ 红。 */
  const misplaced = tableWithout('boss_chronos_colossus', 751).map((b) =>
    b.id === 'boss_beaver_mecha'
      ? { id: b.id, loot: [...b.loot, 751], lootQty: [...(b.lootQty ?? []), 1] }
      : b,
  );
  ok(placementProblems(misplaced, ABSTRACT).some((m) => m.includes('#751') && m.includes('挂错 Boss')),
    '#751 挂到河狸必须被抓到');
});

/* ═════════════════ 5. 生产掉落路径真的发 ═════════════════ */

test('FND84-5 生产掉落真发这 7 件;被标非战利品的载具仍被过滤(负对照)', () => {
  const team: RaidParticipant[] = [{ id: 'p1', contributed: true, damageDealt: 100, x: 0, y: 0 }];

  for (const e of ABSTRACT) {
    const orb = rollPersonalLoot(e.boss, team)[0];
    ok(orb !== undefined, `${e.boss} 必须产出个人光球(前置条件:有贡献者)`);
    const got = orb!.entries.find((x) => x.itemId === e.id);
    ok(got !== undefined,
      `${e.boss} 的个人光球必须含 #${e.id} ${e.name}(接进 loot ⇒ 生产路径必须真发);实际 ${JSON.stringify(orb!.entries.map((x) => x.itemId))}`);
    ok(got!.count >= 1, `#${e.id} 的掉落件数应 ≥ 1,实际 ${got!.count}`);
  }

  /* 负对照(CR-16 的偏离不许被「接奖励」顺手抹掉):437 / 440 是手册里的可造载具,
     生产侧仍必须被 `lootDeviations` 过滤,而新接的 748 必须留下。 */
  const beaverEff = effectiveLoot(BOSS_BY_ID.get('boss_beaver_mecha')!);
  eq(beaverEff.out.includes(437), false, '437(手册 L313 可造载具)不得当战利品发');
  eq(beaverEff.out.includes(748), true, '748 必须留在生产掉落里');
  const whaleEff = effectiveLoot(BOSS_BY_ID.get('boss_sky_whale')!);
  eq(whaleEff.out.includes(440), false, '440(手册 L316 可造载具)不得当战利品发');

  /* 光球条目数 = 生产清单长度(没有凭空多一条 / 少一条)。 */
  const orb = rollPersonalLoot('boss_beaver_mecha', team)[0]!;
  eq(orb.entries.length, beaverEff.out.length, '光球条目数必须等于 effectiveLoot 的长度');
});

/* ═════════════════ 6. 指纹与基线同步 ═════════════════ */

test('FND84-6 指纹/基线同步:bosses = 8f50dc95、overall = 4ae9f66f(负对照:不许等于旧值)', () => {
  const f = contentFingerprints();
  const raw = JSON.parse(readFileSync(join(ROOT, 'server/src/content/content.baseline.json'), 'utf8')) as {
    fingerprints: Record<string, unknown>;
  };
  eq(raw.fingerprints.bosses, f.bosses, '基线 bosses 分区必须与当前内容同步(node scripts/content-lock.ts --update)');
  eq(raw.fingerprints.overall, f.overall, '基线的 overall 分区同理');
  eq(f.bosses, '8f50dc95', '★ CR-28 之后 bosses 分区的字面值');
  eq(f.overall, '4ae9f66f', '★ CR-28 之后 overall 的字面值');

  /* 负对照:`loot` 真的变了 —— 若谁把 7 件又撤回去,指纹会退回旧值,这条立刻红。
     这也证明上面两个字面量不是「什么都没改也能过」的同义反复。 */
  ok(f.bosses !== 'e6bd03cc', 'bosses 分区不得再是 CR-27 的旧值(否则说明 7 件根本没接进 loot)');
});

report('WS-FND-84');