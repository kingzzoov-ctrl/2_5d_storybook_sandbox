/**
 * WS-FND-149 —— 外部审计指出的**三条架构隐患**的判据
 *
 * 运行:`node tests/WS-FND-149-arch-hazards.test.ts`
 *
 * | # | 隐患(审计原话) | 本轮的处置 | 本套件怎么钉 |
 * | :-- | :--- | :--- | :--- |
 * | 1 | `social/afk.ts` 四段(水族箱 / 信箱 / 摊位 / 社交赛道)**全无生产消费者** | 四段**登记为「预留·不做」**;第 1 段(打盹攒露水)标 `〔WIRED〕` —— 它真有生产入口 | FND149-1..4:五段标记齐备 + `RESERVED` 段**必须 0 消费者** + `WIRED` 段**必须真有消费者**(双向) + 文档台账同步 |
 * | 2 | `stallStock` **同名异义**(`afk.ts` 的摊位 vs `world_sim.ts` 的库存) | **改名消歧**:`world_sim.ts` 的私有字段 → `depotStock`(公开方法名 `setStallStock` / `stallStockOf` 是 515 这件家具的既有 API,不动) | FND149-5..8:`stallStock` 作为字段名全仓 0 处 + 两侧符号集交集为空 + 社交摊位函数生产引用 0 + 两者仍绑定同一件家具 515 |
 * | 3 | **两套赛道运行时**(`afk.ts#TrackRuntime` vs `party/modes.ts#RaceRuntime`) | **写清边界**:`RaceRuntime` = 玩法与结算的**唯一权威**;`afk.ts#TrackRuntime` = **罚时视图**(不结算 / 不发奖 / 不播报 / 没有自己的 tick) | FND149-9..12:结算权 / 推进权 / 同一只毫秒表 / 互不相识 —— 四条都是**结构判据** |
 *
 * ## 判据纪律
 *
 * 1 **双向**:`RESERVED` 声明「没人用」⇒ 必须真的 0 处;`WIRED` 声明「有人在用」⇒ 必须真的
 *    有消费者。两侧用**同一个扫描器**(`countSym`),写错任何一边当场红
 *    —— 这正是 `combat/wiring_ledger.ts#auditCombatWiring` 的形状。
 * 2 **剥注释后再数**:本套件的「0 处」一律指**代码**(`stripComments`)。否则「文档里写着
 *    `stallStock`」会把改名判据自己判红 —— 那是判据的错,不是代码的错。
 * 3 **不拿标记核标记**:标记(`${〔RESERVED〕}`)只说明「登记了什么」;实现存在(FND149-13)
 *    与消费者有无(FND149-2)各由独立扫描给出,三方一致才算数。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { STALL_ITEM_ID, suggestedPrice } from '../server/src/social/afk.ts';

const ROOT = join(import.meta.dirname, '..');
const AFK = 'server/src/social/afk.ts';
const MODES = 'server/src/party/modes.ts';
const WORLD = 'server/src/sim/world_sim.ts';
const LEDGER = 'docs/WIRING-LEDGER.md';

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 去掉 `/* … *\/` 块注释与 `//` 行注释。
 *
 * 为什么必须剥:本轮的所有「0 处」判据都是**代码级**的。注释里出现某个名字
 * (比如 `world_sim.ts` 的改名说明必然提到旧名)不代表它有消费者 ——
 * 不剥就会把「文档写对了」判成「代码没改」。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 具名符号在源码里的出现次数(`\b` 词边界 —— 于是 `stallStock` 不会命中也 `stallStockOf`)。 */
function countSym(src: string, sym: string): number {
  return src.match(new RegExp(`\\b${sym}\\b`, 'g'))?.length ?? 0;
}

/** 生产侧(`server/src` + `client/src` + `shared`)全部 `.ts`,已剥注释,排除给定文件。 */
function prodSources(exclude: readonly string[]): { path: string; src: string }[] {
  const walk = (dir: string, out: string[] = []): string[] => {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return out;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out);
      else if (e.isFile() && e.name.endsWith('.ts')) out.push(rel);
    }
    return out;
  };
  const files = [...walk('server/src'), ...walk('client/src'), ...walk('shared')]
    .filter((f) => !exclude.includes(f))
    .sort();
  return files.map((f) => ({ path: f, src: stripComments(read(f)) }));
}

/* ═════════════ 台账(本套件的机器副本;与 `afk.ts` 段标题、WIRING-LEDGER §2.7 三方对齐)═════════════ */

