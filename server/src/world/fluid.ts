/**
 * WS-01 · 水体 / 熔岩 / 粘液 元胞自动机(2Hz)+ 相变。
 *
 * 设计要点(守恒优先):
 *  1. 水量用**整数**「毫格」(1 满格 = 1000 毫格)存 Int32Array。所有输运都是
 *     「A 减 x / B 加 x」的纯转移,不做乘除缩放,因此总水量**逐帧精确守恒**
 *     (误差恒为 0,远优于 1% 的验收线)。
 *  2. 通量按「有向边」只算一次(A→右邻、A→下邻),天然避免同一 tick 内来回搬家,
 *     且结果与遍历顺序无关 → 可复现、可对拍。
 *  3. 流向由**水面高度**决定:水面高的一侧流向低的一侧。水面 =
 *     `elev × (CAP+1) + amount`,海拔以 `CAP+1` 为一级台阶,于是「先向低处流」
 *     严格优先于「同海拔铺平」—— 这就是「重力优先」的实际表达,
 *     **不需要**单独区分水平边与竖直边(早先有个 `vertical` 死形参,已删)。
 *     同海拔时按水量差的一半扩散(避免过冲震荡)。
 *     整帧处理格数被 `FLUID_CELL_BUDGET` 截断,**活跃格优先 + 游标补齐**:
 *     有水的边缘总是先被推进,静止的水由游标兜底。
 *     这解决了纯轮询的致命问题 —— 水的扩散速度会随世界面积急剧变慢
 *     (实测 128×128 铺 25 行需 2268 秒,而 64×64 只要 39 秒)。见 `fluxPass`。
 *  4. 相变(水+熔岩→黑曜石 110 / 温泉+熔岩→多孔浮石 111)是**唯一**会销毁水的
 *     出口,单独记入 `consumedByPhase`,使 `total + consumedByPhase` 仍然守恒。
 */

import { BaseFluid, Elevation } from '../../../shared/types/tile.ts';
import { SLOW_DT } from '../../../shared/types/physics.ts';

/* ═══════════════════════ 1. 常量与配表 ═══════════════════════ */

/** 1 格充满 = 1000 毫格。整数域保证守恒。 */
export const CAP = 1000;

/** 相变所需最小水量(毫格):一滴水不足以浇灭熔岩。 */
export const PHASE_MIN_AMOUNT = 50;

/** 黑曜石 / 多孔浮石 的物品 ID(取自 shared/constants/items.ts 原文)。 */
export const OBSIDIAN_ID = 110;
export const PUMICE_ID = 111;

/** 单帧最多处理的格数上界。推导见 docs/WS-01-terrain.md §6。 */
export const FLUID_CELL_BUDGET = 1024;

export const FluidKind = {
  NONE: 'NONE',
  WATER: 'WATER',
  HOT_SPRING: 'HOT_SPRING',
  SLIME: 'SLIME',
  LAVA: 'LAVA',
} as const;
export type FluidKind = (typeof FluidKind)[keyof typeof FluidKind];

/** 基底层 ID → 流体种类。 */
export function fluidKindOfBase(base: number): FluidKind {
  switch (base) {
    case BaseFluid.SHALLOW_WATER: return FluidKind.WATER;
    case BaseFluid.HOT_SPRING: return FluidKind.HOT_SPRING;
    case BaseFluid.SLIME: return FluidKind.SLIME;
    case BaseFluid.LAVA: return FluidKind.LAVA;
    default: return FluidKind.NONE;
  }
}

/** 基底层 ID ← 流体种类。 */
export function baseOfFluidKind(kind: FluidKind): number {
  switch (kind) {
    case FluidKind.WATER: return BaseFluid.SHALLOW_WATER;
    case FluidKind.HOT_SPRING: return BaseFluid.HOT_SPRING;
    case FluidKind.SLIME: return BaseFluid.SLIME;
    case FluidKind.LAVA: return BaseFluid.LAVA;
    default: return BaseFluid.VOID;
  }
}

/**
 * 水平通量系数(粘度倒数)。熔岩厚重 → 0.5;粘液介于之间;温泉水几乎等同清水。
 * 出处:手册 §5 「流体粘度分级」;粘液取 0.35 以匹配 315/322 的滑腻手感。
 */
export const VISCOSITY_FLOW: Readonly<Record<FluidKind, number>> = {
  NONE: 0,
  WATER: 1.0,
  HOT_SPRING: 1.0,
  SLIME: 0.35,
  LAVA: 0.5,
};

