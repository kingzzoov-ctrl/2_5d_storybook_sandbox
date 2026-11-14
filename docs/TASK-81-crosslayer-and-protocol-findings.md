# task-81 报告:`wiring_view.ts` 客户端接线可行性

> 判定结论:**接不上。** 且任务卡的前提「服务端已实现、只缺客户端调用点」**不成立** ——
> 缺的不是调用点,是**一整条下行通道 + 一个 UI 宿主**,而通道那半属于协议设计。
>
> 作者 build-wiring · 2026-11-14 · 全部数据可复跑(文末命令)

---

## 我能证明的

### 1 ★ 客户端**不能** import `server/**` —— 有一条硬守卫,且我实测它真的会拦

```
判据位置:verify.ts:774 checkCrossLayerImports()(CR-24 §5,Lead 2026-11-13 补)
判据正文(verify.ts:762-763):
    「client/src/** 里的相对说明符(以 . 开头)解析成绝对路径后,不得落在 server/** 之下」
其失败输出措辞(verify.ts:848-849):
    「跨层 import N 处:client/src 不得依赖 server/**(应把线上格式放 shared/ —— CR-24)」
```

**★ 我不是读注释得出的,是注入后实测的**:在 `client/src/` 下放一个真越层文件,跑门禁:

| 状态 | 门禁 exit | 跨层那一行 |
| :--- | ---: | :--- |
| 改动前基线 | 0 | ✓ 跨层 import 无(相对说明符 69 条:静态 69 / 裸 0 / 动态 0;指向 shared/ 21 条,**指向 server/ 0 条**) |
| **注入越层文件后** | **1** | ✗ 跨层 import 1 处:client/src 不得依赖 server/** |
| 按全名删除后 | 0 | ✓ 回到「指向 server/ 0 条」 |

且门禁输出**指到了具体那条**(提到 `wiring_view`),不是泛泛报红。
⇒ **「有这条判据」与「这条判据能拦住」是两件事** —— 我验的是后者。

**还原证明**:原有 27 个 `client/src/**/*.ts` 的 SHA-256 **逐个比对,27/27 字节未变**,多出文件数 0,
`client/src` 文件数 28 → 27 回到基线。

### 2 客户端**没有** tile 下行通道 —— 协议里根本不存在这份数据

```
shared/types/wire.ts(369 行)里:
    'tiles' 0 次   'Tile' 0 次   'grid' 0 次   'wireView' 0 次   'WIRE_VIEW' 0 次
RoomState 的**全部**字段(实测):
    export interface RoomState { roomId: string; meta: RoomMetaState;
                                 players: PlayerState[]; wildlife: WildlifeState[];
                                 bosses: BossState[]; }
⇒ 只有 房间/玩家/野怪/Boss 四类实体 —— **没有地形,没有图块,没有布线**

⚠️ 'chunk' 在 wire.ts 出现 7/8 次,但逐条看**全是 `chunkVersions`**(房间级版本号表,
   用来做 diff,不是图块内容)⇒ 不是 tile 通路。
⚠️ 'wire' 出现 3 次,逐条看全是「**线上格式(wire format)**」的意思
   (L222/L245/L251 讲 telegraphShape 的线上取值),与「电路暗线」**同形异义**。
```

`client/src/net/session.ts`(349 行)里 `tile`/`chunk`/`grid` **各 0 次**,只有 `payload` 15 次、`delta` 3 次
⇒ 客户端网络层收的是实体状态增量,**拿不到图块**。

### 3 客户端**有**一份 tile 网格,但它是 demo 世界,且里面 **0 条暗线**

```
boot.ts:509-522 把 4×4 chunk 拼成连续网格 ⇒ { tiles: Uint32Array, W }
   ★ 它**含** wire 位(wire 打包在 32-bit 单元里,tile.ts:64 的 ((f.wire & 0xf) << WIRE_SHIFT))
   ★ 但数据源是 makeDemoWorld(),而 demo_world.ts:63 的 packTile 实参是 `wire: 0`
   ⇒ 这份网格的 wire 位**全 0** ⇒ buildWireView 会产出**全空的视图**(0 条线)