interface Segment {
  /** 段号(与 `afk.ts` 标题里的 `N.` 一一对应) */
  no: number;
  name: string;
  /** 该段的**对外符号**(实现必须在 afk.ts 里;`RESERVED` 段还必须在生产侧 0 引用) */
  symbols: readonly string[];
}

/**
 * 四段 `RESERVED` + 一段 `WIRED`。
 *
 * ⚠️ 这份表**不是**新的真值源:真值源是 `afk.ts` 每段标题里的 `〔WIRED〕` / `〔RESERVED〕`
 * 标记。本表只回答「该段的符号是哪几个」—— 标记与实现对不上(FND149-1 / -13)就红。
 */
const SEGMENTS: readonly Segment[] = [
  {
    no: 1,
    name: '打盹与梦境露水',
    /**
     * 只列**真被生产侧引用**的四个口(`world_sim.ts` 的 import 表逐个实测)。
     * `patDozing` / `dewRatePerSec` 不是漏了 —— 它们只被本模块内部调用(生产侧 0 引用),
     * 放进这里会让 FND149-2 的正向判据变成假红。
     */
    symbols: ['createAfkPlayer', 'goBackground', 'goForeground', 'tickAfk'],
  },
  {
    no: 2,
    name: '生态缸挂机模式',
    symbols: [
      'VIVARIUM', 'VIVARIUM_CAMERA_SHOTS', 'WHITE_NOISE_MIX',
      'createVivarium', 'enterVivarium', 'tickVivarium', 'exitVivarium', 'whiteNoiseMasterGain',
    ],
  },
  {
    no: 3,
    name: '534 迎宾点赞留言信箱',
    symbols: [
      'createMailbox', 'leaveMail', 'likeMail', 'pruneMailbox', 'badgeFor',
      'MAILBOX_ITEM_ID', 'MAILBOX_CAPACITY', 'MAIL_TTL_SEC', 'STICKER_COUNT', 'MAIL_LIKE_BADGES',
    ],
  },
  {
    no: 4,
    name: '515 无人自助售货摊(上架行)',
    symbols: [
      'createStall', 'listItem', 'buyFromStall', 'suggestedPrice',
      'Stall', 'StallListing', 'STALL_ITEM_ID', 'STALL_SLOT_COUNT',
      'CROSS_ROOM_FEE_RATIO', 'SUGGESTED_PRICE_MUL', 'CROSS_ROOM_MAX_QTY',
    ],
  },
  {
    no: 5,
    name: '跑道计时(社交展示)',
    symbols: [
      'createTrack', 'trackStart', 'trackFinish', 'trackStandings', 'trackPodiumText', 'trackCaught',
      'TrackRuntime', 'TRACK_KIND', 'MARATHON_LENGTH', 'KITE_LENGTH', 'KITE_CATCH_PENALTY_MS',
    ],
  },
];

const afkRaw = read(AFK);
const afkCode = stripComments(afkRaw);
const modesRaw = read(MODES);
const modesCode = stripComments(modesRaw);
const worldRaw = read(WORLD);
const worldCode = stripComments(worldRaw);
const ledger = read(LEDGER);
const prod = prodSources([AFK]);
/** 某符号在**生产侧**(除 afk.ts 自身)的总出现次数。 */
const prodCount = (sym: string): number => prod.reduce((n, f) => n + countSym(f.src, sym), 0);
/** 该符号在生产侧的**命中文件**(报错时要能一眼看出是谁接上了)。 */
const prodHits = (sym: string): string[] =>
  prod.filter((f) => countSym(f.src, sym) > 0).map((f) => f.path);

/** 段标题:`/* ═════ N. 标题 〔标记〕 ═════ *\/`(整行)。 */
const HEADER_RE = /^\/\* ═+ (\d)\. ([^\n]*?) ═+ \*\/$/gm;
/** 标记:`〔WIRED:<文件#符号>〕` / `〔RESERVED:<为什么不做>〕`。 */
const MARK_RE = /〔(WIRED|RESERVED)(?::([^〕]*))?〕/;

interface Header { no: number; title: string; marker: string; reason: string; at: number }
const headers: Header[] = [...afkRaw.matchAll(HEADER_RE)].map((m) => {
  const title = m[2] as string;
  const mk = MARK_RE.exec(title);
  return {
    no: Number(m[1]),
    title,
    marker: mk?.[1] ?? '',
    reason: mk?.[2] ?? '',
    /* ★ 用**匹配位置**而不是 `indexOf(' N. ')`:后者会被正文里同形的文字骗到。 */
    at: m.index ?? 0,
  };
});
/** 第 n 段从标题行到**下一个**段标题之间的原文(标记块 + 实现)。 */
function bodyOf(no: number): string {
  const i = headers.findIndex((h) => h.no === no);
  if (i < 0) return '';
  const from = headers[i]!.at;
  const to = headers[i + 1]?.at ?? afkRaw.length;
  return afkRaw.slice(from, to);
}

