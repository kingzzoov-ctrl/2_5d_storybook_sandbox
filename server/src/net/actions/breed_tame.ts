/**
 * `BREED_TAME` —— **投喂 / 驯服 / 繁殖 / 送进牧场**。
 *
 * 接线前本文件是 `notImplemented(...)`(`docs/TASK-96-action-landing-gaps.md`:
 * 「`mobs/taming.ts` 存在但为 **orphan**:缺宠物容器与驯服交互(它的喂食出口零生产调用)」)。
 *
 * ## 分支口径:一个动作、四个子操作,由 `payload.op` 选
 *
 * `RoomAction` 只有一个 `BREED_TAME`(动作表里没有 `FEED_PET` / `TAME_PET` /
 * `BREED` / `SEND_TO_RANCH`),所以子操作只能是**同一动作的几种 payload**:
 *
 * ```ts
 * { op: 'FEED',  petId, itemId, mobId? }   // 投喂:扣 1 件、亲密度 +1(物种食物另算驯化)
 * { op: 'TAME',  petId }                   // 驯服:亲密度达标 + 无主 ⇒ 记主人并下 FOLLOW
 * { op: 'BREED', petId, mateId }           // 繁殖:两只都归自己且都达标 ⇒ 记一条记录
 * { op: 'RANCH', petId }                   // ★ WS-FND-119 送进牧场 ⇒ host.setRanchPets
 * ```
 *
 * `op` / `petId` / `mobId` / `mateId` **不在** `ActionPayload`(`room.ts`)里 ——
 * 那条接口是别的动作的字段表;本模块的键照 `craft.ts` 的先例**局部**收窄读取
 * (见 `BreedTamePayload`),`room.ts` 不用动。
 *
 * ## ★ 定案(2026-11-19):宠物容器**不在本模块**,唯一事实源是 `mobs/taming.ts` 第 6 节
 *
 * 本模块此前自带 `Map<roomId, Map<petId, PetEntry>>`(归属 / 好感 / 已投喂三件全在
 * 这里),而 `mobs/taming.ts` 另有 `PetRecord` + 它自己的容器 ⇒ **两份宠物状态**。
 * 现在容器搬进 `mobs/taming.ts`(按玩家存:`roomId → ownerId → petId`),本模块只留
 * **投影 + 动作语义**:
 *
 * ```
 * 权威(唯一)   taming.ts  PET_BOX —— { petId, ownerId, bond, record: PetRecord }
 * 投影(本模块)  petsOfRoom / tameOwnerOf / tamedPetsOfRoom —— 算出来的只读视图
 * ```
 *
 * 各子操作调的是 `mobs/taming.ts` 的**同一批函数**(不是复制一份等价逻辑):
 *
 * ```
 * FEED   createPetRecord(首次登记,顺带判「这物种可驯服吗」)
 *        + feedPet(该物种**自己**的食物才推进 stage/fedCount)
 * TAME   commandPet(FOLLOW) —— 认主那一刻宠物开始跟随(该函数唯一的生产调用点)
 * RANCH  sendToRanch(在圈标记 = 权威;圈养上限也在这里判)
 *        + systems/intake.ts 的 addPetToRanch(名单投影:牧场物种 / 亲和下限 / petId 去重)
 * ```
 *
 * ## 两个计数器,不是两份进度(读这条才不会误以为「又并存两份」)
 *
 * ```
 * slot.bond        玩家侧口径:每一次**被接受**的投喂 +1(不论那件是不是物种食物);
 *                  认主门槛 `AFFECTION_REQUIRED` 用它 —— 这是**动作层契约**
 *                  (tests/WS-FND-29 / WS-FND-41 / WS-FND-105 / WS-FND-119 都钉着
 *                  「背包里有那一件就能喂」,不验食谱)
 * record.fedCount  驯化口径:`feedPet` 只数「该物种自己的食物」(`MobDef` 的 tameItem 字段),`stage` 由它推
 *                  (`requiredFeeds` 按物种,见 `TAME_FEED_COUNT`)
 * ```
 *
 * ⇒ 拿黄金小麦(123)喂花栗鼠(它吃 121):亲密度 +1(**接受**),但 `stage` 仍是
 *   `WILD` —— 它更熟,却还没被驯化。两个数合成一个,必然有一边的语义是假的。
 * ⚠️ 本模块**不读** `MobDef` 的 tameItem 字段(那条规则只存在于 `mobs/taming.ts`)——
 *   否则 `tests/WS-04` 的「全仓 dot 读该字段的文件恰好 4 个」会多出第 5 个。
 *
 * ## `RANCH` 为什么还要过 `systems/intake.ts`
 *
 * 圈养名单进世界那一步(`WorldSim.setRanchPets`)在修前于 `server/**` 内**零调用**
 * ⇒ 牧场日结每慢帧空跑而校验全绿。判定(谁能进圈 / 亲和下限 / 去重)在
 * `intake.ts`(纯函数);**在圈这个事实**的权威是 `taming.ts` 的
 * `PetRecord.inRanch` —— 本模块只把两者按顺序接起来,不另立第三个地方记「在圈」。
 *
 * ## 事务性(失败路径两侧都不留痕)
 *
 * ```
 * 所有前置校验(权限 / op / petId / 物种 / 物品 / 亲密度 / 归属)
 *   ⇒ 任何一条不过:直接返回,**背包与容器两边都没被碰过**;
 * 喂食在**副本**上试算(`feedPet` 改的是 `{ ...record }`),过了才写回容器;
 * 唯一可能失败的写入 = ctx.applyInventory(负 delta)
 *   ⇒ 被拒(背包里没有那件)⇒ 容器仍未动(副本没提交);
 * 之后只剩容器赋值(不可能失败)⇒ 不存在「扣了东西却没涨亲密度」。
 * ```
 *
 * 繁殖**不产出任何物品、不造任何生物实体**(那两样是别处的权威):只往
 * `Map<roomId, BreedRecord[]>` 里登记一条记录,并在 `effect` 里说明。
 *
 * ## 权限
 *
 * `ACTION_PERMISSION.BREED_TAME = 'baseline'`(`room.ts`)⇒ 只要在房里就能做
 * (GUEST 也行)。闸写在这里,不写在别处:世界/内容方法没有「谁」这个参数
 * (与 `material.ts` 同一例外)。
 *
 * ## 宠物归属**世界侧今天还看不见**(边界 + 那一行接线)
 *
 * 归属住在 `mobs/taming.ts` 的容器里,**世界与 AI 完全不知道**这条记录存在:
 *
 * ```
 * 权威(本模块可查)  tameOwnerOf(roomId, petId) / tamedPetsOfRoom(roomId)
 * 投影链(今天)      world_sim.ts listWildlife() 把 tameOwnerId **硬编码 `''`**
 *                    ⇒ room.ts projectWildlife() 抄进 state.wildlife
 *                    ⇒ 客户端快照恒为「野生」
 * ```
 *
 * 建议接线(一行;归属以 `taming.ts` 的容器为权威):
 * ```
 *   room.ts:1925   tameOwnerId: w.tameOwnerId,
 *              ⇒   tameOwnerId: tameOwnerOf(this.state.roomId, w.id) ?? '',
 *   并在 room.ts 顶部 import { tameOwnerOf } from './actions/breed_tame.ts';
 * ```
 * ⚠️ 本模块**绝不**自己写 `state.wildlife` —— 那会与投影层争同一个字段(两份写者)。
 * 世界侧存活清单的权威只属于 `world_sim`,本模块只提供归属。
 *
 * ## 取走后**不清除**(关键口径)
 *
 * `tameOwnerOf` / `tamedPetsOfRoom` 是**纯读**:投影**每帧**都会问一次,若「取走
 * 即清」则主人只能在一帧里被看见(下一帧又变回野生)。⇒ 查询**不**消费登记,
 * 同一 `(roomId, petId)` 可无限次问、答案恒定(`tests/WS-FND-41` 第 7 条钉这一条)。
 */
