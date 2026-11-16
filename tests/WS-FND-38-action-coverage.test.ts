/**
 * WS-FND-38 —— 「哪些动作真的接线了」**从源码派生**,不再靠人肉登记。
 *
 * ## 这套件守的是什么
 *
 * 本仓此前有三份**手抄**的「未接动作」名单,每次接线都要手改:
 *
 *   · `tests/WS-07.test.ts`(ACT-2)                `for (const act of [MOVE, ATTACK])`
 *   · `tests/WS-FND-18-action-ownership.test.ts`(FND18-4)  `['MOVE', {}, 'NOT_IMPLEMENTED']`
 *   · `tests/WS-FND-21-action-e2e.test.ts`(FND21-3)        `{ action: 'MOVE' }`
 *
 * 最近三个波次里这份名单**每次都过期**(接了线却仍列在「未接」里,或者反过来),
 * 每次都靠人肉发现 —— 也就是说「哪些接线了」这件事此前**没有**机器可查的事实源。
 *
 * ⇒ 事实源应该是**源码本身**。`scripts/action-coverage.ts` 只读源码算出
 * `wired` / `unwired` / `total`;本套件做两件事:
 *
 *   1 钉住派生结果本身(总数 22、已知接线、刻意不接的 MOVE/ATTACK、不重不漏);
 *   2 **交叉核对**上面那两份硬编码名单 —— 名单里的动作必须在派生的 `unwired` 里,
 *     而且(反向,见 FND38-5)`unwired` 里的动作也必须出现在名单里,除非在
 *     `ACT2_EXEMPT` 里写明为什么它**不该**出现在 ACT-2 里。
 *
 * 第 2 点才是牙齿:名单一旦过期(接线了却仍列在未接里,或未接线却没进名单)⇒ 红,
 * 而不是等谁想起来去看一眼。
 *
 * ## 「未接线」的判定规则(实现见 `scripts/action-coverage.ts` 文件头 ⊕)
 *
 *   处理器函数体**整段只剩一句** `return notImplemented(ctx.action)`(或表达式体
 *   `(ctx) => notImplemented(ctx.action)`)⇒ 未接线;
 *   函数体里出现任何别的语句(**包括 `if (!ok) return notImplemented(...)` 这类兜底**)
 *   ⇒ 已接线。
 *
 * 为什么不是「文件里出现过 `notImplemented` 就算未接线」:
 * `server/src/net/actions/reset_world.ts:90` 的 `resetWorld` 在 `host === null` 时
 * **故意**回 `notImplemented`,而它是一支真实现(权限闸 / confirm 校验 / 宿主调用)。
 * 按「文件里出现就算」会把它判成未接线 —— FND38-2 要求 `RESET_WORLD` ∈ `wired`,
 * 就是钉住这个**反例**。注入验证见 `scripts/action-coverage.ts` 的回报与本节末注。
 *
 * ## 已知边界(别把本套件当成形式化证明)
 *
 *   · 委托不被追:`OPEN_CHEST` / `USE_OWN_CHEST` 只是 `runChestAction(...)` 的入口,
 *     本套件看**函数体** ⇒ 判已接线;
 *   · 一行占位(`const t = 1; return notImplemented(...)`)会被判已接线;
 *   · 判据跑在剥注释/剥字符串的词法近似上(`buildMasks`),正则字面量会干扰它。
 *
 * 完整清单见 `scripts/action-coverage.ts` 文件头的「已知误判面」。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveActionCoverage, formatCoverage } from '../scripts/action-coverage.ts';
import type { ActionCoverage } from '../scripts/action-coverage.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ACTIONS_DIR = join(ROOT, 'server', 'src', 'net', 'actions');
const ROOM_FILE = join(ROOT, 'server', 'src', 'net', 'room.ts');
const WS07 = join(ROOT, 'tests', 'WS-07.test.ts');
const WS_FND_18 = join(ROOT, 'tests', 'WS-FND-18-action-ownership.test.ts');
const SCRIPT = join(ROOT, 'scripts', 'action-coverage.ts');
const SELF = join(ROOT, 'tests', 'WS-FND-38-action-coverage.test.ts');

/* ══════════ 逐行**流式**扫大文件(`WS-07.test.ts` 5700+ 行) ══════════
 *
 * ⚠️ 不整文件读进内存再打印:
 *   · 本仓 `tests/WS-07.test.ts` 约 287 KB / 5700+ 行,一次性读进来只为找 5 行
 *     是浪费,且一旦有人手滑 `console.log(file)` 就是几百 KB 的刷屏;
 *   · 用**分块 + StringDecoder**:块边界上的多字节汉字不会被切成两个乱码字符
 *     (`buf.toString()` 逐块解会把 UTF-8 序列切断)。
 * 访问器返回 `false` ⇒ 立刻停止读(找到名单就不再往下读)。
 */