/* ═══════════════════════ 2. 单元与统计 ═══════════════════════ */

export interface FluidCellInit {
  amount?: number;
  base?: number;
  /** 实心地形(不可流入),如黑曜石、墙体 */
  solid?: boolean;
  /** 局部海拔 0..3,水只能往低处或同级走 */
  elev?: number;
}

export interface FluidStepReport {
  /**
   * 本帧**访问**的格数(遍历额度用量)。
   *
   * **这个名字有误导性,读的人容易当成「有水的格数」。** 实测:全干世界的
   * `step()` 也报 `processed = 1024`,而 `moved = 0`。
   *
   * 保留旧名是为了不破坏既有断言与外部上报(WS-01 有四条断言锁定
   * `processed === 256 / 1024`,它们锁的是「预算被正确执行」这件事,
   * 与「处理了多少水」无关 —— 那由新字段 `moved` / `active` 表达)。
   * **新代码请读 `visited` / `active` / `moved`,不要读 `processed`。**
   */
  processed: number;
  /** 本帧访问的格数 —— 与 `processed` 同值,只是名字诚实。 */
  visited: number;
  /**
   * 本帧**真正参与通量计算**的格数(有水的、或有水邻居的)。
   *
   * 这是判断「流体是否在工作」的正确指标:`visited` 会随预算恒为 1024,
   * 而 `active` 为 0 表示世界是干的(或者活跃追踪坏了)。
   */
  active: number;
  /** 本帧转移的总毫格(单边计一次) */
  moved: number;
  /** 本帧相变次数 */
  phaseChanges: number;
  /** 本帧因相变销毁的**水量**(毫格) */
  consumedByPhase: number;
  /** 本帧因相变销毁的**熔岩量**(毫格) */
  consumedLava: number;
  /** 是否因为预算耗尽而截断 */
  truncated: boolean;
}

/* ═══════════════════════ 3. FluidField ═══════════════════════ */

export class FluidField {
  readonly width: number;
  readonly height: number;

  /** 水量(毫格),0..CAP */
  readonly amount: Int32Array;
  /** 基底层 ID,决定流体种类 */
  readonly base: Uint8Array;
  /** 1 = 实心不可流入 */
  readonly solid: Uint8Array;
  /** 局部海拔 0..3 */
  readonly elev: Uint8Array;