import { tameableMobs } from '../../../../shared/constants/mobs.ts';
import { ITEM_LIST } from '../../../../shared/constants/items.ts';
/* ★ 唯一事实源:宠物容器、喂食/驯化规则、在圈标记、三指令全在这里。 */
import {
  RANCH_CAPACITY,
  TameCommand,
  commandPet,
  createPetRecord,
  feedPet,
  forgetRoomPets,
  petSlotOf,
  petSlotsOfRoom,
  petsOfPlayer,
  putPetSlot,
  sendToRanch,
  type PetRecord,
  type PetSlot,
} from '../../mobs/taming.ts';
/* ★ 实例 id → 物种 id 的唯一规则在 `mobs/spawner.ts`;这里只用来对账客户端带来的 mobId。 */
import { mobSpeciesId } from '../../mobs/spawner.ts';
/* ★ WS-FND-119:圈养名单的判定在 systems 层(纯函数);本文件只把结果交给宿主。 */
import { addPetToRanch, roomSystemsPortOf } from '../../systems/intake.ts';
import { ownedItemCount } from './item_source.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════ 1. 常量与报文形状 ═══════════════════════ */

/** 认主门槛:亲密度到这个数才算「养熟」(驯服与繁殖共用同一条线)。 */
export const AFFECTION_REQUIRED = 3;

