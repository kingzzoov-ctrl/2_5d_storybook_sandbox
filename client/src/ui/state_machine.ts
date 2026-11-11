/**
 * WS-09 / UI 状态机 —— 纯逻辑层(不 import three)。
 *
 * 六个界面共用一台状态机:背包 / 合成台配方树 / 像素画架 / 房间蓝图 / Boss 血条 / 音高砖编辑。
 * 为什么必须做成状态机而不是几个 boolean:
 *  背包里有「配方树」,配方树里能开「像素画架」,画架提交时又要回到背包 ——
 *  用 boolean 表达会出现「画架开着但背包以为已关闭」这类状态错相,
 *  而错相一旦发生,玩家会看到两个面板重叠、点击穿透、提交两次(重复消耗材料)。
 *
 * 设计:
 *  - 状态用 `as const` 对象(仓库禁 enum);
 *  - **唯一合法通路**:CLOSED ↔ OPENING ↔ OPEN ↔ SUBMITTING → OPEN / ERROR → OPEN / CLOSED;
 *    非法迁移抛 `Error`,不静默吞掉 —— 宁可崩在开发机,也不要线上丢材料;
 *  - SUBMITTING 期间锁输入(`acceptsInput === false`),这是防重复提交的第一道闸;
 *  - 带 `revision` 版本号,装配层可据此判断「本帧是否发生了界面切换」而无需 diff DOM。
 */

export const UiState = {
  CLOSED: 'CLOSED',
  OPENING: 'OPENING',
  OPEN: 'OPEN',
  SUBMITTING: 'SUBMITTING',
  ERROR: 'ERROR',
} as const;
export type UiState = (typeof UiState)[keyof typeof UiState];

export const UI_STATES: readonly UiState[] = ['CLOSED', 'OPENING', 'OPEN', 'SUBMITTING', 'ERROR'];

/** 迁移白名单:key = 起点,value = 允许到达的终点集合 */
export const LEGAL_TRANSITIONS: Record<UiState, readonly UiState[]> = {
  CLOSED: ['OPENING'],
  OPENING: ['OPEN', 'CLOSED'],
  OPEN: ['SUBMITTING', 'CLOSED'],
  SUBMITTING: ['OPEN', 'ERROR'],
  ERROR: ['OPEN', 'CLOSED'],
};

export interface TransitionRecord {
  from: UiState;
  to: UiState;
  reason: string;
  /** 单调递增的迁移序号 */
  seq: number;
}

/** 状态机可挂载的界面面板 */
export const UiPanel = {
  NONE: 'NONE',
  INVENTORY: 'INVENTORY',
  RECIPE_TREE: 'RECIPE_TREE',
  PIXEL_EASEL: 'PIXEL_EASEL',
  BLUEPRINT: 'BLUEPRINT',
  BOSS_HUD: 'BOSS_HUD',
  PITCH_EDITOR: 'PITCH_EDITOR',
} as const;
export type UiPanel = (typeof UiPanel)[keyof typeof UiPanel];

/** 各面板允许的草稿类型(提交时的载荷契约) */
export interface PanelPayload {
  panel: UiPanel;
  /** 像素画架的 16×16 行 */
  iconRows?: string[];
  /** 蓝图的框选矩形 */
  rect?: { x0: number; y0: number; x1: number; y1: number };
  /** 配方树的选定配方哈希 */
  recipeHash?: string;
  /** 音高砖的 32 位音高掩码 */
  pitchMask?: number;
}

