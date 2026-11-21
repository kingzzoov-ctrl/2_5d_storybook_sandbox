/**
 * WS-FND-124 —— 战斗语义的**五处断点**(第七轮实测:P1×2 / P2×3)。
 *
 * 运行:`node tests/WS-FND-124-combat-semantics.test.ts`
 *
 * ## 五处断点与本套件的判据
 *
 * | # | 缺陷(第七轮实测) | 本套件怎么钉 |
 * | :-- | :--- | :--- |
 * | 1 | **P1** 倒地者仍可攻击:`revive.canAttack` 只判 `GHOST_BUBBLE`,水枪把倒地者置 `BUBBLED` 后与移动侧(`vitals.downed`)**分叉** | 经生产道具路径(227 水枪 3 发)把倒地者打成 `BUBBLED` ⇒ 攻击闸仍拒(FND124-1) |
 * | 2 | **P1** 破盾 / 晶甲整条不生效:`TargetProfile` 只拿到 `{ hp }` ⇒ 204/712 的破盾倍率与 `CRYSTAL_ARMOR_MUL` / `ignoresCrystal` 永不生效 | AI 账本 `mem.shield = 400` ⇒ 破盾分支真的走、盾破后 HP 才掉;`mem.crystalArmor` ⇒ 系数 0.2(FND124-2/3) |
 * | 3 | **P2** 辅助技被抬成 1 点真实伤害:717/720/721 倍率为 0 却走同一段 `computeDamage` ⇒ `MIN_DAMAGE` 抬成 1 并经 `damageMob` 落账(会补刀/触发击杀) | 1 血怪挨 717 ⇒ **不掉血、不死**;伤害技(715)同一只怪照样打死(负对照)(FND124-4/5) |
 * | 4 | **P2** 反伤口径不一致 + 被二次减免:`reflectFrom` 用未钳的 `res.applied`、`reflectTotal` 记折前额度 | 残血 1 挨打 ⇒ 反伤基数 = 实际扣除 1;`reflectTotalDamage()` = 生物真实掉血(FND124-6) |
 * | 5 | **P2** 技能时序未走完:`plan.ticks` 的 `tickSec` / `telegraphSec` 被丢 ⇒ 716 箭雨 6×0.55 同帧结算 | 716 首发只 1 段、0.5 秒后第 2 段;718 前摇 1 秒内零结算(FND124-7/8) |
 *
 * ## 判据纪律(与 WS-FND-103/110/117/118 同一套)
 *
 * 1 **负对照**:每条正例都配一条「不该生效」的对照(没护盾 / 没声明晶甲 /
 *    换成伤害技 / 不穿 728 / 三段同刻的技能不排队),否则「恒真」也能过。
 * 2 **注入验证**:FND124-9 把时序规则喂边界与 `NaN`;FND124-10 检查修前
 *    写法是否真的从源码消失(附:剥注释后匹配,不吃注释里的引用)。
 * 3 **不拿实现常量核实现行为**:期望值取内容表字面量(1.5 秒 / 3.0 倍率 /
 *    6 段 × 0.5 秒)或由世界侧独立读数给出。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq, ok, near, report, test, mulberry32 } from '../shared/testing/harness.ts';
import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import { BodyState, secondsToTicks } from '../shared/types/physics.ts';
import { createProgress, setLevel } from '../server/src/combat/progression.ts';
import { createDowned, ghostControl } from '../server/src/combat/revive.ts';
import {
  CRYSTAL_ARMOR_MUL,
  dueSkillTicks,
  skillTiming,
} from '../server/src/combat/damage.ts';
import { combatantStats, WEAPON_BY_ID } from '../server/src/combat/weapons.ts';
import { stripCommentsForAudit } from '../server/src/combat/wiring_ledger.ts';

const ROOT = join(import.meta.dirname, '..');

/* ═════════════════════ 夹具 ═════════════════════ */

