/**
 * WS-FND-84 —— 手册的 **7 件抽象奖励**(748~754)各自落到**手册写的那张表**。
 *
 * ## 这个套件补的是哪一段
 *
 * CR-16 把这 7 件登记成 `BossDef.lootAbstract`(纯文字),因为那时 320 项物品表**零命中**;
 * CR-27 把它们补录成物品(§3.11 的 `748~754`);CR-28 把 7 件**一股脑挂进 Boss 的 `loot`**;
 * **CR-29 修正 CR-28 的归属**:751/752/753 手册写的是 **mob 掉落**(L481 / L476 / L467),
 * 不在 Boss 表 ⇒ 挪回 `shared/constants/mobs.ts` 既有的 `drops` 记录。
 *
 * ```
 * shared/constants/items.ts    748~754 已存在(CR-27)                 ← 有 ID
 * shared/constants/bosses.ts   748 / 749 / 750 / 754 ∈ 各 Boss loot   ← 手册有 Boss 归属的 4 件
 * shared/constants/mobs.ts     751→golem · 752→chocobo · 753→squirrel ← 手册写给 mob 的 3 件
 * server/src/bosses/raid.ts    effectiveLoot → rollPersonalLoot        ← Boss 侧生产路径
 * server/src/mobs/taming.ts    Object.keys(drops)[0] = 驯服回赠       ← mob 侧唯一的消费点
 * ```
 *
 * ## 判据结构(每一条都带**负对照**,负对照一律在**内存假表**上做,不写死数据)
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | 1 | 7 件各**恰好**出现在手册指定的那张表的那一行(8 Boss + 24 mob 全枚举) | 假表漏挂一件 ⇒ 报「未挂」;塞第二份 ⇒ 报「重复掉」;把 751 塞回 Boss loot ⇒ 报「越界」 |
 * | 2 | Boss 侧 4 件经 `normalizeBossLoot` / `bossLootEntries` 读出 `count === 1`;mob 侧 3 件 `drops[id] === 1` | 假表把 750 改成 3 / 753 改成 2 ⇒ 红;同时证 703×10 / 117×15 没被抹成 1 |
 * | 3 | 既有 Boss 的原有战利品**一个不丢、一位不挪**(逐 Boss 与 CR-28 前快照比);新增只允许是 748~754,总数 = 4 | 假表删掉 703 ⇒ 红;把 748 插到队首 ⇒ 红 |
 * | 4 | 归属与手册逐条一致(748→河狸 / 754·749→姜饼巨魔 / 750→克洛诺斯 / 751→golem / 752→chocobo / 753→squirrel);`lootAbstract` 的手册原文保留 | 假表把 748 挪到克洛诺斯 / 把 751 挂到松鼠 / 把 751 又塞回 Boss loot ⇒ 报「挂错」 |
 * | 5 | 生产路径真发:Boss 侧 4 件的 `rollPersonalLoot` 光球都含该件;mob 侧 3 件在 `drops` 里且**不是首项**(`taming.ts` 的驯服回赠取 `drops` 第一项,新件不得顶掉特色产出) | 被标 `lootDeviations` 的 `437` / `440` 仍被过滤;mob 掉落引用闭合(`auditContent`) |
 * | 6 | 指纹与基线同步:`bosses = cf4bd9dc`、`overall = 0afe5562`、`mobs = 487f4515`(CR-30 起整字段投影,mob 的 `drops` 也进 mobs 分区哈希),且与 `content.baseline.json` 一致 | 断言 `bosses ∉ {1fb56d39, 8f50dc95, e6bd03cc}`(否则「什么都没改也能过」) |
 *
 * ## 期望值来源
 *
 * 手册行号/原文来自 `docs/DATA-CONFORMANCE.md:216~220`、`docs/ID-CROSSCHECK.md:266~282`
 * 与 CR-16/CR-27/CR-28/CR-29 的登记;数量 `1` 不是猜的 —— 手册对这 7 件**没写** `×N`
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
import { MOB_LIST, MOB_BY_ID } from '../shared/constants/mobs.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { effectiveLoot, rollPersonalLoot } from '../server/src/bosses/raid.ts';
import { auditContent, contentFingerprints } from '../server/src/content/registry.ts';
import type { BossLootEntry } from '../shared/types/entities.ts';
import type { RaidParticipant } from '../server/src/bosses/raid.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═════════════════ 0. 判据的输入数据(逐条抄手册 / CR 登记)═════════════════ */

