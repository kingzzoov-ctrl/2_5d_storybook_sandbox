/**
 * **主线六步状态机** —— 玩家「第一步做什么 / 下一步做什么」的唯一权威(纯函数,零 IO)。
 *
 * ## 为什么要有这个文件
 *
 * 采集 / 合成 / 建造 / 战斗 / 成长 / 炼金 / 派对**都已实现**,但**没有任何引导**:
 * 玩家进游戏不知道「该干什么」,系统也不知道「他第一步做完了没有」。
 * 本文件把愿景 §1 V7 要的那条循环
 * ```text
 * 采集 → 合成 → 建造 → 打怪 → 变强(Boss)
 * ```
 * 落成一台**六步 · 顺序 · 事件驱动**的状态机。
 *
 * ## 六步与「可机检条件」(条件全部由**冻结内容表**判定,不发明名单)
 *
 * ```text
 * #  id     事件(显式)                       可机检条件
 * 1  gather  onGather(itemId, count)        count ≥ 1 且 ITEM_BY_ID[itemId].category === NATURAL(§3.1)
 * 2  craft   onCraft(itemId)                ITEM_BY_ID[itemId].category === TOOL(§3.3 生产工具表)
 * 3  place   onPlace(objId)                 ITEM_BY_ID 里有 objId(方块 / 家具 / 建筑都在表里)
 * 4  travel  onEnterRegion(regionId)        regionId ∈ REGIONS[].id(design.ts,= regionAt 的返回值)
 * 5  hunt    onKill(mobId)                  mobId ∈ MOB_BY_ID(§4.2 野生动物 24 种;Boss 不算)
 * 6  boss    onBossProgress(bossId, hpRatio) bossId ∈ BOSS_BY_ID 且 hpRatio ≤ BOSS_HP_THRESHOLD(0.5)
 * ```
 *
 * 第 1 步的「自然材料」与 `server/src/net/actions/gather.ts#gatherableOf` **同一条口径**
 * (`category === NATURAL`):那边是「能不能采」,这里是「采到的是不是自然材料」——
 * 内容表加一件自然资源,两处**同时**认得,不会漂。
 *
 * ## 三条硬性质(测试逐条钉住,不是同一个开关的三次开关)
 *
 * ```text
 * 跳步无效            事件只在**当前步**被判定:第 3 步没做时,`onEnterRegion` 不推进
 *                     (FND187-2/3;把「只在当前步判定」换成「总是推进到下一步」⇒ 立刻变红)
 * 重复事件不重复推进  同一条规则的下半段:前进一步后,同一类事件不再匹配当前步(FND187-4)
 * 未知事件/未知 id 不抛 每个入口先做运行时收窄(kind / 数值 / 内容表),不认识就当没发生(FND187-7/8)
 * ```
 *
 * **为什么跳步必须无效**:六步是**有前置**的(没材料就合成不出工具、没工具就砍不动矿、
 * 没放下方块就没有自己的据点)。若事件能跳步推进,HUD 会打出「合成 2/6 ✓」而玩家背包里
 * 一件材料都没有 —— 那不是引导,是**谎报进度**。状态机宁可停在原处等真事件。
 *
 * ## 纯函数契约
 *
 * `applyEvent(state, ev)` **不改入参**,返回值有三种情形:
 * ```text
 * 事件被接受 ⇒ 新对象(completed + 1)+ completed 只 +1(跳过的步**不会**被补记)
 * 事件没被接受 / 已全通 ⇒ 返回**入参本身**(引用相等)⇒ `next !== prev` 就是「有进展」
 *                     的廉价判据,接线侧不必深比较
 * 入参是垃圾(null / NaN / 越界)⇒ 按「一步没做」处理,**不抛**
 * ```
 *
 * 状态**不可变**:`MainlineState` 只有 `completed`(已完成步数 0..6)一个字段。
 * 不计时、不轮询 —— 推进只由世界侧的事件流驱动。
 */