/** 「玩家贴着生物」的世界;装备经 `setMobPlayers`(装配层入口,不是后门)灌入。 */
function scene(opts: {
  wearing?: readonly number[];
  mobId?: string;
  extraPlayerAt?: { id: string; x: number; y: number };
} = {}): WorldSim {
  const s = new WorldSim({ sizeCells: 48, rng: mulberry32(7) });
  s.addPlayer('p1', 24, 24);
  const roster = [{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [...(opts.wearing ?? [711])], playingInstrument: false,
  }];
  if (opts.extraPlayerAt !== undefined) {
    s.addPlayer(opts.extraPlayerAt.id, opts.extraPlayerAt.x, opts.extraPlayerAt.y);
    roster.push({
      id: opts.extraPlayerAt.id, x: opts.extraPlayerAt.x, y: opts.extraPlayerAt.y, z: 0,
      facingDeg: 0, afk: false, heldItem: 0, wearing: [711], playingInstrument: false,
    });
  }
  s.setMobPlayers(roster);
  s.addMob(opts.mobId ?? 'mob_sheep', 'MEADOW', 25, 24);
  return s;
}

/** 野猪贴脸的世界(反伤那条路要的是「生物真的打出预警」)。 */
function boarScene(wearing: readonly number[]): WorldSim {
  const s = new WorldSim({ sizeCells: 32, rng: mulberry32(7) });
  s.addPlayer('p1', 12.5, 8.5);
  s.setMobPlayers([{
    id: 'p1', x: 12.5, y: 8.5, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [...wearing], playingInstrument: false,
  }]);
  s.addMob('mob_boar#1', 'MEADOW', 8.5, 8.5);
  return s;
}

/** 推到第一次命中(与 WS-FND-118 FND118-6 同一手法,便于双向对照)。 */
function untilHit(s: WorldSim): number {
  for (let i = 1; i <= 1200; i += 1) {
    s.tick();
    if (s.lastHits.length > 0) return i;
  }
  return -1;
}

/* ═══════════ 1. P1:倒地者不能攻击(§规则 4 与移动侧同源)═══════════ */

test('FND124-1 ★★ P1:倒地者被打成 BUBBLED 后仍然不能攻击(修前只判 GHOST_BUBBLE)', () => {
  const s = scene({ extraPlayerAt: { id: 'p2', x: 22, y: 24 } });
  eq(s.attackMobAuthorized('p1', 'mob_sheep').rejected, null, '前置:活着能打');

  /* 把 p1 打成 0 血 ⇒ vitals.downed 同一帧置真;慢帧建幽灵泡泡。 */
  s.vitals.applyDamage('p1', 1e9, { ignoreIframe: true });
  /* 泡泡由**慢帧**创建 ⇒ 推满一个慢帧 stride(旧写法 10 编码了 20Hz)。 */
  for (let i = 0; i < FAST_PER_SLOW; i += 1) s.tick();
  const ghost = s.downedOf('p1');
  ok(ghost !== undefined, '前置:慢帧建出了倒地状态');
  eq(ghost!.state, BodyState.GHOST_BUBBLE, '前置:泡泡态是 GHOST_BUBBLE');
  eq(s.attackMobAuthorized('p1', 'mob_sheep').rejected, 'DOWNED', '前置:泡泡态拒');

  /* ★ 生产道具路径:227 泡泡连发水枪对**幽灵泡泡**目标连中 3 发 ⇒ BUBBLED。 */
  for (let i = 0; i < 3; i += 1) {
    const r = s.useItem('p2', { itemId: 227, targetId: 'p1' });
    ok(r.applied, `前置:第 ${i + 1} 发水枪命中(生产者路径,不是直接改字段)`);
  }
  const bubbled = s.downedOf('p1');
  eq(bubbled!.state, BodyState.BUBBLED, '★ 倒地者被装进大泡泡(BUBBLED)');
  eq(s.vitals.get('p1')!.downed, true, '前置:移动侧的真值 `vitals.downed` 仍为真');

  eq(s.attackMobAuthorized('p1', 'mob_sheep').rejected, 'DOWNED',
    '★ 修前这里放行(只判 GHOST_BUBBLE ⇒ 封了腿却还能挥刀)');
  eq(s.applyPlayerMove('p1', 30, 30), false, '移动侧同样拒绝 ⇒ 两侧同源');

  /* 负对照:纯规则层 —— 只有 NORMAL(已复活)才放行。 */
  const d = createDowned(setLevel(createProgress('x'), 5), {
    weapon: null, armor: null, helm: null, boots: null, relic: null, cape: null,
  }, 0, 0);
  eq(ghostControl({ ...d, state: BodyState.NORMAL }).canAttack, true,
    '★ 负对照:复活后(NORMAL)可以攻击 —— 统一口径不是「一律封手」');
  eq(ghostControl({ ...d, state: BodyState.BUBBLED }).canAttack, false,
    '★ BUBBLED(倒地者)不能攻击');
  eq(ghostControl({ ...d, state: BodyState.GHOST_BUBBLE }).canAttack, false,
    'GHOST_BUBBLE 不能攻击');
});

