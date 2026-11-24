/**
 * WS-FND-152 —— **战斗效果全接线**(owner 2026-11-19 裁定「全接」)。
 *
 * ## 这个套件钉的五件事
 *
 * ```text
 * 1 料理 5 个 buff 槽  defFlat / moveMul / gravityMul / jumpMul / expMul
 *                       ⇒ 受伤减免 / 移速上限乘区(≠ 地面摩擦 μ)/ 重力 / 跳跃 / 经验
 * 2 受击击退的**完整参数**  伤害 + 受击者质量 + 方向(★ D-09 的上界 2 格不变)
 * 3 连击窗口            COMBO_WINDOW_SEC = 0.6(★ 待平衡)⇒ 进**伤害**(comboMul)
 * 4 锻造按稀有度三档      0 / +1 / +2(★ 待平衡)
 * 5 carrySlots 接容量闸   `net/room.ts#carryCapacityOf` 不再内联 `8 + (lv-1)`
 * ```
 *
 * ## 每条判据都是「正反各一」+「改常量立即反映」
 *
 * | 效果 | 正例(吃到/接上 ⇒ 数变) | 负例(没吃/没接 ⇒ 一字不变) |
 * | :--- | :--- | :--- |
 * | `defFlat` | FND152-5 受伤乘区 120/122 | FND152-2/-5 没吃 ⇒ 恰 1 |
 * | `moveMul` | FND152-3 速度上限 4.5×1.10 | FND152-2/-3 没吃 ⇒ 旁表无记录 |
 * | `gravityMul` | FND152-4 重力 0.90 | FND152-4 没吃 ⇒ 恒 1 |
 * | `jumpMul` | FND152-4 起跳 8×1.05 | FND152-4 没吃 ⇒ 恒 1 |
 * | `expMul` | FND152-6 入账 45×1.05 = 47 | FND152-6 没吃 ⇒ 逐字 45 |
 * | 击退质量 | FND152-12 质量 20 ⇒ 0.1 格 | FND152-12 质量 1 ⇒ 2 格 / 非法质量退化 |
 * | 连击 | FND152-8 同帧三刀 ⇒ base ×1.25 | FND152-7/-8 超窗/首刀 ⇒ ×1.00 |
 * | 锻造 | FND152-9 稀有度 1/2 ⇒ +1/+2 | FND152-9 稀有度 0 / 非法 ⇒ +0 |
 * | 容量闸 | FND152-10 档案 99 ⇒ 99 | FND152-10 无档案 ⇒ 等级派生的 8 |
 *
 * ## ⚠️ 断言右侧一律**字面量**
 *
 * `2` / `1.10` / `0.90` / `1.05` / `0.6` / `1.25` / `2`(格)/ `4.5` / `120` / `45` / `47`
 * 全部取自 **owner 裁决的保守默认 / 冻结层常量 / 手册** —— 不从被测模块取期望值
 * (否则「改常量时两侧一起变」⇒ 同义反复,门禁 `--strict-taut` 会报)。
 * 唯一用被测导出当期望的是**表格状**的那两处(`FORGE_TIER_*` 与台账状态位):
 * 它们断言的是「表与行为一致」,不是把表当期望。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { eq, near, ok, report, test } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { WorldSim, FAST_PER_SLOW } from '../server/src/sim/world_sim.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import { BASE_MOVE_SPEED, secondsToTicks } from '../shared/types/physics.ts';
import {
  COMBO_CHAIN_MUL,
  COMBO_WINDOW_SEC,
  HIT_KNOCKBACK_MAX_CELLS,
  hitKnockbackOf,
  massNormalizedCells,
  nextComboState,
} from '../server/src/combat/damage.ts';
import { applyForgeTierBonus, forgeTierBonusOf } from '../server/src/combat/weapons.ts';
import { carryCapacityOfLevel, carryItemCapacity, PROGRESS_FIELD_WIRING } from '../server/src/combat/progression.ts';
import {
  COMBAT_WIRING_LEDGER,
  WIRING_STATUS,
  auditCombatWiring,
  stripCommentsForAudit,
} from '../server/src/combat/wiring_ledger.ts';

const ROOT = join(import.meta.dirname, '..');

/* ═════════════════════ 夹具 ═════════════════════ */

