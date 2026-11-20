/**
 * WS-FND-122 —— **服务端有能力、报文层没出口**的四个 P0/P1(逐条接线 + 负对照 + 注入验证)。
 *
 * | # | 缺陷(修前) | 本套件怎么钉 |
 * | :-- | :--- | :--- |
 * | 1 | `[Q]` 技:`attackMobAuthorized(opts.useSkill)` 与 `skillOf/planSkillHits` 都在,但 `onAttack` 只读 `mobId/bonus`、`applyAttack` 没有形参 ⇒ 13 把武器的 [Q] **按不出来** | 报文位 → 房间 → 世界三段都打真技能;无技能 ⇒ `NO_SKILL` 且**零副作用**(FND122-1/2/3) |
 * | 2 | 整蛊:`resolvePrankAction` / `gatePrank` 生产零调用,`use_item` 对 221..255 回「没有使用语义」,`shieldOn` 写死 false | 对队友用 222 ⇒ 眩晕 + 击退真的落到权威状态;218 盾成为**真实开关**(FND122-6/7) |
 * | 3 | `jump`:客户端发 `jump:true`,`parseMoveIntent` **静默丢弃**,`jumpPlayer` 零调用 | 解析 → 房间 → 世界一条链;地面/冷却两道闸 + 落地后 COOLDOWN(FND122-4/5) |
 * | 4 | 派对参数:四模式九闸读 `436.params.mode`,而 net 层 **0 处**写 `params`,电路图恒空 | `START_PARTY` 把模式写进哨台 ⇒ 慢帧真的开局;没有哨台 ⇒ 显式 `NO_REFEREE_DESK`(FND122-8) |
 *
 * ## 判据纪律(每条都带两样东西)
 * 1 **负对照**:同一夹具上「不该生效」的那一次(不按 Q / 不按空格 / 超距 / 没哨台),
 *    证明判据不是恒真;
 * 2 **注入验证**:把接线**从源码里删掉**再喂给同一个检测器 ⇒ 必须报红(`FND122-9` 的表格),
 *    外加行为级的「修前路径」对照(直接问世界侧 `itemUseKind(222)` ⇒ 修前那句话原样出现 ⇒
 *    证明能力真的挂在**动作层那条接线**上)。
 *
 * 运行:`node tests/WS-FND-122-protocol-exits.test.ts`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { parseMoveIntent } from '../server/src/net/ws_server.ts';
import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import type { WorldSim as WorldSimType } from '../server/src/sim/world_sim.ts';
import { makeComponent } from '../server/src/wiring/components.ts';
import { stripCommentsForAudit } from '../server/src/combat/wiring_ledger.ts';

const ROOT = join(import.meta.dirname, '..');

/* ═════════════════════════ 夹具 ═════════════════════════ */

/** 一个「玩家 p1 紧挨着一只羊」的世界(装备经装配层入口 `setMobPlayers` 灌入)。 */
function mobScene(wearing: readonly number[], opts: { mob?: boolean } = {}): WorldSimType {
  const sim = new WorldSim({ sizeCells: 48, mobs: false });
  sim.addPlayer('p1', 24, 24);
  sim.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [...wearing], playingInstrument: false,
  }]);
  if (opts.mob !== false) sim.addMob('mob_sheep', 'MEADOW', 25, 24);
  return sim;
}

/** 生物当前血量(`listWildlife` 是世界侧的公开投影口)。 */
function mobHp(sim: WorldSimType, label = ''): number {
  const rows = sim.listWildlife();
  if (rows.length === 0) throw new Error(`前置失败:世界里没有生物${label === '' ? '' : `(${label})`}`);
  return rows[0].hp;
}

/** 生物血量;已经被打死(从 `listWildlife` 消失)⇒ **0**。 */
function mobHpOrDead(sim: WorldSimType): number {
  const rows = sim.listWildlife();
  return rows.length === 0 ? 0 : rows[0].hp;
}

let seq = 0;

interface Room {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: WorldSimType;
}

/**
 * 真装配(与 WS-FND-39 同一手法):动作走 `rt.dispatchAction`,`ActionContext` 不手搓。
 * 两个玩家 p1 / p2 都在世界里,并给 p1 塞好 `items` 里的道具(总量守恒 ⇒ 必须先登记来源)。
 */
