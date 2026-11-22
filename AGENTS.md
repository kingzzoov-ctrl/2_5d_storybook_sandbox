# AGENTS.md —— 2.5D 绘本沙盒(项目级规则)

> 本文件是**这个项目**的规则,与 `~/.pi/agent/AGENTS.md`(全局)叠加生效;
> 冲突时本文件在**项目范围**内优先,但不得放宽全局的安全底线。
>
> **开工第一件事:读 `docs/GAME-VISION.md`。** 那份文件是北极星:
> 愿景原文、七条体验验收(V1..V7)、逐项差距、里程碑与并行车道。

---

## 0 这个项目是什么

**2.5D 精致绘本风·高自由度多人欢笑沙盒**,手机浏览器打开网址就能玩。
四条支柱:**自由造物 × 实时欢笑互坑 × 奇幻狩猎 × AI 万物炼金**。

愿景原文(105 KB,仓外):`~/Downloads/2_5d_cartoon_sandbox_plan.md`。
工程细化:`docs/LEAD-PLAN.md`;设计图:`docs/WORLD-DESIGN.md`;子系统:`docs/WS-XX-*.md`。

**判断有没有跑偏的唯一尺子是 `GAME-VISION.md` §1 的 V1..V7。**
任何一轮工作,如果它不推进其中一条,那一轮就是跑偏 —— 哪怕门禁全绿。

---

## 1 每轮的固定动作(硬规则)

**开工:**
1. 读 `docs/GAME-VISION.md` §1 与 §2.2,确定本轮推进**哪一条 V**、消掉**哪一条 G**。
2. 读相关 `docs/WS-XX-*.md` 与本文件 §4 的车道表,确认**文件所有权**(避免两个车道改同一文件)。

**收工(缺一项就算没做完):**
1. `typecheck ≤ 257`(`npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String "error TS" | Measure-Object`);
2. 相关套件全绿,**贴真实输出**(不许写"应该通过");
3. 新增/修改的判据**必须有牙**:改坏实现 ⇒ 判据变红,并留下前后对比;
4. **更新 `docs/GAME-VISION.md`**:§1 的 V 状态、§2.2 的 G 表(消掉哪条、新出哪条)、§3 的里程碑进度;
5. 改动涉及**接口**的,同轮更新 `docs/WORLD-DESIGN.md` 或对应 `WS-XX` 文档;
6. 提交(commit)按全局 `AGENTS.md` 的常设授权:本地验证通过后提交并推送;服务器另起一次同步 + 服务器侧提交。

**文档不只是给人看的**:`GAME-VISION.md` 是跨会话的**项目记忆替身**。不更新它,
下一个会话就只会看到一堆审计欠账 —— 这正是本项目此前跑偏的机制。

---

## 2 铁律(不许为了"让它过"而放宽)

- **判据常量不许改**:`TELEPORT_SLACK`、`SPEED_WINDOW_TOLERANCE/SECONDS`、`MAX_MOVE_CATCHUP_TICKS`、
  `BASE_MOVE_SPEED`、`DT`、`TICK_HZ`、`gate-selfcheck.ts#VERIFY_TIMEOUT_MS`(600000)、
  `verify.ts#SELFCHECK_TIMEOUT_MS`(900000)、`FACE_BUDGET`、`LOD_*` 一律不动。
- **发现真回归 ⇒ 改代码,不改期望**。删断言/改恒真/放宽阈值 = 放水。
- **注释是契约的一部分**:不许删注释、不许把"为什么"抹掉。发现旧注释与现实不符 ⇒ 当轮改正。
- 文件**必须是 LF**(Edit/Write 工具写 LF);改完数 `\r` 必须为 0。
- 相对导入**必须带 `.ts` 后缀**。
- `shared/**` 是**冻结层**:改动要走 CR;不要为了图省事往里塞渲染/玩法逻辑。
- 不引入新依赖(除非用户同意);不碰 `.pi/`。

---

## 3 环境(唯一运行环境 = 服务器)

- **长任务与门禁只在服务器跑**:`120.79.230.40`(Debian 12 / 2 核 / 1676 MB / Node v24.13.0),
  路径 `/root/2_5d_sandbox`。本机(Windows)会回收长命子进程,**本机不跑 play/soak/verify**。
