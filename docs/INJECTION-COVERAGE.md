# 独立注入覆盖记录(契约判据 8)

> 任务:`docs/DECISIONS.md` D-19 第 6 条 —— **档 2 第 3 组:34 个套件全补独立注入**(每个 ≥1 次注入 + 字节还原)。
> 执行者:fixer 子代理(独立于套件作者)。日期:2026-11-17。
> **本文件是本批唯一的仓库内新增记录**;注入期间只临时改过 `server/**`、`client/**`、`shared/**`,
> 每次都是「读原始字节 → 写坏 → 跑 → 用原始字节写回 → SHA-256 前后比对 → 复跑绿」。
> **没有** `git checkout` / `git reset` / 通配删除,没有改 `tests/**` 与 `scripts/**`,没有放宽任何断言。

---

## 一、口径与目标清单

- 「已有注入记录」= `docs/ADVERSARIAL-REVIEW*.md`、`docs/PROGRESS.md` 及各 TASK 记录里已有的注入条目,
  加上本批新套件 `WS-FND-65/66/71/72/73/74/75/76/77/78`。
- 目标 = 上述之外的 34 个套件:**9 个 WS 套件**(WS-01/02/03/05/06/09/11/12/14)+ **25 个 WS-FND 套件**(WS-FND-03/05/06/08/09/10/11/13/14/16/18/20/21/22/23/24/25/26/27/28/29/30/31/32/33)。
- 说明:同一次扫描还发现**另有一批套件**同样没有注入记录(见附录 B),但不在本次 34 个目标内。

## 二、方法(每一步都可复现)

1. 从被测套件的 `import` 出发,在 `server/**`、`client/**`、`shared/**`(不含 `shared/testing/**`)里
   枚举**字面量常量**与**单字面量 `return X;` 分支**,按「套件正文是否引用该符号 + 是否出现在 `eq/near/ok` 行」
   排序;一批自动化找不到红的套件改用人工指定的锚点(见附录 A 的 `manual.json` 用法)。
2. 注入前 **先把原始字节读进内存**(备份),并记 `SHA-256(before)`。
3. 写坏:只替换**一条**锚点(锚点全文在文件里出现次数必须为 1;若为分支则按行号整行替换)。
4. **生效自检**:注入态下 `import()` 被测模块并打印该常量的运行期取值(记为 `selfcheck`),
   确认「注入真的进去了」——避免把「注入无效」读成「断言没牙」。
5. 跑 `node tests/<套件>`:要求 **exit≠0 且出现该套件的 `✗` 判据行**(纯解析错误 `SyntaxError` /
   `Cannot find module` 一律判为**无效注入**并换候选)。
6. 用第 2 步的原始字节 `writeFileSync` 写回,复算 `SHA-256(after)`;**前后必须相等**。
7. 复跑 `node tests/<套件>`:必须 exit=0 且全绿。
8. 单次注入窗口内**只改一个文件**;任何一次还原失败都会让驱动停止(本批未出现)。

## 三、逐条记录(34/34)

