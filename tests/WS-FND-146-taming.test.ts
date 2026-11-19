/**
 * WS-FND-146 —— `mobs/taming.ts` 的**定案判据**(接上,不再是 orphan)。
 *
 * ## 这个套件为什么存在
 *
 * `server/src/mobs/taming.ts` 从第一轮起就**整模块零生产 import**,一直挂在
 * `scripts/verify.ts` 的 `UNREACHABLE_EXEMPT` 与 `scripts/orphan-audit.ts` 的
 * `ORPHAN_KNOWN` 里,注释一律写「等宠物容器」。本轮**二选一定案 = 接上**:
 *
 * ```
 * 权威(唯一)   taming.ts 第 6 节  PET_BOX:roomId → ownerId → petId → { ownerId, bond, record }
 * 生产入口     net/actions/breed_tame.ts 的 BREED_TAME
 *              FEED → createPetRecord + feedPet   TAME → commandPet(FOLLOW)
 *              RANCH → sendToRanch                forgetRoom → forgetRoomPets
 * ```
 *
 * ⇒ 本套件钉三件事:**容器是单一的**、**两处白名单与实测一致**、**三个失败路径各有负对照**
 *   (驯养前置 / 牧场容量 / 出战上限 —— 这三条以前只在「模块内自洽」这个层面上被测过,
 *   没有任何东西保证它们与生产接线后的形状对得上)。
 *
 * ## 两个计数器(本套件最重要的一条语义)
 *
 * ```
 * slot.bond        动作层口径:每一次**被接受**的投喂 +1(不验食谱)⇒ 认主门槛用它
 * record.fedCount  驯化口径:`feedPet` 只数**该物种自己的食物** ⇒ stage 由它推
 * ```
 *
 * 拿黄金小麦(123)喂花栗鼠(它吃 121):**接受**(亲密度 +1)但 `stage` 仍是 `WILD`。
 * 两个数合成一个,必然有一边的语义是假的 ⇒ FND146-4/5 双向钉住。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { RoomAction, type ActionOutcome, type ActionPayload } from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { RoomStatus } from '../server/src/db/repo.ts';
import {
  AFFECTION_REQUIRED, breedTame, forgetRoom, petsOfRoom, tameOwnerOf, TameOp,
} from '../server/src/net/actions/breed_tame.ts';
import {
  DEPLOY_BADGE_ID,
  RANCH_CAPACITY,
  TameCommand,
  TameStage,
  commandPet,
  createPetRecord,
  deployLimit,
  deployPet,
  feedPet,
  forgetRoomPets,
  petSlotOf,
  petsOfPlayer,
  putPetSlot,
  sendToRanch,
  type PetRecord,
  type PetSlot,
} from '../server/src/mobs/taming.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** 黄金小麦(绵羊/陆行鸟的食物)。 */
const WHEAT = 123;
/** 大尾花栗鼠吃的食物(**不是**黄金小麦 —— 用它验「两个计数器」)。 */
const SQUIRREL_FOOD = 121;
const MOB_SHEEP = 'mob_sheep';
const MOB_SQUIRREL = 'mob_squirrel';
/** 不可驯服物种(行为 MISCHIEVOUS、内容层没有 tameItem)。 */
const MOB_NOT_TAMEABLE = 'mob_slime_green';

/* ═════════════ 0. 夹具:最小 ActionContext(同 WS-FND-41)═════════════ */

type Bag = Map<number, number>;

