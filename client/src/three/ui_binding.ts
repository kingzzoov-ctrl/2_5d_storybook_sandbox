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
  layoutBlueprintHud,
  layoutBossHudBand,
  layoutEaselPanel,
  layoutInventoryPanel,
  layoutPartyPanel,
  layoutPitchPanel,
  paletteRect,
  partyRowRect,
  rectVisible,
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
  type BossHudView,
  type HpBarLayout,
  dangerColor,
  hpBarText,
  layoutHpBar,
} from '../ui/boss_hud.ts';
import type { PartyHudView } from '../ui/party_hud.ts';
/* ★ WS-FND-151:模式选择面板的**数据**(纯逻辑)与急行条件清单(三态)。
   本层只按矩形画字 —— 不在绘制层算"当前是哪档 / 哪几条满足"。 */
import type { PartyPanelView } from '../ui/party_panel.ts';
import type { RushReadinessView } from '../ui/rush_readiness.ts';
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
  /**
   * ★ WS-FND-151:点了模式面板的某一行。
   *
   * `mode` 是**线上下标(1 起)**;谁来发报文由 `boot.ts` 决定(它持有选择器与报文口),
   * 本层只回答"点中了哪一档"。
   */
  | { kind: 'partyMode'; mode: number }
  | { kind: 'toolbar'; action: 'undo' | 'redo' | 'clear' }
  | { kind: 'none' };

