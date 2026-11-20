/**
 * WS-FND-170 —— **canvas 可读性残留**与**浏览器基线**(上一轮留下的两个洞)。
 *
 * ```text
 * 1 画布那一层还挂着 9 / 10 / 11 / 12px 字号与手写 rgba 描边
 *   (cellEdge ≈1.52:1、panelEdge ≈2.09:1),而 DOM 层的基线是 13px + #7f9dc9
 *   ⇒ **同一个屏幕两套可读口径**,而且没有任何东西钉住"两处同源"。
 * 2 `vite.config.ts` 的 `build.target = es2022`(允许 `??=` / `Array.prototype.at` /
 *   `Object.hasOwn` / `structuredClone`)、没有 import maps、也不装 polyfill
 *   ⇒ 基线在哪、以及"缺了会整页白"的那个 API 怎么降级,此前一条断言都没有。
 * ```
 *
 * ## 判据设计纪律(与 `WS-FND-150` / `-163` / `-167` 同款)
 * ```text
 * 1 从**生产入口**出发:`ui/a11y.ts` 的真导出 + `ui_binding.ts` / `vite.config.ts` / README 的**真源码**;
 * 2 每条都配**负对照**:把修前那个值注入回去 ⇒ **同一个检测器**必须报红;
 * 3 文本类判据一律**剥注释**后断言(注释里的同一句话会把判据撑绿);
 * 4 不测"参数被传进去",只测"缺 API 时降级真的发生 / 横幅真的写进 DOM"。
 * ```
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  A11Y_BAD, A11Y_BG, A11Y_DIM, A11Y_EDGE, A11Y_MONO_STACK, A11Y_OK, A11Y_PANELS, A11Y_TEXT,
  BASELINE_REQUIRED_APIS, BROWSER_BASELINE_TEXT, CANVAS_FONT_PX, CANVAS_PANEL_FILL_ALPHA,
  MIN_NON_TEXT_CONTRAST, MIN_TEXT_CONTRAST, MIN_TEXT_PX,
  blendOver, browserBaselineReport, canvasFontText, contrastRatio, createA11yMirror,
  installStructuredCloneFallback, missingBaselineApis, rgbaOf, structuredCloneFallback,
} from '../client/src/ui/a11y.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** 剥注释(口径与 `WS-FND-138` / `-145` / `-151` / `-167` 一致:`//` 前排除 `:`)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ═══════════════════ 画布源码的两组结构判据 ═══════════════════ */

const CANVAS_SRC = stripComments(read('client/src/three/ui_binding.ts'));

/** 画布的可读性口径**只许**来自 `ui/a11y.ts`:`import` 缺了 ⇒ 后面全部判据都失去意义。 */
function canvasImports(src: string): string[] {
  const p: string[] = [];
  if (!/from '\.\.\/ui\/a11y\.ts'/.test(src)) p.push("没有 import '../ui/a11y.ts'(画布又在各写一份)");
  for (const name of ['A11Y_EDGE', 'A11Y_TEXT', 'A11Y_DIM', 'A11Y_OK', 'A11Y_BAD', 'A11Y_BG',
    'A11Y_MONO_STACK', 'CANVAS_FONT_PX', 'CANVAS_PANEL_FILL_ALPHA', 'canvasFontText', 'rgbaOf']) {
    if (!src.includes(name)) p.push(`没 import / 没用 ${name}`);
  }
  return p;
}

