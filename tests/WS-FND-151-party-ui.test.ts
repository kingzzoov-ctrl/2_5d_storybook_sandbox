/**
 * WS-FND-151 —— **派对 UI 三件套**(模式面板 / 比分 HUD / 急行条件清单)的判据。
 *
 * ## 修的是什么
 *
 * `SET_PARTY_MODE` 在 `client/src/wiring_ledger.ts` 里长期是 `missing`,理由写得很具体:
 * 「四选一要**选择器 + 权限位**;裸键只能"轮到下一档"、没有确认」。本轮把那块 UI 补上:
 * ```
 * ui/party_panel.ts        档位/名字/规则/光标/命令(**纯**,名字来自冻结层 PARTY_MODES)
 * ui/panel_layout.ts       layoutPartyPanel / partyRowRect(纯布局)
 * ui/rush_readiness.ts     急行开工三条前置的三态(met / unmet / **unknown**)
 * three/ui_binding.ts      drawParty + 命中测试(只画不算)
 * three/boot.ts            M 开面板、J/L 移光标、Enter 发报文、点行同效
 * net/action_entry.ts      setPartyModeRequest ⇒ 恰好一条报文
 * main.ts                  端口注入(setPartyModeSink)
 * ```
 *
 * ## 判据的形状(为什么这么写)
 *
 * ```
 * 面板档数 = 冻结层档数(不是写死的 4)
 * 选中 ⇒ 假 socket 捕到**逐字段**正确的那一条(经生产的 sessionPorts + ActionEntry)
 * HUD 字段来自权威 meta;没有赛局 ⇒ 一条都不画
 * 急行三条各自正例 / 反例 / **未知例**(未知不许并进"没满足")
 * 键位互斥读**真表**(keyGroups),并给一条"故意重叠 ⇒ 报红"的负对照
 * 台账已翻成 wired 且登记已删(接线后还留登记 ⇒ 本仓自检当场红)
 * 手册/提示条与真表一致(删掉那段 ⇒ 检测器报红)
 * ```
 *
 * 运行:`node tests/WS-FND-151-party-ui.test.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';

import { PARTY_MODES } from '../shared/constants/bosses.ts';

import { ActionEntry, describeEntryReceipt } from '../client/src/net/action_entry.ts';
import { sessionPorts, type SessionLike } from '../client/src/net/action_binding.ts';
import {
  PARTY_MODE_COUNT,
  PARTY_MODE_ACTION,
  movePartyCursor,
  partyModeIntent,
  partyModeOptionAt,
  partyModeOptions,
  partyPanelOf,
} from '../client/src/ui/party_panel.ts';
import { partyHudOf } from '../client/src/ui/party_hud.ts';
import {
  RUSH_SNAPSHOT_GAP,
  RUSH_START_CONDITIONS,
  RushConditionState,
  rushConditionStateOf,
  rushReadinessOf,
  type RushReadinessInput,
} from '../client/src/ui/rush_readiness.ts';
import {
  layoutFitsViewport,
  layoutPartyPanel,
  partyRowRect,
} from '../client/src/ui/panel_layout.ts';
import {
  PANEL_KEYS,
  PARTY_PANEL_KEYS,
  PARTY_SELECT_KEYS,
  keyCollisions,
  keyGroups,
  keyGroupsExclusive,
  panelKeyOf,
} from '../client/src/ui/panel_keys.ts';
import {
  CLIENT_ENTRY_HOLDS,
  CLIENT_ENTRY_LEDGER,
  ClientEntryStatus,
  ClientHoldKind,
  clientEntryRow,
  clientEntryWitnessOf,
  validateClientEntryHolds,
  validateClientEntryLedger,
} from '../client/src/wiring_ledger.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** 剥注释(口径与 `WS-FND-138` / `WS-FND-145` 一致:`//` 前排除 `:`)。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

type WireIntent = { action: string; [k: string]: unknown };

interface FakeSocket {
  session: SessionLike;
  sent: WireIntent[];
  link: { state: string; accept: boolean };
}

/**
 * **假 socket** —— 「选中 → 真的发出去一条什么」的唯一证据来源。
 *
 * 只实现 `SessionLike` 的结构(`state` + `sendAction`),再由**生产的**
 * `sessionPorts()` 适配进 `ActionEntry` ⇒ 被测的是生产那段判定,不是替身逻辑。
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

/** 生产路径:假 socket → `sessionPorts` → `ActionEntry` */
function mkEntry(sock: FakeSocket): ActionEntry {
  return new ActionEntry(sessionPorts(() => sock.session));
}
/* ═══════════════════════════ 1 ═══════════════════════════ */

