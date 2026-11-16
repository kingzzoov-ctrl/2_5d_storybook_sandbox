/**
 * 动作接线覆盖率 —— **从源码派生**,不读任何手抄名单。
 *
 * 用法:
 *   node scripts/action-coverage.ts           # 打印表格(只读,**不写文件**)
 *   node scripts/action-coverage.ts --json    # 同样的结论,改成 JSON
 *
 * ## 谁该跑它(别让它变成第 N 个死脚本)
 *
 *   1 `tests/WS-FND-38-action-coverage.test.ts` —— 每次跑测试都调 `deriveActionCoverage()`,
 *     并用它交叉核对 `tests/WS-07.test.ts`(ACT-2)与 `tests/WS-FND-18`(FND18-4)里
 *     那两份**硬编码名单**。名单一过期,那两条就红;
 *   2 将来在门禁里挂一条(`scripts/verify.ts` 的接线类判据)时,直接
 *     `import { deriveActionCoverage }` 或 spawn 本脚本 —— 本文件是纯只读的,
 *     import 它**没有**顶层副作用(有 `import.meta.main` 守卫)。
 *
 * ## 为什么要有它(这不是洁癖)
 *
 * 本仓的「哪些动作真的接线了」此前**只**活在注释与三份手抄名单里:
 *
 *   · `tests/WS-07.test.ts`(ACT-2)            `for (const act of [MOVE, ATTACK])`
 *   · `tests/WS-FND-18-action-ownership.test.ts`(FND18-4)  `['MOVE', {}, 'NOT_IMPLEMENTED']`
 *   · `tests/WS-FND-21-action-e2e.test.ts`(FND21-3)        `{ action: 'MOVE' }`
 *
 * 最近三个波次里这份名单**每次都过期**(接了线却仍列在「未接」里,或者反过来),
 * 每次都靠人肉发现。⇒ 结论应该**算**出来:事实源是源码,名单只是它的**投影**;
 * 投影过期 ⇒ 测试红,而不是靠谁想起来去看一眼。
 *
 * ## 判定规则(以及为什么这样判)
 *
 * 输入(全部只读):
 *
 *   a `server/src/net/room.ts`  的 `export const RoomAction = { … } as const;`
 *     ⇒ **动作清单与总数**(22 个键;**不写死** 22,数字是从这里数出来的);
 *   b `server/src/net/actions/action_table.ts` 的 `ACTION_HANDLERS` 表
 *     ⇒ **动作 → 处理器标识符**;以及它顶部 `import { … } from './x.ts'`
 *     ⇒ **处理器标识符 → 文件**(所以 `admin.ts` 里 5 个、`material.ts` 里 4 个
 *     动作也能被各自判到,不必假设「一个动作一个文件」);
 *   c 每个处理器的**函数体**(按下面的 ⊕ 规则从源码里切出来)。
 *
 * 判定(⊕):
 *
 *   **未接线** ⇔ 该处理器的函数体**整段只有一句**把 `notImplemented(...)` 原样回出去:
 *
 *   ```ts
 *   export const move: ActionHandler = (ctx) => notImplemented(ctx.action);   // 表达式体
 *   export const move: ActionHandler = (ctx) => { return notImplemented(ctx.action); };  // 块体
 *   ```
 *
 *   **已接线** ⇔ 函数体里出现**任何**别的东西(赋值、`if`、`ctx.authorize(...)`、
 *   `applyInventory(...)`、委托给同文件的另一支函数……)。
 *
 * 为什么判「整段只有一句」而不是「文件里出现过 `notImplemented`」:
 *
 *   ★ **反例就在仓库里**:`server/src/net/actions/reset_world.ts` 的 `resetWorld`
 *     在 `host === null` 时**故意**回 `notImplemented`(`reset_world.ts:90`),
 *     而它是一支货真价实的实现(权限闸 / confirm 校验 / `host.resetWorld` 调用)。
 *     「文件里有 notImplemented ⇒ 未接线」会把它判成未接线 —— 假红。
 *   ★ 反向的假绿:「函数体里只要不是 notImplemented 就算接了」。这没法完全消除
 *     (见文件末「已知误判面」),但「整段只有一句」至少保证**多一句就一定是接了**:
 *     一个动作要「其实没做却算接了」,必须写出一句既不是转发、又什么都不做的语句。
 *
 * 注释与 `import`:判定在**剥掉注释与字符串内容**的文本上跑(`buildMasks`),
 * 所以「注释里写着 TODO」「import 了 `notImplemented` 却没用」都不会影响结论 ——
 * 后者由 `bodyUsesNotImplemented` 显式再挡一次(纯 import 不是转发)。
 *
 * 每条判定都带**依据行号**(`declLine` 声明处、`verdictLine` 决定结论的那一行),
 * 测试会回读那一行确认它真的属于该处理器(见 WS-FND-38 的第 7 条)。
 *
 * ## 已知误判面(老实写在这里,别让读者以为这是形式化证明)
 *
 *   1 **委托不被追**:`openChest` / `useOwnChest` 只是 `runChestAction(...)` 的入口,
 *     本脚本看它们的**函数体** ⇒ 判「已接线」。若某天 `runChestAction` 被写回
 *     一句转发,这两个动作会被判已接线(**假绿**)。追委托需要跨函数数据流,
 *     不是本脚本的判据范围;
 *   2 **一行占位会被判已接线**:若有人把函数体写成
 *     `{ const t = 1; return notImplemented(ctx.action); }`,那就是「已接线」——
 *     规则只看「是不是整段一句转发」,不看语义;
 *   3 **剥注释/字符串是词法近似**:正则字面量里若含引号或反引号
 *     (`/'/`、`/`/`)会让扫描器错位;模板字符串里的 `${…}` 内容被整段当成字符串。
 *     当前 `server/src/net/actions/*.ts` 里**没有**正则字面量,于是这两种情形都成立;
 *     新增时若出现怪判,先看 `buildMasks`;
 *   4 **拼写/别名**:别名 import(`import { notImplemented as ni }`)是支持的;
 *     但「自己重写一份 `notImplemented`」或换名字的转发(`return stub(...)`)只能靠
 *     ESM 图判断,本脚本只认 `not-implemented.ts` 导出的那个名字。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/* ─────────────────────────── 路径常量 ─────────────────────────── */

