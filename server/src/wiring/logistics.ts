/**
 * WS-08 / 自动化物流:传送带 428、智能分拣 429、机械臂 430、自动采矿钻头 431。
 *
 * 全部机器跑在 **2Hz 低频帧** 上(`SLOW_TICK_HZ = 2`,即每帧 0.5s):
 *  - 传送带 428:1 格/秒 → 每 2 帧推 1 格;
 *  - 智能分拣 429:在传送带基础上按过滤物品 ID 分流到左/前/右三路;
 *  - 机械臂 430:抓取 → 摆动 → 投喂,单次循环 2.0s = 4 帧;
 *  - 采矿钻头 431:10 秒/块 → 20 帧产 1 块矿石。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { SLOW_TICK_HZ } from '../../../shared/types/physics.ts';
import { WireColor } from '../../../shared/types/tile.ts';

export { SLOW_TICK_HZ };

/** 物流帧率 = 2Hz。 */
export const LOGISTICS_HZ = SLOW_TICK_HZ;
/** 每帧秒数 = 0.5s。 */
export const LOGISTICS_FRAME_SECONDS = 1 / LOGISTICS_HZ;

/** 把「秒」换算成 2Hz 帧数(向上取整,最小 1)。 */
export function ticksFor(seconds: number): number {
  return Math.max(1, Math.ceil(seconds * LOGISTICS_HZ - 1e-9));
}

/** 传送带速度:1 格/秒。 */
export const CONVEYOR_CELLS_PER_SECOND = 1;
/** 传送带每帧推进的格数 = 0.5。 */
export const CONVEYOR_CELLS_PER_TICK = CONVEYOR_CELLS_PER_SECOND / LOGISTICS_HZ;
/** 走满 1 格所需帧数 = 2。 */
export const CONVEYOR_TICKS_PER_CELL = CONVEYOR_CELLS_PER_SECOND === 0
  ? Number.POSITIVE_INFINITY
  : LOGISTICS_HZ / CONVEYOR_CELLS_PER_SECOND;

/** 机械臂单次循环时长(秒)与帧数。 */
export const ARM_CYCLE_SECONDS = 2.0;
export const ARM_CYCLE_TICKS = ARM_CYCLE_SECONDS * LOGISTICS_HZ;
/** 机械臂抓取半径(格)。 */
export const ARM_REACH = 3;
/** 机械臂每次搬运件数。 */
export const ARM_BATCH = 1;

/** 采矿钻头周期:10 秒/块 → 20 帧。 */
export const DRILL_PERIOD_SECONDS = 10;
export const DRILL_PERIOD_TICKS = DRILL_PERIOD_SECONDS * LOGISTICS_HZ;
/** 钻头取矿半径(格)。 */
export const DRILL_REACH = 1;

/** 机械臂可投喂的目标设备 ID。 */
export const ARM_TARGETS: readonly number[] = Object.freeze([503, 506, 508, 536, 425, 429, 437]);

export const ItemStack = {
  EMPTY: 'EMPTY',
} as const;

export interface Stack {
  id: number;
  count: number;
}

/** 方向:0=北 1=东 2=南 3=西(与 `faceDir()` 一致)。 */
export const DIR_DX: readonly number[] = [0, 1, 0, -1];
export const DIR_DY: readonly number[] = [-1, 0, 1, 0];
/** 相对朝向的左/前/右偏移:左 = 朝向 −90°。 */
export function sideOffset(dir: number, side: number): { dx: number; dy: number } {
  const d = (((dir | 0) + side) % 4 + 4) % 4;
  return { dx: DIR_DX[d], dy: DIR_DY[d] };
}

/* ══════════════════════════ 428 定向物流传送带 ══════════════════════════ */

export interface ConveyorState {
  /** 0..1 的格内进度 */
  progress: number;
  /** 朝向(货物前进方向) */
  dir: number;
  /** 承载的货 */
  item: Stack | null;
  /** 累计搬运格数(统计用) */
  movedCells: number;
}

export function createConveyorState(dir = 1): ConveyorState {
  return { progress: 0, dir, item: null, movedCells: 0 };
}

export interface ConveyorStepResult {
  /** 本帧是否推进了 1 格 */
  moved: boolean;
  /** 货物离开本格的去向 */
  exit: { dx: number; dy: number; item: Stack } | null;
  /** 本格当前是否仍载货 */
  stillLoaded: boolean;
  /** 进度(0..1) */
  progress: number;
}