test('FND151-1 面板列出的档数与冻结层 `PARTY_MODES` 一致,名字/规则逐条来自它(不手抄)', () => {
  const opts = partyModeOptions();
  eq(opts.length, PARTY_MODES.length, '面板档数 = `PARTY_MODES.length`(不是写死的 4)');
  eq(PARTY_MODE_COUNT, PARTY_MODES.length, '导出的档数常量同源');
  ok(PARTY_MODES.length >= 2, `前提:冻结层至少两个模式(实际 ${PARTY_MODES.length})`);

  for (let i = 0; i < PARTY_MODES.length; i += 1) {
    const frozen = PARTY_MODES[i]!;
    const o = opts[i]!;
    eq(o.mode, i + 1, `第 ${i} 项的线上下标 = ${i + 1}(0 = 没有派对,见 party_hud)`);
    eq(o.key, frozen.key, `${i}: key 逐字来自冻结层`);
    eq(o.name, frozen.name, `${i}: 名字逐字来自冻结层(客户端不另抄一份)`);
    eq(o.rule, frozen.note, `${i}: 一句话规则 = 冻结层的 note`);
    ok(o.text.includes(frozen.name) && o.text.includes(frozen.note),
      `${i}: 面板那一行同时含名字与规则(实际 ${o.text})`);
  }

  /* 越界不猜:0 / 越界 / NaN 一律 null */
  eq(partyModeOptionAt(0), null, '0 档 ⇒ null(0 是"没有派对",不是第一档)');
  eq(partyModeOptionAt(PARTY_MODES.length + 1), null, '越界 ⇒ null');
  eq(partyModeOptionAt(Number.NaN), null, 'NaN ⇒ null(不回落第一档)');
  eq(partyPanelOf({ partyMode: 0 }, 0).rows.length, PARTY_MODES.length,
    '面板行数同样等于冻结层档数');
});

/* ═══════════════════════════ 2 ═══════════════════════════ */

test('FND151-2 选中某一档 ⇒ 假 socket 捕到**恰好一条** `SET_PARTY_MODE`(逐字段)', () => {
  const sock = fakeSocket();
  const entry = mkEntry(sock);

  /* 选中第二档(经面板的 intent,与 Enter 键走同一条路) */
  const intent = partyModeIntent(2);
  ok(intent !== null, '第 2 档有 intent');
  eq(intent, { action: 'SET_PARTY_MODE', partyMode: PARTY_MODES[1]!.key },
    '★ intent 逐字段:`action` + `partyMode` = 冻结层 key(不是下标)');

  const out = entry.setPartyMode({ partyMode: intent!.partyMode });
  eq(out.sent, true, '★ 真的发出去了(不是"按了没反应")');
  eq(out.code, 'OK', 'code 是 OK');
  eq(sock.sent, [{ partyMode: PARTY_MODES[1]!.key, action: 'SET_PARTY_MODE' }],
    '★ 线上是**扁平一层**:恰好一条报文、两个键、值逐字正确');
  ok(!Object.prototype.hasOwnProperty.call(sock.sent[0]!, 'payload'),
    '线上不许出现 payload 这个键(`ActionEntry.submit` 已经铺平)');
  eq(entry.sentCount, 1, '入口自己的计数 = 1(自检口径)');
  ok(out.status.includes('派对模式'), `状态行要用玩家读得到的名字(实际:${out.status})`);

  /* 越界档:不发 */
  eq(partyModeIntent(99), null, '越界档 ⇒ 没有 intent(不发注定被拒的报文)');
  eq(sock.sent.length, 1, '越界后假 socket 上仍然只有那一条');

  /* 参数不全:入口就地拒,且**有话说** */
  const bad = entry.setPartyMode({});
  eq(bad.sent, false, '缺 partyMode ⇒ 不发');
  eq(bad.code, 'INVALID_INPUT', '分档是 INVALID_INPUT(不是"未连接")');
  ok(bad.status.length > 10, `拒绝必须有一句可读理由(实际:${bad.status})`);
  eq(sock.sent.length, 1, '被拒时一条报文都不许多');

  /* 未连接:发不出,但要如实说 */
  const offline = fakeSocket({ state: 'idle' });
  const offEntry = mkEntry(offline);
  const off = offEntry.setPartyMode({ partyMode: PARTY_MODES[0]!.key });
  eq(off.sent, false, '未连接 ⇒ 不发');
  eq(off.code, 'NOT_CONNECTED', '分档是 NOT_CONNECTED');
  eq(offline.sent, [], '假 socket 上 0 条');
  ok(off.status.includes('未连接'), `状态行点名"未连接"(实际:${off.status})`);

  /* 回执:玩家读得到「派对模式」而不是原始动作名 */
  const line = describeEntryReceipt({ action: 'SET_PARTY_MODE', ok: true, kind: 'OK', effect: { partyMode: 'BRIDGE_CTF' } });
  ok(line.startsWith('派对模式'), `回执行以「派对模式」开头(实际:${line})`);
  ok(line.includes('partyMode=BRIDGE_CTF'), `回执带服务端回读的 partyMode(实际:${line})`);
});

