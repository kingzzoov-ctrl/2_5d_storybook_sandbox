/**
 * WS-FND-166 —— **B3 审计的三个真机必炸项** + 布局单一事实源。
 *
 * ## 修的四件事(每一条都是"真机上一定发生")
 *
 * ```
 * 1 触屏永远打不出攻击:攻击只挂 `mousedown`(main.ts),而 `main.ts#onStickDown`
 *   对**每一次触摸**都 preventDefault ⇒ 兼容 mousedown 被抑制。
 * 2 单指拖背包时角色同时走路:摇杆监听在 window 冒泡层,`boot` 的画布监听先执行
 *   且**不判"已命中 UI"** ⇒ 两条监听各吃一半。
 * 3 窄屏面板出界且永远点不到:音高面板恒 448px 宽(`panel_layout.ts:334`),
 *   360px 手机上右侧 3 列在 `inRect` 下**数学上不可达**;配方面板一处写 300、
 *   绘制层另写 320 ⇒ 两处各算一份。
 * 4 手机无键盘 ⇒ `PANEL_KEYS` 全是字母键 ⇒ **全部面板不可达**;另外
 *   contextmenu / user-select 未处理(iOS 长按选文本/弹菜单),而
 *   prefers-reduced-motion 只覆盖了摇杆。
 * ```
 *
 * ## 判据的形状
 *
 * node 里没有 DOM ⇒ 不假装测像素。能机械钉住的是:
 * ```
 * 纯几何   每个面板 / 每个按钮 / 每个可点部件在 320~1920 的视口里都在屏内,
 *          且用**绘制同一份**矩形去 `inRect` 命中得到自己
 * 纯判定   轻点算不算攻击、这一下算不算按在 UI 上(含面板容器)
 * 源码契约 main.ts / ui_binding.ts 里那几条接线**真的在**(每条都带注入负对照)
 * ```
 * **没有**钉住的部分(如实写明):真机手感、浏览器是否真的不再弹菜单、
 * reduced-motion 的观感 —— 这些只能在真浏览器里看。
 *
 * 运行:`node tests/WS-FND-166-touch-and-narrow.test.ts`
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildView } from '../client/src/ui/inventory.ts';
import { PixelEasel } from '../client/src/ui/pixel_easel.ts';
import { PANEL_KEYS } from '../client/src/ui/panel_keys.ts';
import { keyGroupsExclusive } from '../client/src/ui/panel_keys.ts';
import { UiPanel } from '../client/src/ui/state_machine.ts';
import {
  fitPanelRect,
  layoutEaselPanel,
  layoutFitsViewport,
  layoutInventoryPanel,
  layoutPartyPanel,
  layoutPitchPanel,
  layoutRecipePanel,
  paletteRect,
  panelRectOf,
  slotRect,
} from '../client/src/ui/panel_layout.ts';
import {
  hitEaselPanel,
  hitInventoryPanel,
  hitPartyPanel,
  hitPitchPanel,
  hitUiPanel,
  inRect,
  uiConsumesPoint,
  type UiHitArgs,
  type UiHitLayouts,
} from '../client/src/ui/panel_hit.ts';
import {
  TOUCH_BUTTON_HARD_MIN_W_PX,
  TOUCH_BUTTON_MIN_W_PX,
  TOUCH_BUTTON_SIZE_PX,
  createTouchBar,
  hitTouchBar,
  layoutTouchBar,
  panelButtonId,
  panelOfButtonId,
  touchButtons,
} from '../client/src/ui/touch_bar.ts';
import { TAP_MAX_MS, TAP_MAX_TRAVEL_PX, tapAttackVerdict } from '../client/src/net/touch_intent.ts';
import {
  PANEL_ALPHA_MIN,
  SUPPRESSED_GESTURES,
  gestureHandler,
  panelAnimAlpha,
  prefersReducedMotion,
  suppressNativeGestures,
} from '../client/src/ui/mobile_shell.ts';
import { JOYSTICK_DEAD_ZONE, STICK_RADIUS_PX } from '../client/src/net/joystick.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 读**代码态**(剥注释)。
 *
 * 本套件多处判"代码里有没有这一行",而 `main.ts` / `ui_binding.ts` 的 docblock
 * 里**逐字**写着修前那几行(它们正在解释为什么改)⇒ 查原文会假红。
 * 剥法与 `tests/WS-FND-60` / `WS-FND-58` 的 `readCode` 同形。
 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * 判据覆盖的视口档 —— **设计承诺**:320(Android 小屏 CSS 宽下限)到 1920 桌面。
 *
 * 360 是主流手机;640×360 是横屏;375/414 是 iPhone 两档;768 是平板。
 * 这张表写在判据里(而不是产品代码里):它声明的是「我们在哪些视口上承诺可用」,
 * 改产品布局时**不该**顺手把它改小。
 */
