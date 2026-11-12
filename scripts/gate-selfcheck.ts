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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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
  for (const m of block.matchAll(/^\s*\['(server\/[^']+)',\s*'([^']+)'\]/gm)) {
    const reason = m[2] as string;
    if (reason.includes("'")) continue;
    return `'${reason}'`;
  }
  return '';
}

const CASES: Case[] = [
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
    wantMsg: /入口 2 个/,
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
       故改为「必须打印**当前实际条数**」—— 从 verify.ts 读同源常量。 */
    wantMsg: (() => {
      const src = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8');
      const a = src.indexOf('const UNREACHABLE_EXEMPT = new Map<string, string>([');
      const b = src.indexOf(']);', a);
      const n = [...src.slice(a, b).matchAll(/^\s*\['[^']+',\s*'[^']*'\]/gm)].length;
      /* 既断言「用了实测值」,也断言「没写死上一个值」 */
      return new RegExp(`欠账构成\\(${n} 条全部待接`);
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

let failures = 0;
let passed = 0;

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
