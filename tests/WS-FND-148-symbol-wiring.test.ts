/**
 * WS-FND-148 —— 外部审计四项「符号存在但行为不通」的**逐项核实判据**。
 *
 * 运行:`node tests/WS-FND-148-symbol-wiring.test.ts`
 *
 * ## 四项审计与本文的回答
 *
 * | # | 审计原话 | 核实结论 | 本套件怎么钉 |
 * | :-- | :--- | :--- | :--- |
 * | 1 | 35 件玩具仅 3 件进生产,缺玩家→玩家 `applyPrank` 入口,`PRANK` 分支仍 `NONE` | **已过期**(入口在 w49 接上了),**但台账在撒谎** | FND148-1/2/3:半径真的决定成败、34 件逐件可判、台账与 `itemUseKind` 逐 ID 对账 |
 * | 2 | `TALENTS`/`activeTalents` 未接生产 | **部分成立**:`dmgMul` 已接、梦境启示两个数值已接、`carrySlots` **已接(WS-FND-152)**,其余 16 个字段未接 | FND148-4/5/6/7:行为正例 + 逐条台账 + 反向扫描 + 注入 |
 * | 3 | 急单 `stock` 恒空、房间等级未接入 | **成立**(房间等级早已登记;`stock` 未登记) | FND148-8/9:空表的两个可观测退化、真库存的行为差异、台账与生产对账 |
 * | 4 | `mobs/taming.ts` 27 导出 0 引用 | **已过期(WS-FND-146)** | FND148-10:复用行为 + 容器往返,只此一行 |
 *
 * ## 判据纪律
 * 1 **行为优先**:能用「改一个输入,输出跟着变」证明的,绝不靠「符号被 import」。
 * 2 **负对照**:每条正例都配一条「不该生效」的对照(超半径 / 等级不一致 / 关掉天赋)。
 * 3 **注入验证**:三张台账各被篡改一次,要求对账函数当场报错 —— 证明它有牙,
 *    而不是在当前快照上恰好为绿。
 * 4 **不复制实现的数**:期望值取内容表 / 冻结层常量字面量,或直接由被测函数给出。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { eq, ok, near, report, test } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import type { WorldSim as WorldSimType } from '../server/src/sim/world_sim.ts';
import { stripCommentsForAudit } from '../server/src/combat/wiring_ledger.ts';

import {
  PRANK_ACTION_LEDGER,
  PRANK_PLAYER_VERB,
  auditPrankLedger,
  wiredPrankToys,
} from '../server/src/prank/actions.ts';
import { PRANK_TOYS, PRANK_TOY_ID_MAX, PRANK_TOY_ID_MIN } from '../server/src/prank/toys.ts';
import { gatePrank } from '../server/src/party/actions.ts';

import {
  PROGRESS_FIELD_WIRING,
  TALENT_EFFECT_WIRING,
  auditTalentWiring,
  createProgress,
  KillLedger,
  settleMobExp,
  type PlayerProgress,
  type ShareEntry,
  type ShareParticipant,
} from '../server/src/combat/progression.ts';
import {
  createDowned,
  touchRevive,
  type DownedState,
} from '../server/src/combat/revive.ts';

import {
  BEAVER_STEAL_SEC,
  RUSH_STOCK_WIRING,
  auditRushStockWiring,
  generateOrderBoard,
  hitBeaver,
  reclaimWood,
  spawnBeaver,
  tickBeaver,
} from '../server/src/coop/rush_order.ts';
import { RUSH_ACTION_LEDGER } from '../server/src/coop/rush_actions.ts';

import {
  TameCommand,
  TameStage,
  carrySlots,
  commandPet,
  createPetRecord,
  forgetRoomPets,
  petSlotOf,
  petSlotsOfRoom,
  putPetSlot,
  tameableDefs,
} from '../server/src/mobs/taming.ts';

const ROOT = join(import.meta.dirname, '..');

/* ══════════════ 夹具:真装配(动作走 `runtime.dispatchAction`)══════════════ */

interface Room {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: WorldSimType;
}

let seq = 0;

