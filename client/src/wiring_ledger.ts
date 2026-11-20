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
    reason: 'boot.ts onUiPointerUp:抬手成交(修前全 client 零调用,拖拽永远走不到第三态)。'
      + '⚠️ ★ 第十轮 P1:成交只改**本机格位状态**,**一条报文都不发**'
      + '(`RoomAction` 里没有 MOVE_ITEM;快照里也没有服务端的格子布局)'
      + ' ⇒ 它被登记为**本地整理视图**(口径常量 `DRAG_UPLINK = "local-only"`,'
      + '见 `ui/inventory.ts`),文案与手册都如实写明"刷新/重连即回原序"',
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
    reason: '光环发射器要挂在**实体**节点上,而客户端的实体节点只有 `player_marker` 与'
      + '`entitySprites`(野生 / 远端玩家的占位色块,见第七轮 P1)。'
      + '`stage/particles.ts` 的发射器要按 aura 种类建粒子池并每帧推进,'
      + '那需要一个带纹理/尺寸契约的真立牌(现在是 Sprite + 纯色),'
      + '硬接只会得到"看不见的粒子"。先补真图集立牌,再挂发射器。',
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

  /* ── ★ 第十轮(WS-FND-138):四个补入口的动作 —— 每个构建器都有**真调用点** ── */
  {
    symbol: 'breedTameRequest',
    definedIn: 'client/src/net/action_entry.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'net/action_binding.ts 的 trigger 的 breedTame 分支(键位 HOTBAR_KEYS 的 `1`)',
  },
  {
    symbol: 'buyItemRequest',
    definedIn: 'client/src/net/action_entry.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'net/action_binding.ts 的 trigger 的 buyItem 分支(键位 HOTBAR_KEYS 的 `2`)',
  },
  {
    symbol: 'useAlchemyFurnaceRequest',
    definedIn: 'client/src/net/action_entry.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'net/action_binding.ts 的 trigger 的 useAlchemyFurnace 分支(键位 HOTBAR_KEYS 的 `3`)',
  },
  {
    symbol: 'placeAutomationRequest',
    definedIn: 'client/src/net/action_entry.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'net/action_binding.ts 的 trigger 的 placeAutomation 分支(键位 HOTBAR_KEYS 的 `4`)',
  },
  {
    symbol: 'gatherRequest',
    definedIn: 'client/src/net/action_entry.ts',
    status: WiringStatus.WIRED,
    callSites: 1,
    reason: 'net/action_binding.ts 的 trigger 的 gather 分支(键位 HOTBAR_KEYS 的 `5`)',
  },
  {
    symbol: 'HOTBAR_KEYS',
    definedIn: 'client/src/net/action_binding.ts',
    status: WiringStatus.WIRED,
    callSites: 3,
    reason: 'action_binding.handleKey 的查表 + ui/panel_keys.keyGroups 的互斥判据'
      + ' + boot.ts 的 #hint(entryKeyHints/hotbarKeyHints)',
  },
  {
    symbol: 'DRAG_UPLINK',
    definedIn: 'client/src/ui/inventory.ts',
    status: WiringStatus.WIRED,
    callSites: 2,
    reason: 'boot.ts 的 lastMove 文案与自检口径的 dragUplink:拖拽是**本地整理视图**,'
      + '不发报文(修前只有一句注释,谁都不知道它不同步)',
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
  /* ★ 第十轮(WS-FND-138):四个补入口的构建器 + 两张新表 —— 见证片段取**调用点**,
     而不是定义行(定义行永远存在,等于没有声明"接上了")。 */
  breedTameRequest: 'return this.submit(breedTameRequest(input));',
  buyItemRequest: 'return this.submit(buyItemRequest(input));',
  useAlchemyFurnaceRequest: 'return this.submit(useAlchemyFurnaceRequest(input));',
  placeAutomationRequest: 'return this.submit(placeAutomationRequest(input));',
  /* ★ WS-FND-154:采集。见证片段取**调用点**(定义行永远存在,等于没有声明「接上了」)。 */
  gatherRequest: 'return this.submit(gatherRequest(input));',
  HOTBAR_KEYS: 'ENTRY_KEYS[k] ?? HOTBAR_KEYS[k]',
  DRAG_UPLINK: '本地整理视图(不发报文:${DRAG_UPLINK};刷新/重连即回原序)',
};

/** 某符号的见证片段(`''` = 没有:它应当仍是 `blocked`) */
export function witnessOf(symbol: string): string {
  return WIRED_WITNESS[symbol] ?? '';
}

/* ═══════════════════════════ 客户端**入口**台账(★ 第十轮 P1) ═══════════════════════════ */

