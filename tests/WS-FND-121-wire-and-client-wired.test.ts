/**
 * WS-FND-121 / 第六轮实测的六个 P1/P2/P3:**线语义 + 客户端接线**
 *
 * 本套件只查两类东西,而且**每条都带负对照**(检测器必须能对坏样本报红):
 *
 * | # | 判据 | 负对照(证明这条有牙齿) |
 * |---|------|--------------------------|
 * | 1 | `FULL` 是**整体替换**(旧快照独有的 player/wildlife/boss 不残留) | 把同一份报文按修前的 merge 语义(op 改成 DELTA)应用 ⇒ 幽灵实体**确实**出现 |
 * | 2 | `FULL` 的房间级 meta 也整体替换(party/score 不残留) | 同一 base + 一份**没有 ROOM upsert** 的 DELTA ⇒ meta 保留 |
 * | 3 | `DELTA` 的 `removed` 仍然真的删实体(修复没破坏删除路径) | `encodeDelta(prev, prev)`(无删除)⇒ 实体全留 |
 * | 4 | 客户端 store 端到端:重连的第二份 FULL 之后没有幽灵 | 非法 op 的坏包 ⇒ `decode-failed` 且**状态对象不变** |
 * | 5 | `applyPacket(empty, encodeFull(st))` 与原状态逐字段一致(round-trip 不破) | `encodeFull` 的 `stats.removed` 恒 0(证明编码侧无法表达删除) |
 * | 6 | Boss HUD 的比例/阶段**随权威状态变**,且**不随时间伪造** | 空 `bosses` ⇒ `null`(不编一个满血条);同样输入两次 ⇒ 逐字段相同 |
 * | 7 | 线上 `telegraphShape` 数字 → 渲染几何的映射 | 未知值(99)必须 `null`,**不许**兜底成 CIRCLE |
 * | 8 | 派对/比分 HUD 按 wire 下标出模式名 + 计时 + 比分 | `mode = 0` ⇒ `active=false`/`text=''`;未知下标 ⇒ 不认(不编名字) |
 * | 9 | 背包搜索可达(`FilterOptions.query` 真的过滤) | 空查询的结果数 ≥ 任意查询 ⇒ 说明过滤器不是恒真/恒假 |
 * | 10 | `DragController.drop()` 能成交;生产里有调用点(`dragCtl.drop(hover)`) | 修前路径(只 `cancel()`)⇒ `drop()` 返回 `null`(永远不会成交) |
 * | 11 | 6 档缩放:`stepZoom` 从 1 能到 2、再回到 0.5,且生产里有写点 | 只有读点的源码样本必须被判为"未接" |
 * | 12 | 接线台账双向核对:`wired` 有见证片段、`blocked` 真的 0 调用点 | 伪造一条"wired 却无见证"和一条"blocked 却有调用点"的条目 ⇒ 检测器报红 |
 * | 13 | `#hint` 与 `invQuery` 都有写点(不再是死元素/死字段) | 修前的 boot 样本(两处都没有)⇒ 检测器判红 |
 *
 * 运行:`node tests/WS-FND-121-wire-and-client-wired.test.ts`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, eq, ok, report } from '../shared/testing/harness.ts';

import {
  PacketOp,
  applyPacket,
  decodePacket,
  encodeDelta,
  encodeFull,
} from '../shared/net/delta.ts';
import type { BossState, PlayerState, RoomState, WildlifeState } from '../shared/types/wire.ts';
import { ClientStateStore, emptyRoomState } from '../client/src/net/state_store.ts';
import {
  bossHudFrom,
  bossHudOf,
  clientTelegraphShapeOf,
  layoutHpBar,
} from '../client/src/ui/boss_hud.ts';
import { partyHudOf, partyModeName } from '../client/src/ui/party_hud.ts';
import { DragController } from '../client/src/ui/state_machine.ts';
import { createCamera, stepZoom, ZOOM_LEVELS } from '../client/src/stage/iso_camera.ts';
import { filterItems } from '../client/src/ui/inventory.ts';
import { PARTY_MODES } from '../shared/constants/bosses.ts';
import {
  WIRING_LEDGER,
  WiringStatus,
  validateLedger,
  witnessOf,
  type WiringEntry,
} from '../client/src/wiring_ledger.ts';

/* ─────────────────────────── 基础设施 ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT_SRC = join(ROOT, 'client', 'src');

const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');
const read = (p: string): string => readFileSync(p, 'utf8');

interface SrcFile {
  readonly path: string;
  readonly text: string;
}

/** 递归读 `client/src/**\/*.ts`(与 WS-FND-89 同一口径) */
function clientSources(): SrcFile[] {
  const out: SrcFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.ts')) out.push({ path: rel(full), text: read(full) });
    }
  };
  walk(CLIENT_SRC);
  return out;
}

