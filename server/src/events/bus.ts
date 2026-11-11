/**
 * 事件总线 —— 事件驱动子系统的共同前置。
 *
 * ## 为什么需要它
 *
 * 本项目有**两类**子系统,推进方式根本不同:
 *
 * | 类型 | 例子 | 推进方式 |
 * | :--- | :--- | :--- |
 * | **连续型** | 物理、流体、电路、AOI | 每帧/每慢帧 `step()` |
 * | **事件型** | 伤害结算、Boss 阶段、炼金、生物行为触发 | 有输入才动作 |
 *
 * 编排层 `WorldSim` 已经解决了连续型(双频调度)。事件型此前**没有归属**:
 *
 * - `server/src/mobs/behaviors.ts` 里有 **30 处 `world.emit(kind, payload)`,
 *   覆盖 29 种事件**(野猪撞墙自晕、河狸筑坝、卡皮巴拉反弹爱心、姜饼小人逃逸、
 *   竖琴风精鸟合奏送礼 …),但 `MobWorld.emit` 的实现方**根本不存在** ——
 *   `MobWorld` 只是个 interface,**全仓没有任何类实现它**。
 * - 于是 `createMobAi()` 是唯一入口(工厂函数存在),但**没有任何地方调用
 *   `ai.tick()`** —— 25 个 `tick` 实现一行都没跑过。
 *
 * 所以「生物行为没接入」的真正原因不是缺宿主类,而是**缺一个事件契约**:
 * 没有地方规定「emit 出来的东西交给谁、按什么顺序、失败了怎么办」。
 *
 * ## 这一层做什么
 *
 * 把 `emit(kind, payload)` 从「往空气里喊」变成有接收、有序、可观测的投递:
 *
 * 1. **订阅**:`on(pattern, handler)` 支持精确匹配与通配(`mob.*`、`*`);
 * 2. **投递**:同帧内 FIFO;处理器**不可重入**地修改订阅表(收件人快照);
 * 3. **顺序**:按订阅顺序调用,同帧事件按发出顺序排;
 * 4. **隔离**:单个处理器抛错不中断同帧其它投递,错误被收集上报;
 * 5. **上限**:每帧事件数与每事件处理器调用数有硬上限 ——
 *    防止一个死循环 emit 拖垮 20Hz 循环(与 `MAX_ACTIONS_PER_TICK` 同一思路);
 * 6. **确定性**:不依赖 `Math.random`,不依赖 Map 迭代顺序之外的东西,
 *    同输入序列必产出同投递序列;
 * 7. **可测**:记录投递日志(`history`),使「某个 AI 真的 emit 了吗」
 *    从「靠肉眼读代码」变成可断言。
 *
 * ## 这一层不做什么
 *
 * - **不做跨帧队列**:事件在**当帧**内投递完。跨帧排队会引入延迟不确定性与
 *   队列膨胀,而本游戏的玩法(整蛊、Boss 预警)需要「立刻看到反应」。
 *   需要延迟的动作由各自的系统用计时器表达(如 `BREAK_STUN_SEC`)。
 * - **不猜语义**:不解释 `payload` 里有什么,只搬运。语义由订阅方与
 *   `MobWorld` 契约约定(见 `docs/EVENT-BUS.md`)。
 * - **不替代 `RoomRuntime` 的网络事件**:那是客户端↔服务端,这是服务端内部。
 */

/* ═══════════════════════ 1. 类型 ═══════════════════════ */

/** 事件负载:扁平标量,便于序列化与日志。 */
export type EventPayload = Record<string, number | string | boolean>;

/** 一条事件。 */
export interface GameEvent {
  /** 事件种类,如 `boar_wall_stun`。 */
  kind: string;
  /** 负载(可为空)。 */
  payload: EventPayload;
  /** 发出者 ID(生物 ID / 玩家 ID / 系统名),便于诊断与过滤。 */
  source: string;
  /** 发出时的帧序(快帧单位)。 */
  frame: number;
}

