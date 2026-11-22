/**
 * 门禁自检 —— 用**变异测试**证明 `scripts/verify.ts` 的检查真的有牙齿。
 *
 * ## 为什么需要它
 *
 * 本项目反复出现「门禁看起来在管、实际管不住」:
 * 恒绿门禁、查错位置、影子行绕过、恒真断言、只报数量不查性质。
 * 共同点是:**门禁全绿不是证据**。判断一条检查有没有牙齿,唯一可靠的办法是
 * **注入它本该拦住的反例,看它红不红** —— 这就是本脚本做的事。
 *
 * ## 设计
 *
 * 1. **绝不碰真仓库**:把整棵树复制到 `%TEMP%`( `ROOT` 由 `import.meta.url`
 *    推导,故副本里跑的就是副本),在副本内变异,跑完删副本。
 * 2. 每条用例声明:目标文件、锚点、替换文本、期望(红/绿)。
 *    跑之前先**读回文件自证内容已变** —— 探针失效时报「探针无效」而不是
 *    「门禁失职」。这个区分很关键:第 13 批审计里我差点因探针的空操作
 *    而误判门禁(见 GATE-AUDIT-13 §六 E3)。
 * 3. **基线对照**:干净副本必须先绿。若基线就红,一切结论作废。
 * 4. 退出码非 0 表示「有检查没牙齿」或「探针失效」。
 *
 *
 * 用法:
 *   node scripts/gate-selfcheck.ts              # 全部用例(默认 `min(8, CPU−1)` 路并发)
 *   node scripts/gate-selfcheck.ts --only D1    # 只跑某组
 *   node scripts/gate-selfcheck.ts --jobs 4     # 指定并发路数(上限 16)
 *
 * 期望耗时:单组约 0.2~6s(多数只跑 `--frozen`);D3/D4 必须跑 `runTests` 故较慢
 * (D3 18s / D4 6s,口径已收窄,见各自用例上的注释)。
 * ⚠️ 30 个用例**并发**跑:每条用例独占一份整树副本(`makeLab`),彼此无共享可写状态。
 *    串行版本实测 163s,且默认口径改成「自检真跑」之后会因副本里递归 spawn 门禁自检
 *    而突破外层超时(表现为 `门禁自检失败(exit=null)`)。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, relative, sep, dirname, resolve } from 'node:path';
/* ★ 2026-11-14(接手者):跳过规则走唯一事实源(`scripts/scan-scope.ts`)。
   ⚠️ 这与本文件「独立复算」的原则**不冲突**:独立性要求的是**算法**独立
      (自己走 import 图、不借 verify.ts 的函数),而不是「目录黑名单各写一份」——
      后者不是独立复算,是**同一份事实的第七份副本**,而且它实测已经缺了 `_probe_sandbox`。 */
import { shouldSkipDirAtDepth } from './scan-scope.ts';

/**
 * ★ **本文件自带**的相对导入提取 —— 有意**不**从 `verify.ts` import。
 *
 * 理由与本文件既有的那条一致(见「窄词在此重复一份而非 import —— 本文件的职责是
 * **独立复算**;若 import verify.ts 的正则,正则写错时两边一起错,自检就失去意义」)。
 *
 * ⚠️ 2026-11-14 实测过这条原则**不是空话**:`verify.ts` 与 `deadcode-audit.ts`
 * 各有一份「提取相对导入」的实现,而 `deadcode-audit.ts:172` 那份**只认 `from`** ⇒
 * 它把可达模块报成「真缺陷」。两份都在用、有一份对、门禁全绿。
 * ⇒ 所以这里自带一份,并与它比对 —— 若两者结果不同,那是**发现**而不是噪声。
 */
function extractRelImports(src: string): string[] {
  const out: string[] = [];
  /* 静态 `from '...'` —— 含 `export ... from` 与 `import type ... from`(都是同一条边) */
  for (const m of src.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) out.push(m[1]!);
  /* 裸副作用导入 `import '...'` */
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)) out.push(m[1]!);
  /* **字面量**动态导入:`import('./x.ts')` / `await import('./x.ts')` / 无插值模板串。
   * ⚠️ 与 `scripts/imports.ts` 的真值表**同一口径**:非字面量 `import(expr)` 不跟踪
   *    (静态不可解析,已作为接受边界登记在 `verify.ts` 的 `checkDynamicImportBoundary()`)。
   * ⚠️ 2026-11-18:此前这条只认 `await import('...')`(单引号),而真正的口径来源
   *    (`scripts/imports.ts`)三种形态都认 ⇒ 两份实现会在「`import('./x.ts').then()`」
   *    这类写法上分叉。分叉的表现是**差集条数不等**,而不是报错。 */
  for (const m of src.matchAll(/(?<![\w.])import\s*\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g)) out.push(m[1]!);
  return out;
}
import { cpus, tmpdir } from 'node:os';
const ROOT = process.cwd();

/** 变异用例。 */
interface Case {
  /** 组号,用于 `--only` */
  group: string;
  name: string;
  file: string;
  /**
   * 必须唯一命中的原文。
   *
   * **允许写成函数**:函数收到抽样时的 `verify.ts` 全文,返回锚点。
   * 这是为了防一类**反复发生**的假失败:锚点写死在某条白名单理由上,
   * 而白名单会随接线**单调收缩**(43→35→27→23→…),那条理由一旦被摘,
   * 探针就报「锚点命中 0 次」。
   *
   * 本项目已因此**修过两次**(客户端 8 条接线、WS-05 三条接线)。
   * 与其每次手改锚点,不如让它**从活的清单里自己取**。
   */
  from: string | ((src: string) => string);
  /** 替换为 */
  to: string;
  /**
   * 对「变红与否」的期望。
   *
   * `'any'` = 不约束红绿,只用 `wantMsg` / `notMsg` 精确断言某条消息。
   * 这是 N1 这类用例必须的:它测的是「某条假红是否已消失」,
   * 而不是「整体是否绿」—— 后者取决于**队友在飞的活**,不是我能保证的。
   */
  expect: 'red' | 'green' | 'any';
  /** verify 的参数 */
  args?: string[];
  /** 期望在输出里出现的子串(可选,用于确认是**对的**那条检查红的) */
  wantMsg?: RegExp;
  /**
   * 期望**不**出现的子串。
   *
   * 用于「某条假红已修好」这类断言:`expect: 'green'` 要求整个 verify 退出 0,
   * 但清理干净时队友可能正有在飞的红项(本项目多人并行),
   * 于是「整体绿」不是我能单方面保证的。
   * 此时改用 `notMsg` 精确断言**那一条**消息已消失 —— 这才是本用例要测的东西。
   */
  notMsg?: RegExp;
  /**
   * 运行时自取锚点的标记。
   *
   * `from` / `to` 留空时,由 `resolveAnchors()` 按此标记从**活文件**里取值。
   * 为什么必须自取:本仓的清单(白名单 / orphan 表)会随接线**单调收缩**,
   * 写死锚点必然过期 —— 而过期后的表现是「锚点命中 0 次」,
   * 看起来像「门禁没问题」,实际是**用例根本没测到**。
   * 这个坑本轮已踩过两次(T32 的理由锚点 + Lead 注入时用错缩进)。
   */
  mark?: string;
  /**
   * 用例自带的**副本改造**(可选,在变异之前对该用例的整树副本执行一次)。
   *
   * 目前只有 D3 用:`它必须跑默认口径(全量 `runTests`),而默认口径会再 spawn
   * 一次门禁自检 ⇒ 副本里递归复制整棵树`。理由与实测证据见 D3 用例上的注释。
   */
  labSetup?: (labRoot: string) => void;
}

/**
 * 从 `verify.ts` 的 `UNREACHABLE_EXEMPT` 里挑一条**仍在册的**服务端理由,
 * 返回可直接用于 `String.replace` 的引号形式(含两侧单引号)。
 *
 * **为什么需要它**:T32 那两条「理由过时」探针原先写死锚点
 * (`'WS-05 Boss 破防,待接入 tickMobs'`)。而白名单会随接线**单调收缩**
 * —— WS-05 三条一通,那句理由就被摘了,探针随即报「锚点命中 0 次」。
 *
 * 这是**同一类假失败在本轮第二次发生**(第一次是客户端 8 条接线后)。
 * 与其每次手改,不如让锚点从活清单里自取。
 *
 * 选服务端条目而非客户端:客户端条目已全部摘除(接线 + orphan 审计双重确认)。
 * 若未来连服务端清单也空了,本函数返回空串 —— 调用处会报「探针失效」,
 * 那时应删掉这两条用例(它们要测的对象已不存在)。
 */
function pickServerReason(src: string): string {
  const a = src.indexOf('const UNREACHABLE_EXEMPT = new Map<string, string>([');
  if (a < 0) return '';
  const b = src.indexOf(']);', a);
  if (b < 0) return '';
  const block = src.slice(a, b);
  /* 逐行找 `['server/...', '理由'],` —— 理由里不许含单引号(有则跳过,避免替换歧义) */
  /* ⚠️ 本正则要求「路径与理由**同行**且同行 `]` 闭合」——
     这是**刻意**的:本函数要拿理由文本去构造 `String.replace`,
     而多行条目(理由用 `+` 拼接)无法用单行锚点替换。
     故多行条目被**显式跳过**:宁可换一条,也不误选后替换失败。
     (计数用的是另一套更宽的正则 —— 两者目的不同,不该共用。) */
  for (const m of block.matchAll(/^\s*\['(server\/[^']+)',\s*'([^']+)'\]/gm)) {
    const reason = m[2] as string;
    if (reason.includes("'")) continue;
    return `'${reason}'`;
  }
  return '';
}

/**
 * ★★ 换行无关的锚点匹配 —— 修一个「锚点写对了却报 0 命中」的假失败。
 *
 * ## 症状
 *
 * T37 第 2 条用例(`把**已修好的** attack 重新塞回登记`)长期报
 * 「探针无效:锚点命中 0 次」,而它注入的是 `scripts/verify.ts`。
 * 但**锚点文本确实在文件里** —— 这是最误导的部分:报错说"找不到"。
 *
 * ## 根因(实测)
 *
 * ```
 * scripts/verify.ts              CRLF=6120  bareLF=0    ← 磁盘上是 CRLF
 * scripts/gate-selfcheck.ts      CRLF=0     bareLF=1130 ← 本文件是 LF
 * git config core.autocrlf = true          ← 这就是两者不同的原因
 * ```
 * 用例里 anchor 写作字面量 `'...([\n'`(源码里的 `\n` = 一个 LF 字符),
 * 而目标文件里那一行**结尾是 `\r\n`** ⇒ `split(anchor)` 恒为 0。
 *
 * 实测对照:
 * ```
 * anchor 带 bare LF  ⇒ 命中 0
 * anchor 带 CRLF     ⇒ 命中 1
 * ⇒ 是**换行不一致**,不是锚点不存在。
 * ```
 *
 * ## 为什么这个 bug 特别值得记
 *
 * 它把一个**"环境不一致"**伪装成了**"锚点过期"**,而本文件为"锚点过期"
 * 专门写了大量注释与自取锚点机制(见 `from` 的接口注释)。
 * ⇒ 于是**诊断系统把注意力引向了错误的方向**:我按"锚点又过期了"的思路
 *   查了半天,真相是 `core.autocrlf=true` 与 LF 字面量的交互。
 * ⇒ 与陷阱 132(冻结基线把崩溃冻成预期状态)同族:
 *   **错误的诊断标签会让修的人修错地方。**
 *
 * ## 修法
 *
 * 先按**原样**匹配(精确优先,不改既有语义);
 * 0 命中时,把两侧的 `\r\n` 都归一成 `\n` 再试 —— 并在命中后从
 * 归一化文本里**定位切回原文本**,保证替换的是原文。
 * 这样:CRLF 文件、LF 文件、以及将来混行的文件,都能正确命中。
 */
