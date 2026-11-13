# WS-10 战斗伤害管线、等级词条成长与幽灵泡泡救援 — 细化设计文档

> 适用范围:`server/src/combat/{weapons,damage,progression,revive,cooking}.ts` + `tests/WS-10.test.ts`
> 事实源:`shared/contracts/FREEZE.md`、`shared/types/entities.ts`、`shared/types/physics.ts`、
> `shared/constants/items.ts` §3.9(601-630)与 §3.10(701-745)、`shared/constants/bosses.ts`
> 冻结层全程只读,本模块只 `import`,不复制、不改写任何冻结公式。

---

## 1. 职责边界

**本子系统负责**

- §3.10 表(701~745)中全部战斗向物品的**数值化**:13 件武器(711~723)、1 件破盾工具(204)、
  9 件护甲/饰品/披风(724~731 与 630)、2 件团战消耗品(732/733)、8 件 Boss 召唤祭品(734~741)、
  10 件狩猎材料(701~710)与 4 件辅助工具(742~745),共 45 项全覆盖索引。
- 每件武器/护甲的被动与 `[Q]` 主动技的**可执行参数**:倍率、射程、形状、段数、冷却、破盾倍率、
  破甲、暴击加成、击退倍率、眩晕/冻结时长、预警时长。
- **完整伤害管线**(8 步公式链):基础 → 元素克制 → 破甲 → 破盾 → 暴击 → 减伤 → 反伤 → 击退。
- **等级成长**:`expToNext` / `statsAtLevel` 的调用封装、6 条被动天赋(5/10/15/20/25/30 级解锁)、
  升级动画触发条件与属性重算。
- **全队经验共享**:24 格内 100%、≥3 人 +25%、打盹 0.3×、同怪去重与总额防刷上限。
- **幽灵泡泡倒地与救援**:零掉级零爆装快照、1 秒半血复活、227 三发困人、
  733 六格满血复活 + 3 秒无敌、435 复活旗点位复活。
- **料理与恶作剧锅**:601~615 全量效果与时长、506 老汤锅双分支判定、212 大铁铲灭火与 +1 战斗词条。

**本子系统明确不负责**

- 物品 ID 分配与名称/分类/价值分:全部由冻结层 `items.ts` 决定,本模块只经 `itemName()` 读取。
- `expToNext` / `statsAtLevel` / `bossScaledHp` 的**公式实现**:冻结层已给出,本模块只调用。
- 位压缩地形、质点物理积分、AOI 管理、网络同步协议:属 WS-01/WS-02/WS-03。
- 炼金炉 LLM 协议与数值 Roll:属 WS-05(`alchemy.ts`),本模块仅消费其产出的 `RolledStats`。
- 客户端表现层:飘字渲染、粒子特效、相机抖动、音效播放属 WS-11/WS-12;
  本模块只输出**飘字规格**(文本、颜色、字号缩放比)与**命中计划**(结算帧偏移)。

---

## 2. 上游 / 下游接口

### 2.1 上游(只读引用,冻结层)

| 符号 | 来源 | 用途 |
| :--- | :--- | :--- |
| `BASE_ATK = 10` | `shared/types/physics.ts` | 裸装攻击基值 |
| `MASS_PLAYER = 1.0` | `shared/types/physics.ts` | 质量换算基准 |
| `BodyState` 七态 | `shared/types/physics.ts` | `GHOST_BUBBLE` / `BUBBLED` / `NORMAL` |
| `MAX_LEVEL = 30`、`BASE_HP = 100` | `shared/types/entities.ts` | 满级与生命基值 |
| `expToNext` / `statsAtLevel` / `TALENT_LEVELS` | `shared/types/entities.ts` | 成长曲线与天赋等级轴 |
| `SHARE_EXP_RADIUS=24`、`PARTY_BONUS_THRESHOLD=3`、`PARTY_BONUS=0.25`、`AFK_EXP_RATIO=0.3` | `shared/types/entities.ts` | 经验共享四常数 |
| `REVIVE_TIME=1.0`、`REVIVE_HP_RATIO=0.5`、`FEATHER_RANGE=6`、`FEATHER_INVULN=3.0` | `shared/types/entities.ts` | 救援四常数 |
| `ITEM_LIST` / `ITEM_BY_ID` / `itemName` | `shared/constants/items.ts` | 45 项名称唯一来源 |
| `BOSS_LIST` | `shared/constants/bosses.ts` | 祭品 ID ↔ Boss 的交叉校验 |

`revive.ts` 刻意用 `FEATHER_RANGE` / `FEATHER_INVULN` 而非字面量 6 / 3.0,
若 Lead 后续调整冻结常数,测试会立刻指出契约漂移。

### 2.2 下游(本模块对外输出)

| 输出 | 消费方(WS) | 结构 |
| :--- | :--- | :--- |
| `CombatantStats` | WS-03 移动/状态机、WS-04 背包 | 攻防/暴击/闪避/减伤/反伤/冷却乘区 + `flags` 被动钩子 |
| `DamageResult` | WS-11 表现层(飘字)、WS-03(击退冲量) | 8 步明细 + `FloatSpec` + `knockbackImpulse` |
| `DamageResult.steps[]` | WS-13 战斗日志/回放 | `{ step, value, detail }` 三元组 |
| `ShareResult` | WS-02 会话层(广播经验条) | 每人 `share` + 缩放标记 |
| `DownedState` / `ReviveResult` | WS-02 同步、WS-11 特效 | 泡泡状态、无敌计时、快照 |
| `FoodBuff` | WS-07 状态机 buff 槽 | 乘区 + `flags` + `remainingSec` |
| `COMBAT_ITEM_INDEX` | WS-04 背包/图鉴 | 45 项分类与说明 |

---

## 3. 数据结构

### 3.1 装备定义

