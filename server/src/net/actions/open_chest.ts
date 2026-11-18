/**
 * `OPEN_CHEST` —— 打开**公共**储物箱(全房共享一份内容)。
 *
 * ## 本文件同时是「箱子容器模型」的唯一归属地
 *
 * `docs/TASK-96-action-landing-gaps.md` 说这两个动作缺的**不是**一段逻辑,而是
 * 一个**内容物模型**。世界里没有真实箱子实体(那要动 `world_sim` / wire,
 * 不在本次接线范围),于是模型就住在**本模块内**,由两个动作共用:
 *
 * ```
 * chestsByRoom: Map<roomId, Map<cellKey, ChestCell>>
 * ChestCell = { public: ItemStack[]; own: Map<userId, ItemStack[]> }
 *              └ 公共:同一房间**任何人**打开的是同一份
 *                          └ 私有:按玩家各自的抽屉(见 `use_own_chest.ts`)
 * ```
 *
 * 为什么选这个形状:
 *   · 外层按 `roomId`、内层按格子键 —— 公共箱是「位置共享」而**不是**「全局共享」,
 *     两张地图分别的箱子不该互相看见(隔离靠的是键,不是靠调用方自觉);
 *   · `public` 与 `own` 挂在**同一格**上,因为它们在世界里是同一个实体 ——
 *     `OPEN_CHEST` 动它的一半,`USE_OWN_CHEST` 动另一半;
 *   · `cellKey` 用 `${x},${y}` 字符串,省掉一层嵌套 Map,也便于测试直读。
 *
 * ⚠️ 诚实记录边界(接线**没有**做到的事,别当成做到了):
 *   1 箱内内容**不上 wire** —— 客户端暂时看不到箱子里的东西;`OPEN_CHEST` 的只读
 *     回执(`effect.stacks` / `effect.total`)是**唯一**的可见出口,而那要客户端自己解析;
 *   2 容器状态**只活在进程内存里** —— 不落盘、不随 `room.ts` 的存档走,
 *     房间重建即清空(与背包的 `inventoryTotals` 退路缓存同一性质);
 *   3 世界里**没有**真实箱子实体:`registerChest()` 是登记箱子的**唯一**入口
 *     (测试与将来的放置动作都用它)。没登记过的格子 ⇒ `INVALID`「不是箱子」。
 *
 * ## 取放的顺序纪律(与 `material.ts` 同一套)
 *
 * 两侧(容器 / 背包)必须**真的**一起变,或**都不变**:
 *   · 存入:先看容器有没有位置 ⇒ 再 `ctx.applyInventory` 扣背包(负 delta)⇒ 最后写容器;
 *   · 取出:**先扣容器** ⇒ 再 `ctx.grantItemSource`(产出侧凭证,必须早于正向
 *     `applyInventory`)⇒ 再进背包;背包收不下就**放回容器**(不留痕)。
 * 任一步失败都直接返回,另一侧一个字都不动 —— 这是「半步事务」的对照面。
 *
 * ## 判序(与其他动作逐段同构:权限 → 校验 → 能力 → 执行 → 回执)
 *
 * ```
 *   1 `authorize` 不通过          ⇒ PERMISSION(闸在第一行,零状态)
 *   2 x / y 不是有限数            ⇒ INVALID
 *   3 距离闸(R8):拿不到权威位置 / 离目标格超过 `CHEST_REACH`
 *                               ⇒ INVALID,容器一个字都没动
 *   4 这一格不是箱子              ⇒ INVALID
 *   5 `itemId` / `count` 非法     ⇒ INVALID(含 `ITEM_ID_SET` 拒「编号空投」)
 *   6 容器容量 / 件数不够         ⇒ INVALID(容器与背包都还没动)
 *   7 两侧事务(见上)            ⇒ 任一步失败 ⇒ INVALID + 另一侧原样
 *   8 成功                        ⇒ OK + `effect`
 * ```
 *
 * ⚠️ 距离闸在**读容器之前**:闸拒的是「谁在哪」(状态),不是「这一格是什么」;
 *   两条都 `INVALID`,但把距离放在前面 ⇒ 「不是箱子」这条事实不会**先**泄露给
 *   站得老远的调用方(`OPEN_CHEST` 的只读回执会报箱内档数)。
 */
