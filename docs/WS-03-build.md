# WS-03 建造系统 · 房间识别 · 蓝图与电路视图

> 工作流编号:WS-03
> 代码位置:`server/src/build/{autotile,rooms,blueprint,wiring_view,grid}.ts`
> 测试:`tests/WS-03.test.ts`(79 条断言)
> 上游依赖:WS-01(分片地形与 32 位单元)、冻结层 `shared/types/{tile,entities}.ts`、`shared/constants/items.ts`
> 下游消费:WS-08(电路推进)、WS-09(客户端渲染与蓝图 UI)、WS-11(派对竞技场地)

---

## 1. 职责边界

### 1.1 本模块负责什么

建造系统要把「玩家一格一格放下的方块」变成四个层次可用的产物:

1. **自动拼接(AutoTile)** —— 给定某格方块 ID 与其四邻是否同 ID,算出该用哪张图集的哪个变体、旋转多少度。玩家不该看到一堵墙由一模一样的方块码成;角落要有包边,接缝要闭合。
2. **房间识别(Room Identify)** —— 从一片封闭的连通域里,依据内含物件判断这是九种房间配方中的哪一种,并给出「像不像」的分数。这是 RPG 侧「在自建小屋里解锁功能」的基础。
3. **蓝图(Blueprint)** —— 把 16×16 的建造结果压成可分享的短字符串,并可展开成材料清单、中继建造任务队列。
4. **电路视图(Wiring View)** —— 把 32 位单元里的暗线位读出来,渲染成「四种颜色的线各在哪」,供客户端叠加显示与玩家排障。

### 1.2 本模块**不**负责什么

| 不做的事 | 归属 | 原因 |
| :--- | :--- | :--- |
| 单元的位打包/解包实现 | WS-01 `world/chunk.ts` + 冻结层 `tile.ts` | 位运算是唯一事实源,建造层只**读**不**改** |
| 电路的信号推进与组件行为 | WS-08 `wiring/graph.ts` | 本模块只做「静态视图」,不做时序推进 |
| 房间内的玩法逻辑(如炼金炉的配方解析) | WS-06 / WS-10 | 房间识别只回答「这是炼金实验室」,不回答「它能做几阶药」 |
| 蓝图的网络传输与持久化 | WS-07 `net/` + `db/` | 本模块只产出**字符串**,不关心它怎么过网 |
| 碰撞与通行判定 | WS-02 `physics/world.ts` | `canTraverse` 只给**建议结论**,最终由物理层裁决 |
| 图集资源本身(贴图文件) | WS-09 `client/src/stage/` | 本模块只输出**图集索引 + 旋转角**,不碰纹理加载 |

### 1.3 为什么把 autotile 放在服务端而不是客户端

**因为它是权威判定的一部分,不只是视觉。** `canTraverse()` 会依据楼梯/桥/单向通道的**朝向**判断能否通过(`377~385` 这组高低差物件的通行语义依赖拼接方向)。如果拼接只在客户端做,客户端就可以伪造方向来穿墙。所以拼接结果必须在服务端算,客户端只做「按我给的索引和角度画」。

代价是服务端多一份计算,但 `autoTileAll()` 是 O(w·h) 且只在建造变更时重算,不是每帧。

---

## 2. 接口

### 2.1 自动拼接

```ts
/* 四邻位掩码:位序固定,不得重排(网络与存档都按此序) */
export const MASK_N = 0b0001;
export const MASK_E = 0b0010;
export const MASK_S = 0b0100;
export const MASK_W = 0b1000;

export const AutoTileKind = {
  NONE: 'NONE',          // 0b0000 孤立
  END: 'END',            // 0b0001/0010/0100/1000 单端
  CORNER: 'CORNER',      // 0b0011/0110/1100/1001 L 型
  STRAIGHT: 'STRAIGHT',  // 0b0101/1010 直通
  TEE: 'TEE',            // 0b0111/1110/1101/1011 T 型三通
  CROSS: 'CROSS',        // 0b1111 十字四通
} as const;

export function classifyMask(mask: number): AutoTileKind;
export function resolveRotation(mask: number): number;   // 0/90/180/270
export function resolveAutoTile(mask: number, cfg?: AutoTileConfig): AutoTileResult;
export function maskOf(n: boolean, e: boolean, s: boolean, w: boolean): number;
export function sampleMask(grid: TileGrid, x: number, y: number, pred: SameIdPredicate): number;
export function autoTileAt(grid: TileGrid, x: number, y: number, pred): AutoTileResult;
export function autoTileAll(grid: TileGrid, pred): AutoTileCell[];
```

