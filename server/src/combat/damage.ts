/**
 * WS-10-B 完整伤害管线(server/src/combat/damage.ts)
 *
 * 公式链(严格按此顺序,每一步均可单独断言):
 *   1 基础   = ATK总 × 等级倍率 × 武器倍率 × 连段倍率 × 技能倍率
 *   2 元素   = 基础 × ELEMENT_COUNTER[攻元素][守元素]
 *   3 破甲   = 有效DEF = max(0, (守DEF − 固定破甲) × (1 − 百分比破甲))
 *   4 破盾   = 护盾伤害 = 元素后伤害 × 晶甲系数 × 破盾倍率;溢出按破盾倍率折算转入 HP
 *   5 暴击   = × 暴击倍率(暴击率判定;爆伤封顶 3.0)
 *   6 减伤   = × ARMOR_K/(ARMOR_K + 有效DEF)  ← 递减曲线,永不归零
 *              × (1 − 词条减伤)   (728 为 0.30)
 *              × 外部乘区(易伤/环境)
 *   7 反伤   = 实际承伤 × 反伤倍率(728 为 1.50),作用于 3 格内攻击者
 *   8 击退   = (武器基础击退 × 武器击退倍率 × 技能击退倍率) ÷ 目标质量
 *
 * 零运行时依赖,仅 import 本工程内部模块(相对路径全部带 .ts)。
 */

import {
  Element,
  MAX_CRIT_DMG,
  MAX_DODGE_RATE,
  PRANK_HAMMER_KNOCKBACK,
  elementMul,
  sanitizeComboMul,
  type CombatantStats,
  type SkillDef,
  type WeaponDef,
} from './weapons.ts';

/* ───────────────────────────── 管线参数(全部可测) ───────────────────────────── */

/** 护甲递减曲线常数:K/(K+DEF),DEF=K 时减伤 50% */
export const ARMOR_K = 120;
/** 晶甲类正面免疫系数:普通刀剑弓箭只打 20% */
export const CRYSTAL_ARMOR_MUL = 0.20;
/** 破盾倍率达到此值即视为「无视晶甲」 */
export const CRYSTAL_BREAK_THRESHOLD = 3.0;
export const MIN_DAMAGE = 1;
export const REFLECT_RADIUS = 3.0;
export const TELEGRAPH_MIN_SEC = 0.6;
/** 命中最长距离容差,超过则本次攻击不结算 */
export const MAX_REACH_TOLERANCE = 1.5;

/* ───────────────── 生物战斗面板的派生系数(冻结层缺这几项)───────────────── */

/**
 * 生物护甲的等级线性派生系数。
 *
 * ## 为什么是「派生」而不是「查表」
 *
 * 冻结层 `MobDef` 只有 `{id,name,biome,behavior,level,hp,exp,drops,note}` ——
 * **没有 `def`、没有 `element`、没有 `crystalArmor`**;手册里也没有怪物的防御表
 * (grep `防御|护甲|晶甲` 命中的全是**物品**数值,如「616 草帽 防御+2」,
 * 没有一条是生物的)。而 `TargetProfile` 这四项都是必需输入。
 * ⇒ 「怪物的防御从哪来」只能由服务端派生,**不能**去改冻结层补字段。
 *
 * ## 为什么刻意与 `vitals.ts` 取同一组系数
 *
 * 本仓「怪打玩家」方向已经是纯等级线性(`vitals.ts`):
 *   `MOB_HIT_BASE + MOB_HIT_PER_LEVEL × (lv − 1)` = `6 + 2/lv`
 * 这里让「玩家打怪」的护甲走**同一形式、同一组数值**,两条伤害方向在
 * **口径上可互相换算**。两个方向**不共用代码**(输入类型无交集:见
 * `docs/DAMAGE-LOOP.md`),能共享的本来就只有口径 —— 另造一套会让同一个
 * 平衡问题在两条路上各说各话。
 *
 * ⚠ **这是派生规则,不是手册硬数值。属平衡决策,待 owner 批准。**
 */
