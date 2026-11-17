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
 *
 * ## 用法(2026-11-17 补:此处**曾经是空输出**)
 *
 * ```
 * node scripts/dead_items.ts                                 # 打印三件死道具现状 + 自检
 * import { DEAD_ITEMS } from '../scripts/dead_items.ts';     # 判据用法(tests/WS-FND-17)
 * ```
 *
 * ⚠️ **它不是 `verify.ts` 的消费对象**:`verify.ts` 里没有任何一处 import 本文件。
 *    真实的消费者只有一个 —— `tests/WS-FND-17-room-c-and-dead-items.test.ts`(FND17-6)。
 *
 * ⚠️ 2026-11-17 之前的症状:`node scripts/dead_items.ts` **一个字符都不打印**。
 *    原因是文件里只有 export、没有入口块 ——
 *    于是「跑它看看这三件现在什么状态」这件事**静默返回空**,
 *    而空输出既可以被读成「三件都已实装」、也可以被读成「脚本坏了」:
 *    两种读法都不会红。**这正是本仓反复记的那类静默失败。**
 *
 * ⇒ 现在文件末尾有 `import.meta.main` 守卫的入口块(与 `verify.ts:7266` 同一写法):
 *    直接跑 ⇒ 逐条打印 + 自检,登记表自相矛盾时 **exit code 1**;
 *    被 import(tests/WS-FND-17)⇒ **一行都不打印**,不污染测试输出。
 *    ⚠️ 不要改用 `process.argv[1]` 比对:`verify.ts:7263` 已记过原因。
 *
 * ⚠️ 接口**未变**:`DEAD_ITEMS` / `DEAD_ITEM_BY_ID` 两个 export 名字与形状都不动
 *    (FND17-6 直接 import 它们)。本批只**加**入口块,不改登记表内容。
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
    reason: '使用入口**已接**(`USE_ITEM` → `combat/revive.ts` 的 `featherRevive`,判据 `WS-FND-39` FND39-3):'
      + '6 格内命中幽灵泡泡队友 ⇒ 满血复活 + 3 秒无敌;仍缺:**投掷弹道** —— 现在是"点目标即生效",'
      + '没有飞行物与落点判定(所以隔墙也能用)',
  },
  {
    id: 435,
    name: '四色队伍出生复活旗',
    implemented: false,
    consumer: null,
    reason: '旗**范围复活**已接(`WorldSim.tickDowned` 的旗优先半血复活,判据 `WS-FND-49` FND49-9/10);'
      + '仍缺:**四色队伍归属(红/蓝/黄/绿)**与"呼救"流程 —— `PARTY_MODES`(手册 §6.3)已定义四色模式,'
      + '但竞技队伍状态机未实装',
  },
  {
    id: 227,
    name: '泡泡连发水枪',
    implemented: false,
    consumer: null,
    reason: '两个半边都**已接**:活人半边(`combat/live_bubble.ts`,连中 3 发装泡泡)与器件半边'
      + '(`USE_ITEM` + `extinguishDeviceByHand` 浇灭料理站炉火),判据 `WS-FND-49` FND49-11 / `WS-FND-52`;'
      + '仍缺:水枪弹道对**高炉火苗**(coop 工位槽位没有世界坐标)与**火灵护盾**的判定',
  },
];

/** 按 id 索引,便于断言与将来的消费点查表。 */
export const DEAD_ITEM_BY_ID: ReadonlyMap<number, (typeof DEAD_ITEMS)[number]> =
  new Map(DEAD_ITEMS.map((d) => [d.id, d]));

/* ══════════════════ 入口:打印现状 + 自检 ══════════════════
 *
 * 为什么需要它:`node scripts/dead_items.ts` 此前是**空输出** ——
 * 文件里只有 export、没有 main ⇒ 跑它等于什么都没发生,
 * 而「空输出」与「三件都已实装」在肉眼上**不可区分**。这就是要消灭的静默。
 *
 * ⚠️ 守卫必须是 `import.meta.main`(Node 24 实测为 boolean;`node -e` 形态下
 *    `process.argv[1]` 是 `[eval]`,比对会抛错 —— 见 `verify.ts:7263`):
 *    `tests/WS-FND-17` import 本文件时 `main === false` ⇒ 这段一次都不执行。
 */
if (import.meta.main) {
  const rule = '─'.repeat(74);
  const bad: string[] = [];
  console.log('\n══ 三件死道具现状(冻结内容表里的 733 / 435 / 227)══\n');
  for (const d of DEAD_ITEMS) {
    /* 自检,与 `tests/WS-FND-17` FND17-6 同一判据:
       声称已实装却没写消费点 = 过度声称;未实装却有消费点 = 自相矛盾。 */
    if (d.implemented && (d.consumer === null || d.consumer.trim().length === 0)) {
      bad.push(`${d.id} ${d.name}:implemented true 但 consumer 为空(过度声称)`);
    } else if (!d.implemented && d.consumer !== null) {
      bad.push(`${d.id} ${d.name}:implemented false 但 consumer 非 null(自相矛盾)`);
    }
    console.log(`  【${d.implemented ? '已实装' : '未实装'}】${d.id} ${d.name}`);
    console.log(`      消费点:${d.consumer ?? '(无 —— 未实装时按约定必为 null)'}`);
    console.log(`      仍缺什么:${d.reason}`);
    console.log(`  ${rule}`);
  }
  const done = DEAD_ITEMS.filter((d) => d.implemented).length;
  console.log(`  统计:${done} / ${DEAD_ITEMS.length} 已实装;其余**未实装**,不是**不存在**。`);
  console.log('  裁决(外部审计 U2,2026-11-14):保留定义 + 显式标记未实装,**不删内容表** ——');
  console.log('    删条目会打红 `content-lock` 指纹、破坏配方 ID 引用、让存档失效。');
  console.log('  钉住它的判据:tests/WS-FND-17-room-c-and-dead-items.test.ts 的 FND17-6。');
  console.log('  接口:本文件导出 DEAD_ITEMS / DEAD_ITEM_BY_ID(上面那个测试消费)—— 未变。');
  if (bad.length > 0) {
    console.log(`\n  ✗ 登记表自相矛盾(${bad.length} 处):`);
    for (const b of bad) console.log(`      ${b}`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ✓ 登记表自洽(${DEAD_ITEMS.length} 条 implemented / consumer 一一对应)\n`);
  }
}
