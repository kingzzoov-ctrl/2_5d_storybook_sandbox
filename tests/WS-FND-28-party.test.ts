/**
 * WS-FND-28 —— **派对赛开局**(`START_PARTY`:开局 → 计分 → 结算)。
 *
 * ## 这个套件为什么存在
 *
 * `START_PARTY` 在接线前是 `notImplemented(...)`(`server/src/net/actions/start_party.ts`),
 * 于是「开一局派对赛」在线上不存在:模式能选(`SET_PARTY_MODE` 已接线),但
 * **选了模式之后没有开局**,分数与名次没有任何一处登记。本套件钉的是新接的那条线:
 * ```
 *   SET_PARTY_MODE(选模式) → START_PARTY(开局) → addScore(计分) → endParty(结算名次)
 * ```
 *
 * ## 本套件钉的不是「回了 OK」,而是**状态与权限**
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 正常开局:回执 `OK` + `effect` 有模式/开始时刻/参局人数;**血量与背包一点没动** | 去掉 `authorize` 后的状态写入 / 把分数写成血量或物品 |
 * | 2 | 已在局中再开局 ⇒ `INVALID` **且原局不变** | 去掉 RUNNING 那道闸(第二局会覆盖第一局) |
 * | 3 | 未选模式 / 报文模式与房间不一致 / 越界下标 ⇒ `INVALID` 且**没有**开局 | 不读 `meta.partyMode` 就开局(默认开 NONE 局) |
 * | 4 | `addScore` 累加,**只影响该局**(另一局/另一房间不受影响) | 分数表不按 roomId 分桶 / 记在共享单例上 |
 * | 5 | 结算:`endParty` 返回名次(降序 + **同分确定顺序**),结算后不再计分 | 排序用插入序或 `localeCompare` |
 * | 6 | 越权(GUEST)⇒ `PERMISSION` **且没有开局** | 闸写在状态写入之后 |
 * | 7 | 结算后重开:新局分数从零(状态机 RUNNING → SETTLED → RUNNING) | 旧记录不清/分数跨局 |
 *
 * ⚠️ 夹具照 `tests/WS-FND-20-material-loop.test.ts`:**真装配**(`assemble()`)+
 *   `rt.dispatchAction`;模式由**真的** `SET_PARTY_MODE` 动作选(不手写
 *   `state.meta.partyMode` —— 那就绕开了唯一的选择路径)。断言风格参考
 *   `tests/WS-FND-25-craft.test.ts`(成功回执必须带 `effect`)。
 *
 * ⚠️ 时钟:`START_PARTY` 用**本模块**的可注入时钟(`setPartyClock`,手法同
 *   `sleep.ts` 的 `setSleepClock`),与房间时钟无关;这里注入一个可推进的假时钟,
 *   以断言「开始时刻」这件事,而不是断言 `Date.now` 附近。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome } from '../server/src/net/room.ts';
import { PartyMode } from '../server/src/db/repo.ts';
import {
  PartyPhase,
  addScore,
  clearPartyRegistry,
  endParty,
  partyStateOf,
  setPartyClock,
} from '../server/src/net/actions/start_party.ts';

/** 注入时钟:所有用例推进它来观察「开始时刻」,不真等一秒。 */
let NOW = 1_700_000_000_000;
setPartyClock(() => NOW);

/** 一次开局的 `effect` 声明形状(`Record<string, 基本类型>` ⇒ 这里显式窄化读它)。 */
type PartyEffect = { mode?: string; startedAtMs?: number; participants?: number; state?: string };

type Room = { rt: ReturnType<typeof assemble>['runtime'] };

/**
 * 真装配:生产入口 `assemble()`(不手搓 rtOpts —— 那会绕开 `assemble()`)。
 * `mobs: false`:本套件与怪物无关,不想让自发改刷的怪参与。
 */
function makeRoom(roomId: string, extra: readonly string[] = []): Room {
  const a = assemble({
    roomId,
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    mobs: false,
    rng: mulberry32(28),
  });
  /* 房主恒为 OWNER(`party` 位为 true);其余人默认 MEMBER(没有 `party` 位)。 */
  a.runtime.join({ userId: 'u_owner' });
  for (const id of extra) a.runtime.join({ userId: id });
  return { rt: a.runtime };
}

const disp = (
  rt: Room['rt'],
  actor: string,
  action: RoomAction,
  payload: Record<string, unknown> = {},
): ActionOutcome => rt.dispatchAction(actor, action, payload);

