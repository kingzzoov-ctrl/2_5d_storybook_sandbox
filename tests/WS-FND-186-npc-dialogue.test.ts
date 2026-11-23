/**
 * WS-FND-186 —— **NPC 实体 + 对话/任务**(车道 C,2026-11-26)。
 *
 * ## 修前是什么样
 * 本仓**没有任何"能说话的人"**:任务板(516)/售货摊(515)/篝火(501)只是 `obj` 图层
 * 里的物件。`grep -rn "npc" server/src` 的结果是 0 —— 所以"找谁接任务"这件事
 * 在世界上根本没有承载体。
 *
 * ## 本套件钉的是什么
 *
 * | # | 断言 | 注入验证(改坏哪一处会红) |
 * | :--- | :--- | :--- |
 * | 1 | ≥4 个 NPC,id/任务 id 唯一 | 复制一个 NPC 不改 id |
 * | 2 | 每个 NPC 有 ≥3 条**互不相同**的台词;`talk` 只会说出自己的台词 | `lines` 写成 `[]` |
 * | 3 | `home` 落在设计图的陆地上(`regionAt`/`biomeAt` 非空) | 坐标改成 (5,5)(海里) |
 * | 4 | `talk` 纯函数:同输入同输出;三种状态说三句不同的话 | `talk` 里加 `Date.now()` |
 * | 5 | 未知 npcId **不抛**,给兜底台词、无 offer | `npcById(id)!` 去掉 null 分支 |
 * | 6 | `npcAt` 取最近/半径语义;`npcsIn` 含边界 | `d < bestD` 改成 `<=`(平局换人) |
 * | 7 | 领任务:`available → accepted`,`awarded = null` | 领任务时顺手发奖 |
 * | 8 | ★ 物品不够 ⇒ `NOT_ENOUGH_ITEMS` 且**不发奖** | 去掉 `have < needCount` 判断 |
 * | 9 | ★ 物品够 ⇒ `completed` 且奖励**只发一次**(之后连领 5 次全 null) | 删掉 `status === 'completed'` 短路 |
 * | 10 | `acceptQuest` 不改入参(纯函数);无任务/未知 NPC 不抛 | 原地写 `state.quests[...]` |
 * | 11 | `progressOf` 三态 + `have/ready/done`;物品 id 都在冻结表里 | `ready` 不看 `status` |
 *
 * ## 为什么"奖励只发一次"要单独占一条
 * 这是本次唯一会**真的给玩家资产**的函数。重复发奖的症状是"刷任务" ——
 * 玩家不报错、日志不报错,只有经济曲线慢慢歪掉。所以第 8/9 条连"用**旧**状态
 * 回放"这件事也一起钉住:纯函数能保证的是"给定状态,奖励至多一次"。
 *
 * 运行:`node tests/WS-FND-186-npc-dialogue.test.ts`
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { regionAt, biomeAt, DESIGN_SIZE } from '../shared/world/design.ts';
import { NPCS, allQuests, npcAt, npcById, npcsIn, missingItemIds, NPC_TALK_RADIUS } from '../server/src/npc/defs.ts';
import {
  UNKNOWN_NPC_LINE, acceptQuest, emptyNpcState, itemCountOf, progressOf, questStatusOf, talk,
  type NpcPlayerState, type QuestStatus,
} from '../server/src/npc/dialogue.ts';

/** 造一份只读状态(测试里显式写清背包与账本,不依赖任何默认值)。 */
function st(
  inventory: Record<number, number> = {},
  quests: Record<string, QuestStatus> = {},
): NpcPlayerState {
  return { inventory, quests };
}

/** 有任务的 NPC(农夫/矿工/守卫),按声明顺序。 */
const QUEST_NPCS = NPCS.filter((n) => n.quest !== undefined);
/** 无任务的 NPC(镇长)—— 负对照。 */
const PLAIN_NPCS = NPCS.filter((n) => n.quest === undefined);

/* ───────────────────────── 1 ───────────────────────── */

