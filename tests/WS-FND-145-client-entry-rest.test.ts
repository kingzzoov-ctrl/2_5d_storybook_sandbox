/**
 * WS-FND-145 —— **客户端入口台账剩下的 8 条**(+ 两条非 `RoomAction` 的缺口)逐条处置。
 *
 * ## 修的是什么(第十轮之后的状态)
 *
 * 第十轮补了 `1`/`2`/`3`/`4` 四条入口,`CLIENT_ENTRY_LEDGER` 里**仍有 8 条 `missing`**,
 * 而且它们只有一句理由 —— "服务端有执行层、客户端没有入口"这件事在玩家/后来者眼里
 * 与"这个键坏了"同形。本轮的裁决是**第二个选项**:
 * ```
 * 不接裸键(它们都是房间管理类:{SET_ROOM_ACCESS…WIRE_EDIT})
 * ⇒ 在台账里登记为「服务端已实现、客户端**刻意不提供**」
 *   并写清 why(为什么刻意)/ unblock(解锁它的那一件事)/ today(玩家今天能做到哪一步)
 * ```
 * 另外两条不是 `RoomAction` 的缺口(急单 rush 的开局与交付、分拣带的 `lane` 形态)
 * 用同一套口径补齐,而不是留在"只说了缺什么"。
 *
 * ## 判据的形状(为什么这么写)
 *
 * ```ts
 * 假 socket + 生产 sessionPorts   —— 把所有**真的会发报文**的键都按一遍,逐字段对账;
 *                                  并反向断言**没有任何一条报文**带管理类键
 * 源码级零入口                    —— missing 的动作名在 client/src(剥注释)里必须 0 次,
 *                                  注入一行 ⇒ 同一条判据必须命中(有牙齿)
 * 契约级 lane                    —— 逐字读 `ActionPayload`,lane 一出现就红(那时才可以接线)
 * 文档                            —— PLAY.md / docs/WIRING-LEDGER.md 的 2.9.1 节逐条点名;
 *                                  删掉一行 ⇒ 检测器必须报红
 * ```
 *
 * 运行:`node tests/WS-FND-145-client-entry-rest.test.ts`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';

import { ActionEntry, describeEntryReceipt } from '../client/src/net/action_entry.ts';
import {
  ENTRY_KEYS,
  HOTBAR_KEYS,
  createActionBinding,
  sessionPorts,
  type EntryInputs,
  type SessionLike,
} from '../client/src/net/action_binding.ts';
import { ACTION_KEYS } from '../client/src/net/action_target.ts';
import {
  CLIENT_ENTRY_GAPS,
  CLIENT_ENTRY_HOLDS,
  CLIENT_ENTRY_LEDGER,
  ClientEntryStatus,
  ClientHoldKind,
  clientEntryRow,
  clientEntryWitnessOf,
  clientHoldRow,
  missingRowsWithoutHold,
  validateClientEntryHolds,
  validateClientEntryLedger,
  type ClientEntryRow,
  type ClientHoldRow,
} from '../client/src/wiring_ledger.ts';

/* 服务端那两张**真表** —— 客户端不许自说自话 */
import { RoomAction } from '../server/src/net/room.ts';
import { RUSH_ACTION_LEDGER, RUSH_DELIVERY_RADIUS } from '../server/src/coop/rush_actions.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** 本轮逐条处置的 8 条(`RoomAction` 名,**字面量**写死 —— 不拿台账当期望值)。 */
const MANAGEMENT_ACTIONS: readonly string[] = [
  'SET_ROOM_ACCESS', 'SET_PARTY_MODE', 'KICK_MEMBER', 'SET_MEMBER_ROLE',
  'RESET_WORLD', 'CLOSE_ROOM', 'MODIFY_TOWN', 'WIRE_EDIT',
];

