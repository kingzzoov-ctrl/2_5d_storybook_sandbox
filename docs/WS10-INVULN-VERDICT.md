# WS-10 无敌/复活死实现裁决(task-64)

> 定性人:`combat-progress`(WS-10 owner) · 2026-11-13 · **只读任务,未改任何实现**
>
> ⚠️ 本文件的每条结论都附**命令 + 原始输出**。推理不算证据。

---

## 0. 结论速览

| # | 问题 | 结论 |
|---|---|---|
| **A** | `revive.ts` 三件套裁决 | **保留 + 显式标注为死**(CR-19 选项 2)。**但不是因为「删除要动断言」** —— 见 §3 的反驳 |
| **B** | 三条测死函数的断言 | **是「欠账」,不是「守实现」。** 实证:把活路径改回坏的,套件仍 **94/94 全绿** ⇒ 那三条**从未守过任何东西** |
| **C1** | `featherRevive`(733) | **情形 2:设计上该有但漏了**(证据最强:冻结层 note 原文写明了行为) |
| **C2** | `flagRevive`(435) | **情形 2**(复活行为漏接) + **情形 3 部分成立**(该道具的计分/出生旗用途已被 `party/scoring.ts` 取代) |
| **C3** | `bubbleGunHit`(227) | **情形 2**。看起来的「取代者」`prank/toys.ts` **自己就不可达** ⇒ 不能算取代。227 的**灭火半边是活的**(`interactMob`) |

**额外发现(Lead 任务书未列):**
- 同族死符号还有 **5 个**:`ghostControl` / `ghostDamageMul` / `snapshotDiff` / `revivePlayer` / 消耗品字段 `reviveRange`·`reviveFullHp`
- **幽灵泡泡的三条硬规则有两条在生产里根本不存在**(不能移动 / 不能攻击)—— 这是**玩法缺陷**,不是死代码
- build-wiring 已落地的注释里有 **4 处行号引用过期**(陷阱 27)

---

## 1. 先纠 Lead 任务书的四处

### 1.1 ★ 事实 #3 已过时 —— 任务书写的「复活后零无敌帧」现在不成立了

任务书 §实测事实 3 写:

```
world_sim.ts:1951  this.downedStates.delete(id)
vitals.ts:347      v.iframeSec = 0;      ← **显式清零**
⇒ ★★ **复活后零无敌帧**
```

**这是 build-wiring 在我开工前 1 分钟改掉的。** 文件时间戳:

```
server/src/combat/vitals.ts        c12b7a5b36d47f62  mtime=2026-11-12T16:49:42Z
server/src/sim/world_sim.ts       6252544fc762f332  mtime=2026-11-12T16:49:55Z
tests/WS-10.test.ts               393c3c0b7ecb9a16  mtime=2026-11-12T16:10:16Z
```

`vitals.ts` / `world_sim.ts` 在 **16:49** 被改,而我的任务开始时是 **16:50**。当前代码:

```
vitals.ts:360   revive(id: string, hp?: number, invulnSec = 0): boolean {
vitals.ts:365     v.iframeSec = Math.max(0, invulnSec);      ← 不再是无条件 0

world_sim.ts:1957  this.vitals.revive(id, out.result.hpAfter, out.result.invulnSec);
```

**运行时实测(修后)**:

```
复活瞬间 iframeSec=0.500
复活后第 1 拳:raw=6 applied=0 blockedByIframe=true
⇒ ★ 无敌生效(被 iframe 挡掉)
```

**⚠️ 但请 Lead 注意一个更严重的问题:这个修法目前没有任何断言守着。** 见 §4.2。

### 1.2 事实 #1「`isInvulnerable` 0 读者」为真,但要排除一个假阳性

用**调用语法 + 块注释遮罩**扫描(见 `_v64_precise.ts` 的实现),`isInvulnerable` 生产调用 **0 处**。朴素的行检索会报「1 处」,那是 `world_sim.ts:1954` 的注释续行(`而**读那个字段的 isInvulnerable() 生产 0 调用**`)。

### 1.3 build-wiring 落地的注释里有 4 处**行号引用过期**(陷阱 27)

```
引用                            实际内容
revive.ts:82   vitals.ts:397   L397 = "const base: MobHitResult = {"   ← 不是判定行
revive.ts:359  vitals.ts:397   真正的 if (v.iframeSec > 0) 在 L415
revive.ts:360  vitals.ts:444   L444 = 治疗函数;真正的递减在 L462
vitals.ts:353  world_sim.ts:2718  真正的 iframeSec 过滤在 L2725
```