function room(opts: { items?: readonly number[]; players?: readonly string[] } = {}): Room {
  seq += 1;
  const a = assemble({
    roomId: `r_f122_${seq}`,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
  });
  const sim = a.host as unknown as WorldSimType;
  const players = opts.players ?? ['p1', 'p2'];
  for (const id of players) a.runtime.join({ userId: id });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const u of players) for (const id of a.runtime.authoritativeItemIds(u)) a.runtime.applyInventory(u, { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount(u, id) }] });
  for (const id of players) {
    if (!sim.physics.bodies.has(id)) sim.addPlayer(id, 8, 8);
  }
  const items = opts.items ?? [];
  for (let i = 0; i < items.length; i += 1) {
    const itemId = items[i];
    /* 同一件道具可以出现多次 ⇒ 来源串必须**每次唯一**(来源是一次性凭证)。 */
    const src = `seed:${itemId}:${seq}:${i}`;
    a.runtime.grantItemSource('p1', src);
    const seeded = a.runtime.applyInventory('p1', { ops: [{ itemId, delta: 1, source: src }] });
    if (!seeded.allowed) throw new Error(`前置失败:塞不进第 ${i + 1} 件 ${itemId}`);
  }
  return { rt: a.runtime, sim };
}

/** 跑 `n` 个**慢帧**(2Hz)。 */
function tickSlow(sim: WorldSimType, n = 1): void {
  for (let i = 0; i < n * FAST_PER_SLOW; i += 1) sim.tick();
}

const eff = (r: { effect?: unknown }): Record<string, unknown> =>
  (r.effect ?? {}) as Record<string, unknown>;

/* ══════════ 1.`[Q]` 世界侧:技能真的进结算,没有技能就显式拒 ══════════ */

test('FND122-1 ★★ [Q] 世界侧:useSkill 真的打出技能;不按 Q 走普攻;空手 ⇒ NO_SKILL 且零副作用', () => {
  /* 711「旋风斩」damageMul 1.4(内容表字面量)。 */
  const plain = mobScene([711]);
  const skill = mobScene([711]);
  const p = plain.attackMobAuthorized('p1', 'mob_sheep');
  const q = skill.attackMobAuthorized('p1', 'mob_sheep', { useSkill: true });

  ok(p.hit !== null, '前置:不按 Q 也应结算');
  ok(q.hit !== null, '按 Q 也应结算');
  eq(p.rejected, null, '负对照:不按 Q 不该被拒');
  eq(p.hit?.result.source, 'NORMAL_ATTACK', '负对照:不按 Q ⇒ 普攻来源');
  eq(q.rejected, null, '按 Q 且这把武器有技能 ⇒ 不该被拒');
  eq(q.hit?.result.source, 'SKILL', '★ 按 Q ⇒ 走 SKILL 来源(修前报文到不了这里)');
  ok((q.hit?.result.base ?? 0) > (p.hit?.result.base ?? 0),
    `★ 技能倍率进第 1 步:普攻 base=${p.hit?.result.base} / 技能 base=${q.hit?.result.base}`);

  /* 多段:715「三连散射」hits=3 ⇒ 段数来自 `planSkillHits`(修前恒 1)。 */
  const triple = mobScene([715]);
  const t = triple.attackMobAuthorized('p1', 'mob_sheep', { useSkill: true });
  eq(t.hit?.segments, 3, '★ 715 的 [Q] ⇒ 3 段(段数只由 planSkillHits 决定)');

  /* 注入验证(行为级):空手按 Q ⇒ **无技能可放** ⇒ 显式拒 + 生物一滴血没掉。 */
  const empty = mobScene([]);
  const before = mobHp(empty);
  const noSkill = empty.attackMobAuthorized('p1', 'mob_sheep', { useSkill: true });
  eq(noSkill.rejected, 'NO_SKILL', '★ 空手按 Q ⇒ rejected=NO_SKILL(不是静默退回普攻)');
  eq(noSkill.hit, null, '零副作用:没有结算记录');
  eq(mobHp(empty), before, '零副作用:生物血量一位不动');
});

