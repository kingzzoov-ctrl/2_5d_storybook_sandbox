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
import {
  tickLogistics,
  loadConveyor,
  type ArmWorld,
  type ArmState,
  type ConveyorState,
  type DrillState,
  type LogisticsLine,
  type LogisticsTickReport,
  type SorterState,
  type Stack,
} from '../wiring/logistics.ts';
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
/*
 * ── 炼金炉(WS-06)—— 2026-11-12 接线 ──
 *
 * 此前 `alchemy/` 整个目录(3,626 行 / 8 个文件)在生产里**零引用**:
 * `verify.ts` 的可达性门禁把 `index.ts` 与它的 6 个内部模块全列在白名单里,
 * 理由写的是「随 index 一起接」—— 也就是说**接线本身还没开始**,
 * 而不是「差最后一根线」。后果:门禁、缓存、五步算法、像素立牌
 * 全部单测全绿,但玩家永远合成不出任何东西。
 *
 * 这里接的是**离线/降级路径**(`degrade.ts` 的文件头把「客户端连的是离线
 * 单机房间」列为它存在的第一公民场景)。为什么要接这条路而不是等网关:
 * `cache.ts` 的 `LlmClient` 是**依赖注入契约**,生产侧实现(HTTP / 密钥 /
 * 退避 / 限流)属于网关层,本仓不存在也不该存在。默认注入
 * `StubLlmClient` ⇒ 重试耗尽后走 `degradeGenerate`,六条链路**全部真实执行**:
 *   gate.checkGate → cache.RecipeCache → prompt + LLM → degrade → attributes.rollStats → pixel_icon.buildIcon
 * 等真网关出现时,`WorldSimOptions.alchemy` 注入即可,编排层无需改动。
 */
import {
  createAlchemyService,
  type AlchemyService,
  type ForgeResult,
} from '../alchemy/index.ts';
import { MemoryRecipeStore, StubLlmClient } from '../alchemy/cache.ts';
/*
 * ── Boss 副本(WS-05)—— 2026-11-12 接线 ──
 *
 * `bosses/` 三个文件 1,261 行此前在生产里零引用(见 `bossRaid` 字段注释)。
 * 这里只 import 运行时容器;破防/阶段/掉落的算法仍留在各自模块,
 * 本层不复制任何一条判定。
 */