/** 剥注释(**保留字符串字面量**;口径与 WS-FND-138 一致,`//` 前排除 `:`)。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

interface CodeFile {
  path: string;
  code: string;
}

function clientCode(): CodeFile[] {
  const out: CodeFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.ts')) {
        out.push({
          path: full.slice(ROOT.length + 1).split('\\').join('/'),
          code: stripComments(readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(join(ROOT, 'client', 'src'));
  return out;
}

function codeHas(files: readonly CodeFile[], needle: string, exclude?: string): boolean {
  if (needle === '') return false;
  return files.some((f) => f.path !== exclude && f.code.includes(needle));
}

/** 台账自己 —— `missing` 的动作名当然只在它里面出现(排除它,判据才有牙齿)。 */
const LEDGER_FILE = 'client/src/wiring_ledger.ts';

type WireIntent = { action: string; [k: string]: unknown };

interface FakeSocket {
  session: SessionLike;
  sent: WireIntent[];
  link: { state: string; accept: boolean };
}

/**
 * **假 socket** —— 「入口键 → 真的发出报文」的唯一证据来源。
 *
 * 它只实现 `SessionLike` 的**结构**(`state` + `sendAction`),再由**生产的**
 * `sessionPorts()` 适配进入口 ⇒ 被测的是生产那段判定,不是测试里的替身逻辑。
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

/** 宿主(`main.ts`)给得出来的参数 —— 与生产里那几个 provider 逐字段同形。 */
const HOST_INPUTS: EntryInputs = {
  craft: () => ({ itemId: 151, have: { 151: 2 } }),
  chestCell: () => ({ x: 3, y: 4 }),
  /* 房间还没选模式 ⇒ 回声是 `undefined`(生产里 `partyModeName(0)` 就是 null)。 */
  partyModeEcho: () => undefined,
  useItem: () => ({ itemId: 151 }),
  breedTame: () => ({ op: 'FEED', petId: 'mob_boar#3', mobId: 'mob_boar', itemId: 201 }),
  buyItem: () => ({ itemId: 151, qty: 1 }),
  useAlchemyFurnace: () => ({ itemId: 151 }),
  placeAutomation: () => ({ x: 5, y: 6, itemId: 151 }),
};

const mk = (sock: FakeSocket, inputs: EntryInputs = HOST_INPUTS) =>
  createActionBinding({ entry: new ActionEntry(sessionPorts(() => sock.session)), inputs });

/* ═══════════════════════════ 1 ═══════════════════════════ */

test('FND145-1 8 条 missing 逐条:台账有该条 + 登记有 why/unblock/today(理由非空)', () => {
  eq([...CLIENT_ENTRY_HOLDS.map((h) => h.action)].sort(), [...MANAGEMENT_ACTIONS].sort(),
    '★ 登记表必须**恰好**覆盖这 8 条(多一条 = 无主登记;少一条 = 有人没裁决)');

  for (const action of MANAGEMENT_ACTIONS) {
    const row = clientEntryRow(action);
    ok(row !== null, `${action} 不在 CLIENT_ENTRY_LEDGER 里(判据要求逐键覆盖 RoomAction)`);
    eq(row?.status, ClientEntryStatus.MISSING,
      `${action} 的裁决是"刻意不提供" ⇒ 状态必须仍是 missing(它不是"已接线")`);
    eq(row?.entry, 'missing', `${action} 的 entry 必须是 missing(与状态同向)`);
    ok((row?.reason ?? '').trim().length > 20,
      `${action} 的 reason 必须写清"为什么刻意不提供"(现在只有一句话的长度)`);

    const hold = clientHoldRow(action);
    ok(hold !== null, `★ ${action} 没有登记(台账不许留"没有说明的 missing")`);
    eq(hold?.kind, ClientHoldKind.DELIBERATE, `${action} 的登记档位必须是 deliberate`);
    ok((hold?.why ?? '').length >= 40,
      `${action} 的 why 必须说清"为什么刻意不提供",而不是一句"还没做"(实际 ${(hold?.why ?? '').length} 字)`);
    ok((hold?.unblock ?? '').trim().length >= 10,
      `${action} 必须写 unblock(解锁它的那一件事),否则这条登记没有出路`);
    ok((hold?.today ?? '').trim().length >= 2,
      `${action} 必须写 today(玩家今天能做到哪一步,做不到就写"做不到")`);

    eq(clientEntryWitnessOf(action), '',
      `${action} 仍是 missing ⇒ 不许有见证片段(有片段就等于说"接上了")`);
  }

  /* 两条非 RoomAction 的缺口:同一套口径 */
  eq([...CLIENT_ENTRY_GAPS.map((g) => g.what)].length, 2, '非 RoomAction 的缺口恰好两条(急单 / lane)');
  for (const g of CLIENT_ENTRY_GAPS) {
    eq(g.kind, ClientHoldKind.DELIBERATE, `${g.what} 的判定档位必须是 deliberate`);
    ok(g.reason.length > 40, `${g.what} 的 reason 必须写清现状与为什么`);
    ok(g.unblock.trim().length >= 10, `${g.what} 必须写 unblock(解锁它的那一件事)`);
    ok(g.today.trim().length >= 2, `${g.what} 必须写 today(今天能做到哪一步)`);
  }

  eq(clientHoldRow('没有这个动作'), null, '负对照:没登记的动作返回 null(判据据此发现"没裁决")');
});

