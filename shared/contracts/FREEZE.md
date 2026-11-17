# 冻结契约 FREEZE.md — 全组必读,不得修改本文件与其列出的冻结层文件

> 本文件是整个 2.5D 沙盒工程细化工作的**唯一事实源与硬约束**。
> 任何工作流在写第一行代码前必须先读完本文件。
> 冻结层文件任何人**只读、不得改动**;发现需要改签名,先把需求写进 `docs/CHANGE_REQUESTS.md`,由 Lead 统一裁决。

---

## 0. 运行环境与语法硬约束

| 项 | 值 |
| :--- | :--- |
| Node | v24.13.0(支持原生 `.ts` 类型擦除直跑) |
| 运行方式 | `node <file>.ts`,**不使用** ts-node / tsx / 构建产物 |
| 依赖 | **零运行时依赖**。测试与实现不得 import 除 `node:*` 之外的任何模块 |
| 新文件一律用 Node 原生可擦除语法 | 见下 |

**语法硬禁令(触碰即验证失败)**

1. 禁止 `enum` / `const enum` → 用 `as const` 对象 + `type X = (typeof X)[keyof typeof X]`。
2. 禁止构造函数参数属性 `constructor(private x: number)` → 显式声明字段再赋值。
3. 禁止 `namespace`、`declare module`、装饰器**元数据**(`emitDecoratorMetadata`)。
4. 相对导入**必须带 `.ts` 扩展名**:`import { packTile } from '../../shared/types/tile.ts'`。
5. 禁止 `import ... = require(...)`;统一用 ESM `import`。
6. 所有可执行逻辑放函数体,模块顶层只放常量/类型/函数/类声明。

**验证命令(每次提交前自跑)**

```
node scripts/verify.ts --only WS-XX
node scripts/verify.ts --all
```

---

## 1. 目录与写作范围(每个写手只碰自己的 scope)

```
2_5d_sandbox/
├── shared/                     # ── 冻结层,只读(D-19 解锁范围见 §5)──
│   ├── types/{tile,physics,entities,alchemy}.ts   # D-19 追加:cooking.ts / events.ts
│   ├── types/wire.ts                               # 线上格式唯一定义处(字段表/定点/状态结构)
│   ├── net/delta.ts                                # 20Hz 差量编解码 + Chunk 版本差量
│   ├── constants/{items,mobs,bosses}.ts            # D-19 追加:dye.ts / cooking.ts
│   ├── testing/harness.ts                          # 永不改
│   └── contracts/FREEZE.md
├── server/src/<子域>/          # 各写手实现代码
├── client/src/<子域>/          # 各写手实现代码
├── tests/WS-XX.test.ts         # 各写手测试(node 直跑)
├── docs/WS-XX-*.md             # 各写手细化设计文档(核心交付物)
└── scripts/verify.ts           # Lead 维护
```

**写作用语**:文档一律简体中文,代码标识符/命令/日志保留原文。

---

## 2. 冻结层 API 速查(只能用这些名字与签名)

### 2.1 `shared/types/tile.ts` — 32-Bit 单元格位压缩

| 常量/函数 | 签名 | 语义 |
| :--- | :--- | :--- |
| `ELEV/BASE/FLOOR/WIRE/OBJ/META_SHIFT` `_MASK` | `number` | 各层位移与掩码,与手册 §2.3 表逐行一致 |
| `packTile(f: TileFields): number` | — | 六字段压成 32-bit |
| `unpackTile(v: number): TileFields` | — | 解压 |
| `withField(v, field, value): number` | — | 单字段改写 |
| `hasWire(v, c): boolean` / `setWire(v, c, on): number` | — | 四色暗线读写 |
| `metaState(v): number` / `faceDir(v): number` | — | 运行态低 2 位 / 朝向高 2 位 |
| `CHUNK_SIZE=16` `CHUNK_CELLS=256` `CHUNK_BYTES=1024` | — | 1KB/Chunk |
| `Elevation` `BaseFluid` `WireColor` | `as const` 对象 | 枚举替代 |
| `packTileWide(f: TileFields): TileCellWide` | `{ lo, hi }` | 宽单元:u16 地砖 + u16 物体 ID(D-19)。`floor`/`obj` 非整数 / 负 / > u16 ⇒ **归 0**,绝不回绕(审计 P1-3) |
| `unpackTileWide(c: TileCellWide): TileFields` / `wideCellValue(f)` / `fieldsFromWideValue(v)` | — | 宽单元 ↔ `TileFields` ↔ 单个 46 位数值 |
| `isValidFloorId(id)` / `isValidObjId(id): boolean` | `boolean` | u16 ID 口径的**唯一定义处**;`packTileWide` 生产调用它们 |
| `FLOOR_ID_BITS=16` `OBJ_ID_BITS=16` `FLOOR_WORD_BITS=6` `OBJ_WORD_BITS=12` `WIDE_HI_BITS=14` | `number` | 位宽常量 |