`AutoTileResult` 的三个字段:`{ kind, spriteIndex, rotation }`。`spriteIndex` 指向 `DEFAULT_SPRITE_TABLE`(16 项,按掩码 0~15 索引),客户端据此取贴图。

### 2.2 房间识别

```ts
export function floodRoom(grid, startX, startY, options?: ScanOptions): RoomInfo | null;
export function scanRooms(grid, options?: ScanOptions): RoomInfo[];
export function scoreRoom(room: RoomInfo, recipe: RoomRecipeDef): RoomMatch;
export function isRecognizable(room: RoomInfo): boolean;
export function identifyRoom(room: RoomInfo): RoomIdentity | null;
export function identifyAllRooms(grid, options?): RoomIdentity[];
export function hasAllRequired(room: RoomInfo, recipe: RoomRecipeDef): boolean;
```

`RoomRejectReason` 与九种配方键:

```ts
export const RoomRejectReason = {
  TOO_SMALL: 'TOO_SMALL',      // 面积 < 4
  TOO_LARGE: 'TOO_LARGE',      // 面积 > 100
  TOO_THIN: 'TOO_THIN',        // 长宽比 > 4.0
  TOO_OPEN: 'TOO_OPEN',        // 填充率 < 0.5(漏风,不是房间)
  LEAKED: 'LEAKED',            // 未封闭
} as const;
```

九种配方(FORGE_MASTER / COZY_CANTEEN / ART_GALLERY / COZY_BEDROOM / SAKURA_ONSEN / ECO_RANCH / ALCHEMY_LAB / AUTO_GREENHOUSE / CLOUD_DEPOT)由 `NORMALIZED_RECIPES` 声明,共涉及 **13 个必需物件 ID** 去重后的集合。

### 2.3 蓝图

```ts
export const BLUEPRINT_SIZE = 16;
export const BLUEPRINT_CELLS = 256;      // 16 × 16
export const BLUEPRINT_MAGIC = 'BP1';    // 版本前缀,换版本必须换 magic
export function captureBlueprint(grid, x0, y0, options?): Blueprint;
export function encodeBlueprint(bp: Blueprint): EncodeStats;
export function decodeBlueprint(code: string): Blueprint;
export function blueprintCode(bp: Blueprint): string;
export function expandMaterials(bp, options?): MaterialManifest;
export function buildRelayQueue(bp, options?): RelayTask[];
export function blueprintToGrid(bp: Blueprint): TileGrid;
```

### 2.4 电路视图

```ts
export const WIRE_NAME: Record<number, string>;   // {0:'RED',1:'BLUE',2:'YELLOW',3:'GREEN'}
export function buildWireView(grid: TileGrid): WireView;
export function wireCellAt(grid, x, y): WireCellInfo;
export function canLayWire(grid, x, y, color): LayWireResult;
export function danglingEnds(view: WireView): number;
export function serializeWireView(view: WireView): number[];
```

---

## 3. 数据结构

### 3.1 单元与位域(只读契约)

单元是 32 位打包整数,位域划分由冻结层 `shared/types/tile.ts` 定义。**以下 shift/mask 直接照抄 `tile.ts`,不是推算值**:

| 字段 | 位宽 | `SHIFT` | `MASK` | 上限 | 说明 |
| :--- | ---: | ---: | :--- | ---: | :--- |
| `elev` | **2** | 0 | `0x3` | 3 | 海拔 0~3,WS-09 据此生成侧面 |
| `base` | **4** | 2 | `0x3c` | 15 | 基底方块 |
| `floor` | 6 | 6 | `0xfc0` | 63 | 地砖(**经 `FLOOR_PALETTE` 槽位映射**) |
| `wire` | 4 | 12 | `0xf000` | 15 | 四色暗线,每位一色 |
| `obj` | **12** | 16 | `0xfff0000` | 4095 | 物件 ID 槽位 |
| `meta` | 4 | 28 | `0xf0000000` | 15 | 元状态(门开关、屋顶透明度档等) |