/* ═══════════════════════════ 3 ═══════════════════════════ */

test('FND151-3 面板的「当前档 / 光标」全部来自权威 `meta.partyMode` + 纯函数', () => {
  /* 没选:没有当前档,光标仍在第一行 */
  const none = partyPanelOf({ partyMode: 0 }, 0);
  eq(none.currentMode, 0, '未选 ⇒ currentMode = 0');
  eq(none.currentName, null, '未选 ⇒ currentName = null(不假装已选)');
  eq(none.rows.filter((r) => r.current), [], '未选 ⇒ 没有任何行被标成"当前"');
  ok(none.currentText.includes('未选'), `标题如实写"未选"(实际:${none.currentText})`);

  /* 权威改成第 3 档 ⇒ 高亮跟着走(不在客户端缓存) */
  const third = partyPanelOf({ partyMode: 3 }, 0);
  eq(third.currentName, PARTY_MODES[2]!.name, '当前档名 = 冻结层第 3 个模式名');
  eq(third.rows.map((r) => r.current), [false, false, true, false], '只有第 3 行标"当前"');
  eq(third.rows.map((r) => r.cursor), [true, false, false, false], '光标在第 0 行(J/L 才动它)');

  /* 越界下标(线上污染值)= 没有当前档,不是"最后一档" */
  const bogus = partyPanelOf({ partyMode: PARTY_MODES.length + 3 }, 1);
  eq(bogus.currentName, null, '越界下标 ⇒ 没有当前档');
  eq(bogus.rows.filter((r) => r.current), [], '越界下标 ⇒ 一行都不高亮');

  /* 光标:夹紧 + 循环移动 */
  eq(movePartyCursor(0, -1), PARTY_MODES.length - 1, '从第一行往上 ⇒ 循环到最后一行');
  eq(movePartyCursor(PARTY_MODES.length - 1, 1), 0, '从最后一行往下 ⇒ 回到第一行');
  eq(partyPanelOf({ partyMode: 1 }, 99).cursor, PARTY_MODES.length - 1, '越界光标夹到最后一行');
  eq(partyPanelOf({ partyMode: 1 }, -5).cursor, 0, '负数光标夹到 0');

  /* 选中项 = 光标那一行(Enter 会发的就是它) */
  eq(partyPanelOf({ partyMode: 1 }, 2).selected?.key, PARTY_MODES[2]!.key,
    'selected = 光标那一行的冻结层 key');
  eq(PARTY_MODE_ACTION, 'SET_PARTY_MODE', '动作名常量 = 服务端 RoomAction.SET_PARTY_MODE');
});

/* ═══════════════════════════ 4 ═══════════════════════════ */

