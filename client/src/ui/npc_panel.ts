/**
 * **NPC 任务面板的「要画什么」**(纯函数 / 零 DOM / 零 three / 零 import ⇒ `node` 里可直接断言)。
 *
 * ## 它补的是哪一格
 *
 * 服务端早就有 `server/src/npc/dialogue.ts`(`talk()` / `acceptQuest()` / `progressOf()`),
 * 而且 `T` 键已经把 NPC 的**台词**送上 HUD 了(`WS-FND-188`)。但玩家看不到
 * 「这个 NPC 要我做什么、我还差几件、奖励是什么」—— 台词只有一句。本文件产出面板三段:
 * ```text
 * title  行首那一行(谁 + 哪条任务)
 * rows   面板正文(需求 / 奖励 / 进度,逐行)
 * hint   底部那一行键位提示(按哪个键、什么时候按)
 * ```
 *
 * ## 为什么是纯函数、为什么零 import
 *
 * 与 `mainline_hud.ts` 同一形状:输入 = 一份只读快照,输出 = 「要画什么」。
 * **不 import** `server/src/npc/dialogue.ts`:层次方向固定(`server → shared ← client`),
 * 客户端不该依赖服务端模块。两边靠**结构**对接,输入里 `quest` 的字段名与
 * `NpcOffer` 同一口径(`title` / `needItemId` / `needCount` / `rewardItemId` /
 * `rewardCount`;服务端叫 `questId`、这里叫 `id`,由调用方装配),
 * `status` 是 `'available' | 'accepted' | 'completed'` 三值联合 —— 与服务端
 * `QuestStatus` 同值。零 import 还有一个好处:`node` 能直接加载它,没有依赖链。
 *
 * ## 兜底:垃圾输入必须给「可读的一行」,而不是抛或者空串
 *
 * 面板上的空串 = 「这一块不存在」,而玩家**正**需要知道该干什么。逐条兜底
 * (判据 `FND192-6..9`,每条都断言「不抛 + 非空 + 可读」):
 * ```text
 * status 不认识         ⇒ 面板照画,正文点明「状态看不懂」,不猜他是哪一种
 * have 负数 / NaN / 非数 ⇒ 按 0 件算,并在正文注明「读数异常」
 * have 小数            ⇒ 截断,并在正文注明「不是整数,按 N 件算」
 * have > needCount     ⇒ 照实写 `进度:9/5`(多的那几件不吞掉,也不说谎)
 * needCount ≤ 0 / NaN  ⇒ 按「没写清要多少件」处理(不写 `还差 -1 件`)
 * itemName 抛错 / 空串  ⇒ 退到 `物品 #101`,不把异常抛进渲染循环
 * quest 为 null / 垃圾  ⇒ 那一句「他今天没什么要你做的。」
 * ```
 *
 * ## 键位
 *
 * `hint` 里的 `Y` 是**本文件提议**的接/交键位(`NPC_PANEL_ACCEPT_KEY`),
 * 按 `T` 说话那条已在 `client/src/three/boot.ts#NPC_TALK_KEY` 落地。接线时
 * 若主代理选了别的键,改这一个常量即可(判据读的是常量,不是字面量)。
 */

/** 面板要显示的 NPC(字段与 `server/src/npc/defs.ts#NpcDef` 的对应字段同口径)。 */
export interface NpcPanelNpc {
  /** NPC id(`server/src/npc/defs.ts#NPCS[].id`)。 */
  readonly id: string;
  /** 显示名。 */
  readonly name: string;
}

/**
 * 面板要显示的任务。
 *
 * `id` 对应服务端 `NpcOffer.questId`,其余字段与之**逐字同名**(刻意不 import)。
 */
export interface NpcPanelQuest {
  readonly id: string;
  readonly title: string;
  readonly needItemId: number;
  readonly needCount: number;
  readonly rewardItemId: number;
  readonly rewardCount: number;
}

/** `planNpcPanel` 的输入(一份只读快照 + 一个查名的回调)。 */
export interface NpcPanelInput {
  readonly npc: NpcPanelNpc;
  /** `null` = 这个 NPC 没有任务(与服务端 `NpcTalk.offer === undefined` 对应)。 */
  readonly quest: NpcPanelQuest | null;
  /** 与服务端 `QuestStatus` 同值;运行时不认识的一律走兜底分支。 */
  readonly status: 'available' | 'accepted' | 'completed';
  /** 背包里已有多少件 `needItemId`(服务端 `NpcOffer.have`)。 */
  readonly have: number;
  /**
   * 物品 id → 显示名。**不 import 内容表**:客户端侧的查名入口由调用方注入
   * (内容表在 `shared/constants/items.ts`);本函数只保证「抛错/返回空串也画得出字」。
   */
  readonly itemName: (id: number) => string;
}

