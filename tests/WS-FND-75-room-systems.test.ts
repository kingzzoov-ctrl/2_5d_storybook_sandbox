/**
 * WS-FND-75 —— 手册 §3.8 里四种「**系统解锁**」房间的实装判据。
 *
 * ## 这个套件钉的是什么
 *
 * `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION` 把 9 种房间分成三类,其中
 * `ECO_RANCH` / `ALCHEMY_LAB` / `AUTO_GREENHOUSE` / `CLOUD_DEPOT` 四条此前都是
 * 「SYSTEM_UNLOCK ⇒ **未实装**」—— 玩家盖出牧场、炼金实验室、温室、百货店,
 * 手册承诺的东西一件都不发生,而门禁全绿。
 *
 * 本轮把这四个系统的实现落在 `server/src/systems/**`,并在 `ROOM_EFFECT_DECISION`
 * 里给每条加了一个**可判定**的 `implementedBy`(仓库相对路径)。本套件核三件事:
 *
 *   1. **落点是真的**:`implementedBy` 指向的文件真的存在、`entry` 指向的函数
 *      真的从那个模块导出、`purpose` 里不再写「未实装」;
 *   2. **四个系统各自的行为**:日结产出 / 全天候透光与分拣 / 首创冠名陈列 /
 *      上架与购买结算;
 *   3. **负对照**:没有饲料 ⇒ 不产出;夜里 ⇒ 温室照长而露天不长;没炼过 ⇒
 *      陈列里没有;库存不足 ⇒ 购买被拒且库存不变;内容表没有 `price` ⇒
 *      「无定价」而不是编一个价。
 *
 * ## 期望值的来源(为什么右侧全是字面量)
 *
 * 期望值只有两个来源:**内容表**(`shared/constants/items.ts` 的 ID / tag)与
 * **手算**(1/4 天 = 0.25;单价 30 × 2 件 = 60;5×5 = 25 格)。
 * **不**从被测模块取期望 —— 用被测模块的常量核被测模块的行为是同义反复
 * (`scripts/verify.ts` 的 `--strict-taut` 判它「自证」)。
 *
 * 每条断言上方都写明「它怎么变红」。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { ITEM_BY_ID, ITEM_LIST } from '../shared/constants/items.ts';

import {
  ROOM_EFFECT_DECISION,
  ROOM_SYSTEM_IMPL,
  isRoomSystemImplemented,
} from '../server/src/rooms/effects.ts';

import * as ranchNs from '../server/src/systems/ranch.ts';
import * as greenhouseNs from '../server/src/systems/greenhouse.ts';
import * as alchemyNs from '../server/src/systems/alchemy_lab.ts';
import * as depotNs from '../server/src/systems/depot.ts';

import { settleRanchDay, canAutoFeed, feedItemOf } from '../server/src/systems/ranch.ts';
import {
  cellGrowth,
  morningMoisture,
  sprinklerCells,
  sortHarvest,
} from '../server/src/systems/greenhouse.ts';
import {
  createGallery,
  brewAndRecord,
  firstDiscovererOf,
  galleryOrder,
  galleryEntryOf,
} from '../server/src/systems/alchemy_lab.ts';
import { buy, listable, priceOf } from '../server/src/systems/depot.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * 四个系统房间 → (模块路径, 入口函数名)。**全部手写**:
 * 这三个字段就是「已实装」的可判定内容,抄实现的值等于没判。
 */
const EXPECTED_IMPL: [string, string, string][] = [
  ['ECO_RANCH', 'server/src/systems/ranch.ts', 'settleRanchDay'],
  ['ALCHEMY_LAB', 'server/src/systems/alchemy_lab.ts', 'brewAndRecord'],
  ['AUTO_GREENHOUSE', 'server/src/systems/greenhouse.ts', 'cellGrowth'],
  ['CLOUD_DEPOT', 'server/src/systems/depot.ts', 'buy'],
];