test('FND151-4 比分 HUD:字段来自权威 meta;**没有赛局 ⇒ 不显示**', () => {
  const idle = partyHudOf({ partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 });
  eq(idle.active, false, '★ 没有赛局 ⇒ active = false');
  eq(idle.text, '', '★ 没有赛局 ⇒ 一行文本都不给(调用方据此不画)');
  eq([idle.modeName, idle.timerSec, idle.scoreA, idle.scoreB], [null, 0, 0, 0],
    '没有赛局时四个字段都是"空"(而不是编一个模式名)');

  const meta = { partyMode: 2, partyTimer: 41.2, scoreA: 3, scoreB: 5 };
  const live = partyHudOf(meta);
  eq(live.active, true, '有赛局 ⇒ active = true');
  eq(live.modeName, PARTY_MODES[1]!.name, '模式名 = 冻结层第 2 个模式(下标 1 起)');
  eq(live.timerSec, 42, '剩余秒数向上取整(41.2 ⇒ 42;显示 0 秒但还没结算会被读成卡住)');
  eq([live.scoreA, live.scoreB], [3, 5], '比分原值来自权威 meta');
  ok(live.text.includes(PARTY_MODES[1]!.name) && live.text.includes('42'),
    `一行文本含模式名与剩余秒(实际:${live.text})`);
  ok(live.text.includes('红 3 : 5 蓝'), `一行文本含红蓝比分(实际:${live.text})`);

  /* 比分 0 照实显示(省略会让"0 分"与"还没比分"变得不可区分) */
  const zero = partyHudOf({ partyMode: 1, partyTimer: 10, scoreA: 0, scoreB: 0 });
  ok(zero.text.includes('红 0 : 0 蓝'), `0 分照实写(实际:${zero.text})`);

  /* 越界模式下标 ⇒ 当作"没有赛局"(不画),而不是猜一个名字 */
  const bogus = partyHudOf({ partyMode: PARTY_MODES.length + 1, partyTimer: 5, scoreA: 1, scoreB: 1 });
  eq(bogus.active, false, '越界下标 ⇒ 不显示');
  eq(bogus.text, '', '越界下标 ⇒ 文本为空');
});

/* ═══════════════════════════ 5 ═══════════════════════════ */

test('FND151-5 急行三条前置:各自**正例 / 反例 / 未知例**,未知不并进"没满足"', () => {
  eq(RUSH_START_CONDITIONS.map((c) => c.id), ['canteen', 'stations', 'actorAtStation'],
    '三条条件的顺序与 `world_sim.stepRushEntry` 的判序一致(食堂 → 三工位 → 站格)');
  eq(RUSH_START_CONDITIONS.length, 3, '恰好三条');

  /* 未知:只认字面布尔 */
  eq(rushConditionStateOf(undefined), RushConditionState.UNKNOWN, 'undefined ⇒ 未知');
  eq(rushConditionStateOf(null), RushConditionState.UNKNOWN, 'null ⇒ 未知');
  eq(rushConditionStateOf(1), RushConditionState.UNKNOWN, '1 ⇒ 未知(不把真值当"满足")');
  eq(rushConditionStateOf('true'), RushConditionState.UNKNOWN, "字符串 'true' ⇒ 未知");
  eq(rushConditionStateOf(true), RushConditionState.MET, 'true ⇒ 满足');
  eq(rushConditionStateOf(false), RushConditionState.UNMET, 'false ⇒ 不满足');

  /* 全未知(今天的生产输入) */
  const allUnknown = rushReadinessOf({}, RUSH_SNAPSHOT_GAP);
  eq([allUnknown.met, allUnknown.unmet, allUnknown.unknown], [0, 0, 3],
    '★ 三项全未知:met=0 / **unmet=0** / unknown=3(未知不许并进 unmet)');
  ok(allUnknown.text.includes('未知'), `文本必须写"未知"(实际:${allUnknown.text})`);
  ok(allUnknown.note.includes('快照'), `未知必须带原因(实际:${allUnknown.note})`);
  eq(allUnknown.rows.map((r) => r.mark), ['?', '?', '?'], '未知的行首是 `?`(不是空白)');

  /* 逐项正例:把某一项喂 true ⇒ 该项 met,其它两项未知 */
  const inputs: ReadonlyArray<readonly [string, string]> = [
    ['canteen', 'canteen'], ['stations', 'stations'], ['actorAtStation', 'actorAtStation'],
  ];
  const withInput = (key: string, v: boolean): ReturnType<typeof rushReadinessOf> =>
    rushReadinessOf({ [key]: v } as RushReadinessInput, RUSH_SNAPSHOT_GAP);
  for (const [id, key] of inputs) {
    const v = withInput(key, true);
    eq(v.rows.find((r) => r.id === id)?.state, RushConditionState.MET, `${id} 正例 ⇒ met`);
    eq(v.met, 1, `${id} 正例 ⇒ met 计数 = 1`);
    eq(v.unknown, 2, `${id} 正例 ⇒ 其它两项仍是未知`);
    eq(v.rows.find((r) => r.id === id)?.mark, '✓', `${id} 正例的行首是 ✓`);

    const f = withInput(key, false);
    eq(f.rows.find((r) => r.id === id)?.state, RushConditionState.UNMET, `${id} 反例 ⇒ unmet`);
    eq(f.unmet, 1, `${id} 反例 ⇒ unmet 计数 = 1`);
    eq(f.met, 0, `${id} 反例 ⇒ met 计数仍 0`);
    eq(f.rows.find((r) => r.id === id)?.mark, '✗', `${id} 反例的行首是 ✗`);
    ok(f.note !== '', '还有未知项时,原因**仍然**带出来(不因"有一条已知"就丢掉未知)');
  }

  /* 已知全满足 ⇒ 没有未知项,也就不该挂一句"未知原因" */
  const allMet = rushReadinessOf({ canteen: true, stations: true, actorAtStation: true }, RUSH_SNAPSHOT_GAP);
  eq([allMet.met, allMet.unmet, allMet.unknown], [3, 0, 0], '三项全满足 ⇒ 3/3');
  eq(allMet.note, '', '未知 0 项 ⇒ 不带"未知原因"');
  ok(allMet.text.includes('3/3'), `文本写 3/3(实际:${allMet.text})`);

  /* 已知全不满足 */
  const allUnmet = rushReadinessOf({ canteen: false, stations: false, actorAtStation: false }, RUSH_SNAPSHOT_GAP);
  eq([allUnmet.met, allUnmet.unmet, allUnmet.unknown], [0, 3, 0], '三项全不满足 ⇒ unmet=3 / unknown=0');
  eq(allUnmet.rows.map((r) => r.state), ['unmet', 'unmet', 'unmet'], '三行都是 unmet');
});

