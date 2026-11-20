/**
 * WS-FND-55 —— **D-11:高级锻造闸**(`forgeUnlocked` 的消费点)。
 *
 * ## 补的是哪一条
 *
 * `server/src/rooms/effects.ts` 的 `RoomEffectResult.forgeUnlocked`(= 玩家站在
 * `FORGE_MASTER` 房间里)此前**没有任何消费点**:房间里解锁了,合成路径却不知道。
 * 裁决原文(`docs/DECISIONS.md` **D-11**):
 *
 * ``` » 解锁 = 能用 **505 工作台出产的配方**(不新增 tier 字段、不动冻结内容表) «
 * ```
 *
 * 本套件钉的是**动作层**那一半(`server/src/net/actions/craft.ts`):
 * 配方 `station === 505` **且**该玩家未解锁 ⇒ `PERMISSION` 且**一件材料都不扣**。
 *
 * ## 事实从宿主读,不在这里重算
 *
 * 动作层只问宿主一条**可选**读口 `host.forgeUnlockedOf?(actorId: string): boolean`
 * (世界侧把 `roomEffects` 的 `forgeUnlocked` 投影成它)。房间/动作层**不许**自己猜
 * "这人在哪个房间" —— 那是第二份房间判定。
 *
 * ⇒ 判据用**可控替身**装这条读口(`withForge`),不依赖世界侧今天的形态;
 *   而「宿主**没有**这条读口」那种形态(`hideForge`)必须回 `NOT_IMPLEMENTED`
 *   (与 `material.ts` 的 `materialsOf()` / `reset_world.ts` 同契约),
 *   **不许**默认放行 —— 默认放行等于裁决没落地。
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 505 配方 + **未解锁** ⇒ `PERMISSION`,材料一件没扣 | 去掉闸 / 把闸写成静默成功 / 闸放在扣减之后 |
 * | 2 | 505 配方 + **已解锁** ⇒ `OK` 且产出、材料照扣 | 闸判反 / 永远拒 |
 * | 3 | **非 505** 配方 + 未解锁 ⇒ 照常 `OK`(负对照) | 把闸写成"所有配方都要解锁" |
 * | 4 | 宿主**没有**读口 ⇒ `NOT_IMPLEMENTED`(显式),且非 505 仍照常 | 缺能力时默认放行 / 当成"锁着" |
 * | 5 | 越权(GUEST)仍**先**被拦(理由不是锻造那条) | 新闸抢到权限闸前面 |
 * | 6 | 报文非法仍**先**被拦(`INVALID`,理由不是锻造那条) | 报文校验被挪到闸之后 |
 *
 * ## ⚠️ 断言右侧一律用**字面量**
 *
 * `318`(station 505 的"高弹果冻蹦床砖")/ `162` / `151`(station 502)/ `101` /
 * `505` 全部取自**冻结内容表**,不取被测模块的导出常量 —— 否则就是同义反复
 * (门禁 `--strict-taut`)。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome } from '../server/src/net/room.ts';

/** 一次合成的回执摘要(`effect` 的声明值类型只有基本类型 ⇒ 这里显式窄化读明细)。 */
type CraftEffect = { itemId: number; produced: number; consumed: Record<number, number> };

type Assembled = ReturnType<typeof assemble>;
type Runtime = Assembled['runtime'];

/** 505 工作台出产的合法配方(内容表:`recipe: { 162: 2 }, station: 505`)。 */
const FORGE_PRODUCT = 318;
/** 上面那条配方的材料(2 件)。 */
const GLUE = 162;
/** **非** 505 的对照配方(内容表:`recipe: { 101: 1 }, output: 2, station: 502`)。 */
const CARPENTRY_PRODUCT = 151;
/** 对照配方的材料(1 件)。 */
const LOG = 101;

let seq = 0;

interface Scene {
  /** 装配产物:`host` 就是房间看到的那个宿主(读口要装在它上面)。 */
  a: Assembled;
  rt: Runtime;
}

/**
 * 真装配(`assemble()`,不手搓 `rtOpts`),玩家 `p1` 已入房。
 * `asGuest` 只用于"越权仍先被拦"那条(判据 5)。
 */
function scene(opts: { asGuest?: boolean } = {}): Scene {
  seq += 1;
  const a = assemble({
    roomId: `r_forge_${seq}`,
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    /* 本套件只测合成闸,不想让自发改刷的怪参与(它们会让失败信息难以归因)。 */
    mobs: false,
    rng: mulberry32(seq * 7 + 1),
  });
  a.runtime.join({ userId: 'p1', asGuest: opts.asGuest === true });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const id of a.runtime.authoritativeItemIds('p1')) a.runtime.applyInventory('p1', { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount('p1', id) }] });
  return { a, rt: a.runtime };
}

