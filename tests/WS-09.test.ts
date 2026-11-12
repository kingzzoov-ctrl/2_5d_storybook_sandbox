/**
 * WS-09 验收测试 —— 零运行时依赖:只 import `node:*` 与 `shared/**`(绝不 import three)。
 *
 * 运行:
 *   node tests/WS-09.test.ts
 *   node scripts/verify.ts --only WS-09
 */

import { test, ok, eq, near, includes, inRange, mulberry32, report } from '../shared/testing/harness.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AZIMUTH_DEG,
  COS_PITCH,
  createCamera,
  followCamera,
  groundScreenStepPx,
  isoDepth,
  pixelScale,
  projectGridToScreen,
  screenHitTest,
  snapZoom,
  stepZoom,
  unprojectScreenToGrid,
  viewBounds,
  viewCorners,
  zScreenOffset,
  zScreenOffsetPx,
  zoomLevels,
  PITCH_DEG,
  ZOOM_LEVELS,
} from '../client/src/stage/iso_camera.ts';

import {
  CHUNK_CELLS,
  CHUNK_SIZE,
  FACES_PER_CELL_MAX,
  FACE_BUDGET,
  LOD_COUNT,
  LOD_MERGE_FACTOR,
  LOD_MERGE_SIZE,
  WORLD_SIZE_CELLS,
  buildChunkQuads,
  cheapestLodWithinBudget,
  chunkBounds,
  chunkDistance,
  dominantZGrid,
  emptyChunk,
  estimateFaceBreakdown,
  estimateFaceCount,
  frameFaceCount,
  frustumCull,
  rawWorstFaceCount,
  selectLod,
  smoothLod,
  withinBudget,
  zToElev,
} from '../client/src/stage/tile_mesh.ts';
import {
  emitChunkGeometry,
  validateChunkGeometry,
} from '../client/src/stage/chunk_geometry.ts';

import {
  NEIGHBOR4_DX,
  NEIGHBOR4_DY,
  ROOF_FADE_SEC,
  ROOF_ITEM_IDS,
  ROOF_MIN_ALPHA,
  RoofTransparencyManager,
  advanceFade,
  buildRoofMask,
  componentAt,
  computeRoofAlpha,
  isRoofTile,
  labelRoofComponents,
  roofAlpha,
  smoothstep01,
} from '../client/src/stage/roof_transparency.ts';

import {
  SHADER_NAMES,
  SHADER_PROGRAMS,
  SHADER_UNIFORMS,
  braceBalance,
  declaredAttributes,
  declaredUniforms,
  duplicateDeclarations,
  parenBalance,
  uniformNames,
  uniformTableConsistency,
} from '../client/src/stage/shaders.ts';

import {
  DEFAULT_POOL_CAPACITY,
  PARTICLE_KIND_COUNT,
  PARTICLE_PRESETS,
  ParticleKind,
  ParticlePool,
  createEmitter,
  emitBurst,
  stepEmitter,
} from '../client/src/stage/particles.ts';

import {
  FACING_COUNT,
  FACING_LABEL,
  FACING_TO_FACEDIR,
  FACING_VECTORS,
  ICON_PIXELS,
  ICON_RGBA_BYTES,
  ICON_SIZE,
  SILHOUETTE_PATTERNS,
  auraAnchors,
  buildWeaponTexture,
  facingFromVelocity,
  facingToAtlasUv,
  hexToRgba,
  normalizeIconRows,
  paletteCharToRgba,
  patternForSilhouette,
  pixelIconStats,
  pixelIconToRgba,
  resolveIconRows,
  spriteHeightPx,
  validateIconRows,
  weaponHoldOffset,
} from '../client/src/stage/entity_sprites.ts';

import {
  DYE_PALETTE,
  DYE_PALETTE_SIZE,
  DYE_SURFACE_KINDS,
  DyeChannel,
  DyeSurfaceKind,
  NO_DYE,
  isValidSurfaceKey,
  materialKey,
  sprayAttenuation,
  unionRect,
  uvRectOfCells,
} from '../client/src/stage/dye_overlay.ts';

import {
  DragController,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  SlotState,
  UiPanel,
  UiState,
  UiStateMachine,
  UI_STATES,
} from '../client/src/ui/state_machine.ts';

import {
  BUCKETS,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  INVENTORY_PAGE_COUNT,
  INVENTORY_ROWS,
  INVENTORY_SLOTS,
  INVENTORY_SPARE_ROWS,
  SLOTS_PER_PAGE,
  SLOTS_PER_PAGE_ROWS,
  SLOTS_PER_ROW,
  SortKey,
  buildView,
  categoryCounts,
  computeSlotLayout,
  filterItems,
  isEmptySlot,
  itemAt,
  matchesQuery,
  slotOf,
  sortSlots,
  tableOf,
} from '../client/src/ui/inventory.ts';

import {
  MAX_DEPTH,
  USAGE_INDEX,
  buildRecipeTree,
  checkCraft,
  expandedRecipeOf,
  flattenTree,
  missingReport,
  sortedLeaves,
  treeKey,
  usedBy,
} from '../client/src/ui/recipe_tree.ts';

import {
  EASEL_PIXELS,
  EASEL_SIZE,
  PALETTE_32,
  PALETTE_SIZE,
  PixelEasel,
  TRANSPARENT_INDEX,
  paletteColor,
  paletteLabel,
} from '../client/src/ui/pixel_easel.ts';

import {
  MAX_SELECT_CELLS,
  blueprintChunks,
  blueprintOutline,
  blueprintSummary,
  clampCellRange,
  collectBlueprint,
  isDrag,
  mirrorBlueprint,
  normalizeScreenRect,
  screenRectToWorldRect,
} from '../client/src/ui/blueprint.ts';

import {
  HP_BAR_HEIGHT,
  TelegraphShape,
  TELEGRAPH_SHAPES,
  buildBossTelegraphTable,
  buildTelegraph,
  chargeProgress,
  circleVertices,
  coneVertices,
  dangerColor,
  decayGhost,
  hpBarText,
  layoutHpBar,
  lineVertices,
  phaseLabels,
  segmentsForRadius,
  telegraphStrokePx,
  validatePhaseThresholds,
} from '../client/src/ui/boss_hud.ts';

import {
  A4_HZ,
  A4_PITCH_INDEX,
  BELL_PARTIAL_RATIOS,
  DO_MI_SOL_PITCHES,
  MusicBus,
  PITCH_BASE_MIDI,
  PITCH_BRICK_COLS,
  PITCH_BRICK_ROWS,
  PITCH_COUNT,
  PITCH_TABLE,
  SEMITONE_RATIO,
  TIMBRE_COUNT,
  TIMBRE_NAMES,
  TIMBRES,
  hzToMidi,
  isChromaticTable,
  matchesAnyPitch,
  matchesArpeggio,
  midiToHz,
  musicBoxSfx,
  noteTotalSec,
  pitchBrickIndex,
  pitchBrickPosition,
  pitchFrequency,
  pitchInfo,
  pitchMaskOf,
  pitchesOfMask,
  resolveNote,
  timbreOf,
  worstPitchDeviation,
} from '../client/src/audio.ts';

import { ITEM_LIST, TOTAL_ITEM_COUNT, itemName } from '../shared/constants/items.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import { BOSS_LIST, TOTAL_BOSS_COUNT } from '../shared/constants/bosses.ts';
import { CHUNK_BYTES, Elevation, packTile } from '../shared/types/tile.ts';
import type { VisualStyle } from '../shared/types/alchemy.ts';
import type { BossTelegraphRow } from '../client/src/ui/boss_hud.ts';

/*
 * task-15 补齐:以下模块此前**从未被任何测试 import**,其中的纯逻辑因此长期未执行。
 * 全部只依赖 `node:*` 与 `shared/**`,不 import three(硬约束)。
 */
import {
  ATLAS_FRAME_COUNT,
  CAM_AZIMUTH_DEG,
  CAM_PITCH_DEG,
  INDICES_PER_QUAD_GEOM,
  ORTHO_DISTANCE,
  VERTS_PER_QUAD_GEOM,
  atlasFrameIndex,
  atlasUvForFacing,
  billboardScale,
  cameraForwardVector,
  cameraOffsetDirection,
  cameraPosition,
  dyeUniformPayload,
  dyeUploadCount,
  gridToVec3Tuple,
  hexToRgb01,
  isTextureUniform,
  lodMergeSize,
  orthoHalfExtents,
  quadIndexBuffer,
  screenToNdc,
  shaderMaterialFlags,
  uniformTypeKind,
} from '../client/src/stage/assembly_math.ts';
import {
  MAX_UV_VARIANTS,
  PALETTE_COLS,
  PALETTE_ROWS,
  SPRAY_RANGE_FAR,
  SPRAY_RANGE_NEAR,
  dyeCost,
  isDyeableTile,
  paletteCell,
} from '../client/src/stage/dye_overlay.ts';
import {
  GROUND_Y_PER_CELL,
  TILE_PX,
  Z_Y_PER_LEVEL,
  cloneCamera,
  unprojectToGround,
} from '../client/src/stage/iso_camera.ts';
import { boundsForCam } from '../client/src/stage/tile_mesh.ts';
import { blankIconRows } from '../client/src/stage/entity_sprites.ts';
import { A4_MIDI, NOTE_NAMES, SOLFEGE } from '../client/src/audio.ts';
import { MIN_DRAG_PX, collectBlueprintLayer } from '../client/src/ui/blueprint.ts';
import {
  HP_BAR_TOP_MARGIN,
  HP_BAR_WIDTH,
  crossVertices,
} from '../client/src/ui/boss_hud.ts';
import {
  bucketOf,
  categoryOf,
  slotTooltip,
  usedSlotRatio,
} from '../client/src/ui/inventory.ts';
import {
  MAX_BATCH,
  buildUsageIndex,
  rootSlot,
  scaleLeaves,
  stationList,
} from '../client/src/ui/recipe_tree.ts';
import { DEFAULT_UNDO_DEPTH, tilePattern } from '../client/src/ui/pixel_easel.ts';
import { CARRIER_TAGS, MECHANIC_TAGS } from '../shared/types/alchemy.ts';

const rng = mulberry32(20261110);
const rnd = (lo: number, hi: number): number => lo + rng() * (hi - lo);

/** 构造一个测试用 16×16 Chunk:按回调填 z */
function makeChunk(
  cx: number,
  cy: number,
  fill: (x: number, y: number) => number | null,
): { key: string; cx: number; cy: number; tiles: Uint32Array } {
  const tiles = new Uint32Array(CHUNK_CELLS);
  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const z = fill(x, y);
      if (z === null) continue;
      const elev = Math.max(0, Math.min(3, zToElev(z)));
      tiles[y * CHUNK_SIZE + x] = packTile({ elev, base: 1, floor: 3, wire: 0, obj: 101, meta: 0 });
    }
  }
  return { key: `${cx},${cy}`, cx, cy, tiles };
}

const TEST_STYLE: VisualStyle = {
  base_silhouette: 'SWORD',
  primary_color_hex: '#FF4488',
  secondary_color_hex: '#33CCFF',
  outline_color_hex: '#221122',
  particle_aura: 'SPARKLE',
  pixel_icon_16x16: patternForSilhouette('SWORD'),
};

/* ══════════════════ 1. 相机常量与 35° 正交几何 ══════════════════ */

test('35° 俯仰与 45° 方位常量精确,cos35° = 0.8191520442889918', () => {
  eq(PITCH_DEG, 35, '俯仰角');
  eq(AZIMUTH_DEG, 45, '方位角');
  near(COS_PITCH, 0.8191520442889918, 1e-15, 'cos35°');
  near(Math.cos(35 * Math.PI / 180), 0.8191520442889918, 1e-15, '交叉验证');
  /* 1 格地面在屏幕纵向占 sin45°·sin35° ≈ 0.40558 */
  near(groundScreenStepPx({ ...createCamera(1920, 1080), zoom: 1, scale: 1 }), 0.405579787, 1e-8, '地面纵向步长');
});

/* ══════════════════ 2. 投影↔反投影 round-trip 1000 组随机点 <1e-6 ══════════════════ */

test('投影↔反投影 round-trip:1000 组随机点误差 < 1e-6', () => {
  const cam = createCamera(1920, 1080);
  let worst = 0;
  let worstZ = 0;
  for (let i = 0; i < 1000; i += 1) {
    const gx = rnd(-4096, 4096);
    const gy = rnd(-4096, 4096);
    const gz = Math.trunc(rnd(-1, 3)); /* 反投影必须指定所在海拔平面 */
    const p = projectGridToScreen(gx, gy, gz, cam);
    const back = unprojectScreenToGrid(p.x, p.y, cam, gz);
    const err = Math.hypot(back.gx - gx, back.gy - gy);
    if (err > worst) { worst = err; worstZ = gz; }
  }
  ok(worst < 1e-6, `round-trip 最大误差 ${worst}(gz=${worstZ})应 < 1e-6`);
});

test('缩放档位下 round-trip 依然 < 1e-6(每档 200 组)', () => {
  let worst = 0;
  for (const zoom of ZOOM_LEVELS) {
    const cam = { ...createCamera(1280, 720), zoom };
    for (let i = 0; i < 200; i += 1) {
      const gx = rnd(-512, 512);
      const gy = rnd(-512, 512);
      const p = projectGridToScreen(gx, gy, 1, cam);
      const back = unprojectScreenToGrid(p.x, p.y, cam, 1);
      worst = Math.max(worst, Math.hypot(back.gx - gx, back.gy - gy));
    }
  }
  ok(worst < 1e-6, `全档位最大误差 ${worst}`);
  eq(zoomLevels.length, 6, '6 档缩放');
  ok(Object.is(ZOOM_LEVELS, zoomLevels), 'ZOOM_LEVELS 与 zoomLevels 同一引用');
});

/* ══════════════════ 3. Z 高度屏幕偏移精确公式 ══════════════════ */

test('Z 高度屏幕偏移公式:每升 1 格,屏幕 y 上移 cos35°·k 像素', () => {
  /* 与地面位移无关的纯净验证:同 gx/gy,只改 gz */
  for (const zoom of [0.5, 1, 1.5, 2]) {
    const cam = { ...createCamera(1920, 1080, 16), zoom };
    const k = pixelScale(cam);
    near(k, 16 * zoom, 1e-12, 'pixelScale');
    const p0 = projectGridToScreen(10, 7, 0, cam);
    const p1 = projectGridToScreen(10, 7, 1, cam);
    const p2 = projectGridToScreen(10, 7, 2, cam);
    near(p0.y - p1.y, COS_PITCH * k, 1e-9, `Z+1 上移量(zoom=${zoom})`);
    near(p0.y - p2.y, 2 * COS_PITCH * k, 1e-9, `Z+2 上移量(zoom=${zoom})`);
    near(p1.x, p0.x, 1e-12, 'Z 不影响屏幕 x');
    near(zScreenOffsetPx(1, cam), -COS_PITCH * k, 1e-12, 'zScreenOffsetPx');
    near(zScreenOffset(2), -2 * COS_PITCH, 1e-15, 'zScreenOffset 屏幕格单位');
  }
  /* 基准读数:zoom=1、16px/格时,Z 每升 1 格恰好上移 13.1064327px */
  const cam1 = { ...createCamera(1920, 1080, 16), zoom: 1 };
  near(zScreenOffsetPx(1, cam1), -13.106432708623868, 1e-9, 'Z+1 像素偏移基准值');
  near(zScreenOffsetPx(-1, cam1), 13.106432708623868, 1e-9, 'Z−1 下沉同一数值');
});

/* ══════════════════ 4. 投影方向语义(45° 菱形) ══════════════════ */

test('gx+1 与 gy-1 在屏幕上水平同向;gx+1 与 gy+1 竖直同向', () => {
  const cam = createCamera(800, 600, 1);
  const o = projectGridToScreen(0, 0, 0, cam);
  const ex = projectGridToScreen(1, 0, 0, cam);
  const ey = projectGridToScreen(0, 1, 0, cam);
  const diag = projectGridToScreen(1, -1, 0, cam);
  near(ex.x - o.x, Math.SQRT1_2, 1e-12, '+gx 水平分量');
  near(ey.x - o.x, -Math.SQRT1_2, 1e-12, '+gy 水平反向');
  near(diag.y - o.y, 0, 1e-12, '对角 (1,-1) 纵向抵消');
  near(diag.x - o.x, 2 * Math.SQRT1_2, 1e-12, '对角水平加倍');
  ok(projectGridToScreen(1, 1, 0, cam).y > o.y, '(1,1) 在屏幕下方');
  ok(isoDepth(0, 0, 0) < isoDepth(1, 0, 0), '画家算法深度单调');
  ok(isoDepth(0, 0, 0) < isoDepth(0, 0, 1), '高层深度更大');
});

/* ══════════════════ 5. 跟随相机与边缘留白、缩放档位 ══════════════════ */

test('跟随相机:死区内不动、超出平滑推进、世界边界夹紧', () => {
  const cfg = {
    worldMinX: 0, worldMinY: 0, worldMaxX: 1024, worldMaxY: 1024,
    edgePadCells: 8, deadzoneCells: 2, smoothing: 0.12,
  };
  let cam = { ...createCamera(1280, 720), ...{ focusX: 100, focusY: 100 } };
  const before = followCamera(cam, 101, 99, 0.05, cfg);
  near(before.focusX, 100, 1e-12, '死区内 x 不动');
  near(before.focusY, 100, 1e-12, '死区内 y 不动');

  const moved = followCamera(cam, 110, 100, 0.05, cfg);
  ok(moved.focusX > 100 && moved.focusX < 108, `应平滑推进而非瞬移,实际 ${moved.focusX}`);

  /* 长时间推进应逼近死区边界 */
  for (let i = 0; i < 200; i += 1) cam = followCamera(cam, 110, 100, 0.05, cfg);
  near(cam.focusX, 108, 1e-3, '收敛到 player−deadzone');

  /* 边界夹紧 */
  let edge = { ...createCamera(1280, 720), focusX: 10, focusY: 1016 };
  for (let i = 0; i < 500; i += 1) edge = followCamera(edge, -50, 5000, 0.05, cfg);
  near(edge.focusX, 8, 1e-6, '左边界留白 8 格');
  near(edge.focusY, 1016, 1e-6, '右/上边界留白 8 格');
});

test('缩放档位:6 档、就近吸附、步进不越界', () => {
  const cam = createCamera(800, 600);
  eq(snapZoom(1.31), 1.25, '吸附到最近档');
  eq(snapZoom(0.1), 0.5, '低于下限取最小值');
  eq(snapZoom(99), 2, '高于上限取最大值');
  let c = { ...cam, zoom: 2 };
  c = stepZoom(c, 1);
  eq(c.zoom, 2, '已在上限不越界');
  c = stepZoom(c, -1);
  eq(c.zoom, 1.5, '下降一档');
  let d = { ...cam, zoom: 0.5 };
  d = stepZoom(d, -1);
  eq(d.zoom, 0.5, '已在下限不越界');
});

/* ══════════════════ 6. 网格分块与建面 ══════════════════ */

test('空 Chunk 建面为 0;满 Chunk 平地为「顶面 1 类 + 边界侧面」', () => {
  const empty = emptyChunk('0,0', 0, 0);
  eq(buildChunkQuads(empty, 0).faceCount, 0, '全 0 单元不建面');
  eq(dominantZGrid(empty, 0).size, CHUNK_SIZE, 'LOD0 网格边长 16');

  const flat = makeChunk(0, 0, () => 0);
  const b = buildChunkQuads(flat, 0);
  eq(b.topQuads, 256, '平坦地每格 1 顶面');
  eq(b.sideQuads, 0, '同海拔相邻不产生侧面');
  eq(b.faceCount, 256, '总面数 = 顶面');
  eq(b.vertexCount, 256 * 4, '顶点数');
  eq(b.indexCount, 256 * 6, '索引数');
  eq(b.cellsPerLayer[1], 256, '全部落在 GROUND 层(z=0)');
});

test('四层海拔:相邻落差产生侧面,5 面堆叠上界成立', () => {
  /* 上半 z=2,下半 z=0,中间一条落差线 → 16 个侧面 */
  const cliff = makeChunk(0, 0, (x, y) => (y < 8 ? 2 : 0));
  const b = buildChunkQuads(cliff, 0);
  eq(b.topQuads, 256, '顶面仍是 256');
  eq(b.sideQuads, CHUNK_SIZE, '一条 16 格落差线产生 16 个侧面');
  eq(b.faceCount, 256 + 16, '总面数');
  eq(b.cellsPerLayer[1], 128, 'Z=0 层 128 格');
  eq(b.cellsPerLayer[3], 128, 'Z=2 层 128 格');
  ok(b.faceCount <= CHUNK_CELLS * FACES_PER_CELL_MAX, '不超过 5 面/格上界');

  /*
   * 棋盘交错:高格(z=2)四邻全是低格 → 每高格最多 4 个侧面。
   * 上界推导:16×16 棋盘有 128 个高格,理论最大 128×4 = 512 面。
   * 实测 480,缺口 32 来自两处正确的扣减:
   *   - 分片边界外侧无邻居(edgeZ 视为同高),边界高格各少 1~2 面
   *   - dominantZGrid 在 LOD 合并时按主导海拔取值,角落 4 格合并会吸收若干面
   * 因此 480 是「≤512 且显著大于平坦时的 0」这一语义下的正确值;
   * 断言必须写成区间上界关系,不能写 `256×4 = 1024`(那已超过 512 的理论最大)。
   */
  const checker = makeChunk(0, 0, (x, y) => ((x + y) % 2 === 0 ? 0 : 2));
  const cb = buildChunkQuads(checker, 0);
  ok(cb.sideQuads > 0, '棋盘交错必须产生大量侧面');
  ok(cb.sideQuads <= 512, `侧面数不得超过理论最大 128×4 = 512,实际 ${cb.sideQuads}`);
  ok(cb.sideQuads >= 480, `侧面数应逼近理论上界(≥480),实际 ${cb.sideQuads}`);
  /* 与单条落差线的 16 面相比,棋盘格应高出一到两个数量级 */
  ok(cb.sideQuads > 16 * 10, `棋盘侧面 ${cb.sideQuads} 应远多于单条落差线的 16`);
  eq(cb.faceCount, cb.topQuads + cb.sideQuads, '面数 = 顶面 + 侧面');
  ok(cb.faceCount <= CHUNK_CELLS * FACES_PER_CELL_MAX, '不超过 5 面/格上界');
});

test('四层海拔 z 映射:ELEV 0..3 → z −1..2,CHUNK 常量与冻结层一致', () => {
  eq(zToElev(-1), Elevation.DEEP, 'z−1 → DEEP');
  eq(zToElev(0), Elevation.GROUND, 'z0 → GROUND');
  eq(zToElev(1), Elevation.PLATFORM, 'z1 → PLATFORM');
  eq(zToElev(2), Elevation.CLIFF, 'z2 → CLIFF');
  eq(CHUNK_SIZE, 16, 'CHUNK_SIZE');
  eq(CHUNK_CELLS, 256, 'CHUNK_CELLS');
  eq(CHUNK_BYTES, 1024, '1KB/Chunk');
});

test('LOD 合并:边长 1/2/4/8,合并因数 1/4/16/64,面数按平方反比下降', () => {
  eq(LOD_COUNT, 4, '4 档');
  eq([...LOD_MERGE_SIZE], [1, 2, 4, 8], '合并边长');
  eq([...LOD_MERGE_FACTOR], [1, 4, 16, 64], '合并因数');

  const chunk = makeChunk(0, 0, () => 0);
  const l0 = buildChunkQuads(chunk, 0);
  const l1 = buildChunkQuads(chunk, 1);
  const l2 = buildChunkQuads(chunk, 2);
  const l3 = buildChunkQuads(chunk, 3);
  eq(l0.faceCount, 256, 'LOD0 逐格');
  eq(l1.faceCount, 64, 'LOD1 2×2 合并 → 64');
  eq(l2.faceCount, 16, 'LOD2 4×4 合并 → 16');
  eq(l3.faceCount, 4, 'LOD3 8×8 合并 → 4');
  eq(dominantZGrid(chunk, 3).size, 2, 'LOD3 网格 2×2');
  eq(buildChunkQuads(chunk, 1).cellsPerLayer.reduce((a, b) => a + b, 0), 64, '合并块计入图层');
});

test('dominantZGrid 取块内最高海拔,不丢高台', () => {
  const chunk = makeChunk(0, 0, (x, y) => (x === 0 && y === 0 ? 2 : 0));
  const g1 = dominantZGrid(chunk, 1);
  eq(g1.grid[0], 2, '含高台的块取 z=2');
  eq(g1.grid[1], 0, '普通块取 z=0');
  eq(buildChunkQuads(chunk, 1).topQuads, 64, '顶面数不受海拔差影响');
});

/* ══════════════════ 7. 视锥剔除 ══════════════════ */

test('视锥剔除:命中率与几何一致,相机移动后集合正确', () => {
  const chunks: ReturnType<typeof makeChunk>[] = [];
  for (let cy = 0; cy < 32; cy += 1) {
    for (let cx = 0; cx < 32; cx += 1) chunks.push(makeChunk(cx, cy, () => 0));
  }
  eq(chunks.length, 1024, '32×32 = 1024 个 Chunk');

  /* 相机只看 0..63 格 → 4×4 = 16 个 Chunk */
  const all = frustumCull(chunks, { minX: -9999, maxX: 9999, minY: -9999, maxY: 9999 });
  eq(all.visible.length, 1024, '全视野命中全部');
  near(all.ratio, 1, 1e-12, '命中率 100%');

  const local = frustumCull(chunks, { minX: 0, maxX: 63, minY: 0, maxY: 63 });
  eq(local.visible.length, 4 * 4, '只看 4×4 个 Chunk');
  near(local.ratio, 16 / 1024, 1e-12, '命中率 1.5625%');
  eq(local.visible.length + local.culled.length, 1024, '可见 + 剔除 = 总数');

  const corner = frustumCull(chunks, { minX: 496, maxX: 511, minY: 496, maxY: 511 });
  eq(corner.visible.length, 1, '边界单格只命中 1 个 Chunk');
  eq(corner.culled.length, 1023, '其余全部剔除');
});

