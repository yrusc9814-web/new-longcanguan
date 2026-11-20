import type { RETAINED_MODELS } from '../contracts/models.js';

export type SyncEntityName = (typeof RETAINED_MODELS)[number];

/** 游标为服务端签发的不透明值。 */
export type SyncCursor = string;

export type SyncValue = null | boolean | number | string | readonly SyncValue[] | SyncPayload;
export type SyncPayload = { readonly [key: string]: SyncValue };

interface SyncOperationBase {
  /** 客户端生成的幂等操作 ID。 */
  readonly id: string;
  readonly entity: SyncEntityName;
  readonly entityId: string;
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
