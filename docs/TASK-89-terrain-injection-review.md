# TASK-89 地形/物理套件注入复核报告

teammate:`terrain-physicist` · 范围:task-89 任务1(5 条同义反复判定与修复)+ 任务2(WS-01 / WS-02 系统性注入复核,U5 欠账)

---

## 我能证明的

1. **5 条里 4 条是同义反复,已修好,且修好后都有牙** —— `WS-03::BLUEPRINT_SIZE`、`WS-FND-01::CONTENT_FINGERPRINT_VERSION`、`WS-FND-02::HISTORY_CAPACITY`、`WS-FND-02::MAX_EVENTS_PER_FRAME`。每条都做了「注入常量 ⇒ 该断言红 ⇒ 还原 ⇒ SHA-256 逐字节一致」的完整闭环。**Lead 已把这 4 条白名单条目全部摘除,我实测复核通过。**
2. **第 5 条 `WS-06::ICON_SIZE` 我判定「保留」;Lead 进一步做了双重锚定并摘除** —— 我用隔离探针证明 L129/L130 比的是手写 16 字符美术字面量,改常量必然失配 ⇒ 有牙。Lead 随后把它也改成字面量 + 常量锚定(`WS-06.test.ts:593`/`:595`),比我建议的「改措辞」更彻底,**我采纳**。
3. **我额外抓到并修好 2 条原来不在清单里的缺陷:**
   - **`MAX_SUBSTEPS` 空断言**(`WS-02.test.ts:769`):`ok(substeps <= MAX_SUBSTEPS)` 两侧同源 ⇒ 任意常量值恒真。修前注入 4→5 **全绿**,修后 **变红**。
   - **`WS-01::CAP` 同义反复**(`WS-01.test.ts:853`):`eq(f.amountAt(0,0), CAP)` 而实现就是 `Math.min(..., CAP)`。**这条是门禁的「未登记候选」暴露的,不是我注入发现的** —— 因为我注入 CAP 时它确实红了(被 `:847` 的锚定挡住),掩盖了 `:853` 仍同义反复这个事实。
4. **注入复核跑了 50 组,覆盖 45 个数值常量**(WS-01 13/15 = 86.7%,WS-02 32/32 = 100%,合计 45/47 = 95.7%),每组都有生效自检(运行期读回被改的值),全部逐字节还原(10 个生产文件 SHA-256 与改前完全一致)。
5. **阴性对照通过** —— 我故意做了一次「值不变的注入」(i21),套件保持 50/50 全绿、exit=0,证明我的驱动器不是「凡跑必红」。
6. **结构性审计:50 个 WS-01 test() + 43 个 WS-02 test() 里,零断言块 0 个、仅恒真 `ok` 块 0 个、try 内被吞断言 0 条。**(分母已断言 > 0)
7. **`MAX_SUBSTEPS` 那类形态在全仓还有 57 处 `ok(... 比较式含大写常量)`,是 `checkTautology` 的检测盲区**,已全量列出交 Lead 评估。
8. **★ 门禁 `verify.ts` 自身有一处崩溃级缺陷**,我已实测复现并定位到行号:

   ```
   L2404   const reachHint = '...'      ← 声明在 function checkReachability() 内(L2291),是局部 const
   L3345   function checkTautology() {   ← 另一个函数
   L3544      ... ${reachHint}          ← 引不到 ⇒ ReferenceError(--strict-taut 路径)
   L3556      console.warn(... ${reachHint})   ← 同上(默认路径)
   ```

   **触发条件**:`checkTautology` 走进「有未登记候选」分支(即 `unlisted.length > 0`)。
   **后果**:整个进程在 `[同义反复候选]` 节**抛 ReferenceError 终止**,后续节**一条都不执行**,但 `exit code` 仍是 1 ⇒ **表现为"门禁报红",实为"门禁没跑完"**。
   **为什么严重**:越是有未登记候选(最需要门禁报明细的场合)越必崩;而且「红」与「崩溃」在退出码上**不可区分**。
   两条路径我都实测崩过(`--all` 与 `--all --strict-taut`)。
   **修法**(仅 Lead 可改 `scripts/**`):把 `reachHint` 提到模块级,或在 `checkTautology` 内重新声明一份。

## 我不能证明的

1. **我不能证明 WS-01/WS-02 的断言「全部」有牙** —— 我只覆盖了正文真引用的 47 个数值常量里的 45 个(WS-01 有效池 15、WS-02 有效池 32),而且**断言级**只抽样,不是逐条断言穷举。WS-01 有 194 条数值断言、WS-02 有 121 条,我没有为每一条都构造一次破坏。
2. **我不能证明那 57 处 `ok(...CONST)` 都有问题** —— 只有当该常量同时是「实现里的钳制上界」时才恒真。我只**实测**了 `MAX_SUBSTEPS` 一处;其余 56 处是**待查清单**,不是结论。
3. **我不能证明「注入不变红 ⇒ 一定没牙」的逆命题** —— 我发现了一个反例:注入可能**语义上是 no-op**(i12 第一次把 `this.amount[i] = 0;` 插到 `fluid.ts:634` 已有的同一行旁边),这种「绿」不代表断言弱。所以我是靠**生效自检**逐个排除的,不是靠「没红」直接下结论。
4. **我不能替 Lead 动 `scripts/verify.ts`** —— 白名单 `TAUT_SUSPECT_EXEMPT` 的摘除由 Lead 执行;我改了测试文件后,门禁在 Lead 摘除前会报「白名单失真」。
5. **我不能证明手册里的每个数字都是对的** —— 我只负责核对「测试里的字面量有没有独立于实现的手册来源」,手册本身是否正确不在我的判定范围。

---

## 任务1:5 条逐条判定(仍是同义反复 / 已修好 / 刻意保留)+ 行号原文

### 1 `WS-03::BLUEPRINT_SIZE` —— **仍是同义反复,已修好**

命中行(改前):

```
tests/WS-03.test.ts:649   eq(bp.w, BLUEPRINT_SIZE, '宽 16');
tests/WS-03.test.ts:650   eq(bp.h, BLUEPRINT_SIZE, '高 16');
```

**为什么是真同义反复**(不是读源码猜的,是看两侧数据来源):`server/src/build/blueprint.ts:166-167`

```ts
export function captureBlueprint(grid, originX, originY,
  w: number = BLUEPRINT_SIZE, h: number = BLUEPRINT_SIZE) {
```

`bp.w` 的**唯一来源就是这个形参默认值**,而默认值就是那个常量 ⇒ 两侧同步移动 ⇒ 恒真。

改后(`tests/WS-03.test.ts:657`):

```ts
eq(bp.w, 16, '宽 16(手册 §2.3 / §5.3)');
eq(bp.h, 16, '高 16(手册 §2.3 / §5.3)');
eq(BLUEPRINT_SIZE, 16, 'BLUEPRINT_SIZE 本身 = 16(手册 §5.3 参数表)');   // :657 双向锚定
```

### 2 `WS-06::ICON_SIZE` —— **刻意保留,保留成立(应改措辞,不该改断言)**

命中行(`tests/WS-06.test.ts:129/130`,该文件我**没有改动**):

