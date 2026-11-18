/**
 * 客户端权威状态存储 —— **唯一**持有 `RoomState` 的地方。
 *
 * ## 职责(只有两件)
 *
 * 1. 持有当前权威状态
 * 2. 把服务端来的字节**解包 → 合入 → 换掉**
 *
 * **不做**的事:不碰 WebSocket(`session.ts`)、不碰 three(`boot.ts`)、不碰预测(`prediction.ts`)。
 *
 * ## 为什么搬进这里,而不是继续用 boot.ts 里的局部变量
 *
 * 接线前 `boot.ts` 用 `playerGx/playerGy` 两个局部量当"玩家位置"(从 `pan` 抄来,见 S1 注释)。
 * 那是**客户端自己的推测**,不是权威。现在权威只有一个来源:服务端编码的字节流。
 * ⇒ 状态必须**离开渲染层**才能被测试断言(渲染层含三方 `three`,不可测)。
 *
 * ## ★ 两个实测出来的坑,都在本题内处理
 *
 * ### 1 `applyPacket` **返回新对象**,不改入参
 * 实测(`shared/net/delta.ts:452` `const out = cloneRoomState(base);`):
 * 调用 `applyPacket(s, pkt)` 而**不接返回值** ⇒ `s` 一点没变、**不报错**。
 * ⇒ 本模块的 `apply()` 只在这一处调用,并**必须**把返回值写回。
 *
 * ### 2 「0 字节」**不是**坏包
 * 实测:`RoomRuntime.step(null)` 在 `prevSnapshot` 为 null 时
 * 返回 `new Uint8Array(0)`(`server/src/net/room.ts:1154`)——
 * 语义是「本 tick 没有可发的差量」,**是协议的一部分**,不是损坏数据。
 * 而 `decodePacket(new Uint8Array(0))` 会**抛异常**(实测:"报文截断:需要 1 字节,剩余 0")。
 * ⇒ 所以 **0 字节必须在解码前被跳过**。跳过逻辑写在 `apply()` 里(而非散在调用方),
 *   并有一条 WS-12 判据钉住它 —— 否则有人"顺手"删掉这行,没人会发现。
 *
 * ## 分工:谁负责什么
 * ```
 * session.ts    收字节 ⇒ 调 store.apply(bytes) ⇒ 拿到 ApplyResult 决定是否重画
 * state_store   解包 / 合入 / 跳过空帧 / 记录错误 —— 不抛,把结果**返回**给调用方
 * boot.ts       读 store.state(经 telegraphCenterOf)画预警圈
 * ```
 * 「不抛」是刻意的:坏包会来(网络就是这样),一次坏包不该打断渲染循环。
 * 但**也不静默**:错误计数与最近一条原因都留在 `ApplyResult` / `lastError` 里,可被断言。
 */

import {
  PacketOp,
  applyPacket,
  decodePacket,
  type DecodedPacket,
} from '../../../shared/net/delta.ts';
import type { RoomState } from '../../../shared/types/wire.ts';

/**
 * 空 base —— **与 `wire.ts` 的 `RoomState` 结构手工对齐**。
 *
 * ## 为什么是字面量,而不是 `createRoomState()`
 *
 * 实测:`createRoomState` 属于「**留在 server 的 16 个**」之一 ——
 * `shared/types/wire.ts` **没有它**(`cloneRoomState` 有)。客户端拿不到。
 * ⇒ 客户端只需要 `RoomState` 的**形状**(`applyPacket` 只用它做 `cloneRoomState`),
 *   **不需要**那个工厂。所以用字面量是正解,不是绕过。
 *
 * ## ⚠️ 已知代价(记在案,并有判据兜底)
 *
 * 这个字面量**手工**镜像了 `wire.ts` 的结构 ⇒ 协议加字段时它会**静默缺字段**。
 * ⇒ `tests/WS-12.test.ts` 有一条判据:
 *    「空 base 的键集 == 一个**真实** `RoomState` 的键集」(行为判据,不读源码文本)。
 * ⇒ 长期看 `createRoomState` 可能也该上移(已作为待裁项报 Lead)。
 */
export function emptyRoomState(): RoomState {
  return {
    roomId: '',
    meta: { tick: 0, chunkVersions: {}, partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 },
    players: [],
    wildlife: [],
    bosses: [],
  };
}

