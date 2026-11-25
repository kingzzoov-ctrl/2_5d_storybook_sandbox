/**
 * WS-07 · 服务端权威反作弊(零依赖核心)。
 *
 * 原则:客户端的一切输入都视为「**申请**」,不是「事实」。四类校验:
 *   1. 坐标跳变 —— 单帧位移不得超过 `maxSpeed(移速加成上限) × 帧步长 × 容差`,
 *      帧步长 = `FRAME_SECONDS`(由 `TICK_HZ` 推导,见该常量)。
 *   2. 移速上限 —— 单位时间平均移速,窗口式检测(防单帧合法、累计超速)。
 *   3. 攻速上限 —— 攻击间隔不得小于武器基线间隔 × (1 - 攻速加成上限)。
 *   4. 物品栏一致性 —— 物品总量守恒(消耗必须有来源,产出必须落账)。
 *
 * ⚠️ 第 1~3 类的「加成」**取自客户端声明**(装备/料理/冰面),服务端只把它**钳到上限**,
 * 不自行核算该玩家应有多少加成 —— 因为服务端目前没有装备数据(见 `MoveIntent.speedMul`
 * 与 `docs/WS-07-net-persist.md` §7)。故上限会随声明抬高;收敛它需先让服务端知道装备
 * (`CR-14 U2`)。服务端强制的是**声明的合法性**(非法值不得让检查失效),不是声明的大小。
 *
 * 处置:轻则**静默拒绝**(把请求回退到权威值,不打断同伴游戏),
 * 重则**累计违规分**触发 kick。所有裁决写 `room_events`。
 */

import { createHmac, randomBytes } from 'node:crypto';
import { BASE_MOVE_SPEED, TICK_HZ } from '../../../shared/types/physics.ts';

/**
 * ★ 单帧标称步长(秒)—— **由 `TICK_HZ` 推导**,这里不写字面量。
 * 20Hz ⇒ 0.05;32Hz(31.25ms)⇒ 0.03125。
 *
 * 为什么在本文件再推一次(而不是直接用 `physics.ts` 的 `DT`):反作弊有两处量
 * 必须随节拍一起重标定,而它们**同源**于 `TICK_HZ` 才能保证「秒级语义不变」——
 *   1 每帧额度 `maxDisplacementPerTick`(= 基线速度 × `FRAME_SECONDS` × slack);
 *   2 速度窗口分母的**缺省值** `DEFAULT_FRAME_DT_SECONDS`。
 * 两者同源 ⇒ 改 tick 率只把「一帧是多少秒」重标定,速度读数(格/秒)、窗口秒数、
 * 容差、单帧容差**逐位不变**。单一事实源仍是 `TICK_HZ`;本式与 `physics.ts`
 * 的 `DT` 必须一致,由 `tests/WS-FND-172` 的 `FND172-16` 钉住(不许两处漂移)。
 */
export const FRAME_SECONDS = 1 / TICK_HZ;

/* ═══════════════════════════ 1. 阈值表 ═══════════════════════════ */

/**
 * 移速加成上限。来源:手册 §3.9/§3.10 的可叠加加速项取上界并留余量 ——
 *   249 行进小军鼓 +25% · 601 甜莓果茶 +15% · 729 夜影吸血蝙蝠斗篷 移速 +10% ·
 *   619 冰面 +40% · 622 水中 +30% · 724 滚翻冷却(不改速度) ·
 *   叠罗汉 `carrierSpeedMul` 只减不增 · 230 缩小药水 0.3 倍(减速)。
 * 最坏正向叠加 1.25 × 1.15 × 1.10 × 1.40 = 2.21;再给 1.15 的余量 → 2.55。
 *
 * 注:手册 `719` 无移速、`731` 是攻防,两者均与本值无关 —— 早期把它们并写作移速出处
 * 是**引用标错**(数值 1.10 一直是对的),已修正为手册 `729`。
 */
export const MAX_SPEED_BONUS_MUL = 2.55;

/**
 * 坐标跳变的**单帧**容差:网络抖动下的补偿量,再宽会放过瞬移。
 *
 * ⚠️ **与 `SPEED_WINDOW_TOLERANCE`(1.25)语义不同,不要因为数值接近而合并。**
 *   - `TELEPORT_SLACK`  —— **单帧**抖动补偿。语义是「某一帧突然多走一点」,
 *     分母是**一帧**,只用于 `dist > allowed` 这一处。
 *   - `SPEED_WINDOW_TOLERANCE` —— **持续**超速容忍。语义是「一整秒里平均快了
 *     一点」,分母是**1 秒窗口**(帧数 = `SPEED_WINDOW_TICKS`),只用于窗口均速比较。
 *
 * 两者可推导出一个容易误读的结论:`1.6 > 1.25` ⇒ **持续以「单帧上界」的速度
 * 行走会被窗口抓住**。这不是矛盾,而是设计意图:
 * 单帧可以抖(1.6),但不能**一直**抖(1.25)。实测(WS-07,120 帧):
 *   · 1.00× / 0.90× 合法         ⇒ 0 拒、0 分(不误伤);
 *   · 1.25× 合法(5.63 格/秒)    ⇒ 0 拒、0 分(**恰在容差边界也不误伤**);
 *   · 1.30× 合法(5.85 格/秒)    ⇒ 第 20 帧判 SPEED;
 *   · 2.00× 合法(9.00 格/秒)    ⇒ 第 1 帧判 TELEPORT;
 *   · 2.55× **且声明** `speedMul:2.55` ⇒ 0 拒(满加成合法,不误伤);
 *     同样 2.55× 却声明 `speedMul:1`   ⇒ 第 1 帧判 TELEPORT(真超速)。
 *   ⇒ 判据是「位移与**声明**的加成是否自洽」,不是绝对速度。
 */
export const TELEPORT_SLACK = 1.6;

/**
 * 窗口式移速检测:窗口长度与窗口内允许的平均超速比例。
 * ⚠️ 与 `TELEPORT_SLACK`(1.6)语义不同,见上。
 *
 * ★ 窗口的**语义锚是「秒」,不是「帧」**:窗口恒为 `SPEED_WINDOW_SECONDS` 秒,
 * 帧数由 `TICK_HZ` 推导(20Hz ⇒ `SPEED_WINDOW_TICKS = 20`;32Hz ⇒ 32)。
 * 原先写死 `20`(把「1 秒」写在注释里)⇒ 改 `TICK_HZ` 时窗口会**悄悄**变成
 * 0.625 秒 —— 那是容差判据变紧(重标定),不是「改帧率」应有的副作用。
 */
export const SPEED_WINDOW_SECONDS = 1;
/** 窗口长度(帧)= 秒数 × `TICK_HZ`(取整:窗口是整帧数)。 */
export const SPEED_WINDOW_TICKS = Math.round(SPEED_WINDOW_SECONDS * TICK_HZ);
export const SPEED_WINDOW_TOLERANCE = 1.25;

/**
 * ★ 速度窗口**分母**用的帧间隔(秒)的缺省值 = 标称帧步长 `FRAME_SECONDS`(由
 * `TICK_HZ` 推导:20Hz ⇒ 50ms;32Hz ⇒ 31.25ms)。**与每帧额度同源** ⇒
 * 「窗口跨度 / 分母」恒等于真实秒数,与 tick 率无关。
 *
 * ## 为什么需要它
 * 窗口分母原先是写死的 `spanTicks × DT`,而宿主定时器粒度可能 > 标称帧间隔 ——
 * 本机实测 **62.77ms/帧(= 15.93Hz)**,`docs/DECISIONS.md` D-26。
 * 此时一个 1 秒窗口(20Hz 下 20 帧)跨的是 **1.2555 秒**真实时间,分母却只记 1.0 秒
 * ⇒ 满速裸装合法玩家 4.5 格/秒被读成 `4.5 × 20/15.93 = 5.65 > 5.625`(**误判 SPEED**)。
 *
 * ## 它与 `SPEED_WINDOW_TOLERANCE` 的分工(不要混淆)
 * ```
 * SPEED_WINDOW_TOLERANCE —— 判据:容忍多少超速。放大它在**真作弊者**身上同步放水
 *                           (6.0 格/秒会变成合法,且会红掉以 5.63 为锚的
 *                            WS-07 `M49` / WS-10:`5.63 限住总量` 那两条)。
 * 本常量                —— 秒表:一帧是多少秒。修正它只把读数**还原成真实格/秒**,
 *                           判据一字不动(真作弊者 6.0 格/秒在实测节拍下照样 > 5.625)。
 * ```
 *
 * ## 怎么注入
 * `AntiCheatRoom.setFrameIntervalMs(ms)` 或 `tick(t, frameMs)`(`room.ts` 有
 * `this.clock.nowMs()` 可读实测节拍)。**不注入 ⇒ 本缺省值**,既有判据逐位不变
 * (含 WS-07/WS-10 的 5.63 锚点与 FND172-3 登记的 5.65 误判)。
 */
export const DEFAULT_FRAME_DT_SECONDS = FRAME_SECONDS;

/**
 * 自报 `tick` 相对**水位**允许的单包最大超前量(帧)。它是**斜率**限制,不是配额。
 *
 * ## 两个水位,两种含义(原名 `s.lastTick` 被两侧共写,是失明的病根)
 *
 * - `s.lastTick`  —— **服务端时钟**水位。只由 `AntiCheatRoom.tick()` 每帧推进。
 * - `s.lastMoveTick` —— **客户端申报**水位。只由被接受的移动推进。
 *
 * `claimedTick = min(intent.tick, lastMoveTick + MAX, lastTick + MAX)`。
 * 夹取点仍在 `checkMove` 入口**一处**(下游一律用 `claimedTick`),
 * 调用方不再重复夹取(J13 形态)。
 *
 * ⚠️ **唯一例外:窗口的时间轴**。★ WS-FND-172 起 §6.2 的 `window.push` /
 * `cutoff` / `spanTicks` 读的是 `s.lastTick`(**服务端时钟**),不是 `claimedTick` ——
 * 因为 `claimedTick` 被 `lastMoveTick + MAX` 项夹住,推进速率 = `min(报文率, 帧率)`,
 * 拿它当秒表就会把「报文条数」当成「时间」。额度(`dtTicks`)与跳变判据仍全走
 * `claimedTick`,**未动**。
 *
 * ## 为什么单靠 `MAX` 不够:同一帧可重复兑现额度
 *
 * 原实现 `dtTicks = Math.max(1, claimedTick - s.lastTick)` 有两处病:
 *
 * 1. **下界 `max(1, …)`**:`dtTicks` 永不为 0 ⇒ 报文条数**线性放大**总额度。
 * 2. **夹取点被客户端推动**:`s.lastTick` 由 `checkMove` 自己写,
 *    于是「额度上限」和「已用额度」是同一个字段 —— 每包都把上限往前推一格,
 *    再兑现一格。服务端帧号 `10` 时连发 50 包,每包 `0.918` 格,**全部放行、违规分 0**。
 *
 * 实测(WS-07 `E17` 族,均以真实 20Hz 帧推进):
 *   · 修复前:同一 tick 连发 20 包 ⇒ **20 包全放行、18.36 格、违规分 0**。
 *   · 修复后:同一 tick 连发 20 包 ⇒ **1 包放行、19 包被拒、0.918 格、违规分 76**
 *     (40 包时 39 拒 / 156 分),超过 3 次拒绝即达踢出阈值。
 *
 * 因此额度必须锚在**攻击者推不动的锁**上 —— 即服务端时钟 `lastTick`,
 * 而不是客户端也能写的字段。
 *
 * ## 为什么是「叠加」而不是「替换」(task-51 J13:两层都要,职责不同)
 *
 * 两层**不是**同一职责的两种写法,各自有**独立可测**的失效后果
 * (用工作区源码做单点手术生成副本,同一攻击形状实测):
 *
 * - 只删**服务端时钟封顶** ⇒ 同一帧内「逐包递进声称 tick」的放行量从
 *   **11 包 / 10.098 格**涨到 **19 包 / 17.442 格**(层级关系:此时单帧总额度
 *   不再与 `lastTick` 挂钩,只剩窗口检查兜底)。即**斜率层单独无法限制
 *   「一帧里能兑现多少」** —— 报文条数重新成为吞吐放大器。
 * - 只删**斜率封顶** ⇒ 玩家静默 200 帧后,单包声称 `tick:1e9` 可把整段积压
 *   一次兑现:**二分实测单包最大放行 144.15 格**(两层都在时同一输入只放行
 *   0.918 格,差 **157 倍**;其余更大的输入被判 TELEPORT)。
 *   即**时钟层单独无法限制「单包能跳多远」**,一包即可跨过任何墙体。
 *
 * 结论:**任何一层都不是另一层的冗余**,删任一层都不安全;
 * 故取 `Math.min` 保留两项,而不是「用一个替换另一个」。
 * (对照:`dtTicks` 的下界必须同时为 0,见下。)
 *
 * ## 取值 1(不是 20,也不是 5)
 *
 * 取 `SPEED_WINDOW_TICKS`(20)时单包额度 `0.918×20 = 18.36` 格 —— 而单包位移
 * **没有路径碰撞检测**(`applyMove` 只校验起终点欧氏距离,不查 `WorldGrid.isSolidAt`),
 * 18.36 格足以跨过任何墙体/陷阱/Boss 预警区。`1` ⇒ 单包 `0.918` 格,
 * 单包跨不过 1 格墙(0.918 < 1.0)。RTT 抖动由「服务端时钟水位」承担(它按真实
 * 流逝帧数放行),不需要靠放大 `MAX` 来补。
 *
 * ## ⚠️ 残留(如实记录,本修复**没有**根治这一条)
 *
 * 上面的「跨不过墙」是**单包**性质。额度锚在服务端时钟上,而时钟是**按帧**推进的,
 * 于是攻击者只要**静默若干帧**换取积压,再在**同一帧内**连发,就能把积压一次兑现:
 *
 *   静默 T 帧 ⇒ 可用额度 B = T + 1(帧);同帧内连发 K 包时
 *   超出 B 的包被拒 ⇒ 分数 = 4×拒(TELEPORT)或 3×拒(SPEED)。
 *
 * ★ WS-FND-172(2026-11-21)把**窗口时间轴**改锚 `s.lastTick`(见 §6.2)后重测:
 *   · 静默 19 帧 + 同帧连发 22 包 ⇒ **放行 20 / 拒 2(全 TELEPORT,权重 4)/
 *     违分 8.0 < 12 ⇒ 未被踢**,单帧位移 **18.36 格**;
 *     (改前口径:19 放行 / 3 拒 SPEED / 9 分 / 17.442 格 —— 拒因 SPEED→TELEPORT,
 *      权重 3→4 ⇒ 记分更快。)
 *   · **立刻重复**该循环 ⇒ 第 2 轮 22 条**全判 SPEED**,累计分 73.58 ⇒ 被踢(实测)。
 *
 * ⚠️ ⚠️ 同一改动曾打开另一条更大的口子 —— **本轮已修**(见 §6.2b 零跨度分支 / `FND172-10`);
 *   **修前**实测如下(如实保留作对照):同帧连发的报文在时间轴上**全落进同一个 `lastTick`**
 *   ⇒ 窗口检查对「同帧突发」完全失明;而额度 = T + 1 ⇒ 只要把静默间隔拉到
 *   ≥ `SPEED_WINDOW_TICKS`(20 帧),上一轮的位置也已被 `cutoff` 剪掉,
 *   突发就**一条都不被拒**:
 *
 *   实测(间隔 22 帧、每轮 22 包 × 0.918 格、跑 20 轮):
 *     · 本改动后:**403.92 格 / 460 帧 ≈ 17.56 格/秒,0 违规、0 踢**;
 *     · 改前(窗口轴 = `claimedTick`)同一输入:**17.442 格 / 460 帧 ≈ 0.76 格/秒,
 *       且第 1 轮即被判 SPEED 踢出**。
 *   ⇒ 定性从「**一次性**位置可达优势」变成「**可持续**移速优势」(
 *     裸装合法 4.5 的 3.9 倍、满加成合法 11.48 的 1.53 倍)。
 *   ⚠️ 同一族的**分母耦合**(非本改动引入,**后被 `dtSeconds` 注入覆盖**):窗口分母走
 *     标称 `spanTicks × DT`(32Hz ⇒ `DT = 31.25ms`)。服务端真实帧率低于标称时
 *     (如 15.93Hz),窗口跨的 32 帧是 **2.009 秒**真实时间,分母却只记 1.0 秒
 *     ⇒ **满速裸装合法玩家 4.5 → 9.0 格/秒 > 上限 5.625,会被误判 SPEED**;
 *     `AntiCheatRoom.tick(t, frameMs)` 传**实测**帧间隔后分母跟着变 ⇒ 该误判消失(见 §6.2)。
 *
 * 与修复前的定性差别(task-55 的实质交付):
 *   · 修复前:同一形状 **20 包全放行 / 18.36 格 / 违规分恒 0** ⇒
 *     零代价、无界、可无限重复;
 *   · task-55 修复后:**单包**位移有界(≤ B × 0.918)、超出部分**必留违规流水并记分**。
 *     ⚠️ 「残留收窄为一次穿墙」这个定性**已被 WS-FND-172 推翻**(见上)。
 *
 * 根治需要两件事之一(均**不在本文件职责内**):
 *   1. **入站报文限速**(会话/传输层):同一帧内进站报文数有上限,
 *      则「静默 + 连发」不可用 —— 这是最直接的修法;
 *   2. **路径碰撞检测**(`applyMove` 对整段位移做 ray/path 检查):
 *      则「单帧累计多包」即使发生也跨不过墙。
 *
 * 本文件只能保证:**每条报文**的位移上界正确、额度不被客户端自己推动、
 * 违规分不再恒 0。WS-07 `E17e` 把这个残留**钉成断言**:
 * 一旦有人真正根治(限速或路径检查),该断言会变红,提示更新。
 *
 * 代价(如实记录):丢包 ≥2 帧时,客户端那一包的位移超过 1 帧额度 ⇒ 被拒并回退。
 * ⚠️ 实测 HEAD 与修复版在同一丢包输入上**拒绝次数/拒因/违规分逐格相同**
 * (1% 丢包 60 秒都是 13 次 `单帧位移 1.148 格 > 上界 0.918`)——
 * 即该脆性**不是本次修复引入的**,根因是 `TELEPORT_SLACK(1.6)` 容不下 2 帧的
 * 真实位移(`4.5×2.55×0.05×2 = 1.1475 > 0.918`)。收紧 slack 属独立议题。
 * 这是刻意的**失效关闭**取向 —— 客户端会自行重新对齐,而多走一点是不可撤销的
 * 权威状态污染。真正的补偿应放在传输层(入站报文限速 + 客户端插值补帧),
 * 不在本函数职责内。
 *
 * 诚实客户端不受影响:mul=1(0.225 格/帧)与 mul=2.55(0.5737 格/帧)
 * 各跑 60 秒 **0 拒绝 / 0 分 / 未踢出**(实测)。
 *
 * 详见 `docs/GUARD-AUDIT.md` 与 WS-07 的 `E14` / `E17` 族用例。
 */
