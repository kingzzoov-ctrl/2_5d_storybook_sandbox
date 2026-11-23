/**
 * WS-FND-187 · **主线六步状态机 + HUD 一行指引**(采集 → 合成 → 建造 → 打怪 → 变强)。
 *
 * ## 这套判据在守什么
 *
 * 玩法系统(采集 / 合成 / 建造 / 战斗 / 成长 / 炼金 / 派对)**都实现了**,
 * 缺的是「第一步做什么」与「第一步做完了没有」。本套件守两件事:
 * ```text
 * server/src/quests/mainline.ts  六步**顺序**推进;跳步无效;重复事件不重复推进
 * client/src/ui/mainline_hud.ts  一行字:每一步一句**不同**的指引 + 全通时那句收尾
 * ```
 *
 * ## 判据
 *
 * | # | 判据 | 为什么有牙(改坏了哪条会红) |
 * |---|------|----------------------------|
 * | FND187-1  | 六步按序推进:逐步喂事件,step 1→2→…→6,最后 `done` | 顺序表错一位 / 少一步 ⇒ 逐步断言当场红 |
 * | FND187-2  | **跳步无效**:第 1 步没做时喂第 2 步事件 ⇒ step 仍是 1 | 把「只在当前步判定」换成「总是推进」⇒ 红(见文末实证) |
 * | FND187-3  | 推到第 3 步后喂第 4 步事件 ⇒ 不动;补第 3 步事件 ⇒ 才到 4 | 同上,且证明状态没被「跳过的那一步」偷改 |
 * | FND187-4  | **重复事件不重复推进**:同一事件喂 5 次 ⇒ step 只 +1 | 「接受就再 +1」⇒ 红 |
 * | FND187-5  | 完成态:`done === true`,再喂六类事件都不变(逐步) | 去掉「已全通就没有下一步」⇒ completed 涨到 7,红 |
 * | FND187-6  | 纯函数:入参不被改;推进返新对象;不推进返**同一引用** | 在入参上原地 +1 ⇒ 红 |
 * | FND187-7  | 未知事件(`kind` 不认识 / `null` / 数字 / 字符串 / 空对象)在**六个步位**各喂一遍:不抛、不推进 | 去掉运行时收窄 ⇒ 抛 TypeError,红 |
 * | FND187-8  | 未知 id 逐条不抛不推进(采/合/放/区/怪/Boss 各一条) | 把内容表判换成「非空即算」⇒ 红 |
 * | FND187-9  | **错配**:六个步位各喂其余五类**合法**事件 ⇒ 一步都不动 | 去掉 `kind !==` 守卫 ⇒ 红 |
 * | FND187-10 | 第 1 步只认**自然材料**(101 原木 / 121 甜莓;201 工具 / 151 板材 / 9999 不认) | 去掉 `category === NATURAL` ⇒ 红 |
 * | FND187-11 | 第 2 步只认**工具**(201 工具;101 原木 / 151 板材不认) | 去掉 `category === TOOL` ⇒ 红 |
 * | FND187-12 | 第 6 步阈值:`hpRatio = 0.5` 过、`0.51` 不过、越界 / NaN / 非数不抛 | 阈值漂成 `<` / 去掉越界判 ⇒ 红 |
 * | FND187-13 | 表自洽:步数 = 6、`order` = 下标 + 1、`stepId` 并集 = 六步;穿越认 `REGIONS` 的**每一个** id,且 `regionAt` 的真值在其中 | 手抄一份区名单 / 顺序漂 ⇒ 红 |
 * | FND187-14 | HUD 六步文案**两两不同**、都非空、都以 `□ 主线 n/6` 开头、`done === false` | 六行抄成一句 ⇒ 红 |
 * | FND187-15 | HUD 全通文案与六步文案**都不同**,`done === true`,句首是勾 | 收尾写成第 6 步的文案 ⇒ 红 |
 * | FND187-16 | HUD 兜底:未知 `stepId` / 越界 `step` / `null` ⇒ 非空、退到第 1 步、不抛 | 返回空串 ⇒ 红 |
 * | FND187-17 | 结构兼容:`mainlineState()` 的产物**直接**喂 `planMainlineHud`(服务端视图 ↔ 客户端视图) | 任一侧字段改名 ⇒ 编译期红(本文件 typecheck 覆盖) |
 *
 * ## 内容 id 为什么是这些(全部来自冻结内容表,不是随手编的)
 *
 * ```text
 * 101 暖松原木 / 121 露水甜莓   category NATURAL(§3.1)⇒ 第 1 步认
 * 201 暖松石刃斧                category TOOL(§3.3)     ⇒ 第 2 步认
 * 151 精刨松木板                category REFINED         ⇒ 第 1/2 步都**不**认
 * 305 复古红砖广场砖            category FLOOR           ⇒ 第 3 步认(方块/家具/建筑都算)
 * 'meadow' / 'grove' 等         REGIONS[].id             ⇒ 第 4 步认
 * 'mob_boar'                    MOB_BY_ID                ⇒ 第 5 步认
 * 'boss_jelly_king'             BOSS_BY_ID               ⇒ 第 6 步认
 * ```
 *
 * ## 有牙实证(改坏实现 ⇒ 判据真变红;两个变异都已还原,`sha256` 前后一致)
 *
 * ### ① 把「只在当前步判定」换成「总是推进到下一步」
 *
 * 摘掉 `server/src/quests/mainline.ts#applyEvent` 里的
 * `if (!mainlineAccepts(step.id, ev)) return from;`(只留 `return { completed: +1 }`)⇒
 * ```text
 * ✗ FND187-2 跳步无效 — 合成事件不能替玩家「预支」采集那一步 期望 1 / 实际 2
 * ✗ FND187-3 跳步无效 — 跨越区事件不能替玩家预支「建造」那一步 期望 3 / 实际 4
 * ✗ FND187-4 重复事件 — 五条采集事件只算一步 completed:期望 1 / 实际 5
 * ✗ FND187-6 纯函数 — 同类事件在下一步不匹配 ⇒ 返回入参本身
 * ✗ FND187-7 未知事件 — 已完成 0 步时喂垃圾 null step:期望 1 / 实际 2
 * ✗ FND187-8 未知 id — 已完成 0 步时喂 {"kind":"gather","itemId":9999,...} 期望 1 / 实际 2
 * ✗ FND187-9 错配 — 已完成 0 步(gather)时喂 craft 事件 step:期望 1 / 实际 2
 * [WS-FND-187-mainline] 10/17 通过
 * ```
 *
 * ### ② 去掉「已全通就没有下一步」
 *
 * 把 `const step = MAINLINE_STEPS[from.completed]; if (step === undefined) return from;`
 * 换成 `MAINLINE_STEPS[Math.min(from.completed, MAINLINE_STEP_COUNT - 1)]` ⇒
 * ```text
 * ✗ FND187-5 完成态 — 全通后再喂 bossProgress 事件:结构不变 completed:期望 6 / 实际 7
 * [WS-FND-187-mainline] 16/17 通过
 * ```
 *
 * 还原后:`node tests/WS-FND-187-mainline.test.ts` ⇒ `17/17 通过`。
 *
 * 运行:`node tests/WS-FND-187-mainline.test.ts`
 */

