/**
 * WS-FND-22 —— **客户端的动作入口**(纯逻辑那一半)。
 *
 * ## 为什么把客户端判定单独一个套件
 *
 * `main.ts` 不可测(import 就要 `document`)。而"玩家按 Q 到底动了哪一格"
 * 是一个**会静默错**的判定:
 * ```
 * 客户端以为在放 A 格,服务端放的是 B 格 —— 两边都不报错,
 * 玩家只看到"东西没出现在我想的地方"。
 * ```
 * 所以把目标格、键位表、文案抽进 `client/src/net/action_target.ts`
 * (不碰 DOM),在这里逐条钉住。**两处最容易错的**:取整口径 与 键位表的动作名。
 *
 * ## 逐条的注入靶子
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | `cellUnder` 与**服务端**的取整口径一致(真世界里交叉验) | `Math.floor` 改成 `Math.round` |
 * | 2 | 四个朝向各只动一格 | `cellInFront` 的分支写反 |
 * | 3 | 斜着站时**只**取一格 | 两个分量都判(会得到"面前 2 格") |
 * | 4 | 键位表里的动作名**都是真的 `RoomAction`** | 名字打错(线上会变成 NOT_IMPLEMENTED) |
 * | 5 | 四种失败分类给出**不同**的话 | 文案塌成一个"操作失败" |
 * | 6 | 提示行由键位表生成(不手写第二份) | `keyHints` 硬编码 |
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';

import {
  ACTION_KEYS, FACING_DEFAULT, cellInFront, cellUnder, describeActionResult, inventoryLine, keyHints,
} from '../client/src/net/action_target.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { assemble } from '../server/src/index.ts';

/* ───────────────────────── 1 ───────────────────────── */