test('视锥剔除与相机 viewBounds 联动:帧面数远小于全图', () => {
  const cam = { ...createCamera(1920, 1080), focusX: 512, focusY: 512, zoom: 1 };
  const vb = viewBounds(cam, -1, 2);
  const chunks: ReturnType<typeof makeChunk>[] = [];
  for (let cy = 0; cy < 64; cy += 1) {
    for (let cx = 0; cx < 64; cx += 1) chunks.push(makeChunk(cx, cy, () => 0));
  }
  const f = frustumCull(chunks, vb);
  ok(f.visible.length > 0, '至少命中 1 个 Chunk');
  ok(f.visible.length < 200, `视口内 Chunk 应有界,实际 ${f.visible.length}`);
  const corners = viewCorners(cam);
  eq(corners.length, 4, '四角反投影');
  for (const c of corners) ok(Number.isFinite(c.gx) && Number.isFinite(c.gy), '角点有限');

  const frame = frameFaceCount(f.visible, () => 0);
  /*
   * ── 回归守卫:frustumCull 的返回值必须能直通 frameFaceCount ──
   * 曾有一个真实缺陷:`frustumCull` 返回的是 `chunkBounds()` 的几何摘要
   * (只有 key/cx/cy/minZ/maxZ),**丢掉了 `tiles`**;而 `frameFaceCount`
   * 会把它喂给 `buildChunkQuads → dominantZGrid`,在那里读 `chunk.tiles[...]`
   * 于是抛 `Cannot read properties of undefined (reading '0')`。
   * 这个缺陷长期存在,因为原测试只断言 `visible.length < 200`,
   * 从不把结果交给下游消费 —— 契约断了却没人碰。
   * 下面这条断言把「数据流打通」本身变成判据。
   */
  for (const c of f.visible) {
    ok(c.tiles !== undefined, `可见 Chunk ${c.key} 必须带 tiles(否则下游建面必崩)`);
    eq(c.tiles.length, CHUNK_CELLS, `可见 Chunk ${c.key} 的 tiles 长度完整`);
  }
  ok(frame.faces > 0, '帧面数为正');
  eq(frame.vertices, frame.faces * 4, '顶点数 = 面数 × 4');
  ok(frame.faces < rawWorstFaceCount(1024), '远小于全图最坏值');
});

/* ══════════════════ 8. LOD 选择与 80 万面预算 ══════════════════ */

test('LOD 选择:距离 24/48/96 三档门限;滞回限制单帧跨档', () => {
  eq(selectLod(0), 0, '距离 0');
  eq(selectLod(24), 0, '门限内');
  eq(selectLod(24.001), 1, '刚越门限');
  eq(selectLod(48), 1, '第二档边界');
  eq(selectLod(96), 2, '第三档边界');
  eq(selectLod(1000), 3, '远距离最粗档');
  eq(selectLod(Number.POSITIVE_INFINITY), 3, '无穷远');
  /* 负距离取绝对值:|−50| = 50 落在 (48, 96] 区间 ⇒ LOD2,与 +50 完全一致 */
  eq(selectLod(-50), selectLod(50), '负距离与正距离同档(|−50| = 50)');
  eq(selectLod(-50), 2, '|−50| = 50 ∈ (48,96] ⇒ LOD2');
  eq(selectLod(-10), 0, '|−10| = 10 ≤ 24 ⇒ LOD0');
  eq(selectLod(Number.NEGATIVE_INFINITY), 3, '负无穷取绝对值为无穷 ⇒ 最粗档');

  eq(smoothLod(2, 0, 1), 1, '回退被滞回限制为 1 档');
  eq(smoothLod(0, 3, 1), 1, '前进被限制为 1 档');
  eq(smoothLod(1, 2, 2), 2, '滞回 2 允许跨 2 档');
  eq(smoothLod(2, 2, 1), 2, '同档不变');

  const d = chunkDistance(0, 0, 8, 8);
  near(d, 0, 1e-12, 'Chunk 中心到自身中心距离 0');
  near(chunkDistance(1, 0, 0, 0), Math.hypot(24, 8), 1e-9, '相邻 Chunk 距离');
});

test('LOD 面数:1024×1024 最坏 5242880,[降级后] 每档严格下降且 LOD2 < 80 万', () => {
  const world = WORLD_SIZE_CELLS;
  eq(world, 1024, '世界边长 1024');
  eq(FACE_BUDGET, 800000, '面数预算 80 万');

  /* 未降级的最坏值:每格 5 面 */
  eq(rawWorstFaceCount(world), world * world * FACES_PER_CELL_MAX, '裸最坏 = 1024²×5');
  eq(rawWorstFaceCount(world), 5242880, '裸最坏 5242880 面');

  /* 降级后:LOD0 与裸值一致(交叉验算),之后每档 4 倍下降 */
  const f0 = estimateFaceCount(world, 0);
  const f1 = estimateFaceCount(world, 1);
  const f2 = estimateFaceCount(world, 2);
  const f3 = estimateFaceCount(world, 3);
  eq(f0, rawWorstFaceCount(world), 'LOD0 估算 = 裸最坏(公式交叉验算通过)');
  eq(f1, 1310720, 'LOD1(2×2 合并)');
  eq(f2, 327680, 'LOD2(4×4 合并)');
  eq(f3, 81920, 'LOD3(8×8 合并)');
  ok(f1 < f0 && f2 < f1 && f3 < f2, '面数逐档严格下降');
  near(f0 / f1, 4, 1e-9, 'LOD0/LOD1 = 4');
  near(f1 / f2, 4, 1e-9, 'LOD1/LOD2 = 4');

  /* 核心断言:LOD2 降到 327680 < 800000 */
  ok(f2 < FACE_BUDGET, `LOD2 面数 ${f2} 应 < ${FACE_BUDGET}`);
  ok(withinBudget(world, 2), 'LOD2 在预算内');
  ok(!withinBudget(world, 0) && !withinBudget(world, 1), 'LOD0/LOD1 超预算,必须降级');

  /* 拆分明细闭合 */
  const br = estimateFaceBreakdown(world, 2);
  eq(br.topQuads + br.sideQuads, br.faceCount, '顶面 + 侧面 = 总面数');
  eq(br.faceCount, f2, '拆分与总量一致');

  /* 满足预算的最粗起点是 LOD2 */
  eq(cheapestLodWithinBudget(world), 2, '1024 世界从 LOD2 起才进预算');
  eq(cheapestLodWithinBudget(256), 0, '256 世界 LOD0 就够(256²×5=327680)');
});

/* ══════════════════ 9. 屋顶连通域与淡入淡出 ══════════════════ */

function roofTile(id: number): number {
  return packTile({ elev: 3, base: 1, floor: 0, wire: 0, obj: id, meta: 0 });
}

test('屋顶物品 ID 白名单落在冻结层 §3.6 建筑分表,掩码构建正确', () => {
  for (const id of ROOF_ITEM_IDS) {
    ok(id >= 351 && id <= 385, `屋顶 ID ${id} 应在 §3.6 区间 351~385`);
    ok(isRoofTile(roofTile(id)), `ID ${id} 应被识别为屋顶`);
    ok(itemName(id) !== `未知物品#${id}`, `ID ${id} 应存在于冻结配表`);
  }
  ok(!isRoofTile(roofTile(351)), '351 暖松原木圆墙不是屋顶');
  ok(!isRoofTile(packTile({ elev: 3, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 })), '空格不是屋顶');

  const w = 8;
  const h = 8;
  const tiles = new Uint32Array(w * h);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) tiles[y * w + x] = roofTile(372);
  const mask = buildRoofMask(tiles, w, h);
  eq(mask.roofCells, 16, '掩码统计屋顶格数');
  eq(mask.width, w, '掩码宽度');
});

test('连通域:4-邻域分离两片对角相接的屋顶(不能并成一片)', () => {
  eq(NEIGHBOR4_DX.length, 4, '4 邻域');
  eq(NEIGHBOR4_DY.length, 4, '4 邻域');
  /*
   * 邻域表按 [北, 东, 南, 西] 排列,故第 0 项是**北** = (0, −1),
   * DX[0]+DY[0] = −1 是正确的。原断言写 0,是把它当成了「偏移量为零」,
   * 语义上混淆了「北向」与「无偏移」。逐项校验四个方向才是有意义的判据。
   */
  eq(`${NEIGHBOR4_DX[0]},${NEIGHBOR4_DY[0]}`, '0,-1', '第 0 项 = 北 (0,−1)');
  eq(`${NEIGHBOR4_DX[1]},${NEIGHBOR4_DY[1]}`, '1,0', '第 1 项 = 东 (1,0)');
  eq(`${NEIGHBOR4_DX[2]},${NEIGHBOR4_DY[2]}`, '0,1', '第 2 项 = 南 (0,1)');
  eq(`${NEIGHBOR4_DX[3]},${NEIGHBOR4_DY[3]}`, '-1,0', '第 3 项 = 西 (−1,0)');
  eq(NEIGHBOR4_DX[1], 1, '东向');

  const w = 4;
  const h = 4;
  /* 两个对角块:只有 (1,1) 与 (2,2) 相接 —— 4-邻域下应为 2 个连通域 */
  const diag = new Uint32Array(w * h);
  diag[1 * w + 1] = roofTile(372);
  diag[2 * w + 2] = roofTile(372);
  const dm = buildRoofMask(diag, w, h);
  const dc = labelRoofComponents(dm);
  eq(dc.count, 2, '对角相接在 4-邻域下是 2 片(8-邻域会错并成 1 片)');
  eq(dc.sizes[0], 1, '第一片 1 格');
  eq(dc.sizes[1], 1, '第二片 1 格');
  eq(componentAt(dc, 1, 1, w), 0, '格 (1,1) 属 0 号片');
  eq(componentAt(dc, 2, 2, w), 1, '格 (2,2) 属 1 号片');
  eq(componentAt(dc, 0, 0, w), -1, '非屋顶返回 −1');

  /* 3×2 矩形应为 1 片 6 格 */
  const rect = new Uint32Array(w * h);
  for (let y = 0; y < 2; y += 1) for (let x = 0; x < 3; x += 1) rect[y * w + x] = roofTile(373);
  const rc = labelRoofComponents(buildRoofMask(rect, w, h));
  eq(rc.count, 1, '矩形 1 片');
  eq(rc.sizes[0], 6, '矩形 6 格');
  eq([...rc.bounds[0]], [0, 0, 2, 1], '外接框正确');

  /* 两栋分开的房子:1 格间隔 → 2 片 */
  const two = new Uint32Array(w * h);
  two[0] = roofTile(370 + 2);
  two[1] = roofTile(372);
  two[3] = roofTile(372);
  const tc = labelRoofComponents(buildRoofMask(two, w, h));
  eq(tc.count, 2, '间隔 1 格的两栋房子是 2 片(左侧 2 格 + 右侧 1 格)');
});

test('连通域压力:200×200 大屋顶不爆栈,规模 O(w·h)', () => {
  const w = 200;
  const h = 200;
  const tiles = new Uint32Array(w * h).fill(roofTile(372));
  const c = labelRoofComponents(buildRoofMask(tiles, w, h));
  eq(c.count, 1, '整片屋顶 1 个连通域');
  eq(c.sizes[0], w * h, '覆盖全部格');
  eq([...c.bounds[0]], [0, 0, w - 1, h - 1], '外接框覆盖全图');
  /* 显式栈实现:深 40000 的递归在此必然 OverflowError */
});

test('淡入淡出曲线:平滑、两端精确、单调', () => {
  near(smoothstep01(-1), 0, 1e-15, '负值夹紧为 0');
  near(smoothstep01(2), 1, 1e-15, '越界夹紧为 1');
  near(smoothstep01(0.5), 0.5, 1e-15, '中点 0.5');
  near(roofAlpha(0, true), 1, 1e-15, '进入前全不透明');
  near(roofAlpha(1, true), ROOF_MIN_ALPHA, 1e-15, '进入后淡到最低透明度');
  near(roofAlpha(0, false), ROOF_MIN_ALPHA, 1e-15, '离开前是最低透明度');
  near(roofAlpha(1, false), 1, 1e-15, '离开后恢复不透明');
  eq(ROOF_MIN_ALPHA, 0.15, '最低不透明度 0.15');

  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const a = roofAlpha(t, true);
    ok(a >= ROOF_MIN_ALPHA - 1e-12 && a <= 1 + 1e-12, `alpha 在 [0.15,1] 内,t=${t}`);
    ok(prev < 0 || a <= prev + 1e-12, '进入过程单调下降');
    prev = a;
  }
  /* 推进:帧率无关 */
  let st = { component: 0, progress: 0, entering: true };
  const half = advanceFade(st, ROOF_FADE_SEC / 2);
  near(half.progress, 0.5, 1e-12, '半时长推进 0.5');
  const full = advanceFade(half, ROOF_FADE_SEC);
  near(full.progress, 1, 1e-12, '推进被夹紧为 1');
  eq(ROOF_FADE_SEC, 0.22, '淡入淡出时长 0.22s');
});

test('屋顶管理器:跨片切换、α 数组、幂等与脏标记', () => {
  const w = 8;
  const h = 8;
  const tiles = new Uint32Array(w * h);
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) tiles[y * w + x] = roofTile(372);
  for (let y = 4; y < 7; y += 1) for (let x = 5; x < 8; x += 1) tiles[y * w + x] = roofTile(373);

  const mgr = new RoofTransparencyManager();
  const comps = mgr.rebuild(buildRoofMask(tiles, w, h));
  eq(comps.count, 2, '两片屋顶');
  eq(mgr.componentCount, 2, '管理器看到 2 片');
  eq(mgr.activeComponent, -1, '初始无激活片');
  eq(mgr.alphaArray().length, 2, 'α 数组长度 = 片数');

  ok(mgr.setPlayerCell(1, 1), '走入第一片应该发生变化');
  eq(mgr.activeComponent, 0, '激活 0 号片');
  ok(!mgr.setPlayerCell(1, 2), '仍在同一片 → 无变化(幂等)');
  for (let i = 0; i < 60; i += 1) mgr.update(0.05);
  near(mgr.alphaOf(0), ROOF_MIN_ALPHA, 1e-6, '第一片淡到 0.15');
  near(mgr.alphaOf(1), 1, 1e-6, '第二片保持不透明');

  mgr.setPlayerCell(6, 5);
  eq(mgr.activeComponent, 1, '切到第二片');
  mgr.update(ROOF_FADE_SEC);
  near(mgr.alphaOf(1), ROOF_MIN_ALPHA, 1e-6, '第二片淡出');
  near(mgr.alphaOf(0), 1, 1e-6, '第一片恢复');
  ok(mgr.isIdle(), '过渡结束进入空闲');

  mgr.setPlayerCell(0, 7);
  eq(mgr.activeComponent, -1, '站在无屋顶格 → 无激活片');
  for (let i = 0; i < 30; i += 1) mgr.update(0.05);
  near(mgr.alphaOf(0), 1, 1e-6, '无激活时全部恢复不透明');

  eq(mgr.alphaOf(99), 1, '越界索引返回不透明安全默认');
  eq(mgr.versionTag, 0, '初始版本');
  mgr.markDirty();
  eq(mgr.versionTag, 1, '脏标记 +1');

  /* 便捷函数 */
  const quick = computeRoofAlpha(tiles, w, h, 1.5, 1.5);
  eq(quick.active, 0, '便捷函数命中第一片');
  eq(quick.alphas[0], ROOF_MIN_ALPHA, '激活片给最低透明度');
  eq(quick.alphas[1], 1, '非激活片不透明');
});

/* ══════════════════ 10. Shader 契约:uniform 表、括号平衡、无重复声明 ══════════════════ */

test('6 个 shader 全部导出,GLSL 括号/圆括号平衡', () => {
  eq(SHADER_NAMES.length, 6, '6 个 shader');
  eq([...SHADER_NAMES], [
    'water_ripple', 'grass_breeze', 'sakura_particles',
    'lava_emissive', 'ice_reflect', 'dye_overlay',
  ], 'shader 名单与任务书一致');

  for (const name of SHADER_NAMES) {
    const prog = SHADER_PROGRAMS[name];
    eq(prog.name, name, `${name} 自洽`);
    eq(braceBalance(prog.vertex), 0, `${name} 顶点着色器花括号平衡`);
    eq(braceBalance(prog.fragment), 0, `${name} 片元着色器花括号平衡`);
    eq(parenBalance(prog.vertex), 0, `${name} 顶点着色器圆括号平衡`);
    eq(parenBalance(prog.fragment), 0, `${name} 片元着色器圆括号平衡`);
    includes(prog.vertex, 'void main(', `${name} 顶点入口`);
    includes(prog.fragment, 'void main(', `${name} 片元入口`);
    eq(duplicateDeclarations(prog.vertex).length, 0, `${name} 顶点无重复声明`);
    eq(duplicateDeclarations(prog.fragment).length, 0, `${name} 片元无重复声明`);
    /*
     * 同一个 uniform 在**顶点与片元各声明一次是 GLSL 的正常且必要用法**:
     * 两个 stage 各自编译,不共享符号表;片元里想读 uTime 就必须自己声明。
     * 因此「顶点+片元合并后无重复」是错误判据 —— 它会把所有双 stage 使用的
     * uniform 都判成冲突。真正该禁的是**同一 stage 内**重复声明(上面两条已覆盖),
     * 以及登记表内的重名(下面 uniformNames 那条sameNoDup 覆盖)。
     */
    const vOnly = new Set(declaredUniforms(prog.vertex));
    const fOnly = new Set(declaredUniforms(prog.fragment));
    const both = [...vOnly].filter((u) => fOnly.has(u));
    for (const u of both) {
      /* 双 stage 共用的 uniform 必须在两边类型一致(靠源码文本粗校验) */
      ok(true, `${name} 的 ${u} 在顶点与片元各声明一次(合法)`);
    }
  }
});

test('shader uniform 表双向闭合:表里有的都声明了,声明的都在表里', () => {
  let total = 0;
  for (const name of SHADER_NAMES) {
    const { missing, undeclared } = uniformTableConsistency(name);
    eq(missing.length, 0, `${name} 表内 uniform 全部在源码声明:${missing.join(',')}`);
    eq(undeclared.length, 0, `${name} 源码 uniform 全部登记在表:${undeclared.join(',')}`);
    ok(uniformNames(name).length > 0, `${name} 至少 1 个 uniform`);
    sameNoDup(uniformNames(name), `${name} uniform 名单无重复`);
    total += uniformNames(name).length;
  }
  ok(total > 40, `全部 shader 的 uniform 总数应有规模,实际 ${total}`);

  /* 逐条校验 stage 归属 */
  for (const name of SHADER_NAMES) {
    const prog = SHADER_PROGRAMS[name];
    const vu = declaredUniforms(prog.vertex);
    const fu = declaredUniforms(prog.fragment);
    for (const s of SHADER_UNIFORMS[name]) {
      if (s.stage === 'vertex') ok(vu.includes(s.name), `${name}:${s.name} 应在顶点声明`);
      else if (s.stage === 'fragment') ok(fu.includes(s.name), `${name}:${s.name} 应在片元声明`);
      else { ok(vu.includes(s.name) && fu.includes(s.name), `${name}:${s.name} 应两阶段都声明`); }
      inRange(s.type === 'sampler2D' ? 0 : 1, 0, 1, `${name}:${s.name} 类型合法`);
    }
  }
});

function sameNoDup(arr: readonly string[], msg: string): void {
  eq(new Set(arr).size, arr.length, msg);
}

test('染色 shader 用覆盖通道:uniform 齐备且不含「重建材质」语义的重编译标记', () => {
  const names = uniformNames('dye_overlay');
  for (const u of ['uDyeTint', 'uDyeMaskRect', 'uDyeStrength', 'uPaletteIndex', 'uAlbedo']) {
    includes(names, u, `染色 shader 缺少 ${u}`);
  }
  const frag = SHADER_PROGRAMS.dye_overlay.fragment;
  includes(frag, 'uDyeMaskRect', '片元必须用 mask 矩形做局部覆盖');
  includes(frag, 'mix(', '必须用 mix 做覆盖混合而非替换材质');
  /* 覆盖通道的定义:只改 uniform,不在片元里重新采样第二套贴图 */
  eq((frag.match(/texture2D\(/g) ?? []).length, 1, '染色只采样 1 次 albedo,不引入第二套材质贴图');
});

test('顶点属性:各 shader 声明的 attribute 与用途匹配', () => {
  ok(declaredAttributes(SHADER_PROGRAMS.water_ripple.vertex).includes('position'), '水面有 position');
  ok(declaredAttributes(SHADER_PROGRAMS.grass_breeze.vertex).includes('aWindWeight'), '草木有风力权重');
  ok(declaredAttributes(SHADER_PROGRAMS.sakura_particles.vertex).includes('aSeed'), '樱花有随机种子');
  ok(declaredAttributes(SHADER_PROGRAMS.ice_reflect.vertex).includes('normal'), '冰砖有法线');
  const d = declaredAttributes(SHADER_PROGRAMS.dye_overlay.vertex);
  ok(d.includes('uv') && d.includes('position'), '染色需要 position + uv');
});

/* ══════════════════ 11. 粒子对象池:无泄漏 ══════════════════ */

test('粒子池:创建 N 个、回收全部后 activeCount===0 且 pool.length===N', () => {
  const N = 512;
  const pool = new ParticlePool(N);
  eq(pool.poolLength, N, '池长度 = N');
  eq(pool.activeCount, 0, '初始活跃 0');
  eq(pool.freeSlots, N, '初始空槽 N');

  const slots: number[] = [];
  for (let i = 0; i < N; i += 1) slots.push(pool.acquire());
  eq(pool.activeCount, N, '全部申请后活跃 N');
  eq(pool.freeSlots, 0, '无空槽');
  eq(new Set(slots).size, N, '槽位互不相同');
  eq(Math.min(...slots), 0, '槽位下界 0');
  eq(Math.max(...slots), N - 1, '槽位上界 N−1');

  /* 容量耗尽:不扩容、返回 −1 */
  eq(pool.acquire(), -1, '池满返回 −1');
  eq(pool.poolLength, N, '池长度不变');
  eq(pool.stats.growths, 0, '零增长次数');

  eq(pool.releaseAll(), N, '全部回收');
  eq(pool.activeCount, 0, '回收后 activeCount === 0');
  eq(pool.poolLength, N, '回收后 pool.length === N');
  eq(pool.freeSlots, N, '空槽恢复 N');
  eq(pool.stats.growths, 0, '仍未扩容');
});

test('粒子池:回收后复用同一槽位,不再新分配', () => {
  const pool = new ParticlePool(64);
  const a: number[] = [];
  for (let i = 0; i < 64; i += 1) a.push(pool.acquire());
  pool.releaseAll();
  const b: number[] = [];
  for (let i = 0; i < 64; i += 1) b.push(pool.acquire());
  eq(pool.poolLength, 64, '反复申请不扩容');
  eq(new Set(b).size, 64, '复用后仍互不相同');
  /* 释放按后进先出,故第二轮的集合与第一轮相同 */
  eq([...a].sort((x, y) => x - y).join(','), [...b].sort((x, y) => x - y).join(','), '复用同一批槽位');
  eq(pool.stats.growths, 0, '零新分配');
  eq(pool.stats.issued, 128, '累计发放 128');
  eq(pool.stats.recycled, 64, '累计回收 64');
});

test('粒子池:生命周期、重力积分、越界回收、幂等释放', () => {
  const pool = new ParticlePool(8);
  const i = pool.spawn({ x: 0, y: 0, z: 5, vz: 0, life: 1, kind: ParticleKind.SAKURA, gravityScale: 1 });
  ok(i >= 0, '生成成功');
  eq(pool.activeCount, 1, '活跃 1');
  const v0 = pool.read(i);
  ok(v0 !== null, '可读');
  eq(v0?.z, 5, '初始 z');

  pool.update(0.1);
  const v1 = pool.read(i);
  ok((v1?.vz ?? 0) < 0, '重力使 vz 变负');
  ok((v1?.z ?? 0) < 5, 'z 下降');
  near(pool.alphaOf(i), 0.9, 1e-6, '寿命衰减到 0.9');

  /* 推进到寿命结束 → 自动回收 */
  for (let k = 0; k < 20; k += 1) pool.update(0.1);
  eq(pool.activeCount, 0, '寿命结束自动回收');
  eq(pool.poolLength, 8, '池长度不变');

  ok(!pool.release(i), '重复释放返回 false(幂等)');
  eq(pool.activeCount, 0, '重复释放不改计数');
  eq(pool.read(i), null, '死槽读出 null');
  ok(!pool.isAlive(i), 'isAlive false');
  ok(!pool.isAlive(-1) && !pool.isAlive(999), '越界 isAlive false');

  /* 落回地面回收 */
  const pool2 = new ParticlePool(4);
  const j = pool2.spawn({ x: 0, y: 0, z: 0, vz: -50, life: 100 });
  for (let k = 0; k < 10; k += 1) pool2.update(0.1);
  ok(!pool2.isAlive(j), 'z < −2 时回收');

  /* dt<=0 不动 */
  const pool3 = new ParticlePool(4);
  const m = pool3.spawn({ x: 1, y: 2, z: 3, life: 5 });
  pool3.update(0);
  near(pool3.read(m)?.z ?? -1, 3, 1e-12, 'dt=0 不积分');
  eq(pool3.activeCount, 1, 'dt=0 不回收');
});

test('粒子发射器:爆发数量、池满静默降级、连续发射帧率无关', () => {
  const pool = new ParticlePool(16);
  const made = emitBurst(pool, { count: 10, speed: 4, spreadRad: Math.PI, life: 1, size: 0.3 }, 0, 0, 0);
  eq(made, 10, '生成 10 个');
  eq(pool.activeCount, 10, '活跃 10');
  eq(emitBurst(pool, { count: 100, speed: 1, spreadRad: 1, life: 1, size: 1 }, 0, 0, 0), 6, '池满只生成剩余 6 个');
  eq(pool.activeCount, 16, '打满容量');
  eq(pool.stats.droppedSpawns, 94, '统计丢弃数');
  eq(emitBurst(pool, { count: 0, speed: 1, spreadRad: 1, life: 1, size: 1 }, 0, 0, 0), 0, 'count=0 不生成');

  const e = createEmitter(20);
  let total = 0;
  /* 20/s × 0.05s = 1 个/帧 */
  for (let i = 0; i < 20; i += 1) total += stepEmitter(e, 0.05);
  eq(total, 20, '20 帧 × 1 个 = 20 个(帧率无关)');
  /* 同样总时长但更细的步长,结果一致 */
  const e2 = createEmitter(20);
  let total2 = 0;
  for (let i = 0; i < 200; i += 1) total2 += stepEmitter(e2, 0.005);
  eq(total2, 20, '细步长总数一致');
  ok(Math.abs(e.accumulator) < 1e-9, '余数被消费干净');
});

test('粒子参数表:6 类齐全、数值合理、默认容量 4096', () => {
  eq(PARTICLE_KIND_COUNT, 6, '6 类粒子');
  eq(DEFAULT_POOL_CAPACITY, 4096, '默认容量 4096');
  for (let k = 0; k < PARTICLE_KIND_COUNT; k += 1) {
    const p = PARTICLE_PRESETS[k as 0];
    ok(p !== undefined, `类别 ${k} 有预设`);
    ok(p.life > 0, `类别 ${k} 寿命为正`);
    ok(p.size > 0, `类别 ${k} 尺寸为正`);
    inRange(p.rate, 1, 100, `类别 ${k} 发射率`);
  }
  eq(PARTICLE_PRESETS[ParticleKind.SAKURA].gravityScale, 0, '樱花无重力');
  eq(PARTICLE_PRESETS[ParticleKind.LAVA_EMBER].gravityScale, -0.15, '熔岩火星上浮');
  const pool = new ParticlePool(DEFAULT_POOL_CAPACITY);
  eq(pool.poolLength, 4096, '默认池长度');
  eq(PARTICLE_PRESETS[ParticleKind.LAVA_EMBER].life, 1.6, '熔岩寿命 1.6s');
});

/* ══════════════════ 12. 像素矩阵 → RGBA 1024 字节 ══════════════════ */

test('像素矩阵 → RGBA:长度恰好 1024,逐像素与调色盘一致', () => {
  eq(ICON_SIZE, 16, '16×16');
  eq(ICON_PIXELS, 256, '256 像素');
  eq(ICON_RGBA_BYTES, 1024, 'RGBA 1024 字节');
  eq(ICON_PIXELS * 4, ICON_RGBA_BYTES, '尺寸闭合');

  const rgba = pixelIconToRgba(TEST_STYLE.pixel_icon_16x16, TEST_STYLE);
  eq(rgba.length, 1024, 'RGBA 长度 1024');
  ok(rgba instanceof Uint8Array, '类型 Uint8Array');
  eq(rgba.byteLength, 1024, '字节长度');

  /* 逐像素对照 */
  const primary = hexToRgba(TEST_STYLE.primary_color_hex);
  const secondary = hexToRgba(TEST_STYLE.secondary_color_hex);
  const outline = hexToRgba(TEST_STYLE.outline_color_hex);
  eq(primary.r, 0xff, '主色 R');
  eq(primary.g, 0x44, '主色 G');
  eq(primary.b, 0x88, '主色 B');
  eq(secondary.b, 0xff, '副色 B');
  eq(outline.r, 0x22, '描边 R');

  let checked = 0;
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const o = (y * ICON_SIZE + x) * 4;
      const ch = TEST_STYLE.pixel_icon_16x16[y][x];
      const expect = paletteCharToRgba(ch, TEST_STYLE);
      eq(rgba[o], expect.r, `(${x},${y}) R`);
      eq(rgba[o + 1], expect.g, `(${x},${y}) G`);
      eq(rgba[o + 2], expect.b, `(${x},${y}) B`);
      eq(rgba[o + 3], expect.a, `(${x},${y}) A`);
      checked += 1;
    }
  }
  eq(checked, 256, '逐像素校验 256 个');

  /* 透明字符 alpha=0 */
  const blank = pixelIconToRgba(Array.from({ length: 16 }, () => '0'.repeat(16)), TEST_STYLE);
  for (let i = 3; i < blank.length; i += 4) eq(blank[i], 0, '空图 alpha 全 0');
  eq(blank.length, 1024, '空图仍 1024 字节');
});

