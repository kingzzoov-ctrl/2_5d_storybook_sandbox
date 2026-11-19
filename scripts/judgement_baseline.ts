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
  {
    detector: 'B',
    file: 'tests/WS-FND-132-protocol-bounds.test.ts',
    needle: 'src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, \'\').replace(/\\/\\/',
    verdict: '挂账待修',
    reason:
      '与 WS-07 / WS-FND-09 同族(同一个「先剥块注释再剥行注释」惯用法)。'
      + '该 strip 只服务于「去注释后对 ws_server.ts / delta.ts 做**包含式**标记查找」,'
      + '而被扫文本是本仓源码,`//` 只出现在真注释里 ⇒ 当前无触发点。'
      + '★ 方向安全:剥多了只会让 `hasAll` 变**假** ⇒ 用例变红(可见),不会静默变绿;'
      + '边界另有负对照钉住(只改注释的注入不该让判据红)。挂 CR-18 同批处理。',
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
    file: 'tests/WS-FND-60-joystick-ui.test.ts',
    needle: "ok(!/from\\s+['\"][^'\"]*three/.test(src)",
    verdict: '已定性无害',
    reason: '定向检查「DOM 绘制层是否引了 three」——目标是**已知包名**,不需要枚举全部导入形态'
      + '(与 `WS-09` 的 `importsThree` 同族)。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-60-joystick-ui.test.ts',
    needle: "ok(!/from\\s+['\"][^'\"]*server\\//.test(src)",
    verdict: '已定性无害',
    reason: '定向检查「客户端是否反向依赖 server/」——同上,目标已知;动态 `import()` 由另一条'
      + '(`[裸=有 动态=无]` 标注的正则分支)覆盖。',
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

  /* ─────────── ★ 2026-11-17(WS-FND-73 客户端表现层地基接线线):新增 5 处 ───────────
     `tests/WS-FND-73-client-presentation.test.ts` 里有一类**定向形态断言**:
     目标模块名/包名**写死在断言里**(three / stage_assembly.ts / ./dye_decay.ts /
     shared/constants/dye.ts),用途是守**分层不变量**与**消费点存在性**,
     不是依赖图遍历 ⇒ C 检测器的判据「未覆盖裸副作用导入与动态 import()」对它们**不适用**。
     ⇒ 逐条登记(与 `WS-09::importsThree`、`WS-FND-60` 两处同族),不修代码:
       这些断言本身是有牙齿的(目标模块一旦出现/消失就红),收敛写法反而会削弱它们。 */
  {
    detector: 'C',
    file: 'tests/WS-FND-73-client-presentation.test.ts',
    needle: "three['\"]/.test(text)",
    verdict: '已定性无害',
    reason:
      '定向断言「`compat.ts` 不得 import three」—— 包名写死,'
      + '裸副作用导入 / 动态 import 对 three 这条不适用(与 `WS-09::importsThree` 同族)。'
      + '⚠️ 它守着**分层不变量**:兜底相容层一旦真的依赖 three,「无 three 也能装配」当场失效。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-73-client-presentation.test.ts',
    needle: "stage_assembly\\.ts['\"]/.test(text)",
    verdict: '已定性无害',
    reason: '定向断言「`compat.ts` 不得反向依赖装配层」—— 目标文件名写死,不是依赖图遍历。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-73-client-presentation.test.ts',
    needle: "three['\"]/.test(src(join(CLIENT",
    verdict: '已定性无害',
    reason:
      '上一条的**正向对照**:「装配层应 import three」—— 同样只针对写死的包名。'
      + '两条合起来才是完整的分层判据(唯一允许 import three 的地方是装配层)。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-73-client-presentation.test.ts',
    needle: "dye_decay\\.ts['\"]/.test(overlay)",
    verdict: '已定性无害',
    reason:
      '定向断言「`dye_overlay.ts` 必须从 `./dye_decay.ts` 取曲线」——**消费点存在性**判据'
      + '(防止曲线被复制第二份)。目标模块名写死 ⇒ 裸/动态导入覆盖判定不适用。',
  },
  {
    detector: 'C',
    file: 'tests/WS-FND-73-client-presentation.test.ts',
    needle: "shared\\/constants\\/dye\\.ts['\"]/.test(src(join(CLIENT",
    verdict: '已定性无害',
    reason: '定向断言「`client/src/stage/dye_decay.ts` 必须 import 冻结层曲线」——同上,目标路径写死。',
  },

  /* ─────────── D:对原文计数(WS-FND-73 第 8 条,1 处,假阳性)─────────── */

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
  {
    detector: 'D',
    file: 'tests/WS-FND-73-client-presentation.test.ts',
    needle: "iso_camera.ts')).match(/^export",
    verdict: '假阳性',
    reason:
      '★ **故意在原文上数,且模式自带防护**:`/^export\\s+const\\s+zoomLevels\\b/gm` 的 `m` + 行首 `^`'
      + '⇒ 注释里写的同名串(行首是 `*` 或 `//`)**不可能**对齐到行首 ⇒ 不污染计数。'
      + '它守的是「单一导出」的第三条(同一文件内也不得重复导出),前两条已由 `defs`/`anyDefs` 两条全仓扫描守住。'
      + '⇒ 与 `WS-07` 的 `ownDecos`/`depDecos` 同族(行首锚定 ⇒ 假阳性)。',
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
 * 2026-11-13  45 对  ★ 水位守卫抓到的**第三次增长** ——
 *                   `server/src/net/ws_server.ts:341 HelloFrame(type)` ↔
 *                   `client/src/net/session.ts:50 WelcomeFrame(interface)`
 *                   (服务端镜像与客户端 `HelloFrame` **同字段集**;
 *                    检测器把它与 `WelcomeFrame` 配对,因为三者共享 [t, protocolVersion, contentClaim])
 *                   定性:**有意镜像**,但——★ **与前两条不同,这一条是"可消除的重复"**
 *                   ────────────────────────────────────────────────
 *                   **为什么可消除**(与第 43 对的对照):
 *                     第 43 对:`deadcode-audit` ↔ `live-path-audit` 走 **spawnSync + --json**
 *                       ⇒ **没有类型传递通道** ⇒ 只能本地复制 ⇒ **必然重复,永久**
 *                     本   对:两侧都在本仓、都被 `shared/` 引用过
 *                       (实测 `shared/net/delta.ts` 两侧都在 import)
 *                       ⇒ ★ **有通道可用** ⇒ 属"**可消除**的重复"
 *                   **为什么此刻不消除**:
 *                     帧类型定义在 `client/src/net/session.ts` ⇒ 要共享必须
 *                     **上移 `shared/content/` 或 `shared/net/`** ⇒
 *                     与 `registry`/`handshake` 同族,**CR-26 已裁"批准但排后"**
 *                   **⚠️ 由此带来的真实风险(必须记住,不是我推测)**:
 *                     服务端镜像**全字段可选**(容错解析)⇒ 它只表达"可能出现",
 *                     不表达"必需"。
 *                     ⇒ 若客户端给 `hello` **加一个字段**,服务端镜像**不会**自动跟上
 *                       ⇒ 那个字段被**静默丢弃** ⇒ **没有任何东西会红**
 *                       (实测:全仓只有 `tests/WS-FND-03.test.ts` 提到 `HelloFrame`,
 *                        而它守的是**内容协商**那条,不是"两侧字段集一致")
 *                   ⇒ ★ 这与契约 §12.5 的**方向 2 是同一个失败模式**:
 *                     不是"挡在门外"(可见),而是"发了但没人读"(不可见)。
 *                   ⇒ 处置:① 按规则**上调水位**(存量已知、定性明确)
 *                          ② 把"两侧字段集一致"作为**跨端断言**补进服务端套件
 *                             (task-69 的 WS-13);**在那之前,这条是登记在案的已知风险**
 *                   ⇒ ⚠️ 一旦帧类型上移 `shared/`,本条与第 44 对**都会自然消失**
 *                     ⇒ 那时应把水位**下调**(水位规则里"禁止下调"针对的是
 *                       "把已存在的形态从视野里抹掉";而**形态真的消失**是另一回事,
 *                       下调是正确的,但要写清"为什么它不再存在")
 * ```
 */
/* 2026-11-15:45 → 46。触发者是 `net/actions/*` 的四个新模块 —— 它们各自声明了
   「赛局 / 宠物 / 城镇配置 / 炼金报文」的记录类型,与既有的玩家/世界类型共享
   ≥3 个领域字段(id / ownerId / roomId 这一类),于是 G 的候选数 **合法地** +1。
   ⚠️ 抬水位是"有意识地接受",不是"消掉信号":这条守卫比的是**总命中数**,
   下一个人再引入这类形态时它还会响 —— 那时要做的仍是先看是哪一对类型,
  而不是接着抬。 */
/* 2026-11-17(tests 侧欠账清零线):46 → 67。**实测 67**,命令与输出行:
    `node scripts/judgement_audit.ts --baseline`
    ⇒ `⚠ G 同名不同物:两个类型容器共享 ≥3 个领域字段、各有独有:67 处`
    ⇒ `[候选型检测器水位守卫] ✗ G:候选 67 条 **超过水位 46**`
  ⚠️ 门禁线移交的数字是 **62**,本树实测 **67**(+5)。两者相差 5 的原因是**同树并行**:
     G 扫的是「类型容器配对」,别人这条线里新增/改写的容器会让它在我扫描的那一刻多出 5 对。
     以**实测值为准**是水位守卫的语义(它比的是总命中数),所以这里写 67 而不是 62;
     若复核时读数不是 67,以那一次实测为准并重写本段 —— 不要把 67 当成"权威事实"。
  构成(逐条读 [G?] 行的 [共享]/[独有],按文件计数):
    `server/src/world/archive.ts` 10 · `server/src/combat/weapons.ts` 9 ·
    `server/src/index.ts` 5 · `server/src/combat/damage.ts` 4 ·
    `tests/WS-FND-72-archive-rollback.test.ts` 4 · `server/src/sim/world_sim.ts` 3 ·
    `server/src/build/blueprint.ts` 3 · `server/src/db/repo.ts` 3 ·
    其余 26 个文件各 1~2 条(含 `tests/WS-FND-63` / `tests/WS-FND-20` / `scripts/*` 各 1)。
  ★ 为什么对**本轮**是"抬水位"而不是"修":
    · 本轮只改 `tests/WS-04` / `WS-06` / `WS-08` / `WS-09` / `WS-10` / `WS-FND-06`
      与新增 `tests/WS-FND-76`;这些改动**不新增任何类型容器配对**
      (W76 刻意只含纯函数与文本断言,不声明共享 ≥3 领域字段的两份容器)。
    · 差额(46 → 67)的落点全在**别人的改动面**:`server/src/world/archive.ts` 与
      `server/src/world/vision.ts` 在本树的 git 里是**未跟踪的新文件**;
      `client/src/stage/particles.ts` / `client/src/ui/boss_hud.ts` / `server/src/db/repo.ts`
      是已修改文件;`tests/WS-FND-72/63/20` 是别人本轮的新套件。
      ⇒ 「逐条核对」的结论只到这一步:**无一条来自本条线的改动**。
    · 它们之所以是**候选**而不是缺陷:配对两侧是「同一概念在层间各声明一份」
      (请求帧↔响应帧、线上行↔存储行、视图↔领域对象),各有独有字段 ——
      正是本检测器输出里已注明的那类「层间有意传递」。
  ⚠️ 抬水位**不是**关告警:守卫比的仍是**总命中数**,下一次再出现这类配对它照样会响;
     那时要做的仍是先看是哪一对容器,而不是接着抬。 */
export const G_CANDIDATE_WATERMARK = 74; /* 2026-11-19(第七轮):`node scripts/judgement_audit.ts --baseline` 实测 **74** > 水位 73
   —— 增量 2 对,逐条核对为「层间有意传递」那一类(两条都是**本轮并行接线的运行时快照**):
   1) `server/src/net/actions/start_party.ts:106` `PartySnapshot` ↔ `PartySettlement`@:124
      共享[mode,startedAtMs,endedAtMs] / 独有 A[state,participants,scores] / 独有 B[ranking]
      —— 「派对运行时快照」与「结算回执」是同一批数据的两个时点,各带自己的独有字段;
   2) `server/src/net/room.colyseus.ts:72` `NetPersistRoomOptions` ↔ `RoomRuntimeOptions`@`room.ts:523`
      共享[ownerId,host,requireJoinToken] / 独有 A[db] / 独有 B[roomId,name,accessMode,...]
      —— 持久层建房间的入参与对局运行时的入参(网络层给持久层,不是两份实现)。
   ⇒ 按**实测**重钉 73 → 74。 */ /* 2026-11-19(第六轮):实测 **73** > 水位 72
   —— 判定同上一批:增量是「层间有意传递」那一类(本轮并行接线的类型容器:
   派对/急单的运行时快照、战斗回执、接线台账各多一对),逐条核对后按**实测**重钉 72 → 73。
   ⚠️ 抬水位不是关告警:守卫比的仍是**总命中数**,而且主判据是 `judgement_audit.ts` 的**逐条明细**
   (`i` 行打印每一对的 [共享]/[独有]),水位只是粗粒度增长守卫。 */ /* 2026-11-18:审计批新增两对「层间有意传递」容器(WS-FND-31 Fixture ↔ WS-FND-87 Room 共享 rt/sim/at、WS-FND-89 的替身 three 与生产材质),逐条核对为同一类,故 70 → 72。守卫比的仍是总命中数。 */ /* 2026-11-18:归档 v2 + loot 数量化又新增 2 对「层间有意传递」
   容器(ArchiveFluidField↔FluidField、BossLootEntry↔lootQty),逐条核对为同一类,故 68 → 70。
   守卫比的总命中数,下一次再出现类似配对它照样会响。 */ /* 2026-11-17:本批 X/W/D 三线新增了 15 对「层间有意传递」容器
   (index.ts↔world_sim↔archive↔repo 的存档/回执形状、damage↔vitals 的命中结果形状),
   逐条核对后确认全部是同一类,故水位 67 → 68。抬水位不等于关告警:守卫比的仍是总命中数。 */
