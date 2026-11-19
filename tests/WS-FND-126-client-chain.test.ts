/**
 * WS-FND-126 / 第七轮实测的**五处端到端断点**(客户端侧):
 *
 * | # | 断点(修前) | 判据 | 负对照(证明这条有牙齿) |
 * |---|------------|------|--------------------------|
 * | 1 | `main.ts` 的 `facing` 是 `const {dx:0,dy:1}` ⇒ 放置/拆除**永远**作用于脚下南侧一格 | `nextFacing()` 会按输入/权威位移转向,`cellInFront` 因此给出不同格 | 零输入 + 零位移 ⇒ 返回 `prev`(不回落到默认向下) |
 * | 2 | `boot.ts:1344` 用 `e` 开画架,而 `ACTION_KEYS.e` 是「拆除」⇒ 一次按键两件事 | `panel_keys.keyCollisions()` 为空(读**四张真表**) | 把 `e` 塞回面板组 ⇒ 必须报出恰好 `e` 一条冲突 |
 * | 3 | 面板键表住在不可测的 `boot.ts` 里,`net/action_binding.ts` 的注释还把 `e` 列进两个互斥集合 | 面板键表是纯模块、画架在 `h`、提示由表生成 | 提示里仍出现 `E 画架` / `panelKeyOf('e')` 非空 ⇒ 判红 |
 * | 4 | `drop()` 的返回值只拼提示;`invView` 每帧由静态 `ITEM_LIST` 重建 ⇒ 格子内容不变 | `applySlotMove` 改的是**格位状态**,`buildView({slotItemIds})` 读到新内容 | 不传 `slotItemIds` ⇒ 视图与修前逐字段相同(证明"只改提示"会被这条判据抓住) |
 * | 5 | `wildlife` / 其他 `players` 零渲染出口 ⇒ 怪与队友看不见 | `planEntitySprites` 把 wildlife 与远端玩家都列出来,本地玩家不在内 | 空快照 ⇒ `[]`(不编实体);坏坐标 ⇒ 跳过(不摆到 0,0) |
 * | 6 | `CRAFT` 的 `have` 恒 `undefined` ⇒ 按 N 永不发;T 没有 `useItem` 端口 ⇒ 按 T 永不发 | 账本按回执增量落账后 `craftRequest` 成立、入口真的发出两条动作 | 不给 `useItem` 端口 ⇒ 按 T **不发**(修前形态) |
 * | 7 | `searchMode` 下打 `e` 会误发 `BREAK_BLOCK` | `ActionKeyGuard` 在文本输入态挡掉动作键 | 不看输入态(修前形态)对 `e` 仍会给 `true` |
 *
 * ## 注入验证(判据必须能对"坏样本"报红)
 * 有 4 条判据直接跑在**被改坏的源码/数据副本**上(`FND126-2/7/11/12` 的注入段),
 * 而不是只断言"当前代码里搜得到某个字符串" —— 否则路径写错、正则写松都会静默变绿。
 *
 * 运行:`node tests/WS-FND-126-client-chain.test.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, eq, ok, report } from '../shared/testing/harness.ts';

import {
  ACTION_KEYS,
  FACING_DEFAULT,
  cellInFront,
  facingLabel,
  nextFacing,
  type Facing,
} from '../client/src/net/action_target.ts';
import {
  PANEL_KEYS,
  keyCollisions,
  keyGroups,
  keyGroupsExclusive,
  panelKeyHints,
  panelKeyOf,
} from '../client/src/ui/panel_keys.ts';
import { ActionKeyGuard } from '../client/src/net/key_guard.ts';
import { applyReceiptToHave, haveEntryCount, type HaveDetail } from '../client/src/net/have_ledger.ts';
import { ActionEntry, craftRequest } from '../client/src/net/action_entry.ts';
import { ENTRY_KEYS, createActionBinding } from '../client/src/net/action_binding.ts';
import {
  applySlotMove,
  buildView,
  defaultSlotItemIds,
  slotItemOf,
} from '../client/src/ui/inventory.ts';
import { countByKind, planEntitySprites } from '../client/src/stage/entity_sprites.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';

/* ─────────────────────────── 基础设施 ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * 去掉注释再匹配源码片段。
 *
 * 为什么必须去:`main.ts` / `boot.ts` 的注释里逐字写着**修前**的坏代码
 * (`const facing: Facing = { dx: 0, dy: 1 }`、`case 'e': setPanel(...)`),
 * 不剥注释的话"修好了"与"只在注释里写了"完全同形。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const bootSrc = stripComments(read('client/src/three/boot.ts'));
const mainSrc = stripComments(read('client/src/main.ts'));

/* ─────────────────────────── 1 朝向 ─────────────────────────── */