### 2.2 `shared/types/physics.ts` — 2.5D 伪三维质点物理

| 常量 | 值 | 出处 |
| :--- | :--- | :--- |
| `TICK_HZ / DT` | 20 / 0.05s | §2.1 高频帧 |
| `SLOW_TICK_HZ / SLOW_DT` | 2 / 0.5s | §2.1 低频帧 |
| `GRAVITY` | −18.0 格/秒² | §2.2 |
| `THROW_SPEED_XY / THROW_SPEED_Z` | 8.5 / 6.0 | §2.2 |
| `CARRY_Z_STEP / CARRY_MAX_DEPTH / CARRY_SLOWDOWN` | 0.85 / 4 / 0.85 | §2.2 叠罗汉 |
| `CATCH_RADIUS / CATCH_Z_MIN / CATCH_Z_MAX` | 0.8 / 0.3 / 1.4 | §2.2 完美接球 |
| `RADIUS_PLAYER/WILD/BOSS` | 0.35 / 0.40 / 1.20 | §2.2 |
| `MASS_PLAYER/HEAVY/BOSS` | 1.0 / 3.0 / 20.0 | §2.2 |
| `BASE_MOVE_SPEED / BASE_HP / BASE_ATK` | 4.5 / 100 / 10 | §4.1 |

函数:`integrateHorizontal` `integrateVertical` `throwVelocity` `stackOffset` `carrierSpeedMul` `canPerfectCatch` `resolveCircleBounce` `createBody`。

`BodyState` 七态:`NORMAL/SLIPPING/STUNNED/BUBBLED/FROZEN/GHOST_BUBBLE/AFK_SHIELD`。

### 2.3 `shared/types/entities.ts`

`ItemCategory`(12 类)· `ItemDef` · `Biome`(8 群系)+`BIOME_LABEL` · `MobBehavior`(7 类)· `MobFsmState`(3 态)· `MobDef` · `BossPhase` · `BossDef`。
公式:`bossScaledHp(baseHp, n) = round(baseHp × (1 + 0.65(n−1)))`、`expToNext(L) = 50L²+50L`、`statsAtLevel(L)`、`TALENT_LEVELS=[5,10,15,20,25,30]`。
共享常数:`SHARE_EXP_RADIUS=24` `PARTY_BONUS_THRESHOLD=3` `PARTY_BONUS=0.25` `AFK_EXP_RATIO=0.3` `REVIVE_TIME=1.0` `REVIVE_HP_RATIO=0.5` `FEATHER_RANGE=6` `FEATHER_INVULN=3.0`。

### 2.4 `shared/types/alchemy.ts`

`ALCHEMY_MIN_INPUTS=2` `ALCHEMY_MAX_INPUTS=4` · `CARRIER_TAGS` / `MECHANIC_TAGS`(门禁白名单)·
`AlchemyCategory`(7)· `PrimaryMechanic`(10)· `SecondaryElement`(8)· `BaseSilhouette`(9)· `ParticleAura`(7)·
`StatWeights` · `VisualStyle` · `LLMAlchemyOutputSchema` · `RarityTier` + `RARITY_LABEL`(四档阈值 1.00 / 1.25 / 1.55)· `RolledStats` · `ItemInstanceStats` · `AlchemyRecipeRow` · `recipeHash()` · `DEW_ITEM_ID=130` `ALCHEMY_FURNACE_ID=536` `BETA_DEW=0.15`。

### 2.5 `shared/constants/items.ts` — 329 项配表

`ITEM_LIST: readonly ItemDef[]`(329 条)· `ITEM_BY_ID: ReadonlyMap<number, ItemDef>` · `TOTAL_ITEM_COUNT=329` · `ITEM_TABLES`(十一分表 key/range/count)· `itemName(id)` `itemValue(id)` `itemTags(id)` `expandRecipe()`。

ID 分段(与手册 §3 完全一致,**任何写手不得新增或改号**):
`101-130` 自然(30) · `151-170` 半成品(20) · `201-218` 工具(18) · `221-255` 整蛊玩具(35) · `301-330` 地砖(30) · `351-385` 建筑构件(35) · `401-440` 电路物流竞技(40) · `501-537` 家具设备(37) · `601-630` 料理时装(30) · `701-745` 战利品武器护甲祭品(45) · **`746-754` 3.11 手册补录:牧场产出 2 + 无 ID 抽象奖励 7(9)**。
合计 **329 项 / 11 张分表**(320 原有 + 9 扩编,由 `tests/WS-FND-79-content-expansion.test.ts` 钉住)。