同一份注释还说 `vitals.ts:444 stepTimers() 每帧递减`,而 `stepTimers` 实际在 L462。

**这不算致命**(读者跟着函数名能找到),但它违反本仓那条纪律:**「门禁/注释里印的每个坐标都在断言事实,措辞与数字必须同口径」**。建议 Lead 让 build-wiring 把这 4 个行号改成**函数名锚点**(`applyHit` 的 `if (v.iframeSec > 0)`),不再用行号 —— 行号会随任何上游插入漂移。

### 1.4 一处**语义混淆**(不是错,但要说清)

注释写「实测:复活后第 1 拳 `applied` 由 **14** → 0」。我按同一语义复现得到的是 `raw=6 applied=0`,因为 `applyHit` 的伤害由 `mobHitDamage(level, mul)` 算,我传的是 `level=1, mul=1.0`。

**14 与 6 都是对的,只是输入不同。** 我把确切 replex 写进 §7 附录,任何人可逐字复现。**建议注释里带上输入参数**,否则这个数字不可复现。

---

## 2. 「无敌」在本仓有**三套**实现,不止两套

任务书说「两套」。实测是**三套**,数值与语义各不相同:

| # | 实现 | 字段 | 数值 | 生产状态 | 语义 |
|---|---|---|---|---|---|
| 1 | `revive.ts` | `DownedState.invulnSec` | `MANUAL_REVIVE_INVULN=0.5` / `FEATHER_INVULN=3.0` / `BUBBLE_TRAP_SEC=5.0` | **死**(0 读者) | 倒地/复活状态机上的**计划值** |
| 2 | `vitals.ts` | `Vitals.iframeSec` | `PLAYER_IFRAME_SEC=0.35` | **活** | 受击后 i-frame |
| 3 | `weapons.ts:567` | `CombatConsumableDef.invulnSec` | `733 → 3.0` | **死**(0 读者) | 消耗品表上的**计划值** |

第 3 套是我这次新发现的。`reviveRange` / `reviveFullHp` 同样只被「定义处 + 1 条测试」提到:

```
reviveRange:
  生产:combat/weapons.ts:567, combat/weapons.ts:577, combat/weapons.ts:583
  测试:WS-10.test.ts:892
  ⇒ ★ 只有定义,零读者(定义处之外)
reviveFullHp:
  生产:combat/weapons.ts:568, combat/weapons.ts:577, combat/weapons.ts:583
  测试:WS-10.test.ts:894
  ⇒ ★ 只有定义,零读者(定义处之外)
```

**⇒ 所以「无敌」这个概念在本仓有 3 份声明,只有 1 份生效。** 这与 CR-19(`crystalArmor`/`shield`)是同族第 **三**、**四** 例,不是第三例。

---

## 3. A 裁决:`invulnSec` / `tickInvuln` / `isInvulnerable`

### 3.1 结论:**保留 + 显式标注为死**(CR-19 选项 2)

但我要**反驳 Lead 给的两条理由**,因为它们是错的,而错的理由会让下一个做同样裁决的人踩坑:

> Lead 原文:「删它要动 WS-10 的断言;接活它要改语义(全向 vs 定向无敌是玩法问题)」

**反驳一:「删它要动断言」不构成理由。**
断言测的是死函数(§4 已证)。**改/删一条测死代码的断言,成本是零风险** —— 因为它守的东西本来就不存在。用「会动断言」来否决删除,等于让断言反过来绑住实现。**正确的成本论证是:删它会丢掉「复活宽限无敌」这个设计意图的唯一代码载体。**

**反驳二:「全向 vs 定向」这个说法在本仓不成立。**
`isInvulnerable(downed)` 的签名只收 `DownedState`,**没有朝向、没有攻击者、没有伤害来源**。它连「定向」的信息都装不下 —— 所以「接活它会退化成全向」是**对签名的事实性误读**。将来若要做定向无敌,`isInvulnerable` 这个签名必须改,与「接活」与否无关。

### 3.2 真正的理由(三条)

