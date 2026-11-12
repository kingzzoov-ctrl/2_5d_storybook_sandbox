/**
 * WS-09 / Boss 血条与地面预警圈绘制 —— 纯几何层(不 import three)。
 *
 * 这是全项目「手感」最敏感的一块:Boss 的攻击能不能躲开,完全取决于地面预警圈
 * 画得对不对。因此三个设计决定:
 *
 *  1. **预警圈用世界坐标存,不存屏幕坐标**。2.5D 正交投影下,世界里的圆投影到屏幕是
 *     **椭圆**(x 方向半轴 = r·cos45°·k,y 方向半轴 = r·sin45°·sin35°·k),
 *     如果在屏幕空间存圆,相机一缩放整圈就错位;
 *  2. **环形/扇形/长条/十字**四种几何全部化成「世界多边形顶点表」,
 *     装配层统一按椭圆变换投到屏幕,保证描边宽度一致;
 *  3. **填充进度用 sweep 表示**(0..1),配合 shader 做「扫描式蓄力」,
 *     这是玩家唯一能准确读秒的表现方式。
 */

import { BOSS_LIST } from '../../../shared/constants/bosses.ts';
import type { BossDef, BossPhase } from '../../../shared/types/entities.ts';
import { projectGridToScreen, type IsoCamera } from '../stage/iso_camera.ts';

/** 血条像素尺寸 */
export const HP_BAR_WIDTH = 360;
export const HP_BAR_HEIGHT = 18;
export const HP_BAR_TOP_MARGIN = 24;

/** 四种地面几何 */
export const TelegraphShape = {
  CIRCLE: 'CIRCLE',
  ANNULUS: 'ANNULUS',
  CONE: 'CONE',
  LINE: 'LINE',
  CROSS: 'CROSS',
} as const;
export type TelegraphShape = (typeof TelegraphShape)[keyof typeof TelegraphShape];

export const TELEGRAPH_SHAPES: readonly TelegraphShape[] = ['CIRCLE', 'ANNULUS', 'CONE', 'LINE', 'CROSS'];

export interface TelegraphSpec {
  shape: TelegraphShape;
  /** 中心(世界格) */
  cx: number;
  cy: number;
  cz: number;
  /** 主半径(格) */
  radius: number;
  /** ANNULUS 的内半径 */
  innerRadius?: number;
  /** CONE 的朝向(弧度)与张角 */
  facing?: number;
  spreadRad?: number;
  /** LINE 的长度与宽度 */
  length?: number;
  width?: number;
  /** 蓄力时长(秒) */
  chargeSec: number;
  /** 危险度 0..1,决定红色浓度 */
  danger: number;
}

export interface TelegraphVertex {
  x: number;
  y: number;
  z: number;
}

export interface TelegraphGeometry {
  spec: TelegraphSpec;
  /** 外圈多边形(世界坐标) */
  outer: TelegraphVertex[];
  /** 内圈多边形(ANNULUS / CROSS 副臂才有) */
  inner: TelegraphVertex[];
  /** 圆心世界坐标 */
  center: TelegraphVertex;
  /** 屏幕投影后的外圈(供 2D overlay 直绘) */
  screenOuter: { x: number; y: number }[];
  /**
   * 屏幕投影后的内圈(ANNULUS / CROSS 副臂才非空)。
   *
   * 调用方用 `fill('evenodd')` 同时喂外圈与内圈即可得到真实的「环」;
   * 只填外圈会画成实心盘(见 `buildTelegraph` 里的实测说明)。
   */
  screenInner: { x: number; y: number }[];
  /** 屏幕上的椭圆半轴,供 Canvas2D ctx.ellipse 快路径 */
  screenRadii: { rx: number; ry: number };
}

/** 圆的分段数:半径越大段数越多,但封顶 96 段(单圈最多 96 顶点) */
export function segmentsForRadius(radius: number): number {
  const r = Math.max(0.1, radius);
  return Math.min(96, Math.max(12, Math.ceil(r * 6)));
}

