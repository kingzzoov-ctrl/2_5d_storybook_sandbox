/**
 * WS-FND-30 —— **`MODIFY_TOWN`(城镇改造)接线**。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md:81` 把 `MODIFY_TOWN` 归为「仓库里完全没有落地点」:
 * 「无城镇安全区 / 图腾实体,也无『谁有权改』的裁决」。接线前它只回
 * `NOT_IMPLEMENTED`(`actions/modify_town.ts` 的占位)。
 *
 * 接线之后能断言的是**第三段**——「谁有权改、改成了什么」变成一条可查的事实。
 * ⚠️ 前两段仍是缺口,本套件**不**声称它们被补齐,也**不**声称刷怪行为变了:
 *   世界侧(刷怪 / 安全区)今天**没有任何**读者,唯一事实源仍是
 *   `mobs/spawner.ts` 的 `TOWN_SAFE_RADIUS` 与 `isInsideSafeRadius`。
 *   故本文件的命题是「**登记 + 可查**」,而不是「改了就生效」(见被测文件开头)。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 有 `town` 位 ⇒ `OK` + 配置改了 + `effect` 有改前/改后 | 回 OK 却不写注册表 / 丢掉 before |
 * | 2 | 无权(GUEST / MEMBER)⇒ `PERMISSION` 且**整份配置一字未动** | 权限闸写在参数校验之后 / 拒绝路径也写配置 |
 * | 3 | 半径非法(负数 / 小数 / 越界 / 非数字)⇒ `INVALID` 且配置不变 | 去掉 `Number.isInteger` 或上下界判定 |
 * | 4 | 读回的就是刚改的(不是出厂值),且是**副本** | `townConfigOf` 直接返回内部对象 / 忘了写注册表 |
 * | 5 | 出厂值等于 `spawner.ts` 的 `TOWN_SAFE_RADIUS`(= 24,带字面量锚) | 本模块另拍一个默认半径 |
 * | 6 | 两次改造**叠加**(第二次不回出厂值) | 每次都从默认值重算 |
 * | 7 | 图腾格:登记 / 显式清掉(`null`,不靠省略) | 把 `null` 当成「没给这个字段」 |
 * | 8 | 其余参数的显式拒绝(空名 / 超长 / 形状不对 / 空改造)且配置不变 | 空改造回 OK(静默成功) |
 *
 * ## 用**真装配**
 *
 * `assemble()` 造出运行时,动作走 `rt.dispatchAction`(不手搓 `ActionContext`)。
 * 角色不手写:`ownerId` 与 `join` 的既有判定决定谁带 `town` 位
 * (`net/room.ts:1067`,房主恒 `OWNER`)。
 *
 * ## ⚠️ 两处刻意的写法,别当成笔误
 *
 *   1 第 5 条**没有**写成 `eq(townConfigOf(r).safeRadius, TOWN_SAFE_RADIUS)`:
 *     那会让断言的两侧同源(实现与期望一起变 ⇒ 恒真),门禁 `--strict-taut`
 *     的正确形态是「断言右侧不得取自被测模块」。这里改用**字面量锚**:
 *     `TOWN_SAFE_RADIUS` 自己先被钉到 24,出厂值再被钉到同一个 24 ——
 *     任何一侧漂了都会红,而两侧**不同源**。
 *   2 半径上下界同理:先用字面量把 `MIN_TOWN_RADIUS` / `MAX_TOWN_RADIUS` 钉住,
 *     再用它们构造越界输入。否则「放宽上界」这种改动不会让任何断言变红。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { TOWN_SAFE_RADIUS } from '../server/src/mobs/spawner.ts';
import {
  MAX_TOWN_NAME_LEN,
  MAX_TOWN_RADIUS,
  MIN_TOWN_RADIUS,
  clearTownRegistry,
  setTownClock,
  townConfigOf,
} from '../server/src/net/actions/modify_town.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

/** 假时钟(ms):配置里的 `updatedAtMs` 与回执都走它,判据不依赖真实时间。 */
let now = 1_000_000;
setTownClock(() => now);

