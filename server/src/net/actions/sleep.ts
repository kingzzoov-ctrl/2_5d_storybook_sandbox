/**
 * `SLEEP` —— **玩家上床睡觉**。
 *
 * ⚠️ 别与 `RoomRuntime.sleep()` / `wake()` 搞混:那是**房间休眠**(空闲暂停,
 *   把 `status` 推成 `SLEEPING`),**不是**玩家睡觉。两者名字相邻、语义无关,
 *   故本模块的公开名字一律用 `Sleep*` 的**玩家**含义(见下)。
 *
 * ## 本模块只登记「谁在睡、睡到什么时候」,不做回血
 *
 * 睡觉的**回血**已经在别处:`rooms/effects.ts` 的 `stepRoomEffects` 对「站在
 * 卧室里」的玩家按 `BEDROOM_HEAL_PER_SEC = 15` 派生 `healHp` / `napping`,
 * 由 `WorldSim` 慢帧写进**权威** `vitals`(`world_sim.ts` 的 `tickRoomEffects`)。
 * 那条路不在本次可改范围内,而且权威血量**本来就不该**由动作模块持有
 * (`vitals` 的上限截断、倒下不回血等边界都在那边)。
 *
 * ⇒ 本动作的职责被刻意收窄成一份**状态登记**:
 * ```ts
 *   入睡 ⇒ SLEEPERS[roomId].players[userId] = { sinceMs, untilMs }(随房间世代作废)
 *   睡着时再 SLEEP ⇒ 幂等(不叠加计时)
 *   离开卧室 / 被打断 / 时间到 ⇒ 结束
 * ```
 * 未来接线时,世界侧可读 `sleepStateOf()` 决定「这个人现在算不算在睡」,
 * 再把它接到既有的卧室回血/打盹判定上 —— 那时才有「睡着期间按秒回血」。
 * 现在**没有**这条读写边,故本文件**不声称**自己回血。
 *
 * ## 为什么状态放在本模块的 per-room Map
 *
 * `ActionContext` 只有一次分派的入参与宿主能力,**没有**可写的世界侧状态;
 * 而「玩家在睡觉」既不是 `RoomRuntime` 的房间状态,也不是 `vitals` 的字段。
 * 放进模块内的 `Map<roomId, Map<userId, SleepRecord>>` 有两个直接好处:
 *   1 `roomId` 分桶 ⇒ 两个房间里的同名 `playerId` 不会互相串;
 *   2 显式查询函数可被未来的世界侧/慢帧调用,不需要把 `RoomRuntime` 或
 *     `WorldSim` 交进动作层。
 *
 * ## 时钟:世界钟(游戏秒)—— 与回血/露水**同一时基**
 *
 * ★ WS-FND-174:窗口打在**世界钟**上(`sim/world_sim.ts` 的 `partyClock`:
 * `0.5s × 慢帧数`),由房间每帧推进世界后经 `noteSleepWorldSeconds()` 推来。
 * 为什么必须这样:床上的回血与露水由 `social/afk.ts#tickAfk` 按**游戏秒**累加,
 * 而打盹的**结束**由本模块的窗口决定(`sleepSource` → 世界侧 `stepDozingEntry`)
 * —— 两边任一边退回墙钟,表现就是「睡够了却还在回血 / 没睡够就停了」,且**不报错**
 * (真实帧率低于名义 20Hz 时,墙钟比世界钟快约 20%:墙上 60 秒 ≈ 世界 47.8 秒)。
 *
 * 三级取钟(逐级显式,不猜):
 * ```text
 *   1 显式 nowMs 入参   ⇒ 用它(调用方自带基准;查询侧也要一起给)
 *   2 本房有世界钟读数   ⇒ 用世界钟(生产路径:房间每帧推)
 *   3 两者都没有        ⇒ 注入的模块时钟(setSleepClock;缺省 Date.now())
 * ```
 * 第 3 级是**如实**的降级,不是静默兜底:没有世界源就没有回血/露水那条链,也就
 * 没有能与窗口错配的第二条时间线;而「这条记录用了哪个钟」由 `SleepRecord.base`
 * 记着(`sleepClockBaseOf` 可读)。
 *
 * ⚠️ 已知边界(不是两个钟的错配):窗口到期由**世界的慢帧回调**判定,而房间每帧
 * 只能推一次读数 ⇒ 到期生效时刻最多晚**一个慢帧**(0.5 世界秒)。它是世界钟上的
 * 采样延迟,回血那一侧同样按慢帧走 ⇒ 两端仍然同源。
 *
 * ## 卧室判定从哪来
 *
 * 动作**不**自己识别房间。它读世界源的 `roomEffectOf(playerId)` —— 那是
 * `rooms/effects.ts` 的判定输出(`inBedroom`),由 `WorldSim` 慢帧算出。
 * 动作层再写一遍「哪个 key 算卧室」就是本仓反复点名的**两份实现**。
 */
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/**
 * 一次睡眠的时长:**60 世界秒(游戏秒)**。★ WS-FND-174 起这是一个**时基声明**,
 * 不是「随便挑的 60 秒」—— 它量的是世界钟上的一次打盹,与床上的回血/露水
 * (`social/afk.ts#tickAfk` 按 `dt` 游戏秒累加)同源。
 *
 * 取值理由(对着本仓已有常量算,不拍脑袋):
 *   · 床上回血 `BED_HP_PER_SEC = 15`(`social/afk.ts`)/ 卧室回血
 *     `BEDROOM_HEAL_PER_SEC = 15`(`rooms/effects.ts`);
 *   · 满级生命上限 `statsAtLevel(MAX_LEVEL = 30).maxHp = 100 + 15×(30−1) = 535`
 *     (`shared/types/entities.ts`);
 *   ⇒ 60 **游戏**秒 = 900 HP > 535,一次完整睡眠足以把濒死玩家拉回满血;
 *     再长只是把「睡着」变成挂机占位。
 *
 * ⚠️ 同一个 60 在墙钟上不是同一段时间:真实帧率低于名义 20Hz 时(实测 ~16Hz)
 *   60 世界秒 ≈ 75 墙钟秒。修前本模块的窗口按**墙钟**判到期,于是「墙上睡满
 *   60 秒」只换来 47.8 世界秒的回血(≈ 717 HP 而不是 900),而**不报错**。
 *
 * ⚠️ 它与 `RoomRuntime` 的**房间休眠**、以及 `AFK_TIMEOUT_MS`(30 分钟,**墙钟**)
 *   是三条互不相干的线:这里量的是「一次上床睡多久」。
 */
