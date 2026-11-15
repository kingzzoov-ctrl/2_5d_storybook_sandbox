/**
 * WS-FND-33 —— `WIRE_EDIT`:**编辑一格上的接线**(接上 / 覆盖 / 断开)。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md:104` 把它登记为「缺布线编辑的落点
 * (`build/wiring_view.ts` 是**只读视图**,且它在 `orphan-audit` 里登记为
 * "缺 WireView 下发报文 + 铺线 UI 面板")」。接线前它逐字回 `NOT_IMPLEMENTED`
 * (`server/src/net/actions/wire_edit.ts` 的占位),于是**线上没有任何方式记录
 * 「这条线接在哪一格、朝哪个方向、走哪一色、挂哪个频道」** —— 铺线 UI 也就
 * 没有可写的那一端。
 *
 * ## ⚠️ 本套件钉的是「登记 + 可查」,**不是**「接上就通电」
 *
 * 被测模块的文件头写明了三条边界(不碰 `wiring/graph.ts` 的图、不下发任何报文、
 * ⇒ 电路不会因为这条记录而导通)。所以这里断言的对象是**本模块自己的登记表**
 * (`wireAt` / `wiresOfRoom`),不是信号图:
 * ```
 *   电路是否导通 ← 本次**没有**接线(缺 WireView 下发报文 + 铺线 UI 面板)
 *   登记是否成立 ← 本套件钉的就是这一层
 * ```
 * 与 `tests/WS-FND-30-town`(改造没有世界侧读者)/ `tests/WS-FND-28-party`
 * (分数没接慢帧计分)同一形态:边界写在被测文件头里,判据只钉**已经落地**的那部分。
 *
 * ## 逐条对应的判据(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 合法接线 ⇒ `OK` 且 `wireAt` 读得到颜色与频道 | 处理器只回 OK 却不写登记表 |
 * | 2 | 同向重复接同色同通道 ⇒ 幂等(记录数不增) | 去掉「已存在且相同 ⇒ changed: 0」那一支 |
 * | 3 | 同向改接不同色/通道 ⇒ **覆盖**,`effect` 有改前/改后 | 覆盖那一支不填 `fromColor`/`fromChannel` |
 * | 4 | 非法颜色 / 频道越界 / 非法方向 / 非整数坐标 ⇒ `INVALID` 且零状态 | 校验放在写之后,或把 `unknown` 当真值用 |
 * | 5 | `clear` 口径被钉住(本来就没有 ⇒ `INVALID`;真断开 ⇒ `OK`) | 两支混成一支(都会变红) |
 * | 6 | 跨房间隔离(A 房断开不动 B 房) | 登记表改成全局单桶(不按 `roomId` 分) |
 * | 7 | 越权 ⇒ `PERMISSION` 且零状态(GUEST 无 `wiring` 位) | 去掉处理器里的 `authorize` |
 *
 * ## 为什么断言右侧只用**字面量**
 *
 * 颜色与频道的合法域是 `ALL_COLORS` / `CHANNEL_MIN..CHANNEL_MAX`(被测模块 import 的
 * 同一来源)。若断言里写 `eq(edge.color, ALL_COLORS[0])`,把那份表改坏时**两侧同步移动**
 * ⇒ 断言恒真(`--strict-taut` 盯的就是这个)。故这里:
 * ```
 *   红 = 0 / 蓝 = 1(WireColor 的**字面值**,出处 shared/types/tile.ts:43)
 *   合法频道 3 / 5;反例取**域外**的 0(< CHANNEL_MIN=1)与 9(> CHANNEL_MAX=8)
 * ```
 * 反例是**构造出来**的(域外值),不是从被测模块读出来的。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionPayload } from '../server/src/net/room.ts';
import { wireAt, wiresOfRoom } from '../server/src/net/actions/wire_edit.ts';

/** 四色里的红 / 蓝 —— `WireColor.RED = 0`、`BLUE = 1`(`shared/types/tile.ts:43` 的**字面值**)。 */
const RED = 0;
const BLUE = 1;
/** 合法频道(`CHANNEL_MIN=1..CHANNEL_MAX=8` 之内),同样只写字面量。 */
const CH3 = 3;
const CH5 = 5;

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  /** 房间 id —— 本模块的登记表按它分桶,查询入口也要它。 */
  id: string;
};