| 套件 | 判据名(注入后变红的用例) | 改的文件:行 | 改前 → 改后 | 注入后 exit / 失败摘要 / 复跑 | 还原后 SHA256 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `WS-FND-03` | 一致 → 放行  (实测 false ≠ 期望 true) | `server/src/content/handshake.ts:191` | `  if (claim.version !== local.version) {` → `  if (claim.version === local.version) {` | exit=1([WS-FND-03] 102/116 通过),复跑 exit=0 [WS-FND-03] 116/116 通过 | `2a4905153da83bcc…` 前=后=true |
| `WS-FND-05` | [WS-FND-05] BFS 闭合房间检测面积上限 = 100 格(手册 L726) — 房间面积上限应为 100 格(手册 L726) 期望 100 / 实际 424342 | `server/src/build/rooms.ts:19` | `export const DEFAULT_MAX_AREA = 100;` → `export const DEFAULT_MAX_AREA = 424342;` | exit=1([WS-FND-05] 24/25 通过),复跑 exit=0 [WS-FND-05] 25/25 通过 | `c6c10e54d44538fe…` 前=后=true |
| `WS-FND-06` | [WS-FND-06] [L566] T_eff 幂次聚合:指数 1.35、多材料系数 0.12 — 幂指数 期望 1.35(±1e-12) / 实际 5.127000000000001 | `server/src/alchemy/attributes.ts:32` | `export const AGG_EXPONENT = 1.35;` → `export const AGG_EXPONENT = 5.127000000000001;` | exit=1([WS-FND-06] 95/96 通过),复跑 exit=0 [WS-FND-06] 96/96 通过 | `b727fc9442066d1c…` 前=后=true |
| `WS-FND-08` | [WS-FND-08] WG-08-03 原料被真的消耗(不是「返回了对象就算成功」) — 101 从 4 扣 1 剩 3 期望 3 / 实际 4 | `server/src/sim/world_sim.ts:1922` | `const got = this.consumeGroundItem(id, want);` → `const got = want; /* injected: 不真的扣地面材料 */` | exit=1([WS-FND-08] 14/16 通过),复跑 exit=0 [WS-FND-08] 16/16 通过 | `c801848069f1530a…` 前=后=true |
| `WS-FND-09` | [WS-FND-09] FND9-11 import 本入口必须**无副作用**(不打印、不装配、不监听) — import 不应触发装配(实测 stdout:"[server/src/index.ts] 装配入口(不监听端口)\n装配完成… | `server/src/index.ts:531` | `return false;` → `return true;` | exit=1([WS-FND-09] 13/14 通过),复跑 exit=0 [WS-FND-09] 14/14 通过 | `f0f34a44d15ed0f2…` 前=后=true |
| `WS-FND-10` | [WS-FND-10-restore] T0 装配:assemble({db}) 给出 host 与 db,且 restoreFromProfile **未被结构裁掉** — 用户已存在:p1 | `server/src/db/memory_db.ts:522` | `return false;` → `return true;` | exit=1([WS-FND-10-restore] 3/13 通过),复跑 exit=0 [WS-FND-10-restore] 13/13 通过 | `48c8776e5f975fe7…` 前=后=true |
| `WS-FND-11` | [WS-FND-11] FND11-3 房间 setAfk 推送到模拟层:AOI 列表不含它,且真值可读 — ★ 房间 setAfk 后模拟层真值应为 true 期望 true / 实际 false | `server/src/net/room.ts:2471` | `this.pushAfkToHost(userId, afk);` → `void (userId, afk); /* injected: 删掉推送调用 */` | exit=1([WS-FND-11] 7/14 通过),复跑 exit=0 [WS-FND-11] 14/14 通过 | `65837c998b4d1555…` 前=后=true |
| `WS-FND-13` | [WS-FND-13] FND13-3 ★★ 世界帧持续增长:3 个采样点严格递增(不是「帧数 > 0」) — 世界帧必须严格递增 —— 第 1 点 0 未大于第 0 点 0(全序列 0,0,0) | `server/src/net/room.ts:2067` | `host.advance(1);` → `void host; /* injected: step 里删掉 host.advance(1) */` | exit=1([WS-FND-13] 5/7 通过),复跑 exit=0 [WS-FND-13] 7/7 通过 | `65837c998b4d1555…` 前=后=true |
| `WS-FND-14` | [WS-FND-14] FND14-5 ★★ 大垃圾包:**不抛**也算失败(尾部未消耗 ⇒ 不计成功) — 前置:该垃圾包**不抛**(它版本/op 合法)—— 若抛了则本断言测错对象 | `server/src/net/ws_server.ts:1156` | `export const PROTOCOL_VERSION = 3;` → `export const PROTOCOL_VERSION = 24;` | exit=1([WS-FND-14] 6/8 通过),复跑 exit=0 [WS-FND-14] 8/8 通过 | `4af78c45f0a6692e…` 前=后=true |
| `WS-FND-16` | [WS-FND-16] FND16-1 方向映射:W/S/A/D 与方向键等价,且 y 向下(与格坐标同向) — A 应是 -x 期望 -1 / 实际 1 | `client/src/net/input.ts:70` | `if (MOVE_KEYS.left.some(isDown)) moveX -= 1;` → `if (MOVE_KEYS.left.some(isDown)) moveX += 1;` | exit=1([WS-FND-16] 10/11 通过),复跑 exit=0 [WS-FND-16] 11/11 通过 | `cc5ffc524000198b…` 前=后=true |
| `WS-FND-18` | [WS-FND-18] FND18-4 越权**不执行**:已接线回 PERMISSION、未接线回 NOT_IMPLEMENTED(都不许 OK) — PLACE_BLOCK 对 GUEST 的拒绝类别 期望 "PERMISSION" /… | `server/src/net/room.ts:177` | `baseline: true, build: false, wiring: false, publicStorage: false,` → `baseline: true, build: true, wiring: false, publicStorage: false,` | exit=1([WS-FND-18] 3/4 通过),复跑 exit=0 [WS-FND-18] 4/4 通过 | `65837c998b4d1555…` 前=后=true |
| `WS-FND-20` | [WS-FND-20] FND20-1 放置:世界多一个 obj,背包少一件(两侧同时成立) — ★ 背包真的少了一件(只改世界不改背包 = 凭空造物) 期望 2 / 实际 3 | `server/src/net/actions/material.ts:62` | `{ ops: [{ itemId, delta: -1 }] }` → `{ ops: [{ itemId, delta: 0 }] }` | exit=1([WS-FND-20] 6/11 通过),复跑 exit=0 [WS-FND-20] 11/11 通过 | `a84209d316f3a78b…` 前=后=true |
| `WS-FND-21` | [WS-FND-21-action-e2e] FND21-1 ★★ 动作端到端:真客户端发 → 服务端执行 → 回执 + 世界变了 — live 状态下 sendAction 应返回 true(返回 false 说明连接已不 OPEN) 期… | `client/src/net/session.ts:534` | `return true;` → `return false;` | exit=1([WS-FND-21-action-e2e] 0/5 通过),复跑 exit=0 [WS-FND-21-action-e2e] 5/5 通过 | `4c3c1d800822b554…` 前=后=true |
| `WS-FND-22` | [WS-FND-22-client-actions] FND22-7 背包行只报**总量**(快照里没有明细,不假装有) — 拿不到就说不知道 期望 "背包 (未知)" / 实际 "背包 (未知)_ZZ" | `client/src/net/action_target.ts:137` | `return '背包 (未知)';` → `return '背包 (未知)_ZZ';` | exit=1([WS-FND-22-client-actions] 6/7 通过),复跑 exit=0 [WS-FND-22-client-actions] 7/7 通过 | `48a103e939ef3d06…` 前=后=true |
| `WS-FND-23` | [WS-FND-23-camera-follow] FND23-1 相机目标**等于**权威玩家位置;未知 / NaN 返回 null(不是世界原点) — 世界内的权威位置不应被夹(夹紧只在边界上生效) x:期望 40 / 实际 32 | `client/src/net/camera_follow.ts:81` | `export const CAMERA_EDGE_PAD = 8;` → `export const CAMERA_EDGE_PAD = 59;` | exit=1([WS-FND-23-camera-follow] 4/6 通过),复跑 exit=0 [WS-FND-23-camera-follow] 6/6 通过 | `ef06f5573625e46f…` 前=后=true |
| `WS-FND-24` | [WS-FND-24-contract-align] FND24-2 每个 FieldSpec 的 bytes 与 FIELD_TYPE_BYTES 自洽;变长类型不得有定长值 — hp:u16 的 bytes 应等于 FIELD_TYPE… | `shared/types/wire.ts:110` | `key: 'hp', bit: 3, type: FieldType.U16, bytes: 2` → `key: 'hp', bit: 3, type: FieldType.U16, bytes: 3` | exit=1([WS-FND-24-contract-align] 6/7 通过),复跑 exit=0 [WS-FND-24-contract-align] 7/7 通过 | `10643f05edbad539…` 前=后=true |
| `WS-FND-25` | [WS-FND-25] FND25-1 材料够 ⇒ 成功:材料 -N、产物 +1(两侧都走权威路径) — 合成 #245:应成功(实测 kind=INVALID reason=材料不足:#245 没有配方) | `shared/constants/items.ts:500` | `if (def.recipe === undefined && def.recipeAnyTag === undefined) {` → `if (def.recipe !== undefined \|\| def.recipeAnyTag !== undefined) {` | exit=1([WS-FND-25] 3/8 通过),复跑 exit=0 [WS-FND-25] 8/8 通过 | `fc5837eb768ed033…` 前=后=true |
| `WS-FND-26` | [WS-FND-26] FND26-2 同一玩家再 SLEEP ⇒ OK 但**不叠加**(到期时刻不变) — 回执应说明「已在睡」 期望 true / 实际 false | `server/src/net/actions/sleep.ts:62` | `export const SLEEP_DURATION_MS = 60_000;` → `export const SLEEP_DURATION_MS = 42;` | exit=1([WS-FND-26] 5/6 通过),复跑 exit=0 [WS-FND-26] 6/6 通过 | `0bf4848c51146ee6…` 前=后=true |
| `WS-FND-27` | [WS-FND-27] FND27-1 放入公共箱:背包减、容器加,且另一玩家看到**同一份**(共享模型) — ★ 公共箱真的多了 2 件 期望 [{ itemId: 101, count: 2 }] / 实际 null | `server/src/net/actions/open_chest.ts:111` | `return cell === null ? null : snapshot(cell.public);` → `return null; /* injected: 公开抽屉读口恒 null */` | exit=1([WS-FND-27] 1/7 通过),复跑 exit=0 [WS-FND-27] 7/7 通过 | `ecdd8806d11cd31a…` 前=后=true |
| `WS-FND-28` | [WS-FND-28] FND28-2 已在局中再开局 ⇒ INVALID,且原局一个字段都不变 — ★ 原局的分数不变 期望 5 / 实际 424247 | `server/src/net/actions/start_party.ts:213` | `const total = (rec.scores.get(userId) ?? 0) + n;` → `const total = (rec.scores.get(userId) ?? 0) + n + 424242;` | exit=1([WS-FND-28] 3/7 通过),复跑 exit=0 [WS-FND-28] 7/7 通过 | `8d743ba079afcf60…` 前=后=true |
| `WS-FND-29` | [WS-FND-29] FND29-3 好感不够 ⇒ 拒绝;喂满 ⇒ 成功并记下唯一主人 — 测试前置:应能塞进 25 件 123(被拒说明容量/守恒层先坏了) | `server/src/net/actions/breed_tame.ts:144` | `export const AFFECTION_REQUIRED = 3;` → `export const AFFECTION_REQUIRED = 24;` | exit=1([WS-FND-29] 5/10 通过),复跑 exit=0 [WS-FND-29] 10/10 通过 | `176f61ab958ce109…` 前=后=true |
| `WS-FND-30` | [WS-FND-30] FND30-1 有 `town` 位的房主 ⇒ OK,配置被改且 `effect` 有改前/改后 — 前置:未改过时是出厂配置 safeRadius:期望 24 / 实际 171 | `server/src/mobs/spawner.ts:48` | `export const TOWN_SAFE_RADIUS = 24;` → `export const TOWN_SAFE_RADIUS = 171;` | exit=1([WS-FND-30] 1/8 通过),复跑 exit=0 [WS-FND-30] 8/8 通过 | `ae28b2593eef41d7…` 前=后=true |
| `WS-FND-31` | [WS-FND-31] FND31-1 站在炼金室 + 材料够 ⇒ 成功后材料减、产物加(两侧账都对) — 炼制应成功(实测 kind=INVALID reason=只有站在炼金室(BEDROOM)里才能用炼金台(当前所在房间:ALCHEM… | `server/src/net/actions/use_alchemy_furnace.ts:79` | `export const ALCHEMY_LAB_ROOM_KEY = 'ALCHEMY_LAB';` → `export const ALCHEMY_LAB_ROOM_KEY = 'BEDROOM';` | exit=1([WS-FND-31] 3/8 通过),复跑 exit=0 [WS-FND-31] 8/8 通过 | `68ad90d80cec53ae…` 前=后=true |
| `WS-FND-32` | [WS-FND-32] FND32-1 空格 + 已注册 kind ⇒ OK,`effect` 带 kind/坐标/时刻,且登记可查 — 前置:这个种类必须在 wiring 的注册表里(否则本断言测不到东西) | `server/src/wiring/graph.ts:135` | `return REGISTRY.has(kind);` → `return !REGISTRY.has(kind); /* injected */` | exit=1([WS-FND-32] 1/8 通过),复跑 exit=0 [WS-FND-32] 8/8 通过 | `93359f4d80fb8593…` 前=后=true |
| `WS-FND-33` | [WS-FND-33] FND33-1 合法接线 ⇒ OK,且 wireAt 读得到颜色与频道 — ★ 接上的那条边必须能被 wireAt 读到(否则「登记」这一步不存在) | `server/src/net/actions/wire_edit.ts:168` | `return edge === undefined ? null : { ...edge };` → `return null; /* injected: 连线读口恒 null */` | exit=1([WS-FND-33] 0/7 通过),复跑 exit=0 [WS-FND-33] 7/7 通过 | `88fbc1a0eacd82c1…` 前=后=true |
| `WS-01` | [WS-01] 脏格位图:标记、查询、逐格清除 — 8 个 32 位字 = 256 位 期望 8 / 实际 59 | `server/src/world/chunk.ts:47` | `export const DIRTY_WORDS = 8;` → `export const DIRTY_WORDS = 59;` | exit=1([WS-01] 47/50 通过),复跑 exit=0 [WS-01] 50/50 通过 | `3d16520493b88af1…` 前=后=true |
| `WS-02` | [WS-02] 平安盾 218:免疫举起、击退、掼摔 — 平安盾物品 ID 期望 218 / 实际 424460 | `server/src/physics/carry.ts:35` | `export const SHIELD_ITEM_ID = 218;` → `export const SHIELD_ITEM_ID = 424460;` | exit=1([WS-02] 42/43 通过),复跑 exit=0 [WS-02] 43/43 通过 | `a83126ad1158be69…` 前=后=true |
| `WS-03` | [WS-03] WT-03-36 框选 16×16 生成蓝图:尺寸与格数正确 — 宽 16(手册 §2.3 / §5.3) 期望 16 / 实际 115 | `server/src/build/blueprint.ts:35` | `export const BLUEPRINT_SIZE = 16;` → `export const BLUEPRINT_SIZE = 115;` | exit=1([WS-03] 82/89 通过),复跑 exit=0 [WS-03] 89/89 通过 | `fd251cc1bf56a5c8…` 前=后=true |
| `WS-05` | [WS-05] W5-25 破防④ 巨蟹:315 冰砖上 μ=0.98 失控,撞 359 碎壳,眩晕 6 秒 — 冰砖摩擦系数 μ=0.98(冻结物品表 315) 期望 0.98 / 实际 4.757 | `server/src/bosses/breaks.ts:49` | `export const ICE_MU = 0.98;` → `export const ICE_MU = 4.757;` | exit=1([WS-05] 56/57 通过),复跑 exit=0 [WS-05] 57/57 通过 | `456febd45404798d…` 前=后=true |
| `WS-06` | [WS-06] C1 门禁正例:载体 + 机制双命中放行并给出亲和度 — 应放行,实际拒绝:需要 17~4 件材料,实际 2 件。(未进入亲和度判定) | `shared/types/alchemy.ts:8` | `export const ALCHEMY_MIN_INPUTS = 2;` → `export const ALCHEMY_MIN_INPUTS = 17;` | exit=1([WS-06] 47/64 通过),复跑 exit=0 [WS-06] 64/64 通过 | `1716a492890778b6…` 前=后=true |
| `WS-09` | [WS-09] 32 音高频率表与十二平均律一致(A4=440Hz),至少 5 个音 near() 断言 — 32 个音高 期望 32 / 实际 227 | `client/src/audio.ts:24` | `export const PITCH_COUNT = 32;` → `export const PITCH_COUNT = 227;` | exit=1([WS-09] 102/104 通过),复跑 exit=0 [WS-09] 104/104 通过 | `678dbb4c2a0792cd…` 前=后=true |
| `WS-11` | [WS-11] A7 急单 3 分钟状态机:注入时钟到点自动结算 — 到 180s 自动结算 期望 "SETTLED" / 实际 "RUNNING" | `server/src/coop/rush_order.ts:76` | `export const RUSH_ORDER_DURATION_SEC = 180;` → `export const RUSH_ORDER_DURATION_SEC = 424422;` | exit=1([WS-11] 83/85 通过),复跑 exit=0 [WS-11] 85/85 通过 | `08db0bfab1fd9788…` 前=后=true |
| `WS-12` | [WS-12] 分派 · ★ 裸协议包(真服务端行为)必须能通 —— 首字节是版本号,不是 tag — ★ 裸包首字节是版本号 3(v1 时是 1,与 FRAME_TEXT 撞值) 期望 3 / 实际 24 | `shared/net/delta.ts:70` | `export const PROTOCOL_VERSION = 3;` → `export const PROTOCOL_VERSION = 24;` | exit=1([WS-12] 46/47 通过),复跑 exit=0 [WS-12] 47/47 通过 | `45c15e75a96d22e6…` 前=后=true |
| `WS-14` | [WS-14] A1 生产路径上投满配方真的出锅(接线前:cooked=0,货被丢弃) — 生产路径上投满配方应出锅,实际 cooked=0(0 说明 cooking.ts 未被生产调用:货投进锅后被丢弃) | `server/src/combat/cooking.ts:16` | `export const SOUP_POT_ID = 506;` → `export const SOUP_POT_ID = 424748;` | exit=1([WS-14] 6/8 通过),复跑 exit=0 [WS-14] 8/8 通过 | `db462816daadd551…` 前=后=true |

## 四、合计

- **目标数:34 / 完成数:34 / 未完成:0**。
- 34 次注入的候选尝试总次数:`95`(`coverage-results.json` 里逐次可见:哪几个候选是 `green(no red)`、
  哪几个因锚点不唯一被跳过)。**只有最终变红的那一次写进上表**,失败候选不作数也不隐藏。
- 32 个被改文件:全部还原后 SHA-256 与注入前**逐字节一致**(见下表)。
- 未完成清单:无。

### 残留自检(注入后复算)

```
HASH-OK   server/src/content/handshake.ts                  suites=WS-FND-03 git=(clean)
HASH-OK   server/src/build/rooms.ts                        suites=WS-FND-05 git=(clean)
HASH-OK   server/src/alchemy/attributes.ts                 suites=WS-FND-06 git=(clean)
HASH-OK   server/src/sim/world_sim.ts                      suites=WS-FND-08 git=M server/src/sim/world_sim.ts
HASH-OK   server/src/index.ts                              suites=WS-FND-09 git=M server/src/index.ts
HASH-OK   server/src/db/memory_db.ts                       suites=WS-FND-10 git=(clean)
HASH-OK   server/src/net/room.ts                           suites=WS-FND-11/WS-FND-13/WS-FND-18 git=M server/src/net/room.ts
HASH-OK   server/src/net/ws_server.ts                      suites=WS-FND-14 git=(clean)
HASH-OK   client/src/net/input.ts                          suites=WS-FND-16 git=(clean)
HASH-OK   server/src/net/actions/material.ts               suites=WS-FND-20 git=M server/src/net/actions/material.ts
HASH-OK   client/src/net/session.ts                        suites=WS-FND-21 git=(clean)
HASH-OK   client/src/net/action_target.ts                  suites=WS-FND-22 git=(clean)
HASH-OK   client/src/net/camera_follow.ts                  suites=WS-FND-23 git=(clean)
HASH-OK   shared/types/wire.ts                             suites=WS-FND-24 git=(clean)
HASH-OK   shared/constants/items.ts                        suites=WS-FND-25 git=(clean)
HASH-OK   server/src/net/actions/sleep.ts                  suites=WS-FND-26 git=(clean)
HASH-OK   server/src/net/actions/open_chest.ts             suites=WS-FND-27 git=(clean)
HASH-OK   server/src/net/actions/start_party.ts            suites=WS-FND-28 git=(clean)
HASH-OK   server/src/net/actions/breed_tame.ts             suites=WS-FND-29 git=(clean)
HASH-OK   server/src/mobs/spawner.ts                       suites=WS-FND-30 git=(clean)
HASH-OK   server/src/net/actions/use_alchemy_furnace.ts    suites=WS-FND-31 git=M server/src/net/actions/use_alchemy_furnace.ts
HASH-OK   server/src/wiring/graph.ts                       suites=WS-FND-32 git=(clean)
HASH-OK   server/src/net/actions/wire_edit.ts              suites=WS-FND-33 git=(clean)
HASH-OK   server/src/world/chunk.ts                        suites=WS-01 git=(clean)
HASH-OK   server/src/physics/carry.ts                      suites=WS-02 git=(clean)
HASH-OK   server/src/build/blueprint.ts                    suites=WS-03 git=M server/src/build/blueprint.ts
HASH-OK   server/src/bosses/breaks.ts                      suites=WS-05 git=(clean)
HASH-OK   shared/types/alchemy.ts                          suites=WS-06 git=M shared/types/alchemy.ts
HASH-OK   client/src/audio.ts                              suites=WS-09 git=(clean)
HASH-OK   server/src/coop/rush_order.ts                    suites=WS-11 git=(clean)
HASH-OK   shared/net/delta.ts                              suites=WS-12 git=(clean)
HASH-OK   server/src/combat/cooking.ts                     suites=WS-14 git=(clean)
modules=32 hashSame=32 diff=[]
```

- 32/32 个文件:当前 SHA-256 == 注入前 SHA-256(`hashSame=32 diff=[]`)。
- `git status --porcelain` 里被改的那些文件(world_sim.ts / index.ts / room.ts / material.ts /
  use_alchemy_furnace.ts / blueprint.ts / types/alchemy.ts)**在我开工前就已经是 modified 状态**(属于别的线),
  不是本次注入留下的;其余 25 个文件现在是 clean。
- 本批**没有**新增任何 `git status` 条目(除本记录文件)。

### 全量复跑(还原完成后,34 个套件一起重跑)

```
GREEN WS-FND-03   WS-FND-03.test.ts                    [WS-FND-03] 116/116 通过
GREEN WS-FND-05   WS-FND-05.test.ts                    [WS-FND-05] 25/25 通过
GREEN WS-FND-06   WS-FND-06.test.ts                    [WS-FND-06] 96/96 通过
GREEN WS-FND-08   WS-FND-08.test.ts                    [WS-FND-08] 16/16 通过
GREEN WS-FND-09   WS-FND-09-wiring.test.ts             [WS-FND-09] 14/14 通过
GREEN WS-FND-10   WS-FND-10-restore.test.ts            [WS-FND-10-restore] 13/13 通过
GREEN WS-FND-11   WS-FND-11-afk.test.ts                [WS-FND-11] 14/14 通过
GREEN WS-FND-13   WS-FND-13.test.ts                    [WS-FND-13] 7/7 通过
GREEN WS-FND-14   WS-FND-14.test.ts                    [WS-FND-14] 8/8 通过
GREEN WS-FND-16   WS-FND-16-prediction-wiring.test.ts  [WS-FND-16] 11/11 通过
GREEN WS-FND-18   WS-FND-18-action-ownership.test.ts   [WS-FND-18] 4/4 通过
GREEN WS-FND-20   WS-FND-20-material-loop.test.ts      [WS-FND-20] 11/11 通过
GREEN WS-FND-21   WS-FND-21-action-e2e.test.ts         [WS-FND-21-action-e2e] 5/5 通过
GREEN WS-FND-22   WS-FND-22-client-actions.test.ts     [WS-FND-22-client-actions] 7/7 通过
GREEN WS-FND-23   WS-FND-23-camera-follow.test.ts      [WS-FND-23-camera-follow] 6/6 通过
GREEN WS-FND-24   WS-FND-24-contract-align.test.ts     [WS-FND-24-contract-align] 7/7 通过
GREEN WS-FND-25   WS-FND-25-craft.test.ts              [WS-FND-25] 8/8 通过
GREEN WS-FND-26   WS-FND-26-sleep.test.ts              [WS-FND-26] 6/6 通过
GREEN WS-FND-27   WS-FND-27-chests.test.ts             [WS-FND-27] 7/7 通过
GREEN WS-FND-28   WS-FND-28-party.test.ts              [WS-FND-28] 7/7 通过
GREEN WS-FND-29   WS-FND-29-tame.test.ts               [WS-FND-29] 10/10 通过
GREEN WS-FND-30   WS-FND-30-town.test.ts               [WS-FND-30] 8/8 通过
GREEN WS-FND-31   WS-FND-31-alchemy.test.ts            [WS-FND-31] 8/8 通过
GREEN WS-FND-32   WS-FND-32-automation.test.ts         [WS-FND-32] 8/8 通过
GREEN WS-FND-33   WS-FND-33-wire.test.ts               [WS-FND-33] 7/7 通过
GREEN WS-01       WS-01.test.ts                        [WS-01] 50/50 通过
GREEN WS-02       WS-02.test.ts                        [WS-02] 43/43 通过
GREEN WS-03       WS-03.test.ts                        [WS-03] 89/89 通过
GREEN WS-05       WS-05.test.ts                        [WS-05] 57/57 通过
GREEN WS-06       WS-06.test.ts                        [WS-06] 64/64 通过
GREEN WS-09       WS-09.test.ts                        [WS-09] 104/104 通过
GREEN WS-11       WS-11.test.ts                        [WS-11] 85/85 通过
GREEN WS-12       WS-12.test.ts                        [WS-12] 47/47 通过
GREEN WS-14       WS-14.test.ts                        [WS-14] 8/8 通过
TOTAL green=34/34 red=[]
```

⇒ 34 个套件在还原后**全部 exit=0 全绿**(合计 976 条断言),注入痕迹为零。

## 五、诚实披露

1. **注入手段不是「同一条断言、同一种改法」一刀切**:每个套件按「它自己引用的生产常量/分支」选点,
   自上而下优先常量,常量不红则退到分支/调用删除。上表的「改前 → 改后」就是实际改的那一处。
2. **候选搜索存在失败尝试**:若某个候选写坏后套件仍绿(说明该常量不被这个套件覆盖),换下一个候选;
   这类尝试全部留在 `coverage-results.json` 的 `attempts[]` 里,状态字段为 `green(no red)` 或 `skip(...)`。
3. **并行编辑的窗口风险**:注入期间只改 1 个文件、窗口在秒级;但仓库里同时有别的线在改文件。
   本批 32 个文件的还原哈希与 `git status` 都复核过,未发现与他人改动相互覆盖的痕迹。
4. 未跑 `verify.ts --all`(任务硬约束);每个套件只跑自己。

## 附录 A:驱动(可复现)

驱动不写进仓库(`scripts/**` 禁止改动),所以全文附在这里。用法:

```
# 在仓库根:
node <此文件>.mjs               # 顺序跑全部目标
node <此文件>.mjs WS-FND-25     # 只跑指定套件(逗号分隔)
# 人工指定注入点:同目录放 manual.json,形如
#   { "WS-FND-13": [ { "module": "server/src/net/room.ts", "anchor": "host.advance(1);",
#                       "newText": "void host; /* injected */", "note": "为什么是这处" } ] }
```

```js
/**
 * INJECTION-COVERAGE driver (fixer, criterion 8).
 * Per target suite: break one production literal constant/branch, run `node tests/<suite>`,
 * expect exit!=0 with that criterion red, restore original bytes from a byte backup,
 * assert SHA-256 identical, re-run green. No git checkout/reset, no wildcard delete,
 * never writes tests/** or scripts/**.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/2_5d_sandbox';
const TESTS = path.join(REPO, 'tests');
const OUT = 'C:/Users/Administrator/.pi-desktop/scratch/96d8f961-bcc4-4d3e-bb74-76dcb1c67957';
const ONLY = process.argv[2] && process.argv[2] !== '-' ? process.argv[2].split(',') : null;
const MANUAL = fs.existsSync(path.join(OUT, 'manual.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'manual.json'), 'utf8')) : {};
const MAX_ATTEMPTS = 26;

const GROUP_FND = ['WS-FND-03', 'WS-FND-05', 'WS-FND-06', 'WS-FND-08', 'WS-FND-09', 'WS-FND-10', 'WS-FND-11',
  'WS-FND-13', 'WS-FND-14', 'WS-FND-16', 'WS-FND-18', 'WS-FND-20', 'WS-FND-21', 'WS-FND-22', 'WS-FND-23',
  'WS-FND-24', 'WS-FND-25', 'WS-FND-26', 'WS-FND-27', 'WS-FND-28', 'WS-FND-29', 'WS-FND-30', 'WS-FND-31',
  'WS-FND-32', 'WS-FND-33'];
const GROUP_WS = ['WS-01', 'WS-02', 'WS-03', 'WS-05', 'WS-06', 'WS-09', 'WS-11', 'WS-12', 'WS-14'];
const TARGETS = [...GROUP_FND, ...GROUP_WS];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const suiteFile = (id) => {
  const all = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.ts'));
  return all.find((f) => f === `${id}.test.ts`) ?? all.find((f) => f.startsWith(`${id}-`)) ?? null;
};

function litInfo(raw) {
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) return { kind: 'number', value: Number(raw) };
  if (/^'[^'\\]*'$/.test(raw) || /^"[^"\\]*"$/.test(raw)) return { kind: 'string', value: raw.slice(1, -1) };
  if (raw === 'true' || raw === 'false') return { kind: 'boolean', value: raw === 'true' };
  if (/^[0-9\s+\-*/().e]+$/i.test(raw)) {
    try { const v = Function(`return (${raw});`)(); if (Number.isFinite(v)) return { kind: 'number', value: v }; } catch { /* not evaluable */ }
  }
  return null;
}

function definedConsts(src, withBranches = true) {
  const out = [];
  const re = /(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=\s*([^;\n]+)\s*;/g;
  let m;
  while ((m = re.exec(src))) {
    const li = litInfo(m[4].trim());
    if (!li) continue;
    out.push({ name: m[3], kw: m[2], exported: Boolean(m[1]), kind: li.kind, value: li.value, raw: m[4].trim(), line: src.slice(0, m.index).split('\n').length, text: m[0] });
  }
  if (!withBranches) return out;
  const retRe = /\breturn\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|'[^'\\]*'|true|false)\s*;/g;
  while ((m = retRe.exec(src))) {
    const raw = m[1];
    const li = litInfo(raw);
    out.push({ name: `return@L${src.slice(0, m.index).split('\n').length}`, branch: true, kind: li.kind, value: li.value, raw, line: src.slice(0, m.index).split('\n').length, text: m[0] });
  }
  return out;
}

function brokenText(c) {
  const head = c.branch ? 'return' : `${c.exported ? 'export ' : ''}${c.kw ?? 'const'} ${c.name} =`;
  if (c.kind === 'number') {
    const v = c.value;
    let nv;
    if (Number.isInteger(v)) nv = v === 0 ? 424242 : (Math.abs(v) >= 100 ? v + 424242 : v * 7 + 3);
    else nv = v === 0 ? 4.5 : v + 3.777;
    if (nv === v) nv += 1;
    return `${head} ${nv};`;
  }
  if (c.kind === 'string') return `${head} '${c.value}_ZZ';`;
  return `${head} ${!c.value};`;
}

function parseImports(src) {
  const re = /import\s+(?:type\s+)?(\*\s+as\s+\w+|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  const specs = [];
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1];
    if (clause.startsWith('*')) { specs.push({ spec: m[2], local: [], ns: clause.replace(/\*\s+as\s+/, '').trim() }); continue; }
    const local = [];
    clause.slice(1, -1).split(',').forEach((part) => {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) return;
      const as = p.split(/\s+as\s+/);
      local.push({ imported: as[0].trim(), localName: (as[1] ?? as[0]).trim() });
    });
    specs.push({ spec: m[2], local, ns: null });
  }
  return specs;
}

const prd = (rel) => /^(server\/|client\/|shared\/)/.test(rel) && !/^shared\/testing\//.test(rel);
const toRel = (abs) => path.relative(REPO, abs).replace(/\\/g, '/');

function makeCand(lines, modAbs, c, token, score) {
  const tokRe = new RegExp(`\\b${token.replace(/[$]/g, '\\$')}\\b`);
  let best = null;
  lines.forEach((ln, i) => {
    if (!tokRe.test(ln)) return;
    const callsEq = /(?:eq|near|assert\.strictEqual|assert\.equal)\s*\(/.test(ln);
    const hasLit = /(?:eq|near|ok|assert|expect|throws)\s*\([^)]*?(\d|'|"|true|false)/.test(ln);
    const sc = (callsEq ? 3 : 0) + (hasLit ? 2 : 0);
    if (best === null || sc > best.sc) best = { sc, lineNo: i + 1, text: ln.trim().slice(0, 160) };
  });
  return {
    module: toRel(modAbs), moduleAbs: modAbs, name: c.name, token, kind: c.kind, value: c.value,
    defLine: c.line, defText: c.text, score: score + (best?.sc ?? 0),
    suiteLine: best?.lineNo ?? 0, suiteText: best?.text ?? '', newText: brokenText(c),
  };
}

function candidatesFor(suiteSrc) {
  const lines = suiteSrc.split('\n');
  const cands = [];
  const seen = new Set();
  const push = (c) => { const k = `${c.module}:${c.defLine}:${c.name}:${c.newText}`; if (seen.has(k)) return; seen.add(k); cands.push(c); };
  const specs = parseImports(suiteSrc);
  const direct = [];
  for (const s of specs) {
    const modAbs = path.resolve(TESTS, s.spec);
    if (!/\.ts$/.test(modAbs) || !fs.existsSync(modAbs)) continue;
    const rel = toRel(modAbs);
    if (!prd(rel)) continue;
    let modSrc;
    try { modSrc = fs.readFileSync(modAbs, 'utf8'); } catch { continue; }
    const consts = definedConsts(modSrc);
    const wanted = new Set(s.local.map((l) => l.imported));
    let referenced = s.ns ? new RegExp(`\\b${s.ns}\\.`).test(suiteSrc)
      : s.local.some((l) => new RegExp(`\\b${l.localName}\\b`).test(suiteSrc));
    if (!referenced) continue;
    direct.push({ modAbs, rel, modSrc });
    for (const c of consts) {
      if (c.branch) continue;
      let token = null;
      if (wanted.has(c.name)) token = c.name;
      else if (s.ns) token = `${s.ns}.${c.name}`;
      if (!token) continue;
      push(makeCand(lines, modAbs, c, token, c.exported ? 1 : 0));
    }
  }
  // depth-1: exported literal consts of modules directly imported by those production modules
  let depth1 = 0;
  for (const d of direct) {
    if (depth1 >= 12) break;
    for (const s2 of parseImports(d.modSrc)) {
      if (!/^\.{1,2}\//.test(s2.spec)) continue;
      const abs2 = path.resolve(path.dirname(d.modAbs), s2.spec);
      if (!/\.ts$/.test(abs2) || !fs.existsSync(abs2)) continue;
      const rel2 = toRel(abs2);
      if (!prd(rel2) || direct.some((x) => x.rel === rel2)) continue;
      let src2;
      try { src2 = fs.readFileSync(abs2, 'utf8'); } catch { continue; }
      for (const c of definedConsts(src2, false)) {
        if (!c.exported) continue;
        if (depth1 >= 12) break;
        depth1 += 1;
        push(makeCand(lines, abs2, c, c.name, 0));
      }
    }
  }
  // explicitly referenced production files (suites that read source text / wiring targets)
  const refRe = /['"]((?:server|client|shared)\/[A-Za-z0-9_./-]+\.ts)['"]/g;
  let rm;
  let refN = 0;
  while ((rm = refRe.exec(suiteSrc)) && refN < 24) {
    const absR = path.resolve(REPO, rm[1]);
    if (!fs.existsSync(absR) || direct.some((x) => x.rel === rm[1])) continue;
    let srcR;
    try { srcR = fs.readFileSync(absR, 'utf8'); } catch { continue; }
    for (const c of definedConsts(srcR)) {
      if (refN >= 24) break;
      if (!c.exported && !c.branch) continue;
      refN += 1;
      push(makeCand(lines, absR, c, c.name, 2));
    }
  }
  // branch candidates (single-literal `return X;`) from directly imported modules
  for (const d of direct) {
    let n = 0;
    for (const c of definedConsts(d.modSrc)) {
      if (!c.branch || n >= 12) continue;
      n += 1;
      push(makeCand(lines, d.modAbs, c, '(branch)', -1));
    }
  }
  cands.sort((a, b) => (b.score - a.score) || (a.module === b.module ? a.defLine - b.defLine : a.module.localeCompare(b.module)));
  return cands;
}

function applyInjection(src, c) {
  const lines = src.split('\n');
  const idx = c.defLine - 1;
  const count = src.split(c.defText).length - 1;
  if (count === 1) return { next: src.replace(c.defText, c.newText), mode: 'anchor' };
  if (idx >= 0 && idx < lines.length && lines[idx].trim() === c.defText) {
    const indent = lines[idx].match(/^\s*/)[0];
    const copy = lines.slice();
    copy[idx] = indent + c.newText;
    return { next: copy.join('\n'), mode: `line(anchorCount=${count})` };
  }
  return null;
}

function runSuite(file, timeout) {
  try {
    const out = execFileSync(process.execPath, [path.join('tests', file)], {
      cwd: REPO, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? (e.killed ? 'timeout' : 1), out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const resFile = path.join(OUT, 'coverage-results.json');
const results = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : {};
const save = () => fs.writeFileSync(resFile, JSON.stringify(results, null, 1));

for (const id of TARGETS) {
  if (ONLY && !ONLY.includes(id)) continue;
  if (results[id] && results[id].status === 'done') { console.log(`SKIP(done) ${id}`); continue; }
  const file = suiteFile(id);
  if (!file) { results[id] = { status: 'no-suite-file' }; save(); continue; }
  const rec = { suite: id, file, attempts: [], status: 'pending' };
  results[id] = rec;

  const base = runSuite(file, 180000);
  rec.baselineExit = base.exit;
  rec.baselineSummary = (base.out.match(/\[[^\]]+\] \d+\/\d+ 通过/) ?? []).slice(-1)[0] ?? '';
  if (base.exit !== 0) {
    rec.status = 'baseline-red';
    rec.baselineTail = base.out.slice(-900);
    console.log(`BASELINE-RED ${id}`);
    save();
    continue;
  }

  const suiteSrc = fs.readFileSync(path.join(TESTS, file), 'utf8');
  let cands;
  if (MANUAL[id]) {
    cands = MANUAL[id].map((m) => {
      const modAbs = path.resolve(REPO, m.module);
      let c = definedConsts(fs.readFileSync(modAbs, 'utf8')).find((x) => x.text === m.anchor);
      return {
        module: m.module, moduleAbs: modAbs, name: m.name ?? (c?.name ?? '?'), anchor: m.anchor, defText: m.anchor,
        defLine: c?.line ?? 0, kind: c?.kind ?? m.kind ?? 'number', value: c?.value ?? m.value, score: 99,
        suiteLine: 0, suiteText: m.note ?? '', newText: m.newText,
      };
    });
  } else {
    cands = candidatesFor(suiteSrc).slice(0, MAX_ATTEMPTS);
  }
  rec.candidates = cands.length;
  if (!cands.length) { rec.status = 'no-candidate'; console.log(`NO-CANDIDATE ${id}`); save(); continue; }

  for (const c of cands) {
    const att = {
      module: c.module, name: c.name, defLine: c.defLine, before: `${c.kind}:${JSON.stringify(c.value)}`,
      anchor: c.defText, newText: c.newText, score: c.score, suiteLine: c.suiteLine, suiteText: c.suiteText,
    };
    const buf0 = fs.readFileSync(c.moduleAbs);
    const h0 = sha256(buf0);
    const src = buf0.toString('utf8');
    const inj = applyInjection(src, c);
    if (!inj) { att.result = `skip(anchor count=${src.split(c.defText).length - 1}, no line-mode)`; rec.attempts.push(att); continue; }
    att.mode = inj.mode;
    fs.writeFileSync(c.moduleAbs, Buffer.from(inj.next, 'utf8'));
    try {
      const probe = execFileSync(process.execPath, ['-e',
        `import(${JSON.stringify('file:///' + c.moduleAbs.replace(/\\/g, '/'))}).then(m=>{const v=m[${JSON.stringify((c.name || '').replace(/^return@L\d+$/, 'zzz') || 'zzz')}];console.log('runtime='+typeof v+':'+JSON.stringify(v));}).catch(e=>{console.log('IMPORT-FAIL:'+String(e.message).split('\\n')[0]);});`],
        { cwd: REPO, encoding: 'utf8', timeout: 60000 });
      att.selfcheck = probe.trim().slice(0, 140);
    } catch { att.selfcheck = 'probe-error'; }
    const r = runSuite(file, 180000);
    fs.writeFileSync(c.moduleAbs, buf0);
    att.sha256Before = h0;
    att.sha256After = sha256(fs.readFileSync(c.moduleAbs));
    att.restored = att.sha256After === att.sha256Before;
    att.exitAfterInject = r.exit;
    att.redLines = (r.out.match(/^.*✗.*$/gm) ?? []).map((s) => s.trim()).slice(0, 4);
    att.summaryAfterInject = (r.out.match(/\[[^\]]+\] \d+\/\d+ 通过/) ?? []).slice(-1)[0] ?? '';
    const invalid = /SyntaxError|ERR_MODULE_NOT_FOUND|Unexpected token|Expected ident|Cannot find module|ERR_UNSUPPORTED/.test(r.out);
    if (!att.restored) { att.result = 'RESTORE-MISMATCH'; rec.attempts.push(att); rec.status = 'restore-failed'; break; }
    if (invalid) { att.result = 'invalid(syntax/import)'; rec.attempts.push(att); save(); console.log(`  invalid ${id} ${c.module}:${c.name}`); continue; }
    if (r.exit !== 0 && att.redLines.length > 0) {
      att.result = 'RED-OK';
      rec.attempts.push(att);
      rec.status = 'done';
      rec.chosen = att;
      const green = runSuite(file, 180000);
      rec.reRunExit = green.exit;
      rec.reRunSummary = (green.out.match(/\[[^\]]+\] \d+\/\d+ 通过/) ?? []).slice(-1)[0] ?? '';
      console.log(`OK ${id} ${c.module}:${c.defLine} ${c.name} -> exit ${r.exit} reds=${att.redLines.length} restore=${att.restored} reRun=${green.exit} ${att.summaryAfterInject}`);
      save();
      break;
    }
    att.result = r.exit === 0 ? 'green(no red)' : `exit${r.exit}-no-redline`;
    rec.attempts.push(att);
    console.log(`  miss ${id} ${c.module}:${c.name} (${att.result})`);
    save();
  }
  if (rec.status === 'pending') rec.status = 'no-red-found';
  save();
}
save();
console.log('DONE');

```

## 附录 B:目标之外、按同一启发式仍无注入记录的套件(未做)

`WS-13` WS-FND-34` WS-FND-35` WS-FND-37` WS-FND-38` WS-FND-40` WS-FND-41` WS-FND-42` WS-FND-44` WS-FND-45` WS-FND-46` WS-FND-47` WS-FND-51` WS-FND-53` WS-FND-54` WS-FND-55` WS-FND-56` WS-FND-57` WS-FND-58` WS-FND-59` WS-FND-60` WS-FND-61` WS-FND-62` WS-FND-63` WS-FND-64`

(共 25 个。它们是「同一类欠账」的剩余部分,不在本批 34 个目标内;若要补,
可直接用附录 A 的驱动 —— 命令 `node <driver>.mjs WS-FND-34,...`,机制与上表完全一致。)
