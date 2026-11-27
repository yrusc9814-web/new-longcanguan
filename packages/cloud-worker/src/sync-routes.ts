import {
  HOUSEHOLD_EPOCH_HEADER,
  SYNC_COMMAND_ENTITIES,
  type CloudServerFrame,
  type SyncAcknowledgement,
  type SyncJournalEntry,
  type SyncOperation,
  type SyncPullPage,
  type SyncPushResult,
  type SyncRowChange,
  type SyncSnapshotUpload,
} from '@dafan/shared/sync';

import { hashBearer, hashCredential, requireMember } from './auth';
import { cloudError } from './http';
import { authoritativeRejection } from './sync-authority';
import { ReplayConflict, ReplayValidationError, replayOperation } from './sync-replay';
import {
  acceptSnapshotPage,
  completedReset,
  currentSeq,
  InvalidSyncData,
  isObject,
  isSyncTable,
  readSnapshot,
  SyncStateConflict,
  writeJournal,
} from './sync-storage';

const MAX_SYNC_BODY_BYTES = 3 * 1024 * 1024;
const MAX_ROW_BYTES = 900 * 1024;
const MAX_OPERATIONS = 64;
const MAX_PAGE_ROWS = 500;
const idPattern = /^[\x21-\x7e]{1,200}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const noStore = { 'cache-control': 'no-store' };

export const SYNC_ROUTES = {
  '/api/sync/push': 'POST',
  '/api/sync/pull': 'GET',
  '/api/sync/snapshot': 'GET',
  '/api/sync/init-upload': 'POST',
  '/api/sync/epoch-reset': 'POST',
} as const;

type SyncRoute = keyof typeof SYNC_ROUTES;
type Publish = (
  frame: CloudServerFrame,
  source?: { connectionId: string; memberId: string },
) => void;

export const isSyncRoute = (pathname: string): pathname is SyncRoute =>
  Object.hasOwn(SYNC_ROUTES, pathname);

function validId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function asOperation(value: unknown): SyncOperation {
  if (
    !isObject(value) ||
    !validId(value.id) ||
    !isSyncTable(value.entity) ||
    !validId(value.entityId)
  ) {
    throw new InvalidSyncData();
  }
  if (value.baseVersion !== null && !version(value.baseVersion)) throw new InvalidSyncData();
  if (value.kind === 'delete') {
    if (!version(value.baseVersion) || !validDate(value.deletedAt)) throw new InvalidSyncData();
  } else if (value.kind === 'upsert' || value.kind === 'command') {
    if (!isObject(value.payload)) throw new InvalidSyncData();
    if (
      value.kind === 'command' &&
      (typeof value.commandType !== 'string' ||
        !Object.hasOwn(SYNC_COMMAND_ENTITIES, value.commandType) ||
        SYNC_COMMAND_ENTITIES[value.commandType as keyof typeof SYNC_COMMAND_ENTITIES] !==
          value.entity ||
        (value.commandType !== 'RECIPE_COOK_CHECKIN' && !version(value.baseVersion)) ||
        typeof value.payloadHash !== 'string' ||
        !hashPattern.test(value.payloadHash))
    )
      throw new InvalidSyncData();
  } else throw new InvalidSyncData();
  return value as unknown as SyncOperation;
}

async function readSyncJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new InvalidSyncData();
  if (Number(request.headers.get('content-length')) > MAX_SYNC_BODY_BYTES) throw new BodyTooLarge();
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = '';
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SYNC_BODY_BYTES) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const data: unknown = JSON.parse(text + decoder.decode());
    if (!isObject(data)) throw new InvalidSyncData();
    return data;
  } catch (error) {
    if (error instanceof BodyTooLarge) throw error;
    throw new InvalidSyncData();
  } finally {
    reader.releaseLock();
  }
}

class BodyTooLarge extends Error {}

function readInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new InvalidSyncData();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new InvalidSyncData();
  return value;
}

function pull(sql: SqlStorage, epoch: number, after: number, limit: number): SyncPullPage {
  const entries: SyncJournalEntry[] = [];
  let bytes = 0;
  let hasMore = false;
  for (const entry of sql.exec<{ sync_seq: number; operation_id: string }>(
    'SELECT sync_seq, operation_id FROM sync_log WHERE epoch = ? AND sync_seq > ? ORDER BY sync_seq LIMIT ?',
    epoch,
    after,
    limit + 1,
  )) {
    if (entries.length === limit) {
      hasMore = true;
      break;
    }
    const changes: SyncRowChange[] = [];
    for (const { change_json } of sql.exec<{ change_json: string }>(
      'SELECT change_json FROM sync_journal_rows WHERE epoch = ? AND sync_seq = ? ORDER BY row_index',
      epoch,
      entry.sync_seq,
    )) {
      bytes += change_json.length * 3;
      if (entries.length && bytes > MAX_SYNC_BODY_BYTES) break;
      changes.push(JSON.parse(change_json) as SyncRowChange);
    }
    if (entries.length && bytes > MAX_SYNC_BODY_BYTES) {
      hasMore = true;
      break;
    }
    entries.push({ seq: entry.sync_seq, operationId: entry.operation_id, changes });
  }
  return { epoch, entries, nextSeq: entries.at(-1)?.seq ?? after, hasMore };
}

