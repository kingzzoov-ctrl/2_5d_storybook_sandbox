/**
 * WS-FND-128 —— 世界快照**不变量**(纯函数层)。
 *
 * ## 它要解决的事
 *
 * 「让系统**在跑动中自己暴露违反**」:世界照常跑,一组判据盯着它,
 * 一旦某条不变量被踩,**当场**报出 `code + detail`(哪一跳、哪个 id、差多少)。
 * 不靠人眼去翻状态,也不靠事后对账。
 *
 * ## 为什么是「纯函数 + 局部窄类型」而不是 `import world_sim.ts`
 *
 * ```text
 * 1 生产层不必为它改变形状:把世界拼成下面这几个窄接口即可 ——
 *   本模块**不知道**世界内部怎么存,只判「交上来的这份快照自不自洽」。
 * 2 判据层(测试 / 门禁)因此可以**手工构造**快照:正例 + 反例各来一份,
 *   不必拉起整个世界,也不必依赖 RNG 才复现的出某一次越界。
 * 3 反向也零耦合:本模块不 import 任何生产模块 ⇒ 它不会把判据拖进生产闭包,
 *   也不会因为世界内部重构而失效。
 * ```
 * ⚠️ 因此**不要**在这里 import `../sim/world_sim.ts` —— 那会把「快照的形状」
 *   与「世界的实现」绑死,上面三条同时失效。
 *
 * ## 判据的形态:每条都返回 `{ ok, code, detail }`
 *
 * ```text
 * 不抛异常 —— 一次跑完拿到**全部**违反(抛异常只能报第一条);
 * 不返回 boolean —— 布尔说不出「哪一跳、差多少」,读者还得自己再跑一遍去查;
 * code 是**稳定标识** —— 门禁/测试按它归因(「这一条被抓到了」),
 * 而不是按 detail 的措辞(措辞一改,判据就静默失效)。
 * ```
 *
 * ## 一条判据「有牙」的两个必要条件(本轮补的两处系统性漏洞)
 *
 * ```text
 * 1 参数合法性前置:判据的**边界值**本身非法(容量 NaN、地图 maxZ=Infinity ...)
 *   会让比较恒假 ⇒ 这一条对所有输入放行 —— 那不是「没有违反」,是「判不了」。
 *   ⇒ 凡读过参数的判据都必须先判参数,非法即报(见 POS_FINITE_IN_BOUNDS / CONTAINER_CAPACITY)。
 * 2 分支各自有反例:一条判据内部有 N 个分支(entries/perItem/total/container ...)
 *   时,「多分支压成单点」= 只测第一个分支就把整条标成有牙。
 *   ⇒ 反例表里**每个分支各一个独立反例**(见 `scripts/invariants.ts` 的 VIOLATION_CASES)。
 * ```
 *
 * ## ★ 注入面(`checkAll` 的 `overrides`)
 *
 * 「有这条检查」与「这条检查有牙」是两件事。`overrides` 让调用方把**某一条**
 * 换成另一份实现(典型用法:换成恒真),于是可以断言:
 *
 * ```text
 * 注入恒真 ⇒ 对应的反例**不再被抓到** ⇒ 说明抓到它的**正是这一条**(归因),
 * 而不是「恰好被别的条目顺手抓到」或「它本来就是恒真的」。
 * ```
 * 运行时防线(本轮补):`overrides` 的 key 必须是 `INVARIANT_CODES` 的成员 ——
 * 拼错 key 直接抛(否则注入静默不生效,「注入后不再被抓到」会**假绿**)。
 * 被注入的条目在其结果上留痕 `overridden:true`,`summarize` 汇总为 `overridden` 清单。
 *
 * 消费者见 `scripts/invariants.ts`(自带反例 + 注入自证)与
 * `tests/WS-FND-128-invariants.test.ts`(每条正例/反例 + 注入验证)。
 *
 * ## 覆盖到的 8 条(每条一个 `InvariantCode`)
 *
 * | code | 判什么 | 破了会怎样 |
 * | :--- | :--- | :--- |
 * | `POS_FINITE_IN_BOUNDS` | 位置有限且在地图内(地图边界本身须合法) | NaN/Infinity 会静默污染物理与存档;越界刚体永远走不回可行域 |
 * | `BODY_ID_UNIQUE` | 同 id 唯一刚体 | 两个刚体共用一个 id ⇒ 旁表/存档/网络指着谁变成非确定 |
 * | `CONTAINER_CAPACITY` | 背包/容器总量 ≤ 容量(容量本身须合法) | 溢出件在下一次落盘时凭空消失(或无限增长) |
 * | `LEDGER_NON_NEGATIVE` | 账不得为负 | 负结余 = 凭空多出来的东西,且会一路传下去 |
 * | `PER_ITEM_MATCHES_TOTAL` | 按件账与总量账一致 | 两个数各说各话 ⇒ 总量越大越容易瞒过容量判据 |
 * | `STATE_EXCLUSION` | 状态互斥(BUBBLED/STUNNED/alive/DEAD) | 同时眩晕+泡泡/dead 还活着 ⇒ 逻辑分支互相抵消 |
 * | `SIDE_TABLE_KEYS` | 旁表 key ⊆ 存在 id | 旁表指向不存在的 id ⇒ 空指针或永远清不掉的残留 |
 * | `FRAME_BYTES_BOUND` | 单帧字节 ≤ 上界(上界本身须合法) | 带宽预算被击穿(客户端卡顿,而服务端看起来一切正常) |
 */