/** 「一个玩家」的世界(需要生物时由用例自己 `addMob`)。 */
function scene(): WorldSim {
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 24);
  return s;
}

/** 读一个文件的**代码**(剥注释):判据只看代码,说明里会成段引用被禁的写法。 */
function codeOf(rel: string): string {
  return stripCommentsForAudit(readFileSync(join(ROOT, rel), 'utf8'));
}

/** `server/src/**` 全量源码(台账对账的输入,与 `WS-FND-118` 同一口径)。 */
function serverSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.set(relative(ROOT, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(ROOT, 'server/src'));
  return out;
}

/** 料理 id(全部来自冻结内容表 §3.9)。 */
const FOOD_MOVE = 601;      // 移动速度 +15%(有数值)
const FOOD_CHICKEN = 608;   // 整蛊·变鸡:手册**没给任何数值** ⇒ 走保守默认剂量
const FOOD_GRAVITY = 609;   // 重力 0.30(有数值)
const FOOD_JUMP = 604;      // 跳跃 1.50(有数值)
const FOOD_EXP = 613;       // 经验 1.30(有数值)

/** 用 9999 点真伤打死一只野猪(击杀结算 ⇒ 经验入账)。 */
function killBoar(s: WorldSim): void {
  s.addMob('mob_boar#1', 'MEADOW', 25, 24);
  s.damageMob('mob_boar#1', 9999, DamageKind.PHYSICAL, 0);
}

/* ═══════════ 1. 料理 5 槽:保守默认剂量(★ 待平衡(owner))═══════════ */

test('FND152-1 ★ 608(手册无任何数值)吃下 ⇒ 五个槽全部非中性,数值 = 保守默认', () => {
  /* 手算(owner 裁定的保守默认):defFlat 2 / moveMul 1.10 / gravityMul 0.90 /
     jumpMul 1.05 / expMul 1.05。
     怎么变红:`dishStatMods` 退回 `mods(def.statMods)`(空 ⇒ 全中性)⇒ 五条全红。 */
  const s = scene();
  eq(s.useItem('p1', { itemId: FOOD_CHICKEN }).applied, true, '608 有使用语义');
  const m = s.buffsOf('p1');
  eq(m.defFlat, 2, '★ defFlat = +2(待平衡(owner))');
  near(m.moveMul, 1.10, 1e-12, '★ moveMul = ×1.10');
  near(m.gravityMul, 0.90, 1e-12, '★ gravityMul = ×0.90');
  near(m.jumpMul, 1.05, 1e-12, '★ jumpMul = ×1.05');
  near(m.expMul, 1.05, 1e-12, '★ expMul = ×1.05');
});

test('FND152-2 负对照:有数值的料理**逐字透传**,不被默认剂量污染;没吃 ⇒ 全中性', () => {
  /* 601 只声明 moveMul 1.15 ⇒ 其余四个槽必须仍是中性 0 / 1。
     怎么变红:`dishStatMods` 一律叠加默认剂量 ⇒ 601 的 gravity/jump/exp 全变 ⇒ 红。 */
  const s = scene();
  s.useItem('p1', { itemId: FOOD_MOVE });
  const m = s.buffsOf('p1');
  near(m.moveMul, 1.15, 1e-12, '601 自己的 1.15(手册字面量)');
  eq(m.defFlat, 0, '★ 601 没有 defFlat ⇒ 不许被默认 +2 白送');
  near(m.gravityMul, 1, 1e-12, '★ 601 不带重力乘区');
  near(m.jumpMul, 1, 1e-12, '★ 601 不带跳跃乘区');
  near(m.expMul, 1, 1e-12, '★ 601 不带经验乘区');

  /* 负对照 2:一口都没吃 ⇒ 五个槽是单位元(合并函数只乘/加 buff,不自己造数)。 */
  const bare = scene().buffsOf('p1');
  eq(bare.defFlat, 0, '没吃料理 ⇒ defFlat 0');
  near(bare.moveMul, 1, 1e-12, '没吃料理 ⇒ moveMul 1');
  near(bare.gravityMul, 1, 1e-12, '没吃料理 ⇒ gravityMul 1');
  near(bare.jumpMul, 1, 1e-12, '没吃料理 ⇒ jumpMul 1');
  near(bare.expMul, 1, 1e-12, '没吃料理 ⇒ expMul 1');
});