### 2.6 `shared/constants/mobs.ts` / `bosses.ts`

`MOB_LIST`(24 条,`mob_*` 命名)· `MOB_BY_ID` · `TOTAL_MOB_COUNT=24` · `mobsByBiome()` `tameableMobs()` `hostileMobs()`。
`BOSS_LIST`(8 条)· `BOSS_BY_ID` · `TOTAL_BOSS_COUNT=8` · `PARTY_MODES`(4)· `ROOM_RECIPES`(9)。

### 2.7 `shared/testing/harness.ts`

`test(name, fn)` `ok()` `eq()` `near()` `includes()` `inRange()` `mulberry32(seed)` `report(moduleName): number`。
测试文件模板:

```ts
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { packTile } from '../shared/types/tile.ts';

test('最高位不产生符号位污染', () => {
  const v = packTile({ elev: 3, base: 4, floor: 63, wire: 15, obj: 4094, meta: 15 });
  ok(v >= 0, '应为无符号 32 位');
});

report('WS-01');
```

### 2.8 `shared/types/wire.ts` — 线上格式唯一定义处

| 常量/函数/类型 | 签名 | 语义 |
| :--- | :--- | :--- |
| `PROTOCOL_VERSION`(值在 `net/delta.ts`) | `3` | 包头版本字节;**任何线格式改动必须 bump** |
| `FieldType` | `as const` 对象(7 种:`pos/u8/u16/u32/i16/str/hash`) | 字段类型词表,禁止 enum |
| `FIELD_TYPE_BYTES` | `Readonly<Record<string, number>>` | 定长类型的线上字节数(变长类型不在表内) |
| `POS_SCALE=1024` · `quantizePos(v)` · `dequantizePos(q)` | — | 坐标 1/1024 格定点(超 int32 钳到端点) |
| `FieldSpec` · `FIELD_TABLE`(14)· `WILDLIFE_FIELD_TABLE`(9)· `BOSS_FIELD_TABLE`(10)· `ROOM_FIELD_TABLE`(5) | `readonly FieldSpec[]` | 四张字段表:**唯一事实源**,顺序即编码顺序 |
| `tableFor(kind)` · `EntityKind` · `ENTITY_KIND_LABEL` | — | 实体种类判别(0 保留为非法) |
| `PlayerState` / `WildlifeState` / `BossState` / `RoomMetaState` / `RoomState` · `cloneRoomState(s)` | TS 接口 / 函数 | 状态结构(客户端必须装得下) |
| `StateFlagIndex` / `STATE_FLAG_NAMES` · `FsmIndex` / `FSM_NAMES` · `TelegraphShape` | `as const` 派生 | 位压缩 u8 → 语义的词表 |
| `chunkKey(cx, cy)` · `serializeChunkVersions(map)` · `parseChunkVersions(text)` | — | Chunk 版本号拍平成**键排序**的确定性串 |

线格式要点:`str` = 分段 u8 长度前缀(`< 255` 时与原 1 字节前缀**逐字节相同**;
≥ 255 时每 255 字节一段、段前缀写哨兵 `255`),上限 65280 字节
⇒ 房间级 `chunkVersions`(40 个 chunk ≈ 300 字节)不再触发「字符串超长」。
`u8/u16/u32` 字段**越界即抛错**,不做静默钳位;`u8` 与 `u16/u32` 统一 `Math.round`。

### 2.9 `shared/net/delta.ts` — 20Hz 差量编解码

| 常量/函数 | 签名 | 语义 |
| :--- | :--- | :--- |
| `PROTOCOL_VERSION` | `3` | 协议版本(**v3** = 包头 `tick` 后多加 4 字节 `ackedSeq`;跳过 2 因为 `FRAME_BINARY===0x02` 会撞值) |
| `PacketOp` | `{ FULL: 0, DELTA: 1 }` | 报文 op |
| `encodeDelta(prev, next, tick?)` / `encodeFull(state, tick?)` | `→ { bytes, stats }` | 字段级 diff;`prev===null` 退化为全量 |
| `decodePacket(bytes)` | `→ DecodedPacket` | 版本/op 门 + **恰好消耗完**(尾部有剩余 ⇒ 抛错) |
| `applyPacket(base, pkt)` | `→ RoomState` | 解码结果套回状态(round-trip 断言用) |
| `roomToFlat(s)` · `estimateBandwidth(players, tickHz?)` · `bandwidthTable(tickHz?)` | — | 房间拍平 / 带宽估算模型 |
| `diffChunkVersions(prev, next)` · `chunkWireBytes()` · `makeChunkVersionKey(cx, cy)` | — | Chunk 地形增量 |
| 再导出:`POS_SCALE` `quantizePos` `dequantizePos` | — | 调用方只 import `delta.ts` 即可 |

