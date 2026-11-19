/**
 * ★ WS-FND-120 · 整蛊动作层(把玩具表 / 218 和平盾 / 免疫清单接上运行期判定)
 *
 * ## 修的是什么
 *
 * 第六轮实测:`PRANK_TOYS` / `toyOf` / `isImmuneToAllyPrank` / `resolveShield`
 * 在**生产里零 import** —— 35 件玩具表与 218 和平盾的免疫清单都只是「数据」,
 * 没有任何运行期判定读过它们。于是「队友 0 伤害」「和平盾免疫香蕉皮」这些
 * 手册条款在游戏里**不存在**,只存在于 `tests/WS-11` 的纯函数断言里。
 *
 * ## 这个文件为什么是「动作层」而不是「玩法实现」
 *
 * 玩具的**物理后果**(击退位移、眩晕计时、变形外观)属于战斗/物理层;本层只做
 * 一件战斗层做不到的事:**在施加效果之前**,把「这一下该不该生效」判完 ——
 * 因为它要同时看玩具表(表里没有的 ID)、免疫清单(218)与来源(ALLY/SELF/HOSTILE)。
 * 施不施加由调用方按 `accepted && !blocked` 决定。
 *
 * ## 方向:严格向下
 *
 * 只 import `prank/toys.ts` 与 `prank/immunity.ts`(同目录纯模块)。
 * 不 import `net/**`、`physics/**`、`combat/**` —— 见
 * `docs/WS-11-coop-prank-party.md:745` 的禁用耦合。
 *
 * ## 具名台账(唯一入口:`PRANK_ACTION_LEDGER`)
 *
 * 修前的说法是「整蛊玩具已实现」,而实际是「表已实现、判定无消费者」。
 * 台账把**每一件玩具的三条路**逐列写清(WS-FND-148 起):
 * ```
 * path    掉冠(contestCrownDrop → gateCrownKnock)—— WS-FND-120 冻结口径
 * player  玩家→玩家(use_item 的 221..255 分支 → gatePrank → applyPrankToTarget)
 * enemy   玩家→怪物(enemyEffect 的落点;今天 35 件全 NONE,理由逐行写清)
 * ```
 * 判据见 `tests/WS-FND-120`(掉冠列)与 `tests/WS-FND-148`(三列对账)。
 */

import {
  PRANK_TOYS,
  PRANK_TOY_BY_ID,
  PRANK_TOY_ID_MAX,
  PRANK_TOY_ID_MIN,
  SAFE_SHIELD_ITEM_ID,
  toyOf,
  type PrankToyDef,
  type ToyStateFlag,
} from './toys.ts';
import {
  EFFECT_ORIGIN,
  isImmuneToAllyPrank,
  resolveShield,
  type EffectOrigin,
  type ShieldResolution,
} from './immunity.ts';

/** 218 和平盾(工程安全帽)的物品 ID —— 与 `toys.ts#SAFE_SHIELD_ITEM_ID` 同一件。 */
export const PRANK_SHIELD_ITEM_ID = SAFE_SHIELD_ITEM_ID;

/** 拒绝原因词表(与 `useItem` 家族的 `reason` 同风格:大写下划线,可直接进报文)。 */
export const PRANK_REJECT = {
  UNKNOWN_TOY: 'UNKNOWN_TOY',
  SELF_TARGET: 'SELF_TARGET',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  SHIELDED: 'SHIELDED_218',
  OK: 'OK',
} as const;
export type PrankReject = (typeof PRANK_REJECT)[keyof typeof PRANK_REJECT];

/**
 * 手册点名的**掉冠**来源(整蛊玩具):222 充气大锤击退 / 225 香蕉皮 / 224 钩爪拽倒。
 * 出处:`party/modes.ts#crownDrop` 的注释(「被 222 大锤击退 / 225 香蕉皮 / 224 钩爪
 * 拽倒」)。这三个 ID 都必须在 `PRANK_TOYS` 里 —— 由下面的 `assertCrownKnockToys()` 自检。
 */