function findAnchor(src: string, anchor: string): { at: number; len: number } | null {
  const at = src.indexOf(anchor);
  if (at >= 0) return { at, len: anchor.length };
  /* 归一化重试:两侧同法归一,故下标可直接映射回原文本 */
  const nSrc = src.replace(/\r\n/g, '\n');
  const nAnchor = anchor.replace(/\r\n/g, '\n');
  const nAt = nSrc.indexOf(nAnchor);
  if (nAt < 0) return null;
  /* 把归一化下标映射回原下标:统计 nAt 之前的 \r\n 个数 */
  const before = nSrc.slice(0, nAt);
  const crlfBefore = (before.match(/\n/g) ?? []).length;
  const realAt = nAt + crlfBefore;
  /* 原文本里对应的长度 = 归一化长度 + 该段内的 \r 个数 */
  const nSeg = nSrc.slice(nAt, nAt + nAnchor.length);
  const segCrlf = (nSeg.match(/\n/g) ?? []).length;
  return { at: realAt, len: nAnchor.length + segCrlf };
}

/** 计数 = 精确匹配数;为 0 时用归一化计数(供报错文本区分两种成因)。 */
function countAnchor(src: string, anchor: string): { n: number; normalized: boolean } {
  const exact = src.split(anchor).length - 1;
  if (exact !== 0) return { n: exact, normalized: false };
  const nSrc = src.replace(/\r\n/g, '\n');
  const nAnchor = anchor.replace(/\r\n/g, '\n');
  return { n: nSrc.split(nAnchor).length - 1, normalized: true };
}

/**
 * ★ D1 的锚点**自取**:返回汇点 `this.ac.inventory(userId, {...})` 整段调用文(含 `(`,不含 `;`)。
 *
 * ## 为什么不能再靠「注入一个未闭合的 `/*`」
 * 旧版锚点是 `this.ac.inventory(userId, {` ⇒ 替换成
 * `this.ac.inventory(userId, input as never, /*`,靠**末尾那个未闭合块注释**把后面整个对象
 * 字面量吞掉,好让门禁看到「实参里一个字面字段都没有」⇒ 回退接口级。这个惯用法**位置敏感**:
 * ```
 * server/src/net/room.ts:2784-2788  新增了一条内层块注释(「★ 按件判据」的说明)
 *   ⇒ 注入的 `/*` 在**那里**就被闭合(块注释不嵌套)
 *   ⇒ 其后的 `capacity` 又变成活的实参 ⇒ matched=1 ⇒ D1 不再回退接口级
 *   ⇒ 用例红在「契约表失真」而不是「整体透传」,即**探针**坏了,不是门禁坏了
 * ```
 * ⇒ 探针不该依赖「后面有没有闭注释符、它在哪一行」。改为**括号配平取出整段调用**,
 *   再整段换成 `this.ac.inventory(userId, input as never)`:
 *   注入结果是**恰好**「对象整体递下去、字段名不出现」这一种形态 ——
 *   形态由替换后的文本本身决定,与注释位置无关;**判据强度一分不降**(反而更强:
 *   旧版连 `tick/ops` 都一起消失,新版把它们所在的整段实参换成了裸标识符)。
 */