/* ═══════════════════════════ 6 ═══════════════════════════ */

test('FND151-6 键位不冲突:读 `panel_keys.keyGroups()` 的真表,并给"故意重叠 ⇒ 报红"的负对照', () => {
  eq(keyGroupsExclusive(), true, '★ 全部键位组互斥(没有任何键同时绑两件事)');
  eq(keyCollisions(), [], '冲突清单为空');

  eq(panelKeyOf('m'), 'PARTY', '`m` 打开模式面板');
  eq(PANEL_KEYS.m, 'PARTY', '`PANEL_KEYS.m` = PARTY(唯一一处键表)');
  eq([PARTY_PANEL_KEYS.prev, PARTY_PANEL_KEYS.next, PARTY_PANEL_KEYS.confirm], ['j', 'l', 'enter'],
    '面板选中键 = J / L / Enter(空闲字母 {j,l,m} 里的两个 + Enter)');

  /* 面板键 / 选中键都不在别的组里 —— 逐组点名(不是"看起来不冲突") */
  const groups = keyGroups();
  for (const key of ['m', ...PARTY_SELECT_KEYS]) {
    const owners = groups.filter((g) => g.keys.includes(key)).map((g) => g.name);
    eq(owners.length, 1, `键 \`${key}\` 恰好属于一个组(实际:${owners.join(' / ')} 共 ${owners.length} 个)`);
  }
  /* `1..4` 仍只属于 HOTBAR(模式键**不是**数字键,否则一次按键两件事) */
  for (const digit of ['1', '2', '3', '4']) {
    const owners = groups.filter((g) => g.keys.includes(digit)).map((g) => g.name);
    ok(owners.length === 1 && owners[0]!.startsWith('HOTBAR_KEYS'),
      `\`${digit}\` 只属于 HOTBAR_KEYS(实际:${owners.join(' / ')})`);
  }

  /* 负对照:把模式键硬塞进面板组 ⇒ 检测器必须报红(否则"空数组"可能恒真) */
  const broken = [...groups, { name: 'PANEL_KEYS(故意重复 `j`)', keys: ['j'] }];
  const coll = keyCollisions(broken);
  ok(coll.some((c) => c.key === 'j'), '★ 注入重复的 `j` ⇒ 必须点名 `j`');
  eq(keyGroupsExclusive(broken), false, '注入后总判据转假 ⇒ 上面那条不是恒真');
});