import { eq, ok, report, test } from '../shared/testing/harness.ts';

import {
  BOSS_HP_THRESHOLD,
  MAINLINE_REGION_IDS,
  MAINLINE_STEP_COUNT,
  MAINLINE_STEP_IDS,
  MAINLINE_STEPS,
  applyEvent,
  createMainline,
  mainlineAccepts,
  mainlineState,
  onBossProgress,
  onCraft,
  onEnterRegion,
  onGather,
  onKill,
  onPlace,
  type MainlineEvent,
  type MainlineState,
} from '../server/src/quests/mainline.ts';
import {
  MAINLINE_HUD_DONE_MARK,
  MAINLINE_HUD_DONE_TEXT,
  MAINLINE_HUD_ROWS,
  MAINLINE_HUD_TODO_MARK,
  planMainlineHud,
  type MainlineHudView,
} from '../client/src/ui/mainline_hud.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import { regionAt } from '../shared/world/design.ts';

/* ── 内容表取样(取值理由见文件头「内容 id 为什么是这些」) ── */
const NAT_WOOD = 101;
const NAT_BERRY = 121;
const TOOL_AXE = 201;
const REFINED_PLANK = 151;
const FLOOR_BRICK = 305;
const REGION_MEADOW = 'meadow';
const MOB_BOAR = 'mob_boar';
const BOSS_JELLY = 'boss_jelly_king';

