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
 * 用法:
 *   node scripts/gate-selfcheck.ts              # 全部用例
 *   node scripts/gate-selfcheck.ts --only D1    # 只跑某组
 *
 * 期望耗时:每组约 0.2s(只跑 `--frozen`),D4 组需跑全套测试故较慢。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, sep, dirname, resolve } from 'node:path';

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
  /* 静态 `from '...'` */
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) out.push(m[1]!);
  /* 裸副作用导入 `import '...'` */
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+'(\.[^']+)'/g)) out.push(m[1]!);
  /* 动态 `await import('...')` —— ⚠️ 排除 `typeof import(`(类型查询不产生运行时边) */
  for (const m of src.matchAll(/await\s+import\(\s*'(\.[^']+)'/g)) out.push(m[1]!);
  return out;
}
import { tmpdir } from 'node:os';

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
  {
    group: 'T37',
    name: 'action handler 加上成功执行 ⇒ 登记应报「不再是该形态」',
    file: 'server/src/net/room.colyseus.ts',
    from: '',
    to: '',
    expect: 'red',
    wantMsg: /不再是该形态/,
    args: ['--frozen'],
    mark: 'inert-action',
  } as Case,
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

  /* ═══ D1:整体透传必须回退接口级并报红 ═══ */
  {
    group: 'D1',
    name: '汇点实参整体透传 inventory(userId, input)',
    file: 'server/src/net/room.ts',
    from: 'this.ac.inventory(userId, {',
    to: 'this.ac.inventory(userId, input as never, /*',
    expect: 'red',
    wantMsg: /整体透传|取自客户端/,
    args: ['--frozen'],
  },
  {
    group: 'D1',
    name: '汇点实参别名透传 inventory(userId, pkt)',
    file: 'server/src/net/room.ts',
    from: 'this.ac.inventory(userId, {',
    to: 'this.ac.inventory(userId, pkt as never, /*',
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
  },

  /* ═══ D4:断言数取自被测套件自身的输出,可被伪造 ═══
     旧实现取**末匹配**,于是在套件末尾多打一行 `999/999 通过` 就能让门禁
     把 999 当成「实测」断言数(并报 ✓ 用例汇总 1964 条,真值 1015)。
     现在要求恰好 1 处,多一处即 fail。
     注:此用例必须跑 `runTests`,故不能带 `--frozen`(它会跳过 runTests)。 */
  {
    group: 'D4',
    name: '在 WS-01 末尾伪造一行 999/999 通过',
    file: 'tests/WS-01.test.ts',
    from: "report('WS-01');",
    to: "report('WS-01');\nconsole.log('[WS-01] 999/999 通过');",
    expect: 'red',
    wantMsg: /处「N\/N 通过」/,
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
  {
    group: 'N1',
    name: '--integration 不得报「冻结层不变量…实测 0」',
    file: 'README.md',
    from: '',
    to: '',
    expect: 'any',            /* 只断言消息,不约束整体红绿 */
    notMsg: /冻结层不变量.*实测 0/,
    args: ['--integration'],
  },
  {
    group: 'N1',
    name: '--integration 应打印「本模式未运行 checkFrozen」',
    file: 'README.md',
    from: '',
    to: '',
    expect: 'any',
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
      const walkTs = (dir: string, out: string[] = []): string[] => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) {
            if (!/^(node_modules|\.git|_design|_shots|_vss_restore|dist|build|out)$/.test(e.name)) {
              walkTs(join(dir, e.name), out);
            }
            continue;
          }
          if (!e.name.endsWith('.ts')) continue;
          const rel = relative(ROOT2, join(dir, e.name)).split(sep).join('/');
          /* 与 ts-paths.ts 的 isProd 同口径:三个顶层目录的全部 .ts
             ⚠️ 曾经这里写成 `shared/src/`,而 shared/ **没有 src/ 层** ⇒ 整棵被漏 */
          if (/^(server|client|shared)\//.test(rel)) out.push(rel);
        }
        return out;
      };
      const prodAll2 = walkTs(ROOT2);
      if (prodAll2.length === 0) {
        throw new Error('gate-selfcheck: import 图遍历出 0 个生产文件(判据失效,不许静默继续)');
      }
      /* 入口闭包:与 verify.ts 的 PROD_ENTRIES 同口径(4 个入口已登记) */
      const ENTRIES2 = ['server/src/net/room.colyseus.ts', 'client/src/main.ts', 'server/src/sim/demo.ts', 'server/src/index.ts']
        .map((p) => resolve(ROOT2, p)).filter((p) => existsSync(p));
      if (ENTRIES2.length === 0) {
        throw new Error('gate-selfcheck: 一个生产入口都不存在(闭包必然是空的,不许静默继续)');
      }
      const reach2 = new Set<string>();
      {
        const stack = [...ENTRIES2];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          if (reach2.has(cur)) continue;
          reach2.add(cur);
          for (const spec of extractRelImports(readFileSync(cur, 'utf8'))) {
            const dep = resolve(join(dirname(cur), spec));
            if (existsSync(dep) && !reach2.has(dep)) stack.push(dep);
          }
        }
      }
      const diffSetPaths: string[] = [];
      /* ⚠️ 遍历必须取 `e[1]`(捕获组里的**路径**),不能解构 `[rel]` ——
         那取的是 `e[0]`(整段匹配文本),于是 base 提取不到、importer 恒为 0
         ⇒ 差集算成 0 条而**看起来完全正常**。
         我第一次就是 `for (const [rel] of entries)` ⇒ 独立复算报「差集 0 条」,
         与 verify.ts 的 4 条**矛盾** —— 那个矛盾正是这条 bug 的信号。 */
      for (const e of entries) {
        const rel = e[1]!;
        const base = rel.split('/').pop()!.replace(/\.ts$/, '');
        const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const importers = prodAll2.filter((f) => f !== rel
          && new RegExp(`from '[^']*${esc}\\.ts'`).test(readFileSync(resolve(ROOT2, f), 'utf8')));
        if (importers.length > 0 && importers.every((f) => !reach2.has(resolve(ROOT2, f)))) {
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

let lab: string | null = null;
function makeLab(): string {
  if (lab) return lab;
  const d = mkdtempSync(join(tmpdir(), 'cp_selfcheck_'));
  cpSync(ROOT, d, {
    recursive: true,
    filter: (s) => !/[/\\](\.git|node_modules|_shots|_design|_cdp_profile)([/\\]|$)/.test(s),
  });
  lab = d;
  return d;
}
function dropLab(): void {
  if (lab) { rmSync(lab, { recursive: true, force: true }); lab = null; }
}

interface RunResult { exit: number; fails: string[]; out: string }
function runVerify(args: string[]): RunResult {
  const r = spawnSync(process.execPath, ['scripts/verify.ts', ...args], {
    cwd: makeLab(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    exit: r.status ?? -1,
    fails: out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim()),
    out,
  };
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
  dropLab();
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
  dropLab();
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
  dropLab();
}

/* ── 基线:干净副本 ──
   若基线有红(通常是队友在飞的改动),**不中止**,而是把它当作差值基准 ——
   见 `deltaFails` 的说明。这样本脚本在多人并行时依然能给出有效结论。 */
dropLab();
const base = runVerify(['--frozen']);
console.log('[自检基线] 干净副本 --frozen');
if (base.fails.length > 0) {
  console.log(`  · 基线有 ${base.fails.length} 条红(可能是队友在飞的改动)—— 后续判定改用**差值**:`);
  base.fails.slice(0, 5).forEach((f) => console.log(`      ${f.slice(0, 165)}`));
} else {
  console.log(`  ✓ 基线绿(${base.exit === 0 ? 'exit 0' : `exit ${base.exit}`})`);
}
dropLab();

/* ── 逐条用例 ── */
for (const c of CASES) {
  if (only && c.group !== only) continue;
  dropLab();
  const p = join(makeLab(), c.file);
  let probeOk = true;
  if (!existsSync(p)) {
    console.log(`\n[${c.group}] ${c.name}\n  ✗ 探针无效:${c.file} 不存在`);
    failures += 1; dropLab(); continue;
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
    console.log(`\n[${c.group}] ${c.name}\n  ✗ 探针失效:锚点解析器返回空串(清单可能已空)`);
    failures += 1; dropLab(); continue;
  }
  if (fromText !== '') {
    const n = src.split(fromText).length - 1;
    if (n !== 1) {
      console.log(`\n[${c.group}] ${c.name}\n  ✗ 探针无效:锚点命中 ${n} 次(需恰好 1 次)`);
      failures += 1; dropLab(); continue;
    }
    writeFileSync(p, src.replace(fromText, c.to), 'utf8');
    /* 自证:读回确认内容真的变了 —— 防「空操作探针」假证据 */
    if (readFileSync(p, 'utf8') === src) probeOk = false;
  }

  const args = c.args ?? [];
  const r = runVerify(args);
  /* **差值判定**:只看本用例新引入的 ✗,忽略基线就有的(队友在飞的改动)。
     见 `deltaFails` 的说明 —— 用绝对红绿会在多人并行时给出错误结论。 */
  const newFails = deltaFails(r.fails, base.fails);
  const isRed = newFails.length > 0;
  const verdictOk = c.expect === 'any' ? true : (c.expect === 'red') === isRed;
  const msgOk = c.wantMsg === undefined || c.wantMsg.test(r.out);
  const notOk = c.notMsg === undefined || !c.notMsg.test(r.out);
  /* expect:'any' 的用例必须至少给一个消息断言,否则它什么也没测。 */
  const anyHasMsg = c.expect !== 'any' || c.wantMsg !== undefined || c.notMsg !== undefined;

  console.log(`\n[${c.group}] ${c.name}`);
  console.log(`  探针:${c.from === '' ? '(无需变异)' : probeOk ? '✓ 内容已变' : '✗ 空操作!'}`);
  console.log(`  verify ${args.join(' ') || '(无 flag)'} → exit ${r.exit},`
    + `fail ${r.fails.length}${base.fails.length > 0 ? `(基线 ${base.fails.length} ⇒ 新增 ${newFails.length})` : ''}`);
  console.log(`  期望 ${c.expect === 'any' ? '只断言消息' : c.expect === 'red' ? '红' : '绿'}`
    + ` ⇒ ${verdictOk ? '✓ 符合' : '✗✗ 不符'}${
      c.wantMsg ? msgOk ? ';命中预期消息 ✓' : ';消息未命中 ✗' : ''}${
      c.notMsg ? notOk ? ';已消失预期消息 ✓' : ';不该出现的消息仍在 ✗' : ''}`);

  if (verdictOk && msgOk && notOk && probeOk && anyHasMsg) {
    passed += 1;
    /* 红的时候把**新增的**那条打印出来,作为「有牙齿」的证据 */
    if (c.expect === 'red') newFails.slice(0, 2).forEach((f) => console.log(`      ${f.slice(0, 165)}`));
  } else {
    failures += 1;
    newFails.slice(0, 5).forEach((f) => console.log(`      新增: ${f.slice(0, 165)}`));
    if (c.expect === 'red' && newFails.length === 0) {
      console.log('      ⚠️ 门禁没有**新增**红 —— 这条检查是恒真的(或探针打偏了)');
    }
    if (!notOk) console.log(`      ⚠️ 出现不该出现的消息:${c.notMsg}`);
  }
  dropLab();
}

console.log(`\n${failures === 0 ? '✓ 门禁自检全部通过' : `✗ 门禁自检 ${failures} 项未通过`}`
  + `(${passed} 通过 / ${passed + failures} 合计)`);
if (failures > 0) process.exitCode = 1;
