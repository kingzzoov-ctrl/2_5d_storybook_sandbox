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
  /** 检测器编号 A~F */
  detector: string;
  /** 仓库相对路径 */
  file: string;
  /** **行的关键片段**(用于匹配,避免行号飘移造成假「新增」) */
  needle: string;
  /** 定性结论 */
  verdict: '已定性无害' | '假阳性' | '挂账待修' | '潜伏(当前无触发)';
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

  /* ─────────── D:对原文计数(0 处)─────────── */
  /* 无命中。留此段说明「0 处」是**真 0** 而非漏扫:
     D 的脏样本自检通过(见 --selftest 的 E 段),且本仓 `@type` 计数
     (docs/ARCH-GAPS.md:211-213)已改为剥注释后计数 —— 修复于 task-57 前后。*/

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
