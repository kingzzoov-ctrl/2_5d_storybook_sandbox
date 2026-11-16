/**
 * WS-FND-34 —— **`RESET_WORLD`(世界重置)的动作层**。
 *
 * ## 这个套件为什么存在,以及它**不**声称什么
 *
 * `RESET_WORLD` 是 22 个动作里唯一一个「全仓没有任何落地点」的
 * (`docs/TASK-94-action-layer-landing-plan.md:109`)。落点裁决与逐行证据在
 * `docs/TASK-97-world-reset-ruling.md`:世界**不属于**编排层,它由装配层造好、
 * 以 `WorldSaveHost` 交进来 ⇒ 重置只能是**宿主能力**。
 *
 * ⚠️ 本套件断言的是**动作层那一半**:权限 / 显式确认 / 种子校验 / **能力缺失** /
 *   回执。宿主那一半(`WorldSim.resetWorld`)**今天不存在** —— 第 4 条把这个事实
 *   本身也钉住了(`typeof host.resetWorld === 'undefined'`),
 *   所以任何"重置已经能用了"的说法都会先在这里红。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 有能力 + 确认 + 合法种子 ⇒ `OK` + `effect.seed` + **宿主真的被调了** | 回 OK 却不调宿主(假成功) |
 * | 2 | 缺 `confirm` ⇒ `INVALID` 且**宿主零调用** | 去掉确认闸(破坏性动作变"少写字段就执行") |
 * | 3 | 种子非法(缺 / 小数 / NaN / 字符串 / Infinity)⇒ `INVALID` 且零调用 | 只判 `typeof number` 不判有限整数 / 拿默认值兜底 |
 * | 4 | **真宿主没有这个能力** ⇒ `NOT_IMPLEMENTED` + 理由说清"不支持" | 能力缺失时回静默 OK |
 * | 5 | 越权(GUEST)⇒ `PERMISSION` 且宿主零调用 | 权限闸写在参数校验之后 |
 * | 6 | 宿主 `applied: false` ⇒ `NOT_IMPLEMENTED` + **转述宿主理由** + 无 `effect` | 把"没生效"当成功 |
 *
 * ## 用**真装配**,只给宿主**临时挂上**能力
 *
 * `assemble()` 造出运行时与宿主(`index.ts:241/264`),动作走 `rt.dispatchAction`。
 * 第 1/2/3/5/6 条把 `resetWorld` 挂到**真宿主**上,只为证明动作层的能力分支;
 * 第 4 条**不挂**,那正是今天生产的形态。挂载是**测试专用**的:生产宿主没有它。
 *
 * ⚠️ 断言右侧一律用**字面量**(种子用 `4242` 这类具体数),不取被测模块的导出常量
 * —— 否则就是同义反复(门禁 `--strict-taut`)。
 */
import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';

/** 宿主上挂的那个假能力(测试专用)。 */
type ResetFn = (o: { seed: number }) => { applied: boolean; seed: number; reason?: string };

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  host: ReturnType<typeof assemble>['host'];
  roomId: string;
};

let roomSeq = 0;

/**
 * 建一个**真装配**的房间。`p1` 按 `role` 入座(`OWNER` ⇒ 它带 `destructive` 位)。
 * 给了 `reset` 就把能力**临时挂到真宿主上**;不给 ⇒ 保持生产形态(无能力)。
 */
