/**
 * **主线 HUD 的一行指引**(纯函数 / 零 DOM / 零 three ⇒ `node` 里可直接断言)。
 *
 * ## 它补的是哪一格
 *
 * `server/src/quests/mainline.ts` 知道「玩家走到第几步了」,但 HUD 上此前**没有一行**
 * 告诉玩家「现在该干什么」。本文件就是那一行:
 * ```text
 * □ 主线 1/6 采集:对着面前的树 / 矿脉 / 灌木按 5(采集),拿到 1 份自然材料
 * ✓ 主线六步全通:采 → 造 → 建 → 打 → 打疼 Boss 都做到了,接下来去炼金台试试 AI 万物炼金
 * ```
 *
 * ## 六步文案各不相同,且与「全通」文案都不同
 *
 * 判据在 `tests/WS-FND-187-mainline.test.ts` FND187-14/15 —— **两两不同**是有牙的:
 * 把六行抄成同一句(或把 `done` 分支写成第 6 步的文案),那两条立刻红。
 *
 * ## 为什么**不 import** `server/src/quests/mainline.ts`
 *
 * 客户端不该依赖服务端模块(层次方向固定:`server → shared ← client`,两边各自持有
 * 结构相同的视图)。这里用**结构化**接口 `MainlineHudView` 对接:字段名 / 含义与
 * `MainlineView` 逐字一致,`mainlineState(state)` 的返回值可以直接喂进 `planMainlineHud`
 * (FND187-17 用一个真实赋值把「两者仍然兼容」钉住);`stepId` 故意收成 `string`,
 * 于是服务端加一步 **不会**让客户端当场编译失败(加步要改的是文案表,不是类型)。
 *
 * ## 兜底:不认识就退到第 1 步,不抛、不返回空串
 *
 * 线上 `stepId` 被污染 / `step` 越界(快照跨版本、老客户端读到新步号)时**必须有一行字**
 * ——空串在 HUD 上等于「这一行不存在」,而玩家**正**需要指引。判据 FND187-16。
 */

/** 一步的文案行。 */
export interface MainlineHudRow {
  /** 与 `server/src/quests/mainline.ts#MAINLINE_STEP_IDS` 同值(顺序即步号)。 */
  readonly stepId: string;
  /** 1..6 = 步号;必须等于表内下标 + 1。 */
  readonly order: number;
  /** 这一步的一句话指引(**动作 + 键位 + 判定**,玩家读完就能动)。 */
  readonly hint: string;
}

/**
 * HUD 侧持有的「主线视图」。
 *
 * 字段与 `server/src/quests/mainline.ts#MainlineView` **逐字一致**(`step` / `stepId` /
 * `done` / `progress`)—— 刻意**不 import** 那个模块:客户端不依赖服务端(见文件头),
 * 两者靠**结构**兼容,FND187-17 用一个真实赋值钉住它。
 *
 * `stepId` 是 `string` 而不是六步联合:服务端加一步时,客户端**不该**编译失败 ——
 * 它该做的是补一行文案(`MAINLINE_HUD_ROWS`),而在补上之前兜底会给出第 1 步的指引。
 */
export interface MainlineHudView {
  /** 当前步号 1..6(全通时停在 6)。 */
  readonly step: number;
  /** 步骤 id(`'gather' | 'craft' | ...`;不认识时按 `step` 兜底)。 */
  readonly stepId: string;
  /** 六步全通。 */
  readonly done: boolean;
  /** 整体进度 0..1(本文件不直接用它,保留它是为了与服务端视图**结构一致**)。 */
  readonly progress: number;
}

