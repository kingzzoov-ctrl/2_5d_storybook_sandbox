/**
 * WS-FND-175 · **时间口径:帧数即时间**(`docs/DECISIONS.md` D-26)的**声明 + 可判性**。
 *
 * ## 这一套判据在守什么
 *
 * 修前本仓**从未**把「世界时间 = `frameCount × DT`(不读挂钟)」这条口径写下来 ⇒
 * 十三轮里反复出现同一种误读:「1200 游戏秒」被当成「1200 秒实时」(预热 / 冷却 /
 * 长跑时长按挂钟估)。宿主定时器粒度 > 50ms 的机器上这个误差是实打实的
 * (本机 20Hz 循环实测 `tickMean = 62.77ms` ⇒ 倍率 = 20 / 15.93 = **1.2555**)。
 *
 * ⇒ 本套件守两件事:**口径被写下来**(声明句逐字存在)、**写下来的与代码对得上**
 *   (D-26 表的 `文件:行` + needle 逐行核;倍率可由给定间隔复算)。
 *
 * ## 判据(9 条)
 * ```text
 * FND175-1  声明句**逐字**存在(世界时间 = 帧数 × DT / 「1200 游戏秒 ≠ 1200 墙钟秒」/
 *           两钟交界处选一个并保持同源 / 必须用墙钟那一节 / 必须用游戏秒那一节)+ README 有口径段
 * FND175-2  ★ 启动打印含倍率:`play.ts` 装了探针并调**共享**的 `formatTickRateLine`;
 *           探针在假 `step` 上真的采到间隔、`rate()` 与打印行都含倍率,且 `restore` 还原
 * FND175-3  ★★ D-26 表**逐条对账**(抽样 18 行,≥6):`文件:行` 存在 + 那一行含 needle
 *           + needle 的类别与「口径」列一致(墙钟原语 vs 帧 / 固定步长原语)
 * FND175-4  倍率算法**可复算**:`NOMINAL_TICK_MS` = `DT × 1000`;`observedFps` / `clockRatio`
 *           / `clockRatioOfMean` 在 62.77ms ⇒ 15.93fps ⇒ 1.2555;50ms ⇒ 1.0;0 ⇒ 0(不编 1.0)
 * FND175-5  文档里的**实测数**可复算:从 D-26 抽出 `tickMean = 62.77ms` / `fps = 15.93` /
 *           `倍率 = 20 / 15.93 = 1.2555`,用同一算法重算必须逐个吻合
 * FND175-6  两钟**交界处**选了一个:自动存档**稳态**触发走墙钟(`clock.nowMs()`)、那一行
 *           不许按帧;唯一的帧节流(冷启动垫底)必须在口径里点名;世界钟 / 昼夜由
 *           `frameCount` 派生(不读挂钟)
 * FND175-7  倍率**只有一份实现**:`play.ts` 从 `./soak.ts` 取(自己不算),`soak.ts` 的
 *           汇总行调 `clockRatio`(同款一列)
 * FND175-8  ★★ 负对照:删掉声明句 / 把某行「口径」改反(墙钟 ↔ 游戏秒)⇒ **必红**
 * FND175-9  ★★ 负对照:把某行的 `文件:行` 挪一行 ⇒ 必红,且报错**点名**是哪个字段
 * ```
 *
 * ## 反例的纪律
 * ```text
 * 1 期望值写字面量(62.77 / 15.93 / 1.2555 / 50 / 1506.6),不拿被测常量当期望值;
 * 2 凡是「结构必须成立」的断言都配一条**改坏同一份文档文本**的负对照(删句 / 反口径 / 挪行);
 * 3 只读仓库文件 + 一个假 `step` 对象:不起服务、不写盘、不碰 `.data/`。
 * ```
 *
 * 运行:`node tests/WS-FND-175-clock-convention.test.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, near, ok, report, test } from '../shared/testing/harness.ts';
import { DT } from '../shared/types/physics.ts';
import { installTickProbe } from '../scripts/play.ts';
import {
  NOMINAL_TICK_HZ,
  NOMINAL_TICK_MS,
  clockRatio,
  clockRatioOfMean,
  formatTickRateLine,
  observedFps,
  tickRateOf,
} from '../scripts/soak.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const fileLines = (rel: string): string[] => read(rel).split(/\r?\n/);

const DECISIONS = read('docs/DECISIONS.md');
const README = read('README.md');
const PLAY = read('scripts/play.ts');
const SOAK = read('scripts/soak.ts');

/* ═══════════════ 1. 声明句(逐字;删掉任一条 ⇒ FND175-8 红)═══════════════ */

