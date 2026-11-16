/**
 * `MODIFY_TOWN` —— **城镇改造**:一份 per-room 的权威配置 + 「谁有权改」的裁决。
 *
 * ## ⚠️ 先说不做什么:今天**没有任何世界侧读者**
 *
 * 本动作只把一次改造**登记成可查的事实**(谁 / 何时 / 把哪个房间的城镇改成了什么)。
 * 它**没有**改变刷怪,也**没有**改变安全区护盾的实际半径 —— 那两件事的唯一事实源
 * 仍然是 `mobs/spawner.ts`,本模块一个字节都没动它:
 * ```ts
 *   TOWN_SAFE_RADIUS = 24                      // spawner.ts:28,常量(本模块的默认值取自它)
 *   isInsideSafeRadius(x, y, cx, cy, radius)   // spawner.ts:138,半径默认取上面那一个
 *   inSafeZone(world, x, y) / decideSpawn(...) // 刷怪路径的判定入口
 * ```
 * ⇒ `MODIFY_TOWN` 回 `OK` **不等于**「安全区已经按新半径工作了」。要让世界侧真的消费
 *   本配置,得改 `spawner.ts` / `world_sim.ts`(本次范围之外),而且**必须**把半径作为
 *   参数接进 `isInsideSafeRadius` —— 再写一份判定就是 `bosses/raid.ts:92` 明确拒绝过的
 *   **双标准**。
 *
 * ⇒ 诚实说法:**「登记 + 可查」已接线;「改了就生效」没有。**
 *   `docs/TASK-96-action-landing-gaps.md:81` 那一行写的是「无城镇安全区 / 图腾实体,
 *   也无『谁有权改』的裁决」。本模块补的是**最后一段**(裁决 + 可查记录);
 *   前两段(安全区实体、图腾实体)仍是缺口。
 *
 * ## ★ 世界侧的**读口**已存在(接线待主线一行)
 *
 * `mobs/spawner.ts` 现在导出 `setTownRadiusProvider` / `townSafeRadiusFor`(半径可注入:
 * 未装 provider ⇒ 仍是默认 `TOWN_SAFE_RADIUS` = 24;非法 / 抛错同样退回 24),本模块对应
 * 导出**只读**适配器 `townSafeRadiusProvider`(见本文件「适配器」一节)。
 * ⇒ 缺的只剩**世界侧那一行**:`world_sim.ts` 的 `spawnWorld()` 返回对象里带上
 * `roomId: () => <本房间号>`,并在装配期 `setTownRadiusProvider(townSafeRadiusProvider)`。
 * 在这两处接上**之前**,上面那句「改了就生效没有」仍然成立。
 *
 * ## 为什么状态放在本模块的 per-room Map(而不是 `RoomState`)
 *
 * 与 `actions/sleep.ts` 同一条理由:`ActionContext` 只有一次分派的入参与宿主能力,
 * 没有可写的世界侧状态;而「城镇配置」既不是 `RoomRuntime` 的房间状态,也不是
 * `vitals` 的字段。放进模块内的 `Map<roomId, TownConfig>` 有两个直接好处:
 *   1 `roomId` 分桶 ⇒ 两个房间的配置不会互相串;
 *   2 显式读回函数(`townConfigOf`)可被**未来的**世界侧消费,不需要把 `RoomRuntime`
 *     或 `WorldSim` 交进动作层。
 *
 * ⚠️ 与 `sleep` 一样**不持久化**:进程内 Map,房间重建即回出厂值。要持久化得动存档层
 *   (`host.saveToDb` 那一侧),本次范围之外 ⇒ 本文件**不声称**"改造会留下来"。
 *
 * ## 权限位
 *
 * `MODIFY_TOWN: 'town'`(`net/room.ts:191` 的 `ACTION_PERMISSION`)。`town` 位只有
 * OWNER / ADMIN 带(`PERMISSION_MATRIX`,`net/room.ts:156`)⇒ MEMBER 与 GUEST 都在
 * `authorize` 这一步被拦。本模块**不写第二份角色表**:闸就是 `ctx.authorize`
 * (= `RoomRuntime.authorize`),越权时连当前配置都不读。
 *
 * ## 半径的上下界为什么是 6 与 32
 *
 * 下界 `MIN_TOWN_RADIUS = 6`:路灯的抑制半径是 5 格(`STREET_LAMP_RADIUS`,
 *   spawner.ts:23)⇒ 安全区若 ≤ 5 格,它比「灯已经盖住的圈」还小,改它**不可观察**。
 *   取 6 = 5 + 1:「比已有的抑制范围至少大一圈」。
 * 上界 `MAX_TOWN_RADIUS = 32`:`WorldSim` 的**默认**世界是 64 格宽
 *   (`world_sim.ts:897` 的 `opts.sizeCells ?? 64`),城镇中心是它的半边
 *   (`world_sim.ts:4108` 的 `townCenter = sizeCells / 2`)⇒ 半径超过 32 会让「安全区」
 *   盖住中心到边界的整条路,再大也没有可观察的差别。
 *   ⚠️ 动作层拿不到**本房间**的世界尺寸(见下「没有裁决的东西」)⇒ 只能对着**默认**
 *     世界定界。这不是精确界,是**防呆界**;将来若世界尺寸进入 `ActionContext`,
 *     这里的第一选择是换成「本房间尺寸 / 2」。
 *
 * 越界一律 `INVALID`,且**配置一点没变**(先把所有字段验完再写,不做半截事务)。
 *
 * ## 没有裁决的东西(如实登记,不假装完整)
 *
 *   1 「图腾必须落在安全区内」**不判** —— 那需要城镇中心,而 `ActionContext` 里既没有
 *     `townCenter()`(它在 `SpawnWorld` / `WorldSim` 上)也没有世界尺寸(`host` 是
 *     `WorldSaveHost`,不含它)。真要判就得读世界,那属于「世界侧消费」那一步。
 *     故 `totemCell` 只验**形状**(两个有限整数)。
 *   2 「半径是否超过本房间世界尺寸」同上。
 *   3 改造的**历史**只保留最后一次(`TownConfig` 不带版本号 / 审计流)。
 *
 * ## 参数从哪来
 *
 * ⚠️ `radius` / `name` / `totemCell` 这三个键**还没有**写进 `ActionPayload`
 *   (`net/room.ts:828`)—— 那不在本次可改范围里。故按 `actions/sleep.ts:196`
 *   已有的同一手法:用**局部窄类型**读它,并对每个键**显式**校验(缺项不猜默认值)。
 *   将来把这三个字段正式补进 `ActionPayload` 后,把下面的 `as` 收掉即可。
 */