export const MAX_MOVE_CATCHUP_TICKS = 1;

/**
 * 攻速上限。
 *  - 基线:近战轻剑 0.40s/次(711 普攻三连)。
 *  - 允许的最快:0.40 / (1 + 1.00) = 0.20s —— 覆盖 714 双刀 + 249 军鼓 +25%
 *    + 627 炮台 +35%(只对炮台,不叠加到近战)+ 1220 帧近战限流。
 * 取 1.0 作为攻速加成上限。
 */
export const BASE_ATTACK_INTERVAL_S = 0.4;
export const MAX_ATTACK_SPEED_BONUS = 1.0;

/** 单帧最多允许消耗/产出的物品总量(防「一帧刷满背包」)。 */
export const MAX_ITEM_DELTA_PER_TICK = 64;

/** 违规分:达到即踢出。 */
export const VIOLATION_SCORE_KICK = 12;
export const VIOLATION_SCORE_DECAY_PER_TICK = 0.02;

/**
 * 房间级违规流水保留条数(**环形缓冲**,见 `AntiCheatRoom.pushViolation`)。
 *
 * 512 与修前的 `slice(-512)` 同值 —— 这是**保持行为不变**的一处:流水仍然只留
 * 最近 512 条,变的只是「怎么留」(每帧重建数组 → 写一个槽)。
 */
export const VIOLATION_LOG_CAPACITY = 512;

/**
 * 单个玩家最多留多少条自己的违规(有界)。
 *
 * ⚠️ 修前 `PlayerAntiCheatState.violations` **只进不出**:一个 20Hz 长期在线的玩家
 * 只要持续触发(哪怕只是速度抖动)就让这条数组无界增长,而它挂在房间状态里
 * ⇒ 内存随在线时长线性涨。256 条足够回溯最近几十秒的抖动,超出即丢最旧。
 */
export const VIOLATION_KEEP_PER_PLAYER = 256;

export const ViolationKind = {
  TELEPORT: 'TELEPORT',
  SPEED: 'SPEED',
  ATTACK_RATE: 'ATTACK_RATE',
  INVENTORY: 'INVENTORY',
} as const;
export type ViolationKind = (typeof ViolationKind)[keyof typeof ViolationKind];

export const VIOLATION_WEIGHT: Readonly<Record<ViolationKind, number>> = {
  TELEPORT: 4,
  SPEED: 3,
  ATTACK_RATE: 2,
  INVENTORY: 5,
};

/* ═══════════════════════════ 2. 可注入时钟 ═══════════════════════════ */

export interface Clock {
  nowMs(): number;
}

/**
 * 可注入时钟。
 *
 * 返回的对象**同时**是一个合法 `Clock`(自带 `nowMs`)与一个控制器
 * (`advance` / `set`)。两种调用风格因此都成立:
 * ```ts
 * const clock = fixedClock(0);           clock.advance(60_000); clock.nowMs();
 * const { clock: c, advance } = fixedClock(0);
 * ```
 * 这样测试里不会因为「传外壳还是传内核」而写出两种不兼容的用法。
 */
export type FixedClock = Clock & {
  advance: (ms: number) => number;
  set: (ms: number) => number;
  /** 自指,兼容解构写法。 */
  clock: Clock;
};

export function fixedClock(startMs: number): FixedClock {
  let t = startMs;
  const self: FixedClock = {
    nowMs: () => t,
    advance: (ms: number) => { t += ms; return t; },
    set: (ms: number) => { t = ms; return t; },
    clock: undefined as unknown as Clock,
  };
  self.clock = self;
  return self;
}

/* ═══════════════════════════ 3. 裁决结果 ═══════════════════════════ */

export interface Violation {
  kind: ViolationKind;
  tick: number;
  playerId: string;
  detail: string;
  weight: number;
}

export interface Verdict {
  allowed: boolean;
  /** 拒绝时给客户端的权威值(用于静默回退)。 */
  corrected?: { x: number; y: number; z: number };
  violation?: Violation;
  /**
   * ★ WS-FND-135(P1):这次拒绝来自**世界侧**(倒地 / 眩晕 / 被困 / 击退窗口 /
   * 非有限值 …),不是反作弊判定。
   *
   * 两者都会让 `allowed === false`,但客户端的正确反应不同(前者原地不动,
   * 后者回退到权威坐标)⇒ 必须能区分。修前世界拒收时 `applyMove` 照旧返回
   * `allowed: true`(**谎报成功**),而反作弊窗口已被推进到那组**没落地的
   * 幻影坐标**上 —— 下一包按幻影坐标判跳变,合法玩家被误判 TELEPORT / SPEED。
   */
  worldRejected?: boolean;
  /**
   * ★ 这次拒绝**不是**违规:客户端的步长仍在额度内,多出来的距离来自**服务端自己**
   * 在上两包之间挪动刚体(击退 / 碰撞分离 / 落地沉降),客户端那一包发出时还不知道。
   * ⇒ 照样拒绝(陈旧申报不许覆盖权威刚体),但**不计违规、不加分**(见 `checkMove` §6.1)。
   */
  stale?: boolean;
}

export interface AntiCheatLimits {
  maxSpeedBonusMul: number;
  teleportSlack: number;
  speedWindowTicks: number;
  speedWindowTolerance: number;
  baseAttackIntervalS: number;
  maxAttackSpeedBonus: number;
  maxItemDeltaPerTick: number;
  /**
   * 自报 `tick` 相对 `s.lastTick` 的最大追帧幅度。
   * 见 `MAX_MOVE_CATCHUP_TICKS` —— 它是**单帧位移上界的放大系数**,
   * 因此必须夹住,否则报一个大 `tick` 即可放行任意位移。
   */
  maxMoveCatchupTicks: number;
}

export const DEFAULT_LIMITS: AntiCheatLimits = {
  maxSpeedBonusMul: MAX_SPEED_BONUS_MUL,
  teleportSlack: TELEPORT_SLACK,
  speedWindowTicks: SPEED_WINDOW_TICKS,
  speedWindowTolerance: SPEED_WINDOW_TOLERANCE,
  baseAttackIntervalS: BASE_ATTACK_INTERVAL_S,
  maxAttackSpeedBonus: MAX_ATTACK_SPEED_BONUS,
  maxItemDeltaPerTick: MAX_ITEM_DELTA_PER_TICK,
  maxMoveCatchupTicks: MAX_MOVE_CATCHUP_TICKS,
};

/* ═══════════════════════════ 4. 每玩家校验器 ═══════════════════════════ */

export interface MoveIntent {
  tick: number;
  x: number;
  y: number;
  z: number;
  /**
   * 客户端声明的移速倍率(装备/料理)。
   *
   * ⚠️ **服务端不自行核算这个值 —— 只把它钳到上限**(见 §7「一律钳到上限,不自证」)。
   * 服务端目前**没有**装备数据可据以独立算出「该玩家应该多快」:`PlayerState` 只有
   * `weaponId`、无装备槽,`room.ts` 也不保存穿戴状态,`statsAtLevel` 不含任何速度字段。
   *
   * 因此这是**已声明的设计取舍,不是「服务端已核对过」**:上限会随声明抬高
   * (声明 `2.55` 时约基线的 3.19 倍),且绕过装备前置。
   *
   * 要收敛这里就得让服务端真正知道装备(CR-14 U2 的另一条路:加装备槽 + 服务端速度模型),
   * 在那之前**不要**把本注释写成「已比对」—— 那与 §7 口径矛盾,会误导后来者以为这里安全。
   *
   * 唯一被服务端强制的是**值的合法性**:非数字/`NaN` 声明不会让检查失效
   * (见 `sanitizeMul`),而不是「声明的大小」。
   */
  speedMul?: number;
  /**
   * ★ WS-FND-122:**起跳意图位**(`true` = 这一条命令带「按了空格」)。
   *
   * 为什么加在 `MoveIntent` 而不是新开一条上行:`jump` 与移动**同源**
   * (客户端 `input.ts` 的空格锁存就是随移动命令发出来的,见
   * `client/src/net/input.ts` 与 `main.ts`),拆成两条报文会造出
   * 「跳了但没走 / 走了但没跳」两种时序,而锁存语义本来就是「这一条命令」。
   *
   * ⚠️ 它**不参与**反作弊的位移运算(`checkMove` 只读 x/y/z/tick):
   *    「能不能起跳」(地面 / 冷却)由世界侧 `tryPlayerJump` 判 —— 一处判据。
   */
  jump?: boolean;
}

export interface PlayerAntiCheatState {
  id: string;
  lastX: number;
  lastY: number;
  lastZ: number;
  /**
   * **服务端时钟**水位:房间真实走到第几帧。只由 `AntiCheatRoom.tick()` 推进。
   *
   * ⚠️ **不要**在这里写客户端申报值(见 `MAX_MOVE_CATCHUP_TICKS` 的
   * 「两个水位,两种含义」)。它此前被 `checkMove` 与 `tick()` **两侧共写**,
   * 于是「额度上限」和「已用额度」成了同一个字段 —— 攻击者每包都把上限往前推,
   * 再兑现一包,单帧可灌满任意位移。它是反作弊失明的病根,故拆成两个字段。
   */
  lastTick: number;
  /**
   * **客户端申报**水位:被兑现到的最大自报帧号。只由 `checkMove` 推进,且**单调**。
   *
   * 额度 = `claimedTick - lastMoveTick`,故**报同一个 tick 第二次拿不到额度** ——
   * 这正是「同一 tick 可重复兑现」的闸门。
   */
  lastMoveTick: number;

  /**
   * ★ **客户端帧计数器的基准偏移**(首包定,之后不变;`null` = 还没收到过包)。
   *
   * 客户端发的是**它自己的**计数器(`client/src/main.ts` 的 `localTick`,从 0 起),
   * 而 `lastMoveTick` 播种的是**房间帧号**(`room.ts#join` 传 `state.meta.tick`)。
   * 两者相差「加入时房间已经跑了多少帧」——**任何第二个玩家、任何重载**都会差几百帧。
   * 不折算 ⇒ `claimedTick = min(intent.tick, …)` 被压到客户端那个小计数上
   * ⇒ `dtTicks = 0` ⇒ `allowed = 0` ⇒ **每一包带位移的移动都被判 TELEPORT**,
   * 玩家一步也走不动,且每包留一条假阳性(判据 `FND178-8`)。
   *
   * ⚠️ **不进快照、不回滚** —— 它是「两套时钟之间的换算」,不是位置事实。
   */
  clientTickBase: number | null;