/* ═══════════ 2. P1:护盾 / 晶甲进 TargetProfile ═══════════ */

test('FND124-2 ★★ P1:AI 账本的护盾进 TargetProfile ⇒ 破盾分支真的走(负对照:无盾)', () => {
  /* 负对照:AI 没有护盾(默认 mem.shield 缺省)==> 第 4 步无盾可破,伤害直接进 HP。 */
  const bare = scene({ wearing: [204] });
  const bareRt = bare.mobHost.runtimeOf('mob_sheep')!;
  const bareHp0 = bareRt.hp;
  const b = bare.attackMob('p1', 'mob_sheep', { level: 10 })!;
  eq(b.result.shieldDamage, 0, '★ 负对照:没有护盾 ⇒ shieldDamage = 0');
  eq(b.result.shieldBroken, false, '★ 负对照:也没有「破盾」');
  ok(bareRt.hp < bareHp0, '负对照:无盾时伤害真的进 HP(不是「什么都不掉」)');

  /* 正例:火灵那套护盾池(`MobRuntime.mem.shield`)投进档案 ⇒ 盾未破时 HP 免伤。 */
  const s = scene({ wearing: [204] });
  const rt = s.mobHost.runtimeOf('mob_sheep')!;
  rt.mem.shield = 400;
  const hp0 = rt.hp;
  const hit = s.attackMob('p1', 'mob_sheep', { level: 10 })!;
  ok(hit.result.shieldDamage > 0,
    `★ 破盾伤害 ${hit.result.shieldDamage} > 0(修前恒 0:入参里没有 shield)`);
  eq(hit.result.shieldBroken, false, '这一刀没破(单次破盾量 < 400)');
  eq(hit.hpLoss, 0, '★ 盾未破 ⇒ HP 完全免伤');
  eq(rt.hp, hp0, '★ 生物 HP 一点没掉(修前这刀直接进血)');
  ok(rt.mem.shield < 400,
    `★ 盾量写回 AI 账本:400 → ${rt.mem.shield}(不写回 ⇒ 下一刀又是满盾)`);

  /* 继续敲:总会破;破的那一刻 AI 账本归零。 */
  let broke = false;
  for (let i = 0; i < 12 && !broke; i += 1) {
    if (!rt.alive) break;
    const r = s.attackMob('p1', 'mob_sheep', { level: 10 })!;
    if (r.result.shieldBroken) broke = true;
  }
  ok(broke, '★ 连续敲击最终破盾(修前永不破:target.shield 恒 0)');
  eq(rt.mem.shield, 0, '★ 破盾后 AI 账本归零');
});

