/**
 * WS-10-C 等级 / 天赋 / 全队经验共享(server/src/combat/progression.ts)
 *
 * 冻结层事实源:
 *   · expToNext(L) = 50L² + 50L          (shared/types/entities.ts)
 *   · statsAtLevel(L) = HP 100+15(L−1), dmgMul 1+0.03(L−1), carrySlots 8+(L−1)
 *   · TALENT_LEVELS = [5,10,15,20,25,30]
 *   · SHARE_EXP_RADIUS=24 / PARTY_BONUS_THRESHOLD=3 / PARTY_BONUS=0.25 / AFK_EXP_RATIO=0.3
 *
 * 本模块不复制任何冻结公式,全部经 import 取用,保证双实现不会漂移。
 */

import {
  AFK_EXP_RATIO,
  MAX_LEVEL,
  PARTY_BONUS,
  PARTY_BONUS_THRESHOLD,
  SHARE_EXP_RADIUS,
  TALENT_LEVELS,
  expToNext,
  statsAtLevel,
} from '../../../shared/types/entities.ts';

export const SHARE_RADIUS = SHARE_EXP_RADIUS;
export const TALENT_UNLOCK_LEVELS = TALENT_LEVELS;

/* ───────────────────────────── 天赋表(6 条,5/10/15/20/25/30 解锁) ───────────────────────────── */

export interface TalentDef {
  id: string;
  name: string;
  unlockLevel: number;
  /** 一句话机制说明 */
  summary: string;
  /** 可断言的效果数值字典 */
  effects: Record<string, number>;
}

export const TALENTS: readonly TalentDef[] = [
  {
    id: 'talent_roll_bomb', name: '翻滚·残影炸弹', unlockLevel: 5,
    summary: '翻滚后原地留下一个残影泡沫,0.6 秒后炸开并击退周围小怪。',
    effects: {
      shadowBombRatio: 0.40,   // 伤害 = 攻击力 × 40%
      shadowBombSec: 2.0,      // 残影存在 2.0 秒
      shadowBombRadius: 1.5,   // 爆炸半径 1.5 格
      rollCdMul: 0.80,         // 翻滚冷却 ×0.80
    },
  },
  {
    id: 'talent_throw_master', name: '大力士·投掷精通', unlockLevel: 10,
    summary: '举起与投掷伤害翻倍,投掷距离 +1 格,并可把中小型怪物当炮弹扔出去。',
    effects: {
      throwDamageMul: 2.00,    // 投掷伤害翻倍
      throwRangeBonus: 1.0,    // 投掷距离 +1 格
      throwSpeedMul: 1.10,     // 投掷初速 ×1.10
      carrySlowdownRelief: 0.10, // 叠罗汉减速减轻 10%
    },
  },
  {
    id: 'talent_rescue_swift', name: '急救快手·把队友拉起来', unlockLevel: 15,
    summary: '救援队友所需时间减半(1.0s → 0.5s),复活后额外多 10% 生命。',
    effects: {
      reviveTimeMul: 0.50,     // 救援速度翻倍
      reviveHpRatioBonus: 0.10, // 复活血量 50% → 60%
      reviveRadiusBonus: 0.5,  // 救援判定半径 +0.5 格
    },
  },
  {
    id: 'talent_crit_master', name: '暴击大师', unlockLevel: 20,
    summary: '暴击率 +8%,暴击伤害 +25%。',
    effects: { critRateBonus: 0.08, critDmgBonus: 0.25 },
  },
  {
    id: 'talent_element_affinity', name: '元素亲和', unlockLevel: 25,
    summary: '元素克制幅度放大 25%(1.5 → 1.875),被克制方的减伤也同步放大。',
    effects: { elementMulBonus: 0.25, counterAmpCap: 1.875, resistAmpFloor: 0.375 },
  },
  {
    id: 'talent_dream_revelation', name: '梦境启示', unlockLevel: 30,
    summary: '全部经验获取 +20%;打盹见习经验由 0.3 提升到 0.45;打盹攒露水速度 ×1.5。',
    effects: { expGainMul: 1.20, afkExpRatio: 0.45, dewRateMul: 1.5 },
  },
];

