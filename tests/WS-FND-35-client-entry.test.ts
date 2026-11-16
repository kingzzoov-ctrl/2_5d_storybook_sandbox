/**
 * WS-FND-35 —— **客户端的动作入口层**(让"服务端能跑"变成"玩家能感知")。
 *
 * ## 为什么单独一个套件
 *
 * `WS-FND-22` 钉的是**目标格 / 键位表 / 回执文案**(建造·拆·丢·捡那四个动作)。
 * 本套件钉的是**另外五个已经接线的动作的入口**:
 * ```
 * CRAFT / SLEEP / OPEN_CHEST / USE_OWN_CHEST / START_PARTY
 * ```
 * 接线之前它们的状态是:服务端有执行层、有自己的回执、有 `WS-FND-25/26/27/28`
 * 的 60+ 条断言,而客户端**零调用点** —— 表现就是"服务端能跑、玩家按了没反应"。
 *
 * ## 逐条判据与"改坏哪里会红"
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 五个动作各产出**逐字正确**的 `{ action, payload }` | 载荷键名写错(`cellX`)、漏 `payload`、动作名拼错 |
 * | 2 | 产出的动作名都是**真的** `RoomAction` | 拼成 `CRAFTING`(线上会变 `NOT_IMPLEMENTED`) |
 * | 3 | 非法输入 ⇒ 拒绝并且**一个字节都不发** | 把守卫写成"给个默认值"(缺 itemId 时发 0) |
 * | 4 | 非 OK 回执 ⇒ 四种分类**四句话**(不静默) | 塌成一句"操作失败",或 `onActionResult` 空实现 |
 * | 5 | 未连接 / 未握手 / 链路没写进去 ⇒ 不发,且有明确分支 | `canSend` 恒 `true`,或只判 socket 不判握手 |
 * | 6 | 重复触发**不串包**(载荷是新对象;回执按 `action` 归位) | 复用一个模块级 payload 对象 |
 * | 7 | 绑定层在**无 DOM** 环境可被驱动 | `attachKeyboard` 直接引用 `window`/`document` |
 * | 8 | 键位表与既有键位**不重叠**,提示行由表生成 | 用 `e`/`q` 撞上既有键(一次按键两件事) |
 *
 * ⚠️ 本套件的期望值**一律写字面量**,右侧不写被测模块自己导出的常量
 *   (`--strict-taut` 的口径;同义反复的断言等于没有断言)。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';

import {
  ActionEntry,
  craftRequest,
  describeEntryReceipt,
  openChestRequest,
  sleepRequest,
  startPartyRequest,
  useOwnChestRequest,
  type ActionPorts,
} from '../client/src/net/action_entry.ts';
import {
  ENTRY_KEYS,
  createActionBinding,
  entryKeyHints,
  sessionPorts,
} from '../client/src/net/action_binding.ts';
import { RoomAction } from '../server/src/net/room.ts';

/* ═══════════════════════════ 夹具:记录式端口(不碰 socket) ═══════════════════════════ */

interface WireIntent { action: string; [k: string]: unknown }

interface Recorder {
  ports: ActionPorts;
  /** 真的被递出去的 intent(**保留引用** —— 第 6 条判据要靠它看"是不是同一个对象")。 */
  sent: WireIntent[];
  state: { live: boolean; accept: boolean };
}

/**
 * 一个**不碰网络**的端口替身。
 *
 * `accept === false` 模拟 `SessionHandle.sendAction` 在 socket 未开时返回 `false`
 * —— 那**不是**成功,入口不许假装成功。
 */
function recorder(opts: { live?: boolean } = {}): Recorder {
  const sent: WireIntent[] = [];
  const state = { live: opts.live ?? true, accept: true };
  const ports: ActionPorts = {
    sendAction: (intent: WireIntent): boolean => {
      if (!state.accept) return false;
      sent.push(intent);
      return true;
    },
    canSend: (): boolean => state.live,
  };
  return { ports, sent, state };
}

/* ═══════════════════════════ 1 ═══════════════════════════ */