function makeCtx(roomId: string, actorId: string, payload: Record<string, unknown>, bag: Bag): ActionContext {
  return {
    actorId,
    action: RoomAction.BREED_TAME,
    payload: payload as ActionPayload,
    state: createRoomState(roomId),
    host: null,
    status: RoomStatus.OPEN,
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' as const, reason: 'test-stub' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (_userId, input) => {
      for (const op of input.ops) {
        if (op.delta < 0 && (bag.get(op.itemId) ?? 0) + op.delta < 0) {
          return { allowed: false, afterTotal: bag.get(op.itemId) ?? 0, rejectCode: 'ITEM_NEGATIVE' };
        }
      }
      for (const op of input.ops) bag.set(op.itemId, (bag.get(op.itemId) ?? 0) + op.delta);
      let afterTotal = 0;
      for (const n of bag.values()) afterTotal += n;
      return { allowed: true, afterTotal };
    },
    grantItemSource: () => {},
    setMemberRole: () => ({ ok: false }),
    kick: () => ({ ok: false }),
    setAccess: () => ({ ok: false }),
    setPartyModeBy: () => ({ ok: false }),
    close: () => false,
  };
}

const feed = (roomId: string, actor: string, petId: string, mobId: string, itemId: number, bag: Bag): ActionOutcome =>
  breedTame(makeCtx(roomId, actor, { op: TameOp.FEED, petId, mobId, itemId }, bag));
const tame = (roomId: string, actor: string, petId: string, bag: Bag): ActionOutcome =>
  breedTame(makeCtx(roomId, actor, { op: TameOp.TAME, petId }, bag));

/**
 * 解析一张登记表的**表体**(从 `锚点` 到其后第一个 `]);`)。
 *
 * ⚠️ 必须只解析表体,不能在整份文件里 `includes('mobs/taming.ts')` ——
 *   摘除留痕的**注释**里就写着那个路径,那样断言会恒假。
 */
function tableBody(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const end = src.indexOf(']);', start);
  return end < 0 ? '' : src.slice(start, end);
}

/** 表体里是否有**一条以该路径开头**的登记(注释里提到不算)。 */
function hasEntry(body: string, rel: string): boolean {
  return new RegExp(`^\\s*\\[\\s*'${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'm').test(body);
}

/* ═════════════ 1. 容器是单一的(不是「动作层再带一份」)═════════════ */

test('FND146-1 宠物容器只有一份:动作层不再自带 Map,权威在 mobs/taming.ts 第 6 节', () => {
  const breed = read('server/src/net/actions/breed_tame.ts');
  const taming = read('server/src/mobs/taming.ts');

  /* 1 动作层不再有宠物容器(第二份事实源)。 */
  ok(!/ROOM_PETS/.test(breed),
    'bred_tame.ts 不再有 `ROOM_PETS`(第二份宠物容器)');
  ok(!/new Map<string, PetEntry>|new Map<string, Map<string, PetEntry>>/.test(breed),
    '动作层不再 `new Map<...PetEntry>`:宠物状态只有一份');
  /* 2 动作层确实 import 了容器的五个入口(不是「只在注释里说接上了」)。 */
  for (const fn of ['createPetRecord', 'feedPet', 'sendToRanch', 'commandPet', 'forgetRoomPets']) {
    ok(new RegExp(`\\b${fn}\\b`).test(breed), `动作层真的引用了 ${fn}`);
  }
  /* 3 正对照:扫描器看得见容器本体(否则上面两条只是「什么都没找到」)。 */
  ok(/const PET_BOX = new Map<string, Map<string, Map<string, PetSlot>>>\(\)/.test(taming),
    '正对照:taming.ts 里确实有 `PET_BOX`(扫描器不是恒空)');
  ok(/export function putPetSlot\(/.test(taming),
    '正对照:容器的唯一写口 `putPetSlot` 在 taming.ts');
});

/* ═════════════ 2. 白名单条目与实测一致 ═════════════ */

test('FND146-2 taming.ts **不在**两张白名单里(它已有生产 importer);正对照:表体解析得到别的条目', () => {
  const verify = read('scripts/verify.ts');
  const orphan = read('scripts/orphan-audit.ts');
  const unreachable = tableBody(verify, 'const UNREACHABLE_EXEMPT = new Map<string, string>([');
  const known = tableBody(orphan, 'export const ORPHAN_KNOWN = new Map<string, string>([');

  /* 正对照:两张表都还解析得到**别人**(否则下面的「不在表里」是恒真)。 */
  ok(hasEntry(unreachable, 'server/src/build/wiring_view.ts'),
    '正对照:可达性白名单的表体解析到了 wiring_view.ts(表体锚点有效)');
  ok(hasEntry(known, 'server/src/build/wiring_view.ts'),
    '正对照:ORPHAN_KNOWN 的表体解析到了 wiring_view.ts');

  eq(hasEntry(unreachable, 'server/src/mobs/taming.ts'), false,
    '★ taming.ts 已可达 ⇒ 必须从 UNREACHABLE_EXEMPT 摘除(留着门禁会报「已可达,应移出」)');
  eq(hasEntry(known, 'server/src/mobs/taming.ts'), false,
    '★ 同一处豁免的另一半:ORPHAN_KNOWN 必须同步摘(否则「登记 N / 实测 M」永远不相等)');

  /* 模块层锚点:同一条规则在 `feedPet` 本体上也成立(上面绕的是动作层)。 */
  const sheepRecord = createPetRecord(MOB_SHEEP) as PetRecord;
  eq(feedPet(sheepRecord, WHEAT).reason, 'tamed', '锚:绵羊吃 123 ⇒ feedPet 直接判 tamed');
  eq(sheepRecord.stage, TameStage.TAMED, '锚:stage 真的推进到 TAMED');

  /* 生产 importer 是「已可达」的**依据**,不是注释里的说法。 */
  ok(/from '\.\.\/\.\.\/mobs\/taming\.ts'/.test(read('server/src/net/actions/breed_tame.ts')),
    '依据:breed_tame.ts 真有 `from \'../../mobs/taming.ts\'`(值导入)');
});