/* ═══════════ 2. 三个乘区 → 物理层(与 μ 区分)═══════════ */

test('FND152-3 moveMul 接**速度上限**乘区,且**不是**地面摩擦 μ(muMuls 仍空)', () => {
  /* 手算:4.5(冻结层 BASE_MOVE_SPEED)× 1.10 = 4.95。
     怎么变红:慢帧不推 ⇒ speedCapOf 仍是 null;
              或者把 moveMul 当作 μ 写进 muMuls ⇒ 第 2 条红(D-12 的 μ 与这里不是同一件事)。 */
  const s = scene();
  s.useItem('p1', { itemId: FOOD_CHICKEN });
  s.advance(FAST_PER_SLOW); /* 一个慢帧:推送点在慢帧里(旧写法 10 编码了 20Hz) */
  near(s.physics.speedCapOf('p1') ?? -1, BASE_MOVE_SPEED * 1.10, 1e-9, '★ 4.5 × 1.10 = 4.95');
  const phys = s.physics as unknown as { muMuls: Map<string, number> };
  eq(phys.muMuls.has('p1'), false, '★ moveMul 是速度**上限**乘区,不该写进 μ 旁表(610 才走 μ)');

  /* 负对照:没吃料理 ⇒ 速度上限**不设记录**(中性必须是「撤掉」而不是「推 1」)。 */
  const bare = scene();
  bare.advance(FAST_PER_SLOW);
  eq(bare.physics.speedCapOf('p1'), null, '★ 没吃料理 ⇒ 旁表没有记录');
});

test('FND152-4 gravityMul / jumpMul 接物理层(重力 + 起跳),没吃 ⇒ 两道都恒 1', () => {
  /* 手算:609 的重力 0.30 与 604 的跳跃 1.50 是**内容值**;
     本判据换成 608 的保守默认 0.90 / 1.05(同一字段、同一条推送路径)。
     负对照:没吃料理 ⇒ gravityMulOf = 1、jumpMulOf = 1、jumpPlayer 不放大。 */
  const s = scene();
  s.useItem('p1', { itemId: FOOD_CHICKEN });
  s.advance(FAST_PER_SLOW);
  near(s.physics.gravityMulOf('p1'), 0.90, 1e-9, '★ 重力 ×0.90');
  near(s.physics.jumpMulOf('p1'), 1.05, 1e-9, '★ 起跳 ×1.05');
  near(s.jumpPlayer('p1', 8) ?? -1, 8 * 1.05, 1e-9, '★ 8 × 1.05 = 8.4(乘区只结算一次)');
  eq(s.tryPlayerJump('p1').reason, 'AIRBORNE', '负对照:已经在空中 ⇒ 生产入口拒绝第二次起跳');

  const bare = scene();
  bare.advance(FAST_PER_SLOW);
  near(bare.physics.gravityMulOf('p1'), 1, 1e-12, '没吃 ⇒ 重力恒 1');
  near(bare.physics.jumpMulOf('p1'), 1, 1e-12, '没吃 ⇒ 起跳恒 1');
  near(bare.jumpPlayer('p1', 8) ?? -1, 8, 1e-9, '没吃 ⇒ 起跳 8 逐位不变');

  /* 内容值**没有被默认剂量改写**:609 / 604 仍是自己的数。 */
  const c = scene();
  c.useItem('p1', { itemId: FOOD_GRAVITY });
  c.useItem('p1', { itemId: FOOD_JUMP });
  c.advance(FAST_PER_SLOW);
  near(c.physics.gravityMulOf('p1'), 0.30, 1e-9, '609 的 0.30 逐字保留');
  near(c.physics.jumpMulOf('p1'), 1.50, 1e-9, '604 的 1.50 逐字保留');
});

/* ═══════════ 3. defFlat → 受伤减免;expMul → 经验 ═══════════ */

