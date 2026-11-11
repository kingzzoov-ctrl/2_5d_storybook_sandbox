/**
 * WS-FND-06 —— 手册数值表 ↔ 代码实现 一致性门禁
 *
 * ## 这份测试的属性
 *
 * 它检查的是**代码是否忠实于手册**,而不是「代码是否自洽」。
 * 因此每个期望值都是**从手册原文逐字抄来的字面量**(附手册行号),
 * 而**不是**从代码里 `import` 出来的常量 ——
 * 后者会让断言与实现同源:改数值时两边一起变,断言永远通过,等于没测。
 *
 * ```
 * ✅ eq(TICK_HZ, 20, ...)          // 20 抄自手册 L19;代码错了就红
 * ❌ eq(TICK_HZ, PHY.TICK_HZ, ...) // 同义反复,永远绿
 * ```
 *
 * ## 为什么只固化「已确认一致」的项
 *
 * 审计发现了一批不一致(地砖 μ 表、炼金属性区间等)。那些**不写入本测试** ——
 * 写进去会立刻变红,而修数值会引发跨 WS 连锁,必须由 Lead 裁决后统一改。
 * 不一致清单在 `docs/DATA-CONFORMANCE.md`,可复跑工具在 `scripts/data-conformance.ts`。
 *
 * 本测试的另一个作用:把「裁决后改动」变成可失败的——
 * 若有人调整这些数值而不更新本文件,门禁立刻报错。
 *
 * ## 手册位置
 *
 * 期望值已内联,因此**手册文件不在场也能跑**。手册行号仅作溯源标注。
 * 若手册文件可定位,额外做一次「行号仍指向该数值」的校验(见 §10),
 * 用来发现「手册换版但内联值没跟」的情况。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';

import {
  ITEM_LIST, ITEM_BY_ID, ITEM_TABLES,
} from '../shared/constants/items.ts';
import { MOB_LIST, MOB_BY_ID } from '../shared/constants/mobs.ts';
import { BOSS_LIST, BOSS_BY_ID, PARTY_MODES } from '../shared/constants/bosses.ts';
import {
  expToNext, statsAtLevel, MAX_LEVEL, BASE_HP, TALENT_LEVELS,
  SHARE_EXP_RADIUS, PARTY_BONUS_THRESHOLD, PARTY_BONUS, AFK_EXP_RATIO,
  REVIVE_TIME, REVIVE_HP_RATIO, FEATHER_RANGE, FEATHER_INVULN,
  bossScaledHp,
} from '../shared/types/entities.ts';
import {
  TICK_HZ, DT, SLOW_TICK_HZ, GRAVITY, THROW_SPEED_XY, THROW_SPEED_Z,
  CARRY_Z_STEP, CARRY_MAX_DEPTH, CARRY_SLOWDOWN,
  CATCH_Z_MIN, CATCH_Z_MAX, CATCH_RADIUS,
  RADIUS_PLAYER, RADIUS_WILD, RADIUS_BOSS,
  MASS_PLAYER, MASS_HEAVY, MASS_BOSS,
  BASE_MOVE_SPEED, BASE_ATK, BODY_STATES,
} from '../shared/types/physics.ts';
import {
  ELEV_MASK, BASE_MASK, FLOOR_MASK, WIRE_MASK, OBJ_MASK, META_MASK,
  ELEV_SHIFT, BASE_SHIFT, FLOOR_SHIFT, WIRE_SHIFT, OBJ_SHIFT, META_SHIFT,
  CHUNK_SIZE, CHUNK_BYTES,
} from '../shared/types/tile.ts';
import { RARITY_LABEL, ALCHEMY_MIN_INPUTS, ALCHEMY_MAX_INPUTS, BETA_DEW } from '../shared/types/alchemy.ts';
import {
  RARITY_THRESHOLDS, AGG_EXPONENT, K_BONUS_RATE, EPSILON_MIN, EPSILON_MAX,
  S_LOGIC_MIN, S_LOGIC_MAX, PROF_RATE_PER_LEVEL, PROF_MAX_LEVEL, EPSILON_SIGMA,
  ATK_MUL, DEF_MUL, HP_MUL, IMPULSE_BASE, IMPULSE_MUL, UTIL_MUL, UTIL_CAP_PERCENT,
  BUDGET_BASE, BUDGET_EXPONENT,
} from '../server/src/alchemy/attributes.ts';
import { HEAVY_MASS_THRESHOLD } from '../server/src/physics/carry.ts';
import { BELT_FORCE } from '../server/src/physics/world.ts';
import { FLOOR_META, floorMu, FLOOR_DEFAULT_MU, BARE_GROUND_MU } from '../server/src/world/chunk.ts';
import {
  BOAR_WINDUP_SEC, BOAR_CHARGE_TILES, BOAR_SELF_STUN_SEC,
  BEETLE_FRONT_DR, GINGER_ESCAPE_SEC, CHOCOBO_TAME_WHEAT,
} from '../server/src/mobs/behaviors.ts';
import {
  FOODS,
} from '../server/src/combat/cooking.ts';
import { WEAPON_BY_ID, ARMORS } from '../server/src/combat/weapons.ts';
import {
  COMPONENT_SPECS, PULSE_BUTTON_SECONDS, RELAY_DELAY_SECONDS,
  COUNTER_MOD, CHANNEL_MIN, CHANNEL_MAX,
} from '../server/src/wiring/components.ts';
import {
  CONVEYOR_CELLS_PER_TICK, LOGISTICS_HZ, DRILL_PERIOD_SECONDS,
} from '../server/src/wiring/logistics.ts';
import { PRANK_TOYS, SAFE_SHIELD_ITEM_ID, BANANA_SLIDE_TILES, BANANA_SLIDE_STUN_SEC, BUBBLE_HITS_TO_TRAP, BOMB_FUSE_SEC, BOMB_ENEMY_DAMAGE, SHRINK_SCALE, GIANT_SCALE, HONEY_SLOW_RATIO, SNOWBALL_FREEZE_SEC, TUG_IMPULSE } from '../server/src/prank/toys.ts';
import { isImmuneToAllyPrank, isImmuneToHostile } from '../server/src/prank/immunity.ts';
import { CROWN_WIN_SEC } from '../server/src/party/modes.ts';
import { contentFingerprints, contentCapacity } from '../server/src/content/registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════════════════════════════════════════════════════
 * 1. 物品总表(手册 §3,标题行 L71;§3.10 表头 L395)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L71] 物品总数 320 件', () => {
  /* 手册 L71:「(320 项独立 ID 明细配表)」 */
  eq(ITEM_LIST.length, 320, '物品总数');
});

test('[L395] 最大物品 ID = 745', () => {
  /* 手册 L395:「### 3.10 …(ID 701 ~ 745,共 45 项)」 */
  eq(Math.max(...ITEM_LIST.map((i) => i.id)), 745, '最大 ID');
  eq(ITEM_BY_ID.has(745), true, '745 号物品存在');
});

test('[L75~L395] 十大分表项数 30/20/18/35/30/35/40/37/30/45', () => {
  /* 手册每节标题自己写了「共 N 项」,逐节行号见下表 */
  const hb: [string, number, number][] = [
    ['3.1', 30, 75], ['3.2', 20, 110], ['3.3', 18, 135], ['3.4', 35, 158],
    ['3.5', 30, 198], ['3.6', 35, 233], ['3.7', 40, 273], ['3.8', 37, 318],
    ['3.9', 30, 360], ['3.10', 45, 395],
  ];
  const byKey = new Map(ITEM_TABLES.map((t) => [t.key, t.ids.length]));
  eq(byKey.size, 10, '分表数量');
  for (const [key, n, line] of hb) {
    eq(byKey.get(key), n, `§${key} 项数(手册 L${line})`);
  }
  const sum = [...byKey.values()].reduce((a, b) => a + b, 0);
  eq(sum, 320, '十表合计 = 320');
});