/** 面板要画的东西:一行标题 + 若干正文行 + 一行键位提示。 */
export interface NpcPanelView {
  title: string;
  rows: string[];
  hint: string;
}

/** 无任务时那句正文(唯一一句,判据 FND192-11 钉它逐字)。 */
export const NPC_PANEL_IDLE_TEXT = '他今天没什么要你做的。';

/** 接 / 交任务用的键位(⚠️ 由主代理定键;`hint` 从它生成)。 */
export const NPC_PANEL_ACCEPT_KEY = 'Y';
/** 说话键(与 `client/src/three/boot.ts#NPC_TALK_KEY` 同值,大小写见那行注释)。 */
export const NPC_PANEL_TALK_KEY = 'T';

/** 无任务 / 已完成时的提示(只提示「还能说话」,不假装有可接的任务)。 */
export const NPC_PANEL_IDLE_HINT = `按 ${NPC_PANEL_TALK_KEY} 再跟他聊一句`;
/** `available` 时的提示(判据 FND192-2 断言含「按 Y 接下」)。 */
export const NPC_PANEL_ACCEPT_HINT = `按 ${NPC_PANEL_ACCEPT_KEY} 接下这个任务`;
/** `accepted` 且物品够了:这一次按下去就会交 + 发奖。 */
export const NPC_PANEL_TURNIN_HINT = `按 ${NPC_PANEL_ACCEPT_KEY} 交任务并领奖`;
/** `accepted` 但物品不够:说清「按了也不会交」,免得玩家以为按键坏了。 */
export const NPC_PANEL_NOT_READY_HINT = `按 ${NPC_PANEL_ACCEPT_KEY} 交任务(物品还不够,先去凑齐)`;
/** `completed` 时的提示(已封账,奖励发过了)。 */
export const NPC_PANEL_COMPLETED_HINT = `按 ${NPC_PANEL_TALK_KEY} 再跟他聊一句`;
/** 未知 `status` 时的那行正文。 */
export const NPC_PANEL_UNKNOWN_STATUS_TEXT = '(这个任务的状态看不懂,先按没接处理。)';
/** 未知 `status` 时的提示。 */
export const NPC_PANEL_UNKNOWN_STATUS_HINT =
  `状态看不懂,按 ${NPC_PANEL_TALK_KEY} 再问一次他`;

/** 查不到名字时的兜底名(**确定性地只依赖 id**,不抛)。 */
export function fallbackItemName(id: number): string {
  return `物品 #${id}`;
}

/** NPC 名:空 / 非串 ⇒ 一个不冒充任何人的兜底称呼。 */
function nameOf(raw: unknown): string {
  const n = (raw as { name?: unknown } | null | undefined)?.name;
  return typeof n === 'string' && n.trim() !== '' ? n.trim() : '这位陌生人';
}

/**
 * 物品 id 收窄:非数 / NaN / ±Infinity ⇒ `0`(调用方查名时会被兜底成 `物品 #0`)。
 *
 * ⚠️ 刻意**不抛**:面板是每帧都可能重画的东西,一个坏 id 不该让整块 UI 消失。
 */
function itemIdOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

/**
 * 数量读数收窄:非数 / NaN / ±Infinity / 负数 ⇒ `0`;小数 ⇒ 截断。
 *
 * ⚠️ 只有「下界」被夹:上界**不**夹到 `needCount` —— `have = 9 / need = 5`
 * 必须照实写出 `9/5`(夹到 5 就是谎报背包里有几件,判据 FND192-7)。
 */
function countOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.trunc(raw);
}

/** 这个读数是「干净的」吗(整数且 ≥ 0)—— 不干净就在正文里注明。 */
function isCleanCount(raw: unknown): boolean {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && Number.isInteger(raw);
}

/** 任务收窄:非对象 / null ⇒ `null`(走「他今天没什么要你做的」那条)。 */
function questOf(raw: unknown): NpcPanelQuest | null {
  if (raw === null || typeof raw !== 'object') return null;
  const q = raw as Partial<NpcPanelQuest>;
  const title = typeof q.title === 'string' && q.title.trim() !== '' ? q.title.trim() : '未命名任务';
  return {
    id: typeof q.id === 'string' ? q.id : '',
    title,
    needItemId: itemIdOf(q.needItemId),
    needCount: countOf(q.needCount),
    rewardItemId: itemIdOf(q.rewardItemId),
    rewardCount: countOf(q.rewardCount),
  };
}

