/**
 * 判据审计的**已知命中登记表**。
 *
 * ## 这个文件为什么存在
 *
 * `scripts/judgement_audit.ts` 扫出的是「**疑似**形态」,不是「缺陷」。
 * 逐条定性之后,大部分是:**真实但无害**、**假阳性**、或**已挂 CR 暂不修**。
 * 若让门禁对「命中数 > 0」直接报红,接进门禁当天就会全红
 * ⇒ 没人会去看,登记表反而失效。
 *
 * ⇒ 门禁只该对「**超出登记表的新增命中**」报红
 *   —— 与仓库既有的一串登记表(`ENTRY_LOAD_EXEMPT` / 装饰器计数 / 白名单)同模式。
 *
 * ## 维护规则(重要)
 *
 * ```
 * ① 新增命中 ⇒ 先逐条定性,再决定:修 / 登记 / 删检测器
 * ② 登记项必须写 reason —— 只写「已知」等于没写:
 *    下一个人无法判断它是「已定性无害」还是「被忽略了」
 * ③ 修掉一处 ⇒ 从表里删掉,并确认总数下降(否则说明修错了地方)
 * ④ 编号用「检测器 + 文件 + 关键片段」,不用行号 —— 行号会飘
 * ```
 *
 * ⚠️ 与 `verify.ts` 的关系:本表由 `judgement_audit.ts --baseline` 消费。
 * 门禁接线在 `verify.ts`(task-62,Lead 的写域)。
 */

/** 一条已定性的命中。 */
export type BaselineEntry = {
  /** 检测器编号 A~G */
  detector: string;
  /** 仓库相对路径 */
  file: string;
  /** **行的关键片段**(用于匹配,避免行号飘移造成假「新增」) */
  needle: string;
  /**
   * 定性结论。
   *
   * `启发式候选` 是候选型检测器(G)专用 —— 与前几类的区别是**语义**的:
   * ```
   * 已定性无害 / 假阳性   ⇒ 已经看过,确认它**不是**问题
   * 挂账待修              ⇒ 已经看过,确认它**是**问题但本轮不修
   * 潜伏(当前无触发)     ⇒ 形态存在但当前不触发
   * 启发式候选(G)        ⇒ **还没逐对看**,只标记"这处配对在 G 出生时就存在"
   * ```
   */
  verdict: '已定性无害' | '假阳性' | '挂账待修' | '潜伏(当前无触发)' | '启发式候选';
  /** 处置理由 —— 必填,写清「为什么不修」 */
  reason: string;
};