test('[L7] 物品基础价值分 V_i 为正整数且自洽', () => {
  /* 手册 §5.3 L565:「基础价值分分别为 V_1…V_k」;V_i 参与 T_eff 幂次聚合。
     这不是手册给的某个具体数字,而是「V_i 必须能进 1.35 次幂」的语义约束。 */
  for (const it of ITEM_LIST) {
    ok(Number.isInteger(it.value) && it.value >= 0, `#${it.id} V_i 是非负整数(实际 ${it.value})`);
  }
  const bossRelic = ITEM_BY_ID.get(708);
  eq(bossRelic?.value, 250, 'Boss 遗物 V=250(手册 L565 举例)');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. 位压缩(手册 §2.3,L50~L59)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L54~L59] 六层位域掩码与手册逐位一致', () => {
  /* 手册 L54~L59 的「掩码 (Hex)」列 */
  eq(ELEV_MASK >>> 0, 0x00000003, 'ELEV 掩码 L54');
  eq(BASE_MASK >>> 0, 0x0000003c, 'BASE 掩码 L55');
  eq(FLOOR_MASK >>> 0, 0x00000fc0, 'FLOOR 掩码 L56');
  eq(WIRE_MASK >>> 0, 0x0000f000, 'WIRE 掩码 L57');
  eq(OBJ_MASK >>> 0, 0x0fff0000, 'OBJ 掩码 L58');
  eq(META_MASK >>> 0, 0xf0000000, 'META 掩码 L59');
});

test('[L54~L59] 位区间宽度 2/4/6/4/12/4', () => {
  /* 位宽 = 掩码最高位序 − 低位偏移。手册「位数」列:L54=2, L55=4, L56=6, L57=4, L58=12, L59=4 */
  const width = (mask: number, shift: number): number => 32 - Math.clz32(mask) - shift;
  eq(width(ELEV_MASK, ELEV_SHIFT), 2, 'ELEV 2 位');
  eq(width(BASE_MASK, BASE_SHIFT), 4, 'BASE 4 位');
  eq(width(FLOOR_MASK, FLOOR_SHIFT), 6, 'FLOOR 6 位');
  eq(width(WIRE_MASK, WIRE_SHIFT), 4, 'WIRE 4 位');
  eq(width(OBJ_MASK, OBJ_SHIFT), 12, 'OBJ 12 位');
  eq(width(META_MASK, META_SHIFT), 4, 'META 4 位');
});

test('[L58] OBJ 层上限 4095 种地面物体', () => {
  /* 手册 L58:「支持 4095 种地面物体」 */
  eq(OBJ_MASK >>> OBJ_SHIFT, 4095, 'OBJ 层最大值 = (1<<12)-1');
});

test('[L50] Chunk 为 16×16、每块 1KB', () => {
  /* 手册 L50:「每个 16×16 区块使用长度为 256 的 Uint32Array(1KB/Chunk)」 */
  eq(CHUNK_SIZE, 16, 'Chunk 边长');
  eq(CHUNK_BYTES, 1024, 'Chunk 字节数 = 256 × 4');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. 双频主循环与物理常数(手册 §2.1 L19~L20、§2.2 L33~L46)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L19] 高频物理帧 20Hz / 50ms', () => {
  /* 手册 L19:「Fast Tick = 20Hz,每 50ms 执行一次」 */
  eq(TICK_HZ, 20, '高频帧频率');
  near(DT, 0.05, 1e-12, '高频帧步长 = 1/20');
});

test('[L20] 低频演化帧 2Hz / 500ms', () => {
  /* 手册 L20:「Slow Tick = 2Hz,每 500ms 执行一次」 */
  eq(SLOW_TICK_HZ, 2, '低频帧频率');
});

test('[L44] 抛物线重力 −18.0 与投掷初速 8.5 / 6.0', () => {
  /* 手册 L44:「v_xy = d_aim × 8.5 格/秒,v_z = +6.0 格/秒,g = −18.0 格/秒²」 */
  near(GRAVITY, -18.0, 1e-12, '重力');
  near(THROW_SPEED_XY, 8.5, 1e-12, '水平投掷初速');
  near(THROW_SPEED_Z, 6.0, 1e-12, '垂直投掷初速');
});

test('[L43] 叠罗汉每层 0.85 格、底层减速 0.85^k、最多 4 层', () => {
  /* 手册 L43:「E_k.z = E_0.z + k × 0.85,底层移速 v_base × 0.85^k」
     手册 L35:「支持最多 4 层叠罗汉」 */
  near(CARRY_Z_STEP, 0.85, 1e-12, '每层高度');
  near(CARRY_SLOWDOWN, 0.85, 1e-12, '底层移速乘数');
  eq(CARRY_MAX_DEPTH, 4, '最大叠罗汉层数');
});

test('[L46] 完美接球窗口 0.3 ≤ z ≤ 1.4 且半径 0.8', () => {
  /* 手册 L46:「满足 0.3 ≤ z ≤ 1.4 且经过…半径 0.8 格内」 */
  near(CATCH_Z_MIN, 0.3, 1e-12, '接球低位');
  near(CATCH_Z_MAX, 1.4, 1e-12, '接球高位');
  near(CATCH_RADIUS, 0.8, 1e-12, '接球半径');
});

test('[L31~L32] 半径与质量配表:玩家 0.35/1.0、野怪 0.40/3.0、Boss 1.20/20.0', () => {
  /* 手册 L31:「碰撞半径:玩家=0.35,普通野生怪=0.40,群系Boss=1.20」
     手册 L32:「质量:玩家=1.0,重甲怪=3.0,Boss=20.0」 */
  near(RADIUS_PLAYER, 0.35, 1e-12, '玩家半径');
  near(RADIUS_WILD, 0.40, 1e-12, '野怪半径');
  near(RADIUS_BOSS, 1.20, 1e-12, 'Boss 半径');
  near(MASS_PLAYER, 1.0, 1e-12, '玩家质量');
  near(MASS_HEAVY, 3.0, 1e-12, '重甲怪质量');
  near(MASS_BOSS, 20.0, 1e-12, 'Boss 质量');
});

test('[L33] 刚体状态机 7 态,名称与手册逐字一致', () => {
  /* 手册 L33 的 state 联合类型 */
  const want = ['NORMAL', 'SLIPPING', 'STUNNED', 'BUBBLED', 'FROZEN', 'GHOST_BUBBLE', 'AFK_SHIELD'];
  eq(BODY_STATES.length, 7, '状态数');
  for (const s of want) ok((BODY_STATES as readonly string[]).includes(s), `含状态 ${s}`);
});

test('[L40] 缺省 μ 与裸地 μ 落在手册声明的区间 [0.40, 0.98]', () => {
  /* 手册 L40:「摩擦阻尼系数 μ ∈ [0.40, 0.98]」——
     这是手册对 μ 取值范围的声明。
     注意:**不能**拿它逐块校验全部地砖 —— 手册自己的 §3.5 表里 322 强粘蜂蜜减速毯
     写的就是 μ=0.35,低于 L40 的下界。这是手册内部矛盾(不是代码错),
     已在 docs/DATA-CONFORMANCE.md 记为「手册待澄清项」。
     本测试只校验手册未逐块列举的两个缺省值。 */
  ok(FLOOR_DEFAULT_MU >= 0.40 && FLOOR_DEFAULT_MU <= 0.98, `缺省 μ=${FLOOR_DEFAULT_MU}`);
  ok(BARE_GROUND_MU >= 0.40 && BARE_GROUND_MU <= 0.98, `裸地 μ=${BARE_GROUND_MU}`);
  ok(FLOOR_DEFAULT_MU > BARE_GROUND_MU, '裸地应比带地砖略滑');
});

test('[L216/L217/L223] 手册显式给出 μ 的三块地砖逐位一致', () => {
  /* 手册 L216:315 镜面极滑冰砖 μ=0.98
     手册 L217:316 紫泥减速沼泽砖 μ=0.40
     手册 L223:322 强粘蜂蜜减速毯 μ=0.35 —— 注意 0.35 **低于** L40 的 0.40 下界,
     这是手册自身的笔误/特例;代码忠实取 0.35。此处只断言「代码 = 手册原值」。 */
  near(floorMu(315), 0.98, 1e-12, '315 μ 冰砖');
  near(floorMu(316), 0.40, 1e-12, '316 μ 沼泽砖');
  near(floorMu(322), 0.35, 1e-12, '322 μ 蜂蜜毯');
  near(FLOOR_META.get(315)!.mu, 0.98, 1e-12, 'FLOOR_META 315');
  near(FLOOR_META.get(316)!.mu, 0.40, 1e-12, 'FLOOR_META 316');
  near(FLOOR_META.get(322)!.mu, 0.35, 1e-12, 'FLOOR_META 322');
});

