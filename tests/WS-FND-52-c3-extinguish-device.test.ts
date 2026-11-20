/**
 * WS-FND-52 —— **C3 的灭火半边**:玩家手里终于有"对着器件浇水"的动词。
 *
 * ## 补的是哪一条
 *
 * `cooking.ts` 的 `extinguishStation` / `EXTINGUISH_RADIUS` 与 `WorldSim.extinguishStationAt`
 * **都早已存在**,判据也有(`WS-14` 的 D 组直接调 `sim.extinguishStationAt`)——
 * 但那条路只有**机械臂**能触发(炉火灭了 ⇒ 投料作废),玩家从 `USE_ITEM` 走过来时
 * 只有"对玩家用"一条路(救人 / 困人 / 吃 buff)。⇒ 「227 对器件/火焰的路径」生产者为零。
 *
 * 本套件钉的是新加的**器件目标**(`targetDeviceId`)那一半,以及它与玩家目标的**互斥**。
 *
 * ## 每条"生效"都配了负对照
 *
 * 太远 / 不是料理站 / 器件不在图上 / 已经灭了 / 道具不对 —— 五种拒绝各自一条,
 * 否则"拒绝"与"压根没跑"分不开。
 *
 * ## ⚠️ 断言右侧一律用**字面量**
 *
 * `506` / `212` / `227` / `526` / `3` / `1` 取自**冻结内容表**(物件 id、道具 id)与
 * 手册,不取被测模块的导出常量 —— 否则就是同义反复(门禁 `--strict-taut`)。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

/** 506 大汤锅(料理站)/ 507 切菜台 / 508 披萨炉 —— 只有它们有"炉火"这个概念。 */
const SOUP_POT = 506;
/** 212 大铁铲(cooking.ts 的注释点名它也能浇灭炉火)。 */
const SHOVEL = 212;
/** 227 泡泡连发水枪。 */
const BUBBLE_GUN = 227;
/** 526 露天温泉石灯笼 —— 一件**不是**料理站的真实物件,用来做"器件类型不对"的反例。 */
const ONSEN_LANTERN = 526;
/** 汤锅所在格;玩家坐标是**格中心**,故锅中心是 (4.5, 4.5)。 */
const POT_X = 4;
const POT_Y = 4;

type Runtime = ReturnType<typeof assemble>['runtime'];

let seq = 0;

interface Scene {
  rt: Runtime;
  sim: WorldSim;
}

/**
 * 一张安静的图:`mobs: false` 不刷怪。玩家位置可给("太远"的反例要它)。
 *
 * ⚠️ 前置(道具真在背包里)**不是断言对象**:扣减走总量守恒,凭空的负 delta 会被
 * 反作弊整批拒。这里只负责把前置摆好,消耗方向由判据自己钉。
 */
function scene(seed: number, playerX: number, playerY: number, opts: { pot: boolean }): Scene {
  seq += 1;
  const a = assemble({
    roomId: `r_c3_${seq}`, ownerId: 'p1', sizeCells: 24, mobs: false, rng: mulberry32(seed),
  });
  const sim = a.host as unknown as WorldSim;
  a.runtime.join({ userId: 'p1' });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const u of ['p1']) for (const id of a.runtime.authoritativeItemIds(u)) a.runtime.applyInventory(u, { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount(u, id) }] });
  if (opts.pot) sim.setCell(POT_X, POT_Y, { obj: SOUP_POT });
  sim.setCell(5, 5, { obj: ONSEN_LANTERN });
  if (sim.physics.bodies.has('p1')) sim.setPlayerPos('p1', playerX, playerY);
  else sim.addPlayer('p1', playerX, playerY);

  for (const [itemId, n] of [[BUBBLE_GUN, 2], [SHOVEL, 1], [602, 1]] as const) {
    const src = `seed:${itemId}`;
    a.runtime.grantItemSource('p1', src);
    const seeded = a.runtime.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
    if (!seeded.allowed) throw new Error(`前置失败:塞不进 ${n} 件 ${itemId}`);
  }
  return { rt: a.runtime, sim };
}

/** 站在锅边的合法距离(格中心到格中心 2.0 格 < `EXTINGUISH_RADIUS` 3 格)。 */
const NEAR = (seed: number): Scene => scene(seed, POT_X + 0.5, POT_Y + 2.5, { pot: true });
/** 5.0 格 —— 内容层认的半径是 3 格,这条必须被拒。 */
const FAR = (seed: number): Scene => scene(seed, POT_X + 0.5, POT_Y + 5.5, { pot: true });