/**
 * 真装配(`assemble()`)出来的房间 + 一个已加入的玩家。
 *
 * 夹具照 `tests/WS-FND-20-material-loop.test.ts`:`assemble()` 造运行时,
 * 动作走 `rt.dispatchAction`(**不手搓 `ActionContext`** —— 那会绕开权限闸与注册表)。
 * `mobs: false`:本套件与生物无关,不让自发改刷的怪掺进来。
 */
function makeRoom(roomId: string, asGuest = false): Room {
  const a = assemble({
    roomId,
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 48,
    mobs: false,
    rng: mulberry32(33),
  });
  a.runtime.join({ userId: 'p1', asGuest });
  return { rt: a.runtime, id: roomId };
}

/**
 * 派发一次 `WIRE_EDIT`。
 *
 * ⚠️ `dir` / `color` / `channel` / `clear` **还没写进** `ActionPayload`(`net/room.ts:828`)
 * ⇒ 这里做一次显式窄化(与 `tests/WS-FND-29-tame.test.ts:120` 同一手法),
 * 而不是把动作名改成裸字符串(那会绕开 `RoomAction` 这张唯一词表)。
 */
const wire = (rt: Room['rt'], p: Record<string, unknown>) =>
  rt.dispatchAction('p1', RoomAction.WIRE_EDIT, p as unknown as ActionPayload);

/**
 * 记录条数 = 房间里「格 · 方向」边的总数(**唯一**读法:`wiresOfRoom` 这个对外入口,
 * 不偷看模块内部 —— 判据 2 的「记录数不增」正是靠它量出来的)。
 */