test('[L218] 317 加速带推力 10 格/秒', () => {
  /* 手册 L218:「踩上瞬间沿箭头方向施加 10 格/秒推力」 */
  near(BELT_FORCE.get(317)!, 10.0, 1e-12, '317 推力');
});

test('[L178] 重物阈值 10.0 落在可举范围之外', () => {
  /* 手册未直接给 HEAVY_MASS_THRESHOLD;但 L32 给了质量梯度 1.0/3.0/20.0,
     语义约束是「普通重物(3.0)可举、Boss(20.0)不可举」。
     期望值 10.0 来自既有审计锚点(README/WS-02),此处固化以防回归。 */
  near(HEAVY_MASS_THRESHOLD, 10.0, 1e-12, '重物阈值');
  ok(MASS_HEAVY < HEAVY_MASS_THRESHOLD, '重甲怪 3.0 仍可举');
  ok(MASS_BOSS >= HEAVY_MASS_THRESHOLD, 'Boss 20.0 超出可举范围');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 4. 野生动物 24 种(手册 §4.2,L464~L487)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L460] 野生动物共 24 种', () => {
  /* 手册 L460:「八大群系 24 种野生动物生态…全表」 */
  eq(MOB_LIST.length, 24, '生物种数');
});

test('[L464~L487] 24 种生物的等级与 HP 逐条一致', () => {
  /* 手册表每行列「Lv.N / `HP`」,逐行行号 + 期望值 */
  const hb: [string, number, number, number][] = [
    ['mob_sheep', 1, 60, 464], ['mob_slime_green', 2, 90, 465], ['mob_boar', 4, 180, 466],
    ['mob_squirrel', 2, 50, 467], ['mob_beaver', 5, 220, 468], ['mob_crab_river', 6, 260, 469],
    ['mob_capybara', 5, 300, 470], ['mob_tanuki', 8, 320, 471],
    ['mob_samurai_bamboo', 10, 450, 472],
    ['mob_glow_frog', 8, 150, 473], ['mob_bat_sonic', 11, 380, 474],
    ['mob_beetle_crystal', 14, 750, 475],
    ['mob_chocobo', 10, 400, 476], ['mob_pangolin', 13, 600, 477], ['mob_scorpion', 15, 680, 478],
    ['mob_ginger_imp', 12, 250, 479], ['mob_pudding_mage', 16, 720, 480],
    ['mob_choco_golem', 18, 1100, 481],
    ['mob_sky_manta', 15, 500, 482], ['mob_harpy_harp', 19, 850, 483],
    ['mob_thunder_sprite', 21, 950, 484],
    ['mob_mimic_cog', 20, 900, 485], ['mob_lava_elem', 23, 1200, 486],
    ['mob_clock_knight', 25, 1800, 487],
  ];
  eq(hb.length, 24, '对照表覆盖 24 行');
  for (const [id, lv, hp, line] of hb) {
    const m = MOB_BY_ID.get(id);
    ok(m !== undefined, `${id} 存在(手册 L${line})`);
    eq(m!.level, lv, `${id} 等级(手册 L${line})`);
    eq(m!.hp, hp, `${id} HP(手册 L${line})`);
  }
});

test('[L466] 野猪:蓄力 1 秒 → 冲锋 6 格 → 撞墙自晕 3 秒', () => {
  /* 手册 L466:「原地刨蹄蓄力 1 秒,随后沿直线高速冲锋 6 格…自己撞晕 3 秒」 */
  near(BOAR_WINDUP_SEC, 1.0, 1e-12, '蓄力时长');
  eq(BOAR_CHARGE_TILES, 6, '冲锋距离');
  near(BOAR_SELF_STUN_SEC, 3.0, 1e-12, '撞墙自晕时长');
});

test('[L475] 紫晶重甲虫:正面免疫 80% 伤害', () => {
  /* 手册 L475:「正面甲壳免疫 80% 普通刀剑与弓箭伤害」 */
  near(BEETLE_FRONT_DR, 0.80, 1e-12, '正面免伤率');
});

test('[L479] 姜饼小人:10 秒逃逸计时', () => {
  /* 手册 L479:「10 秒内没抓到就会钻进糖果屋消失」 */
  near(GINGER_ESCAPE_SEC, 10.0, 1e-12, '逃逸计时');
});

test('[L476] 彩虹陆行鸟:喂 3 个黄金小麦驯服', () => {
  /* 手册 L476:「再喂 3 个 123 黄金小麦即可驯服」 */
  eq(CHOCOBO_TAME_WHEAT, 3, '驯服所需小麦数');
});

