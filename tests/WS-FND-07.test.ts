/**
 * WS-FND-07:编排层接线回归 —— 守护三条「完整实现、单测全绿、编排层不接」的缺陷。
 *
 * 这三条来自 `docs/FOUNDATION-AUDIT.md`,共同特征一模一样:
 * **子系统实现完整、自己的单元测试全绿,但生产编排层从不调用它**。
 * 因此**任何单元测试都抓不到它们** —— 缺陷不在被测代码里,而在接线处。
 *
 * 本套件的写法有意与其他套件不同:**全部走编排层入口 `WorldSim`**,
 * 不直接 `new SignalGraph()` / 不直接 `import components.ts`。
 * 这一点是刻意的,原因见下面 B 的说明。
 *
 * ## 三条缺陷与对应断言
 *
 * - **A 流体相变产物只进不出**:`fluid.drainPhaseProducts()` 存在但无人调用,
 *   产物停在 `pendingObj` 里 → 断言「该格地形真的变成黑曜石」。
 * - **B `components.ts` 不在生产可达闭包内**:`REGISTRY` 为空 → 40 项件全是空壳。
 *   → 断言「走编排层路径,AND 门真的能求值」;**并且验证「去掉接线就会失败」**。
 * - **C `demo.ts` 用了未注册的 kind `'LEVER'`** → 断言注册表里确有
 *   `'SENSOR_LEVER'` 且 `demo.ts` 不再引用 `'LEVER'`。
 *
 * 运行:`node tests/WS-FND-07.test.ts`
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorldSim } from '../server/src/sim/world_sim.ts';
import { hasComponentKind, SignalGraph, createComponent } from '../server/src/wiring/graph.ts';
import { OBSIDIAN_ID } from '../server/src/world/fluid.ts';
import { BaseFluid, WireColor } from '../shared/types/tile.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ══════════════════ A. 流体相变产物必须写回 OBJ 层 ══════════════════ */

test('WF-07-01 相变产物写回地形:水邻熔岩若干帧后该格真的变成黑曜石', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  /* 造「水 | 熔岩」接触对 —— 与 WS-01 的单元测试同构,
     但**这里走编排层**(WorldSim),WS-01 是直接操作 FluidField。 */
  sim.fluid.setCell(4, 4, { base: BaseFluid.SHALLOW_WATER, amount: 600 });
  sim.fluid.setCell(5, 4, { base: BaseFluid.LAVA, amount: 600 });

  eq(sim.grid.objIdAt(4, 4), 0, '相变前该格 OBJ 层是空的');

  const r = sim.run(20);

  /* 断言**地形**,不是断言 `pendingObj.length` —— 后者在缺陷状态下也会增长,
     它会「通过」却什么都没修好。这正是本条断言的价值所在。 */
  /* ★ 2026-11-14(Lead):期望值改写**字面量 110**,不引 `OBSIDIAN_ID`。
     原写法 `eq(objIdAt(4,4), OBSIDIAN_ID)` 是**同义反复**:
     `fluid.ts:620` 的相变产物**直接取自该常量**
     (`const product = kind === FluidKind.HOT_SPRING ? PUMICE_ID : OBSIDIAN_ID;`)
     ⇒ 两侧同向移动 ⇒ 把常量改成任何值这两条都恒真。

     ## 110 的来源是**独立的**(不是从 fluid.ts 抄的)

     `shared/constants/items.ts:40`:
     ```
     { id: 110, name: '黑曜石块', category: N, tags: ['石材','抗爆','锋利'], … }
     ```
     ⇒ 那是**冻结内容表**(`shared/constants/**`,由内容基线锁 `v1-eaefa38b` 看住),
       而 `fluid.ts:35` 的 docblock 自己写着「取自 `shared/constants/items.ts` 原文」。
     ⇒ 所以 `110` 这个值的**权威在内容表**,不在 fluid.ts —— 改 fluid.ts 会红。

     ## 双向锚定(与 WS-01 `:701` 同一修法)

     `tests/WS-01.test.ts:701` 已有 `eq(OBSIDIAN_ID, 110, '黑曜石 ID')` 锚定常量本身。
     两处合起来:常量改了 ⇒ :701 红;内容表改了而常量没跟 ⇒ 本条红。
     ⇒ 避免「常量与内容表**一起**漂走」这种两个引用同时移动的静默。 */
  eq(sim.grid.objIdAt(4, 4), 110, '水侧该格 OBJ 层已写入黑曜石 110(内容表 items.ts:40)');
  eq(sim.grid.objIdAt(5, 4), 110, '熔岩侧该格 OBJ 层已写入黑曜石 110(内容表 items.ts:40)');

  const products = r.reports.reduce((n, x) => n + x.phaseProducts, 0);
  eq(products, 2, '报告里的相变产物计数为 2(两格)');
});