function scanLines(file: string, visit: (line: string, lineNo: number) => boolean | void): void {
  const fd = openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(1 << 16);
  let carry = '';
  let lineNo = 0;
  let stop = false;
  try {
    while (!stop) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      carry += decoder.write(buf.subarray(0, n));
      let nl = carry.indexOf('\n');
      while (nl >= 0) {
        const line = carry.slice(0, nl).replace(/\r$/, '');
        carry = carry.slice(nl + 1);
        lineNo += 1;
        if (visit(line, lineNo) === false) {
          stop = true;
          break;
        }
        nl = carry.indexOf('\n');
      }
    }
    if (!stop && carry !== '') visit(carry.replace(/\r$/, ''), lineNo + 1);
  } finally {
    closeSync(fd);
  }
}

/* ══════════════════════ 派生结果(整套件共用一份) ══════════════════════ */

let memo: ActionCoverage | null = null;
let memoError: string | null = null;

/** 惰性求值:派生失败**不**让整个文件崩栈,而是让每条断言带着原因变红。 */
function cov(): ActionCoverage {
  if (memo !== null) return memo;
  if (memoError !== null) throw new Error(`deriveActionCoverage() 失败:${memoError}`);
  try {
    memo = deriveActionCoverage(ROOT);
    return memo;
  } catch (e) {
    memoError = e instanceof Error ? e.message : String(e);
    throw new Error(`deriveActionCoverage() 失败:${memoError}`);
  }
}

/* ══════════════ ACT-2 名单:人工登记**例外**的唯一位置 ══════════════
 *
 * 键 = 动作名,值 = 为什么它虽然未接线却**不该**出现在 `tests/WS-07` 的 ACT-2 里。
 * 今天为空:未接线的两个(MOVE / ATTACK)都在 ACT-2 里。
 *
 * ⚠️ 这是**白名单**,所以它必须自己会失效:FND38-5 会断言
 *   「登记项必须仍然是 unwired」—— 一旦某个动作接线了,这条会红,逼你删掉它
 *   (否则白名单会因事实变化而静默放宽)。这与 `scripts/verify.ts` 的
 *   `UNREACHABLE_EXEMPT` / `scripts/orphan-audit.ts` 的 `ORPHAN_KNOWN` 同一思路。
 */
const ACT2_EXEMPT = new Map<string, string>([]);

/**
 * 从 `tests/WS-07.test.ts` 的 ACT-2 里取出那份**硬编码名单**。
 *
 * 只做一件事:定位 `test('ACT-2 …` 之后第一个 `for (const act of [` … `])` 区间,
 * 抽其中的 `RoomAction.X`。抽不到 ⇒ 视为**判据失效**(FND38-5 会红),
 * 而不是「名单为空,断言自然通过」。
 */