/**
 * 一件抽象奖励的「手册归属 → 应落哪张表的哪一行」。
 *
 * `owner` 是**手册原文**写的那张表:`boss` = 该行「必掉史诗战利品」列(L495~L502);
 * `mob` = 生物生态表(L464~L487)。`manual` 是依据原文/行号,便于报错时点名。
 */
interface Expect {
  readonly id: number;
  readonly name: string;
  readonly owner: 'boss' | 'mob';
  readonly ownerId: string;
  readonly manual: string;
}

/**
 * 7 件抽象奖励 —— **顺序 = 手册 §3.x 的 748~754**。
 *
 * 4 件手册有**明确的 Boss 归属**(L496 / L500 ×2 / L502)⇒ 挂 Boss `loot`;
 * 3 件手册写给 **mob**(L481 / L476 / L467)⇒ 挂 mob `drops`(CR-29 从 Boss loot 挪回)。
 */
const ABSTRACT: readonly Expect[] = [
  { id: 748, name: '自动伐木机甲图纸', owner: 'boss', ownerId: 'boss_beaver_mecha', manual: 'L496「自动伐木机甲宠物图纸」' },
  { id: 749, name: '姜饼人随从', owner: 'boss', ownerId: 'boss_ginger_troll', manual: 'L500「姜饼人随从」' },
  { id: 750, name: '纯金通关纪念碑', owner: 'boss', ownerId: 'boss_chronos_colossus', manual: 'L502「纯金通关纪念碑」' },
  { id: 751, name: '稀有甜点食谱', owner: 'mob', ownerId: 'mob_choco_golem', manual: 'L481「掉 105 焦糖威化木×5、稀有甜点食谱」' },
  { id: 752, name: '蓬松彩羽', owner: 'mob', ownerId: 'mob_chocobo', manual: 'L476「掉蓬松彩羽」' },
  { id: 753, name: '稀有树种', owner: 'mob', ownerId: 'mob_squirrel', manual: 'L467「掉 101 原木、稀有树种」' },
  { id: 754, name: '城堡图纸', owner: 'boss', ownerId: 'boss_ginger_troll', manual: 'L500「皇家甜点主题全套城堡图纸」' },
];

const BOSS_SIDE = ABSTRACT.filter((e) => e.owner === 'boss');
const MOB_SIDE = ABSTRACT.filter((e) => e.owner === 'mob');

/**
 * CR-28 **之前**的逐 Boss 冻结快照(= 手册 L495~L502 里「带 ID 的必掉件」)。
 * CR-28/CR-29 只允许在**尾部追加**手册那 4 件,原有位次一个都不许动 ⇒ 下面按前缀逐位对比。
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

/** 判据只看 `id` / `drops` ⇒ 真表(`MobDef`)与假表都能喂。 */
interface DropsDriven {
  readonly id: string;
  readonly drops: Readonly<Record<number, number>>;
}

/** 归一后的条目 —— 与生产**同一条**读取路径(`normalizeBossLoot`)。 */
function entriesOf(list: readonly LootDriven[], bossId: string): BossLootEntry[] {
  const b = list.find((x) => x.id === bossId);
  return b === undefined ? [] : normalizeBossLoot(b.loot, b.lootQty);
}

/** 某生物 `drops` 里的物品 ID 清单。 */
function dropIds(mob: DropsDriven): number[] {
  return Object.keys(mob.drops ?? {}).map(Number);
}

/** 一件物品在两张表里各出现在哪些行(为「跨表唯一」提供同一份读数)。 */
function hitsOf(
  bosses: readonly LootDriven[],
  mobs: readonly DropsDriven[],
  itemId: number,
): { boss: string[]; mob: string[] } {
  const boss: string[] = [];
  const mob: string[] = [];
  for (const b of bosses) {
    for (const e of normalizeBossLoot(b.loot, b.lootQty)) if (e.id === itemId) boss.push(b.id);
  }
  for (const m of mobs) if (dropIds(m).includes(itemId)) mob.push(m.id);
  return { boss, mob };
}

