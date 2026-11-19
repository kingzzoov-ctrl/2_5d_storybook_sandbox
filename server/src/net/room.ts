/**
 * WS-07 · 房间生命周期、权限矩阵与重连快照(零依赖核心)。
 *
 * 用一个**可注入时钟**驱动,所有时间相关断言都是确定性的 ——
 * 测试用 `fixedClock()` 推 60 秒,不真 sleep。
 *
 * 关键状态机
 * ```
 *  (create) ──► OPEN ──(lastPlayerLeft + IDLE_SLEEP_MS 到达)──► SLEEPING
 *                 ▲                                                │
 *                 └──────────(join 触发 wake)──────────────────────┘
 *  任意状态 ──(owner close / 空房超过 EVICT_MS)──► CLOSED
 * ```
 * 断线:成员离开时**不删**成员表,只把 `disconnectedAt` 记上;在
 * `RECONNECT_GRACE_MS`(30 秒)内用同一 token 回来 → 直接恢复快照;
 * 超期 → 记一次 `leave` 并清快照。
 */

import {
  encodeDelta,
  encodeFull,
  decodePacket,
  PROTOCOL_VERSION,
} from '../../../shared/net/delta.ts';
import { EntityKind, TelegraphShape, type BossState } from '../../../shared/types/wire.ts';
/* ★ WS-FND-123:Boss 投影的两个容器写口。修前 `upsertBoss` 是全仓**唯一**定义且
   **零调用**(`room.ts` 没有 `projectBosses`,`bossSnapshots()` 只有测试调)⇒
   `state.bosses` 恒空,客户端血条与地面预警只能走 demo 兜底。 */
import { removeBoss, removeWildlife, upsertBoss, upsertWildlife } from './schema.ts';
import {
  AntiCheatRoom,
  type Clock,
  type InventoryOp,
  type MoveIntent,
  type Verdict,
  type Violation,
} from './anticheat.ts';
import {
  AccessMode,
  PartyMode,
  RoomRole,
  RoomStatus,
  createRoom,
  createUser,
  getRoom,
  getUser,
  listRooms,
  saveReconnectSnapshot,
  loadReconnectSnapshot,
  setPartyMode,
  setRoomStatus,
  upsertRoomPlayer,
  totalItemsOf,
  type DbLike,
} from '../db/repo.ts';
import {
  createPlayerState,
  createRoomState,
  cloneRoomState,
  type PlayerState,
  type RoomState,
} from './schema.ts';
import { MAX_LEVEL } from '../../../shared/types/entities.ts';
import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
/* ★ 第六轮:`meta.partyTimer/scoreA/scoreB` 的**数据源**在本房间的派对赛局记录里
   (`START_PARTY` 写的那份,单例模块)。只读两个导出,不碰它的写口。 */
import { PartyPhase, endParty, partyStateOf } from './actions/start_party.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { lookupActionHandler } from './actions/action_table.ts';
import { tameOwnerOf } from './actions/breed_tame.ts';
import { notImplemented } from './actions/not-implemented.ts';
/* ★ WS-FND-131:世界换代时**顺带**给玩家睡眠登记换代(唯一的换代点在
   `dispatchAction` 的 RESET_WORLD 成功那一刻,见那里的注释)。
   ⚠️ 不引入运行时环:`actions/sleep.ts` 只 `import type` 本文件的类型(擦除)。 */
import { bumpSleepGeneration } from './actions/sleep.ts';
import type { ActionContext } from './actions/types.ts';
/* 物质层的模块级常量(`PICKUP_RADIUS` / `ITEM_ID_SET`)与 `numField` 随那 4 个动作
   一起搬去了 `net/actions/material.ts` —— 它们只为那 4 个 case 存在,留在这里就是死代码。 */

/** 空集合常引用 —— `grantedSourcesFor` 无凭证时返回它,避免每次分配。 */
const EMPTY_SOURCE_SET: ReadonlySet<string> = new Set<string>();

/* ═══════════════════════════ 1. 参数表 ═══════════════════════════ */

/** 无人活动 60 秒 → 自动休眠(手册 §7.1 生命周期)。 */
export const IDLE_SLEEP_MS = 60_000;
/** 断线 30 秒内可原样重连。 */
export const RECONNECT_GRACE_MS = 30_000;
/** 休眠房再无人问津 24 小时 → 关闭(释放内存)。 */
export const EVICT_MS = 24 * 60 * 60 * 1000;
/** 单个玩家两次心跳之间超过此值判定为掉线。 */
export const HEARTBEAT_TIMEOUT_MS = 5_000;
/** 每帧最多处理的动作条数(防止单帧被灌爆)。 */
export const MAX_ACTIONS_PER_TICK = 64;

/**
 * `meta.partyTimer` 的上界:24 小时。
 *
 * 为什么要有:`partyTimer` 在线上是 **POS 类型**(i32 × 1024),而它载的是**秒数**。
 * 超长的值(时钟回拨 / 模式表被人改成天文数字)会让这个字段写出一个编码器
 * 只能按 i32 截断的数 —— 客户端读回一个**负数剩余时间**,而那不报错。
 * 取 24h:四种模式最长 180s,留出的余量已是三个数量级,不会卡住真实值。
 */
export const MAX_PARTY_TIMER_SEC = 24 * 60 * 60;

/**
 * 打盹超时:30 分钟。
 *
 * 这是「玩家去吃了顿饭」与「玩家真的走了」的分界。取值理由:
 *   * **不取 5 分钟** —— 泡杯茶回来发现被踢是体验灾难;
 *   * **不需要更短** —— `AFK_EXP_RATIO = 0.3`(手册 §4.1)本身已经是防挂机机制,
 *     挂机收益只有 30%,不必再用短超时叠加第二重惩罚。
 *
 * **超时后不 disconnect**:房间上限只有 4~16 人,若打盹 30 分钟就释放名额,
 * 16 人房里有人去吃饭、回来时名额可能已被新人占满,他就回不来了。
 * **占着席位比踢掉更友好**,且房间本身有「60 秒无人在线休眠」兜底,
 * 资源不会被真正浪费。
 *
 * 超时只影响两件事:退出经验分配、退出 Boss 个人掉落归属。
 * WS-10 侧算经验分配时请引用本常量,不要另立一份。
 */
export const AFK_TIMEOUT_MS = 30 * 60 * 1000;

/* ═══════════════════════════ 2. 动作与权限矩阵 ═══════════════════════════ */

export const RoomAction = {
  MOVE: 'MOVE',
  ATTACK: 'ATTACK',
  PLACE_BLOCK: 'PLACE_BLOCK',
  BREAK_BLOCK: 'BREAK_BLOCK',
  PICKUP_ITEM: 'PICKUP_ITEM',
  DROP_ITEM: 'DROP_ITEM',
  CRAFT: 'CRAFT',
  USE_ALCHEMY_FURNACE: 'USE_ALCHEMY_FURNACE',
  OPEN_CHEST: 'OPEN_CHEST',
  USE_OWN_CHEST: 'USE_OWN_CHEST',
  SLEEP: 'SLEEP',
  START_PARTY: 'START_PARTY',
  SET_ROOM_ACCESS: 'SET_ROOM_ACCESS',
  SET_PARTY_MODE: 'SET_PARTY_MODE',
  KICK_MEMBER: 'KICK_MEMBER',
  SET_MEMBER_ROLE: 'SET_MEMBER_ROLE',
  RESET_WORLD: 'RESET_WORLD',
  CLOSE_ROOM: 'CLOSE_ROOM',
  MODIFY_TOWN: 'MODIFY_TOWN',
  PLACE_AUTOMATION: 'PLACE_AUTOMATION',
  WIRE_EDIT: 'WIRE_EDIT',
  BREED_TAME: 'BREED_TAME',
  USE_ITEM: 'USE_ITEM',
  /* ★ WS-FND-77 A-4:百货店购买(`515 无人自助售货摊` 的字面量
     「上架……供游客购买」)。此前 `CLOUD_DEPOT` 的购买语义**没有入口**:
     `depot.buy` 只有测试在调。加这一条把「买」变成一个可授权、可回执、
     可判定的动作(判序见 `actions/buy_item.ts`)。 */
  BUY_ITEM: 'BUY_ITEM',
} as const;
export type RoomAction = (typeof RoomAction)[keyof typeof RoomAction];

export interface RolePermissions {
  /** 基础生存动作(移动/攻击/拾取)。 */
  baseline: boolean;
  /** 允许建造 / 拆除。 */
  build: boolean;
  /** 允许布线 / 放自动化件。 */
  wiring: boolean;
  /** 允许改公共储物箱。 */
  publicStorage: boolean;
  /** 允许动城镇安全区与图腾。 */
  town: boolean;
  /** 允许开派对 / 设模式。 */
  party: boolean;
  /** 允许管理成员。 */
  manage: boolean;
  /** 允许改房间属性(密码/容量)。 */
  configure: boolean;
  /** 允许重置世界 / 关房。 */
  destructive: boolean;
}

/**
 * 权限矩阵。语义要点(与手册 §7.1 权限矩阵逐格对应):
 *  GUEST 是「游客/访客」——能玩能捡,不能建造、不能布线、不能开箱、不能办派对。
 *  这正是测试里「越权被拒」的判定依据。
 */
export const PERMISSION_MATRIX: Readonly<Record<RoomRole, RolePermissions>> = {
  OWNER: {
    baseline: true, build: true, wiring: true, publicStorage: true,
    town: true, party: true, manage: true, configure: true, destructive: true,
  },
  ADMIN: {
    baseline: true, build: true, wiring: true, publicStorage: true,
    town: true, party: true, manage: true, configure: false, destructive: false,
  },
  MEMBER: {
    baseline: true, build: true, wiring: true, publicStorage: false,
    town: false, party: false, manage: false, configure: false, destructive: false,
  },
  GUEST: {
    baseline: true, build: false, wiring: false, publicStorage: false,
    town: false, party: false, manage: false, configure: false, destructive: false,
  },
};

/** 动作 -> 所需权限位。baseline 类动作永远允许(只要在房里)。 */
export const ACTION_PERMISSION: Readonly<Record<RoomAction, keyof RolePermissions>> = {
  MOVE: 'baseline',
  ATTACK: 'baseline',
  PICKUP_ITEM: 'baseline',
  DROP_ITEM: 'baseline',
  SLEEP: 'baseline',
  USE_OWN_CHEST: 'baseline',
  BREED_TAME: 'baseline',
  /* 使用道具是基础生存动作:吃/喝/投掷都不要求角色权限。
     具体的**能用哪一件**由世界侧判定(未知道具 ⇒ 明确拒绝),不靠权限位表达。 */
  USE_ITEM: 'baseline',
  /* 购买(515 无人自助售货摊)是**基础生存动作**:游客也能在别人的店里买 ——
     能不能成交由世界侧判(`depot.buy` 的定价/库存),不由权限位表达。 */
  BUY_ITEM: 'baseline',
  PLACE_BLOCK: 'build',
  BREAK_BLOCK: 'build',
  CRAFT: 'build',
  PLACE_AUTOMATION: 'wiring',
  WIRE_EDIT: 'wiring',
  OPEN_CHEST: 'publicStorage',
  USE_ALCHEMY_FURNACE: 'publicStorage',
  MODIFY_TOWN: 'town',
  START_PARTY: 'party',
  SET_PARTY_MODE: 'party',
  KICK_MEMBER: 'manage',
  SET_MEMBER_ROLE: 'manage',
  SET_ROOM_ACCESS: 'configure',
  RESET_WORLD: 'destructive',
  CLOSE_ROOM: 'destructive',
};

export function can(role: RoomRole, action: RoomAction): boolean {
  const perms = PERMISSION_MATRIX[role];
  if (!perms) return false;
  return perms[ACTION_PERMISSION[action]] === true;
}

/* ═══════════════════════════ 3. 会话与成员 ═══════════════════════════ */

/**
 * 成员在场态。
 *
 * `AFK` 与 `AFK_EXPIRED` 的区别就是 `AFK_TIMEOUT_MS`(30 分钟)这条线:
 * 前者还吃 30% 经验,后者完全退出经验与掉落归属 —— 但**两者都仍占席位**。
 *
 * 语法:用 `as const` 对象替代 `enum`(FREEZE.md §0 硬禁令)。
 */
export const MemberPresence = {
  /** 清醒在线。 */
  ACTIVE: 'ACTIVE',
  /** 打盹未超时(< 30 分钟):吃 30% 经验(手册 §4.1 `AFK_EXP_RATIO`)。 */
  AFK: 'AFK',
  /** 打盹已超时(≥ 30 分钟):退出经验分配与个人掉落归属,但仍占席位。 */
  AFK_EXPIRED: 'AFK_EXPIRED',
  /** 断线(App 已关),与打盹正交。 */
  OFFLINE: 'OFFLINE',
} as const;
export type MemberPresence = (typeof MemberPresence)[keyof typeof MemberPresence];

/** 在场态的显示名(日志与审计用)。 */
export const MEMBER_PRESENCE_LABEL: Readonly<Record<MemberPresence, string>> = {
  ACTIVE: '清醒',
  AFK: '打盹',
  AFK_EXPIRED: '打盹超时',
  OFFLINE: '离线',
};

/* ═══════════ 1.5 加入凭证:签发 → 校验闭环(审计 P0-1)═══════════ */

/**
 * 加入凭证的载荷 —— 它是**服务端签发的声明**,不是客户端可以自己填的字段。
 *
 * ## 为什么是这三件事,少一件就有一条绕过路径
 * ```
 * userId       缺 ⇒ 拿到别人的 token 就能冒充别人(旧实现:`?userId=u_owner` 即成房主)
 * roomId       缺 ⇒ A 房签发的凭证可以拿去进 B 房(跨房重放)
 * expiresAtMs  缺 ⇒ 凭证永不过期 ⇒ 泄漏一次 = 永久身份
 * ```
 * ## 为什么不是"一个随机串存进 Map 里查"
 * 无状态签名(HMAC-SHA256)让**校验收敛在一个纯函数**里:不用维护表、
 * 不会因为「忘了写过期清理」而变成永久凭证,也就能被断言直接打(见 WS-FND-86)。
 * 代价:签发后无法单独吊销 —— 由**短 TTL**兜住(`JOIN_TOKEN_TTL_MS` 5 分钟)。
 */
export interface RoomTokenClaims {
  userId: string;
  roomId: string;
  /** 过期时刻(epoch ms)。`nowMs >= expiresAtMs` 即过期(**含**边界)。 */
  expiresAtMs: number;
}

/** 凭证校验结论。判别联合:失败时带**具体原因**(每一种对应一条绕过路径)。 */
export type RoomTokenVerdict =
  | { ok: true; claims: RoomTokenClaims }
  | { ok: false; reason: string };

/**
 * 默认有效期 5 分钟 —— 覆盖 `RECONNECT_GRACE_MS`(30s)且远小于"永久"。
 *
 * ## ★ P1-3(2026-11-19):TTL 的**起算点**有两档,必须分开说
 * ```
 * 签发(join / 重连)     ⇒ 起算点 = 签发时刻(本常量即这一档)
 * 断线中的成员重连时      ⇒ 起算点 = **断线时刻**,且不越过宽限期终点
 * ```
 * 第二档不是"另一张凭证",而是**同一个验签入口**里对「过期」这一项的放宽 ——
 * 口径与实现见 `verifyRoomToken` 的 `expect.expiredOkUntilMs` 与
 * `RoomRuntime.reconnectTokenGraceUntilMs`。为什么服务端不干脆在断线时
 * 换发一张新的:装配层(room.colyseus / ws_server)没有可用的下发通道,
 * 客户端手里那张一出生就被写死了过期时刻 ⇒ 放宽判据是唯一可行的修法。
 */
export const JOIN_TOKEN_TTL_MS = 5 * 60_000;
/** TTL 上限 24 小时(防止调用方传一个"永不过期"的数)。 */
export const JOIN_TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const HEX_DIGITS = '0123456789abcdef';

/** 字节 → 小写十六进制(**不用 Buffer**:本文件保持"只用 node 内建 + 手写编码")。 */
function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const b = bytes[i]!;
    out += HEX_DIGITS[(b >> 4) & 0x0f]! + HEX_DIGITS[b & 0x0f]!;
  }
  return out;
}

/** 十六进制 → 字节;非偶数长度或含非十六进制字符 ⇒ `null`(**不猜**)。 */
function bytesOfHex(text: string): Uint8Array | null {
  if (text.length % 2 !== 0) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.byteLength; i += 1) {
    const hi = HEX_DIGITS.indexOf(text[i * 2]!);
    const lo = HEX_DIGITS.indexOf(text[i * 2 + 1]!);
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** HMAC-SHA256(密钥 = 房间私钥,消息 = `v<协议版本>.<载荷十六进制>`)。 */
function tokenMac(secret: string, signedPayload: string): Uint8Array {
  return createHmac('sha256', secret).update(signedPayload, 'utf8').digest();
}

/**
 * 签发一张加入凭证。**只有服务端**调得动(密钥不出进程)。
 * 形如 `v3.<载荷十六进制>.<签名十六进制>`;三点分段是为了让"格式错"与
 * "签名错"给出**不同**原因(负对照才能分别指认)。
 */
export function signRoomToken(secret: string, claims: RoomTokenClaims): string {
  const payload = hexOf(new TextEncoder().encode(JSON.stringify({
    u: claims.userId, r: claims.roomId, e: claims.expiresAtMs,
  })));
  const prefix = `v${PROTOCOL_VERSION}`;
  return `${prefix}.${payload}.${hexOf(tokenMac(secret, `${prefix}.${payload}`))}`;
}

/**
 * 校验一张加入凭证 —— **全仓唯一的 token 校验实现**(运输层与重连共用同一份)。
 *
 * ## 判据顺序是刻意的
 * ```
 * 1 缺 token        ⇒ 拒(未认证:这就是"带 ?userId=u_owner 即成房主"的那条路)
 * 2 格式/版本不对    ⇒ 拒(而不是当"无 token"放过去 —— 静默降级 = 又一条绕过)
 * 3 签名不符        ⇒ 拒(**先**验签,再读载荷:否则等于信任未认领的 JSON)
 * 4 userId 绑定不符  ⇒ 拒(拿着 u_evil 的凭证声称自己是 u_owner)
 * 5 房间不符        ⇒ 拒(跨房重放)
 * 6 过期            ⇒ 拒(`nowMs >= expiresAtMs`,含边界)——
 *                     除非调用方用 `expiredOkUntilMs` 为**该 userId 自己的重连宽限**开门
 * ```
 * ★ P1-3(2026-11-19):第 6 条是**唯一**可被放宽的一条,放宽方式是把**起算点**
 *   从签发时刻换成断线时刻(不是删掉过期判据)—— 口径与边界见
 *   `expect.expiredOkUntilMs` 的注释。
 * ⚠️ 它排在最后**也是判据的一部分**:宽限回调收到的是**已验签且已绑定**的
 *   `claims.userId` ⇒ 「签名不对也问一次宽限」的写法不存在(签名在第 3 条就返回)。
 * `expect.userId === ''` 表示**只认声明、不核对绑定** —— 只有"凭证即身份"的
 * 入口(Colyseus 的 `sessionId` 由服务端生成,没有可比的声明)才这么用,
 * 见 `RoomRuntime.decodeJoinToken`。
 */
export function verifyRoomToken(
  secret: string,
  token: unknown,
  expect: {
    userId: string;
    roomId: string;
    nowMs: number;
    /**
     * ★ 重连宽限(P1-3,2026-11-19):**允许已过期凭证**的截止时刻。
     *
     * ## 缺陷形态(修前,可算得出,不必实测)
     * ```
     * 凭证的 expiresAtMs 在**签发那一刻**就被写死 = 签发时刻 + 5min。
     * 而客户端手里**只有这一张**:在房里坐满 5 分钟 ⇒ 它已经过期;
     * 此刻掉线,30s 宽限期内重连 ⇒ 第 1 步 verifyJoinToken 判「已过期」
     * ⇒ 席位还在、凭证却不能用 ⇒ 明明在宽限期里,却**必然**被拒
     *  (随后 reapExpiredDisconnects 把席位删掉,进度全丢)。
     * ```
     * ⇒ 为什么不去「断线时换发一张新凭证」:服务端在断线时刻**没有任何
     *   可用的下发通道**(客户端已经走了)。装配层(room.colyseus /
     *   ws_server)只能验它递上来的那一张 ⇒ 能改的只有**判据的起算点**。
     *
     * ## 本项的口径(一句话,与实现逐字对应)
     * ```
     * 断线中的成员,其手中那张凭证的有效期**从断线时刻起算**,
     * 且**不得越过重连宽限期的终点**。
     * 生效值 = min(断线时刻 + JOIN_TOKEN_TTL_MS, 断线时刻 + RECONNECT_GRACE_MS)
     *        = 断线时刻 + RECONNECT_GRACE_MS(30s < 5min,故后者总是更紧)
     * ```
     * ⇒ **全仓唯一**算它的地方是 `RoomRuntime.reconnectTokenGraceUntilMs`
     *   (两处调用点:`verifyJoinToken` / `decodeJoinToken`),不许第二份。
     *
     * ## 放宽的边界(逐条)
     * ```
     * 1 只有「过期」这一项被放宽:签名 / 房间 / userId 绑定 / 载荷格式
     *   一条都没动(它们排在本判据之前,先返回);
     * 2 只有**该 userId 自己**处于断线宽限期时才可能得到非 undefined:
     *   在线成员、宽限期已过、从未入房、查无此人 ⇒ `undefined`
     *   ⇒ 原判据原样生效(负对照就在这几个态上);
     * 3 回调拿到的是**已验签**的 `claims.userId`,而不是调用方声明的那个
     *   (核对绑定时两者相等;`userId === ''` 的入口则完全以凭证为准);
     * 4 「宽限期已过就不再放宽」由 `reapExpiredDisconnects` 保证:席位只多活
     *   RECONNECT_GRACE_MS,过了就不再是"断线中的成员" ⇒ 回调恒 `undefined`。
     * ```
     */
    expiredOkUntilMs?: (claimedUserId: string) => number | undefined;
  },
): RoomTokenVerdict {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: '缺少 token(身份未认证)' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== `v${PROTOCOL_VERSION}`) {
    return { ok: false, reason: 'token 格式非法(不是本服务端签发的形式)' };
  }
  const signed = `${parts[0]!}.${parts[1]!}`;
  const given = bytesOfHex(parts[2]!);
  const expected = tokenMac(secret, signed);
  /* `timingSafeEqual` 要求等长,**长度先判** —— 否则它会抛(那会被上游当成"没拒")。 */
  if (given === null || given.byteLength !== expected.byteLength
    || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'token 签名不符(伪造或密钥不匹配)' };
  }
  const raw = bytesOfHex(parts[1]!);
  if (raw === null) return { ok: false, reason: 'token 载荷非法' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: 'token 载荷非法' };
  }
  if (typeof decoded !== 'object' || decoded === null) {
    return { ok: false, reason: 'token 载荷非法' };
  }
  const rec = decoded as { u?: unknown; r?: unknown; e?: unknown };
  const userId = rec.u;
  const roomId = rec.r;
  const expiresAtMs = rec.e;
  if (typeof userId !== 'string' || typeof roomId !== 'string'
    || typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'token 载荷非法(缺 userId/roomId/过期时刻)' };
  }
  if (expect.roomId !== '' && roomId !== expect.roomId) {
    return { ok: false, reason: `token 与房间不符(签给 ${roomId},本房是 ${expect.roomId})` };
  }
  if (expect.userId !== '' && userId !== expect.userId) {
    return { ok: false, reason: `token 与声明的 userId 不符(token 属于 ${userId},却声称 ${expect.userId})` };
  }
  if (expect.nowMs >= expiresAtMs) {
    /* ★ P1-3:过期**默认**拒;只有调用方为**这个 userId 的重连宽限**开门时才放过
       (口径、生效值与放宽边界见 `expect.expiredOkUntilMs` 的长注释)。 */
    const until = expect.expiredOkUntilMs?.(userId);
    if (until === undefined || expect.nowMs >= until) {
      return { ok: false, reason: `token 已过期(过期时刻 ${expiresAtMs} ≤ 当前 ${expect.nowMs})` };
    }
  }
  return { ok: true, claims: { userId, roomId, expiresAtMs } };
}

export interface MemberSession {
  userId: string;
  role: RoomRole;
  /** 当前连接 token;断线后置 null。 */
  token: string | null;
  connected: boolean;
  /** 掉线时刻(ms);在线时为 null。 */
  disconnectedAtMs: number | null;
  /**
   * 打盹起始时刻(ms);未打盹为 null。
   * **打盹 ≠ 离线**:切后台打盹的玩家仍然占着席位、仍有实体、仍要吃经验
   * (手册 §4.1 `AFK_EXP_RATIO = 0.3`),因此**不触发房间休眠**。
   */
  afkSinceMs: number | null;
  joinedAtMs: number;
  lastSeenMs: number;
  /**
   * 本次 join 从存档恢复出的**权威坐标**;未恢复(首次进入/无存档)时为 `null`。
   *
   * ## 为什么要记它(task-70)
   *
   * 契约 §9 验收 1 要求「读档恢复有真调用点」,而**光有调用点不够** ——
   * 「调用了但恢复无效」与「没有存档」在外部表现上**完全一样**(陷阱 89)。
   * 记下恢复结果,断言才能区分这两件事:
   * ```
   * 有存档且恢复成功 ⇒ restoredFrom ≠ null
   * 有存档但恢复失败 ⇒ restoredFrom === null 而 restoreError ≠ null  ← ★ 缺陷
   * 没有存档         ⇒ restoredFrom === null 且 restoreError === null
   * ```
   */
  restoredFrom?: { x: number; y: number } | null;
}

export interface JoinResult {
  ok: boolean;
  reason?: string;
  role?: RoomRole;
  token?: string;
  /** 重连时给出的快照(与断线前逐字节一致)。 */
  snapshot?: Uint8Array;
  /** 是否走了重连路径。 */
  resumed?: boolean;
}

export interface RoomRuntimeOptions {
  roomId: string;
  ownerId: string;
  clock: Clock;
  name?: string;
  accessMode?: AccessMode;
  passwordHash?: string | null;
  maxPlayers?: number;
  /**
   * **强制加入凭证**(默认 false = 只对"进程内直接 `join`"放宽)。
   *
   * ## 为什么要这个开关,而不是让 `join` 无条件强制
   * ```
   * 网络边界(ws_server / Colyseus)⇒ 一律传 true:客户端串不可信
   * 进程内直接 new RoomRuntime().join(...) ⇒ 是**可信代码**路径
   *   (全仓 200+ 处既有调用点,均不携带 token;把它们一律判死
   *    只会让"没被网络碰到"的单元测试全红,而**不会**让攻击面变小)
   * ```
   * ⇒ 强制与否是**调用方(边界)**的表态,不是房间的默认值;
   *   `ws_server.ts` 的 `onHello` 里写死 `requireToken: true`(见那边注释)。
   * ⚠️ 注意:即便本开关为 false,**只要调用方给了 token 就必须验过**
   *   (见 `join` 里那条 `input.token !== undefined` 分支)——
   *   不给 token 是"没声明身份",给一个坏 token 是"伪造",两者不能同待遇。
   */
  requireJoinToken?: boolean;
  worldSeed?: number;
  /**
   * 世界存档源(可选;**US2 起从构造参数注入**,理由见下)。
   *
   * ## 为什么改成构造参,而不是继续用「建完再赋值」
   *
   * 原先只有字段 `worldSaveHost = null` 可写,于是装配层必须
   * 「先 `new RoomRuntime(...)`,再 `rt.worldSaveHost = host`」。
   * 实测后果:**生产里这个赋值一处都没有**(全仓 6 处赋值,5 处在临时探针、
   * 1 处在 `tests/WS-FND-02.test.ts`),`room.colyseus.ts` 全文
   * 无 `worldSaveHost` ⇒ 该契约在运行期**恒为 null**
   * (含既有的 `saveToDb`,那是**存量**缺口,不是本任务引入的)。
   *
   * 构造参数让「有没有世界」在**建房间的那一刻**就必须表态,
   * 而不是靠事后一个可选赋值 —— 后者漏掉时**没有任何东西报错**。
   * 字段仍然保留可写(测试/渐进接入用),但生产装配走构造参。
   *
   * ⚠️ 仍需要有人**构造** host(`server/src/index.ts` 目前不存在)⇒
   * 本参数只保证「有了就能传进来」,不保证「一定有人构造」。
   */
  host?: WorldSaveHost | null;
}

/* ═══════════════════════════ 4. RoomRuntime ═══════════════════════════ */

/**
 * 一次攻击结算的实际结果(供成功回执 + 断言)。
 *
 * 字段全部是**基本类型**:它要能跨 `net` → 传输层边界被序列化,
 * 也刻意不引用模拟层的 `PipelineDamageResult`(理由同 `WorldSaveHost`)。
 */