const ACTIONS_DIR = 'server/src/net/actions';
const ROOM_FILE = 'server/src/net/room.ts';
const TABLE_FILE = `${ACTIONS_DIR}/action_table.ts`;
const NOT_IMPLEMENTED_FILE = `${ACTIONS_DIR}/not-implemented.ts`;

/** 仓库根:`scripts/` 的上一级(可用 `deriveActionCoverage(root)` 覆盖)。 */
const DEFAULT_ROOT = resolve(import.meta.dirname, '..');

/* ─────────────────────────── 结果形状 ─────────────────────────── */

/** 一个动作的判定结果(逐动作一行,含**依据行号**)。 */
export interface ActionCoverageRow {
  /** 动作名 = `RoomAction` 的键(如 `MOVE`)。 */
  action: string;
  /** `true` = 已接线;**未接线**的定义见文件头 ⊕ 规则。 */
  wired: boolean;
  /** 处理器标识符(`action_table.ts` 里 `ACTION: handler` 的右值)。 */
  handler: string;
  /** 处理器所在文件(仓库相对路径,正斜杠)。 */
  file: string;
  /** 处理器**声明处**的行号(1 起)。 */
  declLine: number;
  /** **决定结论**的那一行:未接线 = `notImplemented(` 所在行;已接线 = 首语句所在行。 */
  verdictLine: number;
  /** 依据行的原文(已 trim,过长截断),便于人眼核对。 */
  evidence: string;
  /** 一句话说清为什么这样判。 */
  why: string;
}

export interface ActionCoverage {
  /** `RoomAction` 的键数(**从源码数出来的**,不是字面量)。 */
  total: number;
  /** `total` 这个数的出处。 */
  totalSource: { file: string; line: number };
  /** 已接线(按 `RoomAction` 声明序)。 */
  wired: string[];
  /** 未接线(同上,顺序一致)。 */
  unwired: string[];
  /** 逐动作的完整判定(顺序 = `RoomAction` 声明序)。 */
  rows: ActionCoverageRow[];
}