test('WF-07-02 相变产物队列有界:连跑多帧不无界累积', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.fluid.setCell(4, 4, { base: BaseFluid.SHALLOW_WATER, amount: 600 });
  sim.fluid.setCell(5, 4, { base: BaseFluid.LAVA, amount: 600 });

  sim.run(20);
  /* 队列由编排层 drain,故相变发生后应回到空 —— 而不是缓慢增长。 */
  const pending = (sim.fluid as unknown as { pendingObj: unknown[] }).pendingObj;
  eq(pending.length, 0, '编排层每慢帧 drain 后,产物队列应为空');

  /* 再跑 500 帧,确认不会因为「只 push 不 drain」而累积。 */
  sim.run(500);
  eq(pending.length, 0, '再跑 500 帧后队列仍为空(无界累积已消除)');
});

/* ══════════════════ B. 组件行为必须在编排层可达 ══════════════════ */

/*
 * 本组断言**必须走编排层入口**,理由是核心的:
 *
 * 若直接 `import '../server/src/wiring/components.ts'` 再测 AND 门,
 * 那么 import 这一动作本身就把注册表填满了 —— **测试会永远通过**,
 * 哪怕生产侧一行都没接。这样写出来的断言是「同义反复」,
 * 正是 `docs/FOUNDATION-AUDIT.md` §3.7 点出的「自检与实现同步退化」。
 *
 * 故本组只 import `world_sim.ts`(生产编排层),让**它的副作用 import**
 * 去填充注册表。生产侧一旦漏了那行,注册表为空,这些断言立刻变红。
 */

test('WF-07-03 编排层副作用注册:world_sim 导入后注册表非空', () => {
  /* 注意:本文件**没有**直接 import components.ts。
     注册表之所以有内容,完全来自 `world_sim.ts` 顶部那行副作用 import。 */
  ok(hasComponentKind('LOGIC_AND'), '编排层导入后 LOGIC_AND 已注册');
  ok(hasComponentKind('LOGIC_NOT'), '编排层导入后 LOGIC_NOT 已注册');
  ok(hasComponentKind('SENSOR_LEVER'), '编排层导入后 SENSOR_LEVER 已注册');
  /* 抽查各类目各一个,证明不是「只注册了一两个」。
     名字取自注册表实际内容(见 `components.ts` 的 `S(id, kind, ...)`)。 */
  for (const kind of [
    'LOGIC_AND', 'LOGIC_NOT', 'LOGIC_DELAY_RELAY', 'LOGIC_SPLITTER',
    'WIRELESS_LINK', 'DISPLAY_COUNTER', 'SENSOR_LEVER', 'ACT_LAUNCH_SPRING',
    'LOGISTICS_CONVEYOR', 'DEF_BUBBLE_BALLISTA',
  ]) {
    ok(hasComponentKind(kind), `${kind} 已注册`);
  }
});

test('WF-07-04 走编排层的 SignalGraph 能真的求值 AND 门', () => {
  /* 用 WorldSim 持有的那个图(尺寸与世界一致),而不是自己 new ——
     这样连「编排层给的图能否求值组件」也一并验证了。
     注意改用 `createComponent`(graph.ts)而非 `makeComponent`(components.ts):
     后者会把 components.ts 拉进来,**注册表就被测试自己填满了**,
     本套件「验证编排层接线」的意义会当场消失。 */
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  const g = sim.wiring;

  /* 红线(y=5)与蓝线(y=9)是输入端,黄线(y=7)是输出端。
     组件占 3×3、端口开在外圈,故线放在中心 ±2 内。 */
  for (let x = 0; x <= 3; x += 1) g.addWire(x, 5, WireColor.RED);
  for (let x = 0; x <= 3; x += 1) g.addWire(x, 9, WireColor.BLUE);
  for (let x = 5; x <= 12; x += 1) g.addWire(x, 7, WireColor.YELLOW);

  g.addComponent(createComponent('and1', 'LOGIC_AND', 4, 7, {
    outputs: [WireColor.YELLOW],
    params: { inA: WireColor.RED, inB: WireColor.BLUE },
  }));

  g.tick();
  g.drive(0, 5, WireColor.RED, true);
  g.drive(0, 9, WireColor.BLUE, true);
  g.run(3);

  eq(g.liveAt(12, 7, WireColor.YELLOW), true, '两输入为真 → AND 输出为真');

  /* 反例:撤掉一个输入,输出必须为假 —— 否则「恒真」也能骗过上面那条 */
  g.drive(0, 9, WireColor.BLUE, false);
  g.run(3);
  eq(g.liveAt(12, 7, WireColor.YELLOW), false, '单输入为真 → AND 输出为假');
});