/** 模块命名空间的查表口:`entry` 是不是真的从那个模块导出的函数。 */
const NS: Record<string, Record<string, unknown>> = {
  ECO_RANCH: ranchNs as unknown as Record<string, unknown>,
  ALCHEMY_LAB: alchemyNs as unknown as Record<string, unknown>,
  AUTO_GREENHOUSE: greenhouseNs as unknown as Record<string, unknown>,
  CLOUD_DEPOT: depotNs as unknown as Record<string, unknown>,
};

/* ═══════════ 1. 落点:(effects.ts 的裁决表) ═══════════ */

test('FND75-1 四种 SYSTEM_UNLOCK 都有可判定的 implementedBy:文件存在 + 入口函数真的导出', () => {
  /* 怎么变红:
       · 某条 purpose 还留着「未实装」⇒ 第 2 条;
       · implementedBy 写成不存在的路径 ⇒ 第 3 条;
       · 入口函数改名/没导出 ⇒ 第 4 条(这是"文字说已实装、代码没这回事"的形态);
       · 把某个房间从登记表里摘掉 ⇒ 第 5 条。 */
  eq(EXPECTED_IMPL.length, 4, '锚:手册 §3.8 的四种系统解锁房间就这四个');
  for (const [key, mod, entry] of EXPECTED_IMPL) {
    const d = ROOM_EFFECT_DECISION[key];
    ok(d !== undefined, `${key} 必须在裁决表里`);
    eq(d.kind, 'SYSTEM_UNLOCK', `${key} 的种类仍是"解锁系统"(不是数值增益)`);
    ok(!d.purpose.includes('未实装'), `${key} 的 purpose 不得再声称「未实装」`);
    eq(d.implementedBy, mod, `${key} 的 implementedBy 必须指向实现模块`);
    ok(existsSync(join(ROOT, mod)), `${key} 的实现模块必须真实存在:${mod}`);
    eq(ROOM_SYSTEM_IMPL[key].module, mod, `登记表与 implementedBy 必须是同一事实`);
    eq(ROOM_SYSTEM_IMPL[key].entry, entry, `${key} 的入口函数名`);
    eq(typeof NS[key][entry], 'function', `${key} 的入口 ${entry} 必须真的从 ${mod} 导出`);
    eq(isRoomSystemImplemented(key), true, `${key} 应判定为已实装`);
  }
  /* 负对照:登记表只管这四个 —— 其余房间/未知 key 必须为假,
     否则 `isRoomSystemImplemented` 退化成恒真。 */
  eq(isRoomSystemImplemented('ART_GALLERY'), false, '画廊是展示型,不是系统解锁');
  eq(isRoomSystemImplemented('FORGE_MASTER'), false, '锻造房是数值增益,不走系统登记');
  eq(isRoomSystemImplemented('NO_SUCH_ROOM'), false, '未知房间必须为假');
});

test('FND75-2 登记表与裁决表**双向**对账:不多不少,且都指向 systems/**', () => {
  /* 怎么变红:往 ROOM_SYSTEM_IMPL 里塞一个裁决表没有的 key(死条目)⇒ 第 1 条;
     把 implementedBy 指到 systems/ 之外(比如指回 effects.ts)⇒ 第 2 条。 */
  eq(Object.keys(ROOM_SYSTEM_IMPL).sort().join(','), 'ALCHEMY_LAB,AUTO_GREENHOUSE,CLOUD_DEPOT,ECO_RANCH');
  for (const [key, impl] of Object.entries(ROOM_SYSTEM_IMPL)) {
    ok(impl.module.startsWith('server/src/systems/'), `${key} 的实现必须落在 server/src/systems/(实际 ${impl.module})`);
    eq(impl.roomKey, key, `${key} 登记里的 roomKey 必须与键一致`);
    ok(impl.entry.length > 0, `${key} 的入口函数名不得为空`);
  }
  /* 反向:裁决表里每个 SYSTEM_UNLOCK 都必须有 implementedBy(漏一条就红) */
  const missing = Object.entries(ROOM_EFFECT_DECISION)
    .filter(([, v]) => v.kind === 'SYSTEM_UNLOCK' && (v.implementedBy ?? '').length === 0)
    .map(([k]) => k);
  eq(missing.join(','), '', `SYSTEM_UNLOCK 缺 implementedBy:${missing.join(',') || '无'}`);
});

