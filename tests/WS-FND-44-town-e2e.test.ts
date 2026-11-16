/**
 * WS-FND-44 —— **`MODIFY_TOWN` 端到端生效**:改配置 ⇒ 刷怪的安全区判定跟着变。
 *
 * ## 为什么还要一个端到端套件(`WS-FND-40` 不是已经测了 provider 吗)
 *
 * `WS-FND-40` 测的是 `spawner` **侧的读取口**(自己装一个假 provider)。
 * 但"配置真的生效"还差两段:
 *   1 `assemble()` 有没有把**城镇配置的适配器**装上去(`index.ts` 里那一行);
 *   2 世界的 `roomId` 有没有真的传进 `SpawnWorld`(否则问不到"本房间")。
 * 本套件用**真装配 + 真动作**(`dispatchAction(MODIFY_TOWN)`)走完整条链:
 *   `MODIFY_TOWN` → `modify_town` 的配置 → `townSafeRadiusFor(roomId)` → `inSafeZone` → `decideSpawn`
 *
 * ⚠️ 断言右侧一律用**字面量**(7 / 8 / 12 / 24 / 30),不取被测模块的导出常量。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { decideSpawn, isInsideSafeRadius, townSafeRadiusFor } from '../server/src/mobs/spawner.ts';
import { SpawnReject, type SpawnContext, type SpawnWorld } from '../server/src/mobs/spawner.ts';

let seq = 0;

type Room = { rt: ReturnType<typeof assemble>['runtime']; roomId: string };

function makeRoom(): Room {
  seq += 1;
  const roomId = `r_towne2e${seq}`;
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => 0 }, sizeCells: 32, mobs: false, rng: mulberry32(41),
  });
  a.runtime.join({ userId: 'p1' });
  return { rt: a.runtime, roomId };
}

/** 最小可用的 `SpawnWorld` 替身:`inSafeZone` 只读 `townCenter()` 与 `roomId()`。 */
const worldFor = (roomId: string): SpawnWorld => ({
  roomId: () => roomId,
  /* `decideSpawn` 除安全区外还会问"这一格挡不挡 / 什么地面" ⇒ 替身给全它读的那几项。 */
  blocked: () => false,
  floorAt: () => 0,
  objAt: () => 0,
  townCenter: () => ({ x: 16, y: 16 }),
} as unknown as SpawnWorld);

/** 最小可用的 `SpawnContext` 替身:`decideSpawn` 的判序里安全区只读 `globalCount` 与坐标。 */
const ctxAt = (x: number, y: number): SpawnContext => ({ globalCount: 0, x, y } as unknown as SpawnContext);

/** 该点是否被判"落在安全区"(`decideSpawn` 的 SAFE_ZONE 拒绝)。 */
const inSafe = (roomId: string, x: number, y: number) =>
  decideSpawn(ctxAt(x, y), worldFor(roomId), 0.5).reason === SpawnReject.SAFE_ZONE;

/* ───────────────────────── 判据 ───────────────────────── */

test('FND44-1 未改造 ⇒ 半径 24;距中心 12 格算安全、30 格不算', () => {
  const r = makeRoom();
  eq(townSafeRadiusFor(r.roomId), 24, '★ 默认半径必须是 24(与接线前逐字一致)');
  eq(inSafe(r.roomId, 16 + 12, 16), true, '12 格在 24 内 ⇒ 安全区');
  eq(inSafe(r.roomId, 16 + 30, 16), false, '30 格在 24 外 ⇒ 不是安全区');
});

test('FND44-2 ★★ 改造半径到 8 之后:原本"24 内、8 外"的点**不再**算安全区', () => {
  const r = makeRoom();
  /* 前置:改造前 12 格是安全区。 */
  eq(inSafe(r.roomId, 16 + 12, 16), true, '前置:改造前 12 格算安全区');

  const mod: Record<string, unknown> = { radius: 8 };
  /* 载荷用变量传:`ActionPayload` 里**没有** `radius`(它是动作模块侧局部窄化的字段),
     直接写字面量会触发"多余属性"检查 ⇒ 传变量(与 `WS-FND-30` 同一写法)。 */
  const out = r.rt.dispatchAction('p1', RoomAction.MODIFY_TOWN, mod);
  eq(out.kind, 'OK', `改造应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);

  eq(townSafeRadiusFor(r.roomId), 8, '★ 读取口应立刻变成 8');
  eq(inSafe(r.roomId, 16 + 12, 16), false, '★★ 12 格不再算安全区(这一条就是"配置真的生效")');
  eq(inSafe(r.roomId, 16 + 7, 16), true, '7 格仍在 8 之内 ⇒ 安全区');
  eq(isInsideSafeRadius(16 + 7, 16, 16, 16, townSafeRadiusFor(r.roomId)), true, '几何判定与半径一致');
});

test('FND44-3 per-room 隔离:一个房间改造不影响另一个房间', () => {
  const a = makeRoom();
  const b = makeRoom();
  a.rt.dispatchAction('p1', RoomAction.MODIFY_TOWN, { radius: 8 } as Record<string, unknown>);

  eq(townSafeRadiusFor(a.roomId), 8, 'a 房改了');
  eq(townSafeRadiusFor(b.roomId), 24, '★ b 房没改 ⇒ 仍是 24');
  eq(inSafe(b.roomId, 16 + 12, 16), true, '★ b 房的 12 格仍算安全区');
});

test('FND44-4 世界的房间号真的传进了刷怪器(否则上面几条都是巧合)', () => {
  const r = makeRoom();
  const host = assemble({ roomId: r.roomId, ownerId: 'p1', mobs: false, sizeCells: 32 }).host;
  /* `WorldSim.roomId` 是装配层给的;`spawnWorld()` 把它透传给刷怪器。
     两处不一致 ⇒ 刷怪问的是**别人的**配置 —— 那才是这条判据要防的。 */
  eq((host as unknown as { roomId: string }).roomId, r.roomId, '★ 世界里的房间号应与装配时一致');
  ok((host as unknown as { roomId: string }).roomId !== '', '★ 不能是空串(空串 ⇒ 刷怪退回默认)');
});

report('WS-FND-44');