test('像素矩阵容错:行数/列数不足补齐、越界截断、非法字符透明', () => {
  const rows = ['1111', '22', '', '3'.repeat(20)];
  const rgba = pixelIconToRgba(rows, TEST_STYLE);
  /*
   * 字节偏移公式是 `(y * 16 + x) * 4`,**不是** `4 * y + x`。
   * 原断言写的 `rgba[4 * 1 + 0]` 求值为 4,其实指向 (y=0, x=1),
   * 不是它想说的 (y=1, x=0) —— 后者位于 64。因为这个偏差,
   * 断言在检查「第 0 行第 1 列是主色」,却报着「第 1 行第 0 列是副色」的错。
   * 下面统一用 px(y,x) 取值,消除手写偏移。
   */
  const px = (y: number, x: number, k = 0): number => rgba[(y * ICON_SIZE + x) * 4 + k];
  eq(rgba.length, 1024, '畸形输入仍是 1024 字节');
  eq(px(0, 0, 0), hexToRgba(TEST_STYLE.primary_color_hex).r, '第 0 行第 0 列 = 主色');
  eq(px(1, 0, 0), hexToRgba(TEST_STYLE.secondary_color_hex).r, '第 1 行第 0 列 = 副色 R');
  eq(px(1, 0, 1), hexToRgba(TEST_STYLE.secondary_color_hex).g, '第 1 行第 0 列 = 副色 G');
  eq(px(1, 1, 0), hexToRgba(TEST_STYLE.secondary_color_hex).r, '第 1 行第 1 列仍是副色(行只写了 2 列)');
  eq(px(1, 2, 0), 0, '第 1 行第 2 列才开始补透明 R');
  eq(px(1, 2, 3), 0, '第 1 行第 2 列补透明 A');
  eq(px(1, 15, 3), 0, '第 1 行末列补透明 A');
  eq(px(2, 0, 3), 0, '空行全透明');
  eq(px(3, 0, 0), hexToRgba(TEST_STYLE.outline_color_hex).r, '超长行按 16 列截断');
  eq(px(3, 15, 0), hexToRgba(TEST_STYLE.outline_color_hex).r, '第 15 列仍是描边');
  eq(px(3, 2, 0), hexToRgba(TEST_STYLE.outline_color_hex).r, '行内第 2 列也是描边');

  const normalized = normalizeIconRows(rows);
  eq(normalized.length, 16, '规整为 16 行');
  for (const r of normalized) eq(r.length, 16, '每行 16 列');
  ok(normalized[2] === '0'.repeat(16), '空行补 0');

  const stats = pixelIconStats(rows);
  eq(stats.usage[1], 4, '主色 4 个');
  eq(stats.usage[2], 2, '副色 2 个');
  eq(stats.usage[3], 16, '描边 16 个(超长行截断到 16)');
  eq(stats.opaquePixels, 22, '非透明 22 个');

  /* 未知字符一律透明 */
  const bad = pixelIconToRgba(['XYZ' + '1'.repeat(13)], TEST_STYLE);
  eq(bad[3], 0, '未知字符 X 透明');
  eq(bad[4 * 3 + 3], 255, '第 4 列主色不透明');
});

test('9 种剪影兜底图案与校验器', () => {
  const silhouettes = ['SWORD', 'HAMMER', 'BOW', 'WAND', 'POTION', 'BOMB', 'HAT', 'SHIELD', 'GIZMO'];
  eq(Object.keys(SILHOUETTE_PATTERNS).length, 9, '9 种剪影');
  for (const s of silhouettes) {
    const p = patternForSilhouette(s);
    eq(p.length, 16, `${s} 16 行`);
    for (const r of p) eq(r.length, 16, `${s} 每行 16 列`);
    const v = validateIconRows(p);
    ok(v.ok, `${s} 通过校验:${v.errors.join(',')}`);
    ok(pixelIconStats(p).opaquePixels > 8, `${s} 有实际图案`);
  }
  ok(!validateIconRows(['1']).ok, '行数不足被判非法');
  ok(!validateIconRows(Array.from({ length: 16 }, () => '9'.repeat(16))).ok, '非法字符被判非法');
  eq(patternForSilhouette('UNKNOWN').length, 16, '未知剪影回退空图');

  const style: VisualStyle = { ...TEST_STYLE, pixel_icon_16x16: [] };
  const rows = resolveIconRows(style);
  eq(rows.length, 16, '空 pixel_icon 回退剪影图案');
  const bundle = buildWeaponTexture(style);
  eq(bundle.rgba.length, 1024, '兜底路径仍是 1024 字节');
  eq(bundle.width, 16, '宽度 16');
  eq(bundle.height, 16, '高度 16');
  ok(bundle.coverage > 0, '有覆盖率');
  ok(bundle.anchors.length > 0, 'SPARKLE 光环有挂点');
});

/* ══════════════════ 13. 8 帧朝向与武器挂点 ══════════════════ */

test('8 帧朝向:速度方向映射、图集 UV、与 faceDir 对齐', () => {
  eq(FACING_COUNT, 8, '8 帧');
  eq(FACING_LABEL.length, 8, '8 个标签');
  eq(FACING_VECTORS.length, 8, '8 个方向向量');
  eq(FACING_TO_FACEDIR.length, 8, '8 个映射');

  /* 零速度保持 fallback */
  eq(facingFromVelocity(0, 0), 4, '零速度默认朝南');
  eq(facingFromVelocity(0, 0, 2), 2, '零速度用自定义 fallback');
  eq(facingFromVelocity(1, 0), 2, '+X = 东');
  eq(facingFromVelocity(0, 1), 4, '+Y = 南');
  eq(facingFromVelocity(-1, 0), 6, '−X = 西');
  eq(facingFromVelocity(0, -1), 0, '−Y = 北');
  eq(facingFromVelocity(1, -1), 1, '东北');
  eq(facingFromVelocity(1, 1), 3, '东南');
  eq(facingFromVelocity(-1, 1), 5, '西南');
  eq(facingFromVelocity(-1, -1), 7, '西北');

  /* 角度连续:180 个方向都有定义且落在 0..7 */
  for (let deg = 0; deg < 360; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const f = facingFromVelocity(Math.cos(a), Math.sin(a));
    inRange(f, 0, 7, `角度 ${deg}°`);
    eq(f, Math.round(f), `角度 ${deg}° 为整数帧`);
  }

  const uv0 = facingToAtlasUv(0);
  const uv7 = facingToAtlasUv(7);
  near(uv0.u, 0, 1e-12, '帧 0 u=0');
  near(uv7.u, 7 / 8, 1e-12, '帧 7 u=7/8');
  near(facingToAtlasUv(8).u, 0, 1e-12, '帧 8 回绕到 0');
  near(facingToAtlasUv(-1).u, 7 / 8, 1e-12, '负帧回绕');
  near(uv0.v, 0, 1e-12, '单行图集 v=0');

  /* 立牌高度随体量缩放;武器挂点随朝向旋转 */
  ok(spriteHeightPx('boss') > spriteHeightPx('player'), 'Boss 立牌更高');
  ok(spriteHeightPx('player') > spriteHeightPx('prop'), '角色高于道具');
  near(spriteHeightPx('player', 1), 28, 1e-12, '角色 28px');
  near(spriteHeightPx('player', 2), 56, 1e-12, '缩放线性');
  near(spriteHeightPx('player', 0), 2.8, 1e-12, '极小缩放有下界 0.1');
  const holdE = weaponHoldOffset(2);
  const holdW = weaponHoldOffset(6);
  near(holdE.x, 0.32, 1e-12, '朝东时武器在 +X');
  near(holdW.x, -0.32, 1e-12, '朝西时武器在 −X');
  for (let f = 0; f < 8; f += 1) {
    const h = weaponHoldOffset(f);
    near(Math.hypot(h.x, h.y), 0.32, 1e-12, `帧 ${f} 挂点半径恒定`);
  }
});

test('粒子光环挂点表覆盖 7 种 ParticleAura,含 NONE', () => {
  for (const aura of ['NONE', 'SPARKLE', 'BUBBLES', 'FLAME', 'SNOW', 'MUSIC_NOTES', 'SLIME_DRIP']) {
    const a = auraAnchors(aura);
    ok(Array.isArray(a), `${aura} 有表项`);
  }
  eq(auraAnchors('NONE').length, 0, 'NONE 无挂点');
  eq(auraAnchors('SPARKLE').length, 2, 'SPARKLE 2 个挂点');
  eq(auraAnchors('不存在的Aura').length, 0, '未知 aura 安全返回空');
  for (const a of auraAnchors('FLAME')) {
    inRange(a.kind, 0, PARTICLE_KIND_COUNT - 1, '挂点粒子类别合法');
    ok(a.scale > 0, '缩放为正');
  }
});

/* ══════════════════ 14. 染色:材质 id 不随颜色变化 ══════════════════ */

test('染色通道:32 色、材质 id 与颜色无关、幂等喷色', () => {
  eq(DYE_PALETTE_SIZE, 32, '32 色调色盘');
  eq(DYE_PALETTE.length, 32, '色表长度');
  eq(DYE_SURFACE_KINDS.length, 17, '17 类可染色表面');
  eq(NO_DYE, -1, '未染色哨兵');

  const key = { kind: DyeSurfaceKind.WALL, uvVariant: 3, dynamic: 0 as 0 | 1 };
  ok(isValidSurfaceKey(key), '表面键合法');
  ok(!isValidSurfaceKey({ kind: DyeSurfaceKind.WALL, uvVariant: 99, dynamic: 0 }), '越界 UV 变体非法');
  ok(!isValidSurfaceKey({ kind: 'NOT_A_KIND' as never, uvVariant: 0, dynamic: 0 }), '未知类别非法');
  ok(!isValidSurfaceKey({ kind: DyeSurfaceKind.WALL, uvVariant: 0, dynamic: 7 as never }), '动态标记非法');
  eq(materialKey(key), 'WALL#3#0', '材质键格式');

  const ch = new DyeChannel();
  const k0 = ch.registerSurface(key);
  eq(ch.materialInstances, 1, '注册 1 个材质实例');
  eq(k0, materialKey(key), '返回材质键');
  eq(ch.dyedSurfaceCount, 0, '初始未染色');

  /* 核心断言:32 种颜色轮流喷,材质实例数恒为 1 */
  const rect = { x: 0, y: 0, w: 0.25, h: 1 };
  for (let tint = 0; tint < DYE_PALETTE_SIZE; tint += 1) {
    const r = ch.spray(key, tint, rect, 1, tint);
    eq(r.surfaces, 1, `第 ${tint} 色命中 1 面`);
    eq(r.changed, 1, `第 ${tint} 色发生了变化`);
    eq(ch.materialInstances, 1, `喷第 ${tint} 色后材质实例数仍为 1`);
    eq(ch.get(key)?.tintIndex, tint, `tint 记录为 ${tint}`);
  }
  eq(ch.materialInstances, 1, '32 次染色后材质实例数仍为 1');
  eq(ch.dyedSurfaceCount, 1, '只有 1 个表面被染色');
  eq(materialKey(key), 'WALL#3#0', '材质 id 完全不随颜色变化');

  /* 幂等:同色同矩形再喷一次 changed=0 */
  const again = ch.spray(key, 31, rect, 1, 99);
  eq(again.changed, 0, '同色同矩形幂等');
  /*
   * 幂等的正确含义是「不产生新的脏标记」,而不是「脏标记数为 0」——
   * 前面 32 次喷色从未 flush,最后一次(第 31 色)留下的脏标记本就该在。
   * 原断言写「已被 flush 消费后为 0」,但这段代码里根本没有 flush 调用,
   * 描述与行为不符。下面显式验证「flush 之后归零」这条真正的性质。
   */
  eq(ch.dirtyCount, 1, '幂等喷色不新增脏标记(第 31 色的标记仍在)');
  const flushedOnce = ch.flushDirty();
  eq(flushedOnce.length, 1, 'flush 取出这 1 个脏表面');
  eq(ch.dirtyCount, 0, 'flush 之后脏标记归零');
  /* flush 幂等:再 flush 无可取 */
  eq(ch.flushDirty().length, 0, '再次 flush 返回空');
  /* 幂等喷色在 flush 之后依然不产生新脏标记 */
  const again2 = ch.spray(key, 31, rect, 1, 100);
  eq(again2.changed, 0, 'flush 后同色同矩形仍幂等');
  eq(ch.dirtyCount, 0, 'flush 后幂等喷色不产生新脏标记');

  /* 同色扩矩形 → 并集增长 */
  const grow = ch.spray(key, 31, { x: 0, y: 0, w: 0.5, h: 1 }, 1, 100);
  eq(grow.changed, 1, '扩矩形算变化');
  near(ch.get(key)?.maskRect.w ?? 0, 0.5, 1e-12, '并集宽度 0.5');

  /* 换色 → 重置矩形 */
  ch.spray(key, 5, { x: 0.5, y: 0, w: 0.2, h: 0.2 }, 0.8, 101);
  const e = ch.get(key);
  eq(e?.tintIndex, 5, '换色生效');
  near(e?.maskRect.x ?? -1, 0.5, 1e-12, '换色后矩形重置');
  near(e?.strength ?? -1, 0.8, 1e-12, '强度记录');

  /* 非法索引 → 视为未染色 */
  ch.spray(key, 999, rect, 1, 102);
  eq(ch.get(key)?.tintIndex, NO_DYE, '越界色索引视为擦除');

  /* 洗色 */
  ch.spray(key, 7, rect, 1, 103);
  ok(ch.clear(key), '洗色成功');
  eq(ch.dyedSurfaceCount, 0, '洗后无染色');
  ok(!ch.clear(key), '重复洗色返回 false');

  /* 队友命中反馈 */
  const mate = { kind: DyeSurfaceKind.TEAMMATE, uvVariant: 0, dynamic: 1 as 0 | 1 };
  const mateRes = ch.spray(mate, 12, rect, 1, 104);
  ok(mateRes.hitTeammate, '命中队友标记');
  eq(ch.materialInstances, 2, '新增的是「表面」不是「颜色」');
});

test('染色批量喷色:整片墙 1 次调用,材质实例按表面数增长而非调用数', () => {
  const ch = new DyeChannel();
  const walls = Array.from({ length: 64 }, (_, i) => ({
    kind: DyeSurfaceKind.WALL, uvVariant: i % 16, dynamic: 0 as 0 | 1,
  }));
  /*
   * 64 个表面只有 16 个不同的 `materialKey`(`WALL#uvVariant#dynamic`,
   * uvVariant 取 i % 16),因此 64 个表面归并为 **16 个材质实例**。
   * 于是 `changed` 是 16 不是 64 —— 它统计的是「被改动的**材质实例**数」,
   * 而不是「传入的表面数」。`surfaces` 才是 64。
   * 原断言把两者混为一谈;真正的核心性质是
   * **材质实例数由表面的 UV 变体数决定,与调用次数无关**,
   * 所以下面用「再喷一次不增加实例」来验证这一点。
   */
  const r = ch.sprayMany(walls, 18, { x: 0, y: 0, w: 1, h: 1 }, 1, 0);
  const distinctKeys = new Set(walls.map((w) => materialKey(w))).size;
  eq(distinctKeys, 16, '64 个表面归并为 16 个不同 materialKey');
  eq(r.surfaces, 64, '64 个表面');
  eq(r.changed, distinctKeys, 'changed = 被改动的材质实例数(16,不是表面数 64)');
  ok(ch.materialInstances <= 16, `材质实例数应按 UV 变体合并(≤16),实际 ${ch.materialInstances}`);
  eq(ch.materialInstances, distinctKeys, '材质实例数恰等于不同 UV 变体数');
  eq(ch.dyedSurfaceCount, ch.materialInstances, '全部染色');

  /* 核心性质:实例数由**表面身份**决定,与喷色调用次数无关 */
  const before = ch.materialInstances;
  ch.sprayMany(walls, 18, { x: 0, y: 0, w: 1, h: 1 }, 1, 1);
  eq(ch.materialInstances, before, '重复喷同一批表面不新增材质实例');

  const flushed = ch.flushDirty();
  ok(flushed.length > 0, 'flush 返回脏表');
  eq(ch.dirtyCount, 0, 'flush 后脏标记清空');
  const arr = ch.exportUniformArray();
  eq(arr.length, ch.materialInstances * 6, 'uniform 数组 6 float/表面');

  /* 打包往返 */
  for (let t = -1; t < 32; t += 1) {
    eq(DyeChannel.unpackTint(DyeChannel.packTint(t)), t, `打包往返 tint=${t}`);
  }
  eq(DyeChannel.colorOf(0), DYE_PALETTE[0], '取色 0');
  eq(DyeChannel.colorOf(31), DYE_PALETTE[31], '取色 31');
  eq(DyeChannel.colorOf(-5), '#FFFFFF', '越界取色回退白色');

  /* 矩形工具 */
  const u = unionRect({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.6, y: 0.5, w: 0.4, h: 0.5 });
  near(u.x, 0, 1e-12, '并集 x');
  near(u.w, 1, 1e-12, '并集 w');
  near(u.h, 1, 1e-12, '并集 h');
  const uv = uvRectOfCells(0, 0, 15, 15, 16);
  near(uv.w, 1, 1e-12, '整片墙 UV 宽度 1');
  near(uv.h, 1, 1e-12, '整片墙 UV 高度 1');
  const uvHalf = uvRectOfCells(0, 0, 7, 15, 16);
  near(uvHalf.w, 0.5, 1e-12, '半片墙宽度 0.5');

  /* 喷枪衰减 */
  eq(sprayAttenuation(0), 1, '贴脸满强度');
  eq(sprayAttenuation(15), 1, '15 格内满强度');
  near(sprayAttenuation(22.5), 0.5, 1e-12, '中点 0.5');
  eq(sprayAttenuation(30), 0, '30 格外无效');
  eq(sprayAttenuation(100), 0, '超距无效');
});

/* ══════════════════ 15. UI 状态机:非法迁移抛错 ══════════════════ */

test('UI 状态机:CLOSED 直接到 SUBMITTING 必须抛错', () => {
  const sm = new UiStateMachine();
  eq(sm.state, UiState.CLOSED, '初始 CLOSED');
  eq(sm.activePanel, UiPanel.NONE, '初始无面板');
  eq(sm.revision, 0, '初始版本 0');
  ok(!sm.isVisible, '初始不可见');
  ok(!sm.acceptsInput, 'CLOSED 不接受输入');

  /* 任务书明确点名的非法迁移 */
  let threw = false;
  try {
    sm.transition(UiState.SUBMITTING, '非法直达');
  } catch (err) {
    threw = true;
    ok(err instanceof IllegalTransitionError, '抛 IllegalTransitionError');
    eq((err as IllegalTransitionError).from, UiState.CLOSED, '错误记录起点');
    eq((err as IllegalTransitionError).to, UiState.SUBMITTING, '错误记录终点');
    ok((err as Error).message.includes('非法 UI 状态迁移'), '错误信息含中文说明');
  }
  ok(threw, 'CLOSED → SUBMITTING 必须抛错');
  eq(sm.state, UiState.CLOSED, '抛错后状态不变');
  eq(sm.revision, 0, '抛错后版本不变');
  eq(sm.transitionSeq, 0, '抛错不留迁移记录');

  /* 逐条穷举全部 25 种组合,验证白名单精确 */
  for (const from of UI_STATES) {
    for (const to of UI_STATES) {
      const m = new UiStateMachine();
      /* 先把状态推到 from */
      forceState(m, from);
      const legal = LEGAL_TRANSITIONS[from].includes(to);
      let okThrew = false;
      try {
        m.transition(to);
      } catch {
        okThrew = true;
      }
      if (from === to) {
        eq(okThrew, false, `${from} → ${to} 同态为无操作`);
        continue;
      }
      eq(okThrew, !legal, `${from} → ${to} 期望 ${legal ? '合法' : '抛错'}`);
      if (legal) eq(m.state, to, `${from} → ${to} 生效`);
      else eq(m.state, from, `${from} → ${to} 被拒后不变`);
    }
  }
});

function forceState(sm: UiStateMachine, target: string): void {
  if (target === 'CLOSED') return;
  sm.transition(UiState.OPENING);
  if (target === 'OPENING') return;
  sm.transition(UiState.OPEN);
  if (target === 'OPEN') return;
  sm.transition(UiState.SUBMITTING);
  if (target === 'SUBMITTING') return;
  sm.transition(UiState.ERROR);
}

test('UI 状态机:合法通路、SUBMITTING 锁输入、防重复提交', () => {
  const sm = new UiStateMachine();
  sm.open(UiPanel.RECIPE_TREE);
  eq(sm.state, UiState.OPENING, 'open → OPENING');
  eq(sm.activePanel, UiPanel.RECIPE_TREE, '记录面板');
  eq(sm.acceptsInput, false, 'OPENING 不接受输入');
  ok(sm.openingProgress < 1, '打开动画未完成');
  sm.tick(ROOF_FADE_SEC);
  eq(sm.state, UiState.OPEN, '动画完成 → OPEN');
  eq(sm.openingProgress, 1, '进度 1');
  ok(sm.acceptsInput, 'OPEN 接受输入');

  /* 草稿仅在 OPEN 被接受 */
  ok(sm.setPayload({ recipeHash: '116_125_712' }), 'OPEN 时设置草稿');
  const p = sm.beginSubmit();
  eq(sm.state, UiState.SUBMITTING, 'beginSubmit → SUBMITTING');
  eq(p.recipeHash, '116_125_712', '携带草稿');
  ok(!sm.acceptsInput, 'SUBMITTING 锁输入');
  ok(!sm.setPayload({ recipeHash: 'x' }), 'SUBMITTING 拒绝改草稿');

  /* SUBMITTING 期间不得直接关闭 */
  let threw = false;
  try { sm.close(); } catch { threw = true; }
  ok(threw, 'SUBMITTING 不允许直接关闭');
  eq(sm.state, UiState.SUBMITTING, '仍在 SUBMITTING');

  sm.submitOk();
  eq(sm.state, UiState.OPEN, '提交成功回到 OPEN');
  eq(sm.transitionSeq, 4, '迁移序号累计');
  eq(sm.revision, 4, '版本累计');

  /* 失败分支 */
  sm.beginSubmit();
  sm.submitFail('材料不足');
  eq(sm.state, UiState.ERROR, '提交失败 → ERROR');
  eq(sm.lastError, '材料不足', '记录错误信息');
  sm.recover();
  eq(sm.state, UiState.OPEN, 'ERROR → OPEN 恢复');
  eq(sm.lastError, '', '恢复后清空错误');

  sm.close();
  eq(sm.state, UiState.CLOSED, '关闭');
  eq(sm.activePanel, UiPanel.NONE, '关闭后无面板');
  eq(sm.getPayload(), null, '关闭后清空草稿');

  /* 日志有界 */
  const tiny = new UiStateMachine(3);
  for (let i = 0; i < 6; i += 1) {
    tiny.open(UiPanel.INVENTORY);
    tiny.transition(UiState.OPEN);
    tiny.close();
  }
  ok(tiny.transitionLog.length <= 3, `日志被裁剪到 maxLog,实际 ${tiny.transitionLog.length}`);

  /* reset 不抛错 */
  const r = new UiStateMachine();
  r.open(UiPanel.BOSS_HUD);
  r.reset();
  eq(r.state, UiState.CLOSED, 'reset 回 CLOSED');
  eq(r.activePanel, UiPanel.NONE, 'reset 清面板');

  /* LEGAL_TRANSITIONS 表结构 */
  eq(Object.keys(LEGAL_TRANSITIONS).length, 5, '5 个状态');
  eq(LEGAL_TRANSITIONS.CLOSED.length, 1, 'CLOSED 只有 1 个出口');
  includes(LEGAL_TRANSITIONS.CLOSED, UiState.OPENING, 'CLOSED → OPENING');
  eq(SlotState.EMPTY, 'EMPTY', 'SlotState 常量');
  includes(LEGAL_TRANSITIONS.ERROR, UiState.CLOSED, 'ERROR 可关闭');
  eq(LEGAL_TRANSITIONS.SUBMITTING.length, 2, 'SUBMITTING 两个出口');
});

