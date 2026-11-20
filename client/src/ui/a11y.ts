/**
 * a11y 最低限度层 —— **字号 / 对比度常量** + 面板的 `role` / `aria-label` / Tab 可达镜像。
 *
 * ## 为什么必须有这个文件(审计 B3 第 6 条,实测量化)
 *
 * ```text
 * 1 面板全部画在 canvas 上(`three/ui_binding.ts`)⇒ 读屏器**一个面板都看不到**,
 *   键盘也 Tab 不到任何东西(整页只有 body)。
 * 2 分类标签 10px(`ui_binding.ts` 里的 `ctx.font`),低于移动端可读基线;
 *   DOM 那层状态条/提示条的描边 `rgba(120,150,210,.22)` 压在 `#121a2b` 上
 *   实测对比度 ≈1.4:1 —— 低于 WCAG 1.4.11(非文本 3:1)。
 * ```
 *
 * ⇒ 本层只做**最低限度**的两件事:
 * ```text
 * 常量:字号基线 + 达标的颜色(附 `contrastRatio` 纯函数,判据可被机器复核)
 * 镜像:把 HUD 那几行文本同时写进一个**真 DOM** 面板
 *      (`role` / `aria-label` / `aria-live` / `tabindex=0` ⇒ Tab 能到、读屏器能读)
 * ```
 *
 * ⚠️ 画布那一层(10px 标签、rgba 描边)住在 `three/ui_binding.ts`,**不在本任务的
 *    写域内** ⇒ 本文件把达标口径**立成常量与判据**,并由 `main.ts` 用在 DOM 层
 *    (状态条 / 提示条 / 诊断行 / 这个镜像面板)。画布侧的残留如实标注,不假装修过。
 *
 * ⚠️ 与 `ui/joystick_ui.ts` 同一条纪律:**构造时不碰 `document`** ——
 *    所有 DOM 访问都在 `mount(el)` 里,否则 node 里 import 本模块就会抛,
 *    这些纯常量与对比度函数就再也没有人钉。
 */

/** 文本可读基线(px):正文/标签都不小于它(移动端基线 13px)。 */
export const MIN_TEXT_PX = 13;
/** 分类标签那一行用的字号(画布侧的 10px 低于本基线;DOM 层一律用它)。 */
export const TAB_LABEL_FONT_PX = MIN_TEXT_PX;
/** 非文本对比度下限(WCAG 1.4.11:边框 / 分隔线 / 图标 ≥ 3:1)。 */
export const MIN_NON_TEXT_CONTRAST = 3;
/** 正文文本对比度下限(WCAG 1.4.3 AA:正文 ≥ 4.5:1)。 */
export const MIN_TEXT_CONTRAST = 4.5;

/* ── 达标色板(每一位都过上面两条下限,由 `a11yStyleProblems()` 机器复核) ── */
/** 面板底色(与 `#app` / `body` 同一个底色 ⇒ 对比度按它算)。 */
export const A11Y_BG = '#121a2b';
/** 正文色。 */
export const A11Y_TEXT = '#e8eefc';
/** 次级文本(仍过 4.5:1)。 */
export const A11Y_DIM = '#b9cbe6';
/** 描边 / 分隔线(过 3:1)。 */
export const A11Y_EDGE = '#7f9dc9';
/** 正常态强调色。 */
export const A11Y_OK = '#8fe0a8';
/** 异常态强调色。 */
export const A11Y_BAD = '#ffb0b0';