/* ═══════════ 2. 牧场日结(ranch) ═══════════ */

test('FND75-3 一天:1 只云朵绵羊吃 1 件黄金小麦、产 1 份「毛团」', () => {
  /* 出处:内容表 529 的 note「圈养的云朵绵羊与水豚会自动进食并每日产出毛团/温泉橘」;
     饲料 = 内容表 `mob_sheep.tameItem = 123 黄金小麦`;1 天 1 份 ⇒ 手算产出 1。
     怎么变红:把"每天 1 份"写成"每份饲料产 N 份"⇒ 第 2 条;饲料 ID 写死成 122 ⇒ 第 3 条; */
  eq(feedItemOf('mob_sheep'), 123, '绵羊的饲料取自内容表 tameItem(123 黄金小麦)');
  eq(feedItemOf('mob_capybara'), 122, '水豚的饲料取自内容表 tameItem(122 金秋蜜桃)');

  const r = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.9 }], feed: { 123: 4 }, days: 1 });
  eq(r.days, 1);
  eq(r.produce.length, 1, '一只动物一行产出');
  eq(r.produce[0].name, '毛团', '手册点名的产出名');
  eq(r.produce[0].count, 1, '1 天 ⇒ 1 份');
  eq(r.feedConsumed, [{ itemId: 123, count: 1 }], '吃掉 1 件黄金小麦');
  eq(r.fedCount, 1);
  eq(r.starvedCount, 0);
  eq(r.skippedCount, 0);
});

test('FND75-4 ★负对照:槽里没有饲料 ⇒ 不进食也不产出(且不报错)', () => {
  /* 怎么变红:把"没饲料"当成"照产不误"⇒ 第 1/2 条;
     或者把没吃到的动物也算进 fedCount ⇒ 第 4 条。 */
  const r = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.9 }], feed: {}, days: 1 });
  eq(r.produce, [], '没有饲料 ⇒ 产出为空');
  eq(r.feedConsumed, [], '没有饲料 ⇒ 消耗为空');
  eq(r.fedCount, 0);
  eq(r.starvedCount, 1, '应该记一条"饿了一天"');
  eq(r.skippedCount, 0, '饿肚子不是"跳过"—— 它在牧场里,只是槽空了');
  ok(r.notes.length > 0, '必须留下人读的理由');
});

test('FND75-5 饲料只够一半 ⇒ 产出一半,不多吃也不少吃(4 天 2 件 ⇒ 2 份)', () => {
  /* 手算:每天 1 件,2 件 ⇒ 2 天有饭吃 ⇒ 2 份产出;第 3/4 天挨饿。
     怎么变红:把 min(天数, 饲料可支撑天数) 写成"有饲料就产满天数" ⇒ 第 2 条;
     或把饲料一次全吃掉 ⇒ 第 3 条。 */
  const r = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.9 }], feed: { 123: 2 }, days: 4 });
  eq(r.produce[0].count, 2, '2 件饲料 ⇒ 2 天产出');
  eq(r.feedConsumed, [{ itemId: 123, count: 2 }], '吃掉的正好是 2 件');
  eq(r.starvedCount, 1, '这只动物有两天没吃到');
  eq(r.fedCount, 1);
});

test('FND75-6 ★负对照:亲和不足 ⇒ 跳过(不进食、不产出);不是牧场物种 ⇒ 也不进日结', () => {
  /* 怎么变红:亲和判定去掉 ⇒ 第 1/2 条;把"所有 tameable 物种"都当成能进牧场
     ⇒ 花栗鼠那条红(手册只点名绵羊与水豚)。 */
  const low = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.69 }], feed: { 123: 9 }, days: 1 });
  eq(low.produce, [], '亲和 0.69 < 0.7 ⇒ 不产出');
  eq(low.feedConsumed, [], '没养熟的动物不吃饲料');
  eq(low.skippedCount, 1);

  const okAff = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.7 }], feed: { 123: 1 }, days: 1 });
  eq(okAff.produce.length, 1, '0.7 是下限本身 ⇒ 达标(边界值)');

  const squirrel = settleRanchDay({ animals: [{ speciesId: 'mob_squirrel', affinity: 0.95 }], feed: { 121: 9 }, days: 1 });
  eq(squirrel.produce, [], '花栗鼠不是手册点名的牧场动物');
  eq(squirrel.feedConsumed, [], '它也不吃牧场饲料');
  eq(squirrel.skippedCount, 1);

  const unknown = settleRanchDay({ animals: [{ speciesId: 'mob_nope', affinity: 1 }], feed: {}, days: 1 });
  eq(unknown.skippedCount, 1, '内容表里没有的物种一律跳过');
});