/** 三维坐标(单位:格;与世界坐标同量纲)。 */
export interface InvVec3 {
  x: number;
  y: number;
  z: number;
}

/** 一个刚体(玩家 / 生物 / 掉落物 / 场景件)。`states` 是**大写字面**状态位。 */
export interface InvBody {
  id: string;
  kind: string;
  pos: InvVec3;
  /** 存活标志。它与 `states` 里的 `DEAD` 互斥(见 `STATE_EXCLUSION`)。 */
  alive: boolean;
  states: string[];
}

/**
 * 一个容器(背包 / 箱子 / 掉落堆)。
 *
 * `byItem` 是**按件账**(itemId → 件数),`total` 是**总量账**。
 * 两者必须相等(`PER_ITEM_MATCHES_TOTAL`),且都不超过 `capacity`。
 * ⚠️ `capacity` 必须是**非负有限数**;否则 `CONTAINER_CAPACITY` 的比较恒假(见文件头「有牙」第 1 条)。
 */
export interface InvContainer {
  id: string;
  capacity: number;
  byItem: Record<string, number>;
  total: number;
}

/** 一条账目:`delta` 本次变动,`balance` 结余(**不得为负**)。 */
export interface InvLedgerEntry {
  id: string;
  delta: number;
  balance: number;
}

/** 账本:逐条结余 + 按件账 + 总量账。 */
export interface InvLedger {
  entries: InvLedgerEntry[];
  /** 按件账:itemId → 件数。 */
  perItem: Record<string, number>;
  /** 账本自报的总量。 */
  total: number;
}

/** 旁表(非刚体索引:携带 / 队伍 / 冷却 / 掉落归属 ...)。`keys` 必须是**已存在的 id**。 */
export interface InvSideTable {
  name: string;
  keys: string[];
}

/**
 * 一份世界快照 + 账本 —— 本模块的**唯一输入**。
 *
 * ⚠️ `knownIds` 是「已存在 id」的正解来源。别用 `bodies` 现算:
 *   容器 id、掉落堆 id 也是合法 key,现算会把它们判成悬空。
 */
export interface InvSnapshot {
  /** 世界帧号(只为 detail 里指认「哪一跳」)。 */
  tick: number;
  /** 地图尺寸(格)与最高可站高度。⚠️ 三者必须非负有限(见 `POS_FINITE_IN_BOUNDS`)。 */
  map: { w: number; h: number; maxZ: number };
  /** 单帧下发预算与实际字节数。 */
  frame: { bytes: number; maxBytes: number };
  bodies: InvBody[];
  containers: InvContainer[];
  ledger: InvLedger;
  sideTables: InvSideTable[];
  /** 已存在的 id 全集(旁表 key 的合法值域)。 */
  knownIds: string[];
}

/** 8 条不变量的稳定标识。**顺序即 `INVARIANT_CODES` 的顺序**(门禁输出按它排)。 */
export type InvariantCode =
  | 'POS_FINITE_IN_BOUNDS'
  | 'BODY_ID_UNIQUE'
  | 'CONTAINER_CAPACITY'
  | 'LEDGER_NON_NEGATIVE'
  | 'PER_ITEM_MATCHES_TOTAL'
  | 'STATE_EXCLUSION'
  | 'SIDE_TABLE_KEYS'
  | 'FRAME_BYTES_BOUND';