/** 六步的**合法**事件,顺序 = 推进顺序。 */
const GOLDEN: readonly MainlineEvent[] = [
  onGather(NAT_WOOD, 1),
  onCraft(TOOL_AXE),
  onPlace(FLOOR_BRICK),
  onEnterRegion(REGION_MEADOW),
  onKill(MOB_BOAR),
  onBossProgress(BOSS_JELLY, 0.4),
];

/** 把 state 推到「已完成 n 步」(`n` = 0..6)。 */
function atCompleted(n: number): MainlineState {
  let s = createMainline();
  for (let i = 0; i < n; i += 1) s = applyEvent(s, GOLDEN[i]);
  return s;
}

/** 依次喂一串事件。 */
function fold(state: MainlineState, evs: readonly MainlineEvent[]): MainlineState {
  let s = state;
  for (const ev of evs) s = applyEvent(s, ev);
  return s;
}

/* ═══════════════════════════ 1. 顺序推进 ═══════════════════════════ */

test('FND187-1 六步按序推进:逐步喂事件,step 1→2→…→6,最后 done', () => {
  eq(MAINLINE_STEP_COUNT, 6, '六步(愿景 V7 的那条循环)');
  const expectedIds = ['gather', 'craft', 'place', 'travel', 'hunt', 'boss'];
  let s = createMainline();

  const v0 = mainlineState(s);
  eq(v0, { step: 1, stepId: 'gather', done: false, progress: 0 }, '新玩家从第 1 步(采集)开始');

  for (let i = 0; i < GOLDEN.length; i += 1) {
    s = applyEvent(s, GOLDEN[i]);
    const view = mainlineState(s);
    const last = i === GOLDEN.length - 1;
    eq(
      view,
      {
        step: last ? 6 : i + 2,
        stepId: expectedIds[last ? 5 : i + 1],
        done: last,
        progress: (i + 1) / 6,
      },
      `喂完第 ${i + 1} 条事件(${GOLDEN[i].kind})后的视图`,
    );
  }
  eq(mainlineState(s).done, true, '六条事件喂完 ⇒ done');
});

/* ═══════════════════════════ 2. 跳步无效(有牙) ═══════════════════════════ */
test('FND187-2 跳步无效:第 1 步没做时喂第 2 步事件 ⇒ step 仍是 1', () => {
  const fresh = createMainline();
  const skipped = applyEvent(fresh, onCraft(TOOL_AXE));
  eq(mainlineState(skipped).step, 1, '合成事件不能替玩家「预支」采集那一步');
  eq(skipped, { completed: 0 }, '状态一个数都没动');
  ok(skipped === fresh, '不推进 ⇒ 返回同一引用(接线侧据此判「有进展」)');

  /* 反过来:补上第 1 步事件 ⇒ 真的走到 2(证明上一步没被偷偷记住/跳过)。 */
  const after = applyEvent(skipped, onGather(NAT_WOOD, 1));
  eq(mainlineState(after).step, 2, '补上采集 ⇒ 才到第 2 步');
  eq(mainlineState(after).stepId, 'craft', '当前步是合成');
});

test('FND187-3 跳步无效:推到第 3 步后喂第 4 步事件 ⇒ 不动', () => {
  const s3 = atCompleted(2);
  eq(mainlineState(s3).step, 3, '前提:已完成采集 + 合成');

  const skipped = applyEvent(s3, onEnterRegion(REGION_MEADOW));
  eq(mainlineState(skipped).step, 3, '跨越区事件不能替玩家预支「建造」那一步');
  ok(skipped === s3, '不推进 ⇒ 同一引用');

  /* 中间补一步(而且是**第 5 步**的事件)也不行:还没到那一步。 */
  eq(mainlineState(applyEvent(s3, onKill(MOB_BOAR))).step, 3, '击杀事件同样不能跳步');

  const s4 = applyEvent(s3, onPlace(FLOOR_BRICK));
  eq(mainlineState(s4).step, 4, '补上建造 ⇒ 到第 4 步(出发)');
  eq(mainlineState(s4).stepId, 'travel', '当前步是出发');
});

/* ═══════════════════════════ 3. 重复事件 ═══════════════════════════ */