test('FND75-7 自动进食判定 + 产出缺口照实暴露(内容表还没有「毛团」/「温泉橘」)', () => {
  /* 怎么变红:给产出编一个物品 ID(比如拿 119 云朵棉花顶替毛团)⇒ 第 1/3 条;
     canAutoFeed 与 settleRanchDay 走两套判定 ⇒ 第 4/5 条对不上。 */
  ok(!ITEM_LIST.some((i) => i.name === '毛团'), '内容表目前没有「毛团」这件物品(锚:缺口是真的)');
  ok(!ITEM_LIST.some((i) => i.name === '温泉橘'), '内容表目前没有「温泉橘」这件物品');

  const r = settleRanchDay({ animals: [{ speciesId: 'mob_capybara', affinity: 0.8 }], feed: { 122: 3 }, days: 2 });
  eq(r.produce[0].name, '温泉橘', '水豚的产出名来自手册');
  eq(r.produce[0].count, 2, '2 天 ⇒ 2 份');
  eq(r.produce[0].itemId, null, '★ 内容表没有这件物品 ⇒ 如实返回 null,不编 ID');
  eq(r.unresolved, ['温泉橘'], '缺口必须浮在脸上(而不是悄悄换成别的物品)');

  /* 自动进食 = 亲和达标 ∧ 物种在牧场 ∧ 槽里至少一天饲料 */
  eq(canAutoFeed({ speciesId: 'mob_sheep', affinity: 0.9 }, { 123: 1 }), true);
  eq(canAutoFeed({ speciesId: 'mob_sheep', affinity: 0.9 }, {}), false, '没有饲料 ⇒ 不自动进食');
  eq(canAutoFeed({ speciesId: 'mob_sheep', affinity: 0.1 }, { 123: 9 }), false, '没养熟 ⇒ 不自动进食');
  eq(canAutoFeed({ speciesId: 'mob_squirrel', affinity: 1 }, { 121: 9 }), false, '非牧场物种 ⇒ 不自动进食');
});

/* ═══════════ 3. 温室(greenhouse) ═══════════ */

test('FND75-8 白天露天:4 天成熟 ⇒ 每天长 0.25;进度 ≥ 1 即成熟', () => {
  /* 手算:1 / 4 = 0.25;0.8 + 0.25 = 1.05 ≥ 1 ⇒ 成熟。
     怎么变红:成熟天数不参与计算(恒长固定值)⇒ 第 1/2 条;ready 用 > 而不是 ≥ ⇒ 边界那条。 */
  const base = cellGrowth({
    cell: { cropId: 121, matureDays: 4, moisture: 1 },
    night: false,
    weather: 'CLEAR',
    inGreenhouse: false,
    sprinkler: false,
  });
  eq(base.lightOk, true);
  eq(base.watered, true);
  eq(base.growthPerDay, 0.25, '4 天成熟 ⇒ 每天 1/4');
  eq(base.ready, false, '刚播种(进度 0)一天后还不熟');

  const nearly = cellGrowth({
    cell: { cropId: 121, matureDays: 4, moisture: 1, progress: 0.8 },
    night: false,
    weather: 'CLEAR',
    inGreenhouse: false,
    sprinkler: false,
  });
  eq(nearly.ready, true, '0.8 + 0.25 = 1.05 ⇒ 今天成熟');

  const bad = cellGrowth({
    cell: { cropId: 121, matureDays: 0, moisture: 1 },
    night: false,
    weather: 'CLEAR',
    inGreenhouse: true,
    sprinkler: true,
  });
  eq(bad.growthPerDay, 0, '成熟天数非法 ⇒ 不生长(不是除零成 Infinity)');
  eq(bad.ready, false);
});

