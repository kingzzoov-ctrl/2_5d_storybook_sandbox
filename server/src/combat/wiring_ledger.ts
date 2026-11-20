/**
 * WS-FND-118 —— 战斗侧「实现了但没接」的**具名台账**(第六轮实测 P0/P1/P2/P3)。
 *
 * ## 为什么要有这个文件
 *
 * 第六轮的实测把 `combat/**` 里的一批符号钉成三类:
 *
 * ``` 
 * 甲  真接线     生产里有消费者(本轮刚接上的那些)
 * 乙  接不了     有理由:规则已被别处拥有 / 接上去就是第二份实现 / 写域外
 * 丙  预留       UI 或将来动作层会读,今天没人读
 * ```
 *
 * 修前这些符号的注释各说各话(「供战斗管线读取」写在一个 0 读者的字段上),于是
 * 「实现了但没接」只能靠人肉审计发现 —— 每次审计都要重读 8 个文件。⇒ 收成一张表,
 * 且**可机器判**:`auditCombatWiring` 按状态双向对账(见下)。
 *
 * ## 判据的双极性(这是它有牙的地方)
 *
 * ``` 
 * WIRED    声明了消费点 ⇒ 那个文件里必须真的**有**这个符号的消费证据(剥注释后)
 * UNWIRED  声明没人读   ⇒ 除本模块外**任何** server/src 文件都不得出现消费证据
 * ``` 
 *
 * 两条方向相反、用的是同一个扫描器 ⇒ 某一行的状态写错、或者读者被谁悄悄接上/摘掉,
 * 都会当场红。**「注释里说已生效」不再是唯一证据。**
 *
 * ⚠️ 本文件只做**登记与对账**,不做任何运行时动作 —— 不 import 任何模块,
 * 因此不会把「未接线」变成「接线」(本仓最容易自我欺骗的那种绿)。
 */

export const WIRING_STATUS = {
  /** 生产里有消费者(证据在 `wiredAt`)。 */
  WIRED: 'WIRED',
  /** 生产里**没有**消费者,且**不应该**在本轮接 —— 理由写在 `reason`。 */
  UNWIRED: 'UNWIRED',
  /** 预留:有明确的下游计划(UI / 将来动作层),今天没人读。 */
  RESERVED: 'RESERVED',
} as const;
export type WiringStatus = (typeof WIRING_STATUS)[keyof typeof WIRING_STATUS];

export interface CombatWiringRow {
  /** 符号名。判据按**标识符**匹配(`\bSYM\b`),不是子串 —— 否则 `float` 会命中 `floaty`。 */
  symbol: string;
  /** 符号所在模块(仓库相对路径,`/` 分隔)。 */
  module: string;
  status: WiringStatus;
  /**
   * 生产消费点(仅 `WIRED` 必填):`路径#方法/位置`。
   * 只用到 `#` 之前的路径 —— 后半是给人看的锚点。
   */
  wiredAt?: string;
  /**
   * 消费证据的正则源。缺省 = `\bsymbol\s*\(`(调用形态)。
   * 字段/常量类符号必须显式给(例:`\.carrySlots\b`),否则同名函数会误判。
   */
  evidence?: string;
  /**
   * 「死路」链:本符号**只**被这个符号读,而那个符号自己也是 `UNWIRED`。
   *
   * 例:PRANK_HAMMER_KNOCKBACK 只被 allyPrankHit 读,后者 UNWIRED ⇒ 常量生产零效果。
   * 判据两条:① 本行有 chain ⇒ 跳过反向扫描(「有读者」与「有活的读者」是两件事);
   * ② 台账里必须真的存在一行该符号且状态 ≠ WIRED(否则「死路」是空话)。
   */
  chain?: string;
  /** 现状 + 理由(必填;≥ 24 字符 —— 空话过不了判据)。 */
  reason: string;
}

/**
 * 台账本体。
 *
 * 排序口径:`WIRED` 在前(本轮真的接上的),其后 `UNWIRED`,最后 `RESERVED`。
 * 同一状态内按符号名 —— 便于与 `grep` 结果对账。
 */