/**
 * 去掉注释(**保留字符串字面量**)。
 *
 * 为什么必须剥注释:本轮的注释里大量写着"修前是 `bossHp = ... 0.035`"
 * 之类的**反例样本**,不剥掉的话"检测器命中 ⇒ 已接"这条判据会被注释喂饱。
 * 为什么**保留**字符串:见证片段里含 `'hint'` / `']'` 这类字面量。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'str' = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '\'' || c === '"' || c === '`') { mode = 'str'; quote = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; } else i += 1;
      continue;
    }
    if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue; }
    if (c === quote) mode = 'code';
    out += c; i += 1;
  }
  return out;
}

/** 见证片段是否在**任意** client 源码的代码区里逐字出现 */
function hasWitness(sources: readonly SrcFile[], witness: string): boolean {
  if (witness === '') return false;
  return sources.some((f) => stripComments(f.text).includes(witness));
}

/** `symbol(` 在**定义文件之外**的代码区里出现几次(blocked 判据要求 0) */
function countCallsOutside(sources: readonly SrcFile[], symbol: string, definedIn: string): number {
  const re = new RegExp(`\\b${symbol}\\s*\\(`, 'g');
  let n = 0;
  for (const f of sources) {
    if (f.path === definedIn) continue;
    const hits = stripComments(f.text).match(re);
    if (hits !== null) n += hits.length;
  }
  return n;
}

/* ─────────────────────────── 状态构造 ─────────────────────────── */

function player(id: string): PlayerState {
  return {
    id, name: id, level: 1, hp: 100, maxHp: 100,
    x: 10, y: 20, z: 0, dir: 0, stateFlag: 0, weaponId: 0,
    aiWeaponRecipeHash: '', heldItemId: 0, carryingEntityId: '',
  };
}

function wild(id: string): WildlifeState {
  return { id, mobId: 'mob_slime', x: 5, y: 6, z: 0, fsm: 0, hp: 30, maxHp: 30, tameOwnerId: '' };
}

function boss(id: string, bossId = 'boss_jelly_king'): BossState {
  return {
    id, bossId, phase: 0, hp: 1000, maxHp: 1000,
    telegraphShape: 0, telegraphX: 0, telegraphY: 0, telegraphR: 0, telegraphEndTick: 0,
  };
}

function stateWith(patch: Partial<RoomState> = {}): RoomState {
  const base = emptyRoomState();
  base.roomId = 'r1';
  base.meta.tick = 1;
  return { ...base, ...patch };
}

/* ═══════════════════════════ 判据 1–3:线语义 ═══════════════════════════ */