function edgeCount(roomId: string): number {
  let n = 0;
  for (const dirs of wiresOfRoom(roomId).values()) n += dirs.size;
  return n;
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND33-1 合法接线 ⇒ OK,且 wireAt 读得到颜色与频道', () => {
  const { rt, id } = makeRoom('r_wire_1');
  eq(edgeCount(id), 0, '前置:这个房间还没接过任何线');

  const r = wire(rt, { x: 6, y: 7, dir: 1, color: RED, channel: CH3 });
  eq(r.ok, true, `接线应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  ok(r.effect !== undefined, '★ `OK` 必须带 effect(不留「回 OK 却无副作用」)');
  eq(r.effect?.changed, 1, '新增一条 ⇒ changed=1');
  eq(r.effect?.color, 0, '回执里的颜色 = 报文里的 0');
  eq(r.effect?.channel, 3, '回执里的频道 = 报文里的 3');

  const e = wireAt(id, 6, 7, 1);
  ok(e !== null, '★ 接上的那条边必须能被 wireAt 读到(否则「登记」这一步不存在)');
  eq(e!.color, 0, '★ 读到的颜色就是接上去的那个(WireColor.RED = 0)');
  eq(e!.channel, 3, '★ 读到的频道就是接上去的那个');
  eq(edgeCount(id), 1, '只登记了一条');

  /* 方向是**这一格朝哪个方向**的边:同一格别的方向必须还没接。 */
  ok(wireAt(id, 6, 7, 0) === null, '同一格的**另一个方向**没有被连带写上');
  ok(wireAt(id, 5, 7, 1) === null, '**另一格**也没有被连带写上');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND33-2 同向重复接同色同通道 ⇒ 幂等(记录数不增)', () => {
  const { rt, id } = makeRoom('r_wire_2');
  const first = wire(rt, { x: 4, y: 4, dir: 2, color: RED, channel: CH3 });
  eq(first.ok, true, '第一条应成功');
  eq(edgeCount(id), 1, '前置:1 条');

  for (let i = 0; i < 5; i += 1) {
    const again = wire(rt, { x: 4, y: 4, dir: 2, color: RED, channel: CH3 });
    eq(again.ok, true, `第 ${i + 2} 次同色同通道应仍成功(kind=${again.kind})`);
    eq(again.kind, 'OK', '重复接同一件事仍走 OK(不是错误)');
    eq(again.effect?.changed, 0,
      '★ 幂等 ⇒ changed=0(a「什么都没有变」必须与新增/覆盖区分开)');
    ok(typeof again.reason !== 'string',
      'OK 回执不该还带 reason(那是失败路径的字段)');
  }

  eq(edgeCount(id), 1, '★ 6 次派发之后记录数**仍是 1**(幂等,没有攒出重复项)');
  eq(wireAt(id, 4, 4, 2)!.color, 0, '颜色没被改动');
  eq(wireAt(id, 4, 4, 2)!.channel, 3, '频道没被改动');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND33-3 同向改接不同色/通道 ⇒ 覆盖,effect 给出改前/改后', () => {
  const { rt, id } = makeRoom('r_wire_3');
  wire(rt, { x: 8, y: 3, dir: 0, color: RED, channel: CH3 });
  eq(wireAt(id, 8, 3, 0)!.channel, 3, '前置:原来接的是 红/3');

  const r = wire(rt, { x: 8, y: 3, dir: 0, color: BLUE, channel: CH5 });
  eq(r.ok, true, `改接应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '覆盖也走 OK');
  eq(r.effect?.changed, 1, '★ 覆盖是真的一次变化 ⇒ changed=1');
  eq(r.effect?.fromColor, 0, '★ 改前颜色(= 红)在回执里');
  eq(r.effect?.fromChannel, 3, '★ 改前频道(= 3)在回执里');
  eq(r.effect?.color, 1, '改后颜色(= 蓝)在回执里');
  eq(r.effect?.channel, 5, '改后频道(= 5)在回执里');

  eq(edgeCount(id), 1, '★ 是**覆盖**不是新增:记录数仍是 1');
  eq(wireAt(id, 8, 3, 0)!.color, 1, '★ 读回来的是**改后**的颜色');
  eq(wireAt(id, 8, 3, 0)!.channel, 5, '★ 读回来的是**改后**的频道');

  /* 只改颜色 / 只改频道,也都算「不同」⇒ 覆盖(不能让「同色同通道」的判据放宽)。 */
  const colorOnly = wire(rt, { x: 8, y: 3, dir: 0, color: RED, channel: CH5 });
  eq(colorOnly.effect?.changed, 1, '只改颜色 ⇒ 覆盖');
  eq(colorOnly.effect?.fromColor, 1, '改前颜色 = 上一步的蓝');
  eq(colorOnly.effect?.fromChannel, 5, '改前频道 = 5');
  const channelOnly = wire(rt, { x: 8, y: 3, dir: 0, color: RED, channel: CH3 });
  eq(channelOnly.effect?.changed, 1, '只改频道 ⇒ 覆盖');
  eq(channelOnly.effect?.fromChannel, 5, '改前频道 = 5(上一步的)');
  eq(edgeCount(id), 1, '三次改接之后仍只有 1 条');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND33-4 非法颜色 / 频道 / 方向 / 坐标 ⇒ INVALID 且**一点不写**', () => {
  const { rt, id } = makeRoom('r_wire_4');
  /* 先合法接一条:**零状态**的对照物(非法报文不许改动它,也不许新增)。 */
  eq(wire(rt, { x: 5, y: 5, dir: 1, color: RED, channel: CH3 }).ok, true, '前置:合法接线');
  const before = edgeCount(id);
  eq(before, 1, '前置:1 条');

  /* 反例全部**构造**在合法域之外:
       · 颜色:4(> ALL_COLORS 里最大的 3)、-1、2.5、缺项;
       · 频道:0(< CHANNEL_MIN=1)、9(> CHANNEL_MAX=8)、2.5、缺项;
       · 方向:4、-1(合法域是四个方向:0..3);
       · 坐标:1.5 与 NaN(要求有限**整数**)。 */
  const bad: Array<[string, Record<string, unknown>]> = [
    ['颜色 4(域外,ALL_COLORS 只到 3)', { x: 5, y: 5, dir: 2, color: 4, channel: CH3 }],
    ['颜色 -1(域外)', { x: 5, y: 5, dir: 2, color: -1, channel: CH3 }],
    ['颜色 2.5(不是整数色号)', { x: 5, y: 5, dir: 2, color: 2.5, channel: CH3 }],
    ['颜色缺失', { x: 5, y: 5, dir: 2, channel: CH3 }],
    ['频道 0(域外,CHANNEL_MIN 之下)', { x: 5, y: 5, dir: 2, color: RED, channel: 0 }],
    ['频道 9(域外,CHANNEL_MAX 之上)', { x: 5, y: 5, dir: 2, color: RED, channel: 9 }],
    ['频道 2.5(不是整数频道)', { x: 5, y: 5, dir: 2, color: RED, channel: 2.5 }],
    ['频道缺失', { x: 5, y: 5, dir: 2, color: RED }],
    ['方向 4(不是四个方向之一)', { x: 5, y: 5, dir: 4, color: RED, channel: CH3 }],
    ['方向 -1', { x: 5, y: 5, dir: -1, color: RED, channel: CH3 }],
    ['方向 1.5', { x: 5, y: 5, dir: 1.5, color: RED, channel: CH3 }],
    ['方向缺失', { x: 5, y: 5, color: RED, channel: CH3 }],
    ['坐标 x 是小数', { x: 1.5, y: 5, dir: 2, color: RED, channel: CH3 }],
    ['坐标 y 是 NaN', { x: 5, y: NaN, dir: 2, color: RED, channel: CH3 }],
    ['坐标缺失', { dir: 2, color: RED, channel: CH3 }],
  ];

  for (const [why, payload] of bad) {
    const r = wire(rt, payload);
    eq(r.ok, false, `${why} ⇒ 必须失败(静默成功是本仓最坏的一类缺陷)`);
    eq(r.kind, 'INVALID',
      `${why} ⇒ 归类应是 INVALID(参数错,不是 INVALID 之外的任何一类)`);
    ok(typeof r.reason === 'string' && r.reason.length > 0, `${why} ⇒ 拒绝必须带原因`);
  }

  eq(edgeCount(id), before, '★ 15 次非法报文之后记录数**不变**(一点不写)');
  ok(wireAt(id, 5, 5, 2) === null, '★ 被拒的那条边没有留下任何记录');
  ok(wireAt(id, 5, 5, 0) === null, '★ 被拒的那条边没有留下任何记录(另一个方向)');
  eq(wireAt(id, 5, 5, 1)!.channel, 3, '★ 原来那条合法接线**一字未动**');
  eq(wiresOfRoom(id).size, 1, '★ 登记表里还是只有那一格(被拒的报文没有造出新的格子条目)');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND33-5 clear 口径被钉住:本来就没有 ⇒ INVALID;真断开 ⇒ OK', () => {
  const { rt, id } = makeRoom('r_wire_5');

  /* ── 5a 「本来就没有」⇒ **INVALID**(口径与理由见被测文件头:不给「拆空气」的
        静默成功,同 tests/WS-FND-20 的 FND20-4)。 ── */
  const empty = wire(rt, { x: 2, y: 2, dir: 1, clear: true });
  eq(empty.ok, false, '★ 本来就没有接线 ⇒ 不得回 ok:true(那是静默成功)');
  eq(empty.kind, 'INVALID', '★ 归类是 INVALID(不是 PERMISSION / NOT_IMPLEMENTED)');
  ok(/本来就没有/.test(empty.reason ?? ''),
    `★ 理由必须说清「本来就没有」(实测 reason=${empty.reason ?? '-'})`);
  eq(edgeCount(id), 0, '零状态:没写任何记录');

  /* ── 5b 真有一条 ⇒ 断开成功,且读不到了。 ── */
  wire(rt, { x: 2, y: 2, dir: 1, color: RED, channel: CH3 });
  eq(edgeCount(id), 1, '前置:已接上 1 条');
  const gone = wire(rt, { x: 2, y: 2, dir: 1, clear: true });
  eq(gone.ok, true, `真有一条时断开应成功(实测 kind=${gone.kind} reason=${gone.reason ?? '-'})`);
  eq(gone.kind, 'OK', '断开成功走 OK');
  eq(gone.effect?.changed, 1, '★ changed=1(真的删掉了一条,不是「本来就没有」)');
  eq(gone.effect?.color, 0, '回执里带着被断开那条的颜色');
  eq(gone.effect?.channel, 3, '回执里带着被断开那条的频道');
  ok(wireAt(id, 2, 2, 1) === null, '★ 断开之后 wireAt 读不到');
  eq(edgeCount(id), 0, '记录数回到 0');

  /* ── 5c 同一口径的另一半(刻意,不是遗漏):**重复 clear 第二次 ⇒ INVALID**。
        客户端据此能分辨「真的删掉了一条」与「重复发的同一份报文」。 ── */
  const twice = wire(rt, { x: 2, y: 2, dir: 1, clear: true });
  eq(twice.kind, 'INVALID', '★ 第二次 clear ⇒ INVALID(不是假装又断了一次)');

  /* ── 5d 含糊的 clear 取值与「既接又断」都被显式拒(不许靠 JS 真值转换猜)。 ── */
  const fuzzy = wire(rt, { x: 2, y: 2, dir: 1, clear: 'true' });
  eq(fuzzy.kind, 'INVALID', "clear 只接受字面 true('true' 也拒)");
  const mixed = wire(rt, { x: 2, y: 2, dir: 1, clear: true, color: RED, channel: CH3 });
  eq(mixed.kind, 'INVALID', 'clear 与 color/channel 不能同时给(一次只表达一件事)');
  eq(edgeCount(id), 0, '★ 后三次失败之后仍然是 0 条(零状态)');

  /* ── 5e 只断**那一个方向**:同格别的方向不受牵连。 ── */
  wire(rt, { x: 2, y: 2, dir: 3, color: BLUE, channel: CH5 });
  wire(rt, { x: 2, y: 2, dir: 1, color: RED, channel: CH3 });
  eq(edgeCount(id), 2, '前置:同格两个方向各一条');
  eq(wire(rt, { x: 2, y: 2, dir: 1, clear: true }).kind, 'OK', '断开 dir=1');
  ok(wireAt(id, 2, 2, 1) === null, '★ 被断的那个方向没了');
  ok(wireAt(id, 2, 2, 3) !== null, '★ 同格另一个方向还在(断开是**按方向**的)');
  eq(wireAt(id, 2, 2, 3)!.channel, 5, '另一个方向的频道没被牵动');
  eq(edgeCount(id), 1, '★ 只少了一条(不是整格清空)');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND33-6 跨房间隔离:同格同方向在两个房间里互不影响', () => {
  const a = makeRoom('r_wire_a');
  const b = makeRoom('r_wire_b');

  eq(wire(a.rt, { x: 9, y: 9, dir: 1, color: RED, channel: CH3 }).kind, 'OK', 'A 房接线');
  eq(wire(b.rt, { x: 9, y: 9, dir: 1, color: BLUE, channel: CH5 }).kind, 'OK', 'B 房**同格同方向**另接一条');
  eq(edgeCount(a.id), 1, 'A 房 1 条');
  eq(edgeCount(b.id), 1, 'B 房 1 条');

  eq(wireAt(a.id, 9, 9, 1)!.color, 0, '★ A 房读到的是 A 接的(红)');
  eq(wireAt(a.id, 9, 9, 1)!.channel, 3, '★ A 房读到的是 A 接的频道');
  eq(wireAt(b.id, 9, 9, 1)!.color, 1, '★ B 房读到的是 B 接的(蓝)—— 没被 A 覆盖');
  eq(wireAt(b.id, 9, 9, 1)!.channel, 5, '★ B 房的频道也没被 A 牵动');

  const cut = wire(a.rt, { x: 9, y: 9, dir: 1, clear: true });
  eq(cut.kind, 'OK', 'A 房断开自己那条');
  ok(wireAt(a.id, 9, 9, 1) === null, 'A 房那条没了');
  ok(wireAt(b.id, 9, 9, 1) !== null,
    '★ B 房那条**一条不少**(登记表按 roomId 分桶,断开不会穿房间)');
  eq(edgeCount(b.id), 1, '★ B 房的条数不变');
  eq(edgeCount(a.id), 0, 'A 房回到 0');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND33-7 越权 ⇒ PERMISSION 且零状态(GUEST 没有 wiring 位)', () => {
  const g = makeRoom('r_wire_guest', true);
  const r = wire(g.rt, { x: 3, y: 3, dir: 1, color: RED, channel: CH3 });
  eq(r.ok, false, 'GUEST 不能布线');
  eq(r.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(不是 INVALID —— 那会把「越权」与「参数错」混成一个值)');
  eq(edgeCount(g.id), 0, '★ 被拒后零状态(闸在第一行,先于任何写)');

  /* 负对照:非 GUEST 做同一件事**要能成功** —— 否则上面可能只是「这个动作永远失败」。 */
  const o = makeRoom('r_wire_owner');
  const okr = wire(o.rt, { x: 3, y: 3, dir: 1, color: RED, channel: CH3 });
  eq(okr.kind, 'OK', '负对照:非访客能接上(证明上面失败的是**权限**,不是动作本身)');
  eq(wireAt(o.id, 3, 3, 1)!.color, 0, '负对照:登记真的写进去了');
});

report('WS-FND-33');