test('FND35-1 五个动作产出**逐字正确**的 { action, payload }', () => {
  /* 期望值全是**字面量**:载荷键名取自服务端 `ActionPayload`
     (`x`/`y`/`itemId`/`count`),动作名取自 `RoomAction`。
     若这里写成 `eq(r.request.action, someImportedConst)`,那这条断言什么都不防。 */
  eq(
    craftRequest({ itemId: 151, have: { 151: 2 } }),
    { ok: true, request: { action: 'CRAFT', payload: { itemId: 151, have: { 151: 2 } } } },
    'CRAFT 的载荷是 { itemId, have }(服务端 craft.ts 的两个键)',
  );
  eq(
    sleepRequest(),
    { ok: true, request: { action: 'SLEEP', payload: {} } },
    'SLEEP 没有参数 ⇒ 空载荷(`ActionPayload` 对它没有字段)',
  );
  eq(
    openChestRequest({ x: 3, y: 4 }),
    { ok: true, request: { action: 'OPEN_CHEST', payload: { x: 3, y: 4 } } },
    '只给坐标 = **只打开看**(服务端 runChestAction 的 itemId===null 分支)',
  );
  eq(
    openChestRequest({ x: 3, y: 4, itemId: 513, count: 2 }),
    { ok: true, request: { action: 'OPEN_CHEST', payload: { x: 3, y: 4, itemId: 513, count: 2 } } },
    'OPEN_CHEST 带物品时是 { x, y, itemId, count }(count 正 = 存入)',
  );
  eq(
    useOwnChestRequest({ x: 7, y: 8, itemId: 9, count: -1 }),
    { ok: true, request: { action: 'USE_OWN_CHEST', payload: { x: 7, y: 8, itemId: 9, count: -1 } } },
    'USE_OWN_CHEST 与 OPEN_CHEST 只差动作名;count 负 = 取出',
  );
  eq(
    startPartyRequest(),
    { ok: true, request: { action: 'START_PARTY', payload: {} } },
    'START_PARTY 不给模式回声 ⇒ 不带那个键(服务端"给了才比")',
  );
  eq(
    startPartyRequest({ partyMode: 'BRIDGE_CTF' }),
    { ok: true, request: { action: 'START_PARTY', payload: { partyMode: 'BRIDGE_CTF' } } },
    'START_PARTY 带模式回声时原样带上(它只是核对,不设模式)',
  );
});

/* ═══════════════════════════ 2 ═══════════════════════════ */

test('FND35-2 产出的动作名都是**真的** RoomAction(拼错会静默变成"还没做")', () => {
  /* ⚠️ 这条最值钱:线上是**字符串**。名字打错时服务端会回 `NOT_IMPLEMENTED`
     ("这一版还没做"),而真相是"客户端拼错了" —— 类型层救不了。
     ⇒ 拿**服务端那张表**做交叉核对(不是拿我自己的常量对账)。 */
  const built = [
    craftRequest({ itemId: 151, have: {} }),
    sleepRequest(),
    openChestRequest({ x: 0, y: 0 }),
    useOwnChestRequest({ x: 0, y: 0 }),
    startPartyRequest(),
  ].map((r) => (r.ok ? r.request.action : '构建失败'));
  eq(built, ['CRAFT', 'SLEEP', 'OPEN_CHEST', 'USE_OWN_CHEST', 'START_PARTY'], '五个构建器产出的动作名');

  const known = new Set<string>(Object.values(RoomAction) as unknown as string[]);
  for (const name of built) {
    ok(known.has(name), `★ 动作名 "${name}" 必须是 server/src/net/room.ts 的 RoomAction 之一`);
  }
});

/* ═══════════════════════════ 3 ═══════════════════════════ */

