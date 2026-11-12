/**
 * UI 面板布局 —— **纯逻辑,零依赖**(不 import three、不碰 DOM)。
 *
 * ## 为什么布局要单独一层
 *
 * `ui/inventory.ts`、`ui/recipe_tree.ts`、`ui/boss_hud.ts` 等模块只算**数据**
 * (哪些格子、哪条配方、血条比例),它们不知道也**不该知道**怎么画。
 * 真正的绘制在 `three/ui_binding.ts`(那里才能碰 DOM/three)。
 *
 * 中间需要一层回答「这个面板摆在屏幕哪、多宽多高、格子几列几行」——
 * 这件事**是纯计算**,所以放在本文件:
 *  - 可在 node 里直接断言(不需要浏览器);
 *  - 绘制层只做「按矩形填像素」,不含任何算术决策。
 *
 * ## 与 boss_hud 的分工
 *
 * `ui/boss_hud.ts` 已经自带 `layoutHpBar()`(血条的屏幕布局),那是血条的**专属**布局。
 * 本文件管**面板容器**布局(背包/配方/画架/蓝图/音高编辑器),两者不重复:
 * 血条布局由 `boss_hud` 自己算,本文件只给它一个面板矩形。
 */

import { HP_BAR_HEIGHT, HP_BAR_TOP_MARGIN, HP_BAR_WIDTH } from './boss_hud.ts';
import {
  INVENTORY_PAGE_COUNT,
  INVENTORY_ROWS,
  SLOTS_PER_PAGE,
  SLOTS_PER_PAGE_ROWS,
  SLOTS_PER_ROW,
} from './inventory.ts';
import { EASEL_SIZE, PALETTE_SIZE } from './pixel_easel.ts';
/* ⚠ 音高砖的行列数在 `audio.ts`(它是音频模块的界面契约),**不在** `pixel_easel.ts`。
   两者都以 32 音高为基准(2×16),但归属模块不同 —— 写错 import 会在构建期直接报错,
   这里记一笔免得下次再放错。 */
import { PITCH_BRICK_COLS, PITCH_BRICK_ROWS } from '../audio.ts';

/** 面板矩形(CSS 像素) */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 背包/配方面板几何 */
export interface InventoryPanelLayout {
  panel: PanelRect;
  /** 标题栏 */
  title: PanelRect;
  /** 分类标签条(12 个分类) */
  tabStrip: PanelRect;
  /** 每格边长(正方形) */
  cell: number;
  /** 网格起点 */
  gridX: number;
  gridY: number;
  /** 当前页显示的列/行 */
  cols: number;
  rows: number;
  /** 分页条 */
  pager: PanelRect;
}

/** 格子尺寸(含 1px 间隔) */
export const CELL_PX = 30;
/**
 * 格子尺寸下限。
 *
 * 窄屏(360px)时按可用宽度反算出的格子约 20px;再小就点不准了。
 * 所以夹在这个下限:宁可面板略微超出,也不让格子小到不可用。
 */
export const CELL_PX_MIN = 18;
/** 面板外边距 */
export const PANEL_MARGIN = 16;
/** 标题栏高度 */
export const TITLE_H = 28;
/** 分类标签条高度 */
export const TAB_H = 24;
/** 分页条高度 */
export const PAGER_H = 22;
/** 图标在格子内的内缩(留出边框) */
export const CELL_INSET = 3;

/**
 * 算背包装备面板的布局。
 *
 * 列数固定 `SLOTS_PER_ROW`(16),行数 = `SLOTS_PER_PAGE_ROWS`(10),
 * 所以一页 `SLOTS_PER_PAGE`(160)格 —— 这与 `inventory.buildView()` 的分页一致。
 */
export function layoutInventoryPanel(viewportW: number, viewportH: number): InventoryPanelLayout {
  const cols = SLOTS_PER_ROW;
  const rows = SLOTS_PER_PAGE_ROWS;
  /**
   * 格子尺寸**随视口收窄**。
   *
   * ## 为什么不能固定 `CELL_PX`(实测踩过)
   *
   * 固定 30px 时面板恒宽 `16×30 + 32 = 512`。在 1280 宽的桌面上没问题,
   * 但窄屏(如 360px)会**直接溢出屏幕右侧 150px** —— 格子画到视口外,
   * 指针也永远点不到那些格子(命中测试用的是同一份布局)。
   *
   * 所以按可用宽度反算格子大小,并夹在 `[CELL_PX_MIN, CELL_PX]`:
   * 桌面维持原尺寸不变,窄屏等比缩小以保证「面板始终在视口内」。
   * 这与 `layoutFitsViewport` 的不变量一致,测试对 360/640/1920 三档都断言。
   */
  const avail = Math.max(1, viewportW - PANEL_MARGIN * 2);
  const cell = Math.max(CELL_PX_MIN, Math.min(CELL_PX, Math.floor(avail / cols)));
  const gridW = cols * cell;
  const gridH = rows * cell;
  const w = gridW + PANEL_MARGIN * 2;
  const h = TITLE_H + TAB_H + gridH + PAGER_H + PANEL_MARGIN * 2;
  /* 面板靠右下:左侧留给 HUD,中间留给世界 */
  const x = Math.max(0, viewportW - w - PANEL_MARGIN);
  const y = Math.max(0, viewportH - h - PANEL_MARGIN);
  const gridX = x + PANEL_MARGIN;
  const gridY = y + PANEL_MARGIN + TITLE_H + TAB_H;
  return {
    panel: { x, y, w, h },
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: gridW, h: TITLE_H },
    tabStrip: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN + TITLE_H, w: gridW, h: TAB_H },
    cell,
    gridX,
    gridY,
    cols,
    rows,
    pager: { x: x + PANEL_MARGIN, y: gridY + gridH, w: gridW, h: PAGER_H },
  };
}