export interface AttackReport {
  tick: number;
  playerId: string;
  mobId: string;
  /** `OUT_OF_AOI` = 目标不在活跃区,未结算;`OK` = 走到结算了。 */
  outcome: 'OK' | 'OUT_OF_AOI';
  /** 真实掉血(已钳制;尸体恒 0 —— task-33 契约)。 */
  hpLoss: number;
  /** 公式给出的伤害(可能被格挡/闪避归零,故与 `hpLoss` 不同)。 */
  finalDamage: number;
  /** 目标存在且结算了(`false` 通常意味着 `mobId` 不存在)。 */
  hit: boolean;
  outOfReach: boolean;
  dodged: boolean;
  /**
   * ★ WS-FND-122:本次是否**按了 [Q]**(报文里的意图位)。
   *
   * 为什么回执要带它:没有这一位,「普攻」与「按了 Q 但没有技能 ⇒ 被拒」
   * 在客户端看起来都是一段伤害 —— 那正是本仓反复记的静默形态。
   */
  useSkill: boolean;
  /**
   * ★ WS-FND-122:世界侧给出的**显式拒绝理由**;`null` = 未被拒绝。
   *
   * 为什么是 `string` 而不是联合类型:`net` 刻意**不 import** 模拟层类型
   * (见 `WorldSaveHost` 的 docblock),在这里照抄一份词表就是第二份口径。
   */
  rejected: string | null;
}

/**
 * ★ WS-FND-122:一次**起跳意图**的结果(供断言与排查)。
 *
 * 与 `AttackReport` 同一取舍:字段全是基本类型(要跨 `net` → 传输层边界被
 * 序列化),且**拒绝也要有记录** —— `jumped:false` + `reason` 让
 * 「按了空格但没跳」与「空格根本没到」在断言里可区分。
 * `reason` 由世界侧给(`NOT_A_PLAYER` / `NO_BODY` / `AIRBORNE` / `COOLDOWN`),
 * 房间另外补一个 `NO_WORLD`(宿主没实现 `jumpPlayer`)。
 */
export interface JumpReport {
  playerId: string;
  jumped: boolean;
  reason: string;
  /** 实际写进权威 `vz` 的值;没跳 ⇒ `null`。 */
  vz: number | null;
}

/**
 * 房间可挂载的「世界存档源」。
 *
 * ## 为什么是结构化接口,而不是 import 模拟层
 *
 * `RoomRuntime` 至今**不认识**模拟层(US2「room 持有 sim」仍未开)。
 * 为了落盘而在 `net/room.ts` 里 import 它,会凭空造出一条
 * `net → sim → db` 的编译期依赖,并把它变成 `room.ts` 的硬约束 ——
 * 那是本任务不需要的耦合。
 *
 * 这里只声明**用到的那几个方法**:谁提供它都行(模拟层满足它),
 * 房间不关心实现。于是接线成本是一行,且不引入新的可达性边。
 *
 * ⚠️ 注意:本文件**有意不出现**模拟层的类型名 —— 一旦这里 import 了它,
 * US2 才真的变成过时条目(`scripts/backlog.ts` 的 US2 探针正盯着本文件)。
 * 现在两者依然互不依赖,只是**结构上可组合**。
 *
 * ## US2 起新增的攻击面(同样只用结构化类型)
 *
 * `attackMobAuthorized` 的返回被**就地展开成基本类型**,不引用
 * `PipelineDamageResult` 等模拟层类型 —— 否则 `net` 就依赖 `combat` 了。
 * 房间只关心四个整数/字符串:结果形态、掉了多少血、是否命中、目标死活。
 */
/* ══════════════ 回执 `effect` 的值域(★ 2026-11-18 第五轮 P1:统一形状)══════════════
 *
 * ## 修前是什么样
 *
 * 契约只允许**标量**,而两个写者塞了嵌套值:
 * ```
 * actions/craft.ts:229              consumed: match.consumed   ← Record<number, number>
 * actions/use_alchemy_furnace.ts:543 consumed / certificate / gallery(对象 + 数组)
 * ⇒ 两处都用 `as unknown as EffectRecord` **绕过**类型
 * ```
 * 绕过之后两端各自的编译器都是绿的:契约说「只放标量」、实现放对象,
 * 线上靠 JSON 恰好能序列化 ⇒ **没有一处会红**。下一个人照「标量」写消费者时
 * 才会炸(`undefined` 字段、`[object Object]` 进 UI)—— 本仓反复点名的
 * 「静默绕类型」形态。
 *
 * ## 裁定:放宽**契约**,而不是继续绕过
 *
 * 回执的唯一出路是报文(`room.colyseus.ts` 的 `client.send('actionResult')`),
 * 而报文就是 JSON ⇒ 允许的值域本来就是 **JSON 值**,不是「标量」:
 * ```
 * EffectValue = string | number | boolean | null | readonly EffectValue[] | EffectRecord
 * ```
 * 顶层仍是 `Record`(键必须是标识符),只有嵌套层递归 —— 深度由数据决定,
 * 于是 `as unknown as` 两处全部消失(见 craft.ts / use_alchemy_furnace.ts)。
 *
 * ## ⚠️ 为什么**不**摊平(`consumed_103: 1` 那种)
 *
 * 键名由内容表 id 决定 ⇒ **键集随配方变**,摊平会得到一个键数随数据膨胀的回执;
 * 而死角在于:逐件账是 `tests/WS-FND-25/31/55/79` 明写要看到的东西
 * (「★ effect 里能看到**扣了哪几件**」),摊平等于把那条证据从回执里删掉。
 * ⇒ 放宽是唯一不动语义、也不动既有断言的写法。
 *
 * ## ⚠️ 值域里**没有** `undefined`
 *
 * `exactOptionalPropertyTypes=false` ⇒ `undefined` 会静默进报文,和「没有这个键」
 * 变成同一件事。要表达「没有」用 `null`(`galleryNote` 就是这一档)。
 * 唯一允许缺省的地方是 `effect` 自己那个 `?:`。
 */
export type EffectScalar = string | number | boolean;
export type EffectValue = EffectScalar | null | readonly EffectValue[] | EffectRecord;
export interface EffectRecord {
  readonly [key: string]: EffectValue;
}

/**
 * `USE_ITEM` 的世界侧回执。
 *
 * ## 为什么 `consume` 与 `applied` 分开
 *
 * 「生效了」和「该扣道具」不是同一件事:
 *   - 733 羽毛笔**超距**时:什么都没发生(不复活),而且**不许扣道具**;
 *   - 733 命中时:复活了,扣 1 件。
 * 一个布尔表达不了这两个维度 ⇒ 分成两个。动作层据此决定要不要 `applyInventory(-1)`
 * (它只信这里回来的 `consume`,不自己再判一次距离 —— 那会是第二份实现)。
 */
export interface UseItemOutcome {
  /** 这次使用是否**真的生效**(世界状态变了)。 */
  applied: boolean;
  /** 是否应扣掉 1 件。⚠️ 只有 `applied === true` 时才允许为 `true`。 */
  consume: boolean;
  /** 给人看的理由(`applied === true` 时为 `'ok'`)。 */
  reason: string;
  /**
   * 回执明细。值域 = `EffectRecord`(**JSON 值**,不是「只标量」)——
   * 与 `ActionOutcome['effect']` 同口径,嵌套项不再靠 `as` 绕过。见 `EffectValue` 的 docblock。
   */
  effect?: EffectRecord;
}

export interface WorldSaveHost {
  saveToDb(
    db: DbLike,
    roomId: string,
    nowMs: number,
  ): { hpSaved: number; hpSkipped: number; memRow: number };
  /**
   * 玩家对某只生物发起一次**权威**攻击(等级/装备由模拟层自己派生)。
   *
   * 与 `saveToDb` 同一取舍:这是**结构化**声明,不 import 模拟层类型。
   *
   * @returns `null` = 没有这只生物;**`outcome`** 区分「结算了」与
   *          「目标不在活跃区(AOI 外)」—— 后者不是错误,是闸门。
   */
  attackMobAuthorized(
    playerId: string,
    mobId: string,
    /**
     * ★ WS-FND-122:**意图位**,不是面板数据。
     * `useSkill:true` = 「我按了 Q」⇒ 技能由模拟层从**当前武器**取
     * (`skillOf`),这里不传任何技能定义/数值(与 `weaponId` 的自报纪律同源)。
     * 可选:`{useSkill:true}` 与「不传」必须可区分 —— 前者会**显式拒**
     * 没有技能的情况(`NO_SKILL`),后者是普攻。
     */
    opts?: { useSkill?: boolean },
  ): {
    outcome: 'OK' | 'OUT_OF_AOI';
    /**
     * `null` = 生物不存在。
     *
     * ⚠ 形状必须与 `WorldSim.attackMobAuthorized` **逐字段对齐** ——
     * 伤害在 `result.finalDamage`(嵌套),不在顶层。
     * 我第一版把 `finalDamage` 写在顶层,于是真实对象里它是
     * `undefined`,经 `?? 0` 静默变成 0:回执永久上报「0 伤害」而
     * **没有任何东西报错**(`worldSaveHost` 是结构化接口 + 装配处用了
     * `as never`,两侧类型不对齐也不会红)。这类「字段路径写错」在本仓
     * 属高发(见陷阱 2:签名/字段猜错),故这里写明嵌套关系。
     */
    hit: {
      /** **已钳制**的真实掉血(task-33 契约;尸体恒 0)。 */
      hpLoss: number;
      result: {
        finalDamage: number;
        outOfReach: boolean;
        dodged: boolean;
      };
    } | null;
    /**
     * ★ WS-FND-122:世界侧的**显式拒绝理由**(`null` = 未被拒绝)。
     *
     * 为什么加它:`outcome` 只有两个值,装不下「为什么没结算」——
     * 而「按了 Q 但这把武器没有技能」必须与「打到了」可区分
     * (修前那种情况会静默退回普攻)。词表由世界层拥有,这里只搬运。
     */
    rejected?: string | null;
  };
  /* ══════════ ★ WS-FND-122:四条「世界侧有能力、网络侧没有出口」的声明 ══════════
   *
   * 与 `setPlayerAfk` / `resetWorld` 同一取舍:**可选**(`?`)。手写 host 假件
   * (`tests/**` / `scripts/**`)不实现它们本来就合法 —— 那种宿主走动作层的
   * 「能力缺失」分支(显式 `NOT_IMPLEMENTED`),**不许**静默成功。
   *
   * ⚠️ 为什么必须在这里声明:`createHost()` 的返回类型标注是 `WorldSaveHost`,
   * `WorldSim` **有**而本接口**没声明**的成员会被**结构化裁掉** ⇒ 房间侧
   * `typeof host.xxx` 在**编译期**恒假(task-70 的实测形态)。
   */
  /**
   * ★ 起跳(`jump` 报文位的落点)。
   *
   * 为什么判据在世界侧而不是房间:地面/冷却要读**权威刚体**(`physics.bodies`),
   * 房间手里没有它。签名只回 `{jumped, reason}` —— 房间不重判。
   */
  tryPlayerJump?(playerId: string): { jumped: boolean; reason: string; vz: number | null };
  /** ★ 218 和平盾的**真实开关**(读口)。见 `WorldSim.shieldOnOf`。 */
  shieldOnOf?(playerId: string): boolean;
  /** ★ 218 和平盾的**写口**(唯一生产调用点:`actions/use_item.ts` 的 218 分支)。 */
  setShieldOn?(playerId: string, on: boolean): boolean;
  /**
   * ★ 整蛊玩具(221..255)的**效果落点**。判定(`gatePrank`)在动作层,
   * 这里只落到权威状态(眩晕计时 + 击退冲量);队友侧零伤害由玩具表保证。
   */
  applyPrankToTarget?(
    actorId: string,
    targetId: string,
    p: { toyId: number; stunSec: number; impulse: number; moveTiles: number; flag: string },
  ): { applied: boolean; reason: string; stunSec: number; moveTiles: number; flag: string };
  /**
   * ★ 436 哨台 `params.mode` 的**唯一写口**(`START_PARTY` 的落点)。
   *
   * `applied:false` + `reason` ⇒ 这一栏写不了(世界里没有哨台 / 模式越界)。
   * ⚠️ 调用方必须把它写进回执 —— 静默当成成功会让「四模式九闸」看起来接好了。
   */
  setRefereeDeskMode?(mode: number): {
    applied: boolean; reason: string; deskId: string | null; mode: number;
  };
  /**
   * 当前**存活**生物的快照(权威 → 投影,每帧一次)。
   *
   * ## 为什么必须由世界提供,而不是房间自己遍历
   * 房间手里只有这个结构化接口,刻意**不 import 模拟层类型** ——
   * 而 `state.wildlife` 总得有东西去填:实测接线前 `upsertWildlife()`
   * 在**全仓 0 个调用点**,于是客户端快照里恒为 `wildlife: []`,
   * 世界里有没有怪都看不见 ⇒ 打怪**永远没有目标**(不是"打不动",是没有)。
   *
   * ## 必选(刻意不写 `?`)
   * 本接口的 `levelOf?` / `applyPlayerMove?` 都是可选的:老的世界源不实现时
   * 整段跳过、不报错。但生物投影**不能**可选 —— 漏掉它的表现是
   * 「世界里满是怪、客户端一只都看不到」,一个不抛错、不打日志的静默失效。
   * ⇒ 写成必选:世界源不提供时,**装配处编译期就该红**。
   *
   * 形状与 `shared/types/wire.ts` 的 `WildlifeState` 逐字段相同
   * (那 9 个字段),这里不 import 它,只为与 `WorldSaveHost` 其余成员
   * 保持同一取舍:接口只描述形状,不引具体层。
   */
  listWildlife(): {
    id: string; mobId: string;
    x: number; y: number; z: number;
    fsm: number; hp: number; maxHp: number;
    tameOwnerId: string;
  }[];
  /**
   * 玩家语义的**物质层**(放置 / 破坏 / 地面物品)。
   *
   * 形状与 `WorldSim.materials()` 逐字段相同(那边导出为 `MaterialApi`);
   * 这里**再写一遍**是刻意的 —— 本接口的取舍是"只描述形状、不 import 具体层"。
   * 两侧若分叉,`createHost()` 里那句 `return sim` 会**编译期**报错
   * (机制说明见 `index.ts` 的 docblock)。
   *
   * 必选(不写 `?`):漏掉它的表现是「能放下、但世界没变」这类静默失效 ——
   * 与 `listWildlife` 同一理由。
   */
  materials(): {
    blockAt(x: number, y: number): number;
    placeBlock(x: number, y: number, objId: number): { ok: true } | { ok: false; reason: string };
    breakBlock(
      x: number, y: number, actorId?: string,
    ): { ok: true; objId: number; gatherMul?: number } | { ok: false; reason: string };
    groundItemsNear(
      x: number, y: number, radius: number,
    ): { itemId: number; count: number; x: number; y: number; dist: number }[];
    consumeGroundItem(itemId: number, count: number, nearX?: number, nearY?: number, radius?: number): number;
    takeGroundItemNear(x: number, y: number, itemId: number, radius: number): boolean;
    dropItem(x: number, y: number, itemId: number, count: number): void;
  };
  /**
   * 玩家的**权威等级**(来自进度档案 `progression`,不是网络投影)。
   *
   * 房间用它把 `state.players[].level` 从「恒 1 的默认值」变成**投影**
   * (见 `syncLevelProjections`)。可选:老的世界源没实现它时,
   * 等级投影整段跳过 —— 不报错,也不假装同步过。
   */
  levelOf?(playerId: string): number;
  /**
   * 把一次**已获准**的移动写进世界(权威位置 = `physics.bodies`)。
   *
   * ## 为什么需要它(task-58 的缺口)
   *
   * 接线前全仓**没有任何地方**把 `MoveIntent` 送进模拟层:
   * ```
   * room.ts        applyMove 只写 state.players[].x/y/z
   * server/src/net 写 physics.bodies 的位置/速度:**0 处**
   * world.ts:460   刚体位移只由 b.x += b.vx*dt 积分驱动
   * world_sim.ts   mobDistance 读 physics.bodies
   * ```
   * ⇒ 玩家在模拟层里**永久静止** ⇒ 距目标恒超 AOI ⇒ `attackMobAuthorized`
   *   **永久 OUT_OF_AOI** ⇒ 攻击永不结算。
   *
   * ## 反作弊**不在这里判**(判据只在一处)
   *
   * 合法性由 `anticheat.checkMove` 判定(见 `applyMove`)。本方法是**执行**,
   * 假设输入已获准。详见 `WorldSim.applyPlayerMove` 的 docblock。
   *
   * 可选:老的世界源不实现它时,`applyMove` 退回「只写 state」——
   * 与 `levelOf` / `saveToDb` 同一 null 契约,不报错也不假装。
   */
  applyPlayerMove?(playerId: string, x: number, y: number, z?: number): boolean;
  /**
   * 读回玩家的**权威位置**。与 `applyPlayerMove` 成对:
   * 写入后从权威读回、投影到 `state`,才能让**击退/搬运**对客户端可见
   * (那两条走 `applyImpulse` 改速度,不经过 `applyPlayerMove`)。
   */
  playerPosition?(playerId: string): { x: number; y: number; z?: number } | null;
  /**
   * 把玩家**登记进世界**(进场)。与 `applyPlayerMove` 是**一对**。
   *
   * ## 为什么它必须与移动转发同时存在(task-58 实测发现的第四条链路)
   *
   * 实测(生产路径 `assemble()` → `join()`):
   * ```
   * room 里 state.players.x           = 0.5(房间出生点)
   * sim 里 playerPosition('p1')       = **null**   ← 模拟层不认识这个玩家
   * ⇒ applyPlayerMove 返回 false ⇒ 移动转发**静默无效**
   * ```
   * `sim.addPlayer()` 的**生产调用者实测为 0**(只有 `demo.ts` 调)。
   * ⇒ 只修「移动转发」而不登记玩家,等于给一个不存在的刚体写坐标 ——
   *   断言会绿(写入方法返回 false 但无人检查),而玩家在模拟层里依然不存在。
   *
   * ## 出生点以**房间的**为准
   *
   * 调用方传 `state.players[].x/y`(房间已按 `spawnPoint()` 定好),保证
   * 「反作弊播种坐标」与「刚体坐标」**同源**。若两者不同,第一次移动会被
   * 判成瞬移(实测:反作弊在 0.5、刚体在 10 ⇒ 报「单帧位移 13.649 格」)。
   */
  addPlayer?(playerId: string, x: number, y: number): void;
  /** 把玩家从世界移除(离场)。与 `addPlayer` 成对,避免刚体残留。 */
  removePlayer?(playerId: string): boolean;
  /**
   * **同步一名玩家的打盹态到模拟层**(task-74)。
   *
   * ## 为什么需要这个口(而不是让模拟层自己算)
   *
   * `afk` 的**权威在房间**:`memberPresence()` / `afkSinceMs` 是只有房间知道的
   * 事实(谁断线、谁切后台、谁超时 30 分钟)。模拟层没有这些输入。
   *
   * 而实测(接线前):`world_sim.ts` 的**三处 `afk` 生产者全写字面量 `false`**
   * ⇒ `afk` 恒 false ⇒ 三条规则**静默失效**:
   * ```
   * mobs/aoi.ts:62               if (p.afk) continue;     打盹者仍提供 AOI 唤醒能量
   * mobs/behaviors.ts:196        if (p.afk) continue;     生物仍追打打盹者
   * combat/progression.ts:326/350  afkMul              打盹者仍**全额**分经验(手册 §4.1:0.3)
   * ```
   * 三条都不报错、门禁全绿、各自的单元测试都是绿的 —— 因为那些测试自己造
   * 夹具(`setPlayers([{afk:true}])`),测的是「给它 true 会跳过」,
   * **从来没人测「true 从哪来」**。
   *
   * ## 返回「是否发生变化」而不是 `void`
   *
   * 与 `restoreFromProfile` 同一纪律:返回**实际生效**的语义,
   * 调用方应断言它。忽略它会让「同步静默无效」与「同步成功」不可区分。
   *
   * ## ⚠️ 本声明**必须**与 `index.ts` 的 `createHost` 一起看
   *
   * `createHost` 的返回类型标注是 `WorldSaveHost`。`WorldSim` **有**而本接口
   * **没声明**的成员会被**结构化裁掉** ⇒ 房间侧 `typeof host.setPlayerAfk`
   * 在**编译期**恒假(不是运行期)。这正是 task-70 实测到的形态。
   *
   * 可选(`?`):老的世界源不实现它时,房间侧整段跳过 —— 与 `levelOf` /
   * `saveToDb` 同一 null 契约,不报错也不假装同步过。
   */
  setPlayerAfk?(playerId: string, afk: boolean): boolean;
  /**
   * 推进世界 **n 个快帧**(task-59:驱动缺失)。
   *
   * ## 为什么是「快帧数」而不是秒
   *
   * `WorldSim` 自管**内部双频**(`FAST_PER_SLOW = 10`),而 `tick()` 一次
   * 就是一帧(实测相位 `FAST×9 SLOW FAST×2`)。
   * ⇒ `advance(1)` 对应外部一帧,**恰好 1:1**,不需要换算。
   * `SIM_FAST_DT = 0.05 = 1/20` 与 20Hz 天然对齐。
   *
   * ## ⚠️ 调用方**绝不可**再乘 `FAST_PER_SLOW`
   *
   * 若以为「慢帧 2Hz,外面要乘 10」,就会每慢帧推进两次 AI ⇒ **世界快 2 倍**。
   * 这类错误不报错、测试也可能照过(`WorldSim.advance` 的 docblock 记录了同一先例)。
   *
   * 可选:世界源不实现它时,`step()` 整段跳过 —— 与 `saveToDb` 同一 null 契约。
   */
  advance?(frames: number): number;

  /**
   * **读档恢复的权威入口**(task-70 / 契约 §2.1)。
   *
   * 把一份**已解码的**玩家档案按固定顺序写进权威层(`progresses` / `vitals`)。
   * 顺序的内部实现在 `WorldSim.restoreFromProfile`,此处只声明契约。
   *
   * ## 为什么它必须存在(而不是房间解析 blob 后直写 `state.players[]`)
   *
   * ```
   * 实测:level 的**唯一**持久化处 = room_players.snapshot_blob
   *       (它是 encodeFull(state) 的**投影值**,不是权威)
   * 而 users 表虽然**有** level/max_hp 列:
   *       saveVitalsToUsers 只写 hp(repo.ts:773),且 hp 被 cur.max_hp(=100)钳住
   *       ⇒ **DB 路装不下 535 血**(实测 hp 恒 100)
   * ⇒ 读档只能走 blob;而 blob 是投影值 ⇒ 必须由**权威侧**接收它,
   *   否则 §4.3 的「唯一写者是 projectPlayer」被绕过:
   *   房间直写 state ⇒ 下一帧 projectPlayer 用权威旧值覆盖 ⇒
   *   表现为「恢复了又弹回」(一帧的错,但可观测)
   * ```
   *
   * ## ⚠️ `profile` **刻意不含 `maxHp`**
   *
   * `maxHp` 是 `level` 的**派生值**(`statsAtLevel`),由模拟层算。
   * 若让房间传 maxHp,就出现了第二份派生实现 —— 那正是 W1 的成因。
   *
   * ## ⚠️ 返回值的含义
   *
   * 实际生效的**玩家数**(0 通常表示「玩家未登记」⇒ 本方法内部会先 `addPlayer`,
   * 故正常路径应返回 1)。调用方应断言它,而不是忽略 ——
   * 忽略它会让「恢复静默无效」与「恢复成功」不可区分(陷阱 89)。
   */
  restoreFromProfile?(playerId: string, profile: {
    level: number;
    hp: number;
    x: number;
    y: number;
    z: number;
    /**
     * 装备的武器 id(U16)。
     *
     * ⚠️ 模拟层会把它写进 `wearing`(`weaponOf` 的既有规则:
     *    「`wearing` 里不在 `ARMOR_BY_ID` 的第一个 id 即武器」),
     *    **不是** `heldItem` —— 写错那个字段 `weaponOf` 读不到,
     *    而不会有任何东西报错。
     */
    weaponId?: number;
  }): number;

  /* ══════════ US2 裁决 3:投影所需的**只读**读口(契约 §3.1)══════════
   *
   * ## 为什么读口单独一组、且**全部可选**
   *
   * 与 `levelOf` / `applyPlayerMove` 同一 null 契约:老的世界源不实现就用
   * 「没有权威」的退路,不报错也不假装同步过。实测老源只实现了前 7 个。
   *
   * ## ★★ 为什么抽这一组而不是让房间直接读 `WorldSim` 内部 Map
   *
   * 契约 §3.1 给了两条理由,第二条是关键的:
   * ```
   * 1 投影**可单测** —— 一个假实现即可,不必起整个 WorldSim
   * 2 ★★ 它把「投影读了哪些字段」变成**显式**的 ——
   *   若将来有人在投影里读 `room.state.players[].hp` 当权威,
   *   那是**回抄**,而有了这个接口就能用「假实现不提供该字段」
   *   来**结构性挡掉**
   * ```
   * ⇒ 本接口**只暴露 SSOT 侧的值**。任何从 `state` 取数的投影都拿不到输入,
   *   因为本接口的方法签名里**根本没有** `state`。这是结构性的,不是约定。
   *
   * ## ⚠️ 与契约 §3.1 的三处**实测不符**(按实现真相取值,已记 CR)
   *
   * | 契约写法 | 实现真相 | 本接口取值 |
   * | :--- | :--- | :--- |
   * | `weaponOf(): string \| undefined` | `PlayerState.weaponId` 是 **U16 数字**(FIELD_TABLE 实测) | `number` |
   * | `poseOf(): {x,y,z} \| null` | `DynamicBody` **有** z,但 `applyMove` 只接 x/y | `{x,y,z}`(z 读回权威) |
   * | `inventoryTotalOf(): {used,cap}` | 三无(零实现/零消费者/零断言),且与 W5 方向相反 | **删声明**(见下) |
   * ```
   * ⚠️ 第一条不是笔误可以忽略的:若按契约返回 `string`,投影写进
   *    `PlayerState.weaponId`(U16,`FIELD_TABLE` 会按 2 字节编码)会得到一个
   *    **字符串进数值字段** —— 编码器要么抛,要么写出垃圾。
   *    ⇒ 按实现真相取 `number`。契约文字应改(已在文档里记 CR)。
   */
  /** 生命值权威(`VitalsSystem`)。不存在该玩家 ⇒ `null`。 */
  vitalsOf?(playerId: string): { hp: number; maxHp: number; downed: boolean } | null;
  /** 位置权威(`physics.bodies`,含 z —— 与 `playerPosition` 的 x/y 版并存)。 */
  poseOf?(playerId: string): { x: number; y: number; z: number } | null;
  /**
   * 装备权威武器 id。`undefined` = 该玩家没有武器/没有装备数据。
   *
   * ⚠️ 类型是 `number`(U16),**不是**契约里写的 `string` —— 见上表。
   */
  weaponOf?(playerId: string): number | undefined;
  /**
   * 玩家的**派对队伍**(435 复活旗是唯一来源)。没有队伍 / 世界没有派对 ⇒ `null`。
   *
   * ## 为什么房间需要它(第六轮 P1:`meta.scoreA/scoreB`)
   * `state.meta.scoreA` / `scoreB` 是**队伍口径**的两个比分,而房间手里的派对账
   * (`actions/start_party.ts` 的 `PartySnapshot.scores`)是**按玩家 id** 的。
   * 两者之间缺的正是「这个人在哪一队」—— 那是世界的权威事实(`partyTeams`,
   * 由 `WorldSim.scanPartyTeams` 从 435 旗扫出来),房间不自己猜。
   *
   * 可选(与 `levelOf?` 同一取舍):老世界源没有这个读口时,比分如实写 0,
   * 不按「加入顺序」编一个队伍 —— 编出来的表现是「比分显示在别人头上」,
   * 不报错、不影响推进,只把名次算错。
   */
  partyTeamOf?(playerId: string): string | null;

  /* ══════════ ★ WS-FND-123:boss / party 的四个读口 + 一个写口 ══════════
   *
   * 修前这五条**一条都没有**,于是两条链路在两端各自"正常"、中间断着:
   * ```
   *   bosses :world 有 bossRaid.snapshots()  room 有 upsertBoss()    ⇒ 无人调 ⇒ 客户端 bosses=[]
   *   party  :436 哨台建 contest        START_PARTY 建 PartyRecord   ⇒ 两套开局互不通 ⇒ HUD 恒 0
   * ```
   * 全部**可选**(与 `partyTeamOf?` 同一取舍):手写 host 假件(测试/脚本)不实现
   * 它们本来就合法 —— 缺哪个读口,对应那一款行为**如实不做**(不猜值、不兜底)。
   */

  /** 在场 Boss 的只读快照(`bosses/runtime.ts` 的 12 个内部字段);无 ⇒ `undefined`。 */
  bossSnapshots?(): readonly {
    bossId: string;
    hp: number;
    maxHp: number;
    phaseIndex: number;
  }[];