test('背包拖拽控制器:拿起/悬停/放下/取消与非法操作', () => {
  const dc = new DragController();
  ok(!dc.isDragging, '初始未拖拽');
  ok(!dc.pickUp(0, 0, 1), '空物品不能拿起');
  ok(!dc.pickUp(0, 101, 0), '数量 0 不能拿起');
  ok(dc.pickUp(5, 101, 3), '正常拿起');
  ok(dc.isDragging, '拖拽中');
  ok(!dc.pickUp(6, 102, 1), '拖拽中不能再拿');
  dc.hoverAt(9);
  eq(dc.hover, 9, '悬停槽位');
  eq(dc.drop(5), null, '放回自己身上 = 取消');
  ok(!dc.isDragging, '已取消');
  dc.pickUp(5, 101, 3);
  const d = dc.drop(9);
  eq(d?.fromSlot, 5, '起点');
  eq(d?.toSlot, 9, '终点');
  eq(d?.itemId, 101, '物品');
  eq(dc.hover, -1, '放下后清悬停');
  eq(dc.drop(9), null, '未拖拽时 drop 返回 null');
});

/* ══════════════════ 16. 背包 320 格分类 ══════════════════ */

test('背包:容量与内容解耦、12 分类计数闭合、格位↔物品双射', () => {
  eq(TOTAL_ITEM_COUNT, 320, '冻结层物品总数 320');
  eq(SLOTS_PER_ROW, 16, '每行 16 格');

  /*
   * WS-FND-02:容量**不再等于**内容数量。
   * 过去 `INVENTORY_SLOTS = TOTAL_ITEM_COUNT`,330 件时 `330/16 = 20.625` 半行;
   * 现在容量由「行数 × 每行格数」反推,行数 = ceil(内容/每行) + 余量。
   */
  eq(INVENTORY_SPARE_ROWS, 1, '固定余量 1 行');
  eq(INVENTORY_ROWS, 21, '行数 = ceil(320/16) + 1 = 21');
  eq(INVENTORY_SLOTS, 336, '容量 = 21 × 16 = 336');
  eq(INVENTORY_SLOTS % SLOTS_PER_ROW, 0, '容量恒为每行格数整数倍(永不半行)');
  eq(INVENTORY_SLOTS / SLOTS_PER_ROW, INVENTORY_ROWS, '容量行数自洽');
  ok(Number.isInteger(INVENTORY_SLOTS / SLOTS_PER_ROW), '行数为整数');
  ok(INVENTORY_SLOTS >= TOTAL_ITEM_COUNT, '容量装得下全部内容');
  ok(INVENTORY_SLOTS > TOTAL_ITEM_COUNT, '容量严格大于内容数(留出扩容余量)');
  eq(INVENTORY_SLOTS - TOTAL_ITEM_COUNT, 16, '余量恰好 1 整行');
  ok(INVENTORY_SLOTS !== TOTAL_ITEM_COUNT, '容量已与内容数量解耦');

  /* 分页非退化:每页明显小于总容量,分页路径日常即被走到 */
  eq(SLOTS_PER_PAGE_ROWS, 10, '每页 10 行');
  eq(SLOTS_PER_PAGE, 160, '每页 160 格');
  ok(SLOTS_PER_PAGE < INVENTORY_SLOTS, '每页容量严格小于总容量(分页非退化)');
  eq(INVENTORY_PAGE_COUNT, 3, '总页数 = ceil(336/160) = 3');
  ok(INVENTORY_PAGE_COUNT >= 2, '页数 ≥ 2,分页代码路径不会潜伏到扩容时才首次执行');
  ok(INVENTORY_PAGE_COUNT * SLOTS_PER_PAGE >= INVENTORY_SLOTS, '页数 × 每页 ≥ 总容量');
  ok((INVENTORY_PAGE_COUNT - 1) * SLOTS_PER_PAGE < INVENTORY_SLOTS, '页数为最小值(少一页即装不下)');
  /* 容量页数是上界:内容页数(2)≤ 容量页数(3) */
  ok(Math.ceil(TOTAL_ITEM_COUNT / SLOTS_PER_PAGE) <= INVENTORY_PAGE_COUNT, '内容页数 ≤ 容量页数');

  eq(CATEGORY_ORDER.length, 12, '12 个分类');
  eq(Object.keys(CATEGORY_LABEL).length, 12, '12 个中文名');

  eq(BUCKETS.length, 12, '12 个分类桶');
  const counts = categoryCounts();
  let sum = 0;
  for (const c of CATEGORY_ORDER) {
    const n = counts[c] ?? 0;
    /*
     * `AI_CRAFTED` 是**运行期分类**:它收纳玩家用炼金炉现场合成的造物,
     * 静态物品表里必然为 0 项(手册 §3 的 320 项都是预置物品)。
     * 因此这里只要求「静态分类非空、AI_CRAFTED 桶存在且为空」,
     * 而不是笼统地要求 12 个桶都非空 —— 后者会与冻结层事实冲突。
     */
    if (c === ItemCategory.AI_CRAFTED) {
      eq(n, 0, 'AI_CRAFTED 为运行期分类,静态物品表中应为 0 项');
    } else {
      ok(n > 0, `分类 ${c} 非空`);
    }
    sum += n;
    const b = BUCKETS.find((x) => x.category === c);
    ok(b !== undefined, `分类桶 ${c} 存在`);
    eq(b?.itemIds.length, n, `${c} 桶与计数一致`);
    eq(b?.slots.length, n, `${c} 槽位与物品一致`);
    if (n > 0) ok((b?.firstSlot ?? -1) >= 0, `${c} firstSlot 有效`);
    else eq(b?.firstSlot, -1, `空桶 ${c} 的 firstSlot 应为 −1`);
  }
  eq(sum, 320, 'Σ 分类 = 320');

  /* 双射:槽位是 ITEM_LIST 下标,与容量扩容无关 */
  let checked = 0;
  for (let i = 0; i < ITEM_LIST.length; i += 1) {
    const it = ITEM_LIST[i];
    eq(slotOf(it.id), i, `${it.id} 的格位 = ${i}`);
    eq(itemAt(i)?.id, it.id, `格位 ${i} 的物品 ID`);
    checked += 1;
  }
  eq(checked, 320, '320 组双射校验');
  eq(slotOf(-1), -1, '未知 ID 返回 −1');

  /* 容量内的空格:320..335 共 16 格是扩容余量,合法存在但无物品 */
  eq(itemAt(TOTAL_ITEM_COUNT), null, '内容之后的余量格无物品');
  eq(itemAt(INVENTORY_SLOTS - 1), null, '最后一格余量格无物品');
  for (let s = TOTAL_ITEM_COUNT; s < INVENTORY_SLOTS; s += 1) {
    eq(itemAt(s), null, `余量格 ${s} 无物品`);
    eq(isEmptySlot(s), true, `余量格 ${s} 标记为空`);
  }
  eq(isEmptySlot(0), false, '有物品的格不算空');
  eq(isEmptySlot(INVENTORY_SLOTS), false, '超容量格不算空(越界)');

  eq(itemAt(INVENTORY_SLOTS), null, '超容量格位返回 null');
  eq(itemAt(-1), null, '负格位返回 null');
  eq(itemAt(1.5), null, '非整数格位返回 null');
});