test('FND187-4 重复事件不重复推进:同一事件喂 5 次 ⇒ step 只 +1', () => {
  let s = createMainline();
  for (let i = 0; i < 5; i += 1) s = applyEvent(s, onGather(NAT_WOOD, 1));
  eq(s, { completed: 1 }, '五条采集事件只算一步');
  eq(mainlineState(s).step, 2, '停在第 2 步(合成)');

  /* 在不同步位上重复同样的重复:越过第 3 步后重复「建造」事件也不再动。 */
  let t = atCompleted(3);
  eq(mainlineState(t).step, 4, '前提:已到第 4 步');
  for (let i = 0; i < 3; i += 1) t = applyEvent(t, onPlace(FLOOR_BRICK));
  eq(mainlineState(t).step, 4, '第 3 步早做过了 ⇒ 再放十个方块也停在第 4 步');
});

/* ═══════════════════════════ 4. 完成态 ═══════════════════════════ */

test('FND187-5 完成态:done === true 且再喂事件不再改变', () => {
  const done = atCompleted(6);
  const view = mainlineState(done);
  eq(view.done, true, '前提:六步已全通');
  eq(view.step, 6, '全通后 step 停在 6(不越界)');
  eq(view.progress, 1, '进度 = 1');

  for (const ev of GOLDEN) {
    const next = applyEvent(done, ev);
    eq(next, done, `全通后再喂 ${ev.kind} 事件:结构不变`);
    ok(next === done, `全通后再喂 ${ev.kind} 事件:同一引用`);
  }
  eq(mainlineState(done), view, '视图也不变');
});

/* ═══════════════════════════ 5. 纯函数 ═══════════════════════════ */

test('FND187-6 纯函数:入参不被改;推进返新对象;不推进返同一引用', () => {
  const s0 = createMainline();
  const s1 = applyEvent(s0, onGather(NAT_WOOD, 1));
  ok(s1 !== s0, '推进 ⇒ 新对象');
  eq(s0, { completed: 0 }, '入参一个数都没动(不可变)');
  eq(s1, { completed: 1 }, '返回值 = completed + 1');

  const noop = applyEvent(s1, onGather(NAT_WOOD, 9));
  ok(noop === s1, '同类事件在下一步不匹配 ⇒ 返回入参本身');

  /* 垃圾 state(null / NaN / 越界)按「一步没做」处理,不抛。 */
  eq(mainlineState(null as unknown as MainlineState), { step: 1, stepId: 'gather', done: false, progress: 0 },
    'state 为 null ⇒ 当作新玩家');
  eq(applyEvent({ completed: Number.NaN } as MainlineState, onGather(NAT_WOOD, 1)), { completed: 1 },
    'state 为 NaN ⇒ 当作 0 再推进');
  eq(mainlineState({ completed: 99 } as MainlineState), { step: 6, stepId: 'boss', done: true, progress: 1 },
    'state 越界 ⇒ 夹到 6(全通)');
});

/* ═══════════════════════════ 6. 未知输入不抛 ═══════════════════════════ */

test('FND187-7 未知事件在六个步位各喂一遍:不抛、不推进', () => {
  /* 抛异常 ⇒ 本 test 直接红(harness 把 throw 当失败),所以「不抛」就是断言本身。 */
  const junk: readonly unknown[] = [
    null,
    undefined,
    42,
    'gather',
    {},
    { kind: 'nope' },
    { kind: 5 },
    { kind: 'Gather' },
    [],
  ];
  for (let n = 0; n < MAINLINE_STEP_COUNT; n += 1) {
    const at = atCompleted(n);
    const before = mainlineState(at);
    for (const ev of junk) {
      const next = applyEvent(at, ev as unknown as MainlineEvent);
      eq(mainlineState(next), before, `已完成 ${n} 步时喂垃圾 ${JSON.stringify(ev) ?? String(ev)}`);
    }
  }
});

test('FND187-8 未知 id 逐条不抛不推进', () => {
  const cases: readonly [number, MainlineEvent][] = [
    [0, onGather(9999, 3)],            /* 内容表里没有的物资 */
    [0, onGather(NAT_WOOD, 0)],        /* 采到 0 份 = 没采到 */
    [0, onGather(TOOL_AXE, 1)],        /* 工具不是自然材料 */
    [1, onCraft(9999)],
    [1, onCraft(NAT_WOOD)],            /* 原木没有「合成」这一步的资格 */
    [2, onPlace(9999)],
    [3, onEnterRegion('atlantis')],    /* regionAt 永远不返回的区 */
    [3, onEnterRegion('')],
    [4, onKill('mob_nope')],
    [5, onBossProgress('boss_nope', 0.1)],
    [5, onBossProgress(BOSS_JELLY, 0.4)],  /* 合法 Boss + 达标血量 ⇒ 这一条**会**推进,反向对照 */
  ];
  for (const [n, ev] of cases) {
    const at = atCompleted(n);
    const next = applyEvent(at, ev);
    const shouldAdvance = n === 5 && ev.kind === 'bossProgress' && (ev as { bossId: string }).bossId === BOSS_JELLY;
    eq(mainlineState(next).step, shouldAdvance ? 7 - 1 : n + 1,
      `已完成 ${n} 步时喂 ${JSON.stringify(ev)}`);
  }
});