/**
 * ## 为什么还要第二张台账
 *
 * 上面 `WIRING_LEDGER` 问的是「**客户端模块**里的符号有没有被调用」。
 * 第十轮实测的 P1 是**另一个方向**的缺口:
 * ```
 * 服务端有执行层(dispatchAction 真的会做事情)
 * 客户端**玩家按不到**(没有键、没有按钮、也没有专用报文)
 * ⇒ 「服务端能跑、玩家没反应」
 * ```
 * 这种缺口**不会让任何既有断言变红**:`WS-FND-18` 查的是服务端逐动作归类,
 * `WS-FND-121` 查的是客户端模块的调用点 —— 而"这个动作客户端有没有入口"两边都不问。
 *
 * ## 口径(逐条可断言)
 *
 * ```
 * status: 'wired'    ⇒ 客户端**代码**(剥掉注释后)里真的出现该动作名
 * status: 'missing'  ⇒ 客户端代码里**一次都不出现**(注释里提到不算 —— 注释不接线)
 * ```
 * ⚠️ 每条都必须覆盖 `RoomAction` 的**全部键**(判据逐键相等,不数总数):
 *   新增一个服务端动作而不作决定 ⇒ 当场红。这正是 `WS-FND-18` 在服务端那一侧
 *   做的事,本表把它搬到客户端这一侧。
 */

/** 客户端入口的有无。 */
export const ClientEntryStatus = {
  /** 玩家真的按得到(键 / 按钮 / 专用报文) */
  WIRED: 'wired',
  /** 服务端有,客户端**零入口** —— `reason` 必须写清为什么以及出路 */
  MISSING: 'missing',
} as const;
export type ClientEntryStatus = (typeof ClientEntryStatus)[keyof typeof ClientEntryStatus];

export interface ClientEntryRow {
  /** `server/src/net/room.ts` 的 `RoomAction` 名(逐字)。 */
  action: string;
  /** 服务端的执行层落点(人读的路径)。 */
  serverPath: string;
  /** 客户端入口:`键位` / `专用报文` / `missing`。 */
  entry: string;
  status: ClientEntryStatus;
  /** `wired` 写接入点;`missing` 写**为什么没有 + 出路**(必填且非空)。 */
  reason: string;
}

/**
 * 逐动作的客户端入口台账(★ 第十轮)。
 *
 * 第十轮补上的是最后四条 `wired`:`BREED_TAME` / `BUY_ITEM` /
 * `USE_ALCHEMY_FURNACE` / `PLACE_AUTOMATION`(键位 `net/action_binding.ts`
 * 的 `HOTBAR_KEYS`:1 / 2 / 3 / 4)。**修前它们是 `missing`**。
 *
 * ★ WS-FND-145:剩下的 8 条**全部**是房间管理类动作,裁决为「服务端已实现、客户端
 *   **刻意不提供**」—— 状态仍是 `missing`(它描述的是"玩家按不到"这个事实),
 *   但每一条都**必须**在 `CLIENT_ENTRY_HOLDS` 里有 `why` / `unblock` / `today` 三段,
 *   否则 `validateClientEntryLedger()` 当场红。台账因此没有"没有说明的 missing"。
 */
