/**
 * 世界模拟编排层 —— 把 11 个工作流真正连成一个**可运行的世界**。
 *
 * ## 为什么需要这一层
 *
 * 交付时各 WS 的测试都是**自证式**的:每个套件只在自己那一个模块里建对象、
 * 断言、销毁。这本身没错 —— 单元测试就该这样。但它留下一个空白:
 * **没有任何代码同时驱动地形、物理、电路、生物、战斗**。
 *
 * 具体表现(交付后审计的实测结果):
 *   - 全仓跨 WS 的 import 只有 **1 处**(`build/blueprint.ts → world/chunk.ts`);
 *   - `PhysicsWorld` / `FluidField` / `SignalGraph` / `MobSpawner` 都**只有
 *     自己文件引用自己**,连一次 `.step()` 调用都没有;
 *   - 没有双频调度器,`SLOW_DT` 只被当作常量引用,从不驱动任何推进。
 *
 * 也就是说:677 条断言全绿,但**这个世界从未跑起来过**。
 *
 * ## 这一层做什么
 *
 * `WorldSim` 持有全部子系统并**按手册 §2.1 的双频节奏推进**:
 *
 *   20Hz 快帧:物理积分(刚体、举投、碰撞、反弹)+ 生物 FSM + 电路时序件
 *    2Hz 慢帧:流体元胞自动机 + 电路信号泛洪 + 刷怪决策 + AOI 唤醒
 *
 * 比例恰好 **10:1** —— 这是「快帧 20Hz、慢帧 2Hz」的直接推论,也是本文件
 * 最重要的不变量:慢帧逻辑在 60 秒里只跑 120 次,快帧跑 1200 次。
 * 把流体或电路误放进快帧会让 CPU 开销直接 ×10,这是最容易被写错的一处。
 *
 * ## 设计约束
 *
 * 1. **零依赖**:只用 `node:*` 与仓库内模块,不 import 任何外部包。
 * 2. **不改冻结层**:`shared/**` 一行不动。
 * 3. **确定性**:给定相同种子与相同输入序列,`step` 序列逐帧可复现。
 *    所有随机来自注入的 `rng`,不使用 `Math.random`。
 * 4. **不重复实现**:子系统已有的逻辑一律调用,本层只负责**顺序与节奏**。
 */

import { SLOW_TICK_HZ, TICK_HZ, DT } from '../../../shared/types/physics.ts';
import type { WireColor } from '../../../shared/types/tile.ts';
import { WorldGrid } from '../world/grid.ts';
import { Chunk, type TileFields } from '../world/chunk.ts';
import { FluidField, FLUID_CELL_BUDGET } from '../world/fluid.ts';
import { PhysicsWorld, type StepReport } from '../physics/world.ts';
import { CarrySystem, CarryReject, type CarryActor, type ChainNode, type ThrowResult } from '../physics/carry.ts';
import { AoiManager, type AoiPlayer } from '../mobs/aoi.ts';
import { MobSpawner, type SpawnContext, type SpawnWorld } from '../mobs/spawner.ts';
import { SignalGraph } from '../wiring/graph.ts';
/* ── 副作用 import:必须保留 ──
 *
 * `components.ts` **没有任何导出被本文件调用**,它的作用是**模块加载时**
 * 用 `registerComponentKind(kind, fn)` 往 `graph.ts` 的模块级 `REGISTRY`
 * 里注册 40 项电路件的行为(401~440)。
 *
 * 因此这一行看起来「没用」,删掉的后果却是**灾难性的安静**:
 * REGISTRY 保持为空 → `SignalGraph.tick()` 里 `REGISTRY.get(comp.kind)`
 * 恒为 `undefined` → `if (!fn) continue` 跳过每一个件 →
 * **40 项电路件全部变成永不求值的空壳**(AND/NOT、延时继电器、分流器、
 * 计数器、无线广播、执行器、防御、物流…… 一项都不跑)。
 *
 * 表现特征:不报错、不抛异常、`addComponent` 照常收下、泛洪照常工作 ——
 * 只有「件的行为」消失了。`docs/FOUNDATION-AUDIT.md` §3.1 缺陷 B 记录的正是
 * 这个状态:生产目录零引用,`verify.ts` 的可达性门禁把 `components.ts`
 * 列在白名单里(「编排层只驱动线,不驱动件,待接线」)。
 *
 * 修复前实测:`hasComponentKind('LOGIC_AND') === false`(导入前)/ `true`(导入后)。
 * 现在它属于生产可达闭包,应已从白名单移出。
 *
 * 为什么写成 `import '../wiring/components.ts';` 而不 `import { ... } from`:
 * 本模块不需要它的任何符号,要的**只有注册副作用**。写成具名导入会引入
 * 未使用变量,反而诱导后人「清理」掉它 —— 那正是这个缺陷会复发的原因。
 */
import '../wiring/components.ts';
import { EventBus } from '../events/bus.ts';
import { MobHost, type MobHostWorld, type MobTickResult } from '../mobs/host.ts';
import { MOB_BY_ID } from '../../../shared/constants/mobs.ts';
import { VitalsSystem, resolveStrikes, collectEventStrikes, type MobHitResult, type PendingStrike } from '../combat/vitals.ts';
import type { GroundItem, WorldPlayer, DamageKind, DamageResult } from '../mobs/behaviors.ts';
/* 存档闭环:`db` 只作为**参数**出现在 `saveToDb` / `loadFromDb` 里,
   不进构造器 —— 保住 `new WorldSim({sizeCells})` 的纯度(见该方法注释)。 */
import {
  saveVitalsToUsers,
  loadVitalsFromUsers,
  saveRoomMobMem,
  loadRoomMobMem,
  type DbLike,
} from '../db/repo.ts';

/** 快帧与慢帧的固定比例:20Hz / 2Hz = 10。 */
export const FAST_PER_SLOW = TICK_HZ / SLOW_TICK_HZ;

/** 一帧快帧的现实时长(秒)。 */
export const SIM_FAST_DT = DT;

/** 一帧慢帧的现实时长(秒)。 */
export const SIM_SLOW_DT = 1 / SLOW_TICK_HZ;

/** 单个模拟实例的构造参数。 */
export interface WorldSimOptions {
  /** 世界边长(格)。默认 64 —— 够放 4×4 个 Chunk,便于调试与测试。 */
  sizeCells?: number;
  /** 每帧慢帧最多处理多少个流体格。默认取 `FLUID_CELL_BUDGET`。 */
  fluidBudget?: number;
  /** 每帧慢帧是否推进电路泛洪。默认 true。 */
  wiring?: boolean;
  /** 每帧快帧是否推进生物 FSM。默认 true。 */
  mobs?: boolean;
  /** 确定性随机源,返回 [0,1)。默认用固定的 mulberry32。 */
  rng?: () => number;
}

