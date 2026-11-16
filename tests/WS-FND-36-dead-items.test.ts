/**
 * WS-FND-36 —— **两件死道具的纯逻辑判据**(`733 羽毛笔` / `227 泡泡水枪`)。
 *
 * ## 这个套件为什么存在
 *
 * `server/src/combat/revive.ts:253 bubbleGunHit` 与 `:268 featherRevive`
 * 在生产里**调用点 = 0**(接线点在 `world_sim.ts`,不在本套件写域)。
 * 也就是说:两条行为今天**只存在于函数体里**,没有任何玩家能触发它们。
 *
 * ⇒ 本文件**只钉「函数体算得对不对」,不声称它们已接线**。
 *    它不装配世界、不建 `WorldSim`、不写临时状态,直接调这两个纯函数。
 *
 * ## 断言右侧为什么全是字面量
 *
 * 右侧若写 `FEATHER_RANGE` / `FEATHER_INVULN` / `BUBBLE_TRAP_SEC`,期望值就与
 * 被测实现**同源** ⇒ 常量一漂,实现与期望一起漂,断言恒真(门禁 `--strict-taut`)。
 * 故本文件的期望值一律是**手工字面量**(6 / 6.1 / 3 / 5 / 3 次),
 * 冻结层常量只出现在**左侧**(先被字面量钉住,再用作输入),两侧不同源:
 *
 * ```
 * eq(FEATHER_RANGE, 6)      // 常量 → 字面量(锚)
 * featherRevive({ distance: 6 })   // 字面量 → 实现(靶)
 * ```
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 0 | 冻结层 `FEATHER_RANGE = 6`、`FEATHER_INVULN = 3.0`(字面量锚) | 有人把冻结常量改成 7 / 5.0 |
 * | 1 | 3 格 + 幽灵泡泡 ⇒ `revived:true`、`state=NORMAL`、`hpAfter=maxHp=385`、`invulnSec=3`、`reviveProgress/rescuerId/bubbleStacks` 清干净 | 复活给半血(把 `hpAfter` 改成 `REVIVE_HP_RATIO`) / 漏写 `invulnSec` / 漏清救援痕迹 |
 * | 2 | 6.1 格 ⇒ `revived:false`、**入参逐字段一字未动**、`reason` 含 `>`。夹具是**非默认值**(0.4 / `Helper` / 2) | 失败路径返回 `{...downed}` 并顺手清成默认值 / 删掉距离检查(回一个「复活了」的状态) |
 * | 3 | 目标 `NORMAL`(以及 `BUBBLED`)⇒ `revived:false`、理由非空且点名「幽灵」 | 删掉 `state !== GHOST_BUBBLE` 分支 / 失败理由留空串 |
 * | 4 | **6.0 本身必须成功**,6 与 6.1 两侧夹住 | 把 `distance > FEATHER_RANGE` 写成 `>=` |
 * | 5 | `method === ReviveMethod.FEATHER`;`levelUnchanged` 随 `progress.level === levelSnapshot` 真/假两种输入各一次 | 把 `levelUnchanged` 写死 `true`(掉级也报「零掉级」) |
 * | 6 | 水枪第 1、2 发 ⇒ `trapped:false`,`bubbleStacks` 1 → 2 | 层数只在局部累加没回传 / 首发就 `trapped` |
 * | 7 | 第 3 发 ⇒ `trapped:true`、`state=BUBBLED`、`invulnSec=5`、层数归 0 | 漏 `bubbleStacks: 0` / 漏 `state: BUBBLED` / 把 5 秒写成别的 |
 * | 8 | 纯函数性:两函数都不改入参(`JSON.stringify` 逐字相同);同输入两次同输出 | 就地 `downed.bubbleStacks += 1` / 把内部对象直接交出去 |
 *
 * ## 不保证的东西
 *
 * · 不保证这两件道具**能用**:生产调用点仍是 0。
 * · 不保证 `DownedState.invulnSec` 有读者(它是死字段,真正生效的是
 *   `Vitals.iframeSec`,见 `revive.ts:344` 的死实现警告)——
 *   本文件只断言**写进去了**,不断言**它有用**。
 * · 不断言 `reason` 的**全文措辞**,只断言其中有 `>` / 点名幽灵泡泡(改文案不该红,改语义应该红)。
 *
 * 运行:`node tests/WS-FND-36-dead-items.test.ts`
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { BodyState } from '../shared/types/physics.ts';
import { FEATHER_INVULN, FEATHER_RANGE } from '../shared/types/entities.ts';
import { createProgress, setLevel } from '../server/src/combat/progression.ts';
import {
  ReviveMethod,
  bubbleGunHit,
  createDowned,
  featherRevive,
  type DownedState,
  type EquipmentSnapshot,
} from '../server/src/combat/revive.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

const EQUIP: EquipmentSnapshot = { weapon: 101, armor: 201, helm: 301, boots: 401, relic: 501, cape: 601 };

/** Lv.20 的幽灵泡泡玩家(满血 385 由 WS-10 的既有断言钉住)。 */
function ghostAtLevel(level: number): { downed: DownedState; progress: ReturnType<typeof createProgress> } {
  const progress = setLevel(createProgress(`Fallen-${level}`), level);
  return { downed: createDowned(progress, EQUIP, 5, 5), progress };
}

