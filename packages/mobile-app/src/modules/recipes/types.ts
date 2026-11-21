export const MEAL_TYPES = ['BREAKFAST', 'LUNCH', 'DINNER', 'AFTERNOON_TEA', 'SOUP'] as const;

export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_ROLES = ['MAIN', 'SIDE', 'STAPLE', 'SOUP', 'DRINK'] as const;

export type MealRole = (typeof MEAL_ROLES)[number];

export const QUANTITY_UNITS = [
  'GRAM',
  'KILOGRAM',
  'MILLILITER',
  'LITER',
  'PIECE',
  'BOX',
  'BAG',
  'BOTTLE',
  'CAN',
  'PACK',
  'PORTION',
  'OTHER',
] as const;

export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export const RECIPE_SORT_FIELDS = [
  'name',
  'cookingTimeMinutes',
  'favorite',
  'createdAt',
  'updatedAt',
] as const;

export type RecipeSortField = (typeof RECIPE_SORT_FIELDS)[number];

export interface RecipeIngredientInput {
  readonly ingredientId: string | null;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly amountText: string | null;
  readonly optional: boolean;
  readonly isPrimary: boolean;
}

export interface RecipeStepInput {
  readonly content: string;
  readonly title: string | null;
  readonly timerMinutes: number | null;
  readonly imagePath: string | null;
}

export interface RecipeToolInput {
  readonly toolId: string | null;
  readonly name: string;
  readonly required: boolean;
}

/**
 * 规范化后的写入输入。
 *
 * `category` 用 `undefined` 表示请求未携带该字段：上游 Prisma 在 update 时把
 * `undefined` 视为「不修改」，其余标量字段仍是 PUT 全量替换语义。
 */
export interface RecipeWriteInput {
  readonly name: string;
  readonly category: string | null | undefined;
  readonly imagePath: string | null;
  readonly ingredientsText: string | null;
  readonly cookingTimeMinutes: number | null;
  readonly difficulty: string | null;
  readonly spicyLevel: number | null;
  readonly servings: number | null;
  readonly calories: number | null;
  readonly sourceNote: string | null;
  readonly notes: string | null;
  readonly favorite: boolean;
  readonly enabledForRecommendation: boolean;
  readonly ingredients: readonly RecipeIngredientInput[];
  readonly steps: readonly RecipeStepInput[];
  readonly tools: readonly RecipeToolInput[];
  readonly tags: readonly string[];
  readonly mealTypes: readonly MealType[];
  readonly mealRoles: readonly MealRole[];
}

export interface RecipeListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
  readonly mealType?: MealType;
  readonly difficulty?: string;
  readonly spicyLevel?: number;
  readonly favorite?: boolean;
  readonly tag?: string;
  readonly sortBy: RecipeSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface RecipeRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly imagePath: string | null;
  readonly ingredientsText: string | null;
  readonly cookingTimeMinutes: number | null;
  readonly difficulty: string | null;
  readonly spicyLevel: number | null;
  readonly servings: number | null;
  readonly calories: number | null;
  readonly sourceNote: string | null;
  readonly notes: string | null;
  readonly favorite: number | boolean;
  readonly enabledForRecommendation: number | boolean;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeIngredientRow {
  readonly id: string;
  readonly recipeId: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly amountText: string | null;
  readonly optional: number | boolean;
  readonly isPrimary: number | boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeStepRow {
  readonly id: string;
  readonly recipeId: string;
  readonly stepNo: number;
  readonly content: string;
  readonly title: string | null;
  readonly timerMinutes: number | null;
  readonly imagePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TagRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeTagRow {
  readonly id: string;
  readonly recipeId: string;
  readonly tagId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeMealTypeRow {
  readonly id: string;
  readonly recipeId: string;
  readonly mealType: MealType;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeMealRoleRow {
  readonly id: string;
  readonly recipeId: string;
  readonly mealRole: MealRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KitchenToolRow {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly icon: string | null;
  readonly category: string | null;
  readonly quantity: number;
  readonly status: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeToolRow {
  readonly id: string;
  readonly recipeId: string;
  readonly toolId: string | null;
  readonly toolNameSnapshot: string;
  readonly required: number | boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeIngredientDto {
  readonly id: string;
  readonly recipeId: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly amountText: string | null;
  readonly optional: boolean;
  readonly isPrimary: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeStepDto {
  readonly id: string;
  readonly recipeId: string;
  readonly stepNo: number;
  readonly content: string;
  readonly title: string | null;
  readonly timerMinutes: number | null;
  readonly imagePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeTagDto extends RecipeTagRow {
  readonly tag: TagRow;
}

export interface RecipeToolDto extends Omit<RecipeToolRow, 'required'> {
  readonly required: boolean;
  readonly tool: KitchenToolRow | null;
}

export interface RecipeDto {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly imagePath: string | null;
  readonly ingredientsText: string | null;
  readonly cookingTimeMinutes: number | null;
  readonly difficulty: string | null;
  readonly spicyLevel: number | null;
  readonly servings: number | null;
  readonly calories: number | null;
  readonly sourceNote: string | null;
  readonly notes: string | null;
  readonly favorite: boolean;
  readonly enabledForRecommendation: boolean;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ingredients: RecipeIngredientDto[];
  readonly steps: RecipeStepDto[];
  readonly tags: RecipeTagDto[];
  readonly mealTypes: RecipeMealTypeRow[];
  readonly mealRoles: RecipeMealRoleRow[];
  readonly tools: RecipeToolDto[];
}

export interface RecipeListResult {
  readonly items: RecipeDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

/** 仅包含读取能力的查询对象：`DatabaseClient` 与事务内客户端都满足。 */
export interface SqlQuery {
  query<T>(sql: string, values?: readonly import('../../db/types.js').SqlValue[]): Promise<T[]>;
}
