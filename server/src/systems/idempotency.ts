/**
 * WS-FND-96 / 【房间系统的幂等边界】—— 审计 P2-3:「同一 `(房间, 结算日/订单)`
 * 只成功一次」的**纯函数级**可判定键 + 台账。
 *
 * ## 这个文件补的是哪一段
 *
 * `ranch.ts:settleRanchDay` / `alchemy_lab.ts:brewAndRecord` / `depot.ts:buy` 都是
 * **纯函数**,重复调用就重复出账:牧场会把同一天的饲料再吃一遍、炼金会把
 * `craftCount` 再加一、百货会把库存再扣一次。而「调用方会不会重复调用」这件事
 * 不归纯函数管 —— 可惜的是**重复真的会发生**:慢帧重入、动作报文重放、
 * 上层重试,三条路都到同一个函数。
 *
 * 于是这一层只做一件很窄的事:把「这次结算是哪一次」变成一个**字符串键**,
 * 并记住"哪个键已经成功过"。于是
 *
 * ```ts
 * const key = settleKeyOf('ECO_RANCH', { kind: 'DAY', day: 7 }); // 'ECO_RANCH@DAY:7'
 * ```
 *
 * 是可判定的、可打印的、可跨进程序列化的(`world_sim` 的 `committedPurchaseKeys`
 * 现在就用了同一形状的字符串键,见 `purchaseCommit`)。
 *
 * ## 三条纪律(判据对着它们核)
 *
 * 1. **房间必须进键**:同一天 / 同一订单号在两个房间是**两件事**。少了房间前缀,
 *    「牧场第 7 天」与「百货第 7 单」会撞成一个键 —— 后者被误判成重放。
 * 2. **只有成功才占键**:失败(无定价、库存不足、材料不合法、天数为 0)不写台账,
 *    否则一次失败会把该订单永久锁死,重试永远被拒(那是比重复结算更坏的缺陷)。
 * 3. **重复不写账**:第二次同键 ⇒ 拒 + **台账一位不动**(`claims.get(key)` 仍是
 *    首次的时刻),判据用「第二次之后的 `seenAt` === 第一次的 `at`」把它钉住。
 * 4. **台账有界**(第三轮实测):`claims` 恒 ≤ `SETTLEMENT_LEDGER_CAPACITY`,打满按
 *    入账顺序 FIFO 淘汰最老一条 —— 键的一维(订单号)是**客户端可控**的,只增不删
 *    会让常驻房间进程的账在世界世代内无界增长。
 *
 *
 * ## 为什么不做成 class
 *
 * 全仓约束:`erasableSyntaxOnly` ⇒ 禁 `enum` / 参数属性 / 装饰器等不可擦除语法。
 * 台账是一个**普通对象**(持有一个 `Map`),与 `alchemy_lab.ts` 的 `Gallery`
 * (`{ rows: Map }`) 同构 —— 判据可以直接 `new Map()` 造一个空台账。
 */

/**
 * 有结算副作用的三个房间。
 *
 * 字面量与 `rooms/effects.ts` 的 `ROOM_SYSTEM_IMPL` 键逐一相同(`ECO_RANCH` /
 * `ALCHEMY_LAB` / `CLOUD_DEPOT`)—— **不新造房间名**,否则幂等键里的房间维度
 * 会与房间识别结果各说一套。
 */
export const SETTLEMENT_ROOMS = Object.freeze({
  ECO_RANCH: 'ECO_RANCH',
  ALCHEMY_LAB: 'ALCHEMY_LAB',
  CLOUD_DEPOT: 'CLOUD_DEPOT',
} as const);

/** 「按天结算」的房间(牧场)的结算范围。 */
export interface DaySettlementScope {
  kind: 'DAY';
  /** 房间内的结算日(0 起整数;负数 / 非有限值一律非法)。 */
  day: number;
}

/** 「按订单结算」的房间(炼金 / 百货)的结算范围。 */
export interface OrderSettlementScope {
  kind: 'ORDER';
  /** 订单号 —— 调用方给的权威身份(空串 / 纯空白一律非法)。 */
  orderId: string;
}

/** 一次结算的范围:要么是某一天,要么是某一张订单。 */
export type SettlementScope = DaySettlementScope | OrderSettlementScope;

/**
 * 台账容量上限(第三轮实测 P2:修前 `claims` 只增不删 ⇒ 世界世代内**无界**)。
 *
 * 口径:不是玩法调参,只是「远大于同一次结算里会被二次结算的键数」——
 * 与 `combat/progression.ts:KILL_LEDGER_CAPACITY` 同一取值口径(4096)。
 * 键的一维(炼金 / 百货的订单号)是**客户端可控**的,一条 `orderId` 就是一条账,
 * 不设上限就能被灌满 ⇒ 常驻房间进程生命期内的内存增长。
 *
 * 打满之后按**入账顺序**淘汰最老一条(FIFO):同一键的二次结算只可能发生在
 * 「最近」这一端(报文重放 / 慢帧重入都在本帧附近),越老的账越不需要记;
 * 而 FIFO 是唯一不引入额外比较规则、也不用重排的取法(与击杀账本同取舍)。
 */
export const SETTLEMENT_LEDGER_CAPACITY = 4096;

/**
 * 幂等台账:**幂等键 → 首次成功结算时的逻辑时刻**。
 *
 * 逻辑时刻由调用方喂(本模块不读时钟),于是判据可复现。值只用于**报错信息**
 * (`已在第 N 帧成交过`)与「重复不覆盖」的断言,不参与任何判定。
 */