/**
 * `apply()` 的结果。调用方**按它决定**要不要重画,不靠副作用。
 */
export interface ApplyResult {
  /** 状态是否真的变了(跳过空帧、解码失败、丢弃旧帧时为 false)。 */
  changed: boolean;
  /** 帧号(`meta.tick`);未变时保持上一个值。 */
  tick: number;
  /**
   * 本次为何跳过 / 失败;正常合入时为 `null`。
   *
   * ★ WS-FND-113 新增 `'stale-frame'`:差量帧**比当前状态旧** ⇒ 丢弃。
   * 它与 `'empty-frame'` 都"不是错误",但**成因完全不同**
   * (一个"本 tick 无差量"、一个"这帧来晚了")⇒ 必须分开计数,否则
   * 掉线与抖动在账上同形,正是本仓记过的「症状名 ≠ 成因名」。
   */
  skipped: 'empty-frame' | 'decode-failed' | 'stale-frame' | null;
  /** `skipped === 'decode-failed'` 时的原因文本(便于诊断与断言)。 */
  error?: string;
  /**
   * ★ D-14:本帧包头带回的 `ackedSeq`(服务端**已应用**到的客户端命令序号,
   * `-1` = 本帧没带 ack)。**跳过 / 失败时为 `null`** —— 它来自帧本身,
   * 不是本地推出来的数(见 `ClientStateStore.lastAckedSeq`)。
   */
  ackedSeq: number | null;
}

export class ClientStateStore {
  private state_: RoomState = emptyRoomState();
  /** 本地玩家 id —— 由握手(`session.ts` 的 `hello`)告知;未知为空串。 */
  private localId_ = '';
  private decodeErrors_ = 0;
  private emptyFrames_ = 0;
  /**
   * ★ WS-FND-113:被**单调门**丢弃的旧帧数。
   *
   * 与 `emptyFrames_` / `decodeErrors_` **分开计**:三种"没合入"的成因不同
   * (本 tick 无差量 / 坏包 / 这帧来晚了)。混成一个数就再也分不出
   * 「网络乱序」与「重连重放」,而这两者的处置完全不同(见 `apply` 的单调门)。
   */
  private staleFrames_ = 0;
  private lastError_: string | undefined;
  /**
   * ★ D-14:最近一帧包头带回的 `ackedSeq`(`-1` = 还没收到过任何 ack)。
   *
   * ## 为什么它住在 store 而不是 session
   * 它是**解码结果的一部分**(`decodePacket` 的字段),而解码只在这里发生
   * ⇒ 放这里,`session.ts` 的运输层**不需要**知道协议头长什么样
   *   (它只把字节交过来)。判据:`tests/WS-FND-58` 的 FND58-8 钉住这一点。
   *
   * ## 它的消费方
   * `main.ts` 每 tick 把它喂进 `LocalPredictor.onAuthoritative({ackedSeq})`,
   * 由预测器剪 `pending`。**不许**在客户端另外造一个 ack(那会让
   * "剪枝真的发生"变成一条本地可以伪造的断言 —— 见 WS-FND-63 的负对照)。
   */
  private ackedSeq_ = -1;

  /** 当前权威状态。**只读**:调用方不得就地改它(`applyPacket` 每帧返回新对象)。 */
  get state(): RoomState {
    return this.state_;
  }

  get localPlayerId(): string {
    return this.localId_;
  }

  /** 坏包计数(供自检与 WS-12 断言)。 */
  get decodeErrors(): number {
    return this.decodeErrors_;
  }

  /** 被跳过的空帧计数。 */
  get emptyFrames(): number {
    return this.emptyFrames_;
  }

  /** ★ WS-FND-113:被单调门丢弃的旧帧(差量帧 tick 未前进)计数。 */
  get staleFrames(): number {
    return this.staleFrames_;
  }

  get lastError(): string | undefined {
    return this.lastError_;
  }

  /** ★ D-14:服务端**已应用**到的客户端命令序号(最近一帧包头带回;`-1` = 还没有)。 */
  get lastAckedSeq(): number {
    return this.ackedSeq_;
  }

  /** 握手拿到自己的 id 时调一次。空串表示未知(圆心会因此返回 `null`)。 */
  setLocalPlayerId(id: string): void {
    this.localId_ = id;
  }

