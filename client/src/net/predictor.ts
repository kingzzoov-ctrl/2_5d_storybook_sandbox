/**
 * 本地预测循环 —— 把 `net/prediction.ts` 的四族接到**生产链**上。
 *
 * ## 它解决的是「预测器没有生产者」的另一半
 *
 * `net/input.ts` 造出了 `InputCmd`;但 `InputCmd` 还需要有人**按 tick 推它**、
 * 并在服务端权威姿态到达时**用同一套输入重演**。这一步以前不存在 ⇒
 * `predictStep` / `reconcile` / `resimulate` / `pruneCmds` 四族在生产里零引用。
 *
 * ## 判据:为什么是「先剪、再重演」而不是「直接设成权威值」
 *
 * ```
 * 直接设成权威值:  客户端位置 = 服务端位置
 *   ⇒ 玩家按键期间的位移被**抹掉**(权威值落后一个 RTT)
 *   ⇒ 手感是「按住 D 走一步、弹回去、再走一步」
 * 先剪已确认、再重演剩余:
 *   位置 = 从权威值出发,重跑服务端还没处理的那几条命令
 *   ⇒ 服务端处理到哪、客户端就对齐到哪,按键位移不丢
 * ```
 * 后者是 `prediction.ts` 里 `resimulate` 的 docblock 写的用法,本文件只是**真的用它**。
 *
 * ## 与 `Interpolator` 的分工(别把两者混起来)
 *
 * ```
 * 自己(本地玩家)  → 本文件:预测 + 重演,位置**先于**服务端到位
 * 别人(远端玩家)  → Interpolator:按服务端时间戳插值,位置**落后**约 INTERP_DELAY_S
 * ```
 * 把本地玩家也塞进 `Interpolator` 会凭空多出 100ms 延迟 ——
 * 那是「所有人都像在冰上」的经典成因。
 */

import { DT } from '../../../shared/types/physics.ts';
import {
  ReconcileAction,
  absorbOffset,
  predictStep,
  pruneCmds,
  reconcile,
  resimulate,
  type InputCmd,
  type PredictParams,
  type ReconcileResult,
  type Vec3,
} from './prediction.ts';

/** 服务端权威姿态(位置 + 它已处理到的命令序号)。 */
export interface AuthoritativePose {
  x: number;
  y: number;
  z: number;
  /**
   * 服务端**已处理**到第几条客户端命令。
   * `undefined` = 服务端没回这个数(当前协议就是如此,见下)。
   */
  ackedSeq?: number;
}

/**
 * 本地预测器。
 *
 * ## `ackedSeq`:剪枝这条路**本文件已经通了**,缺的是**线上那个字段**
 *
 * `onAuthoritative` 收到 `ackedSeq` 就用 `pruneCmds` 剪(第三道门见那里的注释)。
 * 但**目前没有任何东西会把它喂进来** —— 实测:
 * ```
 * client/src/net/session.ts  `ackedSeq` 0 次(下行只分派 welcome / actionResult / 二进制包)
 * shared/net/delta.ts        `ackedSeq` 0 次(下行快照是 encodeFull/encodeDelta 的字节,
 *                             decodePacket 的字段表里没有它)
 * ```
 * ⇒ 要让它上到线上,得动**冻结层** `shared/net/delta.ts` 的编解码 + `session.ts`/`state_store.ts`
 * 的解码路径 —— 这条已按裁决 D-08 上报 owner,**本文件不偷偷扩协议**。
 *
 * 在该字段缺席期间,本类**不剪队列**,改为保留最近 `MAX_PENDING` 条命令
 * 并给出一条**可断言**的降级行为(见 `pendingTruncated`)。
 * 这条不是"先凑合":若不剪也不截断,队列会随游戏时长无界增长 ——
 * 那是一种**不会报错的内存问题**,而它会先被人当成"卡"。
 */
export const MAX_PENDING = 120;

export class LocalPredictor {
  private predicted: Vec3;
  private pending: InputCmd[] = [];
  private last: ReconcileResult | null = null;
  /** SMOOTH 时留下的**视觉**偏移(位置早已对齐权威,这个只影响渲染)。 */
  private visualOffset: Vec3 = { x: 0, y: 0, z: 0 };
  private truncated = 0;
  /**
   * 已被服务端确认的**最高**序号。`-1` = 还没收到任何 `ackedSeq`。
   *
   * ⚠️ 它必须**单调** —— 回执可能乱序(重连后旧帧晚到),而
   * `pruneCmds` 只是 `seq > acked` 的过滤:喂一个倒退的 ack 不会丢数据,
   * 但会让"剪枝计数"倒退/重复计数(判据读的就是计数)。
   */
  private acked = -1;
  /** 被 `pruneCmds` 剪掉的命令**累计**条数(证明"剪枝真的发生"的计数器)。 */
  private pruned = 0;

  constructor(spawn: Vec3 = { x: 0, y: 0, z: 0 }) {
    this.predicted = { ...spawn };
  }

  /** 逻辑位置(权威已对齐过的)。 */
  get pos(): Vec3 {
    return { ...this.predicted };
  }