/**
 * 传送带推进一帧。
 * 规则:载货则 `progress += 0.5`;累计 ≥1 时货物移向下一格并 `progress -= 1`。
 * 因此在 2Hz 下 **恰好 2 帧 1 格 = 1 格/秒**。
 *
 * 复杂度 O(1)。
 */
export function stepConveyor(state: ConveyorState, running: boolean): ConveyorStepResult {
  if (!running || !state.item) {
    return { moved: false, exit: null, stillLoaded: state.item !== null, progress: state.progress };
  }
  state.progress += CONVEYOR_CELLS_PER_TICK;
  if (state.progress + 1e-9 < 1) {
    return { moved: false, exit: null, stillLoaded: true, progress: state.progress };
  }
  state.progress -= 1;
  if (state.progress < 0) state.progress = 0;
  const item = state.item;
  const dir = state.dir;
  state.item = null;
  state.movedCells += 1;
  return {
    moved: true,
    exit: { dx: DIR_DX[dir], dy: DIR_DY[dir], item },
    stillLoaded: false,
    progress: state.progress,
  };
}

/** 把货物放到传送带上(空带才接收)。 */
export function loadConveyor(state: ConveyorState, item: Stack): boolean {
  if (state.item) return false;
  state.item = { id: item.id | 0, count: Math.max(1, item.count | 0) };
  state.progress = 0;
  return true;
}

/* ══════════════════════════ 429 智能分拣交叉带 ══════════════════════════ */

/** 三条出路:左转 / 直行 / 右转。 */
export const SorterRoute = { LEFT: 'LEFT', FORWARD: 'FORWARD', RIGHT: 'RIGHT' } as const;
export type SorterRoute = (typeof SorterRoute)[keyof typeof SorterRoute];

/** 侧向偏移:LEFT = dir−1,RIGHT = dir+1。 */
export const ROUTE_SIDE: Record<SorterRoute, number> = { LEFT: -1, FORWARD: 0, RIGHT: 1 };

export interface SorterState {
  conveyor: ConveyorState;
  /** 过滤物品 ID 白名单(命中 → 直行) */
  filterIds: number[];
  /** 未命中过滤的默认去向 */
  defaultRoute: SorterRoute;
  /** 命中过滤的去向 */
  matchRoute: SorterRoute;
  /** 按物品 ID 分流统计 */
  routed: Map<number, number>;
}

export function createSorterState(dir = 1, filterIds: readonly number[] = []): SorterState {
  return {
    conveyor: createConveyorState(dir),
    filterIds: filterIds.map((n) => n | 0),
    defaultRoute: SorterRoute.RIGHT,
    matchRoute: SorterRoute.FORWARD,
    routed: new Map(),
  };
}

/** 判定某物品走哪条路。 */
export function pickRoute(state: SorterState, itemId: number): SorterRoute {
  return state.filterIds.includes(itemId | 0) ? state.matchRoute : state.defaultRoute;
}

export interface SorterStepResult {
  moved: boolean;
  exit: { dx: number; dy: number; item: Stack; route: SorterRoute } | null;
  progress: number;
}

/**
 * 分拣器推进一帧:先按传送带节拍走格,走满一格时按过滤表选择出路。
 * 复杂度 O(|filter|) 每格,过滤表典型 ≤8,可用 Set 缓存降到 O(1)。
 */
export function stepSorter(state: SorterState, running: boolean): SorterStepResult {
  const itemId = state.conveyor.item?.id ?? 0;
  const route = itemId === 0 ? SorterRoute.FORWARD : pickRoute(state, itemId);
  const base = stepConveyor(state.conveyor, running);
  if (!base.moved || !base.exit) {
    return { moved: base.moved, exit: null, progress: base.progress };
  }
  const side = ROUTE_SIDE[route];
  const d = (((state.conveyor.dir + side) % 4) + 4) % 4;
  state.routed.set(base.exit.item.id, (state.routed.get(base.exit.item.id) ?? 0) + base.exit.item.count);
  return {
    moved: true,
    exit: { dx: DIR_DX[d], dy: DIR_DY[d], item: base.exit.item, route },
    progress: base.progress,
  };
}

/** 用过滤表把物品分流到左/前/右三路的静态映射(供 UI 预览)。 */
export function previewRouting(
  filterIds: readonly number[],
  candidates: readonly number[],
  dir = 1,
): { id: number; route: SorterRoute; dx: number; dy: number }[] {
  const st = createSorterState(dir, filterIds);
  return candidates.map((id) => {
    const route = pickRoute(st, id);
    const side = ROUTE_SIDE[route];
    const d = (((dir + side) % 4) + 4) % 4;
    return { id, route, dx: DIR_DX[d], dy: DIR_DY[d] };
  });
}

