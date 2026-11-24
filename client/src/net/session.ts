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
  /* ★ WS-FND-188:NPC 帧的**判据 + 不抛的解码口**。与 `isTerrainFrame` 同一条纪律:
     判据住在协议层(共享),运输层只做分流与留痕。 */
  isNpcFrame,
  tryDecodeNpcFrame,
  type NpcWireDef,
} from '../../../shared/net/delta.ts';
/* ★ WS-FND-182:地形帧的判据(**不**走 `decodePacket` —— 它是另一条通道)。 */
import { isTerrainFrame } from '../../../shared/net/terrain.ts';
import { ClientStateStore, type ApplyResult } from './state_store.ts';
/* ★ WS-FND-182:块存储 —— 与 `state_store.ts` 同一纪律(纯数据,不 import three)。 */
import { ClientChunkStore } from './chunk_store.ts';

/* ═══ ★ WS-FND-167:连接 / 握手**具名超时** + 重连**指数退避**(纯常量 + 纯函数) ═══
 *
 * 修前实测(审计 B3)的两个缺口:
 * ```text
 * 1 黑洞端口:TCP 一直不回 ⇒ `open` / `error` / `close` **三个事件一个都不来**
 *   ⇒ 状态永久停在 `connecting`,界面永远写着"连接中",而没有任何一处会超时。
 * 2 死服务:`close` 每 1.5s 来一次,而重连间隔**固定 1.5s**、无上限也无退避
 *   ⇒ 空转永不停止,界面上也看不出"下一次什么时候拨"。
 * ```
 * ⇒ 两组数各自单一职责:`CONNECT_TIMEOUT_MS` 管"连上"、`HANDSHAKE_TIMEOUT_MS`
 *   管"welcome 到"(两者是**不同**的失败,文案必须分得开),退避三件套管"下一次拨"。
 * ⚠️ 超时**不是**新状态:落到既有的 `failed`(带具名 detail),这样 UI 与自检脚本
 *   不需要学第二套状态机。
 */

/** 连接(等 socket `open`)超时:超过它还没连上 ⇒ 判「连接超时」。 */
export const CONNECT_TIMEOUT_MS = 8000;
/** 握手(等 `welcome`)超时:连上了但服务端不回握手 ⇒ 判「握手超时」。 */
export const HANDSHAKE_TIMEOUT_MS = 8000;
/** 退避上限:再久也不超过它(固定间隔 ⇒ 空转;无上限 ⇒ 服务恢复后仍要干等)。 */
export const RECONNECT_MAX_MS = 30000;
/** 退避倍率(指数底)。 */
export const RECONNECT_FACTOR = 2;

/**
 * 第 `attempt` 次重连的间隔(毫秒)—— **纯函数**,导出以便直接断言单调性与上限。
 *
 * ```text
 * delay = min(上限, 基数 × 倍率^(attempt − 1))
 * ```
 *
 * ⚠️ 坏值一律**不猜**:
 * ```text
 * 基数 <= 0 / 非有限 / attempt < 1  ⇒ 0(等于"不重连",与接线前逐字相同)
 * 倍率 < 1                          ⇒ 回落到 RECONNECT_FACTOR(否则间隔**越等越短**)
 * 上限非法                          ⇒ 用 RECONNECT_MAX_MS
 * ```
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number = RECONNECT_MAX_MS,
  factor: number = RECONNECT_FACTOR,
): number {
  const a = Math.floor(attempt);
  if (!(baseMs > 0) || !Number.isFinite(baseMs) || !Number.isFinite(a) || a < 1) return 0;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : RECONNECT_MAX_MS;
  const f = Number.isFinite(factor) && factor >= 1 ? factor : RECONNECT_FACTOR;
  return Math.min(cap, Math.round(baseMs * Math.pow(f, a - 1)));
}

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

/**
 * 服务端**拒绝报文**(`ws_server.ts` 的 `onHello` / `onAction` 发出)。
 *
 * ## 为什么单独立一个类型(而不是塞进 `WelcomeFrame`)
 * `t` 是**判别式**:`welcome` / `actionResult` / `reject` 是三种报文,
 * 而修前客户端把它们**全当成 `WelcomeFrame`** 解析 ⇒ `t` 一不匹配就静默丢弃。
 *
 * ## 字段
 * ```text
 * code  机器可读档位(NO_IDENTITY / TOKEN_* / ROOM_FULL / JOIN_REJECTED / ...)
 * kind  分类(两处来源:ws_server 的 actionResult 用 kind;装配层的 join 拒用 kind:'JOIN')
 * reason 散文描述(给人读;`code` 缺席时的兜底说明)
 * note  ⚠️ code/kind 都可能缺席(老服务端只发 reason)⇒ 展示层必须容忍
 * ```
 */
export interface RejectFrame {
  t: 'reject';
  code?: string;
  kind?: string;
  reason?: string;
  action?: string;
}

/**
 * 把一条 `reject` 变成**一行可读原因**(UI / 自检脚本共用一处,不造第二份文案)。
 *
 * ⚠️ `code ?? kind ?? 'UNKNOWN'` 的兜底是刻意的:老服务端只发 `reason`,
 *   那时**不许**把行写成"服务端拒绝(UNKNOWN):"(那等于把原因丢了一半)。
 */
export function describeReject(r: RejectFrame): string {
  const tag = r.code ?? r.kind ?? 'UNKNOWN';
  return `服务端拒绝(${tag}):${r.reason ?? '没给理由'}`;
}

