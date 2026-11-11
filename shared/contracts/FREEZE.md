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
├── shared/                     # ── 冻结层,只读 ──
│   ├── types/{tile,physics,entities,alchemy}.ts
│   ├── constants/{items,mobs,bosses}.ts
│   ├── testing/harness.ts
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

### 2.5 `shared/constants/items.ts` — 320 项配表

`ITEM_LIST: readonly ItemDef[]`(320 条)· `ITEM_BY_ID: ReadonlyMap<number, ItemDef>` · `TOTAL_ITEM_COUNT=320` · `ITEM_TABLES`(十大分表 key/range/count)· `itemName(id)` `itemValue(id)` `itemTags(id)` `expandRecipe()`。

ID 分段(与手册 §3 完全一致,**任何写手不得新增或改号**):
`101-130` 自然(30) · `151-170` 半成品(20) · `201-218` 工具(18) · `221-255` 整蛊玩具(35) · `301-330` 地砖(30) · `351-385` 建筑构件(35) · `401-440` 电路物流竞技(40) · `501-537` 家具设备(37) · `601-630` 料理时装(30) · `701-745` 战利品武器护甲祭品(45)。

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