/** `status` 收窄:三值之一,其余 ⇒ `'unknown'`(走兜底分支,不猜)。 */
function statusOf(raw: unknown): 'available' | 'accepted' | 'completed' | 'unknown' {
  return raw === 'available' || raw === 'accepted' || raw === 'completed' ? raw : 'unknown';
}

/**
 * 把调用方给的查名回调裹成「**保证返回非空字符串**且不抛」的那一个。
 *
 * 三种坏法都退到 `物品 #id`:不是函数、抛异常、返回空串/非串。
 */
function nameResolver(fn: unknown): (id: number) => string {
  return (id: number): string => {
    if (typeof fn === 'function') {
      try {
        const out = (fn as (i: number) => unknown)(id);
        if (typeof out === 'string' && out.trim() !== '') return out;
      } catch {
        /* 内容表查不到 / 回调自己坏了 ⇒ 落到 id 兜底(见文件头「兜底」)。 */
      }
    }
    return fallbackItemName(id);
  };
}

/**
 * 快照 → 面板三段。
 *
 * 语义(四种情形,**正文两两不同**、都非空 —— 判据 FND192-1):
 * ```text
 * 无任务              ⇒ 标题 = NPC 名;正文 = 「他今天没什么要你做的。」
 * available           ⇒ 需要 ×N + 奖励 ×M;提示「按 Y 接下这个任务」
 * accepted            ⇒ 进度 have/need + 还差几件(够了就写「够了」);提示按 Y 交
 * completed           ⇒ 「已完成」+「奖励已发(不会重复发)」;提示按 T 再说一句
 * status 不认识       ⇒ 点明看不懂 + 照列出需求/奖励(不猜他属于哪一种)
 * ```
 * 纯函数:不取时间、不掷骰、不读全局 ⇒ 同输入同输出(`JSON.stringify` 逐字相等)。
 */
export function planNpcPanel(input: NpcPanelInput): NpcPanelView {
  const raw = (input ?? {}) as Partial<NpcPanelInput>;
  const name = nameOf(raw.npc);
  const quest = questOf(raw.quest);
  if (quest === null) {
    return { title: name, rows: [NPC_PANEL_IDLE_TEXT], hint: NPC_PANEL_IDLE_HINT };
  }

  const who = `${name} · ${quest.title}`;
  const itemName = nameResolver(raw.itemName);
  const need = itemName(quest.needItemId);
  const reward = itemName(quest.rewardItemId);
  const status = statusOf(raw.status);

  if (status === 'unknown') {
    return {
      title: who,
      rows: [
        NPC_PANEL_UNKNOWN_STATUS_TEXT,
        `需要:${need} ×${quest.needCount}`,
        `奖励:${reward} ×${quest.rewardCount}`,
      ],
      hint: NPC_PANEL_UNKNOWN_STATUS_HINT,
    };
  }

  if (status === 'available') {
    return {
      title: who,
      rows: [`需要:${need} ×${quest.needCount}`, `奖励:${reward} ×${quest.rewardCount}`],
      hint: NPC_PANEL_ACCEPT_HINT,
    };
  }

  if (status === 'accepted') {
    const haveRaw: unknown = raw.have;
    const have = countOf(haveRaw);
    const rows: string[] = [`进度:${have}/${quest.needCount} ${need}`];
    const missing = quest.needCount > have ? quest.needCount - have : 0;
    rows.push(
      missing > 0
        ? `还差 ${missing} 件 ${need}`
        : `够了:交给他就能拿到 ${reward} ×${quest.rewardCount}`,
    );
    /* 读数不干净 ⇒ 正文里说清「这个数字是怎么来的」,不用一个假数字冒充背包。 */
    if (!isCleanCount(haveRaw)) {
      rows.push(
        typeof haveRaw === 'number' && Number.isFinite(haveRaw) && haveRaw > 0
          ? `(背包读数不是整数,按 ${have} 件算。)`
          : '(背包读数异常,按 0 件算。)',
      );
    }
    /* `needCount` 没写清 ⇒ 不许写 `还差 -3 件`,明说这件任务没写清。 */
    if (quest.needCount <= 0) rows.push('(这件任务没写清要多少件。)');
    return {
      title: who,
      rows,
      hint: missing > 0 ? NPC_PANEL_NOT_READY_HINT : NPC_PANEL_TURNIN_HINT,
    };
  }

  /* status === 'completed':已封账(奖励发过了),不再提示按 Y。 */
  return {
    title: who,
    rows: [
      `已完成:${quest.title}`,
      `奖励已发:${reward} ×${quest.rewardCount}(不会重复发)`,
    ],
    hint: NPC_PANEL_COMPLETED_HINT,
  };
}