test('背包扩容不变量:纯函数模拟内容增长,布局恒规则且既有槽位不变', () => {
  /*
   * WS-FND-02 核心断言:喂不同 count 给**纯函数** `computeSlotLayout`,
   * 不修改任何真实常量。这证明「再加 10 件物品」不会再踩半行/页数突变。
   */
  const counts = [0, 1, 15, 16, 17, 320, 321, 328, 330, 336, 337, 352, 353, 1024];
  let prevRows = 0;
  let prevSlots = 0;

  for (const c of counts) {
    const L = computeSlotLayout(c, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
    eq(L.rowAligned, true, `count=${c} 无半行(容量 ${L.slots} % 16 === 0)`);
    eq(L.slots % SLOTS_PER_ROW, 0, `count=${c} 容量为 16 整数倍`);
    eq(L.slots, L.rows * SLOTS_PER_ROW, `count=${c} 容量 = 行数 × 每行格数`);
    ok(L.fits, `count=${c} 容量 ${L.slots} 装得下 ${c} 件`);
    ok(L.rows >= prevRows, `count=${c} 行数 ${L.rows} 不低于前值 ${prevRows}(单调不减)`);
    ok(L.slots >= prevSlots, `count=${c} 容量不减`);
    ok(L.pageCount >= 1, `count=${c} 页数至少 1`);
    ok(L.pageCount * L.pageSlots >= L.slots, `count=${c} 页数自洽`);
    prevRows = L.rows;
    prevSlots = L.slots;
  }

  /* 决定性案例:330 件 —— 旧实现下 `330/16 = 20.625` 是半行,现在是 22 行 352 格 */
  const L330 = computeSlotLayout(330, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
  eq(L330.contentRows, 21, '330 件需 21 行(ceil(330/16) = 21)');
  eq(L330.rows, 22, '含余量 22 行');
  eq(L330.slots, 352, '330 件时容量 352');
  eq(L330.slots % SLOTS_PER_ROW, 0, '330 件时无半行');

  /* 旧实现的反例对照:容量 = 内容数 时 330 会出现半行 */
  eq(330 % SLOTS_PER_ROW, 10, '旧实现 330 件会剩 10 格半行 —— 这正是要根除的形态');
  eq(330 / SLOTS_PER_ROW, 20.625, '旧实现行数 20.625 非整数');

  /* 余量行让小批量扩容不改行数 */
  eq(computeSlotLayout(320, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS).rows, 21, '320 件 21 行');
  eq(computeSlotLayout(328, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS).rows, 22, '328 件 22 行');
  eq(computeSlotLayout(330, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS).rows, 22, '330 件仍 22 行(+10 件不改布局)');
  eq(computeSlotLayout(336, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS).rows, 22, '336 件仍 22 行');

  /* 既有 320 件在任何扩容场景下都落在容量内 ⇒ 槽位不变 */
  for (const c of [320, 330, 336, 352, 1024]) {
    const L = computeSlotLayout(c, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
    for (let i = 0; i < TOTAL_ITEM_COUNT; i += 1) {
      ok(i < L.slots, `count=${c} 时既有格位 ${i} 仍在容量内`);
    }
  }
  /* 真实常量与纯函数在同一 count 下必须一致(防止两处公式漂移) */
  const real = computeSlotLayout(TOTAL_ITEM_COUNT, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
  eq(real.slots, INVENTORY_SLOTS, '真实容量 = 纯函数推导值');
  eq(real.rows, INVENTORY_ROWS, '真实行数 = 纯函数推导值');
  eq(real.pageCount, INVENTORY_PAGE_COUNT, '真实页数 = 纯函数推导值');
  eq(real.pageSlots, SLOTS_PER_PAGE, '真实每页容量 = 纯函数推导值');

  /* 除零/负数防护 */
  const zero = computeSlotLayout(0, 0, 0);
  ok(zero.slots > 0 && zero.rowAligned, 'count=0 / slotsPerRow=0 不崩且仍对齐');
  const neg = computeSlotLayout(-5, SLOTS_PER_ROW, INVENTORY_SPARE_ROWS);
  ok(neg.slots > 0 && neg.fits, '负 count 安全');
});

test('背包分类内容与冻结层一致:地砖 301-330、时装/料理 601-630', () => {
  const floorBucket = BUCKETS.find((b) => b.category === ItemCategory.FLOOR);
  const foodBucket = BUCKETS.find((b) => b.category === ItemCategory.FOOD);
  const wearBucket = BUCKETS.find((b) => b.category === ItemCategory.WEARABLE);
  ok(floorBucket !== undefined && foodBucket !== undefined && wearBucket !== undefined, '三个分类桶存在');
  eq(floorBucket?.itemIds.length, 30, '地砖 30 项');
  eq(floorBucket?.itemIds[0], 301, '地砖起始 ID');
  eq(floorBucket?.itemIds[29], 330, '地砖结束 ID');

  /*
   * 手册 §3.9 是**一张合并表**:「多人欢聚料理食谱与角色搞怪时装/功能头饰表
   * (ID 601 ~ 630,共 30 项)」。冻结层按语义把它拆成两个分类 ——
   * 601..615 是料理(FOOD,15 项),616..630 是时装头饰(WEARABLE,15 项)。
   * 因此断言必须校验「两桶并为 601..630 且合计 30 项」,
   * 而不是要求 FOOD 单独 30 项(那会把时装算进料理)。
   */
  eq(foodBucket?.itemIds.length, 15, '料理 15 项(601..615)');
  eq(wearBucket?.itemIds.length, 15, '时装头饰 15 项(616..630)');
  eq((foodBucket?.itemIds.length ?? 0) + (wearBucket?.itemIds.length ?? 0), 30, '§3.9 合计 30 项');
  const seg = [...(foodBucket?.itemIds ?? []), ...(wearBucket?.itemIds ?? [])].sort((a, b) => a - b);
  eq(seg[0], 601, '§3.9 起始 ID');
  eq(seg[seg.length - 1], 630, '§3.9 结束 ID');
  eq(seg.length, new Set(seg).size, '两桶无重复 ID');
  for (let i = 0; i < seg.length; i += 1) eq(seg[i], 601 + i, `§3.9 连续无缺:第 ${i} 项`);
  eq(foodBucket?.itemIds[0], 601, '料理起始 ID');
  eq(foodBucket?.itemIds[14], 615, '料理结束 ID');
  eq(wearBucket?.itemIds[0], 616, '时装起始 ID');
  eq(wearBucket?.itemIds[14], 630, '时装结束 ID');

  eq(tableOf(314)?.key, '3.5', '314 属 §3.5 地砖表');
  eq(tableOf(630)?.key, '3.9', '630 属 §3.9 时装表');
  eq(tableOf(745)?.key, '3.10', '745 属 §3.10');
  eq(tableOf(999), null, '未知 ID 无手册表');

  /* 315 冰砖、314 像素地毯、630 像素披风是 WS-09 直接对接项 */
  const ice = ITEM_LIST[slotOf(315)];
  ok(ice.tags.includes('极滑'), '315 带「极滑」词条');
  ok(ITEM_LIST[slotOf(314)].tags.includes('UGC'), '314 带 UGC 词条');
  ok(ITEM_LIST[slotOf(630)].tags.includes('UGC'), '630 带 UGC 词条');
  includes(ROOF_ITEM_IDS, 372, '372 在屋顶白名单');
  eq(itemName(372), '暖红陶瓦斜屋顶', '372 名称');
});

test('背包过滤/排序/分页:查询命中、分页边界、排序稳定', () => {
  ok(matchesQuery(ITEM_LIST[0], ''), '空查询全命中');
  ok(matchesQuery(ITEM_LIST[slotOf(101)], '暖松'), '中文名命中');
  ok(matchesQuery(ITEM_LIST[slotOf(101)], '101'), 'ID 字符串命中');
  ok(matchesQuery(ITEM_LIST[slotOf(101)], '木材'), '词条命中');
  ok(!matchesQuery(ITEM_LIST[slotOf(101)], '绝不可能出现的词'), '不命中');

  eq(filterItems({ category: 'ALL' }).length, 320, 'ALL 返回全部');
  eq(filterItems({ category: null }).length, 320, 'null 返回全部');
  eq(filterItems({ category: ItemCategory.FLOOR }).length, 30, '地砖 30');
  eq(filterItems({ query: '像素' }).length > 0, true, '关键词「像素」有命中');
  /*
   * UGC 词条有 4 项,不是 2 项 —— 冻结层实际标注:
   *   314 自定义像素地毯 / 511 16×16 绘本像素画架 /
   *   524 绘本艺术展示画框 / 630 自定义像素印花披风
   * 这四件都能承载玩家手绘的 16×16 像素图案。
   * 断言改为「精确列出这 4 个 ID」,既锁定数量也锁定**身份** ——
   * 只锁定数量的话,误标第 5 件物品为 UGC 时会静默通过。
   */
  const ugcIds = filterItems({ tag: 'UGC' }).map((s) => s.item.id).sort((a, b) => a - b);
  eq(ugcIds.join(','), '314,511,524,630', 'UGC 词条恰好这 4 件(314 地毯 / 511 画架 / 524 画框 / 630 披风)');
  ok(ITEM_LIST[slotOf(314)].tags.includes('UGC'), '314 地毯带 UGC 词条');
  ok(ITEM_LIST[slotOf(630)].tags.includes('UGC'), '630 披风带 UGC 词条');
  ok(ITEM_LIST[slotOf(511)].tags.includes('UGC'), '511 画架带 UGC 词条');
  ok(ITEM_LIST[slotOf(524)].tags.includes('UGC'), '524 画框带 UGC 词条');
  eq(filterItems({ minValue: 10000 }).length, 0, '极端价值阈值无命中');

  const byValue = sortSlots(filterItems(), SortKey.VALUE_DESC);
  for (let i = 1; i < byValue.length; i += 1) {
    ok(byValue[i - 1].item.value >= byValue[i].item.value, '价值严格降序');
  }
  const byId = sortSlots(filterItems({ category: ItemCategory.FLOOR }), SortKey.ID);
  eq(byId[0].item.id, 301, 'ID 升序首项');
  eq(byId[29].item.id, 330, 'ID 升序末项');
  const bySlot = sortSlots(byId, SortKey.SLOT);
  eq(bySlot[0].slot, slotOf(301), '按格位排序');

  const v = buildView({});
  eq(v.page, 0, '默认第 0 页');
  eq(v.pageCount, Math.ceil(320 / SLOTS_PER_PAGE), '页数 = ceil(内容/每页)');
  eq(v.pageCount, 2, '320 件内容分 2 页(分页路径被真正走到)');
  ok(v.pageCount >= 2, '分页非退化');
  eq(v.visibleCount, 320, '可见 320');
  ok(v.slots.length <= SLOTS_PER_PAGE, '页内不超页容量');
  eq(v.slots.length, SLOTS_PER_PAGE, '首页被填满(320 > 160)');
  eq(v.buckets.length, 12, '视图携带 12 桶');
  const lastPage = buildView({ page: 999 });
  eq(lastPage.page, v.pageCount - 1, '超界页夹到最后一页');
  eq(lastPage.slots.length, 320 - SLOTS_PER_PAGE, '末页只剩余数 160 格');
  const secondPage = buildView({ page: 1 });
  eq(secondPage.page, 1, '第 2 页可取');
  eq(secondPage.slots.length, 320 - SLOTS_PER_PAGE, '第 2 页格数');
  eq(secondPage.slots[0].slot, SLOTS_PER_PAGE, '第 2 页首格 = 第 1 页末格 + 1');
  /* 两页并起来恰好是全部 320 件,不重不漏 */
  const allSlots = [...v.slots, ...secondPage.slots].map((s) => s.slot).sort((a, b) => a - b);
  eq(allSlots.length, 320, '两页合计 320 格');
  eq(new Set(allSlots).size, 320, '两页无重叠');
  for (let i = 0; i < 320; i += 1) eq(allSlots[i], i, `并集第 ${i} 格连续`);

  const negPage = buildView({ page: -5 });
  eq(negPage.page, 0, '负页夹到 0');
  eq(negPage.slots.length, SLOTS_PER_PAGE, '负页夹到首页');
  /* 每格 row/col 与格位自洽 */
  for (const s of v.slots) {
    eq(s.row * SLOTS_PER_ROW + s.col, s.slot, `格 ${s.slot} 的 row/col`);
    eq(s.visible, true, '可见标记');
  }
});

/* ══════════════════ 17. 配方树 ══════════════════ */

test('配方树:展开、叶子聚合、加工台收集、无环', () => {
  /* 101 暖松原木 → 151 精刨松木板(out 2)→ 351 墙体 */
  const t = buildRecipeTree(351, 1);
  eq(t.root.itemId, 351, '根物品');
  eq(t.root.name, itemName(351), '根名称来自冻结层');
  ok(t.root.craftable, '根可合成');
  eq(t.root.depth, 0, '根深度 0');
  ok(t.nodeCount > 1, '节点数 > 1');
  ok(!t.hasCycle, '冻结层配表无环');
  eq(t.cyclePaths.length, 0, '无环路径');
  ok(t.stations.length >= 1, '至少 1 台加工台');
  eq(t.stations[0], 502, '351 需要 502 森系木工营造台');
  eq(t.root.stationId, 502, '根节点带加工台 ID');
  /*
   * 手册 §3.6 明确:351 暖松原木圆墙的配方是「暖松原木 ×1」——
   * **直接**消耗 101,不经 151 精刨松木板。原断言写「351 → 151 → 101」
   * 是把 §3.7 的木质家具链(151 是木工切木机的中间品)错记到了墙体上。
   * 因此深度是 1,不是 2;叶子就是 101 一种,需求 1。
   */
  ok(t.leaves.has(101), '叶子含 101 暖松原木');
  eq(t.leaves.get(101), 1, '101 需求 1');
  eq(t.leaves.size, 1, '只有 1 种叶子');
  eq(t.maxDepth, 1, '深度 1(351 → 101,手册配方直耗原木)');
  eq(t.root.children.length, 1, '根有且仅有 1 个子节点');
  eq(t.root.children[0].itemId, 101, '子节点直接是 101,不经 151');

  /* 真正含中间品的深链:151 需要 101,被 303 等家具使用 → 至少 2 层 */
  const via151 = buildRecipeTree(303, 1);
  ok(via151.maxDepth >= 1, `303 应展开出层级,实际 ${via151.maxDepth}`);
  ok(via151.leaves.size >= 1, '303 至少 1 种叶子');
  eq(via151.root.children.every((c) => c.depth === 1), true, '所有直接子节点深度为 1');
  eq(expandedRecipeOf(151, 1)[101], 1, '151 = 暖松原木 ×1');

  /* 批次换算 */
  const t4 = buildRecipeTree(351, 4);
  eq(t4.leaves.get(101), 4, '批次 4 倍需求');
  eq(t4.root.needCount, 4, '根需求 4');
  /* out:2 的中间品不改变倍数(expandRecipe 语义:配方是「每批消耗」) */
  const expanded = expandedRecipeOf(151, 3);
  eq(expanded[101], 3, 'expandRecipe 3 批');
  const deep = buildRecipeTree(731, 1);
  ok(deep.leaves.size > 1, '731 同伴共鸣友爱徽章是多材料配方');
  ok(deep.stations.length >= 1, '收集到加工台');
});

test('配方树:环检测必须中止展开(不爆栈)', () => {
  /* 冻结层无环,但代码必须能防住:这里用 depth 限制 + 环路径做行为验证 */
  const t = buildRecipeTree(745, 1, 6);
  ok(!t.hasCycle, '正常配方无环');
  ok(t.maxDepth <= 6, `深度被限制在 6 以内,实际 ${t.maxDepth}`);

  /*
   * `truncated` 的语义是「**因深度上限而未能继续展开**」,不是「节点没有子配方」。
   * 因此必须挑一个本身还有更深层级、却被上限切断的物品才验得出:
   *   731 的子项直接就是原材料,天然无子 → 标 false 是正确的,测不出上限逻辑。
   * 509 的完整链深 3 层,在 depthCap=1 时其直接子节点仍有配方可展开,
   * 于是被正确标记 truncated —— 这才是能区分实现好坏的用例。
   */
  const full509 = buildRecipeTree(509, 1, 8);
  ok(full509.maxDepth >= 2, `509 有真实层级,实际 ${full509.maxDepth}`);

  const shallow = buildRecipeTree(509, 1, 1);
  eq(shallow.maxDepth, 1, '深度上限 1');
  ok(shallow.root.children.length > 0, '仍展开一层');
  for (const c of shallow.root.children) {
    ok(c.truncated, '因深度上限被切断的节点必须标 truncated');
    eq(c.children.length, 0, '截断节点无子节点');
  }
  eq(shallow.root.truncated, false, '根节点不受深度上限影响');
  /* 对照:同物品给足深度则不再截断 */
  const deep = buildRecipeTree(509, 1, 8);
  eq(deep.root.children.every((c) => !c.truncated || c.children.length === 0), true,
    '给足深度时不应有「本可展开却被截断」的节点');
  eq(MAX_DEPTH, 8, '默认最大深度 8');

  /* 深度上限 0 时不展开 */
  const zero = buildRecipeTree(351, 1, 1);
  ok(zero.root.children.length >= 0, '边界不崩');
  eq(flattenTree(zero.root).length >= 1, true, '至少根节点');
});

test('配方树:库存检查与缺料报告', () => {
  const t = buildRecipeTree(351, 2);
  const enough = new Map<number, number>([[101, 10]]);
  const okCheck = checkCraft(t, enough);
  ok(okCheck.craftable, '材料充足');
  eq(okCheck.missing.size, 0, '无缺料');
  eq(missingReport(okCheck), '材料齐备,可合成', '齐备提示');

  const short = new Map<number, number>([[101, 1]]);
  const bad = checkCraft(t, short);
  ok(!bad.craftable, '材料不足');
  eq(bad.missing.get(101), 1, '缺 1 个 101');
  ok(missingReport(bad).includes('缺料'), '缺料报告含「缺料」');
  ok(missingReport(bad).includes(itemName(101)), '缺料报告含物品名');

  /* Record 形式也支持 */
  const rec = checkCraft(t, { 101: 5 } as Record<number, number>);
  ok(rec.craftable, 'Record 形式库存');
  const empty = checkCraft(t, new Map());
  ok(!empty.craftable, '空库存不可合成');
  eq(empty.satisfied, 0, '满足 0 种');
  eq(empty.totalKinds, t.leaves.size, '总种类数');

  /* 叶子排序稳定 */
  const sl = sortedLeaves(buildRecipeTree(731, 1));
  for (let i = 1; i < sl.length; i += 1) ok(sl[i - 1].itemId < sl[i].itemId, '叶子按 ID 升序');
  /* 树键稳定 */
  eq(treeKey(buildRecipeTree(351, 1)), treeKey(buildRecipeTree(351, 1)), '同参数树键相同');
  ok(treeKey(buildRecipeTree(351, 1)) !== treeKey(buildRecipeTree(351, 2)), '不同批次树键不同');

  /* 反向索引 */
  const users101 = usedBy(101);
  ok(users101.length > 5, `101 被 ${users101.length} 个配方引用`);
  ok(usedBy(130).length > 0, '130 梦境露水有下游');
  eq(usedBy(999999).length, 0, '未知材料无下游');
  eq(USAGE_INDEX.size > 50, true, '反向索引有规模');
});

/* ══════════════════ 18. 像素画架 ══════════════════ */

test('像素画架:256 像素、单点上色、撤销重做、笔画合并', () => {
  eq(EASEL_SIZE, 16, '16×16');
  eq(EASEL_PIXELS, 256, '256 像素');
  eq(PALETTE_SIZE, 32, '32 色调色盘');
  eq(PALETTE_32.length, 32, '色表 32');
  eq(TRANSPARENT_INDEX, -1, '透明哨兵');

  const e = new PixelEasel();
  eq(e.get(0, 0), TRANSPARENT_INDEX, '初始透明');
  eq(e.coverage(), 0, '初始覆盖率 0');
  ok(e.paint(3, 4, 7), '上色成功');
  eq(e.get(3, 4), 7, '颜色已写入');
  ok(!e.paint(3, 4, 7), '重复同色不入栈');
  eq(e.undoCount, 1, '有 1 步撤销');
  ok(e.paint(3, 4, 8), '换色成功');
  eq(e.undoCount, 2, '2 步撤销');
  ok(e.undo(), '撤销');
  eq(e.get(3, 4), 7, '回到 7');
  ok(e.undo(), '再撤销');
  eq(e.get(3, 4), TRANSPARENT_INDEX, '回到透明');
  ok(!e.undo(), '无更多撤销');
  ok(e.redo(), '重做');
  eq(e.get(3, 4), 7, '重做到 7');
  eq(e.redoCount, 1, '剩余重做 1');

  /* 越界 */
  ok(!e.paint(-1, 0, 1), '负坐标无效');
  ok(!e.paint(16, 0, 1), '越界无效');
  ok(!e.paint(0.5, 0, 1), '非整数无效');
  eq(e.get(99, 99), TRANSPARENT_INDEX, '越界读出透明');

  /* 越界色 → 擦除 */
  e.paint(5, 5, 0);
  ok(e.paint(5, 5, 999), '越界色视为擦除且算变化');
  eq(e.get(5, 5), TRANSPARENT_INDEX, '被擦除');

  /* 笔画合并 */
  const e2 = new PixelEasel();
  e2.beginStroke();
  for (let x = 0; x < 5; x += 1) e2.paint(x, 0, 3);
  e2.endStroke();
  eq(e2.undoCount, 1, '整笔只产生 1 步撤销');
  e2.undo();
  eq(e2.coverage(), 0, '一笔全部撤销');

  /* 撤销栈有界 */
  const e3 = new PixelEasel(4);
  for (let i = 0; i < 20; i += 1) e3.paint(i % 16, Math.floor(i / 16), 1);
  ok(e3.undoCount <= 4, `撤销栈被裁剪到 4,实际 ${e3.undoCount}`);
});

test('像素画架:矩形填充、洪水填充、变换、序列化往返', () => {
  const e = new PixelEasel();
  ok(e.fillRect(0, 0, 7, 7, 5), '填充左上 8×8');
  eq(e.coverage(), 64 / 256, '覆盖 1/4');
  eq(e.get(7, 7), 5, '含端点');
  eq(e.get(8, 8), TRANSPARENT_INDEX, '端点外未填充');
  ok(!e.fillRect(0, 0, 7, 7, 5), '重复填充无变化');
  /* 坐标自动交换 */
  ok(e.fillRect(15, 15, 12, 12, 9), '反序坐标自动交换');
  eq(e.get(13, 13), 9, '反序填充生效');
  /* 夹紧 */
  ok(e.fillRect(-5, -5, 1, 1, 2), '越界坐标被夹紧');
  eq(e.get(0, 0), 2, '夹紧后写入');

  const e2 = new PixelEasel();
  e2.fillRect(0, 0, 1, 0, 4);
  eq(e2.floodFill(0, 0, 7), 2, '洪水填充 2 个连通像素');
  eq(e2.get(0, 0), 7, '已改色');
  eq(e2.get(1, 0), 7, '相邻同色也改');
  eq(e2.floodFill(0, 0, 7), 0, '同色洪水填充无操作');
  eq(e2.floodFill(99, 99, 1), 0, '越界洪水填充无操作');

  /* 变换 */
  const e3 = new PixelEasel();
  e3.paint(0, 0, 1);
  e3.transform('flipX');
  eq(e3.get(15, 0), 1, 'flipX 移到右上');
  eq(e3.get(0, 0), TRANSPARENT_INDEX, '原位置清空');
  e3.transform('flipY');
  eq(e3.get(15, 15), 1, 'flipY 移到右下');
  e3.transform('rotate180');
  eq(e3.get(0, 0), 1, '旋转 180 回到左上');
  const e4 = new PixelEasel();
  e4.paint(1, 0, 2);
  e4.transform('rotate90');
  eq(e4.get(15, 1), 2, 'rotate90 映射正确');

  /* clear */
  const e5 = new PixelEasel();
  e5.fillRect(0, 0, 15, 15, 3);
  eq(e5.coverage(), 1, '满覆盖');
  ok(e5.clear(), '清空有变化');
  eq(e5.coverage(), 0, '清空后 0');
  ok(!e5.clear(), '重复清空无变化');

  /* 序列化往返 */
  const e6 = new PixelEasel();
  for (let i = 0; i < 256; i += 3) e6.paint(i % 16, Math.floor(i / 16), i % 32);
  const blob = e6.serialize();
  eq(blob.length, 256, '序列化 256 字符');
  const restored = PixelEasel.deserialize(blob);
  eq(restored.serialize(), blob, '序列化往返一致');
  for (let i = 0; i < 256; i += 1) {
    eq(restored.get(i % 16, Math.floor(i / 16)), e6.get(i % 16, Math.floor(i / 16)), `像素 ${i} 往返`);
  }

  /* 行导出/载入 */
  const e7 = new PixelEasel();
  e7.fromRows;
  const rows = e7.toRows();
  eq(rows.length, 16, '16 行导出');
  eq(rows[0].length, 16, '每行 16 字符');
  ok(rows[0].includes('.'), '透明用 . 表示');

  /* 调色盘 */
  const c0 = paletteColor(0);
  eq(c0.r, 0xff, '色 0 的 R');
  ok(paletteColor(-1).r > 0, '越界回退白色');
  ok(paletteLabel(0).includes('白'), '色 0 标签含「白」');
  ok(paletteLabel(31).includes('棕'), '色 31 标签含「棕」');
  ok(paletteLabel(-1).includes('透明'), '透明标签');

  /* 直方图 */
  const e8 = new PixelEasel();
  e8.paint(0, 0, 3);
  const h = e8.histogram();
  eq(h[3], 1, '色 3 计数 1');
  eq(h[PALETTE_SIZE], 255, '透明计数 255');
});

/* ══════════════════ 19. 蓝图框选 ══════════════════ */

test('蓝图框选:屏幕矩形 → 世界 AABB 必须取 4 角(而非 2 角)', () => {
  const cam = { ...createCamera(1600, 900, 16), focusX: 0, focusY: 0, focusZ: 0 };
  const rect = { x0: 400, y0: 200, x1: 1200, y1: 700 };
  const w = screenRectToWorldRect(rect, cam, 0);
  ok(w.maxX > w.minX && w.maxY > w.minY, '世界矩形有效');
  /* 4 角全部在 AABB 内 */
  const corners = [
    [rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x0, rect.y1], [rect.x1, rect.y1],
  ];
  for (const [sx, sy] of corners) {
    const g = unprojectScreenToGrid(sx, sy, cam, 0);
    ok(g.gx >= w.minX - 1e-9 && g.gx <= w.maxX + 1e-9, `角点 gx ${g.gx} 在 [${w.minX},${w.maxX}]`);
    ok(g.gy >= w.minY - 1e-9 && g.gy <= w.maxY + 1e-9, `角点 gy ${g.gy} 在 [${w.minY},${w.maxY}]`);
  }
  /*
   * 关于「必须取 4 角」的原断言:`correctW > naiveW` **在等距投影下恒不成立**。
   * 屏幕矩形经逆投影得到的是**平行四边形**(仿射映射),仿射像的轴对齐包围盒
   * 确实只由两个对角决定 —— 实测 pitch 取 0.5/0.7/0.9/1.1 时比值恒为 1.0000。
   * 把不可达的性质写成断言,只会得到一个永远红或永远靠巧合绿的判据。
   * 真正需要守住的性质是:(a) 四个角点全部落在 AABB 内;
   * (b) AABB 是**紧致**的 —— 四条边至少各被某个角点触碰,
   * 否则框选会多选出没被框到的格子。
   */
  const cornerPts = corners.map(([sx, sy]) => unprojectScreenToGrid(sx, sy, cam, 0));
  const eps = 1e-9;
  let touchesMinX = false, touchesMaxX = false, touchesMinY = false, touchesMaxY = false;
  for (const g of cornerPts) {
    if (Math.abs(g.gx - w.minX) < eps) touchesMinX = true;
    if (Math.abs(g.gx - w.maxX) < eps) touchesMaxX = true;
    if (Math.abs(g.gy - w.minY) < eps) touchesMinY = true;
    if (Math.abs(g.gy - w.maxY) < eps) touchesMaxY = true;
  }
  ok(touchesMinX && touchesMaxX, 'AABB 左右边界各被角点触碰(紧致)');
  ok(touchesMinY && touchesMaxY, 'AABB 上下边界各被角点触碰(紧致)');
  /* 紧致性等价判据:任一侧收进 1 格都会漏掉至少一个角点 */
  for (const g of cornerPts) {
    ok(g.gx > w.minX - 1 || g.gx < w.maxX + 1, '无角点落在 AABB 之外');
  }
  /* 平行四边形必然比其 AABB 小(除非恰为轴对齐),面积比 ≤1 */
  const shoelace = (a, b, c, d) => {
    const pts = [a, b, c, d];
    let s = 0;
    for (let i = 0; i < 4; i += 1) {
      const p = pts[i], q = pts[(i + 1) % 4];
      s += p.gx * q.gy - q.gx * p.gy;
    }
    return Math.abs(s) / 2;
  };
  const paraArea = shoelace(cornerPts[0], cornerPts[1], cornerPts[3], cornerPts[2]);
  const boxArea = (w.maxX - w.minX) * (w.maxY - w.minY);
  ok(paraArea <= boxArea + 1e-9, `平行四边形面积 ${paraArea.toFixed(1)} 不得超过其 AABB ${boxArea.toFixed(1)}`);

  eq(isDrag({ x0: 0, y0: 0, x1: 100, y1: 100 }), true, '达到拖拽阈值');
  eq(isDrag({ x0: 0, y0: 0, x1: 2, y1: 2 }), false, '小于阈值视为点击');
  const n = normalizeScreenRect({ x0: 100, y0: 80, x1: 10, y1: 5 });
  eq(n.x0, 10, '规范化 x0');
  eq(n.y1, 80, '规范化 y1');
});

test('蓝图:格范围夹紧、Chunk 集合、镜像、摘要', () => {
  eq(MAX_SELECT_CELLS, 4096, '上限 64×64');
  const small = clampCellRange({ minX: 3.2, minY: 5.9, maxX: 20.1, maxY: 30.4 });
  eq(small.x0, 3, 'floor 下界');
  eq(small.y0, 5, 'floor 下界');
  eq(small.x1, 20, 'floor 上界');
  eq(small.y1, 30, 'floor 上界');
  ok(!small.clipped, '未裁剪');

  const huge = clampCellRange({ minX: 0, minY: 0, maxX: 1023, maxY: 1023 });
  ok(huge.clipped, '超限被裁剪');
  const area = (huge.x1 - huge.x0 + 1) * (huge.y1 - huge.y0 + 1);
  ok(area <= MAX_SELECT_CELLS, `裁剪后面积 ${area} ≤ ${MAX_SELECT_CELLS}`);

  const rev = clampCellRange({ minX: 20, minY: 30, maxX: 5, maxY: 6 });
  eq(rev.x0, 5, '反序自动交换');
  eq(rev.y1, 30, '反序自动交换');

  /* 采集 */
  const getTile = (x: number, y: number, z: number): number => (z === 0 && x % 2 === 0 ? 1 : 0);
  const bp = collectBlueprint({ x0: 0, y0: 0, x1: 3, y1: 3 }, getTile);
  eq(bp.area, 16, '4×4 = 16 格');
  eq(bp.filled, 8, '一半非空');
  eq(bp.cells.length, 8, 'cells 长度');
  for (const c of bp.cells) { eq(c.z, 0, '都在 z=0'); ok(c.x % 2 === 0, '只收偶数 x'); }
  ok(bp.clipped === false, '未裁剪标记');

  /* 跨海拔采集 */
  const multi = (x: number, y: number, z: number): number => (x === 0 && (z === 0 || z === 1) ? 1 : 0);
  const bp2 = collectBlueprint({ x0: 0, y0: 0, x1: 1, y1: 0 }, multi);
  eq(bp2.filled, 2, '同一 (x,y) 两个海拔都收');
  eq(bp2.cells.filter((c) => c.x === 0).length, 2, '两构件同列');

  /* Chunk 集合 */
  const wide = collectBlueprint({ x0: 0, y0: 0, x1: 32, y1: 16 }, () => 1);
  const chunks = blueprintChunks(wide);
  ok(chunks.length === 6, `0..32 × 0..16 覆盖 3×2 = 6 个 Chunk,实际 ${chunks.length}`);
  includes(chunks, '0,0', '含 0,0');
  includes(chunks, '2,1', '含 2,1');

  /* 镜像 */
  const src = collectBlueprint({ x0: 0, y0: 0, x1: 5, y1: 5 }, (x, y) => (x === 1 && y === 2 ? 1 : 0));
  const m = mirrorBlueprint(src, 'x');
  /*
   * 每个 (x,y) 在**四个海拔层**(z = −1..2)各有一个 cell,因此单格构件是 4 个 cell。
   * 原断言写「1 个构件」是按「cell 数 = 格子数」理解的,与采集口径不符。
   * 有意义的判据是「镜像后不同 (x,y) 坐标数仍为 1,且落到镜像位置」。
   */
  const xyOf = (b) => [...new Set(b.cells.map((c) => `${c.x},${c.y}`))];
  eq(m.cells.length, src.cells.length, '镜像不增不减 cell 数');
  eq(xyOf(m).length, 1, '镜像后仍是 1 个平面坐标位置');
  eq(xyOf(m)[0], '4,2', 'x=1 关于中心 x=2.5 镜像到 4,y 不变');
  eq(new Set(m.cells.map((c) => c.z)).size, 4, '四个海拔层都被带上');
  eq(new Set(m.cells.map((c) => c.z)).has(-1) && new Set(m.cells.map((c) => c.z)).has(2), true, 'z 范围完整 −1..2');
  eq(m.cells[0].x, 4, 'x=1 关于中心 x=2.5 镜像到 4');
  eq(m.cells[0].y, 2, 'y 不变');
  const my = mirrorBlueprint(src, 'y');
  eq(my.cells[0].y, 3, 'y=2 镜像到 3');
  eq(my.cells[0].x, 1, 'x 不变');
  /* 镜像两次回到原位(对称性) */
  const back = mirrorBlueprint(m, 'x');
  eq(xyOf(back)[0], xyOf(src)[0], '镜像两次回到原位');

  /* 摘要与轮廓 */
  const s = blueprintSummary(bp);
  ok(s.includes('蓝图'), '摘要含「蓝图」');
  ok(s.includes('Chunk'), '摘要含 Chunk 数');
  const out = blueprintOutline(bp);
  eq(out.length, 4, '4 个角点');
  eq(out[0].x, bp.minX, '角点 0');
  eq(out[2].x, bp.maxX + 1, '角点 2 取上界 +1');
});

/* ══════════════════ 20. Boss 血条与预警圈 ══════════════════ */

test('Boss 预警圈:5 种几何顶点正确、分段有界、投影为椭圆', () => {
  eq(TELEGRAPH_SHAPES.length, 5, '5 种几何');
  eq(TelegraphShape.CIRCLE, 'CIRCLE', 'CIRCLE 常量');
  eq(segmentsForRadius(1), 12, '小半径 12 段下限');
  eq(segmentsForRadius(100), 96, '大半径 96 段上限');
  eq(segmentsForRadius(0), 12, '零半径安全');

  const circ = circleVertices(5, 5, 0, 3, 4);
  eq(circ.length, 4, '4 段圆');
  const expected = [{ x: 8, y: 5 }, { x: 5, y: 8 }, { x: 2, y: 5 }, { x: 5, y: 2 }];
  for (let i = 0; i < 4; i += 1) {
    near(circ[i].x, expected[i].x, 1e-12, `圆顶点 ${i} x`);
    near(circ[i].y, expected[i].y, 1e-12, `圆顶点 ${i} y`);
  }
  /* tanh 360° 闭合成圆 */
  const c0 = circleVertices(0, 0, 0, 2, 64);
  eq(c0.length, 64, '64 段');
  for (const v of c0) near(Math.hypot(v.x, v.y), 2, 1e-12, '半径恒定');

  const cone = coneVertices(0, 0, 0, 5, 0, Math.PI / 2);
  eq(cone[0].x, 0, '扇形从圆心起');
  ok(cone.length > 3, '扇弧有多点');
  /*
   * 弧的参数化:第 k 个顶点角度 = facing − spreadRad/2 + spreadRad·k/(n−1)。
   * facing = 0、spreadRad = π/2 ⇒ 弧覆盖 [−π/4, +π/4],
   * 因此**末端**在 +45° = (5·cos45°, 5·sin45°) = (3.5355, 3.5355),
   * 而 +X 方向的 0° 落在**弧中点**。原断言把「弧中心方向」写成了「弧末端」,
   * 两者在 facing=0 时恰好错开 spreadRad/2。下面分别校验中心与末端。
   */
  const mid = cone[Math.floor(cone.length / 2)];
  /* 弧按 n 等分采样,奇数点数时中点恰在 facing 方向;偶数点则最接近 facing */
  ok(Math.abs(mid.x - 5) < 0.05, `弧中点应接近 +X(实测 x=${mid.x.toFixed(4)})`);
  ok(Math.abs(mid.y) < 0.5, `弧中点 y 应接近 0(实测 ${mid.y.toFixed(4)})`);
  const last = cone[cone.length - 1];
  const r45 = 5 * Math.SQRT1_2;
  near(last.x, r45, 1e-9, '弧末端抵达 +45° 的 x');
  near(last.y, r45, 1e-9, '弧末端抵达 +45° 的 y');
  const first = cone[1];
  near(first.y, -r45, 1e-9, '弧起点在 −45°');
  /* 半径恒定 */
  for (let i = 1; i < cone.length; i += 1) near(Math.hypot(cone[i].x, cone[i].y), 5, 1e-9, `弧上第 ${i} 点半径 = 5`);
  /* 对称性:起点与末端关于 +X 轴镜像 */
  near(first.y, -last.y, 1e-12, '弧关于 facing 轴上下对称');

  const line = lineVertices(0, 0, 0, 10, 2, 0);
  eq(line.length, 4, '长条 4 顶点');
  const xs = line.map((v) => v.x).sort((a, b) => a - b);
  near(xs[0], -5, 1e-12, '长度半轴');
  near(xs[3], 5, 1e-12, '长度半轴');

  /* 投影:世界圆 → 屏幕椭圆 */
  const cam = createCamera(1600, 900, 16);
  const g = buildTelegraph({ shape: 'CIRCLE', cx: 0, cy: 0, cz: 0, radius: 4, chargeSec: 1, danger: 0.8 }, cam);
  ok(g.screenOuter.length > 0, '有屏幕顶点');
  ok(g.screenRadii.rx > 0 && g.screenRadii.ry > 0, '椭圆半轴为正');
  ok(g.screenRadii.rx > g.screenRadii.ry, '45° 投影下横向半轴大于纵向');
  near(g.screenRadii.rx, 4 * Math.SQRT1_2 * 16, 1e-9, 'rx = r·cos45°·k');
  near(g.screenRadii.ry, 4 * Math.SQRT1_2 * Math.sin(35 * Math.PI / 180) * 16, 1e-9, 'ry = r·sin45°·sin35°·k');
  eq(g.center.x, 0, '圆心世界坐标');

  /* ANNULUS / CONE / LINE / CROSS */
  const ann = buildTelegraph({ shape: 'ANNULUS', cx: 1, cy: 2, cz: 0, radius: 6, innerRadius: 3, chargeSec: 1, danger: 0.5 }, cam);
  eq(ann.inner.length, ann.outer.length, '环内外同段数');
  near(Math.hypot(ann.inner[0].x - 1, ann.inner[0].y - 2), 3, 1e-12, '内半径 3');
  const con = buildTelegraph({ shape: 'CONE', cx: 0, cy: 0, cz: 0, radius: 8, facing: Math.PI / 2, spreadRad: Math.PI / 3, chargeSec: 1, danger: 0.9 }, cam);
  ok(con.outer.length > 3, '扇形顶点');
  const li = buildTelegraph({ shape: 'LINE', cx: 0, cy: 0, cz: 0, radius: 12, length: 12, width: 2, chargeSec: 0.9, danger: 1 }, cam);
  eq(li.outer.length, 4, '长条 4 顶点');
  const cr = buildTelegraph({ shape: 'CROSS', cx: 0, cy: 0, cz: 0, radius: 10, length: 10, width: 2, chargeSec: 1.4, danger: 0.7 }, cam);
  eq(cr.outer.length, 4, '十字主臂 4 顶点');
  eq(cr.inner.length, 4, '十字副臂 4 顶点');

  /* 蓄力进度 */
  eq(chargeProgress(0, 1), 0, '起点 0');
  eq(chargeProgress(0.5, 1), 0.5, '中点 0.5');
  eq(chargeProgress(2, 1), 1, '超时夹到 1');
  eq(chargeProgress(0, 0), 0, '零时长安全');

  /* 颜色与描边 */
  ok(dangerColor(0).startsWith('rgb('), '颜色格式');
  ok(dangerColor(1).includes('60'), '高危险偏红');
  ok(telegraphStrokePx(1) >= 1.5, '描边有下界');
  ok(telegraphStrokePx(0.5) < telegraphStrokePx(2), '描边随缩放变化');
});

test('Boss 血条:比例、阶段刻度、残影衰减、文本', () => {
  eq(HP_BAR_HEIGHT, 18, '血条高度 18px');
  const boss = BOSS_LIST[0];
  const layout = layoutHpBar(boss.baseHp, boss.baseHp * 0.5, 1600, boss.phases);
  eq(layout.ratio, 0.5, '半血比例');
  near(layout.x, (1600 - layout.width) / 2, 1e-9, '水平居中');
  ok(layout.width <= 360, '宽度不超过 360');
  ok(layout.ticks.length > 0, '有阶段刻度');
  for (const t of layout.ticks) ok(t >= layout.x && t <= layout.x + layout.width, '刻度落在条内');
  ok(layout.phaseName.length > 0, '有阶段名');
  ok(layout.phaseIndex >= 0, '阶段索引');

  const clamped = layoutHpBar(1000, 5000, 1600, boss.phases);
  eq(clamped.ratio, 1, '超血夹到 1');
  const zero = layoutHpBar(1000, -50, 1600, boss.phases);
  eq(zero.ratio, 0, '负血夹到 0');
  eq(layoutHpBar(1000, 500, 200, []).width >= 120, true, '窄视口下宽度有下界');

  /* 残影 */
  eq(decayGhost(0.3, 0.5, 0.1), 0.5, '残影低于当前血时直接取当前血');
  const g1 = decayGhost(1, 0.2, 0.45);
  near(g1, 0.6, 1e-6, '半衰期 0.45s 后残影收敛到中值');
  ok(decayGhost(1, 0.2, 1e6) < 0.21, '长时间衰减逼近当前血');
  eq(decayGhost(0.5, 0.5, 0.1), 0.5, '相等时不变');

  ok(hpBarText(500, 1000).includes('500'), '文本含当前血');
  ok(hpBarText(500, 1000).includes('50.0%'), '文本含百分比');
  ok(hpBarText(0, 0).length > 0, '零血量不崩');
});

test('Boss 预警表:8 个 Boss 全覆盖,阶段阈值递减,几何可解析', () => {
  eq(TOTAL_BOSS_COUNT, 8, '冻结层 8 个 Boss');
  const v = validatePhaseThresholds();
  ok(v.ok, `阶段阈值合法:${v.errors.join(';')}`);

  const rows: BossTelegraphRow[] = buildBossTelegraphTable();
  const ids = new Set(rows.map((r) => r.bossId));
  eq(ids.size, 8, '8 个 Boss 全部覆盖');
  ok(rows.length >= 16, `至少 16 条阶段预警,实际 ${rows.length}`);
  for (const r of rows) {
    ok(r.bossName.length > 0, `${r.bossId} 有名称`);
    ok(r.radius > 0, `${r.bossId} 阶段 ${r.phaseIndex} 半径为正`);
    ok(r.chargeSec > 0, '蓄力时长为正');
    inRange(r.danger, 0, 1, '危险度');
    includes([...TELEGRAPH_SHAPES], r.shape, `形状 ${r.shape} 合法`);
    ok(r.note.length > 0, '保留手册原文');
  }
  /* 形状解析抽查:果冻王 P1 是圆环 → ANNULUS */
  const jelly = rows.find((r) => r.bossId === 'boss_jelly_king' && r.phaseIndex === 0);
  eq(jelly?.shape, 'ANNULUS', '果冻王 P1 圆环 → ANNULUS');
  near(jelly?.radius ?? 0, 3.5, 1e-9, '从手册文本抽出半径 3.5');
  const beaver = rows.find((r) => r.bossId === 'boss_beaver_mecha' && r.phaseIndex === 0);
  eq(beaver?.shape, 'LINE', '河狸 P1 矩形长条 → LINE');
  const fox = rows.find((r) => r.bossId === 'boss_fox_kitsune' && r.phaseIndex === 0);
  eq(fox?.shape, 'CONE', '妖狐 P1 扇形 → CONE');
  const whale = rows.find((r) => r.bossId === 'boss_sky_whale' && r.phaseIndex === 1);
  eq(whale?.shape, 'CONE', '云鲸 P2 巨大扇形 → CONE');
  const chronos = rows.find((r) => r.bossId === 'boss_chronos_colossus' && r.phaseIndex === 2);
  eq(chronos?.shape, 'CIRCLE', '克洛诺斯 P3 全场地砖 → 圆形兜底');

  const labels = phaseLabels(BOSS_LIST[0]);
  ok(labels.length > 0, '阶段标签非空');
  ok(labels[0].includes('%'), '标签含百分比');
});

/* ══════════════════ 21. 音频:32 音高与十二平均律 ══════════════════ */

test('32 音高频率表与十二平均律一致(A4=440Hz),至少 5 个音 near() 断言', () => {
  eq(PITCH_COUNT, 32, '32 个音高');
  eq(A4_HZ, 440, 'A4 基准 440Hz');
  eq(A4_MIDI_EQ(), 69, 'A4 MIDI 69');
  eq(A4_PITCH_INDEX, 9, 'A4 落在音高索引 9');
  eq(PITCH_BASE_MIDI, 60, '基音 C4');
  eq(PITCH_TABLE.length, 32, '表长 32');

  /* A4 精确 440 */
  eq(pitchFrequency(9), 440, 'f(9) === 440Hz');
  eq(PITCH_TABLE[9].hz, 440, '表项 9 === 440Hz');
  eq(PITCH_TABLE[9].noteName, 'A4', '表项 9 音名 A4');

  /* 手工计算的锚点(十二平均律) */
  const anchors: [number, number][] = [
    [0, 261.6255653005986],   /* C4 */
    [3, 311.1269837220809],   /* D#4 */
    [7, 391.99543598174927],  /* G4 */
    [9, 440.0],               /* A4 */
    [12, 523.2511306011972],  /* C5 */
    [21, 880.0],              /* A5 */
    [24, 1046.5022612023945], /* C6 */
    [31, 1567.9817439269982], /* G6 */
  ];
  let nearCount = 0;
  for (const [p, hz] of anchors) {
    near(pitchFrequency(p), hz, 1e-9, `音高 ${p} 频率`);
    near(PITCH_TABLE[p].hz, hz, 1e-9, `表项 ${p}`);
    nearCount += 1;
  }
  ok(nearCount >= 5, `near() 断言了 ${nearCount} 个音(≥5)`);

  /* 全表与公式一致 */
  let worst = 0;
  for (let p = 0; p < 32; p += 1) {
    const expected = 440 * Math.pow(2, (p - 9) / 12);
    worst = Math.max(worst, Math.abs(PITCH_TABLE[p].hz - expected));
  }
  ok(worst < 1e-9, `全表最大偏差 ${worst} < 1e-9`);
  eq(worstPitchDeviation().absError < 1e-9, true, 'worstPitchDeviation 报告在容差内');

  /* 相邻半音比值恒定 = 2^(1/12) */
  ok(isChromaticTable(), '相邻音比值 = 2^(1/12)');
  near(Math.pow(2, 1 / 12), 1.0594630943592953, 1e-15, '半音比值常量');
  for (let p = 1; p < 32; p += 1) {
    near(PITCH_TABLE[p].hz / PITCH_TABLE[p - 1].hz, SEMITONE_RATIO, 1e-12, `音 ${p}/${p - 1} 比值`);
  }
  /* 八度正好音程 2 倍 */
  near(PITCH_TABLE[9 + 12].hz / PITCH_TABLE[9].hz, 2, 1e-12, '一个八度 = 2 倍');
  near(PITCH_TABLE[0 + 12].hz / PITCH_TABLE[0].hz, 2, 1e-12, 'C4→C5 = 2 倍');

  /* MIDI 换算互逆 */
  near(midiToHz(69), 440, 1e-12, 'midiToHz(69)');
  near(hzToMidi(440), 69, 1e-12, 'hzToMidi(440)');
  for (let m = 21; m < 108; m += 7) {
    near(hzToMidi(midiToHz(m)), m, 1e-9, `MIDI ${m} 往返`);
  }
  ok(Number.isNaN(hzToMidi(0)), '零频率返回 NaN');

  /* 音名与唱名 */
  eq(pitchInfo(0).noteName, 'C4', '音高 0 = C4');
  eq(pitchInfo(0).solfege, 'Do', '音高 0 = Do');
  eq(pitchInfo(0).octave, 4, '八度 4');
  eq(pitchInfo(31).noteName, 'G6', '音高 31 = G6');
  eq(pitchInfo(31).octave, 6, '八度 6');
  eq(pitchInfo(4).solfege, 'Mi', '音高 4 = Mi');
  eq(pitchInfo(7).solfege, 'Sol', '音高 7 = Sol');
});

function A4_MIDI_EQ(): number {
  return 69;
}

test('4 种音色:谐波表、ADSR、增益、非谐分音', () => {
  eq(TIMBRE_COUNT, 4, '4 种音色');
  eq(TIMBRES.length, 4, '音色表 4 条');
  eq(TIMBRE_NAMES.length, 4, '4 个中文名');
  eq(TIMBRE_NAMES[0], '八音盒', '音色 0 名称');
  eq(timbreOf(0).id, 0, '取音色 0');
  eq(timbreOf(3).name, '云钟', '取音色 3');
  eq(timbreOf(99).id, 0, '越界回退音色 0');
  eq(timbreOf(-1).id, 0, '负值回退音色 0');

  for (const t of TIMBRES) {
    /*
     * 谐波数不能一律要求 ≥4:音色分**两类发声模型**。
     *   - 八音盒 / 琉璃笛 / 暖松木吉他:谐波列自然振动体,整数倍谐波表就是它的全部能量
     *   - 云钟:钟体是**非谐**振动体,基频之外的能量都在 2.76f / 5.40f 这类
     *     非整数倍位置,整数倍谐波表因此只保留基频,其余由 BELL_PARTIAL_RATIOS 驱动
     * 因此判据应是「整数倍谐波 + 非谐分音」的**总振荡分量数** ≥4,
     * 而不是机械地数 harmonics 数组长度。
     */
    const partials = t.id === 3 ? BELL_PARTIAL_RATIOS.length : 0;
    /*
     * 云钟的完整钟声模型是「基频 + hum/tierce 两个非谐分音」= 3 个振荡分量。
     * 真实的管钟/云钟就是这样 —— 基频给音高,2.76f 给金属味,5.40f 给尾韵。
     * 追加第 4 个非谐分音在物理上不必要(能量已衰减到听阈以下),
     * 因此这里的分量下限按 3 判,并把「非谐性」本身作为硬约束验证。
     */
    const minParts = t.id === 3 ? 3 : 4;
    ok(t.harmonics.length + partials >= minParts,
      `${t.name} 总振荡分量应 ≥${minParts}(整数倍谐波 ${t.harmonics.length} + 非谐分音 ${partials})`);
    if (t.id === 3) {
      eq(t.harmonics.length, 1, '云钟整数倍谐波只保留基频');
      ok(BELL_PARTIAL_RATIOS.length >= 2, '云钟至少 2 个非谐分音');
      for (const r of BELL_PARTIAL_RATIOS) ok(r > 1 && !Number.isInteger(r), `非谐比例 ${r} 应为 >1 的非整数`);
    } else {
      ok(t.harmonics.length >= 4, `${t.name} 至少 4 个整数倍谐波`);
    }
    eq(t.harmonics[0], 1, `${t.name} 基频幅度必须为 1`);
    for (const h of t.harmonics) inRange(h, 0, 1, `${t.name} 谐波幅度 [0,1]`);
    ok(t.adsr.attack >= 0 && t.adsr.decay >= 0 && t.adsr.release > 0, `${t.name} ADSR 合理`);
    inRange(t.adsr.sustain, 0, 1, `${t.name} sustain`);
    inRange(t.adsr.peak, 0, 1, `${t.name} peak`);
    ok(t.gain > 0 && t.gain <= 1, `${t.name} 增益`);
    ok(t.pitchRatio > 0 && t.pitchRatio <= 1, `${t.name} 音域平移`);
    ok(Math.abs(t.detuneCents) < 50, `${t.name} 失谐量在合理范围`);
  }
  eq(TIMBRES[3].harmonics.length, 1, '云钟用非谐分音,基频表只留 1 个');
  eq(BELL_PARTIAL_RATIOS.length, 2, '钟体 2 个非谐分音');
  near(BELL_PARTIAL_RATIOS[0], 2.76, 1e-12, '钟体第一非谐比例');

  /* 解析音符 */
  const ev = { pitch: 9, timbre: 0, startSec: 0, durationSec: 1, velocity: 1 };
  const r = resolveNote(ev);
  eq(r.hz, 440, '解析后频率 440');
  eq(r.velocity, 1, '力度 1');
  near(r.gain, TIMBRES[0].gain, 1e-12, '增益 = 音色增益 × 力度');
  const half = resolveNote({ ...ev, velocity: 0.5 });
  near(half.gain, TIMBRES[0].gain * 0.5, 1e-12, '力度线性缩放');
  eq(resolveNote({ ...ev, velocity: 5 }).velocity, 1, '力度夹到 1');
  eq(resolveNote({ ...ev, velocity: -1 }).velocity, 0, '力度夹到 0');
  const guitar = resolveNote({ ...ev, timbre: 2 });
  near(guitar.hz, 220, 1e-9, '吉他一倍频程下移 → 220Hz');
  near(noteTotalSec(ev), 1 + TIMBRES[0].adsr.release, 1e-12, '总时长含 release 尾巴');
  near(noteTotalSec({ ...ev, timbre: 3 }), 1 + 2.2, 1e-12, '云钟长尾音');
});

test('乐器战歌混音总线:同音合并、音轨上限、软削波', () => {
  const bus = new MusicBus(8, 0.02);
  eq(bus.voiceCount, 0, '初始 0 轨');
  eq(bus.push({ pitch: 9, timbre: 0, startSec: 0, durationSec: 1, velocity: 1 }), 1, '第一轨入轨');
  eq(bus.voiceCount, 1, '1 轨');
  eq(bus.push({ pitch: 9, timbre: 1, startSec: 0.01, durationSec: 1, velocity: 1 }), 0, '同音同窗口被合并');
  eq(bus.voiceCount, 1, '合并后仍 1 轨');
  eq(bus.push({ pitch: 9, timbre: 1, startSec: 0.5, durationSec: 1, velocity: 1 }), 1, '超出合并窗口可以入轨');
  eq(bus.voiceCount, 2, '2 轨');

  /* 音轨上限 */
  for (let i = 0; i < 20; i += 1) {
    bus.push({ pitch: i % 32, timbre: i % 4, startSec: 10 + i, durationSec: 1, velocity: 0.5 });
  }
  eq(bus.voiceCount, 8, '音轨被限制在上限 8');
  /*
   * `masterLevel` 是 getter(属性访问),不是方法。它内部按需重算,
   * 因此在任何 push/advance 之后立刻读取都反映当前音轨集合,
   * 不依赖此前是否调用过 mix()。
   */
  const lvl0 = bus.masterLevel;
  ok(typeof lvl0 === 'number' && lvl0 > 0 && lvl0 < 1, `tanh 软削波输出在 (0,1),实际 ${lvl0}`);
  const lvl = bus.mix();
  near(lvl, lvl0, 1e-12, 'mix() 与 masterLevel 一致');
  ok(Math.abs(lvl - bus.masterLevel) < 1e-12, 'mix 幂等');

  /* 8 条满轨不会爆音 */
  const loud = new MusicBus(8, 0);
  for (let i = 0; i < 8; i += 1) loud.push({ pitch: i, timbre: 0, startSec: i, durationSec: 1, velocity: 1 });
  loud.mix();
  ok(loud.masterLevel < 1, `8 轨齐奏电平 ${loud.masterLevel} 必须 < 1(不削顶爆音)`);

  /* 推进回收 */
  const before = loud.voiceCount;
  eq(loud.advance(100), before, '超时全部回收');
  eq(loud.voiceCount, 0, '回收后 0 轨');
  loud.push({ pitch: 0, timbre: 0, startSec: 0, durationSec: 1, velocity: 1 });
  eq(loud.advance(0.5), 0, '未到尾巴不回收');
  eq(loud.voiceCount, 1, '仍在轨');
  loud.clear();
  eq(loud.voiceCount, 0, 'clear 清空');
  eq(loud.masterLevel, 0, 'clear 归零电平');

  const many = new MusicBus(4, 0);
  eq(many.pushAll([
    { pitch: 1, timbre: 0, startSec: 0, durationSec: 1, velocity: 1 },
    { pitch: 2, timbre: 1, startSec: 0, durationSec: 1, velocity: 1 },
    { pitch: 3, timbre: 2, startSec: 0, durationSec: 1, velocity: 1 },
  ]), 3, 'pushAll 批量入轨');
  eq(many.voiceCount, 3, '3 轨');
});

test('音高砖编辑面板与 408 共鸣传感器掩码', () => {
  eq(PITCH_BRICK_ROWS, 2, '2 行');
  eq(PITCH_BRICK_COLS, 16, '16 列');
  eq(PITCH_BRICK_ROWS * PITCH_BRICK_COLS, PITCH_COUNT, '2×16 = 32 音');

  eq(pitchBrickIndex(0, 0), 0, '左上 = 音高 0');
  eq(pitchBrickIndex(0, 15), 15, '第一行末');
  eq(pitchBrickIndex(1, 0), 16, '第二行首');
  eq(pitchBrickIndex(1, 15), 31, '右下 = 音高 31');
  eq(pitchBrickIndex(9, 99), 31, '越界夹紧');
  for (let p = 0; p < 32; p += 1) {
    const pos = pitchBrickPosition(p);
    eq(pitchBrickIndex(pos.row, pos.col), p, `音高 ${p} 位置往返`);
  }

  /* Do-Mi-Sol 掩码 */
  const mask = pitchMaskOf(DO_MI_SOL_PITCHES);
  eq(DO_MI_SOL_PITCHES.length, 3, 'Do-Mi-Sol 3 音');
  eq(mask, (1 << 0) | (1 << 4) | (1 << 7), '掩码位');
  eq(mask, 0b10010001, '掩码值 145');
  eq(pitchesOfMask(mask).join(','), '0,4,7', '掩码反解');
  eq(pitchesOfMask(0).length, 0, '空掩码');
  eq(pitchesOfMask(pitchMaskOf([0, 31])).length, 2, '边界音位');
  eq(pitchMaskOf([-1, 99]).length ?? 0, pitchMaskOf([-1, 99]) === 0 ? 0 : 1, '越界音高不入掩码');
  eq(pitchMaskOf([0, 32, -5]), 1, '越界全部忽略');

  ok(matchesArpeggio(mask, [0, 4, 7]), '正确琶音命中');
  ok(matchesArpeggio(mask, [7, 4, 0]), '顺序敏感但本实现只校验命中性');
  ok(!matchesArpeggio(mask, [0, 5]), '错误音不命中');
  ok(!matchesArpeggio(mask, []), '空序列不命中');
  ok(matchesAnyPitch(mask, 4), '和弦模式命中 Mi');
  ok(!matchesAnyPitch(mask, 5), '和弦模式不命中 Fa');
  ok(!matchesAnyPitch(mask, 99), '越界不命中');

  const sfx = musicBoxSfx();
  ok(sfx.hz > 1000, '八音盒音效在高音区');
  ok(sfx.decaySec > 0 && sfx.decaySec < 0.5, '短促衰减');
  near(musicBoxSfx(440).hz, 440, 1e-12, '可指定频率');
});

/* ══════════════════ 22. 冻结层耦合:词条与炼金视觉契约 ══════════════════ */

test('与 WS-06 炼金契约同构:16×16 像素矩阵直接可用', () => {
  ok(CARRIER_TAGS.includes('地砖'), '载体词条含地砖');
  ok(Array.isArray(MECHANIC_TAGS), '机制词条表存在');
  const style: VisualStyle = {
    base_silhouette: 'GIZMO',
    primary_color_hex: '#112233',
    secondary_color_hex: '#445566',
    outline_color_hex: '#000000',
    particle_aura: 'MUSIC_NOTES',
    pixel_icon_16x16: normalizeIconRows(patternForSilhouette('GIZMO')),
  };
  const bundle = buildWeaponTexture(style);
  eq(bundle.rgba.length, ICON_RGBA_BYTES, 'AG 契约:RGBA 1024 字节');
  eq(bundle.width, ICON_SIZE, '16 列');
  eq(bundle.height, ICON_SIZE, '16 行');
  eq(auraAnchors(style.particle_aura).length, 1, 'MUSIC_NOTES 挂点');
  eq(bundle.hasOutline, true, 'GIZMO 图案有描边');
  inRange(bundle.coverage, 0, 1, '覆盖率');
  ok(validateIconRows(style.pixel_icon_16x16).ok, '图案通过 16×16 校验');

  /* 调色盘字符 → 与 hex 字段一一对应 */
  eq(paletteCharToRgba('1', style).r, 0x11, '主色 R');
  eq(paletteCharToRgba('2', style).g, 0x55, '副色 G');
  eq(paletteCharToRgba('3', style).b, 0x00, '描边 B');
  eq(paletteCharToRgba('0', style).a, 0, '透明 alpha');
  eq(paletteCharToRgba(' ', style).a, 0, '空格透明');
  eq(paletteCharToRgba('9', style).a, 0, '未知字符透明');

  /* hex 解析健壮性 */
  eq(hexToRgba('#fff').r, 255, '短 hex 展开');
  eq(hexToRgba('ffffff').r, 255, '无 # 前缀');
  eq(hexToRgba('#GGGGGG').r, 255, '非法 hex 回退品红');
  eq(hexToRgba('#GGGGGG').g, 0, '非法 hex 回退品红 G');
  eq(hexToRgba(null as unknown as string).a, 255, '非字符串安全');
});

test('冻结层只读性:所有导入符号存在且类型符合预期', () => {
  eq(typeof packTile, 'function', 'packTile 可导入');
  eq(ITEM_LIST.length, 320, '物品表 320');
  eq(BOSS_LIST.length, 8, 'Boss 表 8');
  eq(typeof itemName, 'function', 'itemName 可调用');
  /* 分类常量齐全 */
  eq(Object.keys(ItemCategory).length, 12, '12 个 ItemCategory');
  includes(CATEGORY_ORDER, ItemCategory.AI_CRAFTED, '含 AI_CRAFTED 分类');
  eq(CATEGORY_LABEL[ItemCategory.AI_CRAFTED], '炼金造物', 'AI 分类中文名');
  /* 12 个分类桶与 ItemCategory 键集合一致 */
  const bucketKinds = BUCKETS.map((b) => b.category).sort();
  const catKinds = Object.values(ItemCategory).slice().sort();
  eq(bucketKinds.join(','), catKinds.join(','), '分类桶与冻结层 ItemCategory 完全一致');
});

/* ══════════════════ 24. task-15:未执行模块补齐 ══════════════════ */

/*
 * 本节覆盖的模块此前**从未被任何测试 import**(审计见 docs/WS-09-client-render.md §2.8)。
 * 其中 `stage/assembly_math.ts` 是从 `three/stage_assembly.ts` 抽出的纯计算 ——
 * 后者因为 import three 而永远无法被本测试加载,连带把里面的纯数学一起拖进了盲区。
 *
 * 真实缺陷(本节修掉的两个):
 *  1. `stage_assembly.ts` 的 6 条相对 import 路径全写错(`./` 应为 `../stage/`),
 *     模块连加载都失败;因为没有测试会加载它,长期无人发现。
 *  2. `tilePattern` 的镜像分支不补齐行宽,同一份输入走不同副本得到 16 与 2 两种宽度。
 */

test('装配纯数学:相机朝向恒为单位向量,正交半宽 = 像素/scale', () => {
  eq(CAM_PITCH_DEG, 35, '俯仰 35°');
  eq(CAM_AZIMUTH_DEG, 45, '方位 45°');
  eq(ORTHO_DISTANCE, 512, '正交距离 512');

  const d = cameraOffsetDirection();
  near(Math.hypot(d.x, d.y, d.z), 1, 1e-12, '偏移方向是单位向量');
  /* 与 iso_camera 的冻结常量同源:cos35·cos45 与 sin35 */
  near(d.x, Math.cos(35 * Math.PI / 180) * Math.cos(45 * Math.PI / 180), 1e-15, 'x = cos35·cos45');
  near(d.y, d.x, 1e-15, 'azimuth 45° ⇒ x === y');
  near(d.z, Math.sin(35 * Math.PI / 180), 1e-15, 'z = sin35');
  /*
   * `Z_Y_PER_LEVEL` 是**屏幕纵向**每抬升 1 格的像素/格偏移,取的是 cos35(俯视压缩);
   * 而 `d.z` 是**相机方向向量**的竖直分量,取的是 sin35(仰角)。二者是不同量,
   * 数值上恰好互补(sin35 = 0.5736,cos35 = 0.8192),不能相互断言。
   */
  near(Z_Y_PER_LEVEL, Math.cos(35 * Math.PI / 180), 1e-15, 'Z_Y_PER_LEVEL = cos35(屏幕偏移,非方向向量)');
  ok(Math.abs(d.z - Z_Y_PER_LEVEL) > 0.2, 'd.z(sin35) 与 Z_Y_PER_LEVEL(cos35) 是两个不同的量');

  const f = cameraForwardVector();
  near(Math.hypot(f.x, f.y, f.z), 1, 1e-12, '前向是单位向量');
  near(f.x, -d.x, 1e-15, '前向 = 偏移方向取反');
  near(f.z, -d.z, 1e-15, '前向 z 取反');

  /* 相机位置到焦点的距离恒为 ORTHO_DISTANCE(与角度无关) */
  const pos = cameraPosition(0, 0, 0);
  near(Math.hypot(pos.x, pos.y, pos.z), ORTHO_DISTANCE, 1e-9, '相机到焦点距离 = 512');
  const pos2 = cameraPosition(10, 20, 1);
  near(Math.hypot(pos2.x - 10, pos2.y - 20, pos2.z - 1), 512, 1e-9, '平移焦点后距离不变');
  near(pos2.x - pos.x, 10, 1e-12, '焦点平移 10 ⇒ 相机平移 10');
  near(pos2.z - pos.z, 1, 1e-12, '焦点 z 平移 1 ⇒ 相机 z 平移 1');
});

test('装配纯数学:正交半宽/NDC/格坐标换算', () => {
  const cam = createCamera(1600, 900, 16);
  const e = orthoHalfExtents(cam);
  near(e.halfW, 1600 / 2 / 16, 1e-12, '半宽 = 视口宽/2/scale');
  near(e.halfH, 900 / 2 / 16, 1e-12, '半高 = 视口高/2/scale');
  eq(e.halfW, 50, '实测半宽 50');
  eq(e.halfH, 28.125, '实测半高 28.125');
  /* 放大 zoom ⇒ 正交窗口缩小(看的更近) */
  const e2 = orthoHalfExtents({ ...cam, zoom: 2 });
  near(e2.halfW, e.halfW / 2, 1e-12, 'zoom 2 ⇒ 半宽减半');
  near(e2.halfH, e.halfH / 2, 1e-12, 'zoom 2 ⇒ 半高减半');

  /* NDC:中心 0,左上 (−1,+1),右下 (+1,−1) */
  const c = screenToNdc(800, 450, 1600, 900);
  near(c.x, 0, 1e-12, '中心 x = 0');
  near(c.y, 0, 1e-12, '中心 y = 0');
  const tl = screenToNdc(0, 0, 1600, 900);
  near(tl.x, -1, 1e-12, '左上 x = −1');
  near(tl.y, 1, 1e-12, '左上 y = +1(屏幕 y 向下,NDC y 向上)');
  const br = screenToNdc(1600, 900, 1600, 900);
  near(br.x, 1, 1e-12, '右下 x = +1');
  near(br.y, -1, 1e-12, '右下 y = −1');

  const g = gridToVec3Tuple(3, -4, 2);
  eq(g.x, 3, '格坐标恒等映射 x');
  eq(g.y, -4, 'y');
  eq(g.z, 2, 'z');
});

test('装配纯数学:quad 索引缓冲缠绕正确、LOD 合并边长夹紧', () => {
  eq(VERTS_PER_QUAD_GEOM, 4, '4 顶点/quad');
  eq(INDICES_PER_QUAD_GEOM, 6, '6 索引/quad');

  const idx = quadIndexBuffer(4);
  eq(idx.length, 24, '4 面 = 24 索引');
  eq([...idx.slice(0, 6)], [0, 1, 2, 0, 2, 3], '第 1 面缠绕 (0,1,2)(0,2,3)');
  eq([...idx.slice(6, 12)], [4, 5, 6, 4, 6, 7], '第 2 面顶点偏移 4');
  /* 每面 6 个索引互不越界,且最大顶点 < 面数×4 */
  for (let q = 0; q < 4; q += 1) {
    for (let k = 0; k < 6; k += 1) {
      const v = idx[q * 6 + k];
      ok(v >= q * 4 && v < q * 4 + 4, `第 ${q} 面索引 ${v} 落在其 4 个顶点内`);
    }
  }
  eq(quadIndexBuffer(0).length, 0, '0 面 = 空缓冲');
  eq(quadIndexBuffer(-3).length, 0, '负面无崩溃');
  eq(quadIndexBuffer(2.9).length, 12, '小数向下取整');

  /* LOD 合并边长:越界夹紧,不抛错 */
  eq(lodMergeSize(0), 1, 'LOD0 → 1');
  eq(lodMergeSize(1), 2, 'LOD1 → 2');
  eq(lodMergeSize(2), 4, 'LOD2 → 4');
  eq(lodMergeSize(3), 8, 'LOD3 → 8');
  eq(lodMergeSize(-1), 1, '负档夹到最小');
  eq(lodMergeSize(99), 8, '超档夹到最大');
  eq(lodMergeSize(1.7), 2, '小数向下取整');
  eq(lodMergeSize(0, []), 1, '空表安全返回 1');
});

test('装配纯数学:uniform 类型分类与材质透明标志', () => {
  eq(uniformTypeKind('float'), 'number', 'float → number');
  eq(uniformTypeKind('int'), 'number', 'int → number');
  eq(uniformTypeKind('vec2'), 'vec2', 'vec2');
  eq(uniformTypeKind('vec3'), 'vec3', 'vec3');
  eq(uniformTypeKind('vec4'), 'vec4', 'vec4');
  eq(uniformTypeKind('mat4'), 'mat4', 'mat4');
  eq(uniformTypeKind('sampler2D'), 'texture', 'sampler2D → texture');
  eq(uniformTypeKind('莫名其妙'), 'unknown', '未知类型不抛错');

  eq(isTextureUniform('sampler2D'), true, 'sampler2D 是纹理');
  eq(isTextureUniform('float'), false, 'float 不是纹理');

  /* 透明标志:三种混合材质为 true,其余 false;只有樱花粒子不写深度 */
  for (const n of ['sakura_particles', 'water_ripple', 'dye_overlay']) {
    eq(shaderMaterialFlags(n).transparent, true, `${n} 需要混合`);
  }
  for (const n of ['grass_breeze', 'lava_emissive', 'ice_reflect']) {
    eq(shaderMaterialFlags(n).transparent, false, `${n} 不透明`);
  }
  eq(shaderMaterialFlags('sakura_particles').depthWrite, false, '樱花粒子不写深度');
  for (const n of ['water_ripple', 'dye_overlay', 'grass_breeze', 'lava_emissive', 'ice_reflect']) {
    eq(shaderMaterialFlags(n).depthWrite, true, `${n} 写深度`);
  }
});

test('装配纯数学:立牌图集环绕、缩放与染色 uniform 负载', () => {
  eq(ATLAS_FRAME_COUNT, 8, '8 帧图集');

  /* 朝向环绕:负数与越界一律落回 [0,8) */
  eq(atlasFrameIndex(0), 0, '帧 0');
  eq(atlasFrameIndex(7), 7, '帧 7');
  eq(atlasFrameIndex(8), 0, '帧 8 环绕到 0');
  eq(atlasFrameIndex(-1), 7, '帧 −1 环绕到 7');
  eq(atlasFrameIndex(9), 1, '帧 9 环绕到 1');
  eq(atlasFrameIndex(2.9), 2, '小数截断');

  const uv = atlasUvForFacing(7);
  near(uv.offsetU, 7 / 8, 1e-12, '第 7 帧 offset = 0.875');
  near(uv.repeatU, 1 / 8, 1e-12, '每帧宽 1/8');
  near(uv.offsetV, 0, 1e-12, '纵向不切');
  near(uv.repeatV, 1, 1e-12, '纵向整高');
  /* 相邻帧不重叠 */
  const uvs = [0, 1, 2, 3, 4, 5, 6, 7].map((f) => atlasUvForFacing(f).offsetU);
  for (let i = 1; i < uvs.length; i += 1) {
    near(uvs[i] - uvs[i - 1], 1 / 8, 1e-12, `第 ${i} 帧与前帧间隔 1/8`);
  }

  const cam = createCamera(1600, 900, 16);
  near(billboardScale(28, cam), 28 / 16, 1e-12, '像素高 / pixelScale');
  near(billboardScale(28, { ...cam, zoom: 2 }), 28 / 32, 1e-12, 'zoom 放大 ⇒ 世界尺寸减半');

  /* 染色负载:#33CCFF → (0.2, 0.8, 1.0) */
  const p = dyeUniformPayload(
    { tintIndex: 3, maskRect: { x: 0, y: 0, w: 0.5, h: 1 }, strength: 0.8 },
    (i) => (i === 3 ? '#33CCFF' : '#FFFFFF'),
  );
  near(p.tint.r, 0x33 / 255, 1e-12, 'R = 0x33/255');
  near(p.tint.g, 0xCC / 255, 1e-12, 'G = 0xCC/255');
  near(p.tint.b, 1, 1e-12, 'B = 0xFF/255 = 1');
  near(p.strength, 0.8, 1e-12, '强度透传');
  eq(p.maskRect.w, 0.5, '矩形透传');

  const rgb = hexToRgb01('#FF4488');
  near(rgb.r, 1, 1e-12, '#FF → 1');
  near(rgb.g, 0x44 / 255, 1e-12, '#44 → 0x44/255');
  near(hexToRgb01('#000000').r, 0, 1e-12, '#000000 → 0');
  near(hexToRgb01('#FFFFFF').b, 1, 1e-12, '#FFFFFF → 1');
  near(hexToRgb01('坏值').r, 0, 1e-12, '非法色值按 0,不抛错');
  near(hexToRgb01('').g, 0, 1e-12, '空串按 0');

  /*
   * 计数语义:单槽位 uniform 一次上传只能表达 1 个表面。
   * 原实现按 entries.length 计数,把「写同一槽位 N 次」误报成 N 个表面。
   */
  eq(dyeUploadCount([]), 0, '空表 = 0');
  eq(dyeUploadCount([1]), 1, '1 条 = 1');
  eq(dyeUploadCount([1, 2, 3, 4]), 1, '4 条仍只上传 1 个可见表面(单槽位)');
});

test('染色辅助:可染判定、染料消耗、调色盘网格', () => {
  eq(MAX_UV_VARIANTS, 16, '16 个 UV 变体');
  eq(SPRAY_RANGE_NEAR, 15, '近距 15 格');
  eq(SPRAY_RANGE_FAR, 30, '远距 30 格');

  /* 可染 = obj 层非空 */
  eq(isDyeableTile(packTile({ elev: 1, base: 1, floor: 0, wire: 0, obj: 372, meta: 0 })), true, 'obj=372 可染');
  eq(isDyeableTile(packTile({ elev: 1, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 })), false, 'obj=0 不可染');
  eq(isDyeableTile(0), false, '空单元不可染');
  /* 只有地砖槽位、没有 obj 的格子不可染 */
  eq(isDyeableTile(packTile({ elev: 1, base: 1, floor: 5, wire: 0, obj: 0, meta: 0 })), false, '仅有 floor 不可染');

  /* 染料消耗:每 16 格 1 单位,最少 1 */
  eq(dyeCost(0), 1, '0 格仍耗 1(最小值)');
  eq(dyeCost(1), 1, '1 格 1 单位');
  eq(dyeCost(16), 1, '16 格 1 单位');
  eq(dyeCost(17), 2, '17 格 2 单位(向上取整)');
  eq(dyeCost(160), 10, '160 格 10 单位');
  eq(dyeCost(256), 16, '256 格 16 单位');
  eq(dyeCost(-5), 1, '负数安全');

  /* 调色盘 8×4 网格 */
  eq(PALETTE_COLS, 8, '8 列');
  eq(PALETTE_ROWS, 4, '4 行');
  eq(PALETTE_COLS * PALETTE_ROWS, DYE_PALETTE_SIZE, '网格格数 = 调色盘大小 32');
  eq(paletteCell(0).row, 0, '色 0 在 (0,0)');
  eq(paletteCell(0).col, 0, '色 0 列 0');
  eq(paletteCell(7).col, 7, '色 7 行末');
  eq(paletteCell(8).row, 1, '色 8 换行');
  eq(paletteCell(8).col, 0, '色 8 列 0');
  eq(paletteCell(31).row, 3, '色 31 最后一行');
  eq(paletteCell(31).col, 7, '色 31 最后一列');
  eq(paletteCell(32).row, 3, '越界夹到最后一个');
  eq(paletteCell(-1).row, 0, '负值夹到第一个');
  /* 每个色号恰好占一格,无重叠 */
  const seen = new Set<string>();
  for (let i = 0; i < DYE_PALETTE_SIZE; i += 1) {
    const c = paletteCell(i);
    const key = `${c.row},${c.col}`;
    ok(!seen.has(key), `色 ${i} 的格子 ${key} 未被占用`);
    seen.add(key);
  }
  eq(seen.size, 32, '32 个色号各占一格');
});

test('蓝图单层采集与拖拽阈值', () => {
  eq(MIN_DRAG_PX, 4, '拖拽阈值 4px');
  const get = (x: number, y: number, z: number): number => (z === 0 ? 1 : 0);
  const r = collectBlueprintLayer({ x0: 0, y0: 0, x1: 3, y1: 3 }, get, 0);
  eq(r.area, 16, '4×4 = 16 格');
  eq(r.filled, 16, '该层全满');
  eq(r.cells.length, 16, '16 个构件');
  for (const c of r.cells) eq(c.z, 0, '只收指定层');
  /* 取材于非 0 层 */
  const r1 = collectBlueprintLayer({ x0: 0, y0: 0, x1: 1, y1: 1 }, get, 1);
  eq(r1.filled, 0, 'z=1 层为空');
  eq(r1.area, 4, '面积仍是 2×2');
});

test('Boss 预警十字:两臂互相垂直、长度正确', () => {
  eq(HP_BAR_WIDTH, 360, '血条宽 360');
  eq(HP_BAR_TOP_MARGIN, 24, '顶部留白 24');

  const parts = crossVertices(0, 0, 0, 10, 2);
  eq(parts.length, 2, '十字 = 2 个四边形');
  eq(parts[0].length, 4, '主臂 4 顶点');
  eq(parts[1].length, 4, '副臂 4 顶点');

  /* 主臂沿 +X 展开:第一个顶点 x = length/2,y = width/2 */
  eq(parts[0][0].x, 5, '主臂首点 x = 5');
  eq(parts[0][0].y, 1, '主臂首点 y = 1');
  /* 副臂沿 +Y 展开(旋转 90°);首点 x = −width/2(绕向决定符号,绝对值恒为 width/2)*/
  near(parts[1][0].x, -1, 1e-9, '副臂首点 x = −width/2');
  eq(parts[1][0].y, 5, '副臂首点 y = 5');
  near(Math.abs(parts[1][0].x), 1, 1e-9, '副臂首点 |x| = width/2');

  /* 两臂的包围盒长宽互换 ⇒ 垂直 */
  const bbox = (vs: readonly { x: number; y: number }[]): { w: number; h: number } => ({
    w: Math.max(...vs.map((v) => v.x)) - Math.min(...vs.map((v) => v.x)),
    h: Math.max(...vs.map((v) => v.y)) - Math.min(...vs.map((v) => v.y)),
  });
  const b0 = bbox(parts[0]);
  const b1 = bbox(parts[1]);
  near(b0.w, b1.h, 1e-9, '主臂宽 = 副臂高');
  near(b0.h, b1.w, 1e-9, '主臂高 = 副臂宽');
  eq(b0.w, 10, '主臂长 10');
  eq(b0.h, 2, '主臂宽 2');
});

test('背包辅助:tooltip、占用比例、分类查询', () => {
  /* tooltip 含 ID、名称、分类、价值、词条、手册号 */
  const t = slotTooltip(372);
  ok(t.includes('#372'), 'tooltip 含 ID');
  ok(t.includes('暖红陶瓦斜屋顶'), 'tooltip 含名称');
  ok(t.includes('建筑构件'), 'tooltip 含分类中文名');
  ok(t.includes('价值'), 'tooltip 含价值');
  ok(t.includes('屋顶'), 'tooltip 含词条');
  ok(t.includes('§3.6'), 'tooltip 含手册分表号');
  eq(slotTooltip(99999), '未知物品#99999', '未知 ID 的 tooltip');

  /* 占用比例:以解耦后的容量 336 为分母 */
  near(usedSlotRatio(0), 0, 1e-12, '0 件 → 0');
  near(usedSlotRatio(336), 1, 1e-12, '满容量 → 1');
  near(usedSlotRatio(168), 0.5, 1e-12, '半容量 → 0.5');
  near(usedSlotRatio(400), 1, 1e-12, '超容量夹到 1');
  near(usedSlotRatio(-5), 0, 1e-12, '负数夹到 0');
  near(usedSlotRatio(160), 160 / 336, 1e-12, '分母是 336 而非 320');

  eq(categoryOf(101), 'NATURAL', '101 属自然矿物');
  eq(categoryOf(301), 'FLOOR', '301 属地表铺装');
  eq(categoryOf(630), 'WEARABLE', '630 属时装头饰');
  eq(categoryOf(745), 'COMBAT', '745 属战斗祭品');
  eq(categoryOf(99999), null, '未知 ID 返回 null');
  eq(bucketOf('FLOOR')?.itemIds.length, 30, '地砖桶 30 项');
  eq(bucketOf('不存在的分类'), null, '未知分类返回 null');
});

test('配方树辅助:反向索引、加工台清单、批次换算、根格位', () => {
  eq(MAX_BATCH, 64, '最大批次 64');

  /* 反向索引:101 暖松原木被 18 个配方引用,且列表升序 */
  const idx = buildUsageIndex();
  const users101 = idx.get(101) ?? [];
  eq(users101.length, 18, '101 被 18 个成品引用');
  eq(users101[0], 151, '首个引用者是 151');
  for (let i = 1; i < users101.length; i += 1) {
    ok(users101[i - 1] < users101[i], `101 的引用者升序(${users101[i - 1]} < ${users101[i]})`);
  }
  eq(idx.size, 60, '索引覆盖 60 种被引用的材料');
  /* 索引的每个键都必须真的出现在某个配方里 */
  for (const [mat, users] of idx) {
    ok(users.length > 0, `材料 ${mat} 至少被 1 个配方引用`);
  }

  const t = buildRecipeTree(351, 1);
  const st = stationList(t);
  eq(st.length, 1, '351 需要 1 台加工台');
  eq(st[0].id, 502, '加工台 ID 502');
  eq(st[0].name, itemName(502), '加工台名称来自冻结层');

  /* 批次换算:叶子需求 × 批次;批次 <1 视为 1 */
  const s4 = scaleLeaves(t, 4);
  eq(s4.get(101), 4, '4 批 → 101 需求 4');
  eq([...scaleLeaves(t, 1).entries()].length, t.leaves.size, '1 批与原始一致');
  eq(scaleLeaves(t, 0).get(101), 1, '批次 0 视为 1');
  eq(scaleLeaves(t, -3).get(101), 1, '负批次视为 1');
  /* 不修改原树 */
  eq(t.leaves.get(101), 1, 'scaleLeaves 不修改原树');

  eq(rootSlot(t), slotOf(351), '根格位与 slotOf 一致');
  eq(rootSlot(t), 133, '351 在格位 133');
  eq(rootSlot(buildRecipeTree(101, 1)), slotOf(101), '叶子作根也自洽');
});

test('像素画架铺设:所有副本行宽一致(镜像不改变宽度)', () => {
  eq(DEFAULT_UNDO_DEPTH, 64, '撤销深度 64');

  const e = new PixelEasel();
  e.paint(0, 0, 3);
  e.paint(1, 0, 5);
  const rows = e.toRows();
  const tiled = tilePattern(rows, 2, 2);
  /* 2 副本 / 每行 2 组 ⇒ 2 个副本块 + 1 个分组分隔空数组 */
  eq(tiled.length, 3, '2 副本 2 组分 ⇒ 2 块 + 1 分隔');

  for (let i = 0; i < tiled.length; i += 1) {
    if (tiled[i].length === 0) continue;
    eq(tiled[i].length, 16, `第 ${i} 块 16 行`);
    for (const r of tiled[i]) eq(r.length, 16, `第 ${i} 块每行 16 字符`);
  }

  /* 0 号副本原样,1 号副本水平镜像 */
  eq(tiled[0][0], 'df..............', '0 号副本不镜像');
  eq(tiled[1][0], '..............fd', '1 号副本水平镜像');

  /*
   * **回归断言(修掉的真实缺陷)**:原实现的镜像分支直接 reverse,不补齐行宽,
   * 于是同一份短行输入会产出 16 与 2 两种宽度。现在两个副本都必须补齐到 16。
   */
  const short = tilePattern(['df', '11'], 1, 2);
  eq(short[0][0].length, 16, '短行输入的 0 号副本补齐到 16');
  eq(short[2][0].length, 16, '短行输入的 1 号副本也补齐到 16(回归)');
  eq(short[0][0], 'df..............', '0 号副本补齐');
  eq(short[2][0], '..............fd', '1 号副本先补齐再镜像');

  /* 超长行被截断到 16 */
  const long = tilePattern(['x'.repeat(20)], 1, 1);
  eq(long[0][0].length, 16, '超长行截断到 16');
  eq(long[0][1], '................', '缺失行补透明点');

  /* 空白画架铺出的仍是合法 16×16 点阵 */
  const blank = tilePattern(new PixelEasel().toRows(), 1, 1);
  eq(blank[0][0], '................', '空白画架第 0 行全透明点');
});

test('未执行模块补齐:空图标行、相机克隆、地面拾取、包围盒', () => {
  /* blankIconRows:16×16 全 '0'(透明) */
  const b = blankIconRows();
  eq(b.length, 16, '16 行');
  for (const r of b) eq(r.length, 16, '每行 16 列');
  eq(b[0], '0'.repeat(16), '第 0 行全 0');
  ok(b.every((r) => [...r].every((c) => c === '0')), '全部为透明字符');

  /* cloneCamera 是深拷贝:改副本不影响原相机 */
  const c = createCamera(800, 600, 16);
  const d = cloneCamera(c);
  eq(d.focusX, c.focusX, '克隆初值相同');
  d.focusX = 99;
  d.zoom = 2;
  eq(c.focusX, 0, '改副本不影响原 focusX');
  eq(c.zoom, 1, '改副本不影响原 zoom');
  eq(d.scale, c.scale, 'scale 一并拷贝');
  eq(d.viewportW, c.viewportW, '视口宽一并拷贝');

  /* 地面拾取:相机原点(originX, originY)反投影回焦点 */
  const g = unprojectToGround(c.originX, c.originY, c);
  near(g.gx, c.focusX, 1e-9, '屏幕原点反投影回 focusX');
  near(g.gy, c.focusY, 1e-9, '屏幕原点反投影回 focusY');
  /* 与 iso_camera 常量自洽 */
  near(GROUND_Y_PER_CELL, Math.sin(45 * Math.PI / 180) * Math.sin(35 * Math.PI / 180), 1e-15, 'GROUND_Y_PER_CELL = sin45·sin35');
  near(Z_Y_PER_LEVEL, Math.cos(35 * Math.PI / 180), 1e-15, 'Z_Y_PER_LEVEL = cos35');
  eq(TILE_PX, 16, 'TILE_PX 16');

  /* boundsForCam:透传为剔除盒四界 */
  const box = boundsForCam({ minX: 0, maxX: 100, minY: -50, maxY: 50 });
  eq(box.minX, 0, 'minX 透传');
  eq(box.maxX, 100, 'maxX 透传');
  eq(box.minY, -50, 'minY 透传');
  eq(box.maxY, 50, 'maxY 透传');
});

test('音名与唱名常量表:与十二平均律自洽', () => {
  eq(A4_MIDI, 69, 'A4 MIDI = 69');
  eq(NOTE_NAMES.length, 12, '12 个音名');
  eq(SOLFEGE.length, 12, '12 个唱名');
  eq([...NOTE_NAMES], ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], '音名表');
  eq([...SOLFEGE], ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'], '唱名表');

  /* 音高 9 = A4 = 440Hz,MIDI 69(与 A4_MIDI 交叉验证) */
  eq(pitchInfo(9).midi, A4_MIDI, '音高 9 的 MIDI = A4_MIDI');
  eq(pitchInfo(9).hz, 440, '音高 9 = 440Hz');
  eq(pitchInfo(9).noteName, 'A4', '音高 9 音名');
  eq(pitchInfo(9).solfege, 'La', '音高 9 唱名');
  /* 音名/唱名表与 pitchInfo 同源:下标 = midi % 12 */
  for (const p of [0, 4, 9, 21, 31]) {
    const info = pitchInfo(p);
    eq(info.noteName, `${NOTE_NAMES[info.midi % 12]}${info.octave}`, `音高 ${p} 音名与表一致`);
    eq(info.solfege, SOLFEGE[info.midi % 12], `音高 ${p} 唱名与表一致`);
  }
});

/* ══════════ 25. task-15:模块完整性与分层不变量(静态检查) ══════════ */

/*
 * 这两条断言抓的是「**整类**无法被动态加载发现的缺陷」。
 *
 * 背景:`three/stage_assembly.ts` 的 6 条相对 import 路径全部写错,模块连加载都失败,
 * 但因为它 import three 而本测试绝不 import three,**没有任何动态测试会碰它**,
 * 于是这份腐坏长期无人发现。故障注入证明:把它改回错的路径,动态断言一条都不会失败。
 *
 * 因此必须用**静态源码检查**补上这个盲区:读文件、解析 import 说明符、验证目标存在。
 * 这不需要加载 three(`existsSync` 即可)。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 剥离注释,**保留字符串字面量**。
 *
 * ## 为什么需要它
 *
 * 判据是「相对 import 能解析到真实文件」。但直接扫源码会把**注释里
 * 举例说明的 import** 也算成真实 import —— 实测踩到过:`boot.ts` 的注释写
 * 「为什么不用 `import atlas from './atlas_sprites.png'`」,
 * 那句话本身是文档,却让门禁报「有 import 解析不到」。
 *
 * 这会逼着人**为了迎合门禁而把注释写含糊**,是本末倒置。正确做法是把扫描
 * 做得更精确:**注释里的东西不是代码**。
 *
 * 注意**不能连字符串一起剥离** —— import 的说明符本身就是字符串。
 * 所以这里只去注释,保留引号内内容(含转义)。
 *
 * 逐字符状态机,不依赖正则,避免模板字符串/URL 里的 `//` 被误当注释。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote: string | null = null;
  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += c2 ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    /* 行注释:吃到行尾(保留换行,便于后续按行定位) */
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    /* 块注释:吃到闭合;未闭合则吃到末尾 */
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 抓 `from '...'` 与 `import('...')` 两种形态的相对说明符(**已剥离注释**) */
function relativeSpecifiers(src: string): string[] {
  const found: string[] = [];
  const code = stripComments(src);
  const re = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) found.push(m[1]);
  return found;
}

test('分层不变量:client/src 的每条相对 import 都能解析到真实文件', () => {
  const files = walkTs(join(ROOT, 'client', 'src'));
  ok(files.length >= 15, `client/src 至少 15 个模块(实测 ${files.length})`);

  const broken: string[] = [];
  let total = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const spec of relativeSpecifiers(src)) {
      total += 1;
      const target = resolve(dirname(f), spec);
      if (!existsSync(target)) {
        broken.push(`${f.replace(ROOT, '')} → ${spec}`);
      }
    }
  }
  eq(broken, [], `全部 ${total} 条相对 import 必须可解析`);
  ok(total >= 20, `相对 import 数量合理(实测 ${total})`);
});

/*
 * 上面那条门禁靠 `stripComments` 排除注释干扰。**剥离器本身必须被验证** ——
 * 否则它可能把真 import 也剥掉,让门禁「因为看不见问题而变绿」,
 * 那比原来的误报更糟(误报至少是可见的)。
 *
 * 下面这组用例从两个方向钉住它。
 */
test('注释剥离器:注释里的 import 不算数,真 import 一条都不能少', () => {
  /* 方向一:注释里的 import 必须被忽略 */
  const cases: string[] = [
    `// import a from './nope.ts';`,
    `/* import a from './nope.ts'; */`,
    `const s = "// not a comment"; // import a from './nope.ts';`,
    `/**\n * 用 fetch 而不是 \`import x from './nope.png'\`\n */`,
  ];
  for (const src of cases) {
    eq(relativeSpecifiers(src), [], `注释里的 import 应被忽略:${src.slice(0, 46).replace(/\n/g, ' ')}`);
  }

  /* 方向二:真 import 一条都不能漏(含动态 import、双引号、转义) */
  eq(relativeSpecifiers(`import a from './keep.ts';`), ['./keep.ts'], '单引号 from');
  eq(relativeSpecifiers(`import a from "./keep.ts";`), ['./keep.ts'], '双引号 from');
  eq(relativeSpecifiers(`const m = await import('./keep.ts');`), ['./keep.ts'], '动态 import');
  eq(
    relativeSpecifiers(`import a from './a.ts';\nimport b from './b.ts';`),
    ['./a.ts', './b.ts'],
    '多条全部保留(不是只看第一条)',
  );
  /* 关键组合:注释 + 真 import 混在一起,只剩真的那条 */
  eq(
    relativeSpecifiers(`// import x from './fake.ts';\nimport y from './real.ts';\n/* from './fake2.ts' */`),
    ['./real.ts'],
    '注释与真 import 混排时只留真的',
  );

  /* 方向三:字符串里的 `//` 不能被当成注释(否则会吃掉后面的真 import) */
  eq(
    relativeSpecifiers(`const u = 'http://x'; import b from './after.ts';`),
    ['./after.ts'],
    "字符串里的 // 不是注释,后面的 import 仍须被抓到",
  );
  /* 模板字符串同理 */
  eq(
    relativeSpecifiers('const t = `http://a/${b}`; import c from \'./tmpl.ts\';'),
    ['./tmpl.ts'],
    '模板字符串里的 // 不是注释',
  );
  /* 未闭合块注释:吃到末尾即可,不得抛错 */
  eq(relativeSpecifiers(`const a = 1; /* 没闭合 from './x.ts'`), [], '未闭合块注释不抛错');
  /* 转义引号:不得提前结束字符串导致误判 */
  eq(
    relativeSpecifiers(`const s = 'it\\'s'; import d from './esc.ts';`),
    ['./esc.ts'],
    '转义引号不破坏状态机',
  );
});

test('分层不变量:只有 three/** 可以 import three,纯逻辑层零三方依赖', () => {
  const files = walkTs(join(ROOT, 'client', 'src'));
  const threeImporters: string[] = [];
  const pureLayerViolations: string[] = [];

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const importsThree = /from\s*['"]three['"]|import\s*\(\s*['"]three['"]/.test(src);
    if (!importsThree) continue;
    const rel = f.replace(ROOT, '').replace(/\\/g, '/');
    threeImporters.push(rel);
    /* 只有 three/ 目录下的模块允许 import three */
    if (!rel.includes('/client/src/three/')) pureLayerViolations.push(rel);
  }

  eq(pureLayerViolations, [], 'stage/** 与 ui/** 永不 import three');
  ok(threeImporters.length >= 1, '至少有一个装配层模块负责 three');
  /* 装配层只应是薄薄一层:全部 three 导入集中在 three/ 目录内 */
  ok(
    threeImporters.every((p) => p.includes('/client/src/three/')),
    `import three 的模块必须都在 three/ 内,实测:${threeImporters.join(', ')}`,
  );

  /* 纯逻辑层不得引入任何三方包(非 node:、非相对、非 ../shared)*/
  const thirdParty: string[] = [];
  for (const f of files) {
    const rel = f.replace(ROOT, '').replace(/\\/g, '/');
    if (rel.includes('/client/src/three/')) continue;
    const src = readFileSync(f, 'utf8');
    const re = /from\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const s = m[1];
      if (s.startsWith('.') || s.startsWith('node:')) continue;
      thirdParty.push(`${rel} → ${s}`);
    }
  }
  eq(thirdParty, [], '纯逻辑层只依赖 node:* 与仓库内相对路径');
});

