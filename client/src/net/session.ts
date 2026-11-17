/**
 * 客户端会话 —— **本仓唯一**碰 `WebSocket` 的地方。
 *
 * ## 为什么用内置 `WebSocket`,不用 colyseus
 *
 * 实测(Lead 复核):
 *   · `typeof WebSocket === 'function'`(Node 24 / 浏览器都有)⇒ **零新增依赖**
 *   · 二进制帧往返逐字节一致(双向 11 B)+ 大帧 125/126/127/1000/70000 全过
 *   · 服务端那一侧也已证实**零依赖**(`node:http` upgrade + 手写帧,~90 行)
 *   · `server/src/net/room.colyseus.ts:41` `USE_COLYSEUS_PATCH = false`
 *     ⇒ 那套同步通道**本来就关着**,只剩 4 个 `onMessage` 的**协议语义**,
 *       而协议语义与运输层正交 ⇒ 换运输层不丢语义
 * ⇒ 两侧都不新增依赖,且协议**只有一份实现**(`shared/net/delta.ts`)。
 *
 * ## 分帧与超时:**未实现**,如实标注
 *
 * 本文件只处理**整帧**(`ev.data` 是一个完整 `ArrayBuffer`)。
 * 实测:服务端发 ≤70000 B 时内置客户端**没有分片**;但不保证所有实现都不分片。
 * 也**未**回 pong(只处理 close)⇒ 长连接可能被对端判死。
 * ⇒ 接生产前必须处理,已列入 CR-26 的未测清单。
 *
 * ## 握手契约:**收发两侧不对称**,刻意如此
 *
 * 裁决(Lead,2026-11-13):`registry.ts` / `handshake.ts` **批准上移**
 * `shared/content/`,但**不排在阶段 3 之前**。
 * ⇒ ∴ 契约**容纳**两侧:
 *   · **收**:服务端的内容指纹 —— 阶段 3 **必做**(收到即记账,可显示)
 *   · **发**:客户端自算指纹 —— 阶段 3 **留空**(拿不到 `registry.ts`,算不出来)
 * ⇒ 上移完成后只需**填发的那一半**,**不改契约**。
 *   ★ 这是「契约要**容纳**未来,不是**实现**未来」。
 */

import {
  PROTOCOL_VERSION,
} from '../../../shared/net/delta.ts';
import { ClientStateStore, type ApplyResult } from './state_store.ts';

/** 握手:客户端 → 服务端。`contentClaim` 阶段 3 留空(见文件头)。 */
export interface HelloFrame {
  t: 'hello';
  protocolVersion: number;
  /** ★ 阶段 3 留空:客户端还拿不到 `registry.ts`,算不出自己的指纹。 */
  contentClaim: null;
  /** 可选入场凭据(形状取自 `room.colyseus.ts:134` 的 `onJoin` 形参)。 */
  passwordHash?: string;
  asGuest?: boolean;
}

/** 握手:服务端 → 客户端。 */
export interface WelcomeFrame {
  t: 'welcome';
  /** 本地玩家 id —— 圆心要用它找"自己"(见 `telegraph_center.ts`)。 */
  playerId: string;
  roomId: string;
  /** 服务端的协议版本。与本地不符则**明确失败**,不静默降级。 */
  protocolVersion: number;
  /**
   * 服务端的内容指纹(`handshake.ts` 的 `encodeContentClaim` 输出:
   * `v{version}-{overall}` 或 `v{version}-{overall}-{items}.{mobs}.{bosses}.{modes}`)。
   * 阶段 3 **只收不发** ⇒ 存下来、可显示,**不**据此拒绝进场(因为客户端无从自核)。
   */
  contentClaim: string;
}

export type SessionState = 'idle' | 'connecting' | 'live' | 'closed' | 'failed';