test('FND152-5 defFlat 接**受伤减免**(ARMOR_K 曲线),没吃 / 没这个槽 ⇒ 乘区恰 1', () => {
  /* 手算:120 / (120 + 2) ≈ 0.9836065573770492(护甲递减曲线,ARMOR_K = 120 是既有常数)。
     怎么变红:`mobDamageMulFor` 不读 `buffsOf.defFlat` ⇒ 前两条都变 1。 */
  const s = scene();
  s.useItem('p1', { itemId: FOOD_CHICKEN });
  const priv = s as unknown as { mobDamageMulFor(id: string): number };
  near(priv.mobDamageMulFor('p1'), 120 / 122, 1e-12, '★ 120 / (120+2) ⇒ 受伤乘区 < 1');

  const bare = scene();
  near((bare as unknown as { mobDamageMulFor(id: string): number }).mobDamageMulFor('p1'), 1, 1e-12,
    '★ 没吃料理 ⇒ 乘区恰 1');

  /* 负对照 2:601 没有 defFlat ⇒ 不许有减伤(证明不是「吃了任何料理都减伤」)。 */
  const move = scene();
  move.useItem('p1', { itemId: FOOD_MOVE });
  near((move as unknown as { mobDamageMulFor(id: string): number }).mobDamageMulFor('p1'), 1, 1e-12,
    '★ 601 没有 defFlat ⇒ 受伤乘区仍是 1');
});

test('FND152-6 expMul 接**经验入账**(击杀结算),没吃 ⇒ 逐字基础经验', () => {
  /* 手算:野猪 45 exp;单人、等级 1 vs 怪 4 级 ⇒ levelGapMul = 1;expMul 1.05
     ⇒ 45 × 1.05 = 47.25 ⇒ round = 47。
     怎么变红:`settleKill` 不把 `buffsOf.expMul` 填进 `expBonusMul` ⇒ 仍是 45。 */
  const s = scene();
  s.useItem('p1', { itemId: FOOD_CHICKEN });
  killBoar(s);
  eq(s.progressSnapshotOf('p1')?.totalExp, 47, '★ 45 × 1.05 = 47.25 ⇒ 入账 47');

  const bare = scene();
  killBoar(bare);
  eq(bare.progressSnapshotOf('p1')?.totalExp, 45, '★ 负对照:没吃料理 ⇒ 逐字 45');

  /* 内容值不被默认剂量覆盖:613 的 1.30 仍乘出 1.30 倍(45 × 1.30 = 58.5 ⇒ 59)。 */
  const cake = scene();
  cake.useItem('p1', { itemId: FOOD_EXP });
  killBoar(cake);
  eq(cake.progressSnapshotOf('p1')?.totalExp, 59, '★ 613 的 1.30 逐字生效(45 × 1.3 = 58.5 ⇒ 59)');
});

/* ═══════════ 4. 连击窗口(★ 待平衡 = 0.6 秒)═══════════ */

test('FND152-7 连击窗口的**边界**钉住 0.6 秒(闭区间),倍率链 1.00 / 1.00 / 1.25', () => {
  /* 手算:窗口 0.6;恰好 0.6 仍算连击(闭区间),0.61 断开。
     怎么变红:窗口改成开区间 / 换成别的数 ⇒ 第 3/4 条红;
              链长或第 3 段倍率改了 ⇒ 第 5/6 条红。 */
  eq(COMBO_WINDOW_SEC, 0.6, '★ 窗口常量 = 0.6 秒(待平衡(owner))');
  eq([...COMBO_CHAIN_MUL], [1.0, 1.0, 1.25], '★ 倍率链 = 手册的 1.00 / 1.00 / 1.25');

  const first = nextComboState(null, 0);
  eq(first.state.count, 1, '首刀 ⇒ 连击 1');
  eq(first.mul, 1.0, '首刀 ⇒ ×1.00');
  eq(first.inWindow, false, '首刀不算「落在窗口内」');

  const second = nextComboState(first.state, 0.3);
  eq(second.state.count, 2, '0.3 秒后 ⇒ 连击 2');
  eq(second.mul, 1.0, '第 2 段仍是 ×1.00');

  const edge = nextComboState({ count: 1, lastHitSec: 0 }, 0.6);
  eq(edge.inWindow, true, '★ 恰好 0.6 秒 ⇒ 仍算连击(闭区间)');
  eq(edge.state.count, 2, '边界上连击 +1');

  const over = nextComboState({ count: 1, lastHitSec: 0 }, 0.61);
  eq(over.inWindow, false, '★ 0.61 秒 ⇒ 窗口外');
  eq(over.state.count, 1, '超窗 ⇒ 回到第 1 段');
  eq(over.mul, 1.0, '超窗 ⇒ ×1.00');

  const third = nextComboState(second.state, 0.6);
  eq(third.state.count, 3, '第 3 段');
  eq(third.mul, 1.25, '★ 第 3 段起 ×1.25');
  const fourth = nextComboState(third.state, 1.2);
  eq(fourth.state.count, 3, '链封顶:连击数不再变长(倍率不无限放大)');
  eq(fourth.mul, 1.25, '封顶后仍 ×1.25');
});

