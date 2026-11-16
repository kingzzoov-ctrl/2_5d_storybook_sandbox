/**
 * WS-FND-40 —— **安全区半径从常量变成可注入查询**(`MODIFY_TOWN` 真的能影响安全区判定)。
 *
 * ## 这个套件钉的是什么
 *
 * 接线前:`spawner.ts` 的刷怪 / 安全区判定只读**常量** `TOWN_SAFE_RADIUS = 24`
 * (`isInsideSafeRadius` 的默认参数),而 `MODIFY_TOWN` 改的 `safeRadius`
 * **没有任何世界侧读者** —— 「回 OK ≠ 生效」。
 *
 * 接线后:`spawner.ts` 把半径做成**可注入查询** `townSafeRadiusFor(roomId)`
 * —— 「先问 `setTownRadiusProvider` 装的 provider,拿不到 / 非法 / 抛错就退回默认 24」;
 * `inSafeZone`(→ `decideSpawn`)按世界的 `roomId` 去问它。本套件证明:
 *   1 没装 provider ⇒ 与历史**逐字节一致**(默认 24);
 *   2/3 provider 说 8 / 40 ⇒ 判定立刻跟着变;
 *   4   非法值(负数 / NaN / 非数 / Infinity / 0)⇒ 退回默认(不是「处处安全 / 处处危险」);
 *   5   provider 抛错 ⇒ **吞掉并退回默认**(口径见下);
 *   6   换 provider **立即生效**,不需要重建世界 / 刷新器;
 *   7   出厂 `townConfigOf(...).safeRadius` = 24(防配置层与判定层两边漂);
 *   8   `MODIFY_TOWN` 改的半径经只读适配器 `townSafeRadiusProvider` **真的**进世界判定。
 *
 * ## 为什么判定走 `decideSpawn` 而不是直接调 `isInsideSafeRadius`
 *
 * `isInsideSafeRadius` 是**纯几何**(它拿半径当显式参数),它没有 roomId、也不该有
 * —— 「可注入」发生在**拿半径那一步**(`inSafeZone`)。所以判据走
 * `decideSpawn → inSafeZone → townSafeRadiusFor` 这条**真**路径:改坏「忽略 provider
 * 直接用常量」,第 2 / 3 条必然红(注入验证见交付报告)。
 *
 * ## ⚠️ 断言右侧一律**字面量**,不取被测模块的常量(`--strict-taut`)
 *
 * 例:`townConfigOf(r).safeRadius` 不写成 `=== TOWN_SAFE_RADIUS`(两侧同源 ⇒ 恒真),
 * 而是先 `eq(TOWN_SAFE_RADIUS, 24)` 把常量**独立**锚住,再用字面量 24 断言出厂值。
 *
 * ## 与 `WS-FND-30` 的分工
 *
 * `WS-FND-30` 管**登记 + 权限 + 参数校验**(配置层);本套件管**判定层消费**(世界侧)。
 * 两者共享的 `townConfigOf` 出厂值在此用一个字面量锚再钉一遍,专门防「两边漂」。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import {
  TOWN_SAFE_RADIUS,
  decideSpawn,
  inSafeZone,
  setTownRadiusProvider,
  townSafeRadiusFor,
  type SpawnWorld,
} from '../server/src/mobs/spawner.ts';
import {
  clearTownRegistry,
  setTownClock,
  townConfigOf,
  townSafeRadiusProvider,
} from '../server/src/net/actions/modify_town.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 造一个「**除了安全区之外一切放行**」的假世界:不阻挡、无光源、是夜间、群系是 MEADOW。
 * 这样 `decideSpawn` 的结论只可能由**安全区**决定(SAFE_ZONE)或落在默认放行(SPAWN)。
 *
 * `roomId` 可选:不传 = 世界侧没提供房间号(用来验证「零回归」—— 装了 provider 也不受影响)。
 */
function mkWorld(roomId?: string): SpawnWorld {
  const w: SpawnWorld = {
    objAt: () => 0,
    floorAt: () => 0,
    blocked: () => false,
    townCenter: () => ({ x: 0, y: 0 }),
    isNight: () => true,
  };
  if (roomId !== undefined) w.roomId = () => roomId;
  return w;
}

/**
 * 让**真实**判定路径给结论:返回 `'SAFE_ZONE'`(被安全区拒)或 `'SPAWN'`(放行)。
 * 坐标都落在 +x 轴上,于是「距中心的格数」= 传给本函数的 `x`。
 */
function verdict(world: SpawnWorld, x: number, y: number): string {
  const d = decideSpawn(
    { biome: 'MEADOW', x, y, biomeCount: 0, globalCount: 0, mobId: 'mob_boar' },
    world,
    0.9,
  );
  return d.spawn ? 'SPAWN' : String(d.reason);
}