/**
 * 「脏」幽灵泡泡:每个**可被顺手清掉**的字段都填成非默认值。
 *
 * ## 为什么必须脏(实测教训)
 *
 * `createDowned` 的默认值是 `reviveProgress: 0` / `rescuerId: null` / `bubbleStacks: 0`。
 * 用干净夹具测「超距失败时入参一字未动」,注入
 * `return { downed: { ...input.downed, reviveProgress: 0 }, ... }` 时**全绿**
 * —— 因为「清成默认值」这个改坏方向在默认值上不可观测(实测:11/11 通过)。
 * 把四个字段填成非默认值后,同一个注入立刻变红(判据 2)。
 */
function disturbed(d: DownedState): DownedState {
  return { ...d, downedSec: 2.5, reviveProgress: 0.4, rescuerId: 'Helper', bubbleStacks: 2 };
}

/** `DownedState` 的**全部**字段名 —— 「逐字段对比」的清单必须完整,否则漏掉的那个字段改了不红。 */
const DOWNED_FIELDS = [
  'playerId', 'levelSnapshot', 'expSnapshot', 'totalExpSnapshot',
  'x', 'y', 'downedSec', 'reviveProgress', 'rescuerId', 'bubbleStacks', 'invulnSec', 'state',
] as const;

/**
 * 逐字段 + 逐字节比对「入参对象一字未动」。
 *
 * 为什么既要逐字段又要 `JSON.stringify`:
 *   · 逐字段能**指出**是哪个字段被改了(报错可定位);
 *   · `JSON.stringify` 能抓到**键序**变化与嵌套对象(`equipmentSnapshot`)的改动,
 *     以及新增字段(`Object.keys` 数一并比对)。
 */
function assertUntouched(before: DownedState, after: DownedState, label: string): void {
  eq(JSON.stringify(after), JSON.stringify(before), `${label}:入参逐字未变`);
  eq(Object.keys(after).length, DOWNED_FIELDS.length + 1, `${label}:字段个数未变(含 equipmentSnapshot)`);
  for (const k of DOWNED_FIELDS) eq(after[k], before[k], `${label}:字段 ${k} 被改动`);
  eq(after.equipmentSnapshot, before.equipmentSnapshot, `${label}:装备栏快照被改动`);
}

/* ═══════════════════ 0. 冻结常量锚(字面量在右侧)═══════════════════ */

test('[0] 冻结层锚:FEATHER_RANGE = 6 格、FEATHER_INVULN = 3.0 秒', () => {
  /* 右侧是手写字面量,左侧取自 shared/types/entities.ts(定义模块)⇒ 两侧不同源。
     若有人把冻结常量改大,下面的 6.1 格判据会先红;这条让「改了哪个数」一眼可见。 */
  eq(FEATHER_RANGE, 6, '733 羽毛笔射程 = 6 格');
  eq(FEATHER_INVULN, 3.0, '733 复活后无敌 = 3.0 秒');
});

/* ═══════════════════ 1. 命中:满血复活 + 3 秒无敌 ═══════════════════ */