test('FND35-3 非法输入 ⇒ 入口拒绝并且**一个字节都不发**', () => {
  const r = recorder();
  const entry = new ActionEntry(r.ports);

  const noItem = entry.craft({ have: { 151: 1 } });
  eq(noItem.sent, false, '缺 itemId ⇒ 不发');
  eq(noItem.code, 'INVALID_INPUT', '缺 itemId 的分类是"参数不对",不是"未连接"');
  ok(noItem.status.length > 0, '★ 拒绝必须有话说(否则就是静默)');

  const noHave = entry.craft({ itemId: 151 });
  eq(noHave.sent, false, '缺 have(背包明细)⇒ 不发 —— 服务端没有明细读口,发了也是 INVALID');

  const noX = entry.openChest({ y: 4 });
  eq(noX.sent, false, '缺 x ⇒ 不发');

  const noCell = entry.useOwnChest({});
  eq(noCell.sent, false, 'x/y 全缺 ⇒ 不发');

  const countNoItem = entry.openChest({ x: 3, y: 4, count: 2 });
  eq(countNoItem.sent, false, '★ 给了 count 却没给 itemId ⇒ 不发(否则服务端只"打开看"并静默忽略 count)');

  const badId = entry.openChest({ x: 3, y: 4, itemId: 2.5 });
  eq(badId.sent, false, 'itemId 非整数 ⇒ 不发');

  const zeroCount = entry.useOwnChest({ x: 1, y: 1, itemId: 5, count: 0 });
  eq(zeroCount.sent, false, 'count === 0 ⇒ 不发(服务端判非零整数)');

  const badEcho = entry.startParty({ partyMode: 3 });
  eq(badEcho.sent, false, 'partyMode 给了但不是字符串 ⇒ 不发(回声必须是模式名)');

  eq(r.sent.length, 0, '★ 九次非法触发,一条报文都不该被递出去');
  eq(entry.sentCount, 0, '入口自己的"发出计数"也必须是 0');
});

/* ═══════════════════════════ 4 ═══════════════════════════ */

test('FND35-4 非 OK 回执 ⇒ 四种分类**四句话**(不静默)', () => {
  const perm = describeEntryReceipt({ action: 'OPEN_CHEST', ok: false, kind: 'PERMISSION' });
  const invalid = describeEntryReceipt({
    action: 'SLEEP', ok: false, kind: 'INVALID', reason: '只有站在卧室(COZY_BEDROOM)里才能睡觉',
  });
  const notImpl = describeEntryReceipt({ action: 'START_PARTY', ok: false, kind: 'NOT_IMPLEMENTED' });
  const closed = describeEntryReceipt({ action: 'CRAFT', ok: false, kind: 'ROOM_CLOSED' });

  eq(new Set([perm, invalid, notImpl, closed]).size, 4, '★ 四种分类必须是四句不同的话');
  ok(perm.includes('权限'), 'PERMISSION 说的必须是"权限"(不是"那儿做不了")');
  ok(invalid.includes('COZY_BEDROOM'), 'INVALID 要把服务端给的理由带出来 —— 那是可操作的信息');
  ok(closed.includes('房间已关闭'), 'ROOM_CLOSED 要说得出来');
  ok(notImpl.includes('执行层'), 'NOT_IMPLEMENTED 与 PERMISSION 必须是两件事');
  ok(perm.includes('开公共箱'), '★ 文案要带**动作名**:四个动作被拒时分不清是哪一条,等于没提示');

  const okLine = describeEntryReceipt({
    action: 'CRAFT', ok: true, kind: 'OK', effect: { itemId: 151, produced: 2 },
  });
  ok(okLine.includes('✓'), '成功的回执要有成功的样子');
  ok(okLine.includes('produced=2'), '成功回执要把 effect 带出来(否则玩家看不出产生了什么)');

  /* 再经 `ActionEntry` 走一遍:回执必须**改掉**入口的状态(空实现会红在这里)。 */
  const r = recorder();
  const entry = new ActionEntry(r.ports);
  const before = entry.status;
  entry.onActionResult({ action: 'SLEEP', ok: false, kind: 'PERMISSION' });
  ok(entry.status !== before, '★ 回执必须换掉状态行 —— 不换 = 玩家看不到"被拒"');
  ok(entry.status.includes('睡觉'), '状态行按报文自带的 action 归位(这条是 SLEEP 的回执)');
});

/* ═══════════════════════════ 5 ═══════════════════════════ */

