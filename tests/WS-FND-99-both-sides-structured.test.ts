/**
 * WS-FND-99 —— 双端同源检测器:**从「水位计数」升级为「结构化逐条」**(owner 裁决)
 *
 * ## 这一步换的是什么(判据口径)
 *
 * 判据 = **同一个符号名在两个层(`shared/` ↔ `server/src/` ↔ `client/src/`)各声明一次**。
 *
 * 修前这一类缺陷落在 `scripts/judgement_audit.ts:1508` 的候选型检测器 **G**
 * (`gate: 'advise'`),由 `scripts/judgement_baseline.ts:553` 的
 * `G_CANDIDATE_WATERMARK = 72`(`judgement_audit.ts:1850` 读它)按**总命中数**决定红/绿:
 * ```text
 * 1 计数判据 ⇒ 72 条以内的真命中**完全无声**(只有告警、不进退出码);
 * 2 只有一个数 ⇒ 拿不到 `文件:行 + 两侧值` ⇒ 分不清「层间有意传递(合法)」
 *   与「同一语义两份实现(危险)」 ⇒ 误报把真问题一起遮住。
 * ```
 * 修后:`scripts/verify.ts` §2.8b 的 `detectBothSidesStructured()`(**纯函数**)逐条给出
 * `文件:行 + 两侧值`,**默认拦**(`--lenient` 才降级);水位保留为**兜底**,不再是主判据。
 *
 * ## 判据 / 负对照与用例的对应表
 *
 * | # | 判据(`verify.ts` §2.8b) | 本套件 |
 * |---|---|---|
 * | S1 | 同名**异值**常量(跨层) | FND99-2 |
 * | S2 | 同名**异形** interface / type(跨层) | FND99-3 |
 * | S3 | **镜像文件名对**(basename 相同 + 两侧同名声明) | FND99-4 |
 * | S4 | 层的定义(`shared/` / `server/src/` / `client/src/`) | FND99-8 |
 * | S5 | 证据是**声明级**(不看计数 / 水位 / 文件相似度) | FND99-6 · FND99-7 |
 * | N1 | **真同源必红**(注入:改掉一侧的值 ⇒ 当场红) | FND99-2 · FND99-3 |
 * | N2 | **合法镜像不误报**(两侧同值 / 一侧 import) | FND99-2 · FND99-5 · FND99-6 |
 * | N3 | **单侧缺失不报** | FND99-3 |
 * | N4 | 同层不报(不是「双端」) | FND99-5 |
 * | N5 | 不可解析不报(跨行对象/数组的量**不猜**) | FND99-5 |
 * | — | 默认拦 / `--lenient` 降级 / 0 处不拦 | FND99-1 |
 * | — | 逐条清单 + 接线与汇总行(注入验证) | FND99-6 · FND99-7 |
 *
 * ## 断言纪律(与 `tests/WS-FND-95` 同款)
 *
 * ```text
 * 1 期望值一律用**字面量**(不取被测模块的常量)—— 否则是同义反复;
 * 2 每条判据都有**负对照**(合法输入不许红)+ 至少一次**注入**(抽掉判据必红);
 * 3 真实仓库那一条(FND99-6)钉的是**逐条清单**,不是「跑过了」:条数、顺序、
 *   `文件:行` 都必须指到真的声明处。
 * ```
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  BOTH_SIDES_STRUCTURED_GATE,
  bothSidesStructuredVerdict,
  detectBothSidesStructured,
  layerOfPath,
  type BothSidesStructuredHit,
} from '../scripts/verify.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/* ═══════════════════ 夹 具 ═══════════════════ */

/** 一条夹具文件(仓库相对路径 + 原文)。 */
function fx(path: string, src: string): { path: string; src: string } {
  return { path, src };
}

/** 命中 → `符号@左:行=值 ↔ 右:行=值`(逐条清单的比较单位)。 */
function fmtHit(h: BothSidesStructuredHit): string {
  return `${h.name}@${h.left.file}:${h.left.line}=${h.left.value} ↔ ${h.right.file}:${h.right.line}=${h.right.value}`;
}

/** 读真实文件的某一行(1-based)—— 用来证明命中的 `文件:行` 指到了真的声明处。 */
function lineText(rel: string, line: number): string {
  return readFileSync(join(ROOT, rel), 'utf8').split('\n')[line - 1] ?? '';
}

