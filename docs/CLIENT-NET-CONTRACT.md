# 客户端联机协议契约对齐(task-67 阶段 2)

> **任务**:task-67 阶段 2 · **作者**:`client-stage`(WS-09)
> **性质**:**定契约,不接线**。未修改 `client/**`、`server/**`、`shared/**` 任何一行。
> **前置**:阶段 1 = `docs/CLIENT-AUTHORITY-AUDIT.md`(已提交 `f086b18`)。
> **标注约定**:「**实测**」= 实跑探针,附文件名;「**读码**」= 静态读源码;「**未实测**」= 未验证。

---

## 0. 一句话结论

**两侧不是「同一个契约的两份实现」,而是「一份完整协议」与「一个 4 字段的占位结构」之间的关系。**

```
服务端 4 张字段表合计 **38 个字段**(玩家 14 + 野生动物 9 + Boss 10 + 房间 5)
客户端 Snapshot           ** 4 个字段**(tick, x, y, z)

⇒ 逐字段比过 **38 个**:**6 处对齐**(玩家 x/y/z + Boss telegraphX/Y/R)、
   **6 处「同名不同物」**、**26 个字段客户端无对应表达** ⇒ **不对齐合计 32 个**
   (**逐表小计相加 = 6+26+6 = 38,与字段总数闭合** —— 见 §3.5)
```
**⇒ 空清单规则不适用:清单是满的。** 下述 §3 是逐字段的对照表。

**★ 但真正危险的 3 处不是「字段缺失」,是「同名不同物」**(CR-20 形态):
```
① telegraphShape : 5 个下标**全部**被解成不同形状 —— 服务端 0=NONE 客户端同下标解成 CIRCLE
② stateFlag      : 服务端 7 态 ↔ 客户端只有 1 个布尔 `frozen`
③ move 通道      : InputCmd{seq,moveX,moveY,jump} ↔ MoveIntent{tick,x,y,z,speedMul} —— **零同名**
```
⇒ **这三处都会「编译通过、类型正确、静默出错」** —— 与阶段 1 的 S1/S2 是同一族。

---

## 1. 契约的事实源在哪(★ 先说清,因为它决定了「谁该改」)

| 层 | 文件 | 角色 | 三方依赖 |
| :--- | :--- | :--- | :--- |
| **唯一事实源** | `server/src/net/schema.ts` | 4 张 `FieldSpec[]` 表 + 定标 + 定标函数 | **0**(实测) |
| **编码/解码** | `server/src/net/delta.ts` | `encodeDelta`/`encodeFull`/`decodePacket` | **0**(实测,只 import `./schema.ts`) |
| **客户端** | `client/src/net/prediction.ts` | `Snapshot{tick,x,y,z}` | 只 import `@shared/types/physics.ts` |

**实测**(`_nc_pure.ts`):`schema.ts` 的相对依赖 2 个(`shared/types/physics.ts`、`shared/types/entities.ts`),
`delta.ts` 只依赖 `./schema.ts`,**两者三方依赖数均为 0**。

### ★ ★ 关键判定:客户端**没有**第二份字段表 —— 它连「抄」都没抄

Lead 提醒的「若是手抄的就报出来」——**实测结果比那更弱**:
```
enum-client 侧字段表:      **不存在**(client/src 里 FIELD_TABLE / POS_SCALE 出现 0 次)
客户端 Snapshot 字段:      4 个,手写在 prediction.ts:177
客户端解码能力:            **完全没有**(实测:DataView / getInt32 / dequantize / decodePacket
                            在 client/src 里出现次数 **各 0 次**)
```
**⇒ 客户端不是「同一契约的第二实现」(那至少还有对齐的可能性),
而是「一个从未与契约对过账的手写子集」。CR-20 讲的是「多份实现」;
这里连第二份都还没有 —— 只有 4 个字段的锚点。**

### ⚠️ 一条需要 Lead 裁决的选项(我**没有**动)

实测:`client/src` **可以**直接 import `server/src/net/schema.ts`(零三方依赖,`_nc_chan.ts` 通道 C 已跑通
`encodeFull` → 66 字节 → `decodePacket` → 2 upsert)。

而 WS-09 的**分层不变量**门禁(`tests/WS-09.test.ts` 的「纯逻辑层只依赖 node:* 与仓库内相对路径」)
**不会**拦住它 —— `../../server/src/net/schema.ts` 以 `.` 开头,正则判为「相对路径」⇒ **通过**。

```
实测:client/src 现有 import 指向 server/ 的:**0 处**
实测:WS-09.test.ts 里 import server/ 的:**0 处**
⇒ 跨层 import 目前是**无人走过的路**,既没有先例也没有禁令。
```

⇒ **我没有自行决定**。选项是:(a) 客户端 import 服务端的 `schema.ts`(契约单一事实源,但跨层);
(b) 把契约上移到 `shared/`(**冻结层,我不动**);(c) 客户端手写解码器(那就会出现真正的 CR-20)。
**请你裁决。** 我倾向 (a) 或 (b),因为 (c) 会制造本仓反复吃亏的那种「同名不同物」。

---

## 2. 通道契约

### 2.1 服务端已有的下行通道(读码)

| 通道 | 触发 | 载荷 | 出处 |
| :--- | :--- | :--- | :--- |
| `'snapshot'` | `onJoin` 成功 | **全量** `Uint8Array` | `room.colyseus.ts:145`;生成于 `room.ts:642` `encodeFull(...)` |
| `'delta'` | 每 tick(`stepTick`) | **差量** `Uint8Array`(空则不广播) | `room.colyseus.ts:165` `broadcast('delta', ...)` |
| `'correct'` | `move` 被反作弊拒 | `{x,y,z}` 或 `null` | `room.colyseus.ts:193` |
| `'reject'` | `attack`/`inventory`/`action` 被拒 | `{kind, reason?}` | `room.colyseus.ts:207` / `:237` / `:241` |
| `'attackResult'` | `attack` 成功 | `{resolved,mobId,outcome,hpLoss,finalDamage,outOfReach,dodged}` | `room.colyseus.ts:219` |

### 2.2 上行通道

| 通道 | 载荷(服务端读取的字段) | 出处 |
| :--- | :--- | :--- |
| `'move'` | `{ tick, x, y, z, speedMul? }` | `room.colyseus.ts:191` → `MoveIntent`(`anticheat.ts:283`) |
| `'attack'` | `{ claimedBonus?, mobId? }`(**只这两个**;`level`/`wearing`/`weaponId`/`comboMul` 服务端忽略) | `room.colyseus.ts:200` |
| `'inventory'` | `{ ops: {itemId, delta, source?}[] }`(**只有 ops**;`allowedSources`/`capacity`/`beforeTotal` 服务端忽略) | `room.colyseus.ts:233` |
| `'action'` | `{ action }` | `room.colyseus.ts:239` |