/* ═════════════ 3. 驯养前置:不可驯服物种(负对照)═════════════ */

test('FND146-3 ★负对照(驯养前置):不可驯服的物种 ⇒ 不登记、不扣物品;可驯服的才登记', () => {
  const roomId = 'r146_3';
  forgetRoom(roomId);

  /* 模块层:唯一判定是 `createPetRecord`(→ `canTame`)。 */
  eq(createPetRecord(MOB_NOT_TAMEABLE), null,
    '★ `createPetRecord` 对不可驯服物种返回 null(行为类别不在 TAMEABLE/MOUNT/PASSIVE_UNKILLABLE)');
  ok(createPetRecord(MOB_SHEEP) !== null, '正对照:绵羊可驯服(否则这条判据无对象)');

  /* 动作层:被拒之后**不留记录、不扣物品**。 */
  const bag: Bag = new Map([[WHEAT, 1]]);
  const r = feed(roomId, 'p1', 'pet:wild', MOB_NOT_TAMEABLE, WHEAT, bag);
  eq(r.ok, false, '不可驯服物种不能投喂');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(petsOfRoom(roomId), [], '★ 没有留下宠物记录(拒绝发生在写入之前)');
  eq(bag.get(WHEAT), 1, '★ 那件小麦还在背包里');

  /* 正对照:同一夹具换可驯服物种 ⇒ 成功且登记。 */
  const okFeed = feed(roomId, 'p1', 'pet:sheep', MOB_SHEEP, WHEAT, bag);
  eq(okFeed.ok, true, '正对照:可驯服物种能投喂');
  eq(petsOfRoom(roomId).length, 1, '正对照:容器里真的多了一条');
  forgetRoom(roomId);
});

/* ═════════════ 4/5. 两个计数器:亲密度 vs 驯化进度 ═════════════ */