/** 所有 `ctx.font = ...` 的右值(去重前的原始列表)。 */
function fontAssignments(src: string): string[] {
  return [...src.matchAll(/ctx\.font\s*=\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim());
}

/**
 * 画布字号的问题清单(空 = 达标)。
 *
 * ★ 判据的核心不是"13 是不是 ≥13",而是**只有一个来源**:
 *   所有 `ctx.font` 必须赋同一个 `FONT`,而 `FONT` 必须由 a11y 的 `canvasFontText(CANVAS_FONT_PX)` 派生。
 */
function canvasFontProblems(src: string): string[] {
  const p: string[] = [];
  const assigns = fontAssignments(src);
  if (assigns.length === 0) { p.push('没有任何 `ctx.font = ...`(判据会恒真)'); return p; }
  for (const v of new Set(assigns)) {
    if (v !== 'FONT') p.push(`画布字号不是 FONT 而是 ${v}(字号只许来自 ui/a11y.ts)`);
  }
  if (!/const FONT = canvasFontText\(CANVAS_FONT_PX\)/.test(src)) {
    p.push('`const FONT` 不是从 `canvasFontText(CANVAS_FONT_PX)` 派生的');
  }
  if (!/const MONO = A11Y_MONO_STACK/.test(src)) p.push('字体栈不是 `A11Y_MONO_STACK`(两处各写一份会静默分叉)');
  if (/\d+px/.test(src)) p.push('画布源码里还有 px **字面量**(字号必须是常量)');
  return p;
}

/** `const C = { ... } as const;` 那一段(只在这一段里找配色赋值)。 */
function paletteBlock(src: string): string {
  const i = src.indexOf('const C = {');
  const j = i < 0 ? -1 : src.indexOf('} as const;', i);
  return i < 0 || j < 0 ? '' : src.slice(i, j);
}

/** 该键的**原始值文本**(`A11Y_EDGE` 或 `'rgba(...)'`);找不到 ⇒ null。
 *  ⚠️ 引号里的值可能含逗号(`rgba(255,220,140,.95)`)⇒ 先按整串引号匹配,再退回到"到逗号为止"。 */
function paletteValue(block: string, key: string): string | null {
  const m = new RegExp(`\\n\\s*${key}:\\s*('(?:[^']*)'|[^,\\n]+),`).exec(block);
  return m?.[1] === undefined ? null : m[1].trim();
}

/** `A11Y_xxx` 标识符 ⇒ 对应的真色值;不是标识符(字面量)⇒ null。 */
function a11yConstantOf(value: string): string | null {
  if (!/^A11Y_(TEXT|DIM|EDGE|OK|BAD|BG)$/.test(value)) return null;
  const map: Record<string, string> = { A11Y_TEXT, A11Y_DIM, A11Y_EDGE, A11Y_OK, A11Y_BAD, A11Y_BG };
  return map[value] ?? null;
}

/** `rgba(r,g,b,a)` 按 `bg` 混掉(手写半透明描边正是修前的形态)⇒ 实色 `#rrggbb`。 */
function effectiveAgainst(color: string, bg: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(color);
  if (m === null) return color;
  const hex = `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('')}`;
  return blendOver(hex, Number(m[4]), bg);
}

/**
 * 画布配色的两组口径:
 * ```text
 * 同源组 panelEdge / cellEdge / title / dim / ok / bad
 *         —— 必须是 `A11Y_*` 常量(描边与文字色属于 a11y 常量表的职责)
 * 对比组 hot / tabOn / hotGhostLine / hp
 *         —— 允许留字面量(交互 / 状态色,不在本轮改色域内),但≥3:1 **必须**成立
 * ⚠️ 明确不在判据里:cellBg(纯填充底色)、hpGhost(血条残影)——
 *    它们不表达"要看见的边界/文字",放进来只会让判据长得像很严。
 * ```
 * 下限一律按**最坏情况的面板底**(`CANVAS_PANEL_FILL_ALPHA` 叠白场景)算,不是拿 `A11Y_BG` 自己算。
 */
const SAME_SOURCE_KEYS: readonly string[] = ['panelEdge', 'cellEdge', 'title', 'dim', 'ok', 'bad'];
const CONTRAST_ONLY_KEYS: readonly string[] = ['hot', 'tabOn', 'hotGhostLine', 'hp'];

function canvasPaletteProblems(src: string): string[] {
  const p: string[] = [];
  const block = paletteBlock(src);
  if (block === '') return ['找不到 `const C = { ... } as const;`(判据会恒真)'];
  const worst = blendOver(A11Y_BG, CANVAS_PANEL_FILL_ALPHA, '#ffffff');
  for (const key of [...SAME_SOURCE_KEYS, ...CONTRAST_ONLY_KEYS]) {
    const raw = paletteValue(block, key);
    if (raw === null) { p.push(`配色里没有 ${key}(被删掉等于判据变少)`); continue; }
    const viaConst = a11yConstantOf(raw);
    const color = viaConst ?? (/^'[^']*'$/.test(raw) ? raw.slice(1, -1) : raw);
    if (SAME_SOURCE_KEYS.includes(key) && viaConst === null) {
      p.push(`${key} 用了字面量 ${raw}(颜色必须来自 ui/a11y.ts 的常量)`);
    }
    const ratio = contrastRatio(effectiveAgainst(color, worst), worst);
    const need = key === 'panelEdge' || key === 'cellEdge' || CONTRAST_ONLY_KEYS.includes(key)
      ? MIN_NON_TEXT_CONTRAST : MIN_TEXT_CONTRAST;
    if (!(ratio >= need)) {
      p.push(`${key} ${color} 压最坏面板底 ${worst} 只有 ${ratio.toFixed(2)}:1(需 ≥ ${need}:1)`);
    }
  }
  return p;
}

/* ═══════════════════ 1 字号同源 ═══════════════════ */

function fontCases(): void {
  test('FND170-1 ★ 画布字号与 a11y 常量**同源**:每个 ctx.font 都是 FONT,而 FONT 由 canvasFontText(CANVAS_FONT_PX) 派生', () => {
    eq(MIN_TEXT_PX, 13, '锚点:可读基线 = 13px(下面全部写死这个数)');
    eq(CANVAS_FONT_PX, 13, '锚点:画布字号常量 = 13px');
    eq(canvasImports(CANVAS_SRC), [], '画布必须 import a11y 的常量,不许各写一份');
    eq(canvasFontProblems(CANVAS_SRC), [], '画布字号:全部经 FONT + 零 px 字面量');

    const assigns = fontAssignments(CANVAS_SRC);
    ok(assigns.length >= 20, `前提:画布真有这么多处字号(实测 ${assigns.length} 处;少了说明判据扫不到)`);
    eq([...new Set(assigns)], ['FONT'], '★ 22 处字号是**同一个**来源(不是各写各的)');

    /* ── 负对照 1:把任意一处换回修前的 10px 字面量 ⇒ 同一个检测器必须报红 ── */
    const injected = CANVAS_SRC.replace('ctx.font = FONT;', 'ctx.font = `10px ${MONO}`;');
    ok(injected !== CANVAS_SRC, '前提:源码里确实有 `ctx.font = FONT;`');
    ok(canvasFontProblems(injected).some((x) => x.includes('画布字号不是 FONT')),
      '★ 塞回 10px 字面量 ⇒ 报红(说明这条判据不是恒真)');
    /* ── 负对照 2:把 FONT 的实参从常量改成数字 ⇒ 报红 ── */
    const numArg = CANVAS_SRC.replace('canvasFontText(CANVAS_FONT_PX)', 'canvasFontText(12)');
    ok(numArg !== CANVAS_SRC, '前提:派生处写的是常量');
    ok(canvasFontProblems(numArg).some((x) => x.includes('canvasFontText(CANVAS_FONT_PX)')),
      '★ 改成写死数字 ⇒ 报红(否则"同源"只是注释里的一句话)');
  });

  test('FND170-2 ★ 字号串与字体栈由 a11y 给:非法 / 过小的 px 回落到基线(不许变小);负对照:12px 不许原样通过', () => {
    ok(canvasFontText().startsWith('13px '), `画布默认字号串以 13px 开头,实际:${canvasFontText()}`);
    eq(canvasFontText().slice('13px '.length), A11Y_MONO_STACK, '字体栈来自 A11Y_MONO_STACK(与 DOM 层同一份)');
    eq(canvasFontText(15), `15px ${A11Y_MONO_STACK}`, '合法的更大字号原样通过');
    /* ★ 回落方向必须是"变大不许变小":低于基线 / 非法的入参一律回落到 13px */
    ok(canvasFontText(9).startsWith('13px '), `9px 回落到基线,实际:${canvasFontText(9)}`);
    ok(canvasFontText(12).startsWith('13px '), `12px 回落到基线,实际:${canvasFontText(12)}`);
    ok(!canvasFontText(12).includes('12px'), '★ 负对照:12px **不许**原样通过(这正是修前分类标签的档位)');
    ok(canvasFontText(Number.NaN).startsWith('13px '), 'NaN ⇒ 基线');
  });
}

/* ═══════════════════ 2 描边同源 + 对比度 ═══════════════════ */

function edgeCases(): void {
  test('FND170-3 ★ 画布两道描边 = A11Y_EDGE(不是字面量),且过 WCAG 1.4.11(3:1);负对照:同色字面量必须被判"不同源"', () => {
    const block = paletteBlock(CANVAS_SRC);
    eq(paletteValue(block, 'panelEdge'), 'A11Y_EDGE', 'panelEdge 是 a11y 的常量,不是手写 rgba');
    eq(paletteValue(block, 'cellEdge'), 'A11Y_EDGE', 'cellEdge 同上(修前是 rgba(140,170,225,.22) ≈1.52:1)');
    eq(canvasPaletteProblems(CANVAS_SRC), [], '画布配色:同源 + 对比度两条都达标');

    /* ★ 对比度要按**最坏情况**算:面板底是半透明的,压在白场景上最亮 */
    const worst = blendOver(A11Y_BG, CANVAS_PANEL_FILL_ALPHA, '#ffffff');
    ok(worst !== A11Y_BG, '前提:最坏面板底 ≠ 纯底色(半透明面板必须按混合色算)');
    const rWorst = contrastRatio(A11Y_EDGE, worst);
    ok(rWorst >= 3, `★ 描边压最坏面板底 ${worst} = ${rWorst.toFixed(2)}:1(需 ≥ 3:1)`);
    ok(contrastRatio(A11Y_EDGE, A11Y_BG) >= 3, `描边压底色 = ${contrastRatio(A11Y_EDGE, A11Y_BG).toFixed(2)}:1`);

    /* ── 负对照 1:**值一模一样**但写成字面量 ⇒ "同源"这条必须红(证明判据区分"值达标"与"同源") ── */
    const asLiteral = CANVAS_SRC.replace('panelEdge: A11Y_EDGE,', "panelEdge: '#7f9dc9',");
    ok(asLiteral !== CANVAS_SRC, '前提:panelEdge 走常量');
    const lit = canvasPaletteProblems(asLiteral);
    ok(lit.some((x) => x.includes('必须来自 ui/a11y.ts')),
      `★ 同色字面量 ⇒ "不同源"报红(实际:${lit.join(' / ') || '没报'})`);
    ok(!lit.some((x) => x.includes('只有')), '★ 而同色的对比度仍然合格 —— 两条判据不同义,不能互相顶替');

    /* ── 负对照 2:把修前那个 rgba 塞回去 ⇒ 对比度必须被判红(1.x:1) ── */
    const oldEdge = CANVAS_SRC.replace('panelEdge: A11Y_EDGE,', "panelEdge: 'rgba(120,150,210,.42)',");
    ok(oldEdge !== CANVAS_SRC, '前提:确实替换成功');
    const old = canvasPaletteProblems(oldEdge);
    ok(old.some((x) => x.includes('panelEdge') && x.includes('只有')),
      `★ 修前的 rgba 描边必须被判红(实际:${old.join(' / ') || '没报'})`);
    /* ── 负对照 3:状态色也不能掉到 3:1 以下(对比组有牙) ── */
    const dimmed = CANVAS_SRC.replace("hot: 'rgba(255,220,140,.95)',", "hot: 'rgba(255,220,140,.06)',");
    ok(dimmed !== CANVAS_SRC, '前提:确实替换成功');
    ok(canvasPaletteProblems(dimmed).some((x) => x.includes('hot') && x.includes('只有')),
      '★ 把 hot 的不透明度压到 .06 ⇒ 报红');
  });

  test('FND170-4 ★ 文字色也同源且压最坏面板底 ≥4.5:1;负对照:低对比字面量必须报红', () => {
    const block = paletteBlock(CANVAS_SRC);
    eq(paletteValue(block, 'title'), 'A11Y_TEXT', '标题色 = A11Y_TEXT(修前是手写 #e8eefc)');
    eq(paletteValue(block, 'dim'), 'A11Y_DIM', '次级文本 = A11Y_DIM(与 HUD 的次级文本同一份)');
    eq(paletteValue(block, 'ok'), 'A11Y_OK', '正常态 = A11Y_OK');
    eq(paletteValue(block, 'bad'), 'A11Y_BAD', '异常态 = A11Y_BAD');
    const worst = blendOver(A11Y_BG, CANVAS_PANEL_FILL_ALPHA, '#ffffff');
    for (const [name, color] of [['A11Y_TEXT', A11Y_TEXT], ['A11Y_DIM', A11Y_DIM],
      ['A11Y_OK', A11Y_OK], ['A11Y_BAD', A11Y_BAD]] as const) {
      const r = contrastRatio(color, worst);
      ok(r >= 4.5, `${name} 压最坏面板底 = ${r.toFixed(2)}:1(需 ≥ 4.5:1)`);
    }
    /* ── 负对照:换一个压得住的字面量(深蓝灰)⇒ 报红 ── */
    const lowContrast = CANVAS_SRC.replace('title: A11Y_TEXT,', "title: '#3a4a63',");
    ok(lowContrast !== CANVAS_SRC, '前提:title 走常量');
    const problems = canvasPaletteProblems(lowContrast);
    ok(problems.some((x) => x.includes('title') && x.includes('只有')),
      `★ 低对比字面量 ⇒ 报红(实际:${problems.join(' / ') || '没报'})`);
  });

  test('FND170-5 ★ rgbaOf 只派生合法色:非法 hex 原样返回(不许"编"一个合法色);负对照:非法色必须被对比度判红', () => {
    eq(rgbaOf('#1279d3', 0.5), 'rgba(18,121,211,0.5)', '合法 hex ⇒ rgba');
    eq(rgbaOf(A11Y_BG, CANVAS_PANEL_FILL_ALPHA), rgbaOf('#121a2b', 0.94), '面板底由 A11Y_BG 派生');
    eq(rgbaOf('#zzzzzz', 0.5), '#zzzzzz', '★ 非法 hex 原样返回(编一个合法色会让假色值静默通过)');
    eq(rgbaOf('#121a2b', 9), 'rgba(18,26,43,1)', 'alpha 越界 ⇒ 夹到 1');
    eq(contrastRatio(rgbaOf('#121a2b', 1), A11Y_BG), 0,
      '★ 负对照:rgba 串不是 hex ⇒ 对比度 = 0(必然判红),而不是被当成合格');
    /* 混合函数与 WCAG 公式方向一致:同色混合 ⇒ 1:1 */
    eq(contrastRatio(blendOver(A11Y_BG, 0.5, A11Y_BG), A11Y_BG), 1, '同色混合 = 1:1');
  });
}

/* ═══════════════════ 3 浏览器基线(README + vite target) ═══════════════════ */

/** README 基线一节的问题清单(空 = 达标)。 */
function readmeBaselineProblems(readme: string): string[] {
  const p: string[] = [];
  if (!readme.includes('## 浏览器兼容性基线')) p.push('README 没有「浏览器兼容性基线」一节');
  if (!readme.includes(BROWSER_BASELINE_TEXT)) {
    p.push('README 的基线句与 `BROWSER_BASELINE_TEXT` 不一致(抄错即红)');
  }
  for (const kw of ['必须走 Vite 构建', 'dist/client', '白屏', 'import maps', 'structuredClone', 'es2022']) {
    if (!readme.includes(kw)) p.push(`README 基线一节缺关键词:${kw}`);
  }
  if (!readme.includes('client/src/ui/a11y.ts')) p.push('README 没指向降级的落点(a11y.ts)');
  return p;
}

/** vite 配置里的构建 target(`BUILD_TARGET = '...'`);读不到 ⇒ null。 */
function buildTargetOf(src: string): string | null {
  return /BUILD_TARGET = '([^']+)'/.exec(src)?.[1] ?? null;
}