export const CROWN_KNOCK_TOY_IDS: readonly number[] = [222, 225, 224];

export interface PrankActionRequest {
  actorId: string;
  targetId: string;
  /** 玩具物品 ID(221..255) */
  toyId: number;
  /** 两人距离(格);由调用方用**权威坐标**算,本层不读世界 */
  distance: number;
  /** 是否同队(队伍归属的唯一来源是派对容器的 435 复活旗选色) */
  ally: boolean;
  /** 218 和平盾开关;`false` = 没开/**没有生产者**(见台账) */
  shieldOn: boolean;
}

export interface PrankActionOutcome {
  /** 玩具合法且前置满足(不含盾的判定) */
  accepted: boolean;
  /** 218 和平盾拦住了(不施加任何状态/位移/伤害) */
  blocked: boolean;
  reason: PrankReject;
  toy: PrankToyDef | null;
  origin: EffectOrigin;
  /** 该打上的状态标记(被拦 ⇒ null) */
  flag: ToyStateFlag | null;
  /** 位移格数(被拦 ⇒ 0) */
  moveTiles: number;
  stunSec: number;
  /** 盾的裁定明细(未开盾也会有一份:`SHIELD_OFF`) */
  shield: ShieldResolution | null;
}

/**
 * 「这一下整蛊该不该生效」的唯一判定。
 *
 * 判序(每条对着一条判据):
 *   1 玩具表查得到(`toyOf` 查不到 ⇒ `UNKNOWN_TOY`,**不抛错**:客户端自报的 ID
 *     不能把动作层打死);
 *   2 不能打自己(`SELF_TARGET`);
 *   3 距离在玩具自己的 `radius` 内(`OUT_OF_RANGE`;半径来自表,不另设常量);
 *   4 队友 ⇒ 走 `isImmuneToAllyPrank`(和平盾的**队友整蛊**免疫);
 *      敌对 ⇒ 走 `resolveShield(..., HOSTILE)`,而手册规则是「怪物/环境伤害恒穿透」
 *      ⇒ 这里必然 `blocked=false`(它由免疫清单的 `hostileImmune=false` 决定,
 *      不是本层另行写死)。
 */
export function resolvePrankAction(req: PrankActionRequest): PrankActionOutcome {
  const origin = req.ally ? EFFECT_ORIGIN.ALLY : EFFECT_ORIGIN.HOSTILE;
  const empty: PrankActionOutcome = {
    accepted: false, blocked: false, reason: PRANK_REJECT.UNKNOWN_TOY, toy: null,
    origin, flag: null, moveTiles: 0, stunSec: 0, shield: null,
  };

  let toy: PrankToyDef;
  try {
    toy = toyOf(req.toyId);
  } catch {
    return empty;
  }

  if (req.actorId === req.targetId) {
    return { ...empty, toy, reason: PRANK_REJECT.SELF_TARGET };
  }
  if (!Number.isFinite(req.distance) || req.distance > toy.radius) {
    return { ...empty, toy, reason: PRANK_REJECT.OUT_OF_RANGE };
  }

  const shield = resolveShield(req.shieldOn, toy.id, origin);
  const blocked = req.ally ? isImmuneToAllyPrank(req.shieldOn, toy.id) : shield.blocked;
  if (blocked) {
    return { ...empty, toy, reason: PRANK_REJECT.SHIELDED, blocked: true, shield };
  }

  const eff = req.ally ? toy.allyEffect : toy.enemyEffect;
  return {
    accepted: true,
    blocked: false,
    reason: PRANK_REJECT.OK,
    toy,
    origin,
    flag: eff.flag,
    moveTiles: eff.moveTiles,
    stunSec: toy.stunSec,
    shield,
  };
}