test('[L464~L487] 手册明示数量的掉落物逐条一致', () => {
  /* 手册掉落列里写了「×N」的项,逐条核对 */
  const hb: [string, number, number, number][] = [
    ['mob_sheep', 119, 2, 464], ['mob_sheep', 701, 1, 464],
    ['mob_boar', 701, 2, 466], ['mob_boar', 702, 2, 466],
    ['mob_beaver', 703, 2, 468], ['mob_beaver', 151, 3, 468],
    ['mob_samurai_bamboo', 103, 4, 472],
    ['mob_beetle_crystal', 116, 3, 475], ['mob_beetle_crystal', 114, 2, 475],
    ['mob_pangolin', 702, 3, 477],
    ['mob_scorpion', 108, 4, 478],
    ['mob_pudding_mage', 162, 3, 480],
    ['mob_choco_golem', 105, 5, 481],
    ['mob_sky_manta', 119, 4, 482],
    ['mob_thunder_sprite', 117, 2, 484], ['mob_thunder_sprite', 159, 5, 484],
    ['mob_mimic_cog', 158, 6, 485], ['mob_mimic_cog', 115, 3, 485],
    ['mob_lava_elem', 710, 2, 486], ['mob_lava_elem', 110, 3, 486],
    ['mob_clock_knight', 114, 4, 487], ['mob_clock_knight', 158, 8, 487],
  ];
  for (const [id, item, qty, line] of hb) {
    const m = MOB_BY_ID.get(id);
    ok(m !== undefined, `${id} 存在`);
    eq(m!.drops[item], qty, `${id} 掉 ${item} 数量(手册 L${line})`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * 5. 世界 Boss 8 个(手册 §4.3,L491~L502)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L489] 世界 Boss 共 8 个', () => {
  /* 手册 L489:「八大群系野生世界 Boss…」 */
  eq(BOSS_LIST.length, 8, 'Boss 个数');
});

test('[L495~L502] 8 个 Boss 的基础 HP 与推荐等级逐条一致', () => {
  /* 手册表每行列「Lv.N / `HP: N`」 */
  const hb: [number, number, number][] = [
    [5, 2500, 495], [10, 4800, 496], [14, 7500, 497], [18, 11000, 498],
    [21, 15000, 499], [24, 20000, 500], [27, 26000, 501], [30, 38000, 502],
  ];
  for (let i = 0; i < 8; i += 1) {
    const b = BOSS_LIST[i];
    const [lv, hp, line] = hb[i];
    eq(b.level, lv, `${b.id} 推荐等级(手册 L${line})`);
    eq(b.baseHp, hp, `${b.id} 基础 HP(手册 L${line})`);
  }
});

test('[L491] Boss 血量人数缩放 HP(N) = HP_base × (1 + 0.65(N−1))', () => {
  /* 手册 L491:「HP(N) = HP_Base × (1 + 0.65(N-1))」 */
  eq(bossScaledHp(2500, 1), 2500, 'N=1 不缩放');
  eq(bossScaledHp(2500, 4), 7375, 'N=4 → 2500×2.95 = 7375');
  eq(bossScaledHp(38000, 4), 112100, '终 Boss N=4');
  eq(bossScaledHp(2500, 0), 2500, 'N=0 视为 1(防御性钳制)');
});

test('[L432~L439] 召唤祭品 ID 连续 734~741 且顺序与群系一致', () => {
  /* 手册 §3.10 L432~L439:734 草甸 / 735 河谷 / 736 绯樱 / 737 溶洞 /
     738 绿洲 / 739 甜点 / 740 云海 / 741 遗迹(与 §4.3 Boss 行序一致) */
  for (let k = 0; k < 8; k += 1) {
    eq(BOSS_LIST[k].summonItem, 734 + k, `${BOSS_LIST[k].id} 祭品 ID(手册 L${432 + k})`);
  }
  eq(BOSS_BY_ID.get('boss_jelly_king')!.summonItem, 734, '果冻王祭品 734');
  eq(BOSS_BY_ID.get('boss_chronos_colossus')!.summonItem, 741, '克洛诺斯祭品 741');
});

test('[L495/L502] 阶段数:6 个 Boss 两阶段、果冻王与克洛诺斯三阶段', () => {
  /* 手册 L495 果冻王有 P1/P2/P3 三个阶段标记(3 阶段)
     手册 L502 克洛诺斯有 P1/P2/P3 三个阶段标记(3 阶段)
     其余 6 行只有 P1/P2 两个阶段标记(2 阶段) */
  eq(BOSS_LIST.length, 8, 'Boss 数');
  eq(BOSS_BY_ID.get('boss_jelly_king')!.phases.length, 3, '果冻王 3 阶段(手册 L495)');
  eq(BOSS_BY_ID.get('boss_chronos_colossus')!.phases.length, 3, '克洛诺斯 3 阶段(手册 L502)');
  const twoPhase = BOSS_LIST.filter((b) => b.id !== 'boss_jelly_king' && b.id !== 'boss_chronos_colossus');
  eq(twoPhase.length, 6, '其余 6 个 Boss');
  for (const b of twoPhase) eq(b.phases.length, 2, `${b.id} 2 阶段`);
});

test('[L495~L502] 手册点名的必掉战利品全部在列', () => {
  /* 手册每行的「必掉史诗战利品」列里带 ID 的项 */
  const hb: [string, number[], number][] = [
    ['boss_jelly_king', [704, 719, 727], 495],
    ['boss_beaver_mecha', [703], 496],
    ['boss_fox_kitsune', [705, 720], 497],
    ['boss_crab_kraken', [706, 721, 728], 498],
    ['boss_scorpion_pharaoh', [707, 722], 499],
    ['boss_sky_whale', [117, 718], 501],
    ['boss_chronos_colossus', [708, 723], 502],
  ];
  for (const [id, items, line] of hb) {
    const b = BOSS_BY_ID.get(id);
    ok(b !== undefined, `${id} 存在`);
    for (const it of items) {
      ok(b!.loot.includes(it), `${id} loot 含 #${it}(手册 L${line})`);
    }
  }
});

test('[L495~L502] Boss 经验值与手册逐条一致', () => {
  /* 手册每行末尾的 `N EXP` */
  const hb: [string, number, number][] = [
    ['boss_jelly_king', 800, 495], ['boss_beaver_mecha', 1600, 496],
    ['boss_fox_kitsune', 2800, 497], ['boss_crab_kraken', 4200, 498],
    ['boss_scorpion_pharaoh', 6000, 499], ['boss_ginger_troll', 8500, 500],
    ['boss_sky_whale', 12000, 501], ['boss_chronos_colossus', 25000, 502],
  ];
  for (const [id, exp, line] of hb) {
    eq(BOSS_BY_ID.get(id)!.exp, exp, `${id} EXP(手册 L${line})`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * 6. 成长曲线 Lv.1~30(手册 §4.1,L450~L458)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L451] 满级 30 级', () => {
  /* 手册 L451:「角色从 Lv.1 起步,满级 Lv.30」 */
  eq(MAX_LEVEL, 30, '满级');
});

test('[L452] 升级经验 EXP_next(L) = 50L² + 50L', () => {
  /* 手册 L452 的公式,逐点手算期望值 */
  eq(expToNext(1), 100, 'L=1 → 50+50');
  eq(expToNext(2), 300, 'L=2 → 200+100');
  eq(expToNext(5), 1500, 'L=5 → 1250+250');
  eq(expToNext(10), 5500, 'L=10 → 5000+500');
  eq(expToNext(20), 21000, 'L=20 → 20000+1000');
  eq(expToNext(29), 43500, 'L=29 → 42050+1450');
  eq(expToNext(30), 46500, 'L=30 → 45000+1500');
  /* 任意 Lv 都满足公式(抽查而非穷举,避免与实现同源) */
  for (const l of [3, 7, 13, 17, 23, 27]) {
    eq(expToNext(l), 50 * l * l + 50 * l, `L=${l} 符合公式`);
  }
});

test('[L453] 初始属性:HP 100、基础攻击 10、移速 4.5 格/秒', () => {
  /* 手册 L453:「HP = 100,基础攻击 = 10,移动速度 = 4.5 格/秒」 */
  eq(BASE_HP, 100, '初始 HP');
  eq(BASE_ATK, 10, '初始基础攻击');
  near(BASE_MOVE_SPEED, 4.5, 1e-12, '初始移速');
  eq(statsAtLevel(1).maxHp, 100, 'Lv.1 最大 HP');
});

test('[L453] 每级成长:最大 HP +15、伤害 +3%、负重 +1', () => {
  /* 手册 L453:「每升 1 级自动获得 最大 HP +15、全武器基础伤害 +3%、背包负重格 +1」 */
  const s2 = statsAtLevel(2);
  eq(s2.maxHp, 115, 'Lv.2 HP = 100+15');
  near(s2.dmgMul, 1.03, 1e-12, 'Lv.2 伤害倍率 = 1+3%');
  eq(s2.carrySlots, 9, 'Lv.2 负重 = 基准+1');
  const s30 = statsAtLevel(30);
  eq(s30.maxHp, 100 + 15 * 29, 'Lv.30 HP = 100+15×29');
  near(s30.dmgMul, 1 + 0.03 * 29, 1e-12, 'Lv.30 伤害倍率');
  eq(s30.carrySlots - statsAtLevel(1).carrySlots, 29, 'Lv.30 比 Lv.1 多 29 格负重');
});

test('[L453] 每 5 级解锁 1 个被动天赋', () => {
  /* 手册 L453:「每升 5 级解锁 1 个被动天赋」 */
  eq(TALENT_LEVELS.join(','), '5,10,15,20,25,30', '天赋解锁等级');
});

test('[L455] 全队经验共享半径 24 格;≥3 人额外 +25%', () => {
  /* 手册 L455:「距离该怪物 24 格内的所有玩家…均获得 100% 完整经验值!
     若同屏参战人数 ≥ 3 人,全员额外享受 +25% 欢聚狩猎经验加成」 */
  eq(SHARE_EXP_RADIUS, 24, '经验共享半径');
  eq(PARTY_BONUS_THRESHOLD, 3, '欢聚加成人数门槛');
  near(PARTY_BONUS, 0.25, 1e-12, '欢聚经验加成');
});

test('[L456] 打盹玩家获得 30% 梦境见习经验', () => {
  /* 手册 L456:「打盹玩家也会自动获得 30% 的梦境见习经验」 */
  near(AFK_EXP_RATIO, 0.3, 1e-12, '打盹经验比例');
});

test('[L458] 幽灵泡泡救援:1 秒内半血复活', () => {
  /* 手册 L458:「即可在 1 秒内将其半血救活继续战斗」 */
  near(REVIVE_TIME, 1.0, 1e-12, '救援耗时');
  near(REVIVE_HP_RATIO, 0.5, 1e-12, '复活血量比例');
});

test('[L431] 733 羽毛笔:6 格远程满血复活 + 3 秒无敌', () => {
  /* 手册 L431:「哪怕隔着 6 格远也能瞬间将其满血复活并赋予 3 秒无敌」 */
  eq(FEATHER_RANGE, 6, '羽毛笔射程');
  near(FEATHER_INVULN, 3.0, 1e-12, '无敌时长');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 7. 料理 601~615(手册 §3.9,L364~L378)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L360] 料理 601~615 共 15 项', () => {
  /* 手册 L360:ID 601~630 共 30 项;其中 601~615 是料理,616~630 是时装头饰 */
  eq(FOODS.length, 15, '料理条目数');
  const byId = new Map(FOODS.map((f) => [f.id, f]));
  for (let id = 601; id <= 615; id += 1) ok(byId.has(id), `#${id} 存在`);
});

test('[L364] 601 甜莓果茶:立即恢复 40 HP、移速 +15%、持续 10 分钟', () => {
  /* 手册 L364:「立即恢复 40 HP,移动速度 +15%,持续 10 分钟」 */
  const f = FOODS.find((x) => x.id === 601)!;
  eq(f.instantHealHp, 40, '立即恢复量');
  eq(f.durationSec, 600, '持续时间 = 10×60');
  near(f.statMods.moveMul!, 1.15, 1e-12, '移速倍率');
});

test('[L365] 602 厚吐司:最大生命 +30、采集 +20%、持续 10 分钟', () => {
  /* 手册 L365:「最大生命值 +30,伐木与采矿速度 +20%,持续 10 分钟」 */
  const f = FOODS.find((x) => x.id === 602)!;
  eq(f.statMods.hpFlat, 30, 'HP 上限加成');
  near(f.statMods.gatherMul!, 1.2, 1e-12, '采集倍率');
  eq(f.durationSec, 600, '持续时间');
});

test('[L366] 603 果酱派:暴击率 +15%', () => {
  /* 手册 L366:「暴击率 +15%」 */
  near(FOODS.find((x) => x.id === 603)!.statMods.critRate!, 0.15, 1e-12, '暴击率');
});

test('[L367] 604 蘑菇汤:跳跃高度 +50%', () => {
  /* 手册 L367:「跳跃高度 +50% 且免疫跌落眩晕」 */
  near(FOODS.find((x) => x.id === 604)!.statMods.jumpMul!, 1.5, 1e-12, '跳跃倍率');
});

test('[L368] 605 海鲜烩:近战攻击力 +25%、投掷距离 +3 格', () => {
  /* 手册 L368:「近战攻击力 +25%…投掷距离 +3 格」 */
  const f = FOODS.find((x) => x.id === 605)!;
  near(f.statMods.atkMul!, 1.25, 1e-12, '攻击倍率');
  eq(f.flags.throwRangeBonus, 3, '投掷距离加成');
  eq(f.flags.meleeOnly, true, '仅近战生效');
});

test('[L369] 606 烤肉排:附 15 点火焰灼烧、持续 15 分钟、免疫冰冻', () => {
  /* 手册 L369:「每次武器攻击附带 15 点火焰灼烧伤害,且免疫冰冻状态,持续 15 分钟」 */
  const f = FOODS.find((x) => x.id === 606)!;
  eq(f.flags.fireDotPerHit, 15, '灼烧伤害');
  eq(f.durationSec, 900, '持续时间 = 15×60');
  eq(f.flags.freezeImmune, true, '免疫冰冻');
});

test('[L371] 608 小肥鸡浓汤:全房变形 60 秒', () => {
  /* 手册 L371:「全房间喝汤的人集体变成圆滚滚的小肥鸡 60 秒」 */
  const f = FOODS.find((x) => x.id === 608)!;
  eq(f.durationSec, 60, '持续时间');
  eq(f.branch, 'PRANK', '属于整蛊锅');
});

test('[L372] 609 漂浮饮:重力降低 70%', () => {
  /* 手册 L372:「重力降低 70%」→ 重力倍率 = 1 − 0.70 = 0.30 */
  near(FOODS.find((x) => x.id === 609)!.statMods.gravityMul!, 0.30, 1e-12, '重力倍率');
});

test('[L373] 610 溜冰奶昔:脚底 μ = 0.96', () => {
  /* 手册 L373:「脚底自带滑冰效果(μ=0.96)」 */
  near(FOODS.find((x) => x.id === 610)!.statMods.muOverride!, 0.96, 1e-12, 'μ 覆盖值');
});

test('[L375] 612 净化饮:立即恢复 80 HP 并解除一切负面状态', () => {
  /* 手册 L375:「立即恢复 80 HP 并解除滑倒、中毒、变身、灼烧等一切负面/整蛊状态」 */
  const f = FOODS.find((x) => x.id === 612)!;
  eq(f.instantHealHp, 80, '立即恢复量');
  eq(f.flags.cleanse, true, '标记为净化');
});

test('[L376] 613 奶油蛋糕:8 人分食、经验 +30%、持续 20 分钟', () => {
  /* 手册 L376:「摆在地上供 8 人分食,全队获得 20 分钟经验获取 +30% 增益」 */
  const f = FOODS.find((x) => x.id === 613)!;
  eq(f.flags.shareCount, 8, '可分食人数');
  near(f.statMods.expMul!, 1.3, 1e-12, '经验倍率');
  eq(f.durationSec, 1200, '持续时间 = 20×60');
});

test('[L378] 615 彩虹糖:森灵效率翻倍、持续 30 分钟', () => {
  /* 手册 L378:「该森灵在接下来 30 分钟内收菜与协助捡战利品效率翻倍」 */
  const f = FOODS.find((x) => x.id === 615)!;
  near(f.flags.spriteEfficiencyMul!, 2.0, 1e-12, '森灵效率倍率');
  eq(f.durationSec, 1800, '持续时间 = 30×60');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 8. 武器与护甲(手册 §3.10,L409~L426)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L409~L421] 13 件武器的 ATK 与手册逐条一致', () => {
  /* 手册每行写 `ATK +N`(719 号另写「击退 +200%」) */
  const hb: [number, number, number][] = [
    [711, 12, 409], [712, 28, 410], [713, 48, 411], [714, 38, 412],
    [715, 18, 413], [716, 42, 414], [717, 20, 415], [718, 52, 416],
    [719, 40, 417], [720, 46, 418], [721, 45, 419], [722, 50, 420], [723, 65, 421],
  ];
  for (const [id, atk, line] of hb) {
    const w = WEAPON_BY_ID.get(id);
    ok(w !== undefined, `#${id} 武器存在`);
    eq(w!.atk, atk, `#${id} ATK(手册 L${line})`);
  }
});