/** 单条判据的返回。`ok === false` 时 `detail` 必须能指到**哪个 id / 差多少**。 */
export interface InvariantResult {
  ok: boolean;
  code: InvariantCode;
  detail: string;
  /**
   * 本次是否被 `opts.overrides` 替换过(注入面留痕)。
   * ⚠️ 它不足以单独作为「有牙」的证据 —— 只用它会让「注入物接错、一次都没跑」也看起来正常;
   *    调用方仍须按「注入物被调用次数 === 1」自证(见 `scripts/invariants.ts`)。
   */
  overridden?: boolean;
}

/** 一条判据的实现形态(纯函数:同一输入 ⇒ 同一输出)。 */
export type InvariantCheck = (snapshot: InvSnapshot) => InvariantResult;

/** `checkAll` 的选项。`overrides` 是**注入面**(见文件头「注入面」)。 */
export interface InvariantOptions {
  /**
   * 按 code 替换某条判据。典型用法:换成恒真以证明「反例是被这一条抓到的」。
   * ⚠️ key **必须**是 `INVARIANT_CODES` 的成员:`checkAll` 会在运行时校验,
   * 拼错即**抛**(否则注入静默不生效,而「注入后不再被抓到」会假成立)。
   * 注入物的 `code` 字段被忽略:`checkAll` 以**注册表**为准回填 code。
   */
  overrides?: Partial<Record<InvariantCode, InvariantCheck>>;
}

/** 汇总(`summarize` 的返回)。 */
export interface InvariantSummary {
  ok: boolean;
  total: number;
  failed: InvariantCode[];
  /**
   * 本次汇总里被 `overrides` 覆盖(注入)的条目。
   * 非空即「这份结论里有被替换过的判据」—— 读的人必须据此决定是否采信。
   */
  overridden: InvariantCode[];
  detail: string;
}

/**
 * 判据注册表的**唯一顺序来源**。
 * ⚠️ 它同时是「一共有几条不变量」的正解 —— 别在测试/文档里手抄这个数。
 */
export const INVARIANT_CODES: readonly InvariantCode[] = [
  'POS_FINITE_IN_BOUNDS',
  'BODY_ID_UNIQUE',
  'CONTAINER_CAPACITY',
  'LEDGER_NON_NEGATIVE',
  'PER_ITEM_MATCHES_TOTAL',
  'STATE_EXCLUSION',
  'SIDE_TABLE_KEYS',
  'FRAME_BYTES_BOUND',
];

/** 状态互斥对 —— 同时出现即违反 `STATE_EXCLUSION`。 */
const MUTEX_PAIRS: readonly (readonly [string, string])[] = [
  ['BUBBLED', 'STUNNED'],
];

/** 明细只列前 `max` 条:门禁输出要能读,不能被 1000 条越界刷屏。 */
function brief(items: readonly string[], max = 3): string {
  if (items.length <= max) return items.join('; ');
  return `${items.slice(0, max).join('; ')} ...另有 ${items.length - max} 处`;
}

/** 按件账合计。`NaN` 会传染出去(那是刻意的:它由 `LEDGER_NON_NEGATIVE` 报)。 */
function itemSum(byItem: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(byItem)) n += v;
  return n;
}

/** 1 位置有限且在地图内。★ 先判地图边界**本身**是否合法(否则比较恒假 ⇒ 判据静默放行)。 */
function posFiniteInBounds(s: InvSnapshot): InvariantResult {
  const { w, h, maxZ } = s.map;
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(maxZ) || w < 0 || h < 0 || maxZ < 0) {
    return {
      ok: false,
      code: 'POS_FINITE_IN_BOUNDS',
      detail: `地图尺寸非法(w=${w}, h=${h}, maxZ=${maxZ})—— 边界非有限/为负时`
        + '「越界」判定无从成立(那不是「没有越界」,是「判不了」)',
    };
  }
  const bad: string[] = [];
  for (const b of s.bodies) {
    const { x, y, z } = b.pos;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      bad.push(`${b.id} 坐标非有限(x=${x}, y=${y}, z=${z})`);
      continue;
    }
    if (x < 0 || x > w || y < 0 || y > h || z < 0 || z > maxZ) {
      bad.push(`${b.id} 越界(${x}, ${y}, ${z};地图 ${w}×${h}×${maxZ})`);
    }
  }
  return bad.length === 0
    ? {
      ok: true,
      code: 'POS_FINITE_IN_BOUNDS',
      detail: `${s.bodies.length} 个刚体坐标有限且落在 [0,${w}]×[0,${h}]×[0,${maxZ}] 内`,
    }
    : { ok: false, code: 'POS_FINITE_IN_BOUNDS', detail: `位置非法 ${bad.length} 个:${brief(bad)}` };
}