test('FND122-2 ★★ 房间出口:`applyAttack(..., useSkill)` 透传到世界;回执带 useSkill/rejected', () => {
  /* 真装配(`createHost()` 就是那条 seam),再按 WS-FND-118 的夹具布置生物。 */
  const a = assemble({
    roomId: 'r_f122_attack',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: true,
  });
  const sim = a.host as unknown as WorldSimType;
  const rt = a.runtime;
  rt.join({ userId: 'p1' });
  sim.addPlayer('p1', 24, 24);
  sim.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [715], playingInstrument: false,
  }]);
  sim.addMob('mob_sheep', 'MEADOW', 25, 24);

  const beforeHp = mobHp(sim, 'attack 房间的世界');
  const v = rt.applyAttack('p1', 0, 'mob_sheep', true);
  eq(v.allowed, true, '反作弊应放行(首次攻击)');
  const q = rt.lastAttackReport;
  /* 用 `throw` 而不是 `ok(...)`:后者不让 TS 收窄,`q.useSkill` 会多三条类型错误
     (那正是本仓 typecheck 基线锁要挡的东西)。 */
  if (q === null) throw new Error('★ 有结算回执(「没有世界 / 没有目标」才会是 null)');
  eq(q.useSkill, true, '★ 回执承认这次是 [Q]');
  eq(q.rejected, null, '有技能 ⇒ 未被拒');
  eq(q.hit, true, '打中了');
  ok(mobHpOrDead(sim) < beforeHp,
    `★ 生物真的掉血(${beforeHp} → ${mobHpOrDead(sim)},打死也算)`);

  /* 负对照:同一条通道、不按 Q ⇒ `useSkill=false`(不是恒 true)。
     ⚠️ 用**新世界**:上一条已经把这个 tick 的攻击额度用掉,再打会被反作弊拒
        (那时回执是 `null` —— 「被反作弊拒」与「不按 Q」会混成一件事)。 */
  const aNoQ = assemble({
    roomId: 'r_f122_attack_plain',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: true,
  });
  const simNoQ = aNoQ.host as unknown as WorldSimType;
  aNoQ.runtime.join({ userId: 'p1' });
  simNoQ.addPlayer('p1', 24, 24);
  simNoQ.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [715], playingInstrument: false,
  }]);
  simNoQ.addMob('mob_sheep', 'MEADOW', 25, 24);
  aNoQ.runtime.applyAttack('p1', 0, 'mob_sheep');
  eq(aNoQ.runtime.lastAttackReport?.useSkill, false, '负对照:不按 Q ⇒ 回执 useSkill=false');

  /* 注入验证(行为级):装备为空(等价于「没有武器」)再按 Q ⇒ 显式拒且零副作用。 */
  const a2 = assemble({
    roomId: 'r_f122_attack_bare',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: true,
  });
  const bare = a2.host as unknown as WorldSimType;
  a2.runtime.join({ userId: 'p1' });
  bare.addPlayer('p1', 24, 24);
  bare.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [], playingInstrument: false,
  }]);
  bare.addMob('mob_sheep', 'MEADOW', 25, 24);
  const hpBefore = mobHp(bare, 'bare 房间的世界');
  a2.runtime.applyAttack('p1', 0, 'mob_sheep', true);
  eq(a2.runtime.lastAttackReport?.rejected, 'NO_SKILL',
    '★ 空手 [Q] ⇒ 房间回执带 NO_SKILL(修前这里会静默退化成普攻)');
  eq(mobHp(bare), hpBefore, '零副作用:血没动');
});

test('FND122-3 ★ 意图位只认字面 true:`jump` 的垃圾值一律当作「没按」', () => {
  const base = { tick: 0, x: 1, y: 2, z: 0 };
  const j1 = parseMoveIntent({ ...base, jump: true });
  ok(j1.ok, '前置:合法坐标应通过');
  if (j1.ok) eq(j1.intent.jump, true, '★ jump:true 真的进了 intent(修前该字段被静默丢弃)');

  for (const bad of [1, 'true', {}, false] as const) {
    const r = parseMoveIntent({ ...base, jump: bad });
    ok(r.ok, '坐标合法 ⇒ 仍应通过(坏 jump 不让整条移动消失)');
    if (r.ok) eq(r.intent.jump, undefined, `负对照:jump=${String(bad)} 不该被当成「按下了」`);
  }
  /* 负对照(修前路径):完全不提 jump ⇒ 没有那个键 ⇒ 也没有起跳。 */
  const none = parseMoveIntent(base);
  ok(none.ok, '前置:合法坐标');
  if (none.ok) eq(none.intent.jump, undefined, '负对照:不带 jump 的报文 ⇒ intent 里没有 jump');
});

/* ══════════ 2.起跳:地面 / 冷却两道闸 ══════════ */