/** 掉冠判定的回执(世界侧的抢皇冠慢帧用)。 */
export interface CrownKnockOutcome {
  /** 皇冠是否落地 */
  drop: boolean;
  reason: string;
  /** 拦住它的玩具 ID(被盾挡下的候选);没有挡 ⇒ null */
  blockedBy: number | null;
  /** 参与判定的候选玩具(逐个经 `toyOf` 验明在表内) */
  candidates: number[];
}

/**
 * 抢皇冠 · 「持冠者被整蛊玩具击退 ⇒ 掉冠」的唯一判定。
 *
 * ## 为什么需要它
 *
 * `crownDrop`(`modes.ts`)的注释写着三种掉冠来源,而它修前**生产零调用**:
 * 世界侧没有「谁被整蛊了」的入口。这里把三件候选玩具逐个过一遍
 * **218 和平盾**的队友免疫:全被拦 ⇒ 不掉冠(手册「和平盾免疫香蕉皮」);
 * 只要有一件能穿过 ⇒ 掉冠。
 *
 * ## 诚实的边界
 *
 * 世界侧今天只知道「持冠者被击退了」(`knockbackOf`),**不知道是哪一件玩具**
 * ⇒ 这里按「三件都试,有一件能穿过就算被击退」判。要精确到玩具 ID,得让
 * 击退管线(战斗层)把 `sourceItemId` 传下来 —— 那是动作层的欠账,登记在
 * `PRANK_ACTION_LEDGER` 的 `NONE` 行里,不在这里假装已经知道。
 */
export function resolveCrownKnock(opts: { shieldOn: boolean }): CrownKnockOutcome {
  const candidates = [...CROWN_KNOCK_TOY_IDS];
  for (const id of candidates) {
    /* 表外 ID 直接丢:静止引用会随玩具表改动而静默失效。 */
    toyOf(id);
  }
  for (const id of candidates) {
    if (!isImmuneToAllyPrank(opts.shieldOn, id)) {
      return { drop: true, reason: `PASS:${id}`, blockedBy: null, candidates };
    }
  }
  const world = resolveShield(opts.shieldOn, candidates[0], EFFECT_ORIGIN.ALLY);
  return { drop: false, reason: world.reason, blockedBy: candidates[0], candidates };
}

/**
 * 台账里一行。**两条路分两列**,不再合并。
 *
 * 修前的形态只有一个 `path`,而它只回答「掉冠」这一条
 * (`contestCrownDrop → gateCrownKnock`),`note` 却拿它当「整蛊能不能用」的总开关,
 * 于是写着「32 件没有动作路径,出路是 `use_item` 的 221..255 分支(不在本任务写域)」。
 * 那段分支**后来接上了**(WS-FND-122:`use_item.ts` 的玩具分支 →
 * `gatePrank` → `WorldSim.applyPrankToTarget`),而这行说明没跟着改 ——
 * 台账因此成了「说明与仓库相反」的那类缺陷(审计 WS-FND-148 第 1 项)。
 *
 * ⇒ `path` 保留 WS-FND-120 的冻结口径(`WIRED:<verb>` / `NONE`,判据钉住
 *    「只有掉冠那三件是 WIRED、其余 32 行 NONE」),另开 `player` / `enemy`
 *    两列说清**真实**的动作入口。三列一起才对得上仓库。
 */
export interface PrankActionRow {
  toyId: number;
  name: string;
  /** 掉冠这条路(`WIRED:<verb>` / `NONE`)。字段名与取值形态是 WS-FND-120 的冻结口径。 */
  path: string;
  note: string;
  /** 玩家→玩家整蛊:`WIRED:...` / `NONE:<欠哪一步>`。 */
  player: string;
  /** 玩家→怪物(`enemyEffect` 的落点):`WIRED:...` / `NONE:<欠哪一步>`。 */
  enemy: string;
}

/** 玩家→玩家整蛊的唯一生产动词(`use_item` 的 221..255 分支)。 */
export const PRANK_PLAYER_VERB = 'WIRED:use_item#gatePrank → WorldSim.applyPrankToTarget';
/** 掉冠动词。 */
export const PRANK_CROWN_VERB = 'WIRED:crown_knock';

