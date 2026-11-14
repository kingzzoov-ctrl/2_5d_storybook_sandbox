# TASK-95 · 生产入口「不可加载」:三重阻塞的实测成因与两条修法(2026-11-14)

> 对应 ARCH-GAPS「第三层 · 入口可跑性」。本文只做**实测 + 代价清单**,不改代码。
> 所有报错都是**原文照抄**;所有计数都是本次实测。

> ⚠️ **行号口径**:本文的 `verify.ts:NNNN` 是 2026-11-14 **接手者编辑该文件之后**实测的
> (同轮给它加了 1 行 import 与一个 `checkCountAudit()` ⇒ 其后的行号整体偏移);
> 对不上时请按文中给出的**符号名**Grep,不要据行号判断"这里没有"。

---

## 一、结论先说

```
1 「不可加载」不是 1 个阻塞,是 **3 个**,而且它们**互相掩盖** ——
   最外层暴发的是「装饰器语法」,里面还压着「CJS 命名导入」与「真值恒 null」。
2 `Client` 在 colyseus 0.15.57 的根入口里 **根本不存在**(require 拿到 47 个键,Client=undefined)
   ⇒ 它只能是 `import type`(运行时擦除)。这不是命名导入的写法问题,是**该符号没有运行时值**。
3 即使三重都修好,**这 4 条 handler 也不会被注册** ——
   `registerHandlers()` 全仓 **0 调用点**(见 TASK-94 §2.3)。
   ⇒ ★ **只修"可加载"不会让玩家按得动**。
```

---

## 二、三重阻塞:逐层实测

### 2.1 第一重 · 装饰器(语法层)—— **最外层**,它掩盖后面两重

```
$ node -e "import('./server/src/net/room.colyseus.ts').then(()=>console.log('LOADED')).catch(e=>console.log('ERR:', e && e.message))"
ERR: Invalid or unexpected token
```

`e.stack` 原文(只测 `schema.colyseus.ts`,结果与测 `room.colyseus.ts` **逐字相同**):

```
SyntaxError: Invalid or unexpected token
    at compileSourceTextModule (node:internal/modules/esm/utils:318:16)
    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:111:18)
    at ModuleLoader.<anonymous> (node:internal/modules/esm/translators:664:10)
    at #translate (node:internal/modules/esm/loader:473:20)
    at afterLoad (node:internal/modules/esm/loader:529:29)
```

**隔离实验**(在系统临时目录里放一个最小样例,`{"type":"module"}`,内容
`function deco(...a:unknown[]):void {} class A { @deco x = 1; } export const a=new A();`):

```
RAWMSG:Invalid or unexpected token
STACK:
SyntaxError: Invalid or unexpected token
    at compileSourceTextModule (node:internal/modules/esm/utils:318:16)
    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:111:18)
```

⇒ 栈与仓库里**完全同形** ⇒ 成因 = **装饰器语法**,不是别的。

**两条旁证**(排除"是类型剥离被拒"):
```
node --check server/src/net/schema.colyseus.ts        ⇒ EXIT=0(不报错)
stripTypeScriptTypes(code, { mode: 'strip' })          ⇒ 对该文件返回 OK
```
⇒ 报错不来自「剥类型拒绝」,而来自 **JS 编译阶段**(`@` 没被擦除)。
⇒ 与 `verify.ts:1239-1244` 已实测的记录一致:装饰器报 `name=SyntaxError`,`code=(无)`。

### 2.2 第二重 · CJS 命名导入 —— **被第一重掩盖**,在 `room.colyseus.ts` 这一层从不显形

```
$ node --input-type=module -e "import { Room, Client } from 'colyseus'; ..."
SyntaxError: Named export 'Client' not found. The requested module 'colyseus' is a CommonJS module,
which may not support all module.exports as named exports.
CommonJS modules can always be imported via the default export, for example using:
import pkg from 'colyseus';
const { Room, Client } = pkg;
    at #asyncInstantiate (node:internal/modules/esm/module_job:302:21)
```

⚠️ `import { Room } from 'colyseus'`(单独)**同样失败**:`SyntaxError: Named export 'Room' not found…`

**但真正的坏消息在这里**:

```
import c from 'colyseus'          ⇒ ✓(拿得到)
require('colyseus')               ⇒ 47 个键;Room = function;Client = undefined
@colyseus/core/build/index.d.ts:12 ⇒ export { type Client, ... }   ← 只是**类型**
```

⇒ **`Client` 没有运行时值** ⇒ 改 default 解构**也拿不到它**。
⇒ 唯一正确写法是 `import type { Client } from 'colyseus'`(类型导入,运行时擦除)。
⇒ 判据:**这条不是"写法问题",是"该符号不存在"** —— 靠改 import 语法**修不好**。

### 2.3 第三重 · 模块解析 —— **只有 `better-sqlite3` 真缺**

