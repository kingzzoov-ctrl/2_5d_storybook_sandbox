/**
 * ★ WS-FND-166:面板**命中测试** —— 纯逻辑、零 DOM(判定必须能在 node 里断言)。
 *
 * ## 为什么从 `three/ui_binding.ts` 搬出来
 *
 * 修前命中测试是 `UiOverlay` 的一个**方法**:它碰 `CanvasRenderingContext2D` 的宿主类,
 * 而 node 里没有 `document` ⇒ 那条路**一条断言都写不了**。于是两个实测缺陷都是
 * "改坏了没人知道"的形态:
 * ```
 * 音高面板命中用 448px 宽的矩形   ⇒ 360px 手机上右侧 3 列永远点不到
 * boot 只看"命中了哪个格子"       ⇒ 按在面板空白处返回 none
 *                                 ⇒ 摇杆/世界拖动同时吃掉这一下(单指拖背包 = 一边走)
 * ```
 * 现在判定全在这里(`inRect` / `hit*Panel` / `uiConsumesPoint`),
 * `ui_binding` 只做转发。
 *
 * ## 与布局的分工
 *
 * 矩形**全部**来自 `ui/panel_layout.ts`(同一个函数、同一个入参)——
 * 本文件不写任何算术,只回答"这个点落在哪个部件里"。
 */

import type { EaselPanelLayout, InventoryPanelLayout, PanelRect, PitchPanelLayout, PartyPanelLayout } from './panel_layout.ts';
import {
  layoutEaselPanel, layoutPartyPanel, panelRectOf, RECIPE_MAX_ROWS,
} from './panel_layout.ts';
import type { InventoryView } from './inventory.ts';
import type { PixelEasel } from './pixel_easel.ts';
import { PALETTE_SIZE } from './pixel_easel.ts';
import { UiPanel } from './state_machine.ts';

/** 指针命中结果(★ WS-FND-166:定义搬到这里;`ui_binding` 仍然 re-export,调用点不用改) */
export type UiHit =
  | { kind: 'slot'; indexInPage: number; slot: number }
  | { kind: 'tab'; category: string | null }
  | { kind: 'pager'; delta: number }
  | { kind: 'easel'; x: number; y: number }
  | { kind: 'palette'; index: number }
  | { kind: 'brick'; pitch: number }
  /**
   * ★ WS-FND-151:点了模式面板的某一行。
   *
   * `mode` 是**线上下标(1 起)**;谁来发报文由 `boot.ts` 决定(它持有选择器与报文口),
   * 本层只回答"点中了哪一档"。
   */
  | { kind: 'partyMode'; mode: number }
  | { kind: 'toolbar'; action: 'undo' | 'redo' | 'clear' }
  | { kind: 'none' };

/**
 * 点是否在矩形内(**半开区间**:`x` 含左不含右)。
 *
 * 与绘制用的同一批矩形比较 ⇒ "画在哪就点在哪"。半开区间是**写死一侧**:
 * 相邻两个格子共用的那条边只能属于其中一个,否则窄屏下同一像素同时命中两格。
 */
