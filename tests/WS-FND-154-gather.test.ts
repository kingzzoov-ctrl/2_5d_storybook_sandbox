/**
 * WS-FND-154 —— **采集**(`GATHER`):服务端动作 + 客户端入口 + 内容表口径。
 *
 * ## 这一版补的是什么(修前:玩家只能拆方块)
 * ```text
 * RoomAction 里没有 GATHER ⇒ 「从世界里取自然资源」必须走 BREAK_BLOCK,
 * 而 BREAK_BLOCK 的权限位是 build ⇒ GUEST(手册 §7.1「能玩能捡」)一件资源都拿不到;
 * 冻结层给的 gatherMul(602「伐木与采矿速度 +20%」)也没有任何**采集**语义的消费点。
 * ```
 *
 * ## 判据(逐条都给正例 + 负例;`★` = 负对照)
 * ```text
 * FND154-1  服务端动作表完整性:ACTION_HANDLERS 键集 === RoomAction 键集,且 GATHER 有真处理器
 * FND154-2  可采集物**以内容表为准**:§3.1(NATURAL)认得;非自然资源 / 表外编号一律拒
 * FND154-3  工具族词条从内容表派生(逐条对账,不是手抄名单)
 * FND154-4  ★ 成功采集(**真 assemble**:世界真的少一件、背包真的多一件)
 * FND154-5  ★ 重复采集:同格第二次拒且背包不涨(负对照:换一格仍能采)
 * FND154-6  ★ 前置不足·距离:超距拒 + **零副作用**(格上那一件还在 / 背包没动)
 * FND154-7  ★ 前置不足·工具:缺工具拒;而「有同词条但**不是工具**的那一件」同样拒
 * FND154-8  ★ 越界 / 空格 / 非自然资源:三种都拒,且零副作用
 * FND154-9  ★ 产出落地:背包收不下 ⇒ 落回**原地** + 凭证被撤销(不凭空销毁)
 * FND154-10 ★ gatherMul 接到**采集量**上:1.2 ⇒ 期望 1.2 件、且回执带键;1 ⇒ 一次都不翻
 * FND154-11 ★ 缺按件读口 ⇒ NOT_IMPLEMENTED(fail-closed,不退回「信客户端」)
 * FND154-12 ★ 越权 ⇒ PERMISSION 且零副作用(负对照:有权限就走业务分支)
 * ```
 * 运行:`node tests/WS-FND-154-gather.test.ts`
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';

import { assemble } from '../server/src/index.ts';
import { ACTION_PERMISSION, RoomAction } from '../server/src/net/room.ts';
import { ACTION_HANDLERS, lookupActionHandler } from '../server/src/net/actions/action_table.ts';
import {
  GATHER_RADIUS,
  GATHERABLE_CATEGORY,
  TOOL_TAGS,
  gather,
  gatherableOf,
  toolTagFor,
} from '../server/src/net/actions/gather.ts';
import { gatherCountFor, gatherRollFor } from '../server/src/net/actions/material.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import type { ActionOutcome } from '../server/src/net/room.ts';

/* ── 内容层锚点(字面量取自冻结表,不拿被测代码当期望值) ── */
const LOG = 101;        /* 暖松原木:NATURAL,tags 含『木材』⇒ 要一件带木材的工具 */
const BERRY = 121;      /* 露水甜莓:NATURAL,tags ['水果','香甜','恢复'] ⇒ 徒手可采 */
const AXE = 201;        /* 暖松石刃斧:TOOL,tags 含『木材』 */
const PEACH = 122;      /* 金秋蜜桃:NATURAL,tags ['水果','恢复','护盾'] ⇒ 徒手可采(换格对照用) */
const STONE = 106;      /* 云母圆石:NATURAL,tags 含『石材』 */
const FLOOR_TILE = 301; /* FLOOR(地砖):不是自然资源 ⇒ 采集必须拒 */

/* ═══════════════ 1. 服务端动作表完整性(键集逐字对账)═══════════════ */