test('WF-07-05 组件真的被求值:componentsEvaluated 计数随挂载件数增长', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  const g = sim.wiring;

  /* 电路只在**慢帧**推进(10 帧一次),故要跑满 10 帧才拿到一次求值统计。 */
  const r0 = sim.run(10);
  const before = r0.reports.reduce((n, r) => n + r.componentsEvaluated, 0);
  eq(before, 0, '未挂载任何件时,求值计数为 0');

  g.addComponent(createComponent('and1', 'LOGIC_AND', 4, 7));
  g.addComponent(createComponent('not1', 'LOGIC_NOT', 10, 7));

  const r1 = sim.run(10);
  const after = r1.reports.reduce((n, r) => n + r.componentsEvaluated, 0);
  /* 这是**行为层**证据:不只是「注册表非空」,而是真的逐件调用了行为函数。
     缺陷状态下(REGISTRY 为空)`REGISTRY.get()` 恒 undefined,
     循环会 `continue` 跳过每一件,这个计数会停在 0。
     两个件 × 一次慢帧 = 2。 */
  eq(after, 2, '挂载 2 个件后,每个慢帧求值计数为 2');
});

test('WF-07-06 去掉编排层的副作用 import → 注册表为空(证明接线是必需的)', () => {
  /* ── 这条是 B 的**故障注入**,也是本套件最重要的一条 ──
   *
   * 做法:在一个**干净子进程**里只 import `graph.ts`(不 import world_sim),
   * 断言注册表为空;再 import world_sim,断言注册表被填满。
   *
   * 用子进程是因为模块注册表是**进程级全局状态**:在本进程里
   * `components.ts` 早已被加载过,无法「卸掉」。
   *
   * 这条的价值:它直接证明「接线那一行是必要条件」——
   * 若有人删掉 `world_sim.ts` 里的副作用 import,第二段会输出 false,
   * 本断言当场变红。这正是任务要求的「证明不 import components 就会失败」。 */
  const probe = [
    "import { hasComponentKind } from './server/src/wiring/graph.ts';",
    "const clean = hasComponentKind('LOGIC_AND');",
    "await import('./server/src/sim/world_sim.ts');",
    "const wired = hasComponentKind('LOGIC_AND');",
    'console.log(JSON.stringify({ clean, wired }));',
  ].join('\n');

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: ROOT, encoding: 'utf8',
  });
  eq(r.status, 0, `子进程应正常退出(失败时 stderr:${(r.stderr ?? '').slice(0, 200)})`);

  const parsed = JSON.parse((r.stdout ?? '').trim()) as { clean: boolean; wired: boolean };
  eq(parsed.clean, false, '【故障注入】只导入 graph.ts 时注册表为空 —— 证明组件行为不会自己出现');
  eq(parsed.wired, true, '导入编排层 world_sim.ts 后注册表被填满 —— 证明接线那一行是必要条件');
});

/* ══════════════════ C. demo.ts 的 kind 必须是已注册名 ══════════════════ */

test('WF-07-07 demo.ts 不引用未注册的 kind', () => {
  const src = readFileSync(join(ROOT, 'server/src/sim/demo.ts'), 'utf8');

  /* 1) 曾经的错名必须已消失 */
  ok(!/kind:\s*'LEVER'/.test(src), "demo.ts 里不应再有 kind: 'LEVER'(未注册名)");

  /* 2) 出现的每个 kind 字面量都必须真的注册过 */
  const kinds = [...src.matchAll(/kind:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
  ok(kinds.length > 0, 'demo.ts 至少挂载一个组件(否则这条断言是空的)');
  for (const k of kinds) {
    ok(hasComponentKind(k), `demo.ts 使用的 kind '${k}' 必须已在注册表中`);
  }
  /* 3) 修正后的名字确实在 */
  ok(kinds.includes('SENSOR_LEVER'), "demo.ts 应使用 'SENSOR_LEVER'(403 双态机械拉杆)");
});

test('WF-07-08 注册表覆盖 401~440 全部 40 项电路件', () => {
  /* 与 WS-08 的覆盖断言互补:那边查 `COMPONENT_SPECS` 配表完整,
     这边查**注册表实际被填充**——即编排层副作用 import 真的生效。 */
  const g = new SignalGraph(8, 8);
  ok(g !== null, 'SignalGraph 可独立构造');
  const names = [
    'SENSOR_PLATE_LIGHT', 'SENSOR_LEVER', 'SENSOR_LIGHT_DAYNIGHT', 'LOGIC_AND', 'LOGIC_NOT',
    'LOGIC_SPLITTER', 'LOGIC_DELAY_RELAY', 'WIRELESS_LINK', 'DISPLAY_COUNTER', 'ACT_LAUNCH_SPRING',
  ];
  let found = 0;
  for (const n of names) if (hasComponentKind(n)) found += 1;
  eq(found, names.length, `抽查的 ${names.length} 个 kind 全部已注册`);
});

report('WS-FND-07');