test('FND186-1 至少 4 个 NPC;id 与任务 id 都唯一', () => {
  ok(NPCS.length >= 4, `至少要有 4 个 NPC,实测 ${NPCS.length} 个`);
  const ids = NPCS.map((n) => n.id);
  eq(new Set(ids).size, ids.length, `NPC id 必须唯一,实测 [${ids.join('/')}]`);
  for (const n of NPCS) {
    ok(n.id.length > 0 && n.name.length > 0, `NPC id/name 不能为空(${JSON.stringify(n)})`);
    ok(typeof n.home.x === 'number' && typeof n.home.y === 'number', `${n.id} 的 home 必须是两个数`);
  }
  const questIds = allQuests().map((q) => q.id);
  eq(new Set(questIds).size, questIds.length, `任务 id 必须唯一,实测 [${questIds.join('/')}]`);
  ok(QUEST_NPCS.length >= 3, `至少 3 个 NPC 有任务(实测 ${QUEST_NPCS.length})`);
  ok(PLAIN_NPCS.length >= 1, '至少保留一个**无任务**的 NPC 作为负对照(镇长)');
  /* 每个 NPC 都要在世界上找得到:按自己的家坐标查询必须返回自己。 */
  for (const n of NPCS) {
    eq(npcAt(n.home.x, n.home.y)?.id, n.id, `在 ${n.name} 的家 (${n.home.x},${n.home.y}) 应查到自己`);
    eq(npcById(n.id)?.name, n.name, `npcById(${n.id}) 应返回同一个 NPC`);
  }
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND186-2 每个 NPC 有 ≥3 条互不相同的台词;talk 只会说出自己的台词', () => {
  for (const n of NPCS) {
    ok(n.lines.length >= 3, `${n.id} 的台词应 ≥3 条(否则"领了任务"与"没领"在屏幕上一样),实测 ${n.lines.length}`);
    eq(new Set(n.lines).size, n.lines.length, `${n.id} 的台词有重复(重复 = 少一句)`);
    for (const line of n.lines) ok(line.trim().length > 0, `${n.id} 有空台词`);
  }
  /* 三种状态各说一句,而且三句**来自这个 NPC 自己的台词表**。 */
  for (const n of QUEST_NPCS) {
    const qid = n.quest!.id;
    const states = [
      st(),
      st({}, { [qid]: 'accepted' }),
      st({}, { [qid]: 'completed' }),
    ];
    const said = states.map((s) => talk(n.id, s).line);
    for (const line of said) ok(n.lines.includes(line), `${n.id} 说了不属于自己的话:"${line}"`);
    eq(new Set(said).size, 3, `${n.id} 在 available/accepted/completed 三态下应说三句不同的话,实测 ${JSON.stringify(said)}`);
  }
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND186-3 每个 NPC 的家都在设计图的**陆地**上(regionAt / biomeAt 非空)', () => {
  for (const n of NPCS) {
    const { x, y } = n.home;
    ok(Number.isInteger(x) && Number.isInteger(y), `${n.id} 的 home 应是整数格坐标,实测 (${x},${y})`);
    ok(x >= 0 && x < DESIGN_SIZE && y >= 0 && y < DESIGN_SIZE,
      `${n.id} 的 home (${x},${y}) 超出设计图 ${DESIGN_SIZE}×${DESIGN_SIZE}`);
    const region = regionAt(x, y);
    ok(region !== null, `${n.id} 站在设计图的区外(( ${x},${y}) 不属于任何区 = 海上)`);
    const biome = biomeAt(x, y);
    ok(biome !== null, `${n.id} 的格子 "${region}" 没有群系(REGION_BIOME 缺键)`);
  }
  /* 四个 NPC 应分散在不同的区(都挤在营地里等于只有一个人)。 */
  const regions = new Set(NPCS.map((n) => regionAt(n.home.x, n.home.y)));
  ok(regions.size >= 3, `NPC 应分布在不同区域(实测 ${regions.size} 个区:[${[...regions].join('/')}])`);
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND186-4 talk 是纯函数:同输入同输出(逐字段相等,不受调用次数影响)', () => {
  const states: NpcPlayerState[] = [
    st(),
    st({ 123: 8 }),
    st({ 123: 8 }, { quest_first_harvest: 'accepted' }),
    st({ 123: 99 }, { quest_first_harvest: 'completed' }),
    st({ 106: 10, 116: 2 }),
  ];
  for (const n of NPCS) {
    for (const s of states) {
      const a = talk(n.id, s);
      const b = talk(n.id, s);
      eq(a, b, `${n.id} 的 talk 两次输出必须完全相等(实测 ${JSON.stringify(a)} / ${JSON.stringify(b)})`);
      ok(a.line.trim().length > 0, `${n.id} 的台词不能为空`);
      /* offer 必须与 NPC 定义逐字段对齐(不是另算一份)。 */
      if (n.quest === undefined) {
        eq(a.offer, undefined, `${n.id} 没有任务,talk 不该返回 offer`);
      } else {
        ok(a.offer !== undefined, `${n.id} 有任务,talk 必须返回 offer`);
        eq(a.offer!.questId, n.quest.id, `${n.id} 的 offer 指向了别的任务`);
        eq(a.offer!.needItemId, n.quest.needItemId, `${n.id} 的 offer 需求物品与定义不一致`);
        eq(a.offer!.rewardCount, n.quest.rewardCount, `${n.id} 的 offer 奖励数量与定义不一致`);
      }
    }
  }
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND186-5 未知 npcId 不抛,给兜底台词且没有 offer', () => {
  const bogus = ['', 'npc_nobody', 'NPC_MAYOR', 'npc_mayor '];
  for (const id of bogus) {
    let out: { line: string; offer?: unknown } | null = null;
    try {
      out = talk(id, st());
    } catch (err) {
      ok(false, `talk("${id}") 不该抛错,实测 ${err instanceof Error ? err.message : String(err)}`);
    }
    ok(out !== null, `talk("${id}") 应有返回值`);
    eq(out!.line, UNKNOWN_NPC_LINE, `talk("${id}") 应回兜底台词`);
    eq(out!.offer, undefined, `talk("${id}") 不该凭空给一个 offer`);
  }
  /* acceptQuest 对未知 id 同样不抛,且**状态不被改动**。 */
  const before = st({ 123: 8 });
  const r = acceptQuest('npc_nobody', before);
  eq(r.outcome, 'UNKNOWN_NPC', '未知 NPC 的 acceptQuest 应如实回 UNKNOWN_NPC');
  eq(r.awarded, null, '未知 NPC 不该发奖');
  ok(r.state === before, '无事发生时应返回**同一个**状态对象(调用方据此决定要不要落库)');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND186-6 npcAt 取最近且半径含边界;npcsIn 含边界;非法坐标不抛', () => {
  const n = NPCS[0]!;
  const { x, y } = n.home;
  eq(npcAt(x, y, NPC_TALK_RADIUS)?.id, n.id, '站在家坐标上应命中自己');
  eq(npcAt(x + NPC_TALK_RADIUS, y, NPC_TALK_RADIUS)?.id, n.id, '半径边界上(<=)应命中');
  eq(npcAt(x + NPC_TALK_RADIUS + 0.01, y, NPC_TALK_RADIUS), null, '半径外一格应查不到');
  /* 距离语义:两个已知 NPC 之间取更近的那个。 */
  const a = NPCS[0]!;
  const b = NPCS[1]!;
  const mid = { x: (a.home.x + b.home.x) / 2, y: (a.home.y + b.home.y) / 2 };
  const near = mid.x < b.home.x ? a : b;
  const hit = npcAt(near.home.x + 0.5, near.home.y + 0.5, 2);
  eq(hit?.id, near.id, `应取最近的 NPC(${near.id}),实测 ${hit?.id ?? 'null'}`);
  /* 非法坐标:不抛,返回 null。 */
  eq(npcAt(Number.NaN, 0), null, 'NaN 坐标应返回 null');
  /* 半径极大时命中离原点最近的那个(镇长 96,96);`Infinity` 按非法参数拒绝 ——
     无穷半径的语义是"随便给我一个",不是查询(与 NaN 同一条守卫)。 */
  eq(npcAt(0, 0, 1e6)?.id, NPCS[0]!.id, '半径极大时应命中离原点最近的那个(镇长 96,96)');
  eq(npcAt(0, 0, Number.POSITIVE_INFINITY), null, 'Infinity 半径应按非法参数返回 null');

  /* npcsIn:整图 ⇒ 全部;空矩形 ⇒ 空;边界含端点。 */
  eq(npcsIn({ x0: 0, y0: 0, x1: DESIGN_SIZE - 1, y1: DESIGN_SIZE - 1 }).length, NPCS.length, '全图矩形应包含所有 NPC');
  eq(npcsIn({ x0: 0, y0: 0, x1: 1, y1: 1 }).length, 0, '空矩形不该包含任何 NPC');
  const one = npcsIn({ x0: x, y0: y, x1: x, y1: y });
  eq(one.length, 1, '恰好圈住一个 NPC 的矩形应只含 1 个');
  eq(one[0]!.id, n.id, '圈住的那个应是它自己');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND186-7 领任务:available → accepted,领的时候**不发奖**', () => {
  for (const n of QUEST_NPCS) {
    const qid = n.quest!.id;
    const s0 = st();
    eq(questStatusOf(s0, qid), 'available', `初始状态应是 available(${qid})`);
    const r = acceptQuest(n.id, s0);
    eq(r.outcome, 'ACCEPTED', `第一次领任务应是 ACCEPTED,实测 ${r.outcome}`);
    eq(r.awarded, null, '领任务时不应发奖(奖在交付时)');
    eq(questStatusOf(r.state, qid), 'accepted', '领完之后状态应是 accepted');
    /* 背包物品不够 ⇒ 再领一次只回 NOT_ENOUGH_ITEMS,仍然不发奖。 */
    const r2 = acceptQuest(n.id, r.state);
    eq(r2.outcome, 'NOT_ENOUGH_ITEMS', `物品不够时应回 NOT_ENOUGH_ITEMS(实测 ${r2.outcome})`);
    eq(r2.awarded, null, '★ 物品不够时**绝不能**发奖');
    eq(questStatusOf(r2.state, qid), 'accepted', '物品不够时状态应停在 accepted');
    /* talk 的 offer 也要反映这件事。 */
    const off = talk(n.id, r2.state).offer!;
    eq(off.status, 'accepted', 'offer.status 应与会话状态一致');
    eq(off.canAccept, false, '已接过的任务不该还能再"接"');
    eq(off.canTurnIn, false, '物品不够时不该显示"可交"');
  }
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND186-8 物品够 ⇒ completed,奖励只发一次(之后连领 5 次全 null)', () => {
  for (const n of QUEST_NPCS) {
    const q = n.quest!;
    const qid = q.id;
    const s0 = st({ [q.needItemId]: q.needCount });
    const r1 = acceptQuest(n.id, s0); /* 接 */
    eq(r1.outcome, 'ACCEPTED', '先接任务');
    const r2 = acceptQuest(n.id, r1.state); /* 交 */
    eq(r2.outcome, 'COMPLETED', `物品够时应 COMPLETED,实测 ${r2.outcome}`);
    ok(r2.awarded !== null, '★ 交付时应真的发一次奖励');
    eq(r2.awarded!.itemId, q.rewardItemId, '奖励物品应与定义一致');
    eq(r2.awarded!.count, q.rewardCount, '奖励数量应与定义一致');
    eq(questStatusOf(r2.state, qid), 'completed', '交付后状态应是 completed');

    /* ★ 之后**无论领多少次**都不许再发奖。 */
    let s = r2.state;
    let sent = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = acceptQuest(n.id, s);
      eq(r.outcome, 'ALREADY_COMPLETED', `完成后再领第 ${i + 1} 次应回 ALREADY_COMPLETED(实测 ${r.outcome})`);
      if (r.awarded !== null) sent += 1;
      s = r.state;
    }
    eq(sent, 0, '★ 完成后重复领任务**一次奖都不许再发**(否则可以刷任务)');
    /* 时间顺序反一遍:先交后接也必须只发一次。 */
    const r3 = acceptQuest(n.id, s);
    eq(r3.awarded, null, '完成态再领仍是 null');
    eq(questStatusOf(r3.state, qid), 'completed', '完成态不许回退');
  }
});

