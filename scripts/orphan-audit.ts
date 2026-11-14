/**
 * 「实现存在但生产跑不到」扫描器 —— 永久门禁。
 *
 * 用法:
 *   node scripts/orphan-audit.ts              # 报告(不失败)
 *   node scripts/orphan-audit.ts --strict     # 有 L2 未登记项时失败
 *   node scripts/orphan-audit.ts --baseline   # 重新生成已登记清单
 *
 * ## 为什么需要它
 *
 * 本项目**第 5 次**踩同一个坑,每次都是事后偶然发现:
 *   1. 流体相变产物 `pendingObj` 只进不出 —— 实现完整,编排层不收
 *   2. `components.ts` 40 项电路件 —— 单测全绿,生产闭包里没有它
 *   3. 炼金 6 模块 —— 3626 行零引用
 *   4. 八步伤害公式 505 行 —— `computeDamage` 生产调用点 = 0
 *      (**2026-11-12 已接线,此条保留作历史**;`WorldSim.attackMob` 现在真的调它,
 *       八步在生产 API 上逐步跑通 —— WS-10 从 44 涨到 60 块就是这条的证据。
 *       ⚠️ 但注意 `attackMob` 自身**仍只有 tests 调用者**:它所在的 `sim/` 层
 *       只经 `demo.ts` 可达,而 `RoomRuntime` 至今不认识模拟层(见 `backlog.ts` US2)。
 *       ⇒ 「接线了」与「端到端闭合」是两件事,别用前者冒充后者。)
 *   5. 客户端 8 模块约 2500 行 —— 有单测,浏览器从不加载
 *
 * 每一次的症状都一样:**实现存在 + 测试全绿 + 生产不跑到**。
 * 前四个门禁(`checkReachability` 等)都看不见,因为它们查的是
 * **文件级 import 图**,而这类缺陷的文件往往被 import 了、
 * 只是里面的东西没人用。
 *
 * ## 判据(只查最危险的一类,避免噪音)
 *
 * **L2 测试专用**:模块有 `export`,但除自身外**只有 `tests/**` 引用**,
 * `server/src` 与 `client/src` 内零引用。
 * ⇒ 实现存在、测试绿、生产永不执行。
 *
 * 不查「导出符号零调用」那一档 —— 假阳性太多(工具函数、未来 API),
 * 会让门禁退化成噪音然后被忽略。**一条会误报的门禁等于没有门禁。**
 *
 * ## 已登记清单
 *
 * `ORPHAN_KNOWN` 里每条都必须写明**为什么不接**与**接入条件**。
 * 自检:
 * - 登记项若已变可达(生产里出现了引用) ⇒ 报「应移出」;
 * - 登记项若文件不存在 ⇒ 报「失真」;
 * - 未登记的新 orphan ⇒ 报「新增」。`--strict` 下升级为失败。
 *
 * 这套自检与 `verify.ts` 的 `UNREACHABLE_EXEMPT` 同一思路 ——
 * 白名单必须自己会失效,否则它会因事实变化而静默放宽。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const STRICT = process.argv.includes('--strict');
const REBASE = process.argv.includes('--baseline');

/**
 * 已登记的生产零引用模块。
 *
 * 每条:`[相对路径, 为什么不接 / 接入条件]`。
 * 理由必须 ≥8 字符且说清**卡在哪**,否则自检报「未写明理由」。
 */
