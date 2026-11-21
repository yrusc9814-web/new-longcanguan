import type {
  MealType,
  MealRecordSourceType,
  MealRecordStatus,
  MealPlanStatus,
} from '../types/index.js';

/**
 * 排餐 / 饮食记录 / 菜谱打卡的确定性同步命令载荷。
 *
 * 铁律（T-003b）：命令只需被云端按同一执行顺序重放，不得再次生成主键或业务时间。
 * 因此载荷中出现的 `executedAt`、`mealRecordId`、`itemIds`、`dinerRowIds`、
 * `planUncompleteProof` 等，全部是端侧本次事务真实落库的值。
 *
 * 主线程负责把 `MEAL_SYNC_COMMAND_TYPES` 并入 `SyncCommandType`（`protocol.ts`）
 * 并导出本文件；本文件只描述契约。
 */

export const MEAL_SYNC_COMMAND_TYPES = [
  'PLAN_COMPLETE',
  'PLAN_UNCOMPLETE',
  'RECORD_DELETE',
  'RECIPE_COOK_CHECKIN',
] as const;

export type MealSyncCommandType = (typeof MEAL_SYNC_COMMAND_TYPES)[number];

/** 计划完成/撤销共享的关联记录事实。 */
export interface MealRecordFactPayload {
  readonly id: string;
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly mealType: MealType;
  readonly sourceType: MealRecordSourceType;
  readonly status: MealRecordStatus;
  readonly title: string | null;
  readonly relatedPlanId: string | null;
  readonly sourceMealPlanId: string | null;
  readonly confirmedAt: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 落库的子项主键，按 sortOrder 升序。 */
  readonly itemIds: readonly string[];
  /** MealRecordDiner 行主键，按 dinerIds 顺序。 */
  readonly dinerRowIds: readonly string[];
}

export interface MealPlanFactPayload {
  readonly id: string;
  readonly planDate: string;
  readonly mealType: MealType;
  readonly status: MealPlanStatus;
  readonly dinerCount: number;
  readonly completedAt: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

/** `PLAN_COMPLETE`：计划置 COMPLETED，并创建/复活自动 DRAFT 记录。 */
export interface MealPlanCompletePayload {
  readonly id: string;
  readonly baseVersion: number;
  /** 与本次本地事务相同的服务端时间。 */
  readonly executedAt: string;
  readonly plan: MealPlanFactPayload;
  readonly record: MealRecordFactPayload;
  /** true 表示本次事务新建了记录；false 表示复用/复活既有记录。 */
  readonly recordCreated: boolean;
  readonly recordRevived: boolean;
  readonly inventoryDeductionPromptEnabled: boolean;
}

/** `PLAN_UNCOMPLETE`：计划回到 PLANNED，自动记录软删并写入 provenance。 */
export interface MealPlanUncompletePayload {
  readonly id: string;
  readonly baseVersion: number;
  readonly executedAt: string;
  readonly plan: MealPlanFactPayload;
  readonly removedRecord: {
    readonly id: string;
    readonly version: number;
    readonly deletedAt: string;
    /** 与 `MealRecord.planUncompleteProof` 完全一致的字符串。 */
    readonly planUncompleteProof: string;
  } | null;
}

/** `RECORD_DELETE`：软删记录，并释放/回退关联计划。 */
export interface MealRecordDeletePayload {
  readonly id: string;
  readonly baseVersion: number;
  readonly executedAt: string;
  readonly deletedAt: string;
  /** 删除前指向的来源计划；删除后本列置空。 */
  readonly releasedSourceMealPlanId: string | null;
  readonly revertedPlan: MealPlanFactPayload | null;
}

/** `RECIPE_COOK_CHECKIN`：直接打卡创建的 CONFIRMED 记录（不扣库）。 */
export interface RecipeCookCheckinPayload {
  readonly id: string;
  /** 新建时为 null。 */
  readonly baseVersion: number | null;
  readonly executedAt: string;
  readonly recipeId: string;
  readonly recordDate: string;
  readonly mealType: MealType;
  readonly record: MealRecordFactPayload;
  readonly request: {
    readonly recordTime: string | null;
    readonly title: string | null;
    readonly notes: string | null;
    readonly photos: readonly string[] | null;
    readonly calories: number | null;
    readonly rating: number | null;
    readonly satiety: number | null;
    readonly cost: number | null;
    readonly sourceType: MealRecordSourceType;
    readonly dinerIds: readonly string[];
  };
}