test('FND75-9 ★负对照:夜里 ⇒ 温室照长 0.25,露天长 0', () => {
  /* 怎么变红:温室与露天用同一个光照判定(房间里没有增益)⇒ 第 2 条;
     反过来把露天也判成"夜里照长" ⇒ 第 4 条(露天的行为被温室吃掉了)。 */
  const cell = { cropId: 121, matureDays: 4, moisture: 1 };
  const inHouse = cellGrowth({ cell, night: true, weather: 'CLEAR', inGreenhouse: true, sprinkler: true });
  const openAir = cellGrowth({ cell, night: true, weather: 'CLEAR', inGreenhouse: false, sprinkler: false });

  eq(inHouse.growthPerDay, 0.25, '★ 温室夜里照长(375 全天候透光)');
  eq(inHouse.lightOk, true, '温室的光照恒成立');
  eq(openAir.growthPerDay, 0, '★ 露天夜里不长');
  eq(openAir.lightOk, false);
  ok(openAir.reason.includes('夜'), '理由要说清是"夜里"而不是别的原因');
});

test('FND75-10 暴风雨:露天被挡光,温室照长;小雨不挡光(二值判定,不编倍率)', () => {
  /* 怎么变红:把天气做成倍率表(需要编天气强度)⇒ 第 1/3 条会变成 0.15 之类;
     把 RAIN 也判成挡光 ⇒ 第 4 条。 */
  const cell = { cropId: 121, matureDays: 4, moisture: 1 };
  const stormOpen = cellGrowth({ cell, night: false, weather: 'STORM', inGreenhouse: false, sprinkler: false });
  const stormHouse = cellGrowth({ cell, night: false, weather: 'STORM', inGreenhouse: true, sprinkler: true });
  const rainOpen = cellGrowth({ cell, night: false, weather: 'RAIN', inGreenhouse: false, sprinkler: false });

  eq(stormOpen.growthPerDay, 0, '暴风雨露天 ⇒ 不长');
  eq(stormHouse.growthPerDay, 0.25, '暴风雨温室 ⇒ 照长');
  eq(rainOpen.growthPerDay, 0.25, '小雨仍有散射光 ⇒ 露天照长');
});

test('FND75-11 ★负对照:没浇透 ⇒ 不长;温室洒水器早上把它浇满到 1', () => {
  /* 怎么变红:去掉浇水判定 ⇒ 第 1 条(0.2 也照长);
     洒水器只在"有洒水器"时不看温室 ⇒ 第 3 条(露天被凭空自动浇水)。 */
  const dry = cellGrowth({
    cell: { cropId: 121, matureDays: 4, moisture: 0.2 },
    night: false,
    weather: 'CLEAR',
    inGreenhouse: false,
    sprinkler: false,
  });
  eq(dry.watered, false, '含水量 0.2 < 0.35 ⇒ 没浇透');
  eq(dry.growthPerDay, 0, '没浇透 ⇒ 今天不长');

  const houseDry = cellGrowth({
    cell: { cropId: 121, matureDays: 4, moisture: 0.2 },
    night: true,
    weather: 'CLEAR',
    inGreenhouse: true,
    sprinkler: true,
  });
  eq(houseDry.watered, true, '温室 + 洒水器 ⇒ 一定浇透(426 每早自动旋转)');
  eq(houseDry.growthPerDay, 0.25);

  eq(morningMoisture({ moisture: 0.2, inGreenhouse: true, sprinkler: true }), 1, '早上浇到 1.0');
  eq(morningMoisture({ moisture: 0.2, inGreenhouse: false, sprinkler: true }), 0.2, '★ 洒水器在露天不生效(没接水/不在温室)');
});