test('FND126-1 朝向随输入/权威位移更新,而且真的改变"面前那格"', () => {
  const start: Facing = { ...FACING_DEFAULT };
  /* 输入优先:往 +x 走 ⇒ 朝东 */
  const east = nextFacing({ prev: start, input: { moveX: 1, moveY: 0 } });
  eq(east, { dx: 1, dy: 0 }, '往 +x 走 ⇒ 朝东');
  const west = nextFacing({ prev: start, input: { moveX: -1, moveY: 0 } });
  eq(west, { dx: -1, dy: 0 }, '往 -x 走 ⇒ 朝西');
  const north = nextFacing({ prev: start, input: { moveX: 0, moveY: -1 } });
  eq(north, { dx: 0, dy: -1 }, '往 -y 走 ⇒ 朝北');
  /* 斜向只取主分量(与 `cellInFront` 的"只取一个"同口径) */
  eq(nextFacing({ prev: start, input: { moveX: -1, moveY: 1 } }),
    { dx: -1, dy: 0 }, '斜向只取一个分量(|x| >= |y| ⇒ x)');
  /* 权威位移(本地没输入时:被推 / 被传送) */
  eq(nextFacing({ prev: start, input: { moveX: 0, moveY: 0 }, from: { x: 5, y: 5 }, to: { x: 5, y: 6 } }),
    { dx: 0, dy: 1 }, '权威位移 +y ⇒ 朝南');

  /* ★ 关键:朝向真的改变"面前那格"(修前四个方向恒同一个格) */
  const pos = { x: 10.5, y: 10.5 };
  const cellDefault = cellInFront(pos, FACING_DEFAULT);
  eq(cellDefault, { x: 10, y: 11 }, '缺省朝南 ⇒ 脚下南侧一格');
  eq(cellInFront(pos, east), { x: 11, y: 10 }, '朝东 ⇒ 东侧一格');
  eq(cellInFront(pos, west), { x: 9, y: 10 }, '朝西 ⇒ 西侧一格');
  eq(cellInFront(pos, north), { x: 10, y: 9 }, '朝北 ⇒ 北侧一格');

  /* 负对照(修前形态):写死朝南 ⇒ 四个方向全是同一格 */
  const frozen: Facing = { dx: 0, dy: 1 };
  ok(cellInFront(pos, frozen).x === cellDefault.x && cellInFront(pos, frozen).y === cellDefault.y,
    '口径自检:写死朝南时确实落在南侧那格');
  const allSame = [east, west, north].every((f) => {
    const c = cellInFront(pos, f);
    return c.x === cellDefault.x && c.y === cellDefault.y;
  });
  ok(!allSame, '★ 负对照:朝向若被写死,三个方向的格子会全部退化到同一格');

  /* 零输入 + 零位移 ⇒ 保持上一次(不回落到默认向下) */
  const keep = nextFacing({ prev: { dx: -1, dy: 0 }, input: { moveX: 0, moveY: 0 },
    from: { x: 3, y: 3 }, to: { x: 3, y: 3 } });
  eq(keep, { dx: -1, dy: 0 }, '★ 负对照:静止时保持上一次朝向(不是回落到向下)');
  eq(facingLabel({ dx: 0, dy: -1 }), '北(-y)', '方向名可读');
});

/* ─────────────────────────── 2 键集互斥 ─────────────────────────── */