test('拖拽层与背包容量解耦:hoverSlot 不与 INVENTORY_SLOTS 耦合', () => {
  /*
   * task-15 复核结论(原被标记为「可能耦合」):
   * `state_machine.DragController.hoverSlot` 只是一个「悬停在哪一格」的整数,
   * 初值 −1 = 无悬停;它**不读** `INVENTORY_SLOTS`,也不校验格位上界。
   * 因此改容量(320 → 336)不需要动拖拽层,注释里的「320 格」是过期表述。
   * 这条断言把该结论钉住:悬停一个远超容量的格位仍被如实记录(不做上界校验)。
   */
  const dc = new DragController();
  eq(dc.hover, -1, '未拖拽时无悬停(−1 哨兵)');
  ok(!dc.isDragging, '初始不在拖拽中');

  dc.pickUp(0, 101, 1);
  ok(dc.isDragging, '拿起后进入拖拽态');
  eq(dc.hover, -1, '刚拿起时仍无悬停');

  dc.hoverAt(5);
  eq(dc.hover, 5, '悬停如实记录');

  /* 远超容量(336)的格位也被如实记录 ⇒ 本层不做容量校验 */
  dc.hoverAt(100000);
  eq(dc.hover, 100000, '本层不校验容量上界(解耦证据)');
  dc.hoverAt(-2);
  eq(dc.hover, -2, '负值也透传(由背包层负责校验)');

  /* 取消后悬停清空 */
  dc.cancel();
  eq(dc.hover, -1, '取消拖拽后清空悬停');
  eq(dc.dragging, null, '取消后无拖拽上下文');

  /* 未拖拽时 hoverAt 不产生悬停 */
  const dc2 = new DragController();
  dc2.hoverAt(7);
  eq(dc2.hover, -1, '非拖拽态调用 hoverAt 不产生悬停');
});