test('WS-FND-121-1 ★ FULL 是整体替换:旧快照独有的 player/wildlife/boss 不残留', () => {
  /* 旧状态:两个玩家 + 两只野怪 + 一只 boss(模拟"断线前的那一份") */
  const stale = stateWith({
    players: [player('p1'), player('p2')],
    wildlife: [wild('w1'), wild('w2')],
    bosses: [boss('b1')],
  });
  /* 新快照:只剩 p1 —— 服务端没说"谁被删了"(FULL 的 removedCount 恒 0) */
  const fresh = stateWith({ players: [player('p1')] });
  const pkt = decodePacket(encodeFull(fresh, 2).bytes);

  eq(pkt.op, PacketOp.FULL, '全量出口的 op');
  eq(pkt.removed.length, 0, 'FULL 的 removed 恒 0(编码侧没有"上一份"可比)');

  const out = applyPacket(stale, pkt);
  eq(out.players.map((p) => p.id).join(','), 'p1', 'FULL 之后玩家只应剩下快照里的 p1');
  eq(out.wildlife.length, 0, '旧快照的野怪必须消失(幽灵实体)');
  eq(out.bosses.length, 0, '旧快照的 boss 必须消失(幽灵实体)');

  /* ── 负对照(注入):同一份字节,按**修前**的语义(op=DELTA ⇒ 只 merge)应用 ── */
  const oldWay = { ...pkt, op: PacketOp.DELTA };
  const injected = applyPacket(stale, oldWay);
  eq(injected.players.map((p) => p.id).sort().join(','), 'p1,p2', '注入后 p2 仍在(证明上一条不是恒真)');
  eq(injected.wildlife.length, 2, '注入后野怪仍在');
  eq(injected.bosses.length, 1, '注入后 boss 仍在');
});

test('WS-FND-121-2 ★ FULL 的房间级 meta 也整体替换(party/score 不残留)', () => {
  const stale = stateWith({ players: [player('p1')] });
  stale.meta.partyMode = 3;
  stale.meta.partyTimer = 42;
  stale.meta.scoreA = 7;
  stale.meta.scoreB = 9;

  const fresh = stateWith({ players: [player('p1')] }); /* 没有派对:全 0 */
  const out = applyPacket(stale, decodePacket(encodeFull(fresh, 5).bytes));
  eq(out.meta.partyMode, 0, 'partyMode 必须回到快照值(0)');
  eq(out.meta.partyTimer, 0, 'partyTimer 必须回到快照值');
  eq(out.meta.scoreA, 0, 'scoreA 必须回到快照值');
  eq(out.meta.scoreB, 0, 'scoreB 必须回到快照值');

  /* ── 负对照:DELTA 且**不含 ROOM upsert** ⇒ 旧 meta 保留(不是被无条件清零) ── */
  const noop = encodeDelta(stale, stale, 6);
  eq(noop.stats.changedFields.length, 0, 'prev===next 的差量没有变更条目');
  const kept = applyPacket(stale, decodePacket(noop.bytes));
  eq(kept.meta.partyMode, 3, 'DELTA 不动 meta(pay 掉了"无脑清零"的嫌疑)');
  eq(kept.meta.scoreA, 7, 'DELTA 不动比分');
});

test('WS-FND-121-3 ★ DELTA 的 removed 仍然真的删实体(修复没有拖坏删除路径)', () => {
  const prev = stateWith({ players: [player('p1')], wildlife: [wild('w1'), wild('w2')] });
  const next = stateWith({ players: [player('p1')], wildlife: [wild('w1')] });
  const d = encodeDelta(prev, next, 2);
  eq(d.stats.removed.length, 1, '差量里应有 1 条删除');
  eq(d.stats.removed[0]?.id, 'w2', '删的是 w2');

  const out = applyPacket(prev, decodePacket(d.bytes));
  eq(out.wildlife.map((w) => w.id).join(','), 'w1', 'w2 必须被删掉、w1 必须还在');

  /* ── 负对照:不含删除的差量不许删任何东西 ── */
  const same = encodeDelta(prev, prev, 3);
  eq(same.stats.removed.length, 0, 'prev===next 时没有删除条目');
  eq(applyPacket(prev, decodePacket(same.bytes)).wildlife.length, 2, '负对照:实体全留');
});

/* ═══════════════════════════ 判据 4–5:客户端 store ═══════════════════════════ */