test('FND187-9 错配:六个步位各喂其余五类合法事件 ⇒ 一步都不动', () => {
  for (let n = 0; n < MAINLINE_STEP_COUNT; n += 1) {
    const at = atCompleted(n);
    const before = mainlineState(at);
    for (let k = 0; k < GOLDEN.length; k += 1) {
      if (k === n) continue; /* 不是当前步的那五类 */
      const next = applyEvent(at, GOLDEN[k]);
      eq(mainlineState(next), before, `已完成 ${n} 步(${before.stepId})时喂 ${GOLDEN[k].kind} 事件`);
      ok(next === at, `不推进 ⇒ 同一引用(${before.stepId} ← ${GOLDEN[k].kind})`);
    }
    /* 本步的事件确实认(否则上面「不推进」也可能是因为全都不认)。 */
    ok(mainlineAccepts(MAINLINE_STEPS[n].id, GOLDEN[n]), `第 ${n + 1} 步认自己的事件`);
  }
});

/* ═══════════════════════════ 7. 每步的内容表口径 ═══════════════════════════ */

test('FND187-10 第 1 步只认自然材料(内容表 category === NATURAL)', () => {
  eq(ITEM_BY_ID.get(NAT_WOOD)?.category, ItemCategory.NATURAL, '前提:101 是自然资源');
  eq(ITEM_BY_ID.get(NAT_BERRY)?.category, ItemCategory.NATURAL, '前提:121 是自然资源');
  ok(mainlineAccepts('gather', onGather(NAT_WOOD, 1)), '砍一根原木 ⇒ 第 1 步成立');
  ok(mainlineAccepts('gather', onGather(NAT_BERRY, 2)), '采两颗甜莓 ⇒ 第 1 步成立');
  ok(!mainlineAccepts('gather', onGather(TOOL_AXE, 1)), '斧头不是自然材料');
  ok(!mainlineAccepts('gather', onGather(REFINED_PLANK, 1)), '木板是半成品,不是自然材料');
  ok(!mainlineAccepts('gather', onGather(9999, 1)), '内容表里没有的 id 不认');
  ok(!mainlineAccepts('gather', onGather(NAT_WOOD, 0)), '0 份不算采到');
  ok(!mainlineAccepts('gather', onGather(NAT_WOOD, -2)), '负数不算采到');
  ok(!mainlineAccepts('gather', onGather(NAT_WOOD, 1.5)), '非整数件数不认');
  ok(!mainlineAccepts('gather', onGather(NAT_WOOD, Number.NaN)), 'NaN 件数不认');
});

test('FND187-11 第 2 步只认工具(内容表 category === TOOL)', () => {
  eq(ITEM_BY_ID.get(TOOL_AXE)?.category, ItemCategory.TOOL, '前提:201 是生产工具');
  ok(mainlineAccepts('craft', onCraft(TOOL_AXE)), '造出斧头 ⇒ 第 2 步成立');
  ok(!mainlineAccepts('craft', onCraft(NAT_WOOD)), '原木不是工具(它没有配方)');
  ok(!mainlineAccepts('craft', onCraft(REFINED_PLANK)), '木板是半成品,不是工具');
  ok(!mainlineAccepts('craft', onCraft(FLOOR_BRICK)), '地砖不是工具');
  ok(!mainlineAccepts('craft', onCraft(9999)), '内容表里没有的 id 不认');
});

