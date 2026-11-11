/**
 * WS-08 / 四色魔能电路有向图与 2Hz 信号推进器。
 *
 * 模型:
 *  - 四色(R/B/Y/G)为**互相独立的位平面**,同一格可同时埋四种线而互不干扰;
 *  - 每个电线格从「自身 + 最多 4 个邻居」取逻辑**或**作为通电判定 —— 实现上等价于
 *    从所有「被驱动格」出发,沿该色线的 4 邻连通分量整体泛洪(与逐帧松弛到不动点同解,
 *    但复杂度从 O(K·N) 降到 O(N));
 *  - 推进频率 2Hz(`SLOW_TICK_HZ`),即每帧 0.5s;所有逻辑件默认 1 帧固有延迟,
 *    延时继电器在此之上叠加 `ceil(delayS / 0.5)` 帧;
 *  - 「只推进脏网络」:拓扑未变而仅驱动源变化时,只重泛洪受影响的那个连通分量,
 *    单次收益在 512×512 / 2 万电线格场景下约为 **40×~300×**(见文档 §6)。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { SLOW_DT, SLOW_TICK_HZ } from '../../../shared/types/physics.ts';
import { WireColor, WIRE_BIT } from '../../../shared/types/tile.ts';

export { SLOW_DT, SLOW_TICK_HZ };

/** 每帧现实时长(秒):0.5s。 */
export const FRAME_SECONDS = SLOW_DT;
/** 每秒推进帧数:2。 */
export const TICKS_PER_SECOND = SLOW_TICK_HZ;

/** 把秒数换算成 2Hz 下的帧数(向上取整,最小 1 帧)。 */
export function secondsToTicks(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / FRAME_SECONDS - 1e-9));
}

export const ALL_COLORS: readonly WireColor[] = [
  WireColor.RED,
  WireColor.BLUE,
  WireColor.YELLOW,
  WireColor.GREEN,
];

export const COLOR_KEY: Record<number, string> = {
  [WireColor.RED]: 'RED',
  [WireColor.BLUE]: 'BLUE',
  [WireColor.YELLOW]: 'YELLOW',
  [WireColor.GREEN]: 'GREEN',
};

/* ─────────────────── 组件抽象 ─────────────────── */

export interface PendingWrite {
  tick: number;
  color: WireColor;
  on: boolean;
  /** 目标格全局索引;−1 表示本组件所在格 */
  cell: number;
}

export interface ComponentNode {
  id: string;
  /** 逻辑件类型标识,对应 `COMPONENT_KINDS` 注册表 */
  kind: string;
  x: number;
  y: number;
  /** 静态参数(音高、频道、过滤物品 ID 等) */
  params: Record<string, number>;
  /** 输出颜色(该件会点亮哪些线) */
  outputs: WireColor[];
  /** 运行态 */
  state: Record<string, number>;
  /** 固有延迟(帧) */
  latencyTicks: number;
  /** 到期的输出队列 */
  pending: PendingWrite[];
  /** 上一帧的输出快照,用于抑制重复写 */
  lastOut: Record<string, number>;
}

export function createComponent(
  id: string,
  kind: string,
  x: number,
  y: number,
  patch: Partial<ComponentNode> = {},
): ComponentNode {
  return {
    id,
    kind,
    x,
    y,
    params: {},
    outputs: [],
    state: {},
    latencyTicks: 1,
    pending: [],
    lastOut: {},
    ...patch,
  };
}

export interface ComponentContext {
  graph: SignalGraph;
  comp: ComponentNode;
  tick: number;
  /** 读该格 5×5 范围内指定色的通电状态(半径 = READ_RADIUS = 2) */
  readWire(color: WireColor): boolean;
  /** 读无线频道(1..8) */
  readChannel(ch: number): boolean;
  /** 写无线频道 */
  writeChannel(ch: number, on: boolean): void;
  /** 写输出:延迟 `latencyTicks` 帧后生效 */
  write(color: WireColor, on: boolean): void;
  /** 立即写输出(当前帧生效,仅传感器与调试件使用) */
  writeNow(color: WireColor, on: boolean): void;
  /** 写指定相对偏移格的输出(分流器三路端口、活塞臂等) */
  writeAt(dx: number, dy: number, color: WireColor, on: boolean): void;
  /** 读指定相对偏移格的通电状态(定向输入件) */
  readAt(dx: number, dy: number, color: WireColor): boolean;
  /** 读取/写入持久化运行态 */
  st(key: string): number;
  setSt(key: string, v: number): void;
  /** 静态参数读取 */
  param(key: string): number;
  /** 共享跑酷计时器(411 开表 / 412 停表) */
  race: { running: number; startTick: number; elapsedTicks: number; finishMs: number };
}

