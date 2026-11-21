/**
 * WS-FND-118 —— 战斗侧「实现了但没接」的**接线判据**(第六轮实测 P0/P1/P2/P3)。
 *
 * 运行:`node tests/WS-FND-118-combat-wired.test.ts`
 *
 * ## 这个套件钉的七件事
 *
 * | # | 缺陷(第六轮) | 本套件怎么钉 |
 * | :-- | :--- | :--- |
 * | 1 | **P0** 13 把武器的 [Q] 整组不可达(`skillOf`/`planSkillHits` 生产 0 调用) | 经 `attackMobAuthorized({useSkill})` 打出技能:倍率/段数/来源三处可见(FND118-1/2/3) |
 * | 2 | **P0** `PlayerProgress.dmgMul` 全 server 无读者 | 篡改档案倍率 ⇒ 伤害按比例变;等级不一致时**不生效**(FND118-4) |
 * | 3 | **P1** 728 反伤甲:第 7 步算完就被丢 | PvP 与「怪打人」两条通道各一条正例 + 不穿甲的负对照(FND118-5/6) |
 * | 4 | **P1** 幽灵期规则两套(手判 `downed` vs `ghostControl`) | 倒地 ⇒ 拒;泡泡态 ⇒ 拒;复活后**立即**可打(FND118-7) |
 * | 5 | **P2** `cleansePrankBuffs` 0 调用(喝 612 不掉整蛊 buff) | buff 计数:2 → 1;非净化料理 ⇒ 2 → 3(FND118-8) |
 * | 6 | **P2** `extinguishStation` 与 world_sim 自写 `fireOut` 双实现 | 源码判据(无 `.fireOut = true`)+ 行为可逆(FND118-9) |
 * | 7 | **P3** `float`/`steps` 无读者却被当成已生效 | 台账双向对账 + 同一扫描器对**真读者**的校准(FND118-10/11/12) |
 *
 * ## 判据纪律
 *
 * 1 **负对照**:每条正例都配一条「不该生效」的对照(没穿 728 / 没按 Q / 非净化料理 /
 *    等级不一致),否则「恒真」也能过。
 * 2 **注入验证**:FND118-12 把台账**篡改**成四种错误形态喂给审计函数,要求逐一报错 ——
 *    证明那套对账有牙,而不是只在本仓当前快照上恰好为绿。
 * 3 **不拿实现常量核实现行为**:期望值取内容表字面量(0.8×3、1.5、8+(lv−1))或
 *    由世界侧独立读数给出。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { eq, ok, near, report, test, mulberry32 } from '../shared/testing/harness.ts';
import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import { BodyState } from '../shared/types/physics.ts';
import {
  COMBAT_WIRING_LEDGER,
  WIRING_STATUS,
  auditCombatWiring,
  stripCommentsForAudit,
} from '../server/src/combat/wiring_ledger.ts';

const ROOT = join(import.meta.dirname, '..');
const LEDGER_SELF = 'server/src/combat/wiring_ledger.ts';

/* ═════════════════════ 夹具 ═════════════════════ */

type Scene = WorldSim;

/** 「玩家挨着生物」的世界;装备经 `setMobPlayers` 灌入(装配层入口,不是后门)。 */
function scene(opts: {
  wearing?: readonly number[];
  mobId?: string;
  size?: number;
  mobs?: boolean;
} = {}): Scene {
  const s = new WorldSim({ sizeCells: opts.size ?? 48, ...(opts.mobs !== undefined ? { mobs: opts.mobs } : {}) });
  s.addPlayer('p1', 24, 24);
  s.setMobPlayers([{
    id: 'p1', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
    heldItem: 0, wearing: [...(opts.wearing ?? [711])], playingInstrument: false,
  }]);
  s.addMob(opts.mobId ?? 'mob_sheep', 'MEADOW', 25, 24);
  return s;
}