/** 世界圆 → 多边形顶点(默认在 z 平面上) */
export function circleVertices(cx: number, cy: number, cz: number, radius: number, segments?: number): TelegraphVertex[] {
  const n = Math.max(3, Math.trunc(segments ?? segmentsForRadius(radius)));
  const out: TelegraphVertex[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = (2 * Math.PI * i) / n;
    out.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, z: cz });
  }
  return out;
}

/** 扇形(CONE)→ 多边形:圆心 + 弧上 n 点 */
export function coneVertices(cx: number, cy: number, cz: number, radius: number, facing: number, spreadRad: number): TelegraphVertex[] {
  const span = Math.max(0.01, Math.abs(spreadRad));
  const n = Math.max(6, Math.ceil((segmentsForRadius(radius) * span) / (2 * Math.PI)) + 1);
  const out: TelegraphVertex[] = [{ x: cx, y: cy, z: cz }];
  for (let i = 0; i <= n; i += 1) {
    const a = facing - span / 2 + (span * i) / n;
    out.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, z: cz });
  }
  return out;
}

/** 矩形长条(LINE)→ 四边形 */
export function lineVertices(cx: number, cy: number, cz: number, length: number, width: number, facing: number): TelegraphVertex[] {
  const hl = Math.max(0, length) / 2;
  const hw = Math.max(0, width) / 2;
  const dx = Math.cos(facing);
  const dy = Math.sin(facing);
  const px = -dy;
  const py = dx;
  return [
    { x: cx + dx * hl + px * hw, y: cy + dy * hl + py * hw, z: cz },
    { x: cx + dx * hl - px * hw, y: cy + dy * hl - py * hw, z: cz },
    { x: cx - dx * hl - px * hw, y: cy - dy * hl - py * hw, z: cz },
    { x: cx - dx * hl + px * hw, y: cy - dy * hl + py * hw, z: cz },
  ];
}

/** 十字(CROSS)→ 两个互相垂直的四边形(主臂 + 副臂) */
export function crossVertices(cx: number, cy: number, cz: number, length: number, width: number): TelegraphVertex[][] {
  return [
    lineVertices(cx, cy, cz, length, width, 0),
    lineVertices(cx, cy, cz, length, width, Math.PI / 2),
  ];
}

/**
 * 生成预警圈几何。
 * 复杂度 O(段数),段数 ≤ 96。
 */
export function buildTelegraph(spec: TelegraphSpec, cam: IsoCamera): TelegraphGeometry {
  const { cx, cy, cz = 0, radius } = spec;
  const segs = segmentsForRadius(radius);
  let outer: TelegraphVertex[];
  let inner: TelegraphVertex[] = [];

  switch (spec.shape) {
    case 'ANNULUS': {
      const ri = Math.max(0, Math.min(radius, spec.innerRadius ?? radius * 0.5));
      outer = circleVertices(cx, cy, cz, radius, segs);
      inner = circleVertices(cx, cy, cz, ri, segs);
      break;
    }
    case 'CONE':
      outer = coneVertices(cx, cy, cz, radius, spec.facing ?? 0, spec.spreadRad ?? Math.PI / 3);
      break;
    case 'LINE':
      outer = lineVertices(cx, cy, cz, spec.length ?? radius * 2, spec.width ?? 0.8, spec.facing ?? 0);
      break;
    case 'CROSS': {
      const parts = crossVertices(cx, cy, cz, spec.length ?? radius * 2, spec.width ?? 0.8);
      outer = parts[0];
      inner = parts[1];
      break;
    }
    default:
      outer = circleVertices(cx, cy, cz, radius, segs);
      break;
  }

  const screenOuter = outer.map((v) => {
    const p = projectGridToScreen(v.x, v.y, v.z, cam);
    return { x: p.x, y: p.y };
  });
  /**
   * 内圈的屏幕投影。
   *
   * ## 为什么必须提供(实测踩过)
   *
   * `ANNULUS` 的语义是**环**,中间要挖空。调用方只拿到 `screenOuter` 时
   * 只能填成一个**实心圆盘** —— 第一版 UI 覆盖层就是这样,
   * 地面预警"圈"变成一大坨橙色实心块,把立牌全糊住了。
   *
   * 内圈本来就已经算好了(`inner`),只是没投影。这里补上投影,
   * 由调用方用 `evenodd` 填充规则挖空(不能只画内圈描边 —— 那不挖空)。
   *
   * 非 ANNULUS/CROSS 的 shape 内圈为空数组,此时退化为实心多边形,
   * 与「CIRCLE 就该是实心圆」的语义一致。
   */
  const screenInner = inner.map((v) => {
    const p = projectGridToScreen(v.x, v.y, v.z, cam);
    return { x: p.x, y: p.y };
  });

  /* 椭圆半轴:世界圆在屏幕上的投影(用于 Canvas2D 快路径) */
  const k = cam.scale * cam.zoom;
  const screenRadii = {
    rx: radius * Math.SQRT1_2 * k,
    ry: radius * Math.SQRT1_2 * Math.sin((35 * Math.PI) / 180) * k,
  };

  return { spec, outer, inner, center: { x: cx, y: cy, z: cz }, screenOuter, screenInner, screenRadii };
}