/** 每个房间保留的繁殖记录条数上限(超出丢最旧的)。 */
export const MAX_BREED_RECORDS = 64;

/** 四个子操作。用 `as const` 对象(本仓禁 `enum`)。 */
export const TameOp = {
  FEED: 'FEED',
  TAME: 'TAME',
  BREED: 'BREED',
  /**
   * ★ WS-FND-119:送进牧场(第七轮补的第一个真实入口)。
   *
   * 修前实测:`WorldSim.setRanchPets` 在 `server/**` 内**零调用** ⇒ 生产里
   * `ranchPets` 恒空 ⇒ 牧场日结每慢帧空跑而全部校验是绿的。
   */
  RANCH: 'RANCH',
} as const;
export type TameOp = (typeof TameOp)[keyof typeof TameOp];

/** `op` 的取值表;拒绝报文时用它列出**全部**合法值(不猜)。 */
const TAME_OPS: readonly string[] = Object.values(TameOp);

/**
 * 本动作的报文键。
 *
 * `ActionPayload` 只声明了别的动作的字段,而这条通道本就是泛型的(`ws_server` 把
 * 客户端 JSON 原样递进来)⇒ 在自己的模块里局部读自己的键。照 `craft.ts` 的同一手法。
 */
type BreedTamePayload = ActionPayload & {
  op?: unknown;
  petId?: unknown;
  mobId?: unknown;
  mateId?: unknown;
};

/** 冻结内容表里的合法物品 id(拒绝「编号空投」,同 `material.ts`)。 */
const ITEM_ID_SET: ReadonlySet<number> = new Set(ITEM_LIST.map((i) => i.id));

/**
 * 内容层的「可驯服生物」名单(有 `tameItem` 的那些)。
 *
 * ⚠️ 只调 `tameableMobs()`,**不**在这里读 `MobDef` 的 `tameItem` 字段 —— 那个读法
 *   会让 `tests/WS-04` 的事实快照当场变红(它会成为第 5 个读者)。
 *   第二道闸是 `createPetRecord`(`canTame`:行为类别必须是 TAMEABLE / MOUNT /
 *   PASSIVE_UNKILLABLE)—— 两道都在,因为两个集合**不相等**(例如 `mob_pangolin`
 *   有 `tameItem` 但行为是 MISCHIEVOUS)。
 */
const TAMEABLE_MOB_IDS: ReadonlySet<string> = new Set(tameableMobs().map((m) => m.id));

/* ═══════════ 2. 容器投影(权威在 `mobs/taming.ts` 第 6 节)═══════════ */

/**
 * 一只宠物在这个模块里的**投影**形状。
 *
 * 保留它是因为它是回执与判据的既有形状(`affection` / `feeds` 是两个读数),但它
 * 现在是**算出来的**,不是存下来的 —— 存下来的只有 `taming.ts` 容器里的那一条。
 */
export interface PetEntry {
  petId: string;
  mobId: string;
  ownerId: string | null;
  /** 亲密度(= 容器里的 `bond`)。 */
  affection: number;
  /** 已投喂次数;与 `affection` 同源同值(分成两个字段是回执的既有形状)。 */
  feeds: number;
}

/** 一条繁殖记录。**只是记录** —— 不携带物品、不指向任何生物实体。 */
export interface BreedRecord {
  recordId: string;
  roomId: string;
  /** 发起繁殖的玩家(两只宠物的主人)。 */
  ownerId: string;
  petId: string;
  mateId: string;
  parentsMobIds: readonly [string, string];
  seq: number;
}

/** `roomId → 繁殖记录(最旧在最前)`。宠物本身**不**在这里(见文件头定案)。 */
const ROOM_BREEDS = new Map<string, BreedRecord[]>();
/** 记录序号(仅用于生成可读且唯一的 `recordId`)。 */
let breedSeq = 0;