export const SLEEP_DURATION_SEC = 60;
/** 同上,毫秒形态(窗口内部一律用 ms 记,免得两处各转一次)。 */
export const SLEEP_DURATION_MS = SLEEP_DURATION_SEC * 1000;

/** 一条睡眠记录(纯数据,便于回执与断言)。 */
export interface SleepRecord {
  /** 入睡时刻(ms;**在 `base` 那个钟上**)。 */
  readonly sinceMs: number;
  /** 到这一刻就算睡醒(ms;同样在 `base` 那个钟上)。 */
  readonly untilMs: number;
  /**
   * 这条窗口用的是哪个钟(见 `SLEEP_CLOCK`)。★ WS-FND-174:它让「开窗」与
   * 「判到期」两次独立调用**不靠调用方记得**就落在同一时基上(见 `sleepStateOf`)。
   */
  readonly base: SleepClockBase;
}

/**
 * 窗口的**时基**(★ WS-FND-174)。
 *
 * 为什么记录里要存它:`beginSleep` 与 `sleepStateOf` 是**两次独立调用**
 * (前者在动作层、后者在世界慢帧里),两次之间房间可能刚推上一个世界钟读数。
 * 不带这维的话,「世界钟开的窗口 + 模块时钟判到期」会把 60 游戏秒读成几百万
 * 毫秒 ⇒ 永不醒;而那种错**不报错**。
 */
export const SLEEP_CLOCK = {
  /** 世界钟(游戏秒,`0.5s × 慢帧数`)—— 生产路径。 */
  WORLD: 'WORLD',
  /** 注入的模块时钟(`setSleepClock`;缺省 `Date.now()`)= 墙钟。 */
  MODULE: 'MODULE',
} as const;
export type SleepClockBase = (typeof SLEEP_CLOCK)[keyof typeof SLEEP_CLOCK];