test('FND122-4 ★★ 起跳世界入口:地面 ⇒ 真起跳;空中 ⇒ 拒;落地后冷却期内 ⇒ COOLDOWN', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.addPlayer('p1', 8, 8);
  const body = (): { z: number; vz: number } => {
    const b = sim.physics.bodies.get('p1');
    if (b === undefined) throw new Error('前置失败:p1 没有刚体');
    return { z: b.z, vz: b.vz };
  };
  eq(body().z, 0, '前置:站在地面');
  eq(body().vz, 0, '前置:竖直速度为 0');

  /* 负对照(非玩家):生物不能借这条口起跳。 */
  const asMob = sim.tryPlayerJump('mob_ghost');
  eq(asMob.jumped, false, '负对照:非玩家 ⇒ 不能起跳');
  eq(asMob.reason, 'NOT_A_PLAYER', '理由要点名(不是「无事发生」)');

  const first = sim.tryPlayerJump('p1');
  eq(first.jumped, true, '★ 站在地面 ⇒ 起跳成功(修前 jumpPlayer 生产 0 调用)');
  ok((first.vz ?? 0) > 0, `★ 起跳初速写进了权威 vz(${first.vz})`);
  eq(body().vz, first.vz ?? -1, '权威刚体的 vz 就是返回值');
  eq(body().z, 0, '起跳那一帧 z 仍在地面(物理步还没积分)');

  /* 负对照(空中):同一帧再按一次 ⇒ AIRBORNE,且**不重写** vz。 */
  const vzAfter = body().vz;
  const air = sim.tryPlayerJump('p1');
  eq(air.jumped, false, '负对照:空中 ⇒ 不能二段跳');
  eq(air.reason, 'AIRBORNE', '理由 = AIRBORNE');
  eq(body().vz, vzAfter, '被拒时零副作用(vz 没被重写)');

  /* 落地(滞空 ≈ 0.67s ≈ 13 快帧),冷却 24 快帧 ⇒ 落地后仍在冷却。 */
  let frames = 0;
  while (frames < 120 && !(body().z === 0 && body().vz === 0)) { sim.tick(); frames += 1; }
  ok(frames < 60, `前置:应已落地(实测 ${frames} 帧)`);
  const cooling = sim.tryPlayerJump('p1');
  eq(cooling.jumped, false, '★ 落地后冷却期内再跳 ⇒ 拒(冷却闸有牙)');
  eq(cooling.reason, 'COOLDOWN', '理由 = COOLDOWN');

  /* 推进到冷却结束 ⇒ 又能跳(冷却不是「永久锁死」)。 */
  let waited = 0;
  while (waited < 120 && !sim.tryPlayerJump('p1').jumped) { sim.tick(); waited += 1; }
  ok(waited < 120, '★ 冷却结束后又能起跳');
});

test('FND122-5 ★★ 起跳房间出口:`applyMove({jump:true})` ⇒ 世界 vz 真的被写;不带 jump ⇒ 无起跳', () => {
  const a = assemble({
    roomId: 'r_f122_jump',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
  });
  const sim = a.host as unknown as WorldSimType;
  const rt = a.runtime;
  rt.join({ userId: 'p1' });
  /* ⚠️ 反作弊的播种坐标来自**房间**(`spawnPoint()`),刚体必须与它同源 ——
     否则第一条移动会被判「瞬移」(实测:反作弊在 0.5、刚体在 8 ⇒ 直接拒)。 */
  const seat = rt.state.players.find((p) => p.id === 'p1');
  const x0 = seat?.x ?? 0.5;
  const y0 = seat?.y ?? 0.5;
  sim.addPlayer('p1', x0, y0);
  const vz = (): number => sim.physics.bodies.get('p1')?.vz ?? Number.NaN;

  /* 负对照(修前路径):不带 jump 的移动 ⇒ 没有起跳,`lastJumpReport` 保持 null。 */
  rt.applyMove('p1', { tick: 1, x: x0, y: y0, z: 0 });
  eq(rt.lastJumpReport, null, '负对照:不带 jump ⇒ 没有起跳记录(修前就是这样)');
  eq(vz(), 0, '负对照:竖直速度仍是 0');

  /* 正例:同一通道 + `jump:true` ⇒ 世界侧 `tryPlayerJump`(→ `jumpPlayer`)被调到。 */
  const v = rt.applyMove('p1', { tick: 2, x: x0, y: y0, z: 0, jump: true });
  eq(v.allowed, true, '前置:反作弊放行这条移动');
  ok(rt.lastJumpReport !== null, '★ 有起跳回执(修前这条链上没有任何一个消费者)');
  eq(rt.lastJumpReport?.jumped, true, '★ jumped=true');
  ok(vz() > 0, `★ 权威刚体 vz > 0(实测 ${vz()})`);
});

/* ══════════ 3.整蛊施加 + 218 和平盾 ══════════ */