test('[L419] 721 紫晶盾锤额外 DEF +35', () => {
  /* 手册 L419:「ATK +45, DEF +35」 */
  eq(WEAPON_BY_ID.get(721)!.def, 35, 'DEF');
});

test('[L422~L426] 5 件护甲的 HP/DEF 与手册逐条一致', () => {
  /* 手册每行写 `HP上限 +N, DEF +N` */
  const hb: [number, number, number, number][] = [
    [724, 40, 8, 422], [725, 100, 22, 423], [726, 60, 14, 424],
    [727, 120, 18, 425], [728, 160, 32, 426],
  ];
  for (const [id, hp, def, line] of hb) {
    const a = ARMORS.find((x) => x.id === id);
    ok(a !== undefined, `#${id} 护甲存在`);
    eq(a!.hpBonus, hp, `#${id} HP 上限加成(手册 L${line})`);
    eq(a!.def, def, `#${id} DEF(手册 L${line})`);
  }
});

test('[L422] 724 软皮甲:闪避率 +10%', () => {
  /* 手册 L422:「闪避率 +10%」 */
  near(ARMORS.find((x) => x.id === 724)!.dodgeRate, 0.10, 1e-12, '闪避率');
});

test('[L424] 726 魔导袍:技能冷却 −25%', () => {
  /* 手册 L424:「技能冷却 -25%」→ cdMul = 1 − 0.25 = 0.75 */
  near(ARMORS.find((x) => x.id === 726)!.cdMul, 0.75, 1e-12, '冷却倍率');
});

test('[L426] 728 反伤甲:减免 30%、反伤 150%', () => {
  /* 手册 L426:「减免 30% 伤害,并将所受伤害的 150% 化作紫晶尖刺反伤」 */
  const a = ARMORS.find((x) => x.id === 728)!;
  near(a.dmgReduce, 0.30, 1e-12, '减伤比例');
  near(a.reflectMul, 1.5, 1e-12, '反伤倍率');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 9. 整蛊玩具与和平盾(手册 §3.4,L158~L196,L156)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L158] 整蛊玩具 221~255 共 35 项,ID 连续', () => {
  /* 手册 L158:「(ID 221 ~ 255,共 35 项)」 */
  eq(PRANK_TOYS.length, 35, '玩具条目数');
  for (let k = 0; k < 35; k += 1) eq(PRANK_TOYS[k].id, 221 + k, `第 ${k + 1} 项 ID`);
});