  /**
   * ★ **上一包原始的客户端计数器**(只用于识别「计数器被重置」)。
   *
   * 客户端计数器是**JS 上下文的**:页面重载 / 崩溃恢复 / 席位 `resumed` 之后都从 0 重来,
   * 而 AC 状态在 `disconnect()` / resume 那条路上是**整份保留**的(`ac.leave()` 只在
   * 主动退房或宽限超期时才调)⇒ 基准 `clientTickBase` 会一直停在旧值。
   * 不识别重置 ⇒ `t' = 0 + 旧基准 ≈ 旧房间帧号 ≤ lastMoveTick` ⇒ `dtTicks` 恒 0
   * ⇒ **重连回来的玩家一步也走不动**(判据 `FND178-9`,与 `FND178-8` 是同一条缺陷的两个入口)。
   *
   * `null` = 还没收到过任何一包。与 `clientTickBase` 一样**不进快照、不回滚**。
   */
  lastRawClientTick: number | null;
  /**
   * ★ **上一次入口重锚把水位挪了多远**(= 权威刚体自上一包以来**自己**走的距离)。
   *
   * 只在 `room.ts#applyMove` **顶部**那次重锚写入(见 `syncWatermark` 的 `entry` 参数);
   * 出路径的两次重锚**不写**它 —— 否则读数会被压成「一帧」,而客户端错过的是「一包间隔」。
   *
   * 唯一用途:`checkMove` §6.1 把「世界自己挪了刚体」造成的那一包**归类**成 `stale`
   * (客户端的步长仍在额度内,多出来的是**服务端**位移)⇒ 不计违规、不加分。
   * 判据用三角形不等式:`|step − W| ≤ |step| + |W| ≤ 额度 + W` —— 与 `W` 无关地成立,
   * 所以它**不放宽任何上界**;真作弊者申报远处坐标照样按真实位移判。
   */
  authorityDrift: number;
  /** ★ 被归类成 `stale`(服务端自位移所致的假阳性)的拒绝次数。 */
  staleRejections: number;
  /** 环形窗口:最近 N 帧的位置与时间,用于窗口式移速检测。 */
  window: { tick: number; x: number; y: number }[];
  /** 上次成功攻击的 tick。 */
  lastAttackTick: number;
  score: number;
  violations: Violation[];
  kicked: boolean;
  /**
   * 本 tick 内**已用掉**的产出凭证令牌(见 `checkInventory` 的一次性判据)。
   *
   * 记在这里而不是 `grantedSources` 里:后者是「授予」,这里是「消费」——
   * 两个事实分开存,才能同时回答「铸它的那次动作还在本 tick 吗」与
   * 「用过没有」。`usedSourceTick` 与它配对,换 tick 即整体作废。
   */
  usedSourceTokens: Set<string>;
  /** `usedSourceTokens` 所属的 tick;`-1` = 从未用过任何凭证。 */
  usedSourceTick: number;
}

export function createAcState(id: string, tick = 0, x = 0, y = 0, z = 0): PlayerAntiCheatState {
  return {
    id,
    lastX: x, lastY: y, lastZ: z,
    /* 两个水位都**以房间时钟为基准**:`lastTick` 是服务端时钟;`lastMoveTick` 是
       客户端申报水位,也播种成房间帧号 —— 若留 0,玩家可在同一帧内连发 N 包
       「追平」这段积压 ⇒ 开局即兑现 N 帧额度。
       ⚠️ 但客户端发的是**它自己的**计数器 ⇒ 必须经 `normalizeClientTick()` 折算到
       房间时钟(见 `clientTickBase`),否则申报水位永远追不上、`dtTicks` 恒 0
       ⇒ 玩家一步也走不动(这正是 `FND178-8` 守的那条)。 */
    lastTick: tick,
    lastMoveTick: tick,
    /* 基准由**首包**定(见 `normalizeClientTick`);抵达此刻还没有任何一包。 */
    clientTickBase: null,
    lastRawClientTick: null,
    authorityDrift: 0,
    staleRejections: 0,
    window: [{ tick, x, y }],
    lastAttackTick: -9999,
    score: 0,
    violations: [],
    kicked: false,
    usedSourceTokens: new Set<string>(),
    usedSourceTick: -1,
  };
}

/**
 * 记一条违规:入**有界**流水 + 加分(达阈值即标记踢出)。
 *
 * ★ WS-FND-137 P2:`s.violations` 修前**只进不出** —— 它的消费者只有诊断/断言
 * (WS-07 读 `.length` / `.some(...)`),但数组本身挂在房间状态里,
 * 一个反复触发抖动的在线玩家会让它随在线时长线性涨。
 * ⇒ 现在是**有界窗口**:超过 `VIOLATION_KEEP_PER_PLAYER` 先丢最旧一条。
 *
 * ⚠️ 为什么用 `shift()` 而不是环形:`violations` 是**外部可读的公开字段**
 * (`PlayerAntiCheatState` 的一部分,测试直接 `.length` / `.some(...)`),
 * 改成环形结构会改掉它的形状。这里的量级是「违规次数」(抖动级,通常个位数),
 * 而 `shift()` 只在**到顶之后**才发生 ⇒ 摊还成本可忽略。
 * 房间级那条 32Hz 热路径用的是真环形(`AntiCheatRoom.pushViolation`)。
 */
function record(s: PlayerAntiCheatState, v: Violation): void {
  if (s.violations.length >= VIOLATION_KEEP_PER_PLAYER) s.violations.shift();
  s.violations.push(v);
  s.score += v.weight;
  if (s.score >= VIOLATION_SCORE_KICK) s.kicked = true;
}

/** 每帧末的分数衰减,让偶发抖动不会攒成踢出。 */
export function decayScore(s: PlayerAntiCheatState): number {
  s.score = Math.max(0, s.score - VIOLATION_SCORE_DECAY_PER_TICK);
  return s.score;
}

/**
 * 推进单个玩家的**服务端时钟**水位到 `tick`(单调)。
 *
 * `s.lastTick` 只能经这一处写入 —— 它是「同一帧内重复兑现额度」的闸门,
 * 一旦允许别处(尤其是 `checkMove`)写它,闸门就归攻击者控制
 * (见 `MAX_MOVE_CATCHUP_TICKS`)。`AntiCheatRoom.tick()` 循环调用本函数,
 * 调用方与测试共用**同一份**推进逻辑,不另写第二份。
 */
export function advanceServerClock(s: PlayerAntiCheatState, tick: number): void {
  s.lastTick = Math.max(s.lastTick, tick);
}

/* ── ★ WS-FND-135(P1):移动窗口的**快照 / 回滚** ──
 *
 * ## 为什么需要它(第九轮实测)
 *
 * `checkMove` 在**放行**时会把三件事一起推进:
 * ```
 * s.window.push(申报坐标)        窗口式移速的时间轴(时间戳 = `s.lastTick`,见 §6.2)
 * s.lastX / lastY / lastZ        下一包「跳变」比较的基准
 * s.lastMoveTick                 下一包「额度」的基准(单调)
 * ```
 * 而 `room.ts#applyMove` 修前是**先推进、后写世界**,且 `host.applyPlayerMove` 的
 * 返回值**被丢弃**。世界在倒地 / 眩晕 / 被困 / 击退窗口拒收坐标时:
 * ```
 * 刚体位置 : 原地(世界没接受)
 * 反作弊水位: 已到申报坐标(幻影)
 * ⇒ 下一包按幻影坐标算位移 —— 合法玩家被误判 TELEPORT / SPEED,而攻击者只要
 *   「先撞一次世界闸」就能把水位推到任意远处
 * ```
 * ⇒ 世界拒收时必须把这组字段**一起**回滚。回滚的是**窗口与水位**,
 * **不含** `violations` / `score`(那是判定的事实,不是位置事实)。
 *
 * 快照是**浅结构 + 窗口元素的逐点拷贝**:`checkMove` 会 `push` / `shift`
 * 那张数组,共享引用会被后续 `shift` 悄悄改掉。
 */
export interface MoveWindowSnapshot {
  lastX: number;
  lastY: number;
  lastZ: number;
  lastMoveTick: number;
  window: { tick: number; x: number; y: number }[];
}

/** 取一份 `checkMove` 会改动的字段快照(见上文)。 */
export function snapshotMoveWindow(s: PlayerAntiCheatState): MoveWindowSnapshot {
  return {
    lastX: s.lastX,
    lastY: s.lastY,
    lastZ: s.lastZ,
    lastMoveTick: s.lastMoveTick,
    window: s.window.map((p) => ({ tick: p.tick, x: p.x, y: p.y })),
  };
}

/**
 * 把快照写回(**只回滚窗口与水位**)。
 *
 * 单调性照旧:`lastMoveTick` 回滚后**不会**低于进入本次移动之前的值 ——
 * 快照就是那个值,故不存在「回滚把水位拉回去 ⇒ 重复兑现额度」这一路。
 */
export function restoreMoveWindow(s: PlayerAntiCheatState, snap: MoveWindowSnapshot): void {
  s.lastX = snap.lastX;
  s.lastY = snap.lastY;
  s.lastZ = snap.lastZ;
  s.lastMoveTick = snap.lastMoveTick;
  s.window = snap.window.map((p) => ({ tick: p.tick, x: p.x, y: p.y }));
}

/**
 * 把客户端声明的加成**一律化为有界的有限数**。
 *
 * ## 为什么必须有这一步(WR-14 U2-b,真缺陷)
 *
 * 声明值会被喂进 `Math.min/Math.max` 算阈值,而 `Math.max(0, {})` = **`NaN`** ——
 * 之后 `dist > NaN`、`since < NaN` **恒为 `false`**,于是
 * **瞬移 / 窗口均速 / 攻速三道检查同时静默失效**:
 * 单帧跳 200 格会被**直接放行**。
 *
 * 这条路经**真实可达**:`{"speedMul":{}}` / `{"speedMul":"abc"}` 经 JSON 反序列化
 * 即进入 `room.colyseus.ts` 的 `onMessage`;TS 的 `speedMul?: number`
 * **只是编译期标注,不产生运行时校验**,拦不住。
 *
 * ## 兜底为什么取 `fallback`(「未声明」默认值)而不是 0
 *
 * 取 `0` 会让 `allowed = 0`,把该玩家的**每一次**移动都判成瞬移 ——
 * 等于用一个坏输入把自己锁死(自我拒绝服务)。取 `fallback` 则退化为
 * 「没有声明加成」,该玩家仍按基线正常移动。
 *
 * 兜底**不构成放水面**:声明一个合法的上限值(如 `2.55`)得到的结果与兜底完全相同,
 * 作弊者没有动机发非法值;而非法值不再让任何检查失效。
 *
 * ## 为什么只对 `NaN` / `-Infinity` 兜底,而 `+Infinity` 仍旧钳到 `max`
 *
 * `+Infinity` 经 `Math.min` 本来就被钳到 `max` —— 这是**安全**的(等于「申请最大加成」),
 * 属于既有正确行为,不该改;改了反而是无谓回归。
 * 真正有害的只有两个:`NaN` 让比较恒 false(绕过),`-Infinity` 钳成 `0` 会锁死自己。
 */
function sanitizeMul(declared: unknown, fallback: number, max: number): number {
  if (typeof declared !== 'number') return fallback;
  if (Number.isNaN(declared) || declared === Number.NEGATIVE_INFINITY) return fallback;
  return Math.min(Math.max(0, declared), max);
}

/**
 * 校验并**合并**外部传入的限值。
 *
 * ## ★★★ 为什么必须有这一步(CR-27:契约缺守卫 ⇒ fail-open)
 *
 * 构造器此前是 `this.limits = limits`,**对传入值不做任何检查**。
 * 于是传入非对象或**部分对象**时:
 * ```
 * limits.maxMoveCatchupTicks == undefined
 * ⇒ claimedTick = min(intent.tick, lastMoveTick + undefined, lastTick + undefined) = **NaN**
 * ⇒ dtTicks = Math.max(0, NaN) = NaN
 * ⇒ allowed = 0.36 * NaN = **NaN**
 * ⇒ `dist > NaN + 1e-9` **恒 false**  ⇒ **全部放行**
 * ```
 *
 * ## 实测(本仓复现,攻击 = `{tick:1e9, x:1e5}` 瞬移 10 万格)
 * ```
 * new AntiCheatRoom()                       ⇒ 拒绝 ✓
 * new AntiCheatRoom(DEFAULT_LIMITS)         ⇒ 拒绝 ✓
 * new AntiCheatRoom('not-an-object')        ⇒ ★ allowed=true  fail-open
 * new AntiCheatRoom({speedWindowTicks:20})  ⇒ ★ allowed=true  fail-open
 * new AntiCheatRoom(null)                   ⇒ 抛 TypeError(崩溃,非放行)
 * new AntiCheatRoom(42) / ({}) / 字段=undefined / 字段=NaN ⇒ ★ 全部 fail-open
 * ```
 *
 * ## ★ 比 Lead 描述的**更广**:不是单个字段,是**整个类型缺值域门**
 *
 * 逐字段注入 `NaN` 后,**8 个字段全部**让它负责的那道检查静默失效:
 * ```
 * maxMoveCatchupTicks  ⇒ claimedTick = NaN        ⇒ 瞬移放行
 * teleportSlack        ⇒ allowed = NaN            ⇒ 瞬移放行
 * maxSpeedBonusMul     ⇒ cap = NaN                ⇒ 瞬移放行
 * speedWindowTicks     ⇒ cutoff = NaN             ⇒ 窗口检查失效
 * speedWindowTolerance ⇒ cap = NaN                ⇒ 窗口检查失效
 * baseAttackIntervalS  ⇒ minInterval = NaN        ⇒ 同帧 10 连发全放行
 * maxAttackSpeedBonus  ⇒ bonus = NaN              ⇒ 同上
 * maxItemDeltaPerTick  ⇒ Math.abs(net) > NaN = false ⇒ 单帧刷 1000 件放行
 * ```
 * ⚠️ 测 `speedWindow*` 时我第一版探针**自己踩了坑**:攻击构造被 **TELEPORT
 *    抢先拦下**,窗口检查根本没走到 ⇒ 误判成"仍安全"。修正构造(走 1.3 倍速、
 *    声明 mul=1,恰好通过单帧而上窗口)后同样 fail-open。
 *    ⇒ 这正是本仓那条纪律:**注入物必须是缺陷本体**,打在"被别的检查抢先
 *      命中的一侧"测不出来。
 *
 * ## 定性:契约缺守卫,**不是当前可利用缺陷**
 * ```
 * 生产调用点只有 room.ts 的 `new AntiCheatRoom()`(不传参)⇒ 当前不可达。
 * 与 `mobHitDamage` 同类(ARCH-GAPS 第五层):缺守卫,非当前可利用。
 * ```
 * ⇒ 但仍要修:**一个只在"将来有人传参"时才显形的洞,永远不会被自己发现**。
 *
 * ## 取值策略:**逐字段 fail-closed 到默认值**(不是 fail-fast 抛错)
 *
 * ```
 * fail-fast(抛错)的理由:坏配置是**开发者错误**,应尽早暴露。
 * fail-closed(兜默认)的理由:反作弊在**每帧热路径**上,抛错会
 *   把「一个字段写错」升级成「房间整帧崩掉」—— 而崩溃的房间
 *   **不检查任何东西**,比"用默认限值继续检查"更不安全。
 * ⇒ 取 **fail-closed**,但**不静默**:见下面的 `limitsReported`。
 * ```
 * ⚠️ 为什么必须"不静默":兜默认若无声,就成了**又一处静默降级** ——
 *    传错字段的人永远不知道自己传错了,而限值悄悄变回默认。
 *    ⇒ 故合并结果**可读回**(`AntiCheatRoom.limits` 是合并后的值),
 *      且非法字段被记进 `limitsIssues` 供断言与诊断。
 *
 * ## 什么算非法
 * ```
 * · 整个 limits 不是对象(null / 字符串 / 数字)⇒ **整体**回退 DEFAULT_LIMITS
 * · 单字段 非 number / NaN / ±Infinity / 负数 ⇒ **该字段**回退默认
 *   (⚠️ 0 是**合法**值:它表达"零容忍",是一个真实的策略选择,不是坏值)
 * · 未知字段 ⇒ 忽略(不报错:结构化传入允许多余键)
 * ```
 */
