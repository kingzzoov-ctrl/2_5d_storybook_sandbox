/**
 * WS-FND-138 —— **客户端入口平权**:服务端已实现的动作,玩家必须按得到。
 *
 * ## 修的是什么(第十轮实测 P1,四条)
 *
 * | # | 缺陷(修前) | 本套件钉住的性质 |
 * |---|------------|------------------|
 * | 1 | `BREED_TAME` / `BUY_ITEM` / `USE_ALCHEMY_FURNACE` / `PLACE_AUTOMATION` 服务端有执行层、客户端**零入口** | 按 `1`/`2`/`3`/`4` **真的发出对应报文**(用假 socket 捕获),且动作名都在服务端 `RoomAction` 里 |
 * | 2 | 背包拖拽**纯本地视觉**(`drop()` 只改 `slotItemIds`,不发任何报文) | 口径常量 `DRAG_UPLINK = 'local-only'` + 文案如实标出「本地整理视图」+ `boot.ts` 里**没有任何上行调用** |
 * | 3 | `lastItemId` 前置让新玩家第一步就卡住(提示只说"先按 E 拆一块或按 F 捡一件") | 提示把**缺什么 / 怎么拿到 / 之后哪些键才通**三件事一次说清;手册同样写明;旧文案**逐字消失** |
 * | 4 | 空格**同时**攻击与锁存跳跃,手册与提示条都没写 | 提示条(`client/index.html`)与手册(`PLAY.md`)**都**点名这条"一键两义";而跳跃末端为空这件事也如实写明 |
 *
 * 另外两条同批的文档缺陷(第 5/6 条)也在这里被钉住:
 * ```
 * 5 PLAY.md 说「WASD 同时平移相机…是巧合」—— 代码早已改成相机跟随权威位置、键盘平移已删
 * 6 PLAY.md 内部数字不一致(「22 个动作」vs「23 个 RoomAction 中 21 已接线」)
 *   ⇒ 实测是 24 个 RoomAction / 22 个已接线(见下面 FND138-2 的交叉核对)
 * ```
 *
 * ## 判据的形状(为什么这么写)
 *
 * ```
 * 入口键 → 报文   : 假 socket(**经生产的 sessionPorts 适配器**)捕获,逐字段对账
 * 键位表         : 两张表(ENTRY_KEYS / HOTBAR_KEYS)都要与既有键组**互不重叠**,
 *                  且 HOTBAR_KEYS 不改动 ENTRY_KEYS 的条数(别的套件钉着那六条)
 * 台账           : CLIENT_ENTRY_LEDGER 逐键覆盖 RoomAction(新增动作不裁决 ⇒ 红),
 *                  并逐条与**真源码**对账(wired 有见证 / missing 零出现)
 * 负对照 + 注入  : 每条判据都配一个"被改坏的样本",证明它会红(见 FND138-2/5/8/9/10/11/12)
 * ```
 *
 * 运行:`node tests/WS-FND-138-client-entry-parity.test.ts`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';

import {
  ActionEntry,
  CLIENT_TAME_OPS,
  breedTameRequest,
  buyItemRequest,
  placeAutomationRequest,
  useAlchemyFurnaceRequest,
} from '../client/src/net/action_entry.ts';
import {
  ENTRY_KEYS,
  HOTBAR_KEYS,
  createActionBinding,
  entryKeyHints,
  hotbarKeyHints,
  sessionPorts,
  type EntryInputs,
  type SessionLike,
} from '../client/src/net/action_binding.ts';
import { keyCollisions, keyGroups, keyGroupsExclusive } from '../client/src/ui/panel_keys.ts';
import { DRAG_UPLINK } from '../client/src/ui/inventory.ts';
import {
  CLIENT_ENTRY_GAPS,
  CLIENT_ENTRY_LEDGER,
  ClientEntryStatus,
  clientEntryRow,
  clientEntryWitnessOf,
  validateClientEntryLedger,
  type ClientEntryRow,
} from '../client/src/wiring_ledger.ts';

/* 服务端那两张**真表** —— 交叉核对用(客户端不许自说自话) */
import { RoomAction } from '../server/src/net/room.ts';
import { TameOp } from '../server/src/net/actions/breed_tame.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 去掉注释(**保留字符串字面量**)。
 *
 * 为什么必须剥:这一轮的注释里逐字写着**修前**的话(「先按 E 拆一块或按 F 捡一件」、
 * 「WASD 同时在平移相机…那是巧合」)。不剥的话,"改好了"与"只在注释里写了"完全同形。
 * 口径与 `WS-FND-126` 的那份一致(`//` 前面排除 `:` —— 否则 `ws://` 会被当成注释)。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

