/**
 * 世界侧「**一直挂着的五笔账**」—— 机器可读台账(★ WS-FND-147)。
 *
 * ## 为什么要有这个文件(而不是只在注释里各写一段)
 *
 * 这五笔账在被清点之前的形态是**五种不同的静默**:
 * ```text
 * D1  z 轴        客户端回声 ⇒ 服务端高度变化最多被回拖一个 RTT(**行为错**,不报错)
 * D2  EARTH/WATER 元素表里根本没有这两个元素 ⇒ 房间语义只能落到别的元素(**内容缺口**)
 * D3  0.5         待平衡占位数值(标记散落在两个文件的注释里,**没有一处可被工具读到**)
 * D4  0.15        同上
 * D5  gz < 0      落地分支的一侧是**死代码**(冻结层把 z 硬钳 ≥ 0)
 * ```
 * 五笔账里有两笔是**必须由 owner 裁决**的平衡数值(D3/D4)。「把它们记在注释里」
 * 在本仓是不够的:注释不会被任何门禁读,改一个数也不会有任何东西变红。
 * ⇒ 这里把它们变成**数据**:每条账带 `status` / `owner` / `evidence`(文件 + 源码里
 *   必须出现的字面量)。`tests/WS-FND-147` 逐条把 `evidence` 拿去**真读源码**核对。
 *
 * ## 这个文件**不做**什么
 *
 * - **不改任何数值**(D3/D4 的 0.5 / 0.15 一个字节都没动 —— 那是平衡裁决,不是实现);
 * - **不扩元素表**(D2 登记「不扩」的理由,扩表属 `combat/**` + owner 裁决);
 * - **不参与**任何结算:纯数据 + 纯函数,谁 import 它都不会让游戏行为变一位。
 *
 * ## 与 `combat/wiring_ledger.ts` 的分工
 *
 * 那个是 **combat/** 内部「实现了但没接」的账本;本文件是**世界侧跨层**的账
 * (z 权威 / 元素表 / 待平衡数值 / 物理落地分支)。两份都**不是**玩法状态,
 * 都只回答一个问题:「本世界跑的这套东西里,哪些还是空壳/占位」。
 *
 * ⚠️ 判据纪律:`status` 是**声称**,`evidence` 是**可核对的事实**。
 *    `worldDebtVerdict()` 只核后者 —— 一条账可以「已登记」,但它引用的
 *    源码必须真的写着那句话,否则「登记」就是空话。
 */

/** 一条账的三种状态(仓规禁 `enum`:用 `as const` + 字面量联合)。 */
export const WORLD_DEBT_STATUS = {
  /** 已经真的接上(有生产调用点 + 判据)。 */
  WIRED: '已接',
  /** **明确登记**「为什么现在不做 / 谁来做」—— 不是遗忘,是裁决。 */
  REGISTERED: '已登记',
  /** 按现状**订正了说法**(代码没改,错误的注释被改成事实)。 */
  CLOSED: '已按现状订正',
} as const;
export type WorldDebtStatus = (typeof WORLD_DEBT_STATUS)[keyof typeof WORLD_DEBT_STATUS];

/**
 * 一条**可核对**的证据:`file` 里必须出现 `needle`(逐字、区分大小写)。
 *
 * 为什么是「文件 + 字面量」而不是行号:行号会随任何一次无关编辑漂移,
 * 而字面量只有在**那句话真的被改掉/删掉**时才会失配 —— 那正是我们要报警的时刻。
 */
export interface WorldDebtEvidence {
  /** 仓根相对路径(带 `.ts`)。 */
  file: string;
  /** 该文件里必须逐字出现的片段。 */
  needle: string;
}

/** 一条账。 */
export interface WorldDebtRow {
  /** 台账内的稳定 ID(`D1`..`D5`;不随顺序变)。 */
  id: string;
  /** 一句话标题(人读)。 */
  topic: string;
  status: WorldDebtStatus;
  /**
   * **裁决/结论**:现在是什么口径、为什么。
   *
   * ⚠️ 每一条都必须能被单独读懂 —— 不许写「见上文」「同上」。
   */
  decision: string;
  /**
   * **谁**来决定剩下的部分。
   *
   * 取值只有两种形态:
   * - `待平衡(owner)` —— 平衡数值,实现层**不许**自己定;
   * - `owner(<主题>)`  —— 需要裁决的结构性变更(扩元素表 / 改冻结层 ……)。
   */
  owner: string;
  /** 台账**自称**的事实(逐条被 `worldDebtVerdict` 拿去核)。 */
  evidence: readonly WorldDebtEvidence[];
}