test('FND124-3 ★★ P1:CRYSTAL_ARMOR_MUL / ignoresCrystal 从世界入口可达', () => {
  const armored = scene({ wearing: [711] });
  armored.mobHost.runtimeOf('mob_sheep')!.mem.crystalArmor = 1;
  const a = armored.attackMob('p1', 'mob_sheep', { level: 10 })!;
  /* ★ 反同义反复:`expected` 侧写**字面量**,常量留在**锚点**行(它证的是
     「0.20 这个口径没漂」,而本行证的是「世界入口真的把晶甲算进去了」)。 */
  eq(CRYSTAL_ARMOR_MUL, 0.2, '锚点:晶甲系数 0.20 不得漂移');
  eq(a.result.crystalMul, 0.2,
    '★ 晶甲系数真的生效(修前恒 1:入参里没有 crystalArmor)');

  /* 负对照:同一个世界、同一把武器,只是 AI 没声明晶甲。 */
  const plain = scene({ wearing: [711] });
  eq(plain.attackMob('p1', 'mob_sheep', { level: 10 })!.result.crystalMul, 1,
    '★ 负对照:没声明晶甲 ⇒ 系数 1');

  /* 204 的 4.0 破盾倍率 ⇒ ignoresCrystal(`shieldBreakMul >= 3.0`)。 */
  const pick = scene({ wearing: [204] });
  pick.mobHost.runtimeOf('mob_sheep')!.mem.crystalArmor = 1;
  const p = pick.attackMob('p1', 'mob_sheep', { level: 10 })!;
  ok(p.result.shieldBreakMul >= 3.0, `204 的破盾倍率 ${p.result.shieldBreakMul} ≥ 3.0`);
  eq(p.result.crystalMul, 1, '★ 204 无视晶甲(修前这条分支永远走不到)');

  /* 712 的 [Q]「破盾重劈」= 3.0:内容表倍率真的进第 4 步。 */
  const heavy = scene({ wearing: [712] });
  const q = heavy.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
  eq(q.result.shieldBreakMul, 3.0, '★ 712「破盾重劈」的 3.0 倍率进公式');
});

/* ═══════════ 3. P2:辅助技不落伤害 ═══════════ */

test('FND124-4 ★★ P2:717 治愈春风圈不再补刀(1 血怪不掉血),治疗真的发生', () => {
  const s = scene({ wearing: [717] });
  s.vitals.applyDamage('p1', 50, { ignoreIframe: true });      /* hp 100 → 50 */
  const hp0 = s.vitals.get('p1')!.hp;
  const rt = s.mobHost.runtimeOf('mob_sheep')!;
  rt.hp = 1;                                                   /* 残血 1:修前那 1 点会补刀 */
  const mobHp0 = rt.hp;

  const hit = s.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
  eq(hit.result.finalDamage, 0, '★ 辅助技 finalDamage = 0(根本不进伤害管线)');
  eq(hit.result.source, 'SKILL', '来源仍是 SKILL(不是「退回普攻」)');
  eq(hit.hpLoss, 0, '★ 一点血都不掉(修前被 MIN_DAMAGE 抬成 1)');
  eq(rt.hp, mobHp0, '★ 残血 1 的怪没被补刀');
  eq(rt.alive, true, '★ 怪还活着 ⇒ 没有击杀账 / 没有经验');
  const hp1 = s.vitals.get('p1')!.hp;
  ok(hp1 > hp0, `★ 治疗生效:${hp0} → ${hp1}(内容表 healHp 60,按上限截断)`);
  eq(hp1, 100, '治疗被 maxHp 截断(50 + 60 ⇒ 100)');
  ok(hit.events.some((e) => e.includes(':utility')), '★ 事件流写明「辅助技」');
  ok(hit.events.some((e) => e.startsWith('skill:q_heal_circle:heal=')),
    '★ 治疗量进事件流(可观测)');

  /* 负对照:同一只 1 血怪,换成**伤害技**(715 三连)⇒ 真的被补刀。 */
  const dmg = scene({ wearing: [715] });
  const rt2 = dmg.mobHost.runtimeOf('mob_sheep')!;
  rt2.hp = 1;
  const k = dmg.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
  ok(k.hpLoss > 0, `★ 负对照:伤害技照样打出真实掉血(${k.hpLoss})—— 断言不是「什么都打不死」`);
  eq(rt2.alive, false, '★ 负对照:伤害技真的打死了(击杀链没被误伤)');
});