test('WS-FND-121-4 ★ 客户端 store 端到端:重连后的 FULL 不留下幽灵实体', () => {
  const store = new ClientStateStore();
  const before = stateWith({
    players: [player('p1'), player('p2')],
    wildlife: [wild('w1')],
    bosses: [boss('b1')],
  });
  const r1 = store.apply(encodeFull(before, 1).bytes);
  eq(r1.changed, true, '第一份快照应合入');
  eq(store.state.players.length, 2, '两个玩家');
  eq(store.state.bosses.length, 1, '一只 boss');

  /* 重连:新快照只有 p1(服务端 tick **更小** —— 重连时这是常态) */
  const after = stateWith({ players: [player('p1')] });
  const r2 = store.apply(encodeFull(after, 2).bytes);
  eq(r2.changed, true, 'FULL 无条件接受(单调门只拦 DELTA)');
  eq(store.state.players.map((p) => p.id).join(','), 'p1', 'store 里不该再有 p2');
  eq(store.state.wildlife.length, 0, 'store 里不该再有野怪');
  eq(store.state.bosses.length, 0, 'store 里不该再有 boss');
  eq(store.staleFrames, 0, '这不是"旧帧"路径');

  /* ── 负对照:非法 op 的坏包 ⇒ decode-failed 且**状态对象不变**(引用相等) ── */
  const snapshot = store.state;
  const bad = store.apply(Uint8Array.from([3, 9, 0, 0, 0, 0]));
  eq(bad.skipped, 'decode-failed', '非法 op 应记坏包');
  ok(store.state === snapshot, '坏包不许改状态(连引用都不该换)');
  eq(store.decodeErrors, 1, '坏包计数 +1');
});

test('WS-FND-121-5 ★ round-trip 不破:applyPacket(empty, encodeFull(st)) 与原状态一致', () => {
  const st = stateWith({
    players: [player('p1'), player('p2')],
    wildlife: [wild('w1')],
    bosses: [boss('b1')],
  });
  st.meta.partyMode = 2;
  st.meta.partyTimer = 61.5;
  st.meta.scoreA = 4;
  st.meta.scoreB = 6;
  const out = applyPacket(emptyRoomState(), decodePacket(encodeFull(st, 9).bytes));
  eq(out.players.map((p) => p.id).join(','), 'p1,p2', '玩家');
  eq(out.wildlife.map((w) => w.id).join(','), 'w1', '野怪');
  eq(out.bosses.map((b) => b.id).join(','), 'b1', 'boss');
  eq(out.meta.partyMode, 2, 'partyMode');
  eq(out.meta.scoreA, 4, 'scoreA');
  eq(out.meta.scoreB, 6, 'scoreB');
  eq(out.meta.tick, 9, 'tick 来自报文头');

  /* ── 负对照(根因证据):FULL 永远列不出"谁消失了" ── */
  eq(encodeFull(st, 9).stats.removed.length, 0, 'FULL 的 removed 恒 0 ⇒ 替换语义只能由解码侧表达');
});

/* ═══════════════════════════ 判据 6–8:Boss / 派对 HUD ═══════════════════════════ */

test('WS-FND-121-6 ★ Boss HUD 来自权威状态,且不随时间伪造', () => {
  const none = bossHudFrom({ bosses: [] });
  eq(none, null, '负对照:没有 boss 时不许编一张满血条');

  const b = boss('b1');
  b.hp = 500;
  b.maxHp = 1000;
  b.phase = 1;
  const half = bossHudFrom({ bosses: [b] });
  ok(half !== null, '有 boss 时应给出视图');
  eq(half?.hp, 500, '血量=线上 hp');
  eq(half?.baseHp, 1000, '上限=线上 maxHp');
  eq(half?.ratio, 0.5, '比例=hp/maxHp');
  eq(half?.phaseIndex, 1, '阶段索引=线上 phase');
  eq(half?.bossId, 'boss_jelly_king', 'bossId 透传');

  /* 「不随时间伪造」:同一个输入读两次,逐字段相同(修前是 `bossHp -= dt*baseHp*0.035`) */
  eq(JSON.stringify(bossHudFrom({ bosses: [b] })), JSON.stringify(half), '两次读必须一致(没有时间项)');

  /* 「真的流动」:血量变一半 ⇒ ratio/血条几何跟着变(与 layoutHpBar 同源) */
  const layout = layoutHpBar(half!.baseHp, half!.hp, 1280, half!.phases);
  eq(layout.ratio, 0.5, 'layoutHpBar 的 ratio 与视图一致');
  const qu = bossHudOf({ ...b, hp: 250 });
  eq(qu.ratio, 0.25, '再掉一半 ⇒ 比例 0.25');
  ok(qu.ratio < half!.ratio, '比例随权威血量单调下降');
});