test('FND122-6 ★★ 整蛊施加:对队友用 222 ⇒ 眩晕/击退落到目标;超距 ⇒ 拒且一件不扣', () => {
  const r = room({ items: [222] });
  r.sim.setPlayerPos('p1', 8.5, 8.5);
  r.sim.setPlayerPos('p2', 9.5, 8.5); /* 距离 1.0 ≤ 222 的 radius 1.4 */

  const out = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 222, targetId: 'p2' });
  eq(out.ok, true, `应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);
  eq(out.kind, 'OK', '应是 OK');
  eq(eff(out).toyId, 222, '回执带 toyId');
  eq(eff(out).stunSec, 2.5, '★ 222 的眩晕 2.5s(玩具表字面量)进了回执');
  eq(eff(out).consumed, 1, '玩具是用掉的 ⇒ 扣 1 件');
  eq(r.sim.vitals.stunOf('p2') > 0, true, '★ 眩晕真的写进权威 `vitals`(不是只写在回执里)');
  ok((r.sim.physics.bodies.get('p2')?.vx ?? 0) !== 0, '★ 击退冲量真的落到刚体(vx ≠ 0)');

  /* 负对照:超距 ⇒ 拒,且**一件都不扣**(道具还在)、目标一点事没有。 */
  const r2 = room({ items: [222] });
  r2.sim.setPlayerPos('p1', 8.5, 8.5);
  r2.sim.setPlayerPos('p2', 12.5, 8.5); /* 距离 4.0 > 1.4 */
  const before = r2.rt.authoritativeItemCount('p1', 222);
  eq(before, 1, '前置:p1 有 1 件 222');

  const far = r2.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 222, targetId: 'p2' });
  eq(far.ok, false, '★ 超距 ⇒ 拒');
  ok(String(far.reason ?? '').includes('OUT_OF_RANGE'), `理由要点名半径(${far.reason ?? '-'})`);
  eq(r2.rt.authoritativeItemCount('p1', 222), before, '零副作用:道具一件没扣');
  eq(r2.sim.vitals.stunOf('p2'), 0, '零副作用:目标没有被眩晕');

  /* 注入验证(行为级):**修前路径** —— 世界侧那张语义表不认 221..255。
     ⇒ 没有动作层这条接线,整蛊在行为上不可达(不是「只是少了回执」)。 */
  const kind = r2.sim.itemUseKind(222);
  eq(kind, null, '★ 修前路径:世界侧 `itemUseKind(222)` 为 null');

  /* 目标缺失 ⇒ 拒(不许把「报文失误」变成自伤),且道具不动。 */
  const noTarget = r2.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 222 });
  eq(noTarget.ok, false, '负对照:缺 targetId ⇒ 拒');
  eq(r2.rt.authoritativeItemCount('p1', 222), before, '零副作用:道具仍在');
});

test('FND122-6B ★★ 重叠件 227:世界侧语义优先(玩具分支不许把它降级成一发) ', () => {
  /* 227 = 泡泡连发水枪,同时是 prank 表里的 221..255 一件(WS-FND-122 实测到的回归点:
     玩具分支若先跑,227 会变成「一发 STUNNED」,而手册/`WS-FND-53` 要求「连中 3 发才困住」)。 */
  const r = room({ items: [227, 227, 227] });
  r.sim.setPlayerPos('p1', 8.5, 8.5);
  r.sim.setPlayerPos('p2', 9.5, 8.5); /* 距离 1.0 ≤ 227 的 radius 5.0 */

  const shots: Record<string, unknown>[] = [];
  for (let i = 0; i < 3; i += 1) {
    const out = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 227, targetId: 'p2' });
    eq(out.ok, true, `第 ${i + 1} 发应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);
    shots.push(eff(out));
  }
  eq(shots[0].trapped, false, '负对照:第 1 发不该困住');
  eq(shots[1].trapped, false, '负对照:第 2 发不该困住');
  eq(shots[2].trapped, true, '★ 第 3 发才困住(世界侧 BUBBLE 语义,不是玩具分支)');
  eq(shots[0].flag, undefined, '★ 没有玩具分支的 `flag` 字段 ⇒ 227 走的是世界侧那条');
  eq(shots[0].toyId, undefined, '★ 回执里也没有 `toyId` ⇒ 同样证明没被玩具分支接走');
});