function room(opts: { items?: readonly number[]; players?: readonly string[] } = {}): Room {
  seq += 1;
  const a = assemble({
    roomId: `r_f148_${seq}`,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
  });
  const sim = a.host as unknown as WorldSimType;
  const players = opts.players ?? ['p1', 'p2'];
  for (const id of players) a.runtime.join({ userId: id });
  for (const id of players) {
    if (!sim.physics.bodies.has(id)) sim.addPlayer(id, 8, 8);
  }
  const items = opts.items ?? [];
  for (let i = 0; i < items.length; i += 1) {
    const src = `seed:${items[i]}:${seq}:${i}`;
    a.runtime.grantItemSource('p1', src);
    const seeded = a.runtime.applyInventory('p1', { ops: [{ itemId: items[i], delta: 1, source: src }] });
    if (!seeded.allowed) throw new Error(`前置失败:塞不进 ${items[i]}`);
  }
  return { rt: a.runtime, sim };
}

const eff = (r: { effect?: unknown }): Record<string, unknown> =>
  (r.effect ?? {}) as Record<string, unknown>;

/** `server/src/**` 的**剥注释**源码(台账判据只许看代码)。 */
function sourceMap(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) {
        const rel = relative(ROOT, p).split('\\').join('/');
        out.set(rel, stripCommentsForAudit(readFileSync(p, 'utf8')));
      }
    }
  };
  walk(join(ROOT, 'server', 'src'));
  return out;
}

const SOURCES = sourceMap();
const WORLD = 'server/src/sim/world_sim.ts';

/* ══════════════ 夹具:经验结算 / 倒地 / 触摸救援 ══════════════ */

/** 一场击杀结算(每次一张新账本 ⇒ 不会被去重闸挡掉)。 */
function settleShares(
  participants: readonly ShareParticipant[],
  ctx: { mobInstanceId: string; mobLevel: number; baseExp: number },
): ShareEntry[] {
  return settleMobExp(new KillLedger(), { ...ctx, participants }).entries;
}

function downedFixture(progress: PlayerProgress): DownedState {
  return createDowned(progress, {
    weapon: null, armor: null, helm: null, boots: null, relic: null, cape: null,
  }, 0, 0);
}

/** 触摸救援一步(默认**不传**天赋入参 —— 生产现状就是这样)。 */
function touchStep(p: {
  downed: DownedState;
  dt: number;
  reviveTimeMul?: number;
}): { revived: boolean } {
  return touchRevive({
    downed: p.downed,
    rescuerId: 'p9',
    distance: 0,
    dt: p.dt,
    progress: createProgress('p9'),
    ...(p.reviveTimeMul !== undefined ? { reviveTimeMul: p.reviveTimeMul } : {}),
  });
}

/* ══════════════ 1. 整蛊:玩家→玩家入口到底覆盖几件 ══════════════ */

test('FND148-1 ★★ 整蛊入口:半径真的决定成败(221/231 超距被拒,223/255 生效)', () => {
  /* 221「举起队友」radius 1.0;223「弹射器」radius 4.0;231「巨人药水」radius 0.5。 */
  const r = room({ items: [221, 223, 231, 255] });
  r.sim.setPlayerPos('p1', 8.5, 8.5);
  r.sim.setPlayerPos('p2', 11.5, 8.5); /* 距离 3.0 */

  /* 负对照 1:radius 1.0 < 3.0 ⇒ 拒,且**一件不扣**。 */
  const far = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 221, targetId: 'p2' });
  eq(far.ok, false, '★ 221 半径 1.0 用不上 3.0 格外的目标');
  ok(String(far.reason ?? '').includes('OUT_OF_RANGE'), `理由要点名半径(${far.reason ?? '-'})`);
  eq(r.rt.authoritativeItemCount('p1', 221), 1, '零副作用:221 还在背包里');

  /* 负对照 2:radius 0.5 同理(证明半径是**逐件**读表,不是一张白名单)。 */
  const tiny = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 231, targetId: 'p2' });
  eq(tiny.ok, false, '★ 231 半径 0.5 ⇒ 同一距离上被拒(半径逐件来自玩具表)');
  eq(r.rt.authoritativeItemCount('p1', 231), 1, '零副作用:231 还在背包里');

  /* 正例:223 radius 4.0 ⇒ 生效,眩晕/冲量落到权威状态。 */
  const hit = r.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 223, targetId: 'p2' });
  eq(hit.kind, 'OK', `223 应生效(kind=${hit.kind} reason=${hit.reason ?? '-'})`);
  eq(eff(hit).toyId, 223, '回执带 toyId ⇒ 走的是玩具分支');
  eq(eff(hit).stunSec, 1.0, '223 的眩晕 1.0s(玩具表字面量)');
  eq(eff(hit).consumed, 1, '用掉一件');
  ok(r.sim.vitals.stunOf('p2') > 0, '眩晕真的写进权威 `vitals`');
  ok((r.sim.physics.bodies.get('p2')?.vx ?? 0) !== 0, '击退真的落到刚体');

  /* 正例 2:255 radius 32 —— 换一个干净房间(上一条已把 p2 打进 STUNNED,
     `applyPrankToTarget` 的状态互斥闸会拒第二次眩晕,那是另一条规则)。 */
  const r255 = room({ items: [255] });
  r255.sim.setPlayerPos('p1', 8.5, 8.5);
  r255.sim.setPlayerPos('p2', 11.5, 8.5);
  const far2 = r255.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 255, targetId: 'p2' });
  eq(eff(far2).toyId, 255, '★ 255(radius 32)在 3.0 格上生效');
});