/* ═══════════════════════════ 7 ═══════════════════════════ */

test('FND151-7 面板布局:三档视口都不越界,行矩形落在面板内', () => {
  const viewports: Array<[number, number]> = [[1280, 720], [640, 480], [360, 360]];
  for (const [w, h] of viewports) {
    const L = layoutPartyPanel(w, h, PARTY_MODES.length);
    ok(layoutFitsViewport(L, w, h), `${w}×${h}:面板必须落在视口内`);
    eq(L.rows.length, L.visibleRows, `${w}×${h}:可见行数 = 行矩形数`);
    for (let i = 0; i < L.rows.length; i += 1) {
      const r = partyRowRect(L, i);
      ok(r !== null, `${w}×${h}:第 ${i} 行有矩形`);
      ok(r!.y >= L.panel.y && r!.y + r!.h <= L.panel.y + L.panel.h,
        `${w}×${h}:第 ${i} 行在面板纵向范围内`);
      ok(r!.x >= L.panel.x && r!.x + r!.w <= L.panel.x + L.panel.w,
        `${w}×${h}:第 ${i} 行在面板横向范围内`);
    }
    ok(L.footer.y + L.footer.h <= L.panel.y + L.panel.h, `${w}×${h}:底部提示条在面板内`);
    ok(L.visibleRows >= 1, `${w}×${h}:至少画得下一行`);
  }
  /* 桌面档:4 档全部画得下;越界行返回 null(不画到面板外) */
  const desk = layoutPartyPanel(1280, 720, PARTY_MODES.length);
  eq(desk.visibleRows, PARTY_MODES.length, '桌面 1280×720 一屏画得下全部模式');
  eq(desk.scrollable, false, '画得下 ⇒ 不需要翻页');
  eq(partyRowRect(desk, PARTY_MODES.length), null, '越界行 ⇒ null');
  eq(partyRowRect(desk, -1), null, '负下标 ⇒ null');
});

/* ═══════════════════════════ 8 ═══════════════════════════ */

test('FND151-8 台账:`SET_PARTY_MODE` 已翻成 wired,且登记已删(接线后不许还留登记)', () => {
  const row = clientEntryRow('SET_PARTY_MODE');
  ok(row !== null, '`SET_PARTY_MODE` 仍在 `CLIENT_ENTRY_LEDGER` 里(逐条覆盖 RoomAction)');
  eq(row!.status, ClientEntryStatus.WIRED, '★ 状态已从 missing 翻成 wired(UI 已存在)');
  ok(row!.entry !== 'missing', `entry 要点名入口(实际:${row!.entry})`);
  ok(clientEntryWitnessOf('SET_PARTY_MODE') !== '', '★ wired 必须有见证片段');

  const hold = CLIENT_ENTRY_HOLDS.find((x) => x.action === 'SET_PARTY_MODE');
  eq(hold, undefined, '★ 「刻意不提供」的登记必须删掉(已接线还留登记 ⇒ 自检红)');

  /* 整张台账 / 登记自检仍绿 */
  eq(validateClientEntryLedger().errors, [], '台账自检绿');
  eq(validateClientEntryHolds().errors, [], '登记自检绿');
  ok(CLIENT_ENTRY_LEDGER.length > 20, `台账没被削短(实际 ${CLIENT_ENTRY_LEDGER.length} 条)`);

  /* 负对照:把它重新登记为"刻意不提供" ⇒ 必须报红 */
  const back = validateClientEntryHolds(CLIENT_ENTRY_LEDGER, [
    ...CLIENT_ENTRY_HOLDS,
    {
      action: 'SET_PARTY_MODE',
      kind: ClientHoldKind.DELIBERATE,
      why: '故意把已接线的动作重新登记,用来证明这条自检有牙齿(它必须报红)',
      unblock: '不适用',
      today: '不适用',
    },
  ]);
  eq(back.ok, false, '★ 已接线却重新登记 ⇒ 必须判红');
  ok(back.errors.some((e) => e.includes('SET_PARTY_MODE')), '报错要点名 SET_PARTY_MODE');
});

