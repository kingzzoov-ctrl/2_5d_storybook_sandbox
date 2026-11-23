/**
 * WS-FND-192 · **NPC 任务面板 + 头上记号**(车道 D,2026-11-27)。
 *
 * ## 这套判据在守什么
 *
 * NPC 已经上屏、按 `T` 也能说话(`WS-FND-188`),但玩家**看不到任务**:服务端的
 * `server/src/npc/dialogue.ts` 有 `acceptQuest()` / `progressOf()`,而客户端此前一个字
 * 都没有 —— 只有一句台词,没有「要我做什么、我还差几件、奖励是什么」。
 * 本套件守两个新客户端纯函数的**语义 + 兜底 + 确定性**:
 * ```text
 * client/src/ui/npc_panel.ts          面板三段(标题 / 正文 / 键位提示)
 * client/src/ui/npc_quest_targets.ts  头上记号(位置 + 记号,顺序确定)
 * ```
 *
 * ## 判据
 *
 * | # | 判据 | 为什么有牙(改坏了哪条会红) |
 * |---|------|----------------------------|
 * | FND192-1  | 四种情形(无任务/available/accepted/completed)正文**两两不同**且非空、标题非空 | 四个分支抄成一段文案 ⇒ 红 |
 * | FND192-2  | `available` 正文含**需求与奖励**(名字 + 数量),`hint` 含「按 Y 接下」 | 只写「他有事找你」不写要什么 ⇒ 红 |
 * | FND192-3  | `accepted` 正文**逐字符**含 `have` 与 `needCount`,且写明还差几件 | 把 `have` 夹到 `needCount`(或反过来)⇒ 红(见文末实证) |
 * | FND192-4  | `accepted` 且物品够 ⇒ 不写「还差」、写「够了」,提示是**交任务并领奖** | 够了还提示「先去凑齐」⇒ 红 |
 * | FND192-5  | `completed` ⇒ 正文含「已完成」+「不会重复发」,`hint` **不再**提示按 Y | 完成了还叫人按 Y 接一次 ⇒ 红 |
 * | FND192-6  | 兜底:未知 `status` ⇒ 不抛、非空、点明「状态看不懂」 | 走 `default` 返回空串 ⇒ 红 |
 * | FND192-7  | 兜底:`have > needCount`(9/5、999)⇒ 不抛、照实写两个数字、判「可交」;`Infinity` ⇒ 按 0 件算(不够) | 上界夹到 `needCount` ⇒ FND192-3/7 红 |
 * | FND192-8  | 兜底:`have` 负数 / `NaN` / 非数 / 小数 ⇒ 不抛、可读、注明读数异常 | 直接把 `NaN` 拼进文案 ⇒ 红 |
 * | FND192-9  | 兜底:`itemName` 抛错 / 返回空串 / 不是函数 ⇒ 不抛、退到 `物品 #id` | 让回调的异常冒到渲染循环 ⇒ 红 |
 * | FND192-10 | 兜底:`quest` 为 `null` / `undefined` / 数字 ⇒ 那句「他今天没什么要你做的。」 | 无任务时返回空正文 ⇒ 红 |
 * | FND192-11 | 确定性:同输入两次 `JSON.stringify` 逐字相等;入参**不被修改** | 往 `input` 上写字段 / 读时间 ⇒ 红 |
 * | FND192-12 | `markerOf` / `questMarkers`:`available → !`、`completed → ?`、其余(含 `accepted`/`none`/垃圾)⇒ `·` | 两张映射对调 ⇒ 红(见文末实证) |
 * | FND192-13 | `questMarkers` 顺序确定(按 `y` → `x` → `id`)、空输入 `[]`、入参不被改 | 用「数组原序」或乱序 ⇒ 红 |
 * | FND192-14 | `questMarkers` 兜底:`statusOf` 抛错 / 不是函数 ⇒ `·`;坏记录(`NaN` 坐标/空 id)跳过 | 让坏记录进排序 ⇒ 顺序随实现随机,红 |
 *
 * ## 有牙实证(改坏实现 ⇒ 判据真变红;三个变异都已还原,`sha256` 前后一致)
 *
 * 手法(可复跑):用脚本改一个片段 → 跑本套件 → 按字节还原 → 核 `sha256`。
 * 基线:`client/src/ui/npc_quest_targets.ts` = `8dd9a40adc30`、
 * `client/src/ui/npc_panel.ts` = `b4327495647c`(sha256 前 12 位),基线 `14/14 通过`。
 *
 * ### 1 把 `'!'` / `'?'` 两张映射对调(`client/src/ui/npc_quest_targets.ts#markerOf`)
 *
 * ```text
 * 替换:available 分支返回 QUEST_MARKER_COMPLETED、completed 分支返回 QUEST_MARKER_AVAILABLE
 * [WS-FND-192] 11/14 通过
 * ✗ FND192-12 头上记号 — available 头上的记号 期望 "!" / 实际 "?"
 * ✗ FND192-13 记号顺序确定 — 记号跟着各自的 NPC [1]:期望 "!" / 实际 "?"
 * ✗ FND192-14 记号兜底 — 一个坏 id 不会把整帧记号打掉 [0]:期望 "!" / 实际 "?"
 * ```
 *
 * ### 2 进度行漏掉 `have`(只写 `needCount`,`client/src/ui/npc_panel.ts`)
 *
 * ```text
 * 替换:`进度:${have}/${quest.needCount} ${need}` ⇒ `进度:${quest.needCount} ${need}`
 * [WS-FND-192] 11/14 通过
 * ✗ FND192-3 accepted — 正文里必须找得到 2(背包里确实有 2 件,不许夹)
 * ✗ FND192-7 兜底 — have=6:背包里有几件必须照实写(不许夹到 needCount)
 * ✗ FND192-8 兜底 — have=-4:按 0/5 算(进度:5 暖松原木)
 * ```
 *
 * ### 3 把 `have` 上界夹到 `needCount`(`client/src/ui/npc_panel.ts`)
 *
 * ```text
 * 替换:`const have = countOf(haveRaw);` ⇒ `const have = Math.min(countOf(haveRaw), quest.needCount);`
 * [WS-FND-192] 13/14 通过
 * ✗ FND192-7 兜底 — have=6:背包里有几件必须照实写(不许夹到 needCount)
 * ```
 *
 * 还原后:两个文件 `sha256` 与基线**逐字节一致**,`node tests/WS-FND-192-npc-panel.test.ts`
 * ⇒ `[WS-FND-192] 14/14 通过`。
 *
 * ## 运行
 *
 * `node tests/WS-FND-192-npc-panel.test.ts`
 */