```
:129   eq(art.length, ICON_SIZE, `${name} 行数`);
:130   for (const row of art) eq(row.length, ICON_SIZE, `${name} 行宽`);
```

**核实「552/553 已改字面量;111/112 比 SILHOUETTE_ART 有牙齿」这句是否仍成立:成立。**

隔离探针实测(不靠「跑了变红就下结论」):

| 检查项 | 实测 | 结论 |
|:---|:---|:---|
| `SILHOUETTE_ART` 条目数 | 9(分母 > 0 已断言) | — |
| 行数与 16 失配 | 0 / 9 | — |
| 行宽与 16 失配 | 0 / 9 | — |
| `SILHOUETTE_ART` 声明后 60 行内是否引用 `ICON_SIZE` | **否**(是手写 `'0000000330000000'` 16 字符串字面量) | ⇒ L129/130 改常量**必然失配** ⇒ **有牙** |
| 注入 `ICON_SIZE` 16→8 | `[WS-06] 51/64`,13 红 | 确认有牙 |

⚠️ **一个必须记录的细节(过定)**:该 `test` 的 `:126` `ok(r.ok, ...)`(来自 `selfCheckArt()`)会**先 throw**,而 `selfCheckArt` 内部也用 `ICON_SIZE` 比行数/行宽 ⇒ 「A3 变红」的直接报错出自 `:126`(`[ROW_COUNT] 行数应为 8,实际 16`),**L129/130 根本执行不到**。所以「A3 红」这个现象**不能单独用来证明 L129/130 有牙** —— 我是靠隔离探针(绕开 `:126`)证明的。

**我的判断:该条应改措辞。** 白名单理由串现在写「已知:552/553 已改字面量;111/112 比 SILHOUETTE_ART 有牙齿,保留」,建议补一句说明「:126 会遮蔽,故 A3 变红不足以证明 111/112 有牙;真正证据是 SILHOUETTE_ART 为手写字面量」。

> 注:`alchemy-core` 在本轮稍后已把 `:148/:149` 也改成字面量 16(注释 @128-146 的推理与我的探针结论一致)。该改动**不是我做的**,`tests/WS-06.test.ts` 不在我写域。

### 3 `WS-FND-01::CONTENT_FINGERPRINT_VERSION` —— **仍是同义反复,已修好**

命中行(改前):`tests/WS-FND-01.test.ts:205` `eq(f.version, CONTENT_FINGERPRINT_VERSION);`

**两侧同源证据**:`server/src/content/registry.ts:276` `return { version: CONTENT_FINGERPRINT_VERSION, ... }` —— `f.version` 就是那个常量的直传。

改后(`:205`):`eq(f.version, 1, '算法版本 = 1(手册指纹串形如 v1-eaefa38b)');` + 保留 `:214` `eq(CONTENT_FINGERPRINT_VERSION, 1);`

### 4 `WS-FND-02::HISTORY_CAPACITY` —— **仍是同义反复,已修好**

命中行(改前):`tests/WS-FND-02.test.ts:338` `eq(h.length, HISTORY_CAPACITY, '保留满容量');`

**两侧同源证据**:`server/src/events/bus.ts:348/351` 的环形缓冲保留逻辑直接由该常量驱动。

改后:`const N = 512 + 50;` + `eq(h.length, 512, '保留满容量(手册 EVENT-BUS.md §1.3 写 512)');`,保留 `:83` `eq(HISTORY_CAPACITY, 512, '日志容量')`

### 5 `WS-FND-02::MAX_EVENTS_PER_FRAME` —— **仍是同义反复,已修好**

命中行(改前):`tests/WS-FND-02.test.ts:252` `eq(st.delivered, MAX_EVENTS_PER_FRAME, '投递 4096 个');`

**两侧同源证据**:`server/src/events/bus.ts:262` `if (processed >= MAX_EVENTS_PER_FRAME)` 就是投递上限。

改后:`const N = 4096 + 104;` + `eq(st.delivered, 4096, '投递 4096 个(手册 EVENT-BUS.md §1.2)');`,保留 `:81` `eq(MAX_EVENTS_PER_FRAME, 4096, '每帧事件上限')`

### 附:额外发现并修好的第 6 条 —— `WS-01::CAP`(由门禁的「未登记候选」暴露)

**发现渠道**:不是我主动找的,是我跑门禁非 strict 模式时,它把「新增未登记的同义反复候选」打印出来,里面出现了 **`WS-01 CAP`** —— 我自己的套件。

命中行(`tests/WS-01.test.ts:853`,改前):

```ts
eq(f.amountAt(0, 0), CAP, '钳制到 CAP');
```

**两侧同源证据**:`server/src/world/fluid.ts:29` `export const CAP = 1000;`,而 `addWater` 的钳制就是 `Math.min(..., CAP)` ⇒ 钳制点随常量移动 ⇒ 对任意 CAP 值恒真。

改后(`tests/WS-01.test.ts:853` 附近):

```ts
eq(f.amountAt(0, 0), 1000, '钳制到 CAP(= 1000 毫格)');
```

字面量 1000 的来源:手册「一格 = 1000 毫格」+ 同一 test 内既有的 `:847` `eq(CAP, 1000, '单位容量 1000 毫格')` 锚定。

**复测**:基线 `WS-01` 50/50 全绿;注入 `CAP` 1000→1200 ⇒ 49/50,**红 1**,exit 1;还原 SHA-256 逐字节一致。

> ⚠️ **这条的意义超出它自身**:它证明「注入复核」和「门禁候选集」是**两个不同的探测面**。我在任务2 里注入过 `CAP`(i22)并看到它变红,于是**以为它没问题** —— 但我注入的是**运行期数值**,门禁看的是**断言的期望值来源**。i22 变红是因为 `:847 eq(CAP, 1000)` 那条锚定,而 `:853` 那条同义反复当时仍在,只是被 `:847` 的 throw **遮蔽**了(over-determination)。**只看注入结果会漏掉它。**

### 附:额外发现并修好的第 7 条 —— `MAX_SUBSTEPS`(不在我原来的 5 条里)

命中行(`tests/WS-02.test.ts:769`,改前):

```ts
ok(pw.lastReport.substeps <= MAX_SUBSTEPS, `子步数被钳制在 ${MAX_SUBSTEPS}`);
```

**为什么是空断言**:实现侧 `server/src/physics/world.ts:329-333`

```ts
const substeps = clampInt(Math.ceil((vmax * dt) / 0.25), 1, MAX_SUBSTEPS);
```

`substeps` 的**上界就是 `MAX_SUBSTEPS` 本身**,断言又拿它当期望值 ⇒ 对任意常量值恒真。

**实测证据(不是推理)**:
- 生效自检:`MAX_SUBSTEPS` 运行期读回 4→5 ✓
- 注入后套件:`[WS-02] 43/43 通过`,exit 0 —— **仍绿**
- 排除「分支没被执行」:实测该场景 `substeps = 4`,**已钳到上界** ⇒ 断言被行使过,仍无牙 ⇒ 是**真·没牙**,不是「没走到」
- **门禁为什么看不见它**:`checkTautology` 只扫 `/eq|near\s*\(\s*[^,]+,\s*([A-Za-z_]\w*)\s*[,)]/`(`verify.ts:3352`),**只认 `eq`/`near` 的第二实参**;`ok(x <= CONST)` 形态不在扫描范围。且 `checkFrozen` 的 11 项字面量表**不含** `MAX_SUBSTEPS`。⇒ 该常量**当时无人守**。