test('FND152-8 ★ 连击接进**伤害**:生产入口同帧三刀 ⇒ 第 3 刀 base 是 1.25 倍', () => {
  /* 为什么是伤害而不是计分:`comboMul` 早就在八步公式第 1 步里,生产侧恒传 1.0 ——
     要接的是这个**已经存在**的乘区(接到计分是另造一套口径,见 damage.ts 的 docblock)。
     怎么变红:`attackMobAuthorized` 仍传 `comboMul: 1.0` ⇒ comboOf 恒 null、第 2 条红。 */
  const s = scene();
  eq(s.comboOf('p1'), null, '前提:还没打过 ⇒ 没有连击状态');
  s.addMob('mob_boar#1', 'MEADOW', 25, 24); /* 180 HP ⇒ 挨得住三刀 */
  const r1 = s.attackMobAuthorized('p1', 'mob_boar#1', {});
  eq(s.comboOf('p1')?.count, 1, '★ 第 1 刀之后服务端有连击状态(= 真的有状态机)');
  const r2 = s.attackMobAuthorized('p1', 'mob_boar#1', {});
  const r3 = s.attackMobAuthorized('p1', 'mob_boar#1', {});
  eq(s.comboOf('p1')?.count, 3, '★ 同帧三刀 ⇒ 连击 3');
  ok(r1.hit !== null && r2.hit !== null && r3.hit !== null, '三刀都命中了(前置)');
  ok(r1.hit!.hpLoss > 0 && r3.hit!.hpLoss > 0, '三刀都真的掉血(前置:野猪 180 HP 挨得住)');
  near(r3.hit!.result.base / r1.hit!.result.base, 1.25, 0.01, '★ 第 3 刀 base = 第 1 刀 × 1.25');

  /* 负对照:跨过窗口(> 0.6 秒;DT = 0.05 ⇒ 20 帧 = 1.0 秒)⇒ 连击回到 1,伤害回到 1.00 档。 */
  s.advance(secondsToTicks(COMBO_WINDOW_SEC * 2));   /* 跨过 0.6 秒连击窗口 */
  const r4 = s.attackMobAuthorized('p1', 'mob_boar#1', {});
  eq(s.comboOf('p1')?.count, 1, '★ 超窗后重新从第 1 段算');
  ok(r4.hit !== null, '第 4 刀仍命中(前置)');
  near(r4.hit!.result.base / r1.hit!.result.base, 1.0, 0.01, '★ 超窗 ⇒ 伤害回到 ×1.00');
});

/* ═══════════ 5. 锻造按稀有度三档(★ 待平衡)═══════════ */

test('FND152-9 锻造分档:稀有度 0/1/2(3 与 2 同档)⇒ +0/+1/+2;非法 ⇒ +0', () => {
  /* 手算:三档 = [0, 1, 2];稀有度是四档(0 凡品 / 1 奇巧 / 2 秘宝 / 3 神来之笔),
     后两档并进第 3 档。
     怎么变红:表改成 [0,0,0] ⇒ 第 2/3 条红;非法 tier 当最高档 ⇒ 第 5 条红。 */
  eq(forgeTierBonusOf(0), 0, '★ 凡品 +0');
  eq(forgeTierBonusOf(1), 1, '★ 奇巧 +1');
  eq(forgeTierBonusOf(2), 2, '★ 秘宝 +2');
  eq(forgeTierBonusOf(3), 2, '★ 神来之笔与秘宝同档(三档封顶)');
  eq(forgeTierBonusOf(Number.NaN), 0, '★ 非法 tier ⇒ 最低档(fail-closed)');
  eq(forgeTierBonusOf(-5), 0, '负数 tier ⇒ 最低档');
  eq(applyForgeTierBonus({ atk: 10, def: 5 }, 0), { atk: 10, def: 5, bonus: 0 },
    '★ 档 0 ⇒ 战斗点数**一位不动**');
  eq(applyForgeTierBonus({ atk: 10, def: 5 }, 2), { atk: 12, def: 7, bonus: 2 },
    '★ 档 2 ⇒ atk/def 各 +2');
});