export interface SessionEvents {
  /** 状态流:每收到一帧**有效**字节调一次。 */
  onFrame: (r: ApplyResult, store: ClientStateStore) => void;
  /** 状态机变化(供 UI / 自检)。 */
  onState?: (s: SessionState, detail?: string) => void;
  /** 握手的 welcome 到了。 */
  onWelcome?: (w: WelcomeFrame) => void;
  /**
   * 载荷形态不对、帧被丢弃时调用(见 `SessionHandle.droppedFrames`)。
   * ★ 这个回调存在的唯一目的:**让静默丢帧变成可观测**。
   */
  onDrop?: (reason: string) => void;
  /**
   * 动作回执到了(服务端 `t:'actionResult'`)。
   *
   * ★ 这个回调存在的理由与 `onDrop` 同族:**让"被拒"变成可观测**。
   *   没有它,客户端只能看见"我发了、什么都没发生" ——
   *   而那正是本仓反复记的静默形态。
   */
  onActionResult?: (r: ActionResultFrame) => void;
}

/**
 * 描述一个无法按字节处理的载荷。
 *
 * 目的不是"调试好看",而是**让自检脚本一眼分辨**这是形态问题还是网络问题:
 * 若原因是 `Blob`,那就是 `binaryType` 没设对,而不是服务端没发。
 */
function describePayload(raw: unknown): string {
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return `收到 Blob(${raw.size} B)而非 ArrayBuffer —— binaryType 未设为 'arraybuffer'`;
  }
  if (raw === null) return '载荷为 null';
  if (typeof raw === 'string') return `收到字符串(${raw.length} 字符)而非二进制帧`;
  if (typeof raw === 'object') return `收到对象(${Object.keys(raw as object).slice(0, 3).join(',')})而非二进制帧`;
  return `收到 ${typeof raw} 而非二进制帧`;
}

/** 会话句柄。 `close()` 幂等。 */
export interface SessionHandle {
  readonly store: ClientStateStore;
  readonly state: SessionState;
  /** 服务端指纹(握手收到后可用;核心是**只读记账**,见文件头)。 */
  readonly serverContentClaim: string | null;
  /**
   * 因**载荷形态不对**被丢弃的帧数 —— ★ 这是「不许静默丢数据」的出口。
   *
   * ## 为什么要有这个计数器
   *
   * 实测:真 `WebSocket` 的 `binaryType` **默认是 `'blob'`**。若不显式设为
   * `'arraybuffer'`,二进制帧到达时 `ev.data` 是 **Blob** 而非 `ArrayBuffer`
   * ⇒ 「服务端在发、客户端一帧也没收到」,而**三者都不会报错**:
   * `decodeErrors` 是 0(根本没走到解码)、`emptyFrames` 是 0、连接状态是 `live`。
   * ⇒ 表现为「画面永远停在出生点」,而所有指标看起来正常。
   *
   * ⇒ ∴ 载荷形态不对时**必须留痕**。初版写的是直接 `return`(静默忽略)——
   *   故障注入实测:那种写法下「删掉 `binaryType = 'arraybuffer'`」**查不出来**
   *   (加了 Blob 桩的假 socket 也全绿,因为丢弃路径不留任何痕迹)。
   */
  readonly droppedFrames: number;
  /** 最近一次丢弃的原因(便于自检脚本一眼看出是"形态"问题,不是"网络"问题)。 */
  readonly lastDropReason: string | null;
  /** 发一帧上行(原始字节,由调用方用 `delta.ts` 编码)。未连接时返回 false。 */
  send(bytes: Uint8Array): boolean;
  /**
   * 上行一条**移动意图**(WASD 驱角色的产物)。
   *
   * ★ 2026-11-14(task-83 选乙)新增:此前生产侧 `send` 调用点 **0 处**,
   * 于是「客户端命令序号」这条链路在协议上根本不存在。
   * 未连接时返回 `false`(与 `send` 同一纪律:不抛、不静默假装成功)。
   */
  sendMove(intent: MoveIntent): boolean;
  /**
   * 上行一条**攻击意图**(2026-11-14)。服务端把它交给
   * `room.applyAttack(userId, bonus, mobId)`,并把结算报告回成 `t:'attackResult'`。
   *
   * ⚠️ 没有这条时「打怪」在客户端**无处可发** —— 世界里有怪、服务端也能结算,
   *    但中间这一段缺了 ⇒ 表现就是「按了没反应」。
   */
  sendAttack(intent: AttackIntent): boolean;
  /**
   * 上行一条**动作意图**(2026-11-14)。通用动作通道的客户端半边。
   *
   * 服务端在 `ws_server` 的 `onAction` 里收下并交给
   * `RoomRuntime.dispatchAction`,回执是 `t:'actionResult'`(经
   * `events.onActionResult` 交给调用方)。未连接时返回 `false`
   * —— 与 `send` / `sendMove` / `sendAttack` 同一纪律:不抛、不假装成功。
   */
  sendAction(intent: ActionIntent): boolean;
  close(): void;
}

