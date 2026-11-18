/**
 * 接线台账 —— 「**实现了但生产里没人调用**」的显式登记(第六轮审计 P1/P3)。
 *
 * ## 为什么需要它
 *
 * 本仓反复出现的缺陷形态是「**算好了没人画**」:模块有实现、有测试、零三方依赖,
 * 但 `client/src` 里**没有任何调用点**。它不会让任何断言变红 —— 判据查的是模块自己
 * 的行为,而"谁在读它"不在那些判据里。
 *
 * 修前(`git grep` 实测)整整一块渲染层是这样:
 *
 * ```
 * three/stage_assembly.ts  buildShaderMaterial / buildPixelTexture / buildBillboard /
 *                          attachAuraEmitters / applyDyeUniforms / createStage   → 各 0 调用点
 * ui/panel_layout.ts       layoutRecipePanel / indentRecipeRows / layoutFitsViewport → 各 0 调用点
 * ```
 *
 * 连带 `stage/shaders.ts` 的 12 个着色器、`stage/particles.ts` 的粒子池、
 * `stage/dye_overlay.ts` 的染色通道、`entity_sprites.buildWeaponTexture` 全都没有消费者。
 *
 * ## 两种状态,都必须**可验证**
 *
 * | 状态 | 含义 | 判据(见 `tests/WS-FND-121`) |
 * |------|------|------------------------------|
 * | `wired` | 生产里真有调用点(已接上) | `client/src` 中**定义文件之外**至少 1 处调用 |
 * | `blocked` | **仍然没接**,并写明为什么 | 定义文件之外**仍然 0 处调用**(台账不许撒谎) |
 *
 * `blocked` 的那条"0 处调用"是**有牙齿**的:谁哪天把它接上了而忘了改台账,
 * 这条就会红 —— 那时候正确做法是把状态改成 `wired` 并删掉 `reason`
 * (而不是反过来去改判据)。
 *
 * ## 为什么这些条目"blocked"而不是硬接上
 *
 * 每一条都写了具体原因(见各项 `reason`)。共同点是:**接上它需要的输入不存在,
 * 或需要真浏览器截图基线来验收**,而"硬接一个没有数据的渲染路径"只会得到一个
 * 看起来接上了、画面上什么都没有的假接线 —— 那正是本台账要防的东西。
 */

/** 接线状态 */
export const WiringStatus = {
  /** 生产里真有调用点 */
  WIRED: 'wired',
  /** 仍未接:必须有 `reason`,且判据要求它**确实**还没有调用点 */
  BLOCKED: 'blocked',
} as const;
export type WiringStatus = (typeof WiringStatus)[keyof typeof WiringStatus];

export interface WiringEntry {
  /** 符号名(函数/方法名,判据按 `<symbol>(` 精确匹配调用点) */
  symbol: string;
  /** 定义所在文件(仓库相对路径;该文件内的出现**不算**调用点) */
  definedIn: string;
  status: WiringStatus;
  /** `wired` 的最小调用点数(默认 1);`blocked` 必须为 0 */
  callSites: number;
  /**
   * `blocked` 的**原因**(必填且非空)。
   * `wired` 写接线点(便于评审一眼看到"接在哪")。
   */
  reason: string;
}

