/**
 * WS-FND-115 —— **宿主契约 + 回执形状**(第五轮实测的 5 处:P1×2 / P2×2 / P3×1)
 *
 * ## 本套件守的是什么(逐条对着第五轮的实测)
 *
 * ```
 * 1 P1 projectInventoryTotalFor 在生产宿主上是**空桩**
 *      room.ts 只读 host.inventoryDetailOf,而唯一生产宿主 world_sim.ts 恒返回 null
 *      ⇒ 「总量按明细重算」**永不执行**;总量实由 inventoryTotals(增量)与
 *        itemCounts(明细)各自维护 ⇒ 增量式漏一帧就永久偏差(契约 §2.3 的 W5 裁定)
 * 2 P1 回执形状不统一:effect 只允许**标量**,而 craft / use_alchemy_furnace
 *      塞嵌套对象/数组(用 `as unknown as EffectRecord` **绕过**类型)
 * 3 P2 ActionPayload 缺 7 个动作消费的键 ⇒ 各消费方自己补交叉类型
 * 4 P2 WorldSaveHost 未声明 6 个**被实际读取**的成员 ⇒ 全靠 `as` 交叉类型绕过,
 *      与接口自己声称的「结构化裁剪守卫」相悖
 * 5 P3 partyMode 两处维护(rt.partyMode 只写不读)+ hostPositionOf 声明 {x,y}
 *      而实返含 z(被静默丢弃)
 * ```
 *
 * ## 判据纪律(与 WS-FND-103/110/112 同一套)
 *
 * ```
 * 1 每条都能失败 —— 负对照 / 注入验证各至少一次(「跑过了」不算数)
 * 2 行为判据优先:能真跑一次生产装配(assemble)就不 grep 源码
 * 3 文本判据只锁「接线」那一段(纯函数测不到的地方),且必须带**结构语义**
 * 4 源码扫描必须自带**负对照**(扫不到不存在的符号),否则它可能恒真
 * ```
 *
 * 每条 test 的注释里写明「怎么变红」(改哪一行会让它红)—— 那就是注入验证的锚点。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type {
  ActionOutcome, EffectRecord, RoomRuntime, WorldSaveHost,
} from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { PartyMode } from '../server/src/db/repo.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** 读仓库内文件(只读,不写 —— 注入验证的还原由执行者手工做)。 */
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const roomSrc = read('server/src/net/room.ts');
const ctxSrc = read('server/src/net/actions/types.ts');
const craftSrc = read('server/src/net/actions/craft.ts');
const alchemySrc = read('server/src/net/actions/use_alchemy_furnace.ts');

/**
 * 切出 `export interface X { ... }` 的正文。
 *
 * ⚠️ 只用于「声明存在」类判据;正文里的嵌套对象都**缩进**了,所以 `^\n}` 只会命中
 * 接口自己的收尾行(与 `tests/WS-FND-11` 的同一取法)。
 */
function interfaceBody(src: string, name: string): string {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  return m?.[1] ?? '';
}
/**
 * 去掉**注释**后的源码(源码扫描判据必须只看代码)。
 *
 * ⚠️ 这一条是实测逼出来的:本轮修法在 docblock 里**逐字引用了旧写法**
 * (`as unknown as EffectRecord` / `AlchemyLabReadPort` / `WorldSaveHost & {...}`),
 * 只按裸字符串扫会把「文档里提到旧写法」当命中 ⇒ 判据恒红(假阳性)。
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const roomCode = codeOnly(roomSrc);
const craftCode = codeOnly(craftSrc);
const alchemyCode = codeOnly(alchemySrc);

/** 走生产同一条路把东西塞进背包(先铸凭证,再 applyInventory)。 */
function seed(rt: RoomRuntime, userId: string, itemId: number, n: number): void {
  const src = `seed:${userId}:${itemId}:${n}`;
  rt.grantItemSource(userId, src);
  const r = rt.applyInventory(userId, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `前置:应能塞进 ${n} 件 #${itemId}(被拒 ${r.rejectCode ?? '?'})`);
}

/** 生产装配(不手搓 rtOpts —— 那会绕开 `assemble()` 的接线)。 */
function makeRoom(roomId: string) {
  const a = assemble({
    roomId, ownerId: 'p1', clock: { nowMs: () => 0 }, sizeCells: 16, mobs: false,
  });
  a.runtime.join({ userId: 'p1' });
  return a;
}