/** 帧首字节:0x01 = 文本(握手 JSON),0x02 = 二进制(协议包)。 */
const FRAME_TEXT = 0x01;
const FRAME_BINARY = 0x02;

/**
 * JSON 文本帧的**固有首字符** `{`(0x7B)。
 *
 * ★★★ 为什么必须有它:实测发现一个**值碰撞**,它让我的第一版下行分派**完全失效**。
 *
 * ```
 * 服务端下行 = **裸协议包**(room.ts 三处出口都直接返回 `.bytes`)
 * 裸包首字节 = PROTOCOL_VERSION = **1** = 0x01 = FRAME_TEXT
 * ⇒ 第一版写的是 `if (bytes[0] === FRAME_TEXT) { 当 JSON 解析 }`
 *   ⇒ 裸包**首字节恰好命中** ⇒ 被当 JSON 解析 ⇒ JSON.parse 抛
 *   ⇒ setState('failed','welcome 解析失败:Unexpected token ...')
 *   ⇒ ★ **端到端全线失败**,而我的 WS-12 从未测到 —— 因为它全部用
 *     `binaryFrame()`(**人为加了 0x02 tag**),而真服务端**不加 tag**。
 * ```
 * ⇒ ∴ 判"是不是文本"只能靠**内容特征**(JSON 恒以 `{` 开头),
 *   **不能**靠那个 tag 常量 —— 它与协议版本号撞了。
 */
export const JSON_PREFIX = 0x7B;

/**
 * 下行字节分类 —— **纯函数**,导出以便 WS-12 直接断言(不需要真 socket)。
 *
 * ## 判定规则(三条,顺序不可换)
 *
 * ```
 * ① 首个字节是 `{`            ⇒ 文本(**裸** JSON)
 * ② 首字节 0x01 **且** 次字节 `{` ⇒ 文本(带了 tag 的 JSON)
 *    ★ 必须看**第 2 字节**才能与「裸协议包」区分:裸包首字节也是 0x01,
 *      但它的第 2 字节是 `op`(0/1),**不是** `{`。
 * ③ 其余 ⇒ 二进制。默认**原样**(服务端裸发的真实行为);
 *    仅当 `PROTOCOL_VERSION !== 0x02` 时才容忍一个前置 0x02 tag。
 * ```
 *
 * ## ⚠️ 残留歧义(如实标注,不假装没有)
 *
 * 若 `PROTOCOL_VERSION` 将来变成 **2**(== `FRAME_BINARY`),
 * 则「裸包首字节」与「tag」**无法区分** ⇒ 规则③ 主动**不猜**(原样处理)。
 * 那时若服务端仍裸发,行为正确;若服务端加 tag,会在解码处报清晰错误。
 */
export function classifyDownlink(bytes: Uint8Array):
  { kind: 'text'; payload: Uint8Array } | { kind: 'binary'; payload: Uint8Array } {
  /* ① 裸 JSON */
  if (bytes.byteLength > 0 && bytes[0] === JSON_PREFIX) return { kind: 'text', payload: bytes };
  /* ② 带 tag 的 JSON:0x01 + `{` */
  if (bytes.byteLength > 1 && bytes[0] === FRAME_TEXT && bytes[1] === JSON_PREFIX) {
    return { kind: 'text', payload: bytes.subarray(1) };
  }
  /* ③ 二进制 —— 服务端裸发;仅在无歧义时容忍前置 tag */
  const unambiguousTag = PROTOCOL_VERSION !== FRAME_BINARY;
  const tagged = unambiguousTag && bytes.byteLength > 1 && bytes[0] === FRAME_BINARY;
  return { kind: 'binary', payload: tagged ? bytes.subarray(1) : bytes };
}