/** 下行**文本**报文的三种形态 —— `t` 是判别式(修前只认前两种)。 */
type DownlinkText = WelcomeFrame | ActionResultFrame | RejectFrame | InventoryFrame;

/** 背包下行(服务端 `t:'inventory'`):物品 id → 件数,加总件数容量。内容变了才会发。 */
export interface InventoryFrame {
  t: 'inventory';
  items: Record<string, number>;
  capacity: number;
}

export type SessionState = 'idle' | 'connecting' | 'live' | 'closed' | 'failed';

/**
 * ★ WS-FND-182:一帧地形落地后的事件载荷。
 *
 * 为什么带 `store` 而不是把块数组塞进来:块已经写进 `ClientChunkStore` 了,
 * 再拷一份出来会让「渲染读到的那份」与「store 里那份」有机会不一致
 * (本仓反复记的形态:两处都对、合起来不对)⇒ 只给**同一个** store 的引用,
 * 外加一个「这次变了哪些 key」。
 */
export interface TerrainFrameEvent {
  /**
   * 本帧真正落地的块 key(按 (cy,cx) 升序,同 key 只出现一次)。
   * ⇒ 渲染层据此**只重建这些块**,不必每帧全图重建。
   */
  changed: string[];
  /** 与 `SessionHandle.chunks` 是**同一个对象**(不是副本)。 */
  store: ClientChunkStore;
}