/** 六步文案表(顺序即步号;`stepId` 与 `MAINLINE_STEP_IDS` 同值)。 */
export const MAINLINE_HUD_ROWS: readonly MainlineHudRow[] = [
  {
    stepId: 'gather',
    order: 1,
    hint: '采集:对着面前的树 / 矿脉 / 灌木按 5(采集),拿到 1 份自然材料',
  },
  {
    stepId: 'craft',
    order: 2,
    hint: '合成:站到工作台旁按 N(合成)造 1 件工具,例:201 暖松石刃斧 = 101×2 + 106×2',
  },
  {
    stepId: 'place',
    order: 3,
    hint: '建造:选中背包里的一块,朝面前那格按 Q(放置),放下 1 个方块或家具',
  },
  {
    stepId: 'travel',
    order: 4,
    hint: '出发:走出中央营地,踏进另一个区(草原 / 竹林 / 矿丘 / 农田 / 遗迹 ...)',
  },
  {
    stepId: 'hunt',
    order: 5,
    hint: '狩猎:靠近野猪 / 野狼按空格攻击,击杀 1 只野生动物(能驯养的可以放它一马)',
  },
  {
    stepId: 'boss',
    order: 6,
    hint: '变强:Boss 房里按住空格输出,把 1 只 Boss 的血量打掉一半(≤ 50%)',
  },
];

/** 六步全通后的收尾文案(**必须与六行步骤文案都不同**,FND187-15)。 */
export const MAINLINE_HUD_DONE_TEXT =
  '主线六步全通:采 → 造 → 建 → 打 → 打疼 Boss 都做到了,接下来去炼金台试试 AI 万物炼金';

/** 未完成行的行首标记(`□` = 待办)。 */
export const MAINLINE_HUD_TODO_MARK = '□';
/** 全通行首标记(`✓` = 那个勾)。 */
export const MAINLINE_HUD_DONE_MARK = '✓';

/** `planMainlineHud` 的返回:一行文本 + 那个勾。 */
export interface MainlineHudPlan {
  /** HUD 直接画这一行(非空;不认识的状态退到第 1 步)。 */
  readonly text: string;
  /** 六步全通(`${text}` 是收尾文案)。 */
  readonly done: boolean;
}

/**
 * 收窄视图:`step` 只认 `[1, 6]` 的整数,其它一律按「不知道第几步」处理(`0`)。
 *
 * ⚠️ **不夹到边界**:越界 `step: 99` 若夹成 6,HUD 会写「6/6 变强:把 Boss 打掉一半」——
 * 那是**谎报**,玩家会以为打 Boss 已经开始了。夹到 1 同样是猜。不知道就退到第 1 步的
 * 指引(至少那一句永远是真的:「先采集」)。
 */
function normalizeView(view: MainlineHudView | null | undefined): { step: number; stepId: string; done: boolean } {
  const raw = (view ?? {}) as { step?: unknown; stepId?: unknown; done?: unknown };
  const step = typeof raw.step === 'number' && Number.isInteger(raw.step)
    && raw.step >= 1 && raw.step <= MAINLINE_HUD_ROWS.length
    ? raw.step
    : 0;
  const stepId = typeof raw.stepId === 'string' ? raw.stepId : '';
  return { step, stepId, done: raw.done === true };
}

/** 取那一步的文案:先按 `stepId` 认,`stepId` 不认识再按步号认,都认不出 ⇒ 第 1 步。 */
function rowFor(stepId: string, step: number): MainlineHudRow {
  const byId = MAINLINE_HUD_ROWS.find((r) => r.stepId === stepId);
  if (byId !== undefined) return byId;
  const byOrder = MAINLINE_HUD_ROWS[step - 1];
  return byOrder ?? MAINLINE_HUD_ROWS[0];
}

/**
 * 视图 → HUD 一行。
 *
 * 语义:
 *   · 每一步一句**不同**的指引,句首是 `□ 主线 n/6`;
 *   · `done === true` ⇒ 换成收尾文案(`✓` 开头),`done` 照实回 `true`;
 *   · 未知 `stepId` / 越界 `step` / `null` ⇒ 退到第 1 步文案,**不抛**,`done` 仍照实判。
 */
export function planMainlineHud(view: MainlineHudView | null | undefined): MainlineHudPlan {
  const safe = normalizeView(view);
  if (safe.done) {
    return { text: `${MAINLINE_HUD_DONE_MARK} ${MAINLINE_HUD_DONE_TEXT}`, done: true };
  }
  const row = rowFor(safe.stepId, safe.step);
  return {
    text: `${MAINLINE_HUD_TODO_MARK} 主线 ${row.order}/${MAINLINE_HUD_ROWS.length} ${row.hint}`,
    done: false,
  };
}