/** 把上行帧包上 1 字节类型头(服务端据此分流 JSON / 协议包)。 */
export function encodeClientFrame(payload: Uint8Array, isText: boolean): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = isText ? FRAME_TEXT : FRAME_BINARY;
  out.set(payload, 1);
  return out;
}

/**
 * 上行**移动意图** —— WASD 驱角色的产物(2026-11-14 task-83 选乙)。
 *
 * ## 坐标口径(必须与两处一致,否则会出现「服务端认为你在瞬移」)
 *
 * ```
 * 发的是**绝对位置**(tick + x/y/z),不是方向向量。
 * 理由:`server/src/net/anticheat.ts` 的 `checkMove` 判的是
 *       「dist(新旧坐标) / tick 差」与窗口速率 —— 方向向量喂给它没有意义。
 * 字段名与服务端 `room.colyseus.ts` 的 `onMessage('move')` 入参逐字相同。
 * ```
 *
 * ## ★ `seq`(D-14,2026-11-17):这条上行是「第几条命令」
 *
 * 它是下行包头 `ackedSeq` 的**因**:服务端在 `applyMove` **成功之后**记下
 * 这条连接的 `seq`(见 `ws_server.ts` 的 `onMove`),下一帧把它写进包头
 * ⇒ 客户端据此剪掉已确认的预测命令(`predictor.pruneCmds`)。
 *
 * ```
 * 生产者:client/src/main.ts 把 `cmd.seq`(来自 input.ts,单调递增,首个 = 1)带上
 * ```
 * ⚠️ 没有它整条 ack 链**接不上**,而症状是「服务端收到了移动、客户端却永不剪枝」
 *    —— 两边都不报错(上游 `docs/TASK-100-ackedseq-frozen-unlock.md` 实测:
 *    这条生产者此前**不存在**)。
 *
 * ⚠️ 服务端对它的校验是「非负整数」,坏值(1.5 / -3 / NaN)当**没给**
 *    (`ws_server.ts` 的 `parseMoveIntent`)—— 与 `speedMul` 同一取舍。
 */
export interface MoveIntent {
  /** 客户端 tick(用于 ac 的速率窗口)。 */
  tick: number;
  x: number;
  y: number;
  z: number;
  /** 速度倍率(装备 / 料理 / 叠罗汉)。省略时服务端按 1 处理。 */
  speedMul?: number;
  /** 客户端命令序号 —— 服务端回执(包头 `ackedSeq`)就是它。省略 ⇒ 这条不带 ack。 */
  seq?: number;
}

/**
 * 把移动意图编成**上行文本帧**。纯函数 ⇒ 帧形态可被断言。
 *
 * ⚠️ 走**文本**而不是二进制:文本分支在 `ws_server.ts` 里被解析成 JSON,
 * 而二进制分支走的是 `decodePacket`(那是**下行**包格式)。
 * 用错分支的表现是「帧发出去了、服务端解析失败或当别的东西处理」——
 * 不报错、也不断连,只是什么都不会发生。
 */
export function encodeMoveUplink(intent: MoveIntent): Uint8Array {
  const json = JSON.stringify({ t: 'move', ...intent });
  return encodeClientFrame(new TextEncoder().encode(json), true);
}


/** 上行**攻击意图**。`mobId` 取自快照里的 `state.wildlife[].mobId`。 */
export interface AttackIntent {
  /** 目标生物 id(服务端 `applyAttack(userId, bonus, mobId)` 的第三个参数)。 */
  mobId: string;
  /** 客户端声明的加成;服务端自己判上限,不采信这个数(反作弊)。 */
  bonus?: number;
}