export interface SessionEvents {
  /** 状态流:每收到一帧**有效**字节调一次。 */
  onFrame: (r: ApplyResult, store: ClientStateStore) => void;
  /**
   * ★ WS-FND-182:**地形块到了**(块字节已经写进 `ClientChunkStore`)。
   *
   * ## 为什么必须有这个回调(而不是让调用方轮询 `chunks()`)
   * 修前客户端的地形是**本地算**出来的(`design_world.ts` 的 `buildDesignChunks`),
   * 于是「玩家盖的墙」在屏幕上永远不会出现 —— 而**没有任何东西会红**:
   * 连接是 live、快照照常到、画面也在动,只有地形是另一张图。
   * ⇒ 与 `onActionResult` / `onReject` 同一理由:把「服务端发了什么」变成
   *   调用方**可观测**的一件事。
   * ## 落地顺序
   * 块**先**写进 store,**再**调本回调 ⇒ 回调里 `store.chunks()` 已经能看到新块。
   */
  onTerrain?: (e: TerrainFrameEvent) => void;
  /**
   * ★ WS-FND-188:**NPC 表到了**(静态数据,`hello`/`welcome` 之后一次性下发)。
   *
   * ## 为什么必须有这个回调(而不是让调用方去猜)
   * 修前 `server/src/npc/defs.ts` 有 4 个 NPC、`dialogue.talk` 有纯函数、
   * `npcAt()` 有空间查询 —— 而客户端**一个字段都没收到** ⇒ 玩家看不到、
   * 也点不到任何一个 NPC,且没有任何东西会红(连"连接是 live、快照照常到"
   * 都成立,只是世界里没有人)。
   * ⇒ 与 `onTerrain` 同一理由:把"服务端发了什么"变成调用方**可观测**的一件事。
   * ## 与 `onTerrain` 的区别
   * 地形是**分批**、会重复下发的;NPC 表是**一次性**的静态表 ⇒ 每次收到都是**整表**
   * (不是增量,客户端不需要合并 —— 合并两份静态表只会多出一个漂移点)。
   */
  onNpcs?: (npcs: NpcWireDef[]) => void;
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
  /** 背包明细到了(进场一次,之后每次变化一次)。 */
  onInventory?: (inv: InventoryFrame) => void;
  /**
   * ★ WS-FND-134(P1):服务端**拒绝报文**到了(`{t:'reject', code?, reason?}`)。
   *
   * ## 这个回调为什么必须存在(修前的形态,实测)
   * 服务端在 `ws_server.onHello` 里先发 `{t:'reject', reason}` 再关连接,
   * 而客户端当时**只判 `welcome` 与 `actionResult`,其余直接 `return`**
   * ⇒ 玩家只看到 `closed`(随后自动重连),**永远不知道为什么被拒** ——
   * "缺凭证 / token 过期 / 房满 / 密码错"四种原因在现场完全同形。
   *
   * ⇒ 现在:状态(`onState` 的 detail)、字段(`lastReject`)、**这个回调**三处
   *   都拿到同一条可读原因(不是"再加一条日志"就算修了)。
   */
  onReject?: (r: RejectFrame) => void;
  /**
   * ★ WS-FND-113:每次 socket **建立**都调一次(首连与每次重连同一条路)。
   *
   * `epoch` 从 1 起 ⇒ `>= 2` 就是**重连**,调用方必须把本地预测链整体复位
   * (见 `main.ts` 的 `resetLocalChain`)。少了它,重连后 `seq` / `acked` /
   * `pending` 全是上一轮的账,而表现只是"偶尔不走 / 偶尔回弹"。
   */
  onOpen?: (epoch: number) => void;
  /**
   * ★ WS-FND-167:排了一次**自动重连**时调用(带退避后的间隔)。
   *
   * 修前只有"断了"这一个事实,没有"下一次什么时候拨" ⇒ 界面只能永远转圈。
   * `attempt` 从 1 起(成功 `open` 后归零),与 `SessionHandle.retryCount` 同一个数。
   */
  onRetryScheduled?: (info: { attempt: number; delayMs: number }) => void;
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
  /**
   * ★ WS-FND-182:**地形块存储**(与 `store` 同一纪律:必须由调用方持有)。
   *
   * 为什么也必须由调用方传:`boot.ts` 的渲染循环读的是**它自己那个**块存储
   * (拿 `chunks()` 建面、拿 `dirty()` 只重建变了的块)。若本模块内部自建一个,
   * 结果与 `store` 那个坑**逐字相同**:「字节写进了 A,渲染读的是 B」——
   * 两块各自都"正常工作",只有屏幕上是旧地形。
   * 省略时退化为自建(只有单测 / 冒烟才该这样用)。
   */
  readonly chunks: ClientChunkStore;
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
  /**
   * ★ WS-FND-182:已落地的**地形帧**数(单调)。
   *
   * 为什么是一个独立的读数:地形帧与快照帧**互不使用对方的计数**
   * (`framesSent` / `droppedFrames` 都属于快照通道)⇒ 「服务端说它发了地形」
   * 与「客户端真的收到了地形」在这里是两个可分别断言的量。
   * `0` 在首连后几帧内是正常的(块是**分批**下发的,见 `TERRAIN_CHUNKS_PER_FRAME`),
   * 但**一直**是 0 就说明这条通道断了 —— 而屏幕上只会是"地形不动"。
   */
  readonly terrainFrames: number;
  /**
   * ★ WS-FND-182:最近一次**地形帧解码失败**的原因(`null` = 没失败过)。
   *
   * 与 `lastDropReason` 分开:`lastDropReason` 的语义是「载荷**形态**不对」
   * (Blob / 非字节),把它混进来会让「binaryType 没设对」这一类判据失去分辨力
   * (见 `droppedFrames` 的注释)。地形解码失败是**协议内容**问题。
   */
  readonly lastTerrainError: string | null;
  /**
   * ★ WS-FND-188:已落地的 **NPC 帧**数(单调)。
   *
   * 与 `terrainFrames` 分开计:两条通道是**两件事**(地形分批、NPC 一次性)。
   * `0` 一直不变 ⇒ `hello`/`welcome` 之后那一帧没到(而屏幕上只会是"世界里没有人")。
   */
  readonly npcFrames: number;
  /**
   * ★ WS-FND-188:最近一次 **NPC 帧解码失败**的原因(`null` = 没失败过)。
   *
   * 与 `lastTerrainError` 同一条取舍(见它的 docblock):坏帧**出声**,但不算
   * `droppedFrames` —— 那个计数器的语义是「载荷**形态**不对」(Blob / 非字节),
   * 把"协议内容坏了"混进去会让 `binaryType` 那一类判据失去分辨力。
   */
  readonly lastNpcError: string | null;
  /**
   * ★ WS-FND-134(P1):最近一次**服务端拒绝报文**(`null` = 本次连接没被拒过)。
   *
   * ## 为什么必须有它(而不是只靠 `onReject` 回调)
   * 回调是**推送**:没注册回调的调用方(或注册晚了的)就什么都看不到。
   * 而拒因是"这次连接为什么失败"的**唯一**答案 ⇒ 它必须同时是**可拉的**
   * (自检脚本 / UI 面板 / 事后对账都能读)。
   *
   * ⚠️ 语义是**按连接**:`open` 时清空(见 `dial` 的 open 回调)——
   *   否则一次成功后,下一次断开会把上一轮的拒因重新报一遍。
   */
  readonly lastReject: RejectFrame | null;
  /** ★ WS-FND-134(P1):收到过几条 `reject` 报文(单调累加,与 `lastReject` 分开)。 */
  readonly rejectedFrames: number;
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
  /**
   * ★ WS-FND-113:已建立的连接数(`1` = 只有首连;`>= 2` = 重连过)。
   * 与 `onOpen` 的实参是**同一个数**(一处来源,不造第二份计数)。
   */
  /**
   * ★ WS-FND-167:已排过几次**自动重连**(成功 `open` 后归零)。
   * 与 `onRetryScheduled` 的 `attempt` **同一个数**(一处来源,不造第二份计数)。
   */
  readonly retryCount: number;
  /** ★ WS-FND-167:下一次重连的**退避间隔**(毫秒;没有在排 = `null`)。 */
  readonly retryDelayMs: number | null;
  /** ★ WS-FND-167:下一次重连的**绝对时刻**(`Date.now()` 口径;没有在排 = `null`)。 */
  readonly nextRetryAtMs: number | null;
  /**
   * ★ WS-FND-167:最近一次**超时**的具名原因(`null` = 本次连接没超时过)。
   *
   * 与 `state === 'failed'` 的 `detail` 是**同一句话**(一处文案、两处可读):
   * 状态会被随后的 `close` / 重连覆盖,**这个字段只在 `open` 时清空**。
   * `kind` 分开 `connect`(没连上)与 `handshake`(连上了但 welcome 没来)——
   * 两者的修法完全不同(查端口 vs 查服务端握手),混成一句就会指错方向。
   */
  readonly lastTimeout: { kind: 'connect' | 'handshake'; ms: number; text: string } | null;
  readonly epoch: number;
  /**
   * ★ WS-FND-113:主动重连 —— 关掉当前 socket,换一条重新握手。
   *
   * 与自动重连共用同一段 `dial()` ⇒ 不产生第二份连接逻辑。旧 socket 的
   * `close` 回调**不会**再触发一次重连(见 `dial` 里 `socket !== sock` 那道门),
   * 否则每重连一次就会多排一个定时器。
   */
  reconnect(): void;
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
  /**
   * ★ WS-FND-113:这一条命令里**是否按了跳跃**(由 `InputSource` 锁存,恰好一条为真)。
   *
   * ## 为什么在这里加字段(而不是把 InputSource 的锁存删掉)
   * 修前那条锁存**没有任何出口**:`MoveIntent` 没这个字段、`parseMoveIntent` 也只认
   * x/y/z ⇒ 按空格只会 "挥一刀 + 攒一个永远发不出去的跳跃"。两个方向都说得通,
   * 而删锁存会让一条已存在的行为(`tests/WS-FND-16` 的 FND16-2)无声消失。
   * ⇒ 取"给出口":字段进报文,**末端的服务端仍未消费它**(`parseMoveIntent` 会丢弃
   *   未知字段,不报错)—— 这一半如实标注为**残留**,要真落地必须改服务端。
   */
  jump?: boolean;
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
  /**
   * ★ WS-FND-134(P2):`INTERNAL` = **服务端执行抛错**(不是参数/状态不对)。
   *
   * 修前服务端把"执行抛错"与真·参数错一律回报成 `INVALID` ⇒ 客户端(与排障
   * 的人)把"服务端崩了"读成"我发错了",而两者的修法完全不同。
   */
  kind: 'OK' | 'INVALID' | 'PERMISSION' | 'NOT_IMPLEMENTED' | 'ROOM_CLOSED' | 'INTERNAL';
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
  /**
   * ★ WS-FND-182:**复用的块存储**。
   *
   * 与 `store` 同一纪律(理由逐字相同:渲染循环读的是**它自己那个**)⇒
   * 生产路径必须由调用方传入;省略时退化为自建,只有单测 / 冒烟才该这样用。
   */
  chunks?: ClientChunkStore;
  /** 供测试替换(默认 `globalThis.WebSocket`)。 */
  makeSocket?: (url: string) => WebSocketLike;
  /**
   * ★ WS-FND-113:被动断开后的**自动重连间隔**(毫秒)。省略 / `<= 0` ⇒ 不重连
   * —— 与接线前**逐字相同**,单测与 `?server=off` 因此完全不受影响。
   *
   * ⚠️ 只对**非主动**断开生效:`close()` 是调用方的决定(卸载 / 收尾),
   * 不让它再把自己拉起来,否则关页面会变成"重连到别人都走了还在拨"。
   */
  autoReconnectMs?: number;
  /**
   * ★ WS-FND-167:连接(socket `open`)超时(毫秒)。省略 ⇒ `CONNECT_TIMEOUT_MS`;
   * `<= 0` ⇒ **不设**(只给单测/冒烟用 —— 生产**不许**省略:黑洞端口会永远停在
   * "连接中",而 `open` / `error` / `close` 一个事件都不会来)。
   */
  connectTimeoutMs?: number;
  /** ★ WS-FND-167:握手(`welcome`)超时(毫秒)。省略 ⇒ `HANDSHAKE_TIMEOUT_MS`;`<= 0` ⇒ 不设。 */
  handshakeTimeoutMs?: number;
  /** ★ WS-FND-167:退避**上限**(毫秒)。省略 ⇒ `RECONNECT_MAX_MS`(无上限 = 服务回来还要干等)。 */
  reconnectMaxMs?: number;
  /** ★ WS-FND-167:退避**倍率**。省略 ⇒ `RECONNECT_FACTOR`;`< 1` 视为 2(间隔越等越短会加剧空转)。 */
  reconnectFactor?: number;
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
  /* ★ WS-FND-182:块存储(与 `store` 同一纪律 —— 由调用方持有;见 `SessionOptions.chunks`)。 */
  const chunkStore = opts.chunks ?? new ClientChunkStore();
  let state: SessionState = 'idle';
  let serverClaim: string | null = null;
  let socket: WebSocketLike | null = null;
  let droppedFrames = 0;
  /* ★ WS-FND-134(P1):服务端拒绝报文的留证(见 `SessionHandle.lastReject`)。 */
  let lastReject: RejectFrame | null = null;
  let rejectedFrames = 0;
  let lastDropReason: string | null = null;
  /* ★ WS-FND-113 第 4 处:重连三件套。三个字段各有单一职责,别合并 —— */
  /** 已建立的连接数;`onOpen` 的实参就是它(一处来源,不造第二份计数)。 */
  let epoch = 0;
  /** 待重连定时器;`null` = 当前没有在排。 */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 调用方**主动** `close()` ⇒ 不再自动重连(见 `autoReconnectMs`)。 */
  let closedByCaller = false;
  /* ★ WS-FND-167:超时与退避的状态 —— 四个字段各管一件事,别合并。 */
  /** 连接(等 `open`)定时器;`null` = 当前没在等。 */
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 握手(等 `welcome`)定时器;`null` = 当前没在等。 */
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已排过几次自动重连(`open` 时归零)。 */
  let retryCount = 0;
  /** 下一次重连的退避间隔与绝对时刻(`null` = 没在排)。 */
  let retryDelayMs: number | null = null;
  let nextRetryAtMs: number | null = null;
  /** 最近一次超时的具名原因(见 `SessionHandle.lastTimeout`)。 */
  let lastTimeout: { kind: 'connect' | 'handshake'; ms: number; text: string } | null = null;
  /* ★ WS-FND-182:地形通道的两个读数(见 `SessionHandle.terrainFrames` / `lastTerrainError`)。 */
  /** 已落地的地形帧数(单调)。 */
  let terrainFrames = 0;
  /** 最近一次地形帧解码失败的原因(`null` = 没失败过)。 */
  let lastTerrainError: string | null = null;
  /* ★ WS-FND-188:NPC 通道的两个读数(见 `SessionHandle.npcFrames` / `lastNpcError`)。 */
  /** 已落地的 NPC 帧数(单调;`hello`/`welcome` 之后那一帧到了才 +1)。 */
  let npcFrames = 0;
  /** 最近一次 NPC 帧解码失败的原因(`null` = 没失败过)。 */
  let lastNpcError: string | null = null;