/* ══════════════════════════ 430 魔能抓取机械臂 ══════════════════════════ */

export const ArmPhase = {
  IDLE: 'IDLE',
  REACH: 'REACH',
  CARRY: 'CARRY',
  DEPOSIT: 'DEPOSIT',
} as const;
export type ArmPhase = (typeof ArmPhase)[keyof typeof ArmPhase];

export interface ArmState {
  phase: ArmPhase;
  /** 当前循环已过帧数 */
  elapsed: number;
  /** 抓在手上的货 */
  held: Stack | null;
  /** 投喂目标设备 ID(0 表示未指定,取最近合法目标) */
  targetDevice: number;
  /** 抓取半径 */
  reach: number;
  /** 累计投喂次数 */
  delivered: number;
  /** 空转次数(附近无货) */
  idleCycles: number;
}

export function createArmState(targetDevice = 0, reach = ARM_REACH): ArmState {
  return {
    phase: ArmPhase.IDLE,
    elapsed: 0,
    held: null,
    targetDevice: targetDevice | 0,
    reach,
    delivered: 0,
    idleCycles: 0,
  };
}

/** 机械臂视角的格子世界接口。 */
export interface ArmWorld {
  /** 取该格地面掉落物;取走时返回 Stack 并清空格子 */
  take(x: number, y: number): Stack | null;
  /** 往目标设备投喂;成功返回 true */
  feed(deviceId: number, x: number, y: number, item: Stack): boolean;
  /** 该格是否有指定设备 */
  deviceAt(x: number, y: number): number;
}

export interface ArmStepResult {
  phase: ArmPhase;
  /** 本帧新抓到的货 */
  grabbed: Stack | null;
  /** 本帧投喂成功的货 */
  fed: Stack | null;
  /** 是否开始了新循环 */
  newCycle: boolean;
}

/**
 * 机械臂推进一帧。单次循环 4 帧(2.0s):
 *   帧 0 → REACH:在 `reach` 半径内找掉落物或箱内物品;
 *   帧 1 → CARRY:抓在手上;
 *   帧 2 → DEPOSIT:找目标设备投喂;
 *   帧 3 → 回位(IDLE)。
 * 复杂度 O(reach²) 扫描,reach=3 时 49 格。
 */
export function stepArm(state: ArmState, world: ArmWorld, x: number, y: number, powered: boolean): ArmStepResult {
  const result: ArmStepResult = { phase: state.phase, grabbed: null, fed: null, newCycle: false };
  if (!powered) {
    if (state.phase !== ArmPhase.IDLE) {
      state.phase = ArmPhase.IDLE;
      state.elapsed = 0;
    }
    return result;
  }

  switch (state.phase) {
    case ArmPhase.IDLE: {
      state.elapsed = 0;
      state.phase = ArmPhase.REACH;
      result.newCycle = true;
      break;
    }
    case ArmPhase.REACH: {
      let found: Stack | null = null;
      const r = Math.max(1, state.reach | 0);
      for (let dy = -r; dy <= r && !found; dy += 1) {
        for (let dx = -r; dx <= r && !found; dx += 1) {
          if (dx * dx + dy * dy > r * r) continue;
          found = world.take(x + dx, y + dy);
        }
      }
      if (found) {
        state.held = found;
        state.phase = ArmPhase.CARRY;
        result.grabbed = found;
      } else {
        /* 无货:回位并记一次空转 */
        state.idleCycles += 1;
        state.phase = ArmPhase.IDLE;
      }
      break;
    }
    case ArmPhase.CARRY: {
      state.phase = ArmPhase.DEPOSIT;
      break;
    }
    case ArmPhase.DEPOSIT: {
      if (state.held) {
        let deviceId = state.targetDevice;
        if (deviceId === 0) {
          const r = Math.max(1, state.reach | 0);
          for (let dy = -r; dy <= r && deviceId === 0; dy += 1) {
            for (let dx = -r; dx <= r && deviceId === 0; dx += 1) {
              const d = world.deviceAt(x + dx, y + dy);
              if (ARM_TARGETS.includes(d)) deviceId = d;
            }
          }
        }
        if (deviceId !== 0 && world.feed(deviceId, x, y, state.held)) {
          result.fed = state.held;
          state.delivered += 1;
          state.held = null;
        }
      }
      state.phase = ArmPhase.IDLE;
      break;
    }
    default:
      state.phase = ArmPhase.IDLE;
      break;
  }
  state.elapsed += 1;
  result.phase = state.phase;
  return result;
}