test('FND148-2 ★★ 逐件:34 件都能判「该生效」;227 的例外由世界语义表决定(不是白名单)', () => {
  const r = room();
  /* 世界侧语义表认不认它 —— 这是「谁接管这件道具」的唯一判据。 */
  const worldOwned = PRANK_TOYS.filter((t) => r.sim.itemUseKind(t.id) !== null).map((t) => t.id);
  eq(worldOwned.join(','), '227', '★ 221..255 里只有 227 被世界侧语义表接走(itemUseKind=BUBBLE)');

  /* 逐件:距离恰取该件的 radius(闭区间)⇒ 必须判「生效」。 */
  let accepted = 0;
  for (const t of PRANK_TOYS) {
    const v = gatePrank({
      actorId: 'a', targetId: 'b', toyId: t.id, distance: t.radius, ally: true, shieldOn: false,
    });
    if (v.accepted && !v.blocked) accepted += 1;
    else throw new Error(`${t.id}:半径 ${t.radius} 处竟判不出生效(${v.reason})`);
    eq(v.stunSec, t.stunSec, `${t.id} 的眩晕秒数来自玩具表`);
    eq(v.flag, t.allyEffect.flag, `${t.id} 的状态标记来自**队友侧**效果`);
  }
  eq(accepted, 35, '★ 35 件逐件都能判出「该生效」(不是只有掉冠那三件)');

  /* 负对照:半径 +1 格 ⇒ 逐件都必须拒(证明判的是每件自己的 radius)。 */
  for (const t of PRANK_TOYS) {
    const v = gatePrank({
      actorId: 'a', targetId: 'b', toyId: t.id, distance: t.radius + 1, ally: true, shieldOn: false,
    });
    if (v.accepted) throw new Error(`${t.id}:超出半径 ${t.radius} 却仍判生效`);
  }

  /* 227 走世界侧:回执没有 toyId(修前「一发 STUNNED」的回归点)。 */
  const r227 = room({ items: [227] });
  r227.sim.setPlayerPos('p1', 8.5, 8.5);
  r227.sim.setPlayerPos('p2', 9.5, 8.5);
  const out = r227.rt.dispatchAction('p1', RoomAction.USE_ITEM, { itemId: 227, targetId: 'p2' });
  eq(eff(out).toyId, undefined, '★ 227 不进玩具分支(世界侧 BUBBLE 语义优先)');
  eq(eff(out).trapped, false, '★ 227 只中一发 ⇒ 不困住(WS-FND-53 的三发口径得以保留)');
});