import { ITEM_LIST } from '../../../../shared/constants/items.ts';
import { ItemSourcePurpose } from '../anticheat.ts';
import { bindItemSource, missingItemReadPort, ownedItemCount, unbindItemSource } from './item_source.ts';
import type { ActionOutcome } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════════ 1. 容器模型 ═══════════════════════════ */

/** 容器里的一档东西:与背包同一套「物品 id + 件数」。 */
export interface ItemStack {
  itemId: number;
  count: number;
}

/**
 * 一格箱子:**公共**内容 + **每人一份**私有抽屉。
 *
 * ⚠️ `own` 里**缺失**的 userId 与「空数组」语义相同(抽屉是空的);
 *   抽屉**懒建**(第一次成功写入时才落进 Map,见 `ChestContainers.writable`),
 *   ⇒ 一次**失败**的取放不会留下空抽屉。
 */
export interface ChestCell {
  /** 公共内容:同一房间任何人看到的是**同一份**。 */
  public: ItemStack[];
  /** 私有抽屉:`userId → 内容`;别人看不到也拿不到。 */
  own: Map<string, ItemStack[]>;
}

/** `roomId → cellKey → 箱子`。整个容器模型就这一份状态。 */
const chestsByRoom = new Map<string, Map<string, ChestCell>>();

/**
 * 箱子的容量 —— 按**档**(不同的 `itemId`)算,不是按件数。
 *
 * 取值出处:`shared/constants/items.ts` 的 `513 分类图标储物箱`「提供 24 格存储空间」。
 * 同一 `itemId` 的多次存入合并进**同一档**,不占新格 ⇒ 「满」= 24 个不同的物品。
 */
export const CHEST_SLOTS = 24;

/**
 * 箱子**交互半径**(格)。
 *
 * 出处:`docs/AUDIT-W34.md:108`(R8)「箱子存取不比距离……修法要先定交互半径常量」
 * —— 仓库里**没有**现成的「容器交互半径」,本常量就是那条裁决的落点。
 *
 * 取值 5:与既有 `STREET_LAMP_RADIUS`(`mobs/spawner.ts:43` = 5)同一量级 ——
 *   那个常量同样是「一个**已放置的器件**周围多少格内算玩家在跟前」的口径。
 *   比 `PICKUP_RADIUS`(`material.ts:44` = 2)宽是刻意的:箱子是一格**实体**,
 *   玩家贴着它站时自己的刚体(半径 0.35)就在旁边,2 格会把「站在箱子旁边」
 *   也算成超距 ⇒ 箱子没法用。
 *
 * ⚠️ 它是**防远程开箱**的防呆界,**不是**视线闸:闸内不判中间有没有墙
 *   (`world/vision.ts` 才有墙的判定;R5 记了「接视线要在热路径跑 O(格)」,
 *   今天没接)⇒ 闸外一律拒,闸内一律放。
 */
export const CHEST_REACH = 5;

/**
 * 玩家**权威位置**(浮点)到目标**格**(整数格号)的欧氏距离。
 *
 * 与 `world_sim` 判地面物品距离的 `Math.hypot`(`consumeGroundItem` /
 * `takeGroundItemNear`)同一口径 —— 不用曼哈顿/切比雪夫:那会让斜着站
 * 比正着站更远,与玩家直觉相反。
 */
function chestDistance(ax: number, ay: number, x: number, y: number): number {
  return Math.hypot(ax - x, ay - y);
}

/** 格子键。用字符串省掉一层嵌套 Map,失败信息里也能直接打印。 */
function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * 把某一格登记为箱子 —— 世界里**没有**箱子实体时,这是唯一的箱子来源。
 *
 * ⚠️ 幂等:已登记的格子保持原内容(重复登记不会清空别人的东西)。
 */
export function registerChest(roomId: string, x: number, y: number): void {
  let room = chestsByRoom.get(roomId);
  if (room === undefined) {
    room = new Map<string, ChestCell>();
    chestsByRoom.set(roomId, room);
  }
  if (!room.has(cellKey(x, y))) {
    room.set(cellKey(x, y), { public: [], own: new Map<string, ItemStack[]>() });
  }
}