```ts
interface WeaponDef {
  id: number; name: string;
  kind: WeaponKind;              // SWORD_LIGHT/…/CANNON/TOOL(11 类)
  damageType: DamageType;        // MELEE/RANGED/MAGIC/TERRAIN
  atk: number;                   // 面板攻击(与 BASE_ATK 相加)
  def: number;                   // 盾武防御(721 = 35)
  attackMul: number;             // 武器倍率 1.00 ~ 1.50
  speedMul: number;              // 攻速倍率 0.65 ~ 1.60
  reach: number;                 // 格
  knockback: number;             // 基础击退 格/秒
  knockbackMul: number;          // 719 = 3.0(+200%)
  element: Element;              // NONE/FIRE/ICE/LIGHTNING/LIGHT/SLIME
  armorPen: number; armorPenPct: number;
  shieldBreakMul: number;        // 204 = 4.0
  critBonus: number; critDmgBonus: number;
  pierce: number;                // 穿透目标数
  dot: { element; dps; sec } | null;
  skill: SkillDef; passive: string;
}
```

### 3.2 `[Q]` 技能

```ts
interface SkillDef {
  key: string;           // 冷却字典键,如 'q_lavawave'
  name: string; shape: SkillShape;
  damageMul: number; range: number; radius: number;
  hits: number; tickSec: number; delaySec: number;
  cooldown: number;      // 秒
  shieldBreakMul: number; armorPen: number; armorPenPct: number;
  critBonus: number; knockbackMul: number;
  stunSec: number; freezeSec: number; durationSec: number; telegraphSec: number;
  healHp: number; element: Element;
  dot: { element; dps; sec } | null;
  extras: Record<string, number | string>;
  note: string;
}
```

### 3.3 攻方 / 受方面板

```ts
interface CombatantStats {
  level, baseAtk, totalAtk, maxHp, def,
  dodgeRate,     // ≤ MAX_DODGE_RATE 0.75
  critRate,      // ≤ 1.0
  critDmg,       // ≤ MAX_CRIT_DMG 3.0
  dmgReduce, reflectMul, moveMul, cdMul,
  knockbackMul, shieldBreakMul, armorPen, armorPenPct,
  flags: Record<string, number>;   // 被动钩子
}

interface TargetProfile {
  id, name, hp, maxHp, def, shield, shieldMax,
  element, crystalArmor, mass, takenMul, dmgReduce, reflectMul, dodgeRate, isBoss
}
```

`takenMul` 承载三类语义:`1.0` 正常、`>1` 易伤、`0` **完全免疫**(幽灵泡泡或无敌墙)。

### 3.4 经验 / 救援 / 料理

```ts
interface PlayerProgress { playerId; level; exp; totalExp; maxHp; dmgMul; carrySlots; talentFlags }
interface DownedState { playerId; levelSnapshot; expSnapshot; totalExpSnapshot;
                        equipmentSnapshot; x; y; downedSec; reviveProgress;
                        rescuerId; bubbleStacks; invulnSec; state }
interface FoodBuff { key; sourceItemId; branch; durationSec; remainingSec; stacks; statMods; flags }
```

### 3.5 装备槽与单位

六部位 `ARMOR_SLOTS = ['weapon','armor','helm','boots','relic','cape']`。
所有距离单位「格」、时间单位「秒」、速度「格/秒」、冲量「格/秒」、角度「度」。

---

## 4. 算法与公式

### 4.1 伤害管线八步(严格串行)

```
输入: attacker(CombatantStats), target(TargetProfile), weapon, skill, comboMul, critRoll, dodgeRoll

0a 距离校验:  distance > max(skill.range, weapon.reach) + 1.5 → 落空(return)
0b 闪避判定:  dodgeRoll < min(target.dodgeRate, 0.75) → 闪避(return, 0 伤害)

1  基础      = totalAtk × levelMul × weaponMul × comboMul × skillMul
               其中 levelMul = 1 + 0.03 × (level − 1)
                    weaponMul = weapon?.attackMul ?? 1.0
2  元素后    = 基础 × ELEMENT_COUNTER[atkElement][target.element]
3  有效DEF   = max(0, target.def − flatPen) × (1 − pctPen)
               flatPen = max(weapon.armorPen, skill.armorPen, attacker.armorPen)
               pctPen  = min(0.90, max(0, weapon.armorPenPct, skill.armorPenPct, attacker.armorPenPct))
               —— 破甲语义:同源不叠加,异源取最大 ——
               718 手持(固定 10 / 百分比 15%)与它的 [Q] 陨石星落(固定 10 / 百分比 25%)
               同属「该武器自身提供的破甲」,是同源,故取 max 而非相加;
               相加会得到 40% 穿透,远超单件武器的设计强度并造成穿透溢出。
               attacker.armorPen 由 equipSummary 聚合了当前武器,亦与 weapon.armorPen 同源,
               因此三者一律走 max。异源(如 718 + 204 爆破镐,两件不同武器的武器级破甲)
               同样取 max 而非求和,避免换装叠加刷穿甲。
4  破盾      shieldBreakMul = max(weapon.shieldBreakMul, skill.shieldBreakMul, attacker.shieldBreakMul)
               crystalMul = (target.crystalArmor && shieldBreakMul < 3.0) ? 0.20 : 1.0
               preShield = 元素后 × crystalMul
               若 target.shield > 0:
                  shieldDamage = preShield × shieldBreakMul
                  若 shieldDamage ≥ shield: 破盾,carry = (shieldDamage − shield) / shieldBreakMul
                  否则 carry = 0(HP 完全免伤)
               否则 carry = preShield
5  暴击后    = carry × critMul
               critRate = min(1.0, max(0, attacker.critRate + skill.critBonus))
               critMul  = (critRoll < critRate) ? min(attacker.critDmg, 3.0) : 1.0
6  减伤后    = 暴击后 × armorMul × (1 − target.dmgReduce) × externalMul × target.takenMul
               armorMul = ARMOR_K / (ARMOR_K + 有效DEF),ARMOR_K = 120
               参照:有效DEF = K 时 armorMul = 0.5;有效DEF → ∞ 时趋近 0 但恒 > 0
               钳制:target.takenMul = 0 → 0;护盾未破 → 0;否则 = max(1, round(上式))
7  反伤      = round(实际承伤 × target.reflectMul),作用半径 3 格
               728 反伤甲 reflectMul = 1.50
8  击退冲量  = (weapon.knockback × attacker.knockbackMul × skill.knockbackMul)
              ÷ max(target.mass, 0.1)
```