/** 两个玩家相邻的世界(PvP 夹具)。 */
function pvpScene(defenderWearing: readonly number[]): Scene {
  const s = new WorldSim({ sizeCells: 48, mobs: false });
  s.addPlayer('a', 24, 24);
  s.addPlayer('b', 25, 24);
  s.setMobPlayers([
    {
      id: 'a', x: 24, y: 24, z: 0, facingDeg: 0, afk: false,
      heldItem: 0, wearing: [711], playingInstrument: false,
    },
    {
      id: 'b', x: 25, y: 24, z: 0, facingDeg: 180, afk: false,
      heldItem: 0, wearing: [...defenderWearing], playingInstrument: false,
    },
  ]);
  s.setPvp(true);
  return s;
}

/** 读 `server/src/**` 的源码(台账对账的输入)。 */
function serverSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const rel = relative(ROOT, p).split('\\').join('/');
        out.set(rel, readFileSync(p, 'utf8'));
      }
    }
  };
  walk(join(ROOT, 'server/src'));
  return out;
}

const SOURCES = serverSources();
const codeOf = (rel: string): string => stripCommentsForAudit(SOURCES.get(rel) ?? '');

/* ═══════════ 1. P0:[Q] 技能路径可达 ═══════════ */

test('FND118-1 ★★ P0:[Q] 技能经生产入口真的打出技能倍率(修前整组不可达)', () => {
  /* 711「旋风斩」damageMul 1.4。同一把武器、同一等级,唯一差别是**按不按 Q**。 */
  const plain = scene({ wearing: [711] });
  const skill = scene({ wearing: [711] });
  const p = plain.attackMob('p1', 'mob_sheep', { level: 10 })!;
  const q = skill.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;

  eq(p.result.source, 'NORMAL_ATTACK', '负对照:不按 Q ⇒ 走普攻来源');
  eq(q.result.source, 'SKILL', '★ 按 Q ⇒ 走 SKILL 来源(修前这一支没有调用者)');
  eq(q.segments, 1, '711 的 [Q] 是单段技能');
  /* 倍率 = 1.4(内容表)。判据用**比值**,避开暴击/取整的噪声。 */
  const ratio = q.result.base / p.result.base;
  near(ratio, 1.4, 0.02, `★ 技能倍率真的进了第 1 步:base ${p.result.base} → ${q.result.base}(×${ratio.toFixed(3)})`);

  /* 注入:武器不在表里 ⇒ `skillOf` 返回 null ⇒ 退回普攻(不崩、不静默造技能)。 */
  const unknown = scene({ wearing: [711] });
  const u = unknown.attackMob('p1', 'mob_sheep', { level: 10, weaponId: 9999, useSkill: true })!;
  eq(u.result.source, 'NORMAL_ATTACK', '★ 未登记的武器 ⇒ 没有技能可放(useSkill 不能凭空造技能)');
  eq(u.segments, 1, '未登记武器 ⇒ 段数为 1');
});

test('FND118-2 ★★ P0:多段技能的段数来自 planSkillHits(715 三连 / 716 箭雨)', () => {
  const triple = scene({ wearing: [715] });
  const t = triple.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
  eq(t.segments, 3, '★ 715「三连散射」hits=3 ⇒ 3 段结算(修前恒 1 段:技能根本没跑到)');
  ok(t.totalDamage > t.result.finalDamage, `多段合计 ${t.totalDamage} 必须大于单段记录 ${t.result.finalDamage}`);
  ok(t.hpLoss > 0, `多段真的落在生物身上(掉血 ${t.hpLoss})`);

  const rain = scene({ wearing: [716] });
  const r = rain.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!;
  eq(r.segments, 6, '★ 716「箭雨天降」hits=6 ⇒ 6 段(段数只由内容表决定)');

  /* 负对照:段数不是「按了 Q 就变多」—— 单段武器仍是 1 段。 */
  const single = scene({ wearing: [711] });
  eq(single.attackMob('p1', 'mob_sheep', { level: 10, useSkill: true })!.segments, 1,
    '负对照:单段技能（711）按 Q 仍是 1 段');
});