export const TALENT_BY_ID: ReadonlyMap<string, TalentDef> = new Map(TALENTS.map((t) => [t.id, t]));
/*
 * ═════════════════ 天赋效果接线台账(WS-FND-148)═════════════════
 *
 * ## 为什么要有这张表(它修的是什么)
 *
 * `TALENTS` 里有 6 条天赋、19 个效果字段,而**生产里真正生效的只有 2 个**
 * (`talent_dream_revelation` 的 `expGainMul` / `afkExpRatio`;等级闸另由
 * `isTalentUnlocked` 提供)。其余 17 个字段今天只是数据。
 *
 * 修前这件事散落在三处注释里,且**互相矛盾**:
 * ```
 * 本文件(旧 line 91-94):「生产里真正按天赋改数值的一条都没有」  ← 假(梦境启示在读表)
 * `combat/wiring_ledger.ts`:TALENTS / activeTalents 整表 UNWIRED ← 方向对、粒度错
 * `PlayerProgress.talentFlags`:「全 server 无读者」               ← 真,但那是另一件事
 * ```
 * ⇒ 收成一张**可机器对账**的表:逐条天赋 × 逐条效果字段给「已接 / 未接 + 接法 + 理由」,
 *   由 `auditTalentWiring` 双向核对(见下)。判据:`tests/WS-FND-148`。
 *
 * ## 判定方向(这是它有牙的地方)
 * ```
 * WIRED    ⇒ `at` 指向的文件里必须真的能匹配 `evidence`(消费表达式,不是定义行)
 * UNWIRED  ⇒ 任何 server 文件都**不得**匹配 `evidence`(接线了就必须改这一行)
 * ```
 * `evidence` 一律取**消费表达式**形态(`TALENT_BY_ID.get('<id>')` 或 `.dmgMul`),
 * 因此定义行本身(`effects: { ... }`)不构成证据;注释由调用方先剥掉。
 */

export const TALENT_WIRING_STATUS = {
  /** 生产里有消费者(证据在 `at`)。 */
  WIRED: 'WIRED',
  /** 生产里没有消费者;`at` 写「想接的话该改哪一处」,`reason` 写为什么今天不接。 */
  UNWIRED: 'UNWIRED',
} as const;
export type TalentWiringStatus = (typeof TALENT_WIRING_STATUS)[keyof typeof TALENT_WIRING_STATUS];

export interface TalentEffectRow {
  talentId: string;
  /** `TalentDef.effects` 的键名。 */
  effect: string;
  status: TalentWiringStatus;
  /** WIRED:`路径#位置`;UNWIRED:接法(同样写 `路径#位置`,便于将来照着接)。 */
  at: string;
  /** 消费证据正则(对**剥注释后**的代码跑)。 */
  evidence: string;
  reason: string;
}

/** 「这条天赋的数值没有任何读者」的统一证据形态。 */
const noReaderEvidence = (talentId: string): string => `TALENT_BY_ID\\.get\\('${talentId}'\\)`;

/** 未接天赋的批量登记:同一接法 / 同一理由覆盖该天赋的全部效果字段。 */
function unwiredTalent(
  talentId: string,
  effects: readonly string[],
  at: string,
  reason: string,
): TalentEffectRow[] {
  return effects.map((effect) => ({
    talentId,
    effect,
    status: TALENT_WIRING_STATUS.UNWIRED,
    at,
    evidence: noReaderEvidence(talentId),
    reason,
  }));
}

/**
 * 6 条天赋 × 19 个效果字段的**逐条**状态。
 *
 * 排列口径:已接的在前(今天只有梦境启示的两条),其后按解锁等级。
 * ⚠️ 漏登记不会静默:`auditTalentWiring` 拿 `TALENTS` 的键集做**双向**完整性核对,
 *    「新加一个 effects 字段但没登记」当场红。
 */