已按 WS-10 `MAX_DODGE_RATE` 的既有修法修好(`tests/WS-02.test.ts:781-783`):

```ts
eq(pw.lastReport.substeps, 4, '1e6 速度下 substeps 被钳到上界 4(手册 §4.1 L156)');
eq(MAX_SUBSTEPS, 4, 'MAX_SUBSTEPS 本身 = 4(手册 §5 参数表 L356)');
ok(pw.lastReport.substeps <= MAX_SUBSTEPS, `子步数被钳制在 ${MAX_SUBSTEPS}`);
```

修后复测:基线 43/43 全绿;注入 4→5 ⇒ **42/43,1 红**(`✗ 1e6 速度下 substeps 被钳到上界 4 ... 期望 4 / 实际 5`),exit 1 ⇒ **从没牙变成有牙**。

---

## 任务1:每条字面量的来源(手册哪一节);手册没写的逐条列出

| 常量 | 字面量 | 独立来源(手册,非源码) | 来源强度 |
|:---|:---|:---|:---|
| `BLUEPRINT_SIZE` | 16 | `docs/WS-03-build.md` §2.3(L101 代码块)+ §5.3 参数表(L345「BLUEPRINT_SIZE \| 16 \| 边长(格)」) | **逐字明写** |
| `MAX_EVENTS_PER_FRAME` | 4096 | `docs/EVENT-BUS.md` §1.2(L63「每帧 4096 事件」) | **逐字明写** |
| `HISTORY_CAPACITY` | 512 | `docs/EVENT-BUS.md` §1.3(L71「最近 512 条投递记录」) | **逐字明写** |
| `MAX_SUBSTEPS` | 4 | `docs/WS-02-physics.md` §5 参数表(L356「MAX_SUBSTEPS \| 4 \| 见 §4.1 推导」)+ §4.1 伪码(L156)+ 推导(L164) | **逐字明写** |
| `CONTENT_FINGERPRINT_VERSION` | 1 | ⚠️ **手册没有把 `1` 写成常量数值**。只能从**指纹串格式**推:`docs/DATA-CONFORMANCE.md:265` 与 `docs/COMPLETION-CRITERIA.md:49` 都写 `v1-eaefa38b`,格式为 `v{version}-{8hex}` ⇒ 首段 `v1` ⇒ version = 1 | **推导得出,非逐字** |

⚠️ **手册没写、我靠推导的那一条,单独点名:`CONTENT_FINGERPRINT_VERSION = 1`。** 依据是**指纹串字面量** `v1-eaefa38b` 出现在两处独立文档里,而不是手册某节写了「版本常量 = 1」。如果 Lead 认为这不够硬,替代方案是在手册 `docs/DATA-CONFORMANCE.md` 的内容基线小节补一行「指纹算法版本 v1」,但**我没有去改手册**(不在我写域,且会动门禁的文档一致性检查)。

`ICON_SIZE = 16` 有来源(`docs/WS-06-alchemy.md:477` 参数表「ICON_SIZE \| 16 \| 手册 §5.5 16×16」、`:369` schema `minItems:16,maxItems:16`),但我**没有改** WS-06,该文件由 `alchemy-core` 处理。

---

## 任务2:WS-01/WS-02 注入清单(逐条:改了什么 → 该断言红了吗 → 生效自检怎么做)

**生效自检的统一做法**(重要 —— "没红"不可信的根因):驱动器 `_tp89_inject.ts` 在改完文件后,**先 `import()` 被测模块并打印该常量的运行期值**,确认等于我改后的值,再跑套件。初始版本有个坑:对**函数型导出**打印 `undefined`(`JSON.stringify(fn)` 恒为 `undefined`),看起来像"注入没生效";已修成**调用函数并打印返回值**。对**类静态成员**同样修过一次(`Chunk::RESIDENT_BYTES` 形态,类不能直接调用)。

表列说明:「红」= 断言在这组注入下变红并给出中文报错;所有 case 还原后 SHA-256 逐字节一致。

### A. 常量改值型(直接改实现里的数值字面量)

