/**
 * WS-FND-87 —— **产出凭证的绑定/一次性** + **四条扣减路径的按件权威读口**。
 *
 * ## 修的两处(审计 P0-2 + P1)
 *
 * ```
 * P0-2  grantItemSource 只登记**裸字符串**,checkInventory 只判「串在不在集合里」
 *       ⇒ 客户端用**可推算**的串(自己刚拆块的 `break:x,y:objId`)铸任意 itemId;
 *       退款/负 delta 分支也发凭证;expireItemSources() 全仓零调用。
 * P1    itemId 自报只在 USE_ITEM 修过;DROP_ITEM / OPEN_CHEST(存入)/
 *       BREED_TAME(投喂)/ CRAFT 只做**总量守恒**
 *       ⇒ 「丢一件任意 id + 捡起来」= 背包任意换 id。
 * ```
 *
 * ## 判据(每条都带**负对照**;第 3/9 条是**注入**)
 *
 * ```
 * 1 一张凭证只铸它绑定的那一件(itemId 不符 ⇒ ITEM_SOURCE_BINDING,零副作用)
 * 2 凭证**一次性**:同 tick 重放 ⇒ ITEM_SOURCE_REUSED;换一张则放行(防假阳性)
 * 3 推算串 / 伪造令牌:即便**被登记进凭证集**也拒(ITEM_SOURCE_FORGED)
 * 4 凭证不跨 tick ⇒ 同一张凭证推进一帧后**必被拒**;因过期即回收
 *   (`step()` 末尾 `expireItemSources()`),拒因记为 ITEM_FROM_NOTHING
 *   (与凭空不可区分),见该用例里的说明
 * 5 DROP_ITEM:丢一件自己没有的 id / 内容表外的 id ⇒ 拒,地面与背包都不动
 * 6 OPEN_CHEST(存入):存一件自己没有的 id ⇒ 拒,箱子与背包都不动
 * 7 BREED_TAME(投喂):没有那一件 ⇒ 拒,好感不变
 * 8 CRAFT:客户端自报 `have` **无效**(材料只读服务端按件账),合法材料仍能合成
 * 9 BUY_ITEM:成交失败退回是**负 delta** ⇒ 不发凭证(注入失败的分支)
 * 10 静态:动作层 `ctx.grantItemSource(` 裸调用 **0 处**(全部走 bindItemSource)
 * ```
 *
 * ⚠️ 断言右侧一律字面量:`733` / `101` / `515` / `245` 取冻结内容表,不取本模块导出。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import {
  InventoryReject,
  mintItemSourceToken,
  parseItemSourceToken,
} from '../server/src/net/anticheat.ts';
import { tameableMobs } from '../shared/constants/mobs.ts';
import {
  CHEST_SLOTS,
  publicChestContents,
  registerChest,
} from '../server/src/net/actions/open_chest.ts';
import { buyItem } from '../server/src/net/actions/buy_item.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import type { ActionOutcome } from '../server/src/net/room.ts';

/** 101 暖松原木(内容表里的建材);733 复苏天使羽毛笔(内容表里的道具)。 */
const LOG = 101;
const FEATHER = 733;
/** 百货店货摊(515)。 */
const DEPOT = 515;
/** 内容表里没有的编号。 */
const GHOST_ID = 999999;

type GroundNear = { itemId: number; count: number };

type SimLike = {
  addPlayer(id: string, x: number, y: number): void;
  materials(): {
    blockAt(x: number, y: number): number;
    groundItemsNear(x: number, y: number, radius: number): GroundNear[];
  };
};

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: SimLike;
  roomId: string;
  at: { x: number; y: number };
};

let seq = 0;

function makeRoom(tag: string): Room {
  seq += 1;
  const roomId = `r_isrc_${tag}_${seq}`;
  const a = assemble({
    roomId,
    /* `ownerId: 'p1'`:本套件要穿过 `CRAFT`(build)/ `OPEN_CHEST`(publicStorage)
       的权限闸 —— 让被测玩家就是房主,闸不会先把判据挡在外面。 */
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    /* 本套件测物品真值层,不想让自发改刷的怪参与(第三个"东西"会让失败难以归因)。 */
    mobs: false,
    rng: mulberry32(87),
  });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as SimLike;
  const at = { x: 4.5, y: 4.5 };
  sim.addPlayer('p1', at.x, at.y);
  return { rt: a.runtime, sim, roomId, at };
}