- **2 核机上 `verify --all`(约 17 分钟)与开着的 play 不能同时跑** ⇒ 跑门禁前先 `pkill -f '[p]lay.ts'`。
- 同步用 `git -c core.autocrlf=false archive --format=tar.gz -o <t> HEAD`,**整棵覆盖**,不要逐文件打补丁。
  通道:`decodo-recon/rsh.py <host> --put/--script/--get`(先设 `RSH_USER`/`RSH_PASS`/`RSH_TIMEOUT`)。
- 服务器上起长任务:`setsid nohup env ... node scripts/play.ts ... > <log> 2>&1 < /dev/null &`。
- 远程脚本**必须 LF**(用 Write 工具写,别用 `Out-File`;用 PowerShell 时必须显式抹 `\r`)。
- 玩起来:`node scripts/play.ts --host 0.0.0.0 --dist --world design --db <路径>`
  (缺 `--dist` 会撞 8 秒看门狗白屏)。

---

## 4 并行车道与文件所有权(避免撞车)

同一轮可以有多条车道并行;**一条车道一个文件所有权**,跨车道只通过**纯函数签名**对接。

| 车道 | 目标(V/G) | 独占文件 | 对接签名 |
| :--- | :--- | :--- | :--- |
| **A 世界下行** | V3 / G1、G6 | `server/src/net/ws_server.ts`、`shared/net/delta.ts`、`client/src/net/session.ts`、`client/src/net/chunk_store.ts`(新)、`client/src/three/boot.ts` | `chunks(): ChunkInput[]` + 脏块通知 |
| **B 可见物件** | V4 / G2、G7 | `client/src/stage/obj_sprites.ts`(新)、`client/src/stage/entity_sprites.ts`、`client/src/stage/chunk_geometry.ts` | `planObjSprites(chunk)`、`planVegetationSprites(chunk, ids, seed)` |
| **C 群系与 NPC** | V5、V6 / G3、G4 | `server/src/sim/world_sim.ts`(刷怪/群系部分)、`server/src/mobs/**`、`server/src/npc/**`(新) | `biomeAt(x,y)`、`npcAt(x,y)` |
| **D 玩法循环** | V7 / G5、G7 | `server/src/quests/**`(新)、`client/src/ui/**` | `mainlineState(userId)` |
| **E 地形设计** | V2 / G6 | `shared/world/design.ts`、`docs/WORLD-DESIGN.md` | `applyWorldDesign(writer, opts)` |

规则:
- **不要跨车道改别人的独占文件**。需要改 ⇒ 在汇报里提出,由主代理协调。
- 车道之间的接口一旦变化:**同轮**更新本表 + `GAME-VISION.md` §3。
- 子代理**不 commit、不 push、不碰 `.pi/`**;由主代理统一提交。

---

## 5 验收口径:每轮必须回答"玩家屏幕上多了什么"

| 口径 | 怎么说才算数 |
| :--- | :--- |
| **可看** | 真浏览器截图 + 像素统计(色桶数/主色占比),而不是"我看过了" |
| **可测** | 一条命令 + 真实输出(用例数、计数、耗时) |
| **可复现** | 命令写在文档/提交信息里,别人能重跑 |

**不许**用"接线已完成""模块被 import 了""计数为 N"当作体验验收 —— 那是工程验收,
它证明不了玩家能看到东西(本项目 100+ 份审计文档的教训)。

---

## 6 已知的、不要重复踩的坑

- 客户端曾经画的是**本地 demo 世界**(`stage/demo_world.ts`),与服务器世界毫无关系;
  现已改为与服务器同源(`client/src/stage/design_world.ts` + `shared/world/design.ts`)。
- 地形顶点色**默认只按海拔层**取 4 色;材质色在 `terrain_vcolor.ts` 的 `topColorOf`。
- `obj` 图层**此前完全不渲染**(只判"非空"用于建面)⇒ 世界看不到任何东西(车道 B 在修)。
- 群系是**整图一个** `biomeName`;`BIOME_SPAWN` 只走兜底(车道 C 在修)。
- 出生点由 `RoomRuntimeOptions.spawnOrigin` 决定:设计图的世界必须给 `{DESIGN_CENTER, DESIGN_CENTER}`,
  否则玩家出生在海里(改前实测过)。
- `git checkout -- <file>` 在本仓会写 CRLF;判"没变"看 `git diff --quiet HEAD` 而不是 `git status`。
- PowerShell 管道会改字节;算哈希/比二进制走 `execFileSync` 拿 Buffer。