interface PushBody {
  deviceId: string;
  wsConnectionId?: string;
  prepared: { operation: SyncOperation; fingerprint: string }[];
}

async function preparePush(data: Record<string, unknown>): Promise<PushBody> {
  const { deviceId, wsConnectionId, operations } = data;
  if (
    !validId(deviceId) ||
    (wsConnectionId !== undefined && !validId(wsConnectionId)) ||
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > MAX_OPERATIONS
  ) {
    throw new InvalidSyncData();
  }
  const prepared = await Promise.all(
    operations.map(async (value: unknown) => {
      const operation = asOperation(value);
      const payload =
        operation.kind === 'delete' ? operation.deletedAt : JSON.stringify(operation.payload);
      if (new TextEncoder().encode(payload).byteLength > MAX_ROW_BYTES) throw new BodyTooLarge();
      const payloadHash = await hashCredential(payload);
      if (operation.kind === 'command' && operation.payloadHash !== payloadHash)
        throw new InvalidSyncData();
      const fingerprint = await hashCredential(
        JSON.stringify([
          operation.entity,
          operation.entityId,
          operation.kind,
          operation.baseVersion,
          operation.kind === 'command' ? operation.commandType : null,
          payloadHash,
        ]),
      );
      return { operation, fingerprint };
    }),
  );
  return { deviceId, wsConnectionId, prepared };
}

function push(sql: SqlStorage, epoch: number, memberId: string, body: PushBody) {
  const acknowledgements: SyncAcknowledgement[] = [];
  let seq = currentSeq(sql, epoch);
  const previousSeq = seq;
  for (const [index, { operation, fingerprint }] of body.prepared.entries()) {
    const previous = sql
      .exec<{ member_id: string; fingerprint: string; ack_seq: number; new_version: number }>(
        'SELECT member_id, fingerprint, ack_seq, new_version FROM processed_ops WHERE epoch = ? AND client_id = ? AND op_id = ?',
        epoch,
        body.deviceId,
        operation.id,
      )
      .toArray()[0];
    if (previous) {
      if (previous.member_id !== memberId || previous.fingerprint !== fingerprint) {
        throw new ReplayConflict(
          {
            operationId: operation.id,
            code: 'IDEMPOTENCY_CONFLICT',
            serverVersion: null,
          },
          undefined,
          operation,
        );
      }
      acknowledgements.push({
        operationId: operation.id,
        ackSeq: previous.ack_seq,
        newVersion: previous.new_version,
      });
      continue;
    }
    let replayed: ReturnType<typeof replayOperation>;
    try {
      replayed = replayOperation(sql, operation);
    } catch (error) {
      // 与端侧 `dropOperationChain` 同口径：同聚合根的后继操作会随被拒操作整链丢弃，
      // 拒绝响应必须把链上每个操作触及的副根一并交回，端侧才能完整回滚。
      if (error instanceof ReplayConflict && error.chain === undefined) {
        error.chain = body.prepared
          .slice(index + 1)
          .map((entry) => entry.operation)
          .filter(
            (successor) =>
              successor.entity === operation.entity && successor.entityId === operation.entityId,
          );
      }
      throw error;
    }
    const { changes, newVersion } = replayed;
    writeJournal(
      sql,
      epoch,
      ++seq,
      memberId,
      operation.id,
      operation.entity,
      operation.entityId,
      operation.kind,
      newVersion,
      changes,
    );
    sql.exec(
      'INSERT INTO processed_ops VALUES (?, ?, ?, ?, ?, ?, ?)',
      epoch,
      body.deviceId,
      operation.id,
      memberId,
      fingerprint,
      seq,
      newVersion,
    );
    acknowledgements.push({ operationId: operation.id, ackSeq: seq, newVersion });
  }
  const result: SyncPushResult = {
    acceptedOperationIds: acknowledgements.map(({ operationId }) => operationId),
    acknowledgements,
    rejected: [],
  };
  return { result, seq, changed: seq !== previousSeq };
}

function asUpload(data: Record<string, unknown>): SyncSnapshotUpload {
  const { uploadId, page, rows, finalize } = data;
  if (
    !validId(uploadId) ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 0 ||
    typeof finalize !== 'boolean' ||
    !Array.isArray(rows) ||
    rows.length > MAX_PAGE_ROWS ||
    rows.some((value: unknown) => !isObject(value) || !isObject(value.row))
  ) {
    throw new InvalidSyncData();
  }
  const encoder = new TextEncoder();
  if (rows.some((row: unknown) => encoder.encode(JSON.stringify(row)).byteLength > MAX_ROW_BYTES))
    throw new BodyTooLarge();
  return { uploadId, page, rows, finalize };
}

function isConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /SQLITE_CONSTRAINT|constraint failed|datatype mismatch/i.test(error.message)
  );
}

export interface SyncHooks {
  /** 事务提交后清理失去引用的 R2 对象；DO 事务内不得访问 R2。 */
  readonly deleteObjects?: (keys: readonly string[]) => Promise<void>;
}

