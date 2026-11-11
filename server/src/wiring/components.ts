/**
 * WS-08 / 魔能电路与竞技设施:**401~440 全部 40 项**行为实现。
 *
 * 每个物品 ID 对应一个「逻辑件种类」(kind),在模块加载时注册进
 * `server/src/wiring/graph.ts` 的行为注册表。逻辑件的求值入口统一是
 * `ComponentEvaluator = (ctx: ComponentContext) => void`,每 2Hz 帧调用一次。
 *
 * 时序约定(与 graph.ts 一致):
 *   - 逻辑件默认固有延迟 1 帧(= 0.5s),即「本帧读到输入 → 下帧输出生效」;
 *   - 可调延时继电器 413 在固有延迟上加档位帧数;
 *   - 反相输出需显式指定输出色,读输入色与写输出色一般不同(见各件注释)。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { WireColor } from '../../../shared/types/tile.ts';
import type { ComponentContext, ComponentNode } from './graph.ts';
import {
  ALL_COLORS,
  createComponent,
  hasComponentKind,
  registerComponentKind,
  secondsToTicks,
  TICKS_PER_SECOND,
} from './graph.ts';

/* ══════════════════════════ 常量与配表 ══════════════════════════ */

/** 计数器 413 之外的逻辑件固有延迟(帧)。 */
export const INHERENT_LATENCY_TICKS = 1;

/** 可调延时继电器 413 的四档秒数(与配表 note 原文一致)。 */
export const RELAY_DELAY_SECONDS: readonly number[] = Object.freeze([0.2, 0.5, 1.0, 2.0]);

/** 四档在 2Hz 下量化为帧数:ceil(s / 0.5)。 */
export const RELAY_DELAY_TICKS: readonly number[] = Object.freeze(
  RELAY_DELAY_SECONDS.map((s) => secondsToTicks(s)),
);

/** 瞬时脉冲按钮 404 的高电平持续时间。 */
export const PULSE_BUTTON_SECONDS = 0.5;
export const PULSE_BUTTON_TICKS = secondsToTicks(PULSE_BUTTON_SECONDS);

/** 计数器 417 的量程 0..99。 */
export const COUNTER_MOD = 100;
export const COUNTER_MAX = COUNTER_MOD - 1;

/** 弹簧垫 422 两次弹射之间的冷却帧数(2.0s @ 2Hz)。 */
export const SPRING_COOLDOWN_TICKS = 4;

/** 无线频道范围 418。 */
export const CHANNEL_MIN = 1;
export const CHANNEL_MAX = 8;

/** 分流器 416 的三条出路。 */
export const SPLITTER_ROUTES: readonly WireColor[] = Object.freeze([
  WireColor.RED, WireColor.BLUE, WireColor.GREEN,
]);
export const SPLITTER_ROUTE_NAMES: readonly string[] = Object.freeze(['EAST', 'SOUTH', 'WEST']);

/** 逻辑件分类标签(文档与测试断言用)。 */
export const ComponentGroup = {
  SENSOR: 'SENSOR',
  ARENA_SENSOR: 'ARENA_SENSOR',
  LOGIC: 'LOGIC',
  DISPLAY: 'DISPLAY',
  WIRELESS: 'WIRELESS',
  ACTUATOR: 'ACTUATOR',
  DEFENSE: 'DEFENSE',
  AGRI_WATER: 'AGRI_WATER',
  LOGISTICS: 'LOGISTICS',
  AMBIENT: 'AMBIENT',
  ARENA_CORE: 'ARENA_CORE',
  VEHICLE: 'VEHICLE',
} as const;
export type ComponentGroup = (typeof ComponentGroup)[keyof typeof ComponentGroup];

export interface ComponentSpec {
  id: number;
  kind: string;
  name: string;
  group: ComponentGroup;
  /** 该件会驱动哪些线;空数组表示「不写线,只产生游戏内效果」 */
  outputs: readonly WireColor[];
  /** 固有延迟帧 */
  latencyTicks: number;
  /** 默认静态参数 */
  params: Record<string, number>;
}

/* ══════════════════════════ 纯函数工具 ══════════════════════════ */

/** xorshift32:确定性 PRNG,用于分流器与随机件。 */
export function nextRandom(state: number): number {
  let x = state | 0;
  if (x === 0) x = 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x | 0;
}

/** 由 PRNG 状态取 [0, 1) 浮点。 */
export function randomUnit(state: number): number {
  return ((state >>> 0) % 0x1000000) / 0x1000000;
}

/**
 * 分流器选路:把 [0,1) 均分成三段,分别对应东/南/西。
 * 纯函数,可在测试里被调用 10000 次做分布断言。
 */
export function chooseSplitterRoute(unit: number): number {
  const u = unit < 0 ? 0 : unit >= 1 ? 0.9999999 : unit;
  if (u < 1 / 3) return 0;
  if (u < 2 / 3) return 1;
  return 2;
}

/** 计数器步进:脉冲 → +1;到 99 后回到 0。 */
export function counterStep(value: number, pulse: boolean): number {
  if (!pulse) return ((value % COUNTER_MOD) + COUNTER_MOD) % COUNTER_MOD;
  return (value + 1) % COUNTER_MOD;
}

/** 计数器翻页显示:十位与个位。 */
export function counterDigits(value: number): { tens: number; ones: number } {
  const v = ((value % COUNTER_MOD) + COUNTER_MOD) % COUNTER_MOD;
  return { tens: Math.floor(v / 10), ones: v % 10 };
}