export function mergeLimits(limits: unknown): { limits: AntiCheatLimits; issues: string[] } {
  const issues: string[] = [];
  /* 整体不是对象 ⇒ 全部回退。`null` 此前会抛 TypeError,这里一并收下。 */
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    const shown = limits === null ? 'null' : `${typeof limits} ${String(limits).slice(0, 24)}`;
    issues.push(`limits 不是对象(${shown})⇒ 全部回退 DEFAULT_LIMITS`);
    return { limits: { ...DEFAULT_LIMITS }, issues };
  }
  const src = limits as Record<string, unknown>;
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof AntiCheatLimits)[]) {
    if (!(key in src)) {
      issues.push(`${key} 缺失 ⇒ 回退默认 ${DEFAULT_LIMITS[key]}`);
      continue;
    }
    const v = src[key];
    /* ⚠️ 只接受**有限非负数**。`0` 合法(见上文);`NaN`/`±Infinity`/负数/非 number 全拒。 */
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      issues.push(`${key}=${String(v)} 非法(需有限非负数)⇒ 回退默认 ${DEFAULT_LIMITS[key]}`);
      continue;
    }
    out[key] = v;
  }
  return { limits: out, issues };
}

/**
 * 单帧允许的最大位移(格/帧)。
 * 位移上界 = maxSpeed(声明倍率)× **标称帧步长 `FRAME_SECONDS`** × `teleportSlack`,
 * 再乘 `dtTicks`(见 `checkMove`)。
 *
 * ★ 帧步长由 `TICK_HZ` 推导 ⇒ 改 tick 率只**重标定每帧额度**,
 * **每秒额度不变**:`maxDisplacementPerTick / FRAME_SECONDS` 恒 = maxSpeed × slack
 * (20Hz ⇒ 4.5 × 1.6 = 7.2 格/秒;32Hz ⇒ 同一读数)。若这里跟着旧帧长走,
 * 32Hz 下每帧额度会**偏大 1.6 倍**(等于把 slack 悄悄放大到 2.56)。
 *
 * 声明倍率先经 `sanitizeMul` 兜底 —— 否则非法声明会让本函数返回 `NaN`,
 * 使调用方的 `dist > allowed` 恒为 false(见 `sanitizeMul` 说明)。
 */
export function maxDisplacementPerTick(speedMul = 1, limits: AntiCheatLimits = DEFAULT_LIMITS): number {
  const mul = sanitizeMul(speedMul, 1, limits.maxSpeedBonusMul);
  return BASE_MOVE_SPEED * mul * FRAME_SECONDS * limits.teleportSlack;
}

/** 校验一次移动意图。
 *
 * `dtSeconds` = §6.2 窗口**分母**用的帧间隔(秒),缺省标称 `DT`。由调用方注入**实测**
 * 节拍 —— 宿主定时器粒度 > 标称帧步长的机器上这是一个真差别(见 `DEFAULT_FRAME_DT_SECONDS`)。
 * 它只影响分母;`dtTicks` 额度与单帧跳变上界仍按标称 `DT` 记账(**未动**)。
 */
export function checkMove(
  s: PlayerAntiCheatState,
  intent: MoveIntent,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
  maxZ = 3,
  dtSeconds = DEFAULT_FRAME_DT_SECONDS,
): Verdict {
  /* ── 6.0 值域门:非有限值一律拒绝 ──
   *
   * `Math.max(0, {})` / `Math.max(0, "abc")` / 字段缺失 ⇒ `NaN`,而
   * **`NaN` 的任何比较恒为 `false`** ⇒ 下面的 `dist > allowed + 1e-9` 会静默失效。
   * 与 `sanitizeMul` 兜底 `speedMul` 是**同一族的坑**(CR-14 U2-b),只是这里
   * 落在坐标与自报帧号上。
   *
   * `+Infinity` 现在**碰巧**被拦(`Infinity > 0.36` 为真)—— 那是巧合,不是设计:
   * 它靠的是比较运算符的行为,一旦上界算式的形态变化就会失守。
   * 故这里用 `Number.isFinite` 显式判定,不依赖「比较恰好为真」。
   *
   * 实测(WS-07 `E09` 族):若不设此门,`{x: NaN}` 与 `{}`(字段缺失)
   * 都能让一条报文**无条件放行**,且被写进 `s.lastX` ⇒ 下一条报文
   * 的 `dist` 仍是 `NaN` ⇒ 反作弊在该玩家身上持续失明。
   */
  if (
    !Number.isFinite(intent.tick) || !Number.isFinite(intent.x)
    || !Number.isFinite(intent.y) || !Number.isFinite(intent.z)
  ) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: Number.isFinite(intent.tick) ? intent.tick : s.lastTick,
      playerId: s.id,
      detail: `非有限坐标/帧号被拒:tick=${intent.tick} x=${intent.x} y=${intent.y} z=${intent.z}`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return {
      allowed: false,
      corrected: { x: s.lastX, y: s.lastY, z: s.lastZ },
      violation: v,
    };
  }

  /* ── 6.0b 帧号:两个水位,一处夹取 ──
   *
   * `MoveIntent.tick` 是客户端自报值(CR-14 U1 同族:客户端输入一律是「申请」)。
   * 它同时决定两件事:单包位移额度(`dtTicks` **线性放大**上界)与窗口检查的
   * 时间轴。原实现把它们都挂在 `s.lastTick` 一个字段上,而该字段**同时被
   * `checkMove` 和 `tick()` 写** ⇒ 「上限」和「已用」是同一个量,攻击者每包把
   * 上限往前推一格再兑现一格,单帧即可灌满任意位移(实测 20 包 18.36 格、0 分)。
   *
   * 现在拆成两个单调水位,各自只有一个写者:
   *
   *   claimedTick = min(intent.tick, s.lastMoveTick + MAX, s.lastTick + MAX)
   *                 └ 自报值        └ 斜率:单包不能跳太远  └ **服务端时钟:硬上限**
   *
   * ⚠️ **此处是唯一夹取点**。`claimedTick` 在下游被使用多过一处
   * (跳变检查、窗口入队、`cutoff`、`spanTicks`、回写水位),
   * 逐处夹取**漏掉任何一处都会让整条检查失明** —— 所以夹在入口,
   * 之后**一律使用 `claimedTick`**,不再引用 `intent.tick`。
   * 调用方(`room.ts` / `room.colyseus.ts`)**不再重复夹取** ——
   * 两侧都夹会重演「两份等效实现」(task-51 J13 形态)。
   *
   * `s.lastTick` 是 `AntiCheatRoom.tick()` 每帧写入的服务端帧号,攻击者
   * **发报文改不动它**,所以它是「同一帧内重复兑现」的闸门:
   * 同一帧内 `lastMoveTick` 最多被推到 `lastTick + MAX` 就再也拿不到额度。
   */
  const claimedTick = Math.min(
    intent.tick,
    s.lastMoveTick + limits.maxMoveCatchupTicks,
    s.lastTick + limits.maxMoveCatchupTicks,
  );
  /* 额度 = 自报水位之上的增量,**下界 0 而非 1**。
   *
   * 原式 `Math.max(1, …)` 的下界是「每包至少兑现 1 帧」——
   * 报文条数因而**线性放大**总位移:同一 tick 连发 50 包 = 45.9 格且违规分恒 0。
   * 改为 0 后,重复/回退的帧号拿不到额度:位移为 0 的重复包仍放行(心跳无害),
   * 而带位移的重复包被判坐标跳变。
   *
   * 这**故意改变了**「报旧帧仍按 1 帧放行」的旧行为 ——
   * 旧行为正是漏洞的一半,保留它等于保留一半缺口。WS-07 `E14e` 已按新语义重写。
   */
  const dtTicks = Math.max(0, claimedTick - s.lastMoveTick);
  const dist = Math.hypot(intent.x - s.lastX, intent.y - s.lastY);
  const dz = Math.abs(intent.z - s.lastZ);
  const allowed = maxDisplacementPerTick(intent.speedMul ?? 1, limits) * dtTicks;

  /* ── 6.1 坐标跳变 ── */
  if (dist > allowed + 1e-9) {
    /* ★ **分类**(不是放宽):世界会在 `checkMove` **之外**自己挪刚体 ——
       击退(`vitals` 的 `knockbackPerSec`)、互相挤出的碰撞分离(`resolvePairs`)、
       落地沉降、台阶抬升。而客户端那一包是**按它读到投影那一刻**起算的,入口重锚却把
       `lastX/lastY` 钉到**此刻**的权威刚体 ⇒ `dist = |step − W|`(`W` = 上面那些服务端位移)。
       三角形不等式:`|step − W| ≤ |step| + |W|`,所以「这一包超限」**并不**
       说明客户端多走了 —— 只要 `dist ≤ 额度 + W`,客户端的步长就仍在额度内,
       多出来的部分全是**服务端自己的动作**。

       ⇒ 归入 `stale`:照样拒绝(陈旧申报不许覆盖权威刚体,否则一次击退会被客户端的
       迟到包抹掉),但**不计违规、不加分、不进流水**。修前它一律记 TELEPORT ⇒
       诚实玩家被记成作弊者(60 分钟实测:8 客户端堆叠时每 60 分钟 63 条假阳性)。

       ⚠️ 取舍(如实登记):`W` 是**服务端侧可触发**的事件 ⇒ 作弊者能靠「挨一下击退」
       在**那一个包**上多拿 `W` 的余量,而 `W` 由物理给出(击退上界 2 格 / 碰撞分离
       每帧 ≈0.02 格),不是攻击者能自由放大的量。单帧上界、窗口均速、Z 值域三道判据
       一字未动。判据:`tests/WS-FND-178` 的 `FND178-10`(正例认得出 `stale`;反例:
       `dist` 超过 `额度 + W` 时仍是 TELEPORT **且计分**)。 */
    const drift = Number.isFinite(s.authorityDrift) && s.authorityDrift > 0 ? s.authorityDrift : 0;
    if (drift > 0 && dist <= allowed + drift + 1e-9) {
      s.staleRejections += 1;
      return {
        allowed: false,
        corrected: { x: s.lastX, y: s.lastY, z: s.lastZ },
        stale: true,
      };
    }
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: claimedTick,
      playerId: s.id,
      detail: `单帧位移 ${dist.toFixed(3)} 格 > 上界 ${allowed.toFixed(3)}`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return {
      allowed: false,
      corrected: { x: s.lastX, y: s.lastY, z: s.lastZ },
      violation: v,
    };
  }
  if (intent.z < -1 - 1e-9 || intent.z > maxZ + 1e-9) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: claimedTick,
      playerId: s.id,
      detail: `Z=${intent.z} 越界 [-1, ${maxZ}]`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
  }
  void dz;

  /* ── 6.2 窗口式移速 ──
   * ★ WS-FND-172(P1):窗口的**时间轴 = 服务端时钟 `s.lastTick`**,不是自报 `claimedTick`。
   *
   * 病理:额度按**帧**发(`dtTicks × maxDisplacementPerTick`),而窗口时间轴此前走
   * `claimedTick` —— 后者被 `lastMoveTick + MAX` 夹住,同一帧内每发一条最多只推进
   * `MAX = 1` ⇒ `spanTicks ≈ 报文条数`,而分母 `spanS = spanTicks × DT` 却按
   * 「1 tick = 50ms」记账。于是合法速度被读成 `S_obs = S × 20/min(f_c, f_s)`
   * (`f_c` = 报文率,`f_s` = 服务端帧率):**报文率低于标称**时(客户端 15.93Hz、
   * 服务端 20Hz),4.5 格/秒的满速合法玩家被算成 5.65 > 上限 5.625。实测旧轴判
   * 1 次 SPEED、新轴 0 次(WS-FND-172 `FND172-2`)。
   * 锚到 `s.lastTick` 后,窗口的时间轴与额度**同一个时钟**,`min` 里的 `f_c` 那一项消失;
   * 抬高自报 `tick` 也不再能推动时间轴(判据 `FND172-5`)。
   *
   * ★ 分母不再写死标称 `DT`(★ 本轮修点):新增**可注入的帧间隔**,
   * 注入点 `AntiCheatRoom.setFrameIntervalMs()` / `tick(t, frameMs)`
   * (见 `DEFAULT_FRAME_DT_SECONDS` 的口径与残留)。调用方每帧传**实测**间隔后:
   * 服务端真跑到 15.93Hz(62.77ms/帧)时,窗口跨的 20 帧 = 1.2555 秒真实时间,
   * 分母随之 = 1.2555 秒 ⇒ 满速裸装合法玩家读出 **4.5**(不再被误判 SPEED)。
   * ⚠️ **不注入 = 缺省 `DT`** ⇒ 逐位保持既有判据 —— `FND172-3` 登记的误判
   * (5.65 > 5.625)在未接线的房里照旧成立,不是「已消失」。
   *
   * ⚠️ 同一帧内的多条报文落进**同一个 `lastTick`** ⇒ `spanTicks = 0` ⇒ 上面的窗口
   * 检查看不到时间流逝。**这一支已修**(★ 本轮**只动这一支**):见下面 §6.2b 的零跨度
   * 分支 —— 按「最小可判跨度 = 1 帧」结算同帧累计路径,判据 `FND172-10` / `FND172-13`。
   * 额度/跳变逻辑(上面的 `claimedTick` / `dtTicks` / `allowed`)**仍是一字未动**。 */
  s.window.push({ tick: s.lastTick, x: intent.x, y: intent.y });
  const cutoff = s.lastTick - limits.speedWindowTicks;
  while (s.window.length > 2 && s.window[0].tick < cutoff) s.window.shift();

  const first = s.window[0];
  const spanTicks = s.lastTick - first.tick;
  if (spanTicks >= limits.speedWindowTicks) {
    const path = pathLength(s.window);
    /* ★ 分母 = `spanTicks × 帧间隔`。帧间隔取**调用方实测/注入**的值
       (见 `DEFAULT_FRAME_DT_SECONDS`),缺省才是标称 `DT`。
       非法注入(非有限 / ≤ 0)一律回退缺省:分母偏小 ⇒ 观测均速偏大 ⇒
       **fail-closed**(宁可多判,不可失明) —— 与 `sanitizeMul` 同取向。
       仅**分母**走这个值;`dtTicks` 额度与单帧跳变上界仍按标称 `DT` 记账(**未动**)。 */
    const frameDt = Number.isFinite(dtSeconds) && dtSeconds > 0
      ? dtSeconds
      : DEFAULT_FRAME_DT_SECONDS;
    const spanS = spanTicks * frameDt;
    const observed = path / spanS;
    const cap = BASE_MOVE_SPEED * sanitizeMul(intent.speedMul ?? 1, 1, limits.maxSpeedBonusMul)
      * limits.speedWindowTolerance;
    if (observed > cap + 1e-9) {
      const v: Violation = {
        kind: ViolationKind.SPEED,
        tick: claimedTick,
        playerId: s.id,
        detail: `窗口均速 ${observed.toFixed(2)} 格/秒 > 上限 ${cap.toFixed(2)}`,
        weight: VIOLATION_WEIGHT.SPEED,
      };
      record(s, v);
      return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
    }
  }

  /* ── 6.2b ★ 零跨度:同一帧内的多条报文 ⇒ 按**最小可判跨度**结算 ──
   *
   * 病理(本分支要堵的口子):窗口的时间轴是**服务端帧号**,同一帧内连发的报文全落
   * **同一个 `lastTick`** ⇒ `spanTicks = 0` ⇒ 上面的窗口检查看不到「时间流逝」;
   * 而额度是按帧发的(静默 T 帧就攒 T+1 帧)⇒ 攻击者只要「静默 ≥ 一整个窗口 +
   * 同帧连发」,积压就能一次兑现,且窗口与跳变两道检查**都放行**:
   *   实测(间隔 22 帧 / 每轮 22 包 × 0.918 格 / 20 轮)⇒ **17.56 格/秒、0 违规、0 踢**
   *   (旧口径下同一输入 0.76 格/秒,且第 1 轮即被判 SPEED)。
   * ⇒ `spanTicks === 0` **不能**读成「无法判断 ⇒ 放行」,那就是失明。
   *
   * ## 判据一:突发必须被抓 —— 结算跨度 = **最小可判跨度 1 帧**
   *
   * 帧号时钟能分辨的最小跨度就是 **1 帧**,所以同帧内的累计路径一律按「在一帧内走完」
   * 结算,与窗口上限(含 `speedWindowTolerance`)比 —— **不是**按被 `cutoff` 剪掉的
   * 静默段去稀释(稀释正是失明的原形态)。
   * 突发第 2 包即命中:`0.918 / 0.05 = 18.36 > 14.34`(满加成上限)。
   *
   * ## 判据二(**不同**的量):触发条件 = 申报水位**落后整整一个窗口**
   *
   * `s.lastTick - s.lastMoveTick >= speedWindowTicks` 才是「静默后突发」的指纹:
   * 诚实客户端每帧一报,申报水位与时钟只差 0~1 帧 ⇒ 本分支不参与;
   * 零位移的重复/心跳包累计路径 = 0 ⇒ 永不命中;连续流里的同帧双发
   * (`spanTicks > 0`)走上一条正常分支。三种合法形状各由**不同**的量区分,
   * 不是同一条判据的松紧 —— 判据见 `FND172-10`(静默后突发必须违规)/ `FND172-13`(同帧合法连发不违规)。
   *
   * 为什么不塞进 TELEPORT:那条的 detail 是「单帧位移 X > 上界 Y」,而突发里**每一包**
   * 都在自己的额度内(X ≤ Y)⇒ 逐包判会把一条**虚假的**越界写进流水,归因失真。
   * 真正被违反的是**均速**,归因应是 SPEED。
   * 跨度口径与 §6.2 分母**同一个注入量**(实测帧间隔,缺省标称 `DT`)。
   */
  if (spanTicks === 0 && s.lastTick - s.lastMoveTick >= limits.speedWindowTicks) {
    const minSpanS = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : DEFAULT_FRAME_DT_SECONDS;
    const burstPath = pathLength(s.window);
    const burstObserved = burstPath / minSpanS;
    const burstCap = BASE_MOVE_SPEED * sanitizeMul(intent.speedMul ?? 1, 1, limits.maxSpeedBonusMul)
      * limits.speedWindowTolerance;
    if (burstObserved > burstCap + 1e-9) {
      const v: Violation = {
        kind: ViolationKind.SPEED,
        tick: claimedTick,
        playerId: s.id,
        detail: `窗口均速 ${burstObserved.toFixed(2)} 格/秒 > 上限 ${burstCap.toFixed(2)}`
          + `(同帧突发:跨度按最小 1 帧结算;申报水位落后 ${s.lastTick - s.lastMoveTick} 帧)`,
        weight: VIOLATION_WEIGHT.SPEED,
      };
      record(s, v);
      return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
    }
  }

  s.lastX = intent.x;
  s.lastY = intent.y;
  s.lastZ = intent.z;
  /* 只推进**客户端申报**水位,且单调。绝不碰 `s.lastTick`(服务端时钟)——
     那正是原实现被客户端推着走、越推额度越大的病灶。
     `Math.max` 保证回退的 tick 不会把水位拉回去(否则连发「tick 在 1 与 0 之间
     跳动」的报文可反复重置水位,每包重新拿到 MAX 额度)。 */
  s.lastMoveTick = Math.max(s.lastMoveTick, claimedTick);
  return { allowed: true };
}