function sideName(side: 'boss' | 'mob'): string {
  return side === 'boss' ? 'Boss 的 loot' : '生物的 drops';
}

/**
 * #1 / #4:每件「挂了没有 / 挂了几次 / 挂的是不是手册那一行 / 有没有串到另一张表」。
 *
 * 「串表」单独报:只查命中侧不够 —— 一件物品**同时**挂在 Boss 和 mob 上时,
 * 命中侧仍然恰好 1 条,但同一件奖励会被发两次。这是 CR-28 犯的错,必须能被抓住。
 */
function placementProblems(
  bosses: readonly LootDriven[],
  mobs: readonly DropsDriven[],
  expects: readonly Expect[],
): string[] {
  const problems: string[] = [];
  for (const e of expects) {
    const hits = hitsOf(bosses, mobs, e.id);
    const want = e.owner === 'boss' ? hits.boss : hits.mob;
    const wrong = e.owner === 'boss' ? hits.mob : hits.boss;
    if (want.length === 0) {
      problems.push(`#${e.id} ${e.name} 没挂到手册指定的 ${sideName(e.owner)}(${e.ownerId};手册 ${e.manual})`);
    } else if (want.length > 1) {
      problems.push(`#${e.id} ${e.name} 重复掉:出现在 ${want.join(' + ')}(每件只能在一行里)`);
    } else if (want[0] !== e.ownerId) {
      problems.push(`#${e.id} ${e.name} 归属错:手册归属 ${e.ownerId},实际 ${want[0]}(手册 ${e.manual})`);
    }
    if (wrong.length > 0) {
      problems.push(`#${e.id} ${e.name} 越界:它还出现在 ${wrong.join(' + ')} 的 ${sideName(e.owner === 'boss' ? 'mob' : 'boss')} 里(同一件奖励会被发两次)`);
    }
  }
  return problems;
}