/* ═══════════════════════════ 2 ═══════════════════════════ */

test('FND145-2 台账/登记自检真绿,且四条负对照各自报红(不是恒真)', () => {
  const ledger = validateClientEntryLedger();
  eq(ledger.errors, [], '★ 台账自检必须通过');
  ok(ledger.ok, '台账自检 ok');

  const holds = validateClientEntryHolds();
  eq(holds.errors, [], '★ 登记自检必须通过');
  ok(holds.ok, '登记自检 ok');

  /* ── 负对照 1:登记里出现两条同一个动作 ── */
  const dup = validateClientEntryHolds(CLIENT_ENTRY_LEDGER, [...CLIENT_ENTRY_HOLDS, CLIENT_ENTRY_HOLDS[0]!]);
  eq(dup.ok, false, '★ 同一条动作登记两次 ⇒ 必须判红');
  ok(dup.errors.some((e) => e.includes('出现了两次')), `报出来的必须点名重复,实际:${dup.errors.join(' / ')}`);

  /* ── 负对照 2:把一条登记挂到**已接线**的动作上 ── */
  const onWired = validateClientEntryHolds(CLIENT_ENTRY_LEDGER, [{ ...CLIENT_ENTRY_HOLDS[0]!, action: 'CRAFT' }]);
  eq(onWired.ok, false, '★ 已接线却还登记为"刻意不提供" ⇒ 必须判红(登记会腐烂成假清单)');
  ok(onWired.errors.some((e) => e.startsWith('CRAFT')), `报出来的必须点名 CRAFT,实际:${onWired.errors.join(' / ')}`);

  /* ── 负对照 3:少一条登记 ⇒ 台账自检必须点名那一条 ── */
  const dropped = CLIENT_ENTRY_HOLDS.filter((h) => h.action !== 'WIRE_EDIT');
  eq(missingRowsWithoutHold(CLIENT_ENTRY_LEDGER, dropped), ['WIRE_EDIT'],
    '★ 少一条登记时,缺的必须**恰好**是那一条(逐条,不是数总数)');
  const brokenLedger = validateClientEntryLedger(CLIENT_ENTRY_LEDGER);
  ok(brokenLedger.ok, '前提:整张台账本身是绿的');
  const fakeMissing: ClientEntryRow = {
    action: 'FAKE_MISSING', serverPath: 'x', entry: 'missing',
    status: ClientEntryStatus.MISSING, reason: '故意留一条没有登记的 missing',
  };
  const withFake = validateClientEntryLedger([...CLIENT_ENTRY_LEDGER, fakeMissing]);
  eq(withFake.ok, false, '★ 一条 missing 没有登记 ⇒ 台账自检必须判红');
  ok(withFake.errors.some((e) => e.includes('FAKE_MISSING') && e.includes('没有登记')),
    `报出来的必须点名它,实际:${withFake.errors.join(' / ')}`);
  eq(missingRowsWithoutHold(CLIENT_ENTRY_LEDGER, CLIENT_ENTRY_HOLDS), [], '全量登记 ⇒ 一条不缺');

  /* ── 负对照 4:理由被写空(why 只有空格)⇒ 必须判红 ── */
  const blankWhy: ClientHoldRow = { ...CLIENT_ENTRY_HOLDS[0]!, why: '   ' };
  const blank = validateClientEntryHolds(CLIENT_ENTRY_LEDGER, [blankWhy]);
  eq(blank.ok, false, '★ why 空白 ⇒ 必须判红(否则"登记"会退化成一张空话表)');
  ok(blank.errors.some((e) => e.includes('why 太短')), `报出来的必须点名 why,实际:${blank.errors.join(' / ')}`);

  /* ── 负对照 5:登记指向台账里没有的动作(无主登记)── */
  const orphan = validateClientEntryHolds(CLIENT_ENTRY_LEDGER, [
    ...CLIENT_ENTRY_HOLDS, { ...CLIENT_ENTRY_HOLDS[0]!, action: 'NOT_A_ROOM_ACTION' },
  ]);
  eq(orphan.ok, false, '★ 无主登记 ⇒ 必须判红');
  ok(orphan.errors.some((e) => e.includes('无主登记')), `报出来的必须点名无主登记,实际:${orphan.errors.join(' / ')}`);
});