test('FND154-1 ★ ACTION_HANDLERS 的键集与 `RoomAction` **逐键一致**,且 GATHER 有真处理器', () => {
  /* 变红条件:新增 `GATHER` 却忘了在 `action_table.ts` 登记(⇒ 键集不等);
     或者拿一个 `notImplemented` 占位糊过去(⇒ 处理器不是本文件那支);
     或者权限位忘了登记(⇒ `ACTION_PERMISSION.GATHER` 为 undefined)。 */
  const fromRoom = Object.keys(RoomAction).sort();
  const fromTable = Object.keys(ACTION_HANDLERS).sort();
  eq(fromTable, fromRoom,
    '★ 键集必须逐键相等(漏登记 / 多登记都红)—— 这是「动作表完整性」那条断言');
  ok(fromRoom.includes('GATHER'), 'RoomAction 里必须有 GATHER');
  eq(lookupActionHandler(RoomAction.GATHER), gather, '★ GATHER 登记的必须是真处理器(不是占位)');
  eq(ACTION_PERMISSION.GATHER, 'baseline', '采集是基础生存动作(游客也能采)');
  /* ★ WS-FND-188:`NPC_TALK` 进来后是 26(25 + NPC_TALK)。数字与 `RoomAction` 同步,
     它是"动作面又长了一条"的**显式**信号(逐键一致那条断言在 FND154-1 的第一段)。 */
  eq(Object.keys(RoomAction).length, 26, '动作总数 = 26(25 + NPC_TALK;数字与 PLAY.md 对齐)');
  /* 负对照:每个键都能查到处理器(不存在「表里有键、值是 undefined」的形态)。 */
  for (const a of fromRoom) {
    ok(typeof lookupActionHandler(a as never) === 'function', `${a} 的处理器必须是函数`);
  }
});

/* ═══════════════ 2. 可采集物以内容表为准 ═══════════════ */

test('FND154-2 ★ 可采集物 = 内容表 §3.1(NATURAL);非自然资源 / 表外编号一律拒', () => {
  eq(GATHERABLE_CATEGORY, ItemCategory.NATURAL, '类别取自内容表字段(不是本文件另立的 id 名单)');
  ok(gatherableOf(BERRY).ok, '露水甜莓(内容表 NATURAL)是可采集物');
  ok(gatherableOf(LOG).ok, '暖松原木(内容表 NATURAL)是可采集物');

  /* 负例 1:生产工具(§3.3)不是「从世界里采的东西」。 */
  const tool = gatherableOf(AXE);
  eq(tool.ok, false, '★ 工具(§3.3)不是可采集物');
  ok(tool.ok === false && tool.reason.includes('不是可采集物'), `拒因要说明它不是可采集物:${String(tool)}`);
  /* 负例 2:地砖(§3.5)也不是。 */
  eq(gatherableOf(FLOOR_TILE).ok, false, '★ 地砖(§3.5)不是可采集物');
  /* 负例 3:内容表里没有的编号(编号空投)。 */
  const outside = gatherableOf(99999);
  eq(outside.ok, false, '★ 表外编号必须拒(不认编号空投)');
  ok(outside.ok === false && outside.reason.includes('不在冻结内容表里'), String(outside));

  /* 正反例成对:内容表里 category === NATURAL 的**每一件**都必须被认(派生,不手抄)。 */
  const naturals = [...ITEM_BY_ID.values()].filter((i) => i.category === ItemCategory.NATURAL);
  ok(naturals.length >= 30, `§3.1 至少 30 件(实测 ${naturals.length})`);
  const missed = naturals.filter((i) => !gatherableOf(i.id).ok).map((i) => i.id);
  eq(missed, [], '内容表里所有 NATURAL 物件都必须被认(漏一件就红)');
});

/* ═══════════════ 3. 工具族词条也从内容表派生 ═══════════════ */

test('FND154-3 ★ 工具族词条 = 工具表(§3.3)条目 tags 的并集;资源按词条交集要工具', () => {
  /* 期望值从**内容表**算(与实现同源但不同写法:这里是「§3.3 条目的 tags」,实现是同一件事 —— 
     故再补一条人工锚点,避免「同义反复」)。 */
  const expected = new Set<string>();
  for (const i of ITEM_BY_ID.values()) if (i.category === ItemCategory.TOOL) for (const t of i.tags) expected.add(t);
  eq([...TOOL_TAGS].sort(), [...expected].sort(), '工具族词条集必须等于 §3.3 条目的词条并集');
  ok(TOOL_TAGS.includes('木材') && TOOL_TAGS.includes('石材'), '人工锚点:木材 / 石材在工具族里');

  eq(toolTagFor(LOG), '木材', '暖松原木要一件带『木材』的工具(201 斧)');
  eq(toolTagFor(STONE), '石材', '云母圆石要一件带『石材』的工具(203 镐)');
  eq(toolTagFor(BERRY), null, '★ 露水甜莓的 tags 与工具族无交集 ⇒ **徒手**可采');
  /* 负对照:工具族词条**不是**随便一个词条 —— 资源的非工具词条不会被当成要求。 */
  ok(toolTagFor(BERRY) === null && ITEM_BY_ID.get(BERRY)!.tags.includes('水果'),
    '★ 负对照:「水果」不是工具族词条(否则浆果也要工具)');
});