/** 事件处理器。返回值忽略 —— 处理器通过总线再 emit 来产生连锁反应。 */
export type EventHandler = (e: GameEvent) => void;

/** 投递日志的一条记录(供测试与调试面板断言)。 */
export interface DeliveryRecord {
  event: GameEvent;
  /** 被调用的处理器数量。 */
  handlers: number;
  /** 处理器抛错信息(空 = 正常)。 */
  errors: string[];
  /** 是否因上限被丢弃。 */
  dropped: boolean;
}

/** 一帧的投递统计。 */
export interface BusFrameStats {
  frame: number;
  /** 本帧发出的事件数(含被丢弃的)。 */
  emitted: number;
  /** 实际投递的事件数。 */
  delivered: number;
  /** 被上限丢弃的事件数。 */
  dropped: number;
  /** 处理器抛错次数。 */
  errors: number;
  /** 因重入限制被跳过的调用数。 */
  skippedReentrant: number;
}

/* ═══════════════════════ 2. 上限 ═══════════════════════ */

/**
 * 每帧最多投递的事件数。
 *
 * 取 4096:实测一个 64×64 世界、5 刚体、4 生物跑 200 帧产生的事件数为个位数,
 * 所以这个上限在正常玩法下**永远碰不到**。它的作用是兜住「处理器里 emit
 * 触发自身」这类死循环 —— 那会让 20Hz 帧预算(50ms)瞬间爆掉。
 *
 * 之所以不是更小的值:群体事件(Boss 破防 + 16 人伤害结算 + 掉落)在
 * 同一帧可能产生几十个事件,4096 留了充足余量。
 */
export const MAX_EVENTS_PER_FRAME = 4096;

/** 单个事件最多调用多少个处理器(兜住「一个 pattern 被大量订阅」)。 */
export const MAX_HANDLERS_PER_EVENT = 512;

/** 投递日志保留的记录数(环形缓冲,避免长跑内存增长)。 */
export const HISTORY_CAPACITY = 512;

/** 单个处理器在同一事件上的最大重入深度。 */
export const MAX_REENTRY_DEPTH = 8;

/* ═══════════════════════ 3. 事件总线 ═══════════════════════ */

interface Subscription {
  /** 订阅序号,决定调用顺序(稳定)。 */
  seq: number;
  pattern: string;
  handler: EventHandler;
  /** 是否一次性。 */
  once: boolean;
}

/**
 * 模式匹配。
 *
 * 支持三种形式:
 *   - `*`       全部
 *   - `prefix*` 前缀匹配(尾随星号,**不分隔符**)—— 如 `mimic_*`
 *   - 其它      精确匹配
 *
 * **为什么不带分隔符**:本项目的事件名全是 `snake_case`
 * (`mimic_ambush` / `boar_wall_stun`),分隔符是下划线而非点。
 * 我最初只支持 `mimic.*` 这种点分隔形式 —— 实测它**永远匹配不到任何
 * 真实事件**,因为没有一个事件名含点。这种「看起来能用但恒不命中」的
 * 语法比语法错误更糟:订阅方以为自己订阅上了,实际一个事件都收不到,
 * 而且不报错。
 *
 * 改成「尾随 `*` 即前缀匹配」后两种写法都能用,且与命名约定无关。
 */
function matches(pattern: string, kind: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return kind.startsWith(pattern.slice(0, -1));
  return pattern === kind;
}

export class EventBus {
  private subs: Subscription[] = [];
  private seqCounter = 0;
  private frameCount = 0;

  /** 当前帧内待投递队列(FIFO)。 */
  private queue: GameEvent[] = [];
  /** 当前帧内正在投递的事件(用于重入检测)。 */
  private delivering: string | null = null;
  /** 每个正在投递的事件已调用过的处理器数。 */
  private handlerCallsThisEvent = 0;
  /** 各事件当前的重入深度(按 kind)。 */
  private depth = new Map<string, number>();

  /** 投递日志(环形,最近 HISTORY_CAPACITY 条)。 */
  private log: DeliveryRecord[] = [];
  private logNext = 0;
  private logCount = 0;

