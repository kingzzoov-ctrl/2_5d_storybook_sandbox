/**
 * 客户端侧 —— **设计过的世界**,与服务器**同一张图**。
 *
 * ## 这个文件在修什么
 *
 * 此前客户端画的是 `demo_world.ts`:`4×4` 个 chunk(= 64×64 格)、
 * 行列式正弦起伏 + 一条正弦河、地板槽位 `1 + (gx + gy) % 3` 循环 ——
 * 也就是「一堆像素块、地图小、没设计」的**字面来源**。
 *
 * 它和服务器真正的世界**毫无关系**:地形从来没过 WS(`shared/net/delta.ts` 的
 * `chunkWireBytes` / `diffChunkVersions` 至今只有单测在用,线上不存在 chunk 下行),
 * 所以玩家看到的永远是那张 64×64 噪声图,而服务器在另一张图上跑模拟。
 *
 * 现在两边都从 `shared/world/design.ts` 取**同一张图**:
 *
 *   服务器:`createHost()` 在 `restoreWorldFromDb` 之前 `applyWorldDesign(sim)`
 *   客户端:本文件把同一张图切成 `ChunkInput[]` 交给建面
 *
 * ⇒ 至少「你看到的」和「服务器在跑的」是同一张地图。
 *
 * ## 已知边界(不假装已解决)
 *
 * 世界的**改动**(玩家盖墙 / 拆块 / 地形被车床改)**不会**同步到客户端 ——
 * 那需要真正的 chunk 下行通道。本文件只保证**初始地形一致**。
 * 要补齐:服务端在 join 与 `chunkVersions` 变化时下发 1024+8 字节的块,
 * 客户端 `session` 收下后按 `key` 替换并重建那块的面。这是下一刀。
 */

import { CHUNK_SIZE, type ChunkInput } from './tile_mesh.ts';
import { packTile, unpackTile } from '../../../shared/types/tile.ts';
import { applyWorldDesign, DESIGN_SIZE } from '../../../shared/world/design.ts';

/** 设计图边长(格)。与服务器共用 `DESIGN_SIZE` ⇒ 不会两边不一致。 */
export const DESIGN_WORLD_CELLS = DESIGN_SIZE;

/**
 * 把设计图切成 `ChunkInput[]`。
 *
 * **纯函数**(不 import three),所以可以在 node 里直接断言:
 * 同一个 `size` 必得同样的块数组。
 */
export function buildDesignChunks(size: number = DESIGN_WORLD_CELLS): ChunkInput[] {
  const side = Math.max(CHUNK_SIZE, Math.trunc(size));
  const cells = new Uint32Array(side * side);

  /* 盖章走的窄接口,与 `server/src/index.ts` 里传给 `applyWorldDesign` 的
     是**同一个** `DesignWriter` 契约 —— 两边的「怎么盖」因此只有一份实现
     (在 `shared/world/design.ts` 里),这里只提供「盖到哪」。 */
  const writer = {
    sizeCells: side,
    setCell(x: number, y: number, fields: Partial<ReturnType<typeof unpackTile>>): void {
      if (x < 0 || y < 0 || x >= side || y >= side) return;
      const i = y * side + x;
      cells[i] = packTile({ ...unpackTile(cells[i]), ...fields });
    },
    fillRect(
      x0: number, y0: number, x1: number, y1: number,
      fields: Partial<ReturnType<typeof unpackTile>>,
    ): number {
      let n = 0;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          this.setCell(x, y, fields);
          n += 1;
        }
      }
      return n;
    },
  };

  applyWorldDesign(writer, { size: side });

  const perSide = Math.ceil(side / CHUNK_SIZE);
  const out: ChunkInput[] = [];
  for (let cy = 0; cy < perSide; cy += 1) {
    for (let cx = 0; cx < perSide; cx += 1) {
      const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
      for (let y = 0; y < CHUNK_SIZE; y += 1) {
        for (let x = 0; x < CHUNK_SIZE; x += 1) {
          const gx = cx * CHUNK_SIZE + x;
          const gy = cy * CHUNK_SIZE + y;
          /* 世界边长不是 16 的整数倍时,越界格保持**全 0**(空气):建面会跳过它,
             于是不会凭空长出一圈假地面。 */
          if (gx >= side || gy >= side) continue;
          tiles[y * CHUNK_SIZE + x] = cells[gy * side + gx];
        }
      }
      out.push({ key: `${cx},${cy}`, cx, cy, tiles });
    }
  }
  return out;
}