/** 睡眠状态查询结果。 */
export interface SleepState {
  /** 现在是否在睡(时间到会自动变成 `false`,见 `sleepStateOf`)。 */
  sleeping: boolean;
  /** 入睡时刻;未在睡为 `null`。 */
  sinceMs: number | null;
  /** 到期时刻;未在睡为 `null`。 */
  untilMs: number | null;
  /** 距离睡醒还有多少毫秒;未在睡或已到期为 0。 */
  remainingMs: number;
}

/**
 * 一个房间的睡眠登记 = **世代号 + 记录表**。
 *
 * ## 为什么必须带世代维(★ WS-FND-131 P2)
 * 修前是 `SLEEPERS[roomId][playerId]`,**没有世代**:世界重置(`RESET_WORLD` 换代)
 * 之后 `beginSleep` 仍会命中上一世代留下的记录并**原样返回它的 `untilMs`**
 * ⇒ 表现是「刚上床就已经睡了一半 / 立刻睡醒」,而且**不报错、测试也可能照绿**。
 * ⇒ 换代时 `bumpSleepGeneration` 把 `players` 整表作废;`gen` 只增不减,
 *   任何查询都只会看到**当前世代**的记录。
 */
interface SleepBucket {
  /** 世代号(每次世界换代 +1;本模块是唯一写者)。 */
  gen: number;
  players: Map<string, SleepRecord>;
}

/**
 * 房间 → (世代 + 玩家 → 睡眠记录)。
 *
 * 按 `roomId` 分桶:两个房间的 `playerId` 可以重名,不分开就会互相覆盖。
 * 本模块是**唯一写者**;没有世界源时动作会显式拒绝,不会写出「无人消费」的孤儿记录。
 */
const SLEEPERS = new Map<string, SleepBucket>();

/**
 * 注入时钟(毫秒)。默认墙钟;测试注入假时钟并推进它。
 *
 * ★ WS-FND-174:它现在只是**第三级**兜底 —— 本房有世界钟读数时(生产路径:房间
 * 每帧推)开窗与查询都走世界钟。理由见文件头「时钟」:床上的回血/露水按游戏秒
 * 累加,窗口却按墙钟判到期的话,两边会差 20%,而且**不报错**。
 */
let clockMs: () => number = () => Date.now();

/**
 * 注入时钟(**没有世界钟读数时**的时间来源):动作与查询都走它,不各自读 `Date.now`。
 * 生产里由第 2 级(房间推来的世界钟读数)接管;本口留给判据与「没有世界源」的宿主。
 */
export function setSleepClock(clock: () => number): void {
  clockMs = clock;
}

/** 恢复默认时钟(测试收尾;生产不需要)。 */
export function resetSleepClock(): void {
  clockMs = () => Date.now();
}

/* ═══════════ 世界钟读数(由房间推入;★ WS-FND-174)═══════════ */

/**
 * 房间 → **世界钟秒**。由 `RoomRuntime.step()` 每帧推进世界之后推入
 * (`noteSleepWorldSeconds`)。本模块是唯一读者;写口只有下面两个导出函数。
 *
 * 为什么由房间推、而不是本模块自己读:`sim/world_sim.ts` 不 import `net/actions/**`
 * (`sim` 不依赖 `net`),而房间是**唯一**驱动世界的人 —— 世界钟只有它读得到。
 */
const WORLD_SEC = new Map<string, number>();

/**
 * 推入本房的世界钟读数(秒)。`null` / 非有限数 = 本房**没有**世界钟(没有世界源 /
 * 老宿主 / 世界换代后帧号回退)⇒ 摘掉读数,后续开窗与查询如实退回模块时钟。
 * 幂等,每帧可调。
 */
export function noteSleepWorldSeconds(roomId: string, sec: number | null): void {
  if (sec === null || !Number.isFinite(sec) || sec < 0) {
    WORLD_SEC.delete(roomId);
    return;
  }
  WORLD_SEC.set(roomId, sec);
}

