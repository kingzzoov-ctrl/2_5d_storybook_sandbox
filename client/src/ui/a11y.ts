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
 * ✅ ★ WS-FND-170:**本文件是画布可读性的唯一出处**。`three/ui_binding.ts` 现在直接
 *    import 这里的 `CANVAS_FONT_PX` / `canvasFontText()` / `A11Y_EDGE` / `rgbaOf()` /
 *    `A11Y_MONO_STACK`,不再各写一份。修前它自己写 `10px` 与
 *    `rgba(120,150,210,.42)`(实测 2.09:1;`cellEdge` 1.52:1)⇒ 同一个屏幕两套可读口径。
 *    判据:`tests/WS-FND-170-canvas-a11y.test.ts`。
 *
 * ★ 浏览器基线(构建 `target = es2022`、必须走 Vite 构建)与最危险 API
 *    (`structuredClone`)的降级也住在本文件 —— 理由见下方「浏览器基线」一节:
 *    白屏对读屏器 / 键盘用户是 0 信息。
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

/* ── ★ WS-FND-170:画布层(`three/ui_binding.ts`)可读性的**唯一出处** ── */
/**
 * 画布字号(px)。**画布只许 import 它** —— 一个 px 字面量都不许留在 `ui_binding.ts`。
 *
 * 修前画布自己写 9 / 10 / 11 / 12px 四档(分类标签 10px、音名 9px),而这一层(DOM)
 * 早就用 `MIN_TEXT_PX` ⇒ **同一个屏幕两套可读口径**。
 */
export const CANVAS_FONT_PX = MIN_TEXT_PX;
/** 画布与镜像面板**共用**的等宽字体栈(两处各写一份 ⇒ 改一处就静默分叉)。 */
export const A11Y_MONO_STACK = 'ui-monospace,Menlo,Consolas,monospace';
/**
 * 画布面板底的不透明度(面板底 = `rgbaOf(A11Y_BG, 这个数)`)。
 *
 * 画布上的面板底是**半透明**的(压在世界画面上),不是实色 `A11Y_BG`
 * ⇒ 「描边 ≥3:1」必须按**最亮场景**算:0.94 叠在白场景上,`A11Y_EDGE` 仍有 5.32:1。
 * 判据(`tests/WS-FND-170`)正是拿这个最坏情况算的,不是拿 `A11Y_BG` 自己算。
 */
export const CANVAS_PANEL_FILL_ALPHA = 0.94;

/** 画布字号串(`13px <字体栈>`);非法 `px` 回落到基线 —— 不许给出一个**更小**的字号。 */
export function canvasFontText(px: number = CANVAS_FONT_PX): string {
  const size = Number.isFinite(px) && px >= MIN_TEXT_PX ? px : CANVAS_FONT_PX;
  return `${size}px ${A11Y_MONO_STACK}`;
}

/** `#rrggbb` + alpha ⇒ `rgba(r,g,b,a)`(半透明色**从这里**派生,不许另写一处字面量)。 */
export function rgbaOf(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  /* 非法 hex ⇒ 原样返回:不编一个"看起来合法"的颜色(那会让假色值静默通过)。 */
  if (rgb === null) return hex;
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
}