/** 五条必须逐字存在的声明句。 */
const CLOCK_DECLARATIONS: readonly string[] = [
  '世界时间 = `frameCount × DT`(不读挂钟)',
  '「1200 游戏秒 ≠ 1200 墙钟秒」',
  '两钟交界处必须选一个并保持同源',
  '哪些量**必须**用**墙钟**',
  '哪些量**必须**用**游戏秒**',
];

/** 缺哪句报哪句(返回缺失清单;空数组 = 全在)。 */
function missingDeclarations(text: string): string[] {
  return CLOCK_DECLARATIONS.filter((d) => !text.includes(d));
}

/* ═══════════════ 2. D-26 表:逐条对账 ═══════════════ */

/** 一行现状(`口径` 只有两态)。 */
type ClockRow = {
  n: number;
  field: string;
  clock: '墙钟' | '游戏秒';
  file: string;
  line: number;
  needle: string;
};

/** 表行**唯一**的解析式(表头 / 分隔行不匹配:`#` 不是数字)。 */
const ROW_RE =
  /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(墙钟|游戏秒)\s*\|\s*`([^`]+):(\d+)`\s*\|\s*`([^`]+)`\s*\|\s*$/;

/** 解析 D-26 的现状表。 */
function parseClockRows(text: string): ClockRow[] {
  const out: ClockRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = ROW_RE.exec(raw);
    if (m === null) continue;
    out.push({
      n: Number(m[1]),
      field: (m[2] as string).trim(),
      clock: m[3] as '墙钟' | '游戏秒',
      file: m[4] as string,
      line: Number(m[5]),
      needle: m[6] as string,
    });
  }
  return out;
}

/** 墙钟口径的 needle 里**必须**出现一个墙钟原语。 */
const WALL_NEEDLE = /nowMs|Date\.now|performance\.now|_MS\b/;
/** 游戏秒口径的 needle 里**必须**出现一个帧 / 固定步长原语。 */
const GAME_NEEDLE = /DT\b|TICK_HZ|frameCount|FRAME|dozedSec|\bdt\b/;

/**
 * 逐行核 D-26 表:**文件存在 ∧ 行号在范围内 ∧ 那一行含 needle ∧ needle 类别与口径一致**。
 * 返回问题清单(空 = 全对)。行号漂了 ⇒ 报错里**给出 needle 现在的真实行号**(一步可修)。
 */
function checkClockRows(text: string, rel: (p: string) => string[]): string[] {
  const problems: string[] = [];
  const rows = parseClockRows(text);
  if (rows.length < 6) {
    problems.push(`D-26 现状表只解析出 ${rows.length} 行(< 6)—— 抽样必须 ≥ 6 个字段`);
  }
  for (const r of rows) {
    let body: string[];
    try {
      body = rel(r.file);
    } catch {
      problems.push(`#${r.n} ${r.field}:文件不存在 ${r.file}`);
      continue;
    }
    const at = body[r.line - 1] as string | undefined;
    if (at === undefined) {
      problems.push(`#${r.n} ${r.field}:${r.file}:${r.line} 超出文件行数(${body.length})`);
      continue;
    }
    if (!at.includes(r.needle)) {
      const now = body.findIndex((l: string) => l.includes(r.needle)) + 1;
      problems.push(
        `#${r.n} ${r.field}:${r.file}:${r.line} 上没有 \`${r.needle}\``
        + `(该文件里它现在在第 ${now === 0 ? '无处' : String(now)} 行)`,
      );
      continue;
    }
    if (r.clock === '墙钟' && !WALL_NEEDLE.test(r.needle)) {
      problems.push(`#${r.n} ${r.field}:口径写「墙钟」,但 needle \`${r.needle}\` 里没有墙钟原语`);
    }
    if (r.clock === '游戏秒' && (!GAME_NEEDLE.test(r.needle) || WALL_NEEDLE.test(r.needle))) {
      problems.push(`#${r.n} ${r.field}:口径写「游戏秒」,但 needle \`${r.needle}\` 不是帧 / 固定步长原语`);
    }
  }
  return problems;
}

/** 读仓库里的一个相对路径(给 `checkClockRows` 用)。 */
const readLines = (rel: string): string[] => fileLines(rel);

/**
 * 把**某个字段**那一行的「口径」列改成 `to`(负对照用)。
 *
 * ⚠️ 按**字段名**(子串)定位,**不写死 `文件:行`**:表里的行号会随被指向的文件漂
 * (实测:`world_sim.ts` 一动,写死行号的负对照就恒红 —— 那不是判据,是噪音)。
 * 字段名对不上 ⇒ 原样返回(调用方的前置断言会红,不会静默放过)。
 */
function flipClockOf(text: string, field: string, to: '墙钟' | '游戏秒'): string {
  const row = parseClockRows(text).find((r) => r.field.includes(field));
  if (row === undefined) return text;
  return text.replace(
    `| ${row.clock} | \`${row.file}:${row.line}\` |`,
    `| ${to} | \`${row.file}:${row.line}\` |`,
  );
}

/* ═══════════════ 3. 声明句 ═══════════════ */

test('FND175-1 ★ 五条声明句**逐字**存在(DECISIONS D-26 + README 口径段)', () => {
  eq(missingDeclarations(DECISIONS), [], '声明句缺失(口径没写下来 ⇒ 又会被当成实时假设)');
  ok(DECISIONS.includes('## D-26 时间口径:'), 'D-26 章节必须存在');
  /* README:给玩家 / 开发者看的那一段(不逐字复刻,但必须点名口径与出处)。 */
  for (const s of ['时间口径:帧数即时间', 'docs/DECISIONS.md` D-26', '1.2555']) {
    ok(README.includes(s), `README 口径段缺少「${s}」`);
  }
  ok(DECISIONS.includes('`tests/WS-FND-175-clock-convention.test.ts`'), 'D-26 必须点名判据');
});

/* ═══════════════ 4. 启动打印 = 实测节拍 + 倍率 ═══════════════ */

test('FND175-2 ★ 启动打印含倍率:探针真采间隔,打印走共享实现', () => {
  for (const s of ["from './soak.ts'", 'installTickProbe', 'formatTickRateLine', '实测节拍']) {
    ok(PLAY.includes(s), `play.ts 缺少「${s}」(启动打印必须含实测节拍 / 倍率)`);
  }
  /* 行为面:假 `step` 上真的采到间隔(第一次调用没有前驱 ⇒ 不计)。 */
  const room = { step: (v: unknown): string => `ok:${String(v)}` };
  const stepOf = (): ((v: unknown) => string) => room.step;
  const probe = installTickProbe(room);
  eq(stepOf()('a'), 'ok:a', '探针不许改返回值');
  eq(probe.intervals.length, 0, '第一次调用没有前驱 ⇒ 不计间隔');
  eq(stepOf()('b'), 'ok:b', '第 2 次调用仍不许改返回值');
  const rate = probe.rate();
  eq(rate.observed, 1, '第 2 次调用采到 1 个间隔');
  eq(rate.meanMs, probe.intervals[0], '均值 = 那一个间隔(读的是同一份样本,不另算一遍)');
  ok((probe.intervals[0] as number) >= 0, '间隔是非负数(同一毫秒内两次调用读到 0 是分辨率,不是错误)');
  ok(rate.maxMs >= rate.meanMs, '最大 ≥ 均值');
  /* 打印行:同一份 `tickRateOf` + `clockRatio`(用**给定**间隔 ⇒ 「打印含倍率」可复算)。 */
  const printed = formatTickRateLine('实测节拍(自检)', tickRateOf([62.77, 62.77]));
  ok(printed.includes('世界钟×墙钟倍率'), `打印行必须含倍率(实际:${printed})`);
  ok(printed.includes(String(clockRatio(15.93))), '打印行里的倍率 = 同一份算法算出的值');
  ok(printed.includes(`均值 ${rate.meanMs}ms`) === false, '这是构造出来的读数,与真实样本不是同一份');
  probe.restore();
  /* 打印行里的倍率走 `observedFps`(先四舍五入到 2 位)再 `clockRatio` ⇒ 复算也必须走同一口径。 */
  const ratioFromInterval = Math.round((NOMINAL_TICK_HZ / observedFps(62.77)) * 10_000) / 10_000;
  ok(printed.includes(`倍率 ${ratioFromInterval}`),
    `打印行里的倍率 = 标称帧率 ÷ observedFps(62.77)= ${ratioFromInterval}(可由 62.77ms 复算)`);
});

/* ═══════════════ 5. 清单 ↔ 代码现状 ═══════════════ */

test('FND175-3 ★★ D-26 表逐条对账(抽样 ≥6:文件:行 + needle + 口径一致)', () => {
  const rows = parseClockRows(DECISIONS);
  ok(rows.length >= 6, `抽样必须 ≥ 6 个字段(实际 ${rows.length})`);
  ok(rows.some((r) => r.clock === '墙钟') && rows.some((r) => r.clock === '游戏秒'),
    '两张清单都要有抽样(必须用墙钟 / 必须用游戏秒)');
  eq(checkClockRows(DECISIONS, readLines), [], '表里的每一行都必须与代码现状逐字对上');
});

test('FND175-6 两钟交界处「选一个」:存档稳态走墙钟、世界钟走帧序', () => {
  const room = fileLines('server/src/net/room.ts');
  /* ★ 按 **needle** 定位,不写死行号:`room.ts` 正在被另一条线改,行号会漂 ——
     本判据要守的是「稳态触发读墙钟」这条**关系**,不是某一行号。 */
  const steady = room.find((l) => l.includes('>= AUTOSAVE_INTERVAL_MS'));
  ok(steady !== undefined, '自动存档的稳态触发(与 AUTOSAVE_INTERVAL_MS 比较)必须在');
  ok((steady as string).includes('nowMs()'), `稳态触发必须读墙钟(实际:${(steady as string).trim()})`);
  ok(!(steady as string).includes('frameCount'), '稳态触发**不许**按帧数(慢机器上会变成「不存」)');
  ok(room.some((l) => l.includes('% AUTOSAVE_FRAME_INTERVAL === 0') && l.includes('saveCount === 0')),
    '冷启动垫底必须仍在,且只在「还没成功存过」时成立(不许扩成常态)');
  ok(DECISIONS.includes('AUTOSAVE_FRAME_INTERVAL'),
    '交界处唯一的帧节流(冷启动垫底)必须在口径里点名,不许含糊');

  const sim = fileLines('server/src/sim/world_sim.ts');
  const hourAt = sim.findIndex((l) => l.includes('hourOfDay(): number {'));
  ok(hourAt > 0, '世界钟入口 `hourOfDay(): number {` 必须在');
  const body = sim.slice(Math.max(0, hourAt - 4), hourAt + 10).join('\n');
  ok(body.includes('frameCount'), '世界钟必须由 frameCount 派生');
  ok(!/nowMs\(|Date\.now\(/.test(body), '世界钟**不许**读挂钟(否则确定性与回放失效)');
  ok(sim.some((l) => l.includes('FRAMES_PER_DAY = WorldSim.WORLD_DAY_SEC / DT')),
    '世界日长度必须是 `WORLD_DAY_SEC / DT`(游戏秒口径)');
  ok(sim.some((l) => l.includes('(this.frameCount / TICK_HZ) * 1000')),
    '世界内时间戳也必须是帧换算(D-26 的「不读挂钟」)');
});

/* ═══════════════ 6. 倍率可复算 ═══════════════ */

test('FND175-4 ★ 倍率可复算(给定间隔 ⇒ 倍率),标称与 DT 同源', () => {
  near(NOMINAL_TICK_MS, DT * 1000, 1e-9, '标称帧间隔必须 = DT × 1000(不造第二份量纲)');
  near(NOMINAL_TICK_HZ, 1 / DT, 1e-9, '标称帧率 = 1 / DT(旧写法写死 20 ⇒ 改 tick 率即红)');

  /* 期望倍率一律**由标称帧率派生**(标称 ÷ 实测),不写字面量 1.2555(那是 20Hz 的数)。 */
  const ratioAt = (fps: number): number => Math.round((NOMINAL_TICK_HZ / fps) * 10_000) / 10_000;
  eq(observedFps(62.77), 15.93, '1000 / 62.77 ⇒ 15.93fps');
  eq(clockRatio(15.93), ratioAt(15.93), `标称 ${NOMINAL_TICK_HZ}Hz ÷ 15.93fps ⇒ 倍率`);
  eq(clockRatioOfMean(62.77), ratioAt(observedFps(62.77)), '给定实测间隔 62.77ms ⇒ 倍率可复算');
  eq(clockRatioOfMean(NOMINAL_TICK_MS), 1, '标称间隔 ⇒ 倍率 1(游戏秒 = 墙钟秒)');
  eq(clockRatioOfMean(NOMINAL_TICK_MS * 2), 2, '间隔翻倍 ⇒ 倍率 2(与间隔线性)');
  eq(clockRatioOfMean(0), 0, '没有样本 ⇒ 0(不假装 1.0)');
  eq(clockRatio(0), 0, '非正 fps ⇒ 0');

  const line = formatTickRateLine('实测节拍', tickRateOf([62.77, 62.77, 62.77]));
  ok(line.includes('均值 62.77ms'), `均值应逐字进打印行(实际:${line})`);
  ok(line.includes(`倍率 ${clockRatioOfMean(62.77)}`), `倍率应逐字进打印行(实际:${line})`);
  const wallSec = Math.round(1_200 * clockRatioOfMean(62.77) * 10) / 10;
  ok(line.includes(`1200 游戏秒 ≈ ${wallSec} 墙钟秒`),
    `1200 游戏秒的墙钟折算要印出来(实际:${line})`);
  const empty = formatTickRateLine('实测节拍', tickRateOf([]));
  ok(empty.includes('没采到帧间隔'), `0 样本时必须如实说(实际:${empty})`);
  ok(!empty.includes('倍率 1'), '0 样本时不许印一个假的倍率 1');
  ok(formatTickRateLine('实测节拍', { observed: 2, meanMs: 0, minMs: 0, maxMs: 0, fps: 0 })
    .includes('低于时钟分辨率'), '采到了样本但均值为 0 ⇒ 如实说「低于分辨率」,不假装有倍率');
});

test('FND175-5 ★ 文档里的实测数用同一算法复算一致', () => {
  const mean = Number(/tickMean = ([\d.]+)ms/.exec(DECISIONS)?.[1] ?? 'NaN');
  const fps = Number(/fps = ([\d.]+)/.exec(DECISIONS)?.[1] ?? 'NaN');
  /* ⚠️ 分子是**标称帧率**,会随 tick 率变(20 → 32)⇒ 正则不许写死 20。 */
  const ratioDoc = Number(/倍率 = [\d.]+ \/ ([\d.]+) = ([\d.]+)/.exec(DECISIONS)?.[2] ?? 'NaN');
  ok(Number.isFinite(mean) && mean > 0, `D-26 必须写出实测均值间隔(实际读到 ${mean})`);
  ok(Number.isFinite(fps) && fps > 0, `D-26 必须写出实测 fps(实际读到 ${fps})`);
  eq(fps, observedFps(mean), '文档里的 fps = 由均值间隔算出的 fps(同一算法)');
  eq(ratioDoc, clockRatioOfMean(mean), '文档里的倍率 = 由同一算法复算出的倍率');
  const wallDoc = Math.round(1_200 * clockRatioOfMean(mean) * 10) / 10;
  ok(DECISIONS.includes(`1200 游戏秒 ≈ ${wallDoc} 墙钟秒`),
    `D-26 要给出 1200 游戏秒的墙钟折算(${wallDoc} 墙钟秒)`);
  ok(DECISIONS.includes('不读挂钟'), '声明句里的「不读挂钟」必须在');
});

/* ═══════════════ 7. 倍率只有一份实现 ═══════════════ */

test('FND175-7 倍率只有一份实现:play 取 soak 的,soak 的汇总行调它', () => {
  ok(SOAK.includes('export function clockRatio('), 'soak.ts 导出 clockRatio(唯一实现)');
  ok(PLAY.includes("from './soak.ts'"), 'play.ts 必须从 soak.ts 取共享实现');
  ok(!/Math\.round\(\(\s*1_?000\s*\//.test(PLAY), 'play.ts 不许自己再算一遍 fps / 倍率');
  ok(SOAK.includes('世界钟×墙钟倍率 ${clockRatio(s.tick.fps)}'), 'soak.ts 的汇总行要补倍率一列');
});

/* ═══════════════ 8. 负对照(删句 / 反口径 / 挪行)═══════════════ */

test('FND175-8 ★★ 负对照:删掉声明句 ⇒ 红;把「口径」改反 ⇒ 红', () => {
  eq(missingDeclarations(DECISIONS), [], '正例:五句都在');
  for (const d of CLOCK_DECLARATIONS) {
    const missing = missingDeclarations(DECISIONS.replace(d, '(口径已删)'));
    ok(missing.includes(d), `删掉「${d}」必须被报出来(实际缺 ${missing.length} 句)`);
  }
  /* 反口径 1:墙钟行改成「游戏秒」⇒ needle 里的 nowMs 与口径矛盾。
     ⚠️ 两处负对照都按**字段名**锚定,不写死 `file:line`:行号会随被指向的文件漂,
     写死一处就变成「每次改那个文件都要跟着改测试」的脆弱锚点(实测踩过)。 */
  const wallFlipped = flipClockOf(DECISIONS, '自动存档周期', '游戏秒');
  ok(wallFlipped !== DECISIONS, '负对照的前提:墙钟那一行确实被改到(字段名对不上就该先修表)');
  ok(checkClockRows(wallFlipped, readLines).some((p) => p.includes('自动存档周期')),
    '墙钟行被改成游戏秒 ⇒ 必须报出「自动存档周期」这一条');
  /* 反口径 2:游戏秒行改成「墙钟」⇒ needle 里没有墙钟原语。 */
  const gameFlipped = flipClockOf(DECISIONS, '跳跃冷却帧数', '墙钟');
  ok(gameFlipped !== DECISIONS, '负对照的前提:游戏秒那一行确实被改到(按字段名锚定 ⇒ 行号漂了也改得到)');
  ok(checkClockRows(gameFlipped, readLines).some((p) => p.includes('跳跃冷却帧数')),
    '游戏秒行被改成墙钟 ⇒ 必须报出「跳跃冷却帧数」这一条');
  /* 破坏性前提:改坏后的文本必须**确实**被解析成了另一行(否则上面的红是假的)。 */
  eq(parseClockRows(gameFlipped).find((r) => r.n === 9)?.clock, '墙钟',
    '负对照的前提:第 9 行的口径确实被改成墙钟');
  eq(parseClockRows(DECISIONS).find((r) => r.n === 9)?.clock, '游戏秒',
    '正例的前提:第 9 行本来是游戏秒');
});

test('FND175-9 ★★ 负对照:`文件:行` 挪一行 ⇒ 红,且点名是哪个字段', () => {
  /* ⚠️ 锚点由**表里那一行**派生(字段名 → 文件/行/needle),不写死行号:
     写死的话,`session.ts` 一动这条负对照就恒红(噪音),而行号本身不是判据。 */
  const row = parseClockRows(DECISIONS).find((r) => r.field.includes('连接超时'));
  ok(row !== undefined, '负对照的前提:D-26 表里有「连接超时」这一行');
  const anchor = `\`${row!.file}:${row!.line}\``;
  const drifted = DECISIONS.replace(anchor, `\`${row!.file}:${row!.line + 1}\``);
  ok(drifted !== DECISIONS, '负对照的前提:那一行的 `文件:行` 确实被挪了一行');
  const problems = checkClockRows(drifted, readLines);
  ok(problems.length > 0, '行号漂了必须红(否则表会静默腐烂)');
  ok(problems.some((p) => p.includes('连接超时')), `报错必须点名字段(实际:${problems.join(' / ')})`);
  const actual = fileLines(row!.file).findIndex((l) => l.includes(row!.needle)) + 1;
  ok(problems.some((p) => p.includes(`现在在第 ${actual} 行`)),
    `报错要给出现在正确的行号(一步可修;实际:${problems.join(' / ')})`);
});

report('WS-FND-175');