export interface SettlementLedger {
  /**
   * ⚠️ 只有 `claimSettlement()` 允许写它。别处直接 `set` 会绕过「先查后写」的
   *    唯一实现,重复结算就又回来了(同一纪律见 `depot.buy` 的「副本上算、
   *    失败原样退回」)。容量恒 ≤ `SETTLEMENT_LEDGER_CAPACITY`。
   */
  claims: Map<string, number>;
  /**
   * FIFO 入账顺序(有界淘汰用,见 `SETTLEMENT_LEDGER_CAPACITY`)。
   * 与 `claims` **必须同步增删**;它只决定淘汰谁,`claims` 才是判据。
   * 缺省(旧夹具只给 `claims`)时由 `claimSettlement` **懒建** —— 不强迫
   * 每一处 `new Map()` 都补一个字段。
   */
  order?: string[];
}

/** 空台账(每次返回新对象 —— 共享单例会被第一次写入污染)。 */
export function createSettlementLedger(): SettlementLedger {
  return { claims: new Map<string, number>(), order: [] };
}

/**
 * 把 `(房间, 范围)` 归一成**唯一键**;非法输入 ⇒ `null`(不猜、不兜底)。
 *
 * ```
 * ('ECO_RANCH',   { kind: 'DAY',   day: 7 })     ⇒ 'ECO_RANCH@DAY:7'
 * ('CLOUD_DEPOT', { kind: 'ORDER', orderId: 'A' }) ⇒ 'CLOUD_DEPOT@ORDER:A'
 * ```
 *
 * ★ 负对照的地基:同一个订单号在两个房间给**不同**键。把房间前缀删掉
 *   (`@ORDER:A`)就会让「牧场第 7 天」与「百货第 7 单」撞键 —— 判据断两者不相等。
 */
export function settleKeyOf(roomKey: string, scope: SettlementScope): string | null {
  if (typeof roomKey !== 'string') return null;
  const room = roomKey.trim();
  if (room === '') return null;
  if (scope.kind === 'DAY') {
    /* ★ 负数必须在**截断之前**判(第三轮实测 P1):
       修前先 `Math.trunc(-0.5)` 得 `-0`,而 `-0 < 0` 为 **false** ⇒ 返回
       `@DAY:0`,与**合法第 0 天**撞同一把键(文件头承诺「负数一律非法」,
       负小数却伪装成了第 0 天)。现在 `scope.day < 0` 先拒 ⇒ 一切负数
       (-1 / -0.5 / -1.5 …)都为 `null`;0 与正小数的向下取整口径不变。 */
    if (!Number.isFinite(scope.day)) return null;
    if (scope.day < 0) return null;
    const day = Math.trunc(scope.day);
    return `${room}@DAY:${day}`;
  }
  if (typeof scope.orderId !== 'string') return null;
  const orderId = scope.orderId.trim();
  if (orderId === '') return null;
  return `${room}@ORDER:${orderId}`;
}

/** 一次占键的结果:`ok:false` ⇒ **台账未被改动**,调用方必须整笔拒绝。 */
export type SettlementClaim =
  | { ok: true; key: string; at: number }
  | { ok: false; key: string; seenAt: number; reason: string };

/**
 * 占键:第一次成功,第二次(以及之后每一次)拒。
 *
 * ```
 * 键不在台账 ⇒ 记下 at,返回 ok:true
 * 键已在台账 ⇒ 拒,返回首次的 seenAt 与一句人读原因(**不覆盖** at)
 * ```
 *
 * ⚠️ 调它之前必须确认这笔结算**真的会产生副作用**(`depot.buy` 的 ok、
 *    `settleRanchDay` 的 `days > 0`)。先占键再判成败 = 一次失败把订单锁死。
 */
export function claimSettlement(ledger: SettlementLedger, key: string, at: number): SettlementClaim {
  const seenAt = ledger.claims.get(key);
  if (seenAt !== undefined) {
    return {
      ok: false,
      key,
      seenAt,
      reason: `幂等键 ${key} 已在 ${seenAt} 结算过 ⇒ 拒绝,账不变`,
    };
  }
  const t = Number.isFinite(at) ? at : 0;
  ledger.claims.set(key, t);
  /* ★ 有界淘汰(第三轮实测 P2):按入账顺序挤掉最老的一条,`claims` 恒 ≤ 上限。
     只有**新键**才会扩容,所以「重复不覆盖」的断言(第二次 `seenAt` 仍是首次)
     不受影响;被淘汰的是**最旧**的键,不影响最近窗口内的重放判定。 */
  const order = ledger.order ?? (ledger.order = []);
  order.push(key);
  while (order.length > SETTLEMENT_LEDGER_CAPACITY) {
    const oldest = order.shift();
    if (oldest !== undefined) ledger.claims.delete(oldest);
  }
  return { ok: true, key, at: t };
}

/** 这个键**成功**结算过没有;没结算过 ⇒ `undefined`(与「结算于 0 时刻」区分开)。 */
export function settlementSeenAt(ledger: SettlementLedger, key: string): number | undefined {
  return ledger.claims.get(key);
}

/** 台账里的键数(判据用:重复结算**不得**让这个数变大)。 */
export function settlementKeyCount(ledger: SettlementLedger): number {
  return ledger.claims.size;
}