const fireOut = (sim: WorldSim, deviceId: number): boolean => sim.stationState(deviceId).fireOut;
const totalOf = (rt: Runtime): number =>
  (rt as unknown as { authoritativeItemTotal(u: string): number }).authoritativeItemTotal('p1');
const disp = (rt: Runtime, payload: Record<string, unknown>) =>
  rt.dispatchAction('p1', RoomAction.USE_ITEM, payload);
const eff = (r: { effect?: unknown }): Record<string, string | number | boolean> =>
  r.effect as Record<string, string | number | boolean>;
const why = (r: { reason?: string }): string => String(r.reason ?? '');

/* ══════════════════ 1 正例:水枪对着汤锅 ⇒ 炉火真的灭了 ══════════════════ */

test('FND52-1 ★ 227 对着 3 格内的汤锅 ⇒ `fireOut` 真的置位并扣 1 件', () => {
  const s = NEAR(1);
  eq(fireOut(s.sim, SOUP_POT), false, '前置:炉火还没灭');

  const out = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT });

  eq(out.ok, true, `应成功(kind=${out.kind} reason=${why(out)})`);
  eq(out.kind, 'OK', '应是 OK');
  eq(eff(out).deviceId, 506, '回执里应报出是哪个器件');
  eq(eff(out).fireOut, true, '回执里应报出炉火已灭');
  eq(eff(out).consumed, 1, '★ 用掉一件 ⇒ 应扣 1 件');
  eq(fireOut(s.sim, SOUP_POT), true, '★★ 世界侧炉火必须真的灭了(不是只回了 OK)');
});

test('FND52-2 负对照:太远(5 格 > 3 格)⇒ 拒绝、无回执、炉火不变、道具不扣', () => {
  const s = FAR(2);
  const total = totalOf(s.rt);

  const out = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT });

  eq(out.ok, false, '超距必须被拒');
  eq(out.kind, 'INVALID', '应是 INVALID');
  ok(out.effect === undefined, '没生效就没有 effect(也就没有 consumed)');
  eq(fireOut(s.sim, SOUP_POT), false, '★ 炉火不得被"远程"点灭');
  eq(totalOf(s.rt), total, '★ 超距一件都不扣');
});

test('FND52-3 ★ 超距被拒**不消耗**道具:同一件随后靠近还能用', () => {
  const s = FAR(3);
  const total = totalOf(s.rt);
  eq(disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT }).ok, false, '前置:超距那一次被拒');

  /* 站到锅边再来一次 —— 若上一步偷偷扣了,这里会因为"没有这件道具"而失败。 */
  s.sim.setPlayerPos('p1', POT_X + 0.5, POT_Y + 2.5);
  const out = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT });

  eq(out.ok, true, `靠近后应成功(reason=${why(out)})`);
  eq(eff(out).consumed, 1, '★ 这一次才扣 1 件');
  eq(totalOf(s.rt), total - 1, '★★ 全程只少 1 件(超距那次没白扣)');
});

test('FND52-4 ★ 212 大铁铲走**同一条**器件路径(内容注释点名了它)', () => {
  const s = NEAR(4);
  const out = disp(s.rt, { itemId: SHOVEL, targetDeviceId: SOUP_POT });

  eq(out.ok, true, `铁铲也应能浇灭(reason=${why(out)})`);
  eq(eff(out).itemId, 212, '回执里的 itemId 应是铁铲');
  eq(fireOut(s.sim, SOUP_POT), true, '★ 炉火必须真的灭了');
});

/* ══════════════════ 2 四种拒绝各一条 ══════════════════ */

test('FND52-5 负对照:526 石灯笼**不是料理站** ⇒ 拒绝,且不会顺手建一份炉火状态', () => {
  const s = NEAR(5);
  const out = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: ONSEN_LANTERN });

  eq(out.ok, false, '非料理站必须被拒');
  ok(why(out).includes('不是料理站'), `理由要指认器件类型不对(实测:${why(out)})`);
  eq(fireOut(s.sim, ONSEN_LANTERN), false, '★ 不得给非料理站置 fireOut');
});

test('FND52-6 ★ 器件在图上有对应格才算数:凭空报一个料理站 id ⇒ 拒绝', () => {
  /* 这一张图**没有**放汤锅(pot: false),但 506 是合法料理站 id。 */
  const s = scene(6, POT_X + 0.5, POT_Y + 2.5, { pot: false });
  const out = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT });

  eq(out.ok, false, '图上没有这个器件就必须拒');
  ok(why(out).includes('图上没有器件'), `理由要指认"图上找不到"(实测:${why(out)})`);
  eq(fireOut(s.sim, SOUP_POT), false, '★ 不得凭空给一个不存在的器件置火');
});

