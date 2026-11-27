/**
 * WS-FND-199 · 自适应渲染分辨率。
 * 守:帧率持续偏低才降档、只降不升、到底档停住、后台/坏读数不动、一次好帧清零连续计数。
 * 运行:`node tests/WS-FND-199-adaptive-quality.test.ts`
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { LOW_FPS, LOW_WINDOWS, PIXEL_RATIO_STEPS, adaptPixelRatio } from '../client/src/stage/adaptive_quality.ts';
import { readFileSync } from 'node:fs';

test('FND199-1 连续低帧才降一档;单个低帧窗口不动', () => {
  const a = adaptPixelRatio(2, 18, 0);
  eq([a.ratio, a.lowStreak], [2, 1], '第一次低帧只累计');
  const b = adaptPixelRatio(a.ratio, 18, a.lowStreak);
  eq([b.ratio, b.lowStreak], [1.5, 0], `连续 ${LOW_WINDOWS} 次低帧 ⇒ 2 → 1.5,计数清零`);
});

test('FND199-2 好帧清零连续计数;阈值边界(= LOW_FPS 不算卡)', () => {
  eq(adaptPixelRatio(2, 60, 1).lowStreak, 0, '好帧清零');
  eq(adaptPixelRatio(2, LOW_FPS, 1).lowStreak, 0, '恰好 30 不算卡');
  eq(adaptPixelRatio(2, LOW_FPS - 0.1, 0).lowStreak, 1, '29.9 算卡');
});

test('FND199-3 只降不升;一路降到底档停住', () => {
  let r = 2; let s = 0;
  const seen = [r];
  for (let i = 0; i < 20; i += 1) { const n = adaptPixelRatio(r, 10, s); r = n.ratio; s = n.lowStreak; if (seen[seen.length - 1] !== r) seen.push(r); }
  eq(seen, [...PIXEL_RATIO_STEPS], '2 → 1.5 → 1.25 → 1');
  eq(adaptPixelRatio(1, 5, 5).ratio, 1, '底档不再降');
  eq(adaptPixelRatio(1, 120, 0).ratio, 1, '帧率好也不升回去');
});

test('FND199-4 起点不在档位上(dpr=3 被夹到 2 之外、或 1.75)⇒ 降到下一个更低的档', () => {
  eq(adaptPixelRatio(1.75, 10, LOW_WINDOWS - 1).ratio, 1.5, '1.75 → 1.5');
});

test('FND199-5 后台 / 坏读数不动也不累计', () => {
  for (const f of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = adaptPixelRatio(2, f, 1);
    eq([r.ratio, r.lowStreak], [2, 1], `fps=${String(f)}`);
  }
});

test('FND199-6 boot.ts 真的接了它(每个统计窗口喂 fps,改像素比后重设尺寸)', () => {
  const boot = readFileSync(new URL('../client/src/three/boot.ts', import.meta.url), 'utf8');
  ok(boot.includes('adaptPixelRatio(renderer.getPixelRatio(), fps, qualityLowStreak)'), '喂帧率');
  ok(boot.includes('renderer.setPixelRatio(q.ratio);'), '改像素比');
  ok(/renderer\.setPixelRatio\(q\.ratio\);\s*renderer\.setSize\(/.test(boot), '改完必须重设尺寸,否则画布不变');
});

report('WS-FND-199');