/** 单帧结算报告:把各子系统的返回值汇总成一份可观测账本。 */
export interface SimFrameReport {
  /** 全局帧序(每调用一次 `tick` 加一)。 */
  frame: number;
  /** 本帧是快帧还是慢帧。 */
  phase: 'FAST' | 'SLOW';
  /** 本帧对应的模拟时间(秒)。 */
  simSeconds: number;
  /** 本帧物理报告(仅快帧有)。 */
  physics: StepReport | null;
  /** 本帧唤醒的活跃生物数(仅慢帧有)。 */
  activeMobs: number;
  /**
   * 本帧流体**访问**的格数(仅慢帧有)。
   *
   * ⚠️ **这不是「有多少水在动」。** 字段名沿用了旧实现的习惯,但
   * `FluidField.step` 的 `processed` 计的是「遍历额度用量」——
   * 全干世界也报满额(如 1024)。判断流体是否在工作请读
   * `fluidActive`(参与流动的格数)与 `fluidMoved`(转移的毫格)。
   */
  fluidProcessed: number;
  /** 本帧流体中**真正参与流动**的格数(有水或有水邻居;仅慢帧有)。 */
  fluidActive: number;
  /** 本帧流体转移的毫格(仅慢帧有;为 0 表示水已平衡或世界是干的)。 */
  fluidMoved: number;
  /**
   * 本慢帧被写回 OBJ 层的**相变产物**格数(黑曜石 110 / 多孔浮石 111)。
   *
   * 这是「水 + 熔岩」接触后凝结的可观测账本。修复前恒为 0 ——
   * `FluidField.drainPhaseProducts()` 存在但无人调用,产物停在队列里。
   * 断言「该格真的是黑曜石」请查地形(`grid.objIdAt`),不是查这个计数。
   */
  phaseProducts: number;
  /** 本帧电路**增量**泛洪格数(仅慢帧有;结构不变时为 0,属正常)。 */
  wireCellsFlooded: number;
  /**
   * 本慢帧被**求值**的逻辑件数(即真正跑过行为函数的件)。
   *
   * 这是「电路件是否在生产可达」的**直接证据**:`SignalGraph.tick()` 里
   * `REGISTRY.get(comp.kind)` 查不到就 `continue`,计数不增。
   * 故此值恒为 0 就说明注册表是空的 —— 40 项件全是空壳
   * (`docs/FOUNDATION-AUDIT.md` §3.1 缺陷 B 的特征状态)。
   *
   * 与 `wireCellsLive` 互补:后者证明「线能通电」,**不**证明「件能求值」。
   * 早先 `demo.ts` 的自检只看了前者,所以缺陷能长期隐身。
   */
  componentsEvaluated: number;
  /** 当前**稳态**通电格数(电路是否真的通,看这个而不是上面的增量)。 */
  wireCellsLive: number;
  /** 本帧刷怪尝试成功数(仅慢帧有)。 */
  spawned: number;
}

/** 确定性 PRNG(mulberry32)。相同种子必然给出相同序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 可运行的世界。
 *
 * 持有顺序即**初始化顺序**:地形 → 物理 → 电路 → 生物。
 * 推进顺序即**每帧顺序**:物理 → 生物 → 电路 → 流体。
 * 两个顺序不同是刻意的 —— 物理要先动,电路后判,这样「玩家踩到压力板」
 * 与「该板通电」落在同一帧里,不会被推迟一帧(那是 50ms 的可感知延迟)。
 */
export class WorldSim {
  readonly grid: WorldGrid;
  readonly physics: PhysicsWorld;
  readonly fluid: FluidField;
  readonly wiring: SignalGraph;
  readonly aoi: AoiManager;
  readonly spawner: MobSpawner;
  readonly carry: CarrySystem;
  /**
   * 事件总线 —— 事件驱动子系统的共同出口。
   *
   * 生物 AI 的 30 处 `emit` 走这里;伤害结算 / Boss 阶段 / 炼金等
   * 事件型子系统将来也接这里。见 `docs/EVENT-BUS.md`。
   */
  readonly bus: EventBus;
  /**
   * 生物宿主 —— `MobWorld` 的第一份真实实现。
   *
   * 25 个 AI 类的 `tick` 通过它访问世界。此前编排层的
   * `aoi.stepActive(() => {})` 是空回调,25 个实现一行都没跑过。
   */
  readonly mobHost: MobHost;

  readonly sizeCells: number;
  private readonly rng: () => number;
  private readonly fluidBudget: number;
  private readonly wiringOn: boolean;
  private readonly mobsOn: boolean;

  private frameCount = 0;
  private players: AoiPlayer[] = [];
  /**
   * 每慢帧重新施加的驱动态。
   *
   * `SignalGraph.drive(x, y, color, on)` 写的是**帧内**驱动态,不是持久开关 ——
   * `tick()` 结束后驱动态会被消费掉。所以「接一个常亮拉杆」这件事必须由
   * 编排层每帧重放,而不是注册一次就完事。漏掉这一步的表现是:
   * 第一帧之后泛洪恒为 0、模式退化成 `IDLE`,但布线、组件、通电查询全部正常,
   * 看起来像「电路模块坏了」,实际是调用方少写了一次驱动。
   */
  private readonly wireDrives: { x: number; y: number; color: WireColor; on: boolean }[] = [];

  /**
   * 供生物 AI 读取的玩家视图(`MobWorld.players()`)。
   *
   * 与 `aoi` 的玩家列表**分开**维护是刻意的:`AoiPlayer` 只需要
   * `{id,x,y,afk}`(AOI 只做距离判定),而 `WorldPlayer` 还带
   * `heldItem` / `wearing` / `playingInstrument` —— AI 要靠这些做交互判定
   * (喂食看手持、竖琴看是否在演奏)。把两者塞进一个类型会迫使 AOI 承担
   * 它不需要的字段。
   *
   * 同步由 `syncPlayers()` 负责 —— 漏同步的表现是「AI 看不见玩家」
   * 或「看见的是上一帧位置」,不报错。
   */
  private mobPlayers: WorldPlayer[] = [];
  /** 供生物 AI 读写的地面掉落物(`MobWorld.groundItems()`)。 */
  private mobGround: GroundItem[] = [];
  /**
   * 真正的玩家 ID 集合。
   *
   * `physics.bodies` 里玩家与生物**混在一起**(`addPlayer` 与 `addMob`
   * 都调 `physics.spawn`),所以「哪些是玩家」必须单独记账 ——
   * 靠 `bodies` 是分不出来的。缺这个集合会导致生物互相视为玩家。
   */
  private readonly playerIds = new Set<string>();
  /** 最近一次慢帧的生物推进结果(供诊断与断言)。 */
  lastMobTicks: MobTickResult[] = [];
  /** 累计 AI 抛错次数。 */
  mobErrors = 0;