/**
 * 摘掉本房的世界钟读数(**房间实例消失**时调:`RoomRuntime.close()`)。
 * 不摘就是一处按 `roomId` 增长的泄漏 —— 这张表只有房间能回收。
 */
export function forgetSleepWorldClock(roomId: string): void {
  WORLD_SEC.delete(roomId);
}

/** 本房当前的时间基准(ms)+ 它来自哪个钟;没有世界钟读数 ⇒ 模块时钟(第 3 级)。 */
function nowFor(roomId: string): { ms: number; base: SleepClockBase } {
  const sec = WORLD_SEC.get(roomId);
  if (sec === undefined) return { ms: clockMs(), base: SLEEP_CLOCK.MODULE };
  return { ms: Math.trunc(sec * 1000), base: SLEEP_CLOCK.WORLD };
}


/** 取(必要时创建)某房间的睡眠登记桶。 */
function bucketOf(roomId: string): SleepBucket {
  let b = SLEEPERS.get(roomId);
  if (b === undefined) {
    b = { gen: 0, players: new Map() };
    SLEEPERS.set(roomId, b);
  }
  return b;
}

/**
 * 该房间睡眠登记的**世代号**(从未换过代 = 0)。**不改任何状态。**
 *
 * 这个读口的存在理由:只看 `sleepingCount` 区分不出「换过代、刚好没人睡」与
 * 「从没换过代」—— 而判据必须能区分这两种态,否则「换代」不可断言。
 */
export function sleepGenerationOf(roomId: string): number {
  return SLEEPERS.get(roomId)?.gen ?? 0;
}

/**
 * 世界**换代**:世代号 +1,并把该房间上一世代的睡眠窗口**全部作废**。
 *
 * 唯一调用点:`RoomRuntime.dispatchAction()` 里 `RESET_WORLD` 成功那一刻
 * (见 `server/src/net/room.ts` 的同段注释)。返回新世代号(便于回执/断言)。
 */
export function bumpSleepGeneration(roomId: string): number {
  const b = bucketOf(roomId);
  b.gen += 1;
  b.players.clear();
  return b.gen;
}

/**
 * **显式结束睡眠** —— 供未来接线用(被打断 / 离开卧室 / 手动唤醒)。
 *
 * 返回「此前是否真在睡」,而不是 `void`:调用方应能区分
 * 「结束了一条记录」与「本来就没在睡」,否则「中断生效」与「什么都没发生」
 * 在外部完全一样(本仓陷阱 89 的形态)。
 */
export function endSleep(roomId: string, userId: string): boolean {
  const bucket = SLEEPERS.get(roomId);
  if (bucket === undefined) return false;
  const existed = bucket.players.delete(userId);
  /* 房间桶只在「从没换过代」时才回收:换过代的桶要继续带着 `gen`,
     否则世代号会**回退**,下一轮 `bumpSleepGeneration` 会给出一个已经用过的号
     (那时「旧世代窗口」与「新世代窗口」又分不开了)。 */
  if (bucket.players.size === 0 && bucket.gen === 0) SLEEPERS.delete(roomId);
  return existed;
}

/**
 * 登记一次睡眠。**幂等**:已在睡且未到期 ⇒ 原样返回旧记录,**不叠加计时**。
 * 到期后再次入睡会得到**新的**窗口(旧的过期记录在此被覆盖)。
 *
 * ## 窗口的时基(★ WS-FND-174)
 *
 * `nowMs` 不给 ⇒ 按**本房的时间基准**取(有世界钟读数就用世界钟,否则用注入的
 * 模块时钟,见 `nowFor`);给了 ⇒ 就用给的那个,并把这条记录标成 `MODULE`
 * (调用方自带基准 —— 查询侧必须也一起给 `nowMs`,否则两边不同源)。
 *
 * 返回值里的 `nowMs` 是**这一次用掉的读数**:调用方算 `remainingMs` 时复用它,
 * 不要在下一行再读一次钟(两次读数之间可能跨过一个慢帧)。
 */
