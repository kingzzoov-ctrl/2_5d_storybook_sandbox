/**
 * ★ task-76:补上本仓**一直缺的那个检测器** —— 注释/文档里写死的「可被代码算出来的数」。
 *
 * ## 缺口(实测)
 *
 * 陷阱 92:「已提交文档里的事实错误 —— 文档的读者没有编译器」。
 * 本仓已有 6 起同类事故,而**没有针对「N 个」计数的检测器**。
 * 实测(本轮):`scripts/verify.ts` 自己的注释里有 **4 处陈旧数**:
 *   · 「本表 22 条」    实际 14
 *   · 「ORPHAN_KNOWN(13)⊆UNREACHABLE_EXEMPT(22)」实际 9 ⊆ 14
 *   · 「差 9 条(22 vs 13)」实际 5(14 vs 9)
 *   · 「白名单 50 条」(两处)实际 14,且「50 条全部都是欠账」与事实相反(其中 3 条非欠账)
 * 而**同一个文件里的门禁每次都在打印正确的 14** ⇒
 *   正确值与错误值共存于一个文件,没有任何东西比对它们。
 *
 * ## 判据可门禁性(本仓的分水岭)
 *
 * ```
 * 判据是否要求「推断意图」? 要求 ⇒ 出清单;不要求 ⇒ 可门禁。
 * ```
 * 「这段散文里提到某个数,它指向哪个运行时量?」——**要求推断** ⇒ 本探针**只出清单**,
 * 不自动判红。硬猜会误报,而误报会催生「忽略这条」。
 *
 * ## 但它能做一件确定的事
 *
 * 把**有唯一正解**的那几类数挑出来,自动比对:
 *   · `白名单 N 条` → `UNREACHABLE_EXEMPT.size`
 *   · `ORPHAN_KNOWN(N)` → orphan-audit 的实有条数
 *   · `本表 N 条` → 同上
 * 这几类的**语义唯一**(就是那个 Map 的大小),不需要推断 ⇒ 可自动比对。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();

/** 数一个 `new Map<string,string>([...])` / `new Set<string>([...])` 的条目数。 */
function countEntries(file: string, declName: string): number | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${declName}\\s*=\\s*new\\s+(?:Map|Set)<[^>]*>\\(\\[([\\s\\S]*?)\\n\\]\\);`,
  );
  const m = re.exec(src);
  if (!m) return null;
  const body = m[1]!;
  /* Map 条目形如 ['key', 'reason'] 在行首缩进 2 空格;Set 是 'key' */
  const mapEntries = [...body.matchAll(/^\s{2}\['([^']+)',/gm)].length;
  const setEntries = [...body.matchAll(/^\s{2}'([^']+)',/gm)].length;
  if (mapEntries > 0) return mapEntries;
  if (setEntries > 0) return setEntries;
  /* ★ 2026-11-18 审计 P1-4:此前这里是
   *   `return mapEntries > 0 ? mapEntries : setEntries;`
   * ⇒ 条目**缩进一变**(2 空格 → 4 空格)两张正则都数不到,返回值是 **0**,
   *   而 0 是一个**合法正解**(表真的空)⇒ 断言 #2(只查 `undefined`)看不出来:
   *   正解静默变成 0,若引用它的自称也写着 0,整条链**逐字全绿**。
   * ⇒ 现在把两种世界分开:表体**确实为空**才是 0;数不出条目一律 null,
   *   由 `EXPECTED_TRUTH_KEYS`(键缺失)与 `ZERO_TRUTH_DECLARED`(0 必须认账)两道判。 */
  /* ⚠️ 判据是「剥掉注释后还剩什么」,不是 `body.trim() === ''`:
     本仓的空白名单是**会说话的注释**(`TAUT_SUSPECT_EXEMPT` 里整段都是块注释、
     说明「哪条已修、为什么摘除」,而**一条条目都没有**)⇒ 那种表体 trim 不为空,
     但它确实是 0 条。故:剥注释后为空 ⇒ 0(实测的空表);还剩非注释内容却数不出
     条目 ⇒ null(缩进 / 形态变了)。 */
  return stripComments(body).trim() === '' ? 0 : null;
}

/**
 * 剥掉注释(块 + 行),只回答「还剩代码吗」。
 *
 * ⚠️ **刻意不用正则**:剥行注释的常见写法若缺 `(^|[^:])` 前缀,会把 `https://`
 * 当注释起点(judgement_audit 的 B 类形态,本仓已登记若干处挂账)。
 * 逐字符扫没有那个洞,也不需要往登记表里再加一条挂账。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      out += ' ';
      continue;
    }
    if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

const TRUTH: Record<string, number> = {};
/* ★ 每个「正解」都必须解析成功 —— 见文件末尾的断言 #2。
 * 这张表**必须**列出全部应有键:漏一个键 ⇒ 该键永远 undefined ⇒
 * 引用它的自称被判 '?'(既不 ✓ 也不 ★)⇒ **改个声明名就能让它静默恒绿**。 */
