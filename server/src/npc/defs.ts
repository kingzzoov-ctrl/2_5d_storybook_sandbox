/**
 * NPC 静态定义 + **空间查询**(车道 C / WS-FND-186)。
 *
 * ## 为什么需要这一层
 * 修前本仓**没有任何"能说话的人"**:任务板(516)、售货摊(515)、篝火(501)只是
 * `obj` 图层里的物件 —— 玩家能敲碎它们,但它们不会回答任何问题。
 * 于是"主线/支线"这条玩法循环在世界上**没有承载体**:没有实体就没有可交互对象,
 * 没有可交互对象就没有"找谁接任务"这件事。
 *
 * ## 本文件只做两件事
 * ```text
 * 1 静态定义(`NPCS`):id / name / home(设计图坐标) / lines / quest?
 * 2 空间查询:npcAt(x, y, radius) 与 npcsIn(bounds)
 * ```
 * **不做**对话与任务状态机 —— 那在 `./dialogue.ts`(纯函数,可穷举断言)。
 * 也不碰网络层:snapshot 字段与动作路由由主代理统一接(见任务分工)。
 *
 * ## 坐标口径
 * `home` 是**设计图坐标**(`shared/world/design.ts` 的 192×192 格空间),
 * 与 `WorldSim` 的格坐标同一套原点 —— 所以每个点的 `regionAt()` 非空、
 * `biomeAt()` 非空(判据 `WS-FND-186` 逐个钉住)。写错坐标的症状是
 * "NPC 站在海里/悬崖外",而那种缺陷不报错(它只是一个坐标)。
 *
 * ## 物品 id 为什么是 `number`
 * 冻结表 `shared/constants/items.ts` 的 `ItemDef.id` 就是数字(101~754),
 * 全仓引用物品一律走 `ITEM_BY_ID`。这里不发明字符串 id。
 */

import { ITEM_BY_ID } from '../../../shared/constants/items.ts';

/** 一个 NPC 的任务(缺省 = 这个 NPC 只说话)。 */
export interface NpcQuest {
  /** 稳定 id(任务账本的键;**全仓唯一**)。 */
  id: string;
  /** 中文名(UI 直接显示)。 */
  title: string;
  /** 需要交付的物品 id(`ITEM_BY_ID` 的键)。 */
  needItemId: number;
  needCount: number;
  /** 交付后发放的物品 id 与数量(**只发一次**,见 `dialogue.ts`)。 */
  rewardItemId: number;
  rewardCount: number;
}

/** 一个 NPC 的静态定义。 */
export interface NpcDef {
  /** 稳定 id(kebab/下划线均可,但**全仓唯一**;对话与动作路由都用它)。 */
  id: string;
  name: string;
  /** 家(设计图坐标)。**必须是设计图的陆地上的一格**。 */
  home: { x: number; y: number };
  /**
   * 台词。**至少 3 条**且互不相同:
   * `talk()` 按任务状态在里面**确定性**地选一条(见 `dialogue.ts`),
   * 所以单一台词会让"领了任务"与"没领"在屏幕上长得一样。
   */
  lines: readonly string[];
  quest?: NpcQuest;
}

/**
 * 四个 NPC(镇长的位置是出生点,其余三个各守一个资源区)。
 *
 * ⚠️ 增删 NPC 时务必同步判据 `tests/WS-FND-186-npc-dialogue.test.ts`:
 * 那里对"每块地至少一个 NPC""id 唯一""坐标在设计图的陆地上"都是逐项断言。
 */