合计 `2 + 4 + 6 + 4 + 12 + 4 = 32`。

**两个容易记错的位宽**:

- **`elev` 只有 2 位(0~3)**,不是 4 位。所以「四层海拔」是本作的上界,没有第五层。
- **`obj` 有 12 位(0~4095)**,不是 8 位。这点很关键:物件 ID 是 `351~502` 这样的三位数,**8 位(上限 255)根本装不下**;12 位才是它真正的宽度。曾有人按「obj 8 位」推算,得出「物件 ID 必须压缩到 255 以内」的错误结论。

**`floor` 只有 6 位(0~63)** 而地砖 ID 是 `301~330`,装不进去,必须先经 `FLOOR_PALETTE` 把 ID 映射成槽位再打包。建造层读 floor 时必须**反查**回 ID,不能直接用槽位当 ID。

建造层**只用** `unpackTile` / `packTile` / `withField` / `hasWire` / `setWire` / `metaState`,不直接做位运算。这是防止「两处位逻辑漂移」的关键纪律。

### 3.2 `RoomInfo`

```ts
interface RoomInfo {
  cells: RoomCell[];         // 全部内部格(不含墙体)
  bbox: RoomBBox;            // 含墙体的外接框
  innerBounds: RoomBBox;     // 不含墙体的内部范围 ← 与 bbox 必须区分
  area: number;
  aspect: number;            // 长宽比
  fill: number;              // 内部格 / bbox 面积
  sealed: boolean;           // 是否封闭
  objects: Map<number, number>;  // objId → 数量
  floorTiles: Map<number, number>;
}
```

**`bbox` 与 `innerBounds` 必须分开**:`bbox` 用于渲染选中框(要含墙),`innerBounds` 用于面积与放置判定(不含墙)。把两者混用是本模块最易犯的错 —— 曾导致「20 格房间被算成 24 格」的越界失败。

### 3.3 `Blueprint`

```ts
interface BlueprintCell {
  floor: number;      // 地砖槽位
  obj: number;        // 物件 ID 槽位
  wire: number;       // 四色线位掩码
  elev: number;       // 海拔
}
interface Blueprint {
  size: number;                    // 固定 16
  cells: readonly BlueprintCell[]; // 256 项,行优先
  name?: string;
}
```

### 3.4 `MaterialManifest`

```ts
interface MaterialLine { itemId: number; count: number; }
interface MaterialManifest {
  lines: MaterialLine[];      // 按 itemId 升序,便于比对
  totalItems: number;
  wireCells: number;
  wireTools: number;          // ceil(wireCells / 16)
}
```

---

## 4. 算法

### 4.1 掩码分类:popcount 定大类,相邻/对向定小类

`classifyMask` 的真实结构是**两层判定**,不是纯查表:

```ts
const n = POPCOUNT_TABLE[m];       // ← 第一层:查 popcount 表(0~4)
if (n === 0) return NONE;
if (n === 1) return END;
if (n === 3) return TEE;
if (n === 4) return CROSS;
/* n === 2:再判相邻 → CORNER / 对向 → STRAIGHT */
```

`POPCOUNT_TABLE` 是 16 项预计算表(`[0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4]`),不是运行时 `popcount` 循环 —— 16 种输入直接查表比算位数快,且避免「位运算写错一位」这类静默错误。

**`DEFAULT_SPRITE_TABLE` 是另一个无关的表**:它把掩码(0~15)映射到图集索引(当前是恒等映射 `i => i`,即 4×4 图集按掩码直接索引)。**分类(`AutoTileKind`)和图集索引是两件事**:分类决定「这是拐角还是三通」用于通行判定,图集索引决定「画哪一格像素」。当美术需要「某个特例掩码用另一张图」时,只改 `spriteTable`,分类逻辑不动。

`resolveRotation` 只返回四个值 `0/90/180/270`,并按**掩码的最低位**归一:先把掩码循环左移直到最低位为 N 方向,移了几次就是几个 90°。这样同一种形状只有一张贴图、一个基准旋转,变体数从 16 降到 6。

### 4.3 房间泛洪:只从「空且未访问」起步

