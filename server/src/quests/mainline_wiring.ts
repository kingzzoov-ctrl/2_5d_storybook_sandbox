/**
 * **主线六步的接线层** —— 事件总线上的一条**单向管道**:世界/房间产事实,这里记进度。
 *
 * ## 为什么需要它(修前是什么样)
 *
 * `quests/mainline.ts` 是一台**六步顺序状态机**,17 条单测全绿;但**全仓没有
 * 任何地方喂它事件**(`applyEvent` 的生产调用点 = 0)⇒ 它在运行期永远是
 * 「一步没做」,玩家屏幕上的 HUD 永远停在 `□ 主线 1/6`,哪怕他已经采了木头、
 * 合了斧头、盖了房子、打死了一队怪。
 *
 * 这就是本仓反复记录的那类缺陷的**标准形态**:模块在、判据在、图里可达,
 * 只是**没有人把事实喂进去**。判据绿而玩法不动。
 *
 * ## 这条管道只有三个部件(各自只有一个)
 *
 * ```text
 * 事实        世界侧成功点(`sim/world_sim.ts`)/ 房间侧成功点(`noteCraftSuccess`)
 *    ↓  emit(MAINLINE_BUS_KIND.<x>, <x>Payload(userId, ...), userId)
 * 总线        `server/src/events/bus.ts#EventBus`(既有;每帧 `drain()` 投递)
 *    ↓  on(kind, handler)
 * 账本        `Map<userId, MainlineState>` + `applyEvent`(**六步顺序的唯一判定**)
 * ```
 *
 * **状态机不在这里重写**:本文件只做三件「搬运」以外的事 ——
 * 收窄负载的运行时类型、按 `userId` 分账、把「真推进」的那一次落账。
 * 「第几步认哪种事件 / 跳步无效 / 重复事件不重复推进」全部仍由
 * `mainline.ts#applyEvent` 一处判定(本文件**不**再判一遍,否则就是两份口径)。
 *
 * ## 负载形状**只有这一处**(为什么用 `xxxPayload()` 而不是各处写字面量)
 *
 * 生产端与消费端如果各自写键名,漂移时**不报错**:生产端发
 * `{ playerId }`、消费端读 `payload.userId` ⇒ 事件发得出来、永远读不到,
 * 症状是「啥都没发生」。本仓把它归为「两份实现」的同一族
 * (`world_sim` 的 `fluid.solid` / `isSolidAt` 双份判定)。
 * ⇒ 形状由 `xxxPayload()` 一族产出,生产端与消费端**只用它**。
 * 值类型固定为标量(总线 `EventPayload` 的契约),便于日志与断言。
 *
 * ## 分账口径(userId 从哪来)
 *
 * 每个生产者都必须给出**它自己知道的那个用户**,不许写死、不许猜:
 *
 * ```text
 * 采集 onGather         `breakBlock(x, y, actorId)` 的 actorId(动作发起者)
 * 合成 onCraft          `WorldSim.noteCraftSuccess(userId, itemId)`(房间侧推来的事实)
 * 建造 onPlace          `placeBlock(x, y, objId, actorId)` 的 actorId
 * 换区 onEnterRegion    `applyPlayerMove` / `setPlayerPos` 的 playerId
 * 击杀 onKill           `settleKill` 的参与者(距击杀点 `SHARE_RADIUS` 内,与此前
 *                       经验/赛局计分**同一条**归属口径 —— 不另立「谁补的刀」)
 * Boss onBossProgress   `damageBoss(bossId, amount, actorId)` 的 actorId
 * ```
 *
 * 拿不到 userId 的调用点(**一个都没有**)宁可**不发**:没有归属的事件
 * 记不到任何人头上,发出来只会污染「谁做了什么」的可观测值。
 *
 * ## 只读口
 *
 * `mainlineOf(userId)` 对**没见过的用户**返回**第一步的视图**(不抛、不建档)——
 * 与 `mainline.ts#mainlineState(createMainline())` 逐字段相同:HUD 与网络层
 * 不必先判「这个玩家有没有进度」。
 *
 * ⚠️ 本文件**不**驱动总线(`drain()` 由 `WorldSim.tick()` 每帧调用),
 * 也不做跨帧队列:事件在**当帧**投递完(与 `events/bus.ts` 的契约一致)。
 */

import type { EventBus, EventPayload, GameEvent } from '../events/bus.ts';
import {
  applyEvent,
  createMainline,
  mainlineState,
  onBossProgress,
  onCraft,
  onEnterRegion,
  onGather,
  onKill,
  onPlace,
  type MainlineEvent,
  type MainlineEventKind,
  type MainlineState,
  type MainlineView,
} from './mainline.ts';

/* ═══════════════════════ 1. 总线协议(事件名 + 负载形状) ═══════════════════════ */

