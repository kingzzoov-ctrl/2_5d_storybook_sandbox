/**
 * 面板/工具键位表 —— **唯一一处**(第七轮审计 P1:『e』双绑)。
 *
 * ## 修的是什么
 * 修前 `three/boot.ts` 的 `onKeyDown` 把 `e` 绑成「开画架」,而
 * `net/action_target.ts` 的 `ACTION_KEYS` 把 `e` 绑成「拆除面前那格」,
 * 两处**各自正确**、合起来是**一次按键两件事**:
 * ```
 * 按 E ⇒ 画架面板打开(看不见的副作用)
 *      + BREAK_BLOCK 发到服务端(脚下南侧那格被拆)
 * ```
 * 而 `net/action_binding.ts` 的文件头当时还写着「面板键 i/r/e/p/b…」与
 * 「ACTION_KEYS q/e/g/f」**互不重叠** —— 那句话本身就是错的(同一个 `e` 在两边),
 * 所以"贴着注释读代码"也查不出来。
 *
 * ## 为什么搬到本文件(而不是继续写在 boot.ts 里)
 * `three/boot.ts` 顶层 `import three`、还要 `document` ⇒ **node 里加载不了**
 * ⇒ 任何"键位互不重叠"的判据都无法直接读它。键位表搬到这里之后:
 * ```
 * ui/panel_keys.ts   纯常量 + 纯函数(零三方、零 DOM)
 * three/boot.ts      只做 `PANEL_KEYS[key] → setPanel(...)` 的转发
 * ```
 * 判据(`tests/WS-FND-126-client-chain.test.ts`)于是可以**真的**比对四张表的键集。
 *
 * ## 键是怎么选的
 * ## 键是怎么选的
 * 空闲字母集是 `{ j, l, m }`(q/e/g/f 属 ACTION_KEYS,w/a/s/d 属 MOVE_KEYS,
 * n/k/o/u/v/t 属 ENTRY_KEYS,i/r/p 已被面板占用,z/y/x/c 是画架工具键)。
 * 画架从 `e` 挪到 `h`:与 `e`(拆除)不同指,也不在 WASD 手位上。
 *
 * ★ 第十轮:还要给四个「服务端已实现、客户端零入口」的动作补键,
 *   而空闲字母**不够**(只剩 j/l/m,要放四个)⇒ 第二张表是**数字热键条**
 *   (`net/action_binding.ts` 的 `HOTBAR_KEYS`:1/2/3/4)。数字键同样进
 *   `keyGroups()` ⇒ 与上面任何一组撞车都会当场红,不靠人肉核对。
 */

import { ACTION_KEYS } from '../net/action_target.ts';
import { ENTRY_KEYS, HOTBAR_KEYS } from '../net/action_binding.ts';
import { MOVE_KEYS } from '../net/input.ts';
import { UiPanel } from './state_machine.ts';

/**
 * 面板快捷键:按一下把某个面板开/关(走 `UiStateMachine` 的合法迁移)。
 *
 * ⚠️ 表里**不写文案**:文案由 `keysHint` 之类在使用点拼,名字只有 `UiPanel` 一处。
 */
export const PANEL_KEYS: Readonly<Record<string, UiPanel>> = {
  i: UiPanel.INVENTORY,
  r: UiPanel.RECIPE_TREE,
  /* ★ 第七轮 P1:画架从 `e` 挪到 `h` —— `e` 是 ACTION_KEYS 的「拆除」 */
  h: UiPanel.PIXEL_EASEL,
  p: UiPanel.PITCH_EDITOR,
};

/** 画架工具键(只在画架打开时有效):撤销 / 重做 / 清空 / 填充 */
export const EASEL_TOOL_KEYS: readonly string[] = ['z', 'y', 'x', 'c'];

/** demo Boss 血条开关键(只在快照里没有权威 boss 时有意义) */
export const BOSS_DEMO_KEY = 'b';

/** 进背包/配方搜索态的键 */
export const SEARCH_KEY = '/';

/** 6 档缩放的缩小/放大键(`stage/iso_camera.stepZoom` 的两个方向) */
export const ZOOM_KEYS: readonly string[] = ['[', ']'];