test('FND187-12 第 6 步阈值:hpRatio ≤ 0.5 才算「打掉一半」', () => {
  eq(BOSS_HP_THRESHOLD, 0.5, '阈值 = 半个血条');
  ok(!mainlineAccepts('boss', onBossProgress(BOSS_JELLY, 1)), '满血:Boss 刚开打,不算');
  ok(!mainlineAccepts('boss', onBossProgress(BOSS_JELLY, 0.51)), '差一点点(0.51)不算');
  ok(mainlineAccepts('boss', onBossProgress(BOSS_JELLY, 0.5)), '正好一半 ⇒ 算(≤)');
  ok(mainlineAccepts('boss', onBossProgress(BOSS_JELLY, 0)), '打死 ⇒ 算');
  ok(!mainlineAccepts('boss', onBossProgress(BOSS_JELLY, 2)), '越界(>1)不是证据');
  ok(!mainlineAccepts('boss', onBossProgress(BOSS_JELLY, -1)), '越界(<0)不是证据');
  ok(!mainlineAccepts('boss', onBossProgress(BOSS_JELLY, Number.NaN)), 'NaN 不是证据');
  ok(!mainlineAccepts('boss', onBossProgress('boss_nope', 0.1)), '未知 Boss 不认');

  /* 事件级的同一结论:0.51 不推进,0.5 推进。 */
  const at5 = atCompleted(5);
  eq(mainlineState(applyEvent(at5, onBossProgress(BOSS_JELLY, 0.51))).step, 6, '0.51 停在第 6 步');
  eq(mainlineState(applyEvent(at5, onBossProgress(BOSS_JELLY, 0.5))).done, true, '0.5 ⇒ 全通');
});

test('FND187-13 表自洽:步数 / 顺序 / stepId 并集,且穿越认 REGIONS 的每一个 id', () => {
  eq(MAINLINE_STEPS.length, MAINLINE_STEP_COUNT, 'MAINLINE_STEPS 覆盖全部步');
  eq(MAINLINE_STEP_IDS.length, MAINLINE_STEP_COUNT, 'MAINLINE_STEP_IDS 覆盖全部步');
  for (let i = 0; i < MAINLINE_STEPS.length; i += 1) {
    eq(MAINLINE_STEPS[i].order, i + 1, `第 ${i + 1} 步的 order`);
    eq(MAINLINE_STEPS[i].id, MAINLINE_STEP_IDS[i], `第 ${i + 1} 步的 id`);
  }
  eq([...new Set(MAINLINE_STEP_IDS)].length, 6, '六个 id 两两不同(没有重复步)');

  /* 区 id 的**唯一出处**是 design.ts 的 REGIONS:手抄一份名单就迟早漂。 */
  ok(MAINLINE_REGION_IDS.length >= 10, `设计图里的区 ≥ 10 个(实测 ${MAINLINE_REGION_IDS.length})`);
  for (const id of MAINLINE_REGION_IDS) {
    ok(mainlineAccepts('travel', onEnterRegion(id)), `区 ${id} 被第 4 步认`);
    eq(mainlineState(applyEvent(atCompleted(3), onEnterRegion(id))).step, 5, `进 ${id} ⇒ 第 4 步完成、走到第 5 步`);
  }
  /* 出生点(designed spawn)落在 camp,而 meadow 真的能被 regionAt 查出来。 */
  eq(regionAt(64, 64), 'meadow', 'regionAt(64,64) = meadow(草原)');
  ok(MAINLINE_REGION_IDS.includes('meadow'), 'meadow 在区名单里');
  /* regionAt 的**任意**非 null 返回值都必须落在区名单里(下面逐点验真)。 */
  for (const [x, y] of [[64, 64], [128, 64], [64, 128], [96, 132], [128, 128], [96, 150]] as const) {
    const id = regionAt(x, y);
    if (id === null) continue;
    ok(MAINLINE_REGION_IDS.includes(id), `regionAt(${x},${y}) = ${id} 在区名单里`);
  }
});

/* ═══════════════════════════ 8. HUD 一行 ═══════════════════════════ */

test('FND187-14 HUD 六步文案两两不同,且都以「□ 主线 n/6」开头', () => {
  eq(MAINLINE_HUD_ROWS.length, MAINLINE_STEP_COUNT, '六行文案');
  const texts: string[] = [];
  for (let i = 0; i < MAINLINE_HUD_ROWS.length; i += 1) {
    const row = MAINLINE_HUD_ROWS[i];
    eq(row.order, i + 1, `第 ${i + 1} 行的 order`);
    eq(row.stepId, MAINLINE_STEP_IDS[i], `第 ${i + 1} 行的 stepId 与服务端步 id 同值`);
    const plan = planMainlineHud({ step: i + 1, stepId: row.stepId, done: false, progress: i / 6 });
    eq(plan.done, false, `第 ${i + 1} 步:done = false`);
    ok(plan.text.length > 0, `第 ${i + 1} 步:文案非空`);
    ok(plan.text.startsWith(`${MAINLINE_HUD_TODO_MARK} 主线 ${i + 1}/6 `),
      `第 ${i + 1} 步:句首是「${MAINLINE_HUD_TODO_MARK} 主线 ${i + 1}/6」(实测 ${plan.text})`);
    ok(plan.text.includes(row.hint), `第 ${i + 1} 步:文案带本步的指引`);
    texts.push(plan.text);
  }
  eq([...new Set(texts)].length, MAINLINE_STEP_COUNT, '六条文案两两不同');
});