/**
 * 塞东西进背包 —— 走**生产同一条路**(先登记凭证再 `applyInventory`)。
 *
 * ⚠️ 这里用的是**旧口径裸字符串**(夹具专用)。它仍被放行是**刻意保留的兼容口**
 * (见 `anticheat.ts` §5.0 的结尾):生产产出点已全部改成 `bindItemSource`,
 * 而本文件第 10 条判据把"裸调用 0 处"钉住。
 */
function seed(rt: Room['rt'], itemId: number, n: number): void {
  const src = `seed:${itemId}:${n}:${seq}`;
  rt.grantItemSource('p1', src);
  const r = rt.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `测试前置:应能塞进 ${n} 件 ${itemId}(被拒说明容量/守恒层先坏了)`);
}

const disp = (rt: Room['rt'], action: RoomAction, payload: Record<string, unknown> = {}) =>
  rt.dispatchAction('p1', action, payload);

/** 铸一张**当前 tick** 的令牌并登记(模拟服务端产出侧)。 */
function mintAndGrant(rt: Room['rt'], itemId: number, purpose: 'gather' | 'craft' | 'pickup'): string {
  const tok = mintItemSourceToken({
    actorId: 'p1',
    itemId,
    purpose,
    tick: rt.state.meta.tick,
  });
  rt.grantItemSource('p1', tok);
  return tok;
}

/* ───────────────────────── 1 绑定 ───────────────────────── */

test('FND87-1 一张凭证只铸它绑定的那一件:换 itemId ⇒ ITEM_SOURCE_BINDING,且零副作用', () => {
  const { rt } = makeRoom('bind');
  const tok = mintAndGrant(rt, LOG, 'gather');

  /* 负对照:同一张凭证去铸 733(审计 P0-2 实测的那种"任意物品")。 */
  const bad = rt.applyInventory('p1', { ops: [{ itemId: FEATHER, delta: 1, source: tok }] });
  eq(bad.allowed, false, '★ 凭证绑的是 101,不能用来铸 733');
  eq(bad.rejectCode, InventoryReject.SOURCE_BINDING, '拒因应是绑定不符');
  eq(rt.authoritativeItemCount('p1', FEATHER), 0, '★ 被拒 ⇒ 733 一件都不该进账');
  eq(rt.authoritativeItemCount('p1', LOG), 0, '被拒 ⇒ 101 也不该进账(整批零副作用)');

  /* 正对照:同一张凭证铸它绑定的那件 —— 放行,且恰好一件。 */
  const good = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: tok }] });
  eq(good.allowed, true, '凭证用于它绑定的 itemId 必须放行');
  eq(rt.authoritativeItemCount('p1', LOG), 1, '真的进账一件');
});

test('FND87-2 凭证是一次性的:同 tick 重放被拒;换一张仍放行(防假阳性)', () => {
  const { rt } = makeRoom('once');
  const tok = mintAndGrant(rt, LOG, 'gather');

  eq(rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: tok }] }).allowed, true,
    '前置:第一张凭证应放行');

  const replay = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: tok }] });
  eq(replay.allowed, false, '★ 同一张凭证第二次使用必须被拒');
  eq(replay.rejectCode, InventoryReject.SOURCE_REUSED, '拒因应是重复使用');
  eq(rt.authoritativeItemCount('p1', LOG), 1, '★ 重放没有多出第二件');

  /* 负对照的负对照:同 tick 同 (item, purpose) 的**另一张**凭证必须能用
     —— 否则"连捡两件同类道具"会被一次性判据误杀(假阳性)。 */
  const tok2 = mintAndGrant(rt, LOG, 'gather');
  ok(tok2 !== tok, '同 tick 两次铸的令牌必须不同(带 nonce)');
  eq(rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: tok2 }] }).allowed, true,
    '★ 另一张凭证应放行');
  eq(rt.authoritativeItemCount('p1', LOG), 2, '两件都在账上');
});

/* ───────────────────────── 3 伪造注入 ───────────────────────── */

