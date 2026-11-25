/**
 * 世界地标:只存在于地图上的物件(不是物品,进不了背包,拆不掉)。
 *
 * 物品表(`shared/constants/items.ts`)的 obj 编号到 750 为止;地标从 760 起,
 * 与物品号段不相交。它们由世界生成器摆放,客户端按编号画模型。
 */

export const Landmark = {
  /** 远古共鸣祭坛:每个群系深处一座,献上祭品唤醒 Boss */
  ALTAR: 760,
  /** 岔路口的木路标 */
  SIGNPOST: 761,
  /** 营地帐篷 */
  TENT: 762,
  /** 残破石柱(遗迹) */
  PILLAR: 763,
  /** 仙人掌(绿洲) */
  CACTUS: 764,
  /** 棒棒糖树(甜点奇境) */
  LOLLIPOP: 765,
  /** 云团(浮空云海) */
  CLOUD_PUFF: 766,
  /** 钟乳石(溶洞) */
  STALAGMITE: 767,
  /** 水井 */
  WELL: 768,
  /** 干草垛 */
  HAY_BALE: 769,
  /** 鸟居 */
  TORII: 770,
  /** 小木船 */
  BOAT: 771,
  /** 树桩 */
  STUMP: 772,
  /** 花丛 */
  FLOWER_BED: 773,
  /** 灯塔 */
  LIGHTHOUSE: 774,
  /** 石灯笼 */
  STONE_LANTERN: 775,
  /** 巨型齿轮残骸(遗迹) */
  GEAR_WRECK: 776,
  /** 糖果手杖 */
  CANDY_CANE: 777,
} as const;

export type LandmarkId = (typeof Landmark)[keyof typeof Landmark];

export const LANDMARK_ID_MIN = 760;
export const LANDMARK_ID_MAX = 799;

export const LANDMARK_NAME: Readonly<Record<number, string>> = {
  [Landmark.ALTAR]: '远古共鸣祭坛',
  [Landmark.SIGNPOST]: '路标',
  [Landmark.TENT]: '帐篷',
  [Landmark.PILLAR]: '残破石柱',
  [Landmark.CACTUS]: '仙人掌',
  [Landmark.LOLLIPOP]: '棒棒糖树',
  [Landmark.CLOUD_PUFF]: '云团',
  [Landmark.STALAGMITE]: '钟乳石',
  [Landmark.WELL]: '水井',
  [Landmark.HAY_BALE]: '干草垛',
  [Landmark.TORII]: '鸟居',
  [Landmark.BOAT]: '小木船',
  [Landmark.STUMP]: '树桩',
  [Landmark.FLOWER_BED]: '花丛',
  [Landmark.LIGHTHOUSE]: '灯塔',
  [Landmark.STONE_LANTERN]: '石灯笼',
  [Landmark.GEAR_WRECK]: '齿轮残骸',
  [Landmark.CANDY_CANE]: '糖果手杖',
};

/** 这个 obj 编号是不是世界地标。 */
export function isLandmark(obj: number): boolean {
  return obj >= LANDMARK_ID_MIN && obj <= LANDMARK_ID_MAX;
}