/** 逐通道把 `fgHex` 按 `alpha` 混到 `bgHex` 上 ⇒ `#rrggbb`(对比度按**混合后**的实色算)。 */
export function blendOver(fgHex: string, alpha: number, bgHex: string): string {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  if (fg === null || bg === null) return fgHex;
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  const ch = [fg.r, fg.g, fg.b].map((c, i) => Math.round(a * c + (1 - a) * [bg.r, bg.g, bg.b][i]!));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

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

/* ═══════════ ★ WS-FND-170:浏览器基线 + 最危险 API 的降级 ═══════════
 *
 * ## 为什么这件事住在 a11y 层
 * ```text
 * 缺 API 的表现是**整页白屏**(#fatal),而白屏对读屏器 / 键盘用户是 0 信息
 * ⇒「能不能跑」与「跑不起来时说得出话」是同一件事的两面,归这一层。
 * ```
 * ## 基线(README「浏览器兼容性基线」一节**逐字引用** `BROWSER_BASELINE_TEXT`)
 * `vite.config.ts` 的 `build.target = es2022` ⇒ 允许 `??=` / `Array.prototype.at` /
 * `Object.hasOwn` / `structuredClone`;没有 import maps、也不装 polyfill(零依赖)
 * ⇒ 基线是硬门槛,**且必须走 Vite 构建**:未构建的 `client/` 里 import 的是 `.ts`,
 * 浏览器原生不认 ⇒ module 图 404 ⇒ 白屏(由 `client/index.html` 的兜底脚本报 URL)。
 * ## 降级
 * `structuredClone` 是这批 API 里最危险的一个(旧 WebView 抛
 * `TypeError: structuredClone is not defined`,而这通常发生在启动路径上 ⇒ 整页 #fatal)。
 * 本模块给两条出口:JSON 往返的等价降级 + 把话说在屏幕上的 `role="alert"` 横幅。
 *
 * ⚠️ 如实记:截至本轮,生产代码里 `structuredClone` 调用点 = **0**(全仓 grep)。
 *    它仍在基线里,因为 target = es2022 **允许**它 —— 一旦谁开始用,旧 WebView 就整页挂;
 *    降级先就位,并由 `tests/WS-FND-170` 钉住"真的能克隆"。
 */

/** README「浏览器兼容性基线」一节里**逐字引用**的基线句(单一来源:README 抄错 ⇒ WS-FND-170 红)。 */
export const BROWSER_BASELINE_TEXT =
  'Chrome 98+ / Edge 98+ / Firefox 94+ / Safari 15.4+(桌面 + iOS 15.4 WebView),构建 target = es2022';

/** 基线成立的前提 API(名字 + 缺失时的后果)。 */
export const BASELINE_REQUIRED_APIS: readonly { name: string; why: string }[] = [
  { name: 'structuredClone', why: '深拷贝:旧 WebView 缺失 ⇒ 启动路径上抛错 ⇒ 整页走 #fatal(白屏)' },
];

/** JSON 往返降级的**已知差异**(如实写,不假装等价)。 */
export const CLONE_FALLBACK_LIMITS = '只覆盖 JSON 可序列化的数据:'
  + 'Map / Set / Date / 类实例会退化成普通对象或字符串,函数 / undefined 原样返回,循环引用无法复制';

/**
 * 基线要求、但 `scope` 上**缺失**的 API 名(空数组 = 齐备)。
 *
 * 纯函数 + `scope` 可注入 ⇒ 判据能造一个「旧 WebView」(没有 `structuredClone` 的对象),
 * 而不必去改真 `globalThis`。
 */
export function missingBaselineApis(scope: unknown = globalThis): string[] {
  const out: string[] = [];
  const s = scope as Record<string, unknown> | null | undefined;
  for (const spec of BASELINE_REQUIRED_APIS) {
    const impl = s === null || s === undefined ? undefined : s[spec.name];
    if (typeof impl !== 'function') out.push(spec.name);
  }
  return out;
}

/**
 * `structuredClone` 的降级实现(JSON 往返)。
 *
 * ⚠️ **三条边界都不抛**:缺 API 的时候抛就是直接白屏,而这个函数的唯一职责是别让页面挂。
 * ```text
 * 循环引用 / 含函数 / 非 JSON 值 ⇒ 原样返回入参(复制不了就如实说,不假装复制了)
 * undefined / null              ⇒ 原样返回
 * ```
 */
export function structuredCloneFallback<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    return JSON.parse(json) as T;
  } catch {
    return value;
  }
}

/** 装上降级的三态:`native` 本来就有(**不覆盖**)/ `installed` 已装(幂等)/ `unavailable` 装不上。 */
export type CloneFallbackVerdict = 'native' | 'installed' | 'unavailable';

/** 给 `scope` 装 `structuredClone` 降级(**有就绝不动它** —— 别把原生实现换掉)。 */
export function installStructuredCloneFallback(scope: unknown = globalThis): CloneFallbackVerdict {
  const s = scope as Record<string, unknown> | null | undefined;
  if (s === null || s === undefined) return 'unavailable';
  if (typeof s['structuredClone'] === 'function') return 'native';
  try {
    s['structuredClone'] = structuredCloneFallback;
  } catch {
    return 'unavailable';
  }
  return typeof s['structuredClone'] === 'function' ? 'installed' : 'unavailable';
}

/** 基线体检结论(镜像面板按它决定要不要显示横幅)。 */
export interface BrowserBaselineReport {
  /** 进入时就缺的 API(空 = 齐备,不需要任何提示) */
  missing: string[];
  /** `structuredClone` 这一条走了哪条路 */
  clone: CloneFallbackVerdict | 'not-needed';
  /** 装完降级后**仍然**缺的 API(非空 ⇒ 本页大概率跑不起来) */
  remaining: string[];
  /** 给人读的一句话(空串 = 无需提示;非空 ⇒ **必须**显示在 DOM 上,不许只进控制台) */
  text: string;
}

/**
 * 基线体检 + 降级(幂等:第二次调用返回 `clone: 'not-needed'` —— 不再缺就不做任何动作)。
 *
 * ★ 为什么返回**文本**而不是只打一条日志:控制台在真机上没人看得到,
 *   而"缺 API ⇒ 白屏"这条正是本轮要消掉的形态。
 * ⚠️ 调用点如实写:`main.ts` 在 `boot()` **之后**调 `a11y.mount(root)`,降级也随之安装
 *   ⇒ **启动路径内部**若用了缺的 API,先兜住它的是 `index.html` 的兜底脚本 +
 *   `main.ts` 的 `reportFatal`(那条路已有判据:WS-FND-167)。两条出口都不白屏。
 */