export const MOB_DEF_BASE = 6;
/** 每级增量。与 `vitals.MOB_HIT_PER_LEVEL` 同值同量纲(整数点)。 */
export const MOB_DEF_PER_LEVEL = 2.0;
/** 生物质量默认 1(物理刚体 `physics.spawn` 默认即 1,击退换算按此)。 */
export const MOB_MASS_DEFAULT = 1.0;

/**
 * 生物自身的元素属性表 —— **只收名称/行为里明确带元素语义的生物**。
 *
 * 未列出的生物一律 `Element.NONE`(元素矩阵对 NONE 恒 ×1,即无克制)。
 * 刻意**不**「顺手给每只怪分配一个元素」:元素矩阵是 6×6 的克制关系,
 * 凭空赋值等于凭空发明平衡。
 *
 * 收录依据(逐条可查证):
 * - `mob_lava_elem` 熔炉赤焰火灵 —— 名称含「赤焰火灵」,且 `BeetleAi` 同级
 *   的 `LavaElemAi` 自身每 0.5s 把脚下 3×3 改写为火炭砖、吐 2.6 格火环;
 * - `mob_thunder_sprite` 雷云闪电球 —— 名称含「雷云」;
 * - `mob_slime_green` 甜莓果冻怪 —— 名称含「果冻怪」,`Element.SLIME` 即为其设。
 *
 * ⚠ **待 owner 批准**(平衡决策)。
 */
export const MOB_ELEMENT_BY_ID: ReadonlyMap<string, Element> = new Map<string, Element>([
  ['mob_lava_elem', Element.FIRE],
  ['mob_thunder_sprite', Element.LIGHTNING],
  ['mob_slime_green', Element.SLIME],
]);

export const DamageSource = {
  NORMAL_ATTACK: 'NORMAL_ATTACK',
  SKILL: 'SKILL',
  DOT: 'DOT',
  REFLECT: 'REFLECT',
  ENVIRONMENT: 'ENVIRONMENT',
  PRANK: 'PRANK',
} as const;
export type DamageSource = (typeof DamageSource)[keyof typeof DamageSource];

export const FloatColor = {
  NORMAL: 'FFFFFF',
  CRIT: 'FFD34D',
  SHIELD: '66D9FF',
  REFLECT: 'C08CFF',
  HEAL: '7CF29A',
  NULLIFIED: 'B0B0B0',
} as const;
export type FloatColor = (typeof FloatColor)[keyof typeof FloatColor];

/* ───────────────────────────── 输入结构 ───────────────────────────── */

export interface TargetProfile {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  def: number;
  /** 护盾池(晶甲类怪物专用) */
  shield: number;
  /** 护盾初始值,用于 UI 画护盾条 */
  shieldMax: number;
  /** 目标自身元素属性 */
  element: Element;
  /** 是否晶甲类(正面免疫 80% 普通刀剑与弓箭) */
  crystalArmor: boolean;
  /** 质量,用于击退换算 */
  mass: number;
  /** 结算乘区:易伤 1.2 / 无敌墙或幽灵泡泡 0 表示完全免疫 */
  takenMul: number;
  /** 受击方词条减伤(728 = 0.30) */
  dmgReduce: number;
  /** 受击方反伤倍率(728 = 1.50),作用于攻击者 */
  reflectMul: number;
  dodgeRate: number;
  isBoss: boolean;
}

export function createTarget(patch: Partial<TargetProfile> & { id: string; name: string }): TargetProfile {
  const base: TargetProfile = {
    hp: 100, maxHp: 100, def: 0, shield: 0, shieldMax: 0,
    element: Element.NONE, crystalArmor: false, mass: 1.0, takenMul: 1.0,
    dmgReduce: 0, reflectMul: 0, dodgeRate: 0, isBoss: false, ...patch,
  };
  if (patch.shieldMax === undefined && patch.shield !== undefined) base.shieldMax = patch.shield;
  if (patch.shield !== undefined && patch.shieldMax === undefined) base.shieldMax = patch.shield;
  return base;
}

