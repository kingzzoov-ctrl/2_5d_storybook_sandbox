/**
 * WS-04:驯养 / 牧场 / 宠物出战系统。
 *
 * 流程:喂食(达标次数)→ 驯化 → 三指令(跟随 / 留守 / 背物资)→ 牧场产出 → 出战上限。
 *
 * 出战上限:默认 1 只;装备 `628 繁花鹿角园艺冠` 后解锁第 2 只。
 * ## 接线状态(2026-11-19 定案「接上」,本模块不再是 orphan)
 *
 * 生产唯一入口 = `server/src/net/actions/breed_tame.ts` 的 `BREED_TAME`。宠物容器
 * (**唯一事实源**)住本文件第 6 节,按玩家存(`roomId → ownerId → petId`);动作层
 * 不再自带第二份容器,各子操作各自调本模块:
 *
 * ```
 * FEED   createPetRecord(首次登记)+ feedPet(该物种自己的食物才推进驯化)
 * TAME   认主后 commandPet(FOLLOW)
 * RANCH  sendToRanch(在圈标记 = 权威)+ systems/intake.ts 的名单判定(投影)
 * ```
 *
 * ⚠️ 仍**没有**协议入口的导出:`deployPet` / `undeployPet` / `commandIntent` /
 *   `carrySpeedMul` / `tickRanch`。理由是客户端的 op 表被 `tests/WS-FND-138`
 *   逐字钉死为四个(FEED / TAME / BREED / RANCH)—— 加第五个要同时改客户端与判据,
 *   那是**协议变更**,不是接线。它们留在本文件是因为各自的判据(`tests/WS-FND-125`)
 *   在钉模块内语义;这里如实写「没入口」,而不是继续写「等宠物容器」。
 */

import { MOB_LIST } from '../../../shared/constants/mobs.ts';
/* ★ 生物 id 的**两层**只有一处规则:`mobs/spawner.ts` 的 `mobDefOf` / `mobSpeciesId`。
   这 5 处原先各自 `MOB_BY_ID.get(id)`,都隐含"id 就是物种 id" —— 实例 id 带 `#n` 之后
   每一处漏改都是**静默**的(驯养返回 unknown_mob、农场不产出,都不抛错)。 */
import { mobDefOf, mobSpeciesId } from './spawner.ts';
import type { MobDef } from '../../../shared/types/entities.ts';
import { MobBehavior } from '../../../shared/types/entities.ts';

/* ─────────────── 参数配表 ─────────────── */

/** 每只生物驯化所需喂食次数(按 `tameItem` 区分难度)。 */
export const TAME_FEED_COUNT: Record<string, number> = {
  mob_sheep: 1,
  mob_squirrel: 1,
  mob_glow_frog: 1,
  mob_capybara: 1,
  mob_chocobo: 3,   /* 陆行鸟:先蜂蜜罐粘脚,再喂 3 个黄金小麦 */
  mob_pangolin: 1,
  mob_sky_manta: 0, /* 直接跳背搭车,无需驯化 */
};

export const DEFAULT_TAME_FEED_COUNT = 1;

/** 出战上限与解锁头饰。 */
export const DEPLOY_LIMIT_BASE = 1;
export const DEPLOY_LIMIT_WITH_BADGE = 2;
export const DEPLOY_BADGE_ID = 628;

/** 牧场自动产出周期(秒):1 游戏日 = 86400s 的简化,这里按 1 天产出一次。 */
export const RANCH_PRODUCE_SEC = 600;
/** 牧场容量(圈养上限)。 */
export const RANCH_CAPACITY = 24;

export const TameCommand = {
  FOLLOW: 'FOLLOW',
  STAY: 'STAY',
  CARRY: 'CARRY',
} as const;
export type TameCommand = (typeof TameCommand)[keyof typeof TameCommand];

export const TAME_COMMANDS: readonly TameCommand[] = ['FOLLOW', 'STAY', 'CARRY'];

export const TameStage = {
  WILD: 'WILD',
  FED: 'FED',
  TAMED: 'TAMED',
} as const;
export type TameStage = (typeof TameStage)[keyof typeof TameStage];