import { TOWN_SAFE_RADIUS } from '../../mobs/spawner.ts';
import type { ActionOutcome, ActionPayload } from '../room.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/* ═══════════════════════ 1. 配置与出厂值 ═══════════════════════ */

/** 城镇里的一个格号。 */
export interface TownCell {
  readonly x: number;
  readonly y: number;
}

/**
 * 一个房间的城镇配置(本模块登记的**唯一**一份事实)。
 *
 * `updatedBy` / `updatedAtMs` 让「谁改的、什么时候」可查 —— 那正是
 * `docs/TASK-96` 记的那条缺口(「也无『谁有权改』的裁决」)缺的另一半。
 */
export interface TownConfig {
  /** 安全区半径(格)。出厂值 = `spawner.ts` 的 `TOWN_SAFE_RADIUS`。 */
  readonly safeRadius: number;
  /** 城镇名(客户端抬头用)。 */
  readonly name: string;
  /** 图腾所在格;`null` = 还没有图腾(世界侧至今没有图腾实体)。 */
  readonly totemCell: TownCell | null;
  /** 最后一次改造的发起者;`''` = 出厂值(从未被改造过)。 */
  readonly updatedBy: string;
  /** 最后一次改造的时刻(ms);`0` = 出厂值。 */
  readonly updatedAtMs: number;
}