/* ═══════════════════════ 隐患 1:四段未接 ═══════════════════════ */

test('FND149-1 段标题标记齐备:5 段,第 1 段 〔WIRED〕,第 2~5 段 〔RESERVED〕 且各带理由', () => {
  eq(headers.map((h) => h.no), [1, 2, 3, 4, 5], 'afk.ts 的段标题必须仍是 5 段(编号连续)');
  for (const h of headers) {
    ok(h.marker !== '', `第 ${h.no} 段「${h.title}」缺 〔WIRED…〕/〔RESERVED…〕 标记`);
  }
  eq(headers[0]?.marker, 'WIRED', '第 1 段(打盹攒露水)有生产入口 ⇒ 必须标 〔WIRED〕');
  ok((headers[0]?.reason ?? '').length > 0, '第 1 段的 〔WIRED:…〕 必须写明调用点(`文件#符号`)');
  for (const h of headers.slice(1)) {
    eq(h.marker, 'RESERVED', `第 ${h.no} 段「${h.title}」没有生产消费者 ⇒ 必须标 〔RESERVED〕`);
    ok(h.reason.trim().length >= 8, `第 ${h.no} 段的 〔RESERVED:…〕 必须写明「缺什么」(空理由 = 空话)`);
    ok(/预留/.test(bodyOf(h.no)), `第 ${h.no} 段标了 RESERVED,正文必须写明「预留」—— 只留标记等于没说`);
  }
});

test('FND149-2 双向:RESERVED 段生产侧 0 消费者;WIRED 段必须真有消费者', () => {
  /* ── 反向(登记为「没人用」⇒ 必须真的 0 处)── */
  for (const seg of SEGMENTS.slice(1)) {
    for (const sym of seg.symbols) {
      eq(
        prodCount(sym), 0,
        `第 ${seg.no} 段标了 〔RESERVED〕,但 ${sym} 在生产侧被引用(${prodHits(sym).join(', ')})`
        + ' ⇒ 要么撤掉那处引用,要么把标记改成 〔WIRED:<文件#符号>〕 并同步 WIRING-LEDGER §2.7',
      );
    }
  }
  /* ── 正向(登记为「有人在用」⇒ 必须真的有人用)── */
  for (const sym of SEGMENTS[0]!.symbols) {
    ok(
      prodCount(sym) > 0,
      `第 1 段标了 〔WIRED〕,但 ${sym} 在生产侧 0 引用 ⇒ 标记在说谎(接线被撤掉了?)`,
    );
  }
});

test('FND149-3 模块头不宣称可用:必须写「预留」,且不得出现「已接」类断言', () => {
  const head = afkRaw.split('\n').slice(0, 40).join('\n');
  ok(head.includes('预留'), 'afk.ts 的模块头必须写明第 2~5 段是「预留」');
  ok(head.includes('RESERVED'), '模块头必须给出 〔RESERVED〕 标记口径(否则读者不知道标题里的方头括号是什么)');
  ok(!/已接[:|]/.test(head), '模块头出现「已接:」—— 四段没有生产消费者,这句话是误报掩盖');
});

test('FND149-4 文档台账同步:R6-SOC-1..4 的理由列必须写「预留」,现状列仍是 `未接`', () => {
  const rows = ledger.split(/\r?\n/).filter((l) => /^\| R6-SOC-[1-4] \|/.test(l));
  eq(rows.length, 4, 'docs/WIRING-LEDGER.md §2.7 必须仍有 4 条 R6-SOC 行(表体被改坏了?)');
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    /* | ID | 段 | 符号 | 位置 | 现状 | 理由 | 判据 | ⇒ cells[5] = 现状,cells[6] = 理由 */
    const id = cells[1] as string;
    /* 现状列在表体里写成 `**未接**`(markdown 加粗)⇒ 去星号再比,判据比的是词而不是排版。 */
    const status = (cells[5] as string).replace(/\*/g, '').trim();
    const reason = cells[6] as string;
    eq(status, '未接', `${id} 的现状列被改成「${status}」—— 四段仍无生产消费者;改桶计数要同步 §2.10 与 README`);
    ok(reason.includes('预留'), `${id} 的理由列必须写明「预留·不做」(登记在理由里,不在桶计数里)`);
  }
});