function pickInventoryCall(src: string): string {
  /* `{` 只是定位用(汇点实参是对象字面量);真正返回的是**括号配平**的整段调用。 */
  const head = 'this.ac.inventory(userId, {';
  const at = src.indexOf(head);
  if (at < 0) return '';
  const open = at + 'this.ac.inventory'.length;
  if (src[open] !== '(') return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

const CASES: Case[] = [
  /* ═══ T37:新增的「入口执行层」门禁必须能检测漂移 ═══
   *
   * 该门禁查的是「handler 有 verdict 守卫但**成功路径为空**」。
   * 一旦有人给成功侧加上真执行,登记里的「成功路径为空」就变成假事实 ——
   * 门禁必须报「应移出登记」,否则这份登记会慢慢腐烂成一份假的清单。
   *
   * ⚠️ 锚点由 pickVerdictGuard() **运行时自取**(同 T32/T34 的理由):
   * 这两条 handler 一旦被修好,写死的锚点就会过期,而过期的表现是
   * 「锚点命中 0 次」—— 看起来像「门禁没问题」,实际是**用例没测到**。
   */
  /* ⛔ **本用例已于 2026-11-14 移除 —— 它的主体不存在了**。
   *
   * 原用例:「给 `action` handler 加上成功执行 ⇒ 登记应报『不再是该形态』」。
   * 它靠 `mark: 'inert-action'` 从活文件里自取「`action` 的拒绝守卫行」(`!x.allowed`),
   * 再往它后面插一条执行语句来构造注入。
   *
   * 2026-11-14 动作执行层接线之后:
   * ```
   * · action handler 改成 `dispatchAction()` + **双向回执**(成功 actionResult /
   *   失败 reject),里面**不再有** `!x.allowed` 那一行;
   * · 于是锚点自取抛出「action 的拒绝守卫行未找到」(实测:gate-selfcheck 直接崩);
   * · 而 verify.ts 的 VERDICT_HANDLER_KNOWN 里 action 那条**已被移出** ⇒
   *   本用例即便能注入,也**永远不可能变红**(它要测的门禁已不再检查该主体)。
   * ```
   * ⇒ 按 T37 第二条用例(attack 换向)的同一处置原则:**用例自己过期了**,
   *   而不是「门禁失效」。留着它会让 gate-selfcheck 崩溃 —— 那是**更坏的**
   *   状态:一个连跑都跑不起来自检。故移除,并在此留档。
   * ⇒ 仍保留的是 `inert-attack`:attack 不在登记表里,
   *   把一条「已修好」的登记项塞回去必须报「不再是该形态」—— 那条还成立。
   */
  {
    group: 'T37',
    name: '把**已修好的** attack 重新塞回登记 ⇒ 应报「不再是该形态」',
    /* ⚠️ 本用例于 task-47(阶段 A)被**换向**,原因值得记下:
       原用例「给 attack 加成功执行 ⇒ 应报不再是该形态」在 attack **已被移出登记**
       之后**永远不可能变红** —— 它注入的 handler 门禁已不再检查。
       ⇒ 变红失败**不等于**「门禁失效」,而是**用例本身过期**。
       这与 T37 自己注释里的警告是同一件事(`pickVerdictGuard` 的理由),
       只是这次过期的是**登记侧**而不是锚点侧。

       ⇒ 换向后的用例测**相反且更有价值**的方向:
         把一条**已经修好**(handler 有成功路径)的登记项重新加回注册表 ⇒
         门禁必须报「不再是该形态」,否则
         **这份登记会腐烂成一份假的清单**(登记说「无执行」而实际有执行)。

       ⇒ 它钉住的不变量是:`VERDICT_HANDLER_KNOWN` 里的每一条都必须
         **真的**处于「成功路径为空」形态。 */
    file: 'scripts/verify.ts',
    from: 'const VERDICT_HANDLER_KNOWN = new Map<string, VerdictHandlerFacts>([\n',
    to: 'const VERDICT_HANDLER_KNOWN = new Map<string, VerdictHandlerFacts>([\n'
      + "  ['server/src/net/room.colyseus.ts::attack', "
      + "{ successPath: '**无**', evidence: 'gate-selfcheck 注入项' }],\n",
    expect: 'red',
    wantMsg: /不再是该形态/,
    args: ['--frozen'],
    mark: '',
  } as Case,

  /* ═══ T34:新增的「生产零引用」门禁必须能失败 ═══
   *
   * 这道门禁的核心不变量是 `orphan ⊆ 可达性白名单`。
   * 它把「两套判据是否自洽」变成了机器可检查的东西 —— 但**只有它能红才算**。
   *
   * ⚠️ 锚点从 `orphan-audit.ts` 的活清单里**自取**(与 `pickServerReason` 同一理由):
   * 那张表里的条目会随接线被摘除,写死锚点必然过期。
   * **这个教训本轮已经验证过两次**(T32 的理由锚点、以及我第一版注入用错缩进空跑)。 */
  {
    group: 'T34',
    name: 'orphan 清单里混入一个**可达**模块 ⇒ 两套判据矛盾',
    file: 'scripts/orphan-audit.ts',
    /* `from` 由 pickOrphanRow() 运行时填入(见下方 CASES 后处理),
       这里留空串占位,与既有 T32 的自取机制同构。 */
    from: '',
    to: '',
    expect: 'red',
    wantMsg: /两套判据矛盾/,
    /* `--frozen` 而非 `--all`:`checkOrphanList()` 在 main 里是**无条件调用**的
       (不被 `frozenOnly` 门控),所以 `--frozen` 足以触发它,
       又避开了跑全部测试带来的无关噪音(实验室副本里 WS-07 会因缺文件而红)。 */
    args: ['--frozen'],
    /* 标记:本条需要运行时自取锚点 */
    mark: 'orphan-subset',
  } as Case,
  {
    group: 'T34',
    name: 'orphan 清单里理由被清空 ⇒ 未写明理由',
    file: 'scripts/orphan-audit.ts',
    from: '',
    to: '',
    expect: 'red',
    wantMsg: /未写明理由/,
    args: ['--frozen'],
    mark: 'orphan-blank-reason',
  } as Case,

  /* ═══ D1:整体透传必须回退接口级并报红 ═══
     ⚠️ 锚点**自取**(`pickInventoryCall`,理由见该函数头):
     旧版靠「注入 `input as never, /*` 让后面的对象字面量被注释吞掉」,
     而同侪在 `room.ts:2784-2788` 新增内层块注释后,那个 `/*` 提前闭合 ⇒
     探针静默退化成「缺 2 个受管字段」⇒ 用例红在**错的**消息上。
     ⇒ 现在整段实参**整个换成** `inventory(userId, input as never)`:
       形态由替换文本决定,与注释位置无关;注入的就是最纯粹的「整体透传」。 */
  {
    group: 'D1',
    name: '汇点实参整体透传 inventory(userId, input)',
    file: 'server/src/net/room.ts',
    from: (src) => pickInventoryCall(src),
    to: 'this.ac.inventory(userId, input as never)',
    expect: 'red',
    wantMsg: /整体透传|取自客户端/,
    args: ['--frozen'],
  },
  {
    group: 'D1',
    name: '汇点实参别名透传 inventory(userId, pkt)',
    file: 'server/src/net/room.ts',
    from: (src) => pickInventoryCall(src),
    to: 'this.ac.inventory(userId, pkt as never)',
    expect: 'red',
    wantMsg: /整体透传|取自客户端/,
    args: ['--frozen'],
  },

  /* ═══ D2:契约表失真必须报红 ═══ */
  {
    group: 'D2',
    name: '契约表被清空 []',
    file: 'scripts/verify.ts',
    from: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],",
    to: 'applyInventory: [],',
    expect: 'red',
    wantMsg: /契约表/,
    args: ['--frozen'],
  },
  {
    group: 'D2',
    name: '字段名拼错 beforeTotals',
    file: 'scripts/verify.ts',
    from: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],",
    to: "applyInventory: ['allowedSources', 'capacity', 'beforeTotals'],",
    expect: 'red',
    wantMsg: /契约表/,
    args: ['--frozen'],
  },
  {
    group: 'D2',
    name: '契约条目被整条删除',
    file: 'scripts/verify.ts',
    from: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],",
    to: '/* 契约被删 */',
    expect: 'red',
    wantMsg: /契约表/,
    args: ['--frozen'],
  },
  {
    group: 'D2',
    name: '登记了不存在的字段 ghostField',
    file: 'scripts/verify.ts',
    from: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],",
    to: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal', 'ghostField'],",
    expect: 'red',
    wantMsg: /契约表/,
    args: ['--frozen'],
  },
  {
    group: 'D2',
    name: '登记了不存在的汇点方法 applyFoo',
    file: 'scripts/verify.ts',
    from: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],",
    to: "applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],\n  applyFoo: ['x'],",
    expect: 'red',
    wantMsg: /契约表/,
    args: ['--frozen'],
  },
  {
    group: 'D2',
    name: '未修:allowedSources 取自 input(回归守卫)',
    file: 'server/src/net/room.ts',
    from: 'allowedSources: this.grantedSourcesFor(userId),',
    to: 'allowedSources: input.allowedSources,',
    expect: 'red',
    wantMsg: /取自客户端/,
    args: ['--frozen'],
  },

  /* ═══ D3:逐套件表影子行 ═══
     ⚠️ 探针必须复刻**真正的绕过形态**:在真行**之前**插一行数值正确的假行,
     再把真行改错。这样:
       · 正确实现(matchAll + 唯一性)⇒ 数出 2 处 ⇒ 报「影子行」
       · 退化实现(exec 首匹配)⇒ 命中那行**正确的**假行 ⇒ **该 WS 静默通过**
     反过来,若把假行插在真行**之后**,exec 也仍会命中前面那行真行 ⇒
     退化不会被暴露,用例就成了恒绿。这是我自己踩过的坑(见文件末注释)。 */
  {
    group: 'D3',
    name: 'README 逐套件表前插假行(数值对)+ 真行改错',
    file: 'README.md',
    from: '| WS-01 | 地形位压缩与分片 | 50 |',
    to: '| WS-01 | 地形位压缩与分片 | 50 |\n| WS-01 | 地形位压缩与分片 | 999999 |',
    expect: 'red',
    wantMsg: /WS-01 在 README 表格里出现 2 次/,
    /* ★ 本用例是**唯一**必须跑默认口径(全量 `runTests`)的一条:
       被测判据(`verify.ts:7315` 的 `matchAll` + 唯一性)只在 `!frozenOnly && !only`
       时执行,而且它读的是 `runTests` 填进 `suiteCounts` 的**实测**值。
       两处**口径等价**的降本(实测 66s → 18.4s,且不再递归):
       ① 副本里的 `tests/` 只留 README 那张表的**取值域**(`WS-NN` 套件):
          判据只遍历 `suiteCounts` 里 `/^WS-\d+$/` 的键 ⇒ 其余 100 个套件既不进判据、
          又占掉约 48s。影子行判据是**逐键**的,少测别的键不会让它变松。
       ② 把副本里的 `scripts/gate-selfcheck.ts` 换成**桩**(只打印 `30 通过 / 30 合计`):
          默认口径会**再 spawn 一次门禁自检**,而门禁自检又会复制整棵树、
          再跑一遍默认口径 ⇒ **无限递归**。实测(2026-11-18)旧实现的进程树里
          能直接看到嵌套的 `gate-selfcheck.ts` —— 那正是 `verify --all` 报
          `门禁自检失败(exit=null)`(子进程被 kill)的根因之一。
          ⚠️ 桩只让**本副本**的这一道变绿,本条的判定与它无关(`expect: 'red'` 由
          上面那条 README 影子行消息给出)。 */
    labSetup: (lab) => {
      for (const f of readdirSync(join(lab, 'tests'), { withFileTypes: true })) {
        if (!f.isFile()) continue;
        if (/^WS-\d+\.test\.ts$/.test(f.name)) continue;
        rmSync(join(lab, 'tests', f.name), { force: true });
      }
      writeFileSync(
        join(lab, 'scripts', 'gate-selfcheck.ts'),
        "console.log('  30 通过 / 30 合计');\n",
        'utf8',
      );
    },
  },
  /* ═══ D4:断言数取自被测套件自身的输出,可被伪造 ═══
     旧实现取**末匹配**,于是在套件末尾多打一行 `999/999 通过` 就能让门禁
     把 999 当成「实测」断言数(并报 ✓ 用例汇总 1964 条,真值 1015)。
     现在要求恰好 1 处,多一处即 fail。
     ⚠️ 必须跑 `runTests`,故不能带 `--frozen`(它会跳过 runTests)。
     ★ 口径收窄成 `--only WS-01`(**只**跑这一个套件),而不是默认口径:
       ① `runTests` 在 `--only` 下**照跑**(`verify.ts:7893` 的守卫只排除
          `frozen/docs/content`),本用例要断言的正是 `runTests` 里那条
          「每套件恰好 1 处 N/N」判据 ⇒ 口径等价;
       ② 默认口径约 66s(全量 109 个套件),而它还会 **再 spawn 一次门禁自检**
          ⇒ 在副本里递归复制整棵树。实测(2026-11-18)进程树里能直接看到
          嵌套的 `gate-selfcheck.ts`,这正是老 `verify --all` 报
          `门禁自检失败(exit=null)`(子进程被 kill)的根因之一。
       实测:默认口径 66s / `--only WS-01` 6.2s,两者**都**红在那条消息上。 */
  {
    group: 'D4',
    name: '在 WS-01 末尾伪造一行 999/999 通过',
    file: 'tests/WS-01.test.ts',
    from: "report('WS-01');",
    to: "report('WS-01');\nconsole.log('[WS-01] 999/999 通过');",
    expect: 'red',
    wantMsg: /处「N\/N 通过」/,
    args: ['--only', 'WS-01'],
  },
  {
    group: 'D5',
    name: '容量阈值降到 0(迫使告警)⇒ 必须有 ✗',
    file: 'scripts/verify.ts',
    from: 'if (c.ratio !== null && c.ratio > 0.9) {',
    to: 'if (c.ratio !== null && c.ratio > -1) {',
    expect: 'red',
    wantMsg: /容量账本/,
    args: ['--content'],
  },

  /* ═══ N1:--integration 不得假红 ═══
     断言的是「那条具体消息不再出现」,而不是「整体绿」——
     因为队友在飞的 README 项本来就会让它红,那与 N1 无关。 */
  /**
   * ★ 2026-11-22(w79):**两条并一条** —— 它们跑的是**同一条命令、同一处(没有)变异**,
   * 只是一条断言「某消息不得出现」、另一条断言「另一消息必须出现」。
   * `runCase` 本来就**同时**支持 `wantMsg` + `notMsg`(见 1501-1515)⇒ 一次运行
   * 就能给出两个结论,**断言一条不少**。
   *
   * 为什么必须并:2 核机上这两条各 **296 s**(独占)且**不能并发**(并发成 ~600 s ⇒ 各自撞穿
   * `verify.ts#VERIFY_TIMEOUT_MS`),所以长作业专线 = 两条串行 **927 s**(实测 532.9 + 394.3),
   * 已超外层 `SELFCHECK_TIMEOUT_MS`(900 s)。并成一条后专线只跑一次 ⇒ 总墙钟回到预算内。
   * ⚠️ 这不是「少测一条」:删掉的只是**重复执行**,不是任何一条断言。
   */
  {
    group: 'N1',
    name: '--integration:不得报「冻结层不变量...实测 0」,且必须打印「本模式未运行 checkFrozen」',
    file: 'README.md',
    from: '',
    to: '',
    expect: 'any',            /* 只断言消息,不约束整体红绿 */
    notMsg: /冻结层不变量.*实测 0/,
    wantMsg: /本模式未运行 checkFrozen/,
    args: ['--integration'],
  },

  /* ═══ N2:--all 必须被解析,且与选择性 flag 冲突时报错 ═══ */
  {
    group: 'N2',
    name: '--all --frozen 口径歧义必须报错',
    file: 'README.md',
    from: '',
    to: '',
    expect: 'red',
    wantMsg: /--all 不能与/,
    args: ['--all', '--frozen'],
  },

  /* ═══ T32:可达性门禁的客户端入口与理由过时 ═══
     背景(task-32):`PROD_ENTRIES` 曾漏掉整个客户端,于是 8 个**正在被浏览器
     加载**的模块被报成「未登记」;16 条 client/** 白名单带着「本仓无装配入口」
     这条已变成假话的理由长期挂着,而自检抓不到「理由本身过时」。 */

  /* T32-a:切断闭包 —— 可达模块必须被报出来。
     注:`--strict-reach` 下它是硬失败;不带该 flag 时是告警(见 checkReachability
     的函数头注释:不可达有合理情形,故默认告警)。这里两种都断言。 */
  {
    group: 'T32',
    name: '切断 main.ts 的一处 import ⇒ 下游模块被报未登记',
    file: 'client/src/main.ts',
    from: "import { boot, type BootHandle } from './three/boot.ts';",
    to: '/* 自检探针:故意断开闭包 */',
    expect: 'red',
    wantMsg: /未登记的不可达模块/,
    args: ['--frozen', '--strict-reach'],
  },
  {
    group: 'T32',
    name: '切断闭包在默认口径下也应出现告警文本',
    file: 'client/src/main.ts',
    from: "import { boot, type BootHandle } from './three/boot.ts';",
    to: '/* 自检探针:故意断开闭包 */',
    expect: 'any',
    wantMsg: /未登记的不可达模块/,
    args: ['--frozen'],
  },

  /* T32-b:理由过时 —— 核心新自检。把一条当前理由改回已失效的措辞。
   *
   * ⚠ 锚点**必须指向当前真实存在的理由文字**。2026-11-12 客户端 8 条接线后
   * 整块摘除,本探针原先锚定 `audio.ts` 的那句理由就失效了 ——
   * 自检如实报出「探针无效:锚点命中 0 次」,而不是假装门禁失职。
   * **这个区分正是本脚本存在的意义**(见文件头 §2)。 */
  {
    group: 'T32',
    name: '白名单理由写回「本仓无装配入口」⇒ 必须报理由过时',
    file: 'scripts/verify.ts',
    /* 锚点**自取**:从当前清单里挑一条仍在册的服务端理由。
       它确实「等接线」,且本仓确实**有**装配入口 ⇒ 写回
       「本仓无装配入口」必然是假话。
       不写死是因为清单会随接线收缩 —— 本项目已因此修过两次。 */
    from: (src) => pickServerReason(src),
    to: "'客户端子系统,本仓无装配入口'",
    expect: 'red',
    wantMsg: /理由过时/,
    args: ['--frozen'],
  },
  {
    group: 'T32',
    name: '理由里引用不存在的文件 ⇒ 必须报理由过时',
    file: 'scripts/verify.ts',
    from: (src) => pickServerReason(src),
    to: "'待接入客户端装配层(参照 ghost_assembly.ts 的接法)'",
    expect: 'red',
    wantMsg: /理由过时/,
    args: ['--frozen'],
  },

  /* T32-c:客户端 HTML 与 PROD_ENTRIES 脱节 */
  {
    group: 'T32',
    name: 'index.html 改掉 script 路径 ⇒ 必须报入口脱节',
    file: 'client/index.html',
    from: './src/main.ts',
    to: './src/entry.ts',
    expect: 'red',
    wantMsg: /脱节|找不到/,
    args: ['--frozen'],
  },

  /* T32-c2:**本次事故的回归守卫** —— 把客户端入口从 PROD_ENTRIES 里摘掉。
     这是 task-32 的原始形态(Task 描述的第一条缺陷),必须有用例守住。
     摘掉后会有一批模块重新变成「未登记」;默认只是告警,
     故此处带 `--strict-reach` 让它成为硬失败。
     ⚠️ 我第一版漏了这条用例 —— 于是「退回修复」验证时它没被抓到,
     我误以为是自检失灵,实际是**用例覆盖不全**。两者要分清。 */
  {
    group: 'T32',
    name: '摘掉 PROD_ENTRIES 的客户端入口 ⇒ 必须报未登记(回归守卫)',
    file: 'scripts/verify.ts',
    from: "'client/src/main.ts', // client/index.html → <script src=\"./src/main.ts\">",
    to: '/* 自检探针:故意摘掉客户端入口 */',
    expect: 'red',
    wantMsg: /未登记的不可达模块/,
    args: ['--frozen', '--strict-reach'],
  },
  {
    group: 'T32',
    name: '摘掉客户端入口后应打印可达性数字变化',
    file: 'scripts/verify.ts',
    from: "'client/src/main.ts', // client/index.html → <script src=\"./src/main.ts\">",
    to: '/* 自检探针:故意摘掉客户端入口 */',
    expect: 'any',
    /* ⚠️ 本数字 = `PROD_ENTRIES.length - 1`(摘掉一条后剩下的)。
       它**随 PROD_ENTRIES 增删而变**,是本用例唯一需要手工跟的数字。
       本轮实测修正:task-57 补入 `server/src/index.ts` 后
         PROD_ENTRIES 3 → 4 ⇒ 摘掉客户端出口后由 `2 个` 变 **`3 个`**。
       2026-11-13 task-69 再补入 `server/src/sim/ws_demo.ts`
         PROD_ENTRIES 4 → 5 ⇒ 摘掉客户端出口后 `3 个` 变 **`4 个`**(本轮改)。
       与 T32-d「白名单条数必须取实测」是**同一类要求**,只是这一条自带一个常量。
       ⇒ 维护规则:改了 `PROD_ENTRIES` 的**条数**,就回来改这里;
         忘了改的表现是「消息未命中 ✗」(而 `expect: 'any'` 会让它看起来像软失败)。
       ★★ 为什么会连着两轮都要手工跟这个数 —— 这本身是**设计味道**:
         一个常量跟着另一个常量变,而两个文件不互相 import
         ⇒ 只能靠"谁改了记得回来改"。
         ⇒ 但**现在不改结构**:本文件是"给门禁上牙"的自检夹具,
           它**刻意**不 import `verify.ts`(否则被测物与夹具同源)。
         ⇒ 代价就是这个手工数字。已记入 `docs/PROGRESS.md`(与陷阱 80「有通道 vs 无通道」同族)。 */
    wantMsg: /入口 4 个/,
    args: ['--frozen'],
  },

  /* T32-d:写死数字 —— 白名单条数必须取实测 */
  {
    group: 'T32',
    name: '白名单条数行取实测(不写死 50)',
    file: 'README.md',
    from: '',
    to: '',
    expect: 'any',
    /* ⚠ **不许写死条数** —— 这句最初写成 `/欠账构成\(35 条全部待接/`,
       而白名单会随接线单调收缩(43→35→27…)。写死会让本用例在每次接线后
       变成假失败,而不是真失败:它测的是「有没有写死」,
       写死一个随时会变的数字恰恰是它要防的病。
     ⚠️ 2026-11-12 加严:「全部待接」这个前提已被 task-43 实测**证伪**,
     口径改为「N 条中 M 条非欠账」⇒ **M 也必须取实测**。
       故改为「必须打印**当前实际条数**」—— 从 verify.ts 读同源常量。 */
    wantMsg: (() => {
      const src = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8');
      const a = src.indexOf('const UNREACHABLE_EXEMPT = new Map<string, string>([');
      const b = src.indexOf(']);', a);
      /* ⚠️ 只认**行首路径**,不要求「理由与 `]` 同行」——
         白名单条目可以写成**多行**(理由用 `+` 拼接),而原先的正则
         无论是「同行闭合」还是「同行不闭合」都会漏计多行条目。
         实测:漏计 3 条 ⇒ 自检报假失败(26/27)。**这是 Lead 引入的 bug。** */
      const body = src.slice(a, b);
      const n = [...body.matchAll(/^\s*\['[^']+',/gm)].length;
      /* ⚠️ 2026-11-12 加严(Lead):打印口径从「N 条**全部待接**」改成
         「N 条中 M 条非欠账,余 N−M 条按卡点分类」—— 因为 task-43 实测证明
         「全部待接」这个**假设是假的**(有 2 条非欠账:gate-only 与差集)。
         ⇒ M 也**必须从源算**,不许写死。否则同一个病换个字段藏:
           只断言 N,N 对了门禁就放行,而 M 可以随便写。
         窄词在此**重复一份而非 import** —— 本文件的职责是**独立复算**;
         若 import verify.ts 的正则,正则写错时两边一起错,自检就失去意义。 */
      /* ⚠️ 2026-11-13 修(Lead,第二次):
         **只取到「路径后第一个字符串字面量」是不够的** —— 理由**可以是多行拼接**:
         ```
           ['shared/testing/harness.ts',
             '测试夹具(...)。生产侧真 importer = **0** —— '
             + '它**只被 tests/** 消费**(21 个测试文件的公共 harness)。'
             + '属「gate-only」家族:...'
             + '...']
         ```
         ⇒ 原先那条正则只抓到**第一段**(`'测试夹具(...)。生产侧真 importer = **0** —— '`)
           ⇒ 而 `gate-only` 出现在**第三段** ⇒ **漏判** ⇒ nonDebt 算成 2,而 verify 打印 **3**。
         ⇒ 表现:本用例「消息未命中 ✗」;而 `expect: 'any'` 让它看起来像软失败
           ⇒ 所以它**从 HEAD 起就一直红着**(实测:HEAD 与工作区都得 2 ⇒ 非本轮引入)。
         ★★ 这是我在此文件上一处修复的**同族残留**:那次修的是「条目数 N」漏计多行,
            这次是「非欠账数 M」漏计多行的**理由** —— 同一个病换了字段。
            ⇒ 教训:**"多行能力"要一次贯通到这一段的每个抽取点**,不能只修当时报错的那个。

         ★ 而我的**第一次修法也是错的**(留档):我按「本条到下一个 `['` 之间」切段,
           把条目之间的**说明性块注释**一并吞进来了 ⇒ 那些注释里讨论着 `gate-only`/`差集`
           ⇒ 算成 **5**(真值 3)⇒ 从"漏计"变成"多计"。
           ⇒ ⇒ 教训:**切段法在多段落里天生会吃到段间内容。**
           正确做法是**先剥注释**,让条目边界重新变得可靠 —— 见下。
         ⇒ 剥注释时**必须保留换行**(替换成同数量的换行,而不是一个空格):
           否则后面所有行下标前移 —— 这与 `assertion-audit` 那个"行号最多偏 -103"的
           真 bug 是**同一个形态**(net-persist 同日抓到),我在同一轮里犯了同一个错。 */
      const clean = body.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
      const entries = [...clean.matchAll(/^\s*\['([^']+)',\s*([\s\S]*?)'\]/gm)];
      if (entries.length !== n) {
        throw new Error(
          `gate-selfcheck: 剥注释后抽到的条目数(${entries.length})与上面算的 n(${n})不一致 —— 不许静默继续`,
        );
      }
      /* ══════════════ ★ 2026-11-14 Lead:非欠账判据改成**两半**,这里跟着改 ══════════════
       *
       * ## 为什么必须改(而不是把 3 改成 6)
       *
       * 旧版这一行是:
       * ```
       *   const nonDebt = entries.filter((e) => /gate-only/.test(e[2]!) || /差集/.test(e[2]!)).length;
       *   if (nonDebt !== 3) throw ...   「期望 3」
       * ```
       * 它把**当时 BLOCK 出来的 3** 写成了期望值 —— 正是本仓陷阱 71:
       * **一条把「当前状态」编码成期望值的断言,是墓碑**。
       * 所以 verify.ts 把差集改成计算式(4 条)之后,这一行**必然报错**,
       * 而报错的原因**不是新判据错了**,是这行**在守卫旧状态**。
       *
       * ⇒ 正确修法不是"把 3 改成 6",而是**让两半各按自己能算的方式独立复算**:
       * ```
       * gate-only 半:理由文本可判(/gate-only/)      ⇒ 从文本数
       * 差集半     :是**图性质**(引用者是否全不可达)  ⇒ 必须**自己走一遍 import 图**
       * ```
       * ★ 后者的独立实现是**有意重复**的:本文件的职责是独立复算 ——
       *   若 import verify.ts 的 `isDiffSet()` 借它的结果,判据写错时两边一起错,
       *   自检就失去了意义(与上面「窄词重复一份而非 import」同一条理由)。
       *   ⇒ ⇒ 而这份重复实现**真的有价值**:它由**另一个口径**算出同一个集合,
       *      是本仓「报任何总数必须与独立来源对账」的实例。
       */
      const gateOnlyText = entries.filter((e) => /gate-only/.test(e[2]!)).length;

      /* 独立复算差集:自己走 import 图,不借用 verify.ts 的任何函数。 */
      const ROOT2 = ROOT;
      /* ⚠️⚠️ **[2026-11-14 Lead] 我自己在这里踩了陷阱 110 的第三次 —— 必须记下。**
       *
       * 第一版我把 `build`(以及 `dist`/`out`)放进**全局** skip 表:
       * ```
       *   if (!/^(node_modules|\.git|...|dist|build|out)$/.test(e.name)) walkTs(...)
       * ```
       * 而本仓有**一整棵生产源码树**叫 `server/src/build/`(5 个 .ts)。
       * ⇒ 它被静默漏掉 ⇒ 我数出 **93** 个生产文件,而 `ts-paths.ts` 数 **98**。
       *
       * ⇒ 这正是陷阱 110 的原话:"我的排除清单里有 'build' —— 而本仓有一整棵
       *   生产源码树叫 server/src/build/"。**我在修「差集判据」时又犯了一次。**
       * ⇒ 而 `ts-paths.ts` 的正确做法写得很清楚:
       *    「server/src/build ← 同名产物目录但**不在根**,已按源码遍历」
       *    ⇒ 即:**只在根层跳过 build/dist,子层一律当源码**。
       *
       * ★ 判据(这次要真正执行):排除规则若按**裸目录名**写,必须问「这个名字
       *   在子层还出现吗」。本仓答案是:**出现,而且是生产源**。
       */
      const walkTs = (dir: string, depth = 0, out: string[] = []): string[] => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) {
            /* ★ 2026-11-14(接手者):两条规则**合并为唯一事实源的一次调用** ——
               此前这里是**第 7 份**跳过清单(而且它自己也缺 `_probe_sandbox`)。
               语义逐条等价:`depth 0` = 构建产物类 + 非本仓类;`depth > 0` = 只有非本仓类
               ⇒ 上面那段长注释写的纪律(「只在根层跳过 build/dist」)从此由**类型**保证,
                 不再靠"下一个写判据的人会读到这段注释"。 */
            if (shouldSkipDirAtDepth(e.name, depth)) continue;
            walkTs(join(dir, e.name), depth + 1, out);
            continue;
          }
          if (!e.name.endsWith('.ts')) continue;
          const rel = relative(ROOT2, join(dir, e.name)).split(sep).join('/');
          /* 与 ts-paths.ts 的 isProd 同口径:三个顶层目录的全部 .ts
             ⚠️ 曾经这里写成 `shared/src/`,而 shared/ **没有 src/ 层** ⇒ 整棵被漏
             (陷阱 113 的实例,同一次修法里犯的第二个) */
          if (/^(server|client|shared)\//.test(rel)) out.push(rel);
        }
        return out;
      };
      const prodAll2 = walkTs(ROOT2);
      if (prodAll2.length === 0) {
        throw new Error('gate-selfcheck: import 图遍历出 0 个生产文件(判据失效,不许静默继续)');
      }
      /* ★ 自证分母:与 ts-paths.ts 对账(本仓硬规则「报任何总数必须与独立来源对账」)。
         实测正解 = 98(client 27 + server 61 + shared 10)。
         ⚠️ 不写死 98(那是墓碑)—— 改成"必须 > 90 且能整除出三块",漂了就报。 */
      console.log(`      · 生产文件(本文件独立遍历):${prodAll2.length} 个 `
        + `(client ${prodAll2.filter((f) => f.startsWith('client/')).length} / `
        + `server ${prodAll2.filter((f) => f.startsWith('server/')).length} / `
        + `shared ${prodAll2.filter((f) => f.startsWith('shared/')).length})`);
      if (prodAll2.filter((f) => f.startsWith('shared/')).length === 0) {
        throw new Error(
          'gate-selfcheck: shared/ 下遍历出 0 个 .ts —— 遍历口径漏了整棵 shared/'
          + '(2026-11-14 实测过这个 bug:/^shared\\/src\\// 而 shared/ 没有 src 层)',
        );
      }
      if (prodAll2.filter((f) => f.startsWith('server/src/build/')).length === 0) {
        throw new Error(
          'gate-selfcheck: server/src/build/ 下遍历出 0 个 .ts —— 遍历口径把生产源码树当产物目录'
          + '(2026-11-14 实测过这个 bug:skip 表里有裸目录名 build)',
        );
      }
      /* ── 入口闭包:入口清单**从 verify.ts 源码解析**,不硬编码 ──────────────
       *
       * ★ 2026-11-18(本轮):此前这里硬编码 4 个入口,而 `verify.ts` 的
       *   `PROD_ENTRIES` 因 task-69 已是 **5** 个(加了 `server/src/sim/ws_demo.ts`)。
       *   ⇒ 镜像闭包比真闭包少 2 个文件(ws_demo 与它带进来的 ws_server),
       *     镜像复算与门禁打印因此**必然对不上**,而症状看起来像「判据写错了」。
       *   ★ 教训:硬编码**别人的清单**= 两份事实绑在一起、却没有任何东西检查它们一致。
       *     本文件已反复吃这一口(见上方 T32 那条「入口 N 个」的手工数字)。
       *   ⇒ 修法不是「把 4 改成 5」(下一轮照样漂),而是**从源码解析**:入口数永远跟随。
       *   ⇒ 三条**互校**(解析不可靠时立刻红,并**点名**差哪几条):
       *     1 解析条数 == 数组字面量里的**全部**字符串条数(漏认就会不等);
       *     2 每条都必须真存在于磁盘(否则说明把非条目文本当成了入口);
       *     3 解析结果必须含客户端入口(它由 `client/index.html` 的 script 路径钉住,
       *       是本文件之外的另一份事实 —— 解析若只吃到前半段,这条会红)。
       */
      const PROD_ENTRY_PATHS = (() => {
        const at = src.indexOf('const PROD_ENTRIES = [');
        if (at < 0) {
          throw new Error('gate-selfcheck: verify.ts 里找不到 `const PROD_ENTRIES = [`'
            + ' —— 入口清单无法同源(镜像必然与门禁漂移,不许静默继续)');
        }
        const rest = src.slice(at);
        const endRel = rest.search(/^];/m);
        if (endRel < 0) {
          throw new Error('gate-selfcheck: PROD_ENTRIES 数组字面量没有行首 `];` 收尾 —— 解析锚点已失效');
        }
        /* 剥注释时**保留换行**(否则行下标前移 —— 与上面白名单解析同一纪律) */
        const body = rest.slice(0, endRel)
          .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
          .replace(/\/\/.*$/gm, '');
        const parsed = [...body.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]!);
        /* 互校 1:与「字面量里的全部字符串」对账 —— 不等就点名差哪几条 */
        const literals = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
        const missed = literals.filter((x) => !parsed.some((y) => y === x));
        if (parsed.length !== literals.length || missed.length > 0) {
          throw new Error(
            `gate-selfcheck: PROD_ENTRIES 解析条数(${parsed.length})≠ 数组字面量字符串条数(${literals.length})`
            + ` —— 未被认出的条目:${missed.length > 0 ? missed.join(', ') : '(内容一致但条数不符,疑重复项)'}`
            + '(入口清单的解析锚点失效 ⇒ 镜像不能再当真)',
          );
        }
        /* 互校 2:每条都必须真存在于磁盘 */
        const missing = parsed.filter((p) => !existsSync(resolve(ROOT2, p)));
        if (missing.length > 0) {
          throw new Error(
            `gate-selfcheck: PROD_ENTRIES 里有 ${missing.length} 条在磁盘上不存在:${missing.join(', ')}`
            + '(解析可能把非条目文本当成入口;也可能入口文件被删 —— 两种都要人看)',
          );
        }
        /* 互校 3:客户端入口必在其中(`client/index.html` 的 script 路径 = 另一份事实) */
        if (!parsed.includes('client/src/main.ts')) {
          throw new Error('gate-selfcheck: 解析出的 PROD_ENTRIES 里没有 `client/src/main.ts`'
            + ' —— 而 client/index.html 的 script 指向它 ⇒ 解析只吃到了一部分');
        }
        return parsed;
      })();
      console.log(`      · 入口清单(从 verify.ts **解析**,不硬编码):${PROD_ENTRY_PATHS.length} 个`
        + ` — ${PROD_ENTRY_PATHS.join(', ')}`);
      const ENTRIES2 = PROD_ENTRY_PATHS.map((p) => resolve(ROOT2, p)).filter((p) => existsSync(p));
      if (ENTRIES2.length === 0) {
        throw new Error('gate-selfcheck: 一个生产入口都不存在(闭包必然是空的,不许静默继续)');
      }
      /* 说明符 → 绝对路径。**与 `verify.ts:resolveImport()` 同一语义**
         (`./x` → `./x.ts` → `./x/index.ts`;非相对说明符一律 null),
         因为闭包与 importer 两侧都必须用它,否则「引用者全不可达」会依赖两侧的偏差。 */
      const resolveSpec2 = (fromAbs: string, spec: string): string | null => {
        if (!spec.startsWith('.')) return null;
        const p = resolve(join(dirname(fromAbs), spec));
        const isFile2 = (q: string): boolean => {
          try { return statSync(q).isFile(); } catch { return false; }
        };
        if (p.endsWith('.ts')) return isFile2(p) ? p : null;
        if (isFile2(`${p}.ts`)) return `${p}.ts`;
        const idx = join(p, 'index.ts');
        return isFile2(idx) ? idx : null;
      };
      const reach2 = new Set<string>();
      {
        const stack = [...ENTRIES2];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          if (reach2.has(cur)) continue;
          reach2.add(cur);
          for (const spec of extractRelImports(readFileSync(cur, 'utf8'))) {
            const dep = resolveSpec2(cur, spec);
            if (dep !== null && !reach2.has(dep)) stack.push(dep);
          }
        }
      }
      const diffSetPaths: string[] = [];
      /* ⚠️ 遍历必须取 `e[1]`(捕获组里的**路径**),不能解构 `[rel]` ——
         那取的是 `e[0]`(整段匹配文本),于是 base 提取不到、importer 恒为 0
         ⇒ 差集算成 0 条而**看起来完全正常**。
         我第一次就是 `for (const [rel] of entries)` ⇒ 独立复算报「差集 0 条」,
        与 verify.ts 的 4 条**矛盾** —— 那个矛盾正是这条 bug 的信号。 */
      /* ══ 差集判据:**与 verify.ts 的 `isDiffSet()` 同口径** ══
       * ★ 2026-11-18:此前这里按 **basename 正则** (`from '...x.ts'`) 找 importer,
       *   而 `verify.ts` 用的是同一套 basename 正则 —— 于是两边都犯同一个错:
       *   `server/src/combat/cooking.ts` 的 importer 被算到 `shared/{types,constants}/cooking.ts` 头上。
       *   现在两侧都改成「**解析到绝对路径再比较**」,并且都用
       *   「静态 `from` / 裸副作用 / `export ... from` / **字面量**动态 `import()`」这一套提取口径
       *   (口径来源 = `scripts/imports.ts` 头部的真值表;非字面量 `import(expr)` **两侧都不跟踪**,
       *    已作为接受边界登记在 verify.ts 的 `checkDynamicImportBoundary()`)。
       * ⚠️ 本文件仍**自己实现**提取与解析(不 import imports.ts / verify.ts):
       *   独立复算的价值在于用另一份实现算出同一个集合;若两侧结果不同,那是**发现**。
       */
      for (const e of entries) {
        const rel = e[1]!;
        const target = resolve(ROOT2, rel);
        const importers = prodAll2
          .map((f) => resolve(ROOT2, f))
          .filter((abs) => abs !== target
            && extractRelImports(readFileSync(abs, 'utf8')).some((s) => resolveSpec2(abs, s) === target));
        if (importers.length > 0 && importers.every((abs) => !reach2.has(abs))) {
          diffSetPaths.push(rel);
        }
      }
      const nonDebt = gateOnlyText + diffSetPaths.length;
      /* ⚠️ 这里**不再**写死总数(那是墓碑的形态)。
         改成断言两半**各自**都算出来了,并打印实际值供人核对 ——
         若哪天判据漂了,报错消息会带上两半的分解,而不是一个孤零零的数字。 */
      if (gateOnlyText === 0 && diffSetPaths.length === 0) {
        throw new Error(
          'gate-selfcheck: 两半都算出 0 条非欠账 —— 判据必然失效(本仓确有 gate-only 与差集条目)',
        );
      }
      console.log(`      · 非欠账分解(本文件**独立复算**):gate-only ${gateOnlyText} 条 + `
        + `差集 ${diffSetPaths.length} 条 = ${nonDebt} 条`);
      console.log(`      · 差集逐条:${diffSetPaths.length > 0 ? diffSetPaths.join(', ') : '(无)'}`);
      const rules = src.slice(
        src.indexOf('const WL_NON_DEBT_GATE'),
        src.indexOf('const WL_BLOCK_MECHANISM'),
      );
      if (!/gate-only/.test(rules) || !/差集/.test(rules)) {
        throw new Error('gate-selfcheck: WL_NON_DEBT_* 判据不见了');
      }
      return new RegExp(`欠账构成\\(${n} 条中 ${nonDebt} 条`);
    })(),
    args: ['--frozen'],
  },

  /* T32-e:分类打印必须与实际同源 —— 影子数须显式打印 */
  {
    group: 'T32',
    name: '「等裁决 0」必须附影子数说明',
    file: 'README.md',
    from: '',
    to: '',
    expect: 'any',
    wantMsg: /分类顺序.*结果/,
    args: ['--frozen'],
  },

  /* ═══ T38:新增的「计数对账」接链必须能失败 ═══
   *
   * 2026-11-14(接手者)把 `scripts/count-audit.ts` 的**两组断言**接进了 verify.ts 的退出链。
   * 本仓的纪律是「**接线时必须自带区分力自检**」——
   * 一个"永远绿"的消费侧和没接线没有区别(见 `checkJudgementAudit` 处那条长注释)。
   *
   * 两条用例各打**一条不同的**分支 —— 合起来才是"接线真的在消费它的退出码":
   * ```
   * T38-a  README 里的自称改坏        ⇒ 走「★ 陈旧」分支
   * T38-b  真值来源被拆(多要一个键) ⇒ 走「★ 正解缺失」分支
   * ```
   * ⚠️ `wantMsg` 用的是**只有本道会打的**那句(`文档自称与代码正解不一致` /
   *    `TRUTH 键解析失败`)—— 不能用 `/计数对账/` 之类宽串:
   *    宽串会**同时匹配"节标题"**,于是即使失败来自别的检查、用例也照样"通过"。
   *    这正是本仓那条判据:**断言必须锚在只有目标路径才会产出的字符串上**。
   *
   * ⚠️ 两条都用 `--docs`(局部口径,约 4.6s):本道的守卫是 `!frozenOnly && !only`,
   *    `--docs` 属于会跑到它的口径 ⇒ 用例既快又真的经过那条路径。
   */
  {
    group: 'T38',
   name: '把 README 的「同义反复白名单 0 条」改坏 ⇒ 计数对账必须红(T38-a)',
   file: 'README.md',
   from: '✅(白名单 0 条',
   to: '✅(白名单 1 条',
    expect: 'red',
    wantMsg: /文档自称与代码正解不一致/,
    args: ['--docs'],
  },
  {
    group: 'T38',
    name: '把 TRUTH 表多要一个不存在的键 ⇒ 计数对账必须报「真值缺失」(T38-b)',
    file: 'scripts/count-audit.ts',
    from: "const EXPECTED_TRUTH_KEYS = ['可达性白名单', 'orphan', '同义反复白名单'] as const;",
    to: "const EXPECTED_TRUTH_KEYS = ['可达性白名单', 'orphan', '同义反复白名单', '本用例注入的假键'] as const;",
    expect: 'red',
    wantMsg: /TRUTH 键解析失败/,
    args: ['--docs'],
  },
];