export const CLIENT_ENTRY_LEDGER: readonly ClientEntryRow[] = [
  {
    action: 'MOVE', serverPath: 'sim/world_sim.ts applyPlayerMove', entry: 'WASD/摇杆 → 专用报文 move',
    status: ClientEntryStatus.WIRED,
    reason: '不走 action 通道(坐标契约:绝对位置 + tick),入口在 main.ts 的输入链路',
  },
  {
    action: 'ATTACK', serverPath: 'sim/world_sim.ts attackMobAuthorized', entry: '鼠标左键 / 空格 → 专用报文 attack',
    status: ClientEntryStatus.WIRED,
    reason: 'main.ts 的 attackNearest;不走 action 通道(结算值经 attackResult 回执)',
  },
  {
    action: 'PLACE_BLOCK', serverPath: 'net/actions/material.ts', entry: 'Q(net/action_target.ts 的 ACTION_KEYS)',
    status: ClientEntryStatus.WIRED, reason: 'main.ts 的 ACTION_KEYS 监听 → action 报文(需要「最近物品」)',
  },
  {
    action: 'BREAK_BLOCK', serverPath: 'net/actions/material.ts', entry: 'E(ACTION_KEYS)',
    status: ClientEntryStatus.WIRED, reason: '同上;拆下来的 obj 会经回执记进「最近物品」',
  },
  {
    action: 'DROP_ITEM', serverPath: 'net/actions/material.ts', entry: 'G(ACTION_KEYS)',
    status: ClientEntryStatus.WIRED, reason: '同上(count 恒 1,落点取权威位置)',
  },
  {
    action: 'PICKUP_ITEM', serverPath: 'net/actions/material.ts', entry: 'F(ACTION_KEYS)',
    status: ClientEntryStatus.WIRED, reason: '同上',
  },
  {
    action: 'CRAFT', serverPath: 'net/actions/craft.ts', entry: 'N(ENTRY_KEYS)',
    status: ClientEntryStatus.WIRED, reason: 'action_binding 的 craft 槽位;`have` 由 have_ledger 供给',
  },
  {
    action: 'SLEEP', serverPath: 'net/actions/sleep.ts', entry: 'K(ENTRY_KEYS)',
    status: ClientEntryStatus.WIRED, reason: '空载荷,入口直接发',
  },
  {
    action: 'OPEN_CHEST', serverPath: 'net/actions/open_chest.ts', entry: 'O(ENTRY_KEYS)',
    status: ClientEntryStatus.WIRED, reason: '目标格用宿主给的「脚下那格」',
  },
  {
    action: 'USE_OWN_CHEST', serverPath: 'net/actions/use_own_chest.ts', entry: 'U(ENTRY_KEYS)',
    status: ClientEntryStatus.WIRED, reason: '同 OPEN_CHEST,只差动作名',
  },
  {
    action: 'START_PARTY', serverPath: 'net/actions/start_party.ts', entry: 'V(ENTRY_KEYS)',
    status: ClientEntryStatus.WIRED, reason: 'partyMode 回声取 meta.partyMode 的模式名',
  },
  {
    action: 'USE_ITEM', serverPath: 'net/actions/use_item.ts', entry: 'T(ENTRY_KEYS)',
    status: ClientEntryStatus.WIRED, reason: 'itemId 取「最近物品」;targetId 省略 = 对自己用',
  },
  {
    action: 'BREED_TAME', serverPath: 'net/actions/breed_tame.ts', entry: '1(HOTBAR_KEYS;op 由参数选)',
    status: ClientEntryStatus.WIRED,
    reason: '★ 第十轮补:键盘走 FEED(投喂 = 首次登记),petId 用权威快照的**实例 id**'
      + '、mobId 用物种 id;TAME/BREED/RANCH 由按钮路径带 op 参数走同一条路',
  },
  {
    action: 'BUY_ITEM', serverPath: 'net/actions/buy_item.ts', entry: '2(HOTBAR_KEYS)',
    status: ClientEntryStatus.WIRED,
    reason: '★ 第十轮补:键盘按 qty=1 买「最近物品」那一件;qty 在构建器里是必填(不猜 1)',
  },
  {
    action: 'USE_ALCHEMY_FURNACE', serverPath: 'net/actions/use_alchemy_furnace.ts', entry: '3(HOTBAR_KEYS)',
    status: ClientEntryStatus.WIRED,
    reason: '★ 第十轮补:站位由服务端判(客户端不报坐标);itemId 取「最近物品」',
  },
  {
    action: 'PLACE_AUTOMATION', serverPath: 'net/actions/place_automation.ts', entry: '4(HOTBAR_KEYS;播种形态)',
    status: ClientEntryStatus.WIRED,
    reason: '★ 第十轮补:键盘走**播种形态**(只给 itemId);组件形态(kind)由按钮路径给 ——'
      + '客户端不持有 wiring 的 kind 名单(见 CLIENT_ENTRY_GAPS 的 lane 行)',
  },
  {
    action: 'GATHER', serverPath: 'net/actions/gather.ts', entry: '5(HOTBAR_KEYS)',
    status: ClientEntryStatus.WIRED,
    reason: '★ WS-FND-154 补:目标格 = 宿主用 `cellInFront` 算的**面前那格**;'
      + '可采集性(内容表 §3.1 自然资源)/ 工具族词条 / 采集半径三件事**全在服务端判**'
      + '(`server/src/net/actions/gather.ts`),客户端不报「那一格是什么」'
      + '(快照里没有格子物件数据)。'
      + '为什么不让既有 `F`(拾取)改道:同一个理由 —— 客户端**判不出**'
      + '「面前有没有可采集物」,让一个键两义就是拿一次按键去猜。',
  },
  /* ── ★ WS-FND-145:剩下的 8 条**全部**裁决为「服务端已实现、客户端刻意不提供」──
     逐条的「为什么」与「解锁它的那一件事」在 `CLIENT_ENTRY_HOLDS`(同一份数据;
     别在这里再写一遍 —— 两处写同一段理由,迟早漂成两句不同的话)。 */
  {
    action: 'SET_ROOM_ACCESS', serverPath: 'net/room.ts RoomRuntime.setAccess', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供(见 CLIENT_ENTRY_HOLDS):改口令/容量要一个房主表单 + 口令输入口,'
      + '而客户端**没有任何房间管理 UI** ⇒ 裸键 = 一次误触改掉全房访问。',
  },
  {
    /* ★ WS-FND-151:这一条**从 `missing` 翻成 `wired`** —— 缺的那块 UI 已经补上
       (`ui/party_panel.ts` 的选择器 + `three/ui_binding.drawParty` 的绘制 +
       `net/action_entry.setPartyMode` 的报文)。CLIENT_ENTRY_HOLDS 里对应的登记
       同时删除(`validateClientEntryHolds` 要求"已接线的行不许还留在登记表里")。 */
    action: 'SET_PARTY_MODE', serverPath: 'net/room.ts RoomRuntime.setPartyModeBy',
    entry: 'M(模式面板;J/L 选 + Enter 定 / 点面板行)',
    status: ClientEntryStatus.WIRED,
    reason: '★ WS-FND-151 补:面板列出冻结层 `PARTY_MODES` 全部模式(名字 + 一句话规则),'
      + '选中即经 `net/action_entry.setPartyMode` 发一条 `{ action, partyMode: <key> }`;'
      + '权限(OWNER/ADMIN)仍由服务端 `authorize` 判,被拒会回一条带理由的 PERMISSION 回执。',
  },
  {
    action: 'KICK_MEMBER', serverPath: 'net/room.ts RoomRuntime.kick', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供:踢人不可逆,而快照里**没有成员角色**(`PlayerState` 无 role 字段)'
      + ' ⇒ 凭猜出来的列表接键,最可能踢掉的是房主或你自己。',
  },
  {
    action: 'SET_MEMBER_ROLE', serverPath: 'net/room.ts RoomRuntime.setMemberRole', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供:同 KICK_MEMBER —— `role` 是服务端权限位枚举,'
      + '快照里没有这个字段 ⇒ 连"把谁改成什么"都表达不出来。',
  },
  {
    action: 'RESET_WORLD', serverPath: 'net/actions/reset_world.ts', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供:不可逆,服务端要求 `confirm: true` 字面量(= 二次确认的机器形态);'
      + '没有确认对话框就接键 = 一次误触重置世界。',
  },
  {
    action: 'CLOSE_ROOM', serverPath: 'net/room.ts RoomRuntime.close', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供:不可逆(全房被踢)+ 服务端要权限位与显式请求;'
      + '与 RESET_WORLD 同一条:没有确认对话框就不给键。',
  },
  {
    action: 'MODIFY_TOWN', serverPath: 'net/actions/modify_town.ts', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供:要 `radius` / `name` / `totemCell` 三个**自由输入**,'
      + '客户端没有拾取坐标的 UI,也没有接到动作上的文本输入口。',
  },
  {
    action: 'WIRE_EDIT', serverPath: 'net/actions/wire_edit.ts', entry: 'missing',
    status: ClientEntryStatus.MISSING,
    reason: '刻意不提供:服务端**不下发线框数据** ⇒ 客户端画不出任何一条已存在的导线,'
      + '没有"编辑哪一个方向"的可见对象。',
  },
];