1. **它是设计意图的唯一载体。** `MANUAL_REVIVE_INVULN` / `FEATHER_INVULN` 这两个常量在冻结层有定义(见 §5.1),删掉 `invulnSec` 会让这两个常量失去落脚点。
2. **它是 `featherRevive`/`flagRevive` 接线时的复用点**(见 §5)。删了以后接那两条要重写一遍递减逻辑。
3. **⚠️ 但它必须标注「死的」,而且标注要能通过一个可执行的检查。** 现状的注释是**纯文本**,没有任何门禁能发现它何时变成假话 —— 一旦将来有人真把它接活,注释就成了谎言。**建议:注释里加一个 `@dead-prod-calls 0` 标记,并让 `verify.ts` 扫这个标记**(这是 Lead 写域,我只提建议)。

### 3.3 我不建议「接活」

因为它**已经被绕过了**,而且绕得对:`iframeSec` 是受击判定的真实入口,复活宽限写进它才生效。若把 `tickInvuln`/`isInvulnerable` 也接上,就会变成**两套无敌同时生效**,需要裁决「谁覆盖谁」—— 那才是真的改语义、真的动玩法。

---

## 4. B 核心:一条断言测生产零调用的函数,算「守实现」还是「欠账」?

### 4.1 判据(可复用)

**判据名:「活路径优先」(Live-Path-Advantage, LPA)**

> 一条断言若断言在**生产零调用**的符号上,它**不是「守实现」,而是「欠账」** ——
> 当且仅当 **它所声称守护的那条用户可见保证,在别处有活的实现**。
>
> 理由:此时该断言**产出了虚假的覆盖证据**。它让「复活后有宽限无敌」看起来被测过了,
> 而真正的实现换行代码就能坏掉,门禁一声不吭。
> **这种断言比不写更糟** —— 不写至少不会骗人。

反过来,**它可以是合法的「未来规格」**,当且仅当:
- 该保证在生产里**确实不存在活的实现**(功能真的没做),**且**
- 断言所属 test 的名字**显式标注「未接线」**,**且**
- 套件的「断言数」统计**不把它算进覆盖率**(否则就是拿规格冒充满分)。

### 4.2 判据的可执行形式(这是重点)

抽象判据不能验收。**可执行的判别实验只有一个:**

> **把「活的那套」改回坏的行为,重跑套件。
> 若套件仍全绿 ⇒ 这些断言是欠账(它们没在守那条保证)。
> 若变红 ⇒ 它们是守实现(只是恰好守在了死符号上,应当改指向)。**

### 4.3 我跑的就是这个实验(内存 patch,不写文件)

手法:`VitalsSystem.prototype.revive` 在内存里还原成旧行为 `v.iframeSec = 0`,然后**动态 import 真正的 `tests/WS-10.test.ts`**。ESM 按 URL 缓存模块实例,测试拿到的就是我 patch 过的同一个 `vitals`。

```
══ 1 patch 前(当前实现)==
  复活瞬间 iframeSec=0.5
  复活后第 1 拳:raw=6 applied=0 blockedByIframe=true
  ⇒ ★ 无敌生效(被 iframe 挡掉)

══ 2 内存 patch:还原成旧行为(`iframeSec = 0`)══
  复活瞬间 iframeSec=0
  复活后第 1 拳:raw=6 applied=6 blockedByIframe=false
  ⇒ ★ 无敌被抹掉 —— 复活后立刻吃满伤害

══ 3 ★ 在②的破坏仍生效时,跑真正的 tests/WS-10.test.ts ══
   ...
[WS-10] 94/94 通过
   ⇒ 套件已跑完

   复原复核:applied=0 blocked=true(应 0/true)
```

### 4.4 结论

**生产行为已坏(复活后 0 无敌帧,第一拳吃满 6 点伤害),而 WS-10 是 94/94 全绿。**

⇒ 那三条断言(以及全文件所有 `invuln` 相关断言)**不是「守实现」,是「欠账」**。它们测的是一个没人调用的函数,而真正生效的那套**一行都没被断言覆盖**。

支撑数据(穷举):

```
测试文件里 "iframeSec" 出现 0 处
测试文件里 ".applied" 出现 0 处
测试文件里 "blockedByIframe / applyHit" 出现 0 处
⇒ ★ 活的那套(iframeSec)在整个 WS-10 里**完全没有断言覆盖**
```

### 4.5 逐条裁决那三条(以及顺带的两条)

