# 导出覆盖矩阵(工具 + 台账)

> **口径的正解在 `scripts/coverage-matrix.ts`,不在本文。**
> 本文只承载三件事,且这三块**由工具生成**(手改会被 `--check` 报红):
>
> ```text
> §1 三档统计      STATS   —— 可被代码算出来的数,这里只许是抄件
> §2 待处置清单    ROWS    —— 「文件:符号」逐条,状态列**由人填**
> §3 导出普查      CENSUS  —— 逐符号一行;「新增/消失的导出必须红」靠它
> ```
>
> 其余章节(§0 / §4 / §5 / §6)是人写的:判据的由来、结论、接线改法、已知边界。`--write` 不碰它们。

## 0 这个工具要解决的病

```text
上一轮(第十轮)把 server/src 的导出分成三档,结论只活在一台机器的 scratch 目录里。
⇒ 「覆盖如何」这个事实**没有可复算的来源**:
   · 数字是抄件,谁都不许再算一遍(算出来也对不上,因为口径没落到代码里);
   · 新加一个导出**不会**让任何东西绿→红 ⇒ 欠账只增不减,且没人知道增了。
⇒ 故本轮的产物不是「一份报告」,而是**判据(代码)+ 台账(可被比对)**。
```

复算命令:

```bash
node scripts/coverage-matrix.ts            # 可读表(人读;含 symbol-only 全列 + none∧生产引用的前 60 条)
node scripts/coverage-matrix.ts --json     # 机读:整份 MatrixReport
node scripts/coverage-matrix.ts --check    # 台账 vs 实测;不一致 exit 1,并**点名**哪一条
node scripts/coverage-matrix.ts --write    # 重写 §1/§2/§3 三块(保留人填的状态列)
```

`--check` 只校验两件事:**清单与实测一致**、**状态列写法合法**。
它**不判断**你填的理由对不对 —— 那要求推断意图(属本仓分水岭的另一侧)。

## 1 三档统计

三档判据的**定义**在 `scripts/coverage-matrix.ts` 文件头(含优先级与边界),这里只抄结果:

<!-- GEN:STATS:BEGIN -->
total = 2508
behavior = 1331
symbol-only = 15
none = 1162
none-prodref-positive = 289
none-prodref-zero = 873
src-files = 101
<!-- GEN:STATS:END -->

读法:

```text
behavior     = 该符号在 tests/*.test.ts 里**出现在代码位**,且满足下列之一:
               B1 同一行含断言调用(eq( / ok( / near( / inRange( / throws)
               B2 该出现落在某个 test(...) 用例体内,且该用例体内同行或其后含断言调用
               ⇒ 「被真调用且断言到」的**上界**(见 §6 边界 1)
symbol-only  = 只出现在**字符串或正则字面量**里,且该行是「取文本的实参」
               (.includes( / readCode( / .test( / .match( / .exec( / .search( / …)
               ⇒ 即:符号名只被**当文本比对**,没有被调用
none         = 其余(含:只在注释里;只在字符串里但那一行不是取文本的实参)
```

`none` 还要再分两类,因为**处置完全不同**:

```text
none-prodref-positive  仍被生产引用 ⇒ 属**真欠账**:有调用者、零直调判据
none-prodref-zero      连生产引用也没有 ⇒ 多是"本文件内部用"或"契约先行"
```

## 2 待处置清单(状态列由人填)

**入清单的条件(可复算)**:`tier = symbol-only` **或** (`tier = none` ∧ 生产引用 > 0)。

状态列只允许三种写法(`--check` 校验**写法**,不校验理由内容):

```text
待补              默认值 —— 还没人处置
已补(判据名)      已补上真判据;括号里必须写**哪条判据**(如 `已补(WS-07 H11)`)
无需(理由)        确实不需要直调判据;括号里必须写**为什么**(如 `无需(类型导出,运行时不可断言)`)
```

⚠️ 两条纪律:

1. **清单变短是唯一的"完成"形式**。填 `已补(...)` 不会让它消失 ——
   只有把真判据补进去、`tier` 变成 `behavior` 之后,`--write` 才会把它移出清单
   (`--check` 会先红一次,报「多登记 1 条(实测已不属待处置)」)⇒ 这就是"完成"的判据。
2. **不要把 `待补` 改成 `无需` 来消红**。`无需` 是"我知道它不需要",不是"我不想做";
   两者的区别**只有理由写不写得出来**能体现 —— 工具不会替你判断,评审会。