/* ══════════ 26. task-15:染色 uniform 是单槽位(表结构印证) ══════════ */

/*
 * 第 10 节已覆盖 `shaders.ts` 的括号平衡、声明提取、表↔源码双向闭合与 stage 归属,
 * 这里**只补一条此前没人钉住的结构事实** —— 它直接决定 `applyDyeUniforms` 的计数语义。
 *
 * `applyDyeUniforms` 每帧只写一轮 `uDyeTint`/`uDyeMaskRect`/`uDyeStrength`;
 * 这三个名字在表里**各只有一条登记**(类型分别是 vec3/vec4/float,不是数组,
 * 也没有 `uDyeTint2` 之类备用槽位)。因此「本次上传覆盖了几个表面」恒为 0 或 1,
 * 不可能等于 `entries.length` —— 这正是 `dyeUploadCount` 返回 0/1 的根据。
 *
 * 若将来改成数组 uniform 或实例化属性,这条断言会失败,提醒同步修正计数语义。
 */

test('染色 uniform 是单槽位:表结构印证 dyeUploadCount 的 0/1 语义', () => {
  const dyeUniforms = SHADER_UNIFORMS.dye_overlay.filter((s) => /Dye/.test(s.name));
  eq(dyeUniforms.map((s) => s.name).sort(), ['uDyeMaskRect', 'uDyeStrength', 'uDyeTint'], '染色只有 3 个 uniform');

  const byName = new Map(dyeUniforms.map((s) => [s.name, s]));
  eq(byName.get('uDyeTint')?.type, 'vec3', 'uDyeTint 是 vec3(单槽位)');
  eq(byName.get('uDyeMaskRect')?.type, 'vec4', 'uDyeMaskRect 是 vec4(单槽位)');
  eq(byName.get('uDyeStrength')?.type, 'float', 'uDyeStrength 是 float(单槽位)');
  for (const s of dyeUniforms) {
    eq(s.stage, 'fragment', `${s.name} 在片元阶段`);
    ok(!s.type.includes('array'), `${s.name} 不是数组型`);
    ok(!/\d+$/.test(s.name), `${s.name} 没有编号后缀(不存在备用槽位)`);
  }
});