/* ══════════════ 2. 客户端「刻意不提供」的登记(★ WS-FND-145) ══════════════ */

/**
 * ## 为什么剩下的 8 条仍然写 `missing`,而不是硬接几个键
 *
 * 第十轮之后 `CLIENT_ENTRY_LEDGER` 里没有入口的 8 条**全是房间管理类**:
 * ```
 * SET_ROOM_ACCESS / SET_PARTY_MODE / KICK_MEMBER / SET_MEMBER_ROLE
 * RESET_WORLD / CLOSE_ROOM / MODIFY_TOWN / WIRE_EDIT
 * ```
 * 它们的共同形态是:
 * ```
 * 服务端有执行层(dispatchAction 真的会做)
 * 缺的不是"一行转发",而是它需要的那块 UI(表单 / 成员表 / 确认框 / 线框数据)
 * 而这块 UI 缺席时,接一个裸键 = 一次误触改掉**整个房间**的状态(其中一半不可逆)
 * ```
 * ⇒ 本轮的裁决是**第二个选项**:不接键,登记为「服务端已实现、客户端**刻意不提供**」,
 *   并把「为什么」「解锁它的那一件事」「玩家今天能做到哪一步」写成**可断言的数据**(本表)。
 *
 * ⚠️ 两条纪律,别弄反:
 *   · `missing` 描述的是**玩家按不到**这件事本身,不是欠账清单 —— 所以不因为"登记了"
 *     就改成 `wired`;
 *   · 「登记」也**不等于**"什么都不做":`validateClientEntryHolds()` 要求每一条 `missing`
 *     都在本表里,且 `why` / `unblock` / `today` 三段**全部非空** ⇒ 台账从此不可能出现
 *     "一条 missing 没有任何说明"。反向也查:`wired` 的行**不许**还留在本表里。
 *
 * 判据:`tests/WS-FND-145-client-entry-rest.test.ts`(逐条;含负对照)。
 */