test('FND122-7 ★★ 218 和平盾:use_item 真的打开世界侧开关;开着盾 ⇒ 队友整蛊被拦', () => {
  const r = room({ items: [218, 222] });
  /* 两个相邻的 435 复活旗(team=0)⇒ 慢帧扫描把两人登记成**同队**(盾只免疫队友整蛊)。 */
  r.sim.wiring.addComponent(makeComponent('banner_a', 435, 8, 8, { params: { team: 0 } }));
  r.sim.wiring.addComponent(makeComponent('banner_b', 435, 9, 8, { params: { team: 0 } }));
  r.sim.setPlayerPos('p1', 8.5, 8.5);
  r.sim.setPlayerPos('p2', 9.5, 8.5);
  tickSlow(r.sim, 1);
  ok(r.sim.partyTeamOf('p1') !== null && r.sim.partyTeamOf('p1') === r.sim.partyTeamOf('p2'),
    '前置:两人同队(否则盾按「敌对」处理)');

  /* 负对照:没开盾时开关为 false —— 修前这里**只有** false 这一个值。 */
  eq(r.sim.shieldOnOf('p2'), false, '负对照:没开盾 ⇒ false');

  /* 用 218 ⇒ 世界侧开关真的置真。 */
  const shield = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 218 });
  eq(shield.ok, true, `应成功(kind=${shield.kind} reason=${shield.reason ?? '-'})`);
  eq(eff(shield).shieldOn, true, '回执说盾已开');
  eq(eff(shield).consumed, 0, '★ 218 是穿戴件 ⇒ 不消耗(扣了才是错的)');
  eq(r.sim.shieldOnOf('p1'), true, '★ 开关真的落到世界侧(读口 `shieldOnOf`)');

  /* p2 开盾后:p1 对 p2 用 222(队友整蛊)⇒ 被 218 拦,零副作用。 */
  const r2 = room({ items: [218, 222] });
  r2.sim.wiring.addComponent(makeComponent('banner_a', 435, 8, 8, { params: { team: 0 } }));
  r2.sim.wiring.addComponent(makeComponent('banner_b', 435, 9, 8, { params: { team: 0 } }));
  r2.sim.setPlayerPos('p1', 8.5, 8.5);
  r2.sim.setPlayerPos('p2', 9.5, 8.5);
  tickSlow(r2.sim, 1);
  eq(r2.sim.partyTeamOf('p1'), r2.sim.partyTeamOf('p2'), '前置:同队');
  r2.sim.setShieldOn('p2', true);
  eq(r2.sim.shieldOnOf('p2'), true, '前置:目标开着盾');

  const blocked = r2.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 222, targetId: 'p2' });
  eq(blocked.ok, false, '★ 开着 218 盾 ⇒ 队友整蛊被拦');
  ok(String(blocked.reason ?? '').includes('SHIELDED_218'), `理由要点名盾(${blocked.reason ?? '-'})`);
  eq(r2.rt.authoritativeItemCount('p1', 222), 1, '零副作用:道具没扣');
  eq(r2.sim.vitals.stunOf('p2'), 0, '零副作用:目标没被眩晕');

  /* 关盾后同一条报文 ⇒ 真的生效(证明拦住它的是**开关**,不是别的闸)。 */
  r2.sim.setShieldOn('p2', false);
  const passed = r2.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 222, targetId: 'p2' });
  eq(passed.ok, true, '★ 关盾后同一条报文 ⇒ 生效(对照在上一条)');
  ok(r2.sim.vitals.stunOf('p2') > 0, '眩晕真的写进权威');
});

/* ══════════ 4.派对参数:436 哨台的写入口 ══════════ */

test('FND122-8A ★★ 436 哨台写入口:世界侧 `setRefereeDeskMode` 让 `stepRefereeDesk` 读到模式', () => {
  const sim = new WorldSim({ sizeCells: 24, mobs: false });
  const desk = makeComponent('desk', 436, 5, 5);
  sim.wiring.addComponent(desk);
  sim.addPlayer('ref', 5.5, 5.5); /* 裁判:站在哨台格上 */
  sim.addPlayer('p1', 12.5, 12.5);

  eq(desk.params.mode, undefined, '前置:哨台没有模式(修前的生产状态)');
  /* 负对照:没人写 `params.mode` ⇒ 即使裁判站在哨台格上也开不了局。 */
  tickSlow(sim, 2);
  eq(sim.partyPhase(), 'IDLE', '负对照:没有写入口 ⇒ 相位仍在 IDLE');

  const w = sim.setRefereeDeskMode(1);
  eq(w.applied, true, '★ 写入成功(修前 net 层写 `params` 的地方 0 处)');
  eq(desk.params.mode, 1, '★ 436 的 `params.mode` 真的被写成了 1');

  tickSlow(sim, 1);
  eq(sim.partyPhase(), 'BUILD', '★ 慢帧读到哨台命令 ⇒ 真的开局(修前 `desks.length===0` 永远成立)');
  eq(sim.partyReferee(), 'ref', '裁判 = 站在哨台格上的那个玩家(不是写入口的调用方)');

  /* 负对照 2:表外模式 ⇒ 显式拒,且不写(写进去只会被 `stepRefereeDesk` 静默无视)。 */
  const bad = sim.setRefereeDeskMode(9);
  eq(bad.applied, false, '负对照:表外模式 ⇒ 拒');
  eq(bad.reason, 'BAD_MODE', '理由 = BAD_MODE');
  eq(desk.params.mode, 1, '零副作用:旧值保持不变');

  /* 没有哨台 ⇒ 显式说写不了(不是静默成功)。 */
  const noDesk = new WorldSim({ sizeCells: 16, mobs: false });
  const none = noDesk.setRefereeDeskMode(1);
  eq(none.applied, false, '负对照:世界里没有哨台 ⇒ 拒');
  eq(none.reason, 'NO_REFEREE_DESK', '理由要点名缺什么');
});