### 2.3 报文**字节**布局(实测 `decodePacket`)

```
version  u8    必须 === PROTOCOL_VERSION(=1),否则 throw
op       u8    0=FULL 1=DELTA
tick     u32   世界帧号;**无条件覆盖** meta.tick(单调时钟,不是 diff 字段)
removedCount u16
  └ 每项: kind u8 + id str
upsertCount  u16
  └ 每项: kind u8 + id str + mask u32 + [按 bit 升序,仅 mask 命中的字段]
字段类型线上宽度:
  pos  i32(小端,值 = 格 × 1024)   u8/u16/u32 定长   i16 2B   str/hash = u8 长度前缀 + UTF-8
⇒ 头部固定 6 字节
```
**实测往返**:`{x:12.345, y:67.891, z:1}` ⇒ `{x:12.3447265625, y:67.890625, z:1}`,
**误差 2.73e-4 格 ≤ 1/2048 = 4.88e-4** ✓(**读值已 dequantize 回「格」**,见 `delta.ts:190`)。

### 2.4 ★ 选型:建议 `ws`,不建议 colyseus(附实测理由)

| 通道 | 实测结果 | 判定 |
| :--- | :--- | :--- |
| **`ws` 裸 WebSocket** | ✓ 本机监听 + 往返 + **阴性对照**(连死端口正确失败)全过。**零构建步骤** | ★ 推荐 |
| **colyseus** | ✗ 房间层**根本加载不了** —— `schema.colyseus.ts` 有 **44 处 `@type` 装饰器**,Node strip-only **无法擦除**(实测 `room.colyseus.ts` 报 `SyntaxError: Invalid or unexpected token`,它自己 0 装饰器,**是传递依赖**) | 需先有构建步骤,违反「服务端零构建」铁律 |
| | ✗ `import { Room, Client } from 'colyseus'` 实测 `m.Client === undefined` ⇒ **命名导入会抛**。`export default` 里有 `Server`/`Room` 但**没有 `Client`** | |

⇒ 阶段 3 用 `ws`,**恰好绕开** `server/src/index.ts:37-48` 记录的那个阻塞点(它当时给 colyseus 判的
「无法被 Node 加载」**经我独立复核成立**,但**只对 colyseus 层成立** —— 换 `ws` 就没有这个问题)。

> ⚠️ 附带发现(我自己踩的,同族陷阱):`import { WebSocketServer } from 'ws'` 也抛
> `Named export 'WebSocketServer' not found`;而我**按名字猜** `WebSocketServer`,
> 又得到 `TypeError: not a constructor`。**枚举真实导出**才知道是 `Server`(`ws` 的 `default` 是客户端构造器)。
> ⇒ **猜导出名 = 猜错了两次**。这条与阶段 1 我「引了没核过的行号」是同一类错。

---

## 3. ★ 逐字段对照表(38 个字段逐条)

**图例**:`✓对齐` = 两侧都能表达且语义一致;`缺失` = 客户端无对应表达;`★错配` = 两侧都有但语义/单位/下标不同。

### 3.1 玩家 `FIELD_TABLE`(14 字段 · `shared/types/wire.ts:106`;切分前在 `schema.ts:85`)

| bit | 字段 | 服务端类型/单位 | 客户端 | 判定 |
| --: | :--- | :--- | :--- | :--- |
| 0 | `id` | str(8B) | — | 缺失 |
| 1 | `name` | str(9B, len+UTF-8) | — | 缺失 |
| 2 | `level` | u8, 1..30 | — | 缺失(**客户端 boss_hud/recipe 都按本地常量算**) |
| 3 | `hp` | u16, 整数 HP | — | 缺失 |
| 4 | `maxHp` | u16 | — | 缺失 |
| 5 | `x` | **pos, i32, 格 ×1024** | `Snapshot.x` | **✓对齐**(实测往返误差 2.73e-4) |
| 6 | `y` | **pos, 格 ×1024** | `Snapshot.y` | **✓对齐** |
| 7 | `z` | **pos, 格** ∈[-1,3] | `Snapshot.z` | **✓对齐** |
| 8 | `dir` | u8, **0=北 1=东 2=南 3=西** | — | **缺失**(客户端朝向只在 `entity_sprites` 里按参数传;无权威来源) |
| 9 | `stateFlag` | u8, **BodyState 七态索引 0..6** | `PredictParams.frozen?: boolean` | ★**错配**(见 §4.2) |
| 10 | `weaponId` | u16(0=空手) | — | 缺失 |
| 11 | `aiWeaponRecipeHash` | hash(13B, `116_125_712` 形态) | — | 缺失 |
| 12 | `heldItemId` | u16(0=空) | — | 缺失 |
| 13 | `carryingEntityId` | str(9B, 空串=无) | — | 缺失 |

**小计:14 个字段,3 对齐 / 10 缺失 / 1 错配。**
> ⚠️ 上一版此处写「11 缺失」。**是我数错了** —— 逐行重数:14 字段里
> `id/name/level/hp/maxHp/dir/weaponId/aiWeaponRecipeHash/heldItemId/carryingEntityId` = **10** 个缺失,
> 不是 11。错因:我把「14 − 3 − 1 = 10」算成了 14 − 3 − 0 = 11(漏了那 1 个错配)。
> 这个错被 §8 的校验器复算抓出(它从表格逐行判定,不读我手写的小计)。

### 3.2 野生动物 `WILDLIFE_FIELD_TABLE`(9 字段 · `shared/types/wire.ts:124`,切分前 `:103`)

| bit | 字段 | 类型 | 客户端 | 判定 |
| --: | :--- | :--- | :--- | :--- |
| 0 | `id` | str | — | 缺失 |
| 1 | `mobId` | str(17B, `mob_*` 键) | — | 缺失(客户端只有 `atlas_sprites` 立牌,无实体列表) |
| 2 | `x` | pos | — | 缺失(**注意:客户端 `Snapshot.x` 是「本地玩家」语义,不是「远程实体」**) |
| 3 | `y` | pos | — | 缺失 |
| 4 | `z` | pos | — | 缺失 |
| 5 | `fsm` | u8, **`MobFsmState` 三态索引** | — | 缺失 |
| 6 | `hp` | u16 | — | 缺失 |
| 7 | `maxHp` | u16 | — | 缺失 |
| 8 | `tameOwnerId` | str(9B, 空串=野生) | — | 缺失 |

**小计:9 个字段,0 对齐 / 9 缺失。**
> ⚠️ 上一版把 bit 2-4 的 `x,y,z` **并成一行**写(「| 2-4 | `x`,`y`,`z` |」)。
> 内容没错,但那让「9 个字段」在**逐行口令**下只能数出 7 行 ⇒ 与「9 字段」对不上。
> **我一律展开成一行一字段** —— 合并行会让「分母」无法复核。
> 这个不一致同样被 §8 的校验器抓出。
> ⚠️ 这里有个**语义陷阱**:客户端 `Snapshot` 的 x/y/z 是「**我的**位置」。若把
> `WILDLIFE.x` 也解到同一个 `Snapshot` 上,就会复现阶段 1 的 S1(两个语义共用一个变量)。
> **⇒ 契约必须区分「本地玩家位置」与「远程实体位置」两个容器。**