⇒ 就算硬接上,渲染出来也是**空白**,无法验证"接线真的通了"
```

### 4 `buildWireView` 本身**可用**,依赖也干净 —— 问题不在它

```
server/src/build/wiring_view.ts  271 行 / 13 处 export
  导出: buildWireView / wireCellAt / canLayWire / danglingEnds / serializeWireView
        WIRE_NAME / WIRE_LABEL / ALL_WIRE_COLORS / WireCellInfo / WireLayer / WireView / LayWireResult
  只 import 三处:
        ../../../shared/types/tile.ts   ← 共享层(客户端可达)
        ./grid.ts                       ← server/src(客户端**不可**达)
        ./autotile.ts                   ← server/src(客户端**不可**达)
```
入参形状 `TileGridLike`(grid.ts:180 需 `width`/`height`/`get`/`set`/`setObj`/`inBounds`)
—— 客户端那份 `{tiles, W}` **不满足**(没有 `get()`,也没有 `height`),
但写个适配器是 trivial 的 ⇒ **这一层不是障碍**。

### 5 客户端**没有**任何布线语义的消费点(分母 27)

```
client/src .ts = 27(分母 >0 ✓)
含 wire/wiring/电路/布线/铺线/WIRE/dangling 的 = 5 个文件,**逐条判语义后真消费点 = 0**
    client/src/net/state_store.ts       L47/50/55/61  ← 指的是**协议文件名** `wire.ts`
    client/src/net/telegraph_center.ts  L11/23        ← 同上
    client/src/stage/demo_world.ts      L63           ← `wire: 0`(那个被置 0 的位)
    client/src/three/boot.ts            L541 `wire: u.wire`(抄位) / L1184 `wiring: {`(★ 见下)
    client/src/ui/inventory.ts          L165 `AUTOMATION: '电路物流'`(物品分类名)
★ L1184 的 `wiring` 是「接线生效自检」报告的**字段名**:
    上下文 L1179-1182 写着「8 个模块的『浏览器里真的生效了』的证据 …
    只证明 import 成功是不够的 —— 这些字段每个都取自**模块的实际输出**」
  ⇒ 与「电路暗线」**毫无关系**,纯关键词误命中。
客户端 UI 面板清单(state_machine.ts 的 12 个大写面板名):
    INVENTORY / RECIPE_TREE / PIXEL_EASEL / BLUEPRINT / BOSS_HUD / PITCH_EDITOR …
  ⇒ **没有**铺线/电路面板('/wiring|铺线|电路/' = false)
'207'(四色电路扳手)在客户端 27 个文件里 = **0 处**
```

★★ **这里有个值得记的细节**:`docs/WS-08-wiring.md` §11.3 断言
「客户端含这些词的 .ts = **0 个**(逐个 grep)」,而我裸 grep 得到 **5 个**。
**两边结论相同(真消费点 = 0),但计数不同** —— 差别在于 §11 显然做了语义过滤而没写明。
⇒ 与我在 task-77 抓到的「引用 ≠ 执行」是**同一族**:
　　**裸 grep 会过计数;要得到"真消费点"必须逐条判语义。**
　　两个数都对,口径不同 —— 但如果有人拿 §11 的「0 个」当"grep 结果"去复验,他会得到 5 而以为 §11 错了。

### 6 唯一的真 importer 是 `tests/WS-03.test.ts` —— **不是** `tests/WS-08.test.ts`

```
任务卡说:「读 tests/WS-08.test.ts 里已有断言怎么用它」  ⇒ ★ 该主张有误
实测:
    tests/WS-08.test.ts(1685 行)含 'wiring_view' = **false**,含 'WireView' = false
      它测的是 wiring/graph.ts + wiring/components.ts + wiring/logistics.ts(**信号推进**那半)
    tests/WS-03.test.ts(1381 行)才是 wiring_view 的家:
      L65-73  import { buildWireView, danglingEnds, serializeWireView, canLayWire,
                        LayWireResult, wireCellAt, WIRE_LABEL } from '../server/src/build/wiring_view.ts'
      L930/940/954/1001  buildWireView(makeWireScene())   ← 4 次调用
      L989  eq(danglingEnds(view), 8, '红 3 + 蓝 3 + 绿 2 = 8 个线头')
      L1002 serializeWireView(view)