/** 频道是否匹配(同频道联动、跨频道不联动)。 */
export function channelMatches(tx: number, rx: number): boolean {
  const a = Math.max(CHANNEL_MIN, Math.min(CHANNEL_MAX, tx | 0));
  const b = Math.max(CHANNEL_MIN, Math.min(CHANNEL_MAX, rx | 0));
  return a === b;
}

/** 继电器档位 → 帧数。越界档位夹取到 0..3。 */
export function relayTicksFor(setting: number): number {
  const idx = Math.max(0, Math.min(RELAY_DELAY_TICKS.length - 1, setting | 0));
  return RELAY_DELAY_TICKS[idx];
}

/** 昼夜感光器 405:按世界时间判定夜晚。 */
export const NIGHT_START_HOUR = 19;
export const NIGHT_END_HOUR = 6;
export function isNight(hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/** 音高匹配 408/419:半音差在容差内即算命中(默认 0 = 精确音高)。 */
export function pitchMatches(played: number, target: number, tolerance = 0): boolean {
  return Math.abs((played | 0) - (target | 0)) <= Math.max(0, tolerance | 0);
}

/** 跑酷计时:ms 格式化为「秒.厘秒」。 */
export function formatRunTime(ms: number): string {
  const total = Math.max(0, ms);
  const sec = Math.floor(total / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${sec}.${String(cs).padStart(2, '0')}`;
}

/* ══════════════════════════ 40 项规格表 ══════════════════════════ */

const S = (
  id: number,
  kind: string,
  name: string,
  group: ComponentGroup,
  outputs: readonly WireColor[],
  params: Record<string, number> = {},
): ComponentSpec => ({ id, kind, name, group, outputs, latencyTicks: INHERENT_LATENCY_TICKS, params });

/** §3.7 全部 40 项组件规格,ID 与冻结层 401~440 一一对应。 */
export const COMPONENT_SPECS: readonly ComponentSpec[] = Object.freeze([
  /* 传感器 401~409 */
  S(401, 'SENSOR_PLATE_LIGHT', '轻触木质压力板', ComponentGroup.SENSOR, [WireColor.RED, WireColor.YELLOW]),
  S(402, 'SENSOR_PLATE_HEAVY', '双人重物压力板', ComponentGroup.SENSOR, [WireColor.RED, WireColor.YELLOW], { requiredWeight: 2 }),
  S(403, 'SENSOR_LEVER', '双态机械拉杆', ComponentGroup.SENSOR, [WireColor.RED, WireColor.BLUE, WireColor.YELLOW, WireColor.GREEN]),
  S(404, 'SENSOR_PULSE_BUTTON', '瞬时脉冲按钮', ComponentGroup.SENSOR, [WireColor.RED, WireColor.YELLOW], { pulseTicks: PULSE_BUTTON_TICKS }),
  S(405, 'SENSOR_LIGHT_DAYNIGHT', '昼夜星光感光器', ComponentGroup.SENSOR, [WireColor.RED, WireColor.YELLOW]),
  S(406, 'SENSOR_WATER_LEVEL', '河道水位传感器', ComponentGroup.SENSOR, [WireColor.RED, WireColor.BLUE]),
  S(407, 'SENSOR_LASER_TRIPWIRE', '红外激光绊线柱', ComponentGroup.SENSOR, [WireColor.RED, WireColor.YELLOW], { pulseTicks: INHERENT_LATENCY_TICKS }),
  S(408, 'SENSOR_PITCH', '共鸣音高传感器', ComponentGroup.SENSOR, [WireColor.RED, WireColor.BLUE], { pitch: 0, tolerance: 0 }),
  S(409, 'SENSOR_CHEST_FULL', '仓库满载传感器', ComponentGroup.SENSOR, [WireColor.RED, WireColor.BLUE]),

  /* 竞技传感 410~412 */
  S(410, 'ARENA_GOAL_FRAME', '红蓝计分球门框', ComponentGroup.ARENA_SENSOR, [WireColor.RED, WireColor.BLUE], { team: 0 }),
  S(411, 'ARENA_START_GATE', '跑酷起点发令门', ComponentGroup.ARENA_SENSOR, [WireColor.RED, WireColor.YELLOW]),
  S(412, 'ARENA_FINISH_PODIUM', '跑酷终点领奖台', ComponentGroup.ARENA_SENSOR, [WireColor.YELLOW]),

  /* 逻辑控制 413~416 */
  S(413, 'LOGIC_DELAY_RELAY', '可调延时继电器', ComponentGroup.LOGIC, [WireColor.YELLOW], { setting: 1, inputColor: WireColor.RED }),
  S(414, 'LOGIC_AND', '魔能逻辑与门 (AND)', ComponentGroup.LOGIC, [WireColor.YELLOW], { inA: WireColor.RED, inB: WireColor.BLUE }),
  S(415, 'LOGIC_NOT', '魔能逻辑非门 (NOT)', ComponentGroup.LOGIC, [WireColor.YELLOW], { inA: WireColor.RED }),
  S(416, 'LOGIC_SPLITTER', '随机轮盘分流器', ComponentGroup.LOGIC, SPLITTER_ROUTES, { seed: 0x2545f491 }),

  /* 显示 417 */
  S(417, 'DISPLAY_COUNTER', '0-99 翻页计数器', ComponentGroup.DISPLAY, [WireColor.YELLOW, WireColor.GREEN], { inputColor: WireColor.RED }),

  /* 跨区 418 */
  S(418, 'WIRELESS_LINK', '无线信号发射塔', ComponentGroup.WIRELESS, [WireColor.RED, WireColor.YELLOW], { channel: 1 }),

  /* 执行器 419~424 */
  S(419, 'ACT_NOTE_BLOCK', '32 音高八音盒音符砖', ComponentGroup.ACTUATOR, [], { pitch: 0, timbre: 0 }),
  S(420, 'ACT_RGB_LAMP', '16 色 RGB 像素灯箱', ComponentGroup.ACTUATOR, [], { colorIndex: 0 }),
  S(421, 'ACT_HIDDEN_WALL', '升降隐藏机关墙', ComponentGroup.ACTUATOR, [], {}),
  S(422, 'ACT_LAUNCH_SPRING', '万向弹射弹簧垫', ComponentGroup.ACTUATOR, [], { launchDir: 0, range: 5 }),
  S(423, 'ACT_ROTATOR', '360° 大风车旋转推杆', ComponentGroup.ACTUATOR, [], {}),
  S(424, 'ACT_PISTON_ARM', '伸缩推拉活塞臂', ComponentGroup.ACTUATOR, [], {}),

  /* 防御 425 */
  S(425, 'DEF_BUBBLE_BALLISTA', '自动泡泡连弩炮台', ComponentGroup.DEFENSE, [], { range: 7 }),

  /* 农业水利 426~427 */
  S(426, 'AGRI_SPRINKLER', '旋转自动洒水器', ComponentGroup.AGRI_WATER, []),
  S(427, 'WATER_SLUICE_GATE', '电动升降拦水闸门', ComponentGroup.AGRI_WATER, [], {}),

  /* 自动化物流 428~431 */
  S(428, 'LOGISTICS_CONVEYOR', '定向物流传送带', ComponentGroup.LOGISTICS, [], { dir: 1 }),
  S(429, 'LOGISTICS_SORTER', '智能分拣交叉带', ComponentGroup.LOGISTICS, [], { dir: 1, filterId: 0 }),
  S(430, 'LOGISTICS_ARM', '魔能抓取机械臂', ComponentGroup.LOGISTICS, []),
  S(431, 'LOGISTICS_DRILL', '自动采矿钻头机', ComponentGroup.LOGISTICS, [], { oreId: 0 }),

  /* 氛围 / 竞技 / 载具 432~440 */
  S(432, 'AMBIENT_FIREWORK', '庆典烟花发射座', ComponentGroup.AMBIENT, [], { salvo: 5 }),
  S(433, 'ARENA_JELLY_BALL', '巨型果冻足球生成座', ComponentGroup.ARENA_CORE, [], {}),
  S(434, 'ARENA_CROWN_PEDESTAL', '争夺战金皇冠底座', ComponentGroup.ARENA_CORE, [], { roundSeconds: 180 }),
  S(435, 'ARENA_TEAM_BANNER', '四色队伍出生复活旗', ComponentGroup.ARENA_CORE, [], { team: 0 }),
  S(436, 'ARENA_REFEREE_DESK', '派对裁判控制哨台', ComponentGroup.ARENA_CORE, [WireColor.RED, WireColor.BLUE, WireColor.YELLOW, WireColor.GREEN], {}),
  S(437, 'VEHICLE_LOCOMOTIVE', '叮当蒸汽小火车头', ComponentGroup.VEHICLE, [], { crushDamage: 150 }),
  S(438, 'VEHICLE_WAGON', '观光与货运矿车厢', ComponentGroup.VEHICLE, [], {}),
  S(439, 'VEHICLE_SWAN_BOAT', '双人天鹅脚踏船', ComponentGroup.VEHICLE, [], {}),
  S(440, 'VEHICLE_AIRSHIP', '八人云海探险飞艇', ComponentGroup.VEHICLE, [], { seats: 8 }),
]);

/** ID → 规格。 */
export const SPEC_BY_ID: ReadonlyMap<number, ComponentSpec> = new Map(COMPONENT_SPECS.map((s) => [s.id, s]));

/**
 * 每类逻辑件 `state` 的**初值表**。
 *
 * 任何外部读取(`comp.state.shots`、UI 面板、存档)都必须在第 0 帧就拿到
 * 确定数值,而不是 `undefined`。缺初值是「期望 0 / 实际 undefined」这类
 * 报错的唯一来源 —— 行为实现里只在条件分支中 `setSt` 是不够的。
 */
export const STATE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  SENSOR_PLATE_LIGHT: { pressed: 0 },
  SENSOR_PLATE_HEAVY: { pressed: 0, weight: 0 },
  SENSOR_LEVER: { on: 0 },
  SENSOR_PULSE_BUTTON: { remain: 0, lit: 0 },
  SENSOR_LIGHT_DAYNIGHT: { night: 0 },
  SENSOR_WATER_LEVEL: { wet: 0 },
  SENSOR_LASER_TRIPWIRE: { lit: 0 },
  SENSOR_PITCH: { matched: 0 },
  SENSOR_CHEST_FULL: { full: 0 },

  ARENA_GOAL_FRAME: { scoreRed: 0, scoreBlue: 0, lastKey: -1 },
  ARENA_START_GATE: { open: 0, raceRunning: 0, elapsedTicks: 0, startTick: 0 },
  ARENA_FINISH_PODIUM: { finished: 0, finishMs: 0 },

  LOGIC_DELAY_RELAY: { lastTrigger: 0 },
  LOGIC_AND: { out: 0 },
  LOGIC_NOT: { out: 0 },
  LOGIC_SPLITTER: { seed: 0x2545f491, route: -1, rolls: 0, lastTrigger: 0 },

  DISPLAY_COUNTER: { value: 0, count: 0, lastPulse: 0 },

  WIRELESS_LINK: { channel: 1, broadcasting: 0 },

  ACT_NOTE_BLOCK: { playing: 0, notesPlayed: 0, lastPitch: 0, lastTimbre: 0 },
  ACT_RGB_LAMP: { lit: 0, colorIndex: 0 },
  ACT_HIDDEN_WALL: { sunk: 0, solid: 1 },
  ACT_LAUNCH_SPRING: { launches: 0, cooldown: 0, armed: 0 },
  ACT_ROTATOR: { angleQ: 0, spinning: 0 },
  ACT_PISTON_ARM: { extended: 0, strokes: 0 },

  DEF_BUBBLE_BALLISTA: { shots: 0, cooldown: 0, firing: 0 },

  AGRI_SPRINKLER: { active: 0, wetCells: 0 },
  WATER_SLUICE_GATE: { open: 0, flowRate: 0 },

  LOGISTICS_CONVEYOR: { running: 0, dir: 1, movedCells: 0 },
  LOGISTICS_SORTER: { running: 0, filterId: 0, routed: 0 },
  LOGISTICS_ARM: { powered: 0, delivered: 0, idleCycles: 0 },
  LOGISTICS_DRILL: { powered: 0, oreId: 0, produced: 0 },

  AMBIENT_FIREWORK: { shells: 0, launched: 0, lastFire: 0 },
  ARENA_JELLY_BALL: { ballAlive: 0, spawned: 0, lastSpawn: 0 },
  ARENA_CROWN_PEDESTAL: { running: 0, remainTicks: 0, holderTicks: 0 },
  ARENA_TEAM_BANNER: { revives: 0 },
  ARENA_REFEREE_DESK: { mode: 0, running: 0 },

  VEHICLE_LOCOMOTIVE: { moving: 0, crushes: 0, lastCrushDamage: 0, contact: 0 },
  VEHICLE_WAGON: { coupled: 0, riders: 0 },
  VEHICLE_SWAN_BOAT: { afloat: 0, rows: 0, riderCount: 0 },
  VEHICLE_AIRSHIP: { flying: 0, crew: 0 },
});

/** kind → 规格。 */
export const SPEC_BY_KIND: ReadonlyMap<string, ComponentSpec> = new Map(COMPONENT_SPECS.map((s) => [s.kind, s]));

/* ══════════════════════════ 行为实现 ══════════════════════════ */

/** 读「该件所在格是否有实体」的外界信号:由世界层通过 ctx.param 注入。 */
const P_ENTITY_COUNT = 'entityCount';
const P_ENTITY_WEIGHT = 'entityWeight';
const P_FLUID = 'fluid';

function out(ctx: ComponentContext, color: WireColor, on: boolean): void {
  ctx.write(color, on);
}

/** 401 轻触木质压力板:任何玩家/动物/掉落物压上 → 输出 1。 */
registerComponentKind('SENSOR_PLATE_LIGHT', (ctx) => {
  const pressed = ctx.param(P_ENTITY_COUNT) > 0;
  for (const c of ctx.comp.outputs) out(ctx, c, pressed);
});

/** 402 双人重物压力板:总重量 ≥ 2 才输出 1。 */
registerComponentKind('SENSOR_PLATE_HEAVY', (ctx) => {
  const need = Math.max(2, ctx.param('requiredWeight') || 2);
  const weight = ctx.param(P_ENTITY_WEIGHT);
  const on = weight >= need;
  for (const c of ctx.comp.outputs) out(ctx, c, on);
});

/** 403 双态机械拉杆:玩家点击翻转,常开/常闭两态。 */
registerComponentKind('SENSOR_LEVER', (ctx) => {
  const toggled = ctx.param('togglePulse') > 0;
  const v = toggled ? 1 - ctx.st('on') : ctx.st('on');
  ctx.setSt('on', v);
  for (const c of ctx.comp.outputs) out(ctx, c, v === 1);
});

/** 404 瞬时脉冲按钮:按下后 0.5s(1 帧)高电平随后弹回。 */
registerComponentKind('SENSOR_PULSE_BUTTON', (ctx) => {
  const pressed = ctx.param('pressed') > 0;
  const remain = ctx.st('remain');
  const lit = pressed || remain > 0;
  if (pressed && remain === 0) ctx.setSt('remain', Math.max(1, ctx.param('pulseTicks') || PULSE_BUTTON_TICKS));
  else if (remain > 0) ctx.setSt('remain', remain - 1);
  for (const c of ctx.comp.outputs) out(ctx, c, lit);
});

/** 405 昼夜星光感光器:夜晚输出 1,白天输出 0。 */
registerComponentKind('SENSOR_LIGHT_DAYNIGHT', (ctx) => {
  const hour = ctx.param('hour');
  const forceNight = ctx.param('night') > 0;
  const on = forceNight || isNight(hour);
  for (const c of ctx.comp.outputs) out(ctx, c, on);
});

/** 406 河道水位传感器:所在格有水体漫入 → 输出 1。 */
registerComponentKind('SENSOR_WATER_LEVEL', (ctx) => {
  const on = ctx.param(P_FLUID) > 0;
  for (const c of ctx.comp.outputs) out(ctx, c, on);
});

/** 407 红外激光绊线柱:有实体穿过 → 输出 1 帧脉冲。 */
registerComponentKind('SENSOR_LASER_TRIPWIRE', (ctx) => {
  const crossed = ctx.param('crossed') > 0;
  const lit = crossed;
  for (const c of ctx.comp.outputs) out(ctx, c, lit);
});

/** 408 共鸣音高传感器:玩家弹出指定音高 → 输出 1。 */
registerComponentKind('SENSOR_PITCH', (ctx) => {
  const played = ctx.param('playedPitch');
  const target = ctx.param('pitch');
  const tol = ctx.param('tolerance');
  const heard = ctx.param('pitchActive') > 0;
  const on = heard && pitchMatches(played, target, tol);
  for (const c of ctx.comp.outputs) out(ctx, c, on);
});

/** 409 仓库满载传感器:旁边储物箱满载 → 输出 1。 */
registerComponentKind('SENSOR_CHEST_FULL', (ctx) => {
  const on = ctx.param('chestFull') > 0;
  for (const c of ctx.comp.outputs) out(ctx, c, on);
});

/** 410 红蓝计分球门框:球滚入 → 该队 +1 并向对应色输出脉冲(边沿触发,不重复计分)。 */
registerComponentKind('ARENA_GOAL_FRAME', (ctx) => {
  const scored = ctx.param('scored') > 0;
  const team = ctx.param('team') & 1;
  /* 以 (scored, team) 组合做边沿键:同一队持续入球状态只计 1 次 */
  const key = scored ? team : -1;
  if (key >= 0 && ctx.st('lastKey') !== key) {
    ctx.setSt(team === 0 ? 'scoreRed' : 'scoreBlue', ctx.st(team === 0 ? 'scoreRed' : 'scoreBlue') + 1);
  }
  ctx.setSt('lastKey', key);
  out(ctx, team === 0 ? WireColor.RED : WireColor.BLUE, scored);
});

/** 411 跑酷起点发令门:通电或吹哨 → 门栏降下并开启全员计时(共享比赛时钟)。 */
registerComponentKind('ARENA_START_GATE', (ctx) => {
  const go = ctx.readAt(0, 0, WireColor.RED) || ctx.param('whistle') > 0;
  ctx.setSt('open', go ? 1 : 0);
  if (go && ctx.race.running === 0) {
    ctx.race.running = 1;
    ctx.race.startTick = ctx.tick;
    ctx.race.elapsedTicks = 0;
  } else if (go) {
    ctx.race.elapsedTicks = ctx.tick - ctx.race.startTick;
  }
  ctx.setSt('raceRunning', ctx.race.running);
  ctx.setSt('elapsedTicks', ctx.race.elapsedTicks);
  ctx.setSt('startTick', ctx.race.startTick);
  out(ctx, WireColor.YELLOW, go);
});

/** 412 跑酷终点领奖台:玩家踏上 → 停表并向黄线输出脉冲。 */
registerComponentKind('ARENA_FINISH_PODIUM', (ctx) => {
  const arrived = ctx.param('onPodium') > 0;
  const running = ctx.race.running > 0;
  if (arrived && running) {
    if (ctx.race.finishMs === 0) {
      ctx.race.finishMs = ctx.param('nowMs') > 0
        ? ctx.param('nowMs')
        : Math.round(ctx.race.elapsedTicks * 500);
      ctx.race.running = 0;
    }
    ctx.setSt('finished', 1);
    ctx.setSt('finishMs', ctx.race.finishMs);
  }
  out(ctx, WireColor.YELLOW, arrived && running);
});

/**
 * 413 可调延时继电器:四档 0.2/0.5/1.0/2.0s。
 * 在 2Hz 下量化为 1/1/2/4 帧 — 0.2s 与 0.5s 都落在同一帧,
 * 这是低频帧的物理上限,文档 §5 有量化表。
 * `latencyTicks` 由档位动态设定,故此处直接入队而非用固定延迟。
 */
registerComponentKind('LOGIC_DELAY_RELAY', (ctx) => {
  const inColor = (ctx.param('inputColor') as WireColor) ?? WireColor.RED;
  const input = ctx.readAt(0, 0, inColor) || ctx.readWire(inColor);
  const ticks = relayTicksFor(ctx.param('setting'));
  const key = `relay:${ticks}`;
  if (ctx.comp.lastOut[key] === (input ? 1 : 0)) return;
  ctx.comp.lastOut[key] = input ? 1 : 0;
  /* 覆盖 latencyTicks 的等效做法:直接按档位入队 */
  ctx.comp.pending.push({
    tick: ctx.tick + ticks,
    color: WireColor.YELLOW,
    on: input,
    cell: -1,
  });
});

/** 414 魔能逻辑与门 (AND):红线 ∩ 蓝线 → 黄线。 */
registerComponentKind('LOGIC_AND', (ctx) => {
  const a = ctx.readWire((ctx.param('inA') as WireColor) ?? WireColor.RED);
  const b = ctx.readWire((ctx.param('inB') as WireColor) ?? WireColor.BLUE);
  out(ctx, WireColor.YELLOW, a && b);
});

/** 415 魔能逻辑非门 (NOT):输入 0 → 输出 1。 */
registerComponentKind('LOGIC_NOT', (ctx) => {
  const a = ctx.readWire((ctx.param('inA') as WireColor) ?? WireColor.RED);
  out(ctx, WireColor.YELLOW, !a);
});

/**
 * 416 随机轮盘分流器:收到脉冲时随机向东/南/西三路中的一路输出。
 * 使用 xorshift32 保证可复现;三路输出色分别为 RED/BLUE/GREEN(黄线不参与)。
 */
registerComponentKind('LOGIC_SPLITTER', (ctx) => {
  const trigger = ctx.param('trigger') > 0 || ctx.readWire(WireColor.YELLOW);
  const seed = (ctx.st('seed') || ctx.param('seed') || 0x2545f491) | 0;
  if (trigger && ctx.st('lastTrigger') === 0) {
    const next = nextRandom(seed);
    ctx.setSt('seed', next);
    const unit = randomUnit(next);
    const route = chooseSplitterRoute(unit);
    ctx.setSt('route', route);
    ctx.setSt('rolls', ctx.st('rolls') + 1);
    for (let i = 0; i < SPLITTER_ROUTES.length; i += 1) {
      ctx.write(SPLITTER_ROUTES[i], i === route);
    }
  } else if (!trigger) {
    for (let i = 0; i < SPLITTER_ROUTES.length; i += 1) {
      ctx.write(SPLITTER_ROUTES[i], false);
    }
  }
  ctx.setSt('lastTrigger', trigger ? 1 : 0);
});

/** 417 0-99 翻页计数器:每次收到脉冲 +1,到 100 回卷 0。 */
registerComponentKind('DISPLAY_COUNTER', (ctx) => {
  const inColor = (ctx.param('inputColor') as WireColor) ?? WireColor.RED;
  const pulse = ctx.param('pulse') > 0 || ctx.readWire(inColor);
  const prev = ctx.st('lastPulse');
  const value = ctx.st('value');
  if (pulse && prev === 0) {
    ctx.setSt('value', counterStep(value, true));
    ctx.setSt('count', ctx.st('count') + 1);
  }
  ctx.setSt('lastPulse', pulse ? 1 : 0);
  const v = ctx.st('value');
  /* 十位驱动黄线,个位驱动绿线,便于外部直接读显示值 */
  out(ctx, WireColor.YELLOW, v >= 10);
  out(ctx, WireColor.GREEN, v % 10 >= 5);
});

/**
 * 418 无线信号发射塔:把**本地输入**广播到同频道;并把频道态(本地 ∪ 远端)
 * 镜像到黄线输出,供同频道接收器反向联动。
 *
 * 关键:`broadcast` **只取本地输入**。若把远端态也写回频道,接收器会把自己
 * 读到的 1 再写成 1,频道被自锁在高位、永远无法归零(实测踩到的坑)。
 */
registerComponentKind('WIRELESS_LINK', (ctx) => {
  const ch = ctx.param('channel') || CHANNEL_MIN;
  const localInput = ctx.readWire(WireColor.RED) || ctx.param('input') > 0;
  ctx.writeChannel(ch, localInput);
  const link = ctx.readChannel(ch);
  out(ctx, WireColor.YELLOW, link);
  ctx.setSt('channel', ch);
  ctx.setSt('broadcasting', localInput ? 1 : 0);
});

/** 419 32 音高八音盒音符砖:通电或踩踏时播放设定音高(4 种音色)。 */
registerComponentKind('ACT_NOTE_BLOCK', (ctx) => {
  const powered = ctx.readWire(WireColor.RED) || ctx.param('stepped') > 0;
  const was = ctx.st('playing');
  ctx.setSt('playing', powered ? 1 : 0);
  if (powered && was === 0) {
    ctx.setSt('lastPitch', ctx.param('pitch') & 31);
    ctx.setSt('lastTimbre', ctx.param('timbre') & 3);
    ctx.setSt('notesPlayed', ctx.st('notesPlayed') + 1);
  }
});

/** 420 16 色 RGB 像素灯箱:通电点亮,扳手切换颜色。 */
registerComponentKind('ACT_RGB_LAMP', (ctx) => {
  const lit = ctx.readWire(WireColor.RED) || ctx.param('manual') > 0;
  ctx.setSt('lit', lit ? 1 : 0);
  ctx.setSt('colorIndex', ctx.param('colorIndex') & 0xf);
});

/** 421 升降隐藏机关墙:通电沉入地下(可通行),断电升起(阻挡)。 */
registerComponentKind('ACT_HIDDEN_WALL', (ctx) => {
  const powered = ctx.readWire(WireColor.RED);
  ctx.setSt('sunk', powered ? 1 : 0);
  ctx.setSt('solid', powered ? 0 : 1);
});

/**
 * 422 万向弹射弹簧垫:通电**且上方有载荷**时弹射一次。
 *
 * 采用**边沿触发**:持续通电不会反复弹射 —— 弹簧垫是「踩上去弹一次」的装置,
 * 不是「通电就一直喷」的发射器。冷却期只用于限制「持续通电 + 载荷不断刷新」
 * 场景下的连发速率(实测踩到的坑:电平触发会导致冷却结束后立刻二次弹射)。
 */
registerComponentKind('ACT_LAUNCH_SPRING', (ctx) => {
  const powered = ctx.readWire(WireColor.RED);
  const hasPayload = ctx.param('payloadAbove') > 0;
  const cd = ctx.st('cooldown');
  const wasArmed = ctx.st('armed');
  const armed = powered && hasPayload;
  if (armed && wasArmed === 0 && cd === 0) {
    ctx.setSt('launches', ctx.st('launches') + 1);
    ctx.setSt('cooldown', SPRING_COOLDOWN_TICKS);
  } else if (cd > 0) {
    ctx.setSt('cooldown', cd - 1);
  }
  ctx.setSt('armed', armed ? 1 : 0);
});

/** 423 360° 大风车旋转推杆:通电即持续旋转,扫飞接触者。 */
registerComponentKind('ACT_ROTATOR', (ctx) => {
  const powered = ctx.readWire(WireColor.RED);
  ctx.setSt('angleQ', (ctx.st('angleQ') + (powered ? 1 : 0)) & 0xff);
  ctx.setSt('spinning', powered ? 1 : 0);
});

/** 424 伸缩推拉活塞臂:通电伸出 1 格,断电缩回。 */
registerComponentKind('ACT_PISTON_ARM', (ctx) => {
  const powered = ctx.readWire(WireColor.RED);
  const was = ctx.st('extended');
  ctx.setSt('extended', powered ? 1 : 0);
  if (was !== (powered ? 1 : 0)) ctx.setSt('strokes', ctx.st('strokes') + 1);
});

/** 425 自动泡泡连弩炮台:通电即自动索敌,半径 7 格内开火。 */
registerComponentKind('DEF_BUBBLE_BALLISTA', (ctx) => {
  const powered = ctx.readWire(WireColor.RED) || ctx.param('loaded') > 0;
  if (!powered) {
    ctx.setSt('firing', 0);
    return;
  }
  const cd = ctx.st('cooldown');
  if (cd > 0) {
    ctx.setSt('cooldown', cd - 1);
    ctx.setSt('firing', 0);
    return;
  }
  const target = ctx.param('enemyInRange') > 0;
  if (target) {
    ctx.setSt('shots', ctx.st('shots') + 1);
    ctx.setSt('cooldown', 1);
    ctx.setSt('firing', 1);
  }
});

/** 426 旋转自动洒水器:接通水源或每早自动旋转,浇湿周围 5×5 耕地。 */
registerComponentKind('AGRI_SPRINKLER', (ctx) => {
  const powered = ctx.readWire(WireColor.BLUE) || (ctx.param('hour') === 6 && ctx.param('morningTick') > 0);
  ctx.setSt('active', powered ? 1 : 0);
  if (powered) ctx.setSt('wetCells', 25);
});

/** 427 电动升降拦水闸门:通电开闸放水,断电关闭蓄水。 */
registerComponentKind('WATER_SLUICE_GATE', (ctx) => {
  const powered = ctx.readWire(WireColor.BLUE);
  ctx.setSt('open', powered ? 1 : 0);
  ctx.setSt('flowRate', powered ? 100 : 0);
});

/** 428 定向物流传送带:通电运行,每秒 1 格(2Hz 下每 2 帧 1 格)。 */
registerComponentKind('LOGISTICS_CONVEYOR', (ctx) => {
  const powered = ctx.readWire(WireColor.GREEN) || ctx.param('manual') > 0;
  ctx.setSt('running', powered ? 1 : 0);
  ctx.setSt('dir', ctx.param('dir') & 3);
});

/** 429 智能分拣交叉带:通电运行,按过滤物品 ID 分流。 */
registerComponentKind('LOGISTICS_SORTER', (ctx) => {
  const powered = ctx.readWire(WireColor.GREEN) || ctx.param('manual') > 0;
  ctx.setSt('running', powered ? 1 : 0);
  ctx.setSt('filterId', ctx.param('filterId'));
});

/** 430 魔能抓取机械臂:通电时每 2.0s 完成一次「抓取 → 投喂」循环。 */
registerComponentKind('LOGISTICS_ARM', (ctx) => {
  const powered = ctx.readWire(WireColor.GREEN) || ctx.param('manual') > 0;
  ctx.setSt('powered', powered ? 1 : 0);
  if (!powered) ctx.setSt('phase', 0);
});

/** 431 自动采矿钻头机:绿线(风力动力网)覆盖时每 10 秒产出 1 块矿石。 */
registerComponentKind('LOGISTICS_DRILL', (ctx) => {
  const powered = ctx.readWire(WireColor.GREEN) || ctx.param('manual') > 0;
  ctx.setSt('powered', powered ? 1 : 0);
  ctx.setSt('oreId', ctx.param('oreId'));
});

/** 432 庆典烟花发射座:通电时向高空连发 5 枚礼花。 */
registerComponentKind('AMBIENT_FIREWORK', (ctx) => {
  const powered = ctx.readWire(WireColor.RED);
  const salvo = Math.max(1, ctx.param('salvo') || 5);
  if (powered && ctx.st('lastFire') === 0) {
    ctx.setSt('shells', ctx.st('shells') + salvo);
    ctx.setSt('launched', ctx.st('launched') + 1);
  }
  ctx.setSt('lastFire', powered ? 1 : 0);
});

/** 433 巨型果冻足球生成座:点击或通电刷出一颗弹性大果冻球。 */
registerComponentKind('ARENA_JELLY_BALL', (ctx) => {
  const powered = ctx.readWire(WireColor.RED) || ctx.param('clicked') > 0;
  if (powered && ctx.st('lastSpawn') === 0 && ctx.st('ballAlive') === 0) {
    ctx.setSt('ballAlive', 1);
    ctx.setSt('spawned', ctx.st('spawned') + 1);
  }
  ctx.setSt('lastSpawn', powered ? 1 : 0);
  if (ctx.param('ballRemoved') > 0) ctx.setSt('ballAlive', 0);
});

/**
 * 434 争夺战金皇冠底座:通电开启 3 分钟抢皇冠赛,统计各人持冠秒数。
 *
 * **计时约定**:第 N 秒存在的充要条件是「比赛已运行满 N 帧」,即
 * `remainTicks` 从 `roundSeconds × 2` 倒数到 0 恰好消耗 `roundSeconds × 2` 帧,
 * 期间 `running` 恒为 1。开赛那一帧**不**倒数(只登记初始值),
 * 因此 360 帧的比赛精确持续 360 个 tick 后结束。
 */
registerComponentKind('ARENA_CROWN_PEDESTAL', (ctx) => {
  const powered = ctx.readWire(WireColor.RED) || ctx.param('start') > 0;
  const running = ctx.st('running') > 0;
  if (powered && !running) {
    ctx.setSt('running', 1);
    ctx.setSt('remainTicks', (ctx.param('roundSeconds') || 180) * TICKS_PER_SECOND);
  } else if (running) {
    const remain = ctx.st('remainTicks') - 1;
    ctx.setSt('remainTicks', remain);
    if (ctx.param('holder') > 0) ctx.setSt('holderTicks', ctx.st('holderTicks') + 1);
    if (remain <= 0) ctx.setSt('running', 0);
  }
});

/** 435 四色队伍出生复活旗:按队伍归属输出对应色,供复活点判定。 */
registerComponentKind('ARENA_TEAM_BANNER', (ctx) => {
  const team = ctx.param('team') & 3;
  const color = ALL_COLORS[team];
  if (ctx.param('revivePulse') > 0) ctx.setSt('revives', ctx.st('revives') + 1);
  out(ctx, color, true);
});

/** 436 派对裁判控制哨台:一键开启四种竞技模式,并把模式位广播到四色线。 */
registerComponentKind('ARENA_REFEREE_DESK', (ctx) => {
  const cmd = ctx.param('mode') | 0;
  if (cmd > 0 && cmd <= 4) {
    ctx.setSt('mode', cmd);
    ctx.setSt('running', 1);
  } else if (cmd === -1) {
    ctx.setSt('mode', 0);
    ctx.setSt('running', 0);
  }
  const mode = ctx.st('mode');
  for (let b = 0; b < ALL_COLORS.length; b += 1) {
    out(ctx, ALL_COLORS[b], mode === b + 1);
  }
});

/**
 * 437 叮当蒸汽小火车头:通电沿轨道行驶,碾压 150 伤害。
 *
 * 碾压**边沿触发**:同一只怪被碾一次即结算一次,持续接触不重复计数
 * (实测踩到的坑:电平触发会在每个 2Hz 帧重复结算,一帧碾出 2 次伤害)。
 */
registerComponentKind('VEHICLE_LOCOMOTIVE', (ctx) => {
  const powered = ctx.readWire(WireColor.GREEN) || ctx.param('fueled') > 0;
  const contact = powered && ctx.param('hitMob') > 0;
  ctx.setSt('moving', powered ? 1 : 0);
  if (contact && ctx.st('contact') === 0) {
    ctx.setSt('crushes', ctx.st('crushes') + 1);
    ctx.setSt('lastCrushDamage', ctx.param('crushDamage') || 150);
  }
  ctx.setSt('contact', contact ? 1 : 0);
});

/** 438 观光与货运矿车厢:挂在火车头后随动,通电时提供移动射击平台。 */
registerComponentKind('VEHICLE_WAGON', (ctx) => {
  const coupled = ctx.param('coupled') > 0;
  ctx.setSt('coupled', coupled ? 1 : 0);
  ctx.setSt('riders', ctx.param('riderCount'));
});

/** 439 双人天鹅脚踏船:放入水体后可 2 人同乘。 */
registerComponentKind('VEHICLE_SWAN_BOAT', (ctx) => {
  const onWater = ctx.param(P_FLUID) > 0;
  const riders = ctx.param('riderCount');
  ctx.setSt('afloat', onWater ? 1 : 0);
  ctx.setSt('rows', ctx.st('rows') + (onWater && riders > 0 ? 1 : 0));
  ctx.setSt('riderCount', Math.min(2, riders));
});

/** 440 八人云海探险飞艇:支持最多 8 人登船飞行。 */
registerComponentKind('VEHICLE_AIRSHIP', (ctx) => {
  const powered = ctx.readWire(WireColor.GREEN) || ctx.param('moored') === 0;
  const seats = Math.max(1, ctx.param('seats') || 8);
  ctx.setSt('flying', powered ? 1 : 0);
  ctx.setSt('crew', Math.min(seats, ctx.param('riderCount')));
});

/* ══════════════════════════ 便捷构造与自检 ══════════════════════════ */

/** 按物品 ID 造一个逻辑件节点(参数取规格默认值,可被 patch 覆盖)。 */
export function makeComponent(
  id: string,
  itemId: number,
  x: number,
  y: number,
  patch: Partial<ComponentNode> = {},
): ComponentNode {
  const spec = SPEC_BY_ID.get(itemId | 0);
  if (!spec) throw new Error(`未知电路物品 ID:${itemId}`);
  const defaults = STATE_DEFAULTS[spec.kind] ?? {};
  return createComponent(id, spec.kind, x, y, {
    outputs: spec.outputs.slice(),
    latencyTicks: spec.latencyTicks,
    params: { ...spec.params, itemId },
    state: { ...defaults },
    ...patch,
  });
}

/** 自检:40 项全部注册且 ID 连续覆盖 401~440。 */
export function auditComponentCoverage(): { total: number; missingKinds: string[]; idGaps: number[] } {
  const missingKinds: string[] = [];
  for (const s of COMPONENT_SPECS) {
    if (!hasComponentKind(s.kind)) missingKinds.push(s.kind);
  }
  const idGaps: number[] = [];
  for (let id = 401; id <= 440; id += 1) if (!SPEC_BY_ID.has(id)) idGaps.push(id);
  return { total: COMPONENT_SPECS.length, missingKinds, idGaps };
}

/** 规格里出现的全部输出颜色(去重),供 UI 画端口图标。 */
export const ALL_OUTPUT_COLORS: readonly WireColor[] = Object.freeze(
  [...new Set(COMPONENT_SPECS.flatMap((s) => [...s.outputs]))].sort((a, b) => a - b),
);

/** 无输出线的「纯效果件」ID 列表(古董/载具/氛围)。 */
export const PURE_EFFECT_IDS: readonly number[] = Object.freeze(
  COMPONENT_SPECS.filter((s) => s.outputs.length === 0).map((s) => s.id),
);

/** 有输出线的「信号件」ID 列表。 */
export const SIGNAL_IDS: readonly number[] = Object.freeze(
  COMPONENT_SPECS.filter((s) => s.outputs.length > 0).map((s) => s.id),
);