test('[1] 3 格 + 幽灵泡泡 ⇒ revived:true、NORMAL、满血、3 秒无敌、痕迹清干净', () => {
  const { downed, progress } = ghostAtLevel(20);
  const dirty = disturbed(downed);
  const before = JSON.stringify(dirty);
  const out = featherRevive({ downed: dirty, casterId: 'Angel', distance: 3, progress });

  eq(out.revived, true, '射程内应复活');
  ok(typeof out.reason === 'string' && out.reason.length > 0, '成功路径也要给理由');
  ok(out.result !== null, '成功路径必须带 result');
  eq(out.downed.state, BodyState.NORMAL, '复活后状态回到 NORMAL');
  /* 满血是「羽毛笔」与手动救援(50%)的关键区别:写成 out.result!.hpAfter === p.maxHp
     会让「实现改成半血」也通过(两侧同源),故用 Lv.20 的手写字面量 385。 */
  eq(out.result!.maxHpAfter, 385, 'Lv.20 生命上限 = 385(字面量)');
  eq(out.result!.hpAfter, 385, '羽毛笔满血复活 385(不是 50% 的 192)');
  eq(out.result!.hpAfter, out.result!.maxHpAfter, 'hpAfter 等于本帧上限');
  eq(out.result!.invulnSec, 3, 'result.invulnSec = 3 秒(字面量)');
  eq(out.downed.invulnSec, 3, '写进状态的无敌计时 = 3 秒(字面量)');
  eq(out.result!.state, BodyState.NORMAL, 'result.state 与 downed.state 一致');
  /* 复活要把「救援中」的痕迹清干净。夹具里这三个字段都是**非默认值**
     (0.4 / 'Helper' / 2),漏清任何一个都在这里红;用 createDowned 的默认值测不出。 */
  eq(out.downed.reviveProgress, 0, '复活清掉救援进度(入参是 0.4)');
  eq(out.downed.rescuerId, null, '复活清掉救援者(入参是 Helper)');
  eq(out.downed.bubbleStacks, 0, '复活清掉泡泡层数(入参是 2)');
  /* 返回的必须是**新对象**,且入参逐字未动。 */
  eq(JSON.stringify(dirty), before, '成功路径不改动入参');
  ok(out.downed !== dirty, '复活成功必须返回新对象,不能就地改入参');
  ok(out.result !== null && out.result.playerId === dirty.playerId, 'result 记录倒地者 id');
});

/* ═══════════════════ 2. 超距:不复活 + 入参一字未动 ═══════════════════ */

test('[2] 6.1 格 ⇒ revived:false、入参逐字段未被改动、reason 含 ">"', () => {
  const { downed, progress } = ghostAtLevel(20);
  const dirty = disturbed(downed);
  const snapshotBefore = JSON.stringify(dirty);

  const out = featherRevive({ downed: dirty, casterId: 'Angel', distance: 6.1, progress });

  eq(out.revived, false, '6.1 格超出 6 格射程 ⇒ 不复活');
  eq(out.result, null, '失败时 result 为 null(调用方据此退还道具)');
  assertUntouched(dirty, out.downed, '超距失败');
  eq(JSON.stringify(dirty), snapshotBefore, '调用后入参逐字未变');
  /* 反向自检:夹具必须是**脏**的,否则「清成默认值」这种改坏方向不可观测(实测教训见 disturbed)。 */
  eq(dirty.reviveProgress, 0.4, '前置:入参救援进度非默认 0.4');
  eq(dirty.rescuerId, 'Helper', '前置:入参救援者非默认 null');
  eq(dirty.bubbleStacks, 2, '前置:入参层数非默认 0');
  ok(typeof out.reason === 'string' && out.reason.length > 0, '失败必须给理由');
  ok(out.reason.includes('>'), `理由里应含 ">"(说明是距离超限):${out.reason}`);
  ok(out.reason.includes('6.1'), `理由里应带上实际距离:${out.reason}`);
  /* 超距失败的返回对象**就是**入参(实现原样回传):任何「顺手清个字段」都会在这里红。 */
  eq(out.downed.state, BodyState.GHOST_BUBBLE, '失败后仍是幽灵泡泡(没被偷偷复活)');
});

/* ═══════════════════ 3. 目标不是幽灵泡泡 ═══════════════════ */