test('FND124-5 ★ P2:720 / 721 的辅助技同样零伤害(不再各送 1 点)', () => {
  for (const weaponId of [720, 721]) {
    const s = scene({ wearing: [weaponId] });
    const rt = s.mobHost.runtimeOf('mob_sheep')!;
    rt.hp = 1;
    const hit = s.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
    eq(hit.hpLoss, 0, `★ ${weaponId} 的 [Q] 不落伤害(修前 MIN_DAMAGE 抬成 1)`);
    eq(rt.hp, 1, `★ ${weaponId}:1 血怪原封不动`);
    eq(rt.alive, true, `★ ${weaponId}:没有击杀账`);
    eq(hit.result.finalDamage, 0, `★ ${weaponId}:finalDamage = 0`);
  }
});

/* ═══════════ 4. P2:反伤口径 ═══════════ */

test('FND124-6 ★★ P2:反伤按「实际扣除」折算,累计 = 生物真实掉血', () => {
  const armored = boarScene([711, 728]);
  const boar = armored.mobHost.runtimeOf('mob_boar#1')!;
  /* 残血起手:公式侧的 `applied` 会大于「实际扣除」,这正是修前的放大点。
     `vitals.get` 是**同一引用**(契约允许改字段),这里刻意不经过 applyDamage ——
     否则会顺手种上无敌帧,把要测的那一击挡掉。
     ⚠️ 回血(`stepTimers`)会在这几十帧里把血抬一点 ⇒ 判据取「挨打**前那一帧**的 HP」,
     不写死 1。 */
  armored.vitals.get('p1')!.hp = 1;
  const hp0 = boar.hp;
  let hpBeforeStrike = armored.vitals.get('p1')!.hp;
  let frame = -1;
  for (let i = 1; i <= 1200; i += 1) {
    hpBeforeStrike = armored.vitals.get('p1')!.hp;
    armored.tick();
    if (armored.lastHits.length > 0) { frame = i; break; }
  }
  ok(frame > 0, '前置:玩家真的被野猪打中');
  eq(armored.vitals.get('p1')!.downed, true, '前置:残血这一击把玩家打倒');
  const applied = armored.lastHits[0]!.applied;
  ok(applied > hpBeforeStrike,
    `★ 前置:公式额度 ${applied} > 实际扣除 ${hpBeforeStrike}(超额成立,否则这条测不出东西)`);

  const reflectMul = combatantStats(1, [711, 728]).reflectMul;
  ok(reflectMul > 0, `前置:728 的反伤倍率 ${reflectMul} > 0`);
  const loss = hp0 - boar.hp;
  const clampedBase = Math.round(hpBeforeStrike * reflectMul * 100) / 100;
  const rawBase = Math.round(applied * reflectMul * 100) / 100;
  ok(Math.abs(clampedBase - rawBase) > 1e-6,
    `前置:两种口径必须不同(${clampedBase} vs ${rawBase}),否则判据恒真`);
  near(loss, clampedBase, 1e-6,
    '★ 反伤基数 = **实际扣除**(修前用未钳的 res.applied ⇒ 放大)');
  near(armored.reflectTotalDamage(), loss, 1e-9,
    '★ reflectTotalDamage() = 生物真实掉血(修前记折前额度 ⇒ 虚高)');

  /* 负对照:同一张图、同一只猪、同样的帧数,只把护甲换成不带反伤的那件。 */
  const bare = boarScene([711]);
  const bareBoar = bare.mobHost.runtimeOf('mob_boar#1')!;
  bare.vitals.get('p1')!.hp = 1;
  const bareHp0 = bareBoar.hp;
  ok(untilHit(bare) > 0, '前置(负对照):玩家也被打中');
  eq(bareBoar.hp, bareHp0, '★ 负对照:不穿 728 ⇒ 生物 HP 一动不动');
  eq(bare.reflectTotalDamage(), 0, '★ 负对照:反伤累计 0');

  /* ★ 单跳不成环:玩家打生物时生物**不反伤**(reflectMul 恒 0)。 */
  const s = scene();
  const playerHp0 = s.vitals.get('p1')!.hp;
  const mine = s.attackMob('p1', 'mob_sheep', { level: 10 })!;
  eq(mine.result.reflectDamage, 0, '★ 生物不反伤 ⇒ 反伤单跳不成环(不会二次回打玩家)');
  eq(s.vitals.get('p1')!.hp, playerHp0, '★ 玩家没被自己的攻击反噬');
});