export function browserBaselineReport(scope: unknown = globalThis): BrowserBaselineReport {
  const missing = missingBaselineApis(scope);
  if (missing.length === 0) {
    return { missing, clone: 'not-needed', remaining: [], text: '' };
  }
  const clone = installStructuredCloneFallback(scope);
  const remaining = missingBaselineApis(scope);
  const head = `浏览器低于本项目基线(${BROWSER_BASELINE_TEXT}):本页缺少 ${missing.join(' / ')}。`;
  const body = remaining.length === 0
    ? `已装上等价降级(${CLONE_FALLBACK_LIMITS})—— 页面可以继续跑。`
    : `并且**装不上**降级(仍缺 ${remaining.join(' / ')})—— 本页无法运行:请升级浏览器。`;
  return { missing, clone, remaining, text: head + body };
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
    + `font:${px}px/1.55 ${A11Y_MONO_STACK};`
    + `color:${A11Y_TEXT};background:${A11Y_BG};`
    + `border:2px solid ${A11Y_EDGE};border-radius:10px;padding:8px 12px;`
    + 'white-space:pre-wrap;outline-offset:2px;'
    + `outline:2px solid ${A11Y_OK};`;
}

/** 镜像面板的句柄。构造时**不碰 DOM**(见文件头)。 */
export interface A11yMirror {
  /**
   * 挂到宿主元素里(幂等)。`el` 非法 / 无 `ownerDocument` ⇒ 什么都不做。
   *
   * ★ WS-FND-170:`scope` = **可注入的全局对象**(默认 `globalThis`)—— 基线探测与降级
   * 都作用在它上面 ⇒ 判据能模拟"缺 `structuredClone` 的旧 WebView",而不必污染真全局对象。
   */
  mount(el: unknown, scope?: unknown): void;
  /** 写文本(按 panel id;未给的面板保持上一次的值)。 */
  update(text: A11yText): void;
  /** 是否已挂进 DOM。 */
  readonly mounted: boolean;
  /** 是否可见(本层常显 ⇒ 挂上即 true)。 */
  readonly visible: boolean;
  /**
   * ★ WS-FND-170:基线提示(空串 = 环境达标;非空 = 那句话已显示在镜像面板顶部)。
   *
   * 存在的理由:环境不达标时**必须**有一句人话可读 —— 白屏对读屏器是 0 信息,
   * 而"缺 API"这件事此前只在控制台里(真机上没人看得到)。
   */
  readonly baselineNote: string;
  /** 所有面板的 `id: 文本` 行(自检 / 判据读它,而不是去猜 DOM 结构)。 */
  textOf(): string[];
  dispose(): void;
}

/** 建一个镜像面板(构造安全:node 里 import/调用都不抛)。 */
export function createA11yMirror(doc?: unknown): A11yMirror {
  let root: { appendChild: (c: never) => void } | null = null;
  const nodes = new Map<string, { setAttribute: (k: string, v: string) => void; textContent: string }>();
  let owned: unknown = doc ?? null;
  /** ★ WS-FND-170:基线提示(空串 = 环境达标;非空 = 已显示在镜像面板顶部) */
  let baseline = '';

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
    get baselineNote() { return baseline; },

    mount(el: unknown, scope: unknown = globalThis): void {
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

      /* ★ WS-FND-170:基线守卫 —— 缺 API 时**先装降级,再把话说在屏幕上**。
         修前:旧 WebView 缺 `structuredClone` ⇒ 启动路径上抛错 ⇒ 整页 `#fatal`
         (对读屏器 / 键盘用户 = 0 信息)。这里两条出口都给出:
         `browserBaselineReport()` 装降级,`role="alert"` 横幅把那句话念出来。 */
      const report = browserBaselineReport(scope);
      baseline = report.text;
      if (report.text !== '') {
        const banner = d.createElement('div') as {
          setAttribute: (k: string, v: string) => void;
          style: { cssText: string };
          textContent: string;
        };
        banner.setAttribute('role', 'alert');
        banner.setAttribute('aria-live', 'assertive');
        banner.style.cssText = 'margin:0 0 6px;padding:6px 8px;border-radius:6px;'
          + `color:${A11Y_BAD};border:2px solid ${A11Y_BAD};font:${MIN_TEXT_PX}px/1.5 ${A11Y_MONO_STACK};`;
        banner.textContent = report.text;
        section.appendChild(banner as never);
      }
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
      /* ★ WS-FND-170:基线提示也进**机读口径**(判据不去猜 DOM 结构)。 */
      if (baseline !== '') out.push(`基线: ${baseline}`);
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