/** 蓄力进度 0..1(帧率无关的线性推进,便于玩家读秒) */
export function chargeProgress(elapsedSec: number, chargeSec: number): number {
  const total = Math.max(1e-3, chargeSec);
  return Math.min(1, Math.max(0, elapsedSec / total));
}

/** 危险度 → 填充色(红→橙→黄渐变,低危险偏黄) */
export function dangerColor(danger: number): string {
  const d = Math.min(1, Math.max(0, danger));
  const g = Math.round(220 - d * 160);
  const b = Math.round(60 - d * 40);
  return `rgb(255,${g},${b})`;
}

/** 预警圈描边宽度(像素),随缩放微调但有下界,保证小圈也看得见 */
export function telegraphStrokePx(zoom: number): number {
  return Math.max(1.5, Math.min(4, 1.5 + zoom));
}

/* ───────────────────── Boss 血条 ───────────────────── */

export interface HpBarLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 血量比例 0..1 */
  ratio: number;
  /** 已损失的「残影」比例(用于显示刚掉的血,常见做法叫 ghost bar) */
  ghostRatio: number;
  /** 阶段刻度在条上的 x 位置 */
  ticks: number[];
  /** 当前阶段索引 */
  phaseIndex: number;
  /** 阶段名 */
  phaseName: string;
}

/** Boss 血条布局;viewportW 用于水平居中 */
export function layoutHpBar(
  bossBaseHp: number,
  currentHp: number,
  viewportW: number,
  phases: readonly BossPhase[],
): HpBarLayout {
  const base = Math.max(1, bossBaseHp);
  const ratio = Math.min(1, Math.max(0, currentHp / base));
  const width = Math.min(HP_BAR_WIDTH, Math.max(120, viewportW - 80));
  const x = (viewportW - width) / 2;
  const ticks: number[] = [];
  for (const p of phases) {
    const th = Math.min(1, Math.max(0, p.hpThreshold));
    ticks.push(x + th * width);
  }
  ticks.sort((a, b) => a - b);

  /* 阶段:血量低于阈值即进入该阶段,取最靠后的满足项 */
  let phaseIndex = 0;
  let phaseName = phases.length > 0 ? phases[0].name : '';
  for (let i = 0; i < phases.length; i += 1) {
    if (ratio <= phases[i].hpThreshold) {
      phaseIndex = i;
      phaseName = phases[i].name;
    }
  }

  return {
    x,
    y: HP_BAR_TOP_MARGIN,
    width,
    height: HP_BAR_HEIGHT,
    ratio,
    ghostRatio: ratio,
    ticks,
    phaseIndex,
    phaseName,
  };
}

/** 残影条衰减(按指数衰减收敛到 ratio) */
export function decayGhost(ghostRatio: number, ratio: number, dt: number, halfLifeSec = 0.45): number {
  if (ghostRatio <= ratio) return ratio;
  const k = Math.pow(0.5, Math.abs(dt) / Math.max(1e-3, halfLifeSec));
  const next = ratio + (ghostRatio - ratio) * k;
  return next < ratio ? ratio : next;
}

