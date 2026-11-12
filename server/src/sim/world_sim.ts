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
import { unpackTile, type WireColor } from '../../../shared/types/tile.ts';
import { WorldGrid } from '../world/grid.ts';
import { Chunk, type TileFields } from '../world/chunk.ts';
import { FluidField, FLUID_CELL_BUDGET } from '../world/fluid.ts';
import { PhysicsWorld, type StepReport } from '../physics/world.ts';
import { CarrySystem, CarryReject, type CarryActor, type ChainNode, type ThrowResult } from '../physics/carry.ts';
import { AoiManager, type AoiPlayer } from '../mobs/aoi.ts';
import { MobSpawner, type SpawnContext, type SpawnWorld } from '../mobs/spawner.ts';
import { SignalGraph } from '../wiring/graph.ts';
/* task-36 接线:WS-03 的建造 / 房间识别 / 蓝图接力。此前本文件对 `build/**`
   只在注释里提过一句,没有任何 import ⇒ 整目录不可达、被门禁挂白名单。 */
import { scanRooms, identifyRoom, DEFAULT_SCAN_OPTIONS, type RoomIdentity } from '../build/rooms.ts';
import { RelayQueue, buildRelayQueue, type Blueprint } from '../build/blueprint.ts';
/* task-48 房间效果消费点:把识别结果变成玩家身上的可观测增益。 */
import {
  createRoomEffectState,
  stepRoomEffects,
  roomAtCell,
  maxHpMulOf,
  type RoomEffectState,
} from '../rooms/effects.ts';
import {
  createKitchenState,
  feedStation,
  tryCook,
  potCount,
  FOOD_BY_ID,
  SOUP_POT_ID,
  KITCHEN_TABLE_ID,
  PIZZA_OVEN_ID,
  type KitchenState,
} from '../combat/cooking.ts';
import {
  tickLogistics,
  loadConveyor,
  ARM_BATCH,
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
import type { GroundItem, WorldPlayer, DamageResult } from '../mobs/behaviors.ts';
import { DamageKind } from '../mobs/behaviors.ts';
/* 玩家 → 生物 方向的伤害管线(task-33 接线)。
   `damage.ts` 与 `weapons.ts` 此前只在 `tests/**` 里被引用,生产闭包中没有它们;
   接上之后两者同时进入闭包,可达性白名单里的对应两条需一并摘除。 */
import {
  computeDamage,
  mobCombatProfile,
  makeDot,
  tickDot,
  DamageSource,
  type DotTask,
  type DamageResult as PipelineDamageResult,
} from '../combat/damage.ts';
import {
  combatantStats,
  weaponById,
  ARMOR_BY_ID,
  Element,
  BREACH_PICK,
  type SkillDef,
  type WeaponDef,
} from '../combat/weapons.ts';
/* ── task-44:WS-10 三个「实现完整、生产零引用」模块的接线(见各自接线注释)── */
import {
  KillLedger,
  createProgress,
  settleMobExp,
  applyShareResult,
  isTalentUnlocked,
  SHARE_RADIUS,
  type PlayerProgress,
  type ShareResult,
} from '../combat/progression.ts';
import {
  createDowned,
  tickGhostBubble,
  touchRevive,
  TOUCH_RADIUS,
  type DownedState,
  type EquipmentSnapshot,
  type ReviveResult,
} from '../combat/revive.ts';

/**
 * 读地面掉落物的物品 ID —— **兼容两种字段名**。
 *
 * ## 为什么需要这个函数(真缺陷,不是洁癖)
 *
 * 本仓对「地面掉落物」的 ID 字段存在**两种不一致的命名**:
 *  - 接口 `GroundItem`(mobs/behaviors.ts)声明的是 `{ id, x, y, count }`,
 *    且 `behaviors.ts:242/410/1124` 确实按 `g.id` 读;
 *  - 但生产写入侧(`spawnItem`、`forgeAlchemy` 产物)**写的是 `itemId`**,
 *    而 `world_sim.ts` 有 6 处按 `g.itemId` 读。
 *
 * 后果是**静默的数据不可见**,不是报错:
 *  - 生物 `spawnItem` 落地的货(如 `behaviors.ts:478` 的 611),
 *    被同文件 `:242` 的 `groundItems().filter(g => g.id === ...)` 永远看不到;
 *  - 实测 `consumeGroundItem(151, 3)` 对**确实存在**的 151 返回 **0**。
 *
 * 这类「同一数组两种字段名、读写各看一半」的缺陷不会抛错,只会让功能看起来
 * 时灵时不灵,所以这里统一走一个读法,兼容两侧;写入侧另行补齐两个字段
 * (见 `spawnItem` / `forgeAlchemy` 的注释),使双方都能看见。
 */
function groundItemId(g: GroundItem): number {
  return (g as { itemId?: number }).itemId ?? g.id;
}
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
   * 战斗随机源(**与 `rng` 分离**),返回 [0,1)。供暴击/闪避取数。
   *
   * ## 为什么要单开一条流(不是洁癖,是实测缺陷)
   *
   * 第一版 `attackMob` 用 `this.rng()` 取 `critRoll`/`dodgeRoll`,而
   * **同一个 `rng` 也喂给 `mobHost`(生物 AI)与 spawner**(见构造里的
   * `new MobHost(..., { rng: this.rng })`)。实测后果:
   *
   * ```
   * 0 次攻击 vs 1 次攻击 → 三个**远处、与战斗无关**的生物轨迹全部分叉:
   *   mob_boar      50.2835,50.7434 → 51.0355,49.4897
   *   mob_tanuki    40.3489,54.6323 → 37.3426,55.6306
   *   mob_squirrel  54.1809,38.3564 → 55.1844,39.4780
   *   1 次 vs 3 次攻击 → 同样分叉
   * ```
   *
   * ⇒ **玩家攻击次数成了生物 AI 的隐式输入**。这在真实游戏里是错的:
   * 玩家在 A 处砍一刀,不该改变 B 处野猪的游荡轨迹。回放/录像也会因此
   * 无法只记录世界种子重演 —— 必须额外记录完整攻击序列。
   *
   * 本仓把「同种子两次运行逐字节一致」当硬不变量(`demo.ts` 自检、
   * `verify.ts`),所以这类耦合必须切断。分离后:
   *   · 生物 AI 的随机序列**只由世界推进决定**,与玩家行为解耦;
   *   · 战斗仍确定性可复现(同种子 → 同暴击序列,只是流独立);
   *   · 想复现「含战斗」的一次运行,需同时给 `rng` 与 `combatRng` 同种子。
   *
   * **反例守卫**:断言「攻击不扰动远处生物」守住这条 —— 若有人把
   * `combatRng()` 改回 `this.rng()`,该断言立刻红。
   */
  combatRng?: () => number;
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
  /** 战斗专用随机流(与 `rng` 分离,见 `WorldSimOptions.combatRng`)。 */
  private readonly combatRng: () => number;
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
    exitsDelivered: 0, exitsDropped: 0, exitsHeld: 0,
  };
  /**
   * 物流流水线节点表:由 `SignalGraph` 里已注册的 `LOGISTICS_*` 件**每慢帧重建**。
   *
   * 刻意不缓存成长期状态:件的增删/移动由 `addComponent` / `removeComponent`
   * 驱动(生产里还可能随存档恢复重建),缓存会与真实件表脱节。
   * 重建成本 O(件数),LOGISTICS_* 件典型数量在个位数到几十。
   */
  private readonly logisticsBelts = new Map<string, ConveyorState>();

  /* ═══════════ task-44:击杀结算 / 幽灵泡泡 / 装备词条的生产接线 ═══════════ */

  /**
   * 击杀去重账本 —— `progression.settleMobExp` 的必需入参。
   *
   * ## 为什么它必须由编排层持有(而不是每次结算新建一个)
   *
   * `KillLedger` 的职责是「同一怪实例只结算一次」。若在结算处 `new KillLedger()`,
   * 每次都是空账本 ⇒ `claim()` 恒为 true ⇒ 去重**完全失效**,而来回调用
   * 10 次就发 10 份经验。这个错误不会让任何纯函数单测变红:纯函数测的是
   * 「同一账本上重复 claim 返回 false」,而缺陷在于「账本的生命周期错了」。
   *
   * ⇒ 生命周期必须与「世界」一致,故由 `WorldSim` 持有。
   */
  private readonly killLedger = new KillLedger();

  /**
   * 玩家成长档案(等级 / 经验 / 天赋钩子)。
   *
   * ⚠ **目前是编排层自建的运行时账本**,不是权威存档 —— 与 `playerById` /
   * `syncPlayers` 硬编码 `wearing: []` 同属「玩家状态权威归属未定」这一族。
   * 本轮的接线目标是让击杀**真的会结算**,不是定义存档契约(那是 US2/存档线的范围)。
   */
  private readonly progresses = new Map<string, PlayerProgress>();

  /** 最近一次击杀结算结果(供断言与 UI;null = 尚未发生击杀)。 */
  lastKillSettle: ShareResult | null = null;

  /** 本帧新产生的升级事件(玩家 ID → 升级详情),供网络层播动画。 */
  readonly pendingLevelUps = new Map<string, { from: number; to: number }[]>();

  /**
   * 倒地玩家的幽灵泡泡状态(玩家 ID → 状态)。
   *
   * 与 `vitals.ts` 的 `downed` 布尔是**两层不同的事实**:
   * `vitals.downed` 是「HP 归零」这个**瞬时判定**(VitalsSystem 的职责),
   * `DownedState` 是「泡泡位置 / 救援进度 / 无敌计时」这套**持续状态机**。
   * 两者必须同步,但一个是布尔、一个是状态对象,不能合并。
   */
  private readonly downedStates = new Map<string, DownedState>();

  /** 最近一次复活结果(供断言与 UI;null = 尚未发生复活)。 */
  lastRevive: ReviveResult | null = null;

  /**
   * 生物身上的持续伤害(灼烧 DoT):生物 ID → 任务。
   *
   * ⚠ 这里的类型是 `DotTask & { fromDeg: number }` —— **不是** `damage.ts` 的
   * `DotTask`。`fromDeg` 是本仓编排层需要的额外信息(见 `tickDots` 的注释:
   * 发条重骑的正面护板按方向减伤,传死值会让灼烧量取决于站位运气)。
   *
   * 为什么不直接给 `damage.ts` 的 `DotTask` 加字段:那会改动它的导出契约,
   * 而 task-47(US2)正依赖既有契约。用交叉类型在编排层附加信息,
   * 纯函数 `makeDot`/`tickDot` 保持零改动 —— 它们并不需要知道方向。
   */
  private readonly dots = new Map<string, DotTask & { fromDeg: number }>();

  /** DoT 自增序号,保证同一生物被多次点燃时按键覆盖而不是叠加无限任务。 */
  private dotSeq = 0;

  /** 累计已结算的击杀数(供断言「击杀真的触发了结算」)。 */
  killSettleCount = 0;

  /** 累计已发放的经验总量(供断言)。 */
  totalExpGranted = 0;

  /* ═══════════ task-36:建造 / 房间识别 / 蓝图接力的生产接线 ═══════════ */

  /**
   * 最近一次**房间识别**结果(供诊断与断言)。
   *
   * ## 为什么这个字段本身就是交付物的一部分
   *
   * `server/src/build/` 的 5 个模块(1688 行)在 `server/src` 里**零引用**,
   * 只有 `tests/` 与 `scripts/perf-bounds.ts` 用它们 —— 门禁因此把整目录挂白名单。
   * 后果是典型的一族缺陷:
   *   - `rooms.ts` 的 BFS 闭合检测**实现完整**、WS-03 的 80 条用例**全绿**;
   *   - 但玩家在真实世界里盖出封闭小屋时,`identifyAllRooms` **永远不会被调用**;
   *   - ⇒ 手册 §3.8 的「餐馆 / 工坊 / 温室 / 奇想炼金实验室」等 9 种动态房间
   *     **永不成立**,而模拟层看不出任何异常(它只知道地形被写了)。
   *
   * 只测纯函数发现不了这一点(那正是既有 80 条用例在做的事):
   * 必须断言「**生产路径**上、由真实地形写入触发」的识别结果。
   */
  lastRoomScan: RoomIdentity[] = [];
  /**
   * 与 `lastRoomScan` **一一对应**的房间内部格集合(供「玩家是否在房内」判定)。
   *
   * ## 为什么需要并行保留一份
   *
   * `RoomInfo` 带 `cells`(房间内部全部格),但 `identifyRoom` 返回的
   * `RoomIdentity` **只带 key/score/matches,把 cells 丢了**。
   * 判定「玩家站在房间内」必须按**格集合**而不是外接矩形 ——
   * 房间形状不必是矩形(BFS 泛洪取内部格),用 `bbox` 会把 L 形房间
   * 凹进去的房外空间也算作房内:玩家贴着墙站在屋外,却拿到卧室回血。
   *
   * ⇒ 在调用 `identifyRoom` 之前把 `info.cells` 抄下来,按同一顺序存放,
   * 下标与 `lastRoomScan` 对齐。`build/rooms.ts` 本轮不在写域内,
   * 因此不改它的返回类型(那是冻结层的调用契约),改由编排层并记。
   */
  lastRoomCells: { x: number; y: number }[][] = [];
  /**
   * 房间识别的**脏标记**:地形写入后置位,下一次慢帧才重算。
   *
   * 为什么不每格写入都立刻重算:`scanRooms` 是 O(sizeCells²) 的全图扫描,
   * 而一次 `fillRect` 可能连写几千格 ⇒ 每格都扫一遍是 O(n·sizeCells²)。
   * 用脏标记把它收敛成「每慢帧至多一次」,与流体/电路的慢帧节流同构。
   *
   * 反过来,**不能**只算一次就永远缓存:`WT-03-61` 钉的就是
   * 「墙都拆了还报着那间房」—— 那种错误不报错、不抛异常,
   * 只是房间永久停留在初始识别的结果上。
   */
  private roomsDirty = true;
  /**
   * 房间识别扫描的**视窗半径**。
   *
   * `scanRooms` 会对整张 `width × height` 做泛洪。生产世界的 `WorldGrid` 是
   * **稀疏 Chunk**,按 `sizeCells`(默认 64,上限可到 512)全量扫是每慢帧
   * 26 万格 —— 而实际有建筑的区域通常只有中心几十格。
   * 这里只扫「所有非空 Chunk 的外接矩形」并外扩该半径,使成本与**实际建造规模**
   * 成正比而不是与世界尺寸成正比。
   */
  private readonly roomScanPad = 8;
  /** 正在推进的蓝图接力队列(未启动时为 null)。 */
  private relay: RelayQueue | null = null;
  /** 接力蓝图的落位基准(蓝图左上角对齐到世界的这个坐标)。 */
  private relayOrigin = { x: 0, y: 0 };
  /** 已落位的任务数(接力计数,供断言)。 */
  relayPlacedCount = 0;
  private readonly logisticsSorters = new Map<string, SorterState>();
  private readonly logisticsArms = new Map<string, ArmState>();
  private readonly logisticsDrills = new Map<string, DrillState>();
  /**
   * 各料理站的锅内状态(506 汤锅 / 507 切菜台 / 508 披萨炉)。
   *
   * 按**设备 ID**而不是坐标索引:坐标会随玩家拆建而变,而「这口锅里的料」
   * 是跟着设备走的。本仓目前一台设备只有一份状态(同一世界不多开同型灶),
   * 与 `ARM_TARGETS` 的粒度一致。
   *
   * 惰性创建:`kitchenOf()` 首次访问时建。开局不该为用不到的灶分配状态。
   */
  private readonly kitchens = new Map<number, KitchenState>();
  /** 料理系统的累计账目(供诊断与断言)。 */
  lastCookReport: { cooked: number; lastItemId: number; fedTotal: number; potCount: number } = {
    cooked: 0, lastItemId: 0, fedTotal: 0, potCount: 0,
  };

  constructor(opts: WorldSimOptions = {}) {
    this.sizeCells = Math.max(16, Math.trunc(opts.sizeCells ?? 64));
    this.fluidBudget = Math.max(1, Math.trunc(opts.fluidBudget ?? FLUID_CELL_BUDGET));
    this.wiringOn = opts.wiring !== false;
    this.mobsOn = opts.mobs !== false;
    this.rng = opts.rng ?? mulberry32(0x5eed);
    /* 战斗随机**独立成一条流** —— 见 `combatRng` 字段注释。
       种子取 `0x5eed` 的派生值,同种子仍完全可复现。 */
    this.combatRng = opts.combatRng ?? mulberry32(0xc0ffee);

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
          if (groundItemId(g) !== itemId) continue;
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
        /* 两个字段都写:接口 `GroundItem` 声明 `id`,而本文件其余读点与
           既有生产写入用 `itemId`。只写一个就会让另一侧读不到(实测
           `consumeGroundItem` 对存在的货返回 0)。修法见 `groundItemId` 的注释。 */
        this.mobGround.push({ id: itemId, itemId, x, y, count } as GroundItem);
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

    /* task-36:地形变了 ⇒ 房间识别结果作废。
       只有 `obj` / `floor` 变化才影响房间判定(墙/门/核心件都在 OBJ 层,
       地砖用于 `floorSet` 评分),`elev` / `wire` / `meta` 与房间无关 ——
       不加这个条件的话,铺一条电线就会触发整轮全图扫描。 */
    if (fields.obj !== undefined || fields.floor !== undefined) this.roomsDirty = true;
  }

  /* ═══════════════ task-36:房间识别 / 蓝图接力的生产入口 ═══════════════ */

  /**
   * 生产路径上的**房间识别结果**(手册 §3.8 的 9 种动态房间)。
   *
   * 正常情况下结果由慢帧(2Hz)自动刷新 —— 与流体/电路/物流同一节流策略。
   * 但**取用时若发现脏标记仍置位,就顺手重算一次**:调用方有权利拿到
   * 「与当前地形一致」的答案,而不是一个空数组或上一帧的旧值。
   *
   * 这点很重要:第一次 `tick()` 是**快帧**(`frame % 10 !== 0`),
   * 若只靠慢帧刷新,构造完立刻取 `rooms()` 会得到 `[]` ——
   * 而世界明明已经盖好了一间房。那会让调用方以为「没有房间」。
   * 脏标记保证这次补偿重算**每次地形变化至多一次**。
   */
  rooms(): RoomIdentity[] {
    if (this.roomsDirty) this.refreshRooms();
    return this.lastRoomScan;
  }

  /**
   * 房间识别已执行次数(供断言「是 tick 自己驱动的,不是调用方手工触发」)。
   *
   * 没有这个计数器,`rooms()` 的惰性补偿会让「自动刷新」与「手工触发」
   * 在外部完全无法区分 —— 测试也就验证不了接线是否真的挂在慢帧上。
   */
  roomScanCount = 0;
  /**
   * 最近一次房间识别**实际扫过的格数**(所有簇的窗口面积之和)。
   *
   * 为什么需要把它暴露出来:簇化修复(见 `refreshRooms`)的收益是**算法复杂度**,
   * 而复杂度不能用墙钟时间断言 —— 时间随机器负载抖,在 CI 上会变成随机红。
   * 用「扫了多少格」这个**确定性**的量,才能把「成本与远处置砖无关」钉成断言:
   * 修复前(全球一个外接矩形)远处放一格 → 扫 256×256 = 65536 格;
   * 修复后 → 两个簇各扫自己那点,量级差两个数量级。
   */
  lastRoomScanArea = 0;

  /**
   * 重算房间识别(慢帧调用,或由脏标记触发)。
   *
   * ## 为什么按「Chunk 簇」而不是「全球外接矩形」扫描
   *
   * `WorldGrid` 是**稀疏**的(`Map<chunkKey, Chunk>`):没被碰过的区域根本没有
   * Chunk。最直接的做法是取所有已存在 Chunk 的**总**外接矩形当扫描窗口。
   *
   * **实测那是个性能陷阱**(本文件 `_bw36_perf2.ts` 的标定数据):
   * 256×256 世界里,一间 9×9 的房在 (10,10):
   * ```
   *   远处那格在 (12,12)   →   0.42 ms/次
   *   远处那格在 (80,80)   →   4.59 ms/次
   *   远处那格在 (160,160) →  16.90 ms/次
   *   远处那格在 (240,240) →  32.57 ms/次   ← 涨了 78 倍
   * ```
   * 原因:总外接矩形由**两个最远点**决定。玩家在离家很远处随手放一格
   * (沙盒建造游戏里这再正常不过),窗口就被撑成整张地图 —— 而窗口里
   * 绝大多数格是空的。房间识别随之变成每慢帧 O(世界面积)。
   *
   * ⇒ 改成**按 Chunk 连通簇分别扫描**:把相邻的非空 Chunk 聚成一簇,
   * 每簇各取自己的外接矩形。一格孤砖只形成 16×16 的簇。
   * 效果(同一次标定):世界 64 → 256(格数 ×16),单次扫描稳定在
   * **0.27ms**,与建造规模成正比而不是与世界尺寸成正比。
   *
   * 簇间互不影响:房间不可能跨越两簇(中间隔着完全空的无 Chunk 区域,
   * 泛洪到那里就断了),所以逐簇识别的结果与整体扫描等价。
   */
  private refreshRooms(): void {
    this.roomScanCount += 1;
    const clusters = this.chunkClusters();
    if (clusters.length === 0) {
      /* 世界还没有任何 Chunk ⇒ 不可能有房间。清空而不是留旧值。 */
      this.lastRoomScan = [];
      this.roomsDirty = false;
      return;
    }

    const pad = this.roomScanPad;
    const out: RoomIdentity[] = [];
    /* 与 `out` 一一对应的格集合,见 `lastRoomCells` 的注释。 */
    const cellsOut: { x: number; y: number }[][] = [];
    let id = 0;
    let area = 0;
    for (const cl of clusters) {
      const x0 = Math.max(0, cl.x0 - pad);
      const y0 = Math.max(0, cl.y0 - pad);
      const x1 = Math.min(this.sizeCells - 1, cl.x1 + pad);
      const y1 = Math.min(this.sizeCells - 1, cl.y1 + pad);
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (w <= 0 || h <= 0) continue;
      area += w * h;

      /* 只读视图:直接转发到 `WorldGrid`,不复制数据 ⇒ 读到的永远是当前地形。
         这正是 `grid.ts` 的 `TileGridLike` 存在的理由(详见那里的注释)。 */
      const view = {
        width: w,
        height: h,
        get: (x: number, y: number) => this.grid.cellAt(x0 + x, y0 + y),
        set: (x: number, y: number, v: number) => {
          this.setCell(x0 + x, y0 + y, unpackTile(v));
        },
        setObj: (x: number, y: number, objId: number) => {
          this.setCell(x0 + x, y0 + y, { obj: objId });
        },
        inBounds: (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h,
      };

      for (const info of scanRooms(view, DEFAULT_SCAN_OPTIONS)) {
        /* 只保留**闭合**的房间:漏墙的泛洪是「室外」,识别它没有意义。 */
        if (!info.closed) continue;
        id += 1;
        /* 房间 ID 在全局唯一:簇内 `scanRooms` 从 1 开始编号,会跨簇重复,
           这里统一用全局自增的 `id` 覆盖,否则两簇的第 1 间房会撞号。 */
        out.push(identifyRoom({ ...info, id }));
        /* 格坐标必须**换回世界坐标**:视图是 `x0/y0` 偏移过的局部坐标,
           直接存会让「玩家在房内」判定整体偏移 (x0,y0)。 */
        cellsOut.push(info.cells.map((c) => ({ x: c.x + x0, y: c.y + y0 })));
      }
    }
    this.lastRoomScan = out;
    this.lastRoomCells = cellsOut;
    this.lastRoomScanArea = area;
    this.roomsDirty = false;
  }

  /**
   * 把相邻的非空 Chunk 聚成连通簇,返回每簇的**世界格**外接矩形。
   *
   * 相邻判据用 4-连通(上下左右):斜角相接的两个 Chunk 之间隔着一格宽的
   * 对角空隙,房间的泛洪过不去,合成一簇只会白白放大窗口。
   */
  private chunkClusters(): { x0: number; y0: number; x1: number; y1: number }[] {
    const present = new Set<string>();
    for (const c of this.grid.chunks.values()) present.add(`${c.cx},${c.cy}`);
    const seen = new Set<string>();
    const out: { x0: number; y0: number; x1: number; y1: number }[] = [];

    for (const key of present) {
      if (seen.has(key)) continue;
      const parts = key.split(',');
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const stack: string[] = [key];
      seen.add(key);
      while (stack.length > 0) {
        const k = stack.pop()!;
        const [cs, rs] = k.split(',');
        const cx = Number(cs);
        const cy = Number(rs);
        const gx0 = cx * 16;
        const gy0 = cy * 16;
        if (gx0 < x0) x0 = gx0;
        if (gy0 < y0) y0 = gy0;
        if (gx0 + 15 > x1) x1 = gx0 + 15;
        if (gy0 + 15 > y1) y1 = gy0 + 15;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nk = `${cx + dx},${cy + dy}`;
          if (present.has(nk) && !seen.has(nk)) {
            seen.add(nk);
            stack.push(nk);
          }
        }
      }
      out.push({ x0, y0, x1, y1 });
    }
    return out;
  }

  /**
   * 启动一次**蓝图飞砖接力**(手册 `208 魔法描图卷轴`)。
   *
   * 生产路径上的蓝图消费入口:把蓝图拆成每格一个任务,由接力队列在慢帧里
   * 逐块派发/飞行,**落位时真正写进世界**(见 `tickRelay`)。
   *
   * ## 为什么必须「落位即写世界」而不是只推进队列状态
   *
   * `RelayQueue.tick()` 只维护 `PENDING → FLYING → PLACED` 三个状态位,
   * **一行都没写过网格**(实测:`RelayQueue` 段落内 `setCell`/`setObj` 出现 0 次)。
   * WS-03 既有用例也只断言 `r.placed === 256` 这个**计数** ——
   * 于是「队列说全放完了,世界里一块砖都没有」这种缺陷全绿通过。
   * ⇒ 本方法负责把 `PLACED` 的任务真正落到地形上。
   */
  startRelay(bp: Blueprint, builders: { id: string; x: number; y: number; speedMul: number }[], origin?: { x: number; y: number }): void {
    this.relayOrigin = origin ?? { x: 0, y: 0 };
    this.relay = new RelayQueue(buildRelayQueue(bp), builders);
    this.relayPlacedCount = 0;
  }

  /** 接力是否仍在进行。 */
  relayActive(): boolean {
    return this.relay !== null;
  }

  /**
   * 推进接力一次(慢帧调用),并把**本帧落位的任务真正写进世界**。
   *
   * 时间戳用**模拟时钟**(`frameCount × 快帧 dt`)而不是 `Date.now()`:
   * 用真实墙钟会让接力速度取决于机器快慢,且测试无法确定性复现。
   */
  private tickRelay(): void {
    const q = this.relay;
    if (q === null) return;
    const nowMs = (this.frameCount / TICK_HZ) * 1000;
    const r = q.tick(nowMs);
    for (const t of r.placed) {
      const x = this.relayOrigin.x + t.lx;
      const y = this.relayOrigin.y + t.ly;
      this.setCell(x, y, { obj: t.obj, floor: t.floor, elev: t.elev, wire: t.wire, meta: t.meta });
      this.relayPlacedCount += 1;
    }
    if (r.remaining === 0) this.relay = null;
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
      for (const g of this.mobGround) if (groundItemId(g) === id) have += g.count;
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
      id: -1,
      itemId: -1,
      x,
      y,
      count: 1,
    } as GroundItem);
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
      /* 必须走 `groundItemId`,不能直读 `g.itemId` —— 这一处曾漏改:
         `GroundItem` 声明的是 `id`,只有生产写入侧才同时写 `itemId`。
         于是 `setGroundItems([{id:151,...}])` 之后本方法对**确实存在**的
         151 返回 0(实测),而同类入口已修好,只有这个公开入口还在按
         `itemId` 读 —— 同一个类里两种读法,正是这个缺陷最坏的地方:
         调用方看到时灵时不灵。 */
      if (groundItemId(g) !== itemId) continue;
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

  /* ── 玩家 → 生物 的伤害入口(task-33 接线)─────────────────────────
   *
   * ## 为什么必须新增入口,而不是「让 damageMob 内部算一下」
   *
   * 接线前实测(`_cp_red33.ts`):
   *   · `computeDamage` 生产调用点 = **0**;
   *   · 玩家贴 `mob_sheep`(60HP)站 600 帧 → 生物 HP **仍是 60**;
   *   · `damageMob(amount=7)`→7、`damageMob(amount=70)`→70 —— `amount`
   *     完全由调用方给定,等级/武器/护甲/元素/暴击**一个都不参与**;
   *   · 手工直调 `computeDamage` → `finalDamage=28`、八步全跑。
   *   ⇒ 缺陷在**接线**,不在算法。
   *
   * `damageMob` 保留原样:它的 `amount` 语义是「已经算好的伤害」,
   * 环境伤害、陷阱、脚本事件都该直接给数,不该被拉去跑一遍八步公式。
   * 新增的 `attackMob` 才是「玩家发起一次攻击」的入口 —— 它负责
   * **算出** amount,再交给 `damageMob` 转发给生物 AI。
   */

  /**
   * 玩家对生物发起一次**真实攻击**:走八步伤害公式,再转交生物 AI。
   *
   * ## 链路(每一步都不可省)
   *
   * ```
   * equipSummary(wearing)  →  CombatantStats  ← 等级/武器/护甲/词条
   *         ↓
   * computeDamage(...)     →  DamageResult   ← 八步:基础/元素/破甲/破盾/暴击/减伤/反伤/击退
   *         ↓
   * damageMob(hpLoss)      →  生物 AI        ← 个体特性:格挡/反弹/晶甲/固化
   * ```
   *
   * 前两段是**通用规则**,后一段是**个体差异**。本仓把个体特性全部实现在
   * 各生物的 `onDamage` 里(实测:剑客正面格挡、骑士正面减伤、卡皮巴拉反弹、
   * 甲虫正面 80% 减伤),所以这里**只算通用八步**,不重复实现个体特性
   * —— 重复会让同一次攻击被减两遍(见 `mobCombatProfile` 的注释)。
   *
   * ## 反伤(第 7 步)为什么回打玩家而不回打生物
   *
   * `result.reflectDamage` 语义是「**受击方**把伤害反给攻击者」。玩家的
   * 728 反伤甲只在玩家**挨打**时生效(那条路在 `vitals.ts`,本函数不涉及)。
   * 生物没有反伤甲这类装备,`mobCombatProfile` 也刻意不给 `reflectMul`
   * (给了就会凭空造出「怪物反伤」)。所以这里只把非零反伤如实上报,
   * 不擅自扣玩家血 —— 扣了就等于给每只怪白送反伤。
   *
   * ## 随机源
   *
   * 暴击/闪避用 `this.rng`,与生物 AI 同一个确定性 PRNG(`mulberry32`)。
   * 用 `Math.random` 会让回放与测试不可复现 —— 本仓的 `rng` 注入口
   * 正是为此存在(`WorldSimOptions.rng`)。
   *
   * @returns `null` 表示没有这个生物;`outOfReach`/`dodged` 时 `finalDamage=0`。
   */
  attackMob(
    playerId: string,
    mobId: string,
    opts: {
      /**
       * 已装备物品 ID(武器 + 护甲);缺省取 `setMobPlayers` 灌入的 wearing。
       *
       * ⚠️ **信任边界:`wearing` / `level` / `weaponId` 目前是「调用方自报值」。**
       *
       * 本入口现在只有测试与 `scripts/**` 调用(非测试生产调用者 = 0,
       * 与 WS-05 的 `tryBreakBoss`/`bossSnapshots` 同标准),所以这三个
       * 覆盖参数是给测试注入受控夹具用的。
       *
       * **但网络层一旦接上(US2),绝不能把客户端报文里的装备/等级直接塞进来** ——
       * 本仓已有同类事故先例(CR-14 U1):`applyInventory` 早期由调用方传
       * `allowedSources` / `capacity`,等于「自带合法清单就能凭空产物品」。
       *
       * 接线的正确形态:这三个值**一律由服务端从玩家权威状态派生**,
       * 即调用方只传 `playerId` / `mobId`,其余走 `this.wearingOf(playerId)`
       * 与玩家档案里的 `level`;`opts` 覆盖项应改为**仅测试可见**。
       *
       * ⇒ 现在**不要**给这三个参数加「客户端可传」的语义;
       * 与 `playerById` / `syncPlayers` 硬编码 `wearing: []` 是同一个病根:
       * **装备与等级的权威归属尚未定义**,应由 US2 一并裁决。
       */
      wearing?: readonly number[];
      /** 玩家等级;缺省 1。语义与信任边界同 `wearing`,见上。 */
      level?: number;
      /** 武器 ID;缺省从 wearing 里自动识别。语义同 `wearing`,见上。 */
      weaponId?: number;
      /** 技能(有则走 SKILL 源,并叠技能倍率)。 */
      skill?: SkillDef | null;
      /** 普攻连段倍率(1.00 / 1.00 / 1.25)。 */
      comboMul?: number;
      /** 覆盖伤害类型(默认由武器推导)。 */
      kind?: DamageKind;
      /** 朝向(度),供生物 AI 的正面/背面判定。 */
      fromDeg?: number;
    } = {},
  ): { result: PipelineDamageResult; hpLoss: number; events: string[] } | null {
    const rt = this.mobHost.runtimeOf(mobId);
    if (rt === null) return null;

    /* 1 组装攻击方面板 —— 装备/等级 → CombatantStats(武器/护甲词条在此聚合)。 */
    const wearing = opts.wearing ?? this.wearingOf(playerId);
    const level = Math.max(1, Math.trunc(opts.level ?? 1));
    const attacker = combatantStats(level, [...wearing]);
    const weaponId = opts.weaponId ?? attacker.flags.weaponId;
    const weapon = weaponId > 0 ? weaponById(weaponId) : null;

    /* 2 距离:超出 reach 容差时九步里的第 0a 步会短路(此处如实传入)。 */
    const distance = this.mobDistance(playerId, mobId);

    /* 3 受击方档案 —— 由冻结层 MobDef 派生(缺的字段见 mobCombatProfile)。 */
    const target = mobCombatProfile(rt.def, { hp: rt.hp });

    /* 4 八步公式。暴击/闪避注入确定性随机。
       ⚠ 用 `combatRng` 而非 `this.rng` —— 后者与生物 AI 共用,
       拿它取战斗随机会把「玩家攻击次数」变成生物 AI 的隐式输入
       (实测扰动远处生物轨迹,见 `WorldSimOptions.combatRng`)。 */
    const critRoll = this.combatRng();
    const dodgeRoll = this.combatRng();
    const result = computeDamage({
      attacker,
      target,
      weapon,
      skill: opts.skill ?? null,
      comboMul: opts.comboMul,
      critRoll,
      dodgeRoll,
      distance,
      source: opts.skill ? DamageSource.SKILL : DamageSource.NORMAL_ATTACK,
    });

    /* 5 落账:公式给出通用伤害,生物 AI 再叠个体特性(格挡/反弹/晶甲)。
       一律走 `damageMob`,**不直接改 rt.hp** —— 否则绕过个体特性。 */
    const kind = opts.kind ?? this.damageKindOf(weapon);
    const fromDeg = opts.fromDeg ?? this.facingOf(playerId);

    /* ⚠ 已死生物:`hpLoss` 必须归零,不能照抄 AI 的返回值。
     *
     * `BaseMobAi.onDamage`(`behaviors.ts:175`)算的是
     * `hpLoss = Math.max(0, amount); rt.hp = Math.max(0, rt.hp - hpLoss)`
     * —— 对一具**尸体**(`rt.hp` 已是 0)它会返回 `hpLoss = amount`,
     * 但 `rt.hp` 仍被钳在 0。实测:`alive=false, hp=0` 时再攻击得到
     * `hpLoss=27`,`hp` 却 `0 → 0`。
     *
     * 这与 `damageMob` 自述的契约「`hpLoss` 才是真正的掉血」**直接矛盾**:
     * 调用方若据此发经验 / 判定击杀 / 记 DPS,会为已经死掉的生物反复记账
     * (本仓把「击杀真的会发生」当验收项,所以这条迟早被读到)。
     *
     * 归零的判据取「攻击前 `rt.hp`」而非 AI 返回值 —— 只有攻击前还活着、
     * 且攻击后 HP 真的下降,才算掉血。
     *
     * 外层 `Math.max(0, …)` 经实测是**冗余防御**,不是必要逻辑:遍历全部
     * 24 个生物 × 5 档伤害 × 4 种 `DamageKind` 共 480 次真实调用,
     * 最小 `hpLoss` = 0,无一为负(`behaviors.ts` 里所有分支都从
     * `Math.max(0, amount)` 或 `amount × 正系数` 起算)。
     * 保留它是为了将来某个 AI 若返回负值时不至于把血**加上去**;
     * 注意**这句冗余本身测不住**——注入实验里去掉它,断言全绿完全相同,
     * 属等价变异体,不是断言盲区。 */
    const hpBefore = rt.hp;
    const ai = this.damageMob(mobId, result.finalDamage, kind, fromDeg);
    const rawLoss = ai?.hpLoss ?? 0;
    const hpLoss = Math.max(0, Math.min(rawLoss, hpBefore));

    /* 6 灼烧 DoT(task-44 接线)—— 命中带 `dot` 的武器则点燃目标。
     *
     * ## 判据用「本次真的掉血了」而不是「打中了」
     *
     * `hpLoss > 0` 才算命中:被闪避 / 距离不足 / 目标已死时 `hpLoss = 0`,
     * 此时点燃等于给一个没打到的目标挂灼烧。手册 §18 的「每击 +15 灼烧」
     * 语义是「命中后附加」,不是「挥空也附加」。
     *
     * ## 只在生物还活着时点燃
     *
     * 一击打死时挂 DoT 是无意义的(下一帧 `tickDots` 见 `!rt.alive` 立刻清账),
     * 但更重要的是:那会让「击杀时的 DoT 数」这个可观测值出现一个
     * **活了 0 帧的幽灵任务**,断言写起来会有虚假的正例。 */
    if (weapon !== null && weapon.dot !== null && hpLoss > 0 && rt.alive) {
      this.applyDot(mobId, weapon.dot, fromDeg);
    }
    return { result, hpLoss, events: ai?.events ?? [] };
  }

  /** 取玩家已装备物品(装配层经 `setMobPlayers` 灌入;无记录则为空)。 */
  private wearingOf(playerId: string): readonly number[] {
    const p = this.mobPlayers.find((x) => x.id === playerId);
    /* `?? []` 不是洁癖:装配层漏传 `wearing` 时 `p.wearing` 是 `undefined`,
       直接返回会让调用方在 `[...wearing]` 处抛 `TypeError: wearing is not iterable`。
       本仓的取舍是「生产路径上不 throw」——漏传装备应当退化成**按裸装结算**
       (玩家看得见伤害数字变小),而不是让整次攻击崩掉。 */
    return p?.wearing ?? [];
  }

  /** 取玩家朝向(度)。 */
  private facingOf(playerId: string): number {
    const b = this.physics.bodies.get(playerId);
    return b?.facingDeg ?? 0;
  }

  /** 玩家与生物的平面距离(格)。任一方不存在时返回 `Infinity`。 */
  private mobDistance(playerId: string, mobId: string): number {
    const a = this.physics.bodies.get(playerId);
    const rt = this.mobHost.runtimeOf(mobId);
    if (a === undefined || rt === null) return Infinity;
    return Math.hypot(rt.x - a.x, rt.y - a.y);
  }

  /**
   * 由武器推导生物的 `DamageKind` —— 决定生物 AI 走哪条减伤/碎壳/固化分支。
   *
   * ## 只映射**真的有 AI 分支**的四种
   *
   * 实测 `behaviors.ts` 里对 `kind` 的判定只有四处:
   * `FIRE`(`behaviors.ts:581` 剑客点燃、`:979` 巧克力盾卫融化)、
   * `EXPLOSION`(`:720` 紫晶甲虫碎壳)、`WATER`(`:1224` 火灵固化)、
   * 其余一律不判。所以这里**只产出这四种 + PHYSICAL 兜底**,
   * 不把 `LIGHTNING`/`LIGHT`/`SLIME` 硬塞进 `SOUND`/`SLIP` 之类
   * —— 那些 kind 没有任何 AI 消费,映射过去只会让日志里出现
   * 「明明该碎壳却走了 SOUND」的假信号。
   *
   * ## 为什么 204 必须映射成 `EXPLOSION`(真缺陷,不是可选)
   *
   * 手册与 `WeaponDef` 都写着 204 黑金爆破冲击镐「对晶甲类护盾拥有 4.0
   * 破盾倍率」「一击敲碎晶甲类怪物的护盾」,而 `BeetleAi.onDamage` 的碎壳
   * 分支判据正是 `kind === DamageKind.EXPLOSION`。
   *
   * `BREACH_PICK.element` 是 `NONE`(它靠爆破而非元素),若按元素映射就会
   * 落到 `PHYSICAL` ⇒ **碎壳分支永远不可达** —— 手册记载的机制在
   * `attackMob` 这条新入口上形同不存在。这是「实现存在但生产跑不到」的
   * 又一例,只是这次出现在我刚接的线上。故按**武器 ID** 单独钉死。
   */
  private damageKindOf(weapon: WeaponDef | null): DamageKind {
    if (weapon === null) return DamageKind.PHYSICAL;
    /* 204 爆破镐:靠爆破碎晶甲壳,必须走 EXPLOSION(见上)。 */
    if (weapon.id === BREACH_PICK.id) return DamageKind.EXPLOSION;
    switch (weapon.element) {
      case Element.FIRE: return DamageKind.FIRE;
      /* ⚠ **刻意没有 `case Element.ICE`。**
       *
       * 直觉上该有:火灵的固化分支判 `kind === DamageKind.WATER`,而
       * `Element.ICE` 是唯一语义上对应水的武器元素。但**实测武器表里
       * 没有任何 ICE 武器**(13 把武器的元素只有 NONE/FIRE/LIGHT/SLIME/
       * LIGHTNING —— 见下方断言「武器表无 ICE 武器」)。
       * ⇒ 写 `case Element.ICE` 就是一段**永不执行的代码**,正是本仓
       * 反复出现的「实现存在但生产跑不到」那一类,只不过这次会是我自己
       * 刚引进来的。故不写。
       *
       * 那 WATER 通道怎么走?两条**真实可达**的路径:
       *   1. 调用方显式给 `kind: DamageKind.WATER`(本方法只负责推导,
       *      显式覆盖优先于推导);
       *   2. 227 泡泡连发水枪经 `interactMob`(工具通道,不经本方法)。
       * 两条都由断言覆盖。
       *
       * 若将来新增 ICE 武器,必须同时恢复 `case Element.ICE:
       * return DamageKind.WATER;`,否则火灵固化会**静默失效**
       * —— 这个陷阱由断言「武器表无 ICE 武器」守着:一旦有人加了 ICE
       * 武器,该断言立刻变红并把这句话顶到脸上。 */
      default: return DamageKind.PHYSICAL;
    }
  }

  /**
   * 玩家对生物造成伤害(武器 / 环境 / 元素)。
   *
   * 转发到生物自己的 AI,使**格挡 / 反弹 / 元素特性**生效 ——
   * 直接改 `rt.hp` 会绕过这些,例如卡皮巴拉的反弹爱心、武士的正面格挡。
   *
   * 返回 `null` 表示没有这个生物;否则返回 AI 的结算结果
   * (`hpLoss` 才是真正的掉血,因为可能被格挡)。
   *
   * **`amount` 的语义是「已经算好的伤害」**:环境/陷阱/脚本事件直接给数;
   * 玩家发起的攻击请用 `attackMob`,由它跑八步公式算出 amount。
   */
  damageMob(
    mobId: string,
    amount: number,
    kind: DamageKind,
    fromDeg: number,
  ): DamageResult | null {
    const rt = this.mobHost.runtimeOf(mobId);
    const wasAlive = rt !== null && rt.alive;
    const r = this.mobHost.damage(mobId, amount, kind, fromDeg);
    if (r === null) return null;
    /* AI 的 `onDamage` 可能已把 hp 扣到 0 或负 —— 同步存活标记,
       否则 `tickMobs` 会继续推进一只已经死掉的生物。 */
    const after = this.mobHost.runtimeOf(mobId);
    if (after !== null && after.hp <= 0) after.alive = false;

    /* ── task-44 接线:击杀结算(经验)──
     *
     * ## 为什么挂在 `damageMob` 而不是 `attackMob`
     *
     * `damageMob` 是**全部**生物伤害的唯一收口:玩家普攻(`attackMob`)、
     * 技能、环境(熔岩/掉落)、陷阱、脚本全都经由它(`attackMob` 自己也是
     * 调它)。挂在 `attackMob` 会漏掉「生物被熔岩烧死」「被陷阱打死」
     * 这类同样该发经验的击杀。
     *
     * 手册 §「全队经验共享」判据是**按距离**而不是「谁补的刀」
     * (`settleMobExp` 的入参是 participants 的 distance),所以这个位置
     * 天然正确:不需要知道击杀者是谁,只需要知道击杀点在哪。
     *
     * ## 判据用 `wasAlive && !after.alive`
     *
     * 不能只看 `after.hp <= 0`:一具**尸体**再挨打时 hp 已经是 0,
     * 那样每打一次都会「击杀」一次 —— 正是 task-33 实测过的
     * 「为死掉的生物反复记账」。同理不能只看 `wasAlive`:活着但没打死
     * 不该结算。两者合取才是「本次伤害**造成了**击杀」。
     * 另外 `KillLedger` 做第二道去重(同一实例只结算一次),两道防线
     * 各自独立:前者防「尸体反复结算」,后者防「同一怪被多路径结算」。 */
    if (wasAlive && after !== null && !after.alive) {
      this.settleKill(mobId, after.x, after.y);
    }
    return r;
  }

  /**
   * 击杀结算 —— 队伍经验共享 + 入账(task-44 接线)。
   *
   * 从 `damageMob` 调用(见那里的注释说明为什么是那个位置)。
   * 返回 `ShareResult`,`null` 表示该怪不在 `MOB_BY_ID` 里(查不到等级/经验)。
   */
  private settleKill(mobId: string, x: number, y: number): ShareResult | null {
    const def = MOB_BY_ID.get(mobId);
    if (def === undefined) return null;

    /* 参与者 = 所有「有成长档案的玩家」,距离取与击杀点的平面距离。 */
    const participants = [];
    let inRange = 0;
    for (const id of this.playerIds) {
      const p = this.progressOf(id);
      const b = this.physics.bodies.get(id);
      const dist = b === undefined ? Number.POSITIVE_INFINITY : Math.hypot(b.x - x, b.y - y);
      if (dist <= SHARE_RADIUS) inRange += 1;
      participants.push({
        playerId: id,
        distance: dist,
        level: p.level,
        afk: false,
        hasDreamTalent: isTalentUnlocked(p.level, 'talent_dream_revelation'),
      });
    }

    const result = settleMobExp(this.killLedger, {
      mobInstanceId: mobId,
      mobLevel: def.level,
      baseExp: def.exp,
      participants,
    });

    /* 入账:把 share 写进各玩家档案(含连续升级)。 */
    const applied = applyShareResult(this.progresses, result);
    for (const [id, p] of applied.progresses) this.progresses.set(id, p);
    for (const [id, ev] of applied.events) {
      if (ev.levelUps.length > 0) {
        const list = this.pendingLevelUps.get(id) ?? [];
        for (const lu of ev.levelUps) list.push({ from: lu.from, to: lu.to });
        this.pendingLevelUps.set(id, list);
      }
    }

    this.lastKillSettle = result;
    this.killSettleCount += 1;
    this.totalExpGranted += result.total;
    void inRange;
    return result;
  }

  /** 取(必要时新建)玩家成长档案。 */
  progressOf(playerId: string): PlayerProgress {
    let p = this.progresses.get(playerId);
    if (p === undefined) {
      p = createProgress(playerId);
      this.progresses.set(playerId, p);
    }
    return p;
  }

  /** 某玩家当前成长档案的快照(供断言;不存在则返回 null)。 */
  progressSnapshotOf(playerId: string): PlayerProgress | null {
    return this.progresses.get(playerId) ?? null;
  }

  /** 取玩家幽灵泡泡状态(不存在 = 未倒地)。 */
  downedOf(playerId: string): DownedState | undefined {
    return this.downedStates.get(playerId);
  }

  /**
   * 幽灵泡泡逐帧推进 + 队友触摸救援(task-44 接线)。
   *
   * ## 为什么触发条件读 `vitals.downed` 而不是自己判 HP
   *
   * 「HP 归零 ⇒ 倒地」的判定属于 `VitalsSystem`(`vitals.ts` 的
   * `applyHit` 里置 `v.downed = true`)。若在这里再判一次
   * `hp <= 0` 就出现了**两份实现了同一规则**——本仓明确把它当缺陷形态
   * (`roomAtCell`/`forgeUnlocked` 的注释都记着这条)。
   * ⇒ 这里只**消费** `vitals` 的判定结果,负责「判定之后的事」:
   * 建泡泡、推进计时、处理救援。分工是「vitals 判瞬时、这里管持续」。
   *
   * ## 为什么救援判定放在慢帧
   *
   * 与房间效果同一理由:救援读条按 `dt` 折算,总量与帧率无关,
   * 2Hz 足够(`REVIVE_TIME = 1.0s` 只需 2 个慢帧)。挂快帧只会
   * 让同一份状态被查询 10 倍次数。
   */
  private tickDowned(): void {
    const dt = SIM_SLOW_DT;
    for (const id of this.playerIds) {
      const v = this.vitals.get(id);
      if (v === null) continue;
      const st = this.downedStates.get(id);

      /* 情况 1:刚倒地(vitals 说 downed,但还没有泡泡状态)⇒ 建泡泡。 */
      if (v.downed && st === undefined) {
        const body = this.physics.bodies.get(id);
        const d = createDowned(
          this.progressOf(id),
          this.equipmentSnapshotOf(id),
          body?.x ?? 0,
          body?.y ?? 0,
        );
        this.downedStates.set(id, d);
        continue;
      }
      /* 情况 2:没倒地但留着状态 ⇒ 清掉(复活后由本路径收尾)。 */
      if (!v.downed) {
        if (st !== undefined) this.downedStates.delete(id);
        continue;
      }
      if (st === undefined) continue;

      /* 情况 3:已倒地 —— 推进泡泡计时,并尝试队友触摸救援。 */
      let d = tickGhostBubble(st, dt).downed;

      /* 找最近的**其他**玩家作为救援者(自己捞不起自己)。 */
      const body = this.physics.bodies.get(id);
      let bestId: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      if (body !== undefined) {
        for (const other of this.playerIds) {
          if (other === id) continue;
          const ov = this.vitals.get(other);
          if (ov === null || ov.downed) continue;   /* 倒地的人救不了人 */
          const ob = this.physics.bodies.get(other);
          if (ob === undefined) continue;
          const dist = Math.hypot(ob.x - body.x, ob.y - body.y);
          if (dist < bestDist) { bestDist = dist; bestId = other; }
        }
      }

      if (bestId !== null && bestDist <= TOUCH_RADIUS) {
        const out = touchRevive({
          downed: d,
          rescuerId: bestId,
          distance: bestDist,
          dt,
          progress: this.progressOf(id),
        });
        d = out.downed;
        if (out.revived && out.result !== null) {
          this.lastRevive = out.result;
          /* 复活落账:把 HP 写回 `vitals`(半血)并清掉倒地标记。
             这是「谁负责把状态机结果写回瞬时判定」的必要一步 ——
             不写回的话 `vitals.downed` 仍是 true,下一帧又会重建泡泡,
             表现为「复活了但立刻又倒下」。 */
          this.vitals.revive(id, out.result.hpAfter);
          this.downedStates.delete(id);
          continue;
        }
      }
      this.downedStates.set(id, d);
    }
  }

  /** 玩家的装备栏快照(供倒地时冻结;零爆装由它保证)。 */
  private equipmentSnapshotOf(playerId: string): EquipmentSnapshot {
    const wearing = this.wearingOf(playerId);
    const snap: EquipmentSnapshot = {
      weapon: null, armor: null, helm: null, boots: null, relic: null, cape: null,
    };
    for (const id of wearing) {
      const a = ARMOR_BY_ID.get(id);
      if (a === undefined) {
        if (snap.weapon === null) snap.weapon = id;
        continue;
      }
      if (snap[a.slot] === null) snap[a.slot] = id;
    }
    return snap;
  }

  /**
   * 灼烧 DoT 逐帧推进(task-44 接线)。
   *
   * 挂在**快帧**:`dps` 的单位是「每秒」,按 `DT` 折算到每帧,
   * 总量与帧率无关。挂慢帧会让 3 秒的灼烧只结算 6 次(手感差异无必要引入)。
   *
   * ## ⚠ 为什么 DoT 要记住**点燃时的方向**(我自己踩的坑)
   *
   * 第一版给 `damageMob` 传的是硬编码 `fromDeg: 0`。实测同一玩家、同一武器、
   * 同一只发条重骑,只因**站位在正面 / 背后**,灼烧总量是 **6.00 / 17.16** ——
   * 差近 3 倍。
   *
   * 原因:`behaviors.ts` 的 `KnightAi.onDamage` 按**方向**判定正面护板减伤
   * (`KNIGHT_FRONT_DR = 0.90`,正面只吃 10%),而它比对的正是
   * `fromDeg - rt.facingDeg`。传死值 0 等于宣称「灼烧永远从 0° 方向来」——
   * 伤害于是取决于**生物恰好朝哪边**,这是运气而不是设计。
   *
   * ⇒ 点燃时把那一击的真实方向存进任务,后续每跳沿用之。
   * 语义是「灼烧源自那一次命中」,可复现、可解释。
   *
   * ## 仍然开放的设计问题(不在本轮裁决,如实记录)
   *
   * 「持续燃烧**该不该**再受正面护板影响」手册未规定 —— 直觉上
   * 护板挡的是正面**冲击**,而已经烧在身上的火不该被护板挡第二次。
   * 但改这个语义要动 `behaviors.ts`(不在本任务写域),且属机制裁决,
   * 故本轮**只消除不确定性**,不替设计作决定。已报给 Lead。
   */
  private tickDots(): void {
    if (this.dots.size === 0) return;
    for (const [mobId, task] of [...this.dots]) {
      const rt = this.mobHost.runtimeOf(mobId);
      /* 生物已死 / 已移除 ⇒ 烧完的账直接清掉,不留孤儿任务。 */
      if (rt === null || !rt.alive) { this.dots.delete(mobId); continue; }
      const step = tickDot(task, DT);
      if (step.damage > 0) {
        /* DoT 走 `damageMob`(同一个收口)—— 于是灼烧**也能击杀**,
           击杀同样触发经验结算,不需要在 DoT 里复制一份击杀判定。 */
        this.damageMob(mobId, step.damage, DamageKind.FIRE, task.fromDeg);
      }
      if (step.expired) this.dots.delete(mobId);
      else this.dots.set(mobId, step.task);
    }
  }

  /**
   * 点燃生物(由命中带 `dot` 的武器触发)。
   *
   * 同一生物重复点燃时**覆盖**而不是叠加:手册写的是「附加 8/s × 3s」,
   * 没有「可叠层」的记载。用递增 key 保证方向性 —— 若用固定 key,
   * 覆盖与不覆盖在外部不可区分。
   */
  private applyDot(
    mobId: string,
    dot: { element: Element; dps: number; sec: number },
    fromDeg: number,
  ): void {
    this.dotSeq += 1;
    this.dots.set(mobId, { ...makeDot(mobId, dot, `dot_${this.dotSeq}`), fromDeg });
  }

  /** 某生物当前是否有灼烧(供断言)。 */
  dotOf(mobId: string): (DotTask & { fromDeg: number }) | undefined {
    return this.dots.get(mobId);
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

  /** 登记一个「玩家」:物理刚体 + AOI 唤醒源,一次注册两处保持一致。 */  addPlayer(id: string, x: number, y: number): void {    this.physics.spawn(id, { x, y, z: 0 });
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
    /* 房间效果状态一并清掉:留着会让重新加入的同名玩家**继承上一轮的温泉计时**
       (表现为「刚上线就带着 20 分钟上限加成」)。 */
    this.roomEffects.delete(id);
    this.forgeUnlockedIds.delete(id);
    this.syncPlayers();
    return had;
  }

  /** 治疗玩家(料理 / 药水 / 队友技能)。返回实际回复量。 */
  healPlayer(id: string, amount: number): number {
    return this.vitals.heal(id, amount);
  }

  /* ═══════════ task-48:房间效果消费点 ═══════════ */

  /**
   * 每个玩家的房间效果状态(温泉计时 / 本帧在哪个房间)。
   *
   * 按玩家持有而不是全局:温泉增益是**个人**的(谁泡谁得),
   * 而 `vitals` 里的 `hp`/`maxHp` 也是按玩家存的。
   */
  private readonly roomEffects = new Map<string, RoomEffectState>();
  /**
   * 最近一慢帧房间效果的施加结果(供诊断与断言)。
   *
   * 与 `lastMobTicks` / `lastLogisticsTick` 同一模式:把「这一帧给哪些玩家
   * 施加了什么」暴露成可观测量。没有它,「增益没接」与「接了但这一帧恰好
   * 没人站在房里」从外面看不出区别。
   */
  lastRoomEffects: { playerId: string; roomKey: string | null; healHp: number; maxHpMul: number; forgeUnlocked: boolean }[] = [];
  /**
   * 本慢帧**解锁了锻造**的玩家集合。
   *
   * ## 为什么单独存一个集合,而不是在 `forgeUnlocked()` 里重判一次
   *
   * 第一版 `forgeUnlocked()` 写的是 `playerRoomKey.get(id) === 'FORGE_MASTER'`,
   * 即**绕过了 `stepRoomEffects` 的返回值自己又判了一遍**。
   * 后果(由故障注入 J3 抓到):把 `effects.ts` 的 `forgeUnlocked: inForge`
   * 改成恒 `false`,**没有任何断言变红** —— 那个返回字段根本没人读,
   * 是个死字段。判定逻辑存在**两份实现**。
   *
   * 这正是本仓反复出现的病灶(`world_sim.ts` 里 `fluid.solid` 与
   * `isSolidAt` 的双份判定、`components.ts` 与 `logistics.ts` 的双份搬运)。
   * 两份判定**今天结果相同**,但迟早漂移 —— 而漂移时不报错,只是某一边失效。
   *
   * ⇒ 单一真相:判定只发生在 `stepRoomEffects` 里,本集合是它的**唯一出口**。
   */
  private readonly forgeUnlockedIds = new Set<string>();

  /** 移动玩家到指定坐标(测试与传送用)。 */
  setPlayerPos(id: string, x: number, y: number): void {
    const b = this.physics.bodies.get(id);
    if (b === undefined) return;
    b.x = x;
    b.y = y;
    this.syncPlayers();
  }

  /**
   * 该玩家当前是否处于【大师锻造房】内(手册:解锁中高级锻造)。
   *
   * 同步查询,读慢帧缓存的**单一真相**(`forgeUnlockedIds`)——
   * 不在这里重新判一遍房间 key,否则判定会有两份实现,一边失效时不报错。
   * 详见 `forgeUnlockedIds` 的注释(该字段是被故障注入 J3 逼出来的)。
   */
  forgeUnlocked(id: string): boolean {
    return this.forgeUnlockedIds.has(id);
  }

  /** 某玩家的房间效果状态(供断言与 UI)。 */
  roomEffectOf(id: string): RoomEffectState | undefined {
    return this.roomEffects.get(id);
  }

  /**
   * 推进全部玩家的房间效果一慢帧。
   *
   * ## 为什么挂在慢帧(2Hz)而不是快帧(20Hz)
   *
   * 与流体/电路/物流同一理由:房间识别本身就是慢帧产物
   * (`refreshRooms`),本函数消费它的输出。挂在快帧只会读到同一份缓存
   * 十次,徒增开销。代价是增益以 0.5s 为粒度施加 —— 对「每秒 15 HP」
   * 这类持续性增益完全够用(按 `dt` 折算,总量与帧率无关)。
   */
  private tickRoomEffects(): void {
    const dt = SIM_SLOW_DT;
    const out: typeof this.lastRoomEffects = [];

    /* 把 `lastRoomScan`(key)与 `lastRoomCells`(格集合)按下标配成一张表。
       两者由 `refreshRooms` 同一次循环产出,长度必然相等;仍显式取 min,
       避免将来任一侧单独改动时静默错位成「A 房的 key + B 房的格」。 */
    const roomsView: { key: string | null; cells: readonly { x: number; y: number }[] }[] = [];
    const n = Math.min(this.lastRoomScan.length, this.lastRoomCells.length);
    for (let i = 0; i < n; i += 1) {
      roomsView.push({ key: this.lastRoomScan[i].key, cells: this.lastRoomCells[i] });
    }

    for (const id of this.playerIds) {
      const b = this.physics.bodies.get(id);
      if (b === undefined) continue;

      /* 玩家坐标定位到格:房间按格集合记录,必须 floor 到格再查。 */
      const key = roomAtCell(roomsView, b.x, b.y);

      let st = this.roomEffects.get(id);
      if (st === undefined) {
        st = createRoomEffectState();
        this.roomEffects.set(id, st);
      }
      const r = stepRoomEffects(st, { roomKey: key, dt });
      this.roomEffects.set(id, r.state);

      /* 卧室回血:走既有 `vitals.heal` 接口 —— 它已处理「上限截断」
         与「倒下不回血」两条边界,不在这里重写一遍。 */
      if (r.healHp > 0) this.vitals.heal(id, r.healHp);

      /* 锻造解锁:记录 `stepRoomEffects` 的**返回判定**,不在此重判。 */
      if (r.forgeUnlocked) this.forgeUnlockedIds.add(id);
      else this.forgeUnlockedIds.delete(id);

      out.push({ playerId: id, roomKey: key, healHp: r.healHp, maxHpMul: r.maxHpMul, forgeUnlocked: r.forgeUnlocked });
    }
    this.lastRoomEffects = out;
  }

  /**
   * 某玩家的**有效生命上限**(含房间增益)。
   *
   * ## 为什么不直接改 `PlayerVitals.maxHp`
   *
   * `vitals.ts` 明说 `maxHp` 是**构造期常量**,且 `importVitals` 刻意
   * **不信任存档里的 maxHp**(见那里的注释)。若房间效果直接写 `maxHp`,
   * 存档往返一次就把增益固化,离开温泉也回不去 —— 与那条不变量冲突。
   *
   * ⇒ 基准值留在 `vitals.maxHp`,增益在此**派生**。这样「离开即撤销」
   * 天然成立,不需要任何反向记账(WT-03-64 的负对照钉住这条)。
   */
  effectiveMaxHp(id: string): number {
    const v = this.vitals.get(id);
    if (v === null) return 0;
    const st = this.roomEffects.get(id);
    /* 倍率走 `effects.ts` 的 `maxHpMulOf` —— 与 `stepRoomEffects` 同一个函数,
       不在这里重写一遍条件(重写就是第二份实现,漂移时不报错)。 */
    if (st === undefined) return v.maxHp;
    return Math.round(v.maxHp * maxHpMulOf(st));
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
          /*
           * 不搬**成品料理** —— 只搬原料。
           *
           * `ARM_TARGETS` 全是加工设备(高炉/汤锅/披萨炉/炼金炉/炮台/分拣/火车头),
           * 把一道做好的菜再喂进加工设备是**无意义自环**:它既不是任何配方
           * 的原料,也不会被加工出别的东西。
           *
           * 实测缺陷(不修就成死循环):出锅的成品落在汤锅相邻格,而该格仍在
           * 机械臂的抓取半径内 ⇒ 刚出锅就被抓回锅里 —— 锅里的 604 **永远
           * 到不了玩家手里**(逐帧追踪:`cooked=1` 但地面为空、锅内卡着 604)。
           *
           * 判定用 `FOOD_BY_ID`(料理表)而不是硬编码 ID 段:表本身是
           * 权威来源,以后加菜不必改这里。
           */
          if (FOOD_BY_ID.has(groundItemId(g))) continue;
          /*
           * 只取 **1 件**,不是整叠 —— `ARM_BATCH = 1` 就是「每次搬运件数」。
           *
           * 这里原先是 `count: g.count`(返回整叠数量)却只从地上减 1:
           * 结果是「地上少 1 件、手里报 2 件」,投喂时按 2 记账。
           * 实测后果:5 件材料被投出 8 件的账,凭空多出 3 件 ——
           * 物品守恒被破坏,而**不抛任何错**。
           */
          const take = Math.min(g.count, ARM_BATCH);
          const out: Stack = { id: groundItemId(g), count: take };
          if (g.count <= take) this.mobGround.splice(i, 1);
          else g.count -= take;
          return out;
        }
        return null;
      },
      feed: (deviceId: number, x: number, y: number, item: Stack): boolean => {
        /* 目标设备必须在 OBJ 层真实存在;不存在就不算投喂成功。
           返回 false 会让机械臂保持持有,下一循环继续找目标 ——
           这比「假装成功」更能暴露配置错误。 */
        const r = Math.max(1, 3);
        let foundDevice = false;
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dx = -r; dx <= r; dx += 1) {
            if (this.grid.objIdAt(x + dx, y + dy) === deviceId) { foundDevice = true; break; }
          }
          if (foundDevice) break;
        }
        if (!foundDevice) return false;

        /*
         * 投喂进料理站:货**入锅记账**,而不是被丢弃。
         *
         * 这里修的是一个真实缺陷:`ARM_TARGETS` 含 506 汤锅 / 508 披萨炉,
         * 机械臂接线后真的会往它们投喂,但原实现只 `return true` ——
         * 货凭空消失(实测 5 件 → 0 件,无任何产出)。
         * 「投喂成功」必须是「有容器收下了」,否则走到设备前等于倒进黑洞。
         */
        if (deviceId === SOUP_POT_ID || deviceId === PIZZA_OVEN_ID || deviceId === KITCHEN_TABLE_ID) {
          const k = this.stationState(deviceId);
          const accepted = feedStation(k, item.id, item.count);
          if (accepted > 0) {
            this.tryCookAt(deviceId);
            return true;
          }
          /* 炉火被浇灭:料不能进,返回 false 让机械臂留着手里的货 */
          return false;
        }
        return true;
      },
      deviceAt: (x: number, y: number): number => this.grid.objIdAt(x, y),
      /*
       * 出货口兜底落地点 —— 传送带把货搬出本格后,若下游没有人接,货落在这里。
       *
       * 没有这个方法时 `deliverExit` 只能退回原带,而原带在被搬走的那一刻
       * 已经 `item = null` —— 于是「退回」实际上等于销毁(实测:1 件货被搬
       * 一格后从世界上彻底消失,既不在地面也不在任何设备里)。
       *
       * 越界返回 false:让出口处掉头/停住,而不是把货挤出世界。
       */
      drop: (x: number, y: number, item: Stack): boolean => {
        if (x < 0 || y < 0 || x >= this.sizeCells || y >= this.sizeCells) return false;
        this.mobGround.push({
          id: item.id, itemId: item.id, x, y, count: item.count,
        } as GroundItem);
        return true;
      },
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
      this.lastLogisticsTick = { beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0, exitsDelivered: 0, exitsDropped: 0, exitsHeld: 0 };
      return;
    }

    const line = this.collectLogisticsLine();
    if (line.belts.length + line.sorters.length + line.arms.length + line.drills.length === 0) {
      this.lastLogisticsTick = { beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0, exitsDelivered: 0, exitsDropped: 0, exitsHeld: 0 };
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
        if (c) {
          c.state.movedCells = st.movedCells;
          c.state.progress = st.progress;
          /*
           * **必须连带着把「带内当前承载的货」也投影出去。**
           *
           * 漏这一行的后果不是「显示不全」,而是**可观测性谎言**:
           * 货在 `logisticsBelts`(私有 Map)里正常待着,但从件表看
           * `belt.item` 永远是 undefined —— 于是「货好好地在带上等着」
           * 与「货被销毁了」在外部看起来**完全一样**。
           *
           * 实测:我的验收探针判「断电时货丢了」正是被这个假象骗了
           * (实际货在带上没动,只是看不见)。缺可观测性会让排查方向彻底错。
           */
          c.state.item = st.item === null ? null : { id: st.item.id, count: st.item.count };
        }
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

  /* ══════════════════ 料理系统接线(WS-10)══════════════════ */

  /**
   * 取某个料理站的锅内状态(惰性创建)。
   *
   * 为什么按设备 ID 索引而不是坐标:坐标随拆建而变,而「这口锅里的料」
   * 跟着设备走。与 `ARM_TARGETS` 的粒度一致(一台设备一份状态)。
   */
  stationState(deviceId: number): KitchenState {
    let k = this.kitchens.get(deviceId);
    if (!k) {
      k = createKitchenState();
      this.kitchens.set(deviceId, k);
    }
    return k;
  }

  /**
   * 把**地面掉落物**投进指定料理站(玩家手动投料的公开入口)。
   *
   * 与机械臂的 `feed()` 走同一条记账路径 —— 两条路都必须把货记进锅里,
   * 否则又会造出「一边投一边丢」的分叉实现。
   *
   * @returns 实际投入的件数(该格无货 / 火已灭 时为 0)
   */
  feedStationAt(deviceId: number, x: number, y: number, maxCount = 1): number {
    const k = this.stationState(deviceId);
    let moved = 0;
    const want = Math.max(0, Math.trunc(maxCount));
    for (let i = this.mobGround.length - 1; i >= 0 && moved < want; i -= 1) {
      const g = this.mobGround[i]!;
      if (g.x !== x || g.y !== y || g.count <= 0) continue;
      const take = Math.min(g.count, want - moved);
      const accepted = feedStation(k, groundItemId(g), take);
      if (accepted === 0) break;
      g.count -= accepted;
      moved += accepted;
      if (g.count <= 0) this.mobGround.splice(i, 1);
    }
    if (moved > 0) this.tryCookAt(deviceId);
    return moved;
  }

  /**
   * 试出锅并把成品落地。
   *
   * 产物**作为掉落物落在地面上**,而不是只留在返回值里 —— 这是本仓
   * 那条被反复验证的判据:`材料件数 → 成品件数` 必须可对账,
   * 只返回一个对象等于把「函数被调过」当成「生效了」。
   */
  private tryCookAt(deviceId: number): void {
    const k = this.kitchens.get(deviceId);
    if (!k) return;
    const res = tryCook(k, deviceId);
    if (res === null) {
      this.syncCookReport(deviceId);
      return;
    }
    /* 出锅:成品落地。
       落在**站点相邻格**而不是站点自己那一格 —— 后者会被机械臂的抓取半径
       覆盖,于是「刚出锅 → 立刻被抓回锅里」,成品永远到不了玩家手里
       (实测:落点选站格时锅内残留 1 件、地面为空)。
       相邻格才是「从锅里拿出来」的语义。 */
    const spot = this.freeTileNear(deviceId);
    this.mobGround.push({ id: res.itemId, itemId: res.itemId, x: spot.x, y: spot.y, count: 1 } as GroundItem);
    this.bus.emit('cook_done', { itemId: res.itemId, station: deviceId });
    this.syncCookReport(deviceId);
  }

  /**
   * 找站点旁一个空格放成品。找不到理想位就退回站点自身坐标
   * (宁可落在站上,也不让产物凭空消失)。
   */
  private freeTileNear(deviceId: number): { x: number; y: number } {
    let sx = 0;
    let sy = 0;
    let found = false;
    for (let y = 0; y < this.sizeCells && !found; y += 1) {
      for (let x = 0; x < this.sizeCells && !found; x += 1) {
        if (this.grid.objIdAt(x, y) === deviceId) { sx = x; sy = y; found = true; }
      }
    }
    if (!found) return { x: 0, y: 0 };
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = sx + dx;
      const ny = sy + dy;
      if (nx < 0 || ny < 0 || nx >= this.sizeCells || ny >= this.sizeCells) continue;
      if (this.grid.objIdAt(nx, ny) === 0) return { x: nx, y: ny };
    }
    return { x: sx, y: sy };
  }

  /** 把锅内账目刷新到 `lastCookReport`(供断言,避免逐字段翻 Map)。 */
  private syncCookReport(deviceId: number): void {
    const k = this.kitchens.get(deviceId);
    this.lastCookReport = {
      cooked: this.totalCooked(),
      lastItemId: k ? k.lastItemId : 0,
      fedTotal: k ? k.fedTotal : 0,
      potCount: k ? potCount(k) : 0,
    };
  }

  /** 全部料理站的出锅次数合计。 */
  private totalCooked(): number {
    let n = 0;
    for (const k of this.kitchens.values()) n += k.cooked;
    return n;
  }

  /** 浇灭某料理站的炉火(227 水枪 / 212 大铁铲)。锅内料保留,只是不再出锅。 */
  extinguishStationAt(deviceId: number): void {
    this.stationState(deviceId).fireOut = true;
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
      const okLoad = loadConveyor(st, { id: groundItemId(g), count: g.count });
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

    /* ── 快帧 20Hz:灼烧 DoT(task-44)──
     * ⚠ **必须在快帧、且用 `SIM_FAST_DT`**。
     *
     * 我第一版把它放进了下面的 `isSlow` 块(2Hz)却仍按 `DT = 0.05s` 折算,
     * 于是每帧只扣 1/10 的量、烧 30 秒 —— 总伤害偏小一个数量级,
     * 而「有没有烧」看不出差别(仍会跳数字)。`dps` 的单位是「每秒」,
     * 只有「每帧一次 × 每帧实际时长」才让它与帧率无关。
     *
     * 位置在物理之后:AoI 的存活判定已由物理步同步,`tickDots` 才能看到
     * 本帧的准确坐标与存活状态(见那里的 `!rt.alive` 清账分支)。 */
    this.tickDots();

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

      /* ── 慢帧 2Hz:建造 / 房间识别 / 蓝图接力(task-36)──
         放在地形与物流之后:本帧的地形写入(含接力落位)应在本帧就被看见,
         否则「墙立起来了但房间要等下一帧才认」——一帧的延迟在这里无害,
         但「先识别再落位」会让本帧识别的是**落位前**的地形,顺序反了。
         `refreshRooms` 自带脏标记,地形没动时是空操作。 */
      this.tickRelay();
      if (this.roomsDirty) this.refreshRooms();

      /* ── 慢帧 2Hz:房间效果消费(task-48)──
         必须在 `refreshRooms()` **之后**:本函数消费的正是识别结果
         (`lastRoomScan` / `lastRoomCells`)。放在之前会读到上一帧的房间 ——
         玩家盖好卧室的当帧拿不到增益,表现为「晚一帧才生效」。 */
      this.tickRoomEffects();

      /* ── 慢帧 2Hz:幽灵泡泡与救援(task-44)──
         读 `vitals.downed`(VitalsSystem 的瞬时判定),负责其后的持续状态:
         建泡泡 / 漂移计时 / 队友触摸救援。放在房间效果之后无依赖,
         取「与其它玩家状态推进同处一地」便于阅读。 */
      this.tickDowned();

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