| 行 | 断言 | 所在 test | 是否生产路径 | 裁决 |
|---|---|---|---|---|
| L1777 | `s = tickInvuln(s, 1.0)` | 733 羽毛笔 | ✗ 纯函数 | **改**:连同 1778/1779/1780 一起,改为测 `vitals.iframeSec` |
| L1779 | `s = tickInvuln(s, 2.0)` | 733 羽毛笔 | ✗ 纯函数 | 同上 |
| L1781 | `eq(isInvulnerable(s), false, ...)` | 733 羽毛笔 | ✗ 纯函数 | **改**:改测复活宽限到期后 `applyHit` 的 `applied > 0` |
| L1773 | `eq(isInvulnerable(okRange.downed), true, ...)` | 733 羽毛笔 | ✗ 纯函数 | **改**:改测 `result.invulnSec` 是否被写进 `iframeSec` |
| L1738 | `eq(s3.downed.invulnSec, BUBBLE_TRAP_SEC, ...)` | 227 水枪 | ✗ 纯函数 | **保留但降级**:它是 `bubbleGunHit` 的死规格,等 §5.3 接线后才有意义 |
| L893 | `eq(c733.invulnSec, FEATHER_INVULN, ...)` | 733 数值 | ✗ 纯函数 | **保留**:这是「消耗品表与冻结层一致」的字面量守卫,与死代码无关 |

**L1735/1737 提到的 `consumeItem` 顺带核实结果:**
`consumeItem` 全仓只有 1 处,在 `db/repo.ts:624`(`export function consumeItem`),**0 生产调用者**。它与 `revive.ts` 无关,属另一条已登记项,我未改动。

### 4.6 建议加的**唯一**一条新断言(不改,只列 —— 待 Lead 派工)

这是本次最重要的产出。它必须满足 §4.2 的判别实验:改坏活路径 ⇒ 变红。

```
// 建议插入 WS-10,紧邻现有「task44-7 复活后泡泡清除」块
test('task64-1:复活后宽限无敌写进活字段 iframeSec(不是 downedStates.invulnSec)', () => {
  const { s } = reviveScenario();          // 现有 helper,见 WS-10 L2276 那个
  ok(s.lastRevive !== null, '前置:复活发生了');
  eq(s.vitals.get('p1')!.iframeSec, MANUAL_REVIVE_INVULN,
     '前置:宽限无敌落在 vitals.iframeSec 上');
  s.vitals.beginFrame();                   // ← 必须:否则测的是同帧去重不是无敌
  const h = s.vitals.applyHit('mob_lava_elem', 'p1', 1, 1.0, 0);
  eq(h.applied, 0, '复活后第一拳被无敌挡掉');
  eq(h.blockedByIframe, true, '挡掉的原因是 iframe(不是其它早退)');
  // 到期后必须真的失效 —— 否则「永久无敌」这个方向重新出现
  for (let i = 0; i < 16; i += 1) s.tick();
  s.vitals.beginFrame();
  ok(s.vitals.applyHit('mob_lava_elem', 'p1', 1, 1.0, 0).applied > 0,
     '宽限到期后正常受击(证明它不是永久无敌)');
});
```

**两个易踩的坑(我踩过,写在这里):**
1. **`beginFrame()` 必须调**。不调的话 `hitThisFrame` 去重会让 `applied=0`,**看起来像无敌生效**,实际测的是去重。我第一版就错在这里。
2. **`applyHit` 签名是 `(attackerId, playerId, level: number, mul, distance)`**,第 3 参是数字不是对象。我第一版传了对象 ⇒ `mobHitDamage(对象)` = `NaN` ⇒ `applied=NaN`,得出了「无敌仍在」的**假结论**。

---

## 5. C 三条死复活途径的定性

### 5.1 三件道具在冻结层**都存在且有配方**

```
227 泡泡连发水枪: ✓ 存在  category=P  recipe={103:2, 162:1}  station=505
    note: '扑灭高炉火苗、浇灭火灵护盾;连射队友 3 发将其装进大泡泡随风乱飘。'
733 复苏天使羽毛笔: ✓ 存在  category=C  recipe={119:2, 130:1}  station=505
    note: '扔向变成"幽灵泡泡"倒地的队友,哪怕隔着 6 格远也能瞬间将其满血复活并赋予 3 秒无敌。'
435 四色队伍出生复活旗: ✓ 存在  category=A  recipe={151:2, 161:2}  station=502
    note: '可切换红/蓝/黄/绿四队归属,比赛或 Boss 战期间倒地的玩家可在旗帜旁复活。'
```