/** 血量文本 */
export function hpBarText(currentHp: number, maxHp: number): string {
  const c = Math.max(0, Math.round(currentHp));
  const m = Math.max(1, Math.round(maxHp));
  return `${c} / ${m}(${((c / m) * 100).toFixed(1)}%)`;
}

/* ───────────────────── 全部 8 个 Boss 的预警几何登记 ───────────────────── */

export interface BossTelegraphRow {
  bossId: string;
  bossName: string;
  phaseIndex: number;
  phaseName: string;
  hpThreshold: number;
  shape: TelegraphShape;
  radius: number;
  chargeSec: number;
  danger: number;
  note: string;
}

function detectShape(text: string): TelegraphShape {
  if (/环|圈状|扇形环|双环/.test(text)) return 'ANNULUS';
  if (/扇形|锥|扇面/.test(text)) return 'CONE';
  if (/十字|交叉/.test(text)) return 'CROSS';
  if (/直线|条形|带状|矩形|射线|指针|长条|细长/.test(text)) return 'LINE';
  return 'CIRCLE';
}

function defaultRadius(shape: TelegraphShape): number {
  if (shape === 'LINE') return 12;
  if (shape === 'CONE') return 8;
  if (shape === 'ANNULUS') return 9;
  if (shape === 'CROSS') return 10;
  return 6;
}

function defaultCharge(shape: TelegraphShape): number {
  if (shape === 'CIRCLE') return 1.2;
  if (shape === 'ANNULUS') return 1.6;
  if (shape === 'CONE') return 1.0;
  if (shape === 'LINE') return 0.9;
  return 1.4;
}

/**
 * 从冻结层 `BOSS_LIST` 的 `phases[].telegraph` 文本抽形状关键词与半径。
 * 例如「以自身为中心的红色圆环(半径 3.5 格,持续 0.8s)」→ ANNULUS 半径 3.5。
 * 复杂度 O(8 个 Boss × 阶段数)。
 */
export function buildBossTelegraphTable(): BossTelegraphRow[] {
  const rows: BossTelegraphRow[] = [];
  for (const b of BOSS_LIST) {
    for (let i = 0; i < b.phases.length; i += 1) {
      const ph = b.phases[i];
      const text = `${ph.telegraph} ${ph.skill}`;
      const shape = detectShape(text);
      const rMatch = /(\d+(?:\.\d+)?)\s*格/.exec(text);
      const radius = rMatch ? Number(rMatch[1]) : defaultRadius(shape);
      rows.push({
        bossId: b.id,
        bossName: b.name,
        phaseIndex: i,
        phaseName: ph.name,
        hpThreshold: ph.hpThreshold,
        shape,
        radius,
        chargeSec: defaultCharge(shape),
        danger: shape === 'CIRCLE' ? 0.6 : 0.85,
        note: ph.telegraph,
      });
    }
  }
  return rows;
}

/** Boss 血条上方的阶段标签列表(UI 顶部小图标) */
export function phaseLabels(boss: Pick<BossDef, 'phases'>): string[] {
  return boss.phases.map((p) => `${p.name}(${(p.hpThreshold * 100).toFixed(0)}%)`);
}

/** 校验:8 个 Boss 的 hpThreshold 应严格递减且首项为 1.0 */
export function validatePhaseThresholds(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const b of BOSS_LIST) {
    for (let i = 1; i < b.phases.length; i += 1) {
      if (b.phases[i].hpThreshold >= b.phases[i - 1].hpThreshold) {
        errors.push(`${b.id} 阶段 ${i} 阈值 ${b.phases[i].hpThreshold} 未严格递减`);
      }
    }
    if (b.phases.length > 0 && Math.abs(b.phases[0].hpThreshold - 1) > 1e-9) {
      errors.push(`${b.id} 首阶段阈值 ${b.phases[0].hpThreshold} ≠ 1.0`);
    }
  }
  return { ok: errors.length === 0, errors };
}