<!-- GEN:ROWS:BEGIN -->
| # | 文件:符号 | 类型 | 生产引用 | 状态 |
| --: | --- | --- | --: | --- |
| 1 | `server/src/combat/cooking.ts:extinguishStation` | value | 2 | 无需(判据即接线:WS-FND-118 FND118-9 断言 world_sim 真调它,对象是"谁调它") |
| 2 | `server/src/combat/damage.ts:DamageResult` | type | 15 | 无需(类型导出:无可断言的运行时行为,只作类型标注位) |
| 3 | `server/src/mobs/behaviors.ts:DamageResult` | type | 15 | 无需(类型导出:无可断言的运行时行为,只作类型标注位) |
| 4 | `server/src/mobs/behaviors.ts:TAMEABLE_AI_IDS` | value | 0 | 待补 |
| 5 | `server/src/mobs/behaviors.ts:WorldPlayer` | type | 10 | 待补 |
| 6 | `server/src/net/actions/breed_tame.ts:PetEntry` | type | 0 | 待补 |
| 7 | `server/src/net/actions/gather.ts:GATHER_RADIUS` | value | 0 | 待补 |
| 8 | `server/src/net/actions/not-implemented.ts:notImplemented` | value | 8 | 无需(WS-FND-38 断言该登记行的依据文本含 notImplemented( —— 判登记与源码一致) |
| 9 | `server/src/net/actions/open_chest.ts:forgetChests` | value | 4 | 待补 |
| 10 | `server/src/net/actions/place_automation.ts:forgetPlacements` | value | 4 | 待补 |
| 11 | `server/src/net/anticheat.ts:MoveIntent` | type | 6 | 待补 |
| 12 | `server/src/net/room.ts:RoomRuntimeOptions` | type | 5 | 待补 |
| 13 | `server/src/net/ws_server.ts:HelloFrame` | type | 2 | 待补 |
| 14 | `server/src/net/ws_server.ts:WsServerHandle` | type | 0 | 待补 |
| 15 | `server/src/party/actions.ts:gateCrownKnock` | value | 2 | 无需(WS-FND-120 断言生产源码里出现 gateCrownKnock( —— 判接线) |
| 16 | `server/src/alchemy/attributes.ts:NormalSpec` | type | 1 | 待补 |
| 17 | `server/src/alchemy/attributes.ts:PowerMeanBreakdown` | type | 1 | 待补 |
| 18 | `server/src/alchemy/attributes.ts:QualityBreakdown` | type | 1 | 待补 |
| 19 | `server/src/alchemy/attributes.ts:ReactionHit` | type | 1 | 待补 |
| 20 | `server/src/alchemy/attributes.ts:ReactionRule` | type | 1 | 待补 |
| 21 | `server/src/alchemy/attributes.ts:RollBreakdown` | type | 1 | 待补 |
| 22 | `server/src/alchemy/attributes.ts:RollOutcome` | type | 4 | 待补 |
| 23 | `server/src/alchemy/attributes.ts:RollRequest` | type | 1 | 待补 |
| 24 | `server/src/alchemy/attributes.ts:S_LOGIC_CEIL` | value | 11 | 待补 |
| 25 | `server/src/alchemy/attributes.ts:S_LOGIC_FLOOR` | value | 15 | 待补 |
| 26 | `server/src/alchemy/attributes.ts:SliceBreakdown` | type | 1 | 待补 |
| 27 | `server/src/alchemy/attributes.ts:WEIGHT_SUM_TOLERANCE` | value | 3 | 待补 |
| 28 | `server/src/alchemy/cache.ts:BuildRowInput` | type | 1 | 待补 |
| 29 | `server/src/alchemy/cache.ts:CacheEntry` | type | 1 | 待补 |
| 30 | `server/src/alchemy/cache.ts:CacheStats` | type | 3 | 待补 |
| 31 | `server/src/alchemy/cache.ts:DEFAULT_DISCOVERER` | value | 3 | 待补 |
| 32 | `server/src/alchemy/cache.ts:LlmClient` | type | 4 | 待补 |
| 33 | `server/src/alchemy/cache.ts:RecipeCache` | value | 3 | 待补 |
| 34 | `server/src/alchemy/cache.ts:RecipeCacheOptions` | type | 1 | 待补 |
| 35 | `server/src/alchemy/cache.ts:RecipeStore` | type | 3 | 待补 |
| 36 | `server/src/alchemy/cache.ts:SQL_BUMP_COUNT` | value | 1 | 待补 |
| 37 | `server/src/alchemy/cache.ts:SQL_GET_RECIPE` | value | 1 | 待补 |
| 38 | `server/src/alchemy/cache.ts:SQL_TOP_GALLERY` | value | 1 | 待补 |
| 39 | `server/src/alchemy/cache.ts:StubLlmOptions` | type | 1 | 待补 |
| 40 | `server/src/alchemy/cache.ts:emptyStats` | value | 1 | 待补 |
| 41 | `server/src/alchemy/degrade.ts:CARRIER_WORD` | value | 1 | 待补 |
| 42 | `server/src/alchemy/degrade.ts:ColorTriple` | type | 1 | 待补 |
| 43 | `server/src/alchemy/degrade.ts:DegradeRequest` | type | 1 | 待补 |
| 44 | `server/src/alchemy/degrade.ts:DegradeResult` | type | 1 | 待补 |
| 45 | `server/src/alchemy/degrade.ts:FALLBACK_RULE` | value | 1 | 待补 |
| 46 | `server/src/alchemy/degrade.ts:MECHANIC_WORD` | value | 1 | 待补 |
| 47 | `server/src/alchemy/degrade.ts:NEUTRAL_AFFINITY` | value | 2 | 待补 |
| 48 | `server/src/alchemy/degrade.ts:NameParts` | type | 1 | 待补 |
| 49 | `server/src/alchemy/degrade.ts:PromptMaterialLike` | type | 3 | 待补 |
| 50 | `server/src/alchemy/degrade.ts:SILHOUETTE_NOUN` | value | 1 | 待补 |
| 51 | `server/src/alchemy/degrade.ts:SILHOUETTE_RULES` | value | 1 | 待补 |
| 52 | `server/src/alchemy/degrade.ts:SILHOUETTE_WEIGHTS` | value | 1 | 待补 |
| 53 | `server/src/alchemy/degrade.ts:SilhouetteRule` | type | 1 | 待补 |
| 54 | `server/src/alchemy/degrade.ts:TAG_COLOR` | value | 1 | 待补 |
| 55 | `server/src/alchemy/degrade.ts:composeLore` | value | 1 | 待补 |
| 56 | `server/src/alchemy/degrade.ts:composeName` | value | 1 | 待补 |
| 57 | `server/src/alchemy/degrade.ts:pickAura` | value | 1 | 待补 |
| 58 | `server/src/alchemy/degrade.ts:pickColor` | value | 1 | 待补 |
| 59 | `server/src/alchemy/degrade.ts:pickElement` | value | 1 | 待补 |
| 60 | `server/src/alchemy/degrade.ts:selectSilhouetteRule` | value | 1 | 待补 |
| 61 | `server/src/alchemy/degrade.ts:tagsOf` | value | 1 | 待补 |
| 62 | `server/src/alchemy/gate.ts:AffinityBreakdown` | type | 1 | 待补 |
| 63 | `server/src/alchemy/gate.ts:DEW_RELEASE_QUALITY_PENALTY` | value | 1 | 待补 |
| 64 | `server/src/alchemy/gate.ts:DewRelease` | type | 1 | 待补 |
| 65 | `server/src/alchemy/gate.ts:GateCode` | type | 1 | 待补 |
| 66 | `server/src/alchemy/gate.ts:GateRequest` | type | 1 | 待补 |
| 67 | `server/src/alchemy/gate.ts:GateResult` | type | 7 | 待补 |
| 68 | `server/src/alchemy/gate.ts:REJECT_SUBJECT` | value | 1 | 待补 |
| 69 | `server/src/alchemy/gate.ts:S_LOGIC_BASE` | value | 2 | 待补 |
| 70 | `server/src/alchemy/gate.ts:S_LOGIC_CEIL` | value | 9 | 待补 |
| 71 | `server/src/alchemy/gate.ts:S_LOGIC_FLOOR` | value | 11 | 待补 |
| 72 | `server/src/alchemy/gate.ts:S_LOGIC_SPAN` | value | 2 | 待补 |
| 73 | `server/src/alchemy/gate.ts:clampNum` | value | 7 | 待补 |
| 74 | `server/src/alchemy/gate.ts:collectTags` | value | 3 | 待补 |
| 75 | `server/src/alchemy/gate.ts:isCarrierTag` | value | 2 | 待补 |
| 76 | `server/src/alchemy/gate.ts:isMechanicTag` | value | 2 | 待补 |
| 77 | `server/src/alchemy/index.ts:AlchemyService` | type | 3 | 待补 |
| 78 | `server/src/alchemy/index.ts:ForgeResult` | type | 2 | 待补 |
| 79 | `server/src/alchemy/index.ts:createAlchemyService` | value | 2 | 待补 |
| 80 | `server/src/alchemy/pixel_icon.ts:CanvasTexturePayload` | type | 1 | 待补 |
| 81 | `server/src/alchemy/pixel_icon.ts:IconBuildResult` | type | 3 | 待补 |
| 82 | `server/src/alchemy/pixel_icon.ts:PALETTE_CHAR` | value | 1 | 待补 |
| 83 | `server/src/alchemy/pixel_icon.ts:PALETTE_KEYS` | value | 3 | 待补 |
| 84 | `server/src/alchemy/pixel_icon.ts:PALETTE_MEANING` | value | 1 | 待补 |
| 85 | `server/src/alchemy/pixel_icon.ts:PixelMatrixCheck` | type | 3 | 待补 |
| 86 | `server/src/alchemy/pixel_icon.ts:PixelMatrixProblem` | type | 1 | 待补 |
| 87 | `server/src/alchemy/pixel_icon.ts:RasterResult` | type | 1 | 待补 |
| 88 | `server/src/alchemy/pixel_icon.ts:Rgba` | type | 4 | 待补 |
| 89 | `server/src/alchemy/pixel_icon.ts:TEXTURE_PIXEL_RATIO` | value | 1 | 待补 |
| 90 | `server/src/alchemy/pixel_icon.ts:describePixelProblems` | value | 3 | 待补 |
| 91 | `server/src/alchemy/pixel_icon.ts:normalizeHexColor` | value | 2 | 待补 |
| 92 | `server/src/alchemy/pixel_icon.ts:parseHexColor` | value | 4 | 待补 |
| 93 | `server/src/alchemy/prompt.ts:BuildUserPromptOptions` | type | 1 | 待补 |
| 94 | `server/src/alchemy/prompt.ts:FewShot` | type | 1 | 待补 |
| 95 | `server/src/alchemy/prompt.ts:MAX_LORE_LEN` | value | 1 | 待补 |
| 96 | `server/src/alchemy/prompt.ts:MIN_ITEM_NAME_LEN` | value | 1 | 待补 |
| 97 | `server/src/alchemy/prompt.ts:MIN_LORE_LEN` | value | 1 | 待补 |
| 98 | `server/src/alchemy/prompt.ts:MechanicCorrection` | type | 1 | 待补 |
| 99 | `server/src/alchemy/prompt.ts:PromptMaterial` | type | 6 | 待补 |
| 100 | `server/src/alchemy/prompt.ts:SCHEMA_INVARIANTS` | value | 1 | 待补 |
| 101 | `server/src/alchemy/prompt.ts:ValidationIssue` | type | 1 | 待补 |
| 102 | `server/src/alchemy/prompt.ts:ValidationResult` | type | 1 | 待补 |
| 103 | `server/src/alchemy/prompt.ts:buildFewShotMessages` | value | 1 | 待补 |
| 104 | `server/src/alchemy/prompt.ts:describeMaterials` | value | 1 | 待补 |
| 105 | `server/src/alchemy/prompt.ts:issueMessages` | value | 3 | 待补 |
| 106 | `server/src/bosses/breaks.ts:BreakResult` | type | 4 | 待补 |
| 107 | `server/src/bosses/phases.ts:BREAK_CRIT_BONUS` | value | 2 | 待补 |
| 108 | `server/src/bosses/phases.ts:BossClone` | type | 5 | 待补 |
| 109 | `server/src/bosses/raid.ts:LootOrb` | type | 2 | 待补 |
| 110 | `server/src/bosses/raid.ts:OfferingPort` | type | 5 | 待补 |
| 111 | `server/src/bosses/raid.ts:SummonWithOfferingRequest` | type | 4 | 待补 |
| 112 | `server/src/bosses/raid.ts:SummonWithOfferingResult` | type | 4 | 待补 |
| 113 | `server/src/bosses/runtime.ts:BossSnapshot` | type | 2 | 待补 |
| 114 | `server/src/bosses/runtime.ts:BossTickReport` | type | 2 | 待补 |
| 115 | `server/src/build/autotile.ts:isDoor` | value | 3 | 待补 |
| 116 | `server/src/build/autotile.ts:isRoof` | value | 2 | 待补 |
| 117 | `server/src/build/autotile.ts:isWall` | value | 1 | 待补 |
| 118 | `server/src/build/autotile.ts:isWindow` | value | 3 | 待补 |
| 119 | `server/src/build/blueprint.ts:BlueprintCell` | type | 3 | 待补 |
| 120 | `server/src/build/blueprint.ts:EncodeStats` | type | 5 | 待补 |
| 121 | `server/src/build/grid.ts:DIR_DX` | value | 10 | 待补 |
| 122 | `server/src/build/grid.ts:DIR_DY` | value | 10 | 待补 |
| 123 | `server/src/build/grid.ts:TileGridLike` | type | 21 | 待补 |
| 124 | `server/src/build/rooms.ts:RoomIdentity` | type | 4 | 待补 |
| 125 | `server/src/combat/cooking.ts:BIG_SHOVEL_ID` | value | 2 | 待补 |
| 126 | `server/src/combat/cooking.ts:EXTINGUISH_RADIUS` | value | 4 | 待补 |
| 127 | `server/src/combat/cooking.ts:KitchenState` | type | 3 | 待补 |
| 128 | `server/src/combat/cooking.ts:PIZZA_OVEN_ID` | value | 5 | 待补 |
| 129 | `server/src/combat/cooking.ts:createKitchenState` | value | 2 | 待补 |
| 130 | `server/src/combat/cooking.ts:feedStation` | value | 3 | 待补 |
| 131 | `server/src/combat/cooking.ts:tryCook` | value | 2 | 待补 |
| 132 | `server/src/combat/damage.ts:AttackInput` | type | 1 | 待补 |
| 133 | `server/src/combat/damage.ts:ComboState` | type | 3 | 待补 |
| 134 | `server/src/combat/damage.ts:DEFAULT_UNARMED_KNOCKBACK` | value | 2 | 待补 |
| 135 | `server/src/combat/damage.ts:DotTask` | type | 3 | 待补 |
| 136 | `server/src/combat/damage.ts:HIT_KNOCKBACK_DAMAGE_PER_CELL` | value | 2 | 待补 |
| 137 | `server/src/combat/damage.ts:HIT_KNOCKBACK_MASS_REF` | value | 2 | 待补 |
| 138 | `server/src/combat/damage.ts:knockbackDirection` | value | 2 | 待补 |
| 139 | `server/src/combat/damage.ts:skillZeroResult` | value | 3 | 待补 |
| 140 | `server/src/combat/live_bubble.ts:LiveBubbleState` | type | 3 | 待补 |
| 141 | `server/src/combat/live_bubble.ts:isTrapped` | value | 6 | 待补 |
| 142 | `server/src/combat/progression.ts:PlayerProgress` | type | 9 | 待补 |
| 143 | `server/src/combat/progression.ts:ShareResult` | type | 3 | 待补 |
| 144 | `server/src/combat/revive.ts:ReviveResult` | type | 2 | 待补 |
| 145 | `server/src/combat/vitals.ts:BLIND_VIEW_MUL` | value | 2 | 待补 |
| 146 | `server/src/combat/vitals.ts:ELEMENT_RESIST_NEUTRAL` | value | 2 | 待补 |
| 147 | `server/src/combat/vitals.ts:MobHitResult` | type | 3 | 待补 |
| 148 | `server/src/combat/vitals.ts:PendingStrike` | type | 4 | 待补 |
| 149 | `server/src/combat/vitals.ts:collectEventBlinds` | value | 2 | 待补 |
| 150 | `server/src/combat/vitals.ts:collectEventStrikes` | value | 2 | 待补 |
| 151 | `server/src/combat/vitals.ts:warnHitsPlayer` | value | 2 | 待补 |
| 152 | `server/src/combat/weapons.ts:CombatantStats` | type | 3 | 待补 |
| 153 | `server/src/combat/weapons.ts:SkillDef` | type | 11 | 待补 |
| 154 | `server/src/combat/weapons.ts:WeaponDef` | type | 4 | 待补 |
| 155 | `server/src/combat/weapons.ts:sanitizeComboMul` | value | 2 | 待补 |
| 156 | `server/src/combat/weapons.ts:sanitizeMul` | value | 5 | 待补 |
| 157 | `server/src/combat/wiring_ledger.ts:CombatWiringRow` | type | 2 | 待补 |
| 158 | `server/src/content/registry.ts:ContentFingerprints` | type | 2 | 待补 |
| 159 | `server/src/coop/rush_order.ts:Clock` | type | 24 | 待补 |
| 160 | `server/src/coop/rush_order.ts:Rng` | type | 9 | 待补 |
| 161 | `server/src/coop/rush_order.ts:RushOrderSession` | type | 6 | 待补 |
| 162 | `server/src/coop/rush_order.ts:RushOrderState` | type | 3 | 待补 |
| 163 | `server/src/coop/rush_order.ts:RushSessionSettlement` | type | 4 | 待补 |
| 164 | `server/src/db/repo.ts:KeyParts` | type | 11 | 待补 |
| 165 | `server/src/db/repo.ts:OrderBy` | type | 4 | 待补 |
| 166 | `server/src/db/repo.ts:PlayerLedgerSnapshot` | type | 6 | 待补 |
| 167 | `server/src/db/repo.ts:PlayerSnapshotRow` | type | 6 | 待补 |
| 168 | `server/src/db/repo.ts:RoomRuntimeRead` | type | 2 | 待补 |
| 169 | `server/src/db/repo.ts:RoomRuntimeSection` | type | 2 | 待补 |
| 170 | `server/src/db/repo.ts:RoomRuntimeSnapshot` | type | 2 | 待补 |
| 171 | `server/src/db/repo.ts:RoomSystemsBootCheck` | type | 2 | 待补 |
| 172 | `server/src/db/repo.ts:RoomSystemsRead` | type | 2 | 待补 |
| 173 | `server/src/db/repo.ts:RoomSystemsSnapshot` | type | 2 | 待补 |
| 174 | `server/src/db/repo.ts:Row` | type | 25 | 待补 |
| 175 | `server/src/db/repo.ts:StartingInventoryBootCheck` | type | 2 | 待补 |
| 176 | `server/src/db/repo.ts:StartingInventoryGrantRecord` | type | 2 | 待补 |
| 177 | `server/src/db/repo.ts:WorldArchiveBootCheck` | type | 2 | 待补 |
| 178 | `server/src/db/repo.ts:forgetRoomWorldSave` | value | 3 | 待补 |
| 179 | `server/src/db/repo.ts:listRoomChunkCoords` | value | 2 | 待补 |
| 180 | `server/src/db/repo.ts:loadRoomRuntimeState` | value | 2 | 待补 |
| 181 | `server/src/db/repo.ts:migrateRoomSystemsIfInstalled` | value | 4 | 待补 |
| 182 | `server/src/db/repo.ts:migrateStartingInventoryIfInstalled` | value | 2 | 待补 |
| 183 | `server/src/db/repo.ts:migrateWorldPersistence` | value | 2 | 待补 |
| 184 | `server/src/db/repo.ts:releaseStartingInventoryGrant` | value | 2 | 待补 |
| 185 | `server/src/db/repo.ts:savePlayerLedgers` | value | 2 | 待补 |
| 186 | `server/src/db/repo.ts:saveRoomRuntimeState` | value | 2 | 待补 |
| 187 | `server/src/db/repo.ts:saveWorldState` | value | 2 | 待补 |
| 188 | `server/src/db/repo.ts:worldPersistenceInstalled` | value | 2 | 待补 |
| 189 | `server/src/events/bus.ts:EventPayload` | type | 2 | 待补 |
| 190 | `server/src/mobs/behaviors.ts:BaseMobAi` | value | 2 | 待补 |
| 191 | `server/src/mobs/behaviors.ts:MobRuntime` | type | 13 | 待补 |
| 192 | `server/src/mobs/behaviors.ts:MobWorld` | type | 2 | 待补 |
| 193 | `server/src/mobs/drops.ts:MobDropResult` | type | 2 | 待补 |
| 194 | `server/src/mobs/fsm.ts:FsmConfig` | type | 1 | 待补 |
| 195 | `server/src/mobs/fsm.ts:PROBE_LEN` | value | 1 | 待补 |
| 196 | `server/src/mobs/geometry.ts:DEG` | value | 15 | 待补 |
| 197 | `server/src/mobs/geometry.ts:WarnGeom` | type | 59 | 无需(类型导出:无可断言的运行时行为;生产引用按名字计数,只作类型位) |
| 198 | `server/src/mobs/geometry.ts:WarnShape` | value | 7 | 待补 |
| 199 | `server/src/mobs/geometry.ts:angleDiffDeg` | value | 3 | 待补 |
| 200 | `server/src/mobs/geometry.ts:angleToDeg` | value | 6 | 待补 |
| 201 | `server/src/mobs/geometry.ts:unit` | value | 15 | 待补 |
| 202 | `server/src/mobs/host.ts:MobHostWorld` | type | 2 | 待补 |
| 203 | `server/src/mobs/host.ts:MobTickResult` | type | 2 | 待补 |
| 204 | `server/src/mobs/spawner.ts:MOB_INSTANCE_SEP` | value | 2 | 待补 |
| 205 | `server/src/mobs/spawner.ts:SpawnContext` | type | 2 | 待补 |
| 206 | `server/src/mobs/spawner.ts:mobDefOf` | value | 9 | 待补 |
| 207 | `server/src/mobs/spawner.ts:mobSpeciesId` | value | 8 | 待补 |
| 208 | `server/src/mobs/spawner.ts:spawnsPerCheck` | value | 2 | 待补 |
| 209 | `server/src/net/actions/item_source.ts:ownedItemIds` | value | 2 | 待补 |
| 210 | `server/src/net/actions/material.ts:pickupItem` | value | 2 | 待补 |
| 211 | `server/src/net/actions/modify_town.ts:modifyTown` | value | 2 | 待补 |
| 212 | `server/src/net/actions/open_chest.ts:ItemStack` | type | 1 | 待补 |
| 213 | `server/src/net/actions/open_chest.ts:ownChestContainers` | value | 2 | 待补 |
| 214 | `server/src/net/actions/open_chest.ts:runChestAction` | value | 2 | 待补 |
| 215 | `server/src/net/actions/plant_crop.ts:plantSeedAt` | value | 2 | 待补 |
| 216 | `server/src/net/actions/sleep.ts:forgetSleepWorldClock` | value | 2 | 待补 |
| 217 | `server/src/net/actions/sleep.ts:noteSleepWorldSeconds` | value | 2 | 待补 |
| 218 | `server/src/net/actions/types.ts:ActionHandler` | type | 47 | 无需(类型导出:函数类型别名无运行时可断言行为,47 处生产引用全是类型位;契约由注册表与各处理器判,见 WS-FND-154 FND154-1) |
| 219 | `server/src/net/actions/use_alchemy_furnace.ts:forgetFurnaceClaims` | value | 2 | 待补 |
| 220 | `server/src/net/actions/wire_edit.ts:wireEdit` | value | 2 | 待补 |
| 221 | `server/src/net/anticheat.ts:Clock` | type | 24 | 待补 |
| 222 | `server/src/net/anticheat.ts:InventoryCheckResult` | type | 2 | 待补 |
| 223 | `server/src/net/anticheat.ts:InventoryOp` | type | 6 | 待补 |
| 224 | `server/src/net/anticheat.ts:Verdict` | type | 3 | 待补 |
| 225 | `server/src/net/anticheat.ts:Violation` | type | 3 | 待补 |
| 226 | `server/src/net/anticheat.ts:mintItemSourceToken` | value | 2 | 待补 |
| 227 | `server/src/net/room.ts:EffectValue` | type | 2 | 待补 |
| 228 | `server/src/net/room.ts:ItemReadPort` | type | 5 | 待补 |
| 229 | `server/src/net/schema.ts:removeBoss` | value | 2 | 待补 |
| 230 | `server/src/net/schema.ts:removeWildlife` | value | 2 | 待补 |
| 231 | `server/src/net/schema.ts:upsertBoss` | value | 2 | 待补 |
| 232 | `server/src/net/ws_server.ts:startWsServer` | value | 3 | 待补 |
| 233 | `server/src/party/actions.ts:REFEREE_DESK_STOP_MODE` | value | 3 | 待补 |
| 234 | `server/src/party/modes.ts:BRIDGE_BOARD_ITEM_ID` | value | 3 | 待补 |
| 235 | `server/src/party/modes.ts:PartyContest` | type | 3 | 待补 |
| 236 | `server/src/party/modes.ts:PartyModeRuntime` | type | 2 | 待补 |
| 237 | `server/src/party/scoring.ts:Broadcast` | type | 2 | 待补 |
| 238 | `server/src/party/scoring.ts:Broadcaster` | type | 3 | 待补 |
| 239 | `server/src/party/scoring.ts:PaintGrid` | type | 3 | 待补 |
| 240 | `server/src/party/scoring.ts:RaceTimer` | type | 6 | 待补 |
| 241 | `server/src/party/scoring.ts:RewardLine` | type | 3 | 待补 |
| 242 | `server/src/party/scoring.ts:TeamKey` | type | 33 | 待补 |
| 243 | `server/src/party/scoring.ts:TeamScore` | type | 2 | 待补 |
| 244 | `server/src/party/scoring.ts:modeEndLine` | value | 6 | 待补 |
| 245 | `server/src/party/scoring.ts:modeStartLine` | value | 2 | 待补 |
| 246 | `server/src/party/scoring.ts:podiumBroadcast` | value | 2 | 待补 |
| 247 | `server/src/party/scoring.ts:rankByDescending` | value | 2 | 待补 |
| 248 | `server/src/physics/carry.ts:ChainNode` | type | 2 | 待补 |
| 249 | `server/src/physics/carry.ts:JUMP_VZ` | value | 2 | 待补 |
| 250 | `server/src/physics/carry.ts:ThrowResult` | type | 2 | 待补 |
| 251 | `server/src/physics/world.ts:KNOCKBACK_STUN_SEC` | value | 2 | 待补 |
| 252 | `server/src/physics/world.ts:StepReport` | type | 3 | 待补 |
| 253 | `server/src/physics/world.ts:applyTimedBodyState` | value | 3 | 待补 |
| 254 | `server/src/prank/actions.ts:CrownKnockOutcome` | type | 2 | 待补 |
| 255 | `server/src/prank/actions.ts:PrankActionOutcome` | type | 2 | 待补 |
| 256 | `server/src/prank/immunity.ts:EffectOrigin` | type | 2 | 待补 |
| 257 | `server/src/prank/immunity.ts:ShieldResolution` | type | 2 | 待补 |
| 258 | `server/src/prank/toys.ts:PrankToyDef` | type | 3 | 待补 |
| 259 | `server/src/prank/toys.ts:ToyStateFlag` | type | 5 | 待补 |
| 260 | `server/src/rooms/effects.ts:RoomEffectState` | type | 3 | 待补 |
| 261 | `server/src/sim/world_debts.ts:WorldDebtRow` | type | 2 | 待补 |
| 262 | `server/src/sim/world_sim.ts:WorldArchiveReceipt` | type | 3 | 待补 |
| 263 | `server/src/sim/world_sim.ts:WorldArchiveRequest` | type | 2 | 待补 |
| 264 | `server/src/sim/world_sim.ts:WorldArchiveSink` | type | 4 | 待补 |
| 265 | `server/src/social/afk.ts:AfkPlayer` | type | 2 | 待补 |
| 266 | `server/src/systems/alchemy_lab.ts:ALCHEMY_LAB_SYSTEM` | value | 2 | 待补 |
| 267 | `server/src/systems/alchemy_lab.ts:BrewInput` | type | 3 | 待补 |
| 268 | `server/src/systems/alchemy_lab.ts:BrewOutcome` | type | 3 | 待补 |
| 269 | `server/src/systems/alchemy_lab.ts:Gallery` | type | 2 | 待补 |
| 270 | `server/src/systems/alchemy_lab.ts:GalleryEntry` | type | 2 | 待补 |
| 271 | `server/src/systems/depot.ts:BuyResult` | type | 2 | 待补 |
| 272 | `server/src/systems/depot.ts:DEPOT_SYSTEM` | value | 2 | 待补 |
| 273 | `server/src/systems/depot.ts:PriceTable` | type | 3 | 待补 |
| 274 | `server/src/systems/greenhouse.ts:GREENHOUSE_SYSTEM` | value | 2 | 待补 |
| 275 | `server/src/systems/greenhouse.ts:Weather` | value | 6 | 待补 |
| 276 | `server/src/systems/idempotency.ts:mergeSettlementLedger` | value | 2 | 待补 |
| 277 | `server/src/systems/idempotency.ts:settlementEntries` | value | 2 | 待补 |
| 278 | `server/src/systems/intake.ts:roomSystemsPortOf` | value | 6 | 待补 |
| 279 | `server/src/systems/ranch.ts:RANCH_SYSTEM` | value | 2 | 待补 |
| 280 | `server/src/systems/ranch.ts:RanchAnimal` | type | 16 | 待补 |
| 281 | `server/src/systems/ranch.ts:RanchDayResult` | type | 7 | 待补 |
| 282 | `server/src/systems/ranch.ts:RanchOnceOutcome` | type | 2 | 待补 |
| 283 | `server/src/systems/wiring.ts:CropCellState` | type | 6 | 待补 |
| 284 | `server/src/systems/wiring.ts:GalleryDisplayRow` | type | 4 | 待补 |
| 285 | `server/src/systems/wiring.ts:GrowInput` | type | 2 | 待补 |
| 286 | `server/src/systems/wiring.ts:HarvestRow` | type | 7 | 待补 |
| 287 | `server/src/systems/wiring.ts:gatherMulOf` | value | 1 | 待补 |
| 288 | `server/src/systems/wiring.ts:producedItemIdOf` | value | 2 | 待补 |
| 289 | `server/src/wiring/components.ts:SPEC_BY_KIND` | value | 2 | 待补 |
| 290 | `server/src/wiring/graph.ts:ComponentContext` | type | 2 | 待补 |
| 291 | `server/src/wiring/graph.ts:ComponentNode` | type | 6 | 待补 |
| 292 | `server/src/wiring/graph.ts:registerComponentKind` | value | 41 | 待补 |
| 293 | `server/src/wiring/logistics.ts:ARM_BATCH` | value | 2 | 待补 |
| 294 | `server/src/wiring/logistics.ts:ArmState` | type | 2 | 待补 |
| 295 | `server/src/wiring/logistics.ts:ConveyorState` | type | 2 | 待补 |
| 296 | `server/src/wiring/logistics.ts:DIR_DX` | value | 6 | 待补 |
| 297 | `server/src/wiring/logistics.ts:DIR_DY` | value | 6 | 待补 |
| 298 | `server/src/wiring/logistics.ts:DrillState` | type | 2 | 待补 |
| 299 | `server/src/wiring/logistics.ts:ItemStack` | value | 15 | 待补 |
| 300 | `server/src/wiring/logistics.ts:LogisticsLine` | type | 6 | 待补 |
| 301 | `server/src/wiring/logistics.ts:LogisticsTickReport` | type | 2 | 待补 |
| 302 | `server/src/world/chunk.ts:CHUNK_W` | value | 4 | 待补 |
| 303 | `server/src/world/chunk.ts:toBytes` | value | 3 | 待补 |
| 304 | `server/src/world/fluid.ts:applyFluidAmounts` | value | 2 | 待补 |
<!-- GEN:ROWS:END -->

## 3 导出普查(逐符号)

格式:`文件 | 类型(v=值 / t=类型) | 档位 | 符号名…`(同行内按名字排序;行序按文件/类型/档位)。

```text
为什么需要这一块:
  §1 只能告诉你"数量对不对",§2 只覆盖"要处置的",而**新增一个 behavior 档导出**
  在 §1 里只是 total +1 —— 说不清是哪一个。
  ⇒ CENSUS 逐符号登记:任何新增/消失/换档都会让 `--check` 点出 `文件:符号(档位)`。
```

<!-- GEN:CENSUS:BEGIN -->
server/src/alchemy/attributes.ts | v | behavior | AFFIX_POOL AGG_EXPONENT ATK_MUL BUDGET_BASE BUDGET_EXPONENT DEF_MUL EPSILON_MAX EPSILON_MEAN EPSILON_MIN EPSILON_SIGMA HP_MUL IMPULSE_BASE IMPULSE_MUL K_BONUS_RATE PROF_MAX_LEVEL PROF_RATE_PER_LEVEL RARITY_THRESHOLDS REACTION_RULES S_LOGIC_MAX S_LOGIC_MIN UTIL_CAP_PERCENT UTIL_MUL affixCountOf applyWeightShift budgetOf clamp effectiveValue materialValues pickAffixes powerMeanBreakdown qualityBreakdown rarityTierOf rollReaction rollStats sampleTruncatedNormal seededRng selfCheckParams splitBudget weightsSum
server/src/alchemy/attributes.ts | v | none | BUDGET_MAX BUDGET_MIN EPSILON_MAX_ATTEMPTS EPSILON_SPEC NO_WEIGHT_SHIFT Q_MAX S_LOGIC_CEIL S_LOGIC_FLOOR WEIGHT_SUM_TOLERANCE
server/src/alchemy/attributes.ts | t | none | NormalSpec ParamSelfCheck PowerMeanBreakdown QualityBreakdown ReactionHit ReactionRule RollBreakdown RollOutcome RollRequest SliceBreakdown
server/src/alchemy/cache.ts | v | behavior | MemoryDewLedger MemoryRecipeStore SQLITE_DDL SQL_UPSERT_RECIPE StubLlmClient buildRecipeRow sanitizeDiscoverer selfCheckCacheModule
server/src/alchemy/cache.ts | v | none | DEFAULT_DISCOVERER RecipeCache SQL_BUMP_COUNT SQL_GET_RECIPE SQL_TOP_GALLERY emptyStats
server/src/alchemy/cache.ts | t | none | BuildRowInput CacheEntry CacheStats LlmClient MemoryStoreSeed RecipeCacheOptions RecipeStore StubLlmOptions
server/src/alchemy/degrade.ts | v | behavior | degradeGenerate selfCheckDegrade
server/src/alchemy/degrade.ts | v | none | CARRIER_WORD DEFAULT_COLOR FALLBACK_RULE LORE_TEMPLATE MECHANIC_AURA MECHANIC_WORD NAME_MAX_LEN NEUTRAL_AFFINITY SILHOUETTE_NOUN SILHOUETTE_RULES SILHOUETTE_WEIGHTS TAG_COLOR TAG_ELEMENT composeLore composeName pickAura pickColor pickElement selectSilhouetteRule tagsOf
server/src/alchemy/degrade.ts | t | none | ColorTriple DegradeRequest DegradeResult NameParts PromptMaterialLike SilhouetteRule
server/src/alchemy/gate.ts | v | behavior | affinityBreakdown carrierTagsOf checkGate gateSelfCheck mechanicTagsOf resonanceTagsOf
server/src/alchemy/gate.ts | v | none | AFFINITY_BASE AFFINITY_CARRIER_CAP AFFINITY_CARRIER_STEP AFFINITY_K_STEP AFFINITY_MAX AFFINITY_MECHANIC_CAP AFFINITY_MECHANIC_STEP AFFINITY_MIN AFFINITY_RESONANCE_CAP AFFINITY_RESONANCE_STEP DEW_RELEASE_COST DEW_RELEASE_QUALITY_PENALTY REJECT_SUBJECT S_LOGIC_BASE S_LOGIC_CEIL S_LOGIC_FLOOR S_LOGIC_SPAN clampNum collectTags isCarrierTag isMechanicTag round3
server/src/alchemy/gate.ts | t | none | AffinityBreakdown DewRelease GateCode GateRequest GateResult
server/src/alchemy/index.ts | v | behavior | fnv1a32 generateWithRetry saneWeights
server/src/alchemy/index.ts | v | none | createAlchemyService productTags promptMaterialsOf
server/src/alchemy/index.ts | t | none | AlchemyService AlchemyServiceOptions ForgeFailure ForgeRequest ForgeResult ForgeSuccess GenerateAttempt GenerateInput GenerateOutcome
server/src/alchemy/pixel_icon.ts | v | behavior | ICON_BYTES ICON_SIZE MIN_INK_PIXELS SILHOUETTE_ART buildCanvasTexturePayload buildIcon canonicalArt matrixFromRgba paletteFrom pixelAt rasterizePixelIcon selfCheckArt validatePixelMatrix
server/src/alchemy/pixel_icon.ts | v | none | DEFAULT_OUTLINE DEFAULT_PRIMARY DEFAULT_SECONDARY HIGHLIGHT_WHITE_LERP PALETTE_CHAR PALETTE_KEYS PALETTE_MEANING TEXTURE_PIXEL_RATIO describePixelProblems normalizeHexColor parseHexColor
server/src/alchemy/pixel_icon.ts | t | none | CanvasTexturePayload IconBuildResult PaletteChar PixelMatrixCheck PixelMatrixProblem RasterResult Rgba
server/src/alchemy/prompt.ts | v | behavior | ALCHEMY_JSON_SCHEMA CATEGORY_MECHANIC_ALLOWED FEW_SHOTS MAX_ITEM_NAME_LEN MAX_RETRY SYSTEM_PROMPT buildUserPrompt correctMechanic defaultMechanicFor extractJsonObject isMechanicAllowed selfCheckFewShots validateAlchemyOutput
server/src/alchemy/prompt.ts | v | none | MAX_LORE_LEN MIN_ITEM_NAME_LEN MIN_LORE_LEN SCHEMA_INVARIANTS buildFewShotMessages describeMaterials issueMessages
server/src/alchemy/prompt.ts | t | none | BuildUserPromptOptions FewShot MechanicCorrection PromptMaterial ValidationIssue ValidationResult
server/src/bosses/breaks.ts | v | behavior | BREAK_BOSS_IDS BREAK_ITEM CHRONOS_CIRCUIT_COUNT CIRCUIT_COLORS CRAB_SHELL_DR ICE_MU PULL_FORCE_THRESHOLD PULL_MIN_PLAYERS WHALE_CRYSTAL_COUNT beaverBreakReady breakCoverage brokenCrystalCount chronosBreakReady crabSlideBreak evaluateBreak fakeCloneCount foxBreakReady gingerBreakReady jellyBreakReady pullBreakReady settleBreak survivorsAfterFoxBreak whaleBreakReady
server/src/bosses/breaks.ts | v | none | CRAB_SHATTER_SPEED CRAB_UNCONTROLLED_DISTANCE OBSIDIAN_WALL_STUN_SEC PULL_COOP_WINDOW_SEC PULL_FORCE_PER_PLAYER PULL_MAX_PLAYERS WHALE_CRYSTAL_WINDOW_SEC
server/src/bosses/breaks.ts | t | none | BeaverBreakInput BreakResult ChronosBreakInput ChronosBreakResult CrabSlideInput CrabSlideResult FoxBreakInput GingerBreakInput JellyBreakInput PullInput PullResult WhaleBreakInput
server/src/bosses/phases.ts | v | behavior | BREAK_STUN_SEC TIME_SHIELD_HEAL_RATIO applyBreak createBossState damageBoss phaseIndexFor phaseName skillWarnGeoms tickBoss
server/src/bosses/phases.ts | v | none | BREAK_CRIT_BONUS CAST_INTERVAL_SEC FOX_CLONE_COUNT JELLY_SPLIT_COUNT TIME_SHIELD_SEC arenaCorners spawnFoxClones
server/src/bosses/phases.ts | t | behavior | BossState
server/src/bosses/phases.ts | t | none | BossClone BossTickInput
server/src/bosses/raid.ts | v | behavior | BOSS_BY_SUMMON_ITEM RAID_MAX_PLAYERS RAID_PARTICIPATION_RADIUS SUMMON_ITEM_BY_BOSS SUMMON_ITEM_MAX SUMMON_ITEM_MIN SummonReject allScalingCurves canLoot effectiveLoot fnv1a makeOfferingPort orbCountFor rollPersonalLoot scalingCurve seededRoll selfRecyclingBosses summonBoss summonBossWithOffering summonItemCoverage summonItemsInLoot
server/src/bosses/raid.ts | v | none | LOOT_SCATTER_RADIUS RAID_MIN_PLAYERS bossDef
server/src/bosses/raid.ts | t | behavior | RaidParticipant
server/src/bosses/raid.ts | t | none | LootEntry LootOrb OfferingPort ScalingCurve SummonRequest SummonResult SummonWithOfferingRequest SummonWithOfferingResult
server/src/bosses/runtime.ts | v | behavior | BossRaidRuntime makeMemoryOfferingPort
server/src/bosses/runtime.ts | t | none | BossSnapshot BossTickReport
server/src/build/autotile.ts | v | behavior | AutoTileKind BRIDGE_IDS DEFAULT_AUTOTILE_CONFIG DOOR_IDS EDGE_GUARD_IDS HIGH_LOW_IDS ONE_WAY_IDS STAIR_IDS WALL_IDS autoTileAll canTraverse classifyMask isAutoTileable isBarrier maskOf resolveAutoTile resolveRotation sampleMask
server/src/build/autotile.ts | v | none | BUILDING_TRAITS DEFAULT_SPRITE_TABLE MASK_E MASK_N MASK_S MASK_W ROOF_IDS WINDOW_IDS autoTileAt isDoor isRoof isWall isWindow sameIdPredicate
server/src/build/autotile.ts | t | none | AutoTileCell AutoTileConfig AutoTileResult BuildingTrait TraverseQuery TraverseVerdict
server/src/build/blueprint.ts | v | behavior | BLUEPRINT_CELLS BLUEPRINT_MAX_CELLS BLUEPRINT_MAX_SIZE BLUEPRINT_MIN_SIZE BLUEPRINT_SIZE DEFAULT_RELAY_OPTIONS MAX_RUN_CELLS RelayQueue RelayTaskState blueprintCellCount blueprintCode blueprintSolidCells buildRelayQueue captureBlueprint decodeBlueprint encodeBlueprint expandMaterials flightDurationMs floorItemId relayWorkload
server/src/build/blueprint.ts | v | none | BLUEPRINT_CELL_COUNT BLUEPRINT_MAGIC BRICK_FLIGHT_BASE_MS BRICK_FLIGHT_PER_CELL_MS DEFAULT_MANIFEST_OPTIONS FLOOR_ID_OFFSET WIRE_CELLS_PER_TOOL WIRE_TOOL_ID blueprintToGrid fromBase64 toBase64
server/src/build/blueprint.ts | t | behavior | Blueprint
server/src/build/blueprint.ts | t | none | BlueprintCell EncodeStats ManifestOptions MaterialLine MaterialManifest RelayBuilder RelayQueueOptions RelayTask RelayTickResult
server/src/build/grid.ts | v | behavior | TileGrid
server/src/build/grid.ts | v | none | DIR_DX DIR_DY Dir asTileGrid
server/src/build/grid.ts | t | none | TileGridLike
server/src/build/rooms.ts | v | behavior | ALL_REQUIRED_IDS DEFAULT_MAX_AREA DEFAULT_SCAN_OPTIONS NORMALIZED_RECIPES RoomRejectReason floodRoom identifyAllRooms identifyRoom isRecognizable placeInRoom scanRooms scoreRoom stampBoxRoom
server/src/build/rooms.ts | v | none | DEFAULT_MAX_ASPECT DEFAULT_MIN_AREA DEFAULT_MIN_FILL SCORE_OPTIONAL_CAP SCORE_OPTIONAL_EACH SCORE_REQUIRED_BASE SCORE_SEAL_BONUS SCORE_SWEET_SPOT SWEET_SPOT_MAX SWEET_SPOT_MIN hasAllRequired punchHole
server/src/build/rooms.ts | t | none | BoxRoomSpec RoomBBox RoomCell RoomIdentity RoomInfo RoomMatch RoomRecipeDef ScanOptions
server/src/build/wiring_view.ts | v | behavior | MAX_WIRE_RUN WIRE_LABEL buildWireView danglingEnds serializeWireView
server/src/build/wiring_view.ts | v | none | ALL_WIRE_COLORS LayWireResult WIRE_NAME canLayWire wireCellAt
server/src/build/wiring_view.ts | t | none | WireCellInfo WireLayer WireView
server/src/combat/cooking.ts | v | behavior | COMBAT_KEYWORD_POOL CookBranch FOODS FOOD_BY_ID KITCHEN_TABLE_ID PRANK_PRIORITY SHOVEL_BONUS_KEYWORDS SOUP_NORMAL_RECIPE SOUP_POT_ID cleansePrankBuffs cookSoup extinguishFire foodBuffFrom foodCombatInput mergeFoodBuffs potCount tickFoodBuff
server/src/combat/cooking.ts | v | symbol-only | extinguishStation
server/src/combat/cooking.ts | v | none | BIG_SHOVEL_ID EXTINGUISH_RADIUS FOOD_PARAM_DEFAULT_DOSE FOOD_PARAM_DEFAULT_SLOTS PIZZA_OVEN_ID createKitchenState dishStatMods feedStation tryCook
server/src/combat/cooking.ts | t | behavior | FoodBuff
server/src/combat/cooking.ts | t | none | CookInput CookResult FireCell FoodDef KitchenState
server/src/combat/damage.ts | v | behavior | ARMOR_K COMBO_CHAIN_MUL COMBO_WINDOW_SEC CRYSTAL_ARMOR_MUL DamageSource HIT_KNOCKBACK_MAX_CELLS MIN_DAMAGE MOB_DEF_BASE MOB_DEF_PER_LEVEL MOB_ELEMENT_BY_ID REFLECT_RADIUS allyPrankHit applyDamage computeDamage createTarget dueSkillTicks floatText healTarget hitKnockbackOf makeDot massNormalizedCells mobCombatProfile nextComboState planSkillHits pvpVerdict reflectFrom shieldPercent skillTiming targetFromStats tickDot
server/src/combat/damage.ts | v | none | CRYSTAL_BREAK_THRESHOLD DEFAULT_UNARMED_KNOCKBACK FloatColor HIT_KNOCKBACK_DAMAGE_PER_CELL HIT_KNOCKBACK_MASS_REF MAX_REACH_TOLERANCE MOB_MASS_DEFAULT PVP_REJECT TELEGRAPH_MIN_SEC healFloat knockbackDirection reflectFloat skillZeroResult
server/src/combat/damage.ts | t | symbol-only | DamageResult
server/src/combat/damage.ts | t | none | AppliedDamage AttackInput ComboState DamageStep DotTask FloatSpec HitKnockbackPlan HitKnockbackRequest SkillHitPlan SkillTiming TargetProfile
server/src/combat/live_bubble.ts | v | behavior | LIVE_BUBBLE_INITIAL liveBubbleHit tickLiveBubble
server/src/combat/live_bubble.ts | v | none | LIVE_BUBBLE_SHOTS_TO_TRAP LIVE_BUBBLE_STACK_WINDOW_SEC isTrapped
server/src/combat/live_bubble.ts | t | none | LiveBubbleState
server/src/combat/progression.ts | v | behavior | KILL_LEDGER_CAPACITY KillLedger PER_MOB_EXP_CAP_MULT PROGRESS_FIELD_WIRING REBIRTH_AFFIX_POOL REBIRTH_DEW_COST SHARE_RADIUS TALENTS TALENT_BY_ID TALENT_EFFECT_WIRING TALENT_UNLOCK_LEVELS activeTalents applyShareResult auditTalentWiring carryCapacityOf carryCapacityOfLevel createProgress cumulativeExp expToReachMax gainExp isTalentUnlocked levelGapMul reforge setLevel settleMobExp talentsUnlockedAt
server/src/combat/progression.ts | v | none | LEVEL_GAP_MIN LEVEL_GAP_STEP TALENT_WIRING_STATUS
server/src/combat/progression.ts | t | none | ExpGainResult LevelUpEvent PlayerProgress ProgressFieldRow RebirthResult ShareContext ShareEntry ShareParticipant ShareResult TalentDef TalentEffectRow TalentWiringStatus
server/src/combat/revive.ts | v | behavior | BUBBLE_GUN_SHOTS BUBBLE_STACK_WINDOW_SEC BUBBLE_TRAP_SEC FLAG_REVIVE_RADIUS FLAG_REVIVE_TIME ReviveMethod TOUCH_RADIUS bubbleGunHit createDowned featherRevive flagRevive ghostControl ghostDamageMul isInvulnerable snapshotDiff tickGhostBubble tickInvuln touchRevive
server/src/combat/revive.ts | v | none | GHOST_BUBBLE_MIN_SEC GHOST_DRIFT_SPEED GHOST_MOVE_MUL MANUAL_REVIVE_INVULN
server/src/combat/revive.ts | t | behavior | DownedState EquipmentSnapshot
server/src/combat/revive.ts | t | none | GhostBubbleTick RangedReviveInput ReviveResult TouchReviveInput TouchReviveOutcome
server/src/combat/vitals.ts | v | behavior | CONTENT_MAX_MOB_LEVEL MOB_HIT_MAX_DAMAGE PLAYER_BASE_HP PLAYER_IFRAME_SEC PLAYER_REGEN_DELAY_SEC VitalsSystem mobHitDamage resolveStrikes
server/src/combat/vitals.ts | v | none | BLIND_VIEW_MUL ELEMENT_RESIST_NEUTRAL EVENT_BLIND_RULES EVENT_STRIKE_RULES MAX_ELEMENT_RESIST_MUL MOB_HIT_BASE MOB_HIT_PER_LEVEL MOB_HIT_RADIUS_SLACK PLAYER_REGEN_PER_SEC collectEventBlinds collectEventStrikes eventStrikeRule explainMiss warnHitsPlayer
server/src/combat/vitals.ts | t | none | MobHitResult PendingStrike PlayerVitals VitalsFrameStats
server/src/combat/weapons.ts | v | behavior | ARMORS ARMOR_BY_ID BASE_CRIT_DMG BREACH_PICK COMBAT_CONSUMABLES COMBAT_ITEM_INDEX COMBAT_ITEM_RANGE DEAD_ELEMENTS ELEMENTS ELEMENT_COUNTER ELEMENT_COUNTER_MUL ELEMENT_MATRIX_VALUES ELEMENT_REVERSE_MUL Element MAX_COMBO_MUL MAX_CRIT_DMG MAX_DODGE_RATE PRANK_HAMMER_KNOCKBACK SET_BONUSES SkillShape WEAPONS WEAPON_BY_ID activeSets applyForgeTierBonus combatantStats elementMul equipSummary forgeTierBonusOf levelDamageMul skillOf weaponById
server/src/combat/weapons.ts | v | none | ARMOR_SLOTS ArmorSlot BASE_CRIT_RATE CONSUMABLE_BY_ID CombatItemKind ConsumableKind DamageType ELEMENT_LABEL ELEMENT_NEUTRAL_MUL ELEMENT_SELF_MUL FORGE_TIER_STAT_BONUS KAIROS_CRIT_BONUS MAX_CRIT_RATE TAUNT_RADIUS WEAPON_ITEM_BASE_ATK WeaponKind emptySummary forgeTierIndexOf sanitizeComboMul sanitizeMul
server/src/combat/weapons.ts | t | none | ArmorDef BuffInput CombatConsumableDef CombatItemEntry CombatantStats DeadElementEntry EquipSummary SetBonusDef SkillDef WeaponDef
server/src/combat/wiring_ledger.ts | v | behavior | COMBAT_WIRING_LEDGER WIRING_STATUS auditCombatWiring stripCommentsForAudit
server/src/combat/wiring_ledger.ts | v | none | evidenceOf
server/src/combat/wiring_ledger.ts | t | behavior | WiringStatus
server/src/combat/wiring_ledger.ts | t | none | CombatWiringRow
server/src/content/baseline.ts | v | behavior | auditExtensions buildBaseline defaultBaselinePath diffBaseline extensionFingerprint readBaseline writeBaseline
server/src/content/baseline.ts | t | behavior | ContentExtension
server/src/content/baseline.ts | t | none | BaselineDrift ContentBaseline
server/src/content/handshake.ts | v | behavior | ContentPolicy DEFAULT_CONTENT_POLICY checkSaveContent decodeContentClaim encodeContentClaim localContentClaim verifyContentCompatibility
server/src/content/handshake.ts | v | none | contentCompatReport fingerprintBreakdown
server/src/content/handshake.ts | t | none | ClientContentClaim ContentCompatResult SaveContentCheck
server/src/content/registry.ts | v | behavior | CONTENT_FINGERPRINT_VERSION FIELD_BITS FIELD_MAX FINGERPRINT_EXCLUDED auditContent canonicalize capacityReport contentCapacity contentFingerprintLine contentFingerprints fnv1a32 freeIdCount freeIdSegments idSegments
server/src/content/registry.ts | t | none | CapacityEntry ContentAudit ContentFingerprints IdSegment
server/src/coop/rush_actions.ts | v | behavior | RUSH_ACTION_LEDGER RUSH_DELIVERY_RADIUS RUSH_ENTRY_ROOM_LEVEL openOrderLines rushAcceptsDelivery rushRewardCellOf
server/src/coop/rush_actions.ts | t | none | OpenOrderLine RushActionRow
server/src/coop/rush_order.ts | v | behavior | BEAVER_STATE BEAVER_STEAL_SEC BEAVER_TARGET_ITEM_ID BOSS_BACK_HEIGHT CHAIN_STATE DEFAULT_STATION_CELLS EVT_BEAVER_STOLE EVT_DOUSED EVT_FIRE EVT_SMOKE EXTINGUISH_SEC HAMMER_222_IMPULSE ORDER_POOL ORDER_SLOT_MAX ORDER_SLOT_MIN OVERHEAT_SEC RELAY_RIVER_WIDTH RELAY_STAGES RELAY_STAGE_TIMEOUT_SEC RELAY_THROW_RANGE ROOM_LEVEL_PER_SLOT RUSH_ORDER_DURATION_SEC RUSH_ORDER_STATE RUSH_STOCK_WIRING STACK_REACH_Z STATION_KIND STATION_SPRAY_RADIUS STATION_STATE Z2_FRUIT_HEIGHT Z2_REACH_TARGET addRelayChain advanceRelayChain assertOrderPoolClosed auditRushStockWiring boardProgress canMountBossBack canPickZ2Fruit cellCenterOf createManualClock createRelayChain createRushOrderSession createStation deliverItem elapsedSec fireRelayStage generateOrderBoard gradeOf hitBeaver isSmoking reclaimWood settleSession spawnBeaver sprayableKinds stackCarrierSpeed stackTopZ startRushOrder startStation stationStateOf stationsBeingSprayedBy stationsBeingTendedBy submitDelivery tendStation tickBeaver tickRushOrder tickStation
server/src/coop/rush_order.ts | v | none | BEAVER_ESCAPE_SEC BEAVER_MAX_ACTIVE BEAVER_MOB_ID BEAVER_RECLAIM_QTY BEAVER_SPAWN_INTERVAL_SEC BEAVER_STUN_IMPULSE BEAVER_STUN_SEC BURN_DAMAGE_PER_SEC CHAIN_BREAK_PENALTY CHAIN_BREAK_REASON CHAIN_SUCCESS_SCORE EPS EVT_BEAVER_ESCAPED EVT_BEAVER_KNOCKED EVT_WOOD_RECLAIMED ORDER_LEVEL_VALUE_STEP ORDER_NEED_MAX ORDER_NEED_MIN RUSH_GRADE RUSH_GRADE_THRESHOLDS RUSH_STOCK_SUPPLY SMOKE_LEAD_SEC STACK_FORMATIONS STOCK_PRESSURE_UNIT canReachHeight pollChainTimeout settleRushOrder stationCellOf
server/src/coop/rush_order.ts | t | behavior | StationKind
server/src/coop/rush_order.ts | t | none | BeaverRuntime BeaverState ChainBreakReason ChainState Clock DeliverResult HammerHitResult ManualClock RelayChain RelayStage RelayStageInput RelayStageResult Rng RushGrade RushOrderBoard RushOrderSession RushOrderSessionOptions RushOrderSlot RushOrderState RushSessionSettlement RushSettlement RushStockRow RushStockSupply RushTickOptions StationCellBook StationRuntime StationState WorldCell
server/src/db/driver.sqlite.ts | v | behavior | RECOMMENDED_PRAGMAS VACUUM_FREELIST_PCT_THRESHOLD maybeVacuum nodeSqliteConnection openNodeSqlite
server/src/db/driver.sqlite.ts | v | none | SqliteDb WAL_AUTOCHECKPOINT_PAGES betterSqlite3Connection
server/src/db/driver.sqlite.ts | t | none | SqlConnection VacuumReport
server/src/db/memory_db.ts | v | behavior | FOREIGN_KEYS MemoryDb checkExprUnsupported checkPasses parseCheckExpr splitStatements
server/src/db/memory_db.ts | v | none | blankComments splitTopLevel
server/src/db/memory_db.ts | t | none | CheckExpr
server/src/db/repo.ts | v | behavior | AccessMode BLOB_MAX_BYTES CHUNK_ROOFS_TABLE EquipSlot MAX_LEVEL MIGRATION_BASELINE_VERSION PLAYER_EQUIPMENT_TABLE PartyMode RECONNECT_SNAPSHOT_MAX_BYTES ROOM_EVENT_LIST_FETCH_MAX ROOM_EVENT_LIST_MAX ROOM_EVENT_LIST_OVERFETCH ROOM_EVENT_RETAIN_LOW_WATER ROOM_EVENT_RETAIN_MAX ROOM_RUNTIME_MIGRATION_VERSION ROOM_RUNTIME_TABLE ROOM_SYSTEMS_MIGRATION_VERSION ROOM_SYSTEMS_TABLE RoomRole RoomStatus STARTING_INVENTORY_MIGRATION_VERSION STARTING_INVENTORY_TABLE STARTING_INVENTORY_VERSION TABLE_PRIMARY_KEYS WORLD_ARCHIVE_MIGRATION_VERSION WORLD_ARCHIVE_TABLE addItemInstance archiveWorldSnapshot badQuantityRowCount checksumOf chunksUpdatedSince claimStartingInventoryGrant clampInt consumeItem countRoomChunks countStartingInventoryGrants countWorldArchives createRoom createUser eventIdRetryCount getRecipe getRoom getUser incrementCraftCount listEvents listItems listRooms listTopRecipes listWorldArchives loadChunk loadChunkCells loadChunkRoofs loadPlayerLedger loadPlayerSnapshots loadReconnectSnapshot loadRoomMobMem loadRoomSystemsState loadVitalsFromUsers loadWorldArchive loadWorldState migrate migrateStartingInventory migrateWorldArchives migrateWorldArchivesIfInstalled packChunkBlob readMigrationRows readSchemaSql readStartingInventoryGrant readStartingInventorySql readWorldArchiveSql resetBadQuantityRowCount resetEventIdRetryCount saveChunk saveChunkBatch saveChunkRoofs savePlayerSnapshots savePlayerState saveReconnectSnapshot saveRoomMobMem saveRoomSystemsState saveVitalsToUsers schemaSqlPath setPartyMode setRoomStatus startingInventoryMigrationInstalled totalItemsOf trimEvents unpackChunkBlob upsertRecipe upsertRoomPlayer worldArchiveSqlPath writeEvent
server/src/db/repo.ts | v | none | MIGRATION_BASELINE_NAME PLAYER_EQUIPMENT_MAX PLAYER_EQUIPMENT_MAX_BYTES PLAYER_LEDGER_ITEM_MAX PLAYER_LEDGER_TOTAL_KEY PLAYER_LEDGER_VERSION PLAYER_LEDGER_VERSION_KEY PLAYER_SNAPSHOT_MAX_TALENTS ROOFS_BLOB_MAX_BYTES ROOM_RUNTIME_DATA_KEY ROOM_RUNTIME_MAX_BYTES ROOM_RUNTIME_MIGRATION_NAME ROOM_RUNTIME_SCHEMA_FILE_NAME ROOM_RUNTIME_SECTIONS ROOM_RUNTIME_STATE_VERSION ROOM_RUNTIME_VERSION_KEY ROOM_SYSTEMS_MAX_KEYS ROOM_SYSTEMS_MIGRATION_NAME ROOM_SYSTEMS_SCHEMA_FILE_NAME ROOM_SYSTEMS_STATE_VERSION ROOM_SYSTEMS_VERSION_KEY SCHEMA_FILE_NAME STARTING_INVENTORY_MIGRATION_NAME STARTING_INVENTORY_SCHEMA_FILE_NAME WORLD_ARCHIVE_KEEP_PER_ROOM WORLD_ARCHIVE_MAX_BYTES WORLD_ARCHIVE_MIGRATION_NAME WORLD_ARCHIVE_SCHEMA_FILE_NAME WORLD_PERSISTENCE_MIGRATION_NAME WORLD_PERSISTENCE_MIGRATION_VERSION WORLD_PERSISTENCE_SCHEMA_FILE_NAME WORLD_STATE_TABLE assertChunkBlob assertMigrationVersionSupported assertRoofsBlob clampIntQuiet countRoomChunkRoofs forgetRoomWorldSave knownMigrationVersions listRoomChunkCoords listRoomPlayers loadPlayerEquipmentState loadRoomRuntimeState migrateRoomRuntime migrateRoomRuntimeIfInstalled migrateRoomSystems migrateRoomSystemsIfInstalled migrateStartingInventoryIfInstalled migrateWorldPersistence pruneWorldArchives readRoomRuntimeSql readRoomSystemsSql readWorldPersistenceSql releaseStartingInventoryGrant removeRoomPlayer roomRuntimeInstalled roomRuntimeSqlPath roomSystemsMigrationInstalled roomSystemsSqlPath savePlayerEquipmentState savePlayerLedgers saveRoomRuntimeState saveWorldState startingInventorySqlPath touchRoom worldArchiveMigrationInstalled worldPersistenceInstalled worldPersistenceSqlPath
server/src/db/repo.ts | t | behavior | DbLike ItemInstanceRecord RecipeRecord
server/src/db/repo.ts | t | none | ChunkRecord EventWriteReport KeyParts MigrateResult MigrationRow OrderBy PlayerEquipmentRead PlayerLedgerRead PlayerLedgerSnapshot PlayerLedgerWriteReport PlayerRecord PlayerSnapshotRow RoomRecord RoomRuntimeBootCheck RoomRuntimeLoaded RoomRuntimeMigrateResult RoomRuntimeRead RoomRuntimeSection RoomRuntimeSnapshot RoomSystemsBootCheck RoomSystemsKeyEntry RoomSystemsMigrateResult RoomSystemsRead RoomSystemsSnapshot Row StartingInventoryBootCheck StartingInventoryGrantRecord StartingInventoryMigrateResult VitalsSaveReport WorldArchiveBootCheck WorldArchiveMigrateResult WorldArchiveRecord WorldArchiveSummary WorldArchiveWriteResult WorldPersistenceMigrateResult WorldStateRecord
server/src/events/bus.ts | v | behavior | EventBus HISTORY_CAPACITY MAX_EVENTS_PER_FRAME MAX_HANDLERS_PER_EVENT MAX_REENTRY_DEPTH
server/src/events/bus.ts | t | none | BusFrameStats DeliveryRecord EventHandler EventPayload GameEvent
server/src/index.ts | v | behavior | DEFAULT_DB_PATH assemble createHost createServer resolveAssembly
server/src/index.ts | t | none | AssembleDeps Assembled AssembledServer
server/src/invariants.ts | v | behavior | INVARIANT_CODES checkAll summarize violations
server/src/invariants.ts | v | none | registryProblems
server/src/invariants.ts | t | behavior | InvariantCheck InvariantCode
server/src/invariants.ts | t | none | InvBody InvContainer InvLedger InvLedgerEntry InvSideTable InvSnapshot InvVec3 InvariantOptions InvariantResult InvariantSummary
server/src/mobs/aoi.ts | v | behavior | AOI_WAKE_DISTANCE AoiManager chunkKeyOf estimateAoiScanCost isInsideAoi
server/src/mobs/aoi.ts | v | none | AOI_EPS AOI_WAKE_DISTANCE_SQ DORMANT_TICK_HZ
server/src/mobs/aoi.ts | t | behavior | AoiPlayer
server/src/mobs/aoi.ts | t | none | AoiMobRecord AoiStats
server/src/mobs/behaviors.ts | v | behavior | BEETLE_FRONT_DR BOAR_CHARGE_TILES BOAR_SELF_STUN_SEC BOAR_WINDUP_SEC CHOCOBO_TAME_WHEAT CHOCO_MELT_FLOOR DamageKind GINGER_ESCAPE_SEC HARPY_ENSEMBLE_SEC ITEM SAMURAI_FRONT_ARC_DEG SCORPION_BURROW_SEC TANUKI_REVEAL_DISTANCE createMobAi isHostile
server/src/mobs/behaviors.ts | v | symbol-only | TAMEABLE_AI_IDS
server/src/mobs/behaviors.ts | v | none | BAT_FALL_SEC BAT_RING_RADIUS BAT_RING_WIDTH BEAVER_DAM_MAX BEAVER_STEAL_TILES BEETLE_FLIP_SEC BEETLE_FRONT_ARC_DEG BOAR_CHARGE_SPEED BaseMobAi BatAi BeaverAi BeetleAi BoarAi CAPYBARA_HEAL_AURA_RADIUS CAPYBARA_HEAL_MUL CAPYBARA_REFLECT_HEARTS CHOCOBO_HONEY_SLOW CHOCOBO_MOUNT_SPEED_MUL CHOCO_ARMOR CapybaraAi ChocoGolemAi ChocoboAi ClockKnightAi CrabRiverAi DefaultMobAi FIRE_PEPPER_ARROW FROG_LIGHT_RADIUS FROG_TONGUE_RANGE GINGER_CANDY GingerImpAi GlowFrogAi HARPY_CLIFF_MARGIN HARPY_GUST_FORCE HarpyAi INSTRUMENT_IDS INSTRUMENT_MAX INSTRUMENT_MIN KNIGHT_FRONT_DR KNIGHT_KEY_ARC_DEG KNIGHT_PARALYZE_SEC LAVA_BURN_RADIUS LAVA_SHIELD_HP LavaElemAi MANTA_BACK_RADIUS MANTA_GLIDE_SPEED MIMIC_BITE_RANGE MIMIC_EXPOSE_SEC MOB_AI_FACTORY MimicCogAi NOCTURNAL_MOBS PANGOLIN_ROLL_SPEED PANGOLIN_STUN_SEC PUDDING_CARAMEL_RADIUS PUDDING_CARAMEL_SEC PUDDING_HEAL_AMOUNT PUDDING_HEAL_RADIUS PangolinAi PuddingMageAi SAMURAI_BURN_SEC SCORPION_POISON_RADIUS SamuraiAi ScorpionAi SheepAi SkyMantaAi SlimeAi SquirrelAi TANUKI_MIST_FRUIT THUNDER_HELM_ATK_SPEED_STACK THUNDER_HELM_STACK_MAX THUNDER_LINK_RADIUS THUNDER_LINK_TARGETS TanukiAi ThunderSpriteAi isInstrument noDamage
server/src/mobs/behaviors.ts | t | behavior | GroundItem
server/src/mobs/behaviors.ts | t | symbol-only | DamageResult WorldPlayer
server/src/mobs/behaviors.ts | t | none | MobAiFactory MobMem MobRuntime MobWorld
server/src/mobs/drops.ts | v | behavior | MANDATORY_DROP_CHANCE mobDropChanceOf mobDropCountOf mobDropTableOf rollMobDrops
server/src/mobs/drops.ts | v | none | mobDropRoll rolledDropIds
server/src/mobs/drops.ts | t | none | MobDropEntry MobDropResult
server/src/mobs/fsm.ts | v | behavior | GRAZE_RADIUS MobFsm TELEGRAPH_SEC_MAX TELEGRAPH_SEC_MIN estimateFsmCostUs resolveTelegraphHit steer45
server/src/mobs/fsm.ts | v | none | ATTACK_COOLDOWN_SEC AVOID_ANGLE_DEG CHASE_SPEED_MUL DISENGAGE_DISTANCE GRAZE_SEC_MAX GRAZE_SEC_MIN GRAZE_SPEED_MUL PROBE_LEN PROBE_READS_PER_STEP forceAlert headingDeg
server/src/mobs/fsm.ts | t | none | FsmConfig SteerResult TelegraphState
server/src/mobs/geometry.ts | v | behavior | WARN_SHAPES circleWarn insideWarn insideWarn3D insideWarnZ pointerAngleDeg pointerWarn rectWarn ringWarn sectorWarn
server/src/mobs/geometry.ts | v | none | DEG GEOM_EPS WarnShape angleDiffDeg angleToDeg makeWarn rayWarn rejectByBounds unit warnBoundsRadius wrapDeg
server/src/mobs/geometry.ts | t | none | WarnGeom
server/src/mobs/host.ts | v | behavior | BOSS_AI_DT_SEC BOSS_AI_RATE_HZ FAST_FRAME_HZ MOB_AI_DT_SEC MOB_AI_RATE_HZ MOB_CORPSE_FRAMES MOB_CORPSE_SEC MobHost frameSecondsAtRate frameStrideAtRate tickDueAtRate ticksInWindow
server/src/mobs/host.ts | t | none | MobHostFrameStats MobHostOptions MobHostWorld MobTickResult
server/src/mobs/spawner.ts | v | behavior | BIOME_SPAWN GLOBAL_MOB_CAP MobSpawner NIGHT_BRICK_ID NOCTURNAL STREET_LAMP_ID STREET_LAMP_RADIUS SpawnReject TOWN_SAFE_RADIUS applySafeZoneShield biomeCoverage decideSpawn inSafeZone isInsideSafeRadius isNocturnal lightSuppressed mobInstanceId nightGateAllows safeZoneShield setTownRadiusProvider spawnableMobs townSafeRadiusFor
server/src/mobs/spawner.ts | v | none | MOB_INSTANCE_SEP NIGHT_BRICK_RADIUS SAFE_SHIELD_MULT SPAWNER_MOB_TOTAL mobDefOf mobSpeciesId spawnsPerCheck
server/src/mobs/spawner.ts | t | behavior | SpawnWorld
server/src/mobs/spawner.ts | t | none | BiomeSpawnConfig SpawnContext SpawnerState TownRadiusProvider
server/src/mobs/taming.ts | v | behavior | DEPLOY_BADGE_ID RANCH_CAPACITY TameCommand TameStage canTame carrySlots carrySpeedMul commandPet createPetRecord deployLimit deployPet feedPet forgetRoomPets petSlotOf petSlotsOfRoom petsOfPlayer putPetSlot sendToRanch tameableDefs tamingCoverage tickRanch undeployPet
server/src/mobs/taming.ts | v | none | CARRY_BASE_SLOTS CARRY_MAX_SLOTS CARRY_SPEED_PENALTY DEFAULT_TAME_FEED_COUNT DEPLOY_LIMIT_BASE DEPLOY_LIMIT_WITH_BADGE RANCH_PRODUCE_SEC TAME_COMMANDS TAME_FEED_COUNT commandIntent
server/src/mobs/taming.ts | t | behavior | PetRecord PetSlot
server/src/mobs/taming.ts | t | none | DeployResult RanchYield TameResult
server/src/net/actions/action_table.ts | v | behavior | ACTION_HANDLERS lookupActionHandler
server/src/net/actions/admin.ts | v | behavior | closeRoom kick setMemberRole setPartyMode setRoomAccess
server/src/net/actions/attack.ts | v | behavior | attack
server/src/net/actions/breed_tame.ts | v | behavior | AFFECTION_REQUIRED TameOp breedRecordsOfRoom breedTame forgetRoom petsOfRoom tameOwnerOf tamedPetsOfRoom
server/src/net/actions/breed_tame.ts | v | none | MAX_BREED_RECORDS
server/src/net/actions/breed_tame.ts | t | symbol-only | PetEntry
server/src/net/actions/breed_tame.ts | t | none | BreedRecord TameOwnerRecord
server/src/net/actions/buy_item.ts | v | behavior | buyItem
server/src/net/actions/craft.ts | v | behavior | craft
server/src/net/actions/gather.ts | v | behavior | GATHERABLE_CATEGORY TOOL_TAGS gather gatherableOf toolTagFor
server/src/net/actions/gather.ts | v | symbol-only | GATHER_RADIUS
server/src/net/actions/item_source.ts | v | behavior | authoritativeStock bindItemSource missingItemReadPort ownedItemCount unbindItemSource
server/src/net/actions/item_source.ts | v | none | ownedItemIds
server/src/net/actions/material.ts | v | behavior | breakBlock dropItem gatherCountFor gatherDoubleChance gatherRollFor placeBlock
server/src/net/actions/material.ts | v | none | pickupItem
server/src/net/actions/modify_town.ts | v | behavior | MAX_TOWN_NAME_LEN MAX_TOWN_RADIUS MIN_TOWN_RADIUS clearTownRegistry setTownClock townConfigOf townSafeRadiusProvider
server/src/net/actions/modify_town.ts | v | none | DEFAULT_TOWN_NAME modifyTown resetTownClock
server/src/net/actions/modify_town.ts | t | none | TownCell TownConfig
server/src/net/actions/move.ts | v | behavior | move
server/src/net/actions/not-implemented.ts | v | symbol-only | notImplemented
server/src/net/actions/open_chest.ts | v | behavior | CHEST_MAX_ITEMS CHEST_SLOTS openChest ownChestContents publicChestContents registerChest
server/src/net/actions/open_chest.ts | v | symbol-only | forgetChests
server/src/net/actions/open_chest.ts | v | none | CHEST_REACH PUBLIC_CHEST ownChestContainers runChestAction
server/src/net/actions/open_chest.ts | t | none | ChestCell ChestContainers ItemStack
server/src/net/actions/place_automation.ts | v | behavior | placeAutomation placementAt placementsOfRoom
server/src/net/actions/place_automation.ts | v | symbol-only | forgetPlacements
server/src/net/actions/place_automation.ts | v | none | FALLBACK_MAX_CELL SORTER_COMPONENT_ID clearPlacementRegistry resetPlacementClock setPlacementClock
server/src/net/actions/place_automation.ts | t | none | AutomationPlacement
server/src/net/actions/plant_crop.ts | v | none | plantSeedAt
server/src/net/actions/reset_world.ts | v | behavior | resetWorld
server/src/net/actions/sleep.ts | v | behavior | SLEEP_DURATION_MS SLEEP_DURATION_SEC beginSleep bumpSleepGeneration clearSleepRegistry setSleepClock sleep sleepClockBaseOf sleepGenerationOf sleepStateOf sleepingCount
server/src/net/actions/sleep.ts | v | none | SLEEP_CLOCK endSleep forgetSleepWorldClock noteSleepWorldSeconds resetSleepClock
server/src/net/actions/sleep.ts | t | none | SleepClockBase SleepRecord SleepState
server/src/net/actions/start_party.ts | v | behavior | PartyPhase addScore clearPartyRegistry endParty partyStateOf setPartyClock startParty
server/src/net/actions/start_party.ts | v | none | resetPartyClock
server/src/net/actions/start_party.ts | t | behavior | PartySettlement
server/src/net/actions/start_party.ts | t | none | PartySnapshot PartyStanding ScoreResult
server/src/net/actions/types.ts | t | behavior | ActionContext
server/src/net/actions/types.ts | t | none | ActionHandler
server/src/net/actions/use_alchemy_furnace.ts | v | behavior | claimFurnaceOrder furnaceClaimKeyOf furnaceOrderIdOf useAlchemyFurnace
server/src/net/actions/use_alchemy_furnace.ts | v | none | ALCHEMY_LAB_ROOM_KEY FURNACE_KEY_NS_DERIVED FURNACE_KEY_NS_EXPLICIT forgetFurnaceClaims releaseFurnaceOrder
server/src/net/actions/use_alchemy_furnace.ts | t | none | FurnaceClaim
server/src/net/actions/use_item.ts | v | behavior | useItem
server/src/net/actions/use_own_chest.ts | v | behavior | useOwnChest
server/src/net/actions/wire_edit.ts | v | behavior | wireAt wiresOfRoom
server/src/net/actions/wire_edit.ts | v | none | wireEdit
server/src/net/actions/wire_edit.ts | t | none | RoomWires WireEdge
server/src/net/anticheat.ts | v | behavior | AntiCheatRoom BASE_ATTACK_INTERVAL_S DEFAULT_FRAME_DT_SECONDS DEFAULT_LIMITS FRAME_SECONDS InventoryReject ItemSourcePurpose MAX_ATTACK_SPEED_BONUS MAX_ITEM_DELTA_PER_TICK MAX_MOVE_CATCHUP_TICKS MAX_SPEED_BONUS_MUL SPEED_WINDOW_SECONDS SPEED_WINDOW_TICKS SPEED_WINDOW_TOLERANCE TELEPORT_SLACK VIOLATION_KEEP_PER_PLAYER VIOLATION_LOG_CAPACITY VIOLATION_SCORE_DECAY_PER_TICK VIOLATION_SCORE_KICK VIOLATION_WEIGHT ViolationKind advanceServerClock checkAttack checkInventory checkMove commitAttack createAcState decayScore fixedClock maxDisplacementPerTick mergeLimits parseItemSourceToken previewAttack restoreMoveWindow snapshotMoveWindow
server/src/net/anticheat.ts | v | none | looksLikeItemSourceToken mintItemSourceToken
server/src/net/anticheat.ts | t | behavior | FixedClock
server/src/net/anticheat.ts | t | symbol-only | MoveIntent
server/src/net/anticheat.ts | t | none | AntiCheatLimits Clock InventoryCheckInput InventoryCheckResult InventoryOp ItemSourceGrant MoveWindowSnapshot PlayerAntiCheatState Verdict Violation
server/src/net/room.colyseus.ts | v | behavior | NetPersistRoom deltaExclusions resolveRoomDb resolveRoomHost
server/src/net/room.colyseus.ts | v | none | USE_COLYSEUS_PATCH gameServerConfig patchEnabled
server/src/net/room.colyseus.ts | t | behavior | NetPersistRoomOptions
server/src/net/room.colyseus.ts | t | none | RoomCreateOptions
server/src/net/room.ts | v | behavior | ACTION_PERMISSION AC_FRAME_GAP_MAX_MS AFK_TIMEOUT_MS AUTOSAVE_FRAME_INTERVAL AUTOSAVE_INTERVAL_MS EVENT_TRIM_INTERVAL_MS IDLE_SLEEP_MS JOIN_TOKEN_MAX_TTL_MS JOIN_TOKEN_TTL_MS MAX_ACTIONS_PER_TICK MAX_PARTY_TIMER_SEC MEMBER_PRESENCE_LABEL MemberPresence PERMISSION_MATRIX PLAYER_SNAPSHOT_INTERVAL_MS RECONNECT_GRACE_MS RoomAction RoomRegistry RoomRuntime bootstrap can projectInventoryTotal projectPlayer
server/src/net/room.ts | v | none | EVICT_MS HEARTBEAT_TIMEOUT_MS SAVE_ERROR_LOG_MAX registryRoomIds signRoomToken verifyRoomToken
server/src/net/room.ts | t | behavior | ActionOutcome ActionPayload EffectRecord PlayerProjection SimReadView WorldSaveHost
server/src/net/room.ts | t | symbol-only | RoomRuntimeOptions
server/src/net/room.ts | t | none | AttackReport AutosaveReason BootstrapOptions EffectScalar EffectValue InventoryDetailSource ItemReadPort JoinRejectCode JoinResult JumpReport MemberSession RolePermissions RoomRegistryOptions RoomTokenClaims RoomTokenVerdict StartingInventoryReport UseItemOutcome
server/src/net/schema.colyseus.ts | v | behavior | BossSchema PlayerSchema RoomMetaSchema RoomSchema WildlifeSchema assertFieldTableParity assertSchemaReady
server/src/net/schema.colyseus.ts | v | none | colyseusTypeOf fieldTypeMap
server/src/net/schema.ts | v | behavior | bumpChunkVersion createBossState createPlayerState createRoomState createWildlifeState entityPayloadBytes fullMask removePlayer upsertPlayer upsertWildlife validateFieldTable
server/src/net/schema.ts | v | none | MAX_FIELDS_PER_TABLE fieldBytes removeBoss removeWildlife upsertBoss
server/src/net/ws_server.ts | v | behavior | BACKPRESSURE_DISCONNECT_STRIKES FrameTooBigError MAX_CONN_BUF_BYTES MAX_CONTROL_FRAME_BYTES MAX_FRAME_BYTES MAX_FRAME_HEADER_BYTES MAX_PENDING_HELLO_CONNS OP_BINARY OP_CLOSE OP_PING PROTOCOL_VERSION acceptKey classifyUplink encodeFrame formatWsLogLine isBufOverflow parseFrame parseMoveIntent readUserIdFromUrl
server/src/net/ws_server.ts | v | none | HELLO_TIMEOUT_MS OP_CONT OP_PONG OP_TEXT defaultWsLog encodeClose readQueryParam readTokenFromUrl startWsServer
server/src/net/ws_server.ts | t | symbol-only | HelloFrame WsServerHandle
server/src/net/ws_server.ts | t | none | MoveIntentParse ParsedFrame UplinkKind WsConn WsLogCategory WsLogCounts WsRoomLike WsServerOptions
server/src/party/actions.ts | v | behavior | GATE_REJECT PARTY_ACTION deskModeKey gateBridgeCapture gateBridgePlace gateCrownPickup gatePartyStart gatePartyStop gatePrank gateRushDelivery gateRushStart unwiredActions wiredActions
server/src/party/actions.ts | v | symbol-only | gateCrownKnock
server/src/party/actions.ts | v | none | CROWN_COOLDOWN_SEC PARTY_ACTION_LEDGER REFEREE_DESK_STOP_MODE
server/src/party/actions.ts | t | none | ActionGate ActionLedgerRow GateReject PartyAction
server/src/party/modes.ts | v | behavior | BRIDGE_TILES_TO_WIN CROWN_MODE_SEC CROWN_PICKUP_COOLDOWN_SEC CROWN_WIN_SEC JELLY_BALL_RESET_SEC PAINT_BALL_RADIUS PAINT_MODE_SEC PARTY_MODE_KEY PARTY_PHASE assertAllModesPresent bridgeCapture bridgePlace contestAssignTeam contestBridgeFlagged contestBroadcaster contestBuiltOf contestCapture contestCrownCooldown contestCrownDrop contestCrownHolder contestCrownPickup contestCrownSecOf contestCrownWinner contestMode contestPlaceBoard contestSettlement createBridgeRun createCrownRun createJellyBall createPaintWar createPartyContest createPartyMode createRaceRun crownAssignTeam crownDrop crownPickup finishRunner judgeGoal kickBall modeElapsedSec modeTotalSec openGate partyModeConfig settleBridgeRun settleCrown settleJellyBall settlePaintWar settlePartyRun settleRace startPartyMode throwPaintBall tickCrown tickJellyBall tickPartyContest tickPartyMode
server/src/party/modes.ts | v | none | BRIDGE_BOARD_ITEM_ID BRIDGE_BUILD_SEC BRIDGE_FLAG_ITEM_ID BRIDGE_RACE_SEC BRIDGE_SCORE_PER_FLAG BRIDGE_SCORE_PER_TILE CROWN_ITEM_ID JELLY_BALL_RADIUS JELLY_GOAL_DEPTH JELLY_GOAL_WIDTH JELLY_MU JELLY_RESTITUTION JELLY_TEAM_SIZE PAINT_DYE_COUNT PAINT_GRID_H PAINT_GRID_W ballInGoal registerRunner
server/src/party/modes.ts | t | behavior | PartyPhase PartySettlement
server/src/party/modes.ts | t | none | BridgeRunRuntime CrownRuntime GoalResult JellyBall JellyBallRuntime JellyGoal PaintWarRuntime PartyContest PartyModeConfig PartyModeKey PartyModeRuntime PartyStandingRow RaceRuntime ThrowPaintResult
server/src/party/scoring.ts | v | behavior | BROADCAST_KIND PARTY_SCORE_EVENT REWARD_EXP_BY_RANK REWARD_ITEM_BY_RANK TEAM_KEY TEAM_LABEL TEAM_ORDER createBroadcaster createPaintGrid createRaceTimer createScoreboard crownLine drainBroadcasts formatMs gateStart getTeam idx makeRng neutralCount paint paintRadius paintStandingLine pickDyeIndex podiumFinish pushBroadcast rankPaint rankRace rewardForRank rewardsForPlayers rewardsForTeams scoreLine scoreOfPartyEvent seededRng shiftBroadcast tallyPartyScores tileCount toMs
server/src/party/scoring.ts | v | none | BALL_SPAWNER_ITEM_ID CROWN_BASE_ITEM_ID DYE_VAT_ITEM_ID GOLD_WHISTLE_ITEM_ID PAINT_BALL_ITEM_ID PARTY_FOREIGN_EVENT_UNITS PARTY_MODE_UNIT_POINTS PARTY_REACH_TARGET_METRIC PARTY_REACH_TARGET_POINTS PARTY_SCORE_METRIC RACE_FINISH_PODIUM_ITEM_ID RACE_START_GATE_ITEM_ID REFEREE_STAND_ITEM_ID SCORE_GOAL_ITEM_ID SPAWN_FLAG_ITEM_ID TEAM_DYE_INDEX modeEndLine modeStartLine podiumBroadcast rankByDescending
server/src/party/scoring.ts | t | behavior | PaintStanding RaceResult
server/src/party/scoring.ts | t | none | Broadcast BroadcastKind Broadcaster PaintGrid PartyScoreAward PartyScoreEvent PartyScoreEventKind PartyScoreMetric PartyScoreTally RaceTimer RewardLine TeamKey TeamScore
server/src/physics/carry.ts | v | behavior | BOUNCE_TARGET_Z BOUNCE_VZ BOUNCE_VZ_ANALYTIC CarryReject CarrySystem HEAVY_MASS_THRESHOLD LIFT_RANGE LIFT_Z_MAX SHIELD_ITEM_ID STACK_4_TOP_Z STACK_STEP arcElevation arcRange canLift firstCatchWindow isKnockbackImmune simulateArc theoreticalAirtime theoreticalRange
server/src/physics/carry.ts | v | none | JUMP_TARGET_Z JUMP_VZ PASS_WINDOW STACK_SHED_SPEED THROW_COOLDOWN chainLength planarDistance
server/src/physics/carry.ts | t | behavior | CarryActor
server/src/physics/carry.ts | t | none | ArcSample CarryWorld CatchCheck ChainNode ThrowResult
server/src/physics/world.ts | v | behavior | BELT_FORCE BLEED_DPS BOUNCE_VZ BOUNCE_VZ_ANALYTIC BURN_DPS CLAMP_RING_MAX COLLISION_RESTITUTION DEFAULT_BODY_MASS DEFAULT_PLAYER_RADIUS FLAT_TERRAIN MAX_SUBSTEPS PhysicsWorld TRAP_DELAY apexHeight decayTrace glide lastFreeAlong launchSpeedForApex safeMass slideDistance slideFrames
server/src/physics/world.ts | v | none | BELT_POWERED_BONUS BELT_REQUIRES_POWER BODY_STATE_PRIORITY DEFAULT_PLAYER_MASS FINITE_LIMIT FxKind KNOCKBACK_STUN_SEC MU_MUL_NEUTRAL PhysStats SERVER_TICK_HZ SUBSTEP_SPEED_THRESHOLD SWEEP_REFINE_STEPS TIMED_BODY_STATES TRAP_EPS TRAP_FALL_MUL VORTEX_ACCEL VORTEX_RADIUS applyTimedBodyState isTimedBodyState
server/src/physics/world.ts | t | behavior | PhysTerrain
server/src/physics/world.ts | t | none | PhysFx PhysicsWorldOptions StepReport
server/src/prank/actions.ts | v | behavior | CROWN_KNOCK_TOY_IDS PRANK_ACTION_LEDGER PRANK_PLAYER_VERB PRANK_REJECT auditPrankLedger resolveCrownKnock resolvePrankAction wiredPrankToys
server/src/prank/actions.ts | v | none | PRANK_CROWN_VERB PRANK_SHIELD_ITEM_ID assertPrankActionLedgerComplete
server/src/prank/actions.ts | t | none | CrownKnockOutcome PrankActionOutcome PrankActionRequest PrankActionRow PrankReject
server/src/prank/immunity.ts | v | behavior | EFFECT_ORIGIN HOSTILE_ENTRIES HOSTILE_SOURCES IMMUNITY_BY_KEY IMMUNITY_MANIFEST NAMED_IMMUNE_TOY_IDS SHIELD_VERDICT applyShield assertImmunityManifestComplete createShield isImmuneToAllyPrank isImmuneToHostile resolveShield toggleShield
server/src/prank/immunity.ts | v | none | EFFECT_ORIGINS HOSTILE_SOURCE HOSTILE_SOURCE_LABEL NAMED_IMMUNE_LABEL
server/src/prank/immunity.ts | t | none | EffectOrigin HostileSource ImmunityEntry ShieldResolution ShieldState ShieldVerdict
server/src/prank/toys.ts | v | behavior | BANANA_SLIDE_STUN_SEC BANANA_SLIDE_TILES BOMB_ENEMY_DAMAGE BOMB_FUSE_SEC BUBBLE_DRIFT_SEC BUBBLE_HITS_TO_TRAP GIANT_SCALE HELMET_SELF_DAMAGE HELMET_SELF_PARALYZE_SEC HONEY_SLOW_RATIO PRANK_TOYS PRANK_TOY_BY_ID PRANK_TOY_COUNT PRANK_TOY_ID_MAX PRANK_TOY_ID_MIN SAFE_SHIELD_ITEM_ID SELF_DAMAGE_HP_FLOOR_RATIO SELF_DAMAGE_STATE SHRINK_SCALE SNOWBALL_FREEZE_SEC TOY_STATE_FLAG TOY_TRIGGER TUG_IMPULSE applySelfDamage assertAllyZeroDamage assertToyFieldsSane assertToyIdSetClosed createBubble hitBubble resolveBananaSlide resolveHelmetSelfStrike resolveSnowball selfDamageHpFloor toyIds toyOf
server/src/prank/toys.ts | v | none | BANANA_MU BUBBLE_STACK_LIMIT
server/src/prank/toys.ts | t | none | BananaSlideResult BubbleHitResult BubbleRuntime PrankToyDef SelfDamageOutcome SnowballResult ToyEffect ToyStateFlag ToyTrigger
server/src/rooms/effects.ts | v | behavior | PENDING_ELEMENT_RESIST_MUL ROOM_EFFECT_DECISION ROOM_ELEMENT_RESIST ROOM_SYSTEM_IMPL createRoomEffectState isRoomSystemImplemented maxHpMulOf pushRoomElementResist roomAtCell roomElementResistOf stepRoomEffects
server/src/rooms/effects.ts | v | none | BEDROOM_HEAL_PER_SEC CANTEEN_MEAL_MUL ONSEN_BUFF_SEC ONSEN_MAX_HP_MUL
server/src/rooms/effects.ts | t | none | ElementResistSink RoomEffectInput RoomEffectResult RoomEffectState RoomElementResistEntry RoomSystemImpl
server/src/sim/world_debts.ts | v | behavior | WORLD_DEBTS WORLD_DEBT_STATUS pendingBalanceRows worldDebtLedgerVerdict worldDebtOf worldDebtVerdict
server/src/sim/world_debts.ts | t | none | WorldDebtEvidence WorldDebtRow WorldDebtStatus
server/src/sim/world_sim.ts | v | behavior | FAST_PER_SLOW RESTORE_FAIL SIM_FAST_DT SIM_SLOW_DT WorldSim mulberry32
server/src/sim/world_sim.ts | v | none | WORLD_SAVE_FLUID_MAX_BYTES warnRadiusOf wireTelegraphShapeOf
server/src/sim/world_sim.ts | t | none | MaterialApi PlayerProfile RestoreFailCode SimFrameReport WorldArchiveReceipt WorldArchiveRequest WorldArchiveSink WorldArchiveTrimReceipt WorldResetResult WorldSimOptions
server/src/social/afk.ts | v | behavior | BED_HP_PER_SEC CROSS_ROOM_FEE_RATIO DEEP_SLEEP_AFTER_SEC DEW_FIRE_BONUS DEW_SEC_PER_UNIT DEW_TATAMI_BONUS DOZE_AFTER_SEC DOZE_STATE KITE_CATCH_PENALTY_MS MAILBOX_CAPACITY MAIL_TTL_SEC MARATHON_LENGTH STALL_ITEM_ID TRACK_KIND VIVARIUM VIVARIUM_CAMERA_SHOTS WHITE_NOISE_MIX afkExpRatio badgeFor buyFromStall createAfkPlayer createMailbox createStall createTrack createVivarium dewRatePerSec enterVivarium exitVivarium goBackground goForeground leaveMail likeMail listItem patDozing pruneMailbox suggestedPrice tickAfk tickVivarium trackCaught trackFinish trackPodiumText trackStandings trackStart whiteNoiseMasterGain
server/src/social/afk.ts | v | none | CROSS_ROOM_MAX_QTY DEEP_SLEEP_MUL DEW_PAT_BONUS KITE_LENGTH MAILBOX_ITEM_ID MAIL_LIKE_BADGES STALL_SLOT_COUNT STICKER_COUNT SUGGESTED_PRICE_MUL assertSocialRefsClosed
server/src/social/afk.ts | t | none | AfkPlayer DozeState Mail Mailbox PurchaseResult Stall StallListing TrackKind TrackRuntime VivariumShot VivariumState
server/src/systems/alchemy_lab.ts | v | behavior | brewAndRecord createGallery firstDiscovererOf galleryEntryOf galleryOrder materialsOf
server/src/systems/alchemy_lab.ts | v | none | ALCHEMY_LAB_SYSTEM GALLERY_FALLBACK_NAME MAX_BREW_MATERIALS MIN_BREW_MATERIALS displayNameOf materialsResolvable
server/src/systems/alchemy_lab.ts | t | none | BrewInput BrewOutcome Gallery GalleryEntry
server/src/systems/depot.ts | v | behavior | CONTENT_PRICE_TABLE buy buyOnce contentPriceTable listable priceOf
server/src/systems/depot.ts | v | none | DEPOT_SYSTEM LISTABLE_TAGS
server/src/systems/depot.ts | t | none | BuyInput BuyOnceOutcome BuyResult ListableResult OrderBuyInput PriceLookup PriceTable
server/src/systems/greenhouse.ts | v | behavior | HARVEST_YIELD SORT_PASS_THROUGH cellGrowth cropProductIdOf cropProductNameOf morningMoisture sortHarvest sprinklerCells
server/src/systems/greenhouse.ts | v | none | CROP_PRODUCT_NAME_BY_CROP GREENHOUSE_MIN_MOISTURE GREENHOUSE_SYSTEM OUTDOOR_BLOCKING_WEATHER SPRINKLER_MOISTURE SPRINKLER_REACH Weather
server/src/systems/greenhouse.ts | t | behavior | SortFilter
server/src/systems/greenhouse.ts | t | none | CellGrowthInput CellGrowthResult CropCell
server/src/systems/idempotency.ts | v | behavior | SETTLEMENT_LEDGER_CAPACITY SETTLEMENT_ROOMS claimSettlement createSettlementLedger settleKeyOf settlementKeyCount settlementSeenAt
server/src/systems/idempotency.ts | v | none | mergeSettlementLedger settlementEntries
server/src/systems/idempotency.ts | t | behavior | SettlementLedger
server/src/systems/idempotency.ts | t | none | DaySettlementScope OrderSettlementScope SettlementClaim SettlementScope
server/src/systems/intake.ts | v | behavior | SOWABLE_ITEM_IDS addPetToRanch addSortFilter sowableReasonOf
server/src/systems/intake.ts | v | none | SOWABLE_NOTE_MARKERS roomSystemsPortOf
server/src/systems/intake.ts | t | none | IntakeOutcome RanchIntakePet RoomSystemsPort SortFilterIntake
server/src/systems/ranch.ts | v | behavior | RANCH_AFFINITY_MIN RANCH_PRODUCE_BY_SPECIES canAutoFeed feedItemOf resolveItemByName settleRanchDay settleRanchDayOnce
server/src/systems/ranch.ts | v | none | RANCH_FEED_PER_DAY RANCH_PRODUCE_PER_DAY RANCH_SYSTEM
server/src/systems/ranch.ts | t | none | RanchAnimal RanchDayInput RanchDayKeyedInput RanchDayResult RanchFeedRow RanchOnceOutcome RanchProduceRow
server/src/systems/wiring.ts | v | behavior | CROP_MATURE_DAYS HarvestLanding brewInLab brewInLabOnce createRoomSystemsState cropAt foodPhysicsOf galleryDisplay growCrops plantCrop settleRanch settleRanchOnce
server/src/systems/wiring.ts | v | none | cropKey gatherMulOf producedItemIdOf
server/src/systems/wiring.ts | t | behavior | RoomSystemsState
server/src/systems/wiring.ts | t | none | BrewOnceOutcome BrewOrderInput CropCellState FoodPhysicsTarget FoodStatModsLike GalleryDisplayRow GrowInput GrowResult HarvestDelivery HarvestRow
server/src/wiring/components.ts | v | behavior | CHANNEL_MAX CHANNEL_MIN COMPONENT_PRODUCER_LEDGER COMPONENT_SPECS COUNTER_MOD ENV_KEY_LEDGER NIGHT_END_HOUR NIGHT_START_HOUR NIGHT_WINDOW PULSE_BUTTON_SECONDS PURE_EFFECT_IDS RELAY_DELAY_SECONDS RELAY_DELAY_TICKS SIGNAL_IDS SPEC_BY_ID SPRING_COOLDOWN_TICKS STATE_DEFAULTS WORLD_ENV_KEYS auditComponentCoverage auditComponentProducers channelMatches chooseSplitterRoute counterDigits counterStep formatRunTime isNight isNightAtHour makeComponent nextRandom pitchMatches randomUnit relayTicksFor
server/src/wiring/components.ts | v | none | ALL_OUTPUT_COLORS COUNTER_MAX ComponentGroup EnvKeyProducer INHERENT_LATENCY_TICKS PULSE_BUTTON_TICKS SPEC_BY_KIND SPLITTER_ROUTES SPLITTER_ROUTE_NAMES
server/src/wiring/components.ts | t | none | ComponentProducerRow ComponentSpec EnvKeyRow NightWindow
server/src/wiring/graph.ts | v | behavior | ALL_COLORS FRAME_SECONDS PropagateMode SignalGraph TICKS_PER_SECOND createComponent estimateAdvanceCost hasComponentKind layHorizontal registeredKinds secondsToTicks
server/src/wiring/graph.ts | v | none | COLOR_KEY layVertical registerComponentKind
server/src/wiring/graph.ts | t | none | AdvanceCostEstimate ComponentContext ComponentEvaluator ComponentNode EnvSource PendingWrite PropagateStats SignalGridLike
server/src/wiring/logistics.ts | v | behavior | ARM_CYCLE_TICKS ARM_TARGETS CONVEYOR_CELLS_PER_SECOND CONVEYOR_CELLS_PER_TICK CONVEYOR_TICKS_PER_CELL DRILL_PERIOD_SECONDS DRILL_PERIOD_TICKS LANE_ROUTE LOGISTICS_HZ SorterRoute applySorterFilters createArmState createConveyorState createDrillState createSorterState loadConveyor pickRoute previewRouting routeOfLane stepArm stepConveyor stepDrill stepSorter takeDrillBuffer tickLogistics ticksFor
server/src/wiring/logistics.ts | v | none | ARM_BATCH ARM_CYCLE_SECONDS ARM_REACH ArmPhase DIR_DX DIR_DY DRILL_REACH ItemStack LOGISTICS_FRAME_SECONDS ROUTE_SIDE drillPowered sideOffset
server/src/wiring/logistics.ts | t | behavior | ArmWorld SorterLaneRule SorterState Stack
server/src/wiring/logistics.ts | t | none | ArmState ArmStepResult ConveyorState ConveyorStepResult DrillState DrillStepResult LogisticsLine LogisticsTickReport SorterStepResult
server/src/world/archive.ts | v | behavior | FLUID_LEVELS_BUDGET_BYTES TRIM_RULE_ID WORLD_ARCHIVE_FORMAT_VERSION WORLD_ARCHIVE_MIN_READABLE_VERSION applyRestorePlan decodeWorldArchive describeDecodedWorld diffWorldState emptyWorldState encodeWorldArchive fitWorldArchive planChunkTrim planFluidLevelsTrim planRestore
server/src/world/archive.ts | v | none | FLUID_LEVEL_TRIM_RULE_ID WORLD_ARCHIVE_MAGIC archiveChunksChecksum compareChunkPriority compareFluidLevelPriority
server/src/world/archive.ts | t | behavior | ArchiveTrimReport DecodedWorldArchive RestorePlan
server/src/world/archive.ts | t | none | ArchiveChunk ArchiveFluidField ArchiveFluidLevel ArchiveGroundItem ArchiveMob ArchivePlayer ArchiveTrimDroppedChunk ArchiveWorldMeta ChunkTrimPlan EncodeWorldArchiveInput FitWorldArchiveResult FluidLevelTrimPlan RestoreChunk RestoreChunkOp RestoreFluidOp RestoreGroundOp RestoreMobOp RestoreOp RestorePlayerOp RestoreWorldOp RestoreWorldState WorldArchiveChunkPayload
server/src/world/chunk.ts | v | behavior | BARE_GROUND_MU Chunk DIRTY_BYTES DIRTY_WORDS EMPTY_TILE FLOOR_BURN_BY_SLOT FLOOR_DEFAULT_MU FLOOR_META FLOOR_MU_BY_SLOT FLOOR_PALETTE FLOOR_SLOT_MASK FLOOR_SPEED_MUL_BY_SLOT ROOF_BITS ROOF_CAPABLE ROOF_ID_MAX ROOF_META SPEED_MUL_DEFAULT VERTICAL_STACK assertRoofId chunkKey decodeRoofRle encodeRoofRle floorIdOfSlot floorMeta floorMu floorSlotOfId idx inChunkBounds isRoofId muOfSlot popcount32 roofAlphaOf roofSpanOf speedMulOfSlot worldToChunk
server/src/world/chunk.ts | v | none | BUILDING_MAX BUILDING_MIN CHUNK_MASK CHUNK_SHIFT CHUNK_W DEFAULT_MU FLOOR_BASE_COUNT FLOOR_ID_MAX FLOOR_ID_MIN FLOOR_UGC_FIRST FLOOR_UGC_ID FLOOR_UGC_LAST LAYER_FIELD PACKED_LAYERS SurfaceKind VerticalLayer floorBurn toBytes
server/src/world/chunk.ts | t | none | FloorMeta LayerSpec RoofMeta TileView WorldToChunk
server/src/world/fluid.ts | v | behavior | CAP FLUID_CELL_BUDGET FLUID_FRAME_SECONDS FLUID_RATE_HZ FluidField FluidKind OBSIDIAN_ID PHASE_MIN_AMOUNT PUMICE_ID VISCOSITY_FLOW baseOfFluidKind fluidKindOfBase makeSealedPool packFluidAmounts readFluidAmounts
server/src/world/fluid.ts | v | none | FLUID_AMOUNT_HEADER_BYTES FLUID_AMOUNT_MAGIC applyFluidAmounts
server/src/world/fluid.ts | t | none | FluidAmountsBlob FluidCellInit FluidStepReport
server/src/world/grid.ts | v | behavior | CanalResult DIR_NAMES DIR_VECTORS WorldGrid digToDeep findCanalIntakes isCanalIntake
server/src/world/grid.ts | v | none | isInsideChunk
server/src/world/grid.ts | t | none | GridStats TerrainSource
server/src/world/vision.ts | v | behavior | lineOfSight losBlocked losClear
server/src/world/vision.ts | v | none | LOS_MAX_CELLS
server/src/world/vision.ts | t | none | SolidAt
<!-- GEN:CENSUS:END -->

## 4 本轮结论(实测)

```text
1 三档分布:见 §1。none 里仍被生产引用的那一批(见 §2)是真欠账:
  有**生产调用者**、却零直调判据 —— 一旦它的行为改坏,没有任何测试会红。
2 与上一轮(第十轮,scratch 里的矩阵)对照:
   上一轮 2290 导出 = 真行为 1222 / 只有符号 10 / 完全没有 979
   本轮   2307 导出 = 见 §1(判据更严:B2 要求"同用例体内有断言",上一轮只要"名字出现在测试代码里")
   ⇒ **口径变了,数不可直接相减**;这也是本轮把口径写进代码的原因。
   上一轮那 10 条 symbol-only 里,`assertFieldTableParity` / `assertSchemaReady` / `MAX_LEVEL` / `assertRoofId`
   已翻成 behavior(WS-07 / WS-FND-144 的真调用);其余仍在清单里。
3 symbol-only 只剩十几条(见 §2 表头几行)—— 这一档本来就是"最容易假绿"的形态:
   `ok(src.includes('foo'))` 看起来在测 foo,实则只证明**源码里出现过这个名字**。
```

## 5 接线改法(`scripts/verify.ts`,本任务**没有**改它)

两行改动,**一行 import + 一行调用**:

```text
① import 区(紧跟第 33 行 `import { runSelfcheck } from './invariants.ts';` 之后):
   import { runCheck as runCoverageMatrixCheck } from './coverage-matrix.ts';

② main 里紧跟 `if (!frozenOnly && !only) checkCountAudit();`(写这份改法时在 verify.ts:8038)之后:
   if (!frozenOnly && !only) {
     const cm = runCoverageMatrixCheck({ root: ROOT, ledgerPath: join(ROOT, 'docs', 'COVERAGE-MATRIX.md') });
     if (!cm.ok) fail(`导出覆盖矩阵台账与实测不一致:${cm.problems.slice(0, 3).join('; ')}`);
     else pass(`导出覆盖矩阵台账与实测一致(导出 ${cm.report.totals.exports}:`
       + `behavior ${cm.report.totals.behavior} / symbol-only ${cm.report.totals.symbolOnly}`
       + ` / none ${cm.report.totals.none})`);
   }
```

```text
为什么用**进程内调用**而不是 spawnSync:本工具是纯读函数,进程内调用会把它算进 pass/fail
计数与退出码;子进程形态在"脚本被删"时会静默变成「没跑」(与 scripts/invariants.ts 同一理由)。
为什么位置与 checkCountAudit 对齐:两者性质相同(「文档里的自称」vs「代码算出的正解」),
且都是**只读文件 + 全量口径** ⇒ 局部口径(--only / --frozen)里比它必然假红。
```

## 6 已知边界(判据的边界写在这里,不假装无边界)

```text
1 B2 是**上界**:用例体内出现过名字 + 后面有断言 ≠ 断言的就是它的行为。
  例:`const c: Clock = ...; eq(c.now(), 1);` 里 Clock 只作类型标注 ⇒ 记 behavior。
  ⇒ 故台账把 kind 逐行标出:对 **type** 导出,behavior 的语义只是「在测试代码里被引用(类型位)」,
    而**类型没有可断言的运行时行为** —— 那一档不是"证明了行为"。
2 生产引用数**按名字**统计 ⇒ 跨模块同名会串台(本仓确有:Clock / ItemStack / 各 DIR_DX)。
  它是**上界**,不是引用图。
3 barrel 只解析**一层**(`export ... from` / `export *` 折回定义文件);
  匿名 `export default {...}` 不登记(没有名字可登记);
  `export const a = 1, b = 2` 只登记 a(单声明符口径)。
4 正则字面量靠「前一个有效字符」识别(不是 tokenizer):极端写法会把除法当正则起点。
  上一轮在同一处栽过**相反**方向 —— 把正则里的引号当字符串起始,报了 400 条假阳性。
5 「只在字符串里、但那行不是取文本的实参」⇒ 记 `none`,**不**记 symbol-only:
  它不构成"用文本核对该符号"的证据(否则 `eq(msg, 'foo')` 这种巧合会污染这一档)。
```