/** 关面板键(`KeyboardEvent.key` 的小写形态) */
export const CLOSE_PANEL_KEY = 'escape';

/** 攻击键(`main.ts` 的 `attackNearest`;`InputSource` 同时把它当跳跃锁存) */
export const ATTACK_KEY = ' ';

/** 一组键位:名字只用于报错/自检文案。 */
export interface KeyGroup {
  name: string;
  keys: readonly string[];
}

/**
 * 全部键位组 —— **互不重叠**是本仓的一条硬约束
 * (重叠 = 一次按键两件事,而两边都不报错)。
 *
 * 组是从**各表本身**算出来的,不是手抄的第二份清单:
 * 谁改了 `ACTION_KEYS` / `ENTRY_KEYS` / `HOTBAR_KEYS` / `PANEL_KEYS`,这里会自动跟着变。
 */
export function keyGroups(): KeyGroup[] {
  const move: string[] = [
    ...MOVE_KEYS.up, ...MOVE_KEYS.down, ...MOVE_KEYS.left, ...MOVE_KEYS.right,
  ];
  return [
    { name: 'ACTION_KEYS(建造/拆/丢/捡)', keys: Object.keys(ACTION_KEYS) },
    { name: 'ENTRY_KEYS(合成/睡觉/开箱/派对/用道具)', keys: Object.keys(ENTRY_KEYS) },
    { name: 'HOTBAR_KEYS(驯养/购买/炼金/自动化)', keys: Object.keys(HOTBAR_KEYS) },
    { name: 'MOVE_KEYS(WASD + 方向键)', keys: move },
    { name: 'PANEL_KEYS(面板)', keys: Object.keys(PANEL_KEYS) },
    { name: 'EASEL_TOOL_KEYS(画架工具)', keys: EASEL_TOOL_KEYS },
    { name: '单键(搜/缩/关/Boss/攻击)', keys: [SEARCH_KEY, ...ZOOM_KEYS, CLOSE_PANEL_KEY, BOSS_DEMO_KEY, ATTACK_KEY] },
  ];
}

/** 一处键位冲突:同一个键落在多个组里。 */
export interface KeyCollision {
  key: string;
  groups: string[];
}

/**
 * 找出**同时**属于多个键位组的键。
 *
 * `groups` 可注入 —— 判据需要喂一份"故意重叠"的表来证明检测器有牙齿
 * (否则「返回空数组」既可能是真的互斥,也可能是检测器恒真)。
 */
export function keyCollisions(groups: readonly KeyGroup[] = keyGroups()): KeyCollision[] {
  const at = new Map<string, string[]>();
  for (const g of groups) {
    for (const k of g.keys) {
      const list = at.get(k) ?? [];
      list.push(g.name);
      at.set(k, list);
    }
  }
  const out: KeyCollision[] = [];
  for (const [key, names] of at) {
    if (names.length > 1) out.push({ key, groups: names });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** 互斥性总判据:`true` = 没有任何键同时绑两件事。 */
export function keyGroupsExclusive(groups: readonly KeyGroup[] = keyGroups()): boolean {
  return keyCollisions(groups).length === 0;
}

/** 面板键 → 界面上的名字(`UiPanel` 是机器名,这里是给人看的那一份)。 */
export const PANEL_LABEL: Readonly<Record<string, string>> = {
  INVENTORY: '背包',
  RECIPE_TREE: '配方',
  PIXEL_EASEL: '画架',
  PITCH_EDITOR: '音高',
};

/**
 * 一行面板提示(`I 背包 · R 配方 · H 画架 · P 音高`)。
 *
 * 由 `PANEL_KEYS` 生成 —— 键改了提示自动跟着改,
 * 不会出现"提示写着 E、实际按 H"那种只在截图上才看得出的事。
 */
export function panelKeyHints(): string {
  return Object.entries(PANEL_KEYS)
    .map(([k, p]) => `${k.toUpperCase()} ${PANEL_LABEL[p] ?? String(p)}`)
    .join(' · ');
}

/** 某个键是不是面板键(是则返回面板名,否则 `null`)。 */
export function panelKeyOf(key: string): UiPanel | null {
  const p = PANEL_KEYS[key.toLowerCase()];
  return p === undefined ? null : p;
}