export function beginSleep(
  roomId: string,
  userId: string,
  nowMs?: number,
): { record: SleepRecord; alreadySleeping: boolean; nowMs: number } {
  const resolved = nowMs === undefined
    ? nowFor(roomId)
    : { ms: nowMs, base: SLEEP_CLOCK.MODULE as SleepClockBase };
  const now = resolved.ms;
  const bucket = bucketOf(roomId);
  const cur = bucket.players.get(userId);
  if (cur !== undefined && cur.untilMs > now) {
    /* 已在睡 ⇒ 连**它自己的时基**一起原样返回(不把新读数塞进旧窗口)。 */
    return { record: cur, alreadySleeping: true, nowMs: now };
  }
  const record: SleepRecord = {
    sinceMs: now,
    untilMs: now + SLEEP_DURATION_MS,
    base: resolved.base,
  };
  bucket.players.set(userId, record);
  return { record, alreadySleeping: false, nowMs: now };
}

/**
 * **显式查询**(给未来接线用):这个玩家现在算不算在睡。
 *
 * 「时间到」在**这里**落地:过期记录被顺手清掉并返回 `sleeping: false`。
 * 这样「睡到什么时候」只有一份事实,不需要每个调用方各自比一次时间。
 *
 * ★ WS-FND-174:时基**跟着记录走** —— 没给 `nowMs` 时按这条记录当初用的那个钟读
 * (`base`),不是无条件读模块时钟。否则「世界钟开窗 + 墙钟判到期」会把一条
 * 60 游戏秒的窗口判成「还差几百万毫秒」(= 永不醒),而**不报错**。
 */
export function sleepStateOf(
  roomId: string,
  userId: string,
  nowMs?: number,
): SleepState {
  const rec = SLEEPERS.get(roomId)?.players.get(userId);
  if (rec === undefined) {
    return { sleeping: false, sinceMs: null, untilMs: null, remainingMs: 0 };
  }
  const now = nowMs ?? (rec.base === SLEEP_CLOCK.WORLD ? nowFor(roomId).ms : clockMs());
  if (rec.untilMs <= now) {
    endSleep(roomId, userId);
    return { sleeping: false, sinceMs: null, untilMs: null, remainingMs: 0 };
  }
  return {
    sleeping: true,
    sinceMs: rec.sinceMs,
    untilMs: rec.untilMs,
    remainingMs: rec.untilMs - now,
  };
}

/** 该房间当前在睡的玩家数(断言「失败路径没写状态」用)。 */
export function sleepingCount(roomId: string): number {
  return SLEEPERS.get(roomId)?.players.size ?? 0;
}

/**
 * 清空全部登记(测试隔离用;生产不需要)。
 *
 * ★ WS-FND-174:各房的**世界钟读数**一起清 —— 它也是模块级按房状态,留着会让
 * 下一个用例的第一次查询直接命中上一轮的世界钟(生产里由 `RoomRuntime.close()`
 * 逐房摘掉,见 `forgetSleepWorldClock`)。
 */
export function clearSleepRegistry(): void {
  /* 连**世代号**一起清(清掉房间桶 ⇒ gen 归零)⇒ 测试之间不带着上一轮的 gen 起跑。 */
  SLEEPERS.clear();
  WORLD_SEC.clear();
}

/**
 * 某房某玩家当前窗口用的是**哪个钟**(`WORLD` = 世界钟 / `MODULE` = 注入的模块
 * 时钟);未登记返回 `null`。
 *
 * 为什么要有这个读口:窗口的**时基**是本模块唯一的时间契约,而它取决于「房间推过
 * 世界钟读数没有」—— 只看 `untilMs` 分不出「世界钟 60 秒」与「墙钟 60 秒」
 * (两个数的字面值可以一模一样)。与 `sleepGenerationOf` 同一取舍:不为断言省读口。
 */
export function sleepClockBaseOf(roomId: string, userId: string): SleepClockBase | null {
  return SLEEPERS.get(roomId)?.players.get(userId)?.base ?? null;
}