/**
 * 六条主线事件的**总线事件名**。
 *
 * 命名跟既有事件族(`player_hit` / `cook_done` / `party_broadcast`,见
 * `sim/world_sim.ts` 里那些 `this.bus.emit(...)`)—— `snake_case` 前缀 `mainline_`:
 * 订阅方既能精确订阅一条,也能用前缀通配 `'mainline_*'` 一次全订
 * (`events/bus.ts#matches` 支持尾随 `*`,见那里的注释)。
 *
 * 类型写成 `Record<MainlineEventKind, string>`:与状态机的六种事件**逐键对齐** ——
 * 少了哪一种、或者将来状态机加了第七种,这里会在**编译期**报缺键。
 */
export const MAINLINE_BUS_KIND: Readonly<Record<MainlineEventKind, string>> = {
  gather: 'mainline_gather',
  craft: 'mainline_craft',
  place: 'mainline_place',
  enterRegion: 'mainline_enter_region',
  kill: 'mainline_kill',
  bossProgress: 'mainline_boss_progress',
};

/**
 * 六条事件的负载。
 *
 * 用 `type` 而不是 `interface`:总线负载是 `Record<string, number|string|boolean>`,
 * 而 **`interface` 没有隐式索引签名**(类型别名有)⇒ 写成 `interface` 会赋值不上,
 * 要么被迫加索引签名、要么被迫 `as` 断言(后者会把「形状对不对」这件事交给运行时)。
 */
export type MainlineGatherPayload = { userId: string; itemId: number; count: number };
export type MainlineCraftPayload = { userId: string; itemId: number };
export type MainlinePlacePayload = { userId: string; objId: number };
export type MainlineEnterRegionPayload = { userId: string; regionId: string };
export type MainlineKillPayload = { userId: string; mobId: string };
export type MainlineBossProgressPayload = { userId: string; bossId: string; hpRatio: number };

/** 任一负载(生产端 / 消费端共用的形状来源)。 */
export type MainlineBusPayload =
  | MainlineGatherPayload
  | MainlineCraftPayload
  | MainlinePlacePayload
  | MainlineEnterRegionPayload
  | MainlineKillPayload
  | MainlineBossProgressPayload;

/** 采集到 `count` 份 `itemId` 的负载(`itemId` 由世界/动作层给,不由这里判类别)。 */
export function gatherPayload(userId: string, itemId: number, count: number): MainlineGatherPayload {
  return { userId, itemId, count };
}

/** 合成出 `itemId` 的负载。 */
export function craftPayload(userId: string, itemId: number): MainlineCraftPayload {
  return { userId, itemId };
}

/** 放下 `objId` 的负载。 */
export function placePayload(userId: string, objId: number): MainlinePlacePayload {
  return { userId, objId };
}

/** 进入区 `regionId` 的负载(`regionId` 取值域见 `shared/world/design.ts#regionAt`)。 */
export function enterRegionPayload(userId: string, regionId: string): MainlineEnterRegionPayload {
  return { userId, regionId };
}

/** 击杀野生物 `mobId` 的负载(**内容层 id**,不是实例 id `mob_x#3`)。 */
export function killPayload(userId: string, mobId: string): MainlineKillPayload {
  return { userId, mobId };
}

/** Boss `bossId` 血量比例为 `hpRatio` 的负载。 */
export function bossProgressPayload(userId: string, bossId: string, hpRatio: number): MainlineBossProgressPayload {
  return { userId, bossId, hpRatio };
}

/* ═══════════════════════ 2. 负载收窄(运行时) ═══════════════════════ */

/**
 * 取一个**非空** userId;不是字符串 / 空串 ⇒ `null`(调用方跳过这条事件)。
 *
 * 为什么在消费端再收窄一次:总线只保证负载是**标量**,不保证键在、类型对
 * (`EventPayload` 是 `Record<string, ...>`)⇒ 直接 `payload.userId as string`
 * 会把「发错键」变成一个 `undefined` 当 userId 的幽灵账本条目。
 */
function userIdOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function intOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function finiteOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * 一条总线事件 → 状态机的 `MainlineEvent`;**形状不对 ⇒ `null`**。
 *
 * ⚠️ 这里**不判内容语义**(是不是自然材料 / 是不是工具 / 血量比够不够低):
 * 那些判定在 `mainline.ts#mainlineAccepts` 里**只有一处**,由它按内容表判。
 * 本函数只负责「字段在不在、类型对不对」,把垃圾拦在 `applyEvent` 之前。
 */