test('FND75-12 自动洒水 5×5(25 格)+ 分拣带按过滤规则分流', () => {
  /* 手算:半径 2 ⇒ 5 行 × 5 列 = 25 格,角在 (cx±2, cy±2)。
     怎么变红:半径写成 1 ⇒ 25 变 9;分拣"最后一条命中" ⇒ 第 4 条。 */
  const cells = sprinklerCells(10, 20);
  eq(cells.length, 25, '5×5 = 25 格(内容表 426 的字面量)');
  eq(cells[0], { x: 8, y: 18 }, '左上角 = (cx-2, cy-2)');
  eq(cells[24], { x: 12, y: 22 }, '右下角 = (cx+2, cy+2)');
  ok(!cells.some((c) => c.x === 13), '不含半径外的格');

  const filters = [
    { lane: 1, itemIds: [119, 121] },
    { lane: 2, itemIds: [119, 704] },
  ];
  eq(sortHarvest(119, filters), 1, '两条都命中 ⇒ 取**第一条**');
  eq(sortHarvest(704, filters), 2, '只命中第二条 ⇒ lane 2');
  eq(sortHarvest(123, filters), -1, '★ 一条都没命中 ⇒ 不从带上分出去(-1)');
});

/* ═══════════ 4. 炼金实验室:首创冠名陈列(alchemy_lab) ═══════════ */

test('FND75-13 ★负对照:没炼过 ⇒ 陈列里没有;查询一律空', () => {
  /* 怎么变红:createGallery 预置一行(比如"示例奇物")⇒ 第 1/2/3 条;
     firstDiscovererOf 对没炼过的配方返回空字符串而不是 null ⇒ 第 3 条。 */
  const g = createGallery();
  eq(galleryOrder(g), [], '空馆 ⇒ 陈列 0 行');
  eq(firstDiscovererOf(g, [116, 125, 712]), null, '没炼过 ⇒ 没有冠名');
  eq(galleryEntryOf(g, [116, 125, 712]), undefined, '没炼过 ⇒ 没有那一行');
});

test('FND75-14 首次合成:冠名 = 合成者,craftCount = 1,产物来自确定性降级(不联网)', () => {
  /* 怎么变红:冠名写成固定值 ⇒ 第 2 条;不走降级生成器(产物名空)⇒ 第 3/4 条;
     不记 schema ⇒ 第 5 条。 */
  const g = createGallery();
  const out = brewAndRecord(g, {
    itemIds: [116, 125, 712],
    affinity: 0.8,
    suggestedSLogic: 60,
    discovererName: '阿岚',
    at: 1000,
  });
  ok(out.ok, `合成应成功(${out.ok ? '' : out.reason})`);
  if (!out.ok) return;
  eq(out.first, true, '第一次合成 ⇒ 首创');
  eq(out.entry.discovererName, '阿岚', '冠名 = 合成者名字');
  eq(out.entry.recipeHash, '116_125_712', '配方哈希 = 材料 ID 升序下划线拼接');
  eq(out.entry.craftCount, 1);
  eq(out.entry.firstAt, 1000, '时间戳来自入参(本模块不读时钟)');
  ok(out.entry.itemName.length > 0, '降级生成器必须给出产物名(无 LLM 也能产出)');
  const schema = JSON.parse(out.entry.schemaJson) as { item_name?: string };
  eq(schema.item_name, out.entry.itemName, 'schema 里的产物名与台账同一份');
  eq(galleryOrder(out.gallery).length, 1, '陈列里出现 1 行');
});

test('FND75-15 第二个人合出同一配方:冠名**仍是第一人**,只加 craft_count', () => {
  /* 怎么变红:第二次把冠名覆盖成新玩家 ⇒ 第 1 条(首创二字失效);
     每次合成新建一行 ⇒ 第 2 条。 */
  const g0 = createGallery();
  const first = brewAndRecord(g0, { itemIds: [116, 125, 712], affinity: 0.8, suggestedSLogic: 60, discovererName: '阿岚', at: 1000 });
  ok(first.ok);
  if (!first.ok) return;
  const second = brewAndRecord(first.gallery, { itemIds: [712, 116, 125], affinity: 0.4, suggestedSLogic: 40, discovererName: '小满', at: 2000 });
  ok(second.ok);
  if (!second.ok) return;

  eq(second.first, false, '第二次不是首创');
  eq(second.entry.discovererName, '阿岚', '★ 首创者不变(材料顺序不同也算同一配方)');
  eq(second.entry.craftCount, 2, '全服合成次数 +1');
  eq(galleryOrder(second.gallery).length, 1, '同一配方只陈列一行');
  eq(firstDiscovererOf(second.gallery, [125, 712, 116]), '阿岚', '查询口与台账同源');
});