export const NPCS: readonly NpcDef[] = [
  {
    id: 'npc_mayor',
    name: '镇长·阿岭',
    home: { x: 96, y: 96 }, /* 中央营地(出生点:红砖广场) */
    lines: [
      '欢迎来到这座岛。先四处走走 —— 别急着下矿,矿丘的洞里现在不太平。',
      '我这儿没有差事给你:去问问田里的老农、矿口的老铁,还有遗迹那边守夜的人。',
      '岛上就这么些人。你要是帮得动他们,他们会记住你。',
    ],
    /* 刻意**没有**任务:负对照 —— 判据要证明"没任务的 NPC 也会说话、talk 不返回 offer"。 */
  },
  {
    id: 'npc_farmer',
    name: '农夫·禾子',
    home: { x: 93, y: 134 }, /* 农田区(farm) */
    lines: [
      '今年的黄金小麦长得比人还高,可我一个人割不过来。',
      '帮我收八捆黄金小麦,我把新摘的露水甜莓分你一半。',
      '谢了。粮仓满的时候,我就在这儿晒太阳。',
    ],
    quest: {
      id: 'quest_first_harvest',
      title: '一畦新苗',
      needItemId: 123, /* 黄金小麦 */
      needCount: 8,
      rewardItemId: 121, /* 露水甜莓 */
      rewardCount: 3,
    },
  },
  {
    id: 'npc_miner',
    name: '矿工·铁生',
    home: { x: 64, y: 122 }, /* 矿丘(mine) */
    lines: [
      '别看我这一身灰 —— 矿丘这一片,我说了算。',
      '给我搬十块云母圆石来砌矿道口,寒铁矿分你三块,童叟无欺。',
      '成色不错。这条矿道以后有你一份。',
    ],
    quest: {
      id: 'quest_mine_entrance',
      title: '矿道口的石头',
      needItemId: 106, /* 云母圆石 */
      needCount: 10,
      rewardItemId: 113, /* 寒铁矿石 */
      rewardCount: 3,
    },
  },
  {
    id: 'npc_ruins_guard',
    name: '遗迹守卫·灰',
    home: { x: 128, y: 124 }, /* 遗迹区(ruins) */
    lines: [
      '这里以前是一座城。现在只剩棋盘和祭坛。',
      '带两块萤光魔晶簇来,我把压箱底的极光星辰碎片给你 —— 那东西夜里会亮。',
      '拿去吧。别让祭坛再亮起来。',
    ],
    quest: {
      id: 'quest_ruins_watch',
      title: '守夜人的碎晶',
      needItemId: 116, /* 萤光魔晶簇 */
      needCount: 2,
      rewardItemId: 117, /* 极光星辰碎片 */
      rewardCount: 1,
    },
  },
];

/** `npcAt()` 的默认交互半径(格)。2.5 ≈ 「站在它旁边」。 */
export const NPC_TALK_RADIUS = 2.5;

/** 按 id 查 NPC(未知 id ⇒ `null`,不抛)。 */
export function npcById(id: string): NpcDef | null {
  for (const n of NPCS) if (n.id === id) return n;
  return null;
}

/**
 * 离 `(x, y)` 最近的 NPC(**半径内**;区外 / 未知坐标 ⇒ `null`)。
 *
 * 平局(两个 NPC 一样近)按 `NPCS` 的声明顺序取前者 —— 确定性,不靠 Map 迭代序。
 * `radius` 含边界(`<=`),与 `spawner.ts#isInsideSafeRadius` 同一口径。
 */
export function npcAt(x: number, y: number, radius: number = NPC_TALK_RADIUS): NpcDef | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) return null;
  let best: NpcDef | null = null;
  let bestD = Infinity;
  for (const n of NPCS) {
    const d = Math.hypot(x - n.home.x, y - n.home.y);
    if (d <= radius && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** 落在矩形(含边界)里的 NPC —— 宿主投影快照时的只读入口。 */
export function npcsIn(bounds: { x0: number; y0: number; x1: number; y1: number }): NpcDef[] {
  const { x0, y0, x1, y1 } = bounds;
  return NPCS.filter((n) => n.home.x >= x0 && n.home.x <= x1 && n.home.y >= y0 && n.home.y <= y1);
}

/**
 * 所有任务(按 NPC 声明顺序)。
 *
 * 为什么是派生而不是第二份列表:任务 id 的**唯一事实源**必须是 `NPCS[].quest`
 * —— 两份列表迟早漂移,而漂移的症状是"某个任务在账本里永远查不到"。
 */
export function allQuests(): readonly NpcQuest[] {
  const out: NpcQuest[] = [];
  for (const n of NPCS) if (n.quest !== undefined) out.push(n.quest);
  return out;
}

/** 按任务 id 查 `{ npc, quest }`(未知 id ⇒ `null`)。 */
export function questById(questId: string): { npc: NpcDef; quest: NpcQuest } | null {
  for (const n of NPCS) {
    if (n.quest !== undefined && n.quest.id === questId) return { npc: n, quest: n.quest };
  }
  return null;
}

/** 定义自检:物品 id 必须真的在冻结表里(拼错一个数字 = 任务永远交不了)。 */
export function missingItemIds(): number[] {
  const out: number[] = [];
  for (const q of allQuests()) {
    for (const id of [q.needItemId, q.rewardItemId]) {
      if (!ITEM_BY_ID.has(id)) out.push(id);
    }
  }
  return out;
}