**复杂度**:每步 O(1),整条管线 O(1);单次结算无循环、无分配(仅 8 元素 `steps` 数组,一次性预分配)。

### 4.2 元素克制矩阵

四元环 1.5 克制 / 0.75 逆克 / 0.5 同抗,笔误为 1.0:

```
FIRE → ICE → LIGHTNING → SLIME → FIRE
LIGHT → SLIME(1.5),LIGHT → LIGHT(0.5)
NONE 对所有属性 = 1.0
```

### 4.3 经验共享

```
owner = 击杀点;R = 24 格

eligible = |{ p : p.distance ≤ R 且 !p.afk }|
partyMul = eligible ≥ 3 ? 1.25 : 1.00
cap      = baseExp × 5.0

对每个 p:
  若 distance > R: share = 0
  否则:
    afkMul   = p.afk ? 0.3 : 1.0
    levelMul = p.level > mobLevel ? max(0.10, 1 − 0.10 × (p.level − mobLevel)) : 1.0
    bonusMul = p.expBonusMul × (p.hasDreamTalent ? 1.20 : 1.0)
    raw      = baseExp × partyMul × afkMul × levelMul × bonusMul

rawTotal = Σ raw
若 rawTotal > cap: scale = cap / rawTotal,share = floor(raw × scale),
                   余数逐个补给前若干名,使 Σ share 恰好 = floor(cap)
否则 share = round(raw)
```

**去重**:`KillLedger.claim(mobInstanceId)` 是唯一入口;同一怪实例第二次结算直接返回
`deduped: true, total: 0`,不产生任何发放条目。

**防刷依据**:3 人满编欢聚的总额 = 1.25 × 3 = 3.75 倍,闸门取 5.0 倍留 33% 余量不误伤正常组队;
8 人同屏理论总额 10 倍,被压回 5 倍后人均反而低于 3 人队,构成负向激励。

### 4.4 幽灵泡泡状态机

```
HP 归零 → createDowned(冻结 level/exp/totalExp/equipment 四份快照)
       → state = GHOST_BUBBLE
期间: takenMul = 0(免伤)、moveMul = 0、canAttack = false、canBeHealed = false
      tickGhostBubble: y += sin(t × 1.4) × 0.6 × dt(仅表现层漂浮)

出口 A 触摸: distance ≤ 0.9 且累计 dt ≥ 1.0 × reviveTimeMul
             → HP = maxHp × (0.5 + reviveHpRatioBonus),invuln 0.5s
出口 B 羽毛笔 733: distance ≤ 6 → HP = maxHp(满血),invuln 3.0s
出口 C 复活旗 435: distance ≤ 3 且累计 dt ≥ 2.0 → HP = maxHp × 0.5
出口 D 227 泡泡水枪: 连中 3 发 → state = BUBBLED,困人 5 秒(不复活)
```

三个出口共用同一份快照还原路径,**从不写回** `level` / `exp` / `equipment`,
故「零掉级零爆装」是结构性保证,而非依赖调用方自觉。

### 4.5 恶作剧锅判定

```
第 1 步:fireOut ? 出锅失败
第 2 步:按 PRANK_PRIORITY = [607,608,609,610,611] 顺序扫描,
       首个 prankTrigger 被投料满足者胜出 → 改判整蛊料理
       · 607 ← 126 × 2(爆裂火椒)
       · 608 ← 127 × 1(幻彩变身菇)
       · 609 ← 119 × 2(云朵棉花)
       · 610 ← 125 × 2(滑溜香蕉)
       · 611 ← 124 × 3(弹簧跳跳菇)
第 3 步:未命中整蛊时校验正常配方 {104:1, 124:2, 121:2} → 604
第 4 步:shovelUsed 时追加 1 条战斗词条;chefHat 时时长 ×2
```

**优先级而非投料顺序**:保证多人同时投料、客户端上报顺序不确定时结果仍可复现。

---

## 5. 参数配表

### 5.1 武器(711~723 与 204)

| ID | 名称 | 类型 | ATK | 武器倍率 | 攻速 | 击退 | 击退倍率 | 元素 | 破盾 | [Q] 倍率 | CD |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- | ---: | ---: | ---: |
| 711 | 初心冒险者木剑 | 轻剑 | 12 | 1.00 | 1.10 | 3.0 | 1.0 | NONE | 1.0 | 1.4 | 6 |
| 712 | 寒铁骑士阔剑 | 重剑 | 28 | 1.25 | 0.80 | 4.5 | 1.2 | NONE | 1.5 | 2.2 | 9 |
| 713 | 黑曜石烈焰巨剑 | 重剑 | 48 | 1.35 | 0.75 | 5.0 | 1.3 | FIRE | 1.5 | 2.6 | 10 |
| 714 | 秘银疾风双刃 | 双刀 | 38 | 1.10 | 1.60 | 2.5 | 1.0 | NONE | 1.2 | 1.8 | 7 |
| 715 | 翠玉青竹连珠弓 | 猎弓 | 18 | 1.00 | 0.90 | 2.0 | 0.8 | NONE | 0.8 | 0.8×3 | 5 |
| 716 | 秘银追星神弓 | 猎弓 | 42 | 1.15 | 0.85 | 2.5 | 0.9 | LIGHT | 1.0 | 0.55×6 | 14 |
| 717 | 晨露新芽魔杖 | 法杖 | 20 | 1.00 | 1.00 | 1.5 | 0.6 | LIGHT | 1.0 | 治疗 60 | 12 |
| 718 | 极光星辰魔导师杖 | 法杖 | 52 | 1.20 | 0.70 | 3.0 | 1.0 | LIGHT | 1.4 | 4.0 | 18 |
| 719 | 果冻王弹跳皇冠锤 | 重锤 | 40 | 1.40 | 0.70 | 6.0 | **3.0** | SLIME | 2.0 | 3.0 | 16 |
| 720 | 绯月落英吹雪扇 | 法器 | 46 | 1.15 | 1.00 | 2.0 | 0.8 | LIGHT | 1.0 | 护盾 25% | 20 |
| 721 | 深渊紫晶破城盾锤 | 盾武 | 45 | 1.30 | 0.70 | 4.0 | 1.2 | NONE | 1.8 | 反弹 100% | 12 |
| 722 | 法老流沙毒刺枪 | 长枪 | 50 | 1.25 | 0.90 | 3.5 | 1.0 | NONE | 1.6 | 0.6×5 | 14 |
| 723 | 克洛诺斯磁暴齿轮炮 | 重炮 | 65 | 1.50 | 0.65 | 4.0 | 1.1 | LIGHTNING | 2.0 | 0.8 | 22 |
| 204 | 黑金爆破冲击镐 | 工具 | 35 | 1.10 | 0.80 | 3.5 | 1.0 | NONE | **4.0** | 1.6 | 6 |