  /**
   * 在场 Boss 的**线格式**投影(`BOSS_FIELD_TABLE` 的 10 个字段)。
   *
   * 为什么不复用 `bossSnapshots()`:它**不含** `telegraphShape/X/Y/R/EndTick` 与 `id`,
   * 那五格是客户端画地面预警的唯一来源(`bossHudFrom`)。
   * 房间只做搬运(`projectBosses`),几何由世界侧算 —— 这里**不许**再算一遍。
   */
  bossHudSnapshots?(): readonly {
    id: string;
    bossId: string;
    phase: number;
    hp: number;
    maxHp: number;
    telegraphShape: number;
    telegraphX: number;
    telegraphY: number;
    telegraphR: number;
    telegraphEndTick: number;
  }[];

  /** 派对相位(`IDLE` / `BUILD` / `RACE` / `PLAY` / `SETTLED`);没有派对 ⇒ `'IDLE'`。 */
  partyPhase?(): string;

  /** 本局模式键(`BRIDGE_CTF` / `JELLY_BALL` / `CROWN_BR` / `PAINT_WAR`);未开局 ⇒ `null`。 */
  partyModeKey?(): string | null;

  /** 本局裁判的玩家 id(站在 436 哨台上的人);未开局 ⇒ `''`。 */
  partyReferee?(): string;

  /**
   * **开一局派对**(★ 两套开局的另一半)。
   *
   * `START_PARTY` 只建**记分账**(`actions/start_party.ts` 的 `PartyRecord`),
   * 世界侧的 contest 只能由这里开 —— 修前两条路各开一半,于是:
   * `addScore` 永不调用(没账本)/ `partyPhase()` 恒 `IDLE`(没赛局)。
   *
   * 返回 `false` = 世界拒绝(未知模式键 / 空裁判 id),调用方如实记录,**不**当成功。
   */
  startPartyRun?(key: string, refereeId: string): boolean;

  /** 最近一次派对结算的**线格式视图**(终场文案 / 前三名 / 各队名次);无 ⇒ `null`。 */
  partySettlementView?(): {
    modeName: string;
    broadcastText: string;
    top: string[];
    standing: { rank: number; team: string | null; value: number }[];
  } | null;

  /** 急单结算回执(`RUSH_GRADE` 在这里);未结算 ⇒ `null`。 */
  rushSettlement?(): { grade: string; score: number } | null;

  /**
   * 世界总线(**只订阅**,不 emit)。
   *
   * 播报此前只 `bus.emit('party_broadcast')`,而 `server/src` 里 `.bus.on(` 是 **0 处**
   * ⇒ 比分播报 / 终场文案 / 前三名堆在总线里没人取。房间订阅它是这条链的第一段消费。
   */
  bus?: {
    on(pattern: string, handler: (e: { kind: string; payload?: Record<string, unknown> }) => void): unknown;
  };
  /* ⚠️ 此处**刻意没有** `inventoryTotalOf(): {used, cap}` —— 契约 §3.1 列了它,
     但实测它在本仓是**三无**:零实现(WorldSim 没有)、零消费者(step/applyInventory
     都不读)、零断言引用。而它给的又是**总量**,与 W5 的裁定
     「总量必须由**明细重算**,不得当输入」**方向相反** ——
     留着它会鼓励将来有人「读总量再赋给 state」,那正是 W5 要挡的形态。
     ⇒ 第 8 项的真实通路是:
       `projectInventoryTotalFor` → `host.inventoryDetailOf` → `projectInventoryTotal`
     ⇒ 故删声明而不补实现(已在 docs/WS-07-net-persist.md §9.1 记 CR)。 */
  /**
   * **世界重置**(`RESET_WORLD` 的唯一通路)。★ **2026-11-16 起有实现者**:
   * `WorldSim.resetWorld`(`server/src/sim/world_sim.ts`),落点见
   * `docs/DECISIONS.md` **D-06**(= 归档 + 内存重建)。
   *
   * ## 为什么仍是**可选**成员
   *
   * 本接口每个成员都要求实现者**真的做得到**。手写 host 假件(`tests/**`、
   * `scripts/**` 里那几份)不实现它本来就合法 —— 那种宿主走的是动作层的
   * 「能力缺失」分支(显式 `NOT_IMPLEMENTED`,不许静默成功)。
   * 做成必填会逼所有假件补一个**假实现**,那正是本仓反复防的"静默成功"。
   * 配套那行 `return sim` 也说明了这点:可选成员**必须**在这里声明,
   * 否则会被结构化裁掉(`index.ts` 的 `createHost` docblock)。
   *
   * ## 契约:返回**实际生效**的语义(不是"我收到了请求")
   *
   * - `applied: true`  ⇒ 世界已经是新种子,调用方必须假定旧状态全部作废
   *   (地形 / 生物 / 掉落 / 钟点 06:00;玩家保留、满血、回出生点);
   * - `applied: false` ⇒ **一字未改**,`reason` 说清为什么。
   *
   * ## 归档回执(★ D-06,三态的来源)
   *
   * `archive` **必填**(不是可选):
   *   - `{ id, seed, archived_at, bytes }` = 旧世界**已归档**;
   *   - `null` = **明确**没归档,原因在 `archiveError`(`'没有库'` / sink 抛错 / …)。
   *
   * ⚠️ **归档失败不许改 `applied`**:世界确实已经重建了,把 `applied` 写成
   *   `false` 会让调用方以为还停在旧世界(继续用旧 chunk)。动作层
   *   (`net/actions/reset_world.ts` 的 `resetEffect`)按这三态回 `ARCHIVED` /
   *   `NOT_ARCHIVED` / `UNREPORTED`,本接口的形状必须与它**逐字段同形**。
   *
   * ## 参数
   *
   * - `seed`:**新世界**的种子(有限整数;非法 ⇒ `applied: false` + 零副作用);
   * - `nowMs`:**可选**归档时间戳(动作层手里没有时钟,缺省世界自己取
   *   `Date.now()`)。它**只进归档行**,不进模拟 —— 世界时钟由帧序派生(D-07),
   *   挂钟不会污染确定性。
   */
  resetWorld?(opts: { seed: number; nowMs?: number }): {
    applied: boolean;
    /** **实际生效**的种子(`applied: true` 时 = 新世界的种子)。 */
    seed: number;
    reason?: string;
    /** 旧世界归档回执(★ D-06):`{...}` = 已归档;`null` = 明确没归档。 */
    archive: { id: string; seed: number; archived_at: number; bytes: number } | null;
    /** 归档失败 / 没有库的原因(归档没成不该让回执看起来一切正常)。 */
    archiveError?: string;
  };
  /**
   * 该玩家是否已**解锁高级锻造**(★ D-11:站进 `FORGE_MASTER` 房间 ⇒ true)。
   *
   * 世界侧把 `rooms/effects.ts` 的 `RoomEffectResult.forgeUnlocked` 投影成这条读口
   * (不另算一份房间归属)。**可选**(`?`):没有它时 `CRAFT` 对 `station === 505`
   * 的配方回 `NOT_IMPLEMENTED` —— 显式能力缺失,不是静默放行。
   */
  forgeUnlockedOf?(actorId: string): boolean;
  /**
   * **使用一件道具**(`USE_ITEM` 的唯一世界侧落点)。
   *
   * 为什么是一个**通用**口而不是三个专用方法:道具语义按 `itemId` 分派
   * (733 救队友 / 227 困人 / 料理吃 buff),三者共享同一套"判定 → 扣减 → 写回"纪律。
   * 开三个方法会让动作层按 itemId 自己 `if/else`,把语义判断复制到两层。
   *
   * ⚠️ **今天没有"按件背包明细"读口**(`PlayerState` 只有 `heldItemId`)⇒
   *   `itemId` 由动作层从报文取(客户端自报),世界侧**只信它是自己认识的 id**,
   *   不校验"该玩家真的有这一件" —— 那需要先补按件读口(见 `TASK-99`)。
   */
  useItem?(actorId: string, req: { itemId: number; targetId?: string; targetDeviceId?: number }): UseItemOutcome;
  /**
   * **百货店购买(515)的报价**(`BUY_ITEM` 的第一步)。**零副作用**:
   * 在库存副本上跑一遍 `systems/depot.ts:buy`,失败时世界一个字节都不改。
   *
   * 为什么拆成「报价 + 提交」两步:动作层要**先知道这笔能不能成**,
   * 再去扣玩家背包(否则失败时会出现「扣了东西但没买到」)。
   * `buy` 是纯函数 ⇒ 两次调用算的是同一件事,不构成第二份实现。
   *
   * 可选:老的世界源没有摊位 ⇒ 动作层回 `NOT_IMPLEMENTED`(显式能力缺失)。
   */
  purchaseQuote?(itemId: number, qty: number): {
    ok: boolean;
    reason: string;
    cost: number;
    stock: Record<number, number>;
  };
  /**
   * **百货店购买(515)的提交**:只有成交才写库存。
   *
   * 与 `purchaseQuote` 一起构成「检查 → 扣背包 → 落定」的三段事务;
   * 任何一段失败,库存与背包都回到原样(见 `actions/buy_item.ts` 的判序)。
   */
  purchaseCommit?(itemId: number, qty: number): { ok: boolean; cost: number; reason: string };
  /**
   * **炼金首创冠名 + 537 陈列投影**(`ALCHEMY_LAB` 的系统落点)。
   *
   * 为什么不是 `forgeAlchemy`:那条路要外部 LLM 网关,而本仓的确定性
   * 降级路径(`systems/alchemy_lab.ts` → `alchemy/degrade.ts`)在离线也能出产物 ——
   * 「全服首创」因此**在没有模型的房间里也可判定**。
   */
  brewAtFurnace?(actorId: string, itemIds: readonly number[], opts?: {
    affinity?: number;
    suggestedSLogic?: number;
    at?: number;
  }): {
    ok: boolean;
    reason?: string;
    first?: boolean;
    entry?: {
      recipeHash: string;
      discovererName: string;
      itemName: string;
      itemCategory: string;
      craftCount: number;
      firstAt: number;
      schemaJson: string;
    };
    display: {
      recipeHash: string;
      discovererName: string;
      itemName: string;
      itemCategory: string;
      craftCount: number;
      firstAt: number;
    }[];
  };

  /* ══════════ ★ 2026-11-18(第五轮 P2):被**实际读取**的 6 个成员必须在这里声明 ══════════
   *
   * ## 修前是什么形态
   *
   * 下面这 6 个成员 `WorldSim` 都有、房间也都在用,但**本接口一句都没声明** ⇒
   * `createHost()` 的 `return sim` 会把它们**结构化裁掉**,于是各消费方只能:
   * ```
   * room.ts:2667        host as (WorldSaveHost & { syncMaxHp?(...) })        ← 交叉类型
   * room.ts:2694        host as (WorldSaveHost & { inventoryDetailOf?(...) })← 交叉类型
   * actions/sleep.ts     host as unknown as RoomEffectCapableHost           ← 局部窄类型
   * actions/place_automation.ts  host as unknown as SizeCapableHost         ← 局部窄类型
   * actions/use_alchemy_furnace.ts  host as unknown as AlchemyLabReadPort   ← 局部窄类型
   * ```
   * 这与本接口第 798-806 行自称的「结构化裁剪守卫」**直接相悖**:守卫的价值是
   * 「漏声明 ⇒ 编译期红」,而这几处 `as` 让「漏声明」照样编译通过 ⇒ 守卫在最需要它的
   * 地方失效了(第五轮实测 P2)。
   *
   * ## 为什么仍写成**可选**(`?`)
   *
   * 与 `setPlayerAfk` / `resetWorld` 同一契约:手写 host 假件(`tests/**`、`scripts/**`)
   * 不实现它们本来就合法,那种宿主走动作层的「能力缺失」分支(显式 `NOT_IMPLEMENTED`),
   * **不许**静默成功。改成必填会逼所有假件补一个假实现 —— 那正是本仓反复防的形态。
   *
   * ## 形状从哪来(以实现真相为准,不引模拟层类型)
   *
   * 逐字段对着 `server/src/sim/world_sim.ts` 的签名抄,并**只抄房间用到的那几维**:
   * `roomEffectOf` 只留 `inBedroom`(`sleep.ts` 读的那一维)、`lastRoomEffects` 只留
   * `playerId` / `roomKey`(`use_alchemy_furnace.ts` 站位判定读的那两维)——
   * 多抄一维就多一份「将来会漂」的声明。
   */
  /**
   * 等级 → **派生上限**(`progression.statsAtLevel` 的唯一算子,含温泉/大餐乘区)。
   * `null` = 没有这个玩家。房间只**搬运**它(经 `syncMaxHp` 落到权威 `vitals`)。
   */
  maxHpForLevel?(playerId: string, level: number): number | null;
  /**
   * 把派生上限写进权威 `vitals`(钳制策略 C 在 vitals 内,**不在这里再钳一次**)。
   * @returns 是否**真的发生变更**(同值重复提交 ⇒ false,供调用方避免重复投影)。
   */
  syncMaxHp?(playerId: string, maxHp: number): boolean;
  /**
   * 背包**明细**(第 8 项总量重算的唯一输入,契约 §2.3 的 W5 裁定)。
   *
   * ⚠️ 生产实现(`world_sim.ts`)如实返回 `null`:模拟层不持有背包明细。
   * 房间侧因此**必须**有同源的退路(见 `RoomRuntime.inventoryDetailOf` 与
   * `projectInventoryTotalFor`)——「宿主没有明细」不等于「不重算」。
   */
  inventoryDetailOf?(playerId: string): readonly { quantity?: unknown }[] | null;
  /** 该玩家本慢帧的房间效果(只声明 `sleep.ts` 读的那一维)。 */
  roomEffectOf?(playerId: string): { readonly inBedroom: boolean } | undefined;
  /** 世界边长(格)。`place_automation` 的坐标上界读它,读不到才退回防呆常量。 */
  readonly sizeCells?: number;
  /**
   * 最近一慢帧的房间效果**成行**结果(只声明站位判定读的两维:
   * `playerId` / `roomKey`)。`roomKey === null` = 不在任何具名房间。
   */
  lastRoomEffects?: readonly { readonly playerId: string; readonly roomKey: string | null }[];
}

/** 投影输出的 7 个状态字段(第 8 项 `inventory` 不落在 `PlayerState` 上,见下)。 */
export interface PlayerProjection {
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  z: number;
  weaponId: number;
}

/**
 * 投影所需的**只读**读口(契约 §3.1)。
 *
 * ## 为什么它与 `WorldSaveHost` 的读口分开定义
 *
 * `WorldSaveHost` 是「房间对世界的完整契约」(写口 + 读口 + 驱动口),
 * 而本接口是**投影函数唯一被允许的输入面**。
 * ⇒ 分开之后,`projectPlayer` 的签名**结构上**只能拿到 SSOT 侧的值:
 *   它没有任何参数能触及 `room.state`,所以「回抄」不是「不该做」,
 *   而是**做不到**(契约 §3.1 理由 2 的兑现)。
 *
 * ## ⚠️ 全部方法返回 `null`/`undefined` 的语义
 * ```
 * null  = 「权威说这个玩家不存在」⇒ 该字段**不投影**(保留旧值,不写 0)
 * ⇒ ★ 不能把 null 当 0 写:那会让「世界不认识这个玩家」表现为
 *   「玩家血量归零 / 位置瞬移到原点」——两个都像真的故障。
 * ```
 */
export interface SimReadView {
  levelOf(playerId: string): number;
  vitalsOf(playerId: string): { hp: number; maxHp: number; downed: boolean } | null;
  poseOf(playerId: string): { x: number; y: number; z: number } | null;
  weaponOf(playerId: string): number | undefined;
}

/**
 * 把 SSOT 投影到只读网络视图(契约 §3.2)。
 *
 * ## 纯函数语义
 *
 * ```
 * 同样输入 ⇒ 同样输出,且**不读 `out` 自身**。
 * ```
 * ⚠️ 注意「不读 out 自身」是**性质**,不是风格:一旦读 `out.hp` 去算新值
 *    (例如 `out.hp -= dmg`),就又把投影变成第二个权威了。
 * 本函数的实现里只出现 `view.*` 与字面常量 —— 没有 `out.` 的读。
 *
 * ## 返回「是否发生变更」而不是「是否有权威值」
 *
 * 契约 §3.2 要求返回 `boolean` 供 20Hz 差分编码复用 —— 但含义必须是
 * **「有字段真的变了」**,不是「读到了权威」。理由:
 * ```
 * 若返回「读到了」⇒ 每帧恒 true ⇒ 差分编码退化成全量下发
 * (带宽浪费,且掩盖"其实没变"这个事实)
 * ```
 *
 * ## ⚠️ 为什么 `level` 要夹上界,而 `hp`/`maxHp` 不夹
 *
 * `level` 夹一次(与既有 `syncLevelProjections` 同口径),理由是本字段的
 * **消费者不夹**:`carryCapacityOf` 直接 `8 + (lv - 1)`。若投影越界,
 * 房间容量口径与 `progression.statsAtLevel`(已钳)就分歧了。
 * 而 `hp`/`maxHp` 的钳制**已经在 `VitalsSystem` 内**(`syncMaxHp` 策略 C),
 * ⇒ 在这里再钳一次就是**第二份实现**(本仓明确的缺陷形态)。
 * ⇒ 分工:上界统一一处(`vitals` 管生命、`progression` 管等级),
 *   投影只**搬运**。
 *
 * ## ⚠️ `z` 从权威读,不从报文
 *
 * `poseOf` 返回的 z 来自 `DynamicBody.z`。此前 `applyMove` 写的是
 * `p.z = intent.z`(客户端声明值)—— 那是任务 58 之前的旧路径。
 * 现在权威有 z(高度/跳跃/流体浮沉都会改它),投影必须读权威,
 * 否则「玩家在水里被抬起」这类变化对客户端不可见。
 */
export function projectPlayer(view: SimReadView, playerId: string, out: PlayerProjection): boolean {
  let changed = false;

  /* ── 1 level(权威 = progresses;夹上界,理由见 docblock)── */
  const lv = view.levelOf(playerId);
  if (Number.isFinite(lv)) {
    const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(lv)));
    if (out.level !== clamped) { out.level = clamped; changed = true; }
  }

  /* ── 2 hp / 3 maxHp(权威 = vitals;**不夹**,钳制在 vitals 内)── */
  const v = view.vitalsOf(playerId);
  if (v !== null) {
    if (Number.isFinite(v.hp) && out.hp !== v.hp) { out.hp = v.hp; changed = true; }
    if (Number.isFinite(v.maxHp) && out.maxHp !== v.maxHp) { out.maxHp = v.maxHp; changed = true; }
  }

  /* ── 4/5/6 x,y,z(权威 = physics)──
     ⚠️ `null` ⇒ 不投影(保留旧值)。把 null 当 0 写会让「世界不认识这个玩家」
        表现成「瞬移到原点」——那看起来像真故障,会把排障引偏。 */
  const pose = view.poseOf(playerId);
  if (pose !== null) {
    if (Number.isFinite(pose.x) && out.x !== pose.x) { out.x = pose.x; changed = true; }
    if (Number.isFinite(pose.y) && out.y !== pose.y) { out.y = pose.y; changed = true; }
    if (Number.isFinite(pose.z) && out.z !== pose.z) { out.z = pose.z; changed = true; }
  }

  /* ── 7 weaponId(权威 = 装备)──
     ⚠️ `undefined` = 「没有装备数据」⇒ 不投影。不得写成 0:
        `0` 在 FIELD_TABLE 里的语义是「空手」,那是一个**真实的手持状态**,
        与「采不到权威」是两件事(本仓 CR-14 U1 的同族区分)。 */
  const w = view.weaponOf(playerId);
  if (w !== undefined && Number.isFinite(w) && out.weaponId !== w) {
    out.weaponId = w;
    changed = true;
  }

  return changed;
}

/**
 * 背包**总量** = 由明细**重算**的纯函数(契约 §2.3 的 W5 裁定)。
 *
 * ## ★★ 为什么必须是纯函数,不得累加式更新
 *
 * ```
 * 累加式:total += delta   ⇒ **漏一帧就永久偏差**(误差不可自愈)
 * 重算式:total = f(items) ⇒ 任何一帧的结果都只依赖当时的明细
 * ```
 * 契约 §2.3 明写这一条。实测同族先例:本仓 `repo.ts` 的 `totalItemsOf`
 * 就是**对明细求和**,不是读一个累加计数器 —— 两者结果应一致,
 * 而那正是本函数可以**交叉验证**的对象。
 *
 * ## ⚠️ 与 `room.inventoryTotals` 的关系(这才是 W5 的实质)
 *
 * ```
 * users.inventory_json(明细)  →  权威
 * room.inventoryTotals(总量)  →  **派生缓存**(纯内存模式下的退路)
 * ⇒ 方向 = 明细 → 总量(单向)
 * ⇒ 故本函数**只接受明细数组**,不接受任何"当前总量"参数 ——
 *   那会让它又变成「以总量为输入」(= 双向的第一步)。
 * ```
 * ⚠️ 若传入的明细**不是数组**(库返回 `{}` / `null`),回退 `0` 而不是 `NaN`:
 *    `NaN` 会让 `after > capacity`、`after < 0` 全部恒 false ⇒ 容量守恒失效
 *    (与 CR-27 同族)。
 *
 * @param items 明细(每项至少要有 `quantity`)
 * @returns 总件数(非负整数);输入非法时 `0`
 */
export function projectInventoryTotal(
  items: readonly { quantity?: unknown }[] | null | undefined,
): number {
  if (!Array.isArray(items)) return 0;
  let sum = 0;
  for (const it of items) {
    const q = it?.quantity;
    /* ⚠️ 逐项 `isFinite` 而不是整段求和后判断:一项 `NaN` 会毒化整个和,
       而逐项挡掉能让「其余合法项仍然计入」—— 与 `checkInventory` 的
       `FRACTIONAL` 逐项判同一取向。 */
    if (typeof q === 'number' && Number.isFinite(q)) sum += q;
  }
  return sum < 0 ? 0 : sum;
}

/**
 * `action` 报文里除动作名之外能带的参数(**可选**;缺则按 `INVALID` 拒绝)。
 *
 * 为什么不把参数并进 `RoomAction` 常量本身:动作名是**协议常量**,
 * 而要带的参数随动作而变(16 个动作里只有 4 个需要参数)。
 * 分开之后,「动作清单」这一份事实仍然只有一处(`RoomAction`)。
 */
export interface ActionPayload {
  /** `SET_MEMBER_ROLE` / `KICK_MEMBER`:目标成员。 */
  targetId?: string;
  /** `SET_MEMBER_ROLE`:新角色。 */
  role?: RoomRole;
  /** `SET_ROOM_ACCESS`:访问模式。 */
  mode?: AccessMode;
  /** `SET_ROOM_ACCESS`:密码房的口令 hash(`null` = 无密码)。 */
  passwordHash?: string | null;
  /** `SET_PARTY_MODE`:派对模式。 */
  /** `SET_PARTY_MODE`:派对模式。 */
  partyMode?: PartyMode;
  /* ── 物质层的四个动作(2026-11-14)────────────────────────────

     这四个字段此前**不存在**,因为那四个动作没有执行层(`TASK-96`)。
     它们都取"客户端只说**做什么**,不说**在哪/多少算数**"的口径:
     `x`/`y` 是目标格,`itemId` 是内容表里的 id,`count` 是件数。
     ⚠️ 丢弃/拾取**不用**客户端报的坐标 —— 落点取权威位置(见 `dispatchAction`)。 */
  /** `PLACE_BLOCK` / `BREAK_BLOCK`:目标格坐标。 */
  x?: number;
  y?: number;
  /** `PLACE_BLOCK` / `DROP_ITEM` / `PICKUP_ITEM`:物品 id(必须在冻结内容表里)。 */
  itemId?: number;
  /** `DROP_ITEM`:丢弃件数(默认 1)。 */
  count?: number;
  /**
   * `USE_ITEM`:目标**器件**(料理站等设备 id)。
   *
   * 与 `targetId`(玩家)是**互斥**的两种报文形态:器件目标走"浇灭炉火",
   * 玩家目标走"救人 / 困人 / 吃 buff"。**两者同时给出 ⇒ 动作层直接拒(`INVALID`)**
   * (`net/actions/use_item.ts`);世界侧另有一道兜底:见 `targetDeviceId` 就不读 `targetId`。
   * 器件在内容表里是**物件 id**(506 汤锅 / 507 切菜台 / 508 披萨炉),不是玩家 id。
   */
  targetDeviceId?: number;
  /**
   * `USE_ITEM`:服务端**账面**的格子序号(0 起,按 `itemId` 升序)。
   *
   * 它不是客户端自报的物品 id —— 服务端拿它去自己的按件账上翻出真实 `itemId`,
   * 与申报的 `itemId` **不一致就拒**(见 `actions/use_item.ts`)。
   * 之所以让客户端能报 slot:UI 列表天然是"第几格",而**翻译**这一步必须在服务端。
   */
  slot?: number;

  /* ── ★ 2026-11-18(第五轮 P2):7 个动作的**消费键**此前不在契约里 ────────────
   *
   * 实测:下列键各自被动作模块读取,却**一个都没写进本接口** ⇒ 消费方只能
   * 各自补交叉类型(`ActionPayload & { ... }`,六处)或直接 `as { key?: unknown }`,
   * 于是「协议只有一处」这条纪律在实际读写里被绕过:
   * ```
   * WIRE_EDIT          dir / color / channel / clear
   * BREED_TAME         op / petId / mobId / mateId
   * MODIFY_TOWN        radius / name / totemCell
   * RESET_WORLD        seed / confirm
   * BUY_ITEM           qty / orderId
   * ALCHEMY_LAB        orderId(与 BUY_ITEM 同键:同一个幂等请求号语义)
   * PLACE_AUTOMATION   kind
   * ```
   *
   * ⚠️ 为什么**全部**是 `unknown` 而不是各自的细类型:
   * 报文是**外部输入**,`ws_server` 把客户端 JSON 原样递进来 ⇒ 契约侧只能说
   * 「这个键可能出现,值未知」;真正的收窄在**唯一**的消费处(各动作模块的
   * `intField` / `numField` / 域检查),那里失败一律 `INVALID` 并**不猜默认值**。
   * 若在这里写 `radius?: number`,就等于让「字符串 8」在编译期变成合法报文 ——
   * 那是把消毒从动作层挪进类型系统,而类型系统在运行期不存在。
   *
   * ⚠️ 各动作模块里的局部交叉类型(如 `TownPayload`)现在与这里**同义重复**,
   * 但它们是**读**用的窄化,不是第二份协议定义;是否删由各模块自己定
   * (本次可改范围不含那几个文件)。
   */
  /** `WIRE_EDIT`:方向下标(合法域 = `DIR_VECTORS` 下标)。 */
  dir?: unknown;
  /** `WIRE_EDIT`:四色之一(合法域 = `ALL_COLORS`)。 */
  color?: unknown;
  /** `WIRE_EDIT`:无线频道(合法域 = `[CHANNEL_MIN, CHANNEL_MAX]` 整数)。 */
  channel?: unknown;
  /** `WIRE_EDIT`:`true` = 断开(只接受字面 true)。 */
  clear?: unknown;
  /** `BREED_TAME`:子动作(`TAME` / `FEED` / `BREED` …)。 */
  op?: unknown;
  /** `BREED_TAME`:宠物 id。 */
  petId?: unknown;
  /** `BREED_TAME`:生物 id。 */
  mobId?: unknown;
  /** `BREED_TAME`:繁殖配对的那一只。 */
  mateId?: unknown;
  /** `MODIFY_TOWN`:新安全区半径(有限整数,`MIN/Max_TOWN_RADIUS` 之间)。 */
  radius?: unknown;
  /** `MODIFY_TOWN`:新城镇名(去空白后 1..`MAX_TOWN_NAME_LEN`)。 */
  name?: unknown;
  /** `MODIFY_TOWN`:新图腾格;`null` = 清掉图腾。 */
  totemCell?: unknown;
  /** `RESET_WORLD`:新世界种子(有限整数)。 */
  seed?: unknown;
  /** `RESET_WORLD`:二次确认(只接受字面 true —— 重置是不可逆破坏性动作)。 */
  confirm?: unknown;
  /** `BUY_ITEM`:购买件数(正整数;**缺省不等于 1**,缺了就是 `INVALID`)。 */
  qty?: unknown;
  /** `BUY_ITEM` / alchemy:客户端请求号(可选幂等键;给了就**原样**透传)。 */
  orderId?: unknown;
  /** `PLACE_AUTOMATION`:组件种类名(必须在 `wiring` 注册表里)。 */
  kind?: unknown;
}

/**
 * 一次动作分派的**结果 + 回执**。`effect` 放可序列化的少量字段 ——
 * 回执要能直接进报文,不许把内部对象漏出去。
 *
 * ⚠️ `effect` 的值域是 `EffectRecord`(**JSON 值**),不是「只标量」:
 * `craft` 的逐件扣料表 / `use_alchemy_furnace` 的冠名证书与陈列投影都是嵌套结构,
 * 它们此前被 `as unknown as EffectRecord` 绕过(见 `EffectValue` 的 docblock)。
 * 仍然**不许**漏内部对象:能进这里的只有**纯数据**(JSON 值),不是类实例/Map/函数。
 */
