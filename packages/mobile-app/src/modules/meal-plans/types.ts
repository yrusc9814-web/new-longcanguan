import type { SqlValue } from '../../db/types.js';
import type { DinerDto, MealRole, MealRecordItemDto, MealType } from '../meal-records/types.js';

export const MEAL_PLAN_STATUSES = ['UNPLANNED', 'PLANNED', 'COMPLETED', 'CANCELLED'] as const;
export const PLAN_ITEM_TYPES = ['RECIPE', 'STORE', 'CUSTOM'] as const;

export type MealPlanStatus = (typeof MEAL_PLAN_STATUSES)[number];
export type PlanItemType = (typeof PLAN_ITEM_TYPES)[number];

export interface MealPlanRow {
  readonly id: string;
  readonly planDate: string;
  readonly mealType: MealType;
  readonly dinerCount: number;
  readonly status: MealPlanStatus;
  readonly notes: string | null;
  readonly time: string | null;
  readonly title: string | null;
  readonly subtext: string | null;
  readonly icon: string | null;
  readonly version: number;
  readonly completedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MealPlanItemRow {
  readonly id: string;
  readonly mealPlanId: string;
  readonly itemType: PlanItemType;
  readonly mealRole: MealRole | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly customName: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MealPlanItemDto {
  readonly id: string;
  readonly mealPlanId: string;
  readonly itemType: PlanItemType;
  readonly mealRole: MealRole | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly customName: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly recipe: MealRecordItemDto['recipe'];
  readonly store: MealRecordItemDto['store'];
}

export interface MealPlanDto {
  readonly id: string;
  readonly planDate: string;
  readonly mealType: MealType;
  readonly dinerCount: number;
  readonly status: MealPlanStatus;
  readonly notes: string | null;
  readonly time: string | null;
  readonly title: string | null;
  readonly subtext: string | null;
  readonly icon: string | null;
  readonly items: MealPlanItemDto[];
  readonly diners: DinerDto[];
  readonly completedAt: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanItemInput {
  readonly itemType: PlanItemType;
  readonly mealRole: MealRole | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly customName: string | null;
  readonly sortOrder: number;
}

export interface PlanInput {
  readonly planDate: string;
  readonly mealType: MealType;
  readonly dinerCount: number;
  readonly status: MealPlanStatus;
  readonly notes: string | null;
  readonly time: string | null;
  readonly title: string | null;
  readonly subtext: string | null;
  readonly icon: string | null;
  readonly items: readonly PlanItemInput[];
  readonly dinerIds: readonly string[];
}

export interface PlanPatch {
  readonly planDate?: string;
  readonly mealType?: MealType;
  readonly dinerCount?: number;
  readonly status?: MealPlanStatus;
  readonly notes?: string | null;
  readonly time?: string | null;
  readonly title?: string | null;
  readonly subtext?: string | null;
  readonly icon?: string | null;
  readonly items?: readonly PlanItemInput[];
  readonly dinerIds?: readonly string[];
}

export interface SqlQuery {
  query<T>(sql: string, values?: readonly SqlValue[]): Promise<T[]>;
}