/* ══════════════ 运行时自取锚点(避免写死后过期)══════════════
 *
 * 为什么需要:本仓的清单会随接线**单调收缩**,写死锚点的探针到期后
 * 报「锚点命中 0 次」—— 那看起来像「门禁没问题」,实际是**用例没测到**。
 * 这个坑本轮踩过两次(T32 的理由锚点、Lead 注入时写错缩进)。
 *
 * 做法:**从活文件里解析出真实条目**,再用它构造 `from`。
 * 解析失败时**不静默跳过** —— 抛错,因为「拿不到锚点」等于这道用例不存在。 */
function resolveAnchors(): void {
  const src = readFileSync(join(ROOT, 'scripts/orphan-audit.ts'), 'utf8');
  const a = src.indexOf('export const ORPHAN_KNOWN');
  const b = src.indexOf(']);', a);
  if (a < 0 || b < 0) {
    throw new Error('gate-selfcheck: 无法解析 ORPHAN_KNOWN(锚点自取失败,用例等于不存在)');
  }
  /* 缩进也自取 —— 我第一版按 4 空格写锚点,表里是 2 空格,3/3 注入空跑。 */
  const rows = [...src.slice(a, b).matchAll(/^(\s*)\['([^']+)',\s*'([^']*)'\]/gm)];
  if (rows.length === 0) {
    throw new Error('gate-selfcheck: ORPHAN_KNOWN 解析出 0 条(正则与形态不符)');
  }
  const ind = rows[0]![1]!;
  const path = rows[0]![2]!;
  const reason = rows[0]![3]!;
  const rowText = `${ind}['${path}', '${reason}'],`;
  if (src.split(rowText).length - 1 !== 1) {
    throw new Error(`gate-selfcheck: 锚点行不唯一或形态不符: ${JSON.stringify(rowText)}`);
  }
  const badRow = `${ind}['${path}', ''],`;
  /* 刻意保留 4 空格 —— 与同行**不同缩进**才能精确命中,且不与真行混淆 */
  const injectRow = `${ind}${ind}['server/src/sim/world_sim.ts', 'probe:可达模块'],\n`;

  for (const c of CASES) {
    if (c.mark === 'inert-action' || c.mark === 'inert-attack') {
      const ev = c.mark === 'inert-action' ? 'action' : 'attack';
      const rl = 'server/src/net/room.colyseus.ts';
      const src2 = readFileSync(join(ROOT, rl), 'utf8').replace(/\r\n/g, '\n');
      const re = new RegExp(`onMessage\\(\\s*'${ev}'`);
      const m = re.exec(src2);
      if (!m) {
        throw new Error(`gate-selfcheck: 找不到 onMessage('${ev}') —— 锚点自取失败,用例等于不存在`);
      }
      /* 取该 handler 的最后一条语句(拒绝守卫)整行,在它后面插一行成功执行 */
      const lines2 = src2.split('\n');
      const li = src2.slice(0, m.index).split('\n').length - 1;
      let guardLine = '';
      for (let k = li; k < li + 12; k += 1) {
        if (/!\w+\.allowed/.test(lines2[k] ?? '')) { guardLine = lines2[k]!; break; }
      }
      if (guardLine === '') {
        throw new Error(`gate-selfcheck: ${ev} 的拒绝守卫行未找到`);
      }
      const indent = guardLine.match(/^\s*/)![0];
      c.from = guardLine + '\n';
      c.to = guardLine + '\n' + indent + 'this.runtime.__probeExecute__();' + '\n';
    }
    if (c.mark === 'orphan-subset') {
      /* 插入一个必然可达的模块 —— 它不在 UNREACHABLE_EXEMPT 里,
         于是触发「是 orphan 却不在可达性白名单 —— 两套判据矛盾」 */
      c.from = rowText;
      c.to = injectRow + rowText;
    } else if (c.mark === 'orphan-blank-reason') {
      c.from = rowText;
      c.to = badRow;
    }
  }
  console.log(`  · 锚点自取:orphan-audit.ts 的「${path}」(缩进 ${ind.length} 空格)\n`);
}
resolveAnchors();