export interface ActionOutcome {
  ok: boolean;
  /** 结果类别。**必须显式**(含 `NOT_IMPLEMENTED`)= 消灭"静默成功"的载体。 */
  kind: 'OK' | 'PERMISSION' | 'INVALID' | 'NOT_IMPLEMENTED' | 'ROOM_CLOSED';
  /** 失败原因;`ok === true` 时不存在。 */
  reason?: string;
  /** 成功时的后果摘要(回执用)。值域见 `EffectValue`。 */
  effect?: EffectRecord;
}

/**
 * **按件库存读口**(`USE_ITEM` 的 itemId 权威来源)。
 *
 * ## 为什么独立成接口,而不是塞进 `ActionContext`
 *
 * `actions/types.ts` 是**跨动作**的契约文件(另一条线在改它)。
 * 这一项只有 `USE_ITEM` 用,且它必须由**房间**实现(账本在 `RoomRuntime`)。
 * ⇒ 用结构化类型接线:`RoomRuntime` 直接把绑定后的两个函数放进 `ActionContext`,
 * 处理器侧用 `Partial<ItemReadPort>` 窄化(**缺读口**时走"没有权威"分支,
 * 而不是假装有 —— 与 `simReadView` 的逐口降级同一取舍)。
 */
export interface ItemReadPort {
  /** 某玩家的某件道具**真的**有几件;0 = 账面没有。 */
  itemCountOf(userId: string, itemId: number): number;
  /** 该玩家按 itemId 升序的持有清单(`slot` 报文体据此翻译)。 */
  itemIdsOf(userId: string): number[];
}

/**
 * 第 8 项「总量 ← 明细」重算时,明细**是从哪来的**(诊断与判据用;见
 * `RoomRuntime.inventoryDetailSource`)。
 *
 * ```
 * 'host' = 世界源提供了明细(它以世界侧权威为准)
 * 'room' = 宿主没有明细(生产实现恒 null)⇒ 退回**本房间按件账**(与总量账同一批 ops)
 * 'none' = 两个来源都没有 ⇒ **不重算**(fail-closed,不编造 0)
 * ```
 */
export type InventoryDetailSource = 'host' | 'room' | 'none';

/**
 * 单个房间的运行时。**不 import colyseus** —— colyseus 的 Room 只是薄装配层
 * (`room.colyseus.ts`),把它的 onTick/onJoin 转发到这里的方法。
 */
export class RoomRuntime {
  readonly id: string;
  readonly ownerId: string;
  readonly clock: Clock;
  state: RoomState;
  status: RoomStatus = RoomStatus.OPEN;
  accessMode: AccessMode;
  passwordHash: string | null;
  maxPlayers: number;
  /**
   * 派对模式。★ 2026-11-18(第五轮 P3):**唯一写者是 `state.meta.partyMode`**。
   *
   * ## 修前:两处维护,其中一处只写不读
   *
   * 此前这里是一个并列字段 `partyMode: PartyMode = PartyMode.NONE`,由
   * `setPartyModeBy` 和 `state.meta.partyMode` **各写一次**:
   * ```
   * this.partyMode = mode;                                   ← 内存副本
   * this.state.meta.partyMode = Object.values(PartyMode).indexOf(mode);  ← 线快照
   * ```
   * 实测:`rt.partyMode` 的**生产读者 = 0**(只有测试读它)⇒ 一份没人读的第二份状态,
   * 迟早与快照漂移(而漂移时没有任何断言会红 —— 它本来就没读者)。
   *
   * ## 现在:解码读法(单一存储)
   *
   * 存储只有 `state.meta.partyMode`(枚举**下标**,因为线协议要 U8);
   * 本访问器按 `Object.values(PartyMode)` 还原 —— 与 `setPartyModeBy` 编码用的是
   * **同一张值表**,故 encode/decode 不可能对不上。越界下标(坏快照)⇒ `NONE`,
   * 与 `START_PARTY` 那边「下标不是任何合法模式 ⇒ 拒」同一取向。
   *
   * ⚠️ `get` 而不是方法:既有调用点(`rt.partyMode`)与 `tests/WS-07` 的断言
   * 都按**字段**读它,改成方法会在调用点静默变成「函数对象」。
   */
  get partyMode(): PartyMode {
    const table = Object.values(PartyMode);
    return table[this.state.meta.partyMode] ?? PartyMode.NONE;
  }
  readonly ac: AntiCheatRoom;
  readonly members = new Map<string, MemberSession>();
  /** 上次「有人活动」的时刻。 */
  lastActivityMs: number;
  /** SQLite 仓储(可注入;null = 纯内存模式,不进库)。 */
  readonly db: DbLike | null;
  /**
   * 世界存档源(可注入;null = 本房间没有模拟层,只落 world_tick)。
   *
   * 弱点可见:`null` 时 HP 与生物 mem **不会落盘**。这个事实由
   * `lastSaveReport` 暴露出来,而不是让调用方以为「已经存过了」。
   */
  worldSaveHost: WorldSaveHost | null = null;
  /** 上一次落盘的实际计数;null = 从未落盘。供测试与诊断断言。 */
  lastSaveReport: {
    tick: number;
    hpSaved: number;
    hpSkipped: number;
    memRow: number;
  } | null = null;
  /**
   * 上一次读档恢复:`restoreFromProfile` 返回的**生效玩家数**;null = 从未尝试。
   *
   * 与 `lastSaveReport` 同一处置:把「做了没有、生效几条」**显式暴露**,
   * 而不是让调用方以为「已经恢复过了」。
   */
  lastRestoreApplied: number | null = null;
  /**
   * 上一次读档失败的**原因**;null = 无失败。
   *
   * ⚠️ 只记**真失败**(存档存在但解不开 —— 协议版本变了 / 字节截断),
   * **不记**「没有存档」(那是常态,不是错误)。
   * ⇒ 这个区分是刻意的:两类混在一起会让「读坏了」看起来像「首次进入」。
   */
  lastRestoreError: string | null = null;

  /**
   * ★ WS-FND-131(P2 移除侧):最近一次「世界侧移除」是否**真的落地**;
   * `null` = 从未尝试过移除(与 `lastRestoreApplied` 同一处置)。
   *
   * ```
   * true   世界侧确实移除了(或本来就没有世界源 —— 没有残留可留)
   * false  两次尝试都抛 ⇒ 已进 `pendingWorldRemovals`,下一帧重试
   * ```
   * 缺陷形态见 `removeFromWorld()`:修前 `host.removePlayer` 排在最后且无 try,
   * 抛了就整条 `leave()` 被吞、`members` 已删 ⇒ 世界侧**没有任何重试点**,
   * 而外部**看不出**这次移除失败了。
   */
  lastRemoveApplied: boolean | null = null;
  /** 最近一次世界侧/反作弊清理的错因;null = 无错。 */
  lastRemoveError: string | null = null;
  /** 世界侧移除失败、等待下一帧重试的 userId(见 `retryPendingWorldRemovals`)。 */
  private readonly pendingWorldRemovals = new Set<string>();

  /**
   * ★ WS-FND-131(P1):最近一次入场的**三方交叉校验**结果;null = 还没入场过。
   *
   * `world` 是**三态**:`unknown` = 该世界源没有 `playerPosition` 读口
   * (不冒充 ok,见 `auditJoin`)。
   */
  lastJoinAudit: {
    userId: string;
    members: boolean;
    state: boolean;
    world: 'ok' | 'missing' | 'unknown';
  } | null = null;
  /** 每 tick 累计的违规,由外层写 room_events。 */
  private pendingViolations: Violation[] = [];

  /* ══════════ ★ WS-FND-123:boss 投影 / 派对记账打通 / 播报下发 ══════════
   *
   * 这四组状态全部是**可观测量**(计数或最近一次的副本),不是第二份真值:
   * 真值仍在世界(`bossRaid` / `partyContest`)与 `actions/start_party.ts` 的
   * `PartyRecord` 里。这里的每一格都由下面那几个方法从真值搬运而来。
   */

  /** 累计投影过的 boss 实体帧数(证明 `upsertBoss` 每帧真的被调)。 */
  bossProjectionCount = 0;

  /** 世界总线订阅是否已接上(幂等;`close()` 会退订)。 */
  private worldBusAttached = false;

  /** 总线订阅的退订函数(`close()` 调;`EventBus.on` 返回它)。 */
  private worldBusOff: (() => void) | null = null;

  /** 从世界总线收到的播报(**未下发**的积压;`drainPartyBroadcasts()` 取走)。 */
  private partyBroadcastOutbox: { kind: string; text: string; atTick: number }[] = [];

  /** 累计收到的播报条数(含已取走的)。 */
  partyBroadcastTotal = 0;

  /** `START_PARTY` 真的建出记账并开出赛局的次数 / 世界开局后补建记账的次数。 */
  partyRecordStartCount = 0;
  partyRecordAdoptCount = 0;
  /** 建账失败/跳过的次数(模式键是契约外取值等),显式计数而不是静默。 */
  partyRecordSkips = 0;
  /** `endParty` 被真调用(赛局收束)的次数。 */
  partyRecordEndCount = 0;

  /** 世界开局 → 记账的锁:同一局只补建一次(键 = 模式键 + 裁判;世界回 IDLE 即释放)。 */
  private partyRecordLatch: string | null = null;

  /** 回执里已经送过的数据指纹(播报条数 / 结算 / 急单评级),避免每帧重复塞。 */
  private receiptSeenBroadcast = 0;
  private receiptSeenSettlement = '';
  private receiptSeenRush = '';
  /**
   * 本房**签名私钥**(32 字节随机)。从不离开服务端进程,也不进任何下行帧。
   *
   * ## 为什么"每房一把"而不是全局一把
   * 换房即换钥 ⇒ 泄漏一把只影响一个房间;而且 A 房的凭证在 B 房**签名就对不上**
   * ⇒ 跨房重放被两层同时挡住(还有 `claims.roomId` 那一层,见 `verifyRoomToken`)。
   * 注:不落库 —— 进程重启后旧凭证失效,重连需要重新签发(如实记为已知边界)。
   */
  private readonly authSecret: string;
  /**
   * **签发方声明的房主凭证**:构造房间时为本房 `ownerId` 签一张。
   *
   * 它就是「房主由谁定」的答案 —— 由**装配层**(库里的 `rooms.owner_id`,
   * 或大厅/首个入房者那次签发)决定,而不是由客户端串决定。
   * 谁能出示这张凭证,谁就是 OWNER;出示不了的人带着 `?userId=u_owner`
   * 也只是一个叫 u_owner 的字符串(旧实现正是在这里形同虚设)。
   */
  readonly ownerToken: string;
  /** 是否强制加入凭证(见 `RoomRuntimeOptions.requireJoinToken`)。 */
  readonly requireJoinToken: boolean;
  /** 休眠/唤醒次数,便于断言。 */
  sleepCount = 0;
  wakeCount = 0;

  constructor(opts: RoomRuntimeOptions, db: DbLike | null = null) {
    this.id = opts.roomId;
    this.ownerId = opts.ownerId;
    this.clock = opts.clock;
    this.db = db;
    this.accessMode = opts.accessMode ?? AccessMode.PUBLIC;
    this.passwordHash = opts.passwordHash ?? null;
    this.maxPlayers = Math.min(16, Math.max(1, opts.maxPlayers ?? 16));
    this.state = createRoomState(this.id);
    this.ac = new AntiCheatRoom();
    this.lastActivityMs = this.clock.nowMs();
    /* ── 身份鉴权(审计 P0-1):私钥 + 强制开关 + 房主凭证 ──
       顺序有要求:`authSecret` 必须先于 `ownerToken`(后者要签名),
       而两者都必须在 `this.id` / `this.clock` 之后(载荷里要 roomId 与过期时刻)。 */
    this.requireJoinToken = opts.requireJoinToken ?? false;
    this.authSecret = randomBytes(32).toString('hex');
    this.ownerToken = this.issueJoinToken(this.ownerId);
    /* 世界源从构造参注入(见 `RoomRuntimeOptions.host` 的长注释):
       缺省仍为 null,但**装配层现在有地方可传** —— 此前只能事后赋值,
       而生产里那个赋值一处都不存在。 */
    this.worldSaveHost = opts.host ?? null;
    /* ══════════ ★ 房间落库必须是**幂等**的(task-70 实测抓到)══════════
     *
     * ## 为什么原来的 `createRoom` 无条件调用是错的
     *
     * `createRoom` 对已存在的 id **抛异常**(`repo.ts:328`)。
     * 而本构造器在**每次**装配时都调它 ⇒
     * ```
     * 服务重启(DB 里已有 room_a)
     * ⇒ assemble() ⇒ new RoomRuntime(...) ⇒ createRoom 抛「房间已存在」
     * ⇒ **装配失败** ⇒ 根本走不到读档恢复那一步
     * ```
     * ⇒ 「冷启动读档」在**架构上**不可达 —— 本任务是 task-70,
     *   而它的名字就是冷启动。实测:
     * ```
     * new RoomRuntime(opts, db) 第一次 ⇒ OK
     * new RoomRuntime(opts, db) 第二次 ⇒ ★ 抛「房间已存在:room_a」
     * assemble({db}) 第二次           ⇒ ★ 同上
     * ```
     *
     * ## 判据:构造器的职责是「**确保**房间存在」,不是「**创建**房间」
     *
     * 与 `migrate` 同一语义:能重复执行。故**先查**:
     * ```
     * 已存在 ⇒ 什么都不做(保留库里的 name/accessMode 等 ——
     *                  那些可能在别处被改过,不该被本次装配的默认值盖回)
     * 不存在 ⇒ 按原逻辑创建
     * ```
     *
     * ## ⚠️ 为什么不改 `createRoom` 成 upsert
     *
     * 它那条守卫是**故意的**:能抓到「同一个房间被建两次」这类真错
     * (实测 `tests/WS-07` 有断言依赖它抛)。把守卫改成静默 upsert
     * 会让那个错误消失 —— 而错误消失不等于问题消失。
     * ⇒ 收敛在**调用点**修,不动被依赖的守卫。
     *
     * ## 幂等后仍可变的部分(刻意不覆盖)
     *
     * `ownerId` / `name` / `maxPlayers` / `worldSeed` / 密码
     * —— 库里的现值**优先**。理由:它们是**可运行时变更**的
     * (`setPartyMode`/`setRoomStatus` 已在做同类变更),
     * 而本次装配的参多数是 `?? 默认值`,用它覆盖会把用户的改动静默抹掉。
     */
    if (db && getRoom(db, opts.roomId) === undefined) {
      createRoom(db, {
        id: opts.roomId,
        ownerId: opts.ownerId,
        name: opts.name ?? opts.roomId,
        accessMode: this.accessMode,
        passwordHash: this.passwordHash,
        maxPlayers: this.maxPlayers,
        worldSeed: opts.worldSeed ?? 20261010,
        nowMs: this.clock.nowMs(),
      });
    }
  }

  /* ── 4.1 加入 / 重连 ── */

  /**
   * 加入房间。
   *  - **先认证**:凭 `token`(服务端签发,见 `signRoomToken`)确定身份,再谈策略。
   *  - 房间 SLEEPING → 自动唤醒(wake),并把世界帧号接续下去。
   *  - 同名成员处于断线宽限期内 → 走重连路径,返回**逐字节一致**的快照。
   *  - 密码房校验 `passwordHash`;满员拒绝。
   *
   * ## ★★★ 审计 P0-1:为什么认证必须**排在第一条**
   * 旧实现的判据只有 `input.userId === this.ownerId`,而 `input.userId`
   * 在运输层**由客户端串决定**(握手 URL 的 `?userId=`)⇒ 谁都能说自己是房主。
   * 修法不是把那一行改得更聪明,而是**让它左边的输入变成已认证的**:
   * ```
   * 网络边界(ws_server)⇒ 一律 requireToken: true
   * 重连               ⇒ 同一条校验(本方法只有这一个入口,重连走的是同一段)
   * 进程内直连          ⇒ 可信代码,默认不强制(见 RoomRuntimeOptions.requireJoinToken)
   * ```
   * ⚠️ 「缺 token」与「给了坏 token」**分开**:前者是没声明身份(可信路径可省),
   *   后者是伪造 —— 不论 `requireToken` 是什么都直接拒。
   */
  join(input: {
    userId: string;
    passwordHash?: string | null;
    asGuest?: boolean;
    /** 加入凭证(服务端签发)。运输层必填;进程内直连可省。 */
    token?: string;
    /** 强制校验凭证 —— 网络边界一律传 `true`(见 `ws_server.ts` 的 `onHello`)。 */
    requireToken?: boolean;
  }): JoinResult {
    const now = this.clock.nowMs();
    /* ── ① 身份认证(先于一切策略:连房间关没关都不该告诉未认证的人)── */
    if (input.requireToken === true || this.requireJoinToken || input.token !== undefined) {
      const verdict = this.verifyJoinToken(input.userId, input.token);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
    }
    if (this.status === RoomStatus.CLOSED) return { ok: false, reason: '房间已关闭' };

    if (this.accessMode === AccessMode.PASSWORD) {
      if (!input.passwordHash || input.passwordHash !== this.passwordHash) {
        return { ok: false, reason: '房间密码错误' };
      }
    }

    if (this.status === RoomStatus.SLEEPING) this.wake();

    /* 宽限期已过的掉线成员:席位已被回收,本次按「访客重进」对待 ——
     * 不恢复原角色(尤其不恢复 ADMIN),必须由房主重新授权。 */
    let demotedFromExpiry = false;
    const stale = this.members.get(input.userId);
    if (stale && !stale.connected) {
      const away = stale.disconnectedAtMs === null ? 0 : now - stale.disconnectedAtMs;
      if (away > RECONNECT_GRACE_MS) {
        demotedFromExpiry = true;
        /* ⚠️ 这一支**刻意不**并进 `purgeSeat()` —— 它必须自己把世界侧那一步
           写在**分支内**:`tests/WS-07.test.ts` 的 M8 用**代码态窗口**
           (从 `away > RECONNECT_GRACE_MS` 起 800 字符)钉住「超期分支必须调
           `removePlayer`」,而代码态窗口无法表达"间接调用"。
           ⇒ 与本分支逐字相同的四步,在 `leave()` / `reapExpiredDisconnects()`
           那两条路径上收敛到 `purgeSeat()`(见那里的注释:reap 修前漏了这一支)。
           三条路径的**行为一致**由 WS-FND-106 的 FND106-6 逐条钉住
           (它数的是 host 上真实发生的调用,不是源码文本)。
           ★ 旧注释(仍然成立):世界侧必须**一并**移除 —— 漏了它会让
           「宽限期超期重进」的玩家在模拟层里**留下旧刚体**,而随后 `addPlayer`
           又会 spawn 一次(位置 = 出生点)。 */
        this.members.delete(input.userId);
        this.state.players = this.state.players.filter((p) => p.id !== input.userId);
        this.ac.leave(input.userId);
        const hostStale = this.worldSaveHost;
        if (hostStale !== null && typeof hostStale.removePlayer === 'function') {
          hostStale.removePlayer(input.userId);
        }
      }
    }

    const existing = this.members.get(input.userId);
    if (existing) {
      /* ── 重连路径(仍在 30 秒宽限期内) ── */
      if (!existing.connected) {
        /* ★ 重连**不豁免**认证:上面那段 `verifyJoinToken` 是唯一的入口,
           所以「带 ?userId=u_owner 重连」和「首次加入冒充房主」是同一条路、同一个门。
           ★ P1-3(2026-11-19):**过期不等于被拒** —— 若该成员正处于断线宽限期,
           上面那次验签会把「过期」的起算点换成**断线时刻**(口径见
           `reconnectTokenGraceUntilMs`);否则会话一超过 5 分钟,宽限期内重连
           就**必然**被拒(修前的实测形态)。
           重连成功后再**换发**一张新凭证:房间侧顺手而已 —— 实测两个装配层
           调用点(`ws_server.ts:onHello` / `room.colyseus.ts:onJoin`)都**只读**
           `res.ok` / `res.resumed` / `res.snapshot`,**没有一处**把 `res.token`
           回给客户端 ⇒「手里那张老凭证还能不能用」只能由上面那条口径决定。 */
        const token = this.issueJoinToken(input.userId);
        existing.token = token;
        existing.connected = true;
        existing.disconnectedAtMs = null;
        existing.afkSinceMs = null;
        existing.lastSeenMs = now;
        this.touch(now);
        const snapshot = this.snapshotFor(input.userId);
        if (this.db) {
          saveReconnectSnapshot(this.db, this.id, input.userId, snapshot, now);
        }
        return { ok: true, role: existing.role, token, snapshot, resumed: true };
      }
      return { ok: false, reason: '该用户已在线' };
    }

    /* ★ WS-FND-131(P2):容量按「**活着**的席位」算 = 在线 + 仍在宽限期内的断线占位。
       修前第一句用的是 `members.size`(含**宽限期已过、只是还没被 reap 掉**的席位)
       ⇒ 全员断线的房间(SLEEPING)会对第一个新玩家误报「房间已满」。
       宽限期内的断线席位**继续占位**(他随时可能回来,那条席位必须给他留着);
       超期的不再占位 —— 它随后会被 `reapExpiredDisconnects()` 真正收掉。 */
    const liveSeats = [...this.members.values()].filter((m) => m.connected
      || (m.disconnectedAtMs !== null && now - m.disconnectedAtMs <= RECONNECT_GRACE_MS)).length;
    if (liveSeats >= this.maxPlayers) return { ok: false, reason: '房间已满' };
    /* 人数上限按「当前在线」算,断线占位不计(与上面那句**不重复**:它管总数,这句管在线)。 */
    const online = [...this.members.values()].filter((m) => m.connected).length;
    if (online >= this.maxPlayers) return { ok: false, reason: '房间已满' };

    /* ── 角色:房主恒为 OWNER;宽限期超期重进的旧管理员降为 GUEST,必须重新授权 ──
     *
     * ## ★ 审计 P0-1:这一行**不是**鉴别器,它是**授权映射**
     * ```
     * 谁能出现在 `input.userId` 里 ← 由上面的 verifyJoinToken 决定(边界 + 凭证)
     * 出现了之后是 OWNER 还是 MEMBER ← 由这一行按 this.ownerId(服务端声明)决定
     * ```
     * 旧缺陷的成因不是这一行写错,而是**它左边的输入可以随便写**。
     * 现在网络路径上 `input.userId` 必须与凭证的 `claims.userId` 逐字相等
     * ( `verifyRoomToken` 的「与声明的 userId 不符」),⇒ 带 `?userId=u_owner`
     * 而拿不出 u_owner 的凭证 ⇒ 在**上一段就返回**了,走不到这里。
     * ⚠️ 故这条 OWNER 分支的正确性依赖「认证在前」—— 谁把认证挪到下面,谁就把它变回缺陷。 */
    const role: RoomRole = input.userId === this.ownerId
      ? RoomRole.OWNER
      : (input.asGuest || demotedFromExpiry) ? RoomRole.GUEST : RoomRole.MEMBER;

    const token = this.issueJoinToken(input.userId);
    const session: MemberSession = {
      userId: input.userId,
      role,
      token,
      connected: true,
      disconnectedAtMs: null,
      afkSinceMs: null,
      joinedAtMs: now,
      lastSeenMs: now,
    };
    /* ══ ★ WS-FND-131(P1 加入侧非原子)════════════════════════════════════
       ## 修前形态(实测可复现)
       ```
       members.set → state.players.push → host.addPlayer
                   → restoreFromSnapshot(可抛) → encodeFull(可抛)   ← 调用方无 try/catch
       ```
       中途抛会**同时**发生三件事,而它不报给任何人:
         1 `members` 里留下一条 `connected=true` 的**幽灵席位**;
         2 `c.userId` 还没写回去 ⇒ 装配层的 close/leave 都**不知道该清谁**;
         3 `reapExpiredDisconnects` 只收 `connected=false` ⇒ 这条席位**永不过期**
           ⇒ 该 id **永久占 maxPlayers**。

       ## 现在的契约:整段是**一件事**
       任何一步抛 ⇒ `rollbackJoin()` 把房间侧与世界侧**逐项还原**
       (有旧实体行就放回去,没有就删干净),返回 `ok:false` 并带上回滚结果。
       调用方拿到的永远是「完整成功」或「一行痕迹都不留」。

       ## 三方交叉校验(成功路径上再核一次)
       `auditJoin()` 核「成员表 / 权威 state / 世界」三者是否同时认这个人
       (`lastJoinAudit` 留证);`members` 或 `state` 任一不一致就按**失败**回滚。
       `world` 有 `ok`/`missing`/`unknown` 三态 —— 没有 `playerPosition` 读口的
       世界源**不谎报**成 ok(与 `lastSaveReport` 同一纪律)。 */
    const prevPlayerRow = this.state.players.find((p) => p.id === input.userId) ?? null;
    let worldAdded = false;
    try {
      this.members.set(input.userId, session);

      /* 玩家实体进场:同位置已有玩家则做最小偏移,避免叠在一起。 */
      if (!this.state.players.some((p) => p.id === input.userId)) {
        const spawn = this.spawnPoint();
        this.state.players.push(createPlayerState(input.userId, {
          name: input.userId,
          x: spawn.x, y: spawn.y, z: 0,
        }));
      }
      /* 反作弊状态以**实际出生坐标**播种,否则会把出生点位移误判成瞬移。 */
      const body = this.state.players.find((p) => p.id === input.userId);

      /* ★ 把玩家登记进**世界**(task-58):`sim.addPlayer` 此前生产调用者为 0,
         于是模拟层不知道有这个玩家 ⇒ `applyPlayerMove` 静默无效,
         距离开闸读刚体 ⇒ 永久 `OUT_OF_AOI`。
         ⚠️ 用**同一个** `body.x/y` 播种,保证反作弊与刚体**同源** ——
         两者不同会让第一次移动被判瞬移(实测差 13.649 格)。
         没有世界时整段跳过(与 `saveToDb`/`levelOf` 同一 null 契约)。 */
      const host = this.worldSaveHost;
      if (host !== null && typeof host.addPlayer === 'function') {
        host.addPlayer(input.userId, body?.x ?? 0, body?.y ?? 0);
        /* ★ WS-FND-131:只有**真的**登记成功才记 —— 回滚时据此决定要不要
           世界侧移除(否则会把「本来就在世界里的人」误踢掉)。 */
        worldAdded = true;
      }

      /* ★★ 读档恢复(task-70 / 契约 §4.1)。**必须在 `ac.join` 之前** ——
       * 反作弊要用**恢复后**的实际坐标播种。
       *
       * ## 顺序:**登记 → 读档 → 反作弊播种 → 落库**
       *
       * `addPlayer` 必须在读档**之前**:`restoreFromProfile` 内部要
       * `applyPlayerMove` 与 `importVitals`,两者对未登记的玩家都是静默 no-op。
       * (与契约 §4.1.1 同一条,理由不同:blob 路要的是「刚体/生命已存在」。)
       *
       * ## 为什么失败时**不报错、只不恢复**
       *
       * 与 `saveToDb`/`levelOf` 同一 null 契约:没有 db、没有存档
       * 都是**正常**情况(首次进入),不是错误。
       * ⚠️ 但**不静默**:返回值与错误分别记在 `restoreApplied` / `restoreError`,
       * 测试可读 ⇒ 让「恢复无效」与「没有存档」可区分(陷阱 89)。 */
      let restoredPose: { x: number; y: number } | null = null;
      if (host !== null && typeof host.restoreFromProfile === 'function' && this.db) {
        restoredPose = this.restoreFromSnapshot(host, input.userId);
        if (restoredPose !== null) session.restoredFrom = restoredPose;
      }

      /* 反作弊播种:优先用**恢复后**的实际权威坐标;没有存档则用出生点。
         ⚠️ 不用 blob 里的坐标 —— 刚体可能因碰撞被推开,
            两者不同会被判瞬移(实测差 13.649 格)。 */
      this.ac.join(
        input.userId,
        this.state.meta.tick,
        restoredPose?.x ?? body?.x ?? 0,
        restoredPose?.y ?? body?.y ?? 0,
        body?.z ?? 0,
      );

      /* ★★ 恢复后**立刻投影一次**(task-70 实测抓到的一环)。
       *
       * ## 为什么不能等到下一帧的 `step()`
       *
       * `step()` 里的 `projectAllPlayers()` 是常规投影点,但它最早也要**50ms 后**
       * 才跑。而本方法下面那行 `encodeFull(this.state, ...)` 会把
       * **当前**投影编成 join 的初始快照**发给客户端**:
       * ```
       * 不立刻投影 ⇒ 客户端收到的首帧是 level=1 / hp=100 / maxHp=100
       *            ⇒ HUD 先显示 1 级 100 血,50ms 后才跳成 30 级 535 血
       * ```
       * ⇒ 实测确认:`join` 后、`step` 前读 `state.players[].maxHp` 得 **100**,
       *   `step` 后得 535 —— 中间那一帧的错**真的存在**。
       *
       * ## 为什么这不是"第二处投影"(不违反 §4.3 单一写者)
       *
       * 调的**就是** `projectAllPlayers()`,同一个唯一写者,没有第二份实现。
       * ⇒ 「唯一写者」约束的是**谁写 state**,不是**何时写**。
       *   在这里调只是把**本该在下一帧发生的同一次投影**提前到发快照之前。
       *
       * ⚠️ 必须先于 `ac.join` 吗?**不必** —— 反作弊读的是刚体(`playerPosition`),
       *   而投影只写 `state`。两件事互不依赖,故顺序无关;
       *   放在 `ac.join` 之后是为了让「反作弊播种」与「读档」贴在一起更好读。 */
      if (restoredPose !== null) this.projectAllPlayers();

      this.touch(now);

      const snapshot = encodeFull(this.state, this.state.meta.tick).bytes;
      if (this.db) {
        upsertRoomPlayer(this.db, this.id, input.userId, role, now, snapshot);
      }

      /* ★ WS-FND-131:三方交叉校验(见上面那段契约说明)。 */
      const audit = this.auditJoin(input.userId);
      this.lastJoinAudit = { userId: input.userId, ...audit };
      if (!audit.members || !audit.state) {
        /* 房间侧两方自己都不一致 ⇒ 这次入场**没成** ⇒ 按失败回滚,
           不留「连带状态的幽灵席位」。 */
        throw new Error(
          `入场后三方不一致(members=${audit.members} state=${audit.state} world=${audit.world})`,
        );
      }
      return { ok: true, role, token, snapshot, resumed: false };
    } catch (e) {
      const rb = this.rollbackJoin(input.userId, prevPlayerRow, worldAdded);
      const why = (e as Error).message.slice(0, 120);
      return {
        ok: false,
        reason: `加入失败(已回滚:world=${rb.world}${rb.restoredRow ? ',旧实体行已还原' : ''}):${why}`,
      };
    }
  }