/* 锻造是 `async`(门禁 + 派生 + 落库);数据在**模块顶层**先跑好,`test` 保持同步。 */
const forged = await (async (): Promise<{
  ok: boolean;
  rarityTier: number;
  bonus: number;
  atk: number;
  def: number;
  rolledAtk: number;
}> => {
  const sim = new WorldSim({ sizeCells: 32 });
  /* `GroundItem` 的声明只有 `{id,x,y,count}`,而世界侧按 `itemId` 认件(`groundItemId` 读它)——
     所以这里显式带上 `itemId` 并按契约收窄(与 `WorldSim.forgeAlchemy` 自己 push 的形状一致)。 */
  type GroundItemLike = Parameters<WorldSim['setGroundItems']>[0][number];
  const mats = [101, 102, 103].map((id, i) =>
    ({ id, itemId: id, x: 4 + i, y: 4, count: 4 }) as unknown as GroundItemLike);
  sim.setGroundItems(mats);
  const r = await sim.forgeAlchemy([101, 102, 103], { seed: 7, x: 12, y: 12 });
  if (!r.ok) return { ok: false, rarityTier: -1, bonus: -1, atk: -1, def: -1, rolledAtk: -1 };
  return {
    ok: true,
    rarityTier: r.crafted.rarityTier,
    bonus: r.crafted.bonus,
    atk: r.crafted.atk,
    def: r.crafted.def,
    rolledAtk: r.result.instance.rolled.atk,
  };
})();

test('FND152-9b ★ 生产投影:forgeAlchemy 返回的 crafted 点数 = rolled + 分档加成', () => {
  /* 怎么变红:`forgeAlchemy` 不调 `applyForgeTierBonus`(直接透传 rolled)⇒ 第 3 条红。 */
  eq(forged.ok, true, '前置:三件材料能出锅');
  eq(forged.bonus, Math.min(2, forged.rarityTier), '★ 加成 = 三档表[min(2, 稀有度)]');
  eq(forged.atk, forged.rolledAtk + Math.min(2, forged.rarityTier), '★ atk = rolled.atk + 档位加成');
  ok(forged.def >= 0, 'def 投影出来了(非负)');
});

/* ═══════════ 6. carrySlots → 容量闸 ═══════════ */

test('FND152-10 ★ 容量闸读档案:carrySlots 改到 99 ⇒ 房间容量 99;复原 ⇒ 8', () => {
  /* 修前:`net/room.ts#carryCapacityOf` 内联 `8 + (lv-1)` ⇒ 档案改成 99 仍是 8
     (`WS-FND-148` FND148-7 就是按「仍是 8」钉的 —— 那条判据在本轮按 owner 裁决反转)。
     怎么变红:房间侧退回内联算式 ⇒ 第 2 条红(仍是 8)。 */
  const a = assemble({
    roomId: 'r_fnd152',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    db: null,
    archiveSink: null,
  });
  const rt = a.runtime;
  rt.join({ userId: 'p1' });
  const sim = a.host as unknown as WorldSim;

  eq(rt.carryCapacityOf('p1'), carryItemCapacity(8), '★ 无档案 ⇒ 等级 1 的容量 8 格(等级派生的同一口径)');
  sim.progressOf('p1').carrySlots = 99;
  eq(rt.carryCapacityOf('p1'), carryItemCapacity(99), '★ 改档案 ⇒ 容量真的变(修前恒 8 格)');
  sim.progressOf('p1').carrySlots = 8;
  eq(rt.carryCapacityOf('p1'), carryItemCapacity(8), '复原 ⇒ 回到 8 格');

  /* 等级派生与冻结层同源:Lv.30 ⇒ 8 + 29 = 37。 */
  eq(carryCapacityOfLevel(30), 37, '★ carryCapacityOfLevel(30) = 37(与 statsAtLevel 同源)');
  eq(carryCapacityOfLevel(1), 8, 'Lv.1 = 8');
});