/** 某格(页内下标)的屏幕矩形 */
export function slotRect(layout: InventoryPanelLayout, indexInPage: number): PanelRect {
  const i = Math.max(0, Math.trunc(indexInPage));
  const col = i % layout.cols;
  const row = Math.floor(i / layout.cols);
  return {
    x: layout.gridX + col * layout.cell,
    y: layout.gridY + row * layout.cell,
    w: layout.cell,
    h: layout.cell,
  };
}

/** 背包面板总行数/总页数(直接取自 inventory,不重算) */
export const INVENTORY_TOTAL_ROWS = INVENTORY_ROWS;
export const INVENTORY_TOTAL_PAGES = INVENTORY_PAGE_COUNT;
export const INVENTORY_PAGE_SLOTS = SLOTS_PER_PAGE;

/* ────────────────────────── 配方树 ────────────────────────── */

export interface RecipeRowLayout {
  rect: PanelRect;
  depth: number;
  /** 缩进像素 */
  indent: number;
}

/** 配方树行高 */
export const RECIPE_ROW_H = 20;
/** 每级缩进 */
export const RECIPE_INDENT_PX = 16;

/**
 * 配方树的左侧面板几何。
 *
 * 行数由调用方给的节点数决定(`buildRecipeTree().nodeCount` 或 `flattenTree().length`),
 * 所以本函数不假设固定行数 —— 配方深度是数据驱动的。
 */
export function layoutRecipePanel(
  viewportW: number,
  viewportH: number,
  nodeCount: number,
  maxVisibleRows = 18,
): {
  panel: PanelRect;
  title: PanelRect;
  rows: RecipeRowLayout[];
  visibleRows: number;
  scrollable: boolean;
} {
  const n = Math.max(0, Math.trunc(nodeCount));
  const visibleRows = Math.max(1, Math.min(maxVisibleRows, n));
  const w = 300;
  const h = TITLE_H + visibleRows * RECIPE_ROW_H + PANEL_MARGIN * 2;
  /* 靠左上,与右下角的背包错开 */
  const x = PANEL_MARGIN;
  const y = PANEL_MARGIN;
  const rows: RecipeRowLayout[] = [];
  for (let i = 0; i < visibleRows; i += 1) {
    rows.push({
      rect: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN + TITLE_H + i * RECIPE_ROW_H, w: w - PANEL_MARGIN * 2, h: RECIPE_ROW_H },
      depth: 0,
      indent: 0,
    });
  }
  return {
    panel: { x, y, w, h: Math.min(h, viewportH - PANEL_MARGIN * 2) },
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: w - PANEL_MARGIN * 2, h: TITLE_H },
    rows,
    visibleRows,
    scrollable: n > visibleRows,
  };
}

/**
 * 按节点深度分配缩进。
 *
 * `flattenTree()` 给的是深度优先的节点序列,每个节点自带 `depth`;
 * 这里把它转成「行矩形 + 缩进」,绘制层据此画树形。
 */
export function indentRecipeRows(rows: readonly RecipeRowLayout[], depths: readonly number[]): RecipeRowLayout[] {
  return rows.map((r, i) => {
    const d = Math.max(0, Math.trunc(depths[i] ?? 0));
    return { ...r, depth: d, indent: d * RECIPE_INDENT_PX };
  });
}

/* ────────────────────────── 像素画架 ────────────────────────── */

export interface EaselPanelLayout {
  panel: PanelRect;
  title: PanelRect;
  /** 16×16 画布 */
  canvas: PanelRect;
  /** 每图素边长 */
  pixel: number;
  /** 调色盘(8×4) */
  palette: PanelRect;
  paletteCell: number;
  /** 工具条(撤销/重做/清空) */
  toolbar: PanelRect;
}