/** 把玩家/怪物的战斗面板转成「受击方档案」,用于怪物打人的反向结算。 */
export function targetFromStats(
  stats: CombatantStats,
  patch: Partial<TargetProfile> & { id: string; name: string },
): TargetProfile {
  return createTarget({
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    def: stats.def,
    dmgReduce: stats.dmgReduce,
    reflectMul: stats.reflectMul,
    dodgeRate: stats.dodgeRate,
    mass: 1.0,
    ...patch,
  });
}

/**
 * 由冻结层 `MobDef` 派生「受击方档案」—— 「玩家 → 生物」方向的唯一入口。
 *
 * ## 为什么要这个函数(它是 task-33 接线缺的那一环)
 *
 * `computeDamage` 第二参数要 `TargetProfile`(13 个字段),而 `MobDef` 只有
 * `{id,name,biome,behavior,level,hp,exp,drops,note}` —— **只有 4 个能用**
 * (`id`/`name`/`hp`)。冻结层不能改,所以缺的 9 项必须在这里补。
 *
 * ## 职责边界:`computeDamage` 管通用八步,生物 AI 管个体特性
 *
 * 这是本函数**刻意留空**很多字段的理由 —— 不是没做,是**避免双重结算**:
 *
 * | 字段 | 谁负责 | 为什么 |
 * | :--- | :--- | :--- |
 * | `def` / `element` | **本函数**(派生) | 冻结层完全没有这两项 |
 * | `dmgReduce` / `reflectMul` / `dodgeRate` | **留 0,交给 AI** | 见下 |
 * | `shield` / `crystalArmor` | **留空,交给 AI** | 见下 |
 *
 * 实测:**手册/行为里记载的个体特性,全部已经在各生物的 `onDamage` 里实现了** ——
 * 竹林剑客傀儡的正面 100% 格挡(`samurai_block`)、远古发条重骑的正面减伤
 * (`knight_front_plate`)、温泉卡皮巴拉的反弹爱心(`capybara_heart_reflect`)、
 * 紫晶重甲虫的正面 ±75° 减伤 80%(`beetle_front_armor`)都是。
 *
 * 若这里**再**把 `crystalArmor` 或 `dmgReduce` 也设上,同一次攻击会被减两遍
 * (公式减一次、AI 的 `onDamage` 再减一次)—— 那是**静默的数值错误**:
 * 不抛异常、只是伤害莫名其妙偏低,而且「减伤 80%」会变成 96%。
 *
 * 所以本函数只补**通用、无个体差异**的两项(`def`/`element`),
 * 个体特性一律留给生物自己的 AI。调用链:
 * `computeDamage`(通用八步)→ `mobHost.damage`(个体 `onDamage`)。
 *
 * @param def   冻结层的生物定义
 * @param patch 覆盖(供特例与测试注入受控夹具;缺省则全部走派生)
 */
export function mobCombatProfile(
  def: { id: string; name: string; level: number; hp: number },
  patch: Partial<TargetProfile> = {},
): TargetProfile {
  const level = Math.max(1, Math.trunc(def.level));
  return createTarget({
    id: def.id,
    name: def.name,
    hp: def.hp,
    maxHp: def.hp,
    def: MOB_DEF_BASE + MOB_DEF_PER_LEVEL * (level - 1),
    element: MOB_ELEMENT_BY_ID.get(def.id) ?? Element.NONE,
    mass: MOB_MASS_DEFAULT,
    ...patch,
  });
}

export interface AttackInput {
  attacker: CombatantStats;
  target: TargetProfile;
  weapon?: WeaponDef | null;
  skill?: SkillDef | null;
  /** 普攻连段倍率(如 1.00 / 1.00 / 1.25) */
  comboMul?: number;
  /** 可注入随机:暴击判定 [0,1) */
  critRoll: number;
  /** 可注入随机:闪避判定 [0,1) */
  dodgeRoll: number;
  /** 相机抖动/环境易伤等外部乘区 */
  externalMul?: number;
  source?: DamageSource;
  /** 命中时目标与玩家的水平距离(格),用于 reach 校验 */
  distance?: number;
}

