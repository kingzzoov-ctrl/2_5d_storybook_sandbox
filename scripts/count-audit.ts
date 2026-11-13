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
  return mapEntries > 0 ? mapEntries : setEntries;
}

const TRUTH: Record<string, number> = {};
{
  const wl = countEntries(join(ROOT, 'scripts/verify.ts'), 'UNREACHABLE_EXEMPT');
  const orphan = countEntries(join(ROOT, 'scripts/orphan-audit.ts'), 'ORPHAN_KNOWN');
  const taut = countEntries(join(ROOT, 'scripts/verify.ts'), 'TAUT_SUSPECT_EXEMPT');
  if (wl !== null) TRUTH['可达性白名单'] = wl;
  if (orphan !== null) TRUTH['orphan'] = orphan;
  if (taut !== null) TRUTH['同义反复白名单'] = taut;
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

console.log(`\n══ 1 扫到 ${hits.length} 处「N 条」型自称 ══`);
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
console.log(`
   ⇒ 本检测器只覆盖**语义唯一**的三类(白名单/本表/ORPHAN_KNOWN)。
     其余「N 条」型自称需要**推断它指向哪个量** —— 按本仓的分水岭
     (判据是否要求推断意图),那类**只出清单,不判红**。
   ⇒ 故本脚本的定位:**辅助清单工具,不是门禁**。
     要门禁化,只能把范围缩到上面三类(那是一份可自动核对的清单)。
`);

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