test('FND148-3 ★★ 台账三列对账:player 列的归属 = 世界语义表的补集;篡改当场红', () => {
  const r = room();
  const worldSemantic = (id: number): string | null => r.sim.itemUseKind(id);
  eq(auditPrankLedger(PRANK_ACTION_LEDGER, worldSemantic).join(' | '), '',
    '★ 台账与仓库一致:玩家侧入口逐件对得上 world.itemUseKind');

  /* 掉冠列仍是 WS-FND-120 的冻结口径(不许因为这次改动而扩大)。 */
  eq(wiredPrankToys().sort().join(','), '222,224,225', '掉冠列不变(只有那三件)');
  eq(PRANK_ACTION_LEDGER.length, 35, '台账 35 行');
  const playerWired = PRANK_ACTION_LEDGER.filter((x) => x.player.startsWith('WIRED:')).map((x) => x.toyId);
  eq(playerWired.length, 34, '★ 玩家侧 34 件已接(35 − 227)');
  const expected = PRANK_TOYS.filter((t) => worldSemantic(t.id) === null).map((t) => t.id);
  eq(playerWired.join(','), expected.join(','), '★ 已接集合 = 世界语义表不认的那些(逐 ID)');
  ok(PRANK_ACTION_LEDGER.every((x) => x.enemy.startsWith('NONE:')), '怪物侧 35 件全 NONE(每条带理由)');

  /* 注入 A:把 227 改成「玩家侧已接」⇒ 必须报错(世界侧明明认它)。 */
  const a = PRANK_ACTION_LEDGER.map((x) => (x.toyId === 227 ? { ...x, player: PRANK_PLAYER_VERB } : x));
  ok(auditPrankLedger(a, worldSemantic).some((p) => p.includes('#227')), '★ 注入 A:227 冒充已接 ⇒ 红');

  /* 注入 B:把 221 改成「未接」⇒ 必须报错(世界侧不认它 ⇒ 玩具分支必然接管)。 */
  const b = PRANK_ACTION_LEDGER.map((x) => (x.toyId === 221 ? { ...x, player: 'NONE:故意说谎' } : x));
  ok(auditPrankLedger(b, worldSemantic).some((p) => p.includes('#221')), '★ 注入 B:已接写成未接 ⇒ 红');

  /* 注入 C:删一行 ⇒ 缺行;注入 D:悬空 ID ⇒ 红。 */
  ok(auditPrankLedger(PRANK_ACTION_LEDGER.slice(1), worldSemantic)
    .some((p) => p.includes(`${PRANK_TOY_ID_MIN}: 台账缺行`)), '★ 注入 C:删掉首行 ⇒ 缺行');
  const d = [...PRANK_ACTION_LEDGER, { ...PRANK_ACTION_LEDGER[0], toyId: PRANK_TOY_ID_MAX + 1 }];
  ok(auditPrankLedger(d, worldSemantic).some((p) => p.includes('不在玩具表里')), '★ 注入 D:悬空玩具 ID ⇒ 红');
});

/* ══════════════ 2. 天赋:哪几条真的改了数 ══════════════ */

test('FND148-4 ★★ dmgMul 已接:篡改档案倍率 ⇒ 伤害按比例变;等级不一致 ⇒ 不生效', () => {
  const scene = (): WorldSim => {
    const s = new WorldSim({ sizeCells: 48, mobs: true });
    s.addPlayer('p1', 24, 24);
    s.setMobPlayers([{
      id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
      heldItem: 0, wearing: [711], playingInstrument: false,
    }]);
    s.addMob('mob_sheep', 'MEADOW', 25, 24);
    return s;
  };
  const s = scene();
  const before = s.attackMobAuthorized('p1', 'mob_sheep').hit?.result.base ?? 0;
  ok(before > 0, '前置:这一刀有基础伤害');
  const progress = s.progressOf('p1');
  eq(progress.dmgMul, 1, '前置:lv1 的档案倍率是 1');
  progress.dmgMul = 2;
  const after = s.attackMobAuthorized('p1', 'mob_sheep').hit?.result.base ?? 0;
  near(after / before, 2, 0.001, `★ 篡改档案 dmgMul ⇒ 伤害按比例变(${before} → ${after})`);
  /* 负对照:结算等级与档案等级不一致 ⇒ 不套档案倍率(避免两份等级口径)。 */
  const injected = s.attackMob('p1', 'mob_sheep', { level: 5 })?.result.base ?? 0;
  near(injected / before, 1 + 0.03 * 4, 0.001, '★ 负对照:等级不一致 ⇒ 退回公式自己的 ×1.12');
});