test('[3] 目标 NORMAL / BUBBLED ⇒ revived:false,理由点名「幽灵」', () => {
  const { downed, progress } = ghostAtLevel(12);

  for (const state of [BodyState.NORMAL, BodyState.BUBBLED] as const) {
    const target: DownedState = disturbed({ ...downed, state });
    const before = JSON.stringify(target);
    const out = featherRevive({ downed: target, casterId: 'Angel', distance: 1, progress });

    eq(out.revived, false, `目标 state=${state} 时不应复活`);
    eq(out.result, null, `state=${state} 时 result 为 null`);
    assertUntouched(target, out.downed, `非幽灵泡泡(${state})`);
    eq(JSON.stringify(target), before, `state=${state} 时入参逐字未变`);
    ok(out.reason.length > 0, `state=${state} 失败必须给理由`);
    ok(out.reason.includes('幽灵'), `理由应点名「幽灵」泡泡:${out.reason}`);
  }

  /* 顺序也有语义:距离检查在状态检查**前**(超距优先报距离)。这里只记录,
     不算判据 —— 见下方「不保证」:措辞与顺序都不是本套件的命题。 */
});

/* ═══════════════════ 4. 边界 6.0 本身 ═══════════════════ */

test('[4] 边界值 6.0 本身必须成功(`>` 与 `>=` 的分界,用 6 / 6.1 两侧夹住)', () => {
  const { downed, progress } = ghostAtLevel(20);

  const atSix = featherRevive({ downed, casterId: 'Angel', distance: 6, progress });
  const atSixOne = featherRevive({ downed, casterId: 'Angel', distance: 6.1, progress });

  eq(atSix.revived, true, '恰好 6.0 格必须成功(实现是 `>` 而非 `>=`)');
  eq(atSix.result!.method, ReviveMethod.FEATHER, '6.0 格走的是羽毛笔');
  eq(atSixOne.revived, false, '6.1 格必须失败');
  /* 两侧夹住:若实现改成 `>=` 则左侧红;若改成 7 格则右侧红。 */
  ok(atSix.revived !== atSixOne.revived, '6.0 与 6.1 必须给出不同结论');
});

/* ═══════════════════ 5. method / levelUnchanged(两种输入)═══════════════════ */

test('[5a] progress.level === levelSnapshot ⇒ levelUnchanged:true', () => {
  const { downed, progress } = ghostAtLevel(20);
  eq(progress.level, downed.levelSnapshot, '前置:两边同为 20');

  const out = featherRevive({ downed, casterId: 'Angel', distance: 2, progress });
  eq(out.revived, true);
  eq(out.result!.method, ReviveMethod.FEATHER, '复活方式 = 羽毛笔(字面量成员)');
  eq(out.result!.method, 'FEATHER', 'method 的字符串值就是 FEATHER');
  eq(out.result!.levelUnchanged, true, '等级未变时 levelUnchanged = true');
});

test('[5b] progress.level !== levelSnapshot ⇒ levelUnchanged:false(不许写死 true)', () => {
  const { downed } = ghostAtLevel(20);
  const current = setLevel(createProgress('Fallen-20'), 22);
  eq(current.level, 22, '前置:当前等级 22');
  eq(downed.levelSnapshot, 20, '前置:倒地快照 20');

  const out = featherRevive({ downed, casterId: 'Angel', distance: 2, progress: current });
  eq(out.revived, true, '等级不一致不影响「能不能复活」');
  eq(out.result!.method, ReviveMethod.FEATHER, '复活方式仍是羽毛笔');
  eq(out.result!.levelUnchanged, false, '等级变了就必须报 false(写死 true 会红)');
  /* 复活本身不动快照字段:零掉级/零爆装的口径在这里被顺带钉住。 */
  eq(out.downed.levelSnapshot, 20, '复活不动 levelSnapshot');
  eq(out.downed.equipmentSnapshot, EQUIP, '复活不动装备栏快照');
  eq(out.result!.equipmentUnchanged, true, 'equipmentUnchanged = true');
});

/* ═══════════════════ 6. 水枪第 1、2 发 ═══════════════════ */