/* ───────────────────── 词法层:剥注释 / 剥字符串 ─────────────────────
 *
 * 为什么不直接在原文上跑正则:`scripts/dup-export-audit.ts` 里记过一次教训 ——
 * 块注释中间的行「在输出里长得和真代码一模一样」。这里同理:
 *
 *     块注释起始
 *       return notImplemented(ctx.action);
 *     块注释结束
 *
 * 在原文上判「函数体只有一句转发」⇒ 把**注释掉的代码**当真代码 ⇒ 结论反转。
 * ⇒ 判据一律跑在 `sealed`(注释与字符串内容都换成空格,**换行保留**)上;
 * 行号因此仍然对得上原文。
 *
 * 两个掩码:
 *   noComment  —— 只把注释换成空格(import 路径、`MOVE: 'MOVE'` 的字面量还要读);
 *   sealed     —— 注释 + 字符串内容都换成空格(切函数体、数语句、认调用)。
 */

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function splitLines(text: string): string[] {
  return text.split('\n').map(stripCR);
}

interface RawMasks {
  noComment: string;
  sealed: string;
}

/**
 * 单趟扫描,同时产出两份掩码(长度与原文一致,换行原样保留)。
 *
 * 支持的词法:行注释、块注释、`'…'`、`"…"`、`` `…` ``(含转义)。
 * 不支持:正则字面量(见文件头「已知误判面」③)。
 */
function buildMasks(text: string): RawMasks {
  const n = text.length;
  const noComment = text.split('');
  const sealed = text.split('');

  /** 把 `[from, to)` 换成空格,**不碰换行**(行号必须保持)。 */
  const blank = (arr: string[], from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
    }
  };

  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    /* 行注释:到行尾。 */
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      blank(noComment, i, j);
      blank(sealed, i, j);
      i = j;
      continue;
    }

    /* 块注释:到闭合标记(未闭合 ⇒ 吃到文件尾,后面会因「找不到声明」显式报错)。 */
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blank(noComment, i, j);
      blank(sealed, i, j);
      i = j;
      continue;
    }

    /* 单/双引号字符串:引号本身保留,引号之间的内容在 sealed 里抹成空格。 */
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      j = Math.min(n, j + 1);
      blank(sealed, i + 1, j - 1);
      i = j;
      continue;
    }

    /* 模板字符串:整段(含 `${…}` 里的内容)当字符串抹掉 —— 见「已知误判面」③。 */
    if (c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      j = Math.min(n, j + 1);
      blank(sealed, i + 1, j - 1);
      i = j;
      continue;
    }

    i += 1;
  }

  return { noComment: noComment.join(''), sealed: sealed.join('') };
}

/** 一个文件的三视图(都已按行切好,行号严格对齐)。 */
interface SourceFile {
  rel: string;
  rawLines: string[];
  noCommentLines: string[];
  sealedLines: string[];
  sealedText: string;
  lineStarts: number[];
  /** 1 起的行号。 */
  lineOf(offset: number): number;
}