function pathLength(win: readonly { x: number; y: number }[]): number {
  let d = 0;
  for (let i = 1; i < win.length; i += 1) {
    d += Math.hypot(win[i].x - win[i - 1].x, win[i].y - win[i - 1].y);
  }
  return d;
}

/**
 * 校验一次攻击。最小间隔 = `baseAttackIntervalS / (1 + 攻速加成)`;加成被服务端上限钳制。
 *
 * ⚠️ 「钳制」≠「核算」:声明 `1.0` 即拿满 2× 攻速且**不需要任何装备前置**
 * (CR-14 U2 的已知取舍)。服务端**不**核对声明是否与持有物相符 ——
 * 它没有装备数据可核。见 `MoveIntent.speedMul` 注释与 §7。
 *
 * ★ WS-FND-135(P3):本函数是**判定 + 提交**的合体形态(给「判定即生效」的调用方用)。
 * 需要「先判定、结算成功后才提交」的调用方(`RoomRuntime.applyAttack`)必须用
 * `previewAttack` + `commitAttack` 两步 —— 见那对函数的 docblock。
 */
export function checkAttack(
  s: PlayerAntiCheatState,
  tick: number,
  claimedAttackSpeedBonus = 0,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): Verdict {
  const v = previewAttack(s, tick, claimedAttackSpeedBonus, limits);
  if (v.allowed) commitAttack(s, tick);
  return v;
}

/**
 * ★ WS-FND-135(P3):攻速闸的**判定**(**不**推进 `lastAttackTick`)。
 *
 * ## 为什么必须与提交分开(第九轮实测)
 *
 * 修前房间入口是**先提交、后结算**:`applyAttack` 第一行就把 `lastAttackTick`
 * 推到当前 tick,之后才 world 侧结算。于是三种**什么都没打出去**的情形
 * 白占 8 帧冷却(基线 `baseAttackIntervalS = 0.4s` = **8 帧**):
 * ```
 * · 没有世界(host === null)或报文没带 mobId ⇒ 只记账、零结算
 * · 世界侧 `rejected === 'NO_SKILL'`(按了 Q 但武器没技能)⇒ 零伤害
 * · 世界侧 `outOfReach`(超射程)⇒ 零伤害
 * ```
 * 表现是「按了没反应,还得再等 8 帧」—— 玩家看到的是一次**凭空丢掉的攻击**。
 *
 * ## 违规记账不受影响
 *
 * 间隔不够 ⇒ 照旧 `record(s, v)`(ATTACK_RATE 是**事实**,与结算成不成功无关),
 * 只是不再顺手把水位往前推 —— 否则「连点两次都被拒」会让水位越推越远。
 */
export function previewAttack(
  s: PlayerAntiCheatState,
  tick: number,
  claimedAttackSpeedBonus = 0,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): Verdict {
  const bonus = sanitizeMul(claimedAttackSpeedBonus, 0, limits.maxAttackSpeedBonus);
  const minIntervalTicks = (limits.baseAttackIntervalS / (1 + bonus)) * TICK_HZ;
  const since = tick - s.lastAttackTick;
  if (since < minIntervalTicks - 1e-9) {
    const v: Violation = {
      kind: ViolationKind.ATTACK_RATE,
      tick,
      playerId: s.id,
      detail: `攻击间隔 ${since.toFixed(2)} 帧 < 最小 ${minIntervalTicks.toFixed(2)} 帧`,
      weight: VIOLATION_WEIGHT.ATTACK_RATE,
    };
    record(s, v);
    return { allowed: false, violation: v };
  }
  return { allowed: true };
}

/**
 * ★ WS-FND-135(P3):提交攻速冷却水位 —— **只在这次攻击真的结算了之后**调用。
 *
 * 单调(`Math.max`)而不是直接赋值:修前是 `s.lastAttackTick = tick`,而 `tick`
 * 是**客户端申报**值 —— 申报一个更小的 tick 就能把水位**往回**拉,下一次攻击
 * 立刻又满足间隔。这与 `lastMoveTick` 的纪律(只进不退)是同一族。
 */
export function commitAttack(s: PlayerAntiCheatState, tick: number): void {
  s.lastAttackTick = Math.max(s.lastAttackTick, tick);
}

/* ═══════════════════════════ 5. 物品栏一致性 ═══════════════════════════ */
/* ─── 5.0 产出凭证(source):绑定 (actor, itemId, 用途) + 一次性 ───
 *
 * ## 修前(审计 P0-2,实测)
 * `checkInventory` 只判 `allowedSources.has(source)`,集合里装的是**裸字符串**。
 * 产出侧登记 `break:${x},${y}:${objId}`,而扣减侧照抄客户端报的 `itemId`
 * ⇒ 那个串**客户端完全可推算**(它刚在 (x,y) 拆了块),于是
 *   `{ itemId: 733, delta: 999, source: 'break:3,4:101' }`
 * 一路放行 —— 一张凭证铸任意物品。第二个洞:`grantItemSource` 从不失效
 * (`expireItemSources()` 全仓零调用),凭证跨 tick 累积、可无限复用。
 *
 * ## 修法:凭证是**绑定令牌**,不是名字
 *   1 服务端铸:`mintItemSourceToken({ actorId, itemId, purpose, tick })`;
 *   2 令牌**自述**绑定,并由进程内随机密钥做 MAC —— 客户端改任何一位
 *     (换 itemId / 换行为人 / 换 tick / 换用途)都是伪造,猜不出也算不来;
 *   3 `checkInventory` 校验四元组 + **一次性**(同一 tick 内同一令牌只用一次);
 *   4 令牌带 tick ⇒ 「过期」是**判据**保证的,不依赖谁记得去调清理函数。
 *     `RoomRuntime.expireItemSources()` 仍应在动作/tick 边界调用,理由是内存
 *     (未消费的令牌会留到房间销毁),**安全性不依赖它** —— 见 `tests/WS-FND-87`。
 *
 * ⚠️ 兼容口:非令牌形态的 source(测试夹具 `seed:101:1` 这类)仍走旧口径
 *   —— 它只能由**服务端自己** `grantItemSource` 注入;生产产出点已全部改为
 *   `bindItemSource`(裸调用 **0 处**,由 `tests/WS-FND-87` 的静态判据钉住)。
 */
export const ItemSourcePurpose = {
  /** 百货店成交 */
  PURCHASE: 'purchase',
  /** 合成产物 */
  CRAFT: 'craft',
  /** 拆块掉落 */
  GATHER: 'gather',
  /** 捡地面那件 */
  PICKUP: 'pickup',
  /** 从箱子里取出 */
  CHEST_TAKE: 'chest-take',
  /** 使用道具未生效时的退回 */
  USE_REFUND: 'use-refund',
  /** 放块失败时的退回 */
  PLACE_REFUND: 'place-refund',
  /** 产物收不下时退回材料 */
  CRAFT_REFUND: 'craft-refund',
  /** 交差事的谢礼 */
  QUEST_REWARD: 'quest-reward',
  /** 谢礼收不下时退回交上去的东西 */
  QUEST_REFUND: 'quest-refund',
} as const;
export type ItemSourcePurpose = (typeof ItemSourcePurpose)[keyof typeof ItemSourcePurpose];

/** 令牌头。改它等于让在途令牌全部失效(它们本就只活一个 tick)。 */
const ITEM_SOURCE_PREFIX = 'rsi1';
/** 进程内随机密钥:令牌因此**不可推算**;重启换钥(在途令牌只活一 tick)。 */
const ITEM_SOURCE_SECRET = randomBytes(32);
const ITEM_SOURCE_PURPOSES: ReadonlySet<string> = new Set(Object.values(ItemSourcePurpose));

/** 一张产出凭证的**绑定**内容。 */
export interface ItemSourceGrant {
  actorId: string;
  itemId: number;
  purpose: ItemSourcePurpose;
  tick: number;
}

function macOf(plain: string): string {
  return createHmac('sha256', ITEM_SOURCE_SECRET).update(plain).digest('hex').slice(0, 32);
}