⇒ 全仓真 import wiring_view 的文件 = **1 个**(tests/WS-03),其中生产侧 = **0**
```

★ **注意 WS-03 / WS-08 的分工错位**:任务卡把它归给 WS-08,而 `docs/WS-08-wiring.md` 是
**接线评估文档** —— 真正的**实现**在 WS-03 的测试里。这不是我的推测,是上面两行的实测。
⇒ 连带影响:白名单理由写「WS-08 电路可视视图」,**套件号指错了**(应指 WS-03)。

**★ 它工作正常(测试绿)**:
```
node tests/WS-03.test.ts  →  [WS-03] 89/89 通过   (连跑 3 次,3/3 同结果)
node tests/WS-08.test.ts  →  [WS-08] 73/73 通过   (连跑 3 次,3/3 同结果)
```

---

## 我不能证明的

```
1 **"服务端接它是不是真的没意义"我只有论证,没有实测。**
  我能证明的是:客户端被守卫禁止、协议无字段、客户端无消费者。
  我**不能**证明「服务端挂 tick 一定错」—— 那是 docs §11.2 的论证(纯函数算出来没人看,
  每帧丢弃 = 假可达),我复核了它的**前提**(它确实是纯函数:13 处 export 里没有 tick*/状态)
  但**没有**去构造反例。⇒ 「服务端也不该接」是**引用了 §11 的结论**,不是我的实测。

2 **把文件上移到 shared/ 是否可行,我没评估。**
  那是唯一可能的两全路径(既让客户端可达、又不动协议),但它要:
    改 wiring_view.ts 的 import 路径 + 改 client 侧的接线 + 改 verify.ts 的分母口径
  ⇒ 其中两样**不在我的写域**,而且会动白名单/可达数字。
  ⇒ 我只报告这条路存在,**没有验证它是否被别的不变量挡住**。

3 **`__zzz_nope__` 控制串自检报了 2,不是 0。**
  我定位到污染源是**我自己的历史探针**(仓库根下 40 个 `_t*` 文件里,7 个含该控制串)。
  排除探针后真实代码 = 0 ⇒ 结论仍成立。
  但我**没能**让那个自检在"含探针"的环境下报 0 —— 这是我的探针卫生问题,如实记下。

4 **跨层守卫的残余缺口我只测了正则行为,没测端到端。**
  实测它的正则 `(?:\bfrom\s*|(?<![\w.])import\s*\(?\s*)['"](\.[^'"]+)['"]`:
     相对+from / 相对+裸副作用 / 相对+动态  → 三种**都被捕获** ✓
     裸说明符(无点) / 拼接变量 / 别名       → 三种**都不被捕获** ✗
  但我说"别名当前不可用"的依据是"tsconfig.json 无 paths 段、package.json 无 imports"
  —— 我**没有**验证 `node --experimental-*` 或运行时的其它解析路径。
  ⚠️ 且我**刻意没有**用这些缺口去达成"接线" —— 那是绕过守卫,不是接线。

5 **我没有跑全量门禁 --strict 三件套。**
  我跑的是不带 strict 的 `node scripts/verify.ts`(用来验跨层守卫的活/死),以及单套件各 3 次。
  理由:队友正在并发改 `client/src/net/**` 与 `tests/WS-13.test.ts`,
  全量红我无法归因到我自己(本轮 Lead 已提醒过一次同类误判)。
  ⇒ 报告里"不得因我变红"这条,**我用的替代证据是「我 0 行改动 + 单套件 3 次可复现」**。