/** 出厂城镇名。 */
export const DEFAULT_TOWN_NAME = '默认城镇';

/**
 * 半径下界(格)。理由见文件头「半径的上下界为什么是 6 与 32」。
 * 取值:6 = 路灯抑制半径 5(`STREET_LAMP_RADIUS`,spawner.ts:23)+ 1。
 */
export const MIN_TOWN_RADIUS = 6;

/**
 * 半径上界(格)。理由见文件头。
 * 取值:32 = `WorldSim` 默认世界 64 格(`world_sim.ts:897`)的半边(即中心到边界)。
 */
export const MAX_TOWN_RADIUS = 32;

/**
 * 城镇名长度上限(字符)。
 *
 * ⚠️ 这是**防呆界,不是产品规则**:名字会随回执(`effect`)出门,不设上界就等于让
 *   一次动作塞进任意长的字符串。24 与客户端抬头栏的同量级字符串齐平。
 */
export const MAX_TOWN_NAME_LEN = 24;

/**
 * 房间 → 城镇配置。**本模块是唯一写者**(`MODIFY_TOWN` 的处理器)。
 *
 * 与 `sleep` 的登记表同款:按 `roomId` 分桶,没登记过 = 出厂值。
 */
const TOWNS = new Map<string, TownConfig>();

/** 可注入时钟(毫秒)。默认墙钟;判据注入假钟,不依赖真实时间。 */
let clockMs: () => number = () => Date.now();

/** 注入时钟。**唯一**的时间来源:配置登记与回执都走它,不各自读 `Date.now`。 */
export function setTownClock(clock: () => number): void {
  clockMs = clock;
}

/** 恢复默认时钟(测试收尾;生产不需要)。 */
export function resetTownClock(): void {
  clockMs = () => Date.now();
}

/** 清空全部登记(测试隔离用;生产不需要)。 */
export function clearTownRegistry(): void {
  TOWNS.clear();
}

/** 出厂配置。**不写进注册表** ⇒ 「有没有被改造过」本身可分辨(`updatedBy === ''`)。 */
function defaultTownConfig(): TownConfig {
  return {
    safeRadius: TOWN_SAFE_RADIUS,
    name: DEFAULT_TOWN_NAME,
    totemCell: null,
    updatedBy: '',
    updatedAtMs: 0,
  };
}

/**
 * 读回某房间**当前**的城镇配置(供未来让 `spawner` / 世界侧消费)。
 *
 * ⚠️ 今天**没有任何生产读者**:世界侧(刷怪 / 安全区)仍读 `spawner.ts` 自己的常量
 *   ⇒ 本函数目前只有判据在调(见文件头「先说不做什么」)。
 *
 * 返回**副本**:调用方改它不会影响注册表 —— 唯一写者仍是 `MODIFY_TOWN`。
 */
export function townConfigOf(roomId: string): TownConfig {
  const cur = TOWNS.get(roomId);
  if (cur === undefined) return defaultTownConfig();
  return {
    safeRadius: cur.safeRadius,
    name: cur.name,
    totemCell: cur.totemCell === null ? null : { x: cur.totemCell.x, y: cur.totemCell.y },
    updatedBy: cur.updatedBy,
    updatedAtMs: cur.updatedAtMs,
  };
}

