/**
 * WS-FND-45 —— **赛局计分的生产链路**:世界事件 → 规则 → `addScore`。
 *
 * ## 补的是哪一环
 *
 * `party/scoring.ts` 有纯规则、`actions/start_party.ts` 有分数容器,但**没有任何生产调用点**
 * ⇒ 分数永远不动。本套件走**真装配 + 真动作 + 真世界事件**:
 * ```
 *   WorldSim.settleKill()            ← 真的打死一只生物
 *     → notePartyEvent(击杀)          ← 世界侧唯一入口
 *       → index.ts 装的 sink          ← 换算 + 落账
 *         → scoreOfPartyEvent()       ← 纯规则
 *           → addScore(roomId, p1, n) ← 分数真值源
 * ```
 *
 * ⚠️ **归属口径沿用击杀结算已有的那条**:距击杀点 `SHARE_RADIUS` 内的玩家(手册按距离,
 *   不是"谁补的刀")。本套件把玩家挪到怪旁边,所以必然在半径内。
 * ⚠️ 断言右侧一律用**字面量**(`2` = BRIDGE_CTF 的单位分 × 一次击杀 1 单位)。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { partyStateOf } from '../server/src/net/actions/start_party.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import { PARTY_SCORE_EVENT } from '../server/src/party/scoring.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

let seq = 0;

type Room = { rt: ReturnType<typeof assemble>['runtime']; sim: WorldSim; roomId: string };

function makeRoom(): Room {
  seq += 1;
  const roomId = `r_partyw${seq}`;
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => 0 }, sizeCells: 48,
    /* ★ 需要真的刷出生物(击杀才有对象);`biome` 与 `mobs` 是一对,不传 biome 会走兜底。 */
    mobs: true, biome: 'MEADOW', rng: mulberry32(53),
  });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as WorldSim;
  if (!sim.physics.bodies.has('p1')) sim.addPlayer('p1', 24, 24);
  return { rt: a.runtime, sim, roomId };
}

/** 开局(选模式 + START_PARTY),返回是否都成功。 */
function startParty(r: Room): boolean {
  const m = r.rt.dispatchAction('p1', RoomAction.SET_PARTY_MODE, { partyMode: 'BRIDGE_CTF' });
  const s = r.rt.dispatchAction('p1', RoomAction.START_PARTY, {});
  return m.kind === 'OK' && s.kind === 'OK';
}

/** 把玩家挪到某点(共享半径内 ⇒ 击杀归属他)。 */
function moveTo(sim: WorldSim, id: string, x: number, y: number): void {
  const b = sim.physics.bodies.get(id);
  if (b === undefined) throw new Error(`前置失败:${id} 没有刚体`);
  b.x = x; b.y = y;
}

/** 打死一只怪(真走 `settleKill`)。返回是否真的打死了。 */
function killOneMob(r: Room): boolean {
  r.sim.advance(600); /* 等刷怪 */
  const mob = r.sim.listWildlife()[0];
  if (mob === undefined) return false;
  moveTo(r.sim, 'p1', mob.x, mob.y);
  r.sim.damageMob(mob.id, 999_999, DamageKind.PHYSICAL, 0);
  return true;
}

/* ───────────────────────── 判据 ───────────────────────── */

test('FND45-1 开局后击杀生物 ⇒ 分数真的涨了(世界事件 → 规则 → addScore)', () => {
  const r = makeRoom();
  eq(startParty(r), true, '前置:选模式 + 开局都应成功');

  const before = partyStateOf(r.roomId)?.scores.get('p1') ?? 0;
  eq(before, 0, '前置:开局时分数为 0');

  const killed = killOneMob(r);
  ok(killed, '前置:应刷出至少一只生物并可击杀');

  const after = partyStateOf(r.roomId)?.scores.get('p1') ?? 0;
  eq(after, 2, '★ 一次击杀 = BRIDGE_CTF 的 2 分(字面量;分数必须由事件累积出来)');
});

test('FND45-2 没开局 ⇒ 不计分(世界照常打死怪,但"分数"这个对象还不存在)', () => {
  const r = makeRoom();
  const killed = killOneMob(r);
  ok(killed, '前置:能击杀');
  eq(partyStateOf(r.roomId), null, '★ 没开局 ⇒ `partyStateOf` 是 null(不是 0 分的空局)');
});

test('FND45-3 未登记的事件类型 ⇒ 不给分(不许"沾边就加")', () => {
  const r = makeRoom();
  eq(startParty(r), true, '前置:开局');

  /* 世界侧唯一入口直接送一条**表外**事件:规则应判 0 分,分数不动。 */
  r.sim.notePartyEvent({ kind: 'no_such_party_event', source: 'p1' });
  eq(partyStateOf(r.roomId)?.scores.get('p1') ?? 0, 0, '★ 表外事件不得给分');
});

test('FND45-4 无归属的事件 ⇒ 不猜谁得分', () => {
  const r = makeRoom();
  eq(startParty(r), true, '前置:开局');

  /* 击杀事件但**没有** `source`(世界侧不知道是谁)⇒ 谁的分数都不该变。 */
  r.sim.notePartyEvent({ kind: PARTY_SCORE_EVENT.CREATURE_KILL });
  const snap = partyStateOf(r.roomId);
  eq(snap?.scores.get('p1') ?? 0, 0, '★ 无归属 ⇒ 不加给任何人');
  eq(snap?.scores.size ?? 0, 0, '★ 也不该凭空建一条 0 分记录');
});

test('FND45-5 击杀之外的事件当前**没有发射点**(如实边界,不是"已支持")', () => {
  const r = makeRoom();
  eq(startParty(r), true, '前置:开局');

  /* `GATHER` / `REACH_TARGET` 两个词表**存在**,但世界侧今天**没有发射点**
     (只有击杀那一处在 `settleKill` 里)。这条判据把现状钉住:
     若将来有人补上发射点,它会红 —— 那时把这条改成正向断言。 */
  r.sim.notePartyEvent({ kind: PARTY_SCORE_EVENT.GATHER, source: 'p1' });
  /* 采集按 BRIDGE_CTF 的单位分:2(`PARTY_MODE_UNIT_POINTS` × `PARTY_FOREIGN_EVENT_UNITS`)。
     ⚠️ 用**字面量**锚:改坏规则表(或把 GATHER 删成 0 分)必须红 ——
     审查 C2 指出原来那条 `ok(awardGather >= 0)` 是同义反复。 */
  eq(partyStateOf(r.roomId)?.scores.get('p1') ?? 0, 2,
    '★ 采集事件按单位分 2 落账(字面量;规则表被改坏会红)');

  /* 但**世界自己**不会产生它:空推 600 帧之后分数不动(说明没有第二个发射点)。 */
  r.sim.advance(600);
  eq(partyStateOf(r.roomId)?.scores.get('p1') ?? 0, 2,
    '★ 空推世界不会自己产出赛局事件(采集/到达的发射点尚未接)');
});

report('WS-FND-45');