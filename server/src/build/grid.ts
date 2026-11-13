/**
 * WS-03 共享网格容器(本工作流自研,冻结层之外):承放 32-Bit 单元格的世界视图。
 *
 * 设计要点:
 *  - 依赖 `node:*`、冻结层的 `shared/types/tile.ts`,以及 WS-01 的
 *    `world/chunk.ts`(**仅为 `EMPTY_TILE` 这一份唯一事实源** —— 见下方长注释);
 *  - 禁止 `enum` / 参数属性 / `namespace`,相对导入必须带 `.ts` 后缀;
 *  - 越界读取返回 `EMPTY_TILE`,越界写入静默丢弃 —— 调用方无需到处写边界分支;
 *  - 底层 `Uint32Array` 一维连续,512×512 世界 = 1 MB。
 */

import { OBJ_MASK, packTile, unpackTile } from '../../../shared/types/tile.ts';
/*
 * 空格默认值:**唯一事实源在 WS-01**,本层只消费、不再定义第二次。
 *
 * ## 为什么必须从这里 import,而不是在本文件里写一遍字面量
 *
 * 此前本文件有自己的 `EMPTY_TILE = packTile({ elev: 0, ... })`,`world/chunk.ts`
 * 另有一份 `packTile({ elev: Elevation.GROUND, ... })` —— **同名、同语义
 * (都是「越界读的返回值」)、不同值**,且 elev 差 1 不是纯表示问题:
 * `physics/world.ts` 的地面高度是 `groundZ = elev - 1`,所以 elev 0 是
 * **Z-1 深沟**、elev 1 才是 **Z0 地面**。同一个「空」在两层意味着不同高度。
 *
 * 实测过的后果(改前):`captureBlueprint` 收本层 `TileGrid`,越界格拿到
 * elev=0 并写进蓝图;`WorldSim.startRelay` → `tickRelay`(`world_sim.ts:1098`)
 * 把任务里的 elev 写回世界 ⇒ 一个**完全空的 16×16 蓝图**把 256 格全挖成深沟,
 * 世界格 (3,3) 从 `elev=1`(groundZ 0)变成 `elev=0`(groundZ −1)。
 *
 * 权威归属:WS-01 拥有地形与「虚空默认格」(`docs/WS-01-terrain.md:337`),
 * `Chunk` 构造默认填充、`FLAT_TERRAIN.elevAt: () => 1`、`verify.ts` 建演示世界用
 * `elev: 1`、以及 `digToDeep` 要**显式**写 DEEP —— 四条独立旁证都指向
 * 「没有数据 = 正常地面,深沟只能由显式动作产生」。
 *
 * 同一份 SSoT 原则在本目录已有先例:`blueprint.ts` 为 `floorIdOfSlot`
 * 从 `../world/chunk.ts` 引入(注释:「不得在本地重写偏移」)。
 */
import { EMPTY_TILE } from '../world/chunk.ts';

export { EMPTY_TILE };

/** 方位常量:0=北(−y) 1=东(+x) 2=南(+y) 3=西(−x),与 `faceDir()` 高 2 位取值一致。 */
export const Dir = { NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

/** 四方向偏移,下标即 `Dir` 值。 */
export const DIR_DX: readonly number[] = [0, 1, 0, -1];
export const DIR_DY: readonly number[] = [-1, 0, 1, 0];

/**
 * 矩形瓦片网格:一维 `Uint32Array` 行主序存放 32-Bit 单元格。
 * 坐标约定:x 向东 0..width-1,y 向南 0..height-1。
 */
export class TileGrid {
  readonly width: number;
  readonly height: number;
  private data: Uint32Array;

  constructor(width: number, height: number, fillValue: number = EMPTY_TILE) {
    this.width = Math.max(0, width | 0);
    this.height = Math.max(0, height | 0);
    this.data = new Uint32Array(this.width * this.height);
    /*
     * `fillValue === 0` 时跳过 `fill` 只是省一次遍历 —— `Uint32Array` 本来就
     * 全 0。**但不能把这个短路条件当成「EMPTY_TILE 等于 0」的假设**:
     * 早期版本隐式依赖了这一点(当时 `EMPTY_TILE` 恰好是 0,于是默认填充
     * 与「不 fill」等价)。现在 `EMPTY_TILE` 的 SSoT 在 `world/chunk.ts`
     * 且值为 1,那个巧合已不成立,故此处显式按值填充。
     */
    if (fillValue !== 0) this.data.fill(fillValue >>> 0);
  }

  /** 全局格索引;越界返回 −1。 */
  index(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** 读格;越界得到 `EMPTY_TILE`(不抛异常,便于邻接掩码直接采样)。 */
  get(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? EMPTY_TILE : this.data[i];
  }

  /** 写格;越界静默丢弃。 */
  set(x: number, y: number, v: number): void {
    const i = this.index(x, y);
    if (i >= 0) this.data[i] = v >>> 0;
  }

  /** 取格内物体 ID(Bits 16..27),越界为 0。 */
  objAt(x: number, y: number): number {
    return (this.get(x, y) & OBJ_MASK) >>> 16;
  }

  /** 写格内物体 ID,其余字段保留。 */
  setObj(x: number, y: number, objId: number): void {
    const f = unpackTile(this.get(x, y));
    f.obj = objId & 0xfff;
    this.set(x, y, packTile(f));
  }

  /** 按 4 邻域填充矩形(含端点);越界部分自动裁剪。 */
  fillRect(x0: number, y0: number, x1: number, y1: number, v: number): void {
    const lx = Math.max(0, Math.min(x0, x1));
    const hx = Math.min(this.width - 1, Math.max(x0, x1));
    const ly = Math.max(0, Math.min(y0, y1));
    const hy = Math.min(this.height - 1, Math.max(y0, y1));
    for (let y = ly; y <= hy; y += 1) {
      for (let x = lx; x <= hx; x += 1) this.set(x, y, v);
    }
  }

  /** 从另一网格整体拷入(左上角对齐),用于测试与蓝图落位。 */
  blit(src: TileGrid, ox: number, oy: number): void {
    for (let y = 0; y < src.height; y += 1) {
      for (let x = 0; x < src.width; x += 1) this.set(ox + x, oy + y, src.get(x, y));
    }
  }

  /** 遍历全部格;回调可提前返回 false 终止。 */
  forEach(fn: (v: number, x: number, y: number) => void | boolean): void {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (fn(this.data[y * this.width + x], x, y) === false) return;
      }
    }
  }

  /** 统计满足谓词的格数。 */
  countWhere(pred: (v: number, x: number, y: number) => boolean): number {
    let n = 0;
    this.forEach((v, x, y) => {
      if (pred(v, x, y)) n += 1;
    });
    return n;
  }

  /** 导出为行主序副本(调试与哈希用)。 */
  toArray(): Uint32Array {
    return this.data.slice();
  }
}