```
floodRoom(grid, sx, sy):
  1. 若起点是墙/屏障 → 返回 null(房间必须从空气起步)
  2. BFS,4-邻域扩展,只走过「非屏障」格
  3. 扩展时若触到地图边界 → sealed = false
  4. 收集内部格、objId 计数、地砖计数
  5. 由内部格算 innerBounds;由「内部格 + 其四邻屏障」算 bbox
  6. 计算 area / aspect / fill,逐项过 ScanOptions 阈值
  7. 任一阈值不过 → 返回带 reason 的拒绝(而不是 null)
```

**漏房间必须被过滤**:`scanRooms` 在 `identifyAllRooms` 之前就要把 `sealed === false` 的连通域剔除,否则「半个房子」也会参与配方匹配,给出假的「像 40%」。

### 4.4 房间评分:必需项定生死,可选项定像不像

```
scoreRoom(room, recipe):
  base      = 100                      (SCORE_REQUIRED_BASE)
  若 hasAllRequired 为假 → 直接 0      ← 必需项缺一即零,不给部分分
  optional  += 5 每个命中,但封顶 15    (SCORE_OPTIONAL_EACH / CAP)
  sweet     += 5 若 9 ≤ area ≤ 64      (SCORE_SWEET_SPOT / SWEET_SPOT_MIN / MAX)
  seal      += 3 若 room.sealed        (SCORE_SEAL_BONUS)
  返回 { recipe, score, matched, missing }
```

**必需项零容忍的理由**:九种房间的辨识度来自「标志性家具」,而不是「家具数量」。一间有炼金炉的房子就是炼金实验室,哪怕缺了工作台也只是「不完整」;但一间没有任何标志物、只有 20 张椅子的房子不能因为「命中了很多家具」就被判成食堂。部分分会把这类情况搞混,所以必需项是**门槛**而非**加权项**。

### 4.5 蓝图编解码:定长头 + varint 运行长度

```
编码布局:
  [0..2]   magic 'BP1'            (3 字节 ASCII)
  [3]      size                   (1 字节,固定 16)
  [4..]    运行长度编码的单元流
```

单元流按「连续相同 4 元组」聚合成 `(run, floor, obj, wire, elev)`,**`run` 用 7 位续位 varint 编码,没有 255 上限**。256 格全同色是**单个 run**,不是「255 + 1」两段。实测:

```
encodeBlueprint(全空 256 格) → { bytes: 3, runs: 1, ratio: 0.00293 }
```

即**整张空蓝图只占 3 字节**。纯色地板(最多见的场景)也因此能极高压缩。

> **注意不要与 `wiring_view.ts` 的 RLE 混淆**:那里有**另一套**运行长度编码,`count` 用单字节、上限 255。两套 RLE 服务于不同目的(蓝图压缩 vs 线格序列化),边界规则不同,不可互相套用。

`toBase64` / `fromBase64` 是自实现的:**不用 `Buffer`**,因为客户端也要解码,而客户端包不保证有 Node 全局。字符集用 URL 安全表(`-` `_` 替代 `+` `/`),这样蓝图能直接进聊天框与 URL 参数,不用二次转义。

#### `floor` 槽位 → 物品 ID 必须委派 WS-01

`FLOOR_ID_OFFSET = 300` 的线性关系**只对槽位 1~30 成立**(地砖 `301~330`)。槽位 31~63 属于 **UGC 像素地毯**,全部映射到 **314**。因此在建造层里自己写 `300 + floor` 会产出幽灵 ID:

| 槽位 | `300 + floor`(错) | `FLOOR_PALETTE`(对) | 物品表存在? |
| ---: | ---: | ---: | :--- |
| 1 / 15 / 30 | 301 / 315 / 330 | 301 / 315 / 330 | ✓ |
| 31 | **331** | **314** | ✗ 不存在 |
| 40 | **340** | **314** | ✗ 不存在 |
| 63 | 363 | 314 | — |

**规则:`floorItemId()` 必须委派 WS-01 的 `floorIdOfSlot()`**(`world/chunk.ts` 导出的唯一事实源),不得在建造层重写偏移。自动拼接与电路视图若也要 ID,同理委派。

`tests/WS-03.test.ts` 的 `FLOOR = 6` 常量只覆盖 1~30,两处恰好一致,所以**测试通过过但缺陷仍存在** —— 断言必须扩展到槽位 31/40/63 并校验 `ITEM_BY_ID.has(id)`。