test('FND148-5 ★★ 梦境启示已接:经验乘区 1.20 / 打盹比例 0.45 真的来自天赋表', () => {
  const base = { mobInstanceId: 'm1', mobLevel: 1, baseExp: 100 };
  const r1 = settleShares([
    { playerId: 'a', distance: 0, level: 1, afk: false, hasDreamTalent: false },
    { playerId: 'b', distance: 0, level: 1, afk: false, hasDreamTalent: true },
  ], base);
  const shareA = r1.find((e) => e.playerId === 'a')?.share ?? 0;
  const shareB = r1.find((e) => e.playerId === 'b')?.share ?? 0;
  near(shareB / shareA, 1.20, 0.02, `★ 同一场结算:开天赋 ${shareB} / 关天赋 ${shareA} = 1.20`);

  const r2 = settleShares([
    { playerId: 'a', distance: 0, level: 1, afk: true, hasDreamTalent: false },
    { playerId: 'b', distance: 0, level: 1, afk: true, hasDreamTalent: true },
  ], base);
  const afkA = r2.find((e) => e.playerId === 'a')?.share ?? 0;
  const afkB = r2.find((e) => e.playerId === 'b')?.share ?? 0;
  eq(afkA, 30, '★ 负对照:没天赋的打盹玩家拿 0.3 × 100 = 30');
  near(afkB / afkA, 1.8, 0.02, `★ 有天赋 ${afkB}:0.45 × 1.20(乘区也生效)= 1.8 × 30`);
});

test('FND148-6 ★★ 其余 5 条天赋未接:台账 + 反向扫描 + 注入;能力正例证明「接法存在」', () => {
  eq(auditTalentWiring(TALENT_EFFECT_WIRING, SOURCES).join(' | '), '',
    '★ 逐条台账与仓库一致(WIRED 有消费证据 / UNWIRED 全仓无消费点)');

  const wired = TALENT_EFFECT_WIRING.filter((r) => r.status === 'WIRED').map((r) => `${r.talentId}#${r.effect}`);
  eq(wired.sort().join(','), 'talent_dream_revelation#afkExpRatio,talent_dream_revelation#expGainMul',
    '★ 只有梦境启示的两条效果字段真的被读');
  const unwiredTalents = new Set(
    TALENT_EFFECT_WIRING.filter((r) => r.status === 'UNWIRED').map((r) => r.talentId),
  );
  eq([...unwiredTalents].sort().join(','),
    'talent_crit_master,talent_dream_revelation,talent_element_affinity,talent_rescue_swift,talent_roll_bomb,talent_throw_master',
    '★ 5 条天赋整条未接 + 梦境启示的 dewRateMul(露水没有累计写口)');

  /* 注入 A:把已接的 expGainMul 改成 UNWIRED ⇒ 反向扫描发现消费点 ⇒ 红。 */
  const a = TALENT_EFFECT_WIRING.map((r) =>
    (r.effect === 'expGainMul' ? { ...r, status: 'UNWIRED' as const } : r));
  ok(auditTalentWiring(a, SOURCES).some((p) => p.includes('expGainMul') && p.includes('消费点')),
    '★ 注入 A:已接写成未接 ⇒ 红(消费点在 settleMobExp)');

  /* 注入 B:把未接的急救快手改成 WIRED ⇒ 声明了却没有证据 ⇒ 红。 */
  const b = TALENT_EFFECT_WIRING.map((r) =>
    (r.talentId === 'talent_rescue_swift' ? { ...r, status: 'WIRED' as const } : r));
  ok(auditTalentWiring(b, SOURCES).some((p) => p.includes('talent_rescue_swift#reviveTimeMul')),
    '★ 注入 B:未接写成已接 ⇒ 红');

  /* 注入 C:删一行 ⇒ 完整性(拿 TALENTS 的键集对账)必须报缺行。 */
  const c = TALENT_EFFECT_WIRING.filter((r) => r.effect !== 'critDmgBonus');
  ok(auditTalentWiring(c, SOURCES).some((p) => p.includes('talent_crit_master#critDmgBonus')),
    '★ 注入 C:漏登记一个效果字段 ⇒ 红');

  /* 能力正例:急救快手的**接法真的存在**(revive.ts 有入参,生产调用点不传)。 */
  const progress = createProgress('p9');
  const downed = downedFixture(progress);
  const out = touchStep({ downed, dt: 0.5, reviveTimeMul: 0.5 });
  eq(out.revived, true, '★ 传 reviveTimeMul=0.5 ⇒ 0.5 秒就能救起(能力在)');
  const slow = touchStep({ downed, dt: 0.5 });
  eq(slow.revived, false, '★ 不传(生产现状)⇒ 0.5 秒不够,要满 1.0 秒');
  ok(!String(SOURCES.get(WORLD)).includes('reviveTimeMul'),
    '★ 世界侧调用点从未传 reviveTimeMul ⇒ 急救快手在生产里恒不生效(与台账 UNWIRED 一致)');
});