test('WS-FND-121-7 ★ 线上 telegraphShape(数字)→ 渲染几何(字符串)', () => {
  eq(clientTelegraphShapeOf(0), null, 'NONE ⇒ 不画');
  eq(clientTelegraphShapeOf(1), 'CIRCLE', 'CIRCLE 同义');
  eq(clientTelegraphShapeOf(2), 'CONE', 'SECTOR ⇒ CONE');
  eq(clientTelegraphShapeOf(3), 'LINE', 'RECT ⇒ LINE');
  eq(clientTelegraphShapeOf(4), 'ANNULUS', 'RING ⇒ ANNULUS');
  /* ── 负对照:未知值不许兜底成某个"看起来正常"的几何 ── */
  eq(clientTelegraphShapeOf(99), null, '未知值 ⇒ null(不兜底成 CIRCLE)');
  eq(clientTelegraphShapeOf(-1), null, '负值 ⇒ null');

  /* 实体上有预警几何 + 半径 > 0 时,视图里才有 telegraph */
  const b = boss('b1');
  b.telegraphShape = 4;
  b.telegraphX = 12.5;
  b.telegraphY = 20;
  b.telegraphR = 6;
  const v = bossHudFrom({ bosses: [b] });
  eq(v?.telegraph?.shape, 'ANNULUS', 'RING 应映射成环');
  eq(v?.telegraph?.radius, 6, '半径透传');
  eq(v?.telegraph?.cx, 12.5, '圆心 x 透传');
  /* 负对照:半径 0 ⇒ 不画(而不是画一个半径 0 的环) */
  const zero = boss('b2');
  zero.telegraphShape = 1;
  zero.telegraphR = 0;
  eq(bossHudFrom({ bosses: [zero] })?.telegraph, null, '半径 0 ⇒ telegraph 为 null');
});

test('WS-FND-121-8 ★ 派对/比分 HUD:wire 下标 → 模式名 + 计时 + 比分', () => {
  eq(partyHudOf({ partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 }).active, false, 'mode=0 ⇒ 没有派对');
  eq(partyHudOf({ partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 }).text, '', '负对照:没派对时 text 为空(不画)');

  const p = partyHudOf({ partyMode: 1, partyTimer: 12.2, scoreA: 3, scoreB: 5 });
  eq(p.active, true, 'mode=1 ⇒ 在派对');
  eq(p.modeName, PARTY_MODES[0]!.name, '名字来自冻结层 PARTY_MODES(不是客户端抄的一份)');
  eq(p.timerSec, 13, '计时向上取整(剩 12.2s 显示 13s)');
  eq(p.scoreA, 3, '红队比分');
  eq(p.scoreB, 5, '蓝队比分');
  ok(p.text.includes('红 3') && p.text.includes('5 蓝'), `文本含双方比分(${p.text})`);

  /* 每个合法下标都要能翻译(下标与词表差一) */
  for (let i = 1; i <= PARTY_MODES.length; i += 1) {
    eq(partyModeName(i), PARTY_MODES[i - 1]!.name, `mode=${i} 对应 PARTY_MODES[${i - 1}]`);
  }
  /* ── 负对照:越界下标**不认**(不编一个名字) ── */
  eq(partyModeName(PARTY_MODES.length + 1), null, '越界下标 ⇒ null');
  eq(partyHudOf({ partyMode: 99, partyTimer: 5, scoreA: 1, scoreB: 1 }).active, false, '未知模式 ⇒ 不显示');
});

/* ═══════════════════════════ 判据 9–13:接线 ═══════════════════════════ */