/**
 * 上行**动作意图**(2026-11-14)。线上是 `t:'action'`。
 *
 * `action` 取 `RoomAction` 的名字(字符串形式);其余字段是该动作的参数。
 * 为什么不做成 `RoomAction` 联合类型:那个枚举住在**服务端**模块里,
 * 客户端 import 它会把服务端拖进浏览器包 —— 而线上本来就是字符串。
 */
export interface ActionIntent {
  action: string;
  [k: string]: unknown;
}

/**
 * 动作回执(服务端 `t:'actionResult'`)。
 *
 * `kind` 是**分类**而不是"成功/失败":`PERMISSION`(越权)与 `INVALID`
 * (参数/状态不对)必须能被客户端区分开 —— 混成一个布尔值就没法给玩家
 * 正确的提示("你没权限" vs "那儿放不了")。
 */
export interface ActionResultFrame {
  t: 'actionResult';
  action: string;
  ok: boolean;
  kind: 'OK' | 'INVALID' | 'PERMISSION' | 'NOT_IMPLEMENTED' | 'ROOM_CLOSED';
  reason?: string;
  effect?: Record<string, unknown>;
}

/**
 * 把动作意图编成上行文本帧(与 `encodeMoveUplink` / `encodeAttackUplink` 同形态)。
 *
 * ⚠️ `t` 放在展开**之后**:这样调用方无法用一个同名的 `t` 覆盖类型头。
 *    反过来写(`{ t:'action', ...intent }`)时,`intent.t` 会赢 ——
 *    服务端就会按别的报文处理这一帧,而**两端都不会报错**。
 */
export function encodeActionUplink(intent: ActionIntent): Uint8Array {
  const json = JSON.stringify({ ...intent, t: 'action' });
  return encodeClientFrame(new TextEncoder().encode(json), true);
}

/** 把攻击意图编成上行文本帧(与 `encodeMoveUplink` 同一形态:文本 + `t` 分流)。 */
export function encodeAttackUplink(intent: AttackIntent): Uint8Array {
  const json = JSON.stringify({ t: 'attack', ...intent });
  return encodeClientFrame(new TextEncoder().encode(json), true);
}
/**
 * 从**上行帧**里剥掉类型头。导出是为了让 WS-12 能测它 ——
 * 这是本模块里唯一**纯**的部分(其余都需要真 WebSocket)。
 */
export function decodeClientFrame(frame: Uint8Array):
  { kind: 'text'; payload: Uint8Array } | { kind: 'binary'; payload: Uint8Array } | null {
  if (frame.byteLength === 0) return null;
  const tag = frame[0];
  const payload = frame.subarray(1);
  if (tag === FRAME_TEXT) return { kind: 'text', payload };
  if (tag === FRAME_BINARY) return { kind: 'binary', payload };
  return null;
}

export interface SessionOptions {
  /** `ws://host:port` 形式的地址(构造后拼接,便于测试注入)。 */
  url: string;
  /**
   * 复用的状态存储。
   *
   * ★ **必须由调用方传入** —— 不要在本模块内部另建一个。
   * 原因:`boot()` 的渲染循环每帧读**它自己那个** store。
   * 若本模块再建一个,结果是「字节写进了 A,渲染读的是 B」⇒
   * **字节收到了、画面不动**,而两个 store 各自都"正常工作"、无人报错。
   * ⇒ 这是本仓反复出现的形态(两处都对、合起来不对),所以把「谁持有 store」
   *   变成**编译期可见的参数**,而不是运行期的一个约定。
   * (省略时退化为自建 —— 只有单测/冒烟才该这样用。)
   */
  store?: ClientStateStore;
  /** 供测试替换(默认 `globalThis.WebSocket`)。 */
  makeSocket?: (url: string) => WebSocketLike;
  events: SessionEvents;
}

/** 我们用到的最小 WebSocket 面(便于在无网环境下注入替身)。 */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, fn: (ev: never) => void): void;
}