/* ═══════════════════════ 手搓 ctx(动作层判定面)═══════════════════════ */

type Op = { itemId: number; delta: number; source?: string };

interface Rig {
  ctx: ActionContext;
  counts: Map<number, number>;
  sources: Set<string>;
  revoked: string[];
  dropped: { itemId: number; count: number; x: number; y: number }[];
  cells: Map<string, number>;
  limits: { denyPositive: number; capacity: number };
  /** `null` ⇒ 回执不带 `gatherMul` 键(世界源给不出来的形态)。 */
  gatherMul: number | null;
  position: { x: number; y: number } | null;
  allowed: boolean;
  hasMaterials: boolean;
  hasReadPort: boolean;
}

interface RigOptions {
  tick?: number;
  actorId?: string;
  /** 格上物件:`"x,y" -> objId`。 */
  cells?: Record<string, number>;
  owns?: Record<number, number>;
  gatherMul?: number | null;
  position?: { x: number; y: number } | null;
  allowed?: boolean;
  hasMaterials?: boolean;
  hasReadPort?: boolean;
  denyPositive?: number;
  capacity?: number;
}

/**
 * 手搓 `ActionContext` —— 与 `tests/WS-FND-105` 同一手法(动作层单元面)。
 * `applyInventory` 的关键规则与 `anticheat.checkInventory` 一致:
 * 正 delta 必须带**已登记**来源串,负 delta 必须够件。
 * 世界侧只实现本任务用到的那三个口(`blockAt` / `breakBlock` / `dropItem`)。
 */