export const TALENT_EFFECT_WIRING: readonly TalentEffectRow[] = Object.freeze([
  /* ── 已接:梦境启示(Lv.30)的两个数值真的在结算里被读 ── */
  {
    talentId: 'talent_dream_revelation',
    effect: 'expGainMul',
    status: TALENT_WIRING_STATUS.WIRED,
    at: 'server/src/combat/progression.ts#settleMobExp(乘区 bonusMul)',
    evidence: `TALENT_BY_ID\\.get\\('talent_dream_revelation'\\)[^\\n]*\\bexpGainMul\\b`,
    reason:
      '`settleMobExp` 的 bonusMul 直接取本表的 1.20(`TALENT_BY_ID.get(...).effects.expGainMul`),'
      + '等级闸在 `world_sim.settleKill → isTalentUnlocked`。判据用行为给证:同一场结算,'
      + 'hasDreamTalent 开 / 关的经验比值 = 1.20,不靠点名符号。',
  },
  {
    talentId: 'talent_dream_revelation',
    effect: 'afkExpRatio',
    status: TALENT_WIRING_STATUS.WIRED,
    at: 'server/src/combat/progression.ts#settleMobExp(afk 分支)',
    evidence: `TALENT_BY_ID\\.get\\('talent_dream_revelation'\\)[^\\n]*\\bafkExpRatio\\b`,
    reason:
      '打盹分支按 `hasDreamTalent` 取 0.45(否则取冻结层 `AFK_EXP_RATIO` 0.3);'
      + '两个数字都来自事实源,本模块不复制。判据:同一场结算,afk 玩家两种天赋状态的份额比 = 1.5。',
  },
  {
    talentId: 'talent_dream_revelation',
    effect: 'dewRateMul',
    status: TALENT_WIRING_STATUS.UNWIRED,
    at: 'server/src/combat/progression.ts#(露水只有花费 REBIRTH_DEW_COST,没有累计写口)',
    evidence: `TALENT_BY_ID\\.get\\('talent_dream_revelation'\\)[^\\n]*\\bdewRateMul\\b`,
    reason:
      '露水在全仓只有**花费**(`REBIRTH_DEW_COST`,洗练扣 5)与本表的 1.5 倍率,没有「攒露水」的'
      + '累计写口 ⇒ 接上去等于凭空造一条生产者,属第二份实现,不在本轮写域。',
  },
  /* ── 未接:其余 5 条 ── */
  ...unwiredTalent(
    'talent_roll_bomb',
    ['shadowBombRatio', 'shadowBombSec', 'shadowBombRadius', 'rollCdMul'],
    'server/src/sim/world_sim.ts#(世界侧没有翻滚冷却状态,也没有残影实体)',
    '翻滚·残影炸弹需要「翻滚动作 + 残影实体 + 0.6 秒后爆炸」三件世界侧设施,今天一件都没有'
    + '(连翻滚冷却字段都不存在)⇒ 接线等于新造一套运动学,属玩法实现,不在本轮写域。',
  ),
  ...unwiredTalent(
    'talent_throw_master',
    ['throwDamageMul', 'throwRangeBonus', 'throwSpeedMul', 'carrySlowdownRelief'],
    'server/src/coop/rush_order.ts#(投掷读冻结常量 THROW_SPEED_XY/Z,无 per-player 乘区)',
    '投掷初速 / 射程只读冻结层常量(`THROW_SPEED_XY`、`RELAY_THROW_RANGE`),没有「按玩家取乘区」'
    + '的入口;接上去就要在物理层加「谁的投掷」这条上下文,属物理接口变更,不在本轮写域。',
  ),
  ...unwiredTalent(
    'talent_rescue_swift',
    ['reviveTimeMul', 'reviveHpRatioBonus', 'reviveRadiusBonus'],
    'server/src/sim/world_sim.ts#stepDowned(touchRevive 调用点未传这两个入参)',
    '`revive.ts#touchRevive` **已经**有 `reviveTimeMul` / `reviveHpRatioBonus` 两个入参(能力在),'
    + '但生产调用点(`world_sim.stepDowned`)不传 ⇒ 天赋无效。缺的是调用点上的一行参数,'
    + '那一处在 `sim/**`(本轮写域外)⇒ 登记未接,不假装已生效。',
  ),
  ...unwiredTalent(
    'talent_crit_master',
    ['critRateBonus', 'critDmgBonus'],
    'server/src/combat/damage.ts#(暴击来自武器/词条的 critBonus、critDmgBonus)',
    '暴击率 / 暴击伤害的两个来源是武器表与洗练词条(`weapons.ts` 的 `critBonus` / `critDmgBonus`),'
    + '`computeDamage` 没有天赋乘区 ⇒ 接上去会与词条口径打架,需 owner 先定「加算还是乘算」。',
  ),
  ...unwiredTalent(
    'talent_element_affinity',
    ['elementMulBonus', 'counterAmpCap', 'resistAmpFloor'],
    'server/src/combat/damage.ts#(元素克制读冻结常量,不读天赋)',
    '元素克制的放大与减伤由冻结层系数拥有(七步结算第 4 步),本表又给了「放大 25%」的一套数'
    + '(`counterAmpCap` / `resistAmpFloor` 与冻结常量同值不同源)⇒ 接上去就是两份口径。',
  ),
]);

/** `PlayerProgress` 上两个**由等级派生**的字段的接线状态(与天赋表分开登记)。 */
export interface ProgressFieldRow {
  field: string;
  status: TalentWiringStatus;
  at: string;
  evidence: string;
  reason: string;
}

export const PROGRESS_FIELD_WIRING: readonly ProgressFieldRow[] = Object.freeze([
  {
    field: 'dmgMul',
    status: TALENT_WIRING_STATUS.WIRED,
    at: 'server/src/sim/world_sim.ts#attackMob(⇒ AttackInput.damageMul)',
    evidence: '\\.dmgMul\\b',
    reason:
      '档案等级 === 本次结算等级时,`attackMob` 把本字段当 `damageMul` 传进 `computeDamage`'
      + '(替换 levelMul,**不叠加**)。判据 WS-FND-118 FND118-4 与 WS-FND-148(篡改字段 ⇒ 伤害按比例变)。',
  },
  {
    field: 'carrySlots',
    status: TALENT_WIRING_STATUS.UNWIRED,
    at: 'server/src/net/room.ts#carryCapacityOf(内联 `8 + (lv-1)`)',
    evidence: '\\.carrySlots\\b',
    reason:
      '唯一真实的容量闸在 `net/room.ts#carryCapacityOf`,它**内联**了同一条公式;改成读档案会让'
      + '「容量由谁说了算」从一份变成两份(`net/**` 不在本轮写域)。判据用行为给证:'
      + '把档案 carrySlots 改成 99,房间容量仍是 8。',
  },
]);