test('FND146-4 物种食物 ⇒ 亲密度 +1 **且** stage 前进;非物种食物 ⇒ 只涨亲密度(不推进驯化)', () => {
  const roomId = 'r146_4';
  forgetRoom(roomId);
  const bag: Bag = new Map([[WHEAT, 4], [SQUIRREL_FOOD, 1]]);

  /* 羊(吃 123)喂 123:两份口径同时前进。 */
  const sheep = feed(roomId, 'p1', 'pet:sheep', MOB_SHEEP, WHEAT, bag);
  eq(sheep.ok, true, '绵羊 + 黄金小麦应被接受');
  eq(sheep.effect?.affection, 1, '亲密度 +1');
  eq(sheep.effect?.stage, TameStage.TAMED, '★ 这是它自己的食物 ⇒ stage 推进(绵羊只需 1 口)');
  eq(sheep.effect?.fedCount, 1, '★ 驯化计数 +1');

  /* 花栗鼠(吃 121)喂 123:**接受**,但不推进驯化。 */
  const squirrel = feed(roomId, 'p1', 'pet:squirrel', MOB_SQUIRREL, WHEAT, bag);
  eq(squirrel.ok, true, '★ 背包里有那一件就能喂(动作层契约:不验食谱)');
  eq(squirrel.effect?.affection, 1, '★ 亲密度照样 +1');
  eq(squirrel.effect?.stage, TameStage.WILD, '★ 但不是它吃的那件 ⇒ stage 仍是 WILD');
  eq(squirrel.effect?.fedCount, 0, '★ 驯化计数没动 —— 两个计数器不是同一个数');

  /* 喂对食物才推进:花栗鼠 + 121。 */
  const right = feed(roomId, 'p1', 'pet:squirrel', MOB_SQUIRREL, SQUIRREL_FOOD, bag);
  eq(right.ok, true, '喂对它自己的食物应被接受');
  eq(right.effect?.stage, TameStage.TAMED, '★ 换对食物后 stage 才前进');
  eq(right.effect?.affection, 2, '亲密度累加到 2(两口都被接受)');
  forgetRoom(roomId);
});

test('FND146-5 认主:亲密度 1/3 时拒;吃到物种食物的认主后 command=FOLLOW,没吃到的不下指令', () => {
  const roomId = 'r146_5';
  forgetRoom(roomId);
  const bag: Bag = new Map([[WHEAT, 3]]);

  eq(feed(roomId, 'p1', 'pet:sheep', MOB_SHEEP, WHEAT, bag).ok, true, '前置:喂一口');
  const early = tame(roomId, 'p1', 'pet:sheep', bag);
  eq(early.ok, false, '★负对照:亲密度 1/3 不能驯服');
  eq(tameOwnerOf(roomId, 'pet:sheep'), null, '★ 被拒后没有主人(驯服没发生)');

  /* 喂满 3 口(羊只需要 1 口就 TAMED,但认主门槛是**动作层**的 3)。 */
  for (let i = 1; i < AFFECTION_REQUIRED; i += 1) {
    eq(feed(roomId, 'p1', 'pet:sheep', MOB_SHEEP, WHEAT, bag).ok, true, `前置:第 ${i + 1} 口`);
  }
  const done = tame(roomId, 'p1', 'pet:sheep', bag);
  eq(done.ok, true, '喂满后应能驯服');
  eq(tameOwnerOf(roomId, 'pet:sheep'), 'p1', '★ 容器里记下主人');
  eq(done.effect?.command, TameCommand.FOLLOW, '★ 认主后下第一条指令 = FOLLOW(commandPet 的生产调用点)');
  eq(done.effect?.following, true, '已驯化 ⇒ 指令被接受');

  /* 只涨亲密度、没吃对食物的宠物:能认主,但 `stage` 仍 WILD ⇒ 指令不被接受。 */
  const bag2: Bag = new Map([[WHEAT, 3]]);
  for (let i = 0; i < AFFECTION_REQUIRED; i += 1) {
    eq(feed(roomId, 'p2', 'pet:squirrel', MOB_SQUIRREL, WHEAT, bag2).ok, true, `前置:花栗鼠第 ${i + 1} 口`);
  }
  const raw = tame(roomId, 'p2', 'pet:squirrel', bag2);
  eq(raw.ok, true, '亲密度达标即可认主(门槛在动作层)');
  eq(raw.effect?.following, false, '★负对照:没吃到物种食物 ⇒ stage 仍 WILD ⇒ `commandPet` 拒绝');
  forgetRoom(roomId);
});