test('FND148-7 ★★ carrySlots **已接**(WS-FND-152 反转):档案改到 99 ⇒ 房间容量 99;复原 ⇒ 8', () => {
  /* ★ 2026-11-19(owner 裁定「全接」/ WS-FND-152):本条此前钉的是「档案改成 99,
     房间容量仍是 8」—— 那条**不是**目标行为,而是「`net/room.ts#carryCapacityOf`
     内联了 `8 + (lv-1)`」这件事实的写照。容量闸现在读世界源的 `carrySlotsOf`
     (档案字段),没有世界源才回落到 `progression.carryCapacityOfLevel`(同一出处)。
     ⇒ 判据按新口径反转:**改档案必须真的改容量**(否则「接线」是空话)。 */
  const r = room({ players: ['p1'] });
  eq(r.rt.carryCapacityOf('p1'), 8, '前置:lv1 无档案 ⇒ 容量闸 = 8(等级派生)');
  r.sim.progressOf('p1').carrySlots = 99;
  eq(r.rt.carryCapacityOf('p1'), 99, '★ 档案 carrySlots=99 ⇒ 容量闸 99(该字段**有**读者)');
  r.sim.progressOf('p1').carrySlots = 8;
  eq(r.rt.carryCapacityOf('p1'), 8, '★ 复原(负对照):容量跟着回到 8,不是只读一次的快照');
  const row = PROGRESS_FIELD_WIRING.find((x) => x.field === 'carrySlots');
  eq(row?.status, 'WIRED', '台账把 carrySlots 记为 WIRED(与上面的行为一致)');
  ok(String(SOURCES.get('server/src/net/room.ts')).includes('carryCapacityOf('),
    '容量闸仍在 net/room.ts(写入口只有一处)');
  ok(!/8\s*\+\s*\(\s*lv\s*-\s*1\s*\)/.test(stripCommentsForAudit(String(SOURCES.get('server/src/net/room.ts')))),
    '★ 内联算式已删(剥注释后仍无):容量口径只剩 `progression.carryCapacityOfLevel` 一处');
});

/* ══════════════ 3. 急单 stock ══════════════ */

test('FND148-8 ★★ 空 stock 的两个可观测退化:订单稀缺系数恒 2、河狸一块也偷不到', () => {
  /* 权重:同一 rng、同一房间等级,只改 stock。pool 收成单件 ⇒ 权重可比。 */
  const emptyBoard = generateOrderBoard(() => 0.5, 1, {}, 0, [151]);
  const fullBoard = generateOrderBoard(() => 0.5, 1, { 151: 10 }, 0, [151]);
  const wEmpty = emptyBoard.slots[0]?.weight ?? 0;
  const wFull = fullBoard.slots[0]?.weight ?? 0;
  ok(wEmpty > 0 && wFull > 0, '前置:两次都生成了含 151 的订单');
  near(wEmpty / wFull, 2, 0.001,
    `★ 空库存 ⇒ scarcity = 2(满库存 = 1):w=${wEmpty} vs ${wFull}(「越缺越点」在空表上失效)`);

  /* 偷料:stock={} ⇒ 偷 0 ⇒ 敲晕也夺不回;stock={151:5} ⇒ 偷 3 并能夺回。 */
  const none: Record<number, number> = {};
  const b0 = spawnBeaver('b0');
  tickBeaver(b0, BEAVER_STEAL_SEC, none);
  eq(b0.stolenQty, 0, '★ 空 stock ⇒ 河狸偷 0 块(读点读的是真表)');
  eq(hitBeaver(b0, 8).knocked, true, '前置:222 冲量照样能敲晕');
  eq(b0.reclaimable, false, '★ 没偷到东西 ⇒ reclaimable 恒 false');
  eq(reclaimWood(b0, none), 0, '★ 夺回 0 块(「敲晕夺回木板」在空表上整条失效)');

  const some: Record<number, number> = { 151: 5 };
  const b1 = spawnBeaver('b1');
  tickBeaver(b1, BEAVER_STEAL_SEC, some);
  eq(b1.stolenQty, 3, '★ 非空 stock ⇒ 偷 3 块(BEAVER_RECLAIM_QTY)');
  eq(some[151], 2, '★ 库存真的被扣:5 → 2');
  eq(hitBeaver(b1, 8).knocked, true, '砸晕');
  eq(b1.reclaimable, true, '★ 偷到了东西 ⇒ 进入可夺回窗口');
  eq(reclaimWood(b1, some), 3, '★ 夺回 3 块');
  eq(some[151], 5, '★ 库存回到 5(夺回写回同一张表)');
});