export async function serveSync(
  storage: DurableObjectStorage,
  request: Request,
  url: URL,
  route: SyncRoute,
  publish: Publish,
  hooks: SyncHooks = {},
): Promise<Response> {
  const { sql } = storage;
  const tokenHash = await hashBearer(request.headers.get('authorization'));
  const requestedEpoch = request.headers.get(HOUSEHOLD_EPOCH_HEADER);
  const ownerOnly = route === '/api/sync/init-upload' || route === '/api/sync/epoch-reset';
  const admit = () => {
    const member = requireMember(sql, tokenHash, ownerOnly ? 'OWNER' : undefined);
    if ('code' in member) return member;
    const { epoch } = sql
      .exec<{ epoch: number }>('SELECT epoch FROM household_meta WHERE id = 1')
      .one();
    return { member, epoch };
  };
  const admission = admit();
  if ('code' in admission) return cloudError(admission);
  const { epoch, member } = admission;
  const mismatch = (currentEpoch: number) =>
    cloudError({ code: 'EPOCH_MISMATCH', status: 409, currentEpoch });
  const retryOfReset = (currentEpoch: number) =>
    route === '/api/sync/epoch-reset' &&
    currentEpoch > 1 &&
    requestedEpoch === String(currentEpoch - 1);
  if (requestedEpoch !== String(epoch) && !retryOfReset(epoch)) return mismatch(epoch);

  try {
    if (route === '/api/sync/pull') {
      const after = readInteger(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = readInteger(url.searchParams.get('limit'), 100, 1, MAX_PAGE_ROWS);
      return Response.json(pull(sql, epoch, after, limit), { headers: noStore });
    }
    if (route === '/api/sync/snapshot') {
      const limit = readInteger(url.searchParams.get('limit'), 100, 1, MAX_PAGE_ROWS);
      const page = storage.transactionSync(() =>
        readSnapshot(sql, member.id, epoch, url.searchParams.get('cursor'), limit),
      );
      return page
        ? Response.json(page, { headers: noStore })
        : cloudError({ code: 'CONFLICT', status: 409 });
    }

    const data = await readSyncJson(request);
    const prepared = route === '/api/sync/push' ? await preparePush(data) : undefined;
    const upload = prepared ? undefined : asUpload(data);
    const fingerprint = upload ? await hashCredential(JSON.stringify(upload)) : '';
    // The read/hash above can yield to revocation or a restore. Commit only under a fresh admission.
    const refreshed = admit();
    if ('code' in refreshed) return cloudError(refreshed);
    if (requestedEpoch !== String(refreshed.epoch)) {
      if (upload && retryOfReset(refreshed.epoch)) {
        const result = completedReset(
          sql,
          refreshed.member.id,
          refreshed.epoch - 1,
          upload,
          fingerprint,
        );
        if (result) return Response.json(result, { headers: noStore });
      }
      return mismatch(refreshed.epoch);
    }
    if (prepared) {
      const { result, changed, seq } = storage.transactionSync(() =>
        push(sql, epoch, member.id, prepared),
      );
      if (changed)
        publish(
          { type: 'SYNC_AVAILABLE', epoch, seq },
          prepared.wsConnectionId
            ? { connectionId: prepared.wsConnectionId, memberId: member.id }
            : undefined,
        );
      return Response.json(result, { headers: noStore });
    }
    if (!upload) throw new InvalidSyncData();
    const action = route === '/api/sync/init-upload' ? 'init' : 'reset';
    const { result, changed, deletedObjectKeys } = storage.transactionSync(() =>
      acceptSnapshotPage(sql, member.id, epoch, action, upload, fingerprint),
    );
    if (deletedObjectKeys.length && hooks.deleteObjects) {
      // 事务已提交：此处是唯一可以安全访问 R2 的时机。删除失败不回滚账本，
      // 下次快照替换会重新算出同样的孤儿键并重试。
      await hooks.deleteObjects(deletedObjectKeys).catch(() => undefined);
    }
    if (changed)
      publish(
        action === 'reset'
          ? { type: 'EPOCH_RESET', epoch: result.epoch }
          : { type: 'SYNC_AVAILABLE', epoch, seq: result.seq },
      );
    return Response.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof ReplayConflict) {
      // 批事务已回滚：此刻读到的就是「本条操作从未发生」的权威状态。
      const rejection =
        error.operation !== undefined
          ? authoritativeRejection(sql, error.operation, error.rejection, error.chain ?? [])
          : error.rejection;
      return Response.json(
        {
          ...rejection,
          acceptedOperationIds: [],
          acknowledgements: [],
          rejected: [rejection],
        },
        { status: 409, headers: noStore },
      );
    }
    if (error instanceof BodyTooLarge) return cloudError({ code: 'FILE_TOO_LARGE', status: 413 });
    if (error instanceof SyncStateConflict) return cloudError({ code: 'CONFLICT', status: 409 });
    if (
      error instanceof InvalidSyncData ||
      error instanceof ReplayValidationError ||
      isConstraint(error)
    ) {
      return cloudError({ code: 'VALIDATION_ERROR', status: 400 });
    }
    throw error;
  }
}