export function inRect(r: PanelRect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/** 背包/配方:分类标签 → 分页 → 格子(顺序即优先级,与绘制层一致) */
export function hitInventoryPanel(
  L: InventoryPanelLayout,
  px: number,
  py: number,
  page: number,
  tabCategories: readonly (string | null)[],
): UiHit {
  if (!inRect(L.panel, px, py)) return { kind: 'none' };
  const tabs = tabCategories.length > 0 ? tabCategories : [null];
  if (inRect(L.tabStrip, px, py)) {
    const tabW = L.tabStrip.w / tabs.length;
    const i = Math.min(tabs.length - 1, Math.max(0, Math.floor((px - L.tabStrip.x) / tabW)));
    return { kind: 'tab', category: tabs[i] ?? null };
  }
  if (inRect(L.pager, px, py)) {
    return { kind: 'pager', delta: px < L.pager.x + L.pager.w / 2 ? -1 : 1 };
  }
  const col = Math.floor((px - L.gridX) / L.cell);
  const row = Math.floor((py - L.gridY) / L.cell);
  if (col >= 0 && col < L.cols && row >= 0 && row < L.rows) {
    const i = row * L.cols + col;
    return { kind: 'slot', indexInPage: i, slot: Math.max(0, Math.trunc(page)) * 160 + i };
  }
  return { kind: 'none' };
}

/** 画架:画布 → 调色盘 → 工具条 */
export function hitEaselPanel(
  L: EaselPanelLayout,
  px: number,
  py: number,
  inBounds: (x: number, y: number) => boolean,
): UiHit {
  if (inRect(L.canvas, px, py)) {
    const x = Math.floor((px - L.canvas.x) / L.pixel);
    const y = Math.floor((py - L.canvas.y) / L.pixel);
    return inBounds(x, y) ? { kind: 'easel', x, y } : { kind: 'none' };
  }
  if (inRect(L.palette, px, py)) {
    const col = Math.floor((px - L.palette.x) / L.paletteCell);
    const row = Math.floor((py - L.palette.y) / L.paletteCell);
    const idx = row * 8 + col;
    if (idx >= 0 && idx < PALETTE_SIZE) return { kind: 'palette', index: idx };
    return { kind: 'none' };
  }
  if (inRect(L.toolbar, px, py)) {
    const third = L.toolbar.w / 3;
    const k = Math.floor((px - L.toolbar.x) / third);
    return { kind: 'toolbar', action: k === 0 ? 'undo' : k === 1 ? 'redo' : 'clear' };
  }
  return { kind: 'none' };
}

/**
 * 音高砖。
 *
 * `bricks` 的**下标就是音高**(`layoutPitchPanel` 按行列顺序压进去的),所以这里用
 * 循环下标 —— 修前用 `indexOf(b)` 找一次同样的东西(多一次 O(n) 且依赖对象同一性)。
 */
export function hitPitchPanel(L: PitchPanelLayout, px: number, py: number): UiHit {
  for (let i = 0; i < L.bricks.length; i += 1) {
    const b = L.bricks[i]!;
    if (inRect(b, px, py)) return { kind: 'brick', pitch: i };
  }
  return { kind: 'none' };
}

/** 模式面板的某一行;`modeOfRow(i)` 给出该行的**线上下标(1 起)** */
export function hitPartyPanel(
  L: PartyPanelLayout,
  px: number,
  py: number,
  modeOfRow: (i: number) => number | undefined,
): UiHit {
  if (!inRect(L.panel, px, py)) return { kind: 'none' };
  for (let i = 0; i < L.rows.length; i += 1) {
    if (inRect(L.rows[i]!, px, py)) {
      const mode = modeOfRow(i);
      return mode === undefined ? { kind: 'none' } : { kind: 'partyMode', mode };
    }
  }
  return { kind: 'none' };
}

/** 命中测试要用到的**面板状态**(`boot.ts` 每帧组装的那一份的子集) */
export interface UiHitArgs {
  panel: UiPanel;
  view: InventoryView;
  easel: PixelEasel;
  partyPanel: { rows: readonly { mode: number }[] };
  /** 配方面板有几行(决定容器高度);不给就用保守上界 */
  recipeNodes?: number;
}

/** 命中测试要用的**两份缓存布局**(与绘制同一份;`UiOverlay` 持有) */
export interface UiHitLayouts {
  inv: InventoryPanelLayout;
  pitch: PitchPanelLayout;
}

/** 分类标签条的**类别序列**(绘制与命中都必须用同一份 —— 顺序即命中区) */
export type TabCategories = readonly (string | null)[];

const NONE: UiHit = { kind: 'none' };

/**
 * 总入口:**只对当前打开的面板做命中**(避免「面板已关但仍吃点击」)。
 *
 * 布局一律**现算**(纯函数、只依赖视口尺寸)⇒ 与绘制那条路不可能分叉;
 * 背包额外接收绘制时缓存的那一份(`lastInvLayout`),因为它与 `resize` 挂钩。
 */
export function hitUiPanel(
  args: UiHitArgs,
  layouts: UiHitLayouts,
  tabCategories: TabCategories,
  viewportW: number,
  viewportH: number,
  px: number,
  py: number,
): UiHit {
  if (args.panel === UiPanel.INVENTORY || args.panel === UiPanel.RECIPE_TREE) {
    return hitInventoryPanel(layouts.inv, px, py, args.view.page, tabCategories);
  }
  if (args.panel === UiPanel.PIXEL_EASEL) {
    return hitEaselPanel(
      layoutEaselPanel(viewportW, viewportH),
      px,
      py,
      (x, y) => args.easel.inBounds(x, y),
    );
  }
  if (args.panel === UiPanel.PITCH_EDITOR) {
    return hitPitchPanel(layouts.pitch, px, py);
  }
  if (args.panel === UiPanel.PARTY) {
    const rows = args.partyPanel.rows;
    return hitPartyPanel(
      layoutPartyPanel(viewportW, viewportH, rows.length),
      px,
      py,
      (i) => rows[i]?.mode,
    );
  }
  return NONE;
}

/**
 * ★ WS-FND-166 的核心判据:**这一下算不算按在 UI 上**。
 *
 * 修前 `boot.onPointerDown` 只看"格子级命中"(`hit.kind !== 'none'`),于是
 * **按在面板空白处**返回 `none` ⇒ 世界拖动与虚拟摇杆同时吃掉这一下:
 * 表现就是「单指拖背包时角色一边走」。这里把"面板容器"也算进去 ——
 * 面板开着时,它的矩形内一寸都不给世界。
 */
export function uiConsumesPoint(
  args: UiHitArgs,
  layouts: UiHitLayouts,
  tabCategories: TabCategories,
  viewportW: number,
  viewportH: number,
  px: number,
  py: number,
): boolean {
  if (args.panel === UiPanel.NONE) return false;
  if (hitUiPanel(args, layouts, tabCategories, viewportW, viewportH, px, py).kind !== 'none') {
    return true;
  }
  const rect = panelRectOf(
    args.panel,
    viewportW,
    viewportH,
    args.recipeNodes ?? RECIPE_MAX_ROWS,
    Math.max(1, args.partyPanel.rows.length),
  );
  return rect !== null && inRect(rect, px, py);
}