export const ClientHoldKind = {
  /** 服务端已实现;客户端**刻意**不给键位/按钮(理由见 `why`)。 */
  DELIBERATE: 'deliberate',
} as const;
export type ClientHoldKind = (typeof ClientHoldKind)[keyof typeof ClientHoldKind];

/** 一条「刻意不提供」的登记。 */
export interface ClientHoldRow {
  /** 与 `CLIENT_ENTRY_LEDGER` 的 `action` **逐字**一致(那条必须是 `missing`)。 */
  action: string;
  /** 判定档位(今天只有「刻意不提供」一档 —— 接了线就该删掉这一行)。 */
  kind: ClientHoldKind;
  /** 为什么**刻意**不提供(不是"还没排期")。 */
  why: string;
  /** 解锁它的**那一件事**(一件独立任务;不是"以后再说")。 */
  unblock: string;
  /** 玩家**今天**能做到哪一步(做不到就如实写"做不到")。 */
  today: string;
}

export const CLIENT_ENTRY_HOLDS: readonly ClientHoldRow[] = [
  {
    action: 'SET_ROOM_ACCESS',
    kind: ClientHoldKind.DELIBERATE,
    why: '改访问模式是**房主表单**的一格:三选一 + 口令输入 + 回执回读,而客户端'
      + '**没有任何房间管理 UI**,也没有口令输入口(唯一的文本框是背包/配方搜索,它只喂过滤)'
      + '⇒ 接一个裸键就是"按一下改掉全房口令/容量",而状态条里**没有任何回读** ——'
      + '玩家看不到改成了什么,只会把队友关在门外。',
    unblock: '房间面板:访问模式单选 + 口令输入 + `effect.mode` 回读 + 权限位显示;'
      + '与 KICK_MEMBER / SET_MEMBER_ROLE 同一件任务(共用成员表)。',
    today: '做不到:口令/容量只能在**建房那一侧**定,客户端内改不了(如实写,不假装)。',
  },
  {
    action: 'KICK_MEMBER',
    kind: ClientHoldKind.DELIBERATE,
    why: '踢人不可逆,而且要一份**带角色的成员表**(谁是 OWNER/ADMIN)才踢得安全;'
      + '而快照的 `PlayerState` 只有 id/名字/位置/血量,**没有 role 字段** ⇒'
      + '凭一份"猜出来的"列表接键,最可能踢掉的是房主或你自己。',
    unblock: '先让快照下发成员角色(`PlayerState.role`),再做房间面板的成员表 + 踢人按钮。',
    today: '做不到(客户端既没有成员角色,也没有踢人入口)。',
  },
  {
    action: 'SET_MEMBER_ROLE',
    kind: ClientHoldKind.DELIBERATE,
    why: '`role` 是服务端**权限位枚举**(`RoomRole`),而快照里没有这个字段 ⇒'
      + '连"把谁改成什么"都表达不出来;在客户端硬编码一份角色名单又是第二份实现'
      + '(服务端加一档,客户端会静默发一个不存在的值)。',
    unblock: '同 KICK_MEMBER:成员表(数据来自快照)+ 角色下拉,而不是手抄的名单。',
    today: '做不到。',
  },
  {
    action: 'RESET_WORLD',
    kind: ClientHoldKind.DELIBERATE,
    why: '不可逆。服务端要求 `confirm: true` **字面量**(`net/actions/reset_world.ts`),'
      + '那正是"二次确认"的机器形态;客户端没有确认对话框,接一个裸键 = 一次误触'
      + '把世界、存档与所有人的进度一起重置。',
    unblock: '确认对话框(显示当前种子与新种子 + 明确的"重置"按钮),挂在房间面板里;'
      + '先做面板,再做这一格。',
    today: '做不到:没有确认对话框就不给键(PLAY.md 同一条)。',
  },
  {
    action: 'CLOSE_ROOM',
    kind: ClientHoldKind.DELIBERATE,
    why: '不可逆(房间关掉,所有人被踢)。`close()` 是**生命周期方法**(`onDispose` /'
      + '`reapEvictions` 也会调),所以权限闸写在 `actions/admin.ts` 里、要求显式请求 ⇒'
      + '没有确认对话框就接键,一次误触关掉全房的局。',
    unblock: '同 RESET_WORLD:房间面板 + 二次确认 + 权限位显示。',
    today: '做不到。',
  },
  {
    action: 'MODIFY_TOWN',
    kind: ClientHoldKind.DELIBERATE,
    why: '要三个**自由输入**:`radius`(整数)、`name`(文本)、`totemCell`(选一格或 `null` 清掉)。'
      + '客户端没有拾取坐标的 UI,也没有接到动作上的文本输入口(搜索框只喂背包过滤)'
      + '⇒ 三个字段里能给的只有"你脚下那格",半径与名字编不出来。',
    unblock: '城镇面板:点格取 `totemCell` + 半径滑杆 + 名字输入(长度上限取冻结常量,不手抄)。',
    today: '做不到(客户端既不能改城名/半径,也不能改图腾格)。',
  },
  {
    action: 'WIRE_EDIT',
    kind: ClientHoldKind.DELIBERATE,
    why: '服务端**不下发线框数据** ⇒ 客户端拿不到任何一条已存在的导线(快照里没有这类字段),'
      + '连"编辑哪一个方向"的对象都画不出来;而 `dir` / `color` / `channel` / `clear`'
      + '四个键都是相对**已存在的那条线**才有意义的。',
    unblock: '先让服务端下发 WireView(节点 / 方向 / 颜色 / 频道),再做接线面板 ——'
      + '与 `PLACE_AUTOMATION` 的 `lane` 配置同一块 UI。',
    today: '做不到(看不到已有导线 ⇒ 没有可编辑的对象)。',
  },
];