冻结层还给了**专用常量**:

```
REVIVE_TIME          = 1.0
REVIVE_HP_RATIO      = 0.5
FEATHER_RANGE        = 6        ← 只有羽毛笔有
FEATHER_INVULN       = 3.0      ← 只有羽毛笔有
GHOST_BUBBLE_MAX_SEC = (未定义)
```

**⇒ 冻结层为羽毛笔专门定义了距离与无敌秒数,却对旗点复活没有任何定义。** 这是 C1 与 C2 定性不同的**直接依据**。

### 5.2 C1 `featherRevive`(733)= **情形 2:设计上该有但漏了**

证据链(三层,互相独立):

1. **冻结层 note 原文写明了完整行为**(6 格 + 满血 + 3 秒无敌)—— 这不是模糊愿景,是可验收的规格。
2. **两个专用常量 `FEATHER_RANGE`/`FEATHER_INVULN` 只为它存在**。
3. **消耗品表已完整登记,但字段零读者**:
```
weapons.ts:582  id: 733, name: itemName(733), kind: ConsumableKind.REVIVE_ITEM, healHp: 0, cooldownSec: 12,
weapons.ts:583  splashRadius: 0, splashHeal: 0, reviveRange: 6, reviveFullHp: true, invulnSec: 3.0,
                tossable: true,
                note: '扔向 6 格内的幽灵泡泡队友,满血复活并赋予 3 秒无敌。',
```
   而 `reviveRange`/`reviveFullHp` 生产读者 **0 处**(§2 已列)。

4. **`revive.ts` 的函数本身行为正确**(实测):
```
featherRevive(3格)  = revived=true method=FEATHER hp=100 invuln=3 reason=ok
featherRevive(7格)  = revived=false reason=距离 7 > 6 格
```
```
733 / REVIVE_ITEM 在其它生产文件:0 处
```

⇒ **规格齐、常量齐、表齐、函数对,只差一层调用。这是「漏接」,不是「没到」。**

### 5.3 C2 `flagRevive`(435)= **情形 2(复活漏接)+ 情形 3 部分成立**

**情形 3 部分成立**:435 在别的路径上**是活的**,但做的是别的事:

```
party/modes.ts:209        export const BRIDGE_FLAG_ITEM_ID = 435;
party/scoring.ts:50       export const SPAWN_FLAG_ITEM_ID = 435;
wiring/components.ts:231  S(435, 'ARENA_TEAM_BANNER', '四色队伍出生复活旗', ComponentGroup.ARENA_CORE, [], { team: 0 }),
```

**情形 2 也成立**:note 明写「倒地的玩家可在旗帜旁复活」,而 `flagRevive` 生产 0 调用。

**为什么比 C1 弱**:`FLAG_REVIVE_TIME=2.0` / `FLAG_REVIVE_RADIUS=3.0` **不在冻结层**,是 `revive.ts` 自己发明的。冻结层对这一行为没有数值承诺。

⇒ **裁决:复活行为属漏接;但「435 = 复活旗」这个身份在本版已被计分/装饰用途占用。若要接线,先要裁决它是否应该同时承担两种身份。** 这是玩法问题,不是代码问题 —— 建议 Lead 另立 CR。

### 5.4 C3 `bubbleGunHit`(227)= **情形 2**,不是情形 3

**看起来像情形 3**:`prank/toys.ts:129` 有一份等效的数据登记:

```
id: 227, name: '', trigger: TOY_TRIGGER.HELD, radius: 5.0, impulse: 0, stunSec: 0, morphSec: 6,
allyEffect: { flag: TOY_STATE_FLAG.BUBBLED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false,
              note: '连射队友 3 发装进大泡泡随风乱飘;扑灭高炉火苗只需持续 0.5 秒。' },
```

**但我做了陷阱 31 的自查 —— 取代者本身是活的吗?**

```
══ prank/ 各文件的 import 者 ══
  prank/immunity.ts        ← 无
  prank/toys.ts            ← prank/immunity.ts

══ prank/immunity.ts 自身是否可达?(逐级追)══
  起点:prank/immunity.ts
    深度 1: (无)
  ⇒ 从 prank/immunity.ts 反向可达 1 个文件
```

`verify.ts` 白名单确认了这一点:

```
['server/src/prank/immunity.ts',
 'WS-11 整蛊免疫,等施加整蛊的宿主(与 toys.ts 同一个);'
['server/src/prank/toys.ts', 'WS-11 玩具,等施加整蛊的宿主(与 immunity.ts 同一个)'],
```

**⇒ 「取代者」`prank/toys.ts` 自身不可达(PROD_ENTRIES 里没有它的宿主)。它不能算作取代 —— 一份死实现不能取代另一份死实现。**

补充:`BUBBLED` 这个 `BodyState` 的生产写入点在**全仓只有 1 处**,就在死的 `bubbleGunHit` 里:

```
combat/revive.ts:257: downed: { ...downed, bubbleStacks: 0, state: BodyState.BUBBLED, invulnSec: BUBBLE_TRAP_SEC }
prank/toys.ts:51:     BUBBLED: 'BUBBLED',
```

⇒ **`BUBBLED` 状态在生产里从未被进入过。**

**但 227 有一半是活的**:灭火/破盾走 `interactMob`,实测 `interactMob('mob_lava_elem', 227, 'p1') = true`。

⇒ **裁决:227 的「灭火」半边活(经 `interactMob`),「困人」半边漏接。属情形 2,且是「部分接线」。**

### 5.5 C 的结论矩阵

| 道具 | 冻结层定义 | 专用常量 | 动作函数 | 其它活用途 | 取代者可达? | 定性 |
|---|---|---|---|---|---|---|
| **227** | ✓ note 写明 | ✗ | 死 | ✓ 灭火/破盾(`interactMob`) | ✗ `prank/toys.ts` 不可达 | **情形 2(困人半边漏接)** |
| **733** | ✓ note 写明 | ✓ `FEATHER_RANGE`/`FEATHER_INVULN` | 死 | ✗ 消耗品表字段全无读者 | — | **情形 2(证据最强)** |
| **435** | ✓ note 写明 | ✗ 常量在 revive.ts 自定 | 死 | ✓ 计分/出生旗/电路件 | 部分(不同用途) | **情形 2 + 情形 3 部分** |

---

## 6. 额外发现(Lead 未列,但同族同严重)

### 6.1 幽灵泡泡的三条硬规则,生产里**只实现了一条**

`revive.ts` 头注释写:

```
· 幽灵泡泡期间免伤(伤害乘区 0),但不能移动、不能攻击、不能被治疗。
```

`ghostControl` / `ghostDamageMul` 都是死的(0 调用)。那么这三条谁兑现?实测:

| 规则 | 生产实现 | 实测 |
|---|---|---|
| 免伤 | ✓ `vitals.ts:407 if (v.downed) return base;` | `倒地时 hp=0 再挨一拳:raw=6 applied=0` ✓ |
| 不能被治疗 | ✓ `vitals.ts:442 if (v.downed) return 0;` | ✓(静态可证) |
| **不能移动** | **✗ 无** | `downed=true, applyPlayerMove('p1', 32, 32) 返回=true,(24,24)→(32,32)` ⇒ **能移动** |
| **不能攻击** | **✗ 无** | `attackMob` 函数体内**无 downed 检查** |

⇒ **「幽灵泡泡期间不能移动/不能攻击」在生产里没有实现。** 这不是死代码问题,是**玩法缺陷**:
- 倒地玩家可被任意传送
- 倒地玩家可以照常打怪拿经验/掉落

**建议 Lead 单独立 CR。** 这条比 `comboMul` 更接近「玩家可见」。

### 6.2 `revivePlayer` 也是一条死复活途径(`world_sim.ts:2404`)

```
revivePlayer 生产调用点 1 处:
    sim/world_sim.ts:2404: revivePlayer(id: string, hp?: number): boolean {
```

那 1 处是它自己的定义 —— **真调用 0 处**。它是第四条死复活途径,且**不传 `invulnSec`**(默认 0)。语义上它是「重新导入 HP / 管理重置」,不是「倒地复活」,所以不给无敌帧是对的。**但它是死的,应予标注。**

### 6.3 `iframeSec` 现在承载**两种语义**

```
写入者 3 处:
  vitals.ts:365  v.iframeSec = Math.max(0, invulnSec);     ← 复活宽限(0.5 / 3.0)
  vitals.ts:422  v.iframeSec = PLAYER_IFRAME_SEC;          ← 受击 i-frame(0.35)
  vitals.ts:459  v.iframeSec = 0;                          ← 倒地时清零
⇒ ★ 同一字段承载两种语义:受击 i-frame(0.35)与复活宽限(0.5/3.0)
```