/**
 * `SLEEP` 在世界源上真正需要的那**一项**能力。
 *
 * `ActionContext.host` 声明为 `WorldSaveHost`,而 `roomEffectOf` 目前不在那份
 * 结构化契约里(`net/room.ts` 的可选成员清单)。本次改动范围只允许碰本文件,
 * 故用一个**局部窄类型**读它:缺这个方法时动作显式回 `INVALID`,而不是静默跳过。
 * ⚠️ 若将来把 `roomEffectOf` 正式写进 `WorldSaveHost`,删除本类型即可 —— 届时
 *   两侧形状一致,这里的 `unknown` 转换也就可以收掉。
 */
type RoomEffectCapableHost = {
  roomEffectOf?(id: string): { inBedroom: boolean } | undefined;
};

/**
 * `SLEEP`:在卧室里上床睡觉。
 *
 * 判序与回执(逐条对着判据):
 *   1 `authorize` 不通过 ⇒ `PERMISSION`。`SLEEP` 的权限位是 `baseline`
 *     (`ACTION_PERMISSION`),而 `GUEST` 也带 `baseline` ⇒ **guest 可以睡**:
 *     这里不发明额外规则,只按真实权限矩阵裁决。
 *   2 拿不到房间效果状态(不在世界里)⇒ `INVALID`。
 *   3 不在卧室 ⇒ `INVALID`;若此前在睡,顺手**结束**它(人已不在床上 = 中断)。
 *      失败路径**不写**新状态。
 *   4 在卧室 ⇒ 登记睡眠并回 `OK` + `effect`(客户端可感知)。
 *      已在睡 ⇒ 仍回 `OK`,但 `untilMs` 不变(`alreadySleeping: true`)。
 */
export const sleep: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  const host = ctx.host as unknown as RoomEffectCapableHost | null;
  const eff = host === null ? undefined : host.roomEffectOf?.(ctx.actorId);
  if (eff === undefined) {
    return {
      ok: false, kind: 'INVALID',
      reason: '拿不到房间效果状态(玩家不在世界里或世界源不支持)⇒ 无法确认是否在卧室',
    };
  }

  const roomId = ctx.state.roomId;
  if (!eff.inBedroom) {
    /* 人已经不在卧室 ⇒ 这不是一次新的入睡,而是一次**中断**:
       若此前登记过睡眠,在这里结束它(判据只认 effects.ts 的 `inBedroom`)。 */
    const wasSleeping = endSleep(roomId, ctx.actorId);
    return {
      ok: false, kind: 'INVALID',
      reason: wasSleeping
        ? '已离开卧室 ⇒ 睡眠结束(只有站在卧室里才能继续睡)'
        : '只有站在卧室(COZY_BEDROOM)里才能睡觉',
    };
  }

  /* ★ WS-FND-174:窗口的两端都打在**本房的时间基准**上(生产 = 世界钟;
     见 `nowFor`)。`beginSleep` 把「用过的那一次读数」一并回给我们 —— 不在这里
     再读一次钟:两次读数之间可能跨过一个慢帧,那样 `remainingMs` 与
     `untilMs` 就错半秒。

     ⚠️ 回血本体**不在**本动作(`rooms/effects.ts` 的卧室回血 + `social/afk.ts`
     的 `tickAfk`),本动作只登记窗口。故窗口的时基必须与那两处一致 —— 那是本
     文件唯一的时间契约(见文件头「时钟」)。 */
  const { record, alreadySleeping, nowMs: now } = beginSleep(roomId, ctx.actorId);
  const remainingMs = record.untilMs - now;
  return {
    ok: true,
    kind: 'OK',
    effect: alreadySleeping
      ? {
          sleeping: true,
          alreadySleeping: true,
          sinceMs: record.sinceMs,
          untilMs: record.untilMs,
          remainingMs,
          clockBase: record.base,
          note: '已在睡觉 ⇒ 幂等回执,不叠加计时',
        }
      : {
          sleeping: true,
          alreadySleeping: false,
          sinceMs: record.sinceMs,
          untilMs: record.untilMs,
          durationMs: SLEEP_DURATION_MS,
          durationSec: SLEEP_DURATION_SEC,
          remainingMs,
          clockBase: record.base,
          note: '已上床睡觉;时长按**世界钟**(游戏秒)计,与床上回血/露水同源;回血本体由卧室效果负责,本动作只登记状态',
        },
  };
};