test('[L156] 218 和平盾 100% 免疫队友举起、大锤击退与香蕉皮', () => {
  /* 手册 L156:「开启后头顶显示黄色安全帽,100% 免疫队友举起、大锤击退与香蕉皮」 */
  ok(isImmuneToAllyPrank(true, 221), '免疫 221 举起');
  ok(isImmuneToAllyPrank(true, 222), '免疫 222 大锤击退');
  ok(isImmuneToAllyPrank(true, 225), '免疫 225 香蕉皮');
  eq(isImmuneToAllyPrank(false, 222), false, '关闭后不免疫');
  eq(SAFE_SHIELD_ITEM_ID, 218, '和平盾自身 ID');
});

test('[L162~L196] 玩具各项数值与手册正文逐条一致', () => {
  /* 手册 §3.4 表中正文里带具体数字的项 —— 这些是**手抄易错**的一类 */
  const byId = new Map(PRANK_TOYS.map((t) => [t.id, t as unknown as Record<string, any>]));
  const want: [number, string, number, number][] = [
    [222, 'impulse', 8, 163], [223, 'radius', 4, 164],
    [225, 'allyEffect.moveTiles', 5, 166], [229, 'morphSec', 10, 170],
    [235, 'enemyEffect.moveTiles', 3, 176], [238, 'allyEffect.moveTiles', 4, 179],
    [242, 'radius', 8, 183], [243, 'radius', 3, 184],
    [243, 'stunSec', 1.5, 184], [246, 'radius', 6, 187],
  ];
  const dig = (o: Record<string, any>, path: string): unknown =>
    path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);
  for (const [id, path, v, line] of want) {
    near(dig(byId.get(id)!, path) as number, v, 1e-12, `#${id} ${path}(手册 L${line})`);
  }
  /* 具名常量 */
  near(BANANA_SLIDE_TILES, 5, 1e-12, '225 打滑距离(手册 L166)');
  near(BANANA_SLIDE_STUN_SEC, 1.2, 1e-12, '225 眩晕(手册 L166)');
  eq(BUBBLE_HITS_TO_TRAP, 3, '227 困人发射数(手册 L168)');
  near(BOMB_FUSE_SEC, 3, 1e-12, '228 引信(手册 L169)');
  eq(BOMB_ENEMY_DAMAGE, 120, '228 破甲伤害(手册 L169)');
  near(SHRINK_SCALE, 0.3, 1e-12, '230 缩小倍率(手册 L171)');
  near(GIANT_SCALE, 2.0, 1e-12, '231 放大倍率(手册 L172)');
  near(HONEY_SLOW_RATIO, 0.70, 1e-12, '232 减速比例(手册 L173)');
  near(SNOWBALL_FREEZE_SEC, 3, 1e-12, '233 冰冻时长(手册 L174)');
  near(TUG_IMPULSE, 10, 1e-12, '241 拔河冲量(手册 L182)');
});

test('[L177/L185] 237/245 配方中的「任意染料」被具体化为 166', () => {
  /* 手册 L177「陶瓷空药水瓶×1 + 任意染料×1」
     手册 L185「翠玉青竹×1 + 爆裂火椒×1 + 染料×1」
     代码把「任意/未指定染料」具体化为 #166 绯红植物染料。
     这不是数字漂移,而是**手册留白被代码填实** —— 属需设计确认项,
     故只固化「除染料外其余材料完全一致」这部分。 */
  const r237 = ITEM_BY_ID.get(237)!.recipe!;
  eq(Object.keys(r237).sort().join(','), '165,166', '237 材料集合');
  eq(r237[165], 1, '237 陶瓷空药水瓶');
  const r245 = ITEM_BY_ID.get(245)!.recipe!;
  eq(Object.keys(r245).sort().join(','), '103,126,166', '245 材料集合');
  eq(r245[103], 1, '245 翠玉青竹');
  eq(r245[126], 1, '245 爆裂火椒');
});

test('[L162~L196] 31 项玩具配方与手册逐条完全一致', () => {
  /* 手册 §3.4 第 5 列「合成配方」。这是一张 35 行的对照表,
     手抄极易**串行**(把 224 的配方写到 225 行),而 recipe 是纯数据,
     串了不会有别的测试变红 —— 所以在这里逐条固化。
     本表由手册材料**名称**反查 ID 生成(权威来源),不是从代码 recipe 抄的。
     另 4 项:#225 手册为「吃掉滑溜香蕉获得」无配方;
     #237/#245 手册写「任意染料」留白;#244 的染料手册已指定为「翡翠森林染料」。 */
  const hb: [number, Record<number, number>, number][] = [
    [221, { 160: 2, 161: 2 }, 162], [222, { 161: 2, 162: 2 }, 163],
    [223, { 124: 2, 158: 2 }, 164], [224, { 156: 2, 160: 3 }, 165],
    [226, { 160: 1, 161: 2 }, 167], [227, { 103: 2, 162: 1 }, 168],
    [228, { 107: 1, 126: 2 }, 169], [229, { 103: 1, 127: 1 }, 170],
    [230, { 116: 1, 165: 1 }, 171], [231, { 124: 2, 165: 1 }, 172],
    [232, { 107: 1, 128: 2 }, 173], [233, { 129: 2, 130: 1 }, 174],
    [234, { 124: 2, 151: 2 }, 175], [235, { 151: 4, 223: 1 }, 176],
    [236, { 126: 1, 162: 2 }, 177], [238, { 103: 3, 160: 1 }, 179],
    [239, { 103: 2, 118: 3 }, 180], [240, { 152: 2 }, 181],
    [241, { 160: 6 }, 182], [242, { 116: 1, 155: 2 }, 183],
    [243, { 156: 3 }, 184], [244, { 162: 3, 168: 1 }, 185],
    [246, { 120: 2, 152: 2 }, 187], [247, { 151: 2, 161: 2 }, 188],
    [248, { 104: 2, 156: 1 }, 189], [249, { 101: 2, 160: 2 }, 190],
    [250, { 103: 3 }, 191], [251, { 155: 3 }, 192],
    [252, { 120: 3, 152: 4 }, 193], [253, { 156: 2 }, 194],
    [254, { 157: 2, 159: 4 }, 195], [255, { 155: 1, 160: 1 }, 196],
  ];
  eq(hb.length, 32, '对照表条数(35 − 225 无配方 − 237/245 染料留白 = 32)');
  for (const [id, recipe, line] of hb) {
    eq(ITEM_BY_ID.get(id)!.recipe, recipe, `#${id} 配方(手册 L${line})`);
  }
  /* 225 无合成配方,靠「吃掉滑溜香蕉」获得 */
  eq(ITEM_BY_ID.get(225)!.recipe, undefined, '225 无合成配方(手册 L166)');
});

test('[L156] 218 和平盾对全部 35 项队友整蛊生效(手册的超集)', () => {
  /* 手册只点名 3 项,代码泛化到全部队友侧整蛊 —— 这是**扩展**而非漂移。
     若哪天变成「只挡点名 3 项」,本条不会红(仍是超集);
     但若漏掉任何一项,本条即红。 */
  for (const t of PRANK_TOYS) {
    ok(isImmuneToAllyPrank(true, t.id), `免疫 ${t.id}`);
  }
});