/** 掉冠这条路在哪些玩具上是活的(手册 §6.1 点名的三件)。 */
const WIRED_CROWN_PATHS: Readonly<Record<number, string>> = {
  222: PRANK_CROWN_VERB,
  224: PRANK_CROWN_VERB,
  225: PRANK_CROWN_VERB,
};

const NOTE_CROWN = '掉冠:持冠者被这三件之一击退 ⇒ `gateCrownKnock` 判 218 盾后掉冠(手册 §6.1/§3.4)';
const NOTE_NO_CROWN = '掉冠这条路没有它:手册点名的掉冠来源是 222 大锤 / 225 香蕉皮 / 224 钩爪,这一件只走整蛊效果';
/**
 * 227 是 35 件里**唯一**被世界侧语义表接走的(`itemUseKind(227) = 'BUBBLE'`)。
 * 玩具分支因此让路(WS-FND-122 实测的回归点):一发就 STUNNED 会打红
 * 「连中 3 发才困住」(`WS-FND-53`)。⇒ 它在**这条**路上没有入口,不是忘了接。
 */
const PLAYER_NONE_227 = 'NONE:世界侧 `itemUseKind(227)=BUBBLE` 优先(WS-FND-122 ⇒ 一发 STUNNED 会打红「连中 3 发才困住」)';
/**
 * 玩家→怪物:35 件**全部**未接。
 * 世界侧的落点 `applyPrankToTarget` 只对玩家生效(`NOT_A_PLAYER`),
 * 怪物侧的伤害/控制在战斗层(`combat/damage.ts`),不属本轮写域。
 */
const ENEMY_NONE = 'NONE:`WorldSim.applyPrankToTarget` 只对玩家生效(NOT_A_PLAYER)⇒ 怪物侧落点在战斗层,不在本轮写域';

/** 台账与玩具表逐条对应(35 行)—— 由 `assertPrankActionLedgerComplete()` 自检。 */
export const PRANK_ACTION_LEDGER: readonly PrankActionRow[] = PRANK_TOYS.map((t) => {
  const crown = WIRED_CROWN_PATHS[t.id] !== undefined;
  return {
    toyId: t.id,
    name: t.name,
    path: crown ? PRANK_CROWN_VERB : 'NONE',
    note: crown ? NOTE_CROWN : NOTE_NO_CROWN,
    player: t.id === 227 ? PLAYER_NONE_227 : PRANK_PLAYER_VERB,
    enemy: ENEMY_NONE,
  };
});

/** 台账里标成 `WIRED:` 的行(断言「不许把没接的写成已接」用)。 */
export function wiredPrankToys(): number[] {
  return PRANK_ACTION_LEDGER.filter((r) => r.path.startsWith('WIRED:')).map((r) => r.toyId);
}

/**
 * 自检:
 *  1 台账与玩具表**逐 ID 一致**(少一行就是「这件玩具没人认领」);
 *  2 `WIRED:` 行的 ID 必须在 `PRANK_TOYS` 里(不许写悬空 ID);
 *  3 掉冠候选玩具必须都在表内;
 *  4 `NONE:` 列必须写清欠的是哪一步(空话挡在门外)。
 */