import { eq, ok, report, test } from '../shared/testing/harness.ts';

import {
  NPC_PANEL_ACCEPT_HINT,
  NPC_PANEL_ACCEPT_KEY,
  NPC_PANEL_COMPLETED_HINT,
  NPC_PANEL_IDLE_HINT,
  NPC_PANEL_IDLE_TEXT,
  NPC_PANEL_NOT_READY_HINT,
  NPC_PANEL_TALK_KEY,
  NPC_PANEL_TURNIN_HINT,
  NPC_PANEL_UNKNOWN_STATUS_TEXT,
  fallbackItemName,
  planNpcPanel,
  type NpcPanelInput,
  type NpcPanelQuest,
  type NpcPanelView,
} from '../client/src/ui/npc_panel.ts';
import {
  QUEST_MARKER_AVAILABLE,
  QUEST_MARKER_COMPLETED,
  QUEST_MARKER_OTHER,
  markerOf,
  questMarkers,
  type QuestMarkerStatus,
} from '../client/src/ui/npc_quest_targets.ts';

/* ── 取样(全部来自 `server/src/npc/defs.ts` 的口径,不是随手编的) ── */
const QUEST: NpcPanelQuest = {
  id: 'q_wood_for_axe',
  title: '给阿岩凑木料',
  needItemId: 101,
  needCount: 5,
  rewardItemId: 201,
  rewardCount: 1,
};
const NPC = { id: 'npc_rocky', name: '樵夫阿岩' };

/** 查名:与内容表无关的假表(`101 → 暖松原木` / `201 → 暖松石刃斧`),并**故意不含数字**。 */
function itemName(id: number): string {
  if (id === 101) return '暖松原木';
  if (id === 201) return '暖松石刃斧';
  return `未知物品`;
}

/** 一份合法输入(各条判据在上面改一两个字段)。 */
function view(over: Partial<NpcPanelInput> = {}): NpcPanelView {
  return planNpcPanel({
    npc: NPC,
    quest: { ...QUEST },
    status: 'available',
    have: 0,
    itemName,
    ...over,
  });
}