/* ───────────────────────── 9 ───────────────────────── */

test('FND186-9 acceptQuest 是纯函数:入参一字不改;无任务的 NPC 回 NO_QUEST', () => {
  const q = QUEST_NPCS[0]!.quest!;
  const s0 = st({ [q.needItemId]: q.needCount }, {});
  const inv0 = JSON.stringify(s0.inventory);
  const quests0 = JSON.stringify(s0.quests);
  const r1 = acceptQuest(QUEST_NPCS[0]!.id, s0);
  eq(JSON.stringify(s0.inventory), inv0, 'acceptQuest 不该改入参的背包');
  eq(JSON.stringify(s0.quests), quests0, 'acceptQuest 不该改入参的任务账本');
  ok(r1.state !== s0, '状态真的变了时应返回**新对象**(不是原地改)');
  const r2 = acceptQuest(QUEST_NPCS[0]!.id, r1.state);
  eq(JSON.stringify(r1.state.quests), JSON.stringify({ [q.id]: 'accepted' }),
    '上一次返回的状态也不该被下一次调用改掉');
  eq(r2.outcome, 'COMPLETED', '第二次应完成');

  /* 物品数量本身不受影响:本模块只**读**背包(扣减是房间/背包系统的职责)。 */
  eq(itemCountOf(r2.state, q.needItemId), q.needCount, '本模块不该扣背包物品(扣减不在这一层)');

  /* 无任务的 NPC:不抛、不发奖、状态原样。 */
  for (const n of PLAIN_NPCS) {
    const s = st({ 123: 1 });
    const r = acceptQuest(n.id, s);
    eq(r.outcome, 'NO_QUEST', `${n.id} 没有任务,应回 NO_QUEST`);
    eq(r.awarded, null, `${n.id} 不该发奖`);
    ok(r.state === s, `${n.id} 无事发生时应返回同一个状态对象`);
  }
  /* 负数/垃圾数量按 0 处理(不信任外部快照)。 */
  eq(itemCountOf(st({ 123: -5 }), 123), 0, '负数应按 0 处理');
  eq(itemCountOf(st({}), 123), 0, '缺键应按 0 处理');
});

