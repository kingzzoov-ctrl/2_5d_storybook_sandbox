/**
 * 演示世界生成 —— **纯逻辑,零三方依赖**。
 *
 * ## 为什么单独一个文件
 *
 * 原本这段逻辑写在客户端入口 `main.ts` 里,而入口必须 `import three`,
 * 于是它被 WS-09 的「分层不变量」门禁归入「不得被测试加载」的一类
 * —— **纯逻辑因此落进了测试盲区**。
 *
 * 拆出来之后:
 * - 本文件**不 import three**,可在 node 里直接测;
 * - 引擎绑定留在 `three/boot.ts`,那里 import three 是合规的。
 *
 * 分层不变量因此得以保持:凡 `import three` 的模块都在 `three/` 内,
 * 其余全部可测。
 *
 * ## 职责边界
 *
 * **只造数据,不碰引擎**。产出 `ChunkInput`,由装配层转成几何。
 * 真实地形由服务端 Chunk 下发,这里是**演示/自检用**的确定性生成器。
 */

import { CHUNK_SIZE, ELEV_TO_Z, type ChunkInput } from './tile_mesh.ts';
import { packTile, Elevation } from '../../../shared/types/tile.ts';

/** 世界尺寸(格)。4×4 个 chunk = 64×64 格。 */
export const WORLD_CHUNKS = 4;
export const WORLD_CELLS = WORLD_CHUNKS * CHUNK_SIZE;

/** 河流中心线:在 gy 轴上按 gx 做正弦摆动 */
function riverCenter(gx: number): number {
  return WORLD_CELLS / 2 + Math.sin(gx * 0.2) * 4;
}

/**
 * 造一个演示 chunk。
 *
 * 刻意做出**高度差与水域**,用来验证:
 * - 顶面四边形朝向正确(不同海拔的块的顶面都应可见);
 * - 侧面在**高差处**生成(平地不产生侧面 ⇒ 画面上会是一整片无厚度地板);
 * - 水(低一层,`base=2`)与陆地的落差能看出来。
 *
 * **确定性**:同一 `(cx, cy)` 必得同一结果,便于截图回归对比。
 */
export function makeDemoChunk(cx: number, cy: number): ChunkInput {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const gx = cx * CHUNK_SIZE + x;
      const gy = cy * CHUNK_SIZE + y;
      /* 两段正弦叠出起伏,再挖一条河 */
      const h = Math.sin(gx * 0.35) * Math.cos(gy * 0.28);
      const isRiver = Math.abs(gy - riverCenter(gx)) < 2;
      let elev: number;
      if (isRiver) elev = Elevation.DEEP;
      else if (h > 0.45) elev = Elevation.CLIFF;
      else if (h > 0.05) elev = Elevation.PLATFORM;
      else elev = Elevation.GROUND;
      tiles[y * CHUNK_SIZE + x] = packTile({
        elev,
        base: isRiver ? 2 : 1,
        floor: isRiver ? 0 : 1 + ((gx + gy) % 3),
        wire: 0,
        obj: 0,
      });
    }
  }
  return { key: `c${cx}_${cy}`, cx, cy, tiles };
}

/** 整片演示世界的所有 chunk(生成顺序固定:先行后列)。 */
export function makeDemoWorld(): ChunkInput[] {
  const out: ChunkInput[] = [];
  for (let cy = 0; cy < WORLD_CHUNKS; cy += 1) {
    for (let cx = 0; cx < WORLD_CHUNKS; cx += 1) out.push(makeDemoChunk(cx, cy));
  }
  return out;
}

/** 世界里最高的那一层,用来给相机算高度范围 */
export function worldHeightRange(): { min: number; max: number } {
  return { min: Math.min(...ELEV_TO_Z), max: Math.max(...ELEV_TO_Z) };
}