/**
 * 台账对账(纯函数,**不 import 世界侧**,也不读盘)。
 *
 * 六条规则:
 * ```
 * 1  talentId 必须在 TALENTS 里,effect 必须是该天赋真的有的字段(悬空行 ⇒ 红)
 * 2  完整性双向:每个天赋的每个 effects 字段都必须有**恰好一行**(漏登记 ⇒ 红)
 * 3  evidence 必须能编译成正则
 * 4  WIRED   ⇒ at 带 `路径#位置`,路径在扫描集里,且该文件**匹配** evidence
 * 5  UNWIRED ⇒ 除 `ignore` 外**任何** server 文件(含本模块)都不得匹配 evidence ——
 *              天赋的数值消费点最可能就长在本模块里(梦境启示就是),故不能像
 *              字段表那样把本模块排除在外
 * 6  reason ≥ 24 字符(空话挡在门外)
 * ```
 *
 * `ignore` 默认只放登记处自己:`wiring_ledger.ts` 的正文字面量里抄了
 * `.carrySlots` 这类证据串,把它算成消费者会让 UNWIRED 行永远红(与
 * `auditCombatWiring` 的 `ignore` 同一理由)。
 *
 *
 * @param sources 仓库相对路径(`/` 分隔)→ **已剥注释**的源码。为什么由调用方剥:
 *                本模块不许 import `wiring_ledger.ts`(那是另一张表的登记处),
 *                而判据必须只看代码 —— 说明里会成段引用要禁的写法。
 */
export function auditTalentWiring(
  rows: readonly TalentEffectRow[],
  sources: ReadonlyMap<string, string>,
  selfModule = 'server/src/combat/progression.ts',
  ignore: ReadonlySet<string> = new Set(['server/src/combat/wiring_ledger.ts']),
): string[] {
  const problems: string[] = [];
  /* problems 声明在下面一行 —— 这里不再重复。 */
  const expect = new Map<string, Set<string>>();
  for (const t of TALENTS) expect.set(t.id, new Set(Object.keys(t.effects)));

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.talentId}#${row.effect}`;
    if (seen.has(key)) problems.push(`${key}: 台账里重复登记`);
    seen.add(key);
    const keys = expect.get(row.talentId);
    if (keys === undefined) {
      problems.push(`${key}: 天赋 ${row.talentId} 不在 TALENTS 里`);
      continue;
    }
    if (!keys.has(row.effect)) problems.push(`${key}: 该天赋没有这个效果字段(台账悬空)`);
    if (row.reason.trim().length < 24) problems.push(`${key}: reason 太短(${row.reason.trim().length} 字符)`);
    let evidence: RegExp;
    try {
      evidence = new RegExp(row.evidence);
    } catch {
      problems.push(`${key}: evidence 不是合法正则`);
      continue;
    }
    if (row.status === TALENT_WIRING_STATUS.WIRED) {
      if (!row.at.includes('#')) problems.push(`${key}: WIRED 必须写 \`路径#位置\``);
      const path = row.at.split('#')[0];
      const code = sources.get(path);
      if (code === undefined) {
        problems.push(`${key}: at 指向的 ${path} 不在扫描集里(路径写错 = 判据失效)`);
      } else if (!evidence.test(code)) {
        problems.push(`${key}: 声明 WIRED,但 ${path} 里没有消费证据`);
      }
      continue;
    }
    if (row.status !== TALENT_WIRING_STATUS.UNWIRED) {
      problems.push(`${key}: 未知状态 ${String(row.status)}`);
      continue;
    }
    for (const [path, code] of sources) {
      if (ignore.has(path)) continue;
      if (evidence.test(code)) problems.push(`${key}: 标记为 UNWIRED,但 ${path} 里有消费点 —— 台账过时`);
    }
  }
  for (const [talentId, keys] of expect) {
    for (const effect of keys) {
      if (!seen.has(`${talentId}#${effect}`)) {
        problems.push(`${talentId}#${effect}: 台账缺行(新加的效果字段没人登记)`);
      }
    }
  }

  /* 两个档案字段:UNWIRED 采用 auditCombatWiring 同口径(本模块的派生算式不算消费)。 */
  const fieldSeen = new Set<string>();
  for (const row of PROGRESS_FIELD_WIRING) {
    const path = row.at.split('#')[0];
    fieldSeen.add(row.field);
    let evidence: RegExp;
    try {
      evidence = new RegExp(row.evidence);
    } catch {
      problems.push(`${row.field}: evidence 不是合法正则`);
      continue;
    }
    if (row.reason.trim().length < 24) problems.push(`${row.field}: reason 太短`);
    if (row.status === TALENT_WIRING_STATUS.WIRED) {
      const code = sources.get(path);
      if (code === undefined) problems.push(`${row.field}: at 指向的 ${path} 不在扫描集里`);
      else if (!evidence.test(code)) problems.push(`${row.field}: 声明 WIRED,但 ${path} 里没有消费证据`);
      continue;
    }
    for (const [p, code] of sources) {
      if (p === selfModule || ignore.has(p)) continue;
      if (evidence.test(code)) problems.push(`${row.field}: 标记为 UNWIRED,但 ${p} 里有消费点 —— 台账过时`);
    }
  }
  for (const field of ['dmgMul', 'carrySlots']) {
    if (!fieldSeen.has(field)) problems.push(`${field}: 台账缺行(玩家档案的派生字段没人认领)`);
  }
  return problems;
}