| # | 目标 | 改了什么 | 红? | 生效自检读回 |
|:---|:---|:---|:---|:---|
| i1 | `blueprint.ts` | `BLUEPRINT_SIZE` 16→15 | **红 6**(83/89) | `= 15` |
| i2 | `registry.ts` | `CONTENT_FINGERPRINT_VERSION` 1→2 | **红 4**(79/83) | `= 2` |
| i3 | `bus.ts` | `MAX_EVENTS_PER_FRAME` 4096→4103 | **红 1**(64/65) | `= 4103` |
| i4 | `bus.ts` | `HISTORY_CAPACITY` 512→519 | **红 2**(63/65) | `= 519` |
| i5 | `pixel_icon.ts` | `ICON_SIZE` 16→8 | **红 13**(51/64) | `= 8` |
| i6 | `chunk.ts` | 地砖 315 `mu` 0.98→0.90 | **红 4**(46/50) | slot 15 `= 0.9` |
| i7 | `carry.ts` | `STACK_STEP = CARRY_Z_STEP`→`+0.01` | **红 1**(42/43) | `= 0.86` |
| i8 | `carry.ts` | `STACK_4_TOP_Z` `+0.01` | **红 1**(42/43) | `= 2.5599999999999996` |
| i9 | `carry.ts` | `theoreticalAirtime` ×1.001 | **红 1**(42/43) | `0.6673333333333332` |
| i10 | `chunk.ts` | 整张 μ 表 `+0.01` | **红 3**(47/50) | slot0 `0.73` / slot15 `0.99` |
| i11 | `fluid.ts` | 相变记账 `+1` | **红 3**(47/50) | 总账 13800→13806 等 |
| i12 | `fluid.ts` | **删除** `totalConsumedByPhase += lostWater` | **红 3**(47/50) | 守恒误差 7.196% |
| i13 | `carry.ts` | `theoreticalRange` `+0.01` | **红 1**(42/43) | `5.676666666666666` |
| i14 | `carry.ts` | `arcElevation` `+0.01` | **红 1**(42/43) | `0.6246629519221656` |
| i15 | `physics/world.ts` | `TRAP_DELAY` 0.4→0.5 | **红 1**(42/43) | `= 0.5` |
| i16 | `physics/world.ts` | `COLLISION_RESTITUTION` 1.0→0.9 | **红 1**(42/43) | `= 0.9` |
| i17 | `carry.ts` | `SHIELD_ITEM_ID` 218→219 | **红 1**(42/43) | `= 219` |
| i18 | `carry.ts` | `LIFT_RANGE` 0.75→0.80 | **红 1**(42/43) | `= 0.8` |
| i19 | `chunk.ts` | `DIRTY_WORDS` 8→16 | **红 3**(47/50) | `= 16` |
| i20 | `chunk.ts` | `Chunk.RESIDENT_BYTES` +68 | **红 1**(49/50) | `Chunk.RESIDENT_BYTES = 1700` |
| **i21** | `chunk.ts` | **阴性对照**:值不变,只加注释 | **仍绿 50/50,exit 0** ✓ | `Chunk.SERIALIZE_BYTES = 1024` |
| i22 | `fluid.ts` | `CAP` 1000→1200 | **红 1**(49/50) | `= 1200` |
| i23 | `chunk.ts` | `FLOOR_DEFAULT_MU` 0.75→0.80 | **红 2**(48/50) | `= 0.8` |
| i24 | `chunk.ts` | `BARE_GROUND_MU` 0.72→0.80 | **红 2**(48/50) | `= 0.8` |
| i25 | `fluid.ts` | `PHASE_MIN_AMOUNT` 50→80 | **红 1**(49/50) | `= 80` |
| i26 | `physics/world.ts` | `BURN_DPS` 15→18 | **红 1**(42/43) | `= 18` |
| i27 | `physics/world.ts` | `BLEED_DPS` 20→25 | **红 1**(42/43) | `= 25` |
| i28 | `carry.ts` | `LIFT_Z_MAX` 0.45→0.50 | **红 1**(42/43) | `= 0.5` |
| i29 | `carry.ts` | `HEAVY_MASS_THRESHOLD` 10→12 | **红 1**(42/43) | `= 12` |
| i30 | `carry.ts` | `BOUNCE_TARGET_Z` 2.0→2.5 | **红 1**(42/43) | `8.044→9.045` |
| i31 | `carry.ts` | `theoreticalRange` 返回 `NaN` | **红 1**(42/43) | `= NaN` |
| i32 | `chunk.ts` | `BARE_GROUND_MU` 置 `NaN` | **红 2**(48/50) | `= NaN` |
| i33 | `chunk.ts` | `ROOF_CAPABLE` 去掉 376 | **红 1**(49/50) | 集合 6→5 |
| i34 | `world/grid.ts` | `digToDeep` 写 `PLATFORM` 而非 `DEEP` | **红 1**(49/50) | `elev = 2` |
| i35 | `shared/physics.ts` | `CATCH_Z_MIN` 0.3→0.25 | **红 1**(42/43) | `= 0.25` |
| i36 | `shared/physics.ts` | `CATCH_Z_MAX` 1.4→1.5 | **红 1**(42/43) | `= 1.5` |
| i37 | `shared/physics.ts` | `CARRY_SLOWDOWN` 0.85→0.80 | **红 3**(40/43) | `= 0.8` |
| i38 | `shared/physics.ts` | `RADIUS_PLAYER` 0.35→0.40 | **红 1**(42/43) | `= 0.4` |
| i39 | `shared/physics.ts` | `MASS_BOSS` 20→25 | **红 1**(42/43) | `= 25` |
| i40 | `fluid.ts` | `OBSIDIAN_ID` 110→111 | **红 2**(48/50) | `= 111` |
| i41 | `fluid.ts` | `PUMICE_ID` 111→112 | **红 2**(48/50) | `= 112` |
| i42 | `chunk.ts` | `SPEED_MUL_DEFAULT` 1.0→1.1 | **红 1**(49/50) | `= 1.1` |
| **i43** | `physics/world.ts` | `MAX_SUBSTEPS` 4→5 | **⚠️ 首次仍绿 43/43** → **修好后红 1** | `= 5` |
| i44 | `chunk.ts` | `DIRTY_BYTES` 32→36 | **红 3**(46/50) | `= 36` |
| i45 | `fluid.ts` | `FLUID_CELL_BUDGET` 1024→2048 | **红 1**(49/50) | `= 2048` |
| i46 | `fluid.ts` | `FLUID_FRAME_SECONDS` 0.5→0.25 | **红 1**(49/50) | `= 0.25` |
| i47 | `shared/physics.ts` | `MASS_HEAVY` 3→4 | **红 1**(42/43) | `= 4` |
| i48 | `shared/physics.ts` | `RADIUS_WILD` 0.40→0.50 | **红 1**(42/43) | `= 0.5` |
| i49 | `chunk.ts` | `FLOOR_SLOT_MASK` 0x3f→0x1f | **红 3**(47/50) | `= 31` |
| i50 | `physics/world.ts` | `BOUNCE_VZ_ANALYTIC` 目标 2→3 | **红 1**(42/43) | `10.392304845413264` |

### B. 覆盖率与分母(避免「覆盖了多少」含糊)

| 套件 | `test()` 数 | 正文真引用的数值常量(有效池) | 我注入过的 | 覆盖率 | 精度 |
|:---|:---|:---|:---|:---|:---|
| WS-01 | 50 | 15 | 13 | 86.7% | 常量级 |
| WS-02 | 43 | 32 | 32 | 100% | 常量级 |
| 合计 | 93 | 47 | 45 | **95.7%** | 常量级 |

**分母口径**:有效池 = 本套件 `import` 的模块里「运行时导出为有限 number」且「正文真引用过(排除 import 行)」的常量。用运行时 `import()` 取导出,不用正则猜。**分母 > 0 已断言**(WS-01: 15 > 0;WS-02: 32 > 0)。

剩下 2 个未注入:`CHUNK_CELLS`(纯派生自 `CHUNK_BYTES`/尺寸,改它会连带 5+ 条断言且会掩盖归因)、`EMPTY_TILE`(它是**打包后的位模式整数**,已在 task-80 单独做过完整注入与根因修复,见 `docs/WS-01-terrain.md` §7.1)。

⚠️ **注意区分「常量级覆盖」与「断言级覆盖」**:我覆盖的是**常量的漂移**,不是**每条断言的牙**。WS-01 有 194 条数值断言、WS-02 有 121 条,常量注入只能覆盖其中「以该常量为期望值」的那部分。

---

## 任务2:★ 仍绿的有哪些 —— 逐条判"没牙"vs"第二份实现顶着"(不许含糊)

50 组注入里,**只有 2 组出现过「仍绿」**,逐条判定如下:

### ① `i43` `MAX_SUBSTEPS` 4→5 ⇒ 仍绿 43/43 —— 判定:**没牙(装饰),不是第二份实现**

- **已排除「第二份实现顶着」**:生效自检确认运行期读回 `= 5`(`world.ts:144` 只有一处定义,`git grep` 确认无第二份)。实现侧 `world.ts:329-333` 用的是同一个 `MAX_SUBSTEPS`,没有别的常量在钳制。
- **已排除「分支没被执行」**:实测该场景 `lastReport.substeps = 4`,**等于上界** ⇒ `clampInt` 的上界分支**被行使过**。所以不是「没走到所以没红」。
- **确切成因**:断言 `ok(substeps <= MAX_SUBSTEPS)` 的**两侧同源** —— `substeps` 由 `clampInt(..., 1, MAX_SUBSTEPS)` 产出,其上界就是被断言的常量 ⇒ 任何常量值都不等式恒成立。
- **门禁为什么漏了它**:`checkTautology` 的正则只匹配 `eq`/`near` 的第二实参,**不匹配 `ok(... <= CONST)`**;`checkFrozen` 字面量表也不含它。⇒ **双重盲区**。
- **处置**:已修(双向锚定),修后注入变红。

### ② `i12` 第一次尝试 ⇒ 仍绿 50/50 —— 判定:**我的注入是语义 no-op(既不是没牙,也不是第二份实现)**