  constructor(opts: WorldSimOptions = {}) {
    this.sizeCells = Math.max(16, Math.trunc(opts.sizeCells ?? 64));
    this.fluidBudget = Math.max(1, Math.trunc(opts.fluidBudget ?? FLUID_CELL_BUDGET));
    this.wiringOn = opts.wiring !== false;
    this.mobsOn = opts.mobs !== false;
    this.rng = opts.rng ?? mulberry32(0x5eed);

    this.grid = new WorldGrid();
    this.fluid = new FluidField(this.sizeCells, this.sizeCells);
    /*
     * `SignalGraph` 的尺寸必须与世界**显式一致** —— 它的构造函数签名是
     * `(width, height)`,没有默认值。漏传会得到 `0×0` 的位平面,于是
     * `index(x,y)` 恒返回 -1,`addWire` 静默返回 false、`wireAt` 恒 false —— 
     * 电路看起来「布线成功但永远不通电」,而实际上**一根线都没写进去**。
     * 这类失败没有异常、没有日志,只有泛洪统计里那个恒为 0 的数字。
     */
    this.wiring = new SignalGraph(this.sizeCells, this.sizeCells);
    this.aoi = new AoiManager();
    this.spawner = new MobSpawner();

    /* 物理需要一个 PhysTerrain;WorldGrid 已实现 TerrainSource,
       但两边的接口名略有差异,这里用一层薄适配把名字对齐 —— 
       不复制逻辑,只转发调用。 */
    this.physics = new PhysicsWorld({
      terrain: {
        floorSlotAt: (x: number, y: number) => this.grid.floorSlotAt(x, y),
        objIdAt: (x: number, y: number) => this.grid.objIdAt(x, y),
        elevAt: (x: number, y: number) => this.grid.elevAt(x, y),
        faceDirAt: (x: number, y: number) => this.grid.faceDirAt(x, y),
        poweredAt: (x: number, y: number) => this.grid.poweredAt(x, y),
        roofAt: (x: number, y: number) => this.grid.roofAt(x, y),
      },
      bounds: { minX: 0, minY: 0, maxX: this.sizeCells - 1, maxY: this.sizeCells - 1 },
    });
    this.carry = new CarrySystem(this.carryActors());

    /* 事件总线 + 生物宿主。宿主通过下面这个窄适配器访问世界 ——
       刻意不让宿主直接拿 WorldSim,避免与 world_sim.ts 形成循环依赖,
       也使宿主能脱离完整编排层单测(见 tests/WS-FND-02.test.ts)。 */
    this.bus = new EventBus();
    this.mobHost = new MobHost(this.mobWorldAdapter(), { bus: this.bus, rng: this.rng });
  }

  /**
   * 把 `WorldSim` 的内部结构适配成宿主需要的窄接口。
   *
   * **适配而非重写**:每个方法只转发到既有系统,不复制任何地形/物理逻辑
   * —— 那会造出第二份真相,而两份真相必然漂移。
   */
  private mobWorldAdapter(): MobHostWorld {
    return {
      probe: (x, y) => {
        /*
         * **返回「有障碍」= true**,不是「可站立」= true。
         *
         * 这个极性是从**调用方**反推确定的,因为 `MobWorld.probe` 在冻结层里
         * 只有一行签名、**没有任何注释说明语义** —— 合同缺失。
         *
         * 两个调用者的写法都是:
         *     const nx = ...; const ny = ...;
         *     if (world.probe(nx, ny)) { / 撞墙 自晕 / }
         *     rt.x = nx; rt.y = ny;              // 没撞才移动
         * 即 `true` = **挡路**。`BoarAi`(冲锋撞墙)与 `PangolinAi`(滚撞)一致。
         *
         * 我最初按「可站立 = true」写(名词语义上更自然),结果是:
         * **全图每一格都被判为障碍** → 野猪与穿山甲每帧自晕、永不移动。
         * 不报错、不抛异常,表现只是「这两只生物站着不动」。
         * 实测:穿山甲在玩家 10 格外仍 `stunSec=4` 且位移恒为 0。
         *
         * 若要统一成语义更清晰的「可站立」,需要改 `shared/` 里 `MobWorld`
         * 的注释 + 两个 AI —— 那是冻结层变更,须走 CR。
         */
        if (x < 0 || y < 0 || x >= this.sizeCells || y >= this.sizeCells) return true;
        return this.grid.objIdAt(Math.floor(x), Math.floor(y)) !== 0;
      },
      players: () => this.mobPlayers,
      groundItems: () => this.mobGround,
      consumeGroundItem: (itemId, count) => {
        /* 从地面掉落里扣减,返回实际消耗数。 */
        let left = count;
        for (let i = this.mobGround.length - 1; i >= 0 && left > 0; i -= 1) {
          const g = this.mobGround[i];
          if (g.itemId !== itemId) continue;
          const take = Math.min(left, g.count);
          g.count -= take;
          left -= take;
          if (g.count <= 0) this.mobGround.splice(i, 1);
        }
        return count - left;
      },
      setFloor: (x, y, floor) => {
        /* 写 FLOOR 层。用 `setCell` 而非直接改 tile —— 后者会绕过水位投影。 */
        this.setCell(Math.floor(x), Math.floor(y), { floor });
      },
      placeObj: (x, y, obj) => {
        this.setCell(Math.floor(x), Math.floor(y), { obj });
      },
      spawnItem: (x, y, itemId, count) => {
        this.mobGround.push({ itemId, x, y, count });
      },
      frame: () => this.frameCount,
    };
  }

  /** 保证覆盖 `x,y` 的 Chunk 存在。 */
  private chunkAt(x: number, y: number): Chunk {
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    return this.grid.ensureChunk(cx, cy);
  }

  /**
   * 写一格地形(编排层的唯一地形入口,自动建 Chunk 并标脏)。
   *
   * **同时把地形投影到流体场**,因为两者是两套独立的数据结构:
   *   - `WorldGrid` 存 32 位打包单元(位平面),是权威地形;
   *   - `FluidField` 自己持有 `solid` / `elev` / `base` 三个数组,
   *     靠它们决定「水能不能流进这一格」。
   * 只写前者不写后者,表现是:地形看起来铺好了、流体也有总量,
   * 但水永远不扩散(`(40,30)` 恒为 0)—— 因为流体场认为那里一格都流不进去。
   * 这类「两套影子状态不同步」的缺陷不会有任何异常,只会让模拟结果
   * 缓慢地变得不合理,所以要在这里一次性对齐。
   */
  setCell(x: number, y: number, fields: Partial<TileFields>): void {
    const c = this.chunkAt(x, y);
    const lx = x - c.cx * 16;
    const ly = y - c.cy * 16;
    c.set(lx, ly, fields);
    c.markDirtyIndex(ly * 16 + lx);

    /* 投影到流体场:海拔决定水能往哪走,实心物件挡住水。
       两条都必须投影 —— 早先只投影了 `elev`,`obj` 完全没同步(US5 真缺陷):
       `WorldGrid.isSolidAt` 认为 351~371 是墙,而 `FluidField.solid` 仍是 0,
       于是**水直接穿墙而过**。实测:左高右低 + x=8 竖一道 351 墙,
       800 帧后墙右侧积水 5844 毫格;补上 solid 投影后为 0。 */
    const elev = fields.elev;
    if (elev !== undefined && this.fluid.inBounds(x, y)) {
      this.fluid.setCell(x, y, { elev });
    }
    const obj = fields.obj;
    if (obj !== undefined && this.fluid.inBounds(x, y)) {
      /* 以 `WorldGrid.isSolidAt` 为**唯一判据** —— 不在这里另立一份墙体 ID 区间,
         否则两份判定迟早漂移(这正是 US5 指出的「双份状态」病灶)。 */
      this.fluid.setCell(x, y, { solid: this.grid.isSolidAt(x, y) });
    }
  }