function roomBreedsOf(roomId: string): BreedRecord[] {
  let list = ROOM_BREEDS.get(roomId);
  if (list === undefined) {
    list = [];
    ROOM_BREEDS.set(roomId, list);
  }
  return list;
}

/**
 * 观测口:某房间当前的宠物状态(**只读快照**,不参与任何判定)。
 *
 * 为什么要有它:本动作的回执(`effect`)只带这一次的增量,而「失败路径两侧都不变」
 * 这类断言要看**连续两次操作之间的差**。宿主没有任何宠物读口(ActionContext 里
 * 没有),故由本模块给出 —— 与 `room.lastSaveReport` 同一处置:把「做了没有、
 * 生效几条」显式暴露,而不是让调用方猜。
 */
export function petsOfRoom(roomId: string): PetEntry[] {
  return petSlotsOfRoom(roomId)
    .map((s) => ({
      petId: s.petId, mobId: s.record.mobId, ownerId: s.ownerId,
      affection: s.bond, feeds: s.bond,
    }))
    .sort((a, b) => (a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0));
}

/**
 * 一条**归属登记**的只读副本:`petId → ownerId`。
 *
 * 形状是给**投影层**用的 —— `world_sim.listWildlife()` / `room.projectWildlife()`
 * 手里只有一个生物 id,需要反查它的主人(见文件头「世界侧今天还看不见」)。
 */
export interface TameOwnerRecord {
  petId: string;
  /** 恒非空:本查询只列**有主**的宠物(`ownerId === null` 的不在此列)。 */
  ownerId: string;
}

/**
 * ★ 权威查询:某房间里某只宠物的主人。
 *
 * ```
 * 已驯服           ⇒ 主人 id(非空字符串)
 * 有记录但未驯服   ⇒ null
 * 房间里没有该记录 ⇒ null
 * ```
 *
 * ⚠️ 返回类型是 `string | null`,**永远不是 `undefined`** —— 宿主/投影层若用
 *   `=== undefined` 判失败,会把「未驯服」与「查错了」混为一谈。
 * ⚠️ **纯读、不消费**:调用它**不会**清空或改动容器(投影**每帧**都会问 ⇒ 必须幂等)。
 */
export function tameOwnerOf(roomId: string, petId: string): string | null {
  /* 刻意**不**走任何「没有就建一个」的 helper —— 对不存在的房间问一次不许留痕。 */
  return petSlotOf(roomId, petId)?.ownerId ?? null;
}

/**
 * 只读查询:某房间**全部有主宠物**的归属(每个元素都是**新副本**)。
 * ⚠️ 返回的是**快照**:调用方改数组或改元素**都不会**回写内部。
 */
export function tamedPetsOfRoom(roomId: string): TameOwnerRecord[] {
  const out: TameOwnerRecord[] = [];
  for (const s of petSlotsOfRoom(roomId)) {
    if (s.ownerId !== null) out.push({ petId: s.petId, ownerId: s.ownerId });
  }
  out.sort((a, b) => (a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0));
  return out;
}

/** 观测口:某房间已登记的全部繁殖记录(最旧在最前)。 */
export function breedRecordsOfRoom(roomId: string): readonly BreedRecord[] {
  return [...(ROOM_BREEDS.get(roomId) ?? [])];
}

/**
 * 丢弃某房间的全部状态(宠物容器 + 繁殖记录)。
 *
 * 生产调用点:`RESET_WORLD` 的房间侧账回收(`tests/WS-FND-105` 钉着「只清本房间」);
 * 测试用它做房间隔离。宠物那一半委派给 `forgetRoomPets` —— 容器的主人。
 */
export function forgetRoom(roomId: string): void {
  forgetRoomPets(roomId);
  ROOM_BREEDS.delete(roomId);
}

/* ═══════════════════════ 3. payload 取值 ═══════════════════════ */

