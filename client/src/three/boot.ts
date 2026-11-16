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
import { createCamera, type IsoCamera, Z_Y_PER_LEVEL } from '../stage/iso_camera.ts';
import { buildChunkGeometry, buildOrthographicCamera } from './stage_assembly.ts';
import { makeDemoWorld, WORLD_CELLS, WORLD_CHUNKS } from '../stage/demo_world.ts';
import { CHUNK_SIZE, ELEV_TO_Z } from '../stage/tile_mesh.ts';
import { packTile, unpackTile } from '../../../shared/types/tile.ts';
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
  buildView,
  usedSlotRatio,
} from '../ui/inventory.ts';
import {
  type RecipeTree,
  buildRecipeTree,
  checkCraft,
  missingReport,
} from '../ui/recipe_tree.ts';
import {
  buildTelegraph,
  layoutHpBar,
  type TelegraphSpec,
} from '../ui/boss_hud.ts';
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
import { UiOverlay, type UiDrawState, type UiHit } from './ui_binding.ts';
import { createAudio, type AudioHandle } from './audio_out.ts';
/* task-67 阶段 3:玩家位置改由**权威状态**提供(不再从 `pan` 抄,见 S1 注释)。
   这两个模块都**纯**(零三方、零 DOM)⇒ 可被 WS-12 直接 import 断言。 */