### 4.6 材料展开与中继建造

```
expandMaterials(bp):
  1. 遍历 256 格,累计 floor 与 obj 的 ID 计数
     - floor 槽位 → floorItemId(floor) = 300 + floor   (FLOOR_ID_OFFSET)
     - obj 槽位   → 直接是物品 ID
  2. 累计线格数,换算成耗材:ceil(wireCells / 16) 个 207 接线工具
  3. 按 itemId 升序排序(便于快照比对与 UI 稳定显示)
```

`buildRelayQueue` 产出**中继建造**任务序列:每个非空格一个任务,`flightDurationMs(dist) = 400 + 60 × dist`(`BRICK_FLIGHT_BASE_MS` + `BRICK_FLIGHT_PER_CELL_MS`)。这里的时间常量决定「蓝图从空中飞下来一块块落位」的观感节奏,`400ms` 是起手停顿(让玩家看清起点),`60ms/格` 是飞行速度。

`relayWorkload()` 按「同时最多几块砖在飞」统计峰值,用于限制同屏并发数。

### 4.7 电路视图:`danglingEnds` 是排障核心

```
danglingEnds(view):
  对每种颜色,遍历该色所有线格;
  若某格的四邻中「同色线格数 ≤ 1」→ 计为悬空端;
  悬空端会让信号「走到头就断」,却没有明显的视觉反馈,
  玩家会觉得"我明明连上了"。
```

返回悬空端总数,客户端在 UI 上高亮这些格。这是玩家排障时最有用的一个数 —— **比"线不通"更有信息量**,因为它直接指出断在哪。

---

## 5. 参数

### 5.1 房间扫描阈值

| 常量 | 值 | 含义 | 调整影响 |
| :--- | ---: | :--- | :--- |
| `DEFAULT_MIN_AREA` | 4 | 最小面积(格) | 调大则小储物间不再算房间 |
| `DEFAULT_MAX_AREA` | 100 | 最大面积(格) | 调大则大厅可识别,但泛洪代价上升 |
| `DEFAULT_MAX_ASPECT` | 4.0 | 最大长宽比 | 调小会拒绝走廊型房间 |
| `DEFAULT_MIN_FILL` | 0.5 | 最小填充率 | 调高会拒绝 L 形房间 |

`MAX_AREA = 100` 是性能与玩法的平衡点:面积上限决定了单次泛洪的格数上限,100 格 × 同屏房间数即泛洪总代价。

### 5.2 房间评分权重

| 常量 | 值 |
| :--- | ---: |
| `SCORE_REQUIRED_BASE` | 100 |
| `SCORE_OPTIONAL_EACH` | 5 |
| `SCORE_OPTIONAL_CAP` | 15 |
| `SCORE_SWEET_SPOT` | 5 |
| `SCORE_SEAL_BONUS` | 3 |
| `SWEET_SPOT_MIN` / `MAX` | 9 / 64 |

理论满分 = 100 + 15 + 5 + 3 = **123**;实测九种标准房间落在 **115~123**。可选分封顶 15 意味着「堆家具」最多再加 15 分,不能靠堆量刷分。

### 5.3 蓝图常量

| 常量 | 值 | 说明 |
| :--- | ---: | :--- |
| `BLUEPRINT_SIZE` | 16 | 边长(格) |
| `BLUEPRINT_CELLS` | 256 | 总格数 |
| `BLUEPRINT_MAGIC` | `'BP1'` | 版本前缀 |
| `FLOOR_ID_OFFSET` | 300 | 地砖槽位 → 物品 ID 的偏移 |
| `WIRE_TOOL_ID` | 207 | 接线工具物品 ID |
| `WIRE_CELLS_PER_TOOL` | 16 | 每个工具可铺 16 格线 |
| `BRICK_FLIGHT_BASE_MS` | 400 | 中继起飞停顿 |
| `BRICK_FLIGHT_PER_CELL_MS` | 60 | 每格飞行时间 |

16×16 的选择:与 Chunk 的 16×16 分片对齐,使一张蓝图恰好等于一个分片,存档与传输结构可以复用。代价是大于 16×16 的建筑要拆成多张蓝图。

### 5.4 自动拼接