test('FND52-7 ★ 已经灭了的炉子再来一次 ⇒ 拒绝(不许把第二件道具浪费掉)', () => {
  const s = NEAR(7);
  const total = totalOf(s.rt);
  eq(disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT }).ok, true, '前置:第一次成功');

  const again = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: SOUP_POT });

  eq(again.ok, false, '对已灭的炉子应拒绝');
  ok(why(again).includes('已经灭了'), `理由要说清是"已灭"(实测:${why(again)})`);
  eq(totalOf(s.rt), total - 1, '★ 只扣了第一次那一件');
});

test('FND52-8 负对照:非灭火道具(602 料理)对着锅用 ⇒ 拒绝,炉火不受影响', () => {
  const s = NEAR(8);
  const out = disp(s.rt, { itemId: 602, targetDeviceId: SOUP_POT });

  eq(out.ok, false, '料理道具没有浇灭语义');
  ok(why(out).includes('没有浇灭器件的语义'), `理由要指认道具不对(实测:${why(out)})`);
  eq(fireOut(s.sim, SOUP_POT), false, '★ 炉火不得被"吃的东西"点灭');
});

/* ══════════════════ 3 动作层与目标互斥 ══════════════════ */

test('FND52-9 报文字段校验:`targetDeviceId` 不是正整数 ⇒ 当场 INVALID(不悄悄改成"对玩家用")', () => {
  const s = NEAR(9);
  for (const bad of [1.5, 0, -506, '506'] as const) {
    const out = disp(s.rt, { itemId: BUBBLE_GUN, targetDeviceId: bad });
    eq(out.ok, false, `targetDeviceId=${String(bad)} 必须被拒`);
    ok(why(out).includes('targetDeviceId'), `理由要指认字段(实测:${why(out)})`);
  }
  eq(fireOut(s.sim, SOUP_POT), false, '★ 三次非法报文都不该碰到世界');
});

test('FND52-10 ★ 两个目标**同时给** ⇒ 动作层当场拒(不静默挑一个执行),世界侧另有兜底', () => {
  const s = NEAR(10);
  const total = totalOf(s.rt);

  /* ① 报文层:同一份请求里两个意图都给 ⇒ 必须**拒**,不是"挑器件那个执行、回执看起来成功"。
     审查抓到过这一条:此前只有世界侧按分支先后"静默忽略 targetId"。 */
  const out = disp(s.rt, { itemId: BUBBLE_GUN, targetId: 'p2', targetDeviceId: SOUP_POT });

  eq(out.ok, false, '两个目标同时给必须被拒');
  eq(out.kind, 'INVALID', '应是 INVALID(不是 NOT_IMPLEMENTED)');
  ok(why(out).includes('互斥'), `理由要指认两者互斥(实测:${why(out)})`);
  ok(out.effect === undefined, '被拒就没有 effect(也就没有 consumed)');
  eq(totalOf(s.rt), total, '★ 拒绝路径不许扣道具(拒绝在扣减之前)');
  eq(fireOut(s.sim, SOUP_POT), false, '★ 拒绝路径不许碰到世界(炉火不变)');
  eq(s.sim.liveBubbleOf('p2').stacks, 0, '★ p2 也不该被叠泡泡');

  /* ② 世界侧兜底:直接调 `WorldSim.useItem` 两个都给 ⇒ 器件优先、不碰玩家。
     这一道留在世界侧是**有意**的:两道各防一种改坏(前者防"客户端多报一个字段改变语义",
     后者防"将来有人只改一处 ⇒ 世界侧悄悄按玩家处理")。 */
  const direct = s.sim.useItem('p1', { itemId: BUBBLE_GUN, targetId: 'p2', targetDeviceId: SOUP_POT });

  eq(direct.applied, true, `世界侧应生效(reason=${direct.reason})`);
  eq(direct.consume, true, '生效 ⇒ 该扣');
  eq(eff(direct).deviceId, 506, '走的是器件那条路');
  ok(!('targetId' in eff(direct)), '★ 回执里不该出现玩家目标(说明没走救人/困人那条)');
  eq(fireOut(s.sim, SOUP_POT), true, '★ 炉火真的灭了');
  eq(s.sim.liveBubbleOf('p2').stacks, 0, '★ p2 不该被顺手叠上一层泡泡(器件目标没被当成玩家)');
});

report('WS-FND-52');
