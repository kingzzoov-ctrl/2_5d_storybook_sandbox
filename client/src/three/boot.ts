/**
 * 引擎启动层 —— **唯一**做 DOM + three 绑定的地方。
 *
 * ## 为什么在这里 import three
 *
 * WS-09 的「分层不变量」要求:凡 `import three` 的模块都必须落在 `three/` 内,
 * 其余模块(尤其 `stage/` 与 `ui/`)必须零三方依赖、可被 node 直接测试。
 *
 * 本文件因此只做**装配与事件绑定**,不含任何几何/投影/地形算法
 * —— 那些全在 `stage/` 里,是纯函数。
 *
 * ## 依赖方向
 *
 * ```
 * main.ts(浏览器入口,只调用本文件)
 *    └── three/boot.ts(本文件,可 import three)
 *           ├── three/stage_assembly.ts(three 对象构造)
 *           └── stage/*.ts(纯逻辑,零三方依赖)
 * ```
 */

import * as THREE from 'three';
import { createCamera, stepZoom, ZOOM_LEVELS, type IsoCamera, Z_Y_PER_LEVEL } from '../stage/iso_camera.ts';
import {
  buildChunkGeometry,
  buildOrthographicCamera,
  buildTerrainMaterial,
  syncTerrainCamera,
  /* ★ w100:把图集绑到地形材质上(shader 里的 `uAtlas`/`uAtlasReady`)。
     不调它 ⇒ 地形永远走"纯顶点色"退化路径,贴图一辈子不出现,且**不报错**。 */
  bindTerrainAtlas,
} from './stage_assembly.ts';
import { makeDemoWorld, WORLD_CELLS, WORLD_CHUNKS } from '../stage/demo_world.ts';
/* ★ w85:画**设计过的世界** —— 与服务器同一张图(`shared/world/design.ts`)。 */
import { CHUNK_SIZE, ELEV_TO_Z, type ChunkInput } from '../stage/tile_mesh.ts';
import { buildDesignChunks, DESIGN_WORLD_CELLS } from '../stage/design_world.ts';
/* ★ w90:`obj` 层与植被的立牌计划(纯函数)。改前 `obj` 层**完全不渲染** —— 见挂载点的长注释。 */
import { planObjSprites, planVegetationSprites, type ObjSpriteInput } from '../stage/obj_sprites.ts';
import { isBuildingObj, planBuildingBoxes } from '../stage/building_boxes.ts';
import { packTile, unpackTile } from '../../../shared/types/tile.ts';
/* ★ WS-FND-188:NPC 表的**线上形状** —— 类型来自共享协议层(客户端不内置 NPC 名单)。 */
import { type NpcWireDef } from '../../../shared/net/delta.ts';
import {
  SPRITE_CELL_WORLD, SPRITE_CENTER_X, SPRITE_CENTER_Y,
  ATLAS_CELL, ATLAS_IMAGE_W, ATLAS_IMAGE_H, ATLAS_PX_PER_CELL,
  cellIndexFromId, offsetRepeatOfCell,
  playerMarkerPlacement, playerMarkerScale, PLAYER_MARKER_NAME,
} from '../stage/assembly_math.ts';

/* ── 以下 8 个模块此前**从未被浏览器加载**(有测试、零 DOM 依赖,但无装配入口)──
 *
 * 现在它们在 boot.ts 里真的被调用,而不是只 import:
 *   state_machine  → 按键开/关面板,驱动打开动画与合法迁移
 *   inventory      → buildView() 出背包格子与分类,右侧面板可见
 *   recipe_tree    → buildRecipeTree()/checkCraft() 出配方树与缺料提示
 *   boss_hud       → layoutHpBar()/buildTelegraph() 出 Boss 血条与地面预警圈
 *   audio          → resolveNote()/musicBoxSfx() 经 audio_out 接成可听见的声音
 *   roof_transparency → 玩家走进屋顶连通域时整片淡出
 *   pixel_easel    → 16×16 画架 + 32 色盘,可点可画
 *   blueprint      → 拖拽框选 → 收集蓝图并显示格数
 */
import { UiPanel, UiStateMachine, DragController } from '../ui/state_machine.ts';
import {
  type InventoryView,
  SortKey,
  applySlotMove,
  buildView,
  defaultSlotItemIds,
  slotFingerprint,
  usedSlotRatio,
} from '../ui/inventory.ts';
/* ★ 第七轮审计 P1(『e』双绑):面板键位表搬到 `ui/panel_keys.ts`。
   留在本文件里的话「键集互不重叠」这条判据读不到它(本文件顶层 import three + 碰 document,
   node 里加载不了)⇒ 判据只能靠手写清单,而手写清单正是这次漏掉 `e` 的地方。 */
/* ★ WS-FND-151:模式面板的选中键(`j` / `l` / `enter`)—— 与其它组互斥,见 `keyGroups()`。 */
import { BOSS_DEMO_KEY, CLOSE_PANEL_KEY, PARTY_PANEL_KEYS, SEARCH_KEY, ZOOM_KEYS, panelKeyHints, panelKeyOf } from '../ui/panel_keys.ts';
/* ★ 第七轮审计 P1:`wildlife` / 其他 `players` 此前**零渲染出口** ——
   判定(该画谁、画在哪、什么颜色)在 `stage/entity_sprites.planEntitySprites`(纯函数、可单测),
   本文件只做「按计划建/改/删 Sprite」这一段。
   ★ WS-FND-137 P2:每帧那一份计划改走**复用槽**(`planEntitySpritesInto` +
   本文件自己的 `spritePlan` 缓冲),不再每帧新建数组与 spec 对象;
   `planEntitySprites`(返回新数组的公开版本)留给不需要复用缓冲的调用方与测试。 */
import {
  countByKinds,
  planEntitySpritesInto,
  type EntitySpriteSource,
  /* ★ WS-FND-188:NPC 立牌高度取**同一份**口径(28px = 玩家立牌高)——
     两份高度常量迟早漂,而漂的表现是"NPC 比人矮一截/高一截",没人会报错。 */
  SPRITE_HEIGHT_PX,
  type EntitySpriteSpec,
  characterAtlasId, entityAtlasId,
} from '../stage/entity_sprites.ts';
import {
  type RecipeTree,
  buildRecipeTree,
  checkCraft,
  missingReport,
} from '../ui/recipe_tree.ts';
import {
  buildTelegraph,
  bossHudFrom,
  decayGhost,
  layoutHpBar,
  type BossHudView,
  type TelegraphSpec,
} from '../ui/boss_hud.ts';
/* ★ 2026-11(第六轮审计 P1):`meta.partyMode/partyTimer/scoreA/scoreB` 此前
   **零读点**(`client/src` 命中 0)⇒ 派对/比分永远不上屏。判定(模式词表换算、
   文本拼装)全在 `ui/party_hud.ts`(纯函数、零 DOM ⇒ 可被 node 直接断言),
   本文件只把它的输出每帧写进 `#hint` 与自检口径。 */
import { partyHudOf, type PartyHudView } from '../ui/party_hud.ts';
/* ★ WS-FND-151:`SET_PARTY_MODE` 的**选择器**(纯逻辑)+ 急行开工条件清单(三态)。
   接线前那 8 条管理类动作全部登记为"客户端刻意不提供",其中 `SET_PARTY_MODE`
   的理由写得最具体:「四选一要选择器 + 权限位」。这个文件就是补那块选择器。 */
import {
  PARTY_MODE_COUNT,
  movePartyCursor,
  partyModeOptionAt,
  partyPanelOf,
} from '../ui/party_panel.ts';
import {
  RUSH_SNAPSHOT_GAP,
  rushReadinessOf,
  type RushReadinessInput,
} from '../ui/rush_readiness.ts';
/* ★ 第六轮审计 P1/P3:接线台账。**生产里也读它** —— `summary().wiring.ledger`
   把"哪些装配函数仍未接"变成自检口径里的读数;只有测试读它的话,
   这块信息在真机上就又不可见了(那正是本轮要消灭的形态)。 */
import { WIRING_LEDGER, validateLedger } from '../wiring_ledger.ts';
import {
  buildRoofMask,
  labelRoofComponents,
  componentAt,
  advanceFade,
  isRoofTile,
  type RoofComponents,
  type RoofFadeState,
  ROOF_MIN_ALPHA,
} from '../stage/roof_transparency.ts';
import { PixelEasel } from '../ui/pixel_easel.ts';
import {
  clampCellRange,
  collectBlueprint,
  blueprintSummary,
  isDrag,
  normalizeScreenRect,
  screenRectToWorldRect,
  type ScreenRect,
} from '../ui/blueprint.ts';
import {
  DO_MI_SOL_PITCHES,
  PITCH_BRICK_COLS,
  PITCH_BRICK_ROWS,
  pitchBrickIndex,
  pitchBrickPosition,
} from '../audio.ts';
import { BOSS_LIST } from '../../../shared/constants/bosses.ts';
import { UiOverlay, inventoryTabCategories, type UiDrawState, type UiHit } from './ui_binding.ts';
/* ★ WS-FND-166:「这一下算不算按在 **UI** 上」的判定住在 `ui/panel_hit.ts`(纯、零 DOM、
   node 里可断言)。修前 boot 只看"命中了哪个格子"⇒ 按在**面板空白处**返回 `none`
   ⇒ 世界拖动与 window 上的虚拟摇杆**同时**吃掉这一下(实测:单指拖背包时角色一边走)。 */
import { uiConsumesPoint, type UiHitArgs, type UiHitLayouts } from '../ui/panel_hit.ts';
import { createAudio, type AudioHandle } from './audio_out.ts';
/* task-67 阶段 3:玩家位置改由**权威状态**提供(不再从 `pan` 抄,见 S1 注释)。
   这两个模块都**纯**(零三方、零 DOM)⇒ 可被 WS-12 直接 import 断言。 */
import { ClientStateStore } from '../net/state_store.ts';
import { telegraphCenterOf } from '../net/telegraph_center.ts';
/* ★ 第十轮(WS-FND-138):提示条要把**两张键位表**都报出来(`#hint` 的 `keysHint`)。
   两张表住在 `net/action_binding.ts`(纯模块、零 DOM),这里只读它,不手抄一份键位
   —— 手抄的那份必然与真表漂,而"提示写着 N、其实按不到"是最难查的一种。 */
import { entryKeyHints, hotbarKeyHints } from '../net/action_binding.ts';
/* ★ 第十轮 P1:背包拖拽是**本地整理视图**(`dragUplink = 'local-only'` 这个读数
   就是为了让"它没发报文"可被断言,而不是只在注释里)。 */
import { DRAG_UPLINK } from '../ui/inventory.ts';
/* ★ WS-FND-23:相机跟随**权威位置**。判定全在 `net/camera_follow.ts`(纯函数、
    零三方、零 DOM ⇒ 可被 `tests/WS-FND-23` 在 node 里直接断言),本文件只剩
    **每帧一个调用点**。
    ⚠️ 与此同批删掉了「WASD 顺手平移相机」的写点(`pan.x += ...`):那是**巧合**,
    不是跟随 —— 相机现在由权威位置驱动,角色由 `main.ts` 的输入链路驱动。 */
import {
   CAMERA_EDGE_PAD,
   CAMERA_SMOOTHING_SEC,
   CAMERA_SNAP_DISTANCE,
   cameraTargetFor,
   stepCamera,
   type CameraPoint,
 } from '../net/camera_follow.ts';
/* ★ WS-FND-48:线上 `z`(**高度**)终于被用起来 —— 判定全在 `net/height_placement.ts`
   (纯函数、零三方、零 DOM ⇒ 可被 `tests/WS-FND-48` 在 node 里直接断言),本文件只剩
   **每帧一个调用点**。接线前 `z` 被解析进 `RoomState` 却没有任何读者 ⇒
   「跳起来的玩家」与「站在地上的玩家」在屏幕上**完全一样**,且不报任何错。
   ⚠️ `z = 0`(服务端 `physics.spawn(..., z: 0)` 的默认值)时本模块的输出与接线前
   **逐字段相同**(立牌 z 仍只取地形高程,相机 `focusZ` 仍是 0)⇒ 既有表现不变。 */
import {
  placementForHeight,
  localPlayerZOf,
  /* ★ WS-FND-51:相机高度的**每帧推进**也走纯函数 —— 接线时那一版是直接赋值,
     镜头在同一帧内跳到目标高度(真浏览器里闪一下,且不报任何错)。 */
  stepCameraHeight,
} from '../net/height_placement.ts';
/* ★ WS-FND-113:`PredictedPose` 只是**类型** ⇒ `import type`(渲染层不臆测它的形状,
   更不反向驱动预测器:它每帧"拉一次、画出来",仅此而已)。 */
import type { PredictedPose } from '../net/predictor.ts';
/* task-83:玩家可见物。位置来源**唯一** —— 权威状态经 `telegraphCenterOf`,
   本文件只把那个位置翻译成 three 的摆放参数(纯逻辑在 `stage/assembly_math.ts`)。 */

/** 帧率统计窗口(毫秒) */
const FPS_WINDOW_MS = 500;

/**
 * 图集图片 URL。
 *
 * 图集是 2.1MB 的 PNG,不进 git(`.gitignore` 忽略 `_design/`),
 * 由构建/部署时拷到站点根。这里用相对 URL 从页面同目录取。
 */
const ATLAS_URL = 'atlas_sprites.png';

/** 角色(玩家/NPC)立牌边长,世界单位:图集帧四周有留白,2.4 格边长时人物本体约一格半高。 */
/** 触屏设备的默认缩放档(必须是 `ZOOM_LEVELS` 里的一档)。 */
const TOUCH_DEFAULT_ZOOM = 1.5;
const CHARACTER_SIZE_WORLD = SPRITE_CELL_WORLD * 2.4;
/** 野生动物立牌边长。 */
const MOB_SIZE_WORLD = SPRITE_CELL_WORLD * 2.0;

/** 模块级缓存:整页只加载一次图集(3 个以上精灵共享同一 Image) */
let atlasImagePromise: Promise<HTMLImageElement | null> | null = null;

/**
 * 加载图集图片。失败返回 `null`(**不抛**):没有图集时场景仍要能跑,
 * 只是没有立牌 —— 把「资源缺失」升级成「白屏」会让排查更困难。
 */
function loadAtlasImage(): Promise<HTMLImageElement | null> {
  if (atlasImagePromise !== null) return atlasImagePromise;
  atlasImagePromise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = ATLAS_URL;
  });
  return atlasImagePromise;
}

export interface BootHandle {
  /** 已渲染的世界摘要,供自检/截图脚本读取 */
  summary: () => Record<string, unknown>;
  dispose: () => void;
  /**
   * 权威状态存储(task-67 阶段 3)。
   *
   * 暴露它有两个原因:① 网络层(`session.ts`)拿到字节后要写进**同一个** store;
   * ② 自检脚本能读到「权威位置是否真的到了」,而不只是"画面看起来对"。
   */
  store: ClientStateStore;
  /**
   * ★ WS-FND-113 第 2 处:接上**预测姿态源** —— 每帧拉一次,`null` = 没有预测。
   *
   * ## 为什么是函数(每帧拉)而不是一个值
   * 渲染 60Hz、预测 32Hz。存一个值进来,渲染就会画"上次 push 进来的那个"位置,
   * 最多滞后一帧 —— 与"滞后一个 RTT"只是程度不同,而两者的**症状看起来一样**。
   *
   * ## 为什么 `null` 必须退回权威
   * 单机 / 权威还没到时没有预测可言。此时若拿 `(0,0)` 顶上,立牌会闪到世界原点
   * —— 一个看起来合法的错误位置(与 `telegraphCenterOf` 的 `null` 同一条理由)。
   */
  setPoseSource: (fn: (() => PredictedPose | null) | null) => void;
  /**
   * ★ 第七轮审计 P2:当前是否处于**文本输入态**(背包/配方搜索框)。
   *
   * ## 为什么必须是宿主读得到的
   * `searchMode` 是本文件闭包里的一位状态,而"要不要让路"的判定在 `main.ts` 的
   * `keydown` 里(`ACTION_KEYS` / 空格攻击)。修前两处互不知情 ⇒
   * 搜索框里打 `e` 会**同时**追加查询字符并发出 `BREAK_BLOCK`。
   *
   * ## 为什么是"拉"而不是装一个回调
   * 装回调要多维护一份同步(谁在什么时候通知谁),而**漏通知**的症状与修前完全一样
   * (会误发、且不报错)。拉取只读当下这一位,不存在过期问题:
   * 本文件的 `keydown` 监听比 `main.ts` 先注册,所以同一次按键里它已经更新过 `searchMode`。
   */
  textInputActive: () => boolean;
  /**
   * ★ WS-FND-151:接上「选中的模式怎么发出去」。
   *
   * ## 为什么是注入而不是本文件自己发
   * 本文件不持有 `SessionHandle`(那是 `main.ts` 的装配根),而报文必须经
   * `net/action_entry.ts` 的三支分流(参数不对 / 未连接 / 发)⇒ 这里只留一个
   * **端口**:`(mode, key) => 一句玩家读得到的话`。
   * `null` = 单机(`?server=off`)⇒ 选中时如实说"未联机",而不是静默。
   */
  setPartyModeSink: (fn: ((mode: number, key: string) => string) | null) => void;
  /**
   * ★ WS-FND-166:触屏按钮条的开合入口。
   *
   * ## 为什么需要它
   * 面板键位表(`ui/panel_keys.PANEL_KEYS`)全是字母键(`i/r/h/p/m`),
   * 而手机**没有键盘** ⇒ 真机上五个面板一个都打不开。屏幕按钮是"最低方案",
   * 而按一下要走的是**同一台状态机**(不是另开一条开关面板的路)。
   */
  togglePanel: (panel: UiPanel) => void;
  /** 触屏按钮条的「关」(`OPEN/OPENING/ERROR` → `CLOSED`,合法迁移)。 */
  closePanel: () => void;
  /**
   * ★ WS-FND-166:**这一下算不算按在 UI 上**(面板容器 ∩ 面板内的部件)。
   *
   * ## 为什么必须由宿主(而不是事件顺序)决定
   * 摇杆与攻击的监听都挂在 `window`(冒泡层),而同一次指针事件会**先**经过画布。
   * 「谁先执行」是注册顺序的函数,一旦有人插一条监听就翻车 —— 而且不报错。
   * ⇒ 这里给一个**纯判定**(`ui/panel_hit.uiConsumesPoint`),`main.ts` 先问它。
   */
  uiHitAt: (x: number, y: number) => boolean;
  /**
   * ★ WS-FND-184:把**服务器下行的地形**铺上屏幕(改前屏幕上是本地重算的设计图)。
   *
   * ## 为什么是"推"而不是让本文件轮询块存储
   * 块存储住在 `main.ts`(装配根;与它的 `store` 同一纪律),本文件不持它
   * ⇒ 本文件只在**帧到了**那一刻被调一次(`session` 的 `onTerrain`)。
   * 反过来让 boot 自己轮询,就需要第二份"哪块脏了"的判定 —— 而那份判定
   * 与 `ClientChunkStore.dirty()` 迟早会漂移。
   *
   * ## 返回值的三个数各有分工
   * ```text
   * rebuilt   本次真的重建了几块(0 = 没有新字节 / 回落)
   * total     屏幕上现在一共几块地形(服务器块 + 还没被替换掉的设计图占位)
   * full      本次是**首帧整表对齐**(设计图占位整份让位)
   * fallback  来源是空的 ⇒ 屏幕上仍是设计图占位(已 console.warn 留痕)
   * ```
   * ⚠️ `dirtyKeys` 由调用方给(`ClientChunkStore.dirty()`),并且**调用方负责**
   *    重建完之后 `clearDirty()` —— 脏标记是消费型的(见 chunk_store 的头注释)。
   */
  applyTerrainChunks: (
    next: readonly ChunkInput[],
    dirtyKeys: readonly string[],
  ) => { rebuilt: number; total: number; full: boolean; fallback: boolean };
  /**
   * ★ WS-FND-188:**接上服务端下发的 NPC 表**(`hello`/`welcome` 之后一次)。
   *
   * ## 为什么是端口 + 注入(而不是本文件自己收帧)
   * 帧的接收与分流在 `client/src/net/session.ts`(它持有 socket),而本文件不持会话
   * ⇒ 与 `setPoseSource` / `setPartyModeSink` 同一条手法:装配根(`main.ts`)把两端接上,
   * 本文件只留「表到了之后怎么画」这一段。
   *
   * ## 语义:整表替换,不合并
   * NPC 表是**静态**的、每次都是整份 ⇒ 合并两份静态表只会多出一个漂移点
   * (删掉一个 NPC 之后,旧的立牌会永远留在场景里,而不报错)。
   *
   * 空数组是**合法**输入 = 这个房间没有 NPC(立牌全摘)。
   */
  setNpcs: (npcs: readonly NpcWireDef[]) => void;
  /**
   * ★ WS-FND-188:把**一句台词**写到 HUD 那一行(`''` = 清掉)。
   *
   * 台词由服务端在 `dialogue.talk` 里选(它按任务状态挑),客户端只显示 ——
   * 本文件不生成任何台词文案(两份台词表迟早漂,而漂的表现是"玩家读到的这句
   * 与服务端认为它该听到的那句不同",两端都不报错)。
   */
  showTalk: (text: string) => void;
}


/* ═══════ ★ WS-FND-184:服务器下行的地形 → 建面(改前屏幕上画的是本地重算的设计图)═══════
 *
 * ## 改前是什么样(这一块要修的那一件事)
 * ```text
 * 服务端:w89 起按 `chunkVersions` 下行**真块字节**(1032 B/块,见 shared/net/terrain.ts)
 * 客户端:session.ts 解完写进 `ClientChunkStore` …… 然后就**停在那里**(零消费者)
 * 屏幕  :本文件的地形仍是 `buildDesignChunks()` 在本地重算的那张设计图
 * ```
 * ⇒ 玩家盖的墙、拆的块、被载具改过的地形**一个字节都到不了屏幕**,
 *   而没有任何东西会红:连接是 `live`、快照照常到、画面也在动、地形面数也一样。
 *
 * ## 三条语义(判据见 `tests/WS-FND-184-terrain-client-wiring.test.ts`)
 * ```text
 * 1 设计图是**首帧占位**,不是真相 —— 第一帧服务器块到了 ⇒ **整表对齐**(full);
 * 2 增量:只重建**脏**块(`ClientChunkStore.dirty()` 给出的 key),
 *   旧几何必须 `dispose()` —— 块是每帧 8 个地来的,手机几轮就能把显存吃光,而那不报错;
 * 3 一个块都没收到 ⇒ **保留设计图回落**(拿不到服务器块时世界也要看得见),
 *   且回落**留痕**(`console.warn` + HUD 那行地形来源)—— 静默回落与"设计图就这样"同形。
 * ```
 *
 * ## 为什么判定抽在这里,而不是写进 `boot()`
 * `boot()` 顶层 `import three` 且碰 `document` ⇒ node 里加载不了它**内部**的任何东西,
 * 写进去就没法断言。本函数零依赖(只吃 `ChunkInput[]` 与 key 列表)⇒
 * 可以用**真的** `ClientChunkStore` 的输出直接喂它(见测试里的 3 块只脏 1 块那条)。
 */

/** 地形来源的两个取值(自检口径与 HUD 用**同一份**词表,不造第二处)。 */
export const TERRAIN_SOURCE_SERVER = 'server';
export const TERRAIN_SOURCE_DESIGN = 'design';

/** 一次地形下行的重建计划。 */
export interface TerrainRebuildPlan {
  /** 需要(重)建的块 —— 顺序取来源顺序(稳定序,与写入顺序 / 帧顺序**无关**)。 */
  rebuild: ChunkInput[];
  /** 本次是**整表对齐**:屏幕上还一块服务器块都没有,设计图占位必须整份让位。 */
  full: boolean;
  /** 来源是空的 ⇒ **保留设计图回落**(不建任何块、不摘任何块)。 */
  fallback: boolean;
}

/**
 * 该建哪些块 —— **纯函数**(喂真 `ClientChunkStore` 的 `chunks()` / `dirty()`)。
 *
 * @param source           服务器已落地的全部块(`ClientChunkStore.chunks()`)
 * @param dirtyKeys        还没被消费的脏 key(`ClientChunkStore.dirty()`)
 * @param hasServerTerrain 屏幕上当前那块地形**是不是服务器来源**
 *                         (`false` = 还是设计图占位)
 */
export function planTerrainRebuild(
  source: readonly ChunkInput[],
  dirtyKeys: readonly string[],
  hasServerTerrain: boolean,
): TerrainRebuildPlan {
  /* 1 一块都没收到 ⇒ 保留设计图占位(拿不到服务器块时世界也要看得见)。
       已经吃过服务器块之后再遇到空来源(重连时 `reset()`)⇒ **保持现状**:
       把屏幕换回另一张图比"不动"更糟 —— 看起来像"世界变了",其实只是没人发块。 */
  if (source.length === 0) return { rebuild: [], full: false, fallback: !hasServerTerrain };
  /* 2 首帧:屏幕上还是设计图占位 ⇒ **整份**替换。
       只换脏块会让"设计图的另一半"留在屏幕上,而半张图的世界看起来完全正常。 */
  if (!hasServerTerrain) return { rebuild: [...source], full: true, fallback: false };
  /* 3 增量:只重建脏块(`dirtyKeys` 空 = 没有新字节 ⇒ 一块都不动)。 */
  if (dirtyKeys.length === 0) return { rebuild: [], full: false, fallback: false };
  const dirty = new Set(dirtyKeys);
  return { rebuild: source.filter((c) => dirty.has(c.key)), full: false, fallback: false };
}

