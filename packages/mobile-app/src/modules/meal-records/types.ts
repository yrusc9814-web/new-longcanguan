import type { SqlValue } from '../../db/types.js';

export const MEAL_TYPES = ['BREAKFAST', 'LUNCH', 'DINNER', 'AFTERNOON_TEA', 'SOUP'] as const;
export const MEAL_ROLES = ['MAIN', 'SIDE', 'STAPLE', 'SOUP', 'DRINK'] as const;

export type MealType = (typeof MEAL_TYPES)[number];
export type MealRole = (typeof MEAL_ROLES)[number];
export const RECORD_SOURCE_TYPES = ['HOMEMADE', 'DINE_IN', 'TAKEOUT', 'CUSTOM'] as const;
export const RECORD_ITEM_TYPES = ['RECIPE', 'STORE', 'CUSTOM'] as const;
export const RECORD_STATUSES = ['DRAFT', 'CONFIRMED'] as const;
/** 饱腹度正式档位：与适配器 SATIETY_LEVELS 一致，旧 demo 值 4 不在契约内。 */
export const SATIETY_LEVELS = [3, 5, 7, 8, 10] as const;

export type RecordItemType = (typeof RECORD_ITEM_TYPES)[number];
export type RecordSourceType = (typeof RECORD_SOURCE_TYPES)[number];
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/**
 * 记录内嵌的菜谱/店铺摘要。
 *
 * 上游 `include: { recipe: true, store: true }` 返回完整行；端侧只保留适配器读取的字段，
 * 避免 records 域反向依赖 recipes/stores 的聚合读取（并在 cook-checkin 中形成循环导入）。
 */
export interface EmbeddedRecipe {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly imagePath: string | null;
  readonly calories: number | null;
  readonly version: number;
  readonly deletedAt: string | null;
}

export interface EmbeddedStore {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly supportsDineIn: boolean;
  readonly supportsTakeout: boolean;
  readonly version: number;
  readonly deletedAt: string | null;
}

export interface MealRecordRow {
  readonly id: string;
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly mealType: MealType;
  readonly sourceType: RecordSourceType;
  readonly title: string | null;
  readonly status: RecordStatus;
  readonly imagePath: string | null;
  readonly photosJson: string | null;
  readonly rating: number | null;
  readonly satiety: number | null;
  readonly calories: number | null;
  readonly cost: number | null;
  readonly isNewTry: number | boolean;
  readonly favorite: number | boolean;
  readonly notes: string | null;
  readonly relatedPlanId: string | null;
  readonly sourceMealPlanId: string | null;
  readonly confirmedAt: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly planUncompleteProof: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MealRecordItemRow {
  readonly id: string;
  readonly mealRecordId: string;
  readonly itemType: RecordItemType;
  readonly mealRole: MealRole | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly customName: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MealRecordDinerRow {
  readonly id: string;
  readonly mealRecordId: string;
  readonly dinerId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MealRecordItemDto {
  readonly id: string;
  readonly mealRecordId: string;
  readonly itemType: RecordItemType;
  readonly mealRole: MealRole | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly customName: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly recipe: EmbeddedRecipe | null;
  readonly store: EmbeddedStore | null;
}

export interface DinerDto {
  readonly id: string;
  readonly name: string;
  readonly avatarPath: string | null;
  readonly active: boolean;
  readonly likesText: string | null;
  readonly dislikesText: string | null;
  readonly tabooText: string | null;
  readonly allergyText: string | null;
  readonly portionNote: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MealRecordDto {
  readonly id: string;
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly mealType: MealType;
  readonly sourceType: RecordSourceType;
  readonly title: string | null;
  readonly status: RecordStatus;
  readonly imagePath: string | null;
  readonly photos: string[] | null;
  readonly rating: number | null;
  readonly satiety: number | null;
  readonly calories: number | null;
  readonly cost: number | null;
  readonly isNewTry: boolean;
  readonly favorite: boolean;
  readonly notes: string | null;
  readonly relatedPlanId: string | null;
  readonly sourceMealPlanId: string | null;
  readonly confirmedAt: string | null;
  readonly items: MealRecordItemDto[];
  readonly diners: DinerDto[];
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 仅包含读取能力的查询对象：`DatabaseClient` 与事务内客户端都满足。 */
export interface SqlQuery {
  query<T>(sql: string, values?: readonly SqlValue[]): Promise<T[]>;
}
