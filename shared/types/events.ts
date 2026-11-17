/**
 * 事件名命名空间(冻结层)。
 *
 * ## 授权
 *
 * owner 2026-11-17 授权「冻结层解锁」;对应 `docs/RULINGS-DRAFT.md` 4.7
 * EVENT-BUS U6「立**事件名命名空间**(一次改完 29 种)」。登记见
 * `shared/contracts/FREEZE.md` 的 D-19 条。
 *
 * ## 它解决什么
 *
 * 全仓 29 种事件名原先**只以字符串字面量存在**(`server/src/mobs/behaviors.ts`
 * 里 30 处 `world.emit('xxx', ...)`,`lava_solidified` 出现两次)。后果是:
 * 拼错一个字母不会报错、订阅方写 `mimic_*` 也永远匹配不到 `mimic_aambush`、
 * 加第 30 种事件时没有任何地方会红。
 *
 * 本文件把这 29 种立成**命名空间**:一个 `as const` 表(单一事实源)+ 一列
 * 供遍历/门禁使用的数组 + 作用域前缀。
 *
 * ## 作用域前缀与「线上的名字」
 *
 * `EventNamespace` 是**代码层作用域**(mob / build / cook / alchemy / combat /
 * room / net),`eventName()` 拼出前缀化名字,如 `mob_boar_wall_stun`。
 * 前缀化的形态**与 `EventBus` 的前缀通配语法一致**(`shared/../server/src/events/bus.ts`:
 * 尾随 `*` 即前缀匹配,所以 `mob_*` 一次订走全部生物事件)。
 *
 * ⚠️ **登记过的边界**:线上实际投递的仍是**扁平名字**(`boar_wall_stun`),
 * 因为发送侧 `server/src/mobs/behaviors.ts` 不在本批改动范围内(那会让 29 处
 * emit 与全部订阅方同时改)。本文件是**唯一事实源**,迁移一旦做就是替换字面量,
 * 不需要再改这里。判据(`tests/WS-FND-66-frozen-unlock.test.ts`)会反向扫
 * `behaviors.ts`,**表与发送侧不一致即红** —— 所以它不是一份写完就过期的文档。
 */

/** 事件名的代码层作用域。 */
export const EventNamespace = {
  /** 生物行为(`server/src/mobs/behaviors.ts`) */
  MOB: 'mob',
  /** 建造 / 蓝图(WS-03) */
  BUILD: 'build',
  /** 料理(WS-10-E) */
  COOK: 'cook',
  /** 炼金(WS-06) */
  ALCHEMY: 'alchemy',
  /** 战斗(WS-10) */
  COMBAT: 'combat',
  /** 房间评分 / 氛围(WS-03) */
  ROOM: 'room',
  /** 网络(WS-07) */
  NET: 'net',
} as const;
export type EventNamespace = (typeof EventNamespace)[keyof typeof EventNamespace];

/** 全部作用域(顺序即参数表顺序)。 */
export const EVENT_NAMESPACES: readonly EventNamespace[] = [
  'mob', 'build', 'cook', 'alchemy', 'combat', 'room', 'net',
];

/** 生物事件数(裁决口径:29 种)。 */
export const MOB_EVENT_COUNT = 29;

/**
 * 29 种生物事件名(**单一事实源**)。
 *
 * 名字本身是**线上契约**,不改大小写、不改拼写;分组只做注释。
 */