  /**
   * ★ WS-FND-131(P1):**三方交叉校验** —— 一次入场之后,「成员表 / 权威 state /
   * 世界」三者必须同时认这个人。
   *
   * ## 为什么是三方,而不是「看 `members` 就够了」
   * 修前的缺陷恰恰是**只看其中一方**就会得出\"入场成功\":`members` 有、`state`
   * 有一行,而世界侧 `addPlayer` 若静默 no-op(宿主没有该方法),玩家在模拟层
   * 不存在 ⇒ 每条移动都 `allowed:false`。反过来,世界有刚体而 `members` 没有
   * 就是那条**永久占位**的幽灵席位。
   *
   * ## `world` 的三态
   * ```
   * ok      宿主有 playerPosition 且查得到 ⇒ 世界真的认这个人
   * missing 宿主有 playerPosition 但查不到 ⇒ 世界侧没登记(缺陷信号)
   * unknown 宿主没有 playerPosition 读口 ⇒ **不知道**,不冒充 ok
   * ```
   * `unknown` 不是失败:那是「结构上读不到」,与 `WS-FND-12` 的 host 三态同族。
   */
  private auditJoin(userId: string): {
    members: boolean;
    state: boolean;
    world: 'ok' | 'missing' | 'unknown';
  } {
    const members = this.members.get(userId)?.connected === true;
    const state = this.state.players.some((p) => p.id === userId);
    const host = this.worldSaveHost;
    let world: 'ok' | 'missing' | 'unknown' = 'unknown';
    if (host !== null && typeof host.playerPosition === 'function') {
      try {
        world = host.playerPosition(userId) !== null ? 'ok' : 'missing';
      } catch {
        world = 'unknown';
      }
    }
    return { members, state, world };
  }

  /**
   * ★ WS-FND-131(P1):入场失败时的**回滚**。返回可读的回滚结果(进 `reason`)。
   *
   * 三件事,一件都不能少:
   * ```
   * 1 房间侧痕迹走 `clearSeatTraces()`(members / state.players / 反作弊)——
   *   它是**唯一**一处做这三步的地方,回滚不另写一份;
   * 2 旧实体行若在入场前就存在,放回去(而不是\"反正删了\");
   * 3 世界侧**只在真的 `addPlayer` 过**时才移除(`worldAdded`)——
   *   否则会把「本来就在世界里的人」误踢掉。
   * ```
   */
  private rollbackJoin(
    userId: string,
    prevPlayerRow: PlayerState | null,
    worldAdded: boolean,
  ): { world: 'skipped' | 'removed' | 'pending'; restoredRow: boolean } {
    this.clearSeatTraces(userId);
    let restoredRow = false;
    if (prevPlayerRow !== null && !this.state.players.some((p) => p.id === userId)) {
      this.state.players.push(prevPlayerRow);
      restoredRow = true;
    }
    if (!worldAdded) return { world: 'skipped', restoredRow };
    const removed = this.removeFromWorld(userId);
    return { world: removed ? 'removed' : 'pending', restoredRow };
  }

  /**
   * ★ WS-FND-131:这个 id 现在是否**真的**在房间里(成员表里有且 connected)。
   *
   * 装配层用它做**第四方**核对:`runtime.join()` 说 ok 而这里说 false
   * 就是「幽灵席位/被回滚」的现场 —— 那时必须出声拒绝连接,而不是让一个
   * 「连着但不在房里」的客户端继续发报文(见 `room.colyseus.ts` 的 onJoin)。
   */
  isSeated(userId: string): boolean {
    return this.members.get(userId)?.connected === true;
  }