test('FND187-15 HUD 全通文案:与六步文案都不同,且带勾', () => {
  const done = planMainlineHud({ step: 6, stepId: 'boss', done: true, progress: 1 });
  eq(done.done, true, 'done = true');
  ok(done.text.startsWith(`${MAINLINE_HUD_DONE_MARK} `), `句首是勾(${MAINLINE_HUD_DONE_MARK})`);
  ok(done.text.includes(MAINLINE_HUD_DONE_TEXT), '带上收尾文案');
  for (let i = 0; i < MAINLINE_STEP_COUNT; i += 1) {
    const stepText = planMainlineHud({
      step: i + 1, stepId: MAINLINE_STEP_IDS[i], done: false, progress: i / 6,
    }).text;
    ok(stepText !== done.text, `全通文案 ≠ 第 ${i + 1} 步文案`);
  }
  ok(done.text !== `${MAINLINE_HUD_TODO_MARK} ${MAINLINE_HUD_DONE_TEXT}`, '全通文案不是把待办标记换成勾就算');
});

test('FND187-16 HUD 兜底:垃圾视图不抛、非空、退到第 1 步', () => {
  const first = planMainlineHud({ step: 1, stepId: 'gather', done: false, progress: 0 });
  const cases: readonly unknown[] = [
    null,
    undefined,
    {},
    { step: -3, stepId: 'nope', done: false, progress: 0 },
    { step: 99, stepId: 'nope', done: false, progress: 0 },
    { step: Number.NaN, stepId: 42, done: false, progress: 0 },
    { step: 2.7, stepId: '', done: false, progress: 0 },
  ];
  for (const v of cases) {
    const plan = planMainlineHud(v as unknown as MainlineHudView);
    ok(plan.text.length > 0, `垃圾视图 => 文案非空(${JSON.stringify(v) ?? String(v)})`);
    eq(plan.done, false, '没写 done === true 就不算全通(不猜)');
  }
  /* stepId 认不出来但 step 合法 ⇒ 按步号兜底(而不是退回第 1 步)。 */
  eq(planMainlineHud({ step: 4, stepId: 'nope', done: false, progress: 0.5 }).text,
    planMainlineHud({ step: 4, stepId: 'travel', done: false, progress: 0.5 }).text,
    'stepId 不认识 ⇒ 按 step 找到第 4 步文案');
  /* 越界 step + 未知 stepId ⇒ 第 1 步文案(兜底不留空)。 */
  eq(planMainlineHud({ step: 99, stepId: 'nope', done: false, progress: 0 }).text, first.text,
    '越界 ⇒ 第 1 步文案');
});

test('FND187-17 结构兼容:mainlineState() 的产物直接喂 planMainlineHud', () => {
  let s = createMainline();
  for (let i = 0; i < GOLDEN.length; i += 1) {
    /* ★ 关键断言在这里的**类型**上:服务端视图与客户端视图必须结构兼容,
       任一侧改字段名 ⇒ typecheck 当场红(本行是那个赋值)。 */
    const view: MainlineHudView = mainlineState(s);
    const plan = planMainlineHud(view);
    eq(plan.done, false, `第 ${i + 1} 步:还没全通`);
    ok(plan.text.includes(`${i + 1}/6`), `第 ${i + 1} 步:HUD 打的步号与状态机一致`);
    s = applyEvent(s, GOLDEN[i]);
  }
  const finalPlan = planMainlineHud(mainlineState(s));
  eq(finalPlan.done, true, '六步喂完 ⇒ HUD 换成收尾文案');
  eq(finalPlan.text, `${MAINLINE_HUD_DONE_MARK} ${MAINLINE_HUD_DONE_TEXT}`, '收尾文案逐字一致');
});

report('WS-FND-187-mainline');