/** 取一个有限数;不是数或缺失 ⇒ `null`(调用方显式拒绝,不猜默认值)。 */
function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 取一个非空字符串;否则 `null`。 */
function strField(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/* ═══════════════════════ 4. 处理器 ═══════════════════════ */

/**
 * `BREED_TAME`:投喂 / 驯服 / 繁殖 / 送进牧场(按 `payload.op` 分支)。
 *
 * ⚠️ 显式写返回类型:`effect` 的每支字段集不同,让 TS 去推会把它们并成一个
 *   带 `undefined` 的联合(同 `material.ts`)。
 */
export const breedTame: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* ── 1 权限闸:越权在此返回,且**未产生任何副作用** ── */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* ── 2 分支选择:op / petId 必须显式给足(缺项不猜) ── */
  const p = ctx.payload as BreedTamePayload;
  const op = strField(p.op);
  if (op === null || !TAME_OPS.includes(op)) {
    return {
      ok: false, kind: 'INVALID',
      reason: `需要 op(${TAME_OPS.join(' / ')};实测 ${JSON.stringify(p.op)})`,
    };
  }
  const petId = strField(p.petId);
  if (petId === null) {
    return { ok: false, kind: 'INVALID', reason: '需要 petId(非空字符串)' };
  }
  /* 房间身份只从 `state` 取(ActionContext 没有 roomId)。 */
  const roomId = ctx.state.roomId;
  /* 只读查:没有记录 ⇒ null(**不** materialize 空登记)。 */
  const slot: PetSlot | null = petSlotOf(roomId, petId);

  /* ── 2b ★ WS-FND-119「送进牧场」:写 `roomSystemsState.ranchPets`(生产里的**唯一**入口) ──
   *
   * 前置(任何一条不过 ⇒ 零副作用,名单一位不动):
   *   · 有记录、**主人是本人**、亲密度达标(与驯服共用 `AFFECTION_REQUIRED`);
   *   · 宿主必须有圈养名单的读 + 写口(缺 ⇒ `NOT_IMPLEMENTED`,不假装送成了);
   *   · 物种必须进得了牧场(`systems/intake.ts` 的 `RANCH_PRODUCE_BY_SPECIES` 说了算);
   *   · `taming.ts` 的 `sendToRanch` 判「已驯化」与圈养上限(`RANCH_CAPACITY`)。
   *
   * ★ 顺序是判据的一部分:物种拒绝(intake)排在驯化拒绝(sendToRanch)之**前**,
   *   否则花栗鼠会先被「还没驯化」拒掉,拿到的理由就不再是「不进牧场」那条。
   *   亲和度换算只用既有常量:`affection / AFFECTION_REQUIRED` 钳到 0..1
   *   (达标即 1.0 ≥ `RANCH_AFFINITY_MIN`,未达标的分支上面已经拒掉)。
   */
  if (op === TameOp.RANCH) {
    if (slot === null) {
      return { ok: false, kind: 'INVALID', reason: `宠物 ${petId} 没有记录 ⇒ 先投喂(FEED)、再驯服(TAME)` };
    }
    if (slot.ownerId !== ctx.actorId) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 的主人不是 ${ctx.actorId}(实为 ${slot.ownerId ?? '无主'})⇒ 不能送别人的宠物进牧场`,
      };
    }
    if (slot.bond < AFFECTION_REQUIRED) {
      return {
        ok: false, kind: 'INVALID',
        reason: `好感 ${slot.bond}/${AFFECTION_REQUIRED} 未达标 ⇒ 还没养熟,不进牧场`,
      };
    }
    const port = roomSystemsPortOf(ctx.host);
    if (port === null
      || typeof port.setRanchPets !== 'function'
      || typeof port.ranchPets !== 'function') {
      return {
        ok: false, kind: 'NOT_IMPLEMENTED',
        reason: '宿主没有圈养名单写口(`setRanchPets` / `ranchPets`)⇒ 没有牧场可送(零副作用)',
      };
    }
    const affinity = Math.min(1, Math.max(0, slot.bond / AFFECTION_REQUIRED));
    const merged = addPetToRanch(port.ranchPets(), { petId, speciesId: slot.record.mobId, affinity });
    if (!merged.ok) {
      return { ok: false, kind: 'INVALID', reason: `送不进牧场:${merged.reason}` };
    }
    /* 在圈标记 = 本模块的权威(`PetRecord.inRanch`),圈养上限也在那里判。
       失败 ⇒ 名单一个字都没写(merged 是纯函数算出来的新数组)。 */
    const inRanch = sendToRanch(
      petsOfPlayer(roomId, ctx.actorId).map((s) => s.record),
      slot.record,
    );
    if (!inRanch) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 进不了圈:还没驯化(该物种的食物 ${slot.record.fedCount}/${slot.record.requiredFeeds})或牧场已满(${RANCH_CAPACITY})`,
      };
    }
    port.setRanchPets(merged.next);
    return {
      ok: true, kind: 'OK',
      effect: {
        op, petId, mobId: slot.record.mobId, affinity,
        ranchPets: merged.next.length,
        note: '已进牧场:慢帧跨日时按 ranch.ts 的「自动进食 + 每日产出」结算(见 world_sim 的 settleRanchIfDayChanged)',
      },
    };
  }

  /* ── 3a 投喂:扣 1 件 → 亲密度 +1(物种食物另算驯化进度) ── */
  if (op === TameOp.FEED) {
    const itemId = numField(p.itemId);
    if (itemId === null || !Number.isInteger(itemId)) {
      return { ok: false, kind: 'INVALID', reason: 'FEED 需要 itemId(整数,内容表里的食物)' };
    }
    if (!ITEM_ID_SET.has(itemId)) {
      return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
    }
    const mobId = strField(p.mobId);
    if (slot === null) {
      /* 首次投喂即「登记」:没有物种就无从判断它是否可驯服 ⇒ 显式要求。 */
      if (mobId === null) {
        return {
          ok: false, kind: 'INVALID',
          reason: `宠物 ${petId} 还没有记录 ⇒ 首次投喂必须带 mobId`,
        };
      }
      if (!TAMEABLE_MOB_IDS.has(mobSpeciesId(mobId))) {
        return {
          ok: false, kind: 'INVALID',
          reason: `${mobId} 不是可驯服的生物(内容层 tameableMobs 名单里没有)`,
        };
      }
    } else {
      if (mobId !== null && mobSpeciesId(mobId) !== slot.record.mobId) {
        return {
          ok: false, kind: 'INVALID',
          reason: `宠物 ${petId} 的物种已是 ${slot.record.mobId} ⇒ 不能按 ${mobId} 投喂`,
        };
      }
      if (slot.ownerId !== null && slot.ownerId !== ctx.actorId) {
        return {
          ok: false, kind: 'INVALID',
          reason: `宠物 ${petId} 已是 ${slot.ownerId} 的 ⇒ 别人不能投喂`,
        };
      }
    }
    /* ★ 驯养前置(负对照):`createPetRecord` 是**唯一**判定 ——
       行为类别不是 TAMEABLE / MOUNT / PASSIVE_UNKILLABLE 的物种返回 null ⇒ 这里拒绝,
       且**不**留下任何记录(FEED 是「首次登记」的唯一入口)。 */
    const base: PetRecord | null = slot === null
      ? createPetRecord(mobSpeciesId(mobId as string), 0)
      : slot.record;
    if (base === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: `${mobId} 不可驯养(createPetRecord 拒绝:行为类别不是 TAMEABLE/MOUNT/PASSIVE_UNKILLABLE)`,
      };
    }
    /* ★ 喂食在**副本**上试算:任何一条不过 ⇒ 容器里一字未改(半步事务的地基)。
     * 本模块的三种结论各有出处:
     *   ok(该物种自己的食物)⇒ stage/fedCount 前进(驯化口径)
     *   wrong_item          ⇒ **接受**这一口(亲密度 +1),但不推进驯化
     *   already_tamed       ⇒ 同样接受(只补 lastProduceAt)
     */
    const next: PetRecord = { ...base };
    const fed = feedPet(next, itemId);
    if (!fed.ok && fed.reason !== 'wrong_item' && fed.reason !== 'already_tamed') {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 这一口喂不进去(${fed.reason})`,
      };
    }
    /* ★ 按件权威读口:能投喂的只有**背包里真的有的那一件**。缺读口时退回下面的
       总量守恒路径(生产路径的 `ctx` 一定带读口;这条 fallback 只可能被手搓桩走到)。 */
    const owned = ownedItemCount(ctx, itemId);
    if (owned !== null && owned < 1) {
      return {
        ok: false, kind: 'INVALID',
        reason: `背包里没有可投喂的 ${itemId}(服务端账面 ${owned} 件)⇒ 好感未变`,
      };
    }
    /* 唯一的失败写入点。**先扣、再提交容器**:扣失败 ⇒ 容器原封不动。 */
    const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] });
    if (!spend.allowed) {
      return {
        ok: false, kind: 'INVALID',
        reason: `背包里没有可投喂的 ${itemId}(${spend.rejectCode ?? '被拒'})⇒ 好感未变`,
      };
    }
    const placed: PetSlot = slot ?? { petId, ownerId: null, bond: 0, record: base };
    placed.record = next;
    placed.bond += 1;
    /* 首次投喂才真的落盘(`putPetSlot` 是容器的唯一写口;旧格会被摘掉)。 */
    putPetSlot(roomId, placed);
    return {
      ok: true, kind: 'OK',
      effect: {
        op, petId, mobId: placed.record.mobId, itemId,
        affection: placed.bond,
        feeds: placed.bond,
        required: AFFECTION_REQUIRED,
        tamed: placed.ownerId !== null,
        /* 这一口有没有推进**驯化**(与亲密度是两件事,见文件头「两个计数器」)。 */
        stage: placed.record.stage,
        fedCount: placed.record.fedCount,
        requiredFeeds: placed.record.requiredFeeds,
      },
    };
  }

  /* ── 3b 驯服:亲密度达标 + 无主 ⇒ 记下这唯一的主人 ── */
  if (op === TameOp.TAME) {
    if (slot === null) {
      return { ok: false, kind: 'INVALID', reason: `宠物 ${petId} 没有记录 ⇒ 先投喂(FEED)` };
    }
    if (slot.ownerId !== null) {
      /* ★「同一只宠物只能有一个主人」:第二次驯服**明确拒绝**,不静默改成新主人。 */
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 已是 ${slot.ownerId} 的 ⇒ 一只宠物只能有一个主人`,
      };
    }
    if (slot.bond < AFFECTION_REQUIRED) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 好感 ${slot.bond}/${AFFECTION_REQUIRED} 未达标 ⇒ 不能驯服`,
      };
    }
    slot.ownerId = ctx.actorId;
    /* 换主人 = 搬格(唯一写口):槽里同时改 ownerId 与键,靠 `putPetSlot` 保证一致。 */
    putPetSlot(roomId, slot);
    /* 认主那一刻宠物开始跟随 —— 三指令的第一条。未驯化(只有亲密度没吃到物种
       食物)的宠物 `stage` 仍是 WILD ⇒ `commandPet` 返回 false,如实回执。 */
    const following = commandPet(slot.record, TameCommand.FOLLOW);
    return {
      ok: true, kind: 'OK',
      effect: {
        op, petId, mobId: slot.record.mobId, ownerId: ctx.actorId,
        affection: slot.bond,
        command: slot.record.command,
        following,
      },
    };
  }

  /* ── 3c 繁殖:两只都归自己且都达标 ⇒ 登记一条记录(不造物、不造生物) ── */
  const mateId = strField(p.mateId);
  if (mateId === null) {
    return { ok: false, kind: 'INVALID', reason: 'BREED 需要 mateId(另一只宠物的 id)' };
  }
  if (mateId === petId) {
    return { ok: false, kind: 'INVALID', reason: `同一只宠物(${petId})不能与自己繁殖` };
  }
  if (slot === null) {
    return { ok: false, kind: 'INVALID', reason: `宠物 ${petId} 没有记录` };
  }
  const mate = petSlotOf(roomId, mateId);
  if (mate === null) {
    return { ok: false, kind: 'INVALID', reason: `宠物 ${mateId} 没有记录` };
  }
  for (const x of [slot, mate]) {
    if (x.ownerId !== ctx.actorId) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${x.petId} 的主人不是 ${ctx.actorId}(实为 ${x.ownerId ?? '无主'})⇒ 不能代它繁殖`,
      };
    }
    if (x.bond < AFFECTION_REQUIRED) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${x.petId} 好感 ${x.bond}/${AFFECTION_REQUIRED} 未达标`,
      };
    }
  }
  breedSeq += 1;
  const record: BreedRecord = {
    recordId: `breed:${roomId}:${petId}+${mateId}:${breedSeq}`,
    roomId,
    ownerId: ctx.actorId,
    petId,
    mateId,
    parentsMobIds: [slot.record.mobId, mate.record.mobId],
    seq: breedSeq,
  };
  const log = roomBreedsOf(roomId);
  log.push(record);
  if (log.length > MAX_BREED_RECORDS) log.splice(0, log.length - MAX_BREED_RECORDS);
  return {
    ok: true, kind: 'OK',
    effect: {
      op, recordId: record.recordId, petId, mateId,
      mobId: slot.record.mobId, mateMobId: mate.record.mobId,
      breedRecords: log.length,
      /* 回执里**显式**说清这次成功没产出东西,免得读回执的人以为漏了。 */
      note: '只登记繁殖记录:不产出物品、不生成生物实体(那是别处的权威)',
    },
  };
};