const EXPECTED_TRUTH_KEYS = ['可达性白名单', 'orphan', '同义反复白名单'] as const;
/* ★ 2026-11-18 审计 P1-4:**0 也要判**。
 * `countEntries` 现在只在「表体确实是空的」时才返回 0(见它的注释)⇒ 理论上
 * 0 已经是实测值;但「某个键的正解变成 0」这件事**必须有人显式认账** ——
 * 否则一张表被清空(或改写形态导致数不出条目、且恰好真的成了空表)会静默通过。
 * ⇒ 判据:任何一个 TRUTH 键解析为 0,都必须出现在这张登记里(断言 #2b)。 */
const ZERO_TRUTH_DECLARED: readonly string[] = ['同义反复白名单'];
{
  const wl = countEntries(join(ROOT, 'scripts/verify.ts'), 'UNREACHABLE_EXEMPT');
  const orphan = countEntries(join(ROOT, 'scripts/orphan-audit.ts'), 'ORPHAN_KNOWN');
  const taut = countEntries(join(ROOT, 'scripts/verify.ts'), 'TAUT_SUSPECT_EXEMPT');
  /* ⚠️ `!== null` 是**唯一**的收下条件:null(数不出条目)不许写成 0 —— 那正是
     审计 P1-4 那条「正解静默变 0」;键不落地 ⇒ 断言 #2 报「正解缺失」。 */
  if (wl !== null) TRUTH['可达性白名单'] = wl;
  if (orphan !== null) TRUTH['orphan'] = orphan;
  if (taut !== null) TRUTH['同义反复白名单'] = taut;
}

/* ══════════════ 正解的另一半:登记 ↔ 实测 互校(审计 P1-3)══════════════
 *
 * ## 缺口(实测)
 *
 * 上面 `TRUTH['orphan']` 是**字面条数**(从 `ORPHAN_KNOWN` 的源码文本数出来的),
 * 而 `orphan-audit.ts` 报的是**实测条数**。2026-11-18 实测这两个数**不相等**:
 * ```
 *   字面/登记 10   实测 9     ← 差 1 条,而没有任何东西比较它们
 * ```
 * 更糟的是 `orphan-audit` 的摘要行**硬写**「…/ **0 处失真**」:
 * 「0」是常量,不是算出来的 ⇒ 无论差额多大都印 0,读的人以为两个数对上了。
 * ⇒ 这正是「自己比自己」的形态:**两个数被分别印出来,却从不互相校验。**
 *   (那一轮的差额根因是遍历口径 —— `server/src/build/` 整棵被跳过。
 *    见 `orphan-audit.ts` 的 `walk()` 注释。)
 *
 * ## 处置
 *
 * 让 `orphan-audit.ts` 同时输出一行机读结果(`__ORPHAN_AUDIT_JSON__{...}`),
 * 本脚本据此做**三方互校**:
 * ```
 *   ① 字面条数(本文件自己数)      == 运行时 Map.size(orphan-audit 报)
 *   ② 登记条数                     == 实测 orphan + 死文件(两边都 0)
 *   ③ 无「登记了但实测归不进任何一类」的条目
 * ```
 * 任一不成立 ⇒ `★ 登记失真`,并置非零退出码。
 *
 * ⚠️ 「解析不到机读行」**不能当通过**:那与「没有失真」不可区分 ——
 *    本仓反复点名的陷阱 126(对「坏掉」与「报红」不可区分)。
 */
