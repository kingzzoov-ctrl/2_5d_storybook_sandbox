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
 * ## 时钟
 *
 * 默认 `Date.now()`,但**可注入**(`setSleepClock`):判据要能推进时间而不
 * `sleep` 真秒。注入点是模块级的,因为 `ActionContext` 没有 `clock`。
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
 * 一次睡眠的时长(毫秒)。
 *
 * 取值理由(对着本仓已有常量算,不拍脑袋):
 *   · 卧室回血 `BEDROOM_HEAL_PER_SEC = 15`(`rooms/effects.ts`);
 *   · 满级生命上限 `statsAtLevel(MAX_LEVEL = 30).maxHp = 100 + 15×(30−1) = 535`
 *     (`shared/types/entities.ts`);
 *   ⇒ 60 秒 = 900 HP > 535,一次完整睡眠足以把濒死玩家拉回满血;
 *     再长只是把「睡着」变成挂机占位。
 *
 * ⚠️ 它与 `RoomRuntime` 的**房间休眠**、以及 `AFK_TIMEOUT_MS`(30 分钟)
 *   是三条互不相干的线:这里量的是「一次上床睡多久」。
 */
export const SLEEP_DURATION_MS = 60_000;

/** 一条睡眠记录(纯数据,便于回执与断言)。 */
export interface SleepRecord {
  /** 入睡时刻(ms)。 */
  readonly sinceMs: number;
  /** 到这一刻就算睡醒(ms)。 */
  readonly untilMs: number;
}

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

/** 可注入时钟(毫秒)。默认墙钟;测试注入假时钟并推进它。 */
let clockMs: () => number = () => Date.now();

/** 注入时钟。**唯一**的时间来源:动作与查询都走它,不各自读 `Date.now`。 */
export function setSleepClock(clock: () => number): void {
  clockMs = clock;
}

/** 恢复默认时钟(测试收尾;生产不需要)。 */
export function resetSleepClock(): void {
  clockMs = () => Date.now();
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
 *
 * 到期后再次入睡会得到**新的**窗口(旧的过期记录在此被覆盖)。
 */
export function beginSleep(
  roomId: string,
  userId: string,
  nowMs: number = clockMs(),
): { record: SleepRecord; alreadySleeping: boolean } {
  const bucket = bucketOf(roomId);
  const cur = bucket.players.get(userId);
  if (cur !== undefined && cur.untilMs > nowMs) {
    return { record: cur, alreadySleeping: true };
  }
  const record: SleepRecord = { sinceMs: nowMs, untilMs: nowMs + SLEEP_DURATION_MS };
  bucket.players.set(userId, record);
  return { record, alreadySleeping: false };
}

/**
 * **显式查询**(给未来接线用):这个玩家现在算不算在睡。
 *
 * 「时间到」在**这里**落地:过期记录被顺手清掉并返回 `sleeping: false`。
 * 这样「睡到什么时候」只有一份事实,不需要每个调用方各自比一次时间。
 */
export function sleepStateOf(
  roomId: string,
  userId: string,
  nowMs: number = clockMs(),
): SleepState {
  const rec = SLEEPERS.get(roomId)?.players.get(userId);
  if (rec === undefined) {
    return { sleeping: false, sinceMs: null, untilMs: null, remainingMs: 0 };
  }
  if (rec.untilMs <= nowMs) {
    endSleep(roomId, userId);
    return { sleeping: false, sinceMs: null, untilMs: null, remainingMs: 0 };
  }
  return {
    sleeping: true,
    sinceMs: rec.sinceMs,
    untilMs: rec.untilMs,
    remainingMs: rec.untilMs - nowMs,
  };
}

/** 该房间当前在睡的玩家数(断言「失败路径没写状态」用)。 */
export function sleepingCount(roomId: string): number {
  return SLEEPERS.get(roomId)?.players.size ?? 0;
}

/** 清空全部登记(测试隔离用;生产不需要)。 */
export function clearSleepRegistry(): void {
  /* 连**世代号**一起清(清掉房间桶 ⇒ gen 归零)⇒ 测试之间不带着上一轮的 gen 起跑。 */
  SLEEPERS.clear();
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

  const now = clockMs();
  const { record, alreadySleeping } = beginSleep(roomId, ctx.actorId, now);
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
          note: '已在睡觉 ⇒ 幂等回执,不叠加计时',
        }
      : {
          sleeping: true,
          alreadySleeping: false,
          sinceMs: record.sinceMs,
          untilMs: record.untilMs,
          durationMs: SLEEP_DURATION_MS,
          remainingMs,
          note: '已上床睡觉;睡眠期间的回血由卧室效果(BEDROOM_HEAL_PER_SEC)负责,本动作只登记状态',
        },
  };
};