test('[L156] 218 和平盾不挡 Boss/环境伤害', () => {
  /* 手册未明说;但「和平盾」语义是「免疫队友整蛊」,
     若连 Boss 也挡就成了无敌挂,会破坏 §4.3 的 Boss 战平衡。 */
  for (const src of ['BOSS_SKILL', 'BOSS_MELEE', 'WILD_ATTACK', 'LAVA_BURN', 'FALL_DAMAGE']) {
    eq(isImmuneToHostile(true, src), false, `不免疫 ${src}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * 10. 电路件 401~440(手册 §3.7,L273~L316)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L273] 电路与物流组件 401~440 共 40 项', () => {
  /* 手册 L273:「(ID 401 ~ 440,共 40 项)」 */
  eq(COMPONENT_SPECS.length, 40, '组件条目数');
});

test('[L280] 404 瞬时脉冲按钮:输出 0.5 秒高电平', () => {
  /* 手册 L280:「按下后输出 0.5 秒高电平随后自动弹回」 */
  near(PULSE_BUTTON_SECONDS, 0.5, 1e-12, '脉冲时长');
});

test('[L289] 413 延时继电器四档 0.2 / 0.5 / 1.0 / 2.0 秒', () => {
  /* 手册 L289:「点击可切换延迟 0.2s / 0.5s / 1.0s / 2.0s 后向下一节点传递信号」 */
  eq(RELAY_DELAY_SECONDS.length, 4, '档位数');
  near(RELAY_DELAY_SECONDS[0], 0.2, 1e-12, '第 1 档');
  near(RELAY_DELAY_SECONDS[1], 0.5, 1e-12, '第 2 档');
  near(RELAY_DELAY_SECONDS[2], 1.0, 1e-12, '第 3 档');
  near(RELAY_DELAY_SECONDS[3], 2.0, 1e-12, '第 4 档');
});

test('[L293] 417 翻页计数器量程 0~99', () => {
  /* 手册 L293:「每次收到脉冲数字 +1」,标题为「0-99 翻页计数器」 */
  eq(COUNTER_MOD, 100, '模数 = 100(即 0~99)');
});

test('[L294] 418 无线信号发射塔频道 1~8', () => {
  /* 手册 L294:「广播至同房间相同频道(1~8频道)的接收器」 */
  eq(CHANNEL_MIN, 1, '频道下限');
  eq(CHANNEL_MAX, 8, '频道上限');
});

test('[L304] 428 定向物流传送带 1 格/秒', () => {
  /* 手册 L304:「每秒将掉落在上面的战利品、矿石或站在上面的怪物平稳运往下一格」 */
  near(CONVEYOR_CELLS_PER_TICK * LOGISTICS_HZ, 1.0, 1e-12, '传送速度');
});

test('[L307] 431 自动采矿钻头机 10 秒/块', () => {
  /* 手册 L307:「每 10 秒自动产出一块对应矿石」 */
  near(DRILL_PERIOD_SECONDS, 10, 1e-12, '产出周期');
});

test('[L310] 434 金皇冠底座:3 分钟赛制', () => {
  /* 手册 L310:「开启 3 分钟"抢皇冠大逃杀"」 */
  near(COMPONENT_SPECS.find((c) => c.id === 434)!.params.roundSeconds, 180, 1e-12, '赛制时长 = 3×60');
});

/* ─────────────────────────────────────────────────────────────────────
 * 以下五项的**几何/枚举数量**参数在代码里没有承载字段:
 *
 *   410 占地 3×1        → params 只有 { team }
 *   423 横杆长 3 格      → params 为 {}
 *   426 浇湿 5×5        → params 为 {}
 *   435 四队归属         → params 只有 { team }(单实例队伍号,不是队数上限)
 *   419 32 音高 / 420 16 色 → params 只有当前索引(pitch/colorIndex),不是档数
 *   412 播报前三名       → params 为 {}
 *
 * 代码把这些常量写死在系统层(几何由方块占位决定、档数由 UI 决定),
 * 因此**没有可比对的代码值**。按本次审计的判据,它们属于「无法判断」,
 * 不写入本门禁 —— 否则一旦系统层补上这些字段,本条会毫无理由地变红。
 * 详见 docs/DATA-CONFORMANCE.md 的「未落地参数」一节。
 * ───────────────────────────────────────────────────────────────────── */

test('[L310] 410/423/426/435/412 的参数键集合未意外"长胖"', () => {
  /* 反向保护:这五项当前**只**承载运行期状态(队伍号、索引等),
     不含几何尺寸。若有人新增了 footprintW / armLength / radius / teamCount
     之类的几何键,应当同时更新本测试与文档,而不是让它们静默生效 ——
     静默生效的几何常量会和手册数值脱钩且无人发现。 */
  const expectedKeys: [number, string[]][] = [
    [410, ['team']],
    [412, []],
    [419, ['pitch', 'timbre']],
    [420, ['colorIndex']],
    [423, []],
    [426, []],
    [435, ['team']],
  ];
  for (const [id, keys] of expectedKeys) {
    const s = COMPONENT_SPECS.find((c) => c.id === id)!;
    eq(Object.keys(s.params).sort().join(','), keys.slice().sort().join(','), `#${id} params 键`);
  }
});

test('[L301] 425 自动泡泡连弩炮台:索敌半径 7 格', () => {
  /* 手册 L301:「自动瞄准半径 7 格内的敌对野生动物」 */
  eq(COMPONENT_SPECS.find((c) => c.id === 425)!.params.range, 7, '索敌半径');
});

test('[L298] 422 万向弹射弹簧垫:抛射 5 格', () => {
  /* 手册 L298:「向设定方向抛射 5 格远」 */
  eq(COMPONENT_SPECS.find((c) => c.id === 422)!.params.range, 5, '抛射距离');
});

test('[L313] 437 蒸汽小火车:碾压 150 点伤害', () => {
  /* 手册 L313:「可直接造成 150 点碾压击飞伤害」 */
  eq(COMPONENT_SPECS.find((c) => c.id === 437)!.params.crushDamage, 150, '碾压伤害');
});

test('[L278] 402 双人重物压力板:需 2 名玩家同时站立', () => {
  /* 手册 L278:「必须 2 名以上玩家同时站立」 */
  eq(COMPONENT_SPECS.find((c) => c.id === 402)!.params.requiredWeight, 2, '所需人数');
});

/* 419 音高 / 420 颜色档数:见上文「不可判断」说明。 */

test('[L316] 440 八人云海探险飞艇:载客 8 人', () => {
  /* 手册 L316:「支持最多 8 名玩家同时登船」 */
  eq(COMPONENT_SPECS.find((c) => c.id === 440)!.params.seats, 8, '载客上限');
});

/* 419 32 音高 / 420 16 色:见上文「不可判断」说明 —— 代码只存当前索引,不存档数。 */

test('[L310] 434 金皇冠底座:3 分钟赛制', () => {
  /* 手册 L310:「开启 3 分钟"抢皇冠大逃杀"」 */
  near(COMPONENT_SPECS.find((c) => c.id === 434)!.params.roundSeconds, 180, 1e-12, '赛制时长 = 3×60');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 11. 炼金属性算法(手册 §5.3,L565~L573)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L566] T_eff 幂次聚合:指数 1.35、多材料系数 0.12', () => {
  /* 手册 L566 的公式 */
  near(AGG_EXPONENT, 1.35, 1e-12, '幂指数');
  near(K_BONUS_RATE, 0.12, 1e-12, '多材料加成系数');
});

test('[L568] Q 公式:ε 截断区间 [0.80, 1.25]、β_dew = 0.15', () => {
  /* 手册 L568:「β_dew = 0.15…ε ~ N(1.0, 0.12²) ∈ [0.80, 1.25]」 */
  near(EPSILON_MIN, 0.80, 1e-12, 'ε 下界');
  near(EPSILON_MAX, 1.25, 1e-12, 'ε 上界');
  near(BETA_DEW, 0.15, 1e-12, '露水催化 β');
});

test('[L568] 每级专精 +2% 品质加成', () => {
  /* 手册 L568:「(1 + 0.02 × Lv_prof + β_dew)」 */
  near(PROF_RATE_PER_LEVEL, 0.02, 1e-12, '每级加成');
});

test('[L570~L573] 四档稀有度阈值 1.00 / 1.25 / 1.55', () => {
  /* 手册 L570~L573:「Q < 1.00 凡品 / 1.00 ≤ Q < 1.25 奇巧 /
     1.25 ≤ Q < 1.55 秘宝 / Q ≥ 1.55 神来之笔」 */
  eq(RARITY_THRESHOLDS.length, 3, '阈值个数');
  near(RARITY_THRESHOLDS[0], 1.00, 1e-12, '凡品/奇巧 分界');
  near(RARITY_THRESHOLDS[1], 1.25, 1e-12, '奇巧/秘宝 分界');
  near(RARITY_THRESHOLDS[2], 1.55, 1e-12, '秘宝/神笔 分界');
});