export interface PetRecord {
  mobId: string;
  name: string;
  stage: TameStage;
  fedCount: number;
  requiredFeeds: number;
  command: TameCommand;
  /** 已装备鞍具(743 云朵陆行鸟骑乘鞍)后可骑乘。 */
  saddle: boolean;
  /** 牧场圈养中。 */
  inRanch: boolean;
  /** 背物资负载(格)。 */
  carryLoad: number;
  /** 已出战中。 */
  deployed: boolean;
  lastProduceAt: number;
}

export interface TameResult {
  ok: boolean;
  stage: TameStage;
  reason: string;
  spawned?: { itemId: number; count: number };
}

/** 可驯养生物清单(温顺/坐骑)。 */
export function tameableDefs(): MobDef[] {
  return MOB_LIST.filter((m) => m.tameItem !== undefined);
}

/** 生物是否为可驯养类别。 */
export function canTame(mobId: string): boolean {
  const def = mobDefOf(mobId);
  if (!def) return false;
  return def.behavior === MobBehavior.TAMEABLE || def.behavior === MobBehavior.MOUNT
    || def.behavior === MobBehavior.PASSIVE_UNKILLABLE;
}

export function createPetRecord(mobId: string, now = 0): PetRecord | null {
  /* 记录里存**物种 id**:`PetRecord.mobId` 下游全按物种用(喂养需求 / 产出 / 负载),
     存实例 id 会让同物种的第二只宠物自成一档。 */
  const species = mobSpeciesId(mobId);
  const def = mobDefOf(mobId);
  if (!def || !canTame(mobId)) return null;
  return {
    mobId: species,
    name: def.name,
    stage: TameStage.WILD,
    fedCount: 0,
    requiredFeeds: TAME_FEED_COUNT[species] ?? DEFAULT_TAME_FEED_COUNT,
    command: TameCommand.STAY,
    saddle: false,
    inRanch: false,
    carryLoad: 0,
    deployed: false,
    lastProduceAt: now,
  };
}

/**
 * 喂食一步。
 *
 * 关键边界:
 *  - 物品不匹配 → `ok=false, reason='wrong_item'`,计数不增长;
 *  - 达到所需次数 → `stage='TAMED'` 并回赠该生物的特色产出(`drops` 第一项);
 *  - 已驯化再次喂食 → 仅补充 `lastProduceAt`,不重复发奖。
 */
export function feedPet(pet: PetRecord, itemId: number): TameResult {
  const def = mobDefOf(pet.mobId);
  if (!def) return { ok: false, stage: pet.stage, reason: 'unknown_mob' };
  if (pet.stage === TameStage.TAMED) {
    return { ok: false, stage: pet.stage, reason: 'already_tamed' };
  }
  if (def.tameItem === undefined) {
    return { ok: false, stage: pet.stage, reason: 'not_tameable' };
  }
  if (itemId !== def.tameItem) {
    return { ok: false, stage: pet.stage, reason: 'wrong_item' };
  }
  pet.fedCount += 1;
  pet.stage = TameStage.FED;
  if (pet.fedCount >= pet.requiredFeeds) {
    pet.stage = TameStage.TAMED;
    const dropId = Number(Object.keys(def.drops)[0]);
    return {
      ok: true,
      stage: pet.stage,
      reason: 'tamed',
      spawned: { itemId: dropId, count: 1 },
    };
  }
  return { ok: true, stage: pet.stage, reason: 'fed' };
}

/** 下达指令;未驯化生物拒不服从。 */
export function commandPet(pet: PetRecord, cmd: TameCommand): boolean {
  if (pet.stage !== TameStage.TAMED) return false;
  pet.command = cmd;
  /*
   * ★ 第七轮 P1:`carryLoad` 以前**全仓只写 0** ⇒ `carrySpeedMul` 恒 1,
   *   「背物资减速」是一条永远不成立的分支。现在它有一个真实生产者:
   *   接下 CARRY 的那一步按 `carrySlots` 装货,任何别的指令都卸货。
   *
   * ⇒ 三个事实连着:`commandPet(CARRY)` → `carryLoad > 0` → `carrySpeedMul = 0.9`。
   *
   * ★ 生产调用点(2026-11-19 定案「接上」):`net/actions/breed_tame.ts` 的 `TAME`
   *   子操作在认主成功后下第一条指令 `commandPet(record, FOLLOW)` ⇒ 本函数不再只在
   *   测试里被调用,也不再是 `scripts/verify.ts` 的 `UNREACHABLE_EXEMPT` 成员
   *   (容器已搬进本文件第 6 节,动作层只留投影)。`CARRY` 那一路仍只有判据
   *   (`tests/WS-FND-125` 第 9 组)—— 加「背物资」子操作要动协议(见文件头)。
   */
  pet.carryLoad = cmd === TameCommand.CARRY ? carrySlots(pet.mobId) : 0;
  return true;
}