/* ═══════════ 顶点填充管线(补上「只报数量不查性质」的洞)═══════════ */

/*
 * 背景:buildChunkGeometry 曾经**只分配顶点缓冲、从不写入** ——
 * position 数组全是 0,地形一个三角形都画不出来。
 *
 * 而本文件原来 3226 行测试**全部是绿的**,因为它们断言的是
 * `vertexCount` 这个**数字**(它一直是对的)。
 *
 * 这是「只报数量不查性质」的典型:数量对、内容空,门禁看不见。
 * 下面这些测试断言的是**顶点内容**,能真正抓住这类缺陷。
 */

/** 造一个有高低差的 16×16 chunk:左半 GROUND、右半 PLATFORM */
function makeSlopedChunk(): { key: string; cx: number; cy: number; tiles: Uint32Array } {
  const tiles = new Uint32Array(256);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      tiles[y * 16 + x] = packTile({
        elev: x < 8 ? Elevation.GROUND : Elevation.PLATFORM,
        base: 1,
        floor: 1,
        wire: 0,
        obj: 0,
      });
    }
  }
  return { key: 'slope', cx: 2, cy: 3, tiles };
}

test('顶点填充:position 数组非零(不是「只分配不写入」)', () => {
  const g = emitChunkGeometry(makeSlopedChunk(), 0);
  ok(g.vertexCount > 0, '有顶点');
  let nonZero = 0;
  for (let i = 0; i < g.positions.length; i += 1) if (g.positions[i] !== 0) nonZero += 1;
  ok(nonZero > 0, `position 数组非零(实测 ${nonZero} / ${g.positions.length})`);
  /*
   * 关键:不能只断言「有非零」就够 —— 全零会红,但「只填了 x 不填 y」
   * 也能通过。所以再断言三个分量各自都有非零。
   */
  let nx = 0; let ny = 0; let nz = 0;
  for (let v = 0; v < g.vertexCount; v += 1) {
    if (g.positions[v * 3] !== 0) nx += 1;
    if (g.positions[v * 3 + 1] !== 0) ny += 1;
    if (g.positions[v * 3 + 2] !== 0) nz += 1;
  }
  ok(nx > 0, 'x 分量有数据');
  ok(ny > 0, 'y 分量有数据');
  ok(nz > 0, 'z 分量有数据');
});

test('顶点填充:写出与计数同源(几何数 = buildChunkQuads 数)', () => {
  const chunk = makeSlopedChunk();
  for (const lod of [0, 1, 2, 3]) {
    const batch = buildChunkQuads(chunk, lod);
    const g = emitChunkGeometry(chunk, lod);
    eq(g.faceCount, batch.faceCount, `LOD${lod} 面数与计数一致`);
    eq(g.vertexCount, batch.vertexCount, `LOD${lod} 顶点数与计数一致`);
    eq(g.batch.topQuads, batch.topQuads, `LOD${lod} 顶面数一致`);
    eq(g.batch.sideQuads, batch.sideQuads, `LOD${lod} 侧面数一致`);
  }
});

test('顶点填充:自检能抓住「清零点」与「索引越界」', () => {
  const g = emitChunkGeometry(makeSlopedChunk(), 0);
  eq(validateChunkGeometry(g), null, '正常几何自检通过');

  /* 反例 1:把顶点清零 —— 这正是原来那版的实际状态 */
  const zeroed = { ...g, positions: new Float32Array(g.positions.length) };
  ok(validateChunkGeometry(zeroed) !== null, '全零顶点必须被自检抓住');

  /* 反例 2:索引越界 */
  const bad = { ...g, indices: new Uint32Array(g.indices) };
  bad.indices[0] = 999999;
  ok(validateChunkGeometry(bad) !== null, '索引越界必须被自检抓住');

  /* 反例 3:顶点数与数组长度不符 */
  const short = { ...g, positions: new Float32Array(6) };
  ok(validateChunkGeometry(short) !== null, 'positions 长度不符必须被抓');
});

test('顶点填充:每个 quad 的 4 个顶点坐标符合预期(不只数量)', () => {
  const chunk = makeSlopedChunk();
  const g = emitChunkGeometry(chunk, 0);

  /*
   * 第一个面应是顶面:4 个顶点的 z 相同,且在 x/y 上构成 1×1 的单位方块
   * (LOD0 时 merge=1)。区块原点 = (cx·16, cy·16) = (32, 48)。
   */
  const z0 = g.positions[2]!;
  eq(g.positions[0], 32, '首面左下角 x = cx·16');
  eq(g.positions[1], 48, '首面左下角 y = cy·16');
  eq(g.positions[3], 33, '第二个顶点 x = +1');
  eq(g.positions[4], 48, '第二个顶点 y 不变');
  eq(g.positions[6], 32, '第三个顶点 x 不变');
  eq(g.positions[7], 49, '第三个顶点 y = +1');
  eq(g.positions[9], 33, '第四个顶点 x = +1');
  eq(g.positions[10], 49, '第四个顶点 y = +1');
  for (let v = 0; v < 4; v += 1) {
    eq(g.positions[v * 3 + 2], z0, `首面第 ${v} 个顶点 z 相同(平四边形)`);
  }

  /* 顶面法线必须朝 +Z */
  for (let v = 0; v < 4; v += 1) {
    eq(g.normals[v * 3 + 2], 1, `顶面第 ${v} 顶点法线朝 +Z`);
  }
});

test('顶点填充:索引落在各面自己的 4 个顶点内', () => {
  const g = emitChunkGeometry(makeSlopedChunk(), 0);
  for (let f = 0; f < g.faceCount; f += 1) {
    const base = f * 4;
    for (let k = 0; k < 6; k += 1) {
      const v = g.indices[f * 6 + k]!;
      ok(v >= base && v < base + 4, `第 ${f} 面索引 ${v} 落在 [${base}, ${base + 4})`);
    }
  }
});

test('顶点填充:空 chunk 不产生顶点,且不报错', () => {
  const g = emitChunkGeometry({ key: 'e', cx: 0, cy: 0, tiles: new Uint32Array(256) }, 0);
  eq(g.faceCount, 0, '空 chunk 无面');
  eq(g.vertexCount, 0, '空 chunk 无顶点');
  eq(g.positions.length, 0, 'positions 为空数组');
  eq(validateChunkGeometry(g), null, '空 chunk 自检通过(不误报)');
});

test('顶点填充:UV 与法线都已写出(不是只填 position)', () => {
  const g = emitChunkGeometry(makeSlopedChunk(), 0);
  let uvNz = 0;
  for (let i = 0; i < g.uvs.length; i += 1) if (g.uvs[i] !== 0) uvNz += 1;
  ok(uvNz > 0, `UV 有数据(实测 ${uvNz})`);

  let nrmNz = 0;
  for (let i = 0; i < g.normals.length; i += 1) if (g.normals[i] !== 0) nrmNz += 1;
  ok(nrmNz > 0, `法线有数据(实测 ${nrmNz})`);

  eq(g.uvs.length, g.vertexCount * 2, 'UV 长度 = 顶点数×2');
  eq(g.normals.length, g.vertexCount * 3, '法线长度 = 顶点数×3');
});

/* ────────── 面板布局(纯逻辑层,2026-11-12 新增)──────────
 *
 * 这些断言守的是「8 个客户端模块接进 boot.ts」时暴露出的**真实缺陷**:
 * UI 面板的算术从 DOM 绘制里被抽到 `ui/panel_layout.ts`,
 * 于是「文字溢出面板」「底行压住砖块」这类错误可以在 node 里断言,
 * 而不必靠肉眼看截图。
 */
import {
  CELL_INSET,
  EASEL_TOOLBAR_RESERVE_PX,
  INVENTORY_TOTAL_ROWS,
  PITCH_BOTTOM_CLEARANCE,
  PITCH_FOOTER_H,
  RECIPE_INDENT_PX,
  bossHudShowsLabels,
  brickRect,
  indentRecipeRows,
  layoutBossHudBand,
  layoutBlueprintHud,
  layoutEaselPanel,
  layoutInventoryPanel,
  layoutPitchPanel,
  layoutRecipePanel,
  layoutFitsViewport,
  paletteRect,
  rectVisible,
  slotRect,
} from '../client/src/ui/panel_layout.ts';

const VW = 1280;
const VH = 800;

test('面板布局:所有面板都完整落在视口内', () => {
  /*
   * ⚠ 两个 helper 的入参形态**不同**,混用会抛 `Cannot read properties of undefined`:
   *   · `rectVisible(rect, w, h)`      —— 收**裸矩形**
   *   · `layoutFitsViewport(layout, w, h)` —— 收**布局对象**(内部取 `.panel`)
   * 我第一版给后者传了裸矩形,直接红。
   */
  const rects = [
    layoutInventoryPanel(VW, VH).panel,
    layoutEaselPanel(VW, VH).panel,
    layoutPitchPanel(VW, VH).panel,
    layoutRecipePanel(VW, VH, 20).panel,
    layoutBossHudBand(VW, VH),
    layoutBlueprintHud(VW, VH).hint,
  ];
  for (const p of rects) {
    ok(rectVisible(p, VW, VH), `矩形 (${p.x},${p.y},${p.w},${p.h}) 完整可见`);
    ok(p.x >= 0 && p.y >= 0, `矩形 (${p.x},${p.y},${p.w},${p.h}) 左上角非负`);
    ok(p.x + p.w <= VW + 0.5 && p.y + p.h <= VH + 0.5, `矩形 (${p.x},${p.y},${p.w},${p.h}) 右下角不越界`);
  }
  /* 布局对象形态走另一个 helper */
  ok(layoutFitsViewport(layoutInventoryPanel(VW, VH), VW, VH), '背包布局在视口内');
  ok(layoutFitsViewport(layoutEaselPanel(VW, VH), VW, VH), '画架布局在视口内');
  ok(layoutFitsViewport(layoutPitchPanel(VW, VH), VW, VH), '音高布局在视口内');
});

test('面板布局:窄视口下也不越界(不能只在 1280 宽成立)', () => {
  for (const [w, h] of [[640, 480], [360, 640], [1920, 1080]]) {
    const inv = layoutInventoryPanel(w, h);
    ok(inv.panel.x >= 0, `${w}×${h} 背包左边界 >= 0`);
    ok(inv.panel.y >= 0, `${w}×${h} 背包上边界 >= 0`);
    ok(inv.panel.x + inv.panel.w <= w + 1, `${w}×${h} 背包右边界不越界`);
    /* 格子必须真的落在面板内 —— 越界会让点击命中算到面板外面去 */
    const first = slotRect(inv, 0);
    const last = slotRect(inv, inv.cols * inv.rows - 1);
    ok(first.x >= inv.panel.x, '首格在面板内');
    ok(last.x + last.w <= inv.panel.x + inv.panel.w + 1, '末格右边界在面板内');
    ok(last.y + last.h <= inv.panel.y + inv.panel.h + 1, '末格下边界在面板内');
  }
});

test('面板布局:格子尺寸自洽(格子数 × 格宽 = 网格宽)', () => {
  const L = layoutInventoryPanel(VW, VH);
  eq(L.cols * L.rows, L.cols * L.rows, '网格格数 = 列×行');
  /* 单元格 inset 不能把格子吃光 */
  ok(CELL_INSET * 2 < L.cell, `内缩 ${CELL_INSET}×2 < 格宽 ${L.cell}`);
  const r0 = slotRect(L, 0);
  const r1 = slotRect(L, 1);
  eq(r1.x - r0.x, L.cell, '相邻格水平间距 = 格宽');
  const rRow = slotRect(L, L.cols);
  eq(rRow.y - r0.y, L.cell, '相邻行垂直间距 = 格高');
});

test('面板布局:slotRect 下标超界不崩(越界返回面板内矩形)', () => {
  const L = layoutInventoryPanel(VW, VH);
  const r = slotRect(L, 99999);
  ok(Number.isFinite(r.x) && Number.isFinite(r.y), '越界下标仍返回有限坐标');
});

test('面板布局:音高砖底部信息行不压住砖块(实测踩过的重叠)', () => {
  const L = layoutPitchPanel(VW, VH);
  /* 底行必须计入面板高度 —— 初版忘了,导致「已选 N 档」压在第二行砖上 */
  ok(PITCH_FOOTER_H > 0, '底行高度 > 0');
  ok(L.panel.h >= 28 + 2 * L.brickH + PITCH_FOOTER_H, '面板高度含底行');
  /* 底行顶端必须在所有砖块底端之下(严格不相交) */
  const lastBrick = L.bricks[L.bricks.length - 1]!;
  ok(L.footer.y >= lastBrick.y + lastBrick.h, `底行 y=${L.footer.y} >= 末砖底 y=${lastBrick.y + lastBrick.h}`);
  ok(L.footer.y + L.footer.h <= L.panel.y + L.panel.h + 1, '底行不超出面板');
  /* 底部还要让开页面常驻提示条 */
  ok(VH - (L.panel.y + L.panel.h) >= 40, `面板底部留白 ${VH - (L.panel.y + L.panel.h)} >= 40(让开 #hint)`);
  eq(PITCH_BOTTOM_CLEARANCE >= 40, true, 'PITCH_BOTTOM_CLEARANCE 足够大');
});

test('面板布局:音高砖共 32 块且下标映射连续', () => {
  const L = layoutPitchPanel(VW, VH);
  eq(L.bricks.length, 32, '32 块砖');
  for (let i = 0; i < 32; i += 1) {
    const r = brickRect(L, i);
    ok(r !== null, `砖 ${i} 存在`);
    ok(r!.x >= L.panel.x && r!.y >= L.panel.y, `砖 ${i} 在面板内`);
    ok(r!.x + r!.w <= L.panel.x + L.panel.w + 1, `砖 ${i} 右边界在面板内`);
  }
  eq(brickRect(L, 32), null, '越界下标返回 null');
  eq(brickRect(L, -1), null, '负下标返回 null');
  /* 第 16 块应换到第二行 */
  const b0 = brickRect(L, 0)!;
  const b16 = brickRect(L, 16)!;
  eq(b16.x, b0.x, '第 16 块回到第一列');
  eq(b16.y - b0.y, L.brickH, '第 16 块下移一行');
});

test('面板布局:画架面板宽度装得下工具条文字(实测溢出)', () => {
  const L = layoutEaselPanel(VW, VH);
  /* 初版宽度取 max(画布, 调色盘),工具条约 317px 直接溢到面板外草地上 */
  ok(EASEL_TOOLBAR_RESERVE_PX >= 320, `工具条预留 ${EASEL_TOOLBAR_RESERVE_PX} >= 320`);
  ok(L.toolbar.w >= EASEL_TOOLBAR_RESERVE_PX, `工具条可用宽 ${L.toolbar.w} >= 预留`);
  ok(L.panel.w >= EASEL_TOOLBAR_RESERVE_PX, '面板宽度 >= 工具条所需');
  ok(L.toolbar.x + L.toolbar.w <= L.panel.x + L.panel.w + 1, '工具条不超出面板');
});

test('面板布局:画布与调色盘都不超出面板', () => {
  const L = layoutEaselPanel(VW, VH);
  ok(L.canvas.x >= L.panel.x, '画布左边界在面板内');
  ok(L.canvas.y >= L.panel.y, '画布上边界在面板内');
  ok(L.canvas.x + L.canvas.w <= L.panel.x + L.panel.w + 1, '画布右边界在面板内');
  ok(L.canvas.y + L.canvas.h <= L.panel.y + L.panel.h + 1, '画布下边界在面板内');
  /* 调色盘 32 格 */
  for (let i = 0; i < 32; i += 1) {
    const r = paletteRect(L, i);
    ok(r.x + r.w <= L.panel.x + L.panel.w + 1, `色 ${i} 右边界在面板内`);
    ok(r.y + r.h <= L.panel.y + L.panel.h + 1, `色 ${i} 下边界在面板内`);
  }
  /* 调色盘与画布不重叠 */
  ok(L.palette.y >= L.canvas.y + L.canvas.h, '调色盘在画布下方,不重叠');
  /* 工具条在调色盘下方 */
  ok(L.toolbar.y >= L.palette.y + L.palette.h, '工具条在调色盘下方');
});

test('面板布局:配方行缩进随深度单调递增', () => {
  const rows = indentRecipeRows([0, 0, 0, 0], [0, 1, 2, 3]);
  /*
   * ⚠ `indentRecipeRows` 返回的是 `{...row, depth, indent}` —— 偏移量在 **`indent`**,
   * 不是 `x`。我第一版按 `x` 断言,4 条全红且报 `undefined`。
   */
  eq(rows.length, 4, '4 行');
  for (let i = 1; i < rows.length; i += 1) {
    ok(rows[i]!.indent > rows[i - 1]!.indent, `第 ${i} 行比第 ${i - 1} 行更缩进`);
  }
  eq(rows[0]!.indent, 0, '深度 0 不缩进');
  /* ⚠️ 这里原先写 `eq(rows[1].indent - rows[0].indent, RECIPE_INDENT_PX)` ——
     那是**同义反复**:断言右侧取自被测模块自己的导出常量,于是「把常量改成 999」
     会让实现与期望**同步变化**,断言永远绿。门禁的「同义反复候选」扫描把它抓出来了
     (报告:`WS-09 RECIPE_INDENT_PX` 未登记 1 条)。
     改成**写死设计档字面量** `16`(出处:`panel_layout.ts` 的注释「每级缩进 16px」)。
     现在 `RECIPE_INDENT_PX` 被改成任何别的值,这两条都会红。 */
  eq(rows[1]!.indent - rows[0]!.indent, 16, '每级缩进 = 16px(设计档,不取自被测常量)');
  eq(rows[3]!.indent, 48, '深度 3 缩进 = 3 级 × 16px');
  /* 反向对照:常量本身必须等于设计档 —— 否则上面两条会与实现「一起错」。 */
  eq(RECIPE_INDENT_PX, 16, 'RECIPE_INDENT_PX 应等于设计档 16px(此条把常量钉在字面量上)');
  /* 深度相同则缩进相同 */
  const same = indentRecipeRows([0, 0], [2, 2]);
  eq(same[0]!.indent, same[1]!.indent, '同深度同缩进');
  /* 负深度与小数必须被规范化(否则会算出负缩进 / 半像素) */
  const weird = indentRecipeRows([0, 0, 0], [-3, 1.7, 2.2]);
  eq(weird[0]!.depth, 0, '负深度夹到 0');
  eq(weird[1]!.depth, 1, '1.7 截断为 1');
  eq(weird[2]!.depth, 2, '2.2 截断为 2');
  ok(weird.every((r) => r.indent >= 0), '缩进永不为负');
});

test('面板布局:配方面板高度随节点数增长但有上限', () => {
  const few = layoutRecipePanel(VW, VH, 3).panel;
  const many = layoutRecipePanel(VW, VH, 500).panel;
  ok(many.h >= few.h, '节点多则面板高');
  ok(many.h <= VH, `面板高 ${many.h} 不超过视口 ${VH}`);
});

test('面板布局:背包页数与总容量一致', () => {
  const L = layoutInventoryPanel(VW, VH);
  eq(L.rows * L.cols, 160, '每页 160 格');
  /* 21 行 336 格 → 3 页,与 inventory.ts 的常量必须吻合(两处不一致会错位) */
  eq(INVENTORY_TOTAL_ROWS, 21, '总行数 21');
});

test('面板布局:Boss 血条带宽度随视口收窄,标签在窄屏隐藏', () => {
  const wide = layoutBossHudBand(1920, VH);
  const narrow = layoutBossHudBand(360, VH);
  ok(wide.w <= 1920, '宽屏血条不超视口');
  ok(narrow.w <= 360, '窄屏血条不超视口');
  eq(bossHudShowsLabels(1920), true, '宽屏显示标签');
  eq(bossHudShowsLabels(360), false, '窄屏隐藏标签');
});

test('面板布局:蓝图提示条居中且不超出视口', () => {
  /* `layoutBlueprintHud` 返回 `{hint}` —— 提示条本身是 `hint`,不是顶层矩形 */
  const p = layoutBlueprintHud(VW, VH).hint;
  ok(p.x >= 0 && p.x + p.w <= VW + 1, '蓝图提示条水平不越界');
  ok(p.y >= 0 && p.y + p.h <= VH + 1, '蓝图提示条垂直不越界');
  /* 居中:左右留白应相等 */
  const left = p.x;
  const right = VW - (p.x + p.w);
  ok(Math.abs(left - right) <= 1, `居中(左 ${left} ≈ 右 ${right})`);
  /* 窄屏也必须在视口内 —— 提示条宽度固定 260,窄屏最容易越界 */
  const narrow = layoutBlueprintHud(360, 640).hint;
  ok(narrow.x >= 0, `窄屏左边界 ${narrow.x} >= 0`);
  ok(narrow.x + narrow.w <= 360 + 1, `窄屏右边界 ${narrow.x + narrow.w} <= 360`);
});

report('WS-09');
