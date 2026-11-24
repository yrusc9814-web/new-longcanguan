import type { SyncOperation } from '@dafan/shared/sync';

import { COMMAND_HANDLERS } from './sync-replay-commands';
import { deleteEntity, upsertEntity } from './sync-replay-entities';
import {
  ChangeCollector,
  ReplayConflict,
  ReplayValidationError,
  type ReplayResult,
} from './sync-replay-support';

/**
 * 家庭同步的业务重放入口。
 *
 * 调用者（运输层）负责 `storage.transactionSync`、`(clientId, opId)` 幂等去重、
 * `sync_log` 追加与 WS 广播。本模块只做三件事：
 *
 * 1. 按客户端载荷中的确定性主键写入 27 张业务表（upsert / 软删 / 物理删除 + 级联）；
 * 2. 原子重放 7 类命令，复用命令载荷里的 `batchId`、`logId`、`mealRecordId`、
 *    `itemIds`、`dinerRowIds`、`operation.id`、`executedAt`；
 * 3. 冲突抛 `ReplayConflict`（含 `SyncRejection`），失败即让整批事务回滚。
 *
 * 返回的 `changes` 是完整裸 SQLite 行（物理删除为 `null`），并按父表优先排序，
 * 端侧可在同一事务内按序复现。
 */

export { ReplayConflict, ReplayValidationError, migrateReplay } from './sync-replay-support';
export { clearReplayHistory } from './sync-replay-support';
export type { ReplayResult } from './sync-replay-support';

export function replayOperation(sql: SqlStorage, operation: SyncOperation): ReplayResult {
  const changes = new ChangeCollector(sql);
  try {
    switch (operation.kind) {
      case 'upsert':
        return upsertEntity(sql, operation, changes);
      case 'delete':
        return deleteEntity(sql, operation, changes);
      case 'command': {
        const handler = COMMAND_HANDLERS[operation.commandType];
        if (!handler) {
          throw new ReplayValidationError(`未知命令：${String(operation.commandType)}`);
        }
        return handler(sql, operation, operation.payload as Record<string, unknown>, changes);
      }
    }
  } catch (error) {
    // 运输层在批事务回滚后需要原始操作来读取权威聚合行。
    if (error instanceof ReplayConflict && !error.operation) {
      throw new ReplayConflict(error.rejection, error.message, operation);
    }
    throw error;
  }
}

export function isReplayConflict(error: unknown): error is ReplayConflict {
  return error instanceof ReplayConflict;
}