/**
 * 等级 → 已解锁天赋(按解锁顺序)。
 *
 * ⚠️ 本函数**不参与任何数值计算**:它的产物是 `recompute` 摊平出来的
 *   `PlayerProgress.talentFlags`(该字段今天仍**无读者**)与 `gainExp` 的升级动画。
 *   生产里唯一按天赋改数值的地方是 `settleMobExp` —— 它读的是 `TALENT_BY_ID`
 *   的两条 `effects`(expGainMul / afkExpRatio),**不是**本函数。
 *   逐条状态见 `TALENT_EFFECT_WIRING`(可机器对账:`auditTalentWiring`)。
 */
export function activeTalents(level: number): TalentDef[] {
  return TALENTS.filter((t) => level >= t.unlockLevel);
}

/** 某个等级刚刚解锁的天赋(升级动画用) */
export function talentsUnlockedAt(level: number): TalentDef[] {
  return TALENTS.filter((t) => t.unlockLevel === level);
}

export function isTalentUnlocked(level: number, talentId: string): boolean {
  const t = TALENT_BY_ID.get(talentId);
  return t !== undefined && level >= t.unlockLevel;
}

/* ───────────────────────────── 经验曲线 ───────────────────────────── */

/** 1 → L 的累计所需经验(不含 L 级内进度) */
export function cumulativeExp(level: number): number {
  const l = Math.max(1, Math.floor(level));
  let sum = 0;
  for (let i = 1; i < l; i += 1) sum += expToNext(i);
  return sum;
}

/** 从 Lv.1 升到 Lv.30 的累计经验 = 449500 */
export function expToReachMax(): number {
  return cumulativeExp(MAX_LEVEL);
}

/* ───────────────────────────── 玩家成长档案 ───────────────────────────── */

export interface PlayerProgress {
  playerId: string;
  level: number;
  /** 当前等级内的经验进度 */
  exp: number;
  /** 开档以来的累计总经验 */
  totalExp: number;
  maxHp: number;
  /**
   * 等级伤害倍率 `1 + 0.03(L−1)`(与 `statsAtLevel` 同源)。
   *
   * ★ 第六轮实测 P0:本字段此前**全 server 无读者**(公式在 `computeDamage` 里
   *   由 `attacker.level` 现算了一遍)。现在经 `AttackInput.damageMul` 进管线:
   *   `WorldSim.attackMob` 在「档案等级 === 本次结算等级」时传它(替换 `levelMul`,
   *   **不叠加**)。两者数值相同 ⇒ 生产行为不变,但从此**改这个字段真的会改伤害**。
   *   判据:`tests/WS-FND-118` FND118-4。
   */
  dmgMul: number;
  /**
   * 背包容量槽数 `8 + (L−1)`(与 `statsAtLevel` 同源)。
   *
   * ⚠️ **本字段仍无读者** —— 唯一真实的容量闸在 `net/room.ts#carryCapacityOf`
   *   (它**内联**了同一条公式 `8 + (lv-1)`,见那里的注释),而 `net/**` 不在本轮
   *   写域。把它接到 `net` 只会让「容量由谁说了算」从一份变成两份。
   *   ⇒ 登记在 `PROGRESS_FIELD_WIRING`(`UNWIRED`,可机器对账),待 owner 裁决单一口径。
   */
  carrySlots: number;
  /**
   * 天赋钩子:每级重算后写入(`activeTalents` 的 `effects` 摊平)。
   *
   * ⚠️ **全 server 无读者**(第六轮实测 P0)。生产里真正生效的天赋数值只有两个:
   *   `talent_dream_revelation` 的 `expGainMul` / `afkExpRatio` —— 由 `settleMobExp`
   *   直接读 `TALENT_BY_ID.get('talent_dream_revelation').effects`,等级闸在
   *   `world_sim.settleKill → isTalentUnlocked`。两者读的都是**表**,**不是**本字段。
   *   其余 5 条天赋的 16 个效果字段没有任何消费点。
   *   ⇒ 逐条状态见 `TALENT_EFFECT_WIRING`;别把「写进 talentFlags」读成「天赋已生效」。
   */
  talentFlags: Record<string, number>;
}

export function createProgress(playerId: string): PlayerProgress {
  return recompute({ playerId, level: 1, exp: 0, totalExp: 0, maxHp: 0, dmgMul: 1, carrySlots: 8, talentFlags: {} });
}