import { ClientStateStore } from '../net/state_store.ts';
import { telegraphCenterOf } from '../net/telegraph_center.ts';
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
     不显式搬过去视野会偏到边上(实测偏右下)。 */
  isoCam.focusX = WORLD_CELLS / 2;
  isoCam.focusY = WORLD_CELLS / 2;
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
  const chunks = makeDemoWorld();
  const meshes: THREE.Mesh[] = [];
  let totalVerts = 0;
  let totalFaces = 0;

  /* 单一材质:所有 chunk 共用,是减少 draw call 的前提 */
  const mat = new THREE.MeshLambertMaterial({ color: 0x9fd6a0 });

  for (const chunk of chunks) {
    /* 顶点由纯逻辑层 `stage/chunk_geometry` 产出,与计数同源 */
    const geom = buildChunkGeometry(chunk, 0);
    totalVerts += geom.getAttribute('position').count;
    totalFaces += (geom.getIndex()?.count ?? 0) / 6;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = chunk.key;
    scene.add(mesh);
    meshes.push(mesh);
  }
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
  const hud = makeHud(container);

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
   * 调用点:`refreshInventory()` → `buildView()`,每帧被 `UiDrawState.view` 消费 */
  let invQuery = '';
  let invCategory: string | null = null;
  let invPage = 0;
  let invView: InventoryView = buildView({ page: 0 });
  const refreshInventory = (): void => {
    invView = buildView({ page: invPage, category: invCategory, query: invQuery, sort: SortKey.SLOT });
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
   * 调用点:`layoutHpBar()` 在 `ui_binding.drawBoss()`;`buildTelegraph()` 在 `telegraphRing()` */
  const boss = BOSS_LIST[0] ?? null;
  let bossHp = boss ? boss.baseHp : 0;
  let bossGhost = 1;
  /** Boss 是否在场(按 B 键召唤/遣返,用来验证 HUD 真的会出现/消失) */
  let bossActive = false;

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
  const CAMERA_BOUNDS = { minX: 0, minY: 0, maxX: WORLD_CELLS, maxY: WORLD_CELLS };
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

  /* ── 组装一帧的 UI 绘制状态 ── */
  const uiState = (): UiDrawState => ({
    panel: uiFsm.activePanel,
    openProgress: uiFsm.state === 'OPEN' ? 1 : uiFsm.openingProgress,
    dragging: dragCtl.isDragging,
    hoverSlot: dragCtl.hover,
    view: invView,
    activeCategory: invCategory,
    recipe: recipeTree,
    recipeId: RECIPE_ID,
    recipeBatches: RECIPE_BATCHES,
    recipeNote,
    easel,
    paletteIndex,
    pitchMask,
    boss: bossActive ? boss : null,
    bossHp,
    bossGhost,
    telegraphNote: bossActive && boss ? String(boss.phases[0]?.telegraph ?? '') : '',
    blueprintNote: bpSummary,
    /* ★ 提示行说清"谁动"与"谁跟":WASD 动的是**角色**,相机是**跟随** ——
       接线前这里写的是「WASD 平移」,那句话现在是错的,而错文案没人会去测。 */
    keysHint: 'I 背包 · R 配方 · E 画架 · P 音高 · B Boss · 拖拽框选蓝图 · WASD 移动角色(相机跟随)',
  });

  /** 预警圈屏幕坐标:交 `boss_hud.buildTelegraph` 算,本层只取结果 */
  const telegraphGeometry = (): { outer: { x: number; y: number }[]; inner: { x: number; y: number }[]; vertices: number } => {
    if (!bossActive || !boss) return { outer: [], inner: [], vertices: 0 };
    const spec: TelegraphSpec = {
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
          dragCtl.pickUp(hit.slot, sl.item.id, 1);
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
      }
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
    if (dragCtl.isDragging) dragCtl.cancel();
  };

  /* ── 键盘:只剩面板/画架/Boss 快捷键 ──
   *
   * ★ WS-FND-23:这里**曾经**还维护一个 `keys` 集合,给渲染循环读去做相机平移。
   *   那条路已删(相机现在跟权威位置走,见 `net/camera_follow.ts`),
   *   `keys` 于是变成"只写不读"的死状态 ⇒ 一并删掉,不留一个看起来还在用的变量。
   *   WASD 的去向完全在 `main.ts` 的输入链路里(`InputSource` → `predictor` → 上行)。
   * ⚠ `pan` / `dragCtl` 已在上面的 UI 运行时块中声明(那里要先用)——
   * 这里**不要**再声明一次,否则是重复定义。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    /* 面板快捷键 —— **走 state_machine 的合法迁移**,不是自己存字符串。
     * 这里也是 `state_machine` 的最直接接入点:按 I 打开背包,再按 I 关闭。 */
    switch (e.key.toLowerCase()) {
      case 'i': setPanel(UiPanel.INVENTORY); break;
      case 'r': setPanel(UiPanel.RECIPE_TREE); break;
      case 'e': setPanel(UiPanel.PIXEL_EASEL); break;
      case 'p': setPanel(UiPanel.PITCH_EDITOR); break;
      case 'b':
        /* Boss 召唤/遣返 —— 用来验证 boss_hud 真的会出现/消失 */
        bossActive = !bossActive;
        if (bossActive) bossHp = boss ? boss.baseHp : 0;
        clickSound();
        break;
      /* 画架工具键(仅画架打开时有效) */
      case 'z': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.undo(); break;
      case 'y': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.redo(); break;
      case 'x': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.clear(); break;
      case 'c': if (uiFsm.activePanel === 'PIXEL_EASEL') easel.floodFill(8, 8, paletteIndex); break;
      case 'escape': if (uiFsm.state !== 'CLOSED') uiFsm.transition('CLOSED', 'escape'); break;
      default: break;
    }
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

    /* ── task-83 + ★ WS-FND-48:把玩家画出来,并让它跟着 20Hz 快照动 ──
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
    const base = playerMarkerPlacement(center, zAt);
    const mount = placementForHeight({ x: base.gx, y: base.gy, z: playerGz }, base.gz);
    /* ⚠️ 下面两行**刻意保留原来的字面写法**(`cell.gx/gy/gz` 与 `cell.visible`):
       `tests/WS-09` 用源码文本钉住「每帧写入立牌位置」与「可见性由 pure 层裁决」,
       它们守的正是「本块不许被绕过」。⇒ 把合成结果**折回** `cell` 的字段名,
       而不是去改那条判据。`cell.gz` 里已经含了 `z`(`mount.sprite.z = base.gz + z`)。 */
    const cell = { gx: mount.sprite.x, gy: mount.sprite.y, gz: mount.sprite.z, visible: base.visible };
    playerMarker.position.set(cell.gx, cell.gy, cell.gz);
    playerMarker.visible = cell.visible;

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
    /* 3. boss_hud:残影条缓慢回落 + 血量按时间缓慢下降(让血条可见地变化) */
    if (bossActive && boss) {
      bossGhost = Math.max(bossHp / boss.baseHp, bossGhost - (dt / 1000) * 0.06);
      bossHp = Math.max(boss.baseHp * 0.18, bossHp - (dt / 1000) * boss.baseHp * 0.035);
    }

    renderer.render(scene, camera);

    /* ── 覆盖层:把上面各模块的状态画出来 ── */
    const st = uiState();
    const tg = telegraphGeometry();
    st.telegraphRing = tg.outer;
    st.telegraphInner = tg.inner;
    ui.draw(st);

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
    summary: () => ({
      cells: WORLD_CELLS,
      chunks: meshes.length,
      verts: totalVerts,
      faces: Math.round(totalFaces),
      buildMs: Math.round(buildMs * 10) / 10,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: Math.round(fps),
      running: raf !== 0,
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
      /* ── 图集自检口径:截图脚本靠这几个字段判断「真图 vs 占位」── */
      atlasOk,
      atlasErr,
      spriteCount: sprites.length,
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
        /* boss_hud:血条比例与阶段名/预警圈顶点数来自 layoutHpBar + buildTelegraph */
        bossHud: boss && bossActive
          ? (() => {
            const L = layoutHpBar(boss.baseHp, bossHp, window.innerWidth, boss.phases);
            const tg = telegraphGeometry();
            return {
              name: boss.name,
              hp: Math.round(bossHp),
              baseHp: boss.baseHp,
              ratio: Math.round(L.ratio * 1000) / 1000,
              ticks: L.ticks.length,
              barWidth: L.width,
              /* 阶段名取自 layoutHpBar(权威),不在绑定层重算 */
              phaseName: L.phaseName,
              phaseIndex: L.phaseIndex,
              /* 环:外圈 + 内圈顶点数都要 > 0,否则退化成实心盘 */
              telegraphOuter: tg.outer.length,
              telegraphInner: tg.inner.length,
              telegraphVertices: tg.vertices,
              ringOnScreen: tg.outer.some((p) => p.x > 0 && p.x < window.innerWidth && p.y > 0 && p.y < window.innerHeight),
            };
          })()
          : null,
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
      for (const m of meshes) m.geometry.dispose();
      for (const s of sprites) {
        s.material.map?.dispose();
        s.material.dispose();
      }
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
}

function makeHud(container: HTMLElement): Hud {
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
  return {
    update: (info, verts, faces, buildMs, fps) => {
      fpsEl.textContent = `FPS ${fps.toFixed(0)}`;
      statsEl.textContent = `地形 ${WORLD_CELLS}×${WORLD_CELLS} 格 / ${WORLD_CHUNKS ** 2} chunk\n`
        + `顶点 ${verts.toLocaleString()} / 面 ${Math.round(faces).toLocaleString()}\n`
        + `draw call ${info.render.calls} / 三角形 ${info.render.triangles.toLocaleString()}\n`
        + `建面 ${buildMs.toFixed(1)} ms`;
    },
  };
}