/**
 * 丢弃**某一个房间**的全部箱子(容器模型 + 私有抽屉)。
 *
 * ## 为什么必须有它(审计 P2:三个侧账无回收)
 *
 * `chestsByRoom` 是模块级 Map,修前**全仓 0 个回收调用点** ⇒ `RESET_WORLD` 之后
 * 旧箱子里的东西还在:世界已经按新种子重建,而「箱子里那 12 件 733」成了
 * 一份**不需要产出**的来源 —— 取出来就是净产出(+1 真值),这正是物品真值层
 * 要防的形态。⇒ 世界重置成功时按 `roomId` 把这一格账一起丢掉。
 *
 * ⚠️ **只清本房间**:键就是 `roomId`,不遍历、不 `clear()` 全表 —— 另一个房间的
 * 箱子与这次重置无关(判据里那条隔离钉的就是它)。
 * ⚠️ 连带丢掉**登记**(哪一格是箱子):世界重建后那面墙/那件器物都不在了,
 * 保留登记等于让旧世界的格子继续可存取。要箱子就重新 `registerChest`。
 */
export function forgetChests(roomId: string): void {
  chestsByRoom.delete(roomId);
}

/** 取一格箱子;`null` = 这一格**不是**箱子。 */
function findChest(roomId: string, x: number, y: number): ChestCell | null {
  return chestsByRoom.get(roomId)?.get(cellKey(x, y)) ?? null;
}

/** 容器内容的**副本**(供测试与诊断直读;不是写入入口)。 */
function snapshot(stacks: readonly ItemStack[]): ItemStack[] {
  return stacks.map((s) => ({ itemId: s.itemId, count: s.count }));
}

/** 公共箱容快照;`null` = 不是箱子。 */
export function publicChestContents(roomId: string, x: number, y: number): ItemStack[] | null {
  const cell = findChest(roomId, x, y);
  return cell === null ? null : snapshot(cell.public);
}

/** 某玩家**自己的**抽屉快照;`null` = 不是箱子。抽屉不存在时回空数组。 */
export function ownChestContents(
  roomId: string,
  x: number,
  y: number,
  userId: string,
): ItemStack[] | null {
  const cell = findChest(roomId, x, y);
  if (cell === null) return null;
  return snapshot(cell.own.get(userId) ?? []);
}

/* ═══════════════════════════ 2. 取放引擎(两个动作共用) ═══════════════════════════ */

/** 冻结内容表里的合法物品 id。用于拒绝「编号空投」(不在表里的 id 一律不认)。 */
const ITEM_ID_SET: ReadonlySet<number> = new Set(ITEM_LIST.map((i) => i.id));

/**
 * 从 action payload 里取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝)。
 *
 * ⚠️ 与 `material.ts` 的同名局部函数**逐字相同**,但那一份没有导出、又不许改
 *   (`material.ts` 不在本次改动范围)⇒ 只能各留一份。它是三行的**纯守卫**,
 *   不构成「两份实现」那种会漂的判定。
 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function countOf(stacks: readonly ItemStack[], itemId: number): number {
  return stacks.find((s) => s.itemId === itemId)?.count ?? 0;
}

function totalOf(stacks: readonly ItemStack[]): number {
  return stacks.reduce((s, x) => s + x.count, 0);
}

/** 往容器里加东西;同一 `itemId` 合并进已有那一档。 */
function addToStacks(stacks: ItemStack[], itemId: number, n: number): void {
  const hit = stacks.find((s) => s.itemId === itemId);
  if (hit) hit.count += n;
  else stacks.push({ itemId, count: n });
}

/** 从容器里拿走东西;**拿空的那一档要删掉**(否则「格数」会算到空的档上)。 */
function removeFromStacks(stacks: ItemStack[], itemId: number, n: number): void {
  const i = stacks.findIndex((s) => s.itemId === itemId);
  if (i < 0) return;
  stacks[i].count -= n;
  if (stacks[i].count <= 0) stacks.splice(i, 1);
}

/**
 * 目标容器的**只读**视图与**可写**入口。
 *
 * 为什么拆成两个(而不是一个懒建的回调):私有抽屉是**懒建**的。若解析时就把
 * 抽屉建出来,一次**失败**的取放(或一次只读打开)会留下一个空抽屉 ——
 * 空抽屉没有内容,但它是一条**残留**,与本文件开头的「失败 ⇒ 两边都不留痕」
 * 相抵。⇒ 只读走 `read`,**只在确定要写**且校验已过时才碰 `writable`。
 */
export interface ChestContainers {
  /** 只读内容;`null` = 这一格不是箱子。 */
  read(roomId: string, x: number, y: number): readonly ItemStack[] | null;
  /** 可写容器;调用前「不是箱子」已被排除、且本次确要写入。 */
  writable(roomId: string, x: number, y: number): ItemStack[];
}