/* ═══════════════════════ 执行 ═══════════════════════ */

/**
 * 一份**新的**整树副本(`%TEMP%/cp_selfcheck_*`),跑完由调用方 `dropLab` 删除。
 *
 * ## 为什么不再用「全局单例 lab」
 * 原实现是 `let lab: string | null` 单例 + 无参 `dropLab()`,等价于**串行**:
 * 同一时刻只有一份副本可用。串行 × 30 个用例 × (副本 ~1.0s + `verify --frozen` ~5.4s)
 * ⇒ 实测 163s;机器一有负载就突破 `checkGateSelfcheck` 那一侧的超时(表现为
 * `门禁自检失败(exit=null)`:子进程被 kill)。
 * ⇒ 改成**每用例一份**,于是用例可以并发(见文件末的 worker 池)。
 */
function makeLab(): string {
  const d = mkdtempSync(join(tmpdir(), 'cp_selfcheck_'));
  cpSync(ROOT, d, {
    recursive: true,
    filter: (s) => !/[/\\](\.git|node_modules|_shots|_design|_cdp_profile)([/\\]|$)/.test(s),
  });
  return d;
}
function dropLab(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 副本删不掉不影响结论 */ }
}

interface RunResult { exit: number; fails: string[]; out: string }

/** 单次 `verify` 的墙钟预算(卡死时明确报「超时」,而不是静默等到外层超时)。 */
const VERIFY_TIMEOUT_MS = 600_000;