  const setState = (s: SessionState, detail?: string): void => {
    state = s;
    opts.events.onState?.(s, detail);
  };

  const make = opts.makeSocket
    ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);

  /**
   * ★ WS-FND-182:落一帧地形。
   *
   * ## 三处都留痕(与 `onDrop` / `onReject` 同纪律)
   * ```text
   * 1 块字节写进 chunkStore          ← 唯一的事实(渲染读它)
   * 2 terrainFrames += 1             ← "收到过几帧"(单调,不会被一次调用伪造)
   * 3 events.onTerrain({changed})    ← 推送:调用方据此**只重建变了的块**
   * ```
   * ## 解不开时**出声**,但不算 `droppedFrames`
   * `droppedFrames` 的语义是「载荷**形态**不对」(Blob / 非字节),把「地形帧
   * 内容坏了」混进去会让 `binaryType` 那一类判据失去分辨力(见它的长注释)。
   * ⇒ 走专用计数 `lastTerrainError` + 同一条 `onDrop` 出口。
   */
  const applyTerrainFrame = (payload: Uint8Array): void => {
    let changed: string[];
    try {
      changed = chunkStore.applyWire(payload).changed;
    } catch (e) {
      lastTerrainError = (e as Error).message;
      opts.events.onDrop?.(`地形帧解码失败:${lastTerrainError}`);
      return;
    }
    terrainFrames += 1;
    opts.events.onTerrain?.({ changed, store: chunkStore });
  };

  /**
   * ★ WS-FND-188:落一帧 **NPC 表**(静态数据的一次性下发)。
   *
   * ## 两条出口都留痕(与 `applyTerrainFrame` 同纪律)
   * ```text
   * 1 好的帧 ⇒ npcFrames += 1 + events.onNpcs(npcs)(渲染层据此摆立牌 / 判"附近有没有人")
   * 2 坏的帧 ⇒ lastNpcError 写原因 + onDrop(**不抛**,见下)
   * ```
   * ⚠️ **不抛**:一条坏帧(版本漂移 / 截断)抛进 socket 的 `message` 回调里,
   * 后果取决于调用方有没有 try/catch;而"取决于"就是本仓最忌的形态 ——
   * 漏掉的那一处会让整条连接因为一条可忽略的坏帧而静默停摆。
   * 坏帧走 `lastNpcError` + `onDrop`(同 `lastTerrainError` 的取舍:
   * **出声**,但**不**算 `droppedFrames` 那个"载荷形态不对"的计数器)。
   */
  const applyNpcFrame = (payload: Uint8Array): void => {
    const d = tryDecodeNpcFrame(payload);
    if (d.error !== null) {
      lastNpcError = d.error;
      opts.events.onDrop?.(`NPC 帧解码失败:${d.error}`);
      return;
    }
    npcFrames += 1;
    opts.events.onNpcs?.(d.npcs);
  };

  /** 取消待重连(重连已经建立 / 调用方收尾时都要调,否则定时器会再拨一次)。 */
  const clearRetry = (): void => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  /**
   * ★ WS-FND-167:被**超时**判死的那条 socket(按连接记,`null` = 没有)。
   *
   * 为什么需要它:超时之后我们会自己 `sock.close()`,而那次 `close` / `error`
   * 回调会**紧接着**把状态覆盖成一句 "closed" / "socket error" ⇒ 具名原因在
   * 现场消失(与 WS-FND-134 的"拒因被 close 盖掉"是同一个病)。
   * ⚠️ 按 **socket** 而不是按一个布尔值:换连接之后布尔值会把新连接的正常错误吞掉。
   */
  let timedOutSocket: WebSocketLike | null = null;

  /** 取消超时定时器(再次 `dial` / 握手完成 / 掉线 / 调用方收尾时都要调)。 */
  const clearTimeouts = (): void => {
    if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
    if (handshakeTimer !== null) { clearTimeout(handshakeTimer); handshakeTimer = null; }
  };

  /** Node 里别让"待重连 / 待超时"把进程吊住(与 `ws_server.ts` 的 broadcaster 同一做法)。 */
  const unrefTimer = (t: ReturnType<typeof setTimeout>): void => {
    if (typeof t.unref === 'function') t.unref();
  };

  /**
   * 排一次自动重连。**只排一次**(`retryTimer !== null` 直接返回):
   * 断开事件会连着来(`error` 之后紧接 `close`)⇒ 排两次会同时拨两条连接,
   * 后一条顶掉前一条,表现是"刚连上又断",而日志里看不出成对关系。
   *
   * ★ WS-FND-167:间隔 = `backoffDelayMs(retryCount + 1, 基数, 上限, 倍率)`。
   * 修前用的是**写死的基数**(生产给 1500)⇒ 死服务每 1.5s 空转、无上限、界面
   * 也看不出"下一次什么时候拨"。`retryCount` 只在**成功 `open`** 时归零:
   * 连续失败一路退避到上限,而真的连上过一次之后立刻回到基数(服务恢复时不再干等)。
   */
  const scheduleRetry = (): void => {
    if (closedByCaller) return;
    const base = opts.autoReconnectMs ?? 0;
    if (!(base > 0) || retryTimer !== null) return;
    const attempt = retryCount + 1;
    const delayMs = backoffDelayMs(
      attempt, base,
      opts.reconnectMaxMs ?? RECONNECT_MAX_MS,
      opts.reconnectFactor ?? RECONNECT_FACTOR,
    );
    const t = setTimeout(() => {
      retryTimer = null;
      retryDelayMs = null;
      nextRetryAtMs = null;
      dial();
    }, delayMs);
    /* Node 里别让"待重连"把进程吊住(与 `ws_server.ts` 的 broadcaster 同一做法)。 */
    unrefTimer(t);
    retryTimer = t;
    /* 三个读数与那次 `setTimeout` **同一个数**(一处来源:界面/自检都读它们)。 */
    retryCount = attempt;
    retryDelayMs = delayMs;
    nextRetryAtMs = Date.now() + delayMs;
    opts.events.onRetryScheduled?.({ attempt, delayMs });
  };

  /**
   * 建立一条连接并挂上四个回调。**首连与每次重连走同一段**
   * (没有第二条连接逻辑,也就不可能出现"重连与首连行为不一致")。
   */
  function dial(): void {
  try {
    /* ★ WS-FND-167:换一条连接 ⇒ 上一条的"等 open / 等 welcome"定时器必须作废,
       否则它们会在**新**连接上开火,把一条正在握手的连接判成超时。 */
    clearTimeouts();
    setState('connecting');
    const sock = make(opts.url);
    socket = sock;
    /* 二进制帧给 ArrayBuffer —— 实测内置客户端在 `arraybuffer` 下
       `ev.data instanceof ArrayBuffer` 为真,可直接喂 `decodePacket`。 */
    socket.binaryType = 'arraybuffer';

    /* ── ★ WS-FND-167 缺口 1:黑洞端口连**事件**都不来,只有定时器救得回来 ──
       实测:`open` / `error` / `close` 三者一个都不来 ⇒ 不设超时这里就是死路,
       而界面上永远写着"连接中"(`setState('connecting')` 之后就再没下文)。
       `connectMs <= 0` = 显式关掉(只给单测);生产由 `main.ts` 显式传值。 */
    const connectMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const handshakeMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    if (connectMs > 0) {
      connectTimer = setTimeout(() => {
        connectTimer = null;
        /* 两道门:老 socket 的超时不算本次;已经 live/failed 的更不算。 */
        if (socket !== sock || state !== 'connecting') return;
        const text = `连接超时:${connectMs}ms 内未建立 WebSocket(${opts.url})`
          + ' —— 端口不通 / 服务未启动 / 被防火墙丢包(不是"正在连",是"连不上")';
        lastTimeout = { kind: 'connect', ms: connectMs, text };
        /* ★ WS-FND-167:记下"是这条 socket 被超时判死的" ⇒ 随后那次 close/error
           不许用一句 "closed" / "socket error" 把具名原因盖掉(见那两个回调)。 */
        timedOutSocket = sock;
        setState('failed', text);
        try { sock.close(); } catch { /* 已经坏掉:幂等 */ }
        scheduleRetry();
      }, connectMs);
      unrefTimer(connectTimer);
    }

      sock.addEventListener('open', (() => {
        /* ★ WS-FND-113:连接**真的**建立起来了 —— 先报 `epoch`,再发握手。
           顺序不能反:调用方(重连)据 `epoch` 复位本地预测链,而复位必须在
           **第一条上行之前**完成,否则新一代命令会带着上一代的 `seq` 发出去。 */
        epoch += 1;
        /* ★ WS-FND-134(P1):新连接开始 ⇒ 清掉**上一条连接**的拒因
           (否则本次断开会把上一轮的 reject 当成这次的原因报出来)。 */
        lastReject = null;
        /* ★ WS-FND-167:新连接起来了 ⇒ 上一条被超时判死的记录作废。 */
        timedOutSocket = null;
        /* ★ WS-FND-167:连上了 ⇒ "等 open"的超时**作废**,退避计数归零(下次断从基数重来),
           然后开始"等 welcome"的计时 —— 这是**另一种**失败(修法不同),不共用定时器。 */
        clearTimeouts();
        retryCount = 0;
        retryDelayMs = null;
        nextRetryAtMs = null;
        lastTimeout = null;
        if (handshakeMs > 0) {
          handshakeTimer = setTimeout(() => {
            handshakeTimer = null;
            if (socket !== sock || state !== 'connecting') return;
            const text = `握手超时:${handshakeMs}ms 内未收到 welcome(${opts.url})`
              + ' —— TCP 通了但服务端没回握手(没起 ws 路由 / 协议或内容指纹对不上)';
            lastTimeout = { kind: 'handshake', ms: handshakeMs, text };
            timedOutSocket = sock;
            setState('failed', text);
            try { sock.close(); } catch { /* 已经坏掉:幂等 */ }
            scheduleRetry();
          }, handshakeMs);
          unrefTimer(handshakeTimer);
        }
        opts.events.onOpen?.(epoch);
        /* 连接建立后**先**发握手。上行也走 1 字节类型头,服务端据此分流。 */
        const hello: HelloFrame = {
          t: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          contentClaim: null,          /* ★ 阶段 3 留空:见文件头 */
        };
        try {
          sock.send(encodeClientFrame(new TextEncoder().encode(JSON.stringify(hello)), true));
        } catch (e) {
          setState('failed', (e as Error).message);
        }
      }) as never);

      sock.addEventListener('message', ((ev: { data: unknown }) => {
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
          /* ★ WS-FND-134(P1):下行文本是**一族**报文(`t` 是判别式),不是一个
             `WelcomeFrame`。修前这里 `as WelcomeFrame` 之后只判 welcome 与
             actionResult,其余**静默 return** —— 服务端发的 `{t:'reject',reason}`
             就是那条被吞掉的路(玩家只看到 "closed → 重连",不知道为什么被拒)。 */
          const w = JSON.parse(new TextDecoder().decode(cls.payload)) as DownlinkText;
          if (w.t === 'welcome') {
            if (w.protocolVersion !== PROTOCOL_VERSION) {
              setState('failed',
                `协议版本不匹配:服务端 ${w.protocolVersion} / 本地 ${PROTOCOL_VERSION}`);
              return;
            }
            serverClaim = w.contentClaim;
            store.setLocalPlayerId(w.playerId);
            opts.events.onWelcome?.(w);
            /* ★ WS-FND-167:握手真的完成了 ⇒ "等 welcome"的超时作废。 */
            clearTimeouts();
            setState('live');
          } else if (w.t === 'actionResult') {
            /* ★ 2026-11-14:动作回执。**五种结果都送达**(OK / INVALID /
               PERMISSION / NOT_IMPLEMENTED / ROOM_CLOSED,以及 WS-FND-134 新增的
               INTERNAL = 服务端执行抛错)—— 客户端据此区分"被拒"与
               "服务器没听见"(见 `ws_server` 的 `onAction`)。
               ⚠️ 这里**只**加动作回执,不加 `attackResult`:攻击的反馈走
                  快照里那只怪的血量下降(见 `main.ts` 的 HUD 注释)—— 一条真值来源。 */
            opts.events.onActionResult?.(w);
          } else if (w.t === 'inventory') {
            opts.events.onInventory?.(w);
          } else if (w.t === 'reject') {
            /* ★ WS-FND-134(P1):**服务端拒绝报文**。三处同时暴露(状态 / 字段 /
               回调)—— 任一处单独存在时,"为什么被拒"都可能在现场丢失
               (状态会被 close 覆盖、回调可能没人注册、字段要有人去读)。 */
            lastReject = w;
            rejectedFrames += 1;
            opts.events.onReject?.(w);
            /* ★★ 2026-11-22(w82):**只有连接级拒绝才落到 `failed`**。
               服务端对「世界侧拒收本次移动」也发 `{t:'reject', kind:'MOVE',
               code:'WORLD_REJECTED'}`,而且**不关连接**(见 `ws_server.ts` 的
               `onMove`:那是**每一条报文**的结果 —— 撞墙 / 被击退 / 格子冷却,
               全是**常态**)。修前这里无条件 `setState('failed', …)` ⇒
               玩家**撞一下墙**,HUD 就变成「连接 failed / 未连接 / 不重试」,
               而 socket 其实还活着 ⇒ 游戏直接玩不下去(实测复现:摇杆顶着墙走十几秒)。
               ⇒ 判据:`kind === 'MOVE'` 只**留痕**(`lastReject` / `rejectedFrames` /
               `onReject`),**不改状态**;`kind` 缺省仍按连接级处理
               (握手 / 入场被拒,服务端随后会 close —— WS-FND-134 的契约不变)。 */
            if (w.kind !== 'MOVE') setState('failed', describeReject(w));
          } else {
            /* ★ WS-FND-134(P1):未知文本报文**也要留痕** —— 修前它落在那个
               "其余直接 return"的静默口上:服务端将来加一种报文时,客户端会
               安静地什么都不做(本仓反复记的形态)。
               ⚠️ 归 `onDrop`(帧被丢弃)但**不**动 `droppedFrames`:那个计数器的
               语义是「**载荷形态**不对」(Blob / 非字节),把它混进来会让
               "binaryType 没设对"这一类判据失去分辨力(实测那正是它的用法)。 */
            opts.events.onDrop?.(`收到未知文本报文 t=${String((w as { t?: unknown }).t)}`);
          }
        } catch (e) {
          /* 握手 JSON 坏 ⇒ 明确失败(握手无法猜) */
          setState('failed', `welcome 解析失败:${(e as Error).message}`);
        }
        return;
      }
      /* ── ★ WS-FND-182:地形帧**先分流** ──
         它也是二进制帧(WS opcode 0x2),但不是差量包:
         ```text
         差量包:首字节 = PROTOCOL_VERSION(3)→ decodePacket
         地形帧:首字节 = TERRAIN_FRAME_TAG(0x54)→ decodeTerrainFrame
         ```
         ⚠️ 判据必须在这里 —— 交给 `store.apply` 的话,一条**形态完好**的地形帧
         会以「协议版本不匹配:84」的形态报出来,而那个原因指向的是**编码器**,
         不是它真的错在哪(本仓反复记的「症状名 ≠ 成因名」)。 */
      if (isTerrainFrame(cls.payload)) {
        applyTerrainFrame(cls.payload);
        return;
      }
      /* ── ★ WS-FND-188:NPC 帧**也先分流** ──
         与地形帧同一条理由、同一位置:它也是二进制帧(opcode 0x2),但不是差量包:
         ```text
         差量包:首字节 = PROTOCOL_VERSION(3)          → decodePacket
         地形帧:首字节 = TERRAIN_FRAME_TAG(0x54)       → decodeTerrainFrame
         NPC 帧:首字节 = NPC_FRAME_TAG(0x4e)           → decodeNpcFrame
         ```
         ⚠️ 判据必须在 `store.apply` **之前**:交给它的话,一条**形态完好**的 NPC 帧
         会以「协议版本不匹配:78」的形态报出来,而那个原因指向的是**编码器**,
         不是它真的错在哪(与地形那一处的「症状名 ≠ 成因名」逐字同款)。
         ⚠️ 与地形不同的是:这一条**不抛**(见 `applyNpcFrame`)——
            静态表坏一帧不该把整条连接带走。 */
      if (isNpcFrame(cls.payload)) {
        applyNpcFrame(cls.payload);
        return;
      }
      /* 二进制:store 内部处理「0 字节」与「坏包」两件事,本层不再判断。 */
      const r = store.apply(cls.payload);
      opts.events.onFrame(r, store);
    }) as never);

      sock.addEventListener('close', (() => {
        /* ⚠️ 已被 `reconnect()` 换掉的老 socket 也**会**回调 close ——
           不拦它,一次重连就会被记成"又断了一次"(状态改成 closed,
           还多排一个重连定时器,两条连接轮流顶掉对方)。 */
        if (socket !== sock) return;
        /* ★ WS-FND-134(P1):被拒之后的那次 close **必须带上拒因** ——
           修前这里写死 `setState('closed')`,于是上一行的
           `setState('failed','服务端拒绝(...)')` 立刻被覆盖成一句 "closed"
           ⇒ 玩家/自检脚本只能看到"断了、重连",**拒因在状态流里消失**。
           ⚠️ 只在**本次连接**收过 reject 时带(`open` 时清空),否则会把上一轮
           无关的拒因挂到这一次的断开上(那会指错对象)。 */
        /* ★ WS-FND-167:被**超时**判死的那次 close 也必须带上具名原因 ——
           否则"连接超时:…"立刻被覆盖成一句 "closed"(与上面拒因同一种病)。 */
        if (timedOutSocket === sock && lastTimeout !== null) {
          setState('closed', lastTimeout.text);
          scheduleRetry();

          return;
        }
        setState('closed', lastReject === null ? undefined : describeReject(lastReject));
        scheduleRetry();
      }) as never);
      sock.addEventListener('error', (() => {
        /* 连接层错误:不抛(未连接的会话是正常状态,不是异常)。
           与 close 同一道门:老 socket 的错误不再算本次会话的失败。 */
        if (socket !== sock) return;
        clearTimeouts();
        /* ★ WS-FND-167:超时已经判死 ⇒ 不许用一句 "socket error" 盖掉具名原因。 */
        if (timedOutSocket === sock) { scheduleRetry(); return; }
        setState('failed', 'socket error');
        scheduleRetry();
      }) as never);
    } catch (e) {
      setState('failed', (e as Error).message);
    }
  }

  /* 首连。此后每一次重连都走同一段 `dial()`(见 `reconnect` / `scheduleRetry`)。 */
  dial();

  return {
    get store() { return store; },
    /* ★ WS-FND-182:地形通道的三个读数(与 `store` / `droppedFrames` 并列,不混用)。 */
    get chunks() { return chunkStore; },
    get terrainFrames() { return terrainFrames; },
    get lastTerrainError() { return lastTerrainError; },
    /* ★ WS-FND-188:NPC 通道的两个读数(**分开**计 —— 地形分批、NPC 一次性)。 */
    get npcFrames() { return npcFrames; },
    get lastNpcError() { return lastNpcError; },
    get state() { return state; },
    get serverContentClaim() { return serverClaim; },
    /* ★ WS-FND-167:超时与退避的四个读数 —— 界面 / 自检脚本都读它们,不靠看日志。 */
    get retryCount() { return retryCount; },
    get retryDelayMs() { return retryDelayMs; },
    get nextRetryAtMs() { return nextRetryAtMs; },
    get lastTimeout() { return lastTimeout; },
    get droppedFrames() { return droppedFrames; },
    get lastDropReason() { return lastDropReason; },
    /* ★ WS-FND-134(P1):被拒的**证据**。两个读数分开:
       `lastReject` 是"最近一次拒了我什么"(诊断),`rejectedFrames` 是"拒了几次"
       (单调累加 ⇒ "发生过的次数"不会被一次调用伪造)。 */
    get lastReject() { return lastReject; },
    get rejectedFrames() { return rejectedFrames; },
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
    get epoch() { return epoch; },
    /**
     * ★ WS-FND-113:主动重连(见 `SessionHandle.reconnect`)。
     * `dial()` 是**同步**的:调用返回时新 socket 已经在建;而 `epoch` 只在它的
     * `open` 事件里才 +1 —— 那才是"真的连上了"的时刻。
     */
    reconnect(): void {
      clearRetry();
      /* ★ WS-FND-167:主动换连接 ⇒ 老连接的超时定时器一并作废(否则它会在新连接上开火)。 */
      clearTimeouts();
      const old = socket;
      /* ⚠️ 先摘引用再关:老 socket 的 `close` 回调据此判"这不是掉线"
         (见 `dial` 里那道 `socket !== sock` 的门)。 */
      socket = null;
      if (old !== null) { try { old.close(); } catch { /* 已关:幂等 */ } }
      dial();
    },
    close(): void {
      /* 主动关闭 ⇒ 不再自动重连(见 `autoReconnectMs` 的说明)。 */
      closedByCaller = true;
      clearRetry();
      clearTimeouts();
      const cur = socket;
      socket = null;
      if (cur !== null) { try { cur.close(); } catch { /* 已关:幂等 */ } }
      setState('closed');
    },
  };
}