/* ═══════════════════════════ 五笔账 ═══════════════════════════ */

export const WORLD_DEBTS: readonly WorldDebtRow[] = [
  {
    id: 'D1',
    topic: 'z 轴:服务端高度变化被客户端回声回拖(最多一个 RTT)',
    status: WORLD_DEBT_STATUS.WIRED,
    decision:
      '按**谁拥有 z** 分两段判,不再无条件照抄客户端声明:'
      + '(a) 刚体在**空中**(`vz !== 0`)或**服务端自己动过 z**(自上次报文以来 `b.z` 变了)'
      + '⇒ z 归服务端(物理积分 / 落地 / 蹦床 / 落穴 / 地形台阶),客户端声明值只当建议、'
      + '**不写进刚体**,裁决记在 `WorldSim.lastZAuthority.source === \'SERVER\'`;'
      + '(b) 刚体静止且服务端没动过 z ⇒ 沿用旧口径写声明值(`source === \'CLIENT\'`),'
      + '因为 `tests/WS-FND-49` 的 FND49-3 / FND49-5 把「带 z 的移动必须被接受」「省略 z 不改高度」'
      + '钉死为对外契约。⇒ **回拖那一段被切断**;「停在地上时客户端仍可声明高度」这一段'
      + '**明确保留并登记在此**(见 owner):它要改成服务端单调判定,必须同时改 FND49 的两条判据,'
      + '属契约变更,不在本批。',
    owner: 'owner(z 轴契约:停地状态下的高度是否由服务端单调裁决)',
    evidence: [
      { file: 'server/src/sim/world_sim.ts', needle: "lastZAuthority: { declared: number; applied: number; source: 'CLIENT' | 'SERVER' } | null = null;" },
      { file: 'server/src/sim/world_sim.ts', needle: 'const serverOwnsZ = b.vz !== 0 || (last !== undefined && b.z !== last);' },
      { file: 'server/src/net/room.ts', needle: 'p.z = auth?.z ?? intent.z;' },
    ],
  },
  {
    id: 'D2',
    topic: '元素表里没有 `EARTH` / `WATER`(房间语义落不到内容层)',
    status: WORLD_DEBT_STATUS.REGISTERED,
    decision:
      '**不扩表**(owner 未裁决,且元素表不在本批写域:`Element` / `ELEMENT_COUNTER` 住在 '
      + '`server/src/combat/weapons.ts`,属 combat 层)。现行口径:元素**只有 6 个**'
      + '(`NONE/FIRE/ICE/LIGHTNING/LIGHT/SLIME`),6×6 矩阵的四条自洽判据(四元环 / 反克对互反 / '
      + '四档取值 / 每元素至少一侧可达)由 `tests/WS-FND-111` 钉住;语义上是「土」的房间'
      + '(`ECO_RANCH`)与「水」的房间**一律不登记抗性**(`roomElementResistOf` 返回 `null`),'
      + '温室按内容里真实存在的 `LIGHT` 落。扩表要同时改:矩阵 6×6→8×8(含新元素的反克对互反)、'
      + '`DEAD_ELEMENTS` 登记、`MOB_ELEMENT_BY_ID`、`world_sim.damageKindOf` 的 `DamageKind` 映射、'
      + '以及 `tests/WS-FND-97`/`WS-FND-111` 的判据 ⇒ 一次性做完才算接上,半扩会让'
      + '「表里有、伤害从不产生」的元素变成新的静默死键。',
    owner: 'owner(是否扩元素表:8 元素 + 反克对 + 死亡出方)',
    evidence: [
      { file: 'server/src/combat/weapons.ts', needle: "export const ELEMENTS: readonly Element[] = ['NONE', 'FIRE', 'ICE', 'LIGHTNING', 'LIGHT', 'SLIME'];" },
      { file: 'server/src/combat/weapons.ts', needle: 'export const ELEMENT_COUNTER: Record<Element, Record<Element, number>> = {' },
      { file: 'server/src/rooms/effects.ts', needle: '要 `EARTH` / `WATER` 是 `combat` 层扩展元素表' },
    ],
  },
  {
    id: 'D3',
    topic: '`PENDING_ELEMENT_RESIST_MUL = 0.5` —— 房间元素抗性的占位系数',
    status: WORLD_DEBT_STATUS.REGISTERED,
    decision:
      '**数值不许由实现层改**(占位值,不是平衡裁决)。取 0.5 的唯一理由是**可观测**'
      + '(判据能用「同一次元素伤害减半」的关系式钉住,而不是把一个平衡数字抄进断言)。'
      + 'owner 给真内容就**整行替换** `server/src/rooms/effects.ts` 的 `ROOM_ELEMENT_RESIST`,'
      + '本常量随之退役;改这个数会让 `tests/WS-FND-93` / `WS-FND-97` 变红,'
      + '而**必须**同时改本行的 evidence(见 `worldDebtVerdict`)—— 两处不会静默分叉。',
    owner: '待平衡(owner)',
    evidence: [
      { file: 'server/src/rooms/effects.ts', needle: 'export const PENDING_ELEMENT_RESIST_MUL = 0.5;' },
      { file: 'server/src/rooms/effects.ts', needle: '待平衡' },
    ],
  },
  {
    id: 'D4',
    topic: '`MOB_RARE_DROP_CHANCE = 0.15` —— 稀有材料档的掉落概率',
    status: WORLD_DEBT_STATUS.REGISTERED,
    decision:
      '**数值不许由实现层按手感调**(手册里唯一的出处是 L387「稀有材料掉落率 +15%」,'
      + '引它的是 624 招财进宝猫耳箍那一行)。它只作用在手册**自己标了「稀有」**的两件掉落上'
      + '(753 / 751),手册没写概率的一律保持必掉。改这个数需新裁决或手册出新值,'
      + '判据 `tests/WS-FND-98` FND98-1 会当场变红 ⇒ 必须同时改本行 evidence。',
    owner: '待平衡(owner)',
    evidence: [
      { file: 'shared/constants/mobs.ts', needle: 'export const MOB_RARE_DROP_CHANCE = 0.15;' },
      { file: 'shared/constants/mobs.ts', needle: '待平衡(owner)' },
    ],
  },
  {
    id: 'D5',
    topic: '`gz < 0` 的「落穴」落地分支是死代码',
    status: WORLD_DEBT_STATUS.CLOSED,
    decision:
      '**按现状订正**(代码没动,错的注释改成事实):`groundZAt` 返回 `(elev & 3) - 1 ∈ {-1,0,1,2}`,'
      + '而冻结层 `integrateVertical` 把 z **硬钳在 ≥ 0** ⇒ `b.z <= gz` 在 `gz = -1`(深沟格)时'
      + '**永不成立**,能走到的只有 `gz ≥ 0`。深沟「掉进去」的观感来自落穴倍率'
      + '(`TRAP_FALL_MUL = 1.8` 让 z 更快归 0),不是真的落到 -1。'
      + '物理层那句「`< 0` 那一支是**死代码**」是本条的证据;行为面由 `tests/WS-FND-147`'
      + '的 FND147-9 钉住(`gz = -1` 格上 z 落 0,不会变负),负对照是 `gz = 1` 格上 z 真的到 1'
      + '(证明这条判据不是恒真)。',
    owner: 'owner(若要把深沟做成真的 -1 层,需改冻结层 integrateVertical)',
    evidence: [
      { file: 'server/src/physics/world.ts', needle: '那一支是**死代码**' },
      { file: 'server/src/physics/world.ts', needle: '硬钳在 ≥ 0' },
      { file: 'server/src/physics/world.ts', needle: 'export const TRAP_FALL_MUL = 1.8;' },
    ],
  },
];