test('FND87-3 推算串与伪造令牌都拒(注入:即便被登记进凭证集也不算数)', () => {
  const { rt } = makeRoom('forge');

  /* ① 审计原话「客户端用可推算串」:没登记过的旧口径串 ⇒ 凭空产出。 */
  const guessed = rt.applyInventory('p1', {
    ops: [{ itemId: FEATHER, delta: 5, source: 'break:3,4:101' }],
  });
  eq(guessed.allowed, false, '★ 没登记过的推算串必须拒');
  eq(guessed.rejectCode, InventoryReject.FROM_NOTHING, '拒因应是凭空产出');

  /* ② 令牌形态但 MAC 是编的。**最坏情况注入**:假设有个 bug 把它登记进了
     凭证集(`grantItemSource`)—— 验签仍应挡住它(集合只回答"登记过没有")。 */
  const actor = Buffer.from('p1', 'utf8').toString('base64url');
  const forged = [
    'rsi1', actor, String(FEATHER), 'gather', String(rt.state.meta.tick),
    '0011223344556677', 'deadbeef'.repeat(4),
  ].join('.');
  eq(parseItemSourceToken(forged), null, '前置:伪造令牌验签必须失败');
  rt.grantItemSource('p1', forged);
  const r = rt.applyInventory('p1', { ops: [{ itemId: FEATHER, delta: 1, source: forged }] });
  eq(r.allowed, false, '★ 伪造令牌即便"登记过"也必须拒');
  eq(r.rejectCode, InventoryReject.SOURCE_FORGED, '拒因应是验签失败');
  eq(rt.authoritativeItemCount('p1', FEATHER), 0, '零副作用');
});

/* ───────────────────────── 4 过期 ───────────────────────── */

test('FND87-4 凭证不跨 tick:推进一帧后同一张凭证过期', () => {
  const { rt } = makeRoom('expire');
  const tok = mintAndGrant(rt, LOG, 'gather');
  ok(parseItemSourceToken(tok)?.tick === rt.state.meta.tick, '前置:令牌带本 tick');

  /* 推进一帧(`step()` 是房间的 20Hz 入口:meta.tick += 1,并驱动 ac.tick)。 */
  rt.step();
  eq(rt.state.meta.tick, 1, '前置:帧号前进');

  const stale = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: tok }] });
  eq(stale.allowed, false, '★ 上一帧的凭证必须失效');

  /* 拒因是「**凭空**」而不是「过期」—— 这不是判据放宽,而是**过期已被真的回收**:
   * `step()` 末尾现在调用 `expireItemSources()`(审计 P0-2 要求),它把
   * `grantedSources` 整张 Map `clear()` 掉 ⇒ 下一 tick 这张串既不在登记集里,
   * 也没有任何「曾签发」的记号 ⇒ `checkInventory` 先命中第 980 行的
   * `!input.allowedSources.has(source)` 分支(`ITEM_FROM_NOTHING`),
   * 走不到第 1001 行的 `token.tick !== input.tick`(`ITEM_SOURCE_EXPIRED`)。
   * 语义上就是「过期即回收,故与凭空不可区分」:凭证的权威是**当前 tick 的
   * 登记集**,不是历史账本。
   *
   * ⚠️ 「凭证不跨 tick」这件事仍被钉住,并且不依赖拒因码:
   *   · 上一行 `allowed === false` —— 同一张凭证推进一帧后一律被拒;
   *   · 下面再推进一帧仍拒(不是「只过期一帧」的特例);
   *   · 伪造 / 绑错 / 重放各有专属码(FND87-1/2/3)。
   * 要让这里恢复 `ITEM_SOURCE_EXPIRED` 归因,得在 anticheat 里另记一张跨 tick 的
   * 「曾签发」集合(≈10 行);本轮依据 `docs/AUDIT-W34.md` §5 的取舍不做。 */
  eq(stale.rejectCode, InventoryReject.FROM_NOTHING,
    '拒因应是凭空产出(过期即回收 ⇒ 与凭空不可区分)');
  eq(rt.authoritativeItemCount('p1', LOG), 0, '零副作用');

  /* 再推进一帧:同一张凭证照样被拒(凭证不跨 tick,与拒因码无关)。 */
  rt.step();
  eq(rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: tok }] }).allowed, false,
    '★ 隔两帧的同一张凭证仍然必须被拒');

  /* 正对照:新 tick 的新凭证照常放行。 */
  const fresh = mintAndGrant(rt, LOG, 'gather');
  eq(rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: fresh }] }).allowed, true,
    '新 tick 的凭证应放行');
});

/* ───────────────────────── 5 DROP_ITEM ───────────────────────── */