/** 2 同 id 唯一刚体。 */
function bodyIdUnique(s: InvSnapshot): InvariantResult {
  const seen = new Map<string, number>();
  for (const b of s.bodies) seen.set(b.id, (seen.get(b.id) ?? 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
  return dup.length === 0
    ? { ok: true, code: 'BODY_ID_UNIQUE', detail: `${s.bodies.length} 个刚体 id 全局唯一` }
    : {
      ok: false,
      code: 'BODY_ID_UNIQUE',
      detail: `同 id 多刚体 ${dup.length} 个:${brief(dup)}`
        + '(旁表/存档/网络按 id 找刚体 ⇒ 指向谁变成非确定)',
    };
}

/** 3 背包/容器总量 ≤ 容量。★ 先判 `capacity` 本身是否合法(非有限 ⇒ 比较恒假 ⇒ 静默放行)。 */
function containerCapacity(s: InvSnapshot): InvariantResult {
  const bad: string[] = [];
  for (const c of s.containers) {
    if (!Number.isFinite(c.capacity) || c.capacity < 0) {
      bad.push(`${c.id} 容量非法(${c.capacity})—— 非有限/为负的容量让「是否溢出」无从判定`);
      continue;
    }
    const sum = itemSum(c.byItem);
    if (sum > c.capacity) bad.push(`${c.id} 按件合计 ${sum} > 容量 ${c.capacity}`);
    if (c.total > c.capacity) bad.push(`${c.id} 总量账 ${c.total} > 容量 ${c.capacity}`);
  }
  return bad.length === 0
    ? {
      ok: true,
      code: 'CONTAINER_CAPACITY',
      detail: `${s.containers.length} 个容器的按件合计与总量账都不超过各自容量(边界:恰好装满也算通过)`,
    }
    : { ok: false, code: 'CONTAINER_CAPACITY', detail: `容器溢出 ${bad.length} 处:${brief(bad)}` };
}

/** 4 账不得为负(逐条结余、按件账、总量账一起判)。 */
function ledgerNonNegative(s: InvSnapshot): InvariantResult {
  const bad: string[] = [];
  let counts = 0;
  for (const e of s.ledger.entries) {
    counts += 1;
    if (!Number.isFinite(e.balance) || e.balance < 0) bad.push(`账目 ${e.id} 结余 ${e.balance} 为负/非有限`);
  }
  for (const [k, v] of Object.entries(s.ledger.perItem)) {
    counts += 1;
    if (!Number.isFinite(v) || v < 0) bad.push(`账本按件 ${k} = ${v} 为负/非有限`);
  }
  counts += 1;
  if (!Number.isFinite(s.ledger.total) || s.ledger.total < 0) {
    bad.push(`账本总量 ${s.ledger.total} 为负/非有限`);
  }
  for (const c of s.containers) {
    counts += 1;
    if (!Number.isFinite(c.total) || c.total < 0) bad.push(`容器 ${c.id} 总量 ${c.total} 为负/非有限`);
    for (const [k, v] of Object.entries(c.byItem)) {
      counts += 1;
      if (!Number.isFinite(v) || v < 0) bad.push(`容器 ${c.id} 按件 ${k} = ${v} 为负/非有限`);
    }
  }
  return bad.length === 0
    ? { ok: true, code: 'LEDGER_NON_NEGATIVE', detail: `账本/容器的 ${counts} 个记账位全部 ≥ 0 且有限` }
    : { ok: false, code: 'LEDGER_NON_NEGATIVE', detail: `账为负 ${bad.length} 处:${brief(bad)}` };
}

/** 5 按件账与总量账一致(账本 + 每个容器)。 */
function perItemMatchesTotal(s: InvSnapshot): InvariantResult {
  const bad: string[] = [];
  const ledgerSum = itemSum(s.ledger.perItem);
  if (ledgerSum !== s.ledger.total) {
    bad.push(`账本:按件合计 ${ledgerSum} ≠ 总量账 ${s.ledger.total}`);
  }
  for (const c of s.containers) {
    const sum = itemSum(c.byItem);
    if (sum !== c.total) bad.push(`${c.id}:按件合计 ${sum} ≠ 总量账 ${c.total}`);
  }
  return bad.length === 0
    ? {
      ok: true,
      code: 'PER_ITEM_MATCHES_TOTAL',
      detail: `账本 + ${s.containers.length} 个容器的按件账与总量账逐一对上`,
    }
    : { ok: false, code: 'PER_ITEM_MATCHES_TOTAL', detail: `按件账与总量账不符 ${bad.length} 处:${brief(bad)}` };
}

/** 6 状态互斥(BUBBLED / STUNNED / DEAD 与 alive、状态位不重复)。 */
function stateExclusion(s: InvSnapshot): InvariantResult {
  const bad: string[] = [];
  for (const b of s.bodies) {
    const set = new Set(b.states);
    if (set.size !== b.states.length) bad.push(`${b.id} 状态位重复:${b.states.join('+')}`);
    for (const pair of MUTEX_PAIRS) {
      if (set.has(pair[0]) && set.has(pair[1])) {
        bad.push(`${b.id} 同时处于互斥状态 ${pair[0]}+${pair[1]}`);
      }
    }
    if (b.alive && set.has('DEAD')) bad.push(`${b.id} alive 为真却带 DEAD 状态位`);
  }
  return bad.length === 0
    ? { ok: true, code: 'STATE_EXCLUSION', detail: `${s.bodies.length} 个刚体状态位无重复且互斥对未同时成立` }
    : { ok: false, code: 'STATE_EXCLUSION', detail: `状态冲突 ${bad.length} 处:${brief(bad)}` };
}

/** 7 旁表 key ⊆ 存在 id。 */
function sideTableKeys(s: InvSnapshot): InvariantResult {
  const known = new Set(s.knownIds);
  /* ⚠️ 「id 域为空」与「没有违反」必须可区分:空域下旁表 key 恒悬空,
     若悄悄通过,这一条就成了摆设(本仓的口径:筛不到东西要报出来)。 */
  if (known.size === 0 && (s.sideTables.length > 0 || s.bodies.length > 0)) {
    return {
      ok: false,
      code: 'SIDE_TABLE_KEYS',
      detail: 'knownIds 为空却有刚体/旁表 ⇒ 存在 id 的值域缺失,本判据无从判定(不是「没有悬空 key」)',
    };
  }
  const bad: string[] = [];
  let keys = 0;
  for (const t of s.sideTables) {
    for (const k of t.keys) {
      keys += 1;
      if (!known.has(k)) bad.push(`${t.name} 的 key ${k} 不在已存在 id 集合`);
    }
  }
  return bad.length === 0
    ? {
      ok: true,
      code: 'SIDE_TABLE_KEYS',
      detail: `${s.sideTables.length} 张旁表的 ${keys} 个 key 全部落在 ${known.size} 个已存在 id 内`,
    }
    : { ok: false, code: 'SIDE_TABLE_KEYS', detail: `旁表悬空 key ${bad.length} 个:${brief(bad)}` };
}

/** 8 单帧字节 ≤ 上界。 */
function frameBytesBound(s: InvSnapshot): InvariantResult {
  const { bytes, maxBytes } = s.frame;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      code: 'FRAME_BYTES_BOUND',
      detail: `单帧字节上界非法(${maxBytes})—— 上界本身必须是正有限数,否则这一条没有判据`,
    };
  }
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { ok: false, code: 'FRAME_BYTES_BOUND', detail: `单帧字节数非法(${bytes})` };
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: 'FRAME_BYTES_BOUND',
      detail: `单帧 ${bytes} 字节 > 上界 ${maxBytes}(超出 ${bytes - maxBytes})`,
    };
  }
  return {
    ok: true,
    code: 'FRAME_BYTES_BOUND',
    detail: `单帧 ${bytes} 字节 ≤ 上界 ${maxBytes}(余量 ${maxBytes - bytes})`,
  };
}