/**
 * 在 `labRoot` 里跑 `verify.ts` —— **异步** spawn(并发的前提)。
 * ⚠️ 不能用 `spawnSync`:`--jobs` 并发时它会把事件循环钉住,退化成串行。
 */
function runVerifyIn(labRoot: string, args: string[]): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    const ch = spawn(process.execPath, ['scripts/verify.ts', ...args], {
      cwd: labRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL'); }, VERIFY_TIMEOUT_MS);
    ch.stdout?.setEncoding('utf8');
    ch.stderr?.setEncoding('utf8');
    ch.stdout?.on('data', (s: string) => { out += s; });
    ch.stderr?.on('data', (s: string) => { out += s; });
    ch.on('error', (e: Error) => { out += `\n[spawn error] ${e.message}\n`; });
    ch.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (timedOut) out += `\n[超时] verify 超过 ${VERIFY_TIMEOUT_MS} ms 被 kill\n`;
      else if (signal !== null) out += `\n[被信号 ${signal} 终止]\n`;
      done({
        exit: code ?? -1,
        fails: out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim()),
        out,
      });
    });
  });
}

/** 一次性用例(基线):自建一份副本,跑完即删。 */
async function runVerify(args: string[]): Promise<RunResult> {
  const d = makeLab();
  try {
    return await runVerifyIn(d, args);
  } finally {
    dropLab(d);
  }
}

/**
 * 并发路数:`--jobs N`;不传则 `min(8, max(2, CPU−1))`。上限 16 —— 再高只是让 8 个
 * `verify` 互相抢 CPU,而每个 `verify` 自己已经是串行。
 *
 * ★ 2026-11-22(**2 核**机器实测):本函数只回答「几路」,**它自己不是** 2 核超时的修点。
 * 两个恒定(都是**别人的**预算,不许为了迁就机器改):
 *   · `verify.ts#VERIFY_TIMEOUT_MS = 600_000` —— 自检内**每条用例**子进程的预算;
 *   · `verify.ts#SELFCHECK_TIMEOUT_MS = 900_000` —— 外层 `verify --all` 给**整个自检**的预算。
 * 2 核上两条 `--integration`(各 **296 s**)并发 ⇒ 互相争用 ⇒ 各自 ~600 s ⇒ 撞穿前者
 * (自检里报 `spawn error … ETIMEDOUT`,N1 的两条消息断言拿不到结论);
 * 而把路数压成 **1** 之后,自检总时长 ~1380 s ⇒ 反过来撞穿后者。
 * ⇒ 修法是**调度的形状**,不是路数:本函数维持 `max(2, CPU−1)`,
 *   **长作业在核数 < 3 时走专线串行**(见 `[并发]` 段的分道逻辑)。
 *   判据 / 期望值 / 超时常量一律未动。
 */
function resolveJobs(): number {
  const auto = Math.min(8, Math.max(2, cpus().length - 1));
  const i = process.argv.indexOf('--jobs');
  if (i < 0) return auto;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`gate-selfcheck: --jobs 需要正整数(收到 ${String(process.argv[i + 1])})`);
  }
  return Math.min(n, 16);
}

/**
 * 「本用例新引入的失败」= 本用例输出的 ✗ 行中,**基线里没有的**那些。
 *
 * ## 为什么必须做差值而不是看绝对红绿(本轮踩到的坑)
 *
 * 第一版用 `r.fails.length > 0` 判定「红」。这在**多人并行**时不可靠:
 * 队友在飞的改动会让基线本身就有 ✗(实测:`WS-10.test.ts` 被队友改了,
 * 导致同义反复白名单失真 —— 与可达性毫无关系)。
 * 于是:
 *   · 退化 `D3`(把 `matchAll` 退回 `exec`)时,verify **仍然**因为队友那两条红,
 *     差值判定若只看绝对红绿就会误判「D3 用例通过了」—— 而影子行其实**没有被抓到**。
 *     实测证据:退化后输出里**完全没有**「影子行」这条 ✗。
 *   · 同理,摘掉客户端入口后仍有 1 条队友的红,绝对判定也会误判。
 *
 * ⇒ 判定必须相对基线。这样即使树上有别人制造的红,本用例的结论依然有效。
 */
function deltaFails(caseFails: string[], baseFails: string[]): string[] {
  const base = new Set(baseFails);
  return caseFails.filter((f) => !base.has(f));
}

const only = ((): string | undefined => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

/* ⚠️ 计数器必须在这里声明:T33(下方)在用例表**之外**先跑并自增它们。
   我曾把这两行留在表循环之前 —— 那在 T33 之后,`const` 的 TDZ 会让 T33 抛错。
   ⇒ **顺序是承重的**,不要因为"看着更整齐"往上/往下挪。 */
let failures = 0;
let passed = 0;

/* ── T33:`import` 守卫(防无限递归)—— 在用例表**之外**单独跑 ──
 *
 * ## 为什么它不能写成表里的一条 `Case`
 *
 * 表里每条用例的形态是「改文件 → 跑 verify → 看红绿」。而本条的期望是
 * **「import verify.ts 不产生任何输出」**,它要跑的不是 `runVerify`(那是 `node` 直接执行),
 * 而是 `import()` —— **动作不同**。硬塞进表里会把「探针改了内容」与
 * 「import 无输出」两件事混进同一个判定,反而说不清。
 *
 * ## 它守的是什么
 *
 * build-wiring 的故障注入**意外触发过两次无限递归**(合计 122 个 node 进程):
 * ```
 * 某模块 import verify.ts ⇒ verify.ts 顶层执行 ⇒ runTests() 无条件 spawn 全部测试
 *   ⇒ 被 spawn 的测试又 import 那个模块 ⇒ **递归**
 * ⚠️ 超时拦不住(每层都在 spawn 新进程)
 * ```
 * ⇒ 修法是在根因处加 `if (import.meta.main)` 守卫(见 verify.ts 该处长注释)。
 *
 * ⚠️ **这条检查必须存在**:守卫一旦被删(比如有人觉得 `import.meta.main` 是冗余),
 * 递归缺陷**立刻回来**,而**没有任何别的检查会报红** ——
 * 因为递归的表现是进程爆炸,不是一条可读的失败行。
 * ⇒ 这正是 build-wiring 报告的形态:「那条预防性断言没有机会报红」。
 *   **⇒ 所以要在外面再包一层检查,专门验证那个守卫还在。**
 */
{
  console.log('\n[T33] `import verify.ts` 不得执行门禁(防无限递归的守卫还在吗)');
  /* ⚠️ 必须用**子进程 + 硬超时**:若守卫已失效,这个 import 会跑整个门禁
     (含 spawn 全部测试),`-e` 里直接 await 会把自检本身卡死。 */
  const probe
    = "import('./scripts/verify.ts').then("
      + "() => { process.stdout.write('IMPORT_OK'); },"
      + " (e) => { process.stdout.write('IMPORT_ERR:' + String(e && e.message).slice(0, 60)); });";
  const r = spawnSync(process.execPath, ['-e', probe], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
  });
  const out = `${r.stdout ?? ''}`;
  /* 判据:import 成功,且 stdout **没有**门禁的特征输出。 */
  const imported = out.includes('IMPORT_OK');
  const ranGate = /生产可达性|入口可加载性|全部通过|项失败|冻结层不变量/.test(out);
  const guarded = imported && !ranGate;
  const timedOut = r.error !== undefined && r.error !== null;
  console.log(`  子进程 exit=${r.status} 超时=${timedOut ? '**是**' : '否'}`);
  console.log(`  import 成功:${imported ? '✓' : '✗'};  含门禁输出:${ranGate ? '**是**' : '否'}`);
  if (guarded) {
    console.log('  ⇒ ✓ 守卫有效(import 只导出、不执行)');
    passed += 1;
  } else {
    console.log('  ⇒ ✗✗ 守卫失效 —— `import.meta.main` 包裹可能被删掉了');
    console.log('     一旦失效,任何 import verify.ts 的模块都会**无限递归 spawn**(超时拦不住)');
    failures += 1;
  }
}