function loadSource(root: string, rel: string): SourceFile {
  const text = readFileSync(join(root, rel), 'utf8');
  const masks = buildMasks(text);
  const sealedText = masks.sealed;
  const lineStarts: number[] = [0];
  for (let i = 0; i < sealedText.length; i += 1) {
    if (sealedText[i] === '\n') lineStarts.push(i + 1);
  }
  return {
    rel,
    rawLines: splitLines(text),
    noCommentLines: splitLines(masks.noComment),
    sealedLines: splitLines(masks.sealed),
    sealedText,
    lineStarts,
    lineOf(offset: number): number {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

/* ─────────────────────── 1 动作清单(room.ts) ─────────────────────── */

interface ActionDecl {
  name: string;
  line: number;
}

/**
 * 从 `RoomAction` 对象字面量里读键。
 *
 * ⚠️ **总数不写死**:`22` 这个字面量在本文件的**代码**里出现 0 次(注释里提到它不算),
 * 它是 `keys.length`。测试里那个字面量 22 是**外部约定**(产品口径),
 * 两者相等才算「源码与约定一致」。
 */
function readRoomActions(root: string): { actions: ActionDecl[]; source: { file: string; line: number } } {
  const room = loadSource(root, ROOM_FILE);
  const start = room.noCommentLines.findIndex((l) => /^export const RoomAction\s*=\s*\{/.test(l));
  if (start < 0) {
    throw new Error(`${ROOM_FILE} 里找不到 \`export const RoomAction = {\` —— 动作清单的唯一事实源不见了`);
  }
  const end = room.noCommentLines.findIndex((l, idx) => idx > start && /^\}\s*as const;/.test(l));
  if (end < 0) {
    throw new Error(`${ROOM_FILE}:${start + 1} 的 RoomAction 字面量没有 \`} as const;\` 收尾`);
  }
  const actions: ActionDecl[] = [];
  for (let idx = start + 1; idx < end; idx += 1) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*'([^']*)'\s*,?\s*$/.exec(room.noCommentLines[idx]);
    if (m === null) continue;
    const key = m[1];
    const value = m[2];
    /* 协议常量:键与值必须逐字相同(否则「动作名」有两个事实 ⇒ 报文对不上)。 */
    if (key !== value) {
      throw new Error(`${ROOM_FILE}:${idx + 1} 的 RoomAction 键值不一致:${key} : '${value}'`);
    }
    actions.push({ name: key, line: idx + 1 });
  }
  if (actions.length === 0) {
    throw new Error(`${ROOM_FILE}:${start + 1} 的 RoomAction 里一个动作都没读到`);
  }
  return { actions, source: { file: ROOM_FILE, line: start + 1 } };
}

/* ──────────────── 2 动作 → 处理器 → 文件(action_table.ts) ──────────────── */

interface ImportBinding {
  /** 被 import 的名字(源模块里的名字)。 */
  imported: string;
  /** 模块路径(`./x.ts`,按 import 原文)。 */
  from: string;
  line: number;
}

interface HandlerEntry {
  action: string;
  /** `ACTION_HANDLERS` 里的右值标识符。 */
  local: string;
  line: number;
}

interface HandlerTable {
  imports: Map<string, ImportBinding>;
  entries: Map<string, HandlerEntry>;
}

/**
 * 读一个文件的 `import { a, b as c } from './x.ts';`(支持 `as` 别名)。
 *
 * 返回 `本地名 → { 源名字, 模块说明符, 行号 }`。
 * 只认命名 import —— 动作模块用的全是命名 import,`import * as ns` 在这里没有出现,
 * 出现了就会被判「追不到源文件」而不是**静默**判成已接线(宁可红,不可假绿)。
 */
function parseImports(src: SourceFile): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  src.noCommentLines.forEach((line, idx) => {
    const m = /^import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'\s*;/.exec(line);
    if (m === null) return;
    for (const part of m[1].split(',')) {
      const spec = part.trim();
      if (spec === '') continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(spec);
      const imported = asMatch ? asMatch[1] : spec;
      const local = asMatch ? asMatch[2] : spec;
      imports.set(local, { imported, from: m[2], line: idx + 1 });
    }
  });
  return imports;
}

function parseHandlerTable(root: string): HandlerTable {
  const src = loadSource(root, TABLE_FILE);
  const imports = parseImports(src);

  const start = src.noCommentLines.findIndex((l) => /^export const ACTION_HANDLERS\b/.test(l));
  if (start < 0) {
    throw new Error(`${TABLE_FILE} 里找不到 \`export const ACTION_HANDLERS\` —— 动作→执行层的唯一一张表不见了`);
  }
  const end = src.noCommentLines.findIndex((l, idx) => idx > start && /^\};/.test(l));
  if (end < 0) {
    throw new Error(`${TABLE_FILE}:${start + 1} 的 ACTION_HANDLERS 字面量没有 \`};\` 收尾`);
  }

  const entries = new Map<string, HandlerEntry>();
  for (let idx = start + 1; idx < end; idx += 1) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(src.noCommentLines[idx]);
    if (m === null) continue;
    entries.set(m[1], { action: m[1], local: m[2], line: idx + 1 });
  }
  if (entries.size === 0) {
    throw new Error(`${TABLE_FILE}:${start + 1} 的 ACTION_HANDLERS 里一条登记都没读到`);
  }
  return { imports, entries };
}

