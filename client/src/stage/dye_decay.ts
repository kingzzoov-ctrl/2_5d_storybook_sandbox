/**
 * WS-09 U5(4.3 U11 的消费点)/ **染色距离衰减曲线** —— client 侧的唯一读点。
 *
 * ## 曲线本体在哪(单一事实源)
 *
 * 曲线本身(端点语义 + 单调性)住在冻结层 `shared/constants/dye.ts` 的
 * `dyeAttenuation(dist, range)`(owner 2026-11-17 授权冻结层解锁,登记见
 * `shared/contracts/FREEZE.md` 的 D-19 条)。本文件**不再自己定义采样点数组**:
 * 早先 client 侧有一份 6 点折线的副本,与冻结层口径不一致(同一枪 UI 读到 0.72、
 * 服务端按线性记 0.5),那正是「同一枪两边看到的颜色不同」的来源。
 *
 * ## 为什么 client 侧还需要这一层
 *
 *   · 射程(`range`)由玩法决定 —— 冻结层**刻意不发明数值**(射程由调用方传入),
 *     所以「本仓射程是多少格」必须由消费方钉住:`DYE_DECAY_FAR_CELLS`。
 *   · 「颜色 = 基色 × 距离衰减」这一乘法只允许一处(`dyeDecayColor`)。
 *     一旦 UI 一处、着色器一处、录制回放一处各自乘,准星预览的颜色就会
 *     与真正喷上去的颜色不同,而两边都"看起来合理"。
 *
 * ## 判据口径(期望值取自字面量,不取自本模块)
 *
 *   · 端点:`dyeDecayAt(0) === 1`、`dyeDecayAt(30) === 0`;
 *   · 全程不增(线性 ⇒ 严格递减),中点 `dyeDecayAt(15) === 0.5`;
 *   · 与冻结层**逐点相等**(证明消费点没有另一套算法);
 *   · 端点颜色分别等于基色与全黑,沿距离亮度单调下降。
 */

import { dyeAttenuation } from '../../../shared/constants/dye.ts';

/** 喷枪射程上界(格):作为曲线的 `range` 传入,达到即完全无效 */
export const DYE_DECAY_FAR_CELLS = 30;

/** 曲线源(单一事实源)。判据用它证明本文件不是另一份曲线副本 */
export const DYE_DECAY_CURVE_SOURCE = 'shared/constants/dye.ts';

/**
 * 距离(格)→ 衰减系数,分段线性插值。
 *
 * 端点语义**刻意不对称**:负数/0 格 = 1(贴脸),≥30 格 = 0(无效)。
 * 负数取 1 而不是 0 是因为喷枪可能报告"负距离"(玩家站在墙里),
 * 那种情况下必须按最强处理,否则玩家会看到"贴脸喷不出来"的怪 bug。
 */
export function dyeDecayAt(distance: number): number {
  return dyeAttenuation(distance, DYE_DECAY_FAR_CELLS);
}

export interface RgbColor {
  /** 0..1 */
  r: number;
  /** 0..1 */
  g: number;
  /** 0..1 */
  b: number;
}

/** `#RRGGBB` / `#RGB` → 0..1 的 RGB;非法输入返回全白(安全默认) */
export function parseHexColor(hex: string): RgbColor {
  const s = hex.trim().replace(/^#/, '');
  const full = s.length === 3
    ? s.split('').map((c) => c + c).join('')
    : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return { r: 1, g: 1, b: 1 };
  const n = Number.parseInt(full, 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}

function to255(v: number): number {
  const x = Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

/** 0..1 RGB → `rgb(r,g,b)`(与 `boss_hud.dangerColor` 同一种输出形态) */
export function formatCssRgb(c: RgbColor): string {
  return `rgb(${to255(c.r)},${to255(c.g)},${to255(c.b)})`;
}

/**
 * **颜色 = 基色 × 距离衰减**。这是曲线的消费点(唯一的颜色算术)。
 *
 * 不做 gamma 校正:本仓是像素画,调色盘本身已经按人眼挑过,
 * 再套一层 sRGB 反而会让远端颜色"发灰偏紫"。
 */
export function dyeDecayColor(base: RgbColor, distance: number): RgbColor {
  const k = dyeDecayAt(distance);
  return { r: base.r * k, g: base.g * k, b: base.b * k };
}

/** 亮度(Rec.601),判据用它表达"单调变暗";只用于检查,不参与渲染 */
export function relativeLuma(c: RgbColor): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

export function validateDyeDecayCurve(range: number = DYE_DECAY_FAR_CELLS): string | null {
  if (!Number.isFinite(range) || range <= 0) return `射程 ${range} 必须是正的有限数`;
  const at0 = dyeAttenuation(0, range);
  if (at0 !== 1) return `起点(距离 0)必须为 1,实际 ${at0}`;
  const atFar = dyeAttenuation(range, range);
  if (atFar !== 0) return `射程 ${range} 处必须为 0,实际 ${atFar}`;
  let prev = at0;
  for (let d = range / 60; d <= range; d += range / 60) {
    const v = dyeAttenuation(d, range);
    if (!(v >= 0 && v <= 1)) return `距离 ${d} 处强度 ${v} 超出 [0,1]`;
    if (v > prev) return `距离 ${d} 处强度回升(${prev} → ${v})—— 衰减曲线必须单调不增`;
    prev = v;
  }
  return null;
}