/**
 * 用**原型链**包一层宿主,只覆盖 `inventoryDetailOf`(其余成员仍是真的 WorldSim
 * ⇒ 不伪造宿主能力)。这是第 1 条 P1 的**注入**夹具:让宿主「有明细」。
 */
function withDetail(
  host: WorldSaveHost,
  detail: readonly { quantity?: unknown }[] | null,
): WorldSaveHost {
  const surrogate = Object.create(host as object) as WorldSaveHost;
  return Object.assign(surrogate, {
    inventoryDetailOf: (): readonly { quantity?: unknown }[] | null => detail,
  });
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND115-1 ★ 生产宿主真的实现了新增声明的 6 个成员(修前:全被结构化裁掉)', () => {
  /* 怎么变红:把 WorldSaveHost 里任一新声明删掉 ⇒ 下面的 `host[m]` 在 tsc 上就红;
     再把 `world_sim.ts` 的 `sizeCells` / `lastRoomEffects` 改名 ⇒ 运行期红。 */
  const a = makeRoom('r115_1');
  const host = a.host;

  for (const m of ['maxHpForLevel', 'syncMaxHp', 'inventoryDetailOf', 'roomEffectOf'] as const) {
    eq(typeof host[m], 'function', `生产宿主要有 ${m}()`);
  }
  ok(Array.isArray(host.lastRoomEffects), '`lastRoomEffects` 是数组(慢帧产物)');
  eq(host.sizeCells, 16, '`sizeCells` 与世界一致(不是猜的默认 64)');
  eq(typeof host.maxHpForLevel?.('p1', 1), 'number', '`maxHpForLevel` 真的算得出上限');
  eq(typeof host.syncMaxHp?.('p1', 100), 'boolean', '`syncMaxHp` 返回「是否变更」');
  a.host.advance?.(60); /* 房间效果是**慢帧**产物:不推帧就没有 roomEffectOf 记录 */
  ok(host.roomEffectOf?.('p1') !== undefined, '`roomEffectOf` 在慢帧后有序');

  /* 声明侧:接口正文里必须有这 6 条 —— 少一条就等于允许「漏声明照样编译」。 */
  const body = interfaceBody(roomSrc, 'WorldSaveHost');
  ok(body.length > 0, '能找到 WorldSaveHost 接口正文');
  for (const decl of [
    'maxHpForLevel?(', 'syncMaxHp?(', 'inventoryDetailOf?(', 'roomEffectOf?(',
    'readonly sizeCells?:', 'lastRoomEffects?:',
  ]) {
    ok(body.includes(decl), `WorldSaveHost 应声明 \`${decl}\``);
  }
  /* 负对照:扫描器不是恒真 —— 编造的成员必须扫不到。 */
  ok(!body.includes('syncMaxHpZzz?('), '负对照:不存在的成员扫不到(证明上面不是恒真)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND115-2 ★★ 总量按明细重算**真的执行**(生产宿主没有明细 ⇒ 走房间按件账)', () => {
  /* 怎么变红:把 `projectInventoryTotalFor` 改回「只读 host.inventoryDetailOf,
     没有就 return false」⇒ `source` 会是 'none'、`total` 会是 0,下面三条全红。 */
  const a = makeRoom('r115_2');
  const rt = a.runtime;

  eq(a.host.inventoryDetailOf?.('p1'), null,
    '前提:生产宿主的明细**如实**是 null(第五轮 P1 的起点,不是缺陷)');
  eq(rt.lastInventoryProjection, null, '前提:还没跑过投影');

  seed(rt, 'p1', 103, 2);

  const proj = rt.lastInventoryProjection;
  ok(proj !== null, '★ 变更时必须留下一次投影记录(修前这里恒 null ⇒ 无从观测)');
  eq(proj?.source, 'room', '★ 宿主 null ⇒ 明细来源 = 房间按件账(不是「不重算」)');
  eq(proj?.total, 2, '重算的总量 = 明细合计(2 件)');
  eq(proj?.changed, false,
    '增量账**先**写(applyItemTotalDelta),重算结果与它一致 ⇒ changed = false(这正是「同源」的另一面)');
  eq(rt.authoritativeItemTotal('p1'), 2, '增量账与重算账一致');

  /* 负对照:两个明细源都没有的用户 ⇒ **如实**标 'none'(不假装算过、也不编造 0)。 */
  eq(rt.projectInventoryTotalFor('nobody_115'), false, '无明细源 ⇒ 返回 false');
  eq(rt.lastInventoryProjection?.source, 'none',
    '负对照:如实标 none —— 修前它与「算出来没变化」是同一个 false,从外面分不开');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND115-3 ★ 两处账同源:总量 == Σ(按件账),且重算幂等', () => {
  /* 怎么变红:让 `applyItemCountDelta` 少记一件(或让重算读 itemCounts 之外的源)
     ⇒ 下面的等式立刻不成立。 */
  const a = makeRoom('r115_3');
  const rt = a.runtime;

  seed(rt, 'p1', 103, 3);
  seed(rt, 'p1', 126, 2);
  rt.grantItemSource('p1', 'spend115');
  const spend = rt.applyInventory('p1', { ops: [{ itemId: 103, delta: -1, source: 'spend115' }] });
  ok(spend.allowed, '前置:消耗一件应放行');

  const total = rt.authoritativeItemTotal('p1');
  const detailSum = rt.authoritativeItemCount('p1', 103) + rt.authoritativeItemCount('p1', 126);
  eq(total, 4, '总量 = 3 + 2 - 1');
  eq(detailSum, total, '★ 两处账同源:总量 == Σ按件账');
  eq(rt.lastInventoryProjection?.total, total, '★ 上一次重算读的就是这份明细');
  eq(rt.authoritativeItemIds('p1'), [103, 126], '按件账的键集仍是那条配方用到的两件');

  /* 幂等:没有新变更 ⇒ false,但 source 仍是 'room'(证明它**又读了一次明细**,
     而不是「上次算过就再也不读」)。 */
  eq(rt.projectInventoryTotalFor('p1'), false, '无变更 ⇒ false');
  eq(rt.lastInventoryProjection?.changed, false, 'changed 如实为 false');
  eq(rt.lastInventoryProjection?.source, 'room', '但明细来源仍是房间账(重算是每次真读)');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND115-4 ★★ 宿主有明细时以宿主为准;撤掉后总量**弹回**房间账(注入验证)', () => {
  /* 怎么变红:把 `inventoryDetailSource` 的宿主分支删掉 ⇒ 第一次重算会是 1 而不是 5;
     把「撤掉后重算」那段删掉(或改成增量记账)⇒ 第二次会停在 5 而不是弹回 1。
     ★ 后半段是**增量式账本做不到**的事:它只会停在 5 ⇒ 这条直接区分两种实现。 */
  const a = makeRoom('r115_4');
  const rt = a.runtime;
  seed(rt, 'p1', 103, 1);
  eq(rt.authoritativeItemTotal('p1'), 1, '前提:房间账 1 件');

  rt.worldSaveHost = withDetail(a.host, [{ quantity: 5 }]);
  eq(rt.projectInventoryTotalFor('p1'), true, '注入:宿主明细 5 件 ⇒ 总量发生变更');
  eq(rt.lastInventoryProjection?.source, 'host', '★ 宿主给了明细 ⇒ 以宿主为准');
  eq(rt.authoritativeItemTotal('p1'), 5, '总量被宿主明细重算成 5');

  rt.worldSaveHost = withDetail(a.host, null);
  eq(rt.projectInventoryTotalFor('p1'), true, '撤掉宿主明细 ⇒ 再重算一次(5 → 1)');
  eq(rt.lastInventoryProjection?.source, 'room', '回退到房间按件账');
  eq(rt.authoritativeItemTotal('p1'), 1,
    '★★ 弹回 1:增量式会把 5 留着永不自愈 —— 这条就是「重算」存在与否的分界');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND115-5 ★ 回执 effect 契约允许嵌套,两个写者不再有 `as unknown as` 绕过', () => {
  /* 怎么变红:
     (a) 把 `EffectRecord` 收窄回 `Record<string, string|number|boolean>`
         ⇒ 本文件 tsc 红(这份常量装不进去);
     (b) 把 craft.ts 的逐件账摊平成标量 ⇒ 下面的 `consumed` 深比较红;
     (c) 把 `as unknown as` 写回去 ⇒ 源码扫描红。 */
  const nested: EffectRecord = {
    itemId: 245,
    consumed: { 103: 1, 126: 1 },
    certificate: { first: true, discovererName: 'p1' },
    gallery: [{ itemName: 'x', craftCount: 1 }],
    note: null,
  };
  eq(nested.consumed, { 103: 1, 126: 1 }, '嵌套对象可以进 effect(类型 + 运行都成立)');
  ok(Array.isArray(nested.gallery), '数组可以进 effect');
  eq(nested.note, null, '`null` 允许(值域里刻意不留 `undefined`)');
  ok(!Array.isArray(nested.consumed), '逐件账是**对象**而不是「摊平成数组」');

  /* 生产路径:走真装配的 CRAFT,回执里的逐件账必须还在(不是只在类型里允许)。 */
  const a = makeRoom('r115_5');
  const rt = a.runtime;
  seed(rt, 'p1', 112, 2);
  seed(rt, 'p1', 101, 1);
  const out: ActionOutcome = rt.dispatchAction('p1', RoomAction.CRAFT, { itemId: 155 });
  eq(out.kind, 'OK', `前置:#155 黄铜金属锭应能合成(实测 reason=${out.reason ?? '-'})`);
  const eff = out.effect;
  ok(eff !== undefined, '`OK` 必须带 effect');
  eq(eff?.consumed, { 112: 2, 101: 1 }, '★ 回执里的逐件账 = 真的被扣的那几件');
  eq(eff?.produced, 1, '`produced` 仍是标量(只有嵌套项被放宽)');

  /* 源码侧:两处绕过必须消失,且检查器**抓得到**旧写法(负对照)。 */
  const hasBypass = (s: string): boolean => s.includes('as unknown as EffectRecord');
  ok(!hasBypass(craftCode), 'craft.ts 不再有 `as unknown as EffectRecord`(只扫**代码**,不扫 docblock)');
  ok(!hasBypass(alchemyCode), 'use_alchemy_furnace.ts 不再有 `as unknown as EffectRecord`');
  eq(hasBypass('const e = { a: 1 } as unknown as EffectRecord;'), true,
    '负对照:检查器抓得到旧写法(不是恒假)');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND115-6 ★ ActionPayload 补进了 7 个动作的消费键(修前各自补交叉类型)', () => {
  /* 怎么变红:从 ActionPayload 删掉任一键 ⇒ 对应判据红;把键只写进**注释**
     ⇒ 行首锚点的判据仍然红(见负对照 2)。 */
  const body = interfaceBody(roomSrc, 'ActionPayload');
  ok(body.length > 0, '能找到 ActionPayload 接口正文');

  const keys = [
    'dir', 'color', 'channel', 'clear',            /* WIRE_EDIT */
    'op', 'petId', 'mobId', 'mateId',             /* BREED_TAME */
    'radius', 'name', 'totemCell',                /* MODIFY_TOWN */
    'seed', 'confirm',                            /* RESET_WORLD */
    'qty', 'orderId',                             /* BUY_ITEM / ALCHEMY_LAB */
    'kind',                                       /* PLACE_AUTOMATION */
  ];
  for (const k of keys) {
    ok(new RegExp(`^  ${k}\\?:`, 'm').test(body), `ActionPayload 应声明 \`${k}?\``);
  }
  /* 负对照 1:编造的键扫不到。 */
  ok(!/^  zzzNotAKey\?:/m.test(body), '负对照:不存在的键扫不到');
  /* 负对照 2:注释里的键名**不算**声明(判据用的是行首 `  key?:`)。 */
  ok(!/^  (dir|radius)\?:/m.test('   * dir / radius 只出现在注释里'), '负对照:注释不算声明');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND115-7 ★★ partyMode 单一存储:唯一写者是 state.meta.partyMode(注入验证)', () => {
  /* 怎么变红:把 `get partyMode()` 改回 `partyMode: PartyMode = PartyMode.NONE` 字段
     ⇒ 第三段注入(直接改快照)之后 `rt.partyMode` 会**停在旧值** ⇒ 红。 */
  const a = makeRoom('r115_7');
  const rt = a.runtime;
  const idx = (m: PartyMode): number => Object.values(PartyMode).indexOf(m);

  eq(rt.partyMode, PartyMode.NONE, '初始 = NONE');
  const r = rt.dispatchAction('p1', RoomAction.SET_PARTY_MODE, { partyMode: PartyMode.PAINT_WAR });
  eq(r.kind, 'OK', `SET_PARTY_MODE 应成功(实测 reason=${r.reason ?? '-'})`);
  eq(rt.state.meta.partyMode, idx(PartyMode.PAINT_WAR), '线快照被写成枚举下标');
  eq(rt.partyMode, PartyMode.PAINT_WAR, '访问器解码同一份存储');

  /* ★ 注入:直接改**唯一存储** ⇒ 访问器必须跟着变。
     修前它是并列字段(两份状态),这里会停在 PAINT_WAR ⇒ 两处维护的直接证据。 */
  rt.state.meta.partyMode = idx(PartyMode.CROWN_BR);
  eq(rt.partyMode, PartyMode.CROWN_BR, '★★ 跟随快照(证明它是解码读法,不是第二份状态)');

  rt.state.meta.partyMode = 99;
  eq(rt.partyMode, PartyMode.NONE, '越界下标(坏快照)⇒ NONE,不返回 undefined');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND115-8 ★ hostPositionOf 声明带 z(修前 {x,y} 把权威 z 静默丢掉)', () => {
  /* 怎么变红:把 `ActionContext.hostPositionOf` 的声明改回 `{ x: number; y: number }`
     ⇒ 下面 `zOf` 那句 `?.z` 在 tsc 上红,且源码判据也红。 */
  ok(/hostPositionOf\(userId: string\): \{ x: number; y: number; z\?: number \} \| null/.test(ctxSrc),
    '`ActionContext.hostPositionOf` 声明了 `z?: number`');
  ok(!/hostPositionOf\(userId: string\): \{ x: number; y: number \} \| null/.test(ctxSrc),
    '负对照:旧的 `{ x, y }` 声明已不存在');

  /* 运行侧:权威位置**真的**带 z ⇒ 声明只写 x/y 就是丢数据,不是「用不到」。 */
  const a = makeRoom('r115_8');
  const pose = a.host.playerPosition?.('p1');
  ok(pose !== undefined && pose !== null, '生产宿主的 `playerPosition` 有值');
  eq(typeof pose?.z, 'number', '★ 权威位置带有 z(声明不带 z 就等于静默丢弃)');

  /* 类型侧:这一行能编译,就说明 ctx 的读口带 z(旧声明下 `?.z` 是 tsc 错误)。 */
  const zOf = (ctx: ActionContext): number | undefined => ctx.hostPositionOf('p1')?.z;
  ok(typeof zOf === 'function', '类型侧:`ctx.hostPositionOf(...)?.z` 可编译(旧声明下红)');
});

/* ───────────────────────── 9 ───────────────────────── */

test('FND115-9 ★ 消费方不再靠局部窄类型读宿主(声明补齐的直接后果)', () => {
  /* 怎么变红:把 `AlchemyLabReadPort` 或 `WorldSaveHost & { inventoryDetailOf... }`
     写回去 ⇒ 源码判据红;把 `lastRoomEffects` 从 WorldSaveHost 删掉 ⇒
     use_alchemy_furnace 的 `ctx.host.lastRoomEffects` 在 tsc 上红。 */
  ok(!alchemyCode.includes('AlchemyLabReadPort'),
    'use_alchemy_furnace 不再有局部窄类型 `AlchemyLabReadPort`');
  ok(!roomCode.includes('WorldSaveHost & { inventoryDetailOf'),
    'room.ts 不再用交叉类型读 `inventoryDetailOf`');
  ok(!roomCode.includes('WorldSaveHost & { maxHpForLevel'),
    'room.ts 不再用交叉类型读 `maxHpForLevel` / `syncMaxHp`');
  /* 负对照:检查器抓得到旧写法。 */
  eq('type X = AlchemyLabReadPort;'.includes('AlchemyLabReadPort'), true,
    '负对照:检查器抓得到旧写法(不是恒假)');

  /* 行为侧:慢帧之后 `lastRoomEffects` 真的带 `roomKey` 那一维(声明不是编的)。 */
  const a = makeRoom('r115_9');
  a.host.advance?.(60);
  const rows = a.host.lastRoomEffects;
  ok(Array.isArray(rows) && rows.length > 0, '慢帧后 `lastRoomEffects` 非空');
  const mine = rows?.find((x) => x.playerId === 'p1');
  ok(mine !== undefined, '★ 能在里面找到 p1 的那一行(站位判定的输入真的存在)');
  ok(Object.prototype.hasOwnProperty.call(mine ?? {}, 'roomKey'),
    '每一行都带 `roomKey`(use_alchemy_furnace 读的那一维)');
});

report('WS-FND-115');