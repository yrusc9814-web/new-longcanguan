import type { MealSyncCommandType, SyncCommandTarget } from '@dafan/shared/sync';

import type { WriteTransaction } from '../../db/database.js';

/**
 * 四类 meals 命令入队桥接。
 *
 * 命令与实体的绑定、`baseVersion` 可空性、`executedAt` 必填校验都由共享
 * `SYNC_COMMAND_ENTITIES` / `SyncCommandTarget` 与发件箱落库边界统一约束，
 * 这里只保留业务侧最常用的入参形状。
 */
export type MealCommandInput = Extract<
  SyncCommandTarget,
  { readonly commandType: MealSyncCommandType }
> & {
  readonly opId: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown>;
};

export async function enqueueMealCommand(
  transaction: WriteTransaction,
  input: MealCommandInput,
): Promise<void> {
  await transaction.enqueue({ ...input, kind: 'command' });
}