```
$ node -e "import('X')…"   (X 逐个测)
[colyseus]           RESOLVED-OK
[@colyseus/schema]   RESOLVED-OK
[three]              RESOLVED-OK
[better-sqlite3]     RESOLVE-FAIL — Cannot find package 'better-sqlite3' imported from …[eval]
```

**`node_modules` 实况**(逐个 `Test-Path`):

```
colyseus            = True   (0.15.57)
@colyseus/schema    = True   (2.0.37)
three               = True
better-sqlite3      = False
@colyseus/{auth,core,greeting-banner,redis-driver,redis-presence,ws-transport} = True
typescript 5.9.3 / vite 在;顶层条目 136
esbuild / tsx / ts-node / sucrase / @swc / amaro = **全部 False**
```

⇒ ★ **解析不是当前阻塞成因**(前两重更早暴发)。`better-sqlite3` 是**独立的**第四点:
  `driver.sqlite.ts:45` 是 `import type`,运行时擦除(见 `driver.sqlite.ts:41-42`)⇒ 也不阻塞加载。

### 2.4 谁掩盖谁(必须写清,否则会去修错地方)

```
room.colyseus.ts 自身:可剥类型 ✓ / 装饰器 **0 处** ✓
  (tests/WS-07.test.ts:4072 断言 ownDecos === 0)
它一被加载,解析期就去加载 ./schema.colyseus.ts ⇒ 立刻抛 SyntaxError
⇒ ∴「CJS 命名导入」这个错误在 room.colyseus.ts 这一层**永远不会显形**。
```

`tests/WS-FND-12-wiring-paths.test.ts:170-181` **正是把「B 路当前不可加载」钉成了断言**
⇒ 修好它,这条断言会**按设计变红**(那是"接线即红",不是回归)。

---

## 三、装饰器本体:44 处 / 4 种形态 / 依赖 4 个导出

**实测计数**(行首 `@type(` 口径):**44**;子串 `@type(` 为 45;另有 4 行注释提到它(L10 / L49 / L182 / L261)。

```
tests/WS-07.test.ts:4079
  eq(depDecos, 44, '...44 处**生效**装饰器(行首口径;含注释为 45)')   ← 与实测一致
```

**4 种形态**:

| 形态 | 数量 | 示例 |
|---|---|---|
| `@type('<prim>')` | **39** | `schema.colyseus.ts:48 @type('string') name = '';` |
| `@type({ map: X })` | **3** | `:205 @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();`(另 `:206` `:207`) |
| `@type(['string'])` | **1** | `:209 @type(['string']) dirtyChunkKeys = new ArraySchema<string>();` |
| `@type(RoomMetaSchema)` | **1** | `:204 @type(RoomMetaSchema) meta = new RoomMetaSchema();` |

合计 39 + 3 + 1 + 1 = **44** ✓

39 处的原始类型分布:`'string'`×11 · `'number'`×10 · `'uint16'`×8 · `'uint8'`×7 · `'uint32'`×3。

**依赖的唯一来源**:`schema.colyseus.ts:13`

```ts
import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';
```

用到 4 个导出:`type`(装饰器本身)、`Schema`(4 个类的基类:`:47`/`:112`/`:144`/`:181`/`:202`)、
`MapSchema`(`:205-207`)、`ArraySchema`(`:209`)。
实测这 4 个都是 `typeof function`,且该包有 `exports.import → build/esm/index.mjs`(**真 ESM**,不是 CJS)。

⚠️ `assertSchemaReady`(`:285`)与 `validateFieldTable`(`:274`)来自**零依赖**的 `./schema.ts`,**不依赖三方**。

---

## 四、两条修法的实测代价

### 方案甲「构建步骤」

**可复用的既有配置**(逐条给位置):

```
package.json:34          "typecheck": "node scripts/typecheck.ts"
package.json:35-37       只有 dev:client / build:client / preview:client —— **无服务端 build**
tsconfig.json:4-5        module / moduleResolution = NodeNext
tsconfig.json:12         "experimentalDecorators": true
tsconfig.json:13         "emitDecoratorMetadata": false
tsconfig.json:14         "allowImportingTsExtensions": true
tsconfig.json:15         "noEmit": true
tsconfig.json:16         "erasableSyntaxOnly": true
vite.config.ts:8-12      「服务端**不**走 Vite…不提供通用 build」
vite.config.ts:84-85     build.outDir = '../dist/client'(root:'client':80,只服务客户端)
```

**实测撞到的两条硬约束**(都挡路):

```
① tsc server/src/net/schema.colyseus.ts --experimentalDecorators --target ES2022 \
     --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --outDir <tmp>
   ⇒ error TS5096: Option 'allowImportingTsExtensions' can only be used when either
     'noEmit' or 'emitDeclarationOnly' is set.
   加上 --rewriteRelativeImportExtensions 后**可以 emit**(仍有 TS2416/TS2345 类型错,
   但产出 .js,内含 __decorate 辅助函数)。

② module 沿用 NodeNext 时,room.colyseus.ts 的产物**仍是**
     import { Room } from 'colyseus';
   (tsc 已把 type-only 的 Client 消掉)⇒ **运行时照样**报 Named export 'Room' not found。
   module 改 CommonJS 时产物是 const colyseus_1 = require("colyseus");(可用),
   但相对导入会保留 `.ts` 后缀(require("./schema.colyseus.ts")),
   而 package.json:5 "type": "module" 下 .js 会被当 ESM。
```