/** `#rrggbb` → 0..255 三元组;非法输入返回 `null`(调用方据此判红,而不是猜一个值)。 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** WCAG 相对亮度(0..1);非法颜色返回 `null`。 */
export function relLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) return null;
  const ch = [rgb.r, rgb.g, rgb.b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/**
 * 对比度比值(WCAG 公式)。**任一颜色非法 ⇒ 返回 0**(不是 1):
 * 判据是"必须 ≥ 下限"⇒ 0 必然判红,于是"给了一个假色值"不会被静默当成合格。
 */
export function contrastRatio(fg: string, bg: string): number {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  if (a === null || b === null) return 0;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` 压在 `bg` 上是否达到 `min`(省略 `min` ⇒ 正文口径 4.5:1)。 */
export function meetsContrast(fg: string, bg: string, min: number = MIN_TEXT_CONTRAST): boolean {
  return contrastRatio(fg, bg) >= min;
}

/**
 * 口径自检 —— **纯函数**:返回违规清单(空数组 = 全达标)。
 *
 * 参数可注入 ⇒ 判据有牙齿:`{ textPx: 10 }` / `{ edge: <低对比度色> }` 必须报红,
 * 否则"字号达标 / 对比度达标"就只是这一行注释里的声明。
 */
export function a11yStyleProblems(opts: {
  textPx?: number;
  fg?: string;
  dim?: string;
  edge?: string;
  bg?: string;
} = {}): string[] {
  const px = opts.textPx ?? MIN_TEXT_PX;
  const fg = opts.fg ?? A11Y_TEXT;
  const dim = opts.dim ?? A11Y_DIM;
  const edge = opts.edge ?? A11Y_EDGE;
  const bg = opts.bg ?? A11Y_BG;
  const out: string[] = [];
  if (!(px >= MIN_TEXT_PX)) out.push(`字号 ${px}px 低于可读基线 ${MIN_TEXT_PX}px`);
  if (!(contrastRatio(fg, bg) >= MIN_TEXT_CONTRAST)) {
    out.push(`正文色 ${fg} 压 ${bg} 只有 ${contrastRatio(fg, bg).toFixed(2)}:1(需 ≥ ${MIN_TEXT_CONTRAST})`);
  }
  if (!(contrastRatio(dim, bg) >= MIN_TEXT_CONTRAST)) {
    out.push(`次级文本 ${dim} 压 ${bg} 只有 ${contrastRatio(dim, bg).toFixed(2)}:1(需 ≥ ${MIN_TEXT_CONTRAST})`);
  }
  if (!(contrastRatio(edge, bg) >= MIN_NON_TEXT_CONTRAST)) {
    out.push(`描边 ${edge} 压 ${bg} 只有 ${contrastRatio(edge, bg).toFixed(2)}:1(需 ≥ ${MIN_NON_TEXT_CONTRAST})`);
  }
  return out;
}

/** 镜像面板里的一格:一个 DOM 节点 = 一块画布面板的文本版。 */
export interface A11yPanelSpec {
  /** 稳定 id(供 `update()` 与自检按名读)。 */
  id: string;
  /** `aria-label`(读屏器念的就是它 —— 必须说清这块是什么)。 */
  label: string;
  /** ARIA role:状态类用 `status`,日志类用 `log`,其余 `region`。 */
  role: 'status' | 'log' | 'region';
}

/**
 * 要被镜像的画布面板(与 `ui/state_machine.ts` 的 `UiPanel` + HUD 那几行对应)。
 *
 * ⚠️ 名字/职责**写在这里一份**,`main.ts` 按 id 填文本 —— 镜像不会因为
 *    "某块面板忘了加"而少一块:漏了它,`update()` 的那一行就没有目标。
 */
export const A11Y_PANELS: readonly A11yPanelSpec[] = [
  { id: 'session', label: '连接与握手(连接中 / 超时 / 重试次数与下次重试时间)', role: 'status' },
  { id: 'diagnostics', label: '诊断计数(坏包 / 空帧 / 旧帧 / 载荷丢帧 / 服务端拒收)', role: 'log' },
  { id: 'load', label: '加载状态(三维场景 / 图集)', role: 'status' },
  { id: 'panel', label: '当前面板(背包 / 配方 / 画架 / 音高 / 派对 / Boss)', role: 'status' },
  { id: 'hint', label: '键位提示', role: 'region' },
];

/** 镜像面板的文案集合(`Partial` ⇒ 允许只更新其中几块)。 */
export type A11yText = Partial<Record<string, string>>;

/**
 * 镜像面板的样式串(内联,零构建 —— 与 `joystick_ui.ts` 同一条取舍)。
 *
 * 三件必须写死在这里的事:
 * ```text
 * font-size          ≥ MIN_TEXT_PX(字号基线)
 * color/border-color 用达标色板(对比度下限)
 * outline            焦点可见框(Tab 到它时必须看得见 —— 否则"可达"只是名义上的)
 * ```
 *
 * ⚠️ 取舍(如实写):本层**常显**在右下角(`max-height:22vh`,可滚动)而不是
 *    `sr-only` 隐到焦点才展开 —— 纯内联样式做不到 `:focus` 揭示,而"隐着但可 Tab"
 *    恰恰违反"焦点必须可见"。代价是占了一小块屏幕,收益是读屏器与键盘用户
 *    真的能读到面板;尺寸已压到最小(宽 ≤340px / 高 ≤22vh)。
 */
export function a11yStyleText(px: number = MIN_TEXT_PX): string {
  return 'position:fixed;right:8px;bottom:8px;z-index:30;max-width:min(56vw,340px);'
    + 'max-height:22vh;overflow:auto;opacity:.94;'
    + `font:${px}px/1.55 ui-monospace,Menlo,Consolas,monospace;`
    + `color:${A11Y_TEXT};background:${A11Y_BG};`
    + `border:2px solid ${A11Y_EDGE};border-radius:10px;padding:8px 12px;`
    + 'white-space:pre-wrap;outline-offset:2px;'
    + `outline:2px solid ${A11Y_OK};`;
}

/** 镜像面板的句柄。构造时**不碰 DOM**(见文件头)。 */
export interface A11yMirror {
  /** 挂到宿主元素里(幂等)。`el` 非法 / 无 `ownerDocument` ⇒ 什么都不做。 */
  mount(el: unknown): void;
  /** 写文本(按 panel id;未给的面板保持上一次的值)。 */
  update(text: A11yText): void;
  /** 是否已挂进 DOM。 */
  readonly mounted: boolean;
  /** 是否可见(本层常显 ⇒ 挂上即 true)。 */
  readonly visible: boolean;
  /** 所有面板的 `id: 文本` 行(自检 / 判据读它,而不是去猜 DOM 结构)。 */
  textOf(): string[];
  dispose(): void;
}

/** 建一个镜像面板(构造安全:node 里 import/调用都不抛)。 */
export function createA11yMirror(doc?: unknown): A11yMirror {
  let root: { appendChild: (c: never) => void } | null = null;
  const nodes = new Map<string, { setAttribute: (k: string, v: string) => void; textContent: string }>();
  let owned: unknown = doc ?? null;

  const getDoc = (host: unknown): { createElement: (t: string) => unknown } | null => {
    const h = host as { ownerDocument?: { createElement?: unknown } } | null;
    if (h !== null && h !== undefined && typeof h.ownerDocument?.createElement === 'function') {
      return h.ownerDocument as { createElement: (t: string) => unknown };
    }
    const d = owned as { createElement?: unknown } | null;
    if (d !== null && typeof d?.createElement === 'function') return d as { createElement: (t: string) => unknown };
    return null;
  };

  return {
    get mounted() { return root !== null; },
    get visible() { return root !== null; },

    mount(el: unknown): void {
      if (root !== null) return;
      const d = getDoc(el);
      if (d === null) return;
      const host = el as { appendChild?: unknown };
      if (typeof host?.appendChild !== 'function') return;
      owned = d;
      const section = d.createElement('section') as {
        id: string;
        setAttribute: (k: string, v: string) => void;
        style: { cssText: string };
        appendChild: (c: never) => void;
      };
      section.id = 'a11y_panels';
      /* ★ 读屏器从这里知道"这是一块什么面板";`tabindex=0` ⇒ 键盘 Tab 能到。 */
      section.setAttribute('aria-label', '面板文本镜像(读屏器 / 键盘 Tab 可读)');
      section.setAttribute('role', 'region');
      section.setAttribute('tabindex', '0');
      section.style.cssText = a11yStyleText(MIN_TEXT_PX);
      for (const spec of A11Y_PANELS) {
        const row = d.createElement('div') as {
          setAttribute: (k: string, v: string) => void;
          textContent: string;
        };
        row.setAttribute('role', spec.role);
        row.setAttribute('aria-label', spec.label);
        row.setAttribute('aria-live', spec.role === 'region' ? 'off' : 'polite');
        row.textContent = '';
        nodes.set(spec.id, row);
        section.appendChild(row as never);
      }
      host.appendChild?.(section as never);
      root = section as unknown as { appendChild: (c: never) => void };
    },

    update(text: A11yText): void {
      if (root === null) return;
      for (const [id, value] of Object.entries(text)) {
        const node = nodes.get(id);
        /* ⚠️ 未登记的面板 id 直接忽略(不新建节点):面板清单只有 `A11Y_PANELS` 一份。 */
        if (node === undefined || typeof value !== 'string') continue;
        node.textContent = value;
      }
    },

    textOf(): string[] {
      const out: string[] = [];
      for (const spec of A11Y_PANELS) {
        const node = nodes.get(spec.id);
        if (node === undefined) continue;
        out.push(`${spec.id}: ${node.textContent}`);
      }
      return out;
    },

    dispose(): void {
      nodes.clear();
      root = null;
    },
  };
}
