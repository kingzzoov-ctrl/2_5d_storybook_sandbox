# §五「未实测」三项的落地实测(COMPLETION-CRITERIA · S5)

本文回答 `COMPLETION-CRITERIA.md` §五「未实测」清单里的**前三项**,
每一项都给:**确切命令 + 原始输出 + 结论**,并且**不改任何运行时**(只新增
`scripts/fps-probe.ts` / `tests/WS-FND-24-contract-align.test.ts` / 本文件)。

测量环境(所有数字都出自这台机器,脱离环境无意义):

```
Node v24.13.0 · Windows(win32-x64)· Chrome 157.0.8103.51
vite 8.3.8(devDependency,已装)· typescript 5.9.3
CPU = AMD64 Family 26 Model 68(GPU = NVIDIA GeForce RTX 5080,见下)
```

结论速览:

| # | 项 | 结论 |
|---|---|---|
| 1 | 真机 FPS | **未实测**(本机没有真机/手机)。给了 headless Chrome 的**可复现数字**,并标明它**不是**真机 FPS |
| 2 | `colyseus.js` × vite 8 / es2022 | **未实测**(依赖未安装 ⇒ 构建在**解析阶段**就失败)。量了什么、没量什么见 §2 |
| 3 | `RoomSchema` ↔ `prediction.ts` 的 `Snapshot` 逐字段 | **实测**:逐字段表见 §3,非显然结论由 `tests/WS-FND-24-contract-align.test.ts`(7/7)钉住 |

---

## 一、真机 FPS:**未实测**,以及 headless 数字(明确不是真机)

### 1.1 为什么「真机 FPS」做不到

```
✗ 没有真机/手机可跑 ⇒ 无人能产出「玩家手机上多少帧」这个数
✗ headless Chrome 没有 vsync/刷新率上限 ⇒ 它的 fps 不是「屏幕刷新率」,是吞吐上限
✗ 本机 GPU 是 RTX 5080 独显,与手机 GPU 不是同一个数量级 ⇒ 即使有数字也不能外推
⇒ 结论:真机 FPS **未实测**。本节给的是「**开发机上 headless 渲染回路**」的数,不是玩家体验的数。
```

### 1.2 命令

```bash
node scripts/fps-probe.ts                 # Chrome 自选 GL(本机 = 硬件 ANGLE/D3D11)
node scripts/fps-probe.ts --gl=swiftshader # 强制软件渲染(与「headless swiftshader 截图」同一种 GL)
```

脚本做的事(零新依赖):起 `node_modules/vite/bin/vite.js`(dev server,root=`client/`)→
起 headless Chrome(CDP,内建 `WebSocket`)→ 先用 `about:blank` 测**同一窗口长度的 rAF 上限**(对照)
→ 导航到 `http://127.0.0.1:5199/?server=off` → 用 CDP 把 `atlas_sprites.png` 就地补上
(dev root 是 `client/`,图集在仓库根 `assets/` ⇒ dev 下必然 404;不补上会量一个**缺立牌**的场景)
→ 桌面视口与手机视口各量 4 秒 → 打印数字。
为什么不用 `chrome --headless --screenshot`:它**只做一次加载+截图**,没有时间轴;
而 `--virtual-time-budget` 会快进虚拟时钟,`performance.now()` 与真实渲染脱钩 ⇒ 那是编数字,不是测量。

### 1.3 原始输出(run A:默认 GL)