/* ═══════════════════════════ 9 ═══════════════════════════ */

test('FND151-9 键盘链路在 boot.ts:走 panel_keys 的键表,且**在输入态之后**(key_guard 同口径)', () => {
  const boot = stripComments(read('client/src/three/boot.ts'));

  ok(boot.includes('panelKeyOf(key)'), '面板键走 `panelKeyOf` 查表(M 与 I/R/H/P 同一张表)');
  ok(boot.includes('PARTY_PANEL_KEYS.prev') && boot.includes('PARTY_PANEL_KEYS.next') && boot.includes('PARTY_PANEL_KEYS.confirm'),
    'J / L / Enter 三个键都从 `PARTY_PANEL_KEYS` 读(不手写第二份)');
  ok(boot.includes('selectPartyMode(partyCursor + 1)'), 'Enter ⇒ 选中光标那一档');
  ok(boot.includes('selectPartyMode(hit.mode)'), '★ 点面板里的行 ⇒ 同一条路(不是两条实现)');
  ok(boot.includes('uiFsm.activePanel === UiPanel.PARTY'), '只有面板开着时才吃 J/L/Enter');

  /* ★ 输入避让:搜索态(文本输入)必须**先 return**,否则打字会误选模式 */
  const guard = boot.indexOf('if (searchMode) {');
  const partyKeys = boot.indexOf('PARTY_PANEL_KEYS.prev');
  ok(guard > 0, 'boot.ts 里有搜索态分支');
  ok(partyKeys > guard, `★ 模式面板按键必须排在搜索态分支**之后**(实际 ${partyKeys} vs ${guard})`);
  /* 单机 / 未注入端口:如实说,不静默 */
  ok(boot.includes('未联机'), '没有注入端口时也**有话说**(不是"按了没反应")');
  ok(boot.includes('rushReadinessOf(') && boot.includes('RUSH_SNAPSHOT_GAP'),
    '急行条件清单在 boot 里真的被算(未知原因也带出来)');
  ok(boot.includes('partyPanelOf(authority.state.meta'), '模式面板的数据取自**权威** meta');
});

/* ═══════════════════════════ 10 ═══════════════════════════ */