### 5.2 护甲 / 饰品 / 消耗品

| ID | 名称 | 槽位 | HP | DEF | 闪避 | 减伤 | 反伤 | 其它 |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| 724 | 森之游侠软皮甲 | armor | +40 | +8 | +10% | — | — | 翻滚 CD ×0.8 |
| 725 | 寒铁重装骑士甲 | armor | +100 | +22 | — | — | — | 硬直 ×0.5,移速 ×0.95 |
| 726 | 秘银星辉魔导袍 | armor | +60 | +14 | — | — | — | 冷却 ×0.75,治疗范围 ×1.5 |
| 727 | 果冻王Q弹软糖甲 | armor | +120 | +18 | — | — | — | 近战弹飞 4 格 |
| **728** | **紫晶荆棘反伤甲** | armor | +160 | +32 | — | **30%** | **150%** | 反伤半径 3 格 |
| 729 | 夜影吸血蝙蝠斗篷 | cape | — | — | — | — | — | 移速 +10%,每击回 3 HP |
| 730 | 疾风二段跳羽戒 | relic | — | — | +3% | — | — | 空中二段跳 |
| 731 | 同伴共鸣友爱徽章 | relic | — | — | — | — | — | 8 格内每队友 +5%,上限 +40% |
| 630 | 自定义像素印花披风 | cape | — | +8 | — | — | — | UGC 图案 |
| 732 | 甜莓瞬回生命药水 | 消耗品 | 瞬回 100 | — | — | — | — | CD 8s,溅射 2 格 / 50 HP |
| 733 | 复苏天使羽毛笔 | 消耗品 | 满血复活 | — | — | — | — | 6 格,3 秒无敌,CD 12s |

### 5.3 天赋(5/10/15/20/25/30 级)

| ID | 名称 | 解锁 | 可断言数值 |
| :--- | :--- | ---: | :--- |
| `talent_roll_bomb` | 翻滚·残影炸弹 | 5 | 伤害 40% 攻击、残影 2.0s、半径 1.5 格、翻滚 CD ×0.80 |
| `talent_throw_master` | 大力士·投掷精通 | 10 | 投掷伤害 ×2.00、距离 +1 格、初速 ×1.10、叠罗汉减速 −10% |
| `talent_rescue_swift` | 急救快手 | 15 | 救援时间 ×0.50、复活血量 +10%(50%→60%)、判定半径 +0.5 格 |
| `talent_crit_master` | 暴击大师 | 20 | 暴击率 +8%、爆伤 +25% |
| `talent_element_affinity` | 元素亲和 | 25 | 克制 1.5→1.875、逆克 0.75→0.375 |
| `talent_dream_revelation` | 梦境启示 | 30 | 经验 +20%、打盹 0.3→0.45、露水速率 ×1.5 |

### 5.4 经验共享与救援常数

| 参数 | 值 | 出处 |
| :--- | ---: | :--- |
| `SHARE_RADIUS` | 24 格 | entities §共享 |
| `PARTY_BONUS_THRESHOLD` / `PARTY_BONUS` | 3 / 0.25 | entities |
| `AFK_EXP_RATIO` | 0.3 | entities |
| `PER_MOB_EXP_CAP_MULT` | 5.0 | 本模块防刷设计 |
| `LEVEL_GAP_STEP` / `LEVEL_GAP_MIN` | 0.10 / 0.10 | 本模块等级压制 |
| `REVIVE_TIME` / `REVIVE_HP_RATIO` | 1.0s / 0.5 | entities |
| `TOUCH_RADIUS` | 0.9 格 | 本模块 |
| `FEATHER_RANGE` / `FEATHER_INVULN` | 6 格 / 3.0s | entities |
| `FLAG_REVIVE_TIME` / `FLAG_REVIVE_RADIUS` | 2.0s / 3.0 格 | 435 复活旗 |
| `BUBBLE_GUN_SHOTS` / `BUBBLE_TRAP_SEC` | 3 发 / 5.0s | 227 泡泡水枪 |
| `ARMOR_K` | 120 | 护甲递减曲线 |
| `CRYSTAL_ARMOR_MUL` / `CRYSTAL_BREAK_THRESHOLD` | 0.20 / 3.0 | 晶甲机制 |
| `MAX_DODGE_RATE` / `MAX_CRIT_DMG` | 0.75 / 3.0 | 上限封顶 |
| `MIN_DAMAGE` | 1 | 最低伤害保底 |
| `REBIRTH_DEW_COST` | 5 露水 | 533 魔镜洗练 |

### 5.5 料理(601~615)

| ID | 名称 | 站 | 时长 | 关键效果 |
| :--- | :--- | ---: | ---: | :--- |
| 601 | 暖心甜莓果茶 | 506 | 600s | 回 40 HP,移速 +15% |
| 602 | 黄金麦香厚吐司 | 508 | 600s | HP +30,采集 +20% |
| 603 | 绯樱蜜桃果酱派 | 508 | 600s | 暴击 +15%,35% 掉落翻倍 |
| 604 | 星光萤火蘑菇汤 | 506 | 600s | 夜光,跳跃 +50%,免跌落眩晕 |
| 605 | 大力水手海鲜烩 | 506 | 600s | 近战 +25%,举投不减速,投距 +3 |
| 606 | 龙息爆辣烤肉排 | 508 | 900s | 每击 +15 灼烧,免冰冻 |
| 607 | 喷火彩虹屁咖喱 | 506 | 300s | 攻击 +25%,每三步冲刺 2 格 |
| 608 | 小肥鸡咯咯浓汤 | 506 | 60s | 全员变鸡 |
| 609 | 气球肚皮漂浮饮 | 506 | 240s | 重力 ×0.30 |
| 610 | 滑溜溜溜冰奶昔 | 506 | 240s | μ = 0.96 |
| 611 | 大嗓门回声果冻 | 506 | 300s | 文字放大 ×2.0,八音盒音效 |
| 612 | 冰爽薄荷净化饮 | 505 | 即时 | 回 80 HP,净化全部整蛊 |
| 613 | 庆典三层奶油蛋糕 | 508 | 1200s | 8 人分食,经验 +30% |
| 614 | 森林百果驯兽饼干 | 508 | 即时 | 直接驯化 |
| 615 | 森灵最爱彩虹糖 | 505 | 1800s | 森灵效率 ×2.0 |