  /** 幂等唤醒:SLEEPING → OPEN。 */
  wake(): boolean {
    if (this.status !== RoomStatus.SLEEPING) return false;
    this.status = RoomStatus.OPEN;
    this.wakeCount += 1;
    this.touch(this.clock.nowMs());
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.OPEN, this.clock.nowMs());
    return true;
  }

  /** 进入休眠:状态落盘、成员保留、世界帧号冻结。 */
  sleep(): boolean {
    if (this.status !== RoomStatus.OPEN) return false;
    this.status = RoomStatus.SLEEPING;
    this.sleepCount += 1;
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.SLEEPING, this.clock.nowMs());
    return true;
  }

  close(): boolean {
    if (this.status === RoomStatus.CLOSED) return false;
    this.status = RoomStatus.CLOSED;
    /* ★ WS-FND-123:退订世界总线 —— 房间关闭后世界可能还活着(装配层可能复用
       host),留着订阅会让播报继续堆进一个已关闭房间的 outbox(纯泄漏)。 */
    if (this.worldBusOff !== null) {
      this.worldBusOff();
      this.worldBusOff = null;
    }
    this.worldBusAttached = false;
    if (this.db) setRoomStatus(this.db, this.id, RoomStatus.CLOSED, this.clock.nowMs());
    return true;
  }

  /**
   * ★ P1-2(2026-11-19):把一名成员的**四处痕迹**一次性摘干净。
   *
   * ## 缺陷形态(修前)
   * 「成员被移除」在房间里是**三条**路径,要做的动作**完全相同**:
   * ```
   * leave()                     主动退房 / 被踢 / 房主关房      —— 4 步齐全
   * join() 宽限超期重进(同名重进) 同一个人换了身份回来            —— 4 步齐全
   * reapExpiredDisconnects()    宽限期到了、房间自己回收         —— ★ 只有 3 步
   * ```
   * 第三条只删了 `members` / `state.players` / `ac` 三处,**没调
   * `host.removePlayer`** ⇒ 超期者的刚体与 `playerIds` 留在模拟层里;
   * 而它随后重新入场会再 `addPlayer` 一次 ⇒ 世界里同一个 id **两份刚体**
   * (位置被悄悄拉回出生点、上一轮的进度/生命值被继承 —— 与 `removePlayer`
   * 注释里记的是同一族症状)。
   * ⚠️ 三条路径分头写时**漏一步不会有任何报错**:前三步照样成功,
   *   「`state.players` 少了一个」的断言照样绿 ⇒ 这类缺陷只能靠
   *   「收敛成一处」消灭,靠"下次仔细点"消灭不掉。
   *
   * ## 谁在用(2/3 条路径,第 3 条是**刻意的例外**)
   * ```
   * leave()                    → 调本方法
   * reapExpiredDisconnects()   → 调本方法   ← ★ 修前就是这条漏了世界侧
   * join() 的宽限超期分支       → **不调**(自己在分支内写那四步)
   * ```
   * 例外的理由**不是设计取舍,而是一条外部约束**(逐字记在这里,免得下一个人
   * 以为它是漏改):`tests/WS-07.test.ts` 的 M8 用**代码态窗口**钉住
   * 「超期分支必须调 `removePlayer`」—— 它从 `away > RECONNECT_GRACE_MS`
   * 起取 800 字符,要求窗口里出现 `removePlayer`。代码态窗口**无法表达
   * 「间接调用」**,把那一支折进本方法会当场让 M8 变红(实测)。
   * ⇒ 三条路径的**行为一致**由行为级判据兜住:`tests/WS-FND-106-...` 的
   *   FND106-6(数 host 上真实发生的调用)+ FND106-8(数调用点数量)。
   */
  private purgeSeat(userId: string): void {
    /* ★ WS-FND-131(P2):修前世界侧(`host.removePlayer`)排在**最后**且没有
       try — 它一抛就整条 `leave()` 被吞,而 `members` 已删 ⇒ **没有重试点**
       (席位没了、刚体/AOI/vitals 还在,同名重进会在世界里叠出第二份刚体)。
       现在:房间侧痕迹与**可重试**的世界侧移除各走各的,任一侧失败都留证据。 */
    this.clearSeatTraces(userId);
    this.removeFromWorld(userId);
  }

  /**
   * ★ WS-FND-131:席位在**房间侧**的痕迹(`members` / `state.players` / 反作弊)。
   *
   * 反作弊那一步单独 try:它失败**不该**阻断席位与实体的回收(否则又回到
   * 「一步抛 ⇒ 整条路径没做完」的老形态),但要留下 `lastRemoveError`。
   */
  private clearSeatTraces(userId: string): void {
    this.members.delete(userId);
    this.state.players = this.state.players.filter((p) => p.id !== userId);
    try {
      this.ac.leave(userId);
    } catch (e) {
      this.lastRemoveError = `反作弊回收失败(${userId}):${(e as Error).message.slice(0, 80)}`;
    }
  }

  /**
   * ★ WS-FND-131(P2):世界侧移除的**唯一实现** —— 一次立即重试 + 待重试队列。
   *
   * ## 为什么要有它(修前形态)
   * ```
   * purgeSeat 最后才调 host.removePlayer,抛则:
   *   房间侧前 3 步已经做完(席位已删)⇒ 没有任何一处还会再调它
   *   世界侧刚体 / AOI / vitals / 玩法表**留着** ⇒ 同名重进 = 同一 id 两份刚体
   * ```
   * ⇒ 两件事都要:①**重试**(同一处最多 2 次);②失败**入队**
   *   (`pendingWorldRemovals`),由 `retryPendingWorldRemovals()` 在下一帧再试 ——
   *   这样「世界侧抛错」不再是终态,而是一个**可观测量 + 可重试点**。
   *
   * ## 可观测量
   * `lastRemoveApplied`:`true` = 这次移除世界侧**确实**成功(或本来就没世界源);
   * `false` = 两次都抛 ⇒ 已入队待重试。`lastRemoveError` 记最后一次的错因。
   */
  private removeFromWorld(userId: string): boolean {
    const host = this.worldSaveHost;
    if (host === null || typeof host.removePlayer !== 'function') {
      /* 没有世界源 ⇒ 没有「世界侧残留」这件事,如实算成功(与 saveToDb 同一 null 契约)。 */
      this.pendingWorldRemovals.delete(userId);
      this.lastRemoveApplied = true;
      this.lastRemoveError = null;
      return true;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        host.removePlayer(userId);
        this.pendingWorldRemovals.delete(userId);
        this.lastRemoveApplied = true;
        this.lastRemoveError = null;
        return true;
      } catch (e) {
        this.lastRemoveError =
          `世界侧移除失败(${userId},第 ${attempt + 1} 次):${(e as Error).message.slice(0, 80)}`;
      }
    }
    this.pendingWorldRemovals.add(userId);
    this.lastRemoveApplied = false;
    return false;
  }

  /**
   * 重试所有「世界侧移除失败」的 id。返回本轮真的移除成功的 id 列表。
   *
   * 调用点:`step()` 的**最顶部**(早于 status 早退)⇒ 休眠房里也会推进;
   * 队列为空时是 O(1) 早退。
   */
  retryPendingWorldRemovals(): string[] {
    if (this.pendingWorldRemovals.size === 0) return [];
    const done: string[] = [];
    for (const userId of [...this.pendingWorldRemovals]) {
      if (this.removeFromWorld(userId)) done.push(userId);
    }
    return done;
  }

  /** 主动离开(非掉线):立刻回收席位与快照。 */
  leave(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s) return false;
    this.purgeSeat(userId);
    if (s.role === RoomRole.OWNER && this.members.size > 0) {
      /* 房主走了:把 OWNER 传给最早的在线 ADMIN/MEMBER。 */
      const next = [...this.members.values()]
        .filter((m) => m.connected)
        .sort((a, b) => a.joinedAtMs - b.joinedAtMs)[0];
      if (next) next.role = RoomRole.ADMIN;
    }
    this.touch(this.clock.nowMs());
    return true;
  }

  /** 掉线:保留席位与快照,记 `disconnectedAtMs`。 */
  disconnect(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s || !s.connected) return false;
    const now = this.clock.nowMs();
    s.connected = false;
    s.token = null;
    s.disconnectedAtMs = now;
    const snapshot = this.snapshotFor(userId);
    if (this.db) saveReconnectSnapshot(this.db, this.id, userId, snapshot, now);
    this.touch(now);
    return true;
  }

  /** 心跳:刷新 lastSeen。 */
  heartbeat(userId: string): boolean {
    const s = this.members.get(userId);
    if (!s) return false;
    s.lastSeenMs = this.clock.nowMs();
    s.connected = true;
    s.disconnectedAtMs = null;
    this.touch(s.lastSeenMs);
    return true;
  }

  /**
   * 把超出宽限期的掉线成员真正移除(在 `tick()` 里驱动)。
   * 返回被清理的 userId 列表。
   */
  reapExpiredDisconnects(): string[] {
    const now = this.clock.nowMs();
    const gone: string[] = [];
    for (const m of [...this.members.values()]) {
      if (m.connected || m.disconnectedAtMs === null) continue;
      if (now - m.disconnectedAtMs > RECONNECT_GRACE_MS) {
        /* ★ P1-2:与 `leave()` / `join()` 走**同一个** `purgeSeat()` ——
           修前这里少了世界侧那一步(见 `purgeSeat` 的注释)。 */
        this.purgeSeat(m.userId);
        gone.push(m.userId);
      }
    }
    if (gone.length > 0) this.touch(now);
    return gone;
  }

  /* ── 4.2 权限门 ── */

  /** 权限裁决。越权返回 false 且**不产生副作用**。 */
  authorize(userId: string, action: RoomAction): { allowed: boolean; reason?: string; role?: RoomRole } {
    const m = this.members.get(userId);
    if (!m || !m.connected) return { allowed: false, reason: '不在房间内' };
    const role = m.role;
    if (!can(role, action)) {
      return { allowed: false, reason: `角色 ${role} 无权执行 ${action}`, role };
    }
    return { allowed: true, role };
  }

  setMemberRole(actorId: string, targetId: string, role: RoomRole): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.SET_MEMBER_ROLE);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    const target = this.members.get(targetId);
    if (!target) return { ok: false, reason: '目标不在房间内' };
    if (targetId === this.ownerId) return { ok: false, reason: '不能改房主角色' };
    if (role === RoomRole.OWNER) return { ok: false, reason: '不能把他人提升为房主' };
    /* ADMIN 不能互相降级,防止管理权互斗。 */
    if (gate.role === RoomRole.ADMIN && target.role === RoomRole.ADMIN) {
      return { ok: false, reason: 'ADMIN 不能修改其它 ADMIN' };
    }
    target.role = role;
    this.touch(this.clock.nowMs());
    if (this.db) upsertRoomPlayer(this.db, this.id, targetId, role, this.clock.nowMs());
    return { ok: true };
  }

  kick(actorId: string, targetId: string): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.KICK_MEMBER);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    if (targetId === this.ownerId) return { ok: false, reason: '不能踢出房主' };
    const target = this.members.get(targetId);
    if (!target) return { ok: false, reason: '目标不在房间内' };
    if (gate.role === RoomRole.ADMIN && target.role === RoomRole.ADMIN) {
      return { ok: false, reason: 'ADMIN 不能踢出 ADMIN' };
    }
    this.leave(targetId);
    return { ok: true };
  }

  setAccess(actorId: string, mode: AccessMode, passwordHash: string | null): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.SET_ROOM_ACCESS);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    if (mode === AccessMode.PASSWORD && !passwordHash) {
      return { ok: false, reason: '密码房必须提供 hash' };
    }
    if (mode === AccessMode.PUBLIC && passwordHash) {
      return { ok: false, reason: '公开房不得带密码' };
    }
    this.accessMode = mode;
    this.passwordHash = passwordHash;
    this.touch(this.clock.nowMs());
    return { ok: true };
  }

  setPartyModeBy(actorId: string, mode: PartyMode): { ok: boolean; reason?: string } {
    const gate = this.authorize(actorId, RoomAction.SET_PARTY_MODE);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    /* ★ 单一存储:只写线快照的枚举下标(值表顺序 = `Object.values(PartyMode)`,
       `get partyMode()` 用同一张表还原)。修前这里还并写 `this.partyMode = mode`,
       于是同一事实有两份状态、其中一份没有生产读者(见 partyMode 的 docblock)。 */
    this.state.meta.partyMode = Object.values(PartyMode).indexOf(mode);
    /* ★ 第六轮:选完模式**立刻**把 HUD 三字段对齐一次(不等下一帧)——
       否则 `SET_PARTY_MODE` 与「下一帧 step」之间,客户端会看到「已选模式但
       计时/比分还是全 0」的一帧。没有赛局记录时 `syncPartyHud` 如实写 0。 */
    this.syncPartyHud();
    this.touch(this.clock.nowMs());
    if (this.db) setPartyMode(this.db, this.id, mode, this.clock.nowMs());
    return { ok: true };
  }

  /**
   * 派对 HUD 的**唯一写口**:`state.meta.partyTimer` / `scoreA` / `scoreB`。
   *
   * ## 为什么需要它(第六轮 P1:「有字段、无写点」)
   * `shared/types/wire.ts` 的 `ROOM_FIELD_TABLE` bit 2..4 声明了这三个字段,
   * 客户端 `client/src/ui/party_hud.ts` 也在读(`partyHudOf`,经
   * `three/ui_binding.ts` 画到 HUD 上)—— 但**生产侧一个写点都没有**:
   * 实测它们只出现在 `schema.ts` / `schema.colyseus.ts` 的默认值里。
   * ⇒ 表现是「派对在跑,客户端恒显示 剩余 0s / 红 0 : 0 蓝」,而这**不报错**。
   *
   * ## 两个数字各自的**已有**权威(不新造第三份状态)
   * ```
   * 计时:`actions/start_party.ts` 的房间赛局记录 `startedAtMs` + 模式总时长
   *       (时长取 `shared/constants/bosses.ts::PARTY_MODES` —— `party/modes.ts`
   *        建运行时用的也是这张表,故两边同源)
   * 比分:同一份记录的 `scores`(按玩家 id),队伍归属问世界 `partyTeamOf`
   * ```
   * ⚠️ 房间**不**自己跑一份对局时钟:那是第二份真值,两份迟早不同步。
   *
   * ## 四个分支都**如实写 0**(不是缺失静默)
   * 1 房间没有赛局记录(`START_PARTY` 从没开过)⇒ 三个字段全 0;
   * 2 赛局已 `SETTLED` ⇒ 剩余秒数归 0(比分保留:名次已定格,清掉会让 HUD 闪成 0:0);
   * 3 世界没有 `partyTeamOf`(老宿主)⇒ 分不出红/蓝 ⇒ 比分 0,不按加入顺序编;
   * 4 模式不在 `PARTY_MODES`(契约外取值)⇒ 总时长 0 ⇒ 剩余 0。
   *
   * ## 幂等与代价
   * 只写**值有变化**的字段(与 `syncLevelProjections` 同一取舍):20Hz 每帧写一遍值
   * 本身不贵,但逐帧把同一个值写回快照会让差量编码器看见「每帧都变」——
   * 那是真的多余。故三个字段各自比较后赋值。
   */
  private syncPartyHud(): void {
    const snap = partyStateOf(this.id);
    let remainSec = 0;
    let scoreA = 0;
    let scoreB = 0;
    if (snap !== null) {
      const cfg = PARTY_MODES.find((m) => m.key === snap.mode);
      const totalSec = cfg === undefined ? 0 : cfg.buildSec + cfg.raceSec;
      if (snap.state === PartyPhase.RUNNING) {
        const elapsedSec = Math.max(0, (this.clock.nowMs() - snap.startedAtMs) / 1000);
        remainSec = Math.max(0, Math.round(totalSec - elapsedSec));
      }
      /* 队伍的权威在世界侧(435 旗)。没有这个读口 ⇒ 比分 0,不猜。 */
      const host = this.worldSaveHost;
      const teamOf = host === null ? undefined : host.partyTeamOf;
      if (teamOf !== undefined) {
        for (const [userId, score] of snap.scores) {
          const team = teamOf.call(host, userId);
          if (team === 'RED') scoreA += score;
          else if (team === 'BLUE') scoreB += score;
        }
      }
    }
    /* `partyTimer` 是 POS(i32×1024)载秒数、`scoreA/B` 是 U16 ⇒ 逐字段夹到值域内:
       负剩余(时钟回拨)与溢出都会让编码器写出垃圾,而那是静默的。 */
    const timer = Math.min(MAX_PARTY_TIMER_SEC, Math.max(0, remainSec));
    if (this.state.meta.partyTimer !== timer) this.state.meta.partyTimer = timer;
    const a = Math.min(65535, Math.max(0, Math.round(scoreA)));
    if (this.state.meta.scoreA !== a) this.state.meta.scoreA = a;
    const b = Math.min(65535, Math.max(0, Math.round(scoreB)));
    if (this.state.meta.scoreB !== b) this.state.meta.scoreB = b;
  }

  /* ── 4.4 动作分派(RoomAction 的**执行层**)── */

  /**
   * 把 `authorize()` 的「许可」变成「执行 + 回执」—— **查注册表**,把活交给该动作自己的模块。
   *
   * ## 结构(2026-11-15 拆分:一个动作一支处理器 + 一张表)
   *
   * ```
   * actions/action_table.ts 22 项归属表(`Record<RoomAction, ActionHandler>` ⇒ 编译期完整)
   * actions/admin.ts        SET_MEMBER_ROLE / KICK_MEMBER / SET_ROOM_ACCESS /
   *                         SET_PARTY_MODE / CLOSE_ROOM
   * actions/material.ts     PLACE_BLOCK / BREAK_BLOCK / DROP_ITEM / PICKUP_ITEM
   * actions/<action>.ts     其余 13 个各占一个模块(接线只改那一个文件 ⇒ 可并行)
   * ```
   * ⇒ 本方法只剩三步:**查表** → 没登记就 `NOT_IMPLEMENTED` → 调处理器。
   *   处理器拿到的是 `ActionContext`(见 `actions/types.ts`),**不是** `RoomRuntime`:
   *   它们碰不到私有态,也不会在这里长出第二份权限判定。
   *
   * ⚠️ 拆分是**纯重构**:回执的字面内容(`kind` / `reason` 文本 / `effect` 字段名)
   *   一个字节都没变 —— 那是 `tests/WS-07`(ACT 系列)/ `WS-FND-18` / `WS-FND-20` /
   *   `WS-FND-21` 钉着的东西。
   *
   * ## 此前的问题(实测,2026-11-14)—— 换结构不动这些结论
   *
   * `room.colyseus.ts` 的 `action` 报文 handler 原本只有一句:
   * ```
   * authorize(...) ⇒ !allowed ⇒ client.send('reject', ...)
   * ```
   * ⇒ `allowed === true` 时**零执行、零回执、零日志**(成功分支为空)。
   * 于是 22 个 `RoomAction` 长期处于「授权存在、执行不存在」的状态,
   * 而**失败是静默的** —— 玩家按了没反应,没有任何一处能看出原因。
   *
   * ## 为什么处理器**不**自己判权限(这是刻意的分工)
   *
   * 4 个管理动作的宿主方法(`setMemberRole` / `kick` / `setAccess` / `setPartyModeBy`)
   * **各自第一行就是 `authorize(...)`**。处理器若再判一次,就长出**第二份权限实现**
   * —— 本仓 1 号病根(陷阱 31/41)。⇒ 宿主方法自带闸的,直接调它,再把返回值翻译成回执。
   *
   * ⚠️ 唯一的例外是 `CLOSE_ROOM`:`close()` 是**生命周期方法**,还被 `onDispose` 与
   *   `reapEvictions` 调用 ⇒ 它**不能**自带权限闸,闸必须写在 `actions/admin.ts` 里。
   *   这个不对称是**刻意的**,不是遗漏。
   *
   * ## 未实现的动作**显式**返回 `NOT_IMPLEMENTED`
   *
   * 静默成功正是要消灭的东西。若对未实现的动作返回 `ok: true`,客户端会以为动作生效了,
   * **而门禁一条都红不了**(它只查「成功分支是否为空」)。⇒ 回 `ok: false` +
   * `kind: 'NOT_IMPLEMENTED'` ⇒ 它**可被断言**:「发 `PLACE_BLOCK` ⇒ 必须是 NOT_IMPLEMENTED」。
   * 将来谁把它接上,那条断言会**按设计变红**,提醒同时更新 `verify.ts` 的
   * `VERDICT_HANDLER_KNOWN` 登记。★ 本仓既有手法:把"未做项"钉成一条会红的断言,
   * 而不是留一句注释。
   */
  dispatchAction(actorId: string, action: RoomAction, payload: ActionPayload = {}): ActionOutcome {
    const handler = lookupActionHandler(action);
    /* 没登记 ⇒ 报文里是个**不存在的动作名**(`tests/WS-FND-21` FND21-3 发的就是
       `NO_SUCH_ACTION_NAME`)。理由文本与拆分前那个 `default:` 分支**逐字相同**
       (唯一出处:`actions/not-implemented.ts`)。 */
    if (handler === undefined) return notImplemented(action);
    const outcome = handler(this.actionContextFor(actorId, action, payload));
    /* ★ WS-FND-123(P1-2):记账建好之后,把**赛局**也开起来。
       `START_PARTY` 的处理器只写 `PartyRecord`,世界的 contest 必须由这条钩子开
       —— 否则账本在、比分永远是 0(`addScore` 有账可记但没有对局事件)。 */
    if (outcome.ok && action === RoomAction.START_PARTY) this.startWorldPartyRun(actorId);
    /* ★ WS-FND-131(P2):世界**换代** ⇒ 玩家睡眠登记一并换代。
       `actions/sleep.ts` 的 `SLEEPERS[roomId][playerId]` 原无世代维 ⇒ 重置世界后
       `beginSleep` 仍可能把**上一世代**的窗口原样返回(「刚上床就已睡了一半」)。
       换代点是**唯一**的:RESET_WORLD 成功这一刻(与 `startWorldPartyRun` 同一位置)。 */
    if (outcome.ok && action === RoomAction.RESET_WORLD) bumpSleepGeneration(this.id);
    /* ★ WS-FND-123(P1-4/P1-5):回执出口。只在**成功**回执上加新键,
       失败回执的形状一个字节都不动(既有断言不受影响)。 */
    return outcome.ok ? this.withPartyReceipt(outcome) : outcome;
  }

  /**
   * 为**一次**分派装配 `ActionContext`。
   *
   * ⚠️ 这里只**转交** `RoomRuntime` 已有的能力(绑定后的函数),不复制任何判定:
   *   `classifyFailure` / `materialsOf` / `hostPositionOf` 仍是 `private`,
   *   处理器拿不到 `this`,只能调下面列出的这些。
   *
   * ⚠️ `status` 必须是 **getter**:`CLOSE_ROOM` 的回执要在 `close()` **之后**读状态
   *   (`effect: { status: 'CLOSED' }`)。若在这里取一次快照值,回执会谎报 `OPEN`
   *   —— 那是**行为变化**,不是代码风格。
   */
  private actionContextFor(
    actorId: string,
    action: RoomAction,
    payload: ActionPayload,
  ): ActionContext {
    const rt = this;
    /* ★ `USE_ITEM` 的**按件**读口(见 `ItemReadPort` 的 docblock):
       两个绑定函数独立挂在上下文上,而不是给 `ActionContext` 接口加成员 ——
       `actions/types.ts` 是跨动作契约(另一条线在改),而读口只有这一个动作消费。
       用交叉类型交出:处理器侧 `Partial<ItemReadPort>` 窄化即可。 */
    const ctx: ActionContext & ItemReadPort = {
      actorId,
      action,
      payload,
      state: rt.state,
      host: rt.worldSaveHost,
      get status() { return rt.status; },
      authorize: (userId, a) => rt.authorize(userId, a),
      classifyFailure: (id, a, reason) => rt.classifyFailure(id, a, reason),
      materialsOf: () => rt.materialsOf(),
      hostPositionOf: (userId) => rt.hostPositionOf(userId),
      applyInventory: (userId, input) => rt.applyInventory(userId, input),
      grantItemSource: (userId, source) => rt.grantItemSource(userId, source),
      revokeItemSource: (userId, source) => rt.revokeItemSource(userId, source),
      setMemberRole: (id, targetId, role) => rt.setMemberRole(id, targetId, role),
      kick: (id, targetId) => rt.kick(id, targetId),
      setAccess: (id, mode, passwordHash) => rt.setAccess(id, mode, passwordHash),
      setPartyModeBy: (id, mode) => rt.setPartyModeBy(id, mode),
      close: () => rt.close(),
      itemCountOf: (userId, itemId) => rt.authoritativeItemCount(userId, itemId),
      itemIdsOf: (userId) => rt.authoritativeItemIds(userId),
    };
    return ctx;
  }

  /**
   * 失败**分类** —— 只在失败路径上问一次 `authorize()`,拿它的**结构化结果**分类。
   *
   * ⚠️ 这里**不许**改成"看 `reason` 字符串里有没有『无权』":
   *   那是本仓反复点名的形态 —— **判据取不到它该判的东西时就会退化成读文本**
   *   (`whitelistBreakdown` 的教训)。`authorize()` 本来就返回布尔,
   *   读它比读它生成的散文可靠。
   *
   * ⚠️ 也**不是**第二份权限实现:判定仍由宿主方法内的那次 `authorize()` 做,
   *   本方法只在它**已经拒绝之后**再问一次,用于分流 PERMISSION 与 INVALID。
   *   `authorize()` 的契约写明"越权返回 false 且**不产生副作用**"⇒ 重问是安全的。
   */
  private classifyFailure(actorId: string, action: RoomAction, reason: string | undefined): ActionOutcome {
    const gate = this.authorize(actorId, action);
    return { ok: false, kind: gate.allowed ? 'INVALID' : 'PERMISSION', reason };
  }

  /**
   * 世界源的**物质层**;没有世界源时返回 `null`。
   *
   * 为什么单开一个取法:四个物质动作都要它,而「拿不到」必须**显式**变成
   * 一条 `NOT_IMPLEMENTED` 回执 —— 不能写成 `?.` 之后静默跳过
   * (那正是本仓反复记的那类静默失效)。
   */
  private materialsOf(): ReturnType<WorldSaveHost['materials']> | null {
    const h = this.worldSaveHost;
    return h === null ? null : h.materials();
  }

  /**
   * 玩家的**权威位置**(`physics.bodies`);拿不到返回 `null`。
   *
   * `playerPosition` 是 `WorldSaveHost` 的**可选**成员(老世界源没有)⇒
   * 这里显式判 `typeof`,由调用方给出可读的拒绝理由。
   *
   * ⚠️ 丢东西 / 捡东西的落点**只认这里** —— 客户端报的坐标一律不采信
   * (否则玩家能把东西丢到地图另一头,或隔着半个世界捡东西)。
   *
   * ★ 本方法是这个读法的**唯一实现**:`applyMove` 里原来内联了一份同样的
   *   `typeof` 判断,已改为调它(同一读法两处各写一遍就是"两份实现"的起点)。
   */
  private hostPositionOf(userId: string): { x: number; y: number; z?: number } | null {
    const h = this.worldSaveHost;
    if (h === null || typeof h.playerPosition !== 'function') return null;
    return h.playerPosition(userId);
  }

  /* ── 4.3 反作弊转发 ── */

  /**
   * 移动报文 → 反作弊闸 → **写入世界**(task-58 接线)。
   *
   * ## 权威归属(与 `docs/AUTHORITY-MAP.md` 的 W2 同一形态)
   *
   * ```
   * physics.bodies            = **权威**(位置与速度的真值)
   * state.players[].x/y/z     = **只读投影**(网络下发用)
   * ```
   * 与 `level` 的处理**逐点同构**:`progresses.level` 权威,
   * `state.players[].level` 每帧由 `syncLevelProjections()` 单向投影。
   * ⇒ 位置是 W2「双写者」形态的**新实例**,不是新机制。
   *
   * ## 为什么必须**从权威读回**,而不是照抄客户端声明
   *
   * 接线前这里写的是 `p.x = intent.x`(照抄声明)。但那只是「玩家自己走」
   * 那一条路径;`physics.bodies` 还会被**击退/搬运**改(`applyImpulse` /
   * `carry.ts`),那些路径**不经过本方法**。
   * ⇒ 若照抄声明,击退后会出现:
   * ```
   * physics.bodies.x = 99(被击退的真实位置)
   * state.players.x  = 0.7(客户端仍声称自己在原地)
   * ⇒ 客户端以为自己在怪旁边,距离闸读权威说不在 ⇒ **永久 OUT_OF_AOI**
   * ```
   * ⇒ 读回让「击退/搬运对客户端可见」,并消除这条死锁。
   *
   * ## 反作弊只有**一处**判定
   *
   * `ac.move` → `checkMove` 是唯一判定点(上界、非有限值、窗口速率)。
   * `host.applyPlayerMove` **不做**第二次判定 —— 理由见
   * `WorldSim.applyPlayerMove` 的 docblock(不制造第二份等效实现;
   * 第二处还会掩盖第一处失效)。
   *
   * ## `host` 为空时退回旧行为
   *
   * 没有世界 ⇒ 无可读回的权威 ⇒ 照抄声明(与 `levelOf`/`saveToDb`
   * 同一 null 契约)。这不是「两份实现」:写入点始终只有这一处,
   * 分支判据是「有没有世界」。
   */
  applyMove(userId: string, intent: Omit<MoveIntent, 'playerId'>): Verdict {
    const v = this.ac.move({ ...intent, playerId: userId }, 3);
    if (!v.allowed) {
      if (v.violation) this.pendingViolations.push(v.violation);
      return v;
    }

    /* 1 先写进世界(权威)。没有世界则跳过 —— 不报错,不假装。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.applyPlayerMove === 'function') {
      host.applyPlayerMove(userId, intent.x, intent.y, intent.z);
    }

    /* ★ 1b WS-FND-122:**起跳**. 报文里的 `jump:true` 此前**没有消费者**
       (`parseMoveIntent` 直接丢字段,`jumpPlayer` 生产 0 调用)。
       判据(地面 / 冷却)在世界侧 `jumpPlayer` 的入口一处判 —— 房间只搬运意图,
       并把**结果**(含拒绝理由)记进 `lastJumpReport`:不记的话「按了空格没反应」
       与「空格没到」在断言里不可区分。
       ⚠️ 放在位置写入**之后**:起跳要在地面(`z === 0`),先写位置再判,
          语义才是「站在这一格起跳」。 */
    if (intent.jump === true) {
      this.lastJumpReport = this.applyJumpIntent(userId);
    }

    /* 2 再把**权威值**投影到 state。
       有世界就从权威读回(含击退/搬运的结果);没有世界就只有声明值可写。
       ★ z 也从权威读回(2026-11-16 接通):`applyPlayerMove` 已把 z 写进刚体,
       这里读回它 ⇒ 客户端声明的 z **不再是最终值**(与 x/y 同一口径)。
       `host.playerPosition` 的 `z` 是**可选**的(老世界源只回 x/y)⇒ 回退到声明值。 */
    const p = this.state.players.find((x) => x.id === userId);
    if (p) {
      const auth = this.hostPositionOf(userId);
      p.x = auth?.x ?? intent.x;
      p.y = auth?.y ?? intent.y;
      p.z = auth?.z ?? intent.z;
    }
    this.touch(this.clock.nowMs());
    return v;
  }

  /**
   * ★ WS-FND-122:把一条**起跳意图**交给世界侧,并把它回的形态**原样**记下。
   *
   * 为什么这一段单独抽出来(而不是三行 inline):
   * 「宿主没实现」这条分支必须有一句**可读的理由**(`NO_WORLD`),
   * 否则 `jumped:false` 会同时表示「跳不了」与「这条链没接」——
   * 正是本仓反复记的静默形态。
   */
  private applyJumpIntent(userId: string): JumpReport {
    const host = this.worldSaveHost;
    if (host === null || typeof host.tryPlayerJump !== 'function') {
      return { playerId: userId, jumped: false, reason: 'NO_WORLD', vz: null };
    }
    const out = host.tryPlayerJump(userId);
    return {
      playerId: userId,
      jumped: out.jumped === true,
      reason: out.reason ?? 'UNKNOWN',
      vz: out.vz ?? null,
    };
  }

  /**
   * 最近一次**起跳意图**的结果;`null` = 还没有带 `jump` 的移动报文。
   *
   * 与 `lastAttackReport` 同一取舍:`null` 让「没接线 / 没按空格」与
   * 「按了但被拒」在断言里可区分。
   */
  lastJumpReport: JumpReport | null = null;

  /**
   * 攻击报文 → 反作弊闸 → **模拟层结算**(US2/task-47 接线)。
   *
   * ## 接线前 vs 接线后(实测)
   *
   * 接线前 `applyAttack` 只做 `ac.attack` 并丢弃结果:
   * ```
   * room.ts:638-642  applyAttack → this.ac.attack(...) → pendingViolations.push → return v
   * ```
   * 实测:玩家的生物 hp 60 → 攻击一次 → **60**(`lastHits` 长度 0、`hitCount` 0)。
   * 即「按攻击键什么都不发生」。
   *
   * ## 协议设计(为什么是 `mobId` 而不是坐标/最近敌人)
   *
   * 报文携带**意图**:打**哪一只**(`mobId`)。
   * - 客户端**不传**坐标:位置权威在 `physics.bodies`,由 `applyMove`
   *    **经 `host.applyPlayerMove` 写入**(task-58 起为真)。
   *    ⚠️ 本句此前写「由 `applyMove` 写入」而当时**并没有**这条写路径
   *    (全仓写 `physics.bodies` 的位置:**0 处**)—— 注释说的是**方向**,
   *    不是**事实**。task-58 补齐了写入,本句才成为对事实的陈述。
   *   若让客户端传目标坐标,等于把「我在哪」这个判据交回客户端。
   * - 客户端**不传** `level` / `wearing` / `weaponId` / `comboMul`:
   *   这些是面板数据,一律由模拟层从权威档案派生
   *   (`attackMobAuthorized` 的签名里根本没有它们)。
   * - 服务端**不信任** `mobId` 本身 —— 它只是「我想打这只」,
   *   能否打到由两道闸决定(AOI 活跃区 + 武器 `reach`)。
   *
   * ⇒ 客户端的自由度只剩「选择目标」,而**目标的合法性与可达性全在服务端**。
   * 这是 CR-14 U1/U2 那族纪律在网络入口上的兑现。
   *
   * ★ WS-FND-122:**`useSkill`(按了 Q)是报文里唯一的第二个意图位**。
   *   它只表达「我按了 Q」,技能定义/倍率/段数一律由模拟层从**当前武器**取
   *   (`skillOf` / `planSkillHits`)—— 与上面「不传面板数据」同一条纪律。
   *   没有技能可放 ⇒ 世界侧回 `rejected:'NO_SKILL'`,回执照实带上,**零副作用**。
   *
   * @param mobId 客户端指定的目标;缺省/非法时按「无目标」处理(不结算)。
   * @param useSkill `true` = 本次是 `[Q]` 技;只接受字面 `true`(运输层已收窄)。
   */
  applyAttack(userId: string, claimedBonus = 0, mobId?: string, useSkill = false): Verdict {
    const v = this.ac.attack(userId, this.state.meta.tick, claimedBonus);
    if (v.violation) this.pendingViolations.push(v.violation);
    if (!v.allowed) {
      this.lastAttackReport = null;
      return v;
    }

    /* 反作弊放行后才结算。没有世界 / 没有目标 ⇒ 只记「闸后无执行」,不谎报成功。 */
    const host = this.worldSaveHost;
    if (host === null || typeof mobId !== 'string' || mobId === '') {
      this.lastAttackReport = null;
      return v;
    }

    /* ★ 第三个实参只在**按了 Q** 时给:老世界源不认它时,「普攻」这条路上的
       结构化调用保持不变(少一个可选实参 ⇒ 不会因为多一层而改变行为)。 */
    const authorized = useSkill
      ? host.attackMobAuthorized(userId, mobId, { useSkill: true })
      : host.attackMobAuthorized(userId, mobId);
    const hit = authorized.hit;
    this.lastAttackReport = {
      tick: this.state.meta.tick,
      playerId: userId,
      mobId,
      outcome: authorized.outcome,
      hpLoss: hit?.hpLoss ?? 0,
      finalDamage: hit?.result.finalDamage ?? 0,
      hit: hit !== null,
      outOfReach: hit?.result.outOfReach ?? false,
      dodged: hit?.result.dodged ?? false,
      useSkill,
      rejected: authorized.rejected ?? null,
    };
    return v;
  }

  /**
   * 上一次攻击结算的实际结果;`null` = **没有发生结算**。
   *
   * 与 `lastSaveReport` 同一取舍:`null` 让「没接线」与「接了但这次没打中」
   * 在断言里**可区分**,而不是都表现为「无事发生」。
   */
  lastAttackReport: AttackReport | null = null;

  /**
   * 反作弊物品检查 —— **权威值一律由服务端派生**(CR-14 U1)。
   *
   * 早期版本由调用方(网络层)把 `allowedSources` / `capacity` / `beforeTotal`
   * 三个值**从客户端报文里取**后传进来 ⇒ 判据由客户端决定,等价于该检查不存在:
   * 自带 `allowedSources` 可凭空产出物品、自报 `capacity` 可绕过容量、
   * `beforeTotal` 由本帧 ops 反推使 `NEGATIVE` 分支恒不可达。
   *
   * 现在只接受客户端的 `ops`(它**本就该**来自客户端:玩家要买/卖什么),
   * 其余四个由本方法从服务端状态算:
   *
   * - `allowedSources`:本 tick 服务端认可的合法产出集合 —— 由 `grantedSources`
   *   显式授予(掉落/合成在授予时登记),**客户端无法自行扩集**;
   * - `beforeTotal`:★ **已落盘基线 + 本房间账**。`db` 侧的 `ai_item_instances`
   *   全仓**没有生产写入口**(`addItemInstance` 只有测试调用),故它单独用只能是
   *   一个恒 0 的基准 —— 那会让容量闸在 db 模式下**恒失效**(连发 N 次每批都判
   *   `0 + net`,累不到上限;而单批 ≥ 容量 反被误判 `OVERFLOW`)。
   *   ⇒ 基准由**同一批 ops 的产物**给出:`inventoryTotals`(本房间账,见
   *   `applyItemTotalDelta` / `projectInventoryTotalFor`),库值只当**已落盘**那部分。
   * - `beforeByItem`:★ **按件**权威账(`itemCounts`,与 `authoritativeItemCount`
   *   同一份)。只有它才判得住「扣一件自己没有的东西」—— 总量判据守恒的是**别人**的
   *   件数(见 `InventoryCheckInput.beforeByItem`)。
   * - `capacity`:来自等级(`carrySlotsAt`),不是客户端自报值。
   *
   * @param input.ops 客户端提交的增减操作(唯一可信来自客户端的部分)
   */
  applyInventory(
    userId: string,
    input: { ops: readonly InventoryOp[] },
  ): ReturnType<AntiCheatRoom['inventory']> {
    const r = this.ac.inventory(userId, {
      tick: this.state.meta.tick,
      ops: input.ops,
      allowedSources: this.grantedSourcesFor(userId),
      beforeTotal: this.authoritativeItemTotal(userId),
      /* ★ 按件判据(唯一汇点):`itemCounts` 是同一批 ops 的产物,和
         `authoritativeItemTotal`/`authoritativeItemCount` 同源。
         ⚠️ 这一行是**判据本身**,不是可选项:去掉它,负 delta 就只剩总量判据,
         `{"itemId":733,"delta":-5}`(实际只有 2 件)会被放行并被静默夹零
         (由 `tests/WS-FND-129` 的 A/B 钉住)。 */
      beforeByItem: new Map(this.itemCounts.get(userId) ?? []),
      capacity: this.carryCapacityOf(userId),
    });
    if (r.violation) this.pendingViolations.push(r.violation);
    /* 通过的合法操作要落到总量记账上,否则下一次 beforeTotal 仍是旧值 ——
       那会让「总量守恒」这层在连续操作间隔里失真。 */
    if (r.allowed) {
      this.applyItemTotalDelta(userId, input.ops);
      /* ★ 按件权威账的**唯一**写入口(与总量记账同一时机、同一前提:只有放行的 ops 才算)。
         放在这里而不是 `use_item` 里:那里只该**读**,写会让「谁改的账」出现第二个来源。 */
      this.applyItemCountDelta(userId, input.ops);
    }
    /* 第 8 项:通过后立刻把**总量**按明细重算一次(契约 §2.3「变更时投影」)。
       ⚠️ 必须在 applyItemTotalDelta **之后** —— 否则重算读的是变更前的明细。
       ⚠️ 这条与 applyItemTotalDelta 不是重复:后者是纯内存模式的**退路缓存**,
          前者是**权威重算**(走明细)。host 提供明细时以**重算**为准
          (见 projectInventoryTotalFor 与 projectInventoryTotal 的 docblock)。 */
    this.projectInventoryTotalFor(userId);
    return r;
  }

  /**
   * 服务端认可的「可产出来源集合」。
   *
   * 这是 CR-14 U1 的修复核心:`checkInventory` 判 `allowedSources.has(source)`,
   * 所以这个集合**必须**由服务端持有。授予发生在掉落/合成时
   * (见 `grantItemSource`),每 tick 末由 `expireItemSources` 清理。
   */
  private grantedSourcesFor(userId: string): ReadonlySet<string> {
    return this.grantedSources.get(userId) ?? EMPTY_SOURCE_SET;
  }

  /**
   * 授予一个合法产出凭证 —— **只有服务端逻辑可以调用**。
   *
   * 典型调用点:掉落结算(`damageMob` 之后)、合成成功(`alchemy` 出口)。
   * 凭证带 tick,过期即失效;重复授予同一 source 是幂等的。
   */
  grantItemSource(userId: string, source: string): void {
    const cur = this.grantedSources.get(userId);
    if (cur) cur.add(source);
    else this.grantedSources.set(userId, new Set([source]));
  }

  /** 清掉所有产出凭证。每 tick 末调用 —— 凭证**不跨 tick 累积**。 */
  expireItemSources(): void {
    this.grantedSources.clear();
  }

  /**
   * **撤销**一张已登记的产出凭证(审计 P3:先登记后正向失败必须回撤)。
   *
   * 修前这里只有「授予」(单调增)与「tick 末清空」两档,于是**发放被拒**的令牌
   * 会留在集合里到 tick 末 —— 同一 tick 内任何另一条分支拿同一张串去铸 +delta,
   * `checkInventory` 都会按「服务端登记过」放行。那条口径正是凭证链要堵的洞。
   *
   * 幂等:串不在集合里 ⇒ 什么都不做(重复撤销安全,`expireItemSources` 之后也安全)。
   * 唯一的生产调用点是 `actions/item_source.ts` 的 `unbindItemSource`(它拿的是
   * `bindItemSource` 铸出来的那张),不开放给动作层裸调。
   */
  revokeItemSource(userId: string, source: string): void {
    this.grantedSources.get(userId)?.delete(source);
  }

  /**
   * 权威库存总量 = **已落盘基线 + 本房间账**。
   *
   * ## ★ 为什么不是「有 db 就读 db」(db 模式容量闸失效的修点)
   *
   * 修前这里是 `if (this.db) return totalItemsOf(this.db, userId)`。
   * 而 `totalItemsOf` 读的是 `ai_item_instances`,这张表**全仓没有生产写入口**
   * (`addItemInstance` 只有测试调用;生产只在内存里记 `inventoryTotals` /
   * `itemCounts`)⇒ db 模式下基准**恒为 0**:
   * ```
   * 连发 20 条 +1  每批都判 (0 + 1) ≤ capacity ⇒ **全部放行**,累不到上限
   * 单批 +9(capacity 8)⇒ 0 + 9 > 8 ⇒ **误判 OVERFLOW**(明明背包里没几件)
   * ```
   * ⇒ 判据用的基准与写账路径更新的是**两份不同的账**,这就是那条「容量闸失效」。
   *
   * ## 修法:基准取**同一权威源**(与写入路径同源),库值只当已落盘那部分
   *
   * `db` 侧是**已落盘**基线(载荷 = 本房间之前存下来的量),`inventoryTotals`
   * 是本房间**未落盘**的增量账 —— 两者相加才是「现在真实的持有量」。
   * `db === null`(纯内存/测试模式)时没有任何已落盘部分,退化为纯房间账。
   *
   * ⚠️ 如实记录边界:今天生产**没有**把 ops 写进 `ai_item_instances` 的路径,
   * 故 db 那一项在生产上恒为 0(两账相加 = 房间账);若将来补上写库,
   * 本式的语义正好变成「持久 + 增量」,不需要改判据 —— 但**必须**同时保证
   * 写库与写房间账是同一批 ops(否则这里会变成双重计数)。这条由
   * `tests/WS-FND-129` 的「基准与写入同源」判据钉住。
   *
   * 记账仍由服务端维护,**绝不取自客户端**。
   */
  authoritativeItemTotal(userId: string): number {
    const local = this.inventoryTotals.get(userId) ?? 0;
    if (this.db) {
      try {
        return totalItemsOf(this.db, userId) + local;
      } catch {
        /* 库不可用(如未建表)时退回本地记账。刻意不抛:网络层不该因
           持久层故障而拒掉全部合法操作;但记账仍走服务端口径。 */
      }
    }
    return local;
  }

  /** 把本次 ops 的净变化记到服务端总量上(仅供 `authoritativeItemTotal` 用)。 */
  private applyItemTotalDelta(userId: string, ops: readonly InventoryOp[]): void {
    const net = ops.reduce((s, o) => s + o.delta, 0);
    if (net === 0) return;
    const next = (this.inventoryTotals.get(userId) ?? 0) + net;
    /* 不允许负总量 —— 那意味着内存账与库不一致,夹到 0 并留给上层发现。 */
    this.inventoryTotals.set(userId, next < 0 ? 0 : next);
  }

  /**
   * 权威背包容量 —— 由**等级**决定,不是客户端自报值。
   *
   * 口径:`statsAtLevel(L).carrySlots = 8 + (L-1)`(见 `progression.ts`)。
   * 本方法内联同一公式而非 import 该模块 —— 因为 `progression.ts` 目前在
   * 可达性白名单里(待接线),网络层不该依赖一个尚未接入的模块。
   * 两者数值必须一致,由 `tests/WS-07.test.ts` 钉住。
   */
  carryCapacityOf(userId: string): number {
    const lv = this.state.players.find((p) => p.id === userId)?.level ?? 1;
    return 8 + (lv - 1);
  }

  /** 本地总量记账(仅 `db === null` 时参与计算;有库时以库为准)。 */
  private readonly inventoryTotals = new Map<string, number>();
  /** 每 tick 的合法产出凭证:userId → source 集合。 */
  private readonly grantedSources = new Map<string, Set<string>>();

  /* ══════════════ 按件权威账(`USE_ITEM` 的 itemId 读口)══════════════
   *
   * ## 为什么必须在这里、而且是一张**新的**表
   *
   * 修前 `USE_ITEM` 的 `itemId` 是**客户端自报**的(见 `actions/use_item.ts` 的
   * 历史注释):服务端只有「总量」(`authoritativeItemTotal`)和「有没有这件」分开算不了。
   * 后果是白嫖:背包里一件 733 都没有,也能无限发 `{itemId:733}` —— 因为扣减只看
   * 「总量够不够」,随便什么别的道具都能被当成 733 扣掉。
   *
   * ## 数据源为什么**不是** `ai_item_instances`(库里的明细)
   *
   * 那张表存的是「AI 生成实例」(`slot` / `recipe_hash` / `stats_json`),
   * **没有内容层 `itemId` 这一列** —— 拿它反查 `itemId` 是查不到东西的。
   * 而 `applyInventory` 的 `ops` 恰恰带着 `itemId`,且它是**唯一的库存变更路径**
   * (总量记账也在这里维护,`inventoryTotals` 是同一形态的先例)。
   * ⇒ 按件账跟着 `ops` 走:唯一写入口 = `applyItemCountDelta`。
   */
  private readonly itemCounts = new Map<string, Map<number, number>>();

  /**
   * **某玩家真的有多少件 `itemId`**(服务端权威读口)。
   *
   * 返回值语义:
   * ```
   * > 0   真的拥有这么多件
   * 0     账面没有 —— 调用方必须**拒绝**且零副作用
   * ```
   * ⚠️ 不接受负数 / 非有限 `itemId`:那不是「查不到」,是**坏参数** ⇒ 同样返回 0
   * (fail-closed:坏参数的唯一安全结论是「没有」)。
   */
  authoritativeItemCount(userId: string, itemId: number): number {
    if (!Number.isFinite(itemId)) return 0;
    const n = this.itemCounts.get(userId)?.get(Math.trunc(itemId)) ?? 0;
    return n > 0 ? n : 0;
  }

  /**
   * 该玩家**按 itemId 升序**的持有清单(> 0 件才出现)。
   *
   * `USE_ITEM` 的 `slot` 报文体用它把「第几个格子」翻译成真实的 `itemId`
   * (服务端说了算;客户端无法用一个 slot 号指认一件它没有的东西)。
   * 排序是**定序**的关键:同一份账面必须每次都给出同样的 slot 序列,
   * 否则「刷两次 slot 拿到两件不同的东西」会变成一个可复现的白嫖入口。
   */
  authoritativeItemIds(userId: string): number[] {
    const m = this.itemCounts.get(userId);
    if (m === undefined) return [];
    return [...m.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort((a, b) => a - b);
  }

  /** 把一次**已放行**的 ops 记到按件账上(唯一写入口)。 */
  private applyItemCountDelta(userId: string, ops: readonly InventoryOp[]): void {
    let m = this.itemCounts.get(userId);
    for (const op of ops) {
      if (!Number.isFinite(op.itemId) || !Number.isInteger(op.delta)) continue;
      const id = Math.trunc(op.itemId);
      if (m === undefined) {
        m = new Map<number, number>();
        this.itemCounts.set(userId, m);
      }
      const next = (m.get(id) ?? 0) + op.delta;
      /* 不允许负件数 —— 与总量记账的 `next < 0 ? 0` 同一取舍(账面异常夹到 0)。
         ★ 经入口(`applyInventory` → `checkInventory` 的按件判据)时**这里已不可达**:
         不足件的负 delta 在 `checkInventory` 就被 `ITEM_NEGATIVE` 拒掉,本函数只处理
         **已放行**的 ops。留着它是给「账面本来就不一致」的兜底,不是判据 ——
         判据在入口,**不要**把这里当「扣超了也无所谓」的依据(那就是修前的静默夹零)。 */
      m.set(id, next > 0 ? next : 0);
    }
  }
  drainViolations(): Violation[] {
    const out = this.pendingViolations;
    this.pendingViolations = [];
    return out;
  }

  /* ── 4.4 每帧推进 ── */

  /**
   * 20Hz 推进。返回本帧的编码报文(差量)。
   * `prev` 由调用方持有(通常是「上一帧已发给该客户端的快照」)。
   */
  step(prevSnapshot: RoomState | null = null): Uint8Array {
    /* ★ WS-FND-131(P2/SLEEPING):回收**不受 status 限制**。
       修前这条早退写在 `reapExpiredDisconnects()` **之前** ⇒ 全员断线 → 房间
       SLEEPING ⇒ 到期席位与世界刚体一直挂着(step 根本走不到回收那一行);
       而新玩家加入时先 `wake()`、再按 `members.size` 判满 ⇒ **对零在线房间
       误报「房间已满」**。⇒ 现在休眠房里也把两件清理做掉:
         · `retryPendingWorldRemovals()` 推进上一次抛错的世界侧移除(见 purgeSeat);
         · `reapExpiredDisconnects()` 回收宽限期已过的席位。
       `CLOSED` 例外:房间已销毁,回收没有意义(席位由装配层 onDispose 收)。
       这两步**都不推进 `meta.tick`** ⇒ F07「休眠房不推进帧号」照旧成立。 */
    this.retryPendingWorldRemovals();
    if (this.status !== RoomStatus.CLOSED) this.reapExpiredDisconnects();
    if (this.status !== RoomStatus.OPEN) return new Uint8Array(0);
    this.state.meta.tick += 1;
    /* ★ WS-FND-123:世界总线订阅必须在**第一次 advance 之前**接上 ——
       播报是在 `advance()` 内部 `bus.drain()` 时投递的,晚一帧接就丢掉第一帧的
       开局播报(`MODE_START`)。幂等。 */
    this.attachWorldBus();
    /* ★ 第六轮:派对 HUD 的三个字段与 `meta.tick` **同一个写点**(每帧一次)——
       放在这里而不是 `worldSaveHost.advance()` 里,是因为它读的两份事实
       (房间赛局记录 / 世界队伍)在**任何**宿主下都存在,而 `advance` 是可选成员。 */
    this.syncPartyHud();
    this.ac.tick(this.state.meta.tick);

    /* ── 推进世界(task-59:驱动缺失)──
       接线前**服务器路径**对 `tick`/`run` 的调用是 **0 处**
       (`setSimulationInterval` → 本方法 → 只 tick 计数/落盘/投影等级 → 返回)
       ⇒ 物理 / AI / 流体 / 电路 / 刷怪 / `syncPlayers()` 一帧都没跑过。
       最要命的是 `syncPlayers()`:它是 `mobPlayers` 的唯一刷新点,
       不跑 ⇒ **生物 AI 看不见玩家移动**。

       ## 为什么是 `advance(1)` 且**只能**写 1
       `WorldSim` 内部自管双频(`FAST_PER_SLOW=10`),一次 `tick()` 就是一帧
       (实测相位 `FAST×9 SLOW FAST×2`);`SIM_FAST_DT = 0.05 = 1/20` 与外部
       20Hz **天然对齐**。⇒ 外部一帧 = 内部一快帧,**恰好 1:1**。

       ⚠️ **绝不可**写成 `advance(FAST_PER_SLOW)` 或在本方法里再调一次 ——
       那会每慢帧推进两次 AI,世界快 2 倍,而**不报错、测试也可能照过**
       (`world_sim.ts` 自己记着这个先例)。翻倍检测断言见 WS-07 的 N 系列。

       ## 为什么放在 `ac.tick` 之后、落盘之前
       - 在 `ac.tick` 之后:反作弊的服务端时钟先单调前进,世界再推进 ——
         两者**互不换算**(见下),顺序只影响「本帧读到哪个值」;
       - 在落盘之前:20 帧节流写库时,存下的是**推进后**的世界,
         与 `world_tick` 同版(否则存的是上一帧的世界)。
       - 在 `syncLevelProjections` 之前:等级投影读的是推进后的权威。

       ## ⚠️ 三个时钟**互不联动**,不要试图让它们相等
       ```
       room.state.meta.tick  本方法 +1(房间 20Hz)
       WorldSim.frame        advance 推进(世界帧)
       ac.s.lastTick         服务端时钟水位(反作弊自己的)
       ```
       实测三者各自增长。**强行让 `sim.frame` 去喂 `ac.tick` 会把
       「客户端申报 tick」与「服务端帧号」混成一个字段** —— 那正是 task-55
       修掉的病根。`MAX_MOVE_CATCHUP_TICKS` 只要求**服务端时钟单调**,
       本方法已用 `meta.tick` 保证,不需要与 `sim.frame` 对齐。 */
    const host = this.worldSaveHost;
    if (host !== null && typeof host.advance === 'function') {
      host.advance(1);
    }
    /* ★ WS-FND-123:两套开局**打通**的落点(见 `syncPartyRecord`)。
       必须在 `advance(1)` **之后**:世界的 `partyPhase()/partyModeKey()` 是本帧
       推进后的事实(哨台入口在 `tickPartyStep` 里跑),早一帧读会差一整局。 */
    this.syncPartyRecord();
    /* 结算/开局会在上面这一行里改变记账 ⇒ HUD 三个字段用**同一帧**的新值重算一次。
       `syncPartyHud` 只写有变化的字段 ⇒ 重复调用无副作用。 */
    this.syncPartyHud();

    this.checkIdleSleep();
    if (this.db) {
      /* 世界帧号低频落盘(每 20 帧 = 1 秒),避免 20Hz 写库。 */
      if (this.state.meta.tick % 20 === 0) {
        this.db.update('rooms', { id: this.id }, {
          world_tick: this.state.meta.tick,
          last_active_at: this.lastActivityMs,
        });
        /* ── 同一时机把「运行时状态」也落盘(WS-05 D7 + WS-04 §430)──
           刻意复用这条 20 帧节流,而不是另起一个计时器:
           两者都是「世界状态低频落盘」,同样的理由(20Hz 写库会打爆 I/O),
           同样的时机(每秒一次)才自洽 —— 两个独立周期会让读回的
           帧号与存档内容互相错位。

           为什么放在 world_tick **之后**:`saveToDb` 里 `saveRoomMobMem`
           也会写 `last_active_at`,先写帧号再写内容,两者落在同一秒;
           顺序固定,读回时 `world_tick` 与 `mob_mem_json` 必然同版。

           `worldSaveHost` 为 null 时**什么都不做** —— 不撒谎说存过了。 */
        if (this.worldSaveHost) {
          const r = this.worldSaveHost.saveToDb(this.db, this.id, this.lastActivityMs);
          this.lastSaveReport = {
            tick: this.state.meta.tick,
            hpSaved: r.hpSaved,
            hpSkipped: r.hpSkipped,
            memRow: r.memRow,
          };
        }
      }
    }
    /* ⚠️ 必须在 `if (this.db)` **之外** —— 等级投影与有没有数据库无关。
       (放进去的话,纯内存模式 `db === null` 就永远不同步等级,
       而那正是测试最常用的形态。) */
    this.projectAllPlayers();
    /* ★ 2026-11-14:生物投影。与等级投影**同一时机、同一理由**
       (「权威一变,投影随即一致」),而且必须与下面的 `encodeDelta` 同帧 ——
       否则客户端比世界晚一帧才看到生物(表现为「走过去才发现它在动」)。 */
    this.projectWildlife();
    /* ★ WS-FND-123:boss 投影。与生物投影**同帧同理由**(权威一变,投影随即一致),
       且必须与下面的 `encodeDelta` 同帧 —— 否则客户端晚一帧才看到 boss 换阶段/换预警。 */
    this.projectBosses();
    /* ★ 审计 P0-2 要求:过期凭证必须真的被回收。
       修前 `expireItemSources()` **全仓零调用**(见 `anticheat.ts` §5.0 的「修前」段),
       而 `grantItemSource` 只增不减 ⇒ 未消费的令牌一直留到房间销毁。
       安全性不依赖本调用(令牌自带 tick + 一次性判据),这里治的是**内存卫生**:
       放在**每 tick 末**,tick 之间到达的动作照常铸/验,凭证**不跨 tick 累积**。
       `expireItemSources` 是**幂等**的(只 `clear()` 一张 Map),重复调用无副作用。 */
    this.expireItemSources();
    return prevSnapshot ? encodeDelta(prevSnapshot, this.state).bytes : new Uint8Array(0);
  }

  /**
   * 把世界的**存活生物清单**单向投影进 `state.wildlife`(权威 → 投影)。
   *
   * ## 它补的是一条**断了两头的**链路
   * ```
   * 世界侧  canSpawn(...) ⇒ spawned += 1          ← 只计数,不造怪(已于 world_sim 修)
   * 网络侧  upsertWildlife()                      ← 全仓 0 个调用点(本方法补上)
   * ```
   * ⇒ 两头都缺时表现完全一样:**客户端 `wildlife: []`**,
   *   而服务端一切"正常"(没有异常、没有日志、测试照过)。
   * 这正是本仓反复记的那类缺陷:能力存在、通路缺失。
   *
   * ## 清账为什么必须做
   * `upsertWildlife` 只**增/改**,没有对应的删除调用。不清的话,
   * 被打死的生物会**永远留在客户端快照里**:一只打不动、也不反击的幽灵目标
   * (`attackMobAuthorized` 对它回 `null`)。
   * ⇒ 以「权威清单」为准做一次差集删除,而不是等客户端自己超时。
   *
   * ## 为什么不信 `this.state` 当权威
   * 本方法只做单向写:读世界的 `listWildlife()`,不改它。
   * 反向(把 `state.wildlife` 灌回世界)会让两处互为依据 ——
   * 与 `projectAllPlayers` 的注释里记的是**同一个**病根形态。
   */
  private projectWildlife(): void {
    const host = this.worldSaveHost;
    /* `typeof` 守卫与上面 `host.advance` 同一写法:接口是必选的,
       但**老的世界源**(测试里的手搓替身)可能不实现 ⇒ 退回"不投影",
       而不是抛。 */
    if (host === null || typeof host.listWildlife !== 'function') return;
    const seen = new Set<string>();
    for (const w of host.listWildlife()) {
      seen.add(w.id);
      upsertWildlife(this.state, {
        id: w.id, mobId: w.mobId, x: w.x, y: w.y, z: w.z,
        fsm: w.fsm, hp: w.hp, maxHp: w.maxHp,
        /* ★ 宠物归属的**权威**是 `actions/breed_tame.ts`(`tameOwnerOf`),不在这里写第二份;
           `null ⇒ ''` 就是 wire 的「野生」口径(`schema.ts` 里 `tameOwnerId` 默认为空串)。
           此前这一格直接抄 `w.tameOwnerId`,而世界侧那格恒为 `''` ⇒ 世界/AI 永远不知道谁被驯服。 */
        tameOwnerId: tameOwnerOf(this.state.roomId, w.id) ?? '',
      });
    }
    for (let i = this.state.wildlife.length - 1; i >= 0; i -= 1) {
      const id = this.state.wildlife[i]!.id;
      if (!seen.has(id)) removeWildlife(this.state, id);
    }
  }

  /**
   * ★ WS-FND-123(P1-1):把世界**在场 Boss** 单向投影进 `state.bosses`(10 字段)。
   *
   * ## 它补的是一条两头都断的链(与 `projectWildlife` 同一形态)
   * ```
   *   世界侧  BossRaidRuntime.snapshots()        ← 12 个内部字段(hp/phase/hpRatio…)
   *   网络侧  schema.ts#upsertBoss               ← 全仓**唯一**容器写口,零调用
   *   ⇒ 客户端 RoomState.bosses 恒 []  ⇒ bossHudFrom() 恒 null ⇒ 血条/地面预警走 demo 兜底
   * ```
   * 修前没有任何一处报错:boss 在世界里正常被打、正常进阶段,只是**从未出进程**。
   *
   * ## 为什么优先 `bossHudSnapshots()`
   * `bossSnapshots()` 不含 `id` 与五个预警字段(`telegraphShape/X/Y/R/EndTick`),
   * 而 `BOSS_FIELD_TABLE` 要求 10 格全给。线格式由世界侧算(= 唯一能拿到
   * `BossState` 的地方),本方法只搬运,**不重算几何**。
   *
   * ## 老世界源(只有 `bossSnapshots()`)怎么办:如实降级
   * 投影阶段与血量,预警五格写 `TelegraphShape.NONE / 0` —— 客户端据此**不画**预警圈,
   * 而不是拿一个默认圆兜底(那会让「几何丢了」看起来像正常画面)。
   */
  private projectBosses(): void {
    const host = this.worldSaveHost;
    if (host === null) return;
    let list: readonly BossState[] | null = null;
    if (typeof host.bossHudSnapshots === 'function') {
      list = host.bossHudSnapshots() as readonly BossState[];
    } else if (typeof host.bossSnapshots === 'function') {
      list = host.bossSnapshots().map((b) => ({
        id: `boss:${b.bossId}`,
        bossId: b.bossId,
        phase: b.phaseIndex,
        hp: b.hp,
        maxHp: b.maxHp,
        telegraphShape: TelegraphShape.NONE,
        telegraphX: 0,
        telegraphY: 0,
        telegraphR: 0,
        telegraphEndTick: 0,
      }));
    }
    /* 一个读口都没有 ⇒ **不投影**(也不清空既有投影:那是「世界不认识 boss」,
       不是「boss 全死了」)。 */
    if (list === null) return;
    const seen = new Set<string>();
    for (const b of list) {
      seen.add(b.id);
      upsertBoss(this.state, { ...b });
      this.bossProjectionCount += 1;
    }
    /* 清账:不在场的一律移除,理由与 `projectWildlife` 逐字相同 ——
       否则被打死的 Boss 会永远留在客户端快照里(一条打不动的血条)。 */
    for (let i = this.state.bosses.length - 1; i >= 0; i -= 1) {
      const id = this.state.bosses[i]!.id;
      if (!seen.has(id)) removeBoss(this.state, id);
    }
  }

  /**
   * ★ WS-FND-123(P1-4):接上世界总线的**第一段消费**(幂等)。
   *
   * 修前:`sim/world_sim.ts` 只 `bus.emit('party_broadcast', …)`,而 `server/src`
   * 里 `.bus.on(` 是 **0 处** ⇒ 比分播报 / 终场文案 / 前三名堆在总线里没人取,
   * 两端的类型都是对的、测试也是绿的(`WS-FND-120` 只断言「总线收到了」)。
   *
   * ## 为什么订阅必须早于第一次 `advance()`
   * 总线在 `advance()` 内部 `drain()` 时投递 ⇒ 晚一帧接就丢掉第一帧的开局播报。
   * 故 `step()` 在 `meta.tick += 1` 之后、`host.advance(1)` 之前调本方法。
   *
   * ## 没有 `bus` 的老世界源
   * 不订阅、也**不假装订阅**(`partyBroadcastTotal` 保持 0)。
   */
  private attachWorldBus(): void {
    if (this.worldBusAttached) return;
    const host = this.worldSaveHost;
    const bus = host === null ? undefined : host.bus;
    if (bus === undefined) return;
    this.worldBusAttached = true;
    const off = bus.on('party_broadcast', (e) => {
      const payload = e.payload ?? {};
      const text = typeof payload.text === 'string' ? payload.text : '';
      const kind = typeof payload.kind === 'string' ? payload.kind : e.kind;
      this.partyBroadcastOutbox.push({ kind, text, atTick: this.state.meta.tick });
      /* 上界:回执/下发只需要最近几条;无界数组会随着对局无限增长。 */
      if (this.partyBroadcastOutbox.length > 64) this.partyBroadcastOutbox.shift();
      this.partyBroadcastTotal += 1;
    });
    this.worldBusOff = typeof off === 'function' ? (off as () => void) : null;
  }

  /** 已收到、尚未下发的播报(只读视图;供传输层/诊断读)。 */
  partyBroadcasts(): readonly { kind: string; text: string; atTick: number }[] {
    return this.partyBroadcastOutbox;
  }

  /** 取走积压播报(下发出口;`drainViolations` 同一形态)。 */
  drainPartyBroadcasts(): { kind: string; text: string; atTick: number }[] {
    const out = this.partyBroadcastOutbox;
    this.partyBroadcastOutbox = [];
    return out;
  }

  /**
   * ★ WS-FND-123(P1-2):**两套开局打通** —— 记账(`PartyRecord`)与赛局(contest)。
   *
   * ## 修前是两条各开一半的路
   * ```
   *   436 哨台(世界):createPartyContest ⇒ contest 在跑,但 PARTIES 里没有记录
   *   START_PARTY(网络):写 PartyRecord      ⇒ 账本有了,但世界没有赛局
   *   ⇒ partyStateOf() 恒 null(哨台开的局)/ addScore 永不调用 / meta.scoreA/B 恒 0
   *      / endParty 零生产调用
   * ```
   *
   * ## 现在这一帧做什么(三种情形,都不猜)
   * ```
   *   世界有局 + 账本 RUNNING            ⇒ 什么都不做(已经在同一条路上)
   *   世界有局 + 账本没有/已结算          ⇒ 补建账本(走真正的 START_PARTY 动作)
   *   世界回 IDLE + 账本仍 RUNNING       ⇒ endParty 收束(名次定格,addScore 停止计分)
   * ```
   *
   * ## 为什么必须走 `dispatchAction(START_PARTY)` 而不是自己写 Map
   * 账本的单例 `PARTIES` 只有 `actions/start_party.ts` 能写(`addScore`/`endParty`
   * 也都在那里)。房间这边再写一份就是第二份真值,那正是要消灭的形态。
   * ⇒ 房间只负责「找到**有权限**的演员 + 把世界的模式键投进去」。
   *
   * ## 演员怎么选(无权限时**如实跳过**,不静默冒充)
   * 候选序:裁判(哨台上站的人) → 房主。`START_PARTY` 要 `party` 权限位
   * (OWNER/ADMIN 有,MEMBER/GUEST 没有)—— 所以裁判是 MEMBER 而房主不在线时,
   * 本帧**建不出**账本,计入 `partyRecordSkips`(可断言,而不是看起来一切正常)。
   */
  private syncPartyRecord(): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.partyPhase !== 'function') return;
    const phase = host.partyPhase();
    const snap = partyStateOf(this.id);
    if (phase === 'IDLE' || phase === '') {
      this.partyRecordLatch = null;
      if (snap !== null && snap.state === PartyPhase.RUNNING) {
        const done = endParty(this.id, this.clock.nowMs());
        if (done !== null) this.partyRecordEndCount += 1;
      }
      return;
    }
    if (snap !== null && snap.state === PartyPhase.RUNNING) return;
    const key = typeof host.partyModeKey === 'function' ? host.partyModeKey() : null;
    if (key === null) { this.partyRecordSkips += 1; return; }
    if (this.partyRecordLatch === key) return;
    const idx = Object.values(PartyMode).indexOf(key as PartyMode);
    if (idx <= 0) { this.partyRecordSkips += 1; return; }
    /* 演员:裁判优先,其次房主;两者都无 `party` 权限 ⇒ 本帧不建账。 */
    const referee = typeof host.partyReferee === 'function' ? host.partyReferee() : '';
    const candidates: string[] = [];
    if (referee !== '') candidates.push(referee);
    if (this.ownerId !== referee) candidates.push(this.ownerId);
    const actor = candidates.find((id) => this.authorize(id, RoomAction.START_PARTY).allowed);
    if (actor === undefined) { this.partyRecordSkips += 1; return; }
    /* 哨台的模式命令**就是**房间已选模式(同一格 `meta.partyMode`)——
       走 `setPartyModeBy`(唯一写口,自带授权闸),不在这里直写字段。 */
    this.setPartyModeBy(actor, key as PartyMode);
    const res = this.dispatchAction(actor, RoomAction.START_PARTY, { partyMode: key as PartyMode });
    if (res.ok) {
      this.partyRecordLatch = key;
      this.partyRecordAdoptCount += 1;
    } else {
      this.partyRecordSkips += 1;
    }
  }

  /**
   * ★ WS-FND-123(P1-2 的另一半):`START_PARTY` 成功 ⇒ **真的开出赛局**。
   *
   * 修前这里零调用 ⇒ 账本建出来了,世界却一场都没跑:`partyPhase()` 恒 `IDLE`、
   * 比分永远为 0、`partySettlement()` 恒 `null`。
   *
   * ⚠️ 幂等守卫:`partyPhase() !== 'IDLE'` 时**不重开** —— `startPartyRun` 每次都会
   * `createPartyContest` 一个新容器,重开等于把正在跑的那一局连同比分丢掉(不报错)。
   */
  private startWorldPartyRun(actorId: string): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.startPartyRun !== 'function') return;
    if (typeof host.partyPhase === 'function' && host.partyPhase() !== 'IDLE') return;
    const snap = partyStateOf(this.id);
    if (snap === null || snap.state !== PartyPhase.RUNNING) return;
    if (host.startPartyRun(String(snap.mode), actorId)) this.partyRecordStartCount += 1;
  }

  /**
   * ★ WS-FND-123(P1-4 / P1-5):**回执出口** —— 把比分播报、终场文案、前三名、
   * 急单 `RUSH_GRADE` 搭在**成功回执**的 `effect` 上。
   *
   * ## 为什么走回执(而不是新开一条下行通道)
   * 客户端只认两条下行:`delta` 二进制包(字段由 `wire.ts` 冻结,房间改不了)
   * 与 `actionResult` 回执(`client/src/net/action_entry.ts` 的
   * `inlinePayload(r.effect)` 会把每个键渲染成一行)。⇒ 在 `effect` 里加键是
   * **不改协议、不动客户端**就能送达的那条路。值域按 `EffectRecord` 只放字符串/数字。
   *
   * ## 为什么带指纹(`receiptSeen*`)
   * 同一条播报/同一份结算在**每次**动作回执里重复出现会被读成「刚刚又发生了一次」。
   * ⇒ 只在世界侧出现**新**数据时挂上去;没有新数据时**一个键都不加**(回执形状不变,
   * 既有 `WS-07`/`WS-FND-*` 的 effect 断言不受影响)。
   */
  private withPartyReceipt(outcome: ActionOutcome): ActionOutcome {
    const host = this.worldSaveHost;
    if (host === null) return outcome;
    const extra: Record<string, string | number> = {};
    if (this.partyBroadcastTotal !== this.receiptSeenBroadcast && this.partyBroadcastOutbox.length > 0) {
      const last = this.partyBroadcastOutbox[this.partyBroadcastOutbox.length - 1]!;
      extra.partyBroadcast = last.text;
      extra.partyBroadcastTotal = this.partyBroadcastTotal;
      this.receiptSeenBroadcast = this.partyBroadcastTotal;
    }
    const view = typeof host.partySettlementView === 'function' ? host.partySettlementView() : null;
    if (view !== null) {
      const fp = `${view.modeName}:${view.broadcastText}`;
      if (fp !== this.receiptSeenSettlement) {
        this.receiptSeenSettlement = fp;
        extra.partyEnd = view.broadcastText;
        extra.partyModeName = view.modeName;
        /* 前三名只对**个人赛**存在(`personal` 有排序);团队赛为空 ⇒ 不加这个键。 */
        if (view.top.length > 0) extra.partyTop3 = view.top.join(' | ');
      }
    }
    const rush = typeof host.rushSettlement === 'function' ? host.rushSettlement() : null;
    if (rush !== null) {
      const fp = `${rush.grade}:${rush.score}`;
      if (fp !== this.receiptSeenRush) {
        this.receiptSeenRush = fp;
        extra.rushGrade = rush.grade;
        extra.rushScore = rush.score;
      }
    }
    if (Object.keys(extra).length === 0) return outcome;
    return { ...outcome, effect: { ...(outcome.effect ?? {}), ...extra } };
  }
  /**
   * 把 SSOT 的 **8 个交集字段**单向投影到 `state.players[]`(契约 §2.3;裁决 2 + 3)。
   *
   * ## 本方法此前叫 `syncLevelProjections`,只投 `level`
   *
   * 改名不是重命名:`level` 此前是**唯一**被投影的字段(W2 的修法),
   * 而契约 §2.3 把交集面扩到 8 个。保留旧名会让人以为「这里只管等级」,
   * 从而在别处再加一条投影路径 —— 那正是「两份实现」的起点。
   * ⇒ 单一出口:`step()` 只调本方法,本方法只调 `projectPlayer`。
   *
   * ## 两份等级的关系(这是 US2 必须显式处理的那一条)
   *
   * | 存在哪 | 是谁 | 谁会写 |
   * | :--- | :--- | :--- |
   * | `WorldSim.progresses[].level` | **权威**(升级经 `progression.ts` 真发生在这里) | 击杀结算 |
   * | `state.players[].level` | **投影**(网络编码 + `carryCapacityOf` 读它) | **本方法** |
   *
   * 接线前实测:`room.ts` 里 `level` 赋值 **0 处** ⇒ 该字段恒为 schema
   * 默认值 `1`,于是 30 级玩家的容量仍算 8(预期 37),而网络下发的等级
   * 也是 1。**两套等级各活各的**(见 `docs/AUTHORITY-MAP.md` W2)。
   *
   * ## 为什么是「投影」而不是「双向同步」
   *
   * 只允许**权威 → 投影**单向流动。反向写(把 `state.players[].level`
   * 灌回 `progresses`)会让两处互为依据、谁最后写谁算数 —— 那正是
   * `CR-14 U1` 的病根形态(`beforeTotal` 由本帧 ops 反推 ⇒ 判据自指)。
   *
   * ## 为什么放在 `step()` 而不是 `applyAttack` 里
   *
   * 升级不只是攻击造成的(救援、任务、打盹经验都会发经验),
   * 挂在攻击上会漏掉其余路径。放在每帧推进里,「权威一变,投影随即一致」,
   * 且与 `saveToDb` 的 20 帧节流**同一个 tick 编号**,落盘与下发不会错位。
   *
   * ## ★ 8 字段的权威来源与投影规则(契约 §2.3 表)
   *
   * | # | 字段 | 权威 | 本方法做什么 |
   * | :--- | :--- | :--- | :--- |
   * | 1 | `level` | `progresses` | 夹 `[1, MAX_LEVEL]` 后直传 |
   * | 2 | `hp` | `vitals` | 直传(**不夹** —— 钳制在 vitals 内) |
   * | 3 | `maxHp` | `vitals`(已是派生值) | 先 `syncMaxHp` 再直传 |
   * | 4/5/6 | `x`/`y`/`z` | `physics.bodies` | 直传 |
   * | 7 | `weaponId` | 装备权威 | 直传(`undefined` = 不投) |
   * | 8 | `inventory` | `users.inventory_json`(明细) | ⚠️ **只投总量**,走变更时路径 |
   *
   * ⚠️ 第 8 项**不在这里逐帧投** —— 它是标量,20Hz × N 人无意义(带宽裁定),
   *    由 `projectInventoryTotalFor` 在 `applyInventory` 变更时调一次。
   *
   * ## ⚠️ 顺序:先 `syncMaxHp` 再 `projectPlayer`(不可换)
   *
   * 契约 §4 第 4 步:先按等级同步派生上限,再投影。
   * 换过来的话,升级那一帧投影到的是**旧上限** —— 一帧的错,
   * 且在等级跳变边界上会表现为「血量上限落后一帧」。
   *
   * ## 上界(`level` 夹一次)
   *
   * 理由不是「模拟层可能溢出」(`combatantStats`
   * 内部已钳到 `MAX_LEVEL`),而是**本字段的消费者不钳**:
   * `carryCapacityOf` 直接 `8 + (lv - 1)`,而 `progression.statsAtLevel` 的口径
   * 是 `8 + (L-1)` 且 `L` 已被钳 ⇒ 投影越界会让两处口径分歧。
   * 该上界此前是**惰性**的(level 恒 1),接线后即时生效 ——
   * 由 `WS-07 E18` 两侧扫描钉住(level=30 ⇒ 37;level=31 ⇒ 仍 37)。
   */
  private projectAllPlayers(): void {
    const host = this.worldSaveHost;
    if (host === null) return;
    const view = this.simReadView();
    if (view === null) return;
    /* 逐玩家投影 8 个交集字段(契约 §2.3)。
       ⚠️ 这里**不改 state 以外的任何东西** —— 投影是只读视图的写入,
          不是领域变更。领域变更只在 `WorldSim.tick` 里发生(契约 §4)。
       ⚠️ 顺序:先 syncMaxHp 再 projectPlayer —— 与契约 §4 第 4 步一致。
          maxHp 是派生值,必须先落到 vitals,投影才能读到**本帧**的正确上限
          (反过来的话,升级那一帧投影到的是旧上限 —— 一帧的错)。 */
    for (const p of this.state.players) {
      const lv = view.levelOf(p.id);
      if (Number.isFinite(lv)) {
        const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(lv)));
        /* 裁决 1:maxHp 由 progression 派生,经 vitals.syncMaxHp 落到权威。
           ⚠️ 这里**不算** maxHp 公式 —— 那会是第二份实现(公式在 progression)。
              本方法只做「等级 → 问一次派生值 → 交给 vitals」的搬运。
           ⚠️ 为什么逐帧调而不是只在等级变化时调:
              syncMaxHp 自己返回 bool 且内部判 changed ⇒ 重复调**无副作用**
              实测:`maxHp` 相同且 `hp <= maxHp` 时 changed=false、不写。
              用「这里先判等级变了没」来省调用,会引入**第二处变化检测**,
              而那正是两份实现互相顶着的地方。 */
        const derived = this.derivedMaxHp(p.id, clamped);
        if (derived !== null) this.syncMaxHpOf(p.id, derived);
      }
      projectPlayer(view, p.id, p);
    }
  }

  /**
   * 构造投影读口(契约 §3.1)。
   *
   * ## 为什么在**这里**构造,而不是让 projectPlayer 自己摸 worldSaveHost
   *
   * `projectPlayer` 只接受 `SimReadView` ⇒ 它**结构上**拿不到 `room.state`。
   * 把所有 `host` 的存在性判断收在这一处,投影函数就变成**纯函数**
   * —— 那正是它能被假实现单测的前提。
   *
   * ## ⚠️ 老世界源(只实现了部分读口)怎么办:逐口降级
   *
   * 缺哪个读口,该读口返回「没有权威」:vitalsOf/poseOf 给 null、
   * weaponOf 给 undefined ⇒ 对应字段不投影(保留旧值)。
   * ⇒ 而不是整段跳过:那样「接了 3 个读口」与「一个都没接」表现相同,
   *   断言分不出进度。逐口降级让**接了哪些**成为可观测的。
   *
   * ⚠️ 第 8 项不在这里 —— 走「变更时投影」的单独路径(且**只有明细一条通路**)
   * (契约 §2.3 带宽裁定),读口存在性由 `projectInventoryTotalFor` 自己判。
   */
  private simReadView(): SimReadView | null {
    const host = this.worldSaveHost;
    if (host === null) return null;
    return {
      levelOf: (id) => (typeof host.levelOf === 'function' ? host.levelOf(id) : 1),
      vitalsOf: (id) => (typeof host.vitalsOf === 'function' ? host.vitalsOf(id) : null),
      poseOf: (id) => (typeof host.poseOf === 'function' ? host.poseOf(id) : null),
      weaponOf: (id) => (typeof host.weaponOf === 'function' ? host.weaponOf(id) : undefined),

    };
  }

  /**
   * 派生上限注入点。默认走 `progression.statsAtLevel` —— 但它住在
   * `server/src/combat/`,而 `net → combat` 是**禁止**的依赖方向
   * (契约 §8;`WS-07 K6` 钉住本文件的代码态不得出现模拟层符号)。
   *
   * ⇒ 故派生值必须**由世界源提供**:它同时知道 progression 与 vitals,
   *   是唯一能合法连接两侧的地方(契约 §8「派生值由**调用方**传入,
   *   不让 vitals 自己按 level 查表」)。
   * ⇒ 世界源没提供时返回 null ⇒ 不改 maxHp(保留 vitals 的既有值),
   *   而**不是**拿一个猜的公式兜底 —— 那会是第二份实现。
   */
  private derivedMaxHp(playerId: string, level: number): number | null {
    const host = this.worldSaveHost;
    if (host === null || typeof host.maxHpForLevel !== 'function') return null;
    const v = host.maxHpForLevel(playerId, level);
    return v !== null && Number.isFinite(v) ? v : null;
  }

  /** 把派生上限交给 vitals(经世界源;`net` 不认识 `VitalsSystem`)。 */
  private syncMaxHpOf(playerId: string, derivedMaxHp: number): void {
    const host = this.worldSaveHost;
    if (host === null || typeof host.syncMaxHp !== 'function') return;
    host.syncMaxHp(playerId, derivedMaxHp);
  }

  /**
   * 第 8 项「总量 ← 明细」重算时**明细从哪来** —— 全类唯一的取法(见 `InventoryDetailSource`)。
   *
   * ## ★★ 第五轮 P1 的修点就在这里
   *
   * 修前:`projectInventoryTotalFor` **只**读 `host.inventoryDetailOf`,而唯一生产宿主
   * (`world_sim.ts:4247`)如实返回 `null` ⇒ **恒**返回 false ⇒「总量按明细重算」这条
   * 契约**在生产上从未执行过**。两处账于是各自维护:
   * ```
   * inventoryTotals  增量式(applyItemTotalDelta:total += Σdelta)
   * itemCounts       明细式(applyItemCountDelta:按件加减)
   * ```
   * 两者今天结果相同,但增量式**漏一帧就永久偏差** —— 正是契约 §2.3(W5 裁定)
   * 要挡的形态;而「按明细重算」这道保险从未上过电。
   *
   * ## 修法:让明细来源**同源**,而不是让宿主编一个明细
   *
   * ```
   * 宿主实现 inventoryDetailOf ⇒ 以世界侧为准(将来背包搬进模拟层时自动生效)
   * 宿主没有(null / 未声明)  ⇒ 退回**本房间按件账** `itemCounts`
   *                            它的唯一写入口 applyItemCountDelta 与总量账
   *                            (applyItemTotalDelta)**吃的是同一批 ops、同一前提**
   *                            ⇒ 两处账同源,重算有真输入
   * 两者都没有                 ⇒ 'none':不重算(fail-closed,见下)
   * ```
   * ⚠️ 为什么**不**改 `world_sim.ts` 去实现 `inventoryDetailOf`:模拟层**确实**
   * 不持有背包明细(那是 `users.inventory_json` / 房间账的事)。让它编一份出来
   * 就是第二份事实源。⇒ 正确的落点是「房间自己的明细账」。
   *
   * ⚠️ 为什么返回**房间账的形状**(`{itemId, quantity}[]`)而不是直接返回 Map:
   * `projectInventoryTotal` 只认 `quantity` 字段(它对 `Record` / `Map` 一概不认),
   * 这里就地翻译成它认的**唯一**形状,免得下游再写一层解析。
   */
  private inventoryDetailSource(userId: string): {
    readonly source: InventoryDetailSource;
    readonly detail: readonly { quantity?: unknown }[];
  } {
    const host = this.worldSaveHost;
    if (host !== null && typeof host.inventoryDetailOf === 'function') {
      const fromHost = host.inventoryDetailOf(userId);
      if (fromHost !== null) return { source: 'host', detail: fromHost };
    }
    const m = this.itemCounts.get(userId);
    if (m === undefined) return { source: 'none', detail: [] };
    const rows: { itemId: number; quantity: number }[] = [];
    for (const [itemId, quantity] of m) rows.push({ itemId, quantity });
    return { source: 'room', detail: rows };
  }

  /**
   * 上一次总量投影的**来源与结果**(诊断;判据用它区分「重算真的跑了」与「静默没跑」)。
   *
   * `null` = 从未跑过。核心一维是 `source`:`'host'` / `'room'` = 重算**有输入**;
   * `'none'` = 两个明细源都没有。第五轮 P1 的形态是「**恒** false 且没有任何地方
   * 看得出它没跑」,本字段就是那个「看得出」。
   */
  lastInventoryProjection: {
    readonly userId: string;
    readonly source: InventoryDetailSource;
    readonly total: number;
    readonly changed: boolean;
  } | null = null;

  /**
   * 第 8 项 `inventory`:总量投影(契约 §2.3 的 W5 裁定)。
   *
   * ## ★★ 方向 = 明细 → 总量,且**重算**而非累加
   *
   * 累加式(`total += delta`)漏一帧就**永久偏差**;
   * 重算式(`total = f(明细)`)任何一帧只依赖当时的明细。
   * ⇒ 故这里**读明细**(经 `inventoryDetailSource`),不读 `inventoryTotals`。
   *   `inventoryTotals` 是纯内存模式下的**退路缓存**,不是本投影的输入。
   *
   * ## 为什么是「变更时」而不是逐帧(契约 §2.3 带宽裁定)
   *
   * 总量是标量,逐帧投 20 次 × N 人无意义。⇒ 调用方只在
   * `applyInventory` 通过后调一次。
   * ⚠️ 但**重算**这一点与频率无关:低频 + 累加式照样会漂(而且更晚发现)。
   *
   * ## `source === 'none'` 时**不重算**(fail-closed,修前是静默 false)
   *
   * 明细源一个都没有 ⇒ 既**不**把总量写成 `0`(那是拿编造的值覆盖增量账),
   * 也**不**假装成功;如实把这一次记进 `lastInventoryProjection`(source `'none'`)。
   * 与修前的差别不是「多一个分支」,而是:**「没有明细」这件事从此可观测**
   * ——修前它与「明细算出来没变化」是同一个返回值 `false`,从外面分不开。
   *
   * @returns 是否发生变更(供调用方决定要不要下发)
   */
  projectInventoryTotalFor(userId: string): boolean {
    const { source, detail } = this.inventoryDetailSource(userId);
    if (source === 'none') {
      this.lastInventoryProjection = {
        userId, source, total: this.inventoryTotals.get(userId) ?? 0, changed: false,
      };
      return false;
    }
    const total = projectInventoryTotal(detail);
    const prev = this.inventoryTotals.get(userId) ?? 0;
    const changed = prev !== total;
    if (changed) this.inventoryTotals.set(userId, total);
    this.lastInventoryProjection = { userId, source, total, changed };
    return changed;
  }

  /**
   * 成员在线态/打盹态的三分。
   *
   * 打盹有**两个阶段**,由 `AFK_TIMEOUT_MS`(30 分钟)分开:
   *
   * | 阶段 | 占席位 | 计活跃 | 吃经验 | 个人掉落归属 |
   * | :--- | :---: | :---: | :---: | :---: |
   * | `ACTIVE` 清醒 | ✓ | ✓ | 100% | ✓ |
   * | `AFK` 打盹 < 30 分钟 | ✓ | ✗ | `AFK_EXP_RATIO`=30% | ✗ |
   * | `AFK_EXPIRED` 打盹 ≥ 30 分钟 | ✓ | ✗ | 0% | ✗ |
   *
   * `OFFLINE` 是断线(App 已关),与打盹正交:打盹者仍 `connected`。
   * 注意 `AFK_EXPIRED` **仍然占席位、仍然 online** —— 超时不 disconnect。
   */
  memberPresence(m: MemberSession): MemberPresence {
    if (!m.connected) return MemberPresence.OFFLINE;
    if (m.afkSinceMs === null) return MemberPresence.ACTIVE;
    return this.isAfkExpired(m) ? MemberPresence.AFK_EXPIRED : MemberPresence.AFK;
  }

  /** 打盹是否已超过 `AFK_TIMEOUT_MS`。 */
  isAfkExpired(m: MemberSession): boolean {
    if (m.afkSinceMs === null) return false;
    return this.clock.nowMs() - m.afkSinceMs >= AFK_TIMEOUT_MS;
  }

  /**
   * 房间是否「无人」。
   *
   * **打盹 ≠ 离线**:切后台打盹的玩家(无论是否超过 `AFK_TIMEOUT_MS`)
   * 仍然 `connected`、仍然占席位、仍有实体,所以**不能让房间休眠**。
   * 真正触发休眠的只有「没有任何在线连接」。
   */
  hasAnyOnlineConnection(): boolean {
    for (const m of this.members.values()) if (m.connected) return true;
    return false;
  }

  /**
   * 在线且清醒(非打盹)的玩家数。
   *
   * 打盹者(含超时者)**不计入** —— 这是「房间还有没有人在真的玩」的口径,
   * 与「席位是否被占」是两个不同的问题。
   */
  activePlayerCount(): number {
    return [...this.members.values()]
      .filter((m) => this.memberPresence(m) === MemberPresence.ACTIVE).length;
  }

  /** 打盹玩家数(含未超时与已超时;两者都仍占席位)。 */
  afkPlayerCount(): number {
    let n = 0;
    for (const m of this.members.values()) {
      const s = this.memberPresence(m);
      if (s === MemberPresence.AFK || s === MemberPresence.AFK_EXPIRED) n += 1;
    }
    return n;
  }

  /**
   * 打盹已超时(≥30 分钟)且**仍在线**的玩家数。
   * 这些人退出经验分配与个人掉落归属,但仍占席位。
   *
   * 注意用在场态而非裸时间戳判定:一个已断线的成员可能还留着旧的 `afkSinceMs`,
   * 但他的态是 `OFFLINE`(断线优先于打盹),不该被算进打盹超时。
   */
  afkExpiredCount(): number {
    let n = 0;
    for (const m of this.members.values()) {
      if (this.memberPresence(m) === MemberPresence.AFK_EXPIRED) n += 1;
    }
    return n;
  }

  /** 席位占用数(在线即占,与是否打盹、是否超时无关)。 */
  seatCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.connected) n += 1;
    return n;
  }

  /** 某成员的在场态(供 WS-10 经验分配、WS-05 掉落归属查询)。 */
  presenceOf(userId: string): MemberPresence | undefined {
    const m = this.members.get(userId);
    return m ? this.memberPresence(m) : undefined;
  }

  /**
   * 该成员是否应参与**经验分配**。
   * 清醒者全额;打盹未超时者按 `AFK_EXP_RATIO` 折算(由 WS-10 侧乘系数);
   * 打盹超时者**完全退出**;断线者退出。
   */
  isExpEligible(m: MemberSession): boolean {
    const s = this.memberPresence(m);
    return s === MemberPresence.ACTIVE || s === MemberPresence.AFK;
  }

  /** 该成员是否应参与 **Boss 个人掉落归属**(超时打盹者不参与)。 */
  isLootEligible(m: MemberSession): boolean {
    const s = this.memberPresence(m);
    return s === MemberPresence.ACTIVE || s === MemberPresence.AFK;
  }

  /**
   * 标记/取消打盹。打盹只影响「是否计入活跃」,不影响连接与席位。
   *
   * ## task-74:本方法现在是**单向推送**的起点
   *
   * 接线前实测:本方法的**生产调用点 0 处**(`tests/WS-07.test.ts` 有 11 处)。
   * ⇒ 打盹这个状态在模拟层**永不生效** ⇒ `afk` 恒 false ⇒
   *   `aoi` / `behaviors` / `progression` 的三条闸门全是死代码。
   *
   * 现在:房间是打盹的**唯一权威**,每次变更**推**给模拟层。
   * 方向是单向的(房间 → 模拟层)—— 模拟层不反过来问房间,
   * 因为 `room.ts` 有意不认识模拟层类型(见本文件 L270-285 的设计自述)。
   *
   * ## ⚠️ 返回值语义**不变**
   *
   * 仍返回「该用户是否是一个可被标记的在线成员」。
   * 模拟层推送**成功与否不影响它** —— 世界侧没有这个玩家(尚未 `addPlayer`)
   * 时,打盹标记在房间侧**依然成立**(他还是房间成员),只是暂时没有投影。
   * 把这层耦合进返回值会让「房间记下了」与「世界知道了」混成一个布尔。
   */
  setAfk(userId: string, afk: boolean): boolean {
    const m = this.members.get(userId);
    if (!m || !m.connected) return false;
    m.afkSinceMs = afk ? this.clock.nowMs() : null;
    this.pushAfkToHost(userId, afk);
    return true;
  }

  /**
   * 把打盹态推给模拟层(单向)。
   *
   * 抽成私有方法而不是写在 `setAfk` 里,是为了让**其它入口**
   * (`join` / `leave` / `disconnect` / 宽限期超期清理)也能复用同一段 ——
   * 那些入口会让玩家出现/消失,而「消失的玩家仍留在模拟层的打盹集合里」
   * 是一类静默残留(本仓 `afkPlayers` 已按 `playerIds` 过滤来防它,
   * 但离场时**主动清一次**更稳)。
   *
   * 与 `removePlayer` 的调用点同一纪律:写成 `typeof host.x === 'function'`
   * 而不是 `if (host.x)` —— 老的世界源没实现它时整段跳过,不报错也不假装。
   */
  private pushAfkToHost(userId: string, afk: boolean): void {
    const host = this.worldSaveHost;
    if (host !== null && typeof host.setPlayerAfk === 'function') {
      host.setPlayerAfk(userId, afk);
    }
  }

  /**
   * 无人 60 秒 → 自动休眠。
   *
   * 判定条件:**没有任何在线连接**(打盹的不算无人,超时的也不算)
   * **且** 距上次活动 ≥ IDLE_SLEEP_MS。
   * 有连接时直接把活动时间戳刷新,保证「有人挂着」的房间永不进入休眠。
   *
   * 注意:打盹者超时(≥30 分钟)也**不**触发休眠 —— 他还在线、还占席位、
   * 可能随时回来。房间真正无人只发生在全部 `disconnect` 之后。
   */
  checkIdleSleep(): boolean {
    if (this.status !== RoomStatus.OPEN) return false;
    if (this.hasAnyOnlineConnection()) {
      /* 有人在线(含打盹与超时打盹):保持活跃计时,永不休眠。 */
      this.touch(this.clock.nowMs());
      return false;
    }
    if (this.clock.nowMs() - this.lastActivityMs < IDLE_SLEEP_MS) return false;
    return this.sleep();
  }

  touch(nowMs: number): void {
    this.lastActivityMs = nowMs;
  }

  /* ── 4.5 快照 ── */

  /**
   * 某玩家在**本轮会话**的稳定快照。
   * 编码是确定性的(`encodeFull` 遍历顺序固定、定点量化),因此只要世界状态未变,
   * 同一 tick 下重复调用逐字节一致 —— 重连一致性的基础。
   */
  snapshotFor(_userId: string): Uint8Array {
    /* ★ WS-FND-131:此处原本写 `s.seq = this.state.meta.tick` —— 那条 `MemberSession.seq`
       全仓**0 读取**,而且它把**房间帧号**混写进**成员会话**字段(两个时钟混写)。
       字段已删;快照本身按整房编码,逐字节一致性不受影响(见 docblock)。 */
    return encodeFull(this.state, this.state.meta.tick).bytes;
  }

  /** 供断言:把快照解码回来对照。 */
  cloneState(): RoomState {
    return cloneRoomState(this.state);
  }

  /**
   * **读档恢复**(task-70 / 契约 §4.1)。返回恢复后该玩家的**实际权威坐标**,
   * 或 `null`(无存档 / 存档里没有这个人 ⇒ 走正常出生流程)。
   *
   * ## 为什么读 blob 而不是 `users` 表
   *
   * 实测(契约 §2.2.1):
   * ```
   * level 的唯一持久化处 = room_players.snapshot_blob
   * users 表虽**有** level/max_hp 列,但 saveVitalsToUsers 只写 hp(repo.ts:773),
   * 且 hp 被 cur.max_hp(=建号 100)钳住 ⇒ 实测写 535 读回 100
   * ```
   * ⇒ **只有 blob 装得下** level 与 535 血。
   *
   * ## 只取「自己那一行」
   *
   * blob 是 `encodeFull(state)`(整房快照)⇒ 含所有玩家的行。
   * 本方法**只提取 `userId` 自己**的那行 ——
   * 若把整房都写回权威,那是**用旧快照覆盖别人当前的状态**,
   * 表现为「一个人重连,全房回档」。
   *
   * ## 失败一律返回 `null`,不抛
   *
   * 存档可能:① 不存在(首次进入) ② 协议版本变了(`decodePacket` 会抛)
   * ③ 字节被截断。三者都是**正常的**「没有可用存档」,不该让 join 失败。
   * ⚠️ 但 ② ③ 与 ① 的处置**不同**:前者是**缺陷**,后者是常态。
   *    故 ② ③ 走 `restoreError` 记下来(测试可断言),而不是彻底静默 ——
   *    否则「存档读坏了」与「没有存档」不可区分(陷阱 89)。
   */
  restoreFromSnapshot(
    host: WorldSaveHost,
    userId: string,
  ): { x: number; y: number } | null {
    if (!this.db) return null;
    const restorer = host.restoreFromProfile;
    if (typeof restorer !== 'function') return null;

    const blob = loadReconnectSnapshot(this.db, this.id, userId);
    if (blob === undefined) return null;

    let row: PlayerProjection | null = null;
    try {
      const pkt = decodePacket(blob);
      for (const up of pkt.upserts) {
        if (up.kind !== EntityKind.PLAYER || up.id !== userId) continue;
        const f = up.fields;
        row = {
          level: typeof f.level === 'number' ? f.level : 1,
          hp: typeof f.hp === 'number' ? f.hp : 0,
          maxHp: typeof f.maxHp === 'number' ? f.maxHp : 0,
          x: typeof f.x === 'number' ? f.x : 0,
          y: typeof f.y === 'number' ? f.y : 0,
          z: typeof f.z === 'number' ? f.z : 0,
          weaponId: typeof f.weaponId === 'number' ? f.weaponId : 0,
        };
        break;
      }
    } catch (e) {
      /* 存档存在但读不回来 ⇒ 这是**缺陷**,与「没有存档」不同。记下来供断言。 */
      this.lastRestoreError = `快照解码失败(${userId}):${(e as Error).message.slice(0, 80)}`;
      return null;
    }
    if (row === null) return null;

    /* ⚠️ 先落到**权威**(唯一入口),**不碰** `state.players[]` —— §4.3。
       投影由下一帧的 `syncLevelProjections` 统一做(它已在每帧被调用)。 */
    const applied = restorer.call(host, userId, {
      level: row.level,
      hp: row.hp,
      x: row.x,
      y: row.y,
      z: row.z,
      weaponId: row.weaponId,
    });
    this.lastRestoreApplied = applied;

    /* 返回**恢复后的实际**坐标(不是 blob 里的):刚体可能因碰撞被推开,
       用 blob 坐标播种反作弊会把第一次移动判成瞬移(实测差 13.649 格)。 */
    if (typeof host.playerPosition === 'function') {
      const p = host.playerPosition(userId);
      if (p !== null) return { x: p.x, y: p.y };
    }
    return { x: row.x, y: row.y };
  }

  onlineCount(): number {
    return [...this.members.values()].filter((m) => m.connected).length;
  }

  playerState(id: string): PlayerState | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  /* ── 内部 ── */

  /**
   * 签发一张加入凭证(服务端专用入口:登录 / 大厅 / 房主入场 / 断线重连)。
   *
   * ## 旧 `mintToken()` 为什么必须删掉
   * ```ts
   * return `${this.id}-${this.tokenSeq}-${PROTOCOL_VERSION}`;   // ← 旧实现
   * ```
   * 它**格式完全可预测**(房间 id + 递增序号 + 常量)⇒ 任何人徒手就能写出一张"合法"的;
   * 而它又**一次都没被校验过**(全仓 0 处 verify)⇒ 那个 token 只是日志里的装饰。
   * 现在:`member.token` 是**签名过的**凭证,并且 `join` 的入口会校验它
   * (见 `verifyJoinToken`)⇒ 签发与校验是**同一份密钥 + 同一份实现**。
   *
   * `ttlMs` 会被钳到 `[1, JOIN_TOKEN_MAX_TTL_MS]`:调用方传 `Infinity`/负数
   * 不该能造出"永不过期"的凭证(那正是要消灭的形态)。
   */
  issueJoinToken(userId: string, ttlMs: number = JOIN_TOKEN_TTL_MS): string {
    const requested = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : JOIN_TOKEN_TTL_MS;
    const ttl = Math.min(JOIN_TOKEN_MAX_TTL_MS, Math.max(1, requested));
    return signRoomToken(this.authSecret, {
      userId,
      roomId: this.id,
      expiresAtMs: this.clock.nowMs() + ttl,
    });
  }

  /**
   * 校验一张加入凭证,并**核对它声明的 userId** —— 运输层与重连调用的是同一个方法。
   * 失败原因原样往上抛(下游把它当 `reject` 帧的 reason),不吞、不归一化:
   * 「缺 token / 伪造 / 过期 / 房的凭证」是四件事,合成一句就没法指认了。
   *
   * ★ P1-3(2026-11-19):过期判据的**起算点**在重连态下改为断线时刻 ——
   *   由 `reconnectTokenGraceUntilMs(userId)` 提供,口径见
   *   `verifyRoomToken` 的 `expect.expiredOkUntilMs`。
   *   ⚠️ 这里**只**放宽过期(签名/房间/绑定三判据没动),而且只对
   *      **这个 userId 自己**的断线宽限生效 —— 在线成员拿到的是 `undefined`。
   */
  verifyJoinToken(userId: string, token: unknown): RoomTokenVerdict {
    return verifyRoomToken(this.authSecret, token, {
      userId,
      roomId: this.id,
      nowMs: this.clock.nowMs(),
      expiredOkUntilMs: () => this.reconnectTokenGraceUntilMs(userId),
    });
  }

  /**
   * 校验凭证的**签名/房间/有效期**,但不核对 userId 绑定 —— 供「凭证即身份」的入口用。
   *
   * 只有一类调用方该用它:`room.colyseus.ts` 的 `onJoin`。那里的成员键是
   * Colyseus 自己生成的 `client.sessionId`(**服务端产物**,不是客户端串),
   * 没有"客户端声明的 userId"可比对;凭证里的 `userId` 才是身份来源。
   * ⚠️ 裸 WS 路径**不要**用它:那里有 `?userId=` 这个可伪造的声明,必须走
   * `verifyJoinToken`(它会把两者钉在一起)。
   */
  decodeJoinToken(token: unknown): RoomTokenVerdict {
    return verifyRoomToken(this.authSecret, token, {
      userId: '',
      roomId: this.id,
      nowMs: this.clock.nowMs(),
      /* ★ P1-3:这里**没有**客户端声明的 userId 可比对 ⇒ 只能用凭证自己的
         `claims.userId` 去问宽限 —— 回调的参数正是它(见 verifyRoomToken 的
         `expiredOkUntilMs` 注释第 3 条)。 */
      expiredOkUntilMs: (claimedUserId: string) => this.reconnectTokenGraceUntilMs(claimedUserId),
    });
  }

  /**
   * ★ P1-3(2026-11-19):断线中的成员**重连时可用的凭证截止时刻**。
   *
   * ## 口径(全仓唯一一处算它 —— 两处调用点共用)
   * ```
   * 生效值 = min(断线时刻 + JOIN_TOKEN_TTL_MS, 断线时刻 + RECONNECT_GRACE_MS)
   *        = 断线时刻 + 30s(因为 30s < 5min,宽限期总是更紧的那个)
   * ```
   * 直觉版:**凭证的有效期从断线时刻重新起算,但绝不越过重连宽限期的终点**。
   * 前一半修的是「会话超过 5 分钟 ⇒ 手里那张已过期 ⇒ 宽限期内必然被拒」;
   * 后一半保证放宽**不能**比席位本身活得更久(席位一过 30s 就被
   * `reapExpiredDisconnects` 收回,那时这里恒返回 `undefined`)。
   *
   * ## 为什么这样算而不是「断线时换发一张」
   * 服务端在**断线那一刻**没有任何可用的下发通道(客户端已经走了);
   * 装配层只能验客户端递上来的那一张 ⇒ 能改的只有**判据的起算点**。
   * 详见 `verifyRoomToken` 的 `expect.expiredOkUntilMs`。
   *
   * ## 三态(负对照的入口都在这里)
   * ```
   * 没有这个成员 / 已在线 / 没有断线时刻 ⇒ `undefined` ⇒ 过期凭证照旧被拒
   * 断线中且仍在宽限期内              ⇒ 断线时刻 + RECONNECT_GRACE_MS
   * ```
   * ⚠️ `s.disconnectedAtMs === null` 单独判一次是**必须**的:它在类型上
   *   是 `number | null`,直接相加会得到 `NaN`,而 `nowMs >= NaN` 恒为
   *   `false` ⇒ 那会变成一条**无条件的放行**(本仓反复点名的 NaN 形态)。
   */
  reconnectTokenGraceUntilMs(userId: string): number | undefined {
    const s = this.members.get(userId);
    if (s === undefined || s.connected || s.disconnectedAtMs === null) return undefined;
    return Math.min(
      s.disconnectedAtMs + JOIN_TOKEN_TTL_MS,
      s.disconnectedAtMs + RECONNECT_GRACE_MS,
    );
  }

  private spawnPoint(): { x: number; y: number } {
    /* 出生点铺开:第 n 个玩家沿 X 轴排开 1.5 格,避免叠罗汉误触。 */
    const n = this.state.players.length;
    return { x: 0.5 + (n % 8) * 1.5, y: 0.5 + Math.floor(n / 8) * 1.5 };
  }
}

