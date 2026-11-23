# 目标

把 `docs/COMPLETION-CRITERIA.md` §六「立项建议(按依赖顺序)」的**序 1–5** 做完,多线并行推进;每条都留下**能被机器判红**的断言,并把门禁数字与文档同步到实测值。

> 序 6(料理 buff 数值 / 三件死道具 / 9 种房间增益的**数值与平衡**)属产品裁决,不在本次范围 —— 见「边界」。

## 现状基线(本次只读实测,2026-11-14)

```
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck
  ⇒ 全部通过 · 行首 ✗ 0 项 · 267.7~279.2s · 用例 1526 / 28 套件 · 可达性 88/98 · 自检 31/31
HEAD 8678abf · 工作区有 8 个改动文件 + 2 个未跟踪文档 · 未 commit · 未 push
```

★ **两处必须当场重测的旧数字**(文档已过期,不得据它施工):
- `COMPLETION-CRITERIA.md` §一说「client 侧 13 个网络关键字逐个 grep 全 0 处」——**已不成立**。
  实测:`client/src/net/session.ts`(15.6 KB)已存在且被引用 **3 处**,`main.ts:32` 已提及,
  `WebSocket` 在 client/src 出现 **14 处**、`new WebSocket` 1 处、`ws://` 2 处。
- `prediction.ts` **仍是 0 个生产引用**(唯一还挂着「等客户端网络层」理由的白名单条目)。

## 要达成的结果

### G1 基础设施不回退(所有线的前提)
`node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck`
⇒ **exit 0 / 行首 ✗ 0 项 / 自检全过**;`node scripts/gate-selfcheck.ts` ⇒ **全部通过**;
生产可达性分母仍为 **98**;`node scripts/backlog.ts` 报 **0 过时条目**。

### G2 幽灵泡泡规则 3/4(§六 序 2)
`vitals.ts:407` 免伤与 `:442` 不能治疗是既有样板;补齐:
- **不能移动**:倒地玩家的位移意图被**显式拒绝**(返回可判定的拒绝 + 理由,不静默返回 true)
- **不能攻击**:倒地玩家的攻击被**显式拒绝**(同上)
- 必须**复用**已有的倒地真值来源,不许新写第二套判定
- 断言落在 `tests/WS-10.test.ts`,且**负对照**(健在玩家同一动作仍允许)必须在内

### G3 生产入口可加载性(§六 序 3)
`docs/TASK-95-entry-loadability.md` 已给出三重阻塞与两条方案的代价。达成:
- `node -e "import('./server/src/net/room.colyseus.ts')"` 打印 **LOADED**
- `server/src/net/schema.colyseus.ts` 的行首 `@type(` 计数 = **0**(44 处装饰器被零依赖替代消除;
  字段名与类型标注语义不变,字段总数不变)
- `registerHandlers()` 有 **≥1 个真实调用点**(现在全仓 0 处)
- `scripts/entry_load_exempt.ts` 里 `room.colyseus.ts` 那条豁免**摘掉**;
  连带更新 `DECORATOR_EXEMPT` 与 README 的 `装饰器例外 N 处` 自称
- **零新增运行时依赖**;不引入构建步骤

### G4 动作执行层(§六 序 3)
`docs/TASK-94-action-layer-landing-plan.md` §五 给了最小切口(5 个动作、宿主已存在、不改可达性):
- 至少这 5 个动作有**真实执行路径**:`SET_MEMBER_ROLE` / `KICK_MEMBER` / `SET_ROOM_ACCESS` /
  `SET_PARTY_MODE` / `CLOSE_ROOM`
- **静默成功必须被消灭**:`allowed === true` 时不再"零执行零回执" —— 成功与失败都要有可观测回执
- `scripts/verify.ts` 的 `VERDICT_HANDLER_KNOWN` 登记随之更新(那条登记自己写着
  「若已加成功执行,应移出登记并记为已修」)