test('WS-FND-121-9 ★ 背包搜索可达(query 真的过滤)', () => {
  const all = filterItems({ query: '' });
  ok(all.length > 10, `无查询时物品数应 > 10(实际 ${all.length})`);
  const q = filterItems({ query: '木' });
  ok(q.length > 0, '中文名里的常见字应能搜到东西');
  ok(q.length < all.length, '查询必须**收窄**结果(否则过滤器恒真)');
  /* 负对照:任意查询的结果数不得多于空查询 */
  for (const query of ['木', '石', 'zzz-不存在-zzz']) {
    ok(filterItems({ query }).length <= all.length, `query="${query}" 的结果数不该超过空查询`);
  }
  eq(filterItems({ query: 'zzz-不存在-zzz' }).length, 0, '负对照:不存在的词 ⇒ 0 件(不是"全都留下")');
});

test('WS-FND-121-10 ★ 背包拖拽能成交:`drop()` 有调用点且语义正确', () => {
  /* 行为:拿起 → 悬停 → 放下 ⇒ 成交凭证 {from,to,item,count} */
  const dc = new DragController();
  eq(dc.pickUp(0, 101, 2), true, '拿得起');
  dc.hoverAt(3);
  const moved = dc.drop(3);
  eq(moved?.fromSlot, 0, 'fromSlot');
  eq(moved?.toSlot, 3, 'toSlot');
  eq(moved?.itemId, 101, 'itemId');
  eq(moved?.count, 2, 'count');
  eq(dc.isDragging, false, '成交后不再处于拖拽态');

  /* ── 负对照(修前路径 = 只 cancel)── */
  const dc2 = new DragController();
  dc2.pickUp(0, 101, 2);
  dc2.hoverAt(3);
  dc2.cancel(); /* ← 修前 onUiPointerUp 干的就是这一句 */
  eq(dc2.drop(3), null, '负对照:先 cancel 再 drop ⇒ null(永远不会成交)');
  eq(dc2.isDragging, false, 'cancel 后不是拖拽态');

  /* 放回原格 ⇒ 取消(不是"搬到同一格") */
  const dc3 = new DragController();
  dc3.pickUp(4, 102, 1);
  dc3.hoverAt(4);
  eq(dc3.drop(4), null, '同格放下 ⇒ null 且内部已取消');

  /* 生产调用点:boot.ts 的抬手分支 */
  const sources = clientSources();
  ok(hasWitness(sources, 'dragCtl.drop(hover)'), 'boot.ts 必须在抬手时真的调 drop()');
  const bootFile = sources.find((f) => f.path === 'client/src/three/boot.ts');
  ok(bootFile !== undefined, 'boot.ts 必须存在');
  const bootCode = stripComments(bootFile!.text);
  ok(/hover\s*>=\s*0\s*\?\s*dragCtl\.drop\(hover\)/.test(bootCode), '悬停为 -1 时不许调 drop(-1)');
});

test('WS-FND-121-11 ★ 6 档缩放在生产里真的可达(有写点)', () => {
  eq(ZOOM_LEVELS.length, 6, '档位表是 6 档');
  let cam = createCamera(1280, 720);
  eq(cam.zoom, 1, '初始 1×');
  for (let i = 0; i < 10; i += 1) cam = stepZoom(cam, 1);
  eq(cam.zoom, 2, '连按放大 ⇒ 端点是 2×(不越界)');
  for (let i = 0; i < 10; i += 1) cam = stepZoom(cam, -1);
  eq(cam.zoom, 0.5, '连按缩小 ⇒ 端点是 0.5×');

  const sources = clientSources();
  ok(hasWitness(sources, 'stepZoom(isoCam,'), 'boot.ts 必须调 stepZoom');
  const bootCode = stripComments(sources.find((f) => f.path === 'client/src/three/boot.ts')!.text);
  ok(/isoCam\.zoom\s*=/.test(bootCode), '必须真的**写** isoCam.zoom(修前只有读点)');

  /* ── 负对照:只有读点的样本必须被判"未接" ── */
  const readOnly = 'function syncCamera(): void { c.zoom = isoCam.zoom; }';
  ok(!/isoCam\.zoom\s*=/.test(readOnly), '负对照:只读样本不该被认成写点');
  ok(!hasWitness([{ path: 'x/old_boot.ts', text: readOnly }], 'stepZoom(isoCam,'), '负对照:没有 stepZoom 也不算');
});