export const JUDGEMENT_BASELINE: readonly BaselineEntry[] = [
  /* ─────────── A:键提取漏简写属性(1 处)─────────── */
  {
    detector: 'A',
    file: 'tests/WS-07.test.ts',
    needle: "matchAll(/(\\w+)\\s*:\\s*'([^']+)'/g)",
    verdict: '已定性无害',
    reason:
      '提取对象是**测试内联的字面映射表**(7 个键全部写成长形式 `k: v`),'
      + '没有简写属性 ⇒ 漏简写在本例不产生少收。'
      + '且该处紧随 `eq(pairs.length, 7)` 断言总数,少收会**立刻变红**。'
      + '⇒ 有独立的数量断言兜底,判定无害。',
  },

  /* ─────────── B:剥注释缺 [^:] 防护(7 处,全部挂账)─────────── */
  {
    detector: 'B',
    file: 'scripts/deadcode-audit.ts',
    needle: '.replace(/\\/\\/[^\\n]*/g, \'\');',
    verdict: '挂账待修',
    reason: '与 `stripCommentsOnly` 配对使用,而该处剥注释**只服务于标识符扫描**,不解析 URL/路径字符串 ⇒ 当前无触发点。挂 CR-18 同批处理(见本文件末「B 形态专项说明」)。',
  },
  {
    detector: 'B',
    file: 'tests/WS-07.test.ts',
    needle: '.replace(/\\/\\/[^\\n]*/g, \' \');',
    verdict: '挂账待修',
    reason: '同上。该文件里 4 处 B 形态均为「剥注释后做包含式字符串查找」,被扫文本是**源码**而非 URL 所在字符串 ⇒ 当前无触发点。挂 CR-18。',
  },
  {
    detector: 'B',
    file: 'tests/WS-07.test.ts',
    needle: 'roomSrc.replace(/\\/\\*[\\s\\S]*?\\*\\//g, \'\').replace(/\\/\\/',
    verdict: '挂账待修',
    reason: '同上(WS-07 第 2 处)。挂 CR-18。',
  },
  {
    detector: 'B',
    file: 'tests/WS-07.test.ts',
    needle: 'idx.replace(/\\/\\*[\\s\\S]*?\\*\\//g, \'\').replace(/\\/\\/',
    verdict: '挂账待修',
    reason: '同上(WS-07 第 3 处)。挂 CR-18。',
  },
  {
    detector: 'B',
    file: 'tests/WS-07.test.ts',
    needle: 'room.replace(/\\/\\*[\\s\\S]*?\\*\\//g, \'\').replace(/\\/\\/',
    verdict: '挂账待修',
    reason: '同上(WS-07 第 4 处)。挂 CR-18。',
  },
  {
    detector: 'B',
    file: 'tests/WS-11.test.ts',
    needle: '.replace(/\\/\\/[^\\n]*/g, \'\')',
    verdict: '挂账待修',
    reason: '同上。挂 CR-18。',
  },
  {
    detector: 'B',
    file: 'tests/WS-FND-09-wiring.test.ts',
    needle: 'src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, \' \').replace(/\\/\\/',
    verdict: '挂账待修',
    reason:
      'task-57 我自己的文件。该 strip 只用于「找 import 路径」的**包含式**扫描,'
      + '而被扫对象是本仓源码(不含 URL 字面量)⇒ 当前无触发点。'
      + '⚠️ 但**同一文件另有 FND9-2 依赖字符串内容**,若将来有人把它换成 '
      + '`stripCommentsAndStrings` 会**静默变成恒真** —— 该风险已由 FND9-14 的'
      + '单一来源断言看住。挂 CR-18。',
  },

  /* ─────────── C:import 探测只认 from(10 处)─────────── */
  {
    detector: 'C',
    file: 'scripts/verify.ts',
    needle: 'code2.matchAll(/from\\s+[\'"](\\.',
    verdict: '已定性无害',
    reason:
      '这是 **import-no-ext 检查**专用的解析,不是依赖图提取:'
      + '它要找的是「写了相对路径但漏了 .ts 扩展名」的**违规**。'
      + '裸副作用导入与动态导入在此处**不是漏检**:它们的路径若缺扩展名,'
      + '由 `imports.ts`(0962c69 抽出的单一事实来源)在**可达性**那一路覆盖。'
      + '⇒ 职责分离,非缺陷。2026-11-13 复核。',
  },
  {
    detector: 'C',
    file: 'tests/WS-07.test.ts',
    needle: 'importsTarget',
    verdict: '假阳性',
    reason:
      '该正则**已含**裸导入(`^\\s*import\\b`)与动态导入(`await\\s+import\\(`)两个分支,'
      + '检测器把「跨行写的多分支」判成「未覆盖」。'
      + '⇒ 是**我的检测器**的覆盖判定不够宽,不是被测代码的问题。已知局限,登记而非改代码。',
  },
  {
    detector: 'C',
    file: 'tests/WS-07.test.ts',
    needle: 'new RegExp(`from\\\\s*[\'"][^\'"]*${esc}',
    verdict: '已定性无害',
    reason: '构造**指定模块名**的定向匹配(目标已知),不需要枚举全部导入形态。',
  },
  {
    detector: 'C',
    file: 'tests/WS-09.test.ts',
    needle: "importsThree = /from\\s*['\"]three['\"]",
    verdict: '已定性无害',
    reason: '定向检查「是否引用了 three 包」,该正则**已含**动态 import 分支,不需要裸导入分支(three 不会用副作用导入)。',
  },
  {
    detector: 'C',
    file: 'tests/WS-09.test.ts',
    needle: "const re = /from\\s*['\"]([^'\"]+)['\"]/g",
    verdict: '已定性无害',
    reason: '收集**具名包**清单用于对照白名单,裸副作用导入不带包名 ⇒ 不适用。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-01.test.ts',
    needle: 'content\\/baseline\\.ts',
    verdict: '假阳性',
    reason:
      '三处均为**针对单个已知文件**的存在性断言(`ok(/from…baseline\\.ts/.test(lockSrc))`),'
      + '不是依赖图遍历 ⇒ 「未覆盖裸导入」不适用。检测器把定向断言误认成遍历器。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-01.test.ts',
    needle: 'content\\/baseline\\.ts',
    verdict: '假阳性',
    reason: '同上(WS-FND-01 第 2 处)。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-01.test.ts',
    needle: 'content\\/baseline\\.ts',
    verdict: '假阳性',
    reason: '同上(WS-FND-01 第 3 处)。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-09-wiring.test.ts',
    needle: 'badImports = [...code.matchAll(/from',
    verdict: '已定性无害',
    reason:
      'task-57 我自己的文件。该扫描的目的是「入口**不得**从 net/** 取字段」,'
      + '即找**违规**的静态 from ⇒ 裸/动态导入不是它的检测对象。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-09-wiring.test.ts',
    needle: 'entry_load_exempt\\.ts',
    verdict: '已定性无害',
    reason: '同上,定向断言(门禁是否 import 了豁免模块)。',
  },
  {
    detector: 'C',
    file: 'scripts/assertion-teeth-report.ts',
    needle: 'const re = /import\\s+([\\s\\S]*?)\\s+from\\s+',
    verdict: '已定性无害',
    reason:
      '★ **这是 C 的已知覆盖边界,不是缺陷**(2026-11-13 登记)。'
      + 'L367 的 `re` 本身就是**一个做 import 解析的正则** ⇒ 被 C 检测器命中'
      + '(C 探的是"只认 from")。'
      + '但 C 报的是"**该站点未覆盖裸/动态 import**"—— 那对该站点**不适用**:'
      + '它的用途是解析**已存在的 import 语句里的绑定名**(为断言定位置),'
      + '不是做依赖图遍历;裸 `import \'x\'` 没有绑定名,动态 `import()` 不在其解析目标内。'
      + '⇒ 处置:**登记为边界**,不修。若将来它真的承担了依赖图职责,此条应重新定性。',
  },

  /* ─────────── D:对原文计数(7 处,全为假阳性)─────────── */
  /* ★ 2026-11-13:**这一段此前写的是「0 处」,而那是**假 0**,不是真 0**。
     ```
     D 的探测正则要求字面 `.match(` 后**紧跟** `(` —— 而 `matchAll(` 里
     紧跟的是字母 `A` ⇒ **结构上不可能匹配**
     ⇒ D 整类漏掉了 matchAll 写法(本仓自己在用),
       所以「0 处」是**判据太窄**的产物,不是"干净"的证据。
     ⇒ 这正是我在 task-60 写过的那条:**空结果不是「没问题」,可能是判据没运行**。
     ```
     D 放宽为认 `match` 与 `matchAll`、flags 用 `[a-z]*` 之后,报出 7 处。
     逐条定性如下 —— **全是假阳性,但逐条登记**(「都是假的」本身也是要被登记的对象,
     否则下一个人要重做这 7 次判定)。 */
  {
    detector: 'D',
    file: 'scripts/deadcode-audit.ts',
    needle: 'for (const cm of s.code.matchAll(',
    verdict: '假阳性',
    reason:
      '`s.code` 来自 `stripCommentsAndStrings(raw)`(L154)⇒ **注释与字符串都已剥**'
      + '⇒ 注释里的词不会污染计数。'
      + '⚠️ D 误报的机制:它只在**±10 行窗口**里找「剥注释关键词」,'
      + '而这次剥注释发生在**约 200 行之外**的定义处 ⇒ 窗口够不到 ⇒ 误报。'
      + '⇒ 与 A/F 同族:判据看「窗口内有没有关键词」,不看「语义上有没有剥」。',
  },
  {
    detector: 'D',
    file: 'scripts/deadcode-audit.ts',
    needle: 'for (const fm of s.code.matchAll(',
    verdict: '假阳性',
    reason: '同上:`s.code = stripCommentsAndStrings(raw)` ⇒ 已剥注释 ⇒ 非缺陷。',
  },
  {
    detector: 'D',
    file: 'scripts/live-path-audit.ts',
    needle: 'for (const m of src.matchAll(',
    verdict: '假阳性',
    reason:
      '`src = mask(readFileSync(...), false)`(L167),而 `mask` 的第二个参数名是 '
      + '**`blankStrings`** —— 它只控制**字符串**是否也抹;'
      + '**注释无条件被抹**(`inLine`/`inBlock` 分支里 `out[i] = \' \'` 无 `if`)'
      + '⇒ `mask(src, false)` = 剥注释、保留字符串 ⇒ 注释不污染计数。'
      + '2026-11-13 读实现确认,非缺陷。',
  },
  {
    detector: 'D',
    file: 'scripts/live-path-audit.ts',
    needle: 'for (const m of src.matchAll(/^export\\s+const',
    verdict: '假阳性',
    reason: '同上:同一行 `src` 已经过 `mask(..., false)` 剥注释 ⇒ 非缺陷。',
  },
  {
    detector: 'D',
    file: 'tests/WS-07.test.ts',
    needle: 'const literal = [...src.matchAll',
    verdict: '假阳性',
    reason:
      '★ **故意在原文上数**:紧接着 L3118-3120 就**显式减去**注释提及数 '
      + '(`eq(literal, 44 + inComments, ...)`)——'
      + '它要验的正是「字面计数 = 真注解数 + 注释提及数」这个恒等式,'
      + '**用注释提及数反推**,防止有人在注释里多加 `@type(` 把等式搞成巧合。'
      + '⇒ 在原文上数是**设计意图**,不是疏忽 ⇒ 假阳性。',
  },
  {
    detector: 'D',
    file: 'tests/WS-07.test.ts',
    needle: 'const ownDecos = [...rcSrc.matchAll',
    verdict: '假阳性',
    reason:
      '★ **故意**:正则用 `^` **行首锚定**(`/^\\s*@(\\w+)/gm`),'
      + '注释里的 `@type(` 若不在行首对齐则不匹配;'
      + '且 L4037-4039 的注释**明确写出**两个口径的差'
      + '(「行首计数 = 真实生效 44;含注释为 45,差 1 处在注释里,不生效」)。'
      + '⇒ 口径是**选定的**,并在注释里论证过 ⇒ 假阳性。',
  },
  {
    detector: 'D',
    file: 'tests/WS-07.test.ts',
    needle: 'const depDecos = [...scSrc.matchAll',
    verdict: '假阳性',
    reason: '同上:行首锚定 + 注释里已写明「44 生效 / 45 含注释」的口径选择 ⇒ 假阳性。',
  },

  /* ─────────── F:spawnSync 不读 status(1 处)─────────── */
  {
    detector: 'F',
    file: 'scripts/extension-drill.ts',
    needle: "spawnSync(process.execPath, ['tests/WS-FND-04.test.ts']",
    verdict: '假阳性',
    reason:
      '它虽然不读 `r.status`,但命中的判据是'
      + '`hit = f.expect.every(p => failed.some(n => n.startsWith(p)))`'
      + '—— 要求「**必须有正向失败证据**」。'
      + '子进程崩溃 ⇒ stdout 空 ⇒ `failed = []` ⇒ `hit = false` ⇒ **正确地判红**。'
      + '⇒ 唯一的例外是 `expect` 为空数组(`every` 恒真),实测本仓 `expect: []` **0 处**。'
      + '2026-11-13 用实跑确认,非缺陷。',
  },
];