  /** 累计统计(供长跑观测)。 */
  readonly totals = {
    frames: 0,
    emitted: 0,
    delivered: 0,
    dropped: 0,
    errors: 0,
    skippedReentrant: 0,
  };

  /* ── 订阅 ── */

  /**
   * 订阅事件。
   *
   * @param pattern 精确种类(如 `boar_wall_stun`)、前缀通配(`mimic_*`)或全通配(`*`)
   * @param handler 处理器
   * @returns 取消订阅函数
   */
  on(pattern: string, handler: EventHandler): () => void {
    const sub: Subscription = { seq: this.seqCounter, pattern, handler, once: false };
    this.seqCounter += 1;
    this.subs.push(sub);
    return () => {
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  /** 订阅一次,触发后自动取消。 */
  once(pattern: string, handler: EventHandler): () => void {
    const off = this.on(pattern, (e) => {
      off();
      handler(e);
    });
    return off;
  }

  /** 取消全部订阅(测试收尾与热重载用)。 */
  clear(): void {
    this.subs = [];
  }

  /** 当前订阅数。 */
  get subscriptionCount(): number {
    return this.subs.length;
  }

  /* ── 发出 ── */

  /**
   * 发出事件。
   *
   * **在 `tick()` 之前调用时会立即投递**;在投递过程中(处理器内部)调用时
   * 会**追加到当帧队列尾**,等当前事件投递完再继续 —— 这样保证:
   *   - 同帧事件按 FIFO 顺序处理(可预测);
   *   - 不会因处理器递归 emit 而无限加深调用栈。
   *
   * @param kind 事件种类
   * @param payload 负载
   * @param source 发出者 ID
   */
  emit(kind: string, payload: EventPayload = {}, source = 'system'): void {
    this.totals.emitted += 1;
    const e: GameEvent = { kind, payload, source, frame: this.frameCount };
    /* 无条件入队 —— 上限在 drain 时统一检查,这样 emitted 计数与丢弃数都能报出 */
    this.queue.push(e);
  }

  /* ── 投递 ── */

  /** 投递当帧队列中的全部事件。返回本帧统计。由编排层每帧调用一次。 */
  drain(): BusFrameStats {
    const stats: BusFrameStats = {
      frame: this.frameCount,
      emitted: this.queue.length,
      delivered: 0,
      dropped: 0,
      errors: 0,
      skippedReentrant: 0,
    };

    /* 重入跳过的本帧增量:在开头快照累计值,末尾做差。
       早先想用 `(this as ...)._lastSkip! || 0` 记在上一个字段里 ——
       既绕又错(增量恒等于累计值,且 `!` 断言掩盖了可能的 undefined)。
       就地快照差值是最直白的写法。 */
    const skipBefore = this.totals.skippedReentrant;

    let processed = 0;
    while (this.queue.length > 0) {
      if (processed >= MAX_EVENTS_PER_FRAME) {
        /* 剩余全部丢弃 —— 记为 dropped,不静默吞掉 */
        const rest = this.queue.length;
        this.queue.length = 0;
        stats.dropped += rest;
        this.totals.dropped += rest;
        this.record({
          event: { kind: '<overflow>', payload: { remaining: rest }, source: 'bus', frame: this.frameCount },
          handlers: 0,
          errors: [],
          dropped: true,
        });
        break;
      }
      const e = this.queue.shift()!;
      processed += 1;

      const rec = this.deliverOne(e);
      if (rec.dropped) {
        stats.dropped += 1;
        this.totals.dropped += 1;
      } else {
        stats.delivered += 1;
        this.totals.delivered += 1;
      }
      stats.errors += rec.errors.length;
      this.totals.errors += rec.errors.length;
      this.record(rec);
    }

    stats.skippedReentrant = this.totals.skippedReentrant - skipBefore;
    this.totals.frames += 1;
    this.frameCount += 1;
    return stats;
  }

  /**
   * 投递单个事件给快照出的收件人。
   *
   * **收件人快照**:投递前拷贝订阅列表,使处理器内部的订阅/取消订阅
   * 不影响本次投递的收件人集合 —— 否则「取消订阅后仍被调用」或
   * 「边遍历边增删」会导致不确定行为。
   */
  private deliverOne(e: GameEvent): DeliveryRecord {
    const rec: DeliveryRecord = { event: e, handlers: 0, errors: [], dropped: false };

    const d = this.depth.get(e.kind) ?? 0;
    if (d >= MAX_REENTRY_DEPTH) {
      rec.dropped = true;
      rec.errors.push(`重入深度超限(${d} ≥ ${MAX_REENTRY_DEPTH}),丢弃 ${e.kind}`);
      this.totals.skippedReentrant += 1;
      return rec;
    }
    this.depth.set(e.kind, d + 1);

    /* 快照 + 按 seq 排序(保证调用顺序稳定,不依赖数组物理顺序) */
    const recipients = this.subs.filter((s) => matches(s.pattern, e.kind)).sort((a, b) => a.seq - b.seq);

    this.delivering = e.kind;
    this.handlerCallsThisEvent = 0;
    for (const s of recipients) {
      if (this.handlerCallsThisEvent >= MAX_HANDLERS_PER_EVENT) {
        rec.errors.push(`处理器数超限(${MAX_HANDLERS_PER_EVENT}),${e.kind} 的后续处理器未调用`);
        break;
      }
      this.handlerCallsThisEvent += 1;
      rec.handlers += 1;
      try {
        s.handler(e);
      } catch (err) {
        /* 隔离:一个处理器抛错不影响同帧其它事件与其它处理器 */
        rec.errors.push(`${e.kind}: ${(err as Error).message}`);
      }
    }
    this.delivering = null;

    const nd = (this.depth.get(e.kind) ?? 1) - 1;
    if (nd <= 0) this.depth.delete(e.kind);
    else this.depth.set(e.kind, nd);

    return rec;
  }

  /* ── 日志 ── */

  private record(r: DeliveryRecord): void {
    if (this.log.length < HISTORY_CAPACITY) this.log.push(r);
    else {
      this.log[this.logNext] = r;
      this.logNext = (this.logNext + 1) % HISTORY_CAPACITY;
    }
    this.logCount += 1;
  }

  /** 最近的投递记录(按时间顺序,最早在前)。 */
  history(limit = HISTORY_CAPACITY): readonly DeliveryRecord[] {
    const n = Math.min(limit, this.log.length);
    if (this.log.length < HISTORY_CAPACITY) return this.log.slice(-n);
    /* 环形:从最旧的开始 */
    const out: DeliveryRecord[] = [];
    for (let i = 0; i < n; i += 1) out.push(this.log[(this.logNext + this.log.length - n + i) % this.log.length]);
    return out;
  }

  /** 某类事件出现过几次(含被丢弃)。 */
  countOf(kind: string): number {
    let n = 0;
    for (const r of this.history()) if (r.event.kind === kind) n += 1;
    return n;
  }

  /** 清空日志与统计(测试用)。 */
  reset(): void {
    this.log = [];
    this.logNext = 0;
    this.logCount = 0;
    this.queue = [];
    this.depth.clear();
    this.totals.frames = 0;
    this.totals.emitted = 0;
    this.totals.delivered = 0;
    this.totals.dropped = 0;
    this.totals.errors = 0;
    this.totals.skippedReentrant = 0;
    this.frameCount = 0;
  }

  /** 当前帧序。 */
  get frame(): number {
    return this.frameCount;
  }

  /** 当帧队列中尚未投递的事件数。 */
  get pending(): number {
    return this.queue.length;
  }

  /** 是否正在投递中(供诊断)。 */
  get isDelivering(): boolean {
    return this.delivering !== null;
  }

  /** 不可变摘要,便于写进快照。 */
  snapshot(): { frame: number; pending: number; subs: number; totals: typeof this.totals } {
    return {
      frame: this.frameCount,
      pending: this.queue.length,
      subs: this.subs.length,
      totals: { ...this.totals },
    };
  }
}
