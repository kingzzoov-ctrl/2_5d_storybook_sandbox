/**
 * WS-FND-18 —— **档 B:22 个 `RoomAction` 的执行层归属必须**逐个明确**。
 *
 * ## 判据
 *
 * `COMPLETION-CRITERIA.md` 档 B 的原文是:
 * ```
 * [ ] 22 个 RoomAction 中,该有执行层的那些**真的执行**
 * ```
 * 「该有执行层的那些」是个**需要逐个裁决**的集合 —— 而它此前只活在注释里。
 * 本套件把它变成**机器可查的归属**:
 *
 * ```
 * 每个动作 ∈ {已接线(dispatchAction 不返回 NOT_IMPLEMENTED), 未接线(显式 NOT_IMPLEMENTED)}
 * 两组不交、并集 = `RoomAction` 的全部键 ⇒ 新增动作必须当场作决定(判据已改为逐键相等,不数总数)
 * 未接线的每个在 docs/TASK-96-action-landing-gaps.md 里写明「缺什么」
 * ```
 *
 * ## 为什么"显式 NOT_IMPLEMENTED"本身是判据
 *
 * 此前的形态是 `onMessage('action')` **成功分支为空** —— 玩家发 `PLACE_BLOCK`,
 * 服务端回 `allowed`,然后**什么都不发生**:无错误、无回执、连 `else` 都没有。
 * 「静默成功」比「明确失败」坏得多,因为它让"没做"与"做了"在客户端不可区分。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble } from '../server/src/index.ts';
import {
  RoomAction, PERMISSION_MATRIX, ACTION_PERMISSION, type ActionOutcome,
} from '../server/src/net/room.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 建一个**生产装配**出来的运行时(不手搓 rtOpts —— 那会绕开 `assemble()`)。 */
const mkRuntime = (): ReturnType<typeof assemble>['runtime'] => {
  const a = assemble({ roomId: 'r_act', ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 16 });
  a.runtime.join({ userId: 'o' });
  return a.runtime;
};

const ALL_ACTIONS: string[] = Object.values(RoomAction);
test('FND18-1 动作清单:每个 `RoomAction` 都由 `dispatchAction` 给出**归类**(不交、不重、不漏)', () => {
  /* 变红条件:
       1 `RoomAction` 里两个键指向**同一个**动作名(复制粘贴手滑)⇒ 第一条红 ——
          那会让「逐个动作归类」把同一个动作数两次、同时另一个动作静默消失;
       2 有人让 `dispatchAction` 对某个动作 **throw** ⇒ 归类直接失败;
       3 归类结果与 `RoomAction` 的**键集**不相等(某动作被 `continue` 掉 / 两边都在)⇒ 红。
     ⚠️ 这里**不写死动作总数**(此前的形态是 `eq(ALL_ACTIONS.length, 22)` 与
        `eq(wired.length + notImpl.length, 22)`:加第 23 个动作就得手改)。
        要钉的是**结构** —— 键集 = 归类集、键值不重复;「一共几个」由 `RoomAction`
        自己派生。加动作而不归类 ⇒ 仍然红,这正是要的信号。
     ⚠️ 这里**不**断言"哪些个应该接" —— 那是产品裁决,不是测试能决定的。 */
  /* 不重:值就是动作名,两个键不许指向同一个值。 */
  eq(new Set(ALL_ACTIONS).size, ALL_ACTIONS.length,
    'RoomAction 的值不许重复(重复会让归类结果虚高、真动作被吞掉)');
  const rt = mkRuntime();
  const wired: string[] = [];
  const notImpl: string[] = [];
  for (const action of ALL_ACTIONS) {
    let out: ActionOutcome;
    try {
      out = rt.dispatchAction('o', action as never, {});
    } catch (e) {
      throw new Error(`dispatchAction(${action}) 抛错 —— 它必须**返回**结论:${(e as Error).message}`);
    }
    if (out.kind === 'NOT_IMPLEMENTED') notImpl.push(action);
    else wired.push(action);
  }
  /* 不交:一个动作不能同时"接了"和"没接" */
  const both = wired.filter((a) => notImpl.includes(a));
  eq(both.join(','), '', `同一动作不能既接线又 NOT_IMPLEMENTED:${both.join(',') || '无'}`);
  /* 不重 + 覆盖:**归类集 === RoomAction 的键集**(逐个相等,不是"数量相等") */
  eq([...wired, ...notImpl].sort(), [...ALL_ACTIONS].sort(),
    '归类结果必须恰好等于 RoomAction 的全部键:漏判(某动作没被裁决)与重判(同一动作进两组)都红');
  ok(wired.length > 0, '至少要有一个真的接上了(否则这条判据没有意义)');
  /* 归类数自洽:已接线 + 未接线 = 键数(键数派生,不写死) */
  eq(wired.length + notImpl.length, Object.keys(RoomAction).length,
    '归类数应自洽:已接线 + 未接线 = RoomAction 的键数');
});