test('FND122-8B ★★ 房间出口:`START_PARTY` 把模式交给哨台(deskApplied / deskMode 进回执)', () => {
  const a = assemble({
    roomId: 'r_f122_party',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    mobs: false,
  });
  const sim = a.host as unknown as WorldSimType;
  const rt = a.runtime;
  rt.join({ userId: 'p1' });
  const desk = makeComponent('desk', 436, 5, 5);
  sim.wiring.addComponent(desk);
  sim.setPlayerPos('p1', 5.5, 5.5);

  const mode = rt.dispatchAction('p1', RoomAction.SET_PARTY_MODE, { partyMode: 'BRIDGE_CTF' });
  eq(mode.ok, true, `前置:选模式应成功(kind=${mode.kind} reason=${mode.reason ?? '-'})`);

  const start = rt.dispatchAction('p1', RoomAction.START_PARTY, {});
  eq(start.ok, true, `开局应成功(kind=${start.kind} reason=${start.reason ?? '-'})`);
  eq(eff(start).deskApplied, true, '★ 哨台写入成功');
  eq(eff(start).deskMode, 1, 'BRIDGE_CTF = 模式下标 1(与 deskModeKey 同一套)');
  eq(desk.params.mode, 1, '★ 436 的 `params.mode` 真的被写成了 1');

  /* 负对照:世界里**没有**哨台 ⇒ 显式说写不了(不许静默当成成功)。 */
  const a2 = assemble({
    roomId: 'r_f122_party_bare',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    mobs: false,
  });
  a2.runtime.join({ userId: 'p1' });
  a2.runtime.dispatchAction('p1', RoomAction.SET_PARTY_MODE, { partyMode: 'BRIDGE_CTF' });
  const start2 = a2.runtime.dispatchAction('p1', RoomAction.START_PARTY, {});
  eq(start2.ok, true, '房间层的开局仍然成功(哨台是另一层的入口)');
  eq(eff(start2).deskApplied, false, '★ 没有哨台 ⇒ deskApplied=false(不是静默成功)');
  eq(eff(start2).deskReason, 'NO_REFEREE_DESK', '理由要点名缺什么');
});

/* ══════════ 5.接线见证 + 注入验证(表格驱动)══════════ */

interface Witness {
  /** 生产文件(相对仓库根)。 */
  readonly file: string;
  /** 接线**必须**出现的那一段(去注释后逐字匹配)。 */
  readonly snippet: string;
  readonly why: string;
}

const WITNESSES: readonly Witness[] = [
  {
    file: 'server/src/net/ws_server.ts',
    snippet: 'apply.call(opts.room, c.userId, bonus, mobId, useSkill)',
    why: '[Q] 意图从报文进到房间',
  },
  {
    file: 'server/src/net/ws_server.ts',
    snippet: 'if (msg.jump === true) intent.jump = true;',
    why: '空格意图从报文进到 intent',
  },
  {
    file: 'server/src/net/room.ts',
    snippet: 'host.attackMobAuthorized(userId, mobId, { useSkill: true })',
    why: '房间把 [Q] 交给世界侧',
  },
  {
    file: 'server/src/net/room.ts',
    snippet: 'this.lastJumpReport = this.applyJumpIntent(userId);',
    why: '房间把起跳交给世界侧',
  },
  {
    file: 'server/src/sim/world_sim.ts',
    snippet: 'if (opts.useSkill === true) {',
    why: '世界侧对「没有技能」显式拒绝',
  },
  {
    file: 'server/src/sim/world_sim.ts',
    snippet: 'shieldOn: this.shieldOnOf(holder)',
    why: '218 盾从世界侧读真实开关(不再写死 false)',
  },
  {
    file: 'server/src/sim/world_sim.ts',
    snippet: 'desk.params.mode = m;',
    why: '436 哨台的模式写点',
  },
  {
    file: 'server/src/net/actions/use_item.ts',
    snippet: 'applyPrank.call(host, ctx.actorId, prankTarget, {',
    why: '整蛊效果落到目标',
  },
  {
    file: 'server/src/net/actions/use_item.ts',
    snippet: 'setShield.call(host, ctx.actorId, true)',
    why: '218 盾的写入口',
  },
  {
    file: 'server/src/net/actions/start_party.ts',
    snippet: 'ctx.host.setRefereeDeskMode(deskMode)',
    why: 'START_PARTY 把模式交给世界侧',
  },
];