test('FND75-16 材料件数不在 2~4 或材料不在内容表 ⇒ 拒绝,且馆不变', () => {
  /* 出处:内容表 536「自由放入任意 2~4 件非蓝图物品」。
     怎么变红:不校验件数 ⇒ 第 1/2 条;对未知 ID 也硬算哈希 ⇒ 第 3 条。 */
  const g = createGallery();
  const one = brewAndRecord(g, { itemIds: [116], affinity: 0.8, suggestedSLogic: 60, discovererName: '阿岚', at: 1 });
  eq(one.ok, false, '1 件材料不该能炼');
  const five = brewAndRecord(g, {
    itemIds: [116, 119, 121, 123, 125],
    affinity: 0.8,
    suggestedSLogic: 60,
    discovererName: '阿岚',
    at: 1,
  });
  eq(five.ok, false, '5 件材料超出上限');
  const unknown = brewAndRecord(g, { itemIds: [116, 99999], affinity: 0.8, suggestedSLogic: 60, discovererName: '阿岚', at: 1 });
  eq(unknown.ok, false, '内容表里没有的物品不能进炉');
  eq(galleryOrder(unknown.gallery).length, 0, '★ 被拒的合成不得留下陈列行');
});

test('FND75-17 冠名净化复用同一处规则:空名回落,超长截断,换行/尖括号被抹掉', () => {
  /* 怎么变红:自己再写一份净化(口径与 alchemy/cache.ts 不同)⇒ 第 2/3 条。 */
  const g = createGallery();
  const empty = brewAndRecord(g, { itemIds: [116, 125], affinity: 0.8, suggestedSLogic: 60, discovererName: '  ', at: 1 });
  ok(empty.ok);
  if (!empty.ok) return;
  eq(empty.entry.discovererName, '无名炉灵', '空名回落值(alchemy/cache.ts 的既有口径)');

  const dirty = brewAndRecord(empty.gallery, {
    itemIds: [116, 121],
    affinity: 0.8,
    suggestedSLogic: 60,
    discovererName: '<贪吃>小满\n',
    at: 2,
  });
  ok(dirty.ok);
  if (!dirty.ok) return;
  eq(dirty.entry.discovererName, '贪吃小满', '尖括号与换行被抹掉');
});

/* ═══════════ 5. 百货店:上架与购买结算(depot) ═══════════ */

test('FND75-18 内容表没有 `price` ⇒ 照实「无定价」(不拿 value 当价格)', () => {
  /* 出处:内容表只有 `value`(炼金价值分),没有 `price`。
     怎么变红:把 value 当价格 ⇒ 第 1 条(704 的 value=250 会被报成有价);
     写一个默认价(比如 1 金)⇒ 第 2 条。 */
  ok(!ITEM_LIST.some((i) => 'price' in (i as unknown as Record<string, unknown>)),
    '锚:内容表当前没有任何 price 字段');
  eq(ITEM_BY_ID.get(704)?.value, 250, '锚:704 的 value 是 250(价值分,不是售价)');

  const p = priceOf(704);
  eq(p.kind, 'UNPRICED', '★ 没有定价就是没有定价');
  ok(p.kind === 'UNPRICED' && p.reason.includes('无定价'), '理由必须明说"无定价"');
  eq(priceOf(99999).kind, 'UNPRICED', '内容表里没有的物品也不可能定价');
});