export function assertPrankActionLedgerComplete(): void {
  if (PRANK_ACTION_LEDGER.length !== PRANK_TOYS.length) {
    throw new Error(`整蛊动作台账 ${PRANK_ACTION_LEDGER.length} 行,玩具表 ${PRANK_TOYS.length} 件`);
  }
  for (const row of PRANK_ACTION_LEDGER) {
    if (row.toyId < PRANK_TOY_ID_MIN || row.toyId > PRANK_TOY_ID_MAX) {
      throw new Error(`台账行 ${row.toyId} 超出玩具 ID 区间 ${PRANK_TOY_ID_MIN}..${PRANK_TOY_ID_MAX}`);
    }
    if (row.path === 'NONE' && row.note === '') throw new Error(`#${row.toyId} 登记为 NONE 却没写原因`);
    if (row.path.startsWith('WIRED:')) toyOf(row.toyId);
    if (row.player.startsWith('NONE:') && row.player.length < 'NONE:'.length + 12) {
      throw new Error(`#${row.toyId} 的玩家侧 NONE 没写清欠哪一步`);
    }
    if (row.enemy.startsWith('NONE:') && row.enemy.length < 'NONE:'.length + 12) {
      throw new Error(`#${row.toyId} 的怪物侧 NONE 没写清欠哪一步`);
    }
  }
  for (const id of CROWN_KNOCK_TOY_IDS) toyOf(id);
}

/**
 * 台账对账(纯函数,**不 import 世界侧**)。
 *
 * 判据只有一条核心:**玩家侧入口的归属必须由「世界侧语义表认不认它」决定**。
 * ``` 
 * itemUseKind(id) === null  ⇒  玩具分支必然接管 ⇒ 台账必须写 WIRED
 * itemUseKind(id) !== null  ⇒  世界侧语义优先   ⇒ 台账必须写 NONE:<为什么>
 * ``` 
 * 调用方把 `worldSemanticOf` 注入进来(判据里传 `WorldSim.itemUseKind`),
 * 于是「227 例外」不是注释里的一句口号:世界侧那张表一改,这一行当场红。
 *
 * @param worldSemanticOf 世界侧语义表的读口;`null` = 那张表不认它。
 * @returns 问题清单(空数组 = 全绿)。
 */
export function auditPrankLedger(
  rows: readonly PrankActionRow[],
  worldSemanticOf: (itemId: number) => string | null,
): string[] {
  const problems: string[] = [];
  if (rows.length !== PRANK_TOYS.length) {
    problems.push(`台账 ${rows.length} 行,玩具表 ${PRANK_TOYS.length} 件`);
  }
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.toyId)) problems.push(`#${row.toyId}: 台账里重复登记`);
    seen.add(row.toyId);
    const def = PRANK_TOY_BY_ID.get(row.toyId);
    if (def === undefined) {
      problems.push(`#${row.toyId}: 不在玩具表里(悬空行)`);
      continue;
    }
    if (def.name !== row.name) problems.push(`#${row.toyId}: 名称与玩具表不符(${row.name} ≠ ${def.name})`);
    const semantic = worldSemanticOf(row.toyId);
    const claimsUseItem = row.player.startsWith('WIRED:');
    if (semantic === null && !claimsUseItem) {
      problems.push(`#${row.toyId}: 世界侧语义表不认它 ⇒ 玩具分支必然接管,台账却写 ${row.player}`);
    }
    if (semantic !== null && claimsUseItem) {
      problems.push(`#${row.toyId}: 世界侧语义表认它(${semantic})⇒ 玩具分支让路,台账却写 WIRED`);
    }
    if (!row.player.startsWith('WIRED:') && !row.player.startsWith('NONE:')) {
      problems.push(`#${row.toyId}: player 只允许 WIRED:... / NONE:...`);
    }
    if (!row.enemy.startsWith('WIRED:') && !row.enemy.startsWith('NONE:')) {
      problems.push(`#${row.toyId}: enemy 只允许 WIRED:... / NONE:...`);
    }
    if (row.note.trim().length < 12) problems.push(`#${row.toyId}: note 太短(台账不许写空话)`);
    if (row.path.startsWith('WIRED:') && !CROWN_KNOCK_TOY_IDS.includes(row.toyId)) {
      problems.push(`#${row.toyId}: 掉冠登记的玩具不在候选三件(${CROWN_KNOCK_TOY_IDS.join('/')})里`);
    }
  }
  for (const t of PRANK_TOYS) if (!seen.has(t.id)) problems.push(`#${t.id}: 台账缺行`);
  return problems;
}

assertPrankActionLedgerComplete();