/**
 * `MODIFY_TOWN` 的 per-room 半径 → `spawner` 的 `TownRadiusProvider` 适配器(**只读**)。
 *
 * `townSafeRadiusProvider(roomId) = townConfigOf(roomId).safeRadius`,**不写**任何状态;
 * 它把本模块的 per-room 半径喂给 `spawner.setTownRadiusProvider` —— 于是世界侧的
 * 「安全区多大」第一次**真的**由 `MODIFY_TOWN` 决定(而不是 spawner 那个常量)。
 *
 * **谁调它**(世界侧接线,主线做;本模块**不自己**调 —— 那会让每个 import 本模块的
 * 测试都拧上全局插槽,`spawner` 判据里「未装 provider ⇒ 默认 24」就再也测不到):
 * ```ts
 *   // 装配期一次(例如 server/src/index.ts 的 assemble 或启动引导里):
 *   setTownRadiusProvider(townSafeRadiusProvider);
 *   // 并让 world_sim.ts 的 spawnWorld() 返回对象带上 roomId:
 *   //   roomId: () => <本房间号>
 * ```
 */
export function townSafeRadiusProvider(roomId: string): number {
  return townConfigOf(roomId).safeRadius;
}

/* ═══════════════════════ 2. 报文参数 ═══════════════════════ */

/**
 * 本次改造的报文参数。
 *
 * ⚠️ 三个键**还没有**写进 `ActionPayload`(`net/room.ts:828`)⇒ 这里的交叉类型
 *   (`ActionPayload & {...}`)只是**读**它用的局部窄类型,不是第二份协议定义:
 *   真正的落点仍是 `ActionPayload`,补进去之后这个 `as` 就可以收掉(见文件头)。
 */
type TownPayload = ActionPayload & {
  /** 新半径(有限整数,`MIN_TOWN_RADIUS..MAX_TOWN_RADIUS`)。 */
  radius?: unknown;
  /** 新城镇名(去空白后 1..`MAX_TOWN_NAME_LEN` 字符)。 */
  name?: unknown;
  /** 新图腾格;`null` = 清掉图腾。 */
  totemCell?: unknown;
};

/** 本次改造要改的字段(全部验完之后才会写进注册表)。 */
interface TownPatch {
  safeRadius?: number;
  name?: string;
  totemCell?: TownCell | null;
}

/**
 * `effect` 只能放 `string | number | boolean`(`net/room.ts:866`)⇒ 坐标对必须
 * **扁平化**:`null` 渲染成 `none`,有坐标渲染成 `"x,y"`。这不是为了好看:
 * 回执要能直接进报文,不许把内部对象漏出去。
 */
function cellText(c: TownCell | null): string {
  return c === null ? 'none' : `${c.x},${c.y}`;
}

/* ═══════════════════════ 3. 动作处理器 ═══════════════════════ */

/**
 * `MODIFY_TOWN`:改城镇配置。
 *
 * 判序(逐条对着判据):
 *   1 `authorize` 不通过 ⇒ `PERMISSION`,**配置一点没变**(闸在第一行);
 *   2 参数逐个校验,任一不合法 ⇒ `INVALID`,**配置一点没变**
 *      (不做「改了一半又拒绝」的半截事务);
 *   3 一个字段都没给 ⇒ `INVALID`(不给空改造「静默成功」);
 *   4 全部合法 ⇒ 写注册表并回 `OK` + `effect`(改前 → 改后,含 `updatedBy` /
 *      `updatedAtMs`)。
 *
 * 显式返回类型:`effect` 的值类型是 `string | number | boolean`,让 TS 去推会把
 * 字面量对象推成具体形状而非 `ActionOutcome`(`actions/material.ts:81` 同款理由)。
 */