  private cursor: number;
  /**
   * 活跃格:**轮转数组** + 位置索引。
   *
   * **不能用 `Set`**。`Set` 按插入顺序遍历,而本帧 `limit` 是有限的:
   * 当活跃格数超过 `limit` 时,排在后面的格**永远轮不到**。
   * 实测后果很干净也很致命 —— 水跑到平衡后活跃集合有 1160 格,
   * 此后在空地注入 500 毫格新水,`moved` 恒为 0、水**原地不动**:
   * 新格插在 1160 个老格之后,`done >= limit` 已成立。这是**停顿**,不是平衡。
   *
   * 改成数组 + 游标后,每一格都在 `ceil(size/limit)` 帧内被轮到,
   * 与它何时被插入无关。
   *
   * **这是缓存,不是真相** —— `amount` 永远是唯一真相。缓存漏了某格,
   * 后果只是它这一帧不流动(游标会补上),不会算错。
   */
  private readonly activeArr: number[] = [];
  /** 格索引 → 在 `activeArr` 中的位置(用于 O(1) 去重与摘除)。 */
  private readonly activeIdx = new Map<number, number>();
  /** `activeArr` 的轮转游标。 */
  private activeCursor = 0;
  /**
   * 通量暂存缓冲,**跨帧复用**。
   *
   * 早先每帧 `new Int32Array(n)`:1024×1024 世界是 **4MB/帧**,
   * 2Hz 下每秒 8MB 垃圾 —— 而其中 99% 的位置恒为 0。
   * 复用后靠「落账时把用过的位置清零」保持正确,不依赖 GC。
   */
  private readonly deltaBuf: Int32Array;
  /** 相变累计销毁**水量**,跨帧累计 */
  totalConsumedByPhase: number;
  /** 相变累计销毁**熔岩量**,跨帧累计 */
  totalConsumedLava: number;
  /** 相变事件表(测试与日志用),最多保留 256 条 */
  readonly events: { x: number; y: number; kind: string }[];

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`FluidField 尺寸非法:${width}×${height}`);
    }
    this.width = width;
    this.height = height;
    const n = width * height;
    this.amount = new Int32Array(n);
    this.deltaBuf = new Int32Array(n);
    this.base = new Uint8Array(n);
    this.solid = new Uint8Array(n);
    this.elev = new Uint8Array(n);
    this.cursor = 0;
    this.totalConsumedByPhase = 0;
    this.totalConsumedLava = 0;
    this.events = [];
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  /**
   * 把一格及其四邻标为活跃 —— 新注入/被改动的水**下一帧立即被推进**。
   *
   * 标四邻而不只标本格:水的传播是**沿边**的(`fluxEdge` 处理右邻与下邻),
   * 只标本格的话,它右侧与下方的格不在活跃集合里,水的第一跳仍要等轮询。
   */
  markActive(i: number): void {
    const n = this.amount.length;
    if (i < 0 || i >= n) return;
    const x = i % this.width;
    const y = (i - x) / this.width;
    this.pushActive(i);
    if (x + 1 < this.width) this.pushActive(i + 1);
    if (x > 0) this.pushActive(i - 1);
    if (y + 1 < this.height) this.pushActive(i + this.width);
    if (y > 0) this.pushActive(i - this.width);
  }

  /** 把一个格加入活跃集合(已存在则跳过)。 */
  private pushActive(i: number): void {
    if (this.activeIdx.has(i)) return;
    this.activeIdx.set(i, this.activeArr.length);
    this.activeArr.push(i);
  }

  /** 从活跃集合摘除一格(O(1):与末尾交换后 pop)。 */
  private dropActive(i: number): void {
    const at = this.activeIdx.get(i);
    if (at === undefined) return;
    const last = this.activeArr.length - 1;
    const lastVal = this.activeArr[last];
    this.activeArr[at] = lastVal;
    this.activeIdx.set(lastVal, at);
    this.activeArr.pop();
    this.activeIdx.delete(i);
  }

  /** 活跃格数量(仅供观测/测试,不参与逻辑)。 */
  get activeCount(): number {
    return this.activeArr.length;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  kindAt(x: number, y: number): FluidKind {
    if (!this.inBounds(x, y)) return FluidKind.NONE;
    return fluidKindOfBase(this.base[this.index(x, y)]);
  }

  amountAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.amount[this.index(x, y)];
  }

  setCell(x: number, y: number, init: FluidCellInit): void {
    if (!this.inBounds(x, y)) throw new RangeError(`FluidField.setCell 越界:(${x}, ${y})`);
    const i = this.index(x, y);
    if (init.base !== undefined) this.base[i] = init.base & 0xff;
    if (init.solid !== undefined) this.solid[i] = init.solid ? 1 : 0;
    if (init.elev !== undefined) this.elev[i] = init.elev & 0x3;
    if (init.amount !== undefined) { this.amount[i] = clampAmount(init.amount); this.markActive(i); }
  }

  /** 注入水量,超出容量部分丢弃并返回实际注入量。 */
  addWater(x: number, y: number, units: number, base = BaseFluid.SHALLOW_WATER): number {
    if (!this.inBounds(x, y)) return 0;
    const i = this.index(x, y);
    if (this.solid[i] === 1) return 0;
    if (this.base[i] === BaseFluid.VOID) this.base[i] = base & 0xff;
    const room = CAP - this.amount[i];
    const put = Math.max(0, Math.min(room, Math.floor(units)));
    this.amount[i] += put;
    if (put > 0) this.markActive(i);
    return put;
  }

  /** 全图总水量(毫格)。 */
  total(): number {
    let s = 0;
    for (let i = 0; i < this.amount.length; i += 1) s += this.amount[i];
    return s;
  }

  /** 按流体种类统计总量。 */
  totalsByKind(): Record<FluidKind, number> {
    const out: Record<string, number> = {
      NONE: 0, WATER: 0, HOT_SPRING: 0, SLIME: 0, LAVA: 0,
    };
    for (let i = 0; i < this.amount.length; i += 1) {
      out[fluidKindOfBase(this.base[i])] += this.amount[i];
    }
    return out as Record<FluidKind, number>;
  }

  /** 满格数换算(便于人类阅读)。 */
  totalTiles(): number {
    return this.total() / CAP;
  }

  /* ═══════════════ 4. 单帧推进 ═══════════════ */

  /**
   * 2Hz 推进一帧。`budget` 为本次最多服务多少格(默认 FLUID_CELL_BUDGET)。
   * 返回统计;守恒关系恒为
   *   total_after + Σconsumed = total_before
   */
  step(budget: number = FLUID_CELL_BUDGET): FluidStepReport {
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new RangeError(`FluidField.step 预算非法:${budget}`);
    }
    const report: FluidStepReport = {
      processed: 0, visited: 0, active: 0, moved: 0,
      phaseChanges: 0, consumedByPhase: 0, consumedLava: 0, truncated: false,
    };
    /* 活跃格数必须在**任何写入之前**取样:相变与落账都会改活跃集合。 */
    const activeAtStart = this.activeArr.length;

    /* — 4.1 相变先行:先把接触面凝固,再谈流动 — */
    this.phasePass(report);

    /* — 4.2 通量:每对相邻格只走一次(右邻 + 下邻),流向由 fluxEdge 内部的水面高度决定。
           注意不能只允许「左→右」「上→下」两个方向,否则水永远无法向左/向上扩散。— */
    const delta = this.deltaBuf;
    const n = this.amount.length;
    const limit = Math.min(budget, n);
    const touched = this.fluxPass(limit, delta, report);
    if (n > limit) report.truncated = true;

    /* — 4.3 落账:delta 由成对写入构成,净额恒为 0 —
       
       **只遍历本帧真正被写过的格**(`touched`),不再扫全图。
       原先这里是 `for (let i = 0; i < n; i++)`,即每帧无条件扫描全部格 ——
       512×512 时那是 262144 次读,而 99% 的 `delta[i]` 都是 0。
       实测:空世界的 step 成本几乎与「有没有水」无关(空/有 = 99%),
       说明这份全图扫描就是主要成本。 */
    let net = 0;
    for (const i of touched) {
      const d = delta[i];
      if (d === 0) continue;
      net += d;
      this.amount[i] += d;
      delta[i] = 0;
      /* ── 关键:水**流到哪,哪就活跃** ──
         只在注入时标活跃是不够的:水一旦流出初始区域,新格就不在活跃集合里,
         只能等光标轮询 —— 而光标每隔 `n/budget` 帧才轮到一次,于是
         「水的传播速度与世界面积成反比」这个 bug 依旧存在。
         在落账时按 `delta` 标活跃,让**前沿始终在活跃集合里**,
         于是每帧成本正比于**湿区面积**,而不是世界面积。 */
      this.markActive(i);
    }
    if (net !== 0) {
      /* fluxEdge 的 avail/room 都按 amount+delta 夹过,正常路径下不可能出现净额。
         走到这里说明有未配对写入,直接抛出便于定位,而不是悄悄夹紧破坏守恒。 */
      throw new Error(`流体守恒被破坏:净变化 ${net} 毫格`);
    }

    report.processed = limit;
    report.visited = limit;
    /* `active` 取**本帧开始时的**活跃格数:落账阶段会往里加新格,
       若在这里读会把「水流过的地方」也算进去,数字就不再是「参与流动的格数」。 */
    report.active = activeAtStart;
    return report;
  }

  /**
   * 选出一帧要处理的格并算通量 —— **活跃格优先,其余按游标补齐**。
   *
   * ## 为什么不能只按游标轮询(这是本文件最重要的一处修正)
   *
   * 游标轮询在**大世界**里有致命后果:一格被访问的间隔 = `n / budget` 慢帧。
   *
   * | 世界 | 全图轮询一轮 | 水纵向铺 25 行的实测耗时 |
   * | :--- | ---: | ---: |
   * | 64×64 | 4 慢帧 | 39 秒 |
   * | 128×128 | 16 慢帧 | **2268 秒(38 分钟)** |
   * | 256×256 | 64 慢帧 | 超过 2500 秒(未测到收敛) |
   *
   * 原因是水的**前沿**每帧最多推进 1 行,而前沿所在的那一行要等轮询转到
   * 才被处理 —— 世界越宽,「一帧覆盖的行数」越少(`budget / width`:
   * 64→16 行、128→8 行、512→**2 行**),所以纵向扩散随世界尺寸**急剧变慢**。
   * 表现是「大世界里倒一桶水,水几乎不动」——玩家会认为流体坏了。
   *
   * 注意这**不是** CPU 问题:`512×512` 每步仅 `0.99ms`,只占 500ms 慢帧预算的
   * `0.2%`。所以「调大预算」治不了它 —— 调到 4 倍也只是把 128 秒变 32 秒,
   * 而每帧成本线性上升。真正的瓶颈是**访问顺序**,不是预算大小。
   *
   * ## 做法
   *
   * 维护一份「有水的格 + 其四邻」的活跃集合。每帧**先处理活跃集合**
   * (水的边缘总是立刻被推进),再用游标补齐剩余额度 —— 游标仍在,
   * 所以：
   *   - 静止的水不会漏掉(它已被移出活跃集合,但游标仍会扫到);
   *   - 全湿池的公平性与「4 帧覆盖全图」的既有断言不变(活跃集合 ≈ 全图);
   *   - 全新注入的水**下一帧立即活跃**(`markActive`),不必等轮询。
   *
   * 活跃集合是**缓存**,不是真相:`amount` 永远是唯一真相。
   * 所以即使缓存漏了某格,也只是它这一帧不流动,不会算错 —— 游标会补上。
   */
  private fluxPass(limit: number, delta: Int32Array, report: FluidStepReport): Set<number> {
    const n = this.amount.length;
    /*
     * 必须用**去重集合**。一格会作为三种身份被触及:自己的 `i`、
     * 左/上邻的 `i+1` 与 `i+width`。若用数组直接 push,同一格会进多次,
     * 落账时 `net += d` 就把同一个 `d` 重复累加 —— 于是净额不再是 0,
     * 抛出「流体守恒被破坏」的**误报**(实测:557 毫格)。
     * 守恒本身没坏,坏的是「哪些格被改过」这份名单。
     */
    const touched = new Set<number>();
    const visited = new Set<number>();
    let done = 0;

    const visit = (i: number): void => {
      if (visited.has(i)) return;
      visited.add(i);
      done += 1;
      const x = i % this.width;
      const y = (i - x) / this.width;
      if (this.solid[i] === 1) return;
      touched.add(i);
      /* 右邻:这一条边同时承载「左→右」与「右→左」两种可能 */
      if (x + 1 < this.width) {
        this.fluxEdge(i, i + 1, delta, report);
        touched.add(i + 1);
        /* 右下邻也要收:它可能被「右邻→下邻」这条边改到。
           加它是因为落账只遍历 `touched`,漏了就会**丢账**。
           但**必须同时判 y**,否则最后一行 `i + width ± 1` 会越界 ——
           越界读 `Int32Array` 得 `undefined`,`net += undefined` 就是 NaN。 */
        if (y + 1 < this.height) touched.add(i + this.width + 1);
      }
      /* 下邻:同理,同时承载「上→下」与「下→上」 */
      if (y + 1 < this.height) {
        this.fluxEdge(i, i + this.width, delta, report);
        touched.add(i + this.width);
        if (x > 0) touched.add(i + this.width - 1);
      }
    };

    /* ① 活跃格优先(轮转,保证公平) —— 水的边缘总被尽快推进。
       
       轮转而非「从头遍历」:`activeArr` 会随水流增长到上千格,
       若每帧都从下标 0 开始且 `limit` 有限,排在后面的格永远轮不到 ——
       实测表现:平衡后注入新水,`moved` 恒为 0、水原地不动(停顿,不是平衡)。
       轮转后每格都在 `ceil(size/limit)` 帧内被轮到,与插入时间无关。 */
    const activeSize = this.activeArr.length;
    if (activeSize > 0) {
      let taken = 0;
      while (taken < activeSize && done < limit) {
        const i = this.activeArr[this.activeCursor % this.activeArr.length];
        this.activeCursor += 1;
        taken += 1;
        this.dropActive(i);
        /*
         * **必须重新入队。**
         *
         * 摘除是为了让轮转游标能前进(否则数组头部永远被重复访问);
         * 但「有水的格必须留在活跃集合里」是 `phasePass` 的正确性前提 ——
         * 静态的水若被摘掉,它紧挨熔岩时的相变就**永远不会触发**。
         * 所以摘除后立刻按「是否仍需处理」重新入队:
         *   有水 或 四邻有水 → 入队(下一轮继续参与)
         *   彻底干涸且四邻也干 → 不入队(自然淘汰,集合不会无限增长)
         */
        if (this.amount[i] > 0 || this.neighborHasFluid(i)) this.pushActive(i);
        else continue;
        visit(i);
      }
    }

    /* ② 游标补齐:拿**剩余**额度。
       
       游标按实际消费的格数前进(`k`),不按完整 `limit` ——
       否则活跃格多了光标就跳得更远,形成永不访问的空洞。 */
    let k = 0;
    while (done < limit && k < n) {
      const i = (this.cursor + k) % n;
      k += 1;
      visit(i);
    }
    this.cursor = (this.cursor + k) % n;
    return touched;
  }

  /** 某格四邻是否有流体(用于判断活跃格是否该被摘除)。 */
  private neighborHasFluid(i: number): boolean {
    const x = i % this.width;
    const y = (i - x) / this.width;
    if (x + 1 < this.width && this.amount[i + 1] > 0) return true;
    if (x > 0 && this.amount[i - 1] > 0) return true;
    if (y + 1 < this.height && this.amount[i + this.width] > 0) return true;
    if (y > 0 && this.amount[i - this.width] > 0) return true;
    return false;
  }

  /**
   * 相邻两格 a、b 之间的一条边。**方向由「水面高度」决定,不由索引顺序决定**:
   *   surface(i) = elev[i] * (CAP+1) + amount[i]
   * 水面高的一侧流向水面低的一侧。于是:
   *   - 海拔低的格(深沟 Z-1)天然吸引水 → 引水渠自动汇水;
   *   - 同海拔时水量多的流向水量少的 → 平地自然铺平;
   *   - 每对相邻格只调用一次,不会出现同一对格来回搬运的震荡。
   */
  /**
   * 单条边的通量。`a`/`b` 是**无序**的一对相邻格 —— 流向完全由水面高度决定,
   * 所以**不需要**「水平边 / 竖直边」这个区分。
   *
   * 早先这里有第三个形参 `vertical: boolean`,但它在函数体内**从未被使用**:
   * 竖直边与水平边走的是同一段代码。而文件顶部的设计说明却声称
   * 「向下优先(重力满流量),水平按位势差减半扩散」—— 文档与实现不符。
   *
   * 核查手册(`2_5d_cartoon_sandbox_plan.md` L20)后确认:手册对该层的唯一要求是
   * 「水体与熔岩的元胞自动机流淌扩散」,**没有**规定重力优先或位势分层。
   * 所以删掉死形参,并让文档改口 —— 重力的实际表达是 `elev` 层差
   * (见 `surface()`)。
   */
  private fluxEdge(a: number, b: number, delta: Int32Array, report: FluidStepReport): number {
    if (this.solid[a] === 1 || this.solid[b] === 1) return 0;

    const sa = this.surface(a, delta);
    const sb = this.surface(b, delta);
    /* 水面持平 → 不流。平局不做任何搬运,避免同一条边来回震荡。 */
    if (sa === sb) return 0;

    /* 水面高的那侧是 src */
    const src = sa > sb ? a : b;
    const dst = src === a ? b : a;

    const ks = fluidKindOfBase(this.base[src]);
    if (ks === FluidKind.NONE) return 0;
    const kd = fluidKindOfBase(this.base[dst]);
    /* 目标格为空基或同类流体才可注入;异类流体不混(熔岩/水由相变处理) */
    if (kd !== FluidKind.NONE && kd !== ks) return 0;

    /* 必须按「本帧已排出/已收入」的量结算,否则一格水会被多条出边各流一次 */
    const avail = this.amount[src] + delta[src];
    if (avail <= 0) return 0;
    const room = CAP - (this.amount[dst] + delta[dst]);
    if (room <= 0) return 0;

    const es = this.elev[src];
    const ed = this.elev[dst];

    let f = 0;
    if (es > ed) {
      /* 有落差:整格倾泻 —— 这就是「向下优先」的数学表达
         (由 `elev` 层差产生,与边是水平还是竖直无关) */
      f = Math.min(avail, room);
    } else if (es < ed) {
      return 0;                       /* 目标海拔更高,水流不上去(水位模型下已是死分支,留作护栏) */
    } else {
      /* 同海拔:按水量差扩散,只取一半避免过冲震荡 */
      const diff = (this.amount[src] + delta[src]) - (this.amount[dst] + delta[dst]);
      if (diff <= 0) return 0;
      const mul = VISCOSITY_FLOW[ks];
      f = Math.min(avail, room, Math.floor((diff * mul) / 2));
    }
    if (f <= 0) return 0;
    if (kd === FluidKind.NONE) this.base[dst] = this.base[src];
    delta[src] -= f;
    delta[dst] += f;
    report.moved += f;
    return f;
  }

  /**
   * 水面高度(毫格)。海拔以 `CAP+1` 为一级台阶,保证「永远先向低处流」
   * 严格优先于「同海拔铺平」:高一级的格即使只装 1 毫格,水面也高过下一级的满格。
   * 于是引水渠(挖低成 Z-1)天然形成汇水口,不需要任何特殊分支。
   */
  private surface(i: number, delta: Int32Array): number {
    return this.elev[i] * (CAP + 1) + this.amount[i] + delta[i];
  }

  /* ═══════════════ 5. 相变 ═══════════════ */

  /**
   * 四邻接触判定:
   *   WATER      + LAVA → 黑曜石 110
   *   HOT_SPRING + LAVA → 多孔浮石 111
   *   SLIME      + LAVA → 黑曜石 110(粘液含水,同规则)
   *
   * **记账规则(守恒不变量的全部内容,写在文档 §4 / §7)**
   * 相变同时抹掉两格的存量:水侧的 `amount[i]` 与熔岩侧的 `amount[lavaIdx]`。
   * 两条销毁量**各自入账**,因此下面这条恒等式逐帧精确成立:
   *
   *     total() + totalConsumedByPhase + totalConsumedLava === 初始总量
   *
   * 只记水侧会漏掉熔岩存量,导致「含相变的池子」对不上账——这是首版的实际缺陷。
   * 注意 `total()` 是**所有流体之和**(水+温泉+粘液+熔岩),所以熔岩也要入账。
   */
  private phasePass(report: FluidStepReport): void {
    /*
     * 只扫**活跃格**,不扫全图。
     *
     * 这一处是最后一个 O(世界面积) 的开销:原先 `for (let i = 0; i < n; i++)`
     * 每帧无条件扫全部格,只为找「水 + 熔岩接触面」。
     * 实测 1024×1024 时每步 2.94ms,而这个循环独占约 3ms ——
     * 即整帧成本几乎全是「在干旱区里找一个几乎不存在的接触面」。
     *
     * **正确性依赖一条不变量**:任何 `amount > 0` 的格都留在活跃集合里
     * (见 `compactActive` 的摘除条件)。所以「静止的水紧挨熔岩」也在集合内,
     * 相变不会被漏掉 —— 这正是必须维护该不变量的原因,而不是可选的优化。
     */
    for (const i of this.activeArr) {
      if (i >= this.amount.length) continue; /* compact 前的残余索引,防御性跳过 */
      const kind = fluidKindOfBase(this.base[i]);
      if (kind === FluidKind.NONE || kind === FluidKind.LAVA) continue;
      if (this.amount[i] < PHASE_MIN_AMOUNT) continue;
      const x = i % this.width;
      const y = (i - x) / this.width;

      let lavaIdx = -1;
      if (x + 1 < this.width && fluidKindOfBase(this.base[i + 1]) === FluidKind.LAVA) lavaIdx = i + 1;
      else if (x > 0 && fluidKindOfBase(this.base[i - 1]) === FluidKind.LAVA) lavaIdx = i - 1;
      else if (y + 1 < this.height && fluidKindOfBase(this.base[i + this.width]) === FluidKind.LAVA) lavaIdx = i + this.width;
      else if (y > 0 && fluidKindOfBase(this.base[i - this.width]) === FluidKind.LAVA) lavaIdx = i - this.width;
      if (lavaIdx < 0) continue;

      const product = kind === FluidKind.HOT_SPRING ? PUMICE_ID : OBSIDIAN_ID;

      /* — 水侧销毁 — */
      const lostWater = this.amount[i];
      this.totalConsumedByPhase += lostWater;
      report.consumedByPhase += lostWater;

      /* — 熔岩侧销毁(必须单独入账,否则守恒式不闭合)— */
      const lostLava = this.amount[lavaIdx];
      this.totalConsumedLava += lostLava;
      report.consumedLava += lostLava;

      report.phaseChanges += 1;

      this.amount[i] = 0;
      this.base[i] = BaseFluid.ROCK;
      this.solid[i] = 1;
      /* 相变后该格变实心,活跃集合要更新 —— 它的邻居从「可能有水」变成
         「永远没有」,留着会让活跃集合无谓增长(每帧多一次无用工)。
         标活跃而非直接删:邻居的水还可能流**过来**,只是流不进来。 */
      this.markActive(i);

      this.amount[lavaIdx] = 0;
      this.base[lavaIdx] = BaseFluid.ROCK;
      this.solid[lavaIdx] = 1;
      this.markActive(lavaIdx);
      this.pendingObj.push({ index: i, obj: product });
      this.pendingObj.push({ index: lavaIdx, obj: product });

      if (this.events.length < 256) {
        const lx = lavaIdx % this.width;
        const ly = (lavaIdx - lx) / this.width;
        this.events.push({ x, y, kind: `phase:${product}` });
        this.events.push({ x: lx, y: ly, kind: `phase:${product}` });
      }
    }
  }

  /** 相变产物需要写回 OBJ 层,由宿主在 step 后取走(不污染流体模块)。 */
  readonly pendingObj: { index: number; obj: number }[] = [];

  drainPhaseProducts(): { x: number; y: number; obj: number }[] {
    const out = this.pendingObj.map((p) => {
      const x = p.index % this.width;
      return { x, y: (p.index - x) / this.width, obj: p.obj };
    });
    this.pendingObj.length = 0;
    return out;
  }

  /* ═══════════════ 6. 引水渠 ═══════════════ */

  /**
   * 挖低一格:把它设为 Z-1 空腔,邻格中的同级水会因位势差在下一次 step 汇入。
   * 返回是否真的挖开。
   */
  digCanal(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.index(x, y);
    if (this.elev[i] === Elevation.DEEP) return false;
    this.elev[i] = Elevation.DEEP;
    this.solid[i] = 0;
    if (this.base[i] === BaseFluid.VOID) this.base[i] = BaseFluid.DIRT;
    return true;
  }

  /** 汇水口判定:自身为 DEEP 且四邻存在更高海拔的流体格。 */
  isIntake(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.index(x, y);
    if (this.elev[i] !== Elevation.DEEP) return false;
    const nb: number[] = [];
    if (x + 1 < this.width) nb.push(i + 1);
    if (x > 0) nb.push(i - 1);
    if (y + 1 < this.height) nb.push(i + this.width);
    if (y > 0) nb.push(i - this.width);
    return nb.some((j) => this.elev[j] > this.elev[i] && fluidKindOfBase(this.base[j]) !== FluidKind.NONE);
  }

  /* ═══════════════ 7. 批量推进与快照 ═══════════════ */

  /**
   * 跑 frames 个 2Hz 帧,返回最后一帧报告与全程「总账」轨迹。
   * 总账 = total() + 相变销毁的水 + 相变销毁的熔岩,应当逐帧等于初始总量。
   */
  run(frames: number, budget: number = FLUID_CELL_BUDGET): { last: FluidStepReport; trace: number[] } {
    const trace: number[] = [];
    let last: FluidStepReport = {
      processed: 0, visited: 0, active: 0, moved: 0,
      phaseChanges: 0, consumedByPhase: 0, consumedLava: 0, truncated: false,
    };
    for (let f = 0; f < frames; f += 1) {
      last = this.step(budget);
      trace.push(this.grandTotal());
    }
    return { last, trace };
  }

  /**
   * 总账(守恒不变量):
   *   grandTotal = 现存全部流体 + 相变销毁的水 + 相变销毁的熔岩
   * 无论跑多少帧、是否发生相变,该值恒等于初始总量。
   */
  grandTotal(): number {
    return this.total() + this.totalConsumedByPhase + this.totalConsumedLava;
  }

  clone(): FluidField {
    const c = new FluidField(this.width, this.height);
    c.amount.set(this.amount);
    c.base.set(this.base);
    c.solid.set(this.solid);
    c.elev.set(this.elev);
    c.cursor = this.cursor;
    c.totalConsumedByPhase = this.totalConsumedByPhase;
    c.totalConsumedLava = this.totalConsumedLava;
    return c;
  }

  /** 每帧模拟耗时(毫秒,2Hz 预算参考),用于文档里的实测数字。 */
  static perStepMillis(field: FluidField, frames: number): number {
    const t0 = performance.now();
    for (let i = 0; i < frames; i += 1) field.step();
    return (performance.now() - t0) / frames;
  }
}

function clampAmount(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const i = Math.floor(v);
  if (i < 0) return 0;
  if (i > CAP) return CAP;
  return i;
}

/* ═══════════════════════ 7. 便捷构造器 ═══════════════════════ */

/** 造一个四周有实心墙的水池(守恒测试夹具)。 */
export function makeSealedPool(width: number, height: number, fill: number): FluidField {
  const f = new FluidField(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const wall = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const i = f.index(x, y);
      f.base[i] = wall ? BaseFluid.ROCK : BaseFluid.SHALLOW_WATER;
      f.solid[i] = wall ? 1 : 0;
      f.elev[i] = Elevation.GROUND;
      f.amount[i] = wall ? 0 : fill;
      /* 直接写数组会绕过 `markActive`,于是这个池子的水**不在活跃集合里**,
         只能靠游标轮询 —— 在 64×64 上就是 4 帧才动一次。
         辅助函数也必须维持这个不变量。 */
      if (fill > 0 && !wall) f.markActive(i);
    }
  }
  return f;
}

/** 2Hz 帧时长(秒),文档与超时判定共用。 */
export const FLUID_FRAME_SECONDS = SLOW_DT;