/* ═══════════════════════════ 3 ═══════════════════════════ */

test('FND145-3 客户端源码里**零入口**(剥注释、排除台账);注入一行 ⇒ 同一条判据命中', () => {
  const files = clientCode();
  ok(files.length > 20, `客户端源码扫描失败(只读到 ${files.length} 个文件)⇒ 判据会恒真`);

  for (const action of MANAGEMENT_ACTIONS) {
    ok(!codeHas(files, action, LEDGER_FILE),
      `★ ${action} 出现在客户端源码里(台账之外)⇒ 登记过期:它已有入口,应当改成 wired`);
    ok(!codeHas(files, `'${action}'`, LEDGER_FILE), `${action} 的字符串字面量不许出现在客户端代码里`);
    ok(!codeHas(files, `"${action}"`, LEDGER_FILE), `${action} 的双引号字面量同理`);
  }

  /* 负对照:塞一行"偷偷接上"的源码 ⇒ 同一条判据必须命中(不是恒真) */
  const injected: CodeFile[] = [
    ...files,
    { path: 'client/src/net/fake_room_panel.ts', code: "session.sendAction({ action: 'WIRE_EDIT', dir: 1 });" },
  ];
  eq(codeHas(files, 'WIRE_EDIT', LEDGER_FILE), false, '前提:当前客户端代码里**零**处 WIRE_EDIT');
  eq(codeHas(injected, 'WIRE_EDIT', LEDGER_FILE), true,
    '★ 注入后必须命中 ⇒ "零入口"这条判据有牙齿');
});

/* ═══════════════════════════ 4 ═══════════════════════════ */