/** 构建 target 与 README / a11y 的基线句是否自洽。 */
function baselineConsistencyProblems(viteSrc: string, readme: string): string[] {
  const p: string[] = [];
  const tgt = buildTargetOf(viteSrc);
  if (tgt === null) { p.push('vite.config.ts 里没有 BUILD_TARGET 常量(基线的构建侧口径无处可查)'); return p; }
  if (tgt !== 'es2022') p.push(`构建 target = ${tgt},而 README / a11y 的基线句写的是 es2022`);
  if (!viteSrc.includes('target: BUILD_TARGET')) p.push('`build.target` 没用上 BUILD_TARGET(两处会漂)');
  if (!readme.includes(`构建 target = ${tgt}`)) p.push(`README 没写「构建 target = ${tgt}」`);
  if (!BROWSER_BASELINE_TEXT.includes(`构建 target = ${tgt}`)) {
    p.push('`BROWSER_BASELINE_TEXT` 没写构建 target');
  }
  return p;
}

function baselineCases(): void {
  test('FND170-6 ★ README 有明确的基线段(逐字引用 a11y 的基线句 + 「必须走 Vite 构建」);删掉任一处 ⇒ 报红', () => {
    const readme = read('README.md');
    eq(readmeBaselineProblems(readme), [], 'README 基线一节:基线句 / 构建方式 / 白屏成因 / 风险 API 都要有');
    const section = readme.indexOf('## 浏览器兼容性基线');
    ok(section > 0, '前提:有这一节');
    ok(readme.indexOf('## 目录结构') > section, '★ 基线段在目录结构之前(不是藏在末尾)');

    /* ── 负对照 1:把基线句改一个字 ⇒ 逐字比对必须红 ── */
    const typo = readme.replace(BROWSER_BASELINE_TEXT, BROWSER_BASELINE_TEXT.replace('Chrome 98+', 'Chrome 99+'));
    ok(typo !== readme, '前提:README 里确实是那句原文');
    ok(readmeBaselineProblems(typo).some((x) => x.includes('不一致')), '★ 抄错一个版本号 ⇒ 报红');
    /* ── 负对照 2:删掉「必须走 Vite 构建」⇒ 报红 ── */
    const noBuild = readme.split('必须走 Vite 构建').join('');
    ok(noBuild !== readme, '前提:那句确实在');
    ok(readmeBaselineProblems(noBuild).some((x) => x.includes('Vite 构建')), '★ 删掉构建要求 ⇒ 报红');
  });

  test('FND170-7 ★ 构建 target 与基线句自洽(es2022 ⇒ 允许 ??= / .at / Object.hasOwn / structuredClone);改成 es2017 ⇒ 报红', () => {
    const viteSrc = read('vite.config.ts');
    const readme = read('README.md');
    eq(buildTargetOf(viteSrc), 'es2022', '锚点:构建 target = es2022(基线就是它定义的)');
    ok(viteSrc.includes('target: BUILD_TARGET'), '`build.target` 读同一个常量');
    ok(viteSrc.includes('structuredClone') && viteSrc.includes('import maps'),
      'vite 配置里写明"这个 target 允许什么 / 为什么没有 polyfill"');
    eq(baselineConsistencyProblems(viteSrc, readme), [], 'target / README / a11y 三处自洽');

    /* ── 负对照:target 改成 es2017 ⇒ 与基线句不再自洽 ── */
    const downgraded = viteSrc.replace("BUILD_TARGET = 'es2022'", "BUILD_TARGET = 'es2017'");
    ok(downgraded !== viteSrc, '前提:常量在那');
    ok(baselineConsistencyProblems(downgraded, readme).some((x) => x.includes('es2017')),
      '★ target 与基线句不一致 ⇒ 报红(两边各改一半会被抓住)');
    const noConst = viteSrc.split('BUILD_TARGET').join('X');
    ok(baselineConsistencyProblems(noConst, readme).length > 0, '★ 拿掉常量 ⇒ 报红');
  });

  test('FND170-8 ★ 基线清单点名 structuredClone 并写清后果(它缺失会整页走 #fatal)', () => {
    ok(BASELINE_REQUIRED_APIS.some((s) => s.name === 'structuredClone'), '清单里有 structuredClone');
    ok(BASELINE_REQUIRED_APIS.every((s) => s.why !== ''), '每条都要写清"缺了会怎样"');
    const why = BASELINE_REQUIRED_APIS.find((s) => s.name === 'structuredClone')!.why;
    ok(why.includes('#fatal'), `理由要点名后果(#fatal / 白屏),实际:${why}`);
    ok(BROWSER_BASELINE_TEXT.includes('Safari 15.4'), '基线句点名 Safari 15.4(structuredClone 的那一档)');
  });
}