/**
 * 给宿主装上 D-11 读口(`host.forgeUnlockedOf?(actorId): boolean`)。
 *
 * 生产形态由世界侧实现(把 `roomEffects.forgeUnlocked` 投影出来);判据里换成**固定答案**,
 * 这样"已解锁 / 未解锁"两支都可控,也不会因为世界侧接线进度不同而时红时绿。
 */
function withForge(host: unknown, unlocked: boolean): void {
  (host as { forgeUnlockedOf?: (actorId: string) => boolean }).forgeUnlockedOf = () => unlocked;
}

/**
 * 造「宿主**没有**这条能力」的形态:运行期把这一个方法遮成 `undefined`,其余成员照常转发。
 *
 * ⚠️ 为什么用 `Proxy` 而不是 `delete` 实例属性:世界侧会把它实现成**原型**上的方法,
 *   实例上的 `delete` 删不掉原型成员 ⇒ 判据 4 会退化成"永远绿"。
 */
function hideForge(rt: Runtime): void {
  const real = rt.worldSaveHost as unknown as Record<string, unknown>;
  const masked = new Proxy(real, {
    get(target, key) {
      if (key === 'forgeUnlockedOf') return undefined;
      return Reflect.get(target, key, target);
    },
  });
  (rt as unknown as { worldSaveHost: unknown }).worldSaveHost = masked;
}

/** 塞材料进背包 —— 走**生产同一条路**(先 `grantItemSource` 再 `applyInventory`)。 */
function seed(rt: Runtime, itemId: number, n: number): void {
  const src = `seed:${itemId}:${n}`;
  rt.grantItemSource('p1', src);
  const r = rt.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `测试前置:应能塞进 ${n} 件 ${itemId}(被拒说明容量/守恒层先坏了)`);
}

/** 权威总量(房间的方法,不是宿主 —— 宿主没有这个读数)。 */
const total = (rt: Runtime): number => rt.authoritativeItemTotal('p1');

const disp = (rt: Runtime, payload: Record<string, unknown>): ActionOutcome =>
  rt.dispatchAction('p1', RoomAction.CRAFT, payload);

const why = (r: ActionOutcome): string => String(r.reason ?? '');

/** 取出成功回执的 `effect`;顺手钉住「OK 必须带 effect」。 */
function effectOf(r: ActionOutcome, label: string): CraftEffect {
  ok(r.ok, `${label}:应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', `${label}:成功路径必须是 OK`);
  const e = r.effect as unknown as CraftEffect | undefined;
  ok(e !== undefined, `${label}:★ \`OK\` 必须带 effect(不留"回 OK 却无副作用")`);
  return e as CraftEffect;
}

/* ═════════════ 1 505 配方 + 未解锁 ⇒ 显式拒绝,材料一件不扣 ═════════════ */

test('FND55-1 ★ 505 配方 + 未解锁 ⇒ PERMISSION,且**一件材料都不扣**', () => {
  const s = scene();
  withForge(s.a.host, false);
  seed(s.rt, GLUE, 2);
  eq(total(s.rt), 2, '前置:背包里 2 件 162(正好是 318 的配方需求)');

  const out = disp(s.rt, { itemId: FORGE_PRODUCT, have: { [GLUE]: 2 } });

  eq(out.ok, false, '未解锁时 505 配方不能合成');
  eq(out.kind, 'PERMISSION',
    '★ 未解锁是**能力**不足 ⇒ PERMISSION(不是 INVALID,更不是静默成功)');
  ok(why(out).includes('未解锁高级锻造'),
    `理由要点明"未解锁高级锻造"(实测:${why(out)})`);
  ok(out.effect === undefined, '被拒时没有 effect(也就没有 produced)');
  eq(total(s.rt), 2, '★★ 材料一件都没扣 —— 闸必须在扣减之前');
});

/* ═════════════ 2 505 配方 + 已解锁 ⇒ 正常出产 ═════════════ */

test('FND55-2 ★ 505 配方 + 已解锁 ⇒ OK:材料 -2、产物 +1(两侧都走权威路径)', () => {
  const s = scene();
  withForge(s.a.host, true);
  seed(s.rt, GLUE, 2);
  eq(total(s.rt), 2, '前置:背包里 2 件 162');

  const eff = effectOf(
    disp(s.rt, { itemId: FORGE_PRODUCT, have: { [GLUE]: 2 } }),
    '#318(505 配方,已解锁)',
  );

  eq(eff.itemId, 318, 'effect 里带产物 id');
  eq(eff.produced, 1, '318 没有 output ⇒ 默认 1 件');
  eq(eff.consumed, { 162: 2 }, '★ effect 里能看到扣了哪几件');
  eq(total(s.rt), 1, '★ 两侧都对:2 件材料 -2、蹦床砖 +1 ⇒ 总量 1');
});

