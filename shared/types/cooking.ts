/**
 * 料理参数槽契约(冻结层)。
 *
 * ## 谁授权它进冻结层
 *
 * owner 2026-11-17 授权「冻结层解锁」(`docs/DECISIONS.md` + `docs/RULINGS-DRAFT.md`
 * 抬头),本文件对应其中「烹饪 6 字段」一项;登记见 `shared/contracts/FREEZE.md`
 * 的 D-19 条。**放宽必须留痕,不许静默放宽。**
 *
 * ## 这 6 个槽是什么
 *
 * `server/src/combat/cooking.ts` 的 `FoodBuff.statMods` 目前只有「加数值」一类
 * (atk/hp/…),于是所有料理只能用**加法**表达效果。这一层补的是 6 个**中性槽**:
 *
 * | 槽 | 语义 | 中性值 | 合并律 |
 * | :--- | :--- | :--- | :--- |
 * | `defFlat` | 减伤/护甲(平加) | `0` | 相加 |
 * | `moveMul` | 移速倍率 | `1` | 相乘 |
 * | `gravityMul` | 重力倍率(轻身/沉重) | `1` | 相乘 |
 * | `jumpMul` | 跳跃/投掷高度倍率 | `1` | 相乘 |
 * | `gatherMul` | 采集速度/产量倍率 | `1` | 相乘 |
 * | `expMul` | 共享经验倍率 | `1` | 相乘 |
 *
 * ## ⚠️ 中性值来自定义,不是平衡裁决
 *
 * `0` / `1` 是**单位元**(加 0、乘 1 等于什么都没做),不是调出来的强度。
 * 手册没有给这 6 个槽的任何数值 ⇒ 内容表(料理)只保留中性默认,
 * **不发明平衡数字**,真实数值留给平衡批次(见 `shared/constants/cooking.ts`)。
 */

/** 料理 buff 的 6 个参数槽。 */
export interface FoodBuffParams {
  /** 减伤/护甲(平加,单位与 combat 的 def 一致) */
  defFlat: number;
  /** 移速倍率(1 = 不变) */
  moveMul: number;
  /** 重力倍率(1 = 不变) */
  gravityMul: number;
  /** 跳跃/投掷高度倍率(1 = 不变) */
  jumpMul: number;
  /** 采集速度/产量倍率(1 = 不变) */
  gatherMul: number;
  /** 共享经验倍率(1 = 不变) */
  expMul: number;
}

/**
 * 中性默认值:平加类 0、倍率类 1。
 *
 * **这是单位元,不是平衡裁决** —— 手工里没有给出这 6 个槽的数值,
 * 所以内容表只登记中性默认,具体强度待平衡批次。
 */
export const NEUTRAL_FOOD_BUFF_PARAMS: Readonly<FoodBuffParams> = Object.freeze({
  defFlat: 0,
  moveMul: 1,
  gravityMul: 1,
  jumpMul: 1,
  gatherMul: 1,
  expMul: 1,
});

/** 6 个槽的键名(顺序即参数表顺序)。 */
export const FOOD_BUFF_PARAM_KEYS: readonly (keyof FoodBuffParams)[] = [
  'defFlat', 'moveMul', 'gravityMul', 'jumpMul', 'gatherMul', 'expMul',
];

/** 平加类槽(合并时相加)。 */
export const FOOD_BUFF_FLAT_KEYS: readonly (keyof FoodBuffParams)[] = ['defFlat'];

/** 倍率类槽(合并时相乘)。 */
export const FOOD_BUFF_MUL_KEYS: readonly (keyof FoodBuffParams)[] = [
  'moveMul', 'gravityMul', 'jumpMul', 'gatherMul', 'expMul',
];

/** 该槽是不是倍率类(否则按平加处理)。 */
export function isFoodBuffMulKey(key: keyof FoodBuffParams): boolean {
  return FOOD_BUFF_MUL_KEYS.includes(key);
}

/**
 * 用局部覆盖生成完整参数:缺省槽补中性值。
 *
 * 用途:内容表只写「非中性」的槽,其余由本函数补位 —— 避免每份食谱都抄一遍 6 个字段,
 * 也避免抄错时把"没写"静默变成 `undefined`(那会让 `base * undefined = NaN`)。
 */
export function withFoodBuffParams(mods: Partial<FoodBuffParams> = {}): FoodBuffParams {
  const out: FoodBuffParams = { ...NEUTRAL_FOOD_BUFF_PARAMS };
  for (const k of FOOD_BUFF_PARAM_KEYS) {
    const v = mods[k];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) throw new Error(`料理参数 ${k} 非有限数:${String(v)}`);
    out[k] = v;
  }
  return out;
}

/**
 * 两份参数合并:平加类相加、倍率类相乘(结合律成立,故多份 buff 与顺序无关)。
 *
 * 中性元的表现:与 `NEUTRAL_FOOD_BUFF_PARAMS` 合并**恒等于对方** —— 这是判据,
 * 也是「中性值不是拍出来的强度」的可执行证据。
 */
export function mergeFoodBuffParams(a: FoodBuffParams, b: FoodBuffParams): FoodBuffParams {
  const out: FoodBuffParams = { ...NEUTRAL_FOOD_BUFF_PARAMS };
  for (const k of FOOD_BUFF_PARAM_KEYS) {
    out[k] = isFoodBuffMulKey(k) ? a[k] * b[k] : a[k] + b[k];
  }
  return out;
}

/** 是否恰好等于中性参数(逐字段,含 `+0` / `-0` 区分)。 */
export function isNeutralFoodBuffParams(p: FoodBuffParams): boolean {
  for (const k of FOOD_BUFF_PARAM_KEYS) {
    if (!Object.is(p[k], NEUTRAL_FOOD_BUFF_PARAMS[k])) return false;
  }
  return true;
}