export type ComponentEvaluator = (ctx: ComponentContext) => void;

const REGISTRY = new Map<string, ComponentEvaluator>();

/** 注册逻辑件行为。components.ts 在模块加载时调用。 */
export function registerComponentKind(kind: string, fn: ComponentEvaluator): void {
  REGISTRY.set(kind, fn);
}

export function hasComponentKind(kind: string): boolean {
  return REGISTRY.has(kind);
}

export function registeredKinds(): string[] {
  return [...REGISTRY.keys()].sort();
}

/* ─────────────────── 推进统计 ─────────────────── */

export interface PropagateStats {
  /** 本次 tick 泛洪访问的格数 */
  cellsFlooded: number;
  /**
   * 本次 tick **扫描**的格数(含未被访问、仅被清零的格)。
   * 全量模式必须遍历整个位平面,故此项 ≈ 颜色数 × 世界格数;
   * 脏模式只碰受影响分量,此项 ≈ 分量格数。这是增量优化真正的收益来源。
   */
  cellsScanned: number;
  /** 本次 tick 泛洪的颜色数 */
  colorsFlooded: number;
  /** 本帧是「全量重算」还是「只推进脏网络」 */
  mode: string;
  /** 评估的逻辑件数 */
  componentsEvaluated: number;
}

export const PropagateMode = {
  FULL: 'FULL',
  DIRTY_ONLY: 'DIRTY_ONLY',
  IDLE: 'IDLE',
} as const;
export type PropagateMode = (typeof PropagateMode)[keyof typeof PropagateMode];

/* ─────────────────── 四色网络图 ─────────────────── */

/**
 * 信号图:稀疏存储(世界可能 512×512,但绝大多数格没有线)。
 * 位平面用 `Uint8Array`,每格 1 字节存 4 色;512×512 = 256KB/平面,四平面共 1MB。
 */
export class SignalGraph {
  readonly width: number;
  readonly height: number;

  /** 每格的四色「已布线」掩码 */
  readonly wireBits: Uint8Array;
  /** 每格的四色「被组件驱动」掩码 */
  readonly driveBits: Uint8Array;
  /** 每格的四色「已通电」掩码 */
  readonly liveBits: Uint8Array;

  components: Map<string, ComponentNode>;
  /**
   * 手动/外部写入的频道态(拉杆直控、测试注入、调试台强制)。
   * 与组件广播态取「或」,因此不会被组件帧循环覆盖。
   */
  channelManual: Map<number, boolean>;
  /** 组件广播态:每帧由全部 `WIRELESS_LINK` 发射器的本地输入取「或」重算 */
  channelBroadcast: Map<number, boolean>;
  /** 本帧累积的组件广播(OR 语义,帧末提升到 `channelBroadcast`) */
  private channelInput: Map<number, boolean>;
  private channelPending: Map<number, PendingWrite[]>;

  /**
   * **共享跑酷计时器**(跑酷是跨件的单一比赛时钟,不属于任何单个件)。
   * 411 发令门负责开表,412 领奖台负责停表,其余件只读。
   */
  race: { running: number; startTick: number; elapsedTicks: number; finishMs: number };

  /** 结构变化(增删线)标记的颜色 */
  private structuralDirty: Set<number>;
  /** 仅驱动源变化标记的颜色 */
  private driveDirty: Set<number>;
  /** 驱动变化的具体格,供分量级重泛洪使用 */
  private driveDirtyCells: Set<number>;
  /** 每色上一帧的通电格,供全量重算时只清这些格 */
  private liveCells: Map<number, number[]>;
  /** 每色当前被驱动的格集合(增量维护,避免全平面扫描) */
  private driveCellsByColor: Map<number, Set<number>>;

  tickCount: number;
  /** 优化开关:false 时每帧全量重算四色(用于对照基线) */
  dirtyOptimization: boolean;

  /** 本帧统计 */
  stats: PropagateStats;
  /** 累计泛洪格数(性能测量用) */
  totalCellsFlooded: number;
  /** 累计帧数 */
  totalTicks: number;