test('FND148-9 ★★ stock 台账与生产一致(UNSUPPLIED);生产一改,台账当场过时', () => {
  eq(auditRushStockWiring(RUSH_STOCK_WIRING, SOURCES).join(' | '), '',
    '★ 两个读点都在 rush_order.ts 里,而生产端仍在传 `{}`');
  ok(RUSH_STOCK_WIRING.every((r) => r.status === 'UNSUPPLIED'), '两行都登记为 UNSUPPLIED');

  /* 房间等级那一半早已登记在 rush_actions 的台账里(不是漏账)。 */
  ok(RUSH_ACTION_LEDGER.some((r) => r.step === 'ROOM_LEVEL' && r.path.startsWith('EXTRA:')),
    '★ 房间等级未接入早已在 `RUSH_ACTION_LEDGER` 的 EXTRA 行登记');

  /* 注入:假装世界侧开始供 stock ⇒ 台账必须报「过时」。 */
  const patched = new Map(SOURCES);
  const world = SOURCES.get(WORLD) ?? '';
  patched.set(WORLD, world.replace(
    'startRushRun(RUSH_ENTRY_ROOM_LEVEL, makeRng(this.worldSeed), {})',
    'startRushRun(RUSH_ENTRY_ROOM_LEVEL, makeRng(this.worldSeed), { 151: 3 })',
  ));
  const problems = auditRushStockWiring(RUSH_STOCK_WIRING, patched);
  eq(problems.length, 2, '★ 注入:生产已经供 stock ⇒ 两行都报「台账过时」');

  /* 注入:声明的读点被删掉 ⇒ 也要红(读点不是注释里的话)。 */
  const noRead = new Map(SOURCES);
  noRead.set('server/src/coop/rush_order.ts',
    (SOURCES.get('server/src/coop/rush_order.ts') ?? '').split('stock[id]').join('xxx[id]'));
  ok(auditRushStockWiring(RUSH_STOCK_WIRING, noRead).some((p) => p.includes('ORDER_WEIGHT')),
    '★ 注入:删掉订单权重的读点 ⇒ 红');
});

/* ══════════════ 4. taming 复核(WS-FND-146,只复核不改)══════════════ */

test('FND148-10 taming:已解决(WS-FND-146)—— 复用行为 + 容器往返', () => {
  const defs = tameableDefs();
  ok(defs.length > 0, '前置:内容表里有可驯服生物');
  const mobId = defs[0].id;
  const pet = createPetRecord(mobId, 0);
  if (pet === null) throw new Error(`${mobId} 应可驯服`);
  /* 前置:未驯化时拒不服从(`commandPet` 的第一行)。这里只考「指令 → 负载」这条接线,
     驯化流程本身由 `feedPet` 拥有(`tests/WS-FND-146` 已钉)。 */
  eq(pet.stage, TameStage.WILD, '前置:新记录还没驯化');
  eq(commandPet(pet, TameCommand.CARRY), false, '负对照:未驯化 ⇒ 指令被拒');
  pet.stage = TameStage.TAMED;
  eq(commandPet(pet, TameCommand.CARRY), true, 'CARRY 指令被接受');
  eq(pet.carryLoad, carrySlots(mobId), '★ 负载槽 = carrySlots(mobId)(与内容表等级同源)');
  eq(commandPet(pet, TameCommand.STAY), true, 'STAY 指令被接受');
  eq(pet.carryLoad, 0, '★ 换指令即卸货(容量语义跟着指令走)');

  putPetSlot('r_f148_room', { petId: 'pet_x', ownerId: 'p1', bond: 0, record: pet });
  ok(petSlotOf('r_f148_room', 'pet_x') !== null, '★ 容器读回同一只宠物(不是 orphan 的数据)');
  forgetRoomPets('r_f148_room');
  eq(petSlotsOfRoom('r_f148_room').length, 0, '离场清理干净');
  /* 生产复用:动作层 import 的就是这一批函数(WS-FND-146 的定案形态)。 */
  ok((SOURCES.get('server/src/net/actions/breed_tame.ts') ?? '').includes("from '../../mobs/taming.ts'"),
    '★ 生产复用:breed_tame 直接 import taming(白名单已摘)');
});

report('WS-FND-148');