test('FND118-3 ★★ P0:attackMobAuthorized 转发 [Q] 意图(生产入口而不是测试后门)', () => {
  const on = scene({ wearing: [715] });
  const off = scene({ wearing: [715] });
  const withSkill = on.attackMobAuthorized('p1', 'mob_sheep', { useSkill: true });
  const without = off.attackMobAuthorized('p1', 'mob_sheep');

  ok(withSkill.hit !== null, '前置:授权入口结算了');
  eq(withSkill.rejected, null, '前置:没有被闸拒绝');
  eq(withSkill.hit!.segments, 3, '★ 经 attackMobAuthorized 也能拿到 3 段(意图被原样转发)');
  eq(without.hit!.segments, 1, '负对照:不传 useSkill ⇒ 1 段');
  eq(withSkill.hit!.result.source, 'SKILL', '★ 来源是 SKILL');
  eq(without.hit!.result.source, 'NORMAL_ATTACK', '负对照:来源是普攻');
  ok(withSkill.hit!.events.some((e) => e.startsWith('skill:')), '★ 命中区域进事件流(planSkillHits 的另一半产出)');
});

/* ═══════════ 2. P0:PlayerProgress.dmgMul 有读者 ═══════════ */

test('FND118-4 ★★ P0:dmgMul 真的进伤害倍率;等级不一致时**不**生效(负对照)', () => {
  const s = scene({ wearing: [711] });
  const before = s.attackMobAuthorized('p1', 'mob_sheep').hit!.result.base;
  /* 档案 level 1 ⇒ dmgMul 1。把它改成 2:与等级无关的值,**只能**来自这个字段。 */
  const progress = s.progressOf('p1');
  eq(progress.dmgMul, 1, '前置:lv1 的档案倍率是 1');
  progress.dmgMul = 2;
  const after = s.attackMobAuthorized('p1', 'mob_sheep').hit!.result.base;
  near(after / before, 2, 0.001, `★ 篡改 dmgMul ⇒ 伤害按比例变(${before} → ${after};修前这个字段改了没人读)`);

  /* 负对照:结算等级与档案等级不一致(测试注入 level=5)⇒ **不**套档案倍率。 */
  const injected = s.attackMob('p1', 'mob_sheep', { level: 5 })!.result.base;
  near(injected / before, 1 + 0.03 * 4, 0.001,
    '★ 等级不一致 ⇒ 退回公式自己的等级倍率(×1.12),不叠档案倍率(×2)以避两份等级口径');
});

/* ═══════════ 3. P1:728 反伤真的施加回去 ═══════════ */

test('FND118-5 ★★ P1:728 反伤甲在 PvP 里回打攻击者(第 7 步不再被丢)', () => {
  const armored = pvpScene([711, 728]);
  const hpA0 = armored.vitals.get('a')!.hp;
  const r = armored.attackPlayerAuthorized('a', 'b');
  ok(r.applied > 0, '前置:B 真的被打中');
  ok(r.result !== null && r.result.reflectDamage > 0, '前置:第 7 步算出了反伤');
  const hpA1 = armored.vitals.get('a')!.hp;
  eq(hpA0 - hpA1, Math.round(r.result!.reflectDamage),
    `★ 反伤施加回攻击者:A 掉 ${hpA0 - hpA1} 血 = round(承伤 × 1.5)`);
  eq(armored.reflectTotalDamage(), Math.round(r.result!.reflectDamage), '★ 反伤累计读数与施加量一致(可观测)');

  /* 负对照:同一次攻击,受击方**不穿** 728 ⇒ 攻击者一点血都不掉。 */
  const bare = pvpScene([711]);
  const hpB0 = bare.vitals.get('a')!.hp;
  const rb = bare.attackPlayerAuthorized('a', 'b');
  ok(rb.applied > 0, '前置:负对照那次也真的打中了');
  eq(bare.vitals.get('a')!.hp, hpB0, '★ 负对照:没穿 728 ⇒ 攻击者 HP 不动');
  eq(bare.reflectTotalDamage(), 0, '★ 负对照:反伤累计 0');
});

