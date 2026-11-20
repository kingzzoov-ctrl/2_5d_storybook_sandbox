/**
 * ★ WS-FND-166:**触屏按钮条** —— 面板/攻击的**屏幕入口**(手机没有键盘)。
 *
 * ## 为什么必须有它(实测:手机上整个 UI 不可达)
 *
 * 面板键位表 `ui/panel_keys.ts#PANEL_KEYS` 全是字母键(`i/r/h/p/m`),
 * 而手机**没有键盘** ⇒ 背包 / 配方 / 画架 / 音高 / 模式面板在真机上
 * **一个都打不开**;攻击又只挂在 `mousedown`(见 `net/touch_intent.ts`)。
 * "功能写了但玩家到不了"是本仓记过的形态;这里补的就是那一步。
 *
 * ## 单一事实源
 *
 * 面板按钮**从 `PANEL_KEYS` 派生**(键位表改了按钮自动跟着变),
 * 标签从 `PANEL_LABEL` 取 —— 不在这里手抄第二份面板清单。
 * `tests/WS-FND-166` 会逐条断言:「每个 `PANEL_KEYS` 里的面板都有触屏按钮」。
 *
 * ## 分层
 *
 * ```
 * ui/panel_keys.ts    面板清单 + 人读名字(唯一一处)
 * ui/touch_bar.ts     布局(纯)+ 命中(纯)+ DOM 层(构造不碰 document)
 * main.ts             接线:点「攻」→ attackNearest;点面板 → boot 的开合
 * ```
 */

import type { PanelRect } from './panel_layout.ts';
import { fitPanelRect } from './panel_layout.ts';
import { inRect } from './panel_hit.ts';
import { PANEL_KEYS, PANEL_LABEL } from './panel_keys.ts';
import { UiPanel } from './state_machine.ts';

/** 按钮 id:「攻」/「关」是两个动作,其余是**打开某个面板** */
export type TouchButtonId = 'attack' | 'close' | `panel:${UiPanel}`;

export interface TouchButton {
  id: TouchButtonId;
  /** 按钮上的短标签(1 个汉字 —— 360px 宽的屏上放得下 7 个按钮) */
  label: string;
  /** 无障碍名(读屏用;也是判据里"这个按钮干什么"的可读证据) */
  aria: string;
}

/** 触屏最小可点尺寸(iOS HIG 的 44pt 档位) */
export const TOUCH_BUTTON_SIZE_PX = 44;
/** 按钮间距 */
export const TOUCH_BUTTON_GAP_PX = 4;
/** 按钮条离视口边缘的留白 */
export const TOUCH_BAR_MARGIN_PX = 8;
/** 按钮宽度的**舒适下限**(低于它 ⇒ `comfortable === false`,玩家会按到隔壁) */
export const TOUCH_BUTTON_MIN_W_PX = 32;
/**
 * 按钮宽度的**硬下限**(★ WS-FND-166)。
 *
 * 7 个按钮 × 32 + 间距 = 248px,在 200px 的极窄分屏里放不下 ——
 * 那时若坚持 32,后面的按钮会**从右边界出去**(而命中用同一个矩形 ⇒ 点不到)。
 * 硬下限之下(`< 7×16`)才允许裁剪,并由 `clipped` 如实报出来。
 */
export const TOUCH_BUTTON_HARD_MIN_W_PX = 16;

/**
 * 面板按钮的短标签表(`PANEL_KEYS` 的**每个**面板都要有一个)。
 *
 * 用 `PANEL_LABEL` 的第一个字(`背包`→`背`、`音高`→`音`),于是名字只有一处来源;
 * 表里缺一个 ⇒ 判据会红(`WS-FND-166`,负对照:删掉一项后判据必须转假)。
 */
export function shortLabelOf(panel: UiPanel): string {
  const full = PANEL_LABEL[panel] ?? String(panel);
  return full.slice(0, 1);
}

/** 触屏按钮清单:攻击 + **每个面板**(从 `PANEL_KEYS` 派生,去重)+ 关闭 */
export function touchButtons(): TouchButton[] {
  const seen = new Set<UiPanel>();
  const panels: UiPanel[] = [];
  for (const p of Object.values(PANEL_KEYS)) {
    if (p === UiPanel.NONE || seen.has(p)) continue;
    seen.add(p);
    panels.push(p);
  }
  return [
    { id: 'attack', label: '攻', aria: '攻击' },
    ...panels.map((p): TouchButton => ({
      id: `panel:${p}`,
      label: shortLabelOf(p),
      aria: `打开${PANEL_LABEL[p] ?? String(p)}面板`,
    })),
    { id: 'close', label: '关', aria: '关闭面板' },
  ];
}

