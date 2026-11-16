/**
 * **薄绑定** —— 键位/按钮 → `net/action_entry.ts` 的入口。**只转发,不判定**。
 *
 * ## 为什么单独一个文件
 * ```
 * action_entry.ts    纯逻辑:构建载荷 / 三个分支(非法 / 未连接 / 发) / 回执文案
 * action_binding.ts  ← 本文件:键位表 + 把宿主给的参数递给入口;**没有任何 IF 判定**
 * main.ts            装配根:注 `SessionHandle.sendAction` / `canSend`,并挂到 `window`
 * ```
 * 键位与按钮**共用同一条路**(`trigger`),所以「按 N」与「点合成按钮」
 * 跑的是同一段代码 —— 不存在两套入口(那正是本仓反复记的"两份实现迟早漂移")。
 *
 * ## ★ 可以在**没有 DOM** 的环境里被驱动(第 6 条判据)
 *
 * `attachKeyboard` 只要求一个**结构化**目标(`KeyEventTarget`)——
 * 浏览器里是 `window`,测试里是一个 10 行的假对象。`handleKey` 更是不碰任何全局:
 * ```ts
 * binding.handleKey('k')                 // ⇒ SLEEP 的结局
 * binding.handleKey('q')                 // ⇒ null(不属于本层,交回既有键位表)
 * ```
 * 手法与 `net/input.ts` 的 `attachKeyboard` 逐字同族(那里也是先抽纯逻辑、再包薄壳)。
 *
 * ## 键位怎么选的(不是随手挑的)
 * 必须**避开**已经有人占的键,否则一次按键会同时触发两件事(而两边都不报错):
 * ```
 * net/action_target.ts 的 ACTION_KEYS  q / e / g / f
 * three/boot.ts 的面板快捷键          i / r / e / p / b / z / y / x / c / escape
 * main.ts                             ' '(空格) = 攻击
 * net/input.ts 的 MOVE_KEYS           w / a / s / d(+ 四个方向键)
 * ⇒ 本层用 n / k / o / u / v / t(六个都不在以上任何一个集合里)
 * ```
 * `tests/WS-FND-35-client-entry.test.ts` 的 FND35-8 有一条判据钉住「与以上集合不重叠」。
 */

import {
  ActionEntry,
  type ActionPorts,
  type ChestInput,
  type CraftInput,
  type EntryOutcome,
  type UseItemInput,
} from './action_entry.ts';

/* ═══════════════════════════ 1. 槽位与键位表(唯一一处) ═══════════════════════════ */

/** 入口的六个槽位。UI 按钮与键位都映射到它。 */
export type EntrySlot = 'craft' | 'sleep' | 'openChest' | 'useOwnChest' | 'startParty' | 'useItem';

/**
 * 槽位 → **玩家读到的名字**。UI 按钮的标题取这里(提示行也取这里)——
 * 名字只有这一处,键位表只记"哪个键是哪个槽位"。
 */
export const ENTRY_SLOTS: Readonly<Record<EntrySlot, string>> = {
  craft: '合成',
  sleep: '睡觉',
  openChest: '开公共储物箱',
  useOwnChest: '开自己的储物箱',
  startParty: '派对开局',
  useItem: '使用道具',
};

/** 一条键位定义:这个键属于哪个槽位。 */
export interface EntryKeySpec {
  slot: EntrySlot;
}

/**
 * 键位表 —— **唯一一处**。
 *
 * 键名用 `KeyboardEvent.key.toLowerCase()`(与 `ACTION_KEYS` / `MOVE_KEYS` 同口径),
 * 不用 `code`:同一物理键在不同布局下 `code` 与 `key` 会分叉,而这里只关心"玩家按了哪个字母"。
 * ⚠️ 表里**不写文案**:文案在 `ENTRY_SLOTS`。两处各存一份名字,迟早漂。
 */