  /**
   * 合入一帧字节。**不抛** —— 坏包记为 `decode-failed` 并计数。
   *
   * `bytes` 为 `null` 视作空帧(WebSocket 的 `message` 事件在
   * `binaryType` 收到空负载时可能给出空 `ArrayBuffer`,见 `session.ts`)。
   */
  apply(bytes: Uint8Array | null): ApplyResult {
    const tickBefore = this.state_.meta.tick;

    /* ── 坑 2:0 字节 = 「本 tick 无差量」,**不是**坏包 ──
       实测 decodePacket(new Uint8Array(0)) 会抛("报文截断") ⇒ 必须在此拦下。 */
    if (bytes === null || bytes.byteLength === 0) {
      this.emptyFrames_ += 1;
      return { changed: false, tick: tickBefore, skipped: 'empty-frame', ackedSeq: null };
    }

    /* ── 解码:版本不符 / op 未知 / 截断 都会在此抛 ── */
    let pkt: DecodedPacket;
    try {
      pkt = decodePacket(bytes);
    } catch (e) {
      this.decodeErrors_ += 1;
      this.lastError_ = (e as Error).message ?? String(e);
      return {
        changed: false, tick: tickBefore, skipped: 'decode-failed',
        error: this.lastError_, ackedSeq: null,
      };
    }

    /* ── ★ WS-FND-113 第 5 处:单调门 —— **旧帧不许把权威状态拉回** ──
     *
     * ## 修的是什么
     * 此前 `applyPacket` 无条件用包头 tick 覆盖 `meta.tick`,于是**晚到的旧帧**
     * 也会被合入 ⇒ 权威位置被往回拉一小段。它的外观与"网络抖动"完全一样,
     * 而且 `changed` 仍是 true、`decodeErrors` 仍是 0 ⇒ 没有任何指标会红。
     *
     * ## 为什么只拦 `DELTA`,而且用 `<=`
     * `DELTA` 是**相对上一份状态**的差量 ⇒ 它作用在**已前进**的基线上会写坏状态
     * (同一份差量应用两次 = 把某一帧的位移记两遍)。服务端每帧 `step()` 一次、
     * 广播一次 ⇒ 同一条连接上 tick **严格递增**,`tick <= 当前` 只可能是
     * 重复投递或乱序晚到。
     *
     * `FULL` **无条件接受**:它是自包含快照(入场 / 重连恢复)。重连时服务端的
     * tick 可能**小于**断线前收到的那个数 —— 按 tick 丢掉它,就等于把唯一的
     * 恢复快照扔掉,此后每一帧 `DELTA` 都因基线不符被继续丢 ⇒ 客户端**永久冻结**,
     * 而且不会报任何错。⇒ 这条豁免是**必要的**,不是宽松。
     */
    if (pkt.op === PacketOp.DELTA && pkt.tick <= this.state_.meta.tick) {
      this.staleFrames_ += 1;
      return { changed: false, tick: tickBefore, skipped: 'stale-frame', ackedSeq: null };
    }

    /* ── 坑 1:`applyPacket` 返回**新对象** ⇒ 必须接住返回值。
       写成 `applyPacket(this.state_, pkt);`(丢弃返回值)会静默无效 ——
       状态不变、不报错、画面冻住而没有任何提示。 */
    this.state_ = applyPacket(this.state_, pkt);

    /* ★ D-14:包头带回的 ack 也是**这一帧的事实** —— 与状态一起落账。
       ★ WS-FND-113:但**只进不退**。乱序帧的 ack 天然更旧,而 `ackedSeq_` 的
       消费者(`LocalPredictor.pruneCmds`)按"最高 ack"剪队列 ⇒ 让它倒退会让
       "已经确认过的命令"重新变成待确认,`prunedTotal` 也不再单调
       (判据读的正是这个计数)。`-1`(本帧没带 ack)因此**不会**把已有值抹掉。 */
    if (Number.isFinite(pkt.ackedSeq) && pkt.ackedSeq > this.ackedSeq_) {
      this.ackedSeq_ = pkt.ackedSeq;
    }

    return { changed: true, tick: this.state_.meta.tick, skipped: null, ackedSeq: pkt.ackedSeq };
  }
}