test('FND35-5 未连接 / 握手未完成 ⇒ 不发(明确分支,不猜)', () => {
  const r = recorder({ live: false });
  const entry = new ActionEntry(r.ports);

  const offline = entry.sleep();
  eq(offline.sent, false, '未连接 ⇒ 不发');
  eq(offline.code, 'NOT_CONNECTED', '分类必须与"参数不对"分开(两种失败两种修法)');
  ok(offline.status.includes('未连接'), '未连接要有可读分支');
  eq(r.sent.length, 0, '未连接时 sendAction 一次都不该被调用');

  r.state.live = true;
  const online = entry.sleep();
  eq(online.sent, true, '握手完成后同一个入口就该发得出去');
  eq(r.sent.length, 1, '发出去恰好一条(不是两条,也不是零条)');

  /* 链路没写进去(socket 未开)⇒ 同样不是成功。 */
  r.state.accept = false;
  const refused = entry.openChest({ x: 1, y: 2 });
  eq(refused.sent, false, 'sendAction 返回 false ⇒ 不许当成成功');
  eq(refused.code, 'NOT_CONNECTED', '链路没写进去归到"没发"这一支');
});

/* ═══════════════════════════ 5b ═══════════════════════════ */

test('FND35-5b sessionPorts 的 canSend 判的是**握手完成**(不是"socket 开着")', () => {
  /* 服务端的 `onAction` 对 `helloDone === false` 的报文是**丢弃**的(连回执都没有)
     ⇒ 握手没完成就放行 = "发了等于没发",而且**两边都不报错**。 */
  const calls: WireIntent[] = [];
  const fake = {
    state: 'connecting',
    sendAction: (intent: WireIntent): boolean => { calls.push(intent); return true; },
  };
  const ports = sessionPorts(() => fake);

  eq(ports.canSend(), false, 'connecting(还没收到 welcome)⇒ 不许发');
  fake.state = 'live';
  eq(ports.canSend(), true, 'live(= welcome 已到)⇒ 允许发');
  eq(sessionPorts(() => null).canSend(), false, '没有会话(单机模式)⇒ 不许发');

  const entry = new ActionEntry(sessionPorts(() => fake));
  const out = entry.startParty();
  eq(out.sent, true, 'live 会话 ⇒ 真的走 sendAction');
  eq(calls[0]?.action, 'START_PARTY', '递出去的 intent 上带着动作名');
});

/* ═══════════════════════════ 6 ═══════════════════════════ */

test('FND35-6 重复触发**不串包**(载荷每次都是新对象;回执按 action 归位)', () => {
  const r = recorder();
  const entry = new ActionEntry(r.ports);

  const first = entry.craft({ itemId: 151, have: { 151: 2 } });
  const second = entry.craft({ itemId: 152, have: { 152: 1 } });

  eq(r.sent.length, 2, '两次触发 = 两条独立报文(不合并、不复用)');
  ok(r.sent[0] !== r.sent[1], '★ 两条 intent 必须是**不同对象** —— 共享一个缓冲就会串包');
  eq(r.sent[0]?.itemId, 151, '★ 第二条触发不该改到第一条的载荷');
  eq(r.sent[1]?.itemId, 152, '第二条载荷是它自己的');
  eq(r.sent[0]?.action, 'CRAFT', '动作名在铺平之后仍在');
  ok(
    !Object.prototype.hasOwnProperty.call(r.sent[0], 'payload'),
    '★ 线上是**扁平**的一层:不能把整个 payload 塞进一个字段(服务端按 ctx.payload.x 读)',
  );
  eq(first.request?.payload, { itemId: 151, have: { 151: 2 } }, '第一条的请求快照不随后续触发改变');
  eq(entry.sentCount, 2, '发出计数可被自检读到');

  /* 回执按报文自带的 `action` 归位 —— 不按"谁最后发的"猜。 */
  const line = entry.onActionResult({ action: 'SLEEP', ok: false, kind: 'PERMISSION' });
  ok(line.includes('睡觉'), '这条回执说的是 SLEEP(即便最后发出去的是 CRAFT)');
});

/* ═══════════════════════════ 7 ═══════════════════════════ */