/** #2:Boss 侧每件必须能读出 `count === 1`;mob 侧每件 `drops[id] === 1`(手册没写 ×N ⇒ 不发明数量)。 */
function countProblems(
  bosses: readonly LootDriven[],
  mobs: readonly DropsDriven[],
  expects: readonly Expect[],
): string[] {
  const problems: string[] = [];
  for (const e of expects) {
    if (e.owner === 'boss') {
      const hits = entriesOf(bosses, e.ownerId).filter((x) => x.id === e.id);
      if (hits.length !== 1) {
        problems.push(`#${e.id} ${e.name} 在 ${e.ownerId} 的 loot 里出现 ${hits.length} 次(应恰好 1 次)`);
      } else if (hits[0].count !== 1) {
        problems.push(`#${e.id} ${e.name} 的 count = ${hits[0].count}(手册未写数量 ⇒ 必须 1)`);
      }
      continue;
    }
    const m = mobs.find((x) => x.id === e.ownerId);
    const q = m === undefined ? undefined : m.drops[e.id];
    if (q === undefined) {
      problems.push(`#${e.id} ${e.name} 不在 ${e.ownerId} 的 drops 里(手册 ${e.manual})`);
    } else if (q !== 1) {
      problems.push(`#${e.id} ${e.name} 在 ${e.ownerId} 的件数 = ${q}(手册未写 ×N ⇒ 必须 1)`);
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

/* ── 假表构造:一律**新建对象**,绝不动 `BOSS_LIST` / `MOB_LIST` 里的真数据 ── */

/** 真表 → 可改的普通对象数组(归一后的形态)。 */
function cloneTable(): { id: string; loot: number[]; lootQty: number[] }[] {
  return BOSS_LIST.map((b) => {
    const ents = normalizeBossLoot(b.loot, b.lootQty);
    return { id: b.id, loot: ents.map((e) => e.id), lootQty: ents.map((e) => e.count) };
  });
}

/** 真表 → 可改的生物 `drops`(浅拷贝,不共享引用)。 */
function cloneMobs(): { id: string; drops: Record<number, number> }[] {
  return MOB_LIST.map((m) => ({ id: m.id, drops: { ...m.drops } }));
}

/** 假 Boss 表:某 Boss 少一件(注入「漏挂」)。 */
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

/** 假 Boss 表:某 Boss 多一件(注入「重复掉」/「越界到 Boss 表」/「挂错 Boss」)。 */
function tablePlus(bossId: string, itemId: number, count = 1): LootDriven[] {
  return cloneTable().map((b) =>
    b.id === bossId ? { id: b.id, loot: [...b.loot, itemId], lootQty: [...b.lootQty, count] } : b,
  );
}

/** 假 Boss 表:某 Boss 的某件数量改成 `count`(注入「发明数量」)。 */
function tableWithCount(bossId: string, itemId: number, count: number): LootDriven[] {
  return cloneTable().map((b) =>
    b.id === bossId
      ? { id: b.id, loot: b.loot, lootQty: b.lootQty.map((q, i) => (b.loot[i] === itemId ? count : q)) }
      : b,
  );
}

/** 假生物表:把某件挪到另一只生物上(注入「挂错生物」)。 */
function mobMoved(fromMob: string, toMob: string, itemId: number): DropsDriven[] {
  return cloneMobs().map((m) => {
    if (m.id === fromMob) {
      const d = { ...m.drops };
      delete d[itemId];
      return { id: m.id, drops: d };
    }
    if (m.id === toMob) return { id: m.id, drops: { ...m.drops, [itemId]: 1 } };
    return m;
  });
}

/** 假生物表:某只生物的某件件数改成 `count`(注入「发明数量」)。 */
function mobWithCount(mobId: string, itemId: number, count: number): DropsDriven[] {
  return cloneMobs().map((m) => (m.id === mobId ? { id: m.id, drops: { ...m.drops, [itemId]: count } } : m));
}

/* ═════════════════ 1. 7 件各落在手册那一行,且全表只出现一次 ═════════════════ */

test('FND84-1 7 件各恰好出现在手册指定的那一行(4 在 Boss loot / 3 在 mob drops;负对照:漏挂 / 重复掉 / 越界)', () => {
  eq(ABSTRACT.length, 7, '手册的抽象奖励是 7 件(748~754)');
  eq(BOSS_SIDE.length, 4, '手册有 Boss 归属的是 4 件(748 / 749 / 750 / 754)');
  eq(MOB_SIDE.length, 3, '手册写给 mob 的是 3 件(751 / 752 / 753)');
  eq(BOSS_LIST.length, 8, '8 个 Boss 必须全被枚举到(漏一只 Boss 就等于漏检它的 loot)');
  eq(MOB_LIST.length, 24, '24 种生物必须全被枚举到(漏一只就等于漏检它的 drops)');

  eq(placementProblems(BOSS_LIST, MOB_LIST, ABSTRACT), [], '★ 7 件都落在手册指定的那一行,且没有一件串到另一张表');

  /* 交叉验证「同一份断言换个数法也对」:两张表里 7 件的命中总数必须 = 7。 */
  let total = 0;
  for (const b of BOSS_LIST) {
    const ents = bossLootEntries(b.id);
    for (const e of ABSTRACT) total += ents.filter((x) => x.id === e.id).length;
  }
  for (const m of MOB_LIST) {
    for (const e of ABSTRACT) total += dropIds(m).filter((x) => x === e.id).length;
  }
  eq(total, 7, '7 件在 Boss loot + mob drops 的命中总数必须 = 7(不是 0,也不是 14)');

  /* 负对照 1:漏挂一件(河狸少 #748)⇒ 检查器必须报「没挂」。 */
  const missing = placementProblems(tableWithout('boss_beaver_mecha', 748), MOB_LIST, ABSTRACT);
  ok(missing.some((m) => m.includes('#748') && m.includes('没挂')),
    `漏挂 #748 必须被抓到,实际 ${JSON.stringify(missing)}`);

  /* 负对照 2:重复掉(克洛诺斯再多一份 #754)⇒ 必须报「重复掉」。 */
  const dup = placementProblems(tablePlus('boss_chronos_colossus', 754), MOB_LIST, ABSTRACT);
  ok(dup.some((m) => m.includes('#754') && m.includes('重复掉')),
    `#754 出现在两只 Boss 上必须被抓到,实际 ${JSON.stringify(dup)}`);

  /* 负对照 3(CR-29 的核心回归):把 #751 又塞回 Boss loot ⇒ 必须报「越界」。
     只查命中侧抓不到这个形态 —— 那时 751 仍恰好命中 1 只 Boss,但它会被发两次。 */
  const cross = placementProblems(tablePlus('boss_chronos_colossus', 751), MOB_LIST, ABSTRACT);
  ok(cross.some((m) => m.includes('#751') && m.includes('越界')),
    `#751 同时挂在 Boss 与 mob 上必须被抓到,实际 ${JSON.stringify(cross)}`);

  /* 负对照 4:mob 侧漏掉一件(松鼠少 #753)⇒ 也要红。 */
  const mobMissing = placementProblems(BOSS_LIST, cloneMobs().map((m) => {
    if (m.id !== 'mob_squirrel') return m;
    const d = { ...m.drops };
    delete d[753];
    return { id: m.id, drops: d };
  }), ABSTRACT);
  ok(mobMissing.some((m) => m.includes('#753') && m.includes('没挂')),
    `mob 侧漏挂 #753 必须被抓到,实际 ${JSON.stringify(mobMissing)}`);
});

/* ═════════════════ 2. 逐件件数 = 1 ═════════════════ */

test('FND84-2 逐件件数 = 1(Boss 侧 count、mob 侧 drops 值;负对照:改成 3 / 2 必须红)', () => {
  for (const e of ABSTRACT) {
    /* 内容表这一端:ID ↔ 名字逐字对上(挂错同名件 = 挂错东西)。 */
    eq(ITEM_BY_ID.get(e.id)?.name, e.name, `#${e.id} 的名字`);
  }

  /* Boss 侧:走生产用的那条归一入口。 */
  for (const e of BOSS_SIDE) {
    const ents = bossLootEntries(e.ownerId);
    const hit = ents.filter((x) => x.id === e.id);
    eq(hit.length, 1, `${e.ownerId}.loot 里 #${e.id} 必须恰好 1 条`);
    eq(hit[0].count, 1, `#${e.id} ${e.name} 的 count(手册未写 ×N ⇒ 1)`);
  }

  /* mob 侧:`drops` 记录的值就是件数。 */
  for (const e of MOB_SIDE) {
    eq(MOB_BY_ID.get(e.ownerId)?.drops[e.id], 1, `${e.ownerId}.drops[#${e.id}] 件数(手册未写 ×N ⇒ 1)`);
  }

  /* 全表口径:`countProblems` 对真表必须 0 条。 */
  eq(countProblems(BOSS_LIST, MOB_LIST, ABSTRACT), [], '★ 7 件的件数全为 1');

  /* 手册写了 ×N 的两件不许被这 7 件带偏(703×10 / 117×15 仍是原值)。 */
  eq(bossLootEntries('boss_beaver_mecha').find((x) => x.id === 703)?.count, 10, '703 仍 ×10(手册 L496)');
  eq(bossLootEntries('boss_sky_whale').find((x) => x.id === 117)?.count, 15, '117 仍 ×15(手册 L501)');
  /* 反向:7 件里没有任何一件拿到 >1 的数量。 */
  for (const b of BOSS_LIST) {
    for (const x of bossLootEntries(b.id)) {
      if (BOSS_SIDE.some((e) => e.id === x.id)) eq(x.count, 1, `${b.id} 的抽象奖励 #${x.id} 数量必须 1`);
    }
  }
  for (const m of MOB_LIST) {
    for (const e of MOB_SIDE) {
      const q = (m.drops ?? {})[e.id];
      if (q !== undefined) eq(q, 1, `${m.id} 的抽象奖励 #${e.id} 件数必须 1`);
    }
  }

  /* 负对照:Boss 侧把 #750 改成 3、mob 侧把 #753 改成 2 ⇒ 检查器必须红。 */
  const badBoss = countProblems(tableWithCount('boss_chronos_colossus', 750, 3), MOB_LIST, ABSTRACT);
  ok(badBoss.some((m) => m.includes('#750') && m.includes('count = 3')),
    `#750 的数量被改成 3 必须被抓到,实际 ${JSON.stringify(badBoss)}`);
  const badMob = countProblems(BOSS_LIST, mobWithCount('mob_squirrel', 753, 2), ABSTRACT);
  ok(badMob.some((m) => m.includes('#753') && m.includes('件数 = 2')),
    `#753 的件数被改成 2 必须被抓到,实际 ${JSON.stringify(badMob)}`);
});

/* ═════════════════ 3. 既有 Boss 的原有 loot 一个不丢 ═════════════════ */

test('FND84-3 既有 Boss 的原有 loot 逐位不丢(负对照:删掉 703 必须红)', () => {
  eq(Object.keys(LOOT_BEFORE_CR28).length, 8, '基准表必须覆盖 8 个 Boss');

  /* 真表:CR-28 之前的位次逐位不变。 */
  eq(lossProblems(BOSS_LIST, LOOT_BEFORE_CR28), [], '★ 8 个 Boss 的原有战利品一位没挪');

  /* 逐 Boss 报一次「新增了什么」—— 新增只允许是手册有 Boss 归属的那 4 件。 */
  const bossAbstractIds = new Set(BOSS_SIDE.map((e) => e.id));
  for (const [bossId, old] of Object.entries(LOOT_BEFORE_CR28)) {
    const def = BOSS_BY_ID.get(bossId)!;
    const now = normalizeBossLoot(def.loot, def.lootQty).map((x) => x.id);
    for (const added of now.slice(old.length)) {
      ok(bossAbstractIds.has(added), `${bossId} 的新增件 #${added} 必须是 748/749/750/754 之一(不许夹带别的件)`);
    }
  }
  /* 新增总数必须正好 4:1(河狸 748)+ 2(姜饼巨魔 754/749)+ 1(克洛诺斯 750)。
     CR-28 时这里是 7,CR-29 把 3 件挪回 mob ⇒ 4。 */
  let addedTotal = 0;
  for (const [bossId, old] of Object.entries(LOOT_BEFORE_CR28)) {
    addedTotal += BOSS_BY_ID.get(bossId)!.loot.length - old.length;
  }
  eq(addedTotal, 4, '全表新增条数 = 4(既没多挂也没少挂;751/752/753 不在 Boss 表)');

  /* 冻结字节:`sky_whale` 的 440 仍留在 loot 里(它是 L316 载具,靠 lootDeviations 过滤,
     不是靠删条目);克洛诺斯必须**退回** CR-28 前的三件 + 750,不再含 751/752/753。 */
  eq(BOSS_BY_ID.get('boss_sky_whale')!.loot, [117, 718, 440], '★ sky_whale.loot 仍是 CR-16 的字节');
  eq(BOSS_BY_ID.get('boss_beaver_mecha')!.loot.slice(0, 2), [703, 437], '★ 河狸前两位仍是 703 / 437');
  eq(BOSS_BY_ID.get('boss_chronos_colossus')!.loot, [708, 723, 750],
    '★ 克洛诺斯只剩手册 L502 的三件(CR-29 已把 751/752/753 挪回 mob)');

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

test('FND84-4 归属逐条对齐手册:4 件在 Boss、3 件在 mob(负对照:挂错 Boss / 挂错生物 / 越界)', () => {
  /* 手册写明的 4 件 —— 行号逐条点名,且用生产读取路径读。 */
  eq(BOSS_BY_ID.get('boss_beaver_mecha')!.loot.includes(748), true, '748 自动伐木机甲图纸 ← 手册 L496');
  eq(BOSS_BY_ID.get('boss_ginger_troll')!.loot.includes(754), true, '754 城堡图纸 ← 手册 L500');
  eq(BOSS_BY_ID.get('boss_ginger_troll')!.loot.includes(749), true, '749 姜饼人随从 ← 手册 L500');
  eq(BOSS_BY_ID.get('boss_chronos_colossus')!.loot.includes(750), true, '750 纯金通关纪念碑 ← 手册 L502');

  /* 手册写给 mob 的 3 件:逐生物点名;并逐件**反向**证它们已不在任何一个 Boss 的 loot 里。 */
  const mobHome: [string, number, number][] = [
    ['mob_squirrel', 753, 467],
    ['mob_chocobo', 752, 476],
    ['mob_choco_golem', 751, 481],
  ];
  for (const [mobId, itemId, line] of mobHome) {
    const def = MOB_BY_ID.get(mobId);
    ok(def !== undefined, `${mobId} 必须在生物表里`);
    eq(def!.drops[itemId], 1, `#${itemId} 必须挂在 ${mobId} 的 drops(手册 L${line})`);
    for (const b of BOSS_LIST) {
      eq(bossLootEntries(b.id).some((x) => x.id === itemId), false,
        `#${itemId} 不得再出现在 ${b.id} 的 loot 里(手册 L${line} 写的是 mob 掉落)`);
    }
  }

  /* 反向:全表口径再确认一次(逐件 × 逐 Boss × 逐生物全枚举)。 */
  eq(placementProblems(BOSS_LIST, MOB_LIST, ABSTRACT), [], '★ 每件的归属都与本表的期望一致');

  /* `lootAbstract` 的手册原文仍保留(接进 loot ≠ 删掉手册登记;WS-05 的 W5-53 也钉着它)。 */
  ok((BOSS_BY_ID.get('boss_beaver_mecha')!.lootAbstract ?? []).some((s) => s.includes('自动伐木机甲')),
    '手册原文「自动伐木机甲宠物图纸」仍登记在 lootAbstract');
  ok((BOSS_BY_ID.get('boss_ginger_troll')!.lootAbstract ?? []).some((s) => s.includes('姜饼人随从')),
    '手册原文「姜饼人随从」仍登记在 lootAbstract');
  ok((BOSS_BY_ID.get('boss_chronos_colossus')!.lootAbstract ?? []).some((s) => s.includes('纯金通关纪念碑')),
    '手册原文「纯金通关纪念碑」仍登记在 lootAbstract');

  /* 负对照 1:把 #748 挪到克洛诺斯(假表)⇒ 必须报「归属错」。
     ⚠️ `loot` 只能装 `number[]`,所以假表走 `LootDriven` 这一层,不碰真数据。 */
  const moved = tableWithout('boss_beaver_mecha', 748).map((b) => {
    if (b.id !== 'boss_chronos_colossus') return b;
    const ents = normalizeBossLoot(b.loot, b.lootQty);
    return { id: b.id, loot: [...ents.map((x) => x.id), 748], lootQty: [...ents.map((x) => x.count), 1] };
  });
  const wrong = placementProblems(moved, MOB_LIST, ABSTRACT);
  ok(wrong.some((m) => m.includes('#748') && m.includes('归属错')),
    `#748 挂到克洛诺斯必须被抓到,实际 ${JSON.stringify(wrong)}`);

  /* 负对照 2:mob 侧把 #751 从巧克力盾卫挪到松鼠 ⇒ 必须报「归属错」。 */
  const misplaced = placementProblems(BOSS_LIST, mobMoved('mob_choco_golem', 'mob_squirrel', 751), ABSTRACT);
  ok(misplaced.some((m) => m.includes('#751') && m.includes('归属错')),
    `#751 挂到松鼠必须被抓到,实际 ${JSON.stringify(misplaced)}`);

  /* 负对照 3:把 #751 塞回 Boss loot(CR-28 的原形态)⇒ 必须报「越界」。 */
  const back = placementProblems(tablePlus('boss_chronos_colossus', 751), MOB_LIST, ABSTRACT);
  ok(back.some((m) => m.includes('#751') && m.includes('越界')),
    '#751 又被塞回最终 Boss 必须被抓到(CR-29 的回归)');
});

/* ═════════════════ 5. 生产路径真的发 ═════════════════ */

test('FND84-5 生产路径:4 件由 Boss 光球真发、3 件落在 mob drops(负对照:不得顶掉驯服回赠)', () => {
  const team: RaidParticipant[] = [{ id: 'p1', contributed: true, damageDealt: 100, x: 0, y: 0 }];

  for (const e of BOSS_SIDE) {
    const orb = rollPersonalLoot(e.ownerId, team)[0];
    ok(orb !== undefined, `${e.ownerId} 必须产出个人光球(前置条件:有贡献者)`);
    const got = orb!.entries.find((x) => x.itemId === e.id);
    ok(got !== undefined,
      `${e.ownerId} 的个人光球必须含 #${e.id} ${e.name}(接进 loot ⇒ 生产路径必须真发);实际 ${JSON.stringify(orb!.entries.map((x) => x.itemId))}`);
    ok(got!.count >= 1, `#${e.id} 的掉落件数应 ≥ 1,实际 ${got!.count}`);
  }

  /* mob 侧:唯一的生产消费点是 `server/src/mobs/taming.ts`(驯服成功回赠 `drops` 第一项)。
     ⇒ 新挂的 3 件必须是**追加项**,`drops` 的第一项仍是手册写的特色产出;
       否则驯服回赠会被悄悄换掉(本仓已第 5 次出现「接线了但语义被顶掉」一类的缺陷)。 */
  const firstKey: [string, number, string][] = [
    ['mob_squirrel', 101, 'L467「掉 101 原木、稀有树种」'],
    ['mob_chocobo', 119, 'L476「掉蓬松彩羽」'],
    ['mob_choco_golem', 105, 'L481「掉 105 焦糖威化木×5、稀有甜点食谱」'],
  ];
  for (const [mobId, wantFirst, line] of firstKey) {
    const m = MOB_BY_ID.get(mobId)!;
    eq(Object.keys(m.drops)[0], String(wantFirst), `${mobId}.drops 第一项仍是 ${wantFirst}(${line})`);
  }
  for (const e of MOB_SIDE) {
    const m = MOB_BY_ID.get(e.ownerId)!;
    eq(m.drops[e.id], 1, `${e.ownerId}.drops 必须含 #${e.id}(件数 1)`);
    ok(Object.keys(m.drops)[0] !== String(e.id), `#${e.id} 不得成为 ${e.ownerId} 的驯服回赠(drops 第一项)`);
  }

  /* 引用闭合:新挂的 3 件必须指向存在的物品 ID(内容审计会逐条查 mob drops)。 */
  eq(auditContent().problems, [], '生物掉落 / Boss 战利品必须全部指向存在的物品 ID');

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

test('FND84-6 指纹/基线同步:bosses = cf4bd9dc、overall = 0afe5562(负对照:不许等于 CR-29 旧值)', () => {
  const f = contentFingerprints();
  const raw = JSON.parse(readFileSync(join(ROOT, 'server/src/content/content.baseline.json'), 'utf8')) as {
    fingerprints: Record<string, unknown>;
  };
  eq(raw.fingerprints.bosses, f.bosses, '基线 bosses 分区必须与当前内容同步(node scripts/content-lock.ts --update)');
  eq(raw.fingerprints.overall, f.overall, '基线的 overall 分区同理');
  eq(f.bosses, 'cf4bd9dc', '★ CR-30(v2 整字段投影)之后 bosses 分区的字面值');
  eq(f.overall, '0afe5562', '★ CR-30(v2 整字段投影)之后 overall 的字面值');

  /* CR-30 起投影改成**整字段**:mob 记录里连 `drops` 一起进 mobs 分区哈希
     (`server/src/content/registry.ts` 的 `contentFingerprints`)⇒ mobs 的分区值也从
     CR-29 的 624808c4 漂到 487f4515。这条同时证明「3 件落到 mob」确实改了数据。 */
  eq(f.mobs, '487f4515', 'CR-30(v2 整字段投影)之后 mobs 分区的字面值');

  /* 负对照:`loot` 真的变了 —— 若谁把 751/752/753 又塞回 Boss,指纹会退回 CR-28 的值,这条立刻红。
     这也证明上面两个字面量不是「什么都没改也能过」的同义反复。 */
  ok(f.bosses !== '8f50dc95', 'bosses 分区不得再是 CR-28 的值(否则说明 3 件根本没挪回 mob)');
  ok(f.bosses !== '1fb56d39', 'bosses 分区不得再是 CR-29(v1 投影)的值');
  ok(f.bosses !== 'e6bd03cc', 'bosses 分区也不得退回 CR-27 的值');
});

report('WS-FND-84');