test('FND22-1 目标格取整口径与**服务端**一致(用真世界交叉验)', () => {
  /* 这条不是"自己测自己":客户端算出的格,拿去问**服务端的世界**
     要那一格的 obj —— 两边对同一对浮点坐标必须指向同一格。
     若客户端用 round、服务端用 floor,`12.5` 就会分叉(12 vs 13)。 */
  const a = assemble({
    roomId: 'r22', ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 48, mobs: false,
  });
  const mat = (a.host as unknown as {
    materials(): { blockAt(x: number, y: number): number; placeBlock(x: number, y: number, id: number): { ok: boolean } };
  }).materials();
  ok(mat.placeBlock(12, 12, 101).ok, '前置:在 (12,12) 放一个块');

  /* 四种落在同一格内的浮点坐标,客户端都应指向 (12,12)。 */
  for (const p of [{ x: 12.5, y: 12.5 }, { x: 12.0, y: 12.0 }, { x: 12.9, y: 12.1 }, { x: 12.01, y: 12.99 }]) {
    const c = cellUnder(p);
    ok(c.x === 12 && c.y === 12, `cellUnder(${p.x},${p.y}) 应落在 (12,12),实测 (${c.x},${c.y})`);
    eq(mat.blockAt(c.x, c.y), 101,
      `★ 客户端算出的格在**服务端**必须就是放块那格((${c.x},${c.y}) 实测 obj=${mat.blockAt(c.x, c.y)})`);
  }
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND22-2 四个朝向各只动一格,且缺省朝下', () => {
  const p = { x: 5.5, y: 5.5 };
  eq(cellInFront(p, { dx: 1, dy: 0 }).x, 6, '向右 ⇒ x+1');
  eq(cellInFront(p, { dx: -1, dy: 0 }).x, 4, '向左 ⇒ x-1');
  eq(cellInFront(p, { dx: 0, dy: 1 }).y, 6, '向下 ⇒ y+1');
  eq(cellInFront(p, { dx: 0, dy: 0 }).y, 5, '零向量不应乱走(退回脚下那格)');
  /* 缺省朝向是"向下":键按下时若还不知道运动方向,应该有个确定的行为。 */
  eq(cellInFront(p).y, FACING_DEFAULT.dy > 0 ? 6 : 5, '缺省朝向应与 FACING_DEFAULT 一致');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND22-3 斜着站时只取一格(不能同时动两格)', () => {
  /* 若实现成"两个分量各判一次",玩家按一次会作用在两格上 ——
     表现是"点一下放了两下",而服务端会照做(它只看收到几条)。 */
  const p = { x: 5.5, y: 5.5 };
  const diag = cellInFront(p, { dx: 1, dy: 1 });
  const manhattan = Math.abs(diag.x - 5) + Math.abs(diag.y - 5);
  eq(manhattan, 1, `斜向应按曼哈顿距离 1 取格(实测 ${JSON.stringify(diag)})`);
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND22-4 键位表里的动作名都是**真的** RoomAction(打错会静默变成"还没做")', () => {
  /* ⚠️ 这条最值钱:客户端发的是**字符串**。名字打错时服务端会回
     `NOT_IMPLEMENTED`(那是有执行层的动作也会走的兜底)→ 玩家看到"这一版还没做",
     而真相是"客户端拼错了"。类型层救不了(线上就是字符串),所以在这里钉。 */
  const names = new Set(Object.values(RoomAction) as unknown as string[]);
  const keys = Object.keys(ACTION_KEYS);
  ok(keys.length >= 4, `键位表至少要有 4 个动作(实测 ${keys.length})`);
  for (const k of keys) {
    const spec = ACTION_KEYS[k]!;
    ok(names.has(spec.action), `★ 键 ${k} 的动作名 "${spec.action}" 必须是 RoomAction 之一`);
    eq(spec.target === 'front' || spec.target === 'under', true, `键 ${k} 的目标格取法必须明示`);
    ok(spec.label.length > 0, `键 ${k} 必须有人能读的提示`);
  }
  /* 四个动作各不相同(复制粘贴最容易出这种错)。 */
  const acts = keys.map((k) => ACTION_KEYS[k]!.action);
  eq(new Set(acts).size, acts.length, '★ 两个键不能映射到同一个动作');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND22-5 四种失败分类给出**不同**的话(不能塌成一句"操作失败")', () => {
  const base = { ok: false, action: 'PLACE_BLOCK' };
  const perm = describeActionResult({ ...base, kind: 'PERMISSION' });
  const invalid = describeActionResult({ ...base, kind: 'INVALID', reason: '那一格已经有东西了' });
  const notImpl = describeActionResult({ ...base, kind: 'NOT_IMPLEMENTED' });
  const closed = describeActionResult({ ...base, kind: 'ROOM_CLOSED' });
  eq(new Set([perm, invalid, notImpl, closed]).size, 4, '★ 四种分类必须是四句不同的话');
  ok(invalid.includes('那一格已经有东西了'), 'INVALID 要把服务端给的理由带出来(那是可操作的)');
  ok(perm.includes('权限'), 'PERMISSION 说的必须是"权限",不是"那儿做不了"');
  ok(describeActionResult({ ok: true, kind: 'OK', action: 'PLACE_BLOCK' }).includes('✓'), '成功要有成功的样子');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND22-6 提示行由键位表生成(不手写第二份)', () => {
  const hints = keyHints();
  for (const k of Object.keys(ACTION_KEYS)) {
    ok(hints.includes(k.toUpperCase()), `提示行应含键 ${k.toUpperCase()}(实测「${hints}」)`);
  }
  ok(hints.includes(ACTION_KEYS.q!.label), '提示行应含键位表里的原文(两侧不同源就会漂)');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND22-7 背包行只报**总量**(快照里没有明细,不假装有)', () => {
  eq(inventoryLine(null, null), '背包 (未知)', '拿不到就说不知道');
  eq(inventoryLine(3, null), '背包 3 件', '只有总量时也要能显示');
  eq(inventoryLine(3, 8), '背包 3/8 件', '有容量时显示 总量/容量');
});

report('WS-FND-22-client-actions');
