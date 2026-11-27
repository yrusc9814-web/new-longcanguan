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
import type {
  SyncEntityName,
  SyncOperation,
  SyncPushResult,
  SyncRowChange,
} from '@dafan/shared/sync';

import type { DatabaseClient } from '../db/database.js';
import { SyncHttpError } from './http.js';
import type { SyncHttpClient } from './http.js';
import {
  dropOperation,
  dropOperationChain,
  pendingOutbox,
  type OutboxChainRow,
  type OutboxRow,
} from './ledger.js';
import { applyPushConflicts, type ConvergeOutcome } from './pull.js';

/**
 * 云端在拒绝某个聚合根时附带该聚合的完整权威行集合（父行 + 全部相关子行）。
 * 端侧据此在同一个本地事务内回滚被丢操作链副作用并完整重对齐，
 * 不再依赖「拉取游标之后」的增量日志，避免跳过过的 sync_log 造成恢复缺口。
 */
export interface AuthoritativeEntityRows {
  readonly entity: SyncEntityName;
  readonly entityId: string;
  readonly rows: readonly SyncRowChange[];
  /**
   * `true` 表示该单元只是被权威子行外键引用的目标行：端侧只补插本地缺失行，
   * 不得删除本地子行或覆盖已有/待推送的聚合。默认 `false` 表示完整替换。
   */
  readonly dependency: boolean;
}

export interface PushConflict {
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly code: string;
  readonly serverVersion: number | null;
  readonly ingredientId: string | null;
  readonly winner: Record<string, unknown> | null;
  readonly payload: Record<string, unknown> | null;
  /** 被本次拒绝连带丢弃的整条操作链（含被拒操作本身）。 */
  readonly chain: readonly OutboxChainRow[];
  /** 云端权威聚合行；旧版服务端可能为空。 */
  readonly authoritative: readonly AuthoritativeEntityRows[];
}

function readAuthoritative(raw: unknown): AuthoritativeEntityRows[] {
  if (!Array.isArray(raw)) return [];
  const result: AuthoritativeEntityRows[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as {
      entity?: unknown;
      entityId?: unknown;
      rows?: unknown;
      dependency?: unknown;
    };
    if (typeof value.entity !== 'string' || typeof value.entityId !== 'string') continue;
    if (!Array.isArray(value.rows)) continue;
    result.push({
      entity: value.entity as SyncEntityName,
      entityId: value.entityId,
      rows: value.rows as SyncRowChange[],
      dependency: value.dependency === true,
    });
  }
  return result;
}

export interface PushResult {
  readonly accepted: number;
  readonly conflicts: PushConflict[];
  readonly outcomes: ReadonlyMap<string, ConvergeOutcome>;
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
 * 被拒操作链、其本地副作用与权威行在同一写事务内收敛。
 */
export async function pushOutbox(options: PushOptions): Promise<PushResult> {
  const batchSize = options.batchSize ?? 50;
  const maxBatches = options.maxBatches ?? 4;
  let accepted = 0;
  const conflicts: PushConflict[] = [];
  let outcomes: ReadonlyMap<string, ConvergeOutcome> = new Map();
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
    if (
      [...acceptedIds, ...rejectedIds].some((id) => !byId.has(id)) ||
      [...rejectedIds].some((id) => acceptedIds.has(id))
    ) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', '推送响应的操作编号无效');
    }

    await options.database.withWriteTransaction(async (tx) => {
      for (const opId of acceptedIds) await dropOperation(tx, opId);
      for (const rejection of response.rejected) {
        const row = byId.get(rejection.operationId);
        if (!row) continue;
        const payload = row.payloadJson === null ? null : JSON.parse(row.payloadJson);
        // 与 DO 拒绝响应同口径：只有本批实际被回滚的同根后继才算「已丢弃」。
        // 超出批次的同根操作留到后续推送，各自触发权威副根回灌，避免留下脏状态。
        const rejectedAt = rows.findIndex((entry) => entry.opId === row.opId);
        const batchChain = new Set(
          rows
            .slice(rejectedAt + 1)
            .filter((entry) => entry.entity === row.entity && entry.entityId === row.entityId)
            .map((entry) => entry.opId),
        );
        const chain = await dropOperationChain(
          tx,
          {
            opId: row.opId,
            entity: row.entity,
            entityId: row.entityId,
          },
          { onlyOpIds: batchChain },
        );
        conflicts.push({
          opId: row.opId,
          entity: row.entity,
          entityId: row.entityId,
          code: rejection.code,
          serverVersion: rejection.serverVersion,
          ingredientId: rejection.ingredientId ?? null,
          winner: (rejection.winner as Record<string, unknown> | undefined) ?? null,
          payload: payload as Record<string, unknown> | null,
          chain,
          authoritative: readAuthoritative(
            (rejection as { authoritative?: unknown }).authoritative,
          ),
        });
      }
      outcomes = await applyPushConflicts(tx, conflicts);
    });

    accepted += acceptedIds.size;
    for (const row of rows) {
      if (!acceptedIds.has(row.opId) && !rejectedIds.has(row.opId)) unresolved += 1;
    }
    if (rejectedIds.size > 0 || response.acceptedOperationIds.length === 0) break;
  }

  return { accepted, conflicts, outcomes, unresolved };
}
