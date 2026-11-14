/**
 * 三件**死道具**的显式裁决(档 C 第三项)。
 *
 * ## 什么是「死道具」
 *
 * `shared/constants/items.ts`(320 件,冻结层)里有三件物品:
 * ```
 * 733 复苏天使羽毛笔   —— 扔向倒地队友,隔 6 格瞬间满血复活 + 3 秒无敌
 * 435 四色队伍出生复活旗 —— 四队归属 + 呼救复活
 * 227 泡泡连发水枪     —— 扑灭高炉火苗、浇灭火灵护盾;连射队友 3 发装进大泡泡
 * ```
 * 它们**有定义、有配方、有手册说明**,但全仓**没有任何生产消费点** ——
 * 即「内容表里有,游戏里拿不到效果」。
 *
 * ## 裁决(外部审计 U2,2026-11-14)
 *
 * ```
 * 保留定义 + 显式标记「未实装」,**不删内容表**。
 * ```
 * ⚠️ 为什么**不许删**:`scripts/content-lock.ts` 的指纹基线锁在
 * `shared/constants/items.ts` 上(320 件 / 可用号 3775)。删条目会
 * ① 触发内容基线锁报警 ② 破坏 ID 引用闭合(配方里引用它们) ③ 让存档失效。
 * ⇒ 「没实装」是一件**待办**,不是一件**不存在**;删掉就等于把待办隐藏起来。
 *
 * ## 这张表的作用
 *
 * 把「三件死道具」从**散落在文档里的一个说法**变成**可断言的事实**:
 * `tests/WS-FND-17` 逐条检查(a)它们仍在冻结内容表里、(b)在这里有裁决。
 * ⇒ 谁哪天真的实现了某件,会把对应条目改成 `implemented: true` 并补消费点;
 *   谁哪天顺手删了内容表条目,会**当场红**。
 */

/**
 * 死道具清单。`implemented` **只有在这件道具真的有生产消费点时**才为 `true`。
 *
 * ⚠️ 判据不是「代码里提到它」——提到不算消费点。
 *    `tests/WS-FND-17` 对 `implemented: false` 的条目只断言「仍在表里 + 有裁决」,
 *    对 `true` 的条目会要求给出消费点位置(`consumer` 非空)。
 */
export const DEAD_ITEMS: readonly {
  id: number;
  name: string;
  implemented: boolean;
  /** `implemented: true` 时必填:消费点在哪(文件 + 符号)。 */
  consumer: string | null;
  /** 未实装的原因 —— 必须写清「缺什么」,不是「TODO」。 */
  reason: string;
}[] = [
  {
    id: 733,
    name: '复苏天使羽毛笔',
    implemented: false,
    consumer: null,
    reason: '复活机制本身在岗(`server/src/combat/revive.ts` 的倒地/宽限),'
      + '但这件道具的**使用入口**(投掷命中 6 格内的幽灵泡泡队友 ⇒ 立即复活 + 3 秒无敌)没有实现,'
      + '也没有投掷物命中队友的判定点',
  },
  {
    id: 435,
    name: '四色队伍出生复活旗',
    implemented: false,
    consumer: null,
    reason: '缺**队伍归属(红/蓝/黄/绿)**与旗帜范围内的复活点判定;'
      + '`PARTY_MODES`(手册 §6.3)已定义四色模式,但竞技队伍状态机未实装',
  },
  {
    id: 227,
    name: '泡泡连发水枪',
    implemented: false,
    consumer: null,
    reason: '缺①水枪弹道对**高炉火苗 / 火灵护盾**的灭火判定 ②把队友装进大泡泡的抓取效果;'
      + '`prank` 家族有免疫与玩具的骨架,但没有这条弹道消费点',
  },
];

/** 按 id 索引,便于断言与将来的消费点查表。 */
export const DEAD_ITEM_BY_ID: ReadonlyMap<number, (typeof DEAD_ITEMS)[number]> =
  new Map(DEAD_ITEMS.map((d) => [d.id, d]));