/**
 * 按「检测器 + 文件 + 关键片段」查登记项。
 *
 * ⚠️ 解析 `where` 的坑(实测踩到):`where` 的格式是 `path:LINE  行文本`,
 * **而行文本自身含冒号**(正则里的 `\s*:`、`https://`、`a ? b : c` 都会)。
 * ⇒ 用 `split(':')` 会在行内第一个冒号处截断 `rest`,导致 `lineText` 只剩半句
 *   ⇒ 登记项匹配不上 ⇒ **已登记的项被误报成「新增」**。
 * ⇒ 必须用 `indexOf(':')` 只切**第一个**冒号,再跳掉行号。
 */
export function findBaseline(detector: string, where: string): BaselineEntry | undefined {
  /* ★ 只切第一个冒号 —— 行文本里的冒号必须保留 */
  const c = where.indexOf(':');
  if (c < 0) return undefined;
  const file = where.slice(0, c);
  const rest = where.slice(c + 1);
  /* rest = `LINE  行文本`;跳掉行号与空格 */
  const sp = rest.indexOf(' ');
  const lineText = sp < 0 ? '' : rest.slice(sp + 1);

  return JUDGEMENT_BASELINE.find(
    (b) => b.detector === detector && b.file === file && lineText.includes(b.needle),
  );
}

