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
  close(): void;
}

/** 帧首字节:0x01 = 文本(握手 JSON),0x02 = 二进制(协议包)。 */
const FRAME_TEXT = 0x01;
const FRAME_BINARY = 0x02;

/** 把上行帧包上 1 字节类型头(服务端据此分流 JSON / 协议包)。 */
export function encodeClientFrame(payload: Uint8Array, isText: boolean): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = isText ? FRAME_TEXT : FRAME_BINARY;
  out.set(payload, 1);
  return out;
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
      /* 服务端的下行:0x01 文本(welcome)/ 0x02 二进制(协议包)。
         若对端**不带**类型头(裸协议包),按二进制处理 —— 兼容两种服务端写法。 */
      let bytes: Uint8Array | null = null;
      if (raw instanceof ArrayBuffer) {
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
      if (bytes.byteLength > 0 && bytes[0] === FRAME_TEXT) {
        const json = new TextDecoder().decode(bytes.subarray(1));
        try {
          const w = JSON.parse(json) as WelcomeFrame;
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
          }
        } catch (e) {
          /* 握手 JSON 坏 ⇒ 明确失败(握手无法猜) */
          setState('failed', `welcome 解析失败:${(e as Error).message}`);
        }
        return;
      }
      /* 二进制:剥掉类型头(若服务端加了),再交给 store。
         ⚠️ store 内部处理「0 字节」与「坏包」两件事,本层不再判断。 */
      const payload = bytes.byteLength > 0 && bytes[0] === FRAME_BINARY
        ? bytes.subarray(1)
        : bytes;
      const r = store.apply(payload);
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
    close(): void {
      if (socket === null) return;
      try { socket.close(); } catch { /* 已关:幂等 */ }
      setState('closed');
    },
  };
}
