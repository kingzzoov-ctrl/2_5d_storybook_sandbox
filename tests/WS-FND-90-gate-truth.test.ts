/**
 * WS-FND-90 —— 门禁可信度(审计 P1:三处「已实测」的判据失效)
 *
 * ## 这一组守的是什么
 *
 * 三道门禁都能通过,但它们**判断的事**其实没被验证:
 *
 * | # | 原缺陷(实测) | 本套判据 |
 * |---|---|---|
 * | P1-1 | `scripts/backlog.ts` 把「已关闭 / 已完成」当关闭判据:133 条**全部**判关,其中 100 条的关闭状态**只由这两个词决定** | FND90-1/2:关闭 = **标记 ∧ 可查证据**(`判据` / `CR-<n>` / `tests/<x>.ts` / `<doc>.md §<n>`);登记表同样要过证据关 |
 * | P1-2 | `server/src/content/registry.ts` 的指纹**手挑字段**:items 无 `recipe/station/output`、mobs 无 `drops` ⇒ 改平衡数据指纹**不变** | FND90-3/4/5:改平衡字段 ⇒ 分区指纹必变;改文档字段 ⇒ 不变;版本随字段集变更 |
 * | P1-3 | `count-audit` 的 orphan 正解取**字面条数**(10)vs 实测 9,**永不互校**;`orphan-audit` 摘要**硬写**「0 处失真」;`build/wiring_view.ts` 因 prod=0 且 test=0 被 `continue` 跳过 ⇒ 真死文件不可见 | FND90-6/7:字面条数 == 运行时 Map == 实测 orphan + 死文件;互校有牙(注入必红) |
 *
 * ## 判据设计的三条纪律(与本仓既有结论一致)
 *
 * ```
 * 1 每条判据都要能**失败**：负对照 + 注入验证各至少一次(不是「跑过了」就算数)
 * 2 行为判据优先于文本判据：能改一行数据看它红,就不要只 grep 源码
 * 3 注入不写仓内文件：用 os.tmpdir() 造最小树,挂在 finally 里删干净
 * ```
 */

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { collectOpenItems, CLOSURE_ANNEX, classifyClosure, hasClosureEvidence } from '../scripts/backlog.ts';
import {
  contentFingerprints,
  CONTENT_FINGERPRINT_VERSION,
  FINGERPRINT_EXCLUDED,
} from '../server/src/content/registry.ts';
import { readBaseline, diffBaseline } from '../server/src/content/baseline.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
import { MOB_LIST } from '../shared/constants/mobs.ts';
import { BOSS_LIST } from '../shared/constants/bosses.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════ 工具 ═══════════════════════ */

interface RunResult { status: number; out: string }