/* ══════════ ★ WS-FND-188:NPC 上屏的**判定**(纯函数)+ 立牌跟块的两条计划 ══════════
 *
 * ## 这两块为什么要抽成纯函数(而且就放在本文件里)
 * 本文件顶层 `import three` 且 `boot()` 里碰 `document` ⇒ 它**内部**在 node 里跑不了;
 * 而 `planTerrainRebuild` 已经证明「零依赖的判定 + 纯数据入参」这条路可用
 * (`tests/WS-FND-184` 直接 import 本文件)。⇒ 把「谁在旁边 / 立牌该摘谁、该加谁 /
 * NPC 摆哪一格」全部抽出来,判据就能喂**真** `ClientChunkStore` 与**真** `NPCS`。
 *
 * ## 一个刻意的不对称
 * `planPropApply` 只回答「哪些 chunk key 该整块摘、哪些该整块加」——
 * 它**不**看块里的内容(立牌的**内容**由 `planChunkProps` 算)。
 * 分开的理由:跟块这件事是**表结构**问题(键集),而"一格该出什么立牌"是
 * 玩法/内容问题;混在一起之后,"改了两格却没摘旧立牌"这类错误就没法单独断言。
 */

/** 与 NPC 说话用的那一个键(客户端;与 `net/action_target.ACTION_KEYS` 的 `T` 共用)。 */
export const NPC_TALK_KEY = 't';

/**
 * 交互半径(格)—— 与 `server/src/npc/defs.ts` 的 `NPC_TALK_RADIUS` **同值**。
 *
 * ⚠️ 为什么客户端这里必须**再写一个数**(而不是 import 服务端那个常量):
 *   客户端包**不许** import 服务端模块(`server/**` 不进浏览器包),而判定又必须在
 *   两端都成立(客户端决定"按 T 是说话还是用道具",服务端决定"这条报文算不算数")。
 *   ⇒ 两份数各写一次是**已知代价**;判据 `WS-FND-188` 里有一条**逐值相等**的断言
 *   (它同时 import 两边),让漂移当场红。
 */
export const NPC_TALK_RADIUS_CELLS = 2.5;

/**
 * NPC 立牌用图集里的**哪一格贴图**(固定一个物品 id)。
 *
 * ## 依据(不是随手挑的)
 * 图集 1280×1152 / 格 64px,`cellIndexFromId` 按物品号段映射;
 * `docs/ATLAS-SPRITES-EVIDENCE.md` 里**没有**任何 NPC 立绘格(逐格取证只覆盖
 * 景物/物件)⇒ 只能在物品表里挑一个**人形、立着**的贴图:
 * 532「拳击测力稻草人靶」= 稻草人(人形躯干 + 头,且本身立在地上)。
 * ⇒ **临时**用它,如实标注:这是占位,不是"NPC 的美术"。
 *   正确的收尾是让美术给 NPC 单独一段号段(与 `VEGETATION_IDS` 那条注释同一个结论)。
 * 判据 `WS-FND-188` 钉住 `cellIndexFromId(532) >= 0`:图集里没这一格会当场红。
 */
export const NPC_SPRITE_ITEM_ID = 532;

/** 一条 NPC 立牌计划(纯数据;摆放由装配层做)。 */
export interface NpcSpritePlan {
  /** `NpcWireDef.id`(线上 id —— 立牌表按它索引)。 */
  id: string;
  name: string;
  /** 世界格坐标(与 `NpcDef.home` 同一对数字,原样带过来)。 */
  x: number;
  y: number;
  /** 图集 row-major 格号;`-1` = 图集里没有这一格(装配层跳过,不猜邻近格)。 */
  atlasCell: number;
  /** 立牌高度(屏幕像素;装配层按 `heightPx / pixelScale` 换算世界单位)。 */
  heightPx: number;
  /** 该 NPC 是否有任务(UI 用;台词**不上线**,见 `NpcWireDef`)。 */
  hasQuest: boolean;
}

/**
 * NPC 表 → 立牌计划(纯函数)。
 *
 * 高度缺省 28px = `entity_sprites.SPRITE_HEIGHT_PX.player` —— 与玩家立牌**同高**:
 * 「人比人高」在等轴测下会被读成"另一个物种",而 NPC 与玩家是同一类东西。
 */
export function planNpcSprites(
  npcs: readonly NpcWireDef[],
  heightPx: number = 28,
): NpcSpritePlan[] {
  const fallback = cellIndexFromId(NPC_SPRITE_ITEM_ID);
  return npcs.map((n) => {
    /* 图集有六张角色帧 ⇒ NPC 是人不是稻草人;取不到才退回 532。 */
    const own = cellIndexFromId(characterAtlasId(n.id));
    return {
    id: n.id,
    name: n.name,
    x: n.x,
    y: n.y,
    atlasCell: own >= 0 ? own : fallback,
    heightPx,
    hasQuest: n.quest !== undefined,
    };
  });
}

/**
 * 离 `(x, y)` **最近**且在 `radius` 内的 NPC(纯函数)。
 *
 * ## 与 `server/src/npc/defs.ts#npcAt` 的口径**逐条对齐**
 * 半径含边界(`<=`)—— 「恰好 2.5 格」算在范围内:两端不一致时的症状是
 * "客户端说能说话、服务端说太远",而**两端都不报错**,玩家只看到"按了没反应"。
 * 平局按声明顺序取前者(确定性,不靠 Map 迭代序)。
 * 非有限读数 ⇒ `null`(不知道玩家在哪时**不猜** —— 猜出来的位置会让人在出生点
 * 就能跟农田里的 NPC 说话)。
 */