/** 按 ID 取一条账(找不到 ⇒ `null`,与 `mobDefOf` 同一 null 契约)。 */
export function worldDebtOf(id: string): WorldDebtRow | null {
  return WORLD_DEBTS.find((d) => d.id === id) ?? null;
}

/**
 * **待平衡**的那几条(owner 形如 `待平衡(owner)`)。
 *
 * 存在的理由:本仓的「待平衡」散落在注释里,没有一处可被工具枚举 ——
 * `sync-docs` / `dead_items` 那一类工具要能回答「还有几个占位数值」时,
 * 需要一个**数据出口**(而不是 grep 中文)。
 */
export function pendingBalanceRows(): readonly WorldDebtRow[] {
  return WORLD_DEBTS.filter((d) => d.owner.startsWith('待平衡(owner)'));
}

/**
 * 一条账的**自检** —— 返回问题清单(空数组 = 合格)。
 *
 * 判据(四条,都是机械可判的):
 * ```text
 * 1 形状   id / topic 非空,status 是三个允许值之一;
 * 2 owner  必须写成 `待平衡(owner)` 或 `owner(...)` —— 不许空、不许「TODO」;
 * 3 裁决  decision 必须写清「现在是什么口径 / 为什么」(≥ 40 字,且不是 TODO 占位);
 * 4 证据  每条 evidence 的 file 存在,且该文件里**逐字**出现 needle。
 * ```
 * `read` 由调用方注入(本模块**不 import `node:fs`**):判据可被测试用**合成源码**
 * 注入验证 —— 「改了 needle 会不会红」这件事本身才有判据。
 */