/* ───────────────────────── 10 ───────────────────────── */

test('FND186-10 progressOf:三种状态 + have/ready/done;物品 id 都在冻结表里', () => {
  const q = QUEST_NPCS[0]!.quest!;
  const rows0 = progressOf(emptyNpcState());
  eq(rows0.length, allQuests().length, 'progressOf 应对每个任务各返回一行');
  for (const r of rows0) {
    eq(r.status, 'available', `${r.questId} 在空账本里应是 available`);
    eq(r.done, false, 'available 不该算 done');
    eq(r.ready, false, 'available 不该算 ready(还没接)`');
    eq(r.have, 0, '空背包 have 应为 0');
  }
  const accepted = progressOf(st({ [q.needItemId]: q.needCount - 1 }, { [q.id]: 'accepted' }));
  const row = accepted.find((r) => r.questId === q.id)!;
  eq(row.status, 'accepted', '接了应显示 accepted');
  eq(row.have, q.needCount - 1, 'have 应等于背包里有的数量');
  eq(row.ready, false, '差一件时 ready 必须是 false(边界:needCount-1)');
  const ready = progressOf(st({ [q.needItemId]: q.needCount }, { [q.id]: 'accepted' })).find((r) => r.questId === q.id)!;
  eq(ready.ready, true, '刚好够时 ready 必须是 true(边界:needCount)');
  const done = progressOf(st({ [q.needItemId]: q.needCount }, { [q.id]: 'completed' })).find((r) => r.questId === q.id)!;
  eq(done.status, 'completed', 'completed 应如实显示');
  eq(done.done, true, 'completed 应算 done(奖励已发过)');
  eq(done.ready, false, 'completed 不该再显示 ready(已经交过了)');

  /* 物品 id 必须真的在冻结表里 —— 拼错一个数字 = 任务永远交不了,而且不报错。 */
  eq(missingItemIds().length, 0, `NPC 任务引用了冻解表里不存在的物品 id:[${missingItemIds().join('/')}]`);
  for (const qq of allQuests()) {
    ok(qq.needCount > 0 && qq.rewardCount > 0, `${qq.id} 的 needCount/rewardCount 必须 > 0`);
    ok(qq.needItemId !== qq.rewardItemId, `${qq.id} 的"需求"与"奖励"是同一件物品(玩家只会看到数字变来变去)`);
  }
});

report('WS-FND-186');