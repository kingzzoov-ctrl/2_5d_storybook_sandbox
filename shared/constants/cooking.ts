/**
 * 料理参数槽的内容表(冻结层旁的内容层)。
 *
 * ## 为什么这里只有中性默认
 *
 * 裁决来源:owner 2026-11-17 授权「冻结层解锁」,本表对应其中的「烹饪 6 字段」
 * (`shared/types/cooking.ts`),登记见 `shared/contracts/FREEZE.md` 的 D-19 条。
 *
 * **手册没有给出这 6 个槽的任何强度数值。** 因此本表只登记:
 *   1. 槽名(与 `FoodBuffParams` 逐键对齐);
 *   2. 合并律(flat = 相加 / mul = 相乘);
 *   3. **中性默认**(加 0 / 乘 1)。
 *
 * 中性值是**单位元**,不是平衡裁决;真实强度**待平衡**,不在此发明数字。
 * 表里的 `neutral` 与 `NEUTRAL_FOOD_BUFF_PARAMS` 是两份数据(一份给内容层读、
 * 一份给代码读),`tests/WS-FND-66-frozen-unlock.test.ts` 逐槽比对两者防漂移。
 */

import type { FoodBuffParams } from '../types/cooking.ts';

/** 一个参数槽的登记项。 */
export interface FoodParamSlot {
  /** 槽名,与 `FoodBuffParams` 的键一一对应 */
  key: keyof FoodBuffParams;
  /** 合并律:`flat` = 相加,`mul` = 相乘 */
  kind: 'flat' | 'mul';
  /** 中性值(单位元) */
  neutral: number;
  /** 边界备注 */
  note: string;
}

/** 6 个参数槽的登记表(中性默认,**待平衡**)。 */
export const FOOD_PARAM_SLOTS: readonly FoodParamSlot[] = [
  { key: 'defFlat', kind: 'flat', neutral: 0, note: '待平衡:手册未给数值,当前只有中性默认 0' },
  { key: 'moveMul', kind: 'mul', neutral: 1, note: '待平衡:手册未给数值,当前只有中性默认 1' },
  { key: 'gravityMul', kind: 'mul', neutral: 1, note: '待平衡:手册未给数值,当前只有中性默认 1' },
  { key: 'jumpMul', kind: 'mul', neutral: 1, note: '待平衡:手册未给数值,当前只有中性默认 1' },
  { key: 'gatherMul', kind: 'mul', neutral: 1, note: '待平衡:手册未给数值,当前只有中性默认 1' },
  { key: 'expMul', kind: 'mul', neutral: 1, note: '待平衡:手册未给数值,当前只有中性默认 1' },
];

/** 参数槽总数(判据:恒等于 `FoodBuffParams` 的键数)。 */
export const FOOD_PARAM_SLOT_COUNT = 6;