### 3.3 Boss `BOSS_FIELD_TABLE`(10 字段 · `shared/types/wire.ts:137`,切分前 `:116`)—— ★ 阶段 3 画预警圈要用

| bit | 字段 | 类型/单位 | 客户端可表达? | 判定 |
| --: | :--- | :--- | :--- | :--- |
| 0 | `id` | str | — | 缺失 |
| 1 | `bossId` | str(17B, `boss_*` 键) | — | 缺失(**客户端用 `BOSS_LIST[0]`,boot.ts:489**) |
| 2 | `phase` | u8, **索引 0..2** | `phaseLabels(boss)` 从**本地 HP** 推 | ★**错配**(客户端自己从 HP 反推阶段,不读服务端 `phase`) |
| 3 | `hp` | **u32**(Boss 上限 38000 需 u32) | `bossHp` 由**本地 dt 递减**(阶段 1 的 S2) | ★**错配** |
| 4 | `maxHp` | u32(缩放后) | `boss.baseHp`(冻结层常量) | ★**错配** |
| 5 | `telegraphShape` | u8, **0=无 1=圆 2=扇 3=矩形 4=环** | 见 §4.1 | ★**错配(5/5 下标全冲突)** |
| 6 | `telegraphX` | pos,**格** | `TelegraphSpec.cx`(格) | **✓对齐**(单位一致) |
| 7 | `telegraphY` | pos,**格** | `TelegraphSpec.cy`(格) | **✓对齐** |
| 8 | `telegraphR` | pos,**格** | `TelegraphSpec.radius`(格) | **✓对齐** |
| 9 | `telegraphEndTick` | **u32,绝对 tick** | `TelegraphSpec.chargeSec`(**秒**) | ★**错配(单位不同,需 `(endTick-now)/TICK_HZ` 换算)** |

**小计:10 个字段,3 对齐 / 2 缺失 / 5 错配。**

**★ 客户端 `TelegraphSpec`(`boss_hud.ts:37`)需要 12 个字段,服务端只给 5 个:**

| 客户端需要 | 服务端有? | 说明 |
| :--- | :--- | :--- |
| `shape` | ✓(但词表冲突) | 见 §4.1 |
| `cx` / `cy` | ✓ | 对齐 |
| `cz` | ✗ | **服务端不发**;客户端要它定圆所在平面 |
| `radius` | ✓ | 对齐 |
| `innerRadius` | ✗ | **服务端不发** —— 而服务端有 `RING(4)` 形状,**环必须有内半径** |
| `facing` | ✗ | **服务端不发** —— `SECTOR`/`CONE` 必须有朝向 |
| `spreadRad` | ✗ | **服务端不发** —— 扇形张角 |
| `length` / `width` | ✗ | **服务端不发** —— `RECT`/`LINE` 需要 |
| `chargeSec` | 仅 `telegraphEndTick` | **单位不同**(绝对帧 vs 秒) |
| `danger` | ✗ | 客户端自定 0..1 |

⇒ **结论:服务端的预警几何只够画「圆」和「环的半径」。
扇形/矩形/直线所需的朝向、张角、长宽一律不在协议里。**
`telegraphShape` 的 5 个取值里有 3 个(`SECTOR`/`RECT`/`RING`)**服务端发得出、客户端画不出**。
**这是协议层的缺口,不是客户端缺口** —— 修它要动 `server/**`(或 `shared/**`),**请你裁决。**

### 3.4 房间 `ROOM_FIELD_TABLE`(5 字段 · `shared/types/wire.ts:157`,切分前 `:136`)

| bit | 字段 | 类型 | 客户端 | 判定 |
| --: | :--- | :--- | :--- | :--- |
| 0 | `chunkVersions` | str(24B,"cx,cy:v" 分号串) | — | 缺失(见 §5 **协议缺口**) |
| 1 | `partyMode` | u8, 0=NONE..4=PAINT_WAR | — | 缺失 |
| 2 | `partyTimer` | **pos 类型但语义是「剩余秒数」** | — | 缺失(★ **类型与语义不符,服务端自己标的**) |
| 3 | `scoreA` | u16 | — | 缺失 |
| 4 | `scoreB` | u16 | — | 缺失 |

**小计:5 个字段,0 对齐 / 5 缺失。**

### 3.5 ★ 汇总(**分母必须报出来**)

```
逐字段比过 **38 个**(玩家 14 / 野生动物 9 / Boss 10 / 房间 5)

四张明细表逐行判定后相加(这才是可复核的口径):
  玩家     3 对齐 / 10 缺失 / 1 错配 = 14  ✓
  野生动物 0 对齐 /  9 缺失 / 0 错配 =  9  ✓
  Boss     3 对齐 /  2 缺失 / 5 错配 = 10  ✓
  房间     0 对齐 /  5 缺失 / 0 错配 =  5  ✓
  ------------------------------------------
  合计     6 对齐 / 26 缺失 / 6 错配 = 38  ✓ 与字段总数相等

⇒ **不对齐合计 32 个字段**(26 缺失 + 6 错配)。
另:报文头的 `tick` 被客户端 `Snapshot.tick` 表达 ✓(它不是字段表里的字段,单独计,不并入 38)
```

> ⚠️ **这个汇总我返工过两次,记下来**(§8 校验器用「从表格逐行判定」的口径复算,
> 不读我手写的小计 —— 两次都是它抓出来的):
> 1. **第一次**:§3.1 小计我写「11 缺失」,真值 **10**(错因:把 `14−3−1=10` 算成 `14−3−0=11`)。
> 2. **第二次**:§3.2 我把 bit 2-4 的 `x,y,z` **并成一行**,导致逐行只能数出 7 个字段。
>    ⇒ 校验器据表格复算出「缺失 24、合计 36」,**与 38 差 2**。
>    **★ 我当时没有把差额抹平,而是先在文档里标出「差额未查明」** —— 因为我怀疑的是
>    「已知的行被合并」而不是「文档缺了 2 个字段」。**展开 §3.2 后差额消失,验证了这个猜测。**
> ⇒ **判据:合计必须等于字段总数。不等于时先查「表格是不是合并过行」,再查「数字是不是算错」。**

> **这 38 个不是我数的**,是 `_nc_tables.ts` 从 `FIELD_TABLE.length` 等**读出来的**(含
> `validateFieldTable` 逐表校验 bit 不重复/升序/不越界 —— 全过)。

---

## 4. ★ 三处「同名不同物」(CR-20 形态)