/** 喂垃圾输入用:判据 FND192-6..10 要故意破坏类型(TS 类型在这里帮不上忙)。 */
function raw(input: unknown): NpcPanelView {
  return planNpcPanel(input as unknown as NpcPanelInput);
}

/**
 * 取「进度」那一行;取不到就当场断言失败(返回 `''` 只为让类型收窄成 `string`)。
 *
 * 用它的理由:`ok(...)` 不做类型收窄,直接 `rows.find(...)` 会让 typecheck 多出
 * `possibly undefined`(那条错误和真 bug 混在一起就没人看了)。
 */
function progressRow(rows: readonly string[]): string {
  const row = rows.find((r) => r.includes('进度'));
  ok(row !== undefined, `必须有一行「进度」(实际 ${JSON.stringify(rows)})`);
  return row ?? '';
}

/* ═══════════════════════════ 1. 四种情形 ═══════════════════════════ */

test('FND192-1 四种情形:正文两两不同、都非空、标题非空', () => {
  const cases: readonly { name: string; v: NpcPanelView }[] = [
    { name: '无任务', v: view({ quest: null }) },
    { name: 'available', v: view({ status: 'available' }) },
    { name: 'accepted', v: view({ status: 'accepted', have: 2 }) },
    { name: 'completed', v: view({ status: 'completed' }) },
  ];
  const seen = new Map<string, string>();
  for (const c of cases) {
    ok(c.v.title.length > 0, `${c.name}:标题非空`);
    ok(c.v.rows.length > 0, `${c.name}:正文至少一行`);
    ok(c.v.hint.length > 0, `${c.name}:键位提示非空`);
    for (const row of c.v.rows) ok(row.length > 0, `${c.name}:正文行非空(${JSON.stringify(c.v.rows)})`);
    const key = JSON.stringify(c.v.rows);
    const dup = seen.get(key);
    ok(dup === undefined, `${c.name} 的正文与「${dup}」逐字相同 —— 四个分支必须各说各的`);
    seen.set(key, c.name);
  }
  /* 四种情形的正文两两不同(4 条互不相同 ⇒ 集合大小也是 4)。 */
  eq(seen.size, 4, '四种情形的正文集合大小');
});

/* ═══════════════════════════ 2. available ═══════════════════════════ */

test('FND192-2 available:正文含需求与奖励,提示「按 Y 接下」', () => {
  const v = view({ status: 'available' });
  const text = v.rows.join('\n');
  ok(text.includes('暖松原木'), `要写清需要什么(${text})`);
  ok(text.includes('暖松石刃斧'), `要写清奖励是什么(${text})`);
  ok(text.includes(String(QUEST.needCount)), '要写清要几件');
  ok(text.includes(String(QUEST.rewardCount)), '要写清奖励几件');
  ok(v.hint.includes('按 Y 接下'), `提示必须说清怎么接(${v.hint})`);
  ok(v.hint.includes(NPC_PANEL_ACCEPT_KEY), '键位从常量来(接线换键只改一个字面量)');
  eq(v.hint, NPC_PANEL_ACCEPT_HINT, '可用那一条提示与常量逐字一致');
  ok(v.title.includes(NPC.name) && v.title.includes(QUEST.title), '标题=谁 + 哪条任务');
});

/* ═══════════════════════════ 3. accepted(进度) ═══════════════════════════ */

test('FND192-3 accepted:进度行逐字符含 have 与 needCount,且写明还差几件', () => {
  const have = 2;
  const v = view({ status: 'accepted', have });
  const progress = progressRow(v.rows);
  ok(progress.includes(String(have)), `正文里必须找得到 ${have}(背包里确实有 ${have} 件,不许夹)`);
  ok(progress.includes(String(QUEST.needCount)), `正文里必须找得到 ${QUEST.needCount}(要几件)`);
  ok(progress.includes(`${have}/${QUEST.needCount}`), '进度写成 have/needCount');
  ok(v.rows.some((r) => r.includes('还差 3 件')), `必须说清还差几件(${JSON.stringify(v.rows)})`);
  ok(v.rows.some((r) => r.includes('暖松原木')), '差的那件要说清是什么');
  eq(v.hint, NPC_PANEL_NOT_READY_HINT, '物品不够 ⇒ 提示「按 Y 交任务(物品还不够)」');
  /* 反向:同一份输入换个 have,进度行必须跟着动(常量文案冒充不了)。 */
  const v1 = view({ status: 'accepted', have: 4 });
  ok(JSON.stringify(v1.rows) !== JSON.stringify(v.rows), 'have 变了,正文必须跟着变');
  ok(v1.rows.some((r) => r.includes('还差 1 件')), 'have=4 ⇒ 还差 1 件');
});