- 我最初在 `fluid.ts` 记账行**之后**插入 `this.amount[i] = 0;`,结果全绿。
- **根因**:该行**本来就在** `fluid.ts:634`。我"插入"的是同一行代码 ⇒ 语义上什么都没改 ⇒ 绿是**正确**结果,不代表断言弱。
- **这正是 Lead 警告的「我以为改坏了其实没改坏」**。靠生效自检(读回被改的值/重看 diff)才察觉。
- **重做**(i12 有效版):改成**删除**记账行 `this.totalConsumedByPhase += lostWater;` ⇒ 真泄漏 ⇒ **红 3**(守恒误差 7.196%),证明守恒断言有牙。

### ③ 我主动构造的阴性对照 `i21` ⇒ 仍绿 50/50 —— 判定:**预期行为,不是缺陷**

只加注释不改值,套件应保持全绿。它的作用是**证明我的驱动器不是「凡跑必红」** —— 否则上面 48 个「红」的说服力要打折。

### 除以上 3 条外,其余 47 组**全部变红**。所以我的结论是:

**WS-01 / WS-02 的数值断言不是大面积装饰。** 90% 的注入(47/50)都打出了对应的红;剩下的 3 组各自有明确、可复现的成因,其中只有 1 组(①)是真正的缺陷,已修。

⚠️ **但我不能因此宣称「断言全都有牙」** ——
- 我的覆盖是**常量级**的(95.7% 的常量),不是**断言级**的(315 条数值断言只覆盖了以这些常量为期望的那部分)。
- 我**没有**逐条对 194+121 条断言各构造一次破坏。
- 那 57 处 `ok(... CONST)` 形态里,我只实测了 `MAX_SUBSTEPS` 一处,其余 56 处**是待查清单,不是"都没问题"**。

### 结构性审计(不依赖注入的独立证据)

| 检查 | WS-01 | WS-02 | 判定 |
|:---|:---|:---|:---|
| `test()` 块总数(分母,已断言 > 0) | 50 | 43 | — |
| 零断言块(体内无 `eq/near/ok/inRange/includes`) | **0** | **0** | 无「只跑代码不判事」的空壳 |
| 仅恒真 `ok(true)` 块 | **0** | **0** | 无恒真式 |
| 断言被 `try` 包住(可能被 catch 吞) | **0** 条 | **0** 条 | 无吞断言 |
| `near` 相对容差 > 1e-6(可能"容差大到抓不住") | **0** 条 | **4** 条(L280/589/591/592) | WS-02 那 4 条容差 0.01,已实测破坏 0.01 以上都能红(i8/i9/i13/i14) |

---

## 有牙证据与还原 SHA-256

### 生产代码全部逐字节还原(7 个文件,注入后复核)

| 文件 | SHA-256 | 状态 |
|:---|:---|:---|
| `server/src/build/blueprint.ts` | `4138EEC06A3A5581374E911C30767947EED2B23FE4BE6A8A4604C0450B7D624F` | ✓ 一致 |
| `server/src/content/registry.ts` | `11513BB087A92E27EB79C05DC661FA8DF73925B4F99A3841CDC716687FF28B40` | ✓ 一致 |
| `server/src/events/bus.ts` | `AE6DBBF2AC3916480E9FB38236B1142A6D23865C3A2E6556EAF6A6F62422C0C0` | ✓ 一致 |
| `server/src/alchemy/pixel_icon.ts` | `AAD56AF9893FBEE51BDCFFBAA4B7C6852B15A634BAF79E441B5CA74F4AFC91AC` | ✓ 一致 |
| `server/src/world/chunk.ts` | `2A9D2B44726E4D906F6514F4ED7A7C7B6D43D1DEEAF1F89ADB7F26ED994F9C86` | ✓ 一致 |
| `server/src/world/fluid.ts` | `ECF9AE5E35B947675ECF14CF59BA8209FD8D4DD9C84ADC39CA0CF22FCB96DBB3` | ✓ 一致 |
| `server/src/world/grid.ts` | `93713128E8429B0BA71BA6F565A98132F26B1A57A5833612B1785F484E5B379C` | ✓ 一致 |
| `server/src/physics/carry.ts` | `A83126AD1158BE69971D5D5DE0148ABED04AF23589E31B7579358A525DD9429E` | ✓ 一致 |
| `server/src/physics/world.ts` | `4E1519531308008994E79F622D054FB98B96B4DD444C8B7E2404A86B5813BD5A` | ✓ 一致 |
| `shared/types/physics.ts` | `154D111F9D8F7AF0F5792E745E90C209E859DFAF170560E7B6349C5E156E80F5` | ✓ 一致 |

**生产代码净改动 = 0。** 每组的还原后 SHA-256 都打印在 `_tp89_i1.txt` ~ `_tp89_i50.txt` 里,可逐条核对。

### 我改的测试文件(有意改动)

| 文件 | SHA-256(改后) | 改动内容 |
|:---|:---|:---|
| `tests/WS-01.test.ts` | `76CE1E7B193C1C4F9E47B9CCB8B9E08714698EEBAC9CCF818D5BBF9AAF2FA09A` | `CAP` 同义反复改字面量 1000 |
| `tests/WS-02.test.ts` | `5C50C977F8DB2302C0E564A7CFD7CAC9B318811F4A443FA5476D2B8B4E7CC218` | `MAX_SUBSTEPS` 空断言修好(新增 2 条 eq) |
| `tests/WS-03.test.ts` | `F07DE36944DFF9EB9B3C31EB0D91A32AC2BE6D302DDDF119E87F0F1CDE4F1A45` | `BLUEPRINT_SIZE` 两条改字面量 + 加常量锚定 |
| `tests/WS-FND-01.test.ts` | `BC54715545FDD07F8B4D7A61CD95E444DBFA2188C56B8B874EB5F99CD4646F6D` | 版本断言改字面量 1 + 保留锚定 |
| `tests/WS-FND-02.test.ts` | `ACF50EC3CF82B8E043D615214AF22A41F04079AD9EAB2E8242C30693F3257C7A` | 容量/上限两条改字面量 + 保留锚定 |

> 我只改了这 5 个测试文件。`tests/WS-06.test.ts` 的改动(`:593`/`:595` 双重锚定)**不是我做的**,归 `alchemy-core` / Lead。

### 套件计数未变(改前改后逐个核对)

| 套件 | 改前 | 改后 | 说明 |
|:---|:---|:---|:---|
| WS-01 | 50/50 | 50/50 | 改了 `CAP` 那条同义反复,计数不变 |
| WS-02 | 43/43 | 43/43 | 加了 2 条断言但**在既有 `test()` 体内** ⇒ 计数不变 |
| WS-03 | 89/89 | 89/89 | 同上 |
| WS-FND-01 | 83/83 | 83/83 | 同上 |
| WS-FND-02 | 65/65 | 65/65 | 同上 |
| WS-06 | 64/64 | 64/64 | 我未改 |

> 之所以「加了断言但计数不变」:`report()` 只数 `test()` 调用次数,不数内部断言。这是本仓的既有约定,也是我能安全加锚定的前提。

---

## 请 Lead 摘除的白名单条目 + 请 Lead 改的数字

### 1. 白名单条目状态(**Lead 已全部处理完毕,我实测复核**)