/* ═══════════ 7. 击退的完整参数(★ D-09 上界不变)═══════════ */

test('FND152-11 击退三参数:伤害折算 + 上界 2 格 + 方向;质量归一**只做一次**', () => {
  /* 手算(D-09,owner 2026-11-16):每 20 点伤害 1 格,上界 2 格,方向远离攻击者;
     质量归一 = 位移 × (1 / 质量)。
     怎么变红:上界被改 ⇒ 第 2 条红;质量归一搬进 `hitKnockbackOf`
               ⇒ 世界侧会乘两遍(FND152-12 的 0.1 变成 0.005)。 */
  eq(HIT_KNOCKBACK_MAX_CELLS, 2, '★ D-09 的上界仍是 2 格');
  const small = hitKnockbackOf({ damage: 10, targetMass: 1, fromX: 0, fromY: 0, toX: 1, toY: 0 });
  near(small.cells, 0.5, 1e-12, '★ 10 / 20 = 0.5 格');
  eq(small.applied, true, '有伤害且有方向 ⇒ 施加');
  near(small.dirX, 1, 1e-12, '方向 = 受击者远离攻击者(+x)');
  near(small.dirY, 0, 1e-12, '方向没有 y 分量');
  const capped = hitKnockbackOf({ damage: 1000, targetMass: 1, fromX: 0, fromY: 0, toX: 1, toY: 0 });
  near(capped.cells, 2, 1e-12, '★ 1000 伤害仍被钳到 2 格(上界没变)');
  eq(hitKnockbackOf({ damage: 0, targetMass: 1, fromX: 0, fromY: 0, toX: 1, toY: 0 }).applied, false,
    '★ 零伤害 ⇒ 不击退(零副作用)');
  eq(hitKnockbackOf({ damage: 10, targetMass: 1, fromX: 1, fromY: 1, toX: 1, toY: 1 }).applied, false,
    '★ 两点重合 ⇒ 没有方向可言 ⇒ 不击退(不随便挑一个方向)');

  near(massNormalizedCells(2, 1), 2, 1e-12, '★ 质量 1 ⇒ 逐位不变(D-09 的老判据不动)');
  near(massNormalizedCells(2, 20), 0.1, 1e-12, '★ 质量 20 ⇒ 2 × (1/20) = 0.1 格');
  near(massNormalizedCells(2, Number.NaN), 2, 1e-12, '★ 非法质量退化到基准(不是 NaN)');
});

test('FND152-12 ★ 世界侧真的按质量推:质量 20 的玩家被推 0.1 格(质量 1 时 2 格)', () => {
  /* 怎么变红:`applyKnockback` 不做质量归一 ⇒ 第 1 条变 2;
              归一做了两遍 ⇒ 第 1 条变 0.005。 */
  const heavy = scene();
  const hb = heavy.physics.bodies.get('p1');
  ok(hb !== undefined, '前置:玩家有刚体');
  const hx = hb!.x;
  hb!.mass = 20;
  eq(heavy.applyKnockback('p1', hx - 1, hb!.y, 2), true, '击退被接受');
  eq(heavy.knockbackOf('p1'), true, '搬家窗口打开(可观测)');
  /* 击退走**慢帧分段推**(生产侧 `WorldSim.KNOCKBACK_STEPS = 2` 段,每段一个慢帧,
     该常量是 private ⇒ 这里按同值声明并注明出处);帧数 = 段数 × 慢帧 stride。
     旧写法 20 = 20Hz 下的 2 个慢帧。 */
  const KNOCKBACK_STEPS = 2;   /* = `WorldSim.KNOCKBACK_STEPS`(private) */
  heavy.advance(KNOCKBACK_STEPS * FAST_PER_SLOW);
  near(hb!.x - hx, 0.1, 1e-6, '★ 质量 20 ⇒ 2 × (1/20) = 0.1 格');

  const light = scene();
  const lb = light.physics.bodies.get('p1');
  const lx = lb!.x;
  eq(lb!.mass, 1, '前提:玩家默认质量 = 1');
  light.applyKnockback('p1', lx - 1, lb!.y, 2);
  light.advance(KNOCKBACK_STEPS * FAST_PER_SLOW);
  near(lb!.x - lx, 2, 1e-6, '★ 质量 1 ⇒ 逐位 2 格(D-09 原值)');
});