/* ═══════════════════════════ 5. 房间管理器 ═══════════════════════════ */

export interface RoomRegistryOptions {
  clock: Clock;
  db?: DbLike | null;
  /** 房间被彻底回收时回调(用于清内存缓存)。 */
  onEvict?: (roomId: string) => void;
}

export class RoomRegistry {
  readonly clock: Clock;
  readonly db: DbLike | null;
  private rooms = new Map<string, RoomRuntime>();
  private evicted: string[] = [];
  private readonly onEvict?: (roomId: string) => void;

  constructor(opts: RoomRegistryOptions) {
    this.clock = opts.clock;
    this.db = opts.db ?? null;
    this.onEvict = opts.onEvict;
  }

  create(opts: Omit<RoomRuntimeOptions, 'clock'>): RoomRuntime {
    if (this.rooms.has(opts.roomId)) throw new Error(`房间 id 冲突:${opts.roomId}`);
    const r = new RoomRuntime({ ...opts, clock: this.clock }, this.db);
    this.rooms.set(opts.roomId, r);
    return r;
  }

  get(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId);
  }

  /** 大厅列表:只列 OPEN;`includeSleeping` 时连休眠房一起列(带状态)。 */
  list(includeSleeping = false): RoomRuntime[] {
    return [...this.rooms.values()]
      .filter((r) => r.status !== RoomStatus.CLOSED)
      .filter((r) => includeSleeping || r.status === RoomStatus.OPEN)
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  /** 休眠房超期回收。 */
  reapEvictions(): string[] {
    const now = this.clock.nowMs();
    const out: string[] = [];
    for (const r of [...this.rooms.values()]) {
      if (r.status !== RoomStatus.SLEEPING) continue;
      if (now - r.lastActivityMs < EVICT_MS) continue;
      r.close();
      this.rooms.delete(r.id);
      this.evicted.push(r.id);
      out.push(r.id);
      if (this.onEvict) this.onEvict(r.id);
    }
    return out;
  }

  evictedRooms(): readonly string[] {
    return this.evicted;
  }

  size(): number {
    return this.rooms.size;
  }
}

/* ═══════════════════════════ 6. 便捷装配 ═══════════════════════════ */

export interface BootstrapOptions {
  clock: Clock;
  db?: DbLike | null;
  ownerId?: string;
  ownerName?: string;
}

/** 最小可跑装配:建一个 owner 用户 + 一个房间。测试与冒烟共用。 */
export function bootstrap(opts: BootstrapOptions): { registry: RoomRegistry; ownerId: string; roomId: string } {
  const ownerId = opts.ownerId ?? 'u_owner';
  const roomId = 'room_alpha';
  const db = opts.db ?? null;
  const now = opts.clock.nowMs();
  if (db && !getUser(db, ownerId)) {
    createUser(db, { id: ownerId, displayName: opts.ownerName ?? '岛主', nowMs: now });
  }
  const registry = new RoomRegistry({ clock: opts.clock, db });
  registry.create({ roomId, ownerId });
  return { registry, ownerId, roomId };
}

/** 供 SQL 侧读取房间列表。 */
export function registryRoomIds(db: DbLike): string[] {
  return listRooms(db, { includeSleeping: true }).map((r) => r.id);
}

/** 导出以保持与 repo 层的可组合性(测试会直接调)。 */
export { getRoom, loadReconnectSnapshot };