test('FND35-7 绑定层在**无 DOM** 环境可被驱动(假 window 也一样跑)', () => {
  /* 只用 `KeyEventTarget` 的**结构**:addEventListener / removeEventListener。
     ⇒ 测试里不需要 jsdom,也不需要 `document`。(若绑定层直接引用 `window`,
        这条会在 import 或调用时抛 —— 那正是要拦的形态。) */
  const handlers: ((ev: { key: string; preventDefault(): void }) => void)[] = [];
  const target = {
    addEventListener: (_type: 'keydown', fn: (ev: { key: string; preventDefault(): void }) => void): void => {
      handlers.push(fn);
    },
    removeEventListener: (_type: 'keydown', fn: (ev: { key: string; preventDefault(): void }) => void): void => {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  /** 派发一次 keydown;返回值 = `preventDefault()` 被调了几次。 */
  const fire = (key: string): number => {
    let prevented = 0;
    for (const h of [...handlers]) h({ key, preventDefault: () => { prevented += 1; } });
    return prevented;
  };

  const r = recorder();
  const entry = new ActionEntry(r.ports);
  const binding = createActionBinding({
    entry,
    inputs: {
      craft: () => ({ itemId: 151, have: { 151: 2 } }),
      chestCell: () => ({ x: 3, y: 4 }),
      partyModeEcho: () => undefined,
    },
  });

  const detach = binding.attachKeyboard(target);
  eq(handlers.length, 1, '挂上一个 keydown 监听');

  eq(fire('k'), 1, '认识的键且**真的发了** ⇒ 吞掉默认行为');
  eq(r.sent[0]?.action, 'SLEEP', '按 K ⇒ SLEEP');
  eq(fire('?'), 0, '不认识的键:既不吞默认行为,也不发');
  eq(r.sent.length, 1, '不认识的键不该多发一条');

  eq(binding.handleKey('q'), null, '★ 既有键位表(ACTION_KEYS)的键不属于本层 ⇒ 交回别的监听器');

  const opened = binding.handleKey('o');
  eq(opened?.request?.payload, { x: 3, y: 4 }, '按 O ⇒ 用宿主给的格子发 OPEN_CHEST');
  eq(r.sent[1]?.action, 'OPEN_CHEST', '递出去的是 OPEN_CHEST');

  /* 按钮路径与键盘路径**同一条路**:参数由调用方显式给。 */
  const button = binding.trigger('craft', { craft: { itemId: 900, have: { 900: 1 } } });
  eq(button.request?.payload, { itemId: 900, have: { 900: 1 } }, '按钮路径给的参数原样进载荷');

  detach();
  eq(handlers.length, 0, '解绑后不再有监听(不留悬空回调)');
  eq(fire('k'), 0, '解绑后再按也不该有反应');
});

/* ═══════════════════════════ 8 ═══════════════════════════ */

test('FND35-8 键位表与既有键位**不重叠**,提示行由表生成', () => {
  /* 撞键的后果:一次按键同时触发两件事,而**两边都不报错**。
     `q/e/g/f` 是 `net/action_target.ts` 的 ACTION_KEYS(那里已有 WS-FND-22 钉着),
     这里用**字面量**再钉一次"本层不许用它们"。 */
  const taken = ['q', 'e', 'g', 'f'];
  for (const k of Object.keys(ENTRY_KEYS)) {
    ok(!taken.includes(k), `键 "${k}" 不能与既有动作键重叠(会一次触发两件事)`);
  }
  eq(Object.keys(ENTRY_KEYS).length, 5, '五个动作各一个键');
  eq(
    new Set(Object.values(ENTRY_KEYS).map((s) => s.slot)).size,
    5,
    '两个键不能映射到同一个槽位(复制粘贴最容易出这种错)',
  );

  const hints = entryKeyHints();
  eq(
    hints,
    'N 合成 · K 睡觉 · O 开公共储物箱 · U 开自己的储物箱 · V 派对开局',
    '提示行原文(由 ENTRY_KEYS 生成,不手写第二份)',
  );
  for (const k of Object.keys(ENTRY_KEYS)) {
    ok(hints.includes(k.toUpperCase()), `提示行应含键 ${k.toUpperCase()}`);
  }
});

report('WS-FND-35-client-entry');