test('FND192-4 accepted 且物品够:写「够了」,提示是交任务并领奖', () => {
  const v = view({ status: 'accepted', have: QUEST.needCount });
  ok(v.rows.some((r) => r.includes('够了')), `够了就要说「够了」(${JSON.stringify(v.rows)})`);
  ok(!v.rows.some((r) => r.includes('还差')), '够了就不许再写「还差」');
  eq(v.hint, NPC_PANEL_TURNIN_HINT, '这次按下去真的会交 + 发奖');
  ok(v.hint.includes(NPC_PANEL_ACCEPT_KEY), '键位从常量来');
  /* 多出来的那些件也算「够」(不该因为 7 > 5 就说还差)。 */
  const over = view({ status: 'accepted', have: 7 });
  ok(over.rows.some((r) => r.includes('够了')), 'have > needCount 同样是「够了」');
  eq(over.hint, NPC_PANEL_TURNIN_HINT, '提示同样是「交任务并领奖」');
});

/* ═══════════════════════════ 4. completed ═══════════════════════════ */

test('FND192-5 completed:写「已完成 / 不会重复发」,不再提示按 Y', () => {
  const v = view({ status: 'completed' });
  const text = v.rows.join('\n');
  ok(text.includes('已完成'), `要说清已经交过了(${text})`);
  ok(text.includes('不会重复发'), '要说清奖励只发一次(与服务端 `acceptQuest` 的硬规则同口径)');
  ok(text.includes('暖松石刃斧'), '要说清发了什么');
  eq(v.hint, NPC_PANEL_COMPLETED_HINT, '已封账 ⇒ 提示回到「再说一句」');
  ok(v.hint.includes(NPC_PANEL_TALK_KEY), '提示的是说话键');
  ok(!v.hint.includes(`按 ${NPC_PANEL_ACCEPT_KEY} 接下`), '完成了就不许再提示「接下」');
  ok(!v.hint.includes(`按 ${NPC_PANEL_ACCEPT_KEY} 交任务`), '完成了也不许再提示「交任务」');
});

/* ═══════════════════════════ 5. 兜底四条 ═══════════════════════════ */

test('FND192-6 兜底:未知 status 不抛、非空、点明「状态看不懂」', () => {
  for (const bad of ['nope', '', 'AVAILABLE', 0, 1, null, undefined, {}, ['available']]) {
    const v = raw({ npc: NPC, quest: { ...QUEST }, status: bad, have: 0, itemName });
    ok(v.title.length > 0, `status=${JSON.stringify(bad) ?? String(bad)}:标题非空`);
    ok(v.rows.length > 0, `status=${JSON.stringify(bad) ?? String(bad)}:正文非空`);
    ok(v.rows.every((r) => r.length > 0), '正文没有空行');
    ok(v.rows.includes(NPC_PANEL_UNKNOWN_STATUS_TEXT), '点明「状态看不懂」,而不是假装他是某一种');
    ok(v.hint.length > 0, '提示非空');
    ok(v.hint.includes(NPC_PANEL_TALK_KEY), '提示「按 T 再问一次他」');
    ok(!v.hint.includes(NPC_PANEL_ACCEPT_KEY), '状态不认识 ⇒ 不许叫人按接/交键');
  }
});