/**
 * **不是 `RoomAction` 的入口缺口** —— 同样如实登记,因为它们与上面同形
 * (服务端/世界侧有实现,客户端没有入口或只有一部分),而 `RoomAction` 那张表
 * 覆盖不到它们。
 *
 * ★ WS-FND-145:两条都补上 `kind` / `unblock` / `today` —— 与 `CLIENT_ENTRY_HOLDS`
 *   同一套口径(「刻意不提供」也要写清**解锁它的那一件事**与**今天能做到哪一步**)。
 */
export interface ClientEntryGap {
  /** 缺什么(人读的一句话)。 */
  what: string;
  /** 现状 + 为什么(必填且非空)。 */
  reason: string;
  /** 判定档位(与 `CLIENT_ENTRY_HOLDS` 同一档)。 */
  kind: ClientHoldKind;
  /** 解锁它的**那一件事**。 */
  unblock: string;
  /** 玩家**今天**能做到哪一步。 */
  today: string;
}

export const CLIENT_ENTRY_GAPS: readonly ClientEntryGap[] = [
  {
    what: '急单(rush)开局与交付:客户端**没有也不该有**专门入口',
    reason: '急单三段全在**世界侧**(`world_sim.tickPartyStep`):START → `startRushRun`'
      + '(食堂建成 + 三工位在场 + 有人站在工位格上),DELIVER → `submitDelivery`'
      + '(脚下 1 格内有订单点名的地面货),SETTLE → `settleSession`(状态变 SETTLED 那一慢帧)'
      + '—— 见 `server/src/coop/rush_actions.ts` 的 `RUSH_ACTION_LEDGER`,三条都是 `WIRED:`,'
      + '但**没有一条**要客户端发报文 ⇒ 不存在"少一个键"的缺口;'
      + '评级走**成功回执**的 `effect.rushGrade`(`net/action_entry.ts` 的'
      + '`describeEntryReceipt` 把它内联进状态条那一行),这也是入口。',
    kind: ClientHoldKind.DELIBERATE,
    unblock: '不需要新键:玩家侧要补的是**工位**(`Q` 放块 + WASD 站上去)与把货丢到**脚下**'
      + '(`G`,`RUSH_DELIVERY_RADIUS = 1` 与 `DROP_ITEM` 的 `target: under` 同口径)。'
      + '真要做"急单面板"(还剩几件 / 交了几件),那是 UI 任务,不是键位任务。',
    today: '建造工位(`Q`)→ 站上去(WASD)= 开工;把订单点名的货丢在**脚下**(`G`)+'
      + ' 站在工位格 = 交付;评级在状态条的**动作回执**那一行。',
  },
  {
    what: 'PLACE_AUTOMATION 的分拣带配置形态(`kind: LOGISTICS_SORTER` + `lane` + `itemId`)',
    reason: '键盘路径只给**播种形态**(`x` / `y` / `itemId`);`lane`(第几道收哪件)需要一个配置 UI'
      + '(选组件 → 选道号 → 选目标物品),而报文键 `lane` **不在** `ActionPayload` 契约里'
      + '(`server/src/net/room.ts` 那一格只有 `kind`)⇒ 客户端不替它发明一个字段。'
      + '判据:`tests/WS-FND-145` 逐字读那份契约,`lane` 一出现就红(那时才可以接线)。',
    kind: ClientHoldKind.DELIBERATE,
    unblock: '先给 `lane` 一个**契约位置**(`ActionPayload`),再做接线面板'
      + '(与 WIRE_EDIT 的线框下发一起做,否则用户看不到自己配的是什么)。',
    today: '键盘 `4` 只走**播种形态**;组件形态的 `kind` 只能由调用方给 ——'
      + '客户端界面上今天没有这个调用方。',
  },
];