export const WIRING_LEDGER: readonly WiringEntry[] = [
  /* ── 已接上(本轮真的加了调用点)── */
  {
    symbol: 'bossHudFrom',
    definedIn: 'client/src/ui/boss_hud.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'client/src/three/boot.ts 的 bossView():每帧从 RoomState.bosses 投影权威 HUD 视图',
  },
  {
    symbol: 'partyHudOf',
    definedIn: 'client/src/ui/party_hud.ts',
    status: WiringStatus.WIRED,
    callSites: 2,
    reason: 'boot.ts 的 uiState()/paintHint()/summary():meta.partyMode/partyTimer/scoreA/scoreB 的读者',
  },
  {
    symbol: 'stepZoom',
    definedIn: 'client/src/stage/iso_camera.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'boot.ts onKeyDown 的 `[` / `]`:6 档缩放唯一的写点(修前 isoCam.zoom 无写点)',
  },
  {
    symbol: 'drop',
    definedIn: 'client/src/ui/state_machine.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'boot.ts onUiPointerUp:抬手成交(修前全 client 零调用,拖拽永远走不到第三态)',
  },
  {
    symbol: 'tooltipFor',
    definedIn: 'client/src/three/ui_binding.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'ui_binding.drawNotes:悬停格的物品说明(修前零读者 ⇒ tooltip 永不显示)',
  },
  {
    symbol: 'layoutBossHudBand',
    definedIn: 'client/src/ui/panel_layout.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'ui_binding.drawBoss:血条背景框的位置(修前绘制层自己手算一份)',
  },
  {
    symbol: 'layoutBlueprintHud',
    definedIn: 'client/src/ui/panel_layout.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'ui_binding.drawNotes:蓝图提示条位置(修前硬编码 {300, h-108, 24})',
  },
  {
    symbol: 'rectVisible',
    definedIn: 'client/src/ui/panel_layout.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'ui_binding.drawNotes:视口外提示条显式跳过(修前零读者)',
  },

  /* ── 仍未接(登记原因;判据要求"定义文件之外 0 处调用")── */
  {
    symbol: 'createStage',
    definedIn: 'client/src/three/stage_assembly.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '它自建 `new THREE.WebGLRenderer` + `Scene` + 相机,而 boot.ts 已经有一套(且带图集立牌/'
      + '屋顶/LOD 的分层与 renderOrder)。两套同时跑 = **两个 WebGL 上下文 + 两张 canvas**;'
      + '把它替换掉 boot 那套需要真浏览器截图基线来验收(白屏/层序错都只在像素上可见),'
      + '本轮无浏览器,故登记而不硬接。',
  },
  {
    symbol: 'buildShaderMaterial',
    definedIn: 'client/src/three/stage_assembly.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '`stage/shaders.ts` 的 12 个程序(水面/草木/熔岩/染色)需要各自的顶点数据源'
      + '(水面高度场 / 熔岩温度 / 染色通道),而客户端快照里**没有这些字段**'
      + '(wire 的 ROOM/ENTITY 字段表只有位置/血量/状态位)。硬接 = 一个画不出东西的空材质。',
  },
  {
    symbol: 'buildPixelTexture',
    definedIn: 'client/src/three/stage_assembly.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '它把 `entity_sprites.buildWeaponTexture` 的 16×16 RGBA 包成 DataTexture。'
      + '现有立牌走图集 PNG(boot.ts 的 atlas 路径),换成程序生成的纹理要重做'
      + '「武器 id → 图集格」的对应,且立牌可能整块变透明(只在像素上可见);'
      + '需要截图基线,本轮不做。',
  },
  {
    symbol: 'buildBillboard',
    definedIn: 'client/src/three/stage_assembly.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '它按 `billboardScale(heightPx, cam)` 决定精灵尺寸,而 boot.ts 的立牌用'
      + '`SPRITE_CELL_WORLD`(≈1.561 世界单位)并有实测的锚点约定(0.15)。两者混用会让'
      + '立牌尺寸/脚底位置同时漂移(WS-09 的脚底对齐判据只在像素差分校准下可信)。',
  },
  {
    symbol: 'attachAuraEmitters',
    definedIn: 'client/src/three/stage_assembly.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '光环发射器要挂在**实体**节点上,而客户端只有玩家立牌一个实体节点'
      + '(野生/首领实体在屏幕上完全不画 —— 见本台账的 `bossHudFrom` 只驱动 HUD 文本)。'
      + '没有实体节点就没有挂点;先补实体渲染,再挂发射器。',
  },
  {
    symbol: 'applyDyeUniforms',
    definedIn: 'client/src/three/stage_assembly.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '染色数据来自 `stage/dye_overlay.ts` 的 `DyeChannel`,而**线上协议里没有染色字段**'
      + '(wire 的 tile/entity 表都不含 dye)。客户端拿到的快照里没有任何染色记录 ⇒ '
      + '上传 uniform 的输入恒空。要接必须先加协议字段(需动 server/src,本轮无权)。',
  },
  {
    symbol: 'layoutRecipePanel',
    definedIn: 'client/src/ui/panel_layout.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '它把配方树摆在**左上**(PANEL_MARGIN),而 `ui_binding.drawRecipe` 现在画在右上'
      + '(`w - 320 - 16`)且与背包面板共享同一列。迁移位置是可见的布局变更,'
      + '需要截图基线确认不与背包/画架重叠,本轮登记。',
  },
  {
    symbol: 'indentRecipeRows',
    definedIn: 'client/src/ui/panel_layout.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '它按节点深度算缩进,要求调用方给 `depths[]`;而 `drawRecipe` 画的是'
      + '`sortedLeaves()` 的**叶子列表**(没有深度信息)。要用它得先把绘制改成树形遍历 —— '
      + '与上一条同属"配方面板改版",一起做。',
  },
  {
    symbol: 'layoutFitsViewport',
    definedIn: 'client/src/ui/panel_layout.ts',
    status: WiringStatus.BLOCKED,
    callSites: 0,
    reason: '它是**断言式**布局检查(面板是否整体落在视口内),生产路径上没有任何'
      + '"越界了就怎样"的处置策略(缩?挪?不画?)。硬接一个只返回 boolean 的调用'
      + '等于加一行不改变行为的代码 —— 那正是本台账要防的假接线。',
  },
  {
    symbol: 'partyModeName',
    definedIn: 'client/src/ui/party_hud.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'client/src/main.ts:START_PARTY 的模式回声(服务端拿它跟模式名比,回下标会被判不一致)',
  },
];

/** 取某符号的台账条目(`null` = 未登记) */
export function ledgerEntry(symbol: string): WiringEntry | null {
  return WIRING_LEDGER.find((e) => e.symbol === symbol) ?? null;
}

/** 台账自检:`blocked` 必须有非空 `reason` 且 `callSites === 0`;`wired` 至少 1 处 */
export function validateLedger(
  entries: readonly WiringEntry[] = WIRING_LEDGER,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.symbol)) errors.push(`${e.symbol} 在台账里出现了两次`);
    seen.add(e.symbol);
    if (e.reason.trim() === '') errors.push(`${e.symbol} 缺少 reason`);
    if (e.status === WiringStatus.BLOCKED && e.callSites !== 0) {
      errors.push(`${e.symbol} 标为 blocked 却声明了 ${e.callSites} 处调用点`);
    }
    if (e.status === WiringStatus.WIRED && e.callSites < 1) {
      errors.push(`${e.symbol} 标为 wired 却没有调用点`);
    }
    /* 见证片段与状态必须**同向**:wired 要有片段,blocked 不许有 —— 否则台账
       会同时说"接上了"和"没接",两个判据各读一半就永远互相掩盖。 */
    const w = witnessOf(e.symbol);
    if (e.status === WiringStatus.WIRED && w === '') errors.push(`${e.symbol} 标为 wired 却没有见证片段`);
    if (e.status === WiringStatus.BLOCKED && w !== '') errors.push(`${e.symbol} 标为 blocked 却有见证片段`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * `wired` 条目的**见证片段**:必须在某个 `client/src/**` 源码里逐字出现。
 *
 * 为什么用"逐字片段"而不是"数调用点":
 *   · 数 `symbol(` 会把**定义行本身**(`drop(slot: number) {`、`tooltipFor(...) {`)
 *     也算成调用点 —— 而 `tooltipFor` 的调用点恰好与定义在同一个文件里;
 *   · 一个片段能同时表达"接在哪、以什么形态接"(`dragCtl.drop(hover)` 比
 *     `drop(` 多说明了两件事:谁持有它、参数是什么)。
 *
 * ⇒ `wired` 判据 = 片段逐字存在;`blocked` 判据 = 定义文件之外确实 0 处 `symbol(`。
 */
export const WIRED_WITNESS: Readonly<Record<string, string>> = {
  bossHudFrom: 'bossHudFrom(authority.state)',
  partyHudOf: 'partyHudOf(authority.state.meta)',
  stepZoom: 'stepZoom(isoCam,',
  drop: 'dragCtl.drop(hover)',
  tooltipFor: 'this.tooltipFor(',
  layoutBossHudBand: 'layoutBossHudBand(this.w, this.h)',
  layoutBlueprintHud: 'layoutBlueprintHud(this.w, this.h, true)',
  rectVisible: 'rectVisible(box, this.w, this.h)',
  partyModeName: 'partyModeName(handle.store.state.meta.partyMode)',
};

/** 某符号的见证片段(`''` = 没有:它应当仍是 `blocked`) */
export function witnessOf(symbol: string): string {
  return WIRED_WITNESS[symbol] ?? '';
}