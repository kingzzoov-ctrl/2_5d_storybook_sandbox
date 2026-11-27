/**
 * WS-FND-198 · 地形块由近到远下发。
 *
 * 守的是「进场先看到脚下」:512×512 的主世界有 1024 块,按 (cy,cx) 行序发要十几秒,
 * 玩家脚下那一块可能排在最后。给了玩家 id ⇒ 第一块必须是他所在的块,之后距离不递减;
 * 不给 ⇒ 仍是原来的行序(既有调用方逐字不变);两种排法发出的块集合必须相同(不丢不重)。
 *
 * 运行:`node tests/WS-FND-198-terrain-near-first.test.ts`
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { decodeTerrainFrames } from '../shared/net/terrain.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

const a = assemble({ overworld: true, mobs: false, memory: true, db: null, archiveSink: null });
const rt = a.runtime;
const sim = a.host as unknown as WorldSim;
rt.join({ userId: 'p1' });

const keyOf = (c: { cx: number; cy: number }): string => `${c.cx},${c.cy}`;

test('FND198-1 给了玩家 ⇒ 第一块是脚下那块,之后距离不递减', () => {
  sim.setPlayerPos('p1', 316.5, 256.5);          /* 块 (19,16) */
  const out = rt.terrainDeltaFor({}, 'p1');
  const chunks = decodeTerrainFrames(out.frames);
  eq(chunks.length, 1024, '512/16 = 32,32×32 = 1024 块全在');
  eq(keyOf(chunks[0]!), '19,16', '★ 第一块 = 玩家脚下');
  let prev = -1;
  let monotone = true;
  for (const c of chunks) {
    const d = Math.hypot(c.cx - 19, c.cy - 16);
    if (d < prev - 1e-9) { monotone = false; break; }
    prev = d;
  }
  ok(monotone, '★ 距离单调不递减');
  const first8 = chunks.slice(0, 8).map((c) => Math.hypot(c.cx - 19, c.cy - 16));
  ok(Math.max(...first8) <= 2, `第一帧(8 块)都在脚下两块以内(最远 ${Math.max(...first8).toFixed(2)})`);
});

test('FND198-2 不给玩家 ⇒ 原来的行序;两种排法的块集合相同', () => {
  const plain = decodeTerrainFrames(rt.terrainDeltaFor({}).frames);
  eq(keyOf(plain[0]!), '0,0', '★ 行序:第一块是 (0,0)');
  eq(keyOf(plain[1]!), '1,0', '行序:第二块是 (1,0)');
  const near = decodeTerrainFrames(rt.terrainDeltaFor({}, 'p1').frames);
  eq(near.map(keyOf).sort(), plain.map(keyOf).sort(), '块集合相同(不丢不重)');
  eq(keyOf(decodeTerrainFrames(rt.terrainDeltaFor({}, 'nobody').frames)[0]!), '0,0',
    '拿不到位置的人 ⇒ 退回行序,不抛');
});

test('FND198-3 排序不改版本表(基线推进口径不变)', () => {
  const x = rt.terrainDeltaFor({});
  const y = rt.terrainDeltaFor({}, 'p1');
  eq(y.versions, x.versions, '版本表逐项相同');
  eq(rt.terrainDeltaFor(y.versions, 'p1').frames.length, 0, '推进基线后再问 ⇒ 0 帧');
});

report('WS-FND-198');