/** 每个用例开始前把插槽卸干净(模块级状态,防跨用例泄漏)。 */
function resetProvider(): void {
  setTownRadiusProvider(null);
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND40-1 未装 provider ⇒ 半径仍是默认 24(字面量锚)', () => {
  resetProvider();
  /* 锚 1:默认常量自己必须还是 24(它是内容口径的锚;右侧是字面量,不取自被测模块)。 */
  eq(TOWN_SAFE_RADIUS, 24, '★ `TOWN_SAFE_RADIUS` 应仍为 24(不许被改成别的)');
  /* 锚 2:读口在没装 provider 时返回默认。 */
  eq(townSafeRadiusFor('r_any'), 24, '★ 没装 provider ⇒ 读口返回默认 24');

  const w = mkWorld('r_any');
  eq(verdict(w, 23.5, 0), 'SAFE_ZONE', '★ 23.5 格在默认半径(24)内 ⇒ 安全');
  eq(verdict(w, 24.5, 0), 'SPAWN', '★ 24.5 格刚出默认半径 ⇒ 不设防(界确实是 24,不是更大)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND40-2 provider 返回 8 ⇒ 8.5 格不再安全,7.5 格仍安全', () => {
  resetProvider();
  setTownRadiusProvider(() => 8);
  eq(townSafeRadiusFor('r1'), 8, 'provider 返回 8 ⇒ 读口采用 8(不是默认 24)');

  const w = mkWorld('r1');
  eq(verdict(w, 8.5, 0), 'SPAWN', '★ 8.5 格 > 8 ⇒ 不再是安全区,可刷怪');
  eq(verdict(w, 7.5, 0), 'SAFE_ZONE', '★ 7.5 格 < 8 ⇒ 仍是安全区');
  /* `inSafeZone`(世界查询版)与决定路径必须同口径。 */
  eq(inSafeZone(w, 8.5, 0), false, '世界查询版同样收紧到 8');
  eq(inSafeZone(w, 7.5, 0), true, '世界查询版:7.5 在内');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND40-3 provider 返回 40 ⇒ 距中心 30 格仍算安全', () => {
  resetProvider();
  setTownRadiusProvider(() => 40);
  eq(townSafeRadiusFor('r1'), 40, 'provider 返回 40 ⇒ 读口采用 40');

  const w = mkWorld('r1');
  /* 默认 24 下 30 格**必**判区外 ⇒ 这一条直接证明半径被放宽到 40。 */
  eq(verdict(w, 30, 0), 'SAFE_ZONE', '★ 半径 40 ⇒ 30 格在安全区内(默认 24 会判区外)');
  eq(verdict(w, 39.5, 0), 'SAFE_ZONE', '39.5 格仍在 40 内');
  eq(verdict(w, 40.5, 0), 'SPAWN', '★ 40.5 格出区 ⇒ 界确实是 40(字面量,不是 41 / 更大)');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND40-4 provider 返回非法值(负数 / NaN / 非数 / Infinity / 0)⇒ 退回默认 24', () => {
  resetProvider();
  const w = mkWorld('r1');
  const bad: Array<[string, () => number]> = [
    ['负数', () => -3],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['非数字', () => 'big' as unknown as number],
    ['0', () => 0],
  ];
  for (const [label, fn] of bad) {
    setTownRadiusProvider(fn);
    eq(townSafeRadiusFor('r1'), 24, `★ ${label} ⇒ 读口退回默认 24`);
    /* 两侧都钉:既不「处处安全」(23.5 该在内),也不「处处危险」(24.5 该在外)。 */
    eq(verdict(w, 23.5, 0), 'SAFE_ZONE', `★ ${label} 退回默认:23.5 格在区内(不是「处处危险」)`);
    eq(verdict(w, 24.5, 0), 'SPAWN', `★ ${label} 退回默认:24.5 格在区外(不是「处处安全」)`);
  }
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND40-5 provider 抛错 ⇒ 吞掉并退回默认 24(口径已钉住)', () => {
  resetProvider();
  /* 本仓选择的口径:**吞掉抛错、退回默认**。理由(见 spawner.ts 的 `townSafeRadiusFor`):
     它跑在 2Hz 刷怪慢帧里,一次抛错会打断**整个**世界步进而**不只是一次刷新**;
     而半径是内容 / 配置细节,坏掉时应退回出厂值,而不是把进程带崩。 */
  setTownRadiusProvider(() => {
    throw new Error('provider 坏了');
  });
  eq(townSafeRadiusFor('r1'), 24, '★ 抛错不传播:读口退回默认 24');

  const w = mkWorld('r1');
  eq(verdict(w, 23.5, 0), 'SAFE_ZONE', '抛错 ⇒ 世界判定退回默认:23.5 格在区内');
  eq(verdict(w, 24.5, 0), 'SPAWN', '抛错 ⇒ 世界判定退回默认:24.5 格在区外');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND40-6 换 provider 立即生效(无需重建);无 roomId 的世界不受 provider 影响', () => {
  resetProvider();
  const w = mkWorld('r1');

  setTownRadiusProvider(() => 8);
  eq(verdict(w, 8.5, 0), 'SPAWN', '装 8 后:8.5 格不设防');
  /* 同一个世界对象、同一个 spawner,不重建任何东西 —— 直接换 provider。 */
  setTownRadiusProvider(() => 40);
  eq(verdict(w, 8.5, 0), 'SAFE_ZONE', '★ 换成 40:8.5 格立刻又安全(立即生效)');
  eq(verdict(w, 39.5, 0), 'SAFE_ZONE', '40 生效:39.5 格在区内');
  setTownRadiusProvider(null);
  eq(verdict(w, 23.5, 0), 'SAFE_ZONE', '卸掉后回到默认 24(内)');
  eq(verdict(w, 24.5, 0), 'SPAWN', '卸掉后回到默认 24(外)');

  /* 零回归:世界**没提供** roomId ⇒ 即使装了 provider 也走默认 24
     (WS-04 那些不带 roomId 的老世界因此完全不受影响)。 */
  setTownRadiusProvider(() => 40);
  const noRoom = mkWorld();
  eq(verdict(noRoom, 30, 0), 'SPAWN', '★ 无 roomId 的世界:30 格仍按默认 24 判 ⇒ 区外');
  eq(verdict(noRoom, 23.5, 0), 'SAFE_ZONE', '无 roomId 的世界:23.5 格在默认区内');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND40-7 出厂 `townConfigOf(...).safeRadius` = 24(防配置层与判定层两边漂)', () => {
  clearTownRegistry();
  eq(TOWN_SAFE_RADIUS, 24, 'spawner 的默认半径锚到 24');
  const cfg = townConfigOf('r_never_touched');
  /* 右侧写字面量:先在上面把 `TOWN_SAFE_RADIUS` 独立锚到 24,再用 24 断言出厂值
     ⇒ 两侧**不同源**,任何一边漂都会红(`--strict-taut` 的正确形态)。 */
  eq(cfg.safeRadius, 24, '★ 未改造过的房间出厂半径 = 24(与 spawner 默认同值)');
  eq(cfg.updatedBy, '', '出厂值「从未被改造过」(空发起者)');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND40-8 适配器打通:`MODIFY_TOWN` 改的半径经 `townSafeRadiusProvider` 真的进世界判定', () => {
  resetProvider();
  clearTownRegistry();
  setTownClock(() => 1_000_000);

  /* 真装配一个房间(房主 `p1` 带 `town` 位),把 radius 改成 30(合法区间 6..32 内)。 */
  const roomId = 'r_fnd40_e2e';
  const a = assemble({
    roomId,
    ownerId: 'p1',
    clock: { nowMs: () => 1_000_000 },
    sizeCells: 48,
    mobs: false,
    rng: mulberry32(40),
  });
  a.runtime.join({ userId: 'p1' });
  /* 载荷走 `Record<string, unknown>` 变量:与 `WS-FND-30` 同款 —— `radius` 还没进
     `ActionPayload`(room.ts:883),内联字面量会触发超额属性检查,变量则不会。 */
  const payload: Record<string, unknown> = { radius: 30 };
  const r = a.runtime.dispatchAction('p1', RoomAction.MODIFY_TOWN, payload);
  eq(r.kind, 'OK', `MODIFY_TOWN 应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(townConfigOf(roomId).safeRadius, 30, '前置:配置里的半径真的变成 30');

  /* 世界侧接线的最小形态:装适配器(只读)+ 世界带上 roomId。 */
  setTownRadiusProvider(townSafeRadiusProvider);
  const w = mkWorld(roomId);
  eq(verdict(w, 29.5, 0), 'SAFE_ZONE', '★ 半径 30 真的进了判定:29.5 格在区内(默认 24 会判区外)');
  eq(verdict(w, 30.5, 0), 'SPAWN', '★ 30.5 格出区 ⇒ 界确实是 30');

  /* 负对照:卸掉适配器 ⇒ 同一个世界退回默认 24,29.5 格又变成可刷(证明上面那条不是碰巧)。 */
  setTownRadiusProvider(null);
  eq(verdict(w, 29.5, 0), 'SPAWN', '卸掉适配器 ⇒ 回到默认 24');

  /* 适配器是**只读**的:再读一次配置,仍是 30(它没写任何状态)。 */
  ok(townSafeRadiusProvider(roomId) === 30, '适配器读回的仍是配置里的 30(只读,不写状态)');
});

report('WS-FND-40');
