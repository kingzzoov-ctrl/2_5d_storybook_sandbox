/**
 * UI 绑定层 —— 把纯逻辑模块的**数据**画到 Canvas2D 覆盖层上,并把输入派发回去。
 *
 * ## 为什么放在 `three/` 而不是 `ui/`
 *
 * `ui/**` 是**纯逻辑**目录(零依赖、可在 node 里直接跑测试)。
 * 本文件碰 DOM(`document`、`CanvasRenderingContext2D`、`AudioContext`),不是纯逻辑,
 * 所以不能放进 `ui/` —— 那会污染该目录的可测性契约。
 *
 * ⚠ 注意:**本文件刻意不 import three**。放进 `three/` 只是因为「绑定层统一在这一个目录」,
 * 与「是否用 three」无关。`three/` 的规则是「**只有**这里**可以** import three」,
 * 不是「这里必须 import three」。分层门禁(`three/**` 之外的模块不得 import three)因此仍然成立。
 *
 * ## 职责边界
 *
 * - **本文件不做任何布局算术**:矩形来自 `ui/panel_layout.ts`(纯函数,已被测试覆盖);
 *   血条布局来自 `ui/boss_hud.layoutHpBar()`;格子内容来自 `ui/inventory.buildView()`。
 * - 本文件只做三件事:`fillRect` / `fillText` / `drawImage`,以及把指针坐标翻译成
 *   「命中了哪个格子」再回调出去。
 *
 * 这样「面板画在哪」是可测的,「怎么画」才归这里 —— 而后者出错的形态是**肉眼可见的**。
 */

import {
  CELL_INSET,
  type InventoryPanelLayout,
  type PanelRect,
  type PitchPanelLayout,
  bossHudShowsLabels,
  brickRect,
  layoutEaselPanel,
  layoutInventoryPanel,
  layoutPitchPanel,
  paletteRect,
  slotRect,
} from '../ui/panel_layout.ts';
import {
  BUCKETS,
  INVENTORY_SLOTS,
  type InventoryView,
  slotTooltip,
  usedSlotRatio,
} from '../ui/inventory.ts';
import { type RecipeNode, type RecipeTree, sortedLeaves } from '../ui/recipe_tree.ts';
import {
  type HpBarLayout,
  dangerColor,
  hpBarText,
  layoutHpBar,
} from '../ui/boss_hud.ts';
import type { BossDef } from '../../../shared/types/entities.ts';
import { EASEL_SIZE, type PixelEasel, PALETTE_SIZE, paletteColor, paletteLabel } from '../ui/pixel_easel.ts';
import { type PitchInfo, PITCH_TABLE } from '../audio.ts';
import { ATLAS_CELL, ATLAS_COLS, cellIndexFromId } from '../stage/assembly_math.ts';
import { type UiPanel } from '../ui/state_machine.ts';

/** 指针命中结果 */
export type UiHit =
  | { kind: 'slot'; indexInPage: number; slot: number }
  | { kind: 'tab'; category: string | null }
  | { kind: 'pager'; delta: number }
  | { kind: 'easel'; x: number; y: number }
  | { kind: 'palette'; index: number }
  | { kind: 'brick'; pitch: number }
  | { kind: 'toolbar'; action: 'undo' | 'redo' | 'clear' }
  | { kind: 'none' };

/** 覆盖层绘制所需的一切状态 —— 由 `boot.ts` 每帧组装 */
export interface UiDrawState {
  panel: UiPanel;
  /** 打开动画进度 0..1(state_machine.openingProgress) */
  openProgress: number;
  /** 处于拖拽中(画高亮边框) */
  dragging: boolean;
  /** 悬停格(页内下标,−1 = 无) */
  hoverSlot: number;
  view: InventoryView;
  /** 当前激活分类 */
  activeCategory: string | null;
  recipe: RecipeTree | null;
  recipeId: number;
  recipeBatches: number;
  /** 配方缺料提示(空串 = 可合成) */
  recipeNote: string;
  easel: PixelEasel;
  paletteIndex: number;
  /** 音高砖掩码(32 位) */
  pitchMask: number;
  boss: BossDef | null;
  bossHp: number;
  bossGhost: number;
  /** 预警圈提示文本(空串 = 不画) */
  telegraphNote: string;
  /**
   * 预警圈屏幕多边形 —— 由 `boss_hud.buildTelegraph(spec, cam)` 产出。
   *
   * ⚠ 顶点来自 `boss_hud`(纯逻辑、已被测试覆盖),本层只负责 `moveTo/lineTo`。
   * 不在这里重算几何 —— 那会让「圆环半径」这类算术脱离测试。
   */
  telegraphRing: { x: number; y: number }[];
  /**
   * 预警圈的**内圈**(仅 ANNULUS/CROSS 副臂非空)。
   *
   * ## 为什么必须单独传进来(实测踩过)
   *
   * 只填外圈多边形会把一个**圆环**画成**实心圆盘** —— 第一版就是这样,
   * 结果地面预警"圈"变成一大坨橙色实心块,把立牌全糊住了。
   * `TelegraphGeometry` 本来就把内圈单独给了(`inner`),照原样用即可。
   *
   * 绘制时用 `fill('evenodd')`:外圈顺时针 + 内圈逆时针 ⇒ 中间被挖空,
   * 这才是「环形果冻波」该有的样子。
   */
  telegraphInner: { x: number; y: number }[];
  /** 蓝图提示(空串 = 不画) */
  blueprintNote: string;
  /** 组合键提示 */
  keysHint: string;
}