export const ENTRY_KEYS: Readonly<Record<string, EntryKeySpec>> = {
  n: { slot: 'craft' },
  k: { slot: 'sleep' },
  o: { slot: 'openChest' },
  u: { slot: 'useOwnChest' },
  v: { slot: 'startParty' },
  /*
   * `t` 给 `USE_ITEM`(TASK-99)。**为什么不是别的字母**:
   * 空闲集是 { h, j, l, m, t }(q/e/g/f 属 ACTION_KEYS,w/a/s/d 属 MOVE_KEYS,
   * i/r/p/b/z/y/x/c/escape 属 boot.ts 的面板键,空格属 main.ts 的攻击,
   * n/k/o/u/v 已被上面五个槽位占掉)。五个都能用,取 `t` 是因为它与既有键
   * **不同指**、也不落在 WASD 手位上(移动中按不到 ⇒ 不会一边跑一边误用道具),
   * 而 h/j/l/m 全在左手移动手位附近。
   */
  t: { slot: 'useItem' },
};

/** 一行提示(键与文案分别来自两张表,不手写第二份)。 */
export function entryKeyHints(): string {
  return Object.entries(ENTRY_KEYS)
    .map(([k, v]) => `${k.toUpperCase()} ${ENTRY_SLOTS[v.slot]}`)
    .join(' · ');
}

/* ═══════════════════════════ 2. 宿主必须提供的参数来源 ═══════════════════════════ */

/**
 * **键盘路径**需要的参数 —— 由宿主(`main.ts`)提供。
 *
 * 为什么是函数而不是快照值:参数要看"此刻"的玩家位置 / 当前选中的产物,
 * 在**按键那一刻**取一次才是对的(装配时取一次会永远用第一帧的值)。
 *
 * ⚠️ 按钮路径**不走这里**:点按钮的人本来就带着参数(选中了哪件产物、哪一格箱子),
 *    直接给 `TriggerArgs` 更准确,也让 UI 不必和宿主猜同一件事。
 */
export interface EntryInputs {
  /** 合成参数(产物 id + 背包明细)。 */
  craft(): CraftInput;
  /** 开箱的目标格(宿主用 `action_target.ts` 的 `cellUnder` / `cellInFront` 算)。 */
  chestCell(): { x: unknown; y: unknown };
  /** 房间已选派对模式的**回声**;拿不到返回 `undefined`(入口则不核对)。 */
  partyModeEcho(): unknown;
  /**
   * `USE_ITEM` 的参数(哪件道具、对谁用)。
   *
   * **可选**:装配根(`main.ts`)目前还没有"当前选中的道具"这一格来源
   * (`heldItemId` 在快照里恒 0,见 `main.ts` 的注释)⇒ 省掉它不会让宿主编译失败。
   * 省略时键盘路径按 `{}` 调构建器,入口会回一句"需要 itemId"而**不是**静默 ——
   * 这正是本层要保证的那条:按了没反应必须变成**按了有话说**。
   */
  useItem?(): UseItemInput;
}

/** 一次触发可显式给的参数(按钮路径用;省略的项回落到 `EntryInputs`)。 */
export interface TriggerArgs {
  /** 合成参数(给全 `itemId` + `have`)。 */
  craft?: CraftInput;
  /** 开箱的目标格。 */
  cell?: { x: unknown; y: unknown };
  /** 派对模式回声。 */
  partyMode?: unknown;
  /** `USE_ITEM` 的参数(哪件道具、对谁用;省略 `targetId` = 对自己用)。 */
  useItem?: UseItemInput;
}

/* ═══════════════════════════ 3. 键盘目标(结构化,不引 DOM 类型) ═══════════════════════════ */

/**
 * `attachKeyboard` 需要的最小形状 —— 便于用假对象测(与 `net/input.ts` 的
 * `KeyboardEventTarget` 同一手法:不 import DOM 类型,测试不需要 jsdom)。
 */
export interface KeyEventTarget {
  addEventListener(type: 'keydown', fn: (ev: { key: string; preventDefault(): void }) => void): void;
  removeEventListener(type: 'keydown', fn: (ev: { key: string; preventDefault(): void }) => void): void;
}

/* ═══════════════════════════ 4. 绑定 ═══════════════════════════ */

export interface ActionBinding {
  /** 被绑的入口(读 `status` / `sentCount` 用)。 */
  readonly entry: ActionEntry;
  /** **按钮路径**:UI 按钮直接调它。参数没给就回落到 `EntryInputs`。 */
  trigger(slot: EntrySlot, args?: TriggerArgs): EntryOutcome;
  /** **键盘路径**(无 DOM 也能调):本层的键返回结局,其余返回 `null`(交给别的监听器)。 */
  handleKey(key: string, args?: TriggerArgs): EntryOutcome | null;
  /** **挂到真 `window`**(有 DOM 才调)。返回解绑函数,与 `net/input.ts` 同契约。 */
  attachKeyboard(target: KeyEventTarget): () => void;
}

