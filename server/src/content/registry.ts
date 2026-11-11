/**
 * 内容注册表与指纹 —— 为「后续升级/更新/拓展」提供可验证的底座。
 *
 * ## 这一层解决什么
 *
 * 交付时内容表是**裸常量数组**:`items.ts` 导出 `ITEM_LIST: ItemDef[]`,
 * `mobs.ts` 导出 `MOB_LIST`。这在「只读交付」时够用,但一旦要扩容,
 * 三件事会同时出问题:
 *
 * 1. **没有容量账本。** 想加 20 件物品,得人工数哪些 ID 空着、
 *    FLOOR 槽位还剩几格、OBJ 层 12 位还装得下多少。数错了要到运行时
 *    `packTile` 静默截断才发现。
 * 2. **没有内容指纹。** 存档、网络协议、蓝图都引用了内容 ID
 *    (`users.held_item_id`、`blueprint` 的 12 位 obj、`ai_alchemy_recipes.recipe_hash`)。
 *    内容表一改,旧存档**照样加载**,读到的是「另一个物品」——没有异常、没有日志。
 *    对照:`schema_migrations` 已经覆盖了 DDL 变更,但内容表变更无人看管。
 * 3. **基线与扩展混在一起。** 验证器硬编码「物品 320 / 分表 30-20-18-…」,
 *    这本是对照手册的正确做法;但扩容时人会直接改数字,基线保证就此永久丢失。
 *
 * ## 这一层不做什么
 *
 * - 不改任何内容数据(320 项、24 生物、8 Boss 一行不动);
 * - 不改冻结层签名(只**读取** `shared/constants/**`);
 * - 不引入运行时依赖。
 *
 * 它只是给已有的内容表**加一层可验证的外壳**:容量账本、内容指纹、
 * 以及「本条目属于哪个 ID 区间」的登记,让扩容从「靠记忆」变成「靠断言」。
 */

import { ITEM_LIST, ITEM_TABLES } from '../../../shared/constants/items.ts';
import { MOB_LIST } from '../../../shared/constants/mobs.ts';
import { BOSS_LIST, PARTY_MODES, ROOM_RECIPES } from '../../../shared/constants/bosses.ts';
import { ItemCategory } from '../../../shared/types/entities.ts';

/* ═══════════════════════ 1. 位域容量账本 ═══════════════════════ */

/**
 * 32 位单元的位域划分(取自冻结层 `tile.ts`,**只读引用,不重新定义**)。
 *
 * 这里显式列出位宽,是因为「还能加多少内容」直接由它决定,
 * 而位宽属于**跨模块硬约束**:写错一个数值不会有编译错误,
 * 只会在某个具体数值上静默截断。
 */
export const FIELD_BITS = Object.freeze({
  /** 海拔 2 位:0..3 */
  ELEV: 2,
  /** 基底 4 位:0..15 */
  BASE: 4,
  /** 地砖槽位 6 位:0..63 */
  FLOOR: 6,
  /** 电线 4 位:四色各 1 位 */
  WIRE: 4,
  /** 物品/构件 ID 12 位:0..4095 */
  OBJ: 12,
  /** 元数据 4 位 */
  META: 4,
});

/** 位宽推出的取值上限。 */
export const FIELD_MAX: Readonly<Record<keyof typeof FIELD_BITS, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(FIELD_BITS).map(([k, bits]) => [k, (1 << bits) - 1]),
  ) as Record<keyof typeof FIELD_BITS, number>,
);