test('WS-FND-121-12 ★ 接线台账与真实调用点双向一致', () => {
  const sources = clientSources();

  const self = validateLedger();
  ok(self.ok, `台账自检必须通过:${self.errors.join(' / ')}`);
  ok(WIRING_LEDGER.length >= 10, `台账至少登记 10 条(实际 ${WIRING_LEDGER.length})`);

  const wired = WIRING_LEDGER.filter((e) => e.status === WiringStatus.WIRED);
  const blocked = WIRING_LEDGER.filter((e) => e.status === WiringStatus.BLOCKED);
  ok(wired.length >= 5, `已接条目 ≥ 5(实际 ${wired.length})`);
  ok(blocked.length >= 6, `登记未接条目 ≥ 6(实际 ${blocked.length})`);

  for (const e of wired) {
    ok(hasWitness(sources, witnessOf(e.symbol)), `${e.symbol} 标为 wired,见证片段必须真的在源码里:${witnessOf(e.symbol)}`);
  }
  for (const e of blocked) {
    const n = countCallsOutside(sources, e.symbol, e.definedIn);
    eq(n, 0, `${e.symbol} 标为 blocked,但 ${e.definedIn} 之外出现了 ${n} 处调用 —— 台账过期了(改成 wired 并补见证)`);
  }

  /* ── 负对照 1:伪造"wired 却无见证" ⇒ 检测器必须报红 ── */
  const fakeWired: WiringEntry = {
    symbol: 'noSuchSymbol_xyz', definedIn: 'client/src/none.ts',
    status: WiringStatus.WIRED, callSites: 1, reason: '假的',
  };
  ok(!hasWitness(sources, 'noSuchSymbol_xyz('), '负对照:不存在的见证必须被判"没接"');
  eq(validateLedger([fakeWired]).ok, false, '负对照:无见证的 wired 条目必须被台账自检拒绝');

  /* ── 负对照 2:伪造"blocked 却有调用点" ⇒ 同一个计数器必须非 0 ── */
  ok(countCallsOutside(sources, 'bossHudFrom', 'client/src/ui/boss_hud.ts') > 0,
    '负对照:bossHudFrom 确实有定义文件之外的调用点(所以把它标 blocked 会被抓)');
});

test('WS-FND-121-13 ★ `#hint` 与 `invQuery` 都有写点(不再是死元素/死字段)', () => {
  const sources = clientSources();
  const boot = sources.find((f) => f.path === 'client/src/three/boot.ts');
  ok(boot !== undefined, 'boot.ts 必须存在');
  const code = stripComments(boot!.text);

  ok(code.includes('getElementById(\'hint\')'), '`#hint` 必须有读点(修前零读点、文案永不更新)');
  ok(/hintEl\.textContent\s*=/.test(code), '`#hint` 必须真的被写');
  ok(/invQuery\s*\+=/.test(code), '`invQuery` 必须能从输入追加(修前恒空 ⇒ 搜索不可达)');
  ok(/searchMode/.test(code), '搜索态必须有开/关');
  /* 提示行里必须提到这两组键位(存在但没人知道 = 不存在) */
  ok(code.includes('[ ] 缩放') || code.includes('[ / ]'), '提示行必须写出缩放键位');
  ok(code.includes('/ 搜索'), '提示行必须写出搜索键位');

  /* ── 负对照:修前的形态(既没有 #hint 读点也没有 invQuery 写点)必须被判红 ── */
  const oldBoot = 'const invQuery = \'\';\nfunction paintStatus(): void { statusEl.textContent = \'连接\'; }';
  ok(!oldBoot.includes('getElementById(\'hint\')'), '负对照:旧样本没有 #hint 读点');
  ok(!/invQuery\s*\+=/.test(oldBoot), '负对照:旧样本没有 invQuery 写点');
});

report('WS-FND-121');