  /** 渲染位置 = 逻辑位置 + 尚未收回的视觉偏移。 */
  get renderPos(): Vec3 {
    return {
      x: this.predicted.x + this.visualOffset.x,
      y: this.predicted.y + this.visualOffset.y,
      z: this.predicted.z + this.visualOffset.z,
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 因队列超过 `MAX_PENDING` 被丢掉的命令数(0 才是健康值)。 */
  get pendingTruncated(): number {
    return this.truncated;
  }

  get lastReconcile(): ReconcileResult | null {
    return this.last;
  }

  /**
   * 已被服务端确认到的序号(`-1` = 服务端一次都没回过这个字段)。
   *
   * 判据用它,而不是用 `pendingCount` 单独看:队列长度同时受
   * `MAX_PENDING` 截断与 `SNAP` 清空影响 ⇒ 只看长度会**把三种原因混成一个数**。
   */
  get lastAckedSeq(): number {
    return this.acked;
  }

  /**
   * 因回执被 `pruneCmds` 剪掉的命令**累计**条数 —— 单调不减。
   *
   * 为什么需要它:`pendingCount` 从 3 变成 1 也可能是截断或 SNAP 造成的;
   * 这个计数器只在 ack 推进时增长 ⇒ `> 0` 才真的证明"剪枝跑过"。
   */
  get prunedTotal(): number {
    return this.pruned;
  }

  /** 推进一步。`cmd` 进入待确认队列 —— 服务端确认后由 `onAuthoritative` 剪掉。 */
  step(cmd: InputCmd, params: PredictParams = {}): Vec3 {
    this.pending.push(cmd);
    if (this.pending.length > MAX_PENDING) {
      this.truncated += this.pending.length - MAX_PENDING;
      this.pending = this.pending.slice(-MAX_PENDING);
    }
    this.predicted = predictStep(this.predicted, cmd, params);
    return this.pos;
  }

  /**
   * 服务端权威姿态到达:
   * 1 有 `ackedSeq` ⇒ 剪掉已确认的命令;
   * 2 从**权威位置**出发重演剩余命令;
   * 3 用 `reconcile` 给这次校正分类(死区忽略 / 软校正 / 硬对齐)。
   */
  onAuthoritative(pose: AuthoritativePose, params: PredictParams = {}): ReconcileResult {
    /* ⚠️ 三道门,缺一不可(`ackedSeq` 现在**没有**线上来源,见文件头):
       1 `Number.isFinite` —— `NaN` 会让 `pruneCmds` 的 `seq > NaN` 全为假
          ⇒ **整个队列被静默清空**(位置从此只靠权威值,按键位移被抹掉);
       2 `a > this.acked` —— 倒退/重复的回执不该再剪一次(计数会骗人);
       3 未给(`undefined`)= 本协议还没有这个字段 ⇒ 交给 `MAX_PENDING` 截断。 */
    const a = pose.ackedSeq;
    if (typeof a === 'number' && Number.isFinite(a) && a > this.acked) {
      const before = this.pending.length;
      this.pending = pruneCmds(this.pending, a);
      this.pruned += before - this.pending.length;
      this.acked = a;
    }
    const before = this.predicted;
    const authoritative: Vec3 = { x: pose.x, y: pose.y, z: pose.z };
    const resimulated = resimulate(authoritative, this.pending, params);
    const r = reconcile(before, resimulated);
    this.last = r;
    if (r.action === ReconcileAction.SNAP) {
      /* 硬误差:连待确认队列一起丢 —— 位置已经不可信,再重演只会把错误放大。 */
      this.pending = [];
      this.predicted = authoritative;
      this.visualOffset = { x: 0, y: 0, z: 0 };
      return r;
    }
    if (r.action === ReconcileAction.SMOOTH) {
      this.predicted = resimulated;
      this.visualOffset = r.offset;
      return r;
    }
    /* IGNORE:预测与重演结果同在死区内 ⇒ 不动,也不产生视觉偏移。 */
    this.visualOffset = { x: 0, y: 0, z: 0 };
    return r;
  }

  /** 每帧收回视觉偏移(收敛窗口见 `prediction.ts` 的 `SMOOTH_WINDOW_S`)。 */
  absorbVisual(dt: number = DT): void {
    if (this.visualOffset.x === 0 && this.visualOffset.y === 0) return;
    const { rest } = absorbOffset(this.visualOffset, dt);
    this.visualOffset = rest;
    if (Math.abs(rest.x) < 1e-4 && Math.abs(rest.y) < 1e-4) {
      this.visualOffset = { x: 0, y: 0, z: 0 };
    }
  }

  /**
   * 传送 / 重连:位置与队列一起重置。
   *
   * `acked` 也回到 `-1`:重连后的命令序号从 1 重新开始(见 `input.ts` 的 `InputSource`),
   * 留着旧的 ack 会让新会话的第一批命令**一条都进不了队列**(`seq > 旧ack` 恒假)
   * ⇒ 表现是"重连后角色不动",且不报错。
   */
  reset(spawn: Vec3): void {
    this.predicted = { ...spawn };
    this.pending = [];
    this.last = null;
    this.visualOffset = { x: 0, y: 0, z: 0 };
    this.truncated = 0;
    this.acked = -1;
    this.pruned = 0;
  }
}