function plainOf(g: ItemSourceGrant): string {
  return `${g.actorId}\u0001${Math.trunc(g.itemId)}\u0001${g.purpose}\u0001${Math.trunc(g.tick)}`;
}

/**
 * (`actions/item_source.ts` 的 `bindItemSource` 是唯一入口)。
 *
 * ⚠️ 令牌里带一个**随机 nonce**(也进 MAC):同一 tick 内同一 (actor,item,purpose)
 *   可以合法地铸**多张**(连捡两件同类道具)。少了它,第二次铸会得到**同一个串**,
 *   而一次性判据会把第二次使用当成重放 —— 那是**假阳性**,不是安全。
 */
export function mintItemSourceToken(grant: ItemSourceGrant): string {
  const actor = Buffer.from(grant.actorId, 'utf8').toString('base64url');
  const nonce = randomBytes(8).toString('hex');
  return [
    ITEM_SOURCE_PREFIX,
    actor,
    Math.trunc(grant.itemId),
    grant.purpose,
    Math.trunc(grant.tick),
    nonce,
    macOf(`${plainOf(grant)}\u0001${nonce}`),
  ].join('.');
}

/** 令牌形态(不验签)。用于把「伪造」与「旧口径字符串」分开归因。 */
export function looksLikeItemSourceToken(source: string): boolean {
  return source.startsWith(`${ITEM_SOURCE_PREFIX}.`);
}

/**
 * 解析并**验签**;不是令牌形态 / 被改过 ⇒ `null`。
 *
 * 两种 `null` 由调用方区分:不是令牌形态 ⇒ 旧口径(兼容夹具);
 * 令牌形态却验签失败 ⇒ **伪造**(`ITEM_SOURCE_FORGED`)。
 */
export function parseItemSourceToken(source: string): ItemSourceGrant | null {
  if (!looksLikeItemSourceToken(source)) return null;
  const parts = source.split('.');
  if (parts.length !== 7) return null;
  const itemId = Number(parts[2]);
  const purpose = parts[3];
  const tick = Number(parts[4]);
  if (!Number.isInteger(itemId) || !Number.isInteger(tick)) return null;
  if (!ITEM_SOURCE_PURPOSES.has(purpose)) return null;
  const grant: ItemSourceGrant = {
    actorId: Buffer.from(parts[1], 'base64url').toString('utf8'),
    itemId,
    purpose: purpose as ItemSourcePurpose,
    tick,
  };
  if (macOf(`${plainOf(grant)}\u0001${parts[5]}`) !== parts[6]) return null;
  return grant;
}

export interface InventoryOp {
  itemId: number;
  /** 正数 = 获得,负数 = 消耗。 */
  delta: number;
  /**
   * 产出凭证(`mintItemSourceToken` 铸的绑定令牌)。无凭证的产出直接拒。
   * 负 delta **不需要**凭证 —— 消耗不是产出。
   */
  source?: string;
}

export interface InventoryCheckInput {
  tick: number;
  ops: readonly InventoryOp[];
  /** 服务端认可的「可产出集合」:本 tick 内登记过的凭证(客户端无法自行扩集)。 */
  allowedSources: ReadonlySet<string>;
  /** 当前背包总量(用于总量守恒)。 */
  beforeTotal: number;
  /**
   * ★ **按件权威账**(`itemId → 件数`,可选)。
   *
   * ## 为什么必须有它(只有总量判不住「扣一件自己没有的东西」)
   *
   * 只给 `beforeTotal` 时,判据只到**总量**这一维。报文
   * `{"ops":[{"itemId":733,"delta":-5}]}` 在玩家**只有 2 件 733**(而总量够)时:
   * 总量判据 `5 + (-5) = 0 ≥ 0` 放行,随后按件账被**静默夹零**
   * (`room.ts:applyItemCountDelta` 的 `next > 0 ? next : 0`)—— 凭空消耗了
   * 不存在的 3 件,一条违规都不记:「总量守恒」在这条路上**恒成立**,
   * 因为它守恒的是**别人**的件数。
   *
   * 给了这张表 ⇒ 负 delta **逐件**判「够不够」,不够即 `ITEM_NEGATIVE`
   * **拒绝**(不夹零:夹零把「扣超了」伪装成「扣到零」,正是本节要堵的形态)。
   *
   * ## 为什么是「可选」而不是「必填」
   * 单元夹具与 `AntiCheatRoom.inventory` 的直调用方只构造旧字段;不传 ⇒
   * 退回**只判总量的旧口径**,行为逐位不变。生产汇点
   * (`room.ts:applyInventory`)**总是**传它 —— 由 `tests/WS-FND-129` 钉住。
   */
  beforeByItem?: ReadonlyMap<number, number>;
  capacity: number;
}
/**
 * 拒因码。每个码对应一条**可判定的守恒律**,便于把违规流水做成指标。
 */
export const InventoryReject = {
  /** 产出没有服务端认可的来源凭证 —— 凭空产出。 */
  FROM_NOTHING: 'ITEM_FROM_NOTHING',
  /** 单帧净变化超过 `MAX_ITEM_DELTA_PER_TICK`。 */
  BURST: 'ITEM_BURST',
  /**
   * 扣减后**总量为负**,或(给了 `beforeByItem` 时)**某一件不够扣**
   * —— 两者都是「消耗了不存在的东西」,共用同一个拒因码。
   */
  NEGATIVE: 'ITEM_NEGATIVE',
  /** 超出背包容量。 */
  OVERFLOW: 'ITEM_OVERFLOW',
  /** 增量不是整数(浮点刷物品的典型手法)。 */
  FRACTIONAL: 'ITEM_FRACTIONAL',
  /**
   * `ops` 本身不是合法操作数组 —— 报文里它是**纯客户端值**,
   * 而 TS 的 `readonly InventoryOp[]` 只是**编译期声明**,运行时不做任何检查。
   */
  MALFORMED: 'ITEM_MALFORMED',
  /**
   * 令牌形态但**验签失败** —— 客户端自己拼了一个 `rsi1.…` 串(推算/伪造)。
   * 与 `FROM_NOTHING`(压根没凭证)分开归因:这一条是**伪造尝试**。
   */
  SOURCE_FORGED: 'ITEM_SOURCE_FORGED',
  /**
   * 凭证与这次 `op` **不相干**:令牌绑的 `itemId` / `actorId` 与本次操作不符
   * —— 审计 P0-2 的核心:「一张掉落凭证铸任意物品」。
   */
  SOURCE_BINDING: 'ITEM_SOURCE_BINDING',
  /** 令牌属于别的 tick —— 过期(凭证**不跨 tick**)。 */
  SOURCE_EXPIRED: 'ITEM_SOURCE_EXPIRED',
  /** 同一 tick 内同一令牌第二次使用 —— 凭证是**一次性**的。 */
  SOURCE_REUSED: 'ITEM_SOURCE_REUSED',
} as const;
export type InventoryReject = (typeof InventoryReject)[keyof typeof InventoryReject];

const INVENTORY_REJECT_LABEL: Readonly<Record<string, string>> = {
  ITEM_FROM_NOTHING: '凭空产出',
  ITEM_BURST: '单帧脉冲',
  ITEM_NEGATIVE: '总量或件数为负',
  ITEM_OVERFLOW: '容量溢出',
  ITEM_FRACTIONAL: '非整数增量',
  ITEM_MALFORMED: '操作数组格式非法',
  ITEM_SOURCE_FORGED: '凭证验签失败',
  ITEM_SOURCE_BINDING: '凭证与本次操作不符',
  ITEM_SOURCE_EXPIRED: '凭证已过期',
  ITEM_SOURCE_REUSED: '凭证重复使用',
};

export interface InventoryCheckResult {
  allowed: boolean;
  afterTotal: number;
  violation?: Violation;
  rejectCode?: InventoryReject;
}

/**
 * 物品栏一致性(逐条 ops):
 *  a) 单帧净变化量绝对值 ≤ MAX_ITEM_DELTA_PER_TICK;
 *  b) 任何**产出**(delta > 0)必须带服务端登记过的凭证;
 *  c) 凭证若是**绑定令牌**,必须属于**这个人、这一件、这个 tick,且只用一次**;
 *  d) 消耗后的总量不得为负,且不得超过容量 —— 即「总和守恒」;
 *  e) ★ **按件**守恒(给了 `beforeByItem` 时):每一条负 delta 都要有**这一件**
 *     垫底。只判 (d) 的量**判不住**「扣一件自己没有的东西」—— 扣 5 件 733 而
 *     只有 2 件,总量够就放行,按件账随后被静默夹零(见
 *     `InventoryCheckInput.beforeByItem` 的实测)。
 *
 * ⚠️ (d) 与 (e) 是**两个维度**,不能互相替代:总量够 ⇏ 每件都够(本节的形态),
 *    每件都够 ⇏ 总量不超(容量闸管的是另一个方向)。
 *
 * 检查顺序刻意把**凭证**放在最前:凭空产出是最严重的一类,不应被
 * 后面的量级检查抢先命中而失去归因。
 *
 * 同 tick 内是否用过记在 `PlayerAntiCheatState` 上(而不是入参)——
 * 一次性是**跨调用**的性质:两次 `applyInventory` 是两次调用。
 * 提交时机是**整批通过之后**:批内任一条被拒 ⇒ 一个令牌都不标记为已用
 * (调用方可以原样重试,不会因为「前两条验过了」而白丢凭证)。
 */
export function checkInventory(
  s: PlayerAntiCheatState,
  input: InventoryCheckInput,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): InventoryCheckResult {
  /* ── ops 形状门(与 checkMove 的 6.0 值域门同族)──
   *
   * `ops` 是报文里**唯一**由客户端提交的部分(`room.colyseus.ts` 的
   * `onMessage('inventory')`),而调用链中间**没有任何运行时校验**:
   * `readonly InventoryOp[]` 只是 TS 编译期声明。
   *
   * 实测:`{"ops":1}` / `{"ops":{}}` / `{"ops":null}` / `{}`(字段缺失)
   * 等**一行合法 JSON** 都会让下面的 `for...of` 抛 `TypeError: input.ops
   * is not iterable` ⇒ 没有裁决对象 ⇒ 调用方的 `if (r.violation)` 拿不到
   * 任何东西,违规分不累计、踢出机制不触发。字符串虽**能**迭代,但那走的是
   * 逐字符路径,判出来的拒因码与"格式非法"完全无关 —— 归因失真。
   *
   * 故先做形状判定,再进入逐条检查:与 checkMove 一样,
   * **判据本身必须先可信**,否则后面的检查只是"恰好"生效。 */
  if (!Array.isArray(input.ops)) {
    return rejectInv(s, input, InventoryReject.MALFORMED,
      `ops 不是数组:${typeof input.ops} ${String(input.ops)}`);
  }
  /* ⚠️ 老/手搓的 `PlayerAntiCheatState`(WS-FND-04 的 `mkState`)没有这两个字段 ——
     缺就补齐,而不是让判据在 `undefined.clear()` 上抛。fail-closed 方向不变:
     补出来的空集只会**放行第一次**使用,重复使用仍被拦。 */
  if (!(s.usedSourceTokens instanceof Set)) s.usedSourceTokens = new Set<string>();
  if (typeof s.usedSourceTick !== 'number') s.usedSourceTick = -1;
  /** 本 tick 已用掉的令牌;**换 tick 即视为空集**(凭证不跨 tick)。 */
  const used = s.usedSourceTick === input.tick ? s.usedSourceTokens : null;
  /** 本批次要提交的一次性标记(整批通过后才落账)。 */
  const fresh: string[] = [];
  /**
   * 本批的**按件运行视图**:只在调用方给了 `beforeByItem` 时建立。
   *
   * 逐条推进(而不是只读一次初始值),于是批内「先加后扣」与「同一件扣两次」
   * 都按**当时的**件数判 —— 判据不能因为批内顺序而被绕开。
   */
  const byItem = input.beforeByItem === undefined ? null : new Map(input.beforeByItem);
  let net = 0;
  for (const op of input.ops) {
    if (!op || typeof op !== 'object' || !Number.isFinite(op.itemId)) {
      return rejectInv(s, input, InventoryReject.MALFORMED,
        `操作项非法:${JSON.stringify(op)}`);
    }
    if (!Number.isInteger(op.delta)) {
      return rejectInv(s, input, InventoryReject.FRACTIONAL,
        `非整数增量 item=${op.itemId} delta=${op.delta}`);
    }
    if (op.delta > 0) {
      const source = op.source;
      if (!source || !input.allowedSources.has(source)) {
        return rejectInv(s, input, InventoryReject.FROM_NOTHING,
          `物品 ${op.itemId} 凭空产出(source=${source ?? '∅'} 未被服务端认可)`);
      }
      const token = parseItemSourceToken(source);
      if (token === null) {
        if (looksLikeItemSourceToken(source)) {
          return rejectInv(s, input, InventoryReject.SOURCE_FORGED,
            `物品 ${op.itemId} 的凭证验签失败(source=${source})—— 服务端从未铸过它`);
        }
        /* 旧口径(非令牌)字符串:只可能由服务端 `grantItemSource` 注入
           (生产产出点已全部走 `bindItemSource`)⇒ 不是客户端可达面。 */
      } else {
        if (token.actorId !== s.id) {
          return rejectInv(s, input, InventoryReject.SOURCE_BINDING,
            `凭证绑的玩家是 ${token.actorId},本次行为人 ${s.id}`);
        }
        if (token.itemId !== Math.trunc(op.itemId)) {
          return rejectInv(s, input, InventoryReject.SOURCE_BINDING,
            `凭证绑的物品 ${token.itemId},本次申报 ${op.itemId}(一张凭证只铸它绑定的那件)`);
        }
        if (token.tick !== input.tick) {
          return rejectInv(s, input, InventoryReject.SOURCE_EXPIRED,
            `凭证来自 tick ${token.tick},当前 tick ${input.tick}(凭证不跨 tick)`);
        }
        if (used !== null && used.has(source)) {
          return rejectInv(s, input, InventoryReject.SOURCE_REUSED,
            `物品 ${op.itemId} 的凭证在本 tick 内已用过(凭证是一次性的)`);
        }
        if (!fresh.includes(source)) fresh.push(source);
      }
    }
    /* ── 按件判据(调用方给了 `beforeByItem` 时;见 `InventoryCheckInput.beforeByItem`)──
       ⚠️ 这条**不能**用 `Math.max(0, ...)` 夹:夹零会把「扣超了」变成「扣到零」,
       与写账路径的静默夹零是同一个病 —— 判据要**拒绝**,不要**修正**。 */
    if (byItem !== null) {
      const id = Math.trunc(op.itemId);
      const owned = byItem.get(id) ?? 0;
      if (op.delta < 0 && owned < -op.delta) {
        return rejectInv(s, input, InventoryReject.NEGATIVE,
          `物品 ${id} 只持有 ${owned} 件,本次要扣 ${-op.delta}(按件判据:不足即拒,不夹零)`);
      }
      byItem.set(id, owned + op.delta);
    }
    net += op.delta;
  }
  if (Math.abs(net) > limits.maxItemDeltaPerTick) {
    return rejectInv(s, input, InventoryReject.BURST,
      `单帧净变化 ${net} 超上限 ${limits.maxItemDeltaPerTick}`);
  }
  const after = input.beforeTotal + net;
  if (after < 0) {
    return rejectInv(s, input, InventoryReject.NEGATIVE,
      `消耗了不存在的东西:${input.beforeTotal}${net >= 0 ? '+' : ''}${net}=${after} < 0`);
  }
  if (after > input.capacity) {
    return rejectInv(s, input, InventoryReject.OVERFLOW,
      `总量 ${after} 超容量 ${input.capacity}`);
  }
  /* ★ 整批通过 ⇒ 才把本批用掉的令牌记成「已用」。 */
  if (s.usedSourceTick !== input.tick) {
    s.usedSourceTokens.clear();
    s.usedSourceTick = input.tick;
  }
  for (const src of fresh) s.usedSourceTokens.add(src);
  return { allowed: true, afterTotal: after };
}

