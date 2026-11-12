/**
 * Boss 副本运行时(`bosses/**` 的生产装配层)。
 *
 * ## 为什么需要这个文件
 *
 * `raid.ts` / `phases.ts` / `breaks.ts` 三个文件共 1,261 行,单测全绿,
 * 但 `server/src` 与 `client/src` 内**零引用** ——
 * 它们一直是「实现存在 + 测试全绿 + 生产永不执行」的成员
 * (本仓第 5 次出现同一形态)。
 *
 * 缺的不是算法,是**容器**:没有东西持有 `BossState`,
 * 于是 `tickBoss` 没人调、`evaluateBreak` 没人调、`summonBossWithOffering` 没人调。
 *
 * 本文件就是那个容器,并且刻意做得**薄**:
 *   · 只管「谁的 Boss 在场上、血多少、破没破防」;
 *   · 破防判定、阶段推进、掉落全部**委托**给既有模块,不复制一份逻辑;
 *   · 存储用端口注入(见 `raid.ts#OfferingPort` 的理由),本模块不 import `db/**`。
 *
 * ## 挂载点选择:为什么不是 `damageMob` 之后
 *
 * 任务书让我在 `tickMobs` 与 `damageMob` 之间选。我选**独立的 `tickBosses(dt)`,
 * 由 `WorldSim.tick` 的慢帧调用**,理由三条:
 *
 * 1. **Boss 不是生物。** 实测 8 个 Boss **全部不在** `MOB_BY_ID` 里
 *    (`sim.addMob('boss_jelly_king', …)` → `undefined`)。所以 `damageMob` /
 *    `tickMobs` 走的 `MobHost` 里**根本没有 Boss 实体**,挂在那里等于挂在空集合上。
 * 2. **量纲要对。** `tickBoss` 的 `dt` 以**秒**为单位(`CAST_INTERVAL_SEC`、
 *    `TIME_SHIELD_SEC`、`stunnedSec` 全是秒),与慢帧 `SIM_SLOW_DT = 0.5` 同量纲。
 *    挂快帧会让阶段/护盾/眩晕以 10 倍速流失 —— 这是「不报错但行为全错」的典型。
 * 3. **结算时机不同。** `damageMob` 是被动入口(玩家打一下才触发),
 *    而 Boss 的阶段推进、护盾回血、眩晕倒计时都是**时间驱动**的,
 *    必须每帧都跑,否则「护盾 8 秒未破则回血」永远不会发生。
 *
 * 所以:受伤走 `damage()`,时间走 `tickBosses(dt)`,破防走 `tryBreak()`,
 * 三条入口都从 `WorldSim` 暴露出去 —— 生产因此可达。
 */

import { BOSS_BY_ID, type BossDef } from '../../../shared/constants/bosses.ts';
import {
  summonBossWithOffering,
  rollPersonalLoot,
  type RaidParticipant,
  type LootOrb,
  type OfferingPort,
  type SummonWithOfferingRequest,
  type SummonWithOfferingResult,
} from './raid.ts';
import {
  createBossState,
  tickBoss,
  applyBreak,
  damageBoss,
  BREAK_STUN_SEC,
  BREAK_CRIT_BONUS,
  type BossState,
} from './phases.ts';
import { evaluateBreak, type BreakResult } from './breaks.ts';

/** 在场 Boss 的只读快照,供外部观察(不暴露可变内部对象)。 */
export interface BossSnapshot {
  bossId: string;
  name: string;
  hp: number;
  maxHp: number;
  hpRatio: number;
  phaseIndex: number;
  phaseName: string;
  /** 破防后的眩晕剩余秒数。 */
  stunnedSec: number;
  /** 破防窗口内的全队暴击加成。 */
  critBonus: number;
  breakAchieved: boolean;
  /** 是否处于护盾期(仅克洛诺斯 P2)。 */
  shielded: boolean;
}

/** `tickBosses` 的单帧结果,便于编排层记账与断言。 */
export interface BossTickReport {
  /** 本次推进的 Boss 数。 */
  ticked: number;
  /** 本帧发生阶段切换的 Boss ID。 */
  phaseSwitched: string[];
  /** 眩晕窗口在本帧走完的 Boss ID。 */
  stunEnded: string[];
}

/**
 * Boss 副本运行时。
 *
 * 持有 `bossId → BossState` 的映射,并提供生产侧的四条入口
 * (召唤 / 受伤 / 破防 / 时间推进)。
 */
export class BossRaidRuntime {
  private readonly states = new Map<string, BossState>();

  /** 当前在场的 Boss ID(按字典序,保证确定性)。 */
  aliveIds(): string[] {
    return [...this.states.keys()].sort();
  }

  /** 在场 Boss 数。 */
  get size(): number {
    return this.states.size;
  }

  /**
   * 祭坛召唤(**含祭品消耗**,owner 裁决 D-03)。
   *
   * 成功时把 `BossState` 登记进来;失败时**不登记、不扣东西** ——
   * 顺序保证由 `summonBossWithOffering` 承担,这里只做登记。
   */
  summon(req: SummonWithOfferingRequest, port: OfferingPort): SummonWithOfferingResult {
    const r = summonBossWithOffering(req, port);
    if (r.ok && r.state !== undefined) this.states.set(req.bossId, r.state);
    return r;
  }

  /** 某 Boss 的只读快照;不在场返回 `undefined`。 */
  snapshot(bossId: string): BossSnapshot | undefined {
    const s = this.states.get(bossId);
    return s === undefined ? undefined : toSnapshot(s);
  }

  /** 全部在场 Boss 的快照。 */
  snapshots(): BossSnapshot[] {
    return this.aliveIds().map((id) => toSnapshot(this.states.get(id)!));
  }