function makeRig(o: RigOptions = {}): Rig {
  const tick = o.tick ?? 7;
  const actorId = o.actorId ?? 'p1';
  const counts = new Map<number, number>(Object.entries(o.owns ?? {}).map(([k, v]) => [Number(k), v]));
  const sources = new Set<string>();
  const revoked: string[] = [];
  const dropped: Rig['dropped'] = [];
  const cells = new Map<string, number>(Object.entries(o.cells ?? {}));
  const limits = { denyPositive: o.denyPositive ?? 0, capacity: o.capacity ?? 99 };
  const rig = {
    counts, sources, revoked, dropped, cells, limits,
    gatherMul: o.gatherMul === undefined ? 1 : o.gatherMul,
    position: o.position === undefined ? { x: 0.5, y: 0.5 } : o.position,
    allowed: o.allowed ?? true,
    hasMaterials: o.hasMaterials ?? true,
    hasReadPort: o.hasReadPort ?? true,
    /* ⚠️ 显式标注 + 先占位再赋值:`rig.ctx` 里的闭包要读 `rig` 自身(自引用),
       而对象字面量里没法直接引用自己 —— 照 `tests/WS-FND-105` 的同一手法。 */
    ctx: null as unknown as ActionContext,
  } satisfies Rig;

  const apply = (ops: readonly Op[]): { allowed: boolean; rejectCode?: string } => {
    let net = 0;
    for (const op of ops) {
      if (!Number.isInteger(op.delta)) return { allowed: false, rejectCode: 'MALFORMED' };
      if (op.delta > 0) {
        if (limits.denyPositive > 0) { limits.denyPositive -= 1; return { allowed: false, rejectCode: 'ITEM_OVERFLOW' }; }
        if (op.source === undefined || !sources.has(op.source)) {
          return { allowed: false, rejectCode: 'ITEM_FROM_NOTHING' };
        }
      } else if (op.delta < 0 && (counts.get(op.itemId) ?? 0) < -op.delta) {
        return { allowed: false, rejectCode: 'NEGATIVE' };
      }
      net += op.delta;
    }
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    if (total + net > limits.capacity) return { allowed: false, rejectCode: 'ITEM_OVERFLOW' };
    for (const op of ops) {
      if (op.delta === 0) continue;
      const next = (counts.get(op.itemId) ?? 0) + op.delta;
      if (next === 0) counts.delete(op.itemId); else counts.set(op.itemId, next);
    }
    return { allowed: true };
  };

  const materials = {
    blockAt: (x: number, y: number): number => cells.get(`${Math.floor(x)},${Math.floor(y)}`) ?? 0,
    breakBlock: (x: number, y: number):
      { ok: true; objId: number; gatherMul?: number } | { ok: false; reason: string } => {
      const key = `${Math.floor(x)},${Math.floor(y)}`;
      const obj = cells.get(key) ?? 0;
      if (obj === 0) return { ok: false, reason: '这一格没有物件' };
      cells.delete(key);
      return rig.gatherMul === null ? { ok: true, objId: obj } : { ok: true, objId: obj, gatherMul: rig.gatherMul };
    },
    placeBlock: () => ({ ok: false, reason: '本套件不用放块' }),
    dropItem: (x: number, y: number, itemId: number, count: number): void => {
      dropped.push({ itemId, count, x, y });
    },
    groundItemsNear: () => [],
    consumeGroundItem: () => 0,
    takeGroundItemNear: () => false,
  };

  rig.ctx = {
    actorId,
    action: RoomAction.GATHER,
    payload: {},
    state: { roomId: 'wsfnd154', meta: { tick } },
    host: null,
    status: 'OPEN',
    authorize: () => (rig.allowed ? { allowed: true } : { allowed: false, reason: '你没这个权限' }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' }),
    materialsOf: () => (rig.hasMaterials ? materials : null),
    hostPositionOf: () => rig.position,
    applyInventory: (_u: string, input: { ops: readonly Op[] }) => apply(input.ops),
    grantItemSource: (_u: string, s: string) => { sources.add(s); },
    revokeItemSource: (_u: string, s: string) => { sources.delete(s); revoked.push(s); },
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
    ...(rig.hasReadPort
      ? {
        itemCountOf: (_u: string, id: number) => counts.get(id) ?? 0,
        itemIdsOf: () => [...counts.keys()],
      }
      : {}),
  } as unknown as ActionContext;
  return rig;
}

/** 发一次采集(`payload` 每次新对象)。 */
function gatherAt(rig: Rig, x: number, y: number): ActionOutcome {
  const ctx = { ...rig.ctx, payload: { x, y } } as unknown as ActionContext;
  return gather(ctx);
}

/* ═══════════════ 4/5. 真 assemble:成功采集 + 重复采集 ═══════════════ */

let seq = 0;
/** 生产装配一个真房间(世界侧 = `WorldSim`,`join` 会把玩家登记进世界)。 */
function realRoom(): ReturnType<typeof assemble> {
  seq += 1;
  const a = assemble({ roomId: `wsfnd154_${seq}`, ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 16, mobs: false });
  a.runtime.join({ userId: 'o' });
  return a;
}


/**
 * 真装配的房间自带一份**起始背包**(实测:容量 8、已占约 7 件)⇒ 先把它丢空。
 *
 * 为什么要这一步:采集的产出走反作弊的**容量闸**(`checkInventory` 的 `after > capacity`),
 * 起始背包几乎占满时「+1 件」会落到地面而不是背包 —— 那不是采集的缺陷,是容量满了。
 * 丢掉用的是 `DROP_ITEM`(本任务之外的动作,只借它腾容量),丢完断言背包确实是空的,
 * 于是后面 `count === 1` 这种**精确**断言才成立(否则测试会随起始背包的随机内容漂)。
 */
function clearBag(rt: ReturnType<typeof assemble>['runtime']): void {
  for (const id of rt.authoritativeItemIds('o')) {
    const n = rt.authoritativeItemCount('o', id);
    if (n > 0) rt.dispatchAction('o', RoomAction.DROP_ITEM, { itemId: id, count: n });
  }
  eq(rt.authoritativeItemIds('o'), [], '前置:起始背包已清空(为「采集 +1 件」腾出容量)');
}
test('FND154-4 ★ 真 assemble:采一格自然资源 ⇒ 格子空、背包 +1、回执带 objId', () => {
  const a = realRoom();
  clearBag(a.runtime);
  const pos = a.host.playerPosition?.('o') ?? { x: 0.5, y: 0.5 };
  /* 玩家自己站的那格放不了(实体占用)⇒ 采**旁边那格**(1 格 < 半径 3)。 */
  const cx = Math.floor(pos.x) + 1;
  const cy = Math.floor(pos.y);
  const placed = a.host.materials().placeBlock(cx, cy, BERRY);
  eq(placed.ok, true, `前置:世界侧放一件自然资源(实测 ${JSON.stringify(placed)})`);
  eq(a.host.materials().blockAt(cx, cy), BERRY, '前置:那一格真的是它');

  const out = a.runtime.dispatchAction('o', RoomAction.GATHER, { x: cx, y: cy });
  eq(out.kind, 'OK', `★ 采集应成功(实测 ${out.kind} / ${out.reason ?? '-'})`);
  eq(out.ok, true, '成功回执');
  eq(out.effect?.objId, BERRY, '回执如实说是哪一件');
  eq(out.effect?.gained, 1, '★ 中性乘子(gatherMul = 1)⇒ 恰好 1 件');
  eq(a.host.materials().blockAt(cx, cy), 0, '★ 世界侧真的少了那一件(不是只回了个 OK)');
  eq(a.runtime.authoritativeItemCount('o', BERRY), 1, '★ 背包真的 +1(走按件账,不是回执自说)');
});

test('FND154-5 ★ 重复采集:同格第二次被拒且背包不涨(负对照:换一格仍能采)', () => {
  const a = realRoom();
  clearBag(a.runtime);
  const pos = a.host.playerPosition?.('o') ?? { x: 0.5, y: 0.5 };
  const base = { x: Math.floor(pos.x), y: Math.floor(pos.y) };
  const cellA = { x: base.x + 1, y: base.y };
  const cellB = { x: base.x + 1, y: base.y + 1 };
  eq(a.host.materials().placeBlock(cellA.x, cellA.y, BERRY).ok, true, '前置:A 格放一件');
  /* ⚠️ B 格放**另一种**资源(122 金秋蜜桃):同一 tick 里同一 (actor, itemId, 用途) 的产出凭证是
     **一次性**的(`anticheat.usedSourceTokens`,与 `BREAK_BLOCK` 同一条凭证纪律)——同 tick 重复采
     同一件会落到地面而不是背包。换一种资源才是「另一格也能采」的干净对照。 */
  eq(a.host.materials().placeBlock(cellB.x, cellB.y, PEACH).ok, true, '前置:B 格放一件(另一种自然资源)');

  const first = a.runtime.dispatchAction('o', RoomAction.GATHER, { ...cellA });
  eq(first.kind, 'OK', '前置:第一次成功');
  const again = a.runtime.dispatchAction('o', RoomAction.GATHER, { ...cellA });
  eq(again.kind, 'INVALID', '★ 同一格再采一次必须被拒(那里已经没有东西了)');
  ok((again.reason ?? '').includes('没有物件'), `拒因要说明那一格空了(实测:${again.reason ?? '-'})`);
  eq(a.runtime.authoritativeItemCount('o', BERRY), 1, '★ 背包没有因为第二次而多一件');

  /* 负对照:换一格 ⇒ 仍然采得到(证明上面拒的是**那一格**,不是这个动作坏了)。 */
  const other = a.runtime.dispatchAction('o', RoomAction.GATHER, { ...cellB });
  eq(other.kind, 'OK', '★ 负对照:换一格仍能采');
  eq(a.runtime.authoritativeItemCount('o', PEACH), 1, '★ 负对照:换一格真的采到了(那是另一份资源)');
  eq(a.runtime.authoritativeItemCount('o', BERRY), 1, '★ 第一次采到的甜莓仍是一件(第二次没重复加)');
});

/* ═══════════════ 6. 前置不足 · 距离(零副作用)═══════════════ */

test('FND154-6 ★ 超距 ⇒ 明确拒 + 零副作用;负对照:走进半径内就成功', () => {
  /* 目标格 (10,10),玩家在 (0.5,0.5) ⇒ 距离 ≈ 13.4 > 3。 */
  const rig = makeRig({ cells: { '10,10': BERRY }, position: { x: 0.5, y: 0.5 } });
  const far = gatherAt(rig, 10, 10);
  eq(far.kind, 'INVALID', '★ 超距必须**明确拒**(不是静默什么都不做)');
  ok((far.reason ?? '').includes(`采集半径 ${GATHER_RADIUS} 格`), `拒因要给出半径(实测:${far.reason ?? '-'})`);
  ok((far.reason ?? '').includes('格 >'), `拒因要给出实测距离(实测:${far.reason ?? '-'})`);
  eq(rig.cells.get('10,10'), BERRY, '★ 零副作用:格上那一件还在');
  eq(rig.counts.size, 0, '★ 零副作用:背包一个字节都没动');
  eq(rig.sources.size, 0, '★ 零副作用:没有留下一张没用掉的凭证');

  /* 负对照:同一个 rig,把玩家挪到目标格中心 ⇒ 距离 0 ⇒ 成功。 */
  rig.position = { x: 10.5, y: 10.5 };
  const near = gatherAt(rig, 10, 10);
  eq(near.kind, 'OK', `★ 负对照:站到格上就该成功(实测 ${near.reason ?? '-'})`);
  eq(rig.cells.get('10,10'), undefined, '世界侧真的扣掉了那一件');
  eq(rig.counts.get(BERRY), 1, '产出进背包');
});

/* ═══════════════ 7. 前置不足 · 工具(零副作用)═══════════════ */

test('FND154-7 ★ 缺工具 ⇒ 拒;「有同词条但不是工具」同样拒;有工具 ⇒ 成功', () => {
  /* 暖松原木要带『木材』的**工具**。 */
  const bare = makeRig({ cells: { '1,0': LOG } });
  const noTool = gatherAt(bare, 1, 0);
  eq(noTool.kind, 'INVALID', '★ 没有工具必须拒');
  ok((noTool.reason ?? '').includes('木材'), `拒因要点名缺哪一族工具(实测:${noTool.reason ?? '-'})`);
  eq(bare.cells.get('1,0'), LOG, '★ 零副作用:那一件还在');
  eq(bare.counts.size, 0, '★ 零副作用:背包没动');

  /* ★ 关键负例:背包里「有带木材词条的另一件」——但它是**原木**,不是工具 ⇒ 仍要拒。
     (若实现只查词条不查类别,这一条会静默变绿。) */
  const logOnly = makeRig({ cells: { '1,0': LOG }, owns: { [LOG]: 4 } });
  const wrongKind = gatherAt(logOnly, 1, 0);
  eq(wrongKind.kind, 'INVALID', '★ 「带木材词条但不是工具」不许顶替工具');
  eq(logOnly.cells.get('1,0'), LOG, '★ 零副作用(同上)');

  /* 负对照:真的带上一把斧头(201,TOOL + 木材)⇒ 成功,且回执带上用到的工具族词条。 */
  const withAxe = makeRig({ cells: { '1,0': LOG }, owns: { [AXE]: 1 } });
  const okOut = gatherAt(withAxe, 1, 0);
  eq(okOut.kind, 'OK', `★ 负对照:有斧头就该采得到(实测 ${okOut.reason ?? '-'})`);
  eq(okOut.effect?.tool, '木材', '回执如实带上是哪一族工具放行的');
  eq(withAxe.counts.get(LOG), 1, '原木进背包');

  /* 徒手资源(露水甜莓)不需要任何工具 —— 正例,防止「工具闸被写成恒真要求」。 */
  const hand = makeRig({ cells: { '1,0': BERRY } });
  eq(gatherAt(hand, 1, 0).kind, 'OK', '★ 徒手可采的资源**不要求**工具(否则采集对浆果类全废)');
});

/* ═══════════════ 8. 越界 / 空格 / 非自然资源 ═══════════════ */

test('FND154-8 ★ 空格 / 世界外 / 非自然资源:三种都拒且零副作用', () => {
  /* (a) 真世界的越界坐标 —— `blockAt` 在世界外回 0。 */
  const a = realRoom();
  const outside = a.runtime.dispatchAction('o', RoomAction.GATHER, { x: -5, y: -5 });
  eq(outside.kind, 'INVALID', '★ 世界外坐标必须拒');
  ok((outside.reason ?? '').includes('没有物件'), `拒因要说明那一格没有东西(实测:${outside.reason ?? '-'})`);
  /* (b) 空格(世界内)。 */
  const pos = a.host.playerPosition?.('o') ?? { x: 0.5, y: 0.5 };
  const emptyCell = { x: Math.floor(pos.x) + 2, y: Math.floor(pos.y) + 2 };
  eq(a.host.materials().blockAt(emptyCell.x, emptyCell.y), 0, '前置:那一格确实是空的');
  const empty = a.runtime.dispatchAction('o', RoomAction.GATHER, { ...emptyCell });
  eq(empty.kind, 'INVALID', '★ 空格必须拒');
  /* (c) 非自然资源:放一块地砖(§3.5)⇒ 拒,而且**不许**把它扣掉。 */
  const tileCell = { x: Math.floor(pos.x) + 1, y: Math.floor(pos.y) + 2 };
  eq(a.host.materials().placeBlock(tileCell.x, tileCell.y, FLOOR_TILE).ok, true, '前置:放一块地砖');
  const tile = a.runtime.dispatchAction('o', RoomAction.GATHER, { ...tileCell });
  eq(tile.kind, 'INVALID', '★ 非自然资源必须拒');
  ok((tile.reason ?? '').includes('不是可采集物'), `拒因要点明「不是可采集物」(实测:${tile.reason ?? '-'})`);
  eq(a.host.materials().blockAt(tileCell.x, tileCell.y), FLOOR_TILE, '★ 零副作用:那块地砖还在');
  eq(a.runtime.authoritativeItemCount('o', FLOOR_TILE), 0, '★ 零副作用:背包里没有多出地砖');

  /* (d) 载荷不是数 ⇒ 拒(不猜默认值)。 */
  const rig = makeRig({ cells: { '1,0': BERRY } });
  const bad = gather({ ...rig.ctx, payload: { x: '1', y: 0 } } as unknown as ActionContext);
  eq(bad.kind, 'INVALID', '★ 非数字坐标必须拒');
  ok((bad.reason ?? '').includes('需要 x / y'), String(bad.reason));
});

/* ═══════════════ 9. 产出落地(背包收不下)═══════════════ */

test('FND154-9 ★ 背包收不下 ⇒ 落回**原地** + 凭证撤销;负对照:收得下就进背包', () => {
  const rig = makeRig({ cells: { '1,0': BERRY }, denyPositive: 1 });
  const out = gatherAt(rig, 1, 0);
  eq(out.ok, true, '背包满不是「采集失败」:那一件已经从格子上下来了');
  eq(out.kind, 'OK');
  eq(out.effect?.gained, 0, '回执如实写 0 件进包');
  eq(out.effect?.dropped, 1, '★ 回执如实写落地的件数');
  ok(out.reason === undefined && typeof out.effect?.note === 'string',
    '★ 落地原因要进回执(note),不许静默');
  eq(rig.cells.get('1,0'), undefined, '格子确实空了(东西没被凭空销毁)');
  eq(rig.dropped.length, 1, '★ 真的落了一件到世界里');
  eq(rig.dropped[0]?.x, 1, '★ 落回**原地**(不是别的格)');
  eq(rig.dropped[0]?.y, 0, '同上(y)');
  eq(rig.dropped[0]?.itemId, BERRY, '落的是那一件');
  eq(rig.revoked.length, 1, '★ 没用掉的那张凭证被**显式撤销**(不留到 tick 末)');
  eq(rig.sources.size, 0, '撤销后它不再是合法来源');

  /* 负对照:不拒绝正向发放 ⇒ 进背包、不掉地。 */
  const okRig = makeRig({ cells: { '1,0': BERRY } });
  const okOut = gatherAt(okRig, 1, 0);
  eq(okOut.effect?.gained, 1, '★ 负对照:收得下就进背包');
  eq(okOut.effect?.dropped, undefined, '★ 且**不**多一个 dropped 键(键的存在本身是事实)');
  eq(okRig.dropped.length, 0, '世界里没有多出掉落物');
});

/* ═══════════════ 10. gatherMul 接到采集量上 ═══════════════ */

test('FND154-10 ★ gatherMul 生效:1.2 ⇒ 期望 1.2 件(20% 翻倍)且回执带键;1 ⇒ 一次都不翻', () => {
  /* 规则本身(字面锚点,不拿实现当期望值):严格小于边界。 */
  eq(gatherCountFor(1.2, 0.199), 2, '1.2 的翻倍概率 20%:roll < 0.2 ⇒ 2 件');
  eq(gatherCountFor(1.2, 0.2), 1, '★ 边界是**严格小于**(roll = 0.2 ⇒ 1 件)');
  eq(gatherCountFor(1, 0), 1, '★ 中性 1 ⇒ 一次都不翻(roll 最小也是 1 件)');
  eq(gatherCountFor(Number.NaN, 0), 1, '★ 非法乘子(NaN)按中性处理,不翻倍');

  /* 生产处理器:同一格、同一 tick、不同玩家 ⇒ 翻倍集合与种子公式逐位一致。
     15% ~ 26% 是 200 个样本下期望 20% 的宽松带(它不是统计显著性问题,是防「恒翻 / 恒不翻」)。 */
  const doubles = (mul: number): { hits: number; total: number; withKey: boolean; avg: number } => {
    let hits = 0;
    let total = 0;
    let withKey = true;
    for (let i = 0; i < 200; i += 1) {
      const actor = `p${i}`;
      const rig = makeRig({ cells: { '1,0': BERRY }, actorId: actor, tick: 11, gatherMul: mul === 1 ? null : mul });
      const out = gatherAt(rig, 1, 0);
      const n = Number(out.effect?.gained ?? 0);
      total += n;
      if (n === 2) hits += 1;
      if (out.effect?.gatherMul === undefined) withKey = false;
      /* 与生产种子公式对账:同一个 (玩家,格,物件,tick) 必须得到同一个件数。 */
      const expected = gatherCountFor(mul, gatherRollFor(actor, 1, 0, BERRY, 11));
      if (n !== expected) throw new Error(`${actor} 的件数与种子公式不一致:${n} ≠ ${expected}`);
    }
    return { hits, total, withKey, avg: total / 200 };
  };

  const buffed = doubles(1.2);
  ok(buffed.hits > 0, '★ 20% 的翻倍真的会发生(不是恒 1 件)');
  ok(buffed.hits < 200, '★ 也不是恒翻倍');
  ok(buffed.avg > 1.15 && buffed.avg < 1.25, `★ 期望件数 ≈ 1.2(实测 ${buffed.avg.toFixed(3)})`);
  ok(buffed.withKey, '★ 非中性乘子进回执(玩家/排查都看得到那 20% 是开着的)');

  /* 负对照:中性(世界源不给 gatherMul)⇒ 200 次全部 1 件,且回执**连键都没有**。 */
  const plain = doubles(1);
  eq(plain.hits, 0, '★ 中性乘子一次都不翻倍');
  eq(plain.total, 200, '★ 每次恰好 1 件');
  eq(plain.withKey, false, '★ 1 是中性值 ⇒ 回执里不该出现 gatherMul 键');
});

/* ═══════════════ 11. 缺按件读口 ⇒ fail-closed ═══════════════ */

test('FND154-11 ★ 需要工具却没有按件读口 ⇒ NOT_IMPLEMENTED(不退回「信客户端」)', () => {
  const rig = makeRig({ cells: { '1,0': LOG }, hasReadPort: false });
  const out = gatherAt(rig, 1, 0);
  eq(out.kind, 'NOT_IMPLEMENTED', '★ 服务端没有按件账读口时,必须如实说「没接好」,不许放行');
  ok((out.reason ?? '').includes('读口'), `拒因要指向缺的那一口(实测:${out.reason ?? '-'})`);
  eq(rig.cells.get('1,0'), LOG, '★ 零副作用');
  /* 负对照:读口在 ⇒ 这一条走的是「缺工具」的 INVALID(两种失败**分档**)。 */
  const withPort = makeRig({ cells: { '1,0': LOG } });
  eq(gatherAt(withPort, 1, 0).kind, 'INVALID', '★ 负对照:读口在 ⇒ 缺工具(INVALID),不是能力缺失');
});

/* ═══════════════ 12. 越权 + 没有物质层 ═══════════════ */

test('FND154-12 ★ 越权 ⇒ PERMISSION 且零副作用;没有物质层 ⇒ NOT_IMPLEMENTED', () => {
  const denied = makeRig({ cells: { '1,0': BERRY }, allowed: false });
  const out = gatherAt(denied, 1, 0);
  eq(out.kind, 'PERMISSION', '★ 越权是权限档(不是 INVALID)');
  eq(denied.cells.get('1,0'), BERRY, '★ 零副作用');
  eq(denied.counts.size, 0, '★ 零副作用');

  /* 负对照:同一份 rig 把闸放开 ⇒ 走业务分支(证明上面拒的是**权限**,不是参数)。 */
  denied.allowed = true;
  eq(gatherAt(denied, 1, 0).kind, 'OK', '★ 负对照:放开权限就成功');

  const noWorld = makeRig({ cells: { '1,0': BERRY }, hasMaterials: false });
  const out2 = gatherAt(noWorld, 1, 0);
  eq(out2.kind, 'NOT_IMPLEMENTED', '没有世界源 ⇒ 能力缺失(显式,不静默)');
  ok((out2.reason ?? '').includes('物质层'), String(out2.reason));
});

report('WS-FND-154-gather');