import { BOSS_BY_ID } from '../../../shared/constants/bosses.ts';
import { ITEM_BY_ID } from '../../../shared/constants/items.ts';
import { MOB_BY_ID } from '../../../shared/constants/mobs.ts';
import { ItemCategory } from '../../../shared/types/entities.ts';
import { REGIONS } from '../../../shared/world/design.ts';

/** 六步的 id,**顺序即推进顺序**(下标 0 = 第 1 步)。 */
export const MAINLINE_STEP_IDS = ['gather', 'craft', 'place', 'travel', 'hunt', 'boss'] as const;
export type MainlineStepId = (typeof MAINLINE_STEP_IDS)[number];

/** 步数(6)。测试 / 文档 / 接线都用它,不写死 6。 */
export const MAINLINE_STEP_COUNT = MAINLINE_STEP_IDS.length;

/** 事件类型名(与 `MainlineEvent` 的 `kind` 判别式一一对应)。 */
export type MainlineEventKind =
  | 'gather' | 'craft' | 'place' | 'enterRegion' | 'kill' | 'bossProgress';

/**
 * 一步的元数据。
 *
 * `eventKind` 是这一步认的**唯一**事件类型 —— `mainlineAccepts` 就是按它分派的,
 * 于是「错配的事件不推进」有一个**可读的结构**而不是藏在 if 里。
 */
export interface MainlineStepSpec {
  readonly id: MainlineStepId;
  /** 顺序号 1..6(必须等于下标 + 1;自洽由 FND187-13 钉住)。 */
  readonly order: number;
  readonly eventKind: MainlineEventKind;
}

export const MAINLINE_STEPS: readonly MainlineStepSpec[] = [
  { id: 'gather', order: 1, eventKind: 'gather' },
  { id: 'craft', order: 2, eventKind: 'craft' },
  { id: 'place', order: 3, eventKind: 'place' },
  { id: 'travel', order: 4, eventKind: 'enterRegion' },
  { id: 'hunt', order: 5, eventKind: 'kill' },
  { id: 'boss', order: 6, eventKind: 'bossProgress' },
];

/**
 * 第 6 步的阈值:**血量掉到一半及以下**算过(`hpRatio ≤ 0.5`)。
 *
 * 取 0.5 的理由(与手册的「护甲 / 血量阈值」同源):0.5 是**半个血条**,
 * 玩家一眼能从 Boss HUD 的血条上看出「我到底打没打到」;而阈值若放在 0.9,
 * 一次乱挥就够了,这一条就不叫「打掉一个 Boss 的护甲/血量阈值」了。
 */
export const BOSS_HP_THRESHOLD = 0.5;

/** 设计图里所有区的 id(`regionAt` 的返回值域)。穿越目标必须落在这里面。 */
export const MAINLINE_REGION_IDS: readonly string[] = REGIONS.map((r) => r.id);

/* ═══════════════════════════ 1. 事件 ═══════════════════════════ */

export interface MainlineGatherEvent {
  readonly kind: 'gather';
  readonly itemId: number;
  readonly count: number;
}

export interface MainlineCraftEvent {
  readonly kind: 'craft';
  readonly itemId: number;
}

export interface MainlinePlaceEvent {
  readonly kind: 'place';
  readonly objId: number;
}

export interface MainlineEnterRegionEvent {
  readonly kind: 'enterRegion';
  readonly regionId: string;
}

export interface MainlineKillEvent {
  readonly kind: 'kill';
  readonly mobId: string;
}

export interface MainlineBossProgressEvent {
  readonly kind: 'bossProgress';
  readonly bossId: string;
  readonly hpRatio: number;
}

/**
 * 全部事件。**显式事件驱动**:状态机不读世界、不查时间 —— 世界侧在真发生
 * (采集成功 / 合成成功 / 放下 / 进区 / 击杀结算 / Boss 掉血)时喂一条进来。
 */