---

## 3. 每份交付物的强制结构(文档评分点)

`docs/WS-XX-<名称>.md` 必须包含以下 10 节,缺一节扣验收:

1. **职责边界** — 本子系统负责什么、明确不负责什么。
2. **上游/下游接口** — 引用冻结层哪些符号,向谁输出什么结构。
3. **数据结构** — 完整 TS 接口定义(字段、单位、取值范围)。
4. **算法与公式** — 伪码或数学式,含复杂度。
5. **参数配表** — 所有魔法数字以表格列全,标注出处(手册章节)。
6. **帧预算 / 性能** — 20Hz 或 2Hz 下的每帧开销估算,1GB 内存约束下的上界。
7. **异常与边界** — 空输入、上限、并发冲突、网络抖动、断线重连的处理。
8. **与其它子系统的耦合点** — 列表化,注明对接的 WS 编号。
9. **验收用例** — 至少 8 条可执行断言(与 `tests/WS-XX.test.ts` 一一对应)。
10. **未决问题** — 明确列出留给 Lead 裁决的事项。

---

## 4. 协作纪律

- **只写自己 scope 内的文件**;需要别人改,发消息给对应写手或 Lead。
- 冻结层文件被改动 = 全员返工,严禁。
- 每完成一个原子步骤后跑 `node scripts/verify.ts --only WS-XX`,失败不得提交。
- 提交给 Lead 的汇报格式:`WS-XX 完成 | 文件清单 | 测试通过数 | 阻塞项`。

---

## 5. D-19 冻结层解锁记录(owner 2026-11-17)

> **授权**:owner 于 **2026-11-17** 授权「冻结层解锁」这一批(`docs/DECISIONS.md`,
> 编号 **D-19**);逐条落点见 `docs/RULINGS-DRAFT.md` 4.1 U1/U7/U10、4.2 U5、
> 4.3 U5、4.4 EXTENDING U3、4.7 EVENT-BUS U6。
>
> **本节是这次放宽的完整清单。** 除本节列出的条目外,§0–§4 的一切约束**照旧有效**
> (`shared/testing/harness.ts` 永不改;`shared/types/physics.ts`、`entities.ts` 未动;
> 32 位单元格的既有位宽与 `CHUNK_BYTES = 1024` 未动)。**没有静默放宽**:任何一条
> 放宽都必须在这里留一行,`tests/WS-FND-66-frozen-unlock.test.ts` 第 9 组判据会
> **反向校验本节**(缺关键词即红)。