/**
 * `TileGrid` 的**结构子集** —— `rooms.ts` / `autotile.ts` / `wiring_view.ts`
 * 实际只用到这 6 个成员(实测,见下方注),因此生产侧的 `WorldGrid`
 * 可以**不复制任何数据**地直接满足它。
 *
 * ## 为什么必须是「视图」而不是「把 WorldGrid 拷进 TileGrid」
 *
 * `TileGrid` 的 `data` 是 **private** ⇒ TS 结构化类型不成立(名义类型),
 * 生产 `WorldGrid` 无法直接当 `TileGrid` 用。看似最省事的做法是:
 * 每次调用 `scanRooms` 前把 `WorldGrid` 拷进一个 `TileGrid`。
 *
 * **那是错的**,而且是本仓反复出现过的那一类错误:
 *   - 拷贝一次 = 造出**第二份真相**;地形随后每帧都在变,
 *     而 `rooms()` 会读到过期快照 ⇒ 表现成「墙都拆了还报着那间房」
 *     (WT-03-61 正是钉这个);
 *   - `WorldSim` 的世界是**稀疏 Chunk**(`Map`),没有固定 `width × height`,
 *     按 `sizeCells` 全量拷贝是每帧 O(sizeCells²),512×512 就是 26 万格/帧 ——
 *     只为了一次房间识别而把整张地图复制一遍。
 *
 * ⇒ 改用**结构化的只读视图**:`grid` 参数放宽到下面这个接口,
 *   由 `WorldSim` 传一个只转发到 `WorldGrid` 的对象(与
 *   `world_sim.ts` 里 `physics.terrain` / `mobWorldAdapter` 的既有做法同构)。
 *   零拷贝、零第二份真相,越界语义与 `TileGrid` 对齐(读越界得 `EMPTY_TILE`)。
 *
 * ⚠️ 实测依据(`server/src/build/**` 内 `grid.<member>` 的全部用法):
 *   `rooms.ts` → get / set / setObj / inBounds / width / height
 *   `autotile.ts` → get / inBounds / width / height
 *   `wiring_view.ts` → get / inBounds / width / height
 *   `blueprint.ts` → get / set
 *   即 `objAt` / `index` / `fillRect` / `blit` / `forEach` / `countWhere` / `toArray`
 *   **一次都没用到** ⇒ 接口只收窄到这 6 个,收得太宽反而会逼出无意义的实现。
 */
export interface TileGridLike {
  readonly width: number;
  readonly height: number;
  /** 读整格(32 位打包);越界返回 `EMPTY_TILE` */
  get(x: number, y: number): number;
  /** 写整格;越界静默丢弃 */
  set(x: number, y: number, v: number): void;
  /** 写 OBJ 层,其余位保留 */
  setObj(x: number, y: number, objId: number): void;
  inBounds(x: number, y: number): boolean;
}

/**
 * 把可写的 `TileGridLike` 适配成 `TileGrid` 的**只读**代理。
 *
 * 用途:纯读的消费点(房间识别 / Auto-Tile / 布线视图)接受 `TileGrid`,
 * 而生产侧只有 `WorldGrid`。本函数**不复制数据** —— 所有读写都转发到 `src`,
 * 因此读到的永远是当前帧的真实地形。
 *
 * 注意:返回的对象**不是** `TileGrid` 实例(类型上是,运行期不是),
 * 只应传给把它当结构用的纯读函数。任何 `instanceof TileGrid` 的判断都会失败,
 * 因此刻意不导出 `data` / `blit` / `toArray` 这些依赖内部数组的成员 —— 
 * 调用它们会抛错而不是静默给出空数据。
 */
export function asTileGrid(src: TileGridLike): TileGrid {
  const shim = {
    width: src.width,
    height: src.height,
    get: (x: number, y: number) => src.get(x, y),
    set: (x: number, y: number, v: number) => src.set(x, y, v),
    setObj: (x: number, y: number, id: number) => src.setObj(x, y, id),
    inBounds: (x: number, y: number) => src.inBounds(x, y),
  };
  return shim as unknown as TileGrid;
}
