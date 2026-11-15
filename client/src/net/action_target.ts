/**
 * 客户端**动作目标**与**动作文案** —— 纯函数,不碰 `document` / `window`。
 *
 * ## 为什么单独一个模块
 *
 * 浏览器入口(`main.ts`)是不可测的:它 import 的那一刻就要 `document`,
 * 在 Node 里连加载都做不到 ⇒ 写成"能测"的唯一办法是**把判定抽出来**。
 * 这正是本仓 `client/src/net/prediction.ts` / `predictor.ts` 的同一手法:
 * 可测的判定与不可测的胶水分开。
 *
 * 于是本文件里三件事各只有**一处实现**:
 * ```
 * 目标格    cellUnder / cellInFront   ← 键按下时要用它决定动哪一格
 * 键位表    ACTION_KEYS               ← 界面提示与键处理共用同一张表
 * 文案      describeActionResult      ← "被拒"与"没权限"给玩家的话不一样
 * ```
 *
 * ## 为什么目标格要"面前那格"而不是鼠标所指
 *
 * 鼠标拾取需要射线与相机矩阵 —— 那是渲染层的事,会把本模块拖成不可测。
 * 而快照里**没有**可用的朝向字段(`PlayerState.dir` 的语义在 wire 里没有
 * 写明,不确定是象限还是角度)⇒ 所以朝向由调用方传**运动方向向量**
 * (客户端本来就知道自己按了什么键),缺省向下。这是显式取舍,不是猜。
 */

/** 一格(整数坐标)。 */
export interface Cell {
  x: number;
  y: number;
}

/** 一个平面方向(不需要归一化;只取符号)。 */
export interface Facing {
  dx: number;
  dy: number;
}

/** 缺省朝向:向下(+y)。等距视角里"屏幕下方"通常对应 +y。 */
export const FACING_DEFAULT: Facing = { dx: 0, dy: 1 };

/**
 * 玩家**脚下**那一格(拆块/自己站的地方)。
 * `Math.floor`:权威坐标是浮点(如 `12.5`),格 = 向下取整 ——
 * 与 `WorldSim.blockAt` 的取整**必须同一口径**,否则"客户端以为在拆 A 格、
 * 服务端拆的是 B 格",而两边都不报错。
 */
export function cellUnder(pos: { x: number; y: number }): Cell {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y) };
}

/**
 * 玩家**面前**那一格(放块/拆对面)。
 *
 * 朝向只取符号:`dx > 0` 往 +x,`dx < 0` 往 -x,`dx === 0` 不动 x。
 * 两个分量都非零时**只取一个**(优先 x):斜着站时不该同时判定两格,
 * 否则"面前"是 2 格,玩家会觉得点一次放了两下。
 */
export function cellInFront(pos: { x: number; y: number }, facing: Facing = FACING_DEFAULT): Cell {
  const base = cellUnder(pos);
  if (facing.dx > 0) return { x: base.x + 1, y: base.y };
  if (facing.dx < 0) return { x: base.x - 1, y: base.y };
  if (facing.dy > 0) return { x: base.x, y: base.y + 1 };
  if (facing.dy < 0) return { x: base.x, y: base.y - 1 };
  return base;
}

/** 一条键位定义。 */
export interface ActionKey {
  /** 线上动作名(`RoomAction` 的字符串形式)。 */
  action: string;
  /** 目标格怎么取:`front` = 面前那格,`under` = 脚下那格。 */
  target: 'front' | 'under';
  /** 界面提示用的短语。 */
  label: string;
}

/**
 * 键位表 —— **唯一一处**。
 *
 * 键的取值是 `KeyboardEvent.key`(小写比较),不是 `code`:
 * `code` 在小键盘/输入法布局下会变,而这里只关心"玩家按了哪个字母"。
 */
export const ACTION_KEYS: Readonly<Record<string, ActionKey>> = {
  q: { action: 'PLACE_BLOCK', target: 'front', label: '放置(面前那格)' },
  e: { action: 'BREAK_BLOCK', target: 'front', label: '拆除(面前那格)' },
  g: { action: 'DROP_ITEM', target: 'under', label: '丢下(1 件)' },
  f: { action: 'PICKUP_ITEM', target: 'under', label: '拾取(最近那件)' },
};

/** 菜单/帮助里那一行提示(由 ACTION_KEYS 生成,不手写第二份)。 */
export function keyHints(): string {
  return Object.entries(ACTION_KEYS)
    .map(([k, v]) => `${k.toUpperCase()} ${v.label}`)
    .join(' · ');
}

/** 动作回执的最小形状(与 `ActionResultFrame` 对齐,但不 import 它 —— 保持本模块零依赖)。 */
export interface ActionResultLike {
  ok: boolean;
  kind: string;
  action: string;
  reason?: string;
}

/**
 * 把一次动作回执变成**一行玩家能读的话**。
 *
 * ## 为什么分类必须转成不同的话
 * `PERMISSION`(你没这个权限)与 `INVALID`(那儿放不了 / 你没这件东西)对玩家
 * 是两件完全不同的事 —— 混成一句"操作失败"就等于把服务端辛苦分开的分类又丢了。
 */
export function describeActionResult(r: ActionResultLike): string {
  const what = ACTION_KEYS[Object.keys(ACTION_KEYS).find((k) => ACTION_KEYS[k]!.action === r.action) ?? '']?.label
    ?? r.action;
  if (r.ok) return `${what} ✓`;
  switch (r.kind) {
    case 'PERMISSION':
      return `${what} ✗ 你没有这个权限`;
    case 'NOT_IMPLEMENTED':
      return `${what} ✗ 这一版还没做`;
    case 'ROOM_CLOSED':
      return `${what} ✗ 房间已关闭`;
    case 'INVALID':
      return `${what} ✗ ${r.reason ?? '那儿做不了'}`;
    default:
      return `${what} ✗ ${r.kind}${r.reason === undefined ? '' : `:${r.reason}`}`;
  }
}

/**
 * 背包那一行要显示的件数文案(`null` = 还不知道)。
 *
 * ⚠️ 快照里**没有**背包明细(只有总量投影),所以这里只能显示**总量** ——
 * 显示明细要先把 wire 的字段表扩出来,那是独立一件。**不假装有明细**。
 */
export function inventoryLine(total: number | null, capacity: number | null): string {
  if (total === null) return '背包 (未知)';
  if (capacity === null) return `背包 ${total} 件`;
  return `背包 ${total}/${capacity} 件`;
}
