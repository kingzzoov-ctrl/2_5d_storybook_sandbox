/**
 * 生物宿主 —— `MobWorld` 的第一份真实实现。
 *
 * ## 为什么这是缺的那一块
 *
 * `server/src/mobs/behaviors.ts` 定义了 `MobWorld` **接口**(8 个方法:
 * `probe` / `players` / `groundItems` / `consumeGroundItem` / `setFloor` /
 * `placeObj` / `spawnItem` / `emit`),25 个 AI 类全部通过它访问世界。
 *
 * 但**全仓没有任何类实现这个接口**。实测后果:
 *   - `MOB_AI_FACTORY` 有 24 条注册、`createMobAi()` 可用 —— 能造出 AI 实例;
 *   - 可是**没有任何地方调用 `ai.tick(rt, world, dt)`** —— 25 个 `tick`
 *     实现一行都没跑过;
 *   - behaviors.ts 里 30 处 `world.emit('...')` 覆盖 29 种事件 ——
 *     全部喊给空气听。
 *
 * 所以「生物行为未接入」的根因不是「缺宿主类」这么简单,而是三件事一起缺:
 *   1. 一个把 `WorldSim` 的内部结构适配成 `MobWorld` 的**宿主**;
 *   2. 一个接收 `emit` 的**事件总线**(见 `events/bus.ts`);
 *   3. 一个把 AOI 唤醒结果变成 `MobRuntime` 的**运行时映射**。
 *
 * 这一层把三者接起来。
 *
 * ## 设计要点
 *
 * **适配而非重写**:宿主只是把 `WorldGrid` / `PhysicsWorld` / `FluidField`
 * 的既有查询包装成 `MobWorld` 的 8 个方法。不复制任何地形/物理逻辑 ——
 * 那会造出第二份真相,而两份真相必然漂移。
 *
 * **`MobRuntime` 也由宿主持有**:`behaviors.ts` 要求运行时对象带 `mem`
 * (AI 私有状态槽)、`fsm`、`warns` 等字段。这些必须**跨帧存活**,
 * 否则「野猪冲了几格」「姜饼小人还剩几秒逃逸」这类状态每帧归零。
 *
 * **落地动作走确定性路径**:`setFloor` / `placeObj` / `spawnItem`
 * 直接写编排层的网格与总线,不经过 LLM 或随机源。
 */

import {
  MobFsm,
  PROBE_LEN,
  TELEGRAPH_SEC_MIN,
  type FsmConfig,
} from './fsm.ts';
import { circleWarn, type WarnGeom } from './geometry.ts';
import { angleToDeg } from './geometry.ts';
import {
  createMobAi,
  isHostile,
  type BaseMobAi,
  type MobRuntime,
  type MobWorld,
  type GroundItem,
  type WorldPlayer,
  type DamageKind,
  type DamageResult,
} from './behaviors.ts';
import { MobFsmState, MobBehavior, type MobDef } from '../../../shared/types/entities.ts';
import { BASE_MOVE_SPEED } from '../../../shared/types/physics.ts';
import type { EventBus, EventPayload } from '../events/bus.ts';

/* ═══════════════════════ 1. 宿主依赖 ═══════════════════════ */

/**
 * 宿主需要的**最小**世界访问能力。
 *
 * 刻意用窄接口而不是直接拿 `WorldSim`:这样宿主可以脱离完整编排层单测,
 * 也避免与 `world_sim.ts` 形成循环依赖。
 */
export interface MobHostWorld {
  /** 该格是否可站立(非实心、有支撑)。 */
  probe(x: number, y: number): boolean;
  /** 当前玩家列表(只读)。 */
  players(): readonly WorldPlayer[];
  /** 地面掉落物。 */
  groundItems(): readonly GroundItem[];
  /** 消耗地面物品,返回实际消耗数。 */
  consumeGroundItem(itemId: number, count: number): number;
  /** 写地砖层(FLOOR)。 */
  setFloor(x: number, y: number, floor: number): void;
  /** 写物件层(OBJ,12 位)。 */
  placeObj(x: number, y: number, obj: number): void;
  /** 生成掉落物。 */
  spawnItem(x: number, y: number, itemId: number, count: number): void;
  /** 当前帧序(快帧)。 */
  frame(): number;
}