/* ═══════════════════ 4 降级路径 ═══════════════════ */

function fallbackCases(): void {
  test('FND170-9 ★ 缺 structuredClone 必须被检测到,且降级**真的能克隆**;负对照:有原生实现时一个字都不动', () => {
    eq(missingBaselineApis(globalThis), [], '前提:node 有原生 structuredClone ⇒ 齐备(检测器不是恒真)');
    const fake: Record<string, unknown> = {};
    eq(missingBaselineApis(fake), ['structuredClone'], '★ 假的旧环境必须被判"缺"');

    eq(installStructuredCloneFallback(fake), 'installed', '装上降级');
    eq(missingBaselineApis(fake), [], '装完不再缺');
    const clone = fake['structuredClone'] as <T>(v: T) => T;
    const src = { a: 1, nested: { b: [1, 2, 3] } };
    const copy = clone(src);
    ok(copy !== src, '★ 顶层是新对象');
    ok(copy.nested !== src.nested, '★ 嵌套也是新对象(否则"降级"等于没克隆)');
    eq(copy, src, '内容相同');
    copy.nested.b.push(4);
    eq(src.nested.b, [1, 2, 3], '★ 改副本不影响原对象(深拷贝)');
    eq(clone(undefined), undefined, 'undefined 原样返回(JSON.stringify(undefined) ⇒ undefined,不能抛)');
    eq(clone(null), null, 'null 原样返回');
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    ok(clone(cyc) === cyc, '★ 循环引用 ⇒ 原样返回(缺 API 时抛就是白屏;降级绝不抛)');
    eq(clone({ fn: () => 1, n: 2 }).n, 2, '含函数的对象也能返回(不抛)');

    /* ── 负对照:已经有实现 ⇒ 报 native 且**不许换掉**它 ── */
    const nativeFn = <T>(v: T): T => v;
    const native: Record<string, unknown> = { structuredClone: nativeFn };
    eq(installStructuredCloneFallback(native), 'native', '★ 负对照:有实现 ⇒ native');
    eq(native['structuredClone'], nativeFn,
      '★ 负对照:原生实现不许被 JSON 版顶掉(顶掉会静默丢 Map / Date)');
    eq(structuredCloneFallback(5), 5, '原始值照常');
    eq(installStructuredCloneFallback(null), 'unavailable', 'null scope ⇒ 装不上(不抛)');
  });

  test('FND170-10 ★ 缺 API ⇒ 在 DOM 上给出**可读的一句话**(不是白屏);负对照:达标环境不许多挂一个节点', () => {
    /* ── 缺席环境:一个**没有** structuredClone 的假全局(不碰真 globalThis) ── */
    const scope: Record<string, unknown> = {};
    const { host } = stubDom();
    const mirror = createA11yMirror();
    mirror.mount(host, scope);
    eq(mirror.mounted, true, '★ 缺 API 时镜像面板照样挂得上(否则用户什么都看不到)');
    ok(mirror.baselineNote !== '', `★ 必须有那句人话,实际:${JSON.stringify(mirror.baselineNote)}`);
    ok(mirror.baselineNote.includes('structuredClone'), '★ 点名缺哪个 API');
    ok(mirror.baselineNote.includes('Chrome 98+'), '★ 带上基线(据此知道要升到什么版本)');
    ok(mirror.baselineNote.includes('已装上等价降级'), `★ 说清已经降级,实际:${mirror.baselineNote}`);
    ok(typeof scope['structuredClone'] === 'function', '★ 降级**真的装上了** scope(不只是报个错)');
    const root = host.root as StubEl;
    eq(root.children.length, A11Y_PANELS.length + 1, '★ 横幅是多出来的那一个节点');
    const banner = root.children[0]!;
    eq(banner.attrs['role'], 'alert', '★ 横幅 role=alert(读屏器立刻念)');
    eq(banner.attrs['aria-live'], 'assertive', '★ aria-live=assertive');
    ok(banner.textContent.includes('structuredClone'), '★ 横幅文本 = 那句人话(屏幕上也读得到)');
    ok(mirror.textOf().some((line) => line.startsWith('基线:')), '★ 基线提示也进 `textOf`(机读口径)');

    /* ── 负对照:达标环境(真 globalThis,node 有 structuredClone)⇒ 不许多一个节点 ── */
    const good = stubDom();
    const okMirror = createA11yMirror();
    okMirror.mount(good.host);
    eq(okMirror.baselineNote, '', '★ 负对照:达标时不许出现提示');
    eq((good.host.root as StubEl).children.length, A11Y_PANELS.length, '★ 负对照:达标时不许多挂节点');
    ok(!okMirror.textOf().some((line) => line.startsWith('基线:')), '★ 负对照:textOf 里没有基线行');
  });

  test('FND170-11 ★ 连降级都装不上 ⇒ 文案说「本页无法运行」;负对照:装得上时不许说这句', () => {
    const frozen = Object.freeze({}) as Record<string, unknown>;
    const rep = browserBaselineReport(frozen);
    eq(rep.missing, ['structuredClone'], 'missing = 进入时缺的');
    eq(rep.clone, 'unavailable', '★ 不可写 scope ⇒ unavailable(不是静默成功)');
    eq(rep.remaining, ['structuredClone'], 'remaining = 仍然缺的');
    ok(rep.text.includes('无法运行'), `★ 装不上必须给出"无法运行 + 升级浏览器",实际:${rep.text}`);
    ok(rep.text.includes('Chrome 98+'), '文案带基线');

    const writable: Record<string, unknown> = {};
    const rep2 = browserBaselineReport(writable);
    eq(rep2.clone, 'installed', '负对照:可写 scope ⇒ 装上');
    eq(rep2.remaining, [], '负对照:装完不再缺');
    ok(!rep2.text.includes('无法运行'), '★ 负对照:装得上时不许说"无法运行"');
    const installed = writable['structuredClone'];
    eq(typeof installed, 'function', '降级函数已经就位');
    const rep3 = browserBaselineReport(writable);
    eq(rep3.clone, 'not-needed', '★ 幂等:第二次不再缺 ⇒ 不再做任何动作');
    eq(rep3.text, '', '★ 幂等:第二次不再提示(否则每帧刷屏)');
    eq(writable['structuredClone'], installed, '★ 幂等:同一个实现没被再包一层(不覆盖已有)');
    /* 达标环境的对照(真 globalThis) */
    const rep4 = browserBaselineReport();
    eq(rep4, { missing: [], clone: 'not-needed', remaining: [], text: '' }, '达标环境:零提示、零动作');
  });
}

/* ═══════════════════ 桩 DOM(只留判据要读的四个面) ═══════════════════ */

interface StubEl {
  tagName?: string;
  style: { display: string; cssText: string };
  textContent: string;
  attrs: Record<string, string>;
  children: StubEl[];
  setAttribute(k: string, v: string): void;
  appendChild(c: StubEl): void;
}

function stubDom(): { host: { ownerDocument: unknown; root: StubEl | null; appendChild(el: StubEl): void } } {
  const doc = {
    createElement(tag: string): StubEl {
      const el: StubEl = {
        tagName: tag.toUpperCase(),
        style: { display: '', cssText: '' },
        textContent: '',
        attrs: {},
        children: [],
        setAttribute(k: string, v: string): void { el.attrs[k] = v; },
        appendChild(c: StubEl): void { el.children.push(c); },
      };
      return el;
    },
  };
  const host = {
    ownerDocument: doc,
    root: null as StubEl | null,
    appendChild(el: StubEl): void { host.root = el; },
  };
  return { host };
}

/* ═══════════════════ 入口 ═══════════════════ */

fontCases();
edgeCases();
baselineCases();
fallbackCases();
report('WS-FND-170');