/* ═════════════ 6/7. 牧场容量 / 出战上限(各一条负对照)═════════════ */

/** 造一只「已驯化」的记录(直接构造成员,不走动作层)。 */
function tamedPet(mobId: string, inRanch = false): PetRecord {
  const pet = createPetRecord(mobId);
  if (pet === null) throw new Error(`${mobId} 应可驯服`);
  pet.stage = TameStage.TAMED;
  pet.fedCount = pet.requiredFeeds;
  pet.inRanch = inRanch;
  return pet;
}

test('FND146-6 ★负对照(牧场容量):圈满即拒,且被拒的那只**没被标成在圈**', () => {
  /* 容量只用**入参**构造(不把常量当期望值 —— 那是同义反复候选)。 */
  const roster: PetRecord[] = [];
  for (let i = 0; i < RANCH_CAPACITY - 1; i += 1) roster.push(tamedPet(MOB_SHEEP, true));
  const last = tamedPet(MOB_SHEEP, false);
  eq(sendToRanch(roster, last), true, '正对照:还差一位时送得进(说明下面那条不是「永远 false」)');
  roster.push(last);

  const overflow = tamedPet(MOB_SHEEP, false);
  eq(sendToRanch(roster, overflow), false,
    `★负对照:圈满(=${RANCH_CAPACITY})时送不进 —— 否则每送一次就多一份产出`);
  eq(overflow.inRanch, false, '★ 被拒的宠物没有被标成在圈(失败路径不改状态)');

  /* 正对照:腾出一个位就送得进(说明上面那条不是「永远 false」)。 */
  roster.pop();
  eq(sendToRanch(roster, overflow), true, '正对照:空一位就能进圈');
  eq(overflow.inRanch, true, '正对照:进了圈就真的标上');
  eq(overflow.deployed, false, '进圈 ⇒ 自动卸下出战');

  /* 未驯化的送不进(第二条前置)。 */
  const wild = createPetRecord(MOB_SHEEP);
  ok(wild !== null, '前置:野生记录构造成功');
  eq(sendToRanch([], wild as PetRecord), false, '未驯化的不能进圈');
});

test('FND146-7 ★负对照(出战上限):默认 1 只,超了拒;戴 628 徽章才 2 只', () => {
  /* 期望值写**字面量**,不拿被测常量当期望(否则改常量断言跟着变 ⇒ 同义反复)。 */
  eq(deployLimit([]), 1, '不戴 ⇒ 上限 1');
  eq(deployLimit([DEPLOY_BADGE_ID]), 2, `戴 ${DEPLOY_BADGE_ID} ⇒ 上限 2`);

  const a = tamedPet(MOB_SHEEP);
  const b = tamedPet(MOB_SQUIRREL);
  const pets = [a, b];

  /* 未驯化先拒(第一条负对照)。 */
  const wild = createPetRecord(MOB_SHEEP) as PetRecord;
  eq(deployPet(pets, wild, []).reason, 'not_tamed', '★负对照:未驯化不能出战');

  const first = deployPet(pets, a, []);
  eq(first.ok, true, '正对照:第一只出战');
  eq(first.deployed, 1, '出战数 1');
  eq(a.command, TameCommand.FOLLOW, '出战时自动转 FOLLOW');

  const second = deployPet(pets, b, []);
  eq(second.ok, false, '★负对照:上限 1 ⇒ 第二只被拒');
  eq(second.reason, 'limit_reached', '拒绝理由必须是 limit_reached');
  eq(b.deployed, false, '★ 被拒的那只没被标成出战中');

  const withBadge = deployPet(pets, b, [DEPLOY_BADGE_ID]);
  eq(withBadge.ok, true, '正对照:戴徽章后上限 2 ⇒ 第二只也能出战');
  eq(withBadge.deployed, 2, '出战数 2');
});