/** 每个用例开始前:清空注册表 + 归零假时钟(防模块级状态跨用例泄漏)。 */
function reset(): void {
  clearTownRegistry();
  now = 1_000_000;
}

type RoomRole = 'OWNER' | 'MEMBER' | 'GUEST';

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  roomId: string;
};

/** 房间号逐个递增:即使 `reset()` 漏了,两个用例也不会互相踩配置。 */
let roomSeq = 0;

/**
 * 建一个**真装配**的房间,`p1` 按 `role` 入座。
 *
 * `ownerId` 跟着角色走(`net/room.ts:1067`):`OWNER` ⇒ `p1` 就是房主(带 `town` 位);
 * `MEMBER` / `GUEST` ⇒ 房主另有其人,`p1` 只能拿到对应角色。
 */
function makeRoom(role: RoomRole): Room {
  roomSeq += 1;
  const roomId = `r_town${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: role === 'OWNER' ? 'p1' : 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 48,
    /* 本套件测的是配置登记,不想让自发改刷的怪参与(它们会变成第三个「东西」,
       让失败信息难以归因)。 */
    mobs: false,
    rng: mulberry32(11),
  });
  a.runtime.join({ userId: 'p1', asGuest: role === 'GUEST' });
  return { rt: a.runtime, roomId };
}

/** 派一次 `MODIFY_TOWN`。载荷照 `WS-FND-20` 的写法传普通对象。 */
const disp = (rt: Room['rt'], payload: Record<string, unknown>) =>
  rt.dispatchAction('p1', RoomAction.MODIFY_TOWN, payload);

/** 出厂配置(`TOWN_SAFE_RADIUS` = 24,见第 5 条的字面量锚)。 */
const FACTORY = {
  safeRadius: 24,
  name: '默认城镇',
  totemCell: null,
  updatedBy: '',
  updatedAtMs: 0,
};

/** 取 `effect`(类型窄化:它是 `Record<string, string | number | boolean>`)。 */
const eff = (r: { effect?: Record<string, string | number | boolean> }) =>
  r.effect as Record<string, string | number | boolean>;

/* ───────────────────────── 1 ───────────────────────── */

test('FND30-1 有 `town` 位的房主 ⇒ OK,配置被改且 `effect` 有改前/改后', () => {
  reset();
  const { rt, roomId } = makeRoom('OWNER');
  eq(townConfigOf(roomId), FACTORY, '前置:未改过时是出厂配置');

  const r = disp(rt, { radius: 20, name: '青石镇' });
  eq(r.ok, true, `改造应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK(接线前这里是 NOT_IMPLEMENTED)');
  ok(r.effect !== undefined, '★ `OK` 必须带 effect(不留「回 OK 却无副作用」)');

  const e = eff(r);
  eq(e.beforeSafeRadius, 24, '★ effect 里的半径**改前**应是出厂值 24');
  eq(e.afterSafeRadius, 20, '★ effect 里的半径**改后**应是本次给的值');
  eq(e.beforeName, '默认城镇', '★ 名字的改前');
  eq(e.afterName, '青石镇', '★ 名字的改后');
  eq(e.updatedBy, 'p1', '★ 谁改的必须可查(那就是「谁有权改」的另一半)');
  eq(e.updatedAtMs, 1_000_000, '时刻取自可注入时钟,不读真实墙钟');

  const cfg = townConfigOf(roomId);
  eq(cfg.safeRadius, 20, '★ 注册表真的被改了(只回 OK 不算数)');
  eq(cfg.name, '青石镇', '名字也真的被改了');
  eq(cfg.updatedBy, 'p1', '登记里记下了发起者');
  eq(cfg.updatedAtMs, 1_000_000, '登记里记下了时刻');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND30-2 无权(GUEST / MEMBER)⇒ PERMISSION,且**整份配置一字未动**', () => {
  reset();
  for (const role of ['GUEST', 'MEMBER'] as const) {
    const { rt, roomId } = makeRoom(role);
    const r = disp(rt, { radius: 20, name: '篡改', totemCell: { x: 1, y: 1 } });
    eq(r.ok, false, `${role} 不能改造城镇`);
    eq(r.kind, 'PERMISSION',
      `★ ${role} 必须归类为 PERMISSION(不是 INVALID / NOT_IMPLEMENTED —— 那是「没权限」与`
      + '「参数不对」「没做」的区别,客户端提示完全不同)');
    ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须带原因');
    eq(townConfigOf(roomId), FACTORY, `★ ${role} 被拒后配置必须逐字段与出厂值相同(不是「没生效」就行)`);
  }

  /* 负对照:同一份载荷换个角色(**房主**)就成功 —— 证明上面两条拒的是**权限**,
     不是这个动作本身坏了(单看两条失败无法区分)。 */
  const { rt, roomId } = makeRoom('OWNER');
  const okOwner = disp(rt, { radius: 20 });
  eq(okOwner.kind, 'OK', 'OWNER 做同一件事应成功');
  eq(townConfigOf(roomId).safeRadius, 20, 'OWNER 的改造真的落进注册表');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND30-3 半径非法(负数 / 小数 / 越界 / 非数字)⇒ INVALID,且配置不变', () => {
  reset();
  /* 先把上下界**锚**住(右侧是字面量,不取自被测模块 ⇒ 不是同义反复)。
     上下界的取值理由见被测文件开头:6 = 路灯抑制半径 5 + 1;
     32 = `WorldSim` 默认世界 64 格(`world_sim.ts:897`)的半边。 */
  eq(MIN_TOWN_RADIUS, 6, '★ 下界应仍为 6 —— 它变了,下面的「越界」用例要一起重算');
  eq(MAX_TOWN_RADIUS, 32, '★ 上界应仍为 32 —— 同上');

  const { rt, roomId } = makeRoom('OWNER');
  const bad: Array<[string, unknown]> = [
    ['负数', -1],
    ['小数', 12.5],
    ['低于下界', MIN_TOWN_RADIUS - 1],
    ['高于上界', MAX_TOWN_RADIUS + 1],
    ['非数字字符串', '20'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ];
  for (const [label, radius] of bad) {
    const r = disp(rt, { radius });
    eq(r.ok, false, `${label} 的半径不能成功`);
    eq(r.kind, 'INVALID', `★ ${label} 必须归类为 INVALID(不是 PERMISSION)`);
    ok(typeof r.reason === 'string' && r.reason.length > 0, `${label} 的拒绝必须带原因`);
  }
  eq(townConfigOf(roomId), FACTORY, '★ 八次非法输入之后配置仍与出厂值逐字段相同');

  /* 负对照:边界值本身**合法**(确认上面拒的是越界,不是「什么都拒」)。 */
  eq(disp(rt, { radius: MIN_TOWN_RADIUS }).kind, 'OK', '下界本身应被接受');
  /* ⚠️ 右侧写**字面量**,不写 `MIN_TOWN_RADIUS` / `MAX_TOWN_RADIUS`:
     那两个常量由**被测模块**导出,拿它们当断言右侧就是同义反复
     (实现与期望一起漂 ⇒ 恒真),门禁 `--strict-taut` 会抓。
     上下界本身已在本条开头用字面量锚过 ⇒ 这里的 6 / 32 有独立来源。 */
  eq(townConfigOf(roomId).safeRadius, 6, '下界(6)真的写进去了');
  eq(disp(rt, { radius: MAX_TOWN_RADIUS }).kind, 'OK', '上界本身应被接受');
  eq(townConfigOf(roomId).safeRadius, 32, '上界(32)真的写进去了');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND30-4 `townConfigOf` 读回的就是刚改的(不是出厂值),且返回**副本**', () => {
  reset();
  const { rt, roomId } = makeRoom('OWNER');
  disp(rt, { radius: 28, name: '读回镇' });

  const cfg = townConfigOf(roomId);
  eq(cfg.safeRadius, 28, '★ 读回的必须是**刚改的**值(若读回出厂值,说明配置从没被登记)');
  ok(cfg.safeRadius !== FACTORY.safeRadius, '★ 且**不是**出厂值(这条防「读回函数恒回默认」)');
  eq(cfg.name, '读回镇', '整份配置都读得回');
  eq(cfg.updatedBy, 'p1', '含发起者');
  ok(cfg.updatedAtMs > 0, '含时刻(出厂值是 0 ⇒ 「改过」与「没改过」可分辨)');

  /* 副本:改返回对象不应影响注册表 —— 唯一写者仍是 `MODIFY_TOWN`。 */
  type Mutable = { name: string; safeRadius: number };
  (cfg as Mutable).name = '被调用方篡改';
  (cfg as Mutable).safeRadius = 999;
  eq(townConfigOf(roomId).name, '读回镇', '★ 返回的是副本(否则这里就读到被篡改的值)');
  eq(townConfigOf(roomId).safeRadius, 28, '★ 半径同理');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND30-5 出厂半径来自 `spawner.ts` 的 `TOWN_SAFE_RADIUS`(字面量锚 + 默认值)', () => {
  reset();
  /* 锚 1:世界侧那个常量自己必须还是 24。**右侧是字面量** ——
     故意不写成 `eq(townConfigOf(r).safeRadius, TOWN_SAFE_RADIUS)`:
     那两侧同源,实现与期望一起漂,恒真(门禁 `--strict-taut` 抓的正是它)。
     ⚠️ 这条红了意味着有人动了世界侧常量的值:此时**必须**同步重新决定
       本模块的出厂值,不能只改这里的 24。 */
  eq(TOWN_SAFE_RADIUS, 24, 'spawner.ts 的 `TOWN_SAFE_RADIUS` 应仍为 24(它的语义是「城镇安全区半径 24 格」)');

  /* 锚 2:未被改造过的房间,出厂半径必须等于同一个 24。 */
  const { roomId } = makeRoom('OWNER');
  const cfg = townConfigOf(roomId);
  eq(cfg.safeRadius, 24, '★ 未改过时半径应等于 24(=`TOWN_SAFE_RADIUS`;不等于说明本模块另拍了一个默认值)');
  eq(cfg.totemCell, null, '出厂没有图腾(世界侧至今没有图腾实体)');
  eq(cfg.updatedBy, '', '★ 出厂值的 `updatedBy` 是空串 ⇒「从未被改造过」本身可查');
  eq(cfg.updatedAtMs, 0, '出厂时刻是 0');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND30-6 两次改造**叠加**:第二次的「改前」是第一次的结果,不是出厂值', () => {
  reset();
  const { rt, roomId } = makeRoom('OWNER');

  const first = disp(rt, { radius: 28 });
  eq(first.kind, 'OK', '第一次改造应成功');
  eq(eff(first).beforeSafeRadius, 24, '第一次的改前是出厂值');
  eq(townConfigOf(roomId).safeRadius, 28, '第一次落地');

  now = 2_000_000;
  const second = disp(rt, { name: '第二版镇' });
  eq(second.kind, 'OK', '第二次改造应成功');
  eq(eff(second).beforeSafeRadius, 28, '★ 第二次的「改前」必须是第一次的结果');
  eq(eff(second).afterSafeRadius, 28, '★ 没提半径 ⇒ 半径保持不变(不回出厂值 24)');
  eq(eff(second).beforeName, '默认城镇', '名字这一侧的改前仍是出厂名');
  eq(eff(second).afterName, '第二版镇', '名字被改');
  eq(eff(second).updatedAtMs, 2_000_000, '时刻推进了(可注入时钟真的被读)');

  const cfg = townConfigOf(roomId);
  eq(cfg.safeRadius, 28, '★ 叠加:半径没被第二次改造重置');
  eq(cfg.name, '第二版镇', '名字是第二次的结果');
  eq(cfg.safeRadius === FACTORY.safeRadius, false, '★ 且确实**不是**出厂值(这条防「每次从默认值重算」)');

  const third = disp(rt, { radius: 30 });
  eq(eff(third).beforeSafeRadius, 28, '第三次的改前是第二次的结果');
  eq(townConfigOf(roomId).name, '第二版镇', '第三次只改半径 ⇒ 名字保留');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND30-7 图腾格:登记、显式清掉(`null` 而不是省略)、形状校验', () => {
  reset();
  const { rt, roomId } = makeRoom('OWNER');

  const set = disp(rt, { totemCell: { x: 7, y: 9 } });
  eq(set.kind, 'OK', `图腾格应能登记(kind=${set.kind} reason=${set.reason ?? '-'})`);
  eq(eff(set).beforeTotemCell, 'none', '改前没有图腾');
  eq(eff(set).afterTotemCell, '7,9', '★ 改后有坐标(`effect` 只能放标量 ⇒ 坐标扁平化成 "x,y")');
  eq(townConfigOf(roomId).totemCell, { x: 7, y: 9 }, '★ 注册表里真的记下了这一格');

  const clear = disp(rt, { totemCell: null });
  eq(clear.kind, 'OK', '`null` 表示**显式清掉**图腾');
  eq(eff(clear).afterTotemCell, 'none', '★ 清掉之后回执里是 none');
  eq(townConfigOf(roomId).totemCell, null, '★ 注册表里图腾真的没了');
  eq(townConfigOf(roomId).safeRadius, 24, '清图腾不应顺手改半径(字段是各管各的)');

  /* 形状不对:一个都不许写进去。 */
  for (const [label, totemCell] of [
    ['字符串', 'nope'],
    ['缺 y', { x: 3 }],
    ['小数', { x: 3.5, y: 4 }],
    ['null 之外的假值', false],
  ] as Array<[string, unknown]>) {
    const r = disp(rt, { totemCell });
    eq(r.kind, 'INVALID', `★ ${label} 的图腾格必须被拒`);
    eq(townConfigOf(roomId).totemCell, null, `★ ${label} 被拒后注册表仍是「没有图腾」`);
  }
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND30-8 其余参数的显式拒绝(空名 / 超长 / 形状 / 空改造)且配置不变', () => {
  reset();
  const { rt, roomId } = makeRoom('OWNER');

  eq(MAX_TOWN_NAME_LEN, 24, '★ 名字长度上限:防呆界(理由见被测文件),它变了这里要跟着看');

  const bad: Array<[string, Record<string, unknown>]> = [
    ['空名', { name: '' }],
    ['全空白名', { name: '   ' }],
    ['非字符串名', { name: 42 }],
    ['超长名', { name: '镇'.repeat(MAX_TOWN_NAME_LEN + 1) }],
    ['一个字段都没给(空改造)', {}],
    ['只给了无关字段', { itemId: 101 }],
  ];
  for (const [label, payload] of bad) {
    const r = disp(rt, payload);
    eq(r.ok, false, `${label} 不能成功`);
    eq(r.kind, 'INVALID', `★ ${label} 必须归类为 INVALID`);
    ok(typeof r.reason === 'string' && r.reason.length > 0, `${label} 的拒绝必须带原因`);
  }
  eq(townConfigOf(roomId), FACTORY, '★ 六次非法输入之后配置仍与出厂值逐字段相同');

  /* 负对照:边界长度(恰好 24)合法,且名字两端空白被去掉。 */
  const edge = disp(rt, { name: ` ${'镇'.repeat(MAX_TOWN_NAME_LEN)} ` });
  eq(edge.kind, 'OK', '恰好等于上限的名字应被接受');
  eq(townConfigOf(roomId).name.length, 24, '★ 名字被 trim 后落库(右侧写字面量:上面已有 `MAX_TOWN_NAME_LEN` 的锚)');
});

report('WS-FND-30');
