/**
 * **活人被困进泡泡**(227 泡泡连发水枪的"活人半边")—— 纯状态机。
 *
 * ## 为什么需要它(`DownedState.BUBBLED` 为什么不够)
 *
 * `revive.ts` 的 `bubbleGunHit(downed)` 作用于 **`DownedState`**,而 `DownedState`
 * **只在玩家倒地(幽灵泡泡)期间存在**。手册 §3.7 的另一半是"对**活人**连中 3 发 ⇒
 * 装进大泡泡、随风飘 5 秒" —— 活人根本没有 `DownedState`,所以那半边需要**自己的状态容器**。
 *
 * ⚠️ 这不是"同一件事两份实现":两者是**不同主体**(倒地 / 未倒地),共享的只是手册里的词
 * ("泡泡")与两个数值常量(`BUBBLE_GUN_SHOTS` / `BUBBLE_TRAP_SEC`)—— 常量从 `revive.ts`
 * **import**,不在这里重抄。若将来两者要合并,合并点应在 `VitalsSystem` 的"玩家瞬时状态"
 * 那一层,而不是让任一方去借用对方的容器。
 *
 * ## 纯函数
 *
 * 不读全局、不看时钟:推进由调用方按 `dt` 喂(世界侧慢帧)。这样判据不需要真等 5 秒。
 */
import { BUBBLE_GUN_SHOTS, BUBBLE_TRAP_SEC } from './revive.ts';

/** 一个玩家的活人泡泡状态。 */
export interface LiveBubbleState {
  /** 已连中几发(0..`BUBBLE_GUN_SHOTS - 1`);被困期间归零。 */
  stacks: number;
  /** 还要被困多少秒(0 = 没被困)。 */
  trapSec: number;
  /** 距**最后一次命中**过了多少秒(只在 `stacks > 0` 时有意义)。 */
  sinceHitSec: number;
}

/** 初始状态(没中过、没被困)。 */
export const LIVE_BUBBLE_INITIAL: LiveBubbleState = Object.freeze({ stacks: 0, trapSec: 0, sinceHitSec: 0 });

/**
 * **连击窗口** = 最后一次命中后多少秒内再命中才算"连中"。
 *
 * ★ D-10(owner,2026-11-16):窗口取 **5 秒**,并且**不新增数值**——
 * 就是 `revive.ts` 里已有的 `BUBBLE_TRAP_SEC`(手册「装进大泡泡随风乱飘」的那 5 秒)。
 * ⚠️ 本常量之前**不存在** ⇒ 层数永不衰减,跨任意时长能凑满"连中 3 发"
 *   (审查抓到的静默缺口:第 1 发在早上、第 2 发在下午也算连击)。
 */
export const LIVE_BUBBLE_STACK_WINDOW_SEC = BUBBLE_TRAP_SEC;

/**
 * 中一发。连中到 `BUBBLE_GUN_SHOTS` ⇒ **困住**:`trapSec` 置为 `BUBBLE_TRAP_SEC`、层数归零。
 *
 * @returns 新状态 + 这一发是否**触发了困住**(供调用方写回执)
 */
export function liveBubbleHit(s: LiveBubbleState): { state: LiveBubbleState; trapped: boolean } {
  /* 已被困时再打:层数从 0 重新累计,不改动剩余困住时间(不许"续杯")。 */
  const stacks = s.stacks + 1;
  if (stacks >= BUBBLE_GUN_SHOTS) {
    /* 困住 ⇒ 层数归零、窗口计时也归零(下一轮连击从"现在"起算)。 */
    return { state: { stacks: 0, trapSec: BUBBLE_TRAP_SEC, sinceHitSec: 0 }, trapped: true };
  }
  /* ★ D-10:**每次命中把连击窗口重置为 0** —— 窗口是按"最后一次命中"算的,不是按第一次。 */
  return { state: { stacks, trapSec: s.trapSec, sinceHitSec: 0 }, trapped: false };
}

/**
 * 推进 `dt` 秒(慢帧调用)。
 *
 * 两件独立的事:
 * 1 **困住计时**递减,到 0 即解困;
 * 2 ★ D-10 **连击窗口**递增:`sinceHitSec` 超过 `LIVE_BUBBLE_STACK_WINDOW_SEC`(5 秒)⇒
 *    层数归零。没有这一步,第 1 发在早上、第 3 发在下午也算"连中 3 发"。
 *
 * ⚠️ 没有层数时**不累加** `sinceHitSec`(否则它会一直涨,而它只在 `stacks > 0` 时有意义)。
 */
export function tickLiveBubble(s: LiveBubbleState, dt: number): LiveBubbleState {
  const trapSec = s.trapSec <= 0 ? 0 : Math.max(0, Math.round((s.trapSec - dt) * 1000) / 1000);
  if (s.stacks <= 0) return { stacks: 0, trapSec, sinceHitSec: 0 };
  const sinceHitSec = Math.round((s.sinceHitSec + Math.max(0, dt)) * 1000) / 1000;
  if (sinceHitSec >= LIVE_BUBBLE_STACK_WINDOW_SEC) return { stacks: 0, trapSec, sinceHitSec: 0 };
  return { stacks: s.stacks, trapSec, sinceHitSec };
  }

/** 是否被困住。 */
export function isTrapped(s: LiveBubbleState): boolean {
  return s.trapSec > 0;
}

/** 连中几发才会被困(唯一的出处是 `revive.ts`,这里只转发)。 */
export const LIVE_BUBBLE_SHOTS_TO_TRAP = BUBBLE_GUN_SHOTS;