const VIEWPORTS: readonly [number, number][] = [
  [320, 480], [360, 640], [360, 360], [375, 812], [414, 896],
  [640, 360], [768, 1024], [1280, 800], [1920, 1080],
];
/** 所有"真面板"(按钮条要覆盖的那一组)—— 从键位表取,不手抄 */
const ALL_PANELS: readonly UiPanel[] = Object.values(PANEL_KEYS);

/** 命中测试要的那份状态(与 `boot.uiState()` 同形;只需要这几项) */
function hitArgs(panel: UiPanel): UiHitArgs {
  return {
    panel,
    view: buildView({ page: 0 }),
    easel: new PixelEasel(),
    partyPanel: { rows: [{ mode: 1 }, { mode: 2 }, { mode: 3 }, { mode: 4 }] },
    recipeNodes: 20,
  };
}

function layoutsOf(w: number, h: number): UiHitLayouts {
  return { inv: layoutInventoryPanel(w, h), pitch: layoutPitchPanel(w, h) };
}

/* ═══════════════ 1. 触屏攻击 ═══════════════ */

test('FND166-1 触屏能打出攻击:攻击不再只挂 mousedown(轻点 / 屏幕按钮 / 鼠标左键三条出口)', () => {
  const main = readCode('client/src/main.ts');
  ok(main.length > 0, 'main.ts 必须读得到');

  const wired = (src: string): boolean => (
    src.includes("addEventListener('pointerdown'")
    && !src.includes("addEventListener('mousedown'")
    && src.includes("attackNearest('mouse')")
    && src.includes("attackNearest('tap')")
    && src.includes("attackNearest('button')")
    && src.includes('tapAttackVerdict(')
  );
  ok(wired(main), '攻击必须挂在指针事件上,且三条出口(左键 / 轻点 / 屏幕按钮)都点名');

  /* 负对照:把攻击改回 `mousedown` ⇒ 检测器必须转假(修前就是这么坏的可读版本) */
  const reverted = main.replace("addEventListener('pointerdown'", "addEventListener('mousedown'");
  ok(reverted !== main, '前提:源码里确实有 pointerdown 那条监听');
  ok(!wired(reverted), '★ 注入「改回 mousedown」后判据必须转假 ⇒ 这条断言有牙齿');

  /* 摇杆那一下仍然要挡掉**兼容的** mousedown(否则「想走路结果挥刀」) */
  ok(main.includes('ev.preventDefault();'), '摇杆落指仍要 preventDefault(挡兼容 mousedown)');
});

test('FND166-2 轻点判定(纯):拖动/长按/非法读数都不是攻击,且负对照证明这条判据有牙齿', () => {
  const tapped = tapAttackVerdict({ durationMs: 90, travelPx: 3 });
  eq(tapped.attack, true, '90ms / 3px ⇒ 是轻点');
  ok(tapped.reason.includes('攻击'), `reason 必须说清结论(实际:${tapped.reason})`);

  const dragged = tapAttackVerdict({ durationMs: 90, travelPx: TAP_MAX_TRAVEL_PX + 1 });
  eq(dragged.attack, false, '拖出阈值 ⇒ 是移动,不是攻击');
  ok(dragged.reason.includes('移动'), `reason 必须点明"移动"(实际:${dragged.reason})`);

  const held = tapAttackVerdict({ durationMs: TAP_MAX_MS + 1, travelPx: 0 });
  eq(held.attack, false, '按太久 ⇒ 长按,不是攻击');
  ok(held.reason.includes('长按'), `reason 必须点明"长按"(实际:${held.reason})`);

  /* 边界取**内侧**:恰好等于阈值算攻击(写死一侧,两端不许各有一个"看起来对"的答案) */
  eq(tapAttackVerdict({ durationMs: TAP_MAX_MS, travelPx: TAP_MAX_TRAVEL_PX }).attack, true,
    '恰好等于阈值 ⇒ 仍算轻点(边界取内侧,写死)');

  /* 负对照 1:非法读数必须是"不攻击" —— 朴素写法(`if (t > MAX) return false`)会误判成攻击 */
  const naive = (t: number, d: number): boolean => {
    if (d > TAP_MAX_TRAVEL_PX) return false;
    if (t > TAP_MAX_MS) return false;
    return true;
  };
  eq(naive(Number.NaN, 0), true, '前提:朴素写法对 NaN 时长**会**判成攻击(所以显式 isFinite 是必需的)');
  eq(tapAttackVerdict({ durationMs: Number.NaN, travelPx: 0 }).attack, false, 'NaN 时长 ⇒ 不攻击');
  eq(tapAttackVerdict({ durationMs: 0, travelPx: Number.NaN }).attack, false, 'NaN 位移 ⇒ 不攻击');
  eq(tapAttackVerdict({ durationMs: -1, travelPx: 0 }).attack, false, '负时长 ⇒ 不攻击');

  /* 负对照 2:四种情形必须给出**四种不同**的话(静默的 reason 与"没接上"同形) */
  const reasons = new Set([
    tapped.reason, dragged.reason, held.reason,
    tapAttackVerdict({ durationMs: Number.NaN, travelPx: 0 }).reason,
  ]);
  eq(reasons.size, 4, '四种结论四句话(去重后仍 4 条)');

  /* 阈值来历:位移阈值必须**小于**摇杆死区的像素半径 ⇒ 抖动算轻点、推杆算拖动 */
  eq(TAP_MAX_MS, 260, '按压阈值钉在设计档 260ms(不取自被测模块的表达式)');
  eq(TAP_MAX_TRAVEL_PX, 12, '位移阈值钉在设计档 12px');
  ok(TAP_MAX_TRAVEL_PX < JOYSTICK_DEAD_ZONE * STICK_RADIUS_PX,
    `位移阈值 ${TAP_MAX_TRAVEL_PX} 必须小于摇杆死区半径(≈${(JOYSTICK_DEAD_ZONE * STICK_RADIUS_PX).toFixed(1)})`);
});