**这不是 bug**(我找不到反例;`applyHit` 在 `iframeSec > 0` 时早退,不会用 0.35 覆盖 3.0),**但它是一个隐患**:将来若有人要「受击 i-frame 不吃复活宽限」或反之,得先拆这个字段。**建议在 `Vitals.iframeSec` 的字段注释里显式写明它有双重用途。**

---

## 7. 我能证明的 vs 我不能证明的

### 能证明(附命令)

| 结论 | 证据 |
|---|---|
| 8 个符号生产调用 0 处 | `_v64_precise.ts`:调用语法 + 块注释遮罩的逐字符扫描 |
| `revive.ts` 三件套死 | 同上;`isInvulnerable` 那 1 处是注释续行,已排除 |
| 复活后宽限无敌**已生效** | `_v64_runtime.ts`:复活瞬间 `iframeSec=0.5`,第 1 拳 `applied=0 blockedByIframe=true` |
| 宽限**会到期**(非永久) | `_v64_expire.ts`:第 2/6 帧 `0.500`,第 10 帧 `0.000` |
| **活路径无断言覆盖** | `_v64_unguarded2.ts`:把 `revive` 改回 `iframeSec=0` ⇒ 套件仍 **94/94** |
| WS-10 里 `iframeSec` 出现 **0** 次 | `_v64_cover2.ts` |
| 三件道具在冻结层存在 | `_v64_c.ts`:逐 ID 提取定义 |
| `reviveRange`/`reviveFullHp` 零读者 | `_v64_final.ts` |
| `prank/immunity.ts` 无 import 者 | `_v64_fix2.ts`:反向 import 图,深度 1 为空 |
| 倒地玩家可被移动 | `_v64_last.ts`:`applyPlayerMove` 返回 `true`,坐标真变 |
| `attackMob` 无 downed 检查 | `_v64_expire.ts`:函数体 60 行内无 `downed` |
| 227 灭火活、困人死 | `_v64_last.ts`:`interactMob(...,227,...) = true`;`bubbleGunHit` 0 调用 |
| 注释行号过期 4 处 | 逐行核对(§1.3) |
| 只读未改 | 三件收尾命令数字不变(§8) |

### 不能证明

1. **不能证明「旗点复活本该在本版做完」。** `docs/` 里对「羽毛笔」「复活旗」「泡泡水枪」的检索全部 **0 命中** —— 没有路线图能证明或否证。我的定性依据是**冻结层的 note 文本**,那是契约,不是排期。
2. **不能证明 `MANUAL_REVIVE_INVULN=0.5` 是好数值。** 0.5s 宽限够不够躲开第二拳,是玩法问题。我只能证明它**生效且会到期**。
3. **不能证明 `iframeSec` 的双重语义在某个场景下真的会出错。** 我找了反例没找到,所以只报「隐患」不报「缺陷」。
4. **不能证明 `ghostControl`/`ghostDamageMul` 的「不能移动/攻击」是漏接还是本版不做。** 同上,无路线图。我只能证明**它们现在没实现**,且**`revive.ts` 头注释声称实现了**。
5. **不能证明 build-wiring 的修法完整。** 它只接了 `touchRevive` 这一条路(`world_sim.ts:1957`);`featherRevive`/`flagRevive` 若将来接线,还需各自把 `result.invulnSec` 转写进 `iframeSec`,否则同样「写了没人读」。

---

## 8. 收尾:三件门禁数字未变(证明我只读)

```
$ node tests/WS-10.test.ts
[WS-10] 94/94 通过

$ node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert
  ✓ README 逐套件断言数与实测一致(12 个 WS 套件)
  ── 本节 38/38 条门禁通过 ──
全部通过 · 8916ms

$ node scripts/gate-selfcheck.ts
✓ 门禁自检全部通过(29 通过 / 29 合计)
```

与开工前一致(94/94、38/38、29/29)。**临时探针脚本 `_v64_*.ts` 全部删除,无残留。**

### 8.1 ⚠️ 期间一次短暂的 `gate-selfcheck` 假红 —— 已定位为**同行者的残留文件**,与本任务无关

我做到第 60 步时,`gate-selfcheck` 一次从 **29/29 掉到 28/29**:

```
[T35] 「判据形态审计」接线是否有牙(注入 1 处新命中必须红)
  注入前:exit=1 新增=2
  注入后:exit=1 新增=3 列出位置=✓
  ⇒ ✗✗ 注入前就有新增 ⇒ 登记表已不全,本条的对照不成立
```

- `verify.ts --all` 当时**仍报自身 38/38 通过**,所以这不是我的改动破坏的
- 我造了副本探针顺序复现,定位到:审计扫描根内存在 `scripts/_cp_cn.ts`(01:25:54 落地的**他人**探针,内容是「独立复核 Lead 关于 client 的三组数字」)

**因果证明(在 `%TEMP%` 副本里做,真仓库未动):**

```
lab = C:\...\Temp\cp_selflab_1gJcsO
残留存在 = true
已从副本删除 scripts/_cp_cn.ts
  [T35] 注入前:exit=0 新增=0
  [T35] 注入后:exit=1 新增=1 列出位置=✓
  ⇒ ✓ 有牙
  ✓ 门禁自检全部通过(29 通过 / 29 合计)
```

⇒ **只删那一个文件,29/29 立即恢复。** 该文件随后被其 owner 自行清理,现仓库已无残留,复核为 29/29。

**这正是 `verify.ts` 自己在注释里警告过的那件事**(L2482-2484):

> 残留落在**审计扫描根之内**(`scripts/` / `tests/` / `server/src/` / `client/src/` / `shared/`)时,
> 它会**污染别的门禁**,那时就不只是"脏",而是**假红**(狼来了 ⇒ 门禁失效)。

**⇒ 建议 Lead 记一条:并行作业时,任何 `scripts/` 下的临时探针都必须在**下一道门禁跑之前**删除。**
本仓已有 `node scripts/clean-temp.ts`;可以考虑让 `verify.ts` 在扫到这个条件时**直接点名文件**,
而不是只报「注入前就有新增」—— 后者的措辞会让人以为登记表坏了,而真凶是别人桌面上的一张草稿纸。

---

## 9. 建议 Lead 的下一步派工顺序

1. **先**给 build-wiring 派「补断言」任务(§4.6 那段),**不要**先让它改别的 ——它现在的修法**没有任何门禁守着**,任何后续改动都可能静默回退。
2. **再**让它修 4 处注释行号(§1.3),改成函数名锚点。
3. **然后**才轮到 A 的标注落地(`revive.ts` 三件套)。
4. **C1(733)可接线** —— 证据最充分,且 `featherRevive` 行为已验证正确,只差一层调用。
5. **C2(435)/C3(227)需先裁决玩法身份**,不要直接接线。
6. **§6.1(倒地可移动/可攻击)单独立 CR** —— 玩家可见,优先级高于上述全部。

---

## 附录:逐字复现命令

```powershell
cd 2_5d_sandbox
node _v64_precise.ts   "<ABS>/2_5d_sandbox"  # ★ 调用语法+块注释遮罩,判死符号(最可信)
node _v64_runtime.ts   "<ABS>/2_5d_sandbox"  # 复活→挨打 实测
node _v64_unguarded2.ts "<ABS>/2_5d_sandbox" # ★ 决定性:改坏活路径仍 94/94
node _v64_cover2.ts    "<ABS>/2_5d_sandbox"  # 断言覆盖面
node _v64_c.ts         "<ABS>/2_5d_sandbox"  # 三件道具定义
node _v64_final.ts     "<ABS>/2_5d_sandbox"  # 消耗品死字段
node _v64_fix2.ts      "<ABS>/2_5d_sandbox"  # prank 可达性(陷阱 31 自查)
node _v64_expire.ts    "<ABS>/2_5d_sandbox"  # 宽限到期 + attackMob 无 downed
```

> 这 8 个脚本是我造的探针,**已删除**。上面的命令行是它们各自做的事,不是可重跑的文件。
> 若需重跑,§4.3 / §4.6 给了完整做法;两个最关键的技术点:
> 1. **`_v64_unguarded2.ts` 之所以成立**,是因为 ESM 按 URL 缓存模块实例 ——
>    在内存里 patch `VitalsSystem.prototype.revive`,测试 import 到的就是同一个实例。
> 2. **`_v64_precise.ts` 之所以必要**,是因为按行过滤注释会把块注释的**续行**(不以 `*` 开头)
>    当成代码,`isInvulnerable` 会被误报成「1 处调用」。