/**
 * 把入口接上键位/按钮。
 *
 * ⚠️ 本函数**不**判断"能不能发"(那是入口的 `ports.canSend()`)、
 *   **不**判断"参数对不对"(那是构建器)、**不**决定发什么(那是槽位表)。
 *   它只有一件事:**查表 + 递参数**。
 */
export function createActionBinding(opts: {
  entry: ActionEntry;
  inputs: EntryInputs;
}): ActionBinding {
  const { entry, inputs } = opts;

  const trigger = (slot: EntrySlot, args: TriggerArgs = {}): EntryOutcome => {
    switch (slot) {
      case 'craft':
        return entry.craft(args.craft ?? inputs.craft());
      case 'sleep':
        return entry.sleep();
      case 'openChest': {
        const cell = args.cell ?? inputs.chestCell();
        return entry.openChest({ x: cell.x, y: cell.y });
      }
      case 'useOwnChest': {
        const cell = args.cell ?? inputs.chestCell();
        return entry.useOwnChest({ x: cell.x, y: cell.y });
      }
      case 'startParty':
        return entry.startParty({ partyMode: args.partyMode ?? inputs.partyModeEcho() });
      /*
       * `USE_ITEM`:参数**先看显式给的**(按钮路径),再回落到宿主(键盘路径),
       * 都没有就按 `{}` 递给构建器 —— 由构建器说"需要 itemId",本层不替它判。
       */
      case 'useItem':
        return entry.useItem(args.useItem ?? inputs.useItem?.() ?? {});
    }
  };

  const handleKey = (key: string, args?: TriggerArgs): EntryOutcome | null => {
    const spec = ENTRY_KEYS[key.toLowerCase()];
    if (spec === undefined) return null;
    return trigger(spec.slot, args);
  };

  const attachKeyboard = (target: KeyEventTarget): (() => void) => {
    const onDown = (ev: { key: string; preventDefault(): void }): void => {
      const outcome = handleKey(ev.key);
      /* 只在**真的发了**的时候吞掉默认行为:
         未连接 / 参数不全时不该顺手把浏览器快捷键也吃掉(那会让人以为"键坏了")。 */
      if (outcome !== null && outcome.sent) ev.preventDefault();
    };
    target.addEventListener('keydown', onDown);
    return () => target.removeEventListener('keydown', onDown);
  };

  return { entry, trigger, handleKey, attachKeyboard };
}

/* ═══════════════════════════ 5. 装配端口(仍然是"薄"的) ═══════════════════════════ */

/**
 * 会话的最小形状 —— **结构类型**,不 import `SessionHandle`。
 *
 * 这样 `action_entry.ts` / 本文件都不会在顶层拿到一个**真 socket 实例**;
 * 真实例只出现在装配根(`main.ts`)里,由它调 `sessionPorts(session)` 注进来。
 * 两个字段的含义照抄 `net/session.ts`:
 * ```
 * state      'idle' | 'connecting' | 'live' | 'closed' | 'failed'
 * sendAction 未连接返回 false(不抛、不假装成功)
 * ```
 */
export interface SessionLike {
  readonly state: string;
  sendAction(intent: { action: string; [k: string]: unknown }): boolean;
}

/**
 * 把 `SessionHandle` 适配成入口端口。
 *
 * `canSend` 的判据是**两条都给齐**:连接态是 `live`(= 握手 `welcome` 已到,
 * 见 `session.ts` 里 `setState('live')` 的位置)**且**会话对象存在。
 * 只判 "socket 是不是 OPEN" 会在握手完成前放行,而服务端的 `onAction`
 * 对 `helloDone === false` 的报文是**丢弃**的(连回执都没有)——
 * 那正是"发了等于没发"的静默形态。
 */
export function sessionPorts(session: () => SessionLike | null): ActionPorts {
  return {
    sendAction: (intent) => {
      const s = session();
      return s === null ? false : s.sendAction(intent);
    },
    canSend: () => {
      const s = session();
      return s !== null && s.state === 'live';
    },
  };
}