/**
 * 出战上限。
 *
 * @param wearing 玩家穿戴的物品 ID 列表
 */
export function deployLimit(wearing: readonly number[]): number {
  return wearing.includes(DEPLOY_BADGE_ID) ? DEPLOY_LIMIT_WITH_BADGE : DEPLOY_LIMIT_BASE;
}

export interface DeployResult { ok: boolean; deployed: number; limit: number; reason: string; }

/** 尝试让某只宠物出战(消耗一个出战名额)。 */
export function deployPet(pets: PetRecord[], pet: PetRecord, wearing: readonly number[]): DeployResult {
  const limit = deployLimit(wearing);
  const deployed = pets.filter((p) => p.deployed).length;
  if (pet.stage !== TameStage.TAMED) {
    return { ok: false, deployed, limit, reason: 'not_tamed' };
  }
  if (pet.inRanch) {
    return { ok: false, deployed, limit, reason: 'in_ranch' };
  }
  if (pet.deployed) {
    return { ok: true, deployed, limit, reason: 'already_deployed' };
  }
  if (deployed >= limit) {
    return { ok: false, deployed, limit, reason: 'limit_reached' };
  }
  pet.deployed = true;
  pet.command = TameCommand.FOLLOW;
  return { ok: true, deployed: deployed + 1, limit, reason: 'deployed' };
}

export function undeployPet(pets: PetRecord[], pet: PetRecord): void {
  pet.deployed = false;
  pet.command = TameCommand.STAY;
  /* 卸下指令 ⇒ 卸货(否则 0.9 的减速会跟着这只宠物一辈子)。 */
  pet.carryLoad = 0;
}

/** 送入牧场。 */
export function sendToRanch(pets: PetRecord[], pet: PetRecord): boolean {
  if (pet.stage !== TameStage.TAMED) return false;
  const inRanch = pets.filter((p) => p.inRanch).length;
  if (inRanch >= RANCH_CAPACITY) return false;
  pet.inRanch = true;
  pet.deployed = false;
  pet.command = TameCommand.STAY;
  /* 进圈 = 回 STAY ⇒ 背上的货卸掉(`carrySpeedMul` 的判据随之回到 1)。 */
  pet.carryLoad = 0;
  return true;
}

export interface RanchYield { itemId: number; count: number; }

/**
 * 牧场自动产出结算。
 *
 * 产出规则:每 `RANCH_PRODUCE_SEC` 秒,每只圈养生物按自身掉落表产出 1 份;
 * 结界内若存在 >= 3 只同类,额外产出 1 份(「圈养动物自动进食并每日产出」的群体加成)。
 */
export function tickRanch(pets: PetRecord[], now: number): RanchYield[] {
  const out: RanchYield[] = [];
  const counts = new Map<string, number>();
  for (const p of pets) {
    if (!p.inRanch) continue;
    counts.set(p.mobId, (counts.get(p.mobId) ?? 0) + 1);
  }
  for (const pet of pets) {
    if (!pet.inRanch) continue;
    if (now - pet.lastProduceAt < RANCH_PRODUCE_SEC) continue;
    pet.lastProduceAt = now;
    const def = mobDefOf(pet.mobId);
    if (!def) continue;
    const dropId = Number(Object.keys(def.drops)[0]);
    const bonus = (counts.get(pet.mobId) ?? 0) >= 3 ? 1 : 0;
    out.push({ itemId: dropId, count: 1 + bonus });
  }
  return out;
}