/** 把配置表里的模块说明符(`./admin.ts`)解析成仓库相对路径。 */
function resolveModule(from: string, importerRel: string): string {
  if (!from.startsWith('.')) {
    throw new Error(`${importerRel} 从非相对路径 import 处理器:${from}(本脚本只追 ./ 开头的模块)`);
  }
  const base = importerRel.split('/').slice(0, -1).join('/');
  const out: string[] = [];
  for (const seg of `${base}/${from}`.split('/')) {
    if (seg === '..') out.pop();
    else if (seg === '.' || seg === '') continue;
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * 文件里 `notImplemented` 的**本地名**(从指向 `./not-implemented.ts` 的命名 import 里找)。
 *
 * 返回 `null` = 本文件根本没 import 它 ⇒ 这个文件的处理器**不可能**是转发 ——
 * 这正是「只被 import 但没用」的另一半:光 import 不算,函数体里**用到**才算。
 * (别名 `import { notImplemented as ni }` 会返回 `ni`。)
 */
function notImplementedLocalName(file: SourceFile, fileRel: string): string | null {
  for (const [local, b] of parseImports(file)) {
    if (b.imported !== 'notImplemented') continue;
    if (resolveModule(b.from, fileRel) === NOT_IMPLEMENTED_FILE) return local;
  }
  return null;
}

/* ────────────────── 3 处理器函数体的切分与判定 ────────────────── */

interface BodySpan {
  /** 函数体起点(sealedText 偏移,含块体的 `{` 之内)。 */
  bodyStart: number;
  /** 函数体终点(不含)。 */
  bodyEnd: number;
  blockBody: boolean;
  arrowAt: number;
}

/**
 * 从「处理器标识符」定位到声明,再切出**函数体**。
 *
 * 切分在 `sealed` 上做:注释/字符串里不可能出现 `=>`、`{`、`;`、`)`,
 * 因此括号配平不会被字符串里的花括号带偏。
 */
function findHandlerBody(file: SourceFile, local: string): { declLine: number; span: BodySpan; declStart: number } {
  const escaped = local.replace(/[$]/g, '\\$');
  const constRe = new RegExp(`^export\\s+const\\s+${escaped}\\b`);
  const funcRe = new RegExp(`^export\\s+function\\s+${escaped}\\b`);

  let declIdx = file.sealedLines.findIndex((l) => constRe.test(l));
  const isConst = declIdx >= 0;
  if (declIdx < 0) declIdx = file.sealedLines.findIndex((l) => funcRe.test(l));
  if (declIdx < 0) {
    throw new Error(`${file.rel} 里找不到处理器的导出声明 \`export const ${local}\` / \`export function ${local}\``);
  }

  const declStart = file.lineStarts[declIdx];
  const sealed = file.sealedText;

  if (!isConst) {
    /* `export function name(...) { … }`:从参数表之后的第一个 `{` 起配平。 */
    const open = sealed.indexOf('{', declStart);
    if (open < 0) throw new Error(`${file.rel}:${declIdx + 1} 的函数 ${local} 没有函数体`);
    const close = matchBrace(sealed, open);
    return {
      declLine: declIdx + 1,
      declStart,
      span: { bodyStart: open + 1, bodyEnd: close, blockBody: true, arrowAt: open },
    };
  }

  const arrowAt = sealed.indexOf('=>', declStart);
  if (arrowAt < 0) {
    throw new Error(`${file.rel}:${declIdx + 1} 的 \`${local}\` 不是箭头函数 —— 本脚本只认 \`export const x: ActionHandler = (ctx) => …\``);
  }

  let i = arrowAt + 2;
  while (i < sealed.length && /\s/.test(sealed[i])) i += 1;

  if (sealed[i] === '{') {
    const close = matchBrace(sealed, i);
    return {
      declLine: declIdx + 1,
      declStart,
      span: { bodyStart: i + 1, bodyEnd: close, blockBody: true, arrowAt },
    };
  }

  /* 表达式体:扫到**顶层**的 `;` 或换行为止(括号内的换行不算结束)。 */
  let depth = 0;
  let j = i;
  for (; j < sealed.length; j += 1) {
    const c = sealed[j];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) break;
    } else if (depth === 0 && (c === ';' || c === '\n')) break;
  }
  return {
    declLine: declIdx + 1,
    declStart,
    span: { bodyStart: i, bodyEnd: j, blockBody: false, arrowAt },
  };
}