```
══ headless FPS 探针(★ 这不是真机 FPS)══
  Chrome      C:\Program Files\Google\Chrome\Application\chrome.exe
  URL         http://127.0.0.1:5199/?server=off
  WebGL 渲染器 ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)
  被测修订     boot.ts=b71fb3c9f66e main.ts=8c2359ddfc93 index.html=6af7ea687a63
  场景        {"cells":64,"chunks":16,"verts":21880,"faces":5470,"drawCalls":22,"triangles":11272,
              "buildMs":6.6,"atlasOk":true,"spriteCount":4,"viewport":[1264,625]}
  图集拦截    1 次
  [对照] about:blank   2160 帧 / 4000.4ms = 539.9 fps · 主线程 0.042 ms/帧
  [桌面] [1264,625]   2161 帧 / 4001.3ms = 540.1 fps · 主线程 0.187 ms/帧 · 脚本 0.09 ms/帧 · 应用自报 fps=540
  [手机] [390,844](DPR3) 2161 帧 / 4000.5ms = 540.2 fps · 主线程 0.188 ms/帧 · 脚本 0.089 ms/帧 · 应用自报 fps=540
  ⚠️ 应用 fps(540) ≈ 空页 rAF 上限(539.9) ⇒ 这个数字是**浏览器调度上限**,不是渲染成本
```

### 1.4 原始输出(run B:`--gl=swiftshader`)

```
  WebGL 渲染器 ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
  被测修订     boot.ts=b71fb3c9f66e main.ts=8c2359ddfc93 index.html=6af7ea687a63
  场景        {"cells":64,"chunks":16,"verts":21880,"faces":5470,"drawCalls":22,"triangles":11272,
              "buildMs":6.9,"atlasOk":true,"spriteCount":4,"viewport":[1264,625]}
  [对照] about:blank   2065 帧 / 4001.1ms = 516.1 fps · 主线程 0.043 ms/帧
  [桌面] [1264,625]    482 帧 / 4002.4ms = 120.4 fps · 主线程 0.384 ms/帧 · 脚本 0.198 ms/帧 · 应用自报 fps=121
  [手机] [390,844](DPR3) 727 帧 / 4003.2ms = 181.6 fps · 主线程 0.335 ms/帧 · 脚本 0.164 ms/帧 · 应用自报 fps=186
  ✓ 应用 fps(121) < 空页上限(516.1) ⇒ 该 GL 模式下受渲染成本限制(每帧主线程 0.384 ms)。
```

**重复性(同一修订 `boot.ts=b71fb3c9f66e` 上各重跑一次)**:

```
run A 重跑:对照 540.3 · 桌面 540.1 fps(主线程 0.174 ms/帧)· 手机 540.2 ⇒ 抖动 < 0.4%
run B 重跑:对照 515.7 · 桌面 115.8 fps(主线程 0.597 ms/帧)· 手机 173.7
⇒ 硬件模式稳定在 rAF 上限;**软件模式的 fps 与每帧成本抖动很大**
  (桌面 120.4→115.8 fps、0.384→0.597 ms/帧;手机 181.6→173.7)
⇒ 软件渲染的绝对值只能当**量级**用,不可当基准数字引用。
```

### 1.5 这些数字**能**与**不能**说明什么

```
能:  在这台机器上、这两种 GL 后端下,渲染回路的吞吐上限(headless 无 vsync)
     每帧主线程成本(Chrome Performance 域的 TaskDuration 差 / 帧数)
     「每帧 0.19 ms(硬件)」⇒ 渲染**不是**本项目的瓶颈;瓶颈在别处
不能:玩家手机上的帧率。也不代表 60fps 稳(手机 fill-rate / 内存带宽差一个数量级)
```

两个**独立读数**互相印证:应用自报 fps(540)与本脚本注入的 rAF 自计数(540.1)一致
⇒ 「读数的通路」本身没坏。运行 B 同样一致(121 / 120.4)。

**反直觉的实测,原样记录**:软件渲染下**手机视口反而更快**(181.6 vs 120.4 fps)。
与「像素更多 ⇒ 更慢」的直觉相反。两个可能的原因(未逐一验证,标注为**假设**):
`boot.ts:165` 是 `setPixelRatio(Math.min(devicePixelRatio, 2))` ⇒ 390×844@DPR3 的绘制缓冲是
780×1688 = 1.32 M 像素,而桌面视口是 1264×625 = 0.79 M 像素 —— **手机视口像素反而更多**;
  而几何侧:两个视口的 `drawCalls` 实测都是 22 ⇒ 不是「手机视口 drawing 更少」。这两条互相对冲,
  所以**起因未确定**;要定位得单独量「fill 受限 vs 顶点/几何受限」,本轮没做。