export interface TouchBarLayout {
  /** 整条(纯容器;按钮都在它里面) */
  bar: PanelRect;
  buttons: { id: TouchButtonId; rect: PanelRect }[];
  /** 实际按钮尺寸(窄屏会缩到 `TOUCH_BUTTON_HARD_MIN_W_PX`) */
  buttonW: number;
  buttonH: number;
  /** 按钮宽 ≥ `TOUCH_BUTTON_MIN_W_PX`(低于它拇指会按到隔壁 —— 如实报,不假装达标) */
  comfortable: boolean;
  /** 连硬下限都放不下 ⇒ 条子被裁(今天只有 < 7×16+留白 的视口会走到) */
  clipped: boolean;
}

/**
 * 按钮条布局。
 *
 * ## 位置为什么是**右上角**
 *
 * `#status` 在左上(条目多、窄屏上很高),`#hint` 在底部(窄屏上会折行成好几行),
 * 右下角是背包面板。右上角是窄屏上唯一一块"没有常驻东西"的地方。
 *
 * ## 为什么宽度是**算出来的**
 *
 * 7 个按钮 × 44 + 间距 = 340 > 320(小屏可用宽)⇒ 必须能缩。
 * `fitPanelRect` 是**全仓唯一的**夹取入口(与各面板同一条口径),
 * 于是"按钮条永远在屏内"与"面板永远在屏内"是同一条判据。
 */
export function layoutTouchBar(
  viewportW: number,
  viewportH: number,
  buttons: readonly TouchButton[] = touchButtons(),
): TouchBarLayout {
  const n = Math.max(1, buttons.length);
  const availW = Math.max(1, viewportW - TOUCH_BAR_MARGIN_PX * 2);
  /* ★ 先算"放得下多宽",再夹进 [硬下限, 44]:极窄分屏里宁可按钮小一点,
     也不许后面的按钮跑到视口外(命中用同一个矩形 ⇒ 那就永远点不到)。 */
  const fitW = Math.floor((availW - TOUCH_BUTTON_GAP_PX * (n - 1)) / n);
  const buttonW = Math.max(
    TOUCH_BUTTON_HARD_MIN_W_PX,
    Math.min(TOUCH_BUTTON_SIZE_PX, fitW),
  );
  const buttonH = TOUCH_BUTTON_SIZE_PX;
  const barW = buttonW * n + TOUCH_BUTTON_GAP_PX * (n - 1);
  const baseH = buttonH;
  const fit = fitPanelRect({
    x: viewportW - barW - TOUCH_BAR_MARGIN_PX,
    y: TOUCH_BAR_MARGIN_PX,
    w: barW,
    h: baseH,
  }, viewportW, viewportH);
  const bar = fit.rect;
  const rects: { id: TouchButtonId; rect: PanelRect }[] = [];
  for (let i = 0; i < buttons.length; i += 1) {
    rects.push({
      id: buttons[i]!.id,
      rect: {
        x: bar.x + i * (buttonW + TOUCH_BUTTON_GAP_PX),
        y: bar.y,
        w: buttonW,
        h: Math.min(buttonH, bar.h),
      },
    });
  }
  return {
    bar,
    buttons: rects,
    buttonW,
    buttonH,
    comfortable: buttonW >= TOUCH_BUTTON_MIN_W_PX,
    clipped: fit.scrollable,
  };
}

/** 命中了哪个按钮(`null` = 没命中) */
export function hitTouchBar(L: TouchBarLayout, px: number, py: number): TouchButtonId | null {
  for (const b of L.buttons) {
    if (inRect(b.rect, px, py)) return b.id;
  }
  return null;
}

/* ─────────────────────────── DOM 层 ───────────────────────────
   ⚠ 构造**不碰 document**(node 里 import 必须不抛);
   样式内联(与本文件同目录的 `joystick_ui.ts` 同一条纪律:客户端零构建)。 */

const S_LAYER = 'position:absolute;inset:0;z-index:26;pointer-events:none;'
  + 'contain:layout style;-webkit-user-select:none;user-select:none;';

const S_BUTTON_BASE = 'position:absolute;box-sizing:border-box;display:flex;'
  + 'align-items:center;justify-content:center;border-radius:9px;'
  + 'font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;'
  + 'color:#e8eefc;background:rgba(18,24,38,.82);border:1px solid rgba(120,150,210,.34);'
  + 'pointer-events:auto;cursor:pointer;touch-action:none;'
  + '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;'
  + '-webkit-tap-highlight-color:transparent;';

const S_BUTTON_ACTIVE = 'background:rgba(168,240,200,.24);border-color:rgba(168,240,200,.75);';

/**
 * 按钮条的 DOM 层。
 *
 * **构造不碰 `document`** —— 所有 DOM 访问都在 `mount(el)` 里
 * (理由与 `ui/joystick_ui.ts` 相同:node 里 import 本模块必须不抛)。
 */