export const COMBAT_WIRING_LEDGER: readonly CombatWiringRow[] = Object.freeze([
  /* ═══════════════ 甲 WIRED:本轮接上的(每条都指向真实消费点)═══════════════ */
  {
    symbol: 'skillOf',
    module: 'server/src/combat/weapons.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#attackMob(useSkill ⇒ 武器 [Q] 技能)',
    reason:
      '第六轮 P0:13 把武器的 [Q] 技整组不可达(生产 0 调用)。现在 attackMob 在 useSkill 时'
      + '从武器取技能;attackMobAuthorized 转发该意图 ⇒ 玩家→生物这条路上技能真的会打。'
      + '仍未接的两处(都不在本轮写域):① net 层没有 [Q] 的动作报文(客户端按键到不了这里,'
      + '"剩余缺口"的一头);② PvP(attackPlayerAuthorized)仍显式传 skill: null ——'
      + '技能打人与否是玩法裁决,不在战斗侧自行放开。',
  },
  {
    symbol: 'planSkillHits',
    module: 'server/src/combat/damage.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#attackMob(段数 + 命中区域)',
    reason:
      '段数取 plan.ticks.length(715 三连 = 3 / 716 箭雨 = 6),命中区域进 events。'
      + '★ 第七轮 P2 起**时序也接了**:telegraphSec + tickSec 进 `skillTiming`,'
      + '本帧只结算「到期」的段,其余进 `WorldSim.tickSkillCasts`(716 的 6 段分布在 2.5 秒、'
      + '718 的 1 秒前摇真的存在)。'
  },
  {
    symbol: 'reflectFrom',
    module: 'server/src/combat/damage.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#resolveMobStrikes(怪打人 ⇒ 反伤回打生物)',
    reason:
      '第六轮 P1:728 反伤甲在「怪打人」方向完全无效。现在按承伤 × 玩家 reflectMul 折算,'
      + '经 damageMob 施加回攻击者(反伤也能击杀,击杀照常结算)。'
      + '★ 第七轮 P2 起口径统一成「**实际扣除**」:折算基数是 min(applied, 受击前 HP),'
      + '累计读 damageMob 的 hpLoss;生物 reflectMul 恒 0 ⇒ 反伤单跳不成环。'
  },
  {
    symbol: 'ghostControl',
    module: 'server/src/combat/revive.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#canActAsPlayer(两条攻击入口共用)',
    reason:
      '第六轮 P1:幽灵期规则两套 —— 攻击闸手判 vitals.downed,而 ghostControl 生产 0 调用。'
      + '现在 canAttack 由 ghostControl 给;moveMul / canBeHealed 仍由 vitals 拥有(同一帧真值只有它有),'
      + '那两半不接。',
  },
  {
    symbol: 'cleansePrankBuffs',
    module: 'server/src/combat/cooking.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#useItem(料理分支,flags.cleanse === true)',
    reason:
      '第六轮 P2:612 净化饮此前只加一条 cleanse 标记,已有的整蛊 buff 一条不掉。'
      + '现在按内容表的 flag 触发,不在编排层写 itemId === 612 的第二份判据。',
  },
  {
    symbol: 'extinguishStation',
    module: 'server/src/combat/cooking.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#extinguishStationAt(委托)',
    reason:
      '第六轮 P2:与 WorldSim.extinguishStationAt 手写 fireOut = true 是同一件事的两份实现。'
      + '现在世界侧委托本函数 ⇒ 写点唯一(relightStationAt 是可逆那一半)。',
  },
  {
    symbol: 'dmgMul',
    module: 'server/src/combat/progression.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#attackMob(⇒ AttackInput.damageMul)',
    evidence: '\\.dmgMul\\b',
    reason:
      '第六轮 P0:PlayerProgress.dmgMul 全 server 无读者。现在按「档案等级 === 结算等级」'
      + '传给 computeDamage 的 damageMul(替换 levelMul,不叠加)⇒ 改这个字段真的会改伤害。',
  },

  /* ═══════════════ 乙 UNWIRED:接不了 / 不该接(逐条理由)═══════════════ */
  {
    symbol: 'TALENTS',
    module: 'server/src/combat/progression.ts',
    status: WIRING_STATUS.UNWIRED,
    reason:
      '第六轮 P0:6 条天赋没有生产效果。talentFlags 无读者 ⇒ 本表只在升级动画(events)里被看见。'
      + '接线需要玩法裁决(每条天赋改哪个计算点),不在本任务写域内可定 ⇒ 如实登记。',
  },
  {
    symbol: 'activeTalents',
    module: 'server/src/combat/progression.ts',
    status: WIRING_STATUS.UNWIRED,
    reason:
      '消费面只有本模块内的 recompute(摊平进 talentFlags,而后者无读者)与 gainExp 的升级事件。'
      + '生产里没有任何一条按天赋改数值的路径。',
  },
  {
    symbol: 'talentsUnlockedAt',
    module: 'server/src/combat/progression.ts',
    status: WIRING_STATUS.UNWIRED,
    reason: '只在 gainExp 的 LevelUpEvent 里被调用(升级动画数据),不参与任何数值计算。',
  },
  {
    symbol: 'talentFlags',
    module: 'server/src/combat/progression.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/sim/world_sim.ts#exportPlayerSnapshots(天赋随档案快照落库)',
    evidence: '\\.talentFlags\\b',
    reason:
      '★ 第十一轮(审计 FND118-10/12):本行此前写 UNWIRED —— 「读取点 = 0」在写它的时候是'
      + '真的,但 R2 的档案快照线给 `world_sim.ts#exportPlayerSnapshots` 加了一个真读者:'
      + '`row.talent = Object.keys(p.talentFlags).sort()`(每名玩家的天赋 id 列表随快照落库,'
      + '重连/换房后能读回来)。⇒ 按**实测**改成 WIRED(消费点在 world_sim,不在定义模块内)。'
      + '整表登记仍在:不许把「写进 talentFlags」说成「天赋数值已生效」—— 天赋是否改数值由'
      + '`TALENT_EFFECT_WIRING`(progression.ts)逐条对账,那是另一件事。',
  },
  {
    symbol: 'carrySlots',
    module: 'server/src/combat/progression.ts',
    status: WIRING_STATUS.WIRED,
    wiredAt: 'server/src/net/room.ts#carryCapacityOf(容量闸的唯一口径)',
    evidence: '\\bcarryCapacityOfLevel\\s*\\(|\\bcarrySlotsOf\\b',
    reason:
      '★ WS-FND-152(owner 裁定「全接」):背包容量槽数此前**无读者** —— 唯一真实的容量闸'
      + '(`net/room.ts#carryCapacityOf`)内联了同一条算式 `8 + (lv-1)`,于是改档案/改冻结层都不影响房间容量。'
      + '现在房间侧改调本层的 `carryCapacityOfLevel`(与 `statsAtLevel` 同源),并优先读世界源的'
      + ' `carrySlotsOf(userId)`(档案字段)。'
      + '(注意 `mobs/taming.ts` 的 `carrySlots()` 是宠物负载槽,同名不同概念 —— 别混。)',
  },
  {
    symbol: 'ghostDamageMul',
    module: 'server/src/combat/revive.ts',
    status: WIRING_STATUS.UNWIRED,
    reason:
      '第六轮 P1:与 vitals.applyHit / applyDamage 开头的 if (v.downed) return 是同一条规则。'
      + '瞬时真值只在 vitals 手里(HP 归零的同一帧),接上去就是第二份判据 ⇒ 规则归 vitals 拥有。',
  },
  {
    symbol: 'tickInvuln',
    module: 'server/src/combat/revive.ts',
    status: WIRING_STATUS.UNWIRED,
    reason:
      '复活无敌的唯一执行点是 vitals.iframeSec(task-64 已把 revive() 的秒数转写进那一套)。'
      + '本函数递减的 DownedState.invulnSec 到不了受击判定 ⇒ 接上等于第三套无敌。',
  },
  {
    symbol: 'isInvulnerable',
    module: 'server/src/combat/revive.ts',
    status: WIRING_STATUS.UNWIRED,
    evidence: '\\.isInvulnerable\\b|\\bisInvulnerable\\s*\\(',
    reason:
      '读的是 DownedState.invulnSec(无生产读者,见 tickInvuln 行)。受击判定的无敌在 vitals.iframeSec。',
  },
  {
    symbol: 'allyPrankHit',
    module: 'server/src/combat/damage.ts',
    status: WIRING_STATUS.UNWIRED,
    reason:
      '第六轮 P1:222 整蛊锤「对队友 0 伤害 + 8 格/秒击退」没有入口。'
      + 'attackPlayerAuthorized 走 pvpVerdict(fail-closed:开关关 ⇒ 拒绝),'
      + '「友军整蛊」的授权形态属玩法+net 动作层裁决(写域外)⇒ 不擅自开一条绕过 PvP 的路。',
  },
  {
    symbol: 'extinguishFire',
    module: 'server/src/combat/cooking.ts',
    status: WIRING_STATUS.UNWIRED,
    reason:
      '第六轮 P2:入参是 FireCell[](x / y / intensity),而全仓**没有该数组的生产者**:'
      + '地形火在 FluidField / rooms/effects 里是另一套表示。给不存在的表接线只会造出恒空调用点。',
  },
  {
    symbol: 'PRANK_HAMMER_KNOCKBACK',
    module: 'server/src/combat/weapons.ts',
    status: WIRING_STATUS.UNWIRED,
    evidence: '\\bPRANK_HAMMER_KNOCKBACK\\b',
    /* 只被 allyPrankHit 读,而后者自己 UNWIRED ⇒ 生产零效果。台账要求这个"死路"名字
       本身有一行 UNWIRED(见 auditCombatWiring 的 chain 规则)。 */
    chain: 'allyPrankHit',
    reason:
      '222 整蛊锤的固定击退量(8 格/秒)。唯一读者是 allyPrankHit(damage.ts),而它本身 UNWIRED'
      + ' ⇒ 生产零效果。world_sim 曾 import 它给受击位移取数,接上会打红 WS-10 的三条既有判据'
      + ' ⇒ 撤下,等 owner 定受击击退口径。',
  },

  /* ★ 第十一轮补登(测量法:全仓 `\bSYM\b` 逐名 grep —— server/src + client/src + shared
     三层里**除定义处之外零命中**,连测试都没读)。它们与 `PRANK_HAMMER_KNOCKBACK` 是同一类:
     内容表给了数值,而对应的机制**没有任何执行点** ⇒ 只能写 UNWIRED,不能写「已生效」。 */
  {
    symbol: 'TAUNT_RADIUS',
    module: 'server/src/combat/weapons.ts',
    status: WIRING_STATUS.UNWIRED,
    evidence: '\\bTAUNT_RADIUS\\b',
    reason:
      '242 大声公扩音喇叭「强制 8 格内怪物仇恨转向」的半径常量,全仓**零读者**(生产与测试都没有):'
      + '怪物仇恨表在 `mobs/aggr.ts` 那一侧另有口径,而「谁被嘲讽转向」是玩法裁决(要不要覆盖仇恨表)'
      + '不在战斗侧自行放开 ⇒ 如实登记为未接,别把它读成「嘲讽已生效」。',
  },
  {
    symbol: 'KAIROS_CRIT_BONUS',
    module: 'server/src/combat/weapons.ts',
    status: WIRING_STATUS.UNWIRED,
    evidence: '\\bKAIROS_CRIT_BONUS\\b',
    reason:
      '251 黄金凯旋小号「全队暴击率 +15%」的加成常量,全仓**零读者**(生产与测试都没有):'
      + '它要接的是「队伍范围 + 持续时长」两条规则(谁是队友 / 加成何时失效),而那两条今天只'
      + '存在于派对与 buff 两套机制里 ⇒ 接上去就是第二份口径,等 owner 定再动。',
  },
  /* ═══════════════ 丙 RESERVED:预留(有下游,今天没人读)═══════════════ */
  {
    symbol: 'shieldLeft',
    module: 'server/src/combat/damage.ts',
    status: WIRING_STATUS.RESERVED,
    evidence: '\\.shieldLeft\\b',
    reason:
      'AppliedDamage.shieldLeft 是「这一刀把盾打剩多少」的唯一出处,但 server/** 无读者(仅测试)。'
      + '不删:删了测试要自己再算一遍;保留:它**不是**任何玩法规则的执行点。',
  },
  {
    symbol: 'float',
    module: 'server/src/combat/damage.ts',
    status: WIRING_STATUS.RESERVED,
    evidence: '\\.float\\b',
    reason:
      '第六轮 P3:DamageResult.float(飘字规格)在 server/** 无消费者。UI 侧尚未接 '
      + 'floatText / reflectFloat / healFloat ⇒ 留作预留,别把它读成「飘字已生效」。',
  },
  {
    symbol: 'steps',
    module: 'server/src/combat/damage.ts',
    status: WIRING_STATUS.RESERVED,
    evidence: '\\.steps\\b',
    reason:
      '第六轮 P3:八步明细(steps)只有测试读,server/** 无消费者(不进快照/不落库)。'
      + '它是审计与判据的证据链,刻意保留为预留;同样不是玩法执行点。',
  },
]);