test('FND145-4 假 socket 经生产 sessionPorts 捕获**全部键位**的报文(逐字段)', () => {
  const sock = fakeSocket();
  const binding = mk(sock);
  const keys = [...Object.keys(ENTRY_KEYS), ...Object.keys(HOTBAR_KEYS)];
  eq(keys, ['n', 'k', 'o', 'u', 'v', 't', '1', '2', '3', '4'],
    '键位集合逐字(两表拼起来才是完整入口;这里不写"若干个")');

  const outs = keys.map((k) => binding.handleKey(k));
  eq(outs.map((o) => o?.sent), keys.map(() => true), '★ 每个键都必须**真的发出去**(不是"按了没反应")');
  eq(sock.sent.length, keys.length, '假 socket 上恰好每条键一条报文');
  eq(binding.entry.sentCount, keys.length, '入口自己的计数也必须是同一个数(它是自检口径)');

  /* 逐字段:线上是**扁平**一层(没有 payload,动作名在展开之后) */
  eq(sock.sent, [
    { itemId: 151, have: { 151: 2 }, action: 'CRAFT' },
    { action: 'SLEEP' },
    { x: 3, y: 4, action: 'OPEN_CHEST' },
    { x: 3, y: 4, action: 'USE_OWN_CHEST' },
    { action: 'START_PARTY' },
    { itemId: 151, action: 'USE_ITEM' },
    { op: 'FEED', petId: 'mob_boar#3', mobId: 'mob_boar', itemId: 201, action: 'BREED_TAME' },
    { itemId: 151, qty: 1, action: 'BUY_ITEM' },
    { itemId: 151, action: 'USE_ALCHEMY_FURNACE' },
    { x: 5, y: 6, itemId: 151, action: 'PLACE_AUTOMATION' },
  ], '★ 十条报文的键集合与取值都必须逐字正确(键多了/少了都会被这条抓住)');

  const known = new Set<string>(Object.values(RoomAction) as unknown as string[]);
  for (const got of sock.sent) {
    ok(!Object.prototype.hasOwnProperty.call(got, 'payload'), '★ 线上是扁平一层:不许出现 payload 这个键');
    ok(known.has(got.action), `${got.action} 必须是 server/src/net/room.ts 的 RoomAction 之一`);
  }

  /* ── 反向断言:生产客户端**物理上发不出**管理类报文 ── */
  const managementKeys = [
    'targetId', 'role', 'mode', 'passwordHash', 'partyMode',
    'confirm', 'seed', 'radius', 'name', 'totemCell', 'dir', 'color', 'channel', 'clear', 'lane',
  ];
  const used = new Set<string>();
  for (const got of sock.sent) for (const k of Object.keys(got)) used.add(k);
  eq(managementKeys.filter((k) => used.has(k)), [],
    '★ 没有任何一条报文带管理类键 ⇒ 那 8 条动作在客户端**没有发送路径**');

  /* 负对照:把缺的那条键补进一条报文里 ⇒ 同一条判据必须命中 */
  const withManagement = [...sock.sent, { action: 'KICK_MEMBER', targetId: 'p1' } as WireIntent];
  const used2 = new Set<string>();
  for (const got of withManagement) for (const k of Object.keys(got)) used2.add(k);
  eq(managementKeys.filter((k) => used2.has(k)), ['targetId'],
    '★ 注入后必须点名 targetId ⇒ 上面的空数组不是恒真');
});

/* ═══════════════════════════ 5 ═══════════════════════════ */

test('FND145-5 `partyMode` 只出现在 START_PARTY 的**回声**上,从不发 SET_PARTY_MODE', () => {
  const sock = fakeSocket();
  const binding = mk(sock, { ...HOST_INPUTS, partyModeEcho: () => 'BRIDGE_CTF' });
  binding.handleKey('v');
  eq(sock.sent, [{ partyMode: 'BRIDGE_CTF', action: 'START_PARTY' }],
    '★ 回声走的是 START_PARTY(与房间已选模式核对),不是 SET_PARTY_MODE');
  ok(sock.sent.every((m) => m.action !== 'SET_PARTY_MODE'),
    'SET_PARTY_MODE 一条都不许出现(它改了赛制,而 `V` 只开那一局)');

  /* 三张键位表里没有任何一格指向管理类动作 */
  const actions = [
    ...Object.values(ACTION_KEYS).map((s) => s.action),
    ...Object.values(ENTRY_KEYS).map((s) => s.slot),
    ...Object.values(HOTBAR_KEYS).map((s) => s.slot),
  ].join(' ');
  for (const action of MANAGEMENT_ACTIONS) {
    ok(!actions.includes(action), `${action} 不许藏在键位表里(台账说它 missing)`);
  }
});