/* ═══════════════════════ 2. 宿主选项 ═══════════════════════ */

export interface MobHostOptions {
  /** 事件总线。省略时事件被静默丢弃(但计数仍上报,便于发现「忘了接总线」)。 */
  bus?: EventBus;
  /** 单个 AI 的预警几何上限(防某 AI 每帧 push 却不清理)。默认 64。 */
  maxWarnsPerMob?: number;
  /**
   * 确定性随机源(0..1)。
   *
   * **必须注入,不用 `Math.random`**:`MobFsm` 的 `resetGraze()` 会用 rng
   * 挑闲逛目标点与时长,而确定性回放(同种子同结果)是本项目的硬要求。
   * 默认用固定序列的 LCG,使「忘了传 rng」也仍可复现 —— 若默认成
   * `Math.random`,第一次回放不一致的排查会非常痛苦。
   */
  rng?: () => number;
}

/**
 * 默认确定性随机源:线性同余,种子固定。
 *
 * 不用 `Math.random`。这里的序列质量无关紧要(只用于挑闲逛点与时长),
 * 重要的是**同种子必同序列**。
 */
function makeDefaultRng(seed = 0x2f6e2b1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 一帧的宿主统计。 */
export interface MobHostFrameStats {
  /** 本帧推进的生物数。 */
  ticked: number;
  /** 本帧 AI 抛错数。 */
  errors: number;
  /** 本帧 emit 的事件数。 */
  emitted: number;
  /** 本帧新产生的预警几何数。 */
  warns: number;
  /** 因预警上限被丢弃的数量。 */
  warnsDropped: number;
}

/** 单个生物被宿主推进后的结果(供编排层/测试观测)。 */
export interface MobTickResult {
  id: string;
  warns: WarnGeom[];
  error: string | null;
}

/* ═══════════════════════ 3. 宿主 ═══════════════════════ */

/**
 * 扫掠采样步长(格)。
 *
 * **必须 < 1**:世界格是 1×1 的,采样步长大于等于 1 就可能整格跳过,
 * 于是 1 格厚的墙漏检 —— 实测确认步长 4.5 格时 1 格墙会被穿过。
 * 取 0.5 留一倍余量。
 */
const PROBE_SWEEP_STEP = 0.5;

/** 宿主内部持有的生物条目:定义 + 运行时 + AI 实例。 */
interface HostedMob {
  rt: MobRuntime;
  ai: BaseMobAi;
}

export class MobHost implements MobWorld {
  private readonly world: MobHostWorld;
  private readonly bus: EventBus | null;
  private readonly maxWarns: number;
  /** 确定性随机源(供 FSM 的闲逛挑点用)。 */
  readonly rng: () => number;

  /** 生物 ID → 宿主条目。用 Map 而非数组:AI 常按 ID 互查(如雷云球链接金属)。 */
  private readonly mobs = new Map<string, HostedMob>();
  /** 本帧已 emit 的事件数(用于上限)。 */
  private emitCount = 0;
  /** 累计统计。 */
  readonly totals = { ticks: 0, errors: 0, emitted: 0, warns: 0, warnsDropped: 0, spawned: 0, sweepClamped: 0, fsmMoves: 0, aiOverrides: 0 };

  /**
   * 本帧 FSM 产出的兜底预警(单只生物用一次就清)。
   *
   * 不是数组:同一帧只推进一只生物,`tickMobs` 的循环是串行的,
   * 而且 `advanceFsmBase` 紧接着就会被同一只生物的预警逻辑消费。
   */
  private pendingFsmWarn: WarnGeom | null = null;

  constructor(world: MobHostWorld, options: MobHostOptions = {}) {
    this.world = world;
    this.bus = options.bus ?? null;
    this.maxWarns = options.maxWarnsPerMob ?? 64;
    this.rng = options.rng ?? makeDefaultRng();
  }

  /* ── 生物注册 ── */

  /**
   * 登记一只生物。重复 ID 会**替换**旧条目(重连/重生场景),
   * 但保留 `mem`:AI 私有状态不该因重生而清空(例如驯化进度)。
   *
   * ## 关于 `rt.fsm`:移动权威(方案 D,已裁决)
   *
   * `MobFsm`(`mobs/fsm.ts`)是一个**完整实现的三态 FSM** —— 闲逛挑点、
   * 45° 避障 steering、预警几何生成、攻击后摇,55 条断言在 `tests/WS-04.test.ts`
   * 全部通过。但它自带一份 `x` / `y` / `vx` / `vy`,并在 `tick()` 里
   * **自己推进位置**;而 25 个 AI 子类里 4 个**各自直接写 `rt.x` / `rt.y`**(共 7 处)。
   *
   * 早先宿主**绝不调用** `fsm.tick()`,理由是「避免两个移动权威互相覆盖」。
   * 那个选择的真实代价是:**22/24 生物 60 秒位移为 0**,与玩家在不在场无关 ——
   * 它们连游荡都不会,而**游荡逻辑只存在于 FSM 里**。
   *
   * 现在的分工(方案 D,详见 `docs/EVENT-BUS.md` §3):
   *   1. FSM 先算**基础移动**(游荡 / 警戒 / 追猎),带 45° 避障,写进 `rt`;
   *   2. AI 随后执行自己的 `tick`;
   *   3. AI **写了位置**(专属运动:野猪直线冲锋、穿山甲翻滚、蝠鲼滑翔、
   *      史莱姆跳向甜莓)就以 AI 为准,并把 FSM 位置**同步**到 AI 落点;
   *   4. AI **没写**,FSM 的位移留下。
   *
   * 第 3 步的同步不是美化:去掉它之后 FSM 与 rt 会分叉(故障注入实测偏差 4.5),
   * 表现是**生物瞬移**。所以不变量是「调用之后位置不分叉」,而不是「不调用」。
   *
   * 判据是「AI 有没有写位置」而非「AI 属于哪一类」——
   * 新增 AI 无需注册,改某个 AI 的移动也不会悄悄失效。
   */
  addMob(id: string, def: MobDef, x: number, y: number, opts: { anchorX?: number; anchorY?: number; hp?: number } = {}): MobRuntime {
    const hp = opts.hp ?? def.hp;
    const existed = this.mobs.get(id);
    const anchorX = opts.anchorX ?? x;
    const anchorY = opts.anchorY ?? y;

    /* 构造真实 FSM:AI 需要写 `fsm.flee` / `fsm.state`,缺了会抛
       「Cannot set properties of undefined」。宿主不是给个占位对象,
       而是给真实 FSM —— 这样 `fsm.setState()` 的状态迁移合法性检查也生效。 */
    const fsm = new MobFsm(
      id,
      {
        homeX: anchorX,
        homeY: anchorY,
        speed: BASE_MOVE_SPEED,
        /* 感知/攻击半径:取手册区间中值。敌对生物感知更远(要扑过来),
           温顺生物感知近(受惊才跑)。 */
        aggroRadius: isHostile(def) ? 8 : 4,
        attackRadius: 1.5,
        makeTelegraph: (self: MobFsm, _target: { x: number; y: number }) =>
          circleWarn(self.x, self.y, 1.5, TELEGRAPH_SEC_MIN),
      },
      this.rng,
    );

    const rt: MobRuntime = {
      id,
      def,
      x,
      y,
      z: 0,
      hp,
      maxHp: def.hp,
      facingDeg: 0,
      mem: existed?.rt.mem ?? {},
      fsm,
      alive: hp > 0,
      warns: [],
      anchorX,
      anchorY,
    };
    this.mobs.set(id, { rt, ai: createMobAi(def) });
    return rt;
  }

  /** 移除一只生物。 */
  removeMob(id: string): boolean {
    return this.mobs.delete(id);
  }

  /** 取运行时(只读用途;改动请通过 AI 或 onDamage)。 */
  runtimeOf(id: string): MobRuntime | null {
    return this.mobs.get(id)?.rt ?? null;
  }

  /** 已登记的生物数。 */
  get size(): number {
    return this.mobs.size;
  }

  /** 全部运行时快照(顺序稳定:按 ID 字典序)。 */
  runtimes(): MobRuntime[] {
    return [...this.mobs.keys()].sort().map((k) => this.mobs.get(k)!.rt);
  }

  /** 全部 AI 实例(顺序稳定)。供测试确认「某生物用的是哪个 AI 类」。 */
  ais(): { id: string; ctor: string }[] {
    return [...this.mobs.keys()].sort().map((k) => {
      const m = this.mobs.get(k)!;
      return { id: k, ctor: m.ai.constructor.name };
    });
  }

  /* ── 推进 ── */

  /**
   * 推进指定生物(通常来自 AOI 的活跃集合)。
   *
   * **只推进传入的 ID**:宿主不做可见性判断 —— 那是 `AoiManager` 的职责。
   * 职责分离的好处是宿主可脱离 AOI 单测。
   *
   * 顺序**按 ID 排序**:即使调用方传的集合顺序不定(Set/Map 迭代顺序、
   * AOI 唤醒顺序),行为序列也一致 —— 这是确定性的前提。
   *
   * `emit` 的 `source` 由宿主在调用栈内补上(见 `emit`)。
   */
  tickMobs(ids: readonly string[], dt: number): MobTickResult[] {
    const out: MobTickResult[] = [];
    this.emitCount = 0;
    /* 本帧 AI 发出的事件 —— **必须留下记录**。
       事件型伤害(蝎子伏击 / 穿山甲滚撞)的结算时机就是「它被发出的那一帧」,
       而 `bus.drain()` 之后事件就没了。所以宿主在本帧内攒一份,供编排层结算。 */
    this.frameEmits = [];

    for (const id of [...new Set(ids)].sort()) {
      const m = this.mobs.get(id);
      if (!m) continue;
      const { rt, ai } = m;
      if (!rt.alive) {
        out.push({ id, warns: [], error: null });
        continue;
      }

      /* 让本帧 emit 的 source 正确 —— AI 不把自己的 ID 传给 world.emit */
      this.currentSource = id;
      this.totals.ticks += 1;
      try {
        /* 记下 tick 前的位置:AI 直接写 `rt.x` / `rt.y`(实测 7 个 AI 共 8 处),
           所以宿主只能在「写完之后」检查这段位移有没有穿墙。 */
        const px0 = rt.x;
        const py0 = rt.y;

        /* ── 方案 D:FSM 是**基础移动权威**,AI 只在专属动作时临时接管 ──
           
           实测依据(这是本决策的全部基础,别凭印象):
           宿主此前**从不调用** `fsm.tick()`(理由是怕两个移动权威互相覆盖),
           后果是 **22/24 生物 60 秒位移为 0** —— 与玩家在不在场无关,
           它们连游荡都不会。而 `fsm.tick()` 单独跑 120 帧能走 5.44 格
           (闲逛)并会追猎(3 格外接近到攻击距离)。
           
           所以「不调 FSM」不是保守选择,而是**让 22 种生物永远站着**。
           
           解决方式不是 A/B/C 任何一个,而是**按动作类型分工**:
             · FSM 先算基础移动(游荡 / 警戒 / 追猎)——它带 45° 避障 steering,
               这是 WS-04 的核心产出,不该丢;
             · AI 随后执行自己的 `tick`。若 AI **写了位置**(专属运动:野猪直线冲锋、
               穿山甲翻滚、蝠鲼参数化滑翔、史莱姆跳向甜莓),就以 AI 为准;
             · 若 AI **没写位置**(22 种都是),FSM 的位移留下。
           
           判据是「AI 有没有写位置」而不是「AI 属于哪一类」——
           这样新增 AI 时无需注册,也不会因为改了某个 AI 的移动而悄悄失效。 */
        const fsmTarget = this.pickFsmTarget(rt);
        const fsmMoved = this.advanceFsmBase(rt, fsmTarget, dt);
        const baseX = rt.x;
        const baseY = rt.y;

        const warns = ai.tick(rt, this, dt) ?? [];
        /* AI 是否写了位置?用「与 FSM 落点是否不同」判定,容差 1e-6 防浮点噪声。 */
        const aiWrote = Math.abs(rt.x - baseX) > 1e-6 || Math.abs(rt.y - baseY) > 1e-6;
        if (!aiWrote && fsmMoved) {
          /* AI 没动,保留 FSM 的位移(已在 advanceFsmBase 里写进 rt) */
          this.totals.fsmMoves += 1;
        } else if (aiWrote) {
          /* AI 接管:把 FSM 的内部位置同步到 AI 的落点,
             避免两条轨迹越走越远(否则下一帧 FSM 会从旧位置继续算,
             表现是生物「瞬移回 FSM 的老位置」)。 */
          rt.fsm.x = rt.x;
          rt.fsm.y = rt.y;
          this.totals.aiOverrides += 1;
        }
        /* ── 防穿墙:把 AI 写的位移夹到墙前 ──
           AI 的步长可达 4.5~5.5 格(见 probeSweep 注释),一步能跨过 1 格厚的墙。
           修在这里而不是改 25 个 AI,是为了让规则**只有一份**。
           若 AI 自己已经处理了撞墙(野猪/穿山甲会自晕并**不移动**),
           这里位移为 0,夹取无副作用。 */
        const t = this.sweepClampT(px0, py0, rt.x, rt.y);
        if (t < 1) {
          rt.x = px0 + (rt.x - px0) * t;
          rt.y = py0 + (rt.y - py0) * t;
          this.totals.sweepClamped += 1;
        }
        /* 预警几何:本帧新产生的覆盖旧值,并强制上限。
           
           FSM 的预警**只作兜底**:AI 若产出了预警,说明它对这个动作的几何
           更精确(矩形冲锋、环形火圈),优先采用 AI 的;AI 没产出时,
           FSM 的通用圆形预警才补位 —— 否则「游荡中的生物」永远打不到人。 */
        let list = warns.length > 0 ? warns : this.pendingFsmWarn ? [this.pendingFsmWarn] : [];
        this.pendingFsmWarn = null;
        let dropped = 0;
        if (list.length > this.maxWarns) {
          dropped = list.length - this.maxWarns;
          list = list.slice(0, this.maxWarns);
        }
        rt.warns = list;
        this.totals.warns += list.length;
        this.totals.warnsDropped += dropped;
        out.push({ id, warns: list, error: null });
      } catch (err) {
        /* 隔离:单只生物的 AI 抛错不影响其它生物推进。
           但**必须上报** —— 否则「生物变傻」会被误认为「这生物就是这行为」。 */
        this.totals.errors += 1;
        rt.warns = [];
        out.push({ id, warns: [], error: (err as Error).message });
      } finally {
        this.currentSource = null;
      }
    }
    return out;
  }

  /**
   * 为 FSM 挑一个目标 —— 最近的玩家,超出感知半径则返回 null。
   *
   * 用**最近的**而不是第一个:多人在场时,「先追上谁」应当按距离而非
   * 玩家加入顺序决定,否则后加入的玩家永远被忽略。
   */
  private pickFsmTarget(rt: MobRuntime): { x: number; y: number } | null {
    const ps = this.players();
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const p of ps) {
      const d = Math.hypot(p.x - rt.x, p.y - rt.y);
      if (d < bestD) {
        bestD = d;
        best = { x: p.x, y: p.y };
      }
    }
    return best;
  }

  /**
   * 推进 FSM 的基础移动,并把落点写进 `rt`。返回「本帧是否真的移动了」。
   *
   * `probe` 用宿主自己的封锁查询 —— FSM 的 45° 避障靠它读地形
   * (实测 `steer45` 会做 3 次探针读)。传进去的是**阻塞语义**
   * (`true` = 被挡),与 `MobWorld.probe` 一致。
   */
  private advanceFsmBase(rt: MobRuntime, target: { x: number; y: number } | null, dt: number): boolean {
    const fsm = rt.fsm;
    /* FSM 的位置可能与 rt 不同步(构造时是从 anchor 起算的)。
       每帧先对齐,保证 FSM 的轨迹接着 rt 走,而不是从老位置重算 ——
       否则第一次启用方案 D 时生物会朝 anchor 方向「瞬移」。 */
    fsm.x = rt.x;
    fsm.y = rt.y;
    const g = fsm.tick(target, (px, py) => this.probe(px, py), dt);
    /* FSM 产出的预警**只在 AI 没产出预警时**采用:AI 的特色预警
       (如火环、矩形冲锋)语义更精确,不该被通用圆形预警覆盖。 */
    if (g) this.pendingFsmWarn = g;
    else this.pendingFsmWarn = null;
    const moved = Math.abs(fsm.x - rt.x) > 1e-6 || Math.abs(fsm.y - rt.y) > 1e-6;
    if (moved) {
      rt.x = fsm.x;
      rt.y = fsm.y;
      rt.facingDeg = angleToDeg(fsm.x - (fsm.x - fsm.vx), fsm.y - (fsm.y - fsm.vy));
    }
    return moved;
  }

  /** 宿主一帧的汇总统计(由 `tickMobs` 的返回值算出)。 */
  static summarize(results: readonly MobTickResult[]): MobHostFrameStats {
    let warns = 0;
    let errors = 0;
    let ticked = 0;
    for (const r of results) {
      if (r.error !== null) errors += 1;
      else ticked += 1;
      warns += r.warns.length;
    }
    return { ticked, errors, emitted: 0, warns, warnsDropped: 0 };
  }

  /* ── 受击 / 交互(转发到 AI) ── */

  /**
   * 对生物结算伤害(转发到它的 AI,使格挡/反弹等特性能生效)。
   *
   * ## `currentSource` 必须在这里设置
   *
   * `emit` 靠 `currentSource` 补 `source` 字段(见 `emit` 的注释)。
   * 原先只有 `tickMobs` 设置它,于是从**外部**调用 `damage` / `interact`
   * 时,AI 在 `onDamage` 里 emit 的事件 source 会错成 `'mob'` ——
   * 事件本身产生了,但「谁发出来的」是错的,回放与诊断都会误判。
   *
   * 现在两处都设,并在 finally 里还原(嵌套调用不会污染外层)。
   */
  damage(id: string, amount: number, kind: DamageKind, fromDeg: number): DamageResult | null {
    const m = this.mobs.get(id);
    if (!m) return null;
    const prevSource = this.currentSource;
    this.currentSource = id;
    try {
      return m.ai.onDamage(m.rt, this, amount, kind, fromDeg);
    } catch (err) {
      this.totals.errors += 1;
      return { hpLoss: 0, blocked: false, blockedRatio: 0, reflectHearts: 0, errors: [(err as Error).message] } as unknown as DamageResult;
    } finally {
      this.currentSource = prevSource;
    }
  }

  /** 道具交互(喂食/敲击/钩爪)。 */
  interact(id: string, itemId: number, player: WorldPlayer): boolean {
    const m = this.mobs.get(id);
    if (!m) return false;
    const prevSource = this.currentSource;
    this.currentSource = id;
    try {
      return m.ai.onInteract(m.rt, this, itemId, player);
    } catch {
      this.totals.errors += 1;
      return false;
    } finally {
      this.currentSource = prevSource;
    }
  }

  /** AI 内部状态摘要(调试面板/测试)。 */
  inspectMob(id: string): Record<string, number> | null {
    const m = this.mobs.get(id);
    return m ? m.ai.inspect(m.rt) : null;
  }

  /* ── AI 记忆(mem)的导出 / 导入 ── */

  /**
   * 导出全部生物的 AI 记忆:可 JSON 序列化,供存档/跨区迁移。
   *
   * ## 为什么需要这个
   *
   * `mem` 原本**只活在宿主进程内** —— `addMob` 里 `mem: existed?.rt.mem ?? {}`
   * 只在同一宿主内、同一 ID 重复登记时保留。重连/换区/重启会构造新宿主,
   * 于是 `mem` 归零:姜饼小人的逃逸计时重置、野猪的冲锋相位丢失、
   * 驯化进度(`fedCount`)清零。实测:`mem={"escapeTimer":7.5,...}` 在新宿主中为 `{}`。
   *
   * 注意值是**联合类型**:`mem` 声明为 `Record<string, number>` 但
   * `GingerImpAi` 写入过字符串(`behaviors.ts:879` 的 `taunt`)。
   * 导出按 `unknown` 透传,导入时按 JSON 实际类型还原,不假设全是 number ——
   * 否则 `'你抓不到我'` 会在往返中变成 `NaN` 或抛错。
   */
  exportMem(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const id of [...this.mobs.keys()].sort()) {
      const mem = this.mobs.get(id)!.rt.mem;
      /* 深拷贝一层:调用方拿到的是快照,后续 mem 变更不影响已导出数据。
         值都是原始类型(number/string/boolean),浅拷贝即足够。 */
      out[id] = { ...(mem as Record<string, unknown>) };
    }
    return out;
  }

  /**
   * 导入 AI 记忆(与 `exportMem` 对偶)。
   *
   * 只对**当前已登记**的生物写入 —— 未登记的 ID 被忽略并计入 `skipped`:
   * 生物可能已被击杀或未在本区刷新,给它凭空建 `mem` 只会造出一份
   * 没有对应实体的孤儿状态。
   *
   * 返回实际写入数与被跳过数,便于调用方断言「写完读回一致」。
   */
  importMem(data: Record<string, Record<string, unknown>>): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    for (const id of Object.keys(data).sort()) {
      const m = this.mobs.get(id);
      if (!m) {
        skipped += 1;
        continue;
      }
      const incoming = data[id];
      if (incoming === null || typeof incoming !== 'object') {
        skipped += 1;
        continue;
      }
      /* 就地覆盖而不是替换对象:AI 可能已持有 `rt.mem` 的引用
         (`rt.mem.xxx = ...` 遍布 behaviors.ts),换掉对象会让旧引用失效。 */
      for (const k of Object.keys(incoming)) {
        (m.rt.mem as Record<string, unknown>)[k] = incoming[k];
      }
      applied += 1;
    }
    return { applied, skipped };
  }

  /* ═══════════ MobWorld 接口实现(25 个 AI 靠这 8 个方法访问世界)═══════════ */

  /** 该格能否站立。语义:非实心即可站立 —— 与 `BoarAi` 的撞墙判定一致。 */
  probe(x: number, y: number): boolean {
    return this.world.probe(x, y);
  }

  /**
   * 沿直线步进的**扫掠**障碍检测(隧道效应防护)。
   *
   * ## 为什么需要它
   *
   * `probe` 只判**终点**。而 AI 的步长可以很大:
   *   - `PangolinAi`:9.0 格/秒 × 0.5 秒 = **4.5 格/步**
   *   - `BoarAi`:11.0 格/秒 × 0.5 秒 = **5.5 格/步**
   *
   * 一步跨过 4.5~5.5 格时,若中间有一堵 1 格厚的墙而终点在墙后,
   * `probe(终点)` 返回「通行」—— 于是生物**穿墙而过**。
   * 实测确认:1 格厚墙 → 穿过;3 格以上 → 正确挡住(与步长 4.5 吻合)。
   *
   * 这不是 `probe` 的极性错误,而是**离散采样漏检中间路径**。
   *
   * @returns 从 (x0,y0) 到 (x1,y1) 的直线路径上是否有障碍
   */
  probeSweep(x0: number, y0: number, x1: number, y1: number): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist <= PROBE_SWEEP_STEP) return this.probe(x1, y1);
    const steps = Math.ceil(dist / PROBE_SWEEP_STEP);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      if (this.probe(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return true;
    }
    return false;
  }

  /**
   * 沿直线找到**最远的可通行点**,返回该点的参数 t ∈ [0,1]。
   *
   * 用于把「AI 想移到 X」修正成「最远只能移到墙前」——
   * 这样生物停在墙边而不是穿过去,也不需要 AI 自己实现扫掠。
   */
  sweepClampT(x0: number, y0: number, x1: number, y1: number): number {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist <= PROBE_SWEEP_STEP) return this.probe(x1, y1) ? 0 : 1;
    const steps = Math.ceil(dist / PROBE_SWEEP_STEP);
    let lastFree = 0;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      if (this.probe(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) break;
      lastFree = t;
    }
    return lastFree;
  }

  players(): readonly WorldPlayer[] {
    return this.world.players();
  }

  groundItems(): readonly GroundItem[] {
    return this.world.groundItems();
  }

  consumeGroundItem(itemId: number, count: number): number {
    return this.world.consumeGroundItem(itemId, count);
  }

  setFloor(x: number, y: number, floor: number): void {
    this.world.setFloor(x, y, floor);
  }

  placeObj(x: number, y: number, obj: number): void {
    this.world.placeObj(x, y, obj);
  }

  spawnItem(x: number, y: number, itemId: number, count: number): void {
    this.totals.spawned += 1;
    this.world.spawnItem(x, y, itemId, count);
  }

  /**
   * 事件出口 —— 25 个 AI 的 30 处 `emit` 都走到这里。
   *
   * `source` 取**发起 emit 的生物 ID**:AI 通过宿主回调时没有把自己的 ID
   * 传进来,所以宿主用「当前正在推进的生物」补上。这要求 emit 只在该生物的
   * `tick` 调用栈内发出 —— `behaviors.ts` 的实际用法正是如此(每个 AI 在
   * 自己的 tick 里 emit 自己的事件)。
   *
   * 若 `bus` 未注入:事件被丢弃,但 `totals.emitted` 仍增长 ——
   * 这样「忘了接总线」会表现为「发出 30 个事件但投递 0 个」,
   * 是可观测的,而不是静默无痕。
   */
  emit(kind: string, payload: EventPayload = {}): void {
    this.emitCount += 1;
    this.totals.emitted += 1;
    /* 留一份本帧记录:事件型伤害(蝎子伏击等)必须在**被发出的那一帧**
       结算,而总线 drain 之后事件就没了。见 server/src/combat/vitals.ts §6。 */
    this.frameEmits.push({ kind, source: this.currentSource ?? 'mob' });
    if (!this.bus) return;
    this.bus.emit(kind, payload, this.currentSource ?? 'mob');
  }

  /** 当前正在 tick 的生物 ID(供 emit 补 source)。 */
  private currentSource: string | null = null;

  /**
   * 本帧 AI 发出的事件(每个 `tickMobs` 重置)。
   *
   * 存在的理由:`bus.drain()` 每帧清空投递队列,而**事件型攻击的结算时机
   * 是它被发出的那一帧**。若等到 drain 之后再去翻总线历史,会拿到
   * 「已投递过」的记录 —— 但没有任何订阅者的事件**根本不会进历史**,
   * 于是「没订阅者 = 不结算」这种诡异的耦合就出现了。
   * 所以宿主自己攒一份,与总线是否有订阅者无关。
   */
  frameEmits: { kind: string; source: string }[] = [];
}