/* ═══════════ 8. 「改常量立即反映」:单点证明 ═══════════ */

test('FND152-13 ★ 六个默认值各自**只有一处字面量**,消费点按名字引用 ⇒ 改常量必然全链路生效', () => {
  /* 这不是同义反复的检查:它断言「没有第二份字面量挡在中间」。
     行为侧的证据在上面的判据里(值被吃到、被推给物理层、被算进伤害/经验);
     这里补的是**结构侧**:一个数一处,改它不会漏。
     怎么变红:有人在消费点又写一遍 `1.10` / `0.6` ⇒ 对应计数变 2。 */
  const cooking = codeOf('server/src/combat/cooking.ts');
  const count = (src: string, needle: string): number => src.split(needle).length - 1;
  eq(count(cooking, 'defFlat: 2'), 1, '★ defFlat 的 2 只出现一处(默认剂量表)');
  eq(count(cooking, 'moveMul: 1.10'), 1, '★ moveMul 的 1.10 只出现一处');
  eq(count(cooking, 'gravityMul: 0.90'), 1, '★ gravityMul 的 0.90 只出现一处');
  eq(count(cooking, 'jumpMul: 1.05'), 1, '★ jumpMul 的 1.05 只出现一处');
  eq(count(cooking, 'expMul: 1.05'), 1, '★ expMul 的 1.05 只出现一处');
  ok(count(cooking, 'dishStatMods(') >= 3,
    '★ 剂量表的消费点 `dishStatMods` 真的被两条构造路径调用(≥3 = 定义 + 两处调用)');

  const damage = codeOf('server/src/combat/damage.ts');
  eq(count(damage, 'COMBO_WINDOW_SEC = 0.6'), 1, '★ 连击窗口 0.6 只出现一处');
  ok(count(damage, 'COMBO_WINDOW_SEC') >= 2, '★ 窗口常量被 `nextComboState` 真的读(不是只导出)');
  eq(count(damage, 'HIT_KNOCKBACK_MAX_CELLS = 2'), 1, '★ 击退上界 2 只出现一处');

  const weapons = codeOf('server/src/combat/weapons.ts');
  eq(count(weapons, 'FORGE_TIER_STAT_BONUS: readonly number[] = Object.freeze([0, 1, 2])'), 1,
    '★ 锻造三档表只有一处声明');
});

/* ═══════════ 9. 台账与源码一致(接线的账要能对)═══════════ */

test('FND152-14 ★ 两本台账都记 `carrySlots` 为 WIRED,且房间侧不再内联算式', () => {
  /* 怎么变红:房间侧把内联算式写回去 ⇒ 第 1 条红;
              台账忘了跟着改 ⇒ 第 2/3 条红;任何 UNWIRED 行有读者 ⇒ 第 4 条红。 */
  const room = codeOf('server/src/net/room.ts');
  ok(!/8\s*\+\s*\(\s*lv\s*-\s*1\s*\)/.test(room), '★ 内联 `8 + (lv-1)` 已从房间侧删除(第二份口径没了)');
  ok(/carryCapacityOfLevel\s*\(/.test(room), '★ 房间侧改调唯一出处');

  const progress = PROGRESS_FIELD_WIRING.find((r) => r.field === 'carrySlots');
  eq(progress?.status, 'WIRED', '★ `PROGRESS_FIELD_WIRING` 的 carrySlots = WIRED');
  const ledger = COMBAT_WIRING_LEDGER.find((r) => r.symbol === 'carrySlots');
  eq(ledger?.status, WIRING_STATUS.WIRED, '★ `COMBAT_WIRING_LEDGER` 的 carrySlots = WIRED');

  const ignore = new Set<string>(['server/src/combat/wiring_ledger.ts']);
  eq(auditCombatWiring(COMBAT_WIRING_LEDGER, serverSources(), ignore), [],
    '★ 台账双向对账全绿(WIRED 真有消费点 / UNWIRED 真没读者)');
});

report('WS-FND-152');