  constructor(width: number, height: number, dirtyOptimization = true) {
    this.width = Math.max(0, width | 0);
    this.height = Math.max(0, height | 0);
    const n = this.width * this.height;
    this.wireBits = new Uint8Array(n);
    this.driveBits = new Uint8Array(n);
    this.liveBits = new Uint8Array(n);
    this.components = new Map();
    this.channelManual = new Map();
    this.channelBroadcast = new Map();
    this.channelInput = new Map();
    this.channelPending = new Map();
    this.race = { running: 0, startTick: 0, elapsedTicks: 0, finishMs: 0 };
    this.structuralDirty = new Set();
    this.driveDirty = new Set();
    this.driveDirtyCells = new Set();
    this.liveCells = new Map();
    for (const c of ALL_COLORS) this.liveCells.set(c as number, []);
    this.driveCellsByColor = new Map();
    for (const c of ALL_COLORS) this.driveCellsByColor.set(c as number, new Set());
    this.tickCount = 0;
    this.dirtyOptimization = dirtyOptimization;
    this.stats = {
      cellsFlooded: 0, cellsScanned: 0, colorsFlooded: 0,
      mode: PropagateMode.IDLE, componentsEvaluated: 0,
    };
    this.totalCellsFlooded = 0;
    this.totalTicks = 0;
    for (const c of ALL_COLORS) this.structuralDirty.add(c);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  index(x: number, y: number): number {
    return this.inBounds(x, y) ? y * this.width + x : -1;
  }

  /* ── 布线 ── */

  addWire(x: number, y: number, color: WireColor): boolean {
    const i = this.index(x, y);
    if (i < 0) return false;
    const bit = WIRE_BIT[color];
    if ((this.wireBits[i] & bit) !== 0) return false;
    this.wireBits[i] |= bit;
    this.structuralDirty.add(color);
    return true;
  }

  removeWire(x: number, y: number, color: WireColor): boolean {
    const i = this.index(x, y);
    if (i < 0) return false;
    const bit = WIRE_BIT[color];
    if ((this.wireBits[i] & bit) === 0) return false;
    this.wireBits[i] &= ~bit & 0xff;
    this.liveBits[i] &= ~bit & 0xff;
    /* 从上一帧通电清单里摘掉,避免重复清零 */
    const live = this.liveCells.get(color);
    if (live) {
      const at = live.indexOf(i);
      if (at >= 0) live.splice(at, 1);
    }
    this.structuralDirty.add(color);
    return true;
  }

  wireAt(x: number, y: number, color: WireColor): boolean {
    const i = this.index(x, y);
    return i >= 0 && (this.wireBits[i] & WIRE_BIT[color]) !== 0;
  }

  liveAt(x: number, y: number, color: WireColor): boolean {
    const i = this.index(x, y);
    return i >= 0 && (this.liveBits[i] & WIRE_BIT[color]) !== 0;
  }

  /**
   * 组件端口读取半径。
   *
   * 组件在世界上占 **3×3 格**(中心 ±1),线路端口开在占位框**外侧一圈**,
   * 因此中心到最近端口恰好是 2 格 → 读取半径必须为 2(5×5 邻域)。
   * 半径 1 会让「线接通了但组件读不到」,是实测踩到的坑(见文档 §7)。
   */
  static readonly READ_RADIUS = 2;

  /**
   * 该格指定色的 (2r+1)×(2r+1) 邻域是否**通电**(逻辑件输入读取的统一入口)。
   * r = READ_RADIUS = 2。
   */
  readAround(x: number, y: number, color: WireColor): boolean {
    const bit = WIRE_BIT[color];
    const r = SignalGraph.READ_RADIUS;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const i = this.index(x + dx, y + dy);
        if (i >= 0 && (this.liveBits[i] & bit) !== 0) return true;
      }
    }
    return false;
  }

  /** 该格指定色的 5×5 邻域是否有线(用于「线接反了」提示),半径与读取一致。 */
  hasWireAround(x: number, y: number, color: WireColor): boolean {
    const bit = WIRE_BIT[color];
    const r = SignalGraph.READ_RADIUS;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const i = this.index(x + dx, y + dy);
        if (i >= 0 && (this.wireBits[i] & bit) !== 0) return true;
      }
    }
    return false;
  }

  /* ── 组件 ── */

  addComponent(node: ComponentNode): ComponentNode {
    this.components.set(node.id, node);
    return node;
  }

  removeComponent(id: string): boolean {
    return this.components.delete(id);
  }

  get(id: string): ComponentNode | undefined {
    return this.components.get(id);
  }

  /** 直驱:把某格标记为被驱动(传感器/调试用),立即影响下一帧泛洪。 */
  drive(x: number, y: number, color: WireColor, on: boolean): void {
    const i = this.index(x, y);
    if (i < 0) return;
    this.applyDrive(i, color, on);
  }

  private applyDrive(i: number, color: WireColor, on: boolean): void {
    const bit = WIRE_BIT[color];
    const before = this.driveBits[i] & bit;
    if (on) this.driveBits[i] |= bit;
    else this.driveBits[i] &= ~bit & 0xff;
    if ((this.driveBits[i] & bit) !== before) {
      this.driveDirty.add(color);
      this.driveDirtyCells.add(i);
      const set = this.driveCellsByColor.get(color);
      if (set) {
        if (on) set.add(i);
        else set.delete(i);
      }
    }
  }

  /* ── 频道 ── */

  /**
   * 直接写频道态(拉杆直控 / 测试注入 / 调试台)。
   * 写入 `channelManual`,与组件广播态取「或」,组件帧循环不会把它冲掉。
   */
  setChannel(ch: number, on: boolean): void {
    const c = Math.max(1, Math.min(8, ch | 0));
    if ((this.channelManual.get(c) ?? false) !== on) this.channelManual.set(c, on);
  }

  /** 读频道:手动态 ∪ 组件广播态。越界频道一律 false。 */
  getChannel(ch: number): boolean {
    const raw = ch | 0;
    if (raw < 1 || raw > 8) return false;
    return (this.channelManual.get(raw) ?? false) || (this.channelBroadcast.get(raw) ?? false);
  }

  /** 组件发射器写入本帧广播(OR 语义)。 */
  private addChannelInput(ch: number, on: boolean): void {
    const c = Math.max(1, Math.min(8, ch | 0));
    if (on) this.channelInput.set(c, true);
    else if (!this.channelInput.has(c)) this.channelInput.set(c, false);
  }

  /** 帧末把本帧累积的广播提升为正式广播态。 */
  private commitChannelInput(): void {
    if (this.channelInput.size === 0) return;
    for (const [c, v] of this.channelInput) this.channelBroadcast.set(c, v);
    this.channelInput.clear();
  }

  /* ── 泛洪 ── */

  /**
   * 全量重算一个颜色平面。
   *
   * **不用 O(W·H) 清零整平面**:只清上一帧该色实际通电过的那批格
   * (`liveCells[color]`),再从「全部被驱动且该色有线」的格出发重泛洪。
   * 于是代价 = O(上一帧通电格 + 被驱动格 + 本帧新泛洪格),
   * 与 512×512 的世界面积无关 —— 这是「2 万线格世界」能跑进 2Hz 的关键。
   */
  private refloodColorFull(color: WireColor): number {
    const bit = WIRE_BIT[color];
    let scanned = 0;

    /* ① 精确清空上一帧的通电格 */
    const prev = this.liveCells.get(color) ?? [];
    for (const i of prev) {
      this.liveBits[i] &= ~bit & 0xff;
      scanned += 1;
    }

    /* ② 种子:被驱动格的 READ_RADIUS 邻域内、该色有线的格
       (组件输出写在中心格,线开在端口圈上,中心到端口 = READ_RADIUS 格) */
    const r = SignalGraph.READ_RADIUS;
    const queue: number[] = [];
    for (const di of this.driveCellsOf(color)) {
      scanned += 1;
      const dx0 = di % this.width;
      const dy0 = (di - dx0) / this.width;
      for (let dy = -r; dy <= r; dy += 1) {
        const ny = dy0 + dy;
        if (ny < 0 || ny >= this.height) continue;
        for (let dx = -r; dx <= r; dx += 1) {
          const nx = dx0 + dx;
          if (nx < 0 || nx >= this.width) continue;
          const i = ny * this.width + nx;
          if ((this.wireBits[i] & bit) === 0) continue;
          if ((this.liveBits[i] & bit) !== 0) continue;
          this.liveBits[i] |= bit;
          queue.push(i);
        }
      }
    }

    /* ③ 沿同色线泛洪 */
    const live: number[] = [];
    let head = 0;
    while (head < queue.length) {
      const i = queue[head];
      head += 1;
      live.push(i);
      const cx = i % this.width;
      const cy = (i - cx) / this.width;
      for (let d = 0; d < 4; d += 1) {
        const nx = cx + DC_DX[d];
        const ny = cy + DC_DY[d];
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        const ni = ny * this.width + nx;
        if ((this.wireBits[ni] & bit) === 0) continue;
        if ((this.liveBits[ni] & bit) !== 0) continue;
        this.liveBits[ni] |= bit;
        queue.push(ni);
      }
    }
    this.liveCells.set(color, live);
    return live.length + scanned;
  }

  /** 该色全部被驱动的格索引(维持增量集合,避免全平面扫描)。 */
  private driveCellsOf(color: WireColor): number[] {
    const set = this.driveCellsByColor.get(color);
    return set ? [...set] : [];
  }

  /** 只重算包含指定格的那个连通分量。返回访问格数。 */
  private refloodComponent(color: WireColor, seedIndex: number): number {
    const bit = WIRE_BIT[color];
    /* 1. 收集该分量全部格 */
    const comp: number[] = [];
    const seen = new Set<number>();
    const stack: number[] = [];
    const sx = seedIndex % this.width;
    const sy = (seedIndex - sx) / this.width;
    /* 种子可能本身不是线格(驱动格),先把 READ_RADIUS 邻域内的同色线格入栈 */
    const r = SignalGraph.READ_RADIUS;
    if ((this.wireBits[seedIndex] & bit) !== 0) stack.push(seedIndex);
    for (let dy = -r; dy <= r; dy += 1) {
      const ny = sy + dy;
      if (ny < 0 || ny >= this.height) continue;
      for (let dx = -r; dx <= r; dx += 1) {
        const nx = sx + dx;
        if (nx < 0 || nx >= this.width) continue;
        const ni = ny * this.width + nx;
        if ((this.wireBits[ni] & bit) !== 0) stack.push(ni);
      }
    }
    while (stack.length > 0) {
      const i = stack.pop() as number;
      if (seen.has(i)) continue;
      seen.add(i);
      comp.push(i);
      const cx = i % this.width;
      const cy = (i - cx) / this.width;
      for (let d = 0; d < 4; d += 1) {
        const nx = cx + DC_DX[d];
        const ny = cy + DC_DY[d];
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        const ni = ny * this.width + nx;
        if ((this.wireBits[ni] & bit) === 0 || seen.has(ni)) continue;
        stack.push(ni);
      }
    }
    if (comp.length === 0) return 0;

    /* 2. 清空该分量的通电位 */
    for (const i of comp) this.liveBits[i] &= ~bit & 0xff;

    /* 3. 重新泛洪分量。
       驱动源可能是**分量外的组件中心格**(组件输出写在中心,端口圈半径 2),
       因此必须按 READ_RADIUS 找种子 —— 只用 ±1 会漏掉「组件距线 2 格」这一
       最主流的接法,表现为「线通电了但整条线不亮」。 */
    const queue: number[] = [];
    const localSeen = new Set<number>();
    const pushCell = (i: number): void => {
      if (localSeen.has(i)) return;
      if ((this.wireBits[i] & bit) === 0) return;
      localSeen.add(i);
      this.liveBits[i] |= bit;
      queue.push(i);
    };
    /* ① 分量内被驱动的格 */
    for (const i of comp) {
      if ((this.driveBits[i] & bit) !== 0) pushCell(i);
    }
    /* ② 分量外的驱动格:在其 READ_RADIUS 邻域内找本分量的格作种子 */
    const rr = SignalGraph.READ_RADIUS;
    for (const di of this.driveCellsOf(color)) {
      const dx0 = di % this.width;
      const dy0 = (di - dx0) / this.width;
      for (let dy = -rr; dy <= rr; dy += 1) {
        const ny = dy0 + dy;
        if (ny < 0 || ny >= this.height) continue;
        for (let dx = -rr; dx <= rr; dx += 1) {
          const nx = dx0 + dx;
          if (nx < 0 || nx >= this.width) continue;
          const ni = ny * this.width + nx;
          if (seen.has(ni)) pushCell(ni);
        }
      }
    }

    let head = 0;
    let visited = 0;
    while (head < queue.length) {
      const i = queue[head];
      head += 1;
      visited += 1;
      const cx = i % this.width;
      const cy = (i - cx) / this.width;
      for (let d = 0; d < 4; d += 1) {
        const nx = cx + DC_DX[d];
        const ny = cy + DC_DY[d];
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        const ni = ny * this.width + nx;
        if (!seen.has(ni)) continue;
        if ((this.wireBits[ni] & bit) === 0) continue;
        if ((this.liveBits[ni] & bit) !== 0) continue;
        this.liveBits[ni] |= bit;
        queue.push(ni);
      }
    }
    /* 统计口径与全量一致:返回本分量被触碰的**格数**(清零 + 重泛洪同一批格,
       按去重后的格数计,避免与全量口径不可比)。 */
    return comp.length;
  }

  /* ── 主推进 ── */

  /**
   * 推进一帧(2Hz)。
   * 阶段:① 提交到期输出 → ② 重算脏颜色网络 → ③ 评估全部逻辑件。
   * 复杂度:O(脏分量格数 + 逻辑件数),全量模式下为 O(四色线格总数 + 逻辑件数)。
   */
  tick(): PropagateStats {
    this.tickCount += 1;
    const now = this.tickCount;
    let cellsFlooded = 0;
    let cellsScanned = 0;
    let colorsFlooded = 0;
    let mode: PropagateMode = PropagateMode.IDLE;

    /* ① 提交到期输出 */
    for (const comp of this.components.values()) {
      if (comp.pending.length === 0) continue;
      const keep: PendingWrite[] = [];
      for (const w of comp.pending) {
        if (w.tick <= now) {
          const target = w.cell >= 0 ? w.cell : comp.y * this.width + comp.x;
          if (w.color >= 0) this.applyDrive(target, w.color, w.on);
        } else {
          keep.push(w);
        }
      }
      comp.pending = keep;
    }
    for (const [ch, list] of this.channelPending) {
      const keep: PendingWrite[] = [];
      for (const w of list) {
        if (w.tick <= now) this.setChannel(ch, w.on);
        else keep.push(w);
      }
      if (keep.length > 0) this.channelPending.set(ch, keep);
      else this.channelPending.delete(ch);
    }

    /* ② 泛洪:结构变化 → 全量；仅驱动变化 → 只重算受影响分量 */
    if (this.structuralDirty.size > 0) {
      for (const c of this.structuralDirty) {
        const n = this.refloodColorFull(c as WireColor);
        cellsFlooded += n;
        cellsScanned += n;
        colorsFlooded += 1;
      }
      this.structuralDirty.clear();
      this.driveDirty.clear();
      this.driveDirtyCells.clear();
      mode = PropagateMode.FULL;
    } else if (!this.dirtyOptimization) {
      for (const c of ALL_COLORS) {
        const n = this.refloodColorFull(c);
        cellsFlooded += n;
        cellsScanned += n;
        colorsFlooded += 1;
      }
      this.driveDirty.clear();
      this.driveDirtyCells.clear();
      mode = PropagateMode.FULL;
    } else if (this.driveDirty.size > 0 && this.driveDirtyCells.size > 0) {
      const handled = new Set<string>();
      for (const raw of this.driveDirtyCells) {
        for (const c of this.driveDirty) {
          const color = c as WireColor;
          const key = `${color}@${raw}`;
          if (handled.has(key)) continue;
          handled.add(key);
          const n = this.refloodComponent(color, raw);
          cellsFlooded += n;
          cellsScanned += n;
          if (n > 0) colorsFlooded += 1;
        }
      }
      this.driveDirty.clear();
      this.driveDirtyCells.clear();
      mode = PropagateMode.DIRTY_ONLY;
    } else if (this.driveDirty.size > 0) {
      for (const c of this.driveDirty) {
        const n = this.refloodColorFull(c as WireColor);
        cellsFlooded += n;
        cellsScanned += n;
        colorsFlooded += 1;
      }
      this.driveDirty.clear();
      this.driveDirtyCells.clear();
      mode = PropagateMode.DIRTY_ONLY;
    } else {
      this.driveDirty.clear();
      this.driveDirtyCells.clear();
      mode = PropagateMode.IDLE;
    }

    /* ③ 评估逻辑件 */
    let evaluated = 0;
    for (const comp of this.components.values()) {
      const fn = REGISTRY.get(comp.kind);
      if (!fn) continue;
      evaluated += 1;
      const ctx = this.makeContext(comp, now);
      fn(ctx);
    }

    /* ④ 帧末提交无线广播(OR 语义) */
    this.commitChannelInput();

    this.stats = { cellsFlooded, cellsScanned, colorsFlooded, mode, componentsEvaluated: evaluated };
    this.totalCellsFlooded += cellsFlooded;
    this.totalTicks += 1;
    return this.stats;
  }

  /** 连推 n 帧。 */
  run(ticks: number): PropagateStats {
    let last = this.stats;
    for (let i = 0; i < Math.max(0, ticks); i += 1) last = this.tick();
    return last;
  }

  /** 连推直到某条件成立或达到上限;返回实际帧数。 */
  runUntil(pred: (g: SignalGraph) => boolean, maxTicks = 64): number {
    for (let i = 0; i < maxTicks; i += 1) {
      if (pred(this)) return i;
      this.tick();
    }
    return pred(this) ? maxTicks : -1;
  }

  private makeContext(comp: ComponentNode, tick: number): ComponentContext {
    const graph = this;
    return {
      graph,
      comp,
      tick,
      readWire(color: WireColor): boolean {
        return graph.readAround(comp.x, comp.y, color);
      },
      readChannel(ch: number): boolean {
        return graph.getChannel(ch);
      },
      writeChannel(ch: number, on: boolean): void {
        graph.addChannelInput(ch, on);
      },
      write(color: WireColor, on: boolean): void {
        if (comp.outputs.length > 0 && !comp.outputs.includes(color)) return;
        const key = `${color}:0`;
        if (comp.lastOut[key] === (on ? 1 : 0)) return;
        comp.lastOut[key] = on ? 1 : 0;
        comp.pending.push({ tick: tick + comp.latencyTicks, color, on, cell: -1 });
      },
      writeNow(color: WireColor, on: boolean): void {
        if (comp.outputs.length > 0 && !comp.outputs.includes(color)) return;
        graph.applyDrive(comp.y * graph.width + comp.x, color, on);
      },
      writeAt(dx: number, dy: number, color: WireColor, on: boolean): void {
        const key = `${color}:${dx},${dy}`;
        if (comp.lastOut[key] === (on ? 1 : 0)) return;
        comp.lastOut[key] = on ? 1 : 0;
        comp.pending.push({ tick: tick + comp.latencyTicks, color, on, cell: graph.index(comp.x + dx, comp.y + dy) });
      },
      readAt(dx: number, dy: number, color: WireColor): boolean {
        return graph.liveAt(comp.x + dx, comp.y + dy, color);
      },
      st(key: string): number {
        return comp.state[key] ?? 0;
      },
      setSt(key: string, v: number): void {
        comp.state[key] = v;
      },
      param(key: string): number {
        return comp.params[key] ?? 0;
      },
      race: this.race,
    };
  }

  /* ── 统计与诊断 ── */

  /** 某色的连通分量清单(格数与是否有驱动)。 */
  networksOf(color: WireColor): { size: number; driven: boolean; cells: number[] }[] {
    const bit = WIRE_BIT[color];
    const n = this.wireBits.length;
    const seen = new Uint8Array(n);
    const out: { size: number; driven: boolean; cells: number[] }[] = [];
    for (let s = 0; s < n; s += 1) {
      if (seen[s] !== 0 || (this.wireBits[s] & bit) === 0) continue;
      const cells: number[] = [];
      const stack: number[] = [s];
      seen[s] = 1;
      let driven = false;
      while (stack.length > 0) {
        const i = stack.pop() as number;
        cells.push(i);
        if ((this.driveBits[i] & bit) !== 0) driven = true;
        const cx = i % this.width;
        const cy = (i - cx) / this.width;
        for (let d = 0; d < 4; d += 1) {
          const nx = cx + DC_DX[d];
          const ny = cy + DC_DY[d];
          if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
          const ni = ny * this.width + nx;
          if (seen[ni] !== 0 || (this.wireBits[ni] & bit) === 0) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      out.push({ size: cells.length, driven, cells });
    }
    return out;
  }

  /**
   * 全部颜色的**色·格**总数(一条红线格记 1,同一格叠四色记 4)。
   * 按位 popcount,不是「非零格数」——单色测试下两者恰好相等,多色才区分。
   */
  totalWireCells(): number {
    let n = 0;
    for (let i = 0; i < this.wireBits.length; i += 1) {
      let b = this.wireBits[i];
      while (b !== 0) {
        n += b & 1;
        b >>= 1;
      }
    }
    return n;
  }

  /** 全部颜色的**通电色·格**总数(按位 popcount)。 */
  totalLiveCells(): number {
    let n = 0;
    for (let i = 0; i < this.liveBits.length; i += 1) {
      let b = this.liveBits[i];
      while (b !== 0) {
        n += b & 1;
        b >>= 1;
      }
    }
    return n;
  }

  /** 至少有一色线的格数(「非零格」口径,用于渲染统计)。 */
  wiredCellCount(): number {
    let n = 0;
    for (let i = 0; i < this.wireBits.length; i += 1) if (this.wireBits[i] !== 0) n += 1;
    return n;
  }

  /** 强制下一帧全量重算。 */
  markAllDirty(): void {
    for (const c of ALL_COLORS) this.structuralDirty.add(c);
  }
}

const DC_DX: readonly number[] = [0, 1, 0, -1];
const DC_DY: readonly number[] = [-1, 0, 1, 0];

/* ─────────────────── 建图辅助 ─────────────────── */

/** 铺一条水平线段(含两端)。 */
export function layHorizontal(g: SignalGridLike, x0: number, x1: number, y: number, color: WireColor): number {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  let n = 0;
  for (let x = lo; x <= hi; x += 1) if (g.addWire(x, y, color)) n += 1;
  return n;
}

/** 铺一条垂直线段(含两端)。 */
export function layVertical(g: SignalGridLike, x: number, y0: number, y1: number, color: WireColor): number {
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  let n = 0;
  for (let y = lo; y <= hi; y += 1) if (g.addWire(x, y, color)) n += 1;
  return n;
}

export interface SignalGridLike {
  addWire(x: number, y: number, color: WireColor): boolean;
}

/* ─────────────────── 性能估算工具 ─────────────────── */

export interface AdvanceCostEstimate {
  /** 世界边长 */
  worldSize: number;
  /** 电线格总数 */
  wireCells: number;
  /** 逻辑件总数 */
  components: number;
  /** 假设的单格泛洪成本(纳秒) */
  nsPerCell: number;
  /** 假设的单件评估成本(纳秒) */
  nsPerComponent: number;
  /** 全量模式下实际触碰的格数(通电格 + 清零格) */
  fullCells: number;
  /** 脏模式下单个受影响分量的平均格数 */
  dirtyComponentCells: number;
  /** 脏模式下需要重估的组件数(默认取 ceil(components/20)) */
  dirtyComponents: number;
  /** 全量推进单帧估算微秒 */
  fullFrameUs: number;
  /** 脏网络推进单帧估算微秒(假设只有 1 个驱动源、脏分量平均 40 格) */
  dirtyFrameUs: number;
  /** 收益倍数 */
  speedup: number;
  /** 2Hz 慢 tick 的单帧 CPU 预算(微秒),= 1/SLOW_TICK_HZ × 1e6 = 500000µs */
  frameBudgetUs: number;
  /** 全量推进占 2Hz 单帧预算的比例(分母是 500000µs,不是 60fps 帧) */
  budgetRatioFull: number;
  /** 脏网络推进占 2Hz 单帧预算的比例 */
  budgetRatioDirty: number;
}

/**
 * 512×512 世界 / 2 万电线格场景的单次 2Hz 推进耗时估算。
 *
 * 假设(见文档 §6 参数表):
 *  - 单格清零/入队成本 12ns(Uint8Array 命中 + 4 邻索引计算,Node 24 V8 实测量级);
 *  - 单件评估成本 120ns(含一次对象属性查找与若干算术);
 *  - **实现已消除 O(W·H) 整平面清零**:全量只清「上一帧通电格」+ 重泛洪,
 *    故 `fullCells ≈ wireCells × 1.25`(通电 + 清零各一次);
 *  - 脏模式下一次驱动变化只重算 1 个平均 40 格的分量,组件也只重估受影响的那批。
 *
 * `frameBudgetUs` 的分母是 **2Hz 慢 tick 的一帧**(`1/SLOW_TICK_HZ` 秒 = 500000µs)。
 * 早期版本误用了「60fps 帧的 5%」= 830µs,导致 348µs 的被报成 41.9% 占用 ——
 * 语义应当是「相对本模块真正运行的那个 tick 频率」。
 */
export function estimateAdvanceCost(
  worldSize = 512,
  wireCells = 20000,
  components = 400,
): AdvanceCostEstimate {
  const nsPerCell = 12;
  const nsPerComponent = 120;
  const dirtyComponentCells = 40;
  const dirtyComponents = Math.max(1, Math.ceil(components / 20));
  const fullCells = Math.round(wireCells * 1.25);
  const fullNs = fullCells * nsPerCell + components * nsPerComponent;
  const dirtyNs = dirtyComponentCells * nsPerCell + dirtyComponents * nsPerComponent;
  const fullFrameUs = fullNs / 1000;
  const dirtyFrameUs = dirtyNs / 1000;
  const frameBudgetUs = (1 / TICKS_PER_SECOND) * 1e6;
  return {
    worldSize,
    wireCells,
    components,
    nsPerCell,
    nsPerComponent,
    fullCells,
    dirtyComponentCells,
    dirtyComponents,
    fullFrameUs,
    dirtyFrameUs,
    speedup: dirtyFrameUs === 0 ? 0 : fullFrameUs / dirtyFrameUs,
    frameBudgetUs,
    budgetRatioFull: fullFrameUs / frameBudgetUs,
    budgetRatioDirty: dirtyFrameUs / frameBudgetUs,
  };
}