/* ═══════════════════════════ 6 ═══════════════════════════ */

test('FND145-6 分拣带 `lane`:契约里没有它;键盘只发播种形态(逐字段)', () => {
  const room = stripComments(read('server/src/net/room.ts'));
  const at = room.indexOf('export interface ActionPayload {');
  ok(at > 0, '前提:ActionPayload 还在 room.ts 里(它挪走了这条判据就该跟着挪)');
  const end = room.indexOf('\n}', at);
  ok(end > at, 'ActionPayload 的闭合花括号找到了');
  const block = room.slice(at, end);
  ok(/\bkind\b/.test(block), '双向的前提:抓到的是**真的** ActionPayload(里面有 kind)');
  eq(/\blane\b/.test(block), false,
    '★ 契约里出现 lane ⇒ 可以向服务端发它了:那时**删掉这条登记**并接上入口,而不是让这条判据自己失效');

  /* 负对照:把 lane 塞进契约片段 ⇒ 同一条判据必须命中 */
  eq(/\blane\b/.test(`${block}\n  lane?: unknown;`), true,
    '★ 注入 lane 后必须命中 ⇒ "契约里没有 lane"这条判据不是恒真');

  /* 键盘路径 = 播种形态,逐字段 */
  const sock = fakeSocket();
  const binding = mk(sock);
  binding.handleKey('4');
  eq(sock.sent, [{ x: 5, y: 6, itemId: 151, action: 'PLACE_AUTOMATION' }],
    '★ 键盘只给播种形态(不猜组件名,也不带 lane)');
  const got = sock.sent[0]!;
  ok(!Object.prototype.hasOwnProperty.call(got, 'lane'), '键盘路径**不许**冒出一个 lane');
  ok(!Object.prototype.hasOwnProperty.call(got, 'kind'), '键盘路径也不猜 kind(注册表在服务端)');

  /* 组件形态(按钮路径)= kind,仍然没有 lane */
  const sock2 = fakeSocket();
  const entry = new ActionEntry(sessionPorts(() => sock2.session));
  const out = entry.placeAutomation({ x: 7, y: 8, kind: 'LOGISTICS_SORTER' });
  eq(out.sent, true, '组件形态是合法的(只是今天没有 UI 调用方)');
  eq(sock2.sent, [{ x: 7, y: 8, kind: 'LOGISTICS_SORTER', action: 'PLACE_AUTOMATION' }],
    '★ 组件形态逐字段;`lane`(第几道收哪件)依然发不出去 —— 契约里没有这个键');
});

/* ═══════════════════════════ 7 ═══════════════════════════ */

test('FND145-7 急单三段全在世界侧(且客户端没有专用键),交付半径与 `G` 同口径', () => {
  const world = stripComments(read('server/src/sim/world_sim.ts'));
  const steps: Array<[string, string]> = [
    ['START', 'startRushRun'],
    ['DELIVER', 'submitDelivery'],
    ['SETTLE', 'settleSession'],
  ];
  for (const [step, call] of steps) {
    const row = RUSH_ACTION_LEDGER.find((r) => r.step === step);
    ok(row !== undefined, `${step} 必须在 RUSH_ACTION_LEDGER 里`);
    ok((row?.path ?? '').startsWith('WIRED:'), `★ ${step} 必须是 WIRED 且有调用点(现在:${row?.path ?? ''})`);
    ok((row?.path ?? '').includes(call), `${step} 的调用点必须点名 ${call}`);
    ok(world.includes(call), `★ ${call} 必须真的出现在 world_sim.ts 里(台账自称不等于存在)`);
  }

  /* 客户端侧:交付 = 把货丢在**脚下**,半径 1 格 ⇒ 与 `G`(DROP_ITEM / under)同口径 */
  eq(RUSH_DELIVERY_RADIUS, 1, '交付半径 = 1 格(与 takeGroundItemNear 的单格口径一致)');
  eq(ACTION_KEYS.g?.action, 'DROP_ITEM', '`G` = DROP_ITEM');
  eq(ACTION_KEYS.g?.target, 'under', '★ 丢在**脚下**(不是面前)⇒ 与"脚下 1 格内"的交付口径一致');

  /* 客户端三张表里没有一格指向 rush(它是世界侧的,不该有键) */
  const tableText = JSON.stringify([ACTION_KEYS, ENTRY_KEYS, HOTBAR_KEYS]);
  eq(/rush/i.test(tableText), false, '★ 键位表里不许出现 rush 专用键(世界侧自动开工,不是键位缺口)');
  const files = clientCode();
  eq(codeHas(files, "'RUSH_", LEDGER_FILE), false, '客户端代码里不许有 RUSH_* 动作名(台账之外)');
});