interface CodeFile {
  /** 仓库相对路径 */
  path: string;
  /** **已剥注释**的代码 */
  code: string;
}

/** `client/src/**\/*.ts` 的代码(剥注释) */
function clientCode(): CodeFile[] {
  const out: CodeFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.ts')) {
        out.push({ path: full.slice(ROOT.length + 1).split('\\').join('/'), code: stripComments(readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(join(ROOT, 'client', 'src'));
  return out;
}

/** 见证片段是否出现在**客户端代码**里(可排除台账自己 —— 否则它恒命中) */
function codeHas(files: readonly CodeFile[], witness: string, exclude?: string): boolean {
  if (witness === '') return false;
  return files.some((f) => f.path !== exclude && f.code.includes(witness));
}

type WireIntent = { action: string; [k: string]: unknown };

interface FakeSocket {
  session: SessionLike;
  /** 真的被递出去的报文(逐条断言用) */
  sent: WireIntent[];
  /** 连接态(**手改**它来验"握手未完成"分支) */
  link: { state: string; accept: boolean };
}

/**
 * **假 socket** —— 「入口键 → 真的发出报文」这句话的唯一证据来源。
 *
 * 它实现 `SessionLike` 的**结构**(`state` + `sendAction`),由**生产的**
 * `sessionPorts()` 适配进入口 ⇒ 被测的是生产那段判定,不是测试里的替身逻辑。
 * `accept === false` 模拟"链路没写进去"(socket 未开)。
 */
function fakeSocket(opts: { state?: string; accept?: boolean } = {}): FakeSocket {
  const link = { state: opts.state ?? 'live', accept: opts.accept ?? true };
  const sent: WireIntent[] = [];
  const session: SessionLike = {
    get state(): string { return link.state; },
    sendAction: (intent: WireIntent): boolean => {
      if (!link.accept) return false;
      sent.push(intent);
      return true;
    },
  };
  return { session, sent, link };
}

/** 宿主(`main.ts`)给得出来的参数 —— 与生产里那四个 provider 逐字段同形。 */
const HOST_INPUTS: EntryInputs = {
  craft: () => ({ itemId: 151, have: { 151: 2 } }),
  chestCell: () => ({ x: 3, y: 4 }),
  partyModeEcho: () => 'BRIDGE_CTF',
  useItem: () => ({ itemId: 151 }),
  breedTame: () => ({ op: 'FEED', petId: 'mob_boar#3', mobId: 'mob_boar', itemId: 201 }),
  buyItem: () => ({ itemId: 151, qty: 1 }),
  useAlchemyFurnace: () => ({ itemId: 151 }),
  placeAutomation: () => ({ x: 5, y: 6, itemId: 151 }),
};

const mk = (sock: FakeSocket, inputs: EntryInputs = HOST_INPUTS): ReturnType<typeof createActionBinding> =>
  createActionBinding({ entry: new ActionEntry(sessionPorts(() => sock.session)), inputs });

/* ═══════════════════════════ 1 ═══════════════════════════ */

test('FND138-1 ★ 入口键 → 真的发出报文(1/2/3/4 经 sessionPorts 进假 socket)', () => {
  const sock = fakeSocket();
  const binding = mk(sock);

  const outs = ['1', '2', '3', '4'].map((k) => binding.handleKey(k));
  eq(outs.map((o) => o?.sent), [true, true, true, true], '四个热键都必须**真的发出去**(不是"按了没反应")');
  eq(sock.sent.length, 4, '假 socket 上恰好多出四条报文');
  eq(binding.entry.sentCount, 4, '入口自己的发出计数也必须是 4(它是自检口径)');

  /* ★ 逐字段对账:线上是**扁平**的一层(没有 `payload`、动作名在展开之后) */
  eq(sock.sent, [
    { op: 'FEED', petId: 'mob_boar#3', mobId: 'mob_boar', itemId: 201, action: 'BREED_TAME' },
    { itemId: 151, qty: 1, action: 'BUY_ITEM' },
    { itemId: 151, action: 'USE_ALCHEMY_FURNACE' },
    { x: 5, y: 6, itemId: 151, action: 'PLACE_AUTOMATION' },
  ], '四条报文的键集合与取值都必须逐字正确(键多了/少了都会被这条抓住)');

  for (const got of sock.sent) {
    ok(!Object.prototype.hasOwnProperty.call(got, 'payload'), '★ 线上是扁平一层:不许出现 payload 这个键');
  }
  ok(binding.handleKey('n')?.sent === true, '既有字母表那条路**没有被新表挤掉**(按 N 仍发 CRAFT)');
});

/* ═══════════════════════════ 2 ═══════════════════════════ */

test('FND138-2 键位表:数字热键与既有键组互不重叠,且**没动** ENTRY_KEYS 的六条', () => {
  eq(Object.keys(HOTBAR_KEYS), ['1', '2', '3', '4'], '数字热键恰好是 1/2/3/4');
  eq(Object.keys(ENTRY_KEYS).length, 6, '★ 既有字母表仍是六个槽位(别的套件钉着它 —— 分表就是为了不动它)');
  eq(Object.values(HOTBAR_KEYS).map((s) => s.slot), ['breedTame', 'buyItem', 'useAlchemyFurnace', 'placeAutomation'], '四个键各映射到一个新槽位');
  eq(Object.keys(ENTRY_KEYS).filter((k) => Object.keys(HOTBAR_KEYS).includes(k)), [], '两张表之间不许有同名键');

  ok(keyGroupsExclusive(), 'keyGroups() 里必须**包含**数字热键组,且全局无冲突');
  eq(keyCollisions(), [], '冲突清单为空');
  const hot = keyGroups().find((g) => g.name.includes('HOTBAR_KEYS'));
  ok(hot !== undefined, '★ 数字热键必须进 keyGroups(不进就等于"没人核对它")');
  eq(hot?.keys, ['1', '2', '3', '4'], '进判据的正是 1/2/3/4');
  eq(hotbarKeyHints(), '1 驯养(投喂/驯服/繁殖/牧场) · 2 购买 · 3 炼金台 · 4 放自动化件/播种',
    '热键提示行由表生成(不手写第二份)');
  ok(!entryKeyHints().includes('1 '), '字母表那行不含数字键(两行各说各的)');

  /* ── 注入验证:把数字键换成已占用的 `t` ⇒ 检测器必须报红 ── */
  const broken = keyGroups().map((g) =>
    (g.name.includes('HOTBAR_KEYS') ? { name: g.name, keys: ['t'] } : g));
  const hits = keyCollisions(broken);
  eq(hits.length, 1, `注入后必须恰好一条冲突(实际 ${hits.length})`);
  eq(hits[0]?.key, 't', '报出来的正是被撞的那个键');
  ok(hits[0]?.groups.some((g) => g.includes('ENTRY_KEYS')), '冲突两侧都点了名(ENTRY_KEYS)');
  eq(keyGroupsExclusive(broken), false, '注入后总判据转假 ⇒ 这条断言有牙齿');
});

/* ═══════════════════════════ 3 ═══════════════════════════ */

test('FND138-3 动作名与 op 取值都与**服务端真表**对账(客户端不许自说自话)', () => {
  const known = new Set<string>(Object.values(RoomAction) as unknown as string[]);
  const built = [
    breedTameRequest({ op: 'FEED', petId: 'p#1', itemId: 201 }),
    buyItemRequest({ itemId: 151, qty: 1 }),
    useAlchemyFurnaceRequest({ itemId: 151 }),
    placeAutomationRequest({ x: 1, y: 2, itemId: 151 }),
  ].map((r) => (r.ok ? r.request.action : '构建失败'));
  eq(built, ['BREED_TAME', 'BUY_ITEM', 'USE_ALCHEMY_FURNACE', 'PLACE_AUTOMATION'], '四个构建器产出的动作名');
  for (const name of built) {
    ok(known.has(name), `★ ${name} 必须是 server/src/net/room.ts 的 RoomAction 之一(拼错会静默变 NOT_IMPLEMENTED)`);
  }
  eq([...CLIENT_TAME_OPS], ['FEED', 'TAME', 'BREED', 'RANCH'], '客户端 op 表逐字(用字面量钉,不拿它自己当期望值)');
  eq(Object.values(TameOp), ['FEED', 'TAME', 'BREED', 'RANCH'], '★ 服务端 TameOp 也是这四个 ⇒ 两边各自与字面量对账,客户端漂了会红');
  eq(breedTameRequest({ op: 'RANCH', petId: 'p#1' }).ok, true, 'RANCH(送进牧场)在客户端可选(WS-FND-119 的真实入口)');
});

/* ═══════════════════════════ 4 ═══════════════════════════ */

test('FND138-4 参数不全 ⇒ **一条都不发**,而且每一条都有话说', () => {
  const bad: Array<[string, () => { ok: boolean; reason?: string }]> = [
    ['BREED_TAME 缺 op', () => breedTameRequest({ petId: 'p#1' })],
    ['BREED_TAME op 打错', () => breedTameRequest({ op: 'EAT', petId: 'p#1' })],
    ['BREED_TAME 缺 petId', () => breedTameRequest({ op: 'TAME' })],
    ['BREED_TAME 空 petId', () => breedTameRequest({ op: 'TAME', petId: '' })],
    ['BREED_TAME FEED 缺 itemId', () => breedTameRequest({ op: 'FEED', petId: 'p#1' })],
    ['BREED_TAME BREED 缺 mateId', () => breedTameRequest({ op: 'BREED', petId: 'p#1' })],
    ['BUY_ITEM 缺 qty', () => buyItemRequest({ itemId: 151 })],
    ['BUY_ITEM qty=0', () => buyItemRequest({ itemId: 151, qty: 0 })],
    ['BUY_ITEM itemId 非整数', () => buyItemRequest({ itemId: 1.5, qty: 1 })],
    ['ALCHEMY itemId=0', () => useAlchemyFurnaceRequest({ itemId: 0 })],
    ['PLACE_AUTOMATION 缺 x/y', () => placeAutomationRequest({ itemId: 151 })],
    ['PLACE_AUTOMATION 两种形态都没有', () => placeAutomationRequest({ x: 1, y: 2 })],
    ['PLACE_AUTOMATION kind 空串', () => placeAutomationRequest({ x: 1, y: 2, kind: '' })],
    /* ★ 浮点坐标必须被拒 —— 这正是 `main.ts` 那条 provider 必须走 `cellUnder` 的理由
       (`predictor.pos` 是 12.53 这种浮点,直接传会被挡在入口;修前那种写法玩家看到的是
       "按了 4 没反应")。 */
    ['PLACE_AUTOMATION 浮点坐标', () => placeAutomationRequest({ x: 12.53, y: 0.5, itemId: 375 })],
  ];
  for (const [what, build] of bad) {
    const r = build();
    eq(r.ok, false, `${what} ⇒ 构建器必须拒绝(发出去也只是服务端一句 INVALID)`);
    ok((r.reason ?? '').length > 0, `${what} 的拒绝必须有可读理由(否则就是静默)`);
  }

  /* 经入口同一批输入:**零条报文**被递出去 */
  const sock = fakeSocket();
  const entry = new ActionEntry(sessionPorts(() => sock.session));
  const outs = [
    entry.breedTame({ op: 'TAME' }),
    entry.buyItem({ itemId: 151 }),
    entry.useAlchemyFurnace({ itemId: 0 }),
    entry.placeAutomation({ x: 1, y: 2 }),
  ];
  eq(outs.map((o) => [o.sent, o.code]), outs.map(() => [false, 'INVALID_INPUT']),
    '四次非法触发:全部"参数不对"分类(与"未连接"分开),且都不发');
  eq(sock.sent.length, 0, '★ 一条报文都不许被递出去');
  eq(entry.sentCount, 0, '入口的发出计数也必须是 0');

  /* 负对照:同一批里合法的那几条**必须发得出去**(否则上面可能只是"全都失败了") */
  const ok1 = entry.breedTame({ op: 'FEED', petId: 'p#1', mobId: 'mob_boar', itemId: 201 });
  const ok2 = entry.buyItem({ itemId: 151, qty: 2 });
  eq([ok1.sent, ok2.sent], [true, true], '合法输入 ⇒ 真的发出去(证明上面拦的是**参数**,不是这个动作本身)');
});

/* ═══════════════════════════ 5 ═══════════════════════════ */

test('FND138-5 握手未完成 ⇒ 不发(NOT_CONNECTED);切成 live ⇒ 发得出去(负对照)', () => {
  const sock = fakeSocket({ state: 'connecting' });
  const binding = mk(sock);
  const out = binding.handleKey('2');
  eq(out?.sent, false, 'connecting(还没收到 welcome)⇒ 不发');
  eq(out?.code, 'NOT_CONNECTED', '分类必须是"未连接",不是"参数不对"');
  ok((out?.status ?? '').includes('未连接'), '未连接要有可读分支');
  eq(sock.sent.length, 0, '★ 未连接时 sendAction 一次都不该被调用');

  sock.link.state = 'live';
  const again = binding.handleKey('2');
  eq(again?.sent, true, '★ 负对照:同一个入口、同一条参数,连上之后就该发得出去');

  /* 链路没写进去(socket 未开)⇒ 同样不是成功 */
  sock.link.accept = false;
  const refused = binding.handleKey('3');
  eq(refused?.sent, false, 'sendAction 返回 false ⇒ 不许当成成功');
  eq(refused?.code, 'NOT_CONNECTED', '链路没写进去归到"没发"这一支');
});

/* ═══════════════════════════ 6 ═══════════════════════════ */

test('FND138-6 重复触发不串包;PLACE_AUTOMATION 的两种形态键集合正确', () => {
  const sock = fakeSocket();
  const binding = mk(sock);
  binding.handleKey('2');
  binding.handleKey('2');
  eq(sock.sent.length, 2, '两次触发 = 两条独立报文(不合并、不复用)');
  ok(sock.sent[0] !== sock.sent[1], '★ 两条 intent 必须是不同对象(共享一个缓冲就会串包)');

  /* 组件形态:`kind` 给了就不该冒出一个 `itemId`(否则服务端把它当 429 的过滤目标) */
  eq(placeAutomationRequest({ x: 7, y: 8, kind: 'LOGISTICS_SORTER' }),
    { ok: true, request: { action: 'PLACE_AUTOMATION', payload: { x: 7, y: 8, kind: 'LOGISTICS_SORTER' } } },
    '组件形态逐字段正确');
  /* 两种都给 ⇒ 两个键都在(与服务端"按组件形态处理、itemId 当过滤目标"同一口径) */
  eq(placeAutomationRequest({ x: 7, y: 8, kind: 'LOGISTICS_SORTER', itemId: 429 }),
    { ok: true, request: { action: 'PLACE_AUTOMATION', payload: { x: 7, y: 8, kind: 'LOGISTICS_SORTER', itemId: 429 } } },
    '两种都给时两个键都在(不静默丢掉一个)');
  /* 播种形态:只有一个 itemId */
  const seed = placeAutomationRequest({ x: 7, y: 8, itemId: 375 });
  if (!seed.ok) { ok(false, '播种形态不该被拒'); return; }
  eq(Object.keys(seed.request.payload), ['x', 'y', 'itemId'], '★ 播种形态的键集合恰好是 x/y/itemId');
  ok(!Object.prototype.hasOwnProperty.call(seed.request.payload, 'kind'), '★ 没有 kind 这个键(不写 undefined)');
});

/* ═══════════════════════════ 7 ═══════════════════════════ */

test('FND138-7 逐动作覆盖 `RoomAction`,并逐条与**真源码**对账(wired 有见证 / missing 零出现)', () => {
  const actions = Object.keys(RoomAction) as string[];
  eq([...CLIENT_ENTRY_LEDGER.map((r) => r.action)].sort(), [...actions].sort(),
    '★ 客户端入口台账必须**逐键**覆盖 RoomAction(新增动作不裁决 ⇒ 红;这里是逐键相等,不是数总数)');
  const self = validateClientEntryLedger();
  ok(self.ok, `台账自检必须通过:${self.errors.join(' / ')}`);

  const files = clientCode();
  const exclude = 'client/src/wiring_ledger.ts';
  let wired = 0;
  let missing = 0;
  for (const row of CLIENT_ENTRY_LEDGER) {
    const witness = clientEntryWitnessOf(row.action);
    if (row.status === ClientEntryStatus.WIRED) {
      wired += 1;
      ok(witness !== '', `${row.action} 标为 wired 却没有见证片段`);
      ok(codeHas(files, witness, exclude),
        `${row.action} 的见证片段必须真的在客户端代码里(剥注释、排除台账自己):${witness}`);
    } else {
      missing += 1;
      eq(witness, '', `${row.action} 标为 missing ⇒ 不许有见证片段`);
      ok(!codeHas(files, `'${row.action}'`, exclude),
        `★ ${row.action} 标为 missing,但客户端代码里出现了这个动作名 —— 台账过期了`);
      ok(row.reason.length > 20, `${row.action} 的"为什么没有"必须写清(现在只有一句话的长度)`);
    }
  }
  /* ★ WS-FND-151/153(接线后应改 wired):`SET_PARTY_MODE` 从 `missing` 翻成 `wired`
     —— 缺的那块 UI(`ui/party_panel.ts` 的选择器 + `net/action_entry.setPartyMode`)
     已经落地 ⇒ 这里按**实测**记 17/7,而不是继续钉 16/8。
     (钉旧数的代价不是"数字难看":它会逼着后来者把已接的入口写回 missing,
      或者把真入口删掉 —— 两种都是把修好的东西退回去。) */
  eq(wired, 17, '已接线 17 条(字母表 6 + ACTION_KEYS 4 + 专用报文 2 + 热键 4 + 模式面板 1)');
  eq(missing, 7, '登记"服务端有、客户端零入口"7 条(SET_PARTY_MODE 已于 WS-FND-151 接线)');
  eq(CLIENT_ENTRY_LEDGER.length, actions.length, '台账条数 = RoomAction 键数(两者派生,不写死)');


  /* ── 注入验证:一条"偷偷把 WIRE_EDIT 接上"的源码 ⇒ 同一条判据必须判它不再是 missing ── */
  const injected: CodeFile[] = [
    ...files,
    { path: 'client/src/net/fake_room_panel.ts', code: "session.sendAction({ action: 'WIRE_EDIT', dir: 1 });" },
  ];
  eq(codeHas(files, "'WIRE_EDIT'", exclude), false, '前提:当前客户端代码里**零**处 WIRE_EDIT(所以它登记为 missing)');
  eq(codeHas(injected, "'WIRE_EDIT'", exclude), true,
    '★ 注入后必须命中 ⇒ "missing 零出现"这条判据真的有牙齿(不是恒真)');
});

/* ═══════════════════════════ 8 ═══════════════════════════ */

test('FND138-8 台账自检能报红:伪造"wired 无见证" / "missing 有见证" / 缺理由', () => {
  const okRow: ClientEntryRow = {
    action: 'CRAFT', serverPath: 'x', entry: 'N', status: ClientEntryStatus.WIRED, reason: 'r',
  };
  eq(validateClientEntryLedger([okRow]).ok, true, '合法行(有见证)必须通过');

  const noWitness: ClientEntryRow = { ...okRow, action: '不存在的动作' };
  eq(validateClientEntryLedger([noWitness]).ok, false, '★ 负对照:没有见证片段的 wired 行必须被判红');

  const missingWithWitness: ClientEntryRow = { ...okRow, status: ClientEntryStatus.MISSING, entry: 'missing' };
  eq(validateClientEntryLedger([missingWithWitness]).ok, false, '★ 负对照:missing 却有见证片段 ⇒ 判红');

  const noReason: ClientEntryRow = { ...okRow, reason: '  ' };
  eq(validateClientEntryLedger([noReason]).ok, false, '★ 负对照:理由空白 ⇒ 判红(否则台账会腐烂成假绿清单)');

  const dup = [okRow, { ...okRow }];
  eq(validateClientEntryLedger(dup).ok, false, '★ 负对照:同一动作两次 ⇒ 判红');
});

/* ═══════════════════════════ 9 ═══════════════════════════ */

test('FND138-9 背包拖拽 = **本地整理视图**(口径常量 + 文案 + 那段路上没有任何上行)', () => {
  eq(DRAG_UPLINK, 'local-only', '★ 口径常量必须如实(missing 的报文语义不许靠注释表达)');

  const boot = stripComments(read('client/src/three/boot.ts'));
  const at = boot.indexOf('dragCtl.drop(hover)');
  ok(at > 0, '成交入口必须在 boot.ts 里(FND126-4 钉着它没被退回 cancel)');
  const branch = boot.slice(at, at + 2000);
  ok(branch.includes('本地整理视图'), '★ 成交文案必须如实标出"这是本地整理"(修前只写"第 3 格 → 第 9 格")');
  ok(branch.includes('DRAG_UPLINK'), '文案必须引用口径常量(手写一句"不发报文"迟早漂)');
  ok(branch.includes('刷新/重连即回原序'), '玩家必须读得到后果(刷新就没了)');
  ok(!branch.includes('sendAction'), '★ 这条路上不许出现 sendAction(拖拽不发报文)');
  ok(!branch.includes('.send('), '★ 也不许出现其它上行调用');
  ok(!boot.includes('sendAction'), '★ 更强的一条:整个 boot.ts 都没有上行调用点(拖拽在客户端**没有**等价动作)');

  /* 负对照(修前形态):老文案必须被判不通过 —— 检测器不能恒真 */
  const oldText = 'lastMove = `第 ${moved.fromSlot} 格 → 第 ${moved.toSlot} 格`;';
  ok(!oldText.includes('本地整理视图') && !oldText.includes('DRAG_UPLINK'),
    '★ 负对照:修前那句文案在同一条判据下必须判红(它确实什么都没说)');
});

/* ═══════════════════════════ 10 ═══════════════════════════ */

test('FND138-10 `lastItemId` 前置:提示把"缺什么 / 怎么拿到 / 之后哪些键才通"说清,旧文案逐字消失', () => {
  const main = stripComments(read('client/src/main.ts'));
  ok(main.includes('还缺「最近物品」'), '★ 新文案必须点名**缺什么**(不是"先按 E 拆一块"这么含糊)');
  ok(main.includes('Q/G/F/N/T/2/3/4'), '★ 必须写清**拿到之后哪些键才通**(否则玩家不知道这是全局前置)');
  ok(main.includes('最近物品 (还没有)'), '状态条里有机器可读的前置读数');
  ok(main.includes('热键 1/2/3/4 需要「最近物品」'), '状态条明写四个热键的前置');

  /* ★ 旧文案必须**逐字消失**(否则说明只是加了一行,把玩家引向两条不同的话) */
  ok(!main.includes('✗ 先按 E 拆一块或按 F 捡一件`;'), '★ 修前那句含糊提示必须被替换掉,不是并存');

  /* 负对照:修前样本在同一条判据下必须判红 */
  const oldMain = 'lastAction = `${spec.label} ✗ 先按 E 拆一块或按 F 捡一件`;';
  ok(oldMain.includes('✗ 先按 E 拆一块或按 F 捡一件`;') && !oldMain.includes('还缺「最近物品」'),
    '★ 负对照:修前的 main.ts 片段在同一条判据下必然判红');
});

/* ═══════════════════════════ 11 ═══════════════════════════ */

test('FND138-11 手册与提示条:键位 / 空格一键两义 / 相机跟随 / 数字一致(带注入负对照)', () => {
  const play = read('PLAY.md');
  const html = read('client/index.html');
  eq(docProblems(play, html), [], 'PLAY.md 与 client/index.html 必须自洽且与代码一致');
  eq(play.includes('23 个 `RoomAction`'), false, '旧数字 23 必须消失');
  eq(play.includes('「22 个动作的归属」'), false, '旧数字 22(动作归属)必须消失');

  /* ── 注入验证:把**修前**的两处文本塞回去 ⇒ 同一条判据必须报红 ── */
  const stale = play
    .replace('24 个 `RoomAction` 里 **22 个已接线**', '23 个 `RoomAction` 里 **21 个已接线**')
    .replace('相机跟着**权威位置**走', 'WASD 现在**同时**在平移相机')
    .concat('\nWASD 现在**同时**在平移相机,所以角色不会走出画面 —— 但那是巧合\n');
  const problems = docProblems(stale, html);
  ok(problems.length >= 2, `★ 注入(旧数字 + 旧相机说法)后必须报出问题,实际:${problems.length}`);
  ok(problems.some((p) => p.includes('相机')), '报出来的必须点名相机那条');
  ok(problems.some((p) => p.includes('RoomAction')), '报出来的必须点名动作总数那条');

  /* 提示条覆盖:实际键位一个都不能漏 */
  for (const key of ['N 合成', 'K 睡觉', 'O/U 开箱', 'V 派对开局', 'T 用道具', '1 驯养', '2 购买', '3 炼金台', '4 放件/播种',
    'I 背包', 'R 配方', 'H 画架', 'P 音高', '[ ] 缩放', '/ 搜索', 'B Boss', 'Z/Y/X/C 画架工具', '空格', '本地整理']) {
    ok(html.includes(key), `提示条里必须列出「${key}」`);
  }
});

/** 手册/提示条的一致性问题清单 —— 返回非空即判红(可注入旧样本证明它会红)。 */
function docProblems(play: string, html: string): string[] {
  const p: string[] = [];
  if (play.includes('但那是巧合') || play.includes('WASD 现在**同时**在平移相机')) {
    p.push('PLAY.md 仍在说「WASD 同时在平移相机 ⇒ 那是巧合」——代码已改成相机跟随权威位置');
  }
  if (!play.includes('相机跟着**权威位置**走')) p.push('PLAY.md 没写明相机跟随权威位置(committed 的行为)');
  if (play.includes('23 个 `RoomAction`')) p.push('PLAY.md 的 RoomAction 总数过期(23 ⇒ 实测 24)');
  if (!play.includes('24 个 `RoomAction`')) p.push('PLAY.md 未写 24 个 RoomAction');
  if (!play.includes('22 个已接线')) p.push('PLAY.md 未写 22 个已接线');
  if (!play.includes('一键两义')) p.push('PLAY.md 没写空格的一键两义(攻击 + 跳跃锁存)');
  if (!play.includes('锁存一次跳跃')) p.push('PLAY.md 没写跳跃锁存这件事');
  if (!play.includes('本地整理视图')) p.push('PLAY.md 没写背包拖拽=本地整理视图');
  if (!play.includes('CLIENT_ENTRY_LEDGER')) p.push('PLAY.md 没指向客户端入口台账');
  if (!html.includes('锁存一次跳跃')) p.push('#hint 提示条没写空格的一键两义');
  if (!html.includes('本地整理')) p.push('#hint 提示条没写拖拽=本地整理');
  return p;
}

/* ═══════════════════════════ 12 ═══════════════════════════ */

test('FND138-12 不是 RoomAction 的入口缺口也登记了(急单开工 / 分拣带 lane)', () => {
  ok(CLIENT_ENTRY_GAPS.length >= 2, '至少两条:急单开工 + 分拣带 lane 配置');
  for (const g of CLIENT_ENTRY_GAPS) {
    ok(g.what.trim() !== '', '每条缺口都要说清"缺什么"');
    ok(g.reason.length > 40, `${g.what} 的现状/出路必须写清(现在只有一句话的长度)`);
  }
  const joined = CLIENT_ENTRY_GAPS.map((g) => `${g.what}${g.reason}`).join('\n');
  ok(joined.includes('急单'), '急单(rush)开工必须在登记里(它不是 RoomAction,却同样"服务端有、客户端按不到")');
  ok(joined.includes('startRushRun'), '急单那条必须点名**谁**在开工(世界侧自动 ⇒ 客户端没有键位缺口)');
  ok(joined.includes('lane'), '分拣带的 lane 形态必须在登记里(键盘只给播种形态)');
  eq(clientEntryRow('BREED_TAME')?.status, ClientEntryStatus.WIRED, '★ 第十轮补的四条必须是 wired(修前是 missing)');
  eq(clientEntryRow('BUY_ITEM')?.status, ClientEntryStatus.WIRED, '同上(BUY_ITEM)');
  eq(clientEntryRow('USE_ALCHEMY_FURNACE')?.status, ClientEntryStatus.WIRED, '同上(USE_ALCHEMY_FURNACE)');
  eq(clientEntryRow('PLACE_AUTOMATION')?.status, ClientEntryStatus.WIRED, '同上(PLACE_AUTOMATION)');
  /* ★ 接线后应改 wired:`SET_PARTY_MODE` 缺的那块 UI(模式选择器)在 WS-FND-151 落地
     ⇒ 台账里它是 `wired`(`clientEntryWitnessOf` 有见证片段)。旧判据钉的是
     `MISSING`("本轮没偷接"),它描述的是**修前**的状态:继续钉就会要求把真入口写回
     missing,等于让判据反过来禁止修复。剩下的管理类动作仍必须 missing(下面两条)。 */
  eq(clientEntryRow('SET_PARTY_MODE')?.status, ClientEntryStatus.WIRED,
    '★ 模式面板已接 ⇒ 台账必须是 wired(旧判据钉 missing,是"修前"的期望)');
  eq(clientEntryRow('SET_ROOM_ACCESS')?.status, ClientEntryStatus.MISSING,
    '对照:没接的管理类动作仍是 missing(SET_ROOM_ACCESS —— 没偷接,也不许自认已接)');
  eq(clientEntryRow('WIRE_EDIT')?.status, ClientEntryStatus.MISSING,
    '对照同上(WIRE_EDIT):缺的是服务端下发的线框数据,不是一行转发');
  eq(clientEntryRow('没有这个动作'), null, '负对照:未登记的动作返回 null(判据据此发现"没裁决")');
});

report('WS-FND-138-client-entry-parity');