我最初报告「请摘除 4 条」,Lead 已执行。我逐条读了 `verify.ts:2680-2711` 并跑了门禁确认:

| 条目 | 状态 | 我的复核 |
|:---|:---|:---|
| `WS-03::BLUEPRINT_SIZE` | **已摘除** | ✓ 不再在候选集(`_tp89_unreg.ts` 实测「已不在候选集」) |
| `WS-FND-01::CONTENT_FINGERPRINT_VERSION` | **已摘除** | ✓ 同上 |
| `WS-FND-02::HISTORY_CAPACITY` | **已摘除** | ✓ 同上 |
| `WS-FND-02::MAX_EVENTS_PER_FRAME` | **已摘除** | ✓ 同上 |
| `WS-06::ICON_SIZE` | **已摘除** | ✓ 我原建议「保留 + 改措辞」;Lead 进一步做了**双重锚定**(`WS-06.test.ts:593` 字面量 16 + `:595` `eq(ICON_SIZE,16)`),比我的建议更彻底。**采纳**。 |

⇒ **本节已无待办**。原来的「请摘除」清单现在只作为历史记录保留在下方。

<details>
<summary>历史记录:我最初提交的摘除清单(Lead 已执行)</summary>

```
WS-03::BLUEPRINT_SIZE
WS-FND-01::CONTENT_FINGERPRINT_VERSION
WS-FND-02::HISTORY_CAPACITY
WS-FND-02::MAX_EVENTS_PER_FRAME
```
理由:已改成**独立字面量** ⇒ 不再命中 `checkTautology` 候选集。
保留项 `WS-06::ICON_SIZE`(当时判断 111/112 有牙)。`verify.ts:2685` 的 `/* ── WS-03 ── */` 孤立注释也要顺手处理。
</details>

### 3. 请 Lead 评估的数字(**手册没给出的那一条**)

- `CONTENT_FINGERPRINT_VERSION = 1` 的 1 **不是手册逐字写的**,是从指纹串 `v1-eaefa38b` 的格式推的。若要求「字面量必须有手册明文」,这条不达标。建议在 `docs/DATA-CONFORMANCE.md` 内容基线小节补一行明文;我没改手册。

### 4. ★ 请 Lead 评估的门禁检测器扩容(任务2 的额外产出)

`checkTautology`(`verify.ts:3352`)的正则**只认 `eq`/`near` 的第二实参**。以下形态是**结构性盲区**:

```ts
ok(substeps <= MAX_SUBSTEPS, ...)    // 实测恒真,已修
```

全仓扫描 `tests/` 下 27 个 `*.test.ts`,「`ok(... 比较式含大写常量)`」共 **57 条**。**这 57 条不一定都是同义反复**(只有常量同时是实现里的钳制上界时才恒真),但它们是**同一种风险形态**。已全量列在 `_tp89_substeps_out.txt` 第 4 节,逐条带文件名行号,供你评估是否要扩检测器。

其中**高危疑似**(常量明显是实现的上界):
- `tests/WS-02.test.ts:769` `ok(substeps <= MAX_SUBSTEPS)` —— **已确认恒真并修好**
- `tests/WS-FND-02.test.ts:240` `ok(calls <= MAX_EVENTS_PER_FRAME + 1)` —— 形态同源,未实测
- `tests/WS-09.test.ts:2313` `ok(area <= MAX_SELECT_CELLS)` —— 待查
- `tests/WS-09.test.ts:539/558` `ok(b.faceCount <= CHUNK_CELLS * FACES_PER_CELL_MAX)` —— 待查
- `tests/WS-07.test.ts:1637` `ok(dist <= STEP + 1e-9)` —— 待查

### 5. 门禁其它红项(**不是我的**,列出以免误判)

- `✗ 类型错误比基线增加了 2 条`:`tests/WS-FND-13.test.ts` `TS2339 Property 'advance' does not exist on type 'HostProbe'` —— 别人的文件。
- `✗ README 用例汇总过期`:声称 1511,实测 1518(别人新增了套件)。
- `✗ 同义反复白名单失真(1 处)`:仅剩 `WS-09::SLOTS_PER_ROW`(已不再命中,应移出)—— 归属 `client-stage`,不是我。
- 我负责的 4 条**已实测移出**失真列表(门禁输出里逐个确认过);`WS-06::ICON_SIZE` 也已被 Lead 正确摘除。

### 6. ★★ 请 Lead 修的 `scripts/verify.ts` 崩溃级缺陷(逐行)

已在「我不能证明的」§8 详列。要点复述:**`reachHint` 跨函数引用**,`checkTautology` 引用不到 `checkReachability` 的局部 const ⇒ 走到「有未登记候选」分支时抛 `ReferenceError` 终止 **整轮门禁**,后续节全部跳过,但退出码仍是 1。

**实测复现**:`node scripts/verify.ts --all` 与 `node scripts/verify.ts --all --strict-taut` **两条路径都崩**,输出停在:

```
[同义反复候选]
  ⚠ 新增未登记的同义反复候选 6 个(断言右侧取自被测模块导出常量):
      · WS-09  ORTHO_DISTANCE
      ...
file:///.../scripts/verify.ts:3556
      console.warn(`      ${reachHint}`);
ReferenceError: reachHint is not defined
```

**危险点**:这条缺陷把「门禁发现新问题」和「门禁自己坏掉」**压成同一个退出码 1** ⇒ 久而久之会把崩溃读成"又是那几条老红"。

### 7. 门禁报的其余未登记候选(**不是我的**,逐名交 Lead 归口)

```
WS-09  ORTHO_DISTANCE
WS-09  TRANSPARENT_INDEX
WS-09  SLOTS_PER_ROW        ← 同时被报「已不再命中,应移出白名单」(失真 1 处)
WS-10  MAX_CRIT_DMG
WS-10  MAX_CRIT_RATE
WS-10  MAX_DODGE_RATE
WS-FND-07  OBSIDIAN_ID
```

⚠️ **`WS-10::MAX_DODGE_RATE` 请重点转给 `combat-progress`**:我在 `tests/WS-10.test.ts:1201-1211` 读到注释自述「原断言 `ok(capped.dodgeRate <= MAX_DODGE_RATE)` 是**空断言** … 已改为字面量 0.13 + 锚定 0.75」,但门禁现在**仍把 `WS-10::MAX_DODGE_RATE` 列为未登记候选** ⇒ 很可能还有**第二处** `eq(x, MAX_DODGE_RATE)` 形态没改干净。这正是我这次在 `WS-01::CAP` 上亲身经历的同一模式(**修了一处,另一处仍留着,且被前一处 throw 遮蔽**)。

### 8. 关于 `docs/TASK-89-terrain-injection-review.md`(本文)

新文件会让「非 WS 文档份数」从 57 → 58 → 59(期间也有别人的文档加入)。`verify.ts` 只 `pass()` 比对实测数、**不**与 README 的写入值比对,所以**不会变红**;若 Lead 需要保持台账整洁,可以删本文(报告内容我已通过 `send_message` 全文交付)。

---

## 我留下的临时文件(逐名)

**全部在仓库根目录,全部被 `.gitignore` 覆盖,按纪律不自行删除,请 Lead 处置。合计 93 个**(11 个探针 + 53 个逐组注入输出 + 29 个其它输出),逐一列名如下。