/**
 * ## ★ 候选型检测器的**水位**(2026-11-13,Lead 裁决「甲」)
 *
 * ```
 * 已经过 4 轮实测(thousand-line survey + 3 次阈值标定),
 * 判据是:「两个类型容器共享 ≥3 个**领域字段** ∧ 各有独有字段」
 * 剔除通用词表(GENERIC_FIELDS)后的结果。
 * ```
 *
 * ## 为什么记水位而非逐条登记
 *
 * ```
 * 甲方案的语义 = 「**把"数量增长"当信号,而不是把"有没有"当信号**」
 *
 * 42 对 ⇒ 告警,门禁**绿**(存量是已知的、无争议的)
 * 43 对 ⇒ 门禁**红**(有人新引入了这类形态)
 * ```
 * ⇒ 理由:这 42 条**没有逐对定性**(逐对读 42 个容器的字段语义超出预算),
 *   强行登记成「已定性无害」是**撒谎**;而逐条定性又只是「为了让门禁好看」——
 *   那不是为了让项目正确。
 *
 * ## ⚠️ 水位只准**上调**,且每次上调必须写理由
 *
 * ```
 * 允许上调(水位是"已知存量",不是"目标值"):
 *   新增的配对**确实是**有意传递 ⇒ 上调并把该配对记进 CR/说明
 * **禁止下调**:下调等于把已存在的形态从视野里抹掉 ⇒ 与"防线前移"相反
 * ⇒ 上调时请同时更新本行注释里的日期与原因。
 * ```
 *
 * 实测记录:
 * ```
 * 2026-11-13  42 对  G 初版判据(通用词表 94 条)
 * 2026-11-13  43 对  ★ **水位守卫自己抓到的第一次增长** ——
 *                   `deadcode-audit.ts:289 Finding` ↔ `live-path-audit.ts:66 DeadSymbol`
 *                   定性:**层间传递,非重复实现**。理由:
 *                   `live-path-audit` 走 **spawnSync + --json** 取数据
 *                   (实测:它只 import node:fs / node:path / node:child_process,
 *                    **不 import** deadcode-audit)⇒ **没有类型传递通道**
 *                   ⇒ 只能本地复制一份结构来接 JSON ⇒ 这是**进程边界导致的必然重复**。
 *                   早已注意:它连 ROOT 都刻意不复制(见本仓"两份实现"教训)。
 *                   ⇒ 按规则**上调水位并把理由写清**(这正是水位守卫的用途)。
 * 2026-11-13  44 对  ★ 水位守卫抓到的**第二次增长** ——
 *                   `client/src/net/session.ts:39 HelloFrame` ↔
 *                   `client/src/net/session.ts:50 WelcomeFrame`
 *                   共享 `[t, protocolVersion, contentClaim]`
 *                   独有A `[passwordHash, asGuest]` / 独有B `[playerId, roomId]`
 *                   定性:**请求/响应对的协议对称,非重复实现**。逐条理由:
 *                   · `t` —— 帧类型判别式,**每一帧都有** ⇒ 共享是定义使然;
 *                   · `protocolVersion` —— 握手**两端都必须声明版本**,否则
 *                     "版本不符 ⇒ 明确失败"无从判定(WS-12 有行为判据守这条);
 *                   · `contentClaim` —— 两端都携带内容指纹,但**角色不同**:
 *                     客户端侧恒为 `null`(阶段 3 拿不到 registry,见 CR-26),
 *                     服务端侧是 `string`(encodeContentClaim 的输出)。
 *                     ⇒ **同一字段名的两种角色**,不是一个概念的两份实现。
 *                   · 独有字段**正交**:上行带凭据,下行带身份 ⇒ 零重叠。
 *                   ⇒ 若合并成一个类型,会造出「playerId 可有可无的帧」——
 *                     类型不再表达方向,是**更差**的设计。
 *                   ⇒ 按规则**上调水位并把理由写清**。
 * ______________________________________________________________________
 * ⚠️ 两次增长由**同一条守卫**抓到,且**都发生在同一天** ——
 *    说明它的灵敏度是对的:它**不**假装能区分"有意传递"与"重复实现",
 *    而是把**每一次增长都当信号**,逼一个人来定性。这正是设计意图。
 * ```
 */
export const G_CANDIDATE_WATERMARK = 44;