/** code → 实现。`INVARIANT_CODES` 是它的顺序来源,两者必须同集合(下面有自证)。 */
const CHECKS: Record<InvariantCode, InvariantCheck> = {
  POS_FINITE_IN_BOUNDS: posFiniteInBounds,
  BODY_ID_UNIQUE: bodyIdUnique,
  CONTAINER_CAPACITY: containerCapacity,
  LEDGER_NON_NEGATIVE: ledgerNonNegative,
  PER_ITEM_MATCHES_TOTAL: perItemMatchesTotal,
  STATE_EXCLUSION: stateExclusion,
  SIDE_TABLE_KEYS: sideTableKeys,
  FRAME_BYTES_BOUND: frameBytesBound,
};

/* 注册表自证:`INVARIANT_CODES` 与 `CHECKS` 的键集必须完全一致。
   少了它,「加一条不改另一个数组」会让新判据**静默不跑**(或跑到 undefined)。
   在**模块加载时**判:坏得越早,报错位置离出错点越近。 */
{
  const missing = INVARIANT_CODES.filter((c) => CHECKS[c] === undefined);
  const extra = (Object.keys(CHECKS) as InvariantCode[]).filter((c) => !INVARIANT_CODES.includes(c));
  /* 重复也算「不同集合」的形态:两条同名 code 会让归因出现两个入口。 */
  const dup = INVARIANT_CODES.filter((c, i) => INVARIANT_CODES.indexOf(c) !== i);
  if (missing.length > 0 || extra.length > 0 || dup.length > 0) {
    throw new Error(
      `INVARIANT_CODES 与判据注册表不同集合(缺实现:${missing.join(',') || '无'};`
      + `多实现:${extra.join(',') || '无'};重复 code:${dup.join(',') || '无'})`,
    );
  }
}