export const ORPHAN_KNOWN = new Map<string, string>([
  /* ── 已接线的组(entries 保留在此仅作历史记录,不再列于表中)──
   *
   * 2026-11-12 两批接线,本表从 25 条收缩到 14 条:
   *   · WS-06 炼金 7 条 → `WorldSim.forgeAlchemy()`
   *   · WS-05 Boss 3 条 → `WorldSim` 慢帧 `bossRaid.tickBosses()`
   *   · WS-08 物流 1 条 → `WorldSim` 慢帧 `tickLogisticsStep()`
   *   · 客户端 8 条 → `three/ui_binding.ts` + `ui/panel_layout.ts`
   * 每次接通,本表的自检都报一次「已可达,应移出」——
   * **本表自检至今抓出过我 8 次误登记。** 若没有那道自检,
   * 白名单会越积越宽而门禁全程绿色。
   */
  /* ── 服务端:等编排层接线 ── */
  /* ⚠ `wiring/components.ts` **不在此表** —— 它被 `world_sim.ts:84` 以
     **裸 import**(`import '../wiring/components.ts';`)引用,因此**可达**。
     我的初版扫描器用正则找 `from '…'`,漏掉裸 import,把它误报成 orphan。
     详见 `extractRelativeImports` 的注释与「词法自检」一节。 */
  /* ── 2026-11-14 task-84(WS-11 缺口 A:对局运行时)接线 2 条 ⇒ 摘除 ──
   *
   * 接线方式 = `WorldSim` 慢帧 `tickPartyStep()`(2Hz,`dt = SIM_SLOW_DT`),
   * 由 `world_sim.ts` 的 `tick()` 在 `isSlow` 块内调用(刻意放在
   * `if (this.wiringOn)` **之外** —— 否则 `wiring:false` 的房间会静默冻结对局)。
   *
   * ★ **本次只摘 2 条,不是 4 条 —— 这个数是算出来的,不是数出来的:**
   *   `coop/rush_order.ts` 与 `party/scoring.ts` **从来不在本表**。
   *   它们有非零引用(modes/scoring/afk 的仅类型或内部导入),
   *   按本表的「零引用」口径从来不成立。
   *   只有 modes / afk 原为 **0 引用**,被 `world_sim` **直接 import** 后
   *   引用者 0 → 1,才从 orphan 转可达。
   *   ⇒ 「可达性白名单摘 4 条 + 本表摘 2 条」**不矛盾**,是两个不同的集合。
   *   ⚠️ 若照「摘几条减几条」去改本表,会多减 2 条;而报错形态是
   *      `verify.ts` 的 `orphan ⊆ 可达性白名单` 不变量 ——
   *      **它看起来像可达性算错了,不像本表改错了**。
   *
   * ⚠️ 本表**不变量**:orphan ⊆ 可达性白名单(`verify.ts` 的那条自检)。
   *   摘可达性白名单时**必须同步摘本表**,否则报「两套判据矛盾」。
   *   本次实测正是如此:`orphan-audit` 报 modes/afk「已可达,应移出」,
   *   而白名单已摘 ⇒ 两套判据互相矛盾。
   *   ⇒ 故理由必须写到「**谁接的、接在哪**」。旧文案是
   *     「待编排层按房间模式分发」/「待房间 tick 调用」—— 这类**目录级、
   *     笼统的理由在事实变化后会继续豁免**,不会自己失效;
   *     与 `UNREACHABLE_EXEMPT` 的「理由过时」是同一个病。
   */
  ['server/src/prank/immunity.ts', 'WS-11 整蛊免疫;待接 applyPrank'],
  ['server/src/build/wiring_view.ts', 'WS-08 电路可视视图;待客户端接线'],
  ['server/src/mobs/taming.ts', 'WS-04 驯服;待交互系统调用'],
  ['client/src/net/prediction.ts', 'WS-07 客户端预测(客户端模块);等客户端网络层 —— 服务端侧不该接'],
  ['server/src/db/memory_db.ts', 'WS-07 内存库;生产走 sqlite 驱动,仅测试用'],
  ['server/src/content/handshake.ts', '内容握手;待房间 join 时校验'],
  ['server/src/content/baseline.ts', '内容基线锁;仅门禁与测试使用'],
  /* ── 客户端:8 个模块已于 2026-11-12 **全部接线**,整块摘除 ──
   *
   * 曾经这里有 7 条(audio / boss_hud / inventory / pixel_easel / recipe_tree /
   * state_machine / blueprint / roof_transparency)。**本表自检把它们逐条抓了出来**
   * —— 每接通一个,它就报一次「已可达,应移出」。
   * 现有装配:`three/ui_binding.ts`(Canvas2D 覆盖层)+ `three/audio_out.ts`
   * (WebAudio)+ `ui/panel_layout.ts`(布局纯逻辑),由 UI 状态机驱动。
   * 客户端不再有「生产零引用」模块。
   *
   * **留作教训**:这张表自检抓出过我 **5 次**误登记(把已可达的写进来)。
   * 若没有那道自检,白名单会越积越宽而门禁全程绿色 ——
   * 与 `UNREACHABLE_EXEMPT` 的「理由过时」是同一个病。 */
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(p, out);
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/* ⚠️⚠️ `shared` 必须在列 —— 与 `verify.ts` 的 `prodDirs` **同一口径**。
 *
 * 2026-11-13 实测(带双向对照):
 *   零引用文件放 `shared/types/`  ⇒ 本行数字 Δ0(空洞)
 *   零引用文件放 `server/src/net/` ⇒ 数字 Δ1(正确报警)
 * ⇒ 两处必须同时改:若只改一处,两个门禁会给出**互相矛盾**的基数,
 *   而「orphan ⊆ 可达性白名单」那条交叉自检建立在两者口径一致的前提上。
 */
const PROD_DIRS = ['server/src', 'client/src', 'shared'];
const prodFiles = PROD_DIRS.flatMap((d) => walk(join(ROOT, d)));
const testFiles = walk(join(ROOT, 'tests'));

const relOf = (p: string): string => relative(ROOT, p).split(sep).join('/');
const text = new Map<string, string>();
for (const f of [...prodFiles, ...testFiles]) text.set(relOf(f), readFileSync(f, 'utf8'));

/**
 * 提取**代码态**下的相对导入路径。
 *
 * ## ⚠ 这里曾经是个真 bug(务必读)
 *
 * 初版用的是 `/(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g` 这个正则。
 * 它漏掉**裸 import**(side-effect import):
 *
 * ```ts
 * import '../wiring/components.ts';   // ← 无 from,正则抓不到
 * ```
 *
 * 后果:`world_sim.ts:72` 正是这么引 `components.ts` 的,**真的可达**,
 * 但脚本报它「生产零引用」⇒ **我的门禁误报**。
 *
 * 反证过程:`verify.ts` 的 `extractRelativeImports`(逐字符扫描)能正确解析
 * 出它,且 `components.ts` **不在** verify 的白名单里 ⇒ verify 认为它可达。
 * 两者对同一文件给出相反结论 ⇒ **我的脚本错了**,不是 verify 错。
 *
 * **教训**:判定「谁引用谁」必须用**同一套词法**,否则两个门禁会互相矛盾,
 * 而矛盾时无法判断该信哪个。故此处改为与 `verify.ts` 同构的逐字符扫描,
 * 并显式覆盖裸 import。
 */
function extractRelativeImports(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  const isId = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    /* 注释:整段跳过 */
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    /* 字符串:整段跳过 —— 否则字符串里的 `from './x.ts'` 会变成幽灵依赖 */
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) { i += 1; break; } i += 1; }
      continue;
    }
    if (isId(c) && !isId(text[i - 1])) {
      let j = i;
      while (j < n && isId(text[j])) j += 1;
      const word = text.slice(i, j);
      /* `import` 覆盖三种形态:`import x from '…'`(由后续 `from` 接)、
         `import '…'`(**裸 import**)、`import('…')`(动态) */
      if (word === 'import' || word === 'from') {
        let k = j;
        while (k < n && /\s/.test(text[k] as string)) k += 1;
        /* 裸/动态 import 形态:`import(` 或 `import '` 紧邻 */
        if (word === 'import' && text[k] === '(') {
          k += 1;
          while (k < n && /\s/.test(text[k] as string)) k += 1;
        }
        const q = text[k];
        if (q === "'" || q === '"') {
          let e = k + 1;
          let spec = '';
          while (e < n) {
            if (text[e] === '\\') { spec += text[e + 1]; e += 2; continue; }
            if (text[e] === q) break;
            spec += text[e]; e += 1;
          }
          if (spec.startsWith('.')) out.push(spec);
          i = e + 1;
          continue;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 解出相对说明符后反解成绝对路径再比 —— 避免 `./x.ts` / `./x` 写法漏判。 */
function referencedBy(target: string, froms: string[], self: string): string[] {
  const tAbs = resolve(ROOT, target);
  const hits: string[] = [];
  for (const f of froms) {
    const r = relOf(f);
    if (r === self) continue;
    const src = text.get(r) ?? '';
    const dir = dirname(resolve(ROOT, r));
    for (const spec of extractRelativeImports(src)) {
      let cand = resolve(dir, spec);
      if (!existsSync(cand)) {
        for (const ext of ['.ts', '/index.ts']) if (existsSync(cand + ext)) { cand += ext; break; }
      }
      if (cand === tAbs) { hits.push(r); break; }
    }
  }
  return hits;
}

/* ── 词法自检:导入扫描必须覆盖全部形态 ──
 *
 * 这一节是**为上面那个真 bug 立的碑**。初版正则漏掉裸 import,导致
 * `components.ts`(被 `world_sim.ts:72` 裸引)被误报为「生产零引用」。
 * 若不立此自检,同类漏判会再次静默发生 —— 而误报方向是**掩盖**:
 * 它让人以为某个模块没接线,于是不必去查,欠账被高估而非暴露。
 *
 * 每条断言:样本源码 → 必须解析出的说明符。任一不满足即 fail。 */
{
  const cases: [string, string, string[]][] = [
    ['具名 import', "import { X } from './a.ts';", ['./a.ts']],
    ['默认 import', "import X from './b.ts';", ['./b.ts']],
    ['类型 import', "import type { T } from './c.ts';", ['./c.ts']],
    ['裸 import(side-effect)', "import './d.ts';", ['./d.ts']],
    ['裸 import 相对上级', "import '../wiring/e.ts';", ['../wiring/e.ts']],
    ['动态 import', "import('./f.ts');", ['./f.ts']],
    ['再导出', "export * from './g.ts';", ['./g.ts']],
    ['具名再导出', "export { Y } from './h.ts';", ['./h.ts']],
    ['双引号', 'import { Z } from "./i.ts";', ['./i.ts']],
    ['注释里的 import 不算', "// import { A } from './ghost.ts'\nconst x = 1;", []],
    ['块注释里的 import 不算', "/* import './ghost.ts' */\nconst x = 1;", []],
    ['字符串里的 from 不算', 'const s = "from \'./ghost.ts\'";', []],
    ['模板串里的 import 不算', 'const t = `import x from "./ghost.ts"`;', []],
    ['多个 import', "import a from './j.ts';\nimport './k.ts';", ['./j.ts', './k.ts']],
    ['第三方包不算', "import { p } from 'three';", []],
    ['node 内置不算', "import { f } from 'node:fs';", []],
  ];
  const bad: string[] = [];
  for (const [name, src, want] of cases) {
    const got = extractRelativeImports(src).slice().sort();
    const exp = want.slice().sort();
    if (got.join(',') !== exp.join(',')) {
      bad.push(`${name}:期望 [${exp.join(', ')}] 实际 [${got.join(', ')}]`);
    }
  }
  /* 阳性对照:必须真的存在一条裸 import,否则上面那组是**装饰**(恒真)。
     `world_sim.ts` 引 `components.ts` 用的就是裸 import。 */
  const wsSrc = readFileSync(join(ROOT, 'server/src/sim/world_sim.ts'), 'utf8');
  const hasBare = /import\s+['"]\.\.\/wiring\/components\.ts['"]/.test(wsSrc);
  const parsedIt = extractRelativeImports(wsSrc).some((s) => s.includes('components'));
  if (!hasBare) bad.push('阳性对照失效:world_sim.ts 里已没有裸 import components.ts(本自检需换锚点)');
  else if (!parsedIt) bad.push('阳性对照失效:扫描器仍看不见 world_sim.ts 的裸 import components.ts');

  if (bad.length > 0) {
    console.log(`\n  ✗ 导入扫描器词法自检未通过(${bad.length} 处):`);
    for (const b of bad) console.log(`      ${b}`);
    console.log('  ⇒ 判定「谁引用谁」出错,本审计的全部数字都不可信');
    process.exit(1);
  }
  console.log(`  ✓ 导入扫描器词法自检通过(${cases.length} 形态 + 1 阳性对照)`);
}

/* ── 找出所有 L2 orphan ── */
const found: { file: string; tests: string[]; lines: number }[] = [];
for (const f of prodFiles) {
  const r = relOf(f);
  const src = text.get(r) ?? '';
  if (!/^export /m.test(src)) continue;
  if (referencedBy(f, prodFiles, r).length > 0) continue;
  const byTest = referencedBy(f, testFiles, r);
  if (byTest.length === 0) continue;
  found.push({ file: r, tests: byTest.map((t) => t.replace(/^tests\//, '')), lines: src.split('\n').length });
}
found.sort((a, b) => b.lines - a.lines);

if (REBASE) {
  console.log('已登记的 orphan 清单(复制进 ORPHAN_KNOWN):');
  for (const x of found) console.log(`  ['${x.file}', 'TODO: 写明为什么不接'],`);
  process.exit(0);
}

/* ── 自检 ── */
const stale: string[] = [];
for (const [rel, reason] of ORPHAN_KNOWN) {
  if (!existsSync(join(ROOT, rel))) { stale.push(`${rel}(文件不存在)`); continue; }
  if (!reason || reason.trim().length < 8) { stale.push(`${rel}(未写明理由)`); continue; }
  const abs = join(ROOT, rel);
  if (referencedBy(abs, prodFiles, rel).length > 0) stale.push(`${rel}(已可达,应移出)`);
}

const unlisted = found.filter((x) => !ORPHAN_KNOWN.has(x.file));
const totalLines = found.reduce((s, x) => s + x.lines, 0);

console.log('\n══ 生产零引用审计(测试专用模块)══\n');
console.log(`  生产文件 ${prodFiles.length} / 测试文件 ${testFiles.length}`);
console.log(`  实测 orphan:${found.length} 个 / ${totalLines} 行`);
console.log(`  已登记:${ORPHAN_KNOWN.size} 条\n`);

if (found.length > 0) {
  console.log('  模块                                                 行数  测试');
  for (const x of found) {
    const mark = ORPHAN_KNOWN.has(x.file) ? ' ' : '!';
    console.log(`  ${mark} ${x.file.padEnd(50)} ${String(x.lines).padStart(4)}  ${x.tests.join(',')}`);
  }
  console.log('\n  (! = 未登记)');
}

let failed = false;
if (stale.length > 0) {
  console.log(`\n  ✗ 登记清单失真(${stale.length} 处,应修正):`);
  for (const s of stale) console.log(`      ${s}`);
  failed = true;
}
if (unlisted.length > 0) {
  const msg = `新增未登记的生产零引用模块 ${unlisted.length} 个:${unlisted.map((x) => x.file).join(', ')}`;
  if (STRICT) { console.log(`\n  ✗ ${msg}`); failed = true; }
  else console.log(`\n  ⚠ ${msg}\n    (补白名单理由,或接线;--strict 下升级为失败)`);
}

if (!failed) {
  console.log(`\n  ✓ 生产零引用审计通过(${found.length} 个已登记 / 0 处失真)`);
}
console.log('');
process.exit(failed ? 1 : 0);