/* ⚠️ T33 **不得在这里打印汇总** —— 用例表(下方)还没跑。
   我第一版在这里加了一行汇总,于是自检打出**两个**结论:
   「✓ 全部通过(1 通过 / 1 合计)」和真正的「(28 通过 / 28 合计)」。
   ⇒ 两个都读作「全部通过」时不会有人发现,但**一个绿一个红时必被误读**。
   ⇒ 汇总只在**文件末尾**打印一次。 */

/* ── T35:「判据形态审计」的接线是否有牙(防恒真门禁)──
 *
 * ## 为什么必须单独守它
 *
 * `verify.ts` 新接了一道 `checkJudgementAudit()`(跑 `judgement_audit.ts --baseline`)。
 * **一个永远 exit 0 的脚本也是绿的** —— 所以「它跑了、汇总绿了」**不构成任何证据**。
 * ⇒ 唯一有效的证明是:**往登记表之外注入 1 处新命中,门禁必须红**。
 * ⇒ 这正是我对 build-wiring 的要求,也是我在 `verify.ts` 那段注释里写下的承诺。
 *
 * ## 动作序列
 * ```
 * 1 在 tests/ 下**新建**一个临时文件,内含一处 D 形态(对原文跑 match 计数)
 *    ⚠️ 必须**新建**,不能改既有文件 —— 改既有文件会与别的用例互相干扰,
 *      且万一没还原干净就是给别人留坑
 * 2 跑 `node scripts/judgement_audit.ts --baseline` ⇒ 期望 exit 1 且输出「新增」
 * 3 删临时文件 ⇒ 再跑一次 ⇒ 期望 exit 0 且「新增 0 处」
 * ⇒ **两端都要验**:只验第 2 步证明不了它在干净时不会误报;
 *   只验第 3 步证明不了它有牙。**两个方向都绿才是真结论。**
 *
 * ## ⚠️ 不用 inject.ts 的原因
 *
 * `scripts/inject.ts` 是 build-wiring 的注入器,它**改既有文件**。
 * 本条只需要「加一处新命中」,**新建文件**是更小、更安全、无还原风险的做法。
 * ⇒ 用最轻的手段达成就行,不必为了复用工具而引入改文件的还原风险。
 */
{
  console.log('\n[T35] 「判据形态审计」接线是否有牙(注入 1 处新命中必须红)');
  /* ⚠️ **必须在 lab 里造**,不能写进真仓库 —— 本脚本全套设计的前提是
     「绝不碰真仓库:把整棵树复制到 %TEMP%」。
     我第一版写的是 `join(ROOT, 'tests', ...)` ⇒ 那会在**真仓库**里创建文件。
     即使 finally 会删,「在真仓库里创建文件」本身就违反本脚本自己的第 1 条铁律。
     ⇒ 用 `makeLab()`(它已复制整棵树)⇒ 一切都发生在临时副本里。 */
  const labRoot = makeLab();
  /* ★★★ 2026-11-13 修(Lead):文件名**不能**以 `_` 开头 —— 探针会被静默跳过
   *
   * ```
   * judgement_audit.ts:1650
   *   .filter((f) => !rel(f).split('/').some((seg) => seg.startsWith('_')));
   * ⇒ 它**刻意**跳过 `_` 前缀路径(理由见该处注释:.gitignore:37 把 `_` 声明为非交付物)
   * ⇒ 而本用例原先把探针命名成 `__T35_PROBE.test.ts`
   *   ⇒ 「文件数:140」注入前后**一模一样**(实测)
   *   ⇒ 探针**从未被扫描** ⇒ A 计数 1→1 ⇒ 判成「接线没牙 ✗」
   * ```
   * ⇒ ⇒ ★★★ 这是**假阴性**:判据(judgement_audit)是好的,是**探针被过滤掉了**。
   *   而它的表现与"接线没牙"**完全一致**(注入后仍绿)—— 两种解释:
   *     ① 判据没牙  ② 注入没生效
   *   本仓把这一对写进过陷阱 31「注入不生效 ≠ 判据没牙」,
   *   而**此用例自己就踩了它**,且因为报出的结论"听起来对"而长期没被发现。
   *
   * ★ 为什么会这样:原命名者按本仓的**通用**约定("临时探针一律用 `_` 前缀")
   *   来命名 —— 那条约定在**大多数**工具那里是对的(clean-temp 会清掉它们),
   *   但**对 judgement_audit 恰好相反**:它就是靠这个前缀来排除非交付物的。
   *   ⇒ ⇒ 教训:**"用 `_` 前缀"不是全局规则,它是一条**局部**约定;
   *     凡是要"让某工具看见"的探针,必须先确认该工具**不跳过 `_`。**
   * ⇒ 修法:改名成 `T35_PROBE.test.ts`(**不带下划线**)。
   *   ⚠️ 副作用检查:`makeLab()` 是临时副本 ⇒ 探针在副本里,
   *     不会落进真仓库 ⇒ 不影响 `clean-temp.ts` 的残留口径。
   *     而 `finally` 里仍按新名字删除。 */
  const labFile = join(labRoot, 'tests', 'T35_PROBE.test.ts');
  const runAudit = (): { exit: number; added: number; listed: boolean; out: string } => {
    const r = spawnSync(process.execPath, ['scripts/judgement_audit.ts', '--baseline'], {
      cwd: labRoot, encoding: 'utf8', timeout: 180_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const m = out.match(/其中\s*\*{0,2}新增\s*(\d+)\s*\*{0,2}\s*处/);
    return { exit: r.status ?? -1, added: m === null ? -1 : Number(m[1]), listed: /\[新增\]/.test(out), out };
  };
  try {
    const before = runAudit();
    const baseClean = before.added === 0;
    console.log(`  注入前:exit=${before.exit} 新增=${before.added < 0 ? '**解析不到**' : String(before.added)}`);

    /* 造一处 **A 形态**:键提取正则只认 `(\w+):`,没有配套的「简写属性」分支。
       ⚠️ 我第一版造的是「对原文跑 match 计数」(以为那是 D 形态)⇒ **D 检测器报 0**。
       实测校准:改用 A 形态 —— 它就是 DET_A 的 `dirty` 样本本身。
       ⇒ 「注入不生效」与「判据没牙」必须区分开(陷阱 31),这里是我自己先撞上的。 */
    writeFileSync(
      labFile,
      [
        '/* T35 探针 —— gate-selfcheck 在临时副本里创建,跑完即删。 */',
        'export function keysOf(body: string): string[] {',
        '  return [...body.matchAll(/^\\s*(\\w+):/gm)].map((m) => m[1]!);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const after = runAudit();
    console.log(`  注入后:exit=${after.exit} 新增=${after.added < 0 ? '**解析不到**' : String(after.added)} 列出位置=${after.listed ? '✓' : '✗'}`);

    const teeth = baseClean && after.exit !== 0 && after.added > 0 && after.listed;
    if (teeth) {
      console.log('  ⇒ ✓ 有牙:注入前 0 新增/exit 0;注入后 >0 新增/exit 非 0 **并指出位置**');
      passed += 1;
    } else if (!baseClean) {
      console.log('  ⇒ ✗✗ 注入前就有新增 ⇒ 登记表已不全,本条的对照不成立');
      console.log('     (这不是「接线没牙」,而是「基线不干净」—— 两者要分开报)');
      failures += 1;
    } else {
      console.log('  ⇒ ✗✗ **接线没牙** —— 注入了新命中却没红');
      console.log('     这正是「恒真门禁」:跑了、绿了、什么都没查。');
      failures += 1;
    }
  } finally {
    try { if (existsSync(labFile)) rmSync(labFile, { force: true }); } catch { /* 忽略 */ }
    const restored = !existsSync(labFile);
    /* ⚠️ 真仓库里**本来就不该有**这个文件 —— 一并自证没污染真仓库。
       ★ 两个名字都查:因为历史版本用过 `__T35_PROBE.test.ts`,
         若某次运行中途死掉,可能在真仓库里留下**旧名字**的残留。 */
    const realClean = !existsSync(join(ROOT, 'tests', 'T35_PROBE.test.ts'))
      && !existsSync(join(ROOT, 'tests', '__T35_PROBE.test.ts'));
    console.log(`  还原:临时副本已清=${restored ? '✓' : '✗✗'}  真仓库未被污染=${realClean ? '✓' : '✗✗ **污染了真仓库!**'}`);
    if (!restored || !realClean) failures += 1;
  }
  dropLab(labRoot);
}

/* ── 基线:干净副本 ──
   若基线有红(通常是队友在飞的改动),**不中止**,而是把它当作差值基准 ——
   见 `deltaFails` 的说明。这样本脚本在多人并行时依然能给出有效结论。 */
const base = await runVerify(['--frozen']);
console.log('[自检基线] 干净副本 --frozen');
if (base.fails.length > 0) {
  console.log(`  · 基线有 ${base.fails.length} 条红(可能是队友在飞的改动)—— 后续判定改用**差值**:`);
  base.fails.slice(0, 5).forEach((f) => console.log(`      ${f.slice(0, 165)}`));
} else {
  console.log(`  ✓ 基线绿(${base.exit === 0 ? 'exit 0' : `exit ${base.exit}`})`);
}

/* ── 逐条用例:并发执行(`--jobs`,默认 `min(8, CPU−1)`)──
 *
 * ## 为什么必须并发(2026-11-18 实测)
 * ```
 * 串行(旧实现):30 个用例 × (整树副本 ~1.0s + `verify --frozen` ~5.4s)
 *   ⇒ 实测 163s;而**默认口径改成「自检真跑」之后**,两个「必须跑全量口径」的用例
 *     还会在副本里再 spawn 一次门禁自检 ⇒ 递归(见 `Case.labSetup`)。
 *   ⇒ 机器一有负载就突破 `checkGateSelfcheck` 那一侧的超时,表现是
 *     `门禁自检失败(exit=null)` —— 子进程被 kill,而不是自检报红。
 * ```
 * ⇒ 每条用例本来就跑在**自己的整树副本**里(见 `makeLab`),用例之间没有共享可写状态
 *   ⇒ 并发是**语义等价**的加速:墙钟从 Σ 变成 max。
 * ⚠️ 不能用 `spawnSync`:它会把事件循环钉住,并发随即退化成串行(见 `runVerifyIn`)。
 */
interface CaseOutcome { failed: boolean; lines: string[] }

/** 跑一条用例:独占一份副本,跑完即删。 */
async function runCase(c: Case, baseFails: string[]): Promise<CaseOutcome> {
  const lines: string[] = [];
  const labRoot = makeLab();
  try {
    /* 用例可自带**副本改造**(见 `Case.labSetup`)。 */
    if (c.labSetup !== undefined) c.labSetup(labRoot);
    const p = join(labRoot, c.file);
    if (!existsSync(p)) {
      lines.push(`\n[${c.group}] ${c.name}\n  ✗ 探针无效:${c.file} 不存在`);
      return { failed: true, lines };
    }
    const src = readFileSync(p, 'utf8');
    /* `from` 可为函数:从当前文件内容里**自取**锚点,避免写死的锚点随
       白名单收缩而失效(见接口注释)。
       ⚠ 必须区分两种"空":
         · `from: ''`(字面空串)= **有意不改**,合法(有些用例只断言消息)
         · `from` 是函数却返回空 = **解析器失效**,必须报错,否则会退化成
           「跑了个空操作还判通过」的假证据。
       初版把两者混为一谈,于是 3 个 `from: ''` 的用例被误报"探针失效" ——
       这正是本脚本自身最该防的那类错误。 */
    const isDerived = typeof c.from === 'function';
    const fromText = isDerived ? (c.from as (s: string) => string)(src) : (c.from as string);
    if (isDerived && fromText === '') {
      lines.push(`\n[${c.group}] ${c.name}\n  ✗ 探针失效:锚点解析器返回空串(清单可能已空)`);
      return { failed: true, lines };
    }
    let probeOk = true;
    if (fromText !== '') {
      const { n, normalized } = countAnchor(src, fromText);
      if (n !== 1) {
        /* 区分两种成因 —— 这是本脚本存在的理由(「探针失效」不等于「门禁失职」)。
           0 命中时明说"是不是换行不一致",否则读者会按"锚点过期"去修错地方。 */
        const diag = n === 0
          ? (normalized
            ? '\n    ⚠ 归一化换行后仍命中 0 ⇒ 锚点**真的**不在了(不是 CRLF 问题)'
            : '\n    ⚠ 但归一化换行后命中 >0 ⇒ 这是**换行不一致**(core.autocrlf=true),不是锚点过期')
          : '';
        lines.push(`\n[${c.group}] ${c.name}\n  ✗ 探针无效:锚点命中 ${n} 次(需恰好 1 次)${diag}`);
        return { failed: true, lines };
      }
      /* ★ 用 findAnchor 定位后按**下标**替换 —— 不再用 src.replace(fromText, ...),
         因为锚点在 CRLF 文件里可能是归一化后才命中的,那时 replace 会找不到。 */
      const hit = findAnchor(src, fromText);
      if (!hit) {
        lines.push(`\n[${c.group}] ${c.name}\n  ✗ 探针失效:定位到锚点但无法切回原文本(换行映射错)`);
        return { failed: true, lines };
      }
      /* ★ 注入文本也要**跟随目标文件的换行风格** —— 否则往 CRLF 文件里塞一段 LF,
         副本就成了混行文件。副本随后要跑真门禁,混行会让 `\n` 锚点类检查
         时灵时不灵(正是本函数要修的那个坑的同族)。 */
      const crlfFile = (src.match(/\r\n/g) ?? []).length > (src.match(/(?<!\r)\n/g) ?? []).length;
      const toText = crlfFile ? c.to.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : c.to.replace(/\r\n/g, '\n');
      writeFileSync(p, src.slice(0, hit.at) + toText + src.slice(hit.at + hit.len), 'utf8');
      /* 自证:读回确认内容真的变了 —— 防「空操作探针」假证据 */
      if (readFileSync(p, 'utf8') === src) probeOk = false;
    }

    const args = c.args ?? [];
    const r = await runVerifyIn(labRoot, args);
    /* **差值判定**:只看本用例新引入的 ✗,忽略基线就有的(队友在飞的改动)。
       见 `deltaFails` 的说明 —— 用绝对红绿会在多人并行时给出错误结论。 */
    const newFails = deltaFails(r.fails, baseFails);
    const isRed = newFails.length > 0;
    const verdictOk = c.expect === 'any' ? true : (c.expect === 'red') === isRed;
    const msgOk = c.wantMsg === undefined || c.wantMsg.test(r.out);
    const notOk = c.notMsg === undefined || !c.notMsg.test(r.out);
    /* expect:'any' 的用例必须至少给一个消息断言,否则它什么也没测。 */
    const anyHasMsg = c.expect !== 'any' || c.wantMsg !== undefined || c.notMsg !== undefined;

    lines.push(`\n[${c.group}] ${c.name}`);
    lines.push(`  探针:${c.from === '' ? '(无需变异)' : probeOk ? '✓ 内容已变' : '✗ 空操作!'}`);
    lines.push(`  verify ${args.join(' ') || '(无 flag)'} → exit ${r.exit},`
      + `fail ${r.fails.length}${baseFails.length > 0 ? `(基线 ${baseFails.length} ⇒ 新增 ${newFails.length})` : ''}`);
    lines.push(`  期望 ${c.expect === 'any' ? '只断言消息' : c.expect === 'red' ? '红' : '绿'}`
      + ` ⇒ ${verdictOk ? '✓ 符合' : '✗✗ 不符'}${
        c.wantMsg ? msgOk ? ';命中预期消息 ✓' : ';消息未命中 ✗' : ''}${
        c.notMsg ? notOk ? ';已消失预期消息 ✓' : ';不该出现的消息仍在 ✗' : ''}`);

    const okAll = verdictOk && msgOk && notOk && probeOk && anyHasMsg;
    if (okAll) {
      /* 红的时候把**新增的**那条打印出来,作为「有牙齿」的证据 */
      if (c.expect === 'red') newFails.slice(0, 2).forEach((f) => lines.push(`      ${f.slice(0, 165)}`));
    } else {
      newFails.slice(0, 5).forEach((f) => lines.push(`      新增: ${f.slice(0, 165)}`));
      if (c.expect === 'red' && newFails.length === 0) {
        lines.push('      ⚠️ 门禁没有**新增**红 —— 这条检查是恒真的(或探针打偏了)');
      }
      if (!notOk) lines.push(`      ⚠️ 出现不该出现的消息:${String(c.notMsg)}`);
    }
    return { failed: !okAll, lines };
  } finally {
    dropLab(labRoot);
  }
}

const active: Case[] = only === undefined ? CASES : CASES.filter((c) => c.group === only);

/**
 * 一条用例的**口径成本**(只作调度键,不影响判定)。
 *
 * ## 为什么需要它(2026-11-18 实测)
 * 并发路数固定时,墙钟 ≈ 「轮数 × 每轮最慢的那一条」。而本表的成本差一个数量级:
 * ```
 * --frozen         ~8s   (20 条)
 * --only WS-01    ~13s   (D4)
 * --docs          ~18s   (T38 两条)
 * --content       ~22s   (D5)
 * 默认口径         ~26s   (D3,全量 runTests)
 * --all --frozen   ~0s   (N2:参数冲突,立即退出)
 * ```
 * 按用例表顺序发车 ⇒ 慢用例排在后面、每轮都被它拖住:实测 28 条 / 8 路 = **100s**。
 * ⇒ **长作业优先**(LPT):按成本降序发车,墙钟由「最后一条长的」决定。
 * ⚠️ 它只是**排序键**:判据、期望值、明细的打印顺序都不受影响。
 */
function caseCost(c: Case): number {
  const a = (c.args ?? []).join(' ');
  if (a === '') return 5;                  /* 默认口径(D3:全量 runTests) */
  if (a.includes('--all')) return 0;       /* N2:参数冲突 ⇒ 立即退出 */
  if (a.includes('--only')) return 4;      /* 单套件(D4) */
  if (a.includes('--content')) return 4;   /* 内容锁(D5) */
  if (a.includes('--docs')) return 3;      /* 文档(T38) */
  if (a.includes('--integration')) return 6; /* ★ 实测单条 **296 s** —— 原值 3 把它排在默认全量 runTests(:5)后面,与「长作业优先」正好相反 */
  return 1;                                /* --frozen(大多数) */
}

const jobs = resolveJobs();
/* 发车顺序(元素是 `active` 的下标);明细仍按 `active` 原顺序打印。 */
const order: number[] = [...active.keys()]
  .sort((x, y) => caseCost(active[y] as Case) - caseCost(active[x] as Case));

/* ★ 2026-11-22(2 核实测):**长作业在核数不足时必须走专线串行**。
   `--integration` 单条 **296 s**,它会把整机吃掉;两条并发 ⇒ 各自 ~600 s ⇒ 各自撞穿
   `verify.ts#VERIFY_TIMEOUT_MS`(600 s)⇒ 自检整体 `spawnSync … ETIMEDOUT`。
   ⚠️ 把**并发数**压成 1 是**错的**修法:自检总时长会 ~1380 s ⇒ 反过来撞穿
   `verify.ts#SELFCHECK_TIMEOUT_MS`(900 s)。两个常量都不许为迁就机器改。
   ⇒ 形状改成「1 条长作业专线(串行)+ 其余 `jobs−1` 路跑短作业」;
      **核数 ≥ 3 时**两条长作业各占不满一核 ⇒ 维持原样的单队列,行为一字不变。 */
const isLongCase = (i: number): boolean =>
  ((active[i] as Case).args ?? []).join(' ').includes('--integration');
const serialLong = cpus().length < 3;
const longQueue: number[] = serialLong ? order.filter(isLongCase) : [];
const shortQueue: number[] = serialLong ? order.filter((i) => !isLongCase(i)) : order;
const shortLanes = serialLong ? Math.max(0, jobs - 1) : jobs;
console.log(`\n[并发] ${active.length} 个用例 / ${jobs} 路(每用例一份独立副本;长作业优先)`
  + (serialLong
    ? ` · ${longQueue.length} 条长作业走**专线串行**(核数 ${cpus().length} < 3)`
    : ''));
const outcomes: CaseOutcome[] = new Array(active.length);
const spent: number[] = new Array(active.length).fill(0);
const startedAt = Date.now();
let seq = 0;
/** 跑一条用例并打印进度行。串行 `await` 是**有意**的:一路 worker 一次只占一份副本。 */
const runOne = async (i: number): Promise<void> => {
  const c = active[i] as Case;
  const at = Date.now();
  const oc = await runCase(c, base.fails);
  outcomes[i] = oc;
  spent[i] = Date.now() - at;
  seq += 1;
  console.log(`  · [${String(seq).padStart(2, ' ')}/${order.length}] `
    + `${oc.failed ? '✗' : '✓'} ${((spent[i] as number) / 1000).toFixed(1)}s ${c.group} — ${c.name}`);
};
/** 抽干一条队列。★ 游标**按队列共享**(多条车道跑同一队列时不能各跑全量)。 */
const cursors = new Map<number[], { n: number }>();
const drain = async (queue: number[]): Promise<void> => {
  let cur = cursors.get(queue);
  if (cur === undefined) {
    cur = { n: 0 };
    cursors.set(queue, cur);
  }
  for (;;) {
    const k = cur.n;
    cur.n += 1;
    if (k >= queue.length) return;
    await runOne(queue[k] as number);
  }
};
const lanes: Array<Promise<void>> = [];
if (serialLong) {
  lanes.push((async () => {
    await drain(longQueue);
    /* `--jobs 1`(或单核)时短作业也归这条专线 ⇒ 全局并发仍是 1。 */
    if (shortLanes === 0) await drain(shortQueue);
  })());
}
for (let i = 0; i < shortLanes; i += 1) lanes.push(drain(shortQueue));
await Promise.all(lanes);
console.log(`  并发总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

/* 明细按**用例表顺序**打印 —— 并发只改墙钟,不改结论的确定性。 */
console.log('\n═══ 逐条明细(按用例表顺序)═══');
for (let i = 0; i < active.length; i += 1) {
  const oc = outcomes[i] as CaseOutcome;
  for (const l of oc.lines) console.log(l);
  if (oc.failed) failures += 1;
  else passed += 1;
}

console.log(`\n${failures === 0 ? '✓ 门禁自检全部通过' : `✗ 门禁自检 ${failures} 项未通过`}`
  + `(${passed} 通过 / ${passed + failures} 合计)`);
if (failures > 0) process.exitCode = 1;