function readAct2Names(): { names: string[]; foundTest: boolean; foundLoop: boolean } {
  const names: string[] = [];
  let foundTest = false;
  let foundLoop = false;
  let inLoop = false;

  scanLines(WS07, (line) => {
    if (!foundTest) {
      if (/test\('ACT-2/.test(line)) foundTest = true;
      return undefined;
    }
    if (!inLoop) {
      if (!/for \(const act of \[/.test(line)) return undefined;
      inLoop = true;
      foundLoop = true;
      /* ⚠️ **不 return**:ACT-2 的数组是一行的(`for (const act of [MOVE, ATTACK]) {`),
         起行本身就要抽名字、也要看 `])` 收尾 —— 第一版在这里 return,
         于是漏掉整行的名字、又因为没看到 `])` 一路扫到文件尾(抽到别人家的名单)。 */
    }
    for (const m of line.matchAll(/RoomAction\.([A-Z][A-Z0-9_]*)/g)) names.push(m[1]);
    if (line.includes('])')) return false;
    return undefined;
  });

  return { names, foundTest, foundLoop };
}

/**
 * 从 `tests/WS-FND-18-action-ownership.test.ts` 的 FND18-4 表里取出
 * 期望为 `NOT_IMPLEMENTED` 的动作(`['MOVE', {}, 'NOT_IMPLEMENTED']` 这一种)。
 */
function readFnd18NotImplemented(): { names: string[]; foundTable: boolean } {
  const names: string[] = [];
  let foundTable = false;
  scanLines(WS_FND_18, (line) => {
    if (/const cases: Array<\[string, Record<string, unknown>, string\]>/.test(line)) {
      foundTable = true;
      return undefined;
    }
    if (!foundTable) return undefined;
    if (/^\s*\];/.test(line)) return false;
    const m = /^\s*\['([A-Z][A-Z0-9_]*)',\s*\{[^}]*\},\s*'([A-Z_]+)'\]/.exec(line);
    if (m !== null && m[2] === 'NOT_IMPLEMENTED') names.push(m[1]);
    return undefined;
  });
  return { names, foundTable };
}

/** 仓库内与判定有关的文件:`server/src/net/actions/*.ts` + `room.ts` + 本套两个文件。 */
function watchedFiles(): string[] {
  const files = readdirSync(ACTIONS_DIR).filter((n) => n.endsWith('.ts')).sort();
  return [ROOM_FILE, ...files.map((n) => join(ACTIONS_DIR, n)), SCRIPT, SELF];
}

/** `路径:mtimeMs:size` 的稳定快照,用来钉「没有写操作」。 */
function snapshot(): string {
  return watchedFiles()
    .map((f) => {
      const st = statSync(f);
      return `${f}|${st.mtimeMs}|${st.size}`;
    })
    .join('\n');
}

/* ═══════════════════════════════ 断言 ═══════════════════════════════ */

test('FND38-1 动作总数 = 22:数字从 room.ts 的 RoomAction **派生**,断言用外部约定字面量', () => {
  /* 变红条件:
       1 `RoomAction` 增删成员却没同步产品口径(22)⇒ 红;
       2 派生器读不到 `RoomAction` 字面量(改名/搬家)⇒ cov() 抛错 ⇒ 红。
     ⚠️ 22 在这里是**外部约定**(`docs/` 与三份名单都按 22 说),故意写死;
        派生器内部**不**写死 22 —— 它数的是 `Object.keys(RoomAction).length`。
        两边相等才叫「源码与约定一致」。 */
  const c = cov();
  eq(c.total, 22, 'RoomAction 应有 22 个成员(派生自源码,断言用外部约定 22)');
  eq(c.totalSource.file, 'server/src/net/room.ts', '22 的出处应是 room.ts');
  ok(c.totalSource.line > 0, `必须给出 22 的出处行号(实得 ${c.totalSource.line})`);
  eq(c.rows.length, c.total, '逐动作判定应与动作数一样多(每个动作都必须被裁决)');
});

test('FND38-2 已知接线:CRAFT / SLEEP / OPEN_CHEST / RESET_WORLD 必须在 wired 里', () => {
  /* 变红条件(★ 这就是**注入反例**要打的那一条):
       把 `craft.ts` / `sleep.ts` / `open_chest.ts` / `reset_world.ts` 里任何一个
       的处理器改成「纯 notImplemented 转发」⇒ 它从 wired 掉进 unwired ⇒ 红。
     `RESET_WORLD` 是特别挑的:它的函数体里**确实**有 `notImplemented(ctx.action)`
       (`reset_world.ts:90`,宿主为空时的兜底),但函数体不止那一句 ⇒ 已接线。
       若判据退化成「文件里出现过 notImplemented 就算未接线」,这一条先红 ——
       它守的是判据的**形状**,不只是四个名字。 */
  const c = cov();
  for (const action of ['CRAFT', 'SLEEP', 'OPEN_CHEST', 'RESET_WORLD']) {
    ok(c.wired.includes(action), `${action} 应在 wired 里(实得 unwired=[${c.unwired.join(',')}])`);
  }
});

test('FND38-3 刻意不接:MOVE / ATTACK 在 unwired 里,且 CRAFT **不**在', () => {
  /* 变红条件:
       1 有人把 MOVE / ATTACK 接上了(`MOVE` 走专用报文通道,接上会与 `applyMove`
          两条路径并存)⇒ 本条红,提醒同步 ACT-2 / FND18-4 / FND21-3 三份名单;
       2 `CRAFT` 被误判成未接线(判据退化的典型症状)⇒ 红。 */
  const c = cov();
  for (const action of ['MOVE', 'ATTACK']) {
    ok(c.unwired.includes(action), `${action} 应在 unwired 里(刻意不接;实得 wired 里有它:${c.wired.includes(action)})`);
  }
  ok(!c.unwired.includes('CRAFT'), 'CRAFT 已接线,不得出现在 unwired 里');
});

test('FND38-4 wired ∪ unwired = 全部动作,且两组不交(不重不漏)', () => {
  /* 变红条件:某个动作既没进 wired 又没进 unwired(被漏判),或两边都在(判据自相矛盾)。 */
  const c = cov();
  eq(c.wired.length + c.unwired.length, c.total, 'wired + unwired 应恰为 total(不允许有动作漏判)');
  const both = c.wired.filter((a) => c.unwired.includes(a));
  eq(both.join(','), '', `同一动作不能既已接线又未接线:${both.join(',') || '无'}`);
  const dupWired = c.wired.filter((a, i) => c.wired.indexOf(a) !== i);
  eq(dupWired.join(','), '', `wired 里不许有重复项:${dupWired.join(',') || '无'}`);
  ok(c.wired.length > 0, '至少要有已接线的动作,否则派生器只会说「全都未接」');
  ok(c.unwired.length > 0, '至少要有未接线的动作,否则本判据失去意义');
});

test('★ FND38-5 交叉核对 WS-07 的 ACT-2 名单:它必须与派生的 unwired 一致(过期即红)', () => {
  /* 这一条是**核心**:名单是投影,源码是事实。
     变红条件:
       1 ACT-2 里列了某个动作,而派生结果说它**已接线** ⇒ 名单过期(最常见的形态);
       2 某个动作**未接线**却没进 ACT-2,又没在 `ACT2_EXEMPT` 里写明为什么
          (**反向**)⇒ 名单过期;
       3 ACT-2 的结构被改动(找不到 `test('ACT-2` 或 `for (const act of [`) ⇒
          判据失效,直接红,而不是「名单为空 ⇒ 自然通过」。

     ⚠️ 反向检查靠 `ACT2_EXEMPT` 这个**会自己失效**的白名单:
        登记项必须仍然是 unwired,否则红(事实变了,白名单必须跟着删)。 */
  const c = cov();
  const { names, foundTest, foundLoop } = readAct2Names();

  ok(foundTest, '在 tests/WS-07.test.ts 里找不到 `test(\'ACT-2` —— 名单搬家了?本判据已失效');
  ok(foundLoop, '在 ACT-2 里找不到 `for (const act of [` —— 名单形状变了?本判据已失效');
  ok(names.length > 0, 'ACT-2 名单解析出来是空的 —— 判据失效(不许「空名单自然通过」)');

  /* 正向:名单里的每个动作都必须真的是未接线。 */
  for (const name of names) {
    ok(
      c.unwired.includes(name),
      `ACT-2 列了 ${name},但派生结果说它**已接线** ⇒ 名单过期(ACT-2=[${names.join(',')}];`
      + `派生的 unwired=[${c.unwired.join(',')}])`,
    );
  }

  /* 反向:未接线的动作要么进 ACT-2,要么在 ACT2_EXEMPT 里写明理由。 */
  const leftover = c.unwired.filter((a) => !names.includes(a));
  const unregistered = leftover.filter((a) => !ACT2_EXEMPT.has(a));
  eq(
    unregistered.join(','),
    '',
    `这些动作未接线却**没**出现在 ACT-2 名单里,也没在 ACT2_EXEMPT 里登记理由:${unregistered.join(',') || '无'}`,
  );
  for (const [action, why] of ACT2_EXEMPT) {
    ok(why.trim().length >= 8, `ACT2_EXEMPT 里 ${action} 的理由太短,写清「为什么它不该进 ACT-2」`);
    ok(
      c.unwired.includes(action),
      `ACT2_EXEMPT 登记的 ${action} 已经不未接线了(它现在在 wired 里)⇒ 该条豁免已失效,删掉它`,
    );
  }
});

test('FND38-6 交叉核对 WS-FND-18 的 FND18-4 表:期望 NOT_IMPLEMENTED 的动作必须在 unwired 里', () => {
  /* 变红条件:
       1 FND18-4 表里某行写 `['X', {}, 'NOT_IMPLEMENTED']`,而派生结果说 X 已接线
          ⇒ 那条用例在**假装**测一个未接动作(接线之后它会静默变成测别的东西);
       2 表的形状变了(找不到 `const cases:` / 解析不出任何 NOT_IMPLEMENTED 行)
          ⇒ 判据失效,红。 */
  const c = cov();
  const { names, foundTable } = readFnd18NotImplemented();

  ok(foundTable, '在 WS-FND-18 里找不到 FND18-4 的 `const cases:` 表 —— 表搬家了?本判据已失效');
  ok(names.length > 0, 'FND18-4 里解析不出任何 NOT_IMPLEMENTED 行 —— 判据失效(不许空过)');

  for (const name of names) {
    ok(
      c.unwired.includes(name),
      `FND18-4 期望 ${name} 回 NOT_IMPLEMENTED,但派生结果说它**已接线** ⇒ 表过期`
      + `(派生的 wired=[${c.wired.join(',')}])`,
    );
  }
});

test('FND38-7 幂等且无副作用:连跑两次结果相同,且不修改任何文件', () => {
  /* 变红条件:
       1 派生器有隐藏状态/顺序依赖(第二次结果不同)⇒ 红;
       2 派生器**写了**任何仓库文件(mtime 或 size 变化)⇒ 红。
         这一条钉的是「只读」这个承诺:`scripts/action-coverage.ts` 不许把结论
         写回仓库(那会造出第四份手抄名单,而且没人会去更新它)。 */
  const before = snapshot();

  const a = deriveActionCoverage(ROOT);
  const b = deriveActionCoverage(ROOT);

  eq(JSON.stringify(b), JSON.stringify(a), '两次派生结果必须逐字段相同(幂等)');
  eq(formatCoverage(b.rows), formatCoverage(a.rows), '两次渲染的表格必须逐字相同');

  const after = snapshot();
  eq(after, before, '派生前后仓库文件的 mtime/size 必须一致(派生器**只读**)');
});

test('FND38-8 依据行号可回读:每条的 declLine 真的落在该处理器的声明行上', () => {
  /* 为什么值得单独一条:判据的**可审计性**全靠行号。若行号是猜的/错位的,
     读者按行号回读会看到别的东西,于是「派生」退化成「另一份需要相信的结论」。
     变红条件:
       1 行号越界或指向空行/注释;
       2 声明的标识符与该行不符(说明切分把别处当成了处理器);
       3 判为未接线的行里**没有** `notImplemented(`(说明「转发」这个结论没有出处)。 */
  const c = cov();
  const cache = new Map<string, string[]>();

  for (const row of c.rows) {
    const abs = join(ROOT, row.file);
    let lines = cache.get(row.file);
    if (lines === undefined) {
      const collected: string[] = [];
      scanLines(abs, (line) => {
        collected.push(line);
        return undefined;
      });
      lines = collected;
      cache.set(row.file, lines);
    }

    ok(row.declLine >= 1 && row.declLine <= lines.length, `${row.action}: declLine=${row.declLine} 越界(${row.file})`);
    const declText = lines[row.declLine - 1];
    ok(
      new RegExp(`^(export\\s+)?(const|function)\\s+${row.handler}\\b`).test(declText.trim() === '' ? '\u0000' : declText),
      `${row.action}: ${row.file}:${row.declLine} 不是 \`${row.handler}\` 的声明行(实得 "${declText.trim()}")`,
    );

    ok(row.verdictLine >= 1 && row.verdictLine <= lines.length, `${row.action}: verdictLine=${row.verdictLine} 越界`);
    const evidenceText = lines[row.verdictLine - 1];
    ok(evidenceText.trim() !== '', `${row.action}: ${row.file}:${row.verdictLine} 是空行 —— 依据行号指向了空处`);
    if (!row.wired) {
      ok(
        evidenceText.includes('notImplemented('),
        `${row.action} 被判「未接线」,但 ${row.file}:${row.verdictLine} 里没有 \`notImplemented(\``
        + `(实得 "${evidenceText.trim()}")`,
      );
    }
    ok(row.why.length > 0, `${row.action}: 必须给出判定理由`);
  }
});

report('WS-FND-38');