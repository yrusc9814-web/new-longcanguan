import type { RETAINED_MODELS } from '../contracts/models.js';

export type SyncEntityName = (typeof RETAINED_MODELS)[number];

/** 游标为服务端签发的不透明值。 */
export type SyncCursor = string;

export type SyncValue = null | boolean | number | string | readonly SyncValue[] | SyncPayload;
export type SyncPayload = { readonly [key: string]: SyncValue };

export const SYNC_COMMAND_ENTITIES = {
  INGREDIENT_CONSUME: 'Ingredient',
  INGREDIENT_UPDATE_SYNC_BATCHES: 'Ingredient',
  PLAN_COMPLETE: 'MealPlan',
  PLAN_UNCOMPLETE: 'MealPlan',
  RECORD_DELETE: 'MealRecord',
  RECIPE_COOK_CHECKIN: 'MealRecord',
  SHOPPING_CHECKIN: 'ShoppingList',
} as const satisfies Record<string, SyncEntityName>;

export type SyncCommandType = keyof typeof SYNC_COMMAND_ENTITIES;

export type SyncCommandTarget = {
  [Command in SyncCommandType]: {
    readonly commandType: Command;
    readonly entity: (typeof SYNC_COMMAND_ENTITIES)[Command];
    readonly baseVersion: Command extends 'RECIPE_COOK_CHECKIN' | 'SHOPPING_CHECKIN'
      ? number | null
      : number;
  };
}[SyncCommandType];

interface SyncOperationBase {
  /** 客户端生成的幂等操作 ID。 */
  readonly id: string;
  readonly entity: SyncEntityName;
  readonly entityId: string;
  /** 命令必须提供请求载荷的 SHA-256。旧实体操作可省略。 */
  readonly payloadHash?: string;
}

export type SyncOperation =
  | (SyncOperationBase & {
      readonly kind: 'upsert';
      /** 新建时为 null。 */
      readonly baseVersion: number | null;
      readonly payload: SyncPayload;
    })
  | (SyncOperationBase & {
      readonly kind: 'delete';
      readonly baseVersion: number;
      /** 删除唯一证据；服务端与端侧都以该值判定删除（与本地软删时间一致）。 */
      readonly deletedAt: string;
    })
  | (SyncOperationBase &
      SyncCommandTarget & {
        readonly kind: 'command';
        readonly payload: SyncPayload;
        readonly payloadHash: string;
      });

export interface SyncPushRequest {
  readonly deviceId: string;
  readonly operations: readonly SyncOperation[];
}

export interface SyncRejection {
  readonly operationId: string;
  readonly code: 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';
  readonly serverVersion: number | null;
}

export interface SyncPushResult {
  readonly acceptedOperationIds: readonly string[];
  readonly rejected: readonly SyncRejection[];
}

export interface SyncPullRequest {
  readonly cursor: SyncCursor | null;
  readonly limit?: number;
}

interface SyncChangeBase {
  readonly entity: SyncEntityName;
  readonly entityId: string;
  readonly version: number;
}

export type SyncChange =
  | (SyncChangeBase & { readonly kind: 'upsert'; readonly payload: SyncPayload })
  | (SyncChangeBase & { readonly kind: 'delete'; readonly deletedAt: string });

export interface SyncPullResult {
  readonly changes: readonly SyncChange[];
  readonly nextCursor: SyncCursor | null;
  readonly hasMore: boolean;
}