test('FND18-2 未接线的动作必须**显式**返回 NOT_IMPLEMENTED,且理由在文档里逐条写明', () => {
  /* 变红条件:
       1 把某个未接动作改成返回 ok:true(kind:'OK')⇒ 「静默成功」复发;
       2 未接动作的 reason 为空 ⇒ 客户端与读者都不知道为什么;
       3 新增了未接动作但没写进 `docs/TASK-96-action-landing-gaps.md` ⇒ 红。 */
  const rt = mkRuntime();
  const doc = readFileSync(join(ROOT, 'docs', 'TASK-96-action-landing-gaps.md'), 'utf8');
  const notImpl: string[] = [];
  for (const action of ALL_ACTIONS) {
    const out = rt.dispatchAction('o', action as never, {});
    if (out.kind !== 'NOT_IMPLEMENTED') continue;
    notImpl.push(action);
    eq(out.ok, false, `${action} 未接线时**不许** ok:true`);
    ok(typeof out.reason === 'string' && out.reason.length > 0, `${action} 必须给出理由`);
    ok(doc.includes(action), `docs/TASK-96-action-landing-gaps.md 里应逐条写明 ${action} 缺什么`);
  }
  ok(notImpl.length > 0, '本条只在存在未接动作时有意义(全部接上后这条自然失效,届时删掉)');
});

test('FND18-3 已接线的动作回 `OK` 时必须带 `effect`(不留"回 OK 却无副作用")', () => {
  /* 变红条件:某个 case 写成 `return { ok: true, kind: 'OK' }` 而没有任何 effect
     ⇒ 客户端只知道"成功",不知道成功成了什么,而门禁不会红。
     ⚠️ `effect` 不是"日志":它会被 handler 回传给客户端(`actionResult`)。 */
  const rt = mkRuntime();
  const missing: string[] = [];
  for (const action of ALL_ACTIONS) {
    const out = rt.dispatchAction('o', action as never, {});
    if (out.kind !== 'OK') continue;
    const effect = (out as { effect?: Record<string, unknown> }).effect;
    if (effect === undefined || Object.keys(effect).length === 0) missing.push(action);
  }
  eq(missing.join(','), '', `这些动作回了 OK 却没有 effect:${missing.join(',') || '无'}`);
});