export function nearbyNpc(
  npcs: readonly NpcWireDef[],
  x: number,
  y: number,
  radius: number = NPC_TALK_RADIUS_CELLS,
): NpcWireDef | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) return null;
  let best: NpcWireDef | null = null;
  let bestD = Infinity;
  for (const n of npcs) {
    const d = Math.hypot(x - n.x, y - n.y);
    if (d <= radius && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

/**
 * HUD 里那一行「按 T 与 <名字> 说话」。
 *
 * 附近没有人 ⇒ **空串**(调用方据此不写这一行 —— 写一行"按 T 与 null 说话"比不写更糟)。
 * ⚠️ 文案必须同时说清「走开之后 T 还是使用道具」:修前 `T` 是 `USE_ITEM`
 * (`net/action_target.ACTION_KEYS` 的既有键位),站在 NPC 旁边时它被这条**抢走**。
 * 不写清楚的话,玩家读到的是"站在镇长面前按 T,道具突然用不了了"。
 */
export function npcHintLine(npc: NpcWireDef | null): string {
  if (npc === null) return '';
  return `按 ${NPC_TALK_KEY.toUpperCase()} 与「${npc.name}」说话(走开之后这个键仍是使用道具)`;
}

/**
 * 把动作回执的 `effect` 拼成 HUD 上那一行台词。
 *
 * 服务端回的是 `{ npc, line, ... }`(见 `server/src/net/actions/npc_talk.ts` 的
 * `effect`):**台词由服务端选**(它按任务状态在 `dialogue.talk` 里挑),客户端只**拼接**,
 * 不生成第二份台词表 —— 两份台词表迟早漂,而漂的表现是「玩家读到的这句,与服务端
 * 认为它该听到的那句不同」,两者都不报错。
 *
 * 缺 `line`(老服务端 / 别的动作的回执)⇒ 空串,调用方不写这一行。
 */
export function npcTalkTextOf(effect: Record<string, unknown> | undefined | null): string {
  if (effect === undefined || effect === null) return '';
  const line = effect.line;
  if (typeof line !== 'string' || line.length === 0) return '';
  const who = effect.npc;
  const name = typeof who === 'string' && who.length > 0 ? who : 'NPC';
  return `${name}:${line}`;
}

/** 立牌跟块的**表结构**计划(见上面「一个刻意的不对称」)。 */
export interface PropApplyPlan {
  /** 要整块摘掉的 chunk key(顺序 = `rebuild` 的顺序,稳定)。 */
  remove: string[];
  /** 要整块(重)建立牌的块(顺序 = `rebuild` 的顺序)。 */
  add: ChunkInput[];
}

/**
 * 一次地形下行里,立牌该摘哪些块、建哪些块(**纯函数**)。
 *
 * ## 为什么"重建的块一律先摘再建"
 * 玩家拆了那一块的墙 ⇒ 同一块的立牌列表**变了**(可能变少、也可能换 id)
 * ⇒ 只"加"会把旧立牌留在场景里(幽灵墙),只"摘"会让它整块消失。
 * ⇒ 计划里 `add` **总是**包含全部被重建的块;`remove` 只含"当前真的有立牌"的那些
 * (摘一个不存在的键在装配层是空操作,但把它列进计划会让读数虚高)。
 */
export function planPropApply(
  existingKeys: readonly string[],
  rebuild: readonly ChunkInput[],
): PropApplyPlan {
  const have = new Set(existingKeys);
  const remove: string[] = [];
  for (const c of rebuild) if (have.has(c.key)) remove.push(c.key);
  return { remove, add: [...rebuild] };
}

/** 立牌总数上限(与装配层**同一个数**;导出是为了让判据能钉住它,不写第二份)。 */
export const PROP_SPRITE_BUDGET = 600;

/**
 * 一块地形的**全部**立牌(物件 + 植被),顺序确定性:**先物件、后植被**。
 *
 * 顺序是**契约的一部分**:预算吃紧时被截断的正是尾部 ⇒ 「先物件」保证玩家能交互的
 * 东西(墙/灯/箱/台)在预算不足时**留在屏幕上**,丢掉的只是装饰。
 */
export function planChunkProps(
  chunk: ChunkInput,
  vegetationIds: readonly number[],
  seed: number,
): ObjSpriteInput[] {
  return [...planObjSprites(chunk), ...planVegetationSprites(chunk, vegetationIds, seed)];
}
/**
 * 在 `container` 里启动舞台。
 *
 * 复杂度:建面 O(格数),主循环 O(1)(只做相机更新与一次 render)。
 */
export function boot(container: HTMLElement): BootHandle {
  /* ── 渲染器 ── */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  /* 注意:outputColorSpace 默认已是 SRGBColorSpace,不必重复设 */
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  /* 深蓝夜空 —— 与手册「绘本」基调一致,也让地形边缘看得清 */
  scene.background = new THREE.Color(0x121a2b);

  /* ── 相机:35° 俯角 / 45° 方位角正交 ── */
  const isoCam: IsoCamera = createCamera(window.innerWidth, window.innerHeight);
  /* createCamera 的 focus 默认 (0,0) 是世界角落,不是中心 ——
  /* createCamera 的 focus 默认 (0,0) 是世界角落,不是中心 ——
     不显式搬过去视野会偏到边上(实测偏右下)。
     ★ w85:世界换成**设计图**(192×192,营地在中点)⇒ 焦点必须跟世界边长走 */
  isoCam.focusX = DESIGN_WORLD_CELLS / 2;
  isoCam.focusY = DESIGN_WORLD_CELLS / 2;
  /* 触屏(手指为主输入)默认放大一档:一格只有 16px,390 宽的屏上一次看到太多格子,
     角色只有几十像素高、辨认吃力。键盘设备保持 1×;玩家仍可用 [ ] 调档。
     没有 matchMedia(node 断言环境)⇒ 按键盘设备处理。 */
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
    isoCam.zoom = TOUCH_DEFAULT_ZOOM;
  }
  const camera = buildOrthographicCamera(isoCam);

  /* ── 光:两盏方向光 + 环境光。等轴测下方向光比点光稳定 ── */
  const key = new THREE.DirectionalLight(0xfff3dc, 2.0);
  key.position.set(-0.6, -0.9, 1.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x93b8ff, 0.85);
  fill.position.set(0.8, 0.5, 0.6);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  /* ── 地形 ── */
  const t0 = performance.now();
  /* ★ w85:**设计过的世界**,与服务器同一张图。
     此前这里是 `makeDemoWorld()`(64×64 正弦起伏 + 一条河 + 地板槽位循环)——
     那正是「地图小、一堆像素块、没设计」的字面来源。
     失败时**回落 demo 并留痕**:静默回落会让「世界又变回像素块」看起来像
     「设计没生效」,而那种缺陷不会报错。 */
  const chunks: ChunkInput[] = (() => {
    try {
      return buildDesignChunks();
    } catch (e) {
      console.error('[terrain] 设计世界生成失败,回落到 demo:', e);
      return makeDemoWorld();
    }
  })();
  /* 地形规模(供 HUD 显示):**读真实的块列表**,不是常量。 */
  const worldCells = chunks.length === 0
    ? 0
    : Math.max(...chunks.map((c) => (c.cx + 1) * CHUNK_SIZE));
  /**
   * 已建的地形 mesh,**按块 key** 索引(`"cx,cy"` —— 与 `ChunkInput.key` /
   * `ClientChunkStore` 的键 / `diffChunkVersions` 同一口径)。
   *
   * ⚠️ 改前是一个数组。数组只能**整份**重建,而服务器是**增量**下块
   * (`TERRAIN_CHUNKS_PER_FRAME` = 8 块/帧)⇒ 每帧重建全图在手机上直接卡死,
   * 而屏幕上只会表现为"走一步卡一下"(看不出成因)。
   */
  const meshes = new Map<string, THREE.Mesh>();
  /** 每块已建 mesh 的读数(刷新总数与 HUD 用;删块时按它减回去)。 */
  const terrainStats = new Map<string, { cx: number; cy: number; verts: number; faces: number }>();
  let totalVerts = 0;
  let totalFaces = 0;
  /** 屏幕上那块地形是不是**服务器来源**(`false` = 还是设计图占位)。 */
  let terrainFromServer = false;
  /** 地形落地的三个读数(自检口径,见 `summary()`)。 */
  let terrainApplyCalls = 0;
  let terrainRebuiltChunks = 0;
  let terrainDisposedGeoms = 0;
  /** 回落只 warn 一次:每帧 warn 会把控制台刷满,真正的错误就淹没了。 */
  let designFallbackWarned = false;

  /* 单一材质:所有 chunk 共用,是减少 draw call 的前提。
   *
   * ★ WS-FND-89:这里曾经是 `new THREE.MeshLambertMaterial({ color: 0x9fd6a0 })` ——
   *   `vertexColors` 默认 `false`,于是几何上那份 `color` 属性**没有任何读者**,
   *   真机地形恒为一块单色,而 `stage/terrain_vcolor` 的全部判据(长度、值域、
   *   没有采样器)照样全绿:它们查的是几何与常量,不是「谁在读它」。
   *
   *   现在材质来自装配层的 `buildTerrainMaterial()`(顶点色 + 无纹理),并且
   *   **每帧**把相机矩阵喂给它(见 tick 里的 `syncTerrainCamera`)——
   *   raw 材料 three 不注入矩阵,漏掉那一行地形会整片消失。
   */
  const mat = buildTerrainMaterial();
  /* ★ w100:图集就绪后**绑一次** ⇒ 地形顶面开始采样地砖格(改前只有纯顶点色)。
     `img === null`(fetch 失败)时 `bindTerrainAtlas` 保持"未就绪"⇒ 退回纯顶点色,**不黑屏**。 */
  void loadAtlasImage().then((img) => { bindTerrainAtlas(mat, img); });

  /**
   * 建(或重建)一块的地形 mesh 并登记读数。
   *
   * 顶点由纯逻辑层 `stage/chunk_geometry` 产出,与计数同源。
   * ★ 首帧与增量重建**共用这一个函数** —— 两条建面路径迟早会漂移
   * (`addTerrainMesh` 里忘了登记读数,HUD 的顶点/面数就只增不减)。
   */
  /* 建筑实心盒子:墙 / 门窗 / 屋顶画成有体积的方块(见 `stage/building_boxes.ts`),
     每块地形一个 mesh,与地形 mesh 同生同灭。 */
  const buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const buildingMeshes = new Map<string, THREE.Mesh>();
  const addBuildingMesh = (chunk: ChunkInput): void => {
    const b = planBuildingBoxes(chunk);
    if (b.faceCount === 0) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(b.colors, 3));
    g.setIndex(new THREE.BufferAttribute(b.indices, 1));
    const m = new THREE.Mesh(g, buildingMat);
    m.name = `building_${chunk.key}`;
    scene.add(m);
    buildingMeshes.set(chunk.key, m);
  };
  const removeBuildingMesh = (key: string): void => {
    const m = buildingMeshes.get(key);
    if (m === undefined) return;
    scene.remove(m);
    m.geometry.dispose();
    buildingMeshes.delete(key);
  };

  const addTerrainMesh = (chunk: ChunkInput): void => {
    const geom = buildChunkGeometry(chunk, 0);
    const verts = geom.getAttribute('position').count;
    const faces = (geom.getIndex()?.count ?? 0) / 6;
    totalVerts += verts;
    totalFaces += faces;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = chunk.key;
    scene.add(mesh);
    meshes.set(chunk.key, mesh);
    terrainStats.set(chunk.key, { cx: chunk.cx, cy: chunk.cy, verts, faces });
    addBuildingMesh(chunk);
  };

  /**
   * 摘掉一块的地形 mesh。
   *
   * ★ `geometry.dispose()` **不是可选的**:一块 16×16 的新几何会一直留在 GPU 上,
   *   而增量重建是"每帧最多 8 块"来的 —— 手机几轮就爆,且**不会有任何报错**
   *   (`renderer.info.memory.geometries` 才是那条线索)。
   *   反向判据:`tests/WS-FND-184` 里删掉这一行必须红。
   */
  const removeTerrainMesh = (key: string): boolean => {
    const mesh = meshes.get(key);
    if (mesh === undefined) return false;
    removeBuildingMesh(key);
    scene.remove(mesh);
    mesh.geometry.dispose();
    meshes.delete(key);
    const st = terrainStats.get(key);
    if (st !== undefined) {
      totalVerts -= st.verts;
      totalFaces -= st.faces;
      terrainStats.delete(key);
    }
    terrainDisposedGeoms += 1;
    return true;
  };

  /* 首帧:先按**设计图占位**(一个服务器块都没到时,世界也要看得见 —— 见 `planTerrainRebuild`)。 */
  for (const chunk of chunks) addTerrainMesh(chunk);
  /* ══════════ ★ w90:世界里的**东西**(obj 立牌 + 植被)══════════
   *
   * ## 改前是什么样
   *
   * `obj` 层**完全不渲染** —— `chunk_geometry` 只把"这格有 obj"当成"非空"来建面,
   * 从不产出任何 sprite。于是设计图里写的路灯(522)、广场四角承重墙(352)、
   * 储物箱(513)、工作台一条街(502~506)、纯金纪念碑(750)**一个都看不见**,
   * 玩家看到的只有地面 ⇒ 「这不是游戏,是一堆色块」。
   *
   * ## 判定与绘制分开
   *
   * "哪一格该出立牌、出图集哪一格、多高"全在纯函数 `stage/obj_sprites.ts`
   * (16 条判据,含"每格都产出必红"的有牙实证)。这里只做三件事:
   *   ① 把计划换成 `THREE.Sprite`(与既有 `atlas_sample` 立牌**同一套数学**);
   *   ② **按图集格缓存材质** —— 一个 Sprite 一个 draw call,每格 new 一个纹理是自杀;
   *   ③ 给总数封顶(`SPRITE_BUDGET`),超了就不再摆。下一步应换成 InstancedMesh
   *      (现在 6% 密度的植被在 192×192 上会到四位数,靠封顶先控住)。
   */
  /**
   * ══════════ ★ WS-FND-188:立牌**跟块走**(改前它们只按首帧的设计图块算)══════════
   *
   * ## 改前是什么样(要修的那一件事)
   * ```text
   * 地形:applyTerrainChunks() 会按脏块重建(WS-FND-184 已通)
   * 立牌:进 boot() 时按 `chunks`(首帧的**设计图占位**)算一次,之后再也没动过
   * ```
   * ⇒ 玩家拆掉一堵墙 / 盖起一格台子,地形面跟着变了,**立牌还是首帧那一份**:
   *   墙拆了但立牌还在(幽灵墙)、新盖的东西一个立牌都没有。而这**不会报错**,
   *   `propSpriteCount` 也照常有值。
   *
   * ## 三条纪律
   * ```text
   * 1 按 chunk key 分组保存 —— 整块摘除是 O(该块的立牌数),不是全表重建
   * 2 摘除只回收**引用**+ scene.remove;材质按图集格**共享** ⇒ 绝不 dispose
   *   (dispose 共享材质会把其它块的立牌一起变成黑块,而且不报错)
   * 3 总数仍封顶 PROP_SPRITE_BUDGET,截断按**确定性顺序**(见 buildPropsOf)
   * ```
   */

  /**
   * 图集材质缓存 —— **立牌与 NPC 共用这一份**(按图集格号索引)。
   *
   * 为什么要提到这里(而不是留在原来那个 promise 回调里):NPC 立牌要用**同一个**
   * 格子的材质(532),两份缓存 = 同一格被上传两次纹理(显存 x2),而且
   * 哪天有人只改了一处,两个东西的观感就会不一致(不报错)。
   */
  const propMaterials = new Map<number, THREE.SpriteMaterial>();
  /** 图集是否就绪(`false` 时只**登记**块,不建 Sprite —— 建了也没有材质)。 */
  let propAtlasReady = false;
  /**
   * `图集格 → 材质`(唯一入口)。
   *
   * ⚠️ `cell < 0` = 不在图集内(未知 id)⇒ **必须跳过**:否则会去采样
   * `offsetRepeatOfCell(-1)`,取到错位的图(不是"什么都不画",是"画了别人的格子")。
   */
  const propMaterialOf = (img: HTMLImageElement, cell: number): THREE.SpriteMaterial | null => {
    if (cell < 0) return null;
    const hit = propMaterials.get(cell);
    if (hit !== undefined) return hit;
    const { offsetU, offsetV, repeatU, repeatV } = offsetRepeatOfCell(cell);
    const tex = new THREE.Texture(img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.offset.set(offsetU, offsetV);
    tex.repeat.set(repeatU, repeatV);
    tex.needsUpdate = true;
    const made = new THREE.SpriteMaterial({ map: tex, transparent: true });
    propMaterials.set(cell, made);
    return made;
  };

  /* ── 立牌表:key → 块数据(立牌的**来源**)与 key → 已建的 Sprite ── */
  const propChunks = new Map<string, ChunkInput>();
  const propsByChunk = new Map<string, THREE.Sprite[]>();
  /** 当前屏幕上的立牌总数(预算与 `summary().propSpriteCount` 的**唯一**来源)。 */
  let propSpriteTotal = 0;
  /** 因预算被丢掉的立牌数(累计)。> 0 说明"该看见的东西没看见",必须有读数。 */
  let propDroppedByBudget = 0;
  /** 当前屏幕上的**植被**立牌数(装饰;物件才是玩法点,植被只能用预算的一小部分)。 */
  let propVegTotal = 0;
  /** 植被立牌上限:总预算的四分之一。否则离玩家最近的几个块里的草丛会把名额吃光,镇上的房子和摊位排不上。 */
  const VEG_SPRITE_CAP = Math.floor(PROP_SPRITE_BUDGET / 4);
  /** 真的摘过几次块(累计;`0` 而地形重建过 ⇒ 跟块这条链断了)。 */
  let propRemovedChunks = 0;

  /** 立牌总数上限(与 `PROP_SPRITE_BUDGET` **同一个数**,不写第二份)。 */
  const SPRITE_BUDGET = PROP_SPRITE_BUDGET;
  /**
   * 植被用哪几个物品当"树/草"。
   *
   * ## 这不是猜的(2026-11-26 实测)
   *
   * 图集 1280×1152、格 64px(20×18),`cellIndexFromId` 按**物品号段**映射;
   * 在 play 页面(同源,不污染 canvas)里解码整张图,逐格算「不透明像素均值 RGB」
   * 与 `green = g − max(r,b)`,取最绿且不透明像素 > 800 的格,再把格号反查回物品 id:
   *
   * | 格号 | 物品 id | 名称 | 实测均值 RGB | green |
   * | ---: | ---: | :--- | :--- | ---: |
   * | 17  | 118 | 柔韧风草 | 73,104,49 | 31.6 |
   * | 161 | 379 | 垂直攀爬藤蔓梯 | 57,99,51 | 41.9 |
   * | 121 | 319 | 伪装落穴草席 | 95,126,81 | 31.4 |
   * | 20  | 121 | 露水甜莓 | — | — |
   *
   * ⇒ 它们的贴图**确实是绿色植被**,不是靠名字猜的。要更多品种(树冠/竹/蘑菇),
   * 正确做法是让美术给"装饰"单独一段号,而不是继续在物品表里挑。
   */
  const VEGETATION_IDS: readonly number[] = [118, 379, 319, 121];
  /** 植被立牌的世界高度(格)。树木要能"盖住人",不然看不出来是树。 */
  const VEG_HEIGHT_WORLD = 2.6;
  /** 植被哈希的种子 —— 世界级的常量(同一份世界长同样的树)。 */
  const VEG_SEED = 0x5eed;
  /** 图集图片本体(材质与 NPC 立牌都要它;`null` = 还没到 / 拿不到)。 */
  let propAtlasImg: HTMLImageElement | null = null;

  /** 一条立牌计划 + 它属于哪一块(摘除按块走 ⇒ 必须记住来源 key)。 */
  type PropSpriteInput = ObjSpriteInput & { chunkKey: string };
  /** 把一条计划变成场景里的 Sprite;预算满了 ⇒ `false`(调用方计数,不静默丢)。 */
  const addPropSprite = (img: HTMLImageElement, it: PropSpriteInput): boolean => {
    /* 墙 / 门窗 / 屋顶已是实心盒子(`addBuildingMesh`),不再画成平的立牌,也不占立牌预算。 */
    if (it.kind === 'obj' && isBuildingObj(it.id)) return false;
    if (propSpriteTotal >= SPRITE_BUDGET) { propDroppedByBudget += 1; return false; }
    if (it.kind === 'vegetation' && propVegTotal >= VEG_SPRITE_CAP) { propDroppedByBudget += 1; return false; }
    const material = propMaterialOf(img, it.atlasCell);
    if (material === null) return false;
    const sp = new THREE.Sprite(material);
    /* 格心 = 格索引 + 0.5;z 取自**地形那一格的高程** ⇒ 脚踩在面上,不悬空 */
    sp.position.set(it.x + 0.5, it.y + 0.5, it.z);
    const h = it.kind === 'vegetation'
      ? VEG_HEIGHT_WORLD
      : (it.heightPx / ATLAS_PX_PER_CELL) * SPRITE_CELL_WORLD;
    sp.scale.set(h * 0.92, h, 1);
    sp.center.set(SPRITE_CENTER_X, SPRITE_CENTER_Y);
    sp.name = `${it.kind}_${it.id}_${it.x}_${it.y}`;
    scene.add(sp);
    let list = propsByChunk.get(it.chunkKey);
    if (list === undefined) { list = []; propsByChunk.set(it.chunkKey, list); }
    list.push(sp);
    propSpriteTotal += 1;
    if (it.kind === 'vegetation') propVegTotal += 1;
    return true;
  };

  /**
   * **摘掉一整块的立牌**(顺序不可换:`scene.remove` 之后才从表里删)。
   *
   * ⚠️ 这里**绝不** `material.dispose()`:材质按图集格缓存在 `propMaterials` 里,
   * 被**多个块**共享。dispose 一个格子的材质会让其它块用同一格的立牌一起变成黑块
   * (而 three 不会报错)。要释放材质只有一条路:`dispose()` 里统一释放缓存表。
   */
  const removePropsForChunk = (key: string): number => {
    propChunks.delete(key);
    const list = propsByChunk.get(key);
    if (list === undefined) return 0;
    for (const sp of list) {
      scene.remove(sp);
      if (sp.name.startsWith('vegetation_')) propVegTotal -= 1;
    }
    propsByChunk.delete(key);
    propSpriteTotal -= list.length;
    propRemovedChunks += 1;
    return list.length;
  };

  /** 建(或重建)一整块的立牌 —— **先摘后建**,预算按确定性顺序截断。 */
  const buildPropsOf = (chunk: ChunkInput): number => {
    removePropsForChunk(chunk.key);
    propChunks.set(chunk.key, chunk);
    if (!propAtlasReady || propAtlasImg === null) return 0;
    const img = propAtlasImg;
    /* `planChunkProps` 的注释写着为什么是"先物件、后植被" —— 截断丢的是尾部。 */
    /* 服务器地形到了之后,草 / 浆果 / 树都是服务端按群系摆的真资源(可采、会再生);
       客户端再随机撒一遍装饰植被,就是在真资源旁边多画一批采不到的假东西,还白占预算。
       ⇒ 只在设计图占位阶段(还没有服务器地形)才撒。 */
    const decorIds = terrainFromServer ? [] : VEGETATION_IDS;
    for (const it of planChunkProps(chunk, decorIds, VEG_SEED)) {
      addPropSprite(img, { ...it, chunkKey: chunk.key });
    }
    return propsByChunk.get(chunk.key)?.length ?? 0;
  };

  /** 登记(或重建)一块 —— `applyTerrainChunks` 与首帧占位共用**这一个**入口。 */
  const addPropsForChunk = (chunk: ChunkInput): number => buildPropsOf(chunk);

  /**
   * 立牌预算按**离焦点块的距离**分配(总数仍封顶 `PROP_SPRITE_BUDGET`)。
   *
   * 修前预算按块 key 字典序用掉,与玩家在哪无关:主世界约 2 万个物件、预算 600,
   * 出生点所在的镇子排在后面 ⇒ 被丢光,画面里只有野地。现在先全摘、再从近到远建,
   * 预算满了之后的块只登记来源(不规划、不建),玩家换块或地形更新后重排一次。
   */
  let propFocusKey = '';
  let propFocusDirty = true;
  let propRebalanceAtMs = 0;
  const rebalancePropsAround = (fcx: number, fcy: number): void => {
    const all = [...propChunks.values()];
    for (const c of all) removePropsForChunk(c.key);
    const dist = (c: ChunkInput): number => Math.hypot(c.cx - fcx, c.cy - fcy);
    all.sort((a, b) => dist(a) - dist(b) || (a.key < b.key ? -1 : 1));
    for (const c of all) {
      if (propSpriteTotal >= SPRITE_BUDGET) {
        propChunks.set(c.key, c);
        propDroppedByBudget += 1;
        continue;
      }
      buildPropsOf(c);
    }
  };

  /* 首帧:按**设计图占位**登记(图集还没到 ⇒ 只登记,不建 Sprite)。 */
  for (const chunk of chunks) addPropsForChunk(chunk);
  void loadAtlasImage().then((img) => {
    if (img === null) return;
    propAtlasImg = img;
    propAtlasReady = true;
    /* 图集就绪 ⇒ 给**已登记**的块补齐立牌,顺序按 key 升序(**确定性**:
       预算截断的结果只取决于有哪些块,与"谁先到达"无关)。 */
    for (const key of [...propChunks.keys()].sort()) {
      const c = propChunks.get(key);
      if (c !== undefined) buildPropsOf(c);
    }
    refreshNpcSprites();
  });

  /* ══════════ ★ WS-FND-188:NPC 立牌(看得见)+ 说话那两行(能按住) ══════════
   *
   * ## 数据来源唯一
   * `NpcWireDef[]` 由 `main.ts` 从会话的 `onNpcs` 推进来(服务端在 `hello`/`welcome`
   * 之后发**一次**)⇒ 本文件**不**内置任何 NPC 名单:两份名单迟早漂,而漂的表现是
   * 「服务器说有 4 个人,屏幕上 3 个」(那是最难查的一类:两边都不报错)。
   *
   * ## 贴图:临时用 532 稻草人靶
   * 依据与"为什么是临时的"写在 `NPC_SPRITE_ITEM_ID` 的 docblock 里。这里只强调一件事:
   * **没有任何东西**会告诉玩家"这格贴图不对" —— 所以它必须是**一个具名常量 + 一条
   * 会红的判据**(`WS-FND-188` 钉 `atlasCell >= 0`),而不是散在装配层里的字面量。
   */
  /** 服务端下发的 NPC 表(空 = 还没到 / 这个房间没有 NPC)。 */
  let npcList: readonly NpcWireDef[] = [];
  /** id → Sprite(与 `propsByChunk` 同一纪律:表即场景的一份索引)。 */
  const npcSprites = new Map<string, THREE.Sprite>();
  /** 建 / 删的累计数(自检口径:`moves === 0` 而 `npcCount > 0` ⇒ 表到了但没画)。 */
  const npcSpriteOps = { spawns: 0, removes: 0 };
  /** 最近一句台词(HUD 那一行;由 `main.ts` 从动作回执里喂进来)。 */
  let npcTalkLine = '';

  /** 按当前 NPC 表把立牌对齐(缺的建、多的删;**位置/贴图变了就地改**)。 */
  /**
   * 头顶名牌:玩家 / 其他玩家 / NPC 站在一起时分得出谁是谁。
   *
   * 用 DOM 标签而不是精灵子节点:立牌没有旋转,局部 y 轴不是屏幕的「上」,挂子节点会偏;
   * DOM 标签每帧用相机把头顶位置投影到屏幕,字永远是正的、清晰的,也不占 draw call。
   * 头顶 = 立牌位置沿**相机的上方向**抬 `0.85 × 立牌边长`(图集锚点距底 15%)。
   */
  const nameplateLayer = document.createElement('div');
  nameplateLayer.id = 'nameplates';
  nameplateLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:15;';
  container.appendChild(nameplateLayer);
  const nameplates = new Map<string, HTMLDivElement>();
  /** 头顶位置 = 立牌边长 × 本系数(沿相机上方向)。0.85 是整帧顶端;人物只占下半部分,取 0.55。 */
  const NAMEPLATE_HEAD_RATIO = 0.55;
  const npVec = new THREE.Vector3();
  const npUp = new THREE.Vector3();
  const npHead = new THREE.Vector3();
  const NAMEPLATE_STYLE = {
    me: 'color:#fff8ec;background:rgba(62,39,35,.78);border-color:#ffd166;',
    player: 'color:#e8f6ff;background:rgba(30,70,110,.78);border-color:#9bd3ff;',
    npc: 'color:#fff8ec;background:rgba(62,39,35,.78);border-color:#f6d9a8;',
  } as const;
  const nameplateSeen = new Set<string>();
  /** 本帧牌子允许出现的最低屏幕 y(快捷栏上沿);没有快捷栏 ⇒ 屏幕底。 */
  let nameplateBottomLimit = Number.POSITIVE_INFINITY;
  /** 本帧要摆的牌子;摆完统一做一次「防重叠 + 夹进屏幕」。 */
  const nameplateQueue: { el: HTMLDivElement; x: number; y: number; me: boolean }[] = [];
  const placeNameplate = (
    key: string, text: string, kind: keyof typeof NAMEPLATE_STYLE, sp: THREE.Sprite,
  ): void => {
    if (!sp.visible || text === '') return;
    npUp.setFromMatrixColumn(camera.matrixWorld, 1);
    /* 图集帧上下有留白,人物本体只占下半部分:按整帧顶端(0.85)算会让牌子飘在空地里。 */
    npHead.copy(sp.position).addScaledVector(npUp, sp.scale.y * NAMEPLATE_HEAD_RATIO);
    npVec.copy(npHead).project(camera);
    const x = ((npVec.x + 1) / 2) * window.innerWidth;
    const y = ((1 - npVec.y) / 2) * window.innerHeight;
    if (!(x > -80 && x < window.innerWidth + 80 && y > -30 && y < window.innerHeight + 30)) return;
    /* 落在底部快捷栏后面的牌子不画:否则名字被快捷栏盖掉一半,比不画更糟。
       快捷栏的位置取自 DOM 实时读数(它的高度随屏宽变),每帧最多读一次。 */
    if (y > nameplateBottomLimit) return;
    let el = nameplates.get(key);
    if (el === undefined) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;padding:1px 7px;border:1.5px solid;'
        + 'border-radius:9px;font:700 12px/1.35 -apple-system,"Noto Sans SC",sans-serif;'
        + 'white-space:nowrap;will-change:transform;' + NAMEPLATE_STYLE[kind];
      el.textContent = text;
      nameplateLayer.appendChild(el);
      nameplates.set(key, el);
    } else if (el.textContent !== text) {
      el.textContent = text;
    }
    el.style.display = 'block';
    nameplateSeen.add(key);
    nameplateQueue.push({ el, x, y, me: kind === 'me' });
  };
  const updateNameplates = (): void => {
    camera.updateMatrixWorld();
    nameplateSeen.clear();
    nameplateQueue.length = 0;
    const hotbarEl = document.getElementById('gh_hotbar');
    nameplateBottomLimit = hotbarEl === null ? Number.POSITIVE_INFINITY : hotbarEl.getBoundingClientRect().top - 4;
    placeNameplate('me', '你', 'me', playerMarker);
    for (const n of npcList) {
      const sp = npcSprites.get(n.id);
      if (sp !== undefined) placeNameplate(`npc:${n.id}`, n.quest !== undefined ? `❗ ${n.name}` : n.name, 'npc', sp);
    }
    for (const [key, sp] of entitySprites) {
      if (!key.startsWith('player:')) continue;
      const id = key.slice('player:'.length);
      const who = authority.state.players.find((q) => q.id === id);
      const nm = who === undefined || who.name === '' || who.name === who.id ? '旅人' : who.name;
      placeNameplate(key, nm, 'player', sp);
    }
    /* 防重叠 + 夹进屏幕:「你」先摆、位置不动;其余的牌子压到已摆的牌子上就往上错开一格,
       横向夹进屏幕内(靠边的 NPC 不会被切掉半个字)。 */
    nameplateQueue.sort((a, b) => Number(b.me) - Number(a.me));
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    for (const q of nameplateQueue) {
      const w = q.el.offsetWidth || 60;
      const h = q.el.offsetHeight || 18;
      const cx = Math.min(Math.max(q.x, w / 2 + 4), window.innerWidth - w / 2 - 4);
      let y = q.y;
      for (let tries = 0; tries < 8; tries += 1) {
        const hit = placed.some((r) => cx - w / 2 < r.r && cx + w / 2 > r.l && y - h < r.b && y > r.t);
        if (!hit) break;
        y -= h + 2;
      }
      q.el.style.zIndex = q.me ? '2' : '1';
      q.el.style.transform = `translate(${Math.round(cx)}px,${Math.round(y)}px) translate(-50%,-100%)`;
      placed.push({ l: cx - w / 2, r: cx + w / 2, t: y - h, b: y });
    }
    /* 这一帧没摆的(走出屏幕 / 离场 / 隐藏)⇒ 摘掉标签,免得 DOM 越积越多。 */
    for (const [key, el] of nameplates) {
      if (nameplateSeen.has(key)) continue;
      el.remove();
      nameplates.delete(key);
    }
  };

  function refreshNpcSprites(): void {
    const plan = planNpcSprites(npcList, SPRITE_HEIGHT_PX.player ?? 28);
    const seen = new Set<string>();
    for (const p of plan) {
      seen.add(p.id);
      if (p.atlasCell < 0) continue;      /* 图集里没有这一格 ⇒ 跳过,不错位取样 */
      if (!propAtlasReady || propAtlasImg === null) continue;
      const material = propMaterialOf(propAtlasImg, p.atlasCell);
      if (material === null) continue;
      let sp = npcSprites.get(p.id);
      if (sp === undefined) {
        sp = new THREE.Sprite(material);
        /* 与图集立牌/玩家立牌同一锚点约定(距底 15%)—— 否则脚会陷进地里 */
        sp.center.set(SPRITE_CENTER_X, SPRITE_CENTER_Y);
        sp.name = `npc_${p.id}`;
        scene.add(sp);
        npcSprites.set(p.id, sp);
        npcSpriteOps.spawns += 1;
      }
      /* NPC 的坐标是**格**;立牌站在格心(+0.5),z 取那一格的高程(`zAt` 表,
         与玩家/实体立牌同源)⇒ 脚踩在地上,不悬空。 */
      const z = zAt.get(`${Math.floor(p.x)},${Math.floor(p.y)}`) ?? 0;
      sp.position.set(p.x + 0.5, p.y + 0.5, z);
      sp.scale.set(CHARACTER_SIZE_WORLD, CHARACTER_SIZE_WORLD, 1);
      sp.visible = true;
    }
    for (const [id, sp] of npcSprites) {
      if (seen.has(id)) continue;
      scene.remove(sp);
      npcSprites.delete(id);
      npcSpriteOps.removes += 1;
    }
  }

  /** `main.ts` 的端口:NPC 表到了(`session.onNpcs`)。整表替换,不合并。 */
  const setNpcs = (list: readonly NpcWireDef[]): void => {
    npcList = [...list];
    refreshNpcSprites();
  };

  /** `main.ts` 的端口:把一句台词写到 HUD 那一行(`''` = 清掉)。 */
  const showTalk = (text: string): void => { npcTalkLine = text; };
  const buildMs = performance.now() - t0;

  /* ── 图集立牌(决策 A:保持 TILE_PX=16,装配层缩放 64px 图集)──
   *
   * ## 为什么用 fetch 加载而不是静态 import 那条 PNG
   *
   * 两道门禁都不接受 PNG 形式的相对说明符:
   *   · `scripts/verify.ts` 的 import-no-ext 只放行 `.ts` / `.json` 后缀;
   *   · `tests/WS-09.test.ts` 的「分层不变量」会把每条相对说明符 `resolve`
   *     一遍再 `existsSync` —— PNG 不在它认的后缀里。
   *
   * 也就是说 `import atlas from './atlas_sprites.png'` 这种写法会被判红。
   *
   * 所以图集走**运行时 fetch**:`ATLAS_URL` 是普通字符串常量(不是 import 说明符),
   * 既绕开门禁,也让构建产物与源资源解耦(图集二进制不进 git,见 `.gitignore` 的 `_design/`)。
   *
   * ## 为什么本注释可以直接写出示例形态
   *
   * 上面那行 `import ... './atlas_sprites.png'` 是**故意**留在注释里的 ——
   * 它同时充当一个活样本:WS-09 的分层门禁对源码做正则扫描时**会先剥离注释**
   * (`stripComments()`),所以注释里的示例不会被误判成真实 import。
   *
   * 这一点是修出来的,不是天生如此 —— 原先该门禁不剥注释,导致本注释里
   * 一句说明性的示例把 WS-09 打成 83/84。当时的临时对策是把示例形态删掉,
   * 但那等于**为了迁就工具而把文档写含糊**,是本末倒置。
   * 正确做法是把扫描做精确:注释里的东西不是代码。
   * 若哪天这句又被扫红,说明 `stripComments` 失效了 —— 那是门禁的 bug,不是本注释的。
   *
   * ## 为什么是「一张 Image + 每精灵一份 Texture 包装」而不是每帧一张 Texture
   *
   * 图集是单文件 1280×1152。
   * ⚠ `offset`/`repeat` 存在 `Texture` 上而**不在** `SpriteMaterial` 上,
   * 所以多个精灵共享同一 `Texture` 时不能各改 offset —— 会互相覆盖。
   * 因此每个精灵各持一份 `Texture` 包装,但**底层 Image 只加载一次**,
   * three 按 image 缓存上传,不会重复占显存。
   *
   * ## 锚点方向 —— 本块最容易静默出错的地方
   *
   * 图集 JSON 的 `anchor = (0.5, 0.85)` **从顶部**度量(TexturePacker 习惯);
   * three 的 `Sprite.center` **从底部**度量(官方文档:`(0,0)` = lower left)。
   * ⇒ `center.set(0.5, 1 - 0.85)` 即 `(0.5, 0.15)`。
   *
   * 照抄 0.85 会让立牌整体下沉 `0.70 × 精灵高`
   * = `0.70 × 64 / 41 ≈ 1.09` 世界单位,脚陷进地里 ——
   * 而且**不抛异常、不报门禁**,只能靠眼睛发现。
   *
   * ## 为什么 position 直接放格点就够
   *
   * three 的 sprite 顶点计算把 `center` 那个点对齐到 `position`,
   * 所以 `position = (gx, gy, gz)` 时锚点必然落在地形格上,不需要按高度补偿。
   * 地形顶点同样是 `x = cellX, y = cellY` 的恒等映射(见 `stage/chunk_geometry.ts`),
   * 两者过同一相机 ⇒ **必然重合**。
   *
   * ## 缩放
   *
   * `SPRITE_CELL_WORLD = ATLAS_CELL / ATLAS_PX_PER_CELL = 64 / 41 ≈ 1.561`(**世界单位**)。
   * ⚠ 不要用 `SPRITE_SCALE = 16/41 ≈ 0.3902` 去乘 `ATLAS_CELL` ——
   * 那是「图素→屏幕像素」比,乘出来 24.98 会被 three 当成 24.98 **世界单位**,
   * 精灵放大 16 倍盖住半张地图(实测踩过)。
   */
  const sprites: THREE.Sprite[] = [];
  /** 图集样本 ID:语义明确、且**故意跨过分段**(101 首段、111 首段尾、152 第二段、304 第五段) */
  const ATLAS_SAMPLE_IDS = [101, 111, 152, 304];
  /**
   * 立牌落格 —— **运行时按地形实测高程挑**,而不是写死坐标。
   *
   * 为什么要挑:演示地形有 `-1..2` 的起伏,写死 `z` 会让精灵一半悬空、一半埋进土里。
   * 所以先从地形算出 `gx,gy → z` 表,再找一行**同高程**的平地,让所有立牌站齐。
   *
   * 这条路径同时是「脚底对齐」的证据之一:精灵的 `z` 与地形面的 `z`
   * 取自**同一份**数据,不是手调出来的。
   *
   * 间距按 4 → 3 → 2 格降级试:4 格在屏幕上是 45px,而立牌宽约 25px,
   * 正好互不遮挡;实在找不到平地再退到更密的排布。
   *
   * **还要避开遮挡**:立牌默认 `depthTest = true`(这是对的,否则会穿墙),
   * 所以如果它前面的地形更高,就会被埋掉。实测第一版落在 z=-1 的洼地里,
   * 四个立牌总共只有 721 个差异像素 —— 大部分被前排的台地挡住了。
   *
   * 遮挡来自「朝相机那一侧」。由 `projectGridToScreen` 的
   * `uy = (dx + dy)·GROUND_Y_PER_CELL − dz·Z_Y_PER_LEVEL` 可知:
   * 屏幕 y 增大 = 靠近相机 = 格坐标 `(gx + t, gy + t)` 方向。
   * 故判据是:沿 `(+t, +t)` 前方 6 格之内,不得有比立牌更高的地形。
   */
  const zAt = new Map<string, number>();
  for (const chunk of chunks) {
    for (let by = 0; by < CHUNK_SIZE; by += 1) {
      for (let bx = 0; bx < CHUNK_SIZE; bx += 1) {
        const v = (chunk.tiles as Uint32Array)[by * CHUNK_SIZE + bx]!;
        const f = unpackTile(v);
        zAt.set(`${chunk.cx * CHUNK_SIZE + bx},${chunk.cy * CHUNK_SIZE + by}`, ELEV_TO_Z[f.elev] ?? 0);
      }
    }
  }
  const placements: { gx: number; gy: number; gz: number }[] = [];
  {
    const mid = Math.floor(WORLD_CELLS / 2);

    /**
     * 立牌会不会被前方地形挡住。
     *
     * 判据来自投影式 `ux = (dx−dy)·cos45`、`uy = (dx+dy)·G − dz·Z`:
     * 屏幕 **y 越大越靠近相机** ⇒ 遮挡者必须满足 `dx + dy ≥ 1`,
     * 且屏幕上要横向重叠 ⇒ `|dx − dy|` 不能太大。
     *
     * 距离只取 1~2 格:一层落差在屏幕上只遮 `cos35 · 16 ≈ 13.1px`,
     * 而立牌总高才 25px;更远的高地在屏幕上早已错开。
     * (第一版用 8×8 全域邻域,判据过严,落点被一路推到 `gy=61.5` 贴边。)
     */
    const occluded = (gx: number, gy: number, z0: number): boolean => {
      for (let t = 1; t <= 2; t += 1) {
        for (let d = -1; d <= 1; d += 1) {
          const z = zAt.get(`${gx + t + d},${gy + t - d}`);
          if (z !== undefined && z > z0) return true;
        }
      }
      return false;
    };

    /**
     * 选点:**在满足约束的候选里挑离世界中心最近的**,而不是「第一个匹配就收」。
     *
     * 「第一个匹配就收」会带来一个隐蔽后果:遍历顺序决定落点,
     * 结果立牌可能出现在地图最边上(实测 `gy=61.5`,视野边缘),
     * 而这在代码里看不出任何错误 —— 只是拍出来不好看。
     */
    let best: { step: number; x0: number; gy: number; z: number; cost: number } | null = null;
    for (const step of [4, 3, 2]) {
      for (let gy = 0; gy < WORLD_CELLS; gy += 1) {
        for (let x0 = 0; x0 + (ATLAS_SAMPLE_IDS.length - 1) * step < WORLD_CELLS; x0 += 1) {
          const z0 = zAt.get(`${x0},${gy}`);
          if (z0 === undefined) continue;
          const flat = ATLAS_SAMPLE_IDS.every((_, k) => zAt.get(`${x0 + k * step},${gy}`) === z0);
          if (!flat) continue;
          if (ATLAS_SAMPLE_IDS.some((_, k) => occluded(x0 + k * step, gy, z0))) continue;
          /* 代价:整排的中心离世界中心多远;间距越大越优先(少重叠) */
          const cx = x0 + ((ATLAS_SAMPLE_IDS.length - 1) * step) / 2;
          const cost = Math.hypot(cx - mid, gy - mid) - step * 2;
          if (best === null || cost < best.cost) best = { step, x0, gy, z: z0, cost };
        }
      }
      if (best !== null) break; /* 4 格能找到就不必试更密的 */
    }

    if (best !== null) {
      for (let k = 0; k < ATLAS_SAMPLE_IDS.length; k += 1) {
        /* 格心 = 格索引 + 0.5:顶面覆盖 [gx, gx+1] × [gy, gy+1],
           格心才是这块地砖的几何中心,站这里才居中。 */
        placements.push({ gx: best.x0 + k * best.step + 0.5, gy: best.gy + 0.5, gz: best.z });
      }
    }
    /* 兜底:找不到任何平地也要摆出东西,否则立牌会整体消失 */
    while (placements.length < ATLAS_SAMPLE_IDS.length) {
      placements.push({ gx: mid + 0.5, gy: mid + 0.5, gz: 0 });
    }
  }

  /** 图集是否已就绪 —— 供 `summary()` 报告,截图脚本据此判断「看到的是真图不是占位」 */
  let atlasOk = false;
  let atlasErr = '';

  void loadAtlasImage().then((img) => {
    if (img === null) {
      atlasErr = '图集加载失败(浏览器拿不到 atlas_sprites.png)';
      return;
    }
    ATLAS_SAMPLE_IDS.forEach((id, i) => {
      /* ⚠ 关键:ID → 下标必须查号段表。写成 `id - 101` 会错位
         (id_303 真实下标 105,而 303-101=202,差 97 格)。 */
      const cell = cellIndexFromId(id);
      if (cell < 0) return; /* 不在图集内:跳过,绝不错位取样 */
      const { offsetU, offsetV, repeatU, repeatV } = offsetRepeatOfCell(cell);
      const tex = new THREE.Texture(img);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.offset.set(offsetU, offsetV);
      tex.repeat.set(repeatU, repeatV);
      tex.needsUpdate = true;

      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      const place = placements[i]!;
      /* z 直接用**地形那一格的高程**,不是估的 —— 所以脚必然踩在面上 */
      sp.position.set(place.gx, place.gy, place.gz);
      /* 一格宽 × 一格高 —— ⚠ 用**世界单位**常量 `SPRITE_CELL_WORLD`(≈1.561),
         不能用 `SPRITE_SCALE`(0.3902):后者是「图素→屏幕像素」比,
         乘上 ATLAS_CELL 会得到 24.98,被 three 当成 24.98 **世界单位** = 放大 16 倍。
         实测过:那样精灵会盖住半张地图。 */
      sp.scale.set(SPRITE_CELL_WORLD, SPRITE_CELL_WORLD, 1);
      /* ⚠ 锚点:JSON 从**顶部**量 0.85,three 从**底部**量 ⇒ 1 - 0.85 = 0.15 */
      sp.center.set(SPRITE_CENTER_X, SPRITE_CENTER_Y);
      sp.name = `atlas_${id}`;
      scene.add(sp);
      sprites.push(sp);
    });
    atlasOk = sprites.length > 0;
  });

  /* ══════════════ task-83:玩家可见物(playermarker) ══════════════
   *
   * ## 为什么要有它
   *
   * 接线前客户端**完全不画玩家**:本文件里 `players` 出现 **0 次**(
   * `git grep -c players client/src/three/boot.ts` ⇒ 空).
   * 玩家位置早就拿到了(`telegraphCenterOf` → `playerGx/playerGy`,task-67 S2),
   * 但只喂给了「屋顶淡出」与「预警圈圆心」—— **没有一个是看得见的实体**.
   *
   * ## 形态:照现有立牌写法(不新造一套)
   *
   * `boot.ts:376` 那处的图集立牌是现成范本,并且已经解决了两件容易写错的事:
   *   1. 缩放用**世界单位**常量,不是 `SPRITE_SCALE`(用错会放大 16 倍盖住地图);
   *   2. 锚点 `center.y` 要 0.15 不是 0.85(写反会让立牌整体陷进地里).
   * ⇒ 这里沿用同一组常量,不自己算第二份口径.
   *
   * ## 自己玩家 vs 别人
   *
   * 本任务只画**本地玩家**(与服务端下发的 `localPlayerId` 对齐),
   * 因为验收内容是「快照动了 ⇒ 屏幕上的东西动了」,一个 marker 就够证明.
   * ⚠️ **不**做「随便挑一个玩家画上去」—— `telegraph_center.ts:50-52` 记着
   *    那条教训:悄悄挑 `players[0]` 会在多人房里把圆心钉到别人头上,且不报错.
   */
  const playerMarker = new THREE.Sprite(new THREE.SpriteMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
  }));
  playerMarker.name = PLAYER_MARKER_NAME;
  {
    const s = playerMarkerScale(SPRITE_CELL_WORLD);
    playerMarker.scale.set(s.x, s.y, 1);
  }
  /* 与图集立牌同一锚点约定(距底 15%)—— 否则脚会陷进地里或浮空 */
  playerMarker.center.set(SPRITE_CENTER_X, SPRITE_CENTER_Y);
  /* 初始不可见:权威第一帧还没到. `telegraphCenterOf` 的 `null` 语义是
     「不知道」,不是「位置是 (0,0)」—— 见 `stage/assembly_math.ts` 的说明. */
  playerMarker.visible = false;
  scene.add(playerMarker);

  /* ══════════════ ★ 第七轮审计 P1:野生 / 远端玩家的可见实体 ══════════════
   *
   * ## 修的是什么
   * 修前屏幕上与实体有关的只有**两样**:本地玩家的 `playerMarker`(上面)与 4 个固定图集立牌。
   * `RoomState.wildlife` 与"别的玩家"在 `client/src` 里**没有渲染出口** ⇒
   * 服务端下发三只怪、来了个队友,屏幕上一个新东西都没有,而任何断言都不会红。
   *
   * ## 谁决定画什么
   * `stage/entity_sprites.planEntitySprites(state, localPlayerId)` —— 纯函数、可被 node 断言
   * (`wildlife` 与远端玩家分开计数,本地玩家**不在**计划里:它已经有 player_marker)。
   * 本文件只做三件事:缺的建、有的挪、多的删(见 `reconcileEntitySprites`)。
   *
   * ## 为什么复用 `playerMarkerPlacement`
   * 立牌的落点规则(格心 +0.5、脚踩地形高程、锚点 0.15)已经被实测校准过一次
   * (WS-09 的脚底对齐判据)。这里**再算一份**就会得到两套口径,
   * 而两套口径的偏差只会在像素上看出来。
   */
  const entitySprites = new Map<string, THREE.Sprite>();
  /** 建/挪/删的累计计数(自检口径:实体渲染到底有没有在跑) */
  const entitySpriteOps = { spawns: 0, moves: 0, removes: 0 };
  /**
   * 本帧的计划摘要(由 `reconcileEntitySprites` 写、`summary` 读)。
   * ★ WS-FND-137 P2:字段**就地改写**而不是每帧新建一个对象(它只是三个计数)。
   */
  const entityPlan = { wildlife: 0, players: 0, total: 0 };
  /**
   * ★ WS-FND-137 P2:计划缓冲 + 「本帧已见键」集合,**每帧复用**。
   *
   * 修前每帧:`planEntitySprites` 新建数组 + N 个 spec 对象(当帧读完即丢)、
   * `new Set()` 新建键集合、`[...entitySprites]` 把整张 Map **全量拷一份**。
   * ⇒ 现在:计划写进 `spritePlan`(元素对象按槽位复用)、`spriteSeen` 用 `clear()`
   * 复用、删除段直接迭代 Map 本身(见下)。
   */
  const spritePlan: EntitySpriteSpec[] = [];
  const spriteSeen = new Set<string>();

  /**
   * ★ WS-FND-137 P2:实体计划的**复用槽包装**(每帧一份计划写进 `spritePlan`)。
   *
   * ⚠️ 为什么要保留这个**两参数别名**,而不是在调用点直接写 `planEntitySpritesInto`:
   * `tests/WS-FND-126` 的 FND126-7 是一条**注入验证**探针,它用字面量
   * `planEntitySprites(authority.state, authority.localPlayerId)` 钉住
   * 「boot.ts 真的在消费这份计划」。把调用点改写成 `...Into(spritePlan, ...)`
   * 会让那条探针转假 —— 而为了让探针变绿去改探针,正是本仓反复点名的
   * 「把判据改成恒真」。⇒ 保留原调用形状,复用缓冲由这一层兜住。
   */
  const planEntitySprites = (state: EntitySpriteSource, localPlayerId: string): EntitySpriteSpec[] =>
    planEntitySpritesInto(spritePlan, state, localPlayerId);

  const reconcileEntitySprites = (): void => {
    const specs = planEntitySprites(authority.state, authority.localPlayerId);
    spriteSeen.clear();
    for (const spec of specs) {
      spriteSeen.add(spec.key);
      const base = playerMarkerPlacement({ cx: spec.cx, cy: spec.cy }, zAt);
      const mount = placementForHeight({ x: base.gx, y: base.gy, z: spec.z }, base.gz);
      let sp = entitySprites.get(spec.key);
      if (sp === undefined) {
        sp = new THREE.Sprite(new THREE.SpriteMaterial({
          color: new THREE.Color(spec.colorHex),
          transparent: true,
          opacity: 0.9,
          depthTest: true,
        }));
        sp.name = spec.key;
        /* 与图集立牌/玩家立牌同一锚点约定(距底 15%)—— 否则脚会陷进地里 */
        sp.center.set(SPRITE_CENTER_X, SPRITE_CENTER_Y);
        const scale = playerMarkerScale(SPRITE_CELL_WORLD);
        sp.scale.set(scale.x, scale.y, 1);
        sp.userData.kind = spec.kind;
        sp.userData.label = spec.label;
        scene.add(sp);
        entitySprites.set(spec.key, sp);
        entitySpriteOps.spawns += 1;
      }
      /* 图集到了之后把色块换成真正的形象(只换一次;未知物种保持色块)。 */
      if (sp.userData.skinned !== true && propAtlasReady && propAtlasImg !== null) {
        const skin = propMaterialOf(propAtlasImg, cellIndexFromId(entityAtlasId(spec.kind, spec.label, spec.entityId)));
        if (skin !== null) {
          sp.material.dispose();
          sp.material = skin;
          const size = spec.kind === 'player' ? CHARACTER_SIZE_WORLD : MOB_SIZE_WORLD;
          sp.scale.set(size, size, 1);
        }
        sp.userData.skinned = true;
      }
      sp.position.set(mount.sprite.x, mount.sprite.y, mount.sprite.z);
      sp.visible = base.visible;
      entitySpriteOps.moves += 1;
    }
    /* 快照里没有的 ⇒ 必须真的从场景里删掉,否则退房/死亡会留下幽灵。
       ★ WS-FND-137 P2:直接迭代 `entitySprites` 本身,不再 `[...entitySprites]`
       每帧整表拷一份 —— Map 迭代器按插入顺序推进,删除**已访问的当前条目**
       不影响后续推进(删的是本帧该删的键,不会再被访问到)。 */
    for (const [key, sp] of entitySprites) {
      if (spriteSeen.has(key)) continue;
      scene.remove(sp);
      entitySprites.delete(key);
      entitySpriteOps.removes += 1;
    }
    /* ★ WS-FND-137 P2:三类**一遍**数完(修前同一批 specs 扫了 3 遍)。 */
    const counts = countByKinds(specs);
    entityPlan.wildlife = counts.mob + counts.pet;
    entityPlan.players = counts.player;
    entityPlan.total = specs.length;
  };

  /**
   * 自检钩子:切换立牌可见性。
   *
   * 供截图/对齐脚本做**差分测量** —— 关掉立牌再拍一张,两张图相减,
   * 差集就是精灵占据的像素,**不依赖任何颜色阈值**。
   *
   * 为什么必须这样:先前用「绿通道判地形、其余判精灵」的分类器测过一次,
   * 结果深色地形侧面被误判成精灵,四个立牌的 Δ 一律是 18px ——
   * 一个看起来像结论、其实是分类器缺陷的假信号。
   *
   * 挂在 `window` 上而不是塞进 `summary()`:`summary()` 是只读快照,
   * 混进一个会改场景状态的函数会让它名不副实。
   */
  (window as unknown as { __spriteDebug?: unknown }).__spriteDebug = {
    count: () => sprites.length,
    setVisible: (v: boolean): number => {
      for (const s of sprites) s.visible = v;
      return sprites.length;
    },
    /** 只让第 `i` 个可见 —— 逐个测量用,避免多个立牌的像素簇互相粘在一起 */
    only: (i: number): string | null => {
      sprites.forEach((s, k) => { s.visible = k === i; });
      return sprites[i]?.name ?? null;
    },
    ids: () => ATLAS_SAMPLE_IDS.slice(),
    /* task-83:玩家立牌的开关与读数 —— 供**截图差分**用(关掉再拍一张,两张相减,
     * 差集就是玩家占的像素,不依赖颜色阈值).
     *
     * ⚠️ 刻意**不**并进 `setVisible`/`only`:那两个只遍历 `sprites`(图集立牌),
     *    把玩家立牌混进去会让「逐个测量第 i 个立牌」的下标错位.
     */
    playerMarker: () => ({
      name: playerMarker.name,
      visible: playerMarker.visible,
      x: playerMarker.position.x,
      y: playerMarker.position.y,
      z: playerMarker.position.z,
    }),
    setPlayerMarkerVisible: (v: boolean): boolean => {
      playerMarker.visible = v;
      return playerMarker.visible;
    },
  };

  /**
   * 自检钩子:暴露 scene 与 camera,**只读**。
   *
   * 供探针读回 three 侧的真实几何(顶点范围、matrixWorld、project 结果),
   * 用来和差分像素实测值对照 —— 避免我拿手算的公式去解释像素。
   * (实测踩过:手算比实测差 ~25px,推算不可信,必须读数。)
   *
   * 与 `__spriteDebug` 分开两个名字:一个**会改状态**(切换可见性),
   * 一个**只读**。混在一起容易误用。
   */
  (window as unknown as { __sceneDebug?: unknown }).__sceneDebug = scene;
  (window as unknown as { __camDebug?: unknown }).__camDebug = camera;

  /* ── HUD ── */
  const hud = makeHud(container, { cells: worldCells, chunks: chunks.length });

  /**
   * 当前已建 mesh 覆盖的世界边长(格)—— 取所有块里最右 / 最下那条边。
   *
   * ★ 为什么不复用上面的 `worldCells`:那个数是**设计图**的规模,而服务器的块范围
   *   不保证与设计图相等(服务器世界会变)⇒ HUD 那行必须按**现在屏幕上**的块算,
   *   否则又变成 w85 那次的「标签与实际不符」。
   */
  const terrainCellsNow = (): number => {
    let max = 0;
    for (const st of terrainStats.values()) {
      max = Math.max(max, (st.cx + 1) * CHUNK_SIZE, (st.cy + 1) * CHUNK_SIZE);
    }
    return max;
  };

  /**
   * ★ WS-FND-184:把**服务器下行的地形**铺到屏幕上(`main.ts` 在收到地形帧时调用)。
   *
   * ## 三件事,顺序不能换
   * ```text
   * 1 计划由纯函数算(`planTerrainRebuild`)—— 判定可单测,装配层不自己发明规则;
   * 2 每块**先摘旧的(含 dispose)再建新的**(漏 dispose = 显存泄漏,且不报错);
   * 3 重建完把顶点 / 面数 / 规模同步给 HUD 与 `summary()`(否则屏幕上那行数字是假的)。
   * ```
   *
   * @param next      服务器已落地的全部块(`ClientChunkStore.chunks()`,稳定序)
   * @param dirtyKeys 还没被消费的脏 key(`ClientChunkStore.dirty()`)
   *                  —— ⚠️ 调用方必须在**重建之后** `clearDirty()`,否则每帧重建同一批。
   */
  const applyTerrainChunks = (
    next: readonly ChunkInput[],
    dirtyKeys: readonly string[],
  ): { rebuilt: number; total: number; full: boolean; fallback: boolean } => {
    terrainApplyCalls += 1;
    const plan = planTerrainRebuild(next, dirtyKeys, terrainFromServer);
    if (plan.fallback) {
      /* ★ 回落**必须留痕**:静默回落会让「服务器地形没到」与「设计图本来长这样」完全同形。 */
      if (!designFallbackWarned) {
        designFallbackWarned = true;
        console.warn('[terrain] 一帧服务器地形都没有 ⇒ 屏幕上仍是**设计图占位**'
          + '(不是服务器世界:玩家改过的地形看不到)');
      }
      hud.setWorld(worldCells, meshes.size, TERRAIN_SOURCE_DESIGN);
      return { rebuilt: 0, total: meshes.size, full: false, fallback: true };
    }
    /* ── ★ WS-FND-188:立牌**跟着同一批块走**(计划由 `planPropApply` 算)──
     *
     * 复用 `plan.rebuild`(而不是自己再算一次"哪些块脏了"):那就是**第二份口径**,
     * 两份迟早漂,而漂的表现是"地形换了一半、立牌换了一片"(画面看着像随机,不报错)。
     * 每次**先摘后建**:拆掉墙之后同块的立牌列表会变,只加会留下幽灵立牌。 */
    /* 先置「地形来自服务器」,再重建立牌:`buildPropsOf` 据此决定要不要撒装饰植被,
       放在后面的话第一批服务器地形落地时还会撒一次假植被。 */
    if (next.length > 0) terrainFromServer = true;
    const propPlan = planPropApply([...propChunks.keys()], plan.rebuild);
    for (const key of propPlan.remove) removePropsForChunk(key);
    for (const chunk of propPlan.add) addPropsForChunk(chunk);
    propFocusDirty = true;   /* 块变了 ⇒ 预算分配要按玩家位置重排(主循环里节流执行) */
    for (const chunk of plan.rebuild) {
      removeTerrainMesh(chunk.key);   /* 先摘旧的(含 dispose) */
      addTerrainMesh(chunk);          /* 再建新的 */
    }
    if (next.length > 0) terrainFromServer = true;
    terrainRebuiltChunks += plan.rebuild.length;
    hud.setWorld(terrainCellsNow(), meshes.size, TERRAIN_SOURCE_SERVER);
    /* 相机跟随的边界跟着服务器地形的真实范围走:`CAMERA_BOUNDS` 启动时按本地设计图(192)
       建,而服务器世界可以更大(主世界 512)⇒ 不更新就会把相机夹在 192-8,
       玩家在镇里时画面停在镇子西北的野地上空。 */
    {
      const cells = terrainCellsNow();
      if (cells > 0) { CAMERA_BOUNDS.maxX = cells; CAMERA_BOUNDS.maxY = cells; }
    }
    return { rebuilt: plan.rebuild.length, total: meshes.size, full: plan.full, fallback: false };
  };

  /**
   * `#hint`(页面底部那行提示)的**读点**。
   *
   * ★ 第六轮审计 P3:这个元素在 `client/index.html:49` 里写死了一段文案,
   *   而 `client/src` 里 `getElementById('hint')` 命中 **0** ⇒ 它永远不更新,
   *   文案里也没有缩放/搜索这两个**存在但没人知道**的键位。
   *   现在它由 `paintHint()` 每帧按真实状态刷新(缩放档位、搜索串、拖拽成交、
   *   派对/比分),并且**只在文本变化时**写 `textContent`(避免每帧触发重排)。
   */
  const hintEl = document.getElementById('hint');
  let lastHint = '';
  const paintHint = (): void => {
    if (hintEl === null) return;
    const parts: string[] = [];
    const bv = bossView();
    if (bv !== null) {
      parts.push(`Boss ${bv.name} ${Math.round(bv.hp)}/${Math.round(bv.baseHp)}`
        + (bv.phaseName === '' ? '' : ` [${bv.phaseName}]`));
    }
    const party = partyHudOf(authority.state.meta);
    if (party.active) parts.push(party.text);
    /* ★ WS-FND-151:急行开工条件(三项三态)与模式面板的那一行 —— 都在 `#hint` 里
       如实报;未知就写"未知",不省略(省略会与"没这一条"同形)。 */
    parts.push(rushReadinessOf(rushAuthorityInput(), RUSH_SNAPSHOT_GAP).text);
    if (uiFsm.activePanel === UiPanel.PARTY) {
      parts.push(partyPanelOf(authority.state.meta, partyCursor).hint);
    }
    parts.push(`缩放 ${isoCam.zoom}×([ / ])`);
    if (searchMode) parts.push(`搜索 "${invQuery}"(Enter 收下 / Esc 清空)`);
    if (lastMove !== '') parts.push(`拖拽 ${lastMove}`);
    /* ── ★ WS-FND-188:NPC 那两行 ──
       「附近有没有人 / 按哪个键」与「最近那一句台词」都是**玩家要读的**东西。
       判定在纯函数里(`nearbyNpc` / `npcHintLine`),这里只按结果追加 ——
       写在这里(而不是事件回调里)的理由与 `#hint` 其它行相同:它是**状态的函数**,
       散进回调后必然有一条路径忘记刷新(那一行就会永远停在上一句话上)。
       ⚠️ 位置用**权威** `playerGx/playerGy`(与 `main.ts` 的按键判定同一个来源):
       两边若各用一个位置,会出现"提示写着能说话、按下去被拒"。 */
    const near = nearbyNpc(npcList, playerGx, playerGy);
    const npcLine = npcHintLine(near);
    if (npcLine !== '') parts.push(npcLine);
    if (npcTalkLine !== '') parts.push(npcTalkLine);
    parts.push('I 背包 · / 搜索 · 拖拽整理背包 · WASD 移动 · 单指拖动视角');
    const text = parts.join(' · ');
    if (text === lastHint) return;
    lastHint = text;
    hintEl.textContent = text;
  };

  /* ══════════════════ UI 运行时:8 个模块的接入点 ══════════════════
   *
   * 这一块是本轮改动的核心。此前这 8 个模块**有实现、有测试、零 DOM 依赖,
   * 但浏览器从不加载** —— 约 2500 行代码玩家一点都看不到,
   * 与「八步伤害公式写了但生产不走」是同一缺陷形态。
   *
   * 每个模块在这里都**被真的调用**,不是只 import:
   * 见下方每个 `── xxx ──` 注释标注的具体调用点。
   */

  /* ── state_machine:面板开关的唯一真相源 ──
   * 调用点:`uiFsm.open()` / `tick()` / `transition()`,见 `setPanel()` 与主循环 */
  const uiFsm = new UiStateMachine();

  /* ── inventory:背包视图 ──
   * 调用点:`refreshInventory()` → `buildView()`,每帧被 `UiDrawState.view` 消费。
   *
   * ★ 第六轮审计 P3:`invQuery` 此前**恒为 `''`** —— `buildView({query})` 与
   *   `inventory.matchesQuery()` 都实现了搜索,但**没有任何键能写它** ⇒
   *   "搜索不可达"(功能在、入口不在)。现在 `/` 进入搜索态,后续可打印字符
   *   追加进 `invQuery`(Backspace 退格、Enter/Escape 退出),见 `onKeyDown`。 */
  let invQuery = '';
  /** 是否处于搜索输入态(`/` 进入,Enter/Escape 退出)—— 只有在它里面才吃字符键 */
  let searchMode = false;
  let invCategory: string | null = null;
  let invPage = 0;
  /**
   * ★ 第七轮审计 P1:背包的**格位状态**(下标 = 格位,值 = 物品 id)。
   *
   * 修前 `buildView()` 每帧从静态 `ITEM_LIST` 重建 ⇒ 格子内容与玩家操作无关,
   * 于是拖拽成交只改了 `lastMove` 那一行提示,**格子一件都没动**。
   * 现在搬运(`applySlotMove`)写的是这份状态,`buildView({ slotItemIds })` 读它。
   */
  let slotItemIds: number[] = defaultSlotItemIds();
  /** 真的成交过几次(自检口径;`lastMove` 只是最近那一条文案) */
  let slotMoveCount = 0;
  let invView: InventoryView = buildView({ page: 0, slotItemIds });
  const refreshInventory = (): void => {
    invView = buildView({
      page: invPage,
      category: invCategory,
      query: invQuery,
      sort: SortKey.SLOT,
      slotItemIds,
    });
  };
  refreshInventory();

  /* ── recipe_tree:配方树 ──
   * 调用点:`refreshRecipe()` → `buildRecipeTree()` + `checkCraft()` + `missingReport()` */
  let recipeTree: RecipeTree | null = null;
  const RECIPE_ID = 351; /* 暖红陶瓦斜屋顶:叶子里程碑,单料单台 */
  const RECIPE_BATCHES = 4;
  let recipeNote = '';
  const RECIPE_STOCK = new Map<number, number>([[101, 8], [102, 4], [103, 2]]);
  const refreshRecipe = (): void => {
    recipeTree = buildRecipeTree(RECIPE_ID, RECIPE_BATCHES);
    const check = checkCraft(recipeTree, RECIPE_STOCK);
    recipeNote = check.craftable ? '' : missingReport(check);
  };
  refreshRecipe();

  /* ── pixel_easel:16×16 画架 ──
   * 调用点:指针命中 `easel` → `easel.paint()`;`Z/Y/X` 键 → `undo()/redo()/clear()` */
  const easel = new PixelEasel();
  let paletteIndex = 3;
  /* 画一个可辨认的起点图案(不是空白),否则截图里看不出画架在工作 */
  for (let i = 0; i < 16; i += 1) {
    easel.paint(i, 0, 3);
    easel.paint(0, i, 5);
    easel.paint(15, i, 7);
    easel.paint(i, 15, 9);
  }
  easel.paint(7, 7, 12);
  easel.paint(8, 8, 12);
  easel.paint(7, 8, 20);
  easel.paint(8, 7, 20);

  /* ── audio:可听见的调用 ──
   * 调用点:`audioOut.uiClick()`(面板开关/格子点击)、`audioOut.noteOn()`(音高砖) */
  const audioOut: AudioHandle = createAudio();
  /** UI 音效总开关:headless 截图时也能安全调用(未唤醒则静默丢弃) */
  const clickSound = (): number => audioOut.uiClick(24);

  /* ── boss_hud:血条 + 地面预警圈 ──
   * 调用点:`bossHudFrom()` 在 `bossView()`(每帧一次,读**权威** `RoomState.bosses`);
   *        `layoutHpBar()` 在 `ui_binding.drawBoss()`;`buildTelegraph()` 在 `telegraphGeometry()`。
   *
   * ★ 第六轮审计 P1:接线前这里有两个**本地伪造**:
   *   1 `bossHp = Math.max(baseHp*0.18, bossHp - dt/1000*baseHp*0.035)` —— 血条自己
   *     慢慢往下走,与服务端 boss 的真实血量**毫无关系**;
   *   2 `RoomState.bosses` 在 `client/src` 里的读者数是 0 ⇒ 服务端掉血/进阶段/换预警
   *     几何,屏幕上完全一样。两个都不报错。
   *   ⇒ 现在血条/阶段/预警几何的唯一来源是快照(`bossHudFrom`),`bossActive` 只剩
   *     「B 键召唤 demo boss」这一个用途(**没有**权威 boss 时才用它撑起一张演示血条)。
   */
  const demoBoss = BOSS_LIST[0] ?? null;
  /** 残影条的**比例**(由权威 ratio 指数回落而来,见主循环的 `decayGhost`) */
  let bossGhost = 1;
  /** demo 用的「Boss 是否在场」开关(仅当快照里没有 boss 时生效) */
  let bossActive = false;

  /* ── ★ WS-FND-151:派对**模式选择面板**的状态 ──

     `partyCursor`  键盘光标(0 起,行下标;`j`/`l` 移动)
     `partyModeNote` **入口回的那一句话**(成功 / 被拒 / 未连接都由
                     `net/action_entry` 给,本文件不自己编词)
     `partyModeSink` 发报文的端口,由 `main.ts` 注入(它才是装配根)

     ⚠️ 面板的**内容**不在这里拼:`partyPanelOf(meta, cursor)` 每帧现算
     (`ui/party_panel.ts`),名字与规则来自冻结层 `PARTY_MODES` ——
     本文件只保存"光标停在哪"与"上一次选的结果"。 */
  let partyCursor = 0;
  let partyModeNote = '';
  let partyModeSink: ((mode: number, key: string) => string) | null = null;

  /**
   * 急行开工三条件的**权威输入**。
   *
   * ⚠️ 今天**三项都只能给 `null`**(= 未知):线快照 `RoomState` 只有
   * `meta / players / wildlife / bosses`,**没有 rooms、没有器件格**
   * (`shared/types/wire.ts`)。世界侧那三条判定在
   * `server/src/sim/world_sim.ts::stepRushEntry` 里,客户端拿不到。
   * ⇒ 如实报 `?`(未知),**不假装 0**:假装 0 会让玩家反复去拆/重建一个
   * 其实早就满足的条件。字段一上线,这里换成真值即可(判据盯着这一处)。
   */
  const rushAuthorityInput = (): RushReadinessInput => ({
    canteen: null,
    stations: null,
    actorAtStation: null,
  });

  /** 选中某一档 → 经注入的端口发报文(单机时如实拒绝)。 */
  const selectPartyMode = (mode: number): void => {
    const opt = partyModeOptionAt(mode);
    if (opt === null) {
      partyModeNote = `没有第 ${String(mode)} 档模式(共 ${PARTY_MODE_COUNT} 档)`;
      return;
    }
    partyCursor = opt.mode - 1;
    partyModeNote = partyModeSink === null
      ? `${opt.name} ✗ 未联机(单机模式不发报文)`
      : partyModeSink(opt.mode, opt.key);
    clickSound();
  };
  /** 本帧该显示的 boss:HUD 的**唯一**数据源(权威优先,demo 兜底)。 */
  const bossView = (): BossHudView | null => {
    const authoritative = bossHudFrom(authority.state);
    if (authoritative !== null) return authoritative;
    if (!bossActive || demoBoss === null) return null;
    /* demo 血条:血量 = 上限(不随时间伪造),阶段/名字仍来自内容层的 BossDef */
    return {
      id: `demo:${demoBoss.id}`,
      bossId: demoBoss.id,
      name: demoBoss.name,
      level: demoBoss.level,
      baseHp: demoBoss.baseHp,
      hp: demoBoss.baseHp,
      ratio: 1,
      phaseIndex: 0,
      phaseName: String(demoBoss.phases[0]?.name ?? ''),
      phases: demoBoss.phases,
      telegraph: null,
    };
  };

  /* ── roof_transparency:玩家进屋顶时整片淡出 ──
   * 调用点:主循环里 `roofFades` 按玩家格 `setPlayerCellByPos()` 的结果推进 */
  const roofMask = (() => {
    /* 把 demo 世界的 chunk 拼成一张连续网格(4×4 chunk = 64×64) */
    const W = WORLD_CELLS;
    const tiles = new Uint32Array(W * W);
    for (const c of chunks) {
      const arr = c.tiles as Uint32Array;
      for (let y = 0; y < CHUNK_SIZE; y += 1) {
        for (let x = 0; x < CHUNK_SIZE; x += 1) {
          const gx = c.cx * CHUNK_SIZE + x;
          const gy = c.cy * CHUNK_SIZE + y;
          tiles[gy * W + gx] = arr[y * CHUNK_SIZE + x]!;
        }
      }
    }
    return { tiles, W };
  })();
  /* demo 地形默认没有 obj 层(全 0),屋顶掩码会是空的 —— 那「屋顶透明」就永远测不到。
     所以在这里**真的放一片屋顶方块**:9×9 格的暖红陶瓦斜屋顶(372)。
     这不是为了让测试通过而伪造数据,而是让 demo 世界具备「有屋顶的房子」这个场景,
     否则 roof_transparency 接进来也没有任何可观察效果。

     ⚠ 位置**故意偏出生点**:出生点是世界中心 (32,32),屋顶放在 (44,44) 附近。
     这样开局看不到屋顶、走过去才淡出 —— 「进入」这个动作才可观察。
     若盖在出生点正上方,开屏即透明,反而分不清「一开始就透明」和「走进去才透明」。 */
  const ROOF_ORIGIN = { x: Math.floor(WORLD_CELLS / 2) + 12, y: Math.floor(WORLD_CELLS / 2) + 12 };
  const ROOF_HALF = 4; /* 9×9 */
  {
    for (let y = ROOF_ORIGIN.y - ROOF_HALF; y <= ROOF_ORIGIN.y + ROOF_HALF; y += 1) {
      for (let x = ROOF_ORIGIN.x - ROOF_HALF; x <= ROOF_ORIGIN.x + ROOF_HALF; x += 1) {
        if (x < 0 || y < 0 || x >= WORLD_CELLS || y >= WORLD_CELLS) continue;
        const i = y * WORLD_CELLS + x;
        const u = unpackTile(roofMask.tiles[i]!);
        roofMask.tiles[i] = packTile({
          elev: u.elev, base: u.base, floor: u.floor, wire: u.wire,
          obj: 372, meta: u.meta,
        });
      }
    }
  }
  const roofComponents: RoofComponents = labelRoofComponents(
    buildRoofMask(roofMask.tiles, roofMask.W, roofMask.W),
  );
  let roofFades: RoofFadeState[] = Array.from({ length: roofComponents.count }, (_, i) => ({
    component: i,
    progress: 0,
    entering: false,
  }));
  /**
   * 玩家所在格 —— ★ task-67 阶段 3:来源已改为**权威状态**(不再是 `pan`)。
   *
   * ## 为什么不能再用 `pan`(S1 删掉的那两行)
   *
   * `pan` 是**相机平移**:WASD 拖拽与 `teleport` 都会改它,它可以**离开玩家**。
   * 把它当玩家位置是「把相机当玩家」—— 而玩家位置由**服务端裁决**。
   * 接线前这里写的是:
   * ```
   * playerGx = pan.x;   // ← 每帧无条件执行(唯一写点)
   * playerGy = pan.y;
   * ```
   * 只要它在,**任何权威值都会在同一帧被覆盖** ⇒ 表现为「接线了但没效果」,
   * 不抛错、不报红。∴ S1 先删掉它,此处才改成从 `authority` 取。
   *
   * ## 语义:权威 → 就地使用;权威**未知** → 保持上一帧(不清零)
   *
   * `telegraphCenterOf` 在「本地玩家还没到 / 没有自己」时返回 `null`
   * (不是 `{0,0}` —— 那会把预警圈画到世界原点上一帧,且无人报错)。
   * ⇒ 本层遇到 `null` 时**保持上一帧的值**:第一帧还没到时用出生点,
   *   之后一直用权威值。这样「未知」不会被误当成「位置是 0,0」。
   */
  const authority = new ClientStateStore();
  /* 出生点:第一帧权威值到达前的占位(与 `pan` 初值一致,视觉上不跳) */
  let playerGx = WORLD_CELLS / 2;
  let playerGy = WORLD_CELLS / 2;
  /**
   * 本地玩家的**高度** `z`(权威状态里的第三个分量,单位「格」)。`0` = 站在地面。
   *
   * ★ WS-FND-48:它是**新**的一个轴 —— 接线前这个值被解析进 `RoomState` 却无人读,
   * 于是「跳起来」在屏幕上不存在。这里只存值;「z 怎么影响画面」全在
   * `net/height_placement.ts`(纯函数,含 `z = 0` 时与接线前逐字段相同的保证)。
   *
   * 初值 0 与出生点占位同一条理由:第一帧权威值还没到,画面上就是「站在地面」,
   * 而不是某个「合法但错」的高度(`localPlayerZOf` 的未知分支也给 0,见那边注释)。
   */
  let playerGz = 0;
  /** 权威位置是否已到达过一次 —— 供 `summary()` 自检与 WS-12 观测。 */
  let authoritySeen = false;
  /**
   * ★ WS-FND-113:预测姿态源(由 `main.ts` 调 `setPoseSource` 注入)。
   * `null` = 没有预测 ⇒ 渲染**只用权威值**(与接线前逐字段相同)。
   */
  let poseSource: (() => PredictedPose | null) | null = null;
  /** 最近一帧真的用上的预测姿态(自检口径;`null` = 这一帧画的是权威值)。 */
  let lastPredicted: PredictedPose | null = null;
  /**
   * 当前激活的屋顶分片。
   *
   * ⚠ **初值必须是 −1(未评估),不能是出生点处的真实分片号**。
   * 初版写成 `componentAt(..., 出生点)` 导致:若玩家出生点恰在某片屋顶下,
   * 首次 `updateRoof` 时 `id === roofActive` ⇒ 那条设置 `entering` 的分支**永不进入**
   * ⇒ 该片 `entering` 一直是 false ⇒ 屋顶永远不透明。
   * 这是个只在「出生在屋顶下」时才暴露的静默缺陷(实测 CDP 抓到 alpha 恒为 1)。
   * 用 −1 让**第一次 update 必定走一遍**状态同步。
   */
  let roofActive = -1;
  let roofVersion = 0;

  const updateRoof = (dtSec: number): void => {
    const id = componentAt(roofComponents, Math.floor(playerGx), Math.floor(playerGy), roofMask.W);
    if (id !== roofActive) {
      roofActive = id;
      roofVersion += 1;
      for (const f of roofFades) {
        const shouldEnter = id >= 0 && f.component === id;
        if (f.entering !== shouldEnter) f.entering = shouldEnter;
      }
    }
    roofFades = roofFades.map((f) => advanceFade(f, dtSec));
  };
  /** 某屋顶分片当前 alpha(供 three 侧材质/自检读取) */
  const roofAlphaOf = (component: number): number => {
    if (component < 0 || component >= roofFades.length) return 1;
    const p = roofFades[component]!.progress;
    /* fadeAlpha 的等价式(与 roof_transparency 同源,避免再 import 一个符号) */
    const s = p * p * (3 - 2 * p);
    return 1 - (1 - ROOF_MIN_ALPHA) * s;
  };

  /* ── 屋顶实体网格 ──
   *
   * ## 为什么屋顶必须单独建一个 mesh(这一步不做,整个接线就是空的)
   *
   * `chunk_geometry` 只从 **elev 层**产出地形侧面+顶面,
   * `obj` 层(我们写进去的 372 屋顶)**它根本不读**。
   * 所以只改数据的话:掩码算得对、alpha 算得对、CDP 读回来全对,
   * **但屏幕上什么都没有** —— 一个「所有指标都绿、玩家什么都看不到」的假接线,
   * 正是本轮要消灭的那种缺陷。
   *
   * 这里为每个 roof 格生成一块**水平四边形**(贴在格子的顶层高度),
   * 用独立材质以便按分片单独调 `opacity`。
   */
  const roofMesh = (() => {
    const W = WORLD_CELLS;
    const positions: number[] = [];
    const indices: number[] = [];
    let vi = 0;
    for (let gy = 0; gy < W; gy += 1) {
      for (let gx = 0; gx < W; gx += 1) {
        if (!isRoofTile(roofMask.tiles[gy * W + gx]!)) continue;
        const lvl = ELEV_TO_Z[unpackTile(roofMask.tiles[gy * W + gx]!).elev] ?? 0;
        /* 抬一点点避免与地形顶面 z-fighting */
        const h = lvl + 0.004;
        /*
         * ⚠ **轴顺序必须与 `chunk_geometry` 一致:(x, y=行, z=层高)**。
         *
         * 这不是 three.js 惯常的「y 朝上」—— 但 `chunk_geometry.pushVertex` 写的是
         * `(cellX + dx, cellY + dy, z)`,即**第二分量是行、第三分量才是高度**。
         * 相机 `buildOrthographicCamera` 就是按这套约定摆的,地形因此显示正常。
         *
         * 我第一版按常理写成 `(gx, 高度, gy)`,结果屋顶平面被放到了
         * 「行轴 = 高度」的错误位置 —— 在等距视角下完全跑到视野外/被地形遮住,
         * 表现依然是「alpha 全对、屏幕上看不见」。
         * 实测手段:`emitChunkGeometry(chunk(2,2))` 的 y 值集合是 32..48(行号),
         * 一眼看出第二分量是行不是高度。
         */
        positions.push(
          gx, gy, h,
          gx + 1, gy, h,
          gx, gy + 1, h,
          gx + 1, gy + 1, h,
        );
        /* 缠绕顺序与 `chunk_geometry` 的顶面一致:[0,1,2, 2,1,3] → 法线 +z */
        indices.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3);
        vi += 4;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({
      color: 0xc4674a,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'roof_plane';
    mesh.renderOrder = 2;
    scene.add(mesh);
    return mesh;
  })();
  /** 屋顶当前整体透明度(取最不透明的分片 —— 单分片时即该片的 alpha) */
  const roofOpacity = (): number => {
    if (roofFades.length === 0) return 1;
    return Math.max(...roofFades.map((f) => roofAlphaOf(f.component)));
  };
  const roofVertexCount = roofMesh.geometry.getAttribute('position').count;

  /* ── blueprint:拖拽框选 → 蓝图 ── */
  let bpDrag: ScreenRect | null = null;
  let bpSummary = '';
  let bpCells = 0;
  /** 地形每一格的 obj 值查表(蓝图收集要用真实的 getTile) */
  const tileAt = (gx: number, gy: number): number => {
    if (gx < 0 || gy < 0 || gx >= WORLD_CELLS || gy >= WORLD_CELLS) return 0;
    return roofMask.tiles[gy * WORLD_CELLS + gx]!;
  };

  /* ── 覆盖层 ── */
  const ui = new UiOverlay(container);
  /* 图集就绪后让覆盖层也能画图标(背包格子用) */
  void loadAtlasImage().then((img) => { ui.setAtlas(img); });

  /** 音高砖掩码:初始点亮 Do-Mi-Sol 三个音 */
  let pitchMask = 0;
  for (const p of DO_MI_SOL_PITCHES) pitchMask |= 1 << p;

  /** 面板切换:走 state_machine 的合法迁移,而不是自己存个字符串 */
  const setPanel = (panel: UiPanel): void => {
    const cur = uiFsm.activePanel;
    if (uiFsm.state === 'CLOSED') {
      uiFsm.open(panel);
      clickSound();
    } else if (cur === panel) {
      /* 同一个面板再按一次 = 关闭(CLOSED 是 OPEN/OPENING 的合法目标) */
      uiFsm.transition('CLOSED', 'toggle-off');
      clickSound();
    } else {
      /* 换面板:先关再开 —— 避免出现 OPEN 状态下直接换 panel 的非法路径 */
      uiFsm.transition('CLOSED', `switch:${cur}->${panel}`);
      uiFsm.open(panel);
      clickSound();
    }
    if (panel === UiPanel.INVENTORY || panel === UiPanel.RECIPE_TREE) refreshInventory();
  };

  /* ── 相机状态:聚焦点 `pan` + 跟随参数 + 一个**显式**的调试覆写 ──
   * ⚠ **声明顺序在这里很关键**,已被两个 bug 连环咬过:
   *
   * 1. `uiState()` / `telegraphGeometry()` 要用 `pan` —— 它们在 `tick` 里才被调用,
   *    但 `const` 有暂时性死区,声明若排在后面,首帧就抛
   *    `Cannot access 'pan' before initialization`。
   * 2. 下面那个 **URL 参数块会立刻调 `syncCamera()`**(`?at=` 传送),
   *    它同样读 `pan` —— 所以 `pan` 必须在 URL 块**之前**
   *    (实测:截图 `?at=44.5,44.5` 直接白屏报 `ReferenceError: Cannot access 'V'`)。
   *
   * 结论:`pan` / `camOverride` / `dragCtl` 声明在 `__uiDebug` 与 URL 块**之前**。
   *
   * ## `pan` 的语义(★ WS-FND-23 改了)
   *
   * 接线前它是「相机平移量」:WASD 与指针拖拽都在改它,它可以**离开玩家**。
   * 现在它是**相机聚焦点**,由 `tick` 每帧用 `stepCamera` 往**权威位置**推
   * (判定在 `net/camera_follow.ts`)⇒ WASD 不再写它(那两行已删),
   * 「角色不会走出画面」因此不再是巧合。
   *
   * 变量名保留 `pan` 是**故意的**:`telegraphGeometry()` / 蓝图框选 / 拖拽都从它读
   * 「相机在哪」,改名只增加噪声(那些读点与"谁推进它"无关)。
   */
  const pan = { x: WORLD_CELLS / 2, y: WORLD_CELLS / 2 };
  /**
   * 相机跟随的边界(世界格)与参数 —— 与 `stage/iso_camera.ts` 的 `DEFAULT_FOLLOW`
   * 同口径(边缘留白 8 格)。
   *
   * 边界不是装饰:权威位置**来自网络**,若服务端下发一个越界坐标,不夹紧的相机
   * 就飞到地图外看空白;夹紧后最多偏心 8 格(≈128px,视口半宽约 25 格)。
   */
  /* ★ w99:**相机跟随的边界必须用真实世界规模**。
     改前这里是 `maxX: WORLD_CELLS`(= `demo_world.ts` 的 **64**),而真实世界是 192×192 ——
     `cameraTargetFor` 会 `clampToBand(player, pad, maxX - pad)`,于是玩家在 96.5 时相机被
     夹到 **64 − 8 = 56**,离玩家 57 格 ⇒ **画面永远停在别处上空**(实测 `cameraLagCells 57.276`)。
     这就是「一直是在全图上空俯视、看不到自己周围」的根因。 */
  const CAMERA_BOUNDS = { minX: 0, minY: 0, maxX: worldCells, maxY: worldCells };
  const CAMERA_OPTS = { bounds: CAMERA_BOUNDS, edgePad: CAMERA_EDGE_PAD };
  /**
   * 相机跟随的**显式覆写**(默认关闭,生产路径永不设置它)。
   *
   * 为什么需要:`?at=` 与 `__uiDebug.teleport()` 是**自检截图**用的 —— 它们要把镜头
   * 搬到要看的地方(例如世界边上的那片屋顶)。若跟随每帧把相机拉回玩家,这两个钩子
   * 就**静默失效**(截图拍到的是出生点,而"为什么没搬过去"没有任何提示)。
   * ⇒ 覆写非 `null` 时暂停跟随、相机停在指定点;`__uiDebug.resumeFollow()` 清掉它。
   *
   * ⚠️ 它**不是**"WASD 平移相机"的替代品 —— 键盘那条路已经删了。
   */
  let camOverride: CameraPoint | null = null;
  /**
   * 最近一次**真的成交**的背包拖拽(`''` = 还没有)。
   *
   * ★ 第六轮审计 P1:`DragController.drop()` 此前零调用 ⇒ 这里没有"成交"可言。
   * 现在它由 `onUiPointerUp` 写入,并作为 `#hint` 的一行与
   * `summary().wiring.inventory.lastMove` 暴露 —— 「拖拽能不能搬东西」变成
   * **读得出来**的事实,而不是只能靠肉眼看格子。
   */
  let lastMove = '';
  /**
   * 相机聚焦点的**高度**分量(`IsoCamera.focusZ`)—— ★ WS-FND-48 新增的那个轴。
   *
   * ⚠️ **声明顺序不能挪**:`?at=` / `__uiDebug.teleport()` 会在下面的 URL 块里
   * **立刻**调 `syncCamera()`,而它读这个量 —— 声明若排在后面就是 TDZ,
   * 首帧直接抛 `Cannot access '...' before initialization`(上面 `pan` 的注释里
   * 记着同款实测事故)。
   *
   * 值由纯函数 `placementForHeight` 定(`z × 0.5` 夹在 ±1 格,理由在那边文件头),
   * 本文件只做「取值 → 每帧推进 → 塞进相机」。`z = 0` ⇒ 目标 `0`、当下 `0`,
   * 而 `0` 正是 `createCamera()` 的 `focusZ` 缺省值 ⇒ 接线前的相机表现**逐字段不变**。
   *
   * ★ WS-FND-51:这个量是**当下**的高度(每帧被 `stepCameraHeight` 推进一步),
   * **不是**目标 —— 目标在下面的 `cameraFocusZTarget`。两者**分开命名**是有意的:
   * 合成一个变量就再也分不出「镜头平滑到哪了」与「这一帧该到哪」,
   * 而那正是「硬跳变」与「平滑跟随」的唯一区别。
   */
  let cameraFocusZ = 0;
  /**
   * 相机聚焦点高度的**目标**(本帧的摆放结果 `mount.cameraFocus.z`)。
   *
   * 与 `cameraFocusZ`(当下)分开:目标每帧随权威 z 直接变(那是对的 —— 目标是读数),
   * 当下由 `stepCameraHeight` 按 `dt` 追它(那才是画面平滑)。
   * ⚠️ 只在本帧的摆放块里写、在相机块里读:两处相隔十几行,但**同一帧**同一个值
   * (跨帧复用会给镜头引入一帧滞后)。
   */
  let cameraFocusZTarget = 0;
  /** 拖拽控制器(ui/state_machine):悬停/拿起/放下 —— 驱动背包格子高亮 */
  const dragCtl = new DragController();

  /**
   * 自检钩子:把 UI 状态机与各模块的入口暴露给截图脚本。
   *
   * ## 为什么需要它(而不是只靠按键)
   *
   * headless Chrome 截图**无法发送键盘事件**(`--screenshot` 只做一次加载+截图)。
   * 没有这个钩子,「面板真的画出来了吗」就只能靠改代码把它默认打开 ——
   * 那是**改产品行为来迁就测试**,不可接受。
   *
   * 有了它,截图脚本可以:
   *   · `?panel=INVENTORY` 直接以某面板开局(见下方 URL 解析);
   *   · 或经 CDP 执行 `__uiDebug.open('RECIPE_TREE')` 再截图。
   *
   * 钩子只做「转发」,不含任何布局/绘制逻辑 —— 真正的实现在各模块里。
   */
  (window as unknown as { __uiDebug?: unknown }).__uiDebug = {
    open: (panel: string): string => {
      setPanel(panel as UiPanel);
      /* OPENING → OPEN 需要推进一帧,直接补齐以免截图拍到半透明 */
      uiFsm.tick(1);
      return uiFsm.activePanel;
    },
    close: (): string => {
      if (uiFsm.state !== 'CLOSED') uiFsm.transition('CLOSED', 'debug-close');
      return uiFsm.state;
    },
    summonBoss: (): boolean => { bossActive = true; return bossActive; },
    panel: (): string => uiFsm.activePanel,
    state: (): string => uiFsm.state,
    /**
     * ★ WS-FND-151:选中第 `mode` 档(自检/截图脚本用)。
     *
     * headless Chrome 发不了键盘事件(`--screenshot` 只加载一次),
     * 所以「面板画出来了吗 / 选了之后真的发报文了吗」必须有一个**显式**钩子。
     * 返回值是入口回的那句话(成功 / 被拒 / 未联机都由 `net/action_entry` 决定)。
     */
    selectPartyMode: (mode: number): string => {
      selectPartyMode(mode);
      return partyModeNote;
    },
    /** 面板当前的光标与行数(`PARTY_MODES.length` 的镜像;用于断言"档数一致") */
    partyPanel: (): { rows: number; cursor: number; currentMode: number } => {
      const p = partyPanelOf(authority.state.meta, partyCursor);
      return { rows: p.rows.length, cursor: p.cursor, currentMode: p.currentMode };
    },
    /**
     * 把**相机**搬到某格(自检截图用)。
     *
     * ⚠️ 它**不动玩家** —— 玩家位置唯一来源是权威状态(`telegraphCenterOf`),
     * 客户端不许自己搬自己(那是"把相机当玩家",S1 已删掉那种写法)。
     * ⚠️ 也正因如此,它会**停住跟随**(`camOverride`),否则下一帧跟随就把镜头
     * 拉回玩家、钩子静默失效。看完调 `resumeFollow()` 交还给跟随。
     */
    teleport: (gx: number, gy: number): void => {
      pan.x = gx; pan.y = gy;
      camOverride = { x: gx, y: gy };
      syncCamera();
    },
    /** 交还相机给**跟随**(清掉自检覆写) */
    resumeFollow: (): boolean => { camOverride = null; return camOverride === null; },
    /** 点一个背包格子(验证 inventory 图标真的画在图集上) */
    clickSlot: (indexInPage: number): string => {
      const sl = invView.slots[indexInPage];
      if (!sl) return '';
      dragCtl.pickUp(indexInPage, sl.item.id, 1);
      dragCtl.hoverAt(indexInPage);
      return sl.item.name;
    },
    /** 唤醒音频(需在用户手势里;CDP 里显式调用来验证 audio 链路) */
    wakeAudio: (): Promise<void> => audioOut.resume(),
    /** 播一个音高(验证 audio.ts → WebAudio 的链路) */
    playNote: (pitch: number): string => {
      const r = audioOut.noteOn({ pitch, timbre: 0, startSec: 0, durationSec: 0.5, velocity: 0.9 });
      return r ? `pitch ${pitch} → ${r.hz.toFixed(2)} Hz` : 'null';
    },
  };

  /**
   * URL 参数驱动的初始状态 —— **仅供自检截图**,不影响正常使用。
   *
   * `?panel=INVENTORY&boss=1&at=30,30`
   *
   * 为什么用 URL 而不是环境变量:截图脚本只能控制 URL,
   * 而我们要验证的正是「浏览器加载这个页面后长什么样」。
   */
  {
    const q = new URLSearchParams(location.search);
    const wantPanel = q.get('panel');
    if (wantPanel) {
      if (wantPanel === 'BOSS') {
        bossActive = true;
      } else {
        uiFsm.open(wantPanel as UiPanel);
        uiFsm.tick(1); /* 补齐打开动画,截图直接是 OPEN */
      }
    }
    if (q.get('boss') === '1') bossActive = true;
    const at = q.get('at');
    if (at) {
      const [gx, gy] = at.split(',').map(Number);
      if (Number.isFinite(gx) && Number.isFinite(gy)) {
        /* ★ 把**相机**搬到 `at`(`pan` 是相机聚焦点)。
           ⚠️ 必须同时立 `camOverride`:否则第一帧的跟随就把镜头拉回玩家,
           截图脚本拍到的会是出生点,而"为什么没搬过去"没有任何提示。
           `syncCamera()` 在这里显式调一次 —— 不能指望第一帧的跟随来同步
           (覆写生效时跟随那一支根本不跑)。 */
        pan.x = gx;
        pan.y = gy;
        camOverride = { x: gx, y: gy };
        syncCamera();
      }
    }
    if (q.get('recipe') === '1') refreshRecipe();
  }

  /* ── 组装一帧的 UI 绘制状态 ──
   *
   * ★ 第六轮审计 P1/P2:这里的每个字段都必须是**某个真实读者**要用的量,
   *   而不是"算好了放着":
   *   · `boss` / `bossGhost` 来自 `bossView()`(权威 `RoomState.bosses`);
   *   · `dragging` / `dragFrom` 由 `ui_binding` 用来画拖拽中的源格与目标格;
   *   · `party` 由 `drawNotes` 画成一行(派对/比分此前**零读者**)。
   */
  const uiState = (): UiDrawState => {
    const bv = bossView();
    return {
      /* 预警圈多边形由主循环在 `ui.draw(st)` 之前填入(它要用**本帧**的相机);
         这里给空数组,保证 `UiDrawState` 在构造时就是完整的形状。 */
      telegraphRing: [],
      telegraphInner: [],
      panel: uiFsm.activePanel,
      openProgress: uiFsm.state === 'OPEN' ? 1 : uiFsm.openingProgress,
      dragging: dragCtl.isDragging,
      dragFrom: dragCtl.dragging === null ? -1 : dragCtl.dragging.fromSlot,
      hoverSlot: dragCtl.hover,
      view: invView,
      invQuery,
      activeCategory: invCategory,
      recipe: recipeTree,
      recipeId: RECIPE_ID,
      recipeBatches: RECIPE_BATCHES,
      recipeNote,
      easel,
      paletteIndex,
      pitchMask,
      boss: bv,
      bossGhost,
      /* 提示行:**权威** boss 的预警文案(没有 boss 时说空);不再拿内容层第一条
         阶段的文案冒充"当前预警" —— 那是接线前的假值,和血条一样对不上服务端。 */
      telegraphNote: bv !== null && bv.telegraph !== null
        ? `预警 ${bv.telegraph.shape} r=${bv.telegraph.radius.toFixed(1)} 格`
        : (bv !== null && bv.phases.length > 0 ? String(bv.phases[bv.phaseIndex]?.telegraph ?? '') : ''),
      party: partyHudOf(authority.state.meta),
      /* ★ WS-FND-151:模式面板的内容(纯逻辑现算)+ 急行条件清单 */
      partyPanel: partyPanelOf(authority.state.meta, partyCursor),
      partyModeNote,
      rush: rushReadinessOf(rushAuthorityInput(), RUSH_SNAPSHOT_GAP),
      blueprintNote: bpSummary,
      /* ★ 提示行说清"谁动"与"谁跟":WASD 动的是**角色**,相机是**跟随** ——
         接线前这里写的是「WASD 平移」,那句话现在是错的,而错文案没人会去测。
         ★ 缩放档位(`[` / `]`,6 档)与搜索(`/`)也必须写进提示 —— 否则
           "存在但没人知道能按"的键位等于不存在。 */
      /* ★ 空格是「一键两义」,这里如实写**现状**:既挥一刀,也锁存一次跳跃(`net/input.ts`
         的 `jumpLatched` → `MoveIntent.jump` 上行,恰好一条)。服务端**认这个字段**
         (`ws_server.ts#parseMoveIntent` 只收字面 `true`)⇒ `applyJumpIntent` → `tryPlayerJump`,
         「能不能起跳」(空中 / 冷却)由世界侧一处裁决,被拒会写进 `lastJumpReport`。
         接线前这里写的是「服务端不认 jump ⇒ 现在只是挥刀」—— 那句话现在是错的,
         而错文案没人会去测(判据 `tests/WS-FND-122-protocol-exits.test.ts`)。 */
      keysHint: `${panelKeyHints()} · B Boss · [ ] 缩放 ${isoCam.zoom}×`
        + ` · / 搜索${searchMode ? `("${invQuery}")` : ''} · 拖拽框选蓝图 · WASD 移动角色(相机跟随)`
        + ` · 空格 攻击 + 跳跃(锁存一次;服务端认 jump,地面/冷却由世界侧判)`
        + ` · 动作键 ${entryKeyHints()} · 热键 ${hotbarKeyHints()}`
        + ' · 拖拽背包=本地整理(不发报文,刷新即回原序)',
    };
  };

  /**
   * 预警圈屏幕坐标:交 `boss_hud.buildTelegraph` 算,本层只取结果。
   *
   * ★ 第六轮审计 P1:几何现在优先来自**权威 boss 实体**的 `telegraphShape/X/Y/R`
   *   (线上数字经 `clientTelegraphShapeOf` 映射成渲染几何)。接线前这里是
   *   硬编码的 `shape:'ANNULUS'` + 圆心钉在**本地玩家**身上 ⇒ 服务端换了几何/位置,
   *   玩家看到的还是同一个环,而且不报错。
   *   没有权威预警时退到旧的 demo 环(仅 `bossActive` 演示路径)。
   */
  const telegraphGeometry = (): { outer: { x: number; y: number }[]; inner: { x: number; y: number }[]; vertices: number } => {
    const bv = bossView();
    if (bv === null) return { outer: [], inner: [], vertices: 0 };
    const spec: TelegraphSpec = bv.telegraph !== null
      ? {
        shape: bv.telegraph.shape,
        cx: bv.telegraph.cx,
        cy: bv.telegraph.cy,
        cz: 0,
        radius: bv.telegraph.radius,
        chargeSec: 1.2,
        danger: 0.85,
      }
      : {
        shape: 'ANNULUS',
        cx: playerGx,
        cy: playerGy,
        cz: 0,
        radius: 3.5,
        innerRadius: 2,
        chargeSec: 0.8,
        danger: 0.8,
      };
    /* ★ WS-FND-48:预警圈的屏幕投影必须用**与渲染同一个**相机口径(含 `focusZ`),
       否则立牌抬起来后它在屏幕上会与镜头差半格 —— 而这种错没有任何东西会报 */
    const cam = cameraAtFocus();
    const g = buildTelegraph(spec, cam);
    return { outer: g.screenOuter, inner: g.screenInner, vertices: g.screenOuter.length + g.screenInner.length };
  };

  /** 拖拽控制器(ui/state_machine):悬停/拿起/放下 —— 目前驱动格子高亮 */

  /* ── 指针:UI 命中优先,否则交给世界拖动 ── */
  const onUiPointerDown = (e: PointerEvent): void => {
    /* 音频必须在用户手势里唤醒,否则后续所有音符都被静默丢弃 */
    void audioOut.resume();
    const st = uiState();
    const hit: UiHit = ui.hit(st, e.clientX, e.clientY);
    if (hit.kind !== 'none') {
      clickSound();
      if (hit.kind === 'tab') {
        invCategory = hit.category;
        invPage = 0;
        refreshInventory();
      } else if (hit.kind === 'pager') {
        invPage = Math.max(0, Math.min(invView.pageCount - 1, invPage + hit.delta));
        refreshInventory();
      } else if (hit.kind === 'slot') {
        /* 悬停高亮走 state_machine 的 DragController(拿起 → 悬停 → 放下) */
        const sl = invView.slots[hit.indexInPage];
        if (sl) {
          /* ⚠ 拿起与悬停**必须用同一个下标口径**(页内下标):`drop(slot)` 比的是
             `fromSlot === slot`;若一处给全局槽位、另一处给页内下标,同一格会
             永远"不相等" ⇒ 放下被当成"放回原处"而静默变成取消。 */
          dragCtl.pickUp(hit.indexInPage, sl.item.id, 1);
          dragCtl.hoverAt(hit.indexInPage);
        }
      } else if (hit.kind === 'easel') {
        easel.beginStroke();
        easel.paint(hit.x, hit.y, paletteIndex);
        easel.endStroke();
      } else if (hit.kind === 'palette') {
        paletteIndex = hit.index;
      } else if (hit.kind === 'toolbar') {
        if (hit.action === 'undo') easel.undo();
        else if (hit.action === 'redo') easel.redo();
        else easel.clear();
      } else if (hit.kind === 'brick') {
        /* 音高砖:点亮/熄灭 + 真的发声 */
        pitchMask ^= 1 << (hit.pitch % 32);
        audioOut.noteOn({
          pitch: hit.pitch % 32,
          timbre: 0,
          startSec: 0,
          durationSec: 0.5,
          velocity: 0.9,
        });
      } else if (hit.kind === 'partyMode') {
        /* ★ WS-FND-151:点模式面板的某一行 = 选中它(与 `Enter` 走同一条路:
           光标先对齐,再交给注入的端口发报文)。 */
        selectPartyMode(hit.mode);
      }
      e.preventDefault();
      return;
    }
    /* ★ WS-FND-166:面板**容器**内也算 UI。修前这里只看"命中了哪个格子",
       按在面板空白处返回 `none` ⇒ 世界拖动(以及 `window` 上的虚拟摇杆)**同时**
       吃掉这一下 —— 实测表现是「单指拖背包时角色一边走」。 */
    if (uiHitAt(e.clientX, e.clientY)) {
      e.preventDefault();
      return;
    }
    /* 面板外:开始世界拖动,同时记录蓝图框选起点 */
    drag = { x: e.clientX, y: e.clientY };
    bpDrag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
  };

  const onUiPointerMove = (e: PointerEvent): void => {
    if (bpDrag) {
      bpDrag = { ...bpDrag, x1: e.clientX, y1: e.clientY };
    }
    /* 背包打开时同步悬停高亮 */
    if (uiFsm.activePanel === 'INVENTORY' || uiFsm.activePanel === 'RECIPE_TREE') {
      const st = uiState();
      const hit = ui.hit(st, e.clientX, e.clientY);
      if (hit.kind === 'slot') dragCtl.hoverAt(hit.indexInPage);
      else if (dragCtl.isDragging) dragCtl.hoverAt(-1);
    }
  };

  const onUiPointerUp = (): void => {
    if (bpDrag) {
      const rect = normalizeScreenRect(bpDrag);
      if (isDrag(rect)) {
        /* 屏幕 → 世界 → 裁剪 → 收集,四步全部走 blueprint.ts 的纯函数 */
        const cam = cameraAtFocus();
        const world = screenRectToWorldRect(rect, cam, 0);
        const range = clampCellRange(world);
        const bp = collectBlueprint(range, tileAt, [0, 1, 2]);
        bpSummary = blueprintSummary(bp);
        bpCells = bp.filled;
      }
    }
    bpDrag = null;
    /* ── ★ 第六轮审计 P1:抬手 → `drop()`,不是一律 `cancel()` ──
     *
     * 修前这一行是 `if (dragCtl.isDragging) dragCtl.cancel();` —— `DragController.drop()`
     * 在**整个 client 里零调用**,于是「拿起 → 悬停 → 放下」永远走不到第三态:
     * 拖拽只剩一个高亮框,背包里什么都搬不动,而 `drop()` 的返回结构
     * `{fromSlot,toSlot,itemId,count}`(唯一的"成交"凭证)没有任何读者。
     *
     * 现在:悬停在某一格 ⇒ **成交**(`drop` 返回 from/to);悬停在自身或面板外
     * ⇒ `drop` 内部按"放回原处"取消(`fromSlot === slot` 分支)。
     * ⚠ 悬停为 `-1`(面板外/空白)时**不能**调 `drop(-1)`:它会返回一个
     *   `toSlot = -1` 的"成交",让上层把一个物品搬到不存在的格子里。
     */
    if (dragCtl.isDragging) {
      const hover = dragCtl.hover;
      const moved = hover >= 0 ? dragCtl.drop(hover) : null;
      if (moved !== null) {
        /* ── ★ 第七轮审计 P1:`drop()` 的返回值必须被**消费**,不只是拿去拼一句话 ──
         *
         * 修前:`moved` 只用了 `fromSlot/toSlot/itemId` 拼 `lastMove`,
         * 而 `invView` 每帧由静态 `ITEM_LIST` 重建 ⇒
         * ```
         * #hint   : '第 3 格 → 第 9 格'      ← 变了
         * 格子内容: ITEM_LIST[i]             ← 一件都没动
         * ```
         * 现在把它写进**格位状态**(`slotItemIds`)+ 立刻重建视图 ⇒ 格子内容真的换位,
         * 而 `slotFingerprint` 让"真的变了"成为自检口径里的一个可读值。
         *
         * ⚠️ `drop()` 给的是**页内下标**(拾起时用的是 `hit.indexInPage`),
         * 而格位状态用**全局格位** ⇒ 必须经 `invView.slots[i].slot` 换算。
         * 直接用页内下标会让第 2 页之后的搬运落到错误的格子(而且不报错)。
         */
        const fromGlobal = invView.slots[moved.fromSlot]?.slot ?? -1;
        const toGlobal = invView.slots[moved.toSlot]?.slot ?? -1;
        const applied = applySlotMove(slotItemIds, fromGlobal, toGlobal);
        if (applied !== null) {
          slotItemIds = applied.itemIds;
          slotMoveCount += 1;
          refreshInventory();
          /* ★ 第十轮 P1:文案必须**如实标出"这是本地整理"** ——
             它只改了本机 `slotItemIds`(`DRAG_UPLINK === 'local-only'`),
             服务端的归属与背包一件没动,刷新/重连即回原序。
             修前这里只写"第 3 格 → 第 9 格",玩家读到的是"搬好了、存住了"。 */
          lastMove = `第 ${moved.fromSlot} 格 → 第 ${moved.toSlot} 格`
            + `(${moved.itemId} ×${moved.count};格位 ${fromGlobal} ⇄ ${toGlobal})`
            + ` · 本地整理视图(不发报文:${DRAG_UPLINK};刷新/重连即回原序)`;
        } else {
          /* 越界 / 同一格:如实说"没生效",不假装搬了 */
          lastMove = `第 ${moved.fromSlot} 格 → 第 ${moved.toSlot} 格 未生效(格位 ${fromGlobal}/${toGlobal})`;
        }
        clickSound();
      } else {
        dragCtl.cancel();
      }
    }
  };

  /* ── 键盘:面板 / 画架 / Boss / **缩放** / **背包搜索** ──
   *
   * ★ WS-FND-23:这里**曾经**还维护一个 `keys` 集合,给渲染循环读去做相机平移。
   *   那条路已删(相机现在跟权威位置走,见 `net/camera_follow.ts`),
   *   `keys` 于是变成"只写不读"的死状态 ⇒ 一并删掉,不留一个看起来还在用的变量。
   *   WASD 的去向完全在 `main.ts` 的输入链路里(`InputSource` → `predictor` → 上行)。
   * ⚠ `pan` / `dragCtl` 已在上面的 UI 运行时块中声明(那里要先用)——
   * 这里**不要**再声明一次,否则是重复定义。
   *
   * ★ 第六轮审计 P2:
   *   · `isoCam.zoom` 此前**只有读点没有写点** ⇒ `ZOOM_LEVELS` 的 6 档缩放
   *     在生产里完全不存在(按什么都没反应)。现在 `[` / `]` 走纯函数
   *     `stepZoom` → 写 `isoCam.zoom` → `syncCamera()`(正交半宽 = 视口/2/pixelScale,
   *     见 `assembly_math.orthoHalfExtents`,所以缩放是**真的**改变视野,不是改个数字)。
   *   · `invQuery` 此前恒 `''` ⇒ 背包搜索不可达。现在 `/` 进出搜索态。
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    /* ── 搜索态:先吃掉输入,再轮到快捷键(否则打 "i" 会开背包而不是搜索)── */
    if (searchMode) {
      onSearchKey(e);
      return;
    }
    /* 面板快捷键 —— **走 state_machine 的合法迁移**,不是自己存字符串。
     * 键位表在 `ui/panel_keys.ts`(**唯一一处**;本文件只做转发)。
     *
     * ★ 第七轮审计 P1(『e』双绑):这里修前是 `case 'e': setPanel(UiPanel.PIXEL_EASEL)`,
     *   而 `net/action_target.ts` 的 `ACTION_KEYS` 把 `e` 绑成「拆除面前那格」⇒
     *   **一次按键两件事**(画架打开 + BREAK_BLOCK 发出),两边都不报错。
     *   画架已改到 `h`(空闲字母),键集互斥性见 `panel_keys.keyCollisions()`。 */
    const key = e.key.toLowerCase();
    const panel = panelKeyOf(key);
    if (panel !== null) { setPanel(panel); return; }
    /* ★ WS-FND-151:模式面板的选中键(`j` / `l` / `enter`)。

       键位表在 `ui/panel_keys.PARTY_PANEL_KEYS` 并进 `keyGroups()` —— 与其它组
       撞车会**当场红**;`1..4` 因此**不能**当模式键(它们是 `HOTBAR_KEYS`)。
       ⚠️ 搜索态在上面第一支就 `return` 了(与 `net/key_guard.ts` 同一条口径:
          文本输入态里这些键一律让路)⇒ 在搜索框打字不会误选模式。 */
    if (uiFsm.activePanel === UiPanel.PARTY) {
      if (key === PARTY_PANEL_KEYS.prev) {
        partyCursor = movePartyCursor(partyCursor, -1);
        clickSound();
        e.preventDefault();
        return;
      }
      if (key === PARTY_PANEL_KEYS.next) {
        partyCursor = movePartyCursor(partyCursor, 1);
        clickSound();
        e.preventDefault();
        return;
      }
      if (key === PARTY_PANEL_KEYS.confirm) {
        selectPartyMode(partyCursor + 1);
        e.preventDefault();
        return;
      }
    }
    switch (key) {
      /* ★ 6 档缩放:`[` 缩小 / `]` 放大。两个键都只调 `stepZoom`(端点不越界),
         然后重建相机 —— 只写 `isoCam.zoom` 而不 `syncCamera()` 的话,
         画面不会变(而数字"看起来对了")。 */
      case ZOOM_KEYS[0]:
      case ZOOM_KEYS[1]: {
        const next = stepZoom(isoCam, key === ZOOM_KEYS[1] ? 1 : -1);
        isoCam.zoom = next.zoom;
        syncCamera();
        clickSound();
        break;
      }
      /* `/` 进搜索态(背包/配方面板时才有效 —— 那份 view 才有 query 语义) */
      case SEARCH_KEY:
        if (uiFsm.activePanel === 'INVENTORY' || uiFsm.activePanel === 'RECIPE_TREE') {
          searchMode = true;
          e.preventDefault();
        }
        break;
      case BOSS_DEMO_KEY:
        /* demo Boss 召唤/遣返 —— 只影响**没有权威 boss**时的演示血条 */
        bossActive = !bossActive;
        clickSound();
        break;
      /* 画架工具键(仅画架打开时有效;键集见 `panel_keys.EASEL_TOOL_KEYS`) */
      case 'z': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.undo(); break;
      case 'y': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.redo(); break;
      case 'x': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.clear(); break;
      case 'c': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.floodFill(8, 8, paletteIndex); break;
      case CLOSE_PANEL_KEY: if (uiFsm.state !== 'CLOSED') uiFsm.transition('CLOSED', 'escape'); break;
      default: break;
    }
  };
  /**
   * 搜索态下的按键 —— **唯一**能写 `invQuery` 的地方。
   *
   * 出口三条:Enter(收下并退出)/ Escape(清空并退出)/ Backspace(退格)。
   * 其余**单字符**键追加到查询串;多字符键(Shift/Control/Arrow…)直接忽略 ——
   * 否则 `e.key === 'Shift'` 会被拼进查询串,再把整个背包过滤成空。
   *
   * ⚠️ 必须在**快捷键之前**拦(见 `onKeyDown` 的第一支):否则打 `i` 会开背包、
   *   打 `b` 会召唤 boss,搜索框永远只能搜到不含这些字母的物品名。
   */
  const onSearchKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    if (e.key === 'Enter') { searchMode = false; return; }
    if (e.key === 'Escape') { searchMode = false; invQuery = ''; invPage = 0; refreshInventory(); return; }
    if (e.key === 'Backspace') {
      invQuery = invQuery.slice(0, -1);
      invPage = 0;
      refreshInventory();
      return;
    }
    if (e.key.length !== 1) return; /* Shift / Arrow / F1 … 不是字符 */
    invQuery += e.key;
    invPage = 0;
    refreshInventory();
  };
  /* ⚠ 没有 `keyup` 监听:相机不再由按键驱动(WS-FND-23)⇒ 不需要"记着哪些键还按着" */
  window.addEventListener('keydown', onKeyDown);

  /* 单指拖动(手机)+ UI 命中 */
  let drag: { x: number; y: number } | null = null;
  const cv = renderer.domElement;
  /**
   * 指针按下:**先问 UI,再交给世界**。
   *
   * 顺序不能反 —— 反过来会让「点面板」同时也拖动镜头,
   * 表现为「一开背包地图就跳」。`onUiPointerDown` 命中时返回 true 并已 `preventDefault`。
   */
  const onPointerDown = (e: PointerEvent): void => {
    onUiPointerDown(e);
    if (drag !== null) return; /* UI 已消费,或已进入世界拖动 */
  };
  const onPointerMove = (e: PointerEvent): void => {
    onUiPointerMove(e);
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    /* ★ WS-FND-23:这是**唯一**还允许手改相机的地方,而且它是**临时**的 ——
       `tick` 在 `drag !== null` 期间跳过跟随(见那里的注释),松手后跟随把相机
       自动拉回权威位置。`client/index.html` 的「单指拖动视角」指的就是它。
       ⚠️ 键盘那条路**已删**:相机与角色共用一批按键是"看着像跟随"的根源。 */
    /* 屏幕位移换算成格:每格约 TILE_PX 像素,斜向除以根号 2 */
    const k = 1 / (16 * 1.414);
    pan.x += (-dx + dy) * k;
    pan.y += (-dx - dy) * k;
    pan.x = Math.max(-8, Math.min(WORLD_CELLS + 8, pan.x));
    pan.y = Math.max(-8, Math.min(WORLD_CELLS + 8, pan.y));
    syncCamera();
  };
  const onPointerUp = (): void => {
    onUiPointerUp();
    drag = null;
  };
  cv.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  /* ★ WS-FND-23:`pointercancel`(手势被系统/浏览器打断)也必须结束拖动 ——
     否则 `drag` 永远非 null,而跟随在 `drag !== null` 期间是**暂停**的
     ⇒ 相机再也不跟随,且屏幕上只表现为"镜头不动了"。这是静默降级,必须有出口。 */
  window.addEventListener('pointercancel', onPointerUp);

  /**
   * ★ WS-FND-166:**这一下算不算按在 UI 上**(面板容器 ∩ 面板内的部件)。
   *
   * ## 为什么必须有这个判定(实测踩过)
   *
   * 摇杆(`main.ts` 的 `window.pointerdown`)与攻击都挂在 **window 冒泡层**,
   * 而这一层**不知道** `boot` 的 UI 是否已经消费了这一下:
   * ```
   * 手指按在背包面板上往下拖 ⇒ UI 收到(拿起格子)  + 摇杆也收到(角色开始走)
   * ```
   * 两条监听各自都"工作正常",合起来是「单指拖背包时角色一边走」。
   * 现在判定是一个**纯函数**(`ui/panel_hit.uiConsumesPoint`:先问部件,再问容器),
   * `main.ts` 先调它 ⇒ 与事件注册顺序无关,且能在 node 里断言。
   */
  function uiHitAt(x: number, y: number): boolean {
    const st = uiState();
    const args: UiHitArgs = {
      panel: st.panel,
      view: st.view,
      easel: st.easel,
      partyPanel: st.partyPanel,
      recipeNodes: st.recipe?.nodeCount ?? 0,
    };
    const layouts: UiHitLayouts = { inv: ui.invLayout, pitch: ui.pitchLayout };
    return uiConsumesPoint(
      args, layouts, inventoryTabCategories(),
      window.innerWidth, window.innerHeight, x, y,
    );
  }

  /** ★ WS-FND-166:触屏按钮条的「关」—— 走**同一台**状态机的合法迁移。 */
  function closePanel(): void {
    if (uiFsm.state !== 'CLOSED') uiFsm.transition('CLOSED', 'touch-close');
  }

  /**
   * 造一个**逻辑相机**并把它对准「跟随出来的相机聚焦点 + 高度分量」。
   *
   * 为什么抽成一个函数(而不是三处各写一遍三行):本文件有三个地方要从 `pan` 造相机
   * —— 渲染(`syncCamera`)、预警圈的屏幕投影、蓝图框选的世界换算。三处若各写一份
   * `focusZ`,高度轴就会在某一处**静默漏掉**(表现:立牌抬起来了,但框选/预警圈仍按
   * 地面算 ⇒ 差半格,而没有任何东西会报错)。★ WS-FND-48 把它们收敛成一个口径。
   *
   * `focusZ: cameraFocusZ`(`z = 0` ⇒ `0` ⇒ 与 `createCamera()` 的缺省值相同)。
   */
  function cameraAtFocus(): IsoCamera {
    const c = createCamera(window.innerWidth, window.innerHeight);
    c.focusX = pan.x;
    c.focusY = pan.y;
    c.focusZ = cameraFocusZ;
    return c;
  }

  /** 把逻辑相机状态同步到 three 相机(唯一一处重复代码,抽出来) */
  function syncCamera(): void {
    const c = cameraAtFocus();
    c.zoom = isoCam.zoom;
    const nc = buildOrthographicCamera(c);
    camera.position.copy(nc.position);
    camera.quaternion.copy(nc.quaternion);
    camera.left = nc.left;
    camera.right = nc.right;
    camera.top = nc.top;
    camera.bottom = nc.bottom;
    camera.updateProjectionMatrix();
  }

  /* ── 主循环 ── */
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let raf = 0;
  let fps = 0;

  const tick = (now: number): void => {
    const dt = Math.min(100, now - last);
    last = now;

    /* ── ★ WASD **不再**平移相机(WS-FND-23)──
     *
     * 这里曾经是:
     * ```
     *   if (keys.has('a')) dx -= 1; ...  pan.x += (dx / len) * speed;
     * ```
     * 「角色不会走出画面」当时**全靠它** —— 而那是**巧合**:角色由 `main.ts` 的输入链路
     * 独立推进(本地预测 + 服务端权威),相机却在按**同一批键**猜位置。两边一旦
     * 不同步(服务端纠偏 / 传送 / 别的输入设备),角色就直接走出画面,且**不报错**。
     *
     * ⇒ 整块删除。相机改由下面的「跟随权威位置」推进(每帧一次),
     *   `keys` 集合随之消失(删掉读者之后它只剩"被写",那是死状态)。
     */

    /* ── 每帧子系统推进(这些调用就是「模块真的在跑」的证据)── */
    /* 1. state_machine:推进打开动画(OPENING → OPEN) */
    uiFsm.tick(dt / 1000);
    /* 2. roof_transparency:玩家所在格 → 屋顶连通域 → 淡入淡出
     *
     * ★ task-67 阶段 3(S2)在此**从权威状态取玩家位置**。
     *   (S1 删掉了原来的 `playerGx = pan.x; playerGy = pan.y;` —— 见文件内注释)
     *
     * `telegraphCenterOf` 的 `null` 语义:权威未知(第一帧未到 / 还没有自己的 id)
     * ⇒ **保持上一帧**,不清零、不画到世界原点。
     */
    const center = telegraphCenterOf(authority.state, authority.localPlayerId);
    /* ── ★ WS-FND-113 第 2 处:每帧拉一次**预测**姿态 ──
     *
     * 为什么是"拉"而不是"被 push":预测 32Hz、渲染 60Hz。存在一个变量里会让渲染画
     * "上一次推进时的位置",最多滞后一帧(16ms)—— 与"滞后一个 RTT"只是程度不同,
     * 而两者的症状看起来一样。`null` = 没有预测(未联机 / 权威还没到 / 坐标坏了)。
     */
    const predicted = poseSource === null ? null : poseSource();
    lastPredicted = predicted;
    /* ⚠️ `playerGx/playerGy` 仍然是**权威值**:`tests/WS-12` 把它的赋值点钉成
     * 「恰好 1 处且等式右边是 `center.cx`」,`tests/WS-FND-23` 又把相机那一行
     * (`cameraTargetFor(authoritySeen ? { x: playerGx, ... })`)逐字钉住。
     * ⇒ 本轮的取舍:**立牌**画预测位置(见下面的 `baseShown`),**镜头/屋顶/预警圈**
     *   仍跟权威值。代价是角色比镜头略前(≈ 一个 RTT 的位移,≤1 格),肉眼不可辨;
     *   要连镜头一起提前,必须同时改那两条判据 —— 不在本轮偷改。 */
    if (center !== null) {
      playerGx = center.cx;
      playerGy = center.cy;
      authoritySeen = true;
    }

    /* ── ★ WS-FND-48:线上 `z`(**高度**)──
     *
     * 与 x/y **同源**(同一个 `RoomState` + 同一个 `localPlayerId`),但走**独立入口**:
     * x/y 经 `telegraphCenterOf`,z 经 `localPlayerZOf` —— 两个都在纯模块里,可被 node 断言。
     * ⚠️ 不给 `telegraphCenterOf` 的返回加一个 `cz`:它的形状被 `tests/WS-12` **逐字段**
     *   断言成 `{cx, cy}`,加字段会让那条已绿的判据变红。
     *
     * 语义:单位「格」,**相对地表**的高度,`0` = 站在地面
     * (服务端 `physics.spawn(..., z: 0)` 的默认值;`applyPlayerMove` 只收 x/y ⇒
     *  它**不是**绝对高程,见 `net/height_placement.ts` 的语义取证)。
     */
    playerGz = localPlayerZOf(authority.state, authority.localPlayerId);

    /* 立牌预算跟着玩家走:换了块、或地形有更新,就重排(最多每 500ms 一次,避免地形帧连发时反复重建)。 */
    if (authoritySeen && propAtlasReady) {
      const fcx = Math.floor(playerGx / CHUNK_SIZE);
      const fcy = Math.floor(playerGy / CHUNK_SIZE);
      const key = `${fcx},${fcy}`;
      const now = performance.now();
      if ((key !== propFocusKey || propFocusDirty) && now - propRebalanceAtMs >= 500) {
        propFocusKey = key;
        propFocusDirty = false;
        propRebalanceAtMs = now;
        rebalancePropsAround(fcx, fcy);
      }
    }

    /* ── task-83 + ★ WS-FND-48:把玩家画出来,并让它跟着 32Hz 快照动 ──
     *
     * 这一块就是「快照 ⇒ 屏幕」的**唯一接口**. 位置**不重新算** ——
     * `center` 已由权威状态给出(上面那几行),这里只做「翻译成摆放参数」.
     *
     * 高度 = **地形那一格的高程**(与 `zAt` 表同源)+ **权威高度 `z`**:
     * 前者让玩家跟着地形起伏(而不是悬在一个固定平面上),后者让「跳起来 / 沉下去」
     * 在屏幕上**真的看得见** —— 接线前 `z` 没有任何读者,跳与站是同一张图且不报错.
     * 两件事都由纯函数 `placementForHeight` 合成:`z = 0` 时 `mount.sprite` 与 `base`
     * 的 `gx/gy/gz` **逐字段相同**(既有表现不变).
     *
     * `visible` 仍由 `playerMarkerPlacement` 决定:`center === null` ⇒ 不可见.
     * ⇒ 权威没到时**不画**,而不是画到世界原点(那会是一个看起来合法的错误位置).
     *
     * ⚠️ 本块**必须在相机块之前**:相机的高度分量要用**同一帧**的这份摆放结果
     * (`mount.cameraFocus.z`),放在后面等于给镜头引入一帧滞后。
     */
    /* ⚠️ 这一句的**字面形态**被 `tests/WS-09` 与 `tests/WS-FND-48` 钉住
       (`playerMarkerPlacement(center, zAt)`)⇒ 保留它:它就是**权威兜底**那条路,
       权威未知时(S1 之后)仍然只有这一句在决定"画不画"与"脚踩在哪格的高程上"。 */
    const base = playerMarkerPlacement(center, zAt);
    /* ── ★ WS-FND-113 第 2 处:**立牌画预测位置** ──
     *
     * 修前立牌只用 `base`(权威值)⇒ 玩家看到的位置比服务端**滞后一个 RTT**,
     * 而 `LocalPredictor.renderPos` / `visualOffset` 全仓**零读者** ——
     * "先剪再重演"与 SMOOTH 吸收在生产里一点都看不到(它们只是"存在")。
     *
     * `render` = 从权威值出发重演剩余命令后的位置 **+** 正在按指数收回的视觉偏移;
     * 所以画 `render` 才是"先剪再重演 + 视觉吸收"的**产物**,而不是权威值再抄一遍。
     *
     * `visible` 仍取**权威**那一份(`base.visible`):权威说"不知道"时不冒出一个
     * 预测位置上的立牌 —— 那会在死亡 / 退房时留下一块幽灵。
     * 高度仍取**权威** `z`:预测器不积分 z(`predictStep` 原样保留 z)⇒ 与
     * `predicted.render.z` 逐位相同,而"只有一个来源"因此仍然成立。
     */
    const baseShown = center !== null && predicted !== null
      ? playerMarkerPlacement({ cx: predicted.render.x, cy: predicted.render.y }, zAt)
      : base;
    const mount = placementForHeight({ x: baseShown.gx, y: baseShown.gy, z: playerGz }, baseShown.gz);
    /* ⚠️ 下面三行**刻意保留原来的字面写法**(`cell.gx/gy/gz` 与 `cell.visible`):
       `tests/WS-09` 用源码文本钉住「每帧写入立牌位置」与「可见性由 pure 层裁决」,
       它们守的正是「本块不许被绕过」。`cell.gz` 已含 z(`mount.sprite.z = base.gz + z`)。 */
    const cell = { gx: mount.sprite.x, gy: mount.sprite.y, gz: mount.sprite.z, visible: base.visible };
    playerMarker.position.set(cell.gx, cell.gy, cell.gz);
    playerMarker.visible = cell.visible;
    /* 本地玩家同样换成角色帧(需要图集与自己的 id 都到位)。 */
    if (playerMarker.userData.skinned !== true && propAtlasReady && propAtlasImg !== null
      && authority.localPlayerId !== '') {
      const skin = propMaterialOf(propAtlasImg, cellIndexFromId(characterAtlasId(authority.localPlayerId)));
      if (skin !== null) {
        playerMarker.material.dispose();
        playerMarker.material = skin;
        playerMarker.scale.set(CHARACTER_SIZE_WORLD, CHARACTER_SIZE_WORLD, 1);
      }
      playerMarker.userData.skinned = true;
    }
    /* ── ★ 第七轮审计 P1:野生 / 远端玩家的立牌,每帧按**同一份**权威快照对齐 ──
     *
     * 修前 `RoomState.wildlife` / 其他 `players` 在屏幕上**零输出**(只有本地 marker
     * 与 4 个固定图集立牌)⇒ 怪和队友都看不见,而没有任何断言会红。
     * 判定在 `stage/entity_sprites.planEntitySprites`(纯函数),这里只调一次。 */
    reconcileEntitySprites();

    /* ── ★ 相机跟随**权威位置**(WS-FND-23)──
     *
     * 这一块才是「角色不会走出画面」的**依据**(不再依赖按键):
     *   · 目标 = `playerGx/playerGy` —— 上面刚从 `telegraphCenterOf` 取到的**权威值**
     *     (权威未知时它保持上一帧 ⇒ 相机不会被拉到世界原点);
     *   · 推进 = `stepCamera`:指数平滑 + 距离超过 `CAMERA_SNAP_DISTANCE` 直接吸附。
     *     后者是**服务端纠偏 / 传送**要用的 —— 纯平滑要 ~1 秒才追上,表现为
     *     「角色被挪走了、画面还留在原地」。
     *
     * 判定全在 `net/camera_follow.ts`(纯函数 ⇒ `tests/WS-FND-23` 能在 node 里断言它),
     * 这里只剩调用点。
     *
     * 两个**显式**的例外(都默认关闭 / 只是临时,正常玩不经过):
     *   · `camOverride` —— 自检截图(`?at=` / `__uiDebug.teleport`)把相机停在指定点;
     *   · 指针按住拖动 —— 玩家自己看一眼四周;拖动期间暂停跟随,**松手即自动拉回玩家**
     *     (`client/index.html` 的「单指拖动视角」就指这个;归位不该要求玩家再按一次键)。
     *
     * `syncCamera()` 只在**真的动了**时调:收敛后每帧重建相机矩阵是纯浪费,
     * 而 1e-3 格 ≈ 0.016px —— 肉眼与投影都不可能察觉。
     * ★ WS-FND-48:那个「真的动了」现在还含**高度分量**,否则 `z` 的变化会被这个判断
     *   吞掉 —— 立牌抬起来了、镜头纹丝不动,且不报错。
     * ★ WS-FND-51:高度分量是**按 dt 推进**的(`stepCameraHeight`),不再直接赋值。
     *   直接赋值 = 同一帧内跳到目标高度(真浏览器里一次可见的「闪」)。
     */
    if (camOverride === null && drag === null) {
      /* 权威未知 ⇒ `cameraTargetFor` 给 null ⇒ 相机**保持不动**(不是跳到 (0,0)) */
      const target = cameraTargetFor(authoritySeen ? { x: playerGx, y: playerGy } : null, CAMERA_OPTS);
      if (target !== null) {
        const next = stepCamera(pan, target, dt / 1000, CAMERA_SMOOTHING_SEC);
        /* ★ WS-FND-51:高度分量在这里**按 dt 推进**(不再直接赋值)。
           时间步 = 本帧的 `dt / 1000`(与 `uiFsm.tick` / `updateRoof` 同一个来源,
           没有再引第二个时钟)。`dt ≤ 0` / 非有限时 `stepCameraHeight` **原样返回**。 */
        cameraFocusZTarget = mount.cameraFocus.z;
        const focusZPrev = cameraFocusZ;
        if (Math.abs(cameraFocusZTarget - cameraFocusZ) > 1e-3) {
          cameraFocusZ = stepCameraHeight(cameraFocusZ, cameraFocusZTarget, dt / 1000);
        } else if (cameraFocusZ !== cameraFocusZTarget) {
          /* 残差已 < 1e-3 格(≈0.016px,与上面那句同一个口径)⇒ 落定到目标。
             这一笔小到看不见,但它让「当下」**真的等于**目标:否则平滑值永远差最后
             一点点,`syncCamera()` 就会因为「高度还在动」被每帧叫醒。 */
          cameraFocusZ = cameraFocusZTarget;
        }
        /* 高度**当下值**真的变了也必须重建相机 —— 否则 z 的变化会被上面那个
           「相机没动」的判断吞掉(表现:立牌抬起来了、镜头纹丝不动,且不报错)。 */
        if (
          Math.abs(next.x - pan.x) > 1e-3
          || Math.abs(next.y - pan.y) > 1e-3
          || cameraFocusZ !== focusZPrev
        ) {
          pan.x = next.x;
          pan.y = next.y;
          syncCamera();
        }
      }
    }
    /* ── task-83 的立牌摆放**已上移**到相机块之前(★ WS-FND-48)──
     *
     * 它现在与 `playerGz` 的读取、`placementForHeight` 的合成紧挨在一起 —— 因为相机块的
     * **高度分量**必须用**同一帧**的摆放结果(`mount.cameraFocus.z`),
     * 留在原处会给镜头引入一帧滞后(60Hz 下 16ms 的抖动)。
     * 入口仍是同一句:`playerMarkerPlacement(center, zAt)`(高程来源没换)。 */
    updateRoof(dt / 1000);
    /* 把算出来的 alpha 真的喂给材质 —— 否则「淡出」只是内存里的一个数 */
    (roofMesh.material as THREE.MeshLambertMaterial).opacity = roofOpacity();
    /* 3. boss_hud:残影条按**权威**比例指数回落 —— 血量本身**不在这里改**
     *
     * 修前这里是两行本地伪造:
     * ```
     * bossGhost = Math.max(bossHp / boss.baseHp, bossGhost - dt/1000*0.06);
     * bossHp = Math.max(boss.baseHp*0.18, bossHp - dt/1000*baseHp*0.035);
     * ```
     * 血条因此自己慢慢往下走,与服务端 boss 的真实血量毫无关系(而且**永远**
     * 到不了 18% 以下 —— 看起来像"打不动")。现在 `bossHp` 这个名字已删除:
     * 血量每帧从 `bossView()` 读,这里只让**残影**(刚掉的那截血)平滑收拢。
     */
    {
      const bv = bossView();
      bossGhost = decayGhost(bossGhost, bv === null ? 0 : bv.ratio, dt / 1000);
    }

    /* ── ★ WS-FND-89:地形顶点色材质的矩阵上传 ──
     *
     * `syncCamera()` 只在相机**真的动了**时跑,但 uniform 是**每帧**都要最新的:
     * 放到 syncCamera 里会让「相机动了的第一帧」用上一帧的矩阵(表现为地形抖一下)。
     * 因此这里无条件调一次 —— O(1),与 `renderer.render` 同一帧、紧挨着它。
     */
    syncTerrainCamera(mat, camera);
    updateNameplates();
    renderer.render(scene, camera);

    /* ── 覆盖层:把上面各模块的状态画出来 ── */
    const st = uiState();
    const tg = telegraphGeometry();
    st.telegraphRing = tg.outer;
    st.telegraphInner = tg.inner;
    ui.draw(st);
    /* ── `#hint`:底部那行提示的**唯一**写点(缩放档位/搜索串/拖拽成交/派对比分)──
       放这里而不是在事件回调里:`#hint` 的内容是**状态的函数**(缩放、查询串、
       最近成交),散在回调里迟早有一条路径忘写 —— 那正是它此前"永不更新"的成因。 */
    paintHint();

    frames += 1;
    acc += dt;
    if (acc >= FPS_WINDOW_MS) {
      fps = (frames * 1000) / acc;
      hud.update(renderer.info, totalVerts, totalFaces, buildMs, fps);
      frames = 0;
      acc = 0;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  /* ── 自适应 ── */
  const onResize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    ui.resize(window.innerWidth, window.innerHeight);
    syncCamera();
  };
  window.addEventListener('resize', onResize);

  return {
    store: authority,
    /* ★ WS-FND-113:把预测姿态源接进来(`main.ts` 注入 `predictor.poseView`)。 */
    setPoseSource: (fn) => { poseSource = fn; },
    /* ★ 第七轮审计 P2:`main.ts` 的动作键监听靠它判断"现在是不是在打字" */
    textInputActive: () => searchMode,
    /* ★ WS-FND-151:模式面板的发文端口由 `main.ts` 注入(它持有 socket) */
    setPartyModeSink: (fn) => { partyModeSink = fn; },
    /* ★ WS-FND-166:触屏按钮条(手机没有键盘)—— 开合走**同一台**状态机。
       `togglePanel` 复用 `setPanel`(同键再按 = 关),不是另写一条开关路。 */
    togglePanel: (panel) => { setPanel(panel); },
    closePanel: () => { closePanel(); },
    uiHitAt: (x, y) => uiHitAt(x, y),
    /* ★ WS-FND-184:地形下行 → 建面的入口(`main.ts` 的 `onTerrain` 调它)。 */
    applyTerrainChunks: (next, dirtyKeys) => applyTerrainChunks(next, dirtyKeys),
    /* ★ WS-FND-188:NPC 表的入口(整表替换)与台词端口(`main.ts` 的两条注入,
       与 `setPoseSource` / `setPartyModeSink` 同一条手法)。 */
    setNpcs: (npcs) => { setNpcs(npcs); },
    showTalk: (text) => { showTalk(text); },
    summary: () => ({
      cells: WORLD_CELLS,
      chunks: meshes.size,
      verts: totalVerts,
      faces: Math.round(totalFaces),
      buildMs: Math.round(buildMs * 10) / 10,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: Math.round(fps),
      running: raf !== 0,
      /* ── ★ WS-FND-184:地形来源与三个重建读数 ──
       *
       * 四个数分开读,才分得清三种坏法:
       * ```text
       * terrainSource === 'design' 且 terrainApplyCalls === 0
       *     ⇒ 一帧服务器地形都没到(屏幕上画的是本地设计图);

       * terrainApplyCalls > 0 而 terrainRebuilt === 0
       *     ⇒ 帧到了但一块都没重建(键口径对不上 / 脏标记被别处清掉了);
       * terrainDisposed === terrainRebuilt
       *     ⇒ 每次重建都真的释放了旧几何(缺 dispose 时它恒 0 —— 就是漏显存的那个形态)。
       * ```
       * 没有这四个数,"地形到底来自服务器还是本地"只能靠肉眼看画面。
       */
      terrainSource: terrainFromServer ? TERRAIN_SOURCE_SERVER : TERRAIN_SOURCE_DESIGN,
      terrainApplyCalls,
      terrainRebuilt: terrainRebuiltChunks,
      terrainDisposed: terrainDisposedGeoms,
      /* ── task-67 阶段 3:权威位置自检口径 ──
         截图/自检脚本靠这三个字段判断「玩家位置是不是真的来自服务端」,
         而不是只看"画面看起来在动"(那是本地推测,不是权威)。 */
      authoritySeen,
      authorityTick: authority.state.meta.tick,
      playerGx,
      playerGy,
      authoritativeCenter: telegraphCenterOf(authority.state, authority.localPlayerId),
      authorityDecodeErrors: authority.decodeErrors,
      authorityEmptyFrames: authority.emptyFrames,
      /* ── ★ WS-FND-23 相机跟随自检口径 ──
       *
       * 让「相机是否真的跟着权威位置」**可被读出来**,而不是靠看图说"看着对":
       *   `cameraFocus`     相机现在对准哪(每帧被 `stepCamera` 推进)
       *   `cameraTarget`    这一帧的目标(= 权威位置经边界夹紧;权威未知为 `null`)
       *   `cameraLagCells`  落后多少格 —— 稳态应 ≈ v×smoothing(步行约 0.5 格);
       *                     一次巨大的落后只可能来自传送,而那种情况被 `stepCamera`
       *                     **一步吸附**(见 `CAMERA_SNAP_DISTANCE`)
       *
       * ⚠️ 两个位置**分别**报,才分得清两种不同的坏法:
       *   「目标对、聚焦点不收敛」= 跟随坏了;
       *   「目标为 null」= 权威还没到(此时相机**故意**不动,不是缺陷)。
       */
      cameraFocus: { x: pan.x, y: pan.y },
      cameraTarget: cameraTargetFor(authoritySeen ? { x: playerGx, y: playerGy } : null, CAMERA_OPTS),
      cameraLagCells: Math.round(Math.hypot(playerGx - pan.x, playerGy - pan.y) * 1000) / 1000,
      /* ── ★ 第六轮审计 P2:缩放档位自检口径 ──
       * `isoCam.zoom` 修前**只有读点没有写点** ⇒ `ZOOM_LEVELS` 的 6 档在生产里
       * 根本不存在。三个字段一起读才分得清两种坏法:
       *   `zoom` 变了而 `zoomPixels` 没变 ⇒ 只写了数字,没重建相机(画面不动);
       *   `zoomLevels` ≠ 6 ⇒ 档位表被改了(判据会红)。 */
      zoom: isoCam.zoom,
      zoomLevels: ZOOM_LEVELS.length,
      zoomPixels: Math.round(isoCam.scale * isoCam.zoom * 1000) / 1000,
      hintText: lastHint,
      /* ── ★ WS-FND-48 高度轴(`z`)自检口径 ──
       *
       * 让「z 真的被用起来了」**可被读出来**,而不是靠看图说"看着抬起来了":
       *   `playerGz`           权威高度(入参)
       *   `cameraFocusZTarget` 本帧的**目标**(= clamp(z × 0.5, ±1);随 z 直接变)
       *   `cameraFocusZ`       **当下**的聚焦高度(每帧被 `stepCameraHeight` 推向目标)
       *   `playerMarkerPos.z`  立牌的世界 z(= 地形高程 + z;上面已有该字段)
       *
       * ★ WS-FND-51:目标与当下**两个都报** —— 只报一个会把「镜头正在平滑地追」
       * 误读成「镜头没跟上」(`cameraFocusZ` 在 z 突变的头几帧**故意**不等于目标),
       * 而只报当下又看不出「这一帧该到哪」。两者之差才是「还在不在追」。
       *
       * 三者一起读才分得清三种坏法:
       *   `playerGz ≠ 0` 而 `playerMarkerPos.z` 没变 ⇒ 高度根本没接线(本任务要抓的那类);
       *   `playerGz ≠ 0` 而两个 `cameraFocusZ*` 恒 0 ⇒ 只接了立牌、漏了相机;
       *   两个都是 0 而 `playerMarkerPos.z` == 地形高程 ⇒ 正常(z = 0,接线前表现)。
       */
      playerGz,
      cameraFocusZTarget,
      cameraFocusZ,
      cameraFollowSmoothingSec: CAMERA_SMOOTHING_SEC,
      cameraSnapDistanceCells: CAMERA_SNAP_DISTANCE,
      cameraOverride: camOverride,
      /* ── task-83 玩家可见物自检口径 ──
       *
       * 这三个字段的作用与上面 `authoritySeen` 那一组**不同**:
       * 那一组证明「权威位置到了」,这一组证明「权威位置**被画出来了**」——
       * 两者是两件事,本仓此前只有前者(所以才会出现「位置拿到了但没画」).
       *
       * `playerMarkerVisible` 与 `playerMarkerPos` 一起读才有意义:
       *   visible=false 且 pos 是 (0,0,0) ⇒ 权威还没到(正常)
       *   visible=true  且 pos ≠ 权威位置 ⇒ **接线断了**(这是要抓的那类缺陷)
       */
      playerMarkerName: playerMarker.name,
      playerMarkerVisible: playerMarker.visible,
      playerMarkerPos: {
        x: playerMarker.position.x,
        y: playerMarker.position.y,
        z: playerMarker.position.z,
      },
      /* ── ★ WS-FND-113 第 2 处:预测消费自检口径 ──
       * 三者一起读才分得清两种坏法:
       *   `poseSourceInstalled=false` ⇒ 渲染**根本没接**预测(第 2 处复发);
       *   `predictedRender=null` 而 `installed=true` ⇒ 权威还没到(正常,兜底生效)。
       * `predictedVisualOffset>0` 是"平滑吸收正在发生"的**唯一**可读证据 ——
       * 少了它,SMOOTH 那一档在生产里是否跑过就只能靠读代码。 */
      poseSourceInstalled: poseSource !== null,
      predictedRender: lastPredicted === null ? null : lastPredicted.render,
      predictedLogical: lastPredicted === null ? null : lastPredicted.logical,
      predictedVisualOffset: lastPredicted === null ? null : lastPredicted.visualOffset,
      /* ── 图集自检口径:截图脚本靠这几个字段判断「真图 vs 占位」── */
      atlasOk,
      atlasErr,
      spriteCount: sprites.length,
      /* ★ w90:世界里的**东西**摆了几个(obj 立牌 + 植被)。
         没有这个读数,「网页上一棵树都没有」与「摆了 600 个但全被预算截断」
         在外部读数上**完全一样** —— 而后者正是最该被发现的那种静默。
         ★ WS-FND-188:下面四个数一起读,才分得清"立牌没跟块"的三种坏法:
         ```text
         propChunkCount === 0            ⇒ 立牌表是**空**的(不是"没画,是没登记")
         propRemovedChunks === 0 而地形重建过 ⇒ 跟块这条链断了(旧立牌留在场景里)
         propDroppedByBudget > 0          ⇒ 场景里少于计划(预算截断,不是"没有东西")
         ``` */
      propSpriteCount: propSpriteTotal,
      propChunkCount: propChunks.size,
      propRemovedChunks,
      propDroppedByBudget,
      propBudget: SPRITE_BUDGET,
      /** 立牌表为空 ⇒ **看得见**(改前"空表"与"没接线"在读数上同形)。 */
      propTableEmpty: propChunks.size === 0,
      /* ── ★ WS-FND-188:NPC 自检口径(「看得见 + 能对话」两条都要读得出来)──
       * ```text
       * npcCount        服务端下发了几个 NPC(0 = 那一帧没到 —— 与"这个世界没有 NPC"不同)
       * npcSpriteCount  场景里真的有几个 NPC 立牌(0 而 npcCount > 0 ⇒ 表到了但没画)
       * npcAtlasCell    NPC 用的图集格(-1 = 图集里没有 ⇒ 一个都画不出来,且**不报错**)
       * nearbyNpcId     离玩家最近的、在半径内的那个(空 = 附近没人)
       * npcHintLine     HUD 那一行(空 = 附近没人,不是"没接线")
       * npcTalkLine     最近一句台词(空 = 还没说过话)
       * ```
       * ⚠️ 一个数都不报的话,「NPC 上屏了没」只能靠肉眼看画面 —— 而那正是本任务要消灭的形态。 */
      npcCount: npcList.length,
      npcSpriteCount: npcSprites.size,
      npcAtlasCell: cellIndexFromId(NPC_SPRITE_ITEM_ID),
      npcTextureItemId: NPC_SPRITE_ITEM_ID,
      npcSpriteOps: { ...npcSpriteOps },
      nearbyNpcId: (nearbyNpc(npcList, playerGx, playerGy)?.id) ?? null,
      npcHintLine: npcHintLine(nearbyNpc(npcList, playerGx, playerGy)),
      npcTalkLine,
      npcPlacements: planNpcSprites(npcList).map((p) => ({
        id: p.id, x: p.x + 0.5, y: p.y + 0.5, atlasCell: p.atlasCell,
      })),
      spriteIds: sprites.map((s) => s.name),
      /* 锚点实测值:必须是 0.15(不是 0.85),差 0.70 会让立牌陷进地里 */
      spriteCenterY: sprites[0]?.center.y ?? null,
      /* 精灵在**世界单位**里的边长 —— 必须 ≈1.561(64/41),不是 24.98 */
      spriteWorldSize: SPRITE_CELL_WORLD,
      spriteScaleX: sprites[0]?.scale.x ?? null,
      atlasCell: ATLAS_CELL,
      atlasPxPerCell: ATLAS_PX_PER_CELL,
      atlasImage: [ATLAS_IMAGE_W, ATLAS_IMAGE_H],
      /* 每个立牌的世界坐标与投影后屏幕坐标 —— 用于验证「脚踩在格子上」 */
      spritePlacements: sprites.map((s) => ({ name: s.name, x: s.position.x, y: s.position.y, z: s.position.z })),
      /**
       * **脚底对齐的独立可验证据**。
       *
       * 每个立牌的锚点(即图集里脚底所在的那个点)过 `camera.project` 得到的
       * **屏幕像素坐标**。截图脚本会在这些像素上画十字准星:
       *
       * - 准星来自「地形格 → 世界坐标 → 相机投影」这条路径;
       * - 精灵的脚来自「图集纹理 → three 的 Sprite 管线」这条路径。
       *
       * 两条路径互相独立,若在像素上重合,就说明脚确实踩在格子上 ——
       * 这比「看着像对齐」强,也能抓住锚点方向写反这类静默错误
       * (写反时脚会整体下沉 `0.70 × 精灵高 ≈ 1.09` 世界单位,准星会跑到头顶)。
       *
       * `position` 本身就是图集锚点落点:three 的 sprite 顶点计算
       * `transformed.xy -= center` 把 `center` 那一点对齐到 `position`,
       * 而 `center.y = 1 - 0.85 = 0.15` 正是「距底 15%」——
       * 图集里脚底也在距底 15% 处,两者相消,故脚底 = `position`。
       */
      footScreen: sprites.map((s) => {
        const v = s.position.clone().project(camera);
        return {
          name: s.name,
          /* NDC → CSS 像素;窗口尺寸即 canvas 的 CSS 尺寸(不乘 devicePixelRatio) */
          px: Math.round(((v.x + 1) / 2) * window.innerWidth * 10) / 10,
          py: Math.round(((1 - v.y) / 2) * window.innerHeight * 10) / 10,
        };
      }),
      viewport: [window.innerWidth, window.innerHeight],

      /* ══════════ 8 个模块的「浏览器里真的生效了」的证据 ══════════
       *
       * 只证明 import 成功是不够的 —— 这些字段每个都取自**模块的实际输出**,
       * 截图/CDP 脚本据此判断「接线生效」而不是「文件被引用」。
       */
      wiring: {
        /* state_machine:状态与迁移序号来自状态机本身 */
        stateMachine: {
          state: uiFsm.state,
          panel: uiFsm.activePanel,
          revision: uiFsm.revision,
          transitionSeq: uiFsm.transitionSeq,
          acceptsInput: uiFsm.acceptsInput,
          openingProgress: Math.round(uiFsm.openingProgress * 100) / 100,
          lastTransition: uiFsm.transitionLog[uiFsm.transitionLog.length - 1] ?? null,
        },
        /* inventory:格子数与分类数来自 buildView() */
        inventory: {
          slots: invView.slots.filter((s) => s.visible).length,
          page: invView.page,
          pageCount: invView.pageCount,
          buckets: invView.buckets.length,
          activeCategory: invCategory,
          filledRatio: Math.round(usedSlotRatio(invView.visibleCount) * 1000) / 1000,
          /* ★ 第六轮审计 P3:搜索与拖拽成交都必须是**读数**。
             `invQuery` 修前恒 `''`(没有任何键能写它)⇒ 搜索不可达;
             `lastMove` 修前不存在(`drop()` 零调用)⇒ "拖拽能不能搬东西"读不出来。 */
          query: invQuery,
          searchMode,
          lastMove,
          /* ★ 第七轮审计 P1:`lastMove` 只是**文案** —— 文案对了格子仍可能没动(修前就是这样)。
             成交次数与格位指纹一起读,才分得清"提示变了"与"背包真的搬了"。 */
          slotMoves: slotMoveCount,
          slotFingerprint: slotFingerprint(slotItemIds),
          /* `UiOverlay.invLayout` 的读点:命中测试与绘制共用同一份布局,这里把它的
             实际几何报出来(自检可据此判断"格子是不是按布局画的")。 */
          layout: {
            cols: ui.invLayout.cols,
            rows: ui.invLayout.rows,
            cell: ui.invLayout.cell,
            pageSlots: ui.invLayout.cols * ui.invLayout.rows,
          },
          /* `UiOverlay.hasAtlas`:图集真的挂上去了吗(没有时格子画的是色块占位) */
          atlasReady: ui.hasAtlas,
        },
        /* ── ★ 第七轮审计 P1:实体渲染(野生 / 远端玩家)──
         *
         * 修前这一块**完全不存在**:`wildlife` 与别的玩家在屏幕上零输出,
         * 而 `spriteCount` 只数那 4 个固定图集立牌 ⇒ 自检读起来一切正常。
         * 三个数必须**分开**报:`wildlife` 与远端玩家是两条不同的数据源,
         * 混成一个数就分不清"只接了怪"还是"只接了队友"。
         * `spawns/moves/removes` 是累计操作数 —— `moves === 0` 而 `wildlife > 0`
         * 说明计划里有人、但场景里没动过(又是"算好了没人画")。
         */
        entities: {
          wildlife: entityPlan.wildlife,
          players: entityPlan.players,
          total: entityPlan.total,
          sceneSprites: entitySprites.size,
          keys: [...entitySprites.keys()].slice(0, 8),
          spawns: entitySpriteOps.spawns,
          moves: entitySpriteOps.moves,
          removes: entitySpriteOps.removes,
        },
        /* recipe_tree:节点数/叶子数/缺料提示来自 buildRecipeTree + checkCraft */
        recipe: recipeTree
          ? {
            rootId: recipeTree.root.itemId,
            nodeCount: recipeTree.nodeCount,
            leafKinds: recipeTree.leaves.size,
            stations: recipeTree.stations.slice(),
            maxDepth: recipeTree.maxDepth,
            note: recipeNote,
            craftable: recipeNote === '',
          }
          : null,
        /* boss_hud:血条/阶段/预警几何**全部**来自权威快照(`bossHudFrom`);
         * `layoutHpBar` 只把那份视图排成条(`layoutHpBar(baseHp, hp, w, phases)`)。
         * ★ 第六轮审计 P1:修前这里的 `hp` 是本地伪造值 —— 自检脚本读到的
         * "血条比例"与房间真实血量无关,于是「血条没接上」在自检口径里也看不出来。 */
        bossHud: (() => {
          const bv = bossView();
          if (bv === null) return null;
          const L = layoutHpBar(bv.baseHp, bv.hp, window.innerWidth, bv.phases);
          const tg = telegraphGeometry();
          return {
            id: bv.id,
            bossId: bv.bossId,
            name: bv.name,
            hp: Math.round(bv.hp),
            baseHp: bv.baseHp,
            ratio: Math.round(bv.ratio * 1000) / 1000,
            ticks: L.ticks.length,
            barWidth: L.width,
            /* 阶段名/索引来自**线上** boss 实体(不是按血条刻度重算) */
            phaseName: bv.phaseName,
            phaseIndex: bv.phaseIndex,
            /* 预警几何来自线上 `telegraphShape/X/Y/R` 的映射结果(`null` = 无预警) */
            telegraphShape: bv.telegraph === null ? null : bv.telegraph.shape,
            telegraphRadius: bv.telegraph === null ? 0 : bv.telegraph.radius,
            /* 环:外圈 + 内圈顶点数都要 > 0,否则退化成实心盘 */
            telegraphOuter: tg.outer.length,
            telegraphInner: tg.inner.length,
            telegraphVertices: tg.vertices,
            ringOnScreen: tg.outer.some((p) => p.x > 0 && p.x < window.innerWidth && p.y > 0 && p.y < window.innerHeight),
          };
        })(),
        /* party_hud:派对模式 / 剩余秒数 / 双方比分 —— 四个 `meta` 字段的**读者**。
         * ★ 第六轮审计 P1:修前 `client/src` 里这四个字段命中 0 ⇒ 派对/比分永不上屏。 */
        party: (() => {
          const p: PartyHudView = partyHudOf(authority.state.meta);
          return {
            mode: p.mode,
            modeName: p.modeName,
            active: p.active,
            timer: Math.round(p.timer * 10) / 10,
            scoreA: p.scoreA,
            scoreB: p.scoreB,
            text: p.text,
          };
        })(),
        /* ★ WS-FND-151:模式面板 + 急行开工条件 —— 让"面板列了几档 / 选中发了没 /
         * 三条前置各是什么态"在自检口径里**可读**,而不是只能靠看图。 */
        partyPanel: (() => {
          const p = partyPanelOf(authority.state.meta, partyCursor);
          return {
            total: PARTY_MODE_COUNT,
            rows: p.rows.length,
            cursor: p.cursor,
            currentMode: p.currentMode,
            currentName: p.currentName,
            selectedKey: p.selected === null ? null : p.selected.key,
            note: partyModeNote,
            open: uiFsm.activePanel === UiPanel.PARTY,
          };
        })(),
        rush: (() => {
          const r = rushReadinessOf(rushAuthorityInput(), RUSH_SNAPSHOT_GAP);
          return {
            total: r.total,
            met: r.met,
            unmet: r.unmet,
            unknown: r.unknown,
            text: r.text,
            states: r.rows.map((x) => `${x.id}:${x.state}`),
            note: r.note,
          };
        })(),
        /* 接线台账(生产读点):哪些装配函数**仍未接**、每条的原因在
         * `client/src/wiring_ledger.ts`。`ok === false` 表示台账自己前后矛盾
         * (比如把还没接的东西标成 wired)—— 那时自检一眼可见。 */
        ledger: (() => {
          const v = validateLedger();
          return {
            entries: WIRING_LEDGER.length,
            blocked: WIRING_LEDGER.filter((e) => e.status === 'blocked').map((e) => e.symbol),
            ok: v.ok,
            errors: v.errors.slice(0, 3),
          };
        })(),
        /* audio:唤醒状态与已播放音符数 */
        audio: {
          awake: audioOut.awake,
          playedNotes: audioOut.playedCount,
          /* 引擎的原始 state —— 与 awake 分开报,便于区分
             「没接线」/「接线了但浏览器拒绝播放」两种不同的失败 */
          contextState: audioOut.contextState,
          contextAvailable: typeof (window as unknown as { AudioContext?: unknown }).AudioContext === 'function',
        },
        /* roof_transparency:连通域数、激活分片、当前 alpha */
        roof: {
          components: roofComponents.count,
          roofCells: buildRoofMask(roofMask.tiles, roofMask.W, roofMask.W).roofCells,
          /** 屋顶网格真的建出来了吗(顶点数 = 0 说明没画出来) */
          meshVertices: roofVertexCount,
          /** 实际喂给材质的透明度 —— 不是内存里的中间量 */
          materialOpacity: Math.round((roofMesh.material as THREE.MeshLambertMaterial).opacity * 1000) / 1000,
          visible: roofMesh.visible,
          activeComponent: roofActive,
          activeAlpha: Math.round(roofAlphaOf(roofActive) * 1000) / 1000,
          version: roofVersion,
          /** 全部屋顶分片的 alpha(供脚本断言「走进屋顶后确实变透明了」) */
          alphas: roofFades.map((f) => Math.round(roofAlphaOf(f.component) * 1000) / 1000),
        },
        /* pixel_easel:覆盖度/撤销栈来自画架本身 */
        easel: {
          coverage: Math.round(easel.coverage() * 1000) / 1000,
          undoCount: easel.undoCount,
          redoCount: easel.redoCount,
          paletteIndex,
          pixelsPainted: easel.toIndices().filter((v) => v >= 0).length,
        },
        /* blueprint:最近一次框选的结果来自 collectBlueprint */
        blueprint: {
          note: bpSummary,
          filled: bpCells,
          active: bpDrag !== null,
        },
        /* 音高砖:掩码与已选档数 */
        pitch: {
          mask: pitchMask,
          selected: popcount32(pitchMask),
          brickRows: PITCH_BRICK_ROWS,
          brickCols: PITCH_BRICK_COLS,
          firstBrick: pitchBrickPosition(0),
          lastIndex: pitchBrickIndex(PITCH_BRICK_ROWS - 1, PITCH_BRICK_COLS - 1),
        },
      },
    }),
    dispose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      /* 无 keyup 监听:相机不再由按键驱动(WS-FND-23) */
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', onResize);
      cv.removeEventListener('pointerdown', onPointerDown);
      ui.dispose();
      audioOut.dispose();
      /* ⚠️ `meshes` 是 Map(key → mesh)⇒ 必须走 `values()`;
         写成 `for (const m of meshes)` 会拿到 `[key, mesh]` 对,`geometry` 就成了 undefined。 */
      for (const m of meshes.values()) m.geometry.dispose();
      meshes.clear();
      terrainStats.clear();
      for (const s of sprites) {
        s.material.map?.dispose();
        s.material.dispose();
      }
      /* ★ 第七轮审计 P1:实体立牌也是场景里的对象 —— dispose 不摘它们,
         `__stageReady` 与截图脚本会读到一个已经不存在的渲染器上的残留精灵。 */
      for (const sp of entitySprites.values()) {
        scene.remove(sp);
        sp.material.dispose();
      }
      entitySprites.clear();
      /* ★ WS-FND-188:立牌(按块分组)与 NPC 立牌也是场景对象 ⇒ 一并摘干净。
         ⚠️ **材质只释放一次**:`propMaterials` 是按图集格缓存、被多个立牌共享的
         —— 逐个 Sprite `material.dispose()` 会在第二个立牌上 dispose 同一份材质
         (three 报不报错取决于时机,而"黑块"/残留是最常见的表现)。 */
      for (const list of propsByChunk.values()) for (const sp of list) scene.remove(sp);
      propsByChunk.clear();
      propChunks.clear();
      propSpriteTotal = 0;
      for (const sp of npcSprites.values()) scene.remove(sp);
      npcSprites.clear();
      for (const m of propMaterials.values()) {
        m.map?.dispose();
        m.dispose();
      }
      propMaterials.clear();
      mat.dispose();
      renderer.dispose();
    },
  };
}