interface OrphanAuditJson {
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

/** 跑一次 orphan-audit 并取出机读行;跑不起来 / 解析失败返回 null(不是"0 失真")。 */
function readOrphanAudit(): OrphanAuditJson | null {
  const script = join(ROOT, 'scripts', 'orphan-audit.ts');
  if (!existsSync(script)) return null;
  const r = spawnSync(process.execPath, ['scripts/orphan-audit.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  /* ★ 退出码**就地**读掉(判据形态审计 F 的实质:spawnSync **从不抛** ——
     崩溃 / 超时被杀时 `status ≠ 0` 且 stdout 为空。不读它就等于
     「子进程崩了」与「没有失真」不可区分 = 静默假绿(陷阱 126)。
     ⚠️ 这里**不**把非零当通过:返回 null ⇒ 调用方把整道互校判成
     「★ 登记失真」,而不是印一行绿。 */
  const spawnStatus = r.status;
  const spawnError = r.error;
  if (spawnError !== undefined || spawnStatus === null || spawnStatus !== 0) return null;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /__ORPHAN_AUDIT_JSON__(\{[^\n]*\})/.exec(out);
  if (m === null) return null;
  try {
    return JSON.parse(m[1]!) as OrphanAuditJson;
  } catch {
    return null;
  }
}

const ORPHAN_AUDIT = readOrphanAudit();
/** 互校问题清单(空 = 两个数确实对上了)。 */
const CROSS_PROBLEMS: string[] = [];
if (ORPHAN_AUDIT === null) {
  CROSS_PROBLEMS.push(
    'orphan-audit 未产出机读行(`__ORPHAN_AUDIT_JSON__`)⇒ 无法互校'
    + ' ⇒ 与「没有失真」不可区分(崩溃 / 超时 / 格式变了都会走到这里)',
  );
} else {
  /* ① 同一张表的两个独立解析器:源码文本 vs 运行时 Map */
  const literal = TRUTH['orphan'];
  if (literal === undefined) {
    CROSS_PROBLEMS.push('本文件解析不出 `ORPHAN_KNOWN` 字面条数 ⇒ ① 无法互校');
  } else if (literal !== ORPHAN_AUDIT.registered) {
    CROSS_PROBLEMS.push(
      `同一张表两个解析器不一致:字面条数 ${literal} vs 运行时 Map.size ${ORPHAN_AUDIT.registered}`
      + '(多行写法 / 重复键 / 锚点漂移)',
    );
  }
  /* ② 登记 ⊇ 实测 ∪ 死文件,且不许多 */
  if (ORPHAN_AUDIT.measured + ORPHAN_AUDIT.dead !== ORPHAN_AUDIT.registered) {
    CROSS_PROBLEMS.push(
      `登记 ${ORPHAN_AUDIT.registered} ≠ 实测 orphan ${ORPHAN_AUDIT.measured}`
      + ` + 死文件 ${ORPHAN_AUDIT.dead} = ${ORPHAN_AUDIT.measured + ORPHAN_AUDIT.dead}`
      + ' ⇒ 有登记项在实测里找不到对应,或有实测项没登记',
    );
  }
  /* ③ 归不进任何一类的登记项 */
  if (ORPHAN_AUDIT.registeredNotMeasured.length > 0) {
    CROSS_PROBLEMS.push(
      `${ORPHAN_AUDIT.registeredNotMeasured.length} 条登记项既不被生产引用、`
      + `也不在实测 orphan/死文件里:${ORPHAN_AUDIT.registeredNotMeasured.slice(0, 5).join(', ')}`,
    );
  }
  if (ORPHAN_AUDIT.unlisted > 0 || ORPHAN_AUDIT.unlistedDead > 0) {
    CROSS_PROBLEMS.push(
      `实测有未登记项:orphan ${ORPHAN_AUDIT.unlisted} 个 / 死文件 ${ORPHAN_AUDIT.unlistedDead} 个`,
    );
  }
  if (ORPHAN_AUDIT.stale > 0) {
    CROSS_PROBLEMS.push(`orphan-audit 自报登记清单失真 ${ORPHAN_AUDIT.stale} 处`);
  }
}
console.log('══ 0 正解(由代码算出,不是抄的)══');
for (const [k, v] of Object.entries(TRUTH)) console.log(`   ${k} = ${v}`);
if (TRUTH['可达性白名单'] !== undefined && TRUTH['orphan'] !== undefined) {
  console.log(`   差集 = ${TRUTH['可达性白名单']} - ${TRUTH['orphan']} = `
    + `${TRUTH['可达性白名单'] - TRUTH['orphan']}`);
}

/**
 * ★★ 第二版订正:第一版把「白名单」当成一个量,实测发现它有**两个**所指 ——
 *
 * ```
 * README:64  白名单 14 条   ← UNREACHABLE_EXEMPT(可达性)
 * README:129 白名单 32 条   ← TAUT_SUSPECT_EXEMPT(同义反复),实测 34
 * ```
 * 第一版把第 129 行的 32 判成「陈旧(正解 14)」——**是我的检测器错,不是文档错**。
 * 32 确实不等于 34(真陈旧),但**原因与 14 无关**。
 *
 * ⇒ 这是**同一词汇指两个量**的经典陷阱。判据:
 *   「一个名字在文档里出现 >1 次且指向不同量」⇒ 任何按该名字匹配的检测器都会误报。
 *   ⇒ 处置:匹配式必须带上**区分词**(「同义反复…白名单」vs 纯「白名单」)。
 *   ⇒ 而更根本的处置是:**让两个量在文档里不共用同一个词**
 *     (已在上游改为「可达性白名单」/「同义反复白名单」)。
 */
const PATTERNS: { re: RegExp; key: string; desc: string }[] = [
  /* 同义反复白名单:必须带「同义反复」前缀才认 —— 否则落到下面"可达性"那条 */
  { re: /同义反复[^\n]{0,20}?白名单\s*(\d+)\s*条/g, key: '同义反复白名单', desc: '同义反复白名单条数' },
  { re: /`ORPHAN_KNOWN`\s*[((]\s*(\d+)\s*[))]/g, key: 'orphan', desc: 'ORPHAN_KNOWN 条数' },
  /* 可达性白名单:显式名,或"本表 N 条";⚠️ 必须排除已被上一式吃掉的"同义反复…白名单" */
  { re: /可达性白名单\s*(\d+)\s*条/g, key: '可达性白名单', desc: '可达性白名单条数' },
  { re: /本表\s*(\d+)\s*条/g, key: '可达性白名单', desc: '本表(=可达性白名单)条数' },
];

/** 扫这些文件里的「N 条」型自称。 */
const SCAN_FILES = ['README.md', 'scripts/verify.ts', 'scripts/orphan-audit.ts'];

/**
 * ★★ 范围界定:为什么**只扫活文档**,不扫 `docs/ADVERSARIAL-REVIEW-*.md` 与 PROGRESS.md
 *
 * 第一版我扫了整个 `docs/`,实测出 **30 处「陈旧」** —— 而其中 24 处**不是陈旧**:
 *
 * ```
 * docs/ADVERSARIAL-REVIEW-11.md:186
 *   ✓ 生产可达性:可达 24 / 不可达 50 (共 74,入口 2 个,白名单 50 条)
 * ```
 * 那是**那次运行的门禁输出原文,逐字引用**。它本来就该写 50 ——
 * 因为当时确实是 50。改成 14 反而是**篡改历史记录**。
 *
 * ⇒ 这正是陷阱 94 的形态:检测器的**三版实测 49 / 365 / 0**,
 *   「收窄范围」与「收紧判据」不是同一件事。
 *   我第一版的错不是判据错,是**范围错**:把「引用」当成了「自称」。
 *
 * ## 为什么不用"文件名含 ADVERSARIAL/PROGRESS 就豁免"
 *
 * 那是**按名字匹配的规则**(陷阱 91):既保护不了该保护的(将来某份报告里
 * 真写错一个数),也放过不了不该放的(README 里引用的历史数也被放过)。
 * ⇒ 本脚本改为**只扫一份显式的文件清单**:这三个文件的性质是
 *   「**描述当前状态**」,所以它们里面的数**应当**等于当前值。
 *   其余文件是「描述过去某时刻」,不在本脚本范围。
 *   ⇒ 是范围界定,不是豁免规则。
 */
const files: string[] = [...SCAN_FILES];
void join; /* 保留 import,供将来扩展目录扫描 */

/* ★★ 审计 P1(2026-11-18):**扫描范围本身也会静默缩水**
 *
 * 旧代码:`if (!existsSync(...)) continue;` —— 把一个被扫文件删掉/改名,
 * 它里面的自称就**一起消失**,而本脚本照样打印「一致 0」。
 * ⇒ 与「改词后 hits=0」是同一类洞:证据被移除 ≠ 证据不存在。
 * ⇒ 判据:清单里点名要扫的文件必须都在,缺一个就 fail(而不是悄悄削范围)。
 */
const missingFiles = files.filter((f) => !existsSync(join(ROOT, f)));

/* 自称模式 → 它指向的真值键(定义见上方说明:必须带区分词,否则两个"白名单"会互相误报) */

interface Hit { file: string; line: number; text: string; claim: number; key: string; desc: string }
const hits: Hit[] = [];
/** 被标为「引用历史值」的行:它们**故意**不复述当前值。 */
const quoted: Hit[] = [];
/* ★★ 「引用」与「自称」的区分标记
 *
 * 问题:一段**记录历史订正**的文字必然要写出**旧值**(「原文写 22,实际 14」)。
 * 那是正确的写法,却被本检测器判成"陈旧"。实测已踩:
 * `scripts/verify.ts` 那段订正注释里同时出现 22/13/9 三个旧值。
 *
 * 处置:在这些行加一个**显式标记** `〔引用〕`,检测器跳过并**单独报出**。
 *
 * ⚠️ 这与陷阱 91(「按名字匹配的清理规则,既保护不了该保护的,也放过不了不该删的」)
 *    是同一个风险面:任何"豁免"都可能被滥用成"把真陈旧藏起来"。
 *    ⇒ 两个约束压住它:
 *      1 标记必须**逐行显式**写,不能是文件名/前缀/正则通配
 *      2 被跳过的行**必须在输出里逐条列出**(不静默) ⇒ 人能看到豁免了哪些
 *    ⇒ 判据:豁免机制的设计目标不是"少报",而是"让每一次豁免都可见"。 */
const QUOTE_MARK = '〔引用〕';
for (const f of files) {
  if (!existsSync(join(ROOT, f))) continue;
  const L = readFileSync(join(ROOT, f), 'utf8').split(/\r?\n/);
  L.forEach((ln, i) => {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      for (const m of ln.matchAll(p.re)) {
        const rec: Hit = {
          file: f, line: i + 1, text: ln.trim(), claim: Number(m[1]), key: p.key, desc: p.desc,
        };
        if (ln.includes(QUOTE_MARK)) quoted.push(rec); else hits.push(rec);
      }
    }
  });
}

/* ★★ 审计 P1(2026-11-18):**命中数的具名下限**
 *
 * ## 缺口(实测)
 *
 * 本脚本只认 4 条**固定措辞**正则。把那句话改个词
 * (「白名单 14 条」→「白名单共 14 个」),`hits` 立刻变成 0,
 * 而输出是 `自称总数 0;与正解一致 0;★ 陈旧 0` + **exit 0** ——
 * 与「所有自称都对上了」**逐字相同**。⇒ 检测面被改没了,而它报绿。
 * ⇒ 这正是本仓的形态:判据消失时,输出与"判据通过"不可区分(陷阱 126)。
 *
 * ## 为什么下限是"具名常量"而不是"与上次运行比较"
 *
 * 与上次比较需要一份基线文件,而基线自己也会跟着一起变(自己比自己)。
 * 具名常量迫使**改文档的人**显式来这里把下限改小 ——
 * 那一刻他必须回答「我是不是把一条自称改没了」。
 *
 * ## ★ 2026-11-18 审计 P1-4:下限**不许是 0**
 *
 * 旧口径给「可达性白名单 / orphan」各写了下限 **0** —— 那等于这两类
 * **完全没有保护**(把措辞改掉后命中 0,也不低于 0)。同一轮里那两句话
 * 也确实从被扫文件里消失了(只剩 〔引用〕 标注的历史值),于是检测器
 * 「什么都没报」而读者以为"这两类都对上了"。
 * ⇒ 现口径:每一类都必须**至少还看得见 1 处自称**(下限 = 2026-11-18 实测值,
 *    三处;`scripts/verify.ts` 的 `UNREACHABLE_EXEMPT` 说明段里现在**显式**
 *    写着「可达性白名单 12 条」与 `ORPHAN_KNOWN`(10) 供比对)。
 *    **降低任何一项都必须写明理由**,不许顺手改 —— 因为 0 下限 = 没有判据。
 */
const CLAIM_FLOORS: Record<string, number> = {
  可达性白名单: 1,
  orphan: 1,
  同义反复白名单: 1,
};
const CLAIM_FLOOR_TOTAL = 3;
console.log(`\n══ 1 扫到 ${hits.length} 处「N 条」型自称(合计下限 ${CLAIM_FLOOR_TOTAL},低于即 fail)══`);
let stale = 0;
let match = 0;
for (const h of hits) {
  const truth = TRUTH[h.key];
  const okFlag = truth === undefined ? '?' : (h.claim === truth ? '✓' : '★ 陈旧');
  if (okFlag === '★ 陈旧') stale += 1;
  if (okFlag === '✓') match += 1;
  console.log(`   ${okFlag.padEnd(7)} ${h.file}:${h.line}  自称 ${h.claim} (正解 ${truth ?? '?'})  ${h.desc}`);
  if (okFlag === '★ 陈旧') console.log(`           ${h.text.slice(0, 130)}`);
}

console.log(`\n══ 2 汇总 ══`);
console.log(`   自称总数 ${hits.length};与正解一致 ${match};★ 陈旧 ${stale}`);
console.log(`   另有 ${quoted.length} 处标注了 ${QUOTE_MARK}(引用历史值,故意不复述当前值):`);
for (const q of quoted) {
  console.log(`     · ${q.file}:${q.line}  引用 ${q.claim} (当前 ${TRUTH[q.key] ?? '?'})  ${q.desc}`);
}
console.log(`
   ⚠️ 上面 ${quoted.length} 处**全部跳过比对**,故它们**不受本检测器保护** ——
      若哪天有人借 \`${QUOTE_MARK}\` 掩盖真陈旧,没有任何东西会报出来。
      ⇒ 唯一防线就是这个逐条清单:每次运行都看得见豁免了哪几行。
      ⇒ 判据:豁免机制的目标不是"少报",而是"让每一次豁免都可见"。
`);
/* ══ 3 登记 ↔ 实测 互校 ══
 * 这一节回答的是**上一节回答不了的问题**:「正解本身对不对?」
 * 自称与正解一致,只证明了两处文字同步;正解与**实测**一致,才证明台账在说真话。 */
console.log('\n══ 3 登记 ↔ 实测 互校(orphan 台账)══');
if (ORPHAN_AUDIT === null) {
  console.log('   ★ 解析不到 orphan-audit 的机读行 ⇒ 本道**没有比对**');
} else {
  console.log(`   orphan-audit 实测:orphan ${ORPHAN_AUDIT.measured} 个 / ${ORPHAN_AUDIT.measuredLines} 行`);
  /* 「两边都 0」必须单列 —— 它们既不是「已接线」也不是「测试专用」,是**死代码**。 */
  if (ORPHAN_AUDIT.dead > 0) {
    console.log(`   ★ 两边都 0(生产 0 **且** 测试 0)的条目 ${ORPHAN_AUDIT.dead} 个:`);
    for (const f of ORPHAN_AUDIT.deadFiles) console.log(`       ${f}`);
  } else {
    console.log('   两边都 0(生产 0 且 测试 0)的条目:0 个');
  }
  console.log(`   字面/登记 ${TRUTH['orphan'] ?? '?'} · 运行时 Map ${ORPHAN_AUDIT.registered}`
    + ` · 实测 ${ORPHAN_AUDIT.measured} + 死文件 ${ORPHAN_AUDIT.dead}`
    + ` ⇒ ${CROSS_PROBLEMS.length === 0 ? '✓ 三方一致' : '★ 登记失真'}`);
}
if (CROSS_PROBLEMS.length > 0) {
  console.log(`   ★ 登记失真:${CROSS_PROBLEMS.length} 处`);
  for (const p of CROSS_PROBLEMS) console.log(`       · ${p}`);
  console.log('      ⇒ 台账的条数与实测对不上 ⇒ 台账不能作为「还剩多少欠账」的依据');
}
console.log(`
   ⇒ 本检测器只覆盖**语义唯一**的三类(白名单/本表/ORPHAN_KNOWN)。
     其余「N 条」型自称需要**推断它指向哪个量** —— 按本仓的分水岭
     (判据是否要求推断意图),那类**只出清单,不判红**。
   ⇒ 故本脚本的定位:**辅助清单工具,不是门禁**。
     要门禁化,只能把范围缩到上面三类(那是一份可自动核对的清单)。
`);

/* ══════════════════ 进链所需的**两组断言** ══════════════════
 *
 * ## 为什么必须是**两组**(task-84 任务A,注入验证过)
 *
 * 让本脚本进退出码,只加"陈旧 ⇒ 非零"是**不够的**。反例实测:
 *
 * ```
 * 把 verify.ts 里被计数的 `TAUT_SUSPECT_EXEMPT` **改名**:
 *   ⇒ countEntries() 返回 null ⇒ TRUTH['同义反复白名单'] 不存在
 *   ⇒ 引用它的自称被判 '?'(truth === undefined)
 *   ⇒ '?' 既不 ✓ 也不 ★ ⇒ stale 恒为 0
 *   ⇒ **改个声明名就让它静默恒绿,而且永远绿**
 *   实测(注入验证):改名前后 exit **都是 0**,而 TRUTH 表少了一个键。
 * ```
 * ⇒ 这是**最难发现的一类腐烂**:不报错、不告警、不减分,
 *   而它同时**关掉了**这个检测器唯一的价值(比对)。
 *   ⇒ 故必须同时断言:**每个应有的 TRUTH 键都解析成功**。
 *
 * ## 三组分别是
 * ```
 * #1  stale > 0                    ⇒ 非零 (过时条目必须报错)
 * #2  每个 TRUTH 键解析成功         ⇒ 非零 (否则"拆掉真值来源"即可恒绿)
 * #3  登记 ↔ 实测 互校不通过        ⇒ 非零 (2026-11-18 审计 P1-3:此前**从不互校**)
 * ```
 * 第 3 组与前面两组是**不同性质**:#1/#2 比的是「文字 vs 正解」,
 * #3 比的是「正解 vs 实测」。少了它,正解可以是 10、实测可以是 9,
 * 两行都印出来、都没人红 —— 那就是「自己比自己」。
 * ★ 施加顺序无所谓(两者各自独立置位),但**验证顺序必须**:
 *   先证明"改前是绿的",再证明"改后是红的" ——
 *   否则无法区分"我修好了"与"它本来就会红"。
 *   (已按此顺序注入验证:`_t84ca.ts`)
 *
 * ## 与 `--selftest` 的关系
 * 本节**独立于** `--selftest` 之外:selftest 验的是"检测能力"(_anchor 等),
 * 本节验的是"**输入是否完整**"。二者任一失败都应非零。
 */
let assertFailed = false;
{
  /* #2 先报 —— 它失败时下面的 stale 数字不可信 */
  const unresolved = EXPECTED_TRUTH_KEYS.filter((k) => TRUTH[k] === undefined);
  if (unresolved.length > 0) {
    console.log(`\n   ★ 正解缺失:${unresolved.length} 个应有的 TRUTH 键解析失败`);
    for (const k of unresolved) {
      console.log(`      · ${k} —— 被计数的声明找不到(改名/删除/形态变了?)`);
    }
    console.log('      ⇒ 引用它的自称会被判 \'?\'(既不 ✓ 也不 ★)⇒ **本检测器静默失效**');
    console.log('      ⇒ 不是"没有陈旧",是**没有比对** —— 两者必须可区分');
    assertFailed = true;
  }
  /* ★ #2b(2026-11-18 审计 P1-4):**正解为 0 必须被显式认账** ——
     `countEntries` 现在只在「表体确实是空的」时才返回 0,理论上 0 已是实测;
     但「某键的正解变成 0」= 一张表被清空 / 形态被改写 ⇒ 必须有人回答
     「这是有意的吗」。⚠️ 文案里**不得**出现「正解缺失」——
     否则与 #2 不可区分(WS-FND-90 的注入 B 会跟着误报)。 */
  const zeroUnlisted = EXPECTED_TRUTH_KEYS.filter(
    (k) => TRUTH[k] === 0 && !ZERO_TRUTH_DECLARED.includes(k),
  );
  if (zeroUnlisted.length > 0) {
    console.log(`\n   ★ 正解为 0 未登记:${zeroUnlisted.length} 个`);
    for (const k of zeroUnlisted) {
      console.log(`      · ${k} —— 解析结果是 **0**(表体为空),而它不在 ZERO_TRUTH_DECLARED 里`);
    }
    console.log('      ⇒ 0 与「表真的空了」不可区分 ⇒ 要么恢复条目,要么显式登记并写明理由');
    assertFailed = true;
  }
  /* #3 登记 ↔ 实测 */
  if (CROSS_PROBLEMS.length > 0) {
    console.log(`\n   ★ 登记失真:${CROSS_PROBLEMS.length} 处(见上面「3 登记 ↔ 实测 互校」)`);
    console.log('      ⇒ 台账条数与实测对不上 ⇒ 它不能作为「还剩多少欠账」的依据');
    assertFailed = true;
  }
  /* #1 */
  if (stale > 0) {
    console.log(`\n   ★ 陈旧 ${stale} 处(见上面 ★ 陈旧 行)`);
    console.log('      ⇒ 文档里的数与代码算出的正解不一致,应更新文档或代码');
    assertFailed = true;
  }
  /* ★ #4 命中数下限(2026-11-18 审计 P1)——
     与 #1 相反:上面查「对上了没有」,这条查「**还看得见几只**」。
     少了它:把措辞改掉 ⇒ hits=0 ⇒ 上面所有断言**都成立**(0 条陈旧),
     而检测面已经消失。⚠️ 报错文案**不得**包含「正解缺失」——
     否则与 #2 不可区分,WS-FND-90 的注入 B 也会跟着误报。 */
  const belowFloor: string[] = [];
  for (const [k, floor] of Object.entries(CLAIM_FLOORS)) {
    const got = hits.filter((h) => h.key === k).length;
    if (got < floor) belowFloor.push(`${k}:命中 ${got} < 下限 ${floor}`);
  }
  if (hits.length < CLAIM_FLOOR_TOTAL) {
    belowFloor.push(`合计:命中 ${hits.length} < 下限 ${CLAIM_FLOOR_TOTAL}`);
  }
  if (belowFloor.length > 0) {
    console.log(`\n   ★ 命中数低于下限:${belowFloor.length} 项`);
    for (const b of belowFloor) console.log(`      · ${b}`);
    console.log('      ⇒ 不是"没有陈旧",是**没有比对** —— 措辞改了 / 那一行被删了');
    console.log('      ⇒ 修法:恢复自称写法;若确属有意,改小 `CLAIM_FLOORS` 并写明理由');
    assertFailed = true;
  }
  /* ★ #5 扫描文件缺失(2026-11-18 审计 P1)——
     删掉被扫文件与"那一行没有自称"在输出上完全一样 ⇒ 必须单列。 */
  if (missingFiles.length > 0) {
    console.log(`\n   ★ 扫描文件缺失:${missingFiles.length} 个`);
    for (const f of missingFiles) console.log(`      · ${f} —— 本脚本点名要扫它,它不在了`);
    console.log('      ⇒ 删掉被扫文件 = 让它里面的自称一起消失,而不是"没有自称"');
    assertFailed = true;
  }
}

/* 退出码策略(与 --selftest 的分工):
 *   默认运行 = **报告 + 六组断言**(陈旧 / 真值缺失 / 正解为 0 未登记 / 登记失真 /
 *   命中数低于下限 / 扫描文件缺失)。
 *   默认运行因此**可进链**:它不是"打印 N 处陈旧",而是任何一种"没比对成"都非零。
 *   ⚠️ 定位变化必须写下来 —— 本文件原来的 docblock 说"不是门禁",
 *      那是**加断言之前**的事实;加完之后那句就不再成立(陷阱 125:说明会过期)。
 *   ⚠️ 「没比对成」(#2/#2b/#4/#5)必须与「比对了且都对上」**在退出码上分开** ——
 *      否则删掉一句话、改一个词、删一个被扫文件、把一张表清空,
 *      都能让本检测器静默变成恒绿。 */
if (assertFailed) process.exitCode = 1;

/* ─────── selftest ───────
 *
 * ★ 第一版 selftest 是错的:「把正解对齐到自称后,报 3 处(应为 0)」。
 *   原因:它的做法是 `for (const h of hits) aligned[h.key] = h.claim` ——
 *   当**同一个 key 有多个自称且互不相同**时,后面的覆盖前面的,
 *   于是仍留 3 处不一致。而那不是检测器坏,是**这个"对齐"操作本身无意义**:
 *   多个互不相同的自称**不可能同时等于同一个正解** ⇒ 必然有陈旧。
 *
 * ⇒ 这本身就是一条判据:**当一列自称互相矛盾时,"全部对齐"是个不可能达成的目标。**
 *   它的存在恰好证明至少有一处陈旧(鸽笼原理)。
 *
 * 正确的 selftest 应当逐类构造:
 *   a 把某条自称改成与正解一致 ⇒ 该条不再报陈旧(证明它**读的是正解**,不是常数)
 *   b 把正解整体改掉          ⇒ 该类别下**所有**自称都报陈旧(证明它**真的在比**)
 */
if (process.argv.includes('--selftest')) {
  console.log('\n══ selftest ══');

  /* a 正向:把正解改掉 ⇒ 该 key 下所有自称都应报陈旧 */
  console.log('   [a] 把每个 key 的正解 +1 ⇒ 该类下所有自称都应报陈旧');
  let allCaught = true;
  for (const key of Object.keys(TRUTH)) {
    const shifted = { ...TRUTH, [key]: TRUTH[key]! + 1 };
    const hit = hits.filter((h) => h.key === key);
    const caught = hit.filter((h) => h.claim !== shifted[h.key]).length;
    const okA = hit.length > 0 ? caught === hit.length : true;
    if (!okA) allCaught = false;
    console.log(`       ${key.padEnd(14)} 自称 ${hit.length} 处,报陈旧 ${caught} 处`
      + ` ⇒ ${okA ? '✓' : '★ 漏报'}`);
  }

  /* b 反向:把正解对齐到"该 key 下唯一的值"(仅当该 key 下自称一致时才有意义) */
  console.log('   [b] 对"该 key 下自称完全一致"的类,对齐后应报 0');
  let consistentOk = true;
  for (const key of Object.keys(TRUTH)) {
    const vals = [...new Set(hits.filter((h) => h.key === key).map((h) => h.claim))];
    if (vals.length !== 1) {
      console.log(`       ${key.padEnd(14)} 自称有 ${vals.length} 个不同值(${vals.join('/')})`
        + ' ⇒ 对齐不可达,跳过(见上方注释:互相矛盾时必然至少一处陈旧)');
      continue;
    }
    const aligned = { ...TRUTH, [key]: vals[0]! };
    const hit = hits.filter((h) => h.key === key);
    const caught = hit.filter((h) => h.claim !== aligned[h.key]).length;
    if (caught !== 0) consistentOk = false;
    console.log(`       ${key.padEnd(14)} 对齐到 ${vals[0]} ⇒ 报陈旧 ${caught} 处`
      + ` ⇒ ${caught === 0 ? '✓' : '★ 坏'}`);
  }

  console.log(`   ⇒ [a] ${allCaught ? '✓' : '★'} [b] ${consistentOk ? '✓' : '★'}`);
  console.log('   ⇒ 判据:检测器必须能"被正解的变化驱动" ——');
  console.log('      [a] 证明它不是恒报同一个数,[b] 证明它真在读正解。');

  /* ★ task-77:退出码 —— 本文件**第一版漏了它**。
   *
   * 事实:第一版的 `--selftest` 跑完永远 `exit 0`,即使 [a]/[b] 报 ★。
   * ⇒ 于是这个 selftest **接进任何流水线都不会红** ——
   *   与陷阱 79「恒报 0 的工具比没有工具更危险」、陷阱 82「不拦门禁的自检脚本,
   *   它的红没有代价」**同形**。而我是在写完那两条之后一小时造的它。
   * ⇒ 是 `scripts/selftest-exit-audit.ts` 普查时把我自己抓出来的。
   *
   * 修法:selftest 的失败**必须驱动退出码**。
   * ⚠️ 但**只在 --selftest 时**驱动 —— 本脚本的默认运行是**报告**(出清单),
   *    它报"有 N 处陈旧"是**正常输出**,不是失败(定位是清单工具,不是门禁)。
   *    若默认也非零,它就成了一块永远红的门禁,而"永远红"与"永远绿"同样无用。
   * ⇒ 判据:**一个脚本该不该非零退出,取决于它的定位,而不是它发现了什么。** */
  if (!allCaught || !consistentOk) {
    console.log('\n   ★ selftest 未通过 ⇒ 本脚本的检测能力不可信,置非零退出码');
    process.exitCode = 1;
  }
}