/* ══════════════════════════ 431 自动采矿钻头机 ══════════════════════════ */

export interface DrillState {
  /** 已计帧数(0..DRILL_PERIOD_TICKS-1) */
  elapsed: number;
  /** 本机开采的矿脉物品 ID(0 = 无矿脉) */
  oreId: number;
  /** 累计产出块数 */
  produced: number;
  /** 累计宕机帧数(无风车动力) */
  stalledTicks: number;
  /** 待取走的成品 */
  buffer: Stack | null;
}

export function createDrillState(oreId = 0): DrillState {
  return { elapsed: 0, oreId: oreId | 0, produced: 0, stalledTicks: 0, buffer: null };
}

/** 风车动力网:绿线接通即视为有风。 */
export function drillPowered(graph: { liveAt(x: number, y: number, c: WireColor): boolean }, x: number, y: number): boolean {
  return graph.liveAt(x, y, WireColor.GREEN) || graph.liveAt(x + 1, y, WireColor.GREEN);
}

export interface DrillStepResult {
  produced: Stack | null;
  progress: number;
  stalled: boolean;
}

/**
 * 钻头推进一帧:有动力则累计,满 20 帧(10s)产 1 块矿。
 * 复杂度 O(1)。
 */
export function stepDrill(state: DrillState, powered: boolean): DrillStepResult {
  if (!powered) {
    state.stalledTicks += 1;
    return { produced: null, progress: state.elapsed / DRILL_PERIOD_TICKS, stalled: true };
  }
  if (state.oreId === 0) {
    return { produced: null, progress: 0, stalled: false };
  }
  state.elapsed += 1;
  if (state.elapsed < DRILL_PERIOD_TICKS) {
    return { produced: null, progress: state.elapsed / DRILL_PERIOD_TICKS, stalled: false };
  }
  state.elapsed = 0;
  state.produced += 1;
  const out: Stack = { id: state.oreId, count: 1 };
  if (state.buffer === null) state.buffer = out;
  else state.buffer.count += 1;
  return { produced: out, progress: 0, stalled: false };
}

/** 取走钻头缓冲的成品。 */
export function takeDrillBuffer(state: DrillState): Stack | null {
  const b = state.buffer;
  state.buffer = null;
  return b;
}

/* ══════════════════════════ 物流流水线编排 ══════════════════════════ */

export interface LogisticsLine {
  /** 流水线挂载的传送带节点(按 order 串联) */
  belts: { x: number; y: number; state: ConveyorState }[];
  /** 分拣机 */
  sorters: { x: number; y: number; state: SorterState }[];
  /** 机械臂 */
  arms: { x: number; y: number; state: ArmState }[];
  /** 钻头 */
  drills: { x: number; y: number; state: DrillState }[];
}

export interface LogisticsTickReport {
  beltMoves: number;
  sorterMoves: number;
  armGrabs: number;
  armFeeds: number;
  drillOres: number;
}

/**
 * 一次物流 tick:按「钻头产矿 → 传送带走格 → 分拣分流 → 机械臂投喂」的顺序串行执行,
 * 保证同一帧内货物只被搬运一次,不会出现钻头刚产出就被本帧机械臂抓走又投喂的穿帧。
 */
export function tickLogistics(
  line: LogisticsLine,
  world: ArmWorld,
  powered: { belt: boolean; arm: boolean; drill: boolean },
): LogisticsTickReport {
  const rep: LogisticsTickReport = { beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0 };
  for (const d of line.drills) {
    const r = stepDrill(d.state, powered.drill);
    if (r.produced) rep.drillOres += 1;
  }
  for (const b of line.belts) {
    const r = stepConveyor(b.state, powered.belt);
    if (r.moved) rep.beltMoves += 1;
  }
  for (const s of line.sorters) {
    const r = stepSorter(s.state, powered.belt);
    if (r.moved) rep.sorterMoves += 1;
  }
  for (const a of line.arms) {
    const r = stepArm(a.state, world, a.x, a.y, powered.arm);
    if (r.grabbed) rep.armGrabs += 1;
    if (r.fed) rep.armFeeds += 1;
  }
  return rep;
}