export type MainlineEvent =
  | MainlineGatherEvent
  | MainlineCraftEvent
  | MainlinePlaceEvent
  | MainlineEnterRegionEvent
  | MainlineKillEvent
  | MainlineBossProgressEvent;

/** 采集到 `count` 份 `itemId`(采集动作成功回执后喂)。 */
export function onGather(itemId: number, count: number): MainlineGatherEvent {
  return { kind: 'gather', itemId, count };
}

/** 合成出 `itemId`(合成动作成功回执后喂)。 */
export function onCraft(itemId: number): MainlineCraftEvent {
  return { kind: 'craft', itemId };
}

/** 放下 `objId`(放置动作成功回执后喂)。 */
export function onPlace(objId: number): MainlinePlaceEvent {
  return { kind: 'place', objId };
}

/**
 * 进入区 `regionId`(区变化时喂;值取 `shared/world/design.ts#regionAt(x, y)`)。
 *
 * ⚠️ `camp`(中央营地)**也是**一个区:出生即在 camp ⇒ 接线方若在「区变化」时喂,
 * 玩家一进游戏就会收到 `onEnterRegion('camp')`。这是**刻意**的 —— 第 4 步不在出生点
 * 之前完成(前 3 步有前置),而把 camp 排除在外会让「在营地里造了据点但没出过门」
 * 的玩家永远卡在第 4 步。要「必须离开营地」是**产品口径**,不是本状态机的口径。
 */
export function onEnterRegion(regionId: string): MainlineEnterRegionEvent {
  return { kind: 'enterRegion', regionId };
}

/** 击杀 `mobId`(野怪死亡结算后喂)。 */
export function onKill(mobId: string): MainlineKillEvent {
  return { kind: 'kill', mobId };
}

/** Boss `bossId` 的血量比例为 `hpRatio`(0..1;Boss 掉血结算后喂)。 */
export function onBossProgress(bossId: string, hpRatio: number): MainlineBossProgressEvent {
  return { kind: 'bossProgress', bossId, hpRatio };
}

/* ═══════════════════════════ 2. 状态 ═══════════════════════════ */

/** 纯状态:只有「已完成步数」。 */
export interface MainlineState {
  /** 0..6;`MAINLINE_STEP_COUNT` = 六步全通。 */
  readonly completed: number;
}

/** 给 HUD 的只读视图(`client/src/ui/mainline_hud.ts` 的 `planMainlineHud` 吃它)。 */
export interface MainlineView {
  /** 当前步号 1..6;全通时停在 6(不越界)。 */
  readonly step: number;
  readonly stepId: MainlineStepId;
  /** 六步全通。 */
  readonly done: boolean;
  /** 整体进度 = 已完成步数 / 6(0..1)。 */
  readonly progress: number;
}

/** 新玩家的状态:一步没做。 */
export function createMainline(): MainlineState {
  return { completed: 0 };
}

/* ═══════════════════════════ 3. 运行时收窄(隐私实现) ═══════════════════════════ */

function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function asFinite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `itemId` 是不是**自然材料**(内容表类别,与 `gather.ts#gatherableOf` 同口径)。 */
function isNaturalMaterial(itemId: number): boolean {
  return ITEM_BY_ID.get(itemId)?.category === ItemCategory.NATURAL;
}

/** `itemId` 是不是**工具**(内容表 §3.3 生产工具表)。 */
function isTool(itemId: number): boolean {
  return ITEM_BY_ID.get(itemId)?.category === ItemCategory.TOOL;
}

/**
 * 把 state 收窄成合法值:合法 ⇒ **原样返回**(引用稳定);否则归一到 `[0, 6]` 整数。
 *
 * 「原样返回」是刻意的:`applyEvent` 不推进时必须回同一个引用,
 * 调用方才能用 `!==` 判「这一条事件没有进展」。
 */
function normalize(state: MainlineState): MainlineState {
  const raw = (state as { completed?: unknown } | null | undefined)?.completed;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAINLINE_STEP_COUNT) {
    return state;
  }
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return { completed: Math.min(MAINLINE_STEP_COUNT, Math.max(0, n)) };
}