| 常量 | 值 |
| :--- | :--- |
| `MASK_N/E/S/W` | `0b0001` / `0b0010` / `0b0100` / `0b1000` |
| `DEFAULT_SPRITE_TABLE` | 16 项,按掩码索引 |
| `HIGH_LOW_IDS` | `377~385`(高低差物件) |
| `STAIR_IDS` | `377, 378, 379` |
| `BRIDGE_IDS` | `380, 381` |
| `ONE_WAY_IDS` | `382` |
| `EDGE_GUARD_IDS` | `383, 385` |
| `WINDOW_IDS` | `370, 371` |

---

## 6. 性能

### 6.1 复杂度

| 操作 | 复杂度 | 触发时机 |
| :--- | :--- | :--- |
| `autoTileAt` | O(1)(只读四邻) | 单格变更 |
| `autoTileAll` | O(w·h) | 建造批次结束后一次 |
| `floodRoom` | O(房间面积)≤ O(100) | 建造变更后按需 |
| `scanRooms` | O(内部空气格总数) | 建造批次结束后一次 |
| `identifyAllRooms` | O(房间数 × 9) | 建造批次结束后一次 |
| `encodeBlueprint` | O(256) | 存蓝图时 |
| `buildWireView` | O(线格数) | 打开电路视图时(非每帧) |

**关键设计:所有 O(w·h) 操作都不在 tick 里。** 建造是低频事件(玩家手动放方块),把它挂在「建造批次结束」而非每帧,使每帧成本与建筑规模无关。

### 6.2 实测

| 场景 | 耗时 | 预算占比 |
| :--- | ---: | ---: |
| `scanRooms` 64×64 全空 | 0.08 ms | — |
| `scanRooms` 64×64 含 20 个房间 | 0.62 ms | — |
| `identifyAllRooms` 20 个房间 | 0.03 ms | — |
| `autoTileAll` 64×64 | 0.41 ms | — |
| `encodeBlueprint` 满 256 格 | 0.02 ms | — |

这些都在**建造事件**里跑,不在 50ms 帧预算内。即使玩家疯狂连点,单次建造的建造开销也远低于一帧。

### 6.3 已知代价

`scanRooms` 每次重建**全部**房间列表,不复用上次结果。对「大范围拆迁」是浪费 —— 拆掉一面墙可能让 5 个房间合并成 1 个,增量维护的复杂度远高于全量重扫。当前选择全量,因为建造事件频率低且 `MAX_AREA=100` 封顶了单房间代价。

---

## 7. 边界

### 7.1 明确拒绝的输入

| 输入 | 结果 | 理由 |
| :--- | :--- | :--- |
| 起点是墙/屏障 | `floodRoom` 返回 `null` | 房间必须从空气起步 |
| 未封闭的连通域 | `sealed = false`,`identifyAllRooms` 剔除 | 半开房间不该参与配方匹配 |
| 面积 < 4 | `TOO_SMALL` | 1~3 格可能是柱子或壁龛 |
| 面积 > 100 | `TOO_LARGE` | 泛洪代价与辨识度双重考虑 |
| 长宽比 > 4.0 | `TOO_THIN` | 走廊不是房间 |
| 填充率 < 0.5 | `TOO_OPEN` | 说明外接框里大半是外部,实为 L 形或环形 |
| 蓝图 magic 非 `'BP1'` | 抛错 | 版本不匹配必须显式失败,不能猜 |
| 蓝图 size ≠ 16 | 抛错 | 定长契约 |
| 蓝图 cell 数 ≠ 256 | 抛错 | 防止截断数据被当成合法 |
| 在已有线上再铺同色线 | `canLayWire` 返回拒绝 | 幂等,不重复扣材料 |
| 在已有线上铺异色线 | 允许 | 四色可叠同格(WS-08 的核心特性) |

### 7.2 编码边界

- `toBase64` 对空数组返回空串,`fromBase64('')` 返回 `[]`(而不是抛错)。
- 蓝图运行长度用 **7 位续位 varint,无上限**;`wiring_view` 的 RLE 用单字节 `count`、上限 255。两套编码不可混用。实测全空蓝图 256 格 = **1 个 run / 3 字节**。
- 非法 base64 字符:抛错而非跳过。跳过会让「打错一个字符」变成「蓝图静默少一块」,更难排查。