/* ═══════════════════════ 隐患 2:摊位同名异义 ═══════════════════════ */

test('FND149-5 改名消歧:`stallStock` 作为**字段名**全仓 0 处;世界侧字段是 `depotStock`', () => {
  eq(
    prodCount('stallStock'), 0,
    `\`stallStock\` 又出现在生产代码里(${prodHits('stallStock').join(', ')})`
    + ' ⇒ 它与 social/afk.ts 的「上架行」模型同名不同物;世界侧字段名必须是 depotStock',
  );
  ok(
    /private depotStock: Record<number, number> = \{\};/.test(worldCode),
    'world_sim.ts 必须有 `private depotStock: Record<number, number> = {};`(515 百货机库存)',
  );
  ok(
    countSym(worldCode, 'this.depotStock') >= 4,
    '`this.depotStock` 的出现次数过少 —— 库存读写被改道了(权威应当只有它一个)',
  );
});

test('FND149-6 afk.ts 里不得出现 `stallStock`(防把百货库存语义抄进社交摊位)', () => {
  eq(countSym(afkCode, 'stallStock'), 0, 'afk.ts 出现了 stallStock —— 两套模型开始互相渗透');
  eq(countSym(afkRaw, 'stallStock'), 0, 'afk.ts 连注释里都不该出现 stallStock(会误导读者以为同名同物)');
});

test('FND149-7 两侧符号集交集为空,且社交摊位的四个函数生产引用 0', () => {
  const afkStall = ['createStall', 'listItem', 'buyFromStall', 'suggestedPrice', 'Stall', 'StallListing', 'STALL_ITEM_ID', 'STALL_SLOT_COUNT'];
  const depot = ['depotStock', 'setStallStock', 'stallStockOf', 'purchaseQuote', 'purchaseCommit'];
  const overlap = afkStall.filter((s) => depot.includes(s));
  eq(overlap, [], `两侧摊位符号集出现交集(${overlap.join(', ')})—— 同名异义又回来了`);
  for (const sym of ['createStall', 'listItem', 'buyFromStall', 'suggestedPrice']) {
    eq(
      prodCount(sym), 0,
      `${sym} 有了生产消费者(${prodHits(sym).join(', ')}) ⇒ 515 出现第二份定价/成交权威`
      + '(唯一权威是 systems/depot.ts;接线要先删掉社交摊位那套)',
    );
  }
});

test('FND149-8 两个模型仍绑定**同一件家具 515**(不许给社交摊位另开 id)', () => {
  eq(STALL_ITEM_ID, 515, 'social/afk.ts 的 STALL_ITEM_ID 必须仍是 515(无人自助售货摊)');
  const depotSection = worldRaw.slice(worldRaw.indexOf('A-4 百货店'), worldRaw.indexOf('C:料理 3 字段'));
  ok(depotSection.length > 0, 'world_sim.ts 的 A-4 百货店段找不到(段标题被改了?)');
  ok(
    depotSection.includes('CLOUD_DEPOT'),
    'world_sim.ts 的 515 段必须写明 `CLOUD_DEPOT` —— 那是它的幂等键房间名,也是"同一件家具"的锚',
  );
  ok(
    depotSection.includes('social/afk.ts'),
    '515 段必须显式点名 `social/afk.ts#createStall` 并说明"同名不同物"(否则改名只是把线索删了)',
  );
  /* 行为口径:推荐价来自冻结层 V_i × 1.6,对未知物品抛错(不是静默给 0)。 */
  ok(suggestedPrice(130) >= 1, 'suggestedPrice(130) 必须给出 ≥1 的推荐价');
  let threw = false;
  try { suggestedPrice(999999); } catch { threw = true; }
  ok(threw, 'suggestedPrice 对未知物品必须抛错(静默返回 0 会被当成"免费")');
});

/* ═══════════════════════ 隐患 3:两套赛道运行时 ═══════════════════════ */

/** `from '../party/scoring.ts'` 的具名导入列表(两侧都从这里取毫秒表)。 */
function scoringImports(src: string, spec: string): string[] {
  const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).exec(src);
  if (m === null) return [];
  return (m[1] as string)
    .split(',')
    .map((s) => s.replace(/^\s*type\s+/, '').trim())
    .filter((s) => s.length > 0);
}