export const modifyTown: ActionHandler = (ctx: ActionContext): ActionOutcome => {
  /* ── 1 权限闸。`town` 位的真实定义见 `ACTION_PERMISSION`,本模块不复制它。 ── */
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };

  const roomId = ctx.state.roomId;
  const p = ctx.payload as TownPayload;
  const patch: TownPatch = {};

  /* ── 2 参数校验(全部验完再写)。`undefined` = 本次没给这个字段。 ── */

  if (p.radius !== undefined) {
    const r = p.radius;
    /* 有限**整数**:小数会让安全区落在半格上,而世界判定按格算(`isInsideSafeRadius`
       吃的是格坐标)。`NaN` / `Infinity` 在这里一并被 `Number.isInteger` 挡掉。 */
    if (typeof r !== 'number' || !Number.isInteger(r)) {
      return {
        ok: false, kind: 'INVALID',
        reason: `radius 必须是有限整数(实测 ${typeof r === 'number' ? r : typeof r})`,
      };
    }
    if (r < MIN_TOWN_RADIUS || r > MAX_TOWN_RADIUS) {
      return {
        ok: false, kind: 'INVALID',
        reason: `radius 必须在 ${MIN_TOWN_RADIUS}..${MAX_TOWN_RADIUS} 格之间`
          + `(实测 ${r};上下界的理由见 MIN_TOWN_RADIUS / MAX_TOWN_RADIUS)`,
      };
    }
    patch.safeRadius = r;
  }

  if (p.name !== undefined) {
    const n = p.name;
    if (typeof n !== 'string') {
      return { ok: false, kind: 'INVALID', reason: `name 必须是字符串(实测 ${typeof n})` };
    }
    const trimmed = n.trim();
    if (trimmed.length === 0) {
      return { ok: false, kind: 'INVALID', reason: 'name 不能是空串(去掉空白后没有内容)' };
    }
    if (trimmed.length > MAX_TOWN_NAME_LEN) {
      return {
        ok: false, kind: 'INVALID',
        reason: `name 最长 ${MAX_TOWN_NAME_LEN} 个字符(实测 ${trimmed.length})`,
      };
    }
    patch.name = trimmed;
  }

  if (p.totemCell !== undefined) {
    const raw = p.totemCell;
    if (raw === null) {
      /* 显式清掉图腾 —— 与「没给这个字段」是两件事,故用 `null` 而不是省略。 */
      patch.totemCell = null;
    } else if (typeof raw !== 'object' || raw === null) {
      return {
        ok: false, kind: 'INVALID',
        reason: 'totemCell 必须是 { x, y } 或 null(实测不是对象)',
      };
    } else {
      const c = raw as { x?: unknown; y?: unknown };
      const { x, y } = c;
      if (typeof x !== 'number' || !Number.isInteger(x)
        || typeof y !== 'number' || !Number.isInteger(y)) {
        return {
          ok: false, kind: 'INVALID',
          reason: `totemCell 的 x / y 必须是有限整数(实测 x=${typeof x === 'number' ? x : typeof x}`
            + ` / y=${typeof y === 'number' ? y : typeof y})`,
        };
      }
      patch.totemCell = { x, y };
    }
  }

  /* ── 3 空改造不留「静默成功」。 ── */
  if (patch.safeRadius === undefined && patch.name === undefined && patch.totemCell === undefined) {
    return {
      ok: false, kind: 'INVALID',
      reason: '这次改造没有任何字段(radius / name / totemCell 至少给一个)'
        + ' —— 空改造不给「静默成功」',
    };
  }

  /* ── 4 写注册表。基准是**当前**配置(不是出厂值)⇒ 两次改造是叠加的。 ── */
  const before = townConfigOf(roomId);
  const after: TownConfig = {
    safeRadius: patch.safeRadius ?? before.safeRadius,
    name: patch.name ?? before.name,
    totemCell: patch.totemCell === undefined ? before.totemCell : patch.totemCell,
    updatedBy: ctx.actorId,
    updatedAtMs: clockMs(),
  };
  TOWNS.set(roomId, after);

  return {
    ok: true,
    kind: 'OK',
    effect: {
      roomId,
      beforeSafeRadius: before.safeRadius,
      afterSafeRadius: after.safeRadius,
      beforeName: before.name,
      afterName: after.name,
      beforeTotemCell: cellText(before.totemCell),
      afterTotemCell: cellText(after.totemCell),
      updatedBy: after.updatedBy,
      updatedAtMs: after.updatedAtMs,
      note: '只登记配置:世界侧(刷怪 / 安全区)今天没有任何读者,见本文件开头',
    },
  };
};