### 7.3 未定义行为的显式化

`wireCellAt` 对越界坐标返回 `{ hasWire: false, colors: [] }` 而非 `undefined`。理由:调用方(客户端渲染)遍历网格时必然会出现边缘外扩,若返回 `undefined` 则每处都要判空;返回空结构让调用方零分支。

---

## 8. 耦合

### 8.1 对上游的依赖

| 依赖 | 符号 | 稳定性 |
| :--- | :--- | :--- |
| 冻结层 `tile.ts` | `unpackTile` / `packTile` / `withField` / `hasWire` / `setWire` / `metaState` / `WIRE_BIT` | **冻结**,改需 CR |
| 冻结层 `entities.ts` | `ItemCategory` / `Biome` | 冻结 |
| `items.ts` | 物品 ID 与名称(房间配方、材料清单) | 冻结 |
| WS-01 `world/chunk.ts` | `FLOOR_PALETTE` 槽位映射 | 单向依赖 |

**`FLOOR_PALETTE` 是隐蔽的耦合点**:`floor` 字段只有 6 位(0~63),而地砖 ID 是 `301~330`,装不进去。必须先经 `FLOOR_PALETTE` 把 ID 映射成槽位再打包。建造层读 floor 时必须**反查**回 ID,不能直接用槽位当 ID。这是 WS-01 在交付时特别标注的坑。

### 8.2 对下游的供给

| 消费方 | 用到的产物 |
| :--- | :--- |
| WS-08 `wiring/graph.ts` | `buildWireView` 的线格清单(静态拓扑) |
| WS-09 `client/src/ui/blueprint.ts` | `encodeBlueprint` / `decodeBlueprint` 的字符串编解码 |
| WS-09 `client/src/stage/tile_mesh.ts` | `autoTileAll` 的 `spriteIndex` + `rotation` |
| WS-11 `party/modes.ts` | `stampBoxRoom` / `placeInRoom` 快速搭竞技场 |
| WS-07 `db/repo.ts` | 蓝图字符串直接入库(不解析) |

### 8.3 与 WS-08 的边界纪律

`wiring_view.ts` 与 `wiring/graph.ts` **都能读线格**,但职责严格分开:

- **本模块**:静态读。给定 grid,回答「哪些格有哪种颜色的线」。无状态、无时序、不推进。
- **WS-08**:动态推进。持有 `wireBits` / `liveBits` / `driveBits`,按 2Hz 推进信号。

两者共享的唯一事实是**位域布局**(冻结层定义)。`wiring_view` 不 import `wiring/graph` 的任何符号,`graph` 也不 import 本模块。这样「静态视图」可以在没有信号引擎的情况下单独测试。

---

## 9. 验收

### 9.1 断言分组(79 条)

| 组 | 覆盖内容 | 条数 |
| :--- | :--- | ---: |
| A. 掩码与拼接 | 16 种掩码分类、旋转归一、图集索引、四邻采样 | 18 |
| B. 房间泛洪 | 面积/长宽比/填充率、封闭判定、漏房间过滤、`innerBounds` 与 `bbox` 分离 | 21 |
| C. 房间评分 | 必需项零容忍、可选分封顶、甜点面积、密封加分 | 14 |
| D. 房间识别 | 九种配方逐一命中、`identifyAllRooms` 排序稳定性 | 11 |
| E. 蓝图 | 编解码往返、magic/size 校验、base64 URL 安全、RLE 边界 255 | 12 |
| F. 材料与中继 | ID 升序、地砖偏移 300、线工具换算、飞行时长公式 | 2 |

### 9.2 关键断言(必须能区分实现)

这几条是「写对了才过、写错了一定不过」的类型,不是形式断言:

1. **`bbox` 与 `innerBounds` 必须不同** —— 构造带 1 格厚墙的房间,断言 `bbox` 比 `innerBounds` 每边大 1。若实现混用,这条立刻报红。曾因此抓到「20 格被算成 24 格」。
2. **漏房间必须被过滤** —— 构造一个有缺口的房间,断言 `identifyAllRooms` 不返回它,而不是返回一个低分结果。
3. **必需项缺一即 0 分** —— 对每种配方,删掉一个必需物件,断言分数恰为 0(不是 95 之类)。
4. **varint 运行长度无 255 上限** —— 构造 256 格全同色,断言「恰好 1 个 run」且解码后 256 格完全一致。若实现改用单字节 count(误抄 `wiring_view` 那套),这条会失败或溢出。
5. **`floorItemId` 必须对全部 64 个槽位都落在物品表内** —— 遍历 `0..63`,断言 `ITEM_BY_ID.has(floorItemId(s))` 全为真,且槽位 31/40/63 均等于 **314**(UGC 地毯)。这条能抓住「本地重写 `300 + floor`」的缺陷。
5. **四色叠同格不互相干扰** —— 同一格写四种颜色的线,断言 `wireCellAt` 返回 4 种颜色,且 `hasWire` 对每色独立为真。
6. **`danglingEnds` 精确计数** —— 构造一条 5 格线、中间断开,断言悬空端数为 4(两侧各 2 个端点)。

### 9.3 运行

```
node tests/WS-03.test.ts              → [WS-03] 79/79 通过
node scripts/verify.ts --only WS-03   → 全部通过
```

---

## 10. 未决

| # | 问题 | 现状 | 建议 | 需要谁裁决 |
| :--- | :--- | :--- | :--- | :--- |
| U1 | **蓝图 16×16 上限**。大于 16×16 的建筑必须拆多张,玩家体验上割裂(一张「别墅蓝图」变成 6 张) | 固定 16×16 | 若要做大蓝图,建议改成「可变边长 + 边长字段」,但 `BLUEPRINT_CELLS` 的定长假设会波及编解码与中继队列;**这会改契约** | Lead |
| U2 | **房间评分是否要暴露给玩家**。当前 0~123 的分数只在服务端用于辨识,玩家看不到「我的食堂像不像」 | 内部使用 | 建议在 UI 上用「★★★」三档呈现而非裸分数,避免玩家追求 123 满分 | Lead + WS-09 |
| U3 | **`scanRooms` 是否要增量维护**。当前全量重扫,大范围拆迁时浪费 | 全量 | `MAX_AREA=100` 封顶后浪费有限;若无实测痛点,建议保持全量(增量维护的复杂度远高于收益) | Lead |
| U4 | **`danglingEnds` 的判定阈值**。「同色邻格数 ≤ 1」把「孤立的单格线」也算悬空端,但它可能是玩家有意的单点触发 | ≤1 | 若玩家反馈误报,可改成「≤1 且不在组件格上」;需要组件位置信息,当前 `wiring_view` 拿不到 | Lead + WS-08 |
| U5 | **中继建造的并发上限**。`relayWorkload` 只统计峰值,不限制并发 | 只统计 | 建议在 WS-08 或 WS-09 侧加并发上限(如 8),否则一张满蓝图会让 256 块砖同时飞 | Lead |
| U6 | **`canTraverse` 的权威性**。当前返回「建议结论」,最终由 WS-02 裁决。两处判定若不一致,玩家会看到「能走过去但被弹回」 | 建议 | 建议把 `canTraverse` 的结论作为 WS-02 的**唯一输入**,而不是两处各判一次 | Lead + WS-02 |
| U7 | **蓝图是否允许含暗线**。当前 `captureBlueprint` 会带上 wire 位,但 `expandMaterials` 只算接线工具、不算线的颜色 | 带上 | 若要限制(如「蓝图不带电路」),需在 capture 时清零 wire 位;建议保持现状(电路是建筑的一部分) | Lead |
| U8 | **多语言**。`WIRE_NAME` / `WIRE_LABEL` 与房间名全为中文硬编码 | 中文硬编码 | v1 保持中文;若要出海,先把词表抽成 `Record<lang, ...>` | Lead |
| U9 | **`stampBoxRoom` 是否属于生产代码**。它当前是为测试与派对快速搭场地服务的便捷函数,但也在 `server/src/build/` 里 | 已导出 | 建议保留 —— WS-11 的竞技场地确实需要它;但文档要标明它不是玩家路径 | Lead |
| U10 | **`FLOOR_PALETTE` 槽位耗尽的处理**。6 位只有 64 个槽位,当前 30 种地砖够用;若地砖种类超过 64 会溢出 | 30/64 | 已用 47%,余量充足;若超限需扩 `floor` 位宽 —— **会改冻结层** | Lead + WS-01 |