test('FND151-10 手册与提示条同步:PLAY.md / index.html 写清新键位与面板;删掉 ⇒ 检测器报红', () => {
  const play = read('PLAY.md');
  const html = read('client/index.html');

  eq(playProblems(play), [], 'PLAY.md 必须点名新键位 / 面板 / 急行三态');
  eq(hintProblems(html), [], 'index.html 的提示条必须含 `M` 与 `SET_PARTY_MODE`');

  /* 负对照:删掉那一节 ⇒ 检测器必须报红 */
  const stale = play.replace(/\n### 派对模式面板[\s\S]*$/, '\n');
  ok(stale !== play, '前提:PLAY.md 里确实有那一节');
  ok(playProblems(stale).length > 0, '★ 删掉那一节后必须报红 ⇒ 检测器有牙齿');

  const staleHtml = html.replace(/M 派对模式面板[^·]*/, '');
  ok(staleHtml !== html, '前提:提示条里确实有 `M 派对模式面板`');
  ok(hintProblems(staleHtml).length > 0, '★ 删掉提示条那一段后必须报红');
});

function playProblems(play: string): string[] {
  const p: string[] = [];
  if (!play.includes('派对模式面板')) p.push('PLAY.md 没写「派对模式面板」');
  if (!play.includes('`M`')) p.push('PLAY.md 没点名 `M` 键');
  if (!play.includes('`J`') || !play.includes('`L`') || !play.includes('`Enter`')) {
    p.push('PLAY.md 没写选中键(`J` / `L` / `Enter`)');
  }
  if (!play.includes('SET_PARTY_MODE')) p.push('PLAY.md 没写 `SET_PARTY_MODE`(选了之后到底发什么)');
  if (!play.includes('急行')) p.push('PLAY.md 没写急行开工条件');
  if (!play.includes('未知')) p.push('PLAY.md 没写"拿不到权威值就报未知"(不许假装 0)');
  if (!play.includes('ui/party_panel.ts')) p.push('PLAY.md 没指向选择器的实现文件');
  if (!play.includes('ui/rush_readiness.ts')) p.push('PLAY.md 没指向急行条件的实现文件');
  return p;
}

function hintProblems(html: string): string[] {
  const p: string[] = [];
  if (!html.includes('M 派对模式面板')) p.push('index.html 的提示条没写 `M 派对模式面板`');
  if (!html.includes('SET_PARTY_MODE')) p.push('index.html 的提示条没写 `SET_PARTY_MODE`');
  if (!html.includes('急行')) p.push('index.html 的提示条没写左下角那条急行条件');
  if (!html.includes('J/L')) p.push('index.html 的提示条没写 `J/L` 选');
  return p;
}

/* ═══════════════════════════ 11 ═══════════════════════════ */

test('FND151-11 面板的档位顺序与服务端设模式的入参同源(不靠"看着对")', () => {
  /* 服务端动作层:读的是 `ctx.payload.partyMode`,并原样交给 `setPartyModeBy` */
  const admin = stripComments(read('server/src/net/actions/admin.ts'));
  ok(admin.includes('ctx.payload.partyMode'), '★ 服务端设模式读 **payload.partyMode**(键名只有一个出处)');
  ok(admin.includes('setPartyModeBy(ctx.actorId, mode)'), '服务端把它原样交给 setPartyModeBy');

  /* 服务端把下标写进 `meta.partyMode`,值表顺序 = `PartyMode` 枚举顺序 */
  const room = stripComments(read('server/src/net/room.ts'));
  ok(room.includes('Object.values(PartyMode).indexOf(mode)'),
    '★ 线上下标 = `Object.values(PartyMode)` 的下标(客户端的 1 起换算据此)');

  /* 客户端发的是**冻结层 key**,不是下标 —— 逐条比对 */
  for (let i = 1; i <= PARTY_MODES.length; i += 1) {
    eq(partyModeIntent(i)?.partyMode, PARTY_MODES[i - 1]!.key, `第 ${i} 档发的是 ${PARTY_MODES[i - 1]!.key}`);
    ok(typeof partyModeIntent(i)?.partyMode === 'string', '载荷是字符串(不是下标)');
  }

  /* 急行三条前置在世界侧确有实现(客户端只是"报",不是自己开工) */
  const world = stripComments(read('server/src/sim/world_sim.ts'));
  ok(world.includes('stepRushEntry'), '世界侧有 `stepRushEntry`(开工判定不在客户端)');
  ok(world.includes("COZY_CANTEEN"), '世界侧判「食堂建成」');
  ok(world.includes('gateRushStart'), '世界侧走 `gateRushStart`(三条前置的唯一闸口)');
});

/* ═══════════════════════════ 12 ═══════════════════════════ */

test('FND151-12 模式面板不是"开局":`V`(START_PARTY)与设模式各走各的', () => {
  const sock = fakeSocket();
  const entry = mkEntry(sock);
  const start = entry.startParty({});
  eq(start.sent, true, '`START_PARTY` 仍发得出去');
  eq(sock.sent[0]!.action, 'START_PARTY', '第 1 条是开局动作');
  ok(!Object.prototype.hasOwnProperty.call(sock.sent[0]!, 'partyMode'),
    '开局**不带** partyMode(不知道房间已选什么就不声称,见 main.ts 的回声说明)');

  entry.setPartyMode({ partyMode: PARTY_MODES[0]!.key });
  eq(sock.sent[1]!, { partyMode: PARTY_MODES[0]!.key, action: 'SET_PARTY_MODE' },
    '第 2 条才是设模式(两个动作分得清楚)');
  eq(sock.sent.length, 2, '两次触发恰好两条报文(没有互相顶替)');

  /* 面板的提示行要**点名**发的是哪个动作(玩家知道自己在改赛制) */
  ok(partyPanelOf({ partyMode: 0 }, 0).hint.includes('SET_PARTY_MODE'),
    '面板底部提示写明"Enter 会发 SET_PARTY_MODE"');
  ok(partyPanelOf({ partyMode: 0 }, 0).hint.includes('Esc'), '面板提示写明 Esc 关闭');
});

report('WS-FND-151-party-ui');