### 4.1 `telegraphShape`:5 个下标**全部**被解成不同形状

`_nc_cmp.ts` 实测(把服务端的数字直接当客户端数组下标用):

| 下标 | 服务端语义(`schema.ts:196`) | 客户端同下标解成(`boss_hud.ts:35`) | |
| --: | :--- | :--- | :--- |
| 0 | `NONE` | `CIRCLE` | ✗ |
| 1 | `CIRCLE` | `ANNULUS` | ✗ |
| 2 | `SECTOR` | `CONE` | ✗ |
| 3 | `RECT` | `LINE` | ✗ |
| 4 | `RING` | `CROSS` | ✗ |

```
⇒ **5/5 冲突**。两侧唯一同名的 `CIRCLE` 还**坐在不同下标上**(服务端 1 / 客户端 0)。
⇒ 最毒的是 0:服务端 0 = **「没有预警」**,客户端同下标解成 **CIRCLE**
   ⇒ 玩家会看到一个**根本不存在的预警圈**;而 0 是「无预警」的默认值,出现频率最高。
```
**两侧的命名集合**:仅服务端 `NONE,SECTOR,RECT,RING`;仅客户端 `ANNULUS,CONE,LINE,CROSS`。

### 4.2 `stateFlag`:7 态 ↔ 1 个布尔

```
服务端 StateFlagIndex(schema.ts:149,由 BodyState 顺序生成):
  0=NORMAL 1=SLIPPING 2=STUNNED 3=BUBBLED 4=FROZEN 5=GHOST_BUBBLE 6=AFK_SHIELD
  ✓ 实测 `STATE_FLAG_NAMES` 与冻结层 `BODY_STATES` **逐项相等**(位定义本身没问题)

客户端能表达的(PredictParams, prediction.ts:56):
  { speedMul?: number; mu?: number; frozen?: boolean }
  ⇒ **只有 1 个布尔**
```
| 服务端态 | 客户端能表达? |
| :--- | :--- |
| `NORMAL` | `frozen=false` ✓ |
| `STUNNED` / `BUBBLED` / `FROZEN` / `GHOST_BUBBLE` | 全部折叠成 `frozen=true` ⇒ **相互不可区分** |
| `SLIPPING` | ✗ 无处放(**滑行不是「冻结」**) |
| `AFK_SHIELD` | ✗ 无处放 |

⇒ **7 态压成 2 态。** 而 `stateFlag` 的用途是「客户端据此决定要不要跑预测」——
把 `SLIPPING` 误当 `NORMAL` 会**预测出错误的滑移**,把 `GHOST_BUBBLE` 与 `BUBBLED` 混同会**画出错误的泡泡**。
**⇒ 客户端需要的是 `stateFlag: number`(0..6),不是 `frozen: boolean`。**

**位定义(Lead 明确要求,逐位给全)**:见 §3.1 bit 9;索引即 `BODY_STATES` 数组下标,
两侧同源(`BodyState` 定义在 `shared/types/physics.ts:34`,**冻结层**)。
`dir` 的位定义:`0=北 1=东 2=南 3=西`(`schema.ts:94` 的 note),u8,**客户端无对应字段**。

### 4.3 `move` 通道:**零个字段同名**

```
客户端 InputCmd  (prediction.ts:40) : { seq, moveX, moveY, jump }
服务端 MoveIntent (anticheat.ts:283) : { tick, x, y, z, speedMul }
同名交集:**空**
```
⇒ 服务端 `move` 处理器读 `msg.tick` / `msg.x` / `msg.y` / `msg.z`;
客户端 `InputCmd` **没有这些字段** ⇒ **直接发送会全部读到 `undefined`**。

⚠️ **这正是 Lead 在任务书里警告的陷阱 62 形态**:服务端反作弊**会正确地**拒绝这种输入
(`checkMove` 对非有限坐标/帧号判 `TELEPORT`,detail 写着原因),
**而那个拒绝会被误读成「联动不成立」。**
**⇒ 阶段 3 的适配层必须做名字/语义转换**,且**必须读拒因文本**(`Verdict.detail`),不能只看 `allowed`。

**两边的坐标系也不同**:`InputCmd.moveX/moveY` 是**归一化前的方向输入 ∈[-1,1]**;
`MoveIntent.x/y/z` 是**目标世界坐标(格)**。⇒ 不只是改名,是**语义转换**
(`predictStep` 输出的位置才是 `MoveIntent.x/y/z`)。

---

## 5. ★★ 最大的一个缺口:地形**根本不在协议里**

Lead 在阶段 1 §7 让我把「地形 Chunk」列为阶段 2 输入。**实测结论比预期严重:**

```
ROOM_FIELD_TABLE 只有 `chunkVersions`(一个 "cx,cy:v;..." 的**版本号字符串**)
在 server/src/net/** 里搜 tiles / Uint32Array / chunkData / CHUNK_BYTES / packTile / ChunkInput
  ⇒ **0 命中**
⇒ 协议告诉客户端「chunk (2,3) 变成版本 5 了」,但**没有任何通道能让客户端取到那 1024 字节的格数据**
```
**⇒ 这是协议层的缺口,不是客户端的缺口。** 修它必须动 `server/**` 或 `shared/**` —— **不在我的写域。**

**而客户端这边的世界尺寸是三方不一致的(实测):**

| 出处 | 值 | 用途 |
| :--- | --: | :--- |
| `client/src/stage/demo_world.ts:28` | **64**(4 chunk × 16) | `boot.ts:166` 真正建地形用的 |
| `client/src/stage/tile_mesh.ts:50` | **1024** | `WORLD_SIZE_CELLS`(设计尺寸) |
| `client/src/stage/iso_camera.ts:210` | **1024** | `DEFAULT_FOLLOW.worldMaxX/Y` |
| (实际生效) `boot.ts:976` | **72** | `pan` 被钳到 `WORLD_CELLS+8` |

⇒ 相机配置说世界是 1024,地形生成器只造 64,相机又被钳在 72。**接入服务端地形时这三处都要一起改。**

---

## 6. 我能证明的 / 我不能证明的

### 6.1 ★ 能证明的(实测,附探针)

