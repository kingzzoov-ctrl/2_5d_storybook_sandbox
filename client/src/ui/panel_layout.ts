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

/* ★ WS-FND-166:`panelRectOf()` 要按 `UiPanel` 查表 —— 命中/绘制/「算不算按在 UI 上」
   因此共用**同一批**布局函数(纯模块,零 DOM)。 */
import { UiPanel } from './state_machine.ts';

/** 面板矩形(CSS 像素) */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * ★ WS-FND-166:一个矩形**夹进视口**的结果 —— 全仓唯一一处做这件事。
 *
 * ## 为什么必须有它(实测踩过)
 *
 * 修前 5 个布局函数各写一份 `x = max(0, …)` / `y = max(0, …)`,而**尺寸**完全没夹:
 * ``` 
 * 音高面板   恒 16×26 + 32 = 448px 宽(360px 手机:右边界越界 88px)
 * 画架面板   恒 336 + 32  = 368px 宽(360px 手机:越界 8px)
 * 配方面板   这里写 300,绘制层另写 320 ⇒ 两处各算一份,窄屏从**左边界**出去
 * ```
 * 越界的后果不是"难看":命中测试 `inRect` 用的是同一个矩形 ⇒ 越界的那几列
 * **数学上永远点不到**。而位置夹取只救边缘,救不了"比视口还大"的面板。
 *
 * ⇒ 现在:位置与尺寸都在本函数里夹,各布局函数只回答"内容想要多大"
 * (`content`),绘制与命中读**同一个** `rect`。
 *
 * ## 返回值
 * ```
 * rect         夹取后的可用矩形(保证 x>=0, y>=0, x+w<=vw, y+h<=vh)
 * content      内容**想要**的尺寸(未夹)—— 调用方据此画裁剪/滚动条
 * scale        内容被等比压小的比例(1 = 没压)
 * scrollable   内容比视口大 ⇒ 需要滚动(此时 scrollMax* 给出可滚动距离)
 * ```
 * 非法输入(`NaN` / 负数 / 0)一律当 1:让 `NaN` 流进 `fillRect` 的结果是
 * 面板**整个消失**,而控制台一句话都不说。
 */
export interface FitRect {
  rect: PanelRect;
  content: { w: number; h: number };
  scale: number;
  scrollable: boolean;
  scrollMaxX: number;
  scrollMaxY: number;
}

/** 有限的数,否则退回 `fallback`(负对照:`NaN` / `Infinity` 不许流进布局)。 */
function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** 把一个矩形夹进 `viewportW × viewportH`(位置 + 尺寸,单一事实源)。 */
export function fitPanelRect(r: PanelRect, viewportW: number, viewportH: number): FitRect {
  const vw = Math.max(1, finiteOr(viewportW, 1));
  const vh = Math.max(1, finiteOr(viewportH, 1));
  const w = Math.max(1, finiteOr(r.w, 1));
  const h = Math.max(1, finiteOr(r.h, 1));
  const fw = Math.min(w, vw);
  const fh = Math.min(h, vh);
  const x = Math.min(Math.max(finiteOr(r.x, 0), 0), Math.max(0, vw - fw));
  const y = Math.min(Math.max(finiteOr(r.y, 0), 0), Math.max(0, vh - fh));
  return {
    rect: { x, y, w: fw, h: fh },
    content: { w, h },
    scale: Math.min(1, vw / w, vh / h),
    scrollable: w > vw + 0.5 || h > vh + 0.5,
    scrollMaxX: Math.max(0, w - fw),
    scrollMaxY: Math.max(0, h - fh),
  };
}