/** 取某动作的客户端入口行(`null` = 未登记 —— 判据要求逐键覆盖) */
export function clientEntryRow(action: string): ClientEntryRow | null {
  return CLIENT_ENTRY_LEDGER.find((r) => r.action === action) ?? null;
}

/**
 * 客户端入口台账的**见证片段** —— `wired` 行必须逐字出现在客户端代码里
 * (**剥掉注释、并排除本文件**),`missing` 行必须是空串。
 *
 * 口径与 `WIRED_WITNESS` 同族,理由也一样:
 * ```
 * 数「动作名出现几次」会把**本台账自己**数进去 ⇒ 恒 ≥ 1 ⇒ 判据没有牙齿;
 * 而一个片段能同时说明"接在哪、以什么形态接"(`spec.action === 'DROP_ITEM'`
 * 比 `DROP_ITEM` 多说明了"它来自 ACTION_KEYS 那条监听")。
 * ```
 * `MOVE` / `ATTACK` 的见证是**专用报文的发送函数**(它们不走 `action` 通道)。
 */
export const CLIENT_ENTRY_WITNESS: Readonly<Record<string, string>> = {
  MOVE: 'session.sendMove({',
  ATTACK: 'session.sendAttack({',
  PLACE_BLOCK: "spec.action === 'PLACE_BLOCK'",
  BREAK_BLOCK: "action: 'BREAK_BLOCK'",
  DROP_ITEM: "spec.action === 'DROP_ITEM'",
  PICKUP_ITEM: "spec.action === 'PICKUP_ITEM'",
  CRAFT: "action: 'CRAFT'",
  SLEEP: "action: 'SLEEP'",
  OPEN_CHEST: "chestBuild('OPEN_CHEST'",
  USE_OWN_CHEST: "chestBuild('USE_OWN_CHEST'",
  START_PARTY: "action: 'START_PARTY'",
  USE_ITEM: "action: 'USE_ITEM'",
  BREED_TAME: "action: 'BREED_TAME'",
  BUY_ITEM: "action: 'BUY_ITEM'",
  USE_ALCHEMY_FURNACE: "action: 'USE_ALCHEMY_FURNACE'",
  PLACE_AUTOMATION: "action: 'PLACE_AUTOMATION'",
  /* ★ WS-FND-154:采集。见证片段取**构建器里的动作名**(定义行永远存在,等于没声明)。 */
  GATHER: "action: 'GATHER'",
  /* ★ WS-FND-151:设模式(模式面板)。见证片段取**构建器里的动作名** —— 定义行
     永远存在,等于没有声明"接上了";这里要求的是"真的有一条报文叫这个名字"。 */
  SET_PARTY_MODE: "action: 'SET_PARTY_MODE'",
};

/** 某动作的见证片段(`''` = 它应当仍是 `missing`:客户端代码里一次都不该出现) */
export function clientEntryWitnessOf(action: string): string {
  return CLIENT_ENTRY_WITNESS[action] ?? '';
}

/**
 * 取某动作的**登记**(`null` = 没登记 —— 对一条 `missing` 来说这就是"没有说明")。
 */
export function clientHoldRow(action: string): ClientHoldRow | null {
  return CLIENT_ENTRY_HOLDS.find((h) => h.action === action) ?? null;
}

/**
 * **只查一个方向**:`missing` 的行必须有登记。
 *
 * 为什么单独导出(而不是把整张 `CLIENT_ENTRY_HOLDS` 塞进下面那个函数):
 * `validateClientEntryLedger()` 允许调用方传**一小撮假行**(负对照用),
 * 而"登记里有孤儿"这件事只有在**整张台账**上才有意义 —— 两个方向混在一起,
 * 一个只传一行的负对照会被 8 条"无主登记"淹没,报错就失去指向性。
 */