| # | 结论 | 探针 |
| --: | :--- | :--- |
| P1 | 4 张表合计 **38 字段**;各表 bit 不重复/升序/不越界 | `_nc_tables.ts` |
| P2 | `telegraphShape` **5/5** 下标语义冲突 | `_nc_cmp.ts` |
| P3 | `stateFlag` 7 态 ↔ 客户端 1 布尔;`STATE_FLAG_NAMES === BODY_STATES` | `_nc_cmp.ts` |
| P4 | `move` 通道 **零同名**字段 | `_nc_cmp.ts` |
| P5 | 位置单位是**格**,`pos` 往返误差 **2.73e-4 ≤ 1/2048** | `_nc_cmp.ts` |
| P6 | `schema.ts`/`delta.ts` **零三方依赖**,可被客户端 import | `_nc_pure.ts` / `_nc_chan.ts` |
| P7 | `ws` 通道**当下可开**(往返 + 阴性对照全过);colyseus 房间层**加载不了**(44 装饰器) | `_nc_chan.ts` / `_nc_load*.ts` |
| P8 | 客户端**无任何解码器**(`DataView`/`dequantize`/`decodePacket` 各 0 次) | 读码 |
| P9 | 协议里**没有地形数据通道** | `_nc_*` + 读码 |
| P10 | 客户端 `import` 指向 `server/`:**0 处** | `_nc_cross.ts` |

**每个探针都带自证**:`POS_SCALE=1024` / `PROTOCOL_VERSION=1` 已知答案过;
**阴性对照**包括「重复 bit 的假表必须判红」「连死端口必须失败」「错位掩码必须解出不同字段集」。

### 6.2 不能证明的(未实测,不得当结论)

| # | 项 |
| --: | :--- |
| U1 | 服务端在真实运行中**实际下发**哪些字段(我只跑了 `encodeFull` 单次往返,未跑 20Hz 长跑) |
| U2 | `TelegraphShape.SECTOR/RECT/RING` 在服务端**是否真的会被置上**(表里有,但生产赋值点我未追) |
| U3 | `partyTimer` 用 `pos` 类型承载「秒数」是否会造成实际精度问题(我判定「类型与语义不符」是**读码**) |
| U4 | colyseus 用 tsc 预编译后能否跑通(我只证明了 **Node 直跑**不行) |
| U5 | 客户端 Vite 构建是否会因 import `server/**` 而出问题(未试构建) |
| U6 | `dir` 在服务端的生产赋值点(字段表里有,但它是否恒 0 我未追) |

### 6.3 我没做的

- **没改任何一行**:`client/**`、`server/**`、`shared/**` 全部只读。
- **没写接线代码**(阶段 3)。
- **没动 `shared/**`** —— §1 那条「契约上移」的选项**留给 Lead 裁决**。

---

## 7. 给阶段 3 的契约清单(可执行项,不含代码)

| # | 项 | 必须做 | 需要谁 |
| --: | :--- | :--- | :--- |
| C1 | 选通道 | **`ws`**(理由见 §2.4) | 我 |
| C2 | 解码器 | 新建(`client/src/net/`),解 §2.3 的字节布局 | 我 |
| C3 | 字段表来源 | import `server/src/net/schema.ts` **或** 上移 `shared/` —— **待裁决** | **Lead** |
| C4 | `telegraphShape` 映射 | 写**显式映射表**,禁止直接用下标 | 我 |
| C5 | `stateFlag` | 扩成 `number`(0..6),替掉 `frozen: boolean` | 我(动 `prediction.ts` 签名 ⇒ 需同步 `tests/WS-07.test.ts`) |
| C6 | `move` 通道适配 | 名字 + 语义转换(方向输入 → 目标坐标),**并读 `Verdict.detail`** | 我 |
| C7 | 预警几何补字段 | `facing`/`spreadRad`/`innerRadius`/`length`/`width` 协议里没有 ⇒ **需动 server/shared** | **Lead** |
| C8 | 地形通道 | 协议里没有 ⇒ **需动 server/shared** | **Lead** |
| C9 | 世界尺寸三方不一致 | 64 / 1024 / 72 统一 | 我 |
| C10 | 阶段 1 的 S1/S2 | 先删 `boot.ts:1033-1034`,再取权威值 | 我 |

**验收要求(Lead 在阶段 2 前给的,我转换成本阶段的可判定形式)**:
- ✅ 「逐字段比过 N 个字段」——**N = 38**,见 §3.5。
- ✅ 「不对齐清单」——**32 个**(6 错配 + 26 缺失),逐条在 §3。
- ✅ 单位/缩放/类型 —— `pos` = i32 × 1024;`telegraphEndTick` = 绝对帧;`partyTimer` = pos 载秒数。
- ✅ 补上 Boss `phase`/预警几何(§3.3)与玩家 `stateFlag`/`dir` 位定义(§4.2)。

---

## 8. 复现方式

```powershell
node _nc_tables.ts   # 38 字段清点 + validateFieldTable(含阴性对照:假表判红)
node _nc_cmp.ts      # ★ 三处同名不同物 + 位置往返精度 + 掩码有牙性
node _nc_pure.ts     # import 纯度(三方依赖数)
node _nc_load.ts     # 房间层可加载性(自证 + 阴性对照)
node _nc_load2.ts    # 传递依赖定位 + colyseus 导出形态
node _nc_chan.ts     # ★ 通道可行性(ws 往返 + 死端口阴性对照)
node _nc_lines.ts    # 行号(★ 用 Node 取,不用 PowerShell —— 陷阱 60)
```
**全部为仓库根下的 `_` 前缀临时文件,已删除。未写入 `scripts/`(陷阱 61:那里在审计扫描根内会假红)。**

**行号提示**:`server/src/net/**` 正在被 net-persist 修改(实测 `room.ts` 已从 1076 行增至 **1474** 行,
新增了 `syncLevelProjections`)。§3 所有条目均同时给**字段名与表名**,可用 `grep` 反查,不单靠行号。

> ⚠️ **行数口径**(我这次核对出的一个坑):`room.ts` 以换行结尾,所以
> `readFileSync(...).split('\n').length` 得 **1475**,而 `read` 工具报 **1474**。
> 差的那 1 是**末尾空串**。**本文所有「行数」一律用 `read` 工具的口径(1474)**,
> 因为它与 `server/src/net/room.ts:1474 export { getRoom, loadReconnectSnapshot };` 一致 ——
> 最后一行是真实代码,不是空行。**报行数时必须说清用哪个口径**,否则 1474 与 1475 会各说各话。

---

## 9. ⚠️ 一条与 task-56 有关的更新(顺带)

本阶段读 `room.ts` 时发现:**net-persist 已经把等级投影接上了**(`room.ts:1192 syncLevelProjections()`,
`:1198` 处 `Math.max(1, Math.min(MAX_LEVEL, Math.trunc(lv)))`,由 `:1153` 每帧调用)。

⇒ **我在 task-56 `docs/GUARD-CONTRACTS.md` §2 的判定仍然成立,但前提已变**:
我当时的结论是「`state.players[].level` 恒为 1 ⇒ 钳制不可达 ⇒ 不是真缺口」。
**现在 `level` 有了真正的写入者** ⇒ `carryCapacityOf` 的上界**即时变为可达** ——
而作者已在 `room.ts:1183-1190` 写明「这里夹一次上界……该上界此前是**惰性**的(level 恒 1),
接线后即时生效」**并加了钳**。
**⇒ 我恰好预判对了这一步,而它在我写文档之后发生了。**
§2 的「契约型风险 R1/R2/R3」应更新为「**已接线,风险由作者自行钳住**」——
但 `docs/GUARD-CONTRACTS.md` 是 task-56 的交付物、已 complete,
**要不要改由你定**(我不擅自 reopen)。