test('FND192-7 兜底:have 溢出(9/5)照实写并判「可交」,Infinity 按 0 件算', () => {
  for (const over of [6, 9, 999]) {
    const v = raw({ npc: NPC, quest: { ...QUEST }, status: 'accepted', have: over, itemName });
    const progress = progressRow(v.rows);
    ok(progress.includes(String(QUEST.needCount)), `have=${over}:要几件必须照实写`);
    ok(progress.includes(String(over)), `have=${over}:背包里有几件必须照实写(不许夹到 needCount)`);
    eq(v.hint, NPC_PANEL_TURNIN_HINT, `have=${over}:够了 ⇒ 提示交任务并领奖`);
    ok(v.rows.every((r) => r.length > 0), '正文没有空行');
  }
  /* `Infinity` **不是**「无限多件」:读不出数 ⇒ 按 0 件算(不够),而不是当"可交"骗玩家按下键。 */
  const inf = raw({ npc: NPC, quest: { ...QUEST }, status: 'accepted', have: Number.POSITIVE_INFINITY, itemName });
  ok(inf.rows.some((r) => r.includes('0/5')), `Infinity ⇒ 0/5(${JSON.stringify(inf.rows)})`);
  ok(!inf.rows.some((r) => r.includes('Infinity')), '正文里不许出现 Infinity');
  eq(inf.hint, NPC_PANEL_NOT_READY_HINT, 'Infinity ⇒ 不够 ⇒ 提示「先去凑齐」');
});

test('FND192-8 兜底:have 负数 / NaN / 非数 / 小数都不抛且可读', () => {
  const cases: readonly { have: unknown; want: string }[] = [
    { have: -4, want: '0/5' },
    { have: Number.NaN, want: '0/5' },
    { have: Number.NEGATIVE_INFINITY, want: '0/5' },
    { have: '3', want: '0/5' },
    { have: null, want: '0/5' },
    { have: undefined, want: '0/5' },
    { have: 2.7, want: '2/5' },
  ];
  for (const c of cases) {
    const v = raw({ npc: NPC, quest: { ...QUEST }, status: 'accepted', have: c.have, itemName });
    const progress = progressRow(v.rows);
    ok(progress.includes(c.want), `have=${String(c.have)}:按 ${c.want} 算(${progress})`);
    ok(!/NaN|Infinity|undefined|null/.test(v.rows.join('\n')), `have=${String(c.have)}:正文里不许出现 NaN/Infinity/undefined`);
    ok(v.rows.some((r) => r.includes('读数')), `have=${String(c.have)}:必须注明这个数字是怎么来的`);
    ok(v.hint.length > 0, `have=${String(c.have)}:提示非空`);
    eq(v.hint, NPC_PANEL_NOT_READY_HINT, `have=${String(c.have)}:不够 ⇒ 提示「先去凑齐」`);
  }
  /* 干净的读数**不**加那行说明(免得每屏都是免责声明)。 */
  const clean = view({ status: 'accepted', have: 2 });
  ok(!clean.rows.some((r) => r.includes('读数')), `have=2 是干净读数,不该有说明行(${JSON.stringify(clean.rows)})`);
});

test('FND192-9 兜底:itemName 抛错 / 返回空串 / 不是函数 ⇒ 退到「物品 #id」', () => {
  const thrower = (id: number): string => {
    throw new Error(`内容表里没有 ${id}`);
  };
  const cases: readonly { name: string; fn: unknown }[] = [
    { name: '抛错', fn: thrower },
    { name: '空串', fn: () => '' },
    { name: '纯空白', fn: () => '   ' },
    { name: '返回非串', fn: () => 42 },
    { name: '返回 null', fn: () => null },
    { name: '不是函数', fn: undefined },
    { name: '字符串当函数', fn: 'itemName' },
    { name: '缺字段', fn: undefined },
  ];
  for (const c of cases) {
    const v = raw({ npc: NPC, quest: { ...QUEST }, status: 'available', have: 0, itemName: c.fn });
    ok(v.rows.length > 0, `${c.name}:正文非空`);
    ok(v.rows.some((r) => r.includes(fallbackItemName(QUEST.needItemId))),
      `${c.name}:需求退到 ${fallbackItemName(QUEST.needItemId)}(${JSON.stringify(v.rows)})`);
    ok(v.rows.some((r) => r.includes(fallbackItemName(QUEST.rewardItemId))),
      `${c.name}:奖励退到 ${fallbackItemName(QUEST.rewardItemId)}`);
    ok(v.hint.length > 0, `${c.name}:提示非空`);
    ok(!/NaN|undefined/.test(v.rows.join('\n')), `${c.name}:正文里不许出现 NaN/undefined`);
  }
  /* 正常回调照旧走(兜底没有把好路径吃掉)。 */
  const normal = view({ itemName });
  ok(normal.rows.some((r) => r.includes('暖松原木')), '正常回调仍然生效');
});