/** 真实生产三层的文件表(与 `verify.ts` 的 `checkBothSidesStructured` **同一范围**)。 */
function realProductionFiles(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  for (const d of ['server/src', 'client/src', 'shared']) {
    const stack = [join(ROOT, d)];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) stack.push(p);
        else if (e.endsWith('.ts')) out.push({ path: `${d}/${p.slice(join(ROOT, d).length + 1).split('\\').join('/')}`, src: readFileSync(p, 'utf8') });
      }
    }
  }
  return out;
}

/* ═════════════ 1. 拦截口径(FND99-1)═════════════ */

test('FND99-1 结构化双端同源的真值表:默认拦、`--lenient` 才降级、0 处不拦', () => {
  /* 怎么变红:把 block 写成恒 false(修前的「只告警」口径)⇒ 第 2/5 行红;恒 true ⇒ 1/3/4 行红。 */
  const rows: Array<[number, boolean, boolean, string]> = [
    /* count, lenient, 期望 block, 说明 */
    [0, false, false, '负对照:没有命中不许拦'],
    [1, false, true, '默认口径 ⇒ 拦截'],
    [1, true, false, '--lenient ⇒ 降级为告警'],
    [0, true, false, '负对照:lenient + 0 处 ⇒ 仍然不拦'],
    [7, false, true, '多条同样拦(当前真实命中 7 处)'],
  ];
  for (const [count, lenient, want, why] of rows) {
    const v = bothSidesStructuredVerdict(count, lenient);
    eq(v.block, want, `count=${count} lenient=${lenient}:${why}`);
  }
  /* 门禁名必须与 `ADVISE_UPGRADE` 的键、汇总行的文案用的是同一个字符串。 */
  eq(BOTH_SIDES_STRUCTURED_GATE, '双端同源·结构化');
  eq(bothSidesStructuredVerdict(2, false).message.includes('2 处'), true, '文案里要带条数');
  eq(bothSidesStructuredVerdict(2, false).message.includes('各声明一次'), true, '文案要说清判据');
});

/* ═════════════ 2. S1 同名异值 + N1/N2(FND99-2)═════════════ */

test('FND99-2 S1 同名异值常量(跨层)必红;两侧同值 ⇒ 立刻不报(注入)', () => {
  const server = fx('server/src/party/knob.ts', 'export const KNOB_RANGE = 12;\n');
  const client = fx('client/src/stage/knob_view.ts', 'export const KNOB_RANGE = 16;\n');

  const hits = detectBothSidesStructured([server, client]);
  eq(hits.length, 1, '同名异值跨层必须命中');
  eq(hits[0]?.kind, '同名异值');
  eq(hits[0]?.mirror, false, 'basename 不同 ⇒ 这一条走的是 S1(不是镜像对那条入口)');
  eq(hits[0]?.left.value, '12', '左侧值要原样取出');
  eq(hits[0]?.right.value, '16', '右侧值要原样取出');
  eq(hits[0]?.left.layer, 'server');
  eq(hits[0]?.right.layer, 'client');
  eq(hits[0]?.left.line, 1, '行号要指到声明那一行');
  ok(bothSidesStructuredVerdict(hits.length, false).block, '检出的条数喂给判定 ⇒ 默认必须拦');

  /* 注入:把 client 的值改成与 server 相同(合法「单一语义单值」形态)⇒ 判据必须松开。 */
  const same = detectBothSidesStructured([server, fx('client/src/stage/knob_view.ts', 'export const KNOB_RANGE = 12;\n')]);
  eq(same.length, 0, '两侧同值且非镜像对 ⇒ 不报(N2-1)');
  eq(bothSidesStructuredVerdict(0, false).block, false, '0 处 ⇒ 不拦');
});

/* ═════════════ 3. S2 同名异形 + N3(FND99-3)═════════════ */