export function worldDebtVerdict(
  row: WorldDebtRow,
  read: (path: string) => string | null,
): string[] {
  const bad: string[] = [];
  if (row.id.trim().length === 0) bad.push('id 为空');
  if (row.topic.trim().length === 0) bad.push(`${row.id}:topic 为空`);
  if (
    row.status !== WORLD_DEBT_STATUS.WIRED
    && row.status !== WORLD_DEBT_STATUS.REGISTERED
    && row.status !== WORLD_DEBT_STATUS.CLOSED
  ) {
    bad.push(`${row.id}:status 非法(${String(row.status)})`);
  }
  const ow = row.owner.trim();
  if (!(ow.startsWith('待平衡(owner)') || ow.startsWith('owner('))) {
    bad.push(`${row.id}:owner 必须写成 \`待平衡(owner)\` 或 \`owner(...)\`(实测 "${ow}")`);
  }
  const d = row.decision.trim();
  if (d.length < 40) bad.push(`${row.id}:decision 只有 ${d.length} 字(< 40),写不清口径`);
  else if (/^(?:todo|tbd|待办|待补|以后再说)/i.test(d)) bad.push(`${row.id}:decision 是 TODO 占位`);
  if (row.evidence.length === 0) bad.push(`${row.id}:没有任何 evidence(声称无法核对)`);

  for (const e of row.evidence) {
    if (e.file.trim().length === 0 || e.needle.trim().length === 0) {
      bad.push(`${row.id}:evidence 有一条 file/needle 为空`);
      continue;
    }
    const src = read(e.file);
    if (src === null) {
      bad.push(`${row.id}:evidence 指向的文件不存在:${e.file}`);
      continue;
    }
    if (!src.includes(e.needle)) {
      bad.push(`${row.id}:${e.file} 里找不到「${e.needle}」⇒ 台账与源码已分叉`);
    }
  }
  return bad;
}

/**
 * 整本台账的自检(逐条跑 `worldDebtVerdict` + 两条**全局**判据)。
 *
 * 全局判据:
 * ```text
 * G1 ID 唯一(D1..D5 各一条 —— 重复 ID 会让「查某条账」悄悄返回第一条);
 * G2 待平衡条目**至少两条**(D3/D4),且都必须是 `待平衡(owner)` 形态
 *    ⇒ 谁哪天把某条待平衡改成「已定」,这里会红(平衡裁决不许被实现层静默接管)。
 * ```
 */
export function worldDebtLedgerVerdict(read: (path: string) => string | null): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const row of WORLD_DEBTS) {
    if (seen.has(row.id)) bad.push(`重复的账 ID:${row.id}`);
    seen.add(row.id);
    bad.push(...worldDebtVerdict(row, read));
  }
  const pending = pendingBalanceRows();
  if (pending.length < 2) {
    bad.push(`待平衡(owner)条目只有 ${pending.length} 条(< 2):D3/D4 必须都在台账里`);
  }
  return bad;
}