/** 调色盘列/行 —— 与 32 色对称 */
export const PALETTE_COLS = 8;
export const PALETTE_ROWS_UI = 4;

export function layoutEaselPanel(viewportW: number, viewportH: number): EaselPanelLayout {
  const pixel = 14;
  const canvasSize = pixel * EASEL_SIZE;
  const palCell = 22;
  const palW = PALETTE_COLS * palCell;
  /**
   * 面板宽度**必须能装下工具条那一行文字**。
   *
   * ## 为什么不能取 `max(canvas, palette)`
   *
   * 初版是 `max(224, 176) + 32 = 256`,但工具条文字
   * `[Z] 撤销(64)  [Y] 重做(0)  [X] 清空  [C] 填充` 在 12px 等宽字体下约 317px ——
   * 直接**溢出到面板外面**(截图实测:字飘在草地上)。
   *
   * 所以宽度取三者的最大值加内边距:画布、调色盘、**加上工具条文字预留**。
   * 这个数改了要让工具条排版跟着变 —— 见 `toolbarTextWidthPx`。
   */
  const toolbarReserve = EASEL_TOOLBAR_RESERVE_PX;
  const w = Math.max(canvasSize, palW, toolbarReserve) + PANEL_MARGIN * 2;
  const h = TITLE_H + canvasSize + PANEL_MARGIN + PALETTE_ROWS_UI * palCell + 28 + PANEL_MARGIN * 2;
  const x = Math.max(0, Math.round((viewportW - w) / 2));
  const y = Math.max(0, Math.round((viewportH - h) / 2));
  return {
    panel: { x, y, w, h },
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: w - PANEL_MARGIN * 2, h: TITLE_H },
    canvas: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN + TITLE_H, w: canvasSize, h: canvasSize },
    pixel,
    palette: {
      x: x + PANEL_MARGIN,
      y: y + PANEL_MARGIN + TITLE_H + canvasSize + PANEL_MARGIN,
      w: palW,
      h: PALETTE_ROWS_UI * palCell,
    },
    paletteCell: palCell,
    toolbar: {
      x: x + PANEL_MARGIN,
      y: y + PANEL_MARGIN + TITLE_H + canvasSize + PANEL_MARGIN + PALETTE_ROWS_UI * palCell,
      w: w - PANEL_MARGIN * 2,
      h: 28,
    },
  };
}

/**
 * 工具条文字预留宽度(像素)。
 *
 * 由 `layoutEaselPanel` 的 `toolbarReserve` 使用 —— 两者必须一致,
 * 否则文字又会溢出面板。独立导出是为了让测试能直接断言
 * 「各面板宽度 ≥ 其最长文字所需宽度」而不必重复那个魔数。
 */
export const EASEL_TOOLBAR_RESERVE_PX = 336;

/** 调色盘第 `i` 色的矩形(索引夹紧到 [0,PALETTE_SIZE)) */
export function paletteRect(layout: EaselPanelLayout, index: number): PanelRect {
  const i = Math.max(0, Math.min(PALETTE_SIZE - 1, Math.trunc(index)));
  const col = i % PALETTE_COLS;
  const row = Math.floor(i / PALETTE_COLS);
  return {
    x: layout.palette.x + col * layout.paletteCell,
    y: layout.palette.y + row * layout.paletteCell,
    w: layout.paletteCell,
    h: layout.paletteCell,
  };
}

/* ────────────────────────── 音高砖 ────────────────────────── */

export interface PitchPanelLayout {
  panel: PanelRect;
  title: PanelRect;
  /** 32 个音高砖(2 行 × 16 列) */
  bricks: PanelRect[];
  /** 每块尺寸 */
  brickW: number;
  brickH: number;
  /**
   * 底部信息行(「已选 N 档」)的矩形。
   *
   * 绘制方必须用**这个**定位,不要用 `panel.h - 20` 之类的算式 ——
   * 那样写会随砖块行数变化再次压到砖上(初版就是这么坏的)。
   */
  footer: PanelRect;
}

export const BRICK_W = 26;
export const BRICK_H = 34;
/** 底部信息行高度(必须计入 `panel.h`,否则会与砖块重叠) */
export const PITCH_FOOTER_H = 22;
/**
 * 音高面板距屏幕底部的留白。
 *
 * 必须大于 `PANEL_MARGIN`:页面底部有一条常驻提示条(`#hint`,约 34px 高),
 * 用 16px 会让面板正好压在它上面(截图实测「WASD / 方向键 平移」被盖住)。
 */
export const PITCH_BOTTOM_CLEARANCE = 56;

