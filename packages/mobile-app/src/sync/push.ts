/**
 * 发件箱推送：整批 `POST /api/sync/push`，按 ack/拒绝收敛本地发件箱。
 *
 * 契约（shared）：
 *   请求  { deviceId(=clientId), wsConnectionId?, operations: SyncOperation[] }
 *   响应  { acceptedOperationIds, rejected: [{operationId, code, serverVersion, ...}],
 *           acknowledgements: [{operationId, ackSeq, newVersion}] }
 *
 * 服务端对同一 `(clientId, opId)` 幂等，因此本地在收到 ack 前始终保持 `pending`，
 * 崩溃或超时后原样重推不会重复扣库存。
 */
import type { SyncOperation, SyncPushResult } from '@dafan/shared/sync';

import type { DatabaseClient } from '../db/database.js';
import { SyncHttpError } from './http.js';
import type { SyncHttpClient } from './http.js';
import { dropOperation, dropOperationChain, pendingOutbox, type OutboxRow } from './ledger.js';

export interface PushConflict {
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly code: string;
  readonly serverVersion: number | null;
  readonly ingredientId: string | null;
  readonly winner: Record<string, unknown> | null;
  readonly payload: Record<string, unknown> | null;
}

export interface PushResult {
  readonly accepted: number;
  readonly conflicts: PushConflict[];
  /** 服务端既未 ack 也未拒绝（异常守卫），保留待重推。 */
  readonly unresolved: number;
}

export interface PushOptions {
  readonly database: DatabaseClient;
  readonly http: SyncHttpClient;
  readonly clientId: string;
  readonly epoch: number;
  readonly connectionId?: string | null;
  readonly batchSize?: number;
  readonly beforePush?: (operations: readonly SyncOperation[]) => Promise<void>;
  /** 单次调用最多发几批，默认 4。 */
  readonly maxBatches?: number;
}

function toOperation(row: OutboxRow): SyncOperation {
  const base = {
    id: row.opId,
    entity: row.entity as SyncOperation['entity'],
    entityId: row.entityId,
  } as const;
  const payload = row.payloadJson === null ? null : JSON.parse(row.payloadJson);
  if (row.kind === 'delete') {
    return {
      ...base,
      kind: 'delete',
      baseVersion: row.baseVersion ?? 0,
      deletedAt: (payload as { deletedAt: string } | null)?.deletedAt ?? '',
    };
  }
  if (row.kind === 'command') {
    return {
      ...base,
      kind: 'command',
      commandType: row.commandType as never,
      entity: row.entity as never,
      baseVersion: row.baseVersion as never,
      payload: (payload ?? {}) as never,
      payloadHash: row.payloadHash ?? '',
    };
  }
  return {
    ...base,
    kind: 'upsert',
    baseVersion: row.baseVersion,
    payload: (payload ?? {}) as never,
  };
}

function parseResult(raw: unknown): SyncPushResult {
  if (!raw || typeof raw !== 'object') throw new SyncHttpError(502, 'BAD_RESPONSE', '推送响应无效');
  const body = raw as Partial<SyncPushResult> & Record<string, unknown>;
  if (!Array.isArray(body.acceptedOperationIds) || !Array.isArray(body.rejected)) {
    throw new SyncHttpError(502, 'BAD_RESPONSE', '推送响应缺少 acceptedOperationIds/rejected');
  }
  return {
    acceptedOperationIds: body.acceptedOperationIds as string[],
    rejected: body.rejected,
    acknowledgements: Array.isArray(body.acknowledgements)
      ? (body.acknowledgements as SyncPushResult['acknowledgements'])
      : [],
  };
}

/**
 * 推送直到发件箱清空或达到批次上限。
 *
 * 被拒绝的操作连同其同实体的后继操作一起从发件箱移除（版本链已断，后继必然失败），
 * 由调用方执行回滚与权威数据重放。
 */
export async function pushOutbox(options: PushOptions): Promise<PushResult> {
  const batchSize = options.batchSize ?? 50;
  const maxBatches = options.maxBatches ?? 4;
  let accepted = 0;
  const conflicts: PushConflict[] = [];
  let unresolved = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await pendingOutbox(options.database, options.epoch, batchSize);
    if (rows.length === 0) break;

    const operations = rows.map(toOperation);
    await options.beforePush?.(operations);
    let raw: unknown;
    try {
      raw = await options.http.request('/api/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: options.clientId,
          ...(options.connectionId ? { wsConnectionId: options.connectionId } : {}),
          operations,
        }),
      });
    } catch (error) {
      if (
        !(error instanceof SyncHttpError) ||
        error.status !== 409 ||
        !Array.isArray((error.body as Partial<SyncPushResult> | null)?.rejected)
      )
        throw error;
      raw = error.body;
    }
    const response = parseResult(raw);

    const acceptedIds = new Set(response.acceptedOperationIds);
    const rejectedIds = new Set(response.rejected.map((entry) => entry.operationId));
    const byId = new Map(rows.map((row) => [row.opId, row]));

    await options.database.withWriteTransaction(async (tx) => {
      for (const opId of acceptedIds) await dropOperation(tx, opId);
      for (const rejection of response.rejected) {
        const row = byId.get(rejection.operationId);
        if (!row) continue;
        const payload = row.payloadJson === null ? null : JSON.parse(row.payloadJson);
        conflicts.push({
          opId: row.opId,
          entity: row.entity,
          entityId: row.entityId,
          code: rejection.code,
          serverVersion: rejection.serverVersion,
          ingredientId: rejection.ingredientId ?? null,
          winner: (rejection.winner as Record<string, unknown> | undefined) ?? null,
          payload: payload as Record<string, unknown> | null,
        });
        await dropOperationChain(tx, {
          opId: row.opId,
          entity: row.entity,
          entityId: row.entityId,
        });
      }
    });

    accepted += acceptedIds.size;
    for (const row of rows) {
      if (!acceptedIds.has(row.opId) && !rejectedIds.has(row.opId)) unresolved += 1;
    }
    if (rejectedIds.size > 0 || response.acceptedOperationIds.length === 0) break;
  }

  return { accepted, conflicts, unresolved };
}
