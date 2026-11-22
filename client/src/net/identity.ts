/**
 * 客户端**身份**(2026-11-22):浏览器必须自带一个 `userId` 才能进房间。
 *
 * ## 为什么需要这个文件(实测的缺陷)
 *
 * 服务端 `ws_server.ts#onHello` 的判据是「**声明**必须有」:
 * url 里没有 `?userId=`、hello 里也没有 `userId` ⇒ 直接
 * `{t:'reject', code:'NO_IDENTITY'}` 并关连接。而客户端此前**两头都不带**
 * (默认地址是 `ws://<host>:8791/ws`,hello 只有 `{t, protocolVersion, contentClaim}`)
 * ⇒ **任何浏览器都进不了房间**:单机渲染照常(地形/UI 都在),但世界里没有你、
 * 没有别的玩家、怪也不同步 —— 现象就是「画面有、逻辑没有」。
 *
 * ## 为什么走**地址**而不是 hello(不是随手选的)
 *
 * 服务端 `HelloFrame` 镜像**刻意不声明** `userId`,理由写在 `ws_server.ts:969-975`:
 * 「一个**谁都不发**的字段,只会让下一个人以为"已经有这条路了"」;
 * `tests/WS-13.test.ts` 的 `WS13-5b-1` 逐字段守着两侧镜像一致,`WS13-6-6` 则钉住
 * 「稳定 id 只从握手 URL 来」。⇒ 本模块产出的 id **拼进 WS 地址**,hello 一字不改。
 *
 * ## 取法(优先级固定,便于排障)
 * ```
 * 1 ?user=<id>                      显式覆盖(换账号 / 双开 / 手机与桌面各占一个席位)
 * 2 localStorage['sandbox.userId']   同一浏览器**永久沿用**(席位与存档才连续)
 * 3 现造一个并写回
 * ```
 * ⚠️ 纯函数 + **注入** storage:零 DOM、零 `window`,可单测(与 `net/joystick.ts` 同款)。
 */

/** 存 id 的键。改名等于**换身份**(席位、背包、存档里的行都跟着换)⇒ 别乱改。 */
export const USER_ID_STORAGE_KEY = 'sandbox.userId';

/**
 * id 的**形状**。限制的理由不是洁癖:它要进 URL query(会被 URL 编码),
 * 还要在日志里与人眼里活下来 —— 空格/引号/emoji 会让排障变成猜谜。
 * 40 字符上限:够 UUID,又不至于把日志行撑爆。
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;

/** 形状不合(空串 / 带怪字符 / 非字符串)⇒ `null`(调用方据此**当作没给**)。 */
export function sanitizeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return ID_SHAPE.test(t) ? t : null;
}

/** 造一个短 id:`u_` + 12 位 base36(两段各 6 位,便于一眼看出是哪个实现造的)。 */
export function mintUserId(random: () => number = Math.random): string {
  const part = (): string => Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
  return `u_${part()}${part()}`;
}

/** 只用到这两个方法的**最小**存储面 —— 注入它就不用碰 `window`。 */
export interface IdentityStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ResolvedIdentity {
  userId: string;
  /** 这个 id 从哪来 —— 排障时**必须**能回答(「为什么我是新号」的答案在这里)。 */
  source: 'query' | 'storage' | 'minted';
}

/**
 * 定身份。三段各自可失败,**任一失败都不抛**:最坏情况是造一个新的(
 * 手机私密模式下 `localStorage` 会**抛**(不是返回 null),那时本次会话仍能玩)。
 */
export function resolveUserId(
  search: string,
  store: IdentityStore | null,
  mint: () => string = mintUserId,
): ResolvedIdentity {
  const fromQuery = sanitizeUserId(new URLSearchParams(search).get('user'));
  if (fromQuery !== null) return { userId: fromQuery, source: 'query' };

  let saved: string | null = null;
  try {
    saved = sanitizeUserId(store?.getItem(USER_ID_STORAGE_KEY) ?? null);
  } catch {
    saved = null;   /* 存储被禁 / 抛异常 ⇒ 当作没有 */
  }
  if (saved !== null) return { userId: saved, source: 'storage' };

  const made = mint();
  try {
    store?.setItem(USER_ID_STORAGE_KEY, made);
  } catch {
    /* 写不进去不影响本次会话:代价只是「下次刷新换个身份」 */
  }
  return { userId: made, source: 'minted' };
}

/**
 * 把 `userId` 合并进 WS 地址。
 *
 * ⚠️ **已有 `userId=` 时不覆盖** —— 显式写在 `?server=` 里的那个更具体,
 * 覆盖它会让「手填地址排障」变成一件不可靠的事。
 */
export function withUserId(url: string, userId: string): string {
  const at = url.indexOf('?');
  const base = at < 0 ? url : url.slice(0, at);
  const q = new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
  const existing = q.get('userId');
  if (existing === null || existing === '') q.set('userId', userId);
  const s = q.toString();
  return s === '' ? base : `${base}?${s}`;
}