### 探针 / 驱动器(11 个 `.ts`)

```
_tp89_hits.ts
_tp89_enum.ts
_tp89_inject.ts
_tp89_wl.ts
_tp89_ws06.ts
_tp89_decor.ts
_tp89_struct.ts
_tp89_cov.ts
_tp89_frozen.ts
_tp89_substeps.ts
_tp89_unreg.ts
```

### 其它输出(29 个)

```
_tp89_hits_out.txt
_tp89_enum_out.txt
_tp89_enum_console.txt
_tp89_inject_out.txt
_tp89_wl_out.txt
_tp89_wl_console.txt
_tp89_ws06_out.txt
_tp89_ws06_console.txt
_tp89_decor_out.txt
_tp89_decor_console.txt
_tp89_struct_out.txt
_tp89_struct_console.txt
_tp89_cov_out.txt
_tp89_cov_console.txt
_tp89_frozen_out.txt
_tp89_frozen_console.txt
_tp89_substeps_out.txt
_tp89_substeps_console.txt
_tp89_unreg_out.txt
_tp89_unreg_console.txt
_tp89_gate1.txt
_tp89_gate2.txt
_tp89_gate3.txt
_tp89_gate4.txt
_tp89_gate5.txt
_tp89_gate6.txt
_tp89_crash.txt
_tp89_crash2.txt
_tp89_crash3.txt
```

### 逐组注入输出(53 个,逐名)

```
_tp89_i1.txt   _tp89_i2.txt   _tp89_i2b.txt  _tp89_i3.txt   _tp89_i4.txt
_tp89_i5.txt   _tp89_i6.txt   _tp89_i7.txt   _tp89_i8.txt   _tp89_i9.txt
_tp89_i10.txt  _tp89_i11.txt  _tp89_i12.txt  _tp89_i13.txt  _tp89_i14.txt
_tp89_i15.txt  _tp89_i16.txt  _tp89_i17.txt  _tp89_i18.txt  _tp89_i19.txt
_tp89_i20.txt  _tp89_i21.txt  _tp89_i22.txt  _tp89_i22b.txt _tp89_i23.txt
_tp89_i24.txt  _tp89_i25.txt  _tp89_i26.txt  _tp89_i27.txt  _tp89_i28.txt
_tp89_i29.txt  _tp89_i30.txt  _tp89_i31.txt  _tp89_i32.txt  _tp89_i33.txt
_tp89_i34.txt  _tp89_i35.txt  _tp89_i36.txt  _tp89_i37.txt  _tp89_i38.txt
_tp89_i39.txt  _tp89_i40.txt  _tp89_i41.txt  _tp89_i42.txt  _tp89_i43.txt
_tp89_i43b.txt _tp89_i44.txt  _tp89_i45.txt  _tp89_i46.txt  _tp89_i47.txt
_tp89_i48.txt  _tp89_i49.txt  _tp89_i50.txt
```

> ⚠️ 门禁会报「临时残留 2xx 个」,那里面**大部分是别人的**(如 `_argcheck.ts`、`_ic_q*.ts`、`_bl.txt`、`_dl.txt`)。我只认领上面这 93 个 `_tp89_*`。

### 第二批(task-A / task-B,9 个)

```
_tp91_taskA.ts        _tp91_taskA_out.txt
_tp91_taskB.ts        _tp91_taskB_out.txt      ← 第一版,结论句硬编码(★ 刻意保留作反面教材)
_tp91_taskB2.ts       _tp91_taskB2_out.txt     ← 第二版,注释行被当断言(★ 刻意保留)
_tp91_taskB3.ts       _tp91_taskB3_out.txt     ← 终版,口径正确
_tp89_gate7.txt                                ← Lead 修好 reachHint 后的全绿门禁输出
```

---

## 追加:任务 A —— `WS-FND-07::OBSIDIAN_ID`

> ⚠️ **时序事实**:我开工时 Lead 已**并发修好**了 `tests/WS-FND-07.test.ts:73/:74`(改成字面量 110)。所以我不是"发现缺陷",而是**独立验证了该修复**。以下证据链对**当前**文本有效。

### 1 全部命中处(file:line,代码/注释分列)

扫 `tests/` 下 27 个 `*.test.ts`(分母已断言 > 0)⇒ 命中 10 处,**代码行仅 3 处**:

| file:line | 代码? | 原文 |
|:---|:---|:---|
| `tests/WS-01.test.ts:29` | 代码 | `CAP, PHASE_MIN_AMOUNT, OBSIDIAN_ID, PUMICE_ID, FLUID_CELL_BUDGET,` |
| `tests/WS-01.test.ts:701` | 代码 | `eq(OBSIDIAN_ID, 110, '黑曜石 ID');` |
| `tests/WS-FND-07.test.ts:32` | 代码 | `import { OBSIDIAN_ID } from '../server/src/world/fluid.ts';` |
| `tests/WS-01.test.ts:777/778/780` | 注释 | (task-80 的解释性注释) |
| `tests/WS-FND-07.test.ts:52/53/55/70` | 注释 | (Lead 本次修复的解释性注释) |

⚠️ 这 3 处是**用 `stripComments` 逐行判定**分出来的 —— 直接 grep 会把注释里的示例算成代码(我在任务 B 里正好踩过这个坑)。

### 2 判定:真同义反复

逐跳追踪(带 file:line):
```
跳1  fluid.ts:620          const product = kind===HOT_SPRING ? PUMICE_ID : OBSIDIAN_ID;
跳2  world_sim.ts:3967-3968  for (const p of drainPhaseProducts()) this.setCell(p.x, p.y, { obj: p.obj })
跳3  → 写入 OBJ 层
跳4  → grid.objIdAt(4,4) 读回**同一个值**
```
⇒ 期望值与被测值**同源** ⇒ 改常量两侧同步移动 ⇒ 恒真。**Lead 的字面量 110 改法正确。**

### 3 独立来源:手册**逐字明写**(最高档)

```
docs/WS-01-terrain.md:268   | OBSIDIAN_ID | 110 | items.ts 黑曜石块 |
docs/WS-01-terrain.md:171   WATER + LAVA → 黑曜石 110
docs/WS-01-terrain.md:173   SLIME + LAVA → 黑曜石 110
```
⇒ 与 `BLUEPRINT_SIZE` / `MAX_EVENTS_PER_FRAME` **同级**(逐字明写),**不是** `CONTENT_FINGERPRINT_VERSION` 那种「靠格式推导」的次档。**这条不需要额外裁定。**

### 4 有牙证据:注入 ⇒ **该行亲自红**(取自 stderr)

```
基线            exit=0   8/8 通过(stderr 失败行 0 条)
注入            fluid.ts  OBSIDIAN_ID 110 → 999
生效自检(子进程读回)  OBSIDIAN_ID = 999        ← 证明"我以为改坏了"是真改坏
注入后          exit=1   7/8(stderr 失败行 1 条)
★ stderr 原文:
  ✗ [WS-FND-07] WF-07-01 相变产物写回地形… — 水侧该格 OBJ 层已写入黑曜石 110(内容表 items.ts:40)
     期望 110 / 实际 999
⇒ **目标行亲自红**,不是"套件红了"
还原            ecf9ae5e35b94767 → ecf9ae5e35b94767   ✓ 逐字节一致
```
> 注意:失败行只有 1 条(`:73` 先 throw ⇒ `:74` 被遮蔽)—— 与下面任务 B 的发现**同构**。