  /** 把某格标为实心(墙体/黑曜石),水不能流入。 */
  setSolid(x: number, y: number, solid = true): void {
    if (this.fluid.inBounds(x, y)) this.fluid.setCell(x, y, { solid });
  }

  /** 批量填充一片矩形地砖(铺地板/灌水用)。 */
  fillRect(x0: number, y0: number, x1: number, y1: number, fields: Partial<TileFields>): number {
    let n = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        this.setCell(x, y, fields);
        n += 1;
      }
    }
    return n;
  }

  /** 注册一个每慢帧重放的驱动源(常亮拉杆 / 测试注入)。 */
  addWireDrive(x: number, y: number, color: WireColor, on = true): void {
    this.wireDrives.push({ x, y, color, on });
  }

  /**
   * 给 `CarrySystem` 的**活视图**:直接读 `physics.bodies`,不复制状态。
   *
   * ## 为什么不是注册一份真 Map
   *
   * 早先这里是 `new CarrySystem(new Map())` —— 一份**与物理无关的空表**。
   * 后果:玩家从未进入 carry,`tryLift` 永远返回 `SELF`(找不到 actor),
   * 整个举投系统在生产中**不可达**(实测 `this.carry.xxx()` 调用点为 **0**)。
   * 而 WS-02 的 43 条断言全绿 —— 因为它们直接 `new CarrySystem(map)` 测,
   * 从不经编排层。这与「22/24 生物不动」是同一类缺口。
   *
   * 为什么用活视图而不是「注册时塞进两个 Map」:
   *   - `CarryActor` 包装的 `DynamicBody` **必须与物理看到的是同一个对象** ——
   *     举起的 z、释放时的速度都写回那份 body,双份会立刻不同步;
   *   - 物理会自己 `spawn` / `bodies.delete`(玩家注册、生物生成、卸载),
   *     两份表的增删永远追不齐;
   *   - `CarrySystem` 只对该表做 `get()`(实测 **13 处全是 get**,无遍历、
   *     无增删),所以只实现 `get` / `has` / `size` 就够,且不会有「看着能写
   *     实际不生效」的假象。
   *
   * 缺失的 actor 一律返回 `undefined`,与真实 Map 语义一致 ——
   * 于是 `tryLift` 走它已有的「找不到 → `SELF`」分支,无需改 carry。
   */
  private carryActors(): Map<string, CarryActor> {
    const bodies = this.physics.bodies;
    /* 用 Map 的子类而不是鸭子类型:接口完整性由类型系统保证,
       将来若有人给 carry 加了遍历,`for..of` 会走真实的 `entries()`。 */
    const view = new Map<string, CarryActor>();
    /* 只覆盖读取路径。`set`/`delete` 保留原语义(允许测试注入),
       但不写回 `physics.bodies` —— 所以文档上标明「只读视图」。 */
    const rawGet = view.get.bind(view);
    view.get = (id: string): CarryActor | undefined => {
      const b = bodies.get(id);
      if (b === undefined) return rawGet(id);
      const cached = rawGet(id);
      /* 缓存 key 存在但 body 换了(重生/替换)时也要返回最新的 body */
      if (cached !== undefined && cached.body === b) return cached;
      const actor: CarryActor = { body: b, shield: cached?.shield ?? false };
      view.set(id, actor);
      return actor;
    };
    view.has = (id: string): boolean => bodies.has(id) || rawGet(id) !== undefined;
    return view;
  }

  /**
   * 举起:让 `carrier` 把 `target` 扛到链尾。
   *
   * 返回 `CarryReject`;`OK` 表示成功。这是**主动交互入口**,
   * 与「每帧推进」区分:玩家按键才调用,不是每帧都试。
   */
  lift(carrierId: string, targetId: string): CarryReject {
    return this.carry.tryLift(carrierId, targetId);
  }

  /**
   * 放下链尾(不投掷)。
   *
   * 与 `throwPlayer` 分开是因为语义不同:放下应保持站立,投掷要给初速度。
   */
  dropTop(carrierId: string): string | null {
    return this.carry.release(carrierId);
  }

  /**
   * 投掷链尾。返回初速度,由物理在后续帧自然积分 —— 不在这里写位置。
   *
   * `speedMul` 默认 1.0;重物需要扁担等增益由调用方决定。
   */
  throwPlayer(carrierId: string, dirX: number, dirY: number, speedMul = 1): ThrowResult | null {
    return this.carry.throwTop(carrierId, dirX, dirY, speedMul);
  }

  /** 整条人链的当前高度(供渲染与 Z 轴判定)。 */
  carryChain(carrierId: string): ChainNode[] {
    return this.carry.syncChain(carrierId);
  }

  /** 链深带来的移速系数(扛得越多走得越慢)。 */
  carrySpeedMul(carrierId: string): number {
    return this.carry.speedMulOf(carrierId);
  }

  /**
   * 玩家用道具与生物交互(喂食 / 敲击 / 钩爪 / 水枪 / 乐器)。
   *
   * ## 为什么这是必需的编排层入口
   *
   * `MobHost.interact()` 一直存在且完整实现,但**编排层从不调用它** ——
   * 实测后果:32 种 AI 事件里有 10 种靠交互触发,全部**永不发生**。
   * 接上之后实测种类从 6 涨到 16(`_events.ts` 的对照)。
   *
   * 这与「AI tick 零调用」「fsm.tick 零调用」「CarrySystem 空 Map」
   * 是同一类缺口:**子系统完整、单测全绿、编排层不接**。
   *
   * 判据是「AI 返回了 true」——`true` 表示它**认这个道具**并处理了,
   * 而不是「我调了」。所以返回值区分「用错道具」与「没找到生物」。
   */
  interactMob(mobId: string, itemId: number, playerId: string): boolean {
    const p = this.playerById(playerId);
    if (p === undefined) return false;
    return this.mobHost.interact(mobId, itemId, p);
  }

  /**
   * 玩家对生物造成伤害(武器 / 环境 / 元素)。
   *
   * 转发到生物自己的 AI,使**格挡 / 反弹 / 元素特性**生效 ——
   * 直接改 `rt.hp` 会绕过这些,例如卡皮巴拉的反弹爱心、武士的正面格挡。
   *
   * 返回 `null` 表示没有这个生物;否则返回 AI 的结算结果
   * (`hpLoss` 才是真正的掉血,因为可能被格挡)。
   */
  damageMob(
    mobId: string,
    amount: number,
    kind: DamageKind,
    fromDeg: number,
  ): DamageResult | null {
    const r = this.mobHost.damage(mobId, amount, kind, fromDeg);
    if (r === null) return null;
    /* AI 的 `onDamage` 可能已把 hp 扣到 0 或负 —— 同步存活标记,
       否则 `tickMobs` 会继续推进一只已经死掉的生物。 */
    const rt = this.mobHost.runtimeOf(mobId);
    if (rt !== null && rt.hp <= 0) rt.alive = false;
    return r;
  }

  /** 按 ID 取玩家(位置实时从物理刚体读,不是缓存快照)。 */
  private playerById(id: string): WorldPlayer | undefined {
    if (!this.playerIds.has(id)) return undefined;
    const b = this.physics.bodies.get(id);
    if (b === undefined) return undefined;
    return {
      id,
      x: b.x,
      y: b.y,
      z: b.z,
      facingDeg: b.facingDeg ?? 0,
      afk: false,
      heldItem: 0,
      wearing: [],
      playingInstrument: false,
    };
  }

  /** 登记一个「玩家」:物理刚体 + AOI 唤醒源,一次注册两处保持一致。 */  addPlayer(id: string, x: number, y: number): void {
    this.physics.spawn(id, { x, y, z: 0 });
    this.aoi.registerMob(id, x, y);
    /* 记账 —— 供 syncPlayers 区分玩家与生物(两者都在 physics.bodies 里) */
    this.playerIds.add(id);
    /* 登记生命值 —— 漏了这一步的表现是「生物打玩家永远不掉血」,
       因为 vitals.applyHit 找不到该玩家就静默返回 0 伤害。 */
    this.vitals.register(id);
    this.syncPlayers();
  }

  /** 移除玩家(生命值一并清掉)。 */
  removePlayer(id: string): boolean {
    const had = this.playerIds.delete(id);
    this.vitals.unregister(id);
    this.physics.bodies.delete(id);
    this.aoi.unregisterMob(id);
    this.syncPlayers();
    return had;
  }

  /** 治疗玩家(料理 / 药水 / 队友技能)。返回实际回复量。 */
  healPlayer(id: string, amount: number): number {
    return this.vitals.heal(id, amount);
  }

  /** 复活玩家(满血)。 */
  revivePlayer(id: string, hp?: number): boolean {
    return this.vitals.revive(id, hp);
  }

  /** 已注册的玩家数。 */
  get playerCount(): number {
    return this.playerIds.size;
  }

  /* ── 存档接口:AI 记忆(WS-04 未决 §430) ── */

  /**
   * 导出全部生物的 AI 记忆(可 JSON 序列化)。
   *
   * 转发到 `mobHost.exportMem()`,让编排层成为**存档的唯一入口** ——
   * 存档系统不必知道宿主的存在,也不必自己遍历 `MobRuntime`。
   */
  exportMobMem(): Record<string, Record<string, unknown>> {
    return this.mobHost.exportMem();
  }

  /** 导入 AI 记忆(与 `exportMobMem` 对偶)。返回写入/跳过计数。 */
  importMobMem(data: Record<string, Record<string, unknown>>): { applied: number; skipped: number } {
    return this.mobHost.importMem(data);
  }

  /**
   * 导出玩家生命值(WS-05 D7:玩家 HP 未持久化)。
   *
   * `PlayerVitals` 由编排层持有(`VitalsSystem`),因此「谁能提供 HP」的答案
   * 只能在这里。`users.hp` 字段在 DB 层早已存在,缺的是**从运行时取值**这一段。
   */
  exportVitals(): Record<string, { hp: number; maxHp: number; downed: boolean }> {
    const out: Record<string, { hp: number; maxHp: number; downed: boolean }> = {};
    for (const id of this.vitals.ids()) {
      const v = this.vitals.get(id);
      if (!v) continue;
      out[id] = { hp: v.hp, maxHp: v.maxHp, downed: v.downed };
    }
    return out;
  }

  /**
   * 导入玩家生命值(重连/读档)。返回实际生效的玩家数。
   *
   * 用 `revive(id, hp)` 而非直接改 `v.hp`:它顺带清掉 `downed` 与 `iframeSec`,
   * 否则「倒下状态」会被一起读回来,玩家一上线就是倒地不起。
   * 未登记的玩家跳过 —— 与 `importMobMem` 同一条理由。
   */
  importVitals(data: Record<string, { hp: number; maxHp?: number; downed?: boolean }>): number {
    let applied = 0;
    for (const id of Object.keys(data).sort()) {
      const v = this.vitals.get(id);
      if (!v) continue;
      const row = data[id];
      if (!row || typeof row.hp !== 'number' || !Number.isFinite(row.hp)) continue;
      /* 钳到 [0, maxHp]:满血 100 的玩家不该因为一份脏存档变成 5 位数。
         `VitalsSystem` 的 maxHp 是构造期常量,不信任存档里的 maxHp 字段。 */
      const hp = Math.max(0, Math.min(v.maxHp, row.hp));
      this.vitals.revive(id, hp);
      applied += 1;
    }
    return applied;
  }

  /* ── 存档闭环:HP 与生物 mem 真正落盘(WS-05 D7 / WS-04 §430) ── */

  /**
   * 把本世界的运行时状态写进 DB。返回各段落的写入计数,供调用方断言。
   *
   * ## 为什么 db 走**参数**而不进构造器
   *
   * `new WorldSim({ sizeCells })` 在 17 个套件里被当成纯对象使用,
   * 构造器一旦依赖 DB,所有测试都得先搭库;而模拟层的确定性也不该
   * 被「有没有库」左右。故存档是**显式动作**,不是构造副作用。
   *
   * ## 两段落盘的语义差别
   *
   * - **HP**:写 `users.hp`,只写战斗里真实变化的字段,不碰 `max_hp`
   *   (那是成长派生量,见 `saveVitalsToUsers`)。
   * - **mem**:写 `rooms.mob_mem_json`,房间级世界状态。
   *
   * `memRow` 是 `UPDATE` 的影响行数 —— 0 表示房间不存在,**存档没落地**。
   * 把它返回出来而不是吞掉:否则「房间没建就存档」会静默成功,
   * 正是本仓反复出现的「函数被调用过 = 以为生效了」那类缺陷。
   */
  saveToDb(
    db: DbLike,
    roomId: string,
    nowMs: number,
  ): { hpSaved: number; hpSkipped: number; memRow: number } {
    const v = saveVitalsToUsers(db, this.exportVitals(), nowMs);
        const memRow = saveRoomMobMem(db, roomId, this.exportMobMem(), nowMs);
    return { hpSaved: v.saved, hpSkipped: v.skipped, memRow };
  }

  /**
   * 从 DB 读回状态并应用到当前世界(与 `saveToDb` 对偶)。
   *
   * 先 HP 后 mem:两者互不依赖,但**顺序固定**才能让返回值可复现。
   * 读回的 HP 走 `importVitals`(内部用 `revive`),因此 `downed` 会被清掉 ——
   * 这是刻意的:D6(死亡/复活流程)未开,还原成 `downed=true` 会让玩家永久倒地。
   */
  loadFromDb(
    db: DbLike,
    roomId: string,
  ): { hpApplied: number; memApplied: number; memSkipped: number } {
    const hpApplied = this.importVitals(loadVitalsFromUsers(db, this.vitals.ids()));
    const mem = this.importMobMem(loadRoomMobMem(db, roomId));
    return { hpApplied, memApplied: mem.applied, memSkipped: mem.skipped };
  }

  /** 从 AOI 的当前状态重建玩家列表(位置每帧会变,必须同步)。 */
  private syncPlayers(): void {
    const list: AoiPlayer[] = [];
    /*
     * `PhysicsWorld.bodies` 是 **Map<string, DynamicBody>**,不是数组。
     * 写成 `bodies.length` 会得到 `undefined`,而 `undefined ?? 0` 静默变成 0 —— 
     * 于是「有 5 个刚体」被报告成「0 个刚体」,快照看起来像世界空了。
     * 这里显式按 Map 遍历。
     */
    for (const b of this.physics.bodies.values()) {
      list.push({ id: b.id, x: b.x, y: b.y, afk: false });
    }
    this.players = list;
    this.aoi.setPlayers(this.players);

    /*
     * 同步给生物 AI 的玩家视图。
     *
     * **必须按 `playerIds` 过滤**。`physics.bodies` 里玩家与生物**混在一起**
     * (`addPlayer` 和 `addMob` 都调 `physics.spawn`),直接把它当玩家列表
     * 会让生物**互相视为玩家**:野猪会把绵羊当猎物冲锋、`nearest()` 返回
     * 另一只生物。这个错误不报错 —— 表现是「生物莫名的攻击性」。
     *
     * 漏掉整个 `mobPlayers` 同步则更隐蔽:25 个 AI 的
     * `BaseMobAi.nearest()` 只读 `world.players()`,为空时恒返回 `null`,
     * 于是所有「发现玩家」的行为(冲锋/伏击/逃跑/驯化)**永不触发**,
     * 而 `tick` 确实在跑、不抛异常 —— 生物只是安静地站着。
     * 实测证据:未同步时 `mob_boar` 的 `mem` 是 `{}`。
     */
    this.mobPlayers = this.players
      .filter((p) => this.playerIds.has(p.id))
      .map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        z: 0,
        facingDeg: 0,
        afk: p.afk,
        heldItem: 0,
        wearing: [],
        playingInstrument: false,
      }));
  }

  /** 注册一只生物:物理刚体 + AOI 记录 + 刷怪计数 + **宿主登记**。 */
  addMob(id: string, biome: string, x: number, y: number): void {
    this.physics.spawn(id, { x, y, z: 0 });
    this.aoi.registerMob(id, x, y);
    this.spawner.add(biome, 1);
    /* 登记到宿主 —— 漏了这一步的表现是「AOI 唤醒了它,但宿主不认识,
       于是安静地跳过」:生物不动、不报错,像世界空了。 */
    const def = MOB_BY_ID.get(id);
    if (def) this.mobHost.addMob(id, def, x, y, { anchorX: x, anchorY: y });
    else this.unknownMobs.push(id);
  }

  /**
   * 注册时 `MOB_BY_ID` 里查不到的 ID。
   *
   * 不静默忽略:调用方传了错 ID(拼写、用了未登记的字符串)时,
   * 生物会「存在但不行为」—— 这是最难查的一类,因为它看起来像
   * 「这个生物的设计就是不动的」。收集起来供断言。
   */
  readonly unknownMobs: string[] = [];

  /** 给生物 AI 用的玩家视图(供 `MobWorld.players()`)。 */
  setMobPlayers(players: WorldPlayer[]): void {
    this.mobPlayers = players;
  }

  /** 给生物 AI 的地面掉落物(供 `MobWorld.groundItems()` / `spawnItem`)。 */
  setGroundItems(items: GroundItem[]): void {
    this.mobGround = items;
  }

  /** 地面掉落物只读视图。 */
  get groundItems(): readonly GroundItem[] {
    return this.mobGround;
  }

  /**
   * 玩家生命值 —— 生物攻击的结算目标。
   *
   * **为什么放在编排层而不是 `WorldPlayer`**:`WorldPlayer` 是 WS-04
   * (`behaviors.ts`)的接口,加 `hp` 会让它的 55 条断言与假 `MobWorld` 全改。
   * 而职责上 AI 只需要「玩家在哪、在做什么」,不需要知道剩多少血。
   */
  readonly vitals = new VitalsSystem();

  /** 最近一次慢帧的命中结果(诊断用)。 */
  lastHits: MobHitResult[] = [];
  /** 累计命中次数。 */
  hitCount = 0;
  /** 累计检查过的预警几何数(诊断用:为 0 说明 AI 从没产出过预警)。 */
  warnsChecked = 0;

  /**
   * 把本帧活跃生物产出的预警几何与玩家位置对照并结算。
   *
   * **为什么用 `warns` 而不是新增 `MobWorld.damagePlayer`**:
   * 25 个 AI 已经通过返回 `WarnGeom` 表达了「将要打哪里、多大范围、多久后生效」
   * (实测 400 帧产生 220 个带 `radius`/`warnSec`/`z` 的真实几何)。
   * 给接口加方法会逼 25 个 AI 各写一遍命中判定,而 `WarnGeom` +
   * `warnHitsPlayer` 已经把这件事做完了 —— 缺的只是「有人去结算」。
   *
   * 两种写法都不改冻结层;选前者是因为它复用已有产出,而后者会
   * 让 25 个 AI 各有一套「我打中了吗」的判断,必然漂移。
   */
  private resolveMobStrikes(): void {
    const players = this.players.map((p) => {
      const body = this.physics.bodies.get(p.id);
      return { id: p.id, x: body ? body.x : p.x, y: body ? body.y : p.y, z: body ? body.z : 0 };
    });

    const strikes: PendingStrike[] = [];
    for (const t of this.lastMobTicks) {
      if (t.error !== null || t.warns.length === 0) continue;
      const rt = this.mobHost.runtimeOf(t.id);
      if (!rt || !rt.alive) continue;
      for (const w of t.warns) {
        strikes.push({ attackerId: t.id, attackerLevel: rt.def.level, warn: w });
      }
    }
    /* ── 第二条通道:事件型攻击 ──
       蝎子伏击(`scorpion_ambush`)、穿山甲滚撞(`pangolin_wall_stun`)
       用事件而非预警几何表达,若只结算预警则它们**打到玩家也不掉血**。
       两种通道都存在是设计事实(实测确认),不是重复实现。 */
    const eventStrikes = collectEventStrikes(
      this.mobHost.frameEmits,
      (id) => {
        const rt = this.mobHost.runtimeOf(id);
        return rt ? { x: rt.x, y: rt.y } : null;
      },
      (id) => this.mobHost.runtimeOf(id)?.def.level ?? 1,
    );
    for (const e of eventStrikes) strikes.push(e);

    if (strikes.length === 0 || players.length === 0) {
      /* 即使没有攻击,**计时器也要推进** —— 否则无敌帧永不结束
         (表现是「被打一次之后再也不掉血」),回血也永不发生。 */
      this.vitals.beginFrame();
      this.vitals.stepTimers(SIM_SLOW_DT);
      this.lastHits = [];
      return;
    }

    this.vitals.beginFrame();
    const strikeResult = resolveStrikes(
      strikes,
      players,
      undefined,
      new Set(this.vitals.ids().filter((id) => (this.vitals.get(id)?.iframeSec ?? 0) > 0)),
    );
    this.warnsChecked += strikeResult.warnsChecked;

    const applied: MobHitResult[] = [];
    for (const h of strikeResult.results) {
      const rt = this.mobHost.runtimeOf(h.attackerId);
      const lv = rt ? rt.def.level : 1;
      const res = this.vitals.applyHit(h.attackerId, h.playerId, lv, 1.0, h.distance);
      if (res.applied > 0) {
        applied.push(res);
        this.hitCount += 1;
        /* 事件:UI 与音效靠它播受击反馈,而不用每帧轮询血量 */
        this.bus.emit(
          'player_hit',
          { playerId: res.playerId, attacker: res.attackerId, damage: res.applied, hp: this.vitals.get(res.playerId)?.hp ?? 0 },
          res.attackerId,
        );
        if (res.downed) {
          this.bus.emit('player_downed', { playerId: res.playerId, by: res.attackerId }, res.attackerId);
        }
      }
    }
    this.lastHits = applied;
    this.vitals.stepTimers(SIM_SLOW_DT);
  }

  /** 给 `SpawnWorld` 用的适配器,把 WorldGrid 的格查询转成刷怪层要的语义。 */
  private spawnWorld(): SpawnWorld {
    return {
      objAt: (x: number, y: number) => this.grid.objIdAt(x, y),
      floorAt: (x: number, y: number) => this.grid.floorIdAt(x, y),
      blocked: (x: number, y: number) => this.grid.objIdAt(x, y) !== 0,
      townCenter: () => ({ x: (this.sizeCells / 2) | 0, y: (this.sizeCells / 2) | 0 }),
      isNight: () => false,
    };
  }

  /**
   * 推进一帧。
   *
   * 帧类型由**帧序**决定:偶数帧快帧、每第 10 帧同时是慢帧。
   * 这样 10 个快帧恰好对应 1 个慢帧,不依赖浮点累加 —— 
   * 用 `accumulator += dt` 判断会让「第几次慢帧」受浮点误差影响,
   * 长跑后出现 119 或 121 次的偏差(这是粒子发射器踩过的同一个坑)。
   */
  tick(): SimFrameReport {
    this.frameCount += 1;
    const frame = this.frameCount;
    const isSlow = frame % FAST_PER_SLOW === 0;

    let physics: StepReport | null = null;
    let activeMobs = 0;
    let fluidProcessed = 0;
    let fluidActive = 0;
    let fluidMoved = 0;
    /* 本慢帧被写回 OBJ 层的相变产物数(黑曜石 / 多孔浮石)。 */
    let phaseProducts = 0;
    let wireCellsFlooded = 0;
    let wireCellsLive = 0;
    let componentsEvaluated = 0;
    let spawned = 0;

    /* ── 快帧 20Hz:物理 ── */
    physics = this.physics.step(SIM_FAST_DT);
    this.syncPlayers();

    if (this.mobsOn) {
      /* ── 慢帧 2Hz:AOI 唤醒 / 休眠 ──
         `update()` 才是**决定谁该被推进**的那一步;`stepActive` 只遍历
         已被唤醒的集合。只调 `stepActive` 不调 `update`,集合恒为空,
         表现成「活跃生物数永远 0」「生物不动」——
         而既不报错也不抛异常,只是默默什么都不做。
         生态模拟只跑慢帧:手册 §2.4 明确「打盹玩家不提供唤醒能量」。 */
      if (isSlow) {
        this.aoi.update();
        /* ── 慢帧 2Hz:生物 AI ──
           这里此前是**空回调** —— `stepActive` 遍历了唤醒集合却什么都不做,
           所以 25 个 AI 的 `tick` 实现一行都没跑过。
           现在直接把 AOI 唤醒集合交给宿主推进(见 mobs/host.ts)。

           用 `activeMobs` 而非 `stepActive(fn)`:后者的回调签名不带 ID,
           而宿主需要 ID 才能推出「谁在 tick」以正确标注 emit 的 source
           (25 个 AI 的 30 处 emit 都不传自己的 ID)。
           为此也不再调用 `stepActive`,改由宿主推进 —— 否则
           `activeStepCalls` 记账会与实际 tick 次数脱节。
           代价:`aoi.activeStepCalls` 不再自增,由 `mobHost.totals.ticks` 取代。 */
        /* 只推进一次,并把结果留作诊断 —— 早先写成「调两次,一次推进一次
           只为读结果」会**每慢帧推进两次 AI**,行为速度凭空翻倍。
           这类错误不报错、测试也可能照过(只是快了 2 倍),很难发现。 */
        this.lastMobTicks = this.mobHost.tickMobs([...this.aoi.activeMobs], SIM_SLOW_DT);
        activeMobs = this.aoi.activeMobs.size;
        this.mobErrors += this.lastMobTicks.filter((t) => t.error !== null).length;
        /* ── 慢帧 2Hz:预警几何 → 玩家伤害结算 ──
           AI 在 `tick` 里产出的 `WarnGeom` 是「将要打哪里、多大范围、多久后生效」。
           此前没有任何地方结算它们 —— 16 只敌对/捣蛋生物的攻击打不到玩家。
           见 server/src/combat/vitals.ts 与 docs/DAMAGE-LOOP.md。 */
        this.resolveMobStrikes();
      } else {
        activeMobs = this.aoi.activeMobs.size;
      }
    }

    /* ── 快帧 20Hz:事件投递 ──
       每帧末尾清空当帧队列。放在物理与 AI 之后,使同一帧内 AI 产生的事件
       在下一帧被订阅方看到 —— 刻意**不**在同帧内递归投递到底:
       那会让「谁先响应」取决于 emit 顺序,难以推理,也放大了死循环风险。 */
    this.bus.drain();

    if (isSlow) {
      /* ── 慢帧 2Hz:举投冷却 ──
         
         `CarrySystem.tick` 只做一件事:递减投掷冷却表。**漏掉它的后果是
         「冷却永不过期」** —— 玩家投掷一次之后永久不能再投,而 `cooldown`
         是个私有 Map,从外面看不出异常。这类「表在、但没人推进」的缺陷
         不会抛错、不会让任何既有断言变红。

         放在慢帧是因为冷却常量以秒为单位(`THROW_COOLDOWN_SEC`),
         2Hz 的 dt=0.5 与它同量纲;快帧调用只会让冷却以 10 倍速消掉。 */
      this.carry.tick(SIM_SLOW_DT);

      /* ── 慢帧 2Hz:流体 ── */
      if (this.fluid !== null) {
        const fr = this.fluid.step(this.fluidBudget);
        fluidProcessed = fr.processed;
        fluidActive = fr.active;
        fluidMoved = fr.moved;
        /* ── 相变产物写回 OBJ 层(必须紧跟 step,不能漏) ──
         *
         * `FluidField.phasePass()` 在 step 内部把「水 + 熔岩」接触面的产物
         * (黑曜石 110 / 多孔浮石 111)**排进 `pendingObj` 队列**,
         * 但流体模块自己**不写地形** —— 它没有 `WorldGrid` 的引用,
         * 这是刻意的职责分离。于是**必须由编排层取走并写回**:
         * 这里 `drainPhaseProducts()` 清空队列,再经 `setCell({ obj })` 落到 OBJ 层。
         *
         * 漏掉这一步的后果是**静默的**:`step` 正常返回、`phaseChanges` 计数正常、
         * 守恒式也闭合(水与熔岩都确实销毁了),只是产物永远停在队列里 ——
         * 玩家把水浇到熔岩上,那一格**不会出现黑曜石**,
         * 而队列会随相变次数无界增长(内存泄漏形状)。
         *
         * 这正是 `docs/FOUNDATION-AUDIT.md` §3.1 缺陷 A 的落点:
         * `drainPhaseProducts()` 早就实现了、WS-01 的 3 条断言也全绿,
         * 只是**没有任何生产代码调用它** —— 典型「实现完整、单测全绿、编排层不接」。
         * 修复前实测:水邻熔岩跑 1 帧后 `pendingObj.length === 8`,再跑 500 帧仍是 8。
         */
        for (const p of this.fluid.drainPhaseProducts()) {
          this.setCell(p.x, p.y, { obj: p.obj });
          phaseProducts += 1;
        }
      }

      /* ── 慢帧 2Hz:电路泛洪 ──
         `drive` 是**帧内**状态:每帧都要重新施加,否则第一次 tick 之后再无驱动态,
         泛洪统计会一直停在 0(模式退化成 IDLE)。 */
      if (this.wiringOn) {
        for (const d of this.wireDrives) {
          this.wiring.drive(d.x, d.y, d.color, d.on);
        }
        const st = this.wiring.tick();
        wireCellsFlooded = st.cellsFlooded;
        /*
         * `cellsFlooded` 是**增量**:结构不变时正确的值是 0(增量优化生效),
         * 只有第一帧或拓扑变化后才非零。把它当成「电路是否通」的指标会误判 —— 
         * 稳态下它会一直报 0,看起来像电路断了。
         * 真正表示「有多少格通电」的是 `totalLiveCells()`。
         */
        wireCellsLive = this.wiring.totalLiveCells();
        /* 与 `wireCellsLive` 分开报:那个只说明「线通电了」,
           这个才说明「件真的被求值了」。两者相等不代表接线正确 ——
           注册表为空时 `wireCellsLive` 照样非零(泛洪由 `drive` 驱动,与件无关)。 */
        componentsEvaluated = st.componentsEvaluated;
      }

      /* ── 慢帧 2Hz:刷怪决策 ── */
      if (this.mobsOn) {
        const ctx: SpawnContext = {
          biome: 'PLAINS',
          x: (this.rng() * this.sizeCells) | 0,
          y: (this.rng() * this.sizeCells) | 0,
          biomeCount: this.spawner.state.biomeCounts.get('PLAINS') ?? 0,
          globalCount: this.spawner.state.globalCount,
          mobId: 'WILDLIFE',
        };
        if (this.spawner.canSpawn(ctx, this.spawnWorld(), this.rng())) spawned += 1;
      }
    }

    return {
      frame,
      phase: isSlow ? 'SLOW' : 'FAST',
      /*
       * `frame` 永远是**快帧计数**,所以模拟时间恒为 `frame / TICK_HZ`。
       * 曾经写成 `isSlow ? frame / SLOW_TICK_HZ : frame / TICK_HZ` —— 
       * 慢帧那一支把时间除以 2 而不是 20,于是慢帧报告的时间**快了 10 倍**
       * (第 10 帧报 5.00 秒,真值是 0.5 秒)。帧序的单位不随相位改变,
       * 这里分支是纯粹的逻辑错误。
       */
      simSeconds: frame / TICK_HZ,
      physics,
      activeMobs,
      fluidProcessed,
      fluidActive,
      fluidMoved,
      phaseProducts,
      wireCellsFlooded,
      wireCellsLive,
      componentsEvaluated,
      spawned,
    };
  }

  /** 连推 n 帧,返回**慢帧**的汇总(快帧汇总意义不大,慢帧才是世界状态的真实推进)。 */
  run(frames: number): { frames: number; slowFrames: number; reports: SimFrameReport[] } {
    const n = Math.max(0, Math.trunc(frames));
    const reports: SimFrameReport[] = [];
    let slowFrames = 0;
    for (let i = 0; i < n; i += 1) {
      const r = this.tick();
      reports.push(r);
      if (r.phase === 'SLOW') slowFrames += 1;
    }
    return { frames: n, slowFrames, reports };
  }

  /** 运行到指定模拟秒数(向上取整到整帧)。 */
  runForSeconds(seconds: number): { frames: number; slowFrames: number } {
    const frames = Math.max(0, Math.round(seconds * TICK_HZ));
    const r = this.run(frames);
    return { frames: r.frames, slowFrames: r.slowFrames };
  }

  /** 当前帧序。 */
  get frame(): number {
    return this.frameCount;
  }

  /** 当前模拟时间(秒)。 */
  get simSeconds(): number {
    return this.frameCount / TICK_HZ;
  }

  /** 一份便于断言与调试的快照。 */
  snapshot(): {
    frame: number;
    simSeconds: number;
    bodies: number;
    chunks: number;
    fluidTotal: number;
    wireCells: number;
    mobs: number;
  } {
    return {
      frame: this.frameCount,
      simSeconds: this.frameCount / TICK_HZ,
      bodies: this.physics.bodies.size,
      chunks: this.grid.chunks.size,
      fluidTotal: this.fluid.total(),
      wireCells: this.wiring.wiredCellCount(),
      mobs: this.aoi.mobCount,
    };
  }
}