---

## 6. 帧预算 / 性能

20Hz 高频帧(`DT = 0.05s`),1GB 内存约束下的上界估算:

| 路径 | 每帧次数(8 人房 + 40 怪) | 单次开销 | 每帧合计 |
| :--- | ---: | :--- | :--- |
| `computeDamage` 普攻 | ≤ 8 次 | O(1),约 8 元素数组 + 12 数字运算,无分配 | < 0.02 ms |
| `computeDamage` 技能(箭雨/流沙 6 段) | ≤ 8 × 6 = 48 次 | O(1) | < 0.12 ms |
| `tickDot` | ≤ 40 条 | O(1) | < 0.01 ms |
| `tickGhostBubble` | ≤ 8 个泡泡 | O(1) | < 0.005 ms |
| `tickInvuln` | ≤ 8 | O(1) | < 0.005 ms |
| `tickFoodBuff` | ≤ 8 × 3 buff | O(1) | < 0.005 ms |
| `settleMobExp` | 仅击杀帧触发,≤ 2Hz | O(P),P = 参与人数 ≤ 8 | 忽略 |

**内存**:`WEAPONS`(13) + `ARMORS`(9) + `FOODS`(15) + `COMBAT_ITEM_INDEX`(45)
四张表为模块级常量,合计 < 40 KB;`KillLedger` 的 `Set<string>` 按房间会话生命周期,
单房每分钟击杀 ≤ 300 时约 12 KB,断线重连时随会话重建。

**不分配热路径**:`computeDamage` 是纯函数,不改写 `target` 也不改写入参 `attacker`;
调用方用 `applyDamage` 拿到新对象,便于网络层做快照 diff。

---

## 7. 异常与边界

| 场景 | 处理 |
| :--- | :--- |
| 空投料 / 投料不足 | `cookSoup` 返回 `ok: false`,产出 0、buff `null`,附可读 `reason` |
| 炉火被浇灭 | `fireOut: true` → 出锅失败,不消耗也不产出 |
| 破甲超过目标防御 | 有效 DEF 钳制为 `0`,不允许负数反向放大伤害 |
| DEF 极高 | 护甲系数趋近 0 但恒 > 0;最终伤害保底 `MIN_DAMAGE = 1` |
| `takenMul = 0` | 完全免疫:幽灵泡泡、无敌墙、活动期间和平区 |
| 护盾未破 | HP 完全免伤(`finalDamage = 0`),飘字染色为护盾蓝 |
| 闪避率超过 0.75 | `Math.min(..., MAX_DODGE_RATE)` 硬封顶 |
| 暴击率 / 爆伤溢出 | 分别封顶 1.0 / 3.0 |
| 超距攻击 | 超过 `reach + 1.5` 容差 → `outOfReach`,0 伤害 |
| 同一怪重复结算 | `KillLedger` 拒绝,`deduped: true` |
| 总额超限 | 等比缩放 + 余数补齐,`Σ share` 恰好 = `floor(cap)`,绝不越界 |
| 满级后继续获得经验 | `level` 停在 30,`gained = 0`,`overflow` 记账供 UI 提示 |
| 打盹者不参与阈值 | 阈值只数「24 格内且非打盹」的玩家 |
| 救援中途离开 | `reviveProgress` 归零(设计上不跨帧留存) |
| 羽毛笔超距 | 复活失败并返回 `reason`,道具由调用方决定是否退还 |
| 并发投料顺序不定 | 整蛊判定用固定优先级表,与上报顺序无关 |
| 断线重连 | `DownedState` 与 `PlayerProgress` 均为可序列化纯数据;`invulnSec` 由服务端权威倒计时 |
| 非法物品 ID | `equipSummary` 忽略未知 ID 不抛错,便于客户端预览 |

---

## 8. 与其它子系统的耦合点

| 对接方 | 耦合内容 | 方向 |
| :--- | :--- | :--- |
| **WS-01** 地形网格 | 无直接耦合;环境伤害走 `DamageSource.ENVIRONMENT` | 单向 |
| **WS-02** 会话/同步 | `DamageResult` / `ReviveResult` / `ShareResult` 为同步载荷 | 输出 |
| **WS-03** 物理状态机 | `knockbackImpulse` 交给 `integrateHorizontal` 作 `F_impulse`;`mass` 取自 `MASS_*` | 双向 |
| **WS-03** 状态机 | 写入 `BodyState.GHOST_BUBBLE` / `BUBBLED`;`ghostControl().moveMul` 抑制位移 | 输出 |
| **WS-04** 背包 | 六部位槽位、`COMBAT_ITEM_INDEX` 45 项、物品消耗(732/733) | 双向 |
| **WS-05** 炼金炉 | 消费 `RolledStats` / `RarityTier`;洗练(533)与炼金共用梦境露水 130 经济 | 输入 |
| **WS-07** 状态机 buff 槽 | `FoodBuff` 的 `statMods` 与 `flags`;`mergeFoodBuffs` 定义多 buff 叠加规则 | 输出 |
| **WS-08** Boss 战 | `bossScaledHp` 血量缩放;8 件祭品 734~741 ↔ `BOSS_LIST.summonItem` | 双向 |
| **WS-09** 怪物 AI | `MobDef.hp/exp/drops`;`settleMobExp` 消费 `exp`;晶甲怪用 `crystalArmor` | 输入 |
| **WS-11** 表现层 | `FloatSpec`(文本/颜色/字号)、`planSkillHits`(结算帧偏移)、地面预警几何 | 输出 |
| **WS-13** 日志/回放 | `DamageResult.steps[]` 八步明细可原样落盘重放 | 输出 |

