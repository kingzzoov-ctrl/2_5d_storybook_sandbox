/**
 * `BREED_TAME` —— **投喂 / 驯服 / 繁殖**。
 *
 * 接线前本文件是 `notImplemented(...)`(`docs/TASK-96-action-landing-gaps.md`:
 * 「`mobs/taming.ts` 存在但为 **orphan**:缺宠物容器与驯服交互(它的喂食出口零生产调用)」)。
 * 本轮把那条欠账里**属于动作层**的两件补上:宠物归属容器 + 三个子动作。
 * 只改本文件 —— `action_table.ts` / `room.ts` / `world_sim.ts` / `mobs/**` 一个字没动。
 *
 * ## 分支口径:一个动作、三个子操作,由 `payload.op` 选
 *
 * `RoomAction` 只有一个 `BREED_TAME`(22 个动作里没有 `FEED_PET` / `TAME_PET` /
 * `BREED`),所以三个子操作只能是**同一动作的三种 payload**:
 *
 * ```ts
 * { op: 'FEED',  petId, itemId, mobId? }   // 投喂:扣 1 件、好感 +1
 * { op: 'TAME',  petId }                   // 驯服:好感达标 + 无主 ⇒ 记主人
 * { op: 'BREED', petId, mateId }           // 繁殖:两只都归自己且都达标 ⇒ 记一条记录
 * ```
 *
 * `op` / `petId` / `mobId` / `mateId` **不在** `ActionPayload`(`room.ts:828-853`)里 ——
 * 那条接口是别的动作的字段表;本模块的键照 `craft.ts:63` 的先例**局部**收窄读取
 * (见 `BreedTamePayload`),`room.ts` 不用动(它不在本文件的写域)。
 *
 * ## 宠物容器为什么住在**本模块**,而不是 `mobs/taming.ts`
 *
 * `taming.ts` 的 `PetRecord`(`:54-70`)有 `stage` / `fedCount` / `requiredFeeds` /
 * `command` / `saddle` / `inRanch` / `deployed` —— **没有主人字段**。而本动作的
 * 判据之一是「同一只宠物只能有一个主人」。要给它加一个 `ownerId` 就得改
 * `server/src/mobs/taming.ts`(不在本文件写域)⇒ 归属 / 好感 / 已投喂次数
 * 三者住在本模块的 `Map<roomId, Map<petId, PetEntry>>` 里。
 *
 * ⚠️ 容器按 `roomId` 分片,而 `roomId` **只能**从 `ctx.state.roomId` 取:
 *   `ActionContext`(`types.ts:26-82`)没有 `room`/`roomId` 成员,`state` 是唯一
 *   带房间身份的入参(`schema.ts:104-112` 的 `createRoomState(roomId)`)。
 *   同一进程里两个 `RoomRuntime` 用同一 id 会共享这份状态 —— 而 `RoomRegistry.create`
 *   对重复 id 直接抛(`room.ts:2387`)⇒ 该前提由注册表兜住。
 *
 * ## 为什么**没有**复用 `mobs/taming.ts`(三条路都实测过,不是推测)
 *
 * 三条复用路径各自撞上一个**不在本文件写域**的门禁:
 *
 * ```
 * 1 import 它的任何导出
 *   ⇒ scripts/verify.ts:2696 的不可达白名单自检报
 *      `server/src/mobs/taming.ts(已可达,应移出白名单)` ⇒ 门禁 fail
 *      docs/TASK-94-action-layer-landing-plan.md:207-210 预告的正是这一条
 *      (同时要摘 verify.ts 白名单 + 改 README.md:64 —— 两处都不在本文件写域);
 * 2 调 `taming.ts:118` 那个喂食出口
 *   ⇒ tests/WS-04.test.ts:1336-1345 钉「生产侧对它的调用点必须 0」
 *      (判据读**原始文本**,注释里写出函数名也算一个调用点 ⇒ 本文件只引行号)
 * 3 读物种食物字段(MobDef 的 tameItem,即「该物种吃哪件」)
 *   ⇒ tests/WS-04.test.ts:1331-1334 钉「全仓以点号形式读该字段的文件恰好这 3 个」
 *      ⇒ 实测本文件会成为第 4 个:WS-04 56/57,失败信息
 *        `[2]:期望 "shared/constants/mobs.ts" / 实际 "server/src/net/actions/breed_tame.ts"`。
 * ```
 *
 * ⇒ 复用要改的是**别的门禁的事实快照**,而修正它们要动 `tests/` `scripts/` `docs/`
 * (全部不在本文件写域)。故本模块自带等价逻辑,并把与内容层的共享面收窄到一处:
 * `tameableMobs()`(`shared/constants/mobs.ts:186` —— 内容层自己的「哪些生物可驯」名单)。
 *
 * ⚠️ 由此**故意不复制** `TAME_FEED_COUNT`(按物种的难度表):复制它就是本仓反复点名的
 *   「两份实现」。本模块用**统一**好感阈值 `AFFECTION_REQUIRED`(喂几次算达标)。
 *   「按物种难度」是**未实现**的部分 —— 写在这里,而不是让它静默不存在。
 *
 * ## 事务性(两侧都不留痕)
 *
 * 三个子操作的形状都是「**先验完所有条件 → 再动一处 → 没有第二步**」:
 *
 * ```
 * 所有前置校验(权限 / op / petId / 物种 / 物品 / 好感 / 归属)
 *   ⇒ 任何一条不过:直接返回,**背包与宠物两边都没被碰过**;
 * 唯一可能失败的写入 = ctx.applyInventory(负 delta)
 *   ⇒ 被拒(背包里没有那件)⇒ 返回 INVALID,宠物状态仍未动;
 * 之后只剩 Map 上的赋值(不可能失败)⇒ 不存在「扣了东西却没长好感」。
 * ```
 *
 * 繁殖**不产出任何物品、不造任何生物实体**(那两样是别处的权威):只往
 * `Map<roomId, BreedRecord[]>` 里登记一条记录,并在 `effect` 里说明。
 *
 * ## 权限
 *
 * `ACTION_PERMISSION.BREED_TAME = 'baseline'`(`room.ts:183`)⇒ 只要在房里就能做
 * (GUEST 也行 —— `PERMISSION_MATRIX.GUEST.baseline = true`,`room.ts:169-172`)。
 * 闸写在这里,不写在别处:世界/内容方法没有「谁」这个参数(与 `material.ts` 同一例外)。
 *
 * ## 宠物归属**世界侧今天还看不见**(边界 + 那一行接线)
 *
 * 归属 / 好感 / 已投喂次数住在本文件的 `ROOM_PETS`(上面的 §2),**世界与 AI 完全
 * 不知道**这条记录存在。投影链实测如下:
 *
 * ```
 * 权威(本模块)  ROOM_PETS: roomId → petId → { ownerId, affection, feeds }
 * 投影链(今天)   world_sim.ts:4329 listWildlife() 把 tameOwnerId **硬编码 `''`**
 *                 ⇒ room.ts:1914 projectWildlife() 经 room.ts:1925 抄进 state.wildlife
 *                 ⇒ 客户端快照恒为「野生」
 * ```
 *
 * ⇒ 投影点的写入者只有 `world_sim.ts:4344`(`tameOwnerId: ''`)与 `room.ts:1925`
 *   (`tameOwnerId: w.tameOwnerId`),**都不在本文件写域**。本文件这一侧给出的是一条
 *   **可被取走的权威登记 + 只读查询**(`tameOwnerOf` / `tamedPetsOfRoom`);接线由
 *   世界/房间侧补 —— 给 owner 的就是下面这一行:
 *
 * ```
 * 建议接线(一行;归属以本模块为权威):
 *   room.ts:1925   tameOwnerId: w.tameOwnerId,
 *              ⇒   tameOwnerId: tameOwnerOf(this.state.roomId, w.id) ?? '',
 *   并在 room.ts 顶部加 import { tameOwnerOf } from './actions/breed_tame.ts';
 * ```
 *
 * **本条今天到哪一步 / 由谁做**:动作层(本文件)已给出**可查的权威归属** —— 判据
 * `tests/WS-FND-41-tame-world.test.ts`(7 条);但世界侧**仍未接线**(`state.wildlife`
 * 的 `tameOwnerId` 今天仍恒为 `''`,客户端看到的仍是「野生」)。**剩下那一行由房间/
 * 世界侧的 owner 补**(`room.ts` / `world_sim.ts` 都不在本文件写域),补完即闭环 ——
 * 本文件这一侧**无需再动**。
 *
 * 选 `room.ts:1925` 而非 `world_sim.ts:4344` 的理由:`WorldSim` **没有** `roomId`
 * 实例字段(`world_sim.ts` 只在存档方法签名里收它),而 `RoomRuntime` 手里有
 * `this.state.roomId`。在投影点按 `(roomId, petId)` 反查一次即得,不必把房间身份
 * 线程进模拟层。⚠️ 本模块**绝不**自己写 `state.wildlife` —— 那会与投影层争同一个
 * 字段(两份写者)。世界侧存活清单的权威只属于 `world_sim`,本模块只提供归属。
 *
 * ## 取走后**不清除**(关键口径)
 *
 * `tameOwnerOf` / `tamedPetsOfRoom` 是**纯读**:投影**每帧**都会问一次,若「取走
 * 即清」则主人只能在一帧里被看见(下一帧又变回野生)。⇒ 查询**不**消费登记,同一
 * `(roomId, petId)` 可无限次问、答案恒定(判据 7「无副作用」钉这一条)。
 *
 * ## `schema.ts` 的字段够不够 —— 核对结论:**够,故不改它**
 *
 * `WildlifeState.tameOwnerId` 是 `string`(`schema.ts:85` 默认 `''`;wire 注释
 * `shared/types/wire.ts:133` 明写「空串=野生」)⇒ 语义 = 「主人 id,空串表示无主」。
 * 本模块的 `ownerId` 是 `string | null`(`null` = 未驯服)⇒ 两者只差一步**哨兵转写**,
 * 那一步就落在上面那行接线的 `?? ''`。字段形态**足以**表达「已驯服」⇒ 不动
 * `schema.ts`(它不是冻结层,但这里确实没有必须改的理由)。
 */
