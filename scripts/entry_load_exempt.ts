/**
 * **入口可加载性豁免登记** —— 单一事实来源。
 *
 * ## 为什么单独一个文件(而不是放在 `verify.ts` 里导出)
 *
 * `scripts/verify.ts` **没有导出、且顶层直接执行整个门禁**。
 * 若把这张表放在它里面:
 * ```
 * 测试 import { ENTRY_LOAD_EXEMPT } from '../scripts/verify.ts'
 *   ⇒ 会**顺带把整个门禁跑一遍**(可达性/文档/内容/集成全跑)
 *   ⇒ 测试里再嵌套跑门禁 ⇒ 表里会多出「门禁自己跑自己」的输出 ⇒ 假绿/假红
 * ```
 * ⇒ 所以抽成这个**零副作用**模块:`verify.ts` 与测试**都 import 它**。
 *
 * ⚠️ **这也是「不要抄一份名单」的实现**:本仓已多次踩到「两份实现并存」
 * (最近一次是 task-47 的 `wearingOf` / `syncPlayers` 互相顶着,
 * 单点注入查不出 —— 见 `docs/PROGRESS.md` 陷阱 31/41)。
 * 谁需要这张表就 import,不许复制。
 *
 * ## 判据(由 `verify.ts` 的 `checkEntryLoadable` 执行)
 *
 * ```
 * PROD_ENTRIES 里 **不在本表** 的入口 ⇒ 必须能被 Node 加载
 *   判据用**错误类型**,不用消息字符串(消息白名单必然漏 —— 实测踩过)
 *   name === 'SyntaxError' 或 code ∈ { ERR_MODULE_NOT_FOUND,
 *     ERR_INVALID_TYPESCRIPT_SYNTAX, ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX }
 *   其余(含 ReferenceError —— 环境缺失是运行环境问题,不是模块图问题)算可加载
 * 本表里 **不在 PROD_ENTRIES** 的条目 ⇒ 报错「应删除该豁免」
 *   (防豁免越积越多、最后没人敢删)
 * 本表条目的**理由为空白** ⇒ 报错
 *   (只写「已知不可加载」会让本表腐烂成一份假的绿色清单)
 * ```
 *
 * ## 每条必须写清「原因 + 出路」
 *
 * 出路可以是「设计如此(浏览器)」,也可以是「待 CR 裁决」,但不许留空。
 * 本仓对不可达白名单(`UNREACHABLE_EXEMPT`)是同一套要求。
 *
 * ## 这张表的来历(2026-11-12,task-57)
 *
 * 缺陷:`reachableClosure()` **只做词法分析**(读 `import` 语句、拼路径、算闭包),
 * **从不执行一行代码**。于是「这个入口能不能被 `import` 成功」在判据里
 * **结构上不可见** —— 门禁把一个**根本加载不了**的模块列为「生产入口」,而它全绿。
 *
 * 实测(Node 24.13.0,逐个加载):
 * ```
 * ✓ server/src/index.ts               可加载(装配入口,无装饰器、不含 colyseus)
 * ✓ server/src/sim/demo.ts            可加载(**但有副作用**:加载即跑 200 帧并打印)
 * ✗ server/src/net/room.colyseus.ts   SyntaxError(44 处 @type 装饰器)
 * ✗ client/src/main.ts                ReferenceError(document/浏览器环境)
 * ```
 * ⇒ **4 个入口里 2 个加载不了,而门禁从未察觉。**
 * ⚠️ 这也是为什么判据**必须用子进程**:`demo.ts` 加载即执行,
 * 用 `await import()` 会让门禁真跑一遍模拟(而且它**跑完不抛错**,捕获异常查不出)。
 */
export const ENTRY_LOAD_EXEMPT: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'client/src/main.ts',
    '设计如此:浏览器入口,依赖 document/window,在 Node 里永不可加载。'
    + '它的可运行性由 client/index.html 的 <script src> + 浏览器实测(60 FPS)保证,'
    + '不由本判据保证。'
    + '⇒ 出路:无需修复;若将来做 SSR 才需要重新评估。',
  ],
  [
    'server/src/net/room.colyseus.ts',
    '**待裁决的架构矛盾**:44 处 @type 装饰器(Colyseus 必需;'
    + '实测行首计数 44、含注释残留 45 —— 口径见 docs/ARCH-GAPS.md:212),'
    + 'Node 24 strip-only 不支持装饰器 ⇒ 需构建步骤(tsc/esbuild)。'
    + '而本仓铁律是「零依赖 + 直接跑 .ts」⇒ 两者不可兼得。'
    + '⇒ 出路:等 CR 裁决三个选项之一 ——'
    + '(1) 移除 Colyseus 依赖(schema 仅作元数据容器,USE_COLYSEUS_PATCH 已为 false);'
    + '(2) 为该文件引入构建步骤(破零依赖铁律);'
    + '(3) 该房间降级为设计文档,从 PROD_ENTRIES 移出。'
    + '⚠️ 在裁决前,`worldSaveHost` 的生产装配路径**不经过**本文件 ——'
    + '装配入口是 server/src/index.ts(它零 colyseus 依赖),'
    + '验收见 tests/WS-FND-09-wiring.test.ts。',
  ],
]);

/**
 * 供测试使用:本表是否登记了某个入口。
 *
 * ⚠️ 提供函数而不是让调用方自己 `.has()`,是为了让**判据的语义**
 * (「豁免 = 有登记且有非空理由」)只有一份实现。
 * 直接 `.has()` 会让「理由为空」的条目被误读成已豁免。
 */
export function isEntryLoadExempt(rel: string): boolean {
  const why = ENTRY_LOAD_EXEMPT.get(rel);
  return why !== undefined && why.trim() !== '';
}

/** 供测试使用:豁免条目的条数(用于「PROD_ENTRIES 增删后回来核对」的断言)。 */
export function entryLoadExemptCount(): number {
  return ENTRY_LOAD_EXEMPT.size;
}