test('[L570~L573] 四档词条数 1 / 2 / 3 / 4', () => {
  /* 手册 L570~L573:「赋予 1 条基础词条 / 2 条词条 / 3 条词条 / 4 条词条」 */
  eq(RARITY_LABEL[0].affixes, 1, '凡品 1 条');
  eq(RARITY_LABEL[1].affixes, 2, '奇巧 2 条');
  eq(RARITY_LABEL[2].affixes, 3, '秘宝 3 条');
  eq(RARITY_LABEL[3].affixes, 4, '神来之笔 4 条');
});

test('[L570~L573] 四档档名与配色与手册一致', () => {
  /* 手册 L570:「【凡品·呆萌造物(白色)】」L571:「【奇巧·脑洞精品(翠绿)】」
     L572:「【秘宝·大师奇物(星蓝)】」L573:「【神来之笔·传世孤品(曜金)】」 */
  eq(RARITY_LABEL[0].name, '凡品·呆萌造物', 'S0 名');
  eq(RARITY_LABEL[0].color, '白色', 'S0 色');
  eq(RARITY_LABEL[1].name, '奇巧·脑洞精品', 'S1 名');
  eq(RARITY_LABEL[1].color, '翠绿', 'S1 色');
  eq(RARITY_LABEL[2].name, '秘宝·大师奇物', 'S2 名');
  eq(RARITY_LABEL[2].color, '星蓝', 'S2 色');
  eq(RARITY_LABEL[3].name, '神来之笔·传世孤品', 'S3 名');
  eq(RARITY_LABEL[3].color, '曜金', 'S3 色');
});

test('[L565] 炼金输入件数 2~4 件', () => {
  /* 手册 L565:「设投入的 k 件物品(2 ≤ k ≤ 4)」 */
  eq(ALCHEMY_MIN_INPUTS, 2, '输入下限');
  eq(ALCHEMY_MAX_INPUTS, 4, '输入上限');
});

test('[L576] 总属性预算 P_budget = round(8.5 × T_eff^0.82 × Q)', () => {
  /* 手册 L576 的公式 */
  near(BUDGET_BASE, 8.5, 1e-12, '基数');
  near(BUDGET_EXPONENT, 0.82, 1e-12, '幂指数');
});

test('[L578~L581] 四维切分系数与手册四条公式逐条一致', () => {
  /* 手册 L578:round(P × w_atk × 1.2)
     手册 L579:DEF = round(P × w_def × 0.6)、HP = round(P × w_hp × 2.5)
     手册 L580:F = 3.0 + round(P × w_imp × 0.15)
     手册 L581:Util% = min(50%, round(P × w_util × 0.4)%) */
  near(ATK_MUL, 1.2, 1e-12, '攻击系数(手册 L578)');
  near(DEF_MUL, 0.6, 1e-12, '防御系数(手册 L579)');
  near(HP_MUL, 2.5, 1e-12, '生命系数(手册 L579)');
  near(IMPULSE_BASE, 3.0, 1e-12, '冲击力基数(手册 L580)');
  near(IMPULSE_MUL, 0.15, 1e-12, '冲击力系数(手册 L580)');
  near(UTIL_MUL, 0.4, 1e-12, '功能属性系数(手册 L581)');
  eq(UTIL_CAP_PERCENT, 50, '功能属性占比上限(手册 L581)');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 12. 四大竞技模式(手册 §6.3,L609~L612、L310、L611)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[L609~L612] 四大派对模式的人数区间与时长与手册一致', () => {
  /* 手册 L609:造桥夺旗 2~12 人(前 15 秒摆陷阱 + 后 30 秒冲刺)
     L610:4v4 果冻球 4~16 人
     L611:金皇冠 3~16 人
     L612:圈地涂色 2~12 人、限时 120 秒 */
  eq(PARTY_MODES.length, 4, '模式数');
  const want: [string, string, number, number, number][] = [
    ['BRIDGE_CTF', '2~12', 15, 30, 609],
    ['JELLY_BALL', '4~16', 0, 180, 610],
    ['CROWN_BR', '3~16', 0, 180, 611],
    ['PAINT_WAR', '2~12', 0, 120, 612],
  ];
  for (const [key, players, build, race, line] of want) {
    const m = PARTY_MODES.find((x) => x.key === key);
    ok(m !== undefined, `${key} 存在`);
    eq(m!.players, players, `${key} 人数(手册 L${line})`);
    eq(m!.buildSec, build, `${key} 建造时长(手册 L${line})`);
    eq(m!.raceSec, race, `${key} 比赛时长(手册 L${line})`);
  }
});

test('[L611] 金皇冠:先积满 60 秒者获胜', () => {
  /* 手册 L611:「先积满 60 秒者获胜」 */
  near(CROWN_WIN_SEC, 60, 1e-12, '持冠获胜阈值');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 13. 内容基座锚点(README 状态块 + 手册 L58)
 * ═══════════════════════════════════════════════════════════════════════ */

test('[README] 内容指纹与容量锚点未漂移', () => {
  /* harness 的 `test()` 是同步的 —— 不能在回调里 await。
     故本文件顶部用静态 `import` 引入 registry(见文件头 import 段)。 */
  const f = contentFingerprints();
  eq(f.version, 1, '版本号');
  eq(f.overall, 'fa111d71', '内容指纹 overall');
  const objs = contentCapacity().filter((c) => c.space.includes('OBJ'));
  ok(objs.length > 0, '存在 OBJ 容量账本');
  eq(objs[0].freeCount, 3775, 'OBJ 可用号');
  eq(objs[0].headroom, 3350, 'OBJ 顶端余量');
});

/* ═══════════════════════════════════════════════════════════════════════
 * 14. 手册行号溯源校验(仅当手册文件可定位时执行)
 *
 *     期望值已内联,所以手册不在场也能跑。本组额外确认
 *     「内联值与当前手册版本仍然对得上」—— 手册换版而内联值没跟会在此报警,
 *     而不是静默继续用旧期望值。
 * ═══════════════════════════════════════════════════════════════════════ */

function locatePlan(): string | null {
  const cands = [
    process.env.PLAN_MD,
    join(process.env.USERPROFILE ?? '', 'Downloads', '2_5d_cartoon_sandbox_plan.md'),
    join(ROOT, 'docs', '2_5d_cartoon_sandbox_plan.md'),
  ].filter((x): x is string => Boolean(x));
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}

test('手册行号溯源:内联期望值与手册当前版本一致', () => {
  const plan = locatePlan();
  if (plan === null) {
    /* 手册不在场:跳过(不是失败)—— 期望值已内联,门禁依然有效 */
    ok(true, '手册文件不在场,跳过溯源校验(内联期望值仍生效)');
    return;
  }
  const lines = readFileSync(plan, 'utf8').split(/\r?\n/);
  /** 断言手册第 line 行(1-based)含某个片段 */
  const at = (line: number, needle: string, what: string): void => {
    const l = lines[line - 1] ?? '';
    ok(l.includes(needle), `手册 L${line} 仍含「${needle}」(${what})`);
  };
  /* 抽 12 个跨章节的锚点 */
  at(19, '20Hz', '高频帧');
  at(20, '2Hz', '低频帧');
  at(43, '0.85', '叠罗汉层高');
  at(44, '8.5', '投掷初速');
  at(46, '1.4', '接球窗口');
  at(50, '16×16', 'Chunk 尺寸');
  at(58, '4095', 'OBJ 上限');
  at(71, '320', '物品总数');
  at(156, '100% 免疫队友举起', '和平盾');
  at(158, '221 ~ 255', '玩具区间');
  at(289, '2.0s', '延时四档');
  at(395, '701 ~ 745', '战利品区间');
  at(452, '50', '经验公式');
  at(460, '24 种', '野生生物');
  at(489, 'Boss', 'Boss 章节');
  at(566, '1.35', 'T_eff 幂指数');
  at(611, '60 秒', '皇冠获胜');
});

report('WS-FND-06');