/* ═══════════════════════════ 8 ═══════════════════════════ */

test('FND145-8 急单评级真的读得到:回执 `effect.rushGrade` → 状态条那一行', () => {
  const line = describeEntryReceipt({
    action: 'START_PARTY', ok: true, kind: 'OK', effect: { rushGrade: 'A', rushScore: 120 },
  });
  ok(line.startsWith('派对开局 ✓'), `回执行必须有动作名(实际:${line})`);
  ok(line.includes('rushGrade=A'), `★ 评级必须进玩家读得到的那一行(实际:${line})`);
  ok(line.includes('rushScore=120'), '分数同理(它不是内部字段,是同一份回执)');

  /* 负对照:没有 effect 时不该凭空出现 rushGrade */
  const bare = describeEntryReceipt({ action: 'START_PARTY', ok: true, kind: 'OK' });
  eq(bare.includes('rushGrade'), false, '★ 没有 effect 就不该显示评级 ⇒ 上面那条不是恒真');

  /* 证据链:键名不是客户端发明的 —— 服务端逐字挂上它 */
  const room = stripComments(read('server/src/net/room.ts'));
  ok(room.includes('extra.rushGrade = rush.grade'),
    '★ room.ts 必须逐字把 rush.grade 挂成 effect.rushGrade(键名只有一个出处)');
});

/* ═══════════════════════════ 9 ═══════════════════════════ */

test('FND145-9 PLAY.md:10 条逐条点名 + 「刻意不提供」+ 出路;删一行 ⇒ 检测器报红', () => {
  const play = read('PLAY.md');
  eq(playProblems(play), [], 'PLAY.md 的登记节必须自洽(每一条:动作 / 为什么 / 出路 / 今天)');

  const stale = play.replace(/\n\| `WIRE_EDIT` \|[^\n]*/g, '');
  ok(stale !== play, '前提:PLAY.md 里确实有 WIRE_EDIT 那一行');
  const problems = playProblems(stale);
  ok(problems.some((p) => p.includes('WIRE_EDIT')),
    `★ 删掉一行后必须点名它 ⇒ 检测器有牙齿,实际:${problems.join(' / ')}`);
});

/**
 * PLAY.md 登记节的问题清单 —— 返回非空即判红。
 *
 * 为什么查**关键词**而不是逐字比对整段:文案会改,但"每一条都在、都写了出路"不会改。
 */
function playProblems(play: string): string[] {
  const p: string[] = [];
  if (!play.includes('刻意不提供')) p.push('PLAY.md 没写「刻意不提供」这个裁决(会被读成"还没做")');
  if (!play.includes('CLIENT_ENTRY_HOLDS')) p.push('PLAY.md 没指向登记表 `CLIENT_ENTRY_HOLDS`(唯一状态源)');
  if (!play.includes('describeEntryReceipt')) p.push('PLAY.md 没写急单评级经 `describeEntryReceipt` 进状态条');
  if (!play.includes('RUSH_DELIVERY_RADIUS')) p.push('PLAY.md 没写交付半径(与 `G` 的脚下口径同源)');
  if (!play.includes('急单')) p.push('PLAY.md 没写急单(rush)');
  if (!play.includes('lane')) p.push('PLAY.md 没写分拣带的 `lane` 形态');
  for (const action of MANAGEMENT_ACTIONS) {
    /* 查的是**那一行**(`| \`ACTION\` |`),不是"这个词在文里出现过" ——
       否则删掉表格行也不报红(同一个词可能出现在别的句子里)。 */
    if (!play.includes(`| \`${action}\` |`)) p.push(`PLAY.md 没点名 ${action}(表体缺那一行)`);
  }
  return p;
}