function rejectInv(
  s: PlayerAntiCheatState,
  input: InventoryCheckInput,
  code: InventoryReject,
  detail: string,
): InventoryCheckResult {
  const v: Violation = {
    kind: ViolationKind.INVENTORY,
    tick: input.tick,
    playerId: s.id,
    detail: `[${code}] ${INVENTORY_REJECT_LABEL[code]} — ${detail}`,
    weight: VIOLATION_WEIGHT.INVENTORY,
  };
  record(s, v);
  return { allowed: false, afterTotal: input.beforeTotal, violation: v, rejectCode: code };
}

/* ═══════════════════════════ 6. 房间级汇总 ═══════════════════════════ */

export class AntiCheatRoom {
  /**
   * **合并后**的实际限值。⚠️ 构造器传入坏值时它**不是**你传进去的那个对象 ——
   * 而是逐字段回退过的安全副本(见 `mergeLimits`)。
   * 这正是「可读回」的用义:传参的人能立刻看出自己的字段没生效。
   */
  readonly limits: AntiCheatLimits;
  /**
   * 构造时发现的限值问题(空数组 = 传参完全合法)。
   *
   * ⚠️ 存在的理由:`mergeLimits` 取 fail-closed(兜默认而非抛错),
   * 那就必须**让降级可观测** —— 否则它只是又一处静默降级。
   */
  readonly limitsIssues: readonly string[];
  /**
   * 速度窗口**分母**用的帧间隔(秒)—— 可注入,缺省标称 `DT`(见 `DEFAULT_FRAME_DT_SECONDS`)。
   *
   * ★ 为什么是**分母**而不是 `SPEED_WINDOW_TOLERANCE`:容差是**判据**(放大它在真作弊者
   * 身上同步放水),分母是**秒表**(修正它只把读数还原成真实格/秒)。
   *
   * ⚠️ 唯一写入口是 `setFrameIntervalMs`(`tick(t, frameMs)` 只是转发):只接受
   * **有限正数**,非法值**保持当前值**。写成 `NaN` 会让 `spanS = spanTicks × NaN`
   * ⇒ `observed > NaN + 1e-9` 恒 `false` ⇒ 窗口检查**静默失明**(与 `sanitizeMul` 同族)。
   *
   * ⚠️ 残留(如实登记):注入值是**调用方说**的间隔,反作弊不独立测量 ⇒ 传进来的值
   * 偏大时窗口读数偏低(稀释)。故调用方必须传**逐帧实测差**;局内休眠 / 暂停造成的长间隔
   * (房间 `status !== OPEN` 时 `tick` 根本不被调用,唤醒后首个差值会很大)应丢弃或夹住。
   */
  dtSeconds = DEFAULT_FRAME_DT_SECONDS;

  /**
   * 注入**实测帧间隔**(毫秒),返回生效后的 `dtSeconds`。
   *
   * 非法(非有限 / ≤ 0)⇒ **忽略**(保持当前值,缺省 `DT`):不抛错(每帧热路径上抛错
   * 会把「一个读数为 0」升级成房间整帧崩掉,与 `mergeLimits` 的 fail-closed 同取向),
   * 也不改成 `NaN`(见 `dtSeconds` 的失明风险)。
   */
  setFrameIntervalMs(frameMs: number): number {
    if (Number.isFinite(frameMs) && frameMs > 0) this.dtSeconds = frameMs / 1000;
    return this.dtSeconds;
  }
  private states = new Map<string, PlayerAntiCheatState>();
  /**
   * 违规流水(**环形缓冲**,容量 `VIOLATION_LOG_CAPACITY`)。
   *
   * 修前它是无界的普通数组 + 每次 `move()` 一次 `slice(-512)` 重建
   * (见 `move` / `pushViolation`)。环形同时治了两件事:
   *   · 热路径成本:写槽 O(1),不再每次重建整个数组;
   *   · 内存上界:长度恒 ≤ 512(修前靠每帧 slice 才勉强有界,
   *     而 `attack` / `inventory` 两条路径连 slice 都没有 —— 只 push 不裁)。
   *
   * ★ P2(2026-11-21)公平修点:槽里存 `{ seq, v }` 而不是裸 `Violation` ——
   * 覆写不再**只能**发生在全局最旧槽(见 `pushViolation`),就地覆写会让物理顺序
   * 不再等于时间顺序,`violations()` 得按 `seq` 重排。
   */
  private log: { seq: number; v: Violation }[] = [];
  /** 环形写游标(仅在 `log` 已满、且走**全局最旧**那条覆写路径时推进)。 */
  private logNext = 0;
  /** 累计写入条数(判断「有没有绕过一圈」的唯一依据)。 */
  private logCount = 0;
  /** 写入序号(单调;`violations()` 据此恢复时间顺序)。 */
  private logSeq = 0;

  /**
   * ★ 被归类成 `stale` 的拒绝**累计条数**(与服务端自位移有关,**不是**违规)。
   *
   * 为什么要有它:修前这一类和真瞬移在读数上不可分(都只让 `acViolations` 涨),
   * 于是「残余几十条」既可能是作弊也可能是诚实玩家被服务端自己挪动 —— 无法归因。
   * 有它之后「假阳性」是汇总里**可分辨的一列**,而不是被静默吃掉。
   */
  staleRejections = 0;

  constructor(limits: AntiCheatLimits | unknown = DEFAULT_LIMITS) {
    /* ★ CR-27 修复点:此前是 `this.limits = limits`(不做任何检查)
       ⇒ 部分对象/非对象会让 `maxMoveCatchupTicks` 变 `undefined`
       ⇒ `claimedTick` 变 `NaN` ⇒ `dist > NaN` 恒 false ⇒ **全部放行**。
       详见 `mergeLimits` 的实测表。 */
    const merged = mergeLimits(limits);
    this.limits = merged.limits;
    this.limitsIssues = merged.issues;
    if (merged.issues.length > 0) {
      /* 打到 stderr:配置错误属**开发者可见**的一类,不该被 32Hz 的日志淹掉。
         (与 WS-13 的 `LOAD_FAIL::` 同一取舍:失败要让门禁能看见。) */
      console.error(
        `[anticheat] 限值非法,已逐字段回退默认值(${merged.issues.length} 项):\n`
        + merged.issues.map((s) => `  · ${s}`).join('\n'),
      );
    }
  }

  join(id: string, tick = 0, x = 0, y = 0, z = 0): PlayerAntiCheatState {
    const s = createAcState(id, tick, x, y, z);
    this.states.set(id, s);
    return s;
  }

  leave(id: string): void {
    this.states.delete(id);
  }

  get(id: string): PlayerAntiCheatState | undefined {
    return this.states.get(id);
  }

  /**
   * 每帧推进:分数衰减 + **服务端时钟水位** + 淘汰被踢的玩家状态。
   *
   * `frameMs`(可选)= 本帧与上一帧的**实测墙钟差**(毫秒),转发给
   * `setFrameIntervalMs`;不传 ⇒ 窗口分母保持当前值(缺省 `DT`)。
   * 这是房间侧的唯一接线点(`room.ts` 手上有 `this.clock.nowMs()`,读得到实测节拍)。
   */
  tick(t: number, frameMs?: number): void {
    if (frameMs !== undefined) this.setFrameIntervalMs(frameMs);
    for (const s of this.states.values()) {
      decayScore(s);
      advanceServerClock(s, t);
    }
  }

  /**
   * 移动检查 + 违规入流水。
   *
   * ★ WS-FND-137 P2:修前本方法尾部有一行 `this.log = this.log.slice(-512)` ——
   * 每次移动(32Hz × 玩家数)都**整数组重建一遍**,只为丢掉最多 1 条过期记录。
   * 现在走 `pushViolation`(环形缓冲,满了才绕回)⇒ 本方法**恒定成本**,
   * 与流水长度无关。
   */
  move(intent: MoveIntent & { playerId: string }, maxZ = 3): Verdict {
    const s = this.states.get(intent.playerId);
    if (!s) return { allowed: false };
    const v = checkMove(s, intent, this.limits, maxZ, this.dtSeconds);
    if (v.violation) this.pushViolation(v.violation);
    /* ★ `stale`(服务端自位移所致的假阳性)单独计数:修前它与真瞬移在读数上**不可分**。 */
    if (v.stale) this.staleRejections += 1;
    return v;
  }

  /**
   * ★ WS-FND-135(P1):取一份**本次移动会改动的窗口/水位**快照。
   *
   * 与 `rollbackMove` 配对:`checkMove` 放行时窗口与水位已被推进,而
   * 「世界是否**接受**了这次坐标」要等 `applyPlayerMove` 的返回值 ——
   * 世界拒收时那组坐标是**幻影**。调用方(房间)拿快照 → 调 `move` →
   * 世界拒收 ⇒ `rollbackMove`。
   *
   * `playerId` 未登记(或已被 `leave` 清掉)⇒ 返回 `null`(没有状态可回滚)。
   */
  snapshotMove(playerId: string): MoveWindowSnapshot | null {
    const s = this.states.get(playerId);
    return s === undefined ? null : snapshotMoveWindow(s);
  }

  /**
   * ★ WS-FND-135(P1):把窗口/水位回滚到 `snap`(世界拒收那次移动之前)。
   *
   * 只回滚**位置事实**(窗口 + `lastX/Y/Z` + `lastMoveTick`);违规流水与分数
   * **不动** —— 它们是「判定」的事实。`snap === null`(玩家未登记)⇒ 空操作。
   */
  rollbackMove(playerId: string, snap: MoveWindowSnapshot | null): boolean {
    const s = this.states.get(playerId);
    if (s === undefined || snap === null) return false;
    restoreMoveWindow(s, snap);
    return true;
  }

  /**
   * ★ WS-FND-178(P1):把水位**重锚**到权威刚体上。
   *
   * ## 它**只为**一件事存在
   *
   * 「世界在**没有被接受的移动**的情况下自己挪了刚体」——
   * 击退/搬运(`carry.ts`)、撞墙滑行、落地沉降、台阶抬升、被世界拒收但仍落了位,
   * 以及房间投影之外的任何服务端位移。这些路径**不经过** `checkMove`,
   * 而水位(`lastX/Y/Z`)在修前只有 `checkMove` 一个写入点 ⇒ 权威刚体走远了,
   * 判据的参考点还钉在旧坐标上。
   *
   * ## 为什么这是**加强**而不是放松反作弊
   *
   * 它把判据的参考点从「上一次**申报**坐标」钉到「权威刚体」:
   * ```text
   * 诚实客户端:按收到的权威坐标重新起算 ⇒ 水位与它同源 ⇒ 相邻两包差 = 真位移
   * 作弊者    :申报坐标必须从**真实位置**(权威刚体)起算 ⇒ 一次瞬移仍按
   *            真实位移量判定(上界、窗口、Z 值域全部照旧)
   * ```
   * 修前那种「权威与水位永久偏离 ⇒ 每个移动包都被判瞬移、永不收敛」的形态,
   * 恰恰是**假阳性**——它伤的是合法玩家,并且掩盖真实证据(流水被自己的假阳性灌满
   * 之后就再也留不下别人的违规)。它**不**放宽任何上界:本方法只写三个坐标,
   * 判据常量(单帧上界 / 窗口均速 / Z 值域)一字未动。
   *
   * ## 只有房间侧可以用**权威值**调它
   *
   * `x/y/z` 必须来自 `WorldSaveHost.playerPosition`(或等价的权威读口)。
   * 客户端申报值走 `checkMove` 那条既定路径。
   *
   * ⚠️ **入口与出路径的兜底是有意的例外,不是新入口** —— 但**两处兜底的对象不同**(逐个核过):
   * - **入口**(`room.ts#applyMove` 顶部):`hostPositionOf()` 为空、或 `z` 不是有限数
   *   ⇒ **整次跳过**(根本不重锚),**不是**退回申报值;
   * - **正常放行路径**:`auth?.x ?? intent.x` 三处逐个兜底到申报值 —— 那里 `checkMove`
   *   刚把申报值写进水位,故与既有行为**逐位等价**;
   * - **世界拒收路径**:x/y 兜底到**调用前**的 `authBefore`(**不是**申报值),z 优先取
   *   `snap.lastZ`(`ac.move` 已放行 ⇒ `snap` 必非空 ⇒ `intent.z` 实际到不了)。
   *   这条比「逐位等价」**更严**,不是放宽。
   * 将来若所有世界源都能回 z,正常放行路径那条兜底应收紧成「拿不到就不重锚」。
   *
   * ## 契约(fail-closed)
   *
   * - 该玩家未登记(或已被 `leave` 清掉)⇒ **直接返回、不抛、不新建状态**
   *   (与 `rollbackMove` 的 `null` 契约同一取舍:没有状态就没有位置事实可写);
   * - 三个值**必须**都 `Number.isFinite`,否则**整次调用不生效** ——
   *   宁可保持旧水位,也不把 `NaN` / `±Infinity` 写进判据基准
   *   (`dist > NaN` 恒 `false` ⇒ 瞬移检查静默失效,见 `checkMove` §6.0 的值域门);
   * - **绝不**碰 `s.window` / `s.lastTick` / `s.lastMoveTick` / 违规流水 / 分数。
   *   窗口是**观测**(放宽它才是放水),`lastMoveTick` 是额度闸门(回退它等于重复兑现),
   *   流水与分数是判定的事实(重锚是位置事实,不是「撤销一次违规」)。
   */
  syncWatermark(playerId: string, x: number, y: number, z: number): void {
    const s = this.states.get(playerId);
    if (s === undefined) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    s.lastX = x;
    s.lastY = y;
    s.lastZ = z;
  }