---

## 追加:任务 B —— over-determination 遮蔽做成**可复跑判据**

### 实例

`tests/WS-01.test.ts` 的 `注入水量受容量钳制,不会溢出 CAP`(L846~L866)。
被测断言行 **7 条**(已用 `stripComments` 排除 2 条注释行 L853/L857);目标 = **L860**。

### ★ 遮蔽深度 = 3

| 中和前 N 条 | exit | 通过 | 目标是否首红 | stderr 首条失败 |
|:--|:--|:--|:--|:--|
| 0 | 1 | 49/50 | 仍非目标 | `单位容量 1000 毫格 期望 1000 / 实际 1200`(L847) |
| 1 | 1 | 49/50 | 仍非目标 | `只接受剩余 300 期望 300 / 实际 500`(L852) |
| 2 | 1 | 49/50 | 仍非目标 | 同 L852(仍在顶上) |
| **3** | 1 | 49/50 | **目标行亲自红** | `钳制到 CAP(= 1000 毫格) 期望 1000 / 实际 1200`(**L860**) |

**判据形式**:「中和掉前 N 条 ⇒ 目标行才**首次**成为失败行」⇒ N = 遮蔽深度。**N ≥ 1 即该断言平时从未被行使。** 逐条前序都是 `CAP` 的函数:L847 / L850 / L852。

### 意义:粒度错配

```
checkTautology 按 **(套件::常量)** = 断言级
注入复核按 **test 块**      = 块级(harness.ts:162 的 eq() 首条即 throw)
⇒ 断言级缺陷可被**块级绿**掩盖
```
**两个可选判据**(交 Lead 裁定,我不改 harness):(a) 报「遮蔽深度 > 0」清单;(b) 改 harness 让 `eq`/`near` 收集失败后**跑完块** ⇒ 遮蔽在根上消失,但改语义需 Lead 定。

### ★★ 两个自曝坑(都在我自己的探针里)

| 坑 | 现象 | 根因 | 修法 |
|:---|:---|:---|:---|
| **坑1 结论句硬编码** | 第一版 `note()` 写「目标行亲自红 ⇒ 它有牙」,而**它自己的实测输出是 `NO`** | 结论是硬编码字符串 ⇒ **不随测量变化**,与测量相反 | 结论**只由测量变量生成** + 新增「无法证明」分支 |
| **坑2 注释行被当断言** | 第二版把 2 条注释行算进"中和对象",其中 1 条是 `no-op` ⇒ 报出的「深度 3」实为「深度 2 + 1 次无效中和」 | **没用 `probe-kit` 的 `stripComments()`** —— 而它存在的理由正是「本仓已两次踩到读到注释里的示例」 | 第三版补上,深度 3 才是可信值 |

⇒ **建议进 PROGRESS:「探针的结论句若硬编码,它自己就是装饰」** —— 这是本仓「判据坏掉却伪装成正常」同族形态在**探针**上的实例。两版有缺陷的探针我**刻意保留**(`_tp91_taskB.ts` / `_tp91_taskB2.ts`),作为实物证据。

### 我能证明的 / 不能证明的(任务 B)

- **能证明**:该块遮蔽深度 = 3;目标行本身有牙(中和 3 条后亲自红);还原 SHA-256 逐字节一致。
- **不能证明**:①我只测了**这 1 个块**;288/312 个多断言块(92.3%)**未逐个测**。②我说不出全仓「被遮蔽断言」的**总数** —— 需对每块做多次中和实验,成本远超本轮。

---

## 未做项 + 理由

1. **`scripts/verify.ts` 我没动(包括那处 `reachHint` 崩溃和 4 条白名单)。** 理由:不在我写域(`✗ Do not touch: scripts/**`),Lead 明确说白名单与门禁由你改。白名单你已执行完毕;**`reachHint` 崩溃也已由 Lead 修好**(改为语义正确的 `tautHint`),我复跑确认 `exit=0`。
2. **`README.md` / `docs/PROGRESS.md` 我没动。** 理由:同上,不在写域。门禁报的 README 台账过期与用例汇总过期都是**别人**新增内容导致的,不是我改出来的。
3. **`tests/WS-06.test.ts` 我没动。** 理由:不在写域,该文件归 `alchemy-core`;而且我的结论是「保留 + 改措辞」,不需要改断言。(注:`alchemy-core` 本轮已把 `:148/149` 改成字面量 16。)
4. **`shared/types/physics.ts` / `shared/types/tile.ts` 的注入算越界吗 —— 我需要声明。** 这 2 个文件在 `✗ Do not touch: shared/contracts/**` 之外(`shared/types/`),但仍是冻结层。我用它们做了 i35~i39、i47、i48 共 7 组注入,**全部立即还原,SHA-256 逐字节一致**(见上表 `154D111F...`)。
5. **57 处 `ok(... CONST)` 我只实测了 1 处。** 理由:每处都做完整注入闭环的成本远超本轮预算,且其中多数常量(如 `SLOTS_PER_PAGE`、`INVENTORY_SLOTS`)不在 WS-01/WS-02 范围(属 WS-09)。我把清单全量交给你,而不是含糊地说「应该都没事」。
6. **我没有逐条对 315 条数值断言各构造一次破坏。** 理由:同上。我做的是**常量级 95.7% 覆盖** + **结构性审计(零断言块/恒真/吞异常)** + **抽样的 50 组注入**,并明确写清「常量级 ≠ 断言级」。
7. **`CHUNK_CELLS`、`EMPTY_TILE` 未在本轮注入。** 理由:`CHUNK_CELLS` 是纯派生量,改它会让 5+ 条断言同时红、掩盖归因;`EMPTY_TILE` 已在 task-80 做过完整注入与根因修复(见 `docs/WS-01-terrain.md` §7.1),重复注入无新信息。
8. **`docs/TASK-89-terrain-injection-review.md` 这份报告我建了**(即本文)。若这会干扰你维护的「非 WS 文档份数」台账(当前 57 份),请告知,我可以删。`verify.ts:4138` 只 `pass()` 不比对 README,所以**不会变红**,只会让影子数字过期。
9. **`WS-03::BLUEPRINT_SIZE` 修复后单独跑会报「白名单失真」** —— 这是**预期**的,因为摘除权在你。你已摘除,现该条不再失真。
10. **`WS-10::MAX_DODGE_RATE` 我没动。** 理由:不在我写域(WS-10 归 `combat-progress`)。它同时出现在「未登记候选」列表里,且该文件注释自述「原断言是空断言,已修」⇒ 疑似还有第二处未改干净。我把线索交给 Lead 转办,不越权修改。
11. **门禁的「临时残留」告警里 2xx 个文件,我只认领 93 个 `_tp89_*`。** 理由:其余是别人的(`_argcheck.ts`、`_ic_q*.ts`、`_bl.txt` 等),我不清楚它们的存废。我没有清理任何文件 —— 按纪律临时探针不自行删除。