**跨表一致性硬约束**:祭品 ID 必须在 `COMBAT_ITEM_INDEX` 与 `BOSS_LIST.summonItem` 同时命中,
由测试「734-741 八件祭品与 bosses.ts 的 summonItem 一一对应」守卫;冻结层若增删 Boss,该断言会立即失败。

---

## 9. 验收用例

`tests/WS-10.test.ts` 共 **43 个 test 块 / 496 处断言调用**,全部经 `mulberry32(0x5eed10)` 注入随机:

| # | 用例 | 关键断言 |
| ---: | :--- | :--- |
| 1 | 701-745 全量索引 | 45 项无缺号 |
| 2 | 13 件武器数值与技能 | 名称/攻/倍率/技能键/被动齐全 |
| 3 | 204 与 222 常数 | 破盾 4.0、击退 8.0 |
| 4 | 728 / 733 / 732 数值 | 减伤 30%、反伤 150%、复活 6 格 3 秒 |
| 5 | 管线 1 基础 | 裸装 10,711 得 22 |
| 6 | 管线 2 元素 | 四元环 1.5 闭环、同抗 0.5 |
| 7 | 管线 3 破甲 | (80−12) 与 (80−10)×0.75 = 52.5 |
| 8 | 管线 4 破盾 | 204 一击破盾、溢出折算、未破免疫 |
| 9 | 管线 5 暴击 | 0.07 边界上下沿、爆伤封顶 3.0 |
| 10 | 管线 6 减伤 | DEF=K → 0.5、递减、保底 1 |
| 11 | 管线 7 反伤 | 728 承伤 ×0.70、反伤 = 承伤 ×1.5 |
| 12 | 管线 8 击退 | 18 vs 0.9 格/秒(质量 1 vs 20) |
| 13 | 八步链路 | 顺序固定、共 8 步 |
| 14 | 闪避/超距短路 | 0 伤害、飘字「闪避」 |
| 15 | 随机可复现 | 2000 次采样 5%~10%、同种子同序列 |
| 16 | 飘字规则 | 白/金/蓝/免疫四色 |
| 17 | 纯函数结算 | 原对象不变、击倒判定 |
| 18 | DoT 灼烧 | 15/s × 4s = 60 |
| 19 | 技能参数 | 713 火浪 6 格、716 箭雨 3s/6 段、718 预警 1s、723 冻结 3s |
| 20 | 升级曲线 | Lv.1→30 累计 449500、29 次升级、Lv.30 HP 535 |
| 21 | 天赋解锁 | 6 条 × 逐级边界 + 12 项数值 |
| 22 | 24 格内外 | 23.9 得 100%、24.1 得 0、不分补刀 |
| 23 | 3 人阈值 | 2 人 200、3 人 250 |
| 24 | 打盹 0.3× | 38 vs 125、单人 1000→300 |
| 25 | 去重 + 8 人上限 | 二次结算 0、1000→500 且 Σ = 500 |
| 26 | 等级压制/增益/写档 | 高 5 级 0.5、蛋糕 1300、升到 Lv.4 |
| 27 | 533 洗练 | 5 露水、14 池、8 个分档边界 |
| 28 | 套装与徽章 | 719+727 ×1.08/×1.05、光环 +40% 封顶 |
| 29 | Boss 级防刷 | 2500 → 实发恰好 12500、人均 1563/1562 |
| 30 | 幽灵泡泡零掉级零爆装 | 等级/经验/装备栏逐格比对无差异 |
| 31 | 泡泡期间免伤 | `takenMul = 0`、moveMul 0、不能攻击 |
| 32 | 1 秒半血复活 | 0.95s 未完成 / 1.00s 完成 / 118 HP |
| 33 | 227 三发困人 | 3 发 BUBBLED 5 秒、灭火 2 格 |
| 34 | 733 六格满血无敌 | 6.1 格失败、6.0 格成功、满血 385、3 秒倒计时 |
| 35 | 435 复活旗 | 2 秒读条、3 格半径、半血 268 |
| 36 | 601-615 全量 | 15 项效果与时长逐条 |
| 37 | 恶作剧锅双分支 | 正常 → 604,偷塞 127 → 608 |
| 38 | 五种整蛊料理 | 607/609/610/611 投料与时长 |
| 39 | 失败分支 | 火灭 / 空投料 / 投料不足 |
| 40 | 212 大铁铲 | 灭火 + 1 条词条、626 时长翻倍 |
| 41 | buff 计时/合并/净化 | 500s 剩余、乘区相乘、612 只留正常料理 |
| 42 | 祭品闭合 | 8 件祭品 ↔ `BOSS_LIST` |
| 43 | 目标档案 | `targetFromStats` 字段与护盾比例 |

**跑法**

```
node scripts/verify.ts --only WS-10
node tests/WS-10.test.ts          # 43/43 通过
```

---

## 10. 未决问题

1. ~~**`PER_MOB_EXP_CAP_MULT` 取值 5.0 待 Lead 裁决**~~ —— **已裁决(Lead 已采纳):维持 5.0**。
   理由:3 人满编欢聚总额 = 1.25 × 3 = 3.75 倍,若取 4.0 会让 4 人队恰好触闸,体验上易被误解为 Bug;
   取 5.0 留 33% 余量不误伤正常组队,而 8 人同屏(理论 10 倍)被压回 5 倍后人均低于 3 人队,防刷激励成立。
2. **等级压制是否应同时向上补偿**:现行只对「高于怪物」做 −10%/级压制,低于怪物无加成。
   是否引入「越级击杀 +X%」属平衡问题,需数值组定夺。
3. **`attackMul` 与 `atk` 的双通道语义**:同一件武器既有面板 `atk` 又有 `attackMul`,
   两者都在管线第 1 步相乘。若后续引入装备强化(+atk 词条),需明确强化走 `atk` 加区
   还是独立乘区,否则高倍率武器会二次放大强化收益。