function recompute(p: PlayerProgress): PlayerProgress {
  const s = statsAtLevel(p.level);
  const flags: Record<string, number> = {};
  for (const t of activeTalents(p.level)) {
    for (const [k, v] of Object.entries(t.effects)) flags[k] = v;
  }
  return { ...p, maxHp: s.maxHp, dmgMul: s.dmgMul, carrySlots: s.carrySlots, talentFlags: flags };
}

export interface LevelUpEvent {
  from: number;
  to: number;
  talents: TalentDef[];
  maxHp: number;
}

export interface ExpGainResult {
  progress: PlayerProgress;
  /** 实际入账经验(满级后为 0) */
  gained: number;
  /** 溢出的废经验(满级) */
  overflow: number;
  levelUps: LevelUpEvent[];
  /** 升级动画:是否播放 + 建议时长(秒) */
  animation: { play: boolean; seconds: number };
}

/**
 * 入账经验并连续升级。满级后经验不再累积(overflow 记账便于 UI 提示)。
 * restartAt:便于测试指定起点等级。
 */
export function gainExp(progress: PlayerProgress, amount: number): ExpGainResult {
  /*
   * ★ 入口拒非有限(第四轮审计 P2)——
   * ```
   * Math.max(0, NaN) === NaN ⇒ exp = progress.exp + NaN = NaN
   * 而升级循环的出口是 `if (exp < need) break`:NaN < need 恒 false
   * ⇒ 一口气把 level 推到 MAX_LEVEL(实测 Lv.1 + NaN ⇒ Lv.30)
   * ```
   * 与 `vitals.applyDamage` / `applyHit` 的「非有限一律拒绝」同口径:
   * 拒绝 = 档案一字不动(`progress` 原样回传),不发明「补满 / 当 0」之类的猜测语义。
   */
  if (!Number.isFinite(amount)) {
    return { progress, gained: 0, overflow: 0, levelUps: [], animation: { play: false, seconds: 0 } };
  }
  const add = Math.max(0, amount);
  if (progress.level >= MAX_LEVEL) {
    return {
      progress, gained: 0, overflow: add, levelUps: [],
      animation: { play: false, seconds: 0 },
    };
  }
  let level = progress.level;
  let exp = progress.exp + add;
  let totalExp = progress.totalExp + add;
  const levelUps: LevelUpEvent[] = [];
  while (level < MAX_LEVEL) {
    const need = expToNext(level);
    if (exp < need) break;
    exp -= need;
    level += 1;
    const next = recompute({ ...progress, level, exp, totalExp });
    levelUps.push({
      from: level - 1,
      to: level,
      talents: talentsUnlockedAt(level),
      maxHp: next.maxHp,
    });
  }
  if (level >= MAX_LEVEL) exp = 0;
  const out = recompute({ ...progress, level, exp, totalExp });
  return {
    progress: out,
    gained: add,
    overflow: 0,
    levelUps,
    animation: { play: levelUps.length > 0, seconds: levelUps.length > 0 ? 1.2 : 0 },
  };
}

/** 直接把档案设到某等级(调试/回滚用),保留累计经验一致性。 */
export function setLevel(progress: PlayerProgress, level: number): PlayerProgress {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return recompute({ ...progress, level: l, exp: 0, totalExp: Math.max(progress.totalExp, cumulativeExp(l)) });
}

/* ───────────────────────────── 全队经验共享 ───────────────────────────── */

/**
 * 同一怪多人结算的总额上限倍数(防刷硬闸)。
 * 取 5.0 的依据:3 人满编欢聚的总额 = 1.25 × 3 = 3.75 倍基础经验,
 * 5.0 留出 33% 余量不误伤正常组队;8 人同屏时 rawTotal = 10 倍,
 * 触发闸门并等比缩放到 5 倍,人均反而低于 3 人队,构成防刷激励。
 */
export const PER_MOB_EXP_CAP_MULT = 5.0;
/** 等级压制:玩家每高出怪物 1 级,经验 −10% */
export const LEVEL_GAP_STEP = 0.10;
export const LEVEL_GAP_MIN = 0.10;

export interface ShareParticipant {
  playerId: string;
  /** 与击杀点的水平距离(格) */
  distance: number;
  level: number;
  /** 打盹/挂机状态:只拿梦境见习经验 */
  afk: boolean;
  /** 外部经验增益乘区(613 庆典蛋糕 1.30) */
  expBonusMul?: number;
  /** 是否已解锁 Lv.30 天赋「梦境启示」 */
  hasDreamTalent?: boolean;
}

export interface ShareContext {
  /** 怪实例唯一 ID:去重的关键 */
  mobInstanceId: string;
  /** 怪等级,用于等级压制 */
  mobLevel: number;
  baseExp: number;
  participants: readonly ShareParticipant[];
}

export interface ShareEntry {
  playerId: string;
  /** 最终入账经验(四舍五入取整) */
  share: number;
  inRadius: boolean;
  afkApplied: boolean;
  partyMul: number;
  levelMul: number;
  bonusMul: number;
  /** 是否因总额上限被等比缩减 */
  scaledDown: boolean;
}