/** 用**真的**动作选模式(唯一的选择路径:`SET_PARTY_MODE`)。 */
function selectMode(rt: Room['rt'], mode: PartyMode): void {
  const r = disp(rt, 'u_owner', RoomAction.SET_PARTY_MODE, { partyMode: mode });
  eq(r.kind, 'OK', `测试前置:房主应能选模式 ${mode}(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
}

/** 取出成功回执的 `effect`;顺手钉住「OK 必须带 effect」。 */
function effectOf(r: ActionOutcome, label: string): PartyEffect {
  eq(r.ok, true, `${label}:应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', `${label}:成功路径必须是 OK`);
  ok(r.effect !== undefined, `${label}:★ \`OK\` 必须带 effect(不留"回 OK 却无副作用")`);
  return r.effect as PartyEffect;
}

/** 玩家血量投影(用来钉「本动作不写血量」)。 */
const hpOf = (rt: Room['rt'], id: string): number =>
  rt.state.players.find((p) => p.id === id)?.hp ?? -1;

/* ───────────────────────── 1 ───────────────────────── */

test('FND28-1 正常开局 ⇒ OK + effect(模式/开始时刻/参局人数),且血量与背包一点没动', () => {
  clearPartyRegistry();
  const RID = 'r_party_1';
  const { rt } = makeRoom(RID, ['u2']);
  selectMode(rt, PartyMode.BRIDGE_CTF);

  const hpBefore = hpOf(rt, 'u_owner');
  const bagBefore = rt.authoritativeItemTotal('u_owner');
  NOW += 1_234;

  const eff = effectOf(disp(rt, 'u_owner', RoomAction.START_PARTY), '开局');
  eq(eff.mode, 'BRIDGE_CTF', '★ effect 里必须是**房间已选**的模式');
  eq(eff.startedAtMs, NOW, '★ effect 里的开始时刻取自本模块注入的时钟');
  eq(eff.participants, 2, '★ 参局人数 = 开局时房间里的玩家数(u_owner + u2)');
  eq(eff.state, PartyPhase.RUNNING, '开局后相位是 RUNNING');

  const st = partyStateOf(RID);
  ok(st !== null, '★ 开局后应查得到赛局(否则"回了 OK 却没开局")');
  eq(st!.mode, PartyMode.BRIDGE_CTF, '赛局记录里的模式');
  eq(st!.state, PartyPhase.RUNNING, '赛局记录的相位');
  eq(st!.startedAtMs, NOW, '赛局记录里的开始时刻');
  eq(st!.scores.size, 0, '刚开局时应还没有人得分');

  eq(hpOf(rt, 'u_owner'), hpBefore, '★ 开局**不动**血量(血量权威在 WorldSim,不在这里)');
  eq(rt.authoritativeItemTotal('u_owner'), bagBefore,
    '★ 开局**不动**背包(背包权威在反作弊的总量守恒 + 凭证链)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND28-2 已在局中再开局 ⇒ INVALID,且原局一个字段都不变', () => {
  clearPartyRegistry();
  const RID = 'r_party_2';
  const { rt } = makeRoom(RID, ['u2']);
  selectMode(rt, PartyMode.JELLY_BALL);

  const first = effectOf(disp(rt, 'u_owner', RoomAction.START_PARTY), '第一局');
  eq(addScore(RID, 'u2', 5).ok, true, '前置:第一局里记 5 分');
  NOW += 60_000;

  const again = disp(rt, 'u_owner', RoomAction.START_PARTY);
  eq(again.ok, false, '★ 不许叠开第二局');
  eq(again.kind, 'INVALID', '★ 应归为 INVALID(状态不对,不是权限问题)');
  ok(String(again.reason ?? '').includes('已有一局'),
    `拒绝理由应说清「已有一局进行中」(实测 ${again.reason ?? '-'})`);
  eq(again.effect, undefined, '被拒的回执没有 effect');

  const st = partyStateOf(RID);
  ok(st !== null, '原局必须还在(不能被第二局的拒绝路径清掉)');
  eq(st!.startedAtMs, first.startedAtMs, '★ 原局的开始时刻不变');
  eq(st!.mode, PartyMode.JELLY_BALL, '★ 原局的模式不变');
  eq(st!.state, PartyPhase.RUNNING, '★ 原局仍在 RUNNING');
  eq(st!.scores.get('u2'), 5, '★ 原局的分数不变');
  eq(st!.participants.length, 2, '★ 原局的参局名单不变');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND28-3 未选模式 / 非法模式 ⇒ INVALID,且没有开局', () => {
  clearPartyRegistry();

  /* (a) 房间压根没选模式(`meta.partyMode = 0 = NONE`)。 */
  const a = 'r_party_3a';
  const ra = makeRoom(a, ['u2']);
  const r1 = disp(ra.rt, 'u_owner', RoomAction.START_PARTY);
  eq(r1.ok, false, '★ 没选模式不能开局(否则会开出一局 NONE 模式的赛)');
  eq(r1.kind, 'INVALID', '★ 应是 INVALID');
  ok(String(r1.reason ?? '').includes('未'),
    `理由应指出「尚未选定模式」(实测 ${r1.reason ?? '-'})`);
  eq(partyStateOf(a), null, '★ 被拒后**没有**赛局记录');

  /* (b) 没选模式时,报文点名一个模式也**不能**开局:模式的选择权在 SET_PARTY_MODE。 */
  const r2 = disp(ra.rt, 'u_owner', RoomAction.START_PARTY, { partyMode: PartyMode.PAINT_WAR });
  eq(r2.ok, false, '★ 本动作是「开局」不是「设模式」⇒ 报文点名也开不了局');
  eq(r2.kind, 'INVALID', '应是 INVALID');
  eq(partyStateOf(a), null, '★ 仍未开局');

  /* (c) 已选模式,但报文的 partyMode 与房间不一致(含"根本不是合法模式"的取值)⇒ 显式拒绝。 */
  const b = 'r_party_3b';
  const rb = makeRoom(b, ['u2']);
  selectMode(rb.rt, PartyMode.CROWN_BR);
  const r3 = disp(rb.rt, 'u_owner', RoomAction.START_PARTY, { partyMode: 'NOT_A_MODE' });
  eq(r3.ok, false, '★ 报文的 partyMode 不是房间已选模式时不能开局');
  eq(r3.kind, 'INVALID', '应是 INVALID');
  ok(String(r3.reason ?? '').includes('不一致'),
    `理由应指出与房间已选模式不一致(实测 ${r3.reason ?? '-'})`);
  eq(partyStateOf(b), null, '★ 仍未开局');

  /* (d) 下标越界(`meta.partyMode` 不是任何合法模式)⇒ 同样拒绝,不猜一个模式出来。 */
  const c = 'r_party_3c';
  const rc = makeRoom(c);
  selectMode(rc.rt, PartyMode.BRIDGE_CTF);
  rc.rt.state.meta.partyMode = 99;
  const r4 = disp(rc.rt, 'u_owner', RoomAction.START_PARTY);
  eq(r4.ok, false, '★ 越界下标不能当成"某种模式"开局');
  eq(r4.kind, 'INVALID', '应是 INVALID');
  eq(partyStateOf(c), null, '★ 仍未开局');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND28-4 计分:addScore 累加,且只影响该局', () => {
  clearPartyRegistry();
  const A = 'r_party_4a';
  const B = 'r_party_4b';
  const ra = makeRoom(A, ['u2']);
  const rb = makeRoom(B, ['u2']);
  selectMode(ra.rt, PartyMode.BRIDGE_CTF);
  selectMode(rb.rt, PartyMode.JELLY_BALL);
  disp(ra.rt, 'u_owner', RoomAction.START_PARTY);
  disp(rb.rt, 'u_owner', RoomAction.START_PARTY);

  const s1 = addScore(A, 'u_owner', 3);
  eq(s1.ok, true, '第一笔应记上');
  eq(s1.total, 3, '第一次累加 = 3');
  const s2 = addScore(A, 'u_owner', 4);
  eq(s2.total, 7, '★ 累加不是覆盖(3 + 4 = 7)');
  eq(addScore(A, 'u2', 2).total, 2, '另一名玩家独立计分');

  const sa = partyStateOf(A);
  eq(sa!.scores.get('u_owner'), 7, '★ A 局里 u_owner 累计 7');
  eq(sa!.scores.get('u2'), 2, '★ A 局里 u2 累计 2');

  /* 另一局完全不受影响:同名玩家在 B 局是另一份记录。 */
  const sb = partyStateOf(B);
  eq(sb!.scores.size, 0, '★ B 局的分数**不受** A 局影响');
  eq(addScore(B, 'u_owner', 100).total, 100, 'B 局从零开始(同名玩家不串分)');
  eq(partyStateOf(A)!.scores.get('u_owner'), 7, '★ A 局仍是 7');

  /* 没开局的房间:计分被显式拒绝,且不写任何状态。 */
  const none = addScore('r_party_4_none', 'u_owner', 1);
  eq(none.ok, false, '★ 没开局就不能计分');
  ok(String(none.reason ?? '').length > 0, '拒绝必须带理由');
  eq(partyStateOf('r_party_4_none'), null, '★ 被拒的计分不凭空造出赛局');

  /* 非有限数会毒化整张榜与排序 ⇒ 显式拒绝,且原分数不动。 */
  const bad = addScore(A, 'u_owner', Number.NaN);
  eq(bad.ok, false, '★ NaN 不能记分');
  eq(partyStateOf(A)!.scores.get('u_owner'), 7, '★ 被拒后分数不变');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND28-5 结算:endParty 返回名次(降序,同分有确定顺序)', () => {
  clearPartyRegistry();
  const RID = 'r_party_5';
  const { rt } = makeRoom(RID, ['u2', 'u3', 'u4']);
  selectMode(rt, PartyMode.CROWN_BR);
  disp(rt, 'u_owner', RoomAction.START_PARTY);

  /* 成绩:u3 = 9,u2 = u_owner = 5(同分!),u4 一分没得。 */
  addScore(RID, 'u3', 9);
  addScore(RID, 'u2', 5);
  addScore(RID, 'u_owner', 5);
  NOW += 500;

  const settle = endParty(RID);
  ok(settle !== null, '★ 进行中的局必须能结算(返回 null = 没结算)');
  eq(settle!.mode, PartyMode.CROWN_BR, '结算带出本局模式');
  eq(settle!.endedAtMs, NOW, '结算时刻取自本模块注入的时钟');

  /* 同分(u2 vs u_owner,都是 5)按 `userId` 码元序:'2'(0x32) < '_'(0x5F)。 */
  eq(settle!.ranking.map((r) => r.userId), ['u3', 'u2', 'u_owner', 'u4'],
    '★ 名次:分数降序;同分按 userId 码元序(u2 在 u_owner 前);零分玩家也进榜');
  eq(settle!.ranking.map((r) => r.score), [9, 5, 5, 0], '★ 名次对应的分数');
  eq(settle!.ranking.map((r) => r.rank), [1, 2, 3, 4], '名次从 1 起逐位排开(同分不同名)');

  const st = partyStateOf(RID);
  eq(st!.state, PartyPhase.SETTLED, '★ 结算后相位推到 SETTLED');
  eq(st!.endedAtMs, NOW, '记录里也带上了结算时刻');

  /* 结算后:不再计分、也不能重复结算。 */
  eq(addScore(RID, 'u3', 100).ok, false, '★ 结算后不再计分(否则名次谁最后报分谁赢)');
  eq(partyStateOf(RID)!.scores.get('u3'), 9, '★ 分数定格在结算那一刻');
  eq(endParty(RID), null, '★ 重复结算返回 null("结算了"与"没什么可结算"可区分)');
  eq(partyStateOf(RID)!.state, PartyPhase.SETTLED, '重复结算不改变相位');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND28-6 越权:GUEST 开不了局,分类是 PERMISSION 且没有开局', () => {
  clearPartyRegistry();
  const RID = 'r_party_6';
  const a = assemble({
    roomId: RID, ownerId: 'u_owner', clock: { nowMs: () => 0 }, sizeCells: 24, mobs: false,
    rng: mulberry32(28),
  });
  a.runtime.join({ userId: 'u_owner' });
  a.runtime.join({ userId: 'g', asGuest: true });
  const rt = a.runtime;
  /* 模式先选好 —— 这样被拒的原因只可能是权限,而不是"没选模式"。 */
  selectMode(rt, PartyMode.BRIDGE_CTF);

  const r = disp(rt, 'g', RoomAction.START_PARTY);
  eq(r.ok, false, 'GUEST 不能开局');
  eq(r.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(不是 INVALID —— 否则"越权"与"状态不对"混成一个值)');
  eq(r.effect, undefined, '被拒时没有 effect');
  eq(partyStateOf(RID), null, '★ 没有开局(闸必须在状态写入之前)');

  /* 负对照:OWNER 做同一件事应当成功(否则上面那条可能只是"这个动作本身坏了")。 */
  const owner = disp(rt, 'u_owner', RoomAction.START_PARTY);
  eq(owner.kind, 'OK', 'OWNER 开局应成功 —— 证明上面失败的是**权限**,不是动作本身');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND28-7 结算后重开:新局从零开始(开局 → 计分 → 结算 → 再开局)', () => {
  clearPartyRegistry();
  const RID = 'r_party_7';
  const { rt } = makeRoom(RID, ['u2']);
  selectMode(rt, PartyMode.PAINT_WAR);

  const first = effectOf(disp(rt, 'u_owner', RoomAction.START_PARTY), '第一局');
  addScore(RID, 'u_owner', 42);
  const settle = endParty(RID);
  eq(settle!.ranking.map((r) => r.userId)[0], 'u_owner', '前置:第一局 u_owner 第一');

  NOW += 10_000;
  const second = effectOf(disp(rt, 'u_owner', RoomAction.START_PARTY), '第二局');
  const st = partyStateOf(RID);
  eq(st!.state, PartyPhase.RUNNING, '★ 重开后回到 RUNNING');
  eq(st!.startedAtMs, NOW, '★ 新局的开始时刻是**新**的');
  ok(second.startedAtMs! > first.startedAtMs!, '第二局晚于第一局');
  eq(st!.scores.size, 0, '★ 旧分数**不跨局**(新局从零开始)');
  eq(addScore(RID, 'u2', 1).total, 1, '新局可以重新计分');
});

report('WS-FND-28');