export const EventKind = {
  /* 野猪 */
  BOAR_WALL_STUN: 'boar_wall_stun',
  BOAR_CHARGE_END: 'boar_charge_end',
  BOAR_SLIP_STUN: 'boar_slip_stun',
  /* 河狸 */
  BEAVER_DAM_BUILT: 'beaver_dam_built',
  BEAVER_HAMMERED: 'beaver_hammered',
  /* 河蟹 / 卡皮巴拉 */
  CRAB_SOUP: 'crab_soup',
  CAPYBARA_HEART_REFLECT: 'capybara_heart_reflect',
  /* 小狸猫 */
  TANUKI_AMBUSH: 'tanuki_ambush',
  /* 竹林剑客傀儡 */
  SAMURAI_BURNING: 'samurai_burning',
  SAMURAI_IGNITED: 'samurai_ignited',
  /* 音波蝠 / 紫晶重甲虫 */
  BAT_SONAR_JAMMED: 'bat_sonar_jammed',
  BEETLE_FLIPPED: 'beetle_flipped',
  /* 陆行鸟 */
  CHOCOBO_FEED_FAILED: 'chocobo_feed_failed',
  CHOCOBO_TAMED: 'chocobo_tamed',
  /* 穿山甲 */
  PANGOLIN_WALL_STUN: 'pangolin_wall_stun',
  PANGOLIN_BATTED: 'pangolin_batted',
  /* 毒尾蝎 */
  SCORPION_AMBUSH: 'scorpion_ambush',
  SCORPION_FORCED_SURFACE: 'scorpion_forced_surface',
  /* 姜饼小人 */
  GINGER_ESCAPED: 'ginger_escaped',
  GINGER_HOOKED: 'ginger_hooked',
  /* 巧克力盾卫 */
  CHOCO_MELTED: 'choco_melted',
  /* 云魔鬼鱼 */
  MANTA_RIDE: 'manta_ride',
  /* 竖琴风精鸟 */
  HARPY_GUST: 'harpy_gust',
  HARPY_ENSEMBLE_GIFT: 'harpy_ensemble_gift',
  /* 雷云闪电球 */
  THUNDER_DISCHARGE: 'thunder_discharge',
  /* 发条伪装宝箱 */
  MIMIC_AMBUSH: 'mimic_ambush',
  MIMIC_EXPLODED: 'mimic_exploded',
  /* 熔炉赤焰火灵 */
  LAVA_SOLIDIFIED: 'lava_solidified',
  /* 远古发条重骑 */
  KNIGHT_KEY_PULLED: 'knight_key_pulled',
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/**
 * 29 种的**有序**清单(供遍历 / 门禁 / 订阅批量注册)。
 *
 * 与 `EventKind` 是两份数据:`EVENT_KINDS` 手写清单、`EventKind` 是有名字面量,
 * 判据逐项比对两者(长度、去重、集合相等),任一处漂移即红。
 */
export const EVENT_KINDS: readonly EventKind[] = [
  'boar_wall_stun', 'boar_charge_end', 'boar_slip_stun',
  'beaver_dam_built', 'beaver_hammered',
  'crab_soup', 'capybara_heart_reflect',
  'tanuki_ambush',
  'samurai_burning', 'samurai_ignited',
  'bat_sonar_jammed', 'beetle_flipped',
  'chocobo_feed_failed', 'chocobo_tamed',
  'pangolin_wall_stun', 'pangolin_batted',
  'scorpion_ambush', 'scorpion_forced_surface',
  'ginger_escaped', 'ginger_hooked',
  'choco_melted',
  'manta_ride',
  'harpy_gust', 'harpy_ensemble_gift',
  'thunder_discharge',
  'mimic_ambush', 'mimic_exploded',
  'lava_solidified',
  'knight_key_pulled',
];

/** 拼前缀化的线上名字:`eventName('mob', 'crab_soup') === 'mob_crab_soup'`。 */
export function eventName(ns: EventNamespace, kind: string): string {
  return `${ns}_${kind}`;
}

/** 前缀通配模式(供 `EventBus.on()` 一次订走某作用域):`mob_*`。 */
export function eventPattern(ns: EventNamespace): string {
  return `${ns}_*`;
}

/** 已登记事件 → 所属作用域;未登记返回 `null`(不抛错:门禁要能报"未登记")。 */
export function namespaceOf(kind: string): EventNamespace | null {
  for (const k of EVENT_KINDS) if (k === kind) return EventNamespace.MOB;
  return null;
}

/** 是否已登记(29 种之内)。 */
export function isKnownEventKind(kind: string): boolean {
  return namespaceOf(kind) !== null;
}

/** 扁平名字是否已是命名空间形态(`mob_xxx` 且前缀在登记表里)。 */
export function isNamespacedEventName(full: string): boolean {
  for (const ns of EVENT_NAMESPACES) {
    if (full.startsWith(`${ns}_`)) return true;
  }
  return false;
}