/** 一条容量条目:某个 ID 空间用了多少、剩多少。 */
export interface CapacityEntry {
  /** 空间名称,如 `OBJ 物品 ID`。 */
  space: string;
  /** 已占用**值域**的宽度(OBJ 行 = 物品件数;FLOOR 行 = 地砖种数)。 */
  used: number;
  /** 值域总宽(由位宽推出);`null` 表示无上限(字符串 ID)。 */
  capacity: number | null;
  /**
   * 值域上界处的剩余宽度 = `capacity - 最高已用值`。
   *
   * **注意它与 `freeCount` 含义不同** —— 早先把两个概念都叫 `remaining`,
   * 导致同一字段在 OBJ 行表示「最大 ID 之后还有多宽」(3350)、
   * 在 FLOOR 行却表示「还能加几种」(33 = 63−30),同名不同义。
   * 读表的人会按同一含义理解,而其中一行必然是错的。
   *
   * 这是**连续增长型**ID 空间的容量指标(新 ID 总是追加在末尾)。
   */
  headroom: number | null;
  /**
   * 真正可用的 ID 个数(含值域中间的零散空档)。
   *
   * 对 OBJ 层它 = `4095 - 已用件数` = **3775**(不是 3350,因为物品 ID
   * 中间有大量未分配空档可用);对 FLOOR 行它 = 63 − 30 = 33。
   *
   * 这是**编排决策**该看的数字:「我还能加多少」。
   */
  freeCount: number | null;
  /**
   * 已占用的持续程度 0..1 = `最高已用值 / capacity`。
   *
   * 用它而不是 `used / capacity` 做告警判据:ID 空间是**稀疏**的,
   * 真正先撞到的墙是「值域上界」而非「件数上限」。例如物品用 320 号
   * 占 4095 值域,`used/capacity` 仅 7.8% 看似很宽裕,但最大 ID 已达
   * 745 —— 若持续按当前密度增长,先撞到的是 4095 这面墙。
   */
  ratio: number | null;
  /** 备注(约束来源)。 */
  note: string;
}

/**
 * 内容容量账本。
 *
 * **为什么需要它**:位宽是硬约束,但没有任何地方在**编译/测试**时
 * 提醒「OBJ 层快满了」。加内容的人只能靠记忆或 `grep` 数。
 * 这份账本把「还剩多少」变成可断言的数据。
 */
export function contentCapacity(): CapacityEntry[] {
  const out: CapacityEntry[] = [];

  /* — OBJ 层物品 ID:12 位,0..4095 — */
  const usedIds = ITEM_LIST.map((i) => i.id).filter((id) => id > 0);
  const maxId = usedIds.length > 0 ? Math.max(...usedIds) : 0;
  /* 真实可用号数:值域总宽 − 已用件数。**不是** capacity − maxId ——
     物品 ID 中间有大量空档(实测共 3775 个可用号,而 capacity − maxId 只有 3350)。 */
  const objFree = FIELD_MAX.OBJ - usedIds.length;
  out.push({
    space: 'OBJ 层物品 ID',
    used: usedIds.length,
    capacity: FIELD_MAX.OBJ,
    headroom: FIELD_MAX.OBJ - maxId,
    freeCount: objFree,
    ratio: maxId / FIELD_MAX.OBJ,
    note: `12 位上限 ${FIELD_MAX.OBJ};当前最大 ID ${maxId};可用号 ${objFree}(含中间空档)`,
  });

  /* — FLOOR 槽位:6 位,1..63(0 = 无铺装) — */
  const FLOOR_CAP = FIELD_MAX.FLOOR; // 63
  const floorTable = ITEM_TABLES.find((t) => t.key === '3.5');
  const floorBase = floorTable ? floorTable.count : 0; // 30 种真实地砖
  out.push({
    space: 'FLOOR 地砖槽位',
    used: floorBase,
    capacity: FLOOR_CAP,
    headroom: FLOOR_CAP - floorBase,
    freeCount: FLOOR_CAP - floorBase,
    ratio: floorBase / FLOOR_CAP,
    note: `6 位上限 ${FLOOR_CAP};1~${floorBase} 为真实地砖,${floorBase + 1}~${FLOOR_CAP} 为 UGC 变体槽`,
  });

  /* — 字符串 ID 内容:无位宽约束 — */
  out.push({
    space: '生物 ID(字符串)',
    used: MOB_LIST.length,
    capacity: null,
    headroom: null,
    freeCount: null,
    ratio: null,
    note: '字符串 ID,不受位宽限制;但新增后需同步 AOI/behavior 注册表',
  });
  out.push({
    space: 'Boss ID(字符串)',
    used: BOSS_LIST.length,
    capacity: null,
    headroom: null,
    freeCount: null,
    ratio: null,
    note: '字符串 ID,不受位宽限制',
  });
  out.push({
    space: '派对模式',
    used: PARTY_MODES.length,
    capacity: null,
    headroom: null,
    freeCount: null,
    ratio: null,
    note: '新增需同步计分器与 UI',
  });
  out.push({
    space: '房间配方',
    used: ROOM_RECIPES.length,
    capacity: null,
    headroom: null,
    freeCount: null,
    ratio: null,
    note: '新增需同步 ROOM_RECIPES 与识别算法',
  });

  return out;
}