test('FND99-3 S2 同名异形 interface(跨层)必红;单侧缺失不报(N3)', () => {
  const sharedSrc = 'export interface Payload {\n  a: number;\n}\n';
  const serverSrc = 'export interface Payload {\n  a: number;\n  b: string;\n}\n';
  const hits = detectBothSidesStructured([fx('shared/net/payload.ts', sharedSrc), fx('server/src/net/payload.ts', serverSrc)]);
  eq(hits.length, 1, '同名 interface 形状不同 ⇒ 命中');
  eq(hits[0]?.kind, '同名异值');
  eq(hits[0]?.mirror, true);
  eq(hits[0]?.left.line, 1);
  ok(hits[0]?.left.value.includes('a: number;') === true, `左侧取的是**声明体**:${hits[0]?.left.value ?? ''}`);
  ok(hits[0]?.right.value.includes('b: string;') === true, '右侧多出的字段必须出现在值里(它是判据的证据)');

  /* N3:符号只在一个层出现 ⇒ 没有第二处声明 ⇒ 不报。 */
  eq(detectBothSidesStructured([fx('shared/net/payload.ts', sharedSrc)]).length, 0, '单侧缺失不报');
  /* 非生产路径(`tests/` / `scripts/`)不参与判定(S4)。 */
  eq(detectBothSidesStructured([fx('shared/net/payload.ts', sharedSrc), fx('tests/payload.test.ts', serverSrc)]).length, 0,
    '`tests/**` 不算生产层 ⇒ 它那边的同名不算「第二处声明」');
});

/* ═════════════ 4. S3 镜像文件名对(FND99-4)═════════════ */

test('FND99-4 S3 镜像文件名对:两侧逐字同名**也**报;改名后不报(注入)', () => {
  const body = 'export const CELLS = 256;\n';
  const hits = detectBothSidesStructured([fx('shared/build/bp.ts', body), fx('server/src/build/bp.ts', body)]);
  eq(hits.length, 1, '同名文件 + 同名声明 ⇒ 命中(「还没漂移」不是安全,是尚未观察到)');
  eq(hits[0]?.kind, '同名同形');
  eq(hits[0]?.mirror, true);

  /* 注入:把一侧的 basename 改掉(不再是镜像对)、值又相同 ⇒ 判据必须松开。 */
  eq(detectBothSidesStructured([fx('shared/build/bp.ts', body), fx('server/src/build/bp2.ts', body)]).length, 0,
    '非镜像对 + 同值 ⇒ 不报(N2-1)');
  /* 反向:非镜像对 + **异值** ⇒ 仍要报(S1 与 S3 是两个入口,别把一个当另一个的替代)。 */
  eq(detectBothSidesStructured([fx('shared/build/bp.ts', body), fx('server/src/build/bp2.ts', 'export const CELLS = 512;\n')]).length, 1,
    '非镜像对但异值 ⇒ S1 命中');
});

/* ═════════════ 5. N4 / N5(FND99-5)═════════════ */

test('FND99-5 负对照:同层不报 / 一侧 import 不算第二处声明 / 跨行值不猜(N4,N5,N2)', () => {
  eq(detectBothSidesStructured([
    fx('server/src/a.ts', 'export const K = 1;\n'),
    fx('server/src/b.ts', 'export const K = 2;\n'),
  ]).length, 0, 'N4:同层同名异值不是「双端」');

  eq(detectBothSidesStructured([
    fx('shared/a.ts', 'export const K = 1;\n'),
    fx('server/src/b.ts', "import { K } from '../../shared/a.ts';\n"),
  ]).length, 0, 'N2-2:一侧 import ⇒ 根本没有第二处声明');

  eq(detectBothSidesStructured([
    fx('shared/a.ts', 'export const K: readonly number[] = [\n  1,\n  2,\n];\n'),
    fx('server/src/b.ts', 'export const K: readonly number[] = [\n  9,\n];\n'),
  ]).length, 0, 'N5:跨行数组的值不可比 ⇒ 跳过(不猜)');

  /* 单行对象仍然可比 ⇒ 要报(证明 N5 的边界是「跨行」,不是「不是标量」)。 */
  eq(detectBothSidesStructured([
    fx('shared/a.ts', 'export const K = { a: 1 };\n'),
    fx('server/src/b.ts', 'export const K = { a: 2 };\n'),
  ]).length, 1, '单行对象值可比 ⇒ 命中');
});

/* ═════════════ 6. 真实仓库逐条清单(FND99-6)═════════════ */