/** 面板配色(与 HUD 同一套绘本基调) */
const C = {
  panelBg: 'rgba(20,26,42,.94)',
  panelEdge: 'rgba(120,150,210,.42)',
  title: '#e8eefc',
  dim: '#8fa6c8',
  cellBg: 'rgba(255,255,255,.05)',
  cellEdge: 'rgba(140,170,225,.22)',
  hot: 'rgba(255,220,140,.95)',
  ok: '#8fe0a8',
  bad: '#ff9d9d',
  hp: '#e2564a',
  hpGhost: 'rgba(255,255,255,.30)',
  tabOn: 'rgba(255,220,140,.92)',
} as const;

/** 等宽字体栈(与 HUD 一致) */
const MONO = 'ui-monospace,Menlo,Consolas,monospace';

function roundRect(ctx: CanvasRenderingContext2D, r: PanelRect, radius = 6): void {
  const rr = Math.min(radius, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rr, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rr);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rr);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rr);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rr);
  ctx.closePath();
}

function fillPanel(ctx: CanvasRenderingContext2D, r: PanelRect, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, r, 8);
  ctx.fillStyle = C.panelBg;
  ctx.fill();
  ctx.strokeStyle = C.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/** 覆盖层渲染器:持有 canvas、图集、当前布局 */