test('[6] 泡泡水枪第 1、2 发 ⇒ trapped:false,层数 1 → 2', () => {
  const { downed } = ghostAtLevel(10);

  const s1 = bubbleGunHit(downed);
  eq(s1.trapped, false, '第 1 发不困人');
  eq(s1.downed.bubbleStacks, 1, '第 1 发后层数 = 1(字面量)');
  eq(s1.downed.state, BodyState.GHOST_BUBBLE, '第 1 发不改状态');
  eq(s1.downed.invulnSec, 0, '第 1 发不写无敌计时');

  const s2 = bubbleGunHit(s1.downed);
  eq(s2.trapped, false, '第 2 发不困人');
  eq(s2.downed.bubbleStacks, 2, '第 2 发后层数 = 2(字面量)');
  eq(s2.downed.state, BodyState.GHOST_BUBBLE, '第 2 发不改状态');
  ok(s2.downed !== s1.downed, '每发都返回新对象');
});

/* ═══════════════════ 7. 第 3 发:装进大泡泡 ═══════════════════ */

test('[7] 第 3 发 ⇒ trapped:true、BUBBLED、5 秒、层数归 0', () => {
  const { downed } = ghostAtLevel(10);
  const s1 = bubbleGunHit(downed);
  const s2 = bubbleGunHit(s1.downed);
  const s3 = bubbleGunHit(s2.downed);

  eq(s3.trapped, true, '第 3 发必须困住(字面量:3 发)');
  eq(s3.downed.state, BodyState.BUBBLED, '状态变 BUBBLED');
  eq(s3.downed.invulnSec, 5, '困人计时 = 5 秒(字面量)');
  eq(s3.downed.bubbleStacks, 0, '层数归 0');
  /* 第 4 发从 0 重新数:证明「归 0」是真的回传了,不是只在 return 里做个样子。 */
  const s4 = bubbleGunHit(s3.downed);
  eq(s4.trapped, false, '第 4 发不困人(层数确实被清零)');
  eq(s4.downed.bubbleStacks, 1, '第 4 发后层数 = 1(重新计数)');
});

/* ═══════════════════ 8. 纯函数性 ═══════════════════ */

test('[8a] 两个函数都不修改入参(逐字比对 + 逐字段比对)', () => {
  const { downed, progress } = ghostAtLevel(15);
  const dirty = disturbed(downed);
  const before = JSON.stringify(dirty);

  /* 三条路径全走一遍:成功 / 超距失败 / 非幽灵失败。 */
  featherRevive({ downed: dirty, casterId: 'Angel', distance: 1, progress });
  eq(JSON.stringify(dirty), before, 'featherRevive 成功路径不得就地改入参');

  featherRevive({ downed: dirty, casterId: 'Angel', distance: 6.1, progress });
  eq(JSON.stringify(dirty), before, 'featherRevive 超距路径不得就地改入参');

  featherRevive({ downed: { ...dirty, state: BodyState.NORMAL }, casterId: 'Angel', distance: 1, progress });
  eq(JSON.stringify(dirty), before, 'featherRevive 非幽灵路径不得就地改入参');

  const hits = bubbleGunHit(dirty);
  eq(JSON.stringify(dirty), before, 'bubbleGunHit 不得就地改入参');
  eq(dirty.bubbleStacks, 2, '入参层数仍是 2(层数只在返回值里)');
  eq(hits.downed.bubbleStacks, 0, '返回值里层数归 0(2 + 1 = 3 ⇒ 困住并清零)');
  eq(hits.trapped, true, '从 2 层再中一发即困住');
});

test('[8b] 同样的输入调两次 ⇒ 同样的输出(无隐藏状态)', () => {
  const { downed, progress } = ghostAtLevel(20);
  const inputA = { downed, casterId: 'Angel', distance: 4, progress };

  const first = featherRevive(inputA);
  const second = featherRevive(inputA);
  eq(JSON.stringify(second), JSON.stringify(first), 'featherRevive 同输入两次同输出');

  const third = featherRevive({ downed, casterId: 'SomeoneElse', distance: 4, progress });
  eq(JSON.stringify(third), JSON.stringify(first), '换 casterId 也不影响结果(casterId 只是记账)');

  const h1 = bubbleGunHit(downed);
  const h2 = bubbleGunHit(downed);
  eq(JSON.stringify(h2), JSON.stringify(h1), 'bubbleGunHit 同输入两次同输出(层数不从模块级计数)');
});

report('WS-FND-36');