4. **反伤是否吃减伤**:现行 728 反伤按「实际承伤」的 150% 计算(即已在受击方减伤之后),
   攻击者若有反伤减免词条是否能再减一层,冻结层未规定,暂按不再减处理。
5. **幽灵泡泡自动消解**:当前幽灵泡泡无限期存在,只能靠队友救援。
   是否加入「90 秒未被救援自动传回 501 篝火茶座」的超时保底,需与 WS-02 会话层共同确认。
6. **`tickGhostBubble` 的漂移轨迹**:目前用纯正弦模拟漂浮,属表现层近似;
   若要接真实风场(WS-03),需把 `y += sin(...)` 替换为风场采样,接口签名不变。
7. **恶作剧锅的配方扩展**:`PRANK_PRIORITY` 是硬编码 5 条。若后续允许 AI 炼金产物投入汤锅,
   需要一套「动态整蛊条目」注册机制,本条留待 WS-05 与 Lead 联合裁决。
8. **626 金牌大厨高高帽的翻倍叠加**:当前 `chefHat` 仅 ×2 一次。若多人同时戴帽,
   是否允许 ×4(或取最大值而非连乘)未定。
9. **`MAX_REACH_TOLERANCE = 1.5` 容差**:为吸收网络抖动所设。
   若 WS-02 改用客户端预测 + 服务端回滚校验,该容差可收紧至 0.5,需联合实测。

---

## 11. task-70:W1 钳制与 `maxHp` 逐玩家派生(契约 §2.1 / §2.4 / §2.4.1)

> 契约唯一依据:`docs/US2-GATEWAY-CONTRACT.md`。本节只记录**落实与实测**,口径以契约为准。

### 11.1 修的是什么

```
W1  hp > maxHp      —— 复活/读档后血量超过上限
W2  hp = NaN        —— revive(id, NaN) ⇒ **所有后续比较恒 false**(比负血更危险)
W3  maxHp 被共享    —— VitalsSystem.maxHp 是**构造器参数**,所有玩家同一个值
                       ⇒ 「按等级各自派生」装不进去
```

修前实测(`VitalsSystem` 裸实例):
```
revive('p1', 535) ⇒ hp=535  而 maxHp=100    ★ W1 本体
revive('p1', -5)  ⇒ hp=-5                  ★ 负血
revive('p1', NaN) ⇒ hp=NaN                 ★ W2
register('p1') / register('p2') ⇒ 两者 maxHp **同值**  ★ W3
```

### 11.2 两处实现(全在 `server/src/combat/vitals.ts`)

**① `revive()` —— W1 钳制,契约指定的唯一选址**
```ts
const want = hp ?? v.maxHp;
const safe = Number.isFinite(want) ? want : v.maxHp;
v.hp = Math.min(v.maxHp, Math.max(0, safe));
```
★ **两个独立机制,不可合并**:
```
甲  Number.isFinite(want) ? want : v.maxHp   →  堵 NaN(W2)
乙  Math.max(0, safe)                        →  管负值落点
```
合并成 `Math.max(0, hp ?? v.maxHp)` 会让 NaN **原样穿过**(`Math.max` 遇 NaN 传播)。
真不变量是 `0 ≤ hp ≤ maxHp`。

**② 新增 `syncMaxHp(id, derivedMaxHp): boolean` —— W3 的正解**
```
· 是**唯一**写 v.maxHp 的入口,逐玩家生效(不碰构造器常量)
· hp 取舍策略 **C:只改上限,hp 绝对值不变**,且**收在函数内部**(不散到调用方)
  ⇒ 理由:C 是唯一**不给玩家凭空回血**的选项
  ⇒ 日后裁决改为 A(补满差额)/B(同比例)只需动这一处
· **必须钳 hp**:`if (v.hp > next) v.hp = next`
  ⇒ 否则**降级**会再造出 hp>maxHp,即 W1 的镜像,而且由本函数亲手制造
· **不 import progression**:派生值由**调用方**传入
  ⇒ 若这里自己查 `statsAtLevel`,vitals 就成了**第二个等级权威**,与契约 §1 冲突
· 拒绝不可信派生值:`!Number.isFinite(derivedMaxHp) ⇒ return false`(不写入)
  ⇒ NaN 上限会让 `hp <= maxHp` 恒 false,比不更新更糟
· 上限地板取 **1**(与 hp 的 0 不同):`maxHp=0` 会让任何 hp 都 `> maxHp`,
  且 `stepTimers` 的 `hp < maxHp` 恒 false ⇒ **回血永久失效**
  ★ 此条**已实测**(不再是推理;手法:内存里把 `syncMaxHp` 地板改成 0 造出 `maxHp=0`):
  ```
  【地板 1】maxHp=1, hp=0(受伤状态)→ 推进 200 帧 ⇒ hp 0 → 1   回血 ✓
  【地板 0】maxHp=0, hp=0(受伤状态)→ 推进 200 帧 ⇒ hp 0 → 0   回血 ✗ 永久失效
  治疗侧:地板 1 heal(50) ⇒ 0→1(返回 1);地板 0 heal(50) ⇒ 0→0(返回 0)
  ```
  ⚠️ 对照时**必须把 hp 置为低于上限**,否则「满血不回血/满血治疗返回 0」是正常行为,
  会得出「两种地板一样」的错误结论(我第一版对照就这么错了)。
```

### 11.3 ★ 下界为什么是 **0** 而不是 1(契约 §2.4.1 的订正)

契约初版写 `Math.max(1, ...)`,理由是「复活后 hp=0 会立刻再次 downed,是死循环入口」。
**那条理由机制错**,三条实测:

```
① revive(0) 后 hp=0 downed=false;推进 400 帧后 hp 被 regen 抬到 **20** ⇒ 不自动倒
   真正置 downed 的只有「**被**打到 0」那一处(vitals.ts 的 applyHit);
   revive() 自己置 downed=false 且**不检查 hp** ⇒ 走不到那个分支
② hp=0 起手 → 一拳: applied=6 hp=0 downed=true
   hp=1 起手 → 一拳: applied=6 hp=0 downed=true    ← **逐字段完全相同**
   ⇒ 下界 1 达成不了它声明的目的(一级生物一拳 6 点,1 血和 0 血都是一拳倒)
③ REVIVE_HP_RATIO = 0.5 ⇒ 复活路径传进来的 hpAfter 最小值是 **50**
   ⇒ 下界在复活语义下**从未被触发过**
```
⇒ 下界 1 的唯一真实效果是**改掉读档语义**:`importVitals`(`world_sim.ts`)把 hp 钳到
`[0, maxHp]` 后交给 `revive`,于是存档里的 0 HP 被悄悄改成 1
⇒ 实测打破 `WS-FND-02` C22「0 HP 保留」。
⇒ 故取 **0**:与读档语义一致,且不伤任何东西。

★ 由此**撤销了 Y 方案**(给 `revive` 加 `floor` 参数):
Y 的前提是「复活与读档两种语义都落到地板」,但实测复活路径落不到 ⇒ 参数多余。

### 11.4 行为变更登记(契约要求显式登记)

```
revive(id, 0)   旧: 0(未钳制)   新: 0(与读档一致;初版曾拟为 1,已订正回 0)
revive(id, -5)  旧: -5          新: 0
revive(id, NaN) 旧: NaN         新: maxHp          ★ 这是真正的修复
revive(id, 535) 旧: 535         新: maxHp          ★ W1 本体
revive(id)      旧: 满血         新: 满血(对照:0 是**下界**,不是**默认值**)
```

### 11.5 验收实测(`node tests/WS-10.test.ts` ⇒ 102/102)

| 契约 §9 | 断言 | 实测 |
| :--- | :--- | :--- |
| 1 | `task70-1` 升 Lv.30 ⇒ `maxHp == 535` | 100 → 535,hp 不变(策略 C) |
| 2 | `task70-2` 降级 ⇒ hp 被钳 | 535 → 100,`hp <= maxHp` |
| 3 | `task70-3` ★★ 同实例两个等级各自正确 | p1=535 且 p2=100,且**两者不同** |
| 7 | `task70-7` `revive(535) ⇒ 100` | ✓ |
| 8 | `task70-8` `revive(NaN) ⇒ maxHp` | ✓ 有限值 |
| 9 | `task70-9/10` `revive(-5) ⇒ 0` | ✓ |
| 10 | `task70-9/10` `revive(0) ⇒ 0` | ✓ 与读档一致 |
| 10b | `task70-10b` 读档 0 HP 忠实保留 | ✓(同址复验 WS-FND-02 C22) |
| — | `task70-附` `syncMaxHp` 拒绝/幂等/上限地板 | ✓ 见 §11.2 |

★ **§9-3 是本组最容易被漏掉的一条**:不写「同一实例两个不同等级玩家」这个反例,
等于**没测到根因** —— 只测单玩家时,「共享常量」与「逐玩家派生」表现**完全相同**。

★ **§9-10b 的作用**:下界改回 1 时 `WS-FND-02` C22 会红,但那个套件不在 WS-10 里。
在此**同址复验**,让「改回 1」在 WS-10 里也立刻可见 —— 防的是本仓
「写对了但没人引用的规则」那一类缺陷。

### 11.6 故障注入验证有牙(8 个突变,全部被抓到)

判据:**把断言声称守护的实现改回错误行为 ⇒ 断言必须红**。绿 = 覆盖证据的赝品。

| 突变 | 结果 |
| :--- | :--- |
| M1 下界 0 → 1 | `task70-9/10` + `task70-10b` 红 ✓ |
| M2 去掉 `Number.isFinite` | `task70-8` 红 ✓ |
| M3 去掉全部钳制 | `task70-7` 红 ✓ |
| M4 `syncMaxHp` 不钳 hp | `task70-2` 红 ✓ |
| M5 `syncMaxHp` 写成共享 | `task70-3` 红 ✓ |
| M6 不校验派生值 | `task70-附` 红 ✓ |
| M7 恒返回 true | `task70-附` 红 ✓ |
| M8 上限地板 1 → 0 | `task70-附` 红 ✓ |
每个突变只改一处、SHA-256 逐字节还原后恢复 102/102。

### 11.7 跑法

```
node tests/WS-10.test.ts            # 102/102
node tests/WS-FND-02.test.ts        # 65/65(下界 0 的既有契约,订正后恢复)
node scripts/verify.ts --all --strict-reach --strict-taut --strict-inert
```

### 11.8 未决(交契约维护者,本节不裁定)

```
1 策略 A/B/C:A/B 均未实现,仅 C。若玩法裁决为「升级回血」,改 syncMaxHp 一处即可
2 ★★ 接入链**已存在但是断的**(实测,非推断):
   room.ts:1517 syncMaxHpOf() → host.syncMaxHp(playerId, derivedMaxHp)
   而 host 运行时是 `WorldSim`,**WorldSim 上没有 syncMaxHp 方法**
   ⇒ room.ts:1521 的 `typeof host.syncMaxHp !== 'function'` ⇒ **直接 return,静默 no-op**
   实测:`w.syncMaxHp` = undefined;`w.vitals.syncMaxHp` = function
        `host.syncMaxHp('p1', 535)` ⇒ p1.maxHp 仍为 100(未同步)
        直调 `w.vitals.syncMaxHp('p1', 535)` ⇒ 535(功能本身好的,只差一层转发)
   ⇒ 修法需要在 `WorldSim` 上加一个转发方法(或让 room.ts 经世界源取 vitals)。
     **`world_sim.ts` 不在本 doc 的写域**(task-70 写域只有 vitals/revive/progression/
     WS-10 测试/本文档)⇒ 已上报 Lead,由该文件的所有者落实。
   ⇒ ⚠️ 且这是**本仓反复出现的「静默 no-op」形态**:`typeof !== 'function'` 的守卫
     让「方法没接上」与「已同步但值没变」在外部**不可区分**(两者都不抛、都无日志)。
3 上一条意味着 syncMaxHp 的**有效**生产调用当前为 0(房间侧调用打在 undefined 上)。
  接上后应补一条「网关真的每帧/变更时调用它」的断言 —— 否则修复本身又无名
4 上限地板为何是 1(而非 0):见 §11.2;若日后允许「maxHp=0 的合法状态」需重裁
```