/* ═══════════════════════════ 10 ═══════════════════════════ */

test('FND145-10 docs/WIRING-LEDGER.md 的入口段:10 行齐、理由与出路都非空;删行 ⇒ 判红', () => {
  const doc = read('docs/WIRING-LEDGER.md');
  eq(docProblems(doc), [], '文档台账的入口段必须逐条与代码台账对齐');

  const stale = doc.replace(/\n\| `WIRE_EDIT` \|[^\n]*/g, '');
  ok(stale !== doc, '前提:文档里确实有 WIRE_EDIT 那一行');
  ok(docProblems(stale).some((p) => p.includes('WIRE_EDIT')),
    '★ 删掉一行后必须点名它 ⇒ 检测器有牙齿');
});

/**
 * 文档**入口段**的问题清单。
 *
 * 口径:只认 `### 2.9.1` 这一节(§2.9 的符号级台账与 §2.10 的桶计数不在这里复核 ——
 * 那两块各有自己的判据,在这里顺手再数一遍只会制造第三份实现)。
 */
function docProblems(doc: string): string[] {
  const p: string[] = [];
  const at = doc.indexOf('### 2.9.1 客户端');
  if (at < 0) return ['docs/WIRING-LEDGER.md 少了客户端的**入口**台账一节(§2.9.1)'];
  const tail = doc.slice(at);
  const next = tail.indexOf('### 2.10');
  const section = next < 0 ? tail : tail.slice(0, next);

  if (!section.includes('CLIENT_ENTRY_LEDGER')) p.push('§2.9.1 没写唯一状态源 `CLIENT_ENTRY_LEDGER`');
  if (!section.includes('CLIENT_ENTRY_HOLDS')) p.push('§2.9.1 没写登记表 `CLIENT_ENTRY_HOLDS`');
  if (!section.includes('刻意不提供')) p.push('§2.9.1 没写「刻意不提供」这个裁决');
  for (const action of MANAGEMENT_ACTIONS) {
    if (!section.includes(`| \`${action}\` |`)) p.push(`§2.9.1 没点名 ${action}(表体缺那一行)`);
  }
  if (!section.includes('lane')) p.push('§2.9.1 没写分拣带的 `lane`');
  if (!section.includes('急单')) p.push('§2.9.1 没写急单');

  /* 逐行:表体每一行都得有 判定 / 为什么 / 出路 / 今天 四格且非空 */
  const rows = section.split('\n').filter((l) => l.startsWith('| `') || l.startsWith('| 急单') || l.startsWith('| 分拣带'));
  if (rows.length !== 10) p.push(`§2.9.1 的表体必须恰好 10 行(8 条管理类 + 急单 + lane),实际 ${rows.length}`);
  for (const line of rows) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const label = cells[0] ?? '?';
    if (cells.length !== 5) { p.push(`${label} 那一行不是 5 列(判定/为什么/出路/今天)`); continue; }
    if (!(cells[1] ?? '').startsWith('刻意不提供')) p.push(`${label} 的判定列不是「刻意不提供」`);
    if ((cells[2] ?? '').length < 10) p.push(`${label} 的"为什么"太短`);
    if ((cells[3] ?? '').length < 5) p.push(`${label} 没写"解锁它的那一件事"`);
    if ((cells[4] ?? '').length < 2) p.push(`${label} 没写"今天能做到哪一步"`);
  }
  return p;
}

report('WS-FND-145-client-entry-rest');