/* ───────────────────────────── 台账对账(纯函数)───────────────────────────── */

/** 消费证据的缺省形态:调用 `sym(...)`。字段类符号必须用 `evidence` 覆盖。 */
export function evidenceOf(row: CombatWiringRow): RegExp {
  return new RegExp(row.evidence ?? `\\b${row.symbol}\\s*\\(`);
}

/**
 * 剥掉注释后的**代码**(判据只看代码:本仓的说明里会成段引用被修的写法)。
 *
 * 逐字符扫,不用正则 ⇒ `https://` 之类的行注释不会被误伤
 * (与 `tests/WS-FND-117` 的同名工具同口径)。
 */
export function stripCommentsForAudit(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      out += ' ';
      continue;
    }
    if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/**
 * 台账对账:返回**问题清单**(空数组 = 全绿)。
 *
 * ## 六条规则
 *
 * ``` 
 * 1  module 必须在 sources 里(路径写错 = 判据失效,不许静默)
 * 2  symbol 必须在 module 里以标识符出现(符号改名 ⇒ 红)
 * 3  evidence 必须能编译成正则
 * 4  WIRED    ⇒ wiredAt 必填、文件在 sources、且 ≠ module、且该文件**匹配**证据
 * 5  UNWIRED / RESERVED ⇒ 除 module 外**任何**文件都**不得匹配**证据
 * 6  reason 必须 ≥ 24 字符(空话挡在门外)
 * ``` 
 *
 * @param rows 台账行(测试会**注入**篡改过的行来证明本函数有牙)
 * @param sources 仓库相对路径(`/` 分隔)→ 文件原文
 * @param ignore 不参与「反向扫描」的路径。**只给台账自己用**:它是登记处,
 *               正文里的字符串会引用符号名(`'symbol': 'float'` 之类),
 *               把它算成消费者会让每条 RESERVED/UNWIRED 行永远红。
 */