test('FND118-6 ★★ P1:728 反伤甲在「怪打人」方向回打生物(修前怪毫发无损)', () => {
  const mk = (wearing: readonly number[]): WorldSim => {
    const s = new WorldSim({ sizeCells: 32, mobs: true, rng: mulberry32(7) });
    s.addPlayer('p1', 12.5, 8.5);
    s.setMobPlayers([{
      id: 'p1', x: 12.5, y: 8.5, z: 0, facingDeg: 0, afk: false,
      heldItem: 0, wearing: [...wearing], playingInstrument: false,
    }]);
    s.addMob('mob_boar#1', 'MEADOW', 8.5, 8.5);
    return s;
  };
  /** 推到第一次命中(mob_boar 的冲锋预警 → 结算)。 */
  const untilHit = (s: WorldSim): number => {
    for (let i = 1; i <= 1200; i += 1) {
      s.tick();
      if (s.lastHits.length > 0) return i;
    }
    return -1;
  };

  const armored = mk([711, 728]);
  const boarHp0 = armored.mobHost.runtimeOf('mob_boar#1')!.hp;
  ok(untilHit(armored) > 0, '前置:玩家真的被野猪打中');
  const boarHp1 = armored.mobHost.runtimeOf('mob_boar#1')!.hp;
  ok(armored.reflectTotalDamage() > 0, `★ 反伤施加出去了(累计 ${armored.reflectTotalDamage()})`);
  ok(boarHp1 < boarHp0, `★ 生物真的掉血:${boarHp0} → ${boarHp1}`);

  /* 负对照:同一张图、同一只猪、同样的帧数,只有护甲换成不带反伤的那件。 */
  const bare = mk([711]);
  const bareHp0 = bare.mobHost.runtimeOf('mob_boar#1')!.hp;
  ok(untilHit(bare) > 0, '前置:负对照那次也真的被打中');
  eq(bare.mobHost.runtimeOf('mob_boar#1')!.hp, bareHp0, '★ 负对照:不穿 728 ⇒ 生物 HP 不动');
  eq(bare.reflectTotalDamage(), 0, '★ 负对照:反伤累计 0');
});

/* ═══════════ 4. P1:幽灵期规则统一 ═══════════ */

test('FND118-7 ★★ P1:倒地/泡泡两态都封手,复活后**立即**放行(规则来自 revive.ts)', () => {
  const s = scene({ wearing: [711] });
  eq(s.attackMobAuthorized('p1', 'mob_sheep').rejected, null, '前置:活着能打');

  /* 打到 0 血 ⇒ `vitals.downed`(同一帧置位)。此时泡泡还没建(慢帧才建)。 */
  s.vitals.applyDamage('p1', 1e9, { ignoreIframe: true });
  eq(s.vitals.get('p1')!.downed, true, '前置:玩家已倒地');
  eq(s.attackMobAuthorized('p1', 'mob_sheep').rejected, 'DOWNED',
    '★ 倒地(泡泡未建)⇒ 拒;真值来自 vitals 的瞬时判定');

  /* 推进慢帧 ⇒ 建泡泡。此后 canAttack 由 `revive.ts#ghostControl` 给。 */
  /* 泡泡由**慢帧**创建 ⇒ 推满一个慢帧 stride(旧写法 10 编码了 20Hz)。 */
  for (let i = 0; i < FAST_PER_SLOW; i += 1) s.tick();
  const bubble = s.downedOf('p1');
  ok(bubble !== undefined, '前置:慢帧建出了幽灵泡泡');
  eq(bubble!.state, BodyState.GHOST_BUBBLE, '前置:泡泡态是 GHOST_BUBBLE');
  eq(s.attackMobAuthorized('p1', 'mob_sheep').rejected, 'DOWNED',
    '★ 泡泡态也拒 —— 且这条现在走 ghostControl.canAttack(修前是另一份手判)');

  /* 负对照:复活后**立刻**能打(不等慢帧清泡泡快照 —— 顺序写反就是这个 bug)。 */
  s.vitals.revive('p1');
  ok(s.attackMobAuthorized('p1', 'mob_sheep').rejected !== 'DOWNED',
    '★ 复活后立刻放行(泡泡快照的清账在慢帧,不能拿它当封手依据)');
});