export function layoutPitchPanel(viewportW: number, viewportH: number): PitchPanelLayout {
  const total = PITCH_BRICK_COLS * PITCH_BRICK_ROWS;
  const w = PITCH_BRICK_COLS * BRICK_W + PANEL_MARGIN * 2;
  /**
   * 高度**要为底部那行「已选 N 档」留位置**。
   *
   * ## 为什么不能只算 `TITLE_H + 砖高 + 边距`(实测踩过)
   *
   * 初版 `h = 28 + 2×34 + 32 = 128`,而底部文字画在 `panel.y + panel.h - 20`,
   * 即第 2 行砖块(占 y+734..768)内部 —— 文字和砖块**直接叠在一起**,
   * 截图里「已选 3 档」压在一排砖上。
   *
   * 现在显式留出 `PITCH_FOOTER_H`,并把它作为 `footer` 矩形导出,
   * 让绘制方按 `footer` 定位而不是自己用 `panel.h - 20` 猜。
   */
  const h = TITLE_H + PITCH_BRICK_ROWS * BRICK_H + PITCH_FOOTER_H + PANEL_MARGIN * 2;
  const x = Math.max(0, Math.round((viewportW - w) / 2));
  /* 距底部留出 `PITCH_BOTTOM_CLEARANCE`,让开 index.html 里的 `#hint` 提示条 —— 
     只留 PANEL_MARGIN 会正好压在提示条上(截图实测)。 */
  const y = Math.max(0, viewportH - h - PITCH_BOTTOM_CLEARANCE);
  const bricks: PanelRect[] = [];
  for (let i = 0; i < total; i += 1) {
    const row = Math.floor(i / PITCH_BRICK_COLS);
    const col = i % PITCH_BRICK_COLS;
    bricks.push({
      x: x + PANEL_MARGIN + col * BRICK_W,
      y: y + PANEL_MARGIN + TITLE_H + row * BRICK_H,
      w: BRICK_W,
      h: BRICK_H,
    });
  }
  return {
    panel: { x, y, w, h },
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: w - PANEL_MARGIN * 2, h: TITLE_H },
    bricks,
    brickW: BRICK_W,
    brickH: BRICK_H,
    footer: {
      x: x + PANEL_MARGIN,
      y: y + PANEL_MARGIN + TITLE_H + PITCH_BRICK_ROWS * BRICK_H,
      w: w - PANEL_MARGIN * 2,
      h: PITCH_FOOTER_H,
    },
  };
}

/** 音高 `p` 的砖矩形(越界返回 `null`,由调用方决定是否跳过) */
export function brickRect(layout: PitchPanelLayout, p: number): PanelRect | null {
  const i = Math.trunc(p);
  if (i < 0 || i >= layout.bricks.length) return null;
  return layout.bricks[i]!;
}

/* ────────────────────────── Boss 血条 ────────────────────────── */

/**
 * Boss 血条面板矩形。
 *
 * 血条**自身**的算术(宽度、阶段刻度、残影)在 `boss_hud.layoutHpBar()`,
 * 这里只回答「把它摆在屏幕上方哪里」——
 * 所以两个函数是**顺序关系**而非重复:`layoutHpBar(Hp, hp, viewportW, phases)` 拿到
 * 条内布局,本函数给它的可视区域。
 */
export function layoutBossHudBand(viewportW: number, viewportH: number): PanelRect {
  const w = Math.min(HP_BAR_WIDTH, Math.max(120, viewportW - 80));
  return {
    x: (viewportW - w) / 2,
    y: HP_BAR_TOP_MARGIN,
    w,
    h: HP_BAR_HEIGHT,
  };
}

/** 血条可视区是否宽到能显示阶段名(太窄就只画条) */
export function bossHudShowsLabels(viewportW: number): boolean {
  return viewportW >= HP_BAR_WIDTH + 80;
}

/* ────────────────────────── 蓝图 ────────────────────────── */

export interface BlueprintHudLayout {
  /** 提示条(显示「已框选 N 格」) */
  hint: PanelRect;
  /** 框选矩形本身由屏幕坐标直接给出,这里只给提示条位置 */
  visible: boolean;
}

export function layoutBlueprintHud(viewportW: number, viewportH: number, hasSelection: boolean): BlueprintHudLayout {
  const w = 260;
  const h = 26;
  return {
    hint: { x: Math.round((viewportW - w) / 2), y: viewportH - h - 44, w, h },
    visible: hasSelection,
  };
}

/* ────────────────────────── 通用 ────────────────────────── */

/** 一个矩形是否落在视口内(用于跳过完全不可见的绘制) */
export function rectVisible(r: PanelRect, viewportW: number, viewportH: number): boolean {
  return r.x + r.w > 0 && r.y + r.h > 0 && r.x < viewportW && r.y < viewportH;
}

/** 面板留白总量(供测试断言「布局不越界」) */
export function layoutFitsViewport(l: { panel: PanelRect }, viewportW: number, viewportH: number): boolean {
  const p = l.panel;
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= viewportW + 0.5 && p.y + p.h <= viewportH + 0.5;
}