---

## 10. ★ 切分线复核(CR-24 授权,只读)

> Lead 裁决:(b) 按**实测消费者**把 `schema.ts` 的导出切分上移,而不是整文件搬 (a)、
> 也不是客户端手抄 (c)。本节是他要求的**只读复核**,未动任何文件。
> 复核工具:`_sp_a.ts`(消费者矩阵)、`_sp_b.ts`(符号闭包)、`_sp_c.ts`(C4 归属)、
> `_sp_d/e.ts`(口径与未用导入)、`_sp_f/g.ts`(冻结层扫描)。

### 10.1 ★★ 先说一个数字口径差(不查清它,C4 的条数永远对不上)

```
`export` 声明行命中        **46**
其中同名对                **3** 组:FieldType ×2、TelegraphShape ×2、EntityKind ×2
                          (`export const X` + `export type X`,TS 里是合法的一对)
⇒ **唯一符号名 = 43**
```
| | 计数对象 | 结果 |
| :--- | :--- | :--- |
| Lead | 「导出条目」(含同名对) | **46** |
| 我 | 「唯一符号名」(去重) | **43** |
| **★ 影响** | Lead 算 `46 − 18 − 3 − 3 = 22` 得 **C4 = 22**;用唯一名算是 `43 − 24 =` **C4 = 19** | **差 3 = 那三组同名对** |

**⇒ 两个口径都对,但必须说清是哪一个**,否则「C4 有 22 个还是 19 个」会各说各话。
**下面我用唯一名口径 = 19**,并逐条给出归属(§10.3)。

### 10.2 ✅ 切分线自洽性:**成立**(我独立复算,不采信结论)

**Lead 的关键核对**——「`decodePacket` 体内用到的符号是否全落在 C1 ∪ C3」——我**扩到整套编解码**复核:

```
delta.ts 从 schema.ts 导入 **21** 个符号
  ⇒ 落在 C1∪C3(应上移 shared):**21 / 21**
  ⇒ 落在 C2(纯服务端状态管理):**0** ✓
  ⇒ 落在 C4:                 **0**
```
逐函数复核(全部 ✓,无一落在 C1∪C3 之外):

| 函数 | 行 | 用到的 schema 符号 |
| :--- | :--- | :--- |
| `decodePacket` | 422-448 | `EntityKind`, `tableFor` |
| `applyPacket` | 451-488 | `EntityKind` `ROOM_FIELD_TABLE` `cloneRoomState` `tableFor` `BossState` `PlayerState` `RoomState` `WildlifeState` |
| `mergeEntity` / `defaultFor` | 490-517 | `FieldSpec`, `FieldType` |
| `encodeDelta` / `planFor` | 299-391 | `EntityKind`, `RoomState`, `tableFor`, `FieldSpec` |
| `normalized` / `writeField` / `readField` | 162-234 | `FieldType` `quantizePos` `dequantizePos` `FieldSpec` `ENTITY_KIND_LABEL` `EntityKind` |
| `roomToFlat` / `applyFlatToRoom` | 259-275 | `serializeChunkVersions`, `parseChunkVersions`, `RoomState` |

**⇒ Lead 的切分线自洽,`C2` 三个符号确实只需服务端。这一条我确认成立。**

**反向核对**:`room.ts` 从 schema 只导入 5 个(`createPlayerState` `createRoomState` `cloneRoomState`
`PlayerState` `RoomState`),其中 3 个(`PlayerState`/`RoomState`/`cloneRoomState`)来自 shared
⇒ **切分后 room.ts 的 import 需要拆成两行(shared + server),这是预期的、不是缺陷。**

### 10.3 ⚠️ 我对 C1 命名的一处修正(归属不变,但「理由」要改)

矩阵显示:**`FIELD_TABLE` 被 `delta.ts` 导入,但体内使用 0 次**(裸 `FIELD_TABLE` 在 import 块后出现 0 次;
1 次命中是 `ROOM_FIELD_TABLE` 的子串)。同样 `WILDLIFE_FIELD_TABLE`、`BOSS_FIELD_TABLE` 也是 **未使用导入**。

```
⇒ 三张表的真实消费者是 schema.colyseus(4/1/1)+ tests + scripts,**不是** delta
⇒ C1 的标题「只被编码器用」对这三张表**不准确**
⇒ 但**归属建议不变**:客户端解码要靠 tableFor(kind) 拿到表,三张表都必须在 shared
⇒ 精确说法:C1 = 「**线上格式的一部分**(被编码器**或它的同类消费者**用)」
```

### 10.4 ★ C4 的 19 个:归属建议(**按判据,不按「谁引用它」**)

**判据**:符号属于 `shared` ⟺ **客户端必须用它解释收到的字节**
(枚举索引要能解成语义、状态结构要能装下、定标要能换算)。

| 归属 | 符号 | 理由 |
| :--- | :--- | :--- |
| **→ shared(6)** | `StateFlagIndex` | 解 `player.stateFlag`(u8 0..6)→ 语义。不上移 ⇒ 客户端只能自己抄索引 = **真 CR-20** |
| | `STATE_FLAG_NAMES` | 同上(且**当前无人引用** —— 与 shared 的 `BODY_STATES` 冗余) |
| | `FsmIndex` | 解 `wildlife.fsm`(u8)→ 语义 |
| | `FSM_NAMES` | 同上(**当前无人引用**) |
| | `TelegraphShape` | ★ 解 `boss.telegraphShape`(u8 0..4)。**§4.1 实测 5/5 下标与客户端冲突** ⇒ 两侧必须只有**一份**词表 |
| | `RoomMetaState` | 是 `RoomState` 的字段,而 `RoomState` 已在 C3 ⇒ 必须随之 |
| **→ server(13)** | `MAX_FIELDS_PER_TABLE` | 掩码宽度;仅 `validateFieldTable` 用,是**服务端自检**常量 |
| | `createWildlifeState` / `createBossState` | 构造器 = 建实体,只在服务端发生 |
| | `upsertPlayer` / `upsertWildlife` / `upsertBoss` | 变更 `RoomState` = **服务端写操作** |
| | `removeWildlife` / `removeBoss` | 同上(两者**当前无人引用**) |
| | `bumpChunkVersion` | 变更 `meta.chunkVersions` = 服务端写操作 |
| | `fullMask` | spawn 时算全字段掩码;**客户端只读掩码** |
| | `validateFieldTable` | 字段表自检(服务端 CI) |
| | `fieldBytes` / `entityPayloadBytes` | **带宽估算**(文档 §5/§6),不参与编解码 |