/**
 * 检测器:**去注释后**逐字包含 `snippet` 才算接了线。
 *
 * 为什么要去注释:`stripCommentsForAudit` 保证「注释里写了什么」不会被当成接线
 * (本仓反复出现的「一条不能变红的说明」正是这么长出来的)。
 */
function wired(src: string, snippet: string): boolean {
  return stripCommentsForAudit(src).includes(snippet);
}

/** 注入:把接线从源码里删掉(模拟「这条线没接」)。 */
function withoutSnippet(src: string, snippet: string): string {
  return stripCommentsForAudit(src).split(snippet).join('/* removed */');
}

const SOURCES = new Map<string, string>();

function sourceOf(rel: string): string {
  if (!SOURCES.has(rel)) SOURCES.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
  return SOURCES.get(rel) as string;
}

test('FND122-9 ★★ 接线见证 + 注入验证:每条能力都能在源码里指到那一行;删掉它检测器必须报红', () => {
  ok(WITNESSES.length >= 8, `见证表应覆盖四条能力(实测 ${WITNESSES.length} 条)`);
  for (const w of WITNESSES) {
    const src = sourceOf(w.file);
    eq(wired(src, w.snippet), true, `★ 正例:${w.file} 应含「${w.why}」的接线`);
    /* 注入:同一份源码删掉那一段 ⇒ 同一个检测器必须判「没接」。 */
    eq(wired(withoutSnippet(src, w.snippet), w.snippet), false,
      `★ 注入验证:${w.file} 去掉那段接线后,检测器必须报红(${w.why})`);
  }

  /* 负对照(检测器本身):一段**只出现在注释里**的接线不算接上。 */
  const fake = `// ${WITNESSES[0].snippet}\nconst x = 1;\n`;
  eq(wired(fake, WITNESSES[0].snippet), false, '负对照:注释里的接线不算接线');
});

test('FND122-10 ★ 四条能力的「修前路径」在行为上确实不可达(负对照汇总)', () => {
  /* 1 [Q]:没有 `useSkill` 意图位 ⇒ 只有普攻来源(`NORMAL_ATTACK`)。 */
  const s1 = mobScene([711]);
  eq(s1.attackMobAuthorized('p1', 'mob_sheep')?.hit?.result.source, 'NORMAL_ATTACK',
    '修前路径:不按 Q 只能普攻');

  /* 2 整蛊:世界侧 `useItem` 对玩具回「没有使用语义」⇒ 动作层不接就永远施加不了。 */
  const s2 = mobScene([], { mob: false });
  s2.addPlayer('p2', 25, 24);
  const world = s2.useItem('p1', { itemId: 222, targetId: 'p2' });
  eq(world.applied, false, '★ 修前路径:世界侧 useItem(222) 不施加');
  ok(world.reason.includes('没有使用语义'), `理由原句:${world.reason}`);

  /* 3 起跳:不调世界入口 ⇒ 刚体竖直速度恒 0。 */
  const s3 = new WorldSim({ sizeCells: 16, mobs: false });
  s3.addPlayer('p1', 8, 8);
  eq(s3.physics.bodies.get('p1')?.vz, 0, '修前路径:没有任何调用者 ⇒ vz 恒 0');

  /* 4 派对:没有写入口 ⇒ 哨台 `params.mode` 缺席 ⇒ 相位恒 IDLE。 */
  const s4 = new WorldSim({ sizeCells: 24, mobs: false });
  s4.wiring.addComponent(makeComponent('desk', 436, 5, 5));
  s4.addPlayer('p1', 5.5, 5.5);
  tickSlow(s4, 2);
  eq(s4.partyPhase(), 'IDLE', '修前路径:没人写 `params.mode` ⇒ 永远开不了局');
});

report('WS-FND-122');