test('FND87-5 DROP_ITEM 不能丢一件自己没有的 id(任意换 id 的入口被堵)', () => {
  const { rt, sim, at } = makeRoom('drop');
  seed(rt, LOG, 2);

  const ghost = disp(rt, RoomAction.DROP_ITEM, { itemId: FEATHER, count: 1 });
  eq(ghost.ok, false, '★ 背包里没有 733 ⇒ 不能丢出 733');
  eq(ghost.kind, 'INVALID', '这是状态/参数问题(INVALID)');
  eq(rt.authoritativeItemCount('p1', LOG), 2, '★ 被拒 ⇒ 101 一件不少');
  eq(rt.authoritativeItemCount('p1', FEATHER), 0, '733 仍然是 0');
  const nearGhost = sim.materials().groundItemsNear(at.x, at.y, 2)
    .filter((g) => g.itemId === FEATHER);
  eq(nearGhost.length, 0, '★ 地面上不该凭空多出 733');

  const outsideTable = disp(rt, RoomAction.DROP_ITEM, { itemId: GHOST_ID, count: 1 });
  eq(outsideTable.ok, false, '内容表外的编号不能丢(「编号空投」)');

  /* 正对照:丢**真的有的**那件 —— 世界与背包同时变。 */
  const real = disp(rt, RoomAction.DROP_ITEM, { itemId: LOG, count: 2 });
  eq(real.ok, true, `丢 101 应成功(实测 kind=${real.kind} reason=${real.reason ?? '-'})`);
  eq(rt.authoritativeItemCount('p1', LOG), 0, '背包真的少了 2 件');
  const near = sim.materials().groundItemsNear(at.x, at.y, 2).filter((g) => g.itemId === LOG);
  ok(near.length >= 1, '★ 地面上真的多了 101');

  /* 捡回来:产出侧凭证绑的是"地上那件" ⇒ 放行。 */
  const back = disp(rt, RoomAction.PICKUP_ITEM, { itemId: LOG });
  eq(back.ok, true, `捡 101 应成功(实测 kind=${back.kind} reason=${back.reason ?? '-'})`);
  eq(rt.authoritativeItemCount('p1', LOG), 1, '★ 捡回来一件');
});

/* ───────────────────────── 6 OPEN_CHEST ───────────────────────── */

test('FND87-6 OPEN_CHEST 存入不能塞一件自己没有的 id', () => {
  const { rt, roomId } = makeRoom('chest');
  const x = 3;
  const y = 3;
  registerChest(roomId, x, y);
  eq(publicChestContents(roomId, x, y), [], `前置:空格子(${CHEST_SLOTS} 档上限)`);

  const ghost = disp(rt, RoomAction.OPEN_CHEST, { x, y, itemId: FEATHER, count: 1 });
  eq(ghost.ok, false, '★ 背包里没有 733 ⇒ 不能存 733');
  eq(ghost.kind, 'INVALID', '这是状态问题(INVALID)');
  eq(publicChestContents(roomId, x, y), [], '★ 箱子一个字都没动');
  eq(rt.authoritativeItemCount('p1', FEATHER), 0, '733 仍是 0');

  /* 正对照:存**真的有的**那一件。 */
  seed(rt, LOG, 1);
  const store = disp(rt, RoomAction.OPEN_CHEST, { x, y, itemId: LOG, count: 1 });
  eq(store.ok, true, `存 101 应成功(实测 kind=${store.kind} reason=${store.reason ?? '-'})`);
  eq(publicChestContents(roomId, x, y), [{ itemId: LOG, count: 1 }], '★ 箱子里真的有 1 件');
  eq(rt.authoritativeItemCount('p1', LOG), 0, '背包真的少了 1 件');
});

/* ───────────────────────── 7 BREED_TAME ───────────────────────── */

test('FND87-7 BREED_TAME 投喂只认背包里真的有的那一件(好感不涨)', () => {
  const { rt } = makeRoom('tame');
  const mob = tameableMobs()[0];
  ok(mob !== undefined, '前置:内容层应有可驯服生物');
  const payload = {
    op: 'FEED', petId: 'pet-1', mobId: mob?.id, itemId: FEATHER,
  } as unknown as Record<string, unknown>;

  const bad = disp(rt, RoomAction.BREED_TAME, payload);
  eq(bad.ok, false, '★ 背包里没有 733 ⇒ 不能投喂 733');
  eq(bad.kind, 'INVALID', '这是状态问题(INVALID)');
  eq(rt.authoritativeItemCount('p1', FEATHER), 0, '零副作用');

  /* 正对照:先真的有一件,再投喂 —— 好感 +1、背包 -1。 */
  seed(rt, FEATHER, 1);
  const good = disp(rt, RoomAction.BREED_TAME, payload);
  eq(rt.authoritativeItemCount('p1', FEATHER), 0, '★ 背包少了一件');
  const eff = good.effect as Record<string, string | number | boolean> | undefined;
  eq(eff?.affection, 1, '好感 +1');
});

/* ───────────────────────── 8 CRAFT ───────────────────────── */