export function auditCombatWiring(
  rows: readonly CombatWiringRow[],
  sources: ReadonlyMap<string, string>,
  ignore: ReadonlySet<string> = new Set<string>(),
): string[] {
  const problems: string[] = [];
  const codeOf = (path: string): string | null => {
    const raw = sources.get(path);
    return raw === undefined ? null : stripCommentsForAudit(raw);
  };

  for (const row of rows) {
    const self = codeOf(row.module);
    if (self === null) {
      problems.push(`${row.symbol}: 模块 ${row.module} 不在扫描集里(路径写错 = 判据失效)`);
      continue;
    }
    if (!new RegExp(`\\b${row.symbol}\\b`).test(self)) {
      problems.push(`${row.symbol}: 在 ${row.module} 里找不到这个标识符(改名了?台账没跟上)`);
    }
    let evidence: RegExp;
    try {
      evidence = evidenceOf(row);
    } catch {
      problems.push(`${row.symbol}: evidence 不是合法正则`);
      continue;
    }
    if (row.reason.trim().length < 24) {
      problems.push(`${row.symbol}: reason 太短(${row.reason.trim().length} 字符)—— 台账不许写空话`);
    }
    if (row.status === WIRING_STATUS.WIRED) {
      if (row.wiredAt === undefined || row.wiredAt.length === 0) {
        problems.push(`${row.symbol}: WIRED 必须写 wiredAt`);
        continue;
      }
      const path = row.wiredAt.split('#')[0];
      const consumer = codeOf(path);
      if (consumer === null) {
        problems.push(`${row.symbol}: wiredAt 指向的 ${path} 不在扫描集里`);
        continue;
      }
      if (path === row.module) {
        problems.push(`${row.symbol}: wiredAt 指向本模块 —— 模块内自用不算接线`);
      }
      if (!evidence.test(consumer)) {
        problems.push(`${row.symbol}: 声明了 WIRED,但 ${path} 里没有消费证据`);
      }
      continue;
    }
    /* UNWIRED / RESERVED:反向 —— 除了本模块,谁都不许读它。
       `chain` 例外:只被一个**死的**符号读(那条链由末尾的 chain 规则另行核对)。 */
    if (row.chain !== undefined) continue;
    for (const [path, raw] of sources) {
      if (path === row.module || ignore.has(path)) continue;
      const code = stripCommentsForAudit(raw);
      if (evidence.test(code)) {
        problems.push(`${row.symbol}: 标记为 ${row.status},但 ${path} 里有消费点 —— 台账过时`);
      }
    }
  }
  /* 重复符号会让「这一行的状态」失去唯一性。 */
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.symbol)) problems.push(`${row.symbol}: 台账里重复登记`);
    seen.add(row.symbol);
  }
  /* chain 的第二条判据:名字必须真的**死**在台账里 —— 否则「只被死符号读」是空话,
     明天那个符号接了线,这一行仍然写着 UNWIRED 而没人会注意。 */
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  for (const row of rows) {
    if (row.chain === undefined) continue;
    const target = bySymbol.get(row.chain);
    if (target === undefined) {
      problems.push(`${row.symbol}: chain 指向的 ${row.chain} 不在台账里(死路必须可查)`);
    } else if (target.status === WIRING_STATUS.WIRED) {
      problems.push(`${row.symbol}: chain 指向的 ${row.chain} 已经接线 ⇒ 本行不该再写 ${row.status}`);
    }
  }
  return problems;
}