/**
 * 跑**全部**不变量(每条一条结果,顺序与 `INVARIANT_CODES` 一致)。
 *
 * `opts.overrides` 见文件头「注入面」—— 它是「这条判据有牙」的可证明入口。
 * ⚠️ `overrides` 的 key 若不在 `INVARIANT_CODES` 里**直接抛**(拼错即抛):
 *   否则该注入静默不生效,而「注入后不再被抓到」会**恰好成立**(最危险的假绿)。
 * 被注入的条目在结果上留痕 `overridden:true`。
 */
export function checkAll(snapshot: InvSnapshot, opts: InvariantOptions = {}): InvariantResult[] {
  const overrides = opts.overrides;
  if (overrides !== undefined) {
    for (const key of Object.keys(overrides)) {
      if (!(INVARIANT_CODES as readonly string[]).includes(key)) {
        throw new Error(
          `overrides 含未知 code「${key}」—— 合法值只有 ${INVARIANT_CODES.join(', ')}`
          + '(拼错即抛:否则该注入静默失效,「注入后不再被抓到」会假绿)',
        );
      }
    }
  }
  return INVARIANT_CODES.map((code) => {
    const injected = overrides !== undefined && overrides[code] !== undefined;
    const fn = injected ? overrides![code]! : CHECKS[code];
    const r = fn(snapshot);
    /* ⚠️ code 以**注册表**为准回填:注入物/手写实现写错 code 时,
       归因不会静默错位(`r.code` 与 `code` 不一致本身就是笔误的证据)。 */
    return injected
      ? { ok: r.ok, code, detail: r.detail, overridden: true }
      : { ok: r.ok, code, detail: r.detail };
  });
}

/** 只返回不通过的那些(调用方通常只关心违反)。 */
export function violations(snapshot: InvSnapshot, opts: InvariantOptions = {}): InvariantResult[] {
  return checkAll(snapshot, opts).filter((r) => !r.ok);
}

/**
 * 把一组结果汇总成一句话 + 失败 code 清单 + **被注入的条目**。
 *
 * `overridden` 非空 ⇒ 这份结论里掺了注入物(例如反例的「有牙」自证),
 * 读的人必须知道:它不是纯粹的实际状态。
 */
export function summarize(results: readonly InvariantResult[]): InvariantSummary {
  const failed = results.filter((r) => !r.ok).map((r) => r.code);
  const overridden = results.filter((r) => r.overridden === true).map((r) => r.code);
  const head = failed.length === 0
    ? `${results.length} 条不变量全部通过`
    : `违反 ${failed.length}/${results.length} 条:${failed.join(', ')}`;
  const covered = overridden.length === 0
    ? ''
    : `;本次覆盖 ${overridden.length} 条(注入):${overridden.join(', ')}`;
  return {
    ok: failed.length === 0,
    total: results.length,
    failed,
    overridden,
    detail: head + covered,
  };
}