/**
 * 背物资指令的负载计算与减速。
 *
 * 负载 = 4 + floor(生物等级 / 5),上限 12 格(`carrySlots`,内容表 `MobDef.level`)。
 *
 * ## ★ 第七轮 P1:`carryLoad` 曾经**全仓只写 0**
 *
 * 修前:唯一写 `carryLoad` 的地方是 `createPetRecord`(写 0),`carrySpeedMul`
 * 里的 `carryLoad > 0` 因此**永远为假** ⇒ 减速永不生效,而门禁全绿
 * (「恒真/恒假分支」家族)。现在有生产者了:`commandPet(CARRY)` 按
 * `carrySlots` 装货,`commandPet(别的指令)` / `sendToRanch` / `undeployPet` 卸货。
 * 判据 `tests/WS-FND-125` 用「CARRY ⇒ 0.9 / STAY ⇒ 1」双向钉住这对字段。
 *
 * ★ 生产消费方(2026-11-19):容器(`roomId → ownerId → petId`)把 `carryLoad` /
 *   `command` 一起带着走,`sendToRanch` 因此在生产路径上真的会卸货(RANCH 子操作)。
 *   `commandPet(CARRY)` 本身仍没有协议入口 —— 客户端 op 表只有四个(见文件头)。
 */
export const CARRY_BASE_SLOTS = 4;
export const CARRY_MAX_SLOTS = 12;
export const CARRY_SPEED_PENALTY = 0.9;

export function carrySlots(mobId: string): number {
  const def = mobDefOf(mobId);
  if (!def) return 0;
  return Math.min(CARRY_MAX_SLOTS, CARRY_BASE_SLOTS + Math.floor(def.level / 5));
}

/** 背物资时的移速乘子(CARRY 且真的背着货 ⇒ 0.9;否则 1)。 */
export function carrySpeedMul(pet: PetRecord): number {
  return pet.command === TameCommand.CARRY && pet.carryLoad > 0 ? CARRY_SPEED_PENALTY : 1;
}

/** 三指令的每帧期望行为(纯函数,便于断言)。 */
export function commandIntent(pet: PetRecord, owner: { x: number; y: number }, petPos: { x: number; y: number }): {
  targetX: number; targetY: number; move: boolean;
} {
  switch (pet.command) {
    case 'FOLLOW': {
      const d = Math.hypot(owner.x - petPos.x, owner.y - petPos.y);
      return { targetX: owner.x, targetY: owner.y, move: d > 1.5 };
    }
    case 'STAY':
      return { targetX: petPos.x, targetY: petPos.y, move: false };
    case 'CARRY':
      return { targetX: owner.x, targetY: owner.y, move: true };
    default:
      return { targetX: petPos.x, targetY: petPos.y, move: false };
  }
}

/** 自检:配表覆盖度(24 种里可驯养的条目数)。 */
export function tamingCoverage(): { tameable: number; total: number } {
  return { tameable: tameableDefs().length, total: MOB_LIST.length };
}

/* ═══════════════════ 6. 宠物容器(唯一事实源;按玩家存)═══════════════════ */

/**
 * 一条宠物槽:`petId`(客户端手里那一只)+ 归属 + 亲密度 + 驯化记录。
 *
 * ## 「按玩家存」落在哪 —— 外层键就是玩家
 *
 * ```
 *   PET_BOX: roomId → ownerId(无主 = '') → petId → 槽
 *   ⇒ 「某玩家的全部宠物」是一次直接查表(出战名额 / 送进牧场都按玩家算);
 *   ⇒ 「房间里有没有这只 petId」是跨玩家的反查(去重键:同一只宠物不许两条记录);
 *   ⇒ `roomId` 在最外层:同一进程的两个房间不共享宠物(测试因此可以按房间隔离)
 * ```
 *
 * ⚠️ `ownerId` 同时出现在键上和槽里,但**只有键是权威**:换主人(TAME)必须走
 *   `putPetSlot` 搬格。若绕过它直接改槽里的 `ownerId`,同一只宠物会同时留在
 *   「无主」与「p1 的」两格(两次出战名额、两份牧场产出),而任何断言都看不出来。
 *   ⇒ 写口只有 `putPetSlot`,读口三个(单查 / 整房 / 按玩家)。
 *
 * ## 两个计数器,不是两份进度
 *
 * ```
 *   slot.bond        玩家侧口径:每一次**被接受**的投喂 +1(BREED_TAME 的 FEED 累计),
 *                    认主门槛用它(`net/actions/breed_tame.ts` 的 AFFECTION_REQUIRED)
 *   record.fedCount  驯化口径:`feedPet` **只数该物种自己的食物**,`stage` 由它推
 * ```
 *
 * 为什么必须分开:喂**任何**东西都让玩家与它更熟(动作层契约:背包里有那一件就能喂),
 * 但「驯化」在内容层是**该物种吃哪件**(`MobDef.tameItem`)—— 拿黄金小麦喂花栗鼠
 * (它吃 121)只会更熟,不会驯化。两个数合成一个,必然有一边的语义是假的。
 */