/* ═══════════ 5. P2:技能时序 ═══════════ */

test('FND124-7 ★★ P2:716 箭雨按 tick 排程(修前 6 段同一帧)', () => {
  const s = scene({ wearing: [716], mobId: 'mob_clock_knight' });
  const rt = s.mobHost.runtimeOf('mob_clock_knight')!;
  const hp0 = rt.hp;
  const hit = s.attackMob('p1', 'mob_clock_knight', { level: 10, useSkill: true })!;

  eq(hit.segments, 6, '计划段数仍是 6(内容表 hits 6)');
  eq(hit.tickScheduleSec, [0, 0.5, 1.0, 1.5, 2.0, 2.5],
    '★ 时序 = telegraphSec + plan.ticks(修前两半都被丢)');
  eq(hit.pendingTicks, 5, '★ 本帧只结算第 1 段,其余 5 段排队');
  eq(s.pendingSkillTicks(), 5, '队列里真的有 5 段');
  const afterFirst = rt.hp;
  ok(hp0 - afterFirst > 0, '第 1 段当场落地');

  for (let i = 0; i < secondsToTicks(0.5); i += 1) s.tick();   /* 0.5 秒(帧数由秒派生) */
  ok(rt.hp < afterFirst, '★ 0.5 秒后第 2 段才到(修前 6 段全在第一帧)');
  eq(s.pendingSkillTicks(), 4, '★ 只到期 1 段(段间隔 0.5 秒真的被遵守)');

  for (let i = 0; i < secondsToTicks(3); i += 1) s.tick();
  eq(s.pendingSkillTicks(), 0, '★ 排队的段全部走完');
  eq(s.skillTickStats().landed, 5, '★ 5 段在后续帧分别结算');
  ok(hp0 - rt.hp > hp0 - afterFirst, '★ 后续段真的继续造成伤害');

  /* 负对照:715 三连的三段**同在时刻 0** ⇒ 不排队(时序不是「一律拖后」)。 */
  const triple = scene({ wearing: [715] });
  const t = triple.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
  eq(t.segments, 3, '715 三连 = 3 段');
  eq(t.pendingTicks, 0, '★ 负对照:三段同刻 ⇒ 不排队');
  eq(triple.pendingSkillTicks(), 0, '队列空');
});