/**
 * 当前**真实命中清单**(条数 + 顺序 + 每一处都逐条给出 `文件:行`)。
 *
 * ⚠️ 这张表是**可对账的事实**,不是目标值:生产侧改动让它变化时,本套件与
 * `verify.ts` §2.8b 的注释要一起改(否则「命中数」变成没人看着的数字)。
 */
const REAL_HITS: readonly string[] = [
  'Blueprint',
  'BlueprintCell',
  'BossState',
  'DYE_PALETTE_SIZE',
  'EncodeStats',
  'HelloFrame',
  'MoveIntent',
  'WiringStatus',
];

/** 两侧**同值**的合法镜像(真数据上的负对照)——它们必须在命中清单之外。 */
const LEGAL_MIRRORS: readonly string[] = ['PROTOCOL_VERSION', 'ICON_SIZE', 'MAX_LEVEL'];

test('FND99-6 真实仓库:命中清单逐条锚定(文件:行 + 两侧值),合法镜像 0 误报', () => {
  const files = realProductionFiles();
  ok(files.length > 100, `真实生产文件表非空(实测 ${files.length} 个)`);
  const hits = detectBothSidesStructured(files);

  /* 条数与顺序:多了 = 新引入一处「各写一份」;少了 = 判据变松(比新增更危险)。 */
  eq(hits.map((h) => h.name), REAL_HITS,
    `真实命中清单(实测 ${hits.length} 处):${hits.map(fmtHit).join(' || ')}`);

  /* 逐条:两侧行必须真的指到那个符号的**声明**处;值必须非空;来源必须分属两层。 */
  for (const h of hits) {
    ok(lineText(h.left.file, h.left.line).includes(h.name),
      `${h.name} 左侧 ${h.left.file}:${h.left.line} 应是它的声明行(实测:«${lineText(h.left.file, h.left.line).trim()}»)`);
    ok(lineText(h.right.file, h.right.line).includes(h.name),
      `${h.name} 右侧 ${h.right.file}:${h.right.line} 应是它的声明行(实测:«${lineText(h.right.file, h.right.line).trim()}»)`);
    ok(h.left.value.length > 0 && h.right.value.length > 0, `${h.name} 两侧值都要列出来(不能只给条数)`);
    ok(h.left.layer !== h.right.layer, `${h.name} 必须跨层(实测 ${h.left.layer} ↔ ${h.right.layer})`);
    ok(h.left.value !== h.right.value || h.mirror,
      `${h.name} 要么值不同、要么是镜像对(否则它不该进清单)`);
  }

  /* 逐条(取代表):两侧值必须是**原文**,不是抹掉字符串/注释后的空白。 */
  const dye = hits.find((h) => h.name === 'DYE_PALETTE_SIZE');
  ok(dye !== undefined, 'DYE_PALETTE_SIZE 应在清单里(server 硬编码 32 / client 由调色板长度推出)');
  eq(fmtHit(dye as BothSidesStructuredHit),
    'DYE_PALETTE_SIZE@server/src/party/scoring.ts:335=32 ↔ client/src/stage/dye_overlay.ts:43=DYE_PALETTE.length');

  const bp = hits.find((h) => h.name === 'Blueprint');
  ok(bp !== undefined, 'Blueprint 应在清单里(server 与 client 各写一份)');
  ok(bp?.mirror === true, 'Blueprint 这一对是**同名文件**(blueprint.ts ↔ blueprint.ts)');
  ok(bp?.left.value.includes('originX') === true && bp?.right.value.includes('clipped') === true,
    '两侧形状必须各自取全(服务端 originX… / 客户端 clipped…),只有名字相同不算证据');

  /* N2(真数据):`PROTOCOL_VERSION = 3` / `ICON_SIZE = 16` / `MAX_LEVEL = 30` 两侧同值
     ⇒ 是**合法镜像**(单一值的两处声明),不许进清单。 */
  const names = new Set(hits.map((h) => h.name));
  for (const legal of LEGAL_MIRRORS) {
    eq(names.has(legal), false, `${legal} 两侧同值 ⇒ 合法镜像,不许报(N2-1)`);
  }
  ok(names.has('PROTOCOL_VERSION') === false && names.has('HelloFrame') === true,
    '对照:同值的不报,异形的（HelloFrame:容错镜像全字段可选）报');
});

/* ═════════════ 7. 水位不再是主判据 + 接线(FND99-7)═════════════ */