  /**
   * 直接读内部状态。
   *
   * **仅供测试与诊断** —— 生产代码请走 `snapshot()`。
   * 保留它是为了让既有 WS-05 用例能继续用同一套断言口径。
   */
  stateOf(bossId: string): BossState | undefined {
    return this.states.get(bossId);
  }

  /** 移除一个 Boss(击杀/离场)。返回是否真的移除了。 */
  despawn(bossId: string): boolean {
    return this.states.delete(bossId);
  }

  /** 清空全部在场 Boss。 */
  clear(): void {
    this.states.clear();
  }

  /**
   * 对 Boss 造成伤害。
   *
   * 走 `phases.damageBoss`(护盾优先吃伤害),**不绕过**任何既有逻辑。
   * 返回实际扣在护盾/血量上的分配;Boss 不在场返回 `null`。
   */
  damage(bossId: string, amount: number): { toShield: number; toHp: number } | null {
    const s = this.states.get(bossId);
    if (s === undefined) return null;
    return damageBoss(s, amount);
  }

  /**
   * 尝试破防。
   *
   * 判定委托给 `breaks.evaluateBreak`(八条破防的唯一分派口),
   * 成功后套用 `phases.applyBreak`(眩晕窗口 + 全队暴击加成)。
   *
   * **已破防的 Boss 不会重复破防** —— 否则每次投喂都能刷新眩晕,
   * 变成无限控场。这条短路是刻意的。
   */
  tryBreak(bossId: string, input: unknown): BreakResult {
    const s = this.states.get(bossId);
    if (s === undefined) return { ok: false, reason: 'boss_not_alive' };
    if (s.breakAchieved) return { ok: false, reason: 'already_broken' };
    const r = evaluateBreak(bossId, input);
    if (r.ok) applyBreak(s);
    return r;
  }

  /**
   * 时间推进(慢帧 2Hz 调用)。
   *
   * `dt` 以秒为单位;挂在快帧会让护盾/眩晕以 10 倍速流失。
   */
  tickBosses(dt: number): BossTickReport {
    const phaseSwitched: string[] = [];
    const stunEnded: string[] = [];
    for (const id of this.aliveIds()) {
      const s = this.states.get(id)!;
      const wasStunned = s.stunnedSec > 0;
      const switched = tickBoss(s, dt, {});
      if (switched) phaseSwitched.push(id);
      if (wasStunned && s.stunnedSec === 0) stunEnded.push(id);
    }
    return { ticked: this.states.size, phaseSwitched, stunEnded };
  }

  /**
   * 结算个人独立掉落(每位参战者一个光球)。
   *
   * 薄封装 —— 算法全在 `raid.rollPersonalLoot`。
   */
  rollLoot(
    bossId: string,
    participants: readonly RaidParticipant[],
    opts: { partyBonus?: number; dropMul?: number } = {},
  ): LootOrb[] {
    return rollPersonalLoot(bossId, participants, opts);
  }

  /** 某 Boss 的冻结定义;未知返回 `undefined`。 */
  defOf(bossId: string): BossDef | undefined {
    return BOSS_BY_ID.get(bossId);
  }

  /** 破防窗口时长(秒);未知 Boss 回退 6 秒,与 `applyBreak` 同口径。 */
  stunSecOf(bossId: string): number {
    return BREAK_STUN_SEC[bossId] ?? 6;
  }

  /** 破防窗口的全队暴击加成(常量,便于断言不漂移)。 */
  critBonus(): number {
    return BREAK_CRIT_BONUS;
  }
}

function toSnapshot(s: BossState): BossSnapshot {
  return {
    bossId: s.bossId,
    name: s.def.name,
    hp: s.hp,
    maxHp: s.maxHp,
    hpRatio: s.maxHp === 0 ? 0 : s.hp / s.maxHp,
    phaseIndex: s.phaseIndex,
    phaseName: s.def.phases[Math.min(s.phaseIndex, s.def.phases.length - 1)]?.name ?? '',
    stunnedSec: s.stunnedSec,
    critBonus: s.critBonus,
    breakAchieved: s.breakAchieved,
    shielded: s.shieldSec > 0 && s.shieldHp > 0,
  };
}

/**
 * 内存版 `OfferingPort` —— **测试与离线降级**用。
 *
 * 生产中由装配层包 `db/repo.ts` 的 `listItems` / `consumeItem` 得到
 * (见 `raid.ts#makeOfferingPort` 的注释);这里给一个纯内存版本,
 * 使 WS-05 无需建库即可断言 D-03「祭品真的被消耗」。
 *
 * 语义与 `makeOfferingPort` **严格一致**:不足则返回 false 且**不做任何扣减**。
 */
export function makeMemoryOfferingPort(
  initial: Record<string, Record<number, number>> = {},
): OfferingPort & { snapshot(): Record<string, Record<number, number>> } {
  /* 深拷贝一层,避免调用方后续改动影响运行时 */
  const store: Record<string, Record<number, number>> = {};
  for (const [owner, bag] of Object.entries(initial)) {
    store[owner] = { ...bag };
  }

  return {
    countOf: (ownerId, itemId) => store[ownerId]?.[itemId] ?? 0,
    consume: (ownerId, itemId, n) => {
      if (n <= 0) return true;
      const have = store[ownerId]?.[itemId] ?? 0;
      /* 原子:不够就**一个都不扣** */
      if (have < n) return false;
      store[ownerId]![itemId] = have - n;
      return true;
    },
    snapshot: () => {
      const out: Record<string, Record<number, number>> = {};
      for (const [owner, bag] of Object.entries(store)) out[owner] = { ...bag };
      return out;
    },
  };
}