export interface PetSlot {
  petId: string;
  ownerId: string | null;
  /** 亲密度(玩家侧口径,见上面「两个计数器」;动作层的 `affection` 就是它)。 */
  bond: number;
  record: PetRecord;
}

/** 无主记录的键(不新造第二个哨兵值:空串即「无主」,与 `tameOwnerId` 的约定同源)。 */
const UNOWNED = '';

/** `roomId → ownerId → petId → 槽`。**唯一事实源。** */
const PET_BOX = new Map<string, Map<string, Map<string, PetSlot>>>();

/** 取/建一个玩家的那一格。⚠️ 只有**写路径**调它 —— 读路径不许 materialize。 */
function playerBox(roomId: string, ownerKey: string): Map<string, PetSlot> {
  let owners = PET_BOX.get(roomId);
  if (owners === undefined) {
    owners = new Map<string, Map<string, PetSlot>>();
    PET_BOX.set(roomId, owners);
  }
  let box = owners.get(ownerKey);
  if (box === undefined) {
    box = new Map<string, PetSlot>();
    owners.set(ownerKey, box);
  }
  return box;
}

/**
 * **唯一的写口**:把槽挂到 `(roomId, slot.petId)` 下,并按 `slot.ownerId` 选格。
 *
 * 换主人时先把 petId 从**别的**格子里摘掉(等于搬格)⇒「同一只宠物两条记录」
 * 在结构上不可能出现,而不是靠每个调用方记得删。
 */
export function putPetSlot(roomId: string, slot: PetSlot): void {
  const owners = PET_BOX.get(roomId);
  const ownerKey = slot.ownerId ?? UNOWNED;
  if (owners !== undefined) {
    for (const [key, box] of owners) {
      if (key === ownerKey) continue;
      if (!box.delete(slot.petId)) continue;
      /* 搬空了就把整格丢掉:否则空 Map 会随「驯服过又搬走的宠物」一直长下去。 */
      if (box.size === 0) owners.delete(key);
    }
  }
  playerBox(roomId, ownerKey).set(slot.petId, slot);
}

/**
 * 只读单查:某房间某只宠物的槽。
 *
 * 没有 ⇒ `null`(**不是** `undefined`),与 `tameOwnerOf` 的返回口径一致;且**不**
 * materialize 空登记(对任何房间问一次都不留痕)。
 */
export function petSlotOf(roomId: string, petId: string): PetSlot | null {
  const owners = PET_BOX.get(roomId);
  if (owners === undefined) return null;
  for (const box of owners.values()) {
    const slot = box.get(petId);
    if (slot !== undefined) return slot;
  }
  return null;
}

/**
 * 某房间的全部宠物槽(**新数组**,元素是活槽 —— 动作层要就地改它;
 * 只读投影请自己拷成 `PetEntry`,别把活引用交给调用方)。
 */
export function petSlotsOfRoom(roomId: string): PetSlot[] {
  const owners = PET_BOX.get(roomId);
  if (owners === undefined) return [];
  const out: PetSlot[] = [];
  for (const box of owners.values()) for (const slot of box.values()) out.push(slot);
  out.sort((a, b) => (a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0));
  return out;
}

/** 按玩家取(外层键就是玩家 ⇒ 一次查表;出战名额与送圈数都按它算)。 */
export function petsOfPlayer(roomId: string, ownerId: string): PetSlot[] {
  const box = PET_BOX.get(roomId)?.get(ownerId);
  if (box === undefined) return [];
  const out = [...box.values()];
  out.sort((a, b) => (a.petId < b.petId ? -1 : a.petId > b.petId ? 1 : 0));
  return out;
}

/**
 * 丢弃某房间的全部宠物。
 *
 * 生产调用点:`net/actions/breed_tame.ts` 的 `forgetRoom`(房间侧账回收,
 * `RESET_WORLD` 走它);测试用它做房间隔离。不调它 ⇒ 进程里的 Map 随建过的
 * 房间数单调增长 —— 这是登记,不是「理论上会回收」。
 */
export function forgetRoomPets(roomId: string): void {
  PET_BOX.delete(roomId);
}