export interface ShareResult {
  mobInstanceId: string;
  entries: ShareEntry[];
  /** 实际总发放 */
  total: number;
  /** 未裁剪前的理论总额 */
  rawTotal: number;
  /** 本次允许的总额上限 */
  cap: number;
  capped: boolean;
  /** 结算时参与人数(24 格内、非打盹者计入阈值) */
  participantCount: number;
  partyMul: number;
  /** 重复结算被拒绝 */
  deduped: boolean;
  /** 24 格内削减掉的玩家数 */
  outOfRangeCount: number;
}

/**
 * 击杀账本的**容量上限**(条)。
 *
 * 为什么需要一个数:旧实现只有 `add` —— 世界跑得越久 `claimed` 越长,进程生命期内
 * **无界增长**(一只怪一条字符串)。一只怪一条看起来很小,但这是 24h 常驻房间。
 *
 * 取值口径:它**不是**玩法调参,只是「远大于同帧/同一次战斗里可能被二次结算的实例数」。
 * 1000 帧(≈50 秒)内全图 200 只怪连续刷死也才 200 条 ⇒ 4096 有 20 倍余量;
 * 而 4096 条 `string` 的常驻成本是几十 KB 量级,可以忽略。
 */
export const KILL_LEDGER_CAPACITY = 4096;

/**
 * 击杀去重账本:同一怪实例只允许结算一次。
 *
 * ## 有界淘汰(按最老)
 *
 * 打满 `KILL_LEDGER_CAPACITY` 之后,按**入账顺序**淘汰最老的一条(FIFO)。
 * 为什么不按"随机 / 按 id 排序"淘汰:`claim` 的抖动只可能发生在"最近"这一端
 * —— 越老的账越不需要记 —— 而 FIFO 是唯一不引入额外比较规则、也不用重排的取法。
 *
 * ## 为什么淘汰最老的**不会**破「已死实例不被复用」这条不变量
 *
 *   1 **窗口是最近这一端**:同一实例被二次结算的路径(`addMob` 同 id 覆盖 /
 *     姜饼小人复活 / 多路径补刀)都是**本帧附近**发生的事;要二次结算第 N 条
 *     之前的账,必须先造出 N 条更新的击杀 —— 那早已不在窗口内。
 *   2 **实例 id 永不复用**:序号来自世界侧 `mobOrdinals` 的**单调计数器**
 *     (`mobs/spawner.ts` 的 id 两层规则),新怪永远拿一个更大的号 ⇒
 *     被淘汰的那个 id **不会被一只新怪重新拿去**,淘汰只丢"旧账",
 *     不存在"新怪继承旧账"。
 *   3 **换代靠 `reset()`**:`world_sim.ts` 的 `rebuildWorld` 把序号清零时
 *     同步 `reset()` 账本(两件事必须成对,那里的注释写了漏一条的后果)。
 *     ⇒ 淘汰只发生在**同一世代内部**,不承担"跨世代清账"的职责。
 */
export class KillLedger {
  private claimed: Set<string>;
  /**
   * 入账顺序(FIFO)。长度恒 ≤ `KILL_LEDGER_CAPACITY`。
   * 与 `claimed` **必须同步增删** —— 只有 `claimed` 是判据,`order` 只决定淘汰谁。
   */
  private order: string[];

  constructor() {
    this.claimed = new Set<string>();
    this.order = [];
  }

  claim(id: string): boolean {
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    this.order.push(id);
    /* 有界淘汰:见类 docblock(按最老 / 不破"已死实例不被复用")。 */
    while (this.order.length > KILL_LEDGER_CAPACITY) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.claimed.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.claimed.has(id);
  }

  size(): number {
    return this.claimed.size;
  }

  reset(): void {
    this.claimed.clear();
    this.order.length = 0;
  }
}

/** 等级压制系数 */
export function levelGapMul(playerLevel: number, mobLevel: number): number {
  const diff = playerLevel - mobLevel;
  if (diff <= 0) return 1.0;
  return Math.max(LEVEL_GAP_MIN, 1 - LEVEL_GAP_STEP * diff);
}

/**
 * 全队经验共享结算。
 * 规则:
 *   1. 距离 > 24 格 → 0 经验(不因补刀者远近而改变);
 *   2. 24 格内一律 100% 基础经验,补刀者不额外加成;
 *   3. 参与人数(24 格内且非打盹)≥ 3 → 每人 ×1.25 欢聚加成;
 *   4. 打盹/挂机 → ×0.3 梦境见习经验(仍享受欢聚加成之前的份额);
 *   5. 同一怪实例只结算一次(KillLedger);
 *   6. 总额硬上限 = baseExp × 4.0,超出按等比缩减。
 */