test('FND126-2 键位表互斥(读四张真表),画架不再占用 `e`', () => {
  eq(keyGroupsExclusive(), true, '四张表 + 单键组之间没有任何键重复');
  eq(keyCollisions(), [], '冲突清单为空');
  eq(panelKeyOf('e'), null, '★ `e` 不再属于面板键(它是 ACTION_KEYS 的「拆除」)');
  eq(panelKeyOf('h'), 'PIXEL_EASEL', '画架键改到 `h`');
  eq(Object.keys(ACTION_KEYS).includes('e'), true, '`e` 仍是拆除键(没被顺手删掉)');
  eq(Object.keys(ENTRY_KEYS).length, 6, '动作入口仍是六个槽位');

  /* ── 注入验证:把 `e` 塞回面板组(修前形态)⇒ 检测器必须报红 ── */
  const broken = [...keyGroups(), { name: 'PANEL_KEYS(修前:画架在 e)', keys: ['e'] }];
  const collisions = keyCollisions(broken);
  eq(collisions.length, 1, `注入后必须恰好报一条冲突(实际 ${collisions.length})`);
  eq(collisions[0].key, 'e', '报出来的正是 `e`');
  ok(collisions[0].groups.some((g) => g.includes('ACTION_KEYS')), '冲突的两侧都点了名(ACTION_KEYS)');
  eq(keyGroupsExclusive(broken), false, '注入后总判据转假 ⇒ 这条断言有牙齿');
});

/* ─────────────────────────── 3 面板键表可测 ─────────────────────────── */

test('FND126-3 面板键表是纯模块,提示由表生成,画架提示不再是 `E`', () => {
  eq(PANEL_KEYS.h, 'PIXEL_EASEL', '`h` ⇒ 画架');
  const hints = panelKeyHints();
  ok(hints.includes('H 画架'), `提示含「H 画架」:${hints}`);
  ok(!hints.includes('E 画架'), '★ 提示里不再出现「E 画架」(玩家按 E 拆墙,不开画架)');
  /* boot 只做转发:面板判定走 `panelKeyOf`,不再有一串 case */
  ok(bootSrc.includes('panelKeyOf(key)'), 'boot.ts 用 `panelKeyOf(key)` 查表');
  ok(!bootSrc.includes("case 'e': setPanel("), '★ 修前的 `case \'e\': setPanel(` 已消失(已剥注释)');
  ok(bootSrc.includes('panelKeyHints()'), '提示行由表生成(不手写第二份)');
});

/* ─────────────────────────── 4 拖拽成交真的改背包 ─────────────────────────── */

test('FND126-4 拖拽成交改变格位状态,视图内容跟着变(不是只改提示)', () => {
  const ids = defaultSlotItemIds();
  eq(ids.length, ITEM_LIST.length, '格位状态与内容表等长');
  const before0 = ITEM_LIST[0].id;
  const before5 = ITEM_LIST[5].id;
  ok(before0 !== before5, '前提:0 号与 5 号格不是同一件物品');

  const moved = applySlotMove(ids, 0, 5);
  if (moved === null) throw new Error('合法搬运必须成交(否则拖拽永远是死的)');
  eq(moved.moved, { fromSlot: 0, toSlot: 5, itemId: before0, count: 1 }, '凭证记的是被搬走的那件');
  eq(moved.itemIds[0], before5, '两格内容**互换**(不是覆盖 —— 覆盖会凭空销毁一件)');
  eq(moved.itemIds[5], before0, '目标格拿到了源格的东西');
  eq(ids[0], before0, '★ 纯函数:入参数组没有被就地改(否则"改了一半"不可回滚)');

  /* 视图真的跟着变 */
  const after = buildView({ page: 0, slotItemIds: moved.itemIds });
  eq(after.slots[0]?.item.id, before5, '视图第 0 格现在是被换进来的那件');
  eq(slotItemOf(moved.itemIds, 5)?.id, before0, '格位查询同样读到新内容');

  /* 负对照(修前形态):不传格位状态 ⇒ 视图仍由静态内容表重建 */
  const frozenView = buildView({ page: 0 });
  eq(frozenView.slots[0]?.item.id, before0, '★ 负对照:不接格位状态时第 0 格还是原来那件 ⇒ 这条判据能抓住"只改提示"');

  /* 非法输入不成交 */
  eq(applySlotMove(ids, 3, 3), null, '同一格 ⇒ 取消');
  eq(applySlotMove(ids, -1, 3), null, '负下标 ⇒ 取消');
  eq(applySlotMove(ids, 0, ids.length + 5), null, '越界 ⇒ 取消');

  /* 生产里真的消费了它 */
  ok(bootSrc.includes('applySlotMove(slotItemIds,'), 'boot.ts 把 `drop()` 的成交写进格位状态');
  ok(bootSrc.includes('slotFingerprint(slotItemIds)'), '摘要里有格位指纹(否则"格子真的变了"读不出来)');
  ok(bootSrc.includes('dragCtl.drop(hover)'), '成交入口仍在(未回退到"一律 cancel")');
});