export function missingRowsWithoutHold(
  rows: readonly ClientEntryRow[] = CLIENT_ENTRY_LEDGER,
  holds: readonly ClientHoldRow[] = CLIENT_ENTRY_HOLDS,
): string[] {
  const held = new Set(holds.map((h) => h.action));
  return rows
    .filter((r) => r.status === ClientEntryStatus.MISSING && !held.has(r.action))
    .map((r) => r.action);
}

/**
 * 登记自检(★ WS-FND-145)。三条,每条都配一条负对照(见 `tests/WS-FND-145`):
 * ```
 * missing 必须有登记,且 why(unblock/today)三段全非空  ⇒ 台账不可能"留 missing 而无说明"
 * 登记的必须是**当前仍然 missing** 的动作            ⇒ 接了线却忘了删登记 ⇒ 红
 * 登记不许重复、不许指向台账里没有的动作              ⇒ 无主登记 ⇒ 红
 * ```
 */
export function validateClientEntryHolds(
  rows: readonly ClientEntryRow[] = CLIENT_ENTRY_LEDGER,
  holds: readonly ClientHoldRow[] = CLIENT_ENTRY_HOLDS,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const h of holds) {
    if (seen.has(h.action)) errors.push(`${h.action} 在登记表里出现了两次`);
    seen.add(h.action);
    if (h.kind !== ClientHoldKind.DELIBERATE) {
      errors.push(`${h.action} 的登记档位不是 deliberate(${String(h.kind)})`);
    }
    if (h.why.trim().length < 20) {
      errors.push(`${h.action} 的 why 太短(必须说清"为什么刻意不提供",而不是"还没做")`);
    }
    if (h.unblock.trim() === '') errors.push(`${h.action} 没写 unblock(解锁它的那一件事)`);
    if (h.today.trim() === '') errors.push(`${h.action} 没写 today(玩家今天能做到哪一步)`);
    const row = rows.find((r) => r.action === h.action) ?? null;
    if (row === null) {
      errors.push(`登记表里的 ${h.action} 不在客户端入口台账里(无主登记)`);
    } else if (row.status !== ClientEntryStatus.MISSING) {
      errors.push(`${h.action} 已接线(${row.status})却还登记为"刻意不提供" ⇒ 删掉那条登记`);
    }
  }
  for (const action of missingRowsWithoutHold(rows, holds)) {
    errors.push(`★ ${action} 标为 missing 却没有登记(台账不许留"没有说明的 missing")`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 客户端入口台账自检:`missing` 必须给出非空理由 + **有登记**;动作名不许重复。
 *
 * ⚠️ 这里只串"missing 必须有登记"这一个方向;整张登记表的自检在
 * `validateClientEntryHolds()`(理由见 `missingRowsWithoutHold` 的注释)。
 */
export function validateClientEntryLedger(
  rows: readonly ClientEntryRow[] = CLIENT_ENTRY_LEDGER,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.action)) errors.push(`${r.action} 在客户端入口台账里出现了两次`);
    seen.add(r.action);
    if (r.action.trim() === '') errors.push('动作名不能为空');
    if (r.reason.trim() === '') errors.push(`${r.action} 缺少 reason`);
    if (r.status === ClientEntryStatus.MISSING && r.entry !== 'missing') {
      errors.push(`${r.action} 标为 missing 却写着入口 ${r.entry}`);
    }
    if (r.status === ClientEntryStatus.WIRED && r.entry === 'missing') {
      errors.push(`${r.action} 标为 wired 却写着入口 missing`);
    }
    if (r.serverPath.trim() === '') errors.push(`${r.action} 没写服务端落点`);
    /* 见证片段与状态必须**同向**:wired 要有片段、missing 不许有 ——
       否则台账会同时说"接上了"和"没接",两个判据各读一半就永远互相掩盖。 */
    const w = clientEntryWitnessOf(r.action);
    if (r.status === ClientEntryStatus.WIRED && w === '') {
      errors.push(`${r.action} 标为 wired 却没有见证片段(加进 CLIENT_ENTRY_WITNESS)`);
    }
    if (r.status === ClientEntryStatus.MISSING && w !== '') {
      errors.push(`${r.action} 标为 missing 却有见证片段:${w}`);
    }
  }
  for (const action of missingRowsWithoutHold(rows)) {
    errors.push(`★ ${action} 标为 missing 却没有登记(见 CLIENT_ENTRY_HOLDS)`);
  }
  return { ok: errors.length === 0, errors };
}