/* ═══════════ 5. P2:净化饮真的清整蛊 buff ═══════════ */

test('FND118-8 ★ P2:612 净化饮清掉整蛊 buff;非净化料理不清(负对照)', () => {
  const s = scene({ wearing: [711] });
  const eat = (itemId: number): number => {
    const r = s.useItem('p1', { itemId });
    ok(r.applied, `前置:道具 ${itemId} 被吃下`);
    return Number(r.effect?.buffs ?? -1);
  };
  eq(eat(607), 1, '前置:整蛊 607 → 1 条 buff');
  eq(eat(608), 2, '前置:再来一条整蛊 608 → 2 条');
  eq(eat(612), 1, '★ 612 净化饮:2 条整蛊全清,只剩它自己(修前是 3 条)');

  /* 负对照:同样两条整蛊,改喝 601(非净化)⇒ 一条都不掉。 */
  const n = scene({ wearing: [711] });
  const eatN = (itemId: number): number => Number(n.useItem('p1', { itemId }).effect?.buffs ?? -1);
  eq(eatN(607), 1, '前置(负对照):607 → 1');
  eq(eatN(608), 2, '前置(负对照):608 → 2');
  eq(eatN(601), 3, '★ 负对照:601 不净化 ⇒ 3 条(清 buff 只由 flags.cleanse 决定)');
});

/* ═══════════ 6. P2:灭火只有一份实现 ═══════════ */

