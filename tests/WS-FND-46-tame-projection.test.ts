/**
 * WS-FND-46 —— **宠物被世界看见**:驯服之后 `state.wildlife[].tameOwnerId` 真的有主人。
 *
 * ## 这条补的是"最后一格"
 *
 * `WS-FND-41` 证明的是"动作模块里的登记可查";但 wire 上那一格
 * (`net/schema.ts` 的 `WildlifeState.tameOwnerId`)此前**恒为空串** ——
 * 世界/AI/客户端都以为所有生物都是野生的。
 * 接法是 `net/room.ts` 的投影:`tameOwnerId: tameOwnerOf(roomId, w.id) ?? ''`
 * (归属的**权威**仍是 `actions/breed_tame.ts`,投影只读它,不写第二份)。
 *
 * ## 用真链路
 *
 * `mobs:true` 刷出真生物 → 用真动作投喂到好感达标 → `TAME` → 推房间帧(`rt.step`)→ 读 `state.wildlife`。
 * ⚠️ 断言右侧一律用**字面量**(`''` 空串 = 野生,是 wire 的口径)。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

let seq = 0;

type Room = { rt: ReturnType<typeof assemble>['runtime']; sim: WorldSim; roomId: string };

function makeRoom(): Room {
  seq += 1;
  const roomId = `r_tameproj${seq}`;
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => 0 }, sizeCells: 64,
    mobs: true, biome: 'MEADOW', rng: mulberry32(61),
  });
  a.runtime.join({ userId: 'p1' });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const id of a.runtime.authoritativeItemIds('p1')) a.runtime.applyInventory('p1', { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount('p1', id) }] });
  const sim = a.host as unknown as WorldSim;
  sim.advance(3000);
  return { rt: a.runtime, sim, roomId };
}

/** 投喂到好感达标并驯服(`mob_sheep` 是内容层的可驯服物种)。 */
function tameSheep(r: Room): string | null {
  const sheep = r.sim.listWildlife().find((w) => w.mobId === 'mob_sheep');
  if (sheep === undefined) return null;
  const src = 'seed:602';
  r.rt.grantItemSource('p1', src);
  r.rt.applyInventory('p1', { ops: [{ itemId: 602, delta: 5, source: src }] });
  for (let i = 0; i < 3; i += 1) {
    const feedPayload: Record<string, unknown> = {
      op: 'FEED', petId: sheep.id, mobId: sheep.mobId, itemId: 602,
    };
    const f = r.rt.dispatchAction('p1', RoomAction.BREED_TAME, feedPayload);
    if (f.kind !== 'OK') return null;
  }
  const tamePayload: Record<string, unknown> = { op: 'TAME', petId: sheep.id, mobId: sheep.mobId };
  const t = r.rt.dispatchAction('p1', RoomAction.BREED_TAME, tamePayload);
  return t.kind === 'OK' ? sheep.id : null;
}

/** 推进房间帧(投影在这里发生)。 */
const stepRoom = (r: Room, n = 3) => { for (let i = 0; i < n; i += 1) r.rt.step(null); };

/* ───────────────────────── 判据 ───────────────────────── */

test('FND46-1 ★ 驯服之后投影里真的有主人(wire 那一格不再恒为空串)', () => {
  const r = makeRoom();
  const id = tameSheep(r);
  ok(id !== null, '前置:应能刷出并驯服一只 mob_sheep');

  stepRoom(r);

  const seen = r.rt.state.wildlife.find((w) => w.id === id);
  ok(seen !== undefined, '前置:投影里应有这只生物');
  eq(seen?.tameOwnerId, 'p1', '★★ 投影必须写出主人(此前恒为空串 ⇒ 世界/AI 以为它野生)');
});

test('FND46-2 没驯服的生物仍是野生(空串,不是别人的 id)', () => {
  const r = makeRoom();
  const id = tameSheep(r);
  ok(id !== null, '前置:驯服一只');
  stepRoom(r);

  const others = r.rt.state.wildlife.filter((w) => w.id !== id);
  ok(others.length > 0, '前置:应还有别的生物');
  for (const w of others) {
    eq(w.tameOwnerId, '', '★ 未驯服的必须是空串(wire 的"野生"口径)');
  }
});

test('FND46-3 不驯服 ⇒ 空串(证明那一格真的来自"归属查询",不是常量)', () => {
  const r = makeRoom();
  const sheep = r.sim.listWildlife().find((w) => w.mobId === 'mob_sheep');
  ok(sheep !== undefined, '前置:刷出 mob_sheep');
  stepRoom(r);

  const seen = r.rt.state.wildlife.find((w) => w.id === sheep?.id);
  eq(seen?.tameOwnerId, '', '★ 没驯服 ⇒ 空串');
});

report('WS-FND-46');