/** 背包/配方面板几何 */
export interface InventoryPanelLayout {
  panel: PanelRect;
  /**
   * 夹取结果(★ WS-FND-166)—— 绘制/命中读 `panel`,而"内容想要多大 / 会不会被裁"
   * 在这一份里,**不另算**。
   */
  fit: FitRect;
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

/**
 * 格子尺寸的**硬下限**(★ WS-FND-166)。
 *
 * `CELL_PX_MIN`(18)是"点得准"的期望值,但它是**愿望**,不是几何约束:
 * 10 行 × 18px + 106px = 286px,在 200px 高的浮窗里必然越界。
 * ⇒ 真正的下限是 8(再小就不是"点不准"而是"点不到"),它之下才允许裁剪
 * (`fitPanelRect().scrollable === true`)。
 */
export const CELL_PX_HARD_MIN = 8;
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
   * 格子尺寸**随视口收窄** —— ★ WS-FND-166 起**两个方向都算**。
   *
   * ## 为什么不能固定 `CELL_PX`(实测踩过)
   *
   * 固定 30px 时面板恒宽 `16×30 + 32 = 512`。在 1280 宽的桌面上没问题,
   * 但窄屏(如 360px)会**直接溢出屏幕右侧 150px** —— 格子画到视口外,
   * 指针也永远点不到那些格子(命中测试用的是同一份布局)。
   *
   * ## 为什么还要看**高度**(第二轮审计 P1)
   *
   * 只看宽度的第二条:`10 行 × 20px + 106px = 306px`,在 360×300 的横屏/浮窗里
   * 面板底部从**下边界**出去 —— 而"靠右下"给的 `y = Math.max(0, …)` 只救上边界。
   * ⇒ 格子取 `min(按宽, 按高)`;宽度那一路仍以 `CELL_PX_MIN` 为期望下限,
   *   真正的硬下限是 `CELL_PX_HARD_MIN`(8)。
   */
  const availW = Math.max(1, viewportW - PANEL_MARGIN * 2);
  const availH = Math.max(1, viewportH - PANEL_MARGIN * 2 - TITLE_H - TAB_H - PAGER_H);
  const byW = Math.floor(availW / cols);
  const byH = Math.floor(availH / rows);
  const cell = Math.max(CELL_PX_HARD_MIN, Math.min(Math.max(CELL_PX_MIN, Math.min(CELL_PX, byW)), byH));
  const gridW = cols * cell;
  const gridH = rows * cell;
  const w = gridW + PANEL_MARGIN * 2;
  const h = TITLE_H + TAB_H + gridH + PAGER_H + PANEL_MARGIN * 2;
  /* 面板靠右下:左侧留给 HUD,中间留给世界。
     ★ 位置与**尺寸**一起夹(`fitPanelRect`):只夹位置救不了"比视口还大"的面板
       (`content` / `scrollable` 因此也一起报出来,而不是让越界悄悄发生)。 */
  const fit = fitPanelRect({
    x: viewportW - w - PANEL_MARGIN,
    y: viewportH - h - PANEL_MARGIN,
    w,
    h,
  }, viewportW, viewportH);
  const panel = fit.rect;
  const x = panel.x;
  const y = panel.y;
  const gridX = x + PANEL_MARGIN;
  const gridY = y + PANEL_MARGIN + TITLE_H + TAB_H;
  return {
    panel,
    fit,
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
 * 配方树最多画几行(★ WS-FND-166:绘制层与 `panelRectOf` 共用这一个上限)。
 *
 * 修前绘制层写死 `Math.min(20, tree.nodeCount)`,而布局默认 18 ⇒ 面板高矮两个口径。
 */
export const RECIPE_MAX_ROWS = 20;
/**
 * 配方面板**底部信息带**的高度(加工台 + 节点/深度两行)。
 *
 * ★ WS-FND-166:修前这两行画在 `panel.y + h - 42` / `- 24`,而 `h` 是绘制层
 * 自己拼的 `30 + rows*18 + 74` —— 与布局那条路**两套高度**。现在高度只有布局一处,
 * 底部带显式留出来(`h − (标题 + 行区)` 恒 ≥ `RECIPE_FOOTER_H`)。
 */
export const RECIPE_FOOTER_H = 40;

/**
 * 配方面板**宽度上限**(★ WS-FND-166)。
 *
 * 修前是两处各写一份:本文件写 300,而绘制层(`three/ui_binding.ts` 的 `drawRecipe`)
 * 另写 `w = 320` 且从**右边界**贴边 ⇒ 在视口 < 336 时面板从**左边界**出去,
 * 而命中用的是本文件那一份 ⇒ 画出来的地方点不到、点得到的地方没画。
 * 现在只有这一处:绘制与命中都读 `layoutRecipePanel().panel`。
 */
export const RECIPE_PANEL_W_MAX = 320;
/** 配方面板宽度下限(再窄就装不下"· 名字 ×N"这一行) */
export const RECIPE_PANEL_W_MIN = 160;

/**
 * 配方树的左侧面板几何。
 *
 * 行数由调用方给的节点数决定(`buildRecipeTree().nodeCount` 或 `flattenTree().length`),
 * 所以本函数不假设固定行数 —— 配方深度是数据驱动的。
 *
 * ★ WS-FND-166:宽度按视口算(`[RECIPE_PANEL_W_MIN, RECIPE_PANEL_W_MAX]`),
 * 行数再按**可用高度**反算,最后整块夹进视口 —— 于是窄屏不会"从左边出去"。
 */
export function layoutRecipePanel(
  viewportW: number,
  viewportH: number,
  nodeCount: number,
  maxVisibleRows = RECIPE_MAX_ROWS,
): {
  panel: PanelRect;
  title: PanelRect;
  rows: RecipeRowLayout[];
  visibleRows: number;
  scrollable: boolean;
} {
  const n = Math.max(0, Math.trunc(nodeCount));
  /* 可用高度只留给"行区" —— 标题与上下边距是固定的 */
  const availRows = Math.max(1, Math.floor(
    (viewportH - PANEL_MARGIN * 2 - TITLE_H - RECIPE_FOOTER_H) / RECIPE_ROW_H,
  ));
  const visibleRows = Math.max(1, Math.min(maxVisibleRows, Math.max(1, n), availRows));
  const w = Math.max(
    RECIPE_PANEL_W_MIN,
    Math.min(RECIPE_PANEL_W_MAX, viewportW - PANEL_MARGIN * 2),
  );
  const h = TITLE_H + visibleRows * RECIPE_ROW_H + RECIPE_FOOTER_H + PANEL_MARGIN * 2;
  /* 靠左上,与右下角的背包错开;位置与尺寸一起夹(与其它面板同一条口径) */
  const panel = fitPanelRect({
    x: PANEL_MARGIN,
    y: PANEL_MARGIN,
    w,
    h,
  }, viewportW, viewportH).rect;
  const x = panel.x;
  const y = panel.y;
  const rows: RecipeRowLayout[] = [];
  for (let i = 0; i < visibleRows; i += 1) {
    rows.push({
      rect: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN + TITLE_H + i * RECIPE_ROW_H, w: panel.w - PANEL_MARGIN * 2, h: RECIPE_ROW_H },
      depth: 0,
      indent: 0,
    });
  }
  return {
    panel,
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: panel.w - PANEL_MARGIN * 2, h: TITLE_H },
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
  /** ★ WS-FND-166:夹取结果(`panel` 与"内容想要多大"都在这一份里) */
  fit: FitRect;
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

/**
 * 像素画架几何。
 *
 * ## 面板宽度**必须能装下工具条那一行文字**(不改的理由,实测踩过)
 *
 * 初版是 `max(224, 176) + 32 = 256`,但工具条文字
 * `[Z] 撤销(64)  [Y] 重做(0)  [X] 清空  [C] 填充` 在 12px 等宽字体下约 317px ——
 * 直接**溢出到面板外面**(截图实测:字飘在草地上)。所以宽度取三者最大值加内边距:
 * 画布、调色盘、**工具条文字预留**(见 `EASEL_TOOLBAR_RESERVE_PX`)。
 *
 * ## ★ WS-FND-166:尺寸随视口缩放(修前恒 368×416)
 *
 * 修前面板恒 368px 宽,360px 的手机上右边界越界 8px;矮屏(360×360)时高度也越界。
 * 而命中用**同一个矩形** ⇒ 越界的那部分不是"难点",是**点不到**。
 * ⇒ 现在:图素边长 / 调色格边长 / 工具条预留都按可用宽高等比缩,
 *   画布再按剩余高度二次夹(宁可画布小,也不让工具条被裁掉)。
 */
export function layoutEaselPanel(viewportW: number, viewportH: number): EaselPanelLayout {
  const availW = Math.max(1, viewportW - PANEL_MARGIN * 2);
  const availH = Math.max(1, viewportH - PANEL_MARGIN * 2);
  /** 设计档下的自然宽度(工具条预留 + 两侧边距) */
  const naturalW = EASEL_TOOLBAR_RESERVE_PX + PANEL_MARGIN * 2;
  const wScale = Math.min(1, availW / naturalW);
  const palCell = Math.max(
    EASEL_PALETTE_CELL_MIN,
    Math.min(EASEL_PALETTE_CELL_PX, Math.floor(EASEL_PALETTE_CELL_PX * wScale)),
  );
  const palW = PALETTE_COLS * palCell;
  const toolbarReserve = Math.max(
    EASEL_TOOLBAR_RESERVE_MIN,
    Math.round(EASEL_TOOLBAR_RESERVE_PX * wScale),
  );
  /* 高度:标题 + 画布 + 间隔 + 调色盘 + 工具条 + 外侧 —— 画布最多能占多少 */
  const fixedH = TITLE_H + PANEL_MARGIN + EASEL_TOOLBAR_H + PANEL_MARGIN * 2;
  const maxCanvasH = Math.max(
    EASEL_PIXEL_MIN * EASEL_SIZE,
    availH - fixedH - PALETTE_ROWS_UI * palCell,
  );
  const pixel = Math.max(EASEL_PIXEL_MIN, Math.min(
    EASEL_PIXEL_PX,
    Math.floor((EASEL_PIXEL_PX * availW) / naturalW),
    Math.floor(maxCanvasH / EASEL_SIZE),
  ));
  const canvasSize = pixel * EASEL_SIZE;
  const w = Math.min(availW, Math.max(canvasSize, palW, toolbarReserve) + PANEL_MARGIN * 2);
  const h = TITLE_H + canvasSize + PANEL_MARGIN + PALETTE_ROWS_UI * palCell
    + EASEL_TOOLBAR_H + PANEL_MARGIN * 2;
  const fit = fitPanelRect({
    x: Math.round((viewportW - w) / 2),
    y: Math.round((viewportH - h) / 2),
    w,
    h,
  }, viewportW, viewportH);
  const panel = fit.rect;
  const x = panel.x;
  const y = panel.y;
  return {
    panel,
    fit,
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: panel.w - PANEL_MARGIN * 2, h: TITLE_H },
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
      w: panel.w - PANEL_MARGIN * 2,
      h: EASEL_TOOLBAR_H,
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

/** 图素边长**设计档**(1280 宽桌面;窄屏按可用宽度等比缩) */
export const EASEL_PIXEL_PX = 14;
/** 图素边长硬下限(再小就不是"像素画",而是噪声) */
export const EASEL_PIXEL_MIN = 4;
/** 调色格边长设计档 */
export const EASEL_PALETTE_CELL_PX = 22;
/** 调色格边长硬下限(拇指仍点得到) */
export const EASEL_PALETTE_CELL_MIN = 6;
/** 工具条行高(标题下方那一行 [Z]/[Y]/[X]/[C]) */
export const EASEL_TOOLBAR_H = 28;
/** 工具条文字预留的**最小**宽度(窄屏等比缩之后的兜底) */
export const EASEL_TOOLBAR_RESERVE_MIN = 120;

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
  /** ★ WS-FND-166:夹取结果(绘制/命中读 `panel`,越界与否读这一份) */
  fit: FitRect;
  title: PanelRect;
  /** 32 个音高砖(2 行 × 16 列) */
  bricks: PanelRect[];
  /** 每块尺寸(★ WS-FND-166:**随视口收窄**,不再是恒定的 `BRICK_W`) */
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
/**
 * 砖宽的**硬下限**(★ WS-FND-166)。
 *
 * 修前砖宽恒 26 ⇒ 面板恒 `16×26 + 32 = 448px`;360px 的手机上右边界越界 88px,
 * 而命中用同一个矩形 ⇒ 右侧 3 列**数学上点不到**。窄屏时必须能缩到 18(实测的
 * 360px 档),10 是"再小就不值得画"的那条线。
 */
export const PITCH_BRICK_W_MIN = 10;
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
  /**
   * ★ WS-FND-166:砖宽**随视口收窄**(修前是恒定的 `BRICK_W`)。
   *
   * 越界不是"难看":`inRect` 用的是**同一个**矩形 ⇒ 右边界外的那几列
   * 不是"难点",是**点不到**。所以面板宽度必须 ≤ 视口可用宽度。
   */
  const availW = Math.max(1, viewportW - PANEL_MARGIN * 2 * 2);
  const brickW = Math.max(
    PITCH_BRICK_W_MIN,
    Math.min(BRICK_W, Math.floor(availW / PITCH_BRICK_COLS)),
  );
  const gridW = PITCH_BRICK_COLS * brickW;
  const w = Math.min(Math.max(1, viewportW - PANEL_MARGIN * 2), gridW + PANEL_MARGIN * 2);
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
  /* 距底部留出 `PITCH_BOTTOM_CLEARANCE`,让开 index.html 里的 `#hint` 提示条 ——
     只留 PANEL_MARGIN 会正好压在提示条上(截图实测)。位置与尺寸一起夹:
     矮视口时 `viewportH - h - CLEARANCE` 是负的,夹取之后面板仍在屏内。 */
  const fit = fitPanelRect({
    x: Math.round((viewportW - w) / 2),
    y: viewportH - h - PITCH_BOTTOM_CLEARANCE,
    w,
    h,
  }, viewportW, viewportH);
  const panel = fit.rect;
  const x = panel.x;
  const y = panel.y;
  const bricks: PanelRect[] = [];
  for (let i = 0; i < total; i += 1) {
    const row = Math.floor(i / PITCH_BRICK_COLS);
    const col = i % PITCH_BRICK_COLS;
    bricks.push({
      x: x + PANEL_MARGIN + col * brickW,
      y: y + PANEL_MARGIN + TITLE_H + row * BRICK_H,
      w: brickW,
      h: BRICK_H,
    });
  }
  return {
    panel,
    fit,
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: gridW, h: TITLE_H },
    bricks,
    brickW,
    brickH: BRICK_H,
    footer: {
      x: x + PANEL_MARGIN,
      y: y + PANEL_MARGIN + TITLE_H + PITCH_BRICK_ROWS * BRICK_H,
      w: gridW,
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
 *
 * ★ WS-FND-166:与其它面板走**同一条**夹取 —— `max(120, …)` 那个硬下限
 * 在超窄视口(如 100px 浮窗)下会让条子从右边出去,而它同样是可点的区域。
 */
export function layoutBossHudBand(viewportW: number, viewportH: number): PanelRect {
  const w = Math.min(HP_BAR_WIDTH, Math.max(120, viewportW - 80));
  return fitPanelRect({
    x: (viewportW - w) / 2,
    y: HP_BAR_TOP_MARGIN,
    w,
    h: HP_BAR_HEIGHT,
  }, viewportW, viewportH).rect;
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
    /* ★ WS-FND-166:同一条夹取 —— 260px 的提示条在窄屏上会从左边出去 */
    hint: fitPanelRect({
      x: Math.round((viewportW - w) / 2),
      y: viewportH - h - 44,
      w,
      h,
    }, viewportW, viewportH).rect,
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

/* ────────────────────────── 派对模式面板(★ WS-FND-151) ────────────────────────── */

/**
 * 模式选择面板的几何。
 *
 * ## 为什么高度是算出来的而不是写死的
 * 行数来自冻结层(`PARTY_MODES.length`),宽度要装得下**一句话规则**
 * (`PARTY_MODES[].note`,最长的一条约 40 个汉字)。而窄屏(360px)装不下 8 行 ——
 * 于是 `visibleRows` 由**可用高度反算**,面板因此永远落在视口内
 * (`layoutFitsViewport` 的不变量,判据对 360/1280 两档都断言)。
 */
export interface PartyPanelLayout {
  panel: PanelRect;
  /** ★ WS-FND-166:夹取结果(与其它面板同一条口径) */
  fit: FitRect;
  title: PanelRect;
  /** 每行高度(行内两行文字:名字 / 规则) */
  rowH: number;
  /** 可见行矩形(下标 = 列表行下标,不是滚动偏移) */
  rows: PanelRect[];
  /** 底部提示条(键位 + "当前:xxx") */
  footer: PanelRect;
  /** 实际可见行数(窄屏会小于总模式数) */
  visibleRows: number;
  /** 列表比可见区更长 ⇒ 需要翻页(今天 4 档,桌面恒 `false`) */
  scrollable: boolean;
}

/** 面板最大宽度(再宽就与右下角背包面板抢地方了) */
export const PARTY_PANEL_W = 520;
/** 一行的高度(名字一行 + 规则一行) */
export const PARTY_ROW_H = 46;
/**
 * 模式面板最多画几行(★ WS-FND-166)。
 *
 * 绘制层与 `panelRectOf()` **共用这一个上限** —— 否则"按在面板空白处算不算 UI"
 * 会用另一个高度算,而那正是「单指拖背包时角色同时走路」的形态。
 */
export const PARTY_MAX_ROWS = 8;
/** 底部提示条高度 */
export const PARTY_FOOTER_H = 22;

export function layoutPartyPanel(
  viewportW: number,
  viewportH: number,
  rowCount: number,
  maxVisibleRows = PARTY_MAX_ROWS,
): PartyPanelLayout {
  const n = Math.max(0, Math.trunc(Number.isFinite(rowCount) ? rowCount : 0));
  const availH = viewportH - PANEL_MARGIN * 2 - TITLE_H - PARTY_FOOTER_H;
  const byH = Math.floor(availH / PARTY_ROW_H);
  const visibleRows = Math.max(1, Math.min(Math.max(1, maxVisibleRows), Math.max(1, n), Math.max(1, byH)));
  const w = Math.max(180, Math.min(PARTY_PANEL_W, viewportW - PANEL_MARGIN * 2));
  const h = TITLE_H + visibleRows * PARTY_ROW_H + PARTY_FOOTER_H + PANEL_MARGIN * 2;
  /* 居中:它是"做决定"的面板,不该贴在角落(背包在右下、配方在左上)。
     ★ WS-FND-166:位置与**尺寸**一起夹 —— 超窄视口下 `max(180, …)` 那个下限会让
     面板从右边出去,而命中用同一个矩形(`inRect`)。 */
  const fit = fitPanelRect({
    x: Math.round((viewportW - w) / 2),
    y: Math.round((viewportH - h) / 2),
    w,
    h,
  }, viewportW, viewportH);
  const panel = fit.rect;
  const x = panel.x;
  const y = panel.y;
  const rows: PanelRect[] = [];
  for (let i = 0; i < visibleRows; i += 1) {
    rows.push({
      x: x + PANEL_MARGIN,
      y: y + PANEL_MARGIN + TITLE_H + i * PARTY_ROW_H,
      w: panel.w - PANEL_MARGIN * 2,
      h: PARTY_ROW_H,
    });
  }
  return {
    panel,
    fit,
    title: { x: x + PANEL_MARGIN, y: y + PANEL_MARGIN, w: panel.w - PANEL_MARGIN * 2, h: TITLE_H },
    rowH: PARTY_ROW_H,
    rows,
    footer: {
      x: x + PANEL_MARGIN,
      y: y + PANEL_MARGIN + TITLE_H + visibleRows * PARTY_ROW_H,
      w: panel.w - PANEL_MARGIN * 2,
      h: PARTY_FOOTER_H,
    },
    visibleRows,
    scrollable: n > visibleRows,
  };
}

/** 第 `i` 行的矩形;可见区外返回 `null`(调用方跳过,不画到面板外)。 */
export function partyRowRect(layout: PartyPanelLayout, i: number): PanelRect | null {
  const k = Math.trunc(Number.isFinite(i) ? i : -1);
  if (k < 0 || k >= layout.rows.length) return null;
  return layout.rows[k]!;
}

/**
 * ★ WS-FND-166:面板容器矩形 —— 绘制 / 命中 / 「这一下算不算按在 UI 上」的**唯一**入口。
 *
 * ## 为什么必须是入口而不是各调用点自己算
 *
 * 修前有三条路各算各的:
 * ```
 * ui_binding.drawInventory   用 resize 时缓存的 this.inv
 * ui_binding.hit             用 lastInvLayout(绘制时存的)或 this.inv
 * boot.onPointerDown         只看 ui.hit() 的**格子级**结果 ⇒ 按在面板空白处返回
 *                            'none' ⇒ 摇杆 / 世界拖动照常拿到这一下
 * ```
 * 第三条正是实测的「单指拖背包时角色同时走路」—— 两条监听各自都"工作正常"。
 * 判定必须能在 node 里断言,所以它落在本模块(纯、零 DOM),而不是事件回调里。
 *
 * ## 参数
 *
 * `recipeNodes` / `partyRows` 决定那两个**行数驱动**的布局有多高;不传时给保守上界
 * (与绘制层的上限同款)⇒ 「按在面板上」判得更宽一点,而不是漏判
 * (漏判的那一下会**同时**走路)。
 */
export function panelRectOf(
  panel: UiPanel,
  viewportW: number,
  viewportH: number,
  recipeNodes = RECIPE_MAX_ROWS,
  partyRows = PARTY_MAX_ROWS,
): PanelRect | null {
  switch (panel) {
    case UiPanel.INVENTORY: return layoutInventoryPanel(viewportW, viewportH).panel;
    case UiPanel.RECIPE_TREE: return layoutRecipePanel(viewportW, viewportH, recipeNodes).panel;
    case UiPanel.PIXEL_EASEL: return layoutEaselPanel(viewportW, viewportH).panel;
    case UiPanel.PITCH_EDITOR: return layoutPitchPanel(viewportW, viewportH).panel;
    case UiPanel.PARTY: return layoutPartyPanel(viewportW, viewportH, partyRows).panel;
    default: return null;
  }
}