/* ─────────────────────────── 5/6 实体渲染计划 ─────────────────────────── */

test('FND126-5 wildlife 与远端玩家都进渲染计划,本地玩家不重复画', () => {
  const state = {
    players: [
      { id: 'me', name: '我', x: 4, y: 4, z: 0, hp: 10, maxHp: 10 },
      { id: 'p2', name: '队友', x: 7, y: 3, z: 0, hp: 8, maxHp: 10 },
    ],
    wildlife: [
      { id: 'w1', mobId: 'SLIME', x: 9, y: 9, z: 0, hp: 5, maxHp: 5, tameOwnerId: '' },
      { id: 'w2', mobId: 'CHICK', x: 2, y: 8, z: 0, hp: 3, maxHp: 3, tameOwnerId: 'me' },
    ],
  };
  const plan = planEntitySprites(state, 'me');
  eq(plan.length, 3, '1 个队友 + 2 只野生 = 3 块立牌(本地玩家不在内)');
  eq(countByKind(plan, 'player'), 1, '远端玩家有出口');
  eq(countByKind(plan, 'mob'), 1, '普通野生有出口');
  eq(countByKind(plan, 'pet'), 1, '已驯服的记为 pet(颜色不同)');
  ok(!plan.some((s) => s.entityId === 'me'), '★ 本地玩家不重复画(它已有 player_marker)');
  eq(plan.map((s) => s.key), ['mob:w1', 'pet:w2', 'player:p2'], 'key 稳定排序,同一份快照两次调用结果相同');
  eq(planEntitySprites(state, 'me'), planEntitySprites(state, 'me'), '两次调用逐字段相同(可被截图脚本比对)');

  /* 负对照:空快照 ⇒ 不编实体 */
  eq(planEntitySprites({ players: [], wildlife: [] }, 'me'), [], '★ 负对照:空快照 ⇒ 空计划(不凭空画怪)');
  eq(planEntitySprites({}, 'me'), [], '字段缺失也当空');
});

test('FND126-6 坐标坏了就不画(不摆到 0,0),高度缺省为 0', () => {
  const plan = planEntitySprites({
    players: [{ id: 'p9', name: '坏坐标', x: Number.NaN, y: 1 }],
    wildlife: [{ id: 'w9', mobId: 'X', x: 1, y: Number.POSITIVE_INFINITY }],
  }, 'me');
  eq(plan.length, 0, '★ NaN / Infinity ⇒ 跳过(世界原点是一个看起来合法的错误位置)');
  const one = planEntitySprites({ wildlife: [{ id: 'w1', mobId: 'SLIME', x: 3, y: 4 }] }, 'me');
  eq(one.length, 1, '合法坐标照画');
  eq(one[0].z, 0, 'z 缺省 = 0(站在地面)');
  eq(one[0].label, 'SLIME', 'label 用 mobId');
  ok(one[0].heightPx > 0, '立牌高度来自 `spriteHeightPx`');
});

test('FND126-7 boot.ts 真的消费实体计划(注入验证:删掉调用点就判红)', () => {
  const hasWiring = (src: string): boolean => (
    src.includes('planEntitySprites(authority.state, authority.localPlayerId)')
    && src.includes('reconcileEntitySprites();')
    /* ⚠️ 见证片段必须**只属于实体池**:`scene.add(sp)` 在图集立牌那段也有(同名变量),
       拿它当见证会让"删掉实体池的 add"仍然通过 —— 注入验证就是这么抓到的。 */
    && src.includes('entitySprites.set(spec.key, sp)')
    && src.includes('entitySprites.delete(key)')
    && src.includes('entities: {')
  );
  ok(hasWiring(bootSrc), '计划 → 场景 / 移除 / 摘要三处都在');

  /* ── 注入验证:逐个删掉关键片段,检测器必须转假 ── */
  for (const victim of [
    'reconcileEntitySprites();',
    'planEntitySprites(authority.state, authority.localPlayerId)',
    'entitySprites.set(spec.key, sp)',
    'entitySprites.delete(key)',
    'entities: {',
  ]) {
    ok(!hasWiring(bootSrc.replace(victim, '')), `注入(删掉 \`${victim}\`)后判据必须转假`);
  }
});

/* ─────────────────────────── 8/9 死键:have + useItem ─────────────────────────── */