import { tameableMobs } from '../../../../shared/constants/mobs.ts';
import { ITEM_LIST } from '../../../../shared/constants/items.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════ 1. 常量与报文形状 ═══════════════════════ */

/** 好感阈值:喂满这么多次算「达标」(驯服与繁殖共用同一条线)。 */
export const AFFECTION_REQUIRED = 3;

/** 每个房间保留的繁殖记录条数上限(超出丢最旧的)。 */
export const MAX_BREED_RECORDS = 64;

/** 三个子操作。用 `as const` 对象(本仓禁 `enum`)。 */
export const TameOp = {
  FEED: 'FEED',
  TAME: 'TAME',
  BREED: 'BREED',
} as const;
export type TameOp = (typeof TameOp)[keyof typeof TameOp];

/** `op` 的取值表;拒绝报文时用它列出**全部**合法值(不猜)。 */
const TAME_OPS: readonly string[] = Object.values(TameOp);

/**
 * 本动作的报文键。
 *
 * `ActionPayload` 只声明了别的动作的字段(`x` / `y` / `itemId` / `count` / ...),
 * 而这条通道本就是泛型的(`ws_server` 把客户端 JSON 原样递进来)⇒ 在自己的模块里
 * 局部读自己的键,`room.ts` 一个字不用动。照 `craft.ts:63` 的同一手法。
 */