| # | 放宽了什么 | 为什么 | 授权 | 新的边界(仍然不许做的事) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 烹饪加 6 个参数槽 `defFlat` / `moveMul` / `gravityMul` / `jumpMul` / `gatherMul` / `expMul`(`shared/types/cooking.ts` + `shared/constants/cooking.ts`) | `FoodBuff.statMods` 只有加法类字段,倍率类效果(移速 / 重力 / 跳跃 / 采集 / 经验)无处可放,所有料理被迫只能用加法表达 | `RULINGS-DRAFT` 抬头点名 + 4.2 料理线 | **中性默认**(flat=0、mul=1)是**单位元,不是平衡裁决**;手册未给这 6 个槽任何数值 ⇒ 内容表只留中性默认并逐条标「待平衡」,不许在这里发明平衡数字。`combat/cooking.ts` 的 `FoodBuff` 结构**本批未改**(属 WS-10),本层只提供可被采纳的槽与合并律 |
| 2 | 蓝图尺寸从「必须 16×16」放宽到**任意 w×h**(下限 16,上限 `BLUEPRINT_MAX_SIZE = 128`) | 208 描图卷轴按定长写死 ⇒ 17×17 的屋子根本框不出来 | `RULINGS-DRAFT` 4.1 **U1** | 下限仍是 16(`tests/WS-03.test.ts` WT-03-37 未撤销,8×8 照样抛错);上限 128 单边——蓝图码是贴进聊天框的文本、接力队列又是每格一条,无上限即病态输入。`BLUEPRINT_SIZE = 16` 降级为**默认值**,不是删除 |
| 3 | 蓝图**允许携带四色暗线** `wire` | 蓝图该是「所见即所得」,暗线是建筑的一半 | `RULINGS-DRAFT` 4.1 **U7** | 只保留 `wire` 4 位原值;不改暗线语义 / 取色 / 通电规则(那是 WS-01 / WS-05) |
| 4 | 地砖 ID 从 **6 位扩到 u16**(`FLOOR_ID_BITS = 16`、`FLOOR_ID_MASK = 0xffff`) | 地砖表早已超过 64 种,6 位装不下 | `RULINGS-DRAFT` 4.1 **U10** | **32 位单元格一个字不动**(`FLOOR_MASK` 仍 `0xfc0`、`CHUNK_BYTES` 仍 1024)。u16 由「宽单元」承载:`packTileWide` / `unpackTileWide` / `wideCellValue`(lo 32 位 + hi 14 位)。**存档迁移与世界格扩宽不在本批**(WS-01 `world/chunk.ts`、WS-07 存档):`RelayQueue.applyTo` 落到 32 位世界格时按 `FLOOR_WORD_MASK` 截断,这是登记过的边界 |
| 5 | 立牌支持非 16×16:`VisualStyle.icon_size?`(`shared/types/alchemy.ts`) | 竖长 / 横幅立牌被 16×16 卡死 | `RULINGS-DRAFT` 4.2 **U5** | 字段**可选**,省略 = 16×16(`DEFAULT_ICON_SIZE`),既有 16×16 路径一字未改;`pixel_icon_16x16` 字段名保留(存档与 `llm_schema_json` 里以此键出现);`server/src/alchemy/prompt.ts` 的 LLM schema 本批未改 |
| 6 | 染色距离衰减曲线进冻结层(`shared/constants/dye.ts`) | 曲线原先散在美术口径里,没有任何可断言的东西 | `RULINGS-DRAFT` 4.3 **U5** | 只钉**形态(线性)与端点(1→0)+ 单调**;**不发明射程**:`range` 由调用方传入 |
| 7 | 事件名命名空间(`shared/types/events.ts`,29 种) | 29 种事件名只以字符串字面量存在:拼错不报错、订阅方写 `mimic_*` 恒不命中、加第 30 种事件没有任何地方会红 | `RULINGS-DRAFT` 4.7 **EVENT-BUS U6** | 线上的**扁平名字不改**(`boar_wall_stun`);发送侧 `server/src/mobs/behaviors.ts` 本批未改,判据**反向扫它**做双向一致校验。`EventKind` 是唯一事实源,新增事件必须同步登记 |
| 8 | 双 ID 宽度统一 **u16**(物体 / 物品 ID 12 位 → 16 位) | 线上 `heldItemId` / `weaponId` 是 u16,而格内 OBJ 层只有 12 位 ⇒ 同一个 ID 在两处宽度不同 | `RULINGS-DRAFT` 4.4 **EXTENDING U3** | 同第 4 条:32 位字里的 `OBJ_MASK = 0xfff` **不变**,u16 走宽单元(`OBJ_HI_BITS = 4`);线上协议 `shared/types/wire.ts` 一个字未改 |

**判据**(全部在 `tests/WS-FND-66-frozen-unlock.test.ts`,9 组,`node tests/WS-FND-66-frozen-unlock.test.ts`):

- **1 烹饪**:6 槽齐全;中性值 flat=0 / mul=1;与中性合并恒等于对方;flat 相加、mul 相乘且满足结合律;内容表逐槽与代码中性值一致并标「待平衡」。
- **2 蓝图**:17×17 可框、可编码(码前缀 `BP1:17x17:`)、可跨中继 289 格全部落地且逐格一致;8×8 与 129×129 仍抛错。
- **3 暗线**:256 格全组合 `wire` round-trip,16 种取值一个不少。
- **4 地砖**:0..99(共 100 种 > 64)与 65535 端点 round-trip;并**证明** 32 位字确实装不下 300。
- **5 双 ID**:4096 / 65535 能过;`heldItemId` 线上位宽 = 16 = 物体 ID 位宽。
- **6 立牌**:32×16 通过;缺 `icon_size` 时 32 宽矩阵报错;给了尺寸但矩阵不符也报错。
- **7 染色**:端点 1→0、中点 0.5、0..2R 采样单调不增。
- **8 事件**:29 种;与 `behaviors.ts` 双向一致;`mob_*` 前缀通配只接前缀化名字;`shared/**` + `server/src/build/**` 裸名 0 命中。
- **9 本节自校验**:D-19 / 2026-11-17 / RULINGS-DRAFT 与 8 项关键词逐条在场。