- 断言走新分派器的**行为**(`tests/WS-07.test.ts` 已 `import { RoomAction }`),含 GUEST 负对照

### G5 第五层:5 条裁决落地(§六 序 3 的前提)
`docs/ARCH-GAPS.md:636-644` 的 5 条未决,每条给出**明文裁决 + 理由 + 判据化**:
1. `maxHp` 以 `vitals` 常量还是 `progression` 等级派生为准
2. `room.PlayerState.level` 无写者 ⇒ 删字段还是补写者
3. 8 个交集字段的同步方向(单向投影 vs 双向)
4. **W1 的钳加在哪一侧**(`revive` 侧或 `vitals` 侧)——⚠️ 两侧都加会重演「两份实现」
5. `mobHitDamage` 加钳的阈值口径(不许硬编码 30)
每条裁决必须有**一条会红的断言**钉住(不接受只写在文档里)。

### G6 复活宽限的门禁断言(§六 序 4)
把 patch `iframeSec` 回坏(退回缺陷态)⇒ **测试必须红**。现在实测「patch 回坏后 WS-10 94/94 仍全绿」
⇒ 该机制目前**无名**。

### G7 客户端联机层(§六 序 1,关键路径)
- 先**重测**当前真实状态(`session.ts` / `state_store.ts` / `main.ts` 接了什么、缺什么),结论落文档
- 把 `prediction.ts` 从「0 生产引用」接上(它是**已有资产**,不得重写);接上后
  `verify.ts` 的不可达白名单要同步摘条目、README 的 88/98 与白名单条数同步
- 至少**一条端到端断言**:node 侧起服务端 → 客户端网络模块完成一次 join/hello 往返 → 收到快照
  (可用宿主已有的 `server/src/net/ws_server.ts` 路径)

### G8 108 条未关闭台账逐条定性(§六 序 5)
每条归入三档之一:**已实现未标 / 真欠账 / 待裁**;总数校验 = 108;
`node scripts/backlog.ts` 仍报 0 过时条目;登记处与判据一致性由门禁校验。

### G9 文档与数字同步
`HANDOVER.md` / `LEAD-PLAN.md` / `PROGRESS.md`(追加陷阱,不改进历史节)/ `COMPLETION-CRITERIA.md`
的数字与**实测**一致;`HANDOVER.md` 末尾 sha256 表逐项复算通过;
`COMPLETION-CRITERIA.md` 档 B / 档 C 的勾选状态按实测更新(未达成的**不许**勾)。

## 验收判据(每条都能被机器或命令客观核验)