test('FND18-4 越权**不执行**:已接线回 PERMISSION、未接线回 NOT_IMPLEMENTED(都不许 OK)', () => {
  /* 变红条件:某个动作只做业务、不做 `authorize` ⇒ GUEST 也能 `MODIFY_TOWN`。
     ⚠️ 这里给的是**合法 payload** —— 因为 `dispatchAction` 的判序是
        「先校验载荷形状,再问权限」:缺 payload 会先回 `INVALID`,
        那条路径测的是参数校验,不是权限闸。两条路径都要各自有断言,
        但**别把它们混成一条**(混了就会像我第一版那样,把 INVALID 当成权限失败)。
     ⚠️ 未接线的动作(GUEST 也无所谓)走 NOT_IMPLEMENTED —— 同样"没执行",
        但类别必须**如实**:不能把"这功能没有"报成"你没权限"。 */
  const a = assemble({ roomId: 'r_act2', ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 16 });
  const rt = a.runtime;
  rt.join({ userId: 'o' });
  rt.join({ userId: 'g', asGuest: true });
  /* 表 = 「GUEST 被拒」的**结构**:每个 GUEST 缺的权限位至少一行(判据见下方 ②/③)。
     ⚠️ 加动作**不必**改这里;只有当新动作落在「目前没有用例覆盖的被拒权限位」上时才红。 */
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['MOVE', {}, 'NOT_IMPLEMENTED'],
    ['CLOSE_ROOM', {}, 'PERMISSION'], /* destructive */
    ['SET_ROOM_ACCESS', { mode: 'PUBLIC' }, 'PERMISSION'], /* configure */
    ['KICK_MEMBER', { targetId: 'o' }, 'PERMISSION'], /* manage */
    ['PLACE_BLOCK', {}, 'PERMISSION'], /* build */
    ['PLACE_AUTOMATION', {}, 'PERMISSION'], /* wiring */
    ['OPEN_CHEST', {}, 'PERMISSION'], /* publicStorage */
    ['MODIFY_TOWN', {}, 'PERMISSION'], /* town */
    ['START_PARTY', {}, 'PERMISSION'], /* party */
  ];
  for (const [action, payload, expected] of cases) {
    const out = rt.dispatchAction('g', action as never, payload);
    ok(out.kind !== 'OK', `GUEST 执行 ${action} 不该成功(实得 ${out.kind})`);
    eq(out.kind, expected, `${action} 对 GUEST 的拒绝类别`);
  }
  /* 负对照:OWNER 做同一件事应当成功(否则上面这些可能只是"全都失败了") */
  const okOwner = rt.dispatchAction('o', 'KICK_MEMBER' as never, { targetId: 'g' });
  eq(okOwner.kind, 'OK', 'OWNER 踢 GUEST 应成功 —— 证明上面失败的是**权限**,不是这个动作本身');

  /* ═══ 表的**结构**判据(不含动作总数,新动作进来通常不需要改本段) ═══
   * ① 表里每个名字都必须是 `RoomAction` 的真键 —— 否则那条用例在测一个**不存在**的动作,
   *    「越权被拒」可能只是因为它压根不是动作(往表里塞一条 'NO_SUCH_THING' ⇒ 这里红);
   * ② 表必须覆盖 GUEST **被拒的每一个权限位**(由 `PERMISSION_MATRIX.GUEST` 派生):
   *    删掉某一行(如 CLOSE_ROOM)就会留下一个没有任何用例的 `destructive` 位 ⇒ 红;
   * ③ 期望 PERMISSION 的行,其权限位必须真是 GUEST 没有的(同样派生,不靠人肉核对)。
   *  ⚠️ 新增动作并纳进 `ACTION_PERMISSION` 后本段自然仍绿;若新动作占了一个**没有用例
   *     覆盖**的被拒权限位 ⇒ 红 —— 那正是「加动作必须当场作决定」的信号。 */
  const actionKeys = new Set<string>(Object.keys(RoomAction));
  const guestPerms = PERMISSION_MATRIX.GUEST;
  const deniedBits = Object.keys(guestPerms)
    .filter((bit) => guestPerms[bit as keyof typeof guestPerms] === false);

  for (const [action, , expected] of cases) {
    ok(actionKeys.has(action),
      `FND18-4 表里的 ${action} 不是 RoomAction 的键 ⇒ 这条用例在测一个不存在的动作`);
    if (expected !== 'PERMISSION') continue;
    const bit = ACTION_PERMISSION[action as RoomAction];
    ok(guestPerms[bit] === false,
      `${action} 期望 GUEST 回 PERMISSION,但 \`PERMISSION_MATRIX.GUEST.${String(bit)}\` 为 true`
      + ' ⇒ 期望与权限矩阵矛盾');
  }

  const coveredBits = new Set<string>(
    cases.filter(([, , expected]) => expected === 'PERMISSION')
      .map(([action]) => String(ACTION_PERMISSION[action as RoomAction])),
  );
  const uncovered = deniedBits.filter((bit) => !coveredBits.has(bit));
  eq(uncovered.join(','), '',
    `GUEST 被拒的权限位必须各有至少一条越权用例(缺:[${uncovered.join(',')}];`
    + `已覆盖:[${[...coveredBits].sort().join(',')}];被拒位:[${deniedBits.join(',')}])`);

});
report('WS-FND-18');