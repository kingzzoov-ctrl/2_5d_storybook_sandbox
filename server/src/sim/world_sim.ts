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

import { SLOW_TICK_HZ, TICK_HZ, DT, BASE_MOVE_SPEED } from '../../../shared/types/physics.ts';
import { unpackTile, type WireColor } from '../../../shared/types/tile.ts';
import { WorldGrid } from '../world/grid.ts';
import { Chunk, chunkKey, type TileFields } from '../world/chunk.ts';
/* ★ WS-FND-77 / D-19:四个房间系统 + 料理 3 字段的**世界侧单一装配点**。
   `systems/**` 里那四个模块在此之前**零生产调用点**(只有 tests/WS-FND-75 在用),
   于是「牧场日结 / 温室生长 / 炼金首创陈列 / 百货购买」在运行期一件都不发生。
   ⇒ 世界只在**一个**地方调它们(`systems/wiring.ts` 的薄封装),见那边的文件头。 */
import {
  createRoomSystemsState,
  plantCrop as plantCropIn,
  growCrops,
  settleRanchOnce,
  brewInLabOnce,
  galleryDisplay,
  foodPhysicsOf,
  gatherMulOf as gatherMulOfMods,
  producedItemIdOf,
  type CropCellState,
  type HarvestRow,
  type GrowInput,
  type GalleryDisplayRow,
  type RoomSystemsState,
} from '../systems/wiring.ts';
import { sprinklerCells, type Weather } from '../systems/greenhouse.ts';
import { feedItemOf, type RanchAnimal, type RanchDayResult } from '../systems/ranch.ts';
import { buy, buyOnce, CONTENT_PRICE_TABLE, type BuyResult, type PriceTable } from '../systems/depot.ts';
/* ★ A-3:炼金的**中性初判**不在这里发明 —— 复用 `alchemy/**` 既有的口径:
   `NEUTRAL_AFFINITY`(0.7 = 不倾斜)与 `S_LOGIC_BASE + SPAN × affinity`
   (`gate.ts:204` 的公式,本文件只照它算默认值,允许调用方显式覆盖)。 */
import { S_LOGIC_BASE, S_LOGIC_SPAN, S_LOGIC_FLOOR, S_LOGIC_CEIL } from '../alchemy/gate.ts';
import { NEUTRAL_AFFINITY } from '../alchemy/degrade.ts';
/* ★ B:把归档回滚计划**真的应用**到世界上(此前计划层是纯数据,没人接)。
   只 import **类型** —— 运行期不依赖 `world/archive.ts`(它反过来认识
   `Chunk`,不依赖 sim)。 */
import type { RestorePlan } from '../world/archive.ts';
import { FluidField, FLUID_CELL_BUDGET } from '../world/fluid.ts';
/* ★ WS-FND-98:`safeMass` 是「质量归一 / 非法质量拒绝」的**唯一入口**(见 `physics/world.ts` §0)。 */
import { PhysicsWorld, safeMass, type StepReport } from '../physics/world.ts';
import { CarrySystem, CarryReject, type CarryActor, type ChainNode, type ThrowResult } from '../physics/carry.ts';
import { AoiManager, AOI_WAKE_DISTANCE, type AoiPlayer } from '../mobs/aoi.ts';
import { MobSpawner, spawnableMobs, spawnsPerCheck, mobInstanceId, mobDefOf, mobSpeciesId, MOB_INSTANCE_SEP, type SpawnContext, type SpawnWorld } from '../mobs/spawner.ts';
import { rollMobDrops, type MobDropResult } from '../mobs/drops.ts';
import type { WildlifeState } from '../../../shared/types/wire.ts';
import { SignalGraph, type ComponentNode } from '../wiring/graph.ts';
/* task-36 接线:WS-03 的建造 / 房间识别 / 蓝图接力。此前本文件对 `build/**`
   只在注释里提过一句,没有任何 import ⇒ 整目录不可达、被门禁挂白名单。 */
import { scanRooms, identifyRoom, DEFAULT_SCAN_OPTIONS, type RoomIdentity } from '../build/rooms.ts';
import { RelayQueue, buildRelayQueue, type Blueprint } from '../build/blueprint.ts';
/* task-48 房间效果消费点:把识别结果变成玩家身上的可观测增益。 */
import {
  createRoomEffectState,
  stepRoomEffects,
  roomAtCell,
  pushRoomElementResist,
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
  BIG_SHOVEL_ID,
  EXTINGUISH_RADIUS,
  foodBuffFrom,
  foodCombatInput,
  tickFoodBuff,
  mergeFoodBuffs,
  /* ★ 第六轮 P2:两个零调用符号的接线点(见各自 docblock)。 */
  cleansePrankBuffs,
  extinguishStation,
  type FoodBuff,
  type KitchenState,
} from '../combat/cooking.ts';
/* ⚠️ `PRANK_HAMMER_KNOCKBACK`(武器击退量)**曾**在这里 import,用于给受击位移取数;
   接上后把 `WS-10` 的三条既有判据打红(见 `damageMob` 的受击点注释)⇒ 撤下。
   等 owner 定受击击退口径再回来取。 */
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
/* ── task-84:WS-11 对局运行时的每帧驱动(缺口 A)──
 *
 * ## 这是「入口可跑性」那一层,不是「WS-11 可用」
 *
 * 接上之后 `RushOrderSession` / `PartyModeRuntime` / `AfkPlayer` 会真的逐帧推进
 * (实测 `tickRushOrder` 在空 `opts` 下仍驱动 `tickStation`/`tickBeaver`/链条超时/结算,
 *  见 `coop/rush_order.ts:924-964`)。但**玩家仍然无法**交单 / 夺旗 / 拾冠 ——
 * `submitDelivery` / `bridgeCapture` / `crownPickup` 的生产非自身调用点为 **0**,
 * 全仓也没有 `applyAction` / `dispatchAction`。**⇒ 不得表述为「WS-11 可用」。**
 *
 * ## ⚠️★ 「import 了」不等于「接线了」—— 我在这次提交里就犯了
 *
 * 本块的**第一版**只 import 了 `createRushOrderSession` / `startRushOrder` /
 * `tickRushOrder` 三个符号,却**一个都没调用**。后果是三绿一空:
 * ```
 *   可达性门禁  绿 —— import 就是一条边(verify.ts:805 的判据就是 import 形态)
 *   文本判据    绿 —— 符号确实出现在本文件里
 *   测试套件    绿 —— 没有一条断言问「急单每帧真推进了吗」
 *   实际行为    空 —— 这一帧什么都没发生
 * ```
 * ⇒ 这正是我在 task-84 报告里反复引用的「**引用 ≠ 执行**」,
 *   而我恰在**声称完成接线的那次提交**里犯了它。
 * ★ 它比 `wiring_view.ts` 那种「挂 tick 也被丢弃」更隐蔽:那种至少有一次真调用,
 *   这种**连调用点都没有**,所以任何「有没有 import」的判据都抓不到。
 * ⇒ 修法不是「补一行调用」就完,而是**给可观测量**(`rushTicked` / `rushRunningSec`),
 *   让「没接」与「接了但这帧无事」在外部**看得出区别**。
 * ⇒ 判据纪律:**证明接线的是「调用会发生」,不是「符号被引用」。**
 *
 * ## 方向:sim → party,单向
 *
 * `docs/WS-11-coop-prank-party.md:745` 的「禁用耦合」明确不许 WS-11 模块
 * import `net/**`、`physics/**`、`combat/**`。故驱动**只能**住在上游、
 * 向下调它们;这些 import 之后,party/coop/social 里**一个 net 字样都不出现**。
 *
 * ## 为什么是 import 具名符号而不是副作用 import
 *
 * `tickLogisticsStep` 那种先例用的是具名导入(它真要调 `tickLogistics`)。
 * 只有 `components.ts` 那种「只要注册副作用」的才写裸 import。
 * 这里每个符号都真的被调用,故按具名写。
 */
import {
  createManualClock,
  createRushOrderSession,
  startRushOrder,
  tickRushOrder,
  /* ★ WS-FND-120:急单的「回执」与「交付」—— 修前 `settleSession` 全仓零引用 ⇒
     `RUSH_GRADE` 永远传不出去;`submitDelivery` 也只有测试在推。 */
  settleSession,
  submitDelivery,
  RUSH_ORDER_STATE,
  type RushSessionSettlement,
  /* ★ D-13:把玩家坐标换成 `opts.spraying`(工位种类)的唯一函数 —— 半径口径也在那边。 */
  stationsBeingSprayedBy,
  /* ★ 第三轮:照看(翻炒)半边 —— 与 `stationsBeingSprayedBy` 同坐标口径。
     修前 `tickRushOrder` 的 `opts.tended` 全仓**无生产者** ⇒ 12 秒过热退化成
     「必然起火」(见 `rush_order.ts#stationsBeingTendedBy` 的 docblock)。 */
  stationsBeingTendedBy,
  type StationKind,
  type RushOrderSession,
} from '../coop/rush_order.ts';
import {
  PARTY_MODE_KEY,
  startPartyMode,
  tickPartyMode,
  /* ★ WS-FND-120:对局容器 —— 修前世界侧只持 `PartyModeRuntime`,拿不到子运行 ⇒
     `bridgeCapture` / `crownPickup` 在生产里只剩测试一个调用者。 */
  createPartyContest,
  contestMode,
  contestBroadcaster,
  tickPartyContest,
  contestPlaceBoard,
  contestCapture,
  contestBuiltOf,
  contestAssignTeam,
  contestCrownPickup,
  contestCrownDrop,
  contestCrownHolder,
  contestCrownCooldown,
  contestCrownWinner,
  contestBridgeFlagged,
  contestSettlement,
  settlePartyRun,
  BRIDGE_BOARD_ITEM_ID,
  BRIDGE_TILES_TO_WIN,
  PARTY_PHASE,
  type PartyContest,
  type PartyModeRuntime,
  type PartySettlement,
} from '../party/modes.ts';
/* ★ WS-FND-120:动作层闸门(权限 + 前置)。**世界侧不许再判一次** —— 两份判定迟早漂移。 */
import {
  gatePartyStart,
  gatePartyStop,
  gateBridgePlace,
  gateBridgeCapture,
  gateCrownPickup,
  gateCrownKnock,
  gateRushStart,
  gateRushDelivery,
  deskModeKey,
  REFEREE_DESK_STOP_MODE,
} from '../party/actions.ts';
/* ★ WS-FND-120:急单读口(订单还差什么 / 奖励落哪)。 */
import {
  RUSH_DELIVERY_RADIUS,
  RUSH_ENTRY_ROOM_LEVEL,
  openOrderLines,
  rushAcceptsDelivery,
  rushRewardCellOf,
} from '../coop/rush_actions.ts';
import {
  createAfkPlayer,
  goBackground,
  goForeground,
  tickAfk,
  type AfkPlayer,
} from '../social/afk.ts';
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
/* ★ D-07:昼夜边界**只有一处**(`isNight(hour)`,405 感光器也用它)—— 这里只借用,不重写。 */
import { isNight as isNightAtHour } from '../wiring/components.ts';
import { EventBus } from '../events/bus.ts';
import { MobHost, type MobHostWorld, type MobTickResult } from '../mobs/host.ts';
import { VitalsSystem, resolveStrikes, collectEventStrikes, collectEventBlinds, warnHitsPlayer, BLIND_VIEW_MUL, type MobHitResult, type PendingStrike } from '../combat/vitals.ts';
/* ★ D2(视线遮挡):纯函数模块(`server/src/world/vision.ts`)。
   生物 → 玩家的打击在**结算前**过一次射线遮挡 —— 修前隔着 1 格墙也能打中
   (`docs/DAMAGE-LOOP.md` D2),因为这条判定在仓库里**根本不存在**。 */
import { losBlocked } from '../world/vision.ts';
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
  /* ★ D1/D3/D4 + 烹饪字段消费:四个**内容层**锚点。
     - `DEFAULT_UNARMED_KNOCKBACK`:生物没有武器时用的击退量(与第 8 步同源,不新造数)
     - `MOB_ELEMENT_BY_ID`:生物的元素归属(抗性折算的输入,唯一出处)
     - `ARMOR_K`:护甲递减曲线常数(烹饪 `defFlat` 的折算用同一曲线,不另造公式)
     - `pvpVerdict` / `targetFromStats`:PvP 的唯一授权判定与受击方档案 */
  DEFAULT_UNARMED_KNOCKBACK,
  MOB_ELEMENT_BY_ID,
  ARMOR_K,
  /* ★ 第六轮 P0 [Q] 技能段数 + P1 反伤折算:两条都是既有实现、生产零调用。 */
  planSkillHits,
  reflectFrom,
  pvpVerdict,
  targetFromStats,
  type AttackInput as PipelineAttackInput,
  type DotTask,
  type DamageResult as PipelineDamageResult,
} from '../combat/damage.ts';
import {
  combatantStats,
  /* ★ 第六轮 P0:[Q] 技从武器表取(修前 skillOf 生产 0 调用)。 */
  skillOf,
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
  setLevel,
  settleMobExp,
  gainExp,
  applyShareResult,
  isTalentUnlocked,
  SHARE_RADIUS,
  type PlayerProgress,
  type ShareResult,
} from '../combat/progression.ts';
/* ★ 第六轮:战斗侧「实现了但没接」的**具名台账**。
   为什么由世界侧 import:它是 `server/src/combat/**` 的接线现状账本,而 `scripts/` 的
   可达性/孤儿门禁只认**生产**引用 —— 只被测试引用的新模块会被判成「未登记孤儿」。
   ⚠️ 本模块**不做任何运行时动作**(纯数据 + 纯函数),import 它不会把「未接线」变成「接线」。 */
import { COMBAT_WIRING_LEDGER, type CombatWiringRow } from '../combat/wiring_ledger.ts';
import { statsAtLevel } from '../../../shared/types/entities.ts';
import {
  createDowned,
  /* ★ 第六轮 P1:幽灵期动作权限的唯一规则(ghostControl.canAttack)。 */
  ghostControl,
  tickGhostBubble,
  touchRevive,
  flagRevive,
  FLAG_REVIVE_RADIUS,
  featherRevive,
  bubbleGunHit,
  TOUCH_RADIUS,
  type DownedState,
  type EquipmentSnapshot,
  type ReviveResult,
} from '../combat/revive.ts';
import {
  LIVE_BUBBLE_INITIAL,
  liveBubbleHit,
  tickLiveBubble,
  isTrapped,
  type LiveBubbleState,
} from '../combat/live_bubble.ts';
import { PARTY_SCORE_EVENT, TEAM_ORDER, drainBroadcasts, makeRng, type TeamKey } from '../party/scoring.ts';

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
/* ★ D3(Boss 技能对玩家的特殊效果):Boss 的**地面预警几何**由 `phases.ts` 按
   阶段产出(每阶段半径/角度/时长都是内容值,`phases.ts:156`)。编排层拿它当
   第三条 strike 通道 ⇒ 此前 Boss 的招式只对着空气(没有任何玩家侧结算)。 */
import { skillWarnGeoms } from '../bosses/phases.ts';

/** 快帧与慢帧的固定比例:20Hz / 2Hz = 10。 */
export const FAST_PER_SLOW = TICK_HZ / SLOW_TICK_HZ;

/** 一帧快帧的现实时长(秒)。 */
export const SIM_FAST_DT = DT;

/** 一帧慢帧的现实时长(秒)。 */
export const SIM_SLOW_DT = 1 / SLOW_TICK_HZ;
/**
 * 玩家语义的**物质层**契约(放置 / 破坏 / 地面物品)。
 *
 * 为什么单独一个接口,而不是把 7 个方法摊在 `WorldSaveHost` 上:
 * 本仓所有**手写 host 假件**(`tests/WS-07` 3 个、`scripts/verify.ts` 若干)
 * 都要逐个满足 `WorldSaveHost` —— 每扩一次能力,摊平写法就要改 N 处夹具;
 * 打包成"一件能力"只需加 1 个成员。房间侧持有的是**结构化同名形状**
 * (`room.ts` 的 `WorldSaveHost.materials()`),两侧形状若分叉,
 * `createHost()` 里那句 `return sim` 会**编译期报错**(见 `index.ts` 的注释)。
 */
export interface MaterialApi {
  /** 该格 obj 层 id(0 = 空)。 */
  blockAt(x: number, y: number): number;
  /** 放一个块(玩家语义:判世界内 / 该格空 / 该格无实体)。 */
  placeBlock(x: number, y: number, objId: number): { ok: true } | { ok: false; reason: string };
  /**
   * 拆一个块,返回被拆下来的 obj id(调用方拿它当掉落)。
   *
   * `actorId` **可选**:给了才多一个 `gatherMul`(采集乘子的归属口,见实现处)。
   * 现有的所有调用点(旧世界源假件、`actions/material.ts` 的旧写法)不传它 ⇒
   * 形状与行为都不变。
   */
  breakBlock(
    x: number,
    y: number,
    actorId?: string,
  ): { ok: true; objId: number; gatherMul?: number } | { ok: false; reason: string };
  /** 附近的地面掉落物(由近及远)。 */
  groundItemsNear(
    x: number, y: number, radius: number,
  ): { itemId: number; count: number; x: number; y: number; dist: number }[];
  /** 从地面扣减,返回实际扣掉的数量(给范围就只扣范围内的)。 */
  consumeGroundItem(itemId: number, count: number, nearX?: number, nearY?: number, radius?: number): number;
  /** 拾取"最近的那一件";`false` = 附近没有这件。 */
  takeGroundItemNear(x: number, y: number, itemId: number, radius: number): boolean;
  /** 把物品放到地面(背包 → 世界)。 */
  dropItem(x: number, y: number, itemId: number, count: number): void;
}


/** 单个模拟实例的构造参数。 */
export interface WorldSimOptions {
  /** 世界边长(格)。默认 64 —— 够放 4×4 个 Chunk,便于调试与测试。 */
  sizeCells?: number;
  /**
   * 本房间号 —— 供"按房间查配置"用(今天唯一的用户是**城镇安全区半径**)。
   * 空串 = 装配层没给 ⇒ 需要房间号的功能退回默认值。见 `spawnWorld().roomId`。
   */
  roomId?: string;
  /** 每帧慢帧最多处理多少个流体格。默认取 `FLUID_CELL_BUDGET`。 */
  fluidBudget?: number;
  /** 每帧慢帧是否推进电路泛洪。默认 true。 */
  wiring?: boolean;
  /** 每帧快帧是否推进生物 FSM。默认 true。 */
  mobs?: boolean;
  /**
   * 世界群系(键应当是 `BIOME_SPAWN` 的键,否则判定会兜底 MEADOW)。
   * 默认 `MEADOW`。见 `biomeName` 字段注释:本仓没有每格群系。
   */
  biome?: string;
  /**
   * 世界种子的**身份**(不是随机流本身)。
   *
   * ## 为什么必须单独一个字段(而不是从 `rng` 反推)
   *
   * `rng` 是一个**函数**(`mulberry32(seed)` 的产物),函数里没有种子。
   * 于是「旧世界的种子是什么」在重置时**无从得知** —— 而 D-06 要求归档行
   * 记下**旧世界**的种子(`db/repo.ts` 的 `WorldArchiveSummary.seed`)。
   * ⇒ 种子必须作为**身份**被持有。
   *
   * 两者分工:
   *   - `seed` = 身份(归档行、重置回执、可重放判据的键);
   *   - `rng`  = 流(确定性随机序列,可被调用方注入以复现)。
   *
   * ⚠️ 注入 `rng` 的调用方**应当同时**给 `seed`(例如 `rng: mulberry32(13)`
   *    ⇒ `seed: 13`),否则归档行会记下默认种子 `0x5eed` —— 那不是你那条流的
   *    种子。**如实记,不猜**(猜出来的种子会让「回滚到这一版」重放成另一个世界)。
   */
  seed?: number;
  /**
   * 确定性随机源,返回 [0,1)。默认 `mulberry32(seed)`(没给 `seed` ⇒
   * 构造期的默认 `0x5eed`,与接线前逐字一致)。
   */
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
  /**
   * **世界归档口** —— 重置时把旧世界交出去的唯一通路(★ D-06)。
   *
   * ## 世界不持库
   *
   * `WorldSim` **不认识** `db`(它只把 `DbLike` 当**参数**收,见 `saveToDb` 的
   * docblock:构造器一旦依赖 DB,17 个套件的纯对象用法全都得先搭库)。
   * 而归档写入(`db/repo.ts:archiveWorldSnapshot`)属于存储层,装配层是唯一
   * 同时认识两侧的地方 ⇒ 由 `index.ts` 注入一个闭包,依赖单向(sim → 不认识 net/db 的类型)。
   *
   * ⚠️ **没有 sink ≠ 归档失败**(两种都要如实报,但不许混成一种):
   *   - 没 sink  ⇒ 本世界**根本没有归档能力**(装配层没给库)⇒ 回执
   *     `archive: null` + `archiveError` 写明「没有库」;
   *   - sink 抛错 ⇒ **归档失败**(磁盘满 / 超配额 / 表没建)⇒ 同样
   *     `archive: null` + 错误原因。
   * 两者都**不许**把 `applied` 改成 false —— 见 `resetWorld` 的判决顺序。
   */
  archiveSink?: WorldArchiveSink | null;
}

/* ══════════════ 世界重置 / 归档契约(★ D-06:归档 + 内存重建)══════════════
 *
 * 三个类型刻意**不 import** `db/repo.ts` 的类型(`WorldArchiveSummary` /
 * `WorldArchiveWriteResult`):`sim` 对存储层的依赖面应当只有「一个闭包」,
 * 两侧的形状对齐由**装配层**(`index.ts`)在编译期保证 —— 那里是唯一同时
 * 认识两边的文件。这与 `room.ts` 的 `WorldSaveHost` 用结构化类型同一条纪律。
 */

/**
 * 归档口的入参 —— 与 `repo.ts:archiveWorldSnapshot` 的入参**逐字段同名同义**
 * (适配函数只有五行的字段搬运,见 `index.ts` 的 `makeArchiveSink`)。
 */
export interface WorldArchiveRequest {
  /** 本房间号(`WorldSim.roomId`;空串 ⇒ 归档口会拒 —— 那是**如实失败**)。 */
  roomId: string;
  /** ★ **旧世界**的种子(不是新种子)。 */
  seed: number;
  /** 旧世界的可重建描述(格式见 `describeWorldForArchive`)。 */
  snapshot: Uint8Array;
  /** Unix 毫秒(归档行的时间戳;缺省由 `resetWorld` 取 `Date.now()`)。 */
  nowMs: number;
  /** 旧世界已推进的帧数。 */
  worldTick: number;
  /** 归档原因(人类可读;`repo.ts` 原样存进 `reason` 列)。 */
  reason: string;
}

/**
 * 归档**裁剪回执**的四件(★ B / D-19 第 5 条)。
 *
 * `repo.archiveWorldSnapshot` 在快照超 1 MiB 时会按 `world/archive.ts` 的规则
 * 裁地形块,并把 `trim: ArchiveTrimReport` 放进回执。那份摘要此前在
 * **两处**被丢掉:
 * ```
 * index.ts:makeArchiveSink   只搬 id/seed/archived_at/bytes ⇒ trim 丢
 * world_sim:archiveBeforeReset 又新建一个只有四字段的回执 ⇒ 再丢一次
 * ```
 * ⇒ 「归档成功了」与「归档是**裁过的**」在回执里不可区分,而回滚恰恰要读它
 * (`planRestore` 的 `missingChunks` 就来自同一份 `trim`)。
 *
 * ⚠️ **键缺席 = 没裁过**(不写 `status: 'KEPT'`):`WorldResetResult.archive`
 *   的三态纪律(有对象 / `null` / 缺键)同理 —— 补一个恒存在的键会让
 *   「这次归档裁了几块」这个事实在**每一次**重置里都出现,反而不可判定。
 */
export interface WorldArchiveTrimReceipt {
  /** `'TRIMMED'` = 这次真的裁了块(`'KEPT'` 预留给"显式报告没裁")。 */
  status: 'TRIMMED' | 'KEPT';
  /** 裁掉的地形块数。 */
  droppedChunks: number;
  /** 裁掉的块体字节合计。 */
  droppedBytes: number;
  /** 人类可读原因(取自 `trim.reason`,**原样转发**,不在这一层重写)。 */
  reason: string;
  /** 规则标识(取自 `trim.rule`,机器可判)。 */
  rule: string;
}

/** 归档口的回执 —— 可判定的句柄 + 摘要(+ **裁剪四件**,没裁过则键缺席)。 */
export interface WorldArchiveReceipt {
  /** 稳定句柄(`<room_id>#<seq>`)。★ 空 id 不算归档成功(见 `archiveBeforeReset`)。 */
  id: string;
  seed: number;
  archived_at: number;
  bytes: number;
  /** 裁剪摘要(**没裁过 ⇒ 键缺席**)。 */
  trim?: WorldArchiveTrimReceipt;
}

/** 注入的世界归档口(装配层把它接到 `repo.archiveWorldSnapshot`)。 */
export type WorldArchiveSink = (req: WorldArchiveRequest) => WorldArchiveReceipt;

/**
 * `resetWorld` 的回执 —— 与 `net/room.ts` 的 `WorldSaveHost.resetWorld` **逐字段同形**
 * (那份声明是本接口的对外契约,改动必须同步两处,否则 `index.ts` 的
 * `return sim` 会当场编译不过 —— 这是刻意的防分叉)。
 *
 * `archive` 是**三态**的来源(`net/actions/reset_world.ts` 的 `resetEffect`):
 *   `{...}` = 旧世界已归档;`null` = **明确**没归档(原因在 `archiveError`);
 *   缺键    = 宿主没报告(本实现**永远**给键,所以生产里到不了第三态)。
 */
export interface WorldResetResult {
  applied: boolean;
  /** **实际生效**的种子(`applied === true` 时它就是新世界的种子)。 */
  seed: number;
  reason?: string;
  archive: WorldArchiveReceipt | null;
  archiveError?: string;
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
 * 玩家**装备与手持**的权威档案。
 *
 * ## 为什么必须与 `mobPlayers` 分开存(US2/task-47 的权威裁决)
 *
 * `mobPlayers` 是**每帧重建的派生视图**:`syncPlayers()` 从 `physics.bodies`
 * 重新组装它(位置权威是 `PhysicsWorld`)。它原先把 `wearing` 写成字面量
 * `[]` —— 于是**装配层灌进来的装备在下一帧被抹掉**,表现为
 * 「`setMobPlayers` 之后立刻攻击有效,`tick()` 一次之后就退回裸装」。
 *
 * 实测(M1,本次接线前的探针):
 * ```
 * setMobPlayers([{wearing:[712]}]) → 立刻攻击 finalDamage = 76
 * sim.tick()                       → 再攻击 finalDamage = 10(退回裸装)
 * tick 后 mobPlayers 的 wearing     = [[]]
 * ```
 * ⇒ 装备**不能**存在派生视图里。它需要自己的持有者,即本结构。
 *
 * ## 权威归属(引 `docs/AUTHORITY-MAP.md` §「#4 权威归属主张」)
 *
 * > `wearing` / `heldItem` → **新结构「玩家档案」**(接线前不存在);
 * > `room` = 投影;`vitals` / `combatantStats` = 消费
 *
 * 本结构就是那个「玩家档案」。等级**不在**这里 —— 等级的权威是
 * `progresses`(`progression.ts`),两者是不同族的状态,不合并持有。
 */
export interface PlayerProfile {
  wearing: readonly number[];
  heldItem: number;
}

/** 空档案常引用 —— 无记录时返回它,避免每次分配。 */
const EMPTY_PROFILE: PlayerProfile = { wearing: [], heldItem: 0 };


/* ══════════ ★ R14:回滚失败的**分类**(字符串字面量 —— 仓规禁 enum)══════════ */

/**
 * `applyRestore` 的失败分类。
 *
 * ## 为什么必须分类(改前只有一句中文 reason)
 *
 * 改前 `applyRestore` 的坏档表现是「解码抛异常」:计划形状不对返回
 * `ok:false`,而块体字节解不开**直接抛出去** —— 同一个方法的失败有两条
 * 互不相同的出口,且调用方无法从回执上区分「坏档 / 形状不对 / 尺寸不符 /
 * 代码缺陷」。四种码各有唯一的**发生面**:
 * ```
 * shape        计划或 op 的形状不对(不是对象 / 缺 ops / 缺 world 段 /
 *              op 缺键 / chunk.bytes 不是 Uint8Array …)   —— 纯数据检查
 * size         sizeCells 或流体场边界 ≠ 当前世界           —— 纯数据检查
 * bad-archive  块体字节解不开(Chunk.deserializeSnapshot 抛 RangeError) —— 坏输入
 * internal     以上之外的抛错(宿主对象上的意外 / 代码缺陷)  —— 非预期
 * ```
 * 前三种**全部在 `rebuildWorld` 之前**判定 ⇒ 失败时世界**一字未改**;
 * `internal` 可能发生在写入阶段,回执措辞会如实说明「可能已被部分修改」。
 */
export const RESTORE_FAIL = {
  SHAPE: 'shape',
  SIZE: 'size',
  BAD_ARCHIVE: 'bad-archive',
  INTERNAL: 'internal',
} as const;
export type RestoreFailCode = (typeof RESTORE_FAIL)[keyof typeof RESTORE_FAIL];

/** 异常 → 一行可读文本(回执里要能看见「抛了什么」,而不是一句「未知错误」)。 */
function thrownText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * ★ R14 的**形状闸**(纯读,零写入):返回第一条形状错误的说明,全对返回 `null`。
 *
 * 只校验「写入阶段真的会用到的键」—— 宁可少校验,也不写第二份计划语义:
 * `world` 段(seed / sizeCells / frame)、`chunk` 的坐标与字节、`player` 的
 * id 与坐标、`fluid` 的边界与水位表、`mob` / `ground` 的坐标。
 *
 * ⚠️ `bytes` 只校验「**当场**是 `Uint8Array` 且非空」:「是字节但解不开」
 * 属于 `bad-archive`(由预解码那一层报),「根本不是字节」属于形状态。
 */
function restoreShapeError(op: unknown): string | null {
  if (op === null || typeof op !== 'object') return '里有一条 op 不是对象';
  const o = op as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== 'string') return '里有一条 op 缺 kind(不是字符串)';
  const finite = (k: string): boolean => typeof o[k] === 'number' && Number.isFinite(o[k]);
  const int = (k: string): boolean => typeof o[k] === 'number' && Number.isInteger(o[k]);
  switch (kind) {
    case 'world':
      if (!finite('seed')) return '的 world.seed 不是有限数';
      if (!int('sizeCells')) return '的 world.sizeCells 不是整数';
      if (!finite('frame')) return '的 world.frame 不是有限数';
      return null;
    case 'chunk': {
      if (!int('cx') || !int('cy')) return '的 chunk 坐标不是整数';
      const bytes = o.bytes;
      if (!(bytes instanceof Uint8Array)) return '的 chunk.bytes 不是 Uint8Array 快照';
      if (bytes.byteLength === 0) return '的 chunk.bytes 是空缓冲';
      return null;
    }
    case 'player':
      if (typeof o.id !== 'string' || o.id.length === 0) return '的 player.id 不是非空字符串';
      if (!finite('x') || !finite('y') || !finite('z')) return '的 player 坐标不是有限数';
      if (!finite('level')) return '的 player.level 不是有限数';
      if (o.hp !== undefined && !finite('hp')) return '的 player.hp 存在但不是有限数';
      return null;
    case 'fluid': {
      if (!int('width') || !int('height')) return '的 fluid 边界不是整数';
      const levels = o.levels;
      if (!Array.isArray(levels)) return '的 fluid.levels 不是数组';
      for (const l of levels) {
        if (l === null || typeof l !== 'object') return '的 fluid 里有一条水位不是对象';
        const lv = l as Record<string, unknown>;
        if (!(typeof lv.x === 'number' && Number.isFinite(lv.x))) return '的 fluid 水位 x 不是有限数';
        if (!(typeof lv.y === 'number' && Number.isFinite(lv.y))) return '的 fluid 水位 y 不是有限数';
        if (!(typeof lv.amount === 'number' && Number.isFinite(lv.amount))) {
          return '的 fluid 水位 amount 不是有限数';
        }
      }
      return null;
    }
    case 'mob':
      if (typeof o.id !== 'string' || o.id.length === 0) return '的 mob.id 不是非空字符串';
      if (!finite('x') || !finite('y')) return '的 mob 坐标不是有限数';
      if (!finite('hp') || !finite('maxHp')) return '的 mob.hp/maxHp 不是有限数';
      return null;
    case 'ground':
      if (!finite('x') || !finite('y')) return '的 ground 坐标不是有限数';
      if (!finite('itemId') || !finite('count')) return '的 ground.itemId/count 不是有限数';
      return null;
    default:
      return `里有未知的 op.kind:${kind}`;
  }
}

/**
 * 闸的产物:要么带**全部待写入的值**,要么带一条**已分类**的拒绝理由。
 *
 * `chunks` 是**预解码好**的块体 —— 这是 R14 的核心:`applyRestore` 在
 * `rebuildWorld` 之前就把每一块解完,坏的字节在那时就变成 `bad-archive`,
 * 于是「世界已经重建、玩家已经清空,却在铺地形时抛异常」这条路不存在。
 */
type RestoreGate =
  | {
      ok: true;
      seed: number;
      biome: string;
      frame: number;
      chunks: { cx: number; cy: number; chunk: Chunk }[];
    }
  | { ok: false; code: RestoreFailCode; reason: string };
/**
 * 可运行的世界。
 *
 * 持有顺序即**初始化顺序**:地形 → 物理 → 电路 → 生物。
 * 推进顺序即**每帧顺序**:物理 → 生物 → 电路 → 流体。
 * 两个顺序不同是刻意的 —— 物理要先动,电路后判,这样「玩家踩到压力板」
 * 与「该板通电」落在同一帧里,不会被推迟一帧(那是 50ms 的可感知延迟)。
 */
export class WorldSim {
  /*
   * ⚠️ **这一组的 `readonly` 在 ★ D-06 被拿掉了**(`grid` / `physics` / `fluid` /
   * `wiring` / `aoi` / `spawner` / `carry` / `bus` / `mobHost` / `bossRaid` /
   * `vitals` / `rng` / `combatRng`)。
   *
   * 理由:`resetWorld` 要「按新种子在内存重建」,而重建的**唯一干净形态**是
   * **换新实例**。逐个把旧实例的内部清零做不到干净:
   *   - `SignalGraph` 的 `liveCells` / `driveCellsByColor` / `channelInput` 等
   *     是 **private**,编排层既清不掉、也不该去清;
   *   - `AoiManager` 连「枚举已登记生物」的读口都没有(只有 `getMob(id)`),
   *     于是「清空 AOI」只能靠调用方自己记住有哪些 id;
   *   - `CarrySystem` 的投掷冷却表同样是 private ⇒ 上一局的冷却会跨世代残留。
   * 这些都是**不报错的残留**(看起来一切正常,只是行为莫名其妙),
   * 正是本仓反复防的那一类。
   *
   * `readonly` 去掉只针对**这一组世界子系统**;`mobOrdinals` 之类的账本仍是
   * `readonly`(它们靠 `clear()` / `reset()` 清,不需要换实例)。
   */
  grid: WorldGrid;
  physics: PhysicsWorld;
  fluid: FluidField;
  wiring: SignalGraph;
  aoi: AoiManager;
  spawner: MobSpawner;
  /**
   * **每个物种已经发到几号** —— 实例 id 的序号来源(见 `mobs/spawner.ts` 的 id 两层说明)。
   *
   * ⚠️ 单调递增、**永不复用**:复用会让"新刷的那只"继承死掉那只的击杀账
   * (`killLedger` 按实例 id 去重)⇒ 经验被静默吞掉,而且不报错。
   * 所以序号**不能**取"当前存活数 + 1"。
   */
  private readonly mobOrdinals = new Map<string, number>();
  carry: CarrySystem;
  /**
   * 事件总线 —— 事件驱动子系统的共同出口。
   *
   * 生物 AI 的 30 处 `emit` 走这里;伤害结算 / Boss 阶段 / 炼金等
   * 事件型子系统将来也接这里。见 `docs/EVENT-BUS.md`。
   */
  bus: EventBus;
  /**
   * 生物宿主 —— `MobWorld` 的第一份真实实现。
   *
   * 25 个 AI 类的 `tick` 通过它访问世界。此前编排层的
   * `aoi.stepActive(() => {})` 是空回调,25 个实现一行都没跑过。
   */
  mobHost: MobHost;
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
  bossRaid: BossRaidRuntime;

  readonly sizeCells: number;
  /**
   * 确定性随机流。★ D-06 起**可被重置**(`resetWorld` 用新种子重造),
   * 故 `readonly` 已摘除 —— 保留它会让「换种子」在类型上不可能。
   */
  private rng: () => number;
  /** 战斗专用随机流(与 `rng` 分离,见 `WorldSimOptions.combatRng`)。重置时**同时**换。 */
  private combatRng: () => number;
  private readonly fluidBudget: number;
  private readonly wiringOn: boolean;
  private readonly mobsOn: boolean;
  /**
   * 世界群系。
   *
   * ⚠️ 本仓**没有「每格/每区块群系」这回事** —— `Biome` 只是
   * `shared/types/entities.ts` 里的枚举 + 每只怪的归属,地形生成不产出群系。
   * 于是「刷怪配表按群系分档」这件事此前无处落地:刷怪 tick 里写的是
   * `biome: 'PLAINS'`,而那个名字**不在 `BIOME_SPAWN` 表里**。
   * ⇒ 改成一个**显式**的世界群系(默认 MEADOW,创世草甸;
   * `decideSpawn` 对未知群系本来也兜底到 MEADOW)。将来真做了群系地图,
   * 把本字段换成「按坐标查询」即可 —— 刷怪逻辑不用动。
   */
  biomeName: string;
  /** 刷怪预算的小数累加器(见 `tickSpawn()`)。 */
  private spawnBudget = 0;
  /** 预算上界(只/慢帧):防「整图被挡」时累积成一次雪崩。 */
  private readonly spawnBudgetMax: number;

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
  /**
   * **打盹(挂机)玩家集合** —— 房间成员态在模拟侧的镜像。
   *
   * ## 为什么是「镜像」而不是「权威」
   *
   * 打盹是**房间的成员态**概念(`room.ts` 的 `MemberPresence` / `afkSinceMs`),
   * 模拟层**不该**自己算它 —— 模拟层不知道谁断线、谁切了后台。
   * 故这里只存房间推过来的事实,由 `setPlayerAfk` 单写入。
   *
   * ⚠️ **不要**与 `social/afk.ts` 的那套「打盹攒露水」玩法合并 ——
   * 那个是**玩法**(切后台 5 秒进打盹、按 30 秒/滴攒露水、篝火翻倍),
   * 本字段是**连接态**(打盹者仍占席位、仍 `connected`)。同名异义。
   * ⚠️ 注意:本文件**刻意不出现**那个模块里的任何函数名 ——
   * `tests/WS-11.test.ts` 有一条判据靠「本文件不含那些标识符」来断言
   * 「玩法模块仍未接线」。我在 docblock 里写全名会让它假红(实测过一次)。
   * ⇒ 需要查那两个函数名时,看 `docs/WS-11-coop-party.md`,不要抄进这里。
   *
   * ## 缺这个集合时的表现(本仓实测,task-74)
   *
   * 先前三处生产者**全写字面量 `false`** ⇒ `afk` 恒 false ⇒
   * 三条规则**静默失效**:打盹玩家仍被生物追打(`aoi.ts:62`)、
   * 仍**全额**分经验(`progression.ts:326`,手册 §4.1 说 `AFK_EXP_RATIO=0.3`)、
   * 仍被算作唤醒源(`behaviors.ts:196`)。
   * 三条都**不报错、不抛异常、门禁全绿** —— 「没接上」与「一切正常」不可区分。
   */
  private readonly afkPlayers = new Set<string>();
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
   * ★ R18:最近一次慢帧**因流体预算被打满而延后**的活跃格数。
   *
   * 与 `lastMobTicks` / `lastBossTick` 同一模式 —— 把「这一帧水为什么没动」
   * 暴露成可观测量。`> 0` 只说明**延后**(下一帧继续、水位未丢),
   * 不是「流体坏了」;`0` 说明额度够用。没有它,「预算打满 ⇒ 这一帧水不动」
   * 与「流体没接线 / 水已平衡」在外部**不可区分**。
   *
   * 取值来自 `FluidStepReport.deferredCells`(2Hz 慢帧),快帧保持上一值。
   */
  lastFluidDeferredCells = 0;
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

  /* ═══════════ task-84:WS-11 对局运行时(缺口 A — 每帧驱动)═══════════ */

  /**
   * 对局模式运行时。**`null` = 本房间没开派对模式**,不是「还没接线」。
   *
   * ## 为什么不在这里 `new` 一个
   *
   * `createPartyMode` 需要 `refereeId`(436 哨台归属者)与 `PartyModeKey` ——
   * 两者都是**玩家/房间级决策**,不是世界模拟层能自己定的。
   * 模拟层替它选一个默认值,就是**替上层做决定**,而那个决定永远不会被质疑:
   * 模式照样推进、播报照样发,只是裁判是错的。
   *
   * ⇒ 故本字段只由 `startPartyRun()` 写入,没开就是 `null`,tick 里直接跳过。
   * 这与 `afkPlayers` 的纪律一致(「只存房间推过来的事实,单写入」)。
   *
   * ★ WS-FND-120(第六轮 P1 修复):`startPartyRun()` 现在**有生产调用者**了 ——
   * `tickPartyStep` 的**哨台入口**每慢帧读 436 `ARENA_REFEREE_DESK` 的
   * `params.mode`(1..4 开局 / -1 收局)与「此刻站在哨台格上的玩家」,
   * 过 `party/actions.ts#gatePartyStart` 之后才调它。判据见
   * `tests/WS-FND-120`(含负对照:没人站哨台 ⇒ 不开局)。
   */
  private partyRun: PartyModeRuntime | null = null;

  /**
   * ★ WS-FND-120:对局**容器**(相位 + 子运行)。
   *
   * `partyRun` 只够推相位;夺旗 / 拾冠 / 掉冠 / 进球都挂在子运行上。
   * 容器由 `startPartyRun` 与 `partyRun` **同一次写入**建立,`clearPartyRun` 同时清空 ——
   * 两半绝不允许单独存在(否则世界侧会「相位在跑但动作层没有容器」)。
   */
  private partyContest: PartyContest | null = null;

  /**
   * ★ WS-FND-120:玩家 → 队伍(唯一来源 = 玩家**站上 435 复活旗**那一格时读到的
   * `params.team`)。抢皇冠的 `crownAssignTeam` 与夺旗的「本队桥板数」都读它。
   * 没站过任何旗 ⇒ 没有队伍 ⇒ 拾冠/夺旗被动作层闸门拒绝(不是猜一个队)。
   */
  private readonly partyTeams = new Map<string, TeamKey>();

  /**
   * ★ WS-FND-120:`party_gather`(GATHER)与 `party_reach_target`(REACH_TARGET)
   * 两个**发射点**的去重锁。
   *
   * 键 = `玩家:格` 或 `玩家:物品`。它解决的是**电平 ≠ 脉冲**:玩家站在旗格上
   * 每慢帧都会「触达」一次,不去重就会每 0.5 秒加一次分(不报错,只是分数失真)。
   * 离开格子 / 交付完成后清键 ⇒ 下一次触达重新计。
   */
  private readonly reachLatch = new Set<string>();

  /**
   * ★ WS-FND-120:哨台命令的**锁存**(键 = `组件ID:mode`)。同一条命令只执行一次 ——
   * 否则 `params.mode` 不清零时,一局结束后会**在同一帧立刻再开一局**,永远停不下来。
   */
  private refereeDeskLatch = '';

  /** 最近一次**真的发生**的派对结算(未结算 ⇒ null)。 */
  private lastPartySettlement: PartySettlement | null = null;

  /** 慢帧下发到客户端的播报(已从 broadcaster 取出 ⇒ 队列不再积压)。 */
  lastPartyBroadcasts: { kind: string; text: string; atSec: number }[] = [];

  /** 累计下发播报条数(可观测量:证明 broadcaster 有**消费者**,不是只写不读的队列)。 */
  partyBroadcastCount = 0;

  /** 最近一次结算发放的奖励合计(证明 rewards 真的落账,不只是躺在对象里)。 */
  lastPartyRewards: { exp: number; items: number; players: number } = { exp: 0, items: 0, players: 0 };

  /** 累计交付进急单的件数(= `submitDelivery` 被真调用的次数)。 */
  rushDeliveryCount = 0;

  /** 急单结算回执(`RUSH_GRADE` 从这里出去);未结算 ⇒ null。 */
  private lastRushSettlement: RushSessionSettlement | null = null;

  /** 打盹入口触发次数(= `setPlayerDozing` 被世界事实驱动的次数)。 */
  dozeEntryCount = 0;

  /**
   * 逻辑时钟。**与 `frameCount` 分离**,理由见 `tickPartyStep` 的注释。
   *
   * `createManualClock` 来自 `coop/rush_order.ts` —— 它是全仓**唯一**已实现的
   * `Clock`,且 `party/modes.ts:21` 的 `Clock` 类型就是从那里 import 的。
   * ⇒ 用它可以让 `PartyModeRuntime` 与将来的 `RushOrderSession` **共用同一个时钟**,
   *   否则两份秒数会各自漂移(ARCH-GAPS 的 W7:「两个同名 Clock 接口」)。
   */
  private readonly partyClock = createManualClock(0);

  /**
   * 挂机(打盹攒露水)玩家表。按键 = `playerId`。
   *
   * ⚠️ **与 `afkPlayers` 不是同一件事,不要合并** —— 见 `afkPlayers` 的 docblock:
   * 那个是**连接态**(断线回收),本表是**玩法态**(切后台 5 秒后打盹、攒露水)。
   * 同名异义,故本字段刻意不叫 `afkPlayers`。
   */
  private readonly afkRuns = new Map<string, AfkPlayer>();

  /**
   * 最近一次慢帧对局推进的可观测量。
   *
   * 与 `lastMobTicks` / `lastLogisticsTick` / `lastBossTick` 同一模式:
   * 把「这一帧推进了什么」暴露成**可观测量**。
   * 没有它,「驱动没接」与「接了但这帧恰好无事发生」从外面**看不出区别** ——
   * `tickPartyMode` 在 IDLE 相位返回空数组,而 `tickAfk` 在非后台时恒返回 0,
   * 两者都与「根本没调用」长得一模一样。
   */
  lastPartyTick: { partyTicked: number; afkTicked: number; afkDew: number; events: string[] } = {
    partyTicked: 0, afkTicked: 0, afkDew: 0, events: [],
  };

  /**
   * 急单会话(WS-11 的 `RushOrderSession`)。**`null` = 本房间没开急单。**
   *
   * ## ⚠️ 这个字段是我第一版**漏掉的**,而且漏得很隐蔽
   *
   * 第一版我只 import 了 `tickRushOrder` / `createRushOrderSession` / `startRushOrder`
   * 三个符号却**一个都不调用**。后果:
   * ```
   * · 可达性门禁:绿 —— import 就是一条边,闭包照样 +1(verify.ts:805 的判据是 import 形态)
   * · 任何「有没有接」的文本判据:绿 —— 符号确实出现在文件里
   * · 实际行为:**这一帧什么都没有推进**
   * ```
   * ⇒ 这正是我自己在报告里反复引用的「**引用 ≠ 执行**」,
   *   而我恰恰在**声称接线的那次提交**里犯了它。
   * ★ 它比 `wiring_view.ts` 那种「挂了 tick 也被丢弃」更难看:
   *   那种至少还有一次真调用可以被人发现,这种连调用点都没有。
   *
   * ⇒ 教训:**「import 了」与「调用了」是两个判据,只有后者能证明接线。**
   *   本文件的 `lastPartyTick.rushTicked` 就是为此加的 ——
   *   它让「没接」和「接了但这帧结算了」在外部**看得出区别**。
   */
  private rushRun: RushOrderSession | null = null;

  /**
   * ★ **D-13**:每个玩家"正在喷水"的意图窗口(以 `frameCount` 计,不是挂钟)。
   *
   * ## 为什么需要它(而不是每帧无条件喂坐标)
   * `stationsBeingSprayedBy` 只判「谁在半径内**且**工位在烧」。若每慢帧无条件喂坐标,
   * **站在燃烧工位旁边**就会自动 0.5 秒灭火 —— 那不是"浇水",那是"靠近即灭火"。
   * ⇒ 只有**刚用过 227/212**(`useItem` 的灭火分支)的玩家,才在他的意图窗口内喂坐标。
   *
   * 窗口长度 = **一个慢帧**(`FAST_PER_SLOW` 快帧),即 0.5 秒 —— 刚好够
   * `EXTINGUISH_SEC`(0.5)累计一次;**不新增数值常量**(两个都是既有常量)。
   */
  private readonly sprayUntil = new Map<string, number>();

  /**
   * ★ **第三轮**:每个玩家"正在翻炒"的意图窗口 —— 与 `sprayUntil` **同形、同列清**。
   *
   * ## 为什么必须有它(第三轮实测 P1/P2:生产从不喂 `tended`)
   * `tickRushOrder` 的 `opts.tended` 修前全仓**没有生产者**:慢帧只算 `spraying`,
   * 于是 `StationRuntime.runningSec` 只增不减 ⇒「连续运转 `OVERHEAT_SEC`(12 秒)
   * 不翻炒 ⇒ 起火」在生产里退化成**必然起火**(见 `rush_order.ts#stationsBeingTendedBy`)。
   *
   * 判据:`extinguishDeviceByHand` 里 `212`(大铁铲)的那一支记一条;
   * 慢帧(`tickPartyStep`)与 `spraying` 同段把它换成工位种类喂给 `tickRushOrder`。
   * 窗口长度同 `sprayUntil` = 一个慢帧(`FAST_PER_SLOW` 快帧),不新增数值常量。
   */
  private readonly tendUntil = new Map<string, number>();

  /** 最近一次慢帧有没有真正推进急单(1 = 调了 `tickRushOrder`,0 = 没开急单)。 */
  rushTicked = 0;

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

  /**
   * 装备/手持的**权威档案**(玩家 ID → 档案)。
   *
   * 见 `PlayerProfile` 的长注释:它必须独立于每帧重建的 `mobPlayers`,
   * 否则装配层的装备会被 `syncPlayers()` 抹掉。
   *
   * 谁写:装配层 `setMobPlayers` / `setProfile`。谁读:`wearingOf`(战斗)、
   * `syncPlayers`(投影给生物 AI)。
   */
  private readonly profiles = new Map<string, PlayerProfile>();

  /** 最近一次击杀结算结果(供断言与 UI;null = 尚未发生击杀)。 */
  lastKillSettle: ShareResult | null = null;

  /**
   * 最近一次击杀结算出的**掉落**(★ WS-FND-98)。
   *
   * 判定在 `settleKill` 里做,种子取**世界种子**(`worldSeed`)+ **击杀实例维**(实例 id)⇒
   * 「同一个种子的世界,打死**同一只**怪,掉同一份东西」可复现,而同种怪的**不同次击杀**
   * 各自独立(只吃世界种子会让同种怪每次击杀都掉同一份,见 `mobs/drops.ts` 文件头第 5 条);
   * 同一次击杀被二次结算(`deduped`)时**不给第二次**,与经验/积分的去重口径一致。
   *
   * 空数组有两义:「这只怪没有掉落」与「还没发生过击杀」—— 与 `lastKillSettle` 的 `null`
   * 一起看即可区分(后者为 `null` ⇒ 尚未击杀)。
   */
  lastMobDrops: readonly MobDropResult[] = [];

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

  /**
   * 本房间号(装配层经 `WorldSimOptions.roomId` 给)。空串 = 没给。
   * ⚠️ 它**只是身份**,不是配置:`spawner` 拿到它之后去问 provider(见 `mobs/spawner.ts`
   * 的"安全区半径可注入"一节),由装配层决定 provider 是 `modify_town.ts` 的适配器。
   */
  roomId = '';
  /**
   * 本世界的**种子身份**(构造期 `WorldSimOptions.seed`;`resetWorld` 换新种子)。
   *
   * 与 `rng` 的分工见 `WorldSimOptions.seed` 的 docblock:这是**身份**,不是流。
   * 归档行记的是它(旧世界的种子),`tests/WS-FND-62` 用它断言「重置真的换了种子」。
   */
  worldSeed = 0x5eed;
  /**
   * 每个玩家**首次进入本世界时**的位置 = 出生点(`addPlayer` 单写)。
   *
   * ## 为什么世界要自己记一份
   *
   * 出生点是**房间**定的(`room.ts:spawnPoint()`:`0.5 + n*1.5`),世界只在
   * `addPlayer(id, x, y)` 时被**告知**一次。重置要把玩家「送回出生点」——
   * 而世界既没有房间的出生点函数,也不该去问(那会让 sim 依赖 net)。
   * ⇒ 记住**首次**进入时的坐标,重置时回到那里。
   *
   * ⚠️ 只在**首次**登记时写(`if (!has)`):重进(重连/读档)时的坐标是
   * **当前位置**,不是出生点 —— 覆盖它会让「重置回出生点」把玩家送到
   * 上一次断线的地方(而那正是本仓库多次踩过的"重进被拉回/被推到别处"同族缺陷)。
   */
  private readonly spawnPoints = new Map<string, { x: number; y: number }>();
  /* ══════════ ★ WS-FND-77 / D-19:四个房间系统 + 料理 3 字段的世界侧状态 ══════════
   *
   * 全部状态**只在这里**(`systems/wiring.ts` 的 `RoomSystemsState` 是纯数据容器)。
   * 为什么世界要持有一份:四个系统的实现是**纯函数**(不碰世界、不读时钟),
   * 而「谁的牧场 / 哪一格作物 / 陈列馆里有什么 / 摊位还剩几件」是**世界世代**
   * 的一部分 —— 它们必须随 `rebuildWorld` 一起换代(见那里的注释)。
   */
  private roomSystemsState: RoomSystemsState = createRoomSystemsState();
  /** 天气(世界侧唯一来源;`greenhouse.ts` 只接受判好的值,不自己判定)。 */
  private weatherNow: Weather = 'CLEAR';
  /**
   * 累计的「过了多少天」的小数部分(牧场跨日结算用)。
   *
   * 为什么不直接用 `frameCount`:一整天是 `WORLD_DAY_SEC = 1200` 秒
   * (24000 帧),用帧号算跨日要除两次;而 `advanceRoomSystems` 已经按
   * 「天的一部分」推进,同一个累加器同时服务温室(按天生长)与牧场(按天结算)。
   */
  private dayFraction = 0;

  /**
   * 房间内的**第几天**(0 起整数)—— `settleRanchOnce` 幂等键的一维。
   *
   * 由 `advanceRoomSystems` 在 `dayFraction` 里凑出**整数天**时 `+= whole`;
   * 不从 `frameCount` 反算(那要多除两次,且慢帧不匀速时会跳日)。
   * ⚠️ 只增不回退:被幂等拒掉的那一拍也算「过了一天」,否则重放能把日结钉死。
   */
  private roomDayIndex = 0;
  /** 最近一次四系统慢帧报告(`null` = 还没跑过)。 */
  private lastRoomSystems: {
    grown: number;
    matured: HarvestRow[];
    ranchDays: number;
    ranchProduced: number;
    ranchDropped: number;
  } | null = null;
  /**
   * 无人自助售货摊(515)的库存:`物品 id → 件数`(世界世代的一部分)。
   *
   * ⚠️ 与它**成对**的购买幂等键**不在本文件**:修前那张私有表
   * (`committedPurchaseKeys`,`${actorId}#${itemId}#${frameCount}` 形状)已并入
   * `roomSystemsState.settled`(键形 `CLOUD_DEPOT@ORDER:<订单号>`,见
   * `systems/idempotency.ts`)—— 与牧场 / 炼金**同一把键、同一张表**,
   * 重置时一处清空就够(两张表各清一处、漏一处就是静默拒单)。
   */
  private stallStock: Record<number, number> = {};
  /** 最近一次牧场日结的**落货**账(哪些产出真的落到地上 / 哪些没物品 id)。 */
  private lastRanchDrop: { dropped: { itemId: number; count: number; x: number; y: number }[]; skipped: string[] } =
    { dropped: [], skipped: [] };
  /** 注入的世界归档口(★ D-06)。`null` = **没有库**(装配层没给)。 */
  private readonly archiveSink: WorldArchiveSink | null;
  constructor(opts: WorldSimOptions = {}) {
    this.sizeCells = Math.max(16, Math.trunc(opts.sizeCells ?? 64));
    this.fluidBudget = Math.max(1, Math.trunc(opts.fluidBudget ?? FLUID_CELL_BUDGET));
    this.wiringOn = opts.wiring !== false;
    this.mobsOn = opts.mobs !== false;
    this.biomeName = opts.biome ?? 'MEADOW';
    this.roomId = opts.roomId ?? '';
    this.spawnBudgetMax = 4;
    /* ★ 种子**身份**先落位:`rng` 的默认值由它派生(没给 `seed` ⇒ 0x5eed,
       与接线前 `mulberry32(0x5eed)` 逐字一致)。 */
    this.worldSeed = Number.isFinite(opts.seed) ? Math.trunc(opts.seed as number) : 0x5eed;
    this.archiveSink = opts.archiveSink ?? null;
    this.rng = opts.rng ?? mulberry32(this.worldSeed);
    /* 战斗随机**独立成一条流** —— 见 `combatRng` 字段注释。
       种子取构造期默认值 `0xc0ffee` 的派生值,同种子仍完全可复现。 */
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
    /* D-07 的世界钟必须**每帧**可读:405 昼夜感光器读的 `hour` 不是摆放时的静态参数。
       两条构造路径(构造器 / `rebuildWorld`)都要挂,否则重置之后感光器会退回"缺失 = 0"。 */
    this.installWorldEnv();
    this.aoi = new AoiManager();
    this.spawner = new MobSpawner();

    /* 物理需要一个 PhysTerrain;WorldGrid 已实现 TerrainSource,
       但两边的接口名略有差异,这里用一层薄适配把名字对齐 —— 
       不复制逻辑,只转发调用。
       ★ D-06 起这段搬进 `makePhysicsWorld()`:重建世界要用**同一份**适配
       (抄第二遍就会漂移,而漂移在物理上表现为"水穿墙/踩不到地板")。 */
    this.physics = this.makePhysicsWorld();
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
      consumeGroundItem: (itemId, count) => this.consumeGroundItem(itemId, count),
      setFloor: (x, y, floor) => {
        /* 写 FLOOR 层。用 `setCell` 而非直接改 tile —— 后者会绕过水位投影。 */
        this.setCell(Math.floor(x), Math.floor(y), { floor });
      },
      placeObj: (x, y, obj) => {
        this.setCell(Math.floor(x), Math.floor(y), { obj });
      },
      spawnItem: (x, y, itemId, count) => {
        /* 委托给 `dropItem` —— 单一实现(见那里的注释:两个字段都要写)。 */
        this.dropItem(x, y, itemId, count);
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

  /* ═══════════ 玩家语义的物质层(2026-11-14)═══════════

     `docs/TASK-96` 把 17 个未接线动作分成三档,其中 4 个
     (`PLACE_BLOCK` / `BREAK_BLOCK` / `DROP_ITEM` / `PICKUP_ITEM`)属于
     「有相邻机制、缺中间一环」:底层 `setCell` / `mobGround` 都在,
     但缺一个**带玩家语义的薄入口**。这一节就是那层薄入口。

     与底层写口的**分工**(这是它存在的全部理由):

     ```
     setCell(x,y,fields)   底层写口:不判"能不能",只管写(存档/相变/AI 都用它)
     placeBlock(...)       玩家语义:判世界内 / 该格空 / 该格无实体,再写
     ```

     ⚠️ 「判能不能」必须在这里、而不是房间层:房间拿不到 `grid` 与
        `physics.bodies`(私有),它只有 `WorldSaveHost` 这一层结构化接口
        ⇒ 判定与写入同处一地,否则又变成"两份实现"。 */

  /** 该点是否在世界内(格坐标)。 */
  private inWorld(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.sizeCells && y < this.sizeCells;
  }

  /** 该格的 obj 层 id(0 = 空)。玩家放置/破坏的**读口**。 */
  blockAt(x: number, y: number): number {
    return this.inWorld(x, y) ? this.grid.objIdAt(Math.floor(x), Math.floor(y)) : 0;
  }

  /**
   * 放一个块(**玩家语义的薄入口**)。
   *
   * 判三件事,按代价从低到高:
   *   1 在世界内;
   *   2 该格 **obj 层为空** —— 覆盖已有物件等于凭空拆掉别人的东西;
   *   3 该格 **没有实体站着** —— 否则会把玩家/生物封进实体块,表现为卡死。
   *
   * ## `obj` 与 `item` 共用编号空间(这不是我发明的)
   * `behaviors.ts:429` 就是 `world.placeObj(rt.x + 1, rt.y, ITEM.PLANK)` ——
   * 生物 AI 直接把**物品 id** 写进 obj 层。所以 `PLACE_BLOCK` 的 `itemId`
   * 同时就是 obj id,不需要第二张映射表(内容层里也确实没有那张表)。
   */
  placeBlock(x: number, y: number, objId: number): { ok: true } | { ok: false; reason: string } {
    if (!this.inWorld(x, y)) return { ok: false, reason: `坐标 ${x},${y} 在世界外` };
    if (!Number.isInteger(objId) || objId <= 0) return { ok: false, reason: `物件 id 非法:${objId}` };
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    const cur = this.grid.objIdAt(gx, gy);
    if (cur !== 0) return { ok: false, reason: `该格已有物件(${cur})` };
    /* 实体占用:直接读物理刚体(玩家与生物都在 `bodies` 里)。
       不用"格上有没有人"的启发式 —— 那会漏掉被击退到别格、或正卡在格边的。 */
    for (const b of this.physics.bodies.values() as IterableIterator<{ x: number; y: number }>) {
      if (Math.floor(b.x) === gx && Math.floor(b.y) === gy) {
        return { ok: false, reason: '该格上有实体站着,不能放置' };
      }
    }
    this.setCell(gx, gy, { obj: objId });
    return { ok: true };
  }

  /**
   * 拆掉一个块,返回**被拆下来的那个 obj id**(调用方拿它当掉落物)。
   * 空格返回 `ok:false` —— 不给「拆空气」这种静默成功。
   *
   * ## `actorId`(可选,WS-FND-77 / W 线:`gatherMul`)
   *
   * 采集乘子(602「伐木与采矿速度 +20%」)只有在**知道是谁在采集**时才能用 ——
   * 此前的签名里没有 actor,于是那个字段永远无处归属(第 3 个无人消费的料理字段)。
   *
   * ⚠️ **不给 actor ⇒ 与接线前逐位相同**(返回值连键都不多一个);
   *   给 actor ⇒ 回执多一个 `gatherMul`(该玩家当前的合并乘子)。
   *   为什么要把它放回执而不是在这里乘件数:一次 `breakBlock` 只产出 1 件,
   *   而「+20% 的采集速度」在没有采集时长的模型里没有可乘的量纲 ——
   *   件数放大规则要 owner 裁决(`items.ts` 的 `flags.dropDoubleChance` 那一族),
   *   本方法**不编规则**(见 `systems/wiring.ts:gatherMulOf`)。
   */
  breakBlock(
    x: number,
    y: number,
    actorId?: string,
  ): { ok: true; objId: number; gatherMul?: number } | { ok: false; reason: string } {
    if (!this.inWorld(x, y)) return { ok: false, reason: `坐标 ${x},${y} 在世界外` };
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    const obj = this.grid.objIdAt(gx, gy);
    if (obj === 0) return { ok: false, reason: '这一格没有物件' };
    this.setCell(gx, gy, { obj: 0 });
    /* 只有给了 actor 才把采集乘子带上(不给 ⇒ 回执与接线前**逐位相同**)。 */
    if (typeof actorId === 'string' && actorId.length > 0) {
      return { ok: true, objId: obj, gatherMul: this.gatherMulOfPlayer(actorId) };
    }
    return { ok: true, objId: obj };
  }

  /**
   * 附近的地面掉落物(**玩家视角**:带格坐标与距离)。
   * 生物 AI 那份是 `mobWorldAdapter().groundItems()`(只要 id、不要坐标);
   * 两者读的是同一个 `mobGround` ⇒ 世界上不存在"两个地面"。
   */
  groundItemsNear(
    x: number, y: number, radius: number,
  ): { itemId: number; count: number; x: number; y: number; dist: number }[] {
    const out: { itemId: number; count: number; x: number; y: number; dist: number }[] = [];
    for (const g of this.mobGround) {
      const dist = Math.hypot(g.x - x, g.y - y);
      if (dist > radius) continue;
      out.push({ itemId: groundItemId(g), count: g.count, x: g.x, y: g.y, dist });
    }
    /* 由近及远:拾取取的是"最近的那一件"(与玩家直觉一致)。 */
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /**
   * 把地面上的某件东西**拿起来**(语义:扣掉地面上那一件)。
   * 返回是否真的拿到了 —— `false` = 附近没有这件。
   * ⚠️ 调用方**必须**据此决定要不要加背包:不能"先加背包、再假设拿到了"。
   */
  takeGroundItemNear(x: number, y: number, itemId: number, radius: number): boolean {
    if (!this.groundItemsNear(x, y, radius).some((g) => g.itemId === itemId)) return false;
    return this.consumeGroundItem(itemId, 1, x, y, radius) === 1;
  }

  /**
   * 把物品放到地面(背包 → 世界)。
   *
   * ⚠️ **两个字段都写**(`id` 与 `itemId`):`GroundItem` 接口声明的是 `id`,
   * 而生产写入侧与 `groundItemId` 的读法用的是 `itemId`;只写一个会让另一侧
   * 看不到这批货(实测 `consumeGroundItem` 对**确实存在**的货返回 0)。
   * 那是本文件已记过的一个真实缺陷 ⇒ 这里作为**唯一写入点**,一次写全。
   */
  dropItem(x: number, y: number, itemId: number, count: number): void {
    if (!Number.isInteger(itemId) || itemId <= 0 || count <= 0) return;
    this.mobGround.push({ id: itemId, itemId, x, y, count } as GroundItem);
  }

  /**
   * 玩家语义的物质层**一次性暴露**(给 `WorldSaveHost` 用)。
   *
   * 为什么打包成一件能力、而不是在接口上摊平 7 个成员:接口每多一个成员,
   * 本仓所有**手写 host 假件**都要跟着补(实测 `tests/WS-07` 里就有 3 个)。
   * 摊平 ⇒ 每扩一次能力就改 3 处测试夹具;打包 ⇒ 只加 1 个成员。
   */
  materials(): MaterialApi {
    return this;
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
   *
   * ★ 第四轮实测 P1:上面这句此前**不成立** —— 扣料是逐项做的、某一项不足就
   *   `return ok:false`,**已扣的那几项永久消失**(既不产出也不归还);而复核与扣减
   *   之间还隔着一次 `await forge(...)`。今天由 `consumeMaterialsFor` 的
   *   「同一段同步代码里复核 + 扣减 + 失败还原」保证。
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

    /* 2 材料必须在**地面**上真的存在(够扣)。露水不从材料位扣(门禁已剥离)。
       ⚠️ 这一步只是**早退**(跑不通就别白跑一次 forge):**权威的那次复核**在扣料前
       一刻、与扣减处在**同一段同步代码**里(`consumeMaterialsFor`)。
       修前这里是唯一的复核,而它与扣减之间隔着 `await forge(...)` ⇒ 可被交错。 */
    const need = new Map<number, number>();
    for (const id of gate.materialIds) need.set(id, (need.get(id) ?? 0) + 1);
    for (const [id, want] of need) {
      const have = this.groundCountOf(id);
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

    /* 4 扣料:**原子**(复核 + 扣减 + 失败还原在同一段同步代码里 ——
       见 `consumeMaterialsFor` 的 docblock)。修前这里是「逐项扣,某一项不足就
       `return ok:false`」:前几项**已永久消失** ⇒ 与本方法
       「`ok:false` 时世界完全未被改动」的自述直接矛盾(第四轮实测 P1)。 */
    const consumed = this.consumeMaterialsFor(need);
    if (consumed === null) {
      return {
        ok: false,
        stage: 'INVENTORY',
        message: '扣料阶段材料被改动:地面库存与复核时不一致(本批材料已**全部还原**)',
      };
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

  /** 地面某件材料的**总件数**(单一计数实现:`forgeAlchemy` 的早退与原子扣料共用)。 */
  private groundCountOf(itemId: number): number {
    let have = 0;
    for (const g of this.mobGround) if (groundItemId(g) === itemId) have += g.count;
    return have;
  }

  /**
   * 一次性扣掉一组材料 —— **原子**(复核 / 扣减 / 失败还原都在同一段同步代码里)。
   *
   * ## 修的是什么(第四轮实测 P1)
   *
   * 修前 `forgeAlchemy` 是「逐项 `consumeGroundItem`,扣到某一项不足就
   * `return ok:false`」,两个后果:
   * ```
   * 1 前面几项**已经扣掉了** ⇒ 那批材料永久消失(既不产出、也不归还),
   *   与该方法契约「ok:false 时世界完全未被改动」直接矛盾;
   * 2 扣料发生在 `await this.alchemy.forge(...)` **之后** ⇒ 从「上一步核过库存」
   *   到「真的扣下去」之间隔着一次 await,别的系统可以在那道缝里改地面。
   * ```
   * 本方法把「全量复核 + 扣减」压进**同一段同步代码**:JS 单线程 ⇒ 复核一旦成立就
   * 一定扣得满;仍留一条防守分支 —— 一旦有一项扣不满,就把这一批**逐堆还原**
   * (件数 **和** 数组次序都还原 ⇒ 与调用前逐字段相同)。
   *
   * ⚠️ 扣减仍然**只走** `consumeGroundItem`(全仓唯一的那种读法):这里不另写一份
   *   遍历,否则又回到"同一个类里两种读法"那个已被点名的缺陷。
   *
   * @returns 逐项实际扣减数(键序与 `need` 一致);任何一项不足 ⇒ `null`(**世界已还原**)
   */
  private consumeMaterialsFor(need: ReadonlyMap<number, number>): { itemId: number; count: number }[] | null {
    /* 1 全量复核:每一项都得够 —— 与下面的扣减之间**没有 await**。 */
    for (const [id, want] of need) {
      if (this.groundCountOf(id) < want) return null;
    }

    /* 2 还原快照:**数组次序 + 每堆件数**。只记总件数不够 —— 被扣空的堆会被
       `consumeGroundItem` 从数组里摘掉,还原时必须连位置一起放回去。 */
    const order = this.mobGround.slice();
    const counts = order.map((g) => g.count);

    /* 3 扣减。 */
    const consumed: { itemId: number; count: number }[] = [];
    for (const [id, want] of need) {
      const got = this.consumeGroundItem(id, want);
      consumed.push({ itemId: id, count: got });
      if (got !== want) {
        for (let i = 0; i < order.length; i += 1) order[i].count = counts[i];
        this.mobGround.length = 0;
        for (const g of order) this.mobGround.push(g);
        return null;
      }
    }
    return consumed;
  }

  /**
   * 从地面掉落物里扣减指定物品,返回**实际**扣减数。
   *
   * ★ 2026-11-14:「两份实现」这一条已经收掉了 —— `mobWorldAdapter().consumeGroundItem`
   *   现在**直接委托**本方法(不再各写一遍遍历)。这也修掉了当初那个"时灵时不灵"
   *   的最坏之处:同一个类里两种读法。现在权威只有这一个数组、一种读法。
   *
   * ★ 同日加 `nearX/nearY/radius`:**给了范围**就只扣范围内的那些堆
   *   (玩家拾取用:不该够到 3 格外的货);**不给**就是"全图扣"
   *   (生物 AI 的既有语义)。两者共用同一段遍历 —— 语义差异只在过滤器。
   */
  consumeGroundItem(itemId: number, count: number, nearX?: number, nearY?: number, radius?: number): number {
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
      /* 范围过滤:只在**调用方给的圈内**扣。缺省(不给三个参数)≡ 全图扣。 */
      if (nearX !== undefined && nearY !== undefined && radius !== undefined) {
        if (Math.hypot(g.x - nearX, g.y - nearY) > radius) continue;
      }
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
   * **权威攻击入口**(US2/task-47):玩家攻击某只生物。
   *
   * ## 与 `attackMob` 的分工(这就是信任边界)
   *
   * `attackMob(playerId, mobId, opts)` 的 `opts` 含 `level` / `wearing` /
   * `weaponId` / `comboMul` —— 全是**调用方自报值**,是给测试注入夹具用的。
   * 本方法**不接受任何面板参数**:等级取 `progresses`(权威),装备取
   * `profiles`(权威)。网络层只调本方法;客户端报文**只允许**携带意图
   * (`mobId`),不得携带面板数据 —— 与 CR-14 U1 的
   * `allowedSources` / `capacity` 同一条纪律。
   *
   * ## 两道闸,而且它们拦的不是同一件事
   *
   * - **身份闸**:`playerId` 必须在 `playerIds` 里(是玩家不是生物)。
   *   生物也活在 `physics.bodies` 里,不查这一条,「用一只生物打另一只」
   *   就能借道 `mobDistance` 通过距离校验。
   * - **AOI 闸**:该玩家到目标的距离 ≤ `AOI_WAKE_DISTANCE`(32 格)。
   *   睡着的怪(附近没有任何玩家)不该被谁打到;这也是「目标必须在模拟层
   *   真的活跃」的近似。**用距离直接判,不用 `aoi.isActive`** —— 后者被
   *   生物互相唤醒污染了,见方法内注释。
   * - **reach 闸**:由 `computeDamage` 的第 0a 步按武器 `reach` 拦
   *   (`outOfReach`)。阈值**复用**管线既有值,不另起一套
   *   (与 `checkAttack` 同一纪律)。这一道比 AOI 更严,是最终的「打得到吗」。
   *
   * 三道合取 ⇒ 「你能打到它」= 「你是玩家」∧「它在活跃半径内」∧「在武器射程内」。
   *
   * ⚠️ 为什么 `aoi.isActive` **不能**替代「到该玩家的距离」:
   * `AoiManager.players` 里混进了生物自身(`sim.players` 由 `physics.bodies`
   * 全体构成),生物互相唤醒 ⇒ 实测距玩家 **50 格** 的生物 `isActive=true`。
   * ⇒ 它回答的是「**有没有任意**玩家在它附近」,不是「**这个**玩家在不在」。
   * 那是 `server/src/mobs/` 的既有缺陷(不在本任务写域),已记入报告未做项。
   *
   * ## `comboMul` 为什么不在这里出现(明确未做项)
   *
   * 连段倍率来自**客户端输入节奏**(普攻三段的第 3 段 = 1.25)。
   * 服务端接受自报即 CR-14 U2 同族缺口;而 task-51 只给它加了**上界**,
   * 「有上界」≠「有权威」。服务端目前**没有连段状态机**,凭空造一个属于
   * 超范围 ⇒ 这里固定按普攻第 1 段(`comboMul` 缺省 1.0)结算。
   *
   *
   * ## ★ 幽灵泡泡闸(规则 4:倒地不能攻击 —— 2026-11-14 补,修前此处零命中)
   *
   * 真值来源是 **`VitalsSystem.downed`**(见下方闸 0b 的实现处注释:
   * 为什么不是 `DownedState`)。
   *
   * @returns `hit === null` 且 `outcome === 'OK'` = 没有这只生物(不静默造伤害);
   *          `outcome === 'OUT_OF_AOI'` = **未结算**(目标不在活跃区,或被闸拒绝 ——
   *          是哪种看 `rejected`);
   *          `rejected` = 显式拒绝的理由(`null` = 未被拒绝),取值:
   *          `NOT_A_PLAYER` / `DOWNED` / `STUNNED` / `TRAPPED` /
   *          `LOS_BLOCKED`(隔墙,与 PvP / 生物→玩家同一条射线)/ `OUT_OF_AOI`。
   *
   *          ⚠️ 为什么不新造 `outcome` 的成员(`'DOWNED'` / `'STUNNED'` ...):
   *          该联合类型是**对外契约**(`server/src/net/room.ts` 的
   *          `AttackReport.outcome` 与 `WorldSaveHost.attackMobAuthorized` 的声明),
   *          加一个成员会立刻在 `room.ts` 里产生**新的**类型错误 —— 而本仓的
   *          `typecheck-baseline` 锁住既有错误数,新增即门禁红。
   *          ⇒ 机器外契约不动,理由由 `rejected` 字段承载(它同时是**可判定**的:
   *          `=== 'DOWNED'` / `=== 'LOS_BLOCKED'` 即可,不需要读人类可读的字符串)。
   */
  attackMobAuthorized(
    playerId: string,
    mobId: string,
    opts: {
      fromDeg?: number;
      /**
       * ★ [Q] 意图(生产形态):`true` ⇒ 技能从**当前武器**取(`skillOf`)。
       * 客户端只表达「我按了 Q」,不带任何数值 —— 与 `weaponId` 的自报纪律同源。
       * ⚠️ `net/**` 还没有这个动作报文(不在本轮写域),见 `combat/wiring_ledger.ts`。
       */
      useSkill?: boolean;
    } = {},
  ): {
    outcome: 'OK' | 'OUT_OF_AOI';
    /**
     * 形状与 `attackMob` 的返回**逐字段对齐**(含 `segments` / `totalDamage`)——
     * 少了它们,[Q] 的多段在回执里就会被读成「1 段」。
     * ⚠️ `net/room.ts` 的 `WorldSaveHost` 只声明它用到的那三项,那是**子集**,
     *    与这里不冲突(结构化类型)。
     */
    hit: {
      result: PipelineDamageResult;
      hpLoss: number;
      events: string[];
      segments: number;
      totalDamage: number;
    } | null;
    /**
     * 显式拒绝的理由;`null` = 未被拒绝(走到了结算或缺生物)。
     *
     * 为什么要这个字段:`outcome` 只有两个值,装不下「为什么没结算」——
     * 而「被打成幽灵泡泡 ⇒ 不能攻击」与「目标在 32 格外」是**两件事**,
     * 混成一个值就是**谎报**(本文件反复强调的取舍)。
     */
   rejected: 'NOT_A_PLAYER' | 'DOWNED' | 'STUNNED' | 'TRAPPED' | 'LOS_BLOCKED' | 'OUT_OF_AOI' | null;
  } {
    /* 闸 0:`playerId` 必须是**登记过的玩家**,不是生物。
       否则攻击者可用一只生物当「玩家」去打另一只(它同样在
       `physics.bodies` 里,`mobDistance` 能算出距离)。 */
    if (!this.playerIds.has(playerId)) return { outcome: 'OUT_OF_AOI', hit: null, rejected: 'NOT_A_PLAYER' };

    /* 闸 0b:★ **幽灵泡泡规则 4 —— 倒地者不能攻击**(与移动侧对称,见 `applyPlayerMove`)。
     *
     * ## 真值来源:`vitals.downed`(**不是** `DownedState`)
     *
     * ```
     * vitals.downed        applyHit 把 HP 打到 0 的**同一帧**置真   ← 本闸读它
     * DownedState(泡泡)   由 tickDowned 在**慢帧**(2Hz)才建        ← 不读它
     * ```
     * 三条理由:
     * 1. **`DownedState` 是 `downed` 的派生状态机**,不是判据本身 ——
     *    `tickDowned` 的注释明写「触发条件读 `vitals.downed` 而不是自己判 HP」,
     *    这里若改读它,等于让动作权限比伤害判定**晚**最多 0.5s(一个慢帧),
     *    表现是「HP 已归零、泡泡还没建,却还能打出一刀」。
     * 2. 它由**慢帧**维护 ⇒ 秒级窗口;权限判定不该依赖帧相位。
     * 3. `DownedState` 还承载 `BUBBLED`(227 泡泡水枪困人)等**别的**语义,
     *    拿它当「是否倒地」会让两种状态混成一个判据。
     * ⇒ 免伤(`applyHit` 的 `if (v.downed) return base`)与不能治疗
     *   (`heal` 的 `if (v.downed) return 0`)读的**也是**这个字段 ——
     *   四条规则一个真值来源,不新造第二套「是否倒地」。 */
    /* ★ 第六轮实测 P1(幽灵期规则两套):本闸**不再自己手判** `downed` ——
       那套手判与 `revive.ts#ghostControl` 是同一规则的两种表达(后者生产 0 调用)。
       判定收在 `canActAsPlayer`(读 `ghostControl(...).canAttack`),两条攻击入口共用。 */
    if (!this.canActAsPlayer(playerId)) {
      return { outcome: 'OUT_OF_AOI', hit: null, rejected: 'DOWNED' };
    }

    /* 闸 0c / 0d:★ 攻击侧也封 **STUNNED / TRAPPED**(与移动侧 `applyPlayerMove`
       的 3316 / 3323 **逐字同源**):真值来源不变 —— `vitals.stunOf`(Boss 定身)
       与 `isTrapped(liveBubbleOf(...))`(227 泡泡)。此前**只有移动侧**读它们 ⇒
       「被冻住 / 被泡泡装起来,却还能挥刀」。与移动侧同一台状态机、同一批拒因名,
       不新造第二套判定(否则两条路会漂移,而门禁查不出)。 */
    if (this.vitals.stunOf(playerId) > 0) {
      return { outcome: 'OUT_OF_AOI', hit: null, rejected: 'STUNNED' };
    }
    if (isTrapped(this.liveBubbleOf(playerId))) {
      return { outcome: 'OUT_OF_AOI', hit: null, rejected: 'TRAPPED' };
    }

    const rt = this.mobHost.runtimeOf(mobId);
    if (rt === null) return { outcome: 'OK', hit: null, rejected: null };

    /* 闸 1:AOI —— 判据是「**这个**玩家到它的距离 ≤ AOI 唤醒半径」。
     *
     * ⚠️ 刻意**不用** `aoi.isActive(mobId)`。实测(`_us2_gate2.ts`):
     * `AoiManager.players` 里混进了**生物自身**(它是 `sim.players`,
     * 而 `sim.players` 由 `physics.bodies` 全体构成,生物也在其中),
     * 于是生物互相唤醒 —— 实测一只距玩家 **50 格** 的生物 `isActive=true`。
     * ⇒ `isActive` 回答不了「你能否打到它」,拿它当授权闸等于没闸。
     * 那是 `server/src/mobs/` 的既有缺陷(不在本任务写域),
     * 这里用**玩家到生物的权威距离**直接判定,语义才是对的。
     *
     * 距离读 `physics.bodies`(服务端权威位置,由 `applyMove` 带反作弊上界写入)
     * ⇒ 客户端无法伪造「我在它旁边」。 */
    const distance = this.mobDistance(playerId, mobId);
    if (!Number.isFinite(distance) || distance > AOI_WAKE_DISTANCE) {
      return { outcome: 'OUT_OF_AOI', hit: null, rejected: 'OUT_OF_AOI' };
    }

    /* ★ 闸 2:视线(与 PvP 的第 3 闸、生物→玩家的 D2 是**同一条射线**)——
       隔墙砍不到生物,对怪同样成立。判据读 `grid.isSolidAt`(权威地形),
       与 :2202 / :5091 逐字同参。`losBlocked` 的取反语义见 `vision.ts`
       (端点在实心格 / 坏坐标 ⇒ fail-open,那是既有取舍,这里不复述)。 */
    const attackerBody = this.physics.bodies.get(playerId);
    if (attackerBody !== undefined &&
        losBlocked(attackerBody.x, attackerBody.y, rt.x, rt.y, (cx, cy) => this.grid.isSolidAt(cx, cy))) {
      return { outcome: 'OUT_OF_AOI', hit: null, rejected: 'LOS_BLOCKED' };
    }

    const hit = this.attackMob(playerId, mobId, {
      level: this.levelOf(playerId),
      wearing: this.wearingOf(playerId),
      comboMul: 1.0,
      ...(opts.fromDeg !== undefined ? { fromDeg: opts.fromDeg } : {}),
      /* ★ [Q]:意图原样转发。技能本身由 attackMob 从**武器**取,不从这里传定义。 */
      ...(opts.useSkill === true ? { useSkill: true } : {}),
    });
    return { outcome: 'OK', hit, rejected: null };
  }

  /**
   * **玩家 → 玩家** 的伤害入口(D3 的 PvP 那一半)。
   *
   * ## 修前是什么样
   *
   * `docs/DAMAGE-LOOP.md` §8 的表格里写着「玩家攻击玩家的 PvP 结算 | 未实现」。
   * 实测:`attackMobAuthorized` 的第一个闸就把「目标不是生物」拒了,而
   * **没有任何别的入口** —— 所以 PvP 不是「打错方向」,是**根本不存在**。
   *
   * ## 三道闸,顺序不可换
   *
   * ```
   * 1 双方都是登记玩家 + 都没倒下   (与 attackMobAuthorized 的 0/0b 同源)
   * 2 pvpVerdict(...)               ← 唯一授权判定(在 damage.ts)
   * 3 视线(D2 同一条射线)          ← 隔墙不能砍人,对玩家同样成立
   * ```
   *
   * ## 伤害走八步公式,而不是 `applyHit`
   *
   * 受击方是玩家 ⇒ 有装备/护甲/闪避/反伤(`combatantStats`),这些只有在
   * `computeDamage` 里才有。算完之后用 `vitals.applyDamage` 落账
   * (它负责无敌帧与 `downed`,不重算公式)。击退用**武器侧**的
   * `result.knockbackImpulse`(内容值)写回刚体 —— 与 D1 同一条写回路径。
   *
   * @returns `rejected`: `'NOT_A_PLAYER' | 'DOWNED' | 'STUNNED' | 'TRAPPED' | 'PVP_OFF' | 'PVP_SELF' | 'PVP_NO_TARGET' | 'NO_LOS' | 'OUT_OF_AOI'`,
   *          `null` = 真的结算了(`applied` 可能为 0:被闪避/无敌帧)。
   */
  attackPlayerAuthorized(
    attackerId: string,
    targetId: string,
  ): {
    rejected: 'NOT_A_PLAYER' | 'DOWNED' | 'STUNNED' | 'TRAPPED' | 'PVP_OFF' | 'PVP_SELF' | 'PVP_NO_TARGET' | 'NO_LOS' | 'OUT_OF_AOI' | null;
    applied: number;
    result: PipelineDamageResult | null;
  } {
    if (!this.playerIds.has(attackerId) || !this.playerIds.has(targetId)) {
      return { rejected: 'NOT_A_PLAYER', applied: 0, result: null };
    }
    /* ★ 第六轮实测 P1(幽灵期规则两套):不再手判 downed,改走 canActAsPlayer
       (规则来自 revive.ts#ghostControl)。与 attackMobAuthorized 同一条判据。 */
    if (!this.canActAsPlayer(attackerId) || !this.canActAsPlayer(targetId)) {
      return { rejected: 'DOWNED', applied: 0, result: null };
    }
    /* ★ D3 补:攻击侧也封 **STUNNED / TRAPPED** —— 只封**攻击者**那一侧
       (被冻住 / 被泡泡装起来的人不能挥刀)。真值来源与移动侧(:3316/:3323)
       同源:`vitals.stunOf` / `isTrapped(liveBubbleOf(...))`,同一台状态机、
       同一批拒因名。受击方照常挨打(被困不等于免伤,那是另一条规则)。 */
    if (this.vitals.stunOf(attackerId) > 0) {
      return { rejected: 'STUNNED', applied: 0, result: null };
    }
    if (isTrapped(this.liveBubbleOf(attackerId))) {
      return { rejected: 'TRAPPED', applied: 0, result: null };
    }
    /* ★ 唯一授权判定 —— 本方法**不**自己判 `this.pvpEnabled`
       (那会长出第二份 PvP 语义,日后与 `pvpVerdict` 漂移)。 */
    const verdict = pvpVerdict({ pvpEnabled: this.pvpEnabled, attackerId, targetId });
    if (!verdict.allowed) {
      const r = verdict.reason;
      const rejected = r === 'PVP_SELF' ? 'PVP_SELF'
        : r === 'PVP_NO_TARGET' ? 'PVP_NO_TARGET'
          : 'PVP_OFF';
      return { rejected, applied: 0, result: null };
    }
    const a = this.physics.bodies.get(attackerId);
    const b = this.physics.bodies.get(targetId);
    if (a === undefined || b === undefined) return { rejected: 'NOT_A_PLAYER', applied: 0, result: null };
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    if (distance > AOI_WAKE_DISTANCE) return { rejected: 'OUT_OF_AOI', applied: 0, result: null };
    if (losBlocked(a.x, a.y, b.x, b.y, (cx, cy) => this.grid.isSolidAt(cx, cy))) {
      return { rejected: 'NO_LOS', applied: 0, result: null };
    }

    const attackerStats = combatantStats(this.levelOf(attackerId), [...this.wearingOf(attackerId)], foodCombatInput(this.buffsOf(attackerId)));
    const targetStats = combatantStats(this.levelOf(targetId), [...this.wearingOf(targetId)], foodCombatInput(this.buffsOf(targetId)));
    const weaponId = attackerStats.flags.weaponId;
    const weapon = weaponId > 0 ? weaponById(weaponId) : null;
    const target = targetFromStats(targetStats, { id: targetId, name: targetId });
    const input: PipelineAttackInput = {
      attacker: attackerStats,
      target,
      weapon,
      skill: null,
      comboMul: 1.0,
      critRoll: this.combatRng(),
      dodgeRoll: this.combatRng(),
      distance,
      source: DamageSource.PVP,
    };
    const result = computeDamage(input);
    const out = this.vitals.applyDamage(targetId, result.finalDamage);
    if (out.applied > 0) {
      this.hitCount += 1;
      /* 击退:**武器侧**的内容量(`result.knockbackImpulse`),与 D1 同一条写回路径。 */
      const len = distance > 1e-6 ? distance : 1;
      const m = b.mass > 0 ? b.mass : 1;
      const j = result.knockbackImpulse * m;
      this.physics.applyImpulse(targetId, ((b.x - a.x) / len) * j, ((b.y - a.y) / len) * j, 0);
      this.bus.emit('player_hit', {
        playerId: targetId, attacker: attackerId, damage: out.applied, hp: this.vitals.get(targetId)?.hp ?? 0,
      }, attackerId);
      if (out.downed) this.bus.emit('player_downed', { playerId: targetId, by: attackerId }, attackerId);
    }
    /* ★ 第六轮实测 P1(反伤整段丢弃):第 7 步算出的 result.reflectDamage 修前
       **没有任何生产消费者** ⇒ 728 反伤甲在 PvP 里等于不存在。现在施加回**攻击者**:
       走 vitals.applyDamage 同一条落账路径(含无敌帧 —— 「反伤是否穿透无敌」是
       玩法裁决,本仓不擅自发明),并记进 reflectTotalDamage()。
       判据:tests/WS-FND-118 的 FND118-5(负对照:受击方没穿 728 ⇒ 攻击者 HP 不动)。 */
    /* ⚠️ 判据是「**这次真的打进去了**」(`out.applied > 0`),不是「公式算出了反伤」:
       被无敌帧/护盾全额挡下的那一击没有造成承伤,反伤也就无从谈起(与「命中才附加」同口径)。 */
    if (out.applied > 0 && result.reflectDamage > 0) {
      const back = this.vitals.applyDamage(attackerId, result.reflectDamage);
      this.reflectTotal += back.applied;
      if (back.applied > 0) {
        this.bus.emit('player_hit', {
          playerId: attackerId, attacker: targetId, damage: back.applied,
          hp: this.vitals.get(attackerId)?.hp ?? 0,
        }, targetId);
        if (back.downed) this.bus.emit('player_downed', { playerId: attackerId, by: targetId }, targetId);
      }
    }
    return { rejected: null, applied: out.applied, result };
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
      /**
       * 显式技能(测试夹具)。生产形态见下面的 `useSkill` —— 别再让客户端自报
       * 一整份 `SkillDef`(CR-14 U1 同族:自带合法数值就能凭空放技能)。
       */
      skill?: SkillDef | null;
      /**
       * ★ **生产形态的 [Q] 意图**:`true` ⇒ 技能从**当前武器**取(`skillOf`)。
       *
       * 修前 13 把武器的 `[Q]` 技**整组不可达**(`skillOf` / `planSkillHits` 生产
       * 0 调用,PvP 那条路还显式写死 `skill: null`)。本开关是那半边的入口:
       * `attackMobAuthorized` 把它原样转发下来,客户端只表达「我按了 Q」。
       * ⚠️ 仍缺的一环:网络层没有 `[Q]` 的动作报文(`net/**` 不在本轮写域)⇒
       *    玩家真按键仍打不出技能,见 `combat/wiring_ledger.ts`。
       */
      useSkill?: boolean;
      /** 普攻连段倍率(1.00 / 1.00 / 1.25)。 */
      comboMul?: number;
      /** 覆盖伤害类型(默认由武器推导)。 */
      kind?: DamageKind;
      /** 朝向(度),供生物 AI 的正面/背面判定。 */
      fromDeg?: number;
    } = {},
  ): {
    /**
     * **首段**的八步记录(`segments > 1` 时**不是**合计)。
     * 合计看 `totalDamage`(公式侧)与 `hpLoss`(真实掉血)。
     */
    result: PipelineDamageResult;
    /** 本次攻击**真的掉了多少血**(已扣格挡/晶甲,并按攻击前 HP 钳制)。 */
    hpLoss: number;
    events: string[];
    /** 本次结算的段数(普攻 1;[Q] 技由 `planSkillHits` 决定)。 */
    segments: number;
    /** 各段 `finalDamage` 之和(= 公式侧的合计;**不等于** `hpLoss`)。 */
    totalDamage: number;
  } | null {
    const rt = this.mobHost.runtimeOf(mobId);
    if (rt === null) return null;

    /* 1 组装攻击方面板 —— 装备/等级 → CombatantStats(武器/护甲词条在此聚合)。 */
    const wearing = opts.wearing ?? this.wearingOf(playerId);
    /* ⚠ `Math.trunc(NaN)` 仍是 `NaN`,`Math.max(1, NaN)` 也是 `NaN`
     * (`Math.max` 遇 `NaN` 返回 `NaN`)⇒ 非数字等级会一路穿到 `levelMul`,
     * 使 `finalDamage = NaN`,再经 `Math.max(MIN_DAMAGE, NaN)` 写进生物 HP ——
     * **HP 被永久污染成 NaN,该生物此后永远打不死**(实测:再补一刀合法值也无效)。
     * 与 `comboMul` 是同一类(自报标量未消毒),故同一处置。
     *
     * ## 这里**只**拒绝「不是数字」,不重复做上下界钳制
     *
     * 上下界(1 … MAX_LEVEL)已经由 `combatantStats` 内部
     * `Math.max(1, Math.min(MAX_LEVEL, level))` 负责,而它对 `+Infinity`
     * 和 `-Infinity` 都处理正确(`+Inf`→30、`-Inf`→1)。
     * 我第一版在这里**又**夹了一次 `Math.min(MAX_LEVEL, …)` ——
     * 那是同一个概念的第二份实现:注入实验 J13(删掉我这里那份)时
     * **全部断言保持绿**,因为 `combatantStats` 那份顶着。
     * 这正是本仓点名的缺陷形态(我自己在 task-44 的复活半径上刚踩过一次)。
     * ⇒ 单一真相:钳制归 `combatantStats`,这里只兜它兜不住的 `NaN` 与非数字。
     *
     * 已用**等价变异体证明**记录在案(不硬造断言):把 `Math.max(1, Math.min(30, …))`
     * 加回来,对 27 个输入(含 `±Infinity` / `NaN` / `1e308` / 非数字 / `null` /
     * 小数)经 `combatantStats` 后 `level` **逐个相同,差异 0 处** ——
     * 即在当前位置它是**惰性**的。这类变异体保持绿是正确的,不是断言没牙。 */
    const rawLevel: unknown = opts.level;
    const level = typeof rawLevel === 'number' && !Number.isNaN(rawLevel)
      ? Math.trunc(rawLevel)
      : 1;
    /* ★ 料理 buff 的**战斗**字段在这里进管线(`atkMul` / `critRate` / `critDmg`)。
       此前第三参恒缺 ⇒ 只有 `hpFlat` 那条路(`maxHpForLevel`)真的到达玩家。
       `hpMul` **不臆造**:食物给的是**加值**(`hpFlat`),不是乘区;`allyCount` 属于 731 徽章光环,不是料理。
       ⚠️ 仍无消费者的:`defFlat` / `moveMul` / `gravityMul` / `jumpMul` / `gatherMul` / `expMul`
         —— 见 `docs/TASK-96` 二之六。
       ★ 2026-11-16 更正:`muOverride` **不是**"缺一个具名默认值导出" —— 名字与语义
         现在都在 `cooking.ts`(`MU_OVERRIDE_NONE = 0`)与地板表(`world/chunk.ts` 的
         `DEFAULT_MU` = 0.75 / `muOfSlot`)里。它缺的是**接线**(滑溜料理要不要盖过
         冰面的 0.98),那是玩法裁决,不是常量问题。 */
    const food = this.buffsOf(playerId);
    const attacker = combatantStats(level, [...wearing], foodCombatInput(food));
    const weaponId = opts.weaponId ?? attacker.flags.weaponId;
    const weapon = weaponId > 0 ? weaponById(weaponId) : null;

    /* 2 距离:超出 reach 容差时九步里的第 0a 步会短路(此处如实传入)。 */
    const distance = this.mobDistance(playerId, mobId);

    /* 3 受击方档案 —— 由冻结层 MobDef 派生(缺的字段见 mobCombatProfile)。 */
    const target = mobCombatProfile(rt.def, { hp: rt.hp });

    /* ★ D5:致盲对**命中**的实际影响。
       机制:看不见 ⇒ 只能打到**贴身**的东西。判据用 `TOUCH_RADIUS`
       (revive.ts 的既有常量 0.9 格,不是新数),超出的这一次攻击**落空**。
       为什么不是「降低伤害」:致盲夺走的是**瞄准**,不是力气 —— 降伤会让
       玩家以为自己的武器变弱了,而落空把「我瞎了」这件事表达得更直接。
       落空走**公式自己的第 0a 步**(`distance = Infinity` ⇒ `outOfReach`),
       不另造一个「未命中」的假结果:否则 `float`/`outOfReach`/`steps` 三处
       都出现第二份口径。 */
    const blindMiss = this.vitals.blindOf(playerId) > 0 && distance > TOUCH_RADIUS;
    /* 4 八步公式。暴击/闪避注入确定性随机。
       ⚠ 用 `combatRng` 而非 `this.rng` —— 后者与生物 AI 共用,
       拿它取战斗随机会把「玩家攻击次数」变成生物 AI 的隐式输入
       (实测扰动远处生物轨迹,见 `WorldSimOptions.combatRng`)。 */
    /* ★ 等级伤害倍率的**权威值**(`PlayerProgress.dmgMul`)—— 与本次结算等级一致才用。
       判据是「档案等级 === 结算等级」而不是「档案存在」:两者不一致时(测试注入
       `opts.level`、存档回填与档案尚未同步)用档案倍率会让 `attacker.level` 与
       实际乘区打架,那正是两份等级口径。不一致 ⇒ 退回公式的现算式(逐字旧行为)。 */
    const progress = this.progresses.get(playerId);
    const damageMul = progress !== undefined && progress.level === level ? progress.dmgMul : undefined;

    /* ★ [Q] 技能路径(第六轮实测 P0:13 把武器的技能此前**整组不可达**)。
       `opts.skill` = 测试注入的显式技能;`opts.useSkill` = **生产形态**的意图
       (「按了 Q」)—— 技能从**当前武器**取(`skillOf`),段数与命中区域由
       `planSkillHits` 给出。技能不另写公式:它仍然走同一条八步管线
       (`computeDamage` 的第 1/2/3/4/5/8 步都有 `skill` 分支)。
       ⚠️ 本路径只实现**伤害那一半**:`telegraphSec` / `tickSec` 的**时序**
          (同帧连发代替逐段调度)、`stunSec` / `freezeSec`、`healHp`、
          召唤/护盾类 `extras` 仍未接线 —— 见 `combat/wiring_ledger.ts`。 */
    const skill = opts.skill ?? (opts.useSkill === true ? skillOf(weaponId) : null);
    const plan = skill === null ? null : planSkillHits(skill);
    /** 段数 = `planSkillHits` 的结算帧数(例:715 三连散射 = 3,716 箭雨 = 6)。 */
    const segments = plan === null ? 1 : Math.max(1, plan.ticks.length);

    const rollSegment = (): PipelineDamageResult => computeDamage({
      attacker,
      target,
      weapon,
      skill,
      comboMul: opts.comboMul,
      critRoll: this.combatRng(),
      dodgeRoll: this.combatRng(),
      distance: blindMiss ? Number.POSITIVE_INFINITY : distance,
      source: skill !== null ? DamageSource.SKILL : DamageSource.NORMAL_ATTACK,
      ...(damageMul !== undefined ? { damageMul } : {}),
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
    /* 首段结算 */
    const result = rollSegment();
    let rawLossSum = 0;
    let totalDamage = result.finalDamage;
    const events: string[] = [];
    const aiFirst = this.damageMob(mobId, result.finalDamage, kind, fromDeg);
    rawLossSum += aiFirst?.hpLoss ?? 0;
    if (aiFirst !== null) events.push(...aiFirst.events);
    /* ★ 多段(715 三连 / 716 箭雨 / 722 流沙 / 723 力场):**同帧连发**。
       目标中途死掉就停 —— 给尸体结算第 2、3 段会把 `hpLoss` 与击杀账算花。
       每段都是**独立**一次 `computeDamage`(暴击/破盾/击退各自结算),
       段数只由 `planSkillHits` 决定,不在这里另定段数。 */
    for (let seg = 1; seg < segments; seg += 1) {
      if (!rt.alive || rt.hp <= 0) break;
      const r = rollSegment();
      totalDamage += r.finalDamage;
      const ai = this.damageMob(mobId, r.finalDamage, kind, fromDeg);
      rawLossSum += ai?.hpLoss ?? 0;
      if (ai !== null) events.push(...ai.events);
    }
    const hpLoss = Math.max(0, Math.min(rawLossSum, hpBefore));

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
    /* ★ `plan` 的另一半产出(命中区域)进事件流:它是 `planSkillHits` 除段数之外
       唯一可被消费者读到的信息(客户端飘字 / 战斗日志)。 */
    if (skill !== null && plan !== null) events.push(`skill:${skill.key}:${plan.area}`);
    return { result, hpLoss, events, segments, totalDamage };
  }

  /**
   * 取玩家已装备物品(**权威档案**;无记录则为空)。
   *
   * ⚠ 读的是 `profiles`(权威)而**不是** `mobPlayers`(每帧重建的派生视图)。
   * 原实现读 `mobPlayers.find(...).wearing`,而 `syncPlayers()` 每帧把该字段
   * 写成 `[]` ⇒ 装备在第二帧起失效。详见 `PlayerProfile` 注释。
   */
  /**
   * 「这个玩家现在能不能动手」的**唯一**判据(攻击侧)。
   *
   * 第六轮实测 P1(幽灵期规则两套):attackMobAuthorized / attackPlayerAuthorized
   * 各自手判 vitals.downed,而 revive.ts#ghostControl(规则的具名实现)生产 0 调用。
   * 现在两条入口共用本方法,两档各自的真值来源写死在下面:
   * ```
   * 已有 DownedState(泡泡已建)     → ghostControl(d).canAttack   ← 规则在 revive.ts
   * 还没有泡泡(刚倒地,慢帧未建)  → vitals.downed              ← 瞬时真值(同一帧置位)
   * ```
   * 为什么保留第二档:DownedState 由慢帧(2Hz)建立 ⇒ 只读它会让「HP 已归零」到
   * 「泡泡建好」之间存在最多 0.5s 的可攻击窗口(见 attackMobAuthorized 闸 0b)
   * —— 那是「两份判据漂移」的另一头,不是保险。
   */
  private canActAsPlayer(playerId: string): boolean {
    /* ⚠️ 判断**顺序不能反**:`downedStates` 的清账在慢帧(2Hz),复活后最多 0.5s
       还留着一份 GHOST_BUBBLE 快照 —— 先读它会表现为「刚被救起来却打不出普攻」。
       所以:没倒地 ⇒ 一律放行;倒地 ⇒ 泡泡已建时规则来自 revive.ts,未建则封手。 */
    if (this.vitals.get(playerId)?.downed !== true) return true;
    const d = this.downedStates.get(playerId);
    return d === undefined ? false : ghostControl(d).canAttack;
  }

  /** 反伤累计(只增;诊断与判据用,不是玩法状态)。 */
  private reflectTotal = 0;

  /**
   * 生产里**真的施加出去**的反伤总量。
   *
   * 存在的理由:修前反伤算到第 7 步就被丢,reflectDamage 只有单测读过 ⇒
   * 「反伤接了没有」在外部**不可观测**。有它之后,WS-FND-118 才能把
   * 「接了」与「恰好在这次为 0」分开。
   */
  reflectTotalDamage(): number {
    return this.reflectTotal;
  }

  /**
   * 战斗侧「实现了但没接」的**台账**(只读)。
   *
   * 存在的理由(两个):
   * ```
   * 一 门禁:combat/** 里哪些符号接了、哪些没接,必须有一个**机器可判**的出处
   *    (判据在 tests/WS-FND-118:WIRED 必须真有消费点、UNWIRED 必须真的零读者)。
   * 二 可达性:账本模块只被测试引用会被孤儿门禁判红 ⇒ 由世界源(战斗的调用方)读它,
   *    这是**真实**的引用,不是为了让门禁变绿的假调用:它回答的是「本世界跑的这套战斗,
   *    哪些规则还是空壳」。
   * ```
   * ⚠️ 它**不是**玩法状态,也不改变任何结算 —— 只读快照。
   */
  combatWiringLedger(): readonly CombatWiringRow[] {
    return COMBAT_WIRING_LEDGER;
  }

  private wearingOf(playerId: string): readonly number[] {
    /* `?? []` 不是洁癖:档案里 `wearing` 可能是 `undefined`(外部构造),
       直接返回会让调用方在 `[...wearing]` 处抛 `TypeError: wearing is not iterable`。
       本仓的取舍是「生产路径上不 throw」——漏传装备应当退化成**按裸装结算**
       (玩家看得见伤害数字变小),而不是让整次攻击崩掉。 */
    return this.profiles.get(playerId)?.wearing ?? [];
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
    const def = mobDefOf(mobId);
    if (def === undefined) return null;

    /* 参与者 = 所有玩家,距离取与击杀点的平面距离。
     *
     * ⚠ **只给范围内**的玩家建档。第一版对全部 `playerIds` 都调 `progressOf`,
     * 于是范围外(实测 40 格)的玩家也凭空多出一个 lv1/exp0 的档案。
     * `totalExp` 仍是 0(没发经验,行为本身是对的),但「档案存在与否」
     * 这个可观测值被污染了 —— 它不再等价于「这人参与过击杀」。
     * 断言 `progressSnapshotOf(far) === null` 正是被这条抓出来的:
     * 起初我以为是断言写得苛刻,查后确认是接线引入了无谓副作用。 */
    const participants = [];
    for (const id of this.playerIds) {
      const b = this.physics.bodies.get(id);
      const dist = b === undefined ? Number.POSITIVE_INFINITY : Math.hypot(b.x - x, b.y - y);
      if (dist <= SHARE_RADIUS && !this.progresses.has(id)) {
        this.progresses.set(id, createProgress(id));
      }
      const p = this.progresses.get(id);
      participants.push({
        playerId: id,
        distance: dist,
        level: p?.level ?? 1,
        /* 打盹真值来自房间推来的镜像(`setPlayerAfk`),不是字面量 `false`。
           见 `afkPlayers` 的 docblock:写死 false 会让
           `progression.ts:350` 的 `afkMul` **永不生效**。 */
        afk: this.afkPlayers.has(id),
        /* ★ 烹饪 `expMul` 的**消费点**(613 庆典蛋糕 = 1.30)。
           `progression.ts:356` 早已把 `expBonusMul` 乘进 `bonusMul`,
           缺的只是**有人把料理的那个字段填进来** —— 修前恒 `undefined`(按 1.0 算),
           所以「经验 +30%」这道菜在生产里从来不生效。
           ⚠️ 不在这里做第二套「乘多少」的判断:乘区算式仍在 progression 一处。 */
        expBonusMul: this.buffsOf(id).expMul,
        hasDreamTalent: p === undefined ? false : isTalentUnlocked(p.level, 'talent_dream_revelation'),
      });
    }

    /* ★ 赛局计分的发射点**在 `settleMobExp` 之后** —— 见下方那段:
       先去重再计分,否则同一只怪被二次结算时"经验去重、分数双发"(审查 A4)。 */

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

    /* ★ 赛局计分:把"这次击杀"送进世界侧的**统一入口**(`notePartyEvent`)。
       归属口径**沿用本方法已有的那条** —— 距击杀点 `SHARE_RADIUS` 内的玩家,
       不另立"谁补的刀":手册的判据本来就是按距离(见上面那段注释)。
       ⚠️ 必须在 `settleMobExp` **之后**、且 `deduped` 时**不计分**:
       同一个实例被二次结算(`addMob` 替换旧条目 / 姜饼小人复活)时经验去重、
       分数却会双发 —— 审查 A4 给的最小复现正是"分数 2 → 4、exp total 0"。 */
    if (!result.deduped) {
      for (const p of participants) {
        if (p.distance <= SHARE_RADIUS) {
          this.notePartyEvent({ kind: PARTY_SCORE_EVENT.CREATURE_KILL, source: p.playerId });
        }
      }
    }

    /* ── ★ WS-FND-98:掉落判定 ──
       种子取 `worldSeed`(世界身份)+ **击杀实例维** = `mobId`(实例 id `mob_species#序号`,
       世界内唯一、由 `mobs/spawner.ts#mobInstanceId` 的单调计数器生成)。
       ⚠ 第三轮实测 P1:只传 `worldSeed` 时,同一世界里同种怪**每次击杀的掉落完全相同**,
       `dropChance` 退化成「该物种在这个世界必掉 / 必不掉」(实测 0% 或 100%)。
       实例维让同种怪的多次击杀在概率上**独立**;同 seed 的世界重放得到同一串实例 id
       ⇒ 逐次一致(见 `tests/WS-FND-98` FND98-15/16/17)。
       ⚠ `deduped`(= 同一实例被二次结算)时清空:经验/积分都去重,掉落也不能给第二份
       (姜饼小人复活 / `addMob` 替换旧条目都会走到这条)。 */
    const drops = result.deduped ? [] : rollMobDrops(def.id, this.worldSeed, mobId);
    /* ── ★ WS-FND-102:掉落**真的落到地面** ──
       修前这一行只赋给诊断字段 `lastMobDrops`,而它在全仓**没有生产读者**:
       击杀路径从不调 `dropItem` ⇒ 打死怪的地面永远是空的(审计实测)。
       现在走既有的 `dropItem`(**地面唯一写入点**,容器仍是 `mobGround`)⇒
       玩家的 `groundItemsNear` / `takeGroundItemNear`、生物 AI 的
       `mobWorldAdapter().groundItems()`、`materials().take(x,y)` 看到的是
       **同一批**货(不存在"两个地面")。`lastMobDrops` 保留为诊断镜像。
       ⚠️ 坐标取**击杀点**(`settleKill` 的入参来自 `after.x/after.y`),不取玩家位置:
       手册判据是"掉在怪倒下的地方"。非有限坐标**不落地**(否则地面会出现
       一件 `x=NaN` 的货:玩家永远拾不到、也永远删不掉)。 */
    if (drops.length > 0 && Number.isFinite(x) && Number.isFinite(y)) {
      for (const d of drops) this.dropItem(x, y, d.itemId, d.count);
    }
    this.lastMobDrops = drops;

    this.lastKillSettle = result;
    this.killSettleCount += 1;
    this.totalExpGranted += result.total;
    return result;
  }

  /* ══════════════════ 赛局计分(事件 → 分)的世界侧入口 ══════════════════ */

  /**
   * 世界侧的**唯一**计分入口:把一件已发生的事实("谁做了什么")送出去。
   *
   * ## 为什么是"入口"而不是"直接算分"
   * 计分规则在 `party/scoring.ts`(纯函数),落账在 `actions/start_party.ts` 的 `addScore`。
   * `WorldSim` 两边都不该认识(`sim` 依赖 `net/actions` 会形成反向依赖)⇒ 这里只负责
   * **转发事实**,由装配层(`index.ts`)把 sink 接到"规则 + 落账"那一段。
   *
   * ⚠️ 没接 sink ⇒ 事件被丢弃(与"世界侧不知道"等价),判据按"分数不变"断言。
   */
  private partyScoreSink: ((ev: { kind: string; source?: string }) => void) | null = null;

  /** 装配层注入计分 sink(幂等:后注入的覆盖先注入的)。 */
  attachPartyScoreSink(fn: (ev: { kind: string; source?: string }) => void): void {
    this.partyScoreSink = fn;
  }

  /**
   * 报告一件与赛局有关的事实:世界侧把「谁做了什么」送出去,它**不该**知道
   * "分数怎么算"(规则在 `party/scoring.ts`,落账在 `net/actions/start_party.ts`)。
   *
   * ## ⚠️ 台账:发射点只有**一个**(★ 第四轮实测 P2,按现状改写)
   *
   * 修前这段注释写的是「**三个**发射点(击杀 / 采集拾取 / 到达目标)各处就近调用它」。
   * 实测全仓:只有**击杀**那一处真在发(`settleKill` 的
   * `PARTY_SCORE_EVENT.CREATURE_KILL`,见本文件 `:2941`);另两个是空的:
   * ```
   * GATHER       (`party_gather`)       无生产者。拾取走 `net/actions/material.ts`
   *              的 `materials().takeGroundItemNear(x, y, itemId, radius)` —— 那个签名
   *              **不带玩家 id**,本层拿不到 `source`;编一个(空串 / 猜人)只会被
   *              `index.ts:257` 的 `source === ''` 丢弃、或把分算到别人头上。
   *              补法:给该调用链加 `actorId`(要改 `MaterialApi` 与动作层)。
   * REACH_TARGET (`party_reach_target`) 无生产者。目标件(435 旗 / 410 球门框 /
   *              434 皇冠底座)的"踩到"判定今天不在本层,没有「按玩家坐标扫目标格」
   *              的入口。补法:在快帧里按玩家刚体所在格查 `objIdAt`,命中目标件就发。
   * ```
   * 同批:`startPartyRun` 在全仓**曾**零调用(只有 `tests/WS-11` 直接调)⇒ 生产里
   * `partyRun` 恒 `null`、`tickPartyMode` 从不推进、`partyPhase()` 恒 `'IDLE'`。
   * ★ WS-FND-120 已修:`tickPartyStep` 的**哨台入口**(436 `params.mode` + 站在哨台格上
   * 的玩家)是 `startPartyRun` 的生产调用者 —— 判据见 `tests/WS-FND-120`。
   * 同一次修复还补上了 `REACH_TARGET` 与 `GATHER` 两个发射点:
   * ``` 
   * REACH_TARGET  玩家**站上** 435 复活旗 / 434 皇冠底座那一格时发一次(`reachLatch` 去重);
   * GATHER        急单交付成功时发(`stepRushDelivery` 扣掉地面货的那一刻就是「拾取」)。
   * ```
   * ⚠️ 没接 sink ⇒ 事件被丢弃(与"世界侧不知道"等价),判据按"分数不变"断言。
   */
  notePartyEvent(ev: { kind: string; source?: string }): void {
    this.partyScoreSink?.(ev);
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

  /**
   * 玩家的**权威等级**(供网络层投影到 `state.players[].level`)。
   *
   * 为什么单开一个方法而不是让房间读 `progressOf().level`:
   * 房间是**结构化**依赖(`WorldSaveHost`),不能引用模拟层类型;
   * 返回一个数字就把依赖面收到最小。
   *
   * ⚠ 用 `progressSnapshotOf` 的语义(**不新建档案**):没有档案 = 还没参与过
   * 任何结算 = 等级 1。若这里用 `progressOf`,房间每帧给每个玩家调一次,
   * 会让**所有**在场玩家凭空多出一个 lv1/exp0 的档案 ——
   * 那正是 `settleKill` 里被断言抓过的同一类副作用
   * (「档案存在与否」这个可观测值被污染)。
   */
  levelOf(playerId: string): number {
    return (this.progresses.get(playerId) ?? { level: 1 }).level;
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

      /* ⚠ **不要在这里加 `bestDist <= TOUCH_RADIUS` 预检查** —— 我加过,是缺陷。
       *
       * `revive.ts` 的 `touchRevive` 已经把「距离越界」定义成**松手**:
       * `if (input.distance > TOUCH_RADIUS) return { ...downed, reviveProgress: 0, rescuerId: null }`。
       * 我在外面预先判一次并**跳过调用**,等于让那段归零逻辑永不执行:
       * 实测救援者在半径内累积 0.5 进度、走远、再回来 —— 进度**被继承**,
       * 下一次贴近直接凑满 1.0 复活。表现是「松手不清进度」,救援变得比设计容易。
       *
       * 这是本仓点名的「同一个概念长出第二份实现」缺陷形态
       * (`effects.ts` 的死字段、`roomAtCell` 的两份判定都属此族):
       * 两份判据今天同结果 ⇒ 注入只改一份时另一份顶着 ⇒ **断言全绿、缺陷隐身**。
       * 注入实验 I9(去掉我这里那份)保持全绿,正是这个形态的实证。
       *
       * ⇒ 单一真相:距离判定只由 `touchRevive` 拥有,这里无条件委托给它。
       * 无救援者时传 `+Infinity` —— 语义即「没人来救」,由它归零。 */
      /* ★ C2:站在**复活旗**(435)旁 ⇒ **自己**读条复活,不等第二个人。
         旗优先于救援:两者共用 `DownedState.reviveProgress` **一个**字段,
         同时推进就是两份实现抢同一个进度 —— 本仓点名的缺陷形态
         (`effects.ts` 死字段、`roomAtCell` 两份判定同族)。
         ⇒ 半径内有旗走 `flagRevive`;否则走 `touchRevive`,既有路径逐字不变。 */
      const flag = this.nearestFlag(id);
      const out = flag === null
        ? touchRevive({
          downed: d,
          rescuerId: bestId ?? '',
          distance: bestId === null ? Number.POSITIVE_INFINITY : bestDist,
          dt,
          progress: this.progressOf(id),
        })
        : flagRevive({
          downed: d,
          flagId: flag.id,
          distance: flag.distance,
          dt,
          progress: this.progressOf(id),
        });
      d = out.downed;
      if (out.revived && out.result !== null) {
        this.lastRevive = out.result;
        /* 复活落账:把 HP 写回 `vitals`(半血)并清掉倒地标记。
           这是「谁负责把状态机结果写回瞬时判定」的必要一步 ——
           不写回的话 `vitals.downed` 仍是 true,下一帧又会重建泡泡,
           表现为「复活了但立刻又倒下」。

           ⚠️ 第三参 `out.result.invulnSec` 是 task-64 补的,**不能省**:
           `revive.ts` 把 `MANUAL_REVIVE_INVULN` 写进了 `DownedState.invulnSec`,
           而**读那个字段的 `isInvulnerable()` 生产 0 调用** ⇒ 无敌到不了玩家身上;
           真正被受击判定读的是 `vitals.iframeSec`(见 vitals.ts:397)。
           实测(修前):复活后第 1 拳 `applied=14`(期望 0)⇒ **复活后零宽限无敌**。
           ⇒ 必须把结果里的秒数**转写进活的那一套**。 */
        this.vitals.revive(id, out.result.hpAfter, out.result.invulnSec);
        this.downedStates.delete(id);
        continue;
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
    /* 装备/手持从权威档案取 —— 原为字面量 `wearing: []`,与 `syncPlayers`
       是同一处病根的第二份实现(见 `PlayerProfile`)。 */
    const prof = this.profiles.get(id) ?? EMPTY_PROFILE;
    return {
      id,
      x: b.x,
      y: b.y,
      z: b.z,
      facingDeg: b.facingDeg ?? 0,
      afk: this.afkPlayers.has(id),
      heldItem: prof.heldItem,
      wearing: prof.wearing,
      playingInstrument: false,
    };
  }

  /**
   * 登记一个「玩家」:物理刚体 + AOI 唤醒源,一次注册两处保持一致。
   *
   * ★ D-06 起**顺带记住出生点**(只在首次登记时写):`resetWorld` 要把玩家
   *   送回「他们进入这个世界时的位置」,而那个位置只有调用方知道一次。
   *   见 `spawnPoints` 的 docblock。
   */
  addPlayer(id: string, x: number, y: number): void {
    this.physics.spawn(id, { x, y, z: 0 });
    this.aoi.registerMob(id, x, y);
    /* 记账 —— 供 syncPlayers 区分玩家与生物(两者都在 physics.bodies 里) */
    this.playerIds.add(id);
    /* 登记生命值 —— 漏了这一步的表现是「生物打玩家永远不掉血」,
       因为 vitals.applyHit 找不到该玩家就静默返回 0 伤害。 */
    this.vitals.register(id);
    /* ★ 出生点**只记首次**:重进(重连/读档)传进来的是**当前位置**,
       覆盖它会让「重置回出生点」把玩家送到上一次断线的地方。 */
    if (!this.spawnPoints.has(id)) this.spawnPoints.set(id, { x, y });
    this.syncPlayers();
  }

  /**
   * 最后一次 `applyPlayerMove` **被拒**的理由;`null` = 未发生拒绝。
   *
   * ## 为什么需要它(返回值是 `boolean`,装不下理由)
   *
   * 「没写进去」有两种完全不同的原因:身份不对(它不是玩家)、
   * 或**规则不允许**(幽灵泡泡期间不能移动)。只返回 `false` 时它们
   * 在断言里**不可区分** —— 而本仓反复记着一条:「不谎报」要求可判定,
   * 不可判定的失败会被读成成功(`attackMobAuthorized` 的 `rejected` 同取舍)。
   *
   * ⚠️ 它**不是**判定本身,只是一份诊断记录:真值来源仍是
   * `VitalsSystem.downed`(见方法内注释)。
   */
  lastMoveRejection: 'NOT_A_PLAYER' | 'NO_BODY' | 'NON_FINITE' | 'DOWNED' | 'KNOCKBACK' | 'TRAPPED' | 'STUNNED' | null = null;
  /**
   * **玩家移动的权威写入点**(task-58)。把一次已获准的移动写进 `physics.bodies`。
   *
   * ## 为什么是「位置」而不是「速度」
   *
   * 三条理由,第一条决定性(实测):
   *
   * 1. **速度方案与客户端预测永久对不上**。`prediction.ts:70-82` 的 `predictStep`
   *    自述「故意**不含**摩擦衰减 —— 连续输入时速度项主导」,算的是 `v * DT`:
   *    ```
   *    客户端预测:4.5 × 0.05 = 0.2250 格/帧
   *    服务端写 vx=4.5 ⇒ 实测一帧 dx = 0.1620,vx 衰减 4.5 → 3.24
   *    ⇒ 差 28.0%
   *    ```
   *    那句注释假设的前提是「位置由别处直接写入、速度项主导」——
   *    在**速度方案**下该前提不成立,`reconcile` 会持续 `SMOOTH`/`SNAP`。
   * 2. 反作弊上界 `maxDisplacementPerTick()` 是**位移**量纲(实测 0.36 格/帧),
   *    而 `checkMove` 判的也是 `dist(新旧坐标)`。速度方案要多做一次换算,
   *    换算式本身成为新的对不齐点。
   * 3. **本仓既有先例全是「直接写位置」**:生物 FSM 走 `host.ts:449` 的
   *    `rt.x = fsm.x`(实测生物的 `physics.bodies` 200 帧完全不动),
   *    叠罗汉走 `carry.ts` 的 `body.vx/.vy` 直赋。位置方案与它们同构。
   *
   * 代价(如实写):本方法**绕过积分**,故不自动获得摩擦/传送带/碰撞反弹。
   * 这是刻意的 —— `MoveIntent` 携带的是**目标坐标**(见 `anticheat.ts:283-299`),
   * 契约本身就是位置语义,速度方案反而要反推。
   *
   * ## ⚠️ 反作弊**不在这里再判一次**(本仓纪律:不制造第二份等效实现)
   *
   * 合法性判定**唯一**在 `anticheat.ts` 的 `checkMove`(由 `RoomRuntime.applyMove`
   * 调用)。本方法假设输入**已获准**,只做写入。
   *
   * 若在此再加一道上界检查,会产生两份等效实现,后果有二:
   * - 两处判据将来必然漂移(一处改常量、另一处没改),而**门禁查不出**;
   * - 更坏:第二处会**掩盖**第一处失效 —— 若 `checkMove` 哪天被绕过,
   *   测试仍可能全绿(因为这里还在夹)⇒ 真缺陷被藏起来。
   *
   * (本仓已两次实测到「两份实现互相顶着」:task-47 的 `wearingOf`/`syncPlayers`
   * 单点注入查不出,task-50 的陷阱 31/41。)
   *
   * ## 身份检查**不是**反作弊的第二份实现
   *
   * 它拦的是**另一件事**:`physics.bodies` 里玩家与生物**混在一起**
   * (`addPlayer` 与 `addMob` 都调 `physics.spawn`),不查这一条
   * 就能用一只生物冒充玩家去改坐标。判据是「**是不是玩家**」,
   * 与「位移合不合法」正交,故不构成重复。
   *
   * @returns 是否真的写入了(未登记的 id 返回 `false`,不抛错 —— 与
   *          `attackMobAuthorized` 的「不谎报」同取舍)。
   *          **被拒的理由**见 `lastMoveRejection`(`boolean` 装不下理由)。
   *
   * ## ★ 幽灵泡泡闸(规则 3:倒地不能移动 —— 2026-11-14 补)
   *
   * 修前实测:`applyPlayerMove('p1', 32, 32)` 在 `vitals.downed === true` 时
   * 照收 ⇒ 位移 33.9 格(而免伤 / 不能治疗早已生效)。这就是「四条规则只落了两条」。
   *
   * **真值来源:`VitalsSystem.downed`**,与该组另外三条规则同一处
   * (免伤 = `applyHit` 的 `v.downed`;不能治疗 = `heal` 的 `v.downed`)。
   * 为什么**不是** `DownedState`:见 `attackMobAuthorized` 闸 0b 的注释
   * (它是慢帧维护的派生状态机,拿它当权限判据会留出最长一个慢帧的窗口)。
   * ⇒ 不新造第二套「是否倒地」,只查这一个字段。
   *
   * 为什么算**规则**而不是反作弊(与上面那一段不冲突):它判的是
   * 「**这个人当前有没有行动权**」,不是「这次位移合不合法」—— 与
   * `checkMove` 的量纲无关,故不构成第二份实现。
   */
  /* ══════════════════ 击退(玩家受伤后的位移)══════════════════ */

  /** 复活旗的内容层件号(与 `party/scoring.ts` 的 `SPAWN_FLAG_ITEM_ID` 是同一件)。 */
  private static readonly FLAG_OBJ_ID = 435;

  /**
   * 227 泡泡连发水枪 —— `useItem` 的**使用语义锚点**。
   *
   * ⚠️ 提到静态字段是因为它现在有**两个消费点**(活人半边的叠层 / 器件半边的灭火),
   * 而原先是 `useItem` 里的一个局部量 ⇒ 灭火分支只能再写一遍 `227`。
   * 一个数字两处出现就是漂移的入口(改一处忘另一处,静默失效)。
   */
  private static readonly BUBBLE_GUN_ITEM_ID = 227;
  /** 212 大铁铲 —— `cooking.ts` 的注释点名它也能浇灭炉火,与 227 同一分支。 */
  private static readonly SHOVEL_ITEM_ID = BIG_SHOVEL_ID;
  /**
   * 733 复苏天使羽毛笔。
   *
   * 提到静态字段的理由与 227 相同:`itemUseKind`(语义表的唯一出处)与
   * `useItem`(分派)两个消费点都要它 —— 原先只在 `useItem` 里当局部量。
   */
  private static readonly FEATHER_PEN_ITEM_ID = 733;

  /**
   * 生效中的击退:玩家 → 剩余位移(格)。**由慢帧推进**,推进期间拒绝位置搬家。
   *
   * ## 为什么是"位移"而不是"速度"
   * 本仓刚体是**位置式**(`DynamicBody` 只有 x/y/z,`applyPlayerMove` 直接写坐标),
   * 没有速度积分器。击退若只写速度,下一帧就被 `applyPlayerMove` 抹掉 ——
   * 那正是 DAMAGE-LOOP D1 记录的「被野猪撞中,位置不变」。
   * ⇒ 击退 = **剩余位移** + **搬家窗口**:位移推完前 `applyPlayerMove` 一律拒绝
   * (`lastMoveRejection = 'KNOCKBACK'`),客户端不会把击退抹掉。
   */
  private readonly knockbacks = new Map<string, { dx: number; dy: number; left: number }>();

  private static readonly KNOCKBACK_STEPS = 2;

  /**
   * 受击击退的**换算**:每 20 点伤害推 1 格(★ D-09 裁决,owner 2026-11-16)。
   *
   * 为什么不借用 `damage.ts` 的 `knockbackImpulse`:那是**攻方武器**的击退量(谁的武器击退更强),
   * 而这里要的是"**我**被打中之后被推多远" —— 同一个物理量在两个语义下不是一回事。
   * 裁决原文给了这条换算,所以数不是发明的;要改这个数需要新裁决。
   */
  private static readonly KNOCKBACK_DAMAGE_PER_CELL = 20;
  /**
   * 受击击退的**总位移上限**(格)。**必须有上限**:`applyKnockback` 一次性把位移写进位置,
   * 没有上限时一次 100 伤害会推 5 格(穿墙/出界由 physics 兜,但观感与救援半径都崩)。
   *
   * 取 `2` = **D-09 裁决的同量级值**(`min(2, 实际伤害 / 20)` 格,owner 2026-11-16);
   * 位移上界只能是**格**,不能用武器的格/秒。
   * ★ WS-FND-98:本条从「受击点里的 `Math.min`」升级为 `applyKnockback` **内部**的上界,
   * 于是**任何**调用方(受击点 / Boss 环形波 / 脚本 / 测试)给多大的距离都被钳在这里,
   * 不存在「绕过受击点就不受上界约束」的第二条路。
   */
  static readonly KNOCKBACK_MAX_CELLS = 2;

  /**
   * 击退的**质量归一基准**(格)。`位移 = 距离 × (基准 / 质量)`:质量为 1(=`MASS_PLAYER`,
   * 也是 `physics.safeMass` 的兜底值)时位移与归一前**逐位相同**,所以 D-09 那套判据
   * (`WS-FND-53` FND53-1/3 的 `min(2, 伤害/20)`)一个数都不变;质量 20 的 Boss 只被推 1/20。
   *
   * 为什么归一化也要在**这一层**:`applyKnockback` 走**位置**路径(慢帧两段推),不经过
   * `physics.applyImpulse` 的 `Δv = J / m`。两条路径各自归一,否则「轻的推得远、重的推得近」
   * 只在纵向速度上成立、水平位移上不成立。
   */
  static readonly KNOCKBACK_MASS_REF = 1;

  /* ══════════════════ 世界时钟(★ D-07:20 分钟一天,0 帧 = 06:00)══════════════════ */

  /** 游戏内**一天**的秒数 —— D-07 裁决值(20 分钟)。改它需要新裁决。 */
  static readonly WORLD_DAY_SEC = 1200;

  /** 世界日 = `WORLD_DAY_SEC / DT` **快帧**(20 分钟一天 ⇒ 24000 帧)。 */
  private static readonly FRAMES_PER_DAY = WorldSim.WORLD_DAY_SEC / DT;
  /** 世界时间 0 帧对应的**钟点** —— D-07 裁决值(06:00 天亮)。 */
  static readonly WORLD_START_HOUR = 6;
  /**
   * 当前世界**钟点**(0..24,带小数)。
   *
   * 换算:`WORLD_START_HOUR + 帧数 × DT / 一天秒 × 24`,再取 24 的模。
   *
   * ⚠️ **不另存一个"经过秒"累加器**:累加 0.05(二进制里不精确)几千次之后,
   * 19:00 会算成 18.99999999999997 ⇒ `isNight(hour)` 在边界上判成"白天"。
   * 直接用 `frameCount × DT`(乘法一次),把误差压到一个 ULP。
   */
  hourOfDay(): number {
    const sec = this.frameCount * DT;
    const raw = WorldSim.WORLD_START_HOUR + (sec / WorldSim.WORLD_DAY_SEC) * 24;
    return ((raw % 24) + 24) % 24;
  }

  /**
   * 现在是夜里吗?(★ D-07)
   *
   * 边界**不在这里定** —— 直接委托 `wiring/components.ts` 的 `isNight(hour)`,
   * 那是 405 昼夜感光器用的同一个函数(19:00–06:00 为夜)。
   * 两处各写一份边界必然漂(本仓已踩过多次)。
   */
  isNightNow(): boolean {
    return isNightAtHour(this.hourOfDay());
  }

  /**
   * 把**世界环境**挂到电路求值环境上(★ D-07 的钟点 + ★ WS-FND-114 的逐格事实)。
   *
   * ## 为什么需要(两条,分别对应两个缺陷)
   *
   * 1 **钟点**:405 昼夜感光器读 `ctx.param('hour')`,而组件的 `params` 是**摆放时**
   *    的静态表 —— 不挂这一口,感光器拿不到钟点(`param` 缺失 ⇒ 0 ⇒ `isNight(0)` = 夜
   *    ⇒ **恒亮**),D-07 的钟点就只是个没人读的字段。
   * 2 **逐格传感事实**(WS-FND-114):`entityCount` / `fluid` / `onPodium` / … 问的是
   *    「**这一格**上有什么」。修前这一口只回答 `hour` / `night`,其余一律 0 ⇒
   *    压力板 / 水位 / 绊线 / 领奖台 / 弹簧垫 / 炮台 / 火车…… 的输入判据**全部恒假**;
   *    而 440 的反向判据(`moored === 0`)与「键缺失」在 `param()` 里不可区分
   *    ⇒ **恒真**(飞艇恒飞)。⇒ 键的形状改成 `(key, comp)`(`graph.ts` 的 `EnvSource`),
   *    逐格键按**件所在格**回答。
   *
   * 键的口径**只有一张台账**:`wiring/components.ts` 的 `ENV_KEY_LEDGER`
   * (哪些是 `WORLD`、哪些是摆放设置、哪些根本没有生产者)。本函数只实现 `WORLD`
   * 那一批;**没实现的键返回 0 的含义是「世界里没有这个事实」**,不是「忘了写」。
   *
   * 挂的时机:`SignalGraph` 每次被新建都要重挂(构造器与 `rebuildWorld` 两条路径),
   * 否则重置过的世界会悄悄退回「钟恒亮 + 传感恒假」。
   */
  private installWorldEnv(): void {
    this.wiring.setEnvSource((key: string, comp?: ComponentNode): number => this.automationEnvOf(key, comp));
  }

  /**
   * 世界环境键的**唯一生产实现**(全局键 + 逐格键)。口径见 `ENV_KEY_LEDGER`。
   *
   * ⚠️ 逐格键在 `comp` 缺省时返回 0:那是「没有位置就没有答案」,不是「这个键没人写」。
   *
   * 复杂度:每个逐格键 O(玩家 + 生物 + 地面堆),与 `sizeCells` **无关**;生产件数
   * 上限 40(见 `COMPONENT_PRODUCER_LEDGER`),每慢帧至多几十次 ⇒ 不进性能预算讨论。
   */
  private automationEnvOf(key: string, comp?: ComponentNode): number {
    /* ── 与位置无关的键 ── */
    if (key === 'hour') return this.hourOfDay();
    if (key === 'night') return this.isNightNow() ? 1 : 0;
    if (key === 'morningTick') return this.isMorningSlowFrame() ? 1 : 0;
    /* ── 逐格键:没有位置就没有答案(旧行为等价于这一支恒 0)── */
    if (comp === undefined) return 0;
    const cx = Math.floor(comp.x);
    const cy = Math.floor(comp.y);
    switch (key) {
      case 'entityCount': return this.entitiesAt(cx, cy).count;
      case 'entityWeight': return this.entitiesAt(cx, cy).weight;
      case 'fluid': return this.fluid.amountAt(cx, cy) > 0 ? 1 : 0;
      /* 「穿过」= 本帧有实体在这个格;绊线柱的脉冲本来就是 1 帧(件自带固有延迟)。 */
      case 'crossed': return this.entitiesAt(cx, cy).count > 0 ? 1 : 0;
      case 'onPodium': return this.playersAt(cx, cy) > 0 ? 1 : 0;
      case 'payloadAbove': return this.entitiesAt(cx, cy - 1).count > 0 ? 1 : 0;
      /* 半径取件自己的 `params.range`(425 配表 7 格),不在世界侧另立一个数。 */
      case 'enemyInRange': return this.mobWithin(cx, cy, Math.max(1, comp.params.range ?? 7)) ? 1 : 0;
      case 'hitMob': return this.mobAt(cx, cy) ? 1 : 0;
      default: return 0;
    }
  }

  /**
   * 某格的实体账:`count` = 玩家 + 活着的生物 + 地面掉落堆;
   * `weight` = **刚体质量之和**(掉落物压上板子算「有东西」,但**不压秤** ——
   * 「双人重物压力板」比的是玩家/动物的质量)。
   */
  private entitiesAt(cx: number, cy: number): { count: number; weight: number } {
    let count = 0;
    let weight = 0;
    for (const id of this.playerIds) {
      const b = this.physics.bodies.get(id);
      if (b === undefined) continue;
      if (Math.floor(b.x) !== cx || Math.floor(b.y) !== cy) continue;
      count += 1;
      weight += safeMass(b.mass);
    }
    for (const rt of this.mobHost.runtimes()) {
      if (!rt.alive) continue;
      if (Math.floor(rt.x) !== cx || Math.floor(rt.y) !== cy) continue;
      count += 1;
      const b = this.physics.bodies.get(rt.id);
      weight += b === undefined ? 1 : safeMass(b.mass);
    }
    for (const g of this.mobGround) {
      if (g.count <= 0) continue;
      if (Math.floor(g.x) !== cx || Math.floor(g.y) !== cy) continue;
      count += 1;
    }
    return { count, weight };
  }

  /** 某格有几名**玩家**(掉落物/生物不算「踏上」)。 */
  private playersAt(cx: number, cy: number): number {
    let n = 0;
    for (const id of this.playerIds) {
      const b = this.physics.bodies.get(id);
      if (b === undefined) continue;
      if (Math.floor(b.x) === cx && Math.floor(b.y) === cy) n += 1;
    }
    return n;
  }

  /** 该格有没有**活着的**生物(尸体不算)。 */
  private mobAt(cx: number, cy: number): boolean {
    for (const rt of this.mobHost.runtimes()) {
      if (!rt.alive) continue;
      if (Math.floor(rt.x) === cx && Math.floor(rt.y) === cy) return true;
    }
    return false;
  }

  /** 以格心为中心、`range` 格内(欧氏距离)有没有活着的生物。 */
  private mobWithin(cx: number, cy: number, range: number): boolean {
    const px = cx + 0.5;
    const py = cy + 0.5;
    for (const rt of this.mobHost.runtimes()) {
      if (!rt.alive) continue;
      if (Math.hypot(rt.x - px, rt.y - py) <= range) return true;
    }
    return false;
  }

  /**
   * 本帧是不是**世界日的头一个慢帧**(世界日 06:00 起头)⇒ 426「每早自动洒水」的触发点。
   *
   * 分母是 D-07 的一天(`WORLD_DAY_SEC`),**不另发明**「清晨窗口」的长度;窗口取
   * 一个慢帧(`FAST_PER_SLOW` 快帧)是因为 426 本身就跑在 2Hz 上 ——
   * 一天的帧数能被慢帧周期整除(`24000 % 10 == 0`),所以这个窗口里**恰好**含
   * 当天第一个慢帧(在世界日边界那一拍)。
   */
  private isMorningSlowFrame(): boolean {
    return this.frameCount % WorldSim.FRAMES_PER_DAY < FAST_PER_SLOW;
  }

  /**
   * 读电路求值环境里的某个键(公开读口,给判据用)。
   *
   * 它读的是**真的挂上去了没有**,不是另算一遍:没人调 `installWorldEnv()` 或中途被摘掉,
   * 这里就返回 0 —— 于是「接线断了」能变成一条红,而不是一个静默的恒亮感光器。
   *
   * ⚠️ 这里**不传 `comp`** ⇒ 只答得出位置无关的键(`hour` / `night`);
   * 逐格键(`entityCount` / `fluid` / …)在这里一律 0,那是「没有位置就没有答案」——
   * 逐格读数请直接 `wiring` 上的件求值结果(判据 `WS-FND-114` 就是这么做的)。
   */
  wiringEnvOf(key: string): number {
    return this.wiring.envOf(key);
  }

  /**
   * 对玩家施加一次**远离**(fromX, fromY) 的击退,总距离最多 `KNOCKBACK_MAX_CELLS` 格。
   *
   * 距离由调用方给:内容层的击退量(`PRANK_HAMMER_KNOCKBACK`)是既有锚,
   * 本方法**不新造数值**(新造就得 owner 裁决)。
   *
   * ★ WS-FND-98 两条**上界/归一**规则(此前没有):
   *   1 **质量归一**:`位移 = 距离 × (KNOCKBACK_MASS_REF / mass)`,质量越重推得越近。
   *     `mass` 经 `physics.safeMass` —— 非有限(`NaN`/`±Infinity`)/非正整数(0/负数/小数)
   *     的质量被**拒绝**并退化为基准值。修前 `mass = NaN` 时位移是 `NaN`,刚体位置随即变 `NaN`
   *     (旧写法 `mass <= 0 ? 1 : mass` 对 `NaN` 判 `false`,漏掉的就是这一类)。
   *   2 **总位移上界**:钳到 `KNOCKBACK_MAX_CELLS`(= D-09 的 2 格)。
   *
   * 为什么上界在这里、而不只在受击点:`applyKnockback` 是公开方法(受击点 / Boss 环形果冻波 /
   * 脚本 / 测试都能调),把钳位放在**被调方**才不可能绕过 —— 修前只有受击点那一处 `Math.min`,
   * 直接调 `applyKnockback(id, x, y, 1e9)` 能一次把玩家推出地图。
   */
  applyKnockback(playerId: string, fromX: number, fromY: number, distance: number): boolean {
    const b = this.physics.bodies.get(playerId);
    if (b === undefined) return false;
    if (!Number.isFinite(distance) || distance <= 0) return false;
    const dx = b.x - fromX;
    const dy = b.y - fromY;
    const len = Math.hypot(dx, dy);
    /* 完全重合时没有方向可言 ⇒ 不击退(而不是随便挑一个方向)。 */
    if (!(len > 0)) return false;
    /* ① 质量归一(非法质量在 `safeMass` 里被拒绝 ⇒ 这里的分母一定是正有限整数)。 */
    const mass = safeMass(b.mass);
    const normalized = distance * (WorldSim.KNOCKBACK_MASS_REF / mass);
    /* ② 总位移上界。`normalized` 理论上有限(distance 已过 `isFinite`、mass 是正整数);
       再兜一次是为了「上界」这条承诺本身不依赖上游:`!(cells > 0)` 同时挡住 0 与 NaN。 */
    const cells = Math.min(WorldSim.KNOCKBACK_MAX_CELLS, normalized);
    if (!(cells > 0)) return false;
    this.knockbacks.set(playerId, { dx: (dx / len) * cells, dy: (dy / len) * cells, left: WorldSim.KNOCKBACK_STEPS });
    return true;
  }

  /** 慢帧推进击退:每次推剩余位移的一部分,推完即删。 */
  private tickKnockback(): void {
    for (const [id, k] of this.knockbacks) {
      const b = this.physics.bodies.get(id);
      if (b === undefined) { this.knockbacks.delete(id); continue; }
      /* ⚠️ 必须按**剩余步数**均分,不能每帧除以固定份数:
         后者是几何级数(2 → 1 → 0.5 → 0.25 …),**永远到不了 0** ——
         实测表现是"窗口永不关闭,之后所有移动报文都被拒"。
         这条由 WS-FND-49 的 FND49-6/FND49-7 钉住。 */
      const stepX = k.dx / k.left;
      const stepY = k.dy / k.left;
      b.x += stepX;
      b.y += stepY;
      const left = k.left - 1;
      if (left <= 0) this.knockbacks.delete(id);
      else this.knockbacks.set(id, { dx: k.dx - stepX, dy: k.dy - stepY, left });
    }
  }

  /** 这个玩家正在被击退?(= 位置搬家的窗口) */
  knockbackOf(playerId: string): boolean {
    return this.knockbacks.has(playerId);
  }

  /**
   * 玩家 `FLAG_REVIVE_RADIUS` 内最近的**复活旗**(435)。`null` = 半径内没有旗。
   *
   * ⚠️ 扫描范围由 `FLAG_REVIVE_RADIUS` 决定(不写死格子数):半径改了扫描跟着改。
   */
  private nearestFlag(playerId: string): { id: string; distance: number } | null {
    const b = this.physics.bodies.get(playerId);
    if (b === undefined) return null;
    const r = Math.ceil(FLAG_REVIVE_RADIUS);
    let best: { id: string; distance: number } | null = null;
    for (let y = Math.floor(b.y) - r; y <= Math.floor(b.y) + r; y += 1) {
      for (let x = Math.floor(b.x) - r; x <= Math.floor(b.x) + r; x += 1) {
        if (this.grid.objIdAt(x, y) !== WorldSim.FLAG_OBJ_ID) continue;
        const d = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y);
        if (d > FLAG_REVIVE_RADIUS) continue;
        if (best === null || d < best.distance) best = { id: `flag:${x},${y}`, distance: d };
      }
    }
    return best;
  }

  applyPlayerMove(playerId: string, x: number, y: number, z?: number): boolean {
    this.lastMoveRejection = null;
    /* 闸 0:身份。`physics.bodies` 里玩家与生物**混在一起**(`addPlayer` 与
       `addMob` 都调 `physics.spawn`)⇒ 不查这一条就能用一只生物冒充玩家改坐标。
       判据是「**是不是玩家**」,与「位移合不合法」正交(不构成反作弊的第二份实现)。 */
    if (!this.playerIds.has(playerId)) {
      this.lastMoveRejection = 'NOT_A_PLAYER';
      return false;
    }
    const b = this.physics.bodies.get(playerId);
    if (b === undefined) {
      this.lastMoveRejection = 'NO_BODY';
      return false;
    }
    /* ★ 幽灵泡泡规则 3 —— 显式拒绝,**不许静默返回 true**。
       判据只读 `vitals.downed`:它是「HP 归零」这一瞬时的**唯一**判定,
       由 `applyHit` 写入、`revive` 清除。 */
    if (this.vitals.get(playerId)?.downed === true) {
      this.lastMoveRejection = 'DOWNED';
      return false;
    }
    /* ★ D3:Boss 技能把玩家**定住**时不能移动。
       状态来源是 `vitals.stunnedSec`(慢帧倒计时,`revive` 清零),
       与 `TRAPPED`(227 泡泡)是**两个不同来源的同一个后果**:
       分开留痕才能在断言里区分「被泡泡困住」与「被 Boss 冻住」。 */
    if (this.vitals.stunOf(playerId) > 0) {
      this.lastMoveRejection = 'STUNNED';
      return false;
    }
    /* ★ 被泡泡困住 ⇒ 不能移动。
       `combat/live_bubble.ts` 的 227 状态机(连中 3 发 ⇒ 困 5 秒)此前**没有消费者**
       (审查 B1:`isTrapped` 只被自己与回执读)⇒ "困住"对玩家不可见。 */
    if (isTrapped(this.liveBubbleOf(playerId))) {
      this.lastMoveRejection = 'TRAPPED';
      return false;
    }
    /* ★ 击退窗口:剩余位移没推完之前**不接受位置搬家**。
       不设这道门,下一帧的移动报文就会把击退覆盖掉 ⇒ 击退等于没有
       (DAMAGE-LOOP D1 的实测现象)。窗口是**状态**不是时钟:推完即开。 */
    if (this.knockbacks.has(playerId)) {
      this.lastMoveRejection = 'KNOCKBACK';
      return false;
    }
    /* 非有限值挡在这里:写入 NaN 会让 `mobDistance` 恒 NaN ⇒ 距离闸永久失效,
       而 `NaN` 的比较恒 false 属本仓高发坑(见 `checkMove` §6.0 值域门)。 */
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.lastMoveRejection = 'NON_FINITE';
      return false;
    }
    /* ★ z(高度)与 x/y 走**同一道门**:非有限一概拒绝,理由同上。
       省略 `z` ⇒ **不改**已有高度(向后兼容:只关心平面的调用方行为逐字不变,
       这条由 WS-FND-49 的负对照钉住)。 */
    if (z !== undefined && !Number.isFinite(z)) {
      this.lastMoveRejection = 'NON_FINITE';
      return false;
    }
    b.x = x;
    b.y = y;
    if (z !== undefined) b.z = z;
    return true;
  }

  /** 玩家当前的**权威位置**(读 `physics.bodies`,不是派生视图)。 */
  playerPosition(playerId: string): { x: number; y: number; z: number } | null {
    const b = this.physics.bodies.get(playerId);
    if (b === undefined) return null;
    return { x: b.x, y: b.y, z: b.z };
  }

  /**
   * **世界推进的权威入口**(task-59):推进 `n` 个**快帧**。
   *
   * ## 为什么需要它(第三项装配缺口:驱动缺失)
   *
   * 接线前实测(**服务器路径** 0 处调用推进):
   * ```
   * room.colyseus.ts  setSimulationInterval(20Hz) → RoomRuntime.step()
   * room.ts:1058      step() = meta.tick++ / ac.tick / 落盘 / 投影等级 → 返回
   *                   **不推进 sim**
   * index.ts          `tick`/`run` 关键词 0 命中
   * ⇒ 物理 / AI / 流体 / 电路 / 刷怪 / syncPlayers() **一帧都没跑过**
   * ```
   * ⚠️ 口径:`demo.ts` 也在 `PROD_ENTRIES` 里(它是 `npm run sim`),
   * 所以严谨说法是「**服务器路径** 0 处」,不是「生产 0 处」。
   *
   * 后果不只是「世界不动」:`syncPlayers()` 只在 `tick()` 里跑
   * ⇒ `mobPlayers` 永不刷新 ⇒ **生物 AI 看不见玩家移动**
   * ⇒ 「玩家走过去 → 生物反应」端到端不通(即使位置写入已通)。
   *
   * ## ⚠️ 双频嵌套:为什么这里**只能**逐帧调 `tick()`,不能自己乘 `FAST_PER_SLOW`
   *
   * 两层频率**嵌套**:
   * ```
   * 外层  setSimulationInterval 20Hz  →  RoomRuntime.step()  每秒 20 次
   * 内层  WorldSim 自管双频            →  tick() 内部按计数决定 FAST / SLOW
   * ```
   * 实测:`tick()` 连调 12 次的相位是 `FAST×9 SLOW FAST×2`
   * ⇒ **一次 `tick()` 就是一帧**,快慢**由内部计数决定**。
   * ⇒ `advance(1)` 对应外部一帧,**恰好 1:1**。
   *
   * `SIM_FAST_DT = 0.05 = 1/20`(实测 `=== 1/20` 为 `true`)与外部 20Hz
   * **天然对齐,无需任何换算**。⚠️ 下一个人若以为「慢帧按 2Hz,所以外面要乘
   * `FAST_PER_SLOW`」,就会**每慢帧推进两次 AI**,世界快 2 倍 ——
   * 而这类错误**不报错、测试也可能照过**(本文件下方记着同一先例)。
   *
   * 所以本方法的契约是「**n 个快帧**」,不是「n 秒」也不是「n 个慢帧」。
   * 需要按时间量推进请用 `runForSeconds`(它自己做换算)。
   *
   * ## 为什么用 `tick()` 而不是 `run(n)`
   *
   * 实测二者**完全等价**(`run(n)` 就是循环调 `tick()`):
   * ```
   * run(100): frames=100 slowFrames=10
   * 手调 100 次 tick(): slow=10
   * ```
   * 但 `tick()` 与外部「一次 step 一帧」**一一对应**,多帧循环写在
   * `run()` 里会掩盖「到底推进了几帧」。产线用 `tick()` 更不容易接错。
   *
   * @param n 快帧数。负数/非有限值按 0 处理(不抛错,与 `run` 同取舍)。
   * @returns 实际推进的快帧数(便于调用方断言「推进了几次」)。
   */
  advance(n = 1): number {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const count = Math.trunc(n);
    for (let i = 0; i < count; i += 1) this.tick();
    return count;
  }

  /**
   * 移除玩家(生命值一并清掉)。
   *
   * ## ★ WS-FND-102:瞬态与物理旁表必须一起清(审计实测)
   *
   * 修前这里只清 `playerIds` / `vitals` / `aoi` / `roomEffects` / `forge`
   * / `afk` / `spawnPoints`,**漏了五张按 id 索引的瞬态表**:
   * ```
   * foodBuffs   料理 buff(602 最大生命 +30 就住在这)—— 漏清 ⇒ 同名重连**继承上轮料理**,
   *             且 `maxHpForLevel` 会把 `hpFlat` 并进上限(上限凭空 +30,不报错)
   * liveBubbles 活人泡泡状态机(227)      —— 漏清 ⇒ 重连时一进场就可能被判"被困在泡泡里"
   * sprayUntil  喷射意图窗口(慢帧时效)  —— 漏清 ⇒ 重连后的一帧窗口对上轮残留依然成立
   * tendUntil   翻炒意图窗口(慢帧时效)  —— 同上;漏清 ⇒ 重连后还能"隔空翻炒"上轮那把铲子
   * knockbacks  击退位移窗口               —— 漏清 ⇒ 重连后还会被上轮那次击退继续推两格
   * ```
   * 五张表本就都按**玩家 id** 索引 ⇒ 生命周期必须跟着玩家 id 走(`rebuildWorld` 的
   * 那段注释里也是同一纪律)。这里逐项点名删除,不做"清空一切"。
   *
   * ## ★ 第四轮实测 P2:玩法表 `afkRuns` 也漏了(与 `afkPlayers` **不是**同一张)
   *
   * `afkPlayers` 只是**连接态**标记;真正的玩法表是 `afkRuns`
   * (`dew` 已攒露水 / `backgroundedAtSec` 切后台时刻 / `dozedSec` 打盹累计秒)。
   * 修前它**从不清** ⇒ 同名玩家重连会**继承上一轮的打盹态与已攒露水**
   * (表现:刚上线就按打盹速率产露水、`dewOf()` 一进场就非 0)。
   * `rebuildWorld` 刻意**保留**它(玩家世代数据,不是世界世代),但
   * **移除玩家**是另一件事 —— 那条 id 已经不在房间里了。
   *
   * ## 物理刚体走 `PhysicsWorld.remove` 而不是 `bodies.delete`
   *
   * `bodies.delete` 只摘掉主表,`trapTimers / muMuls / speedCaps / gravityMuls /
   * jumpMuls` 五张旁表里那条 id **留在原地**:同名重连会继承上一轮的速度上限 /
   * 料理滑溜 / 陷阱计时(`remove()` 与 `spawn()` 共用 `reclaimSideTables`,
   * 见 `physics/world.ts` 的注释)。
   */
  removePlayer(id: string): boolean {
    const had = this.playerIds.delete(id);
    this.vitals.unregister(id);
    /* ★ 走 `remove()`:主表 + 五张旁表一起回收(见 docblock)。 */
    this.physics.remove(id);
    this.aoi.unregisterMob(id);
    /* 房间效果状态一并清掉:留着会让重新加入的同名玩家**继承上一轮的温泉计时**
       (表现为「刚上线就带着 20 分钟上限加成」)。 */
    this.roomEffects.delete(id);
    this.forgeUnlockedIds.delete(id);
    /* 打盹标记一并清掉:留着会让**重新加入**的同名玩家一进场就是打盹态
       (表现为「刚上线就不提供 AOI 唤醒能量、还只拿 30% 经验」)。
       与上面 `roomEffects` 是同一类残留。 */
    this.afkPlayers.delete(id);
    /* 出生点一并清掉:留着会让**重新加入**的同名玩家被重置送到上一局的出生点
       (房间把出生点按席位排开,席位是会变的)。与上面两条是同一类残留。 */
    this.spawnPoints.delete(id);
    /* ★ 按 id 索引的瞬态/玩法表(见 docblock):漏任何一张都是"重连继承上一轮"。 */
    this.foodBuffs.delete(id);
    this.liveBubbles.delete(id);
    this.sprayUntil.delete(id);
    this.tendUntil.delete(id);
    /* ★ 第四条:打盹玩法表(与上面那条连接态标记**不是**同一张,见 docblock)。 */
    this.afkRuns.delete(id);
    this.knockbacks.delete(id);
    this.syncPlayers();
    return had;
  }


  /* ═══════════ US2 裁决 3:投影读口(契约 §3.1)═══════════ */

  /**
   * 生命值权威(`VitalsSystem`)。
   *
   * ## 为什么返回**展开的基本类型**而不是 `PlayerVitals`
   *
   * `room.ts` 是**结构化**依赖:它不 import 模拟层类型。
   * 返回一个 `{hp, maxHp, downed}` 字面量就把依赖面收到最小
   * (与 `levelOf` 同一个理由 —— 见它上面那段)。
   *
   * ⚠️ 只展开投影需要的三个字段,**不返回整个对象**:
   *    返回整个 `PlayerVitals` 会让投影侧能读到 `totalTaken` 等
   *    它**不该**碰的字段 —— 接口面越窄,回抄越难写。
   *
   * @returns `null` = 该玩家没有生命记录(未 register)⇒ 调用方**不投影**
   *          (而不是投 0:那会让「世界不认识这个玩家」表现成「血量归零」)
   */
  vitalsOf(canonicalPlayerId: string): { hp: number; maxHp: number; downed: boolean } | null {
    const v = this.vitals.get(canonicalPlayerId);
    if (v === null) return null;
    return { hp: v.hp, maxHp: v.maxHp, downed: v.downed };
  }

  /**
   * 位置权威(含 `z`)。
   *
   * ## 与已有的 `playerPosition()` 的关系:不是重复
   *
   * ```
   * playerPosition(id)  → { x, y }        ← task-58 为「移动写回」而加
   * poseOf(id)          → { x, y, z } | null  ← 本方法,为「8 字段投影」而加
   * ```
   * 两份**读的是同一个 `physics.bodies`**,所以不存在「两份实现互相顶着」
   * —— 但存在「两个读口」这件事本身需要说明,否则下一个人会问为什么有两个。
   *
   * ## 为什么不把 `playerPosition` 改成带 z、只留一个
   *
   * `playerPosition` 的消费方是 `applyMove`,它**只要 x/y**
   * (z 在那条路径上由报文声明)。改成带 z 会让 `applyMove` 拿到一个
   * 它不该信的 z,从而**扩大**那条路径的信任面。
   * ⇒ 保留两个读口,各自面窄。名字也不同(`playerPosition` vs `poseOf`),
   *   避免「同名不同物」(本仓 W7 那个 `Clock` 就是反例)。
   *
   * ⚠️ `z` 的语义:`DynamicBody.z` 是高度。玩家投影 z 从权威读,
   *    而不是抄报文声明值(旧 `applyMove` 是抄的)。
   */
  poseOf(playerId: string): { x: number; y: number; z: number } | null {
    const b = this.physics.bodies.get(playerId);
    if (b === undefined) return null;
    return { x: b.x, y: b.y, z: b.z };
  }

  /**
   * 装备权威:当前手持武器 id(U16 语义;`0` = 空手)。
   *
   * ## ⚠️ 类型是 `number`,**不是**契约 §3.1 写的 `string`
   *
   * ```
   * 契约 §3.1  : weaponOf(): string | undefined
   * 实现真相    : PlayerState.weaponId 是 FieldType.U16(FIELD_TABLE 实测)
   *              WorldSim 侧武器 id 是 number(ARMOR_BY_ID / weaponById 的键)
   * ⇒ 按契约返回 string 会让投影把一个**字符串写进 U16 字段** ——
   *   编码器要么抛,要么写出垃圾。
   * ⇒ 取 number;契约文字应改(已在实现处记 CR)。
   * ```
   *
   * ## 武器是从 `wearing` 里**推**出来的,不是独立字段
   *
   * `PlayerProfile` 只有 `wearing: number[]` 与 `heldItem: number`
   * ⇒ 「什么是武器」由 `equipmentSnapshotOf` 的既有规则决定:
   *   **不在 `ARMOR_BY_ID` 里的第一个 id** 就是武器。
   * ⚠️ 这里**复用**那条规则而不另写一套 —— 另写会让「武器是什么」
   *    出现两份判据(零爆装冻结与投影会对同一份 wearing 给出不同武器)。
   *
   * @returns `undefined` = 没装备武器 ⇒ 调用方**不投影**
   *          (不写 0:`0` 是「空手」这个**真实状态**,与「采不到权威」两件事)
   */
  weaponOf(playerId: string): number | undefined {
    const wearing = this.profiles.get(playerId)?.wearing;
    if (wearing === undefined || wearing.length === 0) return undefined;
    for (const id of wearing) {
      if (!ARMOR_BY_ID.has(id)) return id;
    }
    return undefined;
  }

  /**
   * 等级 → **派生上限**的权威算子(契约 §2.1)。
   *
   * ## 为什么归 `WorldSim` 提供,而不是让 `room.ts` 自己调 `progression`
   *
   * `net → combat` 是**禁止**的依赖方向(契约 §8;`WS-07 K6` 钉住
   * `room.ts` 的代码态不得出现模拟层符号)。而「等级 → 属性」的算子是
   * `progression.statsAtLevel` —— 若让房间直接调它,那条禁止就被绕过了。
   * ⇒ 由世界源(它**合法地**同时知道 progression 与 vitals)转发一层。
   *
   * ## ⚠️ 这里**不新增**等级→属性的公式
   *
   * `progression` 是唯一算子(契约 §1)。本方法只**转发**它的结果。
   * 若在这里写 `100 + 15*(lv-1)`,就出现了第二份公式 ——
   * 而那正是 W1(两个 maxHp 来源)的成因。
   *
   * @returns `null` = 该玩家没有档案/玩家不存在 ⇒ 调用方不更新上限
   */
  maxHpForLevel(playerId: string, level: number): number | null {
    /* ★★★ 实测抓到的错:我第一版这里先查 `progresses.get(playerId)`,
     * 没有档案就返回 null。后果:
     * ```
     * 玩家 join 后**没有** progression 档案(levelOf 也不建档案,见它的注释)
     * ⇒ maxHpForLevel 返回 null ⇒ 房间不更新上限 ⇒ maxHp 永远停在
     *   VitalsSystem 构造默认值 100
     * ⇒ 30 级玩家 maxHp 仍是 100(而 progression 口径是 535)
     * ⇒ ⇒ **W1 那个缺口原样还在**,只是换了个地方表达
     * ```
     * ⇒ 修:本方法是「等级 → 属性」的**纯算子**转发,等级是**参数**给的,
     *   不需要玩家有档案。加档案检查等于凭空引入一个与等级无关的前提。
     * ⚠️ `playerId` 曾经**没有用到**;2026-11-15 起它真的参与运算:
     *   料理 buff 的 `hpFlat` 要并进上限(见下方 `mergeFoodBuffs` 那一行)。
     *   当初保留这个参数的两个理由(签名一致 / 将来按玩家算)正好在此兑现 ——
     *   调用方一个都没改。⇒ `void playerId` 已随这次接线删除。
     *
     * ⚠️ `progression` 是唯一算子(契约 §1):这里**只转发**
     *    `statsAtLevel` 的结果,不写 `100 + 15*(lv-1)` ——
     *    写出那条公式就是第二份实现(正是 W1 的成因)。 */
    /* ★ 料理 buff 的 `hpFlat`(手册:602 最大生命 +30)并进上限。
       接在这一层而不是 `syncMaxHp`:上限的**唯一**算子是本方法,
       `vitals.syncMaxHp` 只负责"抬上限 / 钳 hp" —— 两边都不复述策略。 */
    const stats = statsAtLevel(level);
    const hpFlat = mergeFoodBuffs(this.foodBuffs.get(playerId) ?? []).hpFlat;
    /* ★ 房间上限乘区(手册:泡温泉 +30%)。
       倍率走 `effects.ts` 的 `maxHpMulOf` —— 与 `effectiveMaxHp`、`stepRoomEffects`
       **同一个函数**,不在这里重写条件(重写就是第二份实现,漂移时不报错)。
       ⚠️ 乘区**只在这一处**套:因为 `vitals.maxHp` 必须是**含乘区**的权威值,
       否则泡温泉时回血填不满上限(上限 130、实际钳在 100)。 */
    const base = stats.maxHp + hpFlat;
    if (!Number.isFinite(base)) return null;
    this.baseMaxHp.set(playerId, base);
    const st = this.roomEffects.get(playerId);
    const total = st === undefined ? base : Math.round(base * maxHpMulOf(st));
    return Number.isFinite(total) ? total : null;
  }

  /**
   * 最近一次 `maxHpForLevel` 算出的**基准上限**(未套房间乘区)。
   *
   * ## 为什么需要它(它不是第二份真值)
   *
   * 乘区**只能**在 `maxHpForLevel` 里套一次;而 `effectiveMaxHp()` 要能在
   * **没经过房间同步**的场景(纯 `WorldSim` 用法、WT-03-64 那类判据)也报同一个数,
   * 所以它需要**算子入参**这一刻的基准值 —— `v.maxHp` 在房间里已经含乘区,
   * 拿它再乘一次就是 ×1.69。
   *
   * ⚠️ 本表**只由 `maxHpForLevel` 写**。任何地方绕过它去改上限,
   * 都会让两个读数分叉 —— 那正是"两份实现"的形态。
   */
  private baseMaxHp = new Map<string, number>();

  /**
   * 把派生上限落到 `vitals`(契约 §2.1 的**唯一**写入口是 `vitals.syncMaxHp`)。
   *
   * ⚠️ 本方法是**纯转发**:策略 C(只抬上限、钳 hp、不补血)的实现在
   *    `vitals.syncMaxHp` 内部,不在这里复述 —— 复述就是两份实现。
   *
   * @returns 是否发生了变更
   */
  syncMaxHp(playerId: string, derivedMaxHp: number): boolean {
    return this.vitals.syncMaxHp(playerId, derivedMaxHp);
  }

  /* ══════════════════ 使用道具(`USE_ITEM` 的世界侧落点)══════════════════ */

  /** 每个玩家身上生效中的料理 buff。慢帧推进、过期即删。 */
  private readonly foodBuffs = new Map<string, FoodBuff[]>();

  /** 该玩家身上 buff 的合并结果(乘区相乘、加值相加)。只读,不返回内部数组。 */
  /* ── 活人被困进泡泡(227 的"活人半边")────────────────────────── */

  /** 每个玩家当前的活人泡泡状态(层数 / 剩余困住秒)。**只在这里**存活人泡泡。 */
  private readonly liveBubbles = new Map<string, LiveBubbleState>();

  /**
   * ★ **D-12**:把每个玩家的「摩擦乘区」推给物理层。
   *
   * ## 为什么这里只推、不算
   * 结算点**只在** `PhysicsWorld`(`b.mu = 地板μ × mul`)。这里多乘一次就是平方
   * (`WS-FND-54` FND54-2 的 0.9408 会变 0.9047)。所以本方法只做「读 buff → 推乘子」。
   *
   * ⚠️ 乘子的中性值是 **1**,而 `FoodBuff.muOverride` 的中性值是 **0**(没意见)。
   *   两者语义不同,必须显式换算:0 ⇒ `clearMuMul`(恢复地板值),>0 ⇒ `setMuMul`。
   */
  private syncFoodFriction(): void {
    for (const id of this.vitals.ids()) {
      const mu = mergeFoodBuffs(this.foodBuffs.get(id) ?? []).muOverride;
      if (mu > 0) this.physics.setMuMul(id, mu);
      else this.physics.clearMuMul(id);
    }
  }

  /**
   * ★ **D-11**:该玩家是否已解锁高级锻造(= 站在 `FORGE_MASTER` 房间里)。
   *
   * **不另算一份房间归属**:`forgeUnlocked` 由 `stepRoomEffects` 每帧写进
   * `RoomEffectState`(那是房间效果的**唯一**产出点),这里只是把它投影成动作层要的读口。
   * 没有房间效果记录的玩家 ⇒ `false`(失败即锁)。
   */
  forgeUnlockedOf(actorId: string): boolean {
    const st = this.roomEffects.get(actorId);
    return st === undefined ? false : st.inForge === true;
  }

  /** 只读:该玩家现在的活人泡泡状态(没记录 ⇒ 初始态,**不建记录**)。 */
  liveBubbleOf(playerId: string): LiveBubbleState {
    return this.liveBubbles.get(playerId) ?? LIVE_BUBBLE_INITIAL;
  }

  /** 慢帧:推进所有活人泡泡的困住计时;回到初始态即清记录。 */
  tickLiveBubbles(): void {
    const dt = SIM_SLOW_DT;
    for (const [id, s] of [...this.liveBubbles]) {
      const next = tickLiveBubble(s, dt);
      if (next.stacks === 0 && next.trapSec === 0) this.liveBubbles.delete(id);
      else this.liveBubbles.set(id, next);
    }
  }

  buffsOf(playerId: string): FoodBuff['statMods'] {
    return mergeFoodBuffs(this.foodBuffs.get(playerId) ?? []);
  }

  /**
   * 慢帧:推进每个玩家 buff 的剩余时间,过期的移除。
   * ⚠️ 先 `[...this.foodBuffs]` 复制:循环内部会 `delete`,边迭代 `Map` 边删键是未定义行为。
   */
  tickFoodBuffs(): void {
    const dt = SIM_SLOW_DT;
    for (const [id, list] of [...this.foodBuffs]) {
      const kept: FoodBuff[] = [];
      for (const b of list) {
        const t = tickFoodBuff(b, dt);
        if (!t.expired) kept.push(t.buff);
      }
      if (kept.length === 0) this.foodBuffs.delete(id);
      else this.foodBuffs.set(id, kept);
    }
  }

  /**
   * 道具的**使用语义分类**(`USE_ITEM` 的唯一语义表)。
   *
   * ## 为什么单独抽出来,而且必须是**纯**的
   *
   * 动作层要在**扣道具之前**回答「这件东西到底能不能用」(否则非法请求会先扣再退,
   * 而「退了」这件事在回执里是看不出来的)。若它自己维护一张 id 白名单,
   * 那张表与 `useItem` 的分支**必然漂移**(本仓陷阱 31/41)。
   * ⇒ 语义只在这里定义一次:动作层查它做前置门,`useItem` 用它做分派。
   *
   * ## 四种语义 + `null`
   *
   * ```
   * FEATHER  733 复苏天使羽毛笔(救幽灵泡泡)
   * BUBBLE   227 泡泡连发水枪(叠/困人)
   * DEVICE   227 / 212 大铁铲 —— 浇灭料理站炉火(与 BUBBLE 同一件道具,两条语义)
   * FOOD     内容表 `FOOD_BY_ID` 里的料理
   * null     没有使用语义(调用方必须**拒绝**,不是"什么都不做但扣掉")
   * ```
   *
   * ⚠️ 这里**不判目标**:「227 对玩家是泡泡枪,对炉子是灭火器」由调用方按
   * `targetDeviceId` 选分支(报文里两者互斥)。
   */
  itemUseKind(itemId: number): 'FEATHER' | 'BUBBLE' | 'DEVICE' | 'FOOD' | null {
    if (!Number.isFinite(itemId)) return null;
    const id = Math.trunc(itemId);
    if (id === WorldSim.FEATHER_PEN_ITEM_ID) return 'FEATHER';
    if (id === WorldSim.BUBBLE_GUN_ITEM_ID) return 'BUBBLE';
    if (id === WorldSim.SHOVEL_ITEM_ID) return 'DEVICE';
    if (FOOD_BY_ID.has(id)) return 'FOOD';
    return null;
  }

  /**
   * `USE_ITEM` 的世界侧落点:按 `itemId` + **目标类型**分派四种语义。
   *
   * ## `applied` 与 `consume` 为什么分开
   * 「生效」与「该扣道具」不是同一件事:733 超距 ⇒ 什么都没发生,**也不许扣**。
   * 动作层只信这里回来的 `consume`,不自己再判一次距离(那会是第二份实现)。
   *
   * ## 三种语义
   * 1 **733 复苏天使羽毛笔**:救 6 格内的幽灵泡泡队友,满血 + 3 秒无敌。
   *    距离判定**只由** `featherRevive` 拥有 —— 这里不预判。
   * 2 **227 泡泡连发水枪**:**两半都有落点** —— 目标已有 `DownedState` ⇒ `bubbleGunHit`
   *    (叠 3 层 ⇒ `BUBBLED`);目标是活人 ⇒ `combat/live_bubble.ts` 的状态机
   *    (手册 §3.7:连中 3 发 ⇒ 装进大泡泡)。两者是**不同主体**,不是同一件事两份实现。
   * 3 **料理**:吃一份成品 ⇒ 写入该玩家的 active buffs(`foodBuffFrom` 是唯一构造处),
   *    即时回复 `instantHealHp`,`hpFlat` 由 `maxHpForLevel` 并进上限。
   * 4 **器件(料理站)**:**227 水枪 / 212 大铁铲**浇灭炉火(`extinguishStationAt`)。
   *    距离由内容层常量 `EXTINGUISH_RADIUS` 判 —— 动作层不预判,世界侧一处说了算。
   *
   * ## ⚠️ 不校验"该玩家真的有这一件"
   * 服务端今天**没有按件背包明细读口**(`PlayerState` 只有 `heldItemId`)⇒ `itemId` 是客户端自报的;
   * 这里只信"它是我认识的 id"。扣减由动作层走 `applyInventory`(总量守恒),见 `TASK-99`。
   */
  useItem(actorId: string, req: { itemId: number; targetId?: string; targetDeviceId?: number }): {
    applied: boolean;
    consume: boolean;
    reason: string;
    effect?: Record<string, string | number | boolean>;
  } {
    /* 道具 id 来自冻结内容表(`shared/constants/items.ts`);语义表见 `itemUseKind`。 */
    const itemId = Number.isFinite(req.itemId) ? Math.trunc(req.itemId) : 0;
    const kind = this.itemUseKind(itemId);
    const targetId = req.targetId ?? actorId;

    /* 0 **器件目标**:`targetDeviceId` 一出现就走灭火这条路,不再看 `targetId`
       (否则"对着锅喊队友名字"会两边都算 —— 两种目标是互斥的报文形态)。 */
    if (req.targetDeviceId !== undefined) {
      return this.extinguishDeviceByHand(actorId, itemId, Math.trunc(req.targetDeviceId));
    }

    if (kind === 'FEATHER') {
      const d = this.downedStates.get(targetId);
      if (d === undefined) {
        return { applied: false, consume: false, reason: '目标不在幽灵泡泡状态' };
      }
      const a = this.physics.bodies.get(actorId);
      const b = this.physics.bodies.get(targetId);
      const distance = a === undefined || b === undefined
        ? Number.POSITIVE_INFINITY
        : Math.hypot(b.x - a.x, b.y - a.y);
      const out = featherRevive({
        downed: d, casterId: actorId, distance, progress: this.progressOf(targetId),
      });
      if (!out.revived || out.result === null) {
        return { applied: false, consume: false, reason: out.reason };
      }
      this.lastRevive = out.result;
      /* 写回**活的那一套**:受击判定读的是 `vitals.iframeSec`,不是 `DownedState.invulnSec`
         (与 `tickDowned` 里 task-64 那条注释同源)。 */
      this.vitals.revive(targetId, out.result.hpAfter, out.result.invulnSec);
      this.downedStates.delete(targetId);
      return {
        applied: true, consume: true, reason: 'ok',
        effect: {
          itemId, targetId, hpAfter: out.result.hpAfter, invulnSec: out.result.invulnSec,
        },
      };
    }

    if (kind === 'BUBBLE') {
      /* ① 目标是**幽灵泡泡**(倒地中)⇒ 走 `DownedState` 那条既有路径(叠层,满 3 层 `BUBBLED`)。 */
      const d = this.downedStates.get(targetId);
      if (d !== undefined) {
        const out = bubbleGunHit(d);
        this.downedStates.set(targetId, out.downed);
        return {
          applied: true, consume: true, reason: 'ok',
          effect: { itemId, targetId, trapped: out.trapped, stacks: out.downed.bubbleStacks, live: 0 },
        };
      }
      /* ② 目标是**活人** ⇒ 走 `combat/live_bubble.ts` 的状态机
         (手册 §3.7:"对活人连中 3 发 ⇒ 装进大泡泡、随风飘 5 秒")。
         ⚠️ 不是"同一件事两份实现":`DownedState` **只在倒地期间存在**,活人没有它;
            两边共享的只有手册里的词与两个常量(常量从 `revive.ts` import,不重抄)。 */
      const v = this.vitals.get(targetId);
      if (v === null) {
        return { applied: false, consume: false, reason: '目标不在这个房间里' };
      }
      const out = liveBubbleHit(this.liveBubbleOf(targetId));
      this.liveBubbles.set(targetId, out.state);
      return {
        applied: true, consume: true, reason: 'ok',
        effect: {
          itemId, targetId, trapped: out.trapped, stacks: out.state.stacks,
          trapSec: out.state.trapSec, live: 1,
        },
      };
    }

    const food = FOOD_BY_ID.get(itemId);
    if (food !== undefined) {
      /* ★ 第六轮实测 P2:`cleansePrankBuffs`(612 净化饮)此前**生产 0 调用** ——
         喝一瓶净化饮只会多一条 `{cleanse:true}` 的 buff,身上已有的整蛊 buff
         一条都不掉(而手册写着「解除一切负面/整蛊状态」)。现在由本分支执行:
         `flags.cleanse === true` ⇒ 先过 `cleansePrankBuffs` 再挂新 buff。
         ⚠️ 判据只看**食物自带的 flag**,不看 id:612 的语义在内容表里,
            在编排层再写一次 `itemId === 612` 就是第二份实现。 */
      const next = foodBuffFrom(food);
      const kept = next.flags.cleanse === true
        ? cleansePrankBuffs(this.foodBuffs.get(actorId) ?? [])
        : (this.foodBuffs.get(actorId) ?? []);
      const list = [...kept, next];
      this.foodBuffs.set(actorId, list);
      let healed = 0;
      if (food.instantHealHp > 0) healed = this.vitals.heal(actorId, food.instantHealHp);
      return {
        applied: true, consume: true, reason: 'ok',
        effect: { itemId, buffs: list.length, healedHp: healed, durationSec: food.durationSec },
      };
    }

    return { applied: false, consume: false, reason: `道具 ${itemId} 没有使用语义` };
  }

  /**
   * 背包**明细**(契约 §2.3 第 8 项的权威来源)。
   *
   * ## ⚠️ 世界源这里返回 `null` 是**正确的当前状态**,不是缺陷
   *
   * 契约 §2.3 说第 8 项的权威是 `users.inventory_json` —— 那是**数据库**侧,
   * 不在 `WorldSim` 里(`WorldSim` 不持有 db,实测它的构造参数里没有)。
   * ```
   * room.ts 侧已有权威总量:`authoritativeItemTotal()`(读 db 的 totalItemsOf)
   * WorldSim 侧:没有背包明细
   * ⇒ 故本方法默认返回 null ⇒ 投影侧走「没有明细」退路
   * ```
   * ⇒ 这是**如实**表达「模拟层不持有背包明细」,而不是假装有。
   *   若日后背包搬进模拟层,实现本方法即可,投影侧一行不用改。
   *
   * ⚠️ 返回 `readonly { quantity?: unknown }[]` 而不是模拟层的物品类型:
   *    仍然是为了让 `room.ts` 不依赖模拟层类型(结构化)。
   */
  inventoryDetailOf(_playerId: string): readonly { quantity?: unknown }[] | null {
    return null;
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
  lastRoomEffects: {
    playerId: string;
    roomKey: string | null;
    healHp: number;
    maxHpMul: number;
    forgeUnlocked: boolean;
    /** 本慢帧该玩家**是否正在睡觉**(0/1)。见 `attachSleepSource`。 */
    sleeping: number;
    /** 大餐乘区(食堂 **且** 带着料理 buff;1.0 = 无)。判定在 `rooms/effects.ts`。 */
    mealMul: number;
  }[] = [];

  /**
   * 「这个玩家正在睡吗」的世界侧读口 —— 由**装配层**接上(`index.ts` 调 `actions/sleep.ts` 的
   * `sleepStateOf`),`WorldSim` 自己不 import `net/actions/**`(那会让 sim 依赖 net)。
   *
   * ⚠️ **可选**:没接 ⇒ 每条记录写 `sleeping: 0`,即"世界侧不知道"。
   *   这不是"玩家没睡",而是"没有读者" —— 所以判据要按 0 断言,不要把它读成否定事实。
   */
  private sleepSource: ((userId: string) => boolean) | null = null;

  /** 注入睡眠读口(幂等:后注入的覆盖先注入的)。 */
  attachSleepSource(fn: (userId: string) => boolean): void {
    this.sleepSource = fn;
  }
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

      /* ★ D4 生产写入点:把**房间来源**的元素抗性推给 `vitals`(单点推送)。
         `key` 为 null(不在任何已识别房间)时本函数写回中性值 ⇒「离开即撤销」。
         不发返回值:这里不消费「是否被接受」—— 非法 `mul` 的守卫在
         `setElementResist` 里,判据 WS-FND-93 FND93-4 直接钉那一层。 */
      pushRoomElementResist(this.vitals, id, key);
      let st = this.roomEffects.get(id);
      if (st === undefined) {
        st = createRoomEffectState();
        this.roomEffects.set(id, st);
      }
      /* ★ 大餐乘区的**另一半触发条件在房间之外**(玩家身上有没有料理 buff)
         ⇒ 必须由这里喂进去。漏传 = 按"没有 buff"处理 ⇒ 乘区恒 1.0 ——
         这正是它此前"算完即丢"的成因(判据 WS-FND-47 第 4 条钉住漏传的后果)。
         ⚠️ 口径:身上**任何**生效中的料理 buff 都算"带着料理";要不要把整蛊类
         (607–611)排除在大餐之外是**平衡裁决**,不是接线 —— 故这里不做。 */
      const hasMealBuff = (this.foodBuffs.get(id) ?? []).length > 0;
      const r = stepRoomEffects(st, { roomKey: key, dt, hasMealBuff });
      this.roomEffects.set(id, r.state);

      /* 卧室回血:走既有 `vitals.heal` 接口 —— 它已处理「上限截断」
         与「倒下不回血」两条边界,不在这里重写一遍。 */
      if (r.healHp > 0) this.vitals.heal(id, r.healHp);

      /* 锻造解锁:记录 `stepRoomEffects` 的**返回判定**,不在此重判。 */
      if (r.forgeUnlocked) this.forgeUnlockedIds.add(id);
      else this.forgeUnlockedIds.delete(id);

      const sleeping = this.sleepSource?.(id) === true ? 1 : 0;
      out.push({
        playerId: id, roomKey: key, healHp: r.healHp, maxHpMul: r.maxHpMul,
        forgeUnlocked: r.forgeUnlocked, sleeping, mealMul: r.mealMul,
      });
    }
    this.lastRoomEffects = out;
  }

  /**
   * 某玩家的**有效生命上限**(含房间增益)—— 与权威值**同一个数**的读数口。
   *
   * ## ★ 2026-11-16 更正:权威值是哪一份
   *
   * 权威值是 `vitals.maxHp`,而它**已经含房间乘区** —— 乘区套在
   * `maxHpForLevel`(上限的**唯一**算子)里,再经 `syncMaxHp` 落到 vitals。
   * 「离开温泉即撤销」靠的是**每帧重算**(`onsenSec` 归零 ⇒ 下一次重算回到基准),
   * 不是"从不写进 vitals"。
   *
   * ⚠️ 本文曾写"基准值留在 `vitals.maxHp`、增益在此派生" —— 那是上一版的实现,
   * 与本版**相反**。本方法现在的存在理由是:`WorldSim` 的**纯用法**(测试夹具,
   * 没有房间运行时去推 `syncMaxHp`)也要能拿到同一个数,所以按同一口径重算一遍。
   * 基准取 `baseMaxHp`(算子入参备忘),**不是** `v.maxHp`:后者在房间里已经含乘区,
   * 再乘一次就是 ×1.69。`WS-03` 的 WT-03-64 负对照钉住"离开即撤销"。
   */
  effectiveMaxHp(id: string): number {
    const v = this.vitals.get(id);
    if (v === null) return 0;
    const st = this.roomEffects.get(id);
    /* 倍率走 `effects.ts` 的 `maxHpMulOf` —— 与 `stepRoomEffects`、`maxHpForLevel`
       **同一个函数**,不在这里重写一遍条件(重写就是第二份实现,漂移时不报错)。
       ⚠️ 基准取 `baseMaxHp`(算子入参备忘),**不是** `v.maxHp`:后者在房间里
       已经含乘区,再乘一次就是 ×1.69。没经过 `maxHpForLevel` 时才退回 `v.maxHp`
       (WT-03-64 那种纯 `WorldSim` 用法走的就是这条)。 */
    const base = this.baseMaxHp.get(id) ?? v.maxHp;
    if (st === undefined) return base;
    return Math.round(base * maxHpMulOf(st));
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
   *
   * ## ★ 裁决 4:hp 的钳制**不在本函数**(唯一选址是 `VitalsSystem.revive`)
   *
   * 本函数此前自带一份 `Math.min(v.maxHp, row.hp)`。裁决要求「把已有规则提到
   * 唯一入口」⇒ 那份实现**已摘除**,这里的 `row.hp` 原样传给 `revive`。
   * 修前的准确缺陷形态不是「读档没钳」,而是「**同一入口两条路径口径不同**」
   * (读档有钳、`revive` 无钳 ⇒ 可造出 `hp > maxHp`)。
   *
   * ⚠️ 由此,调用方的**顺序**成为硬约束:先 `syncMaxHp`(抬到等级派生值)再调本函数。
   * 否则上限还是构造缺省 `PLAYER_BASE_HP`,30 级玩家的 535 血会被钳成 100。
   */
  importVitals(data: Record<string, { hp: number; maxHp?: number; downed?: boolean }>): number {
    let applied = 0;
    for (const id of Object.keys(data).sort()) {
      const v = this.vitals.get(id);
      if (!v) continue;
      const row = data[id];
      /* 不可信行**跳过**(不写):与 `revive` 的 NaN 兜底同族,但拒绝语义不同 ——
         那里是「回退到满血」,这里是「不计入生效数、不改动现值」。
         ⚠️ 数值钳制**不在这里**(见方法注释的裁决 4)。 */
      if (!row || typeof row.hp !== 'number' || !Number.isFinite(row.hp)) continue;
      this.vitals.revive(id, row.hp);
      applied += 1;
    }
    return applied;
  }

  /**
   * **读档恢复的权威入口**(task-70 / 契约 `TASK47-LAYER-WIRING-CONTRACT.md` §2.1)。
   *
   * 把一份玩家档案(来自 `room_players.snapshot_blob` 解码后**该玩家自己那一行**)
   * 按**固定顺序**写进权威层:`progresses`(等级)与 `vitals`(生命)。
   *
   * ## ★ 为什么需要这个口(而不是让房间自己写 state)
   *
   * 实测:`level` 的**唯一持久化处**就是 `snapshot_blob`(它是 `encodeFull(state)`
   * 的投影值);而 `users` 表虽然**有** `level`/`max_hp` 列,
   * `saveVitalsToUsers` 只写 `hp`(`repo.ts:773`),且 `hp` 被
   * `cur.max_hp`(=建号 100)钳住 —— 故 **DB 路装不下 535 血**。
   * ⇒ 读档必须走 blob;而 blob 里是**投影值**,不是权威。
   * ⇒ 若房间直接把 blob 的值塞进 `state.players[]`,那是**直写投影**(违反 §4.3):
   *   下一帧 `projectPlayer` 会用权威的旧值把它覆盖回去,表现为「恢复了又弹回」。
   * ⇒ 故必须有一个**权威侧**的口来接收这份档案。
   *
   * ## ★★ 顺序是硬约束,理由都是实测出来的
   *
   * ```
   * 1 addPlayer            —— 未登记则 vitals/physics 都不知道此人,
   *                          后续 importVitals 会因 `this.vitals.get(id)` 为
   *                          undefined 而**静默跳过**(importVitals 的既有取舍)
   * 2 applyPlayerMove      —— 位置先落位,免得后续投影读到旧坐标
   * 3 ★ syncMaxHp(**必须**在 importVitals 之前)
   *      钳制**唯一**在 `VitalsSystem.revive`(裁决 4;`importVitals` 已摘除自己那份)。
   *      若此时 maxHp 还是构造缺省值 100,30 级玩家的 535 血会被**钳成 100**。
   *      ⇒ 先按 level 把上限抬到派生值,再灌 hp。
   * 4 importVitals         —— hp 落位(原样传值,钳制由 revive 做;顺带清 downed/iframe)
   * 5 setProfile           —— 装备等档案字段
   * ```
   * ⚠️ 第 3 步与第 4 步**换序会静默给出错值** —— 不是报错,是钳制。
   *    这正是 US2 §4 记下的同一条纪律(`先 syncMaxHp 再投影`)。
   *
   * ## ⚠️ 本方法**不新增**派生公式
   *
   * `maxHp` 由 `maxHpForLevel`(纯转发 `progression.statsAtLevel`)算,
   * 落盘走 `vitals.syncMaxHp`。这里不写 `100 + 15*(lv-1)` ——
   * 写了就是第二份实现(正是 W1 的成因)。
   * ⇒ 故 `profile` **刻意不含 `maxHp`**:它是 level 的派生值,由本层算。
   *
   * @returns 实际生效的玩家数(0 = 没登记过 ⇒ 什么都没做)
   */
  restoreFromProfile(playerId: string, profile: {
    level: number; hp: number; x: number; y: number; z: number; weaponId?: number;
  }): number {
    /* 1 登记:未登记时 applyPlayerMove/importVitals 都会静默 no-op。 */
    if (!this.playerIds.has(playerId)) this.addPlayer(playerId, profile.x, profile.y);

    /* 2 位置(刚体) —— 已获准的写入,与 `applyPlayerMove` 同一语义。 */
    this.applyPlayerMove(playerId, profile.x, profile.y);

    /* 3 ★ 先抬上限:必须在灌 hp 之前,否则 535 会被旧上限 100 钳住。 */
    const level = Number.isFinite(profile.level) ? profile.level : 1;
    const derived = this.maxHpForLevel(playerId, level);
    if (derived !== null) this.syncMaxHp(playerId, derived);

    /* 3.5 等级档案。`setLevel` 是纯函数(返回新对象)⇒ 必须回写 Map,
        否则 `levelOf` 仍读到旧等级(而 vitals 上限已经是新等级的值 ⇒ 不一致)。 */
    const cur = this.progresses.get(playerId) ?? createProgress(playerId);
    this.progresses.set(playerId, setLevel(cur, level));

    /* 4 hp 落位(revive ⇒ 清 downed/iframe)。 */
    let applied = 0;
    if (Number.isFinite(profile.hp)) {
      applied = this.importVitals({ [playerId]: { hp: profile.hp } });
    }

    /* 5 档案字段(武器)。
       ⚠️ 必须写进 `wearing`,**不是** `heldItem` ——
       `weaponOf` 的既有规则是「`wearing` 里**不在 `ARMOR_BY_ID`** 的第一个 id」
       (见其 docblock:复用该规则而不另写一套)。
       我第一版写成 `heldItem: profile.weaponId`,那样 `weaponOf` **永远读不到它**
       ⇒ 表现为「存档里有武器,恢复后投影出 undefined ⇒ 武器凭空消失」,
       而**不会有任何东西报错**(setProfile 照常成功)。
       ⇒ 与陷阱 89 同族:写进去了,但走的是另一条路。

       ⚠️ 这里**只写武器那一个 id** —— 因为 blob 里只有 `weaponId` 这一个
       装备字段(`PlayerState` 没有整份 `wearing`)。
       ⇒ 故打包成只含武器的 `wearing`。护甲不在本任务范围(存档里本来就没有它);
         若将来 blob 扩出 `wearing`,这里应改;记在契约 §10 未决。 */
    if (profile.weaponId !== undefined && Number.isFinite(profile.weaponId)) {
      this.setProfile(playerId, { wearing: [profile.weaponId] });
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

  /* ═══════════════ 世界重置(★ D-06:归档 + 内存重建)═══════════════
   *
   * 裁决原文(`docs/DECISIONS.md` **D-06**):
   *   「世界按新 seed **在内存重建**,旧世界存成一份**可回滚快照行**
   *     (不删、也不原地不管)」
   *   「`WorldSim.resetWorld({seed})` 负责内存重建,归档由宿主/DB 侧做」
   *
   * 本节就是这条裁决的**宿主那一半**:
   *   `resetWorld`               —— 唯一入口;顺序 = **描述 → 归档 → 重建**
   *   `describeWorldForArchive`  —— 旧世界的**可重建描述**(字节格式见其 docblock)
   *   `rebuildWorld`             —— 内存重建(清空世界世代 + 玩家复位)
   *
   * ⚠️ 本文件**不 import 存储层的类型**:归档经注入的 `archiveSink` 走
   *   (`WorldSimOptions.archiveSink`),装配层(`index.ts`)把它接到
   *   `repo.archiveWorldSnapshot` —— 依赖单向,sim 不认识 db 的类型面。
   */

  /**
   * **在内存里重建世界**(`WORLD_RESET` 的宿主那一半,`RESET_WORLD` 的落点)。
   *
   * ## 顺序是硬约束:**先取描述 → 归档 → 再重建**
   *
   * ``` 
   * 1 describeWorldForArchive()   ← 此刻世界还是**旧**的,描述才等于"旧世界"
   * 2 archiveBeforeReset(...)     ← 把那份描述交给归档口(D-06)
   * 3 rebuildWorld(seed)          ← 之后才是新世界
   * ```
   * 一旦反序,归档下来的就是**新世界**(或半新半旧),而回滚出去的会是错的 ——
   * 且这种错误在回执上**看不出来**(`archiveId` 照样非空)。
   *
   * ## 归档失败**不改 `applied`**(判决,不是风格)
   *
   * 「旧世界没存下来」与「新世界没生效」是**两件事**:
   *   - 归档口抛错 / 没有库 ⇒ 回 `archive: null` + `archiveError`(**如实**说清),
   *     但世界**照样重建**、`applied` 照样 `true`;
   *   - 把 `applied` 也改成 `false` 是**谎报**:世界其实已经换了,客户端却会以为
   *     还停在旧世界(继续用旧 chunk / 旧实体),那比"少了一份快照"严重得多。
   * `net/actions/reset_world.ts` 的 `resetEffect` 正是按这个分工写的
   * (它能表达的三种归档态:ARCHIVED / NOT_ARCHIVED / UNREPORTED)。
   *
   * ## 参数
   *
   * - `seed`:**新世界**的种子(有限整数;非法 ⇒ `applied: false` + 零副作用)。
   *   动作层已经校验过一遍,这里再拦一次是因为本方法是**公开 API**
   *   (`net/room.ts` 的 `WorldSaveHost.resetWorld` 就是它),不能只靠上游守门。
   * - `nowMs`:归档行的 Unix 毫秒。**刻意做成可选**:动作层手里没有时钟
   *   (它的报文里只有 `seed` / `confirm`),缺省用 `Date.now()`。
   *   ⚠️ 它**只进归档行**,不进模拟 —— 世界时钟是 `frameCount` 派生的(D-07),
   *   故挂钟不会污染确定性。
   *
   * @returns `WorldResetResult`(与 `WorldSaveHost.resetWorld` 逐字段同形;
   *          `applied:false` 时**一字未改**,`reason` 说清为什么)。
   */
  resetWorld(opts: { seed: number; nowMs?: number }): WorldResetResult {
    const raw = opts === null || opts === undefined ? undefined : opts.seed;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      return {
        applied: false,
        seed: 0,
        reason: `世界重置需要有限整数种子(实得 ${String(raw)})—— 不猜默认值`,
        archive: null,
      };
    }
    const seed = Math.trunc(raw);
    const nowMs = Number.isFinite(opts.nowMs) ? Math.trunc(opts.nowMs as number) : Date.now();

    /* 1 旧世界的可重建描述(**必须**在重建之前取)。 */
    const snapshot = this.describeWorldForArchive();
    /* 2 归档(D-06)。失败只影响回执,不影响重建 —— 见本方法 docblock。 */
    const archived = this.archiveBeforeReset(seed, snapshot, nowMs);
    /* 3 重建。 */
    this.rebuildWorld(seed);

    const out: WorldResetResult = { applied: true, seed, archive: archived.archive };
    if (archived.error !== null) out.archiveError = archived.error;
    return out;
  }

  /**
   * 把旧世界交给归档口(★ D-06),**只负责回执**,不碰世界。
   *
   * 三种结果刻意分开(不许合并 —— 合并就是"把不确定说成确定"):
   *   1 没有 sink ⇒ `archive: null` + `error` 写明**没有库**;
   *   2 sink 抛错 / 回执没有 id ⇒ `archive: null` + `error` 写明原因;
   *   3 成功 ⇒ `archive: {id, seed, archived_at, bytes}`。
   *
   * ⚠️ 第 2 条的"回执没有 id"这一支不是洁癖:`net/actions/reset_world.ts` 的
   *    `resetEffect` 见到非空对象就回 `ARCHIVED` + `archiveId`,于是**空 id 会被
   *    当成一次成功的归档**广播出去(而回滚读口拿这个 id 什么也取不到)。
   *    这里拦住它,让"没有句柄"表现为**如实失败**。
   */
  private archiveBeforeReset(
    newSeed: number,
    snapshot: Uint8Array,
    nowMs: number,
  ): { archive: WorldArchiveReceipt | null; error: string | null } {
    const sink = this.archiveSink;
    if (sink === null) {
      return {
        archive: null,
        error: '本世界没有库:装配层没有给归档口(WorldSimOptions.archiveSink)⇒ 旧世界无法归档',
      };
    }
    try {
      const r = sink({
        roomId: this.roomId,
        /* ★ **旧世界**的种子 —— 此刻 `worldSeed` 还没被重建改写。 */
        seed: this.worldSeed,
        snapshot,
        nowMs,
        worldTick: this.frameCount,
        reason: `RESET_WORLD(seed ${newSeed})`,
      });
      if (r === null || typeof r !== 'object' || typeof r.id !== 'string' || r.id.length === 0) {
        return { archive: null, error: '归档口没有给出归档句柄(id 为空)⇒ 这份快照取不回来' };
      }
      const receipt: WorldArchiveReceipt = {
        id: r.id,
        seed: Number(r.seed),
        archived_at: Number(r.archived_at),
        bytes: Number(r.bytes),
      };
      /* ★ B / D-19 第 5 条:裁剪四件**原样上报**(块数 / 字节 / 原因 / 状态)。
         没裁过 ⇒ `trim` 键**缺席**(而不是写一个 `KEPT`)—— 见
         `WorldArchiveTrimReceipt` 的注释;从库里读回时它也在快照头里
         (`header.trim`),两份来源同一事实。 */
      if (r.trim !== undefined) receipt.trim = r.trim;
      return { archive: receipt, error: null };
    } catch (e) {
      return { archive: null, error: `归档失败:${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * 旧世界的**可重建描述**(D-06 的「可回滚快照」原料)。
   *
   * ## 字节格式(自描述,单遍可解)
   *
   * ```
   * [0,4)              magic 'WSA1'          —— 认出"这是我们自己的快照"
   * [4,8)              uint32 LE 版本 = 2
   * [8,12)             uint32 LE headerLen
   * [12, 12+headerLen) header JSON(UTF-8)
   * [12+headerLen, +4) uint32 LE chunkCount
   * 之后               chunkCount 段 `Chunk.serializeSnapshot()` 原始字节,
   *                    长度/坐标在 header 的 `chunks[]` 里(顺序 = 按 (cy,cx) 升序)
   * ```
   *
   * ## v2 头的**键序**(它本身就是判据的一部分)
   *
   * ```
   * version, roomId, seed, sizeCells, biome, frame, hourOfDay,
   * players, fluid, mobs, ground, chunks
   * ```
   *
   * - `players[]`:每项 `id, x, y, z, level, hp` —— **`hp` 在最后**,取玩家当前
   *   血量(`VitalsSystem` 的权威值)。v2 里 `hp` 是**必填语义**:解码器对缺 `hp`
   *   的 v2 头抛错(不拿等级/满血值凑一个 —— 那会让「回滚」变成「顺手改血量」)。
   * - `fluid`(**紧跟 `players` 之后**):`{ width, height, levels }`。
   *   `levels` 是**稀疏水位表**,只收 `amount > 0` 的格,按 `(y, x)` **升序**、
   *   不重复、整数(`FluidField.amount` 的原值)。升序/唯一是**判据**:同一份世界
   *   归档两次必须得到逐字节相同的字节(见 `archive.ts` 的 `ArchiveFluidField`)。
   *   干旱世界 ⇒ `levels: []`(空表,而不是省略这个键)。
   *
   * 其余键(世界身份 / 时钟 / 生物 / 掉落)与 v1 同义。
   * ⚠️ **键序死守**不是风格问题:v2 的 `fluid` 键或玩家里的 `hp` 一旦挪位,
   *   「同一份世界」的两次归档就会出两种字节,而「逐字节可比」正是回滚判据的
   *   基础 ⇒ 写入侧的键序必须与 `encodeWorldArchive` **逐键一致**。
   *
   * ## 为什么用 `Chunk.serializeSnapshot()` 而不是自己造一份地形编码
   *
   * 那是 `world/chunk.ts` **已有**的扩展快照(它的 docblock 明写「本地存档 /
   * 回滚用」),含打包单元 + 脏位图 + 台账 + 屋顶层 RLE。自己再写一份就是
   * 第二份地形序列化 —— 两份必然漂移,而且漂移发生在"回滚"这条**最少被走**
   * 的路径上(等到要用的时候才发现读不回来)。
   *
   * ## 内容裁到「重建得起来」为止
   *
   * header 里有:世界身份(`roomId` / `seed` / `sizeCells` / `biome`)、时钟
   * (`frame` / `hourOfDay`)、玩家(位置 + 等级 + **血量**)、流体水位、
   * 生物(种类/位置/血量)、地面掉落。
   * 地形是主体(字节数占 99%),所以走二进制段而不是塞进 JSON。
   *
   * ⚠️ **有大小上限**:`repo.ts` 的 `WORLD_ARCHIVE_MAX_BYTES`(1 MiB)。一个
   *    完全建满的 512×512 世界,光地形就 ~1 MiB(1024 chunk × 1144 B);
   *    超限时归档口会按 `world/archive.ts` 的规则**裁地形块**(它拒绝截断),
   *    而玩家血量与流体水位在「固定开销」里、不参与裁剪(见 `fitWorldArchive`)。
   */
  private describeWorldForArchive(): Uint8Array {
    const chunks = [...this.grid.chunks.values()]
      .slice()
      /* 顺序必须**确定性**:Map 的插入顺序取决于建造历史,两台机器上不同 ⇒
         同一世界归档出两种字节,而"逐字节可比"是回滚判据的基础。 */
      .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    const blobs = chunks.map((c) => c.serializeSnapshot());

    const players = [...this.playerIds].slice().sort().map((id) => {
      const b = this.physics.bodies.get(id);
      /* ★ v2:每项**最后**加 `hp`(玩家当前血量)。键序是逐字节可比的一部分,
         所以它必须排在 `level` 之后 —— 见方法头那段键序说明。 */
      const hp = this.vitals.get(id)?.hp ?? 0;
      return { id, x: b?.x ?? 0, y: b?.y ?? 0, z: b?.z ?? 0, level: this.levelOf(id), hp };
    });
    const mobs = this.mobHost.runtimes().map((rt) => ({
      id: rt.id, mobId: rt.def.id, x: rt.x, y: rt.y, z: rt.z, hp: rt.hp, maxHp: rt.maxHp,
    }));
    const ground = this.mobGround.map((g) => ({
      itemId: groundItemId(g), count: g.count, x: g.x, y: g.y,
    }));

    /* ★ v2 的稀疏水位表:只收 `amount > 0` 的格,按 `(y, x)` **升序**。
       双重循环写死 y 为外层 —— 这就是「升序」的实现,不是巧合。
       不收 0 水位:它与「不在表里」是同一件事,却白吃 1 MiB 的预算。 */
    const levels: [number, number, number][] = [];
    for (let y = 0; y < this.fluid.height; y += 1) {
      for (let x = 0; x < this.fluid.width; x += 1) {
        const amount = this.fluid.amountAt(x, y);
        if (amount > 0) levels.push([x, y, amount]);
      }
    }

    const header = {
      version: 2,
      roomId: this.roomId,
      /* ★ **旧世界**的种子:它决定"回滚到这一版"重放出来的是不是同一个世界。 */
      seed: this.worldSeed,
      sizeCells: this.sizeCells,
      biome: this.biomeName,
      frame: this.frameCount,
      hourOfDay: this.hourOfDay(),
      players,
      /* `fluid` **紧跟 `players`**(键序是逐字节可比的一部分,见方法头)。 */
      fluid: { width: this.fluid.width, height: this.fluid.height, levels },
      mobs,
      ground,
      chunks: chunks.map((c, i) => ({ cx: c.cx, cy: c.cy, bytes: blobs[i].byteLength })),
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));

    const bodyBytes = blobs.reduce((n, b) => n + b.byteLength, 0);
    const out = new Uint8Array(12 + headerBytes.byteLength + 4 + bodyBytes);
    const dv = new DataView(out.buffer);
    /* magic 用**逐字节赋值**:写成字符串会经 UTF-8 编码,长度未必是 4。 */
    out[0] = 0x57; /* W */
    out[1] = 0x53; /* S */
    out[2] = 0x41; /* A */
    out[3] = 0x31; /* 1 */
    dv.setUint32(4, 2, true);
    dv.setUint32(8, headerBytes.byteLength, true);
    out.set(headerBytes, 12);
    let off = 12 + headerBytes.byteLength;
    dv.setUint32(off, blobs.length, true);
    off += 4;
    for (const b of blobs) {
      out.set(b, off);
      off += b.byteLength;
    }
    return out;
  }

  /**
   * **内存重建**:同一个 `WorldSim` 实例,换成新种子的世界。
   *
   * ## 为什么是「同一实例、换子系统」而不是「new 一个 WorldSim」
   *
   * `RoomRuntime` 持有的是**这个对象**(`rtOpts.host = sim`),装配层还往它身上
   * 挂了两条闭包(赛局计分 sink / 睡眠读口)。换整个实例会让房间继续拿旧世界
   * 发号施令(位置投影、攻击、存档都写到已经没人推进的那一个上),而且**不会报错**
   * —— 那正是「谁持有世界」出现两个答案的那类缺陷。子系统是纯数据/纯算法,
   * 没有外部引用,换掉它们是**干净的**;见类头那段注释。
   *
   * ## 清的与留的(**这条界线就是本方法的契约**)
   *
   * ```
   * 清:世界世代 —— 地形 / 生物 / 掉落 / 时钟 / 房间识别 / 厨房 / 物流 /
   *                 Boss / 瞬态(料理 buff、活人泡泡、倒地、击退、喷射意图、
   *                 击杀账、DoT、对局运行时、地面物品)
   * 留:玩家世代 —— 玩家本身、装备档案(`profiles`)、等级/经验(`progresses`)、
   *                 打盹玩法(`afkRuns`)、连接态打盹标记(`afkPlayers`)、
   *                 出生点(`spawnPoints`)、注入的归档口与接线 sink
   * ```
   * 「留在世界里的玩家数据」是**玩家的**,不是世界的世代 —— 顺手清掉它
   * (等级/装备)是**破坏玩家数据**的超范围动作,不属于"重建世界"。
   */
  private rebuildWorld(seed: number): void {
    /* 1 随机流:两条**一起**换 —— `rng` / `combatRng` 分离的不变量不能因为重置
       丢掉(丢掉的后果是"重置后攻击会扰动远处生物",同 `WorldSimOptions.combatRng`)。
       战斗流用构造期既有默认值 `0xc0ffee` 当盐(xor),不新造数值常量。 */
    this.rng = mulberry32(seed);
    this.combatRng = mulberry32((seed ^ 0xc0ffee) >>> 0);
    this.worldSeed = seed;

    /* 2 子系统**整件重建**(顺序与构造器逐行一致:地形 → 物理 → 电路 → 生物)。
       ⚠️ `carry` 必须在 `physics` **之后**建:`carryActors()` 在调用时抓
          `physics.bodies` 那张表,先建会绑到刚被丢掉的那张上 ⇒ 举投系统
          从此看不见任何人(表现为"扛不动了",不报错)。 */
    this.grid = new WorldGrid();
    this.fluid = new FluidField(this.sizeCells, this.sizeCells);
    this.wiring = new SignalGraph(this.sizeCells, this.sizeCells);
    this.installWorldEnv();
    this.aoi = new AoiManager();
    this.spawner = new MobSpawner();
    this.physics = this.makePhysicsWorld();
    this.carry = new CarrySystem(this.carryActors());
    this.bus = new EventBus();
    this.mobHost = new MobHost(this.mobWorldAdapter(), { bus: this.bus, rng: this.rng });
    this.bossRaid = new BossRaidRuntime();
    /* vitals 换新 ⇒ 玩家"满血 + 非倒地"是**结构上**的结果(register 恒满血),
       不靠"把 hp 写回去"那种漏一个字段就静默失效的写法。 */
    this.vitals = new VitalsSystem();

    /* 3 世界世代的账本与派生视图清零(逐项点名,不做"清空一切")。 */
    this.mobGround = [];                 /* 地面掉落 */
    this.mobPlayers = [];
    this.players = [];
    this.unknownMobs.length = 0;
    this.mobOrdinals.clear();            /* 实例序号从 #1 重来(见 mobOrdinals 注释) */
    this.spawnBudget = 0;
    this.lastMobTicks = [];
    this.mobErrors = 0;
    this.lastBossTick = { ticked: 0, phaseSwitched: [], stunEnded: [] };
    /* 流体场整件换新(4657)⇒ 上一帧的「延后格数」对新场没有意义,清零。 */
    this.lastFluidDeferredCells = 0;
    this.lastLogisticsTick = {
      beltMoves: 0, sorterMoves: 0, armGrabs: 0, armFeeds: 0, drillOres: 0,
      exitsDelivered: 0, exitsDropped: 0, exitsHeld: 0,
    };
    this.logisticsBelts.clear();
    this.logisticsSorters.clear();
    this.logisticsArms.clear();
    this.logisticsDrills.clear();
    this.partyRun = null;
    this.partyContest = null;
    this.rushRun = null;
    this.rushTicked = 0;
    /* ★ WS-FND-120:动作层的瞬态(队伍归属 / 哨台锁存 / 结算回执 / 播报下发计数)
       必须与它对局的运行时一起清 —— 留着上一局的「谁是哪队」会让新一局一开始
       就有队伍,而那种错误不报错、只错归属。 */
    this.partyTeams.clear();
    this.refereeDeskLatch = '';
    this.lastPartySettlement = null;
    this.lastPartyBroadcasts = [];
    this.partyBroadcastCount = 0;
    this.lastPartyRewards = { exp: 0, items: 0, players: 0 };
    this.rushDeliveryCount = 0;
    this.lastRushSettlement = null;
    this.dozeEntryCount = 0;
    this.lastPartyTick = { partyTicked: 0, afkTicked: 0, afkDew: 0, events: [] };
    /* 瞬态:喷射意图窗口 / 翻炒意图窗口 / 击退窗口 / 倒地 / 活人泡泡 / 料理 buff / DoT /
       厨房锅内状态(含 `fireOut` —— 一份"炉火已浇灭"跨世代留着就是错的)。 */
    this.sprayUntil.clear();
    this.tendUntil.clear();
    this.knockbacks.clear();
    this.downedStates.clear();
    this.liveBubbles.clear();
    this.foodBuffs.clear();
    this.dots.clear();
    this.dotSeq = 0;
    this.kitchens.clear();
    this.lastCookReport = { cooked: 0, lastItemId: 0, fedTotal: 0, potCount: 0 };
    /* ★ 击杀账必须清:`mobOrdinals` 重置后新世界的实例 id 又从 `#1` 开始,
       账本里旧世代那条 `mob_sheep#1` 会让**新世界里第一只羊的击杀被静默吞掉**
       (经验不到账、不报错)。这是"清账"与"重置序号"必须成对的原因。 */
    this.killLedger.reset();
    this.pendingLevelUps.clear();
    this.lastKillSettle = null;
    /* ★ WS-FND-98:掉落与击杀结算同生共死 —— 重置后 `lastKillSettle === null`
       而掉落还留着上一局的东西,读的人会以为「新世界刚掉过」。 */
    this.lastMobDrops = [];
    this.lastRevive = null;
    this.killSettleCount = 0;
    this.totalExpGranted = 0;
    this.lastHits = [];
    this.hitCount = 0;
    this.warnsChecked = 0;
    /* 房间效果是**地形派生**的,地形没了就重算(`forgeUnlockedIds` 同理)。 */
    this.roomEffects.clear();
    this.forgeUnlockedIds.clear();
    /* 房间识别:结果与脏标记一起重来(新世界里还没有任何一格地形)。 */
    this.lastRoomScan = [];
    this.lastRoomCells = [];
    this.lastRoomScanArea = 0;
    this.roomScanCount = 0;
    this.roomsDirty = true;
    /* 蓝图接力与它的落位基准 */
    this.relay = null;
    this.relayOrigin = { x: 0, y: 0 };
    this.relayPlacedCount = 0;
    /* ★ WS-FND-77 / D-19:四系统与百货摊位的状态是**世界世代**的一部分 ——
       一起换代。漏掉 `roomSystemsState` 的后果是「重置后牧场还在按旧动物结算、
       537 陈列还挂着上一局的冠名」;漏掉 `stallStock` 是「重置后摊位库存不刷新」。
       两者都不报错,只是跨世代残留(与 `killLedger` / `mobOrdinals` 同一纪律)。 */
    this.roomSystemsState = createRoomSystemsState();
    this.stallStock = {};
    /* ★ 幂等键表**不再单独清**:三把键(牧场日 / 炼金订单 / 百货订单)都住在
       `roomSystemsState.settled` 里,而它在上面刚被换成一张空台账 ⇒ 换代即清空。
       `roomDayIndex` 是键的一维,同样归零(否则新世界第一天被当成旧世界的重放)。 */
    this.dayFraction = 0;
    this.roomDayIndex = 0;
    this.lastRoomSystems = null;
    this.lastRanchDrop = { dropped: [], skipped: [] };
    /* 天气**不重置**:它是外部输入(天气系统/许愿喷泉 528),不是世界世代的账本;
       重置它会让「刚报过 STORM 的房间重置后突然放晴」—— 那是一个没人下过的指令。 */

    /* 4 ★ 钟点回 06:00 —— D-07 把"游戏时间 0 帧 = 06:00"定死,而时间是由
       `frameCount` **派生**的(不存累加器,见 `hourOfDay` 的注释)⇒ 重建世界
       就是让帧序归零。这也是"喷射意图窗口"之类以帧序计的窗口一起失效的原因。 */
    this.frameCount = 0;

    /* 5 玩家**保留**:回出生点、**满血**、非倒地。
       `addPlayer` 一次做全四件事(物理刚体 / AOI / `playerIds` / `vitals.register`),
       所以这里只调它 —— 不另写一份"重生玩家"的实现(那会是第二份注册逻辑,
       漏掉 AOI 或 vitals 就是"看不见"或"打不掉血")。

       ★ 但 `vitals.register` 给的上限是**构造缺省值**(`PLAYER_BASE_HP` = 100),
       与等级无关;而等级档案是**玩家的**、跨世代保留(它不在本方法清空的那批里)。
       ⇒ 不补这一步,5 级玩家重置后上限被抓回 100 且**不报错**(正是 W1 的形态)。
       补法与 `restoreFromProfile` 第 3 步 / `applyRestore` 的 (2) **同一口径**:
       `maxHpForLevel`(上限的唯一算子)+ `syncMaxHp`(vitals 唯一写入口)抬上限;
       再 `revive` 让 `hp` 跟到新上限(`syncMaxHp` 是策略 C:只钳不补)。
       ⚠️ 这里**不写** `100 + 15*(lv-1)`(那是第二份派生公式,正是 W1 的成因)。 */
    const keep = [...this.playerIds].sort();
    this.playerIds.clear();
    for (const id of keep) {
      const sp = this.spawnPoints.get(id)
        ?? { x: this.sizeCells / 2, y: this.sizeCells / 2 };
      this.addPlayer(id, sp.x, sp.y);
      /* 等级 → 上限(复用唯一算子)+ 满血(复用 vitals 的唯一写入口)。 */
      const derived = this.maxHpForLevel(id, this.levelOf(id));
      if (derived !== null) this.syncMaxHp(id, derived);
      this.vitals.revive(id);
    }
    this.syncPlayers();
  }

  /**
   * 造一个绑定到**当前** `this.grid` / `this.sizeCells` 的物理世界。
   *
   * 为什么是方法:构造器与 `rebuildWorld` 都要它。抄两遍就是两份实现 ——
   * 日后有人在其中一处补一条 terrain 投影(例如 `wireAt`),另一处不会跟着改,
   * 而表现是**静默**的(与本仓踩过的"水穿墙"同族:两套影子状态不同步)。
   *
   * ⚠️ 里面的闭包读的是**调用时**的 `this.grid`(不是构造时抓的引用),
   *   所以重建时"先换 grid 再调本方法"与"先调本方法再换 grid"都安全 ——
   *   但仍按构造器的顺序写,免得下一个人以为顺序有讲究。
   */
  private makePhysicsWorld(): PhysicsWorld {
    return new PhysicsWorld({
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
      /* `afk` 是真值投影,不是字面量 —— 这一行曾是本仓第 101 条陷阱:
         写死 `false` ⇒ `aoi.setPlayers` 里 `filter((p) => !p.afk)` 永不生效
         ⇒ **打盹玩家仍提供 AOI 唤醒能量**(手册 §2.4 明确说打盹不维持生态模拟)。
         注意 `bodies` 里混有生物,`afkPlayers` 只含玩家 ID,故生物恒 false —— 正确。 */
      list.push({ id: b.id, x: b.x, y: b.y, afk: this.afkPlayers.has(b.id) });
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
     *
     * ## ⚠ `wearing` / `heldItem` 必须从 `profiles` 投影,不能写字面量 `[]`
     *
     * 这里原先是 `wearing: []`。那是**把派生视图当权威用**:本方法每帧执行,
     * 于是装配层经 `setMobPlayers` 灌入的装备**下一次 tick 就被抹成裸装**
     * (实测:灌 `[712]` 后立刻攻击 76 伤害,`tick()` 一次后掉回 10)。
     * 位置同样由本方法每帧重建,但位置的权威**本来就在** `physics.bodies`,
     * 所以那是正确的投影;装备的权威不在物理层,照抄这个形状就丢了状态。
     * ⇒ 装备改为从 `profiles` 取(权威),`afk` 仍取 AOI 视图。
     */
    this.mobPlayers = this.players
      .filter((p) => this.playerIds.has(p.id))
      .map((p) => {
        const prof = this.profiles.get(p.id) ?? EMPTY_PROFILE;
        return {
          id: p.id,
          x: p.x,
          y: p.y,
          z: 0,
          facingDeg: 0,
          afk: p.afk,
          heldItem: prof.heldItem,
          wearing: prof.wearing,
          playingInstrument: false,
        };
      });
  }

  /** 注册一只生物:物理刚体 + AOI 记录 + 刷怪计数 + **宿主登记**。 */
  addMob(id: string, biome: string, x: number, y: number): void {
    this.physics.spawn(id, { x, y, z: 0 });
    this.aoi.registerMob(id, x, y);
    this.spawner.add(biome, 1);
    /* 登记到宿主 —— 漏了这一步的表现是「AOI 唤醒了它,但宿主不认识,
       于是安静地跳过」:生物不动、不报错,像世界空了。 */
    const def = mobDefOf(id);
    if (def) this.mobHost.addMob(id, def, x, y, { anchorX: x, anchorY: y });
    else this.unknownMobs.push(id);
  }

  /**
   * 某物种的实例序号**水位**(已经发到几号;从没发过 = 0)。
   *
   * 为什么必须有一个读口:序号是「新实例**永不复用**旧 id」的唯一保证
   * (`mobs/spawner.ts` 的 id 两层规则 + 本类的 `mobOrdinals`),而这条保证是
   * 「击杀账不会被新怪继承」的前提。恢复世界那条路上水位是**补写**的
   * (`bumpMobOrdinalForRestored`),没有读口就没法判定补写是否发生
   * —— 判据见 `tests/WS-FND-102`(修前读到的恒为 0)。
   */
  mobOrdinalWatermark(speciesId: string): number {
    return this.mobOrdinals.get(speciesId) ?? 0;
  }

  /**
   * 把 `mobOrdinals` 的水位**推进**到某个已恢复实例的序号(只进不退)。
   *
   * ## 为什么需要它(`applyRestore` 专用)
   *
   * `applyRestore` 先跑 `rebuildWorld`,而它把 `mobOrdinals` 清成空
   * (新世界的序号"从 #1 重来",见那里的注释);接着第 5 步按**归档 id** 把生物
   * 放回来。两者叠在一起就是:世界里明明有 `mob_boar#3`,计数器却是 0
   * ⇒ 下一次刷怪发的号是 `#1`…`#3` —— 撞上已恢复的实例。
   *
   * 撞号的后果**不抛错、不告警**:`addMob` 用同一个 id 再注册一次,`physics.spawn`
   * 覆盖刚体、`mobHost.addMob` 换一条**满血、FSM 归零**的运行时;而 `killLedger`
   * 按实例 id 去重 ⇒ 新那只(以及后面同号的)击杀**不再结算经验**。
   *
   * ## 为什么用回环校验而不是直接切字符串
   *
   * id 的生成规则全仓只有一处(`mobInstanceId`)。这里先按分隔符取尾段数字,
   * 再用 `mobInstanceId(species, n) === id` **回环**确认 —— 只有恰好还原成同一个
   * id 才认。于是「物种 id 里自带 `#`」「尾段不是正整数」「`#0`」这些脏输入
   * 都**不会**把水位推到别处(推错水位同样会撞号,而且更隐蔽)。
   */
  private bumpMobOrdinalForRestored(instanceId: string): void {
    const sep = instanceId.lastIndexOf(MOB_INSTANCE_SEP);
    if (sep < 0) return;
    const ordinal = Number(instanceId.slice(sep + 1));
    if (!Number.isInteger(ordinal) || ordinal < 1) return;
    const species = mobSpeciesId(instanceId);
    if (mobInstanceId(species, ordinal) !== instanceId) return;
    const cur = this.mobOrdinals.get(species) ?? 0;
    if (ordinal > cur) this.mobOrdinals.set(species, ordinal);
  }

  /**
   * 注册时 `MOB_BY_ID` 里查不到的 ID。
   *
   * 不静默忽略:调用方传了错 ID(拼写、用了未登记的字符串)时,
   * 生物会「存在但不行为」—— 这是最难查的一类,因为它看起来像
   * 「这个生物的设计就是不动的」。收集起来供断言。
   */
  readonly unknownMobs: string[] = [];

  /**
   * 给生物 AI 用的玩家视图(供 `MobWorld.players()`)。
   *
   * ## 它同时是「装配层灌装备」的入口(US2 起)
   *
   * 传入项里 `wearing` / `heldItem` 会被写进**权威档案** `profiles`,
   * 而位置 / `afk` 只是本帧视图(它们的权威分别是 `PhysicsWorld` / 房间成员态)。
   *
   * ⚠ 历史坑:早期版本只赋 `this.mobPlayers = players`,而 `syncPlayers()`
   * 每帧用 `wearing: []` 重建该字段 ⇒ 灌进来的装备**下一帧就被抹掉**。
   * 现在装备写进 `profiles`,`syncPlayers()` 反向从 `profiles` 取,
   * 于是「灌一次就能跨帧存活」(由 WS-10 `生产接线15` 钉住)。
   */
  setMobPlayers(players: WorldPlayer[]): void {
    this.mobPlayers = players;
    /* 把装备类字段收进权威档案。位置不在这里收 —— 它归 `physics.bodies`。 */
    for (const p of players) {
      this.profiles.set(p.id, {
        wearing: Array.isArray(p.wearing) ? [...p.wearing] : [],
        heldItem: typeof p.heldItem === 'number' ? p.heldItem : 0,
      });
    }
  }

  /**
   * 设置单个玩家的装备档案(装配层更细粒度的入口)。
   *
   * 与 `setMobPlayers` 的区别:后者是**整表覆盖**(顺带刷新本帧 AI 视图),
   * 本方法只动一名玩家的装备,不影响 `mobPlayers` 里的其他字段。
   * 网络层「装备变更报文」应走这条,而不是重建整张表。
   */
  setProfile(playerId: string, patch: Partial<PlayerProfile>): void {
    const cur = this.profiles.get(playerId) ?? EMPTY_PROFILE;
    this.profiles.set(playerId, {
      wearing: patch.wearing !== undefined ? [...patch.wearing] : cur.wearing,
      heldItem: patch.heldItem !== undefined ? patch.heldItem : cur.heldItem,
    });
    /* 同步到 AI 视图,免得生物看见的装备比战斗用的晚一帧。 */
    const inView = this.mobPlayers.find((p) => p.id === playerId);
    if (inView !== undefined) {
      const next = this.profiles.get(playerId)!;
      inView.wearing = next.wearing;
      inView.heldItem = next.heldItem;
    }
  }

  /** 某玩家的装备档案(只读;无记录返回空档案 —— 不返回 undefined,少一层可选链)。 */
  profileOf(playerId: string): PlayerProfile {
    return this.profiles.get(playerId) ?? EMPTY_PROFILE;
  }

  /**
   * **同步一名玩家的打盹态**(房间成员态 → 模拟层)。
   *
   * ## 为什么是「房间推」而不是「模拟层拉」
   *
   * 打盹的**权威在房间**(`room.ts` 的 `MemberPresence` / `afkSinceMs`):
   * 只有房间知道谁断线、谁切了后台、谁超时 30 分钟。
   * 模拟层若自己去猜(例如按「多久没动」推断),就会造出**第二份判定实现**,
   * 而两份实现的分歧不会报错 —— 这正是本仓反复出现的「两份实现互相顶着」。
   * ⇒ 故本方法是**单写入口**,由 `RoomRuntime.setAfk` 单向推送。
   *
   * ## 与 `WorldSaveHost` 的关系(装配纪律,务必一起看)
   *
   * ⚠️ 本方法若不写进 `net/room.ts` 的 `WorldSaveHost` 接口声明,
   * 就会被 `index.ts` 的 `createHost` **返回类型标注结构性裁掉** ——
   * 即 `const h: WorldSaveHost = sim` 之后 `h.setPlayerAfk` 在类型上不存在,
   * 房间侧 `typeof host.setPlayerAfk` **恒假**(编译期,不是运行期)。
   * 这是 task-70 实测到的形态,见 `index.ts` 的 `createHost` docblock。
   *
   * ## 返回值的含义(与 `restoreFromProfile` 同一纪律)
   *
   * 返回**是否发生变化**。调用方应断言它而不是忽略 ——
   * 忽略会让「同步静默无效」与「同步成功」不可区分(陷阱 89)。
   * 重复推同一状态返回 `false`(幂等),这是**刻意**的:
   * `setAfk` 每帧可能被调,不该每次都被当成一次变更。
   */
  setPlayerAfk(playerId: string, afk: boolean): boolean {
    /* 未登记的玩家不进集合:否则 `afkPlayers` 会积累已离开的 ID,
       且 `aoi` 列表里本来就没有他,集合里的残留没有任何消费者。
       这与 `settleKill` 「只给范围内的玩家建档」同一取舍。 */
    if (!this.playerIds.has(playerId)) return false;
    const had = this.afkPlayers.has(playerId);
    if (had === afk) return false;
    if (afk) this.afkPlayers.add(playerId);
    else this.afkPlayers.delete(playerId);
    /* 立刻重算派生视图,免得消费者看到上一帧的 afk。
       为什么不能等下一帧 `syncPlayers()`:`aoi` 的唤醒判定发生在
       **慢帧**(2Hz),而 `syncPlayers()` 每帧都跑 —— 若不在这里刷新,
       「刚打盹」的玩家在最多一帧内仍提供唤醒能量。一帧的窗口很小,
       但让它变成**确定性的零帧**几乎不要成本。 */
    this.syncPlayers();
    return true;
  }

  /**
   * 某玩家当前是否被打盹标记(只读)。
   *
   * 消费者(`aoi` / `behaviors` / `progression`)一律读**投影**里的 `afk`,
   * 本方法是给**断言与诊断**用的:没有它,「同步口没接上」只能靠
   * 间接观察投影来判定,而投影与真值可能各自正确却不同源。
   */
  isPlayerAfk(playerId: string): boolean {
    return this.afkPlayers.has(playerId);
  }

  /** 当前打盹玩家数(诊断用;与 `room.afkPlayerCount()` 同口径但**不含**超时阶段)。 */
  get afkPlayerCount(): number {
    return this.afkPlayers.size;
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
  vitals = new VitalsSystem();

  /** 最近一次慢帧的命中结果(诊断用)。 */
  lastHits: MobHitResult[] = [];
  /** 累计命中次数。 */
  hitCount = 0;
  /** 累计检查过的预警几何数(诊断用:为 0 说明 AI 从没产出过预警)。 */
  warnsChecked = 0;

  /* ══════════════════ D1 / D2 / D3 / D5 + 烹饪字段消费(2026-11-18)══════════════════
   *
   * 这一段的四个可观测字段都是**计数器/开关**,不是派生态:
   * 「接了但这一帧没发生」与「根本没接」在断言里必须可区分
   * (与 `lastSaveReport` / `lastAttackReport` 同一种取舍)。
   */

  /**
   * **PvP 开关**(★ D3)。
   *
   * 缺省 **关** —— 与修前语义等价:那时玩家之间**根本没有入口**,
   * 所以「关」不会改变任何既有行为;而缺省开会让每个已有房间一上线就变成可互殴。
   * 唯一的判定在 `damage.ts` 的 `pvpVerdict`(本字段只是它的输入)。
   */
  pvpEnabled = false;

  /** 上一慢帧被**视线**挡下的打击数(D2 的可观测出口)。 */
  lastLosBlocked = 0;
  /** 累计被视线挡下的打击数(单调,防「一次伪造」)。 */
  losBlockedTotal = 0;
  /** 上一慢帧落地的致盲次数(D5)。 */
  lastBlindsApplied = 0;
  /** 上一慢帧落地的 Boss 特殊效果(便于断言「真的发生了哪一种」)。 */
  lastBossEffects: { bossId: string; playerId: string; effect: string }[] = [];

  /**
   * 开关 PvP(世界侧唯一写入口)。
   *
   * @returns 开关后的状态(便于调用方/断言读回,而不是自己记一份)
   */
  setPvp(on: boolean): boolean {
    this.pvpEnabled = on === true;
    return this.pvpEnabled;
  }

  /**
   * 玩家**视野半径**(D5 的「视野」那一半)。
   *
   * 基准取 `AOI_WAKE_DISTANCE`(AOI 唤醒半径 = 客户端可见范围的事实基准),
   * 致盲时乘 `BLIND_VIEW_MUL`。**不新造第二个半径常量** ——
   * 两处各写一个数,日后必然一个改了一个没改。
   */
  viewRadiusOf(playerId: string): number {
    const base = AOI_WAKE_DISTANCE;
    return this.vitals.blindOf(playerId) > 0 ? base * BLIND_VIEW_MUL : base;
  }

  /**
   * 烹饪 `defFlat` 的**消费点**:把它折算成「生物打玩家」的伤害乘区。
   *
   * ## 为什么用 `ARMOR_K` 那条曲线,而不是 `1 - defFlat/100`
   *
   * 本仓「玩家打生物」的减伤曲线是 `ARMOR_K / (ARMOR_K + DEF)`(`damage.ts` 第 6 步)。
   * 生物打玩家若另造一条线性公式,同一个「防御 +22」在两个方向上会是两个不同的
   * 减伤率 —— 那正是本仓反复点名的「两份实现」。⇒ 复用同一条曲线:
   * `mul = ARMOR_K / (ARMOR_K + defFlat)`,`defFlat = 0` 时恰为 1.0(与修前同值)。
   * `defFlat` 来自 `buffsOf(playerId)`(料理聚合的**唯一**出口)。
   */
  mobDamageMulFor(playerId: string): number {
    const defFlat = this.buffsOf(playerId).defFlat;
    if (!Number.isFinite(defFlat) || defFlat <= 0) return 1;
    return ARMOR_K / (ARMOR_K + defFlat);
  }

  /**
   * Boss 技能对玩家的**特殊效果**表(D3)。
   *
   * ## 每一行都有内容出处(不新造数值)
   *
   * - `boss_jelly_king` P1:内容写着「环形果冻波,**击退并减速**」⇒ `KNOCKBACK`
   * - `boss_jelly_king` P3:内容写着「巨口**吸气**」⇒ `STUN`(被吸住 = 动不了)
   * - `boss_fox_kitsune` P2:内容写着「地面留下**迷魂花阵**」⇒ `BLIND`
   * - `boss_scorpion_pharaoh` P2:内容写着「黄金**沙暴**」⇒ `BLIND`
   *
   * ## 时长一律取自内容层的 `warnSec`
   *
   * 效果持续 = 该招式预警几何自己的 `warnSec`(`phases.ts` 给的值),
   * 不在这里另写「眩晕几秒」。内容改招式时长,效果时长跟着改,不会漂。
   */
  private static readonly BOSS_PHASE_EFFECTS: readonly {
    bossId: string;
    phase: number;
    effect: 'KNOCKBACK' | 'STUN' | 'BLIND';
  }[] = [
    { bossId: 'boss_jelly_king', phase: 0, effect: 'KNOCKBACK' },
    { bossId: 'boss_jelly_king', phase: 2, effect: 'STUN' },
    { bossId: 'boss_fox_kitsune', phase: 1, effect: 'BLIND' },
    { bossId: 'boss_scorpion_pharaoh', phase: 1, effect: 'BLIND' },
  ];

  /** 查某个 Boss 当前阶段的特殊效果;没登记 ⇒ `null`(只有伤害)。 */
  bossEffectOf(bossId: string, phase: number): 'KNOCKBACK' | 'STUN' | 'BLIND' | null {
    for (const r of WorldSim.BOSS_PHASE_EFFECTS) {
      if (r.bossId === bossId && r.phase === phase) return r.effect;
    }
    return null;
  }
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
    this.lastLosBlocked = 0;
    this.lastBlindsApplied = 0;
    this.lastBossEffects = [];
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
        /* ★ D4:放**生物的元素归属**(内容表 `MOB_ELEMENT_BY_ID` 的唯一出处)。
           没登记的生物是 `NONE` ⇒ 抗性系数 1.0 ⇒ 与修前逐字段相同。 */
        strikes.push({ attackerId: t.id, attackerLevel: rt.def.level, warn: w, element: this.elementOfAttacker(t.id) });
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

    /* ── 第三条通道:Boss 技能(D3)──
       `phases.skillWarnGeoms` 早就按阶段产出了 Boss 的**地面几何**
       (半径/角度/时长全是内容值),但全仓没有任何玩家侧结算 ——
       Boss 的招式等于对着空气放。这里把它并进同一条结算路径
       (而不是另写一套命中判定:那样「玩家被什么打中」会有两份口径)。 */
    for (const s of this.bossStrikes(players)) strikes.push(s);

    /* ── 事件型**致盲**(D5)──
       `tanuki_ambush` 是**零伤害**事件,故不进 `strikes`(否则会污染
       `hitCount`/`lastHits`,玩家会看到「被打中 0 点」)。它单独结算成状态。 */
    const blindEvents = collectEventBlinds(
      this.mobHost.frameEmits,
      (id) => {
        const rt = this.mobHost.runtimeOf(id);
        return rt ? { x: rt.x, y: rt.y } : null;
      },
    );
    for (const b of blindEvents) {
      for (const p of players) {
        if (!warnHitsPlayer(b.warn, p.x, p.y, p.z)) continue;
        this.vitals.applyBlind(p.id, b.sec);
        this.lastBlindsApplied += 1;
        this.bus.emit('player_blinded', { playerId: p.id, by: b.attackerId, sec: b.sec }, b.attackerId);
      }
    }

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
      const lv = rt ? rt.def.level : this.bossLevelOf(h.attackerId);
      /* ── ★ D2:视线遮挡 ──
         `resolveStrikes` 只做**几何**判定(圈里/锥里),它不知道中间有没有墙。
         这里在**扣血之前**过一次射线:挡下 ⇒ 本次不结算(计数留痕)。
         为什么放在这里而不是 `resolveStrikes` 内部:那个函数是纯几何(它拿不到
         `WorldGrid`),把地形塞进去会让它同时依赖两件事,而它的断言全在 2×2 假
         地形上早就写好了。 */
      const from = this.attackerPosOf(h.attackerId);
      const to = players.find((p) => p.id === h.playerId);
      if (from !== null && to !== undefined &&
          losBlocked(from.x, from.y, to.x, to.y, (cx, cy) => this.grid.isSolidAt(cx, cy))) {
        this.lastLosBlocked += 1;
        this.losBlockedTotal += 1;
        continue;
      }
      /* ★ D4 抗性 + 烹饪 `defFlat`(护甲曲线)两个乘区进同一次结算:
         - `element` → `vitals.elementResistOf` 在 `applyHit` 内部折算;
         - `defFlat` → `mobDamageMulFor` 作为等级伤害的乘数。 */
      const res = this.vitals.applyHit(
        h.attackerId,
        h.playerId,
        lv,
        this.mobDamageMulFor(h.playerId),
        h.distance,
        DEFAULT_UNARMED_KNOCKBACK,
        this.elementOfAttacker(h.attackerId),
      );
      if (res.applied > 0) {
        applied.push(res);
        this.hitCount += 1;
        /* ★ 第六轮实测 P1(反伤整段丢弃):728 反伤甲把承伤折算回**攻击者生物**。
           修前这条路上一点反伤都没有 —— 玩家穿 728 挨打,怪毫发无损。
           数值口径与 computeDamage 第 7 步一致(reflectFrom:承伤 × 反伤倍率),
           施加走 damageMob(生物伤害的唯一收口 ⇒ 反伤也能击杀,击杀照常结算)。
           ⚠️ 只对**生物**施加:damageMob 对 Boss 返回 null(它们不在 MOB_BY_ID),
              那是既有边界,不在这里补第二套。
           判据:tests/WS-FND-118 的 FND118-6(负对照:不穿 728 ⇒ 生物 HP 不动)。 */
        const reflectMul = combatantStats(
          this.levelOf(res.playerId), [...this.wearingOf(res.playerId)],
          foodCombatInput(this.buffsOf(res.playerId)),
        ).reflectMul;
        const refl = reflectFrom(reflectMul, res.applied);
        if (refl.reflectDamage > 0 && this.mobHost.runtimeOf(h.attackerId) !== null) {
          this.reflectTotal += refl.reflectDamage;
          /* 反伤的方向 = 玩家 → 生物(供生物 AI 的正面/背面判定)。 */
          const deg = from !== null && to !== undefined
            ? (Math.atan2(from.y - to.y, from.x - to.x) * 180) / Math.PI
            : 0;
          this.damageMob(h.attackerId, refl.reflectDamage, DamageKind.PHYSICAL, deg);
        }
        /* ★ D-09(owner,2026-11-16):受击击退 = `min(2, 实际伤害 / 20)` 格,方向**远离攻击者**。
           裁决给了数值(伤害折算 + 上限 2 格)⇒ 按它接,且**位移仍走 `applyKnockback`**
           (慢帧推 + 搬家窗口),不写速度。
           ⚠️ 若这条把 `WS-10` 的救援判据打红:**按 D-09 重钉那条判据**,不许改回 no-op。 */
        const pushCells = Math.min(
          WorldSim.KNOCKBACK_MAX_CELLS,
          res.applied / WorldSim.KNOCKBACK_DAMAGE_PER_CELL,
        );
        if (from !== null && pushCells > 0) this.applyKnockback(res.playerId, from.x, from.y, pushCells);
        /* ── ★ D1:击退**写回 PhysicsBody**(`physics.applyImpulse`)──
           与上一段 `applyKnockback` 不是同一件事的两份实现,而是**两个分量**:
           ```
           水平位移   applyKnockback → 位置(慢帧两段推 + 搬家窗口)
           纵向速度   applyImpulse    → 刚体 vz(物理步积分,`ensureFinite` 兜 NaN)
           ```
           ⚠️ **为什么是纵向而不是水平**:D-09 已把「水平位移」定成
           `min(2, 伤害/20)` 格并逐字钉死(`WS-FND-53` FND53-1/3 实测 2.0000)。
           若把内容层的击退量**再**加到水平速度上,物理步会把刚体多推约 0.26 格
           (实测 2.2571)—— 那是**同一件事被算两遍**,不是新功能。
           ⇒ 纵向分量取内容层的击退量:玩家的「被打飞一下」由它表达,
             水平预算仍只由 D-09 那一条公式花。
           量纲:内容给的是**格/秒**,`applyImpulse` 里 `Δv = J / m`,
           故这里乘 `mass` 让 Δv 恰为内容值。 */
        if (res.knockbackPerSec > 0) {
          const body = this.physics.bodies.get(res.playerId);
          if (body !== undefined) {
            /* ★ WS-FND-98:质量一律经 `physics.safeMass` 取 —— `NaN` / `±Infinity` /
               0 / 负数 / 小数被拒绝,退化为基准值 1。修前这里是一份**手写**兜底
               (`body.mass > 0 ? body.mass : 1`),它恰好兜住 `NaN`(`NaN > 0` 为 false)
               却没兜住 `+Infinity`(`Δv = J / Infinity = 0`,不炸但静默失效);
               归一规则现在全仓只有 `safeMass` 一个入口。 */
            const m = safeMass(body.mass);
            this.physics.applyImpulse(res.playerId, 0, 0, res.knockbackPerSec * m);
          }
        }
        /* ── ★ D3:Boss 技能对玩家的特殊效果 ──
           时长取该招式预警几何自己的 `warnSec`(内容值)。`KNOCKBACK` 已由上面
           两段落地,这里只处理「动不了」与「看不见」。 */
        const bossEffect = this.bossEffectOf(h.attackerId, this.bossPhaseOf(h.attackerId));
        const warnSec = this.bossWarnSecOf(h.attackerId);
        if (bossEffect === 'STUN' && warnSec > 0) {
          this.vitals.applyStun(res.playerId, warnSec);
          this.lastBossEffects.push({ bossId: h.attackerId, playerId: res.playerId, effect: 'STUN' });
        } else if (bossEffect === 'BLIND' && warnSec > 0) {
          this.vitals.applyBlind(res.playerId, warnSec);
          this.lastBossEffects.push({ bossId: h.attackerId, playerId: res.playerId, effect: 'BLIND' });
        } else if (bossEffect === 'KNOCKBACK') {
          this.lastBossEffects.push({ bossId: h.attackerId, playerId: res.playerId, effect: 'KNOCKBACK' });
        }
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

  /**
   * 某个攻击者的**元素归属**(D4)。生物查内容表;Boss 没有元素表 ⇒ `NONE`。
   *
   * 为什么 Boss 不「顺手分配一个元素」:元素矩阵是 6×6 的克制关系,
   * 凭空赋值等于凭空发明平衡(与 `MOB_ELEMENT_BY_ID` 的注释同一裁决)。
   */
  private elementOfAttacker(attackerId: string): string {
    const rt = this.mobHost.runtimeOf(attackerId);
    const defId = rt?.def.id ?? attackerId;
    const el: Element = MOB_ELEMENT_BY_ID.get(defId) ?? Element.NONE;
    return el;
  }

  /** Boss 的技能几何(第三条 strike 通道,D3)。没有在场 Boss ⇒ 空数组。 */
  private bossStrikes(players: readonly { id: string; x: number; y: number; z: number }[]): PendingStrike[] {
    const out: PendingStrike[] = [];
    if (this.bossRaid.size === 0 || players.length === 0) return out;
    const t = (this.frameCount * DT) as number;
    for (const bossId of this.bossRaid.aliveIds()) {
      const st = this.bossRaid.stateOf(bossId);
      if (st === undefined) continue;
      /* 目标 = 最近的玩家(Boss 的招式本来就朝人放;`skillWarnGeoms` 要一个朝向点)。 */
      let best: { x: number; y: number; d: number } | null = null;
      for (const p of players) {
        const d = Math.hypot(p.x - st.x, p.y - st.y);
        if (best === null || d < best.d) best = { x: p.x, y: p.y, d };
      }
      if (best === null) continue;
      /* `skillWarnGeoms` 在 `stunnedSec > 0` 时返回空数组 ⇒ 破防即打断(D-05 的控场语义,
         由内容层自己保证,这里不重复判)。 */
      for (const g of skillWarnGeoms(st, { x: best.x, y: best.y }, t)) {
        out.push({ attackerId: bossId, attackerLevel: st.def.level, warn: g });
      }
    }
    return out;
  }

  /** Boss 的等级(`attackerPosOf` / 结算用);不是 Boss ⇒ 1。 */
  private bossLevelOf(bossId: string): number {
    return this.bossRaid.stateOf(bossId)?.def.level ?? 1;
  }

  /** Boss 的当前阶段号;不是 Boss ⇒ -1(不会命中任何效果行)。 */
  private bossPhaseOf(bossId: string): number {
    return this.bossRaid.stateOf(bossId)?.phaseIndex ?? -1;
  }

  /**
   * 该 Boss 本次结算的**效果时长** = 它当前阶段预警几何的 `warnSec`(内容值)。
   *
   * 为什么不另存一份「眩晕几秒」:那是内容层的数(0.8 / 1.0 / 1.5),
   * 二份就会漂。取不到 ⇒ 0(不施加),而不是猜一个默认值。
   */
  private bossWarnSecOf(bossId: string): number {
    const st = this.bossRaid.stateOf(bossId);
    if (st === undefined) return 0;
    const geoms = skillWarnGeoms(st, { x: st.x, y: st.y }, 0);
    let max = 0;
    for (const g of geoms) if (g.warnSec > max) max = g.warnSec;
    return max;
  }

  /**
   * 攻击者的**权威位置**:先查生物宿主,再查 Boss 运行时。
   *
   * 为什么需要统一入口:D1 的击退方向与 D2 的视线都用「谁在哪儿」,
   * 而第三条通道(Boss)的攻击者不在 `mobHost` 里 ⇒ 两处各写一遍必然漂一个。
   */
  private attackerPosOf(attackerId: string): { x: number; y: number } | null {
    const rt = this.mobHost.runtimeOf(attackerId);
    if (rt !== null) return { x: rt.x, y: rt.y };
    const st = this.bossRaid.stateOf(attackerId);
    if (st !== undefined) return { x: st.x, y: st.y };
    return null;
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
    /* ★ WS-FND-114:`LOGISTICS_SORTER.routed` 是 `STATE_DEFAULTS` 里**声明过**的读数,
       此前**没有任何写点**(分拣计数只活在 `logisticsSorters` 私有 Map 里,
       从件表看过去恒 0)。这里按「已分流件数之和」投影出去,与 belt/arm/drill 同款。 */
    for (const s of line.sorters) {
      const id = this.componentIdOf(s.x, s.y, 'LOGISTICS_SORTER');
      const c = id ? this.wiring.get(id) : undefined;
      if (c) {
        let routed = 0;
        for (const n of s.state.routed.values()) routed += n;
        c.state.routed = routed;
      }
    }
    for (const d of line.drills) {
      const id = this.componentIdOf(d.x, d.y, 'LOGISTICS_DRILL');
      const c = id ? this.wiring.get(id) : undefined;
      if (c) { c.state.produced = d.state.produced; c.state.stalledTicks = d.state.stalledTicks; }
    }
  }

  /* ═══════════════ task-84:WS-11 对局运行时的每帧驱动 ═══════════════ */

  /**
   * 开一局派对模式(`createPartyContest` 的持有者只能在这里)。
   *
   * ## 生产调用者(★ WS-FND-120 修复第六轮 P1)
   *
   * `tickPartyStep` 的**哨台入口**:每慢帧读 436 `ARENA_REFEREE_DESK` 的
   * `params.mode`(1..4 = 四种模式,`-1` = 收局)与此刻**站在哨台格上**的玩家,
   * 过 `party/actions.ts#gatePartyStart`(未知模式 / 无裁判 / 已在跑 ⇒ 拒绝)。
   * `--` 修前本方法在全仓**零调用**(只有 `tests/WS-11` 直接调),
   * 于是 `partyRun` 恒 `null`、`tickPartyMode` 从不推进、`partyPhase()` 恒 `IDLE`。
   *
   * ## 为什么由模拟层提供这个入口,而不是让房间直接 new
   *
   * 驱动必须与 `tick()` 同源(否则「谁先谁后」取决于两个调用方),
   * 而 `tick()` 在 `WorldSim` 里 ⇒ 持有者也只能在这里。
   *
   * ## 参数全部**必填**,不给默认值
   *
   * `refereeId` / `key` 是**玩家与房间级决策**,模拟层替它猜一个默认值
   * 就会造出「模式在跑但裁判是错的」——而那种错误**不报错、不影响推进**,
   * 只是结算归属错人。故宁可让调用方必须显式给。
   */
  startPartyRun(key: string, refereeId: string): boolean {
    const known = Object.values(PARTY_MODE_KEY) as string[];
    if (!known.includes(key)) return false;
    if (refereeId === '') return false;
    const contest = createPartyContest(
      key as (typeof PARTY_MODE_KEY)[keyof typeof PARTY_MODE_KEY],
      this.partyClock,
      refereeId,
    );
    startPartyMode(contestMode(contest));
    this.partyContest = contest;
    this.partyRun = contestMode(contest);
    this.lastPartySettlement = null;
    /* ★ 把**上一帧已经读到过**的队伍归属补登记进容器:哨台入口比玩家站旗晚一帧
       (同一慢帧里先扫旗、后开局),不补的话「第一帧就站上旗的玩家」永远不会被
       登记 ⇒ 拾冠 `crownPickup` 会被 `teams.get(pid) === undefined` 静默拒掉。 */
    for (const [pid, team] of this.partyTeams) contestAssignTeam(contest, pid, team);
    return true;
  }

  /**
   * 结束并清空对局。
   *
   * ★ WS-FND-120:清空**之前**先结算一次(若还没结算)—— 否则「裁判按 -1 收局」
   * 会把这一局的名次与奖励整份丢掉,而那种丢法**不报错**:相位照样回 `IDLE`。
   */
  clearPartyRun(): void {
    const contest = this.partyContest;
    if (contest !== null) {
      const settlement = contestSettlement(contest) ?? settlePartyRun(contestMode(contest));
      if (settlement !== null) this.grantPartyRewards(settlement);
    }
    this.partyRun = null;
    this.partyContest = null;
  }

  /**
   * 开一场急单(WS-11 §6 的 `RushOrderSession`)。
   *
   * `rng` 必须由调用方注入 —— 本类**刻意不**用自己的 `this.rng`,
   * 因为 `tests/WS-01` 有确定性快照钉住 `tick()` 里的 RNG 调用顺序;
   * 从这里偷偷抽数会让那份快照漂移,而漂移的原因**极难定位**
   * (表现是「某个不相干的确定性测试红了」)。
   * `createRushOrderSession` 会把 `rng` 存在会话里,故只在开局时取一次。
   */
  startRushRun(roomLevel: number, rng: () => number, stock: Record<number, number> = {}): boolean {
    if (!Number.isFinite(roomLevel) || roomLevel < 1) return false;
    /* ★ D-13:工位补上**世界格**(取真实器件格:506 汤锅 / 508 披萨炉 / 507 切菜台)。
       不注入就只能用 `rush_order.ts` 里的占位格(0/6/12)——那是布局占位,不是这张图。 */
    const cells: Partial<Record<'POT' | 'FURNACE' | 'CUTTER', { x: number; y: number }>> = {};
    const potCell = this.deviceTileOf(SOUP_POT_ID);
    const furnaceCell = this.deviceTileOf(PIZZA_OVEN_ID);
    const cutterCell = this.deviceTileOf(KITCHEN_TABLE_ID);
    if (potCell !== null) cells.POT = potCell;
    if (furnaceCell !== null) cells.FURNACE = furnaceCell;
    if (cutterCell !== null) cells.CUTTER = cutterCell;
    /* ⚠️ 仍未接线的一半:把玩家坐标喂成 `opts.spraying`(= 谁在浇水)需要"喷射意图"窗口,
       否则站在燃烧工位旁就会自动灭火;那一半留待下一轮(`docs/TASK-96` 二之十已记)。 */
    const s = createRushOrderSession({
      clock: this.partyClock, roomLevel, rng, stock, stationCells: cells,
    });
    startRushOrder(s);
    this.rushRun = s;
    /* ★ WS-FND-120:新一场急单 ⇒ 清掉上一场的回执(否则 `rushSettlement()` 会把
       上一场的 S/A/B 当成这一场的)。 */
    this.lastRushSettlement = null;
    return true;
  }

  /** 结束并清空急单(★ 收工前先结算,见 `stepRushSettle`)。 */
  clearRushRun(): void {
    this.stepRushSettle();
    this.rushRun = null;
  }

  /** 急单当前状态(诊断与断言用)。未开局返回 `'IDLE'`。 */
  rushState(): string {
    return this.rushRun === null ? 'IDLE' : this.rushRun.state;
  }

  /**
   * 急单三个工位的累计运转秒数之和(诊断用)。
   *
   * ★ 用它而**不是**用 `state === RUNNING` 做判据:状态是**枚举**,
   *   只要 `startStation` 被调过就恒为 RUNNING —— 那只能证明「开局了」,
   *   不能证明「每帧在算」。`runningSec` 是**每帧累加**的连续量,
   *   它会随时间真的增长 ⇒ 才区分得开「已接线」与「只调了一次」。
   * ⚠️ 我第一版写的 `station.heat` **不存在**于 `StationRuntime`
   *   (`rush_order.ts:349-364`),TS 类型擦除不报错,运行时会得到 NaN。
   */
  rushRunningSec(): number {
    if (this.rushRun === null) return 0;
    return this.rushRun.stations.reduce((a, st) => a + st.runningSec, 0);
  }

  /** 当前对局相位(诊断与断言用)。未开局返回 `'IDLE'`。 */
  partyPhase(): string {
    return this.partyRun === null ? 'IDLE' : this.partyRun.phase;
  }

  /**
   * 登记/注销一个挂机玩家的**玩法态**(打盹攒露水)。
   *
   * ⚠️ 与 `setPlayerAfk`(连接态)**不是同一件事**:后者由房间推「谁断线了」,
   * 本方法建的是「谁在打盹攒露水」。两者可以同时为真,也可以一真一假 ——
   * 断线的人未必在打盹,打盹的人也未必断线。
   *
   * `atSec` 传入即视为「此刻切到后台」;传 `null` 表示回到前台。
   */
  setPlayerDozing(playerId: string, atSec: number | null): boolean {
    if (playerId === '') return false;
    if (atSec === null) {
      const p = this.afkRuns.get(playerId);
      if (p === undefined) return false;
      /* 回前台:保留已攒的露水,只清打盹态 —— `goForeground` 是**唯一**写口。 */
      goForeground(p);
      return true;
    }
    let p = this.afkRuns.get(playerId);
    if (p === undefined) {
      p = createAfkPlayer(playerId);
      this.afkRuns.set(playerId, p);
    }
    /* 切后台:`goBackground` 幂等(已在后台 ⇒ 不重置计时);修前这里直接写字段,
       等于把「重置计时」这件事又实现了一遍(两份实现迟早漂移)。 */
    goBackground(p, atSec);
    return true;
  }

  /** 某玩家已攒的露水(诊断与断言用)。未登记返回 0。 */
  dewOf(playerId: string): number {
    return this.afkRuns.get(playerId)?.dew ?? 0;
  }

  /** 已登记的打盹玩法态玩家数(诊断用)。 */
  dozingCount(): number {
    return this.afkRuns.size;
  }

  /**
   * 推进一次 WS-11 对局运行时(慢帧 2Hz)。
   *
   * ## 频次:慢帧,`dt = SIM_SLOW_DT`
   *
   * 三个入口的推荐帧率**都不高于慢帧**,逐个有依据:
   * ```
   * tickAfk      afk.ts:115 原文「单步推进打盹:推荐 dt = 0.5s(低频帧)」
   *              0.5 === SIM_SLOW_DT(2Hz) ⇒ 与模块自己的建议**逐值吻合**
   * tickPartyMode 签名无 dt,内部靠 clock.now() 算 elapsed
   *              ⇒ 正确性只依赖时钟,与帧率无关
   * tickRushOrder  §6.1 每帧开销 < 0.001ms,工位/河狸是秒级状态机
   * ```
   * ★ **我的第一版把 `tickAfk` 放快帧(理由:露水是小数累加器,怕折算错)**,
   *   复核模块注释后**否掉了自己**:`dewAcc += rate * dt` 对 dt **线性**,
   *   只要 dt 与调用频次一致(0.5s × 2Hz),每秒产露量就与快帧等价;
   *   而放快帧反而**违背模块自己写明的推荐值**,且让每秒执行 20 次无用功。
   *   ⇒ 教训:先读模块的推荐帧率,再谈「我觉得该多快」。
   *
   * ## 时钟:本方法自管逻辑秒,不读帧计数
   *
   * `partyClock.advance(SIM_SLOW_DT)` 每慢帧推进一次 ⇒ 逻辑秒与**慢帧数**
   * 严格成比例。刻意**不**用 `frameCount / TICK_HZ`:后者含快帧,
   * 两者差 `FAST_PER_SLOW`(=10)倍 —— 写成那样 `tickAfk` 的
   * `nowSec - backgroundedAtSec` 会 10 倍速越过 `DOZE_AFTER_SEC`,
   * 表现成「切后台不到 5 秒就进打盹」,而**不报错**。
   *
   * ## 顺序:`先 party 后 afk`,互不依赖
   *
   * 两者共享的只有本方法的 `nowSec`,读的都是**各自的**私有状态
   * (`partyRun` vs `afkRuns`),没有先后依赖。
   * 取这个次序是为了让 `events` 的顺序稳定可断言。
   */
  private tickPartyStep(): void {
    this.partyClock.advance(SIM_SLOW_DT);
    const nowSec = this.partyClock.now();
    const events: string[] = [];
    let partyTicked = 0;
    let afkTicked = 0;
    let afkDew = 0;

    /* ── ★ WS-FND-120 入口(世界事实 → 动作层闸门 → 动作)──
       三段都**只在事实成立时**才动:玩家站上 435 旗 / 有人站在 436 哨台 / 食堂建成
       且有人站在工位格。修前这三件事一件都没有入口,`partyRun` / `rushRun` /
       `afkRuns` 在生产里恒空。 */
    this.scanPartyTeams();
    this.stepRefereeDesk(nowSec);
    this.stepRushEntry();

    /* 急单(WS-11 §6)。★ 这一行是我**补上**的 —— 第一版漏了它,
       只 import 不调用 ⇒ 门禁全绿而什么都没推进。详见 `rushRun` 的注释。 */
    if (this.rushRun !== null) {
      /* ★ D-13:把"正在喷水"的玩家坐标换成工位种类 —— `opts.spraying` 今天唯一的生产者。 */
      const spraying: StationKind[] = [];
      for (const [pid, until] of this.sprayUntil) {
        if (until < this.frameCount) { this.sprayUntil.delete(pid); continue; }
        const b = this.physics.bodies.get(pid);
        if (b === undefined) continue;
        for (const kind of stationsBeingSprayedBy(this.rushRun, { x: b.x, y: b.y })) {
          if (!spraying.includes(kind)) spraying.push(kind);
        }
      }
      /* ★ 第三轮:`opts.tended` 与 `spraying` **同段、同形**地在这里成形 —— 修前它全仓
         没有生产者 ⇒「12 秒不翻炒 ⇒ 起火」在生产里退化成**必然起火**
         (见 `rush_order.ts#stationsBeingTendedBy` 的 docblock)。
         只认 `RUNNING`(`stationsBeingTendedBy` 的口径):在烧的工位要浇 227,不是翻炒。 */
      const tended: StationKind[] = [];
      for (const [pid, until] of this.tendUntil) {
        if (until < this.frameCount) { this.tendUntil.delete(pid); continue; }
        const b = this.physics.bodies.get(pid);
        if (b === undefined) continue;
        for (const kind of stationsBeingTendedBy(this.rushRun, { x: b.x, y: b.y })) {
          if (!tended.includes(kind)) tended.push(kind);
        }
      }
      events.push(...tickRushOrder(this.rushRun, SIM_SLOW_DT, { spraying, tended }));
      this.rushTicked = 1;
      /* ★ WS-FND-120:交付与结算回执 —— 修前 `submitDelivery` / `settleSession`
         生产零调用(后者连引用都没有)⇒ 急单永远是「跑完就没了」。 */
      const delivered = this.stepRushDelivery();
      if (delivered > 0) events.push(`RUSH_DELIVERED:${delivered}`);
      const receipt = this.stepRushSettle();
      if (receipt !== null) events.push(`RUSH_SETTLED:${receipt.grade}`);
    } else {
      this.rushTicked = 0;
    }

    if (this.partyContest !== null) {
      /* ★ WS-FND-120:整局推进走**容器**(子运行在前、相位在后),再把世界事实
         (谁站在旗上 / 谁站在底座上 / 谁被击退)过动作层闸门换成真动作。 */
      const contest = this.partyContest;
      events.push(...tickPartyContest(contest, SIM_SLOW_DT));
      this.stepPartyActions(contest, events);
      partyTicked = 1;
    } else if (this.partyRun !== null) {
      events.push(...tickPartyMode(this.partyRun));
      partyTicked = 1;
    }

    for (const p of this.afkRuns.values()) {
      const whole = tickAfk(p, nowSec, SIM_SLOW_DT);
      afkTicked += 1;
      afkDew += whole;
    }
    /* ★ WS-FND-120:`setPlayerDozing` 的生产入口 —— 世界侧唯一知道的「谁在睡」是
       装配层注入的 `sleepSource`(index.ts:266 接 `actions/sleep.ts`)。
       没有它 ⇒ 不登记(与修前同形态,判据按 0 断言)。 */
    const dozeEntries = this.stepDozingEntry(nowSec);
    if (dozeEntries > 0) events.push(`DOZE_ENTER:${dozeEntries}`);
    /* ★ WS-FND-120:broadcaster 的**消费者**。修前 `shiftBroadcast` /
       `drainBroadcasts` 零调用 ⇒ 队列只写不读(播报永远发不出去)。 */
    const drained = this.stepPartyBroadcasts();
    if (drained > 0) events.push(`PARTY_BROADCAST:${drained}`);

    this.lastPartyTick = { partyTicked, afkTicked, afkDew, events };
    /* 事件并入世界总线。**必须与 `bus.drain()` 同帧语义**:总线每快帧末尾排空,
       而本方法在慢帧内被调,故这里 emit 的事件会在**本帧末尾**被投递 ——
       与 mobHost 的 emit 行为一致(同一慢帧内产生、同帧末尾 drain)。 */
    for (const ev of events) this.bus.emit('party_event', { kind: ev });
  }

  /* ══════════════ ★ WS-FND-120:WS-11 的动作层入口(世界事实 → 闸门 → 动作)══════════════ */

  /**
   * 玩家此刻站在哪一格(**权威刚体坐标**)。非玩家 / 没有刚体 ⇒ `null`。
   *
   * 为什么用 `playerIds` 而不是 `physics.bodies.has`:`physics.bodies` 里玩家与生物
   * **混在一起**(`addPlayer` 与 `addMob` 都调 `physics.spawn`)⇒ 不查这一条,
   * 一只怪站在哨台格上就能冒充裁判(`applyPlayerMove` 的闸 0 是同一处理由)。
   */
  private playerCellOf(playerId: string): { x: number; y: number } | null {
    if (!this.playerIds.has(playerId)) return null;
    const b = this.physics.bodies.get(playerId);
    if (b === undefined) return null;
    return { x: Math.floor(b.x), y: Math.floor(b.y) };
  }

  /** 站在该格上的玩家(没有 ⇒ `''`)。同格多名玩家时按 `vitals.ids()` 序取第一个。 */
  private playerAtCell(x: number, y: number): string {
    for (const pid of this.vitals.ids()) {
      const cell = this.playerCellOf(pid);
      if (cell !== null && cell.x === x && cell.y === y) return pid;
    }
    return '';
  }

  /** 某类金件的世界格列表(没有 ⇒ 空数组)。电路关闭时也没有。 */
  private componentCells(kind: string): { id: string; x: number; y: number; params: Record<string, number> }[] {
    if (!this.wiringOn) return [];
    const out: { id: string; x: number; y: number; params: Record<string, number> }[] = [];
    for (const c of this.wiring.components.values()) {
      if (c.kind !== kind) continue;
      out.push({ id: c.id, x: c.x, y: c.y, params: c.params });
    }
    return out;
  }

  /**
   * 435 复活旗 → `partyTeams`(**队伍归属的唯一来源**)。
   *
   * 为什么用旗而不是按加入顺序轮转:轮转会造出「模式在跑但队伍是猜的」——
   * 不报错、不影响推进,只是结算归属错人(`startPartyRun` 的参数纪律同源)。
   * 没站过任何旗 ⇒ 没有队伍 ⇒ 拾冠/夺旗被闸门拒绝(`NO_TEAM_BANNER`)。
   */
  private scanPartyTeams(): void {
    const banners = this.componentCells('ARENA_TEAM_BANNER');
    const pedestals = this.componentCells('ARENA_CROWN_PEDESTAL');
    const goals = this.componentCells('ARENA_GOAL_FRAME');
    /* 触达点 = 三类目标件格;`REACH_TARGET` 只说「踩到了本模式的目标件」,
       具体是哪一件由本层的格判定决定(scoring 不需要知道坐标)。 */
    const reachCells = [...banners, ...pedestals, ...goals];
    const seen = new Set<string>();
    for (const pid of this.vitals.ids()) {
      const cell = this.playerCellOf(pid);
      if (cell === null) continue;
      const banner = banners.find((b) => b.x === cell.x && b.y === cell.y);
      if (banner !== undefined) {
        const idx = Math.abs(Math.trunc(banner.params.team ?? 0)) % TEAM_ORDER.length;
        const team = TEAM_ORDER[idx];
        this.partyTeams.set(pid, team);
        if (this.partyContest !== null) contestAssignTeam(this.partyContest, pid, team);
      }
      /* ★ WS-FND-120:REACH_TARGET 的**唯一发射点**(修前全仓零生产者)。
         只在「刚站上去」那一慢帧发(电平 → 脉冲),离开再踩重新计。 */
      if (reachCells.some((c) => c.x === cell.x && c.y === cell.y)) {
        const key = `${pid}:${cell.x},${cell.y}`;
        seen.add(key);
        if (!this.reachLatch.has(key)) {
          this.notePartyEvent({ kind: PARTY_SCORE_EVENT.REACH_TARGET, source: pid });
        }
      }
    }
    this.reachLatch.clear();
    for (const k of seen) this.reachLatch.add(k);
  }

  /**
   * 436 哨台:**开局 / 收局**的唯一生产入口。
   *
   * ## 命令从哪里来
   * 436 `ARENA_REFEREE_DESK` 的 `params.mode`(`components.ts` 的 436 求值器:
   * `1..4` = 一键开启四种模式,`-1` = 收局)。**裁判是谁**由世界事实决定 ——
   * 此刻站在哨台格上的玩家;没人站在那儿 ⇒ 拒绝(`NO_REFEREE_AT_DESK`)。
   *
   * ## 为什么要锁存(`refereeDeskLatch`)
   * `params.mode` 是**电平**不是脉冲:不锁存的话一局结束(相位 SETTLED → 清空)后
   * 同一帧就会再开一局,永远停不下来,而且不报错。锁存键 = `组件ID:mode`,
   * 只有命令**变了**才响应一次。
   */
  private stepRefereeDesk(nowSec: number): void {
    const desks = this.componentCells('ARENA_REFEREE_DESK');
    if (desks.length === 0) return;
    const desk = desks[0];
    const mode = Math.trunc(desk.params.mode ?? 0);
    const latchKey = `${desk.id}:${mode}`;
    if (latchKey === this.refereeDeskLatch) return;

    const actorId = this.playerAtCell(desk.x, desk.y);
    if (mode === REFEREE_DESK_STOP_MODE) {
      const gate = gatePartyStop({
        refereeId: this.partyRun?.refereeId ?? '',
        actorId,
        refereeAtDesk: actorId !== '',
        runActive: this.partyContest !== null || this.partyRun !== null,
      });
      if (!gate.ok) return;
      this.clearPartyRun();
      this.bus.emit('party_desk_stop', { atSec: nowSec, refereeId: actorId });
      this.refereeDeskLatch = latchKey;
      return;
    }

    const modeKey = deskModeKey(mode);
    if (modeKey === null) return;
    const gate = gatePartyStart({
      modeKey,
      refereeId: actorId,
      refereeAtDesk: actorId !== '',
      runActive: this.partyContest !== null || this.partyRun !== null,
    });
    /* ★ 拒绝时**不锁存**:裁判走上哨台后再按一次仍能开局。 */
    if (!gate.ok) return;
    if (this.startPartyRun(modeKey, actorId)) {
      this.refereeDeskLatch = latchKey;
      this.bus.emit('party_desk_start', { atSec: nowSec, mode: modeKey, refereeId: actorId });
    }
  }

  /**
   * 急单开工:**食堂建成 + 三工位在场 + 有人站在工位格上**。
   *
   * 为什么把「食堂建成」当前置:急单是**食堂的活动**(`ROOM_RECIPES` 的
   * `COZY_CANTEEN`,必需件 506 + 519)。不加这条,任何摆了锅的测试房间都会
   * 被自动开工 —— 那不是接线,那是噪声。
   *
   * 房间等级取 `RUSH_ENTRY_ROOM_LEVEL`(最低档):真实等级由**房间**持有,
   * 世界侧没有 (`docs` 与 `rush_actions.ts` 的台账 `ROOM_LEVEL` 行已登记)。
   */
  private stepRushEntry(): void {
    if (this.rushRun !== null) return;
    if (!this.rooms().some((r) => r.key === 'COZY_CANTEEN')) return;
    const pot = this.deviceTileOf(SOUP_POT_ID);
    const furnace = this.deviceTileOf(PIZZA_OVEN_ID);
    const cutter = this.deviceTileOf(KITCHEN_TABLE_ID);
    const stationsReady = pot !== null && furnace !== null && cutter !== null;
    const cells = [pot, furnace, cutter].filter((c): c is { x: number; y: number } => c !== null);
    let actorAtStation = false;
    for (const pid of this.vitals.ids()) {
      const cell = this.playerCellOf(pid);
      if (cell === null) continue;
      if (cells.some((c) => c.x === cell.x && c.y === cell.y)) { actorAtStation = true; break; }
    }
    const gate = gateRushStart({
      /* 上面已 `if (this.rushRun !== null) return;` ⇒ 此刻必然是没开工。 */
      state: RUSH_ORDER_STATE.IDLE,
      stationsReady,
      actorAtStation,
    });
    if (!gate.ok) return;
    /* 独立确定性 rng:**不碰 `this.rng`**(`tests/WS-01` 钉住了 tick 里的抽数顺序)。 */
    this.startRushRun(RUSH_ENTRY_ROOM_LEVEL, makeRng(this.worldSeed), {});
  }

  /**
   * 急单交付:玩家**脚下 1 格**内有订单点名的地面货 ⇒ 扣货 + 交付。
   *
   * 为什么走地面货而不是背包:模拟层**没有背包明细**(`inventoryDetailOf` 返回
   * `null` 是如实表达)。地面货是世界侧真有的事实,扣减也只有一个写口
   * (`consumeGroundItem`)⇒ 不存在第二份账。
   */
  private stepRushDelivery(): number {
    const s = this.rushRun;
    if (s === null || !rushAcceptsDelivery(s)) return 0;
    let delivered = 0;
    for (const pid of this.vitals.ids()) {
      const b = this.physics.bodies.get(pid);
      if (b === undefined) continue;
      /* 每帧重算:上一条刚交付 ⇒ 剩余量变了。 */
      for (const line of openOrderLines(s)) {
        const near = this.groundItemsNear(b.x, b.y, RUSH_DELIVERY_RADIUS)
          .find((g) => g.itemId === line.itemId);
        if (near === undefined) continue;
        const qty = Math.min(near.count, line.remaining);
        const gate = gateRushDelivery({
          state: s.state, remaining: line.remaining, qty, distance: near.dist, radius: RUSH_DELIVERY_RADIUS,
        });
        if (!gate.ok) continue;
        const taken = this.consumeGroundItem(line.itemId, qty, b.x, b.y, RUSH_DELIVERY_RADIUS);
        if (taken <= 0) continue;
        const r = submitDelivery(s, line.itemId, taken);
        if (!r.accepted) continue;
        delivered += r.consumed;
        this.rushDeliveryCount += r.consumed;
        /* ★ WS-FND-120:GATHER 的**唯一发射点**(修前零生产者):扣掉地面货的那一刻
           就是「拾取」—— `source` 是权威玩家 id,不再需要给 `MaterialApi` 加签名。 */
        this.notePartyEvent({ kind: PARTY_SCORE_EVENT.GATHER, source: pid });
      }
    }
    return delivered;
  }

  /**
   * 急单结算回执:**只在状态变 `SETTLED` 的那一慢帧**结算一次。
   *
   * 修前 `settleSession` 全仓**零引用** ⇒ `RUSH_GRADE` 永远传不出去,
   * 奖励表(`REWARD_TABLE`)也永远没人读。回执在这里落账 + 奖励掉到工位格地面。
   */
  private stepRushSettle(): RushSessionSettlement | null {
    const s = this.rushRun;
    if (s === null || s.state !== RUSH_ORDER_STATE.SETTLED) return null;
    if (this.lastRushSettlement !== null) return this.lastRushSettlement;
    const receipt = settleSession(s);
    this.lastRushSettlement = receipt;
    const cell = rushRewardCellOf(s);
    if (cell !== null) {
      for (const [idStr, n] of Object.entries(receipt.rewards)) {
        const itemId = Number(idStr);
        if (!Number.isFinite(itemId) || n <= 0) continue;
        this.dropItem(cell.x + 0.5, cell.y + 0.5, itemId, n);
      }
    }
    return receipt;
  }

  /**
   * 对局动作:把**世界事实**换成真动作(每一步都先过 `party/actions.ts` 的闸)。
   *
   * | 事实 | 动作 | 前置 |
   * | :--- | :--- | :--- |
   * | 玩家站上 435 旗 + 建造阶段 + 脚下有 152 木板 | `bridgePlace`(铺板) | `gateBridgePlace` |
   * | 玩家站上 435 旗 + 冲刺阶段 + 本队桥板 ≥ 12 | `bridgeCapture`(夺旗) | `gateBridgeCapture` |
   * | 玩家站上 434 底座 + 有队伍 | `crownPickup`(拾冠) | `gateCrownPickup` |
   * | 持冠者进入击退窗口 | `crownDrop`(掉冠) | `gateCrownKnock`(过 218 和平盾) |
   * | 相位到点 / 提前宣胜 | `settle*`(结算) | 相位钩子(见 `modes.ts`) |
   */
  private stepPartyActions(contest: PartyContest, events: string[]): void {
    const mode = contestMode(contest);
    for (const pid of this.vitals.ids()) {
      const team = this.partyTeams.get(pid) ?? null;
      const cell = this.playerCellOf(pid);
      const b = this.physics.bodies.get(pid);
      if (cell === null || b === undefined) continue;
      /* 队伍登记幂等重放:玩家站过旗之后,容器里必须一直有他的队伍。 */
      if (team !== null) contestAssignTeam(contest, pid, team);

      /* ① 铺板:建造阶段,脚下 1 格内有 152 木板 ⇒ 消耗 1 块 + 铺 1 块桥板。 */
      if (mode.phase === PARTY_PHASE.BUILD && gateBridgePlace({ phase: mode.phase, team }).ok && team !== null) {
        const boards = this.groundItemsNear(b.x, b.y, RUSH_DELIVERY_RADIUS)
          .filter((g) => g.itemId === BRIDGE_BOARD_ITEM_ID);
        if (boards.length > 0 && this.consumeGroundItem(BRIDGE_BOARD_ITEM_ID, 1, b.x, b.y, RUSH_DELIVERY_RADIUS) > 0) {
          if (contestPlaceBoard(contest, team)) events.push('PARTY_BOARD');
        }
      }

      /* ② 夺旗:冲刺阶段,本队桥板够 `BRIDGE_TILES_TO_WIN` ⇒ 夺旗。 */
      if (mode.phase === PARTY_PHASE.RACE) {
        const banner = this.componentCells('ARENA_TEAM_BANNER')
          .find((c) => c.x === cell.x && c.y === cell.y);
        if (banner !== undefined && team !== null) {
          const gate = gateBridgeCapture({
            phase: mode.phase,
            team,
            builtTiles: contestBuiltOf(contest, team) ?? 0,
            alreadyFlagged: contestBridgeFlagged(contest, team),
          });
          if (gate.ok && contestCapture(contest, team)) events.push('PARTY_FLAG');
        }
      }

      /* ③ 拾冠:站在 434 底座格 + 队伍已由 435 登记。 */
      const atPedestal = this.componentCells('ARENA_CROWN_PEDESTAL')
        .some((c) => c.x === cell.x && c.y === cell.y);
      if (atPedestal) {
        const gate = gateCrownPickup({
          phase: mode.phase,
          team,
          atPedestal,
          holder: contestCrownHolder(contest),
          cooldownSec: contestCrownCooldown(contest),
          winner: contestCrownWinner(contest),
        });
        if (gate.ok && contestCrownPickup(contest, pid)) events.push('CROWN_PICKUP');
      }
    }

    /* ④ 掉冠:持冠者进入击退窗口 ⇒ 过整蛊掉冠判定(218 盾可拦)。 */
    const holder = contestCrownHolder(contest);
    if (holder !== null && this.knockbackOf(holder)) {
      /* ⚠️ 218 和平盾的**开关**还没有生产者(`useItem` 的 218 分支不在本任务写域),
         故这里按「没开」传;台账 `prank/actions.ts#PRANK_ACTION_LEDGER` 已登记。 */
      const { gate } = gateCrownKnock({ knockback: true, shieldOn: false });
      if (gate.ok && contestCrownDrop(contest)) events.push('CROWN_DROP');
    }

    /* ⑤ 结算:相位钩子已经把 `settle*` 跑掉 ⇒ 这里只负责**把奖励真发出去**。 */
    const settlement = contestSettlement(contest);
    if (settlement !== null && settlement !== this.lastPartySettlement) {
      this.lastPartySettlement = settlement;
      this.grantPartyRewards(settlement);
    }
  }

  /**
   * **把 `settlement.rewards` 真的落账**(修前 `rewards` 只是一份躺在对象里的数组
   * —— 五个 `settle*` 生产零调用,连生成都没发生)。
   *
   * 落点只有两个,都是世界侧已有的权威写口:
   * · 经验 → `gainExp(progressOf(pid), …)`(成长档案的唯一写口);
   * · 物品 → `dropItem(x, y, …)`(地面的唯一写口)。
   * 团队奖励发给**该队在本局登记过的玩家**(`partyTeams`,来自 435 旗);
   * 一名队员都没登记 ⇒ 不发明受益者(计数里看得见)。
   */
  grantPartyRewards(settlement: PartySettlement): { exp: number; items: number; players: number } {
    const lines = [...settlement.rewards, ...settlement.personalRewards];
    const paid = new Set<string>();
    let exp = 0;
    let items = 0;
    for (const line of lines) {
      const targets = line.playerId !== null
        ? [line.playerId]
        : line.team !== null
          ? this.vitals.ids().filter((pid) => this.partyTeams.get(pid) === line.team)
          : [];
      for (const pid of targets) {
        if (line.exp > 0) {
          /* `gainExp` 是**纯函数**(返回新档案)⇒ 必须写回,否则经验只活在返回值里。 */
          const res = gainExp(this.progressOf(pid), line.exp);
          this.progresses.set(pid, res.progress);
          exp += res.gained;
          if (res.levelUps.length > 0) {
            const list = this.pendingLevelUps.get(pid) ?? [];
            for (const lu of res.levelUps) list.push({ from: lu.from, to: lu.to });
            this.pendingLevelUps.set(pid, list);
          }
        }
        paid.add(pid);
        const b = this.physics.bodies.get(pid);
        if (b === undefined) continue;
        for (const [idStr, n] of Object.entries(line.rewards)) {
          const itemId = Number(idStr);
          if (!Number.isFinite(itemId) || n <= 0) continue;
          this.dropItem(b.x, b.y, itemId, n);
          items += n;
        }
      }
    }
    this.lastPartyRewards = { exp, items, players: paid.size };
    return this.lastPartyRewards;
  }

  /**
   * 播报**下发**:把 broadcaster 队列取空并交给世界总线(`party_broadcast`)。
   *
   * 修前 `shiftBroadcast` / `drainBroadcasts` 生产零调用 ⇒ 队列只写不读:
   * 比分播报、终场文案、前三名耗时全部堆在一个永远没人取的数组里。
   * 返回值 = 本慢帧下发条数(`lastPartyTick.events` 里记 `PARTY_BROADCAST:n`)。
   */
  private stepPartyBroadcasts(): number {
    const contest = this.partyContest;
    if (contest === null) {
      this.lastPartyBroadcasts = [];
      return 0;
    }
    const drained = drainBroadcasts(contestBroadcaster(contest), 99);
    this.lastPartyBroadcasts = drained.map((b) => ({ kind: b.kind, text: b.text, atSec: b.atSec }));
    this.partyBroadcastCount += drained.length;
    for (const b of drained) this.bus.emit('party_broadcast', { kind: b.kind, text: b.text });
    return drained.length;
  }

  /**
   * 打盹入口:`setPlayerDozing` 的**生产驱动**。
   *
   * 世界侧唯一知道的「谁在睡」是装配层注入的 `sleepSource`
   * (`index.ts:266` 接 `actions/sleep.ts`)—— 没接 ⇒ 一条都不登记
   * (与修前同形态;判据按 `dozingCount() === 0` 断言,别读成「没人睡」)。
   */
  private stepDozingEntry(nowSec: number): number {
    const src = this.sleepSource;
    if (src === null) return 0;
    const ids = this.vitals.ids();
    let entries = 0;
    for (const pid of ids) {
      let sleeping = false;
      try { sleeping = src(pid) === true; } catch { sleeping = false; }
      const dozing = this.afkRuns.has(pid);
      if (sleeping && !dozing) {
        if (this.setPlayerDozing(pid, nowSec)) { entries += 1; this.dozeEntryCount += 1; }
      } else if (!sleeping && dozing) {
        this.setPlayerDozing(pid, null);
        /* 醒来 ⇒ 整条玩法态注销:留着「已醒来但仍在表里」的记录会让
           `dozingCount()` 说「还有人在睡」,而露水其实已经不产了。 */
        this.afkRuns.delete(pid);
      }
    }
    /* 离场玩家的打盹态一并注销:否则露水会在「人已不在」的记录上继续累加。 */
    const present = new Set(ids);
    for (const pid of [...this.afkRuns.keys()]) if (!present.has(pid)) this.afkRuns.delete(pid);
    return entries;
  }

  /** 最近一次**真的发生**的派对结算(未结算 ⇒ null)。 */
  partySettlement(): PartySettlement | null {
    return this.lastPartySettlement;
  }

  /** 急单结算回执(`RUSH_GRADE` 在这);未结算 ⇒ null。 */
  rushSettlement(): RushSessionSettlement | null {
    return this.lastRushSettlement;
  }

  /** 急单订单板上还差哪些货(诊断与断言用)。 */
  rushOpenLines(): { itemId: number; remaining: number }[] {
    if (this.rushRun === null) return [];
    return openOrderLines(this.rushRun).map((l) => ({ itemId: l.itemId, remaining: l.remaining }));
  }

  /** 某玩家在派对里的队伍(来自 435 复活旗);没站过 ⇒ null。 */
  partyTeamOf(playerId: string): TeamKey | null {
    return this.partyTeams.get(playerId) ?? null;
  }

  /** 当前持冠者(非抢皇冠 / 皇冠落地 ⇒ null)。 */
  crownHolder(): string | null {
    const c = this.partyContest;
    return c === null ? null : contestCrownHolder(c);
  }

  /** 本局裁判 id(未开局 ⇒ '')。 */
  partyReferee(): string {
    return this.partyRun?.refereeId ?? '';
  }

  /** 造桥模式下某队已建桥板数(非造桥 ⇒ 0)。 */
  partyBuiltOf(team: TeamKey): number {
    const c = this.partyContest;
    if (c === null) return 0;
    return contestBuiltOf(c, team) ?? 0;
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
   * ## ★ 第四轮实测 P2:灭火后**不再**由投料复燃(语义定案)
   *
   * 灭火曾经是**单向闩锁**(全仓只有 `RESET_WORLD` 的 `kitchens.clear()` 能清
   * `fireOut`)—— 那部分已经修掉,但复燃走的是**另一条动作**:
   * ```
   * 投料 ≠ 点火   火灭了 ⇒ 本方法照旧**一件都不收**(`feedStation` 对
   *               `fireOut` 返回 0,料留在地面)。这条口径由 `WS-14` 的
   *               C3 负对照钉住(「灭火后不应再进料」「材料应留在地面」),
   *               故**不能**改成「投料即复燃」——那会静默吃掉玩家的料。
   * 复燃 = 显式动作 `relightStationAt()`(见它与 `extinguishStationAt`
   *               的语义表)。"灭火需要重新点火",而不是"丢件料就自动好"。
   * ```
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
   * 器件在**图上的第一格**(`null` = 全图没有这件器件)。
   *
   * ## 为什么需要它(而不是各处自己 `for x for y`)
   * 同一段扫描现在有**两个**消费点:出锅落点(`freeTileNear`)与灭火距离
   * (`extinguishDeviceByHand`)。抄两份就会漂两份 —— 尤其"找不到器件时返回什么"
   * 这种细节(这里**返回 `null`**,由调用方决定退路:出锅退回 (0,0)、灭火直接拒绝)。
   */
  private deviceTileOf(deviceId: number): { x: number; y: number } | null {
    for (let y = 0; y < this.sizeCells; y += 1) {
      for (let x = 0; x < this.sizeCells; x += 1) {
        if (this.grid.objIdAt(x, y) === deviceId) return { x, y };
      }
    }
    return null;
  }

  /**
   * 找站点旁一个空格放成品。找不到理想位就退回站点自身坐标
   * (宁可落在站上,也不让产物凭空消失)。
   */
  private freeTileNear(deviceId: number): { x: number; y: number } {
    const at = this.deviceTileOf(deviceId);
    if (at === null) return { x: 0, y: 0 };
    const sx = at.x;
    const sy = at.y;
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

  /**
   * 浇灭某料理站的炉火(227 水枪 / 212 大铁铲)。锅内料保留,只是不再出锅。
   *
   * ## 灭火是**可逆**的,但复燃是**独立动作**(★ 第四轮实测 P2,语义定案)
   *
   * 修前这里把 `fireOut` 置位后**全仓没有复位路径**(只有 `RESET_WORLD` 的
   * `kitchens.clear()` 会清)⇒ 一次误浇就让这口锅永久废掉,而 `WS-14` / `WS-FND-52`
   * 的门禁全绿(它们只断言"真的灭了")。今天的语义是:
   * ```
   * 灭火   extinguishStationAt(deviceId)            本方法(单向,幂等)
   * 点火   relightStationAt(deviceId)               显式动作:把 fireOut 复位
   * 投料 ≠ 点火 —— 火灭着就**一件都不收**(`feedStation` 对 `fireOut` 返回 0,
   *        料留在地面)。这条口径被 `WS-14` 的 C3 负对照钉住,不能改成
   *        「投料即复燃」:那会静默吃掉玩家的料,也会让一次空投解除灭火。
   * ```
   * ⇒ 「灭火需要**重新点火**」,而 `relightStationAt` 就是那个动作的世界侧落点
   * (与 `extinguishStationAt` 对称)。动作层把它接到 `USE_ITEM` 需要改
   * `net/actions/*` 与 `useItem` 的分派表 —— 超出本次可改范围,已登记在
   * 本文件与 `tests/WS-FND-109` 的台账段。
   */
  extinguishStationAt(deviceId: number): void {
    /* ★ 第六轮实测 P2(两份实现):修前这里**自己**写 `stationState(id).fireOut = true`,
       而 `combat/cooking.ts#extinguishStation` 早就是同一件事的具名实现(生产 0 调用)。
       现在委托它 ⇒ 「炉火怎么灭」只有那一个写点。判据:`tests/WS-FND-118` FND118-10。 */
    extinguishStation(this.stationState(deviceId));
  }

  /**
   * **重新点火**:把某料理站的 `fireOut` 复位(灭火的可逆那一半,语义表见
   * `extinguishStationAt`)。
   *
   * 为什么必须是独立动作而不是"投料时顺手点火":投料被拒时料会落地,
   * 玩家看到的是"我的料没进锅"—— 那是可解释的;若改成"投料即复燃",
   * 灭着的锅会静默收下料(甚至被一次空投解除灭火)。
   *
   * @returns 是否**真的**改了状态 —— `false` = 本来就是点着的(不是"失败")
   */
  relightStationAt(deviceId: number): boolean {
    const k = this.stationState(deviceId);
    if (!k.fireOut) return false;
    k.fireOut = false;
    return true;
  }

  /**
   * **手持灭火**(器件半边):227 水枪 / 212 大铁铲 对着料理站 ⇒ 浇灭它的炉火。
   *
   * ## 这补的是哪个缺口(C3 的灭火半边)
   * `cooking.ts` 的 `extinguishStation` / `EXTINGUISH_RADIUS` 与
   * `WorldSim.extinguishStationAt` **都早已存在**,判据也有(`WS-14` 的 D 组,
   * 直接调 `sim.extinguishStationAt`),但**玩家手里没有动词** ——
   * 从 `USE_ITEM` 走过来时只有"对玩家用"一条路(见 `TASK-96` 二之七 ⚠️3)。
   *
   * ## 判定次序(每一步都能单独被证伪)
   * 1 道具必须是这两个之一(**别的道具**对着锅用 ⇒ 拒绝,不是"什么都不做但扣掉");
   * 2 器件必须是**料理站**(只有它有炉火概念)—— 对着箱子用 ⇒ 拒绝;
   * 3 器件必须**在图上有格子** —— 凭空报一个 id ⇒ 拒绝;
   * 4 距离必须 `<= EXTINGUISH_RADIUS`(内容层常量,不在这里写死格子数);
   * 5 已经灭了 ⇒ 拒绝(不许把一件道具浪费在已经灭了的炉子上)。
   *
   * ⚠️ 拒绝一律 `consume: false`:动作层会据此把刚扣的那一件**退回**。
   */
  private extinguishDeviceByHand(actorId: string, itemId: number, deviceId: number): {
    applied: boolean;
    consume: boolean;
    reason: string;
    effect?: Record<string, string | number | boolean>;
  } {
    if (itemId !== WorldSim.BUBBLE_GUN_ITEM_ID && itemId !== WorldSim.SHOVEL_ITEM_ID) {
      return { applied: false, consume: false, reason: `道具 ${itemId} 没有浇灭器件的语义` };
    }
    if (deviceId !== SOUP_POT_ID && deviceId !== PIZZA_OVEN_ID && deviceId !== KITCHEN_TABLE_ID) {
      return { applied: false, consume: false, reason: `器件 ${deviceId} 不是料理站(没有炉火)` };
    }
    const b = this.physics.bodies.get(actorId);
    if (b === undefined) {
      return { applied: false, consume: false, reason: '施术者在这个房间里没有刚体' };
    }
    const at = this.deviceTileOf(deviceId);
    if (at === null) {
      return { applied: false, consume: false, reason: `图上没有器件 ${deviceId}` };
    }
    /* 距离按**格中心**算(与 `nearestFlag` 同一口径:玩家坐标是格中心)。 */
    const distance = Math.hypot(at.x + 0.5 - b.x, at.y + 0.5 - b.y);
    if (distance > EXTINGUISH_RADIUS) {
      return {
        applied: false, consume: false,
        reason: `离器件 ${deviceId} 太远(要 ${EXTINGUISH_RADIUS} 格内,实测 ${Math.round(distance * 1000) / 1000})`,
      };
    }
    if (this.stationState(deviceId).fireOut) {
      return { applied: false, consume: false, reason: `器件 ${deviceId} 的炉火已经灭了` };
    }
    this.extinguishStationAt(deviceId);
    /* ★ D-13:记下"这个玩家刚喷过水"—— 工位灭火(`opts.spraying`)只认这个意图,
       不认"站在旁边"。窗口 = 一个慢帧(见 `sprayUntil` 的 docblock)。 */
    this.sprayUntil.set(actorId, this.frameCount + FAST_PER_SLOW);
    /* ★ 第三轮:212 大铁铲**同时**兼「翻炒」—— 与 `spraying` 同形的意图窗口记一条。
       只认 `RUNNING` 的工位(`stationsBeingTendedBy` 的口径):它翻不动在烧的工位,
       那种情况要浇 227;这里记了也无害(读口那边过滤)。 */
    if (itemId === WorldSim.SHOVEL_ITEM_ID) {
      this.tendUntil.set(actorId, this.frameCount + FAST_PER_SLOW);
    }
    return {
      applied: true, consume: true, reason: 'ok',
      effect: {
        itemId, deviceId, x: at.x, y: at.y,
        distance: Math.round(distance * 1000) / 1000, fireOut: true,
      },
    };
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
    /*
     * ★ WS-FND-114(口径一致化):`wiringOn === false` 的世界里**没人推进物流** ——
     * `tickLogisticsStep()` 在 `if (this.wiringOn)` 块内,于是装上去的货会永远停在
     * `logisticsBelts[id].item` 上:既不搬动、也不落地。修前这里照样返回 `true`
     * (「装载成功」)⇒「已装载」与「会被搬运」两个口径**相反**。
     * ⇒ 无电路的世界**拒绝装载**(返回 false,货留在地面):宁可不说成功,
     * 也不许诺一次永远不会发生的搬运。
     */
    if (!this.wiringOn) return false;
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
      isNight: () => this.isNightNow(),
      /* ★ 房间号喂给刷怪器:它据此向 provider 问「本房间的安全区半径」
         (此前只有一个常量 `TOWN_SAFE_RADIUS` ⇒ `MODIFY_TOWN` 改了也不生效)。
         没给房间号(空串)⇒ `spawner` 退回默认常量,与历史逐字一致。 */
      roomId: () => this.roomId,
    };
  }

  /**
   * 慢帧 2Hz 刷怪:**把判定真的变成一只怪**。
   *
   * ## 速率不是新常数,是从配表推的
   * 「这一拍该来几只」用 `spawnsPerCheck(biome)`(由 `BIOME_SPAWN.perChunk`
   * 与 `intervalSec` 折算),小数部分累加、整数部分兑现 ⇒ 2Hz 慢帧下的
   * **长期期望恰好等于配表密度**,不需要另发明一个「每帧刷百分之几」的魔数。
   *
   * ## 被拒的预算**退回**,但有上界
   * 一次尝试被 `decideSpawn` 拒(安全区 / 阻挡 / 光照 / 夜行)时不吞预算,
   * 而是退回去下次再试 —— 否则「城镇占了约 20% 面积」会让实际密度悄悄
   * 低于配表,而**没有任何地方会显示这件事**。
   * `spawnBudgetMax` 防的是反面:整张图都被挡住时预算无限累积,
   * 一旦出现空格就瞬间涌出一大群。
   */
  private tickSpawn(): number {
    const biome = this.biomeName;
    this.spawnBudget = Math.min(
      this.spawnBudget + spawnsPerCheck(biome), this.spawnBudgetMax,
    );
    let quota = Math.floor(this.spawnBudget);
    if (quota <= 0) return 0;
    this.spawnBudget -= quota;
    let spawned = 0;
    while (quota > 0) {
      quota -= 1;
      if (this.trySpawnOne(biome)) spawned += 1;
      else this.spawnBudget = Math.min(this.spawnBudget + 1, this.spawnBudgetMax);
    }
    return spawned;
  }

  /**
   * 试刷一只。成功 = 世界里**真的多了一只活的**
   * (物理刚体 + AOI 记录 + 刷怪计数 + 宿主 AI,四件事由 `addMob` 一起做)。
   *
   * ## 实例 id 与物种 id 已经**拆开**(2026-11-16)
   * 实例 id = `` `${物种 id}#序号` ``(`mobs/spawner.ts` 的 `mobInstanceId`),序号来自
   * `mobOrdinals` 的单调计数器;物种 id 仍是 `MOB_BY_ID` 的键,查表一律走 `mobDefOf()`。
   * ⇒ 同物种**可以同时存在多只**(原先"每物种最多一只"是 id 契约的限制,不是设计选择)。
   * 配额由 `decideSpawn` 的群系 `softCap`/`hardCap` 与全局上限管,本函数不再自己按物种去重。
   *
   * **本函数仍不假装能一次刷满** —— 每次慢帧只按 `spawnsPerCheck` 试几只。
   */
  private trySpawnOne(biome: string): boolean {
    /* ★ 拆开两层之后不再按物种去重(旧写法:`alive.some(r => r.def.id === d.id)` 被过滤掉)。
       `runtimes()` 里含尸体(`alive === false`),但实例 id 唯一 ⇒ 不会撞键,故不过滤。 */
    const roster = spawnableMobs(biome);
    if (roster.length === 0) return false;
    if (roster.length === 0) return false;
    const def = roster[Math.floor(this.rng() * roster.length) % roster.length]!;
    /* +0.5:落在**格心**。整数坐标在 `WorldGrid` 上是格的角,
       `blocked()` 查的是格 ⇒ 落在角上会让「刷在墙里/墙外」取决于取整方向。 */
    const x = Math.floor(this.rng() * this.sizeCells) + 0.5;
    const y = Math.floor(this.rng() * this.sizeCells) + 0.5;
    const ctx: SpawnContext = {
      biome,
      x,
      y,
      biomeCount: this.spawner.state.biomeCounts.get(biome) ?? 0,
      globalCount: this.spawner.state.globalCount,
      mobId: def.id,
    };
    /* 判定用的 `roll` **必须新取**:`canSpawn` 把它交给 `decideSpawn` 做软上限
       阻尼(≥softCap 时 roll < 0.5 直接拒)。复用坐标那两次取数会让
       「刷不刷」与「刷在哪」完全相关 —— 同一片坐标永远同命运。 */
    if (!this.spawner.canSpawn(ctx, this.spawnWorld(), this.rng())) return false;
    /* 序号**先增后用**:同一物种第二次刷出来是 `mob_sheep#2`,与 #1 各自独立(物理/AOI/账本)。 */
    const ordinal = (this.mobOrdinals.get(def.id) ?? 0) + 1;
    this.mobOrdinals.set(def.id, ordinal);
    this.addMob(mobInstanceId(def.id, ordinal), biome, x, y);
    return true;
  }

  /**
   * 当前**存活**生物的快照 —— 房间把它投影进 `state.wildlife` 用。
   *
   * ## 为什么必须有这个口(2026-11-14 实测)
   * 房间手里只有 `WorldSaveHost`(结构化接口,刻意不 import 模拟层类型),
   * 所以它**没法自己遍历 `mobHost`**。而 `upsertWildlife()` 在 `net/schema.ts`
   * 里躺着、全仓**没有任何调用点**(`git grep -n addWildlife` = 0 处)
   * ⇒ 客户端快照里恒为 `wildlife: []`,即使世界里真有怪也看不见。
   *
   * ## `fsm` 为什么不从 `rt.fsm` 抄
   * `rt.fsm` 是 `MobFsm` **对象**,而 `WildlifeState.fsm` 是 wire 上的 `uint8`
   * (默认值见 `net/schema.ts` 的 `fsm: 0`);两者之间**没有定义过映射表**。
   * 硬塞一个编号(比如按枚举顺序数)会让客户端拿到一个**看起来合法、
   * 实际没有任何含义**的状态码。⇒ 保持 wire 默认值 0,并在 `docs` 里
   * 记为待办,而不是编一个。
   */
  listWildlife(): WildlifeState[] {
    const out: WildlifeState[] = [];
    for (const rt of this.mobHost.runtimes()) {
      if (!rt.alive) continue;
      out.push({
        id: rt.id,
        mobId: rt.def.id,
        x: rt.x,
        y: rt.y,
        z: rt.z,
        fsm: 0,
        hp: rt.hp,
        maxHp: rt.maxHp,
        /* 驯养归属在模拟层还没有状态位(全仓只有 wire 字段与 colyseus schema
           的 `tameOwnerId = ''`)⇒ 报「野生」。不编一个假主人。 */
        tameOwnerId: '',
      });
    }
    return out;
  }

  /**
   * 推进一帧。
   *
   * 帧类型由**帧序**决定:偶数帧快帧、每第 10 帧同时是慢帧。
   * 这样 10 个快帧恰好对应 1 个慢帧,不依赖浮点累加 —— 
   * 用 `accumulator += dt` 判断会让「第几次慢帧」受浮点误差影响,
   * 长跑后出现 119 或 121 次的偏差(这是粒子发射器踩过的同一个坑)。
   */
  /* ══════════ ★ WS-FND-77 / D-19:四个房间系统接进生产(唯一装配点)══════════
   *
   * 这一整块的职责只有一个:**把世界状态翻译成四个纯函数的入参,并把结果落回世界**。
   * 判定全在 `systems/**`(那份实现有 `tests/WS-FND-75` 的 23 条钉着),
   * 本块**不重写任何判定**,也不自己算平衡数字。
   *
   * ```
   * A-1 牧场  settleRanchIfDayChanged()  → ranch.ts:settleRanchDay
   * A-2 温室  advanceRoomSystems()       → greenhouse.ts:cellGrowth / morningMoisture /
   *                                        sprinklerCells / sortHarvest(经 wiring.ts)
   * A-3 炼金  brewAtFurnace()            → alchemy_lab.ts:brewAndRecord + 537 陈列投影
   * A-4 百货  purchaseQuote/Commit       → depot.ts:buy / priceOf
   * C        syncFoodPhysics()           → physics/world.ts:setSpeedCap/setGravityMul/setJumpMul
   * ```
   *
   * ⚠️ **不 import `mobs/taming.ts`**:它仍是 `scripts/verify.ts` 的不可达白名单成员
   *   (宠物容器未接线),从这里 import 会把那条白名单变成陈旧条目,而
   *   `scripts/verify.ts` 不在本线写域。⇒ 圈养名单由动作层经 `setRanchPets` 注入,
   *   唯一权威仍是 `mobs/taming.ts` 的「在圈标记」(见 `systems/wiring.ts` 文件头)。
   *   ⚠️ 那里**只用文字描述**、不写那个字段的名字:`tests/WS-04` 的 W4-38 系列用
   *   **源码文本**判「world_sim 不碰宠物容器」(存在性无法用 import 表达),
   *   在注释里写字段名会让那条判据红 —— 而它红得对(本文件确实没有容器)。
   *
   * ## ★ WS-FND-119(第六轮实测 P0):三个**进料口**曾经在生产里零调用
   *
   * 修前实测:`setRanchPets` / `plantCrop` / `setSortFilters` 在 `server/**` 内的
   * 调用点是 **0**,唯一调用方是 `tests/**` ⇒ 生产里 `ranchPets` / `crops` /
   * `sortFilters` **恒空**,于是 `settleRanchIfDayChanged`(牧场无产出)、
   * `advanceRoomSystems` 的温室分支(无作物可长)、`sortHarvest`(道号恒 -1)
   * 每慢帧**空跑**,而门禁全绿。
   *
   * ⇒ 三个入口现在各有一条真实动作路径(判定在 `systems/intake.ts`,本文件只做世界写入):
   *
   * ```
   * BREED_TAME 的 RANCH 子操作                 → net/actions/breed_tame.ts     → setRanchPets
   * PLACE_AUTOMATION 的播种分支                → net/actions/place_automation.ts → plantCrop
   * PLACE_AUTOMATION 放下 LOGISTICS_SORTER     → 同上                          → setSortFilters
   * ```
   *
   * ⚠️ 本块注释里同样**不写** `mobs/taming.ts` 的那几个函数名:`tests/WS-04`
   *   读的是源码文本(它要钉的正是「生产侧对它们的调用点 = 0」)。 */

  /** 内容表 `301 肥沃农田耕地` —— 能在上面播种的唯一地表。 */
  private static readonly CROP_SOIL_ID = 301;
  /** 内容表 `426 旋转自动洒水器` —— 温室的「每早 5×5 自动浇水」。 */
  private static readonly SPRINKLER_OBJ_ID = 426;
  /** 内容表 `529 牧场动物自动饲育槽` —— 牧场产出的落货点。 */
  private static readonly RANCH_TROUGH_OBJ_ID = 529;
  /** `AUTO_GREENHOUSE` 的房间 key(`rooms/effects.ts` 的 `ROOM_SYSTEM_IMPL` 同一字面量)。 */
  private static readonly AUTO_GREENHOUSE_KEY = 'AUTO_GREENHOUSE';

  /**
   * 设天气(世界侧是**唯一**来源:`greenhouse.ts` 只接受判好的值,不自己判定)。
   *
   * 非法值一律**忽略**(保持原值):写成「未知 ⇒ STORM」会让一场谎报的报文
   * 把全世界露天作物停摆,而那是不可观测的。
   */
  setWeather(w: Weather): boolean {
    if (w !== 'CLEAR' && w !== 'RAIN' && w !== 'STORM') return false;
    this.weatherNow = w;
    return true;
  }

  /** 当前天气(只读)。 */
  weather(): Weather {
    return this.weatherNow;
  }

  /**
   * 429 智能分拣交叉带的过滤规则(`设定过滤物品 ID ⇒ 分流进某条道`)。
   *
   * 空数组 = 一切产出 `lane: -1`(原样留在带上)—— 那是 `sortHarvest` 的既有语义。
   */
  setSortFilters(filters: readonly { lane: number; itemIds: readonly number[] }[]): void {
    const out: { lane: number; itemIds: number[] }[] = [];
    for (const f of filters) {
      if (!Number.isFinite(f.lane)) continue;
      out.push({ lane: Math.trunc(f.lane), itemIds: [...f.itemIds] });
    }
    this.roomSystemsState.sortFilters = out;
  }

  /**
   * 当前 429 过滤规则(**拷贝**;改返回值不影响世界)。
   *
   * ★ WS-FND-119:动作层要「再加一条规则」就必须先读到已有的那几条
   *   (`systems/intake.ts` 的 `addSortFilter` 只合并不覆盖整表 —— `sortHarvest`
   *   走「第一条命中」,别的道号的规则必须原样留着)。没有这个读口时,动作层只能
   *   `setSortFilters([新的一条])` ⇒ 每放一台 429 就把上一台的规则抹掉,
   *   而回执看起来完全正常。
   */
  sortFilters(): { lane: number; itemIds: number[] }[] {
    return this.roomSystemsState.sortFilters.map((f) => ({ lane: f.lane, itemIds: [...f.itemIds] }));
  }

  /**
   * 播种:**只有耕地(内容表 301)**上能种。
   *
   * 「是不是耕地」在这里判(不在纯函数里)是因为**只有世界知道地形**:
   * `systems/wiring.ts` 的 `plantCrop` 无 IO、无地形,它不猜。
   */
  plantCrop(x: number, y: number, cropId: number, matureDays?: number): { ok: boolean; reason: string } {
    if (!this.inWorld(x, y)) return { ok: false, reason: `坐标 ${x},${y} 在世界外` };
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    const floor = this.grid.floorIdAt(gx, gy);
    if (floor !== WorldSim.CROP_SOIL_ID) {
      return {
        ok: false,
        reason: `这一格不是耕地(需要 ${WorldSim.CROP_SOIL_ID} 肥沃农田耕地,实得 ${floor})`,
      };
    }
    return plantCropIn(this.roomSystemsState, gx, gy, cropId, matureDays);
  }

  /** 耕地上的作物一览(**拷贝**,供网络投影与判据;改返回值不影响世界)。 */
  crops(): CropCellState[] {
    return [...this.roomSystemsState.crops.values()].map((c) => ({ ...c }));
  }

  /** 某一格的作物(没有 ⇒ `undefined`)。 */
  cropAt(x: number, y: number): CropCellState | undefined {
    const c = this.roomSystemsState.crops.get(`${Math.floor(x)},${Math.floor(y)}`);
    return c === undefined ? undefined : { ...c };
  }

  /** 累计收下来的作物(带 429 分拣道号;拷贝)。 */
  harvestLog(): HarvestRow[] {
    return this.roomSystemsState.harvest.map((h) => ({ ...h }));
  }

  /** 温室里的格集合(取**慢帧识别结果** `lastRoomScan`/`lastRoomCells`,不另做识别)。 */
  private greenhouseCells(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < this.lastRoomScan.length; i += 1) {
      if (this.lastRoomScan[i].key !== WorldSim.AUTO_GREENHOUSE_KEY) continue;
      const cells = this.lastRoomCells[i];
      if (!Array.isArray(cells)) continue;
      for (const c of cells) out.push({ x: c.x, y: c.y });
    }
    return out;
  }

  /**
   * 自动洒水器(426)的覆盖格集合 —— 每台以自身为中心的 5×5
   * (半径与「5×5」的字面量都在 `greenhouse.ts`,本方法只做坐标展开)。
   *
   * ⚠️ 全图扫描只在**有作物**时才发生(`advanceRoomSystems` 的先决条件),
   *   没有作物时这里零开销 —— 不让「加了温室」拖慢所有既有套件。
   */
  private sprinklerCoverage(): Set<string> {
    const cover = new Set<string>();
    for (let y = 0; y < this.sizeCells; y += 1) {
      for (let x = 0; x < this.sizeCells; x += 1) {
        if (this.grid.objIdAt(x, y) !== WorldSim.SPRINKLER_OBJ_ID) continue;
        for (const c of sprinklerCells(x, y)) cover.add(`${c.x},${c.y}`);
      }
    }
    return cover;
  }

  /**
   * 四系统的**慢帧推进**(温室生长 + 牧场跨日结算)。
   *
   * @param dayFraction 推进了「多少天」。慢帧默认 `SIM_SLOW_DT / WORLD_DAY_SEC`
   *        (2Hz × 1200 秒一天 ⇒ 每慢帧 1/2400 天);判据可以传 `1`(整整一天),
   *        **走的是同一个实现** —— 这一点由 `tests/WS-FND-77` 用手算的 1/2、1/4 钉住。
   */
  advanceRoomSystems(dayFraction: number = SIM_SLOW_DT / WorldSim.WORLD_DAY_SEC): {
    grown: number;
    matured: HarvestRow[];
    ranchDays: number;
    ranchProduced: number;
    ranchDropped: number;
  } {
    const frac = Number.isFinite(dayFraction) && dayFraction > 0 ? dayFraction : 0;

    /* ── A-2 温室 ── */
    let grown = 0;
    let matured: HarvestRow[] = [];
    if (frac > 0 && this.roomSystemsState.crops.size > 0) {
      /* 房间识别是慢帧产物;地形刚变过就先刷一次(脏标记由 `setCell` 维护)。 */
      if (this.roomsDirty) this.refreshRooms();
      const house = new Set(this.greenhouseCells().map((c) => `${c.x},${c.y}`));
      const cover = this.sprinklerCoverage();
      const input: GrowInput = {
        dayFraction: frac,
        night: this.isNightNow(),
        weather: this.weatherNow,
        isGreenhouse: (x: number, y: number) => house.has(`${x},${y}`),
        hasSprinkler: (x: number, y: number) => cover.has(`${x},${y}`),
      };
      const r = growCrops(this.roomSystemsState, input);
      grown = r.grown;
      matured = r.matured;
    }

    /* ── A-1 牧场:跨日结算(整数天)──
       小数部分留在 `dayFraction` 里累计,整数部分结算 —— 于是「2.4 天」
       只在第 3 天到来时才结 1 天,不会把 0.4 天折算成 0.4 份产出。 */
    this.dayFraction += frac;
    const whole = Math.floor(this.dayFraction);
    let ranchDays = 0;
    let ranchProduced = 0;
    let ranchDropped = 0;
    if (whole > 0) {
      this.dayFraction -= whole;
      /* ★ 幂等键的一维先累加再结算:被 `settleRanchOnce` 拒掉的那一拍
         (重放 / 慢帧重入)**也是**「过了一天」,键必须往前走 ——
         回退或不动都会让后续每一天都撞在同一个已结算的键上。 */
      this.roomDayIndex += whole;
      const res = this.settleRanchIfDayChanged(whole);
      ranchDays = res.days;
      ranchProduced = res.produced;
      ranchDropped = res.dropped;
    }

    this.lastRoomSystems = { grown, matured, ranchDays, ranchProduced, ranchDropped };
    return this.lastRoomSystems;
  }

  /** 最近一次四系统慢帧报告(`null` = 还没跑过)。 */
  lastRoomSystemsReport(): {
    grown: number;
    matured: HarvestRow[];
    ranchDays: number;
    ranchProduced: number;
    ranchDropped: number;
  } | null {
    return this.lastRoomSystems === null ? null : { ...this.lastRoomSystems, matured: this.lastRoomSystems.matured.map((m) => ({ ...m })) };
  }

  /**
   * 圈养名单(**投影**)。
   *
   * 唯一权威是 `mobs/taming.ts` 的「在圈标记」(该模块仍在不可达白名单里,
   * 故本文件只做投影,不 import 它 —— 也不在注释里写那个字段的名字,见本块文件头)。
   * 本方法只是把「谁在圈里 + 亲和多少」搬进来 —— 因为 `taming.ts` 仍在
   * `scripts/verify.ts` 的不可达白名单里(见本块文件头)。
   */
  setRanchPets(animals: readonly RanchAnimal[]): void {
    const out: RanchAnimal[] = [];
    for (const a of animals) {
      if (typeof a.speciesId !== 'string' || a.speciesId.length === 0) continue;
      const affinity = Number.isFinite(a.affinity) ? a.affinity : 0;
      /* ★ WS-FND-119:`petId`(可选去重键)必须**原样带进来** —— 丢掉它,
         下一次「送进牧场」就查不到「这只已经在圈里」⇒ 同一只宠物能被反复
         追加成 N 行 ⇒ N 倍产出。键缺省时不写它(判据夹具的旧形状逐字段不变)。 */
      const petId = typeof a.petId === 'string' && a.petId.length > 0 ? a.petId : null;
      out.push(petId === null ? { speciesId: a.speciesId, affinity } : { petId, speciesId: a.speciesId, affinity });
    }
    this.roomSystemsState.ranchPets = out;
  }

  /** 当前圈养名单(拷贝)。 */
  ranchPets(): RanchAnimal[] {
    return this.roomSystemsState.ranchPets.map((a) => ({ ...a }));
  }

  /**
   * 「槽里有多少饲料」——**世界地面上的 `tameItem`**。
   *
   * 为什么按世界范围统计而不是按半径:529 饲育槽的投喂半径要 owner 裁决
   * (内容表只写「自动进食」,没写距离)。按世界范围统计**不编规则**,
   * 且产出的落货点已经钉在槽上(`troughCell`),所以「喂在哪」在数据上是清楚的。
   */
  private ranchFeedStock(): Record<number, number> {
    const out: Record<number, number> = {};
    const wanted = new Set<number>();
    for (const pet of this.roomSystemsState.ranchPets) {
      const feedId = feedItemOf(pet.speciesId);
      if (feedId !== null) wanted.add(feedId);
    }
    if (wanted.size === 0) return out;
    for (const g of this.mobGround) {
      const id = groundItemId(g);
      if (!wanted.has(id)) continue;
      out[id] = (out[id] ?? 0) + g.count;
    }
    return out;
  }

  /** 饲育槽(529)所在的格;世界里没有 ⇒ `null`(产出无处可落时如实记账)。 */
  private troughCell(): { x: number; y: number } | null {
    for (let y = 0; y < this.sizeCells; y += 1) {
      for (let x = 0; x < this.sizeCells; x += 1) {
        if (this.grid.objIdAt(x, y) === WorldSim.RANCH_TROUGH_OBJ_ID) return { x, y };
      }
    }
    return null;
  }

  /**
   * 牧场日结(**A-1 的唯一调用点**:慢帧与判据口都走它)。
   *
   * 结算 → 扣地面饲料 → 产出落到饲育槽。三步的顺序是刻意的:
   * 先算出「吃掉多少 / 产出多少」,再动物化 —— 反过来会出现
   * 「饲料扣了但没结算」的半截状态(`depot.buy` 的零副作用纪律同源)。
   *
   * ## ★ WS-FND-96:幂等键在这里落地(I2 交回的第 1 处)
   *
   * 结算走 `settleRanchOnce(roomSystemsState, roomDayIndex, ...)`:同一个
   * `(ECO_RANCH, roomDayIndex)` **只成功一次**(键形 `ECO_RANCH@DAY:<n>`)。
   * `accepted: false`(重放 / 慢帧重入 / `days = 0`)⇒ **整笔跳过**:
   * 不扣地面饲料、不落货、`lastRanch` 与 `lastRanchDrop` 一位不动 ——
   * 「拒了但还是扣了一点」正是这一步要消灭的形态。
   *
   * `ranch` 因此可以是 `null`:拒掉的那一拍**没有**本次结算回执
   * (`lastRanchSettle()` 仍是上一次成功的那份,不是本次的空壳)。
   */
  settleRanchIfDayChanged(days: number): {
    days: number;
    produced: number;
    dropped: number;
    ranch: RanchDayResult | null;
  } {
    const n = Math.max(0, Math.trunc(Number.isFinite(days) ? days : 0));
    const feed = this.ranchFeedStock();
    const once = settleRanchOnce(this.roomSystemsState, this.roomDayIndex, this.roomSystemsState.ranchPets, feed, n);
    if (!once.accepted) {
      /* ★ 整笔跳过:饲料、落货、`st.lastRanch` / `st.lastBrew` 一律不动。 */
      return { days: 0, produced: 0, dropped: 0, ranch: null };
    }
    const ranch = once.result;

    /* 饲料按日结的账扣掉(地面上的那几件)。 */
    for (const row of ranch.feedConsumed) {
      this.consumeGroundItem(row.itemId, row.count);
    }

    /* 产出落货:内容表有这件物品就落到槽上;没有就**如实记缺口**。 */
    const dropped: { itemId: number; count: number; x: number; y: number }[] = [];
    const skipped: string[] = [];
    const at = this.troughCell();
    for (const p of ranch.produce) {
      const itemId = p.itemId ?? producedItemIdOf(p.name);
      if (itemId === null) {
        skipped.push(`${p.name}:内容表没有这件物品(ranch.ts 的 unresolved 同源)`);
        continue;
      }
      if (at === null) {
        skipped.push(`${p.name}:世界里没有 529 饲育槽 ⇒ 无处落货`);
        continue;
      }
      this.dropItem(at.x, at.y, itemId, p.count);
      dropped.push({ itemId, count: p.count, x: at.x, y: at.y });
    }
    this.lastRanchDrop = { dropped, skipped };
    return { days: ranch.days, produced: ranch.produce.length, dropped: dropped.length, ranch };
  }

  /** 最近一次牧场日结的回执(`null` = 还没结过)。 */
  lastRanchSettle(): RanchDayResult | null {
    return this.roomSystemsState.lastRanch;
  }

  /** 最近一次牧场落货账(哪些产出真的落地 / 哪些是内容表缺口)。 */
  lastRanchDrops(): { dropped: { itemId: number; count: number; x: number; y: number }[]; skipped: string[] } {
    return {
      dropped: this.lastRanchDrop.dropped.map((d) => ({ ...d })),
      skipped: [...this.lastRanchDrop.skipped],
    };
  }

  /**
   * A-3 炼金:`use_alchemy_furnace` 成功之后调它 ⇒ **首创冠名 + 537 陈列**。
   *
   * `affinity` / `suggestedSLogic` 缺省取 `alchemy/**` 的**中性口径**
   * (`NEUTRAL_AFFINITY = 0.7`;`s_logic = clamp(0.75 + 0.45 × affinity)`)——
   * 不在这里发明新的契合度。
   *
   * ## ★ WS-FND-96:幂等键在这里落地(I2 交回的第 2 处)
   *
   * 走 `brewInLabOnce`,键形 `ALCHEMY_LAB@ORDER:<订单号>`。`orderId` 是
   * **调用方给的请求号**(`use_alchemy_furnace` 把报文里的 `orderId` 透传下来);
   * 没给的调用点(判据夹具 / 老调用方)在这里**退化成与 `purchaseCommit` 同形状的
   * 派生键** `${actorId}#<材料升序>#${at}` —— 同一炉同一帧重放时同样被拒,
   * 而不同材料 / 不同人 / 不同帧不撞键。两种形态都走**同一张台账**
   * (`roomSystemsState.settled`),没有第二张表。
   *
   * @returns 成功时 `entry`(冠名证书那一行)+ `display`(537 的完整陈列投影)。
   *   重放 ⇒ `ok:false` + 理由,且 `craftCount` / 冠名 / `lastBrew` 一位不动。
   */
  brewAtFurnace(
    actorId: string,
    itemIds: readonly number[],
    opts: { affinity?: number; suggestedSLogic?: number; at?: number; orderId?: string } = {},
  ): {
    ok: boolean;
    reason?: string;
    first?: boolean;
    entry?: GalleryDisplayRow & { schemaJson: string };
    display: GalleryDisplayRow[];
  } {
    const affinity = Number.isFinite(opts.affinity) ? (opts.affinity as number) : NEUTRAL_AFFINITY;
    const span = S_LOGIC_BASE + S_LOGIC_SPAN * affinity;
    const suggestedSLogic = Number.isFinite(opts.suggestedSLogic)
      ? (opts.suggestedSLogic as number)
      : Math.min(S_LOGIC_CEIL, Math.max(S_LOGIC_FLOOR, span));
    const at = Number.isFinite(opts.at) ? Math.trunc(opts.at as number) : this.frameCount;
    /* 请求号:给了就用它(权威身份);没给 ⇒ 退化形态(见方法头)。 */
    const given = typeof opts.orderId === 'string' ? opts.orderId.trim() : '';
    const orderId = given !== ''
      ? given
      : `${actorId}#${[...itemIds].sort((a, b) => a - b).join('_')}#${at}`;
    const once = brewInLabOnce(this.roomSystemsState, {
      itemIds: [...itemIds],
      affinity,
      suggestedSLogic,
      discovererName: actorId,
      at,
      orderId,
    });
    if (!once.accepted) {
      return { ok: false, reason: once.reason, display: this.galleryProjection() };
    }
    const e = once.outcome.entry;
    return {
      ok: true,
      first: once.outcome.first,
      entry: {
        recipeHash: e.recipeHash,
        discovererName: e.discovererName,
        itemName: e.itemName,
        itemCategory: e.itemCategory,
        craftCount: e.craftCount,
        firstAt: e.firstAt,
        schemaJson: e.schemaJson,
      },
      display: this.galleryProjection(),
    };
  }

  /** 537「全服奇物发现博物架」的陈列投影(先发现先陈列)。 */
  galleryProjection(): GalleryDisplayRow[] {
    return galleryDisplay(this.roomSystemsState);
  }

  /* ── A-4 百货店(515 无人自助售货摊)── */

  /** 摊位库存(装配层/管理动作注入;`物品 id → 件数`)。 */
  setStallStock(stock: Readonly<Record<number, number>>): void {
    const next: Record<number, number> = {};
    for (const [k, v] of Object.entries(stock)) {
      const id = Number(k);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      next[id] = Math.trunc(v);
    }
    this.stallStock = next;
  }

  /** 摊位库存快照(拷贝)。 */
  stallStockOf(): Record<number, number> {
    return { ...this.stallStock };
  }

  /**
  /**
   * **报价**(纯判定,**零副作用**):用 `depot.buy` 在库存**副本**上算一遍。
   *
   * 为什么先报价再提交:动作层要在「扣玩家背包之前」知道这笔交易成不成立
   * (否则失败时会出现"东西扣了但没买到")。`depot.buy` 本身就是
   * 「副本上算、失败原样退回」的实现,所以报价 = 一次不提交的 buy。
   *
   * @param table 价格表;**缺省 = `CONTENT_PRICE_TABLE`**(缺省语义逐字段不变)。
   *   与 `depot.buy` 的 `table?` 是**同一个入参的纯转发**,不是第二份实现 ——
   *   它存在的理由是:内容表今天**一条价格都没写** ⇒ 缺省路径恒 `UNPRICED`,
   *   而「成交之后」才有意义的幂等/实测库存那几条判据需要一条走得通的价。
   */
  purchaseQuote(itemId: number, qty: number, table: PriceTable = CONTENT_PRICE_TABLE): BuyResult {
    return buy({ itemId, qty, stock: this.stallStock, table });
  }

  /**
   * **提交**(把报价里算出的新库存在世界上落定)。只有 `ok` 才写。
   *
   * 与 `purchaseQuote` 是**同一次**结算的两次调用(`buy` 是纯函数)——
   * 不是两份实现:两边都在调 `systems/depot.ts:buy`。
   *
   * ## ★ 幂等键(WS-FND-96:与牧场 / 炼金**同一把键、同一张台账**)
   *
   * 提交是**有副作用**的那一步,而「报价 → 提交」之间没有任何原子性保证:
   * 报文重放 / 客户端重发 / 上层重试都会走到这里。⇒ 成交走 `depot.buyOnce`,
   * 键由 `idempotency.ts:settleKeyOf('CLOUD_DEPOT', { kind: 'ORDER', orderId })`
   * 归一(`CLOUD_DEPOT@ORDER:<orderId>`),同一个键**只准成交一次**:
   * ```
   * 有 orderId  ⇒ orderId = 订单号(调用方给的权威身份)
   * 否则        ⇒ orderId = `${actorId}#${itemId}#${frameCount}`(退化形态)
   * ```
   * ★ 两条形态落在**同一个键空间、同一张台账**(`roomSystemsState.settled`)里 ——
   * 修前这里有一张私有表 `committedPurchaseKeys`,键形 `order:...` / `a#i#t`,
   * 与牧场(日)/ 炼金(订单)各说一套,重置时三处各清一处;漏一处就是静默拒单。
   * 现在三处共用一张(单一产出点 `systems/idempotency.ts`),本文件里**没有**
   * 第二张购买键表。
   *
   * 第二次(重放)⇒ `ok:false` + `replayed:true`,且**库存一位都不动**。
   * `buy` 失败(无定价 / 库存不足)**不占键**:补价 / 补货后同单号仍可成交
   * (先占键再判成败会把订单永久锁死,那是比重复结算更坏的缺陷)。
   *
   * ⚠️ 退化形态里没有 `actorId` 时两个不同玩家在同一帧买同一件会撞键 ——
   * 那是**上层没传 actorId** 的如实后果(契约:调用方应传 `{ actorId }`)。
   *
   * ## ★ 返回的 `stock` / `stockOfItem` 是**提交时**的实测值
   *
   * 不是 `purchaseQuote` 那张**旧快照**(它按报价那一刻的库存算)。两者在
   * 「报价之后、提交之前库存又被动过」时会分叉;权威只有一个:`stallStock`。
   *
   * @param opts.actorId 发起者(退化形态的键的一维;缺省 ⇒ 见上)
   * @param opts.orderId 订单号(给了就以它为准,不再看 actorId / tick)
   * @param opts.table 价格表;缺省 = `CONTENT_PRICE_TABLE`(与 `purchaseQuote` 同一入参)
   */
  purchaseCommit(
    itemId: number,
    qty: number,
    opts: { actorId?: string; orderId?: string; table?: PriceTable } = {},
  ): {
    ok: boolean;
    cost: number;
    reason: string;
    /** ★ **提交时**的库存快照(实测值,不是报价的旧值)。 */
    stock: Record<number, number>;
    /** ★ **提交时**该物品的件数(同上)。 */
    stockOfItem: number;
    /** 是否因**同一个幂等键已成交过**而被拒(重放)。 */
    replayed: boolean;
  } {
    const tick = this.frameCount;
    const given = typeof opts.orderId === 'string' ? opts.orderId.trim() : '';
    const orderId = given !== '' ? given : `${opts.actorId ?? ''}#${itemId}#${tick}`;
    const once = buyOnce(this.roomSystemsState.settled, {
      itemId,
      qty,
      stock: this.stallStock,
      table: opts.table ?? CONTENT_PRICE_TABLE,
      orderId,
    });
    if (!once.accepted) {
      /* 重放 或 `buy` 被拒:两条路都**不做任何写入**(`stallStock` 一位不动)。 */
      return {
        ok: false, cost: 0, replayed: once.replayed, reason: once.reason,
        stock: { ...this.stallStock },
        stockOfItem: this.stallStock[itemId] ?? 0,
      };
    }
    const r = once.result;
    this.stallStock = r.stock;
    return {
      ok: true, cost: r.cost, replayed: false, reason: r.reason,
      /* 实测:提交后的 `stallStock`(权威),不是 `purchaseQuote` 的旧快照。 */
      stock: { ...this.stallStock },
      stockOfItem: this.stallStock[itemId] ?? 0,
    };
  }

  /* ── C:料理 3 字段 → 物理层的**单点推送** ── */

  /**
   * ★ 把 `moveMul` / `gravityMul` / `jumpMul` 推给物理层。
   *
   * 与 `syncFoodFriction` 同一条纪律:**只推不算**(结算点在 `physics/world.ts`
   * 的 `stepBody` / `jump`;这里再乘一次就是平方)。
   *
   * 中性(`=== 1`)**必须撤掉**设置而**不是**推 1:物理层的三张旁表以
   * 「有没有记录」区分「中性」与「已设置」,推 1 会让「有没有 buff」这个
   * 可观测事实被抹平(同 `muOverride` 的中性值 0)。
   */
  private syncFoodPhysics(): void {
    for (const id of this.vitals.ids()) {
      const t = foodPhysicsOf(this.buffsOf(id));
      if (t.speedCapMul !== null) this.physics.setSpeedCap(id, BASE_MOVE_SPEED * t.speedCapMul);
      else this.physics.clearSpeedCap(id);
      if (t.gravityMul !== null) this.physics.setGravityMul(id, t.gravityMul);
      else this.physics.clearGravityMul(id);
      if (t.jumpMul !== null) this.physics.setJumpMul(id, t.jumpMul);
      else this.physics.clearJumpMul(id);
    }
  }

  /**
   * 起跳(`jumpMul` 的**应用口**)。
   *
   * 仓库里原本**没有**跳跃通道(`physics/carry.ts` 的 `JUMP_VZ` 零消费点),
   * 所以这里给一个薄口:初速由调用方给(内容/物理层的既有常量),
   * `jumpMul` 的乘区在 `PhysicsWorld.jump` 里只结算一次。
   */
  jumpPlayer(playerId: string, baseVz: number): number | null {
    return this.physics.jump(playerId, baseVz);
  }

  /** 采集乘子(602「伐木与采矿速度 +20%」)—— 归属到**发起采集的玩家**。 */
  gatherMulOfPlayer(playerId: string): number {
    return gatherMulOfMods(this.buffsOf(playerId));
  }

  /* ══════════ ★ B:归档回滚**真的应用**到世界(此前计划层是纯数据)══════════
   *
   * `server/src/world/archive.ts` 的 `planRestore()` 产出的是**自足的操作清单**
   * (`world` / `player` / `chunk` / `mob` / `ground`),`applyRestorePlan()` 把它
   * 走成一份「旧世界描述」。那份描述此前**没有任何消费者** —— 归档能写、
   * 计划能算,而世界回不去。本方法就是那个消费者:把描述**落回 `WorldSim`**。
   *
   * ## 判据(见 `tests/WS-FND-78`)
   * ```
   * 归档(sink 捕获字节)→ 重置(新种子)⇒ 世界已变 → applyRestore(plan)
   *   ⇒ 再归档一次,两份解码结果**逐字段相等**(地形块字节 / 玩家 / seed / 帧号)
   * ```
   *
   * ## 「刻意不做」的边界(随 v2 收窄,如实记账,不假装)
   * 1 **`sizeCells` 不还原**:网格 / 流体场 / 物理边界都是按它构造的,换尺寸 =
   *    换世界实例。尺寸不同 ⇒ 本方法**拒绝**(返回 `ok:false`),不改一半。
   *    ★ v2 的流体场尺寸走**同一条闸**:不符就**在任何改动之前**拒绝(见方法内注释)。
   * 2 **流体水位:v1 归档没有 ⇒ 按不可用处理;v2 有则还原**。v1 头里没有
   *    `fluid` ⇒ 计划里没有 `fluid` op ⇒ 液面按 `rebuildWorld` 后的空地重新开始;
   *    v2 有 ⇒ 逐格 `fluid.setCell({ amount })` 铺回去(未列出的格保持重建值,
   *    **不清零** —— 清零会把「归档里没有的水」也一并抹掉)。
   * 3 **玩家血量与等级上限:v1 归档没有 `hp` ⇒ 按不可用处理;v2 有则还原**。
   *    ★ 玩家分支的顺序是**硬约束**(换序静默出错,见方法内注释):
   *    ```
   *    ① 等级(progresses) → ② 上限(maxHpForLevel + syncMaxHp) → ③ hp → ④ downed
   *    ```
   *    ① 等级先落(v2 头里逐玩家写好);② 上限**复用** `maxHpForLevel`(唯一算子)
   *    + `syncMaxHp`(vitals 唯一写入口),**不另写**派生公式;③ hp 原样交 `revive`
   *    (钳制只在它那里);④ `downed` 由本层重算(hp ≤ 0 ⇒ 倒地,避免「血量 0 不倒地」)。
   *    ⚠️ 若把 ③ 挪到 ② 之前:hp 会被 `addPlayer` 刚登记的构造缺省上限
   *    `PLAYER_BASE_HP`(100)钳住 ⇒ 高等级玩家的归档血量**静默回滚成 100**。
   *    ② 之前的 `level` 写回是它的前提(`levelOf` 读的就是这一份)。
   *    v1 头里没有 `hp` ⇒ 上限照样按等级抬到位,`hp` 由 `revive` 缺省填满
   *    (= 当前 `maxHp`,**不填一个 100** —— 高等级玩家填 100 不是满血)。
   *
   * ## ★ R14 失败分类 + 「失败时世界一字未改」
   *
   * 三道闸(**纯读,全部在 `rebuildWorld` 之前**)依次是:
   * ```
   * 1 形状(plan / ops / 逐 op 形状)        ⇒ code 'shape'
   * 2 尺寸(world.sizeCells / fluid 边界)    ⇒ code 'size'
   * 3 预解码(每一块 chunk 的字节)          ⇒ code 'bad-archive'
   * ```
   * 第 3 道是 R14 的落点:改前块体解码夹在写入中间(重建完、玩家清完才解),
   * 坏字节抛出的后果是「世界已经被拆了一半」,而且异常还**绕过了本方法的回执**。
   * 现在**先在闸里全部解完**存进 `gate.chunks`,写入阶段只做搬运 ⇒ 三类失败都
   * 满足「世界一字未改」,且一律以 `{ ok:false, code, reason }` 返回、不抛。
   * 写入阶段的意外抛错归类为 `internal`(回执会写明「可能已被部分修改」)。
   */
  applyRestore(plan: RestorePlan): {
    ok: boolean;
    /** ★ R14 失败分类(见 `RESTORE_FAIL`);`ok:true` 时不带这个键。 */
    code?: RestoreFailCode;
    reason?: string;
    applied?: { chunks: number; players: number; mobs: number; ground: number; fluid: number; seed: number; frame: number };
  } {
    /* 0 闸:纯读。意外抛错也归 `internal`,且此时**还没写过任何东西**。 */
    let gate: RestoreGate;
    try {
      gate = this.restorePreflight(plan);
    } catch (err) {
      return {
        ok: false,
        code: RESTORE_FAIL.INTERNAL,
        reason: `内部异常(${thrownText(err)})—— 回滚在**任何写入之前**中止,世界一字未改`,
      };
    }
    if (!gate.ok) return { ok: false, code: gate.code, reason: gate.reason };

    /* 1..7 写入。意外抛错归 `internal`:写入阶段可能已经改过世界,措辞如实说。 */
    try {
      return this.applyRestoreWrite(gate, plan);
    } catch (err) {
      return {
        ok: false,
        code: RESTORE_FAIL.INTERNAL,
        reason: `内部异常(${thrownText(err)})—— 写入阶段抛出,世界可能已被部分修改`,
      };
    }
  }

  /**
   * `applyRestore` 的**写入**半边(闸已过 ⇒ 这里拿到的计划「形状/尺寸都对、
   * 块体字节已全部解码」)。
   *
   * ⚠️ 顺序是既有语义的一部分(见 `applyRestore` 的 docblock):重建 → 身份 →
   * 地形 → 玩家 → 水位 → 生物 → 地面 → 时钟。
   */
  private applyRestoreWrite(gate: Extract<RestoreGate, { ok: true }>, plan: RestorePlan): {
    ok: boolean;
    reason?: string;
    applied?: { chunks: number; players: number; mobs: number; ground: number; fluid: number; seed: number; frame: number };
  } {
    /* 1 内存重建(地形/物理/电路/生物全部换成新实例,种子用**归档的**)。 */
    this.rebuildWorld(gate.seed);
    /* 2 世界身份:群系可还原(只影响刷怪配表的键)。 */
    this.biomeName = gate.biome;

    /* 3 地形块:**闸里已经全部解完**(`gate.chunks`),这里只做搬运 ——
       解码异常不可能发生在「世界已重建、玩家已清空」之后(见 R14 注释)。
       块体字节原样搬回(`Chunk.deserializeSnapshot` 仍是唯一解码器,不在这里写第二份)。 */
    let chunks = 0;
    for (const c of gate.chunks) {
      this.grid.chunks.set(chunkKey(c.cx, c.cy), c.chunk);
      chunks += 1;
    }

    /* 4 玩家:`rebuildWorld` 会把**现有**玩家送回出生点 ⇒ 先清空,再按归档重建
       (归档里没有的玩家不该留在"回到归档前"的世界里)。 */
    for (const id of [...this.playerIds]) {
      this.physics.remove(id);
      this.playerIds.delete(id);
    }
    let players = 0;
    for (const op of plan.ops) {
      if (op.kind !== 'player') continue;
      this.spawnPoints.delete(op.id);
      this.addPlayer(op.id, op.x, op.y);
      const b = this.physics.bodies.get(op.id);
      if (b !== undefined) b.z = op.z;
      /* ★★ 顺序是**硬约束**(与 `restoreFromProfile` 同一条纪律;换序**静默出错**):
         ```
         ① 等级  →  ② 上限  →  ③ hp  →  ④ downed
         ```
         (1) `progressOf().level` 是权威等级(v2 头里逐玩家写好)。
         (2) 上限**复用**既有的唯二入口:`maxHpForLevel`(上限的唯一算子 —— 纯转发
            `statsAtLevel` + 料理 `hpFlat` + 房间乘区)+ `syncMaxHp`(vitals 的
            唯一写入口)。这里**不写** `100 + 15*(lv-1)` —— 那是第二份派生公式,
            正是 W1 的成因。
         (3) hp 原样交给 `revive`,钳制(`0 ≤ hp ≤ maxHp`)**只**在它那里。
         ⚠️ 反例(先 hp 后上限):`revive` 拿**当前**上限钳值,而 `addPlayer` 刚
            登记的 `maxHp` 是构造缺省 `PLAYER_BASE_HP`(100)⇒ 5 级玩家归档里
            的 160 血被钳成 100,归档值**当场丢**且**不报错**。
            这就是 `restoreFromProfile` 第 3 步注释里记的同一个坑,这里由
            `tests/WS-FND-83` 钉住。 */
      if (Number.isFinite(op.level)) this.progressOf(op.id).level = Math.trunc(op.level);
      /* (2) 等级 → 上限。`levelOf` 取的是**上一步写回的**权威等级(没档案 = 1)。 */
      const derived = this.maxHpForLevel(op.id, this.levelOf(op.id));
      if (derived !== null) this.syncMaxHp(op.id, derived);
      /* (3)(4) 血量:v2 有 `hp` 才写回;v1 缺键 = 不可用 ⇒ 满血
         (`revive` 无参 = `hp = maxHp`,**不填一个 100** —— 上限此时已经是等级
         派生值,填 100 就等于凭空扣血)。
         倒地**自己重算**:`revive` 恒清 `downed`,若把「hp ≤ 0 ⇒ 倒地」留给它
         就永远不成立(血量 0 却不倒地)。判据唯一输入是先写好的 `hp`。 */
      if (op.hp !== undefined) this.vitals.revive(op.id, op.hp);
      else this.vitals.revive(op.id);
      const v = this.vitals.get(op.id);
      if (v !== null) v.downed = v.hp <= 0;
      players += 1;
    }

    /* 4.5 ★ v2 的流体水位:逐格 `setCell({ amount })` 铺回去。
       ⚠️ **不直接写 `amount[]`** —— 那会绕过活跃集合(`markActive`),这些水位
       下一帧**不会被推进**(表现成「水面不流动」而不报错,且没有任何异常)。
       未列出的格**保持 `rebuildWorld` 后的值**(空场 = 0),不主动清零。 */
    let fluid = 0;
    for (const op of plan.ops) {
      if (op.kind !== 'fluid') continue;
      for (const l of op.levels) {
        if (this.fluid.inBounds(l.x, l.y)) this.fluid.setCell(l.x, l.y, { amount: l.amount });
      }
      fluid += 1;
    }

    /* 5 生物:重新注册(位置来自归档),血量按归档写回宿主运行时。
       ★ WS-FND-102:**同时把实例序号水位推进到已恢复的最大序号**(见 `bumpMobOrdinalForRestored`)。
       修前 `rebuildWorld` 已把它清空(那里写着"实例序号从 #1 重来"),而恢复按归档 id 重建 ⇒
       后续发号从 `#1` 起重来,**撞上刚恢复的实例**:`addMob` 同 id 不会报错、只是
       整只替换(满血 + 丢 FSM),而 `killLedger` 又按实例 id 去重 ⇒ 新那只的击杀被
       静默吞掉(经验不到账、不报错)。 */
    let mobs = 0;
    for (const op of plan.ops) {
      if (op.kind !== 'mob') continue;
      this.addMob(op.id, this.biomeName, op.x, op.y);
      this.bumpMobOrdinalForRestored(op.id);
      const rt = this.mobHost.runtimes().find((r) => r.id === op.id);
      if (rt !== undefined) {
        if (Number.isFinite(op.hp)) rt.hp = op.hp;
        if (Number.isFinite(op.maxHp)) rt.maxHp = op.maxHp;
      }
      mobs += 1;
    }

    /* 6 地面掉落。 */
    let ground = 0;
    for (const op of plan.ops) {
      if (op.kind !== 'ground') continue;
      this.dropItem(op.x, op.y, op.itemId, op.count);
      ground += 1;
    }

    /* 7 时钟:帧号是**世界时钟的唯一来源**(`hourOfDay` 由它派生)⇒ 写回去,
       钟点自动跟上(D-07 不存累加器,这里也不写第二份)。 */
    this.frameCount = Math.max(0, Math.trunc(gate.frame));
    this.syncPlayers();
    /* 地形变了 ⇒ 房间识别必须重算。 */
    this.roomsDirty = true;
    return {
      ok: true,
      applied: { chunks, players, mobs, ground, fluid, seed: this.worldSeed, frame: this.frameCount },
    };
  }

  /**
   * ★ R14 的**闸**(纯读,零写入):形状 → 尺寸 → 逐块预解码。
   *
   * 拒绝一律返回 `{ ok:false, code, reason }`;**任何一条不满足,世界一字未改**
   * —— 因为整个方法都在 `rebuildWorld` 之前跑完(这正是改前的缺陷所在:
   * 解码夹在写入中间,坏字节只会在「世界已经被拆一半」时才炸)。
   *
   * ## 为什么预解码是「临时结构」而不是「解一块写一块」
   *
   * 写入阶段要按 `gate.chunks` 原样搬运;解码是纯函数(`Chunk.deserializeSnapshot`
   * 只读字节、写新 `Chunk` 实例,不碰世界),所以「先全部解到临时数组」既满足
   * 「失败时世界不变」,也不改变成功路径的结果(块体字节逐位相同)。
   *
   * ## 错误分类
   *
   * - `RangeError`(`Chunk.deserialize` 缓冲不足 / `decodeRoofRle` 截断)⇒ 坏档;
   * - 其他异常 ⇒ `internal`(形状闸已经把「不是字节 / 空缓冲」挡在 `shape`)。
   */
  private restorePreflight(plan: RestorePlan): RestoreGate {
    if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.ops)) {
      return {
        ok: false,
        code: RESTORE_FAIL.SHAPE,
        reason: '回滚计划形状不对(需要一个带 ops 数组的对象)',
      };
    }
    const worldOp = plan.ops.find((o) => o.kind === 'world');
    if (worldOp === undefined || worldOp.kind !== 'world') {
      return {
        ok: false,
        code: RESTORE_FAIL.SHAPE,
        reason: '回滚计划里没有 world 段 ⇒ 身份与时钟无法还原',
      };
    }
    if (worldOp.sizeCells !== this.sizeCells) {
      return {
        ok: false,
        code: RESTORE_FAIL.SIZE,
        reason: `世界边长不可回滚(归档 ${worldOp.sizeCells} 格 vs 当前 ${this.sizeCells} 格)`
          + ' —— 网格/流体/物理边界都按这个数构造',
      };
    }

    /* ★ v2 的流体场尺寸:**任何改动之前**校验(与上一条同处一道闸)。
       水位场的边界按世界边长构造 ⇒ 尺寸不符就只能拒绝;若挪到重建之后才发现,
       `WS-FND-78` 的「拒绝时世界一字未改」就已经破了(那时地形/玩家都动过了)。 */
    const fluidOp = plan.ops.find((o) => o.kind === 'fluid');
    if (
      fluidOp !== undefined && fluidOp.kind === 'fluid'
      && (fluidOp.width !== this.fluid.width || fluidOp.height !== this.fluid.height)
    ) {
      return {
        ok: false,
        code: RESTORE_FAIL.SIZE,
        reason: `流体场尺寸不可回滚(归档 ${fluidOp.width}×${fluidOp.height} vs 当前 `
          + `${this.fluid.width}×${this.fluid.height}) —— 水位场边界按世界边长构造`,
      };
    }

    /* 逐 op 形状(纯数据):任何一条坏 ⇒ `shape`,且此时**还没有写过任何东西**。 */
    for (const op of plan.ops) {
      const shapeErr = restoreShapeError(op);
      if (shapeErr !== null) {
        return { ok: false, code: RESTORE_FAIL.SHAPE, reason: `回滚计划${shapeErr} ⇒ 拒绝(世界一字未改)` };
      }
    }

    /* ★ R14:块体**全部解完再写**。坏字节在这里变成回执,而不是写入中途的异常。 */
    const chunks: { cx: number; cy: number; chunk: Chunk }[] = [];
    for (const op of plan.ops) {
      if (op.kind !== 'chunk') continue;
      let chunk: Chunk;
      try {
        chunk = Chunk.deserializeSnapshot(op.bytes);
      } catch (err) {
        const bad = err instanceof RangeError;
        return {
          ok: false,
          code: bad ? RESTORE_FAIL.BAD_ARCHIVE : RESTORE_FAIL.INTERNAL,
          reason: bad
            ? `坏档:地形块 (${op.cx},${op.cy}) 解不开(${thrownText(err)})⇒ 拒绝,世界一字未改`
            : `内部异常(${thrownText(err)})⇒ 拒绝,世界一字未改`,
        };
      }
      chunks.push({ cx: op.cx, cy: op.cy, chunk });
    }

    return { ok: true, seed: worldOp.seed, biome: worldOp.biome, frame: worldOp.frame, chunks };
  }

  tick(): SimFrameReport {
    this.frameCount += 1;
    const frame = this.frameCount;
    const isSlow = frame % FAST_PER_SLOW === 0;
    /* ★ D-07:世界时钟按**快帧步长**累加(与物理同一口径),不读系统时钟。 */

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
        /* ★ R18:额度不够 ⇒ 这一帧只「延后」了流动(`deferredCells > 0`),
           水位一格未改、剩下的活跃格留在场里等下一帧 —— 这是可观测的**延后**,
           不是「水不流」。口径见 `FluidField.step` 的 docblock。 */
        this.lastFluidDeferredCells = fr.deferredCells;
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

      /* ── 慢帧 2Hz:WS-11 对局运行时(task-84,缺口 A)──
       *
       * ★ **刻意放在 `if (this.wiringOn)` 块之外。**
       * 我第一版顺手写在 `tickLogisticsStep()` 后面(即块内 L3686 之后),
       * 那会让「派对模式能不能推进」取决于**电路开关** ——
       * `new WorldSim({ wiring: false })` 时整个对局静默冻结,
       * 而 `wiring:false` 是**合法的构造参数**(world_sim.ts:718
       * `this.wiringOn = opts.wiring !== false`),测试与无电路存档都会用到。
       * ⇒ 表现是「没通电的房间开不了派对」,不报错、只是不推进。
       *
       * 顺序放在物流之后:本步骤读 `afkRuns` / `partyRun`,两者都是
       * **房间推过来的事实**(`setPlayerDozing` / `startPartyRun`),
       * 不读本帧的电路或地形,故与前面各步无依赖。
       * 放这里只为「玩家状态推进同处一地」便于阅读。 */
      this.tickPartyStep();

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

      /* ── 慢帧 2Hz:料理 buff 计时(`USE_ITEM` 吃下的那一半)──
         放在房间效果之后无依赖;过期即删,所以"吃完过一会儿就没了"是可观察的。 */
      this.tickFoodBuffs();
      /* ★ D-12:把滑溜料理的 μ 乘区推给物理层(结算点只在 physics,这里只推乘子)。 */
      this.syncFoodFriction();
      /* ★ WS-FND-77(C 线):料理的另外三个字段 —— `moveMul` / `gravityMul` /
         `jumpMul` —— 推给物理层。位置紧贴 `syncFoodFriction`:
         两者读的是**同一份**合并 buff(`buffsOf`),分开写会让
         「同一帧里摩擦更新了而速度上限没更新」成为可能。 */
      this.syncFoodPhysics();

      /* ★ WS-FND-77 / D-19(A 线):四个房间系统的慢帧 —— 温室生长 + 牧场跨日结算。
         ## 为什么放在这里
         · 必须在 `tickRoomEffects()` **之后**:温室的「在不在温室里」读的是
           `refreshRooms()` 的房间识别结果(`lastRoomScan`/`lastRoomCells`),
           识别在本帧更早处完成(见上面的 `if (this.roomsDirty) this.refreshRooms()`)。
         · 必须在 `tickFoodBuffs()` **之后**:两处都以「天/秒」为量纲,
           但 buff 过期不该影响本帧的作物生长判定(读的是世界天气与钟点)。
         · **不能放快帧**:`cellGrowth` 的口径是「每天」,而 `advanceRoomSystems`
           的默认参数是 `SIM_SLOW_DT / WORLD_DAY_SEC`;放快帧会让生长速度 ×10
           (这与流体/电路放快帧是同一类错误,见文件头的「10:1 不变量」)。 */
      this.advanceRoomSystems();
      /* ── 慢帧 2Hz:活人泡泡的困住计时(227 的活人半边)── */
      this.tickLiveBubbles();

      /* ── 慢帧 2Hz:幽灵泡泡与救援(task-44)──
         读 `vitals.downed`(VitalsSystem 的瞬时判定),负责其后的持续状态:
         建泡泡 / 漂移计时 / 队友触摸救援。放在房间效果之后无依赖,
         取「与其它玩家状态推进同处一地」便于阅读。 */
      this.tickKnockback();
    this.tickDowned();

      /* ── 慢帧 2Hz:刷怪决策 ── */
      if (this.mobsOn) {
        /* ★ 2026-11-14:这块此前**只有判定、没有动作**。实测
           `assemble({ mobs: true })` 推进 600 帧 ⇒ `state.wildlife` 仍是 **0 条**。
           三个问题叠在一起:
             1. `biome: 'PLAINS'` **不在 `BIOME_SPAWN` 表里**(表里是 MEADOW/VALLEY/
                …/RUINS)⇒ 每次都静默走 `?? BIOME_SPAWN.MEADOW` 兜底;
             2. `mobId: 'WILDLIFE'` 不是任何 `MOB_BY_ID` 里的 id ⇒ 即便真去
                `addMob` 也只会进 `unknownMobs`(空壳,`runtimeOf()` 返回 null);
             3. `spawned += 1` 只是**计数** —— `StepReport.spawned` 全仓没有
                第二个消费者,所以「判定说该刷」与「世界里多了一只」之间
                从来**没有任何代码**。
           ⇒ 现在交给 `tickSpawn()` 真的造(它自己管密度与去重)。 */
        spawned = this.tickSpawn();
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