/** 覆盖层绘制所需的一切状态 —— 由 `boot.ts` 每帧组装 */
export interface UiDrawState {
  panel: UiPanel;
  /** 打开动画进度 0..1(state_machine.openingProgress) */
  openProgress: number;
  /**
   * 处于拖拽中(源格画虚线 + 目标格画热框)。
   *
   * ★ 第六轮审计 P3:本字段修前**只被赋过值、从没被读过**(`ui_binding` 里
   *   `s.dragging` 命中 0)⇒ 拖拽在画面上与"只是悬停"完全一样。现在它由
   *   `drawInventory` 读(见那边的源格/目标格分支)。
   */
  dragging: boolean;
  /** 拖拽的源格(页内下标;−1 = 没有拖拽) */
  dragFrom: number;
  /** 悬停格(页内下标,−1 = 无) */
  hoverSlot: number;
  view: InventoryView;
  /** 当前的搜索串(空串 = 没在搜)—— 画进背包标题,让"为什么只剩 3 件"可解释 */
  invQuery: string;
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
  /**
   * 权威 Boss HUD 视图(`ui/boss_hud.bossHudFrom` 的产物;`null` = 没有 boss)。
   *
   * ★ 第六轮审计 P1:修前这里是 `BossDef | null` + 一个**本地伪造**的 `bossHp`
   *   (boot 里按 `dt * baseHp * 0.035` 递减)。现在血量/上限/阶段/预警形状
   *   全在这份视图里,本层只做布局 —— 没有再算一遍的余地。
   */
  boss: BossHudView | null;
  bossGhost: number;
  /**
   * 派对 / 比分(`ui/party_hud.partyHudOf` 的产物)。
   *
   * ★ 第六轮审计 P1:`meta.partyMode/partyTimer/scoreA/scoreB` 修前零读者
   *   ⇒ 派对进行中屏幕上没有任何提示。`text` 为空串表示没在派对,不画。
   */
  party: PartyHudView;
  /**
   * ★ WS-FND-151:模式选择面板(`ui/party_panel.partyPanelOf` 的产物)。
   *
   * `panel === 'PARTY'` 时才画;内容全部来自它 —— 本层不自己数模式有几档
   * (档数来自冻结层 `PARTY_MODES`,面板与词表因此不可能对不上)。
   */
  partyPanel: PartyPanelView;
  /** 最近一次选中模式的结果(空串 = 还没选过;来自入口的 `status`,不是本地编的话) */
  partyModeNote: string;
  /**
   * ★ WS-FND-151:急行开工条件清单(三态)。
   *
   * 数据来自权威状态;拿不到就报 `unknown` —— **不假装 0**(假装会让玩家
   * 反复去拆/重建一个其实早就满足的条件)。
   */
  rush: RushReadinessView;
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
  /** 拖拽源格的描边(比 `hot` 淡:它不是"目标",只是"正在被搬") */
  hotGhostLine: 'rgba(255,220,140,.45)',
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
    if (s.panel === 'PARTY') this.drawParty(s, a);
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
    /* ★ 第六轮审计 P3:`invLayout` 这个 getter 修前**零读者**(绘制层直接用私有
       `this.inv`,命中测试用 `lastInvLayout` —— 三条路各读各的)。现在绘制也用
       那一个正规出口:布局只有一份,不再有"画的和点的不是同一个矩形"的余地。 */
    const L = this.invLayout;
    fillPanel(ctx, L.panel, a);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.textBaseline = 'middle';
    const total = INVENTORY_SLOTS;
    /* ★ 搜索串与图集状态都画进标题:
       · 没有它,"为什么只剩 3 件"是**不可解释**的(搜索把其余的都滤掉了);
       · `hasAtlas === false` 时格子是色块占位,标题必须说出来(否则玩家以为图挂了)。 */
    const queryNote = s.invQuery === '' ? '' : `  ·  搜索"${s.invQuery}"`;
    const atlasNote = this.hasAtlas ? '' : '  ·  无图集(色块占位)';
    ctx.fillText(
      `背包  ${s.view.visibleCount}/${total} 件  ·  已用 ${(usedSlotRatio(s.view.visibleCount) * 100).toFixed(0)}%${queryNote}${atlasNote}`,
      L.title.x, L.title.y + L.title.h / 2,
    );

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
      const isSource = s.dragging && i === s.dragFrom;
      const isHover = i === s.hoverSlot;
      ctx.strokeStyle = isHover ? C.hot : (isSource ? C.hotGhostLine : C.cellEdge);
      ctx.lineWidth = isHover ? 2 : 1;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      /* ★ 拖拽中的源格画虚线框:否则"拿起来了"在画面上与"只是悬停"一样
         (`s.dragging` 修前就是那个"算了不读"的字段)。 */
      if (isSource) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = C.hot;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
        ctx.restore();
      }

      if (!filled) continue;
      const sl = s.view.slots[i]!;
      this.drawItemIcon(sl.item.id, r);
      /* 拖拽中的源格:图标变半透明 —— "它正在被搬走"必须看得出来 */
      if (isSource) {
        ctx.save();
        ctx.globalAlpha = a * 0.35;
        ctx.fillStyle = C.cellBg;
        ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        ctx.restore();
      }
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

  /**
   * ★ WS-FND-151:派对**模式选择面板**。
   *
   * 内容全部来自 `partyPanelOf()`(纯逻辑、可单测):档位、名字、规则、当前档、
   * 光标全在那边算好;本层只做 `fillRect` / `fillText`
   * —— 在绘制层再数一次"第几档"就是第二份实现,而它会与词表漂。
   */
  private drawParty(s: UiDrawState, a: number): void {
    const ctx = this.ctx;
    const p = s.partyPanel;
    const L = layoutPartyPanel(this.w, this.h, p.rows.length);
    fillPanel(ctx, L.panel, a);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textBaseline = 'top';
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = C.title;
    ctx.fillText('派对模式(选定后立刻发 SET_PARTY_MODE,影响全房)', L.title.x, L.title.y + 6);
    /* 当前档:来自权威 `meta.partyMode`;没选时用警示色说出来(否则玩家以为已选) */
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = p.currentName === null ? C.bad : C.ok;
    ctx.fillText(p.currentText, L.title.x + L.title.w - ctx.measureText(p.currentText).width, L.title.y + 9);

    for (let i = 0; i < L.visibleRows; i += 1) {
      const r = partyRowRect(L, i);
      const row = p.rows[i];
      if (r === null || row === undefined) continue;
      ctx.fillStyle = row.cursor ? 'rgba(255,220,140,.16)' : C.cellBg;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = row.cursor ? C.hot : (row.current ? C.ok : C.cellEdge);
      ctx.lineWidth = row.cursor ? 2 : 1;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.font = `12px ${MONO}`;
      ctx.fillStyle = row.current ? C.ok : C.title;
      ctx.fillText(
        `${row.mode}. ${row.name}  ${row.players}  ${row.current ? '● 当前' : '○ 可选'}`,
        r.x + 8, r.y + 5,
      );
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = C.dim;
      ctx.fillText(row.rule, r.x + 8, r.y + 25);
    }

    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = s.partyModeNote === '' ? C.dim : C.ok;
    const scroll = L.scrollable ? `(还有 ${p.rows.length - L.visibleRows} 档没画下:窗口太矮)` : '';
    ctx.fillText(
      `${p.hint}${scroll === '' ? '' : `  ·  ${scroll}`}${s.partyModeNote === '' ? '' : `  ·  ${s.partyModeNote}`}`,
      L.footer.x, L.footer.y + 5,
    );
    ctx.restore();
  }

  private drawBoss(s: UiDrawState, a: number): void {
    if (!s.boss) return;
    const ctx = this.ctx;
    /* ★ 第六轮审计 P1:血量取自**权威视图**(`s.boss.hp`,来自 `RoomState.bosses`),
       不再是 boot 里那个按 `dt * baseHp * 0.035` 本地递减的假值。
       `layoutHpBar` 只负责条内几何(width/ticks/ratio);阶段名走线上 `phase`,
       不在这里按 `hpThreshold` 重算(否则"刻度"与"阶段名"会有两套并行逻辑)。 */
    const L: HpBarLayout = layoutHpBar(s.boss.baseHp, s.boss.hp, this.w, s.boss.phases);
    /* ★ 第六轮审计 P3:`panel_layout.layoutBossHudBand` 修前零读者(本文件自己
       手算 `(viewportW - w)/2`)。它算的正是同一件事 —— 现在只有一份。 */
    const band = layoutBossHudBand(this.w, this.h);
    ctx.save();
    ctx.globalAlpha = a;
    /* 背景框 */
    const pad = 6;
    const box: PanelRect = { x: band.x - pad, y: band.y - pad - 20, w: band.w + pad * 2, h: band.h + pad * 2 + 20 };
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

    /* 血量文本 + 当前阶段名 —— 两者都是**线上**字段(s.boss.hp / s.boss.phaseName) */
    ctx.font = `11px ${MONO}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(hpBarText(Math.round(s.boss.hp), s.boss.baseHp), L.x + 6, L.y + 3);
    ctx.fillStyle = C.dim;
    if (s.boss.phaseName !== '') ctx.fillText(s.boss.phaseName, L.x + L.width - 180, L.y + 3);
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
      /* `rectVisible` 修前零读者:完全落在视口外的提示条没必要画(小屏/超宽屏时
         它是真的会跑出去) —— 这里用它做一次显式跳过,而不是先 fill 再被裁掉。 */
      if (rectVisible(box, this.w, this.h)) {
        ctx.fillStyle = dangerColor(0.85);
        roundRect(ctx, box, 6);
        ctx.fill();

        ctx.fillStyle = '#22110f';
        ctx.fillText(s.telegraphNote, box.x + 10, box.y + 6);
      }
    }
    if (s.blueprintNote) {
      /* ★ 第六轮审计 P3:`panel_layout.layoutBlueprintHud` 修前零读者 —— 绘制层
         自己写死 `{x:(w-300)/2, y:h-108, w:300, h:24}`。现在位置来自那个纯函数
         (它已被测试覆盖,且会随视口给出一致的 `visible` 判定)。 */
      const bp = layoutBlueprintHud(this.w, this.h, true);
      if (bp.visible && rectVisible(bp.hint, this.w, this.h)) {
        ctx.fillStyle = 'rgba(140,190,255,.85)';
        roundRect(ctx, bp.hint, 6);
        ctx.fill();
        ctx.fillStyle = '#0d1626';
        ctx.fillText(s.blueprintNote, bp.hint.x + 10, bp.hint.y + 5);
      }
    }
    /* ── ★ 第六轮审计 P1:派对 / 比分 ──
       四个 `meta` 字段此前零读者;现在只要在派对里就有这一行(`text` 为空则不画)。 */
    if (s.party.active) {
      const w = 420;
      const box: PanelRect = { x: (this.w - w) / 2, y: this.h - 140, w, h: 26 };
      if (rectVisible(box, this.w, this.h)) {
        ctx.fillStyle = 'rgba(255,220,140,.9)';
        roundRect(ctx, box, 6);
        ctx.fill();
        ctx.fillStyle = '#221b0d';
        ctx.fillText(s.party.text, box.x + 10, box.y + 6);
      }
    }
    /* ── ★ 第六轮审计 P3:背包 tooltip ──
       `UiOverlay.tooltipFor()` 修前**零读者** ⇒ 悬停到格子上永远看不到物品说明。
       现在悬停格有 tooltip(文本仍由 `inventory.slotTooltip` 给出,本层只画)。 */
    if (s.hoverSlot >= 0 && (s.panel === 'INVENTORY' || s.panel === 'RECIPE_TREE')) {
      const text = this.tooltipFor(s.view.page * 160 + s.hoverSlot, s.view);
      const L = this.invLayout;
      if (text !== '') {
        const r = slotRect(L, s.hoverSlot);
        ctx.font = `11px ${MONO}`;
        const w = Math.min(320, Math.max(120, ctx.measureText(text).width + 16));
        const box: PanelRect = { x: Math.min(this.w - w - 8, r.x + r.w + 8), y: Math.max(8, r.y - 6), w, h: 22 };
        if (rectVisible(box, this.w, this.h)) {
          ctx.fillStyle = 'rgba(20,26,42,.96)';
          roundRect(ctx, box, 5);
          ctx.fill();
          ctx.strokeStyle = C.cellEdge;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = C.title;
          ctx.fillText(text, box.x + 8, box.y + 5);
        }
      }
    }
    /* ── ★ WS-FND-151:急行开工条件清单(三项,三态)──
       世界侧自动开工(食堂 + 三工位 + 站格),客户端只**如实报**这三条:
       `✓` 已知满足 / `✗` 已知不满足 / `?` **拿不到权威值**。
       未知单独计数,不并进"没满足" —— 假装 0 会让玩家反复拆了重建。 */
    if (s.rush.total > 0) {
      const w = 380;
      const h = 22 + s.rush.total * 15 + (s.rush.note === '' ? 0 : 14);
      const box: PanelRect = { x: 16, y: this.h - h - 44, w, h };
      if (rectVisible(box, this.w, this.h)) {
        ctx.fillStyle = 'rgba(20,26,42,.78)';
        roundRect(ctx, box, 6);
        ctx.fill();
        ctx.strokeStyle = C.cellEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `11px ${MONO}`;
        ctx.fillStyle = C.title;
        ctx.fillText(s.rush.text, box.x + 8, box.y + 5);
        let y = box.y + 22;
        for (const r of s.rush.rows) {
          ctx.font = `10px ${MONO}`;
          ctx.fillStyle = r.state === 'met' ? C.ok : (r.state === 'unmet' ? C.bad : C.dim);
          ctx.fillText(r.text, box.x + 8, y);
          y += 15;
        }
        if (s.rush.note !== '') {
          ctx.fillStyle = C.dim;
          ctx.fillText(s.rush.note, box.x + 8, y);
        }
      }
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
  hit(
    s: {
      panel: UiPanel;
      view: InventoryView;
      activeCategory: string | null;
      easel: PixelEasel;
      /* ★ WS-FND-151:模式面板的命中要用它的行数(行矩形来自 `layoutPartyPanel`) */
      partyPanel: PartyPanelView;
    },
    px: number,
    py: number,
  ): UiHit {
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
    if (s.panel === 'PARTY') {
      const L = layoutPartyPanel(this.w, this.h, s.partyPanel.rows.length);
      if (!inRect(L.panel)) return { kind: 'none' };
      for (let i = 0; i < L.rows.length; i += 1) {
        const r = L.rows[i]!;
        if (inRect(r)) {
          const row = s.partyPanel.rows[i];
          return row === undefined ? { kind: 'none' } : { kind: 'partyMode', mode: row.mode };
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