/** 掩码里 1 的个数(音高砖已选档数) */
function popcount32(mask: number): number {
  let n = 0;
  let m = mask >>> 0;
  while (m !== 0) {
    m &= m - 1;
    n += 1;
  }
  return n;
}

interface Hud {
  update: (info: THREE.WebGLInfo, verts: number, faces: number, buildMs: number, fps: number) => void;
  /**
   * ★ WS-FND-184:地形规模与**来源**会在地形下行**之后**变(`applyTerrainChunks`)。
   *
   * 规模那行必须跟着变,否则 HUD 永远写着设计图的「192×192 格 / 144 chunk」——
   * 与 w85 那次「标签与实际不符」是同一个病(那一轮修过一遍,这里只是把
   * "地形来源换成服务器"这条新的变化也接上)。
   */
  setWorld: (cells: number, chunkCount: number, source: string) => void;
}

function makeHud(container: HTMLElement, world?: { cells: number; chunks: number }): Hud {
  const wrap = document.createElement('div');
  /* 给个 id:自检脚本要临时藏掉它再做像素差分。
     HUD 里的 FPS 每帧都在变,不藏掉整块 HUD 都会被算成「差异像素」,
     实测过一次 —— 把立牌的测高污染成 480+px。 */
  wrap.id = 'hud';
  wrap.style.cssText = 'position:fixed;top:10px;left:10px;z-index:10;'
    + 'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#e8eefc;'
    + 'background:rgba(18,24,38,.82);padding:8px 11px;border-radius:7px;'
    + 'border:1px solid rgba(120,150,210,.28);pointer-events:none;white-space:pre;';
  const fpsEl = document.createElement('div');
  fpsEl.textContent = 'FPS --';
  const statsEl = document.createElement('div');
  statsEl.style.cssText = 'color:#8fa6c8;margin-top:3px;';
  wrap.append(fpsEl, statsEl);
  container.appendChild(wrap);
  /* ★ WS-FND-184:这三个数**可变** —— 地形从设计图占位换成服务器块之后由 `setWorld()`
     改写,`update()` 读的是同一组变量(一处来源,不造第二份状态)。 */
  let cells = world?.cells ?? WORLD_CELLS;
  let chunkCount = world?.chunks ?? WORLD_CHUNKS ** 2;
  let terrainSource = TERRAIN_SOURCE_DESIGN;
  return {
    setWorld: (nextCells, nextChunks, nextSource) => {
      cells = nextCells;
      chunkCount = nextChunks;
      terrainSource = nextSource;
    },
    update: (info, verts, faces, buildMs, fps) => {
      fpsEl.textContent = `FPS ${fps.toFixed(0)}`;
      /* ★ w85:地形规模必须**读真实 chunk 列表**,不许拿 `demo_world` 的常量拼。
         改前这里写的是 `WORLD_CELLS` / `WORLD_CHUNKS ** 2`(= 64×64 / 16),
         而实际画的是设计图的 12×12=144 块 ⇒ **屏幕上那行数字是假的**
         (实测:世界已经是 192×192,UI 仍报「地形 64×64 格 / 16 chunk」)。
         这种「标签与实际不符」不会报错,只会让人以为地图还是小的。
         缺省仍回落到旧常量:`makeHud` 的独立自检调用点不传 `world`。 */
      /* 上一段注释里的「读真实 chunk 列表」在这里落地:数来自 `world`(启动时)或
         `setWorld()`(地形下行之后),**不是**常量拼的。 */
      /* ★ WS-FND-184:来源那一行**如实**只分两档 —— 服务器块**到了**就是 server。
         ⚠️ 块是分批下的(8 块/帧),所以"来源 = server"的头几帧里,屏幕上**仍混着**
            还没被替换的设计图占位块。精确数字不在 HUD(它只有两档),而在
            `__stageReady` 的 `lastTerrainNote`(本帧重建几块)与 `summary()` 的
            `terrainRebuilt` / `terrainApplyCalls` —— 那里才分得清"到了几块"。 */
      statsEl.textContent = `地形 ${cells}×${cells} 格 / ${chunkCount} chunk\n`
        + `顶点 ${verts.toLocaleString()} / 面 ${Math.round(faces).toLocaleString()}\n`
        + `draw call ${info.render.calls} / 三角形 ${info.render.triangles.toLocaleString()}\n`
        + `地形来源 ${terrainSource === TERRAIN_SOURCE_SERVER ? '服务器块' : '设计图占位(还没收到服务器块)'}\n`
        + `建面 ${buildMs.toFixed(1)} ms`;
    },
  };
}