export class UiOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private atlas: HTMLImageElement | null = null;
  private w = 0;
  private h = 0;
  private inv!: InventoryPanelLayout;
  private pitch!: PitchPanelLayout;
  /** 最近一次绘制的背包布局(命中测试要用同一份,避免两处各算一次) */
  private lastInvLayout: InventoryPanelLayout | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    /* 覆盖层**不吃指针事件**:世界拖动/拾取仍走 window,避免面板把镜头锁死 */
    this.canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:20;';
    this.canvas.id = 'ui_overlay';
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D 上下文不可用');
    this.ctx = ctx;
    this.resize(window.innerWidth, window.innerHeight);
  }

  setAtlas(img: HTMLImageElement | null): void {
    this.atlas = img;
  }

  get hasAtlas(): boolean {
    return this.atlas !== null;
  }

  resize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.inv = layoutInventoryPanel(w, h);
    this.pitch = layoutPitchPanel(w, h);
  }

  /** 背包布局(命中测试与绘制共用同一份) */
  get invLayout(): InventoryPanelLayout {
    return this.inv;
  }

  /* ────────────────────── 绘制 ────────────────────── */

  draw(s: UiDrawState): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    /* 打开动画:整体淡入 + 轻微上移,进度来自 state_machine.openingProgress */
    const a = 0.35 + 0.65 * s.openProgress;

    /* 预警圈画在最底层:它属于世界,不属于面板 */
    this.drawTelegraphRing(s, a);
    if (s.panel === 'INVENTORY' || s.panel === 'RECIPE_TREE') {
      this.lastInvLayout = this.inv;
      this.drawInventory(s, a);
    } else {
      this.lastInvLayout = null;
    }
    if (s.panel === 'RECIPE_TREE' && s.recipe) this.drawRecipe(s, a);
    if (s.panel === 'PIXEL_EASEL') this.drawEasel(s, a);
    if (s.panel === 'PITCH_EDITOR') this.drawPitch(s, a);
    this.drawBoss(s, a);
    this.drawNotes(s, a);
  }

  /** 地面预警圈:多边形顶点全部来自 boss_hud.buildTelegraph */
  private drawTelegraphRing(s: UiDrawState, a: number): void {
    if (s.telegraphRing.length < 3) return;
    const ctx = this.ctx;
    const trace = (poly: { x: number; y: number }[]): void => {
      poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
    };
    ctx.save();
    ctx.globalAlpha = a;
    ctx.beginPath();
    trace(s.telegraphRing);
    /* 有内圈 ⇒ 用 evenodd 把中间挖空,画成真正的「环」而不是实心盘 */
    if (s.telegraphInner.length >= 3) trace(s.telegraphInner);
    ctx.fillStyle = dangerColor(0.55);
    ctx.fill(s.telegraphInner.length >= 3 ? 'evenodd' : 'nonzero');
    /* 内外圈各描一道边,让环的边界清晰(实心盘时只有一道外沿,看不出是环) */
    ctx.strokeStyle = 'rgba(255,90,70,.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    trace(s.telegraphRing);
    ctx.stroke();
    if (s.telegraphInner.length >= 3) {
      ctx.beginPath();
      trace(s.telegraphInner);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawInventory(s: UiDrawState, a: number): void {
    const ctx = this.ctx;
    const L = this.inv;
    fillPanel(ctx, L.panel, a);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.textBaseline = 'middle';
    const total = INVENTORY_SLOTS;
    ctx.fillText(`背包  ${s.view.visibleCount}/${total} 件  ·  已用 ${(usedSlotRatio(s.view.visibleCount) * 100).toFixed(0)}%`, L.title.x, L.title.y + L.title.h / 2);

    /* 分类标签条:12 个分类,按桶宽平分 */
    const tabs = [{ category: null as string | null, label: '全部', color: '#dcd2b8' }, ...BUCKETS.map((b) => ({ category: b.category as string | null, label: b.label, color: b.color }))];
    const tabW = L.tabStrip.w / tabs.length;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < tabs.length; i += 1) {
      const t = tabs[i]!;
      const x = L.tabStrip.x + i * tabW;
      const on = s.activeCategory === t.category;
      ctx.globalAlpha = on ? a : a * 0.55;
      ctx.fillStyle = on ? C.tabOn : C.dim;
      ctx.fillText(t.label, x + tabW / 2, L.tabStrip.y + L.tabStrip.h / 2);
    }
    ctx.textAlign = 'left';
    ctx.globalAlpha = a;

    /* 格子 */
    const page = s.view.page;
    const start = page * 160;
    for (let i = 0; i < L.cols * L.rows; i += 1) {
      const r = slotRect(L, i);
      const slot = start + i;
      const filled = slot < s.view.slots.length && s.view.slots[i] !== undefined && s.view.slots[i]!.visible;
      ctx.fillStyle = C.cellBg;
      ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.strokeStyle = i === s.hoverSlot ? C.hot : C.cellEdge;
      ctx.lineWidth = i === s.hoverSlot ? 2 : 1;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);

      if (!filled) continue;
      const sl = s.view.slots[i]!;
      this.drawItemIcon(sl.item.id, r);
    }
    ctx.restore();
  }

  /** 把图集里该物品的精灵画进格子 */
  private drawItemIcon(itemId: number, r: PanelRect): void {
    const ctx = this.ctx;
    if (!this.atlas) {
      /* 无图集时的降级:画一个色块而不是留空 —— 空白会让人以为「UI 没生效」 */
      ctx.fillStyle = 'rgba(200,220,255,.35)';
      ctx.fillRect(r.x + CELL_INSET, r.y + CELL_INSET, r.w - CELL_INSET * 2, r.h - CELL_INSET * 2);
      return;
    }
    const cell = cellIndexFromId(itemId);
    if (cell < 0) return;
    const col = cell % ATLAS_COLS;
    const row = Math.floor(cell / ATLAS_COLS);
    const box = r.w - CELL_INSET * 2;
    ctx.drawImage(
      this.atlas,
      col * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL,
      r.x + CELL_INSET, r.y + CELL_INSET, box, box,
    );
  }

  private drawRecipe(s: UiDrawState, a: number): void {
    const ctx = this.ctx;
    const tree = s.recipe!;
    const w = 320;
    const rowsN = Math.min(20, tree.nodeCount);
    const h = 30 + rowsN * 18 + 74;
    const panel: PanelRect = { x: this.w - w - 16, y: 16, w, h };
    fillPanel(ctx, panel, a);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.textBaseline = 'top';
    ctx.fillText(`配方  #${s.recipeId} ×${s.recipeBatches}`, panel.x + 12, panel.y + 10);

    /* 缺料提示:来自 checkCraft/missingReport(不是自己拼的字符串) */
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = s.recipeNote ? C.bad : C.ok;
    ctx.fillText(s.recipeNote || '材料齐备,可合成', panel.x + 12, panel.y + 28);

    /* 叶子清单:来自 sortedLeaves */
    let y = panel.y + 46;
    ctx.fillStyle = C.dim;
    for (const leaf of sortedLeaves(tree).slice(0, rowsN)) {
      ctx.fillText(`· ${leaf.name} ×${leaf.need}`, panel.x + 16, y);
      y += 18;
    }
    /* 加工台 */
    const st = tree.stations.length > 0 ? `加工台 ${tree.stations.join(', ')}` : '无需加工台';
    ctx.fillStyle = C.dim;
    ctx.fillText(st, panel.x + 12, panel.y + h - 42);
    ctx.fillText(`节点 ${tree.nodeCount} · 深度 ${tree.maxDepth}${tree.hasCycle ? ' · 有环!' : ''}`, panel.x + 12, panel.y + h - 24);
    ctx.restore();
  }

  private drawEasel(s: UiDrawState, a: number): void {
    const ctx = this.ctx;
    const L = layoutEaselPanel(this.w, this.h);
    fillPanel(ctx, L.panel, a);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.textBaseline = 'top';
    ctx.fillText(`像素画架 ${EASEL_SIZE}×${EASEL_SIZE} · 覆盖 ${(s.easel.coverage() * 100).toFixed(0)}%`, L.title.x, L.title.y + 6);

    /* 16×16 画布 */
    ctx.strokeStyle = C.panelEdge;
    ctx.strokeRect(L.canvas.x - 1, L.canvas.y - 1, L.canvas.w + 2, L.canvas.h + 2);
    /*
     * ⚠ `PixelEasel.snapshot()` 返回的是**裸的 256 长度数组**(Int8Array),
     * 不是 `{pixels, rows}` 对象 —— 我第一版按对象取 `.pixels[0]`,直接抛
     * `TypeError: Cannot read properties of undefined (reading '0')`,
     * 整个页面被错误层接管(截图只剩一行红字)。
     *
     * 用 `toIndices()`:`−1` = 透明,`0..31` = 调色盘下标,语义与绘制需求完全对应。
     */
    const pixels = s.easel.toIndices();
    for (let y = 0; y < EASEL_SIZE; y += 1) {
      for (let x = 0; x < EASEL_SIZE; x += 1) {
        const idx = pixels[y * EASEL_SIZE + x]!;
        if (idx < 0) continue;
        const rgb = PALETTE_RGB[idx] ?? { r: 255, g: 255, b: 255 };
        ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
        ctx.fillRect(L.canvas.x + x * L.pixel, L.canvas.y + y * L.pixel, L.pixel, L.pixel);
      }
    }

    /* 调色盘 32 色 */
    for (let i = 0; i < PALETTE_SIZE; i += 1) {
      const r = paletteRect(L, i);
      const rgb = PALETTE_RGB[i] ?? { r: 255, g: 255, b: 255 };
      ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
      ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.strokeStyle = i === s.paletteIndex ? C.hot : C.cellEdge;
      ctx.lineWidth = i === s.paletteIndex ? 2 : 1;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
    }
    ctx.fillStyle = C.dim;
    ctx.font = `11px ${MONO}`;
    /* 当前色标签画在**调色盘右侧的空白处**,不是画布右边 ——
       画布右边就是面板外了(第一版把「当前色 #D8B98C」写到了草地上)。
       用 `palette` 的右边界 + 一个内边距定位,仍在面板内。 */
    ctx.fillText(
      `当前色 ${paletteLabel(s.paletteIndex)}`,
      L.palette.x + L.palette.w + 10,
      L.palette.y + 8,
    );

    /* 工具条 */
    ctx.font = `12px ${MONO}`;
    ctx.fillStyle = C.dim;
    ctx.fillText(`[Z] 撤销(${s.easel.undoCount})  [Y] 重做(${s.easel.redoCount})  [X] 清空  [C] 填充`, L.toolbar.x, L.toolbar.y + 8);
    ctx.restore();
  }

  private drawPitch(s: UiDrawState, a: number): void {
    const ctx = this.ctx;
    const L = this.pitch;
    fillPanel(ctx, L.panel, a);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.textBaseline = 'top';
    ctx.fillText('八音盒音高砖 2×16 = 32 档', L.title.x, L.title.y + 6);
    for (const info of PITCH_TABLE) {
      const r = brickRect(L, info.index);
      if (!r) continue;
      const on = (s.pitchMask & (1 << (info.index % 32))) !== 0;
      ctx.fillStyle = on ? 'rgba(255,220,140,.85)' : C.cellBg;
      ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.strokeStyle = C.cellEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      ctx.save();
      ctx.fillStyle = on ? '#221a08' : C.dim;
      ctx.font = `9px ${MONO}`;
      /* 竖排音名:旋转 −90° 后,**必须把基线设为 middle、对齐设为 center**,
         否则默认的 `top`/`start` 会让文字偏向一侧、糊在砖块边上。
         (drawPitch 开头设过 textBaseline='top',这里要显式覆盖。) */
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(info.noteName, 0, 0);
      ctx.restore();
      /* 恢复外层约定(left/top),避免影响后续 fillText */
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
    ctx.fillStyle = C.dim;
    ctx.font = `11px ${MONO}`;
    /* 用 layout 导出的 `footer` 矩形定位 —— 不用 `panel.h - 20` 自己算,
       那样会在砖块行数变化时再次压到砖上(初版实测过)。 */
    ctx.fillText(`已选 ${popcount(s.pitchMask)} 档 / 共 32 档`, L.footer.x, L.footer.y + 6);
    ctx.restore();
  }

  private drawBoss(s: UiDrawState, a: number): void {
    if (!s.boss) return;
    const ctx = this.ctx;
    const L: HpBarLayout = layoutHpBar(s.boss.baseHp, s.bossHp, this.w, s.boss.phases);
    ctx.save();
    ctx.globalAlpha = a;
    /* 背景框 */
    const pad = 6;
    const box: PanelRect = { x: L.x - pad, y: L.y - pad - 20, w: L.width + pad * 2, h: L.height + pad * 2 + 20 };
    fillPanel(ctx, box, a * 0.92);

    ctx.font = `12px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.textBaseline = 'top';
    const labels = bossHudShowsLabels(this.w);
    ctx.fillText(labels ? `${s.boss.name}  Lv.${s.boss.level}` : s.boss.name, box.x + pad, box.y + 4);

    /* 残影(先画掉的血,再画当前血) */
    ctx.fillStyle = C.hpGhost;
    ctx.fillRect(L.x, L.y, L.width * Math.max(0, Math.min(1, s.bossGhost)), L.height);
    ctx.fillStyle = C.hp;
    ctx.fillRect(L.x, L.y, L.width * L.ratio, L.height);
    ctx.strokeStyle = C.panelEdge;
    ctx.strokeRect(L.x + 0.5, L.y + 0.5, L.width - 1, L.height - 1);

    /* 阶段刻度:位置来自 layoutHpBar 的 ticks */
    ctx.fillStyle = 'rgba(255,255,255,.65)';
    for (const t of L.ticks) ctx.fillRect(L.x + t, L.y, 1, L.height);

    /* 血量文本 + 当前阶段名 —— 阶段名直接取 layoutHpBar 的权威字段,
       不在这里自己按 hpThreshold 再判一次(那会产生「血条刻度」与「阶段名」
       两套并行逻辑,一旦阈值语义变化就会不一致)。 */
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(hpBarText(Math.round(s.bossHp), s.boss.baseHp), L.x + 6, L.y + 3);
    ctx.fillStyle = C.dim;
    ctx.fillText(L.phaseName, L.x + L.width - 180, L.y + 3);
    ctx.restore();
  }

  private drawNotes(s: UiDrawState, a: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `12px ${MONO}`;
    ctx.textBaseline = 'top';
    if (s.telegraphNote) {
      const w = 420;
      const box: PanelRect = { x: (this.w - w) / 2, y: this.h - 74, w, h: 26 };
      ctx.fillStyle = dangerColor(0.85);
      roundRect(ctx, box, 6);
      ctx.fill();
      ctx.fillStyle = '#22110f';
      ctx.fillText(s.telegraphNote, box.x + 10, box.y + 6);
    }
    if (s.blueprintNote) {
      const w = 300;
      const box: PanelRect = { x: (this.w - w) / 2, y: this.h - 108, w, h: 24 };
      ctx.fillStyle = 'rgba(140,190,255,.85)';
      roundRect(ctx, box, 6);
      ctx.fill();
      ctx.fillStyle = '#0d1626';
      ctx.fillText(s.blueprintNote, box.x + 10, box.y + 5);
    }
    /* 组合键提示条 */
    ctx.fillStyle = C.dim;
    ctx.font = `11px ${MONO}`;
    ctx.fillText(s.keysHint, 16, this.h - 22);
    ctx.restore();
  }

  /* ────────────────────── 命中测试 ────────────────────── */

  /**
   * 指针命中测试。
   *
   * **只对当前打开的面板做命中**,避免「面板已关但仍吃点击」。
   * 背包用 `lastInvLayout`(绘制时存的同一份布局)而不是重算 —— 两处各算一次
   * 会在视口变化时产生「看起来在这、点上去在那」的错位。
   */
  hit(s: { panel: UiPanel; view: InventoryView; activeCategory: string | null; easel: PixelEasel }, px: number, py: number): UiHit {
    const inRect = (r: PanelRect): boolean => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

    if (s.panel === 'INVENTORY' || s.panel === 'RECIPE_TREE') {
      const L = this.lastInvLayout ?? this.inv;
      if (!inRect(L.panel)) return { kind: 'none' };
      /* 分类标签 */
      if (inRect(L.tabStrip)) {
        const tabs = [null, ...BUCKETS.map((b) => b.category)];
        const tabW = L.tabStrip.w / tabs.length;
        const i = Math.min(tabs.length - 1, Math.max(0, Math.floor((px - L.tabStrip.x) / tabW)));
        return { kind: 'tab', category: tabs[i] ?? null };
      }
      /* 分页 */
      if (inRect(L.pager)) {
        return { kind: 'pager', delta: px < L.pager.x + L.pager.w / 2 ? -1 : 1 };
      }
      /* 格子 */
      const col = Math.floor((px - L.gridX) / L.cell);
      const row = Math.floor((py - L.gridY) / L.cell);
      if (col >= 0 && col < L.cols && row >= 0 && row < L.rows) {
        const i = row * L.cols + col;
        const slot = s.view.page * 160 + i;
        return { kind: 'slot', indexInPage: i, slot };
      }
      return { kind: 'none' };
    }

    if (s.panel === 'PIXEL_EASEL') {
      const L = layoutEaselPanel(this.w, this.h);
      if (inRect(L.canvas)) {
        const x = Math.floor((px - L.canvas.x) / L.pixel);
        const y = Math.floor((py - L.canvas.y) / L.pixel);
        if (s.easel.inBounds(x, y)) return { kind: 'easel', x, y };
        return { kind: 'none' };
      }
      if (inRect(L.palette)) {
        const col = Math.floor((px - L.palette.x) / L.paletteCell);
        const row = Math.floor((py - L.palette.y) / L.paletteCell);
        const idx = row * 8 + col;
        if (idx >= 0 && idx < PALETTE_SIZE) return { kind: 'palette', index: idx };
      }
      if (inRect(L.toolbar)) {
        const third = L.toolbar.w / 3;
        const k = Math.floor((px - L.toolbar.x) / third);
        return { kind: 'toolbar', action: k === 0 ? 'undo' : k === 1 ? 'redo' : 'clear' };
      }
      return { kind: 'none' };
    }

    if (s.panel === 'PITCH_EDITOR') {
      for (const b of this.pitch.bricks) {
        if (inRect(b)) {
          const idx = this.pitch.bricks.indexOf(b);
          return { kind: 'brick', pitch: idx };
        }
      }
      return { kind: 'none' };
    }
    return { kind: 'none' };
  }

  /** 某格位的 tooltip 文本(直接来自 inventory,不在这里拼字符串) */
  tooltipFor(slot: number, view: InventoryView): string {
    const i = slot - view.page * 160;
    const sl = view.slots[i];
    if (!sl || !sl.visible) return '';
    return slotTooltip(sl.item.id);
  }

  dispose(): void {
    this.canvas.remove();
  }
}

/** 32 色调色盘的 RGB 表 —— 从 `pixel_easel` 的权威色表算一次,避免每帧转 32 次 */
const PALETTE_RGB: readonly { r: number; g: number; b: number }[] = Array.from(
  { length: PALETTE_SIZE },
  (_, i) => paletteColor(i),
);

/** 掩码里 1 的个数(音高砖已选档数) */
function popcount(mask: number): number {
  let n = 0;
  let m = mask >>> 0;
  while (m !== 0) {
    m &= m - 1;
    n += 1;
  }
  return n;
}

export type { RecipeNode, PitchInfo };