test('FND192-10 兜底:quest 为 null / undefined / 数字 ⇒ 那句「没什么要你做的」', () => {
  for (const q of [null, undefined, 42, 'quest', true]) {
    const v = raw({ npc: NPC, quest: q, status: 'available', have: 0, itemName });
    eq(v.rows, [NPC_PANEL_IDLE_TEXT], `quest=${String(q)}:正文就是那一句`);
    eq(v.title, NPC.name, '标题只写 NPC 名(没有任务就别编一个)');
    eq(v.hint, NPC_PANEL_IDLE_HINT, '提示回到「再说一句」');
    ok(NPC_PANEL_IDLE_TEXT.length > 0, '那句话本身非空');
  }
  /* `{}` 是对象 ⇒ 按「有任务但字段缺」处理:给可读文案,不抛、不空。 */
  const empty = raw({ npc: NPC, quest: {}, status: 'available', have: 0, itemName });
  ok(empty.rows.length > 0, 'quest={}:正文非空');
  ok(empty.title.includes('未命名任务'), `quest={}:标题里点明没写名字(${empty.title})`);
  ok(!empty.rows.some((r) => r.includes('NaN')), 'quest={}:正文里不许出现 NaN');
  /* NPC 名缺失也不能画出空标题。 */
  const noName = raw({ npc: {}, quest: { ...QUEST }, status: 'available', have: 0, itemName });
  ok(noName.title.length > 0, 'NPC 名缺失 ⇒ 标题仍非空(兜底称呼)');
});

/* ═══════════════════════════ 6. 确定性 ═══════════════════════════ */

test('FND192-11 确定性:同输入两次逐字相等,且入参不被修改', () => {
  const cases: readonly NpcPanelInput[] = [
    { npc: NPC, quest: { ...QUEST }, status: 'available', have: 0, itemName },
    { npc: NPC, quest: { ...QUEST }, status: 'accepted', have: 2, itemName },
    { npc: NPC, quest: { ...QUEST }, status: 'accepted', have: 5, itemName },
    { npc: NPC, quest: { ...QUEST }, status: 'completed', have: 5, itemName },
    { npc: NPC, quest: null, status: 'completed', have: 5, itemName },
  ];
  for (const input of cases) {
    const before = JSON.stringify(input);
    const a = planNpcPanel(input);
    const b = planNpcPanel(input);
    eq(JSON.stringify(a), JSON.stringify(b), `${input.status}/have=${input.have}:两次结果逐字相等`);
    eq(JSON.stringify(input), before, '入参没有被写');
    ok(a.rows !== b.rows, '每次返回新数组(调用方可以随便排序/裁剪)');
    /* 改返回值不该污染下一次(纯函数:没有共享的可变状态)。 */
    a.rows.push('__污染__');
    const c = planNpcPanel(input);
    ok(!c.rows.includes('__污染__'), '返回值与内部状态不共享');
  }
});

/* ═══════════════════════════ 7. 头上记号 ═══════════════════════════ */

test('FND192-12 头上记号:available → ! / completed → ? / 其余 → ·', () => {
  eq(markerOf('available'), QUEST_MARKER_AVAILABLE, 'available 头上的记号');
  eq(markerOf('completed'), QUEST_MARKER_COMPLETED, 'completed 头上的记号');
  eq(markerOf('accepted'), QUEST_MARKER_OTHER, 'accepted 头上没有记号(还在做)');
  eq(markerOf('none'), QUEST_MARKER_OTHER, 'none 头上没有记号');
  eq(QUEST_MARKER_AVAILABLE, '!', '`!` 就是那一个字面量');
  eq(QUEST_MARKER_COMPLETED, '?', '`?` 就是那一个字面量');
  eq(QUEST_MARKER_OTHER, '·', '`·` 就是那一个字面量');
  /* 垃圾状态一律 `·`(不猜)。 */
  for (const bad of ['nope', '', 'AVAILABLE', 0, null, undefined, {}, ['completed']]) {
    eq(markerOf(bad), QUEST_MARKER_OTHER, `垃圾状态 ${JSON.stringify(bad) ?? String(bad)} ⇒ ·`);
  }
  /* 通过列表接口走一遍:五条 NPC,五种状态。 */
  const npcs = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 1, y: 0 },
    { id: 'c', x: 2, y: 0 },
    { id: 'd', x: 3, y: 0 },
    { id: 'e', x: 4, y: 0 },
  ];
  const status: Record<string, QuestMarkerStatus> = {
    a: 'available', b: 'completed', c: 'accepted', d: 'none', e: 'nope' as QuestMarkerStatus,
  };
  const got = questMarkers(npcs, (id) => status[id] ?? 'none');
  eq(got.map((g) => g.marker), ['!', '?', '·', '·', '·'], '五个 NPC 的记号');
  eq(got.map((g) => g.id), ['a', 'b', 'c', 'd', 'e'], '位置原样带出来');
});