test('FND87-8 CRAFT:客户端自报 have 无效,材料只认服务端按件账', () => {
  const { rt } = makeRoom('craft');
  /* 151 精刨松木板 = 101 ×1 → 2 件(`station: 502`,不过 505 锻造闸)。
     一件材料都没有,却自报 `have: { 101: 1 }`。 */
  const claimed = disp(rt, RoomAction.CRAFT, { itemId: 151, have: { 101: 1 } });
  eq(claimed.ok, false, '★ 自报明细不能凭空造物(修前这条会过,因为只查总量)');
  eq(claimed.kind, 'INVALID', '缺料是 INVALID(不是 PERMISSION)');
  eq(rt.authoritativeItemCount('p1', 151), 0, '没有产物');

  /* 正对照:材料**真的**在背包里 ⇒ 连 `have` 都不用给,照样合成。 */
  seed(rt, 101, 1);
  const made = disp(rt, RoomAction.CRAFT, { itemId: 151 });
  eq(made.ok, true, `材料齐时应成功(实测 kind=${made.kind} reason=${made.reason ?? '-'})`);
  eq(rt.authoritativeItemCount('p1', 151), 2, '★ `output: 2` 的产物真的进包');
  eq(rt.authoritativeItemCount('p1', 101), 0, '材料 101 真的被扣');
});

/* ───────────────────────── 9 退款不发凭证(注入失败分支) ───────────────────────── */

test('FND87-9 BUY_ITEM 成交失败:退回是负 delta ⇒ 不发凭证(op 也不带 source)', () => {
  /** 每次 `applyInventory` 原样记下来的 ops。 */
  const batches: { itemId: number; delta: number; source?: string }[][] = [];
  const grants: string[] = [];
  /** 注入一个"提交必失败"的摊位:走的是第 7 步的退款分支。 */
  const host = {
    purchaseQuote: () => ({ ok: true, stock: { [DEPOT]: 5 } }),
    purchaseCommit: () => ({ ok: false, reason: '库存被 ConcurrentModification 掉了' }),
  };
  const ctx = {
    actorId: 'p1',
    action: RoomAction.BUY_ITEM,
    payload: { itemId: DEPOT, qty: 2 },
    state: { meta: { tick: 7 }, roomId: 'r_isrc_buy' },
    host,
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID', reason: 'x' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (_userId: string, input: { ops: readonly { itemId: number; delta: number; source?: string }[] }) => {
      batches.push(input.ops.map((o) => ({ itemId: o.itemId, delta: o.delta, source: o.source })));
      return { allowed: true, afterTotal: 0 };
    },
    grantItemSource: (_userId: string, source: string) => { grants.push(source); },
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
  } as unknown as ActionContext;

  const out: ActionOutcome = buyItem(ctx);
  eq(out.ok, false, '前置:提交被拒 ⇒ 动作失败');

  eq(batches.length, 2, '两批 ops:先入包(成交前)+ 再退回');
  eq(batches[0][0].delta, 2, '第一批是 +2');
  eq(batches[1][0].delta, -2, '第二批是 -2(退回是**负** delta)');
  eq(batches[1][0].source, undefined, '★ 退回 op 不带 source(负 delta 不需要凭证)');
  eq(grants.length, 1, '★ 只该有成交那一张凭证;修前退款分支会多发一张');
  const tok = parseItemSourceToken(grants[0]);
  ok(tok !== null, '成交凭证必须是绑定令牌(不是裸字符串)');
  eq(tok?.itemId, DEPOT, '★ 凭证绑的是这次成交的 itemId');
  eq(tok?.actorId, 'p1', '★ 凭证绑的是这个行为人');
});

/* ───────────────────────── 10 静态:裸调用 0 处 ───────────────────────── */

test('FND87-10 动作层不再有裸 grantItemSource 调用(凭证只能经 bindItemSource 铸)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', 'server', 'src', 'net', 'actions');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  ok(files.length >= 20, `前置:动作目录应有 20+ 个文件(实测 ${files.length})`);

  const offenders: string[] = [];
  let bound = 0;
  for (const f of files) {
    /* `item_source.ts` 是**唯一**允许调 `ctx.grantItemSource` 的地方(它就是铸造口)。 */
    if (f === 'item_source.ts') continue;
    const text = readFileSync(join(dir, f), 'utf8');
    if (text.includes('ctx.grantItemSource(')) offenders.push(f);
    if (text.includes('bindItemSource(')) bound += 1;
  }
  eq(offenders, [], '★ 裸调用必须为 0(否则又会出现"可推算串")');
  ok(bound >= 6, `产出/退回点应都走 bindItemSource(实测 ${bound} 个文件)`);
});

report('WS-FND-87');