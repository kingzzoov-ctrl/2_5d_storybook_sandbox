/**
 * **急行(急单)开工条件**清单的纯逻辑(零 DOM、零 three ⇒ node 里可直接断言)。
 *
 * ## 为什么要有这个文件(WS-FND-151)
 *
 * 急单的三段全在**世界侧**(`world_sim.tickPartyStep` → `startRushRun` /
 * `submitDelivery` / `settleSession`),玩家侧**没有专用键**。于是玩家能问的唯一
 * 问题是「为什么还没开工?」——
 * ```
 * 食堂建成(COZY_CANTEEN:506 + 519)
 * 三工位在场(506 汤锅 / 508 披萨炉 / 507 切菜台)
 * 有人站在工位格上
 * ```
 * 这三条在 `server/src/sim/world_sim.ts::stepRushEntry` 里是**顺序三条 return**,
 * 客户端此前**一条都看不到** ⇒ 症状是「摆好了什么都不发生」。
 *
 * ## 三态,不是布尔(这条是本文件的全部要点)
 *
 * 线快照 `RoomState`(`shared/types/wire.ts`)只有
 * `meta / players / wildlife / bosses` —— **没有 rooms、没有器件格**。
 * ⇒ 「食堂建成」与「三工位在场」在**今天的客户端拿不到**。
 *
 * 拿不到就必须说**未知**:
 * ```
 * ✗ 假装 0   ⇒ 玩家以为没建好,反复去拆/重建(而它可能早就好了)
 * ✓ 'unknown' ⇒ 面板写「?」并说明"快照不含房间/器件数据"
 * ```
 * 所以每条条件是 `met | unmet | unknown` 三态,`met` 的计数**只数已知为真的**,
 * 未知的那些单独报数 —— 不混进分子,也不混进分母。
 *
 * 判据:`tests/WS-FND-151-party-ui.test.ts`(三项各自的正例 / 反例 / 未知例)。
 */

/** 一条条件的三态。字符串常量(本仓禁 enum)。 */
export const RushConditionState = {
  /** 权威状态说**满足** */
  MET: 'met',
  /** 权威状态说**不满足** */
  UNMET: 'unmet',
  /** 拿不到权威值 —— **不知道**,不是"没满足" */
  UNKNOWN: 'unknown',
} as const;
export type RushConditionState = (typeof RushConditionState)[keyof typeof RushConditionState];

/** 一条条件的静态描述(标签只此一处;`server/src/sim/world_sim.ts` 的实现是权威)。 */
export interface RushConditionSpec {
  id: string;
  label: string;
}

/**
 * 世界侧开工的三条前置 —— 顺序与 `stepRushEntry` 的判序**逐条对应**
 * (`server/src/sim/world_sim.ts`:食堂 → 三工位 → 站格)。
 */
export const RUSH_START_CONDITIONS: readonly RushConditionSpec[] = [
  { id: 'canteen', label: '食堂建成(COZY_CANTEEN:506 汤锅 + 519)' },
  { id: 'stations', label: '三工位在场(506 汤锅 / 508 披萨炉 / 507 切菜台)' },
  { id: 'actorAtStation', label: '有人站在工位格上' },
];

/**
 * 权威输入。`true` / `false` = 知道;`null` / `undefined` / 其它任何值 = **不知道**。
 *
 * ⚠️ 只认**字面布尔**:`1` / `'true'` 一律当未知 —— 把可疑值当"满足"就是假装,
 * 而这正是本文件要消灭的那种形态。
 */
export interface RushReadinessInput {
  canteen?: boolean | null;
  stations?: boolean | null;
  actorAtStation?: boolean | null;
}

/** 面板里的一行。 */
export interface RushConditionRow extends RushConditionSpec {
  state: RushConditionState;
  /** 行首标记:`✓` / `✗` / `?`(unknown 用问号,不用空格 —— 空白读起来像"没这一条") */
  mark: string;
  /** 整行文本 */
  text: string;
}

/** 一屏能读到的全部信息。 */
export interface RushReadinessView {
  rows: RushConditionRow[];
  /** 已知**满足**的条数(只数 `met`) */
  met: number;
  /** 已知**不满足**的条数 */
  unmet: number;
  /** **不知道**的条数(不许并进 `unmet`) */
  unknown: number;
  total: number;
  /** 一句话:`急行开工 1/3 满足(<3 项未知>)` */
  text: string;
  /** 未知的原因(没有未知项时是空串);由调用方给出,本函数原样带上 */
  note: string;
}

const MARKS: Readonly<Record<RushConditionState, string>> = {
  [RushConditionState.MET]: '✓',
  [RushConditionState.UNMET]: '✗',
  [RushConditionState.UNKNOWN]: '?',
};

/** 单个值 → 三态(只认字面 `true` / `false`)。 */
export function rushConditionStateOf(v: unknown): RushConditionState {
  if (v === true) return RushConditionState.MET;
  if (v === false) return RushConditionState.UNMET;
  return RushConditionState.UNKNOWN;
}

/**
 * 三态清单 + 计数 + 一行文本。
 *
 * `note` 由调用方给(例如"快照不含房间/器件数据")—— 本函数不猜原因,
 * 但它**只在真的有未知项时**才带出来,以免"未知 0 项"时还挂一句解释。
 */
export function rushReadinessOf(input: RushReadinessInput = {}, note = ''): RushReadinessView {
  const pairs: Array<[RushConditionSpec, unknown]> = [
    [RUSH_START_CONDITIONS[0]!, input.canteen],
    [RUSH_START_CONDITIONS[1]!, input.stations],
    [RUSH_START_CONDITIONS[2]!, input.actorAtStation],
  ];
  const rows: RushConditionRow[] = pairs.map(([spec, raw]) => {
    const state = rushConditionStateOf(raw);
    return { id: spec.id, label: spec.label, state, mark: MARKS[state], text: `${MARKS[state]} ${spec.label}` };
  });
  let met = 0;
  let unmet = 0;
  let unknown = 0;
  for (const r of rows) {
    if (r.state === RushConditionState.MET) met += 1;
    else if (r.state === RushConditionState.UNMET) unmet += 1;
    else unknown += 1;
  }
  const total = rows.length;
  const suffix = unknown > 0 ? `(${unknown} 项未知)` : '';
  return {
    rows,
    met,
    unmet,
    unknown,
    total,
    text: `急行开工 已知 ${met}/${total} 满足${suffix}`,
    note: unknown > 0 ? note : '',
  };
}

/**
 * 今天客户端**为什么**三项都未知 —— 一句话,写进面板。
 *
 * 出处:`shared/types/wire.ts` 的 `RoomState` 只有 `meta / players / wildlife / bosses`;
 * 房间(食堂)与器件格(三工位)**都没有字段**。哪天它们上线了,这条说明就该删,
 * 并把 `three/boot.ts` 里那个输入从 `null` 换成真值 —— 那时判据会盯着改。
 */
export const RUSH_SNAPSHOT_GAP =
  '快照不含房间/器件数据(wire 的 RoomState 无 rooms/devices)⇒ 三项只能报未知';