/** 跑一个脚本,**把退出码就地取出**(推远会被「读了没有」类判据误判成没读)。 */
function run(cwd: string, args: string[]): RunResult {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 原地改一个字段,返回**还原函数**。
 *
 * 为什么用这种方式做注入:内容表是 `const` 数组但对象**未冻结** ⇒
 * 可以在同进程里改一格、算一次指纹、再改回来 —— 既真实(走的是生产代码路径),
 * 又不需要写仓内文件(`shared/**` 本任务禁改)。
 */
function setField(obj: object, key: string, value: unknown): () => void {
  const rec = obj as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(rec, key);
  const before = rec[key];
  rec[key] = value;
  return (): void => {
    if (had) rec[key] = before;
    else delete rec[key];
  };
}

/** 机读结果:必须与 `orphan-audit.ts` 打印的字段一一对应。 */
interface OrphanJson {
  measured: number;
  measuredLines: number;
  dead: number;
  deadFiles: string[];
  registered: number;
  unlisted: number;
  unlistedDead: number;
  registeredNotMeasured: string[];
  stale: number;
}

function parseOrphanJson(out: string): OrphanJson | null {
  const m = /__ORPHAN_AUDIT_JSON__(\{[^\n]*\})/.exec(out);
  if (m === null) return null;
  try {
    return JSON.parse(m[1]!) as OrphanJson;
  } catch {
    return null;
  }
}

/**
 * **独立解析器**:直接数 `ORPHAN_KNOWN` 字面表的条目数。
 *
 * 与 `orphan-audit` 的运行时 `Map.size` 是**两条互不相干的路**:
 * 一条读源码文本、一条读内存对象。两者必须相等 —— 这正是
 * `verify.ts:3970` 用单行正则解析该表时踩过的坑(多行写法会被静默丢弃)。
 */
function countOrphanKnownLiteral(): number | null {
  const src = readFileSync(join(ROOT, 'scripts', 'orphan-audit.ts'), 'utf8');
  const start = src.indexOf('export const ORPHAN_KNOWN');
  if (start < 0) return null;
  const end = src.indexOf(']);', start);
  if (end < 0) return null;
  return src.slice(start, end).split('\n').filter((l) => /^\s*\[\s*'/.test(l)).length;
}

/* ═════════════════ P1-1 台账:关闭必须有证据 ═════════════════ */

test('FND90-1 台账自洽:判为「已关闭」的条目必须带可查证据,且三类互斥穷尽', () => {
  const items = collectOpenItems();
  ok(items.length > 0, '台账解析为空 ⇒ 本判据不成立(不是"没有未决项")');

  /* 主判据:closed ⇒ evidence。这是被修的那条不变量。 */
  for (const it of items) {
    if (it.closed) {
      ok(it.evidence, `${it.doc}:${it.line} ${it.id} 被判为已关闭,却没有 判据/CR/tests/§ 证据`);
    }
  }
  /* 反向:bareClose 是「只写了词」的那一类,它**不许**被算成关闭。 */
  for (const it of items) {
    if (it.bareClose) {
      ok(!it.closed, `${it.doc}:${it.line} ${it.id} 仅标记无证据却被算作已关闭`);
      ok(!it.evidence, `${it.doc}:${it.line} ${it.id} 的 bareClose 与 evidence 同时为真(分类自相矛盾)`);
    }
  }
  /* 穷尽性:closed / bareClose / 普通未关闭 三类之和 = 总数(不许有第四态,也不许漏) */
  const closed = items.filter((i) => i.closed).length;
  const bare = items.filter((i) => i.bareClose).length;
  const plain = items.filter((i) => !i.closed && !i.bareClose).length;
  eq(closed + bare + plain, items.length, '三类之和应等于台账总数');
  console.log(`      · 台账 ${items.length} 条:有据关闭 ${closed} / 仅标记无据 ${bare} / 未关闭 ${plain}`);
});

test('FND90-2 关闭判据的注入验证:决定结果的是「证据」,不是「标记词」', () => {
  /* 负对照 —— 只有词:这正是审计实测的那 100 条的形态 */
  const wordOnly = classifyClosure('| U1 | 已修 | **已关闭(2026-11-17)** |');
  eq(wordOnly.marked, true, '标记词应被识别(否则判据恒真)');
  eq(wordOnly.evidence, false, '这句话里没有任何可查证据');
  eq(wordOnly.closed, false, '★ 只有标记词 ⇒ 不许判关(修复前这里会判关)');

  /* 正对照 —— 同一句话加上证据就成立(证明"证据"真的参与判定) */
  eq(classifyClosure('| U1 | **已关闭** | 判据 tests/WS-01.test.ts |').closed, true);

  /* 四种合法证据逐条成立(只测一种会漏掉其余三种的正则写错) */
  ok(hasClosureEvidence('由 D-19 落地,判据 tests/WS-FND-71-combat-depth.test.ts FND71-3'), '判据');
  ok(hasClosureEvidence('见 CR-29'), 'CR 编号');
  ok(hasClosureEvidence('判据 tests/WS-FND-90-gate-truth.test.ts'), 'tests 链接');
  ok(hasClosureEvidence('见 RULINGS-DRAFT §4.8'), '文档章节锚点');
  /* 负对照:无法核对的措辞不算证据(放行任何一条,整张表就会被重新写软) */
  ok(!hasClosureEvidence('已修,无需处理'), '「已修」不是可核对锚点');
  ok(!hasClosureEvidence('见上文'), '「见上文」不是可核对锚点');

  /* 登记表不是后门:每条 basis 自己也要过证据关 */
  ok(CLOSURE_ANNEX.length > 0, '登记表为空 ⇒ 下面这条循环恒真,判据失效');
  for (const a of CLOSURE_ANNEX) {
    ok(hasClosureEvidence(a.basis), `CLOSURE_ANNEX ${a.doc} ${a.id} 的 basis 无可查证据:${a.basis.slice(0, 40)}`);
  }
});

/* ═════════════════ P1-2 内容指纹:平衡字段必须进哈希 ═════════════════ */

test('FND90-3 items 分区:改 recipe / station / output ⇒ 指纹必须变(此前全盲)', () => {
  const item = ITEM_LIST.find((i) => i.recipe !== undefined && Object.keys(i.recipe).length > 0);
  /* ⚠️ 用 `throw` 而非 `ok()`:harness 的 `ok()` 不是断言函数(签名是 `unknown`),
     TS 不会据此收窄类型 ⇒ 后面 `item.recipe` 会被报 possibly undefined。 */
  if (item === undefined) throw new Error('找不到带 recipe 的物品 ⇒ 本判据无锚点');
  const base = contentFingerprints().items;

  /* 注入 1:配方(材料 ID → 数量) */
  let undo = setField(item, 'recipe', { ...item.recipe, 999: 7 });
  try {
    ok(contentFingerprints().items !== base, '★ 改配方后 items 指纹必须变(修复前不变)');
  } finally { undo(); }

  /* 注入 2:设备 */
  undo = setField(item, 'station', 4242);
  try {
    ok(contentFingerprints().items !== base, '★ 改 station 后 items 指纹必须变');
  } finally { undo(); }

  /* 注入 3:产出数量 */
  undo = setField(item, 'output', 99);
  try {
    ok(contentFingerprints().items !== base, '★ 改 output 后 items 指纹必须变');
  } finally { undo(); }

  /* 还原断言:证明上面三次变化来自注入,不是"每次都变"的随机性 */
  eq(contentFingerprints().items, base, '撤销注入后 items 指纹必须复原');
});

test('FND90-4 mobs / bosses 分区:改 drops / phases ⇒ 指纹必须变', () => {
  const mob = MOB_LIST.find((m) => Object.keys(m.drops ?? {}).length > 0);
  if (mob === undefined) throw new Error('找不到带 drops 的生物 ⇒ 本判据无锚点');
  const mobBase = contentFingerprints().mobs;
  let undo = setField(mob, 'drops', { ...mob.drops, 998: 5 });
  try {
    ok(contentFingerprints().mobs !== mobBase, '★ 改掉落表后 mobs 指纹必须变(修复前不变)');
  } finally { undo(); }
  eq(contentFingerprints().mobs, mobBase, '撤销注入后 mobs 指纹必须复原');

  const boss = BOSS_LIST.find((b) => Array.isArray(b.phases) && b.phases.length > 0);
  if (boss === undefined) throw new Error('找不到带阶段表的 Boss ⇒ 本判据无锚点');
  const bossBase = contentFingerprints().bosses;
  undo = setField(boss, 'phases', boss.phases.slice(0, -1)); // 砍掉最后一阶段
  try {
    ok(contentFingerprints().bosses !== bossBase, '★ 改阶段表后 bosses 指纹必须变(修复前只哈希 loot)');
  } finally { undo(); }
  eq(contentFingerprints().bosses, bossBase, '撤销注入后 bosses 指纹必须复原');
});

test('FND90-5 负对照:文档字段不进指纹 + 排除表不许出现平衡字段 + 版本随字段集变更', () => {
  /* 负对照:改 note(自由文本机制说明)⇒ 指纹**不变**。
     若这里也变了,说明指纹变成了"任何改动都变"的噪声 —— 那与"任何改动都不变"同样没用。 */
  const noteBase = contentFingerprints().items;
  const undo = setField(ITEM_LIST[0]!, 'note', `${ITEM_LIST[0]!.note}〔FND90 注入〕`);
  try {
    eq(contentFingerprints().items, noteBase, 'note 是文档字段,改它不应改变指纹');
  } finally { undo(); }

  /* 结构判据:排除表只允许文档字段。
     ⚠️ 这是**反向**防线:有人为了"消红"把某个平衡字段塞进排除表,指纹就会重新变盲。 */
  const BALANCE_FIELDS = [
    'id', 'name', 'category', 'tags', 'value', 'recipe', 'recipeAnyTag', 'output', 'station', 'price',
    'biome', 'behavior', 'level', 'hp', 'exp', 'drops', 'tameItem',
    'baseHp', 'summonItem', 'loot', 'phases', 'breakMechanic',
  ];
  for (const part of ['items', 'mobs', 'bosses'] as const) {
    for (const k of FINGERPRINT_EXCLUDED[part]) {
      ok(!BALANCE_FIELDS.includes(k), `★ ${part} 分区的指纹排除了平衡字段 ${k} ⇒ 改它不会红`);
    }
  }
  ok(FINGERPRINT_EXCLUDED.items.includes('note'), '排除表必须非空(否则上面对照没有意义)');

  /* 字段集是算法的一部分 ⇒ 版本必须随之下调(修复前是 1,字段集改了还是 1 就会混淆两套算法) */
  ok(CONTENT_FINGERPRINT_VERSION >= 2, `字段集已变更 ⇒ 版本必须 ≥2,实际 ${CONTENT_FINGERPRINT_VERSION}`);
  const f = contentFingerprints();
  eq(f.version, CONTENT_FINGERPRINT_VERSION, '指纹里的版本号必须与常量一致');

  /* 基线必须与当前内容同步(否则内容锁只会报"不一致",而新字段是否真进哈希无从判断) */
  const drift = diffBaseline(readBaseline());
  ok(drift.present, '基线文件必须存在(缺失 = 无法判断,不是通过)');
  ok(
    drift.inSync,
    `基线必须与当前内容一致:执行 node scripts/content-lock.ts --update。差异:${drift.changes.slice(0, 3).join(' / ')}`,
  );
});

/* ═════════════════ P1-3 登记 ↔ 实测 互校 ═════════════════ */

test('FND90-6 真实树互校:字面条数 == 运行时 Map == 实测 orphan + 死文件', () => {
  const r = run(ROOT, ['scripts/orphan-audit.ts']);
  const parsed = parseOrphanJson(r.out);
  if (parsed === null) throw new Error('orphan-audit 必须产出机读行(解析不到 ⇒ 与"没有失真"不可区分)');

  /* ① 同一张表的两个独立解析器:源码文本(本文件) vs 运行时 Map(脚本) */
  const literal = countOrphanKnownLiteral();
  if (literal === null || literal === 0) throw new Error('字面条数解析失败或为 0 ⇒ 本判据不可信(不是"表是空的")');
  eq(literal, parsed.registered, '字面条数应等于运行时 Map.size(否则有键被塌缩/漏解析)');

  /* ② 登记 == 实测 orphan + 死文件。这就是「自己比自己」被修掉的那条:
        修复前 登记 10 / 实测 9,两个数都印出来,却没有东西比较它们。 */
  eq(
    parsed.measured + parsed.dead,
    parsed.registered,
    `登记 ${parsed.registered} 应等于 实测 orphan ${parsed.measured} + 死文件 ${parsed.dead}`,
  );
  eq(parsed.registeredNotMeasured.length, 0, `有登记项实测归不进任何一类:${parsed.registeredNotMeasured.join(', ')}`);
  eq(parsed.unlisted, 0, `有未登记的实测 orphan ${parsed.unlisted} 个`);
  eq(parsed.unlistedDead, 0, `有未登记的死文件 ${parsed.unlistedDead} 个`);

  /* ③ 遍历口径:`server/src/build/` 必须被扫到。
         修复前 `shouldSkipDir()` 把整个目录当构建产物跳掉 ⇒ 该文件不在 prodFiles 里,
         于是"登记 10 / 实测 9"永远对不上,而门禁全绿。 */
  ok(
    r.out.includes('server/src/build/wiring_view.ts'),
    '★ server/src/build/ 下的生产文件必须出现在实测清单里(修复前整棵被跳过)',
  );

  /* ④ 「两边都 0」这一类必须出现在机读结果里(即使当前 0 个)——
         没有这个字段,死文件就仍然是不可见的。 */
  ok(Array.isArray(parsed.deadFiles), '机读结果必须暴露 deadFiles 字段');
  eq(parsed.dead, parsed.deadFiles.length, 'dead 计数与 deadFiles 列表必须一致');
  ok(r.status === 0 || parsed.measured + parsed.dead !== parsed.registered,
    'orphan-audit 既报非零退出、又声称互校一致 ⇒ 退出码与判据不一致');
});

test('FND90-7 互校有牙(注入):实测归不进登记时必须报出来,不许恒绿', () => {
  /* ── 注入 A:把 orphan-audit 放进一棵空树 ──
     空树里 10 条登记全部"文件不存在",实测 = 0 ⇒ 互校必须崩。
     这模拟的是「度量口径悄悄变窄」(修复前正是它的温和版本)。 */
  const fakeOrphan = mkdtempSync(join(tmpdir(), 'wsfnd90-orphan-'));
  try {
    mkdirSync(join(fakeOrphan, 'scripts'), { recursive: true });
    mkdirSync(join(fakeOrphan, 'server', 'src', 'sim'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts', 'orphan-audit.ts'), join(fakeOrphan, 'scripts', 'orphan-audit.ts'));
    copyFileSync(join(ROOT, 'scripts', 'scan-scope.ts'), join(fakeOrphan, 'scripts', 'scan-scope.ts'));
    /* 词法自检的阳性对照锚点:必须有那条裸 import,否则脚本在自检处就退出(那也不证明互校有牙) */
    writeFileSync(
      join(fakeOrphan, 'server', 'src', 'sim', 'world_sim.ts'),
      "import '../wiring/components.ts';\n",
      'utf8',
    );

    const r = run(fakeOrphan, ['scripts/orphan-audit.ts']);
    eq(r.status, 1, '实测无法确认登记时必须非零退出(不许静默通过)');
    const parsed = parseOrphanJson(r.out);
    if (parsed === null) throw new Error('即使失败也必须打印机读行(否则"有失真"与"没跑起来"不可区分)');
    eq(parsed.measured, 0, '空树里不该有实测 orphan');
    ok(parsed.registered > 0, '空树里登记表仍然非空(脚本自带)');
    ok(
      parsed.measured + parsed.dead !== parsed.registered,
      '★ 互校必须暴露「登记非零 / 实测 0」的差额(修复前这组数字从不互相校验)',
    );
  } finally {
    rmSync(fakeOrphan, { recursive: true, force: true });
  }

  /* ── 注入 B:把 count-audit 放进伪树,让「字面条数」与「运行时 Map」故意打架 ──
     字面 5 条 / 运行时 3 条 ⇒ ① 与 ② 同时不成立 ⇒ 必须 `★ 登记失真` 且非零退出。
     这一条同时证明了 count-audit 真的**消费**了 orphan-audit 的机读结果,
     而不是各自印各自的数。 */
  const fakeCount = mkdtempSync(join(tmpdir(), 'wsfnd90-count-'));
  try {
    mkdirSync(join(fakeCount, 'scripts'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts', 'count-audit.ts'), join(fakeCount, 'scripts', 'count-audit.ts'));
    writeFileSync(
      join(fakeCount, 'scripts', 'verify.ts'),
      'export const UNREACHABLE_EXEMPT = new Set<string>([\n'
      + "  'a.ts',\n"
      + "  'b.ts',\n"
      + ']);\n'
      + 'export const TAUT_SUSPECT_EXEMPT = new Set<string>([\n'
      + ']);\n',
      'utf8',
    );
    /* 字面 5 条 … 但机读行谎称 registered 3(模拟"登记与实测分叉") */
    writeFileSync(
      join(fakeCount, 'scripts', 'orphan-audit.ts'),
      'export const ORPHAN_KNOWN = new Map<string, string>([\n'
      + "  ['a.ts', '理由理由理由理由'],\n"
      + "  ['b.ts', '理由理由理由理由'],\n"
      + "  ['c.ts', '理由理由理由理由'],\n"
      + "  ['d.ts', '理由理由理由理由'],\n"
      + "  ['e.ts', '理由理由理由理由'],\n"
      + ']);\n'
      + "console.log('__ORPHAN_AUDIT_JSON__' + JSON.stringify({\n"
      + '  measured: 0, measuredLines: 0, dead: 0, deadFiles: [], registered: 3,\n'
      + '  unlisted: 0, unlistedDead: 0, registeredNotMeasured: [], stale: 0,\n'
      + '}));\n',
      'utf8',
    );

    const r = run(fakeCount, ['scripts/count-audit.ts']);
    eq(r.status, 1, '登记与实测打架时必须非零退出');
    ok(r.out.includes('★ 登记失真'), '必须报出「★ 登记失真」(这是 verify.ts 接链时锚的那一行)');
    ok(/登记\s+3\s*≠\s*实测 orphan\s+0/.test(r.out), '报错要指出**哪两个数**不一致,不能只说"失真"');
    ok(!/正解缺失/.test(r.out), '本注入只该触发互校失败,不该连带触发"正解缺失"(否则分不清是哪条在红)');
  } finally {
    rmSync(fakeCount, { recursive: true, force: true });
  }
});

/* 注入用的临时目录一律 `os.tmpdir()` + `finally rmSync`:
   本仓有「临时残留」门禁(扫仓根),写进仓内会假红;写进系统临时目录则天然隔离。 */
report('WS-FND-90');