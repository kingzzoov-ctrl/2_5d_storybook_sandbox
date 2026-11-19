/**
 * 「输入避让」 —— 文本输入态下,动作键必须让路(第七轮审计 P2)。
 *
 * ## 修的是什么
 * 背包/配方面板按 `/` 进搜索态之后,`three/boot.ts` 的 `onSearchKey` 会吃字符键,
 * 但 `main.ts` 的 `ACTION_KEYS` 监听**不知道有搜索态这回事**:
 * ```
 * 搜索框里打 "e" ⇒ 查询串多一个 e(对)
 *                ⇒ 同时发出 BREAK_BLOCK 把面前那格拆了(错,且没有任何提示)
 * ```
 * 打 `q` / `g` / `f` / 空格同理(`q` 放置、`g` 丢下、`f` 拾取、空格攻击)。
 * 这类缺陷**不会让任何断言变红**:两条监听各自都"工作正常"。
 *
 * ## 为什么判定在本文件
 * 「要不要让路」是一个**纯判定**(键名 + 文本输入态),但它的两个输入分别住在
 * 两个不可测的地方(`main.ts` 的监听 + `boot.ts` 的闭包状态)⇒ 写在任一处都测不到。
 * 搬到本文件后:
 * ```
 * net/key_guard.ts   纯判定(零 DOM、零三方)
 * main.ts           每帧/每键 `guard.setTextInput(handle.textInputActive())` 后问它
 * three/boot.ts     只提供 `textInputActive()` 这一个读数(搜索态)
 * ```
 *
 * ## 口径:谁没被放行
 * `handles()` 只在**两件事同时成立**时放行:
 *  1 这个键**属于**动作表(`ACTION_KEYS` / 攻击键);
 *  2 当前**不是**文本输入态。
 * 其余一律 `false` —— 让上层"什么都不做",而不是"做了但没效果"。
 */

import { ACTION_KEYS } from './action_target.ts';

/** 动作键守卫。持有**唯一**一个状态位:当前是否在文本输入态。 */
export class ActionKeyGuard {
  private text = false;

  /** 由宿主在每次按键前同步一次(`boot` 的搜索态是唯一来源)。 */
  setTextInput(active: boolean): void {
    this.text = active === true;
  }

  /** 当前是否处于文本输入态(搜索框)。 */
  get textInputActive(): boolean {
    return this.text;
  }

  /**
   * 该键当前是否应当**交给动作处理**。
   *
   * ⚠️ 非动作键返回 `false` —— 这与"被文本输入挡掉"是**两种不同的原因**,
   * 调用方靠 `isActionKey()` 区分(否则自检口径里两者同形)。
   */
  handles(key: string): boolean {
    return this.isActionKey(key) && !this.text;
  }

  /** 该键是否属于动作表(与文本输入态无关)。 */
  isActionKey(key: string): boolean {
    return ACTION_KEYS[key.toLowerCase()] !== undefined;
  }

  /** 该键是不是**因为**文本输入态被挡掉的(自检口径:这才是本模块要抓的那一类)。 */
  blockedByTextInput(key: string): boolean {
    return this.isActionKey(key) && this.text;
  }
}