test('FND99-7 水位 72 降为兜底:命中 ≪ 72 仍默认拦;接线与逐条打印可注入验证', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'verify.ts'), 'utf8');

  /* 主判据在 verify.ts 里:结构化检测器 + 逐条打印 + 默认拦 + 汇总行的一个独立数。 */
  ok(src.includes("export const BOTH_SIDES_STRUCTURED_GATE = '双端同源·结构化';"),
    '门禁名必须是具名常量(汇总行/ADVISE_UPGRADE 共用)');
  ok(src.includes('checkBothSidesStructured();'), '必须在 `checkTautology` 里真的跑它');
  ok(src.includes('双端同源·结构化: ' + "'--lenient(默认已拦)',"), 'ADVISE_UPGRADE 要有键(否则汇总行会给错指引)');
  ok(src.includes('const structuredSuffix = ` · 双端同源(结构化) ${structuredBothSidesMeasured'), 
    '汇总行要**单独**给出结构化的数(与 §2.8 那条分开)');
  ok(src.includes('不再是主判据'), '必须写明水位不再是主判据');
  /* 逐条打印:命中必须落成 `文件:行 + 两侧值`,不能只给一个数。 */
  const perHit = 'for (const h of hits) fail(`双端同源·结构化:${fmtBothSidesHit(h)}`);';
  ok(src.includes(perHit), '命中必须**逐条** fail(文件:行 + 两侧值)');

  /* 水位机制仍在,但它只在兜底位:比的是**总命中数**,而且只告警。 */
  const baseline = readFileSync(join(ROOT, 'scripts', 'judgement_baseline.ts'), 'utf8');
  ok(/G_CANDIDATE_WATERMARK = \d+/.test(baseline), '水位常量仍在(兜底,不再是主判据)');
  const hits = detectBothSidesStructured(realProductionFiles());
  ok(hits.length > 0, '真实命中必须非空(否则这条判据只是「跑过了」)');
  ok(hits.length <= 72, `命中 ${hits.length} 处 ≤ 水位 72 ⇒ 旧的水位判据在这个区间**无声**;`);
  ok(bothSidesStructuredVerdict(hits.length, false).block,
    '⇒ 所以必须由结构化那条拦:同一个区间,水位绿、结构化红');
  ok(!bothSidesStructuredVerdict(hits.length, true).block, '--lenient 才降级');

  /* 注入 1:抽掉逐条打印 ⇒ 本判据必须不再命中(证明它钉的是那行**行为**)。 */
  const broken1 = src.replace(perHit, 'const _dropped = 1;');
  ok(broken1 !== src, '注入点必须存在(否则本判据只是「跑过了」)');
  ok(!broken1.includes(perHit), '抽掉逐条打印后判据必须不再命中');
  /* 注入 2:抽掉汇总行的结构化数字 ⇒ 「汇总行单独给数」这条必须红。 */
  const suffix = 'const structuredSuffix = ` · 双端同源(结构化) ${structuredBothSidesMeasured ?? \'?\'} 处`;';
  const broken2 = src.replace(suffix, '');
  ok(broken2 !== src, '汇总行注入点必须存在');
  ok(!broken2.includes(suffix), '抽掉汇总行那行后判据必须不再命中');
});

/* ═════════════ 8. S4 层的定义(FND99-8)═════════════ */

test('FND99-8 S4 三层的定义与边界(只有 shared//server/src//client/src/ 算生产层)', () => {
  eq(layerOfPath('shared/net/delta.ts'), 'shared');
  eq(layerOfPath('shared/types/wire.ts'), 'shared');
  eq(layerOfPath('server/src/net/ws_server.ts'), 'server');
  eq(layerOfPath('client/src/net/session.ts'), 'client');
  /* 负对照:同名前缀但不是生产层 ⇒ `null`(否则测试/脚本会被算成「另一端」)。 */
  eq(layerOfPath('server/tests/x.ts'), null, '`server/**` 下非 `src/` 不算生产层');
  eq(layerOfPath('shared'), null, '目录名本身不是文件');
  eq(layerOfPath('scripts/verify.ts'), null);
  eq(layerOfPath('tests/WS-FND-99-both-sides-structured.test.ts'), null);
  eq(layerOfPath('client/dist/main.ts'), null, '构建产物不算');
});

report('WS-FND-99');