**合计 shared 6 / server 13 = 19** ✓ 覆盖 C4 全部。

### 10.5 ★★ 我的关键论点:为什么不能只按「谁引用它」定归属

```
阶段 2 找到的两处「同名不同物」——`telegraphShape` 与 `stateFlag` ——
它们的符号(`TelegraphShape` / `StateFlagIndex`)在 C4 里,而 C4 是「两边都不用」那批。
```
**⇒ 当前无人引用 ≠ 客户端不需要。** 恰恰相反:
`StateFlagIndex`/`STATE_FLAG_NAMES`/`FsmIndex`/`FSM_NAMES` 现在**只有 tests 引用**(或完全没人引用),
是因为**客户端还没解码**;一旦接线,它们**必须**被客户端用。
**若按「当前引用者」判定,这 4 个会被留在 `server/` ⇒ 客户端接线时只能自己抄一份 ⇒ 制造真 CR-20。**

⇒ **所以我给 C4 加了第二条判据:不是「谁在用」,而是「谁**将要**必须用」。**
这条判据也解释了我为什么建议它们进 shared 而不是 server。

### 10.6 ✅ 冻结层扫描:我扩面复核,结论与 Lead 一致

Lead 扫的是 `tests/` + `scripts/` 里 `shared` 与 `readdirSync`/`.length ===` 的组合。我**扩面**重扫:

```
扫描面:tests + scripts 共 **40** 个 .ts
「shared + 计数/枚举」同时出现:**10 处**,逐个看过 ——
  8 处是 `import { ITEM_LIST/ITEM_BY_ID/... } from '../shared/...'`(读内容,不是数文件)
  1 处 tests/WS-10.test.ts:661 是局部变量名 `shared1`(巧合,与本议题无关)
  1 处 tests/WS-FND-01.test.ts:1280 是**全仓 .ts 遍历**
★ 决定性:该遍历的产物 `T43_FILES` 只被用作**过滤基**(`:1308 return T43_FILES.filter(...)`),
  **没有任何 `.length === N` 断言**
```
**⇒ 未发现「shared 文件数 = N」这类硬断言。Lead 的预期成立,我独立确认。**

**另查了两处更深的**:
- `checkFrozen()`(`scripts/verify.ts:206`)按**具名路径** `import` 7 个 shared 模块并断言内容
  (320 项、ID 唯一、分表 10/320……),**不扫描目录** ⇒ 新增 shared 文件不影响它。
- 「冻结层不变量 17/17」那个门禁(`verify.ts:3935`)比的是**实测通过条数**,不是文件数 ⇒ 同样不受影响。

**⚠️ 一处后果我要提前说明**:切分后新增 `shared/**` 文件,会被 `PROD_ENTRIES` 闭包
(`verify.ts:630`)重新计算可达性。**我没有实测「切分后门禁是否仍全绿」**(那需要真的动 shared)。
⇒ **建议切分落地后立刻跑一次 `--strict-reach`**,确认新文件在闭包内、没有变成「未登记不可达」。

### 10.7 我没做的

- **未修改 `shared/**`、`server/**`、`client/**` 任何一行**(本轮纯只读复核)。
- **未改 CR-24**、未动 `docs/CHANGE_REQUESTS.md`(Lead 写域)。
- 临时探针 `_sp_*.ts` 全在仓库根,**已删除**;未写入 `scripts/`。

---

## 11. ✅ 切分已落地(CR-24 授权后执行)—— 含实测复核

> §10 是**只读复核**;本节是**执行后的实测结果**。CR-24 裁决:(b) 按实测消费者切分 +
> `export * from` 单向转发。**Lead 追加的机器判据「引用相等」已写成断言。**

### 11.1 落点

```
新建 `shared/types/wire.ts`             341 行 / 14,317 B  ⇒ 21 运行时导出 + 6 纯类型
  SHA-256 45C8B550449013124D005B1282FE32A31FB41F75DBE2343C6B9632DBCEBAC73E
改写 `server/src/net/schema.ts`         201 行 /  7,387 B(原 442 行 / 16,448 B)
  SHA-256 F9819CE5A537A2F660ABB99BDCCE1455FA6350B8496D95E5C717A8B55A8E8BE7
  · 唯一转发 `export * from '../../../shared/types/wire.ts'`
  · **不重新定义任何符号**(这条由断言守住,不靠注释)
```
**⇒ 21 + 16 = 37 = 上移前的运行时导出数 ⇒ 对外面零变化,没有任何 import 点需要改。**

### 11.2 ★★ 关键判据:引用相等(把「同物两名」与「两份实现」用机器分开)

**位置:`tests/WS-07.test.ts` 末尾,新增 1 条 `test(...)`(58 行)。**

```
运行时可比 **21 / 21 Object.is 相等** ✓ ⇒ **只有一份实现**
纯类型 6 个比不了引用(无运行时绑定)⇒ 由 tsc 保证同一性
反向:16 个 server 符号**零泄漏**进 wire.ts ✓
```
**为什么必须是引用相等而不是值相等**:
```
· `export * from` = **编译期转发** ⇒ 同一个对象 ⇒ 结构上不可能漂移
· 「两份同步的拷贝」⇒ **值相等但引用不等 ⇒ 也失败** ✓
⇒ ★ 只靠注释守不住:有人补一个 `export const X = ...` 覆盖同名,注释不会变红。
```
**故障注入(带生效自检)**:在 `schema.ts` 里重新定义一份 `FIELD_TABLE`
```
SHA  前 F9819CE5…  →  后 C654AA8C…   ⇒ **生效自检:内容确实变了** ✓
断言**精确变红**:「FIELD_TABLE 在 schema 与 shared 是同一引用」
连带 5 条既有断言也红(B01/B06/H03/H13/H17,字段数 14→1)⇒ 注入确实刺穿真实现
还原 ⇒ SHA **逐字节**回到 F9819CE5… ✓
```

### 11.3 孤儿审计对比(锚)

| | 基线 | 切分后 |
| :--- | --: | --: |
| 可达 | 70 | **70** ✓ |
| 不可达 | 14 | **14** ✓(新增 **0**) |
| 生产文件 | 84 | 84 |

**⇒ `wire.ts` 在 `PROD_ENTRIES` 闭包内,未变成「未登记不可达」。§10.6 那条预告已实测确认。**

### 11.4 ★ 切分暴露的一个真缺陷(已修)

```
tests/WS-11.test.ts 原判据:readFileSync('schema.ts') + /key: 'scoreA'/
⇒ 它**声称**的本体是「**协议**有 scoreA 字段」,
   判据却是「**schema.ts 这个文件**的文本有这一行」
⇒ 上移后事实**仍成立**(tableFor(ROOM) 实测 = chunkVersions, partyMode, partyTimer,
   **scoreA**, scoreB),但文件文本里没有了 ⇒ **假红**
⇒ ★ 与陷阱 27/66 同族:**判据的视野 ≠ 它声称的本体**
```
**修法:换成行为判据** `tableFor(EntityKind.ROOM).some(f => f.key === 'scoreA')` ——
不依赖声明位置,而且**比文本匹配更强**。WS-11 回到 85/85。