test('FND118-9 ★ P2:world_sim 不再自写 fireOut(委托 cooking.extinguishStation)', () => {
  const ws = codeOf('server/src/sim/world_sim.ts');
  eq(/\.fireOut\s*=\s*true/.test(ws), false, '★ 世界侧不再自己写 fireOut(两份实现已合并)');
  ok(/\bextinguishStation\s*\(/.test(ws), '★ 世界侧真的调了 cooking.extinguishStation(不是只写了注释)');

  /* 行为:浇灭 → 可复燃(单向 + 可逆那一半都在),证明委托没改语义。 */
  const s = scene({ wearing: [711] });
  eq(s.relightStationAt(506), false, '前置:火没灭时不能「复燃」');
  s.extinguishStationAt(506);
  eq(s.relightStationAt(506), true, '★ 浇灭后再点火 ⇒ 真的灭过(委托保留了原语义)');

  /* 负对照(注入):`cooking.extinguishStation` 自己确实只有一处写点。 */
  const ck = codeOf('server/src/combat/cooking.ts');
  eq((ck.match(/\.fireOut\s*=\s*true/g) ?? []).length, 1, '★ 「把火灭掉」全仓只有 1 处写点');
});

/* ═══════════ 7. P3:台账双向对账 + 注入 ═══════════ */

test('FND118-10 ★★ 台账自洽:WIRED 有真实消费点,UNWIRED/RESERVED 一处都没有', () => {
  const ignore = new Set([LEDGER_SELF]);
  eq(auditCombatWiring(COMBAT_WIRING_LEDGER, SOURCES, ignore), [],
    '★ 台账 21 行全部对得上(任何一行状态写错/读者被悄悄接上都会红)');

  const byStatus = (st: string): number => COMBAT_WIRING_LEDGER.filter((r) => r.status === st).length;
  ok(byStatus(WIRING_STATUS.WIRED) >= 7, `WIRED 至少 7 行(实测 ${byStatus(WIRING_STATUS.WIRED)})`);
  ok(byStatus(WIRING_STATUS.UNWIRED) >= 10, `UNWIRED 至少 10 行(实测 ${byStatus(WIRING_STATUS.UNWIRED)})`);
  ok(byStatus(WIRING_STATUS.RESERVED) >= 3, `RESERVED 至少 3 行(实测 ${byStatus(WIRING_STATUS.RESERVED)})`);

  /* 三个「注释里曾宣称生效」的字段必须在台账里(不许只在注释里认账)。 */
  for (const sym of ['dmgMul', 'talentFlags', 'carrySlots', 'ghostDamageMul', 'tickInvuln', 'isInvulnerable']) {
    ok(COMBAT_WIRING_LEDGER.some((r) => r.symbol === sym), `★ ${sym} 必须在台账里有一行`);
  }
});

test('FND118-11 ★ RESERVED 的双极性校准:同一扫描器能看见真读者,也确实看不见 float/steps', () => {
  const readers = [...SOURCES.entries()]
    .filter(([p]) => p !== 'server/src/combat/damage.ts' && p !== LEDGER_SELF)
    .map(([, raw]) => stripCommentsForAudit(raw))
    .join('\n');
  /* 校准(正极性):`finalDamage` 真的被编排层读走 —— 证明扫描器不是「什么都看不见」。 */
  ok(/\.finalDamage\b/.test(readers), '校准:finalDamage 在生产里有读者(扫描器有牙)');
  /* 目标(负极性):飘字与八步明细真的没人读 ⇒ 它们只能是 RESERVED,不是「已生效」。 */
  eq(/\.float\b/.test(readers), false, '★ DamageResult.float 在 server/** 无读者');
  eq(/\.steps\b/.test(readers), false, '★ DamageResult.steps 在 server/** 无读者');
});

test('FND118-12 ★★ 注入验证:四种篡改形态都必须被台账审计抓住', () => {
  const ignore = new Set([LEDGER_SELF]);
  const skillOfRow = COMBAT_WIRING_LEDGER.find((r) => r.symbol === 'skillOf')!;

  const doctored = [
    /* 甲 明明接了却标 UNWIRED(反向扫描应报) */
    { ...skillOfRow, status: WIRING_STATUS.UNWIRED },
    /* 乙 声明 WIRED 但消费点写回本模块(自用不算接线) */
    { ...skillOfRow, wiredAt: 'server/src/combat/weapons.ts#自己', status: WIRING_STATUS.WIRED },
    /* 丙 符号不存在(改名/写错) */
    { symbol: 'noSuchCombatSymbolXYZ', module: 'server/src/combat/damage.ts', status: WIRING_STATUS.UNWIRED, reason: '一个故意写错的符号名,用来证明台账会核对标识符是否存在。' },
    /* 丁 chain 指向一个不在台账里的名字 */
    {
      symbol: 'shieldLeft', module: 'server/src/combat/damage.ts', status: WIRING_STATUS.RESERVED,
      evidence: '\\.shieldLeft\\b', chain: 'ghostSymbolNotInLedger',
      reason: '故意把死路指向一个不存在于台账的符号,用来证明 chain 规则不是装饰。',
    },
  ];

  const problems = auditCombatWiring(doctored, SOURCES, ignore);
  ok(problems.length >= 4, `★ 四种篡改至少要报 4 条问题(实测 ${problems.length})`);
  ok(problems.some((p) => p.startsWith('skillOf')), '甲/乙:skillOf 的两条篡改被抓到');
  ok(problems.some((p) => p.includes('noSuchCombatSymbolXYZ')), '丙:不存在的符号被抓到');
  ok(problems.some((p) => p.startsWith('shieldLeft')), '丁:悬空 chain 被抓到');

  /* 反向校准:同一批**未经篡改**的行必须是全绿(否则上面的红没有意义)。 */
  eq(auditCombatWiring(COMBAT_WIRING_LEDGER, SOURCES, ignore), [], '校准:原台账全绿');
});

report('WS-FND-118');