/* ═════════════ 8/9. 容器按玩家存 / 换主人搬格 / 回收 ═════════════ */

test('FND146-8 容器按玩家存:换主人=搬格(同一 petId 只在**一处**),按玩家查得出来', () => {
  const roomId = 'r146_8';
  forgetRoomPets(roomId);
  const record = createPetRecord(MOB_SHEEP) as PetRecord;
  const slot: PetSlot = { petId: 'pet:x', ownerId: null, bond: 0, record };
  putPetSlot(roomId, slot);

  eq(petsOfPlayer(roomId, '').length, 1, '无主的槽挂在「无主」那一格(空串键)');
  eq(petSlotOf(roomId, 'pet:x')?.ownerId, null, '单查读到的也是无主');

  slot.ownerId = 'p1';
  putPetSlot(roomId, slot);
  eq(petsOfPlayer(roomId, '').length, 0, '★ 搬格后旧格不再有它(不是「两份记录」)');
  eq(petsOfPlayer(roomId, 'p1').length, 1, '★ 新格里有它');
  eq(petSlotOf(roomId, 'pet:x')?.ownerId, 'p1', '单查读到新主人');
  eq(petsOfPlayer(roomId, 'p2').length, 0, '别人那一格没有它');

  /* 只读查询不 materialize:对没见过的房间问一次不许留痕。 */
  const ghost = 'r146_8_ghost';
  eq(petSlotOf(ghost, 'pet:x'), null, '不存在的房间 ⇒ null');
  eq(petsOfPlayer(ghost, 'p1'), [], '不存在的房间 ⇒ 空');
  eq(petSlotOf(ghost, 'pet:x'), null, '再问一次仍 null(没有凭空登记)');
  forgetRoomPets(roomId);
});

test('FND146-9 `forgetRoom` 清掉容器与繁殖记录(房间侧账回收真的到容器)', () => {
  const roomId = 'r146_9';
  forgetRoom(roomId);
  const bag: Bag = new Map([[WHEAT, 3]]);
  eq(feed(roomId, 'p1', 'pet:sheep', MOB_SHEEP, WHEAT, bag).ok, true, '前置:登记一只');
  eq(petsOfRoom(roomId).length, 1, '前置:容器里有 1 只');

  forgetRoom(roomId);
  eq(petsOfRoom(roomId), [], '★ 容器被清空(不是只清动作层那份)');
  eq(tameOwnerOf(roomId, 'pet:sheep'), null, '归属也读不到了');
});

/* ═════════════ 10. 反向:未接线的部分如实登记(不是「都接了」)═════════════ */

test('FND146-10 仍**没有**协议入口的导出如实登记(客户端 op 表只有四个)', () => {
  const taming = read('server/src/mobs/taming.ts');
  /* 文件头必须写明「没有协议入口」的那几个 —— 这不是注释洁癖:
     少了这句,下一个人会以为 deployPet 已经能被玩家触发。 */
  ok(/没有.*协议入口|没入口/.test(taming), '文件头如实写明哪些导出没有协议入口');
  ok(/WS-FND-138/.test(taming), '并指名「客户端 op 表被 WS-FND-138 钉死为四个」这个理由');
  /* 正对照:四个 op 确实是四个(与上面那句一致)。 */
  eq(Object.values(TameOp), ['FEED', 'TAME', 'BREED', 'RANCH'], 'TameOp 仍是四个子操作');
  /* 三指令的语义仍在模块内可断言(未接线的部分不是空壳)。 */
  const pet = tamedPet(MOB_SHEEP);
  eq(commandPet(pet, TameCommand.CARRY), true, '驯化后接得下 CARRY');
  ok(pet.carryLoad > 0, 'CARRY ⇒ carryLoad > 0(不是全仓只写 0 的那条恒假分支)');
});

report('WS-FND-146');