test('FND192-13 记号顺序确定(按 y → x → id),空输入 []', () => {
  const status = (id: string): QuestMarkerStatus => (id === 'a' ? 'available' : 'none');
  const npcs = [
    { id: 'c', x: 2, y: 1 },
    { id: 'a', x: 0, y: 1 },
    { id: 'b', x: 0, y: 0 },
  ];
  const got = questMarkers(npcs, status);
  eq(got.map((g) => g.id), ['b', 'a', 'c'], 'y 升序,再 x 升序');
  eq(got.map((g) => g.marker), ['·', '!', '·'], '记号跟着各自的 NPC');
  eq(got[1], { id: 'a', x: 0, y: 1, marker: '!' }, '一条记录就该是这四个字段');
  /* 坐标完全相同 ⇒ 按 id 定序(不依赖引擎排序的稳定性)。 */
  const same = [
    { id: 'z', x: 1, y: 1 },
    { id: 'm', x: 1, y: 1 },
    { id: 'a', x: 1, y: 1 },
  ];
  eq(questMarkers(same, status).map((g) => g.id), ['a', 'm', 'z'], '同一格:按 id 升序');
  /* 入参不被改(原地 sort 会让调用方的列表顺序也变)。 */
  const before = JSON.stringify(npcs);
  questMarkers(npcs, status);
  eq(JSON.stringify(npcs), before, '入参数组没有被排序');
  /* 空输入 */
  eq(questMarkers([], status), [], '空列表 ⇒ []');
  const got2 = questMarkers([], status);
  ok(Array.isArray(got2), '返回的是数组(调用方直接 for...of)');
});

test('FND192-14 记号兜底:statusOf 抛错 / 不是函数 ⇒ ·,坏记录跳过', () => {
  const npcs = [
    { id: 'ok', x: 1, y: 1 },
    { id: 'boom', x: 2, y: 2 },
  ];
  const thrower = (id: string): QuestMarkerStatus => {
    if (id === 'boom') throw new Error('账本读坏了');
    return 'available';
  };
  const got = questMarkers(npcs, thrower);
  eq(got.map((g) => g.marker), ['!', '·'], '一个坏 id 不会把整帧记号打掉');
  eq(got.map((g) => g.id), ['ok', 'boom'], '坏 id 那一条照画(只是没记号)');
  /* `statusOf` 不是函数 ⇒ 全 `·`,不抛。 */
  for (const bad of [undefined, null, 42, 'statusOf', {}]) {
    const v = questMarkers(npcs, bad as unknown as (id: string) => QuestMarkerStatus);
    eq(v.map((g) => g.marker), ['·', '·'], `statusOf=${String(bad)} ⇒ 全 ·`);
  }
  /* 坏记录跳过:没有 id / 坐标不是有限数 / 根本不是对象。 */
  const messy = [
    { id: 'good1', x: 0, y: 0 },
    { id: '', x: 1, y: 1 },
    { id: 'noX', x: Number.NaN, y: 2 },
    { id: 'noY', x: 3, y: Number.POSITIVE_INFINITY },
    { id: 'strX', x: '4', y: 4 },
    null,
    undefined,
    7,
    { id: 'good2', x: 5, y: 5 },
  ];
  const gotMessy = questMarkers(messy as unknown as readonly { id: string; x: number; y: number }[],
    () => 'completed');
  eq(gotMessy.map((g) => g.id), ['good1', 'good2'], '坏记录被跳过');
  eq(gotMessy.map((g) => g.marker), ['?', '?'], '好记录照常带记号');
  /* 整个列表是垃圾 ⇒ [],不是 undefined。 */
  for (const bad of [null, undefined, 42, 'npcs', {}]) {
    eq(questMarkers(bad as unknown as readonly { id: string; x: number; y: number }[], () => 'none'),
      [], `npcs=${String(bad)} ⇒ []`);
  }
});

report('WS-FND-192');