/* ═══════════════════════ 2. 内容指纹 ═══════════════════════ */

/**
 * 内容指纹算法版本。
 *
 * 指纹本身会随算法演进而变;把版本一并记入指纹,使「同一份内容、
 * 不同算法」也能区分开,避免升级算法后误判成「内容变了」。
 */
export const CONTENT_FINGERPRINT_VERSION = 1;

/** FNV-1a 32 位,十六进制 8 字符。与 WS-07 的迁移 checksum 同族。 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    /* imul 保持 32 位溢出语义 */
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 规范化序列化:把任意嵌套值排成**唯一的**字符串形式。
 *
 * 对象键按字典序排列,数组保持顺序(数组顺序通常是语义的一部分,
 * 例如 `loot: [704, 719, 727]`)。
 *
 * **为什么必须规范化**:`JSON.stringify` 的输出依赖键的插入顺序,
 * 同一份内容用不同写法声明会得到不同字符串 → 不同指纹 →
 * 误报「内容变了」。指纹的全部价值在于**稳定**,所以先规范再哈希。
 */
export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undef';
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize((v as Record<string, unknown>)[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(String(v));
}

/** 各内容分区的指纹。 */
export interface ContentFingerprints {
  /** 算法版本。 */
  version: number;
  /** 物品表指纹(含 ID、名称、类别、词条、价值)。 */
  items: string;
  /** 生物表指纹。 */
  mobs: string;
  /** Boss 表指纹。 */
  bosses: string;
  /** 派对模式 + 房间配方。 */
  modes: string;
  /** 全部内容合并指纹 —— **存档/协议只需比对这一个**。 */
  overall: string;
}

/**
 * 计算内容指纹。
 *
 * **用途**:
 *   - 存档时写入 `content_fingerprint`;载入时比对,不一致则拒绝或迁移,
 *     而不是静默读到「另一个物品」;
 *   - 覆盖率测试:断言「指纹未变」即可保证重构没有意外改动内容;
 *   - 客户端/服务端握手:防止内容版本错配导致的 ID 语义分歧。
 *
 * **注意**:指纹只反映**内容数据**,不反映代码。改了算法逻辑而内容不变时
 * 指纹应当不变,这正是它有用的原因 —— 它隔离了「数据变更」这一个变量。
 */
export function contentFingerprints(): ContentFingerprints {
  const items = canonicalize(ITEM_LIST.map((i) => ({ id: i.id, name: i.name, category: i.category, tags: i.tags, value: i.value })));
  const mobs = canonicalize(MOB_LIST.map((m) => ({ id: m.id, name: m.name, biome: m.biome, hp: m.hp, exp: m.exp })));
  const bosses = canonicalize(BOSS_LIST.map((b) => ({ id: b.id, name: b.name, baseHp: b.baseHp, summonItem: b.summonItem, loot: b.loot })));
  const modes = canonicalize({ modes: PARTY_MODES, rooms: ROOM_RECIPES });

  const fi = fnv1a32(items);
  const fm = fnv1a32(mobs);
  const fb = fnv1a32(bosses);
  const fd = fnv1a32(modes);
  const overall = fnv1a32(`${CONTENT_FINGERPRINT_VERSION}|${fi}|${fm}|${fb}|${fd}`);

  return { version: CONTENT_FINGERPRINT_VERSION, items: fi, mobs: fm, bosses: fb, modes: fd, overall };
}

/** 单行摘要,便于写进存档列或日志。 */
export function contentFingerprintLine(): string {
  const f = contentFingerprints();
  return `v${f.version}-${f.overall}`;
}

/* ═══════════════════════ 3. ID 区间登记 ═══════════════════════ */

/**
 * ID 区间登记:声明每个区段「属于谁」。
 *
 * **为什么需要它**:新增内容时可用的 ID 不是一个连续数组,而是若干**有空隙的区间**:
 * 物品表只用了 101~745 中的 320 个号,中间有 131~150、171~200 等大量空段。
 * 没有任何地方记录「这些空段是留给谁的」,于是新增时会随手挑一个空号,
 * 破坏了「区间 ↔ 手册章节」的对应关系(而验证器正是按区间核对分表数量的)。
 *
 * **重要语义**:每个分表区间都是**紧包的**(`range` 恰好等于 `count`),
 * 所以「区间已满」是设计事实,不是容量告警 —— 手册为每张表精确分配了号段。
 * 真正的扩展空间在**区间之间的空隙**上,由 `freeIdSegments()` 报出。
 * 早先把 `reservedForExtension` 按「区间内是否留白」计算,导致 10 张表
 * 全部显示「已满」、看起来毫无扩展余地;那是把「表内紧包」误读成
 * 「整个 ID 空间无余量」。
 */
export interface IdSegment {
  /** 区间名,通常对应手册章节。 */
  key: string;
  /** 闭区间下界。 */
  from: number;
  /** 闭区间上界。 */
  to: number;
  /** 已用数量。 */
  used: number;
  /** 区间内的留白数(手册为表内预留时 > 0;当前全部为 0)。 */
  slackInside: number;
  /** 说明。 */
  note: string;
}

/** 由内容表与手册章节区间推导出 ID 区间登记。 */
export function idSegments(): IdSegment[] {
  return ITEM_TABLES.map((t) => {
    const [from, to] = t.range;
    const span = to - from + 1;
    const slack = span - t.count;
    return {
      key: t.key,
      from,
      to,
      used: t.count,
      slackInside: slack,
      note:
        slack > 0
          ? `${t.title};区间宽 ${span},已用 ${t.count},表内留白 ${slack} 个号`
          : `${t.title};区间紧包(${t.count} 号占满 ${from}~${to}),扩展请用区间之间的空档`,
    };
  });
}

/**
 * 找出未被任何分表覆盖的空闲 ID,返回合并后的区间。
 *
 * @param minLength 只返回长度 ≥ 此值的连续段。默认 8 —— 短于 8 的空隙
 *   (如 §3.3 与 §3.4 之间的 219~220)在「决定往哪加内容」时没有实用价值,
 *   列出来只会淹没真正可用的号段。
 *
 *   **但要注意它是有损的**:过滤掉的短段仍是**真实空闲的 ID**。
 *   所以「可用空间总量」不能用本函数的输出求和 —— 那会漏算。
 *   要精确数字请用 `freeIdCount()`。CLI 早先正是用输出求和报了 3773,
 *   而真实空闲是 3775,差了 219~220 两个号。看起来精确的数字有偏差,
 *   比明显错误更危险:读的人不会去验算。
 */
export function freeIdSegments(minLength = 8): IdSegment[] {
  const used = new Set<number>();
  for (const t of ITEM_TABLES) {
    const [from, to] = t.range;
    for (let id = from; id <= to; id += 1) used.add(id);
  }
  const out: IdSegment[] = [];
  let start = -1;
  const MAX = FIELD_MAX.OBJ;
  for (let id = 1; id <= MAX; id += 1) {
    const isFree = !used.has(id);
    if (isFree && start === -1) start = id;
    if (!isFree && start !== -1) {
      out.push(makeFreeSegment(start, id - 1));
      start = -1;
    }
  }
  if (start !== -1) out.push(makeFreeSegment(start, MAX));
  return out.filter((s) => s.to - s.from + 1 >= minLength);
}

function makeFreeSegment(from: number, to: number): IdSegment {
  return {
    key: `FREE_${from}_${to}`,
    from,
    to,
    used: 0,
    slackInside: to - from + 1,
    note: `空闲 ${to - from + 1} 个号`,
  };
}

/**
 * 空闲 ID 的**精确**总数(不受 `freeIdSegments` 的 minLength 过滤影响)。
 *
 * 恒等于 `FIELD_MAX.OBJ - 已用 ID 数`。之所以单独提供而不让调用方去求和,
 * 是因为「求和会漏算短段」这件事不明显。
 */
export function freeIdCount(): number {
  const used = new Set<number>();
  for (const t of ITEM_TABLES) {
    const [from, to] = t.range;
    for (let id = from; id <= to; id += 1) used.add(id);
  }
  return FIELD_MAX.OBJ - used.size;
}

/* ═══════════════════════ 4. 扩展检查器 ═══════════════════════ */

/** 一次内容扩展的一致性检查结果。 */
export interface ContentAudit {
  ok: boolean;
  /** 内容指纹。 */
  fingerprint: ContentFingerprints;
  /** 容量账本。 */
  capacity: CapacityEntry[];
  /** 问题列表(空 = 通过)。 */
  problems: string[];
  /** 提示列表(不阻断,但值得看)。 */
  notes: string[];
}

/**
 * 审计当前内容表的一致性。
 *
 * 检查项:
 *   1. 物品 ID 全局唯一且 > 0;
 *   2. 物品 ID 是否超出 OBJ 层 12 位上限;
 *   3. 每个物品的 `category` 是否在已知 12 类内;
 *   4. 生物/Boss 的掉落与召唤物是否都指向存在的物品 ID(防悬空引用);
 *   5. 保留容量余量是否低于阈值。
 *
 * 这些检查正是「扩容时最容易出错的地方」,做成函数后可以进验证器。
 */
export function auditContent(): ContentAudit {
  const problems: string[] = [];
  const notes: string[] = [];

  /* 1. ID 唯一且为正 */
  const seen = new Map<number, string>();
  for (const it of ITEM_LIST) {
    if (!Number.isInteger(it.id) || it.id <= 0) {
      problems.push(`物品 ID 非法:${it.id}(${it.name})`);
      continue;
    }
    const prev = seen.get(it.id);
    if (prev !== undefined) problems.push(`物品 ID 重复:${it.id}(${prev} 与 ${it.name})`);
    else seen.set(it.id, it.name);
  }

  /* 2. 位宽上限 */
  for (const it of ITEM_LIST) {
    if (it.id > FIELD_MAX.OBJ) {
      problems.push(`物品 ${it.id}(${it.name}) 超出 OBJ 层 12 位上限 ${FIELD_MAX.OBJ},打包时会被静默截断`);
    }
  }

  /* 3. 类别合法性
     
     必须用**冻结层**的 ItemCategory 作权威清单,不能用从 ITEM_LIST 自建的集合 ——
     那样 `has(it.category)` 对每一项恒真,检查永远不可能失败(同义反复)。
     我最初就是这么写的:审计「通过」了,但它什么都没检查。

     这个错误的形态值得记住:违反检查的数据**恰恰会自己定义出合法集合**,
     所以自建集合的写法在逻辑上不可能报错。 */
  const KNOWN_CATEGORIES = new Set<string>(Object.values(ItemCategory));
  for (const it of ITEM_LIST) {
    if (!KNOWN_CATEGORIES.has(it.category)) {
      problems.push(`物品 ${it.id}(${it.name})类别未知:${it.category}(冻结层 ItemCategory 无此项)`);
    }
  }
  /* 反向检查:冻结层有但内容表未使用的类别 —— 不阻断,但值得知道。
     文案里的件数用 `ITEM_LIST.length` 动态拼 —— 早先硬编码「当前 320 件」,
     内容一扩容这句话就失真,而失真的一句话比没有更糟(读者会信它)。 */
  const usedCategories = new Set(ITEM_LIST.map((i) => i.category));
  for (const c of KNOWN_CATEGORIES) {
    if (!usedCategories.has(c)) {
      notes.push(
        `类别 ${c} 在冻结层存在,但当前 ${ITEM_LIST.length} 件静态内容中没有任何物品使用它` +
          `(若该类为运行时生成内容预留,属预期)`,
      );
    }
  }

  /* 4. 引用闭合:生物掉落 / 驯养物、Boss 召唤物 / 战利品 */
  const itemIds = new Set(ITEM_LIST.map((i) => i.id));
  for (const m of MOB_LIST) {
    for (const k of Object.keys(m.drops ?? {})) {
      const id = Number(k);
      if (!itemIds.has(id)) problems.push(`生物 ${m.id} 掉落引用了不存在的物品 ${id}`);
    }
    if (m.tameItem !== null && m.tameItem !== undefined && !itemIds.has(m.tameItem)) {
      problems.push(`生物 ${m.id} 驯养物 ${m.tameItem} 不存在`);
    }
  }
  for (const b of BOSS_LIST) {
    if (b.summonItem !== null && b.summonItem !== undefined && !itemIds.has(b.summonItem)) {
      problems.push(`Boss ${b.id} 召唤物 ${b.summonItem} 不存在`);
    }
    for (const l of b.loot ?? []) {
      if (!itemIds.has(l)) problems.push(`Boss ${b.id} 战利品 ${l} 不存在`);
    }
  }

  /* 5. 容量告警:值域占用超 90% 时提示。
     用 ratio(最高已用值/值域)而非 used/capacity —— ID 空间是稀疏的,
     先撞到的是值域上界这面墙,不是件数上限。 */
  const cap = contentCapacity();
  for (const c of cap) {
    if (c.ratio !== null && c.ratio > 0.9) {
      notes.push(`${c.space} 值域已占 ${(c.ratio * 100).toFixed(1)}%,接近上限:${c.note}`);
    }
  }

  return { ok: problems.length === 0, fingerprint: contentFingerprints(), capacity: cap, problems, notes };
}

/** 人类可读的容量报表。 */
export function capacityReport(): string {
  const rows = contentCapacity();
  const lines: string[] = ['空间                    已用    值域   顶端余量    可用     占用'];
  lines.push('─'.repeat(70));
  for (const r of rows) {
    const cap = r.capacity === null ? '    —' : String(r.capacity).padStart(7);
    const head = r.headroom === null ? '      —' : String(r.headroom).padStart(8);
    const free = r.freeCount === null ? '     —' : String(r.freeCount).padStart(7);
    const pct = r.ratio === null ? '    —  ' : `${(r.ratio * 100).toFixed(1)}%`.padStart(7);
    lines.push(`${r.space.padEnd(22)}${String(r.used).padStart(5)}${cap}${head}${free}  ${pct}`);
  }
  lines.push('─'.repeat(70));
  lines.push('值域 = 位宽推出的总宽;顶端余量 = 值域上界 − 最高已用值;可用 = 真实空闲号数(含中间空档)');
  return lines.join('\n');
}