/** 公共箱的容器访问(两个动作里 `OPEN_CHEST` 用这一份)。 */
export const PUBLIC_CHEST: ChestContainers = {
  read: (roomId, x, y) => findChest(roomId, x, y)?.public ?? null,
  writable: (roomId, x, y) => {
    const cell = findChest(roomId, x, y);
    if (cell === null) throw new Error(`内部错误:箱子在 read 与 writable 之间消失了(${roomId} ${x},${y})`);
    return cell.public;
  },
};

/**
 * 某玩家**自己**的抽屉访问(`USE_OWN_CHEST` 用这一份)。
 *
 * ⚠️ 只看得到 `actorId` 自己那一格 —— 「别人看不到也拿不到」正是靠**没有**别的
 *   userId 入口来实现的:调用方拿到的数组里**不可能**含别人的东西。
 */
export function ownChestContainers(actorId: string): ChestContainers {
  return {
    read: (roomId, x, y) => {
      const cell = findChest(roomId, x, y);
      return cell === null ? null : (cell.own.get(actorId) ?? []);
    },
    writable: (roomId, x, y) => {
      const cell = findChest(roomId, x, y);
      if (cell === null) throw new Error(`内部错误:箱子在 read 与 writable 之间消失了(${roomId} ${x},${y})`);
      const cur = cell.own.get(actorId);
      if (cur) return cur;
      const fresh: ItemStack[] = [];
      cell.own.set(actorId, fresh);
      return fresh;
    },
  };
}

/**
 * 取放**唯一**的执行体(两个动作各自只负责提供「哪个容器」)。
 *
 * 报文字段(沿用 `ActionPayload`,不新增字段):
 *   · `x` / `y`  —— 目标格(必须是已登记的箱子格);
 *   · 无 `itemId` —— **只打开看**:不动任何一侧,回内容摘要;
 *   · `itemId`   —— 要取放的物品(必须在冻结内容表里);
 *   · `count`    —— **正 = 存入**(背包 −count、容器 +count),**负 = 取出**
 *                   (容器 −|count|、背包 +|count|);缺省 1,0 / 非整数一律拒。
 *
 * ⚠️ 方向编码在 `count` 的**符号**上:`ActionPayload` 没有「方向」字段,
 *   而它属于 `room.ts`(不在本次改动范围),不新增字段。
 */