/** 在 sealedText 上配平花括号,返回与 `open` 配对的 `}` 的偏移。 */
function matchBrace(sealed: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sealed.length; i += 1) {
    if (sealed[i] === '{') depth += 1;
    else if (sealed[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('花括号未配平(源码被截断?)');
}

/** 一句话摘要(证据行太长时截断,避免刷屏)。 */
function clip(s: string, max = 120): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

interface Verdict {
  wired: boolean;
  verdictLine: number;
  evidence: string;
  why: string;
}

/**
 * ⊕ 规则的实现:**函数体整段只剩一句 `notImplemented(...)` 转发 ⇒ 未接线**。
 *
 * 三个条件同时成立才算转发(缺一不可):
 *   a 剥掉注释/字符串后,整段函数体归一到一句 `(return)? notImplemented ( … )`;
 *   b 归一段内部**没有** `;`(否则像 `return notImplemented(a); do();` 会被 a 的
 *     贪婪尾巴误判成「只有一句」);
 *   c 该文件**确实**用了 `notImplemented`(排除「只 import 了但没用」)。
 */
function judgeBody(file: SourceFile, local: string, span: BodySpan, declLine: number, notImplName: string, importsNotImpl: boolean): Verdict {
  const sealedBody = file.sealedText.slice(span.bodyStart, span.bodyEnd);
  const bodyLines = splitLines(sealedBody).map((l) => l.trim()).filter((l) => l !== '');
  const statementCount = bodyLines.length;

  const flatRaw = sealedBody.replace(/\s+/g, ' ').trim();
  const flat = flatRaw.endsWith(';') ? flatRaw.slice(0, -1).trim() : flatRaw;

  const onlyCall = new RegExp(`^(?:return\\s+)?${notImplName.replace(/[$]/g, '\\$')}\\s*\\([\\s\\S]*\\)$`);
  const looksLikeForward = onlyCall.test(flat);
  const hasInnerSemicolon = flat.includes(';');
  const pureForward = looksLikeForward && !hasInnerSemicolon && (importsNotImpl || notImplName !== 'notImplemented');

  const callAt = file.sealedText.indexOf(`${notImplName}(`, span.bodyStart);
  const callLine = callAt >= 0 && callAt < span.bodyEnd ? file.lineOf(callAt) : -1;
  const firstLine = file.lineOf(span.bodyStart + (sealedBody.length - sealedBody.trimStart().length));
  const evidenceLine = pureForward ? callLine : (statementCount === 0 ? declLine : firstLine);
  const raw = file.rawLines[evidenceLine - 1] ?? '';

  if (pureForward) {
    return {
      wired: false,
      verdictLine: evidenceLine,
      evidence: clip(raw),
      why: `函数体整段只有一句 \`${notImplName}(…)\` 转发 ⇒ 未接线`,
    };
  }

  const reasons: string[] = [];
  if (looksLikeForward && hasInnerSemicolon) reasons.push('体内有多条语句(不止一句转发)');
  else if (!looksLikeForward) reasons.push(`首语句不是 \`${notImplName}(…)\``);
  if (importsNotImpl === false) reasons.push('本文件没 import notImplemented');
  return {
    wired: true,
    verdictLine: evidenceLine,
    evidence: clip(raw),
    why: `${reasons.join(';')}(函数体 ${statementCount} 行代码)`,
  };
}

/* ─────────────────────────── 派生入口 ─────────────────────────── */

export function deriveActionCoverage(rootDir: string = DEFAULT_ROOT): ActionCoverage {
  const root = rootDir;
  const room = readRoomActions(root);
  const table = parseHandlerTable(root);

  /* 不重不漏:动作清单与执行层表必须**逐键**对齐。 */
  const missing = room.actions.filter((a) => !table.entries.has(a.name)).map((a) => a.name);
  const extra = [...table.entries.keys()].filter((k) => !room.actions.some((a) => a.name === k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `RoomAction 与 ACTION_HANDLERS 不一致:未登记=[${missing.join(',')}] 多出=[${extra.join(',')}]`
      + ' —— 新增动作必须当场在 action_table.ts 里作决定',
    );
  }

  const fileCache = new Map<string, SourceFile>();
  const rows: ActionCoverageRow[] = [];

  for (const decl of room.actions) {
    const entry = table.entries.get(decl.name);
    if (entry === undefined) throw new Error(`动作 ${decl.name} 没有执行层登记`);

    const binding = table.imports.get(entry.local);
    if (binding === undefined) {
      throw new Error(
        `${TABLE_FILE}:${entry.line} 的 \`${decl.name}: ${entry.local}\` 指向的标识符没有 import —— 追不到源文件`,
      );
    }
    const fileRel = resolveModule(binding.from, TABLE_FILE);
    let file = fileCache.get(fileRel);
    if (file === undefined) {
      try {
        file = loadSource(root, fileRel);
      } catch (e) {
        throw new Error(`动作 ${decl.name} 的处理器文件读不到:${fileRel}(${(e as Error).message})`);
      }
      fileCache.set(fileRel, file);
    }

    const { declLine, span } = findHandlerBody(file, entry.local);

    /* 本文件里 `notImplemented` 的**本地名**(支持 `as` 别名)。
       只 import 了、函数体里没用 ⇒ 不算转发(「纯 import」显式再挡一次)。 */
    const notImplLocal = notImplementedLocalName(file, fileRel);
    const notImplName = notImplLocal ?? 'notImplemented';
    const usesNotImpl = file.sealedText
      .slice(span.bodyStart, span.bodyEnd)
      .includes(`${notImplName}(`);

    const verdict = judgeBody(file, entry.local, span, declLine, notImplName, notImplLocal !== null && usesNotImpl);

    rows.push({
      action: decl.name,
      wired: verdict.wired,
      handler: entry.local,
      file: fileRel,
      declLine,
      verdictLine: verdict.verdictLine,
      evidence: verdict.evidence,
      why: verdict.why,
    });
  }

  return {
    total: room.actions.length,
    totalSource: room.source,
    wired: rows.filter((r) => r.wired).map((r) => r.action),
    unwired: rows.filter((r) => !r.wired).map((r) => r.action),
    rows,
  };
}

/* ─────────────────────────── 打印 ─────────────────────────── */

/**
 * 把逐动作判定渲染成一张表(`rows` 就够:总数 = `rows.length`)。
 *
 * 有意**不**在表里藏数字:wired/unwired/total 三个数都能从 `rows` 数出来。
 */
export function formatCoverage(rows: readonly ActionCoverageRow[]): string {
  const wired = rows.filter((r) => r.wired);
  const unwired = rows.filter((r) => !r.wired);
  const out: string[] = [];
  out.push('动作接线覆盖率(从源码派生:server/src/net/room.ts + server/src/net/actions/*.ts)');
  out.push(`wired ${wired.length} / unwired ${unwired.length} / total ${rows.length}`);
  out.push('');
  out.push('  动作                    处理器           依据');
  for (const r of rows) {
    const mark = r.wired ? '✓' : '✗';
    out.push(
      `  ${mark} ${r.action.padEnd(21)}${r.handler.padEnd(20)}${r.file}:${r.verdictLine}`,
    );
  }
  out.push('');
  out.push(`未接线(${unwired.length}):${unwired.length === 0 ? '(无)' : unwired.map((r) => r.action).join(', ')}`);
  for (const r of unwired) {
    out.push(`  · ${r.action} —— ${r.evidence}   [${r.file}:${r.verdictLine}]`);
  }
  return out.join('\n');
}

/** 直接跑时的入口。**只打印**,不写任何文件。 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const asJson = argv.includes('--json');
  try {
    const cov = deriveActionCoverage();
    if (asJson) {
      console.log(JSON.stringify(cov, null, 2));
    } else {
      console.log(formatCoverage(cov.rows));
      console.log('');
      console.log(`(动作清单出处:${cov.totalSource.file}:${cov.totalSource.line};本脚本只读,不写文件)`);
    }
    return 0;
  } catch (e) {
    console.error(`[action-coverage] 派生失败:${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}