**新增项清单**:

| 项 | 数量 | 说明 |
|---|---|---|
| devDependency | **0**(纯 tsc 路线) | typescript 已在;bundler 路线**必须新装**(esbuild/tsx/sucrase/@swc 实测都不存在) |
| npm script | **≥1** | 当前**无**服务端构建 script |
| 新产物目录 | **≥1** | 若命名 `dist/` 或 `build/`:会被 `scripts/scan-scope.ts` 的 `SKIP_DIRS` **整棵跳过** ⇒ 产物不被任何门禁审计(**但也不可见**)。当前 `dist/client/*` 已存在(vite 产物),`build` **不存在**;`.gitignore` 含 `dist/` |

### 方案乙「零依赖替身」

**要解决两件事**(缺一不可):

```
1 装饰器:44 处 / 4 种形态**全部**要换写法。
  实测 @colyseus/schema 2.0.37 同时导出 `defineTypes` 与 `SchemaDefinition`(都是 typeof function)
  ⇒ 官方**有无装饰器替代**。
  若做完全替身,需提供:Schema 基类、MapSchema(get/set/delete/keys/values)、ArraySchema、
  以及一个 `type()` 注册器 / 空实现。
2 CJS 命名导入:见 §2.2 —— `Client` 只能变 `import type`(它没有运行时值)。
```

**最小替身形状(替换点仅 3 处 import)**:

```
room.colyseus.ts:19   { Room, Client }                 ← Client 改 type-only;Room 改 default 解构
room.colyseus.ts:20   { RoomSchema, BossSchema, PlayerSchema, WildlifeSchema, assertSchemaReady }
schema.colyseus.ts:13 { Schema, MapSchema, ArraySchema, type }
```

**`NetPersistRoom` 实际用到的面**(据此判断替身够不够):

```
Room   (room.colyseus.ts): setState :145-146 · maxClients :182 · setPatchRate :209
                           setSimulationInterval :187 · roomId :280 · onMessage :335
                           broadcast :249 · state :335
Client (:220 / :225 / :229): sessionId · leave · send
assertSchemaReady :285-290 = **本地实现**(不依赖三方)
```

**替身后 4 条 handler 能否被 `tests/WS-FND-13/14.test.ts` 直接覆盖:不能。**
两个套件的 import 只有 `assemble`(index.ts)、`startWsServer` / `PROTOCOL_VERSION`、
`RoomRuntime`、`fixedClock`、`decodePacket`(WS-FND-13:47-51;WS-FND-14:46-53)
—— **都没有 import `room.colyseus.ts`**。
更强的证据:4 条 handler 在 `private registerHandlers()`(`room.colyseus.ts:279`),
而全仓 grep `registerHandlers` **只有声明那一行、调用点 0 处**。

---

## 五、共同前置:它是 `PROD_ENTRIES` 之一

```
scripts/verify.ts:1141   const PROD_ENTRIES = [
scripts/verify.ts:1190     'server/src/net/room.colyseus.ts', // Colyseus 房间被 server 装配层实例化
```

数组范围 `1141-1209`,共 **5 项**:`sim/ws_demo.ts`(:1172) · `index.ts`(:1188) ·
`sim/demo.ts`(:1189) · `net/room.colyseus.ts`(:1190) · `client/src/main.ts`(:1208)。

它同时在 `ENTRY_LOAD_EXEMPT`(`scripts/entry_load_exempt.ts:65-77`)被豁免;
两者由 `verify.ts:1288-1306` 交叉校验(豁免条目若不在 `PROD_ENTRIES` 里 ⇒ 报「应删除该豁免」)。

---

## 六、本文**不能证明**的

```
1 没有跑 `npm run verify` 全量门禁(会写 dist/,按只读约束未跑)。
   ⇒「新产物目录是否会让门禁变红」只有**代码级**证据(`scripts/scan-scope.ts:111-209` ——
     `BUILD_OUTPUT_DIRS` / `NON_REPO_DIRS` / `shouldSkipDirAtDepth()` / `walkRepo()`、verify.ts 的
     临时残留节),没有一次端到端实测。
2 方案甲的产物**能被 Node 正常加载**这一点,只验证到「能 emit 出 .js」,
  未验证「emit 出来的那一份能 import」(因为第 ② 条硬约束会先拦住它)。
3 「colyseus 0.15.57 根入口不导出 Client」是**本机实测**;升级 colyseus 版本会改变这个前提。
4 我没有改动任何代码。
```