  /**
   * ★ 记下「**世界自己**自上一包以来自行挪了多远」(`authorityDrift`)。
   *
   * ## 信息来源必须与 `syncWatermark` **分开**
   *
   * ⚠️ 这个量**不是**从水位推出来的 —— 水位是**判据的参考点**,它可以因回滚 / 注入而
   * 与权威不一致(WS-FND-135 的注入负对照就是手工把它改成幻影)。若拿 `|新水位 − 旧水位|`
   * 当「世界自位移」,那么「水位被改坏」也会换来宽限 ⇒ 一条合法报文会被**静默放过**,
   * 而那正是那条判据守的东西。
   *
   * 所以调用方必须是**房间**,且必须用房间**自己**的权威读数算:
   * `room.ts#applyMove` 顶部拿「上一包时的权威刚体」与「此刻的权威刚体」之差喂进来
   * (`hostPositionOf` 两帧读数)。⇒ 水位怎么变都不影响这个量。
   *
   * ## 它换来的只是**分类**,不是额度
   *
   * 读数只被 `checkMove` §6.1 用来把「世界自己挪了刚体」造成的那一包归入 `stale`
   * (客户的步长仍在额度内,三角形不等式保证)。单帧上界 / 窗口均速 / Z 值域一字未动。
   */
  noteAuthorityDrift(playerId: string, drift: number): void {
    const s = this.states.get(playerId);
    if (s === undefined) return;
    s.authorityDrift = Number.isFinite(drift) && drift > 0 ? drift : 0;
  }

  /**
   * ★ 把**客户端自报的帧计数器**折算到**房间时钟**上(首包定基准,之后不变)。
   *
   * ## 为什么必须有这一层
   *
   * 两套时钟**不同源**:
   * - 房间/反作弊:`s.lastTick` = 房间帧号(`state.meta.tick`),`join` 用它播种
   *   `lastMoveTick`(`room.ts#join`);
   * - 客户端:`client/src/main.ts` 的 `localTick` —— **从 0 起的自有计数器**,
   *   每输入拍 +1,`sendMove` 发它(`main.ts:852`);服务端 `parseMoveIntent`
   *   **原样透传**(`ws_server.ts:669`)。
   *
   * 房间只要在玩家加入**之前**跑过帧(⇒ **任何第二个玩家、任何页面重载**),
   * 两者就差几百帧。此时 `claimedTick = min(intent.tick, lastMoveTick + MAX, …)`
   * 被压到客户端那个小计数上 ⇒ `dtTicks = 0` ⇒ `allowed = 0` ⇒
   * **每一包带位移的移动都被判 TELEPORT、写不进世界**:玩家一步也走不动,
   * 且每包留一条假阳性(判据 `tests/WS-FND-178` 的 `FND178-8`)。
   *
   * ## 为什么它不打洞
   *
   * 返回值仍要过 `checkMove` 的**同一对夹取**(`lastMoveTick + MAX` 与
   * `lastTick + MAX`)⇒ 折算只是把「客户端计数器」翻译成「房间帧号」,
   * **拿不到任何额外额度**;报一个巨大的首包 tick 也没用(基准只定一次,
   * 且随后照样被夹取封顶)。基准不进快照、不回滚 —— 它是换算,不是位置事实。
   */
  normalizeClientTick(playerId: string, clientTick: number): number {
    const s = this.states.get(playerId);
    if (s === undefined || !Number.isFinite(clientTick)) return clientTick;
    /* 基准**钳到 ≥ 0**:只有房间时钟**领先**客户端计数器时才折算。逆差不折算 ——
       那时两套时钟本来就是同起点(短跑夹具直接发房间帧号;单测里没推过房间帧,
       `lastTick === 0` 而 tick 从 1 数起)。折出一个负基准会把申报压到 0 以下,
       `dtTicks` 变 0,反而把**合法**的包判成违规(WS-07 F24/G01/G04/task-38 实测)。

       ★ 另外:**计数器被重置时必须重算基准**。客户端计数器是 JS 上下文的
       (页面重载 / 崩溃恢复 / 席位 `resumed` 都从 0 重来),而 AC 状态在
       `disconnect()` → resume 这条路上**整份保留**(`ac.leave()` 只在主动退房或
       宽限超期时才调)⇒ 基准会一直停在旧值,`t' = 0 + 旧基准 ≤ lastMoveTick`
       ⇒ `dtTicks` 恒 0 ⇒ **重连回来的玩家一步也走不动**(判据 `FND178-9`)。

       重算**不放松任何上界**:返回值照样被 `checkMove` 的同一对夹取
       (`lastMoveTick + MAX` / `lastTick + MAX`)封顶 —— 一次重算只换来
       「与诚实客户端逐位同形」的那 1 帧额度,拿不到更多(对抗审查逐案验过)。 */
    const reset = s.lastRawClientTick !== null && clientTick < s.lastRawClientTick;
    if (s.clientTickBase === null || reset) {
      s.clientTickBase = Math.max(0, s.lastTick - clientTick);
    }
    s.lastRawClientTick = clientTick;
    return clientTick + s.clientTickBase;
  }

  /**
   * 违规入流水(环形缓冲,容量 `VIOLATION_LOG_CAPACITY`)。
   *
   * 为什么必须是**环形**而不是「push 完 `slice(-512)`」:后者把 O(cap) 的重建
   * 压在**每次移动**上,而它要表达的只是「留最近 512 条」。
   * 环形:未满 ⇒ append;已满 ⇒ 覆写最旧槽。单次 O(1)(份额判断走一条 O(n) 扫描,
   * 只在**已满**且该玩家**确实刷过头**时才走 —— 见下)。
   *
   * ⚠️ `logNext` 只在**已满**时、且走「全局最旧」那条覆写路径时才有意义 ——
   * `violations()` 靠 `logCount` 判断「有没有绕过一圈 / 有没有就地覆写过」,
   * 不能只看 `log.length === capacity`。
   *
   * ══════════ ★ P2(2026-11-21)公平修点 ══════════
   *
   * ## 修前形态
   * 流水是**全房一本**、覆写的**永远**是全局最旧那一条 ⇒ 一个客户端持续触发违规,
   * 就能把**别人的违规证据**整批挤出窗口:事后看 room_events,只有刷分那个人的,
   * 被他骚扰/攻击的人一条都没有。而「挤出去」这件事本身**没有任何计数**
   * (`droppedViolations` 只告诉你丢了多少,不告诉你是谁被挤没了)。
   *
   * ## 现在:每人一份**份额**
   * ```text
   * share = max(1, floor(容量 / 在场玩家数))
   * 该玩家已占 ≥ share  ⇒ 覆写**他自己**最旧的那一条(别人的槽一格都不动)
   * 该玩家已占 <  share  ⇒ 才动全局最旧槽(游标照旧前移)
   * ```
   * ⇒ 一个刷分客户端最多挤掉**他自己**早先的证据;**别人的证据只能被他们自己的
   * 新证据挤掉**。容量上界与「最近 N 条」的口径不变(单人在场时 share = 容量,
   * 行为与修前逐位相同 —— 既有判据 `WS-FND-137` / `WS-FND-158` 仍是 512/188)。
   */
  private pushViolation(v: Violation): void {
    this.logSeq += 1;
    const entry = { seq: this.logSeq, v };
    if (this.log.length < VIOLATION_LOG_CAPACITY) {
      this.log.push(entry);
    } else {
      const mine = this.countInLog(v.playerId);
      if (mine >= this.perPlayerShare()) this.overwriteOldestOf(v.playerId, entry);
      else {
        this.log[this.logNext] = entry;
        this.logNext = (this.logNext + 1) % VIOLATION_LOG_CAPACITY;
      }
    }
    this.logCount += 1;
  }

  /**
   * 单名玩家在房间里最多能占几个流水槽 = `floor(容量 / 在场玩家数)`,下限 1。
   *
   * 分母取**在场**人数(`states.size`):份额约束的是「同一段时间里同时在触发违规
   * 的人」;已经离场的人的旧证据本来就该慢慢被挤掉(那不是「挤掉别人的」)。
   */
  private perPlayerShare(): number {
    return Math.max(1, Math.floor(VIOLATION_LOG_CAPACITY / Math.max(1, this.states.size)));
  }

  /** 某人在当前流水里占了几条(只在**已满**路径上调用)。 */
  private countInLog(playerId: string): number {
    let n = 0;
    for (const e of this.log) if (e.v.playerId === playerId) n += 1;
    return n;
  }

  /** 就地覆写**该玩家自己**最旧的那一条(别人的槽不动;`logNext` 也不动)。 */
  private overwriteOldestOf(playerId: string, entry: { seq: number; v: Violation }): void {
    let at = -1;
    let oldest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.log.length; i += 1) {
      const e = this.log[i];
      if (e.v.playerId !== playerId) continue;
      if (e.seq < oldest) {
        oldest = e.seq;
        at = i;
      }
    }
    if (at < 0) {
      /* 一条都没有:理论上不可达(调用方刚判过「已占 ≥ 份额」且份额 ≥ 1)——
         退回全局最旧槽,不许把**新**证据丢了。 */
      this.log[this.logNext] = entry;
      this.logNext = (this.logNext + 1) % VIOLATION_LOG_CAPACITY;
      return;
    }
    this.log[at] = entry;
  }

  /**
   * 因容量上限被**覆写丢弃**的违规条数(= 总写入 − 当前留存)。
   *
   * 用途:证明「有界」不是靠读代码相信 —— 灌 700 条之后这个数必须是 188,
   * 而 `violations()` 里必须只剩**最后** 512 条(判据见 WS-FND-137)。
   */
  get droppedViolations(): number {
    return Math.max(0, this.logCount - this.log.length);
  }

  attack(playerId: string, tick: number, claimedBonus = 0): Verdict {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false };
    const v = checkAttack(s, tick, claimedBonus, this.limits);
    if (v.violation) this.pushViolation(v.violation);
    return v;
  }

  /**
   * ★ WS-FND-135(P3):**只判定、不提交**攻速冷却水位(见 `previewAttack`)。
   *
   * 房间入口用它:世界侧真的结算了才 `commitAttackOf`。这样「按了 Q 但武器没技能」
   * 「超射程」这两类**零伤害**的攻击不再白占 8 帧冷却。
   */
  attackPreview(playerId: string, tick: number, claimedBonus = 0): Verdict {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false };
    const v = previewAttack(s, tick, claimedBonus, this.limits);
    if (v.violation) this.pushViolation(v.violation);
    return v;
  }

  /** ★ WS-FND-135(P3):提交攻速冷却水位(**只在结算成功后**)。未登记 ⇒ `false`。 */
  commitAttackOf(playerId: string, tick: number): boolean {
    const s = this.states.get(playerId);
    if (s === undefined) return false;
    commitAttack(s, tick);
    return true;
  }

  inventory(playerId: string, input: InventoryCheckInput): InventoryCheckResult {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false, afterTotal: input.beforeTotal };
    const r = checkInventory(s, input, this.limits);
    if (r.violation) this.pushViolation(r.violation);
    return r;
  }

  /**
   * 全部违规流水(供写入 `room_events`)。
   *
   * ★ WS-FND-137 P2:底层改成**环形缓冲**(容量 `VIOLATION_LOG_CAPACITY`)。
   * 修前是 `this.log = this.log.slice(-512)`,而那一行在 `move()` 里 ——
   * `move` 是 32Hz × 玩家数的热路径 ⇒ 每次移动都**整数组重建一遍**,
   * 只为丢掉最多 1 条过期记录。环形只写一个槽(且满了才绕回)。
   *
   * ⚠️ 返回值定义**未变**:仍然是「最近 512 条、按时间顺序(最早在前)」的一串。
   * 变的是它现在是**快照**而不是内部数组本身 —— 环形缓冲的物理顺序没有意义,
   * 直接暴露会让「第 0 条 = 最早」这个既有读法静默失效。返回副本的代价只落在
   * **诊断 / 落库**路径(`violations()` 不在每帧热路径上)。
   */
  violations(): readonly Violation[] {
    const n = this.log.length;
    /* 还没绕过一圈、也没有就地覆写过:物理顺序就是时间顺序。 */
    if (this.logCount <= n) return this.log.map((e) => e.v);
    /* ★ P2(2026-11-21):绕回之后物理顺序本来就没有意义;公平修点还会**就地**
       覆写中间槽(把某个人的旧证据换成他的新证据)⇒ 一律按写入序号重排,
       读侧「最早在前」的契约不变。 */
    return [...this.log].sort((a, b) => a.seq - b.seq).map((e) => e.v);
  }

  /** 按 kind 计数(**只读诊断路径**,不在每帧热路径上)。 */
  countByKind(kind: ViolationKind): number {
    let n = 0;
    for (const e of this.log) if (e.v.kind === kind) n += 1;
    return n;
  }


  /**
   * ★ WS-FND-172(P1 顺带登记):**标记为「应踢出」的玩家 id**。
   *
   * ⚠️ ⚠️ **生产侧目前没有任何消费者** —— 全仓 grep `kickedPlayers` / `.kicked`,
   * `server/src/**` 里只命中本文件的定义处(`record` 置位 + 本方法),调用者
   * **只有测试**(WS-07 `E11` / `E17d` / `E17e`、WS-FND-144 等)。
   *
   * 后果必须说清,否则会把它读成「已经会踢人」:
   *   · 越过 `VIOLATION_SCORE_KICK` 只把状态里的 `kicked` 置 `true`,
   *     **不**断开连接、**不**拒绝其后续 `move`/`attack`(`checkMove` 不看这个位)、
   *     **不**写库(写进 `room_events` 的是 `violations()`,与 `kicked` 无关);
   *   · 故一次**长跑**里长出来的是「**作弊证据**」(违规流水),**不是**「踢人」。
   *     WS-FND-172 实测的持续突发玩家(`17.56 格/秒`)即使被标记,也照常移动。
   *
   * 要真正落地「踢」,需要房间层(`room.ts` / `room.colyseus.ts`,**不在本文件职责内**)
   * 在每帧末读一次本方法并 `disconnect()`。在那之前,这里是**悬空的闸门**,
   * 由本注释与 WS-FND-172 的判据共同登记(不许当它已经生效)。
   */
  kickedPlayers(): string[] {
    return [...this.states.values()].filter((s) => s.kicked).map((s) => s.id);
  }
}
