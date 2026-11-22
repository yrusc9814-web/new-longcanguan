/**
 * 增量拉取与冲突收敛。
 *
 * 无回声铁律：云端行写入本地业务表时绝不入队 `sync_outbox`；
 * 本地仍有未确认写入的 `(entity, entityId)` 默认跳过远端行，避免覆盖用户新操作，
 * 只有冲突判定要求「对齐权威数据」时才强制覆盖。
 */
import type { SyncPullPage, SyncRowChange } from '@dafan/shared/sync';

import type { DatabaseClient } from '../db/database.js';
import { SyncHttpError } from './http.js';
import type { SyncHttpClient } from './http.js';
import {
  applyRowChanges,
  createColumnCache,
  pendingEntityKeys,
  readSyncState,
  writeSyncState,
  type ColumnCache,
} from './ledger.js';
import type { PushConflict } from './push.js';

export interface PullResult {
  readonly applied: number;
  readonly nextSeq: number;
  readonly hasMore: boolean;
  readonly epoch: number;
}

export interface PullOptions {
  readonly database: DatabaseClient;
  readonly http: SyncHttpClient;
  readonly epoch: number;
  readonly limit?: number;
  readonly cache?: ColumnCache;
  /** 强制覆盖这些实体的本地行（冲突对齐时使用）。 */
  readonly forceKeys?: readonly string[];
  /** 是否跳过本地未确认实体，默认 true。 */
  readonly respectPending?: boolean;
  /** 每页实际写入的行（用于图片下载入队等副作用）。 */
  readonly onApplied?: (changes: readonly SyncRowChange[]) => void;
}

function parsePage(raw: unknown): SyncPullPage {
  if (!raw || typeof raw !== 'object') throw new SyncHttpError(502, 'BAD_RESPONSE', '拉取响应无效');
  const page = raw as Partial<SyncPullPage>;
  if (!Array.isArray(page.entries)) {
    throw new SyncHttpError(502, 'BAD_RESPONSE', '拉取响应缺少 entries');
  }
  const nextSeq = Number(page.nextSeq);
  if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
    throw new SyncHttpError(502, 'BAD_RESPONSE', '拉取响应 nextSeq 无效');
  }
  return {
    epoch: Number(page.epoch),
    entries: page.entries,
    nextSeq,
    hasMore: page.hasMore === true,
  };
}

/** 拉取一页并写入本地；返回本次推进后的序号。 */
export async function pullOnce(options: PullOptions): Promise<PullResult> {
  const state = await readSyncState(options.database);
  return pullFrom(options, state.lastSeq);
}

export async function pullFrom(options: PullOptions, after: number): Promise<PullResult> {
  const page = parsePage(
    await options.http.request(`/api/sync/pull?after=${after}&limit=${options.limit ?? 200}`),
  );
  const cache = options.cache ?? createColumnCache();
  const force = new Set(options.forceKeys ?? []);
  const pending =
    (options.respectPending ?? true)
      ? await pendingEntityKeys(options.database, options.epoch)
      : new Set<string>();

  let applied = 0;
  await options.database.withWriteTransaction(async (tx) => {
    for (const entry of page.entries) {
      const changes = entry.changes.filter((change) => {
        const key = `${String(change.table)}:${String(change.id)}`;
        return force.has(key) || !pending.has(key);
      });
      if (changes.length === 0) continue;
      await applyRowChanges(tx, cache, changes);
      applied += changes.length;
      options.onApplied?.(changes);
    }
    await writeSyncState(tx, page.epoch || options.epoch, page.nextSeq);
  });

  return {
    applied,
    nextSeq: page.nextSeq,
    hasMore: page.hasMore,
    epoch: page.epoch || options.epoch,
  };
}

/** 循环拉取直到追平。 */
export async function pullUntilIdle(options: PullOptions, maxPages = 20): Promise<PullResult> {
  let total = 0;
  let last = await pullOnce(options);
  total += last.applied;
  let pages = 1;
  while (last.hasMore && pages < maxPages) {
    last = await pullFrom(options, last.nextSeq);
    total += last.applied;
    pages += 1;
  }
  return { ...last, applied: total };
}

/** 冲突后强制对齐指定实体（不受本地未确认行保护）。 */
export async function alignConflictedEntities(
  options: Omit<PullOptions, 'forceKeys' | 'respectPending'>,
  conflicts: readonly PushConflict[],
): Promise<PullResult> {
  const keys = [...new Set(conflicts.map((conflict) => `${conflict.entity}:${conflict.entityId}`))];
  return pullUntilIdle({ ...options, forceKeys: keys, respectPending: false });
}

/**
 * 回滚本地未确认的排餐新建：删除该计划及其子行，清掉发件箱里该计划的全部操作。
 *
 * 只回滚「本地新建但服务端拒绝」的计划；已确认的排餐不会被这里删除。
 */
export async function rollbackLocalPlan(database: DatabaseClient, planId: string): Promise<void> {
  await database.withWriteTransaction(async (tx) => {
    await tx.run(`DELETE FROM "sync_outbox" WHERE "entity" = 'MealPlan' AND "entityId" = ?`, [
      planId,
    ]);
    await tx.run(`DELETE FROM "MealPlanItem" WHERE "mealPlanId" = ?`, [planId]);
    await tx.run(`DELETE FROM "MealPlanDiner" WHERE "mealPlanId" = ?`, [planId]);
    await tx.run(`DELETE FROM "MealPlan" WHERE "id" = ?`, [planId]);
  });
}

/**
 * 回滚本地未确认的库存扣减：删除被拒操作产生的批次与日志，
 * 并把食材恢复为服务端确认的版本（由随后的强制拉取写入权威行）。
 */
export async function rollbackLocalIngredient(
  database: DatabaseClient,
  conflict: PushConflict,
): Promise<void> {
  const payload = conflict.payload;
  const batchIds: string[] = [];
  const logIds: string[] = [];
  if (payload) {
    const collect = (ref: unknown) => {
      if (!ref || typeof ref !== 'object') return;
      const entry = ref as { batchId?: unknown; logId?: unknown };
      if (typeof entry.batchId === 'string') batchIds.push(entry.batchId);
      if (typeof entry.logId === 'string') logIds.push(entry.logId);
    };
    collect(payload.implicitBatch);
    collect(payload.addedBatch);
    if (Array.isArray(payload.deductions)) {
      for (const deduction of payload.deductions) {
        const logId = (deduction as { logId?: unknown } | null)?.logId;
        if (typeof logId === 'string') logIds.push(logId);
      }
    }
    if (Array.isArray(payload.replacedBatches)) payload.replacedBatches.forEach(collect);
    if (Array.isArray(payload.inventoryLogIds)) {
      for (const id of payload.inventoryLogIds) if (typeof id === 'string') logIds.push(id);
    }
  }
  await database.withWriteTransaction(async (tx) => {
    for (const id of batchIds) {
      await tx.run(`DELETE FROM "InventoryLog" WHERE "inventoryBatchId" = ?`, [id]);
      await tx.run(`DELETE FROM "InventoryBatch" WHERE "id" = ?`, [id]);
    }
    for (const id of logIds) await tx.run(`DELETE FROM "InventoryLog" WHERE "id" = ?`, [id]);
  });
}