export class TouchBar {
  private layer: HTMLDivElement | null = null;
  private els: { id: TouchButtonId; el: HTMLDivElement }[] = [];
  private view: Window | null = null;
  private readonly onPick: (id: TouchButtonId) => void;
  private activePanel: UiPanel = UiPanel.NONE;
  private readonly onResize = (): void => { this.relayout(); };
  private readonly buttons: readonly TouchButton[];

  constructor(onPick: (id: TouchButtonId) => void, buttons: readonly TouchButton[] = touchButtons()) {
    this.onPick = onPick;
    this.buttons = buttons;
  }

  get mounted(): boolean {
    return this.layer !== null;
  }

  /** 已经画出几个按钮(自检口径:0 = 手机上一个面板入口都没有) */
  get buttonCount(): number {
    return this.els.length;
  }

  /** 当前视口下的布局(未挂载时 `null`) */
  layoutNow(): TouchBarLayout | null {
    if (this.layer === null) return null;
    return layoutTouchBar(this.view?.innerWidth ?? 0, this.view?.innerHeight ?? 0, this.buttons);
  }

  mount(el: HTMLElement): void {
    if (this.layer !== null) return;
    if (el === null || el === undefined || typeof el.appendChild !== 'function') return;
    const doc = el.ownerDocument;
    if (doc === null || typeof doc.createElement !== 'function') return;
    this.view = doc.defaultView;

    const layer = doc.createElement('div');
    /* 纯容器:整层不吃指针事件,只有**按钮**吃(不给世界拖动添麻烦) */
    layer.setAttribute('aria-hidden', 'false');
    layer.style.cssText = S_LAYER;
    layer.id = 'touch_bar';

    for (const b of this.buttons) {
      const btn = doc.createElement('div');
      btn.style.cssText = S_BUTTON_BASE;
      btn.textContent = b.label;
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-label', b.aria);
      btn.dataset.touchId = b.id;
      /* `pointerdown` 而不是 `click`:手机上有 300ms 的点击延迟,
         而且 `click` 会被长按/拖动吃掉 —— 攻击按钮不能"看运气"。 */
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.onPick(b.id);
      });
      layer.appendChild(btn);
      this.els.push({ id: b.id, el: btn });
    }
    el.appendChild(layer);
    this.layer = layer;
    this.view?.addEventListener('resize', this.onResize);
    this.relayout();
  }

  /** 命中查询(与 `hitTouchBar` 同一份布局) */
  hitAt(px: number, py: number): TouchButtonId | null {
    const L = this.layoutNow();
    return L === null ? null : hitTouchBar(L, px, py);
  }

  /** 高亮"当前打开的面板"(玩家一眼能看出按哪个会关掉) */
  setActivePanel(panel: UiPanel): void {
    this.activePanel = panel;
    for (const { id, el } of this.els) {
      const on = id === `panel:${panel}`;
      el.style.cssText = on ? S_BUTTON_BASE + S_BUTTON_ACTIVE : S_BUTTON_BASE;
    }
  }

  get active(): UiPanel {
    return this.activePanel;
  }

  /** 视口变化 ⇒ 重新摆按钮(与面板同一条 `fitPanelRect` 口径) */
  relayout(): void {
    if (this.layer === null) return;
    const L = layoutTouchBar(this.view?.innerWidth ?? 0, this.view?.innerHeight ?? 0, this.buttons);
    for (let i = 0; i < this.els.length; i += 1) {
      const r = L.buttons[i]?.rect;
      const el = this.els[i]!.el;
      if (r === undefined) continue;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
    }
  }

  dispose(): void {
    this.view?.removeEventListener('resize', this.onResize);
    const layer = this.layer;
    if (layer !== null) {
      if (typeof layer.remove === 'function') layer.remove();
      else layer.parentElement?.removeChild(layer);
    }
    this.layer = null;
    this.els = [];
    this.view = null;
  }
}

/** 工厂(与 `boot()` / `createSession()` / `createJoystickUI()` 同形) */
export function createTouchBar(
  onPick: (id: TouchButtonId) => void,
  buttons: readonly TouchButton[] = touchButtons(),
): TouchBar {
  return new TouchBar(onPick, buttons);
}

/** 面板按钮 id 的构造/解析(唯一一处:`panel:${UiPanel}`) */
export function panelButtonId(panel: UiPanel): TouchButtonId {
  return `panel:${panel}`;
}

/** 从按钮 id 取回面板(不是面板按钮 ⇒ `null`) */
export function panelOfButtonId(id: TouchButtonId): UiPanel | null {
  if (!id.startsWith('panel:')) return null;
  const p = id.slice('panel:'.length) as UiPanel;
  return Object.values(UiPanel).includes(p) ? p : null;
}