/* ═══════════════ 2. 摇杆 / UI 互斥 ═══════════════ */

test('FND166-3 互斥:**先判 UI,再判摇杆**(顺序 + 判定来源,均带注入负对照)', () => {
  const main = readCode('client/src/main.ts');

  ok(main.includes('function pointerConsumedByUi('), '判定必须收在一处(函数)');
  ok(main.includes('touchBar.hitAt(x, y)') && main.includes('handle.uiHitAt(x, y)'),
    '两条来源都要问:触摸条自己的命中 + 宿主的 UI 判定(面板容器也算)');

  const ordered = (src: string): boolean => {
    /* 只看**摇杆那道闸**(`uiPointerSuppressions += 1` 只在那一处)——
       攻击监听里也有一个 `if (pointerConsumedByUi(…))`,用它会把判据做成恒真。 */
    const guard = src.indexOf('uiPointerSuppressions += 1');
    const begin = src.indexOf('stick.begin(');
    return guard >= 0 && begin >= 0 && guard < begin;
  };
  ok(ordered(main), '★ 互斥判定必须排在 `stick.begin(` **之前**(修前根本没有这一步)');

  /* 负对照:删掉那道闸 ⇒ 检测器必须转假 */
  const noGuard = main.replace('if (pointerConsumedByUi(ev.clientX, ev.clientY)) { uiPointerSuppressions += 1; return; }', '');
  ok(noGuard !== main, '前提:源码里确实有那道闸');
  ok(!ordered(noGuard), '★ 删掉互斥闸后判据必须转假');

  /* 摇杆落指**仍然**只认触屏/笔(鼠标左键是攻击) */
  ok(/pointerType === 'mouse'[\s\S]{0,400}?stickUI\.show\(/.test(main),
    '`pointerType === mouse` 的提前 return 仍排在 `stickUI.show` 之前');
});

test('FND166-4 `uiConsumesPoint`(纯):面板**容器内一寸都不给世界**;面板关着时一律不吃', () => {
  const [w, h] = [360, 640];
  const layouts = layoutsOf(w, h);

  for (const panel of ALL_PANELS) {
    const args = hitArgs(panel);
    /* 容器右上角内侧那一点:修前 `hit()` 只报"哪个格子",空白处返回 none ⇒ 世界与摇杆各吃一半 */
    const point = { x: w - 1, y: h - 1 };
    const rect = panelRectOf(panel, w, h, 20, 4);
    ok(rect !== null, `${panel}:必须能取到容器矩形`);
    const at = {
      x: Math.min(point.x, rect!.x + rect!.w - 1),
      y: Math.min(point.y, rect!.y + rect!.h - 1),
    };
    eq(uiConsumesPoint(args, layouts, [null], w, h, at.x, at.y), true,
      `${panel}:容器内(${at.x},${at.y})⇒ 算 UI`);

    /* 负对照:面板关着 ⇒ 同一坐标不算 UI(否则整个屏幕都点不动了) */
    eq(uiConsumesPoint({ ...args, panel: UiPanel.NONE }, layouts, [null], w, h, at.x, at.y), false,
      `${panel}:面板关着时同一坐标不算 UI`);
  }

  /* 负对照:面板开着、但点在面板**外** ⇒ 不算 UI(世界拖动照旧) */
  const inv = layoutInventoryPanel(w, h);
  const args = hitArgs(UiPanel.INVENTORY);
  const outside = { x: 2, y: Math.max(2, inv.panel.y - 4) };
  ok(!inRect(inv.panel, outside.x, outside.y), '前提:这个点在面板外');
  eq(uiConsumesPoint(args, layouts, [null], w, h, outside.x, outside.y), false, '面板外的点不算 UI');
});

/* ═══════════════ 3. 窄屏:所有面板在屏内且可点 ═══════════════ */

test('FND166-5 ★ 任一视口(320~1920)下**每个**面板的矩形都在屏内(负对照:修前 448 > 360)', () => {
  const problems: string[] = [];
  for (const [w, h] of VIEWPORTS) {
    for (const panel of ALL_PANELS) {
      const rect = panelRectOf(panel, w, h, 20, 4);
      if (rect === null) { problems.push(`${w}×${h} ${panel}:没有矩形`); continue; }
      if (!(rect.x >= 0 && rect.y >= 0)) problems.push(`${w}×${h} ${panel}:左上角出界 (${rect.x},${rect.y})`);
      if (!(rect.x + rect.w <= w + 0.5)) problems.push(`${w}×${h} ${panel}:右边界出界 ${rect.x + rect.w} > ${w}`);
      if (!(rect.y + rect.h <= h + 0.5)) problems.push(`${w}×${h} ${panel}:下边界出界 ${rect.y + rect.h} > ${h}`);
      if (!(rect.w > 0 && rect.h > 0)) problems.push(`${w}×${h} ${panel}:尺寸非正`);
    }
    /* 各布局对象自身的不变量(与 WS-09 同一条) */
    for (const [name, L] of [
      ['inv', layoutInventoryPanel(w, h)],
      ['pitch', layoutPitchPanel(w, h)],
      ['easel', layoutEaselPanel(w, h)],
      ['recipe', layoutRecipePanel(w, h, 20)],
      ['party', layoutPartyPanel(w, h, 4)],
    ] as const) {
      if (!layoutFitsViewport(L, w, h)) problems.push(`${w}×${h} ${name}:layoutFitsViewport 假`);
    }
  }
  eq(problems, [], `所有视口的所有面板都必须在屏内(实际问题:${problems.slice(0, 4).join(' / ')})`);

  /* 负对照 1:修前的音高面板宽度是**字面量** 16×26+32 = 448,在 360 宽上必然出界 ——
     这条断言证明"在屏内"不是恒真(老几何一定红)。 */
  const oldPitchW = 16 * 26 + 32;
  eq(oldPitchW, 448, '修前的音高面板宽度 = 448px(设计档字面量)');
  ok(oldPitchW > 360, '前提:448 > 360 ⇒ 老几何在手机上出界');
  /* 负对照 2:夹取真的会咬(`fitPanelRect` 把 448 压到 360) */
  eq(fitPanelRect({ x: 0, y: 0, w: 448, h: 150 }, 360, 640).rect.w, 360, '448px 宽的矩形被夹到 360');
  eq(fitPanelRect({ x: -40, y: -6, w: 320, h: 150 }, 360, 200).rect.y, 0, '负 y 被夹到 0');
  ok(layoutPitchPanel(360, 640).panel.w <= 360, '360px 视口下音高面板宽度 ≤ 360');
});

test('FND166-6 ★ 360px 下每个可点部件都在面板内且 `inRect` 命中得到**自己**', () => {
  const [w, h] = [360, 640];

  /* 音高:32 块砖 —— 修前右侧 3 列在屏外,`inRect` 永远点不到 */
  const pitch = layoutPitchPanel(w, h);
  for (let i = 0; i < pitch.bricks.length; i += 1) {
    const b = pitch.bricks[i]!;
    ok(b.x >= pitch.panel.x && b.x + b.w <= pitch.panel.x + pitch.panel.w + 0.5, `砖 ${i} 横向在面板内`);
    ok(b.x + b.w <= w + 0.5, `砖 ${i} 在屏内(右边界 ${b.x + b.w} ≤ ${w})`);
    eq(hitPitchPanel(pitch, b.x + b.w / 2, b.y + b.h / 2), { kind: 'brick', pitch: i }, `砖 ${i} 点得中`);
  }
  eq(pitch.bricks.length, 32, '32 块砖(2×16)');

  /* 背包:一页 160 格全都能命中(页内下标与全局格位都要对) */
  const inv = layoutInventoryPanel(w, h);
  for (let i = 0; i < inv.cols * inv.rows; i += 1) {
    const r = slotRect(inv, i);
    ok(r.x >= inv.panel.x && r.x + r.w <= inv.panel.x + inv.panel.w + 0.5, `格 ${i} 横向在面板内`);
    ok(r.y + r.h <= inv.panel.y + inv.panel.h + 0.5, `格 ${i} 纵向在面板内`);
    eq(hitInventoryPanel(inv, r.x + r.w / 2, r.y + r.h / 2, 0, [null]),
      { kind: 'slot', indexInPage: i, slot: i }, `格 ${i} 点得中`);
  }
  eq(inv.cols * inv.rows, 160, '一页 160 格');

  /* 画架:画布 / 32 色 / 工具条三段 */
  const easel = layoutEaselPanel(w, h);
  const inBounds = (x: number, y: number): boolean => x >= 0 && x < 16 && y >= 0 && y < 16;
  eq(hitEaselPanel(easel, easel.canvas.x + easel.canvas.w / 2, easel.canvas.y + easel.canvas.h / 2, inBounds),
    { kind: 'easel', x: 8, y: 8 }, '画布中心 ⇒ 命中 (8,8)');
  for (let i = 0; i < 32; i += 1) {
    const r = paletteRect(easel, i);
    eq(hitEaselPanel(easel, r.x + r.w / 2, r.y + r.h / 2, inBounds), { kind: 'palette', index: i },
      `调色格 ${i} 点得中`);
  }
  const third = easel.toolbar.w / 3;
  eq(hitEaselPanel(easel, easel.toolbar.x + third / 2, easel.toolbar.y + 4, inBounds),
    { kind: 'toolbar', action: 'undo' }, '工具条第 1 段 = 撤销');
  eq(hitEaselPanel(easel, easel.toolbar.x + third * 1.5, easel.toolbar.y + 4, inBounds),
    { kind: 'toolbar', action: 'redo' }, '工具条第 2 段 = 重做');
  eq(hitEaselPanel(easel, easel.toolbar.x + third * 2.5, easel.toolbar.y + 4, inBounds),
    { kind: 'toolbar', action: 'clear' }, '工具条第 3 段 = 清空');

  /* 模式面板:每一行 */
  const party = layoutPartyPanel(w, h, 4);
  const rows = [{ mode: 1 }, { mode: 2 }, { mode: 3 }, { mode: 4 }];
  for (let i = 0; i < party.rows.length; i += 1) {
    const r = party.rows[i]!;
    eq(hitPartyPanel(party, r.x + r.w / 2, r.y + r.h / 2, (k) => rows[k]?.mode), { kind: 'partyMode', mode: i + 1 },
      `第 ${i} 行点得中`);
  }

  /* 总入口:同一个坐标经 `hitUiPanel` 走同一条判定(绘制/命中共用布局) */
  const layouts = layoutsOf(w, h);
  const args = hitArgs(UiPanel.INVENTORY);
  const r0 = slotRect(inv, 0);
  eq(hitUiPanel(args, layouts, [null], w, h, r0.x + 1, r0.y + 1).kind, 'slot', '总入口也命中同一格');
});

test('FND166-7 桌面档**不回归**:1280×800 的老数字逐项不变(布局只多夹取,不改设计档)', () => {
  const [w, h] = [1280, 800];
  const inv = layoutInventoryPanel(w, h);
  eq(inv.cell, 30, '桌面格宽仍是 30(CELL_PX)');
  eq(inv.panel.w - inv.cols * inv.cell, 32, '面板宽 − 网格宽 = 32(两侧外边距)');
  eq(inv.panel.h - inv.rows * inv.cell, 106, '面板高 − 网格高 = 106(标题 28 + 标签 24 + 分页 22 + 外侧 32)');

  const pitch = layoutPitchPanel(w, h);
  eq(pitch.panel.w, 448, '桌面音高面板仍是 448px(16×26 + 32)');
  eq(pitch.brickW, 26, '桌面砖宽仍是 26');
  eq(pitch.panel.h, 150, '桌面音高面板高仍是 150(28 + 2×34 + 22 + 32)');

  const easel = layoutEaselPanel(w, h);
  eq(easel.panel.w, 368, '桌面画架面板仍是 368px(工具条 336 + 32)');
  eq(easel.pixel, 14, '桌面图素边长仍是 14');
  eq(easel.paletteCell, 22, '桌面调色格仍是 22');
  eq(easel.toolbar.w, 336, '桌面工具条可用宽仍是 336(装得下那行字)');

  eq(layoutRecipePanel(w, h, 20).panel.w, 320, '桌面配方面板宽 = 320(绘制与命中同一个数)');
  ok(layoutRecipePanel(w, h, 500).panel.h <= h, '节点再多,面板高也不超过视口');
});

test('FND166-8 布局单一事实源(源码契约):矩形只在 `panel_layout.ts` 算,绘制层不再自己拼', () => {
  const layout = readCode('client/src/ui/panel_layout.ts');
  const binding = readCode('client/src/three/ui_binding.ts');

  ok(layout.includes('export function fitPanelRect('), '夹取只有一个入口(`fitPanelRect`)');
  const fitCalls = (layout.match(/fitPanelRect\(\{/g) ?? []).length;
  ok(fitCalls >= 5, `各布局函数都走同一个夹取(实际 ${fitCalls} 处)`);
  /* ⚠️ `layout` 的来源是 `readCode`(**剥注释**)⇒ 这里的计数不会被注释里的同名文字污染 */
  eq(layout.split('export const RECIPE_PANEL_W_MAX = 320;').length - 1, 1, '配方面板宽度只定义一次');

  const singleSource = (src: string): boolean => (
    src.includes('layoutRecipePanel(this.w, this.h, tree.nodeCount)')
    && !src.includes('const w = 320')
    && !src.includes('panel.y + h - 42')
  );
  ok(singleSource(binding), '绘制层的配方面板必须读 `layoutRecipePanel`(修前自己写 w=320 / h=30+rows*18+74)');

  /* 负对照:把绘制层那两行写回去 ⇒ 检测器必须转假 */
  ok(!singleSource(`${binding}\nconst w = 320;`), '★ 注入 `const w = 320` 后判据必须转假');
  ok(!singleSource(binding.replace('layoutRecipePanel(this.w, this.h, tree.nodeCount)', '')),
    '★ 删掉布局调用后判据必须转假');

  /* 面板矩形只有一个查表入口(命中/绘制/「算不算按在 UI 上」共用) */
  ok(layout.includes('export function panelRectOf('), '`panelRectOf` 是容器矩形的唯一入口');
  ok(binding.includes('hitUiPanel('), '命中判定必须委托给纯模块(修前住在碰 DOM 的类里 ⇒ 无法断言)');
});

/* ═══════════════ 4. 触屏可达面板 ═══════════════ */

test('FND166-9 手机能开**每一个**面板:按钮从 `PANEL_KEYS` 派生(负对照:字母键本身不可达)', () => {
  /* 前提:面板键位全是字母键 ⇒ 没有屏幕按钮时,无键盘设备上**一个都打不开** */
  const keys = Object.keys(PANEL_KEYS);
  ok(keys.length >= 5, `面板键位数 ${keys.length} ≥ 5`);
  ok(keys.every((k) => /^[a-z]$/.test(k)), '前提:面板键位全是单个字母键(手机没有键盘)');

  const buttons = touchButtons();
  const everyPanelHasButton = (panels: readonly UiPanel[], list: readonly { id: string }[]): boolean =>
    panels.every((p) => list.some((b) => b.id === `panel:${p}`));
  ok(everyPanelHasButton(ALL_PANELS, buttons), '每个面板都必须有触屏按钮');

  /* 负对照:去掉一个面板按钮 ⇒ 检测器必须转假 */
  const missing = buttons.filter((b) => !b.id.includes('PITCH_EDITOR'));
  eq(everyPanelHasButton(ALL_PANELS, missing), false, '★ 去掉音高按钮后判据必须转假');

  /* 攻击 + 关闭也必须各有一个 */
  ok(buttons.some((b) => b.id === 'attack'), '必须有「攻」');
  ok(buttons.some((b) => b.id === 'close'), '必须有「关」');
  eq(buttons.length, ALL_PANELS.length + 2, '按钮数 = 面板数 + 攻击 + 关闭');

  /* 标签 1 个汉字、互不相同(360px 宽的屏上放得下 7 个) */
  for (const b of buttons) {
    eq([...b.label].length, 1, `按钮 ${b.id} 的标签是 1 个字符(实际「${b.label}」)`);
    ok(b.aria.length > 0, `按钮 ${b.id} 必须有无障碍名`);
  }
  eq(new Set(buttons.map((b) => b.label)).size, buttons.length, '标签互不相同');

  /* id 往返:构造/解析只有一处 */
  for (const p of ALL_PANELS) {
    eq(panelOfButtonId(panelButtonId(p)), p, `${p}:按钮 id 往返一致`);
  }
  eq(panelOfButtonId('attack'), null, '「攻」不是面板按钮');
  eq(panelOfButtonId('panel:NOPE' as `panel:${UiPanel}`), null, '未知面板名 ⇒ null(不静默当成某个面板)');
});

test('FND166-10 触摸条在窄屏也在屏内、每个按钮都点得中(负对照:32px 下限在 200px 里放不下)', () => {
  for (const [w, h] of VIEWPORTS) {
    const L = layoutTouchBar(w, h);
    ok(L.bar.x >= 0 && L.bar.y >= 0 && L.bar.x + L.bar.w <= w + 0.5 && L.bar.y + L.bar.h <= h + 0.5,
      `${w}×${h}:按钮条整体在屏内(${JSON.stringify(L.bar)})`);
    ok(L.buttons.length === touchButtons().length, `${w}×${h}:按钮一个不少`);
    for (const b of L.buttons) {
      ok(b.rect.x >= 0 && b.rect.x + b.rect.w <= w + 0.5, `${w}×${h}:${b.id} 横向在屏内`);
      eq(hitTouchBar(L, b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2), b.id, `${w}×${h}:${b.id} 点得中`);
      ok(b.rect.w >= TOUCH_BUTTON_HARD_MIN_W_PX, `${w}×${h}:${b.id} 宽度 ≥ 硬下限`);
    }
    eq(L.clipped, false, `${w}×${h}:按钮条没有被裁`);
  }

  /* 桌面档:按钮是 44×44(触屏档位),且"舒适" */
  const desk = layoutTouchBar(1280, 800);
  eq([desk.buttonW, desk.buttonH], [TOUCH_BUTTON_SIZE_PX, TOUCH_BUTTON_SIZE_PX], '桌面按钮 44×44');
  eq(desk.comfortable, true, '桌面档按钮宽度达到舒适下限');
  /* 360px(主流手机)也必须是 44:7×44 + 6×4 = 332 ≤ 344 */
  eq(layoutTouchBar(360, 640).buttonW, 44, '360px 手机上按钮仍是 44(332 ≤ 344)');
  eq(layoutTouchBar(320, 480).comfortable, true, '320px 小屏仍在舒适档(40 ≥ 32)');

  /* 负对照:若坚持 32px 下限,7 个按钮 + 间距 = 248 > 200 ⇒ 后面几个按钮跑到屏外 */
  const naiveW = 7 * TOUCH_BUTTON_MIN_W_PX + 6 * 4;
  eq(naiveW, 248, '前提:7×32 + 6×4 = 248(设计档字面量)');
  ok(naiveW > 200, '前提:248 > 200 ⇒ 硬下限那条路是必需的');
  eq(layoutTouchBar(200, 200).buttonW, 22, '200px 视口:按钮缩到 22(放得下,而不是出界)');
  eq(layoutTouchBar(200, 200).clipped, false, '200px 视口:条子没被裁');

  /* 无 DOM 环境:构造 / 空调用都不抛(手机之外的环境不该被这层炸掉) */
  eq(typeof (globalThis as { document?: unknown }).document, 'undefined', '前提:node 里没有 document');
  const bar = createTouchBar(() => { /* 不做事 */ });
  eq([bar.mounted, bar.buttonCount], [false, 0], '未挂载:没挂、没按钮');
  eq(bar.hitAt(10, 10), null, '未挂载:命中恒 null');
  bar.dispose();
});

test('FND166-11 触摸条接线(main.ts):建 / 挂 / 攻击 / 开合面板 / 卸(每条带负对照)', () => {
  const main = readCode('client/src/main.ts');
  const wired = (src: string): boolean => (
    src.includes('createTouchBar(')
    && src.includes('touchBar.mount(root)')
    && src.includes("if (id === 'attack') { attackNearest('button'); return; }")
    && src.includes('handle.togglePanel(panel)')
    && src.includes('handle.closePanel()')
    && src.includes('touchBar.dispose()')
  );
  ok(wired(main), '触摸条的建/挂/攻/开关/卸必须全在');

  for (const piece of ['touchBar.mount(root)', 'handle.togglePanel(panel)', 'touchBar.dispose()']) {
    ok(!wired(main.replace(piece, '')), `★ 删掉「${piece}」后判据必须转假`);
  }

  /* 宿主那三个新出口也要在(声明 + 实现)—— 否则 main 调的是不存在的东西 */
  const boot = readCode('client/src/three/boot.ts');
  ok(boot.includes('togglePanel: (panel: UiPanel) => void;'), 'BootHandle 必须声明 togglePanel');
  ok(boot.includes('togglePanel: (panel) => { setPanel(panel); }'), '实现必须复用 `setPanel`(同键再按 = 关)');
  ok(boot.includes('uiHitAt: (x: number, y: number) => boolean;'), 'BootHandle 必须声明 uiHitAt');
  ok(boot.includes('uiConsumesPoint('), 'uiHitAt 必须走纯判定(不是就地重算)');
  ok(boot.includes("uiFsm.transition('CLOSED', 'touch-close')"), '关面板走状态机的合法迁移');
});

/* ═══════════════ 5. 手机浏览器外壳与 reduced-motion ═══════════════ */

test('FND166-12 contextmenu / selectstart 抑制:注册哪几个、真的 preventDefault、可卸载(带负对照)', () => {
  eq([...SUPPRESSED_GESTURES], ['contextmenu', 'selectstart', 'dragstart'], '抑制这三个原生手势(设计档)');

  const types: string[] = [];
  const removed: string[] = [];
  const fake = {
    addEventListener(type: string): void { types.push(type); },
    removeEventListener(type: string): void { removed.push(type); },
  };
  const detach = suppressNativeGestures(fake);
  eq(types, ['contextmenu', 'selectstart', 'dragstart'], '三个事件都注册了');
  /* 负对照:没有注册 `click` / `pointerdown` —— 抑制不许把正常输入也关掉 */
  ok(!types.includes('click') && !types.includes('pointerdown'), '不许顺手把 click / pointerdown 也关掉');

  /* 驱动那个 handler:它必须真的 preventDefault(否则"注册了"只是摆设) */
  let prevented = 0;
  gestureHandler({ preventDefault: () => { prevented += 1; } });
  eq(prevented, 1, 'handler 真的调用了 preventDefault');
  /* 负对照:一个不调 preventDefault 的假 handler 不会让计数变 */
  const noop = (_ev: { preventDefault(): void }): void => { /* 故意什么都不做 */ };
  noop({ preventDefault: () => { prevented += 1; } });
  eq(prevented, 1, '负对照:空 handler 不会让计数变 ⇒ 上面那条不是恒真');

  detach();
  eq(removed, ['contextmenu', 'selectstart', 'dragstart'], '卸载时三个事件都摘掉');

  /* CSS 那一半(index.html):iOS 的长按选中 / 弹窗 */
  const html = readFileSync(join(ROOT, 'client/index.html'), 'utf8');
  ok(html.includes('user-select: none'), 'index.html 必须关掉文本选择');
  ok(html.includes('-webkit-user-select: none'), 'index.html 必须带 -webkit 前缀');
  ok(html.includes('-webkit-touch-callout: none'), 'index.html 必须关掉 iOS 的长按弹窗');
  ok(html.includes('touch-action: none'), '画布区域不许被浏览器手势抢走');

  /* 接线:main.ts 真的注册了抑制器,并在卸载时摘掉 */
  const main = readCode('client/src/main.ts');
  ok(main.includes('suppressNativeGestures(window)'), 'main.ts 必须真的注册手势抑制');
  ok(main.includes('detachGestures()'), '卸载时必须摘掉');
});

test('FND166-13 prefers-reduced-motion 覆盖**面板**动画(修前只覆盖摇杆)', () => {
  eq(PANEL_ALPHA_MIN, 0.35, '最淡值钉在设计档 0.35');
  eq(panelAnimAlpha(0, true), 1, 'reduced-motion ⇒ 恒 1(直接出现,不淡入)');
  eq(panelAnimAlpha(0.5, true), 1, 'reduced-motion ⇒ 中途也是 1');
  near(panelAnimAlpha(0, false), 0.35, 1e-9, '普通模式:进度 0 ⇒ 0.35');
  near(panelAnimAlpha(1, false), 1, 1e-9, '普通模式:进度 1 ⇒ 1');
  near(panelAnimAlpha(0.5, false), 0.675, 1e-9, '普通模式:0.35 + 0.65×0.5 = 0.675');
  /* 负对照:老写法在进度 0 时是 0.35,与 reduced-motion 的 1 不同 ⇒ 那条分支不可省 */
  ok(panelAnimAlpha(0, true) !== panelAnimAlpha(0, false), '★ reduced-motion 分支必须真的改变输出');
  /* 负对照:NaN / 越界不许把 alpha 变成 NaN(整个面板会消失且不报错) */
  eq(panelAnimAlpha(Number.NaN, false), 0.35, 'NaN 进度 ⇒ 夹到 0(alpha 仍是有限值)');
  eq(panelAnimAlpha(-5, false), 0.35, '负进度 ⇒ 夹到 0');
  eq(panelAnimAlpha(9, false), 1, '超界进度 ⇒ 夹到 1');

  eq(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true, 'matchMedia 命中 ⇒ true');
  eq(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false, 'matchMedia 未命中 ⇒ false');
  eq(prefersReducedMotion(null), false, '没有 view ⇒ false(默认保留动效,不静默改变观感)');
  eq(prefersReducedMotion({}), false, '没有 matchMedia ⇒ false');
  eq(prefersReducedMotion({ matchMedia: () => { throw new Error('boom'); } }), false, 'matchMedia 抛错 ⇒ false(不把启动打挂)');

  /* 源码契约:绘制层必须读这条偏好,且老表达式必须消失 */
  const binding = readCode('client/src/three/ui_binding.ts');
  const gated = (src: string): boolean => (
    src.includes('panelAnimAlpha(s.openProgress, this.reduceMotion)')
    && !src.includes('0.35 + 0.65 * s.openProgress')
  );
  ok(gated(binding), '面板 alpha 必须走 `panelAnimAlpha(…, reduceMotion)`');
  ok(!gated(`${binding}\nconst a = 0.35 + 0.65 * s.openProgress;`), '★ 把老表达式写回后判据必须转假');
  ok(binding.includes('prefersReducedMotion('), '必须在构造时读一次偏好');
});

/* ═══════════════ 6. 负对照:既有链路不许被这轮改坏 ═══════════════ */

test('FND166-14 老链路未被改坏:键位互斥 / 摇杆单点接线 / 上行唯一', () => {
  eq(keyGroupsExclusive(), true, '键位组仍互斥(这轮没往键位表里加东西)');

  const main = readCode('client/src/main.ts');
  eq((main.match(/stickUI\.show\(/g) ?? []).length, 1, '摇杆落指仍只有一处 show');
  eq((main.match(/stickUI\.moveTo\(/g) ?? []).length, 1, '摇杆拖动仍只有一处 moveTo');
  ok(main.includes('mergeCmd(input.nextCmd(), stick.vector())'), '命令仍由键盘 + 摇杆合并');
  eq((main.match(/session\.sendMove\(/g) ?? []).length, 1, '上行发送点仍唯一');
  ok(main.includes('stick.end();\n    stickUI.hide();') || /stick\.end\(\);\s*stickUI\.hide\(\)/.test(main),
    '抬手:逻辑归零与视觉隐藏在**同一处**');
  ok(main.includes("window.addEventListener('pointercancel', onStickEnd)"), 'pointercancel 仍与 pointerup 同一处理');
});

report('WS-FND-166');