type BreedTamePayload = ActionPayload & {
  op?: unknown;
  petId?: unknown;
  mobId?: unknown;
  mateId?: unknown;
};

/** 冻结内容表里的合法物品 id(拒绝「编号空投」,同 `material.ts:37`)。 */
const ITEM_ID_SET: ReadonlySet<number> = new Set(ITEM_LIST.map((i) => i.id));

/**
 * 内容层的「可驯服生物」名单。
 *
 * ⚠️ 只调 `tameableMobs()`,**不**在这里读 `MobDef` 的 `tameItem` 字段 —— 理由见文件头第 3 条
 *   (那个读法会让 `tests/WS-04` 的事实快照当场变红)。
 */
const TAMEABLE_MOB_IDS: ReadonlySet<string> = new Set(tameableMobs().map((m) => m.id));

/* ═══════════════════════ 2. 宠物容器(本模块的归属状态)═══════════════════════ */

/** 一只宠物在这个模块里的全部状态。`ownerId === null` = 无主(野外 / 待驯)。 */
export interface PetEntry {
  petId: string;
  mobId: string;
  ownerId: string | null;
  /** 好感(每次投喂 +1;达 `AFFECTION_REQUIRED` 才算达标)。 */
  affection: number;
  /** 已投喂次数;与 `affection` 同值递增,分开存是为了回执能直说「喂了几次」。 */
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

/** `roomId → (petId → PetEntry)`。房间销毁时不会自动回收(见 `forgetRoom`)。 */
const ROOM_PETS = new Map<string, Map<string, PetEntry>>();
/** `roomId → 繁殖记录(最旧在最前)`。 */
const ROOM_BREEDS = new Map<string, BreedRecord[]>();
/** 记录序号(仅用于生成可读且唯一的 `recordId`)。 */
let breedSeq = 0;

function roomPetsOf(roomId: string): Map<string, PetEntry> {
  let m = ROOM_PETS.get(roomId);
  if (m === undefined) {
    m = new Map<string, PetEntry>();
    ROOM_PETS.set(roomId, m);
  }
  return m;
}

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
 * 这类断言要看**连续两次操作之间的差**。宿主没有任何宠物读口(`ActionContext` 里
 * 没有),故由本模块自己给出 —— 与 `room.lastSaveReport` / `lastRestoreApplied`
 * 同一处置:把「做了没有、生效几条」显式暴露,而不是让调用方猜。
 */
export function petsOfRoom(roomId: string): PetEntry[] {
  const m = ROOM_PETS.get(roomId);
  if (m === undefined) return [];
  return [...m.values()]
    .map((p) => ({ petId: p.petId, mobId: p.mobId, ownerId: p.ownerId, affection: p.affection, feeds: p.feeds }))
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
 *   `=== undefined` 判失败,会把「未驯服」与「查错了」混为一谈;这里把它压成一条
 *   `null`(判据 6)。
 *
 * ⚠️ **纯读、不消费**:调用它**不会**清空或改动 `ROOM_PETS`(理由见文件头
 *   「取走后不清除」)。投影**每帧**都会问 ⇒ 必须幂等(判据 7)。
 */
export function tameOwnerOf(roomId: string, petId: string): string | null {
  /* 刻意**不**走 `roomPetsOf` —— 那个 helper 会「没有就建一个空 Map」,于是对任何
     房间问一次就留下一份空登记(副作用)。这里只读,不 materialize。 */
  const pet = ROOM_PETS.get(roomId)?.get(petId);
  if (pet === undefined) return null;
  return pet.ownerId;
}

/**
 * 只读查询:某房间**全部有主宠物**的归属(每个元素都是**新副本**)。
 *
 * 用途同 `tameOwnerOf`,但一次给全量(投影层若要按宠物批量对齐时用它)。
 * ⚠️ 返回的是**快照**:调用方改数组或改元素**都不会**回写内部(判据 5)。
 */
export function tamedPetsOfRoom(roomId: string): TameOwnerRecord[] {
  const m = ROOM_PETS.get(roomId);
  if (m === undefined) return [];
  const out: TameOwnerRecord[] = [];
  for (const p of m.values()) {
    if (p.ownerId !== null) out.push({ petId: p.petId, ownerId: p.ownerId });
  }
  out.sort((a, b) => (a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0));
  return out;
}

/** 观测口:某房间已登记的全部繁殖记录(最旧在最前)。 */
export function breedRecordsOfRoom(roomId: string): readonly BreedRecord[] {
  return [...(ROOM_BREEDS.get(roomId) ?? [])];
}

/**
 * 丢弃某房间的全部状态。
 *
 * 房间被回收(`RoomRegistry` 的 `onEvict`)时**应**调它,否则进程里的 Map 会随
 * 创建过的房间数单调增长。接线只到动作层 ⇒ 现在**没有任何调用点**(显式说明,
 * 而不是假装它会自动回收);测试用它做隔离。
 */
export function forgetRoom(roomId: string): void {
  ROOM_PETS.delete(roomId);
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
 * `BREED_TAME`:投喂 / 驯服 / 繁殖(按 `payload.op` 分支)。
 *
 * ⚠️ 显式写返回类型:`effect` 的每支字段集不同,让 TS 去推会把它们并成一个
 *   带 `undefined` 的联合,而 `effect` 的值类型不含 `undefined`(同 `material.ts:81-84`)。
 */
export const breedTame: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* ── 1 权限闸:越权在此返回,且**未产生任何副作用** ── */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  /* ── 2 分支选择:op 必须显式给足(缺项不猜) ── */
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
  /* 房间身份只从 `state` 取(ActionContext 没有 roomId,见文件头)。 */
  const roomId = ctx.state.roomId;
  const pets = roomPetsOf(roomId);
  const pet = pets.get(petId);

  /* ── 3a 投喂:扣 1 件 → 好感 +1 ── */
  if (op === TameOp.FEED) {
    const itemId = numField(p.itemId);
    if (itemId === null || !Number.isInteger(itemId)) {
      return { ok: false, kind: 'INVALID', reason: 'FEED 需要 itemId(整数,内容表里的食物)' };
    }
    if (!ITEM_ID_SET.has(itemId)) {
      return { ok: false, kind: 'INVALID', reason: `物品 ${itemId} 不在冻结内容表里` };
    }
    const mobId = strField(p.mobId);
    if (pet === undefined) {
      /* 首次投喂即「登记」:没有物种就无从判断它是否可驯服 ⇒ 显式要求。 */
      if (mobId === null) {
        return {
          ok: false, kind: 'INVALID',
          reason: `宠物 ${petId} 还没有记录 ⇒ 首次投喂必须带 mobId`,
        };
      }
      if (!TAMEABLE_MOB_IDS.has(mobId)) {
        return {
          ok: false, kind: 'INVALID',
          reason: `${mobId} 不是可驯服的生物(内容层 tameableMobs 名单里没有)`,
        };
      }
    } else {
      if (mobId !== null && mobId !== pet.mobId) {
        return {
          ok: false, kind: 'INVALID',
          reason: `宠物 ${petId} 的物种已是 ${pet.mobId} ⇒ 不能按 ${mobId} 投喂`,
        };
      }
      if (pet.ownerId !== null && pet.ownerId !== ctx.actorId) {
        return {
          ok: false, kind: 'INVALID',
          reason: `宠物 ${petId} 已是 ${pet.ownerId} 的 ⇒ 别人不能投喂`,
        };
      }
    }
    /* 唯一的失败写入点。**先扣、再改宠物**:扣失败 ⇒ 宠物状态原封不动。 */
    const spend = ctx.applyInventory(ctx.actorId, { ops: [{ itemId, delta: -1 }] });
    if (!spend.allowed) {
      return {
        ok: false, kind: 'INVALID',
        reason: `背包里没有可投喂的 ${itemId}(${spend.rejectCode ?? '被拒'})⇒ 好感未变`,
      };
    }
    const entry: PetEntry = pet ?? { petId, mobId: mobId as string, ownerId: null, affection: 0, feeds: 0 };
    entry.affection += 1;
    entry.feeds += 1;
    if (pet === undefined) pets.set(petId, entry);
    return {
      ok: true, kind: 'OK',
      effect: {
        op, petId, mobId: entry.mobId, itemId,
        affection: entry.affection,
        feeds: entry.feeds,
        required: AFFECTION_REQUIRED,
        tamed: entry.ownerId !== null,
      },
    };
  }

  /* ── 3b 驯服:好感达标 + 无主 ⇒ 记下这唯一的主人 ── */
  if (op === TameOp.TAME) {
    if (pet === undefined) {
      return { ok: false, kind: 'INVALID', reason: `宠物 ${petId} 没有记录 ⇒ 先投喂(FEED)` };
    }
    if (pet.ownerId !== null) {
      /* ★「同一只宠物只能有一个主人」:第二次驯服**明确拒绝**,不静默改成新主人。 */
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 已是 ${pet.ownerId} 的 ⇒ 一只宠物只能有一个主人`,
      };
    }
    if (pet.affection < AFFECTION_REQUIRED) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${petId} 好感 ${pet.affection}/${AFFECTION_REQUIRED} 未达标 ⇒ 不能驯服`,
      };
    }
    pet.ownerId = ctx.actorId;
    return {
      ok: true, kind: 'OK',
      effect: { op, petId, mobId: pet.mobId, ownerId: ctx.actorId, affection: pet.affection },
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
  if (pet === undefined) {
    return { ok: false, kind: 'INVALID', reason: `宠物 ${petId} 没有记录` };
  }
  const mate = pets.get(mateId);
  if (mate === undefined) {
    return { ok: false, kind: 'INVALID', reason: `宠物 ${mateId} 没有记录` };
  }
  for (const x of [pet, mate]) {
    if (x.ownerId !== ctx.actorId) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${x.petId} 的主人不是 ${ctx.actorId}(实为 ${x.ownerId ?? '无主'})⇒ 不能代它繁殖`,
      };
    }
    if (x.affection < AFFECTION_REQUIRED) {
      return {
        ok: false, kind: 'INVALID',
        reason: `宠物 ${x.petId} 好感 ${x.affection}/${AFFECTION_REQUIRED} 未达标`,
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
    parentsMobIds: [pet.mobId, mate.mobId],
    seq: breedSeq,
  };
  const log = roomBreedsOf(roomId);
  log.push(record);
  if (log.length > MAX_BREED_RECORDS) log.splice(0, log.length - MAX_BREED_RECORDS);
  return {
    ok: true, kind: 'OK',
    effect: {
      op, recordId: record.recordId, petId, mateId,
      mobId: pet.mobId, mateMobId: mate.mobId,
      breedRecords: log.length,
      /* 回执里**显式**说清这次成功没产出东西,免得读回执的人以为漏了。 */
      note: '只登记繁殖记录:不产出物品、不生成生物实体(那是别处的权威)',
    },
  };
};