test('FND75-19 有价时成交:单价 30 × 2 件 = 60,库存 5 → 3', () => {
  /* 手算:30 × 2 = 60;5 - 2 = 3。价格表由调用方喂(内容表还没有价)。
     怎么变红:成本按件数而不是单价×件数 ⇒ 第 2 条;库存不减 ⇒ 第 3 条; */
  const out = buy({ itemId: 704, qty: 2, stock: { 704: 5 }, table: { 704: 30 } });
  eq(out.ok, true, '有价且有货 ⇒ 成交');
  eq(out.cost, 60, '单价 30 × 2 件 = 60');
  eq(out.stock, { 704: 3 }, '库存 5 → 3');
});

test('FND75-20 ★负对照:库存不足 ⇒ 购买被拒且库存**一件不少**', () => {
  /* 怎么变红:先扣库存再判余量 ⇒ 第 2 条(剩下 0 件);
     直接就地改传入的 stock ⇒ 第 3 条。 */
  const stock = { 704: 1 };
  const out = buy({ itemId: 704, qty: 2, stock, table: { 704: 30 } });
  eq(out.ok, false, '只剩 1 件却买 2 件 ⇒ 拒绝');
  eq(out.stock, { 704: 1 }, '★ 被拒时库存不变');
  eq(out.cost, 0, '被拒时不得记成本');
  eq(stock, { 704: 1 }, '入参库存不得被就地修改');
});

test('FND75-21 ★负对照:无定价 ⇒ 购买被拒且库存不变(不编一个价卖出去)', () => {
  /* 怎么变红:缺省价回落成 1 或 value ⇒ 第 1 条。 */
  const out = buy({ itemId: 704, qty: 1, stock: { 704: 3 } });
  eq(out.ok, false, '内容表没定价 ⇒ 不能成交');
  eq(out.stock, { 704: 3 }, '库存不变');
  eq(out.cost, 0);
  ok(out.reason.includes('无定价'), '理由必须说"无定价"');
});

test('FND75-22 上架判定按内容表 tag:Boss 遗物 / 奇物可上架,普通材料不行', () => {
  /* 出处:内容表 515「上架自己爆出的稀有 Boss 材料或 AI 炼金奇物」。
     怎么变红:只按 value 判 ⇒ 第 3/4 条(云朵棉花 value=25 不该可上架;
     或者漏了奇物这一类 ⇒ 第 2 条)。 */
  eq(listable(704).ok, true, '704 是 Boss遗物 ⇒ 可上架');
  eq(listable(729).ok, true, '729 带「奇物」tag ⇒ 可上架');
  eq(listable(119).ok, false, '119 云朵棉花是普通材料 ⇒ 不可上架');
  eq(listable(99999).ok, false, '内容表里没有的物品 ⇒ 不可上架');
});

/* ═══════════ 6. 四个系统都是纯函数(不改入参 / 同输入同输出) ═══════════ */

test('FND75-23 纯函数:两次同输入同输出,且不改传入的饲料 / 库存 / 台账', () => {
  /* 怎么变红:日结把 feed 就地减掉、购买把 stock 就地减掉、记账把 gallery 就地改 ——
     都是"算完即丢"退化成"算完就写"的形态。 */
  const feed = { 123: 4 };
  const a = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.9 }], feed, days: 2 });
  const b = settleRanchDay({ animals: [{ speciesId: 'mob_sheep', affinity: 0.9 }], feed, days: 2 });
  eq(a, b, '相同输入 ⇒ 相同输出');
  eq(feed, { 123: 4 }, '饲料入参不得被就地扣减');

  const g = createGallery();
  const first = brewAndRecord(g, { itemIds: [116, 125], affinity: 0.8, suggestedSLogic: 60, discovererName: '阿岚', at: 5 });
  ok(first.ok);
  if (!first.ok) return;
  eq(galleryOrder(g), [], '记账返回新馆,原馆不动');
  const again = brewAndRecord(createGallery(), { itemIds: [116, 125], affinity: 0.8, suggestedSLogic: 60, discovererName: '阿岚', at: 5 });
  ok(again.ok);
  if (!again.ok) return;
  eq(again.entry.itemName, first.entry.itemName, '★ 降级路径是确定性的:同输入 ⇒ 同产物');
});

report('WS-FND-75');