/* ═════════════ 3 负对照:非 505 配方不受影响 ═════════════ */

test('FND55-3 负对照:**非 505** 配方 + 未解锁 ⇒ 照常 OK(零回归)', () => {
  const s = scene();
  withForge(s.a.host, false);
  seed(s.rt, LOG, 1);
  eq(total(s.rt), 1, '前置:背包里 1 件 101');

  const eff = effectOf(
    disp(s.rt, { itemId: CARPENTRY_PRODUCT, have: { [LOG]: 1 } }),
    '#151(502 木工台,未解锁)',
  );

  eq(eff.itemId, 151, '产物是精刨松木板');
  eq(eff.produced, 2, '★ `output: 2` 照旧生效(闸没碰非 505 那条路)');
  eq(total(s.rt), 2, '1 件原木 -1、木板 +2 ⇒ 总量 2');
});

/* ═════════════ 4 宿主没有这条能力 ⇒ 显式 NOT_IMPLEMENTED ═════════════ */

test('FND55-4 ★ 宿主**没有** `forgeUnlockedOf` ⇒ NOT_IMPLEMENTED(不许默认放行)', () => {
  const s = scene();
  hideForge(s.rt);
  seed(s.rt, GLUE, 2);
  seed(s.rt, LOG, 1);
  eq(total(s.rt), 3, '前置:162×2 + 101×1');

  const out = disp(s.rt, { itemId: FORGE_PRODUCT, have: { [GLUE]: 2 } });

  eq(out.ok, false, '能力缺失时不能"装作解锁了"');
  eq(out.kind, 'NOT_IMPLEMENTED',
    '★ 缺能力必须**显式**回执(与 material.ts / reset_world.ts 同契约),不是 PERMISSION');
  ok(why(out).includes('forgeUnlockedOf'),
    `理由要指认缺的是哪条读口(实测:${why(out)})`);
  ok(out.effect === undefined, '被拒时没有 effect');
  eq(total(s.rt), 3, '★ 材料一件都没扣');

  /* 同一张图、同一次缺能力:**非 505** 配方照常走(缺能力只影响 505 那条路)。 */
  const wood = disp(s.rt, { itemId: CARPENTRY_PRODUCT, have: { [LOG]: 1 } });
  eq(wood.ok, true, `非 505 配方不该被这条能力影响(实测 kind=${wood.kind} reason=${why(wood)})`);
  eq(total(s.rt), 4, '101 -1、151 +2 ⇒ 3 + 1 = 4');
});

/* ═════════════ 5 越权仍先被拦(新闸不抢顺序) ═════════════ */

test('FND55-5 ★ 越权(GUEST)+ 已解锁 + 505 配方 ⇒ 仍是权限闸那条(不是锻造闸)', () => {
  const s = scene({ asGuest: true });
  withForge(s.a.host, true);
  seed(s.rt, GLUE, 2);
  eq(total(s.rt), 2, '前置:GUEST 背包里**真的**有齐料(否则测的就不是权限)');

  const out = disp(s.rt, { itemId: FORGE_PRODUCT, have: { [GLUE]: 2 } });

  eq(out.ok, false, 'GUEST 不能合成');
  eq(out.kind, 'PERMISSION', '越权应是 PERMISSION');
  ok(why(out).includes('无权'), `理由应是权限闸那条(实测:${why(out)})`);
  ok(!why(out).includes('未解锁高级锻造'),
    '★ 新闸没有抢在权限闸前面(否则越权会被误报成"未解锁")');
  eq(total(s.rt), 2, '被拒后背包一点没动');
});

/* ═════════════ 6 报文非法仍先被拦 ═════════════ */

test('FND55-6 ★ 报文非法 + 505 配方 ⇒ 仍先 INVALID(顺序不因新闸改变)', () => {
  const s = scene();
  withForge(s.a.host, true);
  seed(s.rt, GLUE, 2);


  /* `itemId` 不是整数。 */
  const badId = disp(s.rt, { itemId: 318.5, have: { [GLUE]: 2 } });
  eq(badId.ok, false, '非整数 itemId 不能合成');
  eq(badId.kind, 'INVALID', '报文形状不对是 INVALID');
  ok(!why(badId).includes('未解锁高级锻造'), '★ 同上');

  eq(total(s.rt), 2, '★ 两次非法报文都没动背包');
});

report('WS-FND-55');