test('FND126-8 `CRAFT` 的 have 有真来源:回执增量落账 + 被拒不落账', () => {
  let have: HaveDetail = {};
  have = applyReceiptToHave(have, { action: 'BREAK_BLOCK', ok: true, effect: { objId: 101, gained: 2 } });
  eq(have, { 101: 2 }, '拆两块 ⇒ 101 记 2 件');
  have = applyReceiptToHave(have, { action: 'PICKUP_ITEM', ok: true, effect: { itemId: 102 } });
  eq(have, { 101: 2, 102: 1 }, '捡起 ⇒ +1');
  have = applyReceiptToHave(have, { action: 'CRAFT', ok: true, effect: { itemId: 351, produced: 1, consumed: { 101: 2 } } });
  eq(have, { 102: 1, 351: 1 }, '合成消耗 101 全部、产出 351(条目清空即删除)');
  /* ★ 负对照:被拒的回执不改账 */
  const before = have;
  have = applyReceiptToHave(have, { action: 'BREAK_BLOCK', ok: false, effect: { objId: 101, gained: 5 } });
  eq(have, before, '★ 负对照:`ok === false` 不落账(否则"被拒"看起来像"发生了")');
  eq(applyReceiptToHave(before, { action: 'DROP_ITEM', ok: true, effect: { itemId: 102, count: 1 } }),
    { 351: 1 }, '丢下 ⇒ 该件清零并删条目');
  eq(haveEntryCount(before), 2, '条目数可读(自检口径)');

  /* 入口判据:没有 have **一定**不发(这就是修前的死键形态) */
  const missing = craftRequest({ itemId: 351, have: undefined });
  eq(missing.ok, false, '★ `have` 缺省 ⇒ 构建器拒绝(修前 main.ts 恒给 undefined)');
  const okReq = craftRequest({ itemId: 351, have: before });
  eq(okReq.ok, true, '给了账本 ⇒ 参数成立');
  if (okReq.ok) eq(okReq.request.payload.have, before, '载荷里的 have 就是账本(拷贝)');
});

test('FND126-9 按 N / 按 T 真的发出报文(且缺端口时确实不发)', () => {
  const record = (): { sent: { action: string; [k: string]: unknown }[]; entry: ActionEntry } => {
    const sent: { action: string; [k: string]: unknown }[] = [];
    const entry = new ActionEntry({
      sendAction: (intent) => { sent.push(intent); return true; },
      canSend: () => true,
    });
    return { sent, entry };
  };

  /* ── 有端口(修后):N ⇒ CRAFT,T ⇒ USE_ITEM ── */
  const a = record();
  const have: HaveDetail = { 101: 2 };
  const wired = createActionBinding({
    entry: a.entry,
    inputs: {
      craft: () => ({ itemId: 351, have }),
      chestCell: () => ({ x: 1, y: 2 }),
      partyModeEcho: () => undefined,
      useItem: () => ({ itemId: 101 }),
    },
  });
  eq(wired.handleKey('n')?.sent, true, '★ 按 N 发出 CRAFT(修前恒 INVALID_INPUT)');
  eq(a.sent[0]?.action, 'CRAFT', '发的是 CRAFT');
  eq(a.sent[0]?.have, have, '载荷带上了 have 账本');
  eq(wired.handleKey('t')?.sent, true, '★ 按 T 发出 USE_ITEM(修前没有端口 ⇒ 永不发)');
  eq(a.sent[1]?.action, 'USE_ITEM', '发的是 USE_ITEM');
  eq(a.sent[1]?.itemId, 101, 'itemId 来自宿主给的来源');
  eq(a.sent.length, 2, '恰好两条(不串包)');

  /* ── 负对照(修前形态):不提供 useItem / have ── */
  const b = record();
  const noPort = createActionBinding({
    entry: b.entry,
    inputs: {
      craft: () => ({ itemId: 351, have: undefined }),
      chestCell: () => ({ x: 1, y: 2 }),
      partyModeEcho: () => undefined,
    },
  });
  eq(noPort.handleKey('t')?.sent, false, '★ 负对照:没有 `useItem` 端口 ⇒ 按 T 不发(修前就是这样)');
  eq(noPort.handleKey('n')?.sent, false, '★ 负对照:没有 `have` ⇒ 按 N 不发');
  eq(b.sent.length, 0, '一个字节都没写');
});