### 11.5 勘误:「谁 import `schema.ts`」的精确名单(按 `path.resolve` 判,不按字符串)

> ⚠️ 我此前两次口述这个名单,一次说 5 个、一次说 `room.colyseus.ts` 不 import ——
> **两个名字相近的文件必须分开说**:`schema.ts`(线上格式,现 201 行)与
> `schema.colyseus.ts`(44 个装饰器,Colyseus 版)。**用「schema」简称必然混淆。**

**按 `path.resolve` 解析绝对路径统计**(不理字符写法 ⇒ 同目录 `./schema.ts` 也能命中):

| 谁 | import 的是 | 说明 |
| :--- | :--- | :--- |
| `server/src/net/delta.ts` | **`schema.ts`** | 编码器 |
| `server/src/net/room.ts` | **`schema.ts`** | 房间 |
| `server/src/net/schema.colyseus.ts` | **`schema.ts`** | Colyseus 装配层(用字段表生成 `@type`) |
| `tests/WS-07.test.ts` | **`schema.ts`** | 两处(原 import + CR-24 引用相等断言) |
| `tests/WS-FND-04.test.ts` | **`schema.ts`** | — |
| `tests/WS-FND-05.test.ts` | **`schema.ts`** | — |
| `tests/WS-11.test.ts` | **`schema.ts`** | ★ CR-24 后我新增(行为判据要用 `tableFor`) |
| `scripts/extension-drill.ts` | **`schema.ts`** | — |
| `scripts/perf-bounds.ts` | **`schema.ts`** | — |
| `server/src/net/room.colyseus.ts` | **`schema.colyseus.ts`** | ★ **不是** `schema.ts` |
| `server/src/index.ts` | — | **两者都不 import** |

**⇒ 切分前 8 个、切分后 9 个(我加了 WS-11)。**
**⇒ 复核方法**:`for each import 声明 → path.resolve(dirname(file), spec) → 与目标的绝对路径比对`。
**不能字符串比对** —— 同目录写法是 `./schema.ts`(不含 `net/`),
而跨目录写法含 `net/`;只认一种就会漏掉同目录那一半。

### 11.6 ⚠️ 仍未解决的一处:客户端 `TelegraphShape` 与 wire.ts 冲突

```
client/src/ui/boss_hud.ts:26  {CIRCLE:0, ANNULUS:1, CONE:2, LINE:3, CROSS:4}
shared/types/wire.ts          {NONE:0, CIRCLE:1, SECTOR:2, RECT:3, RING:4}
⇒ **5 个下标全部冲突** —— 切分**不解决**它,要等阶段 3 让 boss_hud 改从 shared 取
```
（`client/src/net/prediction.ts:13` 提到 `POS_SCALE` 但**只是注释**,不是第二份定义。）

**另**:`client/src/ui/boss_hud.ts` 的 `TelegraphSpec`(12 字段)比协议能给的几何**更宽** ——
`facing`/`spreadRad`/`innerRadius`/`length`/`width` 都不在 `BOSS_FIELD_TABLE` 里(§3.3)。
⇒ 接线时 ANNULUS 的 `innerRadius` 只能由客户端自定,**这是玩法参数,不是同步字段**。

---

## 12. ★★★ 一条系统性风险:「按路径读 .ts 文本」是**不进依赖图**的依赖

> 起因:我数 `delta.ts` 的改动面时数成「1 文件 + 3 import 点」,真值是 5 处。
> **根因不是粗心,是我的判据把「依赖」默认成了「import 语句」。**

### 12.1 反例:`WS-FND-03` 依赖 delta.ts,但**没有** import 它

```
tests/WS-FND-03.test.ts:249  readFileSync(join(ROOT,'server','src','net','delta.ts'),'utf8')
tests/WS-FND-03.test.ts:300  readFileSync(join(ROOT,'server','src','net','delta.ts'),'utf8')
该文件的 import 目标实测:["node:fs","node:path","node:url","../server/src/content/handshake.ts",
  "../server/src/content/registry.ts","../shared/constants/items.ts"] ⇒ **不含 delta**
⇒ 它**是**依赖(文件不在就崩),却**完全不在 import 判据的视野里**
```

### 12.2 三条后果(比「假红」严重)

```
1 **不进依赖图** ⇒ 可达性门禁 / 孤儿审计**结构上看不到它**(它们跟的是 import 边)
2 文件一移动 ⇒ readFileSync **抛 ENOENT** ⇒ 套件**进程崩**
3 ★ 崩溃的形式最差:exit≠0 且**没有任何断言输出**
   ⇒ WS-11 的 scoreA:文件在、内容不在 ⇒ **可见的红**
   ⇒ 路径读:文件**根本不在**     ⇒ **不可见的崩**
   ⇒ 修 scoreA 时我以为处理完了同族问题 —— **其实只处理了轻的那一半**
```

### 12.3 全仓实测(判据覆盖每一种读取方式)

**判据**:`readFileSync` / `readFile` / `existsSync` / `createReadStream` 里出现指向 `.ts` 的路径;
**排除注释行**(否则会把说明文字算成依赖)。

```
tests/WS-07.test.ts 32 · WS-FND-01 12 · **scripts/verify.ts 9(门禁自己)**
WS-11 7 · WS-04 6 · WS-FND-03 4 · WS-FND-09-wiring 4 · WS-FND-08 3
gate-selfcheck 3 · orphan-audit 2 · live-path-audit 1 · WS-10 1 · WS-FND-07 1
⇒ 合计 **85 处 / 13 个文件**;按目标目录:server/ 50 · client/ 5 · 其他 30
```

### 12.4 建议(治本)

```
对每一处 readFileSync 的 .ts 路径,**在读取前先断言它存在**:
  ok(existsSync(path), '目标存在')
⇒ 「文件被移走」会在**原地立刻变红**(可读),而不是等下一个人**崩**(不可读)
⇒ 成本:每处 1 行;可先只加在 tests/
```

### 12.5 阶段 3 的直接影响

```
上移 delta.ts 前必须改两类(**判据不同,不能只改一类**):
  import 形态   4 个文件(room.ts · WS-07 · WS-FND-05 · perf-bounds)⇒ 改 from
  ★ 路径读形态  **WS-FND-03 两处** ⇒ 改 readFileSync 里的路径,**否则崩**
⇒ 并且建议把该路径收敛到**一个常量**,下次再移只改一行
⇒ ⚠️ 任何 server/** 上移都要过这 50 处 server/ 的路径读 ⇒ **这不是 delta.ts 独有的问题**
```