| # | 判据 | 核验方式 |
|:--|:---|:---|
| AC1 | 全量门禁不退化 | `node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert --strict-selfcheck` ⇒ exit 0 / 行首 ✗ 0 项 / 自检全过 |
| AC2 | 用例数**净增** | 该命令输出的「用例汇总」数 **> 1526** |
| AC3 | 可达性分母不变 | 输出含「生产可达性:可达 N / 不可达 M (共 **98**」 |
| AC4 | 自检区分力 | `node scripts/gate-selfcheck.ts` ⇒ 全部通过,且用例数 **> 31** |
| AC5 | 倒地不可移动 | 存在断言:移除该检查 ⇒ `node tests/WS-10.test.ts` **红**;健在玩家负对照仍绿 |
| AC6 | 倒地不可攻击 | 同上(独立一条断言) |
| AC7 | 入口可加载 | `node -e "import('./server/src/net/room.colyseus.ts').then(m=>console.log('LOADED'))"` ⇒ 打印 `LOADED` |
| AC8 | 装饰器归零 | `grep -c '^\s*@type(' server/src/net/schema.colyseus.ts` ⇒ **0**(且字段总数与改前一致) |
| AC9 | handler 已注册 | `grep -c registerHandlers server/src/net/room.colyseus.ts` ⇒ **≥2**(声明 + 调用) |
| AC10 | 豁免已摘 | `scripts/entry_load_exempt.ts` 不再含 `room.colyseus.ts`;`verify.ts` 入口可加载门禁 exit 0 |
| AC11 | 动作真的执行 | 新断言:5 个动作各自导致可观测状态变化;移除分派 ⇒ **红** |
| AC12 | 静默成功已消灭 | 存在断言:成功与失败**两条**回执都可观测 |
| AC13 | 5 条裁决各有一条钉住它的断言 | 5 条裁决各自有断言,逐条注入 ⇒ **红** |
| AC14 | 复活宽限有名 | patch `iframeSec` 回坏 ⇒ `node tests/WS-10.test.ts` **红** |
| AC15 | prediction 已接 | `scripts/orphan-audit.ts` 不再把 `prediction.ts` 列为 0 引用;白名单条目已摘;README 数字同步 |
| AC16 | 端到端往返 | 存在一条测试:客户端网络模块与服务端完成 join/hello 往返并收到快照,且**断言**快照字段 |
| AC17 | 台账定性完整 | 108 条逐条归档,三档合计 = 108;`node scripts/backlog.ts` ⇒ 0 过时条目 |
| AC18 | 文档哈希自洽 | `HANDOVER.md` 的 sha256 表 7 项逐项与实测一致 |
| AC19 | 无新增依赖 | `package.json` 的 `dependencies` 仍为空;新增 npm 包数 = 0 |
| AC20 | 冻结层未被动 | `node scripts/verify.ts --frozen` ⇒ 17 项全绿;`shared/**` 与 `harness.ts` 的改动清单在报告中**逐条列出**(允许 0 条) |

## 边界(不得越过)

```
1 ✗ 不改 `shared/testing/harness.ts`(承重,且它是 throw 式 —— 改语义会让 1526 条基线全部失效)
2 ✗ 不改冻结层 `shared/{types,constants,contracts}/**`;若确需兼容扩展,必须单独立项并在报告里单列
3 ✗ 不新增运行时依赖、不引入构建步骤(零依赖 + 直接跑 .ts 是本仓铁律)
4 ✗ 不 `git commit`、不 `git push`
5 ✗ 不删根级 `_*` 临时物(动之前必须 `node scripts/clean-temp.ts --dry-run` 展示影响面)
6 ✗ 不动 `_vss_restore/`(只读留档)、`_design/`、`_probe_sandbox/`
7 ✗ 不重写 `client/src/net/prediction.ts`(已有 457 行资产)
8 ✗ 不改历史记录:`docs/ADVERSARIAL-REVIEW-*.md`、`PROGRESS.md` 的既有节(只能追加)
9 ✗ 序 6 的产品数值与平衡(料理 buff 数值、三件死道具的去留、9 种房间增益的数值)不做 —— 需 owner 裁决;
   本次只把它们**判据化**(把"缺消费点"写成会红的断言),不定数值
10 ✗ 不用通配符删除任何文件;不用 `git checkout`/`git reset` 做"还原"(必须逐字节核对)
```

## 施工纪律(取自本仓已有判据,必须遵守)

```
· 每条新断言都要做**注入验证**:破坏它声称守护的东西 ⇒ 必须红;然后逐字节还原
· 接线类改动必须有**被打断通路的对照**(只证明"改后有变化"证明不了变化来自那条通路)
· 一条注入没红有**两种**解释(断言没牙 / 有第二份实现顶着),必须查清是哪种
· 报任何「N/N 通过」必须附**手段口径**与「看不见什么」;若是下界必须写「下界」
· 「我不知道」必须是独立且被计数的类别,不许折进默认桶
```

## 我不打算做的事(明确写出,避免误判)

- 不承诺把「档 B / 档 C」全部勾上 —— 只承诺**逐条实测后如实勾**;未达成的保持未勾并在报告里给阻塞原因
- 不承诺真机 FPS 实测(`COMPLETION-CRITERIA` §五 明确列为「从未测过」)
- 不承诺 `colyseus.js` 与 vite 8 的打包兼容性(依赖未装,且边界 3 禁止装)