/* ─────────────────────────── 10 输入避让 ─────────────────────────── */

test('FND126-10 搜索态下动作键让路(空格/`e` 不再误发)', () => {
  const g = new ActionKeyGuard();
  g.setTextInput(false);
  eq(g.handles('e'), true, '不在打字 ⇒ `e` 照常拆墙');
  eq(g.blockedByTextInput('e'), false, '没被挡');
  g.setTextInput(true);
  eq(g.handles('e'), false, '★ 搜索框里打 `e` ⇒ 不发 BREAK_BLOCK');
  eq(g.handles('q'), false, '`q` 同理(放置)');
  eq(g.handles(' '), false, '空格同理(攻击)');
  eq(g.blockedByTextInput('e'), true, '原因可读:它是**被文本输入挡掉**的');
  eq(g.isActionKey('e'), true, '它仍是动作键(两种原因必须分得开)');
  eq(g.handles('i'), false, '非动作键也不处理(面板键归 boot)');
  eq(g.blockedByTextInput('i'), false, '但**不是**被文本输入挡的 ⇒ 两种原因不同形');

  /* 负对照(修前形态):只看动作表、不看输入态 ⇒ 对 `e` 仍然放行 */
  const naive = ACTION_KEYS['e'] !== undefined;
  eq(naive, true, '★ 负对照:修前那行 `ACTION_KEYS[key]` 在搜索态里照样会发');
  g.setTextInput(false);
  eq(g.blockedByTextInput('e'), false, '恢复后不再挡');
});

/* ─────────────────────────── 11/12 源码级接线 + 注入验证 ─────────────────────────── */

test('FND126-11 main.ts 接上了朝向 / 守卫 / 两个端口(注入验证:改回修前形态就判红)', () => {
  const wired = (src: string): boolean => (
    src.includes('facing = nextFacing({')
    && src.includes('keyGuard.setTextInput(handle.textInputActive())')
    && src.includes('keyGuard.handles(ev.key)')
    && src.includes('useItem: () => ({ itemId: lastItemId })')
    && src.includes('have: haveDetail')
    && src.includes("from './net/have_ledger.ts'")
    && !src.includes('const facing: Facing = { dx: 0, dy: 1 }')
    && !src.includes('have: undefined')
  );
  ok(wired(mainSrc), '朝向 / 守卫 / have / useItem 四处都真的接上,且修前那两行已消失');

  /* ── 注入验证:逐条改回修前形态,检测器必须转假 ── */
  const injections = [
    mainSrc.replace('facing = nextFacing({', 'void 0;'),
    mainSrc.replace('useItem: () => ({ itemId: lastItemId }),', ''),
    mainSrc.replace('have: haveDetail', 'have: undefined'),
    mainSrc.replace('keyGuard.handles(ev.key)', 'true'),
  ];
  for (const [i, injected] of injections.entries()) {
    ok(!wired(injected), `注入 #${i + 1} 后判据必须转假(证明这条断言有牙齿)`);
  }
});

test('FND126-12 boot.ts 开出 `textInputActive` 读数(注入验证:删掉就判红)', () => {
  const hasReader = (src: string): boolean => (
    src.includes('textInputActive: () => searchMode')
    && src.includes('textInputActive: () => boolean;')
  );
  ok(hasReader(bootSrc), 'BootHandle 声明 + 实现都在(`main.ts` 的守卫靠它)');
  ok(!hasReader(bootSrc.replace('textInputActive: () => searchMode,', '')),
    '注入(删掉实现)后判据必须转假');
  ok(!hasReader(bootSrc.replace('textInputActive: () => boolean;', '')),
    '注入(删掉声明)后判据必须转假');
});

/* ─────────────────────────── 13 全链一致性 ─────────────────────────── */

test('FND126-13 四个朝向给出四格不同目标(修前恒一格)', () => {
  const pos = { x: 20.25, y: 30.75 };
  const cells = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
  ].map((f) => cellInFront(pos, f));
  const uniq = new Set(cells.map((c) => `${c.x},${c.y}`));
  eq(uniq.size, 4, `四个朝向必须是四格不同(实际 ${[...uniq].join(' / ')})`);
  eq(cellInFront(pos, { dx: 0, dy: 0 }), { x: 20, y: 30 }, '零朝向退回脚下那格(不越界)');
});

report('WS-FND-126');