/** 建一个会话:**不同步等握手** —— 连接与握手都在事件回调里推进。 */
export function createSession(opts: SessionOptions): SessionHandle {
  const store = opts.store ?? new ClientStateStore();
  let state: SessionState = 'idle';
  let serverClaim: string | null = null;
  let socket: WebSocketLike | null = null;
  let droppedFrames = 0;
  let lastDropReason: string | null = null;

  const setState = (s: SessionState, detail?: string): void => {
    state = s;
    opts.events.onState?.(s, detail);
  };

  const make = opts.makeSocket
    ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);

  try {
    setState('connecting');
    socket = make(opts.url);
    /* 二进制帧给 ArrayBuffer —— 实测内置客户端在 `arraybuffer` 下
       `ev.data instanceof ArrayBuffer` 为真,可直接喂 `decodePacket`。 */
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', (() => {
      /* 连接建立后**先**发握手。上行也走 1 字节类型头,服务端据此分流。 */
      const hello: HelloFrame = {
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        contentClaim: null,          /* ★ 阶段 3 留空:见文件头 */
      };
      try {
        socket?.send(encodeClientFrame(new TextEncoder().encode(JSON.stringify(hello)), true));
      } catch (e) {
        setState('failed', (e as Error).message);
      }
    }) as never);

    socket.addEventListener('message', ((ev: { data: unknown }) => {
      const raw = ev.data;
      /* 服务端的下行:**两种 WebSocket 帧类型都会出现**(实测,见下)。
         📌 2026-11-14 修:此前这里只接受 `ArrayBuffer` / 视图,于是
         **服务端的 welcome 文本帧**落进下面的 `else` ⇒ 被当「载荷形态不对」丢弃
         ⇒ 握手**永不完成**。实测证据(真 `startWsServer` + 真 `createSession`):
         ```
         下行原始形态: string(len=119) | ArrayBuffer(82) | ArrayBuffer(10) | ...
         createSession ⇒ state = connecting(永不 live)
                       · store.localPlayerId = ""     ← 没拿到自己的 id
                       · store.state.players  = 1     ← ★ 二进制快照**照常合入**
                       · droppedFrames = 1 · lastDropReason = "收到字符串(119 字符)而非二进制帧"
         ```
         ⇒ 症状极具误导性:「画面在动、状态在变」,只有圆心恒 `null`。
         ⇒ 判据:**两端各自的单元测试都过,而它们之间的帧类型约定没人测**
           (`WS-12` 全用人为造的字节帧 ⇒ 结构上碰不到这条路径)。
           端到端判据见 `tests/WS-FND-15-e2e.test.ts`(它两条都红过)。
         ⇒ 修法:文本帧按 UTF-8 编成字节,**汇入同一个 `classifyDownlink` 分派**。
           ⚠️ 不新开一条「是字符串就当 JSON」的旁路 —— 那会长出**第二份判定**,
              而两份判定日后必然漂移(陷阱 31/41)。 */
      let bytes: Uint8Array | null = null;
      if (typeof raw === 'string') {
        /* ★ 文本帧在协议里**只可能是**握手 JSON(下行唯一的文本)。
           若它不是以 `{` 开头,那就是**形态不对**,不是"坏协议包" ——
           两者必须分开计数(`droppedFrames` vs `decodeErrors`),否则会把
           **形态问题**报成**坏包**,正是本仓记过的「症状名 ≠ 成因名」(陷阱 137)。
           ⚠️ 若不在此拦下,`classifyDownlink` 会把它归为二进制、喂给解码器
              ⇒ 它就会以「解码失败」的形态出现,原因指向错方向。 */
        const asBytes = new TextEncoder().encode(raw);
        if (asBytes.byteLength === 0 || asBytes[0] !== JSON_PREFIX) {
          droppedFrames += 1;
          lastDropReason = `收到文本帧但不是 JSON(前 24 字符:${raw.slice(0, 24)})`;
          opts.events.onDrop?.(lastDropReason);
          return;
        }
        bytes = asBytes;
      } else if (raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw);
      } else if (ArrayBuffer.isView(raw)) {
        /* 某些实现给 TypedArray / Buffer 视图 —— 也接受(否则又是一次静默丢帧) */
        bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else {
        /* ★ 载荷形态不对 ⇒ **必须留痕**,不许静默丢弃。
           最可能的成因:`binaryType` 没设成 'arraybuffer'(真 WebSocket 默认 'blob')
           ⇒ 这里收到的是 Blob ⇒ 数据被整体丢弃,而 decodeErrors 仍是 0。 */
        droppedFrames += 1;
        lastDropReason = describePayload(raw);
        opts.events.onDrop?.(lastDropReason);
        return;
      }
      /* ── 帧分派 ──
         ★ 不用 `bytes[0] === FRAME_TEXT` 判"是不是文本":实测那个常量
         (0x01)与 `PROTOCOL_VERSION`(1)**撞了**,而服务端下行是**裸协议包**
         (首字节就是 1)⇒ 会把协议包当 JSON 解析 ⇒ 端到端全线失败。
         ⇒ 交给 `classifyDownlink`(按**内容特征**判,不靠那个 tag)。 */
      const cls = classifyDownlink(bytes);
      if (cls.kind === 'text') {
        try {
          const w = JSON.parse(new TextDecoder().decode(cls.payload)) as WelcomeFrame;
          if (w.t === 'welcome') {
            if (w.protocolVersion !== PROTOCOL_VERSION) {
              setState('failed',
                `协议版本不匹配:服务端 ${w.protocolVersion} / 本地 ${PROTOCOL_VERSION}`);
              return;
            }
            serverClaim = w.contentClaim;
            store.setLocalPlayerId(w.playerId);
            opts.events.onWelcome?.(w);
            setState('live');
          } else if (w.t === 'actionResult') {
            /* ★ 2026-11-14:动作回执。**四种结果都送达**(OK / INVALID /
               PERMISSION / NOT_IMPLEMENTED)—— 客户端据此区分"被拒"与
               "服务器没听见"(见 `ws_server` 的 `onAction`)。
               ⚠️ 这里**只**加动作回执,不加 `attackResult`:攻击的反馈走
                  快照里那只怪的血量下降(见 `main.ts` 的 HUD 注释)——
                  一条真值来源,不是两条。 */
            opts.events.onActionResult?.(w as unknown as ActionResultFrame);
          }
        } catch (e) {
          /* 握手 JSON 坏 ⇒ 明确失败(握手无法猜) */
          setState('failed', `welcome 解析失败:${(e as Error).message}`);
        }
        return;
      }
      /* 二进制:store 内部处理「0 字节」与「坏包」两件事,本层不再判断。 */
      const r = store.apply(cls.payload);
      opts.events.onFrame(r, store);
    }) as never);

    socket.addEventListener('close', (() => { setState('closed'); }) as never);
    socket.addEventListener('error', (() => {
      /* 连接层错误:不抛(未连接的会话是正常状态,不是异常)。 */
      setState('failed', 'socket error');
    }) as never);
  } catch (e) {
    setState('failed', (e as Error).message);
  }

  return {
    get store() { return store; },
    get state() { return state; },
    get serverContentClaim() { return serverClaim; },
    get droppedFrames() { return droppedFrames; },
    get lastDropReason() { return lastDropReason; },
    send(bytes: Uint8Array): boolean {
      if (socket === null || socket.readyState !== 1 /* OPEN */) return false;
      socket.send(encodeClientFrame(bytes, false));
      return true;
    },
    sendMove(intent: MoveIntent): boolean {
      if (socket === null || socket.readyState !== 1 /* OPEN */) return false;
      socket.send(encodeMoveUplink(intent));
      return true;
    },
    sendAttack(intent: AttackIntent): boolean {
      if (socket === null || socket.readyState !== 1 /* OPEN */) return false;
      socket.send(encodeAttackUplink(intent));
      return true;
    },
    sendAction(intent: ActionIntent): boolean {
      if (socket === null || socket.readyState !== 1 /* OPEN */) return false;
      socket.send(encodeActionUplink(intent));
      return true;
    },
    close(): void {
      if (socket === null) return;
      try { socket.close(); } catch { /* 已关:幂等 */ }
      setState('closed');
    },
  };
}