⇒ 这条**没有追因**,只作为「fps 数字受视口形状影响、不能单点外推」的实证留下。

### 1.6 一条被**实测逼出来**的判据(否则会写进一个假数字)

第一次跑 `--gl=swiftshader`(探索阶段,中间版本探针)时拿到 **515 fps** —— 与空页上限一致。
同一份输出里 `drawCalls: 0`、`fps: 0`,页面 `#fatal` 是:

```
ReferenceError: keys is not defined
    at tick (http://127.0.0.1:5199/src/three/boot.ts?t=1794717161261:1181:3)
```

那一时刻本仓正被**并行修改**(`git status` 显示 `M client/src/three/boot.ts` 与新增
  `client/src/net/camera_follow.ts` 与 `tests/WS-FND-23-camera-follow.test.ts` 同批的未跟踪文件),
⇒ 所以 `scripts/fps-probe.ts` 加了**有效性判据**(页 `#fatal` 非空 / `drawCalls===0` /
应用自报 fps=0 / CDP 收到 `Runtime.exceptionThrown` ⇒ **拒绝给出数字,exit 1**)。
`boot.ts` 的 sha 前缀也打进输出,让读者知道量的是哪个修订。

---

## 二、`colyseus.js` 与 vite 8 / es2022 的打包兼容性:**未实测**(依赖未安装)

### 2.1 命令与原始输出

```console
$ node -e "const p=require('./package.json'); console.log(JSON.stringify(p.optionalDependencies,null,2))"
{
  "@colyseus/schema": "^2.0.34",
  "better-sqlite3": "^11.3.0",
  "colyseus": "^0.15.17",
  "three": "^0.169.0"
}
⇒ **没有 `colyseus.js`**(那是客户端 SDK,与服务端 `colyseus` 不是同一个包)

$ Test-Path node_modules/colyseus.js
False
$ Get-ChildItem node_modules -Name | Select-String colyseus
@colyseus
colyseus

$ npm ls colyseus.js
cozy-island-sandbox@0.1.0 C:\...\2_5d_sandbox
`-- (empty)

$ node -e "import('colyseus.js').then(()=>console.log('LOADED')).catch(e=>console.log('FAIL', e.code, e.message.split('\n')[0]))"
FAIL ERR_MODULE_NOT_FOUND Cannot find package 'colyseus.js' imported from ...\[eval]
```

### 2.2 「一个 import 了它的客户端包能不能构建」——用真 vite 8 实测(不装依赖)

在**仓库外的临时目录**里造两个最小客户端包(各含 `index.html` + `main.js`,
并放一个指向本仓 `node_modules` 的 junction,让裸包名解析走真实依赖),
用**本仓的 vite 8.3.8 + `build.target='es2022'`** 各构建一次:

```
[对照] main.js: import * as THREE from 'three'      → ✓ built in 68ms(exit 0)  ← 构建链本身是通的
[实测] main.js: import { Client } from 'colyseus.js' → exit 1:
       ✗ Build failed in 25ms
       error during build:
       Build failed with 1 error:
       Error: [vite]: Rolldown failed to resolve import "colyseus.js" from ".../probe-fail/main.js".
       This is most likely unintended because it can break your application at runtime.
       If you do want to externalize this module explicitly add it to
       `build.rolldownOptions.external`