function eventOf(e: GameEvent): MainlineEvent | null {
  switch (e.kind) {
    case MAINLINE_BUS_KIND.gather: {
      const itemId = intOf(e.payload.itemId);
      const count = intOf(e.payload.count);
      return itemId === null || count === null ? null : onGather(itemId, count);
    }
    case MAINLINE_BUS_KIND.craft: {
      const itemId = intOf(e.payload.itemId);
      return itemId === null ? null : onCraft(itemId);
    }
    case MAINLINE_BUS_KIND.place: {
      const objId = intOf(e.payload.objId);
      return objId === null ? null : onPlace(objId);
    }
    case MAINLINE_BUS_KIND.enterRegion: {
      const regionId = strOf(e.payload.regionId);
      return regionId === null ? null : onEnterRegion(regionId);
    }
    case MAINLINE_BUS_KIND.kill: {
      const mobId = strOf(e.payload.mobId);
      return mobId === null ? null : onKill(mobId);
    }
    case MAINLINE_BUS_KIND.bossProgress: {
      const bossId = strOf(e.payload.bossId);
      const hpRatio = finiteOf(e.payload.hpRatio);
      return bossId === null || hpRatio === null ? null : onBossProgress(bossId, hpRatio);
    }
    default:
      /* 不认识的事件名 ⇒ 当没发生(总线上同帧还有别的族,不许因此抛错)。 */
      return null;
  }
}

/* ═══════════════════════ 3. 订阅器 ═══════════════════════ */

/** 只读口 + 收尾口。**没有写口**:进度只由事件推进,外部改不进来。 */
export interface MainlineWiring {
  /**
   * 该玩家的只读视图。
   *
   * 不存在的用户 ⇒ **第一步的视图**(不抛、不建档)——
   * 与 `mainlineState(createMainline())` 同一份产物。
   */
  mainlineOf(userId: string): MainlineView;
  /** 已完成步数 0..6(诊断 / 断言用;不存在 ⇒ 0)。 */
  completedOf(userId: string): number;
  /** 已经**真推进过**的玩家数(只统计落过账的,见 `attachMainline` 的注释)。 */
  readonly size: number;
  /** 取消全部订阅 + 清空账本(测试收尾与热重载用)。 */
  detach(): void;
}

/**
 * 把主线状态机接到一条事件总线上。返回只读口。
 *
 * ## 为什么入参是 `Pick<EventBus, 'on'>`
 * 本订阅器**只订阅、不发送、不驱动**:取总线的一个窄面即可 ——
 * 于是它可以被任意「能订阅的东西」驱动(既有测试夹具也是),而不会
 * 顺手把 `drain()` / `emit()` 拿去做本职之外的事。
 *
 * ## 落账只在**真推进**时发生(`after !== before`)
 * `applyEvent` 不推进时返回**入参本身**(见 `mainline.ts` 的纯函数契约)⇒
 * 「这条事件有没有让玩家前进一步」是引用比较就能判的事实。
 * 只落账推进 ⇒ 账本里**只有真的做过事的玩家**,`size` 于是有明确含义
 * (而不是「碰过任意一条主线事件的用户数」,那会被围观者的移动灌满)。
 *
 * ## 幂等 / 重复挂载
 * 多次 `attachMainline(同一总线)` 会各自记一份账(两份订阅器、两份 Map)。
 * 生产形态是**一次挂载**(装配处调一次);测试里两次挂载互不干扰也不冲突。
 */
export function attachMainline(bus: Pick<EventBus, 'on'>): MainlineWiring {
  const states = new Map<string, MainlineState>();

  /**
   * 一条事件的唯一处理路径:收窄 → 分账 → 推进 → (仅推进时)落账。
   *
   * ⚠️ **不在这里做去重**:同一类事件重复到达时该不该推进,是
   * `applyEvent` 按「当前步」判的事(`mainline.ts` FND187-4 钉住)——
   * 在这里按事件名去重会造出第二份「什么算重复」的口径。
   */
  const feed = (e: GameEvent): void => {
    const userId = userIdOf(e.payload.userId);
    if (userId === null) return;
    const ev = eventOf(e);
    if (ev === null) return;
    const before = states.get(userId) ?? createMainline();
    const after = applyEvent(before, ev);
    if (after !== before) states.set(userId, after);
  };

  /* 六条订阅按 `MAINLINE_BUS_KIND` 的键序建立(顺序固定 ⇒ 同帧事件的
     处理器调用顺序确定,与 `events/bus.ts` 的确定性契约一致)。 */
  const offs: (() => void)[] = [
    bus.on(MAINLINE_BUS_KIND.gather, feed),
    bus.on(MAINLINE_BUS_KIND.craft, feed),
    bus.on(MAINLINE_BUS_KIND.place, feed),
    bus.on(MAINLINE_BUS_KIND.enterRegion, feed),
    bus.on(MAINLINE_BUS_KIND.kill, feed),
    bus.on(MAINLINE_BUS_KIND.bossProgress, feed),
  ];

  return {
    mainlineOf(userId: string): MainlineView {
      const st = states.get(userId);
      return mainlineState(st === undefined ? createMainline() : st);
    },
    completedOf(userId: string): number {
      return states.get(userId)?.completed ?? 0;
    },
    get size(): number {
      return states.size;
    },
    detach(): void {
      for (const off of offs) off();
      states.clear();
    },
  };
}
