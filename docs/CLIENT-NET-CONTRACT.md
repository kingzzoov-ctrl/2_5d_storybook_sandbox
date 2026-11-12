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

### 3.1 玩家 `FIELD_TABLE`(14 字段 · `server/src/net/schema.ts:85`)

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

### 3.2 野生动物 `WILDLIFE_FIELD_TABLE`(9 字段 · `:103`)

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

### 3.3 Boss `BOSS_FIELD_TABLE`(10 字段 · `:116`)—— ★ 阶段 3 画预警圈要用

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

### 3.4 房间 `ROOM_FIELD_TABLE`(5 字段 · `:136`)

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