```

---

## `wiring_view` 的可用性:导出什么、测试怎么用它、客户端能否拿到依赖

| 问题 | 实测答案 |
| :--- | :--- |
| 导出什么 | 13 处:5 个函数(`buildWireView`/`wireCellAt`/`canLayWire`/`danglingEnds`/`serializeWireView`)+ 3 张表 + 5 个类型/接口 |
| 它工作吗 | ✓ `tests/WS-03.test.ts` 89/89 通过(3 次可复现);它自己的断言覆盖连通分量、线头数、RLE 序列化 |
| 依赖什么 | 仅 3 处:`shared/types/tile.ts`(共享层 ✓)、`./grid.ts` ✗、`./autotile.ts` ✗ |
| 客户端拿得到依赖吗 | **✗ 拿不到** —— 后两个在 `server/src/`,而客户端被硬守卫禁止 import `server/**` |
| 客户端有等价数据吗 | **✗** 协议无 tile 字段;唯一那份网格是 demo 世界且 wire 位全 0 |
| 客户端有消费点吗 | **✗** 27 个文件里真消费点 0,UI 面板无铺线项,'207' 0 处 |

**定性**:**服务端侧属「根本不该接」,客户端侧属「宿主不存在」** —— 两半定性相反,必须分开说。
（这与 `docs/WS-08-wiring.md` §11.5 的定性**独立地一致**。）

---

## 接线点:选在哪、为什么是那里

**★ 没有接线点。** 四条候选路径逐一实测排除:

```
① client/src/net/*      ✗ 协议里没有这份数据(wire.ts 无 tiles/Tile/grid/wireView)
② client/src/three/*    ✗ 同上无数据源;且 import 本体被跨层守卫拦
③ client/src/stage/*    ✗ 同上;demo 世界 wire 位全 0 ⇒ 接了也是空视图
④ client/src/ui/*       ✗ 无铺线面板(state_machine 12 个面板名里没有)
```

**能通达的唯一路径只剩两条,都不在我的写域**:
```
(a) 服务端自己 import 它 → 需在 server/src/** 加调用点(不是我的写域),
    且据 §11.2 是「每帧丢弃的假可达」⇒ 我判断**不该做**
(b) 把 wiring_view.ts 上移到 shared/ → 跨层问题消失,客户端可达
    但要改 import 路径 + 新增客户端接线 + 改 verify.ts 分母 ⇒ 两样不在我写域
```
★ **我没有为了交差造一个调用点。** 理由就是 Lead 给的那条:
一个假接线会让它从白名单消失,而门禁**此后再也不看它** —— 比一条欠账更糟。

---

## 能红的证据(改前红 / 改后绿,还原 SHA-256 一致)

我**没有**做"接线"改动(判定接不上),所以没有"接线断言"的红绿对。
但我做了**守卫本身的红绿对**,因为"判定接不上"的**全部依据**就是这条守卫能拦:

```
① 改动前                  门禁 exit=0  跨层行 = ✓ 指向 server/ 0 条        【绿】
② 注入 client/src/__t81_crosslayer_probe__.ts
   (真越层 import '../../server/src/build/wiring_view.ts')
                          门禁 exit=1  跨层行 = ✗ 跨层 import 1 处        【红】
                          门禁输出提到 wiring_view: true(指到具体那条)
③ 按**全名**删除该文件     门禁 exit=0  跨层行 = ✓ 指向 server/ 0 条        【绿】
④ 还原证明:SHA-256 逐个比对原有 27 个 client/src/*.ts → 27/27 字节未变
             多出文件数 = 0 · client/src 文件数 28 → 27
```
⇒ ★ **② ⇒ ③ 的绿是"红由注入引起"的证明**,不是"门禁碰巧绿"。
⇒ 这与我在 task-73 学到的"**没有基线的负向验证,会以 100% 的通过率告诉你一个它根本没测过的东西**"是同一套做法:先跑基线。

**临时越层文件已按全名删除**(不是通配):
```
已删:client/src/__t81_crosslayer_probe__.ts     实测 existsSync = false ✓
```

---

## 改动清单(逐文件逐位置)

```
【生产代码改动】**无**
【测试改动】    **无**
【我的写域】    client/src/** = 0 行改动 · tests/WS-08.test.ts = 0 行改动
                git status -- client tests → 无输出(实测)
```
⇒ **本次交付 = 一份"接不上"的判定报告 + 守卫红绿证据。**
⇒ 我**没有**为了凑出"改动清单"而在写域里塞东西 —— 判定为接不上时,0 行改动就是正确交付。

---

## 请 Lead 改的数字

### ★★ 结论:**数字不该变。白名单 14 不动,欠账 8 不动,可达 84 不动。**

任务卡预测的「白名单 14 → 13,不可达 14 → 13,可达 84 → 85」**不应发生** ——
因为它假设"接上很容易,只缺一个调用点",而这个假设被实测否掉了。

```
若有人为了消掉这条欠账而:
  · 把同一份逻辑抄进 client/          → ★ 欠账数字**一动不动**(实证见下)
  · 用裸说明符/别名绕过守卫引 server/  → ★ 那是绕过守卫,不是接线 ⇒ 应**打回**
  · 把文件上移到 shared/              → 会**真的**改变数字,但必须同步重算:
        白名单 14→13 · 欠账 8→7 · 可达 84→85 **以及** shared/ 的分母(98 那条口径)
     ⇒ 这一步牵连 verify.ts 多处,应由你统一做,不是我在写域里局部改
```

★ **"抄一份到客户端不会消掉欠账"是实证的,不是推理**:
```
可达性是按「**生产 import 闭包**」算的。
实测全仓 import wiring_view 的文件 = 1(tests/WS-03),生产侧 = 0。
抄一份到 client 只是**复制逻辑**,不会有任何生产文件 import 原文件
⇒ 原文件仍在闭包外 ⇒ 欠账数字不变。
⇒ ★ 而且它还会**制造两份实现两份口径**(本仓 CR-20 已点过名的形态)。
```

### 建议:只改**理由措辞**,不改数字

现白名单原文(实测 `verify.ts:1387`):
```
['server/src/build/wiring_view.ts', 'WS-08 电路可视视图,待客户端接线'],
```
**两处不准确**:
1 「待客户端接线」把两件相反的事压成了一件 —— 服务端侧是「**根本不该接**」,不是「等接」
2 「WS-08」—— 真正的实现测试在 `tests/WS-03.test.ts`(`WS-08` 测的是 `wiring/graph` 那半)

建议改成(体例对齐本表其它条目,写清**是谁的活**):
```
['server/src/build/wiring_view.ts',
 '四色电路暗线视图(**实现测试在 WS-03,非 WS-08**)。两半定性相反,必须分开:'
 + '服务端侧**根本不该接**(纯视图计算,非世界状态;挂 tick = 每帧丢弃的假可达);'
 + '客户端侧**宿主不存在**,缺两样:① WireView 下发报文(协议设计,归 shared/types/wire.ts + net 层)'
 + '② 铺线 UI 面板(客户端功能,归 UI 层)。'
 + '⚠️ 客户端**无法**直接 import 本文件 —— verify.ts:774 跨层守卫禁止 client→server。'],
```

---

## 我留下的临时文件(逐名 —— 未删,等你批)

```
_t81_probe.ts    _t81_out.txt     外部列举:客户端/服务端目录清点 + 谁 import 谁
_t81b.ts         _t81b_out.txt    根因:RoomState 字段全貌 + delta 实体种类 + demo wire 位
_t81c.ts         _t81c_out.txt    ★ 跨层守卫红绿对 + SHA-256 还原证明(含注入与还原)
_t81d.ts         _t81d_out.txt    独立复核 docs §11 的 a/b/c/d/f 五条主张
_t81e.ts         _t81e_out.txt    守卫覆盖边界 + WS-03 真测试 + 「抄一份无效」的实证
_t81f.ts         _t81f_out.txt    自检污染源定位 + 正则覆盖矩阵 + 更正理由要用的数字
```
共 **12 个**(6 组 .ts + 6 组 .txt),全在仓库根,不在 `scripts/`、不在 `tests/`、不在 `client/`。
⇒ 按硬纪律**我没有自删**。
⇒ ⚠️ 顺带:**仓库根下有 40 个 `_t*` 探针(不止我的)** —— 那是全队历史残留,处置由你定。

**另外 1 个我按全名删除的**(它是注入实验的一部分,已验收):
```
client/src/__t81_crosslayer_probe__.ts   ← 按设计注入后立即按全名删除,已实测不存在
```

---

## 未做项 + 理由

```
1 **没有接线。** 判定为接不上(守卫禁止 + 无协议字段 + 无消费点 + demo 数据全 0)。
  ★ 没有为了交差硬造调用点 —— 假接线会让它从白名单消失,门禁此后不再看它。

2 **没有改 tests/WS-08.test.ts。** 它测的是 wiring/graph 那半,与 wiring_view 无调用关系。
  往里面塞一条 wiring_view 的断言需要 client 侧 import ⇒ 恰好触发跨层守卫。
  且"断言能红"要有真接线才有意义 ⇒ 不接线的断言是**空转断言**,反而是新的恒真项。

3 **没有碰 shared/types/wire.ts**(加下发字段)。按你的指示:协议改动跨端一致,超出本任务。
  ⇒ 我把它作为「缺什么」的第 ① 项报告。

4 **没有碰 scripts/verify.ts**(白名单/数字)。按你的指示:数字由你改。
  ⇒ 我只报"数字不该变"+ 理由措辞的更正提案。

5 **没有动 wiring_view.ts 的语义。** 我复核了它(纯函数、依赖干净、测试绿),
  认为它**没有问题** —— 有问题的是一条从未被设计出来的下发通道。

6 **没有跑全量 --strict 三件套。** 队友在并发改 client/src/net/** 与 tests/WS-13.test.ts,
  全量红我无法归因。替代证据:我 0 行改动 + 单套件连跑 3 次可复现。
```

---

## 附:与 `docs/WS-08-wiring.md` §11 的关系(重要)

`docs/WS-08-wiring.md` §11(task-72,2026-11-13)**已经做过这份分析**,结论与我一致。
⇒ 我**先独立测完才读到它**;两者是**独立复算**,不是转述。逐条比对:

| §11 的主张 | §11 说 | 我实测 | 一致? |
| :--- | :--- | :--- | :--- |
| 客户端布词语义消费点 | 0 个 | 真消费点 0 个(裸 grep 5 个,逐条判后 0) | ✓ 结论同,计数口径不同 |
| '207' 在客户端 | 0 处 | 0 处 | ✓ |
| 服务端 import wiring_view | 0 个 | 0 个(全仓唯一 importer 是 tests/WS-03) | ✓ |
| wireView/WIRE_VIEW/wire_view 全仓 | 0/0/0 | 0/0/0(排除我自己探针后) | ✓ |
| 客户端有渲染管线 | ✓ | ✓(stage/three) | ✓ |
| 服务端有下发报文 | ✗ | ✗(RoomState 四类实体,无 tile) | ✓ |
| 客户端有铺线 UI | ✗ | ✗(12 个面板名无布线) | ✓ |
| 定性 | B(客户端宿主不存在;服务端根本不该接) | 同 | ✓ |

★ **§11 未覆盖、由我补的三点**:
```
① §11 说"客户端 0 个",但**裸 grep 是 5 个** —— 它没写它做了语义过滤。
   我把 5 处逐条列出并判为误命中(协议文件名 `wire.ts` / 自检字段 `wiring:` / 分类名「电路物流」/ 那个置 0 的位)。
   ⇒ 这条最有价值:下一个复核者若拿 §11 的"0"去 grep 复验,会得到 5 而以为 §11 错了。
② §11 没有提**跨层守卫**(verify.ts:774)—— 那是 2026-11-13 同一天补的,可能晚于 §11。
   ⇒ 这是**硬约束**,比"没人写报文"更强:它让 (a) 路径在门禁层面不成立。
   我给了注入实测(exit 0→1→0 + SHA-256 还原)。
③ §11 把这条归给 WS-08;实测**实现测试在 WS-03**,WS-08 测的是 graph/components/logistics。
   ⇒ 白名单理由里的「WS-08」指错了套件号。
```

★ **最重要的一条**:§11.6 已经写了「改写理由 ≠ 消掉欠账 —— 可达性数字不变」。
⇒ 任务卡让我做的是**接线**,而 §11 早在一天前就论证了**接不上**。
⇒ 若这条信息在派活时就被引用,这个任务本可以不必开 —— 但它**没有被引用**,
　　所以我按你的纪律**如实报了"接不上"**,而不是照着任务卡的假设去凑一个调用点。

---

## 复跑命令

```
node _t81c.ts      # 跨层守卫红绿对 + SHA-256 还原(最硬的一条证据)
node _t81e.ts      # 守卫覆盖边界 + WS-03 真测试 + 「抄一份无效」实证
node _t81f.ts      # 更正理由要用的每个数字
node tests/WS-03.test.ts && node tests/WS-08.test.ts    # 89/89 · 73/73(各 3 次可复现)
node scripts/verify.ts                                  # 跨层行应为「指向 server/ 0 条」
```