export class IllegalTransitionError extends Error {
  readonly from: UiState;
  readonly to: UiState;
  constructor(from: UiState, to: UiState) {
    super(`非法 UI 状态迁移: ${from} → ${to}(合法目标: ${LEGAL_TRANSITIONS[from].join(', ') || '无'})`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class UiStateMachine {
  private current: UiState;
  private panel: UiPanel;
  private rev: number;
  private seq: number;
  private readonly log: TransitionRecord[];
  private readonly maxLog: number;
  private payload: PanelPayload | null;
  private errorMsg: string;
  /** 打开动画进度 0..1(OPENING 时推进) */
  private openProgress: number;

  constructor(maxLog = 64) {
    this.current = UiState.CLOSED;
    this.panel = UiPanel.NONE;
    this.rev = 0;
    this.seq = 0;
    this.log = [];
    this.maxLog = Math.max(1, Math.trunc(maxLog));
    this.payload = null;
    this.errorMsg = '';
    this.openProgress = 0;
  }

  get state(): UiState {
    return this.current;
  }

  get activePanel(): UiPanel {
    return this.panel;
  }

  get revision(): number {
    return this.rev;
  }

  get transitionSeq(): number {
    return this.seq;
  }

  get transitionLog(): readonly TransitionRecord[] {
    return this.log;
  }

  get lastError(): string {
    return this.errorMsg;
  }

  /** SUBMITTING 期间不接受输入 —— 防重复提交 */
  get acceptsInput(): boolean {
    return this.current === UiState.OPEN;
  }

  get isVisible(): boolean {
    return this.current !== UiState.CLOSED;
  }

  get openingProgress(): number {
    return this.openProgress;
  }

  canGo(to: UiState): boolean {
    return LEGAL_TRANSITIONS[this.current].includes(to);
  }

  /** 非法迁移**抛错**;合法则推进并返回 true */
  transition(to: UiState, reason = ''): boolean {
    const from = this.current;
    if (to === from) return false;
    if (!this.canGo(to)) throw new IllegalTransitionError(from, to);
    this.current = to;
    this.seq += 1;
    this.rev += 1;
    this.log.push({ from, to, reason, seq: this.seq });
    if (this.log.length > this.maxLog) this.log.shift();
    if (to === UiState.OPENING) this.openProgress = 0;
    if (to === UiState.OPEN) this.openProgress = 1;
    return true;
  }

  /** 打开某个面板:CLOSED → OPENING,并记下面板类型 */
  open(panel: UiPanel): void {
    if (this.current === UiState.CLOSED) this.transition(UiState.OPENING, `open:${panel}`);
    this.panel = panel;
    this.payload = { panel };
  }

  /** 打开动画推进;进度到 1 时自动进入 OPEN */
  tick(dt: number, openDurationSec = 0.12): void {
    if (this.current !== UiState.OPENING) return;
    const step = openDurationSec <= 0 ? 1 : Math.abs(dt) / openDurationSec;
    this.openProgress = Math.min(1, this.openProgress + step);
    if (this.openProgress >= 1) this.transition(UiState.OPEN, 'opening-done');
  }

  /** 设置当前草稿载荷(OPEN 时才接受,否则忽略) */
  setPayload(patch: Partial<PanelPayload>): boolean {
    if (this.current !== UiState.OPEN) return false;
    this.payload = { ...(this.payload ?? { panel: this.panel }), ...patch };
    return true;
  }

  getPayload(): PanelPayload | null {
    return this.payload;
  }

  /** 提交:OPEN → SUBMITTING;非 OPEN 时抛错(避免半开状态误提交) */
  beginSubmit(): PanelPayload {
    this.transition(UiState.SUBMITTING, 'submit');
    return this.payload ?? { panel: this.panel };
  }

  /** 提交成功:SUBMITTING → OPEN */
  submitOk(reason = 'submit-ok'): void {
    this.transition(UiState.OPEN, reason);
  }

  /** 提交失败:SUBMITTING → ERROR,并记录原因 */
  submitFail(msg: string): void {
    this.errorMsg = msg;
    this.transition(UiState.ERROR, `submit-fail:${msg}`);
  }

  /** 从 ERROR 恢复 */
  recover(): void {
    if (this.current !== UiState.ERROR) return;
    this.errorMsg = '';
    this.transition(UiState.OPEN, 'recover');
  }

  /** 关闭:ERROR/OPENING/OPEN → CLOSED;SUBMITTING 不允许直接关闭(应等结果) */
  close(): void {
    if (this.current === UiState.SUBMITTING) throw new IllegalTransitionError(this.current, UiState.CLOSED);
    this.transition(UiState.CLOSED, 'close');
    this.panel = UiPanel.NONE;
    this.payload = null;
    this.openProgress = 0;
  }

  /** 重置为初始态(断线重连时用,不抛错) */
  reset(): void {
    this.current = UiState.CLOSED;
    this.panel = UiPanel.NONE;
    this.payload = null;
    this.errorMsg = '';
    this.openProgress = 0;
    this.rev += 1;
  }
}

/* ───────────────────── 背包格子状态机(格子级) ───────────────────── */

export const SlotState = {
  EMPTY: 'EMPTY',
  FILLED: 'FILLED',
  DRAGGING: 'DRAGGING',
  DROP_TARGET: 'DROP_TARGET',
} as const;
export type SlotState = (typeof SlotState)[keyof typeof SlotState];

export const SLOT_TRANSITIONS: Record<SlotState, readonly SlotState[]> = {
  EMPTY: ['FILLED', 'DROP_TARGET'],
  FILLED: ['EMPTY', 'DRAGGING', 'DROP_TARGET'],
  DRAGGING: ['EMPTY', 'FILLED', 'DROP_TARGET'],
  DROP_TARGET: ['FILLED', 'EMPTY'],
};

export interface DragContext {
  fromSlot: number;
  itemId: number;
  count: number;
}

/**
 * 拖拽控制器:负责「拿起 → 悬停 → 放下」三态与背包格位索引传递。
 *
 * **本类不与背包容量耦合**(task-15 复核结论):`hoverSlot` 只是一个「当前悬停在哪一格」
 * 的整数,初值 `-1` 表示无悬停,拖拽中由 `hoverAt()` 写入调用方给的格位下标。
 * 这里不读 `INVENTORY_SLOTS`,也不校验 `slot < 容量` —— 越界与否由背包层
 * (`inventory.itemAt` / `isEmptySlot`)负责,拖拽层只负责「记住是哪一格」。
 * 原注释写的「320 格背包索引映射」是 WS-FND-02 解耦前的说法(容量已改为 336),
 * 且它暗示了一个并不存在的依赖,容易让人误以为改容量要动这里 —— 已订正。
 *
 * 非法操作(拿空格、放到自己身上)返回 false 而非抛错 —— 拖拽是高频输入,
 * 抛错会让每帧的输入循环被 exception 打断。
 */
export class DragController {
  private ctx: DragContext | null;
  private hoverSlot: number;

  constructor() {
    this.ctx = null;
    this.hoverSlot = -1;
  }

  get dragging(): DragContext | null {
    return this.ctx;
  }

  get hover(): number {
    return this.hoverSlot;
  }

  get isDragging(): boolean {
    return this.ctx !== null;
  }

  pickUp(slot: number, itemId: number, count: number): boolean {
    if (this.ctx !== null) return false;
    if (itemId <= 0 || count <= 0) return false;
    this.ctx = { fromSlot: slot, itemId, count };
    return true;
  }

  hoverAt(slot: number): void {
    this.hoverSlot = this.isDragging ? slot : -1;
  }

  /** 放下;返回 {fromSlot, toSlot, itemId, count} 供上层交换物品 */
  drop(slot: number): { fromSlot: number; toSlot: number; itemId: number; count: number } | null {
    if (this.ctx === null) return null;
    if (slot === this.ctx.fromSlot) {
      this.cancel();
      return null;
    }
    const out = { fromSlot: this.ctx.fromSlot, toSlot: slot, itemId: this.ctx.itemId, count: this.ctx.count };
    this.ctx = null;
    this.hoverSlot = -1;
    return out;
  }

  cancel(): void {
    this.ctx = null;
    this.hoverSlot = -1;
  }
}