```

对照用**同一个**构建链、同一份配置:装了的包(`three`)能过,没装的包在**解析阶段**就死。

### 2.3 量了什么 / 没量什么

```
已量:
  · 依赖状态:package.json 的 optionalDependencies 里没有 colyseus.js;node_modules 里没有;npm ls 为空
  · 模块解析:import('colyseus.js') ⇒ ERR_MODULE_NOT_FOUND(原文见上)
  · 构建行为:真 vite 8.3.8 + target es2022 下,import 它的入口**在解析阶段即失败**(原文见上)
  · 对照:同一构建链对已安装的 three 构建成功 ⇒ 失败不是环境/配置坏了
  · 客户端现状:client/** 里 `colyseus.js` 出现 **0** 次(不含注释);
    `colyseus` 只出现 4 次,全在 `client/src/net/session.ts:4/10/44/233` 的注释里 ——
    客户端**故意**用内建 WebSocket 手写协议(该文件开头就写着「为什么不用 colyseus」)
未量(本次不许装依赖 ⇒ 无法量):
  · colyseus.js 的**真实** ESM/CJS 形态、`exports` 映射、Node engine 要求
  · es2022 target 下它是否需要降级语法、rollup/rolldown 的 CJS interop 行为
  · 它的 peer 依赖 @colyseus/schema 与已装的 2.0.37 是否冲突、bundle 体积 / tree-shaking
⇒ 结论:这一项**仍未实测**。已测的只是「缺席导致构建起不来」这一半;
  「vite 8/es2022 **兼容**它」这一半**没有任何证据**,不得当作结论使用。
```

---

## 三、`RoomSchema` ↔ 客户端 `Snapshot` 的**逐字段**对齐(实测)

### 3.1 三列的口径

```
第 1 列  shared/types/wire.ts:106-163 的四张字段表(FieldSpec{key,bit,type,bytes,note})
         —— 「线上格式」的唯一事实源(客户端与服务端都必须用它解释字节)
第 2 列  服务端装配层 server/src/net/schema.colyseus.ts 的 RoomSchema / PlayerSchema /
         WildlifeSchema / BossSchema / RoomMetaSchema(Colyseus 自动同步用的类)
第 3 列  客户端:解码路径 client/src/net/state_store.ts:143/153 → shared/net/delta.ts 的
         decodePacket/applyPacket;插值缓冲 client/src/net/prediction.ts:177-183 的 Snapshot
```
第 2 列的一致性由**已有的** `tests/WS-07.test.ts:3301`(H13 逐类对账)与 `:3315`(H14 容器类 6 字段)
守着;本轮的 `tests/WS-FND-24-contract-align.test.ts` 守**第 3 列**(不重复实现第 2 列,
也不 `import` `@colyseus/schema` —— 它是 `optionalDependencies`,WS-07 早就有「不 import 装配层」
的明文约定,见 `schema.colyseus.ts:4-8`)。

### 3.2 玩家实体:14 字段(`FIELD_TABLE`)

| # | 字段 | bit | wire 类型 | bytes | 在 PlayerSchema? | 类型一致? | 在客户端 Snapshot? | 客户端解码覆盖? |
|---|---|---|---|---|---|---|---|---|
| 1 | `id` | 0 | str | 8 | ✓ | str→string | ✗ | ✓ |
| 2 | `name` | 1 | str | 9 | ✓ | str→string | ✗ | ✓ |
| 3 | `level` | 2 | u8 | 1 | ✓ | u8→uint8 | ✗ | ✓ |
| 4 | `hp` | 3 | u16 | 2 | ✓ | u16→uint16 | ✗ | ✓ |
| 5 | `maxHp` | 4 | u16 | 2 | ✓ | u16→uint16 | ✗ | ✓ |
| 6 | `x` | 5 | pos | 4 | ✓ | pos→number | **✓** | ✓ |
| 7 | `y` | 6 | pos | 4 | ✓ | pos→number | **✓** | ✓ |
| 8 | `z` | 7 | pos | 4 | ✓ | pos→number | **✓** | ✓ |
| 9 | `dir` | 8 | u8 | 1 | ✓ | u8→uint8 | ✗ | ✓ |
| 10 | `stateFlag` | 9 | u8 | 1 | ✓ | u8→uint8 | ✗ | ✓ |
| 11 | `weaponId` | 10 | u16 | 2 | ✓ | u16→uint16 | ✗ | ✓ |
| 12 | `aiWeaponRecipeHash` | 11 | hash | 13 | ✓ | hash→string | ✗ | ✓ |
| 13 | `heldItemId` | 12 | u16 | 2 | ✓ | u16→uint16 | ✗ | ✓ |
| 14 | `carryingEntityId` | 13 | str | 9 | ✓ | str→string | ✗ | ✓ |

「类型一致」列的口径是 `schema.colyseus.ts:43-51` 的 `COLYSEUS_TYPE` 映射表(wire 类型 → Colyseus
标注),**不是**逐字段比对两处文本;第 2 列的逐字段核对在 WS-07 H13/H08。

**Snapshot 覆盖度 = 3/14**。差集(11 个,非显然结论之一)在 `WS-FND-24` 的 FND24-5 里逐字钉住:

```
未被 Snapshot 覆盖:id / name / level / hp / maxHp / dir / stateFlag / weaponId /
                    aiWeaponRecipeHash / heldItemId / carryingEntityId
```

### 3.3 房间级:5 字段 `ROOM_FIELD_TABLE` + 一个**不在表里**的 `tick`

| 字段 | 在 ROOM_FIELD_TABLE? | wire 类型 | 在 RoomMetaSchema? | 在 RoomState.meta? | 在 Snapshot? |
|---|---|---|---|---|---|
| `chunkVersions` | ✓ | str(排序 `"cx,cy:v"` 串) | ✓ | ✓(在这里是对象) | ✗ |
| `partyMode` | ✓ | u8 | ✓ | ✓ | ✗ |
| `partyTimer` | ✓ | pos | ✓ | ✓ | ✗ |
| `scoreA` | ✓ | u16 | ✓ | ✓ | ✗ |
| `scoreB` | ✓ | u16 | ✓ | ✓ | ✗ |
| `tick` | **✗(故意)** | — | **✗(故意删)** | **✓** | **✓** |

`tick` 这一行就是**非对称**所在:`RoomState.meta.tick` 有、房间字段表与 `RoomMetaSchema` 都没有,
它由**报文头**承载,`applyPacket` 无条件覆盖(`shared/net/delta.ts:454`)。
理由写在两处(wire.ts:150-156、schema.colyseus.ts:246-255):每帧都变的字段进表会让每帧多出
一次房间级 upsert(≈28 字节)。这条不是缺陷,但**「RoomSchema 与 wire 的 RoomMetaState 不是一一对应」**
是必须知道的事实 —— FND24-6 用行为把它钉住(报文头 tick=987654 ⇒ 合入后 `meta.tick===987654`,
且房间级 upsert 的 `fields` 里**没有** `tick`)。

### 3.4 容器级:`RoomSchema`(6) vs `RoomState`(5)

| RoomSchema 成员 | 在 RoomState(wire 层)? | 有写入点? |
|---|---|---|
| `roomId` | ✓ `RoomState.roomId` | ✓ `syncFrom()` |
| `meta` | ✓ `RoomState.meta` | ✓ `syncFrom()` |
| `players` | ✓ `RoomState.players` | ✓ `syncFrom()`(MapSchema) |
| `wildlife` | ✓ `RoomState.wildlife` | ✓ `syncFrom()` |
| `bosses` | ✓ `RoomState.bosses` | ✓ `syncFrom()` |
| `dirtyChunkKeys` | **✗ 无对应字段** | **✗ 0 个写入点**(见下) |

### 3.5 发现的**真实不一致**(原样列出,**未在本轮修改运行时**)

  **①** `dirtyChunkKeys`:声明了、登记了、但从来不写(实测)

```
文件:server/src/net/schema.colyseus.ts
  :283  dirtyChunkKeys = new ArraySchema<string>();     ← 声明
  :319  dirtyChunkKeys: ['string'],                     ← defineTypes 登记
  全文件 "dirtyChunkKeys" 出现 2 次;`this.dirtyChunkKeys` 出现 **0** 次
  syncFrom(state) (:286-309)只写 roomId / meta.* / players / wildlife / bosses —— 不写它
  全仓其它出现处:tests/WS-07.test.ts:3319-3342(只断言「声明形态与标注」)
期望:装配层的每个字段都有生产者(syncFrom 至少写一次)或明确的「客户端未确认地块」写入方;
实际:0 个写入点 ⇒ 该字段**恒为空数组**,而它已被登记进 Colyseus 同步表。
```
判据:`tests/WS-FND-24-contract-align.test.ts` 的 FND24-7(逐字计数 +「ROOM_FIELD_TABLE 里没有它」)。
⇒ 它是**装配层独有**的字段:不进 delta 包,也不可能被客户端读到。

  **②** `tick`:状态里有、字段表里没有(有意为之,链路正确)

见 §3.3。契约面**没有**说谎:客户端解码路径确实从报文头取 tick,两条独立断言
(FND24-6 行为 + FND24-5 静态)都通过。记录在此是因为它使 `RoomSchema` 与
`RoomMetaState` **字段数不同(5 vs 6)**,按「逐字段对齐」读会误判成缺字段。

  **③** `Snapshot` 的生产者 = 0(生产端没有生产者)

```
$ Select-String -Path client/src/**/*.ts -Pattern "Interpolator|simulateInterpolation"
client/src/net/prediction.ts:10 / :197（定义与文档）/ :343 / :356（测试驱动函数内部）
client/src/net/predictor.ts:22 / :26 / :28   ← 三处**全是注释**
$ Select-String -Path tests/*.ts -Pattern "new Interpolator\("
tests/WS-07.test.ts:1240 / :1269 / :1313 / :1332   ← 4 处,全在测试里
⇒ 生产代码里**没有**任何地方把 wire 的 PlayerState 变成 Snapshot 推进插值缓冲。
```
这与 `COMPLETION-CRITERIA.md` §三 的判断一致(「prediction.ts 的卡点在**输入端**」)。
⇒ §3.2/§3.3 的「对齐」今天是**契约级**的对齐(字段表 ↔ 解码路径 ↔ Snapshot 的形状),
**不是**运行链路级对齐:插值缓冲目前只被 `tests/WS-07` 驱动。
本轮**没有**接线(接线要动渲染路径与输入产品裁决,超出本任务范围)。

### 3.6 判据:`tests/WS-FND-24-contract-align.test.ts`(7/7 通过)

```console
$ node tests/WS-FND-24-contract-align.test.ts
[WS-FND-24-contract-align] 7/7 通过
```

七条分别钉住:FND24-1 字段表 14 项的 key/bit/类型逐项;FND24-2 `bytes` 与 `FIELD_TYPE_BYTES`
自洽(变长类型**不得**有定长字节数);FND24-3 **真编码 → 真解码 → 真合入**覆盖四张表的每一个字段
(Boss 用 hp=38000/telegraphEndTick=123456 —— 若有人把 u32 改窄立刻红);FND24-4 **负对照**
(表外字段必须被丢弃,证明解码是「按表」而非「整对象复制」);FND24-5 Snapshot 覆盖 3/14 与
`tick` 不在字段表里;FND24-6 帧号走报文头;FND24-7 §3.5 ① 的逐字计数。

---

## 四、复跑(每条都在这台机器上跑过)

```bash
node tests/WS-FND-24-contract-align.test.ts                 # 7/7 通过(§3)
node scripts/fps-probe.ts                                   # headless 数字,硬件 GL(§1.3)
node scripts/fps-probe.ts --gl=swiftshader                  # headless 数字,软件 GL(§1.4)
node scripts/typecheck.ts | Select-String "fps-probe|WS-FND-24"   # 空 ⇒ 新文件没引入 TS 错误
```

未做/未变的:`server/**` `shared/**` `client/**` `README.md` `docs/HANDOVER.md`
`docs/COMPLETION-CRITERIA.md` `scripts/verify.ts` `package.json` **一个都没碰**;
没装任何依赖;没跑 `scripts/verify.ts`(门禁由 Lead 独占)。

相关文档:[COMPLETION-CRITERIA.md](COMPLETION-CRITERIA.md)(§五 的原始清单)、
[HANDOVER.md](HANDOVER.md)(基线数字的口径)。