import {
  BossRaidRuntime,
  type BossSnapshot,
  type BossTickReport,
} from '../bosses/runtime.ts';
import type {
  OfferingPort,
  SummonWithOfferingRequest,
  SummonWithOfferingResult,
} from '../bosses/raid.ts';
import type { BreakResult } from '../bosses/breaks.ts';

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
  /**
   * 炼金服务覆盖。缺省时构造一个**离线可用**的实现
   * (`MemoryRecipeStore` + `StubLlmClient` + `allowDegrade=true`),
   * 走「LLM 重试耗尽 → 本地确定性降级」路径,不联网也能出产物。
   * 真网关实现由部署层注入。
   */
  alchemy?: AlchemyService;
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
  /**
   * 炼金炉服务(WS-06)—— 六条链路的唯一编排出口。
   *
   * 接的是**离线路径**:默认注入 `StubLlmClient`,于是
   * `gate → cache → prompt/LLM → degrade → rollStats → buildIcon`
   * 每一步都真实执行,产物带完整中间量(`breakdown` / `icon` / `reaction`)。
   */
  readonly alchemy: AlchemyService;
  /**
   * Boss 副本运行时(WS-05)—— 2026-11-12 接线。
   *
   * 此前 `bosses/` 三个文件(`raid` 413 + `phases` 401 + `breaks` 447 = 1,261 行)
   * 在生产里**零引用**:`verify.ts` 的可达性门禁把三条全挂在白名单里,
   * 理由写「待接入 tickMobs」—— 也就是**接线还没开始**,而不是「差最后一根线」。
   * 后果:八条破防、三阶段技能、人数缩放、个人掉落全部单测全绿,
   * 但玩家永远召不出 Boss、也永远打不破防。
   *
   * **为什么不能挂 `tickMobs`**:8 个 Boss **全部不在** `MOB_BY_ID` 里
   * (实测 `addMob('boss_jelly_king', …)` → `undefined`),`MobHost` 里
   * 根本没有 Boss 实体,挂过去等于挂在空集合上。故用独立容器持有 `BossState`。
   *
   * **为什么挂慢帧**:`tickBoss` 的 `dt` 以秒计(`CAST_INTERVAL_SEC` /
   * `TIME_SHIELD_SEC` / `stunnedSec` 全是秒),与 `SIM_SLOW_DT = 0.5` 同量纲;
   * 挂快帧会让护盾/眩晕以 10 倍速流失 —— 不报错,但行为全错。
   */
  readonly bossRaid: BossRaidRuntime;

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
  /**
   * 最近一次慢帧的 Boss 推进结果(供诊断与断言)。
   *
   * 与 `lastMobTicks` 同一模式:把「这一帧推进了几个 Boss、谁切了阶段」
   * 暴露成可观测量。没有它,「Boss 没接线」与「Boss 在场但恰好没切阶段」
   * 从外面看不出区别。
   */
  lastBossTick: BossTickReport = { ticked: 0, phaseSwitched: [], stunEnded: [] };
  /**
   * 最近一次慢帧的**物流推进结果**(供诊断与断言)。
   *
   * 为什么需要它:`wiring/components.ts` 的 `LOGISTICS_*` 求值器**只维护
   * 通电标志**(`running`/`powered`),从不搬运物品;真正的搬运逻辑在
   * `wiring/logistics.ts`(`stepConveyor`/`stepSorter`/`stepArm`/`stepDrill`)。
   *
   * 这两份曾经**互不引用** —— 后果是「件通电了,但货一动不动」:
   * `componentsEvaluated` 非零、`running=1`,而 `movedCells` 恒为 0。
   * 这类缺陷不会抛错,也不会让既有断言变红(WS-08 第 13 节测的是纯函数,
   * 全都绿);只有断言「生产真的搬运」时才暴露。
   */
  lastLogisticsTick: LogisticsTickReport = {
    beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0,
  };
  /**
   * 物流流水线节点表:由 `SignalGraph` 里已注册的 `LOGISTICS_*` 件**每慢帧重建**。
   *
   * 刻意不缓存成长期状态:件的增删/移动由 `addComponent` / `removeComponent`
   * 驱动(生产里还可能随存档恢复重建),缓存会与真实件表脱节。
   * 重建成本 O(件数),LOGISTICS_* 件典型数量在个位数到几十。
   */
  private readonly logisticsBelts = new Map<string, ConveyorState>();
  private readonly logisticsSorters = new Map<string, SorterState>();
  private readonly logisticsArms = new Map<string, ArmState>();
  private readonly logisticsDrills = new Map<string, DrillState>();

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

    /*
     * 炼金炉:默认离线可用。`StubLlmClient` 恒返回 null ⇒
     * `generateWithRetry` 走满 MAX_RETRY 后回退 `degradeGenerate`,
     * 于是**不联网也能出产物**,且六条链路都被真实执行过。
     * 若将来接了真网关,从 `opts.alchemy` 注入即可,此处无需改动。
     */
    this.alchemy = opts.alchemy ?? createAlchemyService({
      store: new MemoryRecipeStore(),
      llm: new StubLlmClient(),
      allowDegrade: true,
    });

    /* Boss 副本运行时(WS-05)。构造即接线 —— 没有开关:
       「默认关着」正是这个缺陷能潜伏五轮的原因。 */
    this.bossRaid = new BossRaidRuntime();
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
   * 就地炼金:消耗**地面掉落物**里的材料,产出成品(WS-06 接线入口)。
   *
   * ## 为什么这是必需的编排层入口
   *
   * `alchemy/` 8 个文件、3,626 行此前在生产里**零引用**,整目录挂在
   * `verify.ts` 白名单里(理由「随 index 一起接」)。子系统完整、WS-06
   * 的 399 条断言全绿,但**没有任何玩家能合成出东西** —— 与
   * `interactMob` / AI tick / CarrySystem 完全同一类缺口。
   *
   * ## 总量守恒(DEV-PLAN 1.5 的验收条件)
   *
   * 「合成消耗原料产出成品,总量守恒」在这里被拆成两个**可失败**的检查:
   *   1 **消耗必须真的发生**:材料按 `materialIds` 从地面逐个扣减;
   *      扣不满就**整体放弃**(不落库、不扣任何料),避免「产出了但料还在」。
   *   2 **产物必须真的落地**:成品作为一件掉落物写回地面,
   *      于是 `材料件数 → 成品件数` 是可对账的,而不是只返回一个对象。
   *
   * 判据是**扣减后的实际地面状态**,不是「我调了 forge」。这一点很关键:
   * 只返回 `ForgeResult` 而不动世界,就等于把「函数被调用过」当成「生效了」
   * —— 本仓反复出现的那类假接线。
   *
   * @param itemIds 投入的材料 ID(2~4 件,可含梦境露水 130)
   * @param opts    `playerName` 冠名 / `seed` 固定随机种子 / `lvProf` 专精等级
   * @returns `ok:false` 时**世界完全未被改动**;`ok:true` 时附带 `consumed` 账
   */
  async forgeAlchemy(
    itemIds: readonly number[],
    opts: { playerName?: string; seed?: number; lvProf?: number; useDew?: boolean; x?: number; y?: number } = {},
  ): Promise<
    | { ok: true; result: Extract<ForgeResult, { ok: true }>; consumed: { itemId: number; count: number }[]; spawned: { x: number; y: number } }
    | { ok: false; stage: 'INVENTORY' | 'GATE' | 'LLM' | 'ROLL'; message: string }
  > {
    /*
     * 1 先**预演**门禁:不过门就跟世界无关,直接返回。
     * 用 `preview` 而非直接 forge,是为了在**动手扣料之前**就知道会不会过 ——
     * 门禁失败绝不消耗材料,否则玩家丢错东西就永久损失。
     */
    const gate = this.alchemy.preview(itemIds, opts.useDew === true);
    if (!gate.pass) {
      return { ok: false, stage: 'GATE', message: gate.message };
    }

    /* 2 材料必须在**地面**上真的存在(够扣)。露水不从材料位扣(门禁已剥离)。 */
    const need = new Map<number, number>();
    for (const id of gate.materialIds) need.set(id, (need.get(id) ?? 0) + 1);
    for (const [id, want] of need) {
      let have = 0;
      for (const g of this.mobGround) if (g.itemId === id) have += g.count;
      if (have < want) {
        return {
          ok: false,
          stage: 'INVENTORY',
          message: `材料不足:需要 ${want} 件 ${id},地面只有 ${have} 件`,
        };
      }
    }

    /* 3 走到这里才真的合成。失败(如 LLM 硬失败且禁止降级)时**不扣料**。 */
    const result = await this.alchemy.forge({
      itemIds,
      playerName: opts.playerName,
      lvProf: opts.lvProf,
      useDew: opts.useDew,
      seed: opts.seed,
    });
    if (!result.ok) {
      return { ok: false, stage: result.stage, message: result.message };
    }

    /* 4 扣料:逐个 `consumeGroundItem`,并记账「实际扣了多少」。 */
    const consumed: { itemId: number; count: number }[] = [];
    for (const [id, want] of need) {
      const got = this.consumeGroundItem(id, want);
      if (got !== want) {
        /*
         * 理论不可达(第 2 步已核过库存),但**必须防守**:并发调用或
         * 中间被别的系统改过地面时,扣不满就成了「白拿产物」。
         * 这里如实返回差额,让调用方看得见,而不是静默吞掉。
         */
        consumed.push({ itemId: id, count: got });
        return {
          ok: false,
          stage: 'INVENTORY',
          message: `扣料阶段材料被改动:${id} 期望扣 ${want} 实际扣 ${got}`,
        };
      }
      consumed.push({ itemId: id, count: got });
    }

    /*
     * 5 产物落地。AI 产物按 `recipe_hash` 而不是数字 ID 标识
     * (`shared/types/alchemy.ts` 没有为奇物保留数字段位),所以这里用
     * **负的占位 ID** 表示「非表内物品」,并把权威实例信息留在返回值里。
     * 用负数而不是 0:0 是 `BaseFluid.VOID` / 「空格」的约定值,会被
     * 掉落物系统当成空槽吞掉。
     */
    const x = Math.trunc(opts.x ?? 0);
    const y = Math.trunc(opts.y ?? 0);
    this.mobGround.push({
      itemId: -1,
      x,
      y,
      count: 1,
    });
    return { ok: true, result, consumed, spawned: { x, y } };
  }

  /**
   * 从地面掉落物里扣减指定物品,返回**实际**扣减数。
   *
   * 与 `mobWorldAdapter().consumeGroundItem` 是同一份逻辑,但那个适配器
   * 只给生物 AI 用。编排层自己要扣料时不能再绕一层适配器 ——
   * 那会让「谁在扣」变得不可读。两处都只是对 `mobGround` 的遍历,
   * 真正的权威仍是这一个数组。
   */
  consumeGroundItem(itemId: number, count: number): number {
    let left = Math.max(0, Math.trunc(count));
    const want = left;
    for (let i = this.mobGround.length - 1; i >= 0 && left > 0; i -= 1) {
      const g = this.mobGround[i];
      if (g.itemId !== itemId) continue;
      const take = Math.min(left, g.count);
      g.count -= take;
      left -= take;
      if (g.count <= 0) this.mobGround.splice(i, 1);
    }
    return want - left;
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

  /* ── Boss 副本的三个生产入口(WS-05)─────────────────────────────
   *
   * **为什么不能只靠 import**:
   * 可达性门禁走的是**静态 import 图** —— `world_sim` import 了 `bosses/runtime`,
   * 图上门禁就绿了。但「图里可达」与「生产真的会执行」是两件事:
   * 本轮修的正是这个缺陷(bosses/ 三个文件 1,261 行单测全绿、生产零引用)。
   * 若只加 import 不加调用点,门禁会绿,而 `summon`/`tryBreak` 依旧**永不执行** ——
   * 只是把「不可达」换成了「可达但不调用」,缺陷形态不变。
   *
   * 所以这三个方法就是**真实的调用点**:网络层 / 交互层调用它们,
   * 它们再转发到 `bossRaid`。`tickBosses` 已由 `tick()` 每慢帧自动调用。
   */

  /**
   * 祭坛召唤(含祭品消耗,D-03)。
   *
   * `port` 由装配层注入(`db` 层把普通物品背包包成 `OfferingPort`)——
   * 编排层不 import 存储层,保持 `bosses/**` 对数据库零依赖。
   */
  summonBoss(req: SummonWithOfferingRequest, port: OfferingPort): SummonWithOfferingResult {
    return this.bossRaid.summon(req, port);
  }

  /**
   * 对 Boss 造成伤害。
   *
   * 与 `damageMob` 分开:8 个 Boss **不在** `MOB_BY_ID` 里,
   * 走 `damageMob` 会查不到 def 而静默返回 null。
   * 返回 `null` 表示该 Boss 不在场。
   */
  damageBoss(bossId: string, amount: number): { toShield: number; toHp: number } | null {
    return this.bossRaid.damage(bossId, amount);
  }

  /** 尝试破防(八条沙盒机关破防的唯一入口)。 */
  tryBreakBoss(bossId: string, input: unknown): BreakResult {
    return this.bossRaid.tryBreak(bossId, input);
  }

  /** 在场 Boss 的只读快照(供网络层同步 `boss_hud`)。 */
  bossSnapshots(): BossSnapshot[] {
    return this.bossRaid.snapshots();
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

  /* ══════════════════ 自动化物流接线(WS-08)══════════════════ */

  /**
   * 给 `logistics.ts` 的机械臂用的格子世界适配器。
   *
   * 语义映射(三处都需要显式转换,不能直接传 `this`):
   *  - `take(x,y)`:地面掉落物住在 `mobGround`(`{itemId,x,y,count}`),
   *    而物流要的是 `Stack`(`{id,count}`)——字段名不同,必须转。
   *  - `feed(deviceId,...)`:目标设备是否在场由 **OBJ 层**决定(`objIdAt`),
   *    而 `mobGround` 只记掉落物。混用会得到「机械臂对着空气投喂」。
   *  - `deviceAt(x,y)`:同上,查 OBJ 层。
   */
  private armWorld(): ArmWorld {
    return {
      take: (x: number, y: number): Stack | null => {
        for (let i = this.mobGround.length - 1; i >= 0; i -= 1) {
          const g = this.mobGround[i]!;
          if (g.x !== x || g.y !== y || g.count <= 0) continue;
          const out: Stack = { id: g.itemId, count: g.count };
          if (g.count <= 1) this.mobGround.splice(i, 1);
          else g.count -= 1;
          return out;
        }
        return null;
      },
      feed: (deviceId: number, x: number, y: number, _item: Stack): boolean => {
        /* 目标设备必须在 OBJ 层真实存在;不存在就不算投喂成功。
           返回 false 会让机械臂保持持有,下一循环继续找目标 ——
           这比「假装成功」更能暴露配置错误。 */
        const r = Math.max(1, 3);
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dx = -r; dx <= r; dx += 1) {
            if (this.grid.objIdAt(x + dx, y + dy) === deviceId) return true;
          }
        }
        return false;
      },
      deviceAt: (x: number, y: number): number => this.grid.objIdAt(x, y),
    };
  }

  /**
   * 从 `SignalGraph` 的件表重建物流流水线节点。
   *
   * 每慢帧重建:件的增删/移动由 `addComponent`/`removeComponent` 驱动
   * (存档恢复也会重建件表),缓存长期状态会与真实件表脱节。
   *
   * **幂等性**:同一件 ID 复用同一个 state 对象,因此进度/计时跨帧累积 ——
   * 若每帧新建 `ConveyorState`,传送带的 `progress` 会永远停在 0.5,
   * 表现成「通电了但永远走不满一格」,而不报任何错。
   */
  private collectLogisticsLine(): LogisticsLine {
    const belts: LogisticsLine['belts'] = [];
    const sorters: LogisticsLine['sorters'] = [];
    const arms: LogisticsLine['arms'] = [];
    const drills: LogisticsLine['drills'] = [];

    for (const comp of this.wiring.components.values()) {
      switch (comp.kind) {
        case 'LOGISTICS_CONVEYOR': {
          let st = this.logisticsBelts.get(comp.id);
          if (!st) {
            st = { progress: 0, dir: comp.params.dir ?? 1, item: null, movedCells: 0 };
            this.logisticsBelts.set(comp.id, st);
          }
          st.dir = comp.params.dir ?? st.dir;
          belts.push({ x: comp.x, y: comp.y, state: st });
          break;
        }
        case 'LOGISTICS_SORTER': {
          let st = this.logisticsSorters.get(comp.id);
          if (!st) {
            st = {
              conveyor: { progress: 0, dir: comp.params.dir ?? 1, item: null, movedCells: 0 },
              filterIds: [],
              defaultRoute: 'RIGHT',
              matchRoute: 'FORWARD',
              routed: new Map(),
            };
            this.logisticsSorters.set(comp.id, st);
          }
          const fid = comp.params.filterId ?? 0;
          st.filterIds = fid > 0 ? [fid] : [];
          sorters.push({ x: comp.x, y: comp.y, state: st });
          break;
        }
        case 'LOGISTICS_ARM': {
          let st = this.logisticsArms.get(comp.id);
          if (!st) {
            st = {
              phase: 'IDLE', elapsed: 0, held: null, targetDevice: 0,
              reach: 3, delivered: 0, idleCycles: 0,
            };
            this.logisticsArms.set(comp.id, st);
          }
          arms.push({ x: comp.x, y: comp.y, state: st });
          break;
        }
        case 'LOGISTICS_DRILL': {
          let st = this.logisticsDrills.get(comp.id);
          if (!st) {
            st = { elapsed: 0, oreId: comp.params.oreId ?? 0, produced: 0, stalledTicks: 0, buffer: null };
            this.logisticsDrills.set(comp.id, st);
          }
          st.oreId = comp.params.oreId ?? st.oreId;
          drills.push({ x: comp.x, y: comp.y, state: st });
          break;
        }
        default:
          break;
      }
    }
    return { belts, sorters, arms, drills };
  }

  /**
   * 推进一次物流(慢帧 2Hz)。**电源取自件求值结果**,不自己读线:
   * `components.ts` 已经按「绿线/手动」算好 `running`/`powered`,
   * 这里重复读线会导致两处判据不一致(一边说通电、一边说没通)。
   */
  private tickLogisticsStep(): void {
    const comps = [...this.wiring.components.values()];
    if (comps.length === 0) {
      this.lastLogisticsTick = { beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0 };
      return;
    }

    const line = this.collectLogisticsLine();
    if (line.belts.length + line.sorters.length + line.arms.length + line.drills.length === 0) {
      this.lastLogisticsTick = { beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0 };
      return;
    }

    /* 电源:按件 kind 聚合「是否至少有一个通电」。单条流水线共用一路动力,
       与 `components.ts` 里 428/429/430/431 都用 `WireColor.GREEN` 一致。 */
    const anyOn = (kind: string): boolean => {
      for (const c of comps) {
        if (c.kind !== kind) continue;
        if ((c.state.running ?? 0) > 0 || (c.state.powered ?? 0) > 0) return true;
      }
      return false;
    };

    this.lastLogisticsTick = tickLogistics(line, this.armWorld(), {
      belt: anyOn('LOGISTICS_CONVEYOR') || anyOn('LOGISTICS_SORTER'),
      arm: anyOn('LOGISTICS_ARM'),
      drill: anyOn('LOGISTICS_DRILL'),
    });

    /* 把物流侧的可观测量回写到件 state,让 `wiring.get(id).state` 能被断言 ——
       否则「件通电了但没搬运」与「件正常搬运」在件表里长得一模一样。 */
    for (const b of line.belts) {
      const st = this.logisticsBelts.get(this.componentIdOf(b.x, b.y, 'LOGISTICS_CONVEYOR'));
      if (st) {
        const c = this.wiring.get(this.componentIdOf(b.x, b.y, 'LOGISTICS_CONVEYOR'));
        if (c) { c.state.movedCells = st.movedCells; c.state.progress = st.progress; }
      }
    }
    for (const a of line.arms) {
      const id = this.componentIdOf(a.x, a.y, 'LOGISTICS_ARM');
      const c = id ? this.wiring.get(id) : undefined;
      if (c) { c.state.delivered = a.state.delivered; c.state.idleCycles = a.state.idleCycles; }
    }
    for (const d of line.drills) {
      const id = this.componentIdOf(d.x, d.y, 'LOGISTICS_DRILL');
      const c = id ? this.wiring.get(id) : undefined;
      if (c) { c.state.produced = d.state.produced; c.state.stalledTicks = d.state.stalledTicks; }
    }
  }

  /** 按 (x,y,kind) 反查件 ID。物流节点只带坐标,回写 state 时需要 ID。 */
  private componentIdOf(x: number, y: number, kind: string): string {
    for (const c of this.wiring.components.values()) {
      if (c.x === x && c.y === y && c.kind === kind) return c.id;
    }
    return '';
  }

  /**
   * 把该格的**地面掉落物**装上传送带(公开入口,供生产与测试调用)。
   *
   * 为什么必须有这个入口:`stepConveyor` 对空带(`item === null`)直接
   * `moved: false`,而 `item` 没有任何自动来源 —— 缺这一步的后果是
   * 「传送带通电正常、`running=1`、但永远搬不动任何东西」,
   * 且不抛错。装载是**外部动作**(玩家放货 / 机械臂投料),不能由 tick 自己猜。
   *
   * @returns 是否装载成功(该格无带 / 带已满 / 该格无货 都返回 false)
   */
  loadConveyorAt(x: number, y: number): boolean {
    const id = this.componentIdOf(x, y, 'LOGISTICS_CONVEYOR');
    if (id === '') return false;
    /* 惰性建表:调用方可能在**首个慢帧之前**就装载(玩家开局放货),
       而 `logisticsBelts` 由慢帧的 `collectLogisticsLine()` 填充。
       不惰性建的话,「过早装载」会静默返回 false,看起来像「这格没有传送带」。 */
    let st = this.logisticsBelts.get(id);
    if (!st) {
      const comp = this.wiring.get(id);
      st = { progress: 0, dir: comp?.params.dir ?? 1, item: null, movedCells: 0 };
      this.logisticsBelts.set(id, st);
    }
    if (st.item) return false;

    for (let i = this.mobGround.length - 1; i >= 0; i -= 1) {
      const g = this.mobGround[i]!;
      if (g.x !== x || g.y !== y || g.count <= 0) continue;
      const okLoad = loadConveyor(st, { id: g.itemId, count: g.count });
      if (okLoad) {
        this.mobGround.splice(i, 1);
        return true;
      }
      return false;
    }
    return false;
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
        /* ── 慢帧 2Hz:Boss 副本推进(WS-05)──
           阶段切换 / 时间护盾回血 / 破防眩晕倒计时全是**时间驱动**的,
           必须每帧都跑:漏掉的话「8 秒未破盾则回血」永远不会发生。

           量纲必须与 `SIM_SLOW_DT` 一致(0.5 秒)。放快帧会让护盾与眩晕
           以 10 倍速流失 —— 这类错误不抛异常,只是时间凭空快 10 倍。

           放在生物 AI **之后**:Boss 的破防输入(玩家投喂/摆机关)来自
           上一帧的世界状态,同帧内先让生物与世界结算完再推进 Boss,
           避免「谁先响应」取决于调用顺序。 */
        this.lastBossTick = this.bossRaid.tickBosses(SIM_SLOW_DT);
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
        /* ── 慢帧 2Hz:自动化物流(传送带 428 / 分拣 429 / 机械臂 430 / 钻头 431)──
           必须放在 `wiring.tick()` **之后**:物流的驱动信号来自件求值产出的
           `state`(`running`/`powered`),先跑物流会读到上一帧的标志,
           表现成「通电后晚一帧才动」——不报错,只是时序错一拍。

           为什么单独有这一步:`components.ts` 的 `LOGISTICS_*` 求值器只维护
           **通电标志**,不搬运任何物品。真正的搬运在 `wiring/logistics.ts`。
           这两份此前互不引用,于是件通电了、货却一动不动,而
           `componentsEvaluated` 与 `running` 都正常 —— 单看这些指标看不出问题。 */
        this.tickLogisticsStep();
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