export function runChestAction(ctx: ActionContext, containers: ChestContainers): ActionOutcome {
  /* 权限闸写在这里,不写进容器模型 —— 模型不知道「谁」。`ctx.action` 决定权限位:
     `OPEN_CHEST` ⇒ publicStorage,`USE_OWN_CHEST` ⇒ baseline(见 `ACTION_PERMISSION`)。 */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  const x = numField(ctx.payload.x);
  const y = numField(ctx.payload.y);
  if (x === null || y === null) return { ok: false, kind: 'INVALID', reason: '需要 x / y(数字)' };

  /* ── 距离闸(docs/AUDIT-W34.md:108 的 R8)──
     坐标是**客户端自报**的,而「谁在哪」只有服务端知道 ⇒ 取**权威位置**
     (`hostPositionOf`,与 `material.ts` 的丢/捡**同一读法**)与目标格比距离,
     超距一律拒。拿不到位置(不在世界里 / 老世界源没有这个读口)也**拒**
     —— fail-closed,与 `DROP_ITEM` / `PICKUP_ITEM` 的「拿不到权威位置 ⇒ INVALID」
     同口径,不退回「信客户端」。
     ★ 位置判在**读容器之前**:被拒时容器一个字都没动(零副作用)。 */
  const at = ctx.hostPositionOf(ctx.actorId);
  if (at === null) {
    return { ok: false, kind: 'INVALID', reason: '拿不到该玩家的权威位置(不在世界里)' };
  }
  const dist = chestDistance(at.x, at.y, x, y);
  if (dist > CHEST_REACH) {
    return {
      ok: false, kind: 'INVALID',
      reason: `离箱子 (${x},${y}) 太远(要 ${CHEST_REACH} 格内,`
        + `实测 ${Math.round(dist * 1000) / 1000};半径的出处见 CHEST_REACH)`,
    };
  }

  const roomId = ctx.state.roomId;
  const view = containers.read(roomId, x, y);
  if (view === null) return { ok: false, kind: 'INVALID', reason: `格 (${x},${y}) 不是箱子` };

  const itemId = numField(ctx.payload.itemId);
  /* 只带 x/y = 「打开看」:只读,不动任何一侧。 */
  if (itemId === null) {
    return {
      ok: true, kind: 'OK',
      effect: { x, y, stacks: view.length, total: totalOf(view) },
    };
  }
  if (!ITEM_ID_SET.has(itemId)) {
    return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
  }
  const count = numField(ctx.payload.count) ?? 1;
  if (!Number.isInteger(count) || count === 0) {
    return {
      ok: false, kind: 'INVALID',
      reason: `count 必须是非零整数(正 = 存入 / 负 = 取出;实测 ${String(ctx.payload.count)})`,
    };
  }

  if (count > 0) {
    /* ── 存入 ──
       先看容器有没有位置:新的一档要占一格,已有一档则总能再塞(合并)。 */
    if (countOf(view, itemId) === 0 && view.length >= CHEST_SLOTS) {
      return {
        ok: false, kind: 'INVALID',
        reason: `箱子已满(${CHEST_SLOTS} 格)⇒ 放不下新的一档 ${itemId}`,
      };
    }
    /* ★ 按件权威读口(审计 P1):`itemId` 是报文里**客户端自报**的,总量守恒挡不住
       「存入一件自己没有的 id」—— 存进去之后取出来就是另一件东西了。
       缺读口 ⇒ 显式 NOT_IMPLEMENTED;不够件 ⇒ INVALID。两条都**零副作用**。 */
    const owned = ownedItemCount(ctx, itemId);
    if (owned === null) return missingItemReadPort(ctx);
    if (owned < count) {
      return {
        ok: false, kind: 'INVALID',
        reason: `背包里不够 ${count} 个 ${itemId}(服务端账面 ${owned} 件)`,
      };
    }
    /* 扣背包:这一个动作**先扣背包**(与放置块同向)。被拒 ⇒ 容器一个字都没动。 */
    const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -count }] });
    if (!spend.allowed) {
      return {
        ok: false, kind: 'INVALID',
        reason: `背包里不够 ${count} 个 ${itemId}(${spend.rejectCode ?? '被拒'})`,
      };
    }
    const live = containers.writable(roomId, x, y);
    addToStacks(live, itemId, count);
    return {
      ok: true, kind: 'OK',
      effect: { x, y, itemId, stored: count, stacks: live.length, total: totalOf(live) },
    };
  }

  /* ── 取出 ── */
  const take = -count;
  const have = countOf(view, itemId);
  if (have < take) {
    return { ok: false, kind: 'INVALID', reason: `箱子里不够 ${take} 个 ${itemId}(有 ${have})` };
  }
  /* **先扣容器**(与 `material.ts` 的 PICKUP「先扣地面」同一纪律):
     反过来先加背包、再扣容器,中途失败就会造出复制品。 */
  const live = containers.writable(roomId, x, y);
  removeFromStacks(live, itemId, take);
  /* 产出侧凭证必须早于正向 `applyInventory`,否则会被反作弊按「凭空产出」拒。
     ★ 绑定:令牌绑的就是**从这一格取出的这一件**(`itemId` 已由容器账本核过件数)。 */
  const src = bindItemSource(ctx, itemId, ItemSourcePurpose.CHEST_TAKE);
  const gain = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: take, source: src }] });
  if (!gain.allowed) {
    /* 背包收不下 ⇒ **放回容器**(否则东西被吞)。
       ★ 审计 P3:这张凭证已经登记、却没有被用掉 ⇒ **显式撤销**。修前它留到 tick 末,
       本 tick 内任何另一条分支拿同一张串铸 +delta 都会被「登记过」放行
       (靠「消耗侧不读」兜是巧合,不是判据)。放回容器与撤销凭证都必须发生。 */
    addToStacks(live, itemId, take);
    unbindItemSource(ctx, src);
    return {
      ok: false, kind: 'INVALID',
      reason: `背包收不下(${gain.rejectCode ?? '被拒'})⇒ 已放回箱子`,
    };
  }
  return {
    ok: true, kind: 'OK',
    effect: { x, y, itemId, taken: take, stacks: live.length, total: totalOf(live) },
  };
}

/* ═══════════════════════════ 3. 处理器 ═══════════════════════════ */

/** `OPEN_CHEST`:动的是那一格的**公共**内容(全房共享)。 */
export const openChest: ActionHandler = (ctx: ActionContext) => runChestAction(ctx, PUBLIC_CHEST);