export interface DamageStep {
  step: string;
  value: number;
  detail: string;
}

export interface FloatSpec {
  text: string;
  color: FloatColor;
  sizeScale: number;
}

export interface DamageResult {
  targetId: string;
  /** 1 基础伤害 */
  base: number;
  levelMul: number;
  weaponMul: number;
  /** 2 元素克制系数 */
  elementMulValue: number;
  afterElement: number;
  /** 3 破甲后的有效防御 */
  flatPen: number;
  pctPen: number;
  effectiveDef: number;
  /** 4 护盾结算 */
  crystalMul: number;
  shieldBreakMul: number;
  shieldDamage: number;
  shieldBroken: boolean;
  /** 5 暴击 */
  critRolled: boolean;
  critRate: number;
  critMul: number;
  /** 6 减伤 */
  mitigationMul: number;
  takenMul: number;
  externalMul: number;
  finalDamage: number;
  /** 7 反伤(对攻击者) */
  reflectDamage: number;
  /** 8 击退冲量(格/秒) */
  knockbackImpulse: number;
  dodged: boolean;
  outOfReach: boolean;
  source: DamageSource;
  float: FloatSpec;
  steps: DamageStep[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/* ───────────────────────────── 主伤害函数 ───────────────────────────── */

export function computeDamage(input: AttackInput): DamageResult {
  const { attacker, target } = input;
  const weapon = input.weapon ?? null;
  const skill = input.skill ?? null;
  const source = input.source ?? (skill ? DamageSource.SKILL : DamageSource.NORMAL_ATTACK);
  const steps: DamageStep[] = [];
  const externalMul = input.externalMul ?? 1.0;

  const emptyShell = (extra: Partial<DamageResult>): DamageResult => ({
    targetId: target.id, base: 0, levelMul: 1, weaponMul: 1, elementMulValue: 1, afterElement: 0,
    flatPen: 0, pctPen: 0, effectiveDef: 0, crystalMul: 1, shieldBreakMul: 1, shieldDamage: 0,
    shieldBroken: false, critRolled: false, critRate: 0, critMul: 1, mitigationMul: 1,
    takenMul: target.takenMul, externalMul, finalDamage: 0, reflectDamage: 0, knockbackImpulse: 0,
    dodged: false, outOfReach: false, source,
    float: { text: '0', color: FloatColor.NORMAL, sizeScale: 1.0 },
    steps, ...extra,
  } as DamageResult);

  /* 0-a 距离校验:超出 reach 容差不结算 */
  const reach = weapon ? weapon.reach : 1.8;
  const reachLimit = skill && skill.range > 0 ? Math.max(skill.range, reach) + MAX_REACH_TOLERANCE : reach + MAX_REACH_TOLERANCE;
  if (input.distance !== undefined && input.distance > reachLimit) {
    steps.push({ step: '0a 距离校验', value: 0, detail: `距离 ${r2(input.distance)} > 上限 ${r2(reachLimit)},本次攻击落空` });
    return emptyShell({
      outOfReach: true,
      float: { text: '未命中', color: FloatColor.NULLIFIED, sizeScale: 0.85 },
    });
  }

  /* 0-b 闪避判定:闪避率封顶 0.75 */
  const dodgeRate = Math.min(Math.max(target.dodgeRate, 0), MAX_DODGE_RATE);
  if (input.dodgeRoll < dodgeRate) {
    steps.push({ step: '0b 闪避判定', value: 0, detail: `dodgeRoll=${r2(input.dodgeRoll)} < dodgeRate=${r2(dodgeRate)}` });
    return emptyShell({
      dodged: true,
      float: { text: '闪避', color: FloatColor.NULLIFIED, sizeScale: 0.9 },
    });
  }

  /* 1 基础 = ATK总 × 等级倍率 × 武器倍率 × 连段 × 技能倍率 */
  const levelMul = 1 + 0.03 * (attacker.level - 1);
  const weaponMul = weapon ? weapon.attackMul : 1.0;
  /* 连段倍率消毒 —— 详见 `MAX_COMBO_MUL`。
     ⚠ 这是本公式里**唯一**的自报标量:其余六个乘数都有界
     (`levelMul` 经 MAX_LEVEL、`weaponMul`/`skillMul` 查表、
     `dodgeRate`/`critRate`/`critDmg` 各有 MAX_*)。
     未消毒时 `comboMul: 1e9` 让最终伤害从 14 涨到 1.4e10;
     `comboMul: NaN` 更糟 —— `Math.max(MIN_DAMAGE, NaN)` 得 `NaN`,
     生物 HP 被永久污染,此后**永远打不死**(实测补刀也无效)。
     消毒放在这里而不是调用方:这是唯一消费该值的地方,
     放调用方会漏掉其它调用(也与 `dodgeRate`/`critRate` 的就地钳制同形)。 */
  const comboMul = sanitizeComboMul(input.comboMul);
  const skillMul = skill ? skill.damageMul : 1.0;
  const base = attacker.totalAtk * levelMul * weaponMul * comboMul * skillMul;
  steps.push({
    step: '1 基础伤害', value: r2(base),
    detail: `${r2(attacker.totalAtk)} ATK × ${r2(levelMul)} 等级 × ${weaponMul} 武器 × ${comboMul} 连段 × ${skillMul} 技能`,
  });

  /* 2 元素克制矩阵 */
  const atkElement: Element = skill && skill.element !== Element.NONE
    ? skill.element
    : (weapon ? weapon.element : Element.NONE);
  const eMul = elementMul(atkElement, target.element);
  const afterElement = base * eMul;
  steps.push({ step: '2 元素克制', value: r2(afterElement), detail: `${atkElement} → ${target.element} = ×${eMul}` });

  /* 3 破甲 —— 语义:同源不叠加,异源取最大。
     破甲同源不叠加、异源取 max —— 相加会导致穿透溢出(718 手持 15% + 技能 25% = 40%),故取 max。参见 docs/WS-10-combat-progress.md §4。
     注意 attacker.armorPen 已由 equipSummary 聚合了当前武器,与 weapon.armorPen 同源,
     故三者一律走 max 而非求和;叠加会把同一次攻击的双重计数放大成穿透溢出。
     固定穿透先扣,再乘 (1 − 百分比穿透);有效防御钳制在 0 以上,不允许被穿透成负数去放大伤害。 */
  const weaponFlat = weapon ? weapon.armorPen : 0;
  const weaponPct = weapon ? weapon.armorPenPct : 0;
  const skillFlat = skill ? skill.armorPen : 0;
  const skillPct = skill ? skill.armorPenPct : 0;
  const flatPen = Math.max(weaponFlat, skillFlat, attacker.armorPen);
  const pctPen = Math.min(0.90, Math.max(0, weaponPct, skillPct, attacker.armorPenPct));
  const afterFlat = Math.max(0, target.def - flatPen);
  const effectiveDef = afterFlat * (1 - pctPen);
  steps.push({
    step: '3 破甲', value: r2(effectiveDef),
    detail: `DEF ${target.def} − 固定穿透 ${r2(flatPen)} = ${r2(afterFlat)},再 ×(1−${r2(pctPen)}) = ${r2(effectiveDef)}`,
  });

  /* 4 破盾 */
  const weaponBreak = weapon ? weapon.shieldBreakMul : 1.0;
  const skillBreak = skill ? skill.shieldBreakMul : 1.0;
  const shieldBreakMul = Math.max(weaponBreak, skillBreak, attacker.shieldBreakMul);
  const ignoresCrystal = shieldBreakMul >= CRYSTAL_BREAK_THRESHOLD
    || attacker.flags.weaponId === 204
    || source === DamageSource.ENVIRONMENT;
  const crystalMul = target.crystalArmor && !ignoresCrystal ? CRYSTAL_ARMOR_MUL : 1.0;
  const preShield = afterElement * crystalMul;
  let shieldDamage = 0;
  let shieldBroken = false;
  let carry = preShield;
  if (target.shield > 0) {
    shieldDamage = r2(preShield * shieldBreakMul);
    if (shieldDamage >= target.shield) {
      shieldBroken = true;
      carry = (shieldDamage - target.shield) / shieldBreakMul;
    } else {
      carry = 0;
    }
  }
  steps.push({
    step: '4 破盾', value: r2(carry),
    detail: target.shield > 0
      ? `护盾 ${target.shield};晶甲系数 ×${crystalMul};破盾伤害 = ${r2(preShield)} × ${r2(shieldBreakMul)} = ${shieldDamage} → ${shieldBroken ? `击破,溢出折算 ${r2(carry)} 转入 HP` : '未破,HP 免伤'}`
      : `无护盾;晶甲系数 ×${crystalMul}(破盾倍率 ${r2(shieldBreakMul)} ${ignoresCrystal ? '≥3.0 无视晶甲' : '<3.0 被晶甲削减'})`,
  });

  /* 5 暴击 */
  const critRate = Math.min(1.0, Math.max(0, attacker.critRate + (skill ? skill.critBonus : 0)));
  const critRolled = input.critRoll < critRate;
  const critMul = critRolled ? Math.min(attacker.critDmg, MAX_CRIT_DMG) : 1.0;
  const afterCrit = carry * critMul;
  steps.push({
    step: '5 暴击', value: r2(afterCrit),
    detail: `critRate=${r2(critRate)} roll=${r2(input.critRoll)} → ${critRolled ? `暴击 ×${r2(critMul)}` : '未暴击 ×1'}`,
  });

  /* 6 减伤:护甲递减曲线 + 受击方词条减伤 + 外部乘区 */
  const mitigationMul = ARMOR_K / (ARMOR_K + effectiveDef);
  const keywordMul = 1 - target.dmgReduce;
  const finalDamageRaw = afterCrit * mitigationMul * keywordMul * externalMul * target.takenMul;
  /* 护盾未破时 HP 完全免伤;幽灵泡泡/无敌墙 takenMul=0 时整段归零 */
  let finalDamage: number;
  if (target.takenMul === 0) finalDamage = 0;
  else if (target.shield > 0 && !shieldBroken) finalDamage = 0;
  else finalDamage = Math.round(Math.max(MIN_DAMAGE, finalDamageRaw));
  steps.push({
    step: '6 减伤', value: finalDamage,
    detail: `DEF ${r2(effectiveDef)} → 护甲系数 ${r2(mitigationMul)}(递减曲线,趋近 0 不归零);词条减伤 ${r2(target.dmgReduce)} → ×${r2(keywordMul)};外部 ×${externalMul};易伤 ×${target.takenMul} → 未取整 ${r2(finalDamageRaw)}`,
  });

  /* 7 反伤:受击方反伤倍率(728 = 1.50)作用于 3 格内攻击者 */
  const reflectDamage = r2(finalDamage * target.reflectMul);
  steps.push({
    step: '7 反伤', value: reflectDamage,
    detail: `实际承伤 ${finalDamage} × 反伤倍率 ${r2(target.reflectMul)} = ${reflectDamage}(作用半径 ${REFLECT_RADIUS} 格)`,
  });

  /* 8 击退冲量 */
  const wKnock = weapon ? weapon.knockback : 2.0;
  const skKnock = skill ? skill.knockbackMul : 1.0;
  const knockbackImpulse = r2((wKnock * attacker.knockbackMul * skKnock) / Math.max(target.mass, 0.1));
  steps.push({
    step: '8 击退', value: knockbackImpulse,
    detail: `${wKnock} 基础击退 × ${r2(attacker.knockbackMul)} 武器倍率 × ${skKnock} 技能倍率 ÷ ${target.mass} 质量 = ${knockbackImpulse} 格/秒`,
  });

  return {
    targetId: target.id,
    base: r2(base),
    levelMul: r2(levelMul),
    weaponMul,
    elementMulValue: eMul,
    afterElement: r2(afterElement),
    flatPen: r2(flatPen),
    pctPen: r2(pctPen),
    effectiveDef: r2(effectiveDef),
    crystalMul,
    shieldBreakMul: r2(shieldBreakMul),
    shieldDamage,
    shieldBroken,
    critRolled,
    critRate: r2(critRate),
    critMul: r2(critMul),
    mitigationMul: r2(mitigationMul),
    takenMul: target.takenMul,
    externalMul,
    finalDamage,
    reflectDamage,
    knockbackImpulse,
    dodged: false,
    outOfReach: false,
    source,
    float: floatText(finalDamage, critRolled, shieldBroken, shieldDamage),
    steps,
  };
}

/**
 * 反伤独立入口:受击方是 728 反伤甲时,把承伤折算回攻击者。
 * 与 computeDamage 第 7 步数值一致,便于双向同步与断言。
 */
export function reflectFrom(
  defenderReflectMul: number,
  incomingFinalDamage: number,
): { reflectDamage: number; radius: number } {
  return { reflectDamage: r2(incomingFinalDamage * defenderReflectMul), radius: REFLECT_RADIUS };
}

/* ───────────────────────────── 伤害数字飘字规则 ───────────────────────────── */

export function floatText(
  damage: number,
  crit: boolean,
  shieldBroken: boolean,
  shieldDamage: number,
): FloatSpec {
  if (damage <= 0 && shieldDamage <= 0) {
    return { text: '免疫', color: FloatColor.NULLIFIED, sizeScale: 0.9 };
  }
  const color = crit ? FloatColor.CRIT : shieldDamage > 0 ? FloatColor.SHIELD : FloatColor.NORMAL;
  const magnitude = Math.log10(Math.max(damage, 1) + 1);
  const sizeScale = crit
    ? r2(1.0 + Math.min(0.80, magnitude * 0.22))
    : r2(1.0 + Math.min(0.40, magnitude * 0.12));
  const prefix = shieldBroken ? '破盾!' : '';
  return { text: `${prefix}${damage}`, color, sizeScale };
}

export function reflectFloat(damage: number): FloatSpec {
  return { text: `-${damage}`, color: FloatColor.REFLECT, sizeScale: 1.15 };
}

export function healFloat(hp: number): FloatSpec {
  return { text: `+${hp}`, color: FloatColor.HEAL, sizeScale: 1.0 };
}

/* ───────────────────────────── 纯函数式应用 ───────────────────────────── */

export interface AppliedDamage {
  target: TargetProfile;
  result: DamageResult;
  /** 目标是否被本次攻击击倒(HP 归零) */
  downed: boolean;
  /** 击破护盾后的护盾余量 */
  shieldLeft: number;
}

export function applyDamage(target: TargetProfile, result: DamageResult): AppliedDamage {
  if (result.dodged || result.outOfReach) {
    return { target: { ...target }, result, downed: false, shieldLeft: target.shield };
  }
  const shieldLeft = result.shieldBroken ? 0 : Math.max(0, target.shield - result.shieldDamage);
  const hp = Math.max(0, target.hp - result.finalDamage);
  return { target: { ...target, hp, shield: shieldLeft }, result, downed: hp <= 0, shieldLeft };
}

/** 队友整蛊命中:0 伤害 + 固定 8 格/秒击退冲量(222 充气大锤)。 */
export function allyPrankHit(target: TargetProfile): DamageResult {
  return {
    targetId: target.id, base: 0, levelMul: 1, weaponMul: 1, elementMulValue: 1, afterElement: 0,
    flatPen: 0, pctPen: 0, effectiveDef: 0, crystalMul: 1, shieldBreakMul: 1, shieldDamage: 0,
    shieldBroken: false, critRolled: false, critRate: 0, critMul: 1, mitigationMul: 1,
    takenMul: target.takenMul, externalMul: 1, finalDamage: 0, reflectDamage: 0,
    knockbackImpulse: PRANK_HAMMER_KNOCKBACK, dodged: false, outOfReach: false,
    source: DamageSource.PRANK,
    float: { text: '0', color: FloatColor.NORMAL, sizeScale: 1.0 },
    steps: [{ step: '整蛊命中', value: 0, detail: '对队友 0 伤害,固定 8 格/秒击退冲量' }],
  };
}

/* ───────────────────────────── DoT / 灼烧 ───────────────────────────── */

export interface DotTask {
  key: string;
  targetId: string;
  element: Element;
  dps: number;
  remainSec: number;
}

export function makeDot(
  targetId: string,
  dot: { element: Element; dps: number; sec: number },
  key: string,
): DotTask {
  return { key, targetId, element: dot.element, dps: dot.dps, remainSec: dot.sec };
}

export function tickDot(task: DotTask, dt: number): { task: DotTask; damage: number; expired: boolean } {
  const used = Math.min(dt, Math.max(0, task.remainSec));
  const damage = r2(task.dps * used);
  const remainSec = r2(task.remainSec - used);
  return { task: { ...task, remainSec }, damage, expired: remainSec <= 0 };
}

/* ───────────────────────────── 技能命中解析(713/716/718/723) ───────────────────────────── */

export interface SkillHitPlan {
  /** 每个结算帧的偏移秒数(0 或 delaySec 表示立即) */
  ticks: number[];
  /** 每帧伤害倍率 */
  perTickMul: number;
  /** 是否带预警 */
  telegraphSec: number;
  /** 命中区域描述 */
  area: string;
  /** 总伤害倍率(段数 × 每段) */
  totalMul: number;
}

export function planSkillHits(skill: SkillDef): SkillHitPlan {
  const hits = Math.max(1, skill.hits);
  const interval = skill.tickSec > 0 ? skill.tickSec : 0;
  const ticks: number[] = [];
  for (let i = 0; i < hits; i += 1) ticks.push(r2(skill.delaySec + i * interval));
  let area: string;
  if (skill.shape === 'RECT') area = `${r2(skill.range)}×${r2(skill.radius * 2)} 矩形`;
  else if (skill.shape === 'LINE') area = `${r2(skill.range)} 格直线(宽 ${r2(skill.radius * 2)})`;
  else if (skill.shape === 'AREA') area = String(skill.extras.areaSize ?? `半径 ${r2(skill.radius)}`);
  else if (skill.shape === 'CONE') area = `${skill.extras.coneDeg ?? 45}° 扇形(射程 ${r2(skill.range)})`;
  else if (skill.shape === 'SELF' || skill.shape === 'HOLD') area = `自身(半径 ${r2(skill.radius)})`;
  else area = `半径 ${r2(skill.radius)} 圆`;
  return {
    ticks,
    perTickMul: skill.damageMul,
    telegraphSec: skill.telegraphSec,
    area,
    totalMul: r2(skill.damageMul * hits),
  };
}

/* ───────────────────────────── 治疗与护盾工具 ───────────────────────────── */

export function healTarget(target: TargetProfile, hp: number): { target: TargetProfile; healed: number } {
  const healed = Math.min(Math.max(0, hp), Math.max(0, target.maxHp - target.hp));
  return { target: { ...target, hp: target.hp + healed }, healed };
}

export function shieldPercent(target: TargetProfile): number {
  const maxShield = target.shieldMax > 0 ? target.shieldMax : target.shield;
  if (maxShield <= 0) return 0;
  return r2(target.shield / maxShield);
}