test('FND149-9 结算权只在 party/modes.ts:afk.ts 拿不到发奖/播报符号', () => {
  const afkScoring = scoringImports(afkRaw, '../party/scoring.ts');
  ok(afkScoring.length > 0, 'afk.ts 必须仍从 party/scoring.ts 取毫秒表(找不到 import ⇒ 判据口径失效)');
  for (const banned of ['podiumBroadcast', 'rewardsForPlayers', 'rewardForRank', 'pushBroadcast', 'createBroadcaster', 'BROADCAST_KIND']) {
    ok(
      !afkScoring.includes(banned),
      `afk.ts 的赛道段拿到了 ${banned} ⇒ 社交赛道能自己发奖/播报,与 party/modes.ts 成了两条结算链`,
    );
    ok(
      modesRaw.includes(banned),
      `party/modes.ts 里找不到 ${banned} ⇒ "结算权在 modes" 这条判据变成了空话(正对照缺失)`,
    );
  }
  for (const own of ['PartySettlement', 'RewardLine']) {
    ok(!new RegExp(`\\b${own}\\b`).test(afkCode), `afk.ts 不得定义/引用 ${own}(那是结算类型,只属于 modes.ts)`);
  }
});

test('FND149-10 推进权只有一处:afk.ts 的赛道没有 tick;世界慢帧只推 tickPartyContest', () => {
  ok(
    !/function\s+tick[A-Za-z]*(?:Track|Race)\b/.test(afkCode),
    'afk.ts 出现了 tickTrack/tickRace ⇒ 两套赛道可以同时推进同一 tick(审计点名的隐患)',
  );
  for (const sym of ['tickTrack', 'tickRace', 'tickSocialTrack']) {
    eq(countSym(afkCode, sym), 0, `afk.ts 出现了推进口 ${sym}(赛道必须是**被动**计时口)`);
  }
  ok(countSym(worldCode, 'tickPartyContest') >= 1, '世界慢帧必须真的推 tickPartyContest(否则玩法赛道没人推进)');
  for (const sym of ['createTrack', 'trackStart', 'trackFinish', 'trackStandings']) {
    eq(
      countSym(worldCode, sym), 0,
      `world_sim.ts 调了 ${sym} ⇒ 社交赛道被接进世界侧,同一 tick 会有两套赛道计时`,
    );
  }
});

test('FND149-11 同一只毫秒表:两侧都用 scoring.ts 的 RaceTimer,afk.ts 不自带时钟', () => {
  ok(includesAll(scoringImports(afkRaw, '../party/scoring.ts'), ['createRaceTimer', 'gateStart', 'podiumFinish', 'rankRace', 'RaceTimer']),
    'afk.ts 必须仍用 scoring.ts 的 createRaceTimer / gateStart / podiumFinish / rankRace / RaceTimer');
  ok(includesAll(scoringImports(modesRaw, './scoring.ts'), ['RaceTimer']),
    'party/modes.ts 必须仍用 scoring.ts 的 RaceTimer');
  ok(
    !/interface\s+\w*(?:Race|Track)\w*Timer\b/.test(afkCode),
    'afk.ts 自带了第二套赛道计时器结构 ⇒ 毫秒口径会分叉(同一场比赛两个成绩)',
  );
});

test('FND149-12 互不相识:afk.ts 不知道 RaceRuntime,modes.ts 不知道 createTrack', () => {
  for (const sym of ['RaceRuntime', 'createRaceRun', 'settleRace']) {
    eq(countSym(afkCode, sym), 0, `afk.ts 引用了 ${sym} ⇒ 两套运行时开始互相调用(边界失效)`);
  }
  for (const sym of ['createTrack', 'TrackRuntime', 'trackFinish', 'trackCaught']) {
    eq(countSym(modesCode, sym), 0, `party/modes.ts 引用了 ${sym} ⇒ 玩法赛道调用了展示赛道(边界失效)`);
  }
});

test('FND149-13 标记 ⇄ 实现一致:RESERVED 段的符号必须真的在 afk.ts 里定义', () => {
  for (const seg of SEGMENTS) {
    for (const sym of seg.symbols) {
      ok(
        new RegExp(`export (?:function|const|interface|type|async function) ${sym}\\b`).test(afkCode),
        `第 ${seg.no} 段的 ${sym} 在 afk.ts 里找不到导出 —— 标记"预留"但实现没了 = 空注释`,
      );
    }
  }
});

/** 数组包含全部(报错信息指出缺哪一个)。 */
function includesAll(arr: readonly string[], need: readonly string[]): boolean {
  return need.every((n) => arr.includes(n));
}

report('WS-FND-149');