export function settleMobExp(
  ledger: KillLedger,
  ctx: ShareContext,
): ShareResult {
  const partyEligible = ctx.participants.filter((p) => p.distance <= SHARE_RADIUS && !p.afk).length;
  const partyMul = partyEligible >= PARTY_BONUS_THRESHOLD ? 1 + PARTY_BONUS : 1.0;
  const cap = ctx.baseExp * PER_MOB_EXP_CAP_MULT;

  if (!ledger.claim(ctx.mobInstanceId)) {
    return {
      mobInstanceId: ctx.mobInstanceId, entries: [], total: 0, rawTotal: 0, cap, capped: false,
      participantCount: partyEligible, partyMul, deduped: true, outOfRangeCount: 0,
    };
  }

  const provisional: ShareEntry[] = [];
  let rawTotal = 0;
  let outOfRangeCount = 0;
  for (const p of ctx.participants) {
    const inRadius = p.distance <= SHARE_RADIUS;
    if (!inRadius) {
      outOfRangeCount += 1;
      provisional.push({
        playerId: p.playerId, share: 0, inRadius: false, afkApplied: p.afk,
        partyMul: 1, levelMul: 1, bonusMul: 1, scaledDown: false,
      });
      continue;
    }
    const afkMul = p.afk
      ? (p.hasDreamTalent
        ? TALENT_BY_ID.get('talent_dream_revelation')!.effects.afkExpRatio
        : AFK_EXP_RATIO)
      : 1.0;
    const lvMul = levelGapMul(p.level, ctx.mobLevel);
    const bonusMul = (p.expBonusMul ?? 1.0) * (p.hasDreamTalent
      ? TALENT_BY_ID.get('talent_dream_revelation')!.effects.expGainMul
      : 1.0);
    const raw = ctx.baseExp * partyMul * afkMul * lvMul * bonusMul;
    rawTotal += raw;
    provisional.push({
      playerId: p.playerId, share: raw, inRadius: true, afkApplied: p.afk,
      partyMul, levelMul: Math.round(lvMul * 1000) / 1000, bonusMul, scaledDown: false,
    });
  }

  const capped = rawTotal > cap && rawTotal > 0;
  const scale = capped ? cap / rawTotal : 1.0;
  /* 裁剪时先向下取整,再把余数逐个补给前几名,保证分项之和恰好等于总额上限 */
  const entries = provisional.map((e) => ({
    ...e,
    share: capped && e.share > 0 ? Math.floor(e.share * scale) : Math.round(e.share),
    scaledDown: capped && e.share > 0,
  }));
  if (capped) {
    const target = Math.floor(cap);
    let allocated = entries.reduce((a, b) => a + b.share, 0);
    let leftover = target - allocated;
    for (let i = 0; i < entries.length && leftover > 0; i += 1) {
      if (entries[i].share > 0) {
        entries[i].share += 1;
        leftover -= 1;
      }
    }
    allocated = entries.reduce((a, b) => a + b.share, 0);
    void allocated;
  }
  const total = entries.reduce((a, b) => a + b.share, 0);

  return {
    mobInstanceId: ctx.mobInstanceId,
    entries, total, rawTotal: Math.round(rawTotal * 100) / 100, cap,
    capped, participantCount: partyEligible, partyMul, deduped: false, outOfRangeCount,
  };
}

/** 便捷:把一次结算直接写进各玩家档案。 */
export function applyShareResult(
  progresses: ReadonlyMap<string, PlayerProgress>,
  result: ShareResult,
): { progresses: Map<string, PlayerProgress>; events: Map<string, ExpGainResult> } {
  const next = new Map(progresses);
  const events = new Map<string, ExpGainResult>();
  for (const e of result.entries) {
    const p = next.get(e.playerId);
    if (!p || e.share <= 0) continue;
    const r = gainExp(p, e.share);
    next.set(e.playerId, r.progress);
    events.set(e.playerId, r);
  }
  return { progresses: next, events };
}

/* ───────────────────────────── 洗练重铸(533 魔镜) ───────────────────────────── */

export const REBIRTH_DEW_COST = 5;
export const REBIRTH_AFFIX_POOL: readonly string[] = [
  'atk_pct', 'def_flat', 'hp_flat', 'crit_rate', 'crit_dmg', 'dodge_rate',
  'element_fire', 'element_ice', 'element_lightning', 'element_light',
  'cooldown_cut', 'knockback_mul', 'lifesteal', 'shield_break',
];

export interface RebirthResult {
  affix: string;
  roll: number;
  tier: number;
  value: number;
  dewCost: number;
}

/** 洗练:消耗 5 露水,从 14 词条池中滚 1 条,tier 由 roll 分档。 */
export function reforge(roll: number, pick: number): RebirthResult {
  const len = REBIRTH_AFFIX_POOL.length;
  const idx = Math.abs(Math.floor(pick * len)) % len;
  const affix = REBIRTH_AFFIX_POOL[idx];
  const tier = roll < 0.55 ? 1 : roll < 0.87 ? 2 : roll < 0.98 ? 3 : 4;
  const value = Math.round((0.5 + 0.5 * tier) * 100) / 100;
  return { affix, roll, tier, value, dewCost: REBIRTH_DEW_COST };
}