function makeRoom(role: 'OWNER' | 'GUEST', reset?: ResetFn): Room {
  roomSeq += 1;
  const roomId = `r_reset${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: role === 'OWNER' ? 'p1' : 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    /* 本套件测的是重置的动作层,不想让自发改刷的怪参与(它们会变成第三个"东西",
       让失败信息难以归因)。 */
    mobs: false,
    rng: mulberry32(13),
  });
  a.runtime.join({ userId: 'p1', asGuest: role === 'GUEST' });
  if (reset !== undefined) {
    (a.host as unknown as { resetWorld?: ResetFn }).resetWorld = reset;
  }
  return { rt: a.runtime, host: a.host, roomId };
}

/** 派一次 `RESET_WORLD`。 */
const disp = (rt: Room['rt'], payload: Record<string, unknown>) =>
  rt.dispatchAction('p1', RoomAction.RESET_WORLD, payload);

/** 取 `effect`(`ActionOutcome['effect']` 是标量表)。 */
const eff = (r: { effect?: Record<string, string | number | boolean> }) =>
  r.effect as Record<string, string | number | boolean>;

/* ───────────────────────── 判据 ───────────────────────── */

test('FND34-1 宿主有能力 + 显式确认 + 合法种子 ⇒ OK,且宿主**真的被调过**', () => {
  const seen: { seed: number }[] = [];
  const r = makeRoom('OWNER', (o) => {
    seen.push(o);
    return { applied: true, seed: o.seed };
  });

  const out = disp(r.rt, { confirm: true, seed: 4242 });

  eq(out.ok, true, `应成功(kind=${out.kind} reason=${out.reason ?? '-'})`);
  eq(out.kind, 'OK', '应是 OK');
  eq(eff(out).seed, 4242, 'effect 里应带**实际生效**的种子');
  eq(seen.length, 1, '★ 宿主必须恰好被调用一次 —— 否则"成功"是假成功');
  eq(seen[0].seed, 4242, '宿主收到的种子应与报文一致');
});

test('FND34-2 缺 confirm ⇒ INVALID,且宿主**一次都没被调**', () => {
  const seen: { seed: number }[] = [];
  const r = makeRoom('OWNER', (o) => {
    seen.push(o);
    return { applied: true, seed: o.seed };
  });

  const out = disp(r.rt, { seed: 7 });

  eq(out.ok, false, '破坏性动作没确认就不能执行');
  eq(out.kind, 'INVALID', '应是 INVALID(不是 NOT_IMPLEMENTED —— 能力在,是报文不对)');
  eq(seen.length, 0, '★ 没确认就不许调用宿主');
});

test('FND34-3 种子非法(缺 / 小数 / NaN / 字符串 / Infinity)⇒ INVALID 且零调用', () => {
  const seen: { seed: number }[] = [];
  const r = makeRoom('OWNER', (o) => {
    seen.push(o);
    return { applied: true, seed: o.seed };
  });

  const bad: Record<string, unknown>[] = [
    { confirm: true },
    { confirm: true, seed: 1.5 },
    { confirm: true, seed: Number.NaN },
    { confirm: true, seed: '7' },
    { confirm: true, seed: Number.POSITIVE_INFINITY },
    { confirm: true, seed: null },
  ];
  for (const payload of bad) {
    const out = disp(r.rt, payload);
    eq(out.ok, false, `载荷 ${JSON.stringify(payload)} 必须被拒`);
    eq(out.kind, 'INVALID', `载荷 ${JSON.stringify(payload)} 应是 INVALID(kind=${out.kind})`);
  }
  eq(seen.length, 0, '★ 六种非法载荷之后宿主仍然是零调用');
});

test('FND34-4 **真宿主**没有这个能力(今天生产的形态)⇒ NOT_IMPLEMENTED + 理由说清', () => {
  const r = makeRoom('OWNER'); /* 不挂能力 */

  /* 先把"今天确实没有"这个事实钉住 —— 将来宿主实现了它,这里会先红。 */
  eq(
    typeof (r.host as unknown as { resetWorld?: unknown }).resetWorld,
    'undefined',
    '今天的世界宿主没有 resetWorld(如实边界)',
  );

  const out = disp(r.rt, { confirm: true, seed: 99 });

  eq(out.ok, false, '能力缺失就不许成功');
  eq(out.kind, 'NOT_IMPLEMENTED', '应是 NOT_IMPLEMENTED(显式,不静默)');
  ok(
    typeof out.reason === 'string' && out.reason.includes('不支持'),
    `理由必须说清是"宿主不支持"(实得:${out.reason ?? '(无)'})`,
  );
  eq(out.effect, undefined, '没生效就没有 effect');
});

test('FND34-5 越权(GUEST)⇒ PERMISSION,且宿主零调用', () => {
  const seen: { seed: number }[] = [];
  const r = makeRoom('GUEST', (o) => {
    seen.push(o);
    return { applied: true, seed: o.seed };
  });

  const out = disp(r.rt, { confirm: true, seed: 4242 });

  eq(out.ok, false, 'GUEST 不许重置世界');
  eq(out.kind, 'PERMISSION', `应是 PERMISSION(kind=${out.kind} reason=${out.reason ?? '-'})`);
  eq(seen.length, 0, '★ 越权时宿主不许被调用(闸在第一行)');
});

test('FND34-6 宿主 applied:false ⇒ NOT_IMPLEMENTED + 转述宿主理由 + 无 effect', () => {
  const r = makeRoom('OWNER', () => ({ applied: false, seed: 0, reason: '世界正在结算中' }));

  const out = disp(r.rt, { confirm: true, seed: 5 });

  eq(out.ok, false, '"能力在、这次没成"不是成功');
  eq(out.kind, 'NOT_IMPLEMENTED', '应是 NOT_IMPLEMENTED');
  ok(
    typeof out.reason === 'string' && out.reason.includes('世界正在结算中'),
    `必须转述宿主给的理由(实得:${out.reason ?? '(无)'})`,
  );
  eq(out.effect, undefined, '没生效就没有 effect');
});

report('WS-FND-34');