test('FND124-8 ★★ P2:718 陨石的 1 秒前摇真的存在(前摇内零结算)', () => {
  const s = scene({ wearing: [718], mobId: 'mob_clock_knight' });
  const rt = s.mobHost.runtimeOf('mob_clock_knight')!;
  const hp0 = rt.hp;
  const hit = s.attackMob('p1', 'mob_clock_knight', { level: 10, useSkill: true })!;

  eq(hit.tickScheduleSec, [1.0], '★ 前摇 1.0 秒进时序');
  eq(hit.hpLoss, 0, '★ 施法当帧零伤害(前摇)');
  eq(hit.result.finalDamage, 0, '★ 占位结果是零伤害');
  eq(hit.pendingTicks, 1, '整段排队');
  eq(rt.hp, hp0, '生物一点血没掉');

  for (let i = 0; i < secondsToTicks(0.5); i += 1) s.tick();   /* 0.5 秒 */
  eq(rt.hp, hp0, '★ 0.5 秒时仍在预警(前摇没走完)');
  eq(s.pendingSkillTicks(), 1, '★ 段还在队列里');

  for (let i = 0; i < secondsToTicks(0.75); i += 1) s.tick();  /* 累计 1.25 秒 */
  ok(rt.hp < hp0, '★ 1 秒后陨石落地');
  eq(s.pendingSkillTicks(), 0, '★ 落地后队列清空');
});

/* ═══════════ 6. 注入验证 + 修前形态消失 ═══════════ */

test('FND124-9 ★ 注入:时序判据是纯函数,边界 / NaN / 负前摇都有牙', () => {
  const rain = WEAPON_BY_ID.get(716)!.skill;
  const t716 = skillTiming(rain);
  eq(t716.telegraphSec, 0, '716 无前摇(内容表)');
  eq(t716.impactAtSec, [0, 0.5, 1.0, 1.5, 2.0, 2.5], '716 的六段时刻');
  eq(dueSkillTicks(t716, 0), [0], 't = 0 只有第 1 段到期');
  eq(dueSkillTicks(t716, 0.5), [0, 1], 't = 0.5 到期两段');
  eq(dueSkillTicks(t716, 2.5), [0, 1, 2, 3, 4, 5], 't = 2.5 全部到期');
  eq(dueSkillTicks(t716, 1e9), [0, 1, 2, 3, 4, 5], '极大的时刻不会漏段');

  /* 注入 1:NaN ⇒ 按 0 处理(不许「一段都不到期」把技能吞掉)。 */
  eq(dueSkillTicks(t716, Number.NaN), [0], '★ 注入 NaN ⇒ 退化为 t = 0,而不是整段作废');

  /* 注入 2:前摇把第一段推到 1.0 秒之后。 */
  const meteor = skillTiming(WEAPON_BY_ID.get(718)!.skill);
  eq(meteor.impactAtSec, [1.0], '718 前摇 1.0 秒');
  eq(dueSkillTicks(meteor, 0), [], '★ 注入:前摇内一段都不到期');
  eq(dueSkillTicks(meteor, 1.0), [0], '★ 恰好到 1.0 秒 ⇒ 到期');

  /* 注入 3:负前摇不许造出「负时刻」(那会让段在施法前就生效)。 */
  const bad = skillTiming({ ...WEAPON_BY_ID.get(718)!.skill, telegraphSec: -5 });
  eq(bad.telegraphSec, 0, '★ 注入负前摇 ⇒ 归零');
  eq(bad.impactAtSec, [0], '★ 注入负前摇 ⇒ 时刻不出现负数');
});

test('FND124-10 ★ 修前形态已消失(剥注释后判据,不吃注释里的引用)', () => {
  const code = stripCommentsForAudit(readFileSync(join(ROOT, 'server/src/sim/world_sim.ts'), 'utf8'));
  eq(code.includes('mobCombatProfile(rt.def, { hp: rt.hp })'), false,
    '★ 不再只喂 { hp }(那正是护盾/晶甲永不生效的位置)');
  ok(/mobTargetProfileOf\s*\(/.test(code), '受击方档案由 mobTargetProfileOf 统一供给');
  ok(/shield:/.test(code) && /crystalArmor:/.test(code),
    '★ 档案里真的填了 shield / crystalArmor(不是只在注释里认账)');
  ok(/tickSkillCasts\s*\(\)/.test(code), '★ 技能时序有执行点(不是只算出时刻)');
  ok(/this\.tickSkillCasts\(\)/.test(code), '★ 执行点由世界 tick 驱动');
});

report('WS-FND-124');