/* ═══════════════════════════ 4. 判定与推进 ═══════════════════════════ */

/**
 * 第 `stepId` 步认不认这条事件(**顺序判断的唯一落点**)。
 *
 * 判序:`kind` 对不上 ⇒ 立刻 `false`;对上了再逐个收窄载荷,最后落到内容表。
 * 任何一步都不抛 —— 载荷是垃圾(null / 字符串 / NaN / 未知 id)一律当「没发生」。
 */
export function mainlineAccepts(
  stepId: MainlineStepId,
  ev: MainlineEvent | null | undefined,
): boolean {
  if (ev === null || ev === undefined || typeof ev !== 'object') return false;
  const kind: unknown = (ev as { kind?: unknown }).kind;
  switch (stepId) {
    case 'gather': {
      if (kind !== 'gather') return false;
      const itemId = asInt((ev as { itemId?: unknown }).itemId);
      const count = asInt((ev as { count?: unknown }).count);
      if (itemId === null || count === null) return false;
      /* 一次采集 0 份 = 没采到(背包满退回原地也是 0 份)⇒ 不算第一步。 */
      if (count < 1) return false;
      return isNaturalMaterial(itemId);
    }
    case 'craft': {
      if (kind !== 'craft') return false;
      const itemId = asInt((ev as { itemId?: unknown }).itemId);
      return itemId !== null && isTool(itemId);
    }
    case 'place': {
      if (kind !== 'place') return false;
      const objId = asInt((ev as { objId?: unknown }).objId);
      /* 方块 / 家具 / 建筑 / 地面都能算「我在这里站住了脚」⇒ 只要求在内容表里。 */
      return objId !== null && ITEM_BY_ID.has(objId);
    }
    case 'travel': {
      if (kind !== 'enterRegion') return false;
      const regionId = asId((ev as { regionId?: unknown }).regionId);
      return regionId !== null && MAINLINE_REGION_IDS.includes(regionId);
    }
    case 'hunt': {
      if (kind !== 'kill') return false;
      const mobId = asId((ev as { mobId?: unknown }).mobId);
      return mobId !== null && MOB_BY_ID.has(mobId);
    }
    case 'boss': {
      if (kind !== 'bossProgress') return false;
      const bossId = asId((ev as { bossId?: unknown }).bossId);
      const hpRatio = asFinite((ev as { hpRatio?: unknown }).hpRatio);
      if (bossId === null || hpRatio === null) return false;
      if (!BOSS_BY_ID.has(bossId)) return false;
      /* 比值必须在 [0, 1] 内:越界值(NaN 已挡 / 负数 / > 1)不是「打到一半」的证据。 */
      if (hpRatio < 0 || hpRatio > 1) return false;
      return hpRatio <= BOSS_HP_THRESHOLD;
    }
    default:
      return false;
  }
}

/**
 * 喂一条事件,返回**新** state(纯函数;不改入参)。
 *
 * 只判**当前步**(`MAINLINE_STEPS[completed]`)⇒ 跳步无效、重复事件不重复推进
 * 都由这一句保证。已全通时没有下一步 ⇒ 原样返回。
 */
export function applyEvent(
  state: MainlineState,
  ev: MainlineEvent | null | undefined,
): MainlineState {
  const from = normalize(state);
  const step = MAINLINE_STEPS[from.completed];
  if (step === undefined) return from;
  if (!mainlineAccepts(step.id, ev)) return from;
  return { completed: from.completed + 1 };
}

/** state → HUD 只读视图。 */
export function mainlineState(state: MainlineState): MainlineView {
  const completed = normalize(state).completed;
  const done = completed >= MAINLINE_STEP_COUNT;
  const step = done ? MAINLINE_STEP_COUNT : completed + 1;
  return {
